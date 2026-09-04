/**
 * CosmosEngine — GraphEngine adapter over @cosmos.gl/graph.
 *
 * Node-safe module: cosmos is loaded lazily via `await import` inside
 * `mount`; module scope carries only type-only imports (erased at
 * runtime) and never touches the DOM.
 *
 * Color scale note: the EngineCommit contract carries RGBA floats in [0,1],
 * which is exactly cosmos' native scale (verified against the 3.3.0 dist:
 * hex config colors are parsed via /255 into 0–1 floats and setPointColors
 * input is fed to GPU buffers untouched) — so color buffers pass through.
 *
 * Interaction notes (verified against the 3.3.0 dist):
 * - Link picking is native: setting any onLink* config callback flips
 * cosmos' internal `isLinkHoveringEnabled` on, so wiring the callbacks in
 * `buildInitialConfig` is sufficient (no extra config flag exists).
 * - `findPointsInPolygon` takes SCREEN coordinates ("from 0 to the
 * width/height of the canvas" per dist/index.d.ts), so `pointsInPolygon`
 * passes the host's screen polygon through without conversion.
 * - `findPointsInRect` uses the SAME screen space and expects ordered
 * corners `[[left, top], [right, bottom]]` (the dist flips Y assuming that
 * ordering), so `pointsInRect` normalizes the host's [x0,y0,x1,y1] rect to
 * min/max corners and passes it through without conversion.
 * - Camera pan (the earlier zoom-only limitation is LIFTED): cosmos 3.3 has no
 * pan-to API, but `setZoomTransformByPointPositions(positions, duration,
 * scale, padding)` (dist/index.d.ts) is an exact center+zoom when `scale`
 * is explicit. Derivation from the dist (`zoomInstance.getTransform`):
 * space→screen-at-k=1 goes through `store.scaleX/scaleY`, which are LINEAR
 * with slope ±1 (scaleX(x) = x + (w−S)/2; scaleY(y) = (S−y) + (h−S)/2,
 * S = adjustedSpaceSize, w/h = canvas size); a single-point bbox is widened
 * ±0.5 SYMMETRICALLY (center preserved); an explicit `scale` bypasses the
 * fit math and `padding` entirely — k = clamp(scale, d3 scaleExtent) and
 * the result is translate(w/2 − scaleX(x)·k, h/2 − scaleY(y)·k).scale(k),
 * i.e. space point (x, y) lands exactly at the screen center with
 * eventTransform.k = scale. Since `getZoomLevel()` returns eventTransform.k
 * and `getViewport()` reads screenToSpacePosition(screen center),
 * `setViewport({x, y, zoom})` → setZoomTransformByPointPositions(
 * Float32Array.of(x, y), durationMs ?? 0, zoom ?? getZoomLevel()) makes a
 * follow-up `getViewport()` return exactly {x, y, zoom} (modulo the
 * scaleExtent clamp). This also completes recovery: the core replays
 * the full stored {x, y, zoom} through setViewport, so viewport restore is
 * no longer zoom-only.
 * - Context menu: cosmos fires the unified config `onContextMenu(index |
 * undefined, pos, event)` exactly ONCE per gesture — desktop right-click
 * (dist `onContextMenu(e)`) and touch/pen long-press (dist long-press timer
 * → `fireContextMenu`) both route through it — while the per-target
 * `onPointContextMenu`/`onLinkContextMenu`/`onBackgroundContextMenu`
 * callbacks fire ADDITIONALLY for the same gesture. Wiring only the unified
 * callback therefore avoids a double-report (same shape as the
 * onClick/onBackgroundClick dedupe). A context menu over a LINK arrives
 * with index undefined and is reported as background (the host event
 * carries node-or-background only).
 *
 * GATED overlay/activity clock:
 * cosmos still exposes no draw/render-phase hook (`postDrawFrames: false`),
 * so the adapter owns the single requestAnimationFrame loop that reports
 * `onFrame(timeMs)` to the host — an ACTIVITY clock, not a post-draw hook:
 * overlays may lag the canvas by one sample (reported once at mount via
 * `engine:overlay-activity-clock`). Since cosmos 3.4 idle-stops its own
 * rendering (on-demand rendering, quiescence probe: 0 idle frames/750ms),
 * this clock is GATED to match — it free-runs only while a run reason is
 * held (sim hot via onSimulationStart/Pause/Unpause/End, drag gestures,
 * cosmos transitions) and otherwise burns a small one-shot tick budget that
 * every visual write re-arms (commits, highlight/focus/pin setters, camera
 * moves, hover events; animated camera moves self-sustain through per-step
 * onZoom bursts). Releasing a run reason always grants ONE trailing tick
 * the releasing activity's final GPU write lands after the current draw
 * pass. At rest: zero rAF registrations from cosmos AND from this adapter
 * (`capabilities.idleFrames: 'stops'`). The clock stops on context
 * loss/destroy, re-arms on recovery, and skips the callback (keeping its
 * schedule) while `document.hidden`.
 *
 * Screenshots use the same-tick capture method (apps/spike/src/instrument.ts):
 * cosmos renders with preserveDrawingBuffer:false, so the WebGL buffer is only
 * readable via a synchronous drawImage inside the same rAF tick it was drawn
 * `captureScreenshot` schedules one rAF, draws the cosmos canvas onto an
 * offscreen 2D canvas inside that tick, and resolves the Blob (null on any
 * failure or unusable lifecycle state).
 * - The D3 drag events carry NO point index (the drag subject is a bare
 * `{x, y}`); cosmos assigns `store.draggingPointIndex` immediately before
 * invoking `onDragStart`, so the adapter reads it there (see
 * `readDraggingIndex` for the public-callback fallback).
 * - During a drag, cosmos' drag shader hard-pins the dragged point's
 * position texture entry to the mouse's SPACE position every frame
 * (dist `drag`: `pointPosition.rg = mousePos` where `mousePos` =
 * screenToSpace(pointer)). So the point's final space position equals
 * `screenToSpacePosition([event.x, event.y])` at drag end — an O(1) CPU
 * transform, chosen over `getPointPositions` (full GPU readback).
 */

import type { Graph as CosmosGraph, GraphConfig } from '@cosmos.gl/graph';
import type {
  EngineCapabilities,
  EngineCommit,
  EngineHostEvents,
  FitViewOptions,
  GraphEngine,
} from '@modernrelay/orbit-core/engine';
import { RestoreDeadline } from './restoreDeadline';

/** Derived from the contract to avoid importing the core root barrel. */
type ViewportState = NonNullable<ReturnType<GraphEngine['getViewport']>>;

/**
 * Structural view of cosmos' `graph.store` — private in the 3.3.0 d.ts but a
 * stable runtime field. `draggingPointIndex` is assigned right before cosmos
 * invokes `onDragStart` (verified in the dist), making it the authoritative
 * dragged-point source; `hoveredPoint` mirrors the public onPointMouseOver
 * payload.
 */
interface CosmosStoreLike {
  hoveredPoint?: { index: number; position: [number, number] };
  draggingPointIndex?: number;
}

/**
 * Exact-pin 3.4.0 camera seam: private in the d.ts, but the runtime helper
 * used by native fitView. It reads transition destinations while positions
 * animate and live GPU positions otherwise. Using the same helper keeps
 * the clamp decision and native fallback on the same coordinate snapshot.
 * The real-engine transition regression pins this dependency.
 */
interface CosmosFitViewReader {
  getFitViewPositions(): Float32Array;
}

/**
 * Extracts click modifiers from a cosmos-forwarded event. Duck-typed rather
 * than `instanceof MouseEvent`: node-safe and cross-realm-safe. Returns
 * undefined when the event carries no modifier state.
 */
function clickModifiers(event: unknown): { metaKey: boolean; shiftKey: boolean } | undefined {
  const e = event as { metaKey?: unknown; shiftKey?: unknown } | null | undefined;
  if (e && typeof e.metaKey === 'boolean' && typeof e.shiftKey === 'boolean') {
    return { metaKey: e.metaKey, shiftKey: e.shiftKey };
  }
  return undefined;
}

