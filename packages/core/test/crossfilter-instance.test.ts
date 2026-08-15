/**
 * Crossfilter wired through the instance.
 *
 * The engine is built over the ACCEPTED model's nodes (base + published
 * overlays — never the scoped subset): brushes route their slot deltas into
 * the 'brushes' mask source (buffers-only commit, zero relayout);
 * ingestion appends extend columns WITHOUT a rebuild; replaces preserve
 * brushes by dimension key; a datasetKey change clears them.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import { createGraphInstance } from '../src/instance';
import { TypedColumnCrossfilter } from '../src/crossfilter';
import { FakeEngine } from '../src/testing/index';
import type { DimensionSpec, GraphSnapshot } from '../src/types';
import { container } from './helpers';

type NA = { v: number; cat: string };
type EA = Record<string, never>;

const vDim: DimensionSpec<NA> = { key: 'v', kind: 'numeric', get: (n) => n.attrs?.v };
const catDim: DimensionSpec<NA> = { key: 'cat', kind: 'categorical', get: (n) => n.attrs?.cat };

const alphaAt = (buf: Float32Array, i: number): number => buf[4 * i + 3]!;

function snapOf(
  rev: number | string,
  rows: ReadonlyArray<readonly [string, number, string]>,
  links: ReadonlyArray<readonly [string, string]> = [],
  datasetKey = 'ds',
): GraphSnapshot<NA, EA> {
  return {
    datasetKey,
    sourceRevision: rev,
    nodes: rows.map(([id, v, cat]) => ({ id, attrs: { v, cat } })),
    edges: links.map(([source, target]) => ({ source, target })),
  };
}

/** a..f with v 1..6; cat x for a..c, y for d..f; edges a→b and e→f. */
const BASE_ROWS: ReadonlyArray<readonly [string, number, string]> = [
  ['a', 1, 'x'],
  ['b', 2, 'x'],
  ['c', 3, 'x'],
  ['d', 4, 'y'],
  ['e', 5, 'y'],
  ['f', 6, 'y'],
];

function rig() {
  const engines: FakeEngine[] = [];
  const instance = createGraphInstance<NA, EA>({
    engine: () => {
      const e = new FakeEngine();
      engines.push(e);
      return e;
    },
  });
  return { instance, engines };
}

async function readyRig() {
  const r = rig();
  await r.instance.attach(container);
  r.instance.applyHostUpdate({
    data: snapOf(1, BASE_ROWS, [
      ['a', 'b'],
      ['e', 'f'],
    ]),
    nodeColor: 'red',
    crossfilter: [vDim, catDim],
  });
  return { ...r, engine: r.engines[0]! };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session lifecycle', () => {
  it('getCrossfilterSession is null before the crossfilter prop (and before data)', async () => {
    const { instance } = rig();
    expect(instance.getCrossfilterSession()).toBeNull();

    // Dimensions before any data: still null (no base to column-ize).
    instance.applyHostUpdate({ crossfilter: [vDim] });
    expect(instance.getCrossfilterSession()).toBeNull();

    // Data arrives: the engine builds over the accepted base.
    instance.applyHostUpdate({ data: snapOf(1, BASE_ROWS) });
    const session = instance.getCrossfilterSession();
    expect(session).not.toBeNull();
    expect(session!.selectionRevision).toBe(0);
    expect(session!.getBrush('v')).toBeNull();
  });
});

describe('brush → mask fast path', () => {
  it('setBrush hides failing rows via ONE buffers-only commit and updates visible counts', async () => {
    const { instance, engine } = await readyRig();
    const session = instance.getCrossfilterSession()!;
    const commitsBefore = engine.commits.length;
    const revBefore = instance.getRevisions();

    await session.setBrush('v', { min: 1, max: 3 });

    expect(engine.commits.length).toBe(commitsBefore + 1);
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeUndefined();
    expect(commit.restart).toBeUndefined();
    const pc = commit.buffers!.pointColor!;
    expect([0, 1, 2].map((i) => alphaAt(pc, i))).toEqual([1, 1, 1]); // a,b,c pass
    expect([3, 4, 5].map((i) => alphaAt(pc, i))).toEqual([0, 0, 0]); // d,e,f fail
    // Edge cascade: e→f loses both endpoints; a→b survives at the THEME's
    // edgeDefault translucency (0.15 dark base — I5, no accessor configured).
    const lc = commit.buffers!.linkColor!;
    expect(alphaAt(lc, 0)).toBeCloseTo(0.15, 3);
    expect(alphaAt(lc, 1)).toBe(0);

    const state = instance.store.getState();
    expect(state.visible).toEqual({ nodes: 3, edges: 1 });
    expect(state.nodeCount).toBe(6); // accepted counts untouched
    const rev = instance.getRevisions();
    expect(rev.model).toBe(revBefore.model);
    expect(rev.scope).toBe(revBefore.scope + 1);
    expect(rev.render).toBe(revBefore.render + 1);
    expect(session.selectionRevision).toBe(1);
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
  });

  it('clearing the brush restores visibility', async () => {
    const { instance } = await readyRig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 1, max: 3 });
    await session.setBrush('v', null);
    expect(instance.store.getState().visible).toEqual({ nodes: 6, edges: 2 });
    expect(session.selectionRevision).toBe(2);
  });
});

