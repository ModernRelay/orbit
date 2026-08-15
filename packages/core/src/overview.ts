/**
 * minimap / overview — CPU fallback lane.
 *
 * v0.9 trim: no engine exposes `capabilities.overviewPass` yet (cosmos has no
 * second draw pass — matrix), so this controller IS the minimap thumbnail
 * path: an O(n) CPU rasterization of the position mirror into a small
 * RGBA dot field. It is a pure controller — no DOM, no canvas — the React
 * component blits the returned `Uint8ClampedArray` into an `ImageData`/canvas
 * and draws the viewport rectangle on top (O(1) from `getViewport`, fully
 * decoupled from thumbnail refresh cadence).
 *
 * Refresh cadence: ≤ 2 Hz while the simulation is hot (positions
 * change continuously on the GPU, so the epoch is ignored), ≤ 1 Hz after a
 * change while idle, and ZERO work while idle with an unchanged positions
 * epoch — `shouldRefresh` is the single throttle gate and latches its clock /
 * epoch only when it answers true (a `true` must be followed by one
 * `rasterize`).
 *
 * Orientation: minimap pixel y grows DOWNWARD while world (space) y grows
 * upward — the same flip cosmos applies in its space→screen scale (dist
 * `scalePointY.domain([S, 0])`), so the thumbnail visually matches the main
 * canvas. `worldToMinimap`/`minimapToWorld` are exact inverses over the last
 * rasterized bounds.
 */

/** Position mirror handed to the controller: interleaved x,y space coords. */
export interface OverviewScene {
  /** Interleaved `[x0, y0, x1, y1, …]`; may be longer than `count` pairs. */
  positions: Float32Array;
  /** Number of points (pairs) to read from `positions`. */
  count: number;
}

export interface OverviewControllerOptions {
  /** Latest scene snapshot, or null when nothing is loaded yet. */
  getScene: () => OverviewScene | null;
  /**
   * Soft-filter visibility mask. Hidden points still rasterize (and still
   * contribute to bounds — the thumbnail must not re-frame when a filter
   * toggles) but at a dimmed alpha.
   */
  getVisible?: (index: number) => boolean;
  /** Square thumbnail edge in pixels. Default {@link OVERVIEW_SIZE_DEFAULT}. */
  size?: number;
}

/** World-space extent of the last rasterization (finite positions only). */
export interface OverviewBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface OverviewRaster {
  /** RGBA, `size * size * 4` bytes — blit via `new ImageData(bitmap, size)`. */
  bitmap: Uint8ClampedArray;
  bounds: OverviewBounds;
}

/** Spec the CPU fallback rasterizes into a 256² target. */
export const OVERVIEW_SIZE_DEFAULT = 256;
/** Hot-simulation refresh floor: ≤ 2 Hz. */
export const OVERVIEW_HOT_INTERVAL_MS = 500;
/** Idle-after-change refresh floor: ≤ 1 Hz. */
export const OVERVIEW_IDLE_INTERVAL_MS = 1000;

/** Fraction of the thumbnail edge kept clear on every side. */
const PADDING_FRACTION = 0.05;
/** Alpha added per visible point (accumulates — overlaps read denser). */
const VISIBLE_ALPHA = 160;
/** Alpha added per soft-filtered (hidden) point. */
const HIDDEN_ALPHA = 48;

export class OverviewController {
  private readonly getScene: () => OverviewScene | null;
  private readonly getVisible: ((index: number) => boolean) | undefined;
  readonly size: number;

  /** Transform of the LAST rasterization; null until rasterize succeeds. */
  private frame: {
    bounds: OverviewBounds;
    scale: number;
    offsetX: number;
    offsetY: number;
  } | null = null;

  // --- throttle state (latched by shouldRefresh when it answers true) ---
  private lastRefreshMs: number | null = null;
  private lastEpoch: number | null = null;

  constructor(options: OverviewControllerOptions) {
    this.getScene = options.getScene;
    this.getVisible = options.getVisible;
    this.size = options.size ?? OVERVIEW_SIZE_DEFAULT;
  }

