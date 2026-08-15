/**
 * JSON document adapter: a byte source containing ONE JSON object.
 * `mapping.documentPaths.nodes` / `.edges` are dot-paths resolved against the
 * parsed document; each must land on an array of row objects. A single
 * `document` input is valid only for JSON and requires `documentPaths`.
 */

import { EMPTY_ROW_TABLE, isPlainRowObject, type RowTable } from './rowTable';
import { collectBytes } from './sources';
import type { GraphByteSource, GraphColumnMapping } from './types';

export async function documentTables(
  source: GraphByteSource,
  mapping: GraphColumnMapping,
  signal: AbortSignal | undefined,
): Promise<{ nodes: RowTable; edges: RowTable }> {
  const paths = mapping.documentPaths;
  if (paths === undefined) {
    throw new TypeError(
      'prepareGraphData: document input requires mapping.documentPaths ' +
        '({ nodes, edges } dot-paths into the parsed object)',
    );
  }
  const bytes = await collectBytes(source, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new TypeError(
      `prepareGraphData: document input is not valid JSON (${(cause as Error).message})`,
    );
  }
  if (!isPlainRowObject(parsed)) {
    throw new TypeError(
      'prepareGraphData: document input must parse to a single JSON object',
    );
  }
  return {
    nodes: arrayAtPath(parsed, paths.nodes, 'nodes'),
    edges: arrayAtPath(parsed, paths.edges, 'edges'),
  };
}

function arrayAtPath(document: Record<string, unknown>, path: string, role: string): RowTable {
  let cursor: unknown = document;
  for (const segment of path.split('.')) {
    if (!isPlainRowObject(cursor)) {
      throw new TypeError(
        `prepareGraphData: documentPaths.${role} ${JSON.stringify(path)} does not resolve ` +
          `to an array (stopped at segment ${JSON.stringify(segment)})`,
      );
    }
    cursor = cursor[segment];
  }
  if (!Array.isArray(cursor)) {
    throw new TypeError(
      `prepareGraphData: documentPaths.${role} ${JSON.stringify(path)} must resolve to an array`,
    );
  }
  const rows = cursor as readonly unknown[];
  if (rows.length === 0) return EMPTY_ROW_TABLE;
  const first = rows[0];
  if (!isPlainRowObject(first)) {
    throw new TypeError(
      `prepareGraphData: documentPaths.${role} array elements must be plain row objects`,
    );
  }
  return {
    columns: Object.keys(first),
    rows: (async function* () {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!isPlainRowObject(row)) {
          throw new TypeError(
            `prepareGraphData: documentPaths.${role} element ${i} is not a plain row object`,
          );
        }
        yield row;
      }
    })(),
  };
}
