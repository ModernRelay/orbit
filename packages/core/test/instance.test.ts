import { describe, expect, it } from 'vitest';

import { OrbitOperationError } from '../src/errors';
import type { GraphError } from '../src/errors';
import { createGraphInstance } from '../src/instance';
import type { EngineHostEvents } from '../src/engine/index';
import { FakeEngine } from '../src/testing/index';
import type { GraphNode, NodeId, SelectionState } from '../src/types';
import { callsOf, container, makeInstance, snap } from './helpers';
import type { NAttrs } from './helpers';

/** Synthesized edge id: `${source}→${target}#${k}`. */
const eid = (s: string, t: string, k = 0): string => `${s}→${t}#${k}`;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class DelayedMountEngine extends FakeEngine {
  private readonly mountGate = deferred<void>();

  override mount(host: HTMLElement, events: EngineHostEvents): Promise<void> {
    void super.mount(host, events);
    return this.mountGate.promise;
  }

  resolveMount(): void {
    this.mountGate.resolve();
  }

  rejectMount(reason: unknown): void {
    this.mountGate.reject(reason);
  }
}

describe('GraphInstance atomicity', () => {
  it('publishes one store set() and one engine commit for a multi-key update', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    let notifications = 0;
    instance.store.subscribe(() => notifications++);

    instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c'], [['a', 'b']]),
      nodeColor: 'red',
      nodeSize: 5,
      linkColor: 'blue',
      linkWidth: 2,
      theme: { background: 'black' },
      simulation: { gravity: 0.25 },
    });

    expect(notifications).toBe(1);
    // Mount itself paints the default theme tokens via ONE
    // config-only commit; the host update still adds exactly one commit.
    expect(engine.commits).toHaveLength(2);
    expect(engine.commits[0]!.structure).toBeUndefined();
    expect(engine.commits[0]!.buffers).toBeUndefined();
    expect(engine.commits[0]!.config).toBeDefined();

    const commit = engine.commits[1]!;
    expect(commit.structure).toBeDefined();
    expect(commit.structure!.pointCount).toBe(3);
    expect(Array.from(commit.structure!.links)).toEqual([0, 1]);
    expect(commit.buffers).toBeDefined();
    expect(commit.buffers!.pointColor).toHaveLength(12);
    expect(commit.buffers!.pointSize).toHaveLength(3);
    expect(commit.buffers!.linkColor).toHaveLength(4);
    expect(commit.buffers!.linkWidth).toHaveLength(1);
    expect(commit.config).toEqual({ backgroundColor: 'black', simulation: { gravity: 0.25 } });

    const state = instance.store.getState();
    expect(state.status).toBe('ready');
    expect(state.nodeCount).toBe(3);
    expect(state.edgeCount).toBe(1);
    expect(state.revisions).toEqual({
      source: 1,
      model: 1,
      scope: 1,
      render: 1,
      appliedRender: 1,
    });
    expect(commit.revision).toBe(1);
  });
});

