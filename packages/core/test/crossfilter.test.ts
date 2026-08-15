/**
 * Crossfilter engine — oracle property tests: the incremental
 * O(Δ) engine must match a naive full-recount oracle at every step, deltas
 * must exactly equal visibility flips, and summaries must match a naive
 * dual-layer recount (other-dims + external mask, own brush excluded).
 */

import { describe, expect, it } from 'vitest';

import { TypedColumnCrossfilter } from '../src/crossfilter';
import type { BrushState, DimensionKind, DimensionSpec, GraphNode } from '../src/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Attrs {
  score?: unknown;
  group?: unknown;
  when?: unknown;
  [k: string]: unknown;
}
type Node = GraphNode<Attrs>;

const mkNode = (i: number, attrs: Attrs): Node => ({ id: `n${i}`, attrs });

const SPECS: readonly DimensionSpec<Attrs>[] = [
  { key: 'score', kind: 'numeric', get: (n) => n.attrs?.score },
  { key: 'group', kind: 'categorical', get: (n) => n.attrs?.group },
  { key: 'when', kind: 'temporal', get: (n) => n.attrs?.when },
];

const GROUPS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] as const;
const DAY = 86_400_000;
const EPOCH0 = Date.UTC(2024, 0, 1);

function randomNodes(n: number, rand: () => number): Node[] {
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) {
    const r1 = rand();
    const score =
      r1 < 0.8 ? rand() * 100 : r1 < 0.85 ? 'junk' : r1 < 0.9 ? NaN : r1 < 0.95 ? Infinity : null;
    const r2 = rand();
    const group = r2 < 0.85 ? GROUPS[Math.floor(rand() * GROUPS.length)] : r2 < 0.92 ? 7 : null;
    const r3 = rand();
    const t = EPOCH0 + Math.floor(rand() * 90) * DAY;
    const when =
      r3 < 0.4
        ? t
        : r3 < 0.6
          ? new Date(t).toISOString()
          : r3 < 0.8
            ? new Date(t).toISOString().slice(0, 10) // 'YYYY-MM-DD'
            : r3 < 0.9
              ? 'not-a-date'
              : null;
    nodes.push(mkNode(i, { score, group, when }));
  }
  return nodes;
}

