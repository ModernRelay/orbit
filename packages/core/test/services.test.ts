import { describe, expect, it } from 'vitest';
import { OrbitOperationError } from '../src/errors';
import { buildAcceptedAdjacency } from '../src/scope';
import {
  PendingExpansions,
  admitServiceResult,
  createLocalExpansionService,
  createRequestContext,
  nextRequestId,
  serviceCacheKey,
} from '../src/services';
import type { LocalExpansionBase, RevisionSnapshot } from '../src/services';
import type {
  AcceptedGraph,
  ExpansionBatch,
  RequestContext,
  RevisionDimension,
} from '../src/types';

const DIMS: readonly RevisionDimension[] = ['source', 'model', 'scope'];

function revs(source: number | string | null, model: number, scope: number): RevisionSnapshot {
  return { source, model, scope };
}

function accepted(
  ids: readonly string[],
  links: ReadonlyArray<readonly [string, string]> = [],
): AcceptedGraph {
  return {
    datasetKey: 'ds',
    sourceRevision: 1,
    nodes: ids.map((id) => ({ id })),
    edges: links.map(([source, target], i) => ({ id: `e${i}`, source, target })),
    nodeIndex: new Map(ids.map((id, i) => [id, i] as const)),
    diagnostics: [],
  };
}

function baseOf(graph: AcceptedGraph): LocalExpansionBase {
  return { accepted: graph, adjacency: buildAcceptedAdjacency(graph) };
}

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    datasetKey: 'ds',
    sourceRevision: 1,
    modelRevision: 0,
    scopeRevision: 0,
    requestId: 'r1',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function isDirectBatch(
  r: Awaited<ReturnType<ReturnType<typeof createLocalExpansionService>['neighbors']>>,
): r is ExpansionBatch & { provenance?: unknown } {
  return !('batches' in r);
}

describe('createRequestContext', () => {
  it('snapshots dataset + revision dimensions and carries the request id', () => {
    const handle = createRequestContext({
      datasetKey: 'ds',
      revisions: revs('r7', 3, 2),
      requestId: 'req-explicit',
    });
    expect(handle.context).toMatchObject({
      datasetKey: 'ds',
      sourceRevision: 'r7',
      modelRevision: 3,
      scopeRevision: 2,
      requestId: 'req-explicit',
    });
    expect(handle.context.signal.aborted).toBe(false);
  });

  it('generates unique request ids when omitted', () => {
    const a = createRequestContext({ datasetKey: 'ds', revisions: revs(null, 0, 0) });
    const b = createRequestContext({ datasetKey: 'ds', revisions: revs(null, 0, 0) });
    expect(a.context.requestId).not.toBe(b.context.requestId);
    expect(nextRequestId('x')).not.toBe(nextRequestId('x'));
  });

  it('abort() trips the context signal with the given reason', () => {
    const handle = createRequestContext({ datasetKey: 'ds', revisions: revs(null, 0, 0) });
    handle.abort('collapsed');
    expect(handle.context.signal.aborted).toBe(true);
    expect(handle.context.signal.reason).toBe('collapsed');
  });

  it('chains a parent signal (pre-aborted and later-aborted)', () => {
    const pre = new AbortController();
    pre.abort('teardown');
    const a = createRequestContext({
      datasetKey: 'ds',
      revisions: revs(null, 0, 0),
      parentSignal: pre.signal,
    });
    expect(a.context.signal.aborted).toBe(true);
    expect(a.context.signal.reason).toBe('teardown');

    const later = new AbortController();
    const b = createRequestContext({
      datasetKey: 'ds',
      revisions: revs(null, 0, 0),
      parentSignal: later.signal,
    });
    expect(b.context.signal.aborted).toBe(false);
    later.abort('now');
    expect(b.context.signal.aborted).toBe(true);
    expect(b.context.signal.reason).toBe('now');
  });
});

