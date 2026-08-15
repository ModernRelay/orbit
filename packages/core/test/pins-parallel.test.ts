/**
 * persistent pins + parallel-edge grouping.
 *
 * Covers (persistent pins are INDEPENDENT of transient drag
 * pinning: the engine receives the UNION, so releasing a drag on a
 * persistently-pinned node leaves it pinned; departed ids prune through the
 * ownership path) and (the parallel-edge toggle collapses
 * same-directed-pair physical edges into ONE count-weighted meta-edge using
 * the group tuple codec, restores originals as a structural diff, and is a
 * documented no-op — with a diagnostic — on datasets that carry no
 * parallels at all).
 */

import { describe, expect, it } from 'vitest';

import type { GraphInstance } from '../src/instance';
import { metaEdgePublicId } from '../src/groups';
import type { FakeEngine } from '../src/testing/index';
import type { GraphSnapshot, MetaEdge } from '../src/types';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Instance = GraphInstance<NAttrs, EAttrs>;

/** Latest setPinnedIndices payload as a sorted array (null → []). */
function pinnedIndices(engine: FakeEngine): readonly number[] {
  const calls = engine.calls.filter((c) => c.method === 'setPinnedIndices');
  const last = calls[calls.length - 1];
  const arg = last?.args[0] as readonly number[] | null | undefined;
  return arg == null ? [] : [...arg].sort((a, b) => a - b);
}

/** Scene index of a physical node id. */
function slotOf(instance: Instance, id: string): number {
  const idx = instance.getSceneNodeIds().indexOf(id);
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx;
}

async function readyRig(links: ReadonlyArray<readonly [string, string]> = [['a', 'b']]) {
  const h = makeInstance({ fitViewOnFirstData: false });
  await h.instance.attach(container);
  h.instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], links) });
  return { ...h, engine: h.engines[0]! };
}

describe('persistent pins', () => {
  it('pinNodes survives a drag-and-release cycle on the SAME node', async () => {
    const { instance, engine } = await readyRig();
    const a = slotOf(instance, 'a');

    instance.pinNodes(['a']);
    expect(instance.store.getState().pinnedNodeIds).toEqual(new Set(['a']));
    expect(pinnedIndices(engine)).toEqual([a]);

    // A drag adds the TRANSIENT pin for the same node: the union is still {a}.
    engine.injectDragStart(a);
    engine.injectDragEnd(a, 42, 43);
    expect(instance.store.getState().pins.has('a')).toBe(true);
    expect(pinnedIndices(engine)).toEqual([a]);

    // Releasing the DRAG pin must NOT release the persistent one.
    instance.unpinNode('a');
    expect(instance.store.getState().pins.has('a')).toBe(false);
    expect(instance.store.getState().pinnedNodeIds).toEqual(new Set(['a']));
    expect(pinnedIndices(engine)).toEqual([a]);

    // …and unpinNodes releases it for real.
    instance.unpinNodes(['a']);
    expect(instance.store.getState().pinnedNodeIds.size).toBe(0);
    expect(pinnedIndices(engine)).toEqual([]);
  });

  it('the engine receives the UNION of persistent and drag pins', async () => {
    const { instance, engine } = await readyRig();
    const a = slotOf(instance, 'a');
    const b = slotOf(instance, 'b');

    instance.pinNodes(['a']);
    engine.injectDragStart(b);
    engine.injectDragEnd(b, 1, 2); // transient pin on a DIFFERENT node
    expect(pinnedIndices(engine)).toEqual([a, b].sort((x, y) => x - y));

    // Clearing the drag slice leaves the persistent pin alone.
    instance.clearPins();
    expect(pinnedIndices(engine)).toEqual([a]);
  });

  it('unknown ids drop, repeat pins are exact no-ops, and unpinning nothing no-ops', async () => {
    const { instance, engine } = await readyRig();
    const before = engine.calls.filter((c) => c.method === 'setPinnedIndices').length;

    instance.pinNodes(['nope']); // not in the accepted model
    expect(instance.store.getState().pinnedNodeIds.size).toBe(0);
    instance.unpinNodes(['a']); // never pinned
    expect(engine.calls.filter((c) => c.method === 'setPinnedIndices').length).toBe(before);

    instance.pinNodes(['a']);
    const afterFirst = engine.calls.filter((c) => c.method === 'setPinnedIndices').length;
    instance.pinNodes(['a']); // already pinned → no publication, no push
    expect(engine.calls.filter((c) => c.method === 'setPinnedIndices').length).toBe(afterFirst);
  });

  it('controlled pinnedNodeIds round-trips and departed ids prune through ownership', async () => {
    const { instance, engine } = await readyRig();
    const events: string[][] = [];
    instance.on('pinnedChange', ({ pinnedNodeIds }) => {
      events.push([...pinnedNodeIds]);
    });

    // The prop latches the slice controlled.
    instance.applyHostUpdate({ pinnedNodeIds: ['a', 'b'] });
    expect(instance.store.getState().pinnedNodeIds).toEqual(new Set(['a', 'b']));
    expect(pinnedIndices(engine)).toEqual([slotOf(instance, 'a'), slotOf(instance, 'b')].sort((x, y) => x - y));

    // A controlled op INTENDS instead of writing.
    instance.unpinNodes(['a']);
    expect(instance.store.getState().pinnedNodeIds).toEqual(new Set(['a', 'b'])); // unchanged
    expect(events[events.length - 1]).toEqual(['b']); // the intent

    // The host reflects the intent back.
    instance.applyHostUpdate({ pinnedNodeIds: ['b'] });
    expect(instance.store.getState().pinnedNodeIds).toEqual(new Set(['b']));

    // A model replacement that drops 'b' prunes it from the slice.
    instance.applyHostUpdate({ data: snap(2, ['a', 'c'], []) });
    expect(instance.store.getState().pinnedNodeIds.size).toBe(0);

    // null clears (D2).
    instance.applyHostUpdate({ pinnedNodeIds: ['a'] });
    expect(instance.store.getState().pinnedNodeIds).toEqual(new Set(['a']));
    instance.applyHostUpdate({ pinnedNodeIds: null });
    expect(instance.store.getState().pinnedNodeIds.size).toBe(0);
  });

  it('pinned indices are re-pushed with fresh slots after a structural change', async () => {
    const { instance, engine } = await readyRig();
    instance.pinNodes(['c']);
    expect(pinnedIndices(engine)).toEqual([slotOf(instance, 'c')]);

    // Reorder the roster: 'c' moves to slot 0, so the pushed index must move.
    instance.applyHostUpdate({ data: snap(2, ['c', 'a', 'b'], []) });
    expect(slotOf(instance, 'c')).toBe(0);
    expect(pinnedIndices(engine)).toEqual([0]);
  });
});

