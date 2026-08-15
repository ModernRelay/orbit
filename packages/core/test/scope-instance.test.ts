/**
 * hard subgraph scope wired into the instance.
 *
 * Covers: subset-only structure commits with cached positions, the first
 * genuine scope/model revision split (scope-only changes advance scope +
 * render, never model), reflow vs reflow:false restart gating, the
 * isolateSelection/resetIsolation round trip restoring the full base
 * byte-identically through identity-preserving reconciliation, interaction-slice
 * survival across scope changes (departed-id pruning applies only to
 * accepted-BASE changes), and label-candidate re-ranks on scope changes.
 */

import { describe, expect, it } from 'vitest';

import type { GraphInstance } from '../src/instance';
import type { FakeEngine } from '../src/testing/index';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Instance = GraphInstance<NAttrs, EAttrs>;

/** a—b—c—d chain; FakeEngine seeds a(0,0) b(10,0) c(20,0) d(30,0). */
const CHAIN_IDS = ['a', 'b', 'c', 'd'] as const;
const CHAIN_LINKS: ReadonlyArray<readonly [string, string]> = [
  ['a', 'b'],
  ['b', 'c'],
  ['c', 'd'],
];

async function readyChain(layout: 'force' | 'fixed' = 'force') {
  const h = makeInstance({ fitViewOnFirstData: false });
  await h.instance.attach(container);
  h.instance.applyHostUpdate({ data: snap(1, [...CHAIN_IDS], CHAIN_LINKS), layout });
  return { ...h, engine: h.engines[0]! };
}

/** Engine-visible position of a node id (null when unknown). */
function posOf(engine: FakeEngine, instance: Instance, id: string): readonly [number, number] | null {
  const idx = instance.getVisibleNodeIds().indexOf(id);
  if (idx === -1) return null;
  const pos = engine.getPositions();
  if (pos === null) return null;
  return [pos[2 * idx]!, pos[2 * idx + 1]!];
}

describe('hard scope: subset-only structure', () => {
  it('feeds ONLY the resolved subset through the reconciler with cached positions', async () => {
    const { instance, engine } = await readyChain();
    const a0 = posOf(engine, instance, 'a')!;
    const b0 = posOf(engine, instance, 'b')!;

    instance.applyHostUpdate({ subgraph: { seedIds: ['b', 'a'] } });

    const commit = engine.lastCommit!;
    expect(commit.structure).toBeDefined();
    // Subset-only: 2 points, the single surviving a—b edge (cascade: an edge
    // survives iff BOTH endpoints survive), accepted-base order.
    expect(commit.structure!.pointCount).toBe(2);
    expect(Array.from(commit.structure!.links)).toEqual([0, 1]);
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    // Positions come from the cache (banked from the live engine).
    expect(Array.from(commit.structure!.positions)).toEqual([...a0, ...b0]);
    // The scope is published on the store; counts stay MODEL counts.
    expect(instance.store.getState().scope).toEqual({ seedIds: ['b', 'a'] });
    expect(instance.store.getState().nodeCount).toBe(4);
    expect(instance.store.getState().edgeCount).toBe(3);
  });

  it('expands hops over the accepted-base adjacency (lazy cache path)', async () => {
    const { instance } = await readyChain();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a'], hops: 2 } });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
  });

  it('advances scope AND render but NOT model on a scope-only change', async () => {
    const { instance } = await readyChain();
    const before = instance.getRevisions();

    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });

    const after = instance.getRevisions();
    expect(after.model).toBe(before.model); // the scope/model split
    expect(after.scope).toBe(before.scope + 1);
    expect(after.render).toBe(before.render + 1);
    expect(after.source).toBe(before.source);

    // Clearing is also scope-only.
    instance.applyHostUpdate({ subgraph: null });
    const cleared = instance.getRevisions();
    expect(cleared.model).toBe(before.model);
    expect(cleared.scope).toBe(before.scope + 2);
  });

  it('replaying the identical subgraph spec publishes nothing', async () => {
    const { instance } = await readyChain();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });
    const before = instance.getRevisions();
    // A React re-render passing a NEW but structurally equal spec is a no-op.
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });
    expect(instance.getRevisions()).toEqual(before);
  });
});

describe('reflow', () => {
  it("restarts the simulation with alpha 1 on a scope commit under 'force'", async () => {
    const { instance, engine } = await readyChain('force');
    engine.injectSimulationEnd();
    expect(instance.store.getState().simulationRunning).toBe(false);

    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });
    expect(engine.lastCommit!.restart).toEqual({ alpha: 1 });
    expect(instance.store.getState().simulationRunning).toBe(true);
  });

  it('reflow:false keeps the simulation state (no restart)', async () => {
    const { instance, engine } = await readyChain('force');
    engine.injectSimulationEnd();

    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'], reflow: false } });
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeDefined(); // the swap still commits
    expect(commit.restart).toBeUndefined();
    expect(instance.store.getState().simulationRunning).toBe(false);
  });

  it("clearing the scope reflows the restored base by default under 'force'", async () => {
    const { instance, engine } = await readyChain('force');
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'], reflow: false } });
    instance.applyHostUpdate({ subgraph: null });
    expect(engine.lastCommit!.restart).toEqual({ alpha: 1 });
  });
});

