import { describe, expect, it } from 'vitest';

import { callsOf, container, makeInstance, snap } from './helpers';

describe('GraphInstance layout transitions', () => {
  it('force → fixed freezes, banks, and commits the latest engine positions', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;

    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    expect(h.instance.store.getState().simulationRunning).toBe(true);
    engine.nudgePositions(7, 5);

    const callsBefore = engine.calls.length;
    const commitsBefore = engine.commits.length;
    const revisionsBefore = h.instance.getRevisions();

    h.instance.applyHostUpdate({ layout: 'fixed' });

    expect(engine.commits).toHaveLength(commitsBefore + 1);
    const commit = engine.lastCommit!;
    expect(commit.restart).toBeUndefined();
    expect(commit.structure).toBeDefined();
    expect(Array.from(commit.structure!.positions)).toEqual([7, 5, 17, 5]);
    expect(engine.calls.slice(callsBefore).map((call) => call.method)).toEqual([
      'pause',
      'getPositions',
      'commit',
      'appliedRevision',
    ]);

    const state = h.instance.store.getState();
    expect(state.simulationRunning).toBe(false);
    expect(state.revisions.render).toBe(revisionsBefore.render + 1);
    expect(state.revisions.appliedRender).toBe(state.revisions.render);
  });

  it('fixed → force reheats with alpha 1 without resending unchanged structure', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({
      data: snap(1, ['a', 'b'], [['a', 'b']]),
      layout: 'fixed',
    });

    const callsBefore = engine.calls.length;
    const commitsBefore = engine.commits.length;
    const positionReadsBefore = callsOf(engine, 'getPositions').length;
    const revisionsBefore = h.instance.getRevisions();

    h.instance.applyHostUpdate({ layout: 'force' });

    expect(engine.commits).toHaveLength(commitsBefore + 1);
    expect(engine.lastCommit).toEqual({
      revision: revisionsBefore.render + 1,
      restart: { alpha: 1 },
    });
    expect(callsOf(engine, 'getPositions')).toHaveLength(positionReadsBefore);
    expect(callsOf(engine, 'start')).toHaveLength(0);
    expect(engine.calls.slice(callsBefore).map((call) => call.method)).toEqual([
      'commit',
      'appliedRevision',
    ]);
    expect(h.instance.store.getState().simulationRunning).toBe(true);
  });

  it('force → fixed folds data and config changes into the frozen structure commit', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    engine.nudgePositions(4, 6);

    const commitsBefore = engine.commits.length;
    const pausesBefore = callsOf(engine, 'pause').length;
    const positionReadsBefore = callsOf(engine, 'getPositions').length;
    const revisionsBefore = h.instance.getRevisions();

    h.instance.applyHostUpdate({
      data: snap(2, ['a', 'b', 'c'], [
        ['a', 'b'],
        ['b', 'c'],
      ]),
      layout: 'fixed',
      simulation: { gravity: 0.25 },
      theme: { background: '#101010' },
    });

    expect(engine.commits).toHaveLength(commitsBefore + 1);
    expect(callsOf(engine, 'pause')).toHaveLength(pausesBefore + 1);
    expect(callsOf(engine, 'getPositions')).toHaveLength(positionReadsBefore + 1);
    const commit = engine.lastCommit!;
    expect(commit.restart).toBeUndefined();
    expect(commit.config).toEqual({
      simulation: { gravity: 0.25 },
      backgroundColor: '#101010',
    });
    expect(commit.structure!.pointCount).toBe(3);
    expect(Array.from(commit.structure!.positions)).toEqual([4, 6, 14, 6, NaN, NaN]);

    const state = h.instance.store.getState();
    expect(state.simulationRunning).toBe(false);
    expect(state.revisions.model).toBe(revisionsBefore.model + 1);
    expect(state.revisions.render).toBe(revisionsBefore.render + 1);
  });

  it('validates combined data + force → fixed updates before pausing or mutating state', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    const ingest = h.instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: 1,
    });

    const invalid = snap(2, ['a', 'b']);
    const validationError = new Error('hostile nodes getter');
    Object.defineProperty(invalid, 'nodes', {
      get() {
        throw validationError;
      },
    });

    const stateBefore = h.instance.store.getState();
    const callsBefore = engine.calls.length;
    const commitsBefore = engine.commits.length;

    expect(() =>
      h.instance.applyHostUpdate({
        data: invalid,
        layout: 'fixed',
      }),
    ).toThrow(validationError);

    expect(engine.calls).toHaveLength(callsBefore);
    expect(engine.commits).toHaveLength(commitsBefore);
    expect(h.instance.store.getState()).toBe(stateBefore);
    expect(h.instance.store.getState().simulationRunning).toBe(true);
    expect(ingest.state).toBe('open');

    // The rejected transition did not even change the private layout kind:
    // the next structural update still follows the force restart path.
    h.instance.applyHostUpdate({ data: snap(3, ['a', 'b', 'c'], [['a', 'b']]) });
    expect(engine.lastCommit!.restart).toEqual({ alpha: 1 });
  });

  it('fixed → force combines a data/config commit with one full reheat', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    const engine = h.engines[0]!;
    h.instance.applyHostUpdate({
      data: snap(1, ['a', 'b'], [['a', 'b']]),
      layout: 'fixed',
    });

    const commitsBefore = engine.commits.length;
    const revisionsBefore = h.instance.getRevisions();
    h.instance.applyHostUpdate({
      data: snap(2, ['a', 'b', 'c'], [
        ['a', 'b'],
        ['b', 'c'],
      ]),
      layout: 'force',
      simulation: { repulsion: 0.75 },
    });

    expect(engine.commits).toHaveLength(commitsBefore + 1);
    const commit = engine.lastCommit!;
    expect(commit.structure!.pointCount).toBe(3);
    expect(commit.config).toEqual({ simulation: { repulsion: 0.75 } });
    expect(commit.restart).toEqual({ alpha: 1 });
    expect(callsOf(engine, 'start')).toHaveLength(0);

    const state = h.instance.store.getState();
    expect(state.simulationRunning).toBe(true);
    expect(state.revisions.model).toBe(revisionsBefore.model + 1);
    expect(state.revisions.render).toBe(revisionsBefore.render + 1);
    expect(state.revisions.appliedRender).toBe(state.revisions.render);
  });
});
