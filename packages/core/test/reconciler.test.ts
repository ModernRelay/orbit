import { describe, expect, it } from 'vitest';
import { Reconciler } from '../src/reconciler';
import type {
  AcceptedEdge,
  AcceptedGraph,
  GraphNode,
  NodeId,
  RenderScene,
} from '../src/types';

// ---------------------------------------------------------------------------
// Fixture helper: build an AcceptedGraph by hand (validateSnapshot is owned by
// another module and must not be imported here). Mirrors output shape:
// nodes in accepted-base order, edges with ids and no dangling endpoints.
// ---------------------------------------------------------------------------

type NodeSpec = string | { id: string; x?: number; y?: number; attrs?: Record<string, unknown> };
type EdgeSpec = [source: string, target: string] | { id?: string; source: string; target: string };

function accept(
  nodeSpecs: readonly NodeSpec[],
  edgeSpecs: readonly EdgeSpec[] = [],
  opts?: { datasetKey?: string; sourceRevision?: number | string },
): AcceptedGraph {
  const nodes: GraphNode[] = [];
  const nodeIndex = new Map<NodeId, number>();
  for (const spec of nodeSpecs) {
    const s = typeof spec === 'string' ? { id: spec } : spec;
    if (nodeIndex.has(s.id)) continue; // first-wins dedupe, like validation
    const node: GraphNode = { id: s.id };
    if (s.x !== undefined) node.x = s.x;
    if (s.y !== undefined) node.y = s.y;
    if (s.attrs !== undefined) node.attrs = s.attrs;
    nodeIndex.set(s.id, nodes.length);
    nodes.push(node);
  }
  const edges: AcceptedEdge[] = [];
  const parallelCount = new Map<string, number>();
  for (const spec of edgeSpecs) {
    const s = Array.isArray(spec) ? { source: spec[0], target: spec[1] } : spec;
    if (!nodeIndex.has(s.source) || !nodeIndex.has(s.target)) continue; // dangling dropped
    let id = s.id;
    if (id === undefined) {
      const key = `${s.source}→${s.target}`;
      const k = parallelCount.get(key) ?? 0;
      parallelCount.set(key, k + 1);
      id = `${key}#${k}`;
    }
    edges.push({ id, source: s.source, target: s.target });
  }
  return {
    datasetKey: opts?.datasetKey ?? 'ds',
    sourceRevision: opts?.sourceRevision ?? 1,
    nodes,
    edges,
    nodeIndex,
    diagnostics: [],
  };
}

function posOf(scene: RenderScene, id: NodeId): [number, number] {
  const i = scene.indexById.get(id);
  expect(i, `id ${id} present in scene`).toBeDefined();
  return [scene.positions[2 * i!]!, scene.positions[2 * i! + 1]!];
}

function expectNaNPair(scene: RenderScene, id: NodeId): void {
  const [x, y] = posOf(scene, id);
  expect(Number.isNaN(x), `${id}.x is NaN`).toBe(true);
  expect(Number.isNaN(y), `${id}.y is NaN`).toBe(true);
}

/** Engine-readback stand-in: deterministic finite integer positions per slot. */
function enginePositions(scene: RenderScene, offset = 0): Float32Array {
  const out = new Float32Array(2 * scene.count);
  for (let i = 0; i < scene.count; i++) {
    out[2 * i] = offset + i * 10 + 1;
    out[2 * i + 1] = offset + i * 10 + 2;
  }
  return out;
}