describe('GraphInstance idempotent replay', () => {
  it('skips a data snapshot with the same {datasetKey, sourceRevision} entirely', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    const revisionsBefore = instance.getRevisions();
    const commitsBefore = engine.commits.length;

    let notifications = 0;
    instance.store.subscribe(() => notifications++);

    // Same identity, even with different content: skipped without validation.
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c', 'd']) });

    expect(engine.commits.length).toBe(commitsBefore);
    expect(instance.getRevisions()).toEqual(revisionsBefore);
    expect(notifications).toBe(0);
    expect(instance.store.getState().nodeCount).toBe(2);
  });

  it('still applies the other keys carried by a replayed update', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    const before = instance.getRevisions();

    instance.applyHostUpdate({ data: snap(1, ['a', 'b']), nodeSize: 7 });

    const commit = engine.lastCommit!;
    expect(commit.structure).toBeUndefined();
    expect(commit.buffers!.pointSize).toHaveLength(2);
    expect(Array.from(commit.buffers!.pointSize!)).toEqual([7, 7]);

    const after = instance.getRevisions();
    expect(after.model).toBe(before.model); // no model advance
    expect(after.render).toBe(before.render + 1); // but a new desired render
  });

  it('applies a changed sourceRevision as a structural diff with preserved positions', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c']) });
    // FakeEngine seeds (0,0) (10,0) (20,0); drift the simulation then settle.
    engine.nudgePositions(5, 5);
    engine.injectSimulationEnd();

    instance.applyHostUpdate({ data: snap(2, ['a', 'b', 'c', 'd']) });

    const commit = engine.lastCommit!;
    expect(commit.structure).toBeDefined();
    expect(commit.structure!.pointCount).toBe(4);
    const pos = Array.from(commit.structure!.positions);
    expect(pos.slice(0, 6)).toEqual([5, 5, 15, 5, 25, 5]); // reused live positions
    expect(pos[6]).toBeNaN(); // new node seeds in the engine
    expect(pos[7]).toBeNaN();

    const revisions = instance.getRevisions();
    expect(revisions.source).toBe(2);
    expect(revisions.model).toBe(2);
    expect(revisions.render).toBe(2);
    expect(revisions.appliedRender).toBe(2);
  });

  it('commits changed snapshot coordinates even when ids and links are unchanged', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    instance.applyHostUpdate({
      data: {
        datasetKey: 'ds',
        sourceRevision: 1,
        nodes: [
          { id: 'a', x: 1, y: 2, attrs: { label: 'A' } },
          { id: 'b', x: 3, y: 4, attrs: { label: 'B' } },
        ],
        edges: [{ source: 'a', target: 'b', attrs: { weight: 1 } }],
      },
    });
    const commitsBefore = engine.commits.length;

    instance.applyHostUpdate({
      data: {
        datasetKey: 'ds',
        sourceRevision: 2,
        nodes: [
          { id: 'a', x: 101, y: 102, attrs: { label: 'A' } },
          { id: 'b', x: 103, y: 104, attrs: { label: 'B' } },
        ],
        edges: [{ source: 'a', target: 'b', attrs: { weight: 1 } }],
      },
    });

    expect(engine.commits).toHaveLength(commitsBefore + 1);
    expect(engine.lastCommit!.structure).toBeDefined();
    expect(Array.from(engine.lastCommit!.structure!.positions)).toEqual([101, 102, 103, 104]);
    expect(instance.getRevisions().render).toBe(2);
    expect(instance.getRevisions().appliedRender).toBe(2);
  });
});

