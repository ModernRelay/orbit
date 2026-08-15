/**
 * expansion-record stacks with collapse exceptions.
 *
 * Covers the per-node {expandedId, addedNodeIds} record stack
 * pushed by each session-path expandNode; retractExpansion popping the MOST
 * RECENT record and removing its addedNodeIds from the effective set EXCEPT
 * (a) ids re-added by another live record and (b) ids still reachable from
 * the effective set without traversing the collapsed id; the in-flight abort
 * race (a late-resolving result admits ZERO nodes); reconcile invalidation
 * (source replacement drops records referencing departed nodes); the
 * subgraph-statement reset (all records clear, effective set resets); and
 * the interleave — expansion/collapse are history steps whose walk
 * restores IDENTICAL effective sets while the records themselves stay
 * module-local (never a store slice, never serialized).
 */

import { describe, expect, it } from 'vitest';

import { createGraphInstance } from '../src/instance';
import type { GraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import type {
  ExpansionResponse,
  ExpansionService,
  GraphSnapshot,
  RequestContext,
  SubgraphSpec,
} from '../src/types';
import { snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

type Instance = GraphInstance<NAttrs, EAttrs>;
type Response = ExpansionResponse<NAttrs, EAttrs>;

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Seed-keyed canned service: expand(id) resolves table[id] (else noop-ish). */
function tableService(
  table: Record<string, Response>,
): ExpansionService<NAttrs, EAttrs> & { contexts: RequestContext[] } {
  const contexts: RequestContext[] = [];
  return {
    contexts,
    revisionDependencies: ['source'],
    neighbors(seedIds, _hops, ctx) {
      contexts.push(ctx);
      const seed = seedIds[0]!;
      return Promise.resolve(table[seed] ?? {});
    },
  };
}

function makeInstance(service?: ExpansionService<NAttrs, EAttrs>) {
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

function visible(instance: Instance): readonly string[] {
  return instance.getVisibleNodeIds();
}

const node = (id: string) => ({ id, attrs: { label: id.toUpperCase() } });
const edge = (id: string, source: string, target: string) => ({
  id,
  source,
  target,
  attrs: { weight: 1 },
});

describe('expandNode settles on a CURRENT store (B1 regression)', () => {
  it('awaiting expandNode resumes AFTER its own trailing publication', async () => {
    const service = tableService({
      a: { nodes: [node('z')], edges: [edge('a-z', 'a', 'z')] },
    });
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    const before = instance.store.getState().history.undoDepth;
    await instance.expandNode('a');

    // The cleanup publication used to ride a `.finally()` — one microtask
    // AFTER the caller resumed — so an awaiting host observed a stale
    // loading affordance and an under-reported history depth.
    expect(instance.store.getState().pendingExpansions.size).toBe(0);
    expect(instance.store.getState().history.undoDepth).toBe(before + 1);
    expect(visible(instance)).toContain('z'); // data was already correct
  });

  it('a REJECTED expansion also clears its pending slot before rejecting', async () => {
    const failing: ExpansionService<NAttrs, EAttrs> = {
      revisionDependencies: ['source'],
      neighbors: () => Promise.reject(new Error('service exploded')),
    };
    const { instance } = makeInstance(failing);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    await expect(instance.expandNode('a')).rejects.toThrow(/exploded/);
    expect(instance.store.getState().pendingExpansions.size).toBe(0);
  });
});

describe('collapse exceptions over the record stack', () => {
  it('double-expansion survivor: a node added by two expansions survives collapsing one of them', async () => {
    const service = tableService({
      a: { nodes: [node('z')], edges: [edge('a-z', 'a', 'z')] },
      b: { nodes: [node('z')], edges: [edge('b-z', 'b', 'z')] },
    });
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b']]) });

    await expect(instance.expandNode('a')).resolves.toEqual({ added: 1 });
    // Second expansion returns z again: already visible, but the NEW edge
    // opens a session — the record lists z as re-added (owned by both).
    await expect(instance.expandNode('b')).resolves.toEqual({ added: 0 });

    instance.retractExpansion('a');
    // z is re-added by b's live record — it survives collapsing a.
    expect(visible(instance)).toContain('z');
    expect(instance.getNode('z')).toBeDefined();
  });

  it('keeps reachable survivors and removes unreachable nodes while data persists', async () => {
    // expand(b) adds y (b-y AND c-y) and w (b-w only): collapsing b keeps y
    // (reachable from c without traversing b) and removes w (unreachable).
    const service = tableService({
      b: {
        nodes: [node('y'), node('w')],
        edges: [edge('b-y', 'b', 'y'), edge('c-y', 'c', 'y'), edge('b-w', 'b', 'w')],
      },
    });
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]) });

    await expect(instance.expandNode('b')).resolves.toEqual({ added: 2 });
    expect(visible(instance)).toEqual(['a', 'b', 'c', 'y', 'w']);

    const events: SubgraphSpec[] = [];
    instance.on('subgraphChange', (p) => events.push(p.subgraph));
    const modelBefore = instance.getRevisions().model;

    instance.retractExpansion('b');
    expect(visible(instance)).toEqual(['a', 'b', 'c', 'y']); // w removed, y kept
    // VISIBILITY trim, not data removal: the overlay persists.
    expect(instance.getNode('w')).toBeDefined();
    expect(instance.getOverlayIds()).toHaveLength(1);
    // Scope-driven publication: scope+render advanced, model untouched.
    expect(instance.getRevisions().model).toBe(modelBefore);
    // The reporting seam fired with the next effective set.
    expect(events).toHaveLength(1);
    expect(events[0]!.seedIds).toEqual(['a', 'b', 'c', 'y']);
  });

  it('unreachable-only collapse removes the whole overlay (v0.5 explicit-removal contract)', async () => {
    const service = tableService({
      b: { nodes: [node('w')], edges: [edge('b-w', 'b', 'w')] },
    });
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    await expect(instance.expandNode('b')).resolves.toEqual({ added: 1 });
    instance.retractExpansion('b');

    expect(visible(instance)).toEqual(['a', 'b']);
    expect(instance.getNode('w')).toBeUndefined(); // data removed with the overlay
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.getExpansionOverlays('b')).toEqual([]);
  });

  it('collapse pops the MOST RECENT record for the id (stack order)', async () => {
    // Two expansions of b: first adds x (b-x), second adds w (b-w). One
    // collapse pops the w record only; a second pops the x record.
    let call = 0;
    const service: ExpansionService<NAttrs, EAttrs> = {
      revisionDependencies: ['source'],
      neighbors() {
        call++;
        return Promise.resolve(
          call === 1
            ? { nodes: [node('x')], edges: [edge('b-x', 'b', 'x')] }
            : { nodes: [node('w')], edges: [edge('b-w', 'b', 'w')] },
        );
      },
    };
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    await expect(instance.expandNode('b')).resolves.toEqual({ added: 1 });
    await expect(instance.expandNode('b')).resolves.toEqual({ added: 1 });
    expect(visible(instance)).toEqual(['a', 'b', 'x', 'w']);

    instance.retractExpansion('b');
    expect(visible(instance)).toEqual(['a', 'b', 'x']); // w (newest record) left
    instance.retractExpansion('b');
    expect(visible(instance)).toEqual(['a', 'b']); // then x
  });
});