function assertSceneInvariants(scene: RenderScene, accepted: AcceptedGraph): void {
  // Bijection: idByIndex / indexById are exact inverses over the node set.
  expect(scene.count).toBe(accepted.nodes.length);
  expect(scene.idByIndex.length).toBe(scene.count);
  expect(scene.indexById.size).toBe(scene.count);
  for (let i = 0; i < scene.count; i++) {
    const id = scene.idByIndex[i]!;
    expect(id).toBe(accepted.nodes[i]!.id);
    expect(scene.indexById.get(id)).toBe(i);
  }
  // Buffer sizing.
  expect(scene.positions.length).toBe(2 * scene.count);
  expect(scene.linkCount).toBe(accepted.edges.length);
  expect(scene.links.length).toBe(2 * scene.linkCount);
  expect(scene.edgeIdByIndex.length).toBe(scene.linkCount);
  // Links: in accepted edge order, never pointing at a dead slot, endpoints
  // resolving back to the edge's source/target ids.
  for (let k = 0; k < scene.linkCount; k++) {
    const edge = accepted.edges[k]!;
    expect(scene.edgeIdByIndex[k]).toBe(edge.id);
    const s = scene.links[2 * k]!;
    const t = scene.links[2 * k + 1]!;
    expect(s).toBeLessThan(scene.count);
    expect(t).toBeLessThan(scene.count);
    expect(scene.idByIndex[s]).toBe(edge.source);
    expect(scene.idByIndex[t]).toBe(edge.target);
  }
}

// ---------------------------------------------------------------------------

describe('Reconciler: id↔index model', () => {
  it('builds an exact idByIndex/indexById bijection in accepted-base order', () => {
    const r = new Reconciler();
    const g = accept(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['d', 'a']]);
    const { scene, structuralChange } = r.reconcile(g);
    assertSceneInvariants(scene, g);
    expect(structuralChange).toBe(true); // first reconcile is always structural
    expect([...scene.idByIndex]).toEqual(['a', 'b', 'c', 'd']);
  });

  it('links never point at a dead slot after a removal reshuffles indices', () => {
    const r = new Reconciler();
    r.reconcile(accept(['a', 'b', 'c', 'd'], [['a', 'd'], ['c', 'd']]));
    const g2 = accept(['a', 'c', 'd'], [['a', 'd'], ['c', 'd']]); // 'b' removed, indices shift
    const { scene } = r.reconcile(g2);
    assertSceneInvariants(scene, g2);
  });
});

