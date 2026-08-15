import { describe, expect, it, vi } from 'vitest';
import {
  CATEGORICAL_PALETTE,
  DIVERGING_RANGE_DEFAULT,
  DomainStore,
  SEQUENTIAL_RANGE_DEFAULT,
  canonicalScaleKey,
  categoricalIndex,
  categoricalRows,
  computeNumericDomain,
  divergingColor,
  interpolateColor,
  sequentialColor,
  sequentialSize,
} from '../src/scale';
import type { DivergingScale, SequentialScale } from '../src/scale';
import type { GraphNode, Scale } from '../src/types';

const seq = (over?: Partial<SequentialScale<string>>): Scale<string> => ({
  kind: 'sequential',
  metric: 'degree',
  range: ['#3b82f6', '#f59e0b'],
  ...over,
});

// ---------------------------------------------------------------------------
// canonicalScaleKey
// ---------------------------------------------------------------------------

describe('canonicalScaleKey', () => {
  it('gives equal keys to equal inline literals (identity churn never reprojects)', () => {
    expect(canonicalScaleKey(seq())).toBe(canonicalScaleKey(seq()));
  });

  it('is insensitive to object key order', () => {
    const a: Scale<string> = { kind: 'sequential', metric: 'degree', range: ['#000', '#fff'] };
    const b: Scale<string> = { range: ['#000', '#fff'], metric: 'degree', kind: 'sequential' };
    expect(canonicalScaleKey(a)).toBe(canonicalScaleKey(b));
  });

  it('preserves array order (a reversed range is a different scale)', () => {
    expect(canonicalScaleKey(seq({ range: ['#f59e0b', '#3b82f6'] }))).not.toBe(
      canonicalScaleKey(seq()),
    );
  });

  it('discriminates by metric, kind, and nested domain arrays', () => {
    expect(canonicalScaleKey(seq({ metric: 'inDegree' }))).not.toBe(canonicalScaleKey(seq()));
    expect(canonicalScaleKey(seq({ domain: [0, 10] }))).not.toBe(canonicalScaleKey(seq()));
    expect(canonicalScaleKey(seq({ domain: [0, 10] }))).toBe(
      canonicalScaleKey(seq({ domain: [0, 10] })),
    );
    expect(canonicalScaleKey(seq({ domain: [10, 0] }))).not.toBe(
      canonicalScaleKey(seq({ domain: [0, 10] })),
    );
  });

  it('treats a DomainPolicy domain and a numeric domain as distinct', () => {
    expect(canonicalScaleKey(seq({ domain: { scope: 'visible' } }))).not.toBe(
      canonicalScaleKey(seq({ domain: [0, 1] })),
    );
    // Policy key order is canonicalized too.
    expect(
      canonicalScaleKey(seq({ domain: { scope: 'visible', streaming: 'expand' } })),
    ).toBe(canonicalScaleKey(seq({ domain: { streaming: 'expand', scope: 'visible' } })));
  });

  it('keys a function `by` via reference identity, not source text', () => {
    const byA = (n: GraphNode): string | null => (n.attrs?.['t'] as string | undefined) ?? null;
    const byB = (n: GraphNode): string | null => (n.attrs?.['t'] as string | undefined) ?? null;
    const cat = (by: typeof byA): Scale<string> => ({ kind: 'categorical', by });
    expect(canonicalScaleKey(cat(byA))).toBe(canonicalScaleKey(cat(byA)));
    expect(canonicalScaleKey(cat(byA))).not.toBe(canonicalScaleKey(cat(byB)));
  });

  it('gives equal keys to equal categorical field-string literals', () => {
    const a: Scale<string> = { kind: 'categorical', by: 'type', domain: ['x', 'y'] };
    const b: Scale<string> = { kind: 'categorical', domain: ['x', 'y'], by: 'type' };
    expect(canonicalScaleKey(a)).toBe(canonicalScaleKey(b));
  });
});

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