describe('admitServiceResult', () => {
  it('exhaustive truth table: admit iff no DECLARED dimension drifted', () => {
    const at = revs('s0', 10, 20);
    const drifted = { source: 's1', model: 11, scope: 21 } as const;

    // All 8 declared subsets x all 8 drift subsets.
    for (let d = 0; d < 8; d++) {
      const declared = DIMS.filter((_, i) => (d >> i) & 1);
      for (let f = 0; f < 8; f++) {
        const driftSet = new Set(DIMS.filter((_, i) => (f >> i) & 1));
        const now = revs(
          driftSet.has('source') ? drifted.source : at.source,
          driftSet.has('model') ? drifted.model : at.model,
          driftSet.has('scope') ? drifted.scope : at.scope,
        );
        const want = declared.every((dim) => !driftSet.has(dim));
        expect(
          admitServiceResult({ declared, at, now }),
          `declared=[${declared.join(',')}] drift=[${[...driftSet].join(',')}]`,
        ).toBe(want);
      }
    }
  });

  it('declaring nothing admits under arbitrary drift', () => {
    expect(
      admitServiceResult({ declared: [], at: revs(null, 0, 0), now: revs('z', 99, 99) }),
    ).toBe(true);
  });

  it('source drift includes null <-> value and string changes', () => {
    expect(
      admitServiceResult({ declared: ['source'], at: revs(null, 0, 0), now: revs(0, 0, 0) }),
    ).toBe(false);
    expect(
      admitServiceResult({ declared: ['source'], at: revs('a', 0, 0), now: revs('b', 0, 0) }),
    ).toBe(false);
    expect(
      admitServiceResult({ declared: ['source'], at: revs('a', 0, 0), now: revs('a', 5, 9) }),
    ).toBe(true);
  });
});

describe('serviceCacheKey', () => {
  const revisions = revs('s1', 4, 7);

  it('is stable across params key order (canonical JSON), recursively', () => {
    const a = serviceCacheKey({
      serviceId: 'expansion',
      params: { hops: 2, seeds: ['a', 'b'], opts: { x: 1, y: 2 } },
      datasetKey: 'ds',
      declared: ['source'],
      revisions,
    });
    const b = serviceCacheKey({
      serviceId: 'expansion',
      params: { opts: { y: 2, x: 1 }, seeds: ['a', 'b'], hops: 2 },
      datasetKey: 'ds',
      declared: ['source'],
      revisions,
    });
    expect(a).toBe(b);
  });

  it('array order in params is significant (it is data)', () => {
    const a = serviceCacheKey({
      serviceId: 's',
      params: { seeds: ['a', 'b'] },
      datasetKey: 'ds',
      declared: [],
      revisions,
    });
    const b = serviceCacheKey({
      serviceId: 's',
      params: { seeds: ['b', 'a'] },
      datasetKey: 'ds',
      declared: [],
      revisions,
    });
    expect(a).not.toBe(b);
  });

  it('declared revision drift changes the key; undeclared drift does not', () => {
    const args = {
      serviceId: 'expansion',
      params: { seeds: ['a'] },
      datasetKey: 'ds',
      declared: ['source'] as const,
      revisions: revs('s1', 4, 7),
    };
    const key = serviceCacheKey(args);
    // Undeclared model/scope drift: same key.
    expect(serviceCacheKey({ ...args, revisions: revs('s1', 5, 9) })).toBe(key);
    // Declared source drift: new key.
    expect(serviceCacheKey({ ...args, revisions: revs('s2', 4, 7) })).not.toBe(key);
    // null source is distinct from a value.
    expect(serviceCacheKey({ ...args, revisions: revs(null, 4, 7) })).not.toBe(key);
  });

  it('includes service identity and datasetKey', () => {
    const common = { params: { q: 1 }, declared: [] as const, revisions };
    const a = serviceCacheKey({ serviceId: 'search', datasetKey: 'ds', ...common });
    expect(serviceCacheKey({ serviceId: 'metrics', datasetKey: 'ds', ...common })).not.toBe(a);
    expect(serviceCacheKey({ serviceId: 'search', datasetKey: 'other', ...common })).not.toBe(a);
  });

  it('declaration-list order and duplicates do not affect the key', () => {
    const common = { serviceId: 's', params: null, datasetKey: 'ds', revisions };
    const a = serviceCacheKey({ ...common, declared: ['source', 'model'] });
    const b = serviceCacheKey({ ...common, declared: ['model', 'source', 'model'] });
    expect(a).toBe(b);
  });

  it('treats undefined-valued param keys as absent and undefined params as null', () => {
    const common = { serviceId: 's', datasetKey: 'ds', declared: [] as const, revisions };
    const a = serviceCacheKey({ ...common, params: { q: 1, missing: undefined } });
    const b = serviceCacheKey({ ...common, params: { q: 1 } });
    expect(a).toBe(b);
    expect(serviceCacheKey({ ...common, params: undefined })).toBe(
      serviceCacheKey({ ...common, params: null }),
    );
  });
});