describe('in-flight abort race', () => {
  it('retractExpansion during a pending expandNode aborts the RequestContext and a late result admits zero nodes', async () => {
    let resolveCall!: (r: Response) => void;
    const contexts: RequestContext[] = [];
    const service: ExpansionService<NAttrs, EAttrs> = {
      revisionDependencies: ['source'],
      neighbors(_seeds, _hops, ctx) {
        contexts.push(ctx);
        return new Promise<Response>((res) => {
          resolveCall = res;
        });
      },
    };
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });

    const p = instance.expandNode('b');
    const rejection = expect(p).rejects.toMatchObject({
      detail: { code: 'aborted', cause: 'collapsed' },
    });
    expect(contexts[0]!.signal.aborted).toBe(false);

    instance.retractExpansion('b');
    expect(contexts[0]!.signal.aborted).toBe(true); // abort as an optimization
    await rejection;

    const before = instance.getRevisions();
    resolveCall({ nodes: [node('late')], edges: [edge('b-late', 'b', 'late')] });
    await flush();
    // The ownership check discards the late result: ZERO nodes admitted.
    expect(instance.getNode('late')).toBeUndefined();
    expect(instance.getOverlayIds()).toEqual([]);
    expect(instance.getRevisions()).toEqual(before);
    expect(instance.store.getState().pendingExpansions.size).toBe(0);
  });
});