describe('palettes', () => {
  it('exports the 12-hue categorical palette', () => {
    expect(CATEGORICAL_PALETTE).toHaveLength(12);
    expect(CATEGORICAL_PALETTE[0]).toBe('#4e79a7');
    expect(CATEGORICAL_PALETTE[11]).toBe('#d37295');
  });

  it('exports 2-stop sequential and 3-stop diverging defaults', () => {
    expect(SEQUENTIAL_RANGE_DEFAULT).toEqual(['#3b82f6', '#f59e0b']);
    expect(DIVERGING_RANGE_DEFAULT).toEqual(['#3b82f6', '#e5e7eb', '#ef4444']);
  });
});

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

describe('interpolateColor', () => {
  it('returns exact endpoints at t=0 and t=1', () => {
    expect(interpolateColor('#3b82f6', '#f59e0b', 0)).toBe('rgba(59, 130, 246, 1)');
    expect(interpolateColor('#3b82f6', '#f59e0b', 1)).toBe('rgba(245, 158, 11, 1)');
  });

  it('interpolates the midpoint in sRGB', () => {
    expect(interpolateColor('#000000', '#ffffff', 0.5)).toBe('rgba(128, 128, 128, 1)');
    expect(interpolateColor('rgb(0, 0, 0)', 'rgb(100, 200, 40)', 0.5)).toBe(
      'rgba(50, 100, 20, 1)',
    );
  });

  it('interpolates alpha', () => {
    expect(interpolateColor('rgba(255, 0, 0, 0)', 'rgba(255, 0, 0, 1)', 0.25)).toBe(
      'rgba(255, 0, 0, 0.25)',
    );
    expect(interpolateColor('rgba(0, 0, 0, 0)', 'rgba(255, 255, 255, 1)', 0.5)).toBe(
      'rgba(128, 128, 128, 0.5)',
    );
  });

  it('clamps t and tolerates junk t/colors without throwing', () => {
    expect(interpolateColor('#000', '#fff', -3)).toBe('rgba(0, 0, 0, 1)');
    expect(interpolateColor('#000', '#fff', 7)).toBe('rgba(255, 255, 255, 1)');
    expect(interpolateColor('#000', '#fff', NaN)).toBe('rgba(0, 0, 0, 1)');
    // Unparseable stops fall back to the projection-lane neutral gray.
    expect(interpolateColor('not-a-color', 'also-junk', 0.5)).toBe('rgba(168, 168, 168, 1)');
  });
});

