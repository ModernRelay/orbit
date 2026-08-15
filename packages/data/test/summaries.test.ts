/**
 * Summaries vs a naive oracle: count/nullCount/min/max, exact type-7
 * quantiles (n ≤ reservoir cap), approximateUnique, and top-20 categories
 * with truncation.
 */

import { describe, expect, it } from 'vitest';
import { prepareGraphData } from '../src/index';
import { TOP_CATEGORIES } from '../src/summaries';
import { oracleQuantiles, PARITY_OPTIONS } from './helpers';

const ROWS = 700;

function makeNodes(): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (let i = 0; i < ROWS; i++) {
    const row: Record<string, unknown> = { id: 'n' + i };
    if (i % 7 !== 0) row['value'] = ((i * 37) % 100) + i / 1000;
    row['category'] = 'cat' + (i % 25); // 25 distinct > TOP_CATEGORIES
    if (i % 13 === 0) row['noisy'] = Number.NaN; // hygiene: NaN → null
    else if (i % 13 === 1) row['noisy'] = Infinity; // hygiene: ∞ → null
    else row['noisy'] = i % 50;
    nodes.push(row);
  }
  return nodes;
}

describe('summaries vs naive oracle', () => {
  it('matches a naive single-pass oracle on every statistic', async () => {
    const nodes = makeNodes();
    const prepared = await prepareGraphData(
      { nodes, edges: [] },
      { nodes: { id: 'id' }, edges: { source: 'source', target: 'target' } },
      PARITY_OPTIONS,
    );

    // --- numeric column ----------------------------------------------------
    const values = nodes
      .map((r) => r['value'])
      .filter((v): v is number => typeof v === 'number');
    const value = prepared.summaries.nodes['value']!;
    expect(value.count).toBe(ROWS);
    expect(value.nullCount).toBe(ROWS - values.length);
    expect(value.min).toBe(Math.min(...values));
    expect(value.max).toBe(Math.max(...values));
    expect(value.quantiles).toEqual(oracleQuantiles(values)); // exact: n ≤ cap
    expect(value.approximateUnique).toBe(new Set(values).size);
    expect(value.categories).toBeUndefined();

    // --- categorical column with > 20 distinct values ----------------------
    const cats = nodes.map((r) => r['category'] as string);
    const counts = new Map<string, number>();
    for (const c of cats) counts.set(c, (counts.get(c) ?? 0) + 1);
    const oracleTop = [...counts.entries()]
      .sort((a, b) => b[1] - a[1]) // stable: ties keep first-occurrence order
      .slice(0, TOP_CATEGORIES)
      .map(([v, n]) => ({ value: v, count: n }));
    const category = prepared.summaries.nodes['category']!;
    expect(category.count).toBe(ROWS);
    expect(category.nullCount).toBe(0);
    expect(category.categories).toEqual(oracleTop);
    expect(category.categories).toHaveLength(TOP_CATEGORIES);
    expect(category.categoriesTruncated).toBe(true);
    expect(category.approximateUnique).toBe(25);
    expect(category.min).toBeUndefined();
    expect(category.quantiles).toBeUndefined();

    // --- hygiene: NaN/Infinity count as null -------------------------------
    const noisy = prepared.summaries.nodes['noisy']!;
    const usable = nodes
      .map((r) => r['noisy'])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    expect(noisy.count).toBe(ROWS);
    expect(noisy.nullCount).toBe(ROWS - usable.length);
    expect(noisy.min).toBe(Math.min(...usable));
    expect(noisy.max).toBe(Math.max(...usable));
  });

  it('does not truncate at or below the top-N bound', async () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({
      id: 'n' + i,
      tag: 'tag' + (i % 20),
    }));
    const prepared = await prepareGraphData(
      { nodes, edges: [] },
      { nodes: { id: 'id' }, edges: { source: 'source', target: 'target' } },
      PARITY_OPTIONS,
    );
    const tag = prepared.summaries.nodes['tag']!;
    expect(tag.categories).toHaveLength(20);
    expect(tag.categoriesTruncated).toBeUndefined();
  });

  it('summarizes booleans as categories and mixed columns on both lanes', async () => {
    const nodes = [
      { id: 'a', flag: true, mixed: 1 },
      { id: 'b', flag: false, mixed: 'one' },
      { id: 'c', flag: true, mixed: 2 },
    ];
    const prepared = await prepareGraphData(
      { nodes, edges: [] },
      { nodes: { id: 'id' }, edges: { source: 'source', target: 'target' } },
      PARITY_OPTIONS,
    );
    expect(prepared.summaries.nodes['flag']).toEqual({
      count: 3,
      nullCount: 0,
      approximateUnique: 2,
      categories: [
        { value: 'true', count: 2 },
        { value: 'false', count: 1 },
      ],
    });
    const mixed = prepared.summaries.nodes['mixed']!;
    expect(mixed.min).toBe(1);
    expect(mixed.max).toBe(2);
    expect(mixed.categories).toEqual([{ value: 'one', count: 1 }]);
    expect(mixed.approximateUnique).toBe(3); // 1, 2, and 'one' — type-tagged
  });

  it('counts an all-empty seeded CSV column as fully null', async () => {
    const csv = new TextEncoder().encode('id,gap\na,\nb,\n').buffer as ArrayBuffer;
    const prepared = await prepareGraphData(
      { nodes: csv, edges: new TextEncoder().encode('source,target\na,b\n').buffer as ArrayBuffer },
      { nodes: { id: 'id' }, edges: { source: 'source', target: 'target' } },
      { ...PARITY_OPTIONS, format: 'csv' },
    );
    expect(prepared.summaries.nodes['gap']).toEqual({ count: 2, nullCount: 2 });
  });
});
