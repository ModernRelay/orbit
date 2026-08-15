/**
 * GraphEngine adapter contract.
 *
 * The core drives any engine exclusively through this interface; cosmos.gl is
 * the first implementation and lives in @modernrelay/orbit-engine-cosmos — the
 * only package allowed to import it. FakeEngine from the core testing entry implements the
 * same contract headlessly.
 *
 * v0.1 subset decisions:
 * - Buffer updates are full-channel replaces, or RANGED patches for the
 * channels an engine declares in `capabilities.rangeUpdates`.
 * - One visibly atomic update per EngineCommit: the adapter applies all
 * channels/config of a commit before the next drawn frame.
 * - Position readback (`getPositions`) is per-event only, never per-tick.
 */

import type {
  DiagnosticSeverity,
  EngineBufferChannel,
  SimulationConfig,
  ViewportState,
} from '../types';

// Canonical home moved to types.ts (telemetry needs the union without a
// types → engine cycle); re-exported here so every existing consumer of the
// engine seam keeps its import path.
export type { EngineBufferChannel } from '../types';

export interface EngineCapabilities {
  /** Native edge hover/click picking. */
  linkPicking: boolean;
  /** Channels supporting ranged (partial) updates. Empty in v0.1 for cosmos. */
  rangeUpdates: readonly EngineBufferChannel[];
  /** O(k) tracked-subset position readback per frame. */
  trackedPositions: boolean;
  /** Engine runs a live GPU force simulation. */
  simulation: boolean;
  /** Instanced directional arrowheads on links. */
  edgeArrows?: boolean;
  /** Per-point image sprites via a texture atlas. */
  pointImages?: boolean;
  /** cluster force: per-point cluster assignment with optional
   * strength/centers. Engines without it degrade loudly — membership,
   * labels, and centroids still work. */
  clusterForce?: boolean;
  /** frame-loop idle behavior: 'stops' = zero rAF at rest (quiescent,
   * the stop-at-rest target); 'free-running' = the engine burns rAF while
   * idle — a documented degradation, not a violation. Absent reads as
   * 'free-running' (conservative). */
  idleFrames?: 'stops' | 'free-running';
  /** onFrame phase: true = exact post-draw; false/absent = an
   * activity clock (overlays may lag one sample). This field
   * makes the previously prose-only declaration real. */
  postDrawFrames?: boolean;
}

export interface EngineConfigUpdate {
  /** stage-4 cluster force (capability `clusterForce`; inert
   * otherwise). null clears. `pointClusters` maps point index → cluster
   * ordinal (aligned to `centers` pairs). */
  cluster?: {
    pointClusters: Float32Array;
    centers?: Float32Array;
    strength?: number;
  } | null;
  backgroundColor?: string;
  simulation?: SimulationConfig;
  /** Space-coordinate defaults used when seeding unknown (NaN) positions. */
  seedRadius?: number;
  /** arrowheads on/off (capability edgeArrows; inert otherwise). */
  linkArrows?: boolean;
  /** link visibility toggle — config-only, never a buffer rebuild. */
  renderLinks?: boolean;
  /** Engine-relevant theme tokens beyond background. */
  defaultPointColor?: string;
  defaultLinkColor?: string;
  /** emphasis-ring color (cosmos: `focusedPointRingColor`). No capability
   * gate: `setFocusedIndex` is a required engine member, so every engine has
   * the mechanism — one that ignores the COLOR degrades to its own default. */
  emphasisRingColor?: string;
  /** disable-transitions ladder step: 0 = atomic jumps;
   * null = restore the engine's own default duration. Engines without
   * transitions ignore it. */
  transitionDurationMs?: number | null;
}

/**
 * One atomic engine update. `revision` is the desired-render revision the
 * commit realizes; adapters must report it back via `appliedRevision` once
 * visible. Buffers are full-channel replaces sized to the current structure;
 * when `structure` is present it replaces point/link structure and MUST be
 * applied together with any buffers in the same commit.
 */
/** One contiguous ranged write: `data` lands at element offset `start`. */
export interface BufferPatch {
  start: number;
  data: Float32Array;
}

export interface EngineCommit {
  revision: number;
  structure?: {
    pointCount: number;
    /** 2*pointCount floats; NaN pairs = engine seeds the position. */
    positions: Float32Array;
    /** 2*linkCount uint32 endpoint indices. */
    links: Uint32Array;
  };
  buffers?: Partial<{
    /** 4*pointCount RGBA floats in [0,1]. */
    pointColor: Float32Array;
    /** pointCount floats (px). */
    pointSize: Float32Array;
    /** 4*linkCount RGBA floats in [0,1]. */
    linkColor: Float32Array;
    /** linkCount floats (px). */
    linkWidth: Float32Array;
  }>;
  /**
   * ranged channel updates — ONLY for channels the engine declared
   * in `capabilities.rangeUpdates`, and only AFTER that channel has been
   * seeded by at least one full-buffer commit. A channel appears in
   * `buffers` OR here in one commit, never both. `start` is in ELEMENT
   * units of the channel's layout (RGBA floats for color channels). Patch
   * `data` views are valid only during `commit` — same lifetime contract
   * as full buffers.
   */
  bufferPatches?: Partial<{
    pointColor: readonly BufferPatch[];
    pointSize: readonly BufferPatch[];
    linkColor: readonly BufferPatch[];
    linkWidth: readonly BufferPatch[];
  }>;
  config?: EngineConfigUpdate;
  /** image-atlas resource updates (capability pointImages); applied
   * atomically with the same commit's buffers. */
  resources?: {
    imageAtlas?: {
      upserts?: readonly { slot: number; bitmap: ImageBitmap }[];
      removeSlots?: readonly number[];
    };
    /** Per-point atlas slot indices (-1 = placeholder shape). */
    pointImageIndex?: Float32Array;
  };
  /** Restart/reheat the simulation after applying; false/absent = keep state. */
  restart?: { alpha: number } | false;
}

