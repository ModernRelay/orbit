/**
 * search.
 *
 * 1. The built-in LOCAL indexed service: id-only without `searchIndex`
 * (attr values NEVER match — pinned), field-scoped matching + the scoring
 * ladder (exact-id 3 > id-prefix 2 > field token-start 1.25 > field
 * substring 1), score-desc/base-order sorting, limit, label selection,
 * ONE index build per model revision (build-counter pinned), and
 * ctx.signal honored between scan chunks.
 * 2. Instance wiring: revision-keyed cache (same query+revisions → one
 * service call; model bump → fresh call; in-flight equal keys coalesce),
 * supersede cancellation (newer query aborts older — the older promise
 * rejects 'aborted'), stale-admission rejection with an abort-ignoring
 * service, the store.search slice (ONE publish; navigator-consumable
 * shape; node populated for in-model ids; datasetKey change clears),
 * and lifecycle aborts (dataset swap / destroy).
 * 3. activateSearchResult: focused (+ FakeEngine camera call) and all
 * three unavailable reasons; never mutates scope/filters.
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import { createLocalSearchService } from '../src/search';
import type { SearchService } from '../src/search';
import { createRequestContext } from '../src/services';
import type { RequestContextHandle } from '../src/services';
import { OrbitOperationError } from '../src/errors';
import type { GraphOperationError } from '../src/errors';
import { FakeEngine } from '../src/testing/index';
import type { GraphNode, SearchResult } from '../src/types';
import { callsOf, container, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Attrs = Record<string, unknown>;

function node(id: string, attrs?: Attrs): GraphNode<Attrs> {
  return attrs === undefined ? { id } : { id, attrs };
}

/** A RequestContext handle at the given model revision (local-service unit
 * tests drive the service directly, without an instance). */
function ctxAt(model: number): RequestContextHandle {
  return createRequestContext({
    datasetKey: 'ds',
    revisions: { source: 1, model, scope: 0 },
  });
}

/** Await a rejection and return its typed detail. */
async function opError(p: Promise<unknown>): Promise<GraphOperationError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrbitOperationError);
    return (e as OrbitOperationError).detail;
  }
  throw new Error('expected the operation to reject');
}

function makeSearchInstance(service?: SearchService<NAttrs>, searchIndex?: readonly string[]) {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NAttrs, EAttrs>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
    ...(service !== undefined ? { services: { search: service } } : {}),
    // D7: searchIndex is a construction option (read once).
    ...(searchIndex !== undefined ? { searchIndex } : {}),
  });
  return { instance, engines };
}

/** Service that counts calls and returns a fixed result set. */
function countingService(results: readonly SearchResult<NAttrs>[]) {
  let calls = 0;
  const service: SearchService<NAttrs> = {
    revisionDependencies: ['source', 'model'],
    search() {
      calls++;
      return Promise.resolve(results);
    },
  };
  return { service, calls: () => calls };
}

interface SearchGate {
  resolve: (v: readonly SearchResult<NAttrs>[]) => void;
  reject: (e: unknown) => void;
}

/** A manually-gated service: every call parks on its own gate and never
 * reads ctx.signal (the "service that ignores abort"). */
function gatedSearchService() {
  const gates: SearchGate[] = [];
  const service: SearchService<NAttrs> = {
    revisionDependencies: ['source', 'model'],
    search() {
      return new Promise<readonly SearchResult<NAttrs>[]>((resolve, reject) => {
        gates.push({ resolve, reject });
      });
    },
  };
  return { service, gates, calls: () => gates.length };
}

// ---------------------------------------------------------------------------
// 1. createLocalSearchService — the default indexed service.
// ---------------------------------------------------------------------------

