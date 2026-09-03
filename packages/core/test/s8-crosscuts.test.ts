/**
 * Recovery / label-lane / selection / lifecycle cross-cuts
 * with the v0.5 subsystems (revisioned ingestion, hard scope +
 * expansion services). FakeEngine-driven.
 *
 * 1. Context loss during an OPEN progressive overlay session: the recovery
 * replay reflects the last PUBLISHED flush, staged appends stay pending,
 * and the session keeps appending and commits after recovery.
 * 2. Context loss under a hard scope: recovery replays the SCOPED subset
 * with cached positions; resetIsolation afterwards restores the base.
 * 3. detach/re-attach with committed overlays: the fresh engine's replay
 * includes overlay rows; removeOverlay still promotes shadowed rows.
 * 4. Label lane under scope: candidates only ever come from the scoped
 * subset (forced out-of-scope ids never leak); clearing re-ranks to the
 * full base.
 * 5. Ingestion × selection survival: replace sessions prune streamed-out
 * ids (new dataset clears), overlay additions never touch selection, and
 * abort rollback restores the exact pre-session selection-visible state.
 * 6. datasetKey-swap clears the v0.5 slices (scope, pendingExpansions,
 * overlayIds, and the search slice) on BOTH a replace session
 * establishing a new datasetKey and a declarative datasetKey change.
 * 7. destroy mid-progressive-session: staged work rejects, later session
 * calls reject closed, and no timers leak.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { OrbitOperationError } from '../src/errors';
import type { GraphOperationError } from '../src/errors';
import { FakeEngine } from '../src/testing/index';
import type {
  ExpansionResponse,
  ExpansionService,
  GraphEdge,
  GraphNode,
  IngestBatch,
} from '../src/types';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Instance = GraphInstance<NAttrs, EAttrs>;
type Batch = IngestBatch<NAttrs, EAttrs>;
type Response = ExpansionResponse<NAttrs, EAttrs>;

const nodes = (...ids: string[]): GraphNode<NAttrs>[] =>
  ids.map((id) => ({ id, attrs: { label: id.toUpperCase() } }));

const batch = (sequence: number, batchId: string, b: Partial<Batch> = {}): Batch => ({
  sequence,
  batchId,
  ...b,
});

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

function overlaySession(
  instance: Instance,
  opts: Partial<Parameters<Instance['beginIngest']>[0]> = {},
) {
  return instance.beginIngest({
    purpose: 'overlay',
    datasetKey: 'ds',
    baseModelRevision: instance.getRevisions().model,
    ...opts,
  });
}

/** One-batch replace session, valid only on a session-established base. */
async function commitReplaceSession(
  instance: Instance,
  datasetKey: string,
  sourceRevision: number,
  rows: GraphNode<NAttrs>[],
  edges?: GraphEdge<EAttrs>[],
): Promise<void> {
  const s = instance.beginIngest({
    purpose: 'replace',
    datasetKey,
    sourceRevision,
    baseModelRevision: instance.getRevisions().model,
  });
  const b: Batch = { sequence: 0, batchId: 'r0', nodes: rows };
  if (edges !== undefined) b.edges = edges;
  await s.append(b);
  await s.commit();
}

interface Gate {
  promise: Promise<Response>;
  resolve: (v: Response) => void;
}

/** A manually-gated expansion service: every call parks on its own gate and
 * never reads ctx.signal (the "service that ignores abort"). */
function gatedService() {
  const gates: Gate[] = [];
  const service: ExpansionService<NAttrs, EAttrs> = {
    revisionDependencies: ['source'],
    neighbors() {
      let resolve!: (v: Response) => void;
      const promise = new Promise<Response>((res) => {
        resolve = res;
      });
      gates.push({ promise, resolve });
      return promise;
    },
  };
  return { service, gates, calls: () => gates.length };
}

function makeServiceInstance(service: ExpansionService<NAttrs, EAttrs>) {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NAttrs, EAttrs>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
    fitViewOnFirstData: false,
    services: { expansion: service },
  });
  return { instance, engines };
}

