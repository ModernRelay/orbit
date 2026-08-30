/**
 * Overlay scheduler and instance surface.
 *
 * Covers: per-frame position fan-out (projection only — NEVER a re-rank),
 * throttled viewport re-ranks, capped sim-hot readback cadence, one
 * label-overload diagnostic per transition, subscription replay/unsubscribe,
 * contextMenu event mapping, pause/resume + simulationRunning transitions,
 * captureScreenshot delegation, and reduced-motion camera coercion.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Spy-wrap the selector so tests can prove frame ticks never re-rank.
vi.mock('../src/labels', { spy: true });

import * as labelsModule from '../src/labels';
import { callsOf, container, makeInstance, snap } from './helpers';
import type { NAttrs } from './helpers';
import type { LabelConfig, LabelPlacement } from '../src/types';

const selectSpy = vi.mocked(labelsModule.selectLabelCandidates);

afterEach(() => {
  vi.useRealTimers();
  selectSpy.mockClear();
});

/**
 * Ready instance with data a/b/c (degrees a=2, b=1, c=1), a labels config, and
 * a PRIMED position cache: the first frame tick banks the FakeEngine's seeded
 * grid (a→(0,0), b→(10,0), c→(20,0)) and the settle re-rank publishes the
 * candidate set [a, b, c] (degree rank, accepted-base ties).
 */
async function setup(labelOverrides: Partial<LabelConfig<NAttrs>> = {}) {
  const h = makeInstance({ fitViewOnFirstData: false });
  await h.instance.attach(container);
  const engine = h.engines[0]!;
  h.instance.applyHostUpdate({
    data: snap(1, ['a', 'b', 'c'], [['a', 'b'], ['a', 'c']]),
    // overlap-blind by default: this file pins scheduling, not declutter
    labels: { minZoom: 0, overlap: 'allow', ...labelOverrides },
  });
  engine.emitFrame(0); // sim-hot: first tick refreshes the CPU cache
  engine.injectSimulationEnd(); // settle: bank + re-rank
  return { ...h, engine };
}

describe('position channel (frame ticks)', () => {
  it('fires per emitFrame with spaceToScreen-projected cache coords and never re-ranks', async () => {
    const { instance, engine } = await setup();
    const frames: LabelPlacement[][] = [];
    const unsub = instance.labels.subscribePositions((list) => frames.push(list.map((p) => ({ ...p }))));

    // Replay on subscribe with current projected coordinates.
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual([
      { id: 'a', text: 'A', x: 0, y: 0, forced: false },
      { id: 'b', text: 'B', x: 10, y: 0, forced: false },
      { id: 'c', text: 'C', x: 20, y: 0, forced: false },
    ]);

    selectSpy.mockClear();
    instance.resumeSimulation();
    engine.nudgePositions(5, 7); // live engine drift
    engine.emitFrame(1000); // >=500ms since t=0 → ONE readback refreshes the cache
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual([
      { id: 'a', text: 'A', x: 5, y: 7, forced: false },
      { id: 'b', text: 'B', x: 15, y: 7, forced: false },
      { id: 'c', text: 'C', x: 25, y: 7, forced: false },
    ]);

    engine.emitFrame(1016); // within the cadence window → projection only
    expect(frames).toHaveLength(3);
    expect(frames[2]).toEqual(frames[1]);

    // Frame ticks NEVER re-rank — the selector was untouched.
    expect(selectSpy).not.toHaveBeenCalled();

    unsub();
    engine.emitFrame(1032);
    expect(frames).toHaveLength(3);
  });

  it('skips notification when there are no subscribers or no candidates', async () => {
    const { instance, engine } = await setup();
    const before = callsOf(engine, 'spaceToScreen').length;
    engine.emitFrame(100); // subscribers absent → no projection work
    expect(callsOf(engine, 'spaceToScreen').length).toBe(before);

    const cb = vi.fn();
    instance.applyHostUpdate({ labels: { enabled: false } }); // candidates → []
    instance.labels.subscribePositions(cb);
    expect(cb).toHaveBeenCalledExactlyOnceWith([]); // replay still happens
    engine.emitFrame(200);
    expect(cb).toHaveBeenCalledTimes(1); // empty set → no per-frame notify
  });
});

