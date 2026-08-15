/**
 * scales & domains — canonical scale keying, default
 * palettes, sRGB color interpolation, domain-state machinery, and stable
 * categorical assignment. Pure and engine-free; the instance/projection
 * layers consume these primitives when a styling channel carries a `Scale`.
 *
 * Semantics:
 * - Scales are plain descriptors compared by CANONICAL STRUCTURAL VALUE
 * equal inline literals produce equal keys and never reproject. A function
 * `by` keys by reference identity (WeakMap token), never by source text.
 * - Domains default to the whole dataset revision and stay FROZEN across
 * masking/brushing/isolation ('dataset' scope): the same metric value never
 * changes visual meaning because a user brushed. 'hard-scope'/'visible' are
 * explicit opt-ins that recompute when the caller's scope generation bumps;
 * streaming 'expand' permits monotonic domain growth on recompute.
 * - Explicit numeric domains always win verbatim (never computed, cached, or
 * unioned).
 * - Categorical values declared in `domain` take their declared position;
 * out-of-domain values take a stable fnv-1a hash slot — NEVER first-seen
 * order, so arrival order can never recolor a category.
 * - numeric hygiene: null/non-finite metric values resolve to `null`
 * (caller falls back to the default style) and are excluded from domains.
 */

import { canonicalFilterKey } from './filter';
import { parseColor } from './projection';
import type { RGBA } from './projection';
import type { DomainPolicy, Scale } from './types';

// ---------------------------------------------------------------------------
// Scale-kind aliases (narrowing helpers for consumers)
// ---------------------------------------------------------------------------

export type SequentialScale<T, N = Record<string, unknown>> = Extract<
  Scale<T, N>,
  { kind: 'sequential' }
>;
export type CategoricalScale<T, N = Record<string, unknown>> = Extract<
  Scale<T, N>,
  { kind: 'categorical' }
>;
export type DivergingScale<T, N = Record<string, unknown>> = Extract<
  Scale<T, N>,
  { kind: 'diverging' }
>;

// ---------------------------------------------------------------------------
// Canonical keying
// ---------------------------------------------------------------------------

/**
 * Canonical structural key for a Scale descriptor: object keys sorted, array
 * order preserved, undefined-valued keys omitted, and a function `by` mapped
 * to a unique reference-identity token (same WeakMap approach — and canonical
 * grammar — as `canonicalFilterKey`). Two scales with equal keys are
 * structurally equivalent: equal inline literals MUST and DO produce equal keys, so
 * identity churn never reprojects; swapping a function reference always does.
 */
export function canonicalScaleKey<T, N>(scale: Scale<T, N>): string {
  return canonicalFilterKey(scale);
}

// ---------------------------------------------------------------------------
// Default palettes (dataviz-convention: brand-neutral, light/dark aware)
// ---------------------------------------------------------------------------

/** 12 brand-neutral categorical hues distinguishable on light AND dark. */
export const CATEGORICAL_PALETTE: readonly string[] = [
  '#4e79a7',
  '#f28e2b',
  '#59a14f',
  '#e15759',
  '#b07aa1',
  '#76b7b2',
  '#edc948',
  '#ff9da7',
  '#9c755f',
  '#bab0ac',
  '#86bcb6',
  '#d37295',
];

/** Default sequential ramp endpoints (low → high). */
export const SEQUENTIAL_RANGE_DEFAULT: readonly [string, string] = ['#3b82f6', '#f59e0b'];

/** Default diverging stops (low → mid → high). */
export const DIVERGING_RANGE_DEFAULT: readonly [string, string, string] = [
  '#3b82f6',
  '#e5e7eb',
  '#ef4444',
];

// ---------------------------------------------------------------------------
// Color interpolation (sRGB via projection.ts parseColor)
// ---------------------------------------------------------------------------

/** Matches projection.ts DEFAULT_COLOR_FALLBACK — unparseable stops degrade
 * to the same neutral gray the projection lane falls back to. */
const COLOR_STOP_FALLBACK: RGBA = [0.66, 0.66, 0.66, 1];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function formatRgba(r: number, g: number, b: number, a: number): string {
  const rr = Math.round(clamp01(r) * 255);
  const gg = Math.round(clamp01(g) * 255);
  const bb = Math.round(clamp01(b) * 255);
  // 3 decimals keeps alpha exact for the usual fractions and float-noise-free.
  const aa = Math.round(clamp01(a) * 1000) / 1000;
  return `rgba(${rr}, ${gg}, ${bb}, ${aa})`;
}