describe('Reconciler: position cache', () => {
  it('yields NaN pairs for never-seen ids', () => {
    const r = new Reconciler();
    const { scene } = r.reconcile(accept(['a', 'b']));
    expectNaNPair(scene, 'a');
    expectNaNPair(scene, 'b');
  });

  it('preserves positions across add/remove/re-add', () => {
    const r = new Reconciler();
    const s1 = r.reconcile(accept(['a', 'b', 'c'])).scene;
    r.noteEnginePositions(enginePositions(s1)); // a:(1,2) b:(11,12) c:(21,22)

    // Remove b.
    const s2 = r.reconcile(accept(['a', 'c'])).scene;
    expect(posOf(s2, 'a')).toEqual([1, 2]);
    expect(posOf(s2, 'c')).toEqual([21, 22]);

    // Re-add b (plus a brand new d).
    const res3 = r.reconcile(accept(['a', 'b', 'c', 'd']));
    expect(posOf(res3.scene, 'b')).toEqual([11, 12]); // restored from departed
    expect(posOf(res3.scene, 'a')).toEqual([1, 2]);
    expect(posOf(res3.scene, 'c')).toEqual([21, 22]);
    expectNaNPair(res3.scene, 'd');
    expect(res3.reusedPositions).toBe(3); // a, c live + b departed; d is new
  });

  it('preserves overlap positions across a full node/edge-set swap', () => {
    const r = new Reconciler();
    const s1 = r.reconcile(accept(['a', 'b', 'c', 'd'], [['a', 'b'], ['c', 'd']])).scene;
    // Per-event readback before the structural swap.
    r.noteEnginePositions(enginePositions(s1, 100)); // a:(101,102) b:(111,112) c:(121,122) d:(131,132)

    const g2 = accept(['c', 'd', 'e', 'f'], [['c', 'e'], ['e', 'f'], ['f', 'd']]);
    const res = r.reconcile(g2);
    assertSceneInvariants(res.scene, g2);
    expect(res.structuralChange).toBe(true);
    expect(posOf(res.scene, 'c')).toEqual([121, 122]);
    expect(posOf(res.scene, 'd')).toEqual([131, 132]);
    expectNaNPair(res.scene, 'e');
    expectNaNPair(res.scene, 'f');
    expect(res.reusedPositions).toBe(2);
  });

  it('finite node.x/y wins over both caches; a partial pair does not', () => {
    const r = new Reconciler();
    const s1 = r.reconcile(accept(['a', 'b'])).scene;
    r.noteEnginePositions(enginePositions(s1)); // a:(1,2) b:(11,12)

    // Fixed coords beat the live cache; fixed nodes do not count as reused.
    const res2 = r.reconcile(accept([{ id: 'a', x: -5, y: -6 }, 'b']));
    expect(posOf(res2.scene, 'a')).toEqual([-5, -6]);
    expect(posOf(res2.scene, 'b')).toEqual([11, 12]);
    expect(res2.reusedPositions).toBe(1);

    // A partial (x-only) pair falls back to the cache — which now holds the
    // fixed position for a, because the live cache tracks resolved positions.
    const res3 = r.reconcile(accept([{ id: 'a', x: 99 }, 'b']));
    expect(posOf(res3.scene, 'a')).toEqual([-5, -6]);

    // Fixed coords also beat the departed cache on re-add.
    r.reconcile(accept(['b']));
    const res4 = r.reconcile(accept([{ id: 'a', x: 7, y: 8 }, 'b']));
    expect(posOf(res4.scene, 'a')).toEqual([7, 8]);

    //...and the departed entry was consumed on that re-add: removing and
    // re-adding again restores the (newer) fixed position from the live path,
    // not the stale pre-fixed one.
    r.reconcile(accept(['b']));
    const res5 = r.reconcile(accept(['a', 'b']));
    expect(posOf(res5.scene, 'a')).toEqual([7, 8]);
  });

  it('noteEnginePositions applies to the current scene only', () => {
    const r = new Reconciler();
    r.reconcile(accept(['a', 'b', 'c']));
    const s2 = r.reconcile(accept(['a', 'c'])).scene; // b departed with no known position
    r.noteEnginePositions(enginePositions(s2, 500)); // a:(501,502) c:(511,512)

    const s3 = r.reconcile(accept(['a', 'b', 'c'])).scene;
    expect(posOf(s3, 'a')).toEqual([501, 502]);
    expect(posOf(s3, 'c')).toEqual([511, 512]);
    expectNaNPair(s3, 'b'); // left with NaN → nothing banked, still unknown
  });
});

