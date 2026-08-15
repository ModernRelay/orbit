/**
 * context-loss / recovery orchestration — FakeEngine-driven.
 *
 * Invariants under test: transient loss is a status transition + warning
 * diagnostic (never an 'error' event); updates while lost coalesce CPU-side;
 * restore replays the LATEST desired state as ONE gentle-restart commit and
 * re-pushes camera/selection/hover; terminal failure routes through the
 * fatality matrix.
 */

import { describe, expect, it } from 'vitest';

import type { GraphError } from '../src/errors';
import type { InstanceStatus } from '../src/types';
import { callsOf, container, makeInstance, snap } from './helpers';
import type { InstanceHarness } from './helpers';
import type { FakeEngine } from '../src/testing/index';

interface ReadyHarness extends InstanceHarness {
  engine: FakeEngine;
}

/** Attached instance with data, all four styling channels, and config set. */
async function setupReady(): Promise<ReadyHarness> {
  const h = makeInstance();
  await h.instance.attach(container);
  h.instance.applyHostUpdate({
    data: snap(1, ['a', 'b', 'c'], [['a', 'b']]),
    nodeColor: 'red',
    nodeSize: 5,
    linkColor: 'blue',
    linkWidth: 2,
    theme: { background: 'black' },
    simulation: { gravity: 0.25 },
  });
  return { ...h, engine: h.engines[0]! };
}

describe('context lost', () => {
  it('freezes the engine: status lost, one warning diagnostic, no error event, CPU-only updates', async () => {
    const { instance, engine } = await setupReady();
    const errors: unknown[] = [];
    instance.on('error', (p) => errors.push(p));

    engine.injectContextLost();

    const state = instance.store.getState();
    expect(state.status).toBe('lost');
    const contextDiags = state.diagnostics.filter((d) => d.code === 'context-lost');
    expect(contextDiags).toHaveLength(1);
    expect(contextDiags[0]!.severity).toBe('warning');
    expect(errors).toHaveLength(0);

    // Everything below must be a no-op on the (dead) engine.
    const callsBefore = engine.calls.length;
    const commitsBefore = engine.commits.length;

    instance.fitView();
    instance.setSelection(['a']);

    const revBefore = instance.getRevisions();
    instance.applyHostUpdate({ data: snap(2, ['a', 'b', 'c', 'd'], [['a', 'b']]) });
    const revAfter = instance.getRevisions();
    expect(revAfter.model).toBe(revBefore.model + 1);
    expect(revAfter.render).toBe(revBefore.render + 1);
    expect(revAfter.appliedRender).toBe(revBefore.appliedRender);

    expect(engine.commits.length).toBe(commitsBefore);
    expect(engine.calls.length).toBe(callsBefore);
    expect(instance.store.getState().status).toBe('lost');
  });

  it('ignores spurious context events (lost while lost, restored while ready)', async () => {
    const { instance, engine } = await setupReady();

    // restored while ready: silent no-op.
    const commitsBefore = engine.commits.length;
    engine.injectContextRestored();
    expect(instance.store.getState().status).toBe('ready');
    expect(engine.commits.length).toBe(commitsBefore);

    engine.injectContextLost();
    const diagsAfterFirst = instance.getDiagnostics();

    // lost while lost: no second diagnostic, no publish.
    let notifications = 0;
    instance.store.subscribe(() => notifications++);
    engine.injectContextLost();
    expect(notifications).toBe(0);
    expect(instance.getDiagnostics()).toBe(diagsAfterFirst);
  });
});