/**
 * WebGL context lifecycle events. `restored` means the adapter has a
 * fresh, empty, commit-ready GL machine in the same container — the core then
 * re-commits the scene. `failed` is terminal reinitialization failure.
 */
export type EngineContextEvent =
  | { type: 'lost' }
  | { type: 'restored' }
  | { type: 'failed'; error: Error };

/** Adapter observability channel; codes are namespaced `engine:*`. */
export interface EngineDiagnostic {
  code: `engine:${string}`;
  severity: DiagnosticSeverity;
  message: string;
}

/** Events the engine reports to core. Indices are engine-local; core maps
 * them back to typed objects. */
export interface EngineHostEvents {
  onPointClick?(index: number | null, modifiers?: { metaKey: boolean; shiftKey: boolean }): void;
  onPointHover?(index: number | null): void;
  /** Native link picking (capability `linkPicking`); indices are link-local. */
  onLinkClick?(linkIndex: number): void;
  onLinkHover?(linkIndex: number | null): void;
  /** Native point drag (space coords). The core owns pin semantics. */
  onDragStart?(index: number): void;
  onDragEnd?(index: number, x: number, y: number): void;
  /** Context-menu gesture (right-click / touch long-press); null = background. */
  onContextMenu?(index: number | null, screen: readonly [number, number]): void;
  /**
   * Overlay/activity clock: the adapter's per-frame callback for the
   * core scheduler's fan-out (DOM labels, tooltips). Under
   * `postDrawFrames:false` engines this is an activity clock — overlays may
   * lag the canvas by one sample; the adapter reports that degradation once.
   */
  onFrame?(timeMs: number): void;
  onViewportChange?(v: ViewportState): void;
  onSimulationEnd?(): void;
  onError?(error: Error): void;
  onContextEvent?(ev: EngineContextEvent): void;
  onDiagnostic?(d: EngineDiagnostic): void;
}

export interface FitViewOptions {
  durationMs?: number;
  padding?: number;
}

export interface GraphEngine {
  readonly capabilities: EngineCapabilities;

  /** Mount into a container. Resolve when the first frame can be produced. */
  mount(container: HTMLElement, events: EngineHostEvents): Promise<void>;

  /** Apply one atomic update. Throws only on programmer error. */
  commit(update: EngineCommit): void;

  /** Highest commit revision that is visibly applied. */
  appliedRevision(): number | null;

  // --- camera ---
  fitView(opts?: FitViewOptions): void;
  zoom(factor: number, durationMs?: number): void;
  setViewport(v: Partial<ViewportState>, opts?: { durationMs?: number }): void;
  getViewport(): ViewportState | null;
  /** Optional: animate the camera to a point (used by focusNode). */
  zoomToIndex?(index: number, durationMs?: number): void;

  // --- simulation ---
  start(alpha?: number): void;
  pause(): void;

  // --- built-in interaction visuals ---
  setSelectedIndices(indices: readonly number[] | null): void;
  setFocusedIndex(index: number | null): void;

  // --- spatial queries and pinning (optional; availability follows the
  // adapter, and the core provides fallbacks where needed) ---
  /** Point indices inside a SCREEN-coordinate polygon (lasso/rectangle). */
  pointsInPolygon?(screenPolygon: readonly [number, number][]): number[];
  /** Point indices inside a SCREEN-coordinate rect [x0,y0,x1,y1] (label cull). */
  pointsInRect?(screenRect: readonly [number, number, number, number]): number[];
  /** Capture the current frame as an image for toolbar screenshots and exports. */
  captureScreenshot?(): Promise<Blob | null>;
  /** 1-hop neighbor point indices (engine adjacency, if available). */
  neighborIndices?(index: number): number[];
  screenToSpace?(p: readonly [number, number]): [number, number] | null;
  spaceToScreen?(p: readonly [number, number]): [number, number] | null;
  /** Replace the full pinned set; null/[] unpins all (idempotent). */
  setPinnedIndices?(indices: readonly number[] | null): void;

  // --- event-time readback ---
  getPositions(): Float32Array | null;

  destroy(): void;
}

/** Engine factory the host passes in; called once per instance mount. */
export type EngineFactory = () => GraphEngine;
