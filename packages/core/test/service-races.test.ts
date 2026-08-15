/**
 * service sequencing races — the exit gate.
 *
 * Admission — not the abort signal — is the correctness gate: a result whose
 * DECLARED revision dependencies drifted is discarded even when the service
 * ignored the AbortSignal. Also covers same-id coalescing (identical promise,
 * ONE service call), distinct-id concurrency with independent merges,
 * retractExpansion aborting the pending expansion (no merge on late resolve),
 * mid-stream batch failure rolling back ALL batches ('service-error', graph
 * untouched), rejected results leaving no pendingExpansions residue,
 * provenance visible in the removeOverlay bookkeeping, all-visible no-op,
 * local-scope accretion, and pinned accretion.
 *
 * NOTE on the cache assertion: v0.5 does NOT cache service results (the
 * serviceCacheKey seam in src/services.ts is ready but unwired), so the
 * "same params+revisions → no second call within one model revision" cache
 * assertion is deliberately DROPPED here; only in-flight same-id coalescing
 * dedupes calls. See src/instance.ts expansion section.
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { OrbitOperationError } from '../src/errors';
import { INGEST_MAX_PENDING_BYTES_DEFAULT } from '../src/ingestion';
import { FakeEngine } from '../src/testing/index';
import type {
  ExpansionResponse,
  ExpansionService,
  GraphSnapshot,
  RequestContext,
  RevisionDimension,
} from '../src/types';
import { container, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Instance = GraphInstance<NAttrs, EAttrs>;
type Response = ExpansionResponse<NAttrs, EAttrs>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** a—b—c—d chain under datasetKey 'ds'. */
const chain = (rev: number): GraphSnapshot<NAttrs, EAttrs> =>
  snap(rev, ['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['c', 'd']]);

function makeServiceInstance(service?: ExpansionService<NAttrs, EAttrs>) {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NAttrs, EAttrs>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
    ...(service !== undefined ? { services: { expansion: service } } : {}),
  });
  return { instance, engines };
}

/** A manually-gated service: each call records its context and awaits its own
 * deferred. Never reads ctx.signal — the "service that ignores abort". */
function gatedService(declared: readonly RevisionDimension[] = ['source']) {
  const contexts: RequestContext[] = [];
  const seeds: string[][] = [];
  const gates: Deferred<Response>[] = [];
  const service: ExpansionService<NAttrs, EAttrs> = {
    revisionDependencies: declared,
    neighbors(seedIds, _hops, ctx) {
      contexts.push(ctx);
      seeds.push([...seedIds]);
      const gate = deferred<Response>();
      gates.push(gate);
      return gate.promise;
    },
  };
  return { service, contexts, seeds, gates, calls: () => gates.length };
}

function codes(instance: Instance): string[] {
  return instance.getDiagnostics().map((d) => d.code);
}

describe('stale declared-revision results are discarded', () => {
  it('discards a late result after a source change even though the service ignored the signal', async () => {
    const { service, contexts, gates } = gatedService(['source']);
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });

    const p = instance.expandNode('b');
    const rejection = expect(p).rejects.toMatchObject({
      name: 'OrbitOperationError',
      detail: { code: 'aborted' },
    });
    // The RequestContext snapshots the issue-time revisions + carries a signal.
    const ctx = contexts[0]!;
    expect(ctx.datasetKey).toBe('ds');
    expect(ctx.sourceRevision).toBe(1);
    expect(ctx.modelRevision).toBe(1);
    expect(ctx.scopeRevision).toBe(1);
    expect(typeof ctx.requestId).toBe('string');
    expect(ctx.signal.aborted).toBe(false);
    expect(instance.store.getState().pendingExpansions.has('b')).toBe(true);

    // The declared dimension drifts under the in-flight call (same dataset,
    // new sourceRevision). Nothing aborts the service — it resolves late.
    instance.applyHostUpdate({ data: chain(2) });
    const modelAfter = instance.getRevisions().model;
    gates[0]!.resolve({ nodes: [{ id: 'z', attrs: { label: 'Z' } }] });

    await rejection;
    await flush();
    // No merge, no overlay, no revision advance — 'service-aborted' info only.
    expect(instance.getNode('z')).toBeUndefined();
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.getRevisions().model).toBe(modelAfter);
    expect(codes(instance)).toContain('service-aborted');
    expect(instance.store.getState().pendingExpansions.size).toBe(0);
    expect(instance.store.getState().status).not.toBe('error');
  });

  it('a service declaring NO dimensions survives the same drift and merges', async () => {
    const { service, gates } = gatedService([]);
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });

    const p = instance.expandNode('b');
    instance.applyHostUpdate({ data: chain(2) }); // same lineage, seed survives
    gates[0]!.resolve({
      nodes: [{ id: 'z', attrs: { label: 'Z' } }],
      edges: [{ id: 'b-z', source: 'b', target: 'z', attrs: { weight: 1 } }],
    });
    await expect(p).resolves.toEqual({ added: 1 });
    expect(instance.getNode('z')).toBeDefined();
  });
});

