/**
 * Revisioned-ingestion protocol units.
 *
 * Receipts, idempotent replay (incl. the progressive complete receipt),
 * gap/conflict typing, byte backpressure + queue-overflow, coalesced flush
 * cadence (fake timers), edge-before-node resolution, atomic invisibility
 * until commit, replace idempotent replay, and begin-time rejection.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrbitOperationError } from '../src/errors';
import type { GraphOperationError } from '../src/errors';
import {
  AcceptanceQueue,
  estimateBatchBytes,
  newContribution,
  newStagingTallies,
  stageBatch,
} from '../src/ingestion';
import type { GraphNode, IngestBatch } from '../src/types';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Batch = IngestBatch<NAttrs, EAttrs>;

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

/** Synchronous throw variant of opError. */
function thrownDetail(fn: () => unknown): GraphOperationError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(OrbitOperationError);
    return (e as OrbitOperationError).detail;
  }
  throw new Error('expected the call to throw');
}

describe('AcceptanceQueue', () => {
  it('executes jobs synchronously in arrival order and stamps tickets monotonically', () => {
    const q = new AcceptanceQueue();
    const log: number[] = [];
    q.admit(() => log.push(1));
    const t1 = q.nextTicket();
    q.admit(() => log.push(2));
    const t2 = q.nextTicket();
    expect(log).toEqual([1, 2]);
    expect(t2).toBeGreaterThan(t1);
    expect(q.admissions).toBeGreaterThanOrEqual(4);
  });

  it('returns the job result and propagates exceptions to the admitter', () => {
    const q = new AcceptanceQueue();
    expect(q.admit(() => 42)).toBe(42);
    expect(() =>
      q.admit(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(q.active).toBe(false);
  });
});

describe('estimateBatchBytes', () => {
  it('prefers the caller-declared size and falls back to a JSON estimate', () => {
    expect(estimateBatchBytes({ sequence: 0, batchId: 'b', bytes: 123 })).toBe(123);
    const est = estimateBatchBytes({ sequence: 0, batchId: 'b', nodes: nodes('a', 'b') });
    expect(est).toBeGreaterThan(0);
    expect(estimateBatchBytes({ sequence: 0, batchId: 'b' })).toBe(0);
  });
});

describe('stageBatch synthesized edge identities', () => {
  it('keeps delimiter- and NUL-bearing endpoint tuples distinct', () => {
    const contribution = newContribution<NAttrs, EAttrs>('overlay');
    const tallies = newStagingTallies();
    let order = 0;

    stageBatch(
      contribution,
      batch(0, 'b0', {
        edges: [
          { source: 'a→b', target: 'c' },
          { source: 'a', target: 'b→c' },
          { source: 'a\0b', target: 'c' },
          { source: 'a', target: 'b\0c' },
        ],
      }),
      tallies,
      () => order++,
    );

    expect(contribution.edges.map(({ edge }) => edge.id)).toEqual([
      'a\\→b→c#0',
      'a→b\\→c#0',
      'a\0b→c#0',
      'a→b\0c#0',
    ]);
    expect(tallies.duplicateEdges.count).toBe(0);
  });
});

describe('beginIngest validation', () => {
  it('rejects a stale baseModelRevision with typed expected/actual', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const detail = thrownDetail(() =>
      instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 0 }),
    );
    expect(detail).toEqual({ code: 'stale-revision', expected: 1, actual: 0 });
  });

  it('treats an empty instance as model revision zero', () => {
    const { instance } = makeInstance();
    const s = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 1,
      baseModelRevision: 0,
    });
    expect(s.state).toBe('open');
  });

  it('rejects an overlay session naming a non-current datasetKey (lineage)', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const detail = thrownDetail(() =>
      instance.beginIngest({ purpose: 'overlay', datasetKey: 'other', baseModelRevision: 1 }),
    );
    expect(detail.code).toBe('stale-revision');
  });

  it('rejects an overlay session on an empty instance (no dataset lineage)', () => {
    const { instance } = makeInstance();
    const detail = thrownDetail(() =>
      instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 0 }),
    );
    expect(detail.code).toBe('stale-revision');
  });

  it('requires sourceRevision for replace and forbids atomic:false', () => {
    const { instance } = makeInstance();
    expect(() =>
      instance.beginIngest({ purpose: 'replace', datasetKey: 'ds', baseModelRevision: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      instance.beginIngest({
        purpose: 'replace',
        datasetKey: 'ds',
        sourceRevision: 1,
        atomic: false,
        baseModelRevision: 0,
      }),
    ).toThrow(TypeError);
  });

  it('rejects replace at begin while a declarative source is actively driving', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    expect(() =>
      instance.beginIngest({
        purpose: 'replace',
        datasetKey: 'ds',
        sourceRevision: 2,
        baseModelRevision: 1,
      }),
    ).toThrow(TypeError);
    // Overlay ingestion stays allowed alongside a declarative base.
    const s = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 1 });
    expect(s.state).toBe('open');
  });

  it('a committed replace session supersedes the declarative source and re-enables replace', async () => {
    const { instance } = makeInstance();
    const s1 = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 1,
      baseModelRevision: 0,
    });
    await s1.append(batch(0, 'b0', { nodes: nodes('a') }));
    await s1.commit();
    // baseSource is now 'session': a second replace session is allowed.
    const model = instance.getRevisions().model;
    const s2 = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 2,
      baseModelRevision: model,
    });
    expect(s2.state).toBe('open');
    await s2.abort();
  });

  it('throws a typed aborted operation error on a destroyed instance', () => {
    const { instance } = makeInstance();
    instance.destroy();
    const detail = thrownDetail(() =>
      instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 0 }),
    );
    expect(detail.code).toBe('aborted');
  });
});