describe('context restore', () => {
  it('replays the full scene as one commit and re-pushes viewport, selection, pins, positions', async () => {
    const { instance, engine } = await setupReady();

    // Settle drifted positions into the cache, then set camera + selection + pin.
    engine.nudgePositions(5, 5);
    engine.injectSimulationEnd();
    instance.setSelection(['a', 'c']);
    instance.pinNode('b', [15, 5]);
    engine.injectViewportChange({ x: 7, y: 8, zoom: 2 });

    const statuses: InstanceStatus[] = [];
    instance.store.subscribe((next, prev) => {
      if (next.status !== prev.status) statuses.push(next.status);
    });

    engine.injectContextLost();
    const commitsBefore = engine.commits.length;
    const callIndexBefore = engine.calls.length;

    engine.injectContextRestored();

    expect(statuses).toEqual(['lost', 'recovering', 'ready']);

    // Exactly ONE replay commit: structure + all 4 buffers + config + gentle restart.
    expect(engine.commits.length).toBe(commitsBefore + 1);
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeDefined();
    expect(commit.structure!.pointCount).toBe(3);
    expect(commit.buffers).toBeDefined();
    expect(commit.buffers!.pointColor).toHaveLength(12);
    expect(commit.buffers!.pointSize).toHaveLength(3);
    expect(commit.buffers!.linkColor).toHaveLength(4);
    expect(commit.buffers!.linkWidth).toHaveLength(1);
    // The replay config carries the full resolved theme token
    // subset + the link toggle (linkArrows is capability-stripped
    // the FakeEngine profile does not declare edgeArrows).
    expect(commit.config).toEqual({
      backgroundColor: 'black',
      defaultPointColor: '#94a3b8',
      defaultLinkColor: 'rgba(255,255,255,0.15)',
      renderLinks: true,
      emphasisRingColor: '#7aa2f7',
      simulation: { gravity: 0.25 },
    });
    expect(commit.restart).toEqual({ alpha: 0.1 });

    // Replay positions are the nudged cache — no NaN reseeds, no origin pile-up.
    expect(Array.from(commit.structure!.positions)).toEqual([5, 5, 15, 5, 25, 5]);

    // Order: commit → setViewport(stored) → setSelectedIndices → setPinnedIndices.
    const tail = engine.calls
      .slice(callIndexBefore)
      .filter((c) =>
        ['commit', 'setViewport', 'setSelectedIndices', 'setPinnedIndices'].includes(c.method),
      );
    expect(tail.map((c) => c.method)).toEqual([
      'commit',
      'setViewport',
      'setSelectedIndices',
      'setPinnedIndices',
    ]);
    expect(tail[1]!.args).toEqual([{ x: 7, y: 8, zoom: 2 }]);
    expect(tail[2]!.args).toEqual([[0, 2]]);
    expect(tail[3]!.args).toEqual([[1]]);
    expect(engine.pinnedIndices).toEqual([1]);

    const state = instance.store.getState();
    expect(state.status).toBe('ready');
    expect(state.revisions.appliedRender).toBe(state.revisions.render);
  });

  it("layout 'fixed': the replay commit does not restart the simulation", async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']), layout: 'fixed' });
    const engine = engines[0]!;

    engine.injectContextLost();
    engine.injectContextRestored();

    expect(instance.store.getState().status).toBe('ready');
    expect(engine.lastCommit!.structure).toBeDefined();
    expect(engine.lastCommit!.restart).toBeUndefined();
  });

  it('recovers in-place: one factory call and one mount across the whole cycle', async () => {
    const { engine, factoryCalls } = await setupReady();
    engine.injectContextLost();
    engine.injectContextRestored();
    expect(factoryCalls()).toBe(1);
    expect(callsOf(engine, 'mount')).toHaveLength(1);
  });

  it('coalesces updates applied while lost into one replay of the LATEST data', async () => {
    const { instance, engine } = await setupReady();
    engine.injectContextLost();

    const commitsBefore = engine.commits.length;
    const renderBefore = instance.getRevisions().render;

    instance.applyHostUpdate({ data: snap(2, ['a', 'b', 'c', 'd'], [['a', 'b']]) });
    instance.applyHostUpdate({ nodeColor: 'green' });

    expect(instance.getRevisions().render).toBe(renderBefore + 2);
    expect(engine.commits.length).toBe(commitsBefore);

    engine.injectContextRestored();

    expect(engine.commits.length).toBe(commitsBefore + 1);
    const commit = engine.lastCommit!;
    expect(commit.revision).toBe(renderBefore + 2);
    expect(commit.structure!.pointCount).toBe(4);
    expect(commit.buffers!.pointColor).toHaveLength(16); // latest color over latest structure
    expect(instance.getRevisions().appliedRender).toBe(renderBefore + 2);
  });

  it('re-applies pins with FRESHLY mapped indices after a coalesced structural change', async () => {
    const { instance, engine } = await setupReady();
    instance.pinNode('c', [25, 5]); // index 2 in the a,b,c base
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[2]]);

    engine.injectContextLost();
    // While lost: 'z' prepended shifts 'c' to index 3 (CPU-side only).
    instance.applyHostUpdate({ data: snap(2, ['z', 'a', 'b', 'c'], [['a', 'b']]) });
    const pinPushesWhileLost = callsOf(engine, 'setPinnedIndices').length;

    engine.injectContextRestored();

    expect(callsOf(engine, 'setPinnedIndices').length).toBe(pinPushesWhileLost + 1);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[3]]);
    expect(engine.pinnedIndices).toEqual([3]);
    expect(instance.store.getState().pins.get('c')).toEqual([25, 5]); // slice survived
  });

  it("emits 'ready' exactly once per mount and re-pushes hover focus on recovery", async () => {
    const { instance, engines } = makeInstance();
    let readyCount = 0;
    instance.on('ready', () => readyCount++);

    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c']) });
    const engine = engines[0]!;

    engine.injectPointHover(1);
    const focusBefore = callsOf(engine, 'setFocusedIndex').length;

    engine.injectContextLost();
    engine.injectContextRestored();

    expect(readyCount).toBe(1);
    expect(instance.store.getState().status).toBe('ready');
    const focusCalls = callsOf(engine, 'setFocusedIndex');
    expect(focusCalls.length).toBe(focusBefore + 1);
    expect(focusCalls.at(-1)!.args).toEqual([1]);
  });
});

