/**
 * Edge-picking facade.
 *
 * The core commits to ONE route per mount session, read from
 * `engine.capabilities.linkPicking` at engine-ready time — never method
 * sniffing, and never re-evaluated (a capability record mutated after ready
 * changes nothing):
 *
 * - 'native': the adapter delivers `onLinkClick`/`onLinkHover` host events
 * itself; the facade is inert (arm/disarm/queries no-op and
 * `pickLinkAt` returns null) and the instance maps link indices
 * to typed edges straight off the host events.
 * - 'fallback': the instance samples the pointer on the shared throttle
 * cadence and resolves hits through a `LinkPickIndex` uniform
 * grid that is armed ONLY while the simulation is settled.
 *
 * Arming protocol for the fallback route:
 * - `arm(positions, links)` runs on simulation settle (fed by one per-event
 * `getPositions` readback) and on structural commits that do NOT restart
 * the simulation (fixed layout). The grid builds CHUNKED via
 * `LinkPickIndex.buildChunked` under a per-slice time budget so large link
 * sets never block; small builds complete synchronously in the first
 * slice. While an initial build is in flight queries return null; a
 * position-sync REBUILD keeps answering from the previous grid until the
 * new one commits.
 * - `disarm` runs on any commit that restarts the simulation: targets are
 * moving and the position mirror is stale, so queries return null until
 * the next settle re-arms.
 * - Rebuilds happen ONLY on structural change or position sync — the grid is
 * invariant under camera moves and mask changes (the visibility mask
 * is applied per candidate at query time; initially a pass-through stub).
 *
 * Tolerance: a query converts screen px to space units via
 * `screenToSpace` of two points `EDGE_PICK_TOLERANCE_PX` apart, then uses
 * `max(4px, half the median link width)` scaled by that factor.
 */

import { LinkPickIndex } from './linkPick';
import type { LinkVisibilityMask } from './linkPick';

export type EdgePickRoute = 'native' | 'fallback';

/** Screen-space pick tolerance floor, and the probe distance used to measure
 * the screen→space scale. */
export const EDGE_PICK_TOLERANCE_PX = 4;

/** Median-width sampling cap (mirrors the median-length cap). */
const WIDTH_SAMPLE_CAP = 1024;

/** Per-slice chunked-build budget. */
const DEFAULT_BUILD_BUDGET_MS = 6;

/**
 * Median link width in px from a projected linkWidth buffer (deterministic
 * stride sample, cap 1024). Returns 0 for null/empty/non-finite input — the
 * 4px floor then wins in the tolerance formula.
 */
export function medianLinkWidthPx(widths: Float32Array | null): number {
  if (widths === null || widths.length === 0) return 0;
  const n = widths.length < WIDTH_SAMPLE_CAP ? widths.length : WIDTH_SAMPLE_CAP;
  const stride = widths.length / n;
  const sample: number[] = [];
  for (let k = 0; k < n; k++) {
    const w = widths[Math.floor(k * stride)]!;
    if (Number.isFinite(w)) sample.push(w);
  }
  if (sample.length === 0) return 0;
  sample.sort((a, b) => a - b);
  return sample[sample.length >> 1]!;
}

export interface EdgePickingFacadeOptions {
  /** Fixed for the facade's lifetime; read from capabilities at ready. */
  route: EdgePickRoute;
  /** Affine screen→space conversion; null = conversion unavailable. */
  screenToSpace: (p: readonly [number, number]) => readonly [number, number] | null;
  /** Median link width in px for the tolerance floor; default  => 0. */
  medianLinkWidthPx?: () => number;
  /** visibility mask pass-through stub (mutable via the setter). */
  linkVisible?: LinkVisibilityMask;
  /** Chunked-build slice budget in ms. */
  buildBudgetMs?: number;
  /** Scheduler for build continuation slices (test seam). */
  schedule?: (continueBuild: () => void) => void;
  /** Clock for the build budget (test seam). */
  now?: () => number;
}

const defaultSchedule = (continueBuild: () => void): void => {
  setTimeout(continueBuild, 0);
};

const defaultNow: () => number =
  typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

export class EdgePickingFacade {
  /** The route this mount session committed to at ready. */
  readonly route: EdgePickRoute;

  private readonly screenToSpace: (
    p: readonly [number, number],
  ) => readonly [number, number] | null;
  private readonly medianWidthPx: () => number;
  private readonly budgetMs: number;
  private readonly schedule: (continueBuild: () => void) => void;
  private readonly now: () => number;
  private readonly index = new LinkPickIndex();
  private mask: LinkVisibilityMask | null;
  /** Bumped by disarm/arm/destroy; abandons any in-flight chunked build. */
  private generation = 0;

  constructor(opts: EdgePickingFacadeOptions) {
    this.route = opts.route;
    this.screenToSpace = opts.screenToSpace;
    this.medianWidthPx = opts.medianLinkWidthPx ?? (() => 0);
    this.mask = opts.linkVisible ?? null;
    this.budgetMs = opts.buildBudgetMs ?? DEFAULT_BUILD_BUDGET_MS;
    this.schedule = opts.schedule ?? defaultSchedule;
    this.now = opts.now ?? defaultNow;
  }

  /** True when the fallback grid is built and answering queries. */
  get armed(): boolean {
    return this.route === 'fallback' && this.index.isBuilt;
  }

  /**
   * (Re-)arm from a settled position snapshot. `positions`/`links` must be
   * stable snapshots — the grid references them until the next rebuild.
   * No-op on the native route.
   */
  arm(positions: Float32Array, links: Uint32Array): void {
    if (this.route !== 'fallback') return;
    const gen = ++this.generation;
    const it = this.index.buildChunked(positions, links, this.budgetMs, this.now);
    const step = (): void => {
      if (gen !== this.generation) return; // superseded or disarmed
      if (!it.next().done) this.schedule(step);
    };
    step();
  }

  /** Simulation went hot: drop the grid; queries null until the next settle. */
  disarm(): void {
    if (this.route !== 'fallback') return;
    this.generation++;
    this.index.invalidate();
  }

  /** mask pass-through stub: applied per candidate at query time. */
  setLinkVisibilityMask(mask: LinkVisibilityMask | null): void {
    this.mask = mask;
  }

  /**
   * Nearest link index within tolerance of a SCREEN point, or null when: on
   * the native route, disarmed (sim hot / not yet settled), no conversion,
   * or nothing in range.
   */
  pickLinkAt(screen: readonly [number, number]): number | null {
    if (!this.armed) return null;
    const p = this.screenToSpace(screen);
    if (p === null) return null;
    // tolerance conversion: measure the screen→space scale from two
    // points EDGE_PICK_TOLERANCE_PX apart.
    const probe = this.screenToSpace([screen[0] + EDGE_PICK_TOLERANCE_PX, screen[1]]);
    if (probe === null) return null;
    const pxToSpace =
      Math.hypot(probe[0] - p[0], probe[1] - p[1]) / EDGE_PICK_TOLERANCE_PX;
    const tolPx = Math.max(EDGE_PICK_TOLERANCE_PX, this.medianWidthPx() / 2);
    return this.index.nearestLink(p[0], p[1], tolPx * pxToSpace, this.mask ?? undefined);
  }

  /** Abandon any in-flight build and drop the grid (session teardown). */
  destroy(): void {
    this.generation++;
    this.index.invalidate();
  }
}