describe('coalescing and concurrency', () => {
  it('same-id coalescing returns the IDENTICAL promise and calls the service ONCE', async () => {
    const { service, gates, calls } = gatedService();
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });

    const p1 = instance.expandNode('b');
    const p2 = instance.expandNode('b');
    expect(p2).toBe(p1); // the identical promise object
    expect(calls()).toBe(1); // ONE service call serves both

    gates[0]!.resolve({
      nodes: [{ id: 'x', attrs: { label: 'X' } }],
      edges: [{ id: 'b-x', source: 'b', target: 'x', attrs: { weight: 1 } }],
    });
    await expect(p1).resolves.toEqual({ added: 1 });
    expect(instance.getNode('x')).toBeDefined();
    expect(instance.getOverlayIds()).toHaveLength(1);
    await flush();

    // Once settled, a new call issues a fresh request (no result caching in
    // v0.5 — see the file header note); everything is now visible → noop.
    const p3 = instance.expandNode('b');
    expect(p3).not.toBe(p1);
    expect(calls()).toBe(2);
    gates[1]!.resolve({
      nodes: [{ id: 'x', attrs: { label: 'X' } }],
      edges: [{ id: 'b-x', source: 'b', target: 'x', attrs: { weight: 1 } }],
    });
    await expect(p3).resolves.toEqual({ noop: true });
    expect(instance.getOverlayIds()).toHaveLength(1); // all-visible: no second session
  });

  it('distinct ids run concurrently and merge independently', async () => {
    const { service, seeds, gates, calls } = gatedService(['source']);
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });

    const pa = instance.expandNode('a');
    const pd = instance.expandNode('d');
    expect(pa).not.toBe(pd);
    expect(calls()).toBe(2);
    expect(seeds).toEqual([['a'], ['d']]);
    expect(instance.store.getState().pendingExpansions).toEqual(new Set(['a', 'd']));

    // Resolve out of order: d's merge advances the MODEL revision, but a's
    // result stays admissible — it declared only 'source' (independent
    // concurrent merging).
    gates[1]!.resolve({
      nodes: [{ id: 'y', attrs: { label: 'Y' } }],
      edges: [{ id: 'd-y', source: 'd', target: 'y', attrs: { weight: 1 } }],
    });
    await expect(pd).resolves.toEqual({ added: 1 });
    expect(instance.store.getState().pendingExpansions).toEqual(new Set(['a']));

    gates[0]!.resolve({
      nodes: [{ id: 'x', attrs: { label: 'X' } }],
      edges: [{ id: 'a-x', source: 'a', target: 'x', attrs: { weight: 1 } }],
    });
    await expect(pa).resolves.toEqual({ added: 1 });

    expect(instance.getNode('x')).toBeDefined();
    expect(instance.getNode('y')).toBeDefined();
    expect(instance.getOverlayIds()).toHaveLength(2);
    expect(instance.store.getState().pendingExpansions.size).toBe(0);
  });
});