/** a→b twice (parallel) plus b→c once. */
function parallelSnap(rev: number): GraphSnapshot<NAttrs, EAttrs> {
  return {
    datasetKey: 'ds',
    sourceRevision: rev,
    nodes: ['a', 'b', 'c'].map((id) => ({ id, attrs: { label: id.toUpperCase() } })),
    edges: [
      { id: 'ab1', source: 'a', target: 'b', attrs: { weight: 1 } },
      { id: 'ab2', source: 'a', target: 'b', attrs: { weight: 1 } },
      { id: 'bc', source: 'b', target: 'c', attrs: { weight: 1 } },
    ],
  };
}

describe('parallel-edge grouping', () => {
  it('collapses a same-pair bundle into ONE meta-edge with the tuple id and count', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: parallelSnap(1) });
    const engine = h.engines[0]!;
    expect(h.instance.store.getState().edgeCount).toBe(3);

    h.instance.applyHostUpdate({ parallelEdgeGrouping: true });

    // Scene: one meta-edge (a→b, count 2) + the untouched b→c.
    const commit = engine.lastCommit!;
    expect(commit.structure!.links.length / 2).toBe(2);
    // The accepted model is UNCHANGED — grouping is a scene rewrite.
    expect(h.instance.store.getState().edgeCount).toBe(3);

    // Identity + weight, observed through the typed event: synthetics
    // occupy the link suffix, so slot 1 is the bundle (slot 0 = kept b→c).
    const hits: MetaEdge[] = [];
    h.instance.on('metaEdgeClick', ({ metaEdge }) => {
      hits.push(metaEdge);
    });
    engine.injectLinkClick(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe(metaEdgePublicId('node', 'a', 'node', 'b'));
    expect(hits[0]!.count).toBe(2); // the badge datum = collapsed multiplicity
    expect(hits[0]!.source).toBe('a');
    expect(hits[0]!.target).toBe('b');

    // Toggling OFF restores the originals as a structural diff.
    const before = engine.commits.length;
    h.instance.applyHostUpdate({ parallelEdgeGrouping: false });
    expect(engine.commits.length).toBe(before + 1);
    expect(engine.lastCommit!.structure!.links.length / 2).toBe(3);
  });

  it('caller edge accessors are never invoked with the synthesized bundle', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const seen: string[] = [];
    h.instance.applyHostUpdate({
      data: parallelSnap(1),
      linkColor: (e) => {
        seen.push(e.id);
        return 'white';
      },
    });
    seen.length = 0;
    h.instance.applyHostUpdate({ parallelEdgeGrouping: true });
    // The channel DID re-project (guards against a vacuous pass) and only
    // KEPT PHYSICAL edges reached it: the bundled pair is represented by the
    // synthetic meta-edge, which is styled through the aggregate channel and
    // never handed to a caller accessor.
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['bc']));
  });

  it('a dataset with NO parallels: documented diagnostic, zero scene change', async () => {
    const { instance, engine } = await readyRig([
      ['a', 'b'],
      ['b', 'c'],
    ]);
    const before = engine.commits.length;

    instance.applyHostUpdate({ parallelEdgeGrouping: true });

    const rejected = instance.store
      .getState()
      .diagnostics.filter((d) => d.code === 'operation-rejected');
    expect(rejected.some((d) => d.message.includes('inoperative'))).toBe(true);
    expect(engine.commits.length).toBe(before); // nothing changed
  });
});
