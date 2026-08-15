/**
 * ladder step effects through the real instance: count
 * engagement over custom limits (D7 read-once), the batch-histograms
 * notification coalescing, defer-link-picking's rest-only arming, the
 * cap-dom-labels k clamp, and the frame-pressure trigger end to end.
 * Resource-step engagement (disable-transitions/defer-images) is driven by
 * admission, which lands with the worker lane — the controller
 * unit suite pins those transitions; here only their effects have seams.
 */

import { describe, expect, it, vi } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { CreateGraphInstanceOptions } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type { DegradeEvent, GraphNode } from '../src/types';
import { container, snap } from './helpers';

async function rig(limits?: CreateGraphInstanceOptions['limits']) {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
    ...(limits !== undefined ? { limits } : {}),
  });
  await instance.attach(container);
  return { instance, engine: engines[0]! };
}

const CHAIN = snap(1, ['a', 'b', 'c', 'd'], [
  ['a', 'b'],
  ['b', 'c'],
  ['c', 'd'],
]);

describe('count triggers through the instance', () => {
  it('engages cap-dom-labels above a custom domLabelNodes limit with a degrade event', async () => {
    const { instance } = await rig({ domLabelNodes: 2, minimumDwellMs: 0 });
    const events: DegradeEvent[] = [];
    instance.on('degrade', (e) => events.push(e));

    instance.applyHostUpdate({ data: CHAIN }); // 4 visible nodes > 2
    expect(events).toContainEqual(
      expect.objectContaining({ step: 'cap-dom-labels', engaged: true, reason: 'count' }),
    );
    expect(instance.getPerfSnapshot().activeDegradations).toContain('cap-dom-labels');

    // Disengage below the hysteresis band (2 × 0.9 = 1.8 → 1 node passes).
    instance.hideNodes(['b', 'c', 'd']);
    expect(events).toContainEqual(
      expect.objectContaining({ step: 'cap-dom-labels', engaged: false }),
    );
  });

  it('caps the label k at the BUDGET while engaged', async () => {
    const { instance } = await rig({ domLabelNodes: 2, minimumDwellMs: 0 });
    const nodes = Array.from({ length: 80 }, (_, i) => `n${i}`);
    instance.applyHostUpdate({
      data: snap(1, nodes, [['n0', 'n1']]),
      labels: { enabled: true, maxVisible: 1024, minZoom: 0 },
    });
    let seen: number = Infinity;
    const unsub = instance.labels.subscribeCandidates((c) => {
      seen = c.length;
    });
    // 80 nodes, host asked for 1024 — the engaged cap holds it at the
    // default budget (64).
    expect(seen).toBeLessThanOrEqual(64);
    unsub();
  });
});

describe('batch-histograms coalescing', () => {
  it('notifications coalesce to ONE flush per engine frame while engaged', async () => {
    const { instance, engine } = await rig({ histogramBatchNodes: 2, minimumDwellMs: 0 });
    instance.applyHostUpdate({
      data: CHAIN,
      crossfilter: [
        { key: 'k', kind: 'categorical', get: (n: GraphNode) => n.id },
      ],
    });
    expect(instance.getPerfSnapshot().activeDegradations).toContain('batch-histograms');

    const session = instance.getCrossfilterSession()!;
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });

    await session.setBrush('k', { excluded: ['a'] });
    await session.setBrush('k', { excluded: ['a', 'b'] });
    await session.setBrush('k', { excluded: ['b'] });
    expect(notifications).toBe(0); // coalesced — nothing until a frame

    engine.emitFrame();
    expect(notifications).toBe(1); // one batch per frame

    engine.emitFrame();
    expect(notifications).toBe(1); // nothing pending → nothing delivered
  });

  it('delivers synchronously when NOT engaged (the pre-ladder contract)', async () => {
    const { instance } = await rig();
    instance.applyHostUpdate({
      data: CHAIN,
      crossfilter: [{ key: 'k', kind: 'categorical', get: (n: GraphNode) => n.id }],
    });
    const session = instance.getCrossfilterSession()!;
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });
    await session.setBrush('k', { excluded: ['a'] });
    expect(notifications).toBe(1);
  });
});

