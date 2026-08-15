import { describe, expect, it } from 'vitest';

import { FakeEngine } from '../src/testing/index';
import type { EngineCommit, EngineHostEvents } from '../src/engine/index';

const dummyContainer = {} as unknown as HTMLElement;

function structureCommit(revision: number, coords: readonly number[], links: readonly number[] = []): EngineCommit {
  return {
    revision,
    structure: {
      pointCount: coords.length / 2,
      positions: Float32Array.from(coords),
      links: Uint32Array.from(links),
    },
  };
}

describe('FakeEngine recording', () => {
  it('records every public method call in order with trimmed args', async () => {
    const engine = new FakeEngine();
    const events: EngineHostEvents = {};
    await engine.mount(dummyContainer, events);

    const c1 = structureCommit(1, [Number.NaN, Number.NaN]);
    engine.commit(c1);
    engine.start(0.5);
    engine.pause();
    engine.setSelectedIndices([0]);
    engine.setFocusedIndex(null);
    engine.fitView({ padding: 0.1 });
    engine.zoom(2);
    engine.setViewport({ zoom: 3 }, { durationMs: 100 });
    engine.zoomToIndex(0, 250);
    engine.destroy();

    expect(engine.calls.map((c) => c.method)).toEqual([
      'mount',
      'commit',
      'start',
      'pause',
      'setSelectedIndices',
      'setFocusedIndex',
      'fitView',
      'zoom',
      'setViewport',
      'zoomToIndex',
      'destroy',
    ]);
    expect(engine.calls[0]).toEqual({ method: 'mount', args: [dummyContainer, events] });
    expect(engine.calls[1]).toEqual({ method: 'commit', args: [c1] });
    expect(engine.calls[2]).toEqual({ method: 'start', args: [0.5] });
    expect(engine.calls[5]).toEqual({ method: 'setFocusedIndex', args: [null] });
  });

  it('exposes typed conveniences: commits, lastCommit, cameraCalls', () => {
    const engine = new FakeEngine();
    const c1: EngineCommit = { revision: 1 };
    const c2: EngineCommit = { revision: 2, config: { backgroundColor: '#000' } };
    engine.commit(c1);
    engine.commit(c2);
    engine.start();
    engine.fitView();
    engine.zoom(2);
    engine.setViewport({ x: 1 });
    engine.zoomToIndex(4);
    engine.pause();

    expect(engine.commits).toEqual([c1, c2]);
    expect(engine.lastCommit).toBe(c2);
    expect(engine.cameraCalls).toEqual([
      { method: 'fitView', args: [] },
      { method: 'zoom', args: [2] },
      { method: 'setViewport', args: [{ x: 1 }] },
      { method: 'zoomToIndex', args: [4] },
    ]);
  });
});

describe('FakeEngine applied-revision semantics', () => {
  it('applies commits immediately by default', () => {
    const engine = new FakeEngine();
    expect(engine.appliedRevision()).toBeNull();
    engine.commit({ revision: 1 });
    expect(engine.appliedRevision()).toBe(1);
    engine.commit({ revision: 2 });
    expect(engine.appliedRevision()).toBe(2);
  });

  it('manualFrames queues commits; stepFrame applies oldest first', () => {
    const engine = new FakeEngine({ manualFrames: true });
    engine.commit(structureCommit(1, [Number.NaN, Number.NaN]));
    engine.commit({ revision: 2 });

    // Commits are recorded but not yet visible.
    expect(engine.commits).toHaveLength(2);
    expect(engine.appliedRevision()).toBeNull();
    expect(engine.getPositions()).toBeNull();

    engine.stepFrame();
    expect(engine.appliedRevision()).toBe(1);
    expect(engine.getPositions()).toEqual(new Float32Array([0, 0]));

    engine.stepFrame();
    expect(engine.appliedRevision()).toBe(2);

    // Empty queue: no-op.
    engine.stepFrame();
    expect(engine.appliedRevision()).toBe(2);
  });
});

