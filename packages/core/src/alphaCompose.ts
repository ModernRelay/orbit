/**
 * wave 4 — allocation-free incremental alpha composition for the
 * brush fast path.
 *
 * The naive composers (`composeNodeAlphaBuffer`/`composeEdgeAlphaBuffer`)
 * allocate a fresh `Float32Array(base)` copy and walk every slot per call
 * at the L tier that is ~5.6 MB of allocation and two full passes per
 * pointer move, and the GC tail of that allocation rate is what dominates
 * the frame p95. This composer keeps a ping-pong PAIR of persistent
 * buffers and rewrites only CHANGED slots:
 *
 * - `note(slots)` records a drain's changed slots into BOTH buffers' stale
 * lists (each buffer must eventually replay every change);
 * - `nextBuffer(...)` replays the TARGET buffer's stale list (O(Δ),
 * amortized 2×Δ writes per drain across the pair), swaps, and returns
 * it — so two CONSECUTIVE commits always carry DISTINCT array
 * instances, keeping FakeEngine's reference-recording truthful at
 * distance 1. Buffers alias at distance ≥2 by design (documented; no
 * engine holds a commit buffer past its synchronous apply, and no
 * existing suite compares buffer contents across two intervening
 * commits).
 *
 * Invalidation is PULL-based: `ensureSeeded` compares a seed key — the base
 * buffer REFERENCE, slot count, dim alpha, and an opaque `extraEpoch`
 * (edge lane: the active path-emphasis object) — and reseeds both buffers
 * with one full masked pass when anything moved. Callers never have to
 * remember to invalidate: theme changes swap `mutedAlpha`, projections
 * swap the base reference, scene rebuilds change the count, path
 * set/clear changes the epoch, and each forces the reseed on next use.
 */

export class IncrementalAlphaComposer {
  private bufA: Float32Array | null = null;
  private bufB: Float32Array | null = null;
  private readonly staleA: number[] = [];
  private readonly staleB: number[] = [];
  /** Which buffer the NEXT nextBuffer call returns (0 = A, 1 = B). */
  private next: 0 | 1 = 0;

  // --- seed key ---
  private seededBase: Float32Array | null = null;
  private seededCount = -1;
  private seededDimAlpha = NaN;
  private seededEpoch: unknown = undefined;

  /** Slots rewritten since the last resetStats (wave-5 gate instrument). */
  slotsRewritten = 0;
  /** Full reseeds performed (each is one O(n) masked pass over the pair). */
  reseeds = 0;

  resetStats(): void {
    this.slotsRewritten = 0;
    this.reseeds = 0;
  }

  /**
   * True when the composer is seeded for exactly this (base, count,
   * dimAlpha, extraEpoch) tuple; otherwise both buffers are rebuilt with a
   * full masked pass and the stale lists reset. Object.is on the alpha
   * handles the NaN sentinel.
   */
  ensureSeeded(
    base: Float32Array,
    count: number,
    dimAlpha: number,
    extraEpoch: unknown,
    alphaOf: (slot: number) => number,
  ): boolean {
    if (
      this.seededBase === base &&
      this.seededCount === count &&
      Object.is(this.seededDimAlpha, dimAlpha) &&
      this.seededEpoch === extraEpoch &&
      this.bufA !== null &&
      this.bufB !== null
    ) {
      return true;
    }
    this.reseeds += 1;
    this.bufA = this.seedOne(base, count, alphaOf, this.bufA);
    this.bufB = this.seedOne(base, count, alphaOf, this.bufB);
    this.staleA.length = 0;
    this.staleB.length = 0;
    this.seededBase = base;
    this.seededCount = count;
    this.seededDimAlpha = dimAlpha;
    this.seededEpoch = extraEpoch;
    return false;
  }

  /** Record changed slots from one mask drain (call once per drain — the
   * drain arrays are reused by the mask, so this copies them out). */
  note(slots: readonly number[]): void {
    for (let i = 0; i < slots.length; i += 1) {
      this.staleA.push(slots[i]!);
      this.staleB.push(slots[i]!);
    }
  }

  /**
   * Replay the target buffer's stale slots against the CURRENT mask state,
   * swap, and return it. Same output semantics as the naive composer: the
   * base RGB is untouched, alpha = base alpha × alphaOf(slot).
   */
  nextBuffer(base: Float32Array, alphaOf: (slot: number) => number): Float32Array {
    const useA = this.next === 0;
    const buf = (useA ? this.bufA : this.bufB)!;
    const stale = useA ? this.staleA : this.staleB;
    for (let i = 0; i < stale.length; i += 1) {
      const slot = stale[i]!;
      buf[4 * slot + 3] = base[4 * slot + 3]! * alphaOf(slot);
      this.slotsRewritten += 1;
    }
    stale.length = 0;
    this.next = useA ? 1 : 0;
    return buf;
  }

  /** Drop the buffers entirely (scene teardown). */
  reset(): void {
    this.bufA = null;
    this.bufB = null;
    this.staleA.length = 0;
    this.staleB.length = 0;
    this.seededBase = null;
    this.seededCount = -1;
    this.seededDimAlpha = NaN;
    this.seededEpoch = undefined;
    this.next = 0;
  }

  private seedOne(
    base: Float32Array,
    count: number,
    alphaOf: (slot: number) => number,
    reuse: Float32Array | null,
  ): Float32Array {
    const out = reuse !== null && reuse.length === base.length ? reuse : new Float32Array(base.length);
    out.set(base);
    for (let i = 0; i < count; i += 1) {
      const a = alphaOf(i);
      if (a !== 1) out[4 * i + 3] = base[4 * i + 3]! * a;
    }
    return out;
  }
}