describe('GraphInstance lifecycle', () => {
  it('queues pre-attach updates and lands the latest state as one commit at ready', async () => {
    const { instance, engines } = makeInstance();

    instance.applyHostUpdate({ data: snap(1, ['a']) });
    instance.applyHostUpdate({ data: snap(2, ['a', 'b']), nodeColor: 'red' });
    expect(instance.store.getState().status).toBe('idle');
    expect(engines).toHaveLength(0);

    await instance.attach(container);
    const engine = engines[0]!;

    expect(engine.commits).toHaveLength(1);
    const commit = engine.commits[0]!;
    expect(commit.structure!.pointCount).toBe(2);
    expect(commit.buffers!.pointColor).toHaveLength(8);
    expect(commit.revision).toBe(2);

    expect(callsOf(engine, 'fitView')).toHaveLength(1);
    const state = instance.store.getState();
    expect(state.status).toBe('ready');
    expect(state.revisions.appliedRender).toBe(2);
  });

  it('does not fitView when fitViewOnFirstData is false', async () => {
    const { instance, engines } = makeInstance({ fitViewOnFirstData: false });
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    await instance.attach(container);
    expect(callsOf(engines[0]!, 'fitView')).toHaveLength(0);
  });

  it('detach keeps model state and re-attach replays into a fresh engine', async () => {
    const { instance, engines, factoryCalls } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    const firstStructure = engines[0]!.lastCommit!.structure!;

    instance.detach();
    expect(engines[0]!.destroyed).toBe(true);
    const idleState = instance.store.getState();
    expect(idleState.status).toBe('idle');
    expect(idleState.nodeCount).toBe(2); // model state kept
    expect(idleState.revisions.appliedRender).toBeNull();

    await instance.attach(container);
    expect(factoryCalls()).toBe(2);
    const fresh = engines[1]!;

    expect(fresh.commits).toHaveLength(1);
    const replay = fresh.commits[0]!.structure!;
    expect(replay.pointCount).toBe(firstStructure.pointCount);
    expect(Array.from(replay.links)).toEqual(Array.from(firstStructure.links));
    // Positions banked at detach (FakeEngine seeds) survive into the replay.
    expect(Array.from(replay.positions)).toEqual([0, 0, 10, 0]);
    expect(instance.store.getState().status).toBe('ready');
  });

  it('treats a second attach while mounting as a no-op returning the in-flight promise', async () => {
    const { instance, engines, factoryCalls } = makeInstance();
    const p1 = instance.attach(container);
    const p2 = instance.attach(container);

    expect(p2).toBe(p1);
    await Promise.all([p1, p2]);

    expect(factoryCalls()).toBe(1);
    expect(callsOf(engines[0]!, 'mount')).toHaveLength(1);
    expect(instance.store.getState().status).toBe('ready');
  });

  it('resolves a late mount rejection after detach without publishing an error', async () => {
    const engine = new DelayedMountEngine();
    const instance = createGraphInstance({ engine: () => engine });
    const errors: Array<{ error: Error }> = [];
    instance.on('error', (payload) => errors.push(payload));

    const attaching = instance.attach(container);
    expect(instance.store.getState().status).toBe('mounting');
    instance.detach();
    const idleState = instance.store.getState();
    expect(idleState.status).toBe('idle');
    expect(engine.destroyed).toBe(true);

    engine.rejectMount(new Error('detached mount failed late'));
    await expect(attaching).resolves.toBeUndefined();

    expect(errors).toEqual([]);
    expect(instance.store.getState()).toBe(idleState);
  });

  it('resolves a late mount rejection after destroy without mutating destroyed state', async () => {
    const engine = new DelayedMountEngine();
    const instance = createGraphInstance({ engine: () => engine });
    const errors: Array<{ error: Error }> = [];
    instance.on('error', (payload) => errors.push(payload));

    const attaching = instance.attach(container);
    instance.destroy();
    const destroyedState = instance.store.getState();
    expect(destroyedState.status).toBe('destroyed');
    expect(engine.destroyed).toBe(true);

    engine.rejectMount(new Error('destroyed mount failed late'));
    await expect(attaching).resolves.toBeUndefined();

    expect(errors).toEqual([]);
    expect(instance.store.getState()).toBe(destroyedState);
  });

  it('keeps a reattached session ready when the discarded mount later rejects', async () => {
    const engines: DelayedMountEngine[] = [];
    const instance = createGraphInstance({
      engine: () => {
        const engine = new DelayedMountEngine();
        engines.push(engine);
        return engine;
      },
    });
    const errors: Array<{ error: Error }> = [];
    instance.on('error', (payload) => errors.push(payload));

    const discardedAttach = instance.attach(container);
    instance.detach();
    const currentAttach = instance.attach(container);
    expect(engines).toHaveLength(2);

    engines[1]!.resolveMount();
    await currentAttach;
    const readyState = instance.store.getState();
    expect(readyState.status).toBe('ready');
    expect(engines[0]!.destroyed).toBe(true);
    expect(engines[1]!.destroyed).toBe(false);

    engines[0]!.rejectMount(new Error('discarded mount failed late'));
    await expect(discardedAttach).resolves.toBeUndefined();

    expect(errors).toEqual([]);
    expect(instance.store.getState()).toBe(readyState);
    expect(engines[1]!.destroyed).toBe(false);
  });

  it('still rejects and reports a delayed failure from the current mount exactly once', async () => {
    const engine = new DelayedMountEngine();
    const instance = createGraphInstance({ engine: () => engine });
    const errors: Array<{ error: Error; detail?: GraphError }> = [];
    instance.on('error', (payload) => errors.push(payload));

    const attaching = instance.attach(container);
    const failure = new Error('current delayed mount failure');
    engine.rejectMount(failure);
    await expect(attaching).rejects.toBe(failure);

    expect(instance.store.getState().status).toBe('error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.error).toBe(failure);
    expect(errors[0]!.detail).toEqual({
      code: 'engine-unsupported',
      detail: failure.message,
    });
  });

  it('destroy is terminal: engine destroyed, operations throw OrbitOperationError, listeners silent', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });

    const seen: unknown[] = [];
    instance.on('selectionChange', (p) => seen.push(p));

    instance.destroy();

    expect(engines[0]!.destroyed).toBe(true);
    expect(instance.store.getState().status).toBe('destroyed');

    // Destroyed operations throw the typed operation error, not a bare Error.
    for (const call of [
      () => instance.applyHostUpdate({ nodeSize: 3 }),
      () => instance.attach(container),
    ]) {
      let caught: unknown;
      try {
        call();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(OrbitOperationError);
      const opErr = caught as OrbitOperationError;
      expect(opErr.detail).toEqual({ code: 'aborted', cause: 'destroyed' });
      expect(opErr.message).toMatch(/destroyed GraphInstance/);
    }

    // Mutations after destroy are silent no-ops.
    instance.setSelection(['a']);
    instance.clearSelection();
    instance.selectNodes(['a']);
    instance.selectEdges([]);
    instance.selectAll();
    instance.invertSelection();
    instance.selectNeighbors('a');
    instance.hideNodes(['a']);
    instance.pinNode('a', [0, 0]);
    expect(seen).toHaveLength(0);
    const finalState = instance.store.getState();
    expect(finalState.selection.nodeIds).toEqual([]);
    expect(finalState.hiddenNodeIds.size).toBe(0);
    expect(finalState.pins.size).toBe(0);
    expect(finalState.status).toBe('destroyed');
  });

  it('maps a rejected engine.mount to engine-unsupported with exactly one error event', async () => {
    const mountError = new Error('WebGL2 unavailable');
    const { instance, engines } = makeInstance({ engineOptions: { mountError } });

    const events: Array<{ error: Error; detail?: GraphError }> = [];
    instance.on('error', (p) => events.push(p));

    // attach still rejects with the ORIGINAL error.
    await expect(instance.attach(container)).rejects.toBe(mountError);

    const state = instance.store.getState();
    expect(state.status).toBe('error');
    expect(state.diagnostics.some((d) => d.code === 'engine-error' && d.severity === 'error')).toBe(
      true,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.error).toBe(mountError);
    expect(events[0]!.detail).toEqual({
      code: 'engine-unsupported',
      detail: 'WebGL2 unavailable',
    });
    // The failed engine recorded the mount attempt but never became live.
    expect(callsOf(engines[0]!, 'mount')).toHaveLength(1);
    expect(callsOf(engines[0]!, 'commit')).toHaveLength(0);
  });
});