describe('replace position publication', () => {
  it('commits changed coordinates when a replace keeps the same ids and links', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;

    const first = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 1,
      baseModelRevision: 0,
    });
    await first.append(
      batch(0, 'first', {
        nodes: [
          { id: 'a', x: 1, y: 2, attrs: { label: 'A' } },
          { id: 'b', x: 3, y: 4, attrs: { label: 'B' } },
        ],
        edges: [{ id: 'e', source: 'a', target: 'b', attrs: { weight: 1 } }],
      }),
    );
    await first.commit();
    const commitsBefore = engine.commits.length;

    const second = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 2,
      baseModelRevision: instance.getRevisions().model,
    });
    await second.append(
      batch(0, 'second', {
        nodes: [
          { id: 'a', x: 21, y: 22, attrs: { label: 'A' } },
          { id: 'b', x: 23, y: 24, attrs: { label: 'B' } },
        ],
        edges: [{ id: 'e', source: 'a', target: 'b', attrs: { weight: 1 } }],
      }),
    );
    await second.commit();

    expect(engine.commits).toHaveLength(commitsBefore + 1);
    expect(engine.lastCommit!.structure).toBeDefined();
    expect(Array.from(engine.lastCommit!.structure!.positions)).toEqual([21, 22, 23, 24]);
  });
});

