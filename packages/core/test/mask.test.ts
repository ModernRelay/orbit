import { describe, expect, it } from 'vitest';
import { DIM_ALPHA_DEFAULT, SoftMask } from '../src/mask';
import type { MaskDrain, MaskSource } from '../src/mask';

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

function symmetricDiff(a: ReadonlySet<number>, b: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  for (const v of a) if (!b.has(v)) out.add(v);
  for (const v of b) if (!a.has(v)) out.add(v);
  return out;
}

function allZero(counters: Uint16Array): boolean {
  for (let i = 0; i < counters.length; i++) if (counters[i] !== 0) return false;
  return true;
}

/** Flat [src, tgt] pair buffer for a path graph 0-1-2-…: edge i = (i, i+1). */
function pathLinks(edgeCount: number): Uint32Array {
  const links = new Uint32Array(edgeCount * 2);
  for (let i = 0; i < edgeCount; i++) {
    links[i * 2] = i;
    links[i * 2 + 1] = i + 1;
  }
  return links;
}

describe('SoftMask basics', () => {
  it('starts fully visible', () => {
    const mask = new SoftMask(4, 3);
    expect(mask.visibleNodeCount()).toBe(4);
    expect(mask.visibleEdgeCount()).toBe(3);
    for (let i = 0; i < 4; i++) {
      expect(mask.isNodeVisible(i)).toBe(true);
      expect(mask.nodeAlpha(i)).toBe(1);
    }
    const drain = mask.drainDirty();
    expect(drain.nodes).toEqual([]);
    expect(drain.edges).toEqual([]);
    expect(drain.nodesAlpha).toEqual([]);
    expect(drain.edgesAlpha).toEqual([]);
    expect(drain.nodeVisibleCount).toBe(4);
    expect(drain.edgeVisibleCount).toBe(3);
  });

  it('hides via one source and drains exactly the flipped slots', () => {
    const mask = new SoftMask(5, 0);
    const s = mask.acquire('filter');
    s.setNodeFailures([1, 3]);
    expect(mask.visibleNodeCount()).toBe(3);
    expect(mask.isNodeVisible(1)).toBe(false);
    expect(mask.nodeAlpha(1)).toBe(0);

    let drain = mask.drainDirty();
    expect(new Set(drain.nodes)).toEqual(new Set([1, 3]));
    expect(drain.nodeVisibleCount).toBe(3);

    // Membership replace: 1 restored, 4 newly hidden, 3 unchanged.
    s.setNodeFailures([3, 4]);
    drain = mask.drainDirty();
    expect(new Set(drain.nodes)).toEqual(new Set([1, 4]));
    expect(drain.nodeVisibleCount).toBe(3);

    // No changes → empty drain.
    drain = mask.drainDirty();
    expect(drain.nodes).toEqual([]);
  });

  it('suppresses net no-op flips within one drain period', () => {
    const mask = new SoftMask(3, 0);
    const s = mask.acquire('scrub');
    s.setNodeFailures([1]);
    s.setNodeFailures([]); // restored before the drain
    const drain = mask.drainDirty();
    expect(drain.nodes).toEqual([]);
    expect(drain.nodeVisibleCount).toBe(3);
  });

  it('counts duplicate slots in one membership once', () => {
    const mask = new SoftMask(3, 0);
    const s = mask.acquire('dupes');
    s.setNodeFailures([2, 2, 2]);
    expect(mask.nodeHideFailures[2]).toBe(1);
    s.release(); // balanced-assert (DEBUG) would throw on drift
    expect(mask.nodeHideFailures[2]).toBe(0);
  });

  it('composes overlapping sources; visibility returns only at zero', () => {
    const mask = new SoftMask(4, 0);
    const a = mask.acquire('a');
    const b = mask.acquire('b');
    a.setNodeFailures([1]);
    b.setNodeFailures([1, 2]);
    expect(mask.nodeHideFailures[1]).toBe(2);
    expect(mask.visibleNodeCount()).toBe(2);
    mask.drainDirty();

    a.release();
    expect(mask.isNodeVisible(1)).toBe(false); // b still holds it
    let drain = mask.drainDirty();
    expect(drain.nodes).toEqual([]);

    b.release();
    drain = mask.drainDirty();
    expect(new Set(drain.nodes)).toEqual(new Set([1, 2]));
    expect(drain.nodeVisibleCount).toBe(4);
    expect(allZero(mask.nodeHideFailures)).toBe(true);
  });

  it('throws on out-of-range slots without partially applying', () => {
    const mask = new SoftMask(3, 2);
    const s = mask.acquire('bad');
    expect(() => s.setNodeFailures([0, 7])).toThrow(RangeError);
    expect(() => s.setNodeFailures([-1])).toThrow(RangeError);
    expect(() => s.setNodeFailures([0.5])).toThrow(RangeError);
    expect(() => s.setEdgeFailures([2])).toThrow(RangeError);
    // Validation happens before any counter is touched.
    expect(mask.visibleNodeCount()).toBe(3);
    expect(allZero(mask.nodeHideFailures)).toBe(true);
    expect(mask.drainDirty().nodes).toEqual([]);
  });

  it('throws on use after release; release is idempotent', () => {
    const mask = new SoftMask(2, 0);
    const s = mask.acquire('gone');
    s.setNodeFailures([0]);
    s.release();
    expect(() => s.setNodeFailures([1])).toThrow(/after release/);
    expect(() => s.clear()).toThrow(/after release/);
    expect(() => s.release()).not.toThrow();
    expect(mask.visibleNodeCount()).toBe(2);
  });
});