describe('GraphInstance events', () => {
  it('maps engine indices back to caller node objects for click and hover', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    const engine = engines[0]!;

    const hovers: Array<GraphNode<NAttrs> | null> = [];
    const clicks: Array<GraphNode<NAttrs>> = [];
    const selections: Array<readonly NodeId[]> = [];
    let backgroundClicks = 0;
    instance.on('nodeHover', (p) => hovers.push(p.node));
    instance.on('nodeClick', (p) => clicks.push(p.node));
    instance.on('selectionChange', (p) => selections.push(p.nodeIds));
    instance.on('backgroundClick', () => backgroundClicks++);

    engine.injectPointHover(1);
    expect(instance.store.getState().hover.nodeId).toBe('b');
    expect(hovers).toHaveLength(1);
    expect(hovers[0]).toMatchObject({ id: 'b', attrs: { label: 'B' } });
    expect(callsOf(engine, 'setFocusedIndex').at(-1)!.args).toEqual([1]);

    engine.injectPointHover(null);
    expect(instance.store.getState().hover.nodeId).toBeNull();
    expect(hovers[1]).toBeNull();
    expect(callsOf(engine, 'setFocusedIndex').at(-1)!.args).toEqual([null]);

    // Uncontrolled click: replace-selection [id], store written, engine pushed.
    engine.injectPointClick(0);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatchObject({ id: 'a', attrs: { label: 'A' } });
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
    expect(selections.at(-1)).toEqual(['a']);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[0]]);

    // Background click clears and emits backgroundClick.
    engine.injectPointClick(null);
    expect(backgroundClicks).toBe(1);
    expect(instance.store.getState().selection.nodeIds).toEqual([]);
    expect(selections.at(-1)).toEqual([]);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([null]);
  });

  it('surfaces engine errors as diagnostics, error status, and an error event', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const errors: Error[] = [];
    instance.on('error', (p) => errors.push(p.error));

    engines[0]!.injectError(new Error('context lost'));

    const state = instance.store.getState();
    expect(state.status).toBe('error');
    expect(state.diagnostics.some((d) => d.code === 'engine-error')).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toBe('context lost');
  });

  it('reads back positions into the cache on simulationEnd', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    const engine = engines[0]!;

    let ended = 0;
    instance.on('simulationEnd', () => ended++);

    engine.nudgePositions(3, 4);
    engine.injectSimulationEnd();
    expect(ended).toBe(1);

    // Positions survive a detach/attach cycle via the cache.
    instance.detach();
    await instance.attach(container);
    const replay = engines[1]!.commits[0]!.structure!;
    expect(Array.from(replay.positions)).toEqual([3, 4, 13, 4]);
  });
});

