/**
 * image-atlas pipeline: dedupe, slot stability, generation
 * gating, retries, capacity, eviction, failure batching, string resolver
 * results, dispose. Fake resolver/decode/fetch + manual batch scheduler
 * no DOM, no network.
 */

import { describe, expect, it } from 'vitest';
import {
  ATLAS_MAX_CONCURRENT_DEFAULT,
  ATLAS_MAX_ENTRIES_DEFAULT,
  ATLAS_MAX_RETRIES_DEFAULT,
  ImageAtlasPipeline,
} from '../src/imageAtlas';
import type { FetchLike, ImageAtlasBatch, ImageAtlasPipelineOptions } from '../src/imageAtlas';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Drain the microtask/promise chain (setTimeout runs after all microtasks). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeBlob(tag: string): Blob {
  return new Blob([tag]);
}

/** Structural fake — the pipeline never inspects bitmaps, only forwards them. */
function makeBitmap(tag: string): ImageBitmap {
  return { width: 1, height: 1, close() {}, __tag: tag } as unknown as ImageBitmap;
}

/** D5 close-spy: counts close calls per bitmap tag. */
function closeSpyDecode() {
  const closes = new Map<string, number>();
  const decode = async (blob: Blob): Promise<ImageBitmap> => {
    const tag = await blob.text();
    const bmp = {
      width: 1,
      height: 1,
      __tag: tag,
      close() {
        closes.set(tag, (closes.get(tag) ?? 0) + 1);
      },
    } as unknown as ImageBitmap;
    return bmp;
  };
  return { decode, closes };
}

function bitmapTag(bitmap: ImageBitmap): string {
  return (bitmap as unknown as { __tag: string }).__tag;
}

/** Manual batch scheduler: flush thunks run only when the test says so. */
function manualScheduler() {
  const queue: (() => void)[] = [];
  return {
    schedule: (fn: () => void) => {
      queue.push(fn);
    },
    run: () => {
      for (const fn of queue.splice(0)) fn();
    },
  };
}

/** Blob-content-tagged decode so upserted bitmaps are traceable to bytes. */
async function fakeDecode(blob: Blob): Promise<ImageBitmap> {
  return makeBitmap(await blob.text());
}

interface Harness {
  pipeline: ImageAtlasPipeline;
  batches: ImageAtlasBatch[];
  run: () => void;
  /** Resolver call log (refs, in call order). */
  resolverCalls: string[];
  /** Latest AbortSignal handed to the resolver, per ref. */
  signals: Map<string, AbortSignal>;
}

/**
 * Pipeline wired to a fake resolver that resolves `blob(ref)` immediately
 * unless the test overrides `resolver` (deferred/failing variants).
 */
function makeHarness(options: Partial<ImageAtlasPipelineOptions> = {}): Harness {
  const sched = manualScheduler();
  const resolverCalls: string[] = [];
  const signals = new Map<string, AbortSignal>();
  const base: ImageAtlasPipelineOptions = {
    resolver: async (ref, signal) => {
      resolverCalls.push(ref);
      signals.set(ref, signal);
      return makeBlob(ref);
    },
    decode: fakeDecode,
    schedule: sched.schedule,
    ...options,
  };
  // Wrap an override resolver so calls/signals are always logged.
  if (options.resolver) {
    const inner = options.resolver;
    base.resolver = (ref, signal) => {
      resolverCalls.push(ref);
      signals.set(ref, signal);
      return inner(ref, signal);
    };
  }
  const pipeline = new ImageAtlasPipeline(base);
  const batches: ImageAtlasBatch[] = [];
  pipeline.onBatch((b) => batches.push(b));
  return { pipeline, batches, run: sched.run, resolverCalls, signals };
}