describe('dim lane', () => {
  it('dim is independent of hide and never affects visible counts', () => {
    const mask = new SoftMask(4, 0);
    const hider = mask.acquire('hider');
    const dimmer = mask.acquire('dimmer');

    dimmer.setNodeFailures(null, [2]);
    expect(mask.isNodeVisible(2)).toBe(true);
    expect(mask.isNodeDimmed(2)).toBe(true);
    expect(mask.nodeAlpha(2)).toBe(DIM_ALPHA_DEFAULT);
    expect(mask.nodeAlpha(2, 0.4)).toBe(0.4);
    expect(mask.visibleNodeCount()).toBe(4); // dim never hides

    let drain = mask.drainDirty();
    expect(drain.nodes).toEqual([]); // no hide flips
    expect(new Set(drain.nodesAlpha)).toEqual(new Set([2]));

    // Hide the same node: hidden wins over dimmed for alpha.
    hider.setNodeFailures([2]);
    expect(mask.isNodeDimmed(2)).toBe(false); // dimmed requires visible
    expect(mask.nodeAlpha(2)).toBe(0);
    drain = mask.drainDirty();
    expect(new Set(drain.nodes)).toEqual(new Set([2]));
    expect(drain.nodesAlpha).toEqual([]); // dim lane itself did not flip

    // Un-hide: still dimmed.
    hider.setNodeFailures(null);
    expect(mask.nodeAlpha(2)).toBe(DIM_ALPHA_DEFAULT);
    expect(mask.isNodeDimmed(2)).toBe(true);
  });

  it('omitted dim argument leaves the dim lane untouched; null clears it', () => {
    const mask = new SoftMask(3, 0);
    const s = mask.acquire('s');
    s.setNodeFailures([0], [1]);
    s.setNodeFailures([2]); // dim untouched
    expect(mask.isNodeDimmed(1)).toBe(true);
    expect(mask.isNodeVisible(0)).toBe(true);
    expect(mask.isNodeVisible(2)).toBe(false);
    s.setNodeFailures([2], null); // dim cleared
    expect(mask.isNodeDimmed(1)).toBe(false);
  });

  it('edge lanes mirror node semantics', () => {
    const mask = new SoftMask(0, 4);
    const s = mask.acquire('edges');
    s.setEdgeFailures([0], [1]);
    expect(mask.isEdgeVisible(0)).toBe(false);
    expect(mask.edgeAlpha(0)).toBe(0);
    expect(mask.isEdgeDimmed(1)).toBe(true);
    expect(mask.edgeAlpha(1, 0.3)).toBe(0.3);
    expect(mask.visibleEdgeCount()).toBe(3);
    const drain = mask.drainDirty();
    expect(new Set(drain.edges)).toEqual(new Set([0]));
    expect(new Set(drain.edgesAlpha)).toEqual(new Set([1]));
    expect(drain.edgeVisibleCount).toBe(3);
  });
});