export interface CosmosEngineOptions {
  /** Simulation space size passed to cosmos (cosmos default: 4096). */
  spaceSize?: number;
  /** Ring radius for seeding unknown (NaN) positions. Default: spaceSize/4. */
  seedRadius?: number;
  /** Whether cosmos auto-fits the view on init. Default: false (the core drives the camera). */
  fitViewOnInit?: boolean;
  /** Native point dragging (cosmos `enableDrag`). Default: true. */
  enableDrag?: boolean;
  /** Escape hatch: shallow-merged last into the cosmos constructor config. */
  initialConfig?: Record<string, unknown>;
  /**
   * Visible-time budget (ms) for the browser to restore a lost WebGL context
   * before an `engine:context-restore-deadline` diagnostic is emitted. The
   * deadline is observability only — a later restore still recovers.
   * Default: 10_000.
   */
  restoreDeadlineMs?: number;
}

/** cosmos' own default `spaceSize` (see @cosmos.gl/graph config defaults). */
const DEFAULT_SPACE_SIZE = 4096;

/** Default visible-time budget before the restore-deadline diagnostic. */
const DEFAULT_RESTORE_DEADLINE_MS = 10_000;

/** image-atlas channel of an EngineCommit (adapter-local alias). */
type EngineResources = NonNullable<EngineCommit['resources']>;

export class CosmosEngine implements GraphEngine {
  readonly capabilities: EngineCapabilities = {
    // Evidence-backed flip: the probe measured native onLinkClick/
    // onLinkMouseOver delivering correct link indices with ~4px perpendicular
    // tolerance.
    linkPicking: true,
    rangeUpdates: [],
    trackedPositions: true,
    simulation: true,
    // cosmos 3.3.0 exposes the `linkDefaultArrows` config key
    // (config.d.ts) — instanced arrowheads toggle atomically via setConfigPartial.
    edgeArrows: true,
    // cosmos 3.3.0 exposes setImageData(ImageData[]) +
    // setPointImageIndices(Float32Array) (index.d.ts) — per-point sprites via
    // an adapter-maintained slot→ImageData atlas.
    pointImages: true,
    // stage 4: cosmos 3.3.0 ships a real GPU cluster force
    // `setPointClusters((number|undefined)[])`, `setClusterPositions(
    // (number|undefined)[])`, `setPointClusterStrength(Float32Array)`
    // (index.d.ts) plus the `simulationCluster` coefficient (config.d.ts,
    // default 0.1) and the `Clusters` core module (dist/modules/Clusters).
    // `undefined` is cosmos' documented "not in any cluster" value, which the
    // adapter maps from the contract's NaN.
    clusterForce: true,
    // stop-at-rest: cosmos 3.4.0 ships on-demand rendering — the M0
    // quiescence row measured 0 idle frames AND 0 rAF registrations per
    // 750ms at rest.
    // The adapter's own activity clock is gated to match.
    idleFrames: 'stops',
    // onFrame is an activity clock, not an exact post-draw hook — cosmos
    // still exposes no public frame hook (probe `post-draw-frames`);
    // overlays may lag one sample.
    postDrawFrames: false,
  };

  private readonly options: CosmosEngineOptions;
  private graph: CosmosGraph | null = null;
  private innerDiv: HTMLDivElement | null = null;
  private events: EngineHostEvents | null = null;
  /**
   * Pre-mount/lost-context commits collapse per channel and are applied as one
   * atomic commit once a usable graph exists.
   */
  private pendingCommit: EngineCommit | null = null;
  private applied: number | null = null;
  private destroyed = false;
  private mounting = false;
  /** Constructed graph whose `ready` promise has not settled yet. */
  private graphAwaitingReady: CosmosGraph | null = null;
  /** Guards every graph teardown, including async init/recovery races. */
  private readonly destroyedGraphs = new WeakSet<CosmosGraph>();
  /** Sticky override from EngineConfigUpdate.seedRadius. */
  private seedRadiusOverride: number | undefined;
  /** Point count of the last structure-bearing commit — the roster length a
   * `cluster: null` clear must write an all-unclustered array for. */
  private lastPointCount = 0;
  /**
   * cosmos fires `onClick` (index undefined) AND `onBackgroundClick` for the
   * same background click; remembering the MouseEvent dedupes the null emit.
   */
  private lastNullClickEvent: unknown = null;
  /** Point latched at cosmos onDragStart; cleared when the gesture ends. */
  private dragIndex: number | null = null;
  /** Last hover reported by cosmos — fallback dragged-point source. */
  private lastHoverIndex: number | null = null;
  /** Live native link hover gates the unified onClick's
   * background interpretation — a hovered link owns the click). */
  private hoveredLinkIndex: number | null = null;

  // --- adapter-owned GATED overlay/activity clock (see module header) ---

  /** rAF id of the pending activity-clock tick; null = clock not running. */
  private frameHandle: number | null = null;
  /** Window driving the clock, cached so stop works after the div detaches. */
  private frameWindow: Window | null = null;
  /** Continuous-run reasons; the clock free-runs while any is held. */
  private readonly runReasons = new Set<'sim' | 'drag' | 'transition'>();
  /** One-shot tick budget for write/interaction re-arm bursts. */
  private pendingTicks = 0;
  /** One-shot guard for the repulsionTheta deprecation diagnostic. */
  private repulsionThetaWarned = false;

  // --- WebGL context-loss recovery state ---

  /** cosmos' canvas (queried post-mount) carrying the webglcontext* listeners. */
  private canvas: HTMLCanvasElement | null = null;
  private contextLost = false;
  /** Terminal: GL reinitialization failed; commits stash inertly forever. */
  private failed = false;
  private deadline: RestoreDeadline | null = null;
  /** Graph constructor cached at mount so recovery never re-imports cosmos. */
  private cosmosCtor: (new (div: HTMLDivElement, config?: GraphConfig) => CosmosGraph) | null =
    null;

  // --- image atlas (capability pointImages) ---

  /**
   * slot → ImageData mirror of the cosmos image atlas. ImageData is CPU-side,
   * so the mirror survives context loss — any post-restore atlas commit
   * re-uploads the FULL array to the fresh graph. `null` = removed (blank).
   */
  private imageSlots: (ImageData | null)[] = [];
  /** Lazily created 1×1 transparent entry filling removed/hole slots. */
  private blankImage: ImageData | null = null;
  /** One-shot guard for the `engine:image-channel-unavailable` diagnostic. */
  private imageChannelUnavailable = false;

  constructor(options: CosmosEngineOptions = {}) {
    this.options = options;
  }

  async mount(container: HTMLElement, events: EngineHostEvents): Promise<void> {
    if (this.destroyed) throw new Error('CosmosEngine: mount() after destroy()');
    if (this.mounting || this.graph) throw new Error('CosmosEngine: mount() may only be called once');
    this.mounting = true;
    this.events = events;

    // cosmos wants a dedicated HTMLDivElement filling the host container.
    const div = container.ownerDocument.createElement('div');
    div.style.width = '100%';
    div.style.height = '100%';
    container.appendChild(div);
    this.innerDiv = div;

    let graph: CosmosGraph | null = null;
    try {
      // cosmos (and its WebGL dependencies) load only at mount time.
      const { Graph } = await import('@cosmos.gl/graph');
      // destroy may have landed while the dynamic import was pending.
      if (this.destroyed) {
        div.remove();
        return;
      }
      graph = new Graph(div, this.buildInitialConfig());
      this.graphAwaitingReady = graph;
      await graph.ready;
      if (this.graphAwaitingReady === graph) this.graphAwaitingReady = null;
      if (this.destroyed) {
        // destroy raced the async init; tear the graph down immediately.
        this.destroyGraphOnce(graph);
        div.remove();
        return;
      }
      this.graph = graph;
      this.cosmosCtor = Graph;
      this.attachContextListeners();
      // Documented degradation (M0): overlays ride an activity clock because
      // cosmos has no draw-phase hook. Emitted once, at mount only.
      events.onDiagnostic?.({
        code: 'engine:overlay-activity-clock',
        severity: 'info',
        message:
          'CosmosEngine: cosmos exposes no draw-phase hook (postDrawFrames:false); ' +
          'overlays ride an adapter-owned, idle-gated requestAnimationFrame activity ' +
          'clock (stops at rest — idleFrames:stops) and may lag the canvas by one frame.',
      });
      // cosmos 3.4 keeps rendering when the FPS monitor is shown — that
      // silently defeats the idleFrames:'stops' declaration, so say so once.
      if ((this.options.initialConfig as GraphConfig | undefined)?.showFPSMonitor) {
        events.onDiagnostic?.({
          code: 'engine:fps-monitor-defeats-quiescence',
          severity: 'info',
          message:
            'CosmosEngine: showFPSMonitor keeps cosmos rendering every frame; ' +
            'stop-at-rest quiescence is disabled while it is shown.',
        });
      }
      // Gated clock: no unconditional start — cosmos draws its own init
      // frame; a short burst lets overlays sample it, then the clock stops
      // until a wake source (commit/sim/gesture) re-arms it.
      this.requestTicks(2);
      const pending = this.pendingCommit;
      this.pendingCommit = null;
      if (pending) this.applyCommit(graph, pending);
    } catch (err) {
      if (graph !== null) {
        if (this.graph === graph) {
          this.stopFrameLoop();
          this.detachContextListeners();
          this.graph = null;
        }
        if (this.graphAwaitingReady === graph) this.graphAwaitingReady = null;
        this.destroyGraphOnce(graph);
      }
      div.remove();
      if (this.innerDiv === div) this.innerDiv = null;
      // destroy is terminal and already cleaned up the constructed graph;
      // a later ready rejection must not escape or notify stale hosts.
      if (this.destroyed) return;
      const error = err instanceof Error ? err : new Error(String(err));
      events.onError?.(error);
      throw error;
    }
  }

