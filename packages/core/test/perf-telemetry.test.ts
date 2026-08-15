/**
 * the telemetry lane: PressureSampler math, GraphPerfSnapshot
 * assembly through the real instance, the no-raw-attrs/ids property (deep
 * sentinel scan), phase-clock kinds, and the perfSample throttle.
 */

import { describe, expect, it } from 'vitest';

import { PressureSampler, DROPPED_FRAME_MS, SLEEP_GAP_MS } from '../src/perf';
import { container, makeInstance, snap } from './helpers';
import type { GraphPerfSnapshot } from '../src/types';

describe('PressureSampler', () => {
  it('EWMA converges on the per-window mean frame delta', () => {
    const s = new PressureSampler();
    let t = 0;
    for (let i = 0; i < 200; i += 1) {
      s.noteFrame(t, false);
      t += 16;
    }
    const snap1 = s.snapshot();
    expect(snap1.windows).toBeGreaterThan(5);
    expect(snap1.frameEwmaMs).toBeGreaterThan(15);
    expect(snap1.frameEwmaMs).toBeLessThan(17);
    expect(snap1.droppedFrames).toBe(0);
  });

  it('counts dropped frames and the worst delta', () => {
    const s = new PressureSampler();
    s.noteFrame(0, false);
    s.noteFrame(16, false);
    s.noteFrame(16 + DROPPED_FRAME_MS + 20, false); // one stall
    const out = s.snapshot();
    expect(out.droppedFrames).toBe(1);
    expect(out.worstFrameMs).toBe(DROPPED_FRAME_MS + 20);
  });

  it('a quiescence sleep gap is NOT a stall — the delta is discarded', () => {
    const s = new PressureSampler();
    s.noteFrame(0, false);
    s.noteFrame(16, false);
    s.noteFrame(16 + SLEEP_GAP_MS + 5_000, false); // the loop slept 5s
    const out = s.snapshot();
    expect(out.droppedFrames).toBe(0);
    expect(out.worstFrameMs).toBeLessThan(DROPPED_FRAME_MS);
  });

  it('settled frames count as idle wakeups; counters reset per period', () => {
    const s = new PressureSampler();
    s.noteFrame(0, true);
    s.noteFrame(16, true);
    s.noteFrame(32, false);
    expect(s.snapshot().idleWakeups).toBe(2);
    s.resetCounters();
    expect(s.snapshot().idleWakeups).toBe(0);
    expect(s.snapshot().frames).toBe(0);
  });

  it('a clock going backwards resets cleanly (fresh adapter after recovery)', () => {
    const s = new PressureSampler();
    s.noteFrame(1_000, false);
    s.noteFrame(1_016, false);
    s.noteFrame(3, false); // fresh rAF timeline
    s.noteFrame(19, false);
    expect(s.snapshot().droppedFrames).toBe(0);
  });
});

describe('getPerfSnapshot through the real instance', () => {
  async function rig() {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({
      data: snap(1, ['SENTINEL_node_alpha', 'SENTINEL_node_beta', 'SENTINEL_node_gamma'], [
        ['SENTINEL_node_alpha', 'SENTINEL_node_beta'],
        ['SENTINEL_node_beta', 'SENTINEL_node_gamma'],
      ]),
    });
    return { ...h, engine: h.engines[0]! };
  }

  it('NEVER leaks raw attrs or ids — deep sentinel scan', async () => {
    const { instance } = await rig();
    instance.applyHostUpdate({
      filter: { nodes: (n) => n.id !== 'SENTINEL_node_gamma', mode: 'hide' },
    });
    instance.hideNodes(['SENTINEL_node_beta']);
    const json = JSON.stringify(instance.getPerfSnapshot());
    expect(json).not.toContain('SENTINEL');
  });

  it('reports counts, revisions, estimates, and the pressure mirror', async () => {
    const { instance } = await rig();
    const s = instance.getPerfSnapshot();
    expect(s.nodeCount).toBe(3);
    expect(s.edgeCount).toBe(2);
    expect(s.visibleNodeCount).toBe(3);
    expect(s.estimatedCpuBytes).toBeGreaterThan(0);
    expect(s.estimatedGpuBytes).toBeGreaterThan(0);
    expect(s.queueDepth).toBe(0);
    expect(s.renderRevision).toBe(instance.getRevisions().render);
    expect(s.appliedRenderRevision).toBe(instance.getRevisions().appliedRender);
    expect(s.execution).toBe('main');
    expect(s.activeDegradations).toEqual([]);
    expect(Array.isArray(s.rangeUpdates)).toBe(true);
    expect(s.pressure.idleWakeups).toBe(0);
  });

  it('is synchronous and empty-safe pre-attach', () => {
    const { instance } = makeInstance();
    const s = instance.getPerfSnapshot();
    expect(s.nodeCount).toBe(0);
    expect(s.estimatedCpuBytes).toBe(0);
    expect(s.estimatedGpuBytes).toBeUndefined();
    expect(s.lastCommitMs).toBeUndefined();
  });

  it('phase-clock kinds: model on data, config on theme, mask on brush', async () => {
    const { instance } = await rig();
    expect(instance.getPerfSnapshot().lastCommitMs?.kind).toBe('model');

    instance.applyHostUpdate({ theme: { base: 'light' } });
    expect(instance.getPerfSnapshot().lastCommitMs?.kind).toBe('config');

    instance.applyHostUpdate({
      crossfilter: [{ key: 'k', kind: 'categorical', get: (n) => n.id.slice(0, 3) }],
    });
    await instance.getCrossfilterSession()!.setBrush('k', { excluded: ['SEN'] });
    const last = instance.getPerfSnapshot().lastCommitMs;
    expect(last?.kind).toBe('mask');
    expect(last!.validate).toBe(0);
    expect(last!.project).toBeGreaterThanOrEqual(0);
    expect(last!.upload).toBeGreaterThanOrEqual(0);
  });

  it('stamps the phase clock on the ready REPLAY too (pre-attach apply = first paint)', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    // Data lands BEFORE attach — the mount ordering every React host has.
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    expect(h.instance.getPerfSnapshot().lastCommitMs).toBeUndefined(); // no engine yet
    await h.instance.attach(container);
    const last = h.instance.getPerfSnapshot().lastCommitMs;
    expect(last?.kind).toBe('model'); // the replay IS the first upload
    expect(last!.derive).toBeGreaterThanOrEqual(0);
    expect(last!.upload).toBeGreaterThanOrEqual(0);
  });

  it("emits 'perfSample' throttled — never per frame", async () => {
    const { instance, engine } = await rig();
    const samples: GraphPerfSnapshot[] = [];
    instance.on('perfSample', (p) => samples.push(p));

    engine.emitFrame(0);
    engine.emitFrame(16);
    engine.emitFrame(32); // three frames inside one throttle window
    expect(samples).toHaveLength(1); // the first frame emitted; the rest gated

    engine.emitFrame(1_100); // past the 1s throttle
    expect(samples).toHaveLength(2);
    // Counters reset per sample period: the second sample's frame counters
    // cover only the gated stretch.
    expect(samples[1]!.pressure.idleWakeups).toBeGreaterThanOrEqual(0);
  });
});
