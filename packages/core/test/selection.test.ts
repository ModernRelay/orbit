/**
 * selection model — pure set-algebra helpers plus the instance-level
 * mutators. Property-style tests run over seeded-random accepted
 * bases so ordering/stability invariants are exercised broadly but
 * deterministically.
 */

import { describe, expect, it } from 'vitest';

import {
  dedupeFirstOccurrence,
  differenceIds,
  intersectionIds,
  orderByAcceptedBase,
  toggleId,
  unionIds,
} from '../src/selection';
import { FakeEngine } from '../src/testing/index';
import { container, makeInstance, snap } from './helpers';

/** Deterministic PRNG (mulberry32) for property-style cases. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Synthesized edge id: `${source}→${target}#${k}`. */
const eid = (s: string, t: string, k = 0): string => `${s}→${t}#${k}`;

describe('selection set algebra (pure helpers)', () => {
  it('dedupeFirstOccurrence keeps the first occurrence in encounter order', () => {
    expect(dedupeFirstOccurrence(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
    expect(dedupeFirstOccurrence([])).toEqual([]);
  });

  it('orderByAcceptedBase drops unknown ids, dedupes, and orders by base index', () => {
    const base = new Map([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    expect(orderByAcceptedBase(['c', 'zz', 'a', 'c', 'a'], base)).toEqual(['a', 'c']);
    expect(orderByAcceptedBase(['zz', 'yy'], base)).toEqual([]);
    expect(orderByAcceptedBase([], base)).toEqual([]);
  });

  it('unionIds keeps first-occurrence order (a first, then new ids of b)', () => {
    expect(unionIds(['b', 'a'], ['c', 'a', 'd'])).toEqual(['b', 'a', 'c', 'd']);
  });

  it('differenceIds and intersectionIds keep the deduped order of a', () => {
    expect(differenceIds(['c', 'a', 'b', 'a'], ['a'])).toEqual(['c', 'b']);
    expect(intersectionIds(['c', 'a', 'b'], ['b', 'c'])).toEqual(['c', 'b']);
  });

  it('toggleId removes a present id and appends an absent one', () => {
    expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
    expect(toggleId(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(toggleId([], 'x')).toEqual(['x']);
  });

  it('property: orderByAcceptedBase is idempotent and stable over random bases', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = rng(seed);
      const n = 3 + Math.floor(rand() * 40);
      const ids = Array.from({ length: n }, (_, i) => `n${i}`);
      const base = new Map(ids.map((id, i) => [id, i] as const));
      const query = shuffled([...ids, ...ids, 'unknown-1', 'unknown-2'], rand).slice(
        0,
        Math.max(1, Math.floor(rand() * n * 2)),
      );

      const once = orderByAcceptedBase(query, base);
      const twice = orderByAcceptedBase(once, base);
      expect(twice).toEqual(once);
      // Sorted by accepted index, no duplicates, no unknowns.
      const indices = once.map((id) => base.get(id)!);
      expect([...indices].sort((a, b) => a - b)).toEqual(indices);
      expect(new Set(once).size).toBe(once.length);
    }
  });
});

describe('instance node-set mutators', () => {
  it('selectNodes validates against the accepted model: unknown dropped, deduped, base-ordered', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c']) });

    instance.selectNodes(['c', 'zz', 'a', 'c', 'a']);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'c']);
  });

  it('selectEdges validates against accepted edges and never touches nodeIds', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c'], [
        ['a', 'b'],
        ['b', 'c'],
      ]),
    });

    instance.selectNodes(['a']);
    instance.selectEdges([eid('b', 'c'), 'nope', eid('b', 'c'), eid('a', 'b')]);

    const sel = instance.store.getState().selection;
    expect(sel.edgeIds).toEqual([eid('a', 'b'), eid('b', 'c')]); // accepted edge order
    expect(sel.nodeIds).toEqual(['a']);
  });

  it('node-set algebra never mutates edgeIds (same reference across node ops)', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b']]) });

    instance.selectEdges([eid('a', 'b')]);
    const edgeIds = instance.store.getState().selection.edgeIds;

    instance.selectNodes(['b']);
    instance.selectAll();
    instance.invertSelection();
    instance.selectNeighbors('a');
    expect(instance.store.getState().selection.edgeIds).toBe(edgeIds);
  });

  it('setSelection accepts an id array (node namespace) or a full SelectionState', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    instance.selectEdges([eid('a', 'b')]);
    instance.setSelection(['b']); // array form: node namespace only
    expect(instance.store.getState().selection).toMatchObject({
      nodeIds: ['b'],
      edgeIds: [eid('a', 'b')],
    });

    instance.setSelection({ nodeIds: ['a', 'zz'], edgeIds: [], groupIds: ['g', 'g'] });
    expect(instance.store.getState().selection).toEqual({
      nodeIds: ['a'],
      edgeIds: [],
      groupIds: ['g'],
    });
  });

  it('clearSelection clears every namespace', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    instance.setSelection({ nodeIds: ['a'], edgeIds: [eid('a', 'b')], groupIds: [] });
    instance.clearSelection();
    expect(instance.store.getState().selection).toEqual({
      nodeIds: [],
      edgeIds: [],
      groupIds: [],
    });
  });

  it('property: selectNodes stores random subsets in accepted-base order, invert∘invert is identity, selectAll is stable', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rand = rng(seed * 31);
      const n = 3 + Math.floor(rand() * 40);
      const ids = shuffled(
        Array.from({ length: n }, (_, i) => `node-${i}`),
        rand,
      );
      const { instance } = makeInstance();
      instance.applyHostUpdate({ data: snap(1, ids) }); // accepted base = ids order

      const subset = shuffled(ids, rand).slice(0, Math.floor(rand() * n) + 1);
      instance.selectNodes([...subset, ...subset]); // duplicates collapse

      const stored = instance.store.getState().selection.nodeIds;
      const expected = ids.filter((id) => subset.includes(id));
      expect(stored).toEqual(expected);

      // invert twice returns to the same base-ordered selection.
      instance.invertSelection();
      const inverted = instance.store.getState().selection.nodeIds;
      expect(inverted).toEqual(ids.filter((id) => !subset.includes(id)));
      instance.invertSelection();
      expect(instance.store.getState().selection.nodeIds).toEqual(expected);

      // selectAll yields the full base order; a repeat publishes nothing.
      instance.selectAll();
      expect(instance.store.getState().selection.nodeIds).toEqual(ids);
      const stateBefore = instance.store.getState();
      instance.selectAll();
      expect(instance.store.getState()).toBe(stateBefore); // no-op: no publish
      instance.destroy();
    }
  });
});