describe('summarize dual layer', () => {
  it("the filtered layer composes OTHER dims' brushes + the filter-prop/hidden external mask", async () => {
    const { instance } = await readyRig();
    const session = instance.getCrossfilterSession()!;

    // Filter prop hides 'a' → the external mask excludes it from filtered.
    instance.applyHostUpdate({ filter: { nodes: { op: 'neq', field: 'id', value: 'a' } } });
    let cats = session.summarize('cat').categories;
    expect(cats.find((c) => c.key === 'x')).toMatchObject({ total: 3, filtered: 2 });
    expect(cats.find((c) => c.key === 'y')).toMatchObject({ total: 3, filtered: 3 });

    // A v-brush excludes f from cat's filtered layer (other-dim brush).
    await session.setBrush('v', { min: 1, max: 5 });
    cats = session.summarize('cat').categories;
    expect(cats.find((c) => c.key === 'x')).toMatchObject({ total: 3, filtered: 2 });
    expect(cats.find((c) => c.key === 'y')).toMatchObject({ total: 3, filtered: 2 });

    // hiddenNodeIds also feed the external mask.
    instance.hideNodes(['b']);
    cats = session.summarize('cat').categories;
    expect(cats.find((c) => c.key === 'x')).toMatchObject({ total: 3, filtered: 1 });
  });

  it('a filter active BEFORE the crossfilter prop still feeds the external mask', async () => {
    const { instance } = rig();
    await instance.attach(container);
    instance.applyHostUpdate({
      data: snapOf(1, BASE_ROWS),
      filter: { nodes: { op: 'neq', field: 'id', value: 'a' } },
    });
    instance.applyHostUpdate({ crossfilter: [vDim, catDim] });

    const cats = instance.getCrossfilterSession()!.summarize('cat').categories;
    expect(cats.find((c) => c.key === 'x')).toMatchObject({ total: 3, filtered: 2 });
  });
});

