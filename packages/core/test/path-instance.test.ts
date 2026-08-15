/**
 * findPath/clearPath instance wiring: atomic
 * emphasis (ONE link commit + ONE setSelectedIndices per application),
 * ownership release on clearPath / selection mutation / undo / scene
 * rebuild, history neutrality, and revision admission for late results.
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type { GraphSnapshot } from '../src/types';
import { container } from './helpers';

type NA = Record<string, never>;
type EA = Record<string, never>;

/** a→b→c→d chain plus a spur c→e. */
function snap(rev: number): GraphSnapshot<NA, EA> {
  return {
    datasetKey: 'ds',
    sourceRevision: rev,
    nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })),
    edges: [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'bc', source: 'b', target: 'c' },
      { id: 'cd', source: 'c', target: 'd' },
      { id: 'ce', source: 'c', target: 'e' },
    ],
  };
}

async function rig() {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NA, EA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
  });
  await instance.attach(container);
  instance.applyHostUpdate({ data: snap(1), linkColor: 'white' });
  return { instance, engine: engines[0]! };
}

const linkAlpha = (buf: Float32Array, k: number): number => buf[4 * k + 3]!;

describe('findPath wiring', () => {
  it('applies emphasis as ONE link commit + ONE highlight push; dim complement at mutedAlpha', async () => {
    const { instance, engine } = await rig();
    const commitsBefore = engine.commits.length;
    const selCallsBefore = engine.calls.filter((c) => c.method === 'setSelectedIndices').length;

    const path = await instance.findPath('a', 'd');
    expect(path).not.toBeNull();
    expect(path!.nodeIds).toEqual(['a', 'b', 'c', 'd']);
    expect(path!.edgeIds).toEqual(['ab', 'bc', 'cd']);

    expect(engine.commits.length).toBe(commitsBefore + 1); // ONE commit
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeUndefined();
    expect(commit.restart).toBeUndefined();
    const lc = commit.buffers!.linkColor!;
    // Path edges ab/bc/cd keep full alpha; the spur ce dims to mutedAlpha.
    expect(linkAlpha(lc, 0)).toBe(1);
    expect(linkAlpha(lc, 2)).toBe(1);
    expect(linkAlpha(lc, 3)).toBeCloseTo(instance.store.getState().theme.mutedAlpha, 5);

    const selCalls = engine.calls.filter((c) => c.method === 'setSelectedIndices');
    expect(selCalls.length).toBe(selCallsBefore + 1);
    expect(selCalls[selCalls.length - 1]!.args[0]).toEqual([0, 1, 2, 3]);
    expect(instance.getActivePath()).toBe(path);
  });

  it('unreachable resolves null — no emphasis, no commit, no rejection', async () => {
    const { instance, engine } = await rig();
    const before = engine.commits.length;
    // d is a sink: nothing outgoing from d reaches a.
    const path = await instance.findPath('d', 'a');
    expect(path).toBeNull();
    expect(engine.commits.length).toBe(before);
    expect(instance.getActivePath()).toBeNull();
  });

  it('clearPath restores the selection highlight and the undimmed link lane', async () => {
    const { instance, engine } = await rig();
    instance.selectNodes(['e']);
    await instance.findPath('a', 'd');
    instance.clearPath();

    const lc = engine.lastCommit!.buffers!.linkColor!;
    expect(linkAlpha(lc, 3)).toBe(1); // spur restored
    const selCalls = engine.calls.filter((c) => c.method === 'setSelectedIndices');
    // Last push is the SELECTION again (e = index 4), not the path.
    expect(selCalls[selCalls.length - 1]!.args[0]).toEqual([4]);
    expect(instance.getActivePath()).toBeNull();
    instance.clearPath(); // idempotent
  });

  it('ANY selection mutation releases the path (highlight + link lane)', async () => {
    const { instance, engine } = await rig();
    await instance.findPath('a', 'd');
    expect(instance.getActivePath()).not.toBeNull();

    instance.selectNodes(['b']);
    expect(instance.getActivePath()).toBeNull();
    const lc = [...engine.commits].reverse().find((c) => c.buffers?.linkColor)!.buffers!
      .linkColor!;
    expect(linkAlpha(lc, 3)).toBe(1); // dim complement released
  });

  it('findPath is history-neutral; undo clears the active path', async () => {
    const { instance } = await rig();
    instance.hideNodes(['e']); // one real history entry
    const depths = instance.store.getState().history;

    await instance.findPath('a', 'd');
    expect(instance.store.getState().history).toEqual(depths); // no new entry

    expect(instance.undo()).toBe(true);
    expect(instance.getActivePath()).toBeNull();
  });

  it('a result arriving after a dataset replacement is discarded (typed rejection)', async () => {
    await rig(); // this case builds its own service-backed instance below
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const slowService = {
      revisionDependencies: ['source', 'model'] as const,
      find: async () => {
        await gate;
        return { nodeIds: ['a', 'b'], edgeIds: ['ab'] };
      },
    };
    const engines: FakeEngine[] = [];
    const withService = createGraphInstance<NA, EA>({
      engine: () => {
        const e = new FakeEngine();
        engines.push(e);
        return e;
      },
      services: { path: slowService },
    });
    await withService.attach(container);
    withService.applyHostUpdate({ data: snap(1) });

    const pending = withService.findPath('a', 'b');
    const rejection = expect(pending).rejects.toMatchObject({
      detail: { code: 'aborted', cause: 'stale' },
    });
    // Dataset replacement lands while the service is in flight.
    withService.applyHostUpdate({
      data: { datasetKey: 'ds2', sourceRevision: 1, nodes: [{ id: 'a' }], edges: [] },
    });
    release();
    await rejection;
    expect(withService.getActivePath()).toBeNull();
  });

  it('a scene rebuild drops path state silently (stale link indices never dim)', async () => {
    const { instance } = await rig();
    await instance.findPath('a', 'd');
    instance.applyHostUpdate({ data: snap(2) }); // model change → rebuild
    expect(instance.getActivePath()).toBeNull();
  });
});