describe('reconcile invalidation', () => {
  it('source replacement invalidates records referencing departed nodes; records over surviving nodes stay poppable', async () => {
    const service = tableService({
      a: { nodes: [node('z')], edges: [edge('a-z', 'a', 'z')] },
      c: { nodes: [node('y')], edges: [edge('c-y', 'c', 'y')] },
    });
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]) });

    await expect(instance.expandNode('a')).resolves.toEqual({ added: 1 });
    await expect(instance.expandNode('c')).resolves.toEqual({ added: 1 });

    // Replacement (same datasetKey, new sourceRevision): keeps y as a BASE
    // row, drops z. The z record dies; the y record survives.
    const replacement: GraphSnapshot<NAttrs, EAttrs> = {
      datasetKey: 'ds',
      sourceRevision: 2,
      nodes: [node('a'), node('b'), node('c'), node('y')],
      edges: [edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c'), edge('c-y', 'c', 'y')],
    };
    instance.applyHostUpdate({ data: replacement });
    expect(visible(instance)).toEqual(['a', 'b', 'c', 'y']);

    // Dead record: collapsing a changes nothing and reports nothing.
    const events: SubgraphSpec[] = [];
    instance.on('subgraphChange', (p) => events.push(p.subgraph));
    const depthsBefore = instance.store.getState().history;
    instance.retractExpansion('a');
    expect(visible(instance)).toEqual(['a', 'b', 'c', 'y']);
    expect(events).toEqual([]);
    expect(instance.store.getState().history).toEqual(depthsBefore);

    // Live record: collapsing c pops it — y hides (data persists: base row).
    instance.retractExpansion('c');
    expect(visible(instance)).toEqual(['a', 'b', 'c']);
    expect(instance.getNode('y')).toBeDefined();
  });

  it('a subgraph prop change clears ALL records and resets the effective set', async () => {
    const service = tableService({
      a: { nodes: [node('z')], edges: [edge('a-z', 'a', 'z')] },
    });
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]),
      subgraph: { seedIds: ['a'] },
    });
    expect(visible(instance)).toEqual(['a']);

    await expect(instance.expandNode('a')).resolves.toEqual({ added: 1 });
    expect(visible(instance)).toEqual(['a', 'z']); // accretion

    // An explicit scope statement resets the effective set: the accretion
    // AND every record clear — a later collapse has nothing to pop.
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });
    expect(visible(instance)).toEqual(['a', 'b']);

    const events: unknown[] = [];
    instance.on('subgraphChange', (p) => events.push(p.subgraph));
    instance.retractExpansion('a');
    expect(visible(instance)).toEqual(['a', 'b']); // no record left to pop
    expect(events).toEqual([]);

    // Clearing the scope restores the full model because z remains in the accepted data.
    instance.applyHostUpdate({ subgraph: null });
    expect(visible(instance)).toEqual(['a', 'b', 'c', 'z']);
  });
});