/** slot assigned to `ref` in the latest batch, via pointImageIndex + refs. */
function slotOf(batch: ImageAtlasBatch, refs: readonly (string | null)[], ref: string): number {
  const i = refs.indexOf(ref);
  expect(i).toBeGreaterThanOrEqual(0);
  const slot = batch.pointImageIndex[i];
  expect(slot).toBeDefined();
  return slot as number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImageAtlasPipeline', () => {
  it('exports spec defaults', () => {
    expect(ATLAS_MAX_CONCURRENT_DEFAULT).toBe(4);
    expect(ATLAS_MAX_RETRIES_DEFAULT).toBe(2);
    expect(ATLAS_MAX_ENTRIES_DEFAULT).toBe(512);
  });

  it('dedupes: 100 points over 3 unique refs -> 3 resolver calls', async () => {
    const h = makeHarness();
    const pool = ['a', 'b', 'c'] as const;
    const refs: (string | null)[] = [];
    for (let i = 0; i < 100; i++) refs.push(i === 0 ? null : (pool[i % 3] as string));
    h.pipeline.requestRefs(refs, 1);
    await tick();
    h.run();

    expect(h.resolverCalls.length).toBe(3);
    expect([...h.resolverCalls].sort()).toEqual(['a', 'b', 'c']);

    const batch = h.batches.at(-1)!;
    expect(batch.upserts.length).toBe(3);
    expect(batch.removeSlots).toEqual([]);
    expect(batch.diagnostics).toEqual([]);
    expect(batch.pointImageIndex.length).toBe(100);
    expect(batch.pointImageIndex[0]).toBe(-1); // null ref = placeholder
    // Every non-null point maps to the slot upserted for its ref's bitmap.
    const slotByTag = new Map(batch.upserts.map((u) => [bitmapTag(u.bitmap), u.slot]));
    for (let i = 1; i < 100; i++) {
      expect(batch.pointImageIndex[i]).toBe(slotByTag.get(refs[i] as string));
    }
  });

  it('keeps slots stable across generations without re-resolving', async () => {
    const h = makeHarness();
    const gen1 = ['a', 'b', 'c'];
    h.pipeline.requestRefs(gen1, 1);
    await tick();
    h.run();
    const first = h.batches.at(-1)!;
    const slots1 = { a: slotOf(first, gen1, 'a'), b: slotOf(first, gen1, 'b'), c: slotOf(first, gen1, 'c') };

    const gen2 = ['c', 'a', 'b', 'a']; // reordered + duplicated
    h.pipeline.requestRefs(gen2, 2);
    await tick();
    h.run();
    const second = h.batches.at(-1)!;

    expect(h.resolverCalls.length).toBe(3); // no new resolves
    expect(second.upserts).toEqual([]); // nothing new to deliver
    expect(second.removeSlots).toEqual([]);
    expect(slotOf(second, gen2, 'a')).toBe(slots1.a);
    expect(slotOf(second, gen2, 'b')).toBe(slots1.b);
    expect(slotOf(second, gen2, 'c')).toBe(slots1.c);
    expect(second.pointImageIndex[3]).toBe(slots1.a); // duplicate point, same slot
  });

  it('generation gating: late result from an abort-ignoring resolver is not admitted', async () => {
    const holds = new Map<string, Deferred<Blob | string>>();
    const h = makeHarness({
      resolver: (ref) => {
        // Ignores the abort signal entirely.
        const d = deferred<Blob | string>();
        holds.set(ref, d);
        return d.promise;
      },
    });

    h.pipeline.requestRefs(['a'], 1);
    await tick();
    h.pipeline.requestRefs(['b'], 2); // 'a' dropped
    expect(h.signals.get('a')!.aborted).toBe(true); // abort attempted (optimization)

    holds.get('a')!.resolve(makeBlob('a')); // lands anyway, post-eviction
    await tick();
    h.run();
    for (const b of h.batches) expect(b.upserts).toEqual([]); // admission is the gate
    const gated = h.batches.at(-1)!;
    expect(gated.pointImageIndex[0]).toBe(-1); // 'b' still unresolved
    expect(gated.removeSlots).toEqual([]); // 'a' was never delivered

    holds.get('b')!.resolve(makeBlob('b'));
    await tick();
    h.run();
    const admitted = h.batches.at(-1)!;
    expect(admitted.upserts.length).toBe(1);
    expect(bitmapTag(admitted.upserts[0]!.bitmap)).toBe('b');
    expect(admitted.upserts[0]!.slot).toBe(0); // freed slot reused
  });

  it('discards a requestRefs call with a stale generation', async () => {
    const h = makeHarness();
    h.pipeline.requestRefs(['a'], 5);
    h.pipeline.requestRefs(['z'], 4); // stale: discarded entirely
    await tick();
    h.run();
    expect(h.resolverCalls).toEqual(['a']);
    expect(h.batches.at(-1)!.pointImageIndex.length).toBe(1);
  });

  it('retries transient resolver failures up to maxRetries with dedupe held', async () => {
    let failures = 0;
    const h = makeHarness({
      maxRetries: 2,
      resolver: async (ref) => {
        if (failures < 2) {
          failures++;
          throw new Error('transient');
        }
        return makeBlob(ref);
      },
    });
    h.pipeline.requestRefs(['a', 'a', 'a'], 1);
    await tick();
    h.run();

    expect(h.resolverCalls).toEqual(['a', 'a', 'a']); // 1 initial + 2 retries
    const batch = h.batches.at(-1)!;
    expect(batch.upserts.length).toBe(1);
    expect(bitmapTag(batch.upserts[0]!.bitmap)).toBe('a');
    expect(batch.diagnostics).toEqual([]);
    expect(batch.pointImageIndex).toEqual(new Float32Array([0, 0, 0]));
  });

  it('exhausted retries emit one failure diagnostic', async () => {
    const h = makeHarness({
      maxRetries: 1,
      resolver: async () => {
        throw new Error('always down');
      },
    });
    h.pipeline.requestRefs(['a'], 1);
    await tick();
    h.run();

    expect(h.resolverCalls).toEqual(['a', 'a']);
    const batch = h.batches.at(-1)!;
    expect(batch.upserts).toEqual([]);
    expect(batch.diagnostics.length).toBe(1);
    expect(batch.diagnostics[0]!.code).toBe('image-resolve-failed');
    expect(batch.diagnostics[0]!.count).toBe(1);
    expect(batch.pointImageIndex[0]).toBe(-1);
  });

  it('does not retry decode failures', async () => {
    const h = makeHarness({
      maxRetries: 2,
      decode: async () => {
        throw new Error('bad MIME');
      },
    });
    h.pipeline.requestRefs(['a'], 1);
    await tick();
    h.run();

    expect(h.resolverCalls).toEqual(['a']); // decode failure is final: no retry
    const batch = h.batches.at(-1)!;
    expect(batch.upserts).toEqual([]);
    expect(batch.diagnostics.length).toBe(1);
    expect(batch.diagnostics[0]!.code).toBe('image-resolve-failed');
    expect(batch.diagnostics[0]!.sampleIds).toEqual(['a']);
    expect(batch.pointImageIndex[0]).toBe(-1);
  });

  it('caps slots at maxEntries: overflow refs stay placeholder with one diagnostic', async () => {
    const h = makeHarness({ maxEntries: 2 });
    const refs = ['a', 'b', 'c'];
    h.pipeline.requestRefs(refs, 1);
    await tick();
    h.run();

    expect(h.resolverCalls.length).toBe(2); // 'c' never resolved
    expect(h.resolverCalls).not.toContain('c');
    const batch = h.batches.at(-1)!;
    expect(batch.upserts.length).toBe(2);
    expect(batch.diagnostics.length).toBe(1);
    expect(batch.diagnostics[0]!.code).toBe('image-resolve-failed');
    expect(batch.diagnostics[0]!.count).toBe(1);
    expect(batch.diagnostics[0]!.sampleIds).toEqual(['c']);
    expect(batch.pointImageIndex[2]).toBe(-1);
    expect(batch.pointImageIndex[0]).not.toBe(-1);
    expect(batch.pointImageIndex[1]).not.toBe(-1);
  });

  it('eviction emits removeSlots and frees slots for reuse', async () => {
    const h = makeHarness();
    h.pipeline.requestRefs(['a', 'b'], 1);
    await tick();
    h.run();
    const first = h.batches.at(-1)!;
    const slotA = slotOf(first, ['a', 'b'], 'a');
    expect(first.upserts.length).toBe(2);

    h.pipeline.requestRefs(['b'], 2); // 'a' evicted after delivery
    await tick();
    h.run();
    const second = h.batches.at(-1)!;
    expect(second.removeSlots).toEqual([slotA]);
    expect(second.upserts).toEqual([]);

    h.pipeline.requestRefs(['b', 'c'], 3); // 'c' reuses the freed slot
    await tick();
    h.run();
    const third = h.batches.at(-1)!;
    expect(third.upserts.length).toBe(1);
    expect(third.upserts[0]!.slot).toBe(slotA);
    expect(bitmapTag(third.upserts[0]!.bitmap)).toBe('c');
    expect(third.removeSlots).toEqual([]);
  });

  it('batches failures: one diagnostic per flush, each ref counted once per generation', async () => {
    const h = makeHarness({
      maxRetries: 0,
      resolver: async () => {
        throw new Error('down');
      },
    });
    h.pipeline.requestRefs(['x', 'x', 'y', 'y'], 1);
    await tick();
    h.run();

    const batch = h.batches.at(-1)!;
    expect(batch.diagnostics.length).toBe(1); // ONE diagnostic for both refs
    expect(batch.diagnostics[0]!.count).toBe(2); // x once + y once
    expect([...batch.diagnostics[0]!.sampleIds].sort()).toEqual(['x', 'y']);

    // Same failed refs re-requested in the same generation: not re-counted.
    h.pipeline.requestRefs(['x', 'y'], 1);
    await tick();
    h.run();
    expect(h.batches.at(-1)!.diagnostics).toEqual([]);
  });

  it('fetches + decodes a resolver-returned string exactly once, never re-resolving it', async () => {
    const fetchCalls: string[] = [];
    let decodeCalls = 0;
    const fetchImpl: FetchLike = async (url) => {
      fetchCalls.push(url);
      return { ok: true, status: 200, blob: async () => makeBlob('fetched-bytes') };
    };
    const h = makeHarness({
      resolver: async () => 'https://cdn.example/final.png',
      fetchImpl,
      decode: async (blob) => {
        decodeCalls++;
        return fakeDecode(blob);
      },
    });
    h.pipeline.requestRefs(['icon:cdn'], 1);
    await tick();
    h.run();

    expect(h.resolverCalls).toEqual(['icon:cdn']); // the URL never re-enters the resolver
    expect(fetchCalls).toEqual(['https://cdn.example/final.png']); // fetched exactly once
    expect(decodeCalls).toBe(1); // decoded exactly once
    const batch = h.batches.at(-1)!;
    expect(batch.upserts.length).toBe(1);
    expect(bitmapTag(batch.upserts[0]!.bitmap)).toBe('fetched-bytes');
  });

  it('bounds concurrent resolves at maxConcurrent', async () => {
    const holds: Deferred<Blob | string>[] = [];
    const h = makeHarness({
      maxConcurrent: 1,
      resolver: () => {
        const d = deferred<Blob | string>();
        holds.push(d);
        return d.promise;
      },
    });
    h.pipeline.requestRefs(['a', 'b'], 1);
    await tick();
    expect(h.resolverCalls).toEqual(['a']); // 'b' queued behind the bound

    holds[0]!.resolve(makeBlob('a'));
    await tick();
    expect(h.resolverCalls).toEqual(['a', 'b']); // freed capacity pumps the queue
  });

  it('dispose aborts in-flight work and silences all output', async () => {
    const hold = deferred<Blob | string>();
    const h = makeHarness({ resolver: () => hold.promise });
    h.pipeline.requestRefs(['a'], 1);
    await tick();
    expect(h.signals.get('a')!.aborted).toBe(false);

    h.pipeline.dispose();
    expect(h.signals.get('a')!.aborted).toBe(true);

    hold.resolve(makeBlob('a')); // abort-ignoring resolver settles anyway
    await tick();
    h.run(); // any pre-dispose scheduled flush is inert
    expect(h.batches).toEqual([]);

    h.pipeline.requestRefs(['b'], 2); // terminal: no new work
    await tick();
    h.run();
    expect(h.resolverCalls).toEqual(['a']);
    expect(h.batches).toEqual([]);
  });
});