describe('GraphInstance selection ownership', () => {
  it('becomes host-controlled once an update carries selection', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    instance.applyHostUpdate({ data: snap(1, ['a', 'b']), selection: ['a'] });
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[0]]);

    const intents: Array<readonly NodeId[]> = [];
    instance.on('selectionChange', (p) => intents.push(p.nodeIds));
    const pushesBefore = callsOf(engine, 'setSelectedIndices').length;

    // Internal mutations only emit intent; the store does not move.
    engine.injectPointClick(1);
    expect(intents).toEqual([['b']]);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
    expect(callsOf(engine, 'setSelectedIndices')).toHaveLength(pushesBefore);

    instance.setSelection(['b']);
    expect(intents).toEqual([['b'], ['b']]);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);

    // The store changes only when the host reflects the new value.
    instance.applyHostUpdate({ selection: ['b'] });
    expect(instance.store.getState().selection.nodeIds).toEqual(['b']);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[1]]);
  });

  it('uncontrolled setSelection writes the store, pushes the engine, and emits', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    const engine = engines[0]!;

    const seen: Array<readonly NodeId[]> = [];
    instance.on('selectionChange', (p) => seen.push(p.nodeIds));

    instance.setSelection(['b']);
    expect(instance.store.getState().selection.nodeIds).toEqual(['b']);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[1]]);
    expect(seen).toEqual([['b']]);

    instance.clearSelection();
    expect(instance.store.getState().selection.nodeIds).toEqual([]);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([null]);
    expect(seen).toEqual([['b'], []]);
  });
});

