/**
 * Instance styling wiring: scale channels over the
 * FakeEngine harness — canonical-key reprojection skips, degree ramps against
 * the interpolate oracle, domain freeze/recompute semantics, categorical
 * stability, metric-column admission, config-only toggles, capability
 * degradation, the image-atlas lane, and the accessor-churn detector.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGraphInstance } from '../src/instance';
import { FakeEngine } from '../src/testing/index';
import { CATEGORICAL_PALETTE, categoricalIndex, interpolateColor } from '../src/scale';
import { parseColor } from '../src/projection';
import type { EngineCapabilities, EngineCommit } from '../src/engine/index';
import type { ImageResolver } from '../src/imageAtlas';
import type { GraphSnapshot, Scale } from '../src/types';
import { callsOf, container, makeInstance, snap } from './helpers';
import type { EAttrs, NAttrs } from './helpers';

/** Path graph a—b—c: degrees a=1, b=2, c=1 (accepted-base order a,b,c). */
function pathSnap(rev: number | string = 1): GraphSnapshot<NAttrs, EAttrs> {
  return snap(rev, ['a', 'b', 'c'], [
    ['a', 'b'],
    ['b', 'c'],
  ]);
}

const RAMP: readonly [string, string] = ['#000000', '#ffffff'];

function degreeScale(extra?: Partial<Extract<Scale<string, NAttrs>, { kind: 'sequential' }>>) {
  return {
    kind: 'sequential',
    metric: 'degree',
    range: RAMP,
    ...extra,
  } as Scale<string, NAttrs>;
}

/** Last committed pointColor buffer (throws when none was ever committed). */
function lastPointColors(engine: FakeEngine): Float32Array {
  for (let i = engine.commits.length - 1; i >= 0; i--) {
    const pc = engine.commits[i]!.buffers?.pointColor;
    if (pc !== undefined) return pc;
  }
  throw new Error('no pointColor commit');
}

function rgbaAt(buf: Float32Array, idx: number): number[] {
  return [buf[4 * idx]!, buf[4 * idx + 1]!, buf[4 * idx + 2]!, buf[4 * idx + 3]!];
}

function expectRgba(actual: number[], css: string, alpha?: number): void {
  const expected = parseColor(css);
  expect(expected).not.toBeNull();
  const [r, g, b, a] = expected!;
  expect(actual[0]).toBeCloseTo(r, 5);
  expect(actual[1]).toBeCloseTo(g, 5);
  expect(actual[2]).toBeCloseTo(b, 5);
  expect(actual[3]).toBeCloseTo(alpha ?? a, 5);
}

async function readyWithPath(engineOptions?: { capabilities?: Partial<EngineCapabilities> }) {
  const harness = makeInstance(engineOptions !== undefined ? { engineOptions } : {});
  await harness.instance.attach(container);
  harness.instance.applyHostUpdate({ data: pathSnap(), nodeColor: degreeScale() });
  return { ...harness, engine: harness.engines[0]! };
}

describe('scale reprojection keying', () => {
  it('equal inline scale literals never reproject (zero commits, zero store sets)', async () => {
    const { instance, engine } = await readyWithPath();
    const before = engine.commits.length;
    let notifications = 0;
    const unsub = instance.store.subscribe(() => notifications++);

    // Structurally equal literal — different object identity.
    instance.applyHostUpdate({ nodeColor: degreeScale() });

    expect(engine.commits.length).toBe(before);
    expect(notifications).toBe(0);
    unsub();
  });

  it('a categorical scale with the SAME by-function reference compares equal; a new reference reprojects', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    const by = (n: { attrs?: NAttrs }): string | null => n.attrs?.label ?? null;
    instance.applyHostUpdate({
      data: pathSnap(),
      nodeColor: { kind: 'categorical', by },
    });
    const before = engine.commits.length;

    instance.applyHostUpdate({ nodeColor: { kind: 'categorical', by } });
    expect(engine.commits.length).toBe(before); // same reference → equal key

    instance.applyHostUpdate({
      nodeColor: { kind: 'categorical', by: (n: { attrs?: NAttrs }) => n.attrs?.label ?? null },
    });
    expect(engine.commits.length).toBe(before + 1); // new identity → reproject
  });
});