describe('append sequencing & receipts', () => {
  it('returns receipts with admitted counts and pendingBytes', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 1 });
    const r = await s.append(
      batch(0, 'b0', { nodes: nodes('x', 'y'), edges: [{ source: 'x', target: 'y' }], bytes: 10 }),
    );
    expect(r.sequence).toBe(0);
    expect(r.batchId).toBe('b0');
    expect(r.admittedNodes).toBe(2);
    expect(r.admittedEdges).toBe(1);
    expect(r.pendingBytes).toBe(10);
    expect(r.publishedModelRevision).toBeUndefined(); // atomic: nothing public yet
  });

  it('replays an admitted {sequence, batchId} with the ORIGINAL receipt, no reprocessing', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 1 });
    const r1 = await s.append(batch(0, 'b0', { nodes: nodes('x'), bytes: 5 }));
    const r2 = await s.append(batch(0, 'b0', { nodes: nodes('x'), bytes: 5 }));
    expect(r2).toBe(r1); // the same receipt object — nothing re-staged
    await s.commit();
    expect(instance.store.getState().nodeCount).toBe(2); // a + x, not a + x + x
  });

  it('rejects the same sequence under a different batchId with conflict:true', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 1 });
    await s.append(batch(0, 'b0', { nodes: nodes('x') }));
    const detail = await opError(s.append(batch(0, 'OTHER', { nodes: nodes('y') })));
    expect(detail).toEqual({
      code: 'invalid-ingest-sequence',
      expected: 1,
      received: 0,
      conflict: true,
    });
  });

  it('rejects a gap / out-of-order unseen sequence with conflict:false', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 1 });
    const detail = await opError(s.append(batch(2, 'b2', { nodes: nodes('x') })));
    expect(detail).toEqual({
      code: 'invalid-ingest-sequence',
      expected: 0,
      received: 2,
      conflict: false,
    });
  });

  it('a rejected append consumes neither sequence nor batchId (identical retry is unseen)', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 1 });
    await opError(s.append(batch(1, 'b1', { nodes: nodes('x') }))); // gap → rejected
    // The failed batchId is reusable at the correct sequence.
    const r = await s.append(batch(0, 'b1', { nodes: nodes('x') }));
    expect(r.sequence).toBe(0);
    const r1 = await s.append(batch(1, 'b1b', { nodes: nodes('y') }));
    expect(r1.sequence).toBe(1);
  });

  it('rejects calls after terminal commit/abort as closed', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 1 });
    await s.append(batch(0, 'b0', { nodes: nodes('x') }));
    await s.commit();
    expect(s.state).toBe('committed');
    expect((await opError(s.append(batch(1, 'b1')))).code).toBe('ingest-session-closed');
    expect((await opError(s.commit())).code).toBe('ingest-session-closed');
    expect((await opError(s.abort())).code).toBe('ingest-session-closed');
  });
});

describe('byte backpressure & queue-overflow', () => {
  it('atomic receipts resolve at byte admission while under budget', async () => {
    const { instance } = makeInstance();
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: 1,
      maxPendingBytes: 100,
    });
    const r = await s.append(batch(0, 'b0', { nodes: nodes('x'), bytes: 60 }));
    expect(r.pendingBytes).toBe(60);
  });

  it('rejects an over-budget atomic append but keeps the session and staged prefix alive', async () => {
    // "a rejected append consumes neither sequence nor batchId; an
    // identical retry is unseen." The rejection must not deadlock (no
    // parking — atomic staging cannot drain before commit) and must not
    // destroy the session either: the caller decides whether to commit the
    // staged prefix, retry smaller, or abort.
    const { instance } = makeInstance();
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: 1,
      overlayId: 'bounded-atomic',
      maxPendingBytes: 100,
    });
    await s.append(batch(0, 'b0', { nodes: nodes('x'), bytes: 60 }));
    const detail = await opError(s.append(batch(1, 'b1', { nodes: nodes('y'), bytes: 60 })));
    expect(detail).toEqual({ code: 'queue-overflow', queuedBytes: 120, limit: 100 });

    // Session survives; the rejected append consumed nothing.
    expect(s.state).toBe('open');
    // The same sequence retries as unseen — a smaller batch is admitted.
    const retried = await s.append(batch(1, 'b1-small', { nodes: nodes('y'), bytes: 20 }));
    expect(retried.sequence).toBe(1);

    // The staged prefix plus the retried batch commit atomically.
    const receipt = await s.commit();
    expect(receipt.admittedNodes).toBe(2);
    expect(instance.getNode('x')).toBeDefined();
    expect(instance.getNode('y')).toBeDefined();
  });

  it('rejects a single batch above the absolute cap (4× budget) with queue-overflow', async () => {
    const { instance } = makeInstance();
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: 1,
      atomic: false,
      maxFlushLatencyMs: 0,
      maxPendingBytes: 100,
    });
    const detail = await opError(s.append(batch(0, 'big', { nodes: nodes('x'), bytes: 401 })));
    expect(detail).toEqual({ code: 'queue-overflow', queuedBytes: 401, limit: 400 });
    // Consumed neither sequence nor batchId.
    const r = await s.append(batch(0, 'big', { nodes: nodes('x'), bytes: 10 }));
    expect(r.sequence).toBe(0);
  });
});

