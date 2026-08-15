/**
 * versioned sources: switching versions is a new
 * `sourceRevision` under the SAME `datasetKey` — the diff applies and the
 * position cache keeps shared nodes where they were.
 *
 * Covers: byte-identical overlapping positions across the swap under a
 * non-live ('fixed') layout, the documented reheat (engine.restart) under
 * 'force', and the live-cache + departed-LRU interplay across three
 * successive versions (leave-and-return identity).
 */

import { describe, expect, it } from 'vitest';

import type { GraphInstance } from '../src/instance';
import type { FakeEngine } from '../src/testing/index';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Instance = GraphInstance<NAttrs, EAttrs>;

/** Engine-visible position of a node id (null when unknown). */
function posOf(engine: FakeEngine, instance: Instance, id: string): readonly [number, number] | null {
  const idx = instance.getVisibleNodeIds().indexOf(id);
  if (idx === -1) return null;
  const pos = engine.getPositions();
  if (pos === null) return null;
  return [pos[2 * idx]!, pos[2 * idx + 1]!];
}

describe("version switch under layout 'fixed'", () => {
  it('keeps overlapping ids BYTE-identical across the sourceRevision swap', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b']]), layout: 'fixed' });

    // Drift the engine so cached values are distinctive, then switch versions.
    engine.nudgePositions(3, 4);
    const before = {
      b: posOf(engine, h.instance, 'b')!,
      c: posOf(engine, h.instance, 'c')!,
    };

    h.instance.applyHostUpdate({ data: snap(2, ['b', 'c', 'd'], [['b', 'c']]) });

    expect(h.instance.getRevisions().source).toBe(2);
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeDefined(); // the diff is structural
    expect(commit.restart).toBeUndefined(); // fixed: exact identity, no reheat

    // Byte-identical: the committed structure carries the exact cached floats
    // (b, c occupy slots 0, 1 in the new accepted-base order).
    const positions = commit.structure!.positions;
    expect([positions[0], positions[1]]).toEqual([...before.b]);
    expect([positions[2], positions[3]]).toEqual([...before.c]);
    expect(posOf(engine, h.instance, 'b')).toEqual(before.b);
    expect(posOf(engine, h.instance, 'c')).toEqual(before.c);
  });
});

describe("version switch under layout 'force'", () => {
  it('carries cached positions into the commit but reheats (documented restart)', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b']]) }); // force default
    engine.injectSimulationEnd();

    const before = { b: posOf(engine, h.instance, 'b')!, c: posOf(engine, h.instance, 'c')! };
    h.instance.applyHostUpdate({ data: snap(2, ['b', 'c', 'd'], [['b', 'c']]) });

    const commit = engine.lastCommit!;
    // a structure change under a live layout triggers engine.restart
    // apps doing visual comparison should use a non-live layout.
    expect(commit.restart).toEqual({ alpha: 1 });
    expect(h.instance.store.getState().simulationRunning).toBe(true);
    // The commit still SEEDS overlapping ids from the cache; any movement
    // afterwards is the simulation's, not the core's.
    const positions = commit.structure!.positions;
    expect([positions[0], positions[1]]).toEqual([...before.b]);
    expect([positions[2], positions[3]]).toEqual([...before.c]);
  });
});

describe('cache interplay across three successive versions', () => {
  it('live cache carries kept ids; the departed LRU restores a leave-and-return id', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;

    // v1: a, b, c — seeded a(0,0) b(10,0) c(20,0), then drifted by (3,4).
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]), layout: 'fixed' });
    engine.nudgePositions(3, 4);
    const cAtV1 = posOf(engine, h.instance, 'c')!;
    expect(cAtV1).toEqual([23, 4]);

    // v2: c departs → banked into the departed LRU at (23,4).
    h.instance.applyHostUpdate({ data: snap(2, ['a', 'b'], [['a', 'b']]) });
    expect(h.instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    expect(posOf(engine, h.instance, 'a')).toEqual([3, 4]);
    expect(posOf(engine, h.instance, 'b')).toEqual([13, 4]);

    // Keep drifting the survivors so the live cache and departed cache hold
    // DIFFERENT generations of positions.
    engine.nudgePositions(1, 1);

    // v3: c returns → restored from the departed cache at its v1 position,
    // while a and b carry their freshest live-cache values.
    h.instance.applyHostUpdate({ data: snap(3, ['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]) });
    expect(h.instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
    expect(posOf(engine, h.instance, 'a')).toEqual([4, 5]);
    expect(posOf(engine, h.instance, 'b')).toEqual([14, 5]);
    expect(posOf(engine, h.instance, 'c')).toEqual([23, 4]); // leave-and-return identity

    // Three versions later the revisions read: source follows the caller
    // coordinate, model advanced once per accepted change.
    expect(h.instance.getRevisions().source).toBe(3);
    expect(h.instance.getRevisions().model).toBe(3);
  });
});
