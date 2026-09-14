import { describe, expect, it } from 'vitest';
import { createGraphInstance } from '../src/instance';
import { createInvestigationSession } from '../src/investigation';
import type { ExpansionService } from '../src/types';
import { FakeEngine } from '../src/testing/FakeEngine';
import { container } from './helpers';

async function rig(baseIds = ['a'], pages = ['b', 'c', 'd']) {
  let generation = 0;
  const cursors = new Map<string, number>();
  const service: ExpansionService = {
    revisionDependencies: ['source'],
    neighbors: async () => ({ nodes: [], edges: [] }),
    queryNeighbors: async (_seeds, query) => {
      const offset = query.cursor === undefined ? 0 : cursors.get(query.cursor);
      if (offset === undefined) throw new Error('Unknown cursor');
      const id = pages[offset]!;
      const nextCursor = offset + 1 < pages.length ? `page-${++generation}` : undefined;
      if (nextCursor !== undefined) cursors.set(nextCursor, offset + 1);
      return {
        nodes: [{ id, attrs: {} }],
        edges: [{ id: `a${id}`, source: 'a', target: id, attrs: {} }],
        page: {
          returnedNodes: 1, returnedEdges: 1, totalNeighbors: pages.length,
          truncated: nextCursor !== undefined,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        },
      };
    },
  };
  const instance = createGraphInstance({
    engine: () => new FakeEngine(), fitViewOnFirstData: false, services: { expansion: service },
  });
  instance.applyHostUpdate({
    data: {
      datasetKey: 'history', sourceRevision: 1,
      nodes: baseIds.map((id, x) => ({ id, x, y: 0, attrs: {} })),
      edges: baseIds.filter((id) => id !== 'a').map((id) => ({ id: `a${id}`, source: 'a', target: id, attrs: {} })),
    },
    layout: 'fixed',
  });
  await instance.attach(container);
  const session = createInvestigationSession(instance);
  return { instance, session, dispose: () => { session.destroy(); instance.destroy(); } };
}

const query = { limit: 1 };

describe('investigation no-op history dependencies', () => {
  it('does not replay a duplicate first page after its contribution was undone', async () => {
    const { instance, session, dispose } = await rig();
    try {
      await session.expandNode('a', query);
      expect(await session.expandNode('a', query)).toMatchObject({ noop: true });
      instance.undo();
      expect(instance.getVisibleNodeIds()).toEqual(['a']);
      const saved = await session.checkpoint();
      expect(saved.expansions).toEqual([]);
      await session.restoreCheckpoint(saved);
      expect(instance.getVisibleNodeIds()).toEqual(['a']);
    } finally { dispose(); }
  });

  it('restores the duplicate recipe on redo together with its contribution', async () => {
    const { instance, session, dispose } = await rig();
    try {
      await session.expandNode('a', query);
      await session.expandNode('a', query);
      instance.undo();
      expect(session.store.getState().expansions).toEqual([]);
      instance.redo();
      expect(session.store.getState().expansions.map((action) => action.continuation)).toEqual([false, false]);
      const saved = await session.checkpoint();
      await session.restoreCheckpoint(saved);
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
      session.retractExpansion('a');
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
      session.retractExpansion('a');
      expect(instance.getVisibleNodeIds()).toEqual(['a']);
    } finally { dispose(); }
  });

  it('keeps base-only pagination prerequisites when a later contribution is undone', async () => {
    const { instance, session, dispose } = await rig(['a', 'b', 'c']);
    try {
      const first = await session.expandNode('a', query);
      expect(first).toMatchObject({ noop: true });
      const second = await session.expandNode('a', { ...query, cursor: first.page!.nextCursor! });
      expect(second).toMatchObject({ noop: true });
      await session.expandNode('a', { ...query, cursor: second.page!.nextCursor! });
      instance.undo();
      const saved = await session.checkpoint();
      expect(saved.expansions.map((action) => action.continuation)).toEqual([false, true]);
      await session.restoreCheckpoint(saved);
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
    } finally { dispose(); }
  });

  it('binds a restarted query to its live predecessor instead of an undone older chain', async () => {
    const { instance, session, dispose } = await rig();
    try {
      const first = await session.expandNode('a', query);
      await session.expandNode('a', { ...query, cursor: first.page!.nextCursor! });
      instance.undo();
      const restarted = await session.expandNode('a', query);
      expect(restarted).toMatchObject({ noop: true });
      await session.expandNode('a', { ...query, cursor: restarted.page!.nextCursor! });
      const saved = await session.checkpoint();
      expect(saved.expansions.map((action) => action.continuation)).toEqual([false, false, true]);
      await session.restoreCheckpoint(saved);
      expect([...instance.getVisibleNodeIds()].sort()).toEqual(['a', 'b', 'c']);
    } finally { dispose(); }
  });

  it('does not attach a continuation from an undone restart to an earlier first page', async () => {
    const { instance, session, dispose } = await rig(['a', 'b']);
    try {
      const first = await session.expandNode('a', query);
      await session.expandNode('a', { ...query, cursor: first.page!.nextCursor! });
      const restarted = await session.expandNode('a', query);
      expect(await session.expandNode('a', { ...query, cursor: restarted.page!.nextCursor! })).toMatchObject({ noop: true });
      instance.undo();
      const saved = await session.checkpoint();
      expect(saved.expansions.map((action) => action.continuation)).toEqual([false]);
      await session.restoreCheckpoint(saved);
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    } finally { dispose(); }
  });
});
