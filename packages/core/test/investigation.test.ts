import { describe, expect, it, vi } from 'vitest';
import { createGraphInstance } from '../src/instance';
import { createInvestigationSession, parseInvestigation, serializeInvestigation } from '../src/investigation';
import type { GraphInvestigation } from '../src/investigation';
import type { ExpansionQuery, ExpansionService, GraphSnapshot } from '../src/types';
import { FakeEngine } from '../src/testing/FakeEngine';
import { container } from './helpers';

type N = { label: string };
type E = { type: string };
const data: GraphSnapshot<N, E> = {
  datasetKey: 'investigation', sourceRevision: 'v1',
  nodes: [{ id: 'a', x: 0, y: 0, attrs: { label: 'Acme' } }, { id: 'b', x: 30, y: 20, attrs: { label: 'Beta' } }],
  edges: [{ id: 'ab', source: 'a', target: 'b', attrs: { type: 'SUPPLIES' } }],
};

async function rig(service?: ExpansionService<N, E>, initial = data) {
  const engine = new FakeEngine();
  const instance = createGraphInstance<N, E>({
    engine: () => engine, fitViewOnFirstData: false,
    ...(service === undefined ? {} : { services: { expansion: service } }),
  });
  instance.applyHostUpdate({ data: initial, layout: 'fixed', dataRef: { dataset: initial.datasetKey, revision: initial.sourceRevision } });
  await instance.attach(container);
  return { instance, engine };
}