describe('Reconciler: structuralChange', () => {
  it('is false for an attr-only change with identical structure', () => {
    const r = new Reconciler();
    const g1 = accept(
      [{ id: 'a', attrs: { v: 1 } }, { id: 'b', attrs: { v: 2 } }],
      [['a', 'b']],
    );
    expect(r.reconcile(g1).structuralChange).toBe(true);

    const g2 = accept(
      [{ id: 'a', attrs: { v: 10 } }, { id: 'b', attrs: { v: 20 } }],
      [['a', 'b']],
    );
    const res = r.reconcile(g2);
    expect(res.structuralChange).toBe(false);
    assertSceneInvariants(res.scene, g2);
  });

  it('is true on node reorder, edge add, edge id change, and endpoint change', () => {
    const r = new Reconciler();
    r.reconcile(accept(['a', 'b', 'c'], [{ id: 'e1', source: 'a', target: 'b' }]));

    // Node id sequence reordered.
    expect(
      r.reconcile(accept(['b', 'a', 'c'], [{ id: 'e1', source: 'a', target: 'b' }])).structuralChange,
    ).toBe(true);
    // Identical replay of the same structure → false again.
    expect(
      r.reconcile(accept(['b', 'a', 'c'], [{ id: 'e1', source: 'a', target: 'b' }])).structuralChange,
    ).toBe(false);
    // Edge added.
    expect(
      r.reconcile(
        accept(['b', 'a', 'c'], [
          { id: 'e1', source: 'a', target: 'b' },
          { id: 'e2', source: 'b', target: 'c' },
        ]),
      ).structuralChange,
    ).toBe(true);
    // Same endpoints, different edge id sequence.
    expect(
      r.reconcile(
        accept(['b', 'a', 'c'], [
          { id: 'e1', source: 'a', target: 'b' },
          { id: 'e9', source: 'b', target: 'c' },
        ]),
      ).structuralChange,
    ).toBe(true);
    // Same edge ids, one endpoint rewired.
    expect(
      r.reconcile(
        accept(['b', 'a', 'c'], [
          { id: 'e1', source: 'a', target: 'b' },
          { id: 'e9', source: 'b', target: 'a' },
        ]),
      ).structuralChange,
    ).toBe(true);
  });

  it('reports coordinate-only changes separately and treats stable NaNs as equal', () => {
    const r = new Reconciler();
    const first = r.reconcile(accept([{ id: 'a', x: 1, y: 2 }, 'b']));
    expect(first.structuralChange).toBe(true);
    expect(first.positionChange).toBe(true);

    const same = r.reconcile(
      accept([
        { id: 'a', x: 1, y: 2, attrs: { changed: true } },
        { id: 'b', attrs: { changed: true } },
      ]),
    );
    expect(same.structuralChange).toBe(false);
    expect(same.positionChange).toBe(false); // b's NaN pair did not dirty the positions

    const moved = r.reconcile(accept([{ id: 'a', x: 11, y: 12 }, 'b']));
    expect(moved.structuralChange).toBe(false);
    expect(moved.positionChange).toBe(true);
    expect(posOf(moved.scene, 'a')).toEqual([11, 12]);

    const replay = r.reconcile(accept([{ id: 'a', x: 11, y: 12 }, 'b']));
    expect(replay.structuralChange).toBe(false);
    expect(replay.positionChange).toBe(false);
  });

  it('unchanged declared seeds defer to drifted live positions on attrs-only updates', () => {
    // Regression: a seeded force layout must NOT snap back to its declared
    // x/y (and reheat) just because an attrs-only revision re-reconciled.
    const r = new Reconciler();
    const seeded = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 100, y: 100 },
    ];
    r.reconcile(accept(seeded));

    // Simulation drifts both nodes; the per-event readback banks it.
    r.noteEnginePositions(new Float32Array([5, 6, 105, 106]));

    // Attrs-only revision: same ids, same declared seeds, fresh objects.
    const attrsOnly = r.reconcile(
      accept(seeded.map((n) => ({ ...n, attrs: { rev: 2 } }))),
    );
    expect(attrsOnly.structuralChange).toBe(false);
    expect(attrsOnly.positionChange).toBe(false); // drift preserved, no re-upload
    expect(posOf(attrsOnly.scene, 'a')).toEqual([5, 6]);
    expect(posOf(attrsOnly.scene, 'b')).toEqual([105, 106]);

    // Changing ONE node's declaration is caller intent: that node moves,
    // the other keeps its drift.
    const oneMoved = r.reconcile(accept([{ id: 'a', x: 50, y: 50 }, seeded[1]!]));
    expect(oneMoved.positionChange).toBe(true);
    expect(posOf(oneMoved.scene, 'a')).toEqual([50, 50]);
    expect(posOf(oneMoved.scene, 'b')).toEqual([105, 106]);

    // Remove + re-add: the re-added declaration is fresh intent and wins
    // over the departed cache (pre-#8 behavior preserved).
    r.reconcile(accept([seeded[1]!]));
    const readded = r.reconcile(accept([{ id: 'a', x: 0, y: 0 }, seeded[1]!]));
    expect(posOf(readded.scene, 'a')).toEqual([0, 0]);
  });
});