describe('retractExpansion', () => {
  it('aborts the pending expansion: signal fires, promise rejects, late resolve never merges', async () => {
    const { service, contexts, gates } = gatedService();
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });

    const p = instance.expandNode('b');
    const rejection = expect(p).rejects.toMatchObject({ detail: { code: 'aborted' } });
    expect(contexts[0]!.signal.aborted).toBe(false);

    instance.retractExpansion('b');
    expect(contexts[0]!.signal.aborted).toBe(true); // abort as an optimization
    expect(instance.store.getState().pendingExpansions.size).toBe(0);
    await rejection;

    const modelBefore = instance.getRevisions().model;
    gates[0]!.resolve({ nodes: [{ id: 'x', attrs: { label: 'X' } }] }); // late
    await flush();
    expect(instance.getNode('x')).toBeUndefined(); // ownership check discards
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.getRevisions().model).toBe(modelBefore);
    expect(codes(instance)).toContain('service-aborted');
  });

  it('a collapse followed by a re-expand issues a FRESH request (no stale coalescing)', async () => {
    const { service, gates, calls } = gatedService();
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });

    const p1 = instance.expandNode('b');
    p1.catch(() => {}); // settled by the collapse below
    instance.retractExpansion('b');

    const p2 = instance.expandNode('b');
    expect(p2).not.toBe(p1);
    expect(calls()).toBe(2);
    // The FIRST (aborted) request resolving late must not clear or serve the
    // second one.
    gates[0]!.resolve({ nodes: [{ id: 'stale', attrs: { label: 'S' } }] });
    await flush();
    expect(instance.getNode('stale')).toBeUndefined();
    expect(instance.store.getState().pendingExpansions.has('b')).toBe(true);

    gates[1]!.resolve({ nodes: [{ id: 'x', attrs: { label: 'X' } }] });
    await expect(p2).resolves.toEqual({ added: 1 });
    expect(instance.getNode('x')).toBeDefined();
  });
});

describe('streaming + failure semantics', () => {
  it('mid-stream batch failure rolls back ALL batches: graph untouched, service-error, no error event', async () => {
    const boom = new Error('stream blew up');
    const service: ExpansionService<NAttrs, EAttrs> = {
      revisionDependencies: ['source'],
      neighbors: async () => ({
        provenance: { origin: 'stream' },
        batches: (async function* () {
          yield { nodes: [{ id: 'x', attrs: { label: 'X' } }] };
          yield { edges: [{ id: 'b-x', source: 'b', target: 'x', attrs: { weight: 1 } }] };
          throw boom;
        })(),
      }),
    };
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });
    const before = instance.getRevisions();
    const errorEvents: unknown[] = [];
    instance.on('error', (e) => errorEvents.push(e));

    await expect(instance.expandNode('b')).rejects.toBe(boom);
    await flush();

    // Atomic overlay session: nothing published, so the rollback leaves the
    // graph byte-for-byte untouched.
    expect(instance.getRevisions()).toEqual(before);
    expect(instance.getNode('x')).toBeUndefined();
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.getExpansionOverlays('b')).toEqual([]);
    expect(instance.store.getState().pendingExpansions.size).toBe(0);
    expect(codes(instance)).toContain('service-error');
    expect(errorEvents).toEqual([]); // no 'error' event, no status change
    expect(instance.store.getState().status).not.toBe('error');
  });

  it('a streamed result merges through ONE session, batch by batch', async () => {
    const service: ExpansionService<NAttrs, EAttrs> = {
      revisionDependencies: ['source'],
      neighbors: async () => ({
        provenance: { origin: 'stream' },
        batches: (async function* () {
          // Edge BEFORE its node — pending-endpoint rules apply because
          // the stream goes through a real IngestSession.
          yield { edges: [{ id: 'b-x', source: 'b', target: 'x', attrs: { weight: 1 } }] };
          yield { nodes: [{ id: 'x', attrs: { label: 'X' } }] };
        })(),
      }),
    };
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });

    await expect(instance.expandNode('b')).resolves.toEqual({ added: 1 });
    expect(instance.getNode('x')).toBeDefined();
    expect(instance.getOverlayIds()).toHaveLength(1);
    const record = instance.getExpansionOverlays('b')[0]!;
    expect(record.provenance).toEqual({ origin: 'stream' });
    expect(instance.store.getState().edgeCount).toBe(4); // b-x resolved
  });

  it('fails fast and rolls back when a stream exceeds the atomic staging budget', async () => {
    const halfBudgetLabel = 'x'.repeat(Math.floor(INGEST_MAX_PENDING_BYTES_DEFAULT / 2));
    const service: ExpansionService<NAttrs, EAttrs> = {
      revisionDependencies: ['source'],
      neighbors: async () => ({
        batches: (async function* () {
          yield { nodes: [{ id: 'x', attrs: { label: halfBudgetLabel } }] };
          yield { nodes: [{ id: 'y', attrs: { label: halfBudgetLabel } }] };
        })(),
      }),
    };
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });
    const before = instance.getRevisions();

    const detail = await instance.expandNode('b').then(
      () => {
        throw new Error('expected expansion to reject');
      },
      (error: unknown) => {
        expect(error).toBeInstanceOf(OrbitOperationError);
        return (error as OrbitOperationError).detail;
      },
    );
    expect(detail).toMatchObject({
      code: 'queue-overflow',
      limit: INGEST_MAX_PENDING_BYTES_DEFAULT,
    });
    if (detail.code !== 'queue-overflow') throw new Error('expected queue-overflow detail');
    expect(detail.queuedBytes).toBeGreaterThan(detail.limit);
    await flush();

    expect(instance.getRevisions()).toEqual(before);
    expect(instance.getNode('x')).toBeUndefined();
    expect(instance.getNode('y')).toBeUndefined();
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.store.getState().pendingExpansions.size).toBe(0);
  });

  it('a rejected service call leaves no pendingExpansions residue and no error event', async () => {
    const cause = new Error('backend down');
    const service: ExpansionService<NAttrs, EAttrs> = {
      revisionDependencies: ['source'],
      neighbors: () => Promise.reject(cause),
    };
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });
    const before = instance.getRevisions();
    const errorEvents: unknown[] = [];
    instance.on('error', (e) => errorEvents.push(e));

    await expect(instance.expandNode('b')).rejects.toBe(cause);
    await flush();

    expect(instance.store.getState().pendingExpansions.size).toBe(0);
    expect(instance.getRevisions()).toEqual(before);
    expect(codes(instance)).toContain('service-error');
    expect(errorEvents).toEqual([]);
    // A fresh expand after the failure works (no residue in the ledger).
    expect(instance.store.getState().pendingExpansions.has('b')).toBe(false);
  });
});

