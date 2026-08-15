/**
 * local PathService + emphasis planner.
 *
 * 1. The built-in LOCAL BFS service: direction semantics on a directed
 * triangle ('outgoing' default | 'incoming' | 'either'), unreachable and
 * unloaded endpoints resolving null (a RESULT — the promise never
 * rejects for reachability), visibility respected (hidden edges are
 * never walked; detours around them are), synthesized edge ids matching
 * the codec, and ctx.signal honored between scan chunks.
 * 2. BFS parity against a reference implementation over seeded random
 * graphs (mulberry32; 200 nodes / 600 edges) for all three directions,
 * with and without a random visibility mask: reachability parity,
 * hop-count optimality, and full path validity (endpoints, edge
 * direction, visibility, no repeated nodes).
 * 3. computePathEmphasis: index projection, path-order emphasis lane, dim
 * complement disjointness, hidden-link exclusion, and totality when an
 * id is missing from the scene.
 */

import { describe, expect, it } from 'vitest';

import {
  PATH_SCAN_CHUNK,
  computePathEmphasis,
  createLocalPathService,
} from '../src/pathService';
import type { LocalPathBase, PathEmphasisScene } from '../src/pathService';
import { OrbitOperationError } from '../src/errors';
import type { GraphOperationError } from '../src/errors';
import { createRequestContext } from '../src/services';
import type { RequestContextHandle } from '../src/services';
import type { EdgeId, GraphEdge, GraphNode, NodeId, PathOptions, PathResult } from '../src/types';

type Attrs = Record<string, unknown>;
type Base = LocalPathBase<Attrs, Attrs>;

/** Deterministic PRNG (mulberry32) so property runs are reproducible. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nodesOf(ids: readonly string[]): GraphNode<Attrs>[] {
  return ids.map((id) => ({ id }));
}

function edge(id: string, source: string, target: string): GraphEdge<Attrs> {
  return { id, source, target };
}

/** A RequestContext handle (unit tests drive the service directly). */
function ctx(): RequestContextHandle {
  return createRequestContext({
    datasetKey: 'ds',
    revisions: { source: 1, model: 1, scope: 0 },
  });
}

function find(
  base: Base,
  sourceId: NodeId,
  targetId: NodeId,
  options: PathOptions = {},
): Promise<PathResult | null> {
  const service = createLocalPathService<Attrs, Attrs>(() => base);
  return service.find(sourceId, targetId, options, ctx().context);
}

/** Await a rejection and return its typed detail. */
async function opError(p: Promise<unknown>): Promise<GraphOperationError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrbitOperationError);
    return (e as OrbitOperationError).detail;
  }
  throw new Error('expected the operation to reject');
}

