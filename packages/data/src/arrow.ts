/**
 * Arrow format entry — `@modernrelay/orbit-data/arrow`.
 *
 * NEVER imported by the root entry: the
 * 'apache-arrow' optional peer is loaded with a DYNAMIC import inside the
 * call, so this module is import-safe without it (the clear install-hint
 * error fires only when preparation actually runs), and root-entry bundles
 * carry no arrow code.
 *
 * Sources per role are Arrow IPC bytes (file or stream framing
 * Blob/ArrayBuffer/AsyncIterable<Uint8Array>) or an already-constructed
 * arrow Table (duck-typed via `schema.fields`). Tables become row objects
 * through `getChild` vectors and feed the shared builder; columns come from
 * the SCHEMA (exact, not sampled). Value normalization for the object lane:
 * arrow nulls → absent keys, bigints → number when safely representable else
 * decimal string, and LIST/STRUCT values recursively become plain JSON
 * containers. Other values pass through.
 */

import { normalizeJsonSafeValue } from './jsonSafe';

import { buildPrepared } from './builder';
import { EMPTY_ROW_TABLE, type RowTable } from './rowTable';
import { collectBytes, throwIfAborted } from './sources';
import type {
  GraphByteSource,
  GraphColumnMapping,
  GraphPrepareOptions,
  PreparedGraph,
} from './types';

/** Structural subset of an apache-arrow Table (any supported major). */
export interface ArrowTableLike {
  readonly numRows: number;
  readonly schema: { readonly fields: ReadonlyArray<{ readonly name: string }> };
  getChild(name: string): { get(index: number): unknown } | null;
}

export type ArrowGraphSource = GraphByteSource | ArrowTableLike;

export type ArrowGraphPrepareInput =
  | { nodes: ArrowGraphSource; edges: ArrowGraphSource }
  | { edges: ArrowGraphSource; deriveNodes: true };

/** Test seam: lets suites simulate the missing-optional-dependency path. */
export const _internals = {
  importArrow: (): Promise<unknown> => import('apache-arrow'),
};

interface ArrowModule {
  tableFromIPC(bytes: Uint8Array): ArrowTableLike;
  materialize(value: object): unknown;
}

async function loadArrowModule(): Promise<ArrowModule> {
  let mod: unknown;
  try {
    mod = await _internals.importArrow();
  } catch (cause) {
    throw new Error(
      "@modernrelay/orbit-data/arrow requires the optional peer dependency 'apache-arrow'. " +
        'Install it (e.g. `pnpm add apache-arrow`) to use prepareArrowGraphData.',
      { cause },
    );
  }
  const tableFromIPC = (mod as Record<string, unknown>)['tableFromIPC'];
  if (typeof tableFromIPC !== 'function') {
    throw new Error(
      "@modernrelay/orbit-data/arrow: the installed 'apache-arrow' does not expose tableFromIPC " +
        '(unsupported version?)',
    );
  }
  const { Vector, StructRow } = mod as typeof import('apache-arrow');
  return {
    tableFromIPC: tableFromIPC as (bytes: Uint8Array) => ArrowTableLike,
    materialize(value) {
      if (value instanceof Vector) return Array.from(value);
      // Iterate entries instead of using toJSON/Object.entries: Arrow's
      // property access and toJSON can shadow or lose fields such as
      // __proto__ and constructor. fromEntries always creates own data.
      if (value instanceof StructRow) return Object.fromEntries(value);
      return value;
    },
  };
}

export async function prepareArrowGraphData<
  N = Record<string, unknown>,
  E = Record<string, unknown>,
>(
  input: ArrowGraphPrepareInput,
  mapping: GraphColumnMapping,
  options: Omit<GraphPrepareOptions, 'format'>,
): Promise<PreparedGraph<N, E>> {
  const signal = options.signal;
  throwIfAborted(signal);
  const arrow = await loadArrowModule();
  throwIfAborted(signal);
  const deriveNodes = 'deriveNodes' in input && input.deriveNodes === true;
  const edgeTable = await arrowRowTable(input.edges, arrow, signal);
  const nodeTable = deriveNodes
    ? null
    : await arrowRowTable((input as { nodes: ArrowGraphSource }).nodes, arrow, signal);
  return (await buildPrepared({
    nodeTable,
    edgeTable,
    mapping,
    format: 'arrow',
    options: { ...options, format: 'arrow' },
  })) as PreparedGraph<N, E>;
}

function isArrowTable(source: ArrowGraphSource): source is ArrowTableLike {
  return (
    typeof source === 'object' &&
    source !== null &&
    'schema' in source &&
    typeof (source as ArrowTableLike).getChild === 'function' &&
    Array.isArray((source as ArrowTableLike).schema?.fields)
  );
}

async function arrowRowTable(
  source: ArrowGraphSource,
  arrow: ArrowModule,
  signal: AbortSignal | undefined,
): Promise<RowTable> {
  throwIfAborted(signal);
  const table = isArrowTable(source)
    ? source
    : arrow.tableFromIPC(await collectBytes(source as GraphByteSource, signal));
  throwIfAborted(signal);
  const columns = table.schema.fields.map((f) => f.name);
  if (columns.length === 0 && table.numRows === 0) return EMPTY_ROW_TABLE;
  const vectors = columns.map((name) => table.getChild(name));
  return {
    columns,
    rows: (async function* () {
      for (let i = 0; i < table.numRows; i++) {
        throwIfAborted(signal);
        const row: Record<string, unknown> = {};
        for (let j = 0; j < columns.length; j++) {
          const value = vectors[j]?.get(i);
          if (value === null || value === undefined) continue; // arrow null → absent
          // Arrow schemas may legally contain a `__proto__` column. Plain
          // assignment would invoke the legacy prototype setter and lose it.
          Object.defineProperty(row, columns[j]!, {
            value: normalizeJsonSafeValue(value, arrow.materialize),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        throwIfAborted(signal);
        yield row;
      }
      throwIfAborted(signal);
    })(),
  };
}
