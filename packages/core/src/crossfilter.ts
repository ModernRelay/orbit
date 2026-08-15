/**
 * crossfilter — typed-column engine (v0.7 node-dimension subset).
 *
 * `TypedColumnCrossfilter` is the columnar backend the instance wraps into the
 * public `CrossfilterSession`. Design (crossfilter.js lineage):
 *
 * - **Parse once.** `build` extracts every dimension exactly once into typed
 * columns (numeric/temporal → `Float64Array` epoch-ms/values, categorical →
 * dictionary codes). hygiene: non-finite numerics, unparseable temporals,
 * and non-string/non-finite categorical values are excluded from the
 * dimension (tracked per dimension in `excludedRows`; the slot is marked
 * invalid). Temporal parsing: numbers are epoch ms verbatim; strings go
 * through `Date.parse` (ES2022 parses `'YYYY-MM-DD'` as UTC midnight);
 * `Date` instances use `getTime`.
 * - **O(Δ) brushes.** Each range dimension keeps a one-time argsorted
 * permutation. A brush move performs two binary searches and walks ONLY the
 * symmetric difference between the old and new in-range windows; categorical
 * brushes walk only the per-code slot lists whose excluded flag changed. The
 * brush path never re-sorts. A per-slot, per-dimension pass flag plus a
 * global per-slot failure counter make a row selection-visible iff it fails
 * zero dimensions. Hygiene-excluded rows fail any non-null brush on that
 * dimension (they cannot be in range / in a category) and pass a null brush.
 * - **Deltas out.** `setBrush` returns the slots whose overall visibility
 * flipped (`hidden`/`shown`) for the instance's mask source.
 * - **Lazy dual layer.** `summarize` returns immutable summaries whose
 * `filtered` layer counts rows passing every OTHER dimension's brush plus an
 * external node-mask predicate (`setExternalMask`). v0.7 recomputes a dirty
 * dimension's filtered layer lazily per `summarize` call — O(rows) per
 * dirty summarize, documented and acceptable at this tier (fixtures own
 * the perf claims; the O(Δ) guarantee covers the brush/visibility path).
 * - **Revisions & notify.** `selectionRevision` starts at 0 and advances
 * exactly once per observable `setBrush` (a brush state change is observable
 * via `getBrush` even when no row flips). v0.7 is synchronous, so
 * latest-call-wins degenerates to "every call applies immediately in call
 * order". Subscribers fire once per observable change after state is
 * consistent; synchronous re-entrancy (a subscriber mutating the engine) is
 * coalesced into one trailing notification pass. Model updates
 * (`appendRows`/`replaceAll`) keep the current `selectionRevision`
 * but do notify. External-mask changes notify (summaries changed) without
 * advancing the selection revision.
 * - **Incremental append.** `appendRows` extends columns/codes in place and
 * merges the pre-sorted old permutation with the sorted new block
 * (permutation merge — never a full re-argsort); bins extend incrementally
 * unless the domain grew (then a re-bin, still sort-free). Brushes persist
 * by key and are re-applied to the NEW slots only; the returned delta covers
 * only new slots (`shown` = new passing, `hidden` = new failing).
 * `replaceAll` rebuilds columns but preserves brushes by dimension key,
 * re-applying them as one combined delta against an all-visible baseline of
 * the new roster (`shown` is always empty). `replaceAll` clears the external
 * mask (slot indices changed meaning); `appendRows` keeps it and treats new
 * slots as passing until the instance re-supplies it.
 */

import type {
  BrushState,
  CategoryBin,
  DimensionKind,
  DimensionSpec,
  DimensionSummary,
  GraphNode,
  HistogramBin,
} from './types';

/** Default histogram bin count for numeric/temporal dimensions. */
export const DEFAULT_BIN_COUNT = 24;

/** Slots whose overall selection-visibility flipped in one operation. */
export interface BrushDelta {
  /** Slots that flipped visible → hidden. */
  hidden: number[];
  /** Slots that flipped hidden → visible. */
  shown: number[];
}

/** Test instrumentation counters (see crossfilter.test.ts O(Δ) evidence). */
export interface CrossfilterStats {
  /** Slots touched by brush delta walks (the O(Δ) loop). */
  slotsWalked: number;
  /** Full-column argsorts (build/replaceAll only — never append or brush). */
  fullSorts: number;
  /** Permutation merges performed by appendRows. */
  permutationMerges: number;
  /** Incremental filtered-layer bin adjustments (O(Δ·D)). */
  binUpdates: number;
  /** Full O(rows) filtered-layer recomputes (materialization/oracle only). */
  filteredRecomputes: number;
}

