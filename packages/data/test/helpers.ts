/**
 * Shared test data: ONE logical parity dataset expressed per lane (rows,
 * CSV bytes, JSON document, Arrow IPC, Parquet fixture files) — every lane
 * must produce the same snapshot + summaries through prepareGraphData and
 * the format entries.
 */

import type { GraphColumnMapping, PreparedGraphSummaries } from '../src/types';

export const PARITY_MAPPING: GraphColumnMapping = {
  nodes: { id: 'id' },
  edges: { id: 'id', source: 'source', target: 'target' },
};

export const PARITY_OPTIONS = { datasetKey: 'parity', sourceRevision: 1 } as const;

export const PARITY_NODE_ROWS = [
  { id: 'a', label: 'Alpha', size: 1.5, group: 'x' },
  { id: 'b', label: 'Beta', size: 2, group: 'y' },
  { id: 'c', label: 'Gamma', group: 'x' },
] as const;

export const PARITY_EDGE_ROWS = [
  { id: 'e1', source: 'a', target: 'b', weight: 0.5, kind: 'follows' },
  { id: 'e2', source: 'b', target: 'c', weight: 1.25, kind: 'follows' },
  { source: 'c', target: 'a', weight: 2, kind: 'likes' },
] as const;

export const PARITY_NODES_CSV =
  'id,label,size,group\r\n' + 'a,Alpha,1.5,x\r\n' + 'b,Beta,2,y\r\n' + 'c,Gamma,,x\r\n';

export const PARITY_EDGES_CSV =
  'id,source,target,weight,kind\r\n' +
  'e1,a,b,0.5,follows\r\n' +
  'e2,b,c,1.25,follows\r\n' +
  ',c,a,2,likes\r\n';

export const PARITY_DOCUMENT = JSON.stringify({
  graph: {
    nodes: PARITY_NODE_ROWS,
    links: PARITY_EDGE_ROWS,
  },
});

export const PARITY_EXPECTED_SNAPSHOT = {
  datasetKey: 'parity',
  sourceRevision: 1,
  nodes: [
    { id: 'a', attrs: { label: 'Alpha', size: 1.5, group: 'x' } },
    { id: 'b', attrs: { label: 'Beta', size: 2, group: 'y' } },
    { id: 'c', attrs: { label: 'Gamma', group: 'x' } },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'b', attrs: { weight: 0.5, kind: 'follows' } },
    { id: 'e2', source: 'b', target: 'c', attrs: { weight: 1.25, kind: 'follows' } },
    { source: 'c', target: 'a', attrs: { weight: 2, kind: 'likes' } },
  ],
};

/** Type-7 quantiles, mirrored from the documented summary rules. */
export function oracleQuantiles(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return [0.25, 0.5, 0.75].map((p) => {
    if (n === 1) return sorted[0]!;
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
  });
}

export const PARITY_EXPECTED_SUMMARIES: PreparedGraphSummaries = {
  nodes: {
    label: {
      count: 3,
      nullCount: 0,
      approximateUnique: 3,
      categories: [
        { value: 'Alpha', count: 1 },
        { value: 'Beta', count: 1 },
        { value: 'Gamma', count: 1 },
      ],
    },
    size: {
      count: 3,
      nullCount: 1,
      min: 1.5,
      max: 2,
      quantiles: oracleQuantiles([1.5, 2]),
      approximateUnique: 2,
    },
    group: {
      count: 3,
      nullCount: 0,
      approximateUnique: 2,
      categories: [
        { value: 'x', count: 2 },
        { value: 'y', count: 1 },
      ],
    },
  },
  edges: {
    weight: {
      count: 3,
      nullCount: 0,
      min: 0.5,
      max: 2,
      quantiles: oracleQuantiles([0.5, 1.25, 2]),
      approximateUnique: 3,
    },
    kind: {
      count: 3,
      nullCount: 0,
      approximateUnique: 2,
      categories: [
        { value: 'follows', count: 2 },
        { value: 'likes', count: 1 },
      ],
    },
  },
};

export function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Split bytes into chunks at the given cut offsets (sorted, exclusive). */
export function chunked(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const cut of cuts) {
    chunks.push(bytes.subarray(start, cut));
    start = cut;
  }
  chunks.push(bytes.subarray(start));
  return chunks.filter((c) => c.byteLength > 0);
}

export async function* byteStream(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) {
    await Promise.resolve(); // force genuinely asynchronous chunk delivery
    yield chunk;
  }
}

export async function* rowStreamOf(rows: readonly unknown[]): AsyncGenerator<unknown> {
  for (const row of rows) {
    await Promise.resolve();
    yield row;
  }
}