/** Test-side reimplementation of the dimension parsing rules (the oracle). */
function parseVal(kind: DimensionKind, raw: unknown): number | string | null {
  if (kind === 'categorical') {
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return null;
  }
  if (kind === 'numeric') {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function rowPassesDim(spec: DimensionSpec<Attrs>, node: Node, brush: BrushState): boolean {
  if (brush === null) return true;
  const v = parseVal(spec.kind, spec.get(node));
  if (v === null) return false; // hygiene-excluded rows fail any non-null brush
  if ('excluded' in brush) return !brush.excluded.includes(v as string);
  return (v as number) >= brush.min && (v as number) <= brush.max;
}

function oracleVisible(
  nodes: readonly Node[],
  specs: readonly DimensionSpec<Attrs>[],
  brushes: ReadonlyMap<string, BrushState>,
): Set<number> {
  const out = new Set<number>();
  for (let s = 0; s < nodes.length; s++) {
    const node = nodes[s]!;
    if (specs.every((spec) => rowPassesDim(spec, node, brushes.get(spec.key) ?? null))) out.add(s);
  }
  return out;
}

interface OracleSummary {
  domain?: { min: number; max: number };
  bins: { total: number; filtered: number }[];
  categories: { key: string; total: number; filtered: number; excluded: boolean }[];
  excludedRows: number;
}

/** Naive dual-layer recount: filtered = other dims' brushes + external mask. */
function oracleSummarize(
  nodes: readonly Node[],
  specs: readonly DimensionSpec<Attrs>[],
  brushes: ReadonlyMap<string, BrushState>,
  key: string,
  extPass: (slot: number) => boolean,
): OracleSummary {
  const spec = specs.find((s) => s.key === key)!;
  const others = specs.filter((s) => s.key !== key);
  const passesLayer = (s: number): boolean =>
    extPass(s) &&
    others.every((o) => rowPassesDim(o, nodes[s]!, brushes.get(o.key) ?? null));
  const parsed = nodes.map((n) => parseVal(spec.kind, spec.get(n)));
  const excludedRows = parsed.filter((v) => v === null).length;

  if (spec.kind === 'categorical') {
    const brush = brushes.get(key) ?? null;
    const excludedSet = new Set(brush !== null && 'excluded' in brush ? brush.excluded : []);
    const order: string[] = [];
    const totals = new Map<string, number>();
    const filtered = new Map<string, number>();
    for (let s = 0; s < nodes.length; s++) {
      const v = parsed[s];
      if (typeof v !== 'string') continue;
      if (!totals.has(v)) {
        order.push(v);
        totals.set(v, 0);
        filtered.set(v, 0);
      }
      totals.set(v, totals.get(v)! + 1);
      if (passesLayer(s)) filtered.set(v, filtered.get(v)! + 1);
    }
    return {
      bins: [],
      categories: order.map((k) => ({
        key: k,
        total: totals.get(k)!,
        filtered: filtered.get(k)!,
        excluded: excludedSet.has(k),
      })),
      excludedRows,
    };
  }

  const valid: number[] = [];
  for (let s = 0; s < nodes.length; s++) if (parsed[s] !== null) valid.push(s);
  if (valid.length === 0) return { bins: [], categories: [], excludedRows };
  let min = Infinity;
  let max = -Infinity;
  for (const s of valid) {
    const v = parsed[s] as number;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const bcount = min === max ? 1 : (spec.bins ?? 24);
  const span = max - min;
  const bins = Array.from({ length: bcount }, () => ({ total: 0, filtered: 0 }));
  for (const s of valid) {
    const v = parsed[s] as number;
    const b = bcount === 1 ? 0 : Math.min(Math.floor(((v - min) / span) * bcount), bcount - 1);
    bins[b]!.total++;
    if (passesLayer(s)) bins[b]!.filtered++;
  }
  return { domain: { min, max }, bins, categories: [], excludedRows };
}

function sortedNums(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

function testBrushEq(a: BrushState, b: BrushState): boolean {
  if (a === null || b === null) return a === b;
  if ('min' in a && 'min' in b) return a.min === b.min && a.max === b.max;
  if ('excluded' in a && 'excluded' in b) {
    const sa = new Set(a.excluded);
    const sb = new Set(b.excluded);
    return sa.size === sb.size && [...sa].every((k) => sb.has(k));
  }
  return false;
}

function buildEngine(nodes: readonly Node[], specs = SPECS): TypedColumnCrossfilter<Attrs> {
  const xf = new TypedColumnCrossfilter<Attrs>();
  xf.build(nodes, specs);
  return xf;
}

// ---------------------------------------------------------------------------

describe('TypedColumnCrossfilter — oracle property tests', () => {
  it('visibility and deltas match a naive recount across random brush sequences', () => {
    for (const seed of [11, 47, 2026]) {
      const rand = rng(seed);
      const nodes = randomNodes(120, rand);
      const xf = buildEngine(nodes);
      const brushes = new Map<string, BrushState>();
      let prevVisible = oracleVisible(nodes, SPECS, brushes);
      expect(new Set(xf.visibleSlots())).toEqual(prevVisible);

      for (let op = 0; op < 40; op++) {
        const spec = SPECS[Math.floor(rand() * SPECS.length)]!;
        let brush: BrushState;
        if (rand() < 0.15) {
          brush = null;
        } else if (spec.kind === 'categorical') {
          const pool = [...GROUPS, '7', 'zeta-unknown'];
          brush = { excluded: pool.filter(() => rand() < 0.35) };
        } else {
          const lo = spec.kind === 'numeric' ? rand() * 100 : EPOCH0 + rand() * 90 * DAY;
          const width =
            (spec.kind === 'numeric' ? 60 : 45 * DAY) * (rand() < 0.1 ? -0.5 : rand());
          brush = { min: Math.min(lo, lo + width), max: Math.max(lo, lo + width) };
          if (rand() < 0.08) brush = { min: brush.max + 1, max: brush.min - 1 }; // inverted
        }

        const wasEqual = testBrushEq(xf.getBrush(spec.key), brush);
        const revBefore = xf.selectionRevision;
        const delta = xf.setBrush(spec.key, brush);
        brushes.set(spec.key, brush);

        const visible = oracleVisible(nodes, SPECS, brushes);
        expect(new Set(xf.visibleSlots())).toEqual(visible);
        // Deltas exactly equal the visibility flips.
        const expectedHidden = [...prevVisible].filter((s) => !visible.has(s));
        const expectedShown = [...visible].filter((s) => !prevVisible.has(s));
        expect(sortedNums(delta.hidden)).toEqual(sortedNums(expectedHidden));
        expect(sortedNums(delta.shown)).toEqual(sortedNums(expectedShown));
        // Revision advances exactly once per observable (brush-changing) call.
        expect(xf.selectionRevision).toBe(revBefore + (wasEqual ? 0 : 1));
        prevVisible = visible;

        if (op % 10 === 9) {
          for (const dim of SPECS) {
            const got = xf.summarize(dim.key);
            const want = oracleSummarize(nodes, SPECS, brushes, dim.key, () => true);
            expect(got.bins.map((b) => ({ total: b.total, filtered: b.filtered }))).toEqual(
              want.bins,
            );
            expect(got.categories.map((c) => ({ ...c }))).toEqual(want.categories);
            expect(got.excludedRows).toBe(want.excludedRows);
            if (want.domain) {
              expect(got.domain).toEqual(want.domain);
            } else {
              expect(got.domain).toBeUndefined();
            }
          }
        }
      }
      xf.dispose();
    }
  });
});

describe('TypedColumnCrossfilter — O(Δ) evidence', () => {
  it('a small range brush move walks only the delta slots, never n', () => {
    const n = 2000;
    const nodes = Array.from({ length: n }, (_, i) => mkNode(i, { score: i }));
    const specs: DimensionSpec<Attrs>[] = [
      { key: 'score', kind: 'numeric', get: (nd) => nd.attrs?.score },
    ];
    const xf = buildEngine(nodes, specs);
    xf.setBrush('score', { min: 500, max: 1500 });
    xf.resetStats();
    xf.setBrush('score', { min: 502, max: 1502 });
    // leave {500,501} + enter {1501,1502} = exactly 4 slots — not O(n).
    expect(xf.stats.slotsWalked).toBe(4);
    expect(xf.stats.fullSorts).toBe(0); // brush path never re-sorts
    xf.dispose();
  });

  it('a categorical toggle walks only the changed code’s slot list', () => {
    const nodes = Array.from({ length: 1000 }, (_, i) => mkNode(i, { group: `g${i % 10}` }));
    const specs: DimensionSpec<Attrs>[] = [
      { key: 'group', kind: 'categorical', get: (nd) => nd.attrs?.group },
    ];
    const xf = buildEngine(nodes, specs);
    xf.resetStats();
    xf.setBrush('group', { excluded: ['g3'] });
    expect(xf.stats.slotsWalked).toBe(100);
    xf.resetStats();
    xf.setBrush('group', { excluded: ['g3', 'g7'] }); // only g7 changes
    expect(xf.stats.slotsWalked).toBe(100);
    xf.dispose();
  });
});

describe('TypedColumnCrossfilter — revisions & notification', () => {
  it('advances selectionRevision once per observable change and notifies per change', () => {
    const nodes = Array.from({ length: 50 }, (_, i) => mkNode(i, { score: i, group: 'a' }));
    const xf = buildEngine(nodes);
    let notified = 0;
    const unsubscribe = xf.subscribe(() => notified++);
    expect(xf.selectionRevision).toBe(0);

    // Three rapid calls, each observable → +3, three notifications, final wins.
    xf.setBrush('score', { min: 0, max: 10 });
    xf.setBrush('score', { min: 5, max: 15 });
    xf.setBrush('score', { min: 7, max: 20 });
    expect(xf.selectionRevision).toBe(3);
    expect(notified).toBe(3);
    expect(xf.getBrush('score')).toEqual({ min: 7, max: 20 });

    // Deep-equal brush → not observable: no revision, no notify, empty delta.
    const delta = xf.setBrush('score', { min: 7, max: 20 });
    expect(delta).toEqual({ hidden: [], shown: [] });
    expect(xf.selectionRevision).toBe(3);
    expect(notified).toBe(3);

    // Categorical set equality is order-insensitive.
    xf.setBrush('group', { excluded: ['a', 'x'] });
    expect(xf.selectionRevision).toBe(4);
    xf.setBrush('group', { excluded: ['x', 'a'] });
    expect(xf.selectionRevision).toBe(4);
    expect(notified).toBe(4);

    unsubscribe();
    xf.setBrush('score', { min: 0, max: 1 });
    expect(notified).toBe(4); // unsubscribed
    xf.dispose();
  });

  it('coalesces synchronous re-entrancy from subscribers', () => {
    const nodes = Array.from({ length: 20 }, (_, i) => mkNode(i, { score: i }));
    const xf = buildEngine(nodes, [
      { key: 'score', kind: 'numeric', get: (nd) => nd.attrs?.score },
    ]);
    let calls = 0;
    let reentered = false;
    xf.subscribe(() => {
      calls++;
      if (!reentered) {
        reentered = true;
        xf.setBrush('score', { min: 0, max: 5 }); // mutate from inside a callback
      }
    });
    xf.setBrush('score', { min: 0, max: 10 });
    // One pass for the outer change + one coalesced trailing pass — bounded.
    expect(calls).toBe(2);
    expect(xf.getBrush('score')).toEqual({ min: 0, max: 5 });
    expect(xf.selectionRevision).toBe(2);
    expect(new Set(xf.visibleSlots())).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    xf.dispose();
  });
});

describe('TypedColumnCrossfilter — summarize dual layer', () => {
  const nodes: Node[] = Array.from({ length: 60 }, (_, i) =>
    mkNode(i, {
      score: i === 7 || i === 23 ? 'bad' : i % 10,
      group: i === 11 ? null : ['red', 'green', 'blue'][i % 3],
      when: i === 30 ? 'nope' : EPOCH0 + i * DAY,
    }),
  );

  it('filtered layer respects other dims + external mask, never the own brush', () => {
    const xf = buildEngine(nodes);
    const brushes = new Map<string, BrushState>([
      ['score', { min: 2, max: 7 }],
      ['group', { excluded: ['blue'] }],
    ]);
    xf.setBrush('score', brushes.get('score')!);
    xf.setBrush('group', brushes.get('group')!);
    const mask = new Uint8Array(60);
    for (let s = 0; s < 60; s++) mask[s] = s % 2 === 0 ? 1 : 0;
    xf.setExternalMask(mask);

    for (const spec of SPECS) {
      const got = xf.summarize(spec.key);
      const want = oracleSummarize(nodes, SPECS, brushes, spec.key, (s) => s % 2 === 0);
      expect(got.bins.map((b) => ({ total: b.total, filtered: b.filtered }))).toEqual(want.bins);
      expect(got.categories.map((c) => ({ ...c }))).toEqual(want.categories);
      expect(got.excludedRows).toBe(want.excludedRows);
    }

    // Own-brush exclusion, concretely: scores 0,1,8,9 are outside the score
    // brush yet still counted in score's own filtered layer.
    const score = xf.summarize('score');
    const outside = score.bins.filter((b) => b.x1 < 2 || b.x0 > 7);
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.some((b) => b.filtered > 0)).toBe(true);
    xf.dispose();
  });

  it('external mask changes notify without advancing selectionRevision', () => {
    const xf = buildEngine(nodes);
    let notified = 0;
    xf.subscribe(() => notified++);
    const revision = xf.selectionRevision;

    const mask = new Uint8Array(60).fill(1);
    xf.setExternalMask(mask); // all-pass ≡ null → not observable
    expect(notified).toBe(0);

    mask[3] = 0;
    xf.setExternalMask(mask);
    expect(notified).toBe(1);
    expect(xf.selectionRevision).toBe(revision);
    xf.setExternalMask(mask); // same content → no notify
    expect(notified).toBe(1);
    xf.setExternalMask(null);
    expect(notified).toBe(2);
    expect(xf.selectionRevision).toBe(revision);

    expect(() => xf.setExternalMask(new Uint8Array(3))).toThrow(RangeError);
    xf.dispose();
  });
});

describe('TypedColumnCrossfilter — temporal parsing', () => {
  it('accepts epoch ms, ISO strings, YYYY-MM-DD (UTC midnight), Date; junk → excludedRows', () => {
    const nodes: Node[] = [
      mkNode(0, { when: Date.UTC(2025, 0, 1) }),
      mkNode(1, { when: '2025-01-02T00:00:00.000Z' }),
      mkNode(2, { when: '2025-01-03' }),
      mkNode(3, { when: new Date(Date.UTC(2025, 0, 4)) }),
      mkNode(4, { when: 'garbage' }),
      mkNode(5, { when: NaN }),
      mkNode(6, { when: Infinity }),
      mkNode(7, { when: null }),
    ];
    const specs: DimensionSpec<Attrs>[] = [
      { key: 'when', kind: 'temporal', get: (nd) => nd.attrs?.when },
    ];
    const xf = buildEngine(nodes, specs);
    const summary = xf.summarize('when');
    expect(summary.excludedRows).toBe(4);
    expect(summary.domain).toEqual({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2025, 0, 4) });

    // 'YYYY-MM-DD' is UTC midnight: brushing [Jan 2, Jan 3] in epoch ms picks
    // exactly the ISO row and the date-only row; junk rows fail the brush.
    xf.setBrush('when', { min: Date.UTC(2025, 0, 2), max: Date.UTC(2025, 0, 3) });
    expect(xf.visibleSlots()).toEqual([1, 2]);
    xf.dispose();
  });
});

describe('TypedColumnCrossfilter — incremental append', () => {
  function appendFixture(): { base: Node[]; extra: Node[] } {
    const rand = rng(99);
    const base = randomNodes(100, rand);
    const extra: Node[] = [
      mkNode(100, { score: 150, group: 'zeta', when: EPOCH0 + 200 * DAY }), // extends domains, new category
      mkNode(101, { score: 3, group: 'alpha', when: '2024-01-05' }),
      mkNode(102, { score: 'junk', group: null, when: 'nope' }), // hygiene
      mkNode(103, { score: 55, group: 'beta', when: EPOCH0 + 10 * DAY }),
      mkNode(104, { score: -20, group: 'gamma', when: EPOCH0 }), // extends min
    ];
    return { base, extra };
  }

  it('extends without a full re-argsort; brushes persist and apply to new rows', () => {
    const { base, extra } = appendFixture();
    const xf = buildEngine(base);
    const scoreBrush: BrushState = { min: 0, max: 60 };
    const groupBrush: BrushState = { excluded: ['beta', 'zeta'] };
    xf.setBrush('score', scoreBrush);
    xf.setBrush('group', groupBrush);
    const fullSortsAfterBuild = xf.stats.fullSorts;
    expect(fullSortsAfterBuild).toBe(2); // score + when; categorical never argsorts

    let notified = 0;
    xf.subscribe(() => notified++);
    const revBefore = xf.selectionRevision;
    const delta = xf.appendRows(extra);

    expect(xf.stats.fullSorts).toBe(fullSortsAfterBuild); // no full re-argsort
    expect(xf.stats.permutationMerges).toBe(2); // one merge per range dimension
    expect(xf.rowCount()).toBe(105);
    expect(xf.selectionRevision).toBe(revBefore); // model updates keep the revision
    expect(notified).toBe(1);
    expect(xf.getBrush('score')).toEqual(scoreBrush);
    expect(xf.getBrush('group')).toEqual({ excluded: ['beta', 'zeta'] });

    // Delta covers exactly the new slots, partitioned by pass/fail.
    const brushes = new Map<string, BrushState>([
      ['score', scoreBrush],
      ['group', groupBrush],
    ]);
    const all = [...base, ...extra];
    const visible = oracleVisible(all, SPECS, brushes);
    const newSlots = [100, 101, 102, 103, 104];
    expect(sortedNums([...delta.hidden, ...delta.shown])).toEqual(newSlots);
    expect(sortedNums(delta.shown)).toEqual(newSlots.filter((s) => visible.has(s)));
    expect(sortedNums(delta.hidden)).toEqual(newSlots.filter((s) => !visible.has(s)));
    expect(new Set(xf.visibleSlots())).toEqual(visible);
    xf.dispose();
  });

  it('permutation merge equals a full-rebuild oracle (visibility and summaries)', () => {
    const { base, extra } = appendFixture();
    const appended = buildEngine(base);
    appended.setBrush('score', { min: 0, max: 60 });
    appended.setBrush('group', { excluded: ['beta', 'zeta'] });
    appended.appendRows(extra);

    const fresh = buildEngine([...base, ...extra]);
    fresh.setBrush('score', { min: 0, max: 60 });
    fresh.setBrush('group', { excluded: ['beta', 'zeta'] });

    expect(appended.visibleSlots()).toEqual(fresh.visibleSlots());
    for (const spec of SPECS) {
      expect(appended.summarize(spec.key)).toEqual(fresh.summarize(spec.key));
    }
    // A later brush move on the merged index still matches the oracle.
    const brushes = new Map<string, BrushState>([
      ['score', { min: -30, max: 40 }],
      ['group', { excluded: ['beta', 'zeta'] }],
    ]);
    appended.setBrush('score', brushes.get('score')!);
    expect(new Set(appended.visibleSlots())).toEqual(
      oracleVisible([...base, ...extra], SPECS, brushes),
    );
    appended.dispose();
    fresh.dispose();
  });
});

describe('TypedColumnCrossfilter — replaceAll', () => {
  it('rebuilds but preserves brushes by key, emitting one combined delta', () => {
    const rand = rng(7);
    const before = randomNodes(80, rand);
    const after = randomNodes(60, rand);
    const xf = buildEngine(before);
    xf.setBrush('score', { min: 10, max: 50 });
    xf.setBrush('group', { excluded: ['alpha'] });

    let notified = 0;
    xf.subscribe(() => notified++);
    const revBefore = xf.selectionRevision;
    const delta = xf.replaceAll(after);

    expect(xf.rowCount()).toBe(60);
    expect(xf.selectionRevision).toBe(revBefore); // model update keeps revision
    expect(notified).toBe(1);
    expect(xf.getBrush('score')).toEqual({ min: 10, max: 50 });
    expect(xf.getBrush('group')).toEqual({ excluded: ['alpha'] });

    const brushes = new Map<string, BrushState>([
      ['score', { min: 10, max: 50 }],
      ['group', { excluded: ['alpha'] }],
    ]);
    const visible = oracleVisible(after, SPECS, brushes);
    expect(new Set(xf.visibleSlots())).toEqual(visible);
    // Combined delta against the new roster's all-visible baseline.
    expect(delta.shown).toEqual([]);
    expect(sortedNums(delta.hidden)).toEqual(
      after.map((_, s) => s).filter((s) => !visible.has(s)),
    );

    // Summaries also match a fresh build with the same brushes.
    const fresh = buildEngine(after);
    fresh.setBrush('score', { min: 10, max: 50 });
    fresh.setBrush('group', { excluded: ['alpha'] });
    for (const spec of SPECS) {
      expect(xf.summarize(spec.key)).toEqual(fresh.summarize(spec.key));
    }
    xf.dispose();
    fresh.dispose();
  });
});

describe('TypedColumnCrossfilter — summary immutability & lifecycle', () => {
  it('previously returned summaries are frozen and never mutated', () => {
    const nodes = Array.from({ length: 40 }, (_, i) =>
      mkNode(i, { score: i, group: `g${i % 4}` }),
    );
    const xf = buildEngine(nodes);
    const before = xf.summarize('score');
    const beforeGroup = xf.summarize('group');
    const snapshot = JSON.parse(JSON.stringify(before)) as unknown;
    const snapshotGroup = JSON.parse(JSON.stringify(beforeGroup)) as unknown;

    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.bins)).toBe(true);
    expect(Object.isFrozen(before.bins[0])).toBe(true);
    expect(Object.isFrozen(beforeGroup.categories[0])).toBe(true);

    xf.setBrush('group', { excluded: ['g1', 'g2'] });
    xf.appendRows([mkNode(40, { score: 100, group: 'g9' })]);
    const afterScore = xf.summarize('score');
    expect(afterScore).not.toEqual(before); // state really changed
    expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
    expect(JSON.parse(JSON.stringify(beforeGroup))).toEqual(snapshotGroup);
    xf.dispose();
  });

  it('dispose is idempotent and every later call throws', () => {
    const xf = buildEngine([mkNode(0, { score: 1, group: 'a', when: EPOCH0 })]);
    const unsubscribe = xf.subscribe(() => {});
    xf.dispose();
    xf.dispose(); // idempotent
    expect(() => xf.setBrush('score', null)).toThrow(/disposed/);
    expect(() => xf.getBrush('score')).toThrow(/disposed/);
    expect(() => xf.summarize('score')).toThrow(/disposed/);
    expect(() => xf.rowCount()).toThrow(/disposed/);
    expect(() => xf.visibleSlots()).toThrow(/disposed/);
    expect(() => xf.appendRows([])).toThrow(/disposed/);
    expect(() => xf.replaceAll([])).toThrow(/disposed/);
    expect(() => xf.setExternalMask(null)).toThrow(/disposed/);
    expect(() => xf.subscribe(() => {})).toThrow(/disposed/);
    expect(() => xf.build([], SPECS)).toThrow(/disposed/);
    expect(() => unsubscribe()).not.toThrow(); // unsub stays safe
  });
});

