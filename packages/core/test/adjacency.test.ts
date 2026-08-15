import { describe, expect, it } from 'vitest';
import { buildAdjacency, neighborsOf } from '../src/adjacency';

/** Deterministic PRNG (mulberry32) so property runs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function linksOf(pairs: ReadonlyArray<readonly [number, number]>): Uint32Array {
  const out = new Uint32Array(pairs.length * 2);
  for (let i = 0; i < pairs.length; i++) {
    out[i * 2] = pairs[i]![0];
    out[i * 2 + 1] = pairs[i]![1];
  }
  return out;
}

function sortedNeighbors(adj: ReturnType<typeof buildAdjacency>, index: number): number[] {
  return Array.from(neighborsOf(adj, index)).sort((x, y) => x - y);
}

describe('buildAdjacency', () => {
  it('handles the empty graph', () => {
    const adj = buildAdjacency(new Uint32Array(0), 0);
    expect(Array.from(adj.offsets)).toEqual([0]);
    expect(adj.neighbors).toHaveLength(0);
  });

  it('handles points with no links', () => {
    const adj = buildAdjacency(new Uint32Array(0), 3);
    expect(Array.from(adj.offsets)).toEqual([0, 0, 0, 0]);
    for (let p = 0; p < 3; p++) expect(neighborsOf(adj, p)).toHaveLength(0);
  });

  it('builds an undirected path graph 0-1-2', () => {
    const adj = buildAdjacency(linksOf([[0, 1], [1, 2]]), 3);
    expect(sortedNeighbors(adj, 0)).toEqual([1]);
    expect(sortedNeighbors(adj, 1)).toEqual([0, 2]);
    expect(sortedNeighbors(adj, 2)).toEqual([1]);
    expect(adj.neighbors).toHaveLength(4); // 2 entries per link
  });

  it('builds a star (hub as source and as target)', () => {
    const adj = buildAdjacency(linksOf([[0, 1], [0, 2], [3, 0], [4, 0]]), 5);
    expect(sortedNeighbors(adj, 0)).toEqual([1, 2, 3, 4]);
    for (let leaf = 1; leaf < 5; leaf++) expect(sortedNeighbors(adj, leaf)).toEqual([0]);
  });

  it('lists a self-loop once per endpoint slot (twice under its point)', () => {
    const adj = buildAdjacency(linksOf([[1, 1]]), 3);
    expect(Array.from(neighborsOf(adj, 1))).toEqual([1, 1]);
    expect(neighborsOf(adj, 0)).toHaveLength(0);
    expect(neighborsOf(adj, 2)).toHaveLength(0);
  });

  it('keeps parallel edges as repeated entries (multiset, not set)', () => {
    const adj = buildAdjacency(linksOf([[0, 1], [0, 1], [1, 0]]), 2);
    expect(sortedNeighbors(adj, 0)).toEqual([1, 1, 1]);
    expect(sortedNeighbors(adj, 1)).toEqual([0, 0, 0]);
  });

  it('handles mixed self-loops, parallels, and isolated points', () => {
    const adj = buildAdjacency(linksOf([[2, 2], [0, 2], [2, 0], [4, 3]]), 6);
    expect(sortedNeighbors(adj, 0)).toEqual([2, 2]);
    expect(sortedNeighbors(adj, 2)).toEqual([0, 0, 2, 2]);
    expect(sortedNeighbors(adj, 3)).toEqual([4]);
    expect(sortedNeighbors(adj, 4)).toEqual([3]);
    expect(neighborsOf(adj, 1)).toHaveLength(0);
    expect(neighborsOf(adj, 5)).toHaveLength(0);
  });

  it('returns zero-copy subarray views into the shared neighbors buffer', () => {
    const adj = buildAdjacency(linksOf([[0, 1], [1, 2]]), 3);
    const view = neighborsOf(adj, 1);
    expect(view.buffer).toBe(adj.neighbors.buffer);
    expect(view.byteOffset).toBe(adj.offsets[1]! * 4);
  });

  it('throws on an odd-length link buffer', () => {
    expect(() => buildAdjacency(new Uint32Array([0, 1, 2]), 3)).toThrow(RangeError);
  });

  it('throws on an out-of-range endpoint', () => {
    expect(() => buildAdjacency(linksOf([[0, 3]]), 3)).toThrow(RangeError);
    expect(() => buildAdjacency(linksOf([[0, 0]]), 0)).toThrow(RangeError);
  });

  it('throws on a bad pointCount', () => {
    expect(() => buildAdjacency(new Uint32Array(0), -1)).toThrow(RangeError);
    expect(() => buildAdjacency(new Uint32Array(0), 1.5)).toThrow(RangeError);
  });
});

describe('neighborsOf', () => {
  it('throws on out-of-range point index', () => {
    const adj = buildAdjacency(linksOf([[0, 1]]), 2);
    expect(() => neighborsOf(adj, -1)).toThrow(RangeError);
    expect(() => neighborsOf(adj, 2)).toThrow(RangeError);
    expect(() => neighborsOf(adj, 0.5)).toThrow(RangeError);
  });
});

describe('property: CSR adjacency matches a naive oracle', () => {
  it('agrees with a Map-based multiset oracle on random graphs', () => {
    const rand = mulberry32(0xc0ffee);
    for (let trial = 0; trial < 30; trial++) {
      const pointCount = 1 + Math.floor(rand() * 200);
      const linkCount = Math.floor(rand() * 400);
      const pairs: Array<readonly [number, number]> = [];
      for (let l = 0; l < linkCount; l++) {
        // Uniform endpoints: naturally includes self-loops and parallels.
        pairs.push([Math.floor(rand() * pointCount), Math.floor(rand() * pointCount)]);
      }
      const adj = buildAdjacency(linksOf(pairs), pointCount);

      const oracle = new Map<number, number[]>();
      for (const [a, b] of pairs) {
        let la = oracle.get(a);
        if (la === undefined) oracle.set(a, (la = []));
        la.push(b);
        let lb = oracle.get(b);
        if (lb === undefined) oracle.set(b, (lb = []));
        lb.push(a);
      }

      expect(adj.offsets).toHaveLength(pointCount + 1);
      expect(adj.neighbors).toHaveLength(pairs.length * 2);
      for (let p = 0; p < pointCount; p++) {
        const got = sortedNeighbors(adj, p);
        const want = (oracle.get(p) ?? []).slice().sort((x, y) => x - y);
        if (got.length !== want.length || got.some((v, i) => v !== want[i])) {
          expect.fail(
            `trial ${trial}, point ${p}: got [${got.join(',')}], want [${want.join(',')}]`,
          );
        }
      }
    }
  });
});
