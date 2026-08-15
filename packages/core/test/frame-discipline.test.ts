/**
 * frame discipline, the deterministic half (FakeEngine; the
 * in-browser half rides scripts/perf-lite.mjs + apps/demo/e2e/quiescence):
 * upload bytes match the dirty channel set per update class, selection stays
 * off the commit lane, and the getPositions per-event ledger holds
 * (zero at rest, zero per brush step, ≥500ms throttle sim-hot, one per
 * settle).
 */

import { describe, expect, it } from 'vitest';

import type { GraphNode } from '../src/types';
import { container, makeInstance, snap } from './helpers';

const CHAIN = snap(1, ['a', 'b', 'c', 'd'], [
  ['a', 'b'],
  ['b', 'c'],
  ['c', 'd'],
]);

async function rig() {
  const h = makeInstance({ fitViewOnFirstData: false });
  await h.instance.attach(container);
  h.instance.applyHostUpdate({
    data: CHAIN,
    crossfilter: [{ key: 'k', kind: 'categorical', get: (n: GraphNode) => n.id }],
  });
  return { ...h, engine: h.engines[0]! };
}

const positionReads = (engine: { calls: readonly { method: string }[] }) =>
  engine.calls.filter((c) => c.method === 'getPositions').length;

describe('upload bytes == dirty channel set', () => {
  it('a mask-only publish commits EXACTLY the alpha channels — no structure, no restart', async () => {
    const { instance, engine } = await rig();
    const before = engine.commits.length;

    await instance.getCrossfilterSession()!.setBrush('k', { excluded: ['a'] });

    expect(engine.commits.length).toBe(before + 1);
    const commit = engine.commits[engine.commits.length - 1]!;
    expect(commit.structure).toBeUndefined();
    expect(commit.restart).toBeUndefined();
    expect(commit.config).toBeUndefined();
    const channels = Object.keys(commit.buffers ?? {}).sort();
    expect(channels).toEqual(['linkColor', 'pointColor']);
    // RGBA floats: 4 per node / per link — the byte accounting that catches
    // an accidental full-channel or wrong-cardinality upload.
    expect(commit.buffers!.pointColor!.length).toBe(4 * 4);
    expect(commit.buffers!.linkColor!.length).toBe(3 * 4);
  });

  it('a 10-step scrub stays one alpha-only commit per step (no structure ever)', async () => {
    const { instance, engine } = await rig();
    const session = instance.getCrossfilterSession()!;
    const ids = ['a', 'b', 'c', 'd'];
    const before = engine.commits.length;

    for (let i = 0; i < 10; i += 1) {
      await session.setBrush('k', { excluded: [ids[i % 4]!] });
    }

    const scrubCommits = engine.commits.slice(before);
    expect(scrubCommits.length).toBe(10);
    for (const c of scrubCommits) {
      expect(c.structure).toBeUndefined();
      expect(c.restart).toBeUndefined();
      const channels = Object.keys(c.buffers ?? {}).sort();
      expect(channels).toEqual(['linkColor', 'pointColor']);
    }
  });

  it('a config-class update (theme) carries config only — zero buffers, zero structure', async () => {
    const { instance, engine } = await rig();
    const before = engine.commits.length;

    instance.applyHostUpdate({ theme: { base: 'light' } });

    expect(engine.commits.length).toBe(before + 1);
    const commit = engine.commits[engine.commits.length - 1]!;
    expect(commit.config).toBeDefined();
    expect(commit.buffers).toBeUndefined();
    expect(commit.structure).toBeUndefined();
  });

  it('a data replace is ONE commit carrying structure and channels together (never split)', async () => {
    const { instance, engine } = await rig();
    const before = engine.commits.length;

    instance.applyHostUpdate({
      data: snap(2, ['x', 'y'], [['x', 'y']]),
      nodeColor: 'red',
      linkColor: 'blue',
    });

    expect(engine.commits.length).toBe(before + 1);
    const commit = engine.commits[engine.commits.length - 1]!;
    expect(commit.structure).toBeDefined();
    expect(commit.buffers).toBeDefined();
  });

  it('selection rides the highlight lane — zero commits', async () => {
    const { instance, engine } = await rig();
    const before = engine.commits.length;

    instance.applyHostUpdate({ selection: ['b', 'c'] });

    expect(engine.commits.length).toBe(before);
    expect(engine.calls.some((c) => c.method === 'setSelectedIndices')).toBe(true);
  });
});

describe('getPositions per-event ledger', () => {
  it('frames at rest read back NOTHING', async () => {
    const { instance, engine } = await rig();
    engine.injectSimulationEnd(); // settle (this banks once — baseline after)
    const before = positionReads(engine);

    for (let t = 0; t <= 320; t += 16) engine.emitFrame(t);

    expect(positionReads(engine)).toBe(before);
    expect(instance.store.getState().simulationRunning).toBe(false);
  });

  it('a brush scrub never reads positions back', async () => {
    const { instance, engine } = await rig();
    const session = instance.getCrossfilterSession()!;
    const before = positionReads(engine);

    for (const id of ['a', 'b', 'a', 'b']) {
      await session.setBrush('k', { excluded: [id] });
    }

    expect(positionReads(engine)).toBe(before);
  });

  it('sim-hot label refresh reads back at MOST once per 500ms window — never per frame', async () => {
    const { instance, engine } = await rig();
    instance.applyHostUpdate({ labels: { enabled: true, maxVisible: 8, minZoom: 0 } });
    expect(instance.store.getState().simulationRunning).toBe(true);
    const before = positionReads(engine);

    // 31 frames inside the first 480ms: exactly ONE readback (D4 throttle).
    for (let t = 0; t <= 480; t += 16) engine.emitFrame(t);
    expect(positionReads(engine)).toBe(before + 1);

    // Crossing the 500ms boundary grants exactly one more.
    engine.emitFrame(520);
    expect(positionReads(engine)).toBe(before + 2);
  });

  it('settle is one readback (bank + picking re-arm), not a scan per event after', async () => {
    const { engine } = await rig();
    const before = positionReads(engine);

    engine.injectSimulationEnd();
    expect(positionReads(engine)).toBe(before + 1);

    // Post-settle interaction events do not re-read.
    engine.injectPointHover(1);
    engine.injectPointClick(2, { metaKey: false, shiftKey: false });
    expect(positionReads(engine)).toBe(before + 1);
  });
});