describe('model-change rules', () => {
  it('overlay ingestion APPENDS without a rebuild and brushes persist', async () => {
    const buildSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'build');
    const appendSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'appendRows');
    const replaceSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'replaceAll');

    const { instance } = await readyRig();
    expect(buildSpy).toHaveBeenCalledTimes(1);
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 1, max: 3 });

    const ingest = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: instance.getRevisions().model,
    });
    await ingest.append({ sequence: 0, batchId: 'b0', nodes: [{ id: 'g', attrs: { v: 10, cat: 'y' } }] });
    await ingest.commit();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy).toHaveBeenCalledTimes(1); // NO rebuild
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(session.getBrush('v')).toEqual({ min: 1, max: 3 }); // brush persisted
    // The appended row is evaluated against the preserved brush: g (v=10) fails.
    expect(instance.store.getState().nodeCount).toBe(7);
    expect(instance.store.getState().visible.nodes).toBe(3);
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);
    expect(session.summarize('v').domain).toEqual({ min: 1, max: 10 });
  });

  it('a replacing snapshot preserves brushes BY KEY across the new roster', async () => {
    const replaceSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'replaceAll');
    const { instance } = await readyRig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 1, max: 2 });

    // Same dataset, new roster (not a prefix extension) → replaceAll.
    instance.applyHostUpdate({
      data: snapOf(2, [
        ['a', 1, 'x'],
        ['b', 2, 'x'],
        ['z', 9, 'y'],
      ]),
    });

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(session.getBrush('v')).toEqual({ min: 1, max: 2 });
    expect(instance.store.getState().visible.nodes).toBe(2); // z fails the kept brush
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
  });

  it('a datasetKey change clears brushes (rebuild)', async () => {
    const { instance } = await readyRig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 1, max: 2 });
    expect(instance.store.getState().visible.nodes).toBe(2);

    instance.applyHostUpdate({ data: snapOf(1, BASE_ROWS, [], 'ds2') });

    const fresh = instance.getCrossfilterSession()!;
    expect(fresh.getBrush('v')).toBeNull();
    expect(instance.store.getState().visible).toEqual({ nodes: 6, edges: 0 });
  });

  it('dimension-spec identity change rebuilds (brushes cleared)', async () => {
    const buildSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'build');
    const { instance } = await readyRig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 1, max: 2 });
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // Same key, NEW spec object identity → rebuild.
    const vDim2: DimensionSpec<NA> = { key: 'v', kind: 'numeric', get: (n) => n.attrs?.v };
    instance.applyHostUpdate({ crossfilter: [vDim2, catDim] });

    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(instance.getCrossfilterSession()!.getBrush('v')).toBeNull();
    expect(instance.store.getState().visible.nodes).toBe(6); // stale brush mask cleared

    // Same spec REFERENCES in a fresh array → no rebuild.
    instance.applyHostUpdate({ crossfilter: [vDim2, catDim] });
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it('an invalid spec replacement is REJECTED and the live session survives', async () => {
    const { instance } = await readyRig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 1, max: 3 });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);

    // Duplicate dimension keys: the candidate build throws. The previous
    // engine, brushes, mask, and facade must be fully preserved.
    const dupA: DimensionSpec<NA> = { key: 'dup', kind: 'numeric', get: (n) => n.attrs?.v };
    const dupB: DimensionSpec<NA> = { key: 'dup', kind: 'categorical', get: (n) => n.attrs?.cat };
    instance.applyHostUpdate({ crossfilter: [dupA, dupB] });

    const diags = instance.store.getState().diagnostics;
    expect(
      diags.some((d) => d.code === 'operation-rejected' && d.message.includes('crossfilter')),
    ).toBe(true);
    // Old session fully usable: brush intact, summaries respond, and a
    // further brush change still works (no half-swapped engine).
    expect(session.getBrush('v')).toEqual({ min: 1, max: 3 });
    expect(session.summarize('v').domain).toEqual({ min: 1, max: 6 });
    await session.setBrush('v', { min: 1, max: 2 });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b']);
  });

  it('a throwing get() during first build drops the specs without tearing the update', async () => {
    const { instance } = rig();
    await instance.attach(container);
    const bomb: DimensionSpec<NA> = {
      key: 'boom',
      kind: 'numeric',
      get: () => {
        throw new Error('accessor exploded');
      },
    };
    // Atomic update: data + a spec whose extraction throws. The update must
    // COMPLETE (data lands, one publish), crossfilter reports the rejection.
    instance.applyHostUpdate({ data: snapOf(1, BASE_ROWS), crossfilter: [bomb] });
    expect(instance.store.getState().nodeCount).toBe(6); // data landed
    expect(instance.getCrossfilterSession()).toBeNull(); // specs dropped
    expect(
      instance.store
        .getState()
        .diagnostics.some((d) => d.code === 'operation-rejected'),
    ).toBe(true);
  });

  it('an id-stable ATTRIBUTE change re-extracts columns (summaries + brushes update)', async () => {
    const replaceSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'replaceAll');
    const appendSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'appendRows');
    const { instance } = await readyRig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 1, max: 3 });
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'b', 'c']);

    // Same ids, same order, same length — only the VALUES changed (v scaled
    // ×10). Equal ids must not imply equal rows (D1): columns re-extract.
    instance.applyHostUpdate({
      data: snapOf(2, BASE_ROWS.map(([id, v, cat]) => [id, v * 10, cat] as const)),
    });

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    // Summary domain reflects the NEW values…
    expect(session.summarize('v').domain).toEqual({ min: 10, max: 60 });
    // …and the kept brush {1..3} now hides EVERY row (10..60 all fail).
    expect(session.getBrush('v')).toEqual({ min: 1, max: 3 });
    expect(instance.store.getState().visible.nodes).toBe(0);
  });

  it('a prefix extension that ALSO changes a prefix row replaces, never appends', async () => {
    const replaceSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'replaceAll');
    const appendSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'appendRows');
    const { instance } = await readyRig();
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 1, max: 3 });

    // Roster grows a..f → a..g (id-stable prefix) but b's value changed:
    // the old heuristic would appendRows(['g']) and keep filtering b on v=2.
    instance.applyHostUpdate({
      data: snapOf(2, [
        ['a', 1, 'x'],
        ['b', 99, 'x'], // changed prefix row
        ['c', 3, 'x'],
        ['d', 4, 'y'],
        ['e', 5, 'y'],
        ['f', 6, 'y'],
        ['g', 7, 'y'], // appended row
      ]),
    });

    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).not.toHaveBeenCalled();
    // b (v=99) fails the kept brush; a and c still pass.
    expect(instance.getVisibleNodeIds()).toEqual(['a', 'c']);
    expect(session.summarize('v').domain).toEqual({ min: 1, max: 99 });
  });

  it('re-applying the SAME row objects is a proven no-change (no replace, no append)', async () => {
    const replaceSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'replaceAll');
    const appendSpy = vi.spyOn(TypedColumnCrossfilter.prototype, 'appendRows');
    const { instance } = rig();
    await instance.attach(container);
    // Immutable-update idiom: the host keeps the row objects and ships them
    // in a NEW snapshot — reference equality proves the rows are unchanged.
    const rows = BASE_ROWS.map(([id, v, cat]) => ({ id, attrs: { v, cat } }));
    instance.applyHostUpdate({
      data: { datasetKey: 'ds', sourceRevision: 1, nodes: rows, edges: [] },
      crossfilter: [vDim, catDim],
    });
    const session = instance.getCrossfilterSession()!;
    await session.setBrush('v', { min: 1, max: 3 });
    expect(instance.store.getState().visible.nodes).toBe(3);

    instance.applyHostUpdate({
      data: { datasetKey: 'ds', sourceRevision: 2, nodes: rows, edges: [] },
    });

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
    expect(session.getBrush('v')).toEqual({ min: 1, max: 3 });
    expect(instance.store.getState().visible.nodes).toBe(3);
  });
});

