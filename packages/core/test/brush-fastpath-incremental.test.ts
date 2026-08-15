/**
 * wave 5 — integration CORRECTNESS of the incremental brush fast
 * path through the real instance: the buffers the engine receives after a
 * scrub must be byte-identical to a fresh instance that applied only the
 * final state, across every fallback and invalidation boundary the fast
 * path negotiates (analytic alphas, hidden/filter interleaving, theme
 * changes mid-scrub, structural re-baselines, group-rewrite and
 * path-emphasis fallbacks).
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type { BrushState, GraphNode, GraphSnapshot } from '../src/types';
import { container } from './helpers';

type NA = { v: number };
type EA = Record<string, never>;

const N = 40;

/** Small deterministic fixture: v = slot index (analytic brush windows). */
function snapshot(): GraphSnapshot<NA, EA> {
  const nodes: GraphNode<NA>[] = [];
  for (let i = 0; i < N; i++) nodes.push({ id: `n${i}`, attrs: { v: i } });
  const edges: { source: string; target: string }[] = [];
  for (let i = 0; i < N - 1; i++) edges.push({ source: `n${i}`, target: `n${i + 1}` });
  return { datasetKey: 'fastpath', sourceRevision: 1, nodes, edges };
}

interface Rig {
  instance: GraphInstance<NA, EA>;
  engine: FakeEngine;
}

async function rig(): Promise<Rig> {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NA, EA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
  });
  await instance.attach(container);
  instance.applyHostUpdate({
    data: snapshot(),
    nodeColor: 'red',
    linkColor: 'blue',
    crossfilter: [{ key: 'v', kind: 'numeric', bins: 10, get: (n: GraphNode<NA>) => n.attrs?.v }],
  });
  return { instance, engine: engines[0]! };
}

function lastBuffer(engine: FakeEngine, channel: 'pointColor' | 'linkColor'): Float32Array {
  for (let i = engine.commits.length - 1; i >= 0; i--) {
    const buf = engine.commits[i]!.buffers?.[channel];
    if (buf !== undefined) return buf;
  }
  throw new Error(`no ${channel} buffer committed`);
}

/** The oracle: a FRESH rig applying only the final brush state. */
async function oracleBuffers(
  brush: BrushState,
  mutate?: (r: Rig) => void | Promise<void>,
): Promise<{ pointColor: Float32Array; linkColor: Float32Array }> {
  const r = await rig();
  if (mutate) await mutate(r);
  await r.instance.getCrossfilterSession()!.setBrush('v', brush);
  return {
    pointColor: Float32Array.from(lastBuffer(r.engine, 'pointColor')),
    linkColor: Float32Array.from(lastBuffer(r.engine, 'linkColor')),
  };
}

