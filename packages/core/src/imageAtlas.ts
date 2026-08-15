/**
 * image-atlas pipeline — pure core side.
 *
 * Turns per-point image refs (stable strings from the synchronous `nodeImage`
 * accessor) into engine-ready atlas resources: resolved ImageBitmaps with
 * slot assignments plus an index-aligned per-point slot buffer. The engine
 * only ever sees the output shape (`EngineCommit.resources`); everything
 * async — resolve, fetch, decode, retry, abort — stays here.
 *
 * Invariants:
 * - Loads are deduplicated by ref: one in-flight resolve per unique ref.
 * - Slots are allocated per unique ref from a free-list capped at
 * `maxEntries`; over-cap refs stay placeholder and are diagnosed once per
 * generation.
 * - Results are admission-checked against the current request state before
 * atlas admission; the abort signal is an optimization, admission is the
 * gate (a resolver that ignores its signal cannot poison a newer
 * generation).
 * - Transient resolver/fetch failures retry up to `maxRetries`; decode
 * failures are final.
 * - Failures are cadence-batched: ONE `image-resolve-failed` diagnostic per
 * flush with a count and sampled refs, each ref counted once per
 * generation. Failures never poison the engine commit.
 * - A resolver-returned string is a final URL/data URI fetched + decoded
 * exactly once — never recursively passed back to the resolver.
 */

import { DIAGNOSTIC_SAMPLE_CAP } from './types';
import type { GraphDiagnostic } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Owns authenticated fetch / caching / redirect handling for one ref
 * under the public resolver contract. Returning a Blob hands the bytes straight to
 * decode; returning a string names a FINAL URL or data URI that the pipeline
 * fetches + decodes once (it is never re-resolved).
 */
export type ImageResolver = (ref: string, signal: AbortSignal) => Promise<Blob | string>;

/** Minimal structural slice of `fetch` the pipeline needs (Node-test injectable). */
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; blob(): Promise<Blob> }>;

/** Blob → ImageBitmap. Injectable so Node tests never touch createImageBitmap. */
export type ImageDecode = (blob: Blob) => Promise<ImageBitmap>;

/** D5: `close` may throw on already-detached bitmaps in exotic runtimes
 * ownership hygiene must never take down the pipeline. */
function closeBitmapQuietly(bitmap: ImageBitmap): void {
  try {
    bitmap.close();
  } catch {
    // Already closed/detached — the goal (released native memory) is met.
  }
}

/** One coalesced flush of atlas work — mirrors `EngineCommit.resources`. */
export interface ImageAtlasBatch {
  /** Newly resolved bitmaps with their slot assignments. */
  upserts: readonly { slot: number; bitmap: ImageBitmap }[];
  /** Slots freed by eviction that the engine previously received. */
  removeSlots: readonly number[];
  /** Per-point atlas slot indices, aligned to the last requestRefs call
   * (-1 = placeholder shape). */
  pointImageIndex: Float32Array;
  /** At most one batched `image-resolve-failed` diagnostic per flush. */
  diagnostics: readonly GraphDiagnostic[];
}

export interface ImageAtlasPipelineOptions {
  /** Ref → bytes. Default: plain `fetch(ref)` → blob for public URLs. */
  resolver?: ImageResolver;
  /** Concurrent resolve bound. Default 4. */
  maxConcurrent?: number;
  /** Transient-failure retries per ref lifecycle (decode failures are final).
   * Default 2 (three attempts total). */
  maxRetries?: number;
  /** Atlas slot capacity; refs beyond it stay placeholder. Default 512. */
  maxEntries?: number;
  /** Blob → ImageBitmap. Default `createImageBitmap`. */
  decode?: ImageDecode;
  /** Fetch used by the default resolver AND for resolver-returned strings. */
  fetchImpl?: FetchLike;
  /** Batch scheduler: called with a flush thunk when work is pending; each
   * scheduled thunk must run at most once. Default: queueMicrotask. */
  schedule?: (flush: () => void) => void;
}

export const ATLAS_MAX_CONCURRENT_DEFAULT = 4;
export const ATLAS_MAX_RETRIES_DEFAULT = 2;
export const ATLAS_MAX_ENTRIES_DEFAULT = 512;

// ---------------------------------------------------------------------------
// Internal entry state
// ---------------------------------------------------------------------------

type EntryStatus = 'pending' | 'resolving' | 'resolved' | 'failed';