/** a—b—c—d chain; FakeEngine seeds a(0,0) b(10,0) c(20,0) d(30,0). */
const CHAIN_IDS = ['a', 'b', 'c', 'd'] as const;
const CHAIN_LINKS: ReadonlyArray<readonly [string, string]> = [
  ['a', 'b'],
  ['b', 'c'],
  ['c', 'd'],
];

// ---------------------------------------------------------------------------
// 1. Context loss during an OPEN progressive overlay session.
// ---------------------------------------------------------------------------

describe('context loss × open progressive overlay session', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('recovery replays the last PUBLISHED flush; staged appends stay pending; the session finishes after recovery', async () => {
    vi.useFakeTimers();
    const { instance, engines } = makeInstance({ fitViewOnFirstData: false });
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    const session = overlaySession(instance, { atomic: false, overlayId: 'live' });
    const r0 = session.append(batch(0, 'b0', { nodes: nodes('x') }));
    vi.advanceTimersByTime(50); // coalesced flush: x becomes public
    const receipt0 = await r0;
    expect(receipt0.publishedModelRevision).toBe(instance.getRevisions().model);
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'x']);

    // Stage un-flushed work, then lose the context before its flush deadline.
    let b1Settled = false;
    const r1 = session.append(batch(1, 'b1', { nodes: nodes('y') }));
    void r1.then(
      () => (b1Settled = true),
      () => (b1Settled = true),
    );
    engine.injectContextLost();
    expect(instance.store.getState().status).toBe('lost');
    expect(session.state).toBe('open'); // context loss never aborts a session

    const commitsBefore = engine.commits.length;
    engine.injectContextRestored();
    expect(instance.store.getState().status).toBe('ready');

    // ONE replay commit reflecting the LAST PUBLISHED flush: a, b, x — not y.
    expect(engine.commits.length).toBe(commitsBefore + 1);
    const replay = engine.lastCommit!;
    expect(replay.structure!.pointCount).toBe(3);
    expect(replay.restart).toEqual({ alpha: 0.1 }); // gentle reheat

    await Promise.resolve();
    await Promise.resolve();
    expect(b1Settled).toBe(false); // the un-flushed append is still pending

    // The session continues after recovery: append, flush, commit.
    const r2 = session.append(batch(2, 'b2', { nodes: nodes('z') }));
    vi.advanceTimersByTime(50);
    const [receipt1, receipt2] = await Promise.all([r1, r2]);
    expect(receipt1.publishedModelRevision).toBe(instance.getRevisions().model);
    expect(receipt2.publishedModelRevision).toBe(receipt1.publishedModelRevision);
    expect(engine.lastCommit!.structure!.pointCount).toBe(5);

    const commit = await session.commit();
    expect(session.state).toBe('committed');
    expect(commit.overlayId).toBe('live');
    expect(commit.admittedNodes).toBe(3);
    expect(instance.getOverlayIds()).toEqual(['live']);
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'x', 'y', 'z']);
  });
});

// ---------------------------------------------------------------------------
// 2. Context loss during a hard scope.
// ---------------------------------------------------------------------------

describe('context loss × hard scope', () => {
  it('recovery replays the SCOPED subset with cached positions; resetIsolation restores the base', async () => {
    const { instance, engines } = makeInstance({ fitViewOnFirstData: false });
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({ data: snap(1, [...CHAIN_IDS], CHAIN_LINKS) });
    engine.nudgePositions(5, 5);
    engine.injectSimulationEnd(); // bank a(5,5) b(15,5) c(25,5) d(35,5)

    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);

    engine.injectContextLost();
    const commitsBefore = engine.commits.length;
    engine.injectContextRestored();
    expect(instance.store.getState().status).toBe('ready');

    // The replay commit carries the SCOPED subset — never the full base.
    expect(engine.commits.length).toBe(commitsBefore + 1);
    const replay = engine.lastCommit!;
    expect(replay.structure!.pointCount).toBe(2);
    expect(Array.from(replay.structure!.links)).toEqual([0, 1]);
    expect(Array.from(replay.structure!.positions)).toEqual([5, 5, 15, 5]); // cached
    expect(replay.restart).toEqual({ alpha: 0.1 });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    expect(instance.store.getState().scope).toEqual({ seedIds: ['a', 'b'] });

    // resetIsolation AFTER recovery restores the base with cached positions
    // (survivors from the live cache, departed ids from the departed cache).
    instance.resetIsolation();
    expect(instance.store.getState().scope).toBeNull();
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c', 'd']);
    const restored = engine.lastCommit!;
    expect(restored.structure!.pointCount).toBe(4);
    expect(Array.from(restored.structure!.positions)).toEqual([5, 5, 15, 5, 25, 5, 35, 5]);
  });
});

