/**
 * history wiring.
 *
 * The kernel records UNCONTROLLED mutations — selection (one transaction per
 * mutator call), hiddenNodeIds, pins, scope statements, and brushes
 * (coalesced per dimension key). undo/redo apply the inverted value
 * diffs via non-recording setters: one publish, engine pushes refreshed,
 * depths live in store.history, everything cleared on datasetKey change,
 * inert under history:false, and controlled selection never records.
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type { DimensionSpec } from '../src/types';
import { callsOf, container, makeInstance, snap } from './helpers';
import type { NAttrs } from './helpers';

async function readyRig() {
  const h = makeInstance();
  await h.instance.attach(container);
  h.instance.applyHostUpdate({
    data: snap(1, ['a', 'b', 'c'], [
      ['a', 'b'],
      ['b', 'c'],
    ]),
  });
  return { instance: h.instance, engine: h.engines[0]!, engines: h.engines };
}

const vDim: DimensionSpec<NAttrs> = {
  key: 'len',
  kind: 'numeric',
  get: (n) => n.id.length + (n.id.codePointAt(0)! - 96), // a→1, b→2, c→3 (+1 length) — monotonic
};

describe('selection undo/redo', () => {
  it('undoes and redoes selection mutations exactly, re-pushing indices', async () => {
    const { instance, engine } = await readyRig();
    instance.selectNodes(['a']);
    instance.selectNodes(['a', 'b']);
    expect(instance.store.getState().history).toEqual({ undoDepth: 2, redoDepth: 0 });

    expect(instance.undo()).toBe(true);
    expect(instance.store.getState().selection).toEqual({
      nodeIds: ['a'],
      edgeIds: [],
      groupIds: [],
    });
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[0]]);
    expect(instance.store.getState().history).toEqual({ undoDepth: 1, redoDepth: 1 });

    expect(instance.undo()).toBe(true);
    expect(instance.store.getState().selection.nodeIds).toEqual([]);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([null]);
    expect(instance.undo()).toBe(false); // bottom of the stack

    expect(instance.redo()).toBe(true);
    expect(instance.redo()).toBe(true);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b']);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[0, 1]]);
    expect(instance.redo()).toBe(false);
  });

  it('a new mutation clears the redo branch', async () => {
    const { instance } = await readyRig();
    instance.selectNodes(['a']);
    instance.undo();
    expect(instance.store.getState().history.redoDepth).toBe(1);
    instance.selectNodes(['c']);
    expect(instance.store.getState().history).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(instance.redo()).toBe(false);
  });
});

describe('hidden / pins / scope undo', () => {
  it('hiddenNodeIds undo restores the mask (alphas + visible counts)', async () => {
    const { instance, engine } = await readyRig();
    instance.hideNodes(['b']);
    expect(instance.store.getState().visible.nodes).toBe(2);

    expect(instance.undo()).toBe(true);
    expect(instance.store.getState().hiddenNodeIds.size).toBe(0);
    expect(instance.store.getState().visible).toEqual({ nodes: 3, edges: 2 });
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeUndefined();
    expect(commit.buffers!.pointColor![4 * 1 + 3]).toBe(1); // b visible again

    expect(instance.redo()).toBe(true);
    expect(instance.store.getState().hiddenNodeIds).toEqual(new Set(['b']));
    expect(instance.store.getState().visible.nodes).toBe(2);
    expect(engine.lastCommit!.buffers!.pointColor![4 * 1 + 3]).toBe(0);
  });

  it('pin undo re-pushes the pin set to the engine', async () => {
    const { instance, engine } = await readyRig();
    instance.pinNode('a', [1, 2]);
    instance.pinNode('b', [3, 4]);

    expect(instance.undo()).toBe(true);
    expect([...instance.store.getState().pins.entries()]).toEqual([['a', [1, 2]]]);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[0]]);

    expect(instance.undo()).toBe(true);
    expect(instance.store.getState().pins.size).toBe(0);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([null]);

    expect(instance.redo()).toBe(true);
    expect(instance.redo()).toBe(true);
    expect([...instance.store.getState().pins.entries()]).toEqual([
      ['a', [1, 2]],
      ['b', [3, 4]],
    ]);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[0, 1]]);
  });

  it('scope undo restores the full scene through the same reconcile path', async () => {
    const { instance, engine } = await readyRig();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    const revBefore = instance.getRevisions();

    expect(instance.undo()).toBe(true);
    expect(instance.store.getState().scope).toBeNull();
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
    const commit = engine.lastCommit!;
    expect(commit.structure!.pointCount).toBe(3);
    const rev = instance.getRevisions();
    expect(rev.model).toBe(revBefore.model); // scope-only: model untouched
    expect(rev.scope).toBe(revBefore.scope + 1);

    expect(instance.redo()).toBe(true);
    expect(instance.store.getState().scope).toEqual({ seedIds: ['a', 'b'] });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
  });

  it('isolateSelection/resetIsolation record as scope statements', async () => {
    const { instance } = await readyRig();
    instance.selectNodes(['a', 'b']); // entry 1
    instance.isolateSelection(); // entry 2
    expect(instance.store.getState().scope).toEqual({ seedIds: ['a', 'b'] });
    instance.resetIsolation(); // entry 3
    expect(instance.store.getState().history.undoDepth).toBe(3);

    expect(instance.undo()).toBe(true); // back to isolated
    expect(instance.store.getState().scope).toEqual({ seedIds: ['a', 'b'] });
    expect(instance.undo()).toBe(true); // back to full scope
    expect(instance.store.getState().scope).toBeNull();
  });
});

describe('brush undo/redo', () => {
  async function crossfilterRig() {
    const r = await readyRig();
    r.instance.applyHostUpdate({ crossfilter: [vDim] });
    const session = r.instance.getCrossfilterSession()!;
    return { ...r, session };
  }

  it('brush undo restores the prior brush AND the mask', async () => {
    const { instance, session } = await crossfilterRig();
    await session.setBrush('len', { min: 0, max: 2.5 }); // hides b, c
    expect(instance.store.getState().visible.nodes).toBe(1);

    expect(instance.undo()).toBe(true);
    expect(session.getBrush('len')).toBeNull();
    expect(instance.store.getState().visible).toEqual({ nodes: 3, edges: 2 });

    expect(instance.redo()).toBe(true);
    expect(session.getBrush('len')).toEqual({ min: 0, max: 2.5 });
    expect(instance.store.getState().visible.nodes).toBe(1);
  });

  it('a rapid brush drag coalesces into ONE entry restoring the ORIGINAL before', async () => {
    const { instance, session } = await crossfilterRig();
    await session.setBrush('len', { min: 0, max: 3.5 });
    await session.setBrush('len', { min: 0, max: 2.5 });
    await session.setBrush('len', { min: 0, max: 1.5 }); // all within 500ms

    expect(instance.store.getState().history).toEqual({ undoDepth: 1, redoDepth: 0 });
    expect(instance.undo()).toBe(true);
    expect(session.getBrush('len')).toBeNull(); // the FIRST before, not an intermediate
    expect(instance.store.getState().visible.nodes).toBe(3);
  });
});

describe('modes and lifecycle', () => {
  it('history: false is inert (no recording, undo/redo return false)', async () => {
    const engines: FakeEngine[] = [];
    const instance = createGraphInstance<NAttrs, { weight: number }>({
      engine: () => {
        const e = new FakeEngine();
        engines.push(e);
        return e;
      },
      history: false,
    });
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    instance.selectNodes(['a']);
    instance.hideNodes(['b']);
    instance.pinNode('a', [1, 1]);

    expect(instance.store.getState().history).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(instance.undo()).toBe(false);
    expect(instance.redo()).toBe(false);
    // The mutations themselves still applied.
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
    expect(instance.store.getState().hiddenNodeIds).toEqual(new Set(['b']));
  });

  it('history honors a custom limit', async () => {
    const instance = createGraphInstance<NAttrs, { weight: number }>({
      engine: () => new FakeEngine(),
      history: { limit: 2 },
    });
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c']) });
    instance.selectNodes(['a']);
    instance.selectNodes(['b']);
    instance.selectNodes(['c']);
    expect(instance.store.getState().history.undoDepth).toBe(2); // oldest evicted
  });

  it('a datasetKey change clears the stacks', async () => {
    const { instance } = await readyRig();
    instance.selectNodes(['a']);
    instance.hideNodes(['b']);
    expect(instance.store.getState().history.undoDepth).toBe(2);

    instance.applyHostUpdate({ data: snap(1, ['x', 'y'], [], 'ds2') });

    expect(instance.store.getState().history).toEqual({ undoDepth: 0, redoDepth: 0 });
    expect(instance.undo()).toBe(false);
  });

  it('controlled selection is NOT recorded; hide/pin slices still are', async () => {
    const { instance } = await readyRig();
    instance.applyHostUpdate({ selection: ['a'] }); // flips to controlled

    instance.selectNodes(['b']); // intent only — host owns selection
    instance.setSelection(['c']);
    expect(instance.store.getState().history).toEqual({ undoDepth: 0, redoDepth: 0 });

    instance.hideNodes(['b']);
    instance.pinNode('a', [5, 5]);
    expect(instance.store.getState().history.undoDepth).toBe(2);

    // Undo applies hide/pin diffs but never touches controlled selection.
    expect(instance.undo()).toBe(true);
    expect(instance.undo()).toBe(true);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
    expect(instance.store.getState().hiddenNodeIds.size).toBe(0);
    expect(instance.store.getState().pins.size).toBe(0);
  });

  it('drag-pin (the built-in follow-up) records like pinNode', async () => {
    const { instance, engine } = await readyRig();
    engine.injectDragEnd(0, 7, 8); // pins 'a' at (7,8)
    expect(instance.store.getState().pins.get('a')).toEqual([7, 8]);
    expect(instance.store.getState().history.undoDepth).toBe(1);
    expect(instance.undo()).toBe(true);
    expect(instance.store.getState().pins.size).toBe(0);
  });

  it('depth changes fold into the mutation publish (no extra store set)', async () => {
    const { instance } = await readyRig();
    let notifications = 0;
    instance.store.subscribe(() => notifications++);
    instance.hideNodes(['b']); // record + mask + publish — ONE notification
    expect(notifications).toBe(1);
    expect(instance.store.getState().history.undoDepth).toBe(1);
  });

  it('undo on a destroyed instance is a silent false', async () => {
    const { instance } = await readyRig();
    instance.selectNodes(['a']);
    instance.destroy();
    expect(instance.undo()).toBe(false);
    expect(instance.redo()).toBe(false);
  });
});