describe('sequential degree ramp', () => {
  it('matches the interpolateColor oracle on a known graph', async () => {
    const { engine } = await readyWithPath();
    const colors = lastPointColors(engine);
    // Domain [1,2]: a,c at t=0; b at t=1.
    expectRgba(rgbaAt(colors, 0), interpolateColor(RAMP[0], RAMP[1], 0));
    expectRgba(rgbaAt(colors, 1), interpolateColor(RAMP[0], RAMP[1], 1));
    expectRgba(rgbaAt(colors, 2), interpolateColor(RAMP[0], RAMP[1], 0));
  });

  it('drives nodeSize through the same domain (sequentialSize semantics)', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({
      data: pathSnap(),
      nodeSize: { kind: 'sequential', metric: 'degree', range: [2, 14] },
    });
    const sizes = engines[0]!.lastCommit!.buffers!.pointSize!;
    expect(Array.from(sizes)).toEqual([2, 14, 2]);
  });
});

describe('domain freeze (default dataset policy)', () => {
  it('the default domain stays frozen across progressive overlay flushes', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({ data: pathSnap(), nodeColor: degreeScale() });
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 2]);
    const baseline = rgbaAt(lastPointColors(engine), 1); // b: t=1 → white

    // Overlay flush (same sourceRevision): b becomes a degree-3 hub. The
    // DEFAULT policy must NOT re-freeze mid-stream — b clamps at t=1.
    const ingest = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: instance.getRevisions().model,
    });
    await ingest.append({
      sequence: 0,
      batchId: 'b0',
      nodes: [{ id: 'd', attrs: { label: 'D' } }],
      edges: [{ source: 'b', target: 'd', attrs: { weight: 1 } }],
    });
    await ingest.commit();

    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 2]); // frozen
    expect(rgbaAt(lastPointColors(engine), 1)).toEqual(baseline); // b still range max
  });

  it("streaming 'expand' grows across flushes and RESETS on a source replacement", async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({
      data: pathSnap(),
      nodeColor: degreeScale({ domain: { streaming: 'expand' } }),
    });
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 2]);

    // Expand: an overlay flush that raises the max degree unions the domain.
    const ingest = instance.beginIngest({
      purpose: 'overlay',
      datasetKey: 'ds',
      baseModelRevision: instance.getRevisions().model,
    });
    await ingest.append({
      sequence: 0,
      batchId: 'b0',
      nodes: [{ id: 'd', attrs: { label: 'D' } }],
      edges: [{ source: 'b', target: 'd', attrs: { weight: 1 } }],
    });
    await ingest.commit();
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 3]);

    // Source replacement (same datasetKey, NEW sourceRevision, smaller
    // extent): a fresh expand lineage — never a union with dead extrema.
    instance.applyHostUpdate({ data: snap(2, ['a', 'b'], [['a', 'b']]) });
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 1]);
  });

  it('stays frozen across mask, brush, and isolate; recomputes on a new sourceRevision', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({
      data: pathSnap(),
      nodeColor: degreeScale(),
      crossfilter: [{ key: 'lab', kind: 'categorical', get: (n) => n.attrs?.label }],
    });
    const baseline = rgbaAt(lastPointColors(engine), 0); // a: t=0 → black
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 2]);

    // Mask (dim filter on b): alpha-only fast path, colors untouched.
    instance.applyHostUpdate({
      filter: { nodes: { op: 'neq', field: 'id', value: 'b' }, mode: 'dim' },
    });
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 2]);
    let colors = lastPointColors(engine);
    expect(rgbaAt(colors, 0).slice(0, 3)).toEqual(baseline.slice(0, 3));

    // Brush (crossfilter categorical exclusion of B).
    await instance.getCrossfilterSession()!.setBrush('lab', { excluded: ['B'] });
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 2]);
    colors = lastPointColors(engine);
    // Post-brush colors byte-identical for the unmasked node (RGB + alpha).
    expect(rgbaAt(colors, 0)).toEqual(baseline);

    // Isolate to {a, c} — full reprojection, but the domain stays [1,2]:
    // both survivors have degree 1 → t=0 → range[0], byte-identical to the
    // baseline. (A visible-recomputed domain would degenerate to [1,1] and
    // render the ramp midpoint instead.)
    instance.applyHostUpdate({ subgraph: { seedIds: ['a', 'c'] } });
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 2]);
    colors = lastPointColors(engine);
    expect(rgbaAt(colors, 0)).toEqual(baseline);
    expect(rgbaAt(colors, 1)).toEqual(baseline); // c in the scoped scene

    // New sourceRevision with a degree-3 hub: the domain recomputes.
    instance.applyHostUpdate({
      subgraph: null,
      data: snap(2, ['a', 'b', 'c', 'd'], [
        ['a', 'b'],
        ['b', 'c'],
        ['b', 'd'],
      ]),
    });
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 3]);
    colors = lastPointColors(engine);
    expectRgba(rgbaAt(colors, 1).slice(0, 3).concat(1), interpolateColor(RAMP[0], RAMP[1], 1));
  });

  it("'visible' scope recomputes the domain on a mask change", async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({
      data: pathSnap(),
      nodeColor: degreeScale({ domain: { scope: 'visible' } }),
    });
    // All visible: domain [1,2] → a at t=0.
    expectRgba(rgbaAt(lastPointColors(engine), 0), interpolateColor(RAMP[0], RAMP[1], 0));

    // Hide the hub: visible domain degenerates to [1,1] → survivors render
    // the ramp midpoint.
    instance.hideNodes(['b']);
    const colors = lastPointColors(engine);
    expectRgba(rgbaAt(colors, 0), interpolateColor(RAMP[0], RAMP[1], 0.5));
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([1, 1]);
  });
});