// ---------------------------------------------------------------------------
// 3. detach/re-attach with committed overlays.
// ---------------------------------------------------------------------------

describe('detach/re-attach × committed overlays', () => {
  it('the fresh engine replays overlay rows; removeOverlay still promotes shadowed rows', async () => {
    const { instance, engines, factoryCalls } = makeInstance({ fitViewOnFirstData: false });
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const sA = overlaySession(instance, { overlayId: 'A' });
    await sA.append(batch(0, 'a0', { nodes: [{ id: 'n', attrs: { label: 'FROM-A' } }] }));
    await sA.commit();
    const sB = overlaySession(instance, { overlayId: 'B' });
    await sB.append(
      batch(0, 'b0', {
        nodes: [
          { id: 'n', attrs: { label: 'FROM-B' } }, // shadowed by A's earlier row
          { id: 'm', attrs: { label: 'M' } },
        ],
      }),
    );
    await sB.commit();
    expect(instance.getNode('n')!.attrs!.label).toBe('FROM-A');

    instance.detach();
    expect(instance.store.getState().status).toBe('idle');
    // Committed overlays are model state — they survive detach.
    expect(instance.getOverlayIds()).toEqual(['A', 'B']);

    await instance.attach(container);
    expect(factoryCalls()).toBe(2);
    const fresh = engines[1]!;
    // The fresh engine's single replay commit includes the overlay rows.
    expect(fresh.commits).toHaveLength(1);
    expect(fresh.commits[0]!.structure!.pointCount).toBe(3);
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'n', 'm']);
    expect(instance.getOverlayIds()).toEqual(['A', 'B']);
    expect(
      instance.getDiagnostics().some((d) => d.code === 'overlay-node-shadowed'),
    ).toBe(true); // shadow bookkeeping survived the engine swap

    // removeOverlay after re-attach still promotes B's formerly shadowed row.
    expect(instance.removeOverlay('A')).toEqual({ removed: true });
    expect(instance.getNode('n')!.attrs!.label).toBe('FROM-B');
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'n', 'm']);
    expect(instance.getOverlayIds()).toEqual(['B']);
    expect(instance.store.getState().nodeCount).toBe(3);
    expect(
      instance.getDiagnostics().some((d) => d.code === 'overlay-node-shadowed'),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Label lane under scope.
// ---------------------------------------------------------------------------

describe('label lane × hard scope', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('candidates only ever come from the scoped subset; clearing re-ranks to the full base', async () => {
    vi.useFakeTimers();
    const { instance, engines } = makeInstance({ fitViewOnFirstData: false });
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({
      data: snap(1, [...CHAIN_IDS], CHAIN_LINKS),
      labels: { minZoom: 0, showFor: ['d'], overlap: 'allow' },
    });
    engine.injectSimulationEnd(); // settle: bank positions + full-base rank

    const emissions: string[][] = [];
    instance.labels.subscribeCandidates((list) => emissions.push(list.map((p) => p.id)));
    // Full base replay: forced 'd' first, then degree-ranked b, c, a.
    expect(emissions).toEqual([['d', 'b', 'c', 'a']]);

    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });
    const scopedFrom = emissions.length - 1;
    // The forced-but-out-of-scope 'd' never leaks into the lane.
    expect(emissions.at(-1)).toEqual(['a', 'b']);

    // Every scoped re-rank trigger: settle, viewport idle, config change.
    engine.injectSimulationEnd();
    engine.injectViewportChange({ x: 0, y: 0, zoom: 2 });
    vi.advanceTimersByTime(100); // trailing viewport re-rank
    instance.applyHostUpdate({ labels: { minZoom: 0, showFor: ['b', 'd'], overlap: 'allow' } });
    expect(emissions.at(-1)).toEqual(['b', 'a']); // in-scope forced id first
    for (const list of emissions.slice(scopedFrom)) {
      for (const id of list) expect(['a', 'b']).toContain(id);
    }

    // Clearing the scope re-ranks over the FULL base again.
    instance.applyHostUpdate({ subgraph: null });
    expect(emissions.at(-1)).toEqual(['b', 'd', 'c', 'a']);
  });
});

