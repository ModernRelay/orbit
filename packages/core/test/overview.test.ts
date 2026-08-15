/**
 * minimap overview lane: CPU rasterizer exact-pixel math,
 * mask-aware alpha, world↔minimap round-trip, and the refresh throttle truth
 * table (≤2 Hz hot / ≤1 Hz idle-after-change / zero work on unchanged epoch).
 */
import { describe, expect, it } from 'vitest';

import {
  OVERVIEW_HOT_INTERVAL_MS,
  OVERVIEW_IDLE_INTERVAL_MS,
  OVERVIEW_SIZE_DEFAULT,
  OverviewController,
} from '../src/overview';
import type { OverviewScene } from '../src/overview';

/** 5-point known scene on a 10×10 world square (corners + center). */
const FIVE_POINTS = Float32Array.from([
  0, 0, // world bottom-left
  10, 0, // world bottom-right
  0, 10, // world top-left
  10, 10, // world top-right
  5, 5, // center
]);

function controller(
  scene: OverviewScene | null,
  opts: { getVisible?: (i: number) => boolean; size?: number } = {},
): OverviewController {
  const options: ConstructorParameters<typeof OverviewController>[0] = {
    getScene: () => scene,
  };
  if (opts.getVisible) options.getVisible = opts.getVisible;
  if (opts.size !== undefined) options.size = opts.size;
  return new OverviewController(options);
}

/** RGBA tuple at integer pixel (px, py). */
function pixel(bitmap: Uint8ClampedArray, size: number, px: number, py: number): number[] {
  const at = (py * size + px) * 4;
  return Array.from(bitmap.slice(at, at + 4));
}

describe('OverviewController.rasterize', () => {
  it('places the 5 known points at exact pixels (5% padding, uniform scale, y flipped)', () => {
    // size 100 → pad 5, inner 90; world span 10 → scale 9.
    // px = 5 + (x - 0) * 9; py = 5 + (10 - y) * 9 (pixel y grows downward).
    const c = controller({ positions: FIVE_POINTS, count: 5 }, { size: 100 });
    const raster = c.rasterize();
    expect(raster).not.toBeNull();
    const { bitmap, bounds } = raster!;
    expect(bitmap).toHaveLength(100 * 100 * 4);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });

    expect(pixel(bitmap, 100, 5, 95)).toEqual([255, 255, 255, 160]); // (0,0)
    expect(pixel(bitmap, 100, 95, 95)).toEqual([255, 255, 255, 160]); // (10,0)
    expect(pixel(bitmap, 100, 5, 5)).toEqual([255, 255, 255, 160]); // (0,10)
    expect(pixel(bitmap, 100, 95, 5)).toEqual([255, 255, 255, 160]); // (10,10)
    expect(pixel(bitmap, 100, 50, 50)).toEqual([255, 255, 255, 160]); // (5,5)

    // Exactly 5 lit pixels — 1px dots, nothing else painted.
    let lit = 0;
    for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i]! > 0) lit++;
    expect(lit).toBe(5);
  });

  it('centers the short axis: non-square worlds keep aspect (uniform scale)', () => {
    // World 10 wide × 5 tall, size 100: scale = 90/10 = 9; y occupies 45px,
    // centered → offsetY = 5 + (90 - 45)/2 = 27.5. (0,0) → (5, 27.5+45=72.5)
    // rounds to (5, 73); (10,5) → (95, 27.5) rounds to (95, 28).
    const positions = Float32Array.from([0, 0, 10, 5]);
    const c = controller({ positions, count: 2 }, { size: 100 });
    const { bitmap } = c.rasterize()!;
    expect(pixel(bitmap, 100, 5, 73)[3]).toBe(160);
    expect(pixel(bitmap, 100, 95, 28)[3]).toBe(160);
  });

  it('dims mask-hidden points but keeps them in bounds', () => {
    const c = controller(
      { positions: FIVE_POINTS, count: 5 },
      { size: 100, getVisible: (i) => i !== 3 }, // hide (10,10)
    );
    const { bitmap, bounds } = c.rasterize()!;
    // Hidden corner still frames the world (no re-framing on filter toggles)…
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    // …but rasterizes dimmed; visible points keep full alpha.
    expect(pixel(bitmap, 100, 95, 5)).toEqual([255, 255, 255, 48]);
    expect(pixel(bitmap, 100, 50, 50)).toEqual([255, 255, 255, 160]);
  });

  it('accumulates alpha on overlapping dots (heatmap-ish density)', () => {
    const positions = Float32Array.from([0, 0, 0, 0, 10, 10]);
    const c = controller({ positions, count: 3 }, { size: 100 });
    const { bitmap } = c.rasterize()!;
    expect(pixel(bitmap, 100, 5, 95)[3]).toBe(255); // 160+160 saturates
    expect(pixel(bitmap, 100, 95, 5)[3]).toBe(160);
  });

  it('skips NaN tombstones in both bounds and pixels', () => {
    const positions = Float32Array.from([0, 0, NaN, NaN, 10, 10, 500, NaN]);
    const c = controller({ positions, count: 4 }, { size: 100 });
    const { bitmap, bounds } = c.rasterize()!;
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    let lit = 0;
    for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i]! > 0) lit++;
    expect(lit).toBe(2);
  });

  it('centers a degenerate single-point scene', () => {
    const c = controller({ positions: Float32Array.from([7, -3]), count: 1 }, { size: 100 });
    const { bitmap, bounds } = c.rasterize()!;
    expect(bounds).toEqual({ minX: 7, minY: -3, maxX: 7, maxY: -3 });
    expect(pixel(bitmap, 100, 50, 50)[3]).toBe(160);
  });

  it('returns null with no scene, zero points, or all-NaN positions; default size is 256', () => {
    expect(controller(null).rasterize()).toBeNull();
    expect(controller({ positions: new Float32Array(0), count: 0 }).rasterize()).toBeNull();
    expect(
      controller({ positions: Float32Array.from([NaN, NaN]), count: 1 }).rasterize(),
    ).toBeNull();
    expect(controller(null).size).toBe(OVERVIEW_SIZE_DEFAULT);
    expect(OVERVIEW_SIZE_DEFAULT).toBe(256);
  });
});