describe('atomic sessions: nothing publishes until commit', () => {
  it('keeps staged rows invisible, then publishes ONE atomic commit', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    const engine = engines[0]!;
    const commitsBefore = engine.commits.length;
    const modelBefore = instance.getRevisions().model;

    const s = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 1 });
    await s.append(batch(0, 'b0', { nodes: nodes('x'), edges: [{ source: 'a', target: 'x' }] }));
    await s.append(batch(1, 'b1', { nodes: nodes('y') }));
    expect(instance.store.getState().nodeCount).toBe(2); // still just a, b
    expect(engine.commits.length).toBe(commitsBefore);

    let publications = 0;
    instance.store.subscribe(() => publications++);
    const receipt = await s.commit();
    expect(publications).toBe(1); // one store set()
    expect(engine.commits.length).toBe(commitsBefore + 1); // one engine commit
    expect(instance.store.getState().nodeCount).toBe(4);
    expect(instance.store.getState().edgeCount).toBe(1);
    expect(instance.getRevisions().model).toBe(modelBefore + 1);
    expect(receipt.overlayId).toBe(s.overlayId);
    expect(receipt.admittedNodes).toBe(2);
    expect(receipt.admittedEdges).toBe(1);
    expect(receipt.danglingEdges).toBe(0);
    expect(instance.getOverlayIds()).toEqual([s.overlayId]);
    expect(instance.store.getState().overlayIds).toEqual([s.overlayId]);
  });
});

describe('progressive overlays: coalesced flushes with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces appends into one flush no later than maxFlushLatencyMs', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const engine = engines[0]!;
    const commitsBefore = engine.commits.length;
    const modelBefore = instance.getRevisions().model;

    const s = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: 1,
      atomic: false,
    });
    const p0 = s.append(batch(0, 'b0', { nodes: nodes('x') }));
    const p1 = s.append(batch(1, 'b1', { nodes: nodes('y') }));
    let resolved = 0;
    void p0.then(() => resolved++);
    void p1.then(() => resolved++);
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(0); // receipts await the flush becoming public
    expect(instance.store.getState().nodeCount).toBe(1);

    vi.advanceTimersByTime(49);
    expect(instance.store.getState().nodeCount).toBe(1);
    vi.advanceTimersByTime(1); // 50ms default deadline
    expect(instance.store.getState().nodeCount).toBe(3);
    expect(engine.commits.length).toBe(commitsBefore + 1); // ONE coalesced flush
    expect(instance.getRevisions().model).toBe(modelBefore + 1);

    const [r0, r1] = await Promise.all([p0, p1]);
    expect(r0.publishedModelRevision).toBe(modelBefore + 1);
    expect(r1.publishedModelRevision).toBe(modelBefore + 1);
  });

  it('honors a custom maxFlushLatencyMs', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: 1,
      atomic: false,
      maxFlushLatencyMs: 20,
    });
    void s.append(batch(0, 'b0', { nodes: nodes('x') })).catch(() => {});
    vi.advanceTimersByTime(20);
    expect(instance.store.getState().nodeCount).toBe(2);
  });

  it('replaying a flushed progressive batch returns the same COMPLETE receipt', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: 1,
      atomic: false,
    });
    const p = s.append(batch(0, 'b0', { nodes: nodes('x') }));
    vi.advanceTimersByTime(50);
    const original = await p;
    expect(original.publishedModelRevision).toBe(instance.getRevisions().model);
    const replayed = await s.append(batch(0, 'b0', { nodes: nodes('x') }));
    expect(replayed).toBe(original);
    expect(replayed.publishedModelRevision).toBe(original.publishedModelRevision);
  });

  it('a commit performs the final flush; a fully-flushed commit publishes registration only', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: 1,
      atomic: false,
    });
    void s.append(batch(0, 'b0', { nodes: nodes('x') })).catch(() => {});
    vi.advanceTimersByTime(50); // flushed
    const modelAfterFlush = instance.getRevisions().model;
    const receipt = await s.commit();
    // No new rows at commit: registration-only, no extra model advance.
    expect(instance.getRevisions().model).toBe(modelAfterFlush);
    expect(receipt.modelRevision).toBe(modelAfterFlush);
    expect(instance.getOverlayIds()).toEqual([s.overlayId]);
  });
});

