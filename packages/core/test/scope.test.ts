import { describe, expect, it } from 'vitest';
import { buildAcceptedAdjacency, cascadeEdges, resolveScope } from '../src/scope';
import type { AcceptedEdge, AcceptedGraph, NodeId, SubgraphSpec } from '../src/types';

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

function accepted(
  ids: readonly string[],
  links: ReadonlyArray<readonly [string, string]> = [],
): AcceptedGraph {
  return {
    datasetKey: 'ds',
    sourceRevision: 1,
    nodes: ids.map((id) => ({ id })),
    edges: links.map(([source, target], i) => ({ id: `e${i}`, source, target })),
    nodeIndex: new Map(ids.map((id, i) => [id, i] as const)),
    diagnostics: [],
  };
}

function nodeIdsOf(result: { nodes: readonly { id: string }[] }): string[] {
  return result.nodes.map((n) => n.id);
}

function edgeIdsOf(result: { edges: readonly AcceptedEdge[] }): string[] {
  return result.edges.map((e) => e.id);
}

/** Naive id-level BFS oracle: closed N-hop neighborhood over undirected edges. */
function bfsOracle(
  graph: AcceptedGraph,
  seeds: readonly string[],
  hops: number,
): Set<string> {
  const known = seeds.filter((id) => graph.nodeIndex.has(id));
  let frontier = new Set(known);
  const visited = new Set(known);
  for (let depth = 0; depth < hops; depth++) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (frontier.has(edge.source) && !visited.has(edge.target)) next.add(edge.target);
      if (frontier.has(edge.target) && !visited.has(edge.source)) next.add(edge.source);
    }
    if (next.size === 0) break;
    for (const id of next) visited.add(id);
    frontier = next;
  }
  return visited;
}

describe('cascadeEdges', () => {
  const edges: AcceptedEdge[] = [
    { id: 'ab', source: 'a', target: 'b' },
    { id: 'bc', source: 'b', target: 'c' },
    { id: 'aa', source: 'a', target: 'a' },
    { id: 'cd', source: 'c', target: 'd' },
  ];

  it('keeps an edge iff BOTH endpoints survive', () => {
    const survivors = new Set(['a', 'b']);
    const out = cascadeEdges(edges, (id) => survivors.has(id));
    expect(out.map((e) => e.id)).toEqual(['ab', 'aa']);
  });

  it('keeps a self-loop iff its single endpoint survives', () => {
    expect(cascadeEdges(edges, (id) => id === 'a').map((e) => e.id)).toEqual(['aa']);
    expect(cascadeEdges(edges, (id) => id === 'b')).toEqual([]);
  });

  it('returns the same edge objects, never copies', () => {
    const out = cascadeEdges(edges, () => true);
    expect(out).toHaveLength(edges.length);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(edges[i]);
  });

  it('handles empty inputs and all-dead predicates', () => {
    expect(cascadeEdges([], () => true)).toEqual([]);
    expect(cascadeEdges(edges, () => false)).toEqual([]);
  });

  it('property: matches the naive filter on random graphs', () => {
    const rand = mulberry32(0x5c09e);
    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + Math.floor(rand() * 30);
      const ids = Array.from({ length: n }, (_, i) => `n${i}`);
      const m = Math.floor(rand() * 80);
      const randomEdges: AcceptedEdge[] = Array.from({ length: m }, (_, i) => ({
        id: `e${i}`,
        source: ids[Math.floor(rand() * n)]!,
        target: ids[Math.floor(rand() * n)]!,
      }));
      const survivors = new Set(ids.filter(() => rand() < 0.5));
      const survives = (id: NodeId) => survivors.has(id);
      const got = cascadeEdges(randomEdges, survives);
      const want = randomEdges.filter((e) => survives(e.source) && survives(e.target));
      expect(got).toEqual(want);
    }
  });
});