describe('Reconciler: departed cache retention', () => {
  it('retains a full single-reconcile removal batch (a few hundred ids)', () => {
    const r = new Reconciler();
    const ids: string[] = [];
    for (let i = 0; i < 400; i++) ids.push(`n${i}`);

    const s1 = r.reconcile(accept(ids)).scene;
    r.noteEnginePositions(enginePositions(s1));

    // Remove everything in one reconcile...
    r.reconcile(accept([]));
    //...then re-add: every id must come back exactly where it was.
    const res = r.reconcile(accept(ids));
    expect(res.reusedPositions).toBe(400);
    for (let i = 0; i < 400; i++) {
      expect(posOf(res.scene, ids[i]!)).toEqual([i * 10 + 1, i * 10 + 2]);
    }
  });

  it('evicts oldest departed entries beyond the cap, never the current diff', () => {
    // Cap is 262_144; go slightly past it so the test stays fast.
    const CAP = 262_144;
    const EXTRA = 8;
    const total = CAP + EXTRA;
    const r = new Reconciler();
    const ids: string[] = new Array(total);
    for (let i = 0; i < total; i++) ids[i] = `n${i}`;

    const s1 = r.reconcile(accept(ids)).scene;
    r.noteEnginePositions(enginePositions(s1));

    // Single-diff removal exceeding the cap: everything must be retained.
    r.reconcile(accept([]));
    // A later reconcile with no removals performs the deferred eviction of the
    // EXTRA oldest entries (insertion order = prev scene order, so n0..n7 go).
    r.reconcile(accept(['fresh']));

    const res = r.reconcile(accept(ids));
    expect(res.reusedPositions).toBe(total - EXTRA);
    for (let i = 0; i < EXTRA; i++) expectNaNPair(res.scene, ids[i]!);
    // Spot-check survivors at the eviction boundary and the tail.
    expect(posOf(res.scene, ids[EXTRA]!)).toEqual([EXTRA * 10 + 1, EXTRA * 10 + 2]);
    const last = total - 1;
    expect(posOf(res.scene, ids[last]!)).toEqual(
      [Math.fround(last * 10 + 1), Math.fround(last * 10 + 2)],
    );
  });
});

