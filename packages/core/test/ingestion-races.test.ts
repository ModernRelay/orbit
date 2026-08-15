/**
 * Ingestion race rules and randomized exit-gate coverage.
 *
 * Randomized-batch property test maintaining the id↔index bijection,
 * replace-vs-overlay races, per-session rollback isolation (byte-identical
 * survivors), declarative snapshots aborting open sessions, overlay-id
 * conflicts, removeOverlay promotion + endpoint revalidation, shadowing
 * determinism under permuted admission order, terminal-state calls, and
 * concurrent overlay sessions merging in admission order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OrbitOperationError } from '../src/errors';
import type { GraphOperationError } from '../src/errors';
import type { GraphInstance } from '../src/instance';
import type { GraphEdge, GraphNode, IngestBatch, IngestSession } from '../src/types';
import type { FakeEngine } from '../src/testing/index';
import { container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Instance = GraphInstance<NAttrs, EAttrs>;
type Batch = IngestBatch<NAttrs, EAttrs>;

const nodes = (...ids: string[]): GraphNode<NAttrs>[] =>
  ids.map((id) => ({ id, attrs: { label: id.toUpperCase() } }));

const node = (id: string, label: string): GraphNode<NAttrs> => ({ id, attrs: { label } });

const batch = (sequence: number, batchId: string, b: Partial<Batch> = {}): Batch => ({
  sequence,
  batchId,
  ...b,
});

async function opError(p: Promise<unknown>): Promise<GraphOperationError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OrbitOperationError);
    return (e as OrbitOperationError).detail;
  }
  throw new Error('expected the operation to reject');
}

function overlaySession(instance: Instance, opts: Partial<Parameters<Instance['beginIngest']>[0]> = {}): IngestSession<NAttrs, EAttrs> {
  return instance.beginIngest({
    purpose: 'overlay',
    datasetKey: 'ds',
    baseModelRevision: instance.getRevisions().model,
    ...opts,
  });
}

/** Engine-visible position of a node id (null when unknown). */
function posOf(engine: FakeEngine, instance: Instance, id: string): readonly [number, number] | null {
  const idx = instance.getVisibleNodeIds().indexOf(id);
  if (idx === -1) return null;
  const pos = engine.getPositions();
  if (pos === null) return null;
  return [pos[2 * idx]!, pos[2 * idx + 1]!];
}

// ---------------------------------------------------------------------------
// Randomized-batch property test: the id↔index bijection holds
// through every interleaving of session begins/appends/flushes/commits/
// aborts/removals. Seeded PRNG for reproducibility.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkBijection(instance: Instance, engine: FakeEngine): void {
  const ids = instance.getVisibleNodeIds();
  const state = instance.store.getState();
  // id ↔ index bijection: unique ids, count agreement, every id resolvable.
  expect(new Set(ids).size).toBe(ids.length);
  expect(state.nodeCount).toBe(ids.length);
  for (const id of ids) {
    if (instance.getNode(id) === undefined) throw new Error(`getNode(${id}) undefined`);
  }
  // The last structural commit reflects the current scene: every
  // node-set/edge-set change is structural, so the newest structure commit
  // must agree with the store counts and index into the point set.
  let structure: { pointCount: number; links: Uint32Array } | undefined;
  for (let i = engine.commits.length - 1; i >= 0; i--) {
    const s = engine.commits[i]!.structure;
    if (s !== undefined) {
      structure = s;
      break;
    }
  }
  if (structure !== undefined) {
    expect(structure.pointCount).toBe(ids.length);
    expect(structure.links.length).toBe(2 * state.edgeCount);
    for (const idx of structure.links) {
      if (idx >= structure.pointCount) throw new Error(`link index ${idx} out of range`);
    }
  }
}