/**
 * Interpolates between two CSS color strings in sRGB (component-wise,
 * including alpha) and returns an `rgba(r, g, b, a)` string. `t` is clamped
 * to [0,1] (non-finite t → 0). Unparseable endpoints fall back to the
 * projection lane's neutral gray — never a throw, never NaN output.
 */
export function interpolateColor(a: string, b: string, t: number): string {
  const ca = parseColor(a) ?? COLOR_STOP_FALLBACK;
  const cb = parseColor(b) ?? COLOR_STOP_FALLBACK;
  const k = Number.isFinite(t) ? clamp01(t) : 0;
  return formatRgba(
    ca[0] + (cb[0] - ca[0]) * k,
    ca[1] + (cb[1] - ca[1]) * k,
    ca[2] + (cb[2] - ca[2]) * k,
    ca[3] + (cb[3] - ca[3]) * k,
  );
}

/** [lo,hi] position of `value`, clamped; degenerate/junk spans map to 0.5
 * (the d3 convention — a single-valued domain renders the ramp midpoint). */
function normalizePosition(value: number, lo: number, hi: number): number {
  const span = hi - lo;
  if (!Number.isFinite(span) || span === 0) return 0.5;
  return clamp01((value - lo) / span);
}

/**
 * Sequential color: maps `value` across `domain` onto the two-stop ramp.
 * Returns null (caller renders the default style, hygiene) when the value
 * is null/non-finite or the domain is null.
 */
export function sequentialColor<N = Record<string, unknown>>(
  scale: SequentialScale<string, N>,
  value: number | null,
  domain: readonly [number, number] | null,
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || domain === null) return null;
  const t = normalizePosition(value, domain[0], domain[1]);
  return interpolateColor(scale.range[0], scale.range[1], t);
}

/**
 * Diverging color: `mid` maps to the middle stop exactly; each half
 * interpolates independently ([domain[0]..mid] over range[0..1],
 * [mid..domain[1]] over range[1..2]). A degenerate half collapses to the
 * middle stop. Null/non-finite value or null domain → null.
 */
export function divergingColor<N = Record<string, unknown>>(
  scale: DivergingScale<string, N>,
  value: number | null,
  domain: readonly [number, number] | null,
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || domain === null) return null;
  const { mid } = scale;
  if (value <= mid) {
    const span = mid - domain[0];
    const t = !Number.isFinite(span) || span <= 0 ? 1 : clamp01((value - domain[0]) / span);
    return interpolateColor(scale.range[0], scale.range[1], t);
  }
  const span = domain[1] - mid;
  const t = !Number.isFinite(span) || span <= 0 ? 0 : clamp01((value - mid) / span);
  return interpolateColor(scale.range[1], scale.range[2], t);
}

/**
 * Sequential size: linear map of `value` across `domain` onto [lo,hi],
 * clamped at the range endpoints. Degenerate domains yield the range
 * midpoint; null/non-finite values and null domains yield null (default
 * style — NaN is never handed to a size buffer).
 */
export function sequentialSize(
  range: readonly [number, number],
  value: number | null,
  domain: readonly [number, number] | null,
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || domain === null) return null;
  const t = normalizePosition(value, domain[0], domain[1]);
  const size = range[0] + (range[1] - range[0]) * t;
  return Number.isFinite(size) ? size : null;
}

// ---------------------------------------------------------------------------
// Domain computation & the DomainStore
// ---------------------------------------------------------------------------

/**
 * [min,max] over the finite numbers in `values` (hygiene: null and
 * non-finite entries are excluded), or null when nothing qualifies. A single
 * qualifying value yields a degenerate [v,v] domain.
 */
export function computeNumericDomain(values: Iterable<number | null>): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  let seen = false;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    seen = true;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return seen ? [min, max] : null;
}

export interface ResolveDomainArgs {
  /** Cache key — `canonicalScaleKey(scale)` (the metric name is part of the
   * descriptor, so the key already discriminates by metric). Opaque here. */
  key: string;
  /** Explicit caller domain — returned VERBATIM; never computed, cached, or
   * expand-unioned. */
  explicit?: readonly [number, number] | undefined;
  /** Defaults: scope 'dataset', streaming 'freeze-per-revision'. */
  policy?: DomainPolicy | undefined;
  /** The dataset revision the caller is resolving against. */
  datasetRevision: number | string;
  /** Caller-owned generation counter for 'hard-scope'/'visible' scopes
   * (bump = recompute). IGNORED under 'dataset' scope — masking/brushing
   * must never change what a color means. */
  scopeGeneration?: number | undefined;
  /** Source lineage this resolve belongs to (dataset key + source
   * revision). `streaming: 'expand'` unions only WITHIN one lineage — a
   * source replacement starts fresh instead of unioning dead extrema.
   * Callers that omit it keep the legacy always-union behavior. */
  lineage?: string | undefined;
  /** Domain producer (typically wraps computeNumericDomain over the metric
   * column). Called at most once per freeze coordinate. */
  compute: () => readonly [number, number] | null;
}

