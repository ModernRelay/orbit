/**
 * wave 4 — IncrementalAlphaComposer vs the naive-composer semantics
 * (fresh copy + full masked pass), including the invalidation matrix and
 * the distinct-consecutive-buffers contract.
 */

import { describe, expect, it } from 'vitest';

import { IncrementalAlphaComposer } from '../src/alphaCompose';

/** The naive oracle: what composeNodeAlphaBuffer does. */
function naive(base: Float32Array, count: number, alphaOf: (i: number) => number): Float32Array {
  const out = new Float32Array(base);
  for (let i = 0; i < count; i += 1) {
    const a = alphaOf(i);
    if (a !== 1) out[4 * i + 3] = base[4 * i + 3]! * a;
  }
  return out;
}

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

function randomBase(rand: () => number, count: number): Float32Array {
  const base = new Float32Array(count * 4);
  for (let i = 0; i < base.length; i += 1) base[i] = rand();
  return base;
}

describe('IncrementalAlphaComposer', () => {
  it('random drain sequences match the naive composer at every step', () => {
    const rand = mulberry32(0xa1fa);
    const count = 50;
    const base = randomBase(rand, count);
    const alphas = new Float32Array(count).fill(1);
    const alphaOf = (i: number): number => alphas[i]!;
    const composer = new IncrementalAlphaComposer();
    composer.ensureSeeded(base, count, 0.15, null, alphaOf);

    for (let step = 0; step < 200; step += 1) {
      // Random mask churn: flip a few slots between 1 / dim / hidden.
      const changed: number[] = [];
      for (let k = 0; k < 4; k += 1) {
        const slot = Math.floor(rand() * count);
        const r = rand();
        alphas[slot] = r < 0.33 ? 0 : r < 0.66 ? 0.15 : 1;
        changed.push(slot);
      }
      composer.note(changed);
      const out = composer.nextBuffer(base, alphaOf);
      expect(Array.from(out)).toEqual(Array.from(naive(base, count, alphaOf)));
    }
  });

  it('two consecutive buffers are DISTINCT instances; distance-2 aliases', () => {
    const base = new Float32Array(8 * 4).fill(0.5);
    const composer = new IncrementalAlphaComposer();
    const one = (): number => 1;
    composer.ensureSeeded(base, 8, 0.15, null, one);
    const b1 = composer.nextBuffer(base, one);
    const b2 = composer.nextBuffer(base, one);
    const b3 = composer.nextBuffer(base, one);
    expect(b1).not.toBe(b2);
    expect(b2).not.toBe(b3);
    expect(b3).toBe(b1); // ping-pong
  });

  it('reseeds on base identity, count, dimAlpha, or epoch changes — not otherwise', () => {
    const rand = mulberry32(0x5eed);
    const count = 12;
    const base = randomBase(rand, count);
    const one = (): number => 1;
    const composer = new IncrementalAlphaComposer();

    expect(composer.ensureSeeded(base, count, 0.15, null, one)).toBe(false); // first
    expect(composer.ensureSeeded(base, count, 0.15, null, one)).toBe(true); // stable

    const base2 = Float32Array.from(base); // equal CONTENT, new identity
    expect(composer.ensureSeeded(base2, count, 0.15, null, one)).toBe(false);
    expect(composer.ensureSeeded(base2, count, 0.2, null, one)).toBe(false); // dimAlpha
    const epoch = {};
    expect(composer.ensureSeeded(base2, count, 0.2, epoch, one)).toBe(false); // epoch
    expect(composer.ensureSeeded(base2, count, 0.2, epoch, one)).toBe(true);
    expect(composer.reseeds).toBe(4);
  });

  it('a reseed repaints slots whose alpha changed while the composer was cold', () => {
    const count = 6;
    const base = new Float32Array(count * 4).fill(1);
    const alphas = new Float32Array(count).fill(1);
    const alphaOf = (i: number): number => alphas[i]!;
    const composer = new IncrementalAlphaComposer();
    composer.ensureSeeded(base, count, 0.15, null, alphaOf);
    composer.nextBuffer(base, alphaOf);

    // The mask changes AND the theme changes without a drain note (the
    // full-path composers handled the interim) — the dimAlpha key forces a
    // reseed that repaints everything from current state.
    alphas[3] = 0;
    composer.ensureSeeded(base, count, 0.2, null, alphaOf);
    const out = composer.nextBuffer(base, alphaOf);
    expect(out[4 * 3 + 3]).toBe(0);
    expect(Array.from(out)).toEqual(Array.from(naive(base, count, alphaOf)));
  });

  it('steady state allocates nothing (buffer identities stable across drains)', () => {
    const count = 20;
    const base = new Float32Array(count * 4).fill(0.25);
    const one = (): number => 1;
    const composer = new IncrementalAlphaComposer();
    composer.ensureSeeded(base, count, 0.15, null, one);
    const first = composer.nextBuffer(base, one);
    const second = composer.nextBuffer(base, one);
    for (let i = 0; i < 100; i += 1) {
      composer.note([i % count]);
      const out = composer.nextBuffer(base, one);
      expect(out === first || out === second).toBe(true);
    }
  });
});