describe('randomized ingestion property test', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const seed of [1, 42, 1337]) {
    it(`maintains the id↔index bijection under random interleavings (seed ${seed})`, async () => {
      const rand = mulberry32(seed);
      const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
      const { instance, engines } = makeInstance();
      await instance.attach(container);
      const engine = engines[0]!;
      instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b']]) });

      const pool = Array.from({ length: 12 }, (_, i) => `n${i}`);
      const endpoints = [...pool, 'a', 'b', 'c', 'ghost-1', 'ghost-2'];
      interface Live {
        session: IngestSession<NAttrs, EAttrs>;
        seq: number;
      }
      let open: Live[] = [];
      const promises: Promise<unknown>[] = [];
      let edgeIdCounter = 0;

      for (let op = 0; op < 70; op++) {
        const roll = rand();
        if (roll < 0.2 || open.length === 0) {
          const s = overlaySession(instance, { atomic: rand() < 0.5 });
          open.push({ session: s, seq: 0 });
        } else if (roll < 0.6) {
          // append a random batch (correct sequence; races come from timing)
          const live = pick(open);
          const nodeRows: GraphNode<NAttrs>[] = [];
          const nNodes = Math.floor(rand() * 4);
          for (let i = 0; i < nNodes; i++) nodeRows.push(node(pick(pool), `v${op}-${i}`));
          const edgeRows: GraphEdge<EAttrs>[] = [];
          const nEdges = Math.floor(rand() * 3);
          for (let i = 0; i < nEdges; i++) {
            const e: GraphEdge<EAttrs> = { source: pick(endpoints), target: pick(endpoints) };
            if (rand() < 0.7) e.id = `E${edgeIdCounter++}`;
            edgeRows.push(e);
          }
          const b = batch(live.seq, `b${live.seq}`, { nodes: nodeRows, edges: edgeRows });
          live.seq++;
          const p = live.session.append(b);
          p.catch(() => {}); // aborted sessions reject pending appends
          promises.push(p);
          if (rand() < 0.2) {
            // idempotent replay of the batch just admitted
            const replay = live.session.append(b);
            replay.catch(() => {});
            promises.push(replay);
          }
        } else if (roll < 0.75) {
          vi.advanceTimersByTime(60); // progressive flush deadline passes
        } else if (roll < 0.9) {
          const live = pick(open);
          open = open.filter((l) => l !== live);
          const p = rand() < 0.6 ? live.session.commit() : live.session.abort();
          p.catch(() => {});
          promises.push(p);
          await p.catch(() => {});
        } else {
          const committed = instance.getOverlayIds();
          if (committed.length > 0) instance.removeOverlay(pick(committed));
        }
        checkBijection(instance, engine);
      }

      // Drain: close every session, run all timers, settle every promise.
      for (const live of open) {
        const p = live.session.commit();
        p.catch(() => {});
        promises.push(p);
        await p.catch(() => {});
      }
      vi.runAllTimers();
      await Promise.allSettled(promises);
      checkBijection(instance, engine);
    });
  }
});

// ---------------------------------------------------------------------------
// Replace-vs-overlay races.
// ---------------------------------------------------------------------------