interface DomainEntry {
  datasetRevision: number | string;
  scopeGeneration: number;
  lineage: string | undefined;
  domain: readonly [number, number] | null;
}

function unionDomains(
  a: readonly [number, number] | null,
  b: readonly [number, number] | null,
): readonly [number, number] | null {
  if (a === null) return b;
  if (b === null) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

/**
 * Per-instance domain freezer keyed by canonical scale key.
 *
 * FREEZE-PER-REVISION: under scope 'dataset' the domain is computed ONCE per
 * {key, datasetRevision} — repeat resolves return the frozen value without
 * calling `compute`, no matter how the underlying data was masked or brushed
 * in between. 'hard-scope'/'visible' additionally recompute when the caller's
 * scopeGeneration bumps. Streaming 'expand' turns every recompute into a
 * monotonic union with the previous domain (the domain only ever grows);
 * 'freeze-per-revision' replaces it. Explicit domains bypass the store.
 */
export class DomainStore {
  private readonly entries = new Map<string, DomainEntry>();

  resolveDomain(args: ResolveDomainArgs): readonly [number, number] | null {
    if (args.explicit !== undefined) return args.explicit;
    const scope = args.policy?.scope ?? 'dataset';
    const streaming = args.policy?.streaming ?? 'freeze-per-revision';
    const generation = args.scopeGeneration ?? 0;
    const entry = this.entries.get(args.key);
    if (
      entry !== undefined &&
      entry.datasetRevision === args.datasetRevision &&
      (scope === 'dataset' || entry.scopeGeneration === generation)
    ) {
      return entry.domain; // frozen — compute is NOT called
    }
    const computed = args.compute();
    // expand-union is lineage-guarded — a replaced source (new
    // lineage) starts a fresh monotonic run instead of unioning against
    // the dead dataset's extrema.
    const domain =
      streaming === 'expand' && entry !== undefined && entry.lineage === args.lineage
        ? unionDomains(entry.domain, computed)
        : computed;
    this.entries.set(args.key, {
      datasetRevision: args.datasetRevision,
      scopeGeneration: generation,
      lineage: args.lineage,
      domain,
    });
    return domain;
  }

  /**
   * Dataset replace: `revision` is the revision now current — every entry
   * frozen for any OTHER revision is dropped (including expand-union lineage,
   * so a replaced dataset never unions against dead data). Entries already
   * at `revision` survive.
   */
  invalidateDataset(revision: number | string): void {
    for (const [key, entry] of this.entries) {
      if (entry.datasetRevision !== revision) this.entries.delete(key);
    }
  }

  /** Full reset (dataset identity change / instance teardown). */
  clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Categorical assignment
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a over UTF-16 code units — the stable out-of-domain slot hash.
 * PINNED: changing this function recolors every undeclared category. */
function fnv1a(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Palette slot for a categorical value: values declared in `domain` take
 * their declared position (mod palette length — fixed order → stable colors);
 * out-of-domain values take fnv-1a(value) mod palette length — stable across
 * sessions and arrival orders, NEVER first-seen order. Returns -1 for an
 * empty palette.
 */
export function categoricalIndex(
  domain: readonly string[] | undefined,
  palette: readonly unknown[],
  value: string,
): number {
  if (palette.length === 0) return -1;
  if (domain !== undefined) {
    const pos = domain.indexOf(value);
    if (pos >= 0) return pos % palette.length;
  }
  return fnv1a(value) % palette.length;
}

/**
 * Stable legend row order: declared `domain` values FIRST in declared order
 * (including currently-empty categories), then extra seen values sorted
 * lexicographically. Duplicates (within `seen` or already declared) collapse.
 */
export function categoricalRows(
  domain: readonly string[] | undefined,
  seen: Iterable<string>,
): string[] {
  const rows: string[] = [];
  const declared = new Set<string>();
  if (domain !== undefined) {
    for (const v of domain) {
      if (declared.has(v)) continue;
      declared.add(v);
      rows.push(v);
    }
  }
  const extras: string[] = [];
  const extraSet = new Set<string>();
  for (const v of seen) {
    if (declared.has(v) || extraSet.has(v)) continue;
    extraSet.add(v);
    extras.push(v);
  }
  extras.sort();
  for (const v of extras) rows.push(v);
  return rows;
}