  commit(update: EngineCommit): void {
    if (this.destroyed) throw new Error('CosmosEngine: commit() after destroy()');
    const graph = this.activeGraph;
    if (!graph) {
      // Pre-mount, context-lost, or failed: retain the latest value of every
      // independently replaceable channel. The merged commit is flushed on
      // mount/restore (or remains inert forever after terminal failure).
      this.queueCommit(update);
      return;
    }
    this.applyCommit(graph, update);
  }

  appliedRevision(): number | null {
    return this.applied;
  }

  // --- camera ---
  // Every camera write re-arms the clock; ANIMATED moves then self-sustain
  // through cosmos' per-step onZoom events (each grants a fresh burst), so
  // no duration bookkeeping is needed here.

  fitView(opts?: FitViewOptions): void {
    const graph = this.activeGraph;
    if (!graph) return;
    const maxZoom = opts?.maxZoom;
    if (maxZoom !== undefined && Number.isFinite(maxZoom) && maxZoom > 0) {
      if (this.fitViewClamped(graph, maxZoom, opts)) return;
    }
    graph.fitView(opts?.durationMs, opts?.padding);
    this.requestTicks(2);
  }

  /**
   * Zoom-clamped fit: when the natural fit zoom would exceed `maxZoom`
   * (small scenes ballooning), center the scene bbox at `maxZoom` with one
   * animated transform instead. Returns false to fall back to the native
   * fit — unknown positions, detached container, or a fit that stays under
   * the bound anyway (cosmos then applies its own padding semantics).
   */
  private fitViewClamped(
    graph: NonNullable<CosmosEngine['graph']>,
    maxZoom: number,
    opts?: FitViewOptions,
  ): boolean {
    const div = this.innerDiv;
    if (div === null) return false;
    const w = div.clientWidth;
    const h = div.clientHeight;
    if (!(w > 0) || !(h > 0)) return false;
    const raw = (graph as unknown as CosmosFitViewReader).getFitViewPositions();
    if (raw.length === 0) return false;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const x = raw[i]!;
      const y = raw[i + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX > maxX || minY > maxY) return false;
    const padding = opts?.padding ?? 0.1;
    const availW = w * Math.max(0.1, 1 - 2 * padding);
    const availH = h * Math.max(0.1, 1 - 2 * padding);
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    // degenerate bbox (single point / colinear) fits at ANY zoom → clamp
    const fitZoom =
      bboxW <= 0 && bboxH <= 0
        ? Infinity
        : Math.min(bboxW > 0 ? availW / bboxW : Infinity, bboxH > 0 ? availH / bboxH : Infinity);
    if (fitZoom <= maxZoom) return false;
    graph.setZoomTransformByPointPositions(
      Float32Array.of((minX + maxX) / 2, (minY + maxY) / 2),
      opts?.durationMs ?? 250,
      maxZoom,
    );
    this.requestTicks(2);
    return true;
  }

  zoom(factor: number, durationMs?: number): void {
    const graph = this.activeGraph;
    if (!graph) return;
    graph.setZoomLevel(graph.getZoomLevel() * factor, durationMs);
    this.requestTicks(2);
  }

  /**
   * REAL pan (the former zoom-only limitation is lifted — see module header):
   * when a target center is provided, one `setZoomTransformByPointPositions`
   * call centers space point (x, y) at EXACTLY the requested (or current)
   * zoom — `setViewport(p)` then `getViewport()` returns p, modulo cosmos'
   * d3 scaleExtent clamp. A missing x or y is filled from the current
   * viewport; zoom-only calls keep the `setZoomLevel` path (d3's scaleTo
   * preserves the current center). Instant unless `durationMs` is given
   * cosmos' own default duration is 250 ms, which would animate context-
   * recovery replays.
   */
  setViewport(v: Partial<ViewportState>, opts?: { durationMs?: number }): void {
    const graph = this.activeGraph;
    if (!graph) return;
    if (v.x !== undefined || v.y !== undefined) {
      const current = v.x === undefined || v.y === undefined ? this.getViewport() : null;
      const x = v.x ?? current?.x;
      const y = v.y ?? current?.y;
      if (x !== undefined && y !== undefined) {
        graph.setZoomTransformByPointPositions(
          Float32Array.of(x, y),
          opts?.durationMs ?? 0,
          v.zoom ?? graph.getZoomLevel(),
        );
        this.requestTicks(2);
        return;
      }
      // No usable center (detached container): degrade to zoom-only below.
    }
    if (v.zoom !== undefined) graph.setZoomLevel(v.zoom, opts?.durationMs ?? 0);
    this.requestTicks(2);
  }

  getViewport(): ViewportState | null {
    const graph = this.activeGraph;
    const div = this.innerDiv;
    if (!graph || !div) return null;
    const [x, y] = graph.screenToSpacePosition([div.clientWidth / 2, div.clientHeight / 2]);
    return { x, y, zoom: graph.getZoomLevel() };
  }

  zoomToIndex(index: number, durationMs?: number): void {
    this.activeGraph?.zoomToPointByIndex(index, durationMs);
    this.requestTicks(2);
  }

  // --- simulation ---

  start(alpha?: number): void {
    // cosmos fires onSimulationStart (→ wake) — the direct wake covers a
    // callback wiring gap and is idempotent through the Set.
    this.wake('sim');
    this.activeGraph?.start(alpha);
  }

  pause(): void {
    this.sleep('sim');
    this.activeGraph?.pause();
  }

  // --- built-in interaction visuals ---

  setSelectedIndices(indices: readonly number[] | null): void {
    const graph = this.activeGraph;
    if (!graph) return;
    // cosmos 3.3 has no imperative select/unselect API; selection visuals are
    // config-driven — points NOT in `highlightedPointIndices` grey out, and an
    // explicit `undefined` resets the key (clears highlighting) per
    // setConfigPartial semantics.
    graph.setConfigPartial({
      highlightedPointIndices: indices === null ? undefined : Array.from(indices),
    } as unknown as GraphConfig);
    this.requestTicks(2); // write re-arm: overlays sample the new state
  }

  setFocusedIndex(index: number | null): void {
    const graph = this.activeGraph;
    if (!graph) return;
    graph.setConfigPartial({
      focusedPointIndex: index === null ? undefined : index,
    } as unknown as GraphConfig);
    this.requestTicks(2);
  }

  // --- spatial queries & pinning ---

  pointsInPolygon(screenPolygon: readonly [number, number][]): number[] {
    const graph = this.activeGraph;
    if (!graph) return [];
    // cosmos' findPointsInPolygon already expects SCREEN coordinates (0 to
    // canvas width/height per the 3.3.0 d.ts) — no conversion; copy the pairs
    // only to satisfy cosmos' mutable-signature and shield the caller's input.
    return graph.findPointsInPolygon(screenPolygon.map(([x, y]): [number, number] => [x, y]));
  }