describe('provenance & removeOverlay bookkeeping', () => {
  it('the expansion overlay carries requestId + provenance, and removeOverlay clears both data and record', async () => {
    const service: ExpansionService<NAttrs, EAttrs> = {
      revisionDependencies: ['source'],
      neighbors: async () => ({
        nodes: [{ id: 'x', attrs: { label: 'X' } }],
        edges: [{ id: 'b-x', source: 'b', target: 'x', attrs: { weight: 1 } }],
        provenance: { origin: 'remote', query: 'b' },
      }),
    };
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: chain(1) });

    await expect(instance.expandNode('b')).resolves.toEqual({ added: 1 });

    const records = instance.getExpansionOverlays('b');
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.provenance).toEqual({ origin: 'remote', query: 'b' });
    expect(record.requestId.length).toBeGreaterThan(0);
    expect(record.overlayId).toBe(`expand:b:${record.requestId}`); // requestId in the session identity
    expect(record.revealedIds).toEqual(['x']);
    expect(instance.getOverlayIds()).toContain(record.overlayId);

    // removeOverlay removes exactly this contribution AND its bookkeeping.
    expect(instance.removeOverlay(record.overlayId)).toEqual({ removed: true });
    expect(instance.getNode('x')).toBeUndefined();
    expect(instance.getExpansionOverlays('b')).toEqual([]);
    expect(instance.getOverlayIds()).toEqual([]);
  });
});

