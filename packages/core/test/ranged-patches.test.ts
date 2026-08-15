/**
 * Ranged buffer patches apply only to the patch-capable FakeEngine profile:
 * a brush step on a declared channel uploads
 * Δ-proportional patches instead of the full channel, the patched end state
 * is byte-identical to the full-replace twin (oracle), a composer reseed
 * falls back to a full upload, non-capable engines never see patches, and
 * the snapshot reports the declared channels. Ranged upload is NEVER
 * emulated — cosmos keeps `rangeUpdates: []` and full uploads.
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import { normalizeCommitForCapabilities } from '../src/capabilityPolicy';
import type { GraphNode } from '../src/types';
import { container, snap } from './helpers';

const IDS = Array.from({ length: 40 }, (_, i) => `n${i}`);
const EDGES = Array.from({ length: 39 }, (_, i) => [`n${i}`, `n${i + 1}`] as const);
const DATA = snap(1, IDS, EDGES);

async function rig(ranged: boolean) {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance({
    engine: () => {
      const e = new FakeEngine(
        ranged ? { capabilities: { rangeUpdates: ['pointColor', 'linkColor'] } } : {},
      );
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
  });
  await instance.attach(container);
  instance.applyHostUpdate({
    data: DATA,
    crossfilter: [{ key: 'k', kind: 'categorical', get: (n: GraphNode) => n.id }],
  });
  return { instance, engine: engines[0]! };
}

describe('Δ-proportional brush commits', () => {
  it('a brush step patches ONLY the crossed slots — never the full channel', async () => {
    const { instance, engine } = await rig(true);
    const session = instance.getCrossfilterSession()!;

    // First brush: the composer seeds fresh → FULL upload (correctness).
    await session.setBrush('k', { excluded: ['n0'] });
    const first = engine.commits[engine.commits.length - 1]!;
    expect(first.buffers?.pointColor).toBeDefined();
    expect(first.bufferPatches).toBeUndefined();

    // Second brush: incremental step → ranged patches, Δ-proportional.
    await session.setBrush('k', { excluded: ['n0', 'n1'] }); // one node crosses
    const second = engine.commits[engine.commits.length - 1]!;
    expect(second.buffers?.pointColor).toBeUndefined();
    const patches = second.bufferPatches?.pointColor;
    expect(patches).toBeDefined();
    const elements = patches!.reduce((s, p) => s + p.data.length, 0);
    expect(elements).toBeLessThanOrEqual(3 * 4); // ≤ crossed node + touched edges, RGBA
    expect(elements).toBeLessThan(40 * 4); // and certainly not the full channel
    // Edge lane patches too (incident edges of the crossed node).
    expect(second.bufferPatches?.linkColor).toBeDefined();
  });

  it('the patched end state is BYTE-IDENTICAL to the full-replace twin (oracle)', async () => {
    const rangedSide = await rig(true);
    const fullSide = await rig(false);
    const scrub = [['n0'], ['n0', 'n5'], ['n5'], ['n5', 'n9', 'n20'], ['n9']];
    for (const excluded of scrub) {
      await rangedSide.instance.getCrossfilterSession()!.setBrush('k', { excluded });
      await fullSide.instance.getCrossfilterSession()!.setBrush('k', { excluded });
    }
    for (const channel of ['pointColor', 'linkColor'] as const) {
      const patched = rangedSide.engine.lastBuffer(channel)!;
      const replaced = fullSide.engine.lastBuffer(channel)!;
      expect(patched.length).toBe(replaced.length);
      expect(
        Buffer.compare(
          Buffer.from(patched.buffer, patched.byteOffset, patched.byteLength),
          Buffer.from(replaced.buffer, replaced.byteOffset, replaced.byteLength),
        ),
      ).toBe(0);
    }
  });

  it('a mid-scrub reseed (theme change) falls back to ONE full upload, then patches again', async () => {
    const { instance, engine } = await rig(true);
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('k', { excluded: ['n0'] }); // seed
    await session.setBrush('k', { excluded: ['n1'] }); // patches

    instance.applyHostUpdate({ theme: { base: 'light' } }); // mutedAlpha may move; base ref swaps

    await session.setBrush('k', { excluded: ['n2'] });
    const afterTheme = engine.commits[engine.commits.length - 1]!;
    expect(afterTheme.buffers?.pointColor).toBeDefined(); // reseed → full
    expect(afterTheme.bufferPatches?.pointColor).toBeUndefined();

    await session.setBrush('k', { excluded: ['n3'] });
    const next = engine.commits[engine.commits.length - 1]!;
    expect(next.bufferPatches?.pointColor).toBeDefined(); // re-armed
  });

  it('a NON-capable engine (cosmos profile) receives full buffers, never patches', async () => {
    const { instance, engine } = await rig(false);
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('k', { excluded: ['n0'] });
    await session.setBrush('k', { excluded: ['n1'] });
    for (const c of engine.commits) expect(c.bufferPatches).toBeUndefined();
    expect(instance.getPerfSnapshot().rangeUpdates).toEqual([]);
  });

  it('the snapshot reports the DECLARED ranged channels', async () => {
    const { instance } = await rig(true);
    expect([...instance.getPerfSnapshot().rangeUpdates].sort()).toEqual([
      'linkColor',
      'pointColor',
    ]);
  });
});

describe('discipline tripwires', () => {
  it('normalizeCommitForCapabilities strips UNDECLARED patch channels loudly', () => {
    const { commit, dropped } = normalizeCommitForCapabilities(
      {
        revision: 1,
        bufferPatches: { pointColor: [{ start: 0, data: Float32Array.of(1, 1, 1, 1) }] },
      },
      {
        linkPicking: false,
        rangeUpdates: [],
        trackedPositions: false,
        simulation: true,
      },
    );
    expect(dropped).toEqual(['bufferPatches.pointColor']);
    expect(commit.bufferPatches).toBeUndefined();
  });

  it('FakeEngine throws on undeclared, unseeded, or double-lane patches', () => {
    const declared = new FakeEngine({ capabilities: { rangeUpdates: ['pointColor'] } });
    const patch = { start: 0, data: Float32Array.of(1, 1, 1, 1) };

    // Unseeded: patches before any full upload.
    expect(() =>
      declared.commit({ revision: 1, bufferPatches: { pointColor: [patch] } }),
    ).toThrow(/before any full upload/);

    declared.commit({ revision: 2, buffers: { pointColor: new Float32Array(8) } });
    // Both lanes for one channel in one commit.
    expect(() =>
      declared.commit({
        revision: 3,
        buffers: { pointColor: new Float32Array(8) },
        bufferPatches: { pointColor: [patch] },
      }),
    ).toThrow(/BOTH/);

    // Undeclared channel.
    const bare = new FakeEngine();
    expect(() =>
      bare.commit({ revision: 1, bufferPatches: { pointColor: [patch] } }),
    ).toThrow(/without the declared capability/);
  });

  it('lastBuffer replays patches over the newest full upload', () => {
    const engine = new FakeEngine({ capabilities: { rangeUpdates: ['pointColor'] } });
    engine.commit({ revision: 1, buffers: { pointColor: Float32Array.of(1, 2, 3, 4, 5, 6, 7, 8) } });
    engine.commit({
      revision: 2,
      bufferPatches: { pointColor: [{ start: 4, data: Float32Array.of(9, 9, 9, 9) }] },
    });
    expect([...engine.lastBuffer('pointColor')!]).toEqual([1, 2, 3, 4, 9, 9, 9, 9]);
  });
});