describe('selectNeighbors', () => {
  // a—b, b—c, c—d chain plus an isolated e.
  const chain = (): ReturnType<typeof snap> =>
    snap(1, ['a', 'b', 'c', 'd', 'e'], [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ]);

  it('selects exactly the 1-hop neighborhood via engine adjacency (never 2-hop)', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: chain() });
    const engine = engines[0]!;

    instance.selectNeighbors('b');
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b', 'c']);
    // The engine adjacency path was used (FakeEngine provides neighborIndices).
    expect(engine.calls.some((c) => c.method === 'neighborIndices')).toBe(true);

    instance.selectNeighbors('a');
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b']); // d is 2-hop from b, 3 from a

    instance.selectNeighbors('e');
    expect(instance.store.getState().selection.nodeIds).toEqual(['e']); // isolated: seed only
  });

  it('seeds from the current selection when no id is given', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: chain() });

    instance.selectNodes(['b', 'c']);
    instance.selectNeighbors();
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b', 'c', 'd']);
  });

  it('falls back to a links scan over the current scene when detached', () => {
    const { instance } = makeInstance();
    instance.applyHostUpdate({ data: chain() }); // never attached: no engine

    instance.selectNeighbors('c');
    expect(instance.store.getState().selection.nodeIds).toEqual(['b', 'c', 'd']);
  });

  it('ignores unknown seed ids', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: chain() });

    instance.selectNeighbors('zz');
    expect(instance.store.getState().selection.nodeIds).toEqual([]);
  });
});

describe('hidden nodes and the selectAll/invert population', () => {
  it('excludes hiddenNodeIds from selectAll and invertSelection populations', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c', 'd']) });

    instance.hideNodes(['b', 'zz', 'b']);
    expect(instance.store.getState().hiddenNodeIds).toEqual(new Set(['b']));

    instance.selectAll();
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'c', 'd']);

    instance.selectNodes(['a']);
    instance.invertSelection();
    expect(instance.store.getState().selection.nodeIds).toEqual(['c', 'd']);
  });

  it('showNodes/showAll restore the population', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c']) });

    instance.hideNodes(['a', 'b']);
    instance.showNodes(['a']);
    instance.selectAll();
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'c']);

    instance.showAll();
    expect(instance.store.getState().hiddenNodeIds.size).toBe(0);
    instance.selectAll();
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b', 'c']);
  });

  it('hide/show mutators are no-ops (no publish) when nothing changes', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    instance.hideNodes(['a']);

    let notifications = 0;
    instance.store.subscribe(() => notifications++);
    instance.hideNodes(['a']); // already hidden
    instance.hideNodes(['zz']); // unknown
    instance.showNodes(['b']); // not hidden
    instance.showAll();
    expect(instance.store.getState().hiddenNodeIds.size).toBe(0);
    instance.showAll(); // already empty
    expect(notifications).toBe(1); // only the first showAll published
  });
});

describe('FakeEngine spatial queries', () => {
  it('pointsInPolygon ray-casts over applied positions, treating screen as space', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    // FakeEngine seeds a,b,c at (0,0) (10,0) (20,0).
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c']) });
    const engine = engines[0]!;

    expect(
      engine.pointsInPolygon([
        [-5, -5],
        [15, -5],
        [15, 5],
        [-5, 5],
      ]),
    ).toEqual([0, 1]);
    expect(engine.pointsInPolygon([[0, 0], [1, 1]])).toEqual([]); // degenerate polygon
  });

  it('screenToSpace/spaceToScreen are identity transforms', () => {
    const engine = new FakeEngine();
    expect(engine.screenToSpace([3, -4])).toEqual([3, -4]);
    expect(engine.spaceToScreen([-1.5, 8])).toEqual([-1.5, 8]);
  });

  it('neighborIndices reflects the last committed links and excludes self-loops', () => {
    const engine = new FakeEngine();
    engine.commit({
      revision: 1,
      structure: {
        pointCount: 3,
        positions: Float32Array.from([0, 0, 10, 0, 20, 0]),
        links: Uint32Array.from([0, 1, 1, 2, 2, 2]), // 2→2 self-loop
      },
    });
    expect(engine.neighborIndices(1).sort()).toEqual([0, 2]);
    expect(engine.neighborIndices(2)).toEqual([1]); // self-loop excluded
    expect(new FakeEngine().neighborIndices(0)).toEqual([]); // no links yet
  });
});