describe('FakeEngine positions', () => {
  it('returns null before any structure commit', () => {
    const engine = new FakeEngine();
    expect(engine.getPositions()).toBeNull();
    engine.commit({ revision: 1 }); // no structure
    expect(engine.getPositions()).toBeNull();
  });

  it('seeds NaN pairs deterministically and keeps known positions verbatim', () => {
    const engine = new FakeEngine();
    const count = 205;
    const coords: number[] = [];
    for (let i = 0; i < count; i++) coords.push(Number.NaN, Number.NaN);
    coords[2] = 5; // index 1: fully known — kept verbatim
    coords[3] = -7;
    coords[4] = 42; // index 2: half-NaN pair — still seeded
    engine.commit(structureCommit(1, coords));

    const pos = engine.getPositions();
    expect(pos).not.toBeNull();
    expect(pos!).toHaveLength(2 * count);
    expect([pos![0], pos![1]]).toEqual([0, 0]); // seed(0)
    expect([pos![2], pos![3]]).toEqual([5, -7]); // verbatim
    expect([pos![4], pos![5]]).toEqual([20, 0]); // seed(2)
    expect([pos![2 * 101], pos![2 * 101 + 1]]).toEqual([10, 10]); // seed(101): second row
    expect([pos![2 * 204], pos![2 * 204 + 1]]).toEqual([40, 20]); // seed(204): third row
  });

  it('seeding is deterministic across engine instances', () => {
    const coords = [Number.NaN, Number.NaN, 1, 2, Number.NaN, Number.NaN];
    const a = new FakeEngine();
    const b = new FakeEngine();
    a.commit(structureCommit(1, coords));
    b.commit(structureCommit(7, coords));
    expect(a.getPositions()).toEqual(b.getPositions());
  });

  it('nudgePositions shifts every point; getPositions returns defensive copies', () => {
    const engine = new FakeEngine();
    engine.commit(structureCommit(1, [1, 2, 3, 4]));

    const before = engine.getPositions()!;
    engine.nudgePositions(10, -1);
    const after = engine.getPositions()!;

    expect(Array.from(after)).toEqual([11, 1, 13, 3]);
    // Earlier readback is a snapshot, unaffected by the nudge.
    expect(Array.from(before)).toEqual([1, 2, 3, 4]);
    // Mutating a returned array never leaks back into the engine.
    after[0] = 999;
    expect(engine.getPositions()![0]).toBe(11);
  });
});

describe('FakeEngine event injection', () => {
  it('dispatches injected events to the mounted host', async () => {
    const engine = new FakeEngine();
    const received: unknown[] = [];
    const events: EngineHostEvents = {
      onPointClick: (i) => received.push(['click', i]),
      onPointHover: (i) => received.push(['hover', i]),
      onViewportChange: (v) => received.push(['viewport', v]),
      onSimulationEnd: () => received.push(['simEnd']),
      onError: (e) => received.push(['error', e]),
    };
    await engine.mount(dummyContainer, events);

    const viewport = { x: 4, y: 5, zoom: 2 };
    const error = new Error('boom');
    engine.injectPointClick(3);
    engine.injectPointClick(null);
    engine.injectPointHover(1);
    engine.injectPointHover(null);
    engine.injectViewportChange(viewport);
    engine.injectSimulationEnd();
    engine.injectError(error);

    expect(received).toEqual([
      ['click', 3],
      ['click', null],
      ['hover', 1],
      ['hover', null],
      ['viewport', viewport],
      ['simEnd'],
      ['error', error],
    ]);
  });

  it('injection helpers throw when not mounted', () => {
    const engine = new FakeEngine();
    expect(() => engine.injectPointClick(0)).toThrow(/mount/);
    expect(() => engine.injectPointHover(null)).toThrow(/mount/);
    expect(() => engine.injectViewportChange({ x: 0, y: 0, zoom: 1 })).toThrow(/mount/);
    expect(() => engine.injectSimulationEnd()).toThrow(/mount/);
    expect(() => engine.injectError(new Error('x'))).toThrow(/mount/);
  });

  it('tolerates hosts that omit optional event handlers', async () => {
    const engine = new FakeEngine();
    await engine.mount(dummyContainer, {});
    expect(() => {
      engine.injectPointClick(0);
      engine.injectSimulationEnd();
    }).not.toThrow();
  });
});

describe('FakeEngine viewport', () => {
  it('defaults to {x:0,y:0,zoom:1} and merges setViewport partials', () => {
    const engine = new FakeEngine();
    expect(engine.getViewport()).toEqual({ x: 0, y: 0, zoom: 1 });
    engine.setViewport({ zoom: 2 });
    expect(engine.getViewport()).toEqual({ x: 0, y: 0, zoom: 2 });
    engine.setViewport({ x: 9 });
    expect(engine.getViewport()).toEqual({ x: 9, y: 0, zoom: 2 });
  });

  it('returns the last injected viewport', async () => {
    const engine = new FakeEngine();
    await engine.mount(dummyContainer, {});
    engine.injectViewportChange({ x: -3, y: 8, zoom: 0.5 });
    expect(engine.getViewport()).toEqual({ x: -3, y: 8, zoom: 0.5 });
  });
});