describe('categorical scales', () => {
  const catScale: Scale<string, NAttrs> = {
    kind: 'categorical',
    by: 'label',
    domain: ['A', 'B', 'Z'],
  };

  it('declared-domain positions are stable and out-of-domain values hash (never first-seen order)', async () => {
    const project = async (ids: readonly string[]): Promise<Map<string, number[]>> => {
      const { instance, engines } = makeInstance();
      await instance.attach(container);
      instance.applyHostUpdate({ data: snap(1, ids), nodeColor: catScale });
      const colors = lastPointColors(engines[0]!);
      const out = new Map<string, number[]>();
      ids.forEach((id, i) => out.set(id, rgbaAt(colors, i)));
      instance.destroy();
      return out;
    };

    const forward = await project(['a', 'b', 'w']);
    expectRgba(forward.get('a')!, CATEGORICAL_PALETTE[0]!);
    expectRgba(forward.get('b')!, CATEGORICAL_PALETTE[1]!);
    const wIdx = categoricalIndex(['A', 'B', 'Z'], CATEGORICAL_PALETTE, 'W');
    expectRgba(forward.get('w')!, CATEGORICAL_PALETTE[wIdx]!);

    // Reversed arrival order — identical colors per id.
    const reversed = await project(['w', 'b', 'a']);
    for (const id of ['a', 'b', 'w']) {
      expect(reversed.get(id)).toEqual(forward.get(id));
    }
  });

  it('getScaleInfo rows: declared order first (including EMPTY categories), extras sorted, total counts', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b', 'w', 'a2']), nodeColor: catScale });
    // labels: A, B, W, A2 — declared A/B/Z (Z empty), extras A2/W sorted.
    const info = instance.getScaleInfo('nodeColor')!;
    expect(info.scale).toBe(instance.getScaleInfo('nodeColor')!.scale);
    expect(info.rows).toEqual([
      { value: 'A', count: 1, colorIndex: 0 },
      { value: 'B', count: 1, colorIndex: 1 },
      { value: 'Z', count: 0, colorIndex: 2 },
      { value: 'A2', count: 1, colorIndex: categoricalIndex(['A', 'B', 'Z'], CATEGORICAL_PALETTE, 'A2') },
      { value: 'W', count: 1, colorIndex: categoricalIndex(['A', 'B', 'Z'], CATEGORICAL_PALETTE, 'W') },
    ]);
  });

  it('getScaleInfo is null for non-scale channels', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: pathSnap(), nodeColor: 'red' });
    expect(instance.getScaleInfo('nodeColor')).toBeNull();
    expect(instance.getScaleInfo('nodeSize')).toBeNull();
  });
});