  pointsInRect(screenRect: readonly [number, number, number, number]): number[] {
    const graph = this.activeGraph;
    if (!graph) return [];
    // cosmos' findPointsInRect expects SCREEN coordinates (0 to canvas
    // width/height — the same space as findPointsInPolygon per the 3.3.0
    // d.ts) as ordered corners [[left, top], [right, bottom]] (the dist flips
    // Y assuming that ordering) — normalize so any opposite-corner pair works.
    const [x0, y0, x1, y1] = screenRect;
    return graph.findPointsInRect([
      [Math.min(x0, x1), Math.min(y0, y1)],
      [Math.max(x0, x1), Math.max(y0, y1)],
    ]);
  }

  neighborIndices(index: number): number[] {
    const graph = this.activeGraph;
    if (!graph) return [];
    // cosmos dedupes but a self-loop can report the point as its own neighbor.
    return graph.getNeighboringPointIndices(index).filter((i) => i !== index);
  }

  screenToSpace(p: readonly [number, number]): [number, number] | null {
    const graph = this.activeGraph;
    return graph ? graph.screenToSpacePosition([p[0], p[1]]) : null;
  }

  spaceToScreen(p: readonly [number, number]): [number, number] | null {
    const graph = this.activeGraph;
    return graph ? graph.spaceToScreenPosition([p[0], p[1]]) : null;
  }

  setPinnedIndices(indices: readonly number[] | null): void {
    // Full-set replace, idempotent; null and [] both unpin all (cosmos treats
    // them identically). Pin re-application after recovery is core-owned.
    this.activeGraph?.setPinnedPoints(indices === null ? null : Array.from(indices));
    this.requestTicks(2);
  }

  // --- readback ---

  getPositions(): Float32Array | null {
    const graph = this.activeGraph;
    return graph ? Float32Array.from(graph.getPointPositions()) : null;
  }