describe('FakeEngine capabilities', () => {
  it('has the documented defaults', () => {
    expect(new FakeEngine().capabilities).toEqual({
      linkPicking: false,
      rangeUpdates: [],
      trackedPositions: false,
      simulation: true,
      // Quiescent by construction: frames exist only when a test calls
      // stepFrame/emitFrame, and those apply-then-emit (post-draw).
      idleFrames: 'stops',
      postDrawFrames: true,
    });
  });

  it('merges partial overrides over the defaults', () => {
    const engine = new FakeEngine({
      capabilities: { linkPicking: true, simulation: false, idleFrames: 'free-running' },
    });
    expect(engine.capabilities).toEqual({
      linkPicking: true,
      rangeUpdates: [],
      trackedPositions: false,
      simulation: false,
      idleFrames: 'free-running',
      postDrawFrames: true,
    });
  });
});

describe('FakeEngine destroy', () => {
  it('marks the engine destroyed and further commits throw', () => {
    const engine = new FakeEngine();
    engine.commit({ revision: 1 });
    expect(engine.destroyed).toBe(false);

    engine.destroy();

    expect(engine.destroyed).toBe(true);
    expect(() => engine.commit({ revision: 2 })).toThrow(/destroy/);
    // Recorded state survives for post-mortem assertions.
    expect(engine.appliedRevision()).toBe(1);
    expect(engine.commits).toHaveLength(1);
  });

  it('unmounts on destroy: injection helpers throw afterwards', async () => {
    const engine = new FakeEngine();
    await engine.mount(dummyContainer, {});
    engine.destroy();
    expect(() => engine.injectPointClick(0)).toThrow(/mount/);
  });
});

describe('FakeEngine state mirrors', () => {
  it('selectedIndices mirrors the last setSelectedIndices payload, including the null clear', () => {
    const engine = new FakeEngine();
    expect(engine.selectedIndices).toBeNull();

    engine.setSelectedIndices([2, 0]);
    expect(engine.selectedIndices).toEqual([2, 0]);

    // Defensive copy: mutating the caller's array never mutates the mirror.
    const pushed = [7];
    engine.setSelectedIndices(pushed);
    pushed.push(9);
    expect(engine.selectedIndices).toEqual([7]);

    engine.setSelectedIndices(null);
    expect(engine.selectedIndices).toBeNull();
  });

  it('pinnedIndices and selectedIndices are independent lanes', () => {
    const engine = new FakeEngine();
    engine.setPinnedIndices([1]);
    engine.setSelectedIndices([2]);
    expect(engine.pinnedIndices).toEqual([1]);
    expect(engine.selectedIndices).toEqual([2]);
    engine.setSelectedIndices(null);
    expect(engine.pinnedIndices).toEqual([1]); // clearing one leaves the other
  });

  it('lastStructure returns the newest structure-bearing commit, skipping buffers-only commits', () => {
    const engine = new FakeEngine();
    expect(engine.lastStructure).toBeUndefined();

    engine.commit(structureCommit(1, [0, 0, 1, 1], [0, 1]));
    engine.commit({ revision: 2, buffers: { pointColor: Float32Array.from([1, 1, 1, 1]) } });

    expect(engine.lastCommit!.structure).toBeUndefined(); // newest commit has none
    expect(engine.lastStructure!.pointCount).toBe(2);
    expect(Array.from(engine.lastStructure!.links)).toEqual([0, 1]);

    engine.commit(structureCommit(3, [0, 0]));
    expect(engine.lastStructure!.pointCount).toBe(1);
  });

  it('lastBuffer tracks each channel independently — a newer commit for one channel never hides another', () => {
    const engine = new FakeEngine();
    expect(engine.lastBuffer('pointColor')).toBeUndefined();

    engine.commit({
      revision: 1,
      buffers: {
        pointColor: Float32Array.from([1, 0, 0, 1]),
        linkColor: Float32Array.from([0, 0, 1, 1]),
      },
    });
    engine.commit({ revision: 2, buffers: { pointColor: Float32Array.from([0, 1, 0, 0.5]) } });

    expect(Array.from(engine.lastBuffer('pointColor')!)).toEqual([0, 1, 0, 0.5]);
    // The link lane was NOT re-committed, so its last value still stands.
    expect(Array.from(engine.lastBuffer('linkColor')!)).toEqual([0, 0, 1, 1]);
    expect(engine.lastBuffer('pointSize')).toBeUndefined();
  });
});