describe('defer-link-picking', () => {
  it('drops edge hover while the sim is hot; re-arms at rest', async () => {
    const { instance, engine } = await rig({ pickingLinks: 1, minimumDwellMs: 0 });
    const hovers: unknown[] = [];
    instance.on('edgeHover', (p) => hovers.push(p));

    instance.applyHostUpdate({ data: CHAIN }); // 3 edges > 1 → engaged
    expect(instance.getPerfSnapshot().activeDegradations).toContain('defer-link-picking');
    expect(instance.store.getState().simulationRunning).toBe(true); // restart commit

    engine.injectLinkHover(0);
    expect(hovers).toHaveLength(0); // dropped mid-simulation

    engine.injectSimulationEnd();
    engine.injectLinkHover(0);
    expect(hovers).toHaveLength(1); // armed at rest
  });
});

describe('defer-link-picking edge cases', () => {
  it('the CLEARING null passes while engaged mid-simulation — no stale hover', async () => {
    const { instance, engine } = await rig({ pickingLinks: 1, minimumDwellMs: 0 });
    const hovers: Array<{ edge: unknown }> = [];
    instance.on('edgeHover', (p) => hovers.push(p));

    instance.applyHostUpdate({ data: CHAIN });
    engine.injectSimulationEnd(); // at rest: hover arms
    engine.injectLinkHover(0);
    expect(instance.store.getState().hover.edgeId).not.toBeNull();

    // The sim reheats with the hover live; the pointer then LEAVES.
    instance.resumeSimulation();
    expect(instance.store.getState().simulationRunning).toBe(true);
    engine.injectLinkHover(null);
    expect(instance.store.getState().hover.edgeId).toBeNull(); // cleared, not stale
  });

  it('coalescing delivers SYNCHRONOUSLY while detached — no starvation', async () => {
    const { instance } = await rig({ histogramBatchNodes: 2, minimumDwellMs: 0 });
    instance.applyHostUpdate({
      data: CHAIN,
      crossfilter: [{ key: 'k', kind: 'categorical', get: (n: GraphNode) => n.id }],
    });
    expect(instance.getPerfSnapshot().activeDegradations).toContain('batch-histograms');
    const session = instance.getCrossfilterSession()!;
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });

    instance.detach(); // no engine → no frames → deferral would starve
    await session.setBrush('k', { excluded: ['a'] });
    expect(notifications).toBe(1); // delivered synchronously
  });
});

describe('DEFAULT thresholds straddle when limits are omitted', () => {
  it('100,001 visible nodes engages cap-dom-labels; 100,000 does not', async () => {
    const ids = Array.from({ length: 100_001 }, (_, i) => `n${i}`);
    const { instance } = await rig(); // NO limits → spec defaults
    const events: DegradeEvent[] = [];
    instance.on('degrade', (e) => events.push(e));

    instance.applyHostUpdate({ data: snap(1, ids, []) });
    expect(events).toContainEqual(
      expect.objectContaining({ step: 'cap-dom-labels', engaged: true, reason: 'count' }),
    );
    expect(events.some((e) => e.step === 'batch-histograms')).toBe(false); // < 500K

    const { instance: at } = await rig();
    const atEvents: DegradeEvent[] = [];
    at.on('degrade', (e) => atEvents.push(e));
    at.applyHostUpdate({ data: snap(1, ids.slice(0, 100_000), []) });
    expect(atEvents).toEqual([]); // exactly at the limit — not over
  });
});

describe('frame-pressure trigger', () => {
  it('sustained slow frames engage the cheap steps with reason frame-pressure', async () => {
    vi.useFakeTimers();
    try {
      const { instance, engine } = await rig({ minimumDwellMs: 0 });
      instance.applyHostUpdate({ data: CHAIN });
      const events: DegradeEvent[] = [];
      instance.on('degrade', (e) => events.push(e));

      // 60ms deltas: every 250ms window closes with a 60ms mean → EWMA well
      // past the 40ms engage bound; the trigger evaluates on the ≥1s
      // sample cadence.
      for (let t = 0; t <= 2_200; t += 60) engine.emitFrame(t);

      expect(events).toContainEqual(
        expect.objectContaining({
          step: 'cap-dom-labels',
          engaged: true,
          reason: 'frame-pressure',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ step: 'defer-link-picking', reason: 'frame-pressure' }),
      );

      // Recovery: fast frames pull the EWMA under the clear bound.
      for (let t = 2_260; t <= 8_000; t += 10) engine.emitFrame(t);
      expect(events).toContainEqual(
        expect.objectContaining({ step: 'cap-dom-labels', engaged: false }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