describe('node→edge cascade', () => {
  it('hiding a node hide-fails exactly its incident edges; un-hiding restores', () => {
    // Path 0-1-2-3: edges e0=(0,1), e1=(1,2), e2=(2,3).
    const mask = new SoftMask(4, 3);
    const links = pathLinks(3);
    const s = mask.acquire('filter');

    s.setNodeFailures([1]);
    mask.applyNodeCascadeToEdges(links);
    expect(mask.isEdgeVisible(0)).toBe(false);
    expect(mask.isEdgeVisible(1)).toBe(false);
    expect(mask.isEdgeVisible(2)).toBe(true);
    let drain = mask.drainDirty();
    expect(new Set(drain.nodes)).toEqual(new Set([1]));
    expect(new Set(drain.edges)).toEqual(new Set([0, 1]));
    expect(drain.edgeVisibleCount).toBe(1);

    s.setNodeFailures([]);
    mask.applyNodeCascadeToEdges(links);
    drain = mask.drainDirty();
    expect(new Set(drain.nodes)).toEqual(new Set([1]));
    expect(new Set(drain.edges)).toEqual(new Set([0, 1]));
    expect(drain.edgeVisibleCount).toBe(3);
    expect(allZero(mask.edgeHideFailures)).toBe(true);
  });

  it('handles shared-endpoint overlaps between two sources', () => {
    // e1=(1,2) is doomed while EITHER endpoint is hidden by ANY source.
    const mask = new SoftMask(4, 3);
    const links = pathLinks(3);
    const a = mask.acquire('a');
    const b = mask.acquire('b');

    a.setNodeFailures([1]);
    b.setNodeFailures([2]);
    mask.applyNodeCascadeToEdges(links);
    expect([0, 1, 2].map((i) => mask.isEdgeVisible(i))).toEqual([false, false, false]);
    // The cascade is ONE source: shared edge e1 carries a single failure.
    expect(mask.edgeHideFailures[1]).toBe(1);
    mask.drainDirty();

    a.release(); // node 1 restored; node 2 still hidden
    mask.applyNodeCascadeToEdges(links);
    expect(mask.isEdgeVisible(0)).toBe(true); // (0,1) both visible again
    expect(mask.isEdgeVisible(1)).toBe(false); // (1,2) still doomed via node 2
    expect(mask.isEdgeVisible(2)).toBe(false); // (2,3) doomed via node 2
    const drain = mask.drainDirty();
    expect(new Set(drain.nodes)).toEqual(new Set([1]));
    expect(new Set(drain.edges)).toEqual(new Set([0]));

    b.release();
    mask.applyNodeCascadeToEdges(links);
    expect(mask.visibleEdgeCount()).toBe(3);
    expect(allZero(mask.edgeHideFailures)).toBe(true);
    expect(allZero(mask.nodeHideFailures)).toBe(true);
  });

  it('cascade composes with direct edge failures via counters', () => {
    const mask = new SoftMask(3, 2);
    const links = pathLinks(2);
    const nodeSrc = mask.acquire('nodes');
    const edgeSrc = mask.acquire('edges');

    edgeSrc.setEdgeFailures([0]);
    nodeSrc.setNodeFailures([1]);
    mask.applyNodeCascadeToEdges(links);
    expect(mask.edgeHideFailures[0]).toBe(2); // direct + cascade

    nodeSrc.setNodeFailures([]);
    mask.applyNodeCascadeToEdges(links);
    expect(mask.isEdgeVisible(0)).toBe(false); // direct failure remains
    expect(mask.isEdgeVisible(1)).toBe(true);

    edgeSrc.clear();
    expect(mask.visibleEdgeCount()).toBe(2);
  });

  it('validates the links buffer', () => {
    const mask = new SoftMask(2, 1);
    expect(() => mask.applyNodeCascadeToEdges(new Uint32Array([0]))).toThrow(RangeError);
    expect(() => mask.applyNodeCascadeToEdges(new Uint32Array([0, 1, 1, 0]))).toThrow(RangeError); // 2 edges > capacity 1
    expect(() => mask.applyNodeCascadeToEdges(new Uint32Array([0, 5]))).toThrow(RangeError); // endpoint out of range
  });
});

describe('overflow guard', () => {
  it('clamps at 0xFFFF and latches the one-time overflowed flag', () => {
    const mask = new SoftMask(1, 0);
    const sources: MaskSource[] = [];
    for (let i = 0; i < 0xffff; i++) {
      const s = mask.acquire(`s${i}`);
      s.setNodeFailures([0]);
      sources.push(s);
    }
    expect(mask.nodeHideFailures[0]).toBe(0xffff);
    expect(mask.overflowed).toBe(false);

    const straw = mask.acquire('straw');
    straw.setNodeFailures([0]); // 65536th increment — dropped, flag latched
    expect(mask.overflowed).toBe(true);
    expect(mask.nodeHideFailures[0]).toBe(0xffff);
    expect(mask.isNodeVisible(0)).toBe(false);
    expect(mask.visibleNodeCount()).toBe(0);

    // Releasing everything clamps at zero without throwing (assert is
    // skipped once overflowed — the books legitimately drifted).
    straw.release();
    for (const s of sources) s.release();
    expect(mask.nodeHideFailures[0]).toBe(0);
    expect(mask.isNodeVisible(0)).toBe(true);
    expect(mask.overflowed).toBe(true); // flag is one-time, never resets
  });
});