interface AtlasEntry {
  readonly ref: string;
  readonly slot: number;
  status: EntryStatus;
  bitmap: ImageBitmap | null;
  /** Attempts started (1 = initial attempt). */
  attempts: number;
  controller: AbortController | null;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class ImageAtlasPipeline {
  private readonly resolver: ImageResolver;
  private readonly maxConcurrent: number;
  private readonly maxRetries: number;
  private readonly maxEntries: number;
  private readonly decode: ImageDecode;
  private readonly fetchImpl: FetchLike;
  private readonly schedule: (flush: () => void) => void;

  /** ref → live entry. Identity of the mapped entry is the admission gate. */
  private readonly entries = new Map<string, AtlasEntry>();
  private readonly freeSlots: number[] = [];
  private nextSlot = 0;

  private readonly queue: AtlasEntry[] = [];
  private active = 0;

  /** Slots the engine has received via a flushed upsert. */
  private readonly deliveredSlots = new Set<number>();
  private readonly pendingUpserts = new Map<number, ImageBitmap>();
  private readonly pendingRemoveSlots = new Set<number>();
  /** Failed refs awaiting the next flush's single batched diagnostic. */
  private pendingFailureRefs: string[] = [];
  /** ref → generation it was last counted in (once-per-generation gate). */
  private readonly countedFailures = new Map<string, number>();

  private lastRefs: readonly (string | null)[] = [];
  private generation: number | null = null;
  private flushScheduled = false;
  private disposed = false;
  /** Evicted-entry bitmaps awaiting close — closed AFTER the
   * flush that carries their removeSlots, so the instance's recovery-replay
   * map (pruned synchronously in the batch callback) can never re-send a
   * closed bitmap. */
  private pendingCloseBitmaps: ImageBitmap[] = [];

  private readonly batchCallbacks = new Set<(batch: ImageAtlasBatch) => void>();

  constructor(options: ImageAtlasPipelineOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? ATLAS_MAX_CONCURRENT_DEFAULT;
    this.maxRetries = options.maxRetries ?? ATLAS_MAX_RETRIES_DEFAULT;
    this.maxEntries = options.maxEntries ?? ATLAS_MAX_ENTRIES_DEFAULT;
    // globalThis lookup, not the bare global: core stays module-scope
    // network-free; browser hosts get fetch at call time
    // and non-browser hosts inject fetchImpl/resolver.
    this.fetchImpl =
      options.fetchImpl ?? ((url, init) => (globalThis as { fetch: typeof fetch }).fetch(url, init));
    this.resolver = options.resolver ?? (async (ref, signal) => this.fetchBlob(ref, signal));
    this.decode = options.decode ?? ((blob) => createImageBitmap(blob));
    this.schedule = options.schedule ?? ((flush) => queueMicrotask(flush));
  }

  /** Subscribe to coalesced flushes. Returns an unsubscribe thunk. */
  onBatch(cb: (batch: ImageAtlasBatch) => void): () => void {
    this.batchCallbacks.add(cb);
    return () => {
      this.batchCallbacks.delete(cb);
    };
  }

  /**
   * Declare the full index-aligned per-point ref list for `generation`.
   * Refs that drop out are evicted (slot freed → removeSlots); new unique
   * refs are resolved once each; calls with a stale (lower) generation are
   * discarded.
   */
  requestRefs(refs: readonly (string | null)[], generation: number): void {
    if (this.disposed) return;
    if (this.generation !== null && generation < this.generation) return;
    this.generation = generation;
    this.lastRefs = refs;

    const wanted = new Set<string>();
    for (const ref of refs) if (ref !== null) wanted.add(ref);

    // Evict entries whose refs dropped out of this request.
    for (const [ref, entry] of this.entries) {
      if (!wanted.has(ref)) this.evict(ref, entry);
    }

    // Admit new unique refs (first-appearance order) while capacity remains.
    for (const ref of wanted) {
      if (this.entries.has(ref)) continue;
      const slot = this.allocSlot();
      if (slot === -1) {
        // Over cap: stays placeholder; diagnosed once per generation.
        this.recordFailure(ref);
        continue;
      }
      const entry: AtlasEntry = {
        ref,
        slot,
        status: 'pending',
        bitmap: null,
        attempts: 0,
        controller: null,
      };
      this.entries.set(ref, entry);
      this.queue.push(entry);
    }

    this.pump();
    // Always flush: the point→slot mapping may have changed even with zero
    // resolve traffic (e.g. reordered points over already-resolved refs).
    this.scheduleFlush();
  }

  /** Abort all in-flight work and drop all state. Terminal. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      entry.controller?.abort();
      // D5: dataset reset / destroy closes every owned bitmap (the instance
      // clears its replay map in the same synchronous teardown).
      if (entry.bitmap !== null) {
        closeBitmapQuietly(entry.bitmap);
        entry.bitmap = null;
      }
    }
    for (const bmp of this.pendingCloseBitmaps) closeBitmapQuietly(bmp);
    this.pendingCloseBitmaps = [];
    this.entries.clear();
    this.queue.length = 0;
    this.pendingUpserts.clear();
    this.pendingRemoveSlots.clear();
    this.pendingFailureRefs = [];
    this.countedFailures.clear();
    this.deliveredSlots.clear();
    this.batchCallbacks.clear();
  }

  // -------------------------------------------------------------------------
  // Slots
  // -------------------------------------------------------------------------

  private allocSlot(): number {
    const reused = this.freeSlots.pop();
    if (reused !== undefined) return reused;
    if (this.nextSlot < this.maxEntries) return this.nextSlot++;
    return -1;
  }

  private evict(ref: string, entry: AtlasEntry): void {
    entry.controller?.abort();
    this.entries.delete(ref);
    this.freeSlots.push(entry.slot);
    // An undelivered pending upsert is simply cancelled; a delivered slot
    // must be removed engine-side.
    this.pendingUpserts.delete(entry.slot);
    if (this.deliveredSlots.has(entry.slot)) {
      this.deliveredSlots.delete(entry.slot);
      this.pendingRemoveSlots.add(entry.slot);
    }
    // D5: core owns decoded bitmaps — an evicted entry's bitmap closes at
    // the next flush (exactly once; the null-out is the double-close guard).
    if (entry.bitmap !== null) {
      this.pendingCloseBitmaps.push(entry.bitmap);
      entry.bitmap = null;
      this.scheduleFlush();
    }
  }

  // -------------------------------------------------------------------------
  // Resolve machinery
  // -------------------------------------------------------------------------

  /** Admission gate: entry must still be the live entry for its ref. */
  private isCurrent(entry: AtlasEntry): boolean {
    return !this.disposed && this.entries.get(entry.ref) === entry;
  }

  private pump(): void {
    while (this.active < this.maxConcurrent) {
      const entry = this.queue.shift();
      if (entry === undefined) return;
      // Evicted (or superseded) while queued.
      if (!this.isCurrent(entry) || entry.status !== 'pending') continue;
      this.active++;
      entry.status = 'resolving';
      void this.runAttempt(entry).then(() => {
        this.active--;
        this.pump();
      });
    }
  }

  /** One attempt: resolve → (fetch if string) → decode. Never throws. */
  private async runAttempt(entry: AtlasEntry): Promise<void> {
    const controller = new AbortController();
    entry.controller = controller;
    entry.attempts++;

    let blob: Blob;
    try {
      const result = await this.resolver(entry.ref, controller.signal);
      // A string result is a FINAL URL/data URI: fetched + decoded once,
      // never recursively resolved.
      blob = typeof result === 'string' ? await this.fetchBlob(result, controller.signal) : result;
    } catch {
      if (!this.isCurrent(entry)) return; // evicted/disposed — silent discard
      entry.controller = null;
      if (entry.attempts <= this.maxRetries) {
        // Transient: retry through the same queue; dedupe holds because the
        // entry identity is unchanged.
        entry.status = 'pending';
        this.queue.push(entry);
        // pump runs from the settle continuation.
      } else {
        this.finalFailure(entry);
      }
      return;
    }

    if (!this.isCurrent(entry)) return; // admission gate before decode

    let bitmap: ImageBitmap;
    try {
      bitmap = await this.decode(blob);
    } catch {
      if (!this.isCurrent(entry)) return;
      entry.controller = null;
      // Decode/MIME/size failures are final — the bytes will not improve.
      this.finalFailure(entry);
      return;
    }

    if (!this.isCurrent(entry)) {
      // D5: the entry was evicted while decoding — nobody will ever see
      // this bitmap; close it immediately (it was never delivered).
      closeBitmapQuietly(bitmap);
      return;
    }
    entry.status = 'resolved';
    entry.bitmap = bitmap;
    entry.controller = null;
    this.pendingUpserts.set(entry.slot, bitmap);
    // An upsert overwrites the slot content; never emit the same slot in
    // both lists of one batch.
    this.pendingRemoveSlots.delete(entry.slot);
    this.scheduleFlush();
  }

  private async fetchBlob(url: string, signal: AbortSignal): Promise<Blob> {
    const res = await this.fetchImpl(url, { signal });
    if (!res.ok) throw new Error(`image fetch failed (HTTP ${res.status}) for ${url}`);
    return res.blob();
  }

  private finalFailure(entry: AtlasEntry): void {
    entry.status = 'failed';
    this.recordFailure(entry.ref);
  }

  /** Queue a ref for the next flush's single diagnostic, once per generation. */
  private recordFailure(ref: string): void {
    const gen = this.generation ?? 0;
    if (this.countedFailures.get(ref) === gen) return;
    this.countedFailures.set(ref, gen);
    this.pendingFailureRefs.push(ref);
    this.scheduleFlush();
  }

  // -------------------------------------------------------------------------
  // Flush
  // -------------------------------------------------------------------------

  private scheduleFlush(): void {
    if (this.flushScheduled || this.disposed) return;
    this.flushScheduled = true;
    this.schedule(() => this.flush());
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.disposed) return;

    const upserts: { slot: number; bitmap: ImageBitmap }[] = [];
    for (const [slot, bitmap] of this.pendingUpserts) {
      upserts.push({ slot, bitmap });
      this.deliveredSlots.add(slot);
    }
    this.pendingUpserts.clear();

    const removeSlots = [...this.pendingRemoveSlots];
    this.pendingRemoveSlots.clear();

    const failures = this.pendingFailureRefs;
    this.pendingFailureRefs = [];
    const diagnostics: GraphDiagnostic[] =
      failures.length > 0
        ? [
            {
              code: 'image-resolve-failed',
              severity: 'warning',
              count: failures.length,
              sampleIds: failures.slice(0, DIAGNOSTIC_SAMPLE_CAP),
              message:
                `${failures.length} image ref(s) failed to resolve/decode or exceeded ` +
                `atlas capacity (${this.maxEntries}); placeholder retained.`,
            },
          ]
        : [];

    const pointImageIndex = this.buildPointIndex();
    const batch: ImageAtlasBatch = { upserts, removeSlots, pointImageIndex, diagnostics };
    for (const cb of this.batchCallbacks) cb(batch);
    // D5: the batch above delivered the removeSlots; the instance pruned its
    // replay references synchronously in the callback — the evicted bitmaps
    // are now unreachable and close exactly once.
    if (this.pendingCloseBitmaps.length > 0) {
      for (const bmp of this.pendingCloseBitmaps) closeBitmapQuietly(bmp);
      this.pendingCloseBitmaps = [];
    }
  }