describe('OverviewController world↔minimap transforms', () => {
  it('is null before any rasterization', () => {
    const c = controller({ positions: FIVE_POINTS, count: 5 });
    expect(c.worldToMinimap(0, 0)).toBeNull();
    expect(c.minimapToWorld(0, 0)).toBeNull();
  });

  it('round-trips every known point exactly and matches the pixel math', () => {
    const c = controller({ positions: FIVE_POINTS, count: 5 }, { size: 100 });
    c.rasterize();

    expect(c.worldToMinimap(0, 0)).toEqual([5, 95]);
    expect(c.worldToMinimap(10, 10)).toEqual([95, 5]);
    expect(c.worldToMinimap(5, 5)).toEqual([50, 50]);

    for (let i = 0; i < 5; i++) {
      const x = FIVE_POINTS[2 * i]!;
      const y = FIVE_POINTS[2 * i + 1]!;
      const [px, py] = c.worldToMinimap(x, y)!;
      const [wx, wy] = c.minimapToWorld(px, py)!;
      expect(wx).toBeCloseTo(x, 10);
      expect(wy).toBeCloseTo(y, 10);
    }

    // And the inverse composed the other way: pixel → world → pixel.
    const [wx, wy] = c.minimapToWorld(20, 80)!;
    const [px, py] = c.worldToMinimap(wx, wy)!;
    expect(px).toBeCloseTo(20, 10);
    expect(py).toBeCloseTo(80, 10);
  });
});

describe('OverviewController.shouldRefresh throttle', () => {
  it('implements the hot/idle/unchanged truth table', () => {
    const c = controller({ positions: FIVE_POINTS, count: 5 });

    // First ask always refreshes.
    expect(c.shouldRefresh(0, true, 0)).toBe(true);
    // Hot: time-gated at ≤2 Hz, epoch ignored.
    expect(c.shouldRefresh(200, true, 0)).toBe(false);
    expect(c.shouldRefresh(499, true, 7)).toBe(false);
    expect(c.shouldRefresh(500, true, 0)).toBe(true);

    // Idle + unchanged epoch: zero work, regardless of elapsed time.
    expect(c.shouldRefresh(900, false, 0)).toBe(false);
    expect(c.shouldRefresh(99_999, false, 0)).toBe(false);

    // Idle + advanced epoch: gated at ≤1 Hz since the LAST refresh (t=500).
    expect(c.shouldRefresh(1200, false, 1)).toBe(false); // 700ms < 1000ms
    expect(c.shouldRefresh(1600, false, 1)).toBe(true); // 1100ms ≥ 1000ms
    expect(c.shouldRefresh(1700, false, 1)).toBe(false); // unchanged again
    expect(c.shouldRefresh(99_999, false, 1)).toBe(false); // forever

    // A new change while idle refreshes once more, then goes quiet.
    expect(c.shouldRefresh(100_000, false, 2)).toBe(true);
    expect(c.shouldRefresh(100_100, false, 2)).toBe(false);

    // Back to hot: 2 Hz resumes from the last refresh (t=100_000), and the
    // epoch is ignored again while hot.
    expect(c.shouldRefresh(100_200, true, 2)).toBe(false);
    expect(c.shouldRefresh(100_500, true, 2)).toBe(true);

    expect(OVERVIEW_HOT_INTERVAL_MS).toBe(500);
    expect(OVERVIEW_IDLE_INTERVAL_MS).toBe(1000);
  });

  it('a denied ask does not latch: the hot window is measured from the last GRANT', () => {
    const c = controller({ positions: FIVE_POINTS, count: 5 });
    expect(c.shouldRefresh(0, true, 0)).toBe(true);
    // Repeated denied asks inside the window must not push the window forward.
    expect(c.shouldRefresh(300, true, 0)).toBe(false);
    expect(c.shouldRefresh(499, true, 0)).toBe(false);
    expect(c.shouldRefresh(500, true, 0)).toBe(true);
  });
});