  /**
   * Captures the cosmos canvas via the same-tick method (see module
   * header): one rAF is scheduled and, inside that tick, the WebGL canvas is
   * drawn synchronously onto an offscreen 2D canvas (cosmos renders with
   * preserveDrawingBuffer:false, so the buffer is only readable same-tick).
   * Resolves null on any failure or unusable lifecycle state (pre-mount,
   * context lost/failed, destroyed, no 2D context, toBlob failure).
   */
  captureScreenshot(): Promise<Blob | null> {
    const graph = this.activeGraph;
    const canvas = graph ? this.canvas : null;
    const win = canvas?.ownerDocument.defaultView ?? null;
    if (!graph || !canvas || !win || typeof win.requestAnimationFrame !== 'function') {
      return Promise.resolve(null);
    }
    // Under on-demand rendering (cosmos >= 3.4) an idle scene draws nothing,
    // and with preserveDrawingBuffer:false an undrawn buffer reads blank
    // render is a visual mutator that schedules the frame our capture rAF
    // then samples same-tick.
    try {
      graph.render();
    } catch {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      win.requestAnimationFrame(() => {
        // Re-check: loss/destroy (or a restore swapping in a new canvas) may
        // have landed between scheduling and this tick.
        if (this.destroyed || !this.activeGraph || this.canvas !== canvas) {
          resolve(null);
          return;
        }
        try {
          const off = canvas.ownerDocument.createElement('canvas');
          off.width = canvas.width;
          off.height = canvas.height;
          const ctx = off.getContext('2d');
          if (!ctx) {
            resolve(null);
            return;
          }
          ctx.drawImage(canvas, 0, 0);
          off.toBlob((blob) => {
            resolve(blob);
          });
        } catch {
          resolve(null);
        }
      });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    // Set first: if a context-restore reinit is mid-await, it observes the
    // flag, destroys the graph it just built, and emits nothing.
    this.destroyed = true;
    this.stopFrameLoop();
    this.deadline?.cancel();
    this.deadline = null;
    this.detachContextListeners();
    const graph = this.graph;
    this.graph = null;
    this.destroyGraphOnce(graph);
    const awaiting = this.graphAwaitingReady;
    this.graphAwaitingReady = null;
    this.destroyGraphOnce(awaiting);
    this.innerDiv?.remove();
    this.innerDiv = null;
    this.events = null;
    this.pendingCommit = null;
    this.imageSlots = [];
    this.blankImage = null;
  }

  // --- gated overlay/activity clock (see module header) ---

  /**
   * One rAF tick of the gated activity clock. Ordering is load-bearing:
   * 1. the tick budget is consumed BEFORE the host callback runs, so work
   * scheduled from inside onFrame re-arms a fresh tick instead of being
   * coalesced away;
   * 2. the reschedule/stop decision is made BEFORE the host callback, so a
   * throwing host can never kill a should-keep-running clock (and a
   * stopping clock stays stopped even if the callback wakes it — the
   * wake starts a new loop via requestTicks/wake, not this handle).
   * Skips the callback (but keeps its schedule) while the document is hidden.
   */
  private readonly frameTick = (timeMs: number): void => {
    const win = this.frameWindow;
    if (!win || this.frameHandle === null) return;
    if (this.pendingTicks > 0) this.pendingTicks -= 1;
    const keepRunning = this.runReasons.size > 0 || this.pendingTicks > 0;
    this.frameHandle = keepRunning ? win.requestAnimationFrame(this.frameTick) : null;
    if (!keepRunning) this.frameWindow = null;
    if (!win.document.hidden) this.events?.onFrame?.(timeMs);
  };

  /** Hold the clock open for a continuous activity (sim/drag/transition). */
  private wake(reason: 'sim' | 'drag' | 'transition'): void {
    this.runReasons.add(reason);
    this.ensureFrameLoop();
  }

  /**
   * Release a continuous-run reason. ALWAYS grants one trailing tick: the
   * releasing activity's final GPU write lands after the current draw pass
   * (the upstream drag-release bug class), so overlays need one more sample.
   */
  private sleep(reason: 'sim' | 'drag' | 'transition'): void {
    this.runReasons.delete(reason);
    this.requestTicks(1);
  }

  /**
   * Grant a one-shot tick budget (write/interaction re-arm). Two ticks is
   * the standard write burst: ordering between this clock's rAF callback and
   * cosmos' internal render frame within one tick is unguaranteed, so the
   * second tick guarantees overlays sample post-draw state (consistent with
   * the documented may-lag-one-sample degradation).
   */
  private requestTicks(n: number): void {
    if (this.destroyed || this.contextLost || this.failed || !this.graph) return;
    this.pendingTicks = Math.max(this.pendingTicks, n);
    this.ensureFrameLoop();
  }

  private ensureFrameLoop(): void {
    if (this.destroyed || this.frameHandle !== null) return;
    const win = this.innerDiv?.ownerDocument.defaultView ?? null;
    // No window / no rAF (detached document, exotic embedder): no clock — the
    // engine keeps working, overlays simply get no ticks.
    if (!win || typeof win.requestAnimationFrame !== 'function') return;
    this.frameWindow = win;
    this.frameHandle = win.requestAnimationFrame(this.frameTick);
  }

  private stopFrameLoop(): void {
    if (this.frameHandle !== null) {
      this.frameWindow?.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.frameWindow = null;
    this.runReasons.clear();
    this.pendingTicks = 0;
  }

  // --- WebGL context-loss recovery ---

  /** The graph, unless it is unusable (context lost / terminally failed). */
  private get activeGraph(): CosmosGraph | null {
    return this.contextLost || this.failed ? null : this.graph;
  }

  /**
   * cosmos owns its canvas; we can only wire webglcontext* listeners after
   * init by querying it. A missing canvas downgrades to an info diagnostic
   * the engine keeps working, just without context-loss recovery.
   */
  private attachContextListeners(): void {
    const canvas = this.innerDiv?.querySelector('canvas') ?? null;
    if (!canvas) {
      this.events?.onDiagnostic?.({
        code: 'engine:context-listeners-unavailable',
        severity: 'info',
        message:
          'CosmosEngine: no <canvas> found in the cosmos container; WebGL context-loss recovery is disabled.',
      });
      return;
    }
    this.canvas = canvas;
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  private detachContextListeners(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.canvas = null;
  }

  /** DOM listener: nothing may throw out of it. */
  private readonly handleContextLost = (event: Event): void => {
    try {
      // preventDefault signals the browser that restoration is wanted; it must
      // run even on states we otherwise ignore.
      event.preventDefault();
      if (this.destroyed || this.failed || this.contextLost) return;
      this.contextLost = true;
      // The GL machine is dead: pause the activity clock until recovery.
      this.stopFrameLoop();
      // Any in-flight gesture died with the context; drop its latched state.
      this.dragIndex = null;
      this.lastHoverIndex = null;
      try {
        this.graph?.pause();
      } catch {
        // pausing a dead-context graph is best-effort only
      }
      this.startRestoreDeadline();
      this.events?.onContextEvent?.({ type: 'lost' });
    } catch {
      // swallow: DOM listeners must never throw
    }
  };

  /** DOM listener: nothing may throw out of it (async work is caught below). */
  private readonly handleContextRestored = (): void => {
    if (this.destroyed || this.failed || !this.contextLost) return;
    this.reinitializeAfterRestore().catch((err: unknown) => {
      if (this.destroyed) return;
      this.failed = true;
      const error = err instanceof Error ? err : new Error(String(err));
      try {
        this.events?.onContextEvent?.({ type: 'failed', error });
      } catch {
        // swallow: host callback errors must not become unhandled rejections
      }
    });
  };

  /**
   * cosmos cannot reuse a restored context (its GPU resources are gone), so
   * recovery = tear down the old Graph and build a fresh one in the same div,
   * flush the stashed commit, and only then report `restored` — the core
   * re-commits the full scene in response.
   */
  private async reinitializeAfterRestore(): Promise<void> {
    this.deadline?.cancel();
    this.deadline = null;
    this.detachContextListeners();
    const oldGraph = this.graph;
    this.graph = null;
    this.destroyGraphOnce(oldGraph);
    const div = this.innerDiv;
    const Ctor = this.cosmosCtor;
    if (!div || !Ctor) return; // destroy() raced ahead of us
    const graph = new Ctor(div, this.buildInitialConfig());
    this.graphAwaitingReady = graph;
    try {
      await graph.ready;
      if (this.graphAwaitingReady === graph) this.graphAwaitingReady = null;
      if (this.destroyed) {
        // destroy landed mid-reinit: tear down the new graph, emit nothing.
        this.destroyGraphOnce(graph);
        return;
      }

      // Activation is one failure boundary. If listener wiring, frame-loop
      // startup, pending-channel upload, or restored delivery throws, the
      // replacement must not survive as an inert failed graph.
      this.graph = graph;
      this.attachContextListeners(); // the new Graph made a new canvas
      this.contextLost = false;
      // Gated clock: the fresh graph starts paused; the stashed commit (and
      // the core's full replay after `restored`) re-arm via requestTicks
      // no unconditional restart, no re-diagnostic.
      this.requestTicks(2);
      const pending = this.pendingCommit;
      this.pendingCommit = null;
      if (pending) this.applyCommit(graph, pending);
      // Emit only after the stashed commit is visible: `restored` promises a
      // commit-ready engine whose applied revision is consistent.
      this.events?.onContextEvent?.({ type: 'restored' });
    } catch (err) {
      if (this.graphAwaitingReady === graph) this.graphAwaitingReady = null;
      this.stopFrameLoop();
      if (this.graph === graph) {
        this.detachContextListeners();
        this.graph = null;
      }
      this.destroyGraphOnce(graph);
      throw err;
    }
  }

  private startRestoreDeadline(): void {
    const doc = this.canvas?.ownerDocument;
    if (!doc) return;
    const ms = this.options.restoreDeadlineMs ?? DEFAULT_RESTORE_DEADLINE_MS;
    const deadline = new RestoreDeadline(doc, ms, () => {
      // Observability only: listeners stay mounted, state is unchanged, and a
      // late restore still recovers.
      this.deadline = null;
      this.events?.onDiagnostic?.({
        code: 'engine:context-restore-deadline',
        severity: 'warning',
        message: `CosmosEngine: WebGL context was not restored within ${ms}ms of visible time.`,
      });
    });
    this.deadline = deadline;
    deadline.start();
  }

  // -------------------------------------------------------------------------

  /**
   * Coalesces partial commits without discarding independent channels. The
   * newest call supplies the visible revision; structure is one atomic
   * channel, buffers/config merge per field, and restart persists until a
   * later explicit directive (including `false`) replaces it.
   */
  private queueCommit(update: EngineCommit): void {
    // EngineCommit's caller-owned array views expire when commit() returns.
    // A pre-mount/lost-context commit outlives that boundary, so snapshot the
    // complete payload before either retaining it directly or folding it into
    // an earlier pending commit. ImageBitmap handles are intentionally kept by
    // reference; only their caller-owned container objects are copied.
    const ownedUpdate = cloneCommitForQueue(update);
    const previous = this.pendingCommit;
    if (previous === null) {
      this.pendingCommit = ownedUpdate;
      return;
    }

    const merged: EngineCommit = { revision: ownedUpdate.revision };

    const structure = ownedUpdate.structure ?? previous.structure;
    if (structure !== undefined) merged.structure = structure;

    if (previous.buffers !== undefined || ownedUpdate.buffers !== undefined) {
      merged.buffers = { ...previous.buffers, ...ownedUpdate.buffers };
    }

    if (
      previous.bufferPatches !== undefined ||
      ownedUpdate.bufferPatches !== undefined
    ) {
      merged.bufferPatches = {
        ...previous.bufferPatches,
        ...ownedUpdate.bufferPatches,
      };
    }

    if (previous.config !== undefined || ownedUpdate.config !== undefined) {
      const config = { ...previous.config, ...ownedUpdate.config };
      if (
        previous.config?.simulation !== undefined ||
        ownedUpdate.config?.simulation !== undefined
      ) {
        config.simulation = {
          ...previous.config?.simulation,
          ...ownedUpdate.config?.simulation,
        };
      }
      merged.config = config;
    }

    if (previous.resources !== undefined || ownedUpdate.resources !== undefined) {
      merged.resources = mergeResources(previous.resources, ownedUpdate.resources);
    }

    // Contract: `restart: false` and an ABSENT restart are
    // equivalent no-ops ("false/absent = keep state") — so neither cancels a
    // pending queued restart directive; only a new {alpha} replaces it.
    const restart =
      ownedUpdate.restart !== undefined && ownedUpdate.restart !== false
        ? ownedUpdate.restart
        : previous.restart;
    if (restart !== undefined) merged.restart = restart;

    this.pendingCommit = merged;
  }

  /** Invokes a graph's destructor at most once, even across async races. */
  private destroyGraphOnce(graph: CosmosGraph | null): void {
    if (graph === null || this.destroyedGraphs.has(graph)) return;
    this.destroyedGraphs.add(graph);
    try {
      graph.destroy();
    } catch {
      // Teardown is best-effort, but no later path may invoke it again.
    }
  }

  private get spaceSize(): number {
    // The escape hatch is applied last in the constructor config, so a
    // spaceSize there is what cosmos actually uses — mirror it for seeding.
    const fromInitial = this.options.initialConfig?.['spaceSize'];
    if (typeof fromInitial === 'number') return fromInitial;
    return this.options.spaceSize ?? DEFAULT_SPACE_SIZE;
  }

  private get seedRadius(): number {
    return this.seedRadiusOverride ?? this.options.seedRadius ?? this.spaceSize / 4;
  }

  private buildInitialConfig(): GraphConfig {
    const base: GraphConfig = {
      // Default false: the core owns the camera (fitView is driven explicitly).
      fitViewOnInit: this.options.fitViewOnInit ?? false,
      // cosmos 3.4 defaults this to true. Pinned OFF for the 3.4 upgrade:
      // occlusion culling changes which overlapping pixels draw, and the M5
      // pixel-diff thresholds (CHANGED_MIN/RESTORED_MAX) were tuned against
      // un-culled rendering. Keep one variable at a time; enabling culling
      // requires its own threshold re-validation.
      pointOcclusionCulling: false,
      // Native point dragging; the core owns pin semantics on top.
      enableDrag: this.options.enableDrag ?? true,
      onPointClick: (index, _position, event) => {
        this.events?.onPointClick?.(index, clickModifiers(event));
      },
      onBackgroundClick: (event) => {
        // Same guard as the unified onClick below: a hovered link
        // owns the gesture regardless of which cosmos channel reports it.
        if (this.hoveredLinkIndex === null) this.emitNullPointClick(event);
      },
      // onClick fires for every canvas click; an undefined index means no
      // point was hit (background clicks — link clicks arrive via onLinkClick).
      onClick: (index, _position, event) => {
        // A link click also reaches here with index undefined
        // (no POINT was hit), so treating every undefined as background
        // cleared selection on every edge click. A hovered link means the
        // gesture targets the link — cosmos's ~4px hover tolerance IS its
        // click tolerance — and onLinkClick delivers it; only a no-point,
        // no-link click is background.
        if (index === undefined && this.hoveredLinkIndex === null) {
          this.emitNullPointClick(event);
        }
      },
      // Unified context-menu channel: fires exactly once per gesture (desktop
      // right-click AND touch long-press — cosmos synthesizes the latter);
      // the per-target onPoint/onLink/onBackgroundContextMenu callbacks fire
      // ADDITIONALLY for the same gesture, so only this one is wired (see
      // module header). index undefined = background (or a link).
      onContextMenu: (index, _position, event) => {
        this.handleContextMenu(index, event);
      },
      onPointMouseOver: (index) => {
        this.lastHoverIndex = index;
        this.requestTicks(1); // overlay resync (tooltip/ring anchors)
        this.events?.onPointHover?.(index);
      },
      onPointMouseOut: () => {
        this.lastHoverIndex = null;
        this.requestTicks(1);
        this.events?.onPointHover?.(null);
      },
      // Setting any onLink* callback enables cosmos' native link hit-testing.
      onLinkClick: (linkIndex) => {
        this.events?.onLinkClick?.(linkIndex);
      },
      onLinkMouseOver: (linkIndex) => {
        this.hoveredLinkIndex = linkIndex;
        this.requestTicks(1);
        this.events?.onLinkHover?.(linkIndex);
      },
      onLinkMouseOut: () => {
        this.hoveredLinkIndex = null;
        this.requestTicks(1);
        this.events?.onLinkHover?.(null);
      },
      onDragStart: () => {
        this.handleDragStart();
      },
      onDragEnd: (e) => {
        this.handleDragEnd(e);
      },
      onZoom: () => {
        // Per-event ticks rather than a paired start/end reason: d3-zoom
        // fires this every animation step of BOTH user gestures and
        // programmatic transitions, so the burst self-sustains for exactly
        // as long as the camera actually moves.
        this.requestTicks(2);
        this.emitViewportChange();
      },
      onZoomEnd: () => {
        this.requestTicks(2);
        this.emitViewportChange();
      },
      // --- gated-clock run reasons ---
      onSimulationStart: () => {
        this.wake('sim');
      },
      onSimulationUnpause: () => {
        this.wake('sim');
      },
      onSimulationPause: () => {
        this.sleep('sim');
      },
      onSimulationEnd: () => {
        this.sleep('sim');
        this.events?.onSimulationEnd?.();
      },
      onTransitionStart: () => {
        this.wake('transition');
      },
      onTransitionEnd: () => {
        this.sleep('transition');
      },
    };
    if (this.options.spaceSize !== undefined) base.spaceSize = this.options.spaceSize;
    // Escape hatch: shallow-merged last so callers can override anything
    // above — EXCEPT that callback keys defined on BOTH sides COMPOSE
    // (adapter's first, then the caller's) rather than clobber. The gated
    // clock's wake/sleep wiring and the host event channels live in these
    // callbacks; a caller supplying onSimulationStart/onZoom/onDragEnd/…
    // through initialConfig must not silently sever them.
    const extra = this.options.initialConfig as GraphConfig | undefined;
    if (!extra) return base;
    const merged: GraphConfig = { ...base, ...extra };
    for (const key of Object.keys(base)) {
      const ours = (base as Record<string, unknown>)[key];
      const theirs = (extra as Record<string, unknown>)[key];
      if (typeof ours === 'function' && typeof theirs === 'function') {
        (merged as Record<string, unknown>)[key] = (...args: unknown[]) => {
          (ours as (...a: unknown[]) => unknown)(...args);
          return (theirs as (...a: unknown[]) => unknown)(...args);
        };
      }
    }
    return merged;
  }

  /**
   * Maps cosmos' unified context-menu callback to the host event: index
   * undefined → null (background), MouseEvent client coords → container-
   * relative CSS px (the inner div fills the host container exactly). The
   * native event is preventDefault-ed so the browser menu never opens — but
   * only when the host actually registered onContextMenu (it always does in
   * Orbit: the core owns the typed 'contextMenu' event channel). cosmos'
   * desktop `contextmenu` handler already prevents the event itself; repeating
   * it is an idempotent no-op that also covers the touch long-press path
   * (where cosmos forwards the originating pointerdown event instead).
   */
  private handleContextMenu(index: number | undefined, event: MouseEvent): void {
    const events = this.events;
    if (!events?.onContextMenu) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    const div = this.innerDiv;
    if (!div) return;
    const rect = div.getBoundingClientRect();
    events.onContextMenu(index ?? null, [event.clientX - rect.left, event.clientY - rect.top]);
  }

  /** Emits onPointClick(null) once per originating click event. */
  private emitNullPointClick(event: unknown): void {
    if (event != null && event === this.lastNullClickEvent) return;
    this.lastNullClickEvent = event ?? null;
    this.events?.onPointClick?.(null, clickModifiers(event));
  }

  /**
   * The D3 drag event carries no point index; cosmos assigns
   * `store.draggingPointIndex` right before invoking onDragStart (see module
   * header). The public onPointMouseOver stream is the fallback — cosmos only
   * starts a drag while a point is hovered.
   */
  private readDraggingIndex(): number | null {
    const store = (this.graph as unknown as { store?: CosmosStoreLike } | null)?.store;
    return store?.draggingPointIndex ?? store?.hoveredPoint?.index ?? this.lastHoverIndex;
  }

  private handleDragStart(): void {
    // Wake before the index resolution: the gesture is real (cosmos renders
    // it) even when the dragged-point fallback chain comes up empty.
    this.wake('drag');
    const index = this.readDraggingIndex();
    if (index === null) return;
    this.dragIndex = index;
    this.events?.onDragStart?.(index);
  }

  /**
   * Reports the dragged point's final SPACE position. cosmos' drag shader
   * pins the point to the mouse's space position every frame, so converting
   * the event's screen coords is exact and O(1) (see module header).
   */
  private handleDragEnd(e: { x: number; y: number }): void {
    // Release the run reason even when no index was latched — cosmos pairs
    // start/end, but a mid-gesture hover loss must not leak a held reason.
    this.sleep('drag');
    const index = this.dragIndex;
    this.dragIndex = null;
    if (index === null) return;
    const graph = this.activeGraph;
    if (!graph) return; // context died mid-gesture; the drag is dropped
    const [x, y] = graph.screenToSpacePosition([e.x, e.y]);
    this.events?.onDragEnd?.(index, x, y);
  }

  private emitViewportChange(): void {
    const viewport = this.getViewport();
    if (viewport) this.events?.onViewportChange?.(viewport);
  }

  /**
   * One visibly atomic update: all channels and config are staged, then
   * exactly one render draws them; restart reheats after the render.
   */
  private applyCommit(graph: CosmosGraph, update: EngineCommit): void {
    const { config, structure, buffers, resources, restart } = update;

    if (config) {
      if (config.seedRadius !== undefined) this.seedRadiusOverride = config.seedRadius;
      const partial: GraphConfig = {};
      if (config.backgroundColor !== undefined) partial.backgroundColor = config.backgroundColor;
      // arrowheads: cosmos' `linkDefaultArrows` config key (3.3.0
      // config.d.ts) — a pure config toggle, no per-link buffer involved.
      if (config.linkArrows !== undefined) partial.linkDefaultArrows = config.linkArrows;
      // link visibility: cosmos 3.3.0 has a first-class `renderLinks`
      // config key (config.d.ts, default true) — config-only, never a buffer
      // rebuild (no linkOpacity workaround needed).
      if (config.renderLinks !== undefined) partial.renderLinks = config.renderLinks;
      // theme tokens: cosmos accepts CSS color strings natively.
      if (config.defaultPointColor !== undefined) {
        partial.pointDefaultColor = config.defaultPointColor;
      }
      if (config.defaultLinkColor !== undefined) {
        partial.linkDefaultColor = config.defaultLinkColor;
      }
      // disable-transitions ladder step: 0 = atomic jumps; null restores
      // cosmos' own default (config.d.ts `transitionDuration`, 800ms).
      if (config.transitionDurationMs !== undefined) {
        partial.transitionDuration = config.transitionDurationMs ?? 800;
      }
      // emphasis ring: cosmos' FOCUSED ring (config.d.ts
      // `focusedPointRingColor`; drawn whenever a focused index is set — no
      // boolean gate). Deliberately NOT `renderHoveredPointRing`: that would
      // draw a second ring from cosmos' own hover state, and the focused path
      // is what lets orbit choose the ringed node (keyboard nav, focusNode).
      if (config.emphasisRingColor !== undefined) {
        partial.focusedPointRingColor = config.emphasisRingColor;
      }
      const sim = config.simulation;
      if (sim) {
        if (sim.gravity !== undefined) partial.simulationGravity = sim.gravity;
        if (sim.repulsion !== undefined) partial.simulationRepulsion = sim.repulsion;
        if (sim.friction !== undefined) partial.simulationFriction = sim.friction;
        if (sim.linkDistance !== undefined) partial.simulationLinkDistance = sim.linkDistance;
        if (sim.linkSpring !== undefined) partial.simulationLinkSpring = sim.linkSpring;
        // tunables added in v0.10.2 — each maps 1:1 onto a cosmos config
        // key; an omitted field is never written, so cosmos' own default
        // stands (config.d.ts `defaultConfigValues`).
        if (sim.decay !== undefined) partial.simulationDecay = sim.decay;
        if (sim.collision !== undefined) partial.simulationCollision = sim.collision;
        if (sim.collisionRadius !== undefined) {
          partial.simulationCollisionRadius = sim.collisionRadius;
        }
        if (sim.collisionPadding !== undefined) {
          partial.simulationCollisionPadding = sim.collisionPadding;
        }
        // cosmos >= 3.4 replaced Barnes-Hut many-body with grid-based
        // repulsion: `simulationRepulsionTheta` is deprecated and
        // NON-FUNCTIONAL. Sending it would misrepresent state, so the key is
        // not mapped; the host learns once instead of wondering silently.
        if (sim.repulsionTheta !== undefined && !this.repulsionThetaWarned) {
          this.repulsionThetaWarned = true;
          this.events?.onDiagnostic?.({
            code: 'engine:repulsion-theta-deprecated',
            severity: 'info',
            message:
              'CosmosEngine: cosmos >= 3.4 uses grid-based repulsion; ' +
              'simulation.repulsionTheta is ignored by this engine.',
          });
        }
        if (sim.center !== undefined) partial.simulationCenter = sim.center;
        if (sim.repulsionFromMouse !== undefined) {
          partial.simulationRepulsionFromMouse = sim.repulsionFromMouse;
        }
      }
      // stage-4 cluster force: the scene-wide coefficient is cosmos'
      // `simulationCluster` config key (config.d.ts, default 0.1); membership
      // and centers are buffer-shaped and staged below.
      if (config.cluster != null && config.cluster.strength !== undefined) {
        partial.simulationCluster = config.cluster.strength;
      }
      if (Object.keys(partial).length > 0) graph.setConfigPartial(partial);
    }

    if (structure) {
      this.lastPointCount = structure.pointCount;
      graph.setPointPositions(this.withSeededPositions(structure.positions));
      // cosmos takes link endpoint indices as Float32Array; exact for < 2^24 points.
      graph.setLinks(Float32Array.from(structure.links));
    }

    // Staged AFTER the roster so cosmos sees a membership array matching the
    // point count of this same commit (I2), and before the single render.
    if (config && config.cluster !== undefined) this.applyClusterForce(graph, config.cluster);

    if (buffers) {
      // [0,1] RGBA floats — cosmos' native scale; pass through (see header note).
      if (buffers.pointColor) graph.setPointColors(buffers.pointColor);
      if (buffers.pointSize) graph.setPointSizes(buffers.pointSize);
      if (buffers.linkColor) graph.setLinkColors(buffers.linkColor);
      if (buffers.linkWidth) graph.setLinkWidths(buffers.linkWidth);
    }

    // atlas resources are staged before the SAME render as every other
    // channel, keeping the commit visibly atomic.
    if (resources) this.applyResources(graph, resources);

    graph.render();
    this.applied = update.revision;

    if (restart) graph.start(restart.alpha);
    // write re-arm: the commit's render lands this tick; the burst lets
    // overlays sample the post-draw state. A restart additionally holds the
    // clock via the sim run reason (onSimulationStart → wake).
    if (restart) this.wake('sim');
    this.requestTicks(2);
  }

  /**
   * Applies the stage-4 cluster force (capability `clusterForce`).
   *
   * Contract mapping, verified against the 3.3.0 dist (`index.d.ts`):
   * - `pointClusters` (Float32Array, NaN = unclustered) →
   * `setPointClusters((number | undefined)[])`, where cosmos' documented
   * "does not belong to any cluster" value is `undefined`;
   * - `centers` (Float32Array, `[x0,y0,x1,y1,…]`) →
   * `setClusterPositions((number | undefined)[])`; a non-finite entry means
   * "no position" and cosmos falls back to that cluster's centermass;
   * - `null` clears: an all-`undefined` array of the CURRENT roster length
   * (length must track the roster) plus empty cluster positions.
   * `strength` is the scene-wide `simulationCluster` config coefficient
   * applied in the config block, not the per-point
   * `setPointClusterStrength` buffer (Orbit's strength is scene-wide).
   */
  private applyClusterForce(
    graph: CosmosGraph,
    cluster: NonNullable<EngineCommit['config']>['cluster'],
  ): void {
    if (cluster == null) {
      graph.setPointClusters(new Array<number | undefined>(this.lastPointCount).fill(undefined));
      graph.setClusterPositions([]);
      return;
    }
    const source = cluster.pointClusters;
    const assignments = new Array<number | undefined>(source.length);
    for (let i = 0; i < source.length; i++) {
      const value = source[i]!;
      assignments[i] = Number.isFinite(value) ? value : undefined;
    }
    graph.setPointClusters(assignments);
    const centers = cluster.centers;
    if (centers !== undefined) {
      const positions = new Array<number | undefined>(centers.length);
      for (let i = 0; i < centers.length; i++) {
        const value = centers[i]!;
        positions[i] = Number.isFinite(value) ? value : undefined;
      }
      graph.setClusterPositions(positions);
    }
  }

  /**
   * Applies the image-atlas channel: upserts convert ImageBitmap →
   * ImageData through an offscreen 2D canvas into the slot mirror, removals
   * blank their slot, and any atlas change re-uploads the FULL ImageData
   * array (cosmos' setImageData is whole-array only, matching
   * `rangeUpdates: []`). Environments without a usable 2D context (jsdom)
   * no-op the channel and report `engine:image-channel-unavailable` once
   * never throw.
   */
  private applyResources(graph: CosmosGraph, resources: EngineResources): void {
    const atlas = resources.imageAtlas;
    if (atlas) {
      let dirty = false;
      let conversionFailed = false;
      if (atlas.upserts) {
        for (const { slot, bitmap } of atlas.upserts) {
          if (!Number.isInteger(slot) || slot < 0) continue;
          const data = this.canvasImageData(bitmap.width, bitmap.height, bitmap);
          if (data === null) {
            conversionFailed = true;
            continue;
          }
          while (this.imageSlots.length <= slot) this.imageSlots.push(null);
          this.imageSlots[slot] = data;
          dirty = true;
        }
      }
      if (atlas.removeSlots) {
        for (const slot of atlas.removeSlots) {
          // Only slots that currently hold an image need blanking.
          if (slot >= 0 && slot < this.imageSlots.length && this.imageSlots[slot] != null) {
            this.imageSlots[slot] = null;
            dirty = true;
          }
        }
      }
      if (conversionFailed) this.reportImageChannelUnavailable();
      if (dirty) {
        const blank = this.blankImage ?? (this.blankImage = this.canvasImageData(1, 1));
        if (blank === null) {
          this.reportImageChannelUnavailable();
        } else {
          // Array.from (not.map) so sparse holes also materialize as blanks.
          graph.setImageData(Array.from(this.imageSlots, (d) => d ?? blank));
        }
      }
    }
    // Indices into an atlas that can never be populated are meaningless
    // once the channel is known-unavailable the whole channel no-ops.
    if (resources.pointImageIndex && !this.imageChannelUnavailable) {
      graph.setPointImageIndices(resources.pointImageIndex);
    }
  }

  /**
   * Reads an ImageData of the given size off an offscreen 2D canvas, drawing
   * `bitmap` onto it first when provided (ImageBitmap → ImageData transcode;
   * without a bitmap: a transparent blank). Returns null — never throws
   * where no 2D context exists (jsdom without the canvas package).
   */
  private canvasImageData(width: number, height: number, bitmap?: ImageBitmap): ImageData | null {
    const doc = this.innerDiv?.ownerDocument;
    if (!doc || !(width > 0) || !(height > 0)) return null;
    try {
      const canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      if (bitmap) ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, width, height);
    } catch {
      return null;
    }
  }

  /** Documented degradation, reported at most once per engine instance. */
  private reportImageChannelUnavailable(): void {
    if (this.imageChannelUnavailable) return;
    this.imageChannelUnavailable = true;
    this.events?.onDiagnostic?.({
      code: 'engine:image-channel-unavailable',
      severity: 'warning',
      message:
        'CosmosEngine: no 2D canvas context is available to convert ImageBitmap ' +
        'atlas entries to ImageData; point images are disabled in this environment.',
    });
  }

  /**
   * Replaces NaN pairs (= "no known position") with random points on a
   * ring of radius seedRadius around the space center. cosmos treats NaN
   * positions as *absent* points, so they must never reach setPointPositions.
   * Known positions pass through verbatim (same array when nothing to seed).
   */
  private withSeededPositions(positions: Float32Array): Float32Array {
    let needsSeeding = false;
    for (let i = 0; i < positions.length; i += 2) {
      if (Number.isNaN(positions[i]!) || Number.isNaN(positions[i + 1]!)) {
        needsSeeding = true;
        break;
      }
    }
    if (!needsSeeding) return positions;

    const out = Float32Array.from(positions);
    const center = this.spaceSize / 2;
    const radius = this.seedRadius;
    for (let i = 0; i < out.length; i += 2) {
      if (Number.isNaN(out[i]!) || Number.isNaN(out[i + 1]!)) {
        const angle = Math.random() * Math.PI * 2;
        out[i] = center + radius * Math.cos(angle);
        out[i + 1] = center + radius * Math.sin(angle);
      }
    }
    return out;
  }
}

/**
 * Takes ownership of every mutable container in a commit that may be retained
 * past `commit()`'s synchronous lifetime. Typed arrays are copied by value;
 * nested records/lists are copied so callers cannot replace an owned array or
 * atlas operation after enqueue. ImageBitmap itself is an opaque resource
 * handle and deliberately remains shared.
 */
function cloneCommitForQueue(update: EngineCommit): EngineCommit {
  const owned: EngineCommit = { revision: update.revision };

  if (update.structure !== undefined) {
    owned.structure = {
      pointCount: update.structure.pointCount,
      positions: update.structure.positions.slice(),
      links: update.structure.links.slice(),
    };
  }

  if (update.buffers !== undefined) {
    const buffers: NonNullable<EngineCommit['buffers']> = {};
    if (update.buffers.pointColor !== undefined) {
      buffers.pointColor = update.buffers.pointColor.slice();
    }
    if (update.buffers.pointSize !== undefined) {
      buffers.pointSize = update.buffers.pointSize.slice();
    }
    if (update.buffers.linkColor !== undefined) {
      buffers.linkColor = update.buffers.linkColor.slice();
    }
    if (update.buffers.linkWidth !== undefined) {
      buffers.linkWidth = update.buffers.linkWidth.slice();
    }
    owned.buffers = buffers;
  }

  if (update.bufferPatches !== undefined) {
    const patches: NonNullable<EngineCommit['bufferPatches']> = {};
    if (update.bufferPatches.pointColor !== undefined) {
      patches.pointColor = update.bufferPatches.pointColor.map(({ start, data }) => ({
        start,
        data: data.slice(),
      }));
    }
    if (update.bufferPatches.pointSize !== undefined) {
      patches.pointSize = update.bufferPatches.pointSize.map(({ start, data }) => ({
        start,
        data: data.slice(),
      }));
    }
    if (update.bufferPatches.linkColor !== undefined) {
      patches.linkColor = update.bufferPatches.linkColor.map(({ start, data }) => ({
        start,
        data: data.slice(),
      }));
    }
    if (update.bufferPatches.linkWidth !== undefined) {
      patches.linkWidth = update.bufferPatches.linkWidth.map(({ start, data }) => ({
        start,
        data: data.slice(),
      }));
    }
    owned.bufferPatches = patches;
  }

  if (update.config !== undefined) {
    const config: NonNullable<EngineCommit['config']> = { ...update.config };
    if (update.config.simulation !== undefined) {
      config.simulation = { ...update.config.simulation };
    }
    if (update.config.cluster !== undefined) {
      config.cluster =
        update.config.cluster === null
          ? null
          : {
              ...update.config.cluster,
              pointClusters: update.config.cluster.pointClusters.slice(),
              ...(update.config.cluster.centers === undefined
                ? {}
                : { centers: update.config.cluster.centers.slice() }),
            };
    }
    owned.config = config;
  }

  if (update.resources !== undefined) {
    const resources: EngineResources = {};
    if (update.resources.imageAtlas !== undefined) {
      const imageAtlas: NonNullable<EngineResources['imageAtlas']> = {};
      if (update.resources.imageAtlas.upserts !== undefined) {
        imageAtlas.upserts = update.resources.imageAtlas.upserts.map(({ slot, bitmap }) => ({
          slot,
          bitmap,
        }));
      }
      if (update.resources.imageAtlas.removeSlots !== undefined) {
        imageAtlas.removeSlots = Array.from(update.resources.imageAtlas.removeSlots);
      }
      resources.imageAtlas = imageAtlas;
    }
    if (update.resources.pointImageIndex !== undefined) {
      resources.pointImageIndex = update.resources.pointImageIndex.slice();
    }
    owned.resources = resources;
  }

  if (update.restart !== undefined) {
    owned.restart = update.restart === false ? false : { alpha: update.restart.alpha };
  }

  return owned;
}

/**
 * Per-channel merge for queued resources (pre-mount / context-lost):
 * upserts union per slot (latest bitmap wins), a later remove drops an
 * earlier pending upsert of the same slot (and vice versa — folding order
 * mirrors applyResources: upserts before removes within each commit), and
 * the latest pointImageIndex replaces wholesale.
 */
function mergeResources(
  previous: EngineCommit['resources'],
  update: EngineCommit['resources'],
): EngineResources {
  const upsertBySlot = new Map<number, ImageBitmap>();
  const removes = new Set<number>();
  for (const atlas of [previous?.imageAtlas, update?.imageAtlas]) {
    if (!atlas) continue;
    for (const { slot, bitmap } of atlas.upserts ?? []) {
      upsertBySlot.set(slot, bitmap);
      removes.delete(slot);
    }
    for (const slot of atlas.removeSlots ?? []) {
      upsertBySlot.delete(slot);
      removes.add(slot);
    }
  }
  const merged: EngineResources = {};
  if (upsertBySlot.size > 0 || removes.size > 0) {
    const imageAtlas: NonNullable<EngineResources['imageAtlas']> = {};
    if (upsertBySlot.size > 0) {
      imageAtlas.upserts = Array.from(upsertBySlot, ([slot, bitmap]) => ({ slot, bitmap }));
    }
    if (removes.size > 0) imageAtlas.removeSlots = Array.from(removes);
    merged.imageAtlas = imageAtlas;
  }
  const pointImageIndex = update?.pointImageIndex ?? previous?.pointImageIndex;
  if (pointImageIndex !== undefined) merged.pointImageIndex = pointImageIndex;
  return merged;
}
