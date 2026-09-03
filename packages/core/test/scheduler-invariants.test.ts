/**
 * Overlay scheduler invariants that the label lane must never regress on:
 *
 * - frame ticks are pure O(k) CPU projection: the candidate selector is
 * NEVER invoked by a tick, the positions channel fires once per tick, and
 * the emitted array + placement objects are REUSED (no per-tick allocation
 * of the fan-out payload);
 * - settled ticks perform ZERO GPU readbacks because Cosmos tracked-position
 * readback incurs a synchronous stall regardless of k;
 * - viewport-driven re-ranks are trailing-throttled at 100ms;
 * - sim-hot cache refreshes are capped at a >=500ms getPositions cadence;
 * - 'label-overload' publishes exactly once per overload transition, however
 * many re-ranks repeat inside the same overloaded steady state.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Spy-wrap the selector so tests can prove frame ticks never re-rank.
vi.mock('../src/labels', { spy: true });

import * as labelsModule from '../src/labels';
import { callsOf, container, makeInstance, snap } from './helpers';
import type { NAttrs } from './helpers';
import type { LabelConfig, LabelPlacement } from '../src/types';

const selectSpy = vi.mocked(labelsModule.selectLabelCandidates);

/** 80 nodes → a full 64-candidate set under the default cap. */
const IDS = Array.from({ length: 80 }, (_, i) => `n${String(i).padStart(2, '0')}`);

/**
 * Ready instance with 80 nodes, a labels config, and a PRIMED position cache:
 * the t=0 sim-hot tick banks the FakeEngine's seeded grid (anchoring the
 * refresh cadence at 0ms) and the settle re-rank publishes the candidate set
 * (first 64 ids — equal weights, accepted-base tie-break). The selector spy
 * is cleared so each test observes only its own triggers.
 */
async function setup(labelOverrides: Partial<LabelConfig<NAttrs>> = {}) {
  const h = makeInstance({ fitViewOnFirstData: false });
  await h.instance.attach(container);
  const engine = h.engines[0]!;
  h.instance.applyHostUpdate({
    data: snap(1, IDS),
    // overlap-blind by default: this file pins frame-tick invariants
    labels: { minZoom: 0, maxVisible: 64, overlap: 'allow', ...labelOverrides },
  });
  engine.emitFrame(0); // sim-hot: first tick refreshes the CPU cache
  engine.injectSimulationEnd(); // settle: bank + re-rank
  selectSpy.mockClear();
  return { ...h, engine };
}

afterEach(() => {
  vi.useRealTimers();
  selectSpy.mockClear();
});

describe('frame-tick invariants', () => {
  it('300 ticks over a 64-candidate set: zero re-ranks, 300 position callbacks, reused identities, zero readbacks', async () => {
    const { instance, engine } = await setup();

    let callbackCount = 0;
    const seenArrays = new Set<readonly LabelPlacement[]>();
    const seenFirstPlacements = new Set<LabelPlacement>();
    instance.labels.subscribePositions((list) => {
      callbackCount++;
      seenArrays.add(list);
      seenFirstPlacements.add(list[0]!);
    });

    // Replay on subscribe carries the full 64-candidate set.
    expect(callbackCount).toBe(1);
    expect([...seenArrays][0]!).toHaveLength(64);

    const readbacksBefore = callsOf(engine, 'getPositions').length;
    for (let i = 0; i < 300; i++) engine.emitFrame();

    // One positions notification per tick — and not a single re-rank.
    expect(callbackCount).toBe(1 + 300);
    expect(selectSpy).not.toHaveBeenCalled();

    // Allocation invariant (pinned interface: array + placement objects are
    // REUSED across ticks): every callback observed the same identities.
    expect(seenArrays.size).toBe(1);
    expect(seenFirstPlacements.size).toBe(1);

    // Settled ticks are pure CPU projection — zero GPU readbacks (M0).
    expect(callsOf(engine, 'getPositions').length).toBe(readbacksBefore);
  });
});