describe('createLocalExpansionService', () => {
  // a-b-c-d path, e branch off b, isolated f.
  const graph = accepted(
    ['a', 'b', 'c', 'd', 'e', 'f'],
    [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['b', 'e'],
    ],
  );

  it('declares revisionDependencies [source]', () => {
    const service = createLocalExpansionService(() => baseOf(graph));
    expect(service.revisionDependencies).toEqual(['source']);
  });

  it('returns the closed 1-hop neighborhood (seeds included, edges among them)', async () => {
    const service = createLocalExpansionService(() => baseOf(graph));
    const r = await service.neighbors(['b'], 1, ctx());
    if (!isDirectBatch(r)) throw new Error('expected a direct batch');
    expect(r.nodes?.map((n) => n.id)).toEqual(['a', 'b', 'c', 'e']);
    expect(r.edges?.map((e) => e.id)).toEqual(['e0', 'e1', 'e3']);
  });

  it('walks the FULL accepted base, including currently out-of-scope nodes', async () => {
    // Simulate a hard scope of just ['a','b']: the service must still reach
    // c (1 hop from b) because it walks the base, not the scene.
    const service = createLocalExpansionService(() => baseOf(graph));
    const r = await service.neighbors(['b'], 1, ctx());
    if (!isDirectBatch(r)) throw new Error('expected a direct batch');
    const ids = new Set(r.nodes?.map((n) => n.id));
    expect(ids.has('c')).toBe(true);
    expect(ids.has('e')).toBe(true);
  });

  it('hops 2 reaches d; unknown seeds resolve empty; hops 0 returns seeds', async () => {
    const service = createLocalExpansionService(() => baseOf(graph));

    const two = await service.neighbors(['b'], 2, ctx());
    if (!isDirectBatch(two)) throw new Error('expected a direct batch');
    expect(two.nodes?.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);

    const unknown = await service.neighbors(['zzz'], 3, ctx());
    if (!isDirectBatch(unknown)) throw new Error('expected a direct batch');
    expect(unknown.nodes).toEqual([]);
    expect(unknown.edges).toEqual([]);

    const zero = await service.neighbors(['a', 'b'], 0, ctx());
    if (!isDirectBatch(zero)) throw new Error('expected a direct batch');
    expect(zero.nodes?.map((n) => n.id)).toEqual(['a', 'b']);
    expect(zero.edges?.map((e) => e.id)).toEqual(['e0']);
  });

  it('re-reads the base thunk on every call (lazy wiring)', async () => {
    let current = baseOf(accepted(['a']));
    let calls = 0;
    const service = createLocalExpansionService(() => {
      calls++;
      return current;
    });

    const first = await service.neighbors(['a'], 1, ctx());
    if (!isDirectBatch(first)) throw new Error('expected a direct batch');
    expect(first.nodes?.map((n) => n.id)).toEqual(['a']);

    current = baseOf(accepted(['a', 'x'], [['a', 'x']]));
    const second = await service.neighbors(['a'], 1, ctx());
    if (!isDirectBatch(second)) throw new Error('expected a direct batch');
    expect(second.nodes?.map((n) => n.id)).toEqual(['a', 'x']);
    expect(calls).toBe(2);
  });

  it('rejects with OrbitOperationError {code:aborted} on a pre-aborted signal', async () => {
    let thunkCalls = 0;
    const service = createLocalExpansionService(() => {
      thunkCalls++;
      return baseOf(graph);
    });
    const controller = new AbortController();
    controller.abort('collapsed');
    const promise = service.neighbors(['b'], 1, ctx({ signal: controller.signal }));
    await expect(promise).rejects.toBeInstanceOf(OrbitOperationError);
    await promise.catch((error: unknown) => {
      expect((error as OrbitOperationError).detail).toEqual({
        code: 'aborted',
        cause: 'collapsed',
      });
    });
    expect(thunkCalls).toBe(0); // abort short-circuits before touching the base
  });

  it('omits cause when the abort reason is undefined-shaped', async () => {
    const service = createLocalExpansionService(() => baseOf(graph));
    const fakeSignal = { aborted: true, reason: undefined } as unknown as AbortSignal;
    const promise = service.neighbors(['b'], 1, ctx({ signal: fakeSignal }));
    await expect(promise).rejects.toBeInstanceOf(OrbitOperationError);
    await promise.catch((error: unknown) => {
      expect((error as OrbitOperationError).detail).toEqual({ code: 'aborted' });
    });
  });
});