// Directed triangle: a→b→c→a.
const triangle: Base = {
  nodes: nodesOf(['a', 'b', 'c']),
  edges: [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a')],
};

// ---------------------------------------------------------------------------
// Local BFS: direction semantics & result contract
// ---------------------------------------------------------------------------

describe('createLocalPathService — direction semantics (directed triangle)', () => {
  it("'outgoing' walks with the arrows: a→c goes the long way round", async () => {
    expect(await find(triangle, 'a', 'c', { direction: 'outgoing' })).toEqual({
      nodeIds: ['a', 'b', 'c'],
      edgeIds: ['ab', 'bc'],
    });
  });

  it("direction defaults to 'outgoing' when omitted", async () => {
    expect(await find(triangle, 'a', 'c')).toEqual({
      nodeIds: ['a', 'b', 'c'],
      edgeIds: ['ab', 'bc'],
    });
  });

  it("'incoming' walks against the arrows: a→c is one hop via c→a", async () => {
    expect(await find(triangle, 'a', 'c', { direction: 'incoming' })).toEqual({
      nodeIds: ['a', 'c'],
      edgeIds: ['ca'],
    });
  });

  it("'either' ignores arrows and takes the shortest side", async () => {
    expect(await find(triangle, 'a', 'c', { direction: 'either' })).toEqual({
      nodeIds: ['a', 'c'],
      edgeIds: ['ca'],
    });
  });

  it('source === target resolves the trivial path (no edges)', async () => {
    expect(await find(triangle, 'b', 'b')).toEqual({ nodeIds: ['b'], edgeIds: [] });
  });
});

describe('createLocalPathService — null is a result, not an error', () => {
  it('an unreachable pair RESOLVES null (direction-induced dead end)', async () => {
    const chain: Base = { nodes: nodesOf(['a', 'b']), edges: [edge('ab', 'a', 'b')] };
    await expect(find(chain, 'b', 'a', { direction: 'outgoing' })).resolves.toBeNull();
    // The same pair is reachable against the arrow.
    expect(await find(chain, 'b', 'a', { direction: 'incoming' })).toEqual({
      nodeIds: ['b', 'a'],
      edgeIds: ['ab'],
    });
  });

  it('a disconnected component resolves null under every direction', async () => {
    const base: Base = {
      nodes: nodesOf(['a', 'b', 'd']),
      edges: [edge('ab', 'a', 'b')],
    };
    for (const direction of ['outgoing', 'incoming', 'either'] as const) {
      await expect(find(base, 'a', 'd', { direction })).resolves.toBeNull();
    }
  });

  it('an endpoint id absent from the loaded base resolves null', async () => {
    await expect(find(triangle, 'a', 'ghost')).resolves.toBeNull();
    await expect(find(triangle, 'ghost', 'a')).resolves.toBeNull();
  });
});

describe('createLocalPathService — visibility', () => {
  it('never walks a hidden edge; detours around it when one exists', async () => {
    // Direct a→c hidden; the visible detour a→b→c must be taken.
    const base: Base = {
      nodes: nodesOf(['a', 'b', 'c']),
      edges: [edge('ac', 'a', 'c'), edge('ab', 'a', 'b'), edge('bc', 'b', 'c')],
      isEdgeVisible: (id: EdgeId) => id !== 'ac',
    };
    expect(await find(base, 'a', 'c')).toEqual({ nodeIds: ['a', 'b', 'c'], edgeIds: ['ab', 'bc'] });
  });

  it('hiding the only connecting edge makes the pair unreachable (null)', async () => {
    const base: Base = {
      nodes: nodesOf(['a', 'b']),
      edges: [edge('ab', 'a', 'b')],
      isEdgeVisible: () => false,
    };
    await expect(find(base, 'a', 'b', { direction: 'either' })).resolves.toBeNull();
  });
});

describe('createLocalPathService — edge id synthesis', () => {
  it('id-less edges resolve to accepted-style synthesized ids, ordinals counted over ALL id-less edges', async () => {
    const base: Base = {
      nodes: nodesOf(['a', 'b', 'c']),
      edges: [
        { source: 'a', target: 'b' }, // a→b#0 — hidden below
        { source: 'a', target: 'b' }, // a→b#1
        { source: 'b', target: 'c' }, // b→c#0
      ],
      // Hiding the first parallel must NOT renumber the second: ordinals
      // advance for every id-less edge in base order, visible or not.
      isEdgeVisible: (id: EdgeId) => id !== 'a→b#0',
    };
    expect(await find(base, 'a', 'c')).toEqual({
      nodeIds: ['a', 'b', 'c'],
      edgeIds: ['a→b#1', 'b→c#0'],
    });
  });
});

describe('createLocalPathService — ctx.signal between scan chunks', () => {
  /** Chain long enough that the edge scan crosses a chunk boundary. */
  function longChain(edges: number): Base {
    const ids = Array.from({ length: edges + 1 }, (_, i) => `n${i}`);
    return {
      nodes: nodesOf(ids),
      edges: ids.slice(0, -1).map((id, i) => edge(`e${i}`, id, ids[i + 1]!)),
    };
  }

  it('abort mid-scan rejects typed at the next chunk boundary', async () => {
    const base = longChain(PATH_SCAN_CHUNK + 100);
    const service = createLocalPathService<Attrs, Attrs>(() => base);
    const handle = ctx();
    const pending = service.find('n0', `n${PATH_SCAN_CHUNK + 100}`, {}, handle.context);
    handle.abort('stop'); // flips before the first chunk-boundary check
    const detail = await opError(pending);
    expect(detail.code).toBe('aborted');
    expect((detail as { cause?: unknown }).cause).toBe('stop');
  });

  it('a signal already aborted at entry rejects immediately', async () => {
    const service = createLocalPathService<Attrs, Attrs>(() => triangle);
    const handle = ctx();
    handle.abort();
    expect((await opError(service.find('a', 'c', {}, handle.context))).code).toBe('aborted');
  });

  it("declares revisionDependencies ['source', 'model', 'scope']", () => {
    const service = createLocalPathService<Attrs, Attrs>(() => triangle);
    expect(service.revisionDependencies).toEqual(['source', 'model', 'scope']);
  });
});

// ---------------------------------------------------------------------------
// BFS parity against a reference implementation (seeded random graphs)
// ---------------------------------------------------------------------------

type Direction = NonNullable<PathOptions['direction']>;

/** Reference: naive Map-based BFS returning hop distance, or null. */
function referenceDistance(
  base: Base,
  sourceId: NodeId,
  targetId: NodeId,
  direction: Direction,
): number | null {
  if (sourceId === targetId) return 0;
  const out = new Map<NodeId, NodeId[]>();
  for (const e of base.edges) {
    if (base.isEdgeVisible !== undefined && !base.isEdgeVisible(e.id!)) continue;
    if (direction !== 'incoming') {
      (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
    }
    if (direction !== 'outgoing') {
      (out.get(e.target) ?? out.set(e.target, []).get(e.target)!).push(e.source);
    }
  }
  const dist = new Map<NodeId, number>([[sourceId, 0]]);
  const queue: NodeId[] = [sourceId];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head]!;
    const d = dist.get(u)!;
    for (const v of out.get(u) ?? []) {
      if (dist.has(v)) continue;
      dist.set(v, d + 1);
      if (v === targetId) return d + 1;
      queue.push(v);
    }
  }
  return dist.get(targetId) ?? null;
}

