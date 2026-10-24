/**
 * Parquet format entry — `@modernrelay/orbit-data/parquet`.
 *
 * NEVER imported by the root entry: the
 * 'hyparquet' optional peer (a pure-JS parquet reader) is loaded with a
 * DYNAMIC import inside the call — this module is import-safe without it and
 * the install-hint error fires only when preparation actually runs.
 *
 * Sources per role are parquet file bytes (Blob/ArrayBuffer/
 * AsyncIterable<Uint8Array>); each role is one parquet file. Rows come from
 * hyparquet's `parquetReadObjects` and feed the shared builder. Columns are
 * taken from the first materialized row (hyparquet emits every schema column
 * as a key on each row object, so first-row keys ARE the schema for flat
 * files). Value normalization mirrors arrow.ts: nulls → absent keys, bigints
 * (INT64) → number when safely representable else decimal string.
 */

import { normalizeJsonSafeValue } from './jsonSafe';

import { PreparationControl } from './control';
import { buildPrepared } from './builder';
import { EMPTY_ROW_TABLE, isPlainRowObject, type RowTable } from './rowTable';
import { abortable, collectBytes, throwIfAborted } from './sources';
import type {
  GraphByteSource,
  GraphColumnMapping,
  GraphPrepareOptions,
  GraphPrepareAnyOptions,
  GraphPrepareColumnarOptions,
  PreparedColumnarGraph,
  PreparedGraph,
} from './types';

export type ParquetGraphPrepareInput =
  | { nodes: GraphByteSource; edges: GraphByteSource }
  | { edges: GraphByteSource; deriveNodes: true };

/** Test seam: lets suites simulate the missing-optional-dependency path. */
export const _internals = {
  importHyparquet: (): Promise<unknown> => import('hyparquet'),
};

type ParquetReadObjects = (options: {
  file: ArrayBuffer;
}) => Promise<ReadonlyArray<Record<string, unknown>>>;

async function loadHyparquetModule(): Promise<{ parquetReadObjects: ParquetReadObjects }> {
  let mod: unknown;
  try {
    mod = await _internals.importHyparquet();
  } catch (cause) {
    throw new Error(
      "@modernrelay/orbit-data/parquet requires the optional peer dependency 'hyparquet'. " +
        'Install it (e.g. `pnpm add hyparquet`) to use prepareParquetGraphData.',
      { cause },
    );
  }
  const parquetReadObjects = (mod as Record<string, unknown>)['parquetReadObjects'];
  if (typeof parquetReadObjects !== 'function') {
    throw new Error(
      "@modernrelay/orbit-data/parquet: the installed 'hyparquet' does not expose " +
        'parquetReadObjects (unsupported version?)',
    );
  }
  return { parquetReadObjects: parquetReadObjects as ParquetReadObjects };
}

export function prepareParquetGraphData<N = Record<string, unknown>, E = Record<string, unknown>>(
  input: ParquetGraphPrepareInput, mapping: GraphColumnMapping, options: Omit<GraphPrepareColumnarOptions, 'format'>,
): Promise<PreparedColumnarGraph<N, E>>;
export function prepareParquetGraphData<N = Record<string, unknown>, E = Record<string, unknown>>(
  input: ParquetGraphPrepareInput, mapping: GraphColumnMapping, options: Omit<GraphPrepareOptions, 'format'>,
): Promise<PreparedGraph<N, E>>;
export function prepareParquetGraphData<N = Record<string, unknown>, E = Record<string, unknown>>(
  input: ParquetGraphPrepareInput, mapping: GraphColumnMapping, options: Omit<GraphPrepareAnyOptions, 'format'>,
): Promise<PreparedGraph<N, E> | PreparedColumnarGraph<N, E>>;
export async function prepareParquetGraphData<
  N = Record<string, unknown>,
  E = Record<string, unknown>,
>(
  input: ParquetGraphPrepareInput,
  mapping: GraphColumnMapping,
  options: Omit<GraphPrepareAnyOptions, 'format'>,
): Promise<PreparedGraph<N, E> | PreparedColumnarGraph<N, E>> {
  const control = new PreparationControl(options as GraphPrepareAnyOptions);
  const hyparquet = await loadHyparquetModule();
  const signal = options.signal;
  throwIfAborted(signal);
  const deriveNodes = 'deriveNodes' in input && input.deriveNodes === true;
  const edgeTable = await parquetRowTable(input.edges, hyparquet, signal, control);
  const nodeTable = deriveNodes
    ? null
    : await parquetRowTable((input as { nodes: GraphByteSource }).nodes, hyparquet, signal, control);
  return (await buildPrepared({
    nodeTable,
    edgeTable,
    mapping,
    format: 'parquet',
    options: { ...options, format: 'parquet' } as GraphPrepareAnyOptions,
    control,
  })) as PreparedGraph<N, E> | PreparedColumnarGraph<N, E>;
}

async function parquetRowTable(
  source: GraphByteSource,
  hyparquet: { parquetReadObjects: ParquetReadObjects },
  signal: AbortSignal | undefined,
  control: PreparationControl,
): Promise<RowTable> {
  const bytes = await collectBytes(source, signal, control);
  // collectBytes allocates an exact-size buffer, so `bytes.buffer` is the
  // whole file — the AsyncBuffer shape hyparquet expects.
  const rows = await abortable(hyparquet.parquetReadObjects({ file: bytes.buffer as ArrayBuffer }), signal);
  throwIfAborted(signal);
  const first = rows[0];
  if (first === undefined) return EMPTY_ROW_TABLE;
  if (!isPlainRowObject(first)) {
    throw new TypeError(
      '@modernrelay/orbit-data/parquet: hyparquet returned non-object rows (unsupported file?)',
    );
  }
  const columns = Object.keys(first);
  return {
    columns,
    rows: (async function* () {
      for (const raw of rows) {
        throwIfAborted(signal);
        const row: Record<string, unknown> = {};
        for (const key of Object.keys(raw)) {
          const value = raw[key];
          if (value === null || value === undefined) continue; // parquet null → absent
          // Preserve a literal `__proto__` schema column as own data.
          Object.defineProperty(row, key, {
            value: normalizeParquetValue(value),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        throwIfAborted(signal);
        yield row;
      }
    })(),
  };
}

const normalizeParquetValue = normalizeJsonSafeValue;