describe('GraphInstance datasetKey change', () => {
  it('clears selection, hidden, pins, hover, diagnostics, and position identity', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    // ds1 carries a dangling edge so diagnostics are non-empty.
    instance.applyHostUpdate({
      data: {
        datasetKey: 'ds1',
        sourceRevision: 1,
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'zz' }],
      },
    });
    expect(instance.getDiagnostics().some((d) => d.code === 'dangling-edge-endpoint')).toBe(true);

    engine.injectPointClick(0);
    engine.injectPointHover(1);
    engine.injectLinkHover(0);
    instance.selectEdges([eid('a', 'b')]);
    instance.hideNodes(['c']);
    instance.pinNode('b', [7, 8]);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
    expect(instance.store.getState().hover).toEqual({ nodeId: 'b', edgeId: eid('a', 'b') });
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[1]]);

    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [], 'ds2') });

    const state = instance.store.getState();
    expect(state.selection).toEqual({ nodeIds: [], edgeIds: [], groupIds: [] });
    expect(state.hiddenNodeIds.size).toBe(0);
    expect(state.pins.size).toBe(0);
    expect(state.hover).toEqual({ nodeId: null, edgeId: null });
    expect(state.diagnostics).toEqual([]);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([null]);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([null]);
    expect(engine.pinnedIndices).toBeNull();

    // Fresh reconciler: same ids get no cached positions — engine reseeds.
    const structure = engine.lastCommit!.structure!;
    expect(structure.pointCount).toBe(2);
    for (const v of structure.positions) expect(v).toBeNaN();
  });
});

describe('GraphInstance store shape (v0.3 slices)', () => {
  it('initializes namespaced selection, dual hover, pins, and hiddenNodeIds', () => {
    const { instance } = makeInstance();
    const state = instance.store.getState();
    expect(state.selection).toEqual({ nodeIds: [], edgeIds: [], groupIds: [] });
    expect(state.hover).toEqual({ nodeId: null, edgeId: null });
    expect(state.pins.size).toBe(0);
    expect(state.hiddenNodeIds.size).toBe(0);
  });

  it('selectionChange carries the full SelectionState payload', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    const seen: SelectionState[] = [];
    instance.on('selectionChange', (p) => seen.push(p));
    instance.setSelection({ nodeIds: ['b'], edgeIds: [eid('a', 'b')], groupIds: [] });
    expect(seen).toEqual([{ nodeIds: ['b'], edgeIds: [eid('a', 'b')], groupIds: [] }]);
  });
});

describe('GraphInstance click semantics', () => {
  it('plain click replaces; meta/shift click toggles in accepted-base order', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c']) });
    const engine = engines[0]!;

    engine.injectPointClick(0);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);

    engine.injectPointClick(2, { metaKey: true, shiftKey: false });
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'c']);

    // shift acts like meta; result stays in accepted-base order (b between a and c).
    engine.injectPointClick(1, { metaKey: false, shiftKey: true });
    expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b', 'c']);

    // Toggling a selected id removes it.
    engine.injectPointClick(0, { metaKey: true, shiftKey: false });
    expect(instance.store.getState().selection.nodeIds).toEqual(['b', 'c']);

    // A plain click collapses back to a single id.
    engine.injectPointClick(1, { metaKey: false, shiftKey: false });
    expect(instance.store.getState().selection.nodeIds).toEqual(['b']);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[1]]);
  });

  it('background click clears ALL namespaces but leaves hidden/pins alone', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    const engine = engines[0]!;

    instance.setSelection({ nodeIds: ['a'], edgeIds: [eid('a', 'b')], groupIds: [] });
    instance.hideNodes(['b']);
    instance.pinNode('a', [1, 2]);

    let backgroundClicks = 0;
    instance.on('backgroundClick', () => backgroundClicks++);
    engine.injectPointClick(null);

    const state = instance.store.getState();
    expect(backgroundClicks).toBe(1);
    expect(state.selection).toEqual({ nodeIds: [], edgeIds: [], groupIds: [] });
    expect(state.hiddenNodeIds).toEqual(new Set(['b']));
    expect(state.pins.get('a')).toEqual([1, 2]);
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([null]);
  });
});