describe('edge-before-node', () => {
  it('resolves edges whose endpoints arrive in a later batch of the same session', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 1 });
    await s.append(batch(0, 'b0', { edges: [{ id: 'e1', source: 'x', target: 'y' }] }));
    await s.append(batch(1, 'b1', { nodes: nodes('x', 'y') }));
    const r = await s.commit();
    expect(r.danglingEdges).toBe(0);
    expect(instance.store.getState().edgeCount).toBe(1);
  });

  it('keeps unresolved edges out of the link buffer; dangling diagnostics ONLY at commit', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const engine = engines[0]!;
    const s = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: 1,
      atomic: false,
    });
    vi.useFakeTimers();
    try {
      void s.append(batch(0, 'b0', { nodes: nodes('m'), edges: [{ id: 'e1', source: 'a', target: 'ghost' }] })).catch(() => {});
      vi.advanceTimersByTime(50); // provisional publication — edge still pending
      expect(instance.store.getState().edgeCount).toBe(0);
      const structure = engine.commits.filter((c) => c.structure !== undefined).pop()!.structure!;
      expect(structure.links.length).toBe(0); // never entered the link buffer
      // Pre-commit: no dangling diagnostic yet.
      expect(
        instance.getDiagnostics().some((d) => d.code === 'dangling-edge-endpoint'),
      ).toBe(false);
      const r = await s.commit();
      expect(r.danglingEdges).toBe(1);
      expect(
        instance.getDiagnostics().some((d) => d.code === 'dangling-edge-endpoint'),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a later overlay providing the endpoint resolves a committed pending edge', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s1 = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: 1 });
    await s1.append(batch(0, 'b0', { edges: [{ id: 'e1', source: 'a', target: 'z' }] }));
    const r1 = await s1.commit();
    expect(r1.danglingEdges).toBe(1);
    expect(instance.store.getState().edgeCount).toBe(0);

    const model = instance.getRevisions().model;
    const s2 = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: model });
    await s2.append(batch(0, 'b0', { nodes: nodes('z') }));
    await s2.commit();
    expect(instance.store.getState().edgeCount).toBe(1); // resolved cross-overlay
  });
});