describe('grow', () => {
  it('preserves state for existing slots and starts new slots visible', () => {
    const mask = new SoftMask(3, 2);
    const s = mask.acquire('s');
    s.setNodeFailures([1], [2]);
    s.setEdgeFailures([0]);
    mask.drainDirty();

    mask.grow(6, 5);
    expect(mask.nodeCapacity).toBe(6);
    expect(mask.edgeCapacity).toBe(5);
    expect(mask.isNodeVisible(1)).toBe(false);
    expect(mask.isNodeDimmed(2)).toBe(true);
    expect(mask.isEdgeVisible(0)).toBe(false);
    for (const i of [3, 4, 5]) expect(mask.isNodeVisible(i)).toBe(true);
    expect(mask.visibleNodeCount()).toBe(5); // 6 - node 1
    expect(mask.visibleEdgeCount()).toBe(4); // 5 - edge 0
    expect(mask.drainDirty().nodes).toEqual([]); // growth is not a flip

    // Existing sources can address the new slots (per-source columns grew).
    s.setNodeFailures([1, 4]);
    expect(mask.isNodeVisible(4)).toBe(false);

    // Shrink attempts are no-ops per dimension.
    mask.grow(2, 1);
    expect(mask.nodeCapacity).toBe(6);
    expect(mask.edgeCapacity).toBe(5);

    s.release();
    expect(mask.visibleNodeCount()).toBe(6);
    expect(mask.visibleEdgeCount()).toBe(5);
  });
});

describe('composition of three sources', () => {
  it('keeps visible counts correct under hide/dim overlap', () => {
    const mask = new SoftMask(6, 4);
    const a = mask.acquire('a');
    const b = mask.acquire('b');
    const c = mask.acquire('c');
    a.setNodeFailures([0, 1], [2]);
    b.setNodeFailures([1, 2], [2, 3]);
    c.setNodeFailures([5], null);
    c.setEdgeFailures([0, 3]);

    // Hidden: {0,1,2,5}; dim counters on {2,3} (2 is hidden → not "dimmed").
    expect(mask.visibleNodeCount()).toBe(2);
    expect(mask.visibleEdgeCount()).toBe(2);
    expect(mask.isNodeDimmed(3)).toBe(true);
    expect(mask.isNodeDimmed(2)).toBe(false);
    const drain = mask.drainDirty();
    expect(new Set(drain.nodes)).toEqual(new Set([0, 1, 2, 5]));
    expect(new Set(drain.nodesAlpha)).toEqual(new Set([2, 3]));
    expect(new Set(drain.edges)).toEqual(new Set([0, 3]));
    expect(drain.nodeVisibleCount).toBe(2);
    expect(drain.edgeVisibleCount).toBe(2);

    b.release();
    // Hidden: {0,1,5}. Dim lane: node 3 crossed 1→0 (flip); node 2 dropped
    // 2→1 (a still dims it — no flip), and being visible now it reads dimmed.
    expect(mask.visibleNodeCount()).toBe(3);
    expect(mask.isNodeDimmed(2)).toBe(true);
    expect(mask.isNodeDimmed(3)).toBe(false);
    const drain2 = mask.drainDirty();
    expect(new Set(drain2.nodes)).toEqual(new Set([2]));
    expect(new Set(drain2.nodesAlpha)).toEqual(new Set([3]));

    a.release();
    c.release();
    expect(mask.visibleNodeCount()).toBe(6);
    expect(mask.visibleEdgeCount()).toBe(4);
  });
});

