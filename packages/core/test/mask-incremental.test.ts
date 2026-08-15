/**
 * wave 1 — the O(Δ) mask delta API against the replace oracle.
 *
 * Twin-mask property tests: every random operation sequence is applied to
 * one SoftMask through the DELTA ops and to a twin through full REPLACE
 * sets computed from a JS Set model. Counters, visibility, drains, and the
 * DEBUG balance assert must agree at every step — including across mixed
 * delta/replace usage on the same source (the re-baseline contract) and
 * across hole compaction (the double-decrement hazard the bit0 guard
 * exists for).
 */

import { describe, expect, it } from 'vitest';

import { SoftMask } from '../src/mask';
import type { MaskCrossings } from '../src/mask';

/** Deterministic PRNG (mulberry32) — same idiom as the perf-gate fixtures. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 64;
const E = 96;

function crossings(): MaskCrossings {
  return { becameFailing: [], becameClear: [] };
}

describe('SoftMask delta ops vs the replace oracle (property)', () => {
  it('1000 random delta steps match a replace-driven twin exactly', () => {
    const rand = mulberry32(0xf1002);
    const deltaMask = new SoftMask(N, E);
    const replaceMask = new SoftMask(N, E);
    const deltaSrc = deltaMask.acquire('delta');
    const replaceSrc = replaceMask.acquire('replace');
    const model = new Set<number>();

    for (let step = 0; step < 1000; step += 1) {
      const add: number[] = [];
      const remove: number[] = [];
      const count = 1 + Math.floor(rand() * 6);
      for (let k = 0; k < count; k += 1) {
        const slot = Math.floor(rand() * N);
        if (rand() < 0.5) add.push(slot);
        else remove.push(slot);
      }
      for (const s of add) model.add(s);
      for (const s of remove) model.delete(s);

      deltaSrc.updateNodeFailures(add, remove);
      replaceSrc.setNodeFailures([...model]);

      expect(Array.from(deltaMask.nodeHideFailures)).toEqual(
        Array.from(replaceMask.nodeHideFailures),
      );
      expect(deltaMask.visibleNodeCount()).toBe(replaceMask.visibleNodeCount());
    }

    // Both drains report the same net flips relative to their last drain.
    expect([...deltaMask.drainDirty().nodes].sort((a, b) => a - b)).toEqual(
      [...replaceMask.drainDirty().nodes].sort((a, b) => a - b),
    );

    // Releasing both leaves balanced books (DEBUG assert throws otherwise).
    deltaSrc.release();
    replaceSrc.release();
    expect(deltaMask.visibleNodeCount()).toBe(N);
  });

  it('mixed delta and replace calls on ONE source re-baseline correctly', () => {
    const rand = mulberry32(0xbeef);
    const mask = new SoftMask(N, E);
    const twin = new SoftMask(N, E);
    const src = mask.acquire('mixed');
    const twinSrc = twin.acquire('twin');
    const model = new Set<number>();

    for (let step = 0; step < 400; step += 1) {
      if (rand() < 0.25) {
        // REPLACE with a fresh random set (the re-baseline path).
        model.clear();
        const size = Math.floor(rand() * N);
        for (let k = 0; k < size; k += 1) model.add(Math.floor(rand() * N));
        src.setNodeFailures([...model]);
      } else {
        const add: number[] = [];
        const remove: number[] = [];
        for (let k = 0; k < 4; k += 1) {
          const slot = Math.floor(rand() * N);
          if (rand() < 0.5) add.push(slot);
          else remove.push(slot);
        }
        // Model applies adds THEN removes — the documented per-call
        // semantics (a slot in both lists nets to removed).
        for (const s of add) model.add(s);
        for (const s of remove) model.delete(s);
        src.updateNodeFailures(add, remove);
      }
      twinSrc.setNodeFailures([...model]);
      expect(Array.from(mask.nodeHideFailures)).toEqual(Array.from(twin.nodeHideFailures));
    }

    // clear walks the (holey) list — the bit0 guard must keep the books
    // balanced; the DEBUG assert inside clear throws on any drift.
    src.clear();
    expect(mask.visibleNodeCount()).toBe(N);
    src.release();
  });

  it('hole compaction under heavy churn never double-decrements', () => {
    const mask = new SoftMask(8, 4);
    const other = mask.acquire('other'); // second source shares slot 0
    other.setNodeFailures([0]);
    const src = mask.acquire('churn');
    // Add/remove the same slots repeatedly: every remove leaves a hole and
    // every re-add duplicates the list entry; compaction triggers at >50%.
    for (let round = 0; round < 50; round += 1) {
      src.updateNodeFailures([0, 1, 2, 3], null);
      src.updateNodeFailures(null, [0, 1, 2, 3]);
    }
    // src holds nothing; only `other`'s contribution to slot 0 remains.
    expect(Array.from(mask.nodeHideFailures.slice(0, 4))).toEqual([1, 0, 0, 0]);
    src.release();
    expect(mask.nodeHideFailures[0]).toBe(1);
    other.release(); // balanced-books assert runs here
    expect(mask.visibleNodeCount()).toBe(8);
  });
});

describe('per-call crossings (the incremental cascade input)', () => {
  it('reports exactly the slots whose hide counter crossed zero IN THIS CALL', () => {
    const mask = new SoftMask(8, 4);
    const a = mask.acquire('a');
    const b = mask.acquire('b');
    const x = crossings();

    a.updateNodeFailures([1, 2], null, x);
    expect([...x.becameFailing].sort()).toEqual([1, 2]);
    expect(x.becameClear).toEqual([]);

    // Slot 1 is already failing via source A: B adding it crosses nothing.
    b.updateNodeFailures([1, 3], null, x);
    expect(x.becameFailing).toEqual([3]);
    expect(x.becameClear).toEqual([]);

    // Removing A's slot 1 does NOT clear it (B still holds it)…
    a.updateNodeFailures(null, [1, 2], x);
    expect(x.becameFailing).toEqual([]);
    expect(x.becameClear).toEqual([2]);

    // …and idempotent no-ops cross nothing (callee-cleared each call).
    a.updateNodeFailures([], [], x);
    expect(x.becameFailing).toEqual([]);
    expect(x.becameClear).toEqual([]);

    a.release();
    b.release();
  });

  it('rejects out-of-range slots atomically — no partial delta applies', () => {
    const mask = new SoftMask(4, 2);
    const src = mask.acquire('ranges');
    const x = crossings();
    expect(() => src.updateNodeFailures([1, 99], null, x)).toThrow(RangeError);
    // Nothing applied: slot 1 must not have been incremented.
    expect(Array.from(mask.nodeHideFailures)).toEqual([0, 0, 0, 0]);
    expect(x.becameFailing).toEqual([]);
    src.release();
  });
});

describe('op counters', () => {
  it('slotsVisited and zeroCrossings count delta work, resettable', () => {
    const mask = new SoftMask(16, 4);
    const src = mask.acquire('stats');
    mask.resetStats();

    src.updateNodeFailures([1, 2, 3], null); // 3 visits, 3 crossings
    src.updateNodeFailures([1], [2]); // 2 visits, 1 crossing (1 is a no-op add)
    expect(mask.stats.slotsVisited).toBe(5);
    expect(mask.stats.zeroCrossings).toBe(4);

    mask.resetStats();
    expect(mask.stats.slotsVisited).toBe(0);
    src.release();
  });
});