describe('isolateSelection / resetIsolation', () => {
  it('round-trips through the SAME path and restores full-base positions byte-identically (fixed)', async () => {
    const { instance, engine } = await readyChain('fixed');
    const posBefore = Array.from(engine.getPositions()!);

    instance.selectNodes(['a', 'b']);
    instance.isolateSelection();
    expect(instance.store.getState().scope).toEqual({ seedIds: ['a', 'b'] });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);

    instance.resetIsolation();
    expect(instance.store.getState().scope).toBeNull();
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c', 'd']);

    // Identity-preserving reconciliation: fixed layout, no restart, and the restored
    // structure carries byte-identical positions (survivors from the live
    // cache, departed ids from the departed cache).
    const commit = engine.lastCommit!;
    expect(commit.restart).toBeUndefined();
    expect(Array.from(commit.structure!.positions)).toEqual(posBefore);
    expect(Array.from(engine.getPositions()!)).toEqual(posBefore);
  });

  it('isolateSelection with an empty selection is a no-op', async () => {
    const { instance } = await readyChain();
    const before = instance.getRevisions();
    instance.isolateSelection();
    expect(instance.getRevisions()).toEqual(before);
    expect(instance.store.getState().scope).toBeNull();
  });
});

describe('slice survival across scope changes', () => {
  it('selection, pins, and hidden ids survive scope changes (out-of-scope ids stay)', async () => {
    const { instance, engine } = await readyChain();
    instance.selectNodes(['a', 'c']);
    instance.pinNode('c'); // engine-known position (20,0)
    instance.hideNodes(['d']);

    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });

    const state = instance.store.getState();
    expect(state.selection.nodeIds).toEqual(['a', 'c']); // c is out of scope but KEPT
    expect(state.pins.get('c')).toEqual([20, 0]);
    expect(state.hiddenNodeIds.has('d')).toBe(true);

    // The engine highlight maps only in-scope indices — never a store write.
    const lastSelection = engine.calls
      .filter((c) => c.method === 'setSelectedIndices')
      .at(-1)!;
    expect(lastSelection.args[0]).toEqual([0]); // just 'a'
  });

  it('departed-id pruning applies only to accepted-BASE changes, not scope', async () => {
    const { instance } = await readyChain();
    instance.selectNodes(['a', 'c']);
    instance.pinNode('c');
    instance.hideNodes(['d']);
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });

    // Same dataset, new sourceRevision, c departs the BASE → NOW c prunes.
    instance.applyHostUpdate({ data: snap(2, ['a', 'b', 'd'], [['a', 'b']]) });

    const state = instance.store.getState();
    expect(state.selection.nodeIds).toEqual(['a']);
    expect(state.pins.has('c')).toBe(false);
    expect(state.hiddenNodeIds.has('d')).toBe(true); // d survived the base change
    expect(state.scope).toEqual({ seedIds: ['a', 'b'] }); // scope spec persists
  });

  it('selectAll population follows the scoped scene (minus hidden)', async () => {
    const { instance } = await readyChain();
    instance.hideNodes(['b']);
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b', 'c'] } });
    instance.selectAll();
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'c']);
  });
});

describe('label lane × scope', () => {
  it('re-ranks candidates on scope changes (subscribeCandidates fires with the subset)', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c'], [['a', 'b'], ['a', 'c']]),
      labels: { minZoom: 0 },
    });
    engine.injectSimulationEnd(); // settle: bank positions + re-rank

    const emissions: string[][] = [];
    h.instance.labels.subscribeCandidates((list) => emissions.push(list.map((p) => p.id)));
    expect(emissions).toEqual([['a', 'b', 'c']]); // replay on subscribe

    h.instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });
    expect(emissions.at(-1)).toEqual(['a', 'b']);

    h.instance.applyHostUpdate({ subgraph: null });
    expect(emissions.at(-1)).toEqual(['a', 'b', 'c']);
  });
});

describe('dataset changes clear the scope', () => {
  it('a new datasetKey clears the scope (per-dataset id-keyed state)', async () => {
    const { instance } = await readyChain();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a'] } });
    expect(instance.store.getState().scope).toEqual({ seedIds: ['a'] });

    instance.applyHostUpdate({ data: snap(1, ['x', 'y'], [['x', 'y']], 'other') });
    expect(instance.store.getState().scope).toBeNull();
    expect(instance.getVisibleNodeIds()).toEqual(['x', 'y']);
  });
});