describe('resolveScope', () => {
  // a-b-c-d path, e branch off b, isolated f, self-loop on d, parallel a-b.
  const base = accepted(
    ['a', 'b', 'c', 'd', 'e', 'f'],
    [
      ['a', 'b'], // e0
      ['b', 'c'], // e1
      ['c', 'd'], // e2
      ['b', 'e'], // e3
      ['d', 'd'], // e4 self-loop
      ['b', 'a'], // e5 parallel (reversed)
    ],
  );

  it('hops 0 (default): seeds only, edges among seeds', () => {
    const r = resolveScope(base, { seedIds: ['a', 'b'] }, null);
    expect(nodeIdsOf(r)).toEqual(['a', 'b']);
    expect(edgeIdsOf(r)).toEqual(['e0', 'e5']);
    expect(r.nodeIds).toEqual(new Set(['a', 'b']));
  });

  it('hops 1: closed 1-hop neighborhood with cascaded edges', () => {
    const r = resolveScope(base, { seedIds: ['b'], hops: 1 }, null);
    expect(nodeIdsOf(r)).toEqual(['a', 'b', 'c', 'e']);
    expect(edgeIdsOf(r)).toEqual(['e0', 'e1', 'e3', 'e5']);
  });

  it('hops 2: reaches d and retains its self-loop', () => {
    const r = resolveScope(base, { seedIds: ['b'], hops: 2 }, null);
    expect(nodeIdsOf(r)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(edgeIdsOf(r)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('a seed with a self-loop keeps the loop at hops 0', () => {
    const r = resolveScope(base, { seedIds: ['d'] }, null);
    expect(nodeIdsOf(r)).toEqual(['d']);
    expect(edgeIdsOf(r)).toEqual(['e4']);
  });

  it('self-loops do not manufacture extra hop reach', () => {
    const r = resolveScope(base, { seedIds: ['d'], hops: 1 }, null);
    expect(nodeIdsOf(r)).toEqual(['c', 'd']);
  });

  it('drops seeds unknown to the accepted base', () => {
    const r = resolveScope(base, { seedIds: ['nope', 'b', 'ghost'], hops: 0 }, null);
    expect(nodeIdsOf(r)).toEqual(['b']);
  });

  it('resolves to the empty scope when every seed is unknown (even with hops)', () => {
    const r = resolveScope(base, { seedIds: ['x', 'y'], hops: 3 }, null);
    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
    expect(r.nodeIds.size).toBe(0);
  });

  it('dedupes repeated seeds', () => {
    const r = resolveScope(base, { seedIds: ['b', 'b', 'a', 'b'] }, null);
    expect(nodeIdsOf(r)).toEqual(['a', 'b']);
  });

  it('preserves accepted-base order regardless of seed order', () => {
    const r = resolveScope(base, { seedIds: ['e', 'c', 'a'] }, null);
    expect(nodeIdsOf(r)).toEqual(['a', 'c', 'e']);
  });

  it('returns the same node/edge objects as the accepted base', () => {
    const r = resolveScope(base, { seedIds: ['a', 'b'] }, null);
    expect(r.nodes[0]).toBe(base.nodes[0]);
    expect(r.edges[0]).toBe(base.edges[0]);
  });

  it('treats negative, fractional, and non-finite hops as clamped/floored', () => {
    expect(nodeIdsOf(resolveScope(base, { seedIds: ['b'], hops: -1 }, null))).toEqual(['b']);
    expect(nodeIdsOf(resolveScope(base, { seedIds: ['b'], hops: 1.9 }, null))).toEqual([
      'a',
      'b',
      'c',
      'e',
    ]);
    expect(nodeIdsOf(resolveScope(base, { seedIds: ['b'], hops: Number.NaN }, null))).toEqual([
      'b',
    ]);
  });

  it('produces identical results with a caller-provided adjacency', () => {
    const adjacency = buildAcceptedAdjacency(base);
    const withAdj = resolveScope(base, { seedIds: ['b'], hops: 2 }, adjacency);
    const withoutAdj = resolveScope(base, { seedIds: ['b'], hops: 2 }, null);
    expect(nodeIdsOf(withAdj)).toEqual(nodeIdsOf(withoutAdj));
    expect(edgeIdsOf(withAdj)).toEqual(edgeIdsOf(withoutAdj));
  });

  it('handles the empty accepted base', () => {
    const empty = accepted([]);
    const r = resolveScope(empty, { seedIds: ['a'], hops: 2 }, null);
    expect(r.nodes).toEqual([]);
    expect(r.edges).toEqual([]);
  });

  it('property: node set matches an id-level BFS oracle on random graphs', () => {
    const rand = mulberry32(0xbf5bf5);
    for (let trial = 0; trial < 40; trial++) {
      const n = 1 + Math.floor(rand() * 40);
      const ids = Array.from({ length: n }, (_, i) => `n${i}`);
      const m = Math.floor(rand() * 100);
      const links: Array<readonly [string, string]> = Array.from({ length: m }, () => [
        ids[Math.floor(rand() * n)]!,
        ids[Math.floor(rand() * n)]!,
      ]);
      const graph = accepted(ids, links);
      const adjacency = rand() < 0.5 ? buildAcceptedAdjacency(graph) : null;

      const seedCount = 1 + Math.floor(rand() * 4);
      const seeds = Array.from({ length: seedCount }, () =>
        rand() < 0.15 ? 'unknown-id' : ids[Math.floor(rand() * n)]!,
      );
      const hops = Math.floor(rand() * 4);

      const spec: SubgraphSpec = { seedIds: seeds, hops };
      const r = resolveScope(graph, spec, adjacency);
      const want = bfsOracle(graph, seeds, hops);

      expect(r.nodeIds).toEqual(want);
      // Order preservation: nodes appear in accepted-base order.
      expect(nodeIdsOf(r)).toEqual(ids.filter((id) => want.has(id)));
      // Edge cascade: exactly the edges with both endpoints surviving.
      expect(edgeIdsOf(r)).toEqual(
        graph.edges.filter((e) => want.has(e.source) && want.has(e.target)).map((e) => e.id),
      );
    }
  });
});

describe('buildAcceptedAdjacency', () => {
  it('throws on a malformed accepted graph with a dangling edge', () => {
    const bad: AcceptedGraph = {
      ...accepted(['a']),
      edges: [{ id: 'e0', source: 'a', target: 'zzz' }],
    };
    expect(() => buildAcceptedAdjacency(bad)).toThrow(RangeError);
  });
});