describe('replace-vs-overlay races', () => {
  async function sessionBase(instance: Instance): Promise<void> {
    const s = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 1,
      baseModelRevision: instance.getRevisions().model,
    });
    await s.append(batch(0, 'base', { nodes: nodes('a', 'b') }));
    await s.commit();
  }

  it('an overlay publication aborts an open replace session and drops its staged work', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    await sessionBase(instance);

    const replace = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'ds',
      sourceRevision: 2,
      baseModelRevision: instance.getRevisions().model,
      maxPendingBytes: 10,
    });
    await replace.append(batch(0, 'r0', { nodes: nodes('p'), bytes: 8 }));

    const overlay = overlaySession(instance);
    await overlay.append(batch(0, 'o0', { nodes: nodes('x') }));
    await overlay.commit(); // model change NOT owned by the replace session

    expect(replace.state).toBe('aborted');
    expect((await opError(replace.commit())).code).toBe('ingest-session-closed');
    // The overlay's data survives; the replace never partially merged.
    expect(instance.store.getState().nodeCount).toBe(3); // a, b, x
    expect(instance.getNode('p')).toBeUndefined();
    expect(instance.getRevisions().source).toBe(1);
  });

  it('a replace commit aborts open overlay sessions and drops their provisional rows', async () => {
    vi.useFakeTimers();
    try {
      const { instance } = makeInstance();
      await instance.attach(container);
      await sessionBase(instance);

      const overlay = overlaySession(instance, { atomic: false });
      const flushed = overlay.append(batch(0, 'o0', { nodes: nodes('x') }));
      flushed.catch(() => {});
      vi.advanceTimersByTime(50); // x becomes provisionally public
      expect(instance.store.getState().nodeCount).toBe(3);
      const staged = overlay.append(batch(1, 'o1', { nodes: nodes('y') }));
      staged.catch(() => {});

      const replace = instance.beginIngest({
        purpose: 'replace',
        datasetKey: 'ds',
        sourceRevision: 2,
        baseModelRevision: instance.getRevisions().model,
      });
      await replace.append(batch(0, 'r0', { nodes: nodes('m', 'n') }));
      await replace.commit();

      expect(overlay.state).toBe('aborted');
      expect((await opError(staged)).code).toBe('aborted');
      expect(instance.getVisibleNodeIds()).toEqual(['m', 'n']); // x/y gone
      expect(instance.getRevisions().source).toBe(2);
      expect(instance.getOverlayIds()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Per-session rollback: abort removes exactly that session's rows.
// ---------------------------------------------------------------------------

describe('abort rollback isolation', () => {
  it('leaves other sessions rows intact byte-identically and preserves positions', async () => {
    vi.useFakeTimers();
    try {
      const { instance, engines } = makeInstance();
      await instance.attach(container);
      const engine = engines[0]!;
      instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });

      const sA = overlaySession(instance, { atomic: false, overlayId: 'A' });
      const sB = overlaySession(instance, { atomic: false, overlayId: 'B' });
      void sA.append(batch(0, 'a0', { nodes: nodes('x1', 'x2') })).catch(() => {});
      void sB
        .append(batch(0, 'b0', { nodes: nodes('y1', 'y2'), edges: [{ id: 'e1', source: 'a', target: 'y1' }] }))
        .catch(() => {});
      vi.advanceTimersByTime(50); // both provisional sets public
      expect(instance.store.getState().nodeCount).toBe(6);
      expect(instance.store.getState().edgeCount).toBe(1);

      const y1Before = instance.getNode('y1')!;
      const y2Before = instance.getNode('y2')!;
      const posY1 = posOf(engine, instance, 'y1')!;
      const posA = posOf(engine, instance, 'a')!;
      const modelBefore = instance.getRevisions().model;

      await sA.abort('caller aborted');

      // Rollback advanced modelRevision (provisional state HAD become public)
      expect(instance.getRevisions().model).toBe(modelBefore + 1);
      // Exactly A's rows are gone; B's rows are the SAME objects.
      expect(instance.getNode('x1')).toBeUndefined();
      expect(instance.getNode('x2')).toBeUndefined();
      expect(instance.getNode('y1')).toBe(y1Before);
      expect(instance.getNode('y2')).toBe(y2Before);
      expect(instance.store.getState().edgeCount).toBe(1);
      // Positions of survivors are untouched by the rollback commit.
      expect(posOf(engine, instance, 'y1')).toEqual(posY1);
      expect(posOf(engine, instance, 'a')).toEqual(posA);
      // B keeps working after A's rollback.
      void sB.append(batch(1, 'b1', { nodes: nodes('y3') })).catch(() => {});
      vi.advanceTimersByTime(50);
      expect(instance.getNode('y3')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an abort before any publication publishes nothing and does not advance the model', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = overlaySession(instance); // atomic: nothing public until commit
    await s.append(batch(0, 'b0', { nodes: nodes('x') }));
    const modelBefore = instance.getRevisions().model;
    let publications = 0;
    instance.store.subscribe(() => publications++);
    await s.abort();
    expect(publications).toBe(0);
    expect(instance.getRevisions().model).toBe(modelBefore);
    expect(s.state).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// Declarative snapshots vs sessions.
// ---------------------------------------------------------------------------

describe('declarative snapshots vs open sessions', () => {
  it('a replacing snapshot aborts ALL open sessions and clears every overlay', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    // One committed overlay + one open atomic session with staged work + one
    // open progressive session with staged work.
    const committed = overlaySession(instance, { overlayId: 'keepsake' });
    await committed.append(batch(0, 'c0', { nodes: nodes('k') }));
    await committed.commit();
    expect(instance.store.getState().nodeCount).toBe(2);

    const atomic = overlaySession(instance, { maxPendingBytes: 10 });
    await atomic.append(batch(0, 'a0', { nodes: nodes('p'), bytes: 8 }));
    const progressive = overlaySession(instance, { atomic: false });
    const staged = progressive.append(batch(0, 'p0', { nodes: nodes('r') }));
    staged.catch(() => {});

    instance.applyHostUpdate({ data: snap(2, ['a', 'z']) }); // replacing snapshot

    expect(atomic.state).toBe('aborted');
    expect(progressive.state).toBe('aborted');
    expect((await opError(staged)).code).toBe('aborted');
    expect((await opError(atomic.commit())).code).toBe('ingest-session-closed');
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'z']); // overlay 'k' cleared
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.store.getState().overlayIds).toEqual([]);
  });

  it('a base-source idempotent replay does NOT clear overlays or abort sessions', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });
    const engine = engines[0]!;

    const committed = overlaySession(instance, { overlayId: 'expansion' });
    await committed.append(batch(0, 'c0', { nodes: nodes('x') }));
    await committed.commit();
    const openS = overlaySession(instance);
    await openS.append(batch(0, 'o0', { nodes: nodes('y') }));

    const revisionsBefore = instance.getRevisions();
    const commitsBefore = engine.commits.length;
    // The ordinary React re-render: same {datasetKey, sourceRevision} replay.
    instance.applyHostUpdate({ data: snap(1, ['a', 'b']) });

    expect(instance.getRevisions()).toEqual(revisionsBefore);
    expect(engine.commits.length).toBe(commitsBefore);
    expect(instance.getOverlayIds()).toEqual(['expansion']);
    expect(instance.getNode('x')).toBeDefined(); // overlay rows survived
    expect(openS.state).toBe('open'); // open session survived
    await openS.commit();
    expect(instance.getNode('y')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Overlay-id conflicts.
// ---------------------------------------------------------------------------

describe('overlay-id conflicts', () => {
  it('terminally rejects the LATER session whose first append reaches the queue', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const first = overlaySession(instance, { overlayId: 'dup' });
    const second = overlaySession(instance, { overlayId: 'dup' }); // begin is fine
    await first.append(batch(0, 'f0', { nodes: nodes('x') })); // reserves 'dup'

    const detail = await opError(second.append(batch(0, 's0', { nodes: nodes('y') })));
    expect(detail).toEqual({ code: 'overlay-id-conflict', overlayId: 'dup' });
    expect(second.state).toBe('aborted');
    expect((await opError(second.commit())).code).toBe('ingest-session-closed');

    await first.commit(); // the winner is unaffected
    expect(instance.getOverlayIds()).toEqual(['dup']);
    expect(instance.getNode('x')).toBeDefined();
    expect(instance.getNode('y')).toBeUndefined();
  });

  it('conflicts against a COMMITTED overlay id; removal releases it for reuse', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const first = overlaySession(instance, { overlayId: 'slot' });
    await first.append(batch(0, 'f0', { nodes: nodes('x') }));
    await first.commit();

    const clash = overlaySession(instance, { overlayId: 'slot' });
    expect((await opError(clash.commit())).code).toBe('overlay-id-conflict');

    expect(instance.removeOverlay('slot')).toEqual({ removed: true });
    const reuse = overlaySession(instance, { overlayId: 'slot' });
    await reuse.append(batch(0, 'r0', { nodes: nodes('z') }));
    await reuse.commit();
    expect(instance.getOverlayIds()).toEqual(['slot']);
    expect(instance.getNode('z')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// removeOverlay: promotion + endpoint revalidation.
// ---------------------------------------------------------------------------

describe('removeOverlay promotion & endpoint revalidation', () => {
  it('promotes formerly shadowed rows from surviving overlays', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const sA = overlaySession(instance, { overlayId: 'A' });
    await sA.append(batch(0, 'a0', { nodes: [node('n', 'FROM-A')] }));
    const sB = overlaySession(instance, { overlayId: 'B' });
    await sB.append(batch(0, 'b0', { nodes: [node('n', 'FROM-B'), node('m', 'M')] }));
    await sA.commit();
    await sB.commit();

    // Earliest admission (A's append) wins; B's row is retained-but-shadowed.
    expect(instance.getNode('n')!.attrs!.label).toBe('FROM-A');
    const shadow = instance.getDiagnostics().find((d) => d.code === 'overlay-node-shadowed');
    expect(shadow).toBeDefined();
    expect(shadow!.severity).toBe('info');
    expect(shadow!.count).toBe(1);
    expect(shadow!.sampleIds).toContain('n');

    expect(instance.removeOverlay('A')).toEqual({ removed: true });
    // B's shadowed row is PROMOTED; the shadow diagnostic clears.
    expect(instance.getNode('n')!.attrs!.label).toBe('FROM-B');
    expect(
      instance.getDiagnostics().some((d) => d.code === 'overlay-node-shadowed'),
    ).toBe(false);
    expect(instance.store.getState().nodeCount).toBe(3); // a, n, m
  });

  it('re-runs endpoint resolution: edges re-pend when their endpoint provider is removed', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const provider = overlaySession(instance, { overlayId: 'provider' });
    await provider.append(batch(0, 'p0', { nodes: nodes('x') }));
    await provider.commit();

    const edgy = overlaySession(instance, { overlayId: 'edgy' });
    await edgy.append(batch(0, 'e0', { edges: [{ id: 'ax', source: 'a', target: 'x' }] }));
    const r = await edgy.commit();
    expect(r.danglingEdges).toBe(0);
    expect(instance.store.getState().edgeCount).toBe(1);

    instance.removeOverlay('provider');
    // 'x' departed → the edge record re-pends (out of the link buffer)...
    expect(instance.store.getState().edgeCount).toBe(0);
    expect(instance.getNode('x')).toBeUndefined();

    //...and a NEW endpoint provider resolves it again.
    const again = overlaySession(instance, { overlayId: 'again' });
    await again.append(batch(0, 'g0', { nodes: nodes('x') }));
    await again.commit();
    expect(instance.store.getState().edgeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Shadowing determinism & admission-order merging.
// ---------------------------------------------------------------------------

describe('shadowing determinism under permuted admission order', () => {
  it('the earliest APPEND admission wins regardless of commit order', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const sA = overlaySession(instance, { overlayId: 'A' });
    const sB = overlaySession(instance, { overlayId: 'B' });
    await sA.append(batch(0, 'a0', { nodes: [node('n', 'FROM-A')] }));
    await sB.append(batch(0, 'b0', { nodes: [node('n', 'FROM-B')] }));
    // Commit in REVERSE order: B first, then A.
    await sB.commit();
    expect(instance.getNode('n')!.attrs!.label).toBe('FROM-B'); // A not public yet
    await sA.commit();
    // A's row was admitted first → it wins once public; B's is shadowed.
    expect(instance.getNode('n')!.attrs!.label).toBe('FROM-A');
  });

  it('is deterministic per interleaving: permuting appends flips the winner', async () => {
    const run = async (firstIsA: boolean): Promise<string> => {
      const { instance } = makeInstance();
      await instance.attach(container);
      instance.applyHostUpdate({ data: snap(1, ['a']) });
      const sA = overlaySession(instance, { overlayId: 'A' });
      const sB = overlaySession(instance, { overlayId: 'B' });
      if (firstIsA) {
        await sA.append(batch(0, 'a0', { nodes: [node('n', 'FROM-A')] }));
        await sB.append(batch(0, 'b0', { nodes: [node('n', 'FROM-B')] }));
      } else {
        await sB.append(batch(0, 'b0', { nodes: [node('n', 'FROM-B')] }));
        await sA.append(batch(0, 'a0', { nodes: [node('n', 'FROM-A')] }));
      }
      await sA.commit();
      await sB.commit();
      return instance.getNode('n')!.attrs!.label;
    };
    expect(await run(true)).toBe('FROM-A');
    expect(await run(false)).toBe('FROM-B');
  });

  it('concurrent overlay sessions merge row-wise in global admission order', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });

    const sA = overlaySession(instance, { overlayId: 'A' });
    const sB = overlaySession(instance, { overlayId: 'B' });
    await sA.append(batch(0, 'a0', { nodes: [node('n1', 'A1')] }));
    await sB.append(batch(0, 'b0', { nodes: [node('n1', 'B1'), node('n2', 'B2')] }));
    await sA.append(batch(1, 'a1', { nodes: [node('n2', 'A2')] }));
    await sA.commit();
    await sB.commit();

    // Row-level admission order: n1 from A (earlier), n2 from B (earlier).
    expect(instance.getNode('n1')!.attrs!.label).toBe('A1');
    expect(instance.getNode('n2')!.attrs!.label).toBe('B2');
    // Merged order is deterministic: base, then rows by admission ticket.
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'n1', 'n2']);
    const shadow = instance.getDiagnostics().find((d) => d.code === 'overlay-node-shadowed');
    expect(shadow!.count).toBe(2); // B's n1 and A's n2
  });
});

// ---------------------------------------------------------------------------
// Terminal-state calls.
// ---------------------------------------------------------------------------

describe('terminal-state calls', () => {
  it('append/commit/abort after abort() reject as closed', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = overlaySession(instance);
    await s.append(batch(0, 'b0', { nodes: nodes('x') }));
    await s.abort('caller');
    expect(s.state).toBe('aborted');
    expect((await opError(s.append(batch(1, 'b1')))).code).toBe('ingest-session-closed');
    expect((await opError(s.commit())).code).toBe('ingest-session-closed');
    expect((await opError(s.abort())).code).toBe('ingest-session-closed');
    // The admitted-but-unpublished row never surfaced.
    expect(instance.getNode('x')).toBeUndefined();
  });

  it('destroy() aborts open sessions and drops their unpublished atomic work', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a']) });
    const s = overlaySession(instance, { maxPendingBytes: 10 });
    await s.append(batch(0, 'b0', { nodes: nodes('x'), bytes: 8 }));
    instance.destroy();
    expect(s.state).toBe('aborted');
    expect(instance.getNode('x')).toBeUndefined();
    expect((await opError(s.commit())).code).toBe('ingest-session-closed');
  });
});
