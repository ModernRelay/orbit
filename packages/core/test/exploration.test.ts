import { describe, expect, it, vi } from 'vitest';
import { createGraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing';
import type { ExpansionResponse, ExpansionService, GraphSnapshot, RequestContext } from '../src/types';
import { container } from './helpers';

const snapshot = (revision = 1): GraphSnapshot => ({
  datasetKey: 'explore', sourceRevision: revision,
  nodes: ['a', 'b', 'c', 'd', 'e', 'isolated'].map((id) => ({ id })),
  edges: [
    { id: 'ab', source: 'a', target: 'b', attrs: { 'orbit:type': 'works' } },
    { id: 'ab2', source: 'a', target: 'b', attrs: { 'orbit:type': 'owns' } },
    { id: 'ac', source: 'a', target: 'c', attrs: { 'orbit:type': 'works' } },
    { id: 'da', source: 'd', target: 'a', attrs: { 'orbit:type': 'works' } },
    { id: 'ce', source: 'c', target: 'e', attrs: { 'orbit:type': 'works' } },
  ],
});

async function rig(service?: ExpansionService) {
  const engine = new FakeEngine();
  const instance = createGraphInstance({ engine: () => engine, fitViewOnFirstData: false,
    ...(service === undefined ? {} : { services: { expansion: service } }),
  });
  await instance.attach(container);
  instance.applyHostUpdate({ data: snapshot() });
  return { instance, engine };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const options = { direction: 'outgoing', relationshipTypeField: 'orbit:type', relationshipTypes: ['works'], limit: 1 } as const;
const response = (id: string): ExpansionResponse => ({ nodes: [{ id }], edges: [{ id: `a-${id}`, source: 'a', target: id }], page: { returnedNodes: 1, returnedEdges: 1, truncated: false } });

describe('passive neighborhood inspection', () => {
  it('returns directional/type counts, bounded rows, and visibility without a write or engine call', async () => {
    const { instance, engine } = await rig();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b', 'c'] } });
    instance.hideNodes(['b']);
    const before = instance.store.getState();
    const calls = engine.calls.length;
    const result = instance.getNeighborhood('a', { relationshipTypeField: 'orbit:type', limit: 2, edgeLimit: 1 });
    expect(result.nodes.map((n) => n.id)).toEqual(['b', 'c']);
    expect(result.visibility.get('b')).toBe('filtered');
    expect(result.visibility.get('c')).toBe('visible');
    expect(result.relationshipTypes).toEqual([{ type: 'works', count: 3 }, { type: 'owns', count: 1 }]);
    expect(result.totalNeighbors).toBe(3);
    expect(result.totalEdges).toBe(4);
    expect(result.edges).toHaveLength(1);
    expect(result.edgesTruncated).toBe(true);
    const last = instance.getNeighborhood('a', { relationshipTypeField: 'orbit:type', limit: 2, edgeLimit: 1, cursor: result.nextCursor! });
    expect(last.nodes.map((n) => n.id)).toEqual(['d']);
    expect(last.visibility.get('d')).toBe('out-of-scope');
    expect(instance.store.getState()).toBe(before);
    expect(engine.calls.length).toBe(calls);
    instance.destroy();
  });

  it('honors loaded vs visible, relationship types, incoming direction, and unknown nodes', async () => {
    const { instance } = await rig();
    instance.hideNodes(['b']);
    expect(instance.getNeighborhood('a', { ...options, limit: 50 }).nodes.map((n) => n.id)).toEqual(['b', 'c']);
    expect(instance.getNeighborhood('a', { ...options, visibility: 'visible' }).nodes.map((n) => n.id)).toEqual(['c']);
    expect(instance.getNeighborhood('a', { ...options, direction: 'incoming' }).nodes.map((n) => n.id)).toEqual(['d']);
    expect(instance.getNeighborhood('missing').status).toBe('not-loaded');
    instance.destroy();
  });

  it('rejects invalid bounds and changed-query/revision cursors without mutation', async () => {
    const { instance } = await rig();
    const result = instance.getNeighborhood('a', { limit: 1 });
    const before = instance.store.getState();
    expect(() => instance.getNeighborhood('a', { limit: 0 })).toThrow(/limit/);
    expect(() => instance.getNeighborhood('a', { limit: 2, cursor: result.nextCursor! })).toThrow(/cursor/);
    expect(instance.store.getState()).toBe(before);
    instance.hideNodes(['b']);
    expect(() => instance.getNeighborhood('a', { limit: 1, cursor: result.nextCursor! })).toThrow(/cursor/);
    instance.destroy();
  });

  it('visible relationship inspection applies edge hide rules, including parallel rows', async () => {
    const { instance } = await rig();
    instance.applyHostUpdate({ filter: { edges: (edge) => edge.id !== 'ab2', mode: 'hide' } });
    const result = instance.getNeighborhood('a', { visibility: 'visible' });
    expect(result.edges.map((e) => e.id)).toEqual(['ab', 'ac', 'da']);
    expect(instance.getNeighborhood('a').totalEdges).toBe(4);
    instance.destroy();
  });
});

describe('bounded expansion queries', () => {
  it('loads stable pages with exact counts, preserves scope intent, and retracts only the newest page', async () => {
    const { instance } = await rig();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a'] } });
    const first = await instance.expandNode('a', options);
    expect(first).toMatchObject({ added: 1, page: { returnedNodes: 1, returnedEdges: 1, totalNeighbors: 2, truncated: true } });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    const second = await instance.expandNode('a', { ...options, cursor: first.page!.nextCursor! });
    expect(second).toMatchObject({ added: 1, page: { totalNeighbors: 2, truncated: false } });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
    expect(instance.store.getState().scope).toEqual({ seedIds: ['a'] });
    instance.retractExpansion('a');
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    expect(instance.getExpansionOverlays('a')).toHaveLength(1);
    instance.destroy();
  });

  it('reports pages for noops and rejects changed source/query continuations', async () => {
    const { instance } = await rig();
    const first = await instance.expandNode('a', options);
    expect(first).toMatchObject({ noop: true, page: { totalNeighbors: 2 } });
    expect(instance.getExpansionOverlays('a')).toHaveLength(0);
    const model = instance.getRevisions().model;
    await expect(instance.expandNode('a', { ...options, direction: 'incoming', cursor: first.page!.nextCursor! })).rejects.toMatchObject({ detail: { code: 'invalid-operation' } });
    expect(instance.getRevisions().model).toBe(model);
    instance.applyHostUpdate({ data: snapshot(2) });
    await expect(instance.expandNode('a', { ...options, cursor: first.page!.nextCursor! })).rejects.toMatchObject({ detail: { code: 'invalid-operation' } });
    instance.destroy();
  });

  it('exposes copied live record identities through undo and redo', async () => {
    const { instance } = await rig();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a'] } });
    await instance.expandNode('a', options);
    const records = instance.getExpansionRecords();
    const id = records[0]!.overlayId;
    expect(id).toBeTypeOf('string');
    (records[0]!.addedNodeIds as string[]).push('external');
    expect(instance.getExpansionRecords()[0]!.addedNodeIds).toEqual(['b']);
    instance.undo();
    expect(instance.getExpansionRecords()).toEqual([]);
    expect(instance.getExpansionOverlays('a')).toHaveLength(1);
    instance.redo();
    expect(instance.getExpansionRecords()[0]!.overlayId).toBe(id);
    instance.destroy();
  });

  it('sends completion progress to every coalesced caller', async () => {
    const gate = deferred<ExpansionResponse>();
    const service: ExpansionService = { revisionDependencies: ['source'], neighbors: async () => ({}), queryNeighbors: () => gate.promise };
    const { instance } = await rig(service);
    const one = vi.fn(); const two = vi.fn();
    const pending = instance.expandNode('a', { limit: 1, onProgress: one });
    expect(instance.expandNode('a', { onProgress: two, limit: 1 })).toBe(pending);
    gate.resolve(response('new')); await pending;
    for (const callback of [one, two]) expect(callback).toHaveBeenCalledWith(expect.objectContaining({ status: 'committed' }));
    instance.destroy();
  });

  it('coalesces equal semantic queries and notifies both observers; different queries supersede', async () => {
    const gates: ReturnType<typeof deferred<ExpansionResponse>>[] = [];
    const contexts: RequestContext[] = [];
    const service: ExpansionService = { revisionDependencies: ['source'], neighbors: async () => ({}), queryNeighbors(_ids, _opts, ctx) {
      contexts.push(ctx); const gate = deferred<ExpansionResponse>(); gates.push(gate); return gate.promise;
    } };
    const { instance } = await rig(service);
    const observer1 = vi.fn(); const observer2 = vi.fn();
    const first = instance.expandNode('a', { limit: 1, relationshipTypes: ['x', 'y'], onProgress: observer1 });
    const again = instance.expandNode('a', { relationshipTypes: ['y', 'x'], limit: 1, hops: 1, onProgress: observer2 });
    expect(first).toBe(again);
    expect(gates).toHaveLength(1);
    const rejection = expect(first).rejects.toMatchObject({ detail: { code: 'aborted' } });
    const next = instance.expandNode('a', { limit: 2, onProgress: observer2 });
    await rejection;
    expect(contexts[0]!.signal.aborted).toBe(true);
    gates[0]!.resolve(response('stale'));
    gates[1]!.resolve(response('fresh'));
    await next;
    expect(instance.getNode('stale')).toBeUndefined();
    expect(instance.getNode('fresh')).toBeDefined();
    expect(observer2).toHaveBeenCalledWith(expect.objectContaining({ status: 'committed', receivedNodes: 1 }));
    instance.destroy();
  });

  it('validates before canceling a pending query and rejects rich options on legacy services', async () => {
    const gate = deferred<ExpansionResponse>();
    const service: ExpansionService = { revisionDependencies: ['source'], neighbors: () => gate.promise };
    const { instance } = await rig(service);
    const pending = instance.expandNode('a');
    const before = instance.store.getState();
    await expect(instance.expandNode('a', { limit: 0 })).rejects.toMatchObject({ detail: { code: 'invalid-operation' } });
    await expect(instance.expandNode('a', { limit: 1 })).rejects.toMatchObject({ detail: { code: 'unsupported-operation' } });
    expect(instance.store.getState()).toBe(before);
    gate.resolve({ nodes: [{ id: 'new' }] });
    await pending;
    expect(instance.getNode('new')).toBeDefined();
    instance.destroy();
  });

  it('cancelExpansion preserves committed pages and discards a late ignored-abort response', async () => {
    const gates: ReturnType<typeof deferred<ExpansionResponse>>[] = [];
    const service: ExpansionService = { revisionDependencies: ['source'], neighbors: async () => ({}), queryNeighbors() { const gate = deferred<ExpansionResponse>(); gates.push(gate); return gate.promise; } };
    const { instance } = await rig(service);
    const first = instance.expandNode('a', { limit: 1 }); gates[0]!.resolve(response('first')); await first;
    const pending = instance.expandNode('a', { limit: 1 });
    const rejected = expect(pending).rejects.toMatchObject({ detail: { code: 'aborted' } });
    instance.cancelExpansion('a');
    await rejected;
    gates[1]!.resolve(response('late'));
    await new Promise((r) => setTimeout(r, 0));
    expect(instance.getExpansionOverlays('a')).toHaveLength(1);
    expect(instance.getNode('first')).toBeDefined();
    expect(instance.getNode('late')).toBeUndefined();
    expect(instance.store.getState().pendingExpansions.size).toBe(0);
    instance.destroy();
  });

  it('rejects streaming budget excess atomically and reports progress before publication', async () => {
    const seenModels: number[] = [];
    const service: ExpansionService = { revisionDependencies: ['source'], neighbors: async () => ({}), queryNeighbors: async () => ({
      page: { returnedNodes: 2, returnedEdges: 0, truncated: false },
      batches: (async function* () { yield { nodes: [{ id: 'one' }] }; yield { nodes: [{ id: 'two' }] }; })(),
    }) };
    const { instance } = await rig(service);
    const model = instance.getRevisions().model;
    await expect(instance.expandNode('a', { limit: 1, onProgress: () => { seenModels.push(instance.getRevisions().model); } })).rejects.toMatchObject({ detail: { code: 'invalid-operation' } });
    expect(seenModels).toEqual([model, model]);
    expect(instance.getRevisions().model).toBe(model);
    expect(instance.getNode('one')).toBeUndefined();
    expect(instance.getOverlayIds()).toEqual([]);
    instance.destroy();
  });

  it('requires honest metadata and rejects edge budget excess before graph mutation', async () => {
    const service: ExpansionService = { revisionDependencies: ['source'], neighbors: async () => ({}), queryNeighbors: async () => ({ ...response('new'), edges: [{ source: 'a', target: 'new' }, { source: 'a', target: 'new' }] }) };
    const { instance } = await rig(service);
    const model = instance.getRevisions().model;
    await expect(instance.expandNode('a', { limit: 1, edgeLimit: 1 })).rejects.toMatchObject({ detail: { code: 'invalid-operation' } });
    expect(instance.getRevisions().model).toBe(model);
    expect(instance.getNode('new')).toBeUndefined();
    instance.destroy();
  });

  it('holds established positions and camera through settle, preserves user pins, and releases on resume', async () => {
    const { instance, engine } = await rig();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a'] } });
    engine.nudgePositions(30, 40);
    const before = Array.from(engine.getPositions()!);
    const cameraCalls = engine.cameraCalls.length;
    await instance.expandNode('a', { ...options, preserveLayout: true });
    expect(Array.from(engine.getPositions()!).slice(0, 2)).toEqual(before);
    expect(engine.pinnedIndices).toContain(0);
    instance.pinNodes(['b']);
    engine.injectSimulationEnd();
    expect(engine.pinnedIndices).toEqual([1, 0]);
    expect(engine.cameraCalls).toHaveLength(cameraCalls);
    instance.resumeSimulation();
    expect(engine.pinnedIndices).toEqual([1]);
    instance.destroy();
  });

  it('remaps landmark pins through scope changes and history, and clears them on a new dataset', async () => {
    const { instance, engine } = await rig();
    instance.applyHostUpdate({ subgraph: { seedIds: ['c'] } });
    await instance.expandNode('c', { limit: 1, preserveLayout: true });
    engine.injectSimulationEnd();
    // The expansion returns a before c in accepted order: c's pinned index changes.
    expect(engine.pinnedIndices).toEqual([1]);
    instance.undo();
    expect(engine.pinnedIndices).toEqual([0]);
    instance.redo();
    expect(engine.pinnedIndices).toEqual([1]);
    instance.applyHostUpdate({ data: { ...snapshot(), datasetKey: 'other' } });
    expect(engine.pinnedIndices).toBeNull();
    instance.destroy();
  });
});

describe('detailed path queries', () => {
  it('distinguishes missing/filtered endpoints, loaded paths, unreachable, and hop limits passively', async () => {
    const { instance, engine } = await rig();
    instance.hideNodes(['c']);
    const before = instance.store.getState(); const calls = engine.calls.length;
    expect(await instance.findPathDetailed('a', 'missing')).toEqual({ status: 'not-loaded', nodeIds: ['missing'] });
    expect(await instance.findPathDetailed('a', 'c')).toEqual({ status: 'filtered', nodeIds: ['c'] });
    expect(await instance.findPathDetailed('a', 'e')).toEqual({ status: 'filtered', nodeIds: ['c'] });
    expect(await instance.findPathDetailed('a', 'e', { universe: 'loaded' })).toEqual({ status: 'found', path: { nodeIds: ['a', 'c', 'e'], edgeIds: ['ac', 'ce'] } });
    expect(await instance.findPathDetailed('a', 'e', { universe: 'loaded', maxHops: 1 })).toEqual({ status: 'hop-limit' });
    expect(await instance.findPathDetailed('a', 'isolated', { universe: 'loaded' })).toEqual({ status: 'unreachable' });
    expect(instance.store.getState()).toBe(before); expect(engine.calls.length).toBe(calls);
    instance.destroy();
  });

  it('traverses exact relationship fields and direction, handles zero hops, and keeps legacy emphasis', async () => {
    const { instance } = await rig();
    expect(await instance.findPathDetailed('b', 'a', { direction: 'incoming', relationshipTypeField: 'orbit:type', relationshipTypes: ['owns'] })).toEqual({ status: 'found', path: { nodeIds: ['b', 'a'], edgeIds: ['ab2'] } });
    expect(await instance.findPathDetailed('a', 'a', { maxHops: 0 })).toMatchObject({ status: 'found' });
    expect(await instance.findPathDetailed('a', 'b', { maxHops: 0 })).toEqual({ status: 'hop-limit' });
    expect(await instance.findPath('a', 'e', { relationshipTypeField: 'orbit:type', relationshipTypes: ['works'] })).toEqual({ nodeIds: ['a', 'c', 'e'], edgeIds: ['ac', 'ce'] });
    expect(instance.getActivePath()?.nodeIds).toEqual(['a', 'c', 'e']);
    instance.destroy();
  });

  it('rejects rich options for legacy services without superseding an admitted in-flight path', async () => {
    const gate = deferred<{ nodeIds: string[]; edgeIds: string[] }>();
    const engine = new FakeEngine();
    const instance = createGraphInstance({ engine: () => engine, services: { path: { revisionDependencies: ['source'], find: () => gate.promise } } });
    await instance.attach(container); instance.applyHostUpdate({ data: snapshot() });
    const pending = instance.findPath('a', 'b');
    await expect(instance.findPath('a', 'c', { universe: 'loaded' })).rejects.toMatchObject({ detail: { code: 'unsupported-operation' } });
    gate.resolve({ nodeIds: ['a', 'b'], edgeIds: ['ab'] });
    await pending;
    expect(instance.getActivePath()?.nodeIds).toEqual(['a', 'b']);
    instance.destroy();
  });
});