describe('metric columns', () => {
  it('a stale-stamped column is REJECTED after a same-count reorder (never wrong-node values)', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    // Async producer captures the coordinate at ISSUE time…
    const issuedAt = instance.getRevisions().model;

    // …the roster is REPLACED (same count, order flipped) before delivery…
    instance.applyHostUpdate({ data: snap(2, ['b', 'a'], [['b', 'a']]) });

    // …and the late index-aligned column must be rejected, not joined
    // positionally onto the wrong nodes.
    instance.applyHostUpdate({
      metrics: [{ metric: 'score', forModelRevision: issuedAt, align: 'index', values: [10, 20] }],
    });
    expect(instance.getMetricValue('score', 'a')).toBeNull();
    expect(instance.getMetricValue('score', 'b')).toBeNull();
    const diags = instance.store.getState().diagnostics;
    expect(diags.some((d) => d.code === 'metric-column-error' && d.severity === 'info')).toBe(true);
    expect(engines[0]!.lastCommit!.buffers?.pointSize).toBeUndefined();
  });

  it('a current-stamped column admits; atomic data+metrics stamps the ISSUE revision', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    // Atomic delivery: data + its derived column in ONE update, stamped with
    // the revision current when the update was BUILT (here: 0, fresh instance).
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b'], [['a', 'b']]),
      metrics: [{ metric: 'score', forModelRevision: 0, align: 'index', values: [10, 20] }],
    });
    expect(instance.getMetricValue('score', 'a')).toBe(10);
    expect(instance.getMetricValue('score', 'b')).toBe(20);

    // Async flow: capture → compute → deliver with the model unchanged.
    const rev = instance.getRevisions().model;
    instance.applyHostUpdate({
      metrics: [{ metric: 'rank', forModelRevision: rev, align: 'index', values: [1, 2] }],
    });
    expect(instance.getMetricValue('rank', 'b')).toBe(2);
  });

  it('joins by ids (unknown ids diagnosed), reads via getMetricValue, and drops on a model change', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({ data: pathSnap() });

    instance.applyHostUpdate({
      metrics: [{ metric: 'score', forModelRevision: 1, align: 'ids', ids: ['a', 'b', 'nope'], values: [10, 20, 30] }],
    });
    expect(instance.getMetricValue('score', 'a')).toBe(10);
    expect(instance.getMetricValue('score', 'b')).toBe(20);
    expect(instance.getMetricValue('score', 'c')).toBeNull(); // absent row → null
    const diag = instance
      .getDiagnostics()
      .find((d) => d.code === 'metric-column-error');
    expect(diag).toBeDefined();
    expect(diag!.sampleIds).toContain('nope');

    // Degree family stays live alongside columns…
    expect(instance.getMetricValue('degree', 'b')).toBe(2);
    // …and an admitted 'degree' column SHADOWS the built-in.
    instance.applyHostUpdate({
      metrics: [{ metric: 'degree', forModelRevision: 1, align: 'index', values: [100, 200, 300] }],
    });
    expect(instance.getMetricValue('degree', 'b')).toBe(200);

    // Stale discard: a new accepted model drops every admitted column.
    instance.applyHostUpdate({ data: pathSnap(2) });
    expect(instance.getMetricValue('score', 'a')).toBeNull();
    expect(instance.getMetricValue('degree', 'b')).toBe(2); // built-in returns
  });

  it('a scale on a missing metric falls back to theme nodeDefault, then reprojects when the column arrives', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({
      data: pathSnap(),
      nodeColor: { kind: 'sequential', metric: 'score', range: RAMP },
    });
    // No column: every node renders the dark-base nodeDefault fallback.
    let colors = lastPointColors(engine);
    for (let i = 0; i < 3; i++) expectRgba(rgbaAt(colors, i), '#94a3b8');
    expect(instance.getScaleInfo('nodeColor')!.domain).toBeUndefined();

    const before = engine.commits.length;
    // Later-arriving column dirties ONLY the scale channel referencing it.
    instance.applyHostUpdate({
      metrics: [{ metric: 'score', forModelRevision: 1, align: 'index', values: [0, 5, 10] }],
    });
    expect(engine.commits.length).toBe(before + 1);
    const commit = engine.lastCommit!;
    expect(commit.structure).toBeUndefined();
    expect(commit.buffers!.pointSize).toBeUndefined(); // only nodeColor re-projected
    colors = commit.buffers!.pointColor!;
    expectRgba(rgbaAt(colors, 0), interpolateColor(RAMP[0], RAMP[1], 0));
    expectRgba(rgbaAt(colors, 1), interpolateColor(RAMP[0], RAMP[1], 0.5));
    expectRgba(rgbaAt(colors, 2), interpolateColor(RAMP[0], RAMP[1], 1));
    expect(instance.getScaleInfo('nodeColor')!.domain).toEqual([0, 10]);
  });

  it('an unrelated admitted column does NOT dirty scale channels', async () => {
    const { instance, engine } = await readyWithPath();
    const before = engine.commits.length;
    instance.applyHostUpdate({
      metrics: [{ metric: 'other', forModelRevision: 1, align: 'index', values: [1, 2, 3] }],
    });
    expect(engine.commits.length).toBe(before); // no channel references 'other'
    expect(instance.getMetricValue('other', 'c')).toBe(3);
  });
});

