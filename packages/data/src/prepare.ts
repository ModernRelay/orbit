/**
 * `prepareGraphData` — the root-entry preparation pipeline for
 * the built-in lanes: row objects, streaming CSV, and JSON documents.
 *
 * Arrow/Parquet live behind the `./arrow` and `./parquet` format entries:
 * passing `format: 'arrow' | 'parquet'`
 * here throws with a pointer to the right entry instead of dragging optional
 * parsers into the root bundle.
 *
 * Format inference when `format` is omitted:
 * - `{document}` input → 'json';
 * - arrays → 'rows'; Blob/ArrayBuffer → 'csv';
 * - an AsyncIterable is ambiguous: the first element is peeked — Uint8Array
 * chunks mean 'csv' bytes, anything else means row objects (sources.ts).
 * The resolved label used in the fingerprint is `options.format` when given,
 * else 'csv' if any lane parsed CSV, else 'rows' (or 'json' for documents).
 */

import { buildPrepared } from './builder';
import { csvTable } from './csv';
import { documentTables } from './document';
import { EMPTY_ROW_TABLE, type RowTable } from './rowTable';
import { rowsTable } from './rows';
import { isAsyncIterable, isBlob, peekAsyncIterable } from './sources';
import type {
  GraphColumnMapping,
  GraphPrepareInput,
  GraphPrepareOptions,
  GraphTabularSource,
  PreparedGraph,
} from './types';

export async function prepareGraphData<
  N = Record<string, unknown>,
  E = Record<string, unknown>,
>(
  input: GraphPrepareInput,
  mapping: GraphColumnMapping,
  options: GraphPrepareOptions,
): Promise<PreparedGraph<N, E>> {
  const { format, signal } = options;
  if (format === 'arrow' || format === 'parquet') {
    throw new TypeError(
      `prepareGraphData: format '${format}' is served by the '@modernrelay/orbit-data/${format}' ` +
        `entry (prepare${format === 'arrow' ? 'Arrow' : 'Parquet'}GraphData) — the root entry ` +
        'never bundles optional format parsers',
    );
  }

  if ('document' in input) {
    if (format !== undefined && format !== 'json') {
      throw new TypeError(
        `prepareGraphData: a document input is valid only for JSON (got format '${format}')`,
      );
    }
    const tables = await documentTables(input.document, mapping, signal);
    return (await buildPrepared({
      nodeTable: tables.nodes,
      edgeTable: tables.edges,
      mapping,
      format: 'json',
      options,
    })) as PreparedGraph<N, E>;
  }
  if (format === 'json') {
    throw new TypeError(
      "prepareGraphData: format 'json' requires the { document } input variant with mapping.documentPaths",
    );
  }

  const deriveNodes = 'deriveNodes' in input && input.deriveNodes === true;
  const edgeIdentity = new Set(
    [mapping.edges.id, mapping.edges.source, mapping.edges.target].filter(
      (c): c is string => c !== undefined,
    ),
  );
  const lanes = { csv: false, rows: false };
  const edgeTable = await resolveTabular(input.edges, options, edgeIdentity, 'edge', lanes);
  let nodeTable: RowTable | null = null;
  try {
    if (!deriveNodes) {
      if (!('nodes' in input) || input.nodes === undefined) {
        throw new TypeError(
          'prepareGraphData: input must supply nodes, set deriveNodes: true, or use a document',
        );
      }
      const nodeIdentity = new Set(mapping.nodes === undefined ? [] : [mapping.nodes.id]);
      nodeTable = await resolveTabular(input.nodes, options, nodeIdentity, 'node', lanes);
    }

    const resolvedFormat = format ?? (lanes.csv ? 'csv' : 'rows');
    return (await buildPrepared({
      nodeTable,
      edgeTable,
      mapping,
      format: resolvedFormat,
      options,
    })) as PreparedGraph<N, E>;
  } catch (cause) {
    // The edge lane is opened first. If node-lane resolution fails before
    // buildPrepared takes ownership, release every already-peeked iterator.
    // Cleanup is best-effort on this failure path: run every close, but keep
    // the resolution error as the rejection callers receive.
    await Promise.allSettled([
      Promise.resolve().then(() => edgeTable.close?.()),
      Promise.resolve().then(() => nodeTable?.close?.()),
    ]);
    throw cause;
  }
}

async function resolveTabular(
  source: GraphTabularSource,
  options: GraphPrepareOptions,
  identityColumns: ReadonlySet<string>,
  role: 'node' | 'edge',
  lanes: { csv: boolean; rows: boolean },
): Promise<RowTable> {
  const { format, signal } = options;
  if (Array.isArray(source)) {
    if (format === 'csv') {
      throw new TypeError(
        `prepareGraphData: format 'csv' needs a byte source for the ${role} lane, got an array of rows`,
      );
    }
    lanes.rows = true;
    return rowsTable(source, signal, role);
  }
  if (source instanceof ArrayBuffer || isBlob(source)) {
    if (format === 'rows') {
      throw new TypeError(
        `prepareGraphData: format 'rows' needs row objects for the ${role} lane, got bytes`,
      );
    }
    lanes.csv = true;
    return csvTable(source, signal, identityColumns);
  }
  if (isAsyncIterable(source)) {
    if (format === 'csv') {
      lanes.csv = true;
      return csvTable(source as AsyncIterable<Uint8Array>, signal, identityColumns);
    }
    if (format === 'rows') {
      lanes.rows = true;
      return rowsTable(source, signal, role);
    }
    // No format given: peek the first element to tell bytes from rows.
    const { first, done, rest } = await peekAsyncIterable(source);
    if (done) return EMPTY_ROW_TABLE;
    if (first instanceof Uint8Array) {
      lanes.csv = true;
      return csvTable(rest as AsyncIterable<Uint8Array>, signal, identityColumns);
    }
    lanes.rows = true;
    return rowsTable(rest, signal, role);
  }
  throw new TypeError(
    `prepareGraphData: unsupported ${role} source — expected rows (array/AsyncIterable) ` +
      'or bytes (Blob/ArrayBuffer/AsyncIterable<Uint8Array>)',
  );
}