/** Asserts a resolved path is VALID: endpoints, hop linkage under the given
 * direction, per-edge visibility, matching edge count, no repeated nodes. */
function assertValidPath(
  base: Base,
  path: PathResult,
  sourceId: NodeId,
  targetId: NodeId,
  direction: Direction,
): void {
  const { nodeIds, edgeIds } = path;
  expect(nodeIds[0]).toBe(sourceId);
  expect(nodeIds[nodeIds.length - 1]).toBe(targetId);
  expect(edgeIds.length).toBe(nodeIds.length - 1);
  expect(new Set(nodeIds).size).toBe(nodeIds.length);
  const byId = new Map(base.edges.map((e) => [e.id!, e]));
  for (let i = 0; i < edgeIds.length; i++) {
    const e = byId.get(edgeIds[i]!);
    expect(e).toBeDefined();
    if (base.isEdgeVisible !== undefined) expect(base.isEdgeVisible(e!.id!)).toBe(true);
    const from = nodeIds[i]!;
    const to = nodeIds[i + 1]!;
    const forward = e!.source === from && e!.target === to;
    const backward = e!.source === to && e!.target === from;
    if (direction === 'outgoing') expect(forward).toBe(true);
    else if (direction === 'incoming') expect(backward).toBe(true);
    else expect(forward || backward).toBe(true);
  }
}

function randomBase(rand: () => number, nodeCount: number, edgeCount: number): Base {
  const ids = Array.from({ length: nodeCount }, (_, i) => `n${i}`);
  const edges: GraphEdge<Attrs>[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const s = ids[Math.floor(rand() * nodeCount)]!;
    const t = ids[Math.floor(rand() * nodeCount)]!;
    edges.push(edge(`e${i}`, s, t));
  }
  return { nodes: nodesOf(ids), edges };
}