describe('edgeArrows and showLinks', () => {
  it('are config-only commits with ZERO buffer channels (capable engine)', async () => {
    const { instance, engine } = await readyWithPath({ capabilities: { edgeArrows: true } });
    const before = engine.commits.length;

    instance.applyHostUpdate({ edgeArrows: true });
    expect(engine.commits.length).toBe(before + 1);
    let commit = engine.lastCommit!;
    expect(commit.config).toEqual({ linkArrows: true });
    expect(commit.buffers).toBeUndefined();
    expect(commit.structure).toBeUndefined();

    instance.applyHostUpdate({ showLinks: false });
    commit = engine.lastCommit!;
    expect(commit.config).toEqual({ renderLinks: false });
    expect(commit.buffers).toBeUndefined();

    // Same values again: no commit (default showLinks is true, set false above).
    const n = engine.commits.length;
    instance.applyHostUpdate({ edgeArrows: true, showLinks: false });
    expect(engine.commits.length).toBe(n);
  });

  it('degrades loudly on an engine without edgeArrows: one dev diagnostic, linkArrows stripped from every commit', async () => {
    const { instance, engines } = makeInstance(); // FakeEngine: no edgeArrows capability
    instance.applyHostUpdate({ data: pathSnap(), edgeArrows: true });
    await instance.attach(container);
    const engine = engines[0]!;

    const degradations = instance
      .getDiagnostics()
      .filter((d) => d.code === 'engine:capability-degraded');
    expect(degradations).toHaveLength(1);
    expect(degradations[0]!.message).toContain('edgeArrows');
    expect(degradations[0]!.severity).toBe('warning');

    // every commit routes through the normalizer — the incapable
    // adapter never sees linkArrows.
    for (const commit of engine.commits) {
      expect(commit.config === undefined || !('linkArrows' in commit.config)).toBe(true);
    }

    // Post-ready arrow updates stay inert commits without the key too.
    instance.applyHostUpdate({ edgeArrows: false });
    for (const commit of engine.commits) {
      expect(commit.config === undefined || !('linkArrows' in commit.config)).toBe(true);
    }
  });

  it('emits one degradation per requested-but-unsupported feature (arrows + images)', async () => {
    const { instance } = makeInstance();
    instance.applyHostUpdate({
      data: pathSnap(),
      edgeArrows: true,
      nodeImage: () => 'img://x',
    });
    await instance.attach(container);
    const degradations = instance
      .getDiagnostics()
      .filter((d) => d.code === 'engine:capability-degraded');
    expect(degradations).toHaveLength(2);
  });
});