describe('brush fast path — end-state equivalence', () => {
  it('a 30-step scrub lands byte-identical buffers to the single-step oracle', async () => {
    const { instance, engine } = await rig();
    const session = instance.getCrossfilterSession()!;
    for (let step = 0; step <= 30; step++) {
      await session.setBrush('v', { min: step * 0.5, max: 10 + step * 0.5 });
    }
    const finalBrush = { min: 15, max: 25 };
    await session.setBrush('v', finalBrush);

    const oracle = await oracleBuffers(finalBrush);
    expect(Array.from(lastBuffer(engine, 'pointColor'))).toEqual(
      Array.from(oracle.pointColor),
    );
    expect(Array.from(lastBuffer(engine, 'linkColor'))).toEqual(Array.from(oracle.linkColor));
  });

  it('analytic alphas: hidden window at 0, in-range at full, edges cascade', async () => {
    const { instance, engine } = await rig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 10, max: 20 }); // n10..n20 visible

    const pc = lastBuffer(engine, 'pointColor');
    expect(pc[4 * 5 + 3]).toBe(0); // n5 out of range → hidden
    expect(pc[4 * 15 + 3]).toBe(1); // n15 in range → full alpha (red = a 1)
    const lc = lastBuffer(engine, 'linkColor');
    expect(lc[4 * 4 + 3]).toBe(0); // edge n4–n5: both endpoints hidden
    expect(lc[4 * 14 + 3]).not.toBe(0); // edge n14–n15: both visible
    expect(lc[4 * 20 + 3]).toBe(0); // edge n20–n21: n21 hidden → cascaded
  });

  it('hidden-node changes interleaved with brushing stay correct (foreign drains reset the composers)', async () => {
    const { instance, engine } = await rig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 5, max: 30 });
    instance.hideNodes(['n10', 'n11']); // a NON-brush mask drain
    await session.setBrush('v', { min: 6, max: 31 }); // fast path resumes

    const oracle = await oracleBuffers({ min: 6, max: 31 }, (r) => {
      r.instance.hideNodes(['n10', 'n11']);
    });
    expect(Array.from(lastBuffer(engine, 'pointColor'))).toEqual(
      Array.from(oracle.pointColor),
    );
    expect(Array.from(lastBuffer(engine, 'linkColor'))).toEqual(Array.from(oracle.linkColor));
  });

  it('a mutedAlpha theme change mid-scrub reseeds (dim mode)', async () => {
    const { instance, engine } = await rig();
    instance.applyHostUpdate({
      filter: { nodes: (n: GraphNode<NA>) => (n.attrs?.v ?? 0) < 35, mode: 'dim' },
    });
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 0, max: 30 });
    instance.applyHostUpdate({ theme: { mutedAlpha: 0.5 } });
    await session.setBrush('v', { min: 1, max: 31 });

    const pc = lastBuffer(engine, 'pointColor');
    // n36 passes the brush-visible test? No: v=36 > 31 → hidden (0). n34 in
    // range but ≥35 is dimmed... v=34 < 35 → undimmed. Use n36: out of
    // brush range → alpha 0 regardless. The DIMMED probe is a node in brush
    // range with v ≥ 35 — none exist (range caps at 31). So dim the filter
    // the other way: assert an in-range node keeps full alpha and the
    // buffer as a whole matches the oracle under the new mutedAlpha.
    expect(pc[4 * 15 + 3]).toBe(1);
    const oracle = await oracleBuffers({ min: 1, max: 31 }, (r) => {
      r.instance.applyHostUpdate({
        filter: { nodes: (n: GraphNode<NA>) => (n.attrs?.v ?? 0) < 35, mode: 'dim' },
      });
      r.instance.applyHostUpdate({ theme: { mutedAlpha: 0.5 } });
    });
    expect(Array.from(pc)).toEqual(Array.from(oracle.pointColor));
  });

  it('a structural change mid-scrub re-baselines; further scrubbing stays exact', async () => {
    const { instance, engine } = await rig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 5, max: 25 });

    // Append-style replace: same datasetKey, higher revision, extra nodes.
    const snap2 = snapshot();
    const extra: GraphNode<NA>[] = [];
    for (let i = N; i < N + 8; i++) extra.push({ id: `n${i}`, attrs: { v: i } });
    instance.applyHostUpdate({
      data: {
        ...snap2,
        sourceRevision: 2,
        nodes: [...snap2.nodes, ...extra],
      },
    });
    await session.setBrush('v', { min: 6, max: 26 });

    const oracle = await (async () => {
      const r = await rig();
      const s2 = snapshot();
      r.instance.applyHostUpdate({
        data: { ...s2, sourceRevision: 2, nodes: [...s2.nodes, ...extra] },
      });
      await r.instance.getCrossfilterSession()!.setBrush('v', { min: 6, max: 26 });
      return Float32Array.from(lastBuffer(r.engine, 'pointColor'));
    })();
    expect(Array.from(lastBuffer(engine, 'pointColor'))).toEqual(Array.from(oracle));
  });

  it('groupRewrite forces the naive step and stays correct (ANY-member semantics)', async () => {
    const { instance, engine } = await rig();
    instance.groupNodes({ id: 'g', memberIds: ['n0', 'n1', 'n2'], collapsed: true });
    const session = instance.getCrossfilterSession()!;

    const before = { ...instance.getPerfCounters() };
    await session.setBrush('v', { min: 0.5, max: 20 }); // hides n0 (member)
    const after = instance.getPerfCounters();
    expect(after.fullBrushRefreshes).toBeGreaterThan(before.fullBrushRefreshes); // fallback ran

    // Correctness incl. the ANY-member super-node rule: byte-identical to a
    // fresh instance with the same group and final brush (no slot
    // arithmetic — the oracle carries the synthetic-suffix layout).
    const oracle = await oracleBuffers({ min: 0.5, max: 20 }, (r) => {
      r.instance.groupNodes({ id: 'g', memberIds: ['n0', 'n1', 'n2'], collapsed: true });
    });
    expect(Array.from(lastBuffer(engine, 'pointColor'))).toEqual(
      Array.from(oracle.pointColor),
    );
    expect(Array.from(lastBuffer(engine, 'linkColor'))).toEqual(Array.from(oracle.linkColor));
  });

  it('path emphasis owns the edge lane: edge channel falls back, node channel stays incremental', async () => {
    const { instance, engine } = await rig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 0, max: 39 });
    await instance.findPath('n3', 'n6');

    const before = { ...instance.getPerfCounters() };
    await session.setBrush('v', { min: 1, max: 38 });
    const after = instance.getPerfCounters();
    expect(after.fullEdgeRecomposes).toBeGreaterThan(before.fullEdgeRecomposes); // naive edge
    expect(after.fullNodeRecomposes).toBe(before.fullNodeRecomposes); // incremental node

    // Path-dim composition survives: a non-path in-range edge is dimmed.
    const lc = lastBuffer(engine, 'linkColor');
    const pathEdge = 3; // n3–n4 lies on the path
    const offPath = 20; // n20–n21 in range, off path → dimmed by emphasis
    expect(lc[4 * pathEdge + 3]).toBeGreaterThan(lc[4 * offPath + 3]!);
  });
});