describe('createLocalPathService — parity with reference BFS (200 nodes / 600 edges)', () => {
  const directions: readonly Direction[] = ['outgoing', 'incoming', 'either'];

  it('reachability + hop-count parity and path validity, all directions', async () => {
    const rand = mulberry32(0x5127a708);
    const base = randomBase(rand, 200, 600);
    for (const direction of directions) {
      for (let trial = 0; trial < 40; trial++) {
        const sourceId = `n${Math.floor(rand() * 200)}`;
        const targetId = `n${Math.floor(rand() * 200)}`;
        const expected = referenceDistance(base, sourceId, targetId, direction);
        const path = await find(base, sourceId, targetId, { direction });
        if (expected === null) {
          expect(path, `${direction} ${sourceId}→${targetId}`).toBeNull();
        } else {
          expect(path, `${direction} ${sourceId}→${targetId}`).not.toBeNull();
          expect(path!.nodeIds.length, `${direction} ${sourceId}→${targetId}`).toBe(expected + 1);
          assertValidPath(base, path!, sourceId, targetId, direction);
        }
      }
    }
  });

  it('parity holds under a random visibility mask', async () => {
    const rand = mulberry32(0xbadc0de);
    const built = randomBase(rand, 200, 600);
    const hidden = new Set<EdgeId>();
    for (const e of built.edges) if (rand() < 0.2) hidden.add(e.id!);
    const base: Base = { ...built, isEdgeVisible: (id: EdgeId) => !hidden.has(id) };
    for (const direction of directions) {
      for (let trial = 0; trial < 25; trial++) {
        const sourceId = `n${Math.floor(rand() * 200)}`;
        const targetId = `n${Math.floor(rand() * 200)}`;
        const expected = referenceDistance(base, sourceId, targetId, direction);
        const path = await find(base, sourceId, targetId, { direction });
        if (expected === null) {
          expect(path, `${direction} ${sourceId}→${targetId}`).toBeNull();
        } else {
          expect(path!.nodeIds.length, `${direction} ${sourceId}→${targetId}`).toBe(expected + 1);
          assertValidPath(base, path!, sourceId, targetId, direction);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// computePathEmphasis — the pure half of the atomic findPath action
// ---------------------------------------------------------------------------

describe('computePathEmphasis', () => {
  /** Scene: 4 points (a..d), 5 links; the path is a→b→c (links 0 and 2). */
  const scene: PathEmphasisScene = {
    indexById: new Map([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 3],
    ]),
    edgeIdByIndex: ['ab', 'ad', 'bc', 'cd', 'db'],
  };
  const path: PathResult = { nodeIds: ['a', 'b', 'c'], edgeIds: ['ab', 'bc'] };

  it('projects nodes and edges to indices; dims exactly the complement', () => {
    const plan = computePathEmphasis(path, scene);
    expect(plan.nodeIndices).toEqual([0, 1, 2]);
    expect(plan.pathEdgeIndices).toEqual([0, 2]);
    expect(plan.dimEdgeIndices).toEqual([1, 3, 4]);
  });

  it('emphasis lane preserves PATH order, not scene order', () => {
    const reversed: PathResult = { nodeIds: ['c', 'b', 'a'], edgeIds: ['bc', 'ab'] };
    const plan = computePathEmphasis(reversed, scene);
    expect(plan.nodeIndices).toEqual([2, 1, 0]);
    expect(plan.pathEdgeIndices).toEqual([2, 0]);
  });

  it('emphasis and dim lanes are disjoint; hidden links leave the dim set', () => {
    const masked: PathEmphasisScene = {
      ...scene,
      isEdgeVisible: (link) => link !== 3, // 'cd' hidden — alpha already 0
    };
    const plan = computePathEmphasis(path, masked);
    expect(plan.dimEdgeIndices).toEqual([1, 4]);
    const overlap = plan.pathEdgeIndices.filter((i) => plan.dimEdgeIndices.includes(i));
    expect(overlap).toEqual([]);
  });

  it('stays total when an id is missing from the scene (skipped, never thrown)', () => {
    const stale: PathResult = { nodeIds: ['a', 'ghost', 'c'], edgeIds: ['ab', 'gone'] };
    const plan = computePathEmphasis(stale, scene);
    expect(plan.nodeIndices).toEqual([0, 2]);
    expect(plan.pathEdgeIndices).toEqual([0]);
    // Unknown path-edge ids still never leak into the dim complement.
    expect(plan.dimEdgeIndices).toEqual([1, 2, 3, 4]);
  });
});