describe('image pipeline', () => {
  const fakeBitmap = (): ImageBitmap =>
    ({ width: 1, height: 1, close() {} }) as unknown as ImageBitmap;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeImageHarness(resolver: ImageResolver) {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => fakeBitmap()));
    const engines: FakeEngine[] = [];
    const instance = createGraphInstance<NAttrs, EAttrs>({
      engine: () => {
        const e = new FakeEngine({ capabilities: { pointImages: true } });
        engines.push(e);
        return e;
      },
      imageResolver: resolver,
    });
    return { instance, engines };
  }

  async function resolvedResourceCommit(engine: FakeEngine): Promise<EngineCommit> {
    await vi.waitFor(() => {
      const found = engine.commits.some(
        (c) =>
          c.resources?.pointImageIndex !== undefined &&
          Array.from(c.resources.pointImageIndex).some((v) => v >= 0),
      );
      expect(found).toBe(true);
    });
    return [...engine.commits]
      .reverse()
      .find(
        (c) =>
          c.resources?.pointImageIndex !== undefined &&
          Array.from(c.resources.pointImageIndex).some((v) => v >= 0),
      )!;
  }

  it('EVERY structural commit carries a correct-length pointImageIndex (never the old roster\'s)', async () => {
    const resolver: ImageResolver = async () => new Blob(['x']);
    const { instance, engines } = makeImageHarness(resolver);
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b'], [['a', 'b']]),
      nodeImage: (n) => `img://${n.id}`,
    });
    await instance.attach(container);
    const engine = engines[0]!;

    // The FIRST structural commit already pairs the roster with its index
    // (all placeholders — nothing delivered yet).
    const first = engine.commits.find((c) => c.structure !== undefined)!;
    expect(first.resources?.pointImageIndex).toBeDefined();
    expect(first.resources!.pointImageIndex!.length).toBe(2);
    expect(Array.from(first.resources!.pointImageIndex!)).toEqual([-1, -1]);

    await resolvedResourceCommit(engine); // async promotion delivered

    // Roster grows 2 → 3: the structural commit must carry a length-3 index
    // IN THE SAME COMMIT — resolved slots for a/b (already delivered),
    // placeholder for c — never the previous length-2 array.
    instance.applyHostUpdate({
      data: snap(2, ['a', 'b', 'c'], [['a', 'b']]),
      nodeImage: (n) => `img://${n.id}`,
    });
    const structural = [...engine.commits].reverse().find((c) => c.structure !== undefined)!;
    expect(structural.structure!.pointCount).toBe(3);
    const idx = structural.resources?.pointImageIndex;
    expect(idx).toBeDefined();
    expect(idx!.length).toBe(3);
    expect(idx![0]).toBeGreaterThanOrEqual(0); // a: delivered slot
    expect(idx![1]).toBeGreaterThanOrEqual(0); // b: delivered slot
    expect(idx![2]).toBe(-1); // c: pending → placeholder, promoted later

    // I2 sweep: every structural commit in the whole log carried an index
    // sized to ITS OWN roster.
    for (const c of engine.commits) {
      if (c.structure !== undefined && c.resources?.pointImageIndex !== undefined) {
        expect(c.resources.pointImageIndex.length).toBe(c.structure.pointCount);
      }
    }
  });

  it('nodeImage: null CLEARS — placeholders commit and late decodes never republish', async () => {
    let release: (() => void) | null = null;
    const gated = new Promise<void>((res) => {
      release = res;
    });
    let resolved = 0;
    const resolver: ImageResolver = async (ref) => {
      if (ref === 'img://slow') {
        await gated; // decode still pending when the clear lands
      }
      resolved++;
      return new Blob(['x']);
    };
    const { instance, engines } = makeImageHarness(resolver);
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b'], [['a', 'b']]),
      nodeImage: (n) => (n.id === 'a' ? 'img://fast' : 'img://slow'),
    });
    await instance.attach(container);
    const engine = engines[0]!;
    await resolvedResourceCommit(engine); // 'fast' resolved and committed

    // Clear via the explicit null transition (the React prop-removal path).
    instance.applyHostUpdate({ nodeImage: null });
    await vi.waitFor(() => {
      const last = [...engine.commits]
        .reverse()
        .find((c) => c.resources?.pointImageIndex !== undefined)!;
      // All-placeholder index: no slot references survive the clear.
      expect(Array.from(last.resources!.pointImageIndex!).every((v) => v < 0)).toBe(true);
    });
    const commitsAfterClear = engine.commits.length;

    // The pending decode completes AFTER the clear: stale by generation
    // no republication, no resurrected slots.
    release!();
    await new Promise((res) => setTimeout(res, 20));
    const late = engine.commits.slice(commitsAfterClear);
    expect(
      late.every(
        (c) =>
          c.resources?.pointImageIndex === undefined ||
          Array.from(c.resources.pointImageIndex).every((v) => v < 0),
      ),
    ).toBe(true);

    // Re-adding an accessor resumes normal resolution.
    instance.applyHostUpdate({ nodeImage: () => 'img://fast' });
    await resolvedResourceCommit(engine);
    expect(resolved).toBeGreaterThanOrEqual(2);
  });

  it('feeds refs, dedupes by ref via the injected resolver, and lands a resources-ONLY commit', async () => {
    const resolver = vi.fn<ImageResolver>(async (ref) => new Blob([ref]));
    const { instance, engines } = makeImageHarness(resolver);
    await instance.attach(container);
    const engine = engines[0]!;

    instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c']),
      nodeImage: (n) => (n.id === 'c' ? null : 'img://shared'),
    });

    const commit = await resolvedResourceCommit(engine);
    // Dedupe: ONE resolve serves both a and b.
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]![0]).toBe('img://shared');
    // Resources-only: zero buffer channels, zero structure.
    expect(commit.buffers).toBeUndefined();
    expect(commit.structure).toBeUndefined();
    expect(commit.resources!.imageAtlas!.upserts).toHaveLength(1);
    expect(commit.resources!.imageAtlas!.upserts![0]!.slot).toBe(0);
    expect(Array.from(commit.resources!.pointImageIndex!)).toEqual([0, 0, -1]);
    // The render revision advanced with the resources commit.
    expect(instance.getRevisions().appliedRender).toBe(commit.revision);
    instance.destroy();
  });

  it('recovery replay re-sends the FULL current atlas state', async () => {
    const resolver = vi.fn<ImageResolver>(async (ref) => new Blob([ref]));
    const { instance, engines } = makeImageHarness(resolver);
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({
      data: snap(1, ['a', 'b']),
      nodeImage: (n) => `img://${n.id}`,
    });
    await resolvedResourceCommit(engine);
    await vi.waitFor(() => {
      const last = [...engine.commits].reverse().find((c) => c.resources !== undefined)!;
      expect(Array.from(last.resources!.pointImageIndex!)).toEqual([0, 1]);
    });

    engine.injectContextLost();
    engine.injectContextRestored();

    const replay = engine.lastCommit!;
    expect(replay.structure).toBeDefined(); // the full-scene replay commit
    expect(replay.resources).toBeDefined();
    const slots = replay.resources!.imageAtlas!.upserts!.map((u) => u.slot).sort();
    expect(slots).toEqual([0, 1]);
    expect(Array.from(replay.resources!.pointImageIndex!)).toEqual([0, 1]);
    instance.destroy();
  });

  it('a datasetKey change disposes and rebuilds the atlas', async () => {
    const resolver = vi.fn<ImageResolver>(async (ref) => new Blob([ref]));
    const { instance, engines } = makeImageHarness(resolver);
    await instance.attach(container);
    const engine = engines[0]!;
    instance.applyHostUpdate({
      data: snap(1, ['a'], [], 'ds-one'),
      nodeImage: (n) => `img://${n.id}`,
    });
    await resolvedResourceCommit(engine);

    instance.applyHostUpdate({ data: snap(1, ['z'], [], 'ds-two') });
    await vi.waitFor(() => {
      // The new dataset resolves its own ref into a FRESH slot 0.
      expect(resolver.mock.calls.map((c) => c[0])).toContain('img://z');
    });
    instance.destroy();
  });
});