  /** -1 (placeholder) until the ref's bitmap is delivered or in this batch. */
  private buildPointIndex(): Float32Array {
    const refs = this.lastRefs;
    const index = new Float32Array(refs.length).fill(-1);
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      if (ref === null || ref === undefined) continue;
      const entry = this.entries.get(ref);
      if (entry !== undefined && entry.bitmap !== null) index[i] = entry.slot;
    }
    return index;
  }

  /**
   * Roster-atomic resource mappings: the SYNCHRONOUS point→slot
   * mapping for the last requested roster — a slot appears only when its ref
   * is resolved AND the engine has already received the bitmap (delivered);
   * pending, failed, evicted, and reused-but-undelivered refs are the −1
   * placeholder. The instance pairs every STRUCTURAL commit with this index
   * in the same commit, so the engine never renders a new roster against the
   * previous roster's (wrong-length, stale-slot) mapping; the scheduled
   * async flush then only ever PROMOTES placeholders to resolved slots.
   */
  currentPointIndex(): Float32Array | null {
    if (this.disposed || this.lastRefs.length === 0) return null;
    const refs = this.lastRefs;
    const index = new Float32Array(refs.length).fill(-1);
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      if (ref === null || ref === undefined) continue;
      const entry = this.entries.get(ref);
      if (
        entry !== undefined &&
        entry.bitmap !== null &&
        this.deliveredSlots.has(entry.slot)
      ) {
        index[i] = entry.slot;
      }
    }
    return index;
  }
}