describe('sim-hot cache refresh', () => {
  it('caps getPositions readbacks at >=500ms apart while the simulation runs', async () => {
    const { instance, engine } = await setup();
    instance.resumeSimulation();
    const base = callsOf(engine, 'getPositions').length;

    engine.emitFrame(1000); // 1000 - 0 >= 500 → refresh
    engine.emitFrame(1100);
    engine.emitFrame(1400);
    expect(callsOf(engine, 'getPositions').length).toBe(base + 1);

    engine.emitFrame(1500); // exactly 500ms later → second refresh
    expect(callsOf(engine, 'getPositions').length).toBe(base + 2);
  });

  it('does not read back while the simulation is settled', async () => {
    const { engine } = await setup(); // injectSimulationEnd left it settled
    const base = callsOf(engine, 'getPositions').length;
    engine.emitFrame(5000);
    engine.emitFrame(6000);
    expect(callsOf(engine, 'getPositions').length).toBe(base);
  });
});

describe('candidate channel (throttled re-rank)', () => {
  it('viewport bursts coalesce into one trailing re-rank; emits only on set change', async () => {
    vi.useFakeTimers();
    const { instance, engine } = await setup();
    const emissions: (readonly LabelPlacement[])[] = [];
    instance.labels.subscribeCandidates((list) => emissions.push([...list]));
    expect(emissions).toHaveLength(1); // replay
    expect(emissions[0]!.map((p) => p.id)).toEqual(['a', 'b', 'c']);

    selectSpy.mockClear();
    engine.injectViewportChange({ x: 0, y: 0, zoom: 2 });
    engine.injectViewportChange({ x: 1, y: 0, zoom: 2 });
    engine.injectViewportChange({ x: 2, y: 0, zoom: 2 });
    expect(selectSpy).not.toHaveBeenCalled(); // trailing throttle
    vi.advanceTimersByTime(99);
    expect(selectSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(selectSpy).toHaveBeenCalledTimes(1); // ONE re-rank for the burst
    expect(emissions).toHaveLength(1); // same set → no emission

    // Config change re-ranks immediately; zoom 2 < minZoom 5 → set → [].
    instance.applyHostUpdate({ labels: { minZoom: 5 } });
    expect(emissions).toHaveLength(2);
    expect(emissions[1]).toEqual([]);
  });

  it('replays current state on subscribe and stops after unsubscribe', async () => {
    const { instance } = await setup();
    const first: number[] = [];
    const second: number[] = [];
    const unsub = instance.labels.subscribeCandidates((l) => first.push(l.length));
    instance.labels.subscribeCandidates((l) => second.push(l.length));
    expect(first).toEqual([3]);
    expect(second).toEqual([3]);

    unsub();
    instance.applyHostUpdate({ labels: { minZoom: 9 } }); // set change → []
    expect(first).toEqual([3]); // unsubscribed — silent
    expect(second).toEqual([3, 0]); // remaining subscriber notified
  });
});

describe('label-overload diagnostic', () => {
  it('emits once per overload transition and updates the count — no spam', async () => {
    const { instance, engine } = await setup({ maxVisible: 2, showFor: ['a', 'b', 'c'] });
    const diags = () => instance.getDiagnostics().filter((d) => d.code === 'label-overload');

    expect(diags()).toHaveLength(1);
    expect(diags()[0]).toMatchObject({ severity: 'warning', count: 1 });

    // Steady state: repeated settles re-rank but do NOT restate the diagnostic.
    engine.injectSimulationEnd();
    engine.injectSimulationEnd();
    expect(diags()).toHaveLength(1);
    expect(diags()[0]!.count).toBe(1);

    // Overload clears → the diagnostic is removed.
    instance.applyHostUpdate({ labels: { minZoom: 0, maxVisible: 2, showFor: ['a', 'b'] } });
    expect(diags()).toHaveLength(0);

    // New transition with a different count → one diagnostic, updated count.
    instance.applyHostUpdate({ labels: { minZoom: 0, maxVisible: 1, showFor: ['a', 'b', 'c'] } });
    expect(diags()).toHaveLength(1);
    expect(diags()[0]!.count).toBe(2);
  });

  it('keeps forced winners in accepted-base order under overload', async () => {
    const { instance } = await setup({ maxVisible: 2, showFor: ['c', 'b', 'a'] });
    const seen: (readonly LabelPlacement[])[] = [];
    instance.labels.subscribeCandidates((l) => seen.push([...l]));
    expect(seen[0]!.map((p) => ({ id: p.id, forced: p.forced }))).toEqual([
      { id: 'a', forced: true },
      { id: 'b', forced: true },
    ]);
  });
});

describe('contextMenu event', () => {
  it('maps host onContextMenu to typed node/background payloads', async () => {
    const { instance, engine } = await setup();
    const events: unknown[] = [];
    instance.on('contextMenu', (p) => events.push(p));

    engine.injectContextMenu(0, [12, 34]);
    engine.injectContextMenu(null, [1, 2]);

    expect(events).toEqual([
      { target: { kind: 'node', node: { id: 'a', attrs: { label: 'A' } } }, screen: [12, 34] },
      { target: { kind: 'background' }, screen: [1, 2] },
    ]);
  });

  it('drops gestures on stale indices', async () => {
    const { instance, engine } = await setup();
    const cb = vi.fn();
    instance.on('contextMenu', cb);
    engine.injectContextMenu(99, [0, 0]);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('simulation controls', () => {
  it('tracks simulationRunning across restart commits, settle, pause, and resume', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    expect(h.instance.isSimulationRunning()).toBe(false);

    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    expect(h.instance.isSimulationRunning()).toBe(true); // commit carried restart
    expect(h.instance.store.getState().simulationRunning).toBe(true);

    engine.injectSimulationEnd();
    expect(h.instance.isSimulationRunning()).toBe(false);

    h.instance.resumeSimulation();
    expect(callsOf(engine, 'start')).toHaveLength(1);
    expect(h.instance.isSimulationRunning()).toBe(true);

    h.instance.pauseSimulation();
    expect(callsOf(engine, 'pause')).toHaveLength(1);
    expect(h.instance.isSimulationRunning()).toBe(false);
  });

  it('pause/resume are no-ops before the engine is ready', () => {
    const h = makeInstance();
    h.instance.resumeSimulation();
    h.instance.pauseSimulation();
    expect(h.instance.isSimulationRunning()).toBe(false);
    expect(h.engines).toHaveLength(0);
  });
});

describe('captureScreenshot', () => {
  it('delegates to the engine and resolves null when not ready', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    const h = makeInstance({ fitViewOnFirstData: false, engineOptions: { screenshot: blob } });
    await expect(h.instance.captureScreenshot()).resolves.toBeNull(); // pre-attach

    await h.instance.attach(container);
    await expect(h.instance.captureScreenshot()).resolves.toBe(blob);
    expect(callsOf(h.engines[0]!, 'captureScreenshot')).toHaveLength(1);
  });

  it('resolves null from an engine without a screenshot to give', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    await expect(h.instance.captureScreenshot()).resolves.toBeNull();
  });
});

describe('reduced motion', () => {
  it('coerces camera durations to 0 when the binding reports reduced motion', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    h.instance.setReducedMotion(true);
    h.instance.fitView();
    h.instance.setViewport({ zoom: 2 });
    h.instance.zoomIn();
    h.instance.focusNode('a', { highlightNeighbors: false });

    expect(engine.cameraCalls).toEqual([
      { method: 'fitView', args: [{ durationMs: 0, maxZoom: 1.5 }] },
      { method: 'setViewport', args: [{ zoom: 2 }, { durationMs: 0 }] },
      { method: 'zoom', args: [1.5, 0] },
      { method: 'zoomToIndex', args: [0, 0] },
    ]);
  });

  it('accessibility.reducedMotion overrides the binding value', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({
      data: snap(1, ['a']),
      accessibility: { reducedMotion: false },
    });

    h.instance.setReducedMotion(true); // config wins → full motion
    h.instance.fitView();
    expect(engine.cameraCalls).toEqual([{ method: 'fitView', args: [{ maxZoom: 1.5 }] }]);

    expect(h.instance.getAccessibility()).toEqual({ reducedMotion: false });
  });
});
