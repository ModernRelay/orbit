/**
 * Internal adapter contract: every input lane (rows, CSV, JSON document,
 * Arrow, Parquet) normalizes to a `RowTable` — the discovered column list
 * (available BEFORE any row work, so mapping validation can run first) plus a
 * single-pass stream of plain row objects.
 *
 * Column discovery per lane:
 * - row objects → keys of the FIRST row (sampled; later rows may add keys,
 * which flow into attrs/summaries but not validation);
 * - CSV → the header row;
 * - JSON document → keys of the first element of each resolved path array;
 * - Arrow/Parquet → the file schema (exact, not sampled).
 *
 * `columns: null` means the source was empty — nothing to validate against
 * (vacuously valid) and nothing to stream.
 */

export interface RowTable {
  /** Discovered columns, or null when the source has no rows at all. */
  readonly columns: readonly string[] | null;
  readonly rows: AsyncIterable<Readonly<Record<string, unknown>>>;
}

export const EMPTY_ROW_TABLE: RowTable = {
  columns: null,
  rows: (async function* () {})(),
};

export function isPlainRowObject(row: unknown): row is Record<string, unknown> {
  return typeof row === 'object' && row !== null && !Array.isArray(row);
}