describe('accessor-churn detector', () => {
  it('fires ONCE per identical-output streak of ≥3 reprojections', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    const makeAccessor = () => () => '#ff0000'; // fresh identity, constant output
    instance.applyHostUpdate({ data: pathSnap(), nodeColor: makeAccessor() });
    instance.applyHostUpdate({ nodeColor: makeAccessor() });
    expect(
      instance.getDiagnostics().filter((d) => d.code === 'accessor-churn'),
    ).toHaveLength(0);

    instance.applyHostUpdate({ nodeColor: makeAccessor() }); // 3rd identical projection
    let churn = instance.getDiagnostics().filter((d) => d.code === 'accessor-churn');
    expect(churn).toHaveLength(1);
    expect(churn[0]!.message).toContain('nodeColor');

    // The streak keeps going: still exactly ONE diagnostic.
    instance.applyHostUpdate({ nodeColor: makeAccessor() });
    churn = instance.getDiagnostics().filter((d) => d.code === 'accessor-churn');
    expect(churn).toHaveLength(1);
  });

  it('does NOT fire when sampled outputs change between reprojections', async () => {
    const { instance } = makeInstance();
    await instance.attach(container);
    const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
    instance.applyHostUpdate({ data: pathSnap(), nodeColor: () => colors[0]! });
    for (let i = 1; i < colors.length; i++) {
      const css = colors[i]!;
      instance.applyHostUpdate({ nodeColor: () => css });
    }
    expect(
      instance.getDiagnostics().filter((d) => d.code === 'accessor-churn'),
    ).toHaveLength(0);
  });
});

describe('styling commit hygiene', () => {
  it('scale channels never write NaN into buffers (junk metric values fall back)', async () => {
    const { instance, engines } = makeInstance();
    await instance.attach(container);
    instance.applyHostUpdate({
      data: pathSnap(),
      nodeSize: { kind: 'sequential', metric: 'score', range: [2, 14] },
      metrics: [{ metric: 'score', forModelRevision: 0, align: 'index', values: [1, null, Number.NaN] }],
    });
    const sizes = engines[0]!.lastCommit!.buffers!.pointSize!;
    for (const v of sizes) expect(Number.isFinite(v)).toBe(true);
    // Only 'a' carries a usable value → degenerate domain → range midpoint;
    // b/c fall back to the default size 4.
    expect(Array.from(sizes)).toEqual([8, 4, 4]);
    expect(callsOf(engines[0]!, 'commit').length).toBeGreaterThan(0);
  });
});