  /**
   * The single throttle gate (see module header). Latches `nowMs`/`epoch`
   * when it returns true, so each `true` accounts for exactly one refresh:
   *
   * - hot (`simulationRunning`): time-gated only (≤ 2 Hz) — the epoch is
   * ignored because positions change continuously without epoch advances;
   * - idle: refresh only when the epoch ADVANCED since the last refresh,
   * time-gated at ≤ 1 Hz;
   * - idle + unchanged epoch: always false — zero work, forever.
   */
  shouldRefresh(nowMs: number, simulationRunning: boolean, epoch: number): boolean {
    const last = this.lastRefreshMs;
    if (simulationRunning) {
      if (last !== null && nowMs - last < OVERVIEW_HOT_INTERVAL_MS) return false;
    } else {
      if (this.lastEpoch !== null && epoch === this.lastEpoch) return false;
      if (last !== null && nowMs - last < OVERVIEW_IDLE_INTERVAL_MS) return false;
    }
    this.lastRefreshMs = nowMs;
    this.lastEpoch = epoch;
    return true;
  }

  /**
   * Rasterizes the current scene into a fresh `size²` RGBA dot field: 1 px
   * white dots whose alpha ACCUMULATES on overlap (heatmap-ish density),
   * dimmed for mask-hidden points; NaN pairs are skipped.
   * World bounds map into the thumbnail with a 5 % edge padding at a UNIFORM
   * scale (aspect preserved, centered on the short axis) and a downward pixel
   * y (see module header). Returns null when there is no scene or no point.
   */
  rasterize(): OverviewRaster | null {
    const scene = this.getScene();
    if (!scene || scene.count <= 0) return null;
    const { positions, count } = scene;
    const pairs = Math.min(count, Math.floor(positions.length / 2));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pairs; i++) {
      const x = positions[2 * i]!;
      const y = positions[2 * i + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null; // all NaN

    const size = this.size;
    const pad = size * PADDING_FRACTION;
    const inner = size - 2 * pad;
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const span = Math.max(spanX, spanY);
    const scale = span > 0 ? inner / span : 1; // degenerate scene: centered dot
    // Uniform scale, centered on the short axis (and on both for span 0).
    const offsetX = pad + (inner - spanX * scale) / 2;
    const offsetY = pad + (inner - spanY * scale) / 2;

    const bounds: OverviewBounds = { minX, minY, maxX, maxY };
    this.frame = { bounds, scale, offsetX, offsetY };

    const bitmap = new Uint8ClampedArray(size * size * 4);
    const max = size - 1;
    for (let i = 0; i < pairs; i++) {
      const x = positions[2 * i]!;
      const y = positions[2 * i + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      // Inline worldToMinimap (same frame), clamped to the pixel grid.
      let px = Math.round(offsetX + (x - minX) * scale);
      let py = Math.round(offsetY + (maxY - y) * scale);
      if (px < 0) px = 0;
      else if (px > max) px = max;
      if (py < 0) py = 0;
      else if (py > max) py = max;
      const at = (py * size + px) * 4;
      bitmap[at] = 255;
      bitmap[at + 1] = 255;
      bitmap[at + 2] = 255;
      const visible = this.getVisible ? this.getVisible(i) : true;
      // Uint8ClampedArray saturates the accumulation at 255 for us.
      bitmap[at + 3] = bitmap[at + 3]! + (visible ? VISIBLE_ALPHA : HIDDEN_ALPHA);
    }
    return { bitmap, bounds };
  }

  /**
   * World (space) → minimap pixel coords over the LAST rasterized frame
   * (fractional; callers round for pixel work). Null before any rasterize.
   */
  worldToMinimap(x: number, y: number): [number, number] | null {
    const frame = this.frame;
    if (!frame) return null;
    const { bounds, scale, offsetX, offsetY } = frame;
    return [offsetX + (x - bounds.minX) * scale, offsetY + (bounds.maxY - y) * scale];
  }

  /** Exact inverse of {@link worldToMinimap}. Null before any rasterize. */
  minimapToWorld(px: number, py: number): [number, number] | null {
    const frame = this.frame;
    if (!frame) return null;
    const { bounds, scale, offsetX, offsetY } = frame;
    return [bounds.minX + (px - offsetX) / scale, bounds.maxY - (py - offsetY) / scale];
  }
}