describe('all-visible responses + local default service + scope accretion', () => {
  it('resolves {noop:true} without a session when every neighbor is already visible', async () => {
    const { instance } = makeServiceInstance(); // built-in local service
    instance.applyHostUpdate({ data: chain(1) });
    const before = instance.getRevisions();

    await expect(instance.expandNode('b')).resolves.toEqual({ noop: true });

    expect(instance.getRevisions()).toEqual(before); // no session, no advance
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.getExpansionOverlays('b')).toEqual([]);
  });

  it('does not confuse distinct id-less edge endpoint tuples containing spaces', async () => {
    const service: ExpansionService<NAttrs, EAttrs> = {
      revisionDependencies: ['source'],
      neighbors: async () => ({ edges: [{ source: 'a', target: 'b c' }] }),
    };
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({
      data: snap(1, ['a b', 'c', 'a', 'b c'], [['a b', 'c']]),
    });

    await expect(instance.expandNode('a')).resolves.toEqual({ added: 0 });
    expect(instance.store.getState().edgeCount).toBe(2);
    expect(instance.getOverlayIds()).toHaveLength(1);
    expect(instance.getExpansionOverlays('a')).toHaveLength(1);
  });

  it('merges a newly returned parallel id-less edge instead of treating the pair as known', async () => {
    const service: ExpansionService<NAttrs, EAttrs> = {
      revisionDependencies: ['source'],
      neighbors: async () => ({
        edges: [
          { source: 'a', target: 'b' },
          { source: 'a', target: 'b' },
        ],
      }),
    };
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    await expect(instance.expandNode('a')).resolves.toEqual({ added: 0 });
    expect(instance.store.getState().edgeCount).toBe(2);
    expect(instance.getOverlayIds()).toHaveLength(1);
    expect(instance.getExpansionOverlays('a')).toHaveLength(1);
  });

  it('under a hard scope the local service reveals out-of-scope neighbors; collapse restores', async () => {
    const { instance } = makeServiceInstance();
    instance.applyHostUpdate({ data: chain(1), subgraph: { seedIds: ['a'] } });
    expect(instance.getVisibleNodeIds()).toEqual(['a']);

    await expect(instance.expandNode('a')).resolves.toEqual({ added: 1 });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']); // b revealed (accretion)
    expect(instance.store.getState().scope).toEqual({ seedIds: ['a'] }); // spec untouched

    // Second expand: everything the service returns is visible now → noop.
    await expect(instance.expandNode('a')).resolves.toEqual({ noop: true });

    // Collapse = abort pending (none) + removeOverlay of this node's
    // expansion overlays; the accretion leaves the resolved scope with it.
    instance.retractExpansion('a');
    expect(instance.getVisibleNodeIds()).toEqual(['a']);
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.getExpansionOverlays('a')).toEqual([]);
  });

  it('expandNode on a destroyed instance rejects; unknown seeds discard cleanly', async () => {
    const { instance } = makeServiceInstance();
    instance.applyHostUpdate({ data: chain(1) });
    const p = instance.expandNode('nope'); // unknown seed → admission denies
    await expect(p).rejects.toBeInstanceOf(OrbitOperationError);
    await flush();
    expect(instance.store.getState().pendingExpansions.size).toBe(0);

    instance.destroy();
    await expect(instance.expandNode('a')).rejects.toMatchObject({
      detail: { code: 'aborted', cause: 'destroyed' },
    });
  });
});

describe('pinned accretion', () => {
  it('pins previously-placed nodes during the merge and releases them on simulationEnd', async () => {
    const { instance, engines } = makeServiceInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({ data: chain(1), subgraph: { seedIds: ['a'] } }); // force layout
    engine.injectSimulationEnd(); // settle the initial layout
    expect(engine.pinnedIndices).toBeNull();

    await expect(instance.expandNode('a')).resolves.toEqual({ added: 1 });

    // The merge committed with a restart; the PREVIOUSLY-placed set (just
    // 'a') is pinned so only the new arrival settles.
    expect(instance.store.getState().simulationRunning).toBe(true);
    expect(engine.pinnedIndices).toEqual([0]); // 'a' at its new index
    expect(instance.store.getState().pins.size).toBe(0); // never a store write

    engine.injectSimulationEnd();
    expect(engine.pinnedIndices).toBeNull(); // released to (empty) user pins
  });

  it('releases to just the USER pins, not to none', async () => {
    const { instance, engines } = makeServiceInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({ data: chain(1), subgraph: { seedIds: ['a', 'b'] } });
    engine.injectSimulationEnd();
    instance.pinNode('b'); // user pin

    await expect(instance.expandNode('b')).resolves.toEqual({ added: 1 }); // reveals c

    // Union while settling: user pin (b) + placed set (a, b) → indices of a, b.
    expect([...engine.pinnedIndices!].sort()).toEqual([0, 1]);
    engine.injectSimulationEnd();
    // Released to JUST the user pin slice.
    const bIndex = instance.getVisibleNodeIds().indexOf('b');
    expect(engine.pinnedIndices).toEqual([bIndex]);
    expect(instance.store.getState().pins.has('b')).toBe(true);
  });
});
