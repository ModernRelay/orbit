/**
 * Streaming CSV adapter: incremental RFC 4180 parser over
 * `AsyncIterable<Uint8Array>` / `Blob` / `ArrayBuffer`.
 *
 * Parsing:
 * - header row = columns; quoted fields with `""` escapes; quoted delimiters
 * and newlines; CRLF and LF record ends; line assembly is streaming and
 * survives arbitrary chunk boundaries (quotes, CRLF pairs, and multi-byte
 * UTF-8 sequences may all straddle chunks — TextDecoder runs in stream
 * mode);
 * - lenient extensions (Excel-style): a quote inside an unquoted field is
 * literal, and a stray character after a closing quote reopens unquoted
 * accumulation;
 * - blank lines are skipped; an unterminated quote at EOF is a TypeError;
 * - rows shorter than the header leave trailing columns absent; extra cells
 * beyond the header are ignored; duplicate header names collapse (the
 * later column wins).
 *
 * Cell typing (documented heuristic):
 * - attrs get TYPED values: a column parses to numbers when the WHOLE column
 * is numeric-or-empty, decided from the first SAMPLE_ROWS = 1000 data rows
 * (two passes over the retained sample, then streaming). "Numeric" means
 * core's `coerceNumeric` accepts the cell (so '1e3' → 1000 but '12px' and
 * 'NaN' disqualify the column). A column that is all-empty in the sample
 * stays a string column (no evidence). Because the decision is pinned by
 * the sample, a post-sample non-numeric cell in a numeric column coerces
 * to null and the key is simply absent for that row.
 * - identity columns (node id / edge source/target/id) are exempt: they stay
 * raw strings so ids like '01' and '1' never collapse.
 * - empty cells (quoted or not) → absent key.
 */

import { coerceNumeric } from '@modernrelay/orbit-core';
import { EMPTY_ROW_TABLE, type RowTable } from './rowTable';
import { byteChunks, throwIfAborted } from './sources';
import type { GraphByteSource } from './types';

export const SAMPLE_ROWS = 1000;

/** Incremental RFC 4180 record stream (arrays of raw string cells). */
export async function* csvRecords(
  chunks: AsyncIterable<Uint8Array>,
): AsyncGenerator<readonly string[]> {
  const decoder = new TextDecoder('utf-8');
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let afterQuote = false;
  let sawCR = false;
  /** True once the current record saw a quote (so `""` alone is a real row,
   * not a blank line). */
  let recordHadQuote = false;

  const pending: string[][] = [];
  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    const blankLine = record.length === 1 && record[0] === '' && !recordHadQuote;
    if (!blankLine) pending.push(record);
    record = [];
    recordHadQuote = false;
  };

  const feed = (text: string): void => {
    for (const ch of text) {
      const prevCR = sawCR;
      sawCR = false;
      if (afterQuote) {
        afterQuote = false;
        if (ch === '"') {
          field += '"'; // escaped quote, still inside the quoted field
          continue;
        }
        inQuotes = false; // quote closed; fall through as unquoted
      }
      if (inQuotes) {
        if (ch === '"') afterQuote = true;
        else field += ch;
        continue;
      }
      if (ch === '\n') {
        if (!prevCR) endRecord(); // CRLF: the CR already ended the record
        continue;
      }
      if (ch === '\r') {
        endRecord();
        sawCR = true;
        continue;
      }
      if (ch === ',') {
        endField();
        continue;
      }
      if (ch === '"') {
        if (field === '') {
          inQuotes = true;
          recordHadQuote = true;
          continue;
        }
        field += ch; // lenient: literal quote inside an unquoted field
        continue;
      }
      field += ch;
    }
  };

  for await (const chunk of chunks) {
    feed(decoder.decode(chunk, { stream: true }));
    if (pending.length > 0) {
      yield* pending.splice(0, pending.length);
    }
  }
  feed(decoder.decode()); // flush a trailing multi-byte sequence
  if (inQuotes && !afterQuote) {
    throw new TypeError('prepareGraphData: CSV ended inside an unterminated quoted field');
  }
  if (afterQuote) inQuotes = false;
  if (field !== '' || record.length > 0 || recordHadQuote) {
    endRecord(); // final record without a trailing newline
  }
  yield* pending.splice(0, pending.length);
}

export async function csvTable(
  source: GraphByteSource,
  signal: AbortSignal | undefined,
  /** Columns exempt from numeric coercion (identity columns). */
  identityColumns: ReadonlySet<string>,
): Promise<RowTable> {
  const records = csvRecords(byteChunks(source, signal));
  const iterator = records[Symbol.asyncIterator]();
  const head = await iterator.next();
  if (head.done) return EMPTY_ROW_TABLE;
  const columns = [...head.value];

  const rows = (async function* (): AsyncGenerator<Readonly<Record<string, unknown>>> {
    try {
      // Pass 1: retain up to SAMPLE_ROWS records and decide column numericness.
      const sample: (readonly string[])[] = [];
      let sampleDone = false;
      while (sample.length < SAMPLE_ROWS) {
        const next = await iterator.next();
        if (next.done) {
          sampleDone = true;
          break;
        }
        sample.push(next.value);
      }
      const numeric = columns.map((name, index) => {
        if (identityColumns.has(name)) return false;
        let nonEmpty = 0;
        for (const record of sample) {
          const cell = record[index];
          if (cell === undefined || cell === '') continue;
          nonEmpty++;
          if (coerceNumeric(cell) === null) return false;
        }
        return nonEmpty > 0;
      });

      const toRow = (record: readonly string[]): Readonly<Record<string, unknown>> => {
        const row: Record<string, unknown> = {};
        for (let i = 0; i < columns.length; i++) {
          const cell = record[i];
          if (cell === undefined || cell === '') continue; // empty cell → absent key
          const name = columns[i]!;
          const value = numeric[i] ? coerceNumeric(cell) : cell;
          if (value === null) continue; // post-sample outlier in a numeric column
          // A literal `__proto__` header must be data, never the legacy
          // Object.prototype setter.
          Object.defineProperty(row, name, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return row;
      };

      // Pass 2: replay the sample, then keep streaming.
      for (const record of sample) {
        yield toRow(record);
      }
      if (!sampleDone) {
        while (true) {
          throwIfAborted(signal);
          const next = await iterator.next();
          if (next.done) break;
          yield toRow(next.value);
        }
      }
    } finally {
      // `rows` manually drives the record iterator. Forward early return so
      // mapping/materialization failures close the caller's byte source.
      await iterator.return(undefined);
    }
  })();

  return {
    columns,
    rows,
    close: async () => {
      await iterator.return(undefined);
    },
  };
}