describe('ImageBitmap ownership and close', () => {
  it('closes an evicted delivered bitmap exactly once, AFTER the flush carrying its removeSlot', async () => {
    const { decode, closes } = closeSpyDecode();
    const h = makeHarness({ decode });
    h.pipeline.requestRefs(['img://a', 'img://b'], 1);
    await tick();
    h.run(); // delivery flush: a + b upserted
    expect(closes.size).toBe(0);

    // Drop a: evicted → close is DEFERRED to the flush (replay maps prune
    // synchronously in the batch callback, then the bitmap closes).
    let closedAtCallback: number | undefined;
    const off = h.pipeline.onBatch((b) => {
      if (b.removeSlots.length > 0) closedAtCallback = closes.get('img://a') ?? 0;
    });
    h.pipeline.requestRefs(['img://b'], 2);
    await tick();
    h.run();
    off();
    expect(closedAtCallback).toBe(0); // NOT yet closed while callbacks ran
    expect(closes.get('img://a')).toBe(1); // closed exactly once after
    expect(closes.get('img://b')).toBeUndefined(); // live bitmap untouched

    // Re-requesting the same evicted ref later re-resolves fresh (no reuse
    // of a closed bitmap) and never double-closes the old one.
    h.pipeline.requestRefs(['img://a', 'img://b'], 3);
    await tick();
    h.run();
    expect(closes.get('img://a')).toBe(1);
  });

  it('closes a stale decode (evicted mid-DECODE) immediately — it was never delivered', async () => {
    const { decode, closes } = closeSpyDecode();
    const gate = deferred<void>();
    const gatedDecode = async (blob: Blob): Promise<ImageBitmap> => {
      await gate.promise; // eviction lands while the decode is in flight
      return decode(blob);
    };
    const h = makeHarness({ decode: gatedDecode });
    h.pipeline.requestRefs(['img://slow'], 1);
    await tick(); // resolver done, decode pending
    h.pipeline.requestRefs([], 2); // evict during decode
    gate.resolve();
    await tick();
    expect(closes.get('img://slow')).toBe(1); // closed on arrival, no delivery
    h.run();
    expect(h.batches.every((b) => b.upserts.length === 0)).toBe(true);
    expect(closes.get('img://slow')).toBe(1); // never double-closed
  });

  it('dispose() closes every owned bitmap exactly once', async () => {
    const { decode, closes } = closeSpyDecode();
    const h = makeHarness({ decode });
    h.pipeline.requestRefs(['img://a', 'img://b', 'img://c'], 1);
    await tick();
    h.run();
    h.pipeline.dispose();
    expect(closes.get('img://a')).toBe(1);
    expect(closes.get('img://b')).toBe(1);
    expect(closes.get('img://c')).toBe(1);
    h.pipeline.dispose(); // idempotent — no double close
    expect([...closes.values()]).toEqual([1, 1, 1]);
  });

  it('churn keeps the live (unclosed) bitmap count bounded by the roster', async () => {
    const { decode, closes } = closeSpyDecode();
    const h = makeHarness({ decode });
    let created = 0;
    for (let round = 0; round < 10; round++) {
      const refs = [`img://r${round}a`, `img://r${round}b`];
      created += 2;
      h.pipeline.requestRefs(refs, round + 1);
      await tick();
      h.run();
    }
    const closed = [...closes.values()].reduce((a, b) => a + b, 0);
    expect(created - closed).toBe(2); // only the last roster's bitmaps live
    for (const [, n] of closes) expect(n).toBe(1); // each exactly once
  });
});