describe('investigation checkpoints', () => {
  it('round-trips notes, search/table intent, ordered evidence, selection, scope and positions', async () => {
    const { instance } = await rig();
    const session = createInvestigationSession(instance, { now: () => new Date('2026-09-05T00:00:00Z') });
    try {
      session.setTitle('Supplier overlap');
      session.setNotes('Acme supplies Beta. Verify the contract date.');
      session.setSearchQuery('Acme');
      session.setTableQuery('Beta');
      instance.selectNodes(['a']);
      session.savePath({ sourceId: 'a', targetId: 'b', options: { direction: 'outgoing', universe: 'loaded' }, path: { nodeIds: ['a', 'b'], edgeIds: ['ab'] } });
      const saved = await session.checkpoint();
      expect(saved.view.positions).toEqual([['a', 0, 0], ['b', 30, 20]]);
      expect(saved.source).toEqual({ datasetKey: 'investigation', sourceRevision: 'v1', dataRef: { dataset: 'investigation', revision: 'v1' } });
      expect(parseInvestigation(session.exportCheckpoint(saved.id))).toEqual(saved);
      expect(Object.isFrozen(saved.paths[0]!.path.nodeIds)).toBe(true);
      session.setNotes('Changed');
      session.setTableQuery('Changed');
      session.removePath(saved.paths[0]!.id);
      instance.hideNodes(['a']);
      instance.applyHostUpdate({ subgraph: { seedIds: ['b'], hops: 0 } });
      await session.restoreCheckpoint(saved.id);
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
      expect(instance.store.getState().selection.nodeIds).toEqual(['a']);
      expect(session.store.getState()).toMatchObject({ title: 'Supplier overlap', notes: saved.notes, searchQuery: 'Acme', tableQuery: 'Beta', paths: saved.paths, activeCheckpointId: saved.id, status: 'idle' });
    } finally { session.destroy(); instance.destroy(); }
  });

  it('imports without applying and rejects invalid envelopes before a loader or graph mutation', async () => {
    const { instance } = await rig();
    const loadSource = vi.fn(async () => {});
    const session = createInvestigationSession(instance, { loadSource });
    try {
      const saved = await session.checkpoint('Original', { includePositions: false });
      instance.hideNodes(['b']);
      const before = instance.store.getState();
      const imported = session.importCheckpoint(serializeInvestigation(saved));
      expect(imported).toEqual(saved);
      expect(instance.store.getState()).toBe(before);
      const invalid = [
        { ...saved, v: 2 },
        { ...saved, source: { ...saved.source, datasetKey: 2 } },
        { ...saved, view: { ...saved.view, hiddenNodeIds: [42] } },
        { ...saved, expansions: [{ seedId: 'a', options: { cursor: 'ephemeral' }, continuation: false }] },
        { ...saved, expansions: [{ seedId: 'a', options: {}, continuation: true }] },
        { ...saved, paths: [{ id: 'p', title: 'Wrong endpoints', sourceId: 'a', targetId: 'b', options: {}, path: { nodeIds: ['a'], edgeIds: [] } }] },
        { ...saved, hostState: { predicate: () => true } },
      ];
      for (const value of invalid) {
        await expect(session.restoreCheckpoint(value as GraphInvestigation)).rejects.toMatchObject({ code: 'invalid-investigation' });
        expect(instance.store.getState()).toBe(before);
      }
      expect(loadSource).not.toHaveBeenCalled();
    } finally { session.destroy(); instance.destroy(); }
  });

  it('requires the exact source and lets a host load it before applying the saved view', async () => {
    const { instance } = await rig();
    const plain = createInvestigationSession(instance);
    let restoredHost: unknown;
    const session = createInvestigationSession(() => instance, {
      loadSource: async (source) => {
        expect(source.sourceRevision).toBe('v1');
        instance.applyHostUpdate({ data, dataRef: source.dataRef! });
      },
      captureHostState: () => ({ relationship: 'SUPPLIES' }),
      restoreHostState: (state) => { restoredHost = state; },
    });
    try {
      const basic = await plain.checkpoint();
      const saved = await session.checkpoint();
      instance.applyHostUpdate({ data: { ...data, sourceRevision: 'v2' }, dataRef: { dataset: 'investigation', revision: 'v2' } });
      const before = instance.store.getState();
      await expect(plain.restoreCheckpoint(basic)).rejects.toMatchObject({ code: 'source-mismatch' });
      expect(instance.store.getState()).toBe(before);
      await session.restoreCheckpoint(saved);
      expect(instance.getSource()).toEqual({ datasetKey: 'investigation', sourceRevision: 'v1' });
      expect(restoredHost).toEqual({ relationship: 'SUPPLIES' });
      expect(session.store.getState().activeCheckpointId).toBe(saved.id);
    } finally { plain.destroy(); session.destroy(); instance.destroy(); }
  });

  it('rejects an incorrect loader result without applying the checkpoint', async () => {
    const { instance } = await rig();
    const session = createInvestigationSession(instance, { loadSource: async () => {} });
    try {
      const saved = await session.checkpoint();
      instance.applyHostUpdate({ data: { ...data, datasetKey: 'different' }, dataRef: null });
      const before = instance.store.getState();
      await expect(session.restoreCheckpoint(saved)).rejects.toMatchObject({ code: 'source-mismatch' });
      expect(instance.store.getState()).toBe(before);
      expect(session.store.getState()).toMatchObject({ status: 'idle', activeCheckpointId: null });
    } finally { session.destroy(); instance.destroy(); }
  });

  it('honors pre-cancellation without starting a source load or publishing session changes', async () => {
    const { instance } = await rig();
    const loadSource = vi.fn(async () => {});
    const session = createInvestigationSession(instance, { loadSource });
    try {
      const saved = await session.checkpoint();
      instance.applyHostUpdate({ data: { ...data, datasetKey: 'other' } });
      const controller = new AbortController();
      controller.abort();
      const before = session.store.getState();
      await expect(session.restoreCheckpoint(saved, { signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
      expect(session.store.getState()).toBe(before);
      expect(loadSource).not.toHaveBeenCalled();
    } finally { session.destroy(); instance.destroy(); }
  });

  it('keeps checkpoints while discarding source-specific evidence on a new source', async () => {
    const { instance } = await rig();
    const session = createInvestigationSession(instance);
    try {
      session.savePath({ sourceId: 'a', targetId: 'b', path: { nodeIds: ['a', 'b'], edgeIds: ['ab'] } });
      const saved = await session.checkpoint();
      instance.applyHostUpdate({ data: { ...data, sourceRevision: 'v2' } });
      expect(session.store.getState()).toMatchObject({ paths: [], activeCheckpointId: null });
      const next = await session.checkpoint('Next');
      expect(next.paths).toEqual([]);
      expect(session.store.getState().checkpoints.map((c) => c.id)).toEqual([saved.id, next.id]);
    } finally { session.destroy(); instance.destroy(); }
  });

  it('rebinds a getter after remount and detaches the previous source subscription', async () => {
    const first = await rig();
    const second = await rig(undefined, { ...data, datasetKey: 'replacement' });
    let current = first.instance;
    const session = createInvestigationSession(() => current);
    try {
      session.savePath({ sourceId: 'a', targetId: 'b', path: { nodeIds: ['a', 'b'], edgeIds: ['ab'] } });
      const saved = await session.checkpoint();
      current = second.instance;
      session.refreshSource();
      expect(session.store.getState()).toMatchObject({ paths: [], checkpoints: [saved], activeCheckpointId: null });
      const before = session.store.getState();
      first.instance.applyHostUpdate({ data: { ...data, sourceRevision: 'old-instance-change' } });
      expect(session.store.getState()).toBe(before);
      session.destroy();
      second.instance.applyHostUpdate({ data: { ...data, sourceRevision: 'after-destroy' } });
      expect(session.store.getState()).toBe(before);
    } finally { session.destroy(); first.instance.destroy(); second.instance.destroy(); }
  });
});

describe('replayable expansion requests', () => {
  function pagedService() {
    const requests: ExpansionQuery[] = [];
    const cursors = new Map<string, number>();
    let generation = 0;
    const service: ExpansionService<N, E> = {
      revisionDependencies: ['source'],
      neighbors: async () => ({ nodes: [], edges: [] }),
      queryNeighbors: async (_seeds, query, context) => {
        if (context.signal.aborted) throw new Error('aborted');
        requests.push({ ...query });
        const offset = query.cursor === undefined ? 0 : cursors.get(query.cursor);
        if (offset === undefined) throw new Error('Unknown continuation');
        const id = ['b', 'c'][offset]!;
        const nextCursor = offset === 0 ? `cursor-${++generation}` : undefined;
        if (nextCursor !== undefined) cursors.set(nextCursor, 1);
        return {
          nodes: [{ id, attrs: { label: id } }],
          edges: [{ id: `a${id}`, source: 'a', target: id, attrs: { type: 'SUPPLIES' } }],
          page: { returnedNodes: 1, returnedEdges: 1, totalNeighbors: 2, truncated: nextCursor !== undefined, ...(nextCursor === undefined ? {} : { nextCursor }) },
        };
      },
    };
    return { service, requests };
  }

  it('regenerates opaque continuation cursors when replaying saved expansions', async () => {
    const { service, requests } = pagedService();
    const { instance } = await rig(service, { ...data, nodes: [data.nodes[0]!], edges: [] });
    const session = createInvestigationSession(instance);
    try {
      const options = { direction: 'outgoing' as const, relationshipTypes: ['SUPPLIES'], limit: 1, preserveLayout: true };
      const first = await session.expandNode('a', options);
      expect(first.page?.nextCursor).toBeDefined();
      await session.expandNode('a', { ...options, cursor: first.page!.nextCursor! });
      const saved = await session.checkpoint('Expanded suppliers');
      expect(saved.expansions.map((e) => e.continuation)).toEqual([false, true]);
      expect(serializeInvestigation(saved)).not.toContain('cursor-');
      await session.restoreCheckpoint(saved);
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
      expect(requests).toHaveLength(4);
      expect(requests[3]!.cursor).not.toBe(requests[1]!.cursor);
      session.retractExpansion('a');
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
      session.retractExpansion('a');
      expect(instance.getVisibleNodeIds()).toEqual(['a']);
    } finally { session.destroy(); instance.destroy(); }
  });

  it('does not retract an earlier contribution when the latest query was a no-op', async () => {
    const { service } = pagedService();
    const { instance } = await rig(service, { ...data, nodes: [data.nodes[0]!], edges: [] });
    const session = createInvestigationSession(instance);
    try {
      const options = { limit: 1 };
      await session.expandNode('a', options);
      const again = await session.expandNode('a', options);
      expect(again).toMatchObject({ noop: true });
      session.retractExpansion('a');
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
      session.retractExpansion('a');
      expect(instance.getVisibleNodeIds()).toEqual(['a']);
    } finally { session.destroy(); instance.destroy(); }
  });

  it('saves the live expansion recipe after undo and redo', async () => {
    const { service } = pagedService();
    const { instance } = await rig(service, { ...data, nodes: [data.nodes[0]!], edges: [] });
    const session = createInvestigationSession(instance);
    try {
      await session.expandNode('a', { limit: 1 });
      instance.undo();
      expect(session.store.getState().expansions).toEqual([]);
      expect((await session.checkpoint()).expansions).toEqual([]);
      instance.redo();
      expect(session.store.getState().expansions).toHaveLength(1);
      const saved = await session.checkpoint();
      await session.restoreCheckpoint(saved);
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    } finally { session.destroy(); instance.destroy(); }
  });

  it('retains the current investigation when a different source cannot be loaded', async () => {
    const { service } = pagedService();
    const { instance } = await rig(service, { ...data, nodes: [data.nodes[0]!], edges: [] });
    const session = createInvestigationSession(instance, { loadSource: async () => { throw new Error('Revision unavailable'); } });
    try {
      await session.expandNode('a', { limit: 1 });
      const saved = await session.checkpoint();
      const other = { ...saved, source: { ...saved.source, datasetKey: 'unavailable' } };
      const before = session.store.getState();
      await expect(session.restoreCheckpoint(other)).rejects.toThrow('Revision unavailable');
      expect(session.store.getState()).toMatchObject({ expansions: before.expansions, paths: before.paths, activeCheckpointId: saved.id });
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    } finally { session.destroy(); instance.destroy(); }
  });

  it('never retracts a newer same-seed contribution created outside the session', async () => {
    const { service } = pagedService();
    const { instance } = await rig(service, { ...data, nodes: [data.nodes[0]!], edges: [] });
    const session = createInvestigationSession(instance);
    try {
      const first = await session.expandNode('a', { limit: 1 });
      const saved = await session.checkpoint();
      await instance.expandNode('a', { limit: 1, cursor: first.page!.nextCursor! });
      const before = instance.store.getState();
      expect(() => session.retractExpansion('a')).toThrow(/outside this investigation/);
      await expect(session.restoreCheckpoint(saved)).rejects.toMatchObject({ code: 'untracked-expansion' });
      expect(instance.store.getState()).toBe(before);
      expect(session.store.getState().expansions).toHaveLength(1);
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
    } finally { session.destroy(); instance.destroy(); }
  });

  it('rejects untracked cursors before requesting or publishing anything', async () => {
    const { service, requests } = pagedService();
    const { instance } = await rig(service);
    const session = createInvestigationSession(instance);
    try {
      await expect(session.expandNode('a', { limit: 1, cursor: 'outside-session' })).rejects.toMatchObject({ code: 'untracked-cursor' });
      expect(requests).toEqual([]);
      expect(session.store.getState().expansions).toEqual([]);
    } finally { session.destroy(); instance.destroy(); }
  });

  it('cancels a replay request and leaves no restore-owned contribution', async () => {
    const { service } = pagedService();
    const { instance } = await rig(service, { ...data, nodes: [data.nodes[0]!], edges: [] });
    const session = createInvestigationSession(instance);
    try {
      await session.expandNode('a', { limit: 1 });
      const saved = await session.checkpoint();
      let begun!: () => void;
      const started = new Promise<void>((resolve) => { begun = resolve; });
      service.queryNeighbors = async (_ids, _query, context) => new Promise((_resolve, reject) => {
        begun();
        context.signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
      });
      // A different limit avoids the service cache populated while saving.
      const altered = { ...saved, expansions: [{ ...saved.expansions[0]!, options: { limit: 2 } }] };
      const abort = new AbortController();
      const restoring = session.restoreCheckpoint(altered, { signal: abort.signal });
      await started;
      abort.abort();
      await expect(restoring).rejects.toThrow(/abort|cancel/i);
      expect(instance.getVisibleNodeIds()).toEqual(['a']);
      expect(instance.store.getState().pendingExpansions.size).toBe(0);
      expect(session.store.getState()).toMatchObject({ status: 'idle', expansions: [], activeCheckpointId: null });
    } finally { session.destroy(); instance.destroy(); }
  });
});