// ---------------------------------------------------------------------------
// Randomized 300-step property test (seeded, deterministic).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Reconciler: randomized property test', () => {
  it('holds all invariants over 300 add/remove/swap/attr/note steps', () => {
    const rng = mulberry32(0xc0ffee);
    const r = new Reconciler();

    // Model state (the test's independent prediction of reconciler behavior).
    let modelNodes: Array<{ id: string; x?: number; y?: number; attrs?: Record<string, unknown> }> = [];
    let modelEdges: Array<{ id: string; source: string; target: string }> = [];
    /** Last known finite position per id, per semantics. Departed entries
     * persist here too — the run never approaches the LRU cap. */
    const known = new Map<string, [number, number]>();
    /** Declared x/y seen while the id stayed in scene (mirrors prevDeclared). */
    const declaredSeen = new Map<string, readonly [number, number]>();
    let nodeSeq = 0;
    let edgeSeq = 0;
    let prevSignature: string | null = null;

    const randInt = (n: number): number => Math.floor(rng() * n);
    const randCoord = (): number => randInt(2000) - 1000; // exact in float32

    const addNodes = (k: number, withFixed: boolean): void => {
      for (let i = 0; i < k; i++) {
        const id = `n${nodeSeq++}`;
        if (withFixed && rng() < 0.5) {
          modelNodes.push({ id, x: randCoord(), y: randCoord() });
        } else {
          modelNodes.push({ id });
        }
      }
    };
    const addEdges = (k: number): void => {
      if (modelNodes.length === 0) return;
      for (let i = 0; i < k; i++) {
        const source = modelNodes[randInt(modelNodes.length)]!.id;
        const target = modelNodes[randInt(modelNodes.length)]!.id;
        modelEdges.push({ id: `e${edgeSeq++}`, source, target });
      }
    };
    const removeNodes = (k: number): void => {
      for (let i = 0; i < k && modelNodes.length > 0; i++) {
        const at = randInt(modelNodes.length);
        const [gone] = modelNodes.splice(at, 1);
        modelEdges = modelEdges.filter((e) => e.source !== gone!.id && e.target !== gone!.id);
      }
    };

    let lastScene: RenderScene | null = null;

    for (let step = 0; step < 300; step++) {
      const op = randInt(10);

      if (op === 0 && lastScene !== null) {
        // Note engine positions for the current scene (no reconcile this step).
        const noted = new Float32Array(2 * lastScene.count);
        for (let i = 0; i < lastScene.count; i++) {
          noted[2 * i] = randCoord();
          noted[2 * i + 1] = randCoord();
        }
        r.noteEnginePositions(noted);
        for (let i = 0; i < lastScene.count; i++) {
          known.set(lastScene.idByIndex[i]!, [noted[2 * i]!, noted[2 * i + 1]!]);
        }
        continue;
      }

      if (op <= 2) {
        addNodes(1 + randInt(5), true);
        addEdges(randInt(4));
      } else if (op <= 4) {
        removeNodes(1 + randInt(3));
      } else if (op === 5) {
        // Full swap with partial overlap: keep ~half the ids, all-new edges.
        modelNodes = modelNodes.filter(() => rng() < 0.5);
        modelEdges = [];
        addNodes(2 + randInt(6), false);
        addEdges(randInt(6));
      } else if (op === 6) {
        // Attr-only change: identical id/edge structure, fresh objects.
        modelNodes = modelNodes.map((n) => ({ ...n, attrs: { step } }));
        modelEdges = modelEdges.map((e) => ({ ...e }));
      } else if (op === 7) {
        addEdges(1 + randInt(3));
      } else if (op === 8 && modelEdges.length > 0) {
        modelEdges.splice(randInt(modelEdges.length), 1);
      } else {
        addNodes(1 + randInt(3), false);
      }

      const g = accept(modelNodes, modelEdges);
      const signature =
        g.nodes.map((n) => n.id).join(' ') +
        '|' +
        g.edges.map((e) => `${e.id};${e.source};${e.target}`).join(' ');
      const expectStructural = prevSignature === null || signature !== prevSignature;

      const res = r.reconcile(g);
      assertSceneInvariants(res.scene, g);
      expect(res.structuralChange, `step ${step} structuralChange`).toBe(expectStructural);

      // Position invariant: a declaration wins only
      // when the node has no cached placement OR the declaration changed
      // since the previous in-scene reconcile; an unchanged declaration
      // defers to the cached (drifted) position.
      let expectedReused = 0;
      const nextDeclaredSeen = new Map<string, readonly [number, number]>();
      for (const node of g.nodes) {
        const [x, y] = posOf(res.scene, node.id);
        const cached = known.get(node.id);
        const hasDeclared = node.x !== undefined && node.y !== undefined;
        if (hasDeclared) {
          const prev = declaredSeen.get(node.id);
          const changed = prev === undefined || prev[0] !== node.x || prev[1] !== node.y;
          nextDeclaredSeen.set(node.id, [node.x!, node.y!]);
          if (cached === undefined || changed) {
            expect([x, y], `step ${step} declared ${node.id}`).toEqual([node.x, node.y]);
          } else {
            expect([x, y], `step ${step} cached-over-declared ${node.id}`).toEqual(cached);
            expectedReused++;
          }
        } else if (cached !== undefined) {
          expect([x, y], `step ${step} cached ${node.id}`).toEqual(cached);
          expectedReused++;
        } else {
          expect(Number.isNaN(x) && Number.isNaN(y), `step ${step} NaN ${node.id}`).toBe(true);
        }
      }
      expect(res.reusedPositions, `step ${step} reusedPositions`).toBe(expectedReused);
      declaredSeen.clear();
      for (const [id, xy] of nextDeclaredSeen) declaredSeen.set(id, xy);

      // Model bookkeeping: the live cache now holds each RESOLVED position.
      for (const node of g.nodes) {
        const [x, y] = posOf(res.scene, node.id);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          known.set(node.id, [x, y]);
        }
      }

      prevSignature = signature;
      lastScene = res.scene;
    }
  });
});