describe('PendingExpansions', () => {
  it('first register is new; a same-id register coalesces onto the pending request', () => {
    const pending = new PendingExpansions();
    expect(pending.register('a', 'r1')).toEqual({ kind: 'new' });
    expect(pending.register('a', 'r2')).toEqual({ kind: 'coalesced', onto: 'r1' });
    expect(pending.register('a', 'r3')).toEqual({ kind: 'coalesced', onto: 'r1' });
    expect(pending.requestIdFor('a')).toBe('r1');
    expect(pending.size).toBe(1);
  });

  it('distinct ids run concurrently (each registers as new)', () => {
    const pending = new PendingExpansions();
    expect(pending.register('a', 'r1')).toEqual({ kind: 'new' });
    expect(pending.register('b', 'r2')).toEqual({ kind: 'new' });
    expect(pending.ids()).toEqual(new Set(['a', 'b']));
    // Resolving one leaves the other in flight.
    expect(pending.resolve('a')).toBe(true);
    expect(pending.has('a')).toBe(false);
    expect(pending.has('b')).toBe(true);
  });

  it('resolve clears the slot; a later same-id register is new again', () => {
    const pending = new PendingExpansions();
    pending.register('a', 'r1');
    expect(pending.resolve('a', 'r1')).toBe(true);
    expect(pending.register('a', 'r9')).toEqual({ kind: 'new' });
    expect(pending.requestIdFor('a')).toBe('r9');
  });

  it('a stale resolve (wrong requestId) does not clear a newer request', () => {
    const pending = new PendingExpansions();
    pending.register('a', 'r1');
    pending.abort('a');
    pending.register('a', 'r2');
    expect(pending.resolve('a', 'r1')).toBe(false); // r1 completing late
    expect(pending.has('a')).toBe(true);
    expect(pending.resolve('a', 'r2')).toBe(true);
  });

  it('abort returns the in-flight request id and clears; unknown id returns null', () => {
    const pending = new PendingExpansions();
    pending.register('a', 'r1');
    expect(pending.abort('a')).toBe('r1');
    expect(pending.has('a')).toBe(false);
    expect(pending.abort('a')).toBeNull();
    expect(pending.resolve('missing')).toBe(false);
  });

  it('ids() returns a snapshot, not a live view', () => {
    const pending = new PendingExpansions();
    pending.register('a', 'r1');
    const snapshot = pending.ids();
    pending.resolve('a');
    expect(snapshot).toEqual(new Set(['a']));
    expect(pending.ids()).toEqual(new Set());
  });
});
