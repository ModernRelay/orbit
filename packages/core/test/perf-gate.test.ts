/**
 * perf-harness-lite — the CI-SAFE half (the deterministic pre-gate).
 *
 * Operation-count + commit-shape invariants through the REAL instance over
 * FakeEngine at S tier (10K nodes / 25K edges, seeded/deterministic):
 *
 * - a filter application evaluates each node's predicate EXACTLY once (no
 * quadratic blowup) and lands as ONE buffers-only commit;
 * - a crossfilter brush move after an initial brush is ONE buffers-only
 * commit (mask fast path, O(Δ) — never a rebuild);
 * - a 60-step brush scrub is 60 commits, zero structure commits, zero
 * restarts.
 *
 * The REAL assertions are these invariants. The wall-clock bounds are a
 * generous SMOKE CEILING against pathological regressions on slow CI runners
 * — they are NOT the release gates (S first-paint p95, L active-frame
 * p95). Real-GPU latency measurement is local-only (.evidence/) and is
 * produced locally by scripts/perf-lite.mjs, never on CI.
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type { GraphNode, GraphSnapshot } from '../src/types';
import { container } from './helpers';

const S_NODES = 10_000;
const S_EDGES = 25_000;

type NA = { v: number };
type EA = Record<string, never>;

/** Classic mulberry32 — local copy so the fixture is self-contained. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded S-tier snapshot: 10K nodes (v uniform in [0,100)), 25K edges with
 * distinct endpoints (no self-loop diagnostics muddying the run). */
function sTierSnapshot(): GraphSnapshot<NA, EA> {
  const rng = mulberry32(0xdef1);
  const nodes: GraphNode<NA>[] = new Array(S_NODES);
  for (let i = 0; i < S_NODES; i++) {
    nodes[i] = { id: `n${i}`, attrs: { v: rng() * 100 } };
  }
  const edges = new Array<{ source: string; target: string }>(S_EDGES);
  for (let e = 0; e < S_EDGES; e++) {
    const a = Math.floor(rng() * S_NODES);
    const b = (a + 1 + Math.floor(rng() * (S_NODES - 1))) % S_NODES;
    edges[e] = { source: `n${a}`, target: `n${b}` };
  }
  return { datasetKey: 'perf-s', sourceRevision: 1, nodes, edges };
}

async function readyRig(): Promise<{ instance: GraphInstance<NA, EA>; engine: FakeEngine }> {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NA, EA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
  });
  await instance.attach(container);
  instance.applyHostUpdate({ data: sTierSnapshot(), nodeColor: 'red', linkColor: 'blue' });
  return { instance, engine: engines[0]! };
}

describe('perf gate — S tier through the real instance', () => {
  it('(a) filter apply: each node evaluated exactly once, ONE buffers-only commit', async () => {
    const { instance, engine } = await readyRig();

    let evaluations = 0;
    const pred = (node: GraphNode<NA>): boolean => {
      evaluations += 1;
      return (node.attrs?.v ?? 0) < 50;
    };

    const commitsBefore = engine.commits.length;
    const started = performance.now();
    instance.applyHostUpdate({ filter: { nodes: pred, mode: 'hide' } });
    const elapsedMs = performance.now() - started;

    // Op count: the predicate ran once per node — linear, never quadratic.
    expect(evaluations).toBe(S_NODES);

    // Exactly ONE commit, buffers-only: no structure, no restart.
    expect(engine.commits.length).toBe(commitsBefore + 1);
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeUndefined();
    expect(commit.restart).toBeUndefined();
    expect(commit.buffers?.pointColor).toBeDefined();

    // The mask actually took effect (roughly half the uniform draw passes).
    const visible = instance.store.getState().visible.nodes;
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(S_NODES);
    expect(instance.store.getState().nodeCount).toBe(S_NODES); // model untouched

    // Smoke ceiling only (generous for CI) — not the gate.
    expect(elapsedMs).toBeLessThan(250);
  });

  it('(b) small brush move after an initial brush: ONE buffers-only commit', async () => {
    const { instance, engine } = await readyRig();
    instance.applyHostUpdate({
      crossfilter: [{ key: 'v', kind: 'numeric', bins: 30, get: (n: GraphNode<NA>) => n.attrs?.v }],
    });
    const session = instance.getCrossfilterSession();
    expect(session).not.toBeNull();

    await session!.setBrush('v', { min: 20, max: 60 });

    const commitsBefore = engine.commits.length;
    const started = performance.now();
    await session!.setBrush('v', { min: 21, max: 61 }); // small move — O(Δ) walk
    const elapsedMs = performance.now() - started;

    expect(engine.commits.length).toBe(commitsBefore + 1);
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeUndefined();
    expect(commit.restart).toBeUndefined();
    expect(commit.buffers?.pointColor).toBeDefined();

    // Smoke ceiling only — the O(Δ) claim is carried by the commit shape and
    // the crossfilter unit suite's operation counters, not this number.
    expect(elapsedMs).toBeLessThan(50);
  });

  it('(c) 60-step brush scrub: 60 commits, zero structure, zero restarts', async () => {
    const { instance, engine } = await readyRig();
    instance.applyHostUpdate({
      crossfilter: [{ key: 'v', kind: 'numeric', bins: 30, get: (n: GraphNode<NA>) => n.attrs?.v }],
    });
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 0, max: 40 });

    const commitsBefore = engine.commits.length;
    const started = performance.now();
    for (let step = 1; step <= 60; step++) {
      // A steady scrub: the window slides right by half a unit per step.
      await session.setBrush('v', { min: step * 0.5, max: 40 + step * 0.5 });
    }
    const elapsedMs = performance.now() - started;

    const scrubCommits = engine.commits.slice(commitsBefore);
    expect(scrubCommits.length).toBe(60); // one commit per observable brush step
    expect(scrubCommits.filter((c) => c.structure !== undefined).length).toBe(0);
    expect(scrubCommits.filter((c) => c.restart !== undefined && c.restart !== false).length).toBe(
      0,
    );

    // Smoke ceiling: generous CI headroom; the invariants above are the gate.
    expect(elapsedMs).toBeLessThan(1_500);
  });
});