describe('terminal recovery failure', () => {
  it('context failed: error status, context-lost ERROR diagnostic, one detailed error event; then inert', async () => {
    const { instance, engine } = await setupReady();
    const events: Array<{ error: Error; detail?: GraphError }> = [];
    instance.on('error', (p) => events.push(p));

    engine.injectContextLost();
    const failure = new Error('gl re-init failed');
    engine.injectContextFailed(failure);

    const state = instance.store.getState();
    expect(state.status).toBe('error');
    expect(
      state.diagnostics.some((d) => d.code === 'context-lost' && d.severity === 'error'),
    ).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.error).toBe(failure);
    expect(events[0]!.detail).toEqual({ code: 'context-lost' });

    // Later injections are inert: status not ready/lost/recovering anymore.
    const commitsBefore = engine.commits.length;
    engine.injectContextLost();
    engine.injectContextRestored();
    engine.injectContextFailed(new Error('again'));
    expect(events).toHaveLength(1);
    expect(engine.commits.length).toBe(commitsBefore);
    expect(instance.store.getState().status).toBe('error');
  });

  it('a throwing replay commit fails recovery terminally without throwing at the caller', async () => {
    const { instance, engine } = await setupReady();
    const events: Array<{ error: Error; detail?: GraphError }> = [];
    instance.on('error', (p) => events.push(p));

    engine.injectContextLost();

    const originalCommit = engine.commit.bind(engine);
    let thrown = false;
    engine.commit = (update) => {
      if (!thrown) {
        thrown = true;
        throw new Error('commit exploded');
      }
      originalCommit(update);
    };

    expect(() => engine.injectContextRestored()).not.toThrow();

    expect(instance.store.getState().status).toBe('error');
    expect(events).toHaveLength(1);
    expect(events[0]!.error.message).toBe('commit exploded');
    expect(events[0]!.detail).toEqual({ code: 'context-lost' });
  });
});

describe('detach while lost', () => {
  it('lands in idle without touching the dead engine; re-attach replays cached positions', async () => {
    const { instance, engine, engines, factoryCalls } = await setupReady();

    // Bank settled positions BEFORE the loss.
    engine.nudgePositions(5, 5);
    engine.injectSimulationEnd();
    const readbacksBefore = callsOf(engine, 'getPositions').length;

    engine.injectContextLost();
    instance.detach();

    expect(instance.store.getState().status).toBe('idle');
    expect(callsOf(engine, 'destroy')).toHaveLength(1);
    // detach while lost must NOT read positions from the dead engine.
    expect(callsOf(engine, 'getPositions')).toHaveLength(readbacksBefore);

    await instance.attach(container);
    expect(factoryCalls()).toBe(2);
    const fresh = engines[1]!;
    expect(fresh.commits).toHaveLength(1);
    expect(Array.from(fresh.commits[0]!.structure!.positions)).toEqual([5, 5, 15, 5, 25, 5]);
    expect(instance.store.getState().status).toBe('ready');
  });
});