describe('replace sessions', () => {
  it('establishes {datasetKey, sourceRevision} atomically and clears overlays', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    // Base + one overlay via sessions; a declarative source would block replace.
    const s0 = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 1,
      baseModelRevision: 0,
    });
    await s0.append(batch(0, 'b0', { nodes: nodes('a', 'b') }));
    await s0.commit();
    expect(instance.getRevisions().source).toBe(1);

    let model = instance.getRevisions().model;
    const ov = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: model });
    await ov.append(batch(0, 'b0', { nodes: nodes('x') }));
    await ov.commit();
    expect(instance.store.getState().nodeCount).toBe(3);
    expect(instance.getOverlayIds()).toHaveLength(1);

    model = instance.getRevisions().model;
    const s1 = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 2,
      baseModelRevision: model,
    });
    await s1.append(batch(0, 'b0', { nodes: nodes('a', 'c') }));
    const receipt = await s1.commit();
    expect(receipt.sourceRevision).toBe(2);
    expect(instance.getRevisions().source).toBe(2);
    expect(instance.store.getState().nodeCount).toBe(2); // a, c — overlay cleared
    expect(instance.getOverlayIds()).toEqual([]);
  });

  it('a replace commit naming the ALREADY-ACTIVE coordinate is the idempotent replay', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const s0 = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 'r1',
      baseModelRevision: 0,
    });
    await s0.append(batch(0, 'b0', { nodes: nodes('a', 'b') }));
    await s0.commit();
    let model = instance.getRevisions().model;
    const ov = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: model });
    await ov.append(batch(0, 'b0', { nodes: nodes('x') }));
    await ov.commit();

    model = instance.getRevisions().model;
    const engine = engines[0]!;
    const commitsBefore = engine.commits.length;
    const replay = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 'r1',
      baseModelRevision: model,
    });
    await replay.append(batch(0, 'b0', { nodes: nodes('a', 'b') }));
    const receipt = await replay.commit();
    // Publishes nothing, advances nothing, keeps overlays.
    expect(receipt.modelRevision).toBe(model);
    expect(instance.getRevisions().model).toBe(model);
    expect(engine.commits.length).toBe(commitsBefore);
    expect(instance.getOverlayIds()).toHaveLength(1);
    expect(instance.store.getState().nodeCount).toBe(3);
    expect(replay.state).toBe('committed');
  });

  it('a replace commit with a NEW datasetKey clears per-dataset state', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    const s0 = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 1,
      baseModelRevision: 0,
    });
    await s0.append(batch(0, 'b0', { nodes: nodes('a', 'b') }));
    await s0.commit();
    instance.selectNodes(['a']);
    instance.pinNode('a', [1, 2]);
    expect(instance.store.getState().selection.nodeIds).toEqual(['a']);

    const model = instance.getRevisions().model;
    const s1 = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds2',
      sourceRevision: 1,
      baseModelRevision: model,
    });
    await s1.append(batch(0, 'b0', { nodes: nodes('a') }));
    await s1.commit();
    const state = instance.store.getState();
    expect(state.selection.nodeIds).toEqual([]);
    expect(state.pins.size).toBe(0);
  });

  it('retains replace-session dangling edges as pending records resolvable by later overlays', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    const s0 = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 1,
      baseModelRevision: 0,
    });
    await s0.append(
      batch(0, 'b0', { nodes: nodes('a'), edges: [{ id: 'e1', source: 'a', target: 'later' }] }),
    );
    const receipt = await s0.commit();
    expect(receipt.danglingEdges).toBe(1);
    expect(instance.store.getState().edgeCount).toBe(0);

    const model = instance.getRevisions().model;
    const ov = instance.beginIngest({ purpose: 'overlay', datasetKey: 'ds', baseModelRevision: model });
    await ov.append(batch(0, 'b0', { nodes: nodes('later') }));
    await ov.commit();
    expect(instance.store.getState().edgeCount).toBe(1);
  });
});

describe('removeOverlay', () => {
  it('returns { removed: false } idempotently for unknown ids, with no publication', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    let publications = 0;
    instance.store.subscribe(() => publications++);
    expect(instance.removeOverlay('nope')).toEqual({ removed: false });
    expect(publications).toBe(0);
  });

  it('removes exactly one overlay and advances model/render revisions', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: 1,
      overlayId: 'mine',
    });
    await s.append(batch(0, 'b0', { nodes: nodes('x') }));
    await s.commit();
    const before = instance.getRevisions();
    expect(instance.removeOverlay('mine')).toEqual({ removed: true });
    const after = instance.getRevisions();
    expect(after.model).toBe(before.model + 1);
    expect(after.render).toBe(before.render + 1);
    expect(instance.store.getState().nodeCount).toBe(1);
    expect(instance.getOverlayIds()).toEqual([]);
  });
});