describe('GraphInstance pin slice', () => {
  it('pinNode/unpinNode/clearPins mirror mapped indices to setPinnedIndices', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c']) });
    const engine = engines[0]!;

    instance.pinNode('b', [7, 8]);
    expect(instance.store.getState().pins.get('b')).toEqual([7, 8]);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[1]]);

    // Without coordinates the current engine position is used (FakeEngine
    // seeded 'a' at (0,0)).
    instance.pinNode('a');
    expect(instance.store.getState().pins.get('a')).toEqual([0, 0]);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[1, 0]]);
    expect(engine.pinnedIndices).toEqual([1, 0]);

    // Unknown ids are dropped silently.
    const before = instance.store.getState();
    instance.pinNode('zz', [1, 1]);
    expect(instance.store.getState()).toBe(before);

    instance.unpinNode('b');
    expect(instance.store.getState().pins.has('b')).toBe(false);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[0]]);

    instance.clearPins();
    expect(instance.store.getState().pins.size).toBe(0);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([null]);
    expect(engine.pinnedIndices).toBeNull();
  });

  it('pins survive detach and are re-pushed to a fresh engine on re-attach', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    instance.pinNode('b', [3, 4]);

    instance.detach();
    expect(instance.store.getState().pins.get('b')).toEqual([3, 4]);

    await instance.attach(container);
    const fresh = engines[1]!;
    expect(callsOf(fresh, 'setPinnedIndices').at(-1)!.args).toEqual([[1]]);
    expect(fresh.pinnedIndices).toEqual([1]);
  });
});

describe('GraphInstance snapshot-swap survival & pruning', () => {
  it('prunes departed ids from selection/hidden/pins in ONE publish; survivors keep state with fresh indices', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c'], [
        ['a', 'b'],
        ['b', 'c'],
      ]),
    });

    instance.setSelection({
      nodeIds: ['a', 'b'],
      edgeIds: [eid('a', 'b'), eid('b', 'c')],
      groupIds: [],
    });
    instance.hideNodes(['c']);
    instance.pinNode('a', [1, 2]);
    instance.pinNode('b', [3, 4]);
    engine.injectPointHover(1); // hover 'b'

    let notifications = 0;
    instance.store.subscribe(() => notifications++);

    // rev 2 drops 'a' (and edge a→b); keeps b, c; adds d. New base: b,c,d.
    instance.applyHostUpdate({ data: snap(2, ['b', 'c', 'd'], [['b', 'c']]) });

    expect(notifications).toBe(1); // pruning lands in the SAME publish
    const state = instance.store.getState();
    expect(state.selection).toEqual({ nodeIds: ['b'], edgeIds: [eid('b', 'c')], groupIds: [] });
    expect(state.hiddenNodeIds).toEqual(new Set(['c']));
    expect([...state.pins.entries()]).toEqual([['b', [3, 4]]]);

    // highlight remap: surviving ids re-pushed with FRESH indices
    // ('b' moved from index 1 to index 0).
    expect(callsOf(engine, 'setSelectedIndices').at(-1)!.args).toEqual([[0]]);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[0]]);
    expect(callsOf(engine, 'setFocusedIndex').at(-1)!.args).toEqual([0]);
  });

  it('an identical-structure revision does not disturb interaction slices', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    const engine = engines[0]!;

    instance.selectNodes(['a']);
    instance.pinNode('b', [5, 6]);
    const selBefore = instance.store.getState().selection;
    const pinsBefore = instance.store.getState().pins;
    const pinPushes = callsOf(engine, 'setPinnedIndices').length;

    // Same ids/edges, new revision: no structural change, nothing pruned.
    instance.applyHostUpdate({ data: snap(2, ['a', 'b'], [['a', 'b']]) });
    expect(instance.store.getState().selection).toBe(selBefore);
    expect(instance.store.getState().pins).toBe(pinsBefore);
    expect(callsOf(engine, 'setPinnedIndices')).toHaveLength(pinPushes);
  });
});