describe('sequentialColor / divergingColor / sequentialSize', () => {
  const s = seq() as SequentialScale<string>;

  it('maps domain endpoints to range endpoints and clamps outside values', () => {
    expect(sequentialColor(s, 0, [0, 10])).toBe('rgba(59, 130, 246, 1)');
    expect(sequentialColor(s, 10, [0, 10])).toBe('rgba(245, 158, 11, 1)');
    expect(sequentialColor(s, -5, [0, 10])).toBe('rgba(59, 130, 246, 1)');
    expect(sequentialColor(s, 99, [0, 10])).toBe('rgba(245, 158, 11, 1)');
  });

  it('maps a degenerate domain to the ramp midpoint', () => {
    expect(sequentialColor(s, 3, [3, 3])).toBe(interpolateColor('#3b82f6', '#f59e0b', 0.5));
  });

  it('returns null for null/non-finite values and null domains', () => {
    expect(sequentialColor(s, null, [0, 10])).toBeNull();
    expect(sequentialColor(s, NaN, [0, 10])).toBeNull();
    expect(sequentialColor(s, Infinity, [0, 10])).toBeNull();
    expect(sequentialColor(s, 5, null)).toBeNull();
  });

  const d: DivergingScale<string> = {
    kind: 'diverging',
    metric: 'degree',
    mid: 5,
    range: ['#0000ff', '#ffffff', '#ff0000'],
  };

  it('diverging: mid maps to the middle stop; halves interpolate independently', () => {
    expect(divergingColor(d, 5, [0, 10])).toBe('rgba(255, 255, 255, 1)');
    expect(divergingColor(d, 0, [0, 10])).toBe('rgba(0, 0, 255, 1)');
    expect(divergingColor(d, 10, [0, 10])).toBe('rgba(255, 0, 0, 1)');
    expect(divergingColor(d, 2.5, [0, 10])).toBe('rgba(128, 128, 255, 1)');
    expect(divergingColor(d, 7.5, [0, 10])).toBe('rgba(255, 128, 128, 1)');
  });

  it('diverging: asymmetric domains still pin mid to the middle stop', () => {
    // Lower half spans [0,5], upper half spans [5,25]: value 15 is halfway up.
    expect(divergingColor(d, 15, [0, 25])).toBe('rgba(255, 128, 128, 1)');
    expect(divergingColor(d, 5, [0, 25])).toBe('rgba(255, 255, 255, 1)');
  });

  it('diverging: degenerate halves collapse to the middle stop; hygiene nulls', () => {
    expect(divergingColor(d, 5, [5, 10])).toBe('rgba(255, 255, 255, 1)');
    expect(divergingColor(d, 6, [0, 5])).toBe('rgba(255, 255, 255, 1)');
    expect(divergingColor(d, null, [0, 10])).toBeNull();
    expect(divergingColor(d, NaN, [0, 10])).toBeNull();
    expect(divergingColor(d, 5, null)).toBeNull();
  });

  it('sequentialSize: linear clamp over the domain', () => {
    expect(sequentialSize([2, 14], 5, [0, 10])).toBe(8);
    expect(sequentialSize([2, 14], 0, [0, 10])).toBe(2);
    expect(sequentialSize([2, 14], 10, [0, 10])).toBe(14);
    expect(sequentialSize([2, 14], -100, [0, 10])).toBe(2);
    expect(sequentialSize([2, 14], 100, [0, 10])).toBe(14);
    expect(sequentialSize([2, 14], 7, [7, 7])).toBe(8); // degenerate → midpoint
    expect(sequentialSize([2, 14], null, [0, 10])).toBeNull();
    expect(sequentialSize([2, 14], NaN, [0, 10])).toBeNull();
    expect(sequentialSize([2, 14], 5, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeNumericDomain
// ---------------------------------------------------------------------------

describe('computeNumericDomain', () => {
  it('computes [min,max] excluding nulls and non-finite values', () => {
    expect(computeNumericDomain([3, null, -2, 7, NaN, Infinity, -Infinity, 0])).toEqual([-2, 7]);
  });

  it('returns null when nothing qualifies, and [v,v] for a single value', () => {
    expect(computeNumericDomain([])).toBeNull();
    expect(computeNumericDomain([null, NaN])).toBeNull();
    expect(computeNumericDomain([4])).toEqual([4, 4]);
  });
});

// ---------------------------------------------------------------------------
// DomainStore
// ---------------------------------------------------------------------------

describe('DomainStore', () => {
  it('freeze-per-revision: computes ONCE per {key, revision} even when data changed', () => {
    const store = new DomainStore();
    let data: [number, number] = [0, 10];
    const compute = vi.fn(() => data);
    const args = { key: 'k', policy: {}, datasetRevision: 1, compute };

    expect(store.resolveDomain(args)).toEqual([0, 10]);
    data = [100, 200]; // masking/brushing changed what's visible — irrelevant
    expect(store.resolveDomain(args)).toEqual([0, 10]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('dataset scope ignores scopeGeneration bumps (brushing never recomputes)', () => {
    const store = new DomainStore();
    const compute = vi.fn(() => [0, 10] as [number, number]);
    store.resolveDomain({ key: 'k', datasetRevision: 1, scopeGeneration: 1, compute });
    store.resolveDomain({ key: 'k', datasetRevision: 1, scopeGeneration: 2, compute });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('a new dataset revision recomputes (and replaces under freeze-per-revision)', () => {
    const store = new DomainStore();
    let data: [number, number] = [0, 10];
    const compute = vi.fn(() => data);
    expect(store.resolveDomain({ key: 'k', datasetRevision: 1, compute })).toEqual([0, 10]);
    data = [5, 6];
    expect(store.resolveDomain({ key: 'k', datasetRevision: 2, compute })).toEqual([5, 6]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('streaming expand: recomputes union monotonically (the domain only grows)', () => {
    const store = new DomainStore();
    const policy = { streaming: 'expand' as const };
    let data: [number, number] | null = [0, 10];
    const compute = (): [number, number] | null => data;

    expect(store.resolveDomain({ key: 'k', policy, datasetRevision: 1, compute })).toEqual([0, 10]);
    data = [5, 20];
    expect(store.resolveDomain({ key: 'k', policy, datasetRevision: 2, compute })).toEqual([0, 20]);
    data = [2, 3]; // shrunk data never shrinks the domain
    expect(store.resolveDomain({ key: 'k', policy, datasetRevision: 3, compute })).toEqual([0, 20]);
    data = null; // empty batch keeps the prior domain
    expect(store.resolveDomain({ key: 'k', policy, datasetRevision: 4, compute })).toEqual([0, 20]);
  });

  it('explicit domain wins verbatim and never computes or caches', () => {
    const store = new DomainStore();
    const explicit: readonly [number, number] = [42, 43];
    const compute = vi.fn(() => [0, 10] as [number, number]);
    expect(
      store.resolveDomain({ key: 'k', explicit, datasetRevision: 1, compute }),
    ).toBe(explicit);
    expect(compute).not.toHaveBeenCalled();
    // Dropping `explicit` afterwards computes fresh — nothing was cached.
    expect(store.resolveDomain({ key: 'k', datasetRevision: 1, compute })).toEqual([0, 10]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("scoped policies recompute when the caller's scopeGeneration bumps", () => {
    const store = new DomainStore();
    const policy = { scope: 'visible' as const };
    let data: [number, number] = [0, 10];
    const compute = vi.fn(() => data);

    expect(
      store.resolveDomain({ key: 'k', policy, datasetRevision: 1, scopeGeneration: 1, compute }),
    ).toEqual([0, 10]);
    // Same generation → frozen.
    data = [1, 2];
    expect(
      store.resolveDomain({ key: 'k', policy, datasetRevision: 1, scopeGeneration: 1, compute }),
    ).toEqual([0, 10]);
    expect(compute).toHaveBeenCalledTimes(1);
    // Bumped generation → recompute (replace: freeze-per-revision default).
    expect(
      store.resolveDomain({ key: 'k', policy, datasetRevision: 1, scopeGeneration: 2, compute }),
    ).toEqual([1, 2]);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('hard-scope + expand unions across scope generations', () => {
    const store = new DomainStore();
    const policy = { scope: 'hard-scope' as const, streaming: 'expand' as const };
    let data: [number, number] = [0, 10];
    const compute = (): [number, number] => data;
    store.resolveDomain({ key: 'k', policy, datasetRevision: 1, scopeGeneration: 1, compute });
    data = [-5, 3];
    expect(
      store.resolveDomain({ key: 'k', policy, datasetRevision: 1, scopeGeneration: 2, compute }),
    ).toEqual([-5, 10]);
  });

  it('keys are independent (per canonical scale key + metric)', () => {
    const store = new DomainStore();
    const a = vi.fn(() => [0, 1] as [number, number]);
    const b = vi.fn(() => [2, 3] as [number, number]);
    expect(store.resolveDomain({ key: 'a', datasetRevision: 1, compute: a })).toEqual([0, 1]);
    expect(store.resolveDomain({ key: 'b', datasetRevision: 1, compute: b })).toEqual([2, 3]);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('invalidateDataset drops other-revision entries (kills expand lineage on replace)', () => {
    const store = new DomainStore();
    const policy = { streaming: 'expand' as const };
    let data: [number, number] = [0, 100];
    const compute = (): [number, number] => data;
    store.resolveDomain({ key: 'k', policy, datasetRevision: 1, compute });

    store.invalidateDataset(2); // dataset replaced at revision 2
    data = [5, 6];
    // No union with the dead [0,100] lineage — fresh compute.
    expect(store.resolveDomain({ key: 'k', policy, datasetRevision: 2, compute })).toEqual([5, 6]);
  });

  it('invalidateDataset keeps entries already frozen at the given revision', () => {
    const store = new DomainStore();
    const compute = vi.fn(() => [0, 10] as [number, number]);
    store.resolveDomain({ key: 'k', datasetRevision: 2, compute });
    store.invalidateDataset(2);
    store.resolveDomain({ key: 'k', datasetRevision: 2, compute });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('clear() resets everything', () => {
    const store = new DomainStore();
    const compute = vi.fn(() => [0, 10] as [number, number]);
    store.resolveDomain({ key: 'k', datasetRevision: 1, compute });
    store.clear();
    store.resolveDomain({ key: 'k', datasetRevision: 1, compute });
    expect(compute).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Categorical assignment
// ---------------------------------------------------------------------------

describe('categoricalIndex', () => {
  const palette = CATEGORICAL_PALETTE;

  it('assigns declared-domain values their domain position (mod palette length)', () => {
    const domain = ['a', 'b', 'c'];
    expect(categoricalIndex(domain, palette, 'a')).toBe(0);
    expect(categoricalIndex(domain, palette, 'b')).toBe(1);
    expect(categoricalIndex(domain, palette, 'c')).toBe(2);
  });

  it('wraps domain positions past the palette length', () => {
    const domain = Array.from({ length: 15 }, (_, i) => `cat${i}`);
    expect(categoricalIndex(domain, palette, 'cat12')).toBe(0);
    expect(categoricalIndex(domain, palette, 'cat13')).toBe(1);
  });

  it('hashes out-of-domain values to PINNED stable slots (never first-seen order)', () => {
    // fnv-1a 32-bit pins: grape→2893541840, mango→242548693,
    // kiwi→3221091481, pear→3491742317.
    expect(categoricalIndex(undefined, palette, 'grape')).toBe(2893541840 % 12); // 8
    expect(categoricalIndex(undefined, palette, 'mango')).toBe(242548693 % 12); // 1
    expect(categoricalIndex(undefined, palette, 'kiwi')).toBe(3221091481 % 12); // 1
    expect(categoricalIndex(undefined, palette, 'pear')).toBe(3491742317 % 12); // 5
    expect(categoricalIndex(undefined, palette, 'grape')).toBe(8);
    expect(categoricalIndex(undefined, palette, 'pear')).toBe(5);
    // Same hash slots with a declared-but-non-matching domain.
    expect(categoricalIndex(['x'], palette, 'grape')).toBe(8);
    // Custom 4-slot palette: hash mod 4.
    const small = ['p0', 'p1', 'p2', 'p3'];
    expect(categoricalIndex(undefined, small, 'grape')).toBe(0);
    expect(categoricalIndex(undefined, small, 'mango')).toBe(1);
    expect(categoricalIndex(undefined, small, 'pear')).toBe(1);
  });

  it('is arrival-order independent: querying in any order gives the same slots', () => {
    const forward = ['grape', 'mango', 'kiwi', 'pear'].map((v) =>
      categoricalIndex(undefined, palette, v),
    );
    const reverse = ['pear', 'kiwi', 'mango', 'grape']
      .map((v) => categoricalIndex(undefined, palette, v))
      .reverse();
    expect(forward).toEqual(reverse);
    expect(forward).toEqual([8, 1, 1, 5]);
  });

  it('returns -1 for an empty palette', () => {
    expect(categoricalIndex(['a'], [], 'a')).toBe(-1);
    expect(categoricalIndex(undefined, [], 'z')).toBe(-1);
  });
});

describe('categoricalRows', () => {
  it('lists declared domain first — including empty categories — then extras sorted', () => {
    expect(categoricalRows(['x', 'y'], ['y', 'b', 'a'])).toEqual(['x', 'y', 'a', 'b']);
  });

  it('is stable across seen arrival order', () => {
    expect(categoricalRows(['x'], ['c', 'a', 'b'])).toEqual(categoricalRows(['x'], ['b', 'c', 'a']));
  });

  it('deduplicates seen values and declared duplicates', () => {
    expect(categoricalRows(['x', 'x'], ['a', 'a', 'x'])).toEqual(['x', 'a']);
  });

  it('handles absent domains and empty seen sets', () => {
    expect(categoricalRows(undefined, ['b', 'a'])).toEqual(['a', 'b']);
    expect(categoricalRows(['x', 'y'], [])).toEqual(['x', 'y']);
    expect(categoricalRows(undefined, [])).toEqual([]);
  });
});
