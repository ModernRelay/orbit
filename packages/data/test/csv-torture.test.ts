/**
 * CSV chunk-boundary torture: RFC 4180 quotes/escapes/CRLF must
 * survive EVERY possible chunk boundary, including cuts inside quoted
 * fields, inside `""` escapes, between CR and LF, and inside multi-byte
 * UTF-8 sequences.
 */

import { describe, expect, it } from 'vitest';
import { csvRecords, csvTable } from '../src/csv';
import { byteStream, chunked, textBytes } from './helpers';

const TORTURE_CSV =
  'id,quote,note\r\n' +
  'r1,"hello, world","line one\nline two"\r\n' +
  'r2,"she said ""hi""",plain\r\n' +
  'r3,"trailing ""q"" mid, and\r\ncrlf inside",café ☕\r\n' +
  'r4,,empty above\n' + // bare-LF record end and an empty cell
  '\r\n' + // blank line — skipped
  'r5,"",quoted-empty\r\n';

const EXPECTED_RECORDS = [
  ['id', 'quote', 'note'],
  ['r1', 'hello, world', 'line one\nline two'],
  ['r2', 'she said "hi"', 'plain'],
  ['r3', 'trailing "q" mid, and\r\ncrlf inside', 'café ☕'],
  ['r4', '', 'empty above'],
  ['r5', '', 'quoted-empty'],
];

async function parseAll(chunks: readonly Uint8Array[]): Promise<string[][]> {
  const records: string[][] = [];
  for await (const record of csvRecords(byteStream(chunks))) {
    records.push([...record]);
  }
  return records;
}

describe('CSV chunk-boundary torture', () => {
  const bytes = textBytes(TORTURE_CSV);

  it('parses the torture file in one chunk', async () => {
    expect(await parseAll([bytes])).toEqual(EXPECTED_RECORDS);
  });

  it('parses identically when split at EVERY byte boundary (two chunks)', async () => {
    for (let cut = 1; cut < bytes.byteLength; cut++) {
      expect(await parseAll(chunked(bytes, [cut])), `cut at byte ${cut}`).toEqual(
        EXPECTED_RECORDS,
      );
    }
  });

  it('parses identically when every byte is its own chunk', async () => {
    const cuts = Array.from({ length: bytes.byteLength - 1 }, (_, i) => i + 1);
    expect(await parseAll(chunked(bytes, cuts))).toEqual(EXPECTED_RECORDS);
  });

  it('handles a final record without a trailing newline', async () => {
    expect(await parseAll([textBytes('a,b\n1,"x,y"')])).toEqual([
      ['a', 'b'],
      ['1', 'x,y'],
    ]);
  });

  it('rejects an unterminated quote at EOF', async () => {
    await expect(parseAll([textBytes('a,b\n1,"never closed')])).rejects.toThrow(
      /unterminated quoted field/,
    );
  });

  it('maps records to row objects with empty cells absent', async () => {
    const table = await csvTable(
      textBytes(TORTURE_CSV).buffer as ArrayBuffer,
      undefined,
      new Set(['id']),
    );
    expect(table.columns).toEqual(['id', 'quote', 'note']);
    const rows: unknown[] = [];
    for await (const row of table.rows) rows.push(row);
    expect(rows).toEqual([
      { id: 'r1', quote: 'hello, world', note: 'line one\nline two' },
      { id: 'r2', quote: 'she said "hi"', note: 'plain' },
      { id: 'r3', quote: 'trailing "q" mid, and\r\ncrlf inside', note: 'café ☕' },
      { id: 'r4', note: 'empty above' }, // empty cell → absent key
      { id: 'r5', note: 'quoted-empty' }, // quoted-empty cell → absent key
    ]);
  });

  it('ignores extra cells and leaves short rows partially absent', async () => {
    const table = await csvTable(
      textBytes('a,b,c\n1,2,3,4\n5\n').buffer as ArrayBuffer,
      undefined,
      new Set<string>(),
    );
    const rows: unknown[] = [];
    for await (const row of table.rows) rows.push(row);
    expect(rows).toEqual([{ a: 1, b: 2, c: 3 }, { a: 5 }]);
  });
});