describe('createLocalSearchService', () => {
  it('without searchIndex the service is id-only: attr values NEVER match (pinned)', async () => {
    const service = createLocalSearchService<Attrs>(() => ({
      nodes: [node('alpha', { label: 'ZEBRA' }), node('beta', { label: 'alpha station' })],
      searchIndex: undefined,
    }));
    // 'zebra' only exists in an attr value — id-only search must not see it.
    await expect(service.search('zebra', { limit: 10 }, ctxAt(1).context)).resolves.toEqual([]);
    // 'alpha' matches the id 'alpha' but NOT beta's 'alpha station' label.
    const results = await service.search('alpha', { limit: 10 }, ctxAt(1).context);
    expect(results).toEqual([{ id: 'alpha', score: 3, label: 'alpha' }]);
  });

  it('field-scoped matching: scoring ladder, base-order tie-break, limit, labels', async () => {
    const service = createLocalSearchService<Attrs>(() => ({
      nodes: [
        node('x2', { label: 'sonnet' }), // field substring mid-token → 1
        node('nettle', { label: 'stinger' }), // id prefix → 2
        node('x1', { label: 'net income' }), // field PREFIX → 1.5
        node('net', { label: 'Network' }), // exact id → 3
        node('x9', { label: 'gross net gain' }), // token start (after space) → 1.25
        node('x3', { other: 'net' }), // undeclared field → NO match
        node('x4', { label: 'NET' }), // exact FIELD match → 2.5
      ],
      searchIndex: ['label'],
    }));
    const results = await service.search('NET', { limit: 10 }, ctxAt(1).context);
    expect(results.map((r) => r.id)).toEqual(['net', 'x4', 'nettle', 'x1', 'x9', 'x2']);
    expect(results.map((r) => r.score)).toEqual([3, 2.5, 2, 1.5, 1.25, 1]);
    // label = first matching field's ORIGINAL value; the id when only the id matched.
    expect(results[0]!.label).toBe('Network');
    expect(results[1]!.label).toBe('NET'); // exact-field: the field IS the label
    expect(results[2]!.label).toBe('nettle');
    expect(results[3]!.label).toBe('net income');
    // The service itself never populates node (the instance does).
    expect(results[0]!.node).toBeUndefined();
    // limit truncates AFTER scoring/sorting.
    const top = await service.search('net', { limit: 2 }, ctxAt(1).context);
    expect(top.map((r) => r.id)).toEqual(['net', 'x4']); // exact-field outranks id-prefix
  });

  it('String()-coerces indexed attr values (numbers are searchable)', async () => {
    const service = createLocalSearchService<Attrs>(() => ({
      nodes: [node('a', { port: 8080 }), node('b', { port: 443 })],
      searchIndex: ['port'],
    }));
    const results = await service.search('808', { limit: 10 }, ctxAt(1).context);
    expect(results.map((r) => r.id)).toEqual(['a']);
    expect(results[0]!.label).toBe('8080');
  });

  it('builds the index ONCE per model revision, not per keystroke (build counter pinned)', async () => {
    let fields: readonly string[] | undefined = ['label'];
    const nodes = [node('a', { label: 'anchor' }), node('b', { label: 'buoy' })];
    const service = createLocalSearchService<Attrs>(() => ({ nodes, searchIndex: fields }));
    expect(service.buildCount).toBe(0);
    await service.search('a', { limit: 5 }, ctxAt(1).context);
    await service.search('an', { limit: 5 }, ctxAt(1).context);
    await service.search('anc', { limit: 5 }, ctxAt(1).context);
    expect(service.buildCount).toBe(1); // three keystrokes, one build
    await service.search('a', { limit: 5 }, ctxAt(2).context);
    expect(service.buildCount).toBe(2); // model revision moved → rebuild
    await service.search('b', { limit: 5 }, ctxAt(2).context);
    expect(service.buildCount).toBe(2);
    fields = ['label', 'name']; // declared fields changed → rebuild
    await service.search('a', { limit: 5 }, ctxAt(2).context);
    expect(service.buildCount).toBe(3);
  });

  it('respects ctx.signal between scan chunks (abort mid-scan rejects typed)', async () => {
    const many: GraphNode<Attrs>[] = [];
    for (let i = 0; i < 5000; i++) many.push(node(`n${String(i)}`));
    const service = createLocalSearchService<Attrs>(() => ({
      nodes: many,
      searchIndex: undefined,
    }));
    const handle = ctxAt(1);
    const pending = service.search('n', { limit: 3 }, handle.context);
    handle.abort('stop'); // flips before the first 4096-row chunk boundary check
    expect((await opError(pending)).code).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// 2. Instance wiring: cache, coalescing, supersede, stale admission, store.
// ---------------------------------------------------------------------------

describe('instance.search wiring', () => {
  it('caches by declared revisions: same query+revisions → ONE service call; model bump → fresh call', async () => {
    const { service, calls } = countingService([{ id: 'a' }, { id: 'zz' }]);
    const { instance } = makeSearchInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });

    const first = await instance.search('q');
    const second = await instance.search('q');
    expect(calls()).toBe(1); // revision-keyed cache hit
    expect(second).toBe(first); // the SAME admitted result array
    // node populated for in-model ids only.
    expect(first[0]!.node).toBe(instance.getNode('a'));
    expect(first[1]!.node).toBeUndefined();

    instance.applyHostUpdate({ data: snap(2, ['a', 'b']) }); // model bump
    await instance.search('q');
    expect(calls()).toBe(2); // declared revisions moved → fresh call
  });

  it('coalesces same-key calls onto ONE in-flight service call', async () => {
    const { service, gates, calls } = gatedSearchService();
    const { instance } = makeSearchInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const p1 = instance.search('q');
    const p2 = instance.search('q');
    expect(calls()).toBe(1);
    gates[0]!.resolve([{ id: 'a' }]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r2).toBe(r1);
    expect(instance.store.getState().search).toEqual({ query: 'q', results: r1 });
  });

  it('D7: a runtime searchIndex attempt is IGNORED with a one-shot warning (construction-only)', async () => {
    const { instance } = makeSearchInstance(); // constructed id-only
    instance.applyHostUpdate({
      data: {
        datasetKey: 'ds',
        sourceRevision: 1,
        nodes: [{ id: 'x1', attrs: { label: 'zebra' } }],
        edges: [],
      },
    });

    // Untyped runtime attempt — the lane no longer exists on GraphHostUpdate.
    instance.applyHostUpdate({ searchIndex: ['label'] } as never);
    let warns = instance.store
      .getState()
      .diagnostics.filter((d) => d.code === 'operation-rejected');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.severity).toBe('warning');
    expect(warns[0]!.message).toContain('construction-only');

    // IGNORED: the label field is still not indexed (id-only service) — the
    // old stash-only lane would have made this query match.
    expect(await instance.search('zebra')).toEqual([]);

    // One-shot: a second attempt adds no second diagnostic.
    instance.applyHostUpdate({ searchIndex: ['label', 'name'] } as never);
    warns = instance.store
      .getState()
      .diagnostics.filter((d) => d.code === 'operation-rejected');
    expect(warns).toHaveLength(1);
  });

  it('D7: searchIndex passed at CONSTRUCTION indexes fields from the first search', async () => {
    const { instance } = makeSearchInstance(undefined, ['label']);
    instance.applyHostUpdate({
      data: {
        datasetKey: 'ds',
        sourceRevision: 1,
        nodes: [{ id: 'x1', attrs: { label: 'zebra' } }],
        edges: [],
      },
    });
    const results = await instance.search('zebra');
    expect(results.map((r) => r.id)).toEqual(['x1']);
    expect(results[0]!.label).toBe('zebra');
  });

  it('clearSearch supersedes a PENDING flight — late settle never republishes', async () => {
    const { service, gates, calls } = gatedSearchService();
    const { instance } = makeSearchInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const pending = instance.search('q');
    const rejection = expect(pending).rejects.toMatchObject({
      detail: { code: 'aborted', cause: 'cleared' },
    });
    instance.clearSearch();
    await rejection;

    // The service settles AFTER the clear: the cleared slice must stay null
    // (previously this republished {query:'q'} into the store/Navigator).
    gates[0]!.resolve([{ id: 'a' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(instance.store.getState().search).toBeNull();

    // The unsettled cache entry was evicted: the same query re-runs the
    // service instead of serving the aborted promise.
    const again = instance.search('q');
    expect(calls()).toBe(2);
    gates[1]!.resolve([{ id: 'a' }]);
    await again;
    expect(instance.store.getState().search).not.toBeNull();
  });

  it('clear → newer query → only the newer publication lands', async () => {
    const { service, gates } = gatedSearchService();
    const { instance } = makeSearchInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });

    const older = instance.search('aaa');
    const olderRejection = expect(older).rejects.toMatchObject({
      detail: { code: 'aborted', cause: 'cleared' },
    });
    instance.clearSearch();
    await olderRejection;

    const newer = instance.search('b');
    gates[1]!.resolve([{ id: 'b' }]);
    await newer;
    const slice = instance.store.getState().search;
    expect(slice!.query).toBe('b');
    expect(slice!.results[0]).toMatchObject({ id: 'b' });
  });

  it('supersede: a newer query aborts the older in-flight call; older rejects, newer resolves', async () => {
    const { service, gates, calls } = gatedSearchService();
    const { instance } = makeSearchInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });

    const older = instance.search('aaa');
    const olderRejection = expect(older).rejects.toMatchObject({
      detail: { code: 'aborted', cause: 'superseded' },
    });
    const newer = instance.search('bbb');
    expect(calls()).toBe(2);
    await olderRejection; // rejected at supersede time, before any gate settles

    gates[1]!.resolve([{ id: 'b' }]);
    const results = await newer;
    expect(results.map((r) => r.id)).toEqual(['b']);
    expect(instance.store.getState().search).toEqual({ query: 'bbb', results });

    // The superseded service call settling LATE never publishes (admission
    // gates even a service that ignored the abort signal).
    gates[0]!.resolve([{ id: 'a' }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(instance.store.getState().search).toEqual({ query: 'bbb', results });
  });

  it('stale admission: declared revision drift rejects with a distinct aborted error; store untouched', async () => {
    const { service, gates } = gatedSearchService(); // never reads ctx.signal
    const { instance } = makeSearchInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const pending = instance.search('q');
    // Same dataset, new source/model — the declared dimensions drift.
    instance.applyHostUpdate({ data: snap(2, ['a']) });
    gates[0]!.resolve([{ id: 'a' }]);

    const detail = await opError(pending);
    expect(detail.code).toBe('aborted');
    expect(String((detail as { cause?: unknown }).cause)).toContain('stale at admission');
    expect(instance.store.getState().search).toBeNull(); // never published
  });

  it('publishes store.search ONCE per completed search in navigator-consumable shape; datasetKey change clears', async () => {
    const { instance } = makeSearchInstance(undefined, ['label']); // default local service
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b'], [['a', 'b']]),
    });
    let searchPublishes = 0;
    const unsubscribe = instance.store.subscribe((state, prev) => {
      if (state.search !== prev.search) searchPublishes++;
    });

    const results = await instance.search('a');
    expect(searchPublishes).toBe(1); // exactly ONE publication
    const slice = instance.store.getState().search;
    expect(slice).not.toBeNull();
    expect(slice!.query).toBe('a');
    expect(slice!.results).toBe(results);
    expect(slice!.results[0]).toMatchObject({ id: 'a', score: 3, label: 'A' });
    expect(slice!.results[0]!.node).toBe(instance.getNode('a')); // in-model → node populated
    expect(slice!.results).toHaveLength(1); // 'b'/'B' never matched

    instance.clearSearch();
    expect(instance.store.getState().search).toBeNull();
    expect(searchPublishes).toBe(2);
    instance.clearSearch(); // idempotent — no publication
    expect(searchPublishes).toBe(2);

    await instance.search('a'); // cache hit still (re)publishes for the latest call
    expect(instance.store.getState().search).not.toBeNull();

    // a declarative datasetKey change clears the slice.
    instance.applyHostUpdate({ data: snap(1, ['p', 'q'], [], 'ds2') });
    expect(instance.store.getState().search).toBeNull();
    unsubscribe();
  });

  it('default service honors the searchIndex prop and the 20-result default limit', async () => {
    const { instance } = makeSearchInstance();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) ids.push(`node${String(i).padStart(2, '0')}`);
    instance.applyHostUpdate({ data: snap(1, ids) });
    const results = await instance.search('node');
    expect(results).toHaveLength(20); // default limit
    const limited = await instance.search('node', { limit: 5 });
    expect(limited).toHaveLength(5);
    // No searchIndex declared → labels never match ('NODE05' attrs are
    // uppercase, but so is the query proof: search an attr-only token).
    await expect(instance.search('missing')).resolves.toEqual([]);
  });

  it('a datasetKey swap mid-flight rejects the in-flight search', async () => {
    const { service, gates } = gatedSearchService();
    const { instance } = makeSearchInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const pending = instance.search('q');
    const rejection = expect(pending).rejects.toMatchObject({
      detail: { code: 'aborted', cause: 'dataset-changed' },
    });
    instance.applyHostUpdate({ data: snap(1, ['p'], [], 'ds2') });
    await rejection;
    expect(gates.length).toBe(1);
    expect(instance.store.getState().search).toBeNull();
  });

  it('destroy() rejects the in-flight search; later calls reject destroyed', async () => {
    const { service, gates } = gatedSearchService();
    const { instance } = makeSearchInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const pending = instance.search('q');
    const rejection = expect(pending).rejects.toMatchObject({
      detail: { code: 'aborted', cause: 'destroyed' },
    });
    instance.destroy();
    await rejection;
    expect(gates.length).toBe(1);
    expect((await opError(instance.search('x'))).code).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// 3. activateSearchResult — the result contract.
// ---------------------------------------------------------------------------

describe('activateSearchResult', () => {
  async function harness(searchIndex?: readonly string[]) {
    const { instance, engines } = makeSearchInstance(undefined, searchIndex);
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b']]) });
    return { instance, engine: engines[0]! };
  }

  it('focused: in the scene and mask-visible → focusNode (camera flies)', async () => {
    const { instance, engine } = await harness();
    const result: SearchResult<NAttrs> = { id: 'a', score: 3, label: 'A' };
    const activation = instance.activateSearchResult(result);
    expect(activation).toEqual({ status: 'focused', id: 'a' });
    expect(callsOf(engine, 'setFocusedIndex').length).toBeGreaterThan(0);
    expect(callsOf(engine, 'zoomToIndex')).toHaveLength(1); // flown to
  });

  it("not-loaded: id absent from the accepted model (result echoed)", async () => {
    const { instance } = await harness();
    const result: SearchResult<NAttrs> = { id: 'zz' };
    const activation = instance.activateSearchResult(result);
    expect(activation).toEqual({ status: 'unavailable', reason: 'not-loaded', result });
    if (activation.status === 'unavailable') expect(activation.result).toBe(result);
  });

  it('out-of-scope: in the model but outside the hard scope; scope NEVER mutated', async () => {
    const { instance, engine } = await harness();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a'] } });
    const zooms = callsOf(engine, 'zoomToIndex').length;
    const result: SearchResult<NAttrs> = { id: 'c' };
    const activation = instance.activateSearchResult(result);
    expect(activation).toEqual({ status: 'unavailable', reason: 'out-of-scope', result });
    // Classification only: no camera move, no scope rewrite.
    expect(callsOf(engine, 'zoomToIndex')).toHaveLength(zooms);
    expect(instance.store.getState().scope).toEqual({ seedIds: ['a'] });
  });

  it('filtered: in the scene but mask-hidden; filters NEVER mutated', async () => {
    const { instance } = await harness();
    instance.hideNodes(['b']);
    const result: SearchResult<NAttrs> = { id: 'b' };
    const activation = instance.activateSearchResult(result);
    expect(activation).toEqual({ status: 'unavailable', reason: 'filtered', result });
    expect(instance.store.getState().hiddenNodeIds).toEqual(new Set(['b']));
    // A visible sibling still focuses normally alongside the mask.
    expect(instance.activateSearchResult({ id: 'a' })).toEqual({ status: 'focused', id: 'a' });
  });

  it('search → activate round-trip: results feed the contract directly', async () => {
    const { instance } = await harness(['label']);
    const results = await instance.search('b');
    expect(results.map((r) => r.id)).toEqual(['b']);
    expect(instance.activateSearchResult(results[0]!)).toEqual({ status: 'focused', id: 'b' });
  });
});
