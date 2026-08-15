/**
 * CSV numeric-column heuristic: a column parses to numbers only when
 * the WHOLE column is numeric-or-empty, decided from the first
 * SAMPLE_ROWS = 1000 data rows, with identity columns exempt.
 */

import { describe, expect, it } from 'vitest';
import { csvTable, SAMPLE_ROWS } from '../src/csv';
import { prepareGraphData } from '../src/index';
import { PARITY_OPTIONS, textBytes } from './helpers';

async function materialize(csv: string, identity: ReadonlySet<string> = new Set()) {
  const table = await csvTable(textBytes(csv).buffer as ArrayBuffer, undefined, identity);
  const rows: Record<string, unknown>[] = [];
  for await (const row of table.rows) rows.push({ ...row });
  return rows;
}

describe('CSV numeric heuristic', () => {
  it('keeps a column as strings when ANY sampled cell is non-numeric', async () => {
    const rows = await materialize('v\n1\n2\nx\n');
    expect(rows).toEqual([{ v: '1' }, { v: '2' }, { v: 'x' }]);
  });

  it('types a numeric-or-empty column as numbers with empties absent', async () => {
    const rows = await materialize('v\n1\n\r\n2.5\n\n1e3\n');
    expect(rows).toEqual([{ v: 1 }, { v: 2.5 }, { v: 1000 }]);
  });

  it("disqualifies via core hygiene sentinels ('NaN' is not numeric)", async () => {
    const rows = await materialize('v\n1\nNaN\n');
    expect(rows).toEqual([{ v: '1' }, { v: 'NaN' }]);
  });

  it('leaves an all-empty-in-sample column as strings (no evidence)', async () => {
    const rows = await materialize('a,b\n1,\n2,\n');
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('pins the decision from the sample: post-sample outliers go absent', async () => {
    const lines = ['v'];
    for (let i = 0; i < SAMPLE_ROWS; i++) lines.push(String(i));
    lines.push('not-a-number'); // row 1000 — beyond the decision sample
    lines.push('7');
    const rows = await materialize(lines.join('\n') + '\n');
    expect(rows).toHaveLength(SAMPLE_ROWS + 2);
    expect(rows[0]).toEqual({ v: 0 });
    expect(rows[SAMPLE_ROWS]).toEqual({}); // outlier coerces to null → absent
    expect(rows[SAMPLE_ROWS + 1]).toEqual({ v: 7 });
  });

  it('decides string when the non-numeric cell IS in the sample', async () => {
    const lines = ['v'];
    for (let i = 0; i < SAMPLE_ROWS - 1; i++) lines.push(String(i));
    lines.push('not-a-number'); // row 999 — inside the decision sample
    const rows = await materialize(lines.join('\n') + '\n');
    expect(rows[0]).toEqual({ v: '0' });
    expect(rows[SAMPLE_ROWS - 1]).toEqual({ v: 'not-a-number' });
  });

  it('exempts identity columns so ids like 01 and 1 never collapse', async () => {
    const prepared = await prepareGraphData(
      {
        nodes: textBytes('id,score\n01,10\n1,20\n').buffer as ArrayBuffer,
        edges: textBytes('source,target\n01,1\n').buffer as ArrayBuffer,
      },
      { nodes: { id: 'id' }, edges: { source: 'source', target: 'target' } },
      { ...PARITY_OPTIONS, format: 'csv' },
    );
    expect(prepared.snapshot.nodes).toEqual([
      { id: '01', attrs: { score: 10 } },
      { id: '1', attrs: { score: 20 } },
    ]);
    expect(prepared.snapshot.edges).toEqual([{ source: '01', target: '1' }]);
  });
});