describe('hard scope × brushes', () => {
  it('brush deltas only mask in-scope slots (out-of-scope rows have no scene slot)', async () => {
    const { instance } = await readyRig();
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'b'] } });
    expect(instance.store.getState().visible).toEqual({ nodes: 2, edges: 1 });
    const session = instance.getCrossfilterSession()!;

    // Hides b (v=2, in scope) AND c..f (out of scope — skipped, no throw).
    await session.setBrush('v', { min: 0, max: 1.5 });

    expect(instance.store.getState().visible).toEqual({ nodes: 1, edges: 0 });
    expect(instance.getVisibleNodeIds()).toEqual(['a']);
    // Summaries stay BASE-rostered: the crossfilter sees the accepted model.
    const summary = session.summarize('v');
    expect(summary.domain).toEqual({ min: 1, max: 6 });

    // Clearing the scope re-maps the brush mask onto the full scene.
    instance.applyHostUpdate({ subgraph: null });
    expect(instance.store.getState().visible.nodes).toBe(1); // only a passes the brush
    expect(instance.getVisibleNodeIds()).toEqual(['a']);
  });

  it('session subscriptions survive a dataset-change engine rebuild (stream-mode regression)', async () => {
    // A replace IngestSession establishing a NEW datasetKey rebuilds the
    // crossfilter engine object. Facade subscriptions must survive the swap
    // and fire for the rebuild — otherwise a UI subscribed before streaming
    // never learns the summaries changed ("No data" forever).
    const { instance } = rig();
    instance.applyHostUpdate({ crossfilter: [vDim] });
    await instance.attach(container);

    // No data yet: the engine defers its first build until a model exists.
    expect(instance.getCrossfilterSession()).toBeNull();

    const s = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'streamed',
      sourceRevision: 1,
      baseModelRevision: instance.getRevisions().model,
    });
    await s.append({
      sequence: 0,
      batchId: 'b0',
      nodes: [
        { id: 'a', attrs: { v: 1, cat: 'x' } },
        { id: 'b', attrs: { v: 9, cat: 'y' } },
      ],
    });
    await s.commit();

    // The replace commit built the engine over the streamed roster.
    const session = instance.getCrossfilterSession();
    expect(session).not.toBeNull();
    expect(session!.summarize('v').domain).toEqual({ min: 1, max: 9 });

    // And facade subscriptions survive a SUBSEQUENT dataset-change rebuild.
    let notified = 0;
    session!.subscribe(() => {
      notified += 1;
    });
    const s2 = instance.beginIngest({
      purpose: 'replace',
      datasetKey: 'streamed-2',
      sourceRevision: 1,
      baseModelRevision: instance.getRevisions().model,
    });
    await s2.append({
      sequence: 0,
      batchId: 'b0',
      nodes: [{ id: 'z', attrs: { v: 42, cat: 'x' } }],
    });
    await s2.commit();
    expect(notified).toBeGreaterThan(0);
    expect(session!.summarize('v').domain).toEqual({ min: 42, max: 42 });
  });
});