describe('GraphInstance controlled-mode intents for v0.3 mutators', () => {
  it('every node-namespace mutator emits intent without writing nodeIds or pushing the engine', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c'], [['a', 'b']]),
      selection: ['a'],
    });

    const intents: Array<readonly NodeId[]> = [];
    instance.on('selectionChange', (p) => intents.push(p.nodeIds));
    const pushesBefore = callsOf(engine, 'setSelectedIndices').length;

    instance.selectNodes(['b']);
    instance.selectAll();
    instance.invertSelection(); // vs the CONTROLLED store value ['a']
    instance.selectNeighbors('a');
    engine.injectPointClick(1, { metaKey: true, shiftKey: false }); // toggle intent
    instance.clearSelection();

    expect(intents).toEqual([
      ['b'],
      ['a', 'b', 'c'],
      ['b', 'c'],
      ['a', 'b'],
      ['a', 'b'],
      [],
    ]);
    // The node namespace never moved and was never re-pushed.
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
    expect(callsOf(engine, 'setSelectedIndices')).toHaveLength(pushesBefore);
  });

  it('edge namespace stays instance-internal under controlled selection', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b'], [['a', 'b']]),
      selection: ['a'],
    });

    const intents: SelectionState[] = [];
    instance.on('selectionChange', (p) => intents.push(p));
    const pushesBefore = callsOf(engine, 'setSelectedIndices').length;

    instance.selectEdges([eid('a', 'b')]);
    // Edge selection IS written; nodeIds stays host-owned.
    expect(instance.store.getState().selection).toEqual({
      nodeIds: ['a'],
      edgeIds: [eid('a', 'b')],
      groupIds: [],
    });
    expect(intents).toEqual([{ nodeIds: ['a'], edgeIds: [eid('a', 'b')], groupIds: [] }]);
    expect(callsOf(engine, 'setSelectedIndices')).toHaveLength(pushesBefore);
  });

  it('hide and pin slices remain instance-owned under controlled selection', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']), selection: ['a'] });

    instance.hideNodes(['b']);
    instance.pinNode('a', [9, 9]);
    expect(instance.store.getState().hiddenNodeIds).toEqual(new Set(['b']));
    expect(instance.store.getState().pins.get('a')).toEqual([9, 9]);
    expect(callsOf(engine, 'setPinnedIndices').at(-1)!.args).toEqual([[0]]);
  });
});

describe('GraphInstance diagnostics & reads', () => {
  it('surfaces validation and accessor diagnostics through the store', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);

    instance.applyHostUpdate({
      data: {
        datasetKey: 'ds',
        sourceRevision: 1,
        nodes: [{ id: 'a' }, { id: 'a' }, { id: 'b' }],
        edges: [{ source: 'a', target: 'missing' }],
      },
      nodeColor: 'not-a-color',
    });

    const codes = instance.getDiagnostics().map((d) => d.code);
    expect(codes).toContain('duplicate-node-id');
    expect(codes).toContain('dangling-edge-endpoint');
    expect(codes).toContain('accessor-error');
    expect(instance.getDiagnostics()).toBe(instance.store.getState().diagnostics);
  });

  it('exposes typed reads: getNode, getVisibleNodeIds, getRevisions', async () => {
    const { instance } = makeInstance();
    instance.applyHostUpdate({ data: snap(3, ['a', 'b']) });

    expect(instance.getNode('a')).toMatchObject({ id: 'a', attrs: { label: 'A' } });
    expect(instance.getNode('zz')).toBeUndefined();
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    expect(instance.getRevisions()).toEqual({
      source: 3,
      model: 1,
      scope: 1,
      render: 1,
      appliedRender: null,
    });
  });
});