describe('TypedColumnCrossfilter — validation & edge cases', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => mkNode(i, { score: i, group: 'a' }));

  it('rejects unknown keys, kind-mismatched brushes, bad specs', () => {
    const xf = buildEngine(nodes);
    expect(() => xf.setBrush('nope', null)).toThrow(/unknown dimension/);
    expect(() => xf.getBrush('nope')).toThrow(/unknown dimension/);
    expect(() => xf.setBrush('group', { min: 0, max: 1 })).toThrow(TypeError);
    expect(() => xf.setBrush('score', { excluded: ['a'] })).toThrow(TypeError);
    expect(() => xf.setBrush('score', { min: NaN, max: 1 })).toThrow(TypeError);
    xf.dispose();

    expect(() =>
      buildEngine(nodes, [
        { key: 'a', kind: 'numeric', get: () => 1 },
        { key: 'a', kind: 'numeric', get: () => 2 },
      ]),
    ).toThrow(/duplicate/);
    expect(() =>
      buildEngine(nodes, [{ key: 'a', kind: 'numeric', get: () => 1, bins: 0 }]),
    ).toThrow(TypeError);

    const unbuilt = new TypedColumnCrossfilter<Attrs>();
    expect(() => unbuilt.setBrush('score', null)).toThrow(/build/);
    expect(() => unbuilt.appendRows([])).toThrow(/build/);
  });

  it('honors spec.bins, single-value domains, empty dimensions, inverted brushes', () => {
    const xf = buildEngine(nodes, [
      { key: 'ten', kind: 'numeric', get: (nd) => nd.attrs?.score, bins: 10 },
      { key: 'flat', kind: 'numeric', get: () => 5 },
      { key: 'void', kind: 'numeric', get: () => 'never-a-number' },
    ]);
    expect(xf.summarize('ten').bins).toHaveLength(10);

    const flat = xf.summarize('flat'); // single-value domain → one bin
    expect(flat.domain).toEqual({ min: 5, max: 5 });
    expect(flat.bins).toHaveLength(1);
    expect(flat.bins[0]).toMatchObject({ x0: 5, x1: 5, total: 10 });

    const voidSummary = xf.summarize('void'); // all hygiene-excluded
    expect(voidSummary.domain).toBeUndefined();
    expect(voidSummary.bins).toEqual([]);
    expect(voidSummary.excludedRows).toBe(10);

    // Inverted brush (min > max) = empty selection on that dimension.
    xf.setBrush('ten', { min: 9, max: 2 });
    expect(xf.visibleSlots()).toEqual([]);
    xf.setBrush('ten', null);
    expect(xf.visibleSlots()).toHaveLength(10);
    xf.dispose();
  });
});