// ---------------------------------------------------------------------------
// 5. Ingestion × selection survival.
// ---------------------------------------------------------------------------

describe('ingestion × selection survival', () => {
  it('replace sessions prune streamed-out ids; a NEW dataset clears; overlay additions never touch selection', async () => {
    const { instance } = makeInstance({ fitViewOnFirstData: false });
    await instance.attach(container);
    await commitReplaceSession(instance, 'ds', 1, nodes('a', 'b', 'c'));
    instance.selectNodes(['a', 'b']);
    const selBefore = instance.store.getState().selection;

    // Overlay additions NEVER clear selection — the slice object survives.
    const ov = overlaySession(instance, { overlayId: 'add' });
    await ov.append(batch(0, 'o0', { nodes: nodes('x') }));
    await ov.commit();
    expect(instance.store.getState().selection).toBe(selBefore);

    // A same-dataset replace streaming 'b' OUT prunes exactly 'b'.
    await commitReplaceSession(instance, 'ds', 2, nodes('a', 'c'));
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);

    // A replace establishing a NEW datasetKey clears the selection outright.
    instance.selectNodes(['a', 'c']);
    await commitReplaceSession(instance, 'ds2', 1, nodes('p', 'q'));
    expect(instance.store.getState().selection).toEqual({
      nodeIds: [],
      edgeIds: [],
      groupIds: [],
    });
  });

  it('abort rollback restores the exact pre-session selection-visible state', async () => {
    vi.useFakeTimers();
    try {
      const { instance } = makeInstance({ fitViewOnFirstData: false });
      await instance.attach(container);
      instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
      instance.selectNodes(['a', 'b']);
      const preIds = instance.store.getState().selection.nodeIds;

      const s = overlaySession(instance, { atomic: false, overlayId: 'prov' });
      void s.append(batch(0, 'p0', { nodes: nodes('x') })).catch(() => {});
      vi.advanceTimersByTime(50); // x provisionally public
      instance.selectNodes(['a', 'b', 'x']); // select the provisional row too
      expect(instance.store.getState().selection.nodeIds).toEqual(['a', 'b', 'x']);

      await s.abort('rolled back');

      // The provisional id pruned in the SAME rollback publication — the
      // selection-visible state is exactly what it was before the session.
      expect(instance.store.getState().selection.nodeIds).toEqual(preIds);
      expect(instance.getNode('x')).toBeUndefined();
      expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. datasetKey-swap clears the v0.5 slices.
// ---------------------------------------------------------------------------

describe('datasetKey swap × v0.5 slices', () => {
  it('a replace session establishing a NEW datasetKey resets scope, pendingExpansions, overlayIds, search', async () => {
    const { service, gates, calls } = gatedService();
    const { instance } = makeServiceInstance(service);
    await commitReplaceSession(instance, 'ds', 1, nodes('a', 'b'), [
      { id: 'ab', source: 'a', target: 'b', attrs: { weight: 1 } },
    ]);
    instance.applyHostUpdate({ subgraph: { seedIds: ['a'] } });
    const ov = overlaySession(instance, { overlayId: 'ov' });
    await ov.append(batch(0, 'o0', { nodes: nodes('k') }));
    await ov.commit();
    await instance.search('a'); // populate the search slice
    const pending = instance.expandNode('b'); // parks at the gated service
    const rejection = expect(pending).rejects.toMatchObject({ detail: { code: 'aborted' } });

    const before = instance.store.getState();
    expect(before.scope).toEqual({ seedIds: ['a'] });
    expect(before.pendingExpansions).toEqual(new Set(['b']));
    expect(before.overlayIds).toEqual(['ov']);
    expect(before.search).toMatchObject({ query: 'a' });

    await commitReplaceSession(instance, 'ds2', 1, nodes('p', 'q'));

    const after = instance.store.getState();
    expect(after.scope).toBeNull();
    expect(after.pendingExpansions.size).toBe(0);
    expect(after.overlayIds).toEqual([]);
    expect(after.search).toBeNull();
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.getVisibleNodeIds()).toEqual(['p', 'q']);
    await rejection; // the old dataset's expansion promise rejected 'aborted'

    // A fresh expandNode on the NEW dataset is not served the stale promise.
    const p2 = instance.expandNode('p');
    expect(p2).not.toBe(pending);
    expect(calls()).toBe(2);
    gates[1]!.resolve({
      nodes: nodes('r'),
      edges: [{ id: 'pr', source: 'p', target: 'r', attrs: { weight: 1 } }],
    });
    await expect(p2).resolves.toEqual({ added: 1 });
  });

  it('a declarative datasetKey change resets scope, pendingExpansions, overlayIds, search', async () => {
    const { service, calls } = gatedService();
    const { instance } = makeServiceInstance(service);
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b'], [['a', 'b']]),
      subgraph: { seedIds: ['a'] },
    });
    const ov = overlaySession(instance, { overlayId: 'ov' });
    await ov.append(batch(0, 'o0', { nodes: nodes('k') }));
    await ov.commit();
    await instance.search('a'); // populate the search slice
    const pending = instance.expandNode('b');
    const rejection = expect(pending).rejects.toMatchObject({ detail: { code: 'aborted' } });
    expect(instance.store.getState().pendingExpansions).toEqual(new Set(['b']));
    expect(instance.store.getState().overlayIds).toEqual(['ov']);
    expect(instance.store.getState().search).toMatchObject({ query: 'a' });

    instance.applyHostUpdate({ data: snap(1, ['p', 'q'], [['p', 'q']], 'ds2') });

    const after = instance.store.getState();
    expect(after.scope).toBeNull();
    expect(after.pendingExpansions.size).toBe(0);
    expect(after.overlayIds).toEqual([]);
    expect(after.search).toBeNull();
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.getVisibleNodeIds()).toEqual(['p', 'q']);
    await rejection;
    expect(calls()).toBe(1); // the swap never issues a service call
  });
});

// ---------------------------------------------------------------------------
// 7. Destroy mid-session.
// ---------------------------------------------------------------------------

describe('destroy() mid-progressive-session', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('staged work rejects, later session calls reject closed, and no timers leak', async () => {
    vi.useFakeTimers();
    const { instance, engines } = makeInstance({ fitViewOnFirstData: false });
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const s = overlaySession(instance, { atomic: false, overlayId: 'doomed' });
    const staged = s.append(batch(0, 'd0', { nodes: nodes('x') }));
    staged.catch(() => {});
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the pending flush timer

    instance.destroy();

    expect(instance.store.getState().status).toBe('destroyed');
    expect(vi.getTimerCount()).toBe(0); // no timers leak past destroy
    expect(engines[0]!.destroyed).toBe(true);
    expect(s.state).toBe('aborted');
    expect((await opError(staged)).code).toBe('aborted');
    expect((await opError(s.append(batch(1, 'd1', { nodes: nodes('y') })))).code).toBe(
      'ingest-session-closed',
    );
    expect((await opError(s.commit())).code).toBe('ingest-session-closed');
    expect((await opError(s.abort())).code).toBe('ingest-session-closed');
  });
});