interface DimBase<N> {
  readonly spec: DimensionSpec<N>;
  readonly key: string;
  /** 1 = slot passes this dimension's brush. */
  pass: Uint8Array;
  /** hygiene-excluded slots (unparseable / non-finite). */
  invalidSlots: number[];
  /** Normalized, frozen brush (null = no brush). */
  brush: BrushState;
  /** Lazy filtered-layer cache validity. */
  filteredDirty: boolean;
  /** the filtered layer is MATERIALIZED and eagerly maintained by
   * the flip hook — summarize reads it O(bins) with no recompute. Falls
   * back to lazy-dirty on external-mask changes, appends, and replaces
   * (slot meaning or bin domains moved). */
  filteredLive: boolean;
}

interface RangeDim<N> extends DimBase<N> {
  readonly kind: 'numeric' | 'temporal';
  /** Per-slot value; NaN marks hygiene-excluded slots. */
  values: Float64Array;
  /** Valid slots argsorted ascending by value (ties by slot index). */
  sorted: Uint32Array;
  hasDomain: boolean;
  domainMin: number;
  domainMax: number;
  /** Requested bin count (spec.bins ?? DEFAULT_BIN_COUNT). */
  readonly binCount: number;
  /** 0 when empty, 1 when the domain is a single point, else binCount. */
  effectiveBins: number;
  /** Per-slot bin index; -1 for invalid slots. */
  slotBin: Int32Array;
  binTotals: number[];
  /** Current in-range window [lo, hi) into `sorted` (meaningful when brushed). */
  lo: number;
  hi: number;
  filteredBins: number[];
}

interface CatDim<N> extends DimBase<N> {
  readonly kind: 'categorical';
  /** Per-slot dictionary code; -1 for invalid slots. */
  codes: Int32Array;
  codeOf: Map<string, number>;
  /** Code → key, first-occurrence order. */
  codeKeys: string[];
  /** Code → slots carrying it (built once; the categorical delta path). */
  codeSlots: number[][];
  /** Currently excluded category keys (empty set when brush is null). */
  excludedSet: Set<string>;
  filteredCats: number[];
}

type DimState<N> = RangeDim<N> | CatDim<N>;

interface NormalizedBrush {
  brush: BrushState;
  /** Deduped excluded keys (categorical; empty otherwise). */
  set: Set<string>;
}

// ---------------------------------------------------------------------------
// Extraction — applied exactly once per slot per dimension.
// ---------------------------------------------------------------------------