describe('viewport re-rank throttle', () => {
  it('re-ranks only after the 100ms trailing throttle; ticks inside the window never re-rank', async () => {
    const { instance, engine } = await setup();
    vi.useFakeTimers();

    const emissions: string[][] = [];
    instance.labels.subscribeCandidates((list) => emissions.push(list.map((p) => p.id)));
    expect(emissions).toHaveLength(1); // replay
    selectSpy.mockClear();

    engine.injectViewportChange({ x: 3, y: 0, zoom: 1 });
    engine.injectViewportChange({ x: 6, y: 0, zoom: 1 });
    engine.injectViewportChange({ x: 9, y: 0, zoom: 1 });
    engine.emitFrame(); // a tick inside the pending window is projection-only
    expect(selectSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(99);
    expect(selectSpy).not.toHaveBeenCalled(); // 99ms < the 100ms throttle

    vi.advanceTimersByTime(1);
    expect(selectSpy).toHaveBeenCalledTimes(1); // ONE re-rank for the burst

    // Same winners (no cull rect in the headless container) → no emission.
    expect(emissions).toHaveLength(1);
  });
});

describe('sim-hot readback cadence', () => {
  it('caps getPositions refreshes at >=500ms apart across a 5s hot window (<=11 calls)', async () => {
    const { instance, engine } = await setup();
    instance.resumeSimulation();

    // 60fps-ish tick stream over a 5s hot window; record each tick time at
    // which the scheduler performed a cache readback.
    const refreshTimes: number[] = [];
    let before = callsOf(engine, 'getPositions').length;
    for (let t = 16; t <= 5000; t += 16) {
      engine.emitFrame(t);
      const after = callsOf(engine, 'getPositions').length;
      if (after > before) refreshTimes.push(t);
      before = after;
    }

    expect(refreshTimes.length).toBeGreaterThan(0); // the cache DOES refresh hot
    expect(refreshTimes.length).toBeLessThanOrEqual(11); // ~5s / 500ms + slack
    // Consecutive refreshes are >=500ms apart (anchor banked at t=0 in setup).
    expect(refreshTimes[0]!).toBeGreaterThanOrEqual(500);
    for (let i = 1; i < refreshTimes.length; i++) {
      expect(refreshTimes[i]! - refreshTimes[i - 1]!).toBeGreaterThanOrEqual(500);
    }
  });
});

describe('label-overload transitions', () => {
  it('publishes exactly once per overload transition across repeated re-ranks', async () => {
    const { instance, engine } = await setup({ maxVisible: 2, showFor: ['n00', 'n01', 'n02'] });
    const diags = () =>
      instance.getDiagnostics().filter((d) => d.code === 'label-overload');

    // Setup's settle re-rank entered the overloaded state: ONE diagnostic.
    expect(diags()).toHaveLength(1);
    expect(diags()[0]).toMatchObject({ severity: 'warning', count: 1 });

    // Repeated re-ranks in the SAME overloaded steady state — settle twice,
    // plus a throttled viewport re-rank — never restate the diagnostic.
    vi.useFakeTimers();
    engine.injectSimulationEnd();
    engine.injectSimulationEnd();
    engine.injectViewportChange({ x: 1, y: 0, zoom: 1 });
    vi.advanceTimersByTime(100);
    expect(selectSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(diags()).toHaveLength(1);
    expect(diags()[0]!.count).toBe(1);

    // Transition OUT of overload → the diagnostic is removed.
    instance.applyHostUpdate({ labels: { minZoom: 0, maxVisible: 2, showFor: ['n00', 'n01'] } });
    expect(diags()).toHaveLength(0);

    // A NEW transition with a different omission count → one fresh diagnostic.
    instance.applyHostUpdate({
      labels: { minZoom: 0, maxVisible: 1, showFor: ['n00', 'n01', 'n02'] },
    });
    expect(diags()).toHaveLength(1);
    expect(diags()[0]!.count).toBe(2);

    // And that overloaded steady state also stays silent under settles.
    engine.injectSimulationEnd();
    expect(diags()).toHaveLength(1);
    expect(diags()[0]!.count).toBe(2);
  });
});