describe('interleave: expansion/collapse as history steps', () => {
  it('a walk over expand → hide → collapse restores IDENTICAL effective sets at every cursor position', async () => {
    // expand(a) adds z (a-z only: unreachable without a) and y (a-y + c-y:
    // reachable survivor) — collapse is a TRIM step (y survives, z hides).
    const service = tableService({
      a: {
        nodes: [node('z'), node('y')],
        edges: [edge('a-z', 'a', 'z'), edge('a-y', 'a', 'y'), edge('c-y', 'c', 'y')],
      },
    });
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]) });
    const e0 = visible(instance);
    expect(e0).toEqual(['a', 'b', 'c']);

    await expect(instance.expandNode('a')).resolves.toEqual({ added: 2 });
    const e1 = visible(instance);
    expect(e1).toEqual(['a', 'b', 'c', 'z', 'y']);
    expect(instance.store.getState().history.undoDepth).toBe(1); // expansion step

    instance.hideNodes(['b']);
    expect(instance.store.getState().history.undoDepth).toBe(2);

    instance.retractExpansion('a');
    const e2 = visible(instance);
    expect(e2).toEqual(['a', 'c', 'y']); // z trimmed, y survives, b mask-hidden
    expect(instance.store.getState().history.undoDepth).toBe(3); // collapse step

    // Walk down: each undo restores the exact prior effective set.
    expect(instance.undo()).toBe(true); // undo collapse
    expect(visible(instance)).toEqual(['a', 'c', 'z', 'y']); // b still hidden
    expect(instance.undo()).toBe(true); // undo hide
    expect(visible(instance)).toEqual(e1);
    expect(instance.undo()).toBe(true); // undo expansion — z/y leave the view
    expect(visible(instance)).toEqual(e0);
    // Overlay DATA persists across the walk — only visibility moved.
    expect(instance.getNode('z')).toBeDefined();
    expect(instance.getNode('y')).toBeDefined();

    // Walk back up: identical effective sets in forward order.
    expect(instance.redo()).toBe(true);
    expect(visible(instance)).toEqual(e1);
    expect(instance.redo()).toBe(true);
    expect(visible(instance)).toEqual(['a', 'c', 'z', 'y']);
    expect(instance.redo()).toBe(true);
    expect(visible(instance)).toEqual(e2);
    expect(instance.redo()).toBe(false);
  });

  it('records are session-local: no store slice, nothing record-shaped in the published state', async () => {
    const service = tableService({
      a: { nodes: [node('z')], edges: [edge('a-z', 'a', 'z')] },
    });
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    await expect(instance.expandNode('a')).resolves.toEqual({ added: 1 });

    // At this point the store is the only
    // serializable surface — assert the record stack never leaks into it.
    const state = instance.store.getState();
    expect(Object.keys(state)).not.toContain('expansionRecords');
    expect(JSON.stringify({ ...state, pins: [], hiddenNodeIds: [], pinnedNodeIds: [] })).not.toContain(
      'expandedId',
    );
  });

  it('a fully-surviving collapse still pops as a step (no resurrection through the other record)', async () => {
    const service = tableService({
      a: { nodes: [node('z')], edges: [edge('a-z', 'a', 'z')] },
      b: { nodes: [node('z')], edges: [edge('b-z', 'b', 'z')] },
    });
    const { instance } = makeInstance(service);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    await expect(instance.expandNode('a')).resolves.toEqual({ added: 1 });
    await expect(instance.expandNode('b')).resolves.toEqual({ added: 0 });
    expect(instance.store.getState().history.undoDepth).toBe(2);

    instance.retractExpansion('a'); // z survives via b's record — pure pop
    expect(visible(instance)).toContain('z');
    expect(instance.store.getState().history.undoDepth).toBe(3);

    // With a's record popped, collapsing b removes z: no other record owns
    // it and z's only non-b link (a-z) does not save it — z is reachable
    // from a WITHOUT traversing b... so it survives; verify precisely.
    instance.retractExpansion('b');
    // a-z rides in overlay data: z stays reachable from a → survivor.
    expect(visible(instance)).toContain('z');
  });
});