function numericValue(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function temporalValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const t = Date.parse(raw); // 'YYYY-MM-DD' → UTC midnight per ES2022
    return Number.isFinite(t) ? t : null;
  }
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function categoricalKey(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

function rangeValue(kind: 'numeric' | 'temporal', raw: unknown): number | null {
  return kind === 'numeric' ? numericValue(raw) : temporalValue(raw);
}

/** First index i in sorted with values[sorted[i]] >= target. */
function lowerBound(values: Float64Array, sorted: Uint32Array, target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[sorted[mid]!]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i in sorted with values[sorted[i]] > target. */
function upperBound(values: Float64Array, sorted: Uint32Array, target: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[sorted[mid]!]! <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class TypedColumnCrossfilter<N = Record<string, unknown>> {
  /** Test instrumentation; see CrossfilterStats. Reset with resetStats. */
  readonly stats: CrossfilterStats = {
    slotsWalked: 0,
    fullSorts: 0,
    permutationMerges: 0,
    binUpdates: 0,
    filteredRecomputes: 0,
  };
  /** Count of dims whose filtered layer is live-maintained. */
  private liveDims = 0;

  private dims: DimState<N>[] = [];
  private byKey = new Map<string, DimState<N>>();
  private specs: readonly DimensionSpec<N>[] = [];
  private n = 0;
  /** Per-slot count of dimensions the slot currently fails. */
  private failCount = new Uint16Array(0);
  private externalMask: Uint8Array | null = null;
  private revision = 0;
  private readonly subscribers = new Set<() => void>();
  private built = false;
  private disposed = false;
  private notifying = false;
  private renotify = false;

  /** Monotonic from 0; advances exactly once per observable setBrush change. */
  get selectionRevision(): number {
    return this.revision;
  }

  resetStats(): void {
    this.stats.slotsWalked = 0;
    this.stats.fullSorts = 0;
    this.stats.permutationMerges = 0;
    this.stats.binUpdates = 0;
    this.stats.filteredRecomputes = 0;
  }

  /** telemetry: estimated bytes of typed-column storage held.
   * Documented components: per-dim value/permutation/bin/code/pass arrays,
   * the global failure counter, and the external mask. */
  estimatedBytes(): number {
    let bytes = this.failCount.byteLength + (this.externalMask?.byteLength ?? 0);
    for (const d of this.dims) {
      bytes += d.pass.byteLength;
      if (d.kind === 'categorical') {
        bytes += d.codes.byteLength;
      } else {
        bytes += d.values.byteLength + d.sorted.byteLength + d.slotBin.byteLength;
      }
    }
    return bytes;
  }

  /** live-layer bookkeeping — the ONLY writer of `filteredLive`. */
  private setFilteredLive(dim: DimState<N>, live: boolean): void {
    if (dim.filteredLive === live) return;
    dim.filteredLive = live;
    this.liveDims += live ? 1 : -1;
  }

  /**
   * (Re)initialize columns from scratch. Clears all brushes and the external
   * mask (use replaceAll to rebuild while preserving brushes by key). Does not
   * notify and does not touch selectionRevision.
   */
  build(nodes: readonly GraphNode<N>[], specs: readonly DimensionSpec<N>[]): void {
    this.ensureLive();
    this.buildDims(nodes, specs);
    this.built = true;
  }

  rowCount(): number {
    this.ensureLive();
    return this.n;
  }

  getBrush(key: string): BrushState {
    this.ensureLive();
    return this.dim(key).brush;
  }

  isSlotVisible(slot: number): boolean {
    this.ensureLive();
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.n) return false;
    return this.failCount[slot] === 0;
  }

  /** Fresh array of selection-visible slots, ascending. */
  visibleSlots(): number[] {
    this.ensureLive();
    const out: number[] = [];
    for (let s = 0; s < this.n; s++) if (this.failCount[s] === 0) out.push(s);
    return out;
  }

  /**
   * Apply a brush (latest-call-wins: v0.7 is synchronous, so each call applies
   * immediately in call order). Returns the slots whose overall
   * selection-visibility flipped. A no-op (deep-equal brush) returns empty
   * deltas without advancing selectionRevision or notifying.
   */
  setBrush(key: string, brush: BrushState): BrushDelta {
    this.ensureLive();
    const dim = this.dim(key);
    const normalized = normalizeBrush(dim.kind, brush);
    if (brushEquals(dim, normalized)) return { hidden: [], shown: [] };

    const delta: BrushDelta = { hidden: [], shown: [] };
    if (dim.kind === 'categorical') {
      this.applyCatTransition(dim, normalized, delta);
    } else {
      this.applyRangeTransition(dim, normalized.brush as { min: number; max: number } | null, delta);
    }
    dim.brush = normalized.brush;
    // Own filtered layer ignores the own-dim brush. OTHER layers: live ones
    // were maintained inline by the flip hook and stay clean;
    // only never-materialized layers go dirty.
    for (const other of this.dims) {
      if (other !== dim && !other.filteredLive) other.filteredDirty = true;
    }
    this.revision++;
    this.notify();
    return delta;
  }

  /**
   * External node-mask predicate for the joint "filtered" second layer (the
   * instance wires the filter-prop node mask in). Affects summaries only,
   * never selection visibility. Length must equal rowCount. Notifies on
   * observable change; does NOT advance selectionRevision.
   */
  setExternalMask(passSlots: Uint8Array | null): void {
    this.ensureLive();
    if (passSlots === null) {
      if (this.externalMask === null) return;
      this.externalMask = null;
    } else {
      if (passSlots.length !== this.n) {
        throw new RangeError(
          `setExternalMask: mask length ${passSlots.length} !== rowCount ${this.n}`,
        );
      }
      // An all-pass mask is indistinguishable from null → not observable.
      const unchanged =
        this.externalMask === null ? allOnes(passSlots) : sameMask(this.externalMask, passSlots);
      if (unchanged) return;
      this.externalMask = Uint8Array.from(passSlots);
    }
    // The mask enters every layer's predicate: de-materialize (the hook
    // cannot retro-adjust rows the OLD mask hid), full recompute on demand.
    for (const d of this.dims) {
      this.setFilteredLive(d, false);
      d.filteredDirty = true;
    }
    this.notify();
  }

  /**
   * Immutable summary. The filtered layer is recomputed lazily when dirty
   * O(rows) per dirty summarize (v0.7 tier; see module doc). Returned objects
   * are frozen and never mutated by later operations.
   */
  summarize(key: string): DimensionSummary {
    this.ensureLive();
    const dim = this.dim(key);
    if (dim.filteredDirty) {
      this.recomputeFiltered(dim);
      dim.filteredDirty = false;
      // Materialized: the flip hook keeps it correct from here
      // later summarize calls are O(bins) until a de-materializing event.
      this.setFilteredLive(dim, true);
    }
    const bins: HistogramBin[] = [];
    const categories: CategoryBin[] = [];
    let domain: { min: number; max: number } | undefined;
    if (dim.kind === 'categorical') {
      for (let c = 0; c < dim.codeKeys.length; c++) {
        const catKey = dim.codeKeys[c]!;
        categories.push(
          Object.freeze({
            key: catKey,
            total: dim.codeSlots[c]!.length,
            filtered: dim.filteredCats[c] ?? 0,
            excluded: dim.excludedSet.has(catKey),
          }),
        );
      }
    } else if (dim.hasDomain) {
      domain = Object.freeze({ min: dim.domainMin, max: dim.domainMax });
      const bcount = dim.effectiveBins;
      const span = dim.domainMax - dim.domainMin;
      for (let i = 0; i < bcount; i++) {
        bins.push(
          Object.freeze({
            x0: i === 0 ? dim.domainMin : dim.domainMin + (span * i) / bcount,
            x1: i === bcount - 1 ? dim.domainMax : dim.domainMin + (span * (i + 1)) / bcount,
            total: dim.binTotals[i]!,
            filtered: dim.filteredBins[i] ?? 0,
          }),
        );
      }
    }
    const base = {
      key: dim.key,
      kind: dim.kind as DimensionKind,
      bins: Object.freeze(bins) as readonly HistogramBin[],
      categories: Object.freeze(categories) as readonly CategoryBin[],
      excludedRows: dim.invalidSlots.length,
    };
    return Object.freeze(domain !== undefined ? { ...base, domain } : base);
  }

  /**
   * Incrementally extend columns with new rows: no full
   * rebuild, no full re-argsort — the pre-sorted old permutation merges with
   * the sorted new block. Brushes stay by key and are applied to the NEW slots
   * only; the returned delta covers only new slots. Keeps selectionRevision;
   * notifies when rows were appended.
   */
  appendRows(newNodes: readonly GraphNode<N>[]): BrushDelta {
    this.ensureLive();
    this.ensureBuilt();
    const delta: BrushDelta = { hidden: [], shown: [] };
    const m = newNodes.length;
    if (m === 0) return delta;
    const oldN = this.n;
    const newN = oldN + m;

    const fc = new Uint16Array(newN);
    fc.set(this.failCount);
    this.failCount = fc;
    if (this.externalMask !== null) {
      const em = new Uint8Array(newN).fill(1);
      em.set(this.externalMask);
      this.externalMask = em;
    }
    this.n = newN;

    // De-materialize FIRST: append re-bins/extends columns, and any flip
    // the per-dim append performs must find the hook dormant (liveDims 0)
    // rather than adjusting bins that are about to be rebuilt.
    for (const dim of this.dims) {
      this.setFilteredLive(dim, false);
      dim.filteredDirty = true;
    }
    for (const dim of this.dims) {
      const pass = new Uint8Array(newN).fill(1);
      pass.set(dim.pass);
      dim.pass = pass;
      if (dim.kind === 'categorical') this.appendCat(dim, newNodes, oldN);
      else this.appendRange(dim, newNodes, oldN);
    }

    for (let s = oldN; s < newN; s++) {
      (this.failCount[s] === 0 ? delta.shown : delta.hidden).push(s);
    }
    this.notify();
    return delta;
  }

  /**
   * Full rebuild from a new roster, PRESERVING brushes by dimension key and
   * re-applying them as one combined delta against an all-visible baseline of
   * the new roster (shown is always empty). Clears the external mask. Keeps
   * selectionRevision; notifies once.
   */
  replaceAll(nodes: readonly GraphNode<N>[]): BrushDelta {
    this.ensureLive();
    this.ensureBuilt();
    const saved = this.dims.map((d) => ({ key: d.key, brush: d.brush }));
    this.buildDims(nodes, this.specs);
    const delta: BrushDelta = { hidden: [], shown: [] };
    for (const { key, brush } of saved) {
      if (brush === null) continue;
      const dim = this.byKey.get(key)!;
      const normalized = normalizeBrush(dim.kind, brush);
      if (dim.kind === 'categorical') this.applyCatTransition(dim, normalized, delta);
      else this.applyRangeTransition(dim, normalized.brush as { min: number; max: number }, delta);
      dim.brush = normalized.brush;
    }
    for (const d of this.dims) d.filteredDirty = true;
    this.notify();
    return delta;
  }

  /** Fires once per observable selection/summary change, state consistent. */
  subscribe(cb: () => void): () => void {
    this.ensureLive();
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Idempotent; every other method throws afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
    this.dims = [];
    this.byKey.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private ensureLive(): void {
    if (this.disposed) throw new Error('TypedColumnCrossfilter: disposed');
  }

  private ensureBuilt(): void {
    if (!this.built) throw new Error('TypedColumnCrossfilter: build() has not been called');
  }

  private dim(key: string): DimState<N> {
    this.ensureBuilt();
    const dim = this.byKey.get(key);
    if (dim === undefined) throw new Error(`TypedColumnCrossfilter: unknown dimension "${key}"`);
    return dim;
  }

  private buildDims(nodes: readonly GraphNode<N>[], specs: readonly DimensionSpec<N>[]): void {
    this.liveDims = 0; // fresh dims start non-live (filteredLive: false)
    const seen = new Set<string>();
    const dims: DimState<N>[] = [];
    for (const spec of specs) {
      if (seen.has(spec.key)) {
        throw new TypeError(`TypedColumnCrossfilter: duplicate dimension key "${spec.key}"`);
      }
      seen.add(spec.key);
      dims.push(
        spec.kind === 'categorical' ? this.buildCatDim(spec, nodes) : this.buildRangeDim(spec, nodes),
      );
    }
    this.specs = specs;
    this.dims = dims;
    this.byKey = new Map(dims.map((d) => [d.key, d]));
    this.n = nodes.length;
    this.failCount = new Uint16Array(nodes.length);
    this.externalMask = null;
  }

  private buildRangeDim(spec: DimensionSpec<N>, nodes: readonly GraphNode<N>[]): RangeDim<N> {
    const kind = spec.kind as 'numeric' | 'temporal';
    const n = nodes.length;
    const values = new Float64Array(n);
    const invalidSlots: number[] = [];
    const valid: number[] = [];
    for (let s = 0; s < n; s++) {
      const v = rangeValue(kind, spec.get(nodes[s]!));
      if (v === null) {
        values[s] = NaN;
        invalidSlots.push(s);
      } else {
        values[s] = v;
        valid.push(s);
      }
    }
    // One-time index sort on the typed column (build MAY sort; the
    // brush path never re-sorts).
    valid.sort((a, b) => values[a]! - values[b]! || a - b);
    this.stats.fullSorts++;
    const dim: RangeDim<N> = {
      spec,
      key: spec.key,
      kind,
      values,
      sorted: Uint32Array.from(valid),
      hasDomain: false,
      domainMin: NaN,
      domainMax: NaN,
      binCount: sanitizeBinCount(spec.bins),
      effectiveBins: 0,
      slotBin: new Int32Array(0),
      binTotals: [],
      lo: 0,
      hi: valid.length,
      pass: new Uint8Array(n).fill(1),
      invalidSlots,
      brush: null,
      filteredDirty: true,
      filteredLive: false,
      filteredBins: [],
    };
    this.rebinRange(dim);
    return dim;
  }

  private buildCatDim(spec: DimensionSpec<N>, nodes: readonly GraphNode<N>[]): CatDim<N> {
    const n = nodes.length;
    const codes = new Int32Array(n).fill(-1);
    const codeOf = new Map<string, number>();
    const codeKeys: string[] = [];
    const codeSlots: number[][] = [];
    const invalidSlots: number[] = [];
    for (let s = 0; s < n; s++) {
      const key = categoricalKey(spec.get(nodes[s]!));
      if (key === null) {
        invalidSlots.push(s);
        continue;
      }
      let c = codeOf.get(key);
      if (c === undefined) {
        c = codeKeys.length;
        codeOf.set(key, c);
        codeKeys.push(key);
        codeSlots.push([]);
      }
      codes[s] = c;
      codeSlots[c]!.push(s);
    }
    return {
      spec,
      key: spec.key,
      kind: 'categorical',
      codes,
      codeOf,
      codeKeys,
      codeSlots,
      excludedSet: new Set(),
      pass: new Uint8Array(n).fill(1),
      invalidSlots,
      brush: null,
      filteredDirty: true,
      filteredLive: false,
      filteredCats: [],
    };
  }

  /** Recompute domain, bin edges, per-slot bin index, and totals. Sort-free. */
  private rebinRange(dim: RangeDim<N>): void {
    const len = dim.sorted.length;
    const slotBin = new Int32Array(dim.values.length).fill(-1);
    if (len === 0) {
      dim.hasDomain = false;
      dim.domainMin = NaN;
      dim.domainMax = NaN;
      dim.effectiveBins = 0;
      dim.slotBin = slotBin;
      dim.binTotals = [];
      return;
    }
    const min = dim.values[dim.sorted[0]!]!;
    const max = dim.values[dim.sorted[len - 1]!]!;
    dim.hasDomain = true;
    dim.domainMin = min;
    dim.domainMax = max;
    const bcount = min === max ? 1 : dim.binCount;
    dim.effectiveBins = bcount;
    const totals = new Array<number>(bcount).fill(0);
    const span = max - min;
    for (let i = 0; i < len; i++) {
      const s = dim.sorted[i]!;
      const b = bcount === 1 ? 0 : Math.min(Math.floor(((dim.values[s]! - min) / span) * bcount), bcount - 1);
      slotBin[s] = b;
      totals[b] = totals[b]! + 1;
    }
    dim.slotBin = slotBin;
    dim.binTotals = totals;
  }

  private binIndex(dim: RangeDim<N>, v: number): number {
    if (dim.effectiveBins <= 1) return 0;
    const span = dim.domainMax - dim.domainMin;
    return Math.min(Math.floor(((v - dim.domainMin) / span) * dim.effectiveBins), dim.effectiveBins - 1);
  }

  // --- delta machinery -------------------------------------------------------

  private flip(dim: DimState<N>, slot: number, nowPass: boolean, delta: BrushDelta): void {
    this.stats.slotsWalked++;
    if (nowPass) {
      if (dim.pass[slot] === 1) return;
      dim.pass[slot] = 1;
      const next = this.failCount[slot]! - 1;
      this.failCount[slot] = next;
      if (next === 0) delta.shown.push(slot);
      if (this.liveDims > 0) this.maintainFiltered(dim, slot, next, 1);
    } else {
      if (dim.pass[slot] === 0) return;
      dim.pass[slot] = 0;
      const prev = this.failCount[slot]!;
      this.failCount[slot] = prev + 1;
      if (prev === 0) delta.hidden.push(slot);
      if (this.liveDims > 0) this.maintainFiltered(dim, slot, prev, -1);
    }
  }

  /**
   * inline maintenance of LIVE filtered layers, dispatched from the
   * one place that knows the failCount transition. `boundary` is the
   * other-failures picture at the interesting side of the flip (after for
   * shown, before for hidden):
   * - 0 → the slot crossed the FULLY-VISIBLE boundary: every other live
   * layer counts it (own layers ignore the own-dim brush, so the brushed
   * dim's layer is provably unchanged by its own flip);
   * - 1 → exactly one OTHER dim still fails the slot: only that dim's
   * what-if-I-cleared-mine layer flips;
   * - ≥2 → no layer can change.
   * External-mask-excluded and hygiene-invalid slots contribute nothing
   * either way and are skipped.
   */
  private maintainFiltered(
    brushed: DimState<N>,
    slot: number,
    boundary: number,
    sign: 1 | -1,
  ): void {
    if (boundary > 1) return;
    const ext = this.externalMask;
    if (ext !== null && ext[slot] === 0) return;
    if (boundary === 0) {
      for (const d of this.dims) {
        if (d === brushed || !d.filteredLive) continue;
        this.adjustLayer(d, slot, sign);
      }
      return;
    }
    // Exactly one non-brushed dim fails the slot (failCount invariant).
    for (const d of this.dims) {
      if (d === brushed || d.pass[slot] !== 0) continue;
      if (d.filteredLive) this.adjustLayer(d, slot, sign);
      break;
    }
  }

  private adjustLayer(d: DimState<N>, slot: number, sign: 1 | -1): void {
    if (d.kind === 'categorical') {
      const c = d.codes[slot]!;
      if (c < 0) return;
      d.filteredCats[c] = (d.filteredCats[c] ?? 0) + sign;
    } else {
      const b = d.slotBin[slot]!;
      if (b < 0) return;
      d.filteredBins[b] = (d.filteredBins[b] ?? 0) + sign;
    }
    this.stats.binUpdates += 1;
  }

  private walkSorted(dim: RangeDim<N>, from: number, to: number, nowPass: boolean, delta: BrushDelta): void {
    for (let i = from; i < to; i++) this.flip(dim, dim.sorted[i]!, nowPass, delta);
  }

  private walkList(dim: DimState<N>, slots: readonly number[], nowPass: boolean, delta: BrushDelta): void {
    for (const s of slots) this.flip(dim, s, nowPass, delta);
  }

  private applyRangeTransition(
    dim: RangeDim<N>,
    next: { min: number; max: number } | null,
    delta: BrushDelta,
  ): void {
    const len = dim.sorted.length;
    const prevNull = dim.brush === null;
    if (next === null) {
      // brush → null: the complement of the old window (and hygiene-excluded
      // slots) passes again. O(n − window) — clearing, not the scrub path.
      this.walkSorted(dim, 0, dim.lo, true, delta);
      this.walkSorted(dim, dim.hi, len, true, delta);
      this.walkList(dim, dim.invalidSlots, true, delta);
      dim.lo = 0;
      dim.hi = len;
      return;
    }
    const lo1 = lowerBound(dim.values, dim.sorted, next.min);
    let hi1 = upperBound(dim.values, dim.sorted, next.max);
    if (hi1 < lo1) hi1 = lo1; // inverted brush (min > max) = empty selection
    if (prevNull) {
      this.walkSorted(dim, 0, lo1, false, delta);
      this.walkSorted(dim, hi1, len, false, delta);
      this.walkList(dim, dim.invalidSlots, false, delta);
    } else {
      const lo0 = dim.lo;
      const hi0 = dim.hi;
      // Symmetric difference of [lo0,hi0) and [lo1,hi1): O(Δ), the scrub path.
      this.walkSorted(dim, lo0, Math.min(hi0, lo1), false, delta); // leave (low side)
      this.walkSorted(dim, Math.max(lo0, hi1), hi0, false, delta); // leave (high side)
      this.walkSorted(dim, lo1, Math.min(hi1, lo0), true, delta); // enter (low side)
      this.walkSorted(dim, Math.max(lo1, hi0), hi1, true, delta); // enter (high side)
    }
    dim.lo = lo1;
    dim.hi = hi1;
  }

  private applyCatTransition(dim: CatDim<N>, normalized: NormalizedBrush, delta: BrushDelta): void {
    const prevNull = dim.brush === null;
    const nextNull = normalized.brush === null;
    const prevSet = dim.excludedSet;
    const nextSet = normalized.set;
    for (const key of nextSet) {
      if (prevSet.has(key)) continue;
      const c = dim.codeOf.get(key);
      if (c !== undefined) this.walkList(dim, dim.codeSlots[c]!, false, delta);
    }
    for (const key of prevSet) {
      if (nextSet.has(key)) continue;
      const c = dim.codeOf.get(key);
      if (c !== undefined) this.walkList(dim, dim.codeSlots[c]!, true, delta);
    }
    // Hygiene-excluded slots pass a null brush and fail any non-null brush.
    if (prevNull !== nextNull) this.walkList(dim, dim.invalidSlots, nextNull, delta);
    dim.excludedSet = nextSet;
  }

  // --- append ----------------------------------------------------------------

  private appendRange(dim: RangeDim<N>, newNodes: readonly GraphNode<N>[], oldN: number): void {
    const m = newNodes.length;
    const newN = oldN + m;
    const values = new Float64Array(newN);
    values.set(dim.values);
    const newValid: number[] = [];
    for (let j = 0; j < m; j++) {
      const s = oldN + j;
      const v = rangeValue(dim.kind, dim.spec.get(newNodes[j]!));
      if (v === null) {
        values[s] = NaN;
        dim.invalidSlots.push(s);
      } else {
        values[s] = v;
        newValid.push(s);
      }
    }
    dim.values = values;
    // Sort ONLY the new block, then permutation-merge with the old order.
    newValid.sort((a, b) => values[a]! - values[b]! || a - b);
    const old = dim.sorted;
    const merged = new Uint32Array(old.length + newValid.length);
    let i = 0;
    let j = 0;
    let k = 0;
    while (i < old.length && j < newValid.length) {
      const a = old[i]!;
      const b = newValid[j]!;
      if (values[a]! <= values[b]!) {
        merged[k++] = a;
        i++;
      } else {
        merged[k++] = b;
        j++;
      }
    }
    while (i < old.length) merged[k++] = old[i++]!;
    while (j < newValid.length) merged[k++] = newValid[j++]!;
    dim.sorted = merged;
    this.stats.permutationMerges++;

    // Extend bins; a grown domain forces a re-bin (still sort-free).
    const len = merged.length;
    if (len === 0) {
      this.rebinRange(dim);
    } else {
      const nmin = values[merged[0]!]!;
      const nmax = values[merged[len - 1]!]!;
      if (!dim.hasDomain || nmin !== dim.domainMin || nmax !== dim.domainMax) {
        this.rebinRange(dim);
      } else {
        const slotBin = new Int32Array(newN).fill(-1);
        slotBin.set(dim.slotBin);
        dim.slotBin = slotBin;
        for (const s of newValid) {
          const b = this.binIndex(dim, values[s]!);
          slotBin[s] = b;
          dim.binTotals[b] = dim.binTotals[b]! + 1;
        }
      }
    }

    // Re-apply the preserved brush to NEW slots only.
    const brush = dim.brush;
    if (brush !== null && 'min' in brush) {
      for (let j2 = 0; j2 < m; j2++) {
        const s = oldN + j2;
        const v = values[s]!;
        const passes = v >= brush.min && v <= brush.max; // NaN → false (hygiene fails brush)
        if (!passes) {
          dim.pass[s] = 0;
          this.failCount[s] = this.failCount[s]! + 1;
        }
      }
      // The merged permutation shifted window indices; refresh them.
      dim.lo = lowerBound(values, merged, brush.min);
      dim.hi = Math.max(upperBound(values, merged, brush.max), dim.lo);
    } else {
      dim.lo = 0;
      dim.hi = merged.length;
    }
  }

  private appendCat(dim: CatDim<N>, newNodes: readonly GraphNode<N>[], oldN: number): void {
    const m = newNodes.length;
    const newN = oldN + m;
    const codes = new Int32Array(newN).fill(-1);
    codes.set(dim.codes);
    dim.codes = codes;
    for (let j = 0; j < m; j++) {
      const s = oldN + j;
      const key = categoricalKey(dim.spec.get(newNodes[j]!));
      if (key === null) {
        dim.invalidSlots.push(s);
        continue;
      }
      let c = dim.codeOf.get(key);
      if (c === undefined) {
        c = dim.codeKeys.length;
        dim.codeOf.set(key, c);
        dim.codeKeys.push(key);
        dim.codeSlots.push([]);
      }
      codes[s] = c;
      dim.codeSlots[c]!.push(s);
    }
    if (dim.brush !== null) {
      for (let j2 = 0; j2 < m; j2++) {
        const s = oldN + j2;
        const c = codes[s]!;
        const passes = c >= 0 && !dim.excludedSet.has(dim.codeKeys[c]!);
        if (!passes) {
          dim.pass[s] = 0;
          this.failCount[s] = this.failCount[s]! + 1;
        }
      }
    }
  }

  // --- lazy filtered layer -----------------------------------------------------

  private recomputeFiltered(dim: DimState<N>): void {
    this.stats.filteredRecomputes += 1;
    const ext = this.externalMask;
    const fc = this.failCount;
    if (dim.kind === 'categorical') {
      const counts = new Array<number>(dim.codeKeys.length).fill(0);
      for (let s = 0; s < this.n; s++) {
        const c = dim.codes[s]!;
        if (c < 0) continue;
        // Passes every OTHER dimension: total failures minus own-dim failure.
        if (fc[s]! - (dim.pass[s]! ^ 1) !== 0) continue;
        if (ext !== null && ext[s] === 0) continue;
        counts[c] = counts[c]! + 1;
      }
      dim.filteredCats = counts;
    } else {
      const counts = new Array<number>(dim.effectiveBins).fill(0);
      for (let s = 0; s < this.n; s++) {
        const b = dim.slotBin[s]!;
        if (b < 0) continue;
        if (fc[s]! - (dim.pass[s]! ^ 1) !== 0) continue;
        if (ext !== null && ext[s] === 0) continue;
        counts[b] = counts[b]! + 1;
      }
      dim.filteredBins = counts;
    }
  }

  // --- notification -------------------------------------------------------------

  /** One callback pass per observable change; synchronous re-entrancy coalesces. */
  private notify(): void {
    if (this.notifying) {
      this.renotify = true;
      return;
    }
    this.notifying = true;
    try {
      do {
        this.renotify = false;
        for (const cb of [...this.subscribers]) cb();
      } while (this.renotify && !this.disposed);
    } finally {
      this.notifying = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Brush normalization / equality
// ---------------------------------------------------------------------------

function sanitizeBinCount(bins: number | undefined): number {
  if (bins === undefined) return DEFAULT_BIN_COUNT;
  if (!Number.isInteger(bins) || bins < 1) {
    throw new TypeError(`TypedColumnCrossfilter: bins must be a positive integer (got ${bins})`);
  }
  return bins;
}

function normalizeBrush(kind: DimensionKind, brush: BrushState): NormalizedBrush {
  if (brush === null) return { brush: null, set: new Set() };
  if ('excluded' in brush) {
    if (kind !== 'categorical') {
      throw new TypeError(`TypedColumnCrossfilter: categorical brush on ${kind} dimension`);
    }
    const set = new Set<string>();
    for (const key of brush.excluded) {
      if (typeof key !== 'string') {
        throw new TypeError('TypedColumnCrossfilter: excluded keys must be strings');
      }
      set.add(key);
    }
    return { brush: Object.freeze({ excluded: Object.freeze([...set]) as readonly string[] }), set };
  }
  if (kind === 'categorical') {
    throw new TypeError('TypedColumnCrossfilter: range brush on categorical dimension');
  }
  if (!Number.isFinite(brush.min) || !Number.isFinite(brush.max)) {
    throw new TypeError('TypedColumnCrossfilter: brush min/max must be finite numbers');
  }
  return { brush: Object.freeze({ min: brush.min, max: brush.max }), set: new Set() };
}

function brushEquals<N>(dim: DimState<N>, next: NormalizedBrush): boolean {
  const prev = dim.brush;
  if (prev === null || next.brush === null) return prev === next.brush;
  if ('min' in prev) {
    return 'min' in next.brush && prev.min === next.brush.min && prev.max === next.brush.max;
  }
  // categorical: order-insensitive set equality
  if (dim.kind !== 'categorical') return false;
  const prevSet = dim.excludedSet;
  if (prevSet.size !== next.set.size) return false;
  for (const key of next.set) if (!prevSet.has(key)) return false;
  return true;
}

function sameMask(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if ((a[i]! === 0) !== (b[i]! === 0)) return false;
  }
  return true;
}

function allOnes(mask: Uint8Array): boolean {
  for (let i = 0; i < mask.length; i++) if (mask[i] === 0) return false;
  return true;
}
