/**
 * Graph-size global: every story reads the toolbar's S/M/L/XL selection, so
 * the whole catalog rescales without per-story wiring. Snapshots are cached
 * per size so control toggles never regenerate data.
 */

import type { DemoSnapshot } from './generate';

export const SIZES = { S: 300, M: 1500, L: 8000, XL: 40_000 } as const;
export type SizeKey = keyof typeof SIZES;

export function sizeFromGlobals(globals: Record<string, unknown>): number {
  const k = globals['size'];
  return SIZES[typeof k === 'string' && k in SIZES ? (k as SizeKey) : 'M'];
}

export function sizedCache(
  maker: (seed: number, n: number) => DemoSnapshot,
  seed = 7,
): (globals: Record<string, unknown>) => DemoSnapshot {
  const cache = new Map<number, DemoSnapshot>();
  return (globals) => {
    const n = sizeFromGlobals(globals);
    let snap = cache.get(n);
    if (snap === undefined) {
      snap = maker(seed, n);
      cache.set(n, snap);
    }
    return snap;
  };
}