describe('property: random sources vs oracle', () => {
  const NODE_N = 32;
  const EDGE_N = 24;
  const SOURCES = 5;
  const ROUNDS = 90;

  interface OracleSource {
    nh: Set<number>;
    nd: Set<number>;
    eh: Set<number>;
    ed: Set<number>;
  }

  function unionOf(oracle: readonly OracleSource[], lane: keyof OracleSource): Set<number> {
    const out = new Set<number>();
    for (const src of oracle) for (const slot of src[lane]) out.add(slot);
    return out;
  }

  it('dirty lists exactly match membership flips and release balances to zero', () => {
    const rand = mulberry32(0x5eed901);
    const mask = new SoftMask(NODE_N, EDGE_N);
    const sources: MaskSource[] = [];
    const oracle: OracleSource[] = [];
    for (let i = 0; i < SOURCES; i++) {
      sources.push(mask.acquire(`s${i}`));
      oracle.push({ nh: new Set(), nd: new Set(), eh: new Set(), ed: new Set() });
    }

    const randomSubset = (n: number, p: number): number[] => {
      const out: number[] = [];
      for (let slot = 0; slot < n; slot++) if (rand() < p) out.push(slot);
      return out;
    };

    // State at the previous drain.
    let prevNodeHidden = new Set<number>();
    let prevNodeDim = new Set<number>();
    let prevEdgeHidden = new Set<number>();
    let prevEdgeDim = new Set<number>();

    const checkDrain = (drain: MaskDrain): void => {
      const curNodeHidden = unionOf(oracle, 'nh');
      const curNodeDim = unionOf(oracle, 'nd');
      const curEdgeHidden = unionOf(oracle, 'eh');
      const curEdgeDim = unionOf(oracle, 'ed');
      expect(new Set(drain.nodes)).toEqual(symmetricDiff(prevNodeHidden, curNodeHidden));
      expect(new Set(drain.nodesAlpha)).toEqual(symmetricDiff(prevNodeDim, curNodeDim));
      expect(new Set(drain.edges)).toEqual(symmetricDiff(prevEdgeHidden, curEdgeHidden));
      expect(new Set(drain.edgesAlpha)).toEqual(symmetricDiff(prevEdgeDim, curEdgeDim));
      expect(drain.nodeVisibleCount).toBe(NODE_N - curNodeHidden.size);
      expect(drain.edgeVisibleCount).toBe(EDGE_N - curEdgeHidden.size);
      // Full per-slot visibility oracle.
      for (let slot = 0; slot < NODE_N; slot++) {
        expect(mask.isNodeVisible(slot)).toBe(!curNodeHidden.has(slot));
        expect(mask.isNodeDimmed(slot)).toBe(!curNodeHidden.has(slot) && curNodeDim.has(slot));
      }
      for (let slot = 0; slot < EDGE_N; slot++) {
        expect(mask.isEdgeVisible(slot)).toBe(!curEdgeHidden.has(slot));
      }
      prevNodeHidden = curNodeHidden;
      prevNodeDim = curNodeDim;
      prevEdgeHidden = curEdgeHidden;
      prevEdgeDim = curEdgeDim;
    };

    for (let round = 0; round < ROUNDS; round++) {
      const si = Math.floor(rand() * SOURCES);
      const src = sources[si]!;
      const o = oracle[si]!;
      if (rand() < 0.1) {
        src.clear();
        o.nh = new Set();
        o.nd = new Set();
        o.eh = new Set();
        o.ed = new Set();
      } else {
        const nh = randomSubset(NODE_N, 0.25);
        const nd = randomSubset(NODE_N, 0.25);
        const eh = randomSubset(EDGE_N, 0.25);
        const ed = randomSubset(EDGE_N, 0.25);
        src.setNodeFailures(nh, nd);
        src.setEdgeFailures(eh, ed);
        o.nh = new Set(nh);
        o.nd = new Set(nd);
        o.eh = new Set(eh);
        o.ed = new Set(ed);
      }
      if (round % 3 === 2) checkDrain(mask.drainDirty());
    }

    // Release everything: counters must return exactly to zero (the DEBUG
    // balanced-assert inside release would throw on any drift).
    for (let i = 0; i < SOURCES; i++) {
      sources[i]!.release();
      const o = oracle[i]!;
      o.nh = new Set();
      o.nd = new Set();
      o.eh = new Set();
      o.ed = new Set();
    }
    checkDrain(mask.drainDirty());
    expect(mask.visibleNodeCount()).toBe(NODE_N);
    expect(mask.visibleEdgeCount()).toBe(EDGE_N);
    expect(allZero(mask.nodeHideFailures)).toBe(true);
    expect(allZero(mask.nodeDimFailures)).toBe(true);
    expect(allZero(mask.edgeHideFailures)).toBe(true);
    expect(allZero(mask.edgeDimFailures)).toBe(true);
    expect(mask.overflowed).toBe(false);
  });
});
