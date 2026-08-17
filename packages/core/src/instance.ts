/**
 * GraphInstance — the public headless core instance (v0.3 subset).
 *
 * One `applyHostUpdate` call is the atomic host boundary: it validates,
 * reconciles, re-projects only dirty channels, and publishes EXACTLY ONE store
 * `set` and AT MOST ONE engine commit, so a simultaneous data + style +
 * controlled-state change can never tear across frames.
 *
 * Vanilla zustand only — no React, no DOM access at module scope.
 */

import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';

import type {
  Accessor,
  AcceptedEdge,
  AcceptedGraph,
  AccessibilityConfig,
  AppendReceipt,
  BeginIngestOptions,
  BrushState,
  ClusterSpec,
  CrossfilterSession,
  DimensionSpec,
  DomainPolicy,
  EdgeId,
  ExpansionBatch,
  ExpansionResponse,
  ExpansionService,
  FilterMode,
  FilterSpec,
  GraphDiagnostic,
  GraphEdge,
  GraphEventMap,
  GraphEventName,
  GraphHostUpdate,
  GraphPerfSnapshot,
  ScaleLimits,
  DegradeEvent,
  GraphListenerControl,
  ColumnarGraphSnapshot,
  GraphNode,
  GraphSnapshot,
  MetricColumn,
  GraphStoreState,
  GraphTheme,
  GroupBySpec,
  GroupSpec,
  IngestBatch,
  IngestCommitReceipt,
  IngestSession,
  IngestSessionState,
  LabelConfig,
  LabelPlacement,
  LayoutKind,
  MetricName,
  NodeId,
  PathService,
  PathOptions,
  PathResult,
  RenderScene,
  RequestContext,
  ResolvedCluster,
  ResolvedGroup,
  Revisions,
  Scale,
  SearchActivation,
  SearchResult,
  SelectionState,
  SimulationConfig,
  SubgraphSpec,
  ThemeInput,
  TimelinePlayback,
  ViewportState,
} from './types';
import { DIAGNOSTIC_SAMPLE_CAP } from './types';
import {
  AcceptanceQueue,
  INGEST_MAX_FLUSH_LATENCY_MS_DEFAULT,
  INGEST_MAX_PENDING_BYTES_DEFAULT,
  INGEST_OVERFLOW_FACTOR,
  baseFromAccepted,
  baseFromContribution,
  estimateBatchBytes,
  mergeDiagnostics,
  mergeModel,
  newContribution,
  newStagingTallies,
  sessionCommitDiagnostics,
  stageBatch,
} from './ingestion';
import type {
  MergeBase,
  MergeResult,
  SessionContribution,
  StagingTallies,
  StampedEdge,
} from './ingestion';
import type {
  BufferPatch,
  EngineCommit,
  EngineConfigUpdate,
  EngineFactory,
  EngineHostEvents,
  GraphEngine,
} from './engine/index';
import type { ErrorPhase, GraphError, GraphOperationError } from './errors';
import { OrbitOperationError, graphErrorToError, isFatalGraphError } from './errors';
import { validateSnapshot } from './validate';
import { Reconciler } from './reconciler';
import type { ReconcileResult } from './reconciler';
import { parseColor, projectColors, projectSizes } from './projection';
import type { RGBA } from './projection';
import { dedupeFirstOccurrence, orderByAcceptedBase, toggleId, unionIds } from './selection';
import { buildAdjacency, buildIncidence, neighborsOf } from './adjacency';
import type { Adjacency, Incidence } from './adjacency';
import { IncrementalAlphaComposer } from './alphaCompose';
import { PressureSampler } from './perf';
import { DegradeController, resolveScaleLimits } from './degrade';
import { EdgePickingFacade, medianLinkWidthPx } from './edgePicking';
import type { EdgePickRoute } from './edgePicking';
import {
  LABEL_MAX_VISIBLE_CAP,
  LABEL_MAX_VISIBLE_DEFAULT,
  selectLabelCandidates,
} from './labels';
import type { LabelCandidate, LabelCandidateViewport, SelectLabelCandidatesArgs } from './labels';
import { buildAcceptedAdjacency, cascadeEdges, resolveScope } from './scope';
import {
  PendingExpansions,
  admitServiceResult,
  createLocalExpansionService,
  createRequestContext,
  serviceCacheKey,
} from './services';
import type { RequestContextHandle, RevisionSnapshot } from './services';
import { computePathEmphasis, createLocalPathService } from './pathService';
import { createLocalSearchService } from './search';
import type { SearchService } from './search';
import { nextSynthesizedEdgeId } from './edgeIdentity';
import {
  buildAcceptedFromColumnar,
  detachColumnarBuffers,
  isColumnarSnapshot,
  materializeColumnarSnapshot,
  validateColumnarStructure,
} from './columnar';
import { WorkerLane } from './worker/lane';
import type { WorkerFactoryOption } from './worker/lane';
import type { DeriveColumnarRequest, DeriveColumnarResult } from './worker/runtime';
import { collectTransfers, encodeStringTable } from './workerProtocol';
import type { EdgePairCounters } from './edgeIdentity';
import {
  canonicalFilterKey,
  compileEdgeFilter,
  compileNodeFilter,
  resolveFilterField,
  validateFilterExpr,
} from './filter';
import type { CompiledFilter } from './filter';
import {
  CATEGORICAL_PALETTE,
  canonicalScaleKey,
  categoricalIndex,
  categoricalRows,
  computeNumericDomain,
  divergingColor,
  DomainStore,
  sequentialColor,
  sequentialSize,
} from './scale';
import { coerceNumeric } from './hygiene';
import { MetricStore } from './metrics';
import {
  CLUSTER_FORCE_DEGRADATION_REASON,
  normalizeCommitForCapabilities,
  resolveEnginePolicy,
} from './capabilityPolicy';
import type { EnginePolicy } from './capabilityPolicy';
import { clusterCentroids, deriveClusters, resolveClusterCenters } from './clusters';
import type { ClusterDerivation } from './clusters';
import { ImageAtlasPipeline } from './imageAtlas';
import type { ImageAtlasBatch, ImageResolver } from './imageAtlas';
import { SoftMask } from './mask';
import type { MaskCrossings, MaskDrain, MaskSource } from './mask';
import {
  buildRepForest,
  collapseParallelEdges,
  deriveGroupsByKey,
  metaEdgeWidthFor,
  PHYSICAL_DEFAULT_LINK_WIDTH,
  PHYSICAL_DEFAULT_POINT_SIZE,
  resolveManualGroups,
  rewriteGroups,
  sameGroupBySpec,
  sameGroupSpecArrays,
  sameResolvedGroups,
  sceneGroupsOf,
  sceneLinkRefAt,
  scenePointRefAt,
  superNodeSizeFor,
  validateGroupBySpec,
  validateGroupSpecs,
} from './groups';
import type { FoldRecord, GroupRewrite } from './groups';
import { renderSvg, SVG_MAX_ELEMENTS_DEFAULT } from './svgExport';
import { sameDataRef, validateViewState } from './viewState';
import type {
  GraphViewState,
  SerializableScale,
  SetViewStateResult,
  ViewBrushState,
  ViewStyling,
} from './viewState';
import type { JsonValue } from './types';
import { TypedColumnCrossfilter } from './crossfilter';
import type { BrushDelta } from './crossfilter';
import { HistoryKernel } from './history';
import type { HistoryCommand, HistoryDepths } from './history';

// ---------------------------------------------------------------------------
// theme resolution. The `theme` prop accepts a full GraphTheme,
// a Partial over a named base, or the v0.1 `{background}` shorthand (which is
// just a one-key partial over the default dark base).
// ---------------------------------------------------------------------------

/** dark base theme (the default when no base is named). */
export const GRAPH_THEME_DARK: GraphTheme = Object.freeze({
  background: '#0b0e14',
  nodeDefault: '#94a3b8',
  edgeDefault: 'rgba(255,255,255,0.15)',
  labelFg: '#e6e9f0',
  accent: '#3b82f6',
  mutedAlpha: 0.15,
  emphasisRing: '#7aa2f7',
});

/** light base theme. */
export const GRAPH_THEME_LIGHT: GraphTheme = Object.freeze({
  background: '#ffffff',
  nodeDefault: '#475569',
  edgeDefault: 'rgba(15,23,42,0.18)',
  labelFg: '#0f172a',
  accent: '#2563eb',
  mutedAlpha: 0.2,
  emphasisRing: '#2563eb',
});

/**
 * Resolve a ThemeInput to a full GraphTheme: pick the named base
 * (default dark), then merge every defined token over it. A full GraphTheme
 * input resolves to exactly its own tokens; `undefined` resolves to the dark
 * base; the v0.1 `{background}` compat shorthand merges as a partial.
 */
export function resolveTheme(input?: ThemeInput): GraphTheme {
  const base =
    input !== undefined && (input as { base?: 'light' | 'dark' }).base === 'light'
      ? GRAPH_THEME_LIGHT
      : GRAPH_THEME_DARK;
  if (input === undefined) return base;
  const out: GraphTheme = { ...base };
  if (input.background !== undefined) out.background = input.background;
  if (input.nodeDefault !== undefined) out.nodeDefault = input.nodeDefault;
  if (input.edgeDefault !== undefined) out.edgeDefault = input.edgeDefault;
  if (input.labelFg !== undefined) out.labelFg = input.labelFg;
  if (input.accent !== undefined) out.accent = input.accent;
  if (input.mutedAlpha !== undefined) out.mutedAlpha = input.mutedAlpha;
  if (input.emphasisRing !== undefined) out.emphasisRing = input.emphasisRing;
  return out;
}

function sameTheme(a: GraphTheme, b: GraphTheme): boolean {
  return (
    a.background === b.background &&
    a.nodeDefault === b.nodeDefault &&
    a.edgeDefault === b.edgeDefault &&
    a.labelFg === b.labelFg &&
    a.accent === b.accent &&
    a.mutedAlpha === b.mutedAlpha &&
    a.emphasisRing === b.emphasisRing
  );
}

// ---------------------------------------------------------------------------
// Scale-info surface. Categorical rows carry TOTAL counts over the accepted
// model; no separate mask-aware or scope-aware "filtered" count is exposed.
// ---------------------------------------------------------------------------

/** One categorical legend row: declared-domain rows first (including
 * currently-empty categories), then extra seen values sorted. */
export interface ScaleInfoRow {
  value: string;
  /** TOTAL occurrences over the accepted model (v0.8 tier: not mask-aware). */
  count: number;
  /** Palette slot from `categoricalIndex` (-1 = empty palette). */
  colorIndex: number;
}

/** `getScaleInfo` payload: the active Scale descriptor plus its resolved
 * numeric domain (sequential/diverging) or legend rows (categorical). */
export interface ScaleChannelInfo<N = Record<string, unknown>> {
  scale: Scale<string, N> | Scale<number, N>;
  /** Resolved numeric domain; omitted while unresolvable (no data/metric). */
  domain?: readonly [number, number];
  /** Categorical rows; omitted for sequential/diverging scales. */
  rows?: readonly ScaleInfoRow[];
}

/** Revision-aware service seam for expansion and search. */
export interface GraphServices<N = Record<string, unknown>, E = Record<string, unknown>> {
  /**
   * Ego-expansion resolver for `expandNode` / `SubgraphSpec.hops`. Default:
   * the built-in LOCAL service — it walks the core's adjacency over the
   * accepted model, INCLUDING currently out-of-scope nodes (zero config,
   * zero network; the core still never fetches).
   */
  expansion?: ExpansionService<N, E>;
  /**
   * path resolver for `findPath`. Default: the built-in LOCAL
   * unweighted BFS over the loaded VISIBLE edge list, respecting
   * PathOptions.direction. Revision-aware: a result arriving after a
   * dataset replacement is discarded at admission.
   */
  path?: PathService;
  /**
   * search resolver for `instance.search`. Default: the built-in LOCAL
   * indexed service over the accepted model plus the host's declared
   * `searchIndex` fields (id-only when never declared — it never guesses
   * attr names; zero config, zero network). Custom services plug in
   * server-side search (such as Omnigraph stored queries) with the same
   * instance-side correctness: RequestContext, revision-keyed caching, supersede
   * cancellation, stale rejection at admission.
   */
  search?: SearchService<N>;
}

export interface CreateGraphInstanceOptions<
  N = Record<string, unknown>,
  E = Record<string, unknown>,
> {
  /** Called once per mount; a re-attach constructs a fresh engine. */
  engine: EngineFactory;
  /** Fit the camera once when the first data-bearing commit reaches a fresh engine. Default true. */
  fitViewOnFirstData?: boolean;
  /** revision-aware services (expansion + search). */
  services?: GraphServices<N, E>;
  /**
   * node attr fields the DEFAULT search service indexes (ids always;
   * absent = id-only — the service never guesses attr names). CONSTRUCTION-
   * ONLY as a host construction option: read once here;
   * changing it requires a keyed remount / replacement instance. A runtime
   * `applyHostUpdate` attempt is ignored with a one-shot warning.
   */
  searchIndex?: readonly string[];
  /**
   * undo/redo. Default true. `false` makes the history
   * surface inert (record/undo/redo no-ops, depths stay 0); an object sets
   * the stack bound (default {@link HISTORY_LIMIT_DEFAULT} entries).
   */
  history?: boolean | { limit?: number };
  /**
   * Degradation-ladder thresholds. CONSTRUCTION-ONLY: read once; invalid
   * fields fall back to the defaults with ONE
   * config warning diagnostic. A runtime change requires a keyed remount.
   */
  limits?: Partial<ScaleLimits>;
  /**
   * Image-atlas resolver seam: owns authenticated fetch/caching for
   * one `nodeImage` ref. Default: plain `fetch(ref)` for public URLs.
   * Injectable for tests and authenticated hosts.
   */
  imageResolver?: ImageResolver;
  /**
   * Execution mode. Current worker cargo is columnar ACCEPTANCE: validation,
   * deduplication, and link resolution run off-thread, then land through
   * revision-gated async admission. 'main' (default) keeps every
   * columnar ingest synchronous; 'auto' and 'worker' route columnar data
   * through the worker lane when it boots — an unavailable lane degrades
   * to 'main' with one `worker-unavailable` info diagnostic under 'auto'
   * and an ERROR diagnostic under 'worker'. Columnar acceptance may still
   * fall back because it has no worker-required mode; channel projection
   * remains on the main thread.
   */
  execution?: 'auto' | 'main' | 'worker';
  /** Worker construction tri-option (URL / factory / inline
   * default). Testing seam: `transport` on the lane via this factory. */
  workerFactory?: WorkerFactoryOption;
}

/**
 * `expandNode` outcome:
 * - `{ added }` — the admitted result merged; `added` counts the nodes it
 * made newly visible in the current scope.
 * - `{ noop: true }` — every returned neighbor was already visible in the
 * current scope; no session was opened and nothing changed.
 * - `{ coalesced: true }` — reserved. v0.5 same-id coalescing hands the
 * SECOND caller the IDENTICAL in-flight promise, so both callers observe
 * the primary call's `{added}`/`{noop}` result instead of this marker.
 */
export type ExpandNodeResult = { added: number } | { coalesced: true } | { noop: true };

/**
 * expansion bookkeeping: one committed expansion overlay. Data-merging
 * batches carry the request id (overlayId + batch ids) and provenance into
 * ingestion so abort, rollback, and removeOverlay remove the exact
 * contribution they own.
 */
export interface ExpansionOverlayRecord {
  overlayId: string;
  requestId: string;
  /** Node ids this expansion revealed into the visible scope. */
  revealedIds: readonly NodeId[];
  /** Service-supplied provenance (single-response or stream header). */
  provenance?: unknown;
}

/**
 * Expansion record: one per SESSION-path expandNode
 * the {expandedId, addedNodeIds} entry retractExpansion pops. `addedNodeIds` are
 * the ids the expansion ASSERTS into the effective set: newly revealed ids
 * plus returned ids whose presence is itself expansion-made (listed by
 * another live record), so a node added by two expansions is owned by both
 * records and survives collapsing either. Records are SESSION-LOCAL:
 * module-local state only — never a store slice, never
 * serialized into view state (records must stay
 * out of it). They DO interleave with the undo stack as 'expansion'
 * steps (serializable value diffs of the effective-set state).
 */
interface ExpansionRecord {
  expandedId: NodeId;
  addedNodeIds: readonly NodeId[];
  /** Owning overlay — removed wholesale when a collapse leaves no survivor
   * under the v0.5 explicit-removal contract. */
  overlayId: string | null;
}

/** Serializable 'expansion'-slice payload (see ExpansionRecord). */
interface ExpansionStatePlain {
  records: { expandedId: NodeId; addedNodeIds: NodeId[]; overlayId: string | null }[];
  removed: NodeId[];
  extras: NodeId[];
}

/**
 * overlay label lane subscriptions. Two channels with distinct cadences:
 * - `subscribeCandidates` fires ONLY when the candidate SET (ids/text/forced)
 * changes — the throttled re-rank. React re-renders label content here.
 * - `subscribePositions` fires on scheduler ticks (host `onFrame`) with fresh
 * x/y for the SAME set — imperative transform writes, NO React re-render.
 * Both replay the current state synchronously on subscribe. The emitted array
 * and its placement objects are REUSED across position ticks — copy if you
 * need a snapshot.
 */
export interface LabelSubscriptions {
  subscribeCandidates(cb: (list: readonly LabelPlacement[]) => void): () => void;
  subscribePositions(cb: (list: readonly LabelPlacement[]) => void): () => void;
}

export interface GraphInstance<N = Record<string, unknown>, E = Record<string, unknown>> {
  /** Vanilla zustand store — the single observable state surface. */
  readonly store: StoreApi<GraphStoreState>;

  /** DOM label lane (overlay scheduler output). */
  readonly labels: LabelSubscriptions;

  /** Atomic host transaction: one store publication, at most one engine commit. */
  applyHostUpdate(update: GraphHostUpdate<N, E>): void;

  /**
   * revisioned ingestion: begin a bounded, cancellable session against an
   * explicit `datasetKey` and `baseModelRevision` (compare-and-set; mismatch
   * throws 'stale-revision'). Overlay sessions must name the CURRENT
   * datasetKey; replace sessions may establish a new one and are always
   * atomic.
   *
   * While a declarative data source is actively driving (a snapshot
   * was applied through `applyHostUpdate` and has not been superseded by a
   * committed replace session), `purpose:'replace'` is rejected at begin with
   * a TypeError — two writers may not race for the base. Overlay ingestion
   * stays allowed alongside a declarative base.
   *
   * Every session admission/publication is serialized through the
   * instance-local acceptance queue; arrival there is the global admission
   * order.
   */
  beginIngest(opts: BeginIngestOptions): IngestSession<N, E>;

  /**
   * atomically remove exactly one committed overlay — re-runs collision
   * and endpoint resolution, promotes formerly shadowed rows from surviving
   * overlays, advances model/render revisions, and releases the overlayId for
   * deliberate reuse. Unknown ids are an idempotent `{ removed: false }`.
   */
  removeOverlay(overlayId: string): { removed: boolean };

  /** Committed overlay ids for the current dataset. */
  getOverlayIds(): readonly string[];

  attach(container: HTMLElement): Promise<void>;
  detach(): void;
  destroy(): void;

  /**
   * typed events: listeners run SYNCHRONOUSLY in registration order; the
   * control's preventDefault cancels ONLY the built-in follow-up (click
   * selection, drag pin), never other listeners.
   */
  on<K extends GraphEventName>(
    name: K,
    cb: (payload: GraphEventMap<N, E>[K], control: GraphListenerControl) => void,
  ): () => void;

  // --- camera ---
  fitView(): void;
  zoomIn(): void;
  zoomOut(): void;
  setViewport(v: Partial<ViewportState>): void;

  /**
   * Focus neighborhood: keep the v0.1 camera behavior
   * (setFocusedIndex + zoomToIndex) and RETURN the 1-hop neighbor ids
   * (engine adjacency when available, else the core CSR adjacency).
   *
   * Documented compromise: the engine exposes ONE highlight channel, so the
   * neighbor ring is pushed through setSelectedIndices
   * ONLY when that cannot lie about real selection state — selection empty
   * and uncontrolled. The ring is a visual, never a store write; the next
   * selection push overwrites it. Opt out via `highlightNeighbors: false`.
   * Only `hops: 1` is currently supported.
   */
  focusNode(id: NodeId, opts?: { highlightNeighbors?: boolean; hops?: 1 }): readonly NodeId[];
  /**
   * emphasis ring WITHOUT the camera: ring `id` (null clears). The light
   * op keyboard navigation needs — arrowing a list must not fly the camera on
   * every keystroke (`focusNode` stays ring + zoom + neighbors). Unknown ids
   * are a silent no-op (a stale row racing a model swap is data, not an
   * error); `emphasisRing: false` suppresses it entirely. The target is
   * STICKY: it survives structural commits and context recovery until it is
   * cleared, its id departs the model, or pointer hover supersedes it
   * (emphasis belongs to the latest action — the rule).
   */
  emphasizeNode(id: NodeId | null): void;
  /**
   * Typed context-menu channel, opened from a DOM presenter. Label
   * divs are `pointerEvents: 'auto'` by design (click-to-focus), so a
   * right-click on one never reaches the engine canvas — without this seam
   * the nodes prominent enough to carry labels are exactly the ones whose
   * right-click falls through to the browser's native menu. Emits the SAME
   * 'contextMenu' event the canvas gesture produces; `screen` is
   * container-relative CSS px. Unknown ids are a
   * silent no-op (a stale label racing a model swap is data, not an error).
   */
  requestNodeContextMenu(id: NodeId, screen: readonly [number, number]): void;

  // --- selection ownership and set algebra ---
  setSelection(ids: readonly NodeId[] | SelectionState): void;
  selectNodes(ids: readonly NodeId[]): void;
  selectEdges(ids: readonly EdgeId[]): void;
  /** group namespace: validate against the CURRENT resolved
   * groups (unknown ids dropped, duplicates collapse) and store in
   * groups-array order — the group analog of accepted-base ordering. Never
   * touches the node/edge namespaces; the group namespace is always
   * instance-owned. */
  selectGroups(ids: readonly string[]): void;
  /** Expand to the 1-hop neighborhood of `id` (or of the current selection). */
  selectNeighbors(id?: NodeId): void;
  selectAll(): void;
  invertSelection(): void;
  clearSelection(): void;

  /**
   * lasso: resolve the SCREEN-coordinate polygon to node ids
   * via `engine.pointsInPolygon`, drop hidden ids, then replace (default) or
   * union (`additive`) the node selection through the same ownership
   * path as every other mutator (controlled → intent only). Returns the
   * resolved lasso ids (accepted-base order) regardless of ownership; empty
   * when the engine is not ready or lacks `pointsInPolygon`.
   */
  selectWithinPolygon(
    screenPolygon: readonly [number, number][],
    opts?: { additive?: boolean },
  ): readonly NodeId[];

  // --- edge picking. The route is fixed once per mount at ready
  // from `capabilities.linkPicking`: native adapters emit edge events from
  // host events; on the fallback route the binding calls the samplers below
  // on the shared pointer throttle cadence. ---
  /** Pure fallback-route query: the accepted edge within pick tolerance of a
   * SCREEN point. Null on the native route, while picking is disarmed (sim
   * hot), or when nothing is in range. */
  pickEdgeAt(screen: readonly [number, number]): AcceptedEdge<E> | null;
  /** Fallback-route hover sample: writes `hover.edgeId` and emits 'edgeHover'
   * on transitions (identical payloads to the native route). No-op (null) on
   * the native route. */
  sampleEdgeHover(screen: readonly [number, number]): AcceptedEdge<E> | null;
  /** Fallback-route click resolution: emits 'edgeClick' when a link is within
   * tolerance. No-op (null) on the native route. */
  sampleEdgeClick(screen: readonly [number, number]): AcceptedEdge<E> | null;
  /**
   * @internal Shared hit-test/overlay cadence: the count of engine
   * onFrame ticks this session. THE one clock every sampling route throttles
   * against (node hover and link picking share it by construction — there is
   * no second cadence timer anywhere; the lint rule enforces it).
   * The degradation ladder's defer-link-picking step arms/disarms against this counter;
   * telemetry reads it for idle-wakeup accounting.
   */
  getFrameCadence(): number;
  /**
   * @internal op counters (live object — snapshot before comparing):
   * the perf-gate-delta suite proves the brush fast path does O(Δ) work
   * zero full recomposes/refreshes/cascades across a scrub. telemetry
   * will fold these into `lastCommitMs`-adjacent accounting.
   */
  getPerfCounters(): Readonly<{
    brushSlotsTranslated: number;
    fullBrushRefreshes: number;
    fullCascades: number;
    fullNodeRecomposes: number;
    fullEdgeRecomposes: number;
  }>;
  /**
   * telemetry snapshot: counts, byte estimates, queue depth,
   * revisions, last-commit phase decomposition, active ladder steps,
   * execution lane, range availability, and the pressure mirror — never raw
   * attrs or ids. Synchronous in every lifecycle state (pre-scene fields
   * read zero/absent). `validate` is folded into `derive` until the
   * columnar lane splits acceptance from derivation.
   */
  getPerfSnapshot(): GraphPerfSnapshot;

  // --- hide/pin slices ---
  hideNodes(ids: readonly NodeId[]): void;
  showNodes(ids: readonly NodeId[]): void;
  showAll(): void;
  pinNode(id: NodeId, xy?: readonly [number, number]): void;
  unpinNode(id: NodeId): void;
  clearPins(): void;
  /** PERSISTENT pins: pin ids AT THEIR CURRENT POSITION via
   * engine.setPinnedIndices — no position payload in v0.10. Independent of
   * transient drag pinning (`pins`): the engine receives the UNION of both
   * slices, so releasing a drag pin leaves a persistent pin held.
   * ownership mirrors groups: once the host supplies `pinnedNodeIds` (null
   * included) the ops fire the 'pinnedChange' intent instead of writing.
   * Unknown ids drop; departed ids prune through the ownership path on
   * model changes. */
  pinNodes(ids: readonly NodeId[]): void;
  /** Release persistent pins (see {@link pinNodes}); unpinned ids no-op. */
  unpinNodes(ids: readonly NodeId[]): void;

  // --- group operations — the groups slice
  // mutators. Uncontrolled (no `groups` prop ever received): they write the
  // instance-owned groups state through the SAME validate → resolve →
  // rewrite lane as the prop (one publish, at most one commit) and fire
  // 'groupsChange' with the resolved array. Controlled (the prop was
  // provided at least once): they compute the next array and fire the
  // 'groupsChange' INTENT instead of writing — the host reflects it back.
  // Under `groupBy`, membership is derived and READ-ONLY: groupNodes/
  // ungroup are documented config errors (dev-mode warning diagnostic,
  // no-op); setGroupCollapsed is the ONE allowed op and toggles the
  // per-derived-KEY collapsed residue. ---
  /** Add one group definition (same acyclic/singly-parented validation as the
   * `groups` prop — a violating spec is ONE 'config-error' and a no-op). */
  groupNodes(spec: GroupSpec): void;
  /** Remove one group definition; its id prunes from SelectionState.groupIds
   * through the ownership path. Unknown ids no-op (dev-mode warning). */
  ungroup(groupId: string): void;
  /** Collapse/expand one group as a structural diff. Works on manual
   * groups AND groupBy-derived groups (the residue toggle). Same-value
   * calls are exact no-ops (zero publishes, zero commits). */
  setGroupCollapsed(groupId: string, collapsed: boolean): void;

  // --- node folds — the THIRD entry point into the same stage-3
  // containment rewrite. Where a collapsed group hides its members behind a
  // SYNTHETIC super-node, a fold makes an EXISTING node stand for its own
  // neighbourhood: the anchor keeps its row and its position, its members
  // hide, and their outside edges reroute to it as counted meta-edges.
  // Instance-owned and uncontrolled (no `folds` prop) — the pins precedent. ---
  /**
   * Folds `id`'s neighbourhood into `id`. Members default to the anchor's
   * neighbours in the CURRENT render model that no representative has
   * claimed yet — first fold wins, so folding two adjacent hubs never fights
   * over a shared neighbour and never needs a leaf-only restriction. Pass
   * `memberIds` to fold an explicit set instead (unknown ids and ids already
   * claimed elsewhere drop; an id that is an ANCESTOR of the anchor is
   * rejected, since that would close a containment cycle).
   *
   * One publish and at most one structural commit (E1). A no-member fold is
   * an exact no-op. Records a 'folds' history step.
   */
  foldNode(id: NodeId, opts?: { memberIds?: readonly NodeId[] }): void;
  /** Unfolds `id`, returning its members to the scene as a structural
   * diff. Unknown or unfolded ids are exact no-ops. */
  unfoldNode(id: NodeId): void;
  /** The members `id` currently stands for, or null when it is not folded.
   * Membership is the DECLARED set — members that have since left the model
   * are reported but simply do not draw. */
  getFold(id: NodeId): { memberIds: readonly NodeId[] } | null;

  // --- stage-4 clusters ---
  /** Current stage-4 clusters over the physical scene: ordered keys, member
   * ids, the force center labels anchor to while hot, and the settled
   * centroid (null until a readback or a fixed-layout commit). Empty
   * when no `clusters` spec is active. Clusters synthesize nothing — the
   * scene is byte-identical with and without a spec. */
  getClusters(): readonly ResolvedCluster[];
  /** resolve a cluster (by key) to its MEMBER node ids and write
   * them into SelectionState.nodeIds through the standard ownership
   * path — clusters have no id namespace of their own in selection.
   * `additive` unions with the current node selection. Unknown keys no-op. */
  selectCluster(key: string, opts?: { additive?: boolean }): void;

  // --- hard scope + expansion ---
  /**
   * isolate: hard-scope the graph to the CURRENT node selection
   * `subgraph: { seedIds: selection.nodeIds }` through the SAME path as the
   * host-update prop. No-op when nothing is selected. Ownership note (v0.5):
   * `subgraph` is UNCONTROLLED-ONLY — always instance-owned; the prop and
   * this method write the same state, last writer wins.
   */
  isolateSelection(): void;
  /** clear the hard scope (`subgraph: null`) — the full accepted model
   * returns with cached positions. */
  resetIsolation(): void;
  /**
   * Ego-expansion of `id` (default 1 hop) through the configured
   * ExpansionService. The result is gated by admission (declared revision
   * dependencies + dataset lineage + seed existence — abort is only an
   * optimization) and merges through ONE awaited atomic overlay
   * IngestSession carrying the request id; a discard/rejection leaves the
   * graph untouched ('service-aborted' info / 'service-error' error
   * diagnostic; the promise rejects, the 'error' event never fires). Within
   * one valid scope revision a second same-id call while one is in flight
   * returns the IDENTICAL promise (one service call serves both); distinct
   * ids run concurrently. Under an active hard scope, revealed neighbors
   * join the resolved scope (accretion) in the same commit.
   */
  expandNode(id: NodeId, opts?: { hops?: number }): Promise<ExpandNodeResult>;
  /**
   * Undoes `id`'s own expansions — the navigation Back button, NOT a
   * containment operation. Aborts `id`'s pending expansion AND explicitly
   * removes the overlays its past expansions committed (plus their scope
   * accretion). Committed overlay DATA otherwise persists until
   * `removeOverlay()` or a replacing snapshot; this IS that explicit removal for
   * expansion overlays.
   *
   * On a node that was never expanded from, this does nothing — there is no
   * record to pop. To hide a node's neighbourhood behind it on a freshly
   * loaded graph, that is {@link foldNode}: one word for containment, a
   * different word for navigation history.
   */
  retractExpansion(id: NodeId): void;
  /** expansion bookkeeping for `id`: committed overlay records with
   * request id, provenance, and the ids each expansion revealed. */
  getExpansionOverlays(id: NodeId): readonly ExpansionOverlayRecord[];

  // --- search ---
  /**
   * Run the configured SearchService (default: the built-in local indexed
   * service). The instance creates the `RequestContext`, caches results by
   * `serviceCacheKey` over EXACTLY the service's declared revision
   * dimensions ({@link SEARCH_CACHE_LIMIT}-entry LRU; a second call with an
   * equal key while one is in flight coalesces onto the same service call),
   * cancels superseded work (a NEWER query aborts the older in-flight call
   * the older promise rejects `OrbitOperationError {code:'aborted'}`), and
   * rejects stale results at admission (declared revision drift or dataset
   * lineage change → the same typed 'aborted' rejection with a distinct
   * staleness message; the store is untouched). A successful search
   * publishes `store.search = {query, results}` — `node` populated for
   * in-model ids — in ONE store publication. Search NEVER changes
   * scope/filter semantics and never fetches graph data.
   */
  search(query: string, opts?: { limit?: number }): Promise<readonly SearchResult<N>[]>;
  /** Clear `store.search` to null (e.g. the <GraphSearch> input emptied). */
  clearSearch(): void;
  /** path query + atomic emphasis: resolves via the path
   * service (local BFS default); null = unreachable (a RESULT). Emphasis is
   * session-local — released by clearPath, any selection mutation, undo/
   * redo, or a scene rebuild; never a history step; never serialized. */
  findPath(sourceId: NodeId, targetId: NodeId, options?: PathOptions): Promise<PathResult | null>;
  clearPath(): void;
  getActivePath(): PathResult | null;
  /**
   * Result contract: a result id in the current rendered scene
   * AND mask-visible is focused (`focusNode`) → `{status:'focused'}`.
   * Otherwise classification ONLY — 'not-loaded' (absent from the accepted
   * model), 'out-of-scope' (in the model but outside the hard scope),
   * 'filtered' (in the scene but mask-hidden). Never mutates scope or
   * filters — the host reacts explicitly.
   */
  activateSearchResult(result: SearchResult<N>): SearchActivation;

  // --- simulation controls ---
  pauseSimulation(): void;
  resumeSimulation(): void;
  isSimulationRunning(): boolean;

  /** screenshot: delegates to the engine; null when unsupported/not ready. */
  captureScreenshot(): Promise<Blob | null>;

  /**
   * binding-detected reduced-motion media preference. The EFFECTIVE
   * value is `accessibility.reducedMotion ?? v` — when reduced, camera
   * durations (fitView/setViewport/focusNode) coerce to 0.
   */
  setReducedMotion(v: boolean | undefined): void;

  // --- crossfilter ---
  /**
   * The crossfilter session facade, or null until the `crossfilter` prop has
   * configured dimensions over an accepted base. Delegates to the
   * typed-column engine; `setBrush` routes visibility deltas into the
   * soft mask (buffers-only commit, zero relayout) and resolves after the
   * publish. Brush slot deltas are BASE indices; under a hard scope
   * out-of-scope rows have no scene slot and simply do not mask anything.
   */
  getCrossfilterSession(): CrossfilterSession | null;

  // --- timeline playback ---
  /**
   * Play a brush window across a numeric/temporal dimension's domain through
   * the crossfilter mask fast path (zero relayout). One playing dimension at
   * a time — a second play supersedes; a USER `setBrush` on the playing key
   * pauses playback. The whole play session coalesces into ONE history entry.
   */
  playTimeline(key: string, playback?: Partial<TimelinePlayback>): void;
  pauseTimeline(): void;

  // --- history ---
  /** Undo the most recent uncontrolled mutation entry (selection / hidden /
   * pins / scope / brushes). Returns false when there is nothing to undo. */
  undo(): boolean;
  /** Re-apply the most recently undone entry. False when nothing to redo. */
  redo(): boolean;

  // --- view state ---
  /**
   * Serialize the exploration state: camera, selection, hidden ids,
   * isolation, groups (manual specs verbatim; under `groupBy` only collapsed
   * `{key, collapsed}` pairs — membership recomputes on restore), pins,
   * folds, layout, crossfilter brushes in declaration order, the Scale-valued
   * styling subset, and the host's `dataRef` verbatim. The predicate `filter`
   * and expansion records are never serialized. The sync form carries
   * no positions: reproduction is best-effort via the layout descriptor.
   */
  getViewState(opts?: { includePositions?: false }): GraphViewState;
  /**
   * Async form: additionally embeds quantized coordinates for the VISIBLE
   * (post-mask) set, read once from the engine as event-time readback.
   * Restores as a frozen fixed-equivalent — pixel-faithful regardless of
   * engine nondeterminism. Past `maxPositions` (default 100 000) the call
   * rejects `export-materialization-too-large`; persist the layout through
   * the export lane and reference it from `dataRef` instead of inlining.
   */
  getViewState(opts: {
    includePositions: true;
    maxPositions?: number;
  }): Promise<GraphViewState>;
  /**
   * Atomically restore a serialized view. NEVER partially applies:
   * structural validation and the version gate run first (reject whole with
   * one 'invalid-view-state' diagnostic); then the dataRef canonical
   * comparison — a mismatch fires the 'viewStateMismatch' event INSTEAD of
   * applying, and restoration proceeds only on an `ignoreMismatch` re-call.
   * The apply is ONE history transaction through the same command appliers
   * undo/redo uses, so a restore is itself undoable. Embedded positions
   * apply as a frozen fixed-equivalent (one replay-style commit, then the
   * simulation pauses — a later explicit layout change or reheat unfreezes).
   * A state touching a controlled slice (or styling, once a restore
   * callback exists) resolves 'missing-restore-callback' until the aggregate
   * protocol is registered.
   */
  setViewState(
    raw: unknown,
    opts?: {
      ignoreMismatch?: boolean;
      isDataRefEqual?: (stored: JsonValue | undefined, current: JsonValue | undefined) => boolean;
    },
  ): Promise<SetViewStateResult>;

  // --- exports ---
  /**
   * Picture exports. 'png' delegates to {@link captureScreenshot} (typed
   * rejection when the engine lacks the capability). 'svg' renders the
   * VISIBLE (post-mask) set through the engine-free exporter: one per-event
   * position readback, colors/sizes from the same projectors the commits
   * use, labels from the current candidate set, in space coordinates with a
   * padded viewBox. Above `maxSvgElements` (default 50 000) it rejects
   * `export-too-large` — pass `fallback: 'raster-hybrid'` to instead receive
   * a PNG base layer with a vector label overlay.
   */
  exportImage(format: 'png'): Promise<Blob>;
  exportImage(
    format: 'svg',
    opts?: { maxSvgElements?: number; fallback?: 'raster-hybrid' },
  ): Promise<string>;
  /**
   * Bounded object export of the pinned model: 'visible' (default) is the
   * mask-visible roster with both-endpoint-visible edges; 'accepted' the
   * full model. Rejects `export-materialization-too-large` past `limit`
   * (default 100 000 rows) BEFORE allocating — the stream is the remedy.
   */
  exportData(
    scope?: 'visible' | 'accepted',
    opts?: { limit?: number },
  ): Promise<{ nodes: readonly GraphNode<N>[]; edges: readonly AcceptedEdge<E>[] }>;
  /** Memory-bounded JSONL: one `{"kind":"node"|"edge","value":…}` line per
   * entity over ONE pinned revision — a mid-stream commit never mixes
   * epochs. Closing the generator releases the pin. */
  exportDataStream(scope?: 'visible' | 'accepted'): AsyncGenerator<string, void, undefined>;
  /** Bounded id → [x, y] map from one position readback. */
  exportLayout(opts?: { limit?: number }): Promise<ReadonlyMap<NodeId, readonly [number, number]>>;
  /** Memory-bounded `{"id","x","y"}` JSONL over one pinned readback. */
  exportLayoutStream(): AsyncGenerator<string, void, undefined>;

  // --- styling reads ---
  /**
   * legend surface: the active Scale on a styling channel plus its
   * resolved domain (sequential/diverging — resolved through the SAME frozen
   * DomainStore coordinate the projection uses) or categorical legend rows
   * (declared-domain order first including empty categories, then extra seen
   * values sorted; counts are v0.8-tier TOTALS over the accepted model, not
   * mask-aware). Null when the channel is not scale-valued.
   */
  getScaleInfo(channel: 'nodeColor' | 'nodeSize'): ScaleChannelInfo<N> | null;
  /**
   * metric read for one node id via the core id→index map (never a
   * public million-entry Map). Null for unknown ids, unknown metrics, and
   * null values; lazily computes the degree family on first use.
   */
  getMetricValue(metric: MetricName, id: NodeId): number | null;

  // --- reads ---
  getRevisions(): Revisions;
  getDiagnostics(): readonly GraphDiagnostic[];
  getNode(id: NodeId): GraphNode<N> | undefined;
  /** Accepted edge by id — the symmetric partner of {@link getNode}, and the
   * way a hover/selection consumer resolves `store.hover.edgeId` or
   * `selection.edgeIds` to real records. Undefined for unknown ids. */
  getEdge(id: EdgeId): AcceptedEdge<E> | undefined;
  /** Scene ids that are mask-visible (scope ∧ mask), scene order. */
  getVisibleNodeIds(): readonly NodeId[];
  /** Scene roster: scope applied, mask NOT applied — the navigator's
   * entry list, which must still LIST masked/hidden nodes and expose their
   * state in text rather than dropping them. */
  getSceneNodeIds(): readonly NodeId[];
  /** accessibility config stash (navigator/live-region consumers). */
  getAccessibility(): AccessibilityConfig<N> | undefined;
}

const ZOOM_STEP = 1.5;
const EMPTY_IDS: readonly NodeId[] = [];
const EMPTY_SELECTION: SelectionState = { nodeIds: [], edgeIds: [], groupIds: [] };
const EMPTY_PINS: ReadonlyMap<NodeId, readonly [number, number]> = new Map();
const EMPTY_PINNED: ReadonlySet<NodeId> = new Set();
const EMPTY_HIDDEN: ReadonlySet<NodeId> = new Set();
const EMPTY_INDEX: ReadonlyMap<string, number> = new Map();
const EMPTY_GROUPS: readonly ResolvedGroup[] = Object.freeze([]);
const EMPTY_CLUSTERS: readonly ResolvedCluster[] = Object.freeze([]);
const EMPTY_GROUP_SPECS: readonly GroupSpec[] = Object.freeze([]);
const EMPTY_FOLD_RECORDS: readonly FoldRecord[] = Object.freeze([]);
const EMPTY_FOLD_COUNTS: ReadonlyMap<NodeId, number> = new Map();
const EMPTY_OVERLAY_IDS: readonly string[] = [];
const EMPTY_EXPANSIONS: ReadonlySet<NodeId> = new Set();
const EMPTY_EXPANSION_RECORDS: readonly ExpansionOverlayRecord[] = [];
/** a post-recovery replay reheats gently, not with a full relayout. */
const RECOVERY_RESTART_ALPHA = 0.1;
/** consecutive same-dimension brush moves within this window merge
 * into one history entry (scrub/drag coalescing). */
export const BRUSH_HISTORY_COALESCE_MS = 500;
/** timeline defaults. */
export const TIMELINE_TICK_MS_DEFAULT = 100;
export const TIMELINE_STEP_DEFAULT = 0.01;
/** search defaults. */
export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_CACHE_LIMIT = 32;
/** A play session coalesces into ONE entry: effectively-infinite window,
 * closed at pause by rotating the session-scoped coalesce key. */
const TIMELINE_COALESCE_WINDOW_MS = Number.MAX_SAFE_INTEGER;
/** Debug builds (vitest/vite dev) run the history serializability walk. */
const DEV: boolean = Boolean((import.meta as { env?: { DEV?: unknown } }).env?.DEV);
/**
 * Injectable clock seam for history coalescing windows — `Date.now` so vitest
 * fake timers (which fake `Date` by default) drive it deterministically.
 */
const nowMs = (): number => Date.now();
/**
 * Mirrors projection.ts's DEFAULT_COLOR_FALLBACK: the base RGBA used to
 * synthesize a color channel when the host never configured an accessor but
 * the mask needs an alpha lane to reach the engine.
 */
const DEFAULT_RGBA: readonly [number, number, number, number] = [0.66, 0.66, 0.66, 1];
/** minimum interval between 'perfSample' emissions — the
 * "throttled, never per frame" contract. */
const PERF_SAMPLE_THROTTLE_MS = 1_000;

/** frame-pressure bounds: engage the cheap ladder steps when
 * the frame EWMA is past ~25fps, release when it recovers past ~35fps
 * asymmetric on purpose (panic down, recover slowly; the controller's dwell
 * adds the time half of the anti-flap stack). */
const FRAME_PRESSURE_ENGAGE_MS = 40;
const FRAME_PRESSURE_CLEAR_MS = 28;

/** trailing throttle for viewport-driven candidate re-ranks (ms). */
const LABEL_RERANK_THROTTLE_MS = 100;
/** sim-hot degradation: minimum spacing between cache readbacks (ms). */
const SIM_HOT_REFRESH_MS = 500;

/** Per-attach engine session; `alive` gates stale mount continuations and
 * stale engine events after detach/destroy. */
interface MountSession {
  engine: GraphEngine;
  /** The host container — read for the label lane's viewport cull rect. */
  container: HTMLElement;
  alive: boolean;
  /** fitViewOnFirstData fires once per fresh engine. */
  fitDone: boolean;
  /** edge-picking facade; route fixed ONCE at ready (null pre-ready). */
  edgePicking: EdgePickingFacade | null;
  /** capability policy — resolved ONCE per session at ready from
   * the declared capability record (never method sniffing). */
  policy: EnginePolicy | null;
}

interface DirtyChannels {
  nodeColor: boolean;
  nodeSize: boolean;
  linkColor: boolean;
  linkWidth: boolean;
}

// ---------------------------------------------------------------------------
// ingestion session records (instance-internal).
// ---------------------------------------------------------------------------

/** One admitted append: the idempotency record replays resolve against. */
interface IngestEntry {
  batchId: string;
  bytes: number;
  /** Mutated once at settlement (publishedModelRevision / pendingBytes). */
  receipt: AppendReceipt;
  promise: Promise<AppendReceipt>;
  resolve: (r: AppendReceipt) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

interface IngestSessionRecord<N, E> {
  readonly purpose: 'replace' | 'overlay';
  readonly datasetKey: string;
  readonly sourceRevision: number | string | null;
  readonly atomic: boolean;
  /** null for replace sessions. */
  readonly overlayId: string | null;
  readonly maxFlushLatencyMs: number;
  readonly maxPendingBytes: number;
  state: IngestSessionState;
  /** overlayId reserved at the first append/commit reaching the queue. */
  reserved: boolean;
  nextSequence: number;
  entries: Map<number, IngestEntry>;
  /** The session tag index: rollback removes exactly these rows. */
  contribution: SessionContribution<N, E>;
  tallies: StagingTallies;
  /** Progressive entries whose receipts await the next flush publication. */
  unflushed: IngestEntry[];
  pendingBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** True once any provisional row became public (progressive flush). */
  published: boolean;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameSelection(a: SelectionState, b: SelectionState): boolean {
  return (
    sameIds(a.nodeIds, b.nodeIds) && sameIds(a.edgeIds, b.edgeIds) && sameIds(a.groupIds, b.groupIds)
  );
}

function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

/** Drop ids missing from `base`; returns the ORIGINAL array when nothing drops. */
function pruneIds(ids: readonly string[], base: ReadonlyMap<string, number>): readonly string[] {
  let anyDropped = false;
  for (const id of ids) {
    if (!base.has(id)) {
      anyDropped = true;
      break;
    }
  }
  return anyDropped ? ids.filter((id) => base.has(id)) : ids;
}

export function createGraphInstance<N = Record<string, unknown>, E = Record<string, unknown>>(
  opts: CreateGraphInstanceOptions<N, E>,
): GraphInstance<N, E> {
  const engineFactory = opts.engine;
  const fitViewOnFirstData = opts.fitViewOnFirstData ?? true;

  const store = createStore<GraphStoreState>(() => ({
    status: 'idle',
    revisions: { source: null, model: 0, scope: 0, render: 0, appliedRender: null },
    nodeCount: 0,
    edgeCount: 0,
    selection: EMPTY_SELECTION,
    hover: { nodeId: null, edgeId: null },
    pins: EMPTY_PINS,
    pinnedNodeIds: EMPTY_PINNED,
    hiddenNodeIds: EMPTY_HIDDEN,
    scope: null,
    visible: { nodes: 0, edges: 0 },
    timeline: { playingKey: null },
    history: { undoDepth: 0, redoDepth: 0 },
    pendingExpansions: EMPTY_EXPANSIONS,
    folds: EMPTY_FOLD_COUNTS,
    overlayIds: EMPTY_OVERLAY_IDS,
    groups: EMPTY_GROUPS,
    search: null,
    viewport: null,
    simulationRunning: false,
    theme: resolveTheme(undefined),
    diagnostics: [],
  }));

  // --- model state (survives detach; cleared only on datasetKey change) ---
  let reconciler = new Reconciler();
  /** The EFFECTIVE accepted graph: base merged with published overlays. */
  let accepted: AcceptedGraph<N, E> | null = null;
  let scene: RenderScene | null = null;

  // --- ingestion state ---
  /** The instance-local acceptance queue — EVERY state publication
   * (applyHostUpdate, session admissions/flushes/commits/aborts, overlay
   * removals, wave-2 service admissions) routes through it. Arrival order is
   * the global admission order; v0.5 executes synchronously. */
  const acceptanceQueue = new AcceptanceQueue();
  /** The accepted BASE (declarative snapshot or committed replace session),
   * without overlays. `accepted` above is the merged view. */
  let baseAccepted: AcceptedGraph<N, E> | null = null;
  /** Replace-session base edges still awaiting endpoints. */
  let basePendingEdges: readonly StampedEdge<E>[] = [];
  /** Who established the base — the replace-vs-declarative gate. */
  let baseSource: 'declarative' | 'session' | null = null;
  const openSessions = new Set<IngestSessionRecord<N, E>>();
  /** Contributions with public rows, in first-publication order (merge sorts
   * rows by admission ticket, so list order is bookkeeping only). */
  let publishedContributions: SessionContribution<N, E>[] = [];
  let committedOverlayIds: readonly string[] = EMPTY_OVERLAY_IDS;
  /** overlayId → owning session (open since first append, or committed). */
  const reservedOverlayIds = new Map<string, IngestSessionRecord<N, E>>();
  let overlayIdSeq = 0;
  /** Accepted edge id → position in accepted.edges (accepted-base order). */
  let edgeIndexById: ReadonlyMap<EdgeId, number> = EMPTY_INDEX;
  /** CSR adjacency, built lazily per accepted model (focus neighborhood
   * fallback when the engine lacks neighborIndices); invalidated on model
   * change. */
  let adjacency: Adjacency | null = null;
  /** lazy scene INCIDENCE (point -> incident edge slots) driving the
   * O(incident-edges) brush cascade; same lifecycle as the lazy CSR above. */
  let sceneIncidence: Incidence | null = null;
  /** Last projected linkWidth buffer — feeds the pick-tolerance median. */
  let lastLinkWidths: Float32Array | null = null;

  // --- hard scope + expansion state ---
  /** The active hard scope. UNCONTROLLED-ONLY in v0.5: the `subgraph` prop
   * and isolateSelection/resetIsolation write this SAME instance-owned
   * state (there is no controlled subgraph mode). */
  let scopeSpec: SubgraphSpec | null = null;
  /** scope accretion: ids expansions revealed into the resolved scope.
   * Folded into computeScopedAccepted on top of the user's SubgraphSpec;
   * reset by an explicit subgraph statement or a replacing snapshot/session. */
  const scopeExtraIds = new Set<NodeId>();
  /** The scoped subset fed to the reconciler; null = full scope. */
  let scopedAccepted: AcceptedGraph<N, E> | null = null;
  /** CSR adjacency of the EFFECTIVE accepted model — the cache point for
   * scope resolution and the built-in local expansion service. Lazy;
   * invalidated on every accepted-model change (never by scope changes). */
  let acceptedAdjacency: Adjacency | null = null;
  /** in-flight-expansion ledger (coalescing + collapse abort). */
  const expansionLedger = new PendingExpansions();
  /** id → the in-flight promise same-id callers coalesce onto. */
  const expansionPromises = new Map<NodeId, Promise<ExpandNodeResult>>();
  /** requestId → abort handle for the in-flight service call. */
  const expansionHandles = new Map<string, RequestContextHandle>();
  /** requestId → external rejector (collapse/destroy settle the caller
   * promise immediately; the late service completion is then discarded). */
  const expansionRejectors = new Map<string, (e: unknown) => void>();
  /** Root id → overlays its expansions committed. */
  const expansionOverlays = new Map<NodeId, ExpansionOverlayRecord[]>();
  /** Expansion record stack (see ExpansionRecord): session-local, module-
   * local only — never a store slice, never serialized. Ordered oldest →
   * newest; retractExpansion(id) pops the NEWEST record whose expandedId is id. */
  let expansionRecords: ExpansionRecord[] = [];
  /** Effective-set exclusions: accepted-model ids a collapse
   * removed from the DISPLAYED set while their data persists.
   * Folded into computeScopedAccepted (with or without a hard scope); reset
   * by an explicit subgraph statement and a dataset swap; pruned when the
   * referenced nodes depart the accepted snapshot. */
  const effectiveRemovedIds = new Set<NodeId>();
  /** Pinned accretion: previously-placed ids held still while an
   * expansion settles; released to just user pins on the next simulationEnd. */
  let accretionPinIds: ReadonlySet<NodeId> | null = null;
  /** expansion resolver (caller-supplied or the built-in local walk). */
  const expansionService: ExpansionService<N, E> =
    opts.services?.expansion ??
    createLocalExpansionService<N, E>(() => {
      if (accepted === null) {
        throw new OrbitOperationError(
          { code: 'aborted', cause: 'no accepted base' },
          'expansion requires an accepted base dataset',
        );
      }
      return { accepted, adjacency: acceptedAdjacencyOf() };
    });

  // --- search state ---
  /** Host-declared attr fields the DEFAULT search service indexes (ids
   * always); undefined = id-only. CONSTRUCTION-ONLY (D7): read once from
   * the options — a runtime change requires a keyed remount. */
  const searchIndexFields: readonly string[] | undefined = opts.searchIndex;
  /** dataRef: host-owned durable source coordinate, stored VERBATIM
   * and never interpreted; serialized into view states and canonically
   * compared on restore. Update lane is stash-only (no publish, no commit
   * it affects serialization, not rendering). */
  let dataRef: JsonValue | undefined;
  /**
   * aggregate restore protocol (Wave 3): at most ONE staged
   * transaction. Internal commands are HELD (not applied) until every
   * awaited controlled lane arrives from the host with matching values;
   * timeout / divergence / supersession discard the stage with a typed
   * result and the previous scene stays live throughout.
   */
  interface PendingRestore {
    transactionId: string;
    source: 'setViewState' | 'undo' | 'redo';
    commands: readonly HistoryCommand[];
    awaiting: {
      selection?: readonly NodeId[];
      pinnedNodeIds?: readonly NodeId[];
      groups?: readonly GroupSpec[];
    };
    /** Side lanes to run on commit (groups residue, styling, positions,
     * camera for setViewState; cursor publication for history walks). */
    finish: () => void;
    /** History-walk staging: put the cursor back on failure. */
    rollbackCursor?: () => void;
    /** Record the commands as a kernel transaction on commit (setViewState
     * path — history walks were already recorded). */
    recordOnCommit: boolean;
    resolve: (r: SetViewStateResult) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  let pendingRestore: PendingRestore | null = null;
  let restoreTxSeq = 0;
  const RESTORE_ACK_TIMEOUT_MS = 5000;

  /** One-shot per channel: styling values dropped from view-state capture
   * (accessor function / GraphTheme object / function-`by` scale) warn once
   * per instance in dev. A getter must not publish (D10 inverse),
   * so this is a console warning, not a diagnostic. */
  const viewStateDropWarned = new Set<string>();

  /** One-shot D7 guard: the first runtime searchIndex attempt warns. */
  let searchIndexChangeWarned = false;

  // --- path emphasis state — SESSION-LOCAL: cleared by any
  // selection mutation, undo/redo, and every scene rebuild; never a history
  // step; never serialized into view state. ---
  /** Link indices dimmed while a path owns the link lane (composed inside
   * composeEdgeAlphaBuffer so every drain preserves the emphasis). */
  let pathDimEdges: ReadonlySet<number> | null = null;
  let activePath: PathResult | null = null;
  /** Supersede token: only the LATEST findPath call may apply emphasis. */
  let pathSeq = 0;
  /** path resolver (caller-supplied or the built-in local BFS over the
   * loaded VISIBLE edge list — scoped-out edges are not traversable). */
  const pathServiceImpl: PathService =
    opts.services?.path ??
    createLocalPathService<N, E>(() => ({
      nodes: accepted === null ? [] : accepted.nodes,
      edges: accepted === null ? [] : accepted.edges,
      isEdgeVisible: (id) => {
        if (scene === null) return true; // pre-mount: the loaded set is the base
        const k = sceneLinkIndexOf(id);
        if (k === undefined) return false; // out of scope → not traversable
        return softMask === null || softMask.isEdgeVisible(k);
      },
    }));
  /** Lazy edge-id → SCENE link index (invalidated with the scene; the path
   * base and emphasis both need link-lane indices, not accepted order). */
  let sceneLinkIndexCache: { scene: RenderScene; map: ReadonlyMap<EdgeId, number> } | null = null;
  function sceneLinkIndexOf(id: EdgeId): number | undefined {
    if (scene === null) return undefined;
    if (sceneLinkIndexCache === null || sceneLinkIndexCache.scene !== scene) {
      const map = new Map<EdgeId, number>();
      for (let k = 0; k < scene.edgeIdByIndex.length; k++) map.set(scene.edgeIdByIndex[k]!, k);
      sceneLinkIndexCache = { scene, map };
    }
    return sceneLinkIndexCache.map.get(id);
  }
  /** search resolver (caller-supplied or the built-in local index). */
  const searchService: SearchService<N> =
    opts.services?.search ??
    createLocalSearchService<N>(() => ({
      nodes: accepted === null ? [] : accepted.nodes,
      searchIndex: searchIndexFields,
    }));
  /** serviceCacheKey → shared search promise (settled results stay cached;
   * failures evict). Insertion-ordered Map as the LRU. */
  const searchCache = new Map<string, Promise<readonly SearchResult<N>[]>>();
  /** The single in-flight search service call — a newer query aborts it. */
  let searchFlight: {
    key: string;
    handle: RequestContextHandle;
    reject: (e: unknown) => void;
  } | null = null;
  /** Monotonic search call token: only the LATEST call publishes, so a
   * slow superseded result or a replayed cache hit never clobbers a newer
   * store.search publication. */
  let searchSeq = 0;

  // --- soft-mask state. ONE SoftMask instance sized to the current
  // scene; sources: 'filter' (the filter prop), 'hidden' (hiddenNodeIds),
  // 'brushes' (crossfilter selection), plus the kernel's internal node→edge
  // cascade. Memberships are REBUILT from their definitions after every
  // structural change (slot indices shift). ---
  let softMask: SoftMask | null = null;
  let maskFilterSource: MaskSource | null = null;
  let maskHiddenSource: MaskSource | null = null;
  let maskBrushSource: MaskSource | null = null;
  /** Active filter prop state. The spec is host CONFIG (like nodeColor): it
   * survives datasetKey changes and re-evaluates against the new scene. */
  let activeFilterSpec: FilterSpec<N, E> | null = null;
  let activeFilterKey: string | null = null;
  let activeFilterMode: FilterMode = 'hide';
  let compiledNodeSelector: CompiledFilter<GraphNode<N>> | null = null;
  let compiledEdgeSelector: CompiledFilter<AcceptedEdge<E>> | null = null;
  /** Scene slots hidden by the filter prop's NODE lane (hide mode only)
   * feeds the crossfilter external mask without re-running predicates. */
  let filterHiddenNodeSlots: ReadonlySet<number> = new Set();
  /** ONE aggregated 'filter-error' diagnostic per evaluation pass. */
  let filterDiags: readonly GraphDiagnostic[] = [];
  /** Unmasked base RGBA buffers cached from projection — masked COPIES go to
   * the engine so a later mask-only drain can rebuild alphas without
   * re-projecting. */
  let basePointColors: Float32Array | null = null;
  let baseLinkColors: Float32Array | null = null;
  /** True when the corresponding base buffer was SYNTHESIZED from the
   * active theme's default token (no accessor configured) rather than
   * projected — a changed theme token must rebuild synthesized bases, never
   * projected ones, preserving base styling during mask composition. */
  let basePointColorsSynthesized = false;
  let baseLinkColorsSynthesized = false;

  // --- stage-3 groups state. `groupsSpec` is host CONFIG
  // (like the filter prop): it survives dataset swaps and re-RESOLVES against
  // each accepted model (departed members drop tolerantly — validation
  // guards only the boundary where a NEW array is applied, D4). ---
  /**
   * node folds: anchor node id → the members it stands for while
   * folded. Presence IS the folded state — `unfoldNode` deletes the entry.
   *
   * SESSION-LOCAL and instance-owned, like pins and expansion records: there
   * is no `folds` prop, so the controlled/uncontrolled duality never
   * arises. Folds live entirely in stage 3 (they feed the representative
   * forest) and deliberately NOT in `effectiveRemovedIds`, whose path
   * cascades edges away — a fold must REROUTE a member's outside edges to
   * its anchor, not delete them.
   */
  const folds = new Map<NodeId, readonly NodeId[]>();
  /** Set by fold ops so the next inner update re-runs the stage-3 rewrite. */
  let pendingFoldsRefresh = false;
  /** Last ACCEPTED manual groups array (violating arrays never land here). */
  let groupsSpec: readonly GroupSpec[] | null = null;
  /** Resolution published as store.groups (membership ∩ accepted model). */
  let resolvedGroups: readonly ResolvedGroup[] = EMPTY_GROUPS;
  /** Current stage-3 output; null = pass-through scene (no collapsed group
   * intersects the render model). Recomputed on EVERY reconcile. */
  let groupRewrite: GroupRewrite<N, E> | null = null;
  /** Stage-5 meta-entity mask source: a super-node passes iff ANY member
   * passes; a meta-edge iff ANY underlying edge passes. */
  let maskGroupSource: MaskSource | null = null;
  /** At most ONE 'config-error' diagnostic from the last rejected pass. */
  let groupsDiags: readonly GraphDiagnostic[] = [];

  // --- groups ownership and groupBy lanes. ---
  /** ownership: flips to controlled on the FIRST host update carrying
   * `groups` (null included — a clear is still a host statement),
   * permanently. Controlled ops fire the 'groupsChange' intent instead of
   * writing; internal op writes never flip this. */
  let groupsControlled = false;
  /** True while an instance op routes its candidate array through
   * applyHostUpdateInner — distinguishes op writes from host writes. */
  let groupsInternalWrite = false;
  /** groupBy lane: host CONFIG like groupsSpec (survives dataset
   * swaps, re-derives per accepted model). `semanticZoom` is validated at
   * the boundary (D4) and STASHED here — semantic-zoom band tracking reads it from
   * the viewport-event seam; nothing else consumes it yet. */
  let groupBySpec: GroupBySpec<N> | null = null;
  /** store residue: collapsed derived groups keyed by DERIVED KEY
   * (never by id) — survives re-derivation while the key stays alive, drops
   * keys that vanish, and clears on datasetKey change. */
  const groupByCollapsedKeys = new Set<string>();
  /** Derived public id → derived key for the CURRENT derivation (the
   * setGroupCollapsed reverse lookup). */
  let groupByKeyById: ReadonlyMap<string, string> = new Map();
  /** semantic-zoom BAND: the last threshold the
   * zoom crossed. `null` = no threshold crossed yet, so a zoom that starts
   * BETWEEN the thresholds flips nothing (hysteresis holds from the very
   * first event). Reset when the spec or dataset changes. */
  let semanticZoomBand: 'collapsed' | 'expanded' | null = null;
  /** Set by ops that changed instance-side group inputs (collapsed residue)
   * outside the host-update diff; the next inner update re-resolves. */
  let pendingGroupsRefresh = false;
  /** Forces the next inner update to recompose store.diagnostics after a
   * lane changed outside its own diffing (e.g. a cleared op verdict). */
  let pendingDiagnosticsRefresh = false;
  /** Boundary-rejected groupBy pass (D4), replaced per rejected pass. */
  let groupByDiags: readonly GraphDiagnostic[] = [];
  /** ONE conflict diagnostic while groups AND groupBy are both
   * configured — the ERROR wins: neither lane applies until one is removed. */
  let groupsConflictDiags: readonly GraphDiagnostic[] = [];
  /** Latest rejected group op verdict (read-only membership under groupBy,
   * unknown ids, violating specs); cleared by the next applied groups write. */
  let groupsOpDiags: readonly GraphDiagnostic[] = [];
  /** Aggregated accessor-error from the last groupBy derivation pass. */
  let groupsDeriveDiags: readonly GraphDiagnostic[] = [];

  // --- persistent pins and the
  // parallel-edge grouping toggle. ---
  /** Flips to controlled on the FIRST host update carrying `pinnedNodeIds`
   * (null included), permanently; op writes never flip it. */
  let pinnedControlled = false;
  /** True while pinNodes/unpinNodes route their candidate through
   * applyHostUpdateInner — distinguishes op writes from host writes (and
   * gates recording to uncontrolled OP writes only). */
  let pinsInternalWrite = false;
  /** parallel-edge grouping toggle (host lane, stage-3-adjacent
   * rewrite — see composeStage3Rewrite / groups.ts ordering contract). */
  let parallelEdgeGrouping = false;
  /** One-shot latch for the documented INOPERATIVE-toggle diagnostic: when
   * the accepted edge list has zero same-pair multiplicity (edge ids
   * synthesized from (type,source,target)-style dedupe already collapse
   * parallels at ingestion), the toggle warns once and changes nothing. */
  let parallelInoperativeWarned = false;

  // --- stage-4 clusters. Clusters PRESERVE the scene: this
  // lane never touches `groupRewrite`, the reconciler, or any structural
  // commit — only `config.cluster` (capability-gated) and the overlay
  // anchors. ---
  /** Host CONFIG lane (survives dataset swaps, re-derives per scene). */
  let clusterSpec: ClusterSpec<N> | null = null;
  /** Stage-4 membership over the CURRENT physical scene; null = no spec. */
  let clusterDerivation: ClusterDerivation | null = null;
  /** 2*clusterCount force centers: explicit spec entries over deterministic
   * generation from ordered keys + layout seed. */
  let clusterForceCenters: Float32Array | null = null;
  /** 2*clusterCount label anchors — force centers while the sim is HOT, the
   * settled centroids after a readback (or at commit under a fixed
   * layout). Overlay ticks READ this; they never scan members. */
  let clusterAnchors: Float32Array | null = null;
  /** Whether `clusterAnchors` currently holds settled centroids. */
  let clusterCentroidsSettled = false;
  /** A cluster payload is owed to the engine (membership, centers, or a
   * clear). Consumed by the NEXT commit through `commitToEngine`, so an
   * index-addressed `pointClusters` mapping can never lag the roster it
   * describes (the I2 discipline, shared with `pointImageIndex`). */
  let clusterConfigPending = false;
  /** the cluster-force degradation is emitted at most ONCE per mount
   * session, whether the spec was live at mount (policy degradation) or
   * activated later (the frozen mount policy cannot see that). */
  let clusterDegradationEmitted = false;
  /** Aggregated accessor-error from the last stage-4 derivation pass. */
  let clusterDiags: readonly GraphDiagnostic[] = [];

  // --- crossfilter state. The typed-column engine
  // is built over the ACCEPTED model's nodes (base + published overlays,
  // NEVER the scoped subset): base slot s ↔ accepted.nodes[s], so brushes
  // survive scope changes and out-of-scope rows simply have no scene slot. ---
  let crossfilterSpecs: readonly DimensionSpec<N>[] | null = null;
  let crossfilterEngine: TypedColumnCrossfilter<N> | null = null;
  /** Base row s ↔ accepted.nodes[s].id at (re)build/append time. */
  let crossfilterRowIds: string[] = [];
  /** The EXACT row objects the engine's columns were extracted from. D1/I1:
   * a later publication is a proven pure append iff every prior row is the
   * SAME object (immutable-row contract) — id equality proves nothing about
   * attrs. */
  let crossfilterRowsRef: readonly GraphNode<N>[] = [];
  /** BASE slots currently failing at least one brush (selection-hidden). */
  const crossfilterHiddenBase = new Set<number>();
  /** Stable session facade delegating to the CURRENT engine. */
  let crossfilterSessionFacade: CrossfilterSession | null = null;

  // --- history kernel. Records UNCONTROLLED mutations only;
  // depth changes fold into the NEXT store publication (never a second
  // set). Cleared on datasetKey change. ---
  const historyOption = opts.history ?? true;
  const historyKernel = new HistoryKernel({
    enabled: historyOption !== false,
    debug: DEV,
    ...(typeof historyOption === 'object' && historyOption.limit !== undefined
      ? { limit: historyOption.limit }
      : {}),
  });
  let pendingHistoryDepths: HistoryDepths | null = null;
  historyKernel.subscribe((depths) => {
    pendingHistoryDepths = depths;
  });

  // --- timeline playback state ---
  let timelineTimer: ReturnType<typeof setTimeout> | null = null;
  let timelinePlayingKey: string | null = null;
  /** Rotates per play session: scopes the history coalesce key so one play
   * session = ONE entry, closed at pause. */
  let timelineSessionSeq = 0;

  // --- styling & config state (current desired values) ---
  let nodeColor: Accessor<GraphNode<N>, string> | Scale<string, N> | undefined;
  let nodeSize: Accessor<GraphNode<N>, number> | Scale<number, N> | undefined;
  let linkColor: Accessor<AcceptedEdge<E>, string> | undefined;
  let linkWidth: Accessor<AcceptedEdge<E>, number> | undefined;
  let layout: LayoutKind = 'force';
  let simulation: SimulationConfig | undefined;
  /** resolved theme tokens — always defined (dark base by default). */
  let theme: GraphTheme = resolveTheme(undefined);
  /** desired arrowheads (capability-gated; inert when unsupported). */
  let edgeArrows = false;
  /** link visibility toggle (config-only; default true). */
  let showLinks = true;
  /** emphasis-ring toggle (default true — the ring has followed hover
   * since v0.1; this names and gates it). Enforced ONLY in applyEmphasis. */
  let emphasisRingOn = true;
  /** sticky keyboard-emphasis target: replayed after structural commits
   * and recovery so a navigator-set ring survives a streaming batch (the D10
   * lesson). Pointer hover SUPERSEDES it (precedent: emphasis belongs
   * to the latest action); a departed id prunes and never resurrects. */
  let emphasizedNodeId: NodeId | null = null;
  /** Image ref accessor. Refs are retained even under a
   * 'placeholder' capability policy. */
  let nodeImage: ((node: GraphNode<N>) => string | null) | undefined;
  let labelsConfig: LabelConfig<N> | undefined;

  // --- scales and metrics state ---
  /** metric store over the FULL accepted model (dataset topology): the
   * degree family is computed from accepted-base adjacency, NEVER the scoped
   * scene, so isolating/masking can never change a node's degree (frozen
   * visual meaning). */
  const metricStore = new MetricStore<N>();
  /** per-instance domain freezer keyed by canonical scale key. */
  const domainStore = new DomainStore();
  /** Mirrors the public model revision (bumped exactly where revisions.model
   * advances) — the MetricStore/DomainStore freeze coordinate, available
   * DURING projection before the store publish lands. */
  let acceptedModelSeq = 0;
  /** ensureMetricModel sync coordinate (datasetKey + source + model seq). */
  let metricModelKey: string | null = null;
  /** metric-name → admission generation: bumps when a column (re)joins
   * so frozen domains recompute exactly when the metric's values changed
   * without a model-revision change (the missing-column-arrives case). */
  const metricColumnGen = new Map<string, number>();
  /** domain scope generations: 'hard-scope' recomputes when the hard
   * scope changes; 'visible' additionally recomputes on mask changes. */
  let hardScopeGen = 0;
  let visibleGen = 0;
  /** metric-column admission diagnostics (replaced per admission pass). */
  let metricDiags: readonly GraphDiagnostic[] = [];

  // --- accessor-churn detector state (dev inline-lambda warning) ---
  interface ChurnState {
    fp: string | null;
    streak: number;
    emitted: boolean;
  }
  const churnStates: Record<'nodeColor' | 'nodeSize' | 'linkColor' | 'linkWidth', ChurnState> = {
    nodeColor: { fp: null, streak: 0, emitted: false },
    nodeSize: { fp: null, streak: 0, emitted: false },
    linkColor: { fp: null, streak: 0, emitted: false },
    linkWidth: { fp: null, streak: 0, emitted: false },
  };
  /** Accumulated 'accessor-churn' diagnostics (one per streak). */
  let churnDiags: readonly GraphDiagnostic[] = [];

  // --- image-atlas state ---
  let imagePipeline: ImageAtlasPipeline | null = null;
  let imageGeneration = 0;
  /** Slot → bitmap the engine has received — the recovery replay
   * re-sends this full atlas state. */
  const atlasDeliveredBitmaps = new Map<number, ImageBitmap>();
  /** Last per-point atlas index (aligned to the last requestRefs roster). */
  let lastPointImageIndex: Float32Array | null = null;
  /** Cadence-batched 'image-resolve-failed' diagnostics (accumulated). */
  let imageDiags: readonly GraphDiagnostic[] = [];
  /** degradation diagnostics — replaced per mount session at ready. */
  let policyDiags: readonly GraphDiagnostic[] = [];
  let accessibilityConfig: AccessibilityConfig<N> | undefined;
  /** Binding-detected media preference; accessibility.reducedMotion overrides. */
  let bindingReducedMotion: boolean | undefined;

  // --- overlay label lane state (M0: NEVER per-frame GPU readback — the
  // lane projects the reconciler's CPU cache; sim-hot refreshes are capped) ---
  type LabelListener = (list: readonly LabelPlacement[]) => void;
  const candidateSubs = new Set<LabelListener>();
  const positionSubs = new Set<LabelListener>();
  /** Current winners. The array AND its objects are reused: position ticks
   * mutate x/y in place (imperative transforms; no re-render churn). */
  let currentPlacements: LabelPlacement[] = [];
  /** Latest per-event readback aligned to the current scene (null → the
   * reconciled scene.positions, which already merged the live cache). */
  let labelPositionCache: Float32Array | null = null;
  /** Shared hit-test cadence: ONE counter, advanced once per engine
   * onFrame tick, read by every sampling route (native hover events and the
   * CPU fallback edge samplers throttle against the SAME clock — never a
   * second timer). The degradation ladder's defer-link-picking step arms/disarms sampling
   * against this counter. */
  let frameCadence = 0;
  /** One-shot dev assertion state (see armQuiescenceAssertion). */
  let quiescenceAsserted = false;
  let quiescenceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Frame-clock anchor of the last sim-hot cache readback. */
  let lastHotRefreshMs: number | null = null;
  let rerankTimer: ReturnType<typeof setTimeout> | null = null;
  let lastOverloadCount = 0;
  const projectScratch: [number, number] = [0, 0];

  // --- diagnostics, composed per source so a re-projection replaces only its
  // own channel's entries ---
  let dataDiags: readonly GraphDiagnostic[] = [];
  /** columnar lane: the ONE rejection diagnostic for the last
   * data-carrying update (cleared on any successful data acceptance). */
  let columnarDiags: readonly GraphDiagnostic[] = [];
  // --- worker lane: columnar acceptance off-thread. ------------------------
  /** D7 read-once execution mode; 'main' short-circuits everything. */
  const executionMode: 'auto' | 'main' | 'worker' = opts.execution ?? 'main';
  let workerLane: WorkerLane | null = null;
  let workerDiags: readonly GraphDiagnostic[] = [];
  let workerUnavailableReported = false;
  /** Monotonic supersession token: only the LATEST in-flight columnar
   * acceptance may land (I1 discipline — epochs, never references). */
  let pendingDeriveToken = 0;

  /** Boot-or-degrade decision, made synchronously at the update boundary.
   * Unavailable ⇒ ONE diagnostic (info under 'auto' — the documented
   * fallback; error under 'worker' — the caller demanded threads) and the
   * main lane owns every subsequent columnar ingest. */
  function workerEligible(): boolean {
    if (executionMode === 'main') return false;
    if (workerLane === null) {
      workerLane = new WorkerLane({
        ...(opts.workerFactory !== undefined ? { factory: opts.workerFactory } : {}),
        onUnavailable: (reason) => {
          if (workerUnavailableReported) return;
          workerUnavailableReported = true;
          workerDiags = [
            {
              code: 'worker-unavailable',
              severity: executionMode === 'worker' ? 'error' : 'info',
              count: 1,
              sampleIds: [],
              message: `worker lane unavailable (${reason}) — columnar acceptance runs on the main lane`,
            },
          ];
        },
      });
    }
    return workerLane.ensureBooted();
  }

  /** Async worker admission: derive off-thread, land through the
   * acceptance queue, superseded work drops silently. */
  function scheduleWorkerAcceptance(
    columnar: ColumnarGraphSnapshot<N, E>,
    // Metrics are a DATA-COUPLED one-shot payload (they join
    // against the model the SAME update establishes) — they defer WITH the
    // data and admit at the re-entry, against the fresh model.
    deferredMetrics: readonly MetricColumn[] | undefined,
  ): void {
    const lane = workerLane!;
    pendingDeriveToken += 1;
    const token = pendingDeriveToken;
    // COPIES cross the wire (borrowed ownership: caller buffers stay
    // usable; under 'transfer' the zero-copy pass-through is a registered
    // optimization — correctness first).
    const payload: DeriveColumnarRequest = {
      nodeIdTable: encodeStringTable(columnar.nodes.ids.dictionary),
      nodeIdCodes: columnar.nodes.ids.codes.slice(),
      nodeCount: columnar.nodes.length,
      edgeIdTable: encodeStringTable(columnar.edges.ids.dictionary),
      edgeIdCodes: columnar.edges.ids.codes.slice(),
      edgeSource: columnar.edges.source.slice(),
      edgeTarget: columnar.edges.target.slice(),
      edgeCount: columnar.edges.length,
    };
    const transfers = collectTransfers([
      payload.nodeIdTable.offsets,
      payload.nodeIdTable.bytes,
      payload.nodeIdCodes,
      payload.edgeIdTable.offsets,
      payload.edgeIdTable.bytes,
      payload.edgeIdCodes,
      payload.edgeSource,
      payload.edgeTarget,
    ]);
    void lane
      .request(token, 'scene', 'derive-columnar', payload, transfers, 'guaranteed', 'derive')
      .then((reply) => {
        if (destroyed || token !== pendingDeriveToken) return; // superseded
        if (reply.op !== 'result') {
          workerDiags = [
            {
              code: 'worker-unavailable',
              severity: 'error',
              count: 1,
              sampleIds: [],
              message: `worker derive failed (${String((reply.payload as { message?: string }).message)}) — snapshot dropped`,
            },
          ];
          publish({ diagnostics: composeDiagnostics() });
          return;
        }
        const acceptance = reply.payload as DeriveColumnarResult;
        acceptanceQueue.admit(() => {
          if (destroyed || token !== pendingDeriveToken) return;
          // The worker judged COPIES — a caller who mutated
          // the borrowed snapshot mid-flight would have its verdicts applied
          // to DIFFERENT data (undefined identities, invalid topology).
          // Source coordinates are immutable; enforce the
          // detectable class here: structural re-validation + verdict/row
          // length agreement. Value-only mutation stays the documented
          // caller violation (production never deep-hashes million-row
          // inputs to rescue a violated contract).
          const mutated =
            acceptance.keepNodes.length !== columnar.nodes.length ||
            acceptance.keepEdges.length !== columnar.edges.length ||
            validateColumnarStructure(columnar).length > 0;
          if (mutated) {
            columnarDiags = [
              {
                code: 'invalid-columnar-snapshot',
                severity: 'error',
                count: 1,
                sampleIds: [],
                message:
                  'columnar snapshot mutated while worker acceptance was pending — rejected ' +
                  'whole (source coordinates are immutable; publish a new sourceRevision)',
              },
            ];
            publish({ diagnostics: composeDiagnostics() });
            return;
          }
          const preAccepted = buildAcceptedFromColumnar<N, E>(columnar, acceptance);
          applyHostUpdateInner(
            {
              data: {
                datasetKey: columnar.datasetKey,
                sourceRevision: columnar.sourceRevision,
                nodes: [],
                edges: [],
              } as GraphSnapshot<N, E>,
              ...(deferredMetrics !== undefined ? { metrics: deferredMetrics } : {}),
            },
            preAccepted,
          );
          // D4: detach only after validation AND admission — this IS the
          // admission point for the worker path.
          if (columnar.bufferOwnership === 'transfer') detachColumnarBuffers(columnar);
        });
      })
      .catch((err: unknown) => {
        if (destroyed || token !== pendingDeriveToken) return;
        const message = err instanceof Error ? err.message : String(err);
        // 'worker-unavailable': boot raced away between ensureBooted and
        // request. 'worker-failed': the thread DIED mid-flight (module-load
        // failure, uncaught error). Both fall back to the main lane through
        // the SAME queue — the data must not vanish. Superseded/aborted
        // requests drop silently (their work is unwanted by definition).
        if (message !== 'worker-unavailable' && message !== 'worker-failed') return;
        acceptanceQueue.admit(() => {
          if (destroyed || token !== pendingDeriveToken) return;
          // The fallback shares the success path's mutation
          // window — re-validate before materializing (a structurally
          // mutated snapshot must reject whole here too, never throw
          // asynchronously or land reinterpreted rows).
          if (validateColumnarStructure(columnar).length > 0) {
            columnarDiags = [
              {
                code: 'invalid-columnar-snapshot',
                severity: 'error',
                count: 1,
                sampleIds: [],
                message:
                  'columnar snapshot mutated while worker acceptance was pending — rejected ' +
                  'whole (source coordinates are immutable; publish a new sourceRevision)',
              },
            ];
            publish({ diagnostics: composeDiagnostics() });
            return;
          }
          applyHostUpdateInner({
            data: materializeColumnarSnapshot(columnar),
            ...(deferredMetrics !== undefined ? { metrics: deferredMetrics } : {}),
          });
          if (columnar.bufferOwnership === 'transfer') detachColumnarBuffers(columnar);
        });
      });
  }
  let nodeColorDiags: readonly GraphDiagnostic[] = [];
  let nodeSizeDiags: readonly GraphDiagnostic[] = [];
  let linkColorDiags: readonly GraphDiagnostic[] = [];
  let linkWidthDiags: readonly GraphDiagnostic[] = [];
  let engineDiags: readonly GraphDiagnostic[] = [];
  /** at most ONE 'label-overload' entry, replaced per overload transition. */
  let labelDiags: readonly GraphDiagnostic[] = [];
  /** merge-state diagnostics (shadowing/edge dedupe), recomputed per merge. */
  let ingestMergeDiags: readonly GraphDiagnostic[] = [];
  /** commit-time diagnostics (staging tallies + dangling), keyed by
   * overlayId so removeOverlay drops exactly its entries. */
  let ingestCommitDiags: ReadonlyArray<{ overlayId: string; diag: GraphDiagnostic }> = [];

  // --- selection ownership: flips to controlled on the first host
  // update that carries `selection`, permanently. Controlled mode covers the
  // NODE namespace only — edge/group namespaces stay instance-internal. ---
  let selectionControlled = false;

  // --- lifecycle ---
  let destroyed = false;
  let session: MountSession | null = null;
  let mountPromise: Promise<void> | null = null;

  // --- typed events ---
  type AnyListener = (payload: unknown, control: GraphListenerControl) => void;
  const listeners = new Map<GraphEventName, Set<AnyListener>>();

  function on<K extends GraphEventName>(
    name: K,
    cb: (payload: GraphEventMap<N, E>[K], control: GraphListenerControl) => void,
  ): () => void {
    if (destroyed) return () => {};
    let set = listeners.get(name);
    if (set === undefined) {
      set = new Set();
      listeners.set(name, set);
    }
    const fn = cb as AnyListener;
    set.add(fn);
    return () => {
      listeners.get(name)?.delete(fn);
    };
  }

  /**
   * dispatcher: the listener chain runs SYNCHRONOUSLY in registration
   * order. A throwing listener is isolated — one 'listener-error' diagnostic,
   * the chain continues. Returns whether any listener called preventDefault,
   * which cancels ONLY the caller's built-in follow-up, never other listeners.
   */
  function emit<K extends GraphEventName>(name: K, payload: GraphEventMap<N, E>[K]): boolean {
    const set = listeners.get(name);
    if (set === undefined || set.size === 0) return false;
    let prevented = false;
    const control: GraphListenerControl = {
      preventDefault() {
        prevented = true;
      },
    };
    let faults = 0;
    // Snapshot so a listener unsubscribing mid-emit cannot skip a peer.
    for (const cb of Array.from(set)) {
      try {
        cb(payload, control);
      } catch (err) {
        faults++;
        engineDiags = [
          ...engineDiags,
          {
            code: 'listener-error',
            severity: 'error',
            count: 1,
            sampleIds: [],
            message: `'${name}' listener threw: ${err instanceof Error ? err.message : String(err)}`,
          },
        ];
      }
    }
    if (faults > 0) publish({ diagnostics: composeDiagnostics() });
    return prevented;
  }

  /** The ONLY store write path: composes the next state immutably.
   * a pending history-depth change (the kernel notifies synchronously
   * during the mutation that caused it) folds into this same publication so
   * a recorded mutation never costs a second store set. */
  function publish(patch: Partial<GraphStoreState>): void {
    if (pendingHistoryDepths !== null && patch.history === undefined) {
      patch.history = pendingHistoryDepths;
    }
    pendingHistoryDepths = null;
    store.setState((prev) => ({ ...prev, ...patch }));
    // the ladder's count triggers are edge-evaluated wherever
    // the visible counts move — publish is the single store funnel.
    if (patch.visible !== undefined || patch.nodeCount !== undefined) {
      evaluateLadderCounts();
    }
  }

  /** Evaluate count triggers and emit + apply any step transitions. */
  function evaluateLadderCounts(): void {
    if (destroyed) return;
    const vis = store.getState().visible;
    const events = degradeController.evaluateCounts({ nodes: vis.nodes, edges: vis.edges });
    for (const event of events) applyDegradeEvent(event);
  }

  /** One place applies a ladder transition: emits 'degrade' and runs the
   * step's side effects. */
  function applyDegradeEvent(event: DegradeEvent): void {
    if (event.step === 'cap-dom-labels') {
      if (event.engaged && !capLabelsNudged) {
        capLabelsNudged = true;
        console.warn(
          'orbit: cap-dom-labels engaged — DOM labels are hard-capped at the label ' +
            'budget above limits.domLabelNodes visible nodes. A GPU label lane ' +
            "(labelStrategy 'sdf') is the planned scale path.",
        );
      }
      // The cap changes the k clamp — re-rank so it takes effect now.
      scheduleViewportRerank();
    }
    if (event.step === 'batch-histograms' && !event.engaged) {
      flushCrossfilterNotify(); // release: deliver anything still pending
    }
    if (event.step === 'defer-images' && !event.engaged && imageRefsDeferred) {
      pushImageRefs(); // release: queued refs admit now
    }
    if (event.step === 'disable-transitions') {
      // transitions become atomic jumps — config-only engine write.
      const eng = engineIfReady();
      if (eng !== null) {
        const revisions = { ...store.getState().revisions };
        revisions.render += 1;
        commitToEngine(eng, {
          revision: revisions.render,
          config: { transitionDurationMs: event.engaged ? 0 : null },
        });
        revisions.appliedRender = eng.appliedRevision();
        store.setState((prev) => ({ ...prev, revisions }));
      }
    }
    emit('degrade', event);
  }

  /** instance-level fault routing: one diagnostic append, and — only when
   * the fatality matrix says so — one 'error' status publish + 'error' emit. */
  function emitInstanceError(detail: GraphError, phase: ErrorPhase, cause?: Error): void {
    engineDiags = [
      ...engineDiags,
      {
        code: detail.code === 'context-lost' ? 'context-lost' : 'engine-error',
        severity: 'error',
        count: 1,
        sampleIds: [],
        message: graphErrorToError(detail, cause).message,
      },
    ];
    if (isFatalGraphError(detail, phase)) {
      publish({ status: 'error', diagnostics: composeDiagnostics() });
      emit('error', { error: graphErrorToError(detail, cause), detail });
    } else {
      publish({ diagnostics: composeDiagnostics() });
    }
  }

  /** calls on a destroyed instance throw an operation error, not a bare Error. */
  function throwDestroyedOperation(fn: string): never {
    throw new OrbitOperationError(
      { code: 'aborted', cause: 'destroyed' },
      `${fn}() called on a destroyed GraphInstance`,
    );
  }

  /** operation-scoped failure: ONE 'operation-rejected' warning diagnostic
   * plus a typed rejection; never touches status and never emits 'error'.
   * Ingest session calls route their rejections through here. */
  function rejectOperation<T>(detail: GraphOperationError, message?: string): Promise<T> {
    const err = new OrbitOperationError(detail, message);
    engineDiags = [
      ...engineDiags,
      {
        code: 'operation-rejected',
        severity: 'warning',
        count: 1,
        sampleIds: [],
        message: err.message,
      },
    ];
    publish({ diagnostics: composeDiagnostics() });
    return Promise.reject(err);
  }

  function engineIfReady(): GraphEngine | null {
    return session !== null && store.getState().status === 'ready' ? session.engine : null;
  }

  // -------------------------------------------------------------------------
  // hard scope — the render model seam. The reconciler, styling
  // projections, label lane, and selectAll population read the SCOPED view;
  // id-keyed state (selection/pins/hidden), getNode, and the ingestion
  // merge stay on the full accepted model, which is what lets out-of-scope
  // ids survive scope changes.
  // -------------------------------------------------------------------------

  /** The model the scene renders: the scoped subset when a hard scope is
   * active, else the full accepted model. Stage-2 output — the
   * PRE-rewrite physical model; stage-5 meta rules and id-keyed state read
   * this, while slot-aligned consumers read {@link sceneModel}. */
  function renderModel(): AcceptedGraph<N, E> | null {
    return scopedAccepted ?? accepted;
  }

  /** The model the SCENE is aligned to: the stage-3 post-rewrite set when a
   * collapsed group intersects the render model, else the render model.
   * Scene slot i ↔ sceneModel.nodes[i] under the rebuild policy. */
  function sceneModel(): AcceptedGraph<N, E> | null {
    return groupRewrite !== null ? groupRewrite.graph : renderModel();
  }

  /** First synthetic point slot (== scene count when no rewrite). */
  function physicalPointCount(): number {
    return groupRewrite !== null ? groupRewrite.physicalNodeCount : (scene?.count ?? 0);
  }

  /**
   * Re-resolve store.groups from the retained lanes against the CURRENT
   * accepted model. Precedence:
   * - groups + groupBy both configured → the config ERROR wins:
   * NEITHER applies (empty resolution) until the host removes one;
   * - groupBy alone → derive one group per distinct key, pruning the
   * per-key collapsed residue to keys the derivation still produces;
   * - manual groups alone → tolerant re-resolution (departed members drop
   * without a config error — model drift is data).
   * Returns whether the published resolution changed.
   */
  /**
   * semantic zoom: hysteresis band tracking
   * driven by viewport events.
   *
   * Crossing BELOW `collapseBelow` collapses every derived group; crossing
   * ABOVE `expandAbove` expands only the groups intersecting the viewport
   * (off-screen groups stay collapsed — cheap re-entry as the camera moves).
   * A zoom strictly between the thresholds RETAINS the current band, so any
   * oscillation inside the corridor flips nothing. A flip is expressed as
   * collapsed-residue edits plus one inner update: a pure structural diff
   * over already-derived membership, with NO new engine entry points (the
   * in-view test reuses `spaceToScreen`).
   */
  function trackSemanticZoomBand(zoom: number): void {
    const sz = groupBySpec?.semanticZoom;
    if (sz === undefined || groupsSpec !== null) return; // no spec / conflict
    if (!Number.isFinite(zoom)) return;
    const next: 'collapsed' | 'expanded' | null =
      zoom < sz.collapseBelow ? 'collapsed' : zoom > sz.expandAbove ? 'expanded' : null;
    if (next === null || next === semanticZoomBand) return; // corridor / no flip
    semanticZoomBand = next;

    const derived = store.getState().groups;
    if (derived.length === 0) return;
    let changed = false;
    if (next === 'collapsed') {
      for (const group of derived) {
        const key = groupByKeyById.get(group.id);
        if (key !== undefined && !groupByCollapsedKeys.has(key)) {
          groupByCollapsedKeys.add(key);
          changed = true;
        }
      }
    } else {
      for (const group of derived) {
        const key = groupByKeyById.get(group.id);
        if (key === undefined || !groupByCollapsedKeys.has(key)) continue;
        if (!groupInView(group)) continue; // off-screen → stays collapsed
        groupByCollapsedKeys.delete(key);
        changed = true;
      }
    }
    if (!changed) return;
    pendingGroupsRefresh = true;
    applyHostUpdateInner({});
  }

  /**
   * The "in-view only" expansion test: does the group intersect the
   * viewport AS DRAWN? A collapsed group occupies exactly one scene slot
   * its SUPER-NODE (its members have no slots at all while collapsed) — so
   * that is the slot tested; an expanded group tests its member slots.
   *
   * Uses the CPU position cache plus the engine's existing `spaceToScreen`
   * (no new engine surface). When the projection is unavailable
   * (headless, unsized container, pre-mount) every group counts as in view,
   * so semantic zoom degrades to plain band expansion.
   */
  function groupInView(group: ResolvedGroup): boolean {
    const eng = engineIfReady();
    const rect = containerScreenRect();
    if (eng?.spaceToScreen === undefined || rect === null || scene === null) return true;
    const positions = labelPositionCache ?? scene.positions;
    const slots: number[] = [];
    const sceneGroups = scene.groups;
    if (sceneGroups !== undefined) {
      // superNodes is aligned to the point suffix (physicalPointCount…count).
      const at = sceneGroups.superNodes.findIndex((g) => g.id === group.id);
      if (at >= 0) slots.push(sceneGroups.physicalPointCount + at);
    }
    if (slots.length === 0) {
      for (const id of group.memberIds) {
        const idx = scene.indexById.get(id);
        if (idx !== undefined) slots.push(idx);
      }
    }
    // FAIL OPEN: a group whose drawn slot has no KNOWN position yet (a
    // freshly seeded super-node carries NaN until the engine places it)
    // cannot be proven off-screen, and staying collapsed would strand it
    // there across every later flip. Unknown ⇒ in view.
    let decidable = false;
    for (const idx of slots) {
      if (2 * idx + 1 >= positions.length) continue;
      const x = positions[2 * idx]!;
      const y = positions[2 * idx + 1]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      const screen = eng.spaceToScreen([x, y]);
      if (screen === null || screen === undefined) continue;
      decidable = true;
      if (
        screen[0] >= rect[0] &&
        screen[0] <= rect[2] &&
        screen[1] >= rect[1] &&
        screen[1] <= rect[3]
      ) {
        return true;
      }
    }
    return !decidable;
  }

  function refreshGroupsResolution(): boolean {
    let next: readonly ResolvedGroup[];
    // Derivation diagnostics only exist while a derivation lane is live.
    if (groupBySpec === null || groupsSpec !== null) {
      if (groupsDeriveDiags.length > 0) groupsDeriveDiags = [];
    }
    if (groupsSpec !== null && groupBySpec !== null) {
      next = EMPTY_GROUPS;
    } else if (groupBySpec !== null) {
      if (accepted === null) {
        // No model yet: nothing derives, and the residue is NOT pruned
        // only a derivation that omits a key drops that key.
        groupByKeyById = new Map();
        if (groupsDeriveDiags.length > 0) groupsDeriveDiags = [];
        next = EMPTY_GROUPS;
      } else {
        const derivation = deriveGroupsByKey(accepted.nodes, groupBySpec.by, (key) =>
          groupByCollapsedKeys.has(key),
        );
        groupByKeyById = derivation.keyById;
        if (groupByCollapsedKeys.size > 0) {
          // residue: keys that vanished from the model drop;
          // surviving keys keep their collapsed state across re-derivation.
          const alive = new Set(derivation.keyById.values());
          for (const key of groupByCollapsedKeys) {
            if (!alive.has(key)) groupByCollapsedKeys.delete(key);
          }
        }
        groupsDeriveDiags = derivation.diagnostic === null ? [] : [derivation.diagnostic];
        next = derivation.groups;
      }
    } else if (groupsSpec !== null && accepted !== null) {
      next = resolveManualGroups(groupsSpec, accepted.nodeIndex);
    } else {
      next = EMPTY_GROUPS;
    }
    if (sameResolvedGroups(resolvedGroups, next)) return false;
    resolvedGroups = next;
    return true;
  }

  /** Whether the NEXT rewrite would synthesize anything — collapse gating so
   * uncollapsed-only group changes never touch the scene. */
  function anyCollapsedIntersecting(): boolean {
    const model = renderModel();
    if (model === null) return false;
    for (const group of resolvedGroups) {
      if (!group.collapsed) continue;
      for (const id of group.memberIds) {
        if (model.nodeIndex.has(id)) return true;
      }
    }
    return false;
  }

  /**
   * THE reconcile entry point: stage-3 rewrite over the
   * stage-2 model, then the EXISTING structural diff over the
   * post-rewrite set — collapse/expand is a diff, never a reload. Sets
   * `scene` (with the synthetic-suffix descriptor attached when rewritten).
   */
  /** Group composition: apply the group rewrite FIRST, then the
   * parallel-edge pass over its POST-rewrite
   * physical edge list when the toggle is on — group meta-edges already
   * bundle per directed pair by construction (ordering contract documented
   * at collapseParallelEdges in groups.ts). */
  function composeStage3Rewrite(model: AcceptedGraph<N, E>): GroupRewrite<N, E> | null {
    const base = rewriteGroups(model, buildRepForest(resolvedGroups, foldRecords()));
    return parallelEdgeGrouping ? collapseParallelEdges(model, base) : base;
  }

  /** The live folds as forest input (anchor order = insertion order). */
  function foldRecords(): readonly FoldRecord[] {
    if (folds.size === 0) return EMPTY_FOLD_RECORDS;
    const out: FoldRecord[] = [];
    for (const [anchorId, memberIds] of folds) out.push({ anchorId, memberIds });
    return out;
  }

  /** inoperative-case detection: does the ACCEPTED edge list carry
   * ANY same-DIRECTED-endpoint-pair multiplicity? (Collision-safe pairing
   * ids may contain any character.) */
  function acceptedHasParallelEdges(): boolean {
    if (accepted === null) return false;
    const seen = new Set<string>();
    for (const e of accepted.edges) {
      const key = JSON.stringify([e.source, e.target]);
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  }

  function reconcileScene(model: AcceptedGraph<N, E>): ReconcileResult {
    // a scene rebuild invalidates path link indices — drop the state
    // silently; the rebuild's own commit recomposes the link lane.
    dropPathState();
    groupRewrite = composeStage3Rewrite(model);
    const result = reconciler.reconcile(groupRewrite !== null ? groupRewrite.graph : model);
    scene =
      groupRewrite === null
        ? result.scene
        : { ...result.scene, groups: sceneGroupsOf(groupRewrite) };
    // stage 4 follows stage 3 on EVERY scene rebuild (this is the single
    // reconcile entry point): the physical prefix it partitions just moved,
    // and `pointClusters` is index-addressed, so membership re-derives here
    // and ONLY here plus an explicit spec change. Stage-5 soft-mask changes
    // never reach this function, which is exactly why they never re-derive.
    // The physical rows are passed explicitly: `model` is authoritative here
    // even when the caller has not yet published it as `accepted`.
    if (clusterSpec !== null) {
      deriveClusterState(groupRewrite !== null ? groupRewrite.physicalNodes : model.nodes);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // stage-4 clusters. Stage 4 runs AFTER the stage-3
  // rewrite and consumes its PHYSICAL prefix, so a collapsed group's members
  // simply have no scene slot to cluster. It preserves the scene exactly:
  // node/edge counts, the synthetic suffix, and every structural buffer are
  // untouched — the only outputs are `config.cluster`
  // (capability-gated) and the cluster-label anchors.
  //
  // DIRTY DISCIPLINE: derivation runs ONLY on stage-4
  // dirty flags — a `by` accessor identity change or an upstream TOPOLOGY
  // change (data / scope / stage-3 rewrite). A stage-5 soft-mask change
  // (filter, brush, legend toggle, hidden ids) never re-derives; `clusterProbe`
  // pins that.
  // -------------------------------------------------------------------------

  /** The physical rows stage 4 partitions: the stage-3 physical prefix when a
   * rewrite is live, else the scene model's nodes. */
  function physicalSceneNodes(): readonly GraphNode<N>[] {
    if (groupRewrite !== null) return groupRewrite.physicalNodes;
    return sceneModel()?.nodes ?? [];
  }

  /** Recompute stage-4 membership + force centers from the CURRENT scene and
   * mark the engine payload owed. Anchors reset to the force centers: a fresh
   * derivation has no settled centroid until the next readback (or an
   * immediate fixed-layout computation at commit). */
  function deriveClusterState(physical: readonly GraphNode<N>[] = physicalSceneNodes()): void {
    clusterConfigPending = true;
    if (clusterSpec === null) {
      clusterDerivation = null;
      clusterForceCenters = null;
      clusterAnchors = null;
      clusterCentroidsSettled = false;
      if (clusterDiags.length > 0) clusterDiags = [];
      return;
    }
    const derivation = deriveClusters(physical, clusterSpec.by, scene?.count ?? physical.length);
    clusterDerivation = derivation;
    clusterForceCenters = resolveClusterCenters(derivation.keys, clusterSpec.centers);
    clusterAnchors = new Float32Array(clusterForceCenters);
    clusterCentroidsSettled = false;
    clusterDiags = derivation.diagnostic === null ? [] : [derivation.diagnostic];
  }

  /**
   * Anchor refresh: recompute centroids from a slot-aligned
   * position buffer. The ONLY member-scanning path, and it runs exclusively
   * on the settle event (over the single permitted per-event readback) or at
   * commit under a FIXED layout — never per frame.
   */
  function refreshClusterCentroids(positions: Float32Array | null): void {
    const derivation = clusterDerivation;
    const centers = clusterForceCenters;
    if (derivation === null || centers === null || positions === null) return;
    if (derivation.keys.length === 0) return;
    clusterAnchors = clusterCentroids(
      derivation.slotOrdinals,
      positions,
      derivation.keys.length,
      centers,
    );
    clusterCentroidsSettled = true;
  }

  /** The engine payload for the current derivation; null CLEARS the
   * engine's cluster force (D2 explicit reset). */
  function clusterConfigPayload(): NonNullable<EngineConfigUpdate['cluster']> | null {
    const derivation = clusterDerivation;
    if (clusterSpec === null || derivation === null) return null;
    const payload: NonNullable<EngineConfigUpdate['cluster']> = {
      pointClusters: derivation.slotOrdinals,
    };
    if (clusterForceCenters !== null && derivation.keys.length > 0) {
      payload.centers = clusterForceCenters;
    }
    if (clusterSpec.strength !== undefined) payload.strength = clusterSpec.strength;
    return payload;
  }

  /**
   * loud degradation: an engine that does not declare `clusterForce`
   * gets exactly ONE 'engine:capability-degraded' diagnostic per session, with
   * the same text the mount-time policy would have produced. Membership,
   * labels, and centroids keep working and the layout proceeds
   * `normalizeCommitForCapabilities` strips `config.cluster` at the sink.
   */
  function noteClusterDegradation(): boolean {
    if (clusterDegradationEmitted || clusterSpec === null) return false;
    const eng = engineIfReady();
    if (eng === null || eng.capabilities.clusterForce === true) return false;
    clusterDegradationEmitted = true;
    policyDiags = [
      ...policyDiags,
      {
        code: 'engine:capability-degraded',
        severity: 'warning',
        count: 1,
        sampleIds: [],
        message: `clusters degraded: ${CLUSTER_FORCE_DEGRADATION_REASON}`,
      },
    ];
    return true;
  }

  /** public cluster surface. */
  function getClusters(): readonly ResolvedCluster[] {
    const derivation = clusterDerivation;
    const centers = clusterForceCenters;
    if (derivation === null || centers === null) return EMPTY_CLUSTERS;
    const anchors = clusterAnchors;
    return derivation.keys.map((key, i) => ({
      key,
      memberIds: derivation.membersByKey.get(key) ?? [],
      forceCenter: [centers[2 * i]!, centers[2 * i + 1]!] as const,
      centroid:
        clusterCentroidsSettled && anchors !== null
          ? ([anchors[2 * i]!, anchors[2 * i + 1]!] as const)
          : null,
    }));
  }

  /** Lazy CSR adjacency of the EFFECTIVE accepted model, walked
   * by scope resolution AND the default local expansion service, including
   * currently out-of-scope nodes). Callers guarantee an accepted model. */
  function acceptedAdjacencyOf(): Adjacency {
    if (acceptedAdjacency === null) acceptedAdjacency = buildAcceptedAdjacency(accepted!);
    return acceptedAdjacency;
  }

  function sameSubgraphSpec(a: SubgraphSpec | null, b: SubgraphSpec | null): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    return a.hops === b.hops && a.reflow === b.reflow && sameIds(a.seedIds, b.seedIds);
  }

  /**
   * stage-2 isolate-as-unit: a seed id naming a COLLAPSED
   * resolved group — and NOT an accepted node id (on a cross-namespace id
   * collision the NODE wins; group selections expand explicitly through
   * isolateSelection) — resolves to that group's memberIds BEFORE scope
   * resolution, so isolating a collapsed group hard-scopes to the members,
   * the rewrite renders the super-node as a unit, and meta-edges never
   * dangle outside scope. The STORED SubgraphSpec keeps the group id; each
   * re-resolution expands against the then-current groups.
   */
  function expandScopeSeedGroups(spec: SubgraphSpec): SubgraphSpec {
    if (resolvedGroups.length === 0 || accepted === null) return spec;
    let collapsedById: Map<string, ResolvedGroup> | null = null;
    const groupFor = (id: string): ResolvedGroup | undefined => {
      if (collapsedById === null) {
        collapsedById = new Map();
        for (const group of resolvedGroups) {
          if (group.collapsed) collapsedById.set(group.id, group);
        }
      }
      return collapsedById.get(id);
    };
    let any = false;
    for (const id of spec.seedIds) {
      if (!accepted.nodeIndex.has(id) && groupFor(id) !== undefined) {
        any = true;
        break;
      }
    }
    if (!any) return spec;
    const seedIds: NodeId[] = [];
    for (const id of spec.seedIds) {
      const group = accepted.nodeIndex.has(id) ? undefined : groupFor(id);
      if (group === undefined) seedIds.push(id);
      else seedIds.push(...group.memberIds);
    }
    return { ...spec, seedIds };
  }

  /**
   * Resolve the current hard scope against the current accepted model:
   * stage-2 group-seed expansion, then `resolveScope` over the SubgraphSpec
   * (seeds validated, `hops` BFS over the cached accepted adjacency) plus
   * the expansion-revealed extras, edges cascaded through the shared
   * primitive. Null = full scope.
   */
  function computeScopedAccepted(): AcceptedGraph<N, E> | null {
    if (accepted === null) return null;
    if (scopeSpec === null) {
      // No hard scope, but a collapse trimmed the effective set
      // render the accepted model MINUS the exclusions. The data persists;
      // only the displayed set shrinks.
      let anyRemoved = false;
      for (const id of effectiveRemovedIds) {
        if (accepted.nodeIndex.has(id)) {
          anyRemoved = true;
          break;
        }
      }
      if (!anyRemoved) return null;
      const base = accepted;
      const nodes = base.nodes.filter((n) => !effectiveRemovedIds.has(n.id));
      const edges = cascadeEdges(
        base.edges,
        (id) => base.nodeIndex.has(id) && !effectiveRemovedIds.has(id),
      );
      const nodeIndex = new Map<NodeId, number>();
      for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i]!.id, i);
      return {
        datasetKey: base.datasetKey,
        sourceRevision: base.sourceRevision,
        nodes,
        edges,
        nodeIndex,
        diagnostics: base.diagnostics,
      };
    }
    const spec = expandScopeSeedGroups(scopeSpec);
    const hops = spec.hops ?? 0;
    const resolved = resolveScope<N, E>(
      accepted,
      spec,
      Number.isFinite(hops) && hops > 0 ? acceptedAdjacencyOf() : null,
    );
    let ids: ReadonlySet<NodeId> = resolved.nodeIds;
    let nodes = resolved.nodes;
    let edges = resolved.edges;
    let anyExtra = false;
    for (const id of scopeExtraIds) {
      if (accepted.nodeIndex.has(id) && !ids.has(id)) {
        anyExtra = true;
        break;
      }
    }
    if (anyExtra) {
      const union = new Set(ids);
      for (const id of scopeExtraIds) {
        if (accepted.nodeIndex.has(id)) union.add(id);
      }
      nodes = accepted.nodes.filter((n) => union.has(n.id));
      edges = cascadeEdges(accepted.edges, (id) => union.has(id));
      ids = union;
    }
    // Collapse exclusions subtract from the resolved effective
    // set (accretion removal covers most scoped cases; this also covers a
    // removed id the SubgraphSpec resolution itself would re-include).
    let anyExcluded = false;
    for (const id of effectiveRemovedIds) {
      if (ids.has(id)) {
        anyExcluded = true;
        break;
      }
    }
    if (anyExcluded) {
      const kept = new Set<NodeId>();
      for (const id of ids) {
        if (!effectiveRemovedIds.has(id)) kept.add(id);
      }
      nodes = nodes.filter((n) => kept.has(n.id));
      edges = cascadeEdges(accepted.edges, (id) => kept.has(id));
      ids = kept;
    }
    const nodeIndex = new Map<NodeId, number>();
    for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i]!.id, i);
    return {
      datasetKey: accepted.datasetKey,
      sourceRevision: accepted.sourceRevision,
      nodes,
      edges,
      nodeIndex,
      diagnostics: accepted.diagnostics,
    };
  }

  /** Current revision-dimension values (service issue/admission gate). */
  function revisionSnapshot(): RevisionSnapshot {
    const r = store.getState().revisions;
    return { source: r.source, model: r.model, scope: r.scope };
  }

  /** service diagnostics: 'service-aborted' (info) for discards,
   * 'service-error' (error) for failures. Never a status change, never the
   * 'error' event — the caller's promise carries the rejection. */
  function pushServiceDiagnostic(
    code: 'service-aborted' | 'service-error',
    severity: 'info' | 'error',
    message: string,
  ): void {
    engineDiags = [...engineDiags, { code, severity, count: 1, sampleIds: [], message }];
    publish({ diagnostics: composeDiagnostics() });
  }

  function getNode(id: NodeId): GraphNode<N> | undefined {
    if (accepted === null) return undefined;
    const idx = accepted.nodeIndex.get(id);
    return idx === undefined ? undefined : accepted.nodes[idx];
  }

  function getEdge(id: EdgeId): AcceptedEdge<E> | undefined {
    if (accepted === null) return undefined;
    const idx = edgeIndexById.get(id);
    return idx === undefined ? undefined : accepted.edges[idx];
  }

  function nodeAtIndex(index: number): GraphNode<N> | undefined {
    if (scene === null) return undefined;
    const id = scene.idByIndex[index];
    return id === undefined ? undefined : getNode(id);
  }

  function edgeAtLinkIndex(linkIndex: number): AcceptedEdge<E> | undefined {
    if (scene === null || accepted === null) return undefined;
    const id = scene.edgeIdByIndex[linkIndex];
    if (id === undefined) return undefined;
    const k = edgeIndexById.get(id);
    return k === undefined ? undefined : accepted.edges[k];
  }

  /**
   * Shared edge-hover core for both routes: write `hover.edgeId` and
   * emit 'edgeHover'. Native host events pass `transitionsOnly=false` (the
   * engine owns transition detection); the throttled fallback sampler passes
   * true so repeated same-edge samples do not re-emit.
   */
  function applyEdgeHover(edge: AcceptedEdge<E> | null, transitionsOnly: boolean): void {
    if (
      edge !== null &&
      degradeController.isEngaged('defer-link-picking') &&
      store.getState().simulationRunning
    ) {
      return; // defer-link-picking: picking arms at rest only
    }
    const edgeId = edge === null ? null : edge.id;
    const hover = store.getState().hover;
    const changed = hover.edgeId !== edgeId;
    if (changed) publish({ hover: { nodeId: hover.nodeId, edgeId } });
    if (changed || !transitionsOnly) emit('edgeHover', { edge });
  }

  // -------------------------------------------------------------------------
  // edge-picking facade surface. The route was fixed at ready;
  // these are live only on the fallback route and only while armed (settled).
  // -------------------------------------------------------------------------

  function fallbackFacade(): EdgePickingFacade | null {
    if (engineIfReady() === null || session === null) return null;
    const facade = session.edgePicking;
    return facade !== null && facade.route === 'fallback' ? facade : null;
  }

  function pickEdgeAt(screen: readonly [number, number]): AcceptedEdge<E> | null {
    const facade = fallbackFacade();
    if (facade === null) return null;
    const linkIndex = facade.pickLinkAt(screen);
    return linkIndex === null ? null : (edgeAtLinkIndex(linkIndex) ?? null);
  }

  /** Call on the shared pointer throttle cadence (the binding owns the
   * timer). Emits the SAME typed 'edgeHover' payloads as the native route. */
  function sampleEdgeHover(screen: readonly [number, number]): AcceptedEdge<E> | null {
    const facade = fallbackFacade();
    if (facade === null) return null;
    const linkIndex = facade.pickLinkAt(screen);
    const edge = linkIndex === null ? null : (edgeAtLinkIndex(linkIndex) ?? null);
    applyEdgeHover(edge, true);
    return edge;
  }

  function sampleEdgeClick(screen: readonly [number, number]): AcceptedEdge<E> | null {
    const facade = fallbackFacade();
    if (facade === null) return null;
    const linkIndex = facade.pickLinkAt(screen);
    if (linkIndex === null) return null;
    // route parity: a meta-edge hit fires the SAME typed
    // event as the native route; the AcceptedEdge return stays null
    // synthetics never cast to E.
    const ref = scene === null ? null : sceneLinkRefAt(scene, linkIndex);
    if (ref !== null && ref.kind === 'meta-edge') {
      emit('metaEdgeClick', { metaEdge: ref.metaEdge });
      return null;
    }
    const edge = edgeAtLinkIndex(linkIndex) ?? null;
    if (edge !== null) emit('edgeClick', { edge }); // no built-in follow-up
    return edge;
  }

  function composeDiagnostics(): readonly GraphDiagnostic[] {
    return [
      ...dataDiags,
      ...columnarDiags,
      ...workerDiags,
      ...ingestMergeDiags,
      ...ingestCommitDiags.map((e) => e.diag),
      ...nodeColorDiags,
      ...nodeSizeDiags,
      ...linkColorDiags,
      ...linkWidthDiags,
      ...metricDiags,
      ...churnDiags,
      ...imageDiags,
      ...policyDiags,
      ...filterDiags,
      ...groupsDiags,
      ...groupByDiags,
      ...groupsConflictDiags,
      ...groupsOpDiags,
      ...groupsDeriveDiags,
      ...clusterDiags,
      ...engineDiags,
      ...labelDiags,
    ];
  }

  // -------------------------------------------------------------------------
  // soft mask. One SoftMask over the CURRENT scene;
  // slot indices are scene indices (scene slot i ↔ renderModel.nodes[i]
  // under the rebuild policy). Mask changes are the FAST PATH: one
  // buffers-only commit (alpha channels only), NO structure, NO restart
  // zero relayout is required. Mask-affecting publishes advance
  // scope+render revisions, never model.
  // -------------------------------------------------------------------------

  function maskNodeVisibleAt(index: number): boolean {
    return softMask === null || softMask.isNodeVisible(index);
  }

  function maskEdgeVisibleAt(linkIndex: number): boolean {
    return softMask === null || softMask.isEdgeVisible(linkIndex);
  }

  /** Lazily create the mask + named sources sized to the scene; grow on
   * structure change (capacity never shrinks — out-of-scene slots always
   * read zero failures after a membership rebuild). */
  function ensureMask(): SoftMask | null {
    if (scene === null) return null;
    if (softMask === null) {
      softMask = new SoftMask(scene.count, scene.linkCount);
      maskFilterSource = softMask.acquire('filter');
      maskHiddenSource = softMask.acquire('hidden');
      maskBrushSource = softMask.acquire('brushes');
      maskGroupSource = softMask.acquire('groups');
    } else {
      softMask.grow(scene.count, scene.linkCount);
    }
    return softMask;
  }

  /** datasetKey swap: per-dataset mask state does not carry over (the filter
   * SPEC survives — it is host config — and re-evaluates on the new scene). */
  function resetMaskState(): void {
    softMask = null;
    maskFilterSource = null;
    maskHiddenSource = null;
    maskBrushSource = null;
    maskGroupSource = null;
    filterHiddenNodeSlots = new Set();
    basePointColors = null;
    baseLinkColors = null;
    basePointColorsSynthesized = false;
    baseLinkColorsSynthesized = false;
    nodeAlphaComposer.reset();
    edgeAlphaComposer.reset();
    sceneIncidence = null;
  }

  // --- O(Δ) brush fast-path state -----------------------------------
  /** Reused per-call crossings from the brush delta (feeds the cascade). */
  const brushCrossings: MaskCrossings = { becameFailing: [], becameClear: [] };
  /** Reused base→scene translation buffers. */
  const brushSceneAdd: number[] = [];
  const brushSceneRemove: number[] = [];
  /** Allocation-free alpha composition for the brush fast path. RULE: every
   * mask drain the composers do NOT observe must reset them — the seed key
   * (base ref/count/dimAlpha) cannot see membership-only changes. */
  const nodeAlphaComposer = new IncrementalAlphaComposer();
  const edgeAlphaComposer = new IncrementalAlphaComposer();

  /** above this changed-slot share, a full upload beats patch
   * bookkeeping (and the transfer saving is gone anyway). */
  const PATCH_FULL_UPLOAD_RATIO = 0.5;

  /** Coalesce changed slots into contiguous ranged writes over `buf`
   * (stride = elements per slot). Slots may repeat across drain lists
   * sort + dedupe, then merge adjacent runs into zero-copy subarray views
   * (valid during commit only, same lifetime as full buffers). */
  function buildAlphaPatches(
    buf: Float32Array,
    slotLists: readonly (readonly number[])[],
    stride: number,
  ): BufferPatch[] {
    const slots: number[] = [];
    for (const list of slotLists) for (const slot of list) slots.push(slot);
    slots.sort((a, b) => a - b);
    const patches: BufferPatch[] = [];
    let runStart = -1;
    let runEnd = -1; // exclusive
    for (const slot of slots) {
      if (slot < runEnd) continue; // duplicate inside the current run
      if (slot === runEnd) {
        runEnd = slot + 1; // extends the run
        continue;
      }
      if (runStart >= 0) {
        patches.push({
          start: runStart * stride,
          data: buf.subarray(runStart * stride, runEnd * stride),
        });
      }
      runStart = slot;
      runEnd = slot + 1;
    }
    if (runStart >= 0) {
      patches.push({
        start: runStart * stride,
        data: buf.subarray(runStart * stride, runEnd * stride),
      });
    }
    return patches;
  }
  /** pressure sampler — fed ONLY from the onFrame fan-out. */
  const pressureSampler = new PressureSampler();
  /** ladder controller (D7 read-once limits; sanitize warnings
   * fold into one config diagnostic at first compose). */
  const resolvedLimits = resolveScaleLimits(opts.limits);
  const degradeController = new DegradeController(resolvedLimits.limits, () => nowMs());
  /** One-shot dev nudge when cap-dom-labels first engages. */
  let capLabelsNudged = false;
  /** defer-images: a roster feed was skipped while engaged (re-fed on release). */
  let imageRefsDeferred = false;
  /** last-commit phase decomposition (see the GraphPerfSnapshot JSDoc). */
  let lastCommitMs: GraphPerfSnapshot['lastCommitMs'];
  /** Wall-clock throttle anchor for the 'perfSample' emission (>= 1s). */
  let lastPerfSampleAt = -Infinity;
  /** op counters for the gate (internal getter; live object). */
  const perfCounters = {
    brushSlotsTranslated: 0,
    fullBrushRefreshes: 0,
    fullCascades: 0,
    fullNodeRecomposes: 0,
    fullEdgeRecomposes: 0,
  };

  /**
   * Re-evaluate the compiled filter prop over the CURRENT render model and
   * replace the 'filter' source memberships (hide or dim lanes per
   * spec.mode). Predicate throws FAIL OPEN and aggregate into at most ONE
   * 'filter-error' warning diagnostic per pass.
   */
  function evaluateFilterMembership(): void {
    if (softMask === null || maskFilterSource === null) return;
    const model = sceneModel();
    if (activeFilterSpec === null || model === null) {
      maskFilterSource.clear();
      filterHiddenNodeSlots = new Set();
      filterDiags = [];
      return;
    }
    const cn = compiledNodeSelector;
    const ce = compiledEdgeSelector;
    // One aggregate per PASS: reset the live tallies before re-evaluating.
    if (cn !== null) {
      cn.errors.count = 0;
      cn.errors.samples.length = 0;
    }
    if (ce !== null) {
      ce.errors.count = 0;
      ce.errors.samples.length = 0;
    }
    // stage 5: caller predicates run over PHYSICAL rows only — the
    // synthetic suffix is judged by the 'groups' source's meta-entity rule,
    // never cast to N/E.
    const physNodes = groupRewrite !== null ? groupRewrite.physicalNodeCount : model.nodes.length;
    const physEdges = groupRewrite !== null ? groupRewrite.physicalEdgeCount : model.edges.length;
    const nodeFail: number[] = [];
    if (cn !== null) {
      const nodes = model.nodes;
      for (let i = 0; i < physNodes; i++) {
        if (!cn.test(nodes[i]!)) nodeFail.push(i);
      }
    }
    const edgeFail: number[] = [];
    if (ce !== null) {
      const edges = model.edges;
      for (let k = 0; k < physEdges; k++) {
        if (!ce.test(edges[k]!)) edgeFail.push(k);
      }
    }
    if (activeFilterMode === 'hide') {
      maskFilterSource.setNodeFailures(nodeFail, null);
      maskFilterSource.setEdgeFailures(edgeFail, null);
      filterHiddenNodeSlots = new Set(nodeFail);
    } else {
      maskFilterSource.setNodeFailures(null, nodeFail);
      maskFilterSource.setEdgeFailures(null, edgeFail);
      filterHiddenNodeSlots = new Set(); // dim never excludes
    }
    const errorCount = (cn?.errors.count ?? 0) + (ce?.errors.count ?? 0);
    if (errorCount > 0) {
      const samples: string[] = [];
      for (const s of cn?.errors.samples ?? []) {
        if (samples.length < DIAGNOSTIC_SAMPLE_CAP) samples.push(s);
      }
      for (const s of ce?.errors.samples ?? []) {
        if (samples.length < DIAGNOSTIC_SAMPLE_CAP) samples.push(s);
      }
      filterDiags = [
        {
          code: 'filter-error',
          severity: 'warning',
          count: errorCount,
          sampleIds: samples,
          message: `filter predicate threw for ${errorCount} item(s); failing open — throwing predicates never hide data`,
        },
      ];
    } else {
      filterDiags = [];
    }
  }

  /** Replace the 'hidden' source membership from a hiddenNodeIds set. */
  function refreshHiddenMembership(hidden: ReadonlySet<NodeId>): void {
    if (softMask === null || maskHiddenSource === null || scene === null) return;
    const slots: number[] = [];
    for (const id of hidden) {
      const idx = scene.indexById.get(id);
      if (idx !== undefined) slots.push(idx);
    }
    maskHiddenSource.setNodeFailures(slots, null);
  }

  /** Replace the 'brushes' source membership from the crossfilter's hidden
   * BASE slots, mapped to scene slots. Out-of-scope rows have no scene slot
   * under a hard scope and are skipped. */
  function refreshBrushMembership(): void {
    if (softMask === null || maskBrushSource === null || scene === null) return;
    perfCounters.fullBrushRefreshes += 1;
    const slots: number[] = [];
    for (const s of crossfilterHiddenBase) {
      const id = crossfilterRowIds[s];
      if (id === undefined) continue;
      const idx = scene.indexById.get(id);
      if (idx !== undefined) slots.push(idx);
    }
    maskBrushSource.setNodeFailures(slots, null);
  }

  /**
   * O(Δ) brush membership: translate ONLY the changed base slots to
   * scene slots and delta the 'brushes' source (per-call crossings land in
   * `brushCrossings` for the cascade). Base slot == scene slot IDENTITY
   * holds when the scene is the unscoped accepted model over the exact rows
   * the crossfilter indexed (reconciler guarantee: scene order == model
   * order, indexById == nodeIndex); otherwise per-slot Map.get with
   * out-of-scope rows skipped. Returns false when the fast
   * conditions do not hold — groupRewrite needs the ANY-member pass
   * (inherently O(members)) so the whole step falls back to the naive path.
   */
  function refreshBrushMembershipDelta(delta: BrushDelta): boolean {
    if (softMask === null || maskBrushSource === null || scene === null) return false;
    if (groupRewrite !== null) return false;
    const identity =
      accepted !== null && sceneModel() === accepted && crossfilterRowsRef === accepted.nodes;
    const sceneRef = scene;
    const translate = (baseSlots: readonly number[], out: number[]): void => {
      out.length = 0;
      for (let i = 0; i < baseSlots.length; i++) {
        const s = baseSlots[i]!;
        perfCounters.brushSlotsTranslated += 1;
        if (identity) {
          if (s < sceneRef.count) out.push(s);
          continue;
        }
        const id = crossfilterRowIds[s];
        if (id === undefined) continue;
        const idx = sceneRef.indexById.get(id);
        if (idx !== undefined) out.push(idx);
      }
    };
    translate(delta.hidden, brushSceneAdd);
    translate(delta.shown, brushSceneRemove);
    maskBrushSource.updateNodeFailures(brushSceneAdd, brushSceneRemove, brushCrossings);
    return true;
  }

  /** node→edge cascade over the mask lane, after any node-lane change. */
  function cascadeNodeMask(): void {
    if (softMask !== null && scene !== null) {
      perfCounters.fullCascades += 1;
      softMask.applyNodeCascadeToEdges(scene.links);
    }
  }

  /** O(incident-edges) cascade over the slots `brushCrossings`
   * collected in this brush step. Lazily builds the scene incidence
   * (invalidated alongside the lazy CSR on every structural change). */
  function cascadeNodeMaskDelta(): void {
    if (softMask === null || scene === null) return;
    const failing = brushCrossings.becameFailing;
    const cleared = brushCrossings.becameClear;
    if (failing.length === 0 && cleared.length === 0) return;
    sceneIncidence ??= buildIncidence(scene.links, scene.count);
    const crossed = failing.length === 0 ? cleared : cleared.length === 0 ? failing : [...failing, ...cleared];
    softMask.applyNodeCascadeToEdgesDelta(scene.links, sceneIncidence, crossed);
  }

  /**
   * stage-5 meta-entity rule over the synthetic suffix: a super-node
   * passes iff ANY present member passes the composed node mask (filter ∧
   * hiddenNodeIds ∧ brushes, evaluated jointly per member over the PHYSICAL
   * model); a meta-edge passes iff ANY underlying edge passes (edge filter ∧
   * both physical endpoints pass) — collapsed groups stay discoverable under
   * filters. Caller predicates only ever see physical rows.
   * Call after any other source membership changes, before the cascade.
   */
  function refreshGroupMaskMembership(hidden: ReadonlySet<NodeId>): void {
    if (softMask === null || maskGroupSource === null) return;
    if (groupRewrite === null) {
      maskGroupSource.clear();
      return;
    }
    const rewrite = groupRewrite;
    const model = renderModel()!; // a rewrite implies a stage-2 model
    const cn = compiledNodeSelector;
    const ce = compiledEdgeSelector;
    const hideMode = activeFilterMode === 'hide';
    const baseIndex = accepted !== null ? accepted.nodeIndex : null;
    const brushHidden = (id: NodeId): boolean => {
      if (crossfilterHiddenBase.size === 0 || baseIndex === null) return false;
      const s = baseIndex.get(id);
      return s !== undefined && crossfilterHiddenBase.has(s);
    };
    const nodeOf = (id: NodeId): GraphNode<N> | null => {
      const i = model.nodeIndex.get(id);
      return i === undefined ? null : model.nodes[i]!;
    };
    // Member predicate runs happen OUTSIDE evaluateFilterMembership's tally
    // pass: fail-open still applies; only the aggregate error COUNT omits
    // collapsed members.
    const nodeHideFails = (id: NodeId): boolean => {
      if (hidden.has(id) || brushHidden(id)) return true;
      if (cn === null || !hideMode) return false;
      const node = nodeOf(id);
      return node !== null && !cn.test(node);
    };
    const nodeDimFails = (id: NodeId): boolean => {
      if (cn === null || hideMode) return false;
      const node = nodeOf(id);
      return node !== null && !cn.test(node);
    };

    const nodeHide: number[] = [];
    const nodeDim: number[] = [];
    for (let j = 0; j < rewrite.superNodes.length; j++) {
      const rec = rewrite.superNodes[j]!;
      let anyPass = false;
      let anyUndimmed = false;
      for (const id of rec.presentMemberIds) {
        if (nodeHideFails(id)) continue;
        anyPass = true;
        if (!nodeDimFails(id)) {
          anyUndimmed = true;
          break;
        }
      }
      const slot = rewrite.physicalNodeCount + j;
      if (!anyPass) nodeHide.push(slot);
      else if (!anyUndimmed) nodeDim.push(slot);
    }
    maskGroupSource.setNodeFailures(nodeHide, nodeDim);

    const edgeHide: number[] = [];
    const edgeDim: number[] = [];
    const edges = model.edges;
    for (let j = 0; j < rewrite.metaEdges.length; j++) {
      const rec = rewrite.metaEdges[j]!;
      let anyPass = false;
      let anyUndimmed = false;
      for (const k of rec.underlying) {
        const edge = edges[k]!;
        if (nodeHideFails(edge.source) || nodeHideFails(edge.target)) continue;
        if (hideMode && ce !== null && !ce.test(edge)) continue;
        anyPass = true;
        if (!(ce !== null && !hideMode && !ce.test(edge))) {
          anyUndimmed = true;
          break;
        }
      }
      const slot = rewrite.physicalEdgeCount + j;
      if (!anyPass) edgeHide.push(slot);
      else if (!anyUndimmed) edgeDim.push(slot);
    }
    maskGroupSource.setEdgeFailures(edgeHide, edgeDim);
  }

  /**
   * Structural change: slot indices shifted, so REBUILD every source
   * membership from its definition against the new scene, then consume the
   * drain (callers re-project full buffers with the mask composed).
   * Returns whether the filter-error diagnostic changed.
   */
  function rebuildMaskMemberships(hidden: ReadonlySet<NodeId>): boolean {
    if (scene === null) return false;
    if (
      softMask === null &&
      activeFilterSpec === null &&
      hidden.size === 0 &&
      crossfilterHiddenBase.size === 0
    ) {
      return false; // nothing masks and nothing ever did (synthetics visible)
    }
    ensureMask();
    const before = filterDiags;
    evaluateFilterMembership();
    refreshHiddenMembership(hidden);
    refreshBrushMembership();
    refreshGroupMaskMembership(hidden);
    cascadeNodeMask();
    softMask!.drainDirty(); // consume: full buffers re-project with composition
    // this drain bypassed the incremental composers — reset so the
    // next fast-path use reseeds from current mask state.
    nodeAlphaComposer.reset();
    edgeAlphaComposer.reset();
    return filterDiags !== before;
  }

  /** In-scene visible counts: capacity slots beyond the scene always
   * read zero failures post-rebuild, so subtracting the excess is exact. */
  /**
   * visible counts over RENDERED SCENE entities — the synthetic suffix
   * INCLUDED. A collapsed group draws one super-node, and that is one thing
   * the viewer sees, so it counts here (the store contract is literally
   * "scene entities with zero hide-failures").
   *
   * This deliberately differs from `getVisibleNodeIds()`, which returns the
   * PUBLIC physical ids only. The
   * two answer different questions — "how much is on screen" vs "which of
   * your nodes are on screen" — so a host pairing a count with that list
   * must use `getVisibleNodeIds().length`, not `visible.nodes`.
   */
  function computeVisibleCounts(): { nodes: number; edges: number } {
    if (scene === null) return { nodes: 0, edges: 0 };
    if (softMask === null) return { nodes: scene.count, edges: scene.linkCount };
    return {
      nodes: softMask.visibleNodeCount() - (softMask.nodeCapacity - scene.count),
      edges: softMask.visibleEdgeCount() - (softMask.edgeCapacity - scene.linkCount),
    };
  }

  function sameVisible(a: { nodes: number; edges: number }, b: { nodes: number; edges: number }): boolean {
    return a.nodes === b.nodes && a.edges === b.edges;
  }

  function themeColorFill(count: number, rgba: readonly [number, number, number, number]): Float32Array {
    const out = new Float32Array(4 * count);
    for (let i = 0; i < count; i++) {
      out[4 * i] = rgba[0];
      out[4 * i + 1] = rgba[1];
      out[4 * i + 2] = rgba[2];
      out[4 * i + 3] = rgba[3];
    }
    return out;
  }

  /** The unmasked base node-color RGBA buffer: the last projection, or a fill
   * synthesized from the ACTIVE theme's `nodeDefault` when no accessor is
   * configured (so mask alphas still reach the engine without repainting the
   * scene a foreign color — I5). Callers guarantee a scene. */
  function basePointColorBuffer(): Float32Array {
    const n = scene!.count;
    if (basePointColors === null || basePointColors.length !== 4 * n) {
      const fill = themeColorFill(n, parseColor(theme.nodeDefault) ?? DEFAULT_RGBA);
      // stage 6: the synthetic suffix renders through the aggregate
      // channel even in the no-accessor lane (group color / theme accent).
      if (groupRewrite !== null) applySuperNodeColors(fill, groupRewrite);
      basePointColors = fill;
      basePointColorsSynthesized = true;
    }
    return basePointColors;
  }

  /** Link twin of {@link basePointColorBuffer}: synthesized from the theme's
   * `edgeDefault` — including its alpha, so masking a themed edge lane keeps
   * the theme's translucency instead of snapping to opaque (I5). */
  function baseLinkColorBuffer(): Float32Array {
    const n = scene!.linkCount;
    if (baseLinkColors === null || baseLinkColors.length !== 4 * n) {
      baseLinkColors = themeColorFill(n, parseColor(theme.edgeDefault) ?? DEFAULT_RGBA);
      baseLinkColorsSynthesized = true;
    }
    return baseLinkColors;
  }

  /**
   * THE alpha-composition helper — used at EVERY point node colors are
   * (re)built (initial projection, host-update re-projection, recovery and
   * re-attach replays, and the mask fast path). Returns the base unchanged
   * when no mask exists; otherwise a masked COPY with alpha multiplied by
   * nodeAlpha(i) (hide→0, dim→theme.mutedAlpha) — the cached base
   * stays unmasked for later drains.
   */
  function composeNodeAlphaBuffer(base: Float32Array): Float32Array {
    if (softMask === null || scene === null) return base;
    perfCounters.fullNodeRecomposes += 1;
    const out = new Float32Array(base);
    const n = scene.count;
    const dimAlpha = theme.mutedAlpha;
    for (let i = 0; i < n; i++) {
      const a = softMask.nodeAlpha(i, dimAlpha);
      if (a !== 1) out[4 * i + 3] = base[4 * i + 3]! * a;
    }
    return out;
  }

  function composeEdgeAlphaBuffer(base: Float32Array): Float32Array {
    if ((softMask === null && pathDimEdges === null) || scene === null) return base;
    perfCounters.fullEdgeRecomposes += 1;
    const out = new Float32Array(base);
    const n = scene.linkCount;
    const dimAlpha = theme.mutedAlpha;
    for (let k = 0; k < n; k++) {
      const a = softMask === null ? 1 : softMask.edgeAlpha(k, dimAlpha);
      if (a !== 1) out[4 * k + 3] = base[4 * k + 3]! * a;
    }
    // path emphasis: while a path is active it OWNS the link
    // lane — every non-path visible link dims through the same mutedAlpha
    // rule, composed INSIDE the standard composer so any drain (mask fast
    // path, re-projection, replay) preserves the emphasis until clearPath.
    if (pathDimEdges !== null) {
      for (const k of pathDimEdges) {
        if (k < n) out[4 * k + 3] = out[4 * k + 3]! * dimAlpha;
      }
    }
    return out;
  }

  /**
   * fast-path node alpha: replay only the drain's changed slots over
   * the persistent composer pair — O(Δ), zero allocation. The pull-based
   * seed key (base ref, count, dimAlpha) reseeds after any projection,
   * theme, or structural change; drains the composer does NOT observe reset
   * it explicitly at their sites, so a stale buffer cannot survive.
   */
  function composeNodeAlphaIncremental(drain: MaskDrain): Float32Array {
    const base = basePointColorBuffer();
    if (softMask === null || scene === null) return base;
    const mask = softMask;
    const dimAlpha = theme.mutedAlpha;
    const alphaOf = (i: number): number => mask.nodeAlpha(i, dimAlpha);
    const seeded = nodeAlphaComposer.ensureSeeded(base, scene.count, dimAlpha, null, alphaOf);
    if (seeded) {
      nodeAlphaComposer.note(drain.nodes);
      nodeAlphaComposer.note(drain.nodesAlpha);
    }
    return nodeAlphaComposer.nextBuffer(base, alphaOf);
  }

  /** Edge twin. path emphasis owns the link lane while active — that
   * composition is a full-lane pass by construction, so the naive composer
   * runs and the incremental one resets (forcing a clean reseed when the
   * path clears). */
  function composeEdgeAlphaIncremental(drain: MaskDrain): Float32Array {
    const base = baseLinkColorBuffer();
    if (softMask === null || scene === null) return base;
    if (pathDimEdges !== null) {
      edgeAlphaComposer.reset();
      return composeEdgeAlphaBuffer(base);
    }
    const mask = softMask;
    const dimAlpha = theme.mutedAlpha;
    const alphaOf = (k: number): number => mask.edgeAlpha(k, dimAlpha);
    const seeded = edgeAlphaComposer.ensureSeeded(base, scene.linkCount, dimAlpha, null, alphaOf);
    if (seeded) {
      edgeAlphaComposer.note(drain.edges);
      edgeAlphaComposer.note(drain.edgesAlpha);
    }
    return edgeAlphaComposer.nextBuffer(base, alphaOf);
  }

  /**
   * mask FAST PATH (hide/show mutators, brushes, undo/redo of either):
   * source memberships (and the cascade) were already updated — drain the
   * mask and issue AT MOST ONE buffers-only commit rebuilding ONLY the
   * affected alpha channels, plus EXACTLY ONE store publication. Advances
   * scope+render (never model) when any slot flipped.
   */
  function publishMaskFastPath(extraPatch: Partial<GraphStoreState>, diagsChanged: boolean): void {
    const prev = store.getState();
    const patch: Partial<GraphStoreState> = { ...extraPatch };
    let labelRerank: RerankResult = { setChanged: false, diagsChanged: false };
    if (softMask !== null && scene !== null) {
      const drain = softMask.drainDirty();
      const nodesAffected = drain.nodes.length > 0 || drain.nodesAlpha.length > 0;
      const edgesAffected = drain.edges.length > 0 || drain.edgesAlpha.length > 0;
      if (nodesAffected || edgesAffected) {
        // the visible set changed — 'visible'-scoped domains recompute.
        visibleGen += 1;
        const revisions: Revisions = { ...prev.revisions };
        revisions.scope += 1;
        revisions.render += 1; // desired render advances even while detached
        const eng = engineIfReady();
        if (eng !== null) {
          // 'visible' domain opt-in: those scale channels re-project in
          // the SAME commit (an explicit comparison-changing opt-out of the
          // alpha-only fast path).
          const visDirty: DirtyChannels = {
            nodeColor: scaleUsesVisibleDomain(nodeColor),
            nodeSize: scaleUsesVisibleDomain(nodeSize),
            linkColor: false,
            linkWidth: false,
          };
          const buffers: NonNullable<EngineCommit['buffers']> =
            visDirty.nodeColor || visDirty.nodeSize
              ? { ...(projectChannelBuffers(visDirty) ?? {}) }
              : {};
          if (visDirty.nodeColor || visDirty.nodeSize) diagsChanged = true;
          const maskPhaseT0 = performance.now();
          // on a ranged-capable channel, an INCREMENTAL composer
          // step uploads only the drained slots (the engine holds the
          // previous ping-pong instance, whose content differs by exactly
          // this drain — the stale-slot replay reconciled the distance-2
          // gap first). A reseed means every slot may differ → full upload.
          const rangedChannels =
            session !== null && session.policy !== null ? session.policy.rangedChannels : null;
          const bufferPatches: NonNullable<EngineCommit['bufferPatches']> = {};
          if (nodesAffected && buffers.pointColor === undefined) {
            const reseedsBefore = nodeAlphaComposer.reseeds;
            const composed = composeNodeAlphaIncremental(drain);
            const changed = drain.nodes.length + drain.nodesAlpha.length;
            if (
              rangedChannels !== null &&
              rangedChannels.has('pointColor') &&
              nodeAlphaComposer.reseeds === reseedsBefore &&
              changed < scene.count * PATCH_FULL_UPLOAD_RATIO
            ) {
              bufferPatches.pointColor = buildAlphaPatches(
                composed,
                [drain.nodes, drain.nodesAlpha],
                4,
              );
            } else {
              buffers.pointColor = composed;
            }
          }
          if (edgesAffected && buffers.linkColor === undefined) {
            const reseedsBefore = edgeAlphaComposer.reseeds;
            const composed = composeEdgeAlphaIncremental(drain);
            const changed = drain.edges.length + drain.edgesAlpha.length;
            if (
              rangedChannels !== null &&
              rangedChannels.has('linkColor') &&
              edgeAlphaComposer.reseeds === reseedsBefore &&
              changed < (scene.links.length / 2) * PATCH_FULL_UPLOAD_RATIO
            ) {
              bufferPatches.linkColor = buildAlphaPatches(
                composed,
                [drain.edges, drain.edgesAlpha],
                4,
              );
            } else {
              buffers.linkColor = composed;
            }
          }
          const maskUploadT0 = performance.now();
          // NO structure, NO restart.
          const maskCommit: EngineCommit = { revision: revisions.render, buffers };
          if (Object.keys(bufferPatches).length > 0) maskCommit.bufferPatches = bufferPatches;
          commitToEngine(eng, maskCommit);
          lastCommitMs = {
            kind: 'mask',
            validate: 0,
            derive: 0,
            project: maskUploadT0 - maskPhaseT0,
            upload: performance.now() - maskUploadT0,
          };
          revisions.appliedRender = eng.appliedRevision();
        }
        patch.revisions = revisions;
        const vis = computeVisibleCounts();
        if (!sameVisible(vis, prev.visible)) patch.visible = vis;
        labelRerank = recomputeCandidates(); // mask-hidden nodes leave the label lane
      }
    }
    if (diagsChanged || labelRerank.diagsChanged) patch.diagnostics = composeDiagnostics();
    if (Object.keys(patch).length > 0 || pendingHistoryDepths !== null) publish(patch);
    if (labelRerank.setChanged) notifyLabelSubs(candidateSubs);
  }

  // -------------------------------------------------------------------------
  // Crossfilter wiring.
  // -------------------------------------------------------------------------

  function sameDimensionSpecs(
    next: readonly DimensionSpec<N>[],
    prev: readonly DimensionSpec<N>[] | null,
  ): boolean {
    if (prev === null || next.length !== prev.length) return false;
    for (let i = 0; i < next.length; i++) {
      if (!Object.is(next[i], prev[i])) return false;
    }
    return true;
  }

  function disposeCrossfilter(): void {
    crossfilterEngine?.dispose();
    crossfilterEngine = null;
    crossfilterRowIds = [];
    crossfilterRowsRef = [];
    crossfilterHiddenBase.clear();
  }

  /** Facade-level session listeners: they must SURVIVE engine rebuilds (a
   * dataset change swaps the engine object; a subscription bound to the old
   * engine would silently die and the UI would never see the new data). */
  const crossfilterFacadeListeners = new Set<() => void>();
  /** batch-histograms: while engaged, facade notifications
   * COALESCE — one flush per engine frame instead of one per brush write.
   * The flush rides the onFrame fan-out (never a second rAF); a brush
   * commit always wakes the gated clock, so a pending flush cannot starve. */
  let crossfilterNotifyPending = false;
  function notifyCrossfilterFacade(): void {
    // Defer ONLY when a live engine guarantees a flushing frame (every
    // brush/mask/model notify is accompanied by a commit, and commits wake
    // the gated clock). Detached or not-ready, frames cannot come — deliver
    // synchronously rather than starving subscribers.
    if (degradeController.isEngaged('batch-histograms') && engineIfReady() !== null) {
      crossfilterNotifyPending = true;
      return;
    }
    for (const cb of crossfilterFacadeListeners) cb();
  }
  function flushCrossfilterNotify(): void {
    if (!crossfilterNotifyPending) return;
    crossfilterNotifyPending = false;
    for (const cb of crossfilterFacadeListeners) cb();
  }

  /** (Re)build the engine over the accepted model's nodes (spec change /
   * first data). build clears brushes and the external mask.
   *
   * Validate before teardown: the CANDIDATE engine builds
   * FIRST — a throwing build (duplicate dimension keys, invalid bins, a
   * throwing `get`) leaves the previous engine, brushes, mask, and facade
   * fully functional, reports one 'operation-rejected' diagnostic, and
   * returns false. Only a successful candidate disposes the predecessor. */
  function buildCrossfilterEngine(): boolean {
    if (crossfilterSpecs === null || accepted === null) {
      disposeCrossfilter();
      return false;
    }
    const candidate = new TypedColumnCrossfilter<N>();
    try {
      candidate.build(accepted.nodes, crossfilterSpecs);
    } catch (err) {
      candidate.dispose();
      engineDiags = [
        ...engineDiags,
        {
          code: 'operation-rejected',
          severity: 'warning',
          count: 1,
          sampleIds: [],
          message: `crossfilter dimension specs rejected: ${err instanceof Error ? err.message : String(err)} (the previous crossfilter state is unchanged)`,
        },
      ];
      return false;
    }
    disposeCrossfilter();
    crossfilterEngine = candidate;
    crossfilterRowIds = accepted.nodes.map((n) => n.id);
    crossfilterRowsRef = accepted.nodes;
    // Forward same-engine notifications to the stable facade listeners, and
    // fire once for the rebuild itself (the data under every summary changed).
    crossfilterEngine.subscribe(notifyCrossfilterFacade);
    notifyCrossfilterFacade();
    return true;
  }

  /**
   * Model-change sync: datasetKey change →
   * rebuild (brushes cleared); a PROVEN pure append → `appendRows` with ONLY
   * the new nodes (no rebuild, brushes persist); anything unproven →
   * `replaceAll` re-extraction (brushes preserved by dimension key).
   *
   * D1/I1: the append proof is row-object identity over the previously
   * extracted prefix — under the immutable-row contract an identical
   * reference IS the same row, whereas an id-stable prefix says nothing
   * about attrs (an attribute-only update must re-extract columns, or
   * histograms/brushes keep filtering the OLD values while styling shows
   * the new ones). Same length + all references identical is a proven
   * no-change and skips work entirely.
   * Returns whether brush selection state may have shifted.
   */
  function syncCrossfilterModel(datasetChanged: boolean): boolean {
    if (crossfilterEngine === null || crossfilterSpecs === null || accepted === null) return false;
    if (datasetChanged) {
      const had = crossfilterHiddenBase.size > 0;
      if (!buildCrossfilterEngine()) {
        // D3 data-path failure (e.g. a throwing `get` over the NEW rows):
        // the old engine holds the DEAD dataset's rows — dispose rather
        // than keep stale summaries; the diagnostic already landed.
        disposeCrossfilter();
        crossfilterSpecs = null;
      }
      return had;
    }
    const nodes = accepted.nodes;
    const prevRows = crossfilterRowsRef;
    const oldN = prevRows.length;
    let provenAppend = nodes.length >= oldN;
    if (provenAppend) {
      for (let i = 0; i < oldN; i++) {
        if (nodes[i] !== prevRows[i]) {
          provenAppend = false;
          break;
        }
      }
    }
    // D3: extraction over NEW rows runs user `get` accessors — a throw must
    // never tear the atomic update. On failure the engine's columns may be
    // half-extracted: dispose, drop the specs, keep the diagnostic.
    try {
      if (provenAppend) {
        if (nodes.length === oldN) return false; // proven unchanged (same rows)
        const delta = crossfilterEngine.appendRows(nodes.slice(oldN));
        for (let i = oldN; i < nodes.length; i++) crossfilterRowIds.push(nodes[i]!.id);
        crossfilterRowsRef = nodes;
        for (const s of delta.hidden) crossfilterHiddenBase.add(s);
        return true;
      }
      const delta = crossfilterEngine.replaceAll(nodes);
      crossfilterRowIds = nodes.map((n) => n.id);
      crossfilterRowsRef = nodes;
      crossfilterHiddenBase.clear();
      for (const s of delta.hidden) crossfilterHiddenBase.add(s);
      return true;
    } catch (err) {
      const had = crossfilterHiddenBase.size > 0;
      disposeCrossfilter();
      crossfilterSpecs = null;
      engineDiags = [
        ...engineDiags,
        {
          code: 'operation-rejected',
          severity: 'warning',
          count: 1,
          sampleIds: [],
          message: `crossfilter re-extraction failed on the new model: ${err instanceof Error ? err.message : String(err)} (crossfilter disabled until specs are re-applied)`,
        },
      ];
      return had;
    }
  }

  /**
   * dual-layer external mask: BASE-index Uint8 pass array composed
   * from the filter prop's node mask (hide mode) + hiddenNodeIds, kept fresh
   * on every change of either. Affects summaries only, never selection.
   */
  function refreshCrossfilterExternalMask(hidden: ReadonlySet<NodeId>): void {
    if (crossfilterEngine === null) return;
    const n = crossfilterEngine.rowCount();
    const pass = new Uint8Array(n).fill(1);
    let any = false;
    for (let s = 0; s < n; s++) {
      const id = crossfilterRowIds[s];
      if (id === undefined) continue;
      if (hidden.has(id)) {
        pass[s] = 0;
        any = true;
        continue;
      }
      if (filterHiddenNodeSlots.size > 0 && scene !== null) {
        const idx = scene.indexById.get(id);
        if (idx !== undefined && filterHiddenNodeSlots.has(idx)) {
          pass[s] = 0;
          any = true;
        }
      }
    }
    crossfilterEngine.setExternalMask(any ? pass : null);
  }

  /**
   * Apply one brush through the engine and route the visibility delta into
   * the 'brushes' mask source. `coalesce` names the history entry window
   * (null = non-recording application, e.g. undo/redo). One publish.
   */
  function applyBrushInternal(
    key: string,
    brush: BrushState,
    coalesce: { key: string; windowMs: number } | null,
    extraPatch: Partial<GraphStoreState>,
  ): void {
    const eng = crossfilterEngine;
    if (eng === null) return;
    const before = eng.getBrush(key);
    const delta = eng.setBrush(key, brush);
    const after = eng.getBrush(key);
    if (before !== after && coalesce !== null) {
      historyKernel.beginCoalesced(coalesce.key, coalesce.windowMs, nowMs);
      historyKernel.record(`brush:${key}`, before, after);
      historyKernel.end();
    }
    const membershipChanged = delta.hidden.length > 0 || delta.shown.length > 0;
    for (const s of delta.hidden) crossfilterHiddenBase.add(s);
    for (const s of delta.shown) crossfilterHiddenBase.delete(s);
    if (membershipChanged && scene !== null) {
      ensureMask();
      // the O(Δ) path — delta membership + incident-edge cascade.
      // groupRewrite (ANY-member semantics) and missing preconditions fall
      // back to the naive full step; either way the SAME publish follows.
      if (refreshBrushMembershipDelta(delta)) {
        cascadeNodeMaskDelta();
      } else {
        refreshBrushMembership();
        refreshGroupMaskMembership(store.getState().hiddenNodeIds);
        cascadeNodeMask();
      }
    }
    publishMaskFastPath(extraPatch, false);
  }

  /** USER brush path (the session facade): a brush on the playing timeline
   * key pauses playback, folded into the same publication. */
  function userSetBrush(key: string, brush: BrushState): void {
    const extraPatch: Partial<GraphStoreState> = {};
    if (timelinePlayingKey === key) {
      stopTimelineTimer();
      timelinePlayingKey = null;
      extraPatch.timeline = { playingKey: null };
    }
    applyBrushInternal(
      key,
      brush,
      { key: `brush:${key}`, windowMs: BRUSH_HISTORY_COALESCE_MS },
      extraPatch,
    );
  }

  function requireCrossfilterEngine(): TypedColumnCrossfilter<N> {
    if (crossfilterEngine === null) {
      throw new Error('crossfilter session is not available; set the crossfilter prop first');
    }
    return crossfilterEngine;
  }

  function getCrossfilterSession(): CrossfilterSession | null {
    if (destroyed || crossfilterEngine === null) return null;
    crossfilterSessionFacade ??= {
      get selectionRevision(): number {
        return crossfilterEngine?.selectionRevision ?? 0;
      },
      setBrush: (key: string, brush: BrushState): Promise<void> => {
        try {
          if (destroyed) throw new Error('setBrush() on a destroyed GraphInstance');
          requireCrossfilterEngine();
          acceptanceQueue.admit(() => {
            userSetBrush(key, brush);
          });
          return Promise.resolve(); // resolves after the (synchronous) publish
        } catch (err) {
          return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
      getBrush: (key: string) => requireCrossfilterEngine().getBrush(key),
      summarize: (key: string) => requireCrossfilterEngine().summarize(key),
      subscribe: (cb: () => void) => {
        requireCrossfilterEngine(); // throw early, matching the other members
        crossfilterFacadeListeners.add(cb);
        return () => {
          crossfilterFacadeListeners.delete(cb);
        };
      },
    };
    return crossfilterSessionFacade;
  }

  // -------------------------------------------------------------------------
  // timeline playback. A setTimeout CHAIN (fake-timer
  // friendly); every brush goes through the crossfilter mask fast path.
  // -------------------------------------------------------------------------

  function stopTimelineTimer(): void {
    if (timelineTimer !== null) {
      clearTimeout(timelineTimer);
      timelineTimer = null;
    }
  }

  /** Stop playback WITHOUT publishing; returns the timeline patch to fold
   * into the caller's publication (null when nothing was playing). */
  function resetTimelineForPatch(): Partial<GraphStoreState> | null {
    stopTimelineTimer();
    if (timelinePlayingKey === null) return null;
    timelinePlayingKey = null;
    return { timeline: { playingKey: null } };
  }

  function playTimeline(key: string, playback?: Partial<TimelinePlayback>): void {
    if (destroyed) return;
    const eng = crossfilterEngine;
    if (eng === null) {
      throw new TypeError(
        'playTimeline: the crossfilter prop must configure dimensions first',
      );
    }
    const summary = eng.summarize(key); // throws on an unknown dimension
    if (summary.kind === 'categorical' || summary.domain === undefined) {
      throw new TypeError(
        `playTimeline: dimension "${key}" must be numeric/temporal with a non-empty domain`,
      );
    }
    const { min, max } = summary.domain;
    const span = max - min;
    const mode = playback?.mode ?? 'sliding';
    const windowSize = playback?.window ?? span / 10;
    const tickMs = playback?.tickMs ?? TIMELINE_TICK_MS_DEFAULT;
    const step = playback?.step ?? TIMELINE_STEP_DEFAULT;
    const loop = playback?.loop ?? false;
    // Reject invalid options at the boundary — BEFORE the current
    // timer is superseded or any state mutates. tickMs ≤ 0 would busy-loop
    // setTimeout; step ≤ 0 never terminates; a non-finite/negative window
    // yields a permanently-empty or throwing brush.
    if (!Number.isFinite(tickMs) || tickMs <= 0) {
      throw new TypeError(`playTimeline: tickMs must be a finite number > 0 (got ${String(tickMs)})`);
    }
    if (!Number.isFinite(step) || step <= 0) {
      throw new TypeError(`playTimeline: step must be a finite number > 0 (got ${String(step)})`);
    }
    if (!Number.isFinite(windowSize) || windowSize < 0) {
      throw new TypeError(
        `playTimeline: window must be a finite number >= 0 (got ${String(windowSize)})`,
      );
    }
    if (mode !== 'sliding' && mode !== 'cumulative') {
      throw new TypeError(`playTimeline: unsupported mode "${String(mode)}"`);
    }
    stopTimelineTimer(); // one playing dimension: a new play supersedes
    timelineSessionSeq += 1;
    const session = timelineSessionSeq;
    const coalesceKey = `timeline:${key}#${session}`;
    let progress = 0;
    timelinePlayingKey = key;

    const applyWindow = (extraPatch: Partial<GraphStoreState>): void => {
      const pos = min + span * progress;
      const brush: BrushState =
        mode === 'cumulative' ? { min, max: pos } : { min: pos, max: pos + windowSize };
      acceptanceQueue.admit(() => {
        applyBrushInternal(
          key,
          brush,
          { key: coalesceKey, windowMs: TIMELINE_COALESCE_WINDOW_MS },
          extraPatch,
        );
      });
    };

    const scheduleTick = (): void => {
      timelineTimer = setTimeout(() => {
        timelineTimer = null;
        if (destroyed || timelinePlayingKey !== key || timelineSessionSeq !== session) return;
        progress += step;
        if (progress > 1 + 1e-12) {
          if (loop) {
            progress = 0; // wrap
          } else {
            timelinePlayingKey = null; // stop at the end
            publish({ timeline: { playingKey: null } });
            return;
          }
        }
        try {
          applyWindow({});
        } catch {
          // Dimension vanished mid-play (spec rebuild): stop, never leak.
          timelinePlayingKey = null;
          publish({ timeline: { playingKey: null } });
          return;
        }
        scheduleTick();
      }, tickMs);
    };

    applyWindow({ timeline: { playingKey: key } });
    scheduleTick();
  }

  function pauseTimeline(): void {
    if (destroyed) return;
    stopTimelineTimer();
    if (timelinePlayingKey !== null) {
      timelinePlayingKey = null;
      publish({ timeline: { playingKey: null } });
    }
  }

  // -------------------------------------------------------------------------
  // history application. undo/redo apply the kernel's
  // returned value-diff commands to the slices via NON-RECORDING setters
  // one publish, at most one engine commit, engine pushes refreshed.
  // -------------------------------------------------------------------------

  function selectionPlain(s: SelectionState): SelectionState {
    return { nodeIds: [...s.nodeIds], edgeIds: [...s.edgeIds], groupIds: [...s.groupIds] };
  }

  function pinsPlain(
    pins: ReadonlyMap<NodeId, readonly [number, number]>,
  ): ReadonlyArray<readonly [NodeId, readonly [number, number]]> {
    return [...pins.entries()].map(([id, xy]) => [id, [xy[0], xy[1]] as const] as const);
  }

  function subgraphPlain(s: SubgraphSpec | null): SubgraphSpec | null {
    if (s === null) return null;
    return {
      seedIds: [...s.seedIds],
      ...(s.hops !== undefined ? { hops: s.hops } : {}),
      ...(s.reflow !== undefined ? { reflow: s.reflow } : {}),
    };
  }

  function applyHistoryCommands(commands: readonly HistoryCommand[]): void {
    const prev = store.getState();
    let selectionNext: SelectionState | null = null;
    let hiddenNext: Set<NodeId> | null = null;
    let pinsNext: Map<NodeId, readonly [number, number]> | null = null;
    let pinnedNodesNext: Set<NodeId> | null = null;
    let scopeTouched = false;
    /** An 'expansion' command restored the effective-set state
     * shares the scope command's structural republication path below. */
    let effectiveTouched = false;
    /** a 'folds' command changed stage-3 containment — needs the same
     * structural republication, but through the rewrite rather than the
     * scoped-model recompute (folds never change WHICH nodes are accepted). */
    let foldsTouched = false;
    let brushTouched = false;
    for (const cmd of commands) {
      if (cmd.slice === 'selection') {
        // Controlled selection is host-owned; such commands were never
        // recorded post-flip, and pre-flip leftovers are skipped.
        if (!selectionControlled) selectionNext = selectionPlain(cmd.after as SelectionState);
      } else if (cmd.slice === 'hidden') {
        hiddenNext = new Set(cmd.after as readonly NodeId[]);
      } else if (cmd.slice === 'pins') {
        pinsNext = new Map(
          (cmd.after as ReadonlyArray<readonly [NodeId, readonly [number, number]]>).map(
            ([id, xy]) => [id, [xy[0], xy[1]] as const] as const,
          ),
        );
      } else if (cmd.slice === 'pinnedNodes') {
        // Persistent pins — recorded by uncontrolled op writes
        // only; post-latch leftovers are skipped (the selection precedent).
        if (!pinnedControlled) pinnedNodesNext = new Set(cmd.after as readonly NodeId[]);
      } else if (cmd.slice === 'expansion') {
        // Restore the FULL effective-set state (record stack +
        // collapse exclusions + scope accretion) — a walk restores the
        // identical effective set; overlay DATA persists either way.
        const s = cmd.after as ExpansionStatePlain;
        expansionRecords = s.records.map((r) => ({
          expandedId: r.expandedId,
          addedNodeIds: [...r.addedNodeIds],
          overlayId: r.overlayId,
        }));
        effectiveRemovedIds.clear();
        for (const nid of s.removed) effectiveRemovedIds.add(nid);
        scopeExtraIds.clear();
        for (const nid of s.extras) scopeExtraIds.add(nid);
        effectiveTouched = true;
      } else if (cmd.slice === 'folds') {
        // folds: restore the whole anchor→members map. Membership is
        // declared state over stable ids, so a restore is a pure structural
        // diff — no data moves either way.
        folds.clear();
        for (const [anchorId, memberIds] of cmd.after as [NodeId, NodeId[]][]) {
          folds.set(anchorId, [...memberIds]);
        }
        foldsTouched = true;
      } else if (cmd.slice === 'scope') {
        scopeSpec = subgraphPlain(cmd.after as SubgraphSpec | null);
        // An explicit scope statement resets accretion AND the
        // effective set (records + exclusions).
        scopeExtraIds.clear();
        expansionRecords = [];
        effectiveRemovedIds.clear();
        scopeTouched = true;
      } else if (cmd.slice.startsWith('brush:') && crossfilterEngine !== null) {
        const key = cmd.slice.slice('brush:'.length);
        try {
          const delta = crossfilterEngine.setBrush(key, cmd.after as BrushState);
          for (const s of delta.hidden) crossfilterHiddenBase.add(s);
          for (const s of delta.shown) crossfilterHiddenBase.delete(s);
          brushTouched = true;
        } catch {
          // Dimension no longer exists (spec rebuild since): skip inertly.
        }
      }
    }

    // Structural: a scope OR expansion command replays through the SAME
    // path as the subgraph prop (reconcile the scoped/trimmed subset,
    // cached positions, reflow).
    // A fold restore reaches the scene through the stage-3 rewrite inside
    // reconcileScene; recomputing the scoped model alongside is a no-op for
    // folds but keeps ONE republication path for every structural slice.
    const structuralTouched = scopeTouched || effectiveTouched || foldsTouched;
    let structuralChange = false;
    let positionChange = false;
    if (structuralTouched && accepted !== null) {
      const engBank = engineIfReady();
      if (engBank !== null && scene !== null) {
        const pos = engBank.getPositions();
        if (pos !== null) bankEnginePositions(pos);
      }
      scopedAccepted = computeScopedAccepted();
      const result = reconcileScene(scopedAccepted ?? accepted);
      labelPositionCache = null;
      adjacency = null;
      sceneIncidence = null;
      structuralChange = result.structuralChange;
      positionChange = result.positionChange;
    }

    const effHidden = hiddenNext ?? prev.hiddenNodeIds;
    let filterDiagsChanged = false;
    if (structuralTouched) {
      filterDiagsChanged = rebuildMaskMemberships(effHidden);
    } else if (hiddenNext !== null || brushTouched) {
      if (
        scene !== null &&
        (softMask !== null || effHidden.size > 0 || crossfilterHiddenBase.size > 0)
      ) {
        ensureMask();
        if (hiddenNext !== null) refreshHiddenMembership(effHidden);
        if (brushTouched) refreshBrushMembership();
        refreshGroupMaskMembership(effHidden);
        cascadeNodeMask();
      }
    }
    if (crossfilterEngine !== null && (hiddenNext !== null || structuralTouched)) {
      // structuralTouched: scene slots shifted, so the filter-slot mapping
      // in the external mask must re-derive against the new scene.
      refreshCrossfilterExternalMask(effHidden);
    }

    const patch: Partial<GraphStoreState> = {};
    if (selectionNext !== null) patch.selection = selectionNext;
    if (hiddenNext !== null) patch.hiddenNodeIds = hiddenNext;
    if (pinsNext !== null) patch.pins = pinsNext;
    if (pinnedNodesNext !== null) patch.pinnedNodeIds = pinnedNodesNext;
    if (scopeTouched) patch.scope = scopeSpec;

    const eng = engineIfReady();
    let revisions = prev.revisions;
    let simRestarted = false;
    if (structuralTouched && scene !== null) {
      const buffers = projectChannelBuffers({
        nodeColor: true,
        nodeSize: true,
        linkColor: true,
        linkWidth: true,
      });
      const structure: EngineCommit['structure'] | undefined =
        structuralChange || positionChange
          ? { pointCount: scene.count, positions: scene.positions, links: scene.links }
          : undefined;
      const commitNeeded = structure !== undefined || buffers !== undefined;
      revisions = { ...prev.revisions };
      revisions.scope += 1;
      if (commitNeeded) revisions.render += 1;
      if (commitNeeded && eng !== null) {
        const commit: EngineCommit = { revision: revisions.render };
        if (structure !== undefined) {
          commit.structure = structure;
          // I2: a scoped roster ships with ITS index, never the previous
          // roster's.
          const syncIndex = structuralPointImageIndex();
          if (syncIndex !== null) commit.resources = { pointImageIndex: syncIndex };
        }
        if (buffers !== undefined) commit.buffers = buffers;
        if (structure !== undefined && layout === 'force') {
          const reflow = scopeSpec === null || scopeSpec.reflow !== false;
          if (reflow) {
            commit.restart = { alpha: 1 };
            simRestarted = true;
          }
        }
        commitToEngine(eng, commit);
        revisions.appliedRender = eng.appliedRevision();
        const facade = session !== null ? session.edgePicking : null;
        if (facade !== null) {
          if (commit.restart !== undefined && commit.restart !== false) facade.disarm();
          else if (structure !== undefined) facade.arm(scene.positions, scene.links);
        }
      }
    } else if (softMask !== null && scene !== null) {
      const drain = softMask.drainDirty();
      const nodesAffected = drain.nodes.length > 0 || drain.nodesAlpha.length > 0;
      const edgesAffected = drain.edges.length > 0 || drain.edgesAlpha.length > 0;
      if (nodesAffected || edgesAffected) {
        revisions = { ...prev.revisions };
        revisions.scope += 1;
        revisions.render += 1;
        if (eng !== null) {
          nodeAlphaComposer.reset(); // drain unobserved by composers
          edgeAlphaComposer.reset();
          const buffers: NonNullable<EngineCommit['buffers']> = {};
          if (nodesAffected) buffers.pointColor = composeNodeAlphaBuffer(basePointColorBuffer());
          if (edgesAffected) buffers.linkColor = composeEdgeAlphaBuffer(baseLinkColorBuffer());
          eng.commit({ revision: revisions.render, buffers });
          revisions.appliedRender = eng.appliedRevision();
        }
      }
    }
    if (revisions !== prev.revisions) patch.revisions = revisions;
    const vis = computeVisibleCounts();
    if (!sameVisible(vis, prev.visible)) patch.visible = vis;
    if (simRestarted && !prev.simulationRunning) patch.simulationRunning = true;
    const labelRerank =
      structuralTouched || hiddenNext !== null || brushTouched
        ? recomputeCandidates()
        : { setChanged: false, diagsChanged: false };
    if (labelRerank.diagsChanged || filterDiagsChanged) patch.diagnostics = composeDiagnostics();
    publish(patch); // folds the kernel's depth notification

    // Engine pushes refreshed: ALL selected indices are re-pushed even when
    // the mask hides some — engine greyout handles hidden ones and masked
    // selected ids remain in SelectionState while masked.
    if (eng !== null) {
      const selForPush = selectionNext ?? prev.selection;
      if (selectionNext !== null || (structuralChange && selForPush.nodeIds.length > 0)) {
        pushSelectionToEngine(eng, selForPush.nodeIds);
      }
      const pinsForPush = pinsNext ?? prev.pins;
      const persistentSize = store.getState().pinnedNodeIds.size;
      if (
        pinsNext !== null ||
        pinnedNodesNext !== null ||
        (structuralChange && (pinsForPush.size > 0 || persistentSize > 0))
      ) {
        pushPinsToEngine(eng, pinsForPush);
      }
    }
    if (labelRerank.setChanged) notifyLabelSubs(candidateSubs);
  }

  /**
   * history walk with the aggregate protocol: a step touching a
   * host-owned lane emits ONE viewStateRestore intent and the cursor holds
   * (store depths unchanged, nothing applied) until the host's reflection
   * acknowledges; timeout/divergence puts the cursor back. Steps with no
   * controlled participation — or with no restore listener registered (the
   * legacy behavior, where controlled leftovers skip inertly) — apply
   * synchronously as before. A walk during a pending restore returns false.
   */
  function walkHistory(direction: 'undo' | 'redo'): boolean {
    if (destroyed) return false;
    return acceptanceQueue.admit(() => {
      if (pendingRestore !== null) return false; // concurrent walk rejects as pending
      const commands = direction === 'undo' ? historyKernel.undo() : historyKernel.redo();
      if (commands === null) return false;

      const controlledAfters: PendingRestore['awaiting'] = {};
      for (const cmd of commands) {
        if (cmd.slice === 'selection' && selectionControlled) {
          controlledAfters.selection = (cmd.after as SelectionState).nodeIds;
        } else if (cmd.slice === 'pinnedNodes' && pinnedControlled) {
          controlledAfters.pinnedNodeIds = cmd.after as readonly NodeId[];
        }
      }
      const needsHost = Object.keys(controlledAfters).length > 0 && hasRestoreListener();

      if (!needsHost) {
        clearPathInternal(); // path highlight never survives a walk
        applyHistoryCommands(commands);
        return true;
      }

      // Stage: hold every command (the applier skips controlled slices
      // internally, so applying all on commit is safe — the host's
      // reflection is what writes those lanes).
      const transactionId = `restore-${++restoreTxSeq}`;
      const next: GraphViewState = {
        ...captureViewState(),
        ...(controlledAfters.selection !== undefined
          ? {
              selection: {
                nodeIds: [...controlledAfters.selection],
                edgeIds: [],
                groupIds: [],
              },
            }
          : {}),
        ...(controlledAfters.pinnedNodeIds !== undefined
          ? { pinnedNodeIds: [...controlledAfters.pinnedNodeIds] }
          : {}),
      };
      pendingRestore = {
        transactionId,
        source: direction,
        commands,
        awaiting: controlledAfters,
        finish: () => {},
        recordOnCommit: false, // the kernel entry already exists
        rollbackCursor: () => {
          // Cursor-only restore: nothing was applied, so the inverse walk is
          // a pure cursor move whose returned commands are discarded.
          if (direction === 'undo') historyKernel.redo();
          else historyKernel.undo();
        },
        resolve: () => {}, // history walks report via the boolean + store depths
        timer: setTimeout(() => failPendingRestore('restore-timeout'), RESTORE_ACK_TIMEOUT_MS),
      };
      emit('viewStateRestore', { transactionId, source: direction, next });
      return true;
    });
  }

  function undo(): boolean {
    return walkHistory('undo');
  }

  function redo(): boolean {
    return walkHistory('redo');
  }

  // -------------------------------------------------------------------------
  // overlay label lane + scheduler. Re-ranks are THROTTLED
  // (viewport idle, model change, config change, settle) — never per frame.
  // Frame ticks do a pure O(k) CPU-cache → spaceToScreen projection.
  // -------------------------------------------------------------------------

  function effectiveReducedMotion(): boolean {
    return accessibilityConfig?.reducedMotion ?? bindingReducedMotion ?? false;
  }

  function labelsEnabled(): boolean {
    return labelsConfig !== undefined && labelsConfig.enabled !== false;
  }

  /** Container-relative cull rect; null when the size is unknown (headless). */
  function containerScreenRect(): readonly [number, number, number, number] | null {
    if (session === null) return null;
    const el = session.container as Partial<Pick<HTMLElement, 'clientWidth' | 'clientHeight'>>;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return null;
    return [0, 0, w, h];
  }

  function sameCandidates(a: readonly LabelPlacement[], b: readonly LabelCandidate[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const p = a[i]!;
      const c = b[i]!;
      if (p.id !== c.id || p.text !== c.text || p.forced !== c.forced || p.kind !== c.kind) {
        return false;
      }
    }
    return true;
  }

  /** O(k) per tick: project the CURRENT set's cached space positions through
   * engine.spaceToScreen, mutating the reused placements in place. Zero
   * allocations beyond the engine's return tuple.
   *
   * a CLUSTER placement reads its precomputed anchor by ordinal
   * ONE O(1) lookup, never a member scan. The anchor is the force center
   * while the sim is hot and the settled centroid afterwards, so the anchor
   * array (not this tick) owns the "which coordinate" decision. */
  function projectPlacements(eng: GraphEngine): void {
    if (scene === null || eng.spaceToScreen === undefined) return;
    const positions = labelPositionCache ?? scene.positions;
    const anchors = clusterAnchors;
    const ordinals = clusterDerivation?.ordinalByKey;
    for (const p of currentPlacements) {
      let x: number;
      let y: number;
      if (p.kind === 'cluster') {
        if (anchors === null || ordinals === undefined) continue;
        const ordinal = ordinals.get(p.id);
        if (ordinal === undefined || 2 * ordinal + 1 >= anchors.length) continue;
        x = anchors[2 * ordinal]!;
        y = anchors[2 * ordinal + 1]!;
      } else {
        const idx = scene.indexById.get(p.id);
        if (idx === undefined || 2 * idx + 1 >= positions.length) continue;
        x = positions[2 * idx]!;
        y = positions[2 * idx + 1]!;
      }
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      projectScratch[0] = x;
      projectScratch[1] = y;
      const s = eng.spaceToScreen(projectScratch);
      if (s !== null) {
        p.x = s[0];
        p.y = s[1];
      }
    }
  }

  /**
   * Cluster-label candidates. One candidate per derived cluster,
   * capacity-capped like node labels (member count desc, ordinal tie-break)
   * and viewport-culled through the anchor — NOT through any member scan.
   * Empty when no spec is active or the zoom is above the
   * `label.maxZoom` band.
   */
  function clusterLabelCandidates(
    cfg: LabelConfig<N>,
    zoom: number,
    k: number,
  ): readonly LabelCandidate[] {
    const derivation = clusterDerivation;
    const anchors = clusterAnchors;
    if (derivation === null || anchors === null || derivation.keys.length === 0) return [];
    if (cfg.maxZoom !== undefined && zoom > cfg.maxZoom) return [];

    const eng = engineIfReady();
    const rect = containerScreenRect();
    const toScreen = eng?.spaceToScreen;
    const inView = (ordinal: number): boolean => {
      if (eng === null || toScreen === undefined || rect === null) return true;
      const x = anchors[2 * ordinal]!;
      const y = anchors[2 * ordinal + 1]!;
      if (Number.isNaN(x) || Number.isNaN(y)) return true; // unplaced ⇒ fail open
      projectScratch[0] = x;
      projectScratch[1] = y;
      const s = toScreen.call(eng, projectScratch);
      if (s === null || s === undefined) return true;
      return s[0] >= rect[0] && s[0] <= rect[2] && s[1] >= rect[1] && s[1] <= rect[3];
    };

    const ranked: { ordinal: number; size: number }[] = [];
    for (let i = 0; i < derivation.keys.length; i++) {
      if (!inView(i)) continue;
      ranked.push({ ordinal: i, size: derivation.membersByKey.get(derivation.keys[i]!)!.length });
    }
    ranked.sort((a, b) => b.size - a.size || a.ordinal - b.ordinal);
    const take = Math.min(ranked.length, k);
    const out: LabelCandidate[] = [];
    for (let j = 0; j < take; j++) {
      const key = derivation.keys[ranked[j]!.ordinal]!;
      out.push({ id: key, text: key, forced: false, kind: 'cluster' });
    }
    return out;
  }

  /** Subscriber faults are isolated so an overlay callback can never break the
   * frame loop or the applyHostUpdate transaction. */
  function notifyLabelSubs(subs: ReadonlySet<LabelListener>): void {
    if (subs.size === 0) return;
    for (const cb of Array.from(subs)) {
      try {
        cb(currentPlacements);
      } catch {
        /* isolated */
      }
    }
  }

  interface RerankResult {
    setChanged: boolean;
    diagsChanged: boolean;
  }

  /**
   * Recompute the candidate set (throttled callers only). Updates
   * `currentPlacements` (new objects on set change, projected once so replay
   * and candidate emissions carry coordinates) and the single 'label-overload'
   * diagnostic — one update per overload-count transition, no per-tick spam.
   * The CALLER publishes diagnostics and notifies candidate subscribers, so
   * applyHostUpdate can fold both into its one store publication.
   */
  function recomputeCandidates(): RerankResult {
    const eng = engineIfReady();
    const cfg = labelsConfig;
    let next: readonly LabelCandidate[] = [];
    let overload = 0;
    // The label lane ranks over the SCENE model — scene index i
    // is position i of the scoped, group-rewritten model fed to the
    // reconciler. `nodes` is the PHYSICAL prefix only: synthetic slots read
    // `nodes[i] === undefined`, so caller getText/getWeight are never invoked
    // with super-nodes; their placeholder candidates (id text)
    // are dropped below so internal scene keys never escape.
    const labelModel = sceneModel();
    if (eng !== null && scene !== null && labelModel !== null && cfg !== undefined && cfg.enabled !== false) {
      const sceneRef = scene;
      const vp = store.getState().viewport ?? eng.getViewport() ?? { x: 0, y: 0, zoom: 1 };
      // cap-dom-labels: while engaged, the host's maxVisible
      // cannot exceed the label BUDGET (the default k) — above
      // limits.domLabelNodes visible nodes, 1024 DOM labels is the cost the
      // ladder exists to shed.
      const hardCap = degradeController.isEngaged('cap-dom-labels')
        ? LABEL_MAX_VISIBLE_DEFAULT
        : LABEL_MAX_VISIBLE_CAP;
      const k = Math.max(
        0,
        Math.min(Math.floor(cfg.maxVisible ?? LABEL_MAX_VISIBLE_DEFAULT), hardCap),
      );
      // LOD hand-off: at/below `maxZoom` the CLUSTER band owns the
      // lane and node labels are suppressed; above it node-label LOD
      // (`minZoom`) takes over and cluster labels stop. With no `maxZoom` the
      // two bands coexist, each on its own gate.
      const clusterCandidates = clusterLabelCandidates(cfg, vp.zoom, k);
      const nodeLabelsSuppressed = cfg.maxZoom !== undefined && vp.zoom <= cfg.maxZoom;
      const viewport: LabelCandidateViewport = { zoom: vp.zoom };
      const rect = containerScreenRect();
      if (rect !== null) viewport.screenRect = rect;
      const toScreen = eng.spaceToScreen;
      if (toScreen !== undefined) viewport.spaceToScreen = (p) => toScreen.call(eng, p);
      const selArgs: SelectLabelCandidatesArgs<N> = {
        scene: sceneRef,
        nodes: groupRewrite !== null ? groupRewrite.physicalNodes : labelModel.nodes,
        positions: labelPositionCache ?? sceneRef.positions,
        viewport,
        config: cfg,
        degreeOf: (i) => {
          if (adjacency === null) adjacency = buildAdjacency(sceneRef.links, sceneRef.count);
          return adjacency.offsets[i + 1]! - adjacency.offsets[i]!;
        },
      };
      const inRect = eng.pointsInRect;
      if (inRect !== undefined) selArgs.pointsInRect = (r) => inRect.call(eng, r);
      let nodeCandidates: readonly LabelCandidate[] = [];
      if (!nodeLabelsSuppressed) {
        const result = selectLabelCandidates(selArgs);
        nodeCandidates = result.placements;
        overload = result.overloadCount;
        // mask-hidden nodes are excluded from the label lane (post-filter
        // the placements — ranking stays pure; forced ids honor the mask too).
        // synthetic suffix slots are excluded entirely in this slice
        // super-node labels arrive with the group event wiring.
        const physBound = physicalPointCount();
        if (softMask !== null || groupRewrite !== null) {
          nodeCandidates = nodeCandidates.filter((c) => {
            const i = sceneRef.indexById.get(c.id);
            if (i === undefined) return true;
            if (i >= physBound) return false;
            return softMask === null || softMask.isNodeVisible(i);
          });
        }
      }
      // Cluster labels lead: they are the coarser layer, and the array order
      // is the overlay's paint order.
      next = clusterCandidates.length === 0 ? nodeCandidates : [...clusterCandidates, ...nodeCandidates];
    }

    const setChanged = !sameCandidates(currentPlacements, next);
    if (setChanged) {
      currentPlacements = next.map((c) => ({
        id: c.id,
        text: c.text,
        x: 0,
        y: 0,
        forced: c.forced,
        ...(c.kind !== undefined ? { kind: c.kind } : {}),
      }));
      const engNow = engineIfReady();
      if (engNow !== null) projectPlacements(engNow);
    }

    let diagsChanged = false;
    if (overload !== lastOverloadCount) {
      lastOverloadCount = overload;
      labelDiags =
        overload === 0
          ? []
          : [
              {
                code: 'label-overload',
                severity: 'warning',
                count: overload,
                sampleIds: [],
                message: `showLabelsFor exceeds tracked-label capacity; ${overload} forced label(s) omitted`,
              },
            ];
      diagsChanged = true;
    }
    return { setChanged, diagsChanged };
  }

  /** Standalone re-rank (viewport idle, settle, ready): publish + notify here. */
  function rerankAndNotify(): void {
    if (destroyed) return;
    const r = recomputeCandidates();
    if (r.diagsChanged) publish({ diagnostics: composeDiagnostics() });
    if (r.setChanged) notifyLabelSubs(candidateSubs);
  }

  /** viewport-driven re-rank: >=100ms trailing throttle (fires at camera
   * idle when events stop); bursts coalesce into ONE recompute. */
  function scheduleViewportRerank(): void {
    if (destroyed || rerankTimer !== null || !labelsEnabled()) return;
    rerankTimer = setTimeout(() => {
      rerankTimer = null;
      rerankAndNotify();
    }, LABEL_RERANK_THROTTLE_MS);
  }

  function cancelRerankTimer(): void {
    if (rerankTimer !== null) {
      clearTimeout(rerankTimer);
      rerankTimer = null;
    }
  }

  function subscribeLabelChannel(subs: Set<LabelListener>, cb: LabelListener): () => void {
    if (destroyed) return () => {};
    subs.add(cb);
    try {
      cb(currentPlacements); // replay current state on subscribe
    } catch {
      /* isolated */
    }
    return () => {
      subs.delete(cb);
    };
  }

  /** Project the requested channels against the current RENDER model (the
   * scoped subset when a hard scope is active — buffers must align with the
   * scene. Channels without a configured accessor are skipped. */
  // -------------------------------------------------------------------------
  // Scale channels. Scales are plain descriptors detected by
  // their 'kind' discriminant and compared by canonical structural key
  // equal inline literals never reproject. Metric values come from the
  // MetricStore over the FULL accepted model; domains resolve through the
  // DomainStore's freeze coordinates. EVERY caller-supplied numeric input
  // (explicit domains, ranges, mid, palettes) routes through coerceNumeric.
  // -------------------------------------------------------------------------

  type AnyScale = Scale<string, N> | Scale<number, N>;

  function isScaleValue(v: unknown): v is AnyScale {
    if (typeof v !== 'object' || v === null) return false;
    const kind = (v as { kind?: unknown }).kind;
    return kind === 'sequential' || kind === 'categorical' || kind === 'diverging';
  }

  /** per-channel dirty comparison: reference identity first, canonical
   * structural equality for Scale descriptors (equal literals never
   * reproject — a function `by` keys by reference via the WeakMap token). */
  function sameChannelValue(next: unknown, prevValue: unknown): boolean {
    if (Object.is(next, prevValue)) return true;
    if (isScaleValue(next) && isScaleValue(prevValue)) {
      return (
        canonicalScaleKey(next as Scale<unknown, N>) ===
        canonicalScaleKey(prevValue as Scale<unknown, N>)
      );
    }
    return false;
  }

  /** Does this channel carry a sequential/diverging scale over one of the
   * just-admitted metric names? (targeted re-dirty.) */
  function scaleReferencesMetric(channel: unknown, names: ReadonlySet<string>): boolean {
    if (!isScaleValue(channel) || channel.kind === 'categorical') return false;
    return names.has(channel.metric);
  }

  /** Does this channel's domain policy opt into 'visible' recompute? */
  function scaleUsesVisibleDomain(channel: unknown): boolean {
    if (!isScaleValue(channel) || channel.kind !== 'sequential') return false;
    const d = channel.domain;
    return d !== undefined && !Array.isArray(d) && (d as DomainPolicy).scope === 'visible';
  }

  /**
   * Sync the MetricStore to the current accepted model (lazy — the flat link
   * buffer and CSR adjacency are built on FIRST metric use per model
   * revision. Returns false when there is no accepted model.
   */
  function ensureMetricModel(): boolean {
    if (accepted === null) return false;
    const key = `${accepted.datasetKey} ${String(accepted.sourceRevision)} ${String(acceptedModelSeq)}`;
    if (metricModelKey === key) return true;
    const { edges, nodeIndex, nodes } = accepted;
    const links = new Uint32Array(edges.length * 2);
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i]!;
      links[2 * i] = nodeIndex.get(e.source)!;
      links[2 * i + 1] = nodeIndex.get(e.target)!;
    }
    metricStore.setModel({
      nodes,
      adjacency: buildAdjacency(links, nodes.length),
      links,
      datasetRevision: `${accepted.datasetKey} ${String(accepted.sourceRevision)}`,
      modelRevision: acceptedModelSeq,
    });
    metricModelKey = key;
    return true;
  }

  /** Metric value for one RENDER-model node via the accepted id→index map. */
  function metricValueForNode(node: GraphNode<N>, metric: MetricName): number | null {
    if (accepted === null) return null;
    const idx = accepted.nodeIndex.get(node.id);
    if (idx === undefined) return null;
    return metricStore.getMetricValue(metric, idx);
  }

  /** domain freeze coordinate: accepted source+model revision, extended
   * with the metric's column-admission generation so a later-arriving column
   * recomputes exactly the domains that reference it. */
  /**
   * The DEFAULT freeze coordinate is dataset-scoped — source
   * revision + the metric's column generation, NEVER the progressive
   * publication sequence, so inferred domains stay frozen across overlay
   * flushes. 'expand' opts
   * back into per-publication resolution: each flush recomputes and unions
   * WITHIN the current source lineage (the DomainStore lineage guard keeps
   * a replacement from unioning against dead extrema).
   */
  function domainDatasetRevision(
    metric: MetricName,
    streaming: 'freeze-per-revision' | 'expand',
  ): string {
    const src = String(accepted?.sourceRevision);
    const gen = String(metricColumnGen.get(metric) ?? 0);
    return streaming === 'expand' ? `${src}#${String(acceptedModelSeq)}#${gen}` : `${src}#${gen}`;
  }

  /** Domain producer per scope: 'dataset' spans the full accepted metric
   * column; 'hard-scope' the scoped render model; 'visible' additionally
   * restricts to mask-visible slots. hygiene throughout. */
  function computeMetricDomain(
    metric: MetricName,
    scope: 'dataset' | 'hard-scope' | 'visible',
  ): readonly [number, number] | null {
    if (!ensureMetricModel()) return null;
    if (scope === 'dataset') {
      const column = metricStore.metricValues(metric);
      return column === null ? null : computeNumericDomain(column);
    }
    const model = sceneModel();
    if (model === null) return null;
    let min = Infinity;
    let max = -Infinity;
    let seen = false;
    // Synthetic suffix slots are excluded: metrics are physical-node values
    // and super-nodes never join a domain.
    const bound = groupRewrite !== null ? groupRewrite.physicalNodeCount : model.nodes.length;
    for (let i = 0; i < bound; i++) {
      if (scope === 'visible' && softMask !== null && !softMask.isNodeVisible(i)) continue;
      const v = metricValueForNode(model.nodes[i]!, metric);
      if (v === null) continue;
      seen = true;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return seen ? [min, max] : null;
  }

  /** Resolve a sequential/diverging scale's domain through the DomainStore
   * (explicit numeric domains win verbatim; policies freeze by revision). */
  function resolveScaleDomain(
    scale: Extract<AnyScale, { kind: 'sequential' | 'diverging' }>,
  ): readonly [number, number] | null {
    if (accepted === null) return null;
    let explicit: readonly [number, number] | undefined;
    let policy: DomainPolicy | undefined;
    if (scale.kind === 'sequential' && scale.domain !== undefined) {
      if (Array.isArray(scale.domain)) {
        const lo = coerceNumeric(scale.domain[0]);
        const hi = coerceNumeric(scale.domain[1]);
        if (lo !== null && hi !== null) explicit = [lo, hi];
      } else {
        policy = scale.domain as DomainPolicy;
      }
    }
    const scope = policy?.scope ?? 'dataset';
    const streaming = policy?.streaming ?? 'freeze-per-revision';
    const scopeGeneration =
      scope === 'hard-scope' ? hardScopeGen : scope === 'visible' ? visibleGen : 0;
    return domainStore.resolveDomain({
      key: canonicalScaleKey(scale as Scale<unknown, N>),
      explicit,
      policy,
      datasetRevision: domainDatasetRevision(scale.metric, streaming),
      lineage: `${accepted.datasetKey}#${String(accepted.sourceRevision)}`,
      scopeGeneration,
      compute: () => computeMetricDomain(scale.metric, scope),
    });
  }

  function clampUnit(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /** Categorical `by` → string|null getter: 'id'/attrs-field per the
   * FilterExpr convention (string as-is, finite numbers and booleans
   * stringified, everything else null); functions guarded (throw → null). */
  function categoricalByGetter(
    by: string | ((node: GraphNode<N>) => string | null),
  ): (node: GraphNode<N>) => string | null {
    if (typeof by === 'function') {
      return (node) => {
        let v: unknown;
        try {
          v = by(node);
        } catch {
          return null;
        }
        return typeof v === 'string' ? v : null;
      };
    }
    return (node) => {
      const v = resolveFilterField(node, by);
      if (typeof v === 'string') return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      if (typeof v === 'boolean') return String(v);
      return null;
    };
  }

  /** Scale<string> → per-node CSS color accessor. Null metric values and
   * out-of-palette categories fall back to theme.nodeDefault. */
  function scaleColorAccessor(scale: Scale<string, N>): (node: GraphNode<N>) => string {
    const fallbackCss = theme.nodeDefault;
    if (scale.kind === 'categorical') {
      const palette = scale.palette ?? CATEGORICAL_PALETTE;
      const domain = scale.domain;
      const by = categoricalByGetter(scale.by);
      return (node) => {
        const value = by(node);
        if (value === null) return fallbackCss;
        const idx = categoricalIndex(domain, palette, value);
        const css = idx === -1 ? undefined : palette[idx];
        return typeof css === 'string' ? css : fallbackCss;
      };
    }
    ensureMetricModel();
    const metric = scale.metric;
    const domain = resolveScaleDomain(scale);
    if (scale.kind === 'sequential') {
      return (node) =>
        sequentialColor(scale, metricValueForNode(node, metric), domain) ?? fallbackCss;
    }
    const mid = coerceNumeric(scale.mid);
    return (node) => {
      if (mid === null) return fallbackCss;
      return divergingColor(scale, metricValueForNode(node, metric), domain) ?? fallbackCss;
    };
  }

  /** Scale<number> → per-node size accessor. Null metrics and junk
   * ranges/palettes fall back to the default size 4 (hygiene — NaN can
   * never reach the size buffer). */
  function scaleSizeAccessor(scale: Scale<number, N>): (node: GraphNode<N>) => number {
    const FALLBACK_SIZE = 4;
    if (scale.kind === 'categorical') {
      const palette = scale.palette;
      const domain = scale.domain;
      const by = categoricalByGetter(scale.by);
      return (node) => {
        if (palette === undefined || palette.length === 0) return FALLBACK_SIZE;
        const value = by(node);
        if (value === null) return FALLBACK_SIZE;
        const idx = categoricalIndex(domain, palette, value);
        const size = idx === -1 ? null : coerceNumeric(palette[idx]);
        return size === null ? FALLBACK_SIZE : size;
      };
    }
    ensureMetricModel();
    const metric = scale.metric;
    const domain = resolveScaleDomain(scale);
    if (scale.kind === 'sequential') {
      const lo = coerceNumeric(scale.range[0]);
      const hi = coerceNumeric(scale.range[1]);
      return (node) => {
        if (lo === null || hi === null) return FALLBACK_SIZE;
        return sequentialSize([lo, hi], metricValueForNode(node, metric), domain) ?? FALLBACK_SIZE;
      };
    }
    // Diverging size: each half interpolates independently (mirrors
    // divergingColor's piecewise semantics over a numeric range).
    const mid = coerceNumeric(scale.mid);
    const r0 = coerceNumeric(scale.range[0]);
    const r1 = coerceNumeric(scale.range[1]);
    const r2 = coerceNumeric(scale.range[2]);
    return (node) => {
      if (mid === null || r0 === null || r1 === null || r2 === null || domain === null) {
        return FALLBACK_SIZE;
      }
      const v = metricValueForNode(node, metric);
      if (v === null) return FALLBACK_SIZE;
      let size: number;
      if (v <= mid) {
        const span = mid - domain[0];
        const t = !Number.isFinite(span) || span <= 0 ? 1 : clampUnit((v - domain[0]) / span);
        size = r0 + (r1 - r0) * t;
      } else {
        const span = domain[1] - mid;
        const t = !Number.isFinite(span) || span <= 0 ? 0 : clampUnit((v - mid) / span);
        size = r1 + (r2 - r1) * t;
      }
      return Number.isFinite(size) ? size : FALLBACK_SIZE;
    };
  }

  /** theme.nodeDefault as the projection RGBA fallback for scale channels. */
  function themeNodeDefaultRgba(): RGBA {
    return parseColor(theme.nodeDefault) ?? [0.66, 0.66, 0.66, 1];
  }

  /**
   * dev inline-lambda detector: after EVERY projection of a
   * function-valued channel, fingerprint the first 8 sampled outputs (O(8),
   * unconditional). ≥3 consecutive projections with an identical fingerprint
   * emit ONE 'accessor-churn' diagnostic per streak; a changed fingerprint
   * (or a non-function channel value) resets the streak.
   */
  function noteChannelProjection(
    channel: 'nodeColor' | 'nodeSize' | 'linkColor' | 'linkWidth',
    value: unknown,
    items: readonly unknown[],
  ): void {
    const state = churnStates[channel];
    if (typeof value !== 'function') {
      state.fp = null;
      state.streak = 0;
      state.emitted = false;
      return;
    }
    const fn = value as (item: unknown) => unknown;
    const n = Math.min(8, items.length);
    let fp = '';
    for (let i = 0; i < n; i++) {
      let sample: string;
      try {
        sample = String(fn(items[i]));
      } catch {
        sample = 'err';
      }
      fp += sample + ' ';
    }
    if (state.fp === fp) {
      state.streak += 1;
    } else {
      state.fp = fp;
      state.streak = 1;
      state.emitted = false;
    }
    if (state.streak >= 3 && !state.emitted) {
      state.emitted = true;
      churnDiags = [
        ...churnDiags,
        {
          code: 'accessor-churn',
          severity: 'warning',
          count: state.streak,
          sampleIds: [],
          message:
            `${channel} reprojected on ${state.streak} consecutive commits with identical ` +
            'sampled outputs — likely an inline lambda prop; hoist or memoize it',
        },
      ];
    }
  }

  /**
   * stage-6 aggregate channels: synthetic suffix slots are
   * styled here — group color (or theme accent), member-count size, and
   * underlying-count meta-edge width — so caller accessors are NEVER invoked
   * with super-nodes or meta-edges. All helpers write the contiguous suffix.
   */
  function applySuperNodeColors(full: Float32Array, rw: GroupRewrite<N, E>): Float32Array {
    const accent = parseColor(theme.accent) ?? DEFAULT_RGBA;
    for (let j = 0; j < rw.superNodes.length; j++) {
      const group = rw.superNodes[j]!.group;
      const rgba = (group.color !== undefined ? parseColor(group.color) : null) ?? accent;
      const o = 4 * (rw.physicalNodeCount + j);
      full[o] = rgba[0];
      full[o + 1] = rgba[1];
      full[o + 2] = rgba[2];
      full[o + 3] = rgba[3];
    }
    return full;
  }

  function applyMetaEdgeColors(full: Float32Array, rw: GroupRewrite<N, E>): Float32Array {
    const rgba = parseColor(theme.edgeDefault) ?? DEFAULT_RGBA;
    for (let j = 0; j < rw.metaEdges.length; j++) {
      const o = 4 * (rw.physicalEdgeCount + j);
      full[o] = rgba[0];
      full[o + 1] = rgba[1];
      full[o + 2] = rgba[2];
      full[o + 3] = rgba[3];
    }
    return full;
  }

  /** Copy a physical-prefix buffer into a full scene-sized one. */
  function expandToScene(physical: Float32Array, perSlot: number, slots: number): Float32Array {
    const full = new Float32Array(perSlot * slots);
    full.set(physical);
    return full;
  }

  function projectChannelBuffers(dirty: DirtyChannels): EngineCommit['buffers'] | undefined {
    const model = sceneModel();
    if (model === null) return undefined;
    const rw = groupRewrite;
    // Caller accessors and the churn detector see PHYSICAL rows only.
    const physNodes = rw !== null ? rw.physicalNodes : model.nodes;
    const physEdges = rw !== null ? rw.physicalEdges : model.edges;
    const out: NonNullable<EngineCommit['buffers']> = {};
    let any = false;
    if (dirty.nodeColor) {
      if (nodeColor !== undefined) {
        const r = isScaleValue(nodeColor)
          ? projectColors(
              physNodes,
              scaleColorAccessor(nodeColor as Scale<string, N>),
              themeNodeDefaultRgba(),
            )
          : projectColors(physNodes, nodeColor);
        nodeColorDiags = r.diagnostics;
        noteChannelProjection('nodeColor', nodeColor, physNodes);
        const full =
          rw === null ? r.buffer : applySuperNodeColors(expandToScene(r.buffer, 4, model.nodes.length), rw);
        // cache the UNMASKED base; the engine gets a masked copy so a
        // later mask-only drain rebuilds alphas without re-projecting.
        basePointColors = full;
        basePointColorsSynthesized = false;
        out.pointColor = composeNodeAlphaBuffer(full);
        any = true;
      } else if (rw !== null && scene !== null) {
        // No accessor but a rewrite: the aggregate channel must still paint
        // super-nodes distinctly — theme fill prefix + aggregate suffix
        // (basePointColorBuffer is rewrite-aware).
        basePointColors = null;
        out.pointColor = composeNodeAlphaBuffer(basePointColorBuffer());
        any = true;
      } else if (softMask !== null && scene !== null) {
        // No accessor configured but a mask exists: synthesize the default
        // fill so mask alphas reach the engine (initial projection, recovery
        // and re-attach replays all compose here).
        out.pointColor = composeNodeAlphaBuffer(basePointColorBuffer());
        any = true;
      }
    }
    if (dirty.nodeSize && (nodeSize !== undefined || rw !== null)) {
      let physical: Float32Array;
      if (nodeSize !== undefined) {
        const r = isScaleValue(nodeSize)
          ? projectSizes(physNodes, scaleSizeAccessor(nodeSize as Scale<number, N>))
          : projectSizes(physNodes, nodeSize);
        nodeSizeDiags = r.diagnostics;
        noteChannelProjection('nodeSize', nodeSize, physNodes);
        physical = r.buffer;
      } else {
        physical = new Float32Array(physNodes.length).fill(PHYSICAL_DEFAULT_POINT_SIZE);
      }
      if (rw === null) {
        out.pointSize = physical;
      } else {
        const full = expandToScene(physical, 1, model.nodes.length);
        for (let j = 0; j < rw.superNodes.length; j++) {
          full[rw.physicalNodeCount + j] = superNodeSizeFor(
            rw.superNodes[j]!.presentMemberIds.length,
          );
        }
        out.pointSize = full;
      }
      any = true;
    }
    if (dirty.linkColor) {
      if (linkColor !== undefined) {
        const r = projectColors(physEdges, linkColor);
        linkColorDiags = r.diagnostics;
        noteChannelProjection('linkColor', linkColor, physEdges);
        const full =
          rw === null ? r.buffer : applyMetaEdgeColors(expandToScene(r.buffer, 4, model.edges.length), rw);
        baseLinkColors = full;
        baseLinkColorsSynthesized = false;
        out.linkColor = composeEdgeAlphaBuffer(full);
        any = true;
      } else if (softMask !== null && scene !== null) {
        // Aggregate meta-edge color IS the theme edge default, so the
        // synthesized full-length fill covers the suffix too.
        out.linkColor = composeEdgeAlphaBuffer(baseLinkColorBuffer());
        any = true;
      }
    }
    if (dirty.linkWidth && (linkWidth !== undefined || rw !== null)) {
      let physical: Float32Array;
      if (linkWidth !== undefined) {
        const r = projectSizes(physEdges, linkWidth);
        linkWidthDiags = r.diagnostics;
        noteChannelProjection('linkWidth', linkWidth, physEdges);
        physical = r.buffer;
      } else {
        physical = new Float32Array(physEdges.length).fill(PHYSICAL_DEFAULT_LINK_WIDTH);
      }
      let full = physical;
      if (rw !== null) {
        full = expandToScene(physical, 1, model.edges.length);
        for (let j = 0; j < rw.metaEdges.length; j++) {
          // The count badge datum also drives the aggregate width channel.
          full[rw.physicalEdgeCount + j] = metaEdgeWidthFor(rw.metaEdges[j]!.metaEdge.count);
        }
      }
      out.linkWidth = full;
      lastLinkWidths = full;
      any = true;
    }
    return any ? out : undefined;
  }

  /** The FULL desired engine config for replays: theme tokens are
   * always defined (dark base default), so a replay always carries them. */
  function fullConfig(): EngineConfigUpdate {
    const c: EngineConfigUpdate = {
      backgroundColor: theme.background,
      defaultPointColor: theme.nodeDefault,
      defaultLinkColor: theme.edgeDefault,
      linkArrows: edgeArrows,
      renderLinks: showLinks,
      emphasisRingColor: theme.emphasisRing,
    };
    if (simulation !== undefined) c.simulation = simulation;
    // stage-4: a replay re-sends the live cluster force (the restored
    // GL machine has none). Omitted when no spec is active so the inert case
    // adds no key to the replay config.
    if (clusterSpec !== null) {
      const cluster = clusterConfigPayload();
      if (cluster !== null) c.cluster = cluster;
    }
    return c;
  }

  /** EVERY engine commit routes through the capability normalizer
   * payload the declared record cannot honor is stripped before the adapter
   * ever sees it (identity-preserving when nothing strips).
   *
   * stage 4 rides the same funnel (I2 discipline): an owed cluster
   * payload joins the NEXT commit, so the index-addressed `pointClusters`
   * mapping is always applied in the same commit as the roster it describes.
   * A caller that already placed `config.cluster` (the host-update lane, a
   * `fullConfig` replay) wins and just clears the debt. */
  function commitToEngine(eng: GraphEngine, commit: EngineCommit): void {
    let outgoing = commit;
    if (clusterConfigPending) {
      if (commit.config?.cluster === undefined) {
        outgoing = {
          ...commit,
          config: { ...(commit.config ?? {}), cluster: clusterConfigPayload() },
        };
      }
      clusterConfigPending = false;
    }
    eng.commit(normalizeCommitForCapabilities(outgoing, eng.capabilities).commit);
  }

  // -------------------------------------------------------------------------
  // image-atlas wiring. Refs feed the pipeline only under a
  // 'native' capability policy; batches land as their own resources-only
  // commits through the acceptance queue; the full delivered atlas state is
  // replayed on recovery; a datasetKey change disposes and rebuilds.
  // -------------------------------------------------------------------------

  function handleAtlasBatch(batch: ImageAtlasBatch): void {
    acceptanceQueue.admit(() => {
      if (destroyed) return;
      for (const u of batch.upserts) atlasDeliveredBitmaps.set(u.slot, u.bitmap);
      for (const slot of batch.removeSlots) atlasDeliveredBitmaps.delete(slot);
      lastPointImageIndex = batch.pointImageIndex;
      const diagsChanged = batch.diagnostics.length > 0;
      if (diagsChanged) imageDiags = [...imageDiags, ...batch.diagnostics];
      const eng = engineIfReady();
      const patch: Partial<GraphStoreState> = {};
      if (eng !== null) {
        // Resources-only commit: zero buffer channels, zero structure
        // the render revision still advances.
        const revisions: Revisions = { ...store.getState().revisions };
        revisions.render += 1;
        commitToEngine(eng, {
          revision: revisions.render,
          resources: {
            imageAtlas: { upserts: batch.upserts, removeSlots: batch.removeSlots },
            pointImageIndex: batch.pointImageIndex,
          },
        });
        revisions.appliedRender = eng.appliedRevision();
        patch.revisions = revisions;
      }
      if (diagsChanged) patch.diagnostics = composeDiagnostics();
      if (Object.keys(patch).length > 0) publish(patch);
    });
  }

  function ensureImagePipeline(): ImageAtlasPipeline {
    if (imagePipeline === null) {
      imagePipeline = new ImageAtlasPipeline(
        opts.imageResolver !== undefined ? { resolver: opts.imageResolver } : {},
      );
      imagePipeline.onBatch(handleAtlasBatch);
    }
    return imagePipeline;
  }

  /** Feed the index-aligned per-point ref roster to the pipeline (called on
   * accepted-model/scope changes, nodeImage changes, and at ready). No-op
   * unless the session policy resolved images as 'native' — under
   * 'placeholder' the accessor is retained but never resolved. */
  function pushImageRefs(): void {
    if (session === null || session.policy === null || session.policy.images !== 'native') return;
    // defer-images: under admission pressure new decodes stay
    // queued — placeholders render, refs re-admit when the step releases.
    if (degradeController.isEngaged('defer-images')) {
      imageRefsDeferred = true;
      return;
    }
    imageRefsDeferred = false;
    // Index-aligned to the SCENE roster (stage-3 post-rewrite when active).
    const model = sceneModel();
    if (model === null) return;
    if (nodeImage === undefined) {
      // A CLEARED accessor drains the atlas — an all-null roster
      // evicts every slot and commits the all-placeholder index atomically;
      // the generation bump makes any still-pending decode stale on arrival.
      if (imagePipeline !== null) {
        imagePipeline.requestRefs(
          new Array<string | null>(model.nodes.length).fill(null),
          ++imageGeneration,
        );
      }
      return;
    }
    const fn = nodeImage;
    const refs: (string | null)[] = new Array<string | null>(model.nodes.length);
    // synthetic suffix slots always ride as null refs (placeholder
    // shape) — the accessor never sees super-nodes.
    const bound = groupRewrite !== null ? groupRewrite.physicalNodeCount : model.nodes.length;
    for (let i = 0; i < model.nodes.length; i++) {
      if (i >= bound) {
        refs[i] = null;
        continue;
      }
      let ref: unknown;
      try {
        ref = fn(model.nodes[i]!);
      } catch {
        ref = null;
      }
      refs[i] = typeof ref === 'string' && ref !== '' ? ref : null;
    }
    ensureImagePipeline().requestRefs(refs, ++imageGeneration);
  }

  /**
   * Refs re-fed for the NEW roster plus the synchronous
   * point→slot index to ride the SAME structural commit — resolved+
   * delivered slots where known, placeholders otherwise. Returns null when
   * images are not native this session (no pipeline). The scheduled async
   * flush afterwards only ever promotes placeholders.
   */
  function structuralPointImageIndex(): Float32Array | null {
    if (session === null || session.policy === null || session.policy.images !== 'native') {
      return null;
    }
    pushImageRefs();
    return imagePipeline?.currentPointIndex() ?? null;
  }

  /** dataset swap: per-dataset atlas state does not carry over. */
  function resetImagePipelineState(): void {
    imagePipeline?.dispose();
    imagePipeline = null;
    atlasDeliveredBitmaps.clear();
    lastPointImageIndex = null;
    imageDiags = [];
  }

  /** recovery/replay payload: the FULL delivered atlas state. Null
   * when images are not native this session or nothing was ever delivered. */
  function replayAtlasResources(): NonNullable<EngineCommit['resources']> | null {
    if (session === null || session.policy === null || session.policy.images !== 'native') {
      return null;
    }
    if (atlasDeliveredBitmaps.size === 0 && lastPointImageIndex === null) return null;
    const upserts = [...atlasDeliveredBitmaps].map(([slot, bitmap]) => ({ slot, bitmap }));
    return {
      imageAtlas: { upserts },
      ...(lastPointImageIndex !== null ? { pointImageIndex: lastPointImageIndex } : {}),
    };
  }

  /**
   * per-event readback bank with the pin overlay: the pin slice is
   * authoritative for pinned coordinates, so an engine that does not mirror
   * pins into its position buffer can never clobber a pinned position in the
   * cache. Mutates `pos` in place before noting (callers pass a fresh
   * per-event readback they own).
   */
  function bankEnginePositions(pos: Float32Array): void {
    const pins = store.getState().pins;
    if (pins.size > 0 && scene !== null) {
      for (const [id, xy] of pins) {
        const idx = scene.indexById.get(id);
        if (idx !== undefined && 2 * idx + 1 < pos.length) {
          pos[2 * idx] = xy[0];
          pos[2 * idx + 1] = xy[1];
        }
      }
    }
    reconciler.noteEnginePositions(pos);
    // the freshest per-event readback also feeds the label lane's
    // projection cache (pin overlay already applied above).
    labelPositionCache = pos;
  }

  /** Mirror the selection highlight into the engine. Reads the PUBLISHED
   * group namespace from the store (every caller pushes after its publish):
   * selected GROUP ids highlight their super-node slots in the synthetic
   * suffix; expanded/unrewritten groups have no slot and add nothing. */
  function pushSelectionToEngine(eng: GraphEngine, ids: readonly NodeId[]): void {
    const groupIds = store.getState().selection.groupIds;
    if (scene === null || (ids.length === 0 && groupIds.length === 0)) {
      eng.setSelectedIndices(null);
      return;
    }
    const indices: number[] = [];
    for (const id of ids) {
      const idx = scene.indexById.get(id);
      if (idx !== undefined) indices.push(idx);
    }
    const sceneGroups = scene.groups;
    if (sceneGroups !== undefined && groupIds.length > 0) {
      for (let k = 0; k < sceneGroups.superNodes.length; k++) {
        if (groupIds.includes(sceneGroups.superNodes[k]!.id)) {
          indices.push(sceneGroups.physicalPointCount + k);
        }
      }
    }
    eng.setSelectedIndices(indices.length > 0 ? indices : null);
  }

  /** Mirror the pin state into the engine (when supported) as
   * the UNION of three independent lifecycles: transient drag
   * pins (the `pins` map — coordinates live in that slice), PERSISTENT pins
   * (`store.pinnedNodeIds` — no coordinates in v0.10: the engine holds each
   * at its CURRENT position), and pinned accretion (previously-placed
   * ids held while an expansion settles; the next simulationEnd releases
   * the union back to the two user slices). Releasing a drag pin on a
   * persistently-pinned node therefore leaves it pinned. Callers invoke
   * this AFTER their store publication — the persistent slice is read from
   * the current store state. */
  function pushPinsToEngine(
    eng: GraphEngine,
    pins: ReadonlyMap<NodeId, readonly [number, number]>,
  ): void {
    if (eng.setPinnedIndices === undefined) return;
    const persistent = store.getState().pinnedNodeIds;
    if (scene === null || (pins.size === 0 && persistent.size === 0 && accretionPinIds === null)) {
      eng.setPinnedIndices(null);
      return;
    }
    const indexSet = new Set<number>();
    for (const id of pins.keys()) {
      const idx = scene.indexById.get(id);
      if (idx !== undefined) indexSet.add(idx);
    }
    for (const id of persistent) {
      const idx = scene.indexById.get(id);
      if (idx !== undefined) indexSet.add(idx);
    }
    if (accretionPinIds !== null) {
      for (const id of accretionPinIds) {
        const idx = scene.indexById.get(id);
        if (idx !== undefined) indexSet.add(idx);
      }
    }
    eng.setPinnedIndices(indexSet.size > 0 ? [...indexSet] : null);
  }

  /** the ONE writer of the engine's emphasis (focused-point) ring. Every
   * driver — pointer hover, focusNode, emphasizeNode, structural re-applies
   * routes here, so the `emphasisRing:false` toggle is enforced in one place:
   * the host-update lane clears the ring once at toggle time, and this gate
   * turns every later write into a no-op. */
  function applyEmphasis(eng: GraphEngine, index: number | null): void {
    if (!emphasisRingOn) return;
    eng.setFocusedIndex(index);
  }

  /**
   * highlight remap: after a full replay (fresh attach, context recovery)
   * re-push selection, pins, and hover focus with freshly mapped indices from
   * the CURRENT store state.
   */
  function reapplyInteractionState(eng: GraphEngine): void {
    const { selection, pins, pinnedNodeIds, hover } = store.getState();
    if (selection.nodeIds.length > 0 || selection.groupIds.length > 0) {
      pushSelectionToEngine(eng, selection.nodeIds);
    }
    // recovery/re-attach replays PERSISTENT pins with the drag
    // slice — freshly mapped indices, same union sink.
    if (pins.size > 0 || pinnedNodeIds.size > 0) pushPinsToEngine(eng, pins);
    if (emphasizedNodeId !== null && scene !== null && !scene.indexById.has(emphasizedNodeId)) {
      emphasizedNodeId = null; // departed while detached/lost — never resurrect
    }
    if (hover.nodeId !== null && scene !== null) {
      const idx = scene.indexById.get(hover.nodeId);
      if (idx !== undefined) applyEmphasis(eng, idx);
    } else if (emphasizedNodeId !== null && scene !== null) {
      const idx = scene.indexById.get(emphasizedNodeId);
      if (idx !== undefined) applyEmphasis(eng, idx);
    }
  }

  function maybeFitView(eng: GraphEngine): void {
    if (!fitViewOnFirstData || session === null || session.fitDone) return;
    if (accepted === null) return; // "first data": only fit once data exists
    session.fitDone = true;
    if (effectiveReducedMotion()) eng.fitView({ durationMs: 0 });
    else eng.fitView();
  }

  // -------------------------------------------------------------------------
  // Selection model
  // -------------------------------------------------------------------------

  function nodeIndexBase(): ReadonlyMap<NodeId, number> {
    return accepted === null ? EMPTY_INDEX : accepted.nodeIndex;
  }

  /**
   * selectAll/invert population: the VISIBLE set — the render scene
   * (scoped when a hard scope is active), restricted to
   * mask-visible slots (which already fold in hiddenNodeIds, the filter
   * prop, and crossfilter brushes), in accepted-base order. The explicit
   * hiddenNodeIds check also covers the mask-less startup path.
   */
  function selectablePopulation(): NodeId[] {
    const model = sceneModel();
    if (model === null) return [];
    const hidden = store.getState().hiddenNodeIds;
    const out: NodeId[] = [];
    // Physical slots only: synthetic super-nodes are not node-selectable in
    // this slice (group selection uses the groupIds namespace).
    const bound = groupRewrite !== null ? groupRewrite.physicalNodeCount : model.nodes.length;
    for (let i = 0; i < bound; i++) {
      const node = model.nodes[i]!;
      if (hidden.has(node.id)) continue;
      if (softMask !== null && !softMask.isNodeVisible(i)) continue;
      out.push(node.id);
    }
    return out;
  }

  /**
   * Internal selection mutation (clicks, set algebra, setSelection).
   * Controlled mode covers the NODE namespace only: node changes
   * surface as 'selectionChange' intent without a store write, while edge and
   * group namespaces stay instance-internal and are written directly.
   * Uncontrolled store writes mirror node indices to the engine.
   */
  function applySelectionIntent(next: SelectionState): void {
    // ANY selection mutation releases path emphasis — the selection
    // push below then owns the highlight channel again.
    if (activePath !== null) {
      dropPathState();
      const engForPath = engineIfReady();
      if (engForPath !== null && scene !== null) {
        engForPath.commit({
          revision: store.getState().revisions.render,
          buffers: { linkColor: composeEdgeAlphaBuffer(baseLinkColorBuffer()) },
        });
      }
    }
    const prev = store.getState().selection;
    if (selectionControlled) {
      // controlled selection is host-owned — commands SKIP recording.
      const groupsChanged = !sameIds(prev.groupIds, next.groupIds);
      if (!sameIds(prev.edgeIds, next.edgeIds) || groupsChanged) {
        publish({
          selection: { nodeIds: prev.nodeIds, edgeIds: next.edgeIds, groupIds: next.groupIds },
        });
        if (groupsChanged) {
          // the group namespace stays instance-owned even under
          // controlled node selection — mirror its highlight immediately.
          const eng = engineIfReady();
          if (eng !== null) pushSelectionToEngine(eng, prev.nodeIds);
        }
      }
      emit('selectionChange', next);
      return;
    }
    if (sameSelection(prev, next)) return;
    // one implicit single-command transaction per mutator call.
    historyKernel.record('selection', selectionPlain(prev), selectionPlain(next));
    publish({ selection: next });
    const eng = engineIfReady();
    if (
      eng !== null &&
      (!sameIds(prev.nodeIds, next.nodeIds) || !sameIds(prev.groupIds, next.groupIds))
    ) {
      // selection survival: ALL selected indices are pushed even when
      // the mask hides some — engine greyout handles hidden ones and masked
      // selected ids remain in SelectionState while masked.
      pushSelectionToEngine(eng, next.nodeIds);
    }
    emit('selectionChange', next);
  }

  function setSelection(input: readonly NodeId[] | SelectionState): void {
    if (destroyed) return;
    if (Array.isArray(input)) {
      selectNodes(input as readonly NodeId[]);
      return;
    }
    const full = input as SelectionState;
    applySelectionIntent({
      nodeIds: orderByAcceptedBase(full.nodeIds, nodeIndexBase()),
      edgeIds: orderByAcceptedBase(full.edgeIds, edgeIndexById),
      // Group namespace: the raw full-state form stays TOLERANT (deduped,
      // not validated — pinned legacy behavior); ids that stop naming a
      // resolved group prune through the ownership path whenever the groups
      // RESOLUTION changes. selectGroups is the validating
      // mutator.
      groupIds: dedupeFirstOccurrence(full.groupIds),
    });
  }

  /** canonical group-namespace form: dedupe + validate against the
   * CURRENT resolved groups, stored in groups-array order (the group analog
   * of accepted-base ordering for nodes/edges). */
  function orderGroupIds(ids: readonly string[]): string[] {
    const wanted = new Set(ids);
    const out: string[] = [];
    for (const group of resolvedGroups) {
      if (wanted.has(group.id)) out.push(group.id);
    }
    return out;
  }

  function selectGroups(ids: readonly string[]): void {
    if (destroyed) return;
    const cur = store.getState().selection;
    applySelectionIntent({ ...cur, groupIds: orderGroupIds(ids) });
  }

  function selectNodes(ids: readonly NodeId[]): void {
    if (destroyed) return;
    const cur = store.getState().selection;
    applySelectionIntent({ ...cur, nodeIds: orderByAcceptedBase(ids, nodeIndexBase()) });
  }

  /** a cluster resolves to its MEMBER node ids — clusters
   * never enter the group namespace (they synthesize no entity to select). */
  function selectCluster(key: string, opts?: { additive?: boolean }): void {
    if (destroyed) return;
    const members = clusterDerivation?.membersByKey.get(key);
    if (members === undefined) return;
    const cur = store.getState().selection;
    const next = opts?.additive === true ? unionIds(cur.nodeIds, members) : members;
    applySelectionIntent({ ...cur, nodeIds: orderByAcceptedBase(next, nodeIndexBase()) });
  }

  function selectEdges(ids: readonly EdgeId[]): void {
    if (destroyed) return;
    const cur = store.getState().selection;
    applySelectionIntent({ ...cur, edgeIds: orderByAcceptedBase(ids, edgeIndexById) });
  }

  /**
   * selectNeighbors: expand to the 1-hop neighborhood (seed ∪ direct
   * neighbors). Seeds are the argument id when given, else the current node
   * selection. Uses engine adjacency when the adapter provides it, otherwise
   * a links scan over the current scene.
   */
  function selectNeighbors(id?: NodeId): void {
    if (destroyed || accepted === null || scene === null) return;
    const cur = store.getState().selection;
    const seedIds = id !== undefined ? [id] : cur.nodeIds;
    const result = new Set<NodeId>();
    const seedIndices = new Set<number>();
    for (const sid of seedIds) {
      const idx = scene.indexById.get(sid);
      if (idx === undefined) continue;
      seedIndices.add(idx);
      result.add(sid);
    }
    const eng = engineIfReady();
    const engineAdjacency = eng !== null && eng.neighborIndices !== undefined ? eng : null;
    if (engineAdjacency !== null) {
      for (const idx of seedIndices) {
        for (const n of engineAdjacency.neighborIndices!(idx)) {
          const nid = scene.idByIndex[n];
          if (nid !== undefined) result.add(nid);
        }
      }
    } else {
      const links = scene.links;
      for (let k = 0; k < links.length; k += 2) {
        const s = links[k]!;
        const t = links[k + 1]!;
        if (seedIndices.has(s)) result.add(scene.idByIndex[t]!);
        if (seedIndices.has(t)) result.add(scene.idByIndex[s]!);
      }
    }
    applySelectionIntent({
      ...cur,
      nodeIds: orderByAcceptedBase([...result], accepted.nodeIndex),
    });
  }

  function selectAll(): void {
    if (destroyed) return;
    const cur = store.getState().selection;
    applySelectionIntent({ ...cur, nodeIds: selectablePopulation() });
  }

  function invertSelection(): void {
    if (destroyed) return;
    const cur = store.getState().selection;
    const selected = new Set(cur.nodeIds);
    applySelectionIntent({
      ...cur,
      nodeIds: selectablePopulation().filter((id) => !selected.has(id)),
    });
  }

  function clearSelection(): void {
    if (destroyed) return;
    applySelectionIntent(EMPTY_SELECTION);
  }

  /**
   * lasso: engine polygon query → indices → ids, hidden ids
   * dropped, then replace/union through applySelectionIntent — the SAME
   * ownership path as every other mutator (controlled → intent only).
   */
  function selectWithinPolygon(
    screenPolygon: readonly [number, number][],
    opts?: { additive?: boolean },
  ): readonly NodeId[] {
    if (destroyed || accepted === null || scene === null) return EMPTY_IDS;
    const eng = engineIfReady();
    if (eng === null || eng.pointsInPolygon === undefined) return EMPTY_IDS;
    const indices = eng.pointsInPolygon(screenPolygon);
    const hidden = store.getState().hiddenNodeIds;
    const ids: NodeId[] = [];
    for (const idx of indices) {
      if (!maskNodeVisibleAt(idx)) continue; // mask-hidden never lassoed
      const id = scene.idByIndex[idx];
      if (id !== undefined && !hidden.has(id)) ids.push(id);
    }
    const resolved = orderByAcceptedBase(ids, accepted.nodeIndex);
    const cur = store.getState().selection;
    applySelectionIntent({
      ...cur,
      nodeIds:
        opts?.additive === true
          ? orderByAcceptedBase(unionIds(cur.nodeIds, resolved), accepted.nodeIndex)
          : resolved,
    });
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Hide / pin slices. Hidden nodes are VISUALLY masked through
  // the 'hidden' mask source (alpha 0, buffers-only commit, zero
  // relayout) and excluded from the selectAll/invert population.
  // -------------------------------------------------------------------------

  /** Shared hidden-slice write: history record + mask refresh + ONE publish
   * (ONE buffers-only commit through the fast path). */
  function applyHiddenSlice(prevHidden: ReadonlySet<NodeId>, next: Set<NodeId>): void {
    historyKernel.record('hidden', [...prevHidden], [...next]);
    if (scene !== null && (next.size > 0 || softMask !== null)) {
      ensureMask();
      refreshHiddenMembership(next);
      refreshGroupMaskMembership(next);
      cascadeNodeMask();
    }
    refreshCrossfilterExternalMask(next); // dual layer stays fresh
    publishMaskFastPath({ hiddenNodeIds: next }, false);
  }

  function hideNodes(ids: readonly NodeId[]): void {
    if (destroyed || accepted === null) return;
    const prev = store.getState().hiddenNodeIds;
    let next: Set<NodeId> | null = null;
    for (const id of ids) {
      if (!accepted.nodeIndex.has(id) || (next ?? prev).has(id)) continue;
      if (next === null) next = new Set(prev);
      next.add(id);
    }
    if (next !== null) applyHiddenSlice(prev, next);
  }

  function showNodes(ids: readonly NodeId[]): void {
    if (destroyed) return;
    const prev = store.getState().hiddenNodeIds;
    let next: Set<NodeId> | null = null;
    for (const id of ids) {
      if (!(next ?? prev).has(id)) continue;
      if (next === null) next = new Set(prev);
      next.delete(id);
    }
    if (next !== null) applyHiddenSlice(prev, next);
  }

  function showAll(): void {
    if (destroyed) return;
    const prev = store.getState().hiddenNodeIds;
    if (prev.size > 0) applyHiddenSlice(prev, new Set());
  }

  /** Last known position of a node: live engine readback when ready, else the
   * reconciled scene cache; undefined when no finite position is known. */
  function currentPositionOf(id: NodeId): readonly [number, number] | undefined {
    if (scene === null) return undefined;
    const idx = scene.indexById.get(id);
    if (idx === undefined) return undefined;
    const eng = engineIfReady();
    if (eng !== null) {
      const pos = eng.getPositions();
      if (pos !== null) {
        const x = pos[2 * idx];
        const y = pos[2 * idx + 1];
        if (x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y)) {
          return [x, y];
        }
      }
    }
    const sx = scene.positions[2 * idx]!;
    const sy = scene.positions[2 * idx + 1]!;
    return Number.isFinite(sx) && Number.isFinite(sy) ? [sx, sy] : undefined;
  }

  /** Shared pin write path (pinNode and the built-in drag-pin follow-up). */
  function writePin(id: NodeId, xy: readonly [number, number]): void {
    const prev = store.getState().pins;
    const existing = prev.get(id);
    if (existing !== undefined && existing[0] === xy[0] && existing[1] === xy[1]) return;
    const next = new Map(prev);
    next.set(id, [xy[0], xy[1]] as const);
    historyKernel.record('pins', pinsPlain(prev), pinsPlain(next));
    publish({ pins: next });
    const eng = engineIfReady();
    if (eng !== null) {
      pushPinsToEngine(eng, next);
      // Single-point cache write: bank a per-event readback with
      // the pin overlay applied (the just-written pin included) so the pinned
      // position survives structural swaps before the next settle.
      const pos = eng.getPositions();
      if (pos !== null) bankEnginePositions(pos);
    }
  }

  function pinNode(id: NodeId, xy?: readonly [number, number]): void {
    if (destroyed || accepted === null || !accepted.nodeIndex.has(id)) return;
    const p = xy ?? currentPositionOf(id);
    if (p === undefined) return; // no known position to pin at
    writePin(id, p);
  }

  function unpinNode(id: NodeId): void {
    if (destroyed) return;
    const prev = store.getState().pins;
    if (!prev.has(id)) return;
    const next = new Map(prev);
    next.delete(id);
    historyKernel.record('pins', pinsPlain(prev), pinsPlain(next));
    publish({ pins: next });
    const eng = engineIfReady();
    if (eng !== null) pushPinsToEngine(eng, next);
  }

  function clearPins(): void {
    if (destroyed) return;
    const prev = store.getState().pins;
    if (prev.size === 0) return;
    historyKernel.record('pins', pinsPlain(prev), []);
    publish({ pins: new Map() });
    const eng = engineIfReady();
    if (eng !== null) pushPinsToEngine(eng, EMPTY_PINS);
  }

  // -------------------------------------------------------------------------
  // persistent pins — the pinnedNodeIds slice mutators,
  // the latch mirror of groups. Persistent pins hold nodes AT THEIR CURRENT
  // POSITION via engine.setPinnedIndices — v0.10 carries NO position payload
  // (positions keep riding the engine/readback caches; only the drag-pin
  // `pins` slice is coordinate-authoritative). Lifecycles are independent:
  // the engine receives the UNION, so releasing a drag pin on a
  // persistently-pinned node leaves it pinned. Uncontrolled op
  // writes route through applyHostUpdateInner (the SAME validate → prune →
  // publish lane as the prop: one publish, zero engine commits) and record
  // 'pinnedNodes' steps; controlled ops fire the 'pinnedChange'
  // intent instead of writing (the host reflects the array back).
  // -------------------------------------------------------------------------

  /** Apply (uncontrolled) or intend (controlled) a persistent-pin candidate. */
  function commitPinnedCandidate(candidate: readonly NodeId[]): void {
    if (pinnedControlled) {
      emit('pinnedChange', { pinnedNodeIds: candidate });
      return;
    }
    pinsInternalWrite = true;
    try {
      applyHostUpdateInner({ pinnedNodeIds: candidate });
    } finally {
      pinsInternalWrite = false;
    }
    emit('pinnedChange', { pinnedNodeIds: [...store.getState().pinnedNodeIds] });
  }

  function pinNodes(ids: readonly NodeId[]): void {
    if (destroyed) return;
    acceptanceQueue.admit(() => {
      if (accepted === null) return;
      const cur = store.getState().pinnedNodeIds;
      const next = new Set(cur);
      for (const id of ids) {
        if (accepted.nodeIndex.has(id)) next.add(id); // unknown ids drop
      }
      if (next.size === cur.size) return; // exact no-op (all known ∈ cur)
      commitPinnedCandidate([...next]);
    });
  }

  function unpinNodes(ids: readonly NodeId[]): void {
    if (destroyed) return;
    acceptanceQueue.admit(() => {
      const cur = store.getState().pinnedNodeIds;
      const next = new Set(cur);
      for (const id of ids) next.delete(id);
      if (next.size === cur.size) return; // exact no-op (nothing was pinned)
      commitPinnedCandidate([...next]);
    });
  }

  // -------------------------------------------------------------------------
  // group operations — the groups slice mutators.
  // Every op runs inside the acceptance queue (same admission order as host
  // updates). Uncontrolled writes route the candidate array through
  // applyHostUpdateInner — the SAME validate → resolve → rewrite lane as the
  // `groups` prop, so an op is one publish and at most one diff-scale
  // commit. Group ops are host-config statements, not history
  // dimensions — they never record undo entries (like the prop lane).
  // -------------------------------------------------------------------------

  /** ONE 'config-error' verdict for a rejected group op (its own single
   * publish); replaced per rejection, cleared by the next applied write. */
  function rejectGroupOp(severity: 'warning' | 'error', message: string, sampleId?: string): void {
    groupsOpDiags = [
      {
        code: 'config-error',
        severity,
        count: 1,
        sampleIds: sampleId !== undefined ? [sampleId] : [],
        message,
      },
    ];
    publish({ diagnostics: composeDiagnostics() });
  }

  /** Op write path: routes the candidate through applyHostUpdateInner
   * WITHOUT flipping ownership (internal writes are not host writes). */
  function writeGroupsInternal(candidate: readonly GroupSpec[] | null): void {
    groupsInternalWrite = true;
    try {
      applyHostUpdateInner({ groups: candidate });
    } finally {
      groupsInternalWrite = false;
    }
  }

  /** apply (uncontrolled) or intend (controlled) a validated manual
   * candidate. Controlled mode never writes — the resolved candidate rides
   * the 'groupsChange' intent and the host reflects it back via the prop. */
  function commitManualGroups(candidate: readonly GroupSpec[] | null): void {
    if (groupsControlled) {
      const resolved =
        candidate === null || accepted === null
          ? EMPTY_GROUPS
          : resolveManualGroups(candidate, accepted.nodeIndex);
      emit('groupsChange', { groups: resolved });
      return;
    }
    writeGroupsInternal(candidate);
    emit('groupsChange', { groups: resolvedGroups });
  }

  function groupNodes(spec: GroupSpec): void {
    if (destroyed) return;
    acceptanceQueue.admit(() => {
      if (groupBySpec !== null) {
        // membership under groupBy is derived and READ-ONLY.
        if (DEV) {
          rejectGroupOp(
            'warning',
            'groupNodes ignored: membership is derived and read-only under groupBy — change the groupBy accessor or remove it',
            spec.id,
          );
        }
        return;
      }
      const candidate = [...(groupsSpec ?? EMPTY_GROUP_SPECS), spec];
      // Same acyclic/singly-parented boundary as the prop lane (D4): a violating spec
      // (duplicate id included) is ONE 'config-error' and changes nothing.
      const verdict = validateGroupSpecs(candidate, accepted?.nodeIndex ?? null);
      if (verdict.diagnostic !== null) {
        groupsOpDiags = [verdict.diagnostic];
        publish({ diagnostics: composeDiagnostics() });
        return;
      }
      commitManualGroups(candidate);
    });
  }

  function ungroup(groupId: string): void {
    if (destroyed) return;
    acceptanceQueue.admit(() => {
      if (groupBySpec !== null) {
        if (DEV) {
          rejectGroupOp(
            'warning',
            'ungroup ignored: membership is derived and read-only under groupBy — change the groupBy accessor or remove it',
            groupId,
          );
        }
        return;
      }
      const specs = groupsSpec ?? EMPTY_GROUP_SPECS;
      const candidate = specs.filter((s) => s.id !== groupId);
      if (candidate.length === specs.length) {
        if (DEV) {
          rejectGroupOp('warning', `ungroup ignored: no group '${groupId}' is defined`, groupId);
        }
        return;
      }
      commitManualGroups(candidate.length === 0 ? null : candidate);
    });
  }

  function setGroupCollapsed(groupId: string, collapsed: boolean): void {
    if (destroyed) return;
    acceptanceQueue.admit(() => {
      if (groupBySpec !== null) {
        if (groupsSpec !== null) {
          // conflict active — NEITHER lane applies, so no group
          // is addressable until the host removes one.
          if (DEV) {
            rejectGroupOp(
              'warning',
              'setGroupCollapsed ignored: groups and groupBy are both configured — remove one',
              groupId,
            );
          }
          return;
        }
        // THE allowed op under groupBy — toggle the per-KEY
        // collapsed residue; membership stays derived and read-only.
        // Always instance-owned (groupBy has uncontrolled semantics); the
        // inner update below emits the 'groupsChange' notification.
        const key = groupByKeyById.get(groupId);
        if (key === undefined) {
          if (DEV) {
            rejectGroupOp(
              'warning',
              `setGroupCollapsed ignored: no derived group '${groupId}' in the current derivation`,
              groupId,
            );
          }
          return;
        }
        if (groupByCollapsedKeys.has(key) === collapsed) return; // exact no-op
        if (collapsed) groupByCollapsedKeys.add(key);
        else groupByCollapsedKeys.delete(key);
        if (groupsOpDiags.length > 0) {
          // A stale rejected-op verdict clears with this applied write.
          groupsOpDiags = [];
          pendingDiagnosticsRefresh = true;
        }
        pendingGroupsRefresh = true;
        applyHostUpdateInner({});
        return;
      }
      const specs = groupsSpec ?? EMPTY_GROUP_SPECS;
      const idx = specs.findIndex((s) => s.id === groupId);
      if (idx < 0) {
        if (DEV) {
          rejectGroupOp(
            'warning',
            `setGroupCollapsed ignored: no group '${groupId}' is defined`,
            groupId,
          );
        }
        return;
      }
      if ((specs[idx]!.collapsed === true) === collapsed) return; // exact no-op
      const candidate = specs.map((s, i) => (i === idx ? { ...s, collapsed } : s));
      commitManualGroups(candidate);
    });
  }

  // -------------------------------------------------------------------------
  // node folds (see the interface docs). A fold is a stage-3
  // containment change, so it rides the SAME lane as a group collapse: set
  // the dirty flag, run one inner update, let the rewrite + diff do the
  // rest. Unlike group ops, folds ARE a history dimension — they are
  // exploration state the user builds up, like expansion records.
  // -------------------------------------------------------------------------

  /** Serializable 'folds'-slice payload: the anchor→members map as
   * ordered pairs (Map iteration order is insertion order, so a restore
   * reproduces the anchor ordering the scene suffix depends on). */
  function foldsStatePlain(): [NodeId, NodeId[]][] {
    return [...folds].map(([anchorId, memberIds]) => [anchorId, [...memberIds]]);
  }

  /**
   * The published `store.folds` image (anchor → member count) when it differs
   * from `prevFolds`, else null. Folds must reach the store because they
   * change no id and no label text, so nothing else would tell a subscriber
   * that a badge is stale (label lane re-renders on candidate-SET changes
   * only).
   */
  function foldCountsIfChanged(
    prevFolds: ReadonlyMap<NodeId, number>,
  ): ReadonlyMap<NodeId, number> | null {
    if (folds.size === 0) return prevFolds.size === 0 ? null : EMPTY_FOLD_COUNTS;
    if (prevFolds.size === folds.size) {
      let same = true;
      for (const [anchorId, memberIds] of folds) {
        if (prevFolds.get(anchorId) !== memberIds.length) {
          same = false;
          break;
        }
      }
      if (same) return null;
    }
    const next = new Map<NodeId, number>();
    for (const [anchorId, memberIds] of folds) next.set(anchorId, memberIds.length);
    return next;
  }

  /** Every entity standing above `id` in the current forest — the cycle
   * guard for an explicit `memberIds` fold. */
  function foldAncestorsOf(id: NodeId): Set<NodeId> {
    const out = new Set<NodeId>();
    for (const [anchorId, memberIds] of folds) {
      for (const member of memberIds) {
        if (member === id) out.add(anchorId);
      }
    }
    // Walk transitively: an anchor may itself be someone's member.
    let frontier = [...out];
    while (frontier.length > 0) {
      const next: NodeId[] = [];
      for (const [anchorId, memberIds] of folds) {
        if (out.has(anchorId)) continue;
        for (const member of memberIds) {
          if (frontier.includes(member)) {
            out.add(anchorId);
            next.push(anchorId);
            break;
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  /** Distinct neighbours of `id` in `model`, in first-encounter edge order
   * (deterministic default fold membership). One O(E) scan — a fold is a
   * user gesture, not a hot path, and this reads the SCOPED render model
   * rather than the accepted-model adjacency cache. */
  function modelNeighborsOf(model: AcceptedGraph<N, E>, id: NodeId): NodeId[] {
    const out: NodeId[] = [];
    const seen = new Set<NodeId>();
    for (const edge of model.edges) {
      const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null;
      if (other === null || other === id || seen.has(other)) continue;
      seen.add(other);
      out.push(other);
    }
    return out;
  }

  /** Ids already claimed by some representative (fold member or group
   * member) — the "first claim wins" test `foldNode` applies. */
  function claimedByFold(): Set<NodeId> {
    const out = new Set<NodeId>();
    for (const memberIds of folds.values()) {
      for (const member of memberIds) out.add(member);
    }
    return out;
  }

  /**
   * Shared tail: publish a fold mutation as ONE structural update, holding
   * placed survivors still while the layout re-settles (the accretion pin
   * lane — removing rows changes the force balance, which would otherwise let
   * the remainder lurch).
   *
   * Gated on `force` exactly like the expansion path: under a FIXED layout
   * nothing settles, so pinning the whole roster is a pointless engine call
   * that also perturbs the positions a fold/unfold round trip should restore
   * byte-for-byte.
   */
  function commitFoldChange(beforeState: [NodeId, NodeId[]][]): void {
    historyKernel.record('folds', beforeState, foldsStatePlain());
    if (layout === 'force' && scene !== null) accretionPinIds = new Set(scene.idByIndex);
    pendingFoldsRefresh = true;
    applyHostUpdateInner({});
  }

  function foldNode(id: NodeId, opts?: { memberIds?: readonly NodeId[] }): void {
    if (destroyed) return;
    acceptanceQueue.admit(() => {
      if (accepted === null || folds.has(id)) return;
      const model = renderModel();
      if (model === null || !model.nodeIndex.has(id)) return;
      const claimed = claimedByFold();
      if (claimed.has(id)) return; // the anchor is itself hidden — nothing to fold
      const members: NodeId[] = [];
      const seen = new Set<NodeId>();
      if (opts?.memberIds !== undefined) {
        const ancestors = foldAncestorsOf(id);
        for (const member of opts.memberIds) {
          if (member === id || seen.has(member) || claimed.has(member)) continue;
          if (!model.nodeIndex.has(member)) continue;
          if (ancestors.has(member)) continue; // would close a cycle
          seen.add(member);
          members.push(member);
        }
      } else {
        for (const nid of modelNeighborsOf(model, id)) {
          if (nid === id || seen.has(nid) || claimed.has(nid)) continue;
          seen.add(nid);
          members.push(nid);
        }
      }
      if (members.length === 0) return; // exact no-op
      const beforeState = foldsStatePlain();
      folds.set(id, members);
      commitFoldChange(beforeState);
    });
  }

  function unfoldNode(id: NodeId): void {
    if (destroyed) return;
    acceptanceQueue.admit(() => {
      if (!folds.has(id)) return; // exact no-op
      const beforeState = foldsStatePlain();
      folds.delete(id);
      commitFoldChange(beforeState);
    });
  }

  function getFold(id: NodeId): { memberIds: readonly NodeId[] } | null {
    const memberIds = folds.get(id);
    return memberIds === undefined ? null : { memberIds: [...memberIds] };
  }

  // -------------------------------------------------------------------------
  // Revisioned ingestion. All session work is
  // serialized through `acceptanceQueue`; only queue jobs publish state.
  // -------------------------------------------------------------------------

  /** MergeBase for the current accepted base (callers guarantee a base). */
  function currentMergeBase(): MergeBase<N, E> {
    const b = baseFromAccepted(baseAccepted!);
    return basePendingEdges.length > 0 ? { ...b, pendingEdges: basePendingEdges } : b;
  }

  function generateOverlayId(): string {
    for (;;) {
      const id = `overlay-${++overlayIdSeq}`;
      if (reservedOverlayIds.has(id)) continue;
      let taken = false;
      for (const s of openSessions) {
        if (s.overlayId === id) {
          taken = true;
          break;
        }
      }
      if (!taken) return id;
    }
  }

  function cancelFlushTimer(rec: IngestSessionRecord<N, E>): void {
    if (rec.flushTimer !== null) {
      clearTimeout(rec.flushTimer);
      rec.flushTimer = null;
    }
  }

  /**
   * Settle every unflushed entry after a publication (or a non-publishing
   * commit path). `revision` null = the rows never became public (idempotent
   * replace replay), so no publishedModelRevision is stamped. `drainAll`
   * zeroes the byte account (commit paths); flushes drain only their batches.
   */
  function settleUnflushed(
    rec: IngestSessionRecord<N, E>,
    revision: number | null,
    drainAll: boolean,
  ): void {
    if (drainAll) {
      rec.pendingBytes = 0;
    } else {
      for (const e of rec.unflushed) rec.pendingBytes -= e.bytes;
      if (rec.pendingBytes < 0) rec.pendingBytes = 0;
    }
    for (const e of rec.unflushed) {
      if (e.settled) continue;
      e.receipt.pendingBytes = rec.pendingBytes;
      if (revision !== null) e.receipt.publishedModelRevision = revision;
      e.settled = true;
      e.resolve(e.receipt);
    }
    rec.unflushed = [];
  }

  /**
   * Terminal abort core. Removes exactly this session's
   * provisional rows via its tag index (the contribution) — never a
   * whole-scene checkpoint — recomputes the accepted base with every other
   * overlay intact, and (when provisional state had become public and
   * `publishRollback`) publishes ONE commit that advances modelRevision.
   * Pending append promises reject with 'aborted'.
   */
  function abortSessionInternal(
    rec: IngestSessionRecord<N, E>,
    cause: unknown,
    publishRollback: boolean,
  ): void {
    if (rec.state !== 'open') return;
    rec.state = 'aborted';
    openSessions.delete(rec);
    cancelFlushTimer(rec);
    const err = new OrbitOperationError(
      { code: 'aborted', cause },
      `orbit ingest session aborted: ${typeof cause === 'string' ? cause : 'aborted'}`,
    );
    for (const e of rec.unflushed) {
      if (!e.settled) {
        e.settled = true;
        e.reject(err);
      }
    }
    rec.unflushed = [];
    if (rec.overlayId !== null && rec.reserved) reservedOverlayIds.delete(rec.overlayId);
    if (rec.published) {
      publishedContributions = publishedContributions.filter((c) => c !== rec.contribution);
      if (publishRollback) {
        const merge = mergeModel(currentMergeBase(), publishedContributions);
        publishIngestModel({ merged: merge.accepted, merge, owner: rec });
      }
    }
  }

  /** for `purpose:'replace'`, any model change not owned by that
   * session — overlay publications included — aborts it. */
  function invalidateReplaceSessions(owner: IngestSessionRecord<N, E> | null): void {
    for (const s of [...openSessions]) {
      if (s === owner || s.purpose !== 'replace') continue;
      abortSessionInternal(s, 'stale-base: the model changed outside the session', false);
    }
  }

  /** A replacing snapshot/session aborts ALL open sessions. */
  function abortAllSessions(except: IngestSessionRecord<N, E> | null, cause: string): void {
    for (const s of [...openSessions]) {
      if (s === except) continue;
      abortSessionInternal(s, cause, false);
    }
  }

  /** Clear every overlay + ingestion bookkeeping (replacing snapshot/session).
   * Returns whether the store's overlayIds slice must be reset. */
  function clearOverlayState(): boolean {
    const hadCommitted = committedOverlayIds.length > 0;
    publishedContributions = [];
    committedOverlayIds = EMPTY_OVERLAY_IDS;
    reservedOverlayIds.clear();
    ingestMergeDiags = [];
    ingestCommitDiags = [];
    // expansion overlays died with the rest — drop their bookkeeping
    // and the scope accretion they revealed (the SubgraphSpec itself is
    // per-dataset state and survives a same-dataset replace).
    expansionOverlays.clear();
    scopeExtraIds.clear();
    return hadCommitted;
  }

  /**
   * Reconcile invalidation: drop expansion records
   * referencing nodes removed from the accepted snapshot — a record whose
   * expandedId or ANY addedNodeIds departed is invalidated (its collapse
   * exceptions can no longer be evaluated against the model that produced
   * it). Exclusions for departed ids prune as hygiene. Runs on every
   * accepted-model publication (declarative data branch + ingestion path).
   */
  function invalidateExpansionRecords(): void {
    if (accepted === null) {
      expansionRecords = [];
      effectiveRemovedIds.clear();
      return;
    }
    const index = accepted.nodeIndex;
    if (expansionRecords.length > 0) {
      expansionRecords = expansionRecords.filter(
        (r) => index.has(r.expandedId) && r.addedNodeIds.every((nid) => index.has(nid)),
      );
    }
    if (effectiveRemovedIds.size > 0) {
      for (const id of effectiveRemovedIds) {
        if (!index.has(id)) effectiveRemovedIds.delete(id);
      }
    }
    pruneFolds(index);
  }

  /**
   * fold hygiene on an accepted-model publication: an anchor that left
   * the model drops its fold outright (nothing is standing there to stand
   * for anything), and a surviving anchor drops departed members. A fold
   * left with no members is deleted rather than kept as an empty husk, so
   * `getFold` never reports a fold that draws nothing.
   */
  function pruneFolds(index: ReadonlyMap<NodeId, number>): void {
    if (folds.size === 0) return;
    for (const [anchorId, memberIds] of folds) {
      if (!index.has(anchorId)) {
        folds.delete(anchorId);
        continue;
      }
      const kept = memberIds.filter((id) => index.has(id));
      if (kept.length === memberIds.length) continue;
      if (kept.length === 0) folds.delete(anchorId);
      else folds.set(anchorId, kept);
    }
  }

  /** Serializable snapshot of the effective-set state (the
   * 'expansion' slice payload): record stack + collapse exclusions +
   * scope accretion. `extraRemoved` folds ids into the exclusion image
   * WITHOUT mutating state — the expansion step's BEFORE-image excludes its
   * own revealed ids, because overlay DATA persists across an undo
   * and restoring the pre-expansion effective set means hiding them. */
  function expansionStatePlain(extraRemoved: readonly NodeId[] = EMPTY_IDS): ExpansionStatePlain {
    const removed = new Set(effectiveRemovedIds);
    for (const id of extraRemoved) removed.add(id);
    return {
      records: expansionRecords.map((r) => ({
        expandedId: r.expandedId,
        addedNodeIds: [...r.addedNodeIds],
        overlayId: r.overlayId,
      })),
      removed: [...removed],
      extras: [...scopeExtraIds],
    };
  }

  /** a datasetKey swap invalidates every in-flight expansion — the old
   * dataset's requests are aborted destroy-style (their caller promises
   * reject 'aborted'; the admission gate would discard any late result
   * anyway) and the ledger empties so the swap publication can reset the
   * `pendingExpansions` slice. */
  function abortExpansionsForDatasetSwap(): void {
    if (expansionHandles.size === 0 && expansionLedger.size === 0) return;
    const err = new OrbitOperationError(
      { code: 'aborted', cause: 'dataset-changed' },
      'expansion aborted: the datasetKey changed',
    );
    for (const [requestId, handle] of expansionHandles) {
      handle.abort(err);
      expansionRejectors.get(requestId)?.(err);
    }
    expansionHandles.clear();
    expansionRejectors.clear();
    expansionPromises.clear();
    for (const id of expansionLedger.ids()) expansionLedger.abort(id);
  }

  interface IngestPublication {
    merged: AcceptedGraph<N, E>;
    merge: MergeResult<N, E>;
    /** The session owning this change (skipped by replace invalidation). */
    owner: IngestSessionRecord<N, E> | null;
    /** Replace commit establishing a NEW datasetKey: per-dataset state clears. */
    datasetChanged?: boolean;
    /** Replace commit: revisions.source moves to the merged sourceRevision. */
    sourceChanged?: boolean;
    /** New committed-overlay id list, when it changed. */
    overlayIds?: readonly string[];
  }

  /**
   * The single ingestion publication path (flushes, atomic commits, rollback,
   * overlay removal): mirrors applyHostUpdate's data branch — banks live
   * positions, reconciles the merged model, advances model/scope (+render
   * when a commit is needed), prunes interaction slices, issues at most one
   * engine commit, and publishes exactly one store set.
   */
  function publishIngestModel(p: IngestPublication): void {
    const prev = store.getState();
    const datasetChanged = p.datasetChanged === true;
    if (datasetChanged) {
      // new dataset — position caches, engine diagnostics, hard scope,
      // expansion bookkeeping, mask state, history, timeline playback,
      // domain freezes, metric columns, and atlas state do not carry over.
      reconciler = new Reconciler();
      engineDiags = [];
      scopeSpec = null;
      scopeExtraIds.clear();
      expansionOverlays.clear();
      abortExpansionsForDatasetSwap();
      abortSearchFlight('dataset-changed', 'search aborted: the datasetKey changed');
      resetMaskState();
      historyKernel.clear();
      stopTimelineTimer();
      timelinePlayingKey = null;
      domainStore.clear();
      metricColumnGen.clear();
      metricDiags = [];
      churnDiags = [];
      resetImagePipelineState();
      // The groupBy collapsed residue is per-dataset state.
      groupByCollapsedKeys.clear();
      semanticZoomBand = null; // re-establish on the next threshold crossing
      // Records + collapse exclusions are per-dataset state.
      expansionRecords = [];
      effectiveRemovedIds.clear();
    } else {
      // bank live engine positions so they survive the structural swap.
      const engBank = engineIfReady();
      if (engBank !== null && scene !== null) {
        const pos = engBank.getPositions();
        if (pos !== null) bankEnginePositions(pos);
      }
    }
    accepted = p.merged;
    // This publication invalidates expansion records
    // referencing nodes the merged snapshot no longer contains (replace
    // commits, overlay removals, rollbacks).
    invalidateExpansionRecords();
    edgeIndexById = new Map(p.merged.edges.map((e, k) => [e.id, k] as const));
    adjacency = null;
    sceneIncidence = null;
    acceptedAdjacency = null;
    // mirrors the revisions.model advance below — the MetricStore and
    // DomainStore freeze coordinate moves with the accepted model.
    acceptedModelSeq += 1;
    // a model change re-resolves the hard scope; ONLY the scoped subset
    // feeds the reconciler using the position caches.
    scopedAccepted = computeScopedAccepted();
    // the accepted model changed — store.groups re-resolves (departed
    // members drop) and stage 3 re-runs over the fresh scope in the SAME
    // publication.
    const groupsResolutionChanged = refreshGroupsResolution();
    const result = reconcileScene(scopedAccepted ?? p.merged);
    const ingestScene = scene!;
    labelPositionCache = null;
    const structuralChange = result.structuralChange;
    const positionChange = result.positionChange;
    dataDiags = p.merged.diagnostics;
    ingestMergeDiags = mergeDiagnostics(p.merge);

    // Interaction slices: a dataset change clears; a model change prunes
    // departed ids (overlay removal / rollback may remove nodes). Computed
    // BEFORE projection so mask memberships rebuild against the kept set.
    let nextSelection = prev.selection;
    let nextHidden = prev.hiddenNodeIds;
    let nextPins = prev.pins;
    let nextPinned = prev.pinnedNodeIds;
    if (datasetChanged) {
      nextSelection = EMPTY_SELECTION;
      nextHidden = EMPTY_HIDDEN;
      nextPins = EMPTY_PINS;
      nextPinned = EMPTY_PINNED;
    } else {
      const prunedNodes = pruneIds(nextSelection.nodeIds, p.merged.nodeIndex);
      const prunedEdges = pruneIds(nextSelection.edgeIds, edgeIndexById);
      if (prunedNodes !== nextSelection.nodeIds || prunedEdges !== nextSelection.edgeIds) {
        nextSelection = {
          nodeIds: prunedNodes,
          edgeIds: prunedEdges,
          groupIds: nextSelection.groupIds,
        };
      }
      let anyHiddenDropped = false;
      for (const id of nextHidden) {
        if (!p.merged.nodeIndex.has(id)) {
          anyHiddenDropped = true;
          break;
        }
      }
      if (anyHiddenDropped) {
        const kept = new Set<NodeId>();
        for (const id of nextHidden) if (p.merged.nodeIndex.has(id)) kept.add(id);
        nextHidden = kept;
      }
      let anyPinDropped = false;
      for (const id of nextPins.keys()) {
        if (!p.merged.nodeIndex.has(id)) {
          anyPinDropped = true;
          break;
        }
      }
      if (anyPinDropped) {
        const kept = new Map<NodeId, readonly [number, number]>();
        for (const [id, xy] of nextPins) if (p.merged.nodeIndex.has(id)) kept.set(id, xy);
        nextPins = kept;
      }
      // persistent pins prune departed ids through ownership.
      let anyPinnedDropped = false;
      for (const id of nextPinned) {
        if (!p.merged.nodeIndex.has(id)) {
          anyPinnedDropped = true;
          break;
        }
      }
      if (anyPinnedDropped) {
        const kept = new Set<NodeId>();
        for (const id of nextPinned) if (p.merged.nodeIndex.has(id)) kept.add(id);
        nextPinned = kept;
      }
      // A changed groups resolution prunes selected group ids
      // that no longer name a resolved group (same rule as applyHostUpdate).
      if (groupsResolutionChanged && nextSelection.groupIds.length > 0) {
        const keep = new Set<string>();
        for (const group of resolvedGroups) keep.add(group.id);
        const prunedGroupIds = nextSelection.groupIds.filter((id) => keep.has(id));
        if (prunedGroupIds.length !== nextSelection.groupIds.length) {
          nextSelection = { ...nextSelection, groupIds: prunedGroupIds };
        }
      }
    }
    const selectionChanged = !sameSelection(nextSelection, prev.selection);
    const selectedNodesChanged = !sameIds(nextSelection.nodeIds, prev.selection.nodeIds);
    const hiddenChanged = nextHidden !== prev.hiddenNodeIds;
    const pinsChanged = nextPins !== prev.pins;
    const pinnedChanged = nextPinned !== prev.pinnedNodeIds;
    const hoverCleared =
      datasetChanged && (prev.hover.nodeId !== null || prev.hover.edgeId !== null);

    // keep the crossfilter engine in sync with the accepted model
    // an id-stable prefix extension (overlay flush ADD rows) APPENDS without
    // a rebuild; anything else replaces (brushes preserved by key); a
    // dataset change rebuilds (brushes cleared).
    if (crossfilterEngine !== null) {
      syncCrossfilterModel(datasetChanged);
    } else if (crossfilterSpecs !== null) {
      // The crossfilter prop landed BEFORE any data (e.g. a fresh instance
      // that will be fed by a replace IngestSession — the demo's stream
      // mode): build over the first accepted model now. D3: a failed build
      // drops the unusable specs (diagnostic already recorded).
      if (!buildCrossfilterEngine()) crossfilterSpecs = null;
    }
    // slot indices shifted — rebuild every mask membership from its
    // definition BEFORE projection so the buffers below compose the mask.
    rebuildMaskMemberships(nextHidden);
    refreshCrossfilterExternalMask(nextHidden);

    const buffers = projectChannelBuffers({
      nodeColor: true,
      nodeSize: true,
      linkColor: true,
      linkWidth: true,
    });
    let structure: EngineCommit['structure'] | undefined;
    if (structuralChange || positionChange) {
      structure = {
        pointCount: ingestScene.count,
        positions: ingestScene.positions,
        links: ingestScene.links,
      };
    }
    const commitNeeded = structure !== undefined || buffers !== undefined;

    const revisions: Revisions = { ...prev.revisions };
    revisions.model += 1;
    revisions.scope += 1;
    if (p.sourceChanged === true) revisions.source = p.merged.sourceRevision;
    if (commitNeeded) revisions.render += 1;

    const eng = engineIfReady();
    let simRestarted = false;
    let imageRefsPushed = false;
    if (commitNeeded && eng !== null) {
      const commit: EngineCommit = { revision: revisions.render };
      if (structure !== undefined) {
        commit.structure = structure;
        // The structural commit carries the roster's OWN
        // point→slot index (placeholders where undelivered).
        const syncIndex = structuralPointImageIndex();
        if (syncIndex !== null) commit.resources = { pointImageIndex: syncIndex };
        imageRefsPushed = true;
      }
      if (buffers !== undefined) commit.buffers = buffers;
      if (structure !== undefined && layout === 'force') {
        commit.restart = { alpha: 1 };
        simRestarted = true;
      }
      commitToEngine(eng, commit);
      revisions.appliedRender = eng.appliedRevision();
      const facade = session !== null ? session.edgePicking : null;
      if (facade !== null) {
        if (commit.restart !== undefined && commit.restart !== false) facade.disarm();
        else if (structure !== undefined) facade.arm(ingestScene.positions, ingestScene.links);
      }
    }

    // the accepted-model roster changed — re-feed the atlas ref lane
    // (already done inside the structural commit above when one was sent).
    if (!imageRefsPushed) pushImageRefs();

    const labelRerank = recomputeCandidates();

    const patch: Partial<GraphStoreState> = {
      revisions,
      // Counts are ACCEPTED-MODEL counts; the scene may be scoped.
      nodeCount: p.merged.nodes.length,
      edgeCount: p.merged.edges.length,
      diagnostics: composeDiagnostics(),
    };
    const nextVisible = computeVisibleCounts();
    if (!sameVisible(nextVisible, prev.visible)) patch.visible = nextVisible;
    if (datasetChanged && prev.timeline.playingKey !== null) {
      patch.timeline = { playingKey: null };
    }
    if (p.overlayIds !== undefined) patch.overlayIds = p.overlayIds;
    if (datasetChanged && prev.scope !== null) patch.scope = null;
    if (datasetChanged && prev.pendingExpansions.size > 0) {
      patch.pendingExpansions = EMPTY_EXPANSIONS;
    }
    // the search slice is per-dataset — a swap clears it.
    if (datasetChanged && prev.search !== null) patch.search = null;
    if (simRestarted && !prev.simulationRunning) patch.simulationRunning = true;
    if (selectionChanged) patch.selection = nextSelection;
    if (hiddenChanged) patch.hiddenNodeIds = nextHidden;
    if (pinsChanged) patch.pins = nextPins;
    if (pinnedChanged) patch.pinnedNodeIds = nextPinned;
    if (hoverCleared) patch.hover = { nodeId: null, edgeId: null };
    if (groupsResolutionChanged) patch.groups = resolvedGroups;
    // pruning may have shrunk or dropped folds on this publication.
    const nextFoldCounts = foldCountsIfChanged(prev.folds);
    if (nextFoldCounts !== null) patch.folds = nextFoldCounts;
    publish(patch);

    // highlight remap + camera, mirroring applyHostUpdate step 9.
    if (eng !== null) {
      if (selectedNodesChanged || (structuralChange && nextSelection.nodeIds.length > 0)) {
        pushSelectionToEngine(eng, nextSelection.nodeIds);
      }
      if (
        pinsChanged ||
        pinnedChanged ||
        (structuralChange && (nextPins.size > 0 || nextPinned.size > 0))
      ) {
        pushPinsToEngine(eng, nextPins); // union sink reads the published slice
      }
      if (structuralChange && emphasizedNodeId !== null && !ingestScene.indexById.has(emphasizedNodeId)) {
        emphasizedNodeId = null; // departed — never resurrect
      }
      if (structuralChange && !hoverCleared && prev.hover.nodeId !== null) {
        const idx = ingestScene.indexById.get(prev.hover.nodeId);
        if (idx !== undefined) applyEmphasis(eng, idx);
      } else if (structuralChange && emphasizedNodeId !== null) {
        const idx = ingestScene.indexById.get(emphasizedNodeId);
        if (idx !== undefined) applyEmphasis(eng, idx);
      }
      if (commitNeeded) maybeFitView(eng);
    }
    if (labelRerank.setChanged) notifyLabelSubs(candidateSubs);

    // a model change re-derived the groupBy array — notify.
    if (groupsResolutionChanged && groupBySpec !== null && groupsSpec === null) {
      emit('groupsChange', { groups: resolvedGroups });
    }

    // this model change aborts open replace sessions it does not own.
    invalidateReplaceSessions(p.owner);
  }

  /** Reserve the session's overlayId at its first append/commit reaching the
   * queue; a conflict terminally rejects the LATER session. Returns
   * the rejection, or null when reserved. */
  function tryReserveOverlayId(rec: IngestSessionRecord<N, E>): Promise<never> | null {
    const id = rec.overlayId!;
    const holder = reservedOverlayIds.get(id);
    if (holder !== undefined && holder !== rec) {
      rec.state = 'aborted';
      openSessions.delete(rec);
      cancelFlushTimer(rec);
      return rejectOperation(
        { code: 'overlay-id-conflict', overlayId: id },
        `overlayId '${id}' is already reserved by an open or committed overlay for this dataset`,
      );
    }
    reservedOverlayIds.set(id, rec);
    rec.reserved = true;
    return null;
  }

  function scheduleFlush(rec: IngestSessionRecord<N, E>): void {
    if (rec.flushTimer !== null || destroyed) return;
    rec.flushTimer = setTimeout(() => {
      rec.flushTimer = null;
      if (destroyed) return;
      acceptanceQueue.admit(() => flushSession(rec));
    }, rec.maxFlushLatencyMs);
  }

  /** Coalesced progressive flush (queue job): at most one per engine-commit
   * turn and no later than maxFlushLatencyMs after the first staged append. */
  function flushSession(rec: IngestSessionRecord<N, E>): void {
    if (rec.state !== 'open') return;
    const c = rec.contribution;
    const hadNewRows = c.nodes.length > c.publicNodeCount || c.edges.length > c.publicEdgeCount;
    if (!hadNewRows && rec.unflushed.length === 0) return;
    c.publicNodeCount = c.nodes.length;
    c.publicEdgeCount = c.edges.length;
    if (!rec.published && (c.publicNodeCount > 0 || c.publicEdgeCount > 0)) {
      publishedContributions.push(c);
      rec.published = true;
    }
    if (hadNewRows) {
      const merge = mergeModel(currentMergeBase(), publishedContributions);
      publishIngestModel({ merged: merge.accepted, merge, owner: rec });
    }
    settleUnflushed(rec, store.getState().revisions.model, false);
  }

  function appendImpl(rec: IngestSessionRecord<N, E>, batch: IngestBatch<N, E>): Promise<AppendReceipt> {
    if (rec.state !== 'open') {
      return rejectOperation(
        { code: 'ingest-session-closed' },
        `append() on a ${rec.state} ingest session`,
      );
    }
    if (rec.purpose === 'overlay' && !rec.reserved) {
      const conflict = tryReserveOverlayId(rec);
      if (conflict !== null) return conflict;
    }
    // sequencing: consecutive, strictly monotonic from zero. An admitted
    // {sequence, batchId} replay returns its ORIGINAL receipt (no
    // reprocessing); the same sequence under a different batchId is a
    // conflict; anything else unseen is a gap/out-of-order rejection. A
    // rejected append consumes neither sequence nor batchId.
    const existing = rec.entries.get(batch.sequence);
    if (existing !== undefined) {
      if (existing.batchId === batch.batchId) return existing.promise;
      return rejectOperation(
        {
          code: 'invalid-ingest-sequence',
          expected: rec.nextSequence,
          received: batch.sequence,
          conflict: true,
        },
        `append(): sequence ${batch.sequence} was already admitted with batchId '${existing.batchId}'`,
      );
    }
    if (batch.sequence !== rec.nextSequence) {
      return rejectOperation(
        {
          code: 'invalid-ingest-sequence',
          expected: rec.nextSequence,
          received: batch.sequence,
          conflict: false,
        },
        `append(): expected sequence ${rec.nextSequence}, received ${batch.sequence}`,
      );
    }
    const bytes = estimateBatchBytes(batch);
    const queuedBytes = rec.pendingBytes + bytes;
    if (rec.atomic && queuedBytes > rec.maxPendingBytes) {
      // Atomic staging cannot drain before commit, so parking this receipt
      // would deadlock the sequential `await append(); ...; await commit()`
      // producer. Reject THIS append only: a rejected append
      // consumes neither its sequence nor batchId and the session stays
      // open, so the caller may commit the staged prefix, retry with a
      // smaller batch, or abort deliberately. A terminal session abort here
      // would contradict the rejected-append rule.
      return rejectOperation(
        { code: 'queue-overflow', queuedBytes, limit: rec.maxPendingBytes },
        `append(): atomic session would queue ${queuedBytes} bytes, exceeding its non-drainable budget of ${rec.maxPendingBytes}; ` +
          `the append was rejected and the session remains open`,
      );
    }
    const overflowLimit = rec.maxPendingBytes * INGEST_OVERFLOW_FACTOR;
    if (bytes > overflowLimit) {
      return rejectOperation(
        { code: 'queue-overflow', queuedBytes: bytes, limit: overflowLimit },
        `append(): batch of ${bytes} bytes exceeds the absolute cap of ${overflowLimit}`,
      );
    }

    // Admission: stage rows into the session tag index, stamped with global
    // admission-order tickets.
    const counts = stageBatch(rec.contribution, batch, rec.tallies, () =>
      acceptanceQueue.nextTicket(),
    );
    rec.nextSequence = batch.sequence + 1;
    rec.pendingBytes += bytes;
    const receipt: AppendReceipt = {
      sequence: batch.sequence,
      batchId: batch.batchId,
      admittedNodes: counts.admittedNodes,
      admittedEdges: counts.admittedEdges,
      pendingBytes: rec.pendingBytes,
    };
    let resolveFn!: (r: AppendReceipt) => void;
    let rejectFn!: (e: unknown) => void;
    const promise = new Promise<AppendReceipt>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    const entry: IngestEntry = {
      batchId: batch.batchId,
      bytes,
      receipt,
      promise,
      resolve: resolveFn,
      reject: rejectFn,
      settled: false,
    };
    rec.entries.set(batch.sequence, entry);

    if (rec.atomic) {
      // The cumulative hard-cap check above guarantees admission stays within
      // budget, so atomic receipts resolve immediately. NOTHING publishes
      // until commit.
      entry.settled = true;
      entry.resolve(receipt);
    } else {
      // Progressive: the receipt resolves after the coalesced flush
      // containing this batch becomes public (publishedModelRevision set).
      rec.unflushed.push(entry);
      scheduleFlush(rec);
    }
    return promise;
  }

  function commitReplace(rec: IngestSessionRecord<N, E>): IngestCommitReceipt {
    const sourceRevision = rec.sourceRevision!;
    const c = rec.contribution;

    // Idempotent replay: a replace commit naming the ALREADY-ACTIVE
    // {datasetKey, sourceRevision} publishes nothing, advances no revision,
    // and does NOT clear overlays — the same protection that keeps ordinary
    // React re-renders from erasing expansion/service results.
    if (
      baseAccepted !== null &&
      baseAccepted.datasetKey === rec.datasetKey &&
      baseAccepted.sourceRevision === sourceRevision
    ) {
      const replayBase = baseFromContribution(rec.datasetKey, sourceRevision, c, []);
      settleUnflushed(rec, null, true);
      return {
        modelRevision: store.getState().revisions.model,
        sourceRevision,
        admittedNodes: c.nodes.length,
        admittedEdges: c.edges.length,
        danglingEdges: replayBase.pendingEdges.length,
      };
    }

    const datasetChanged = baseAccepted !== null && baseAccepted.datasetKey !== rec.datasetKey;
    // A replacing session aborts every other open session and clears every
    // overlay — folded into this commit's single publication.
    abortAllSessions(rec, 'replaced: a replace session committed');
    const overlaysCleared = clearOverlayState();

    const newBase = baseFromContribution(rec.datasetKey, sourceRevision, c, []);
    const commitDiags = sessionCommitDiagnostics(rec.tallies, newBase.pendingEdges.length);
    baseAccepted = {
      datasetKey: rec.datasetKey,
      sourceRevision,
      nodes: newBase.nodes,
      edges: newBase.edges,
      nodeIndex: newBase.nodeIndex,
      diagnostics: commitDiags,
    };
    basePendingEdges = newBase.pendingEdges;
    baseSource = 'session';

    const merge = mergeModel(currentMergeBase(), publishedContributions);
    const pub: IngestPublication = {
      merged: merge.accepted,
      merge,
      owner: rec,
      sourceChanged: true,
    };
    if (datasetChanged) pub.datasetChanged = true;
    if (overlaysCleared) pub.overlayIds = EMPTY_OVERLAY_IDS;
    publishIngestModel(pub);

    const modelRevision = store.getState().revisions.model;
    settleUnflushed(rec, modelRevision, true);
    return {
      modelRevision,
      sourceRevision,
      admittedNodes: c.nodes.length,
      admittedEdges: c.edges.length,
      danglingEdges: newBase.pendingEdges.length,
    };
  }

  function commitOverlay(rec: IngestSessionRecord<N, E>): IngestCommitReceipt {
    const overlayId = rec.overlayId!;
    const c = rec.contribution;
    const hadNewRows = c.nodes.length > c.publicNodeCount || c.edges.length > c.publicEdgeCount;
    c.publicNodeCount = c.nodes.length;
    c.publicEdgeCount = c.edges.length;
    if (!rec.published && (c.publicNodeCount > 0 || c.publicEdgeCount > 0)) {
      publishedContributions.push(c);
      rec.published = true;
    }
    const merge = mergeModel(currentMergeBase(), publishedContributions);
    // Dangling diagnostics are emitted ONLY at session commit; the
    // records stay in the pending-endpoint index and may resolve later.
    const dangling = merge.pendingBySource.get(overlayId) ?? 0;
    const commitDiags = sessionCommitDiagnostics(rec.tallies, dangling);
    if (commitDiags.length > 0) {
      ingestCommitDiags = [
        ...ingestCommitDiags,
        ...commitDiags.map((diag) => ({ overlayId, diag })),
      ];
    }
    committedOverlayIds = [...committedOverlayIds, overlayId];

    if (hadNewRows) {
      publishIngestModel({
        merged: merge.accepted,
        merge,
        owner: rec,
        overlayIds: committedOverlayIds,
      });
    } else {
      // Everything already public (fully-flushed progressive session):
      // registration-only publication, no model advance.
      publish({ overlayIds: committedOverlayIds, diagnostics: composeDiagnostics() });
    }
    const modelRevision = store.getState().revisions.model;
    settleUnflushed(rec, modelRevision, true);
    return {
      overlayId,
      modelRevision,
      admittedNodes: c.nodes.length,
      admittedEdges: c.edges.length,
      danglingEdges: dangling,
    };
  }

  function commitImpl(rec: IngestSessionRecord<N, E>): Promise<IngestCommitReceipt> {
    if (rec.state !== 'open') {
      return rejectOperation(
        { code: 'ingest-session-closed' },
        `commit() on a ${rec.state} ingest session`,
      );
    }
    if (rec.purpose === 'overlay' && !rec.reserved) {
      const conflict = tryReserveOverlayId(rec);
      if (conflict !== null) return conflict;
    }
    rec.state = 'committing';
    cancelFlushTimer(rec);
    let receipt: IngestCommitReceipt;
    try {
      receipt = rec.purpose === 'replace' ? commitReplace(rec) : commitOverlay(rec);
    } catch (err) {
      // a commit failure after provisional publication terminally
      // aborts and rolls back this session; the previous scene stays healthy.
      rec.state = 'open'; // let the abort path run its terminal transition
      abortSessionInternal(rec, err, true);
      return rejectOperation(
        {
          code: 'resource-limit',
          detail: { reason: err instanceof Error ? err.message : String(err) },
        },
        `commit() failed; session rolled back`,
      );
    }
    rec.state = 'committed';
    openSessions.delete(rec);
    return Promise.resolve(receipt);
  }

  function abortImpl(rec: IngestSessionRecord<N, E>, reason: unknown): Promise<void> {
    if (rec.state !== 'open') {
      return rejectOperation(
        { code: 'ingest-session-closed' },
        `abort() on a ${rec.state} ingest session`,
      );
    }
    abortSessionInternal(rec, reason ?? 'aborted by caller', true);
    return Promise.resolve();
  }

  function beginIngestImpl(opts: BeginIngestOptions): IngestSession<N, E> {
    const purpose = opts.purpose;
    if (purpose !== 'replace' && purpose !== 'overlay') {
      throw new TypeError(`beginIngest: unknown purpose '${String(purpose)}'`);
    }
    if (purpose === 'replace') {
      if (opts.sourceRevision === undefined) {
        throw new TypeError("beginIngest: purpose:'replace' requires sourceRevision");
      }
      if (opts.atomic === false) {
        throw new TypeError(
          "beginIngest: replace sessions are always atomic — progressive replace frames would expose rows before their sourceRevision existed",
        );
      }
      // While a declarative data source is actively driving (a snapshot
      // was applied and not superseded by a replace session), a replace
      // session would race the host's own source of truth — reject at begin.
      // Overlay ingestion stays allowed alongside a declarative base.
      if (baseSource === 'declarative') {
        throw new TypeError(
          "beginIngest: purpose:'replace' is unavailable while a declarative data source is active; keep applying snapshots via applyHostUpdate, or use an overlay session",
        );
      }
    }
    // CAS precondition: zero on an empty instance.
    const currentModel = store.getState().revisions.model;
    if (opts.baseModelRevision !== currentModel) {
      throw new OrbitOperationError(
        { code: 'stale-revision', expected: currentModel, actual: opts.baseModelRevision },
        `beginIngest: baseModelRevision ${opts.baseModelRevision} is stale (current model revision is ${currentModel})`,
      );
    }
    if (purpose === 'overlay') {
      // Lineage: an overlay session is bound to the CURRENT dataset.
      if (baseAccepted === null || baseAccepted.datasetKey !== opts.datasetKey) {
        throw new OrbitOperationError(
          { code: 'stale-revision', expected: currentModel, actual: opts.baseModelRevision },
          baseAccepted === null
            ? 'beginIngest: overlay sessions require an accepted base dataset'
            : `beginIngest: overlay sessions must name the current datasetKey '${baseAccepted.datasetKey}', got '${opts.datasetKey}'`,
        );
      }
    }

    const overlayId =
      purpose === 'overlay' ? (opts.overlayId ?? generateOverlayId()) : null;
    const rec: IngestSessionRecord<N, E> = {
      purpose,
      datasetKey: opts.datasetKey,
      sourceRevision: opts.sourceRevision ?? null,
      // replace is always atomic; overlays default atomic:true.
      atomic: purpose === 'replace' ? true : (opts.atomic ?? true),
      overlayId,
      maxFlushLatencyMs: opts.maxFlushLatencyMs ?? INGEST_MAX_FLUSH_LATENCY_MS_DEFAULT,
      maxPendingBytes: opts.maxPendingBytes ?? INGEST_MAX_PENDING_BYTES_DEFAULT,
      state: 'open',
      reserved: false,
      nextSequence: 0,
      entries: new Map(),
      contribution: newContribution<N, E>(overlayId ?? ''),
      tallies: newStagingTallies(),
      unflushed: [],
      pendingBytes: 0,
      flushTimer: null,
      published: false,
    };
    openSessions.add(rec);

    return {
      get state(): IngestSessionState {
        return rec.state;
      },
      get overlayId(): string | undefined {
        return rec.overlayId ?? undefined;
      },
      append: (batch: IngestBatch<N, E>) => acceptanceQueue.admit(() => appendImpl(rec, batch)),
      commit: () => acceptanceQueue.admit(() => commitImpl(rec)),
      abort: (reason?: unknown) => acceptanceQueue.admit(() => abortImpl(rec, reason)),
    };
  }

  function beginIngest(opts: BeginIngestOptions): IngestSession<N, E> {
    if (destroyed) throwDestroyedOperation('beginIngest');
    return acceptanceQueue.admit(() => beginIngestImpl(opts));
  }

  function removeOverlay(overlayId: string): { removed: boolean } {
    if (destroyed) throwDestroyedOperation('removeOverlay');
    return acceptanceQueue.admit(() => {
      const idx = committedOverlayIds.indexOf(overlayId);
      if (idx === -1) return { removed: false }; // idempotent
      committedOverlayIds = committedOverlayIds.filter((id) => id !== overlayId);
      reservedOverlayIds.delete(overlayId); // released for deliberate reuse
      publishedContributions = publishedContributions.filter((c) => c.overlayId !== overlayId);
      ingestCommitDiags = ingestCommitDiags.filter((e) => e.overlayId !== overlayId);
      // removing an expansion's overlay drops its bookkeeping record
      // and the scope accretion it revealed, in this SAME publication.
      for (const [rootId, records] of expansionOverlays) {
        if (!records.some((r) => r.overlayId === overlayId)) continue;
        const kept: ExpansionOverlayRecord[] = [];
        for (const r of records) {
          if (r.overlayId !== overlayId) {
            kept.push(r);
            continue;
          }
          for (const rid of r.revealedIds) scopeExtraIds.delete(rid);
        }
        if (kept.length === 0) expansionOverlays.delete(rootId);
        else expansionOverlays.set(rootId, kept);
      }
      // Re-run collision + endpoint resolution: formerly shadowed rows from
      // surviving overlays are promoted; resolved edges may re-pend.
      const merge = mergeModel(currentMergeBase(), publishedContributions);
      publishIngestModel({
        merged: merge.accepted,
        merge,
        owner: null,
        overlayIds: committedOverlayIds,
      });
      return { removed: true };
    });
  }

  // -------------------------------------------------------------------------
  // expansion. Every async result re-enters
  // through the acceptance queue for its admission decision and merges via a
  // normal atomic overlay IngestSession, so a custom service cannot bypass
  // byte admission, edge-before-node rules, or all-or-nothing admission.
  // NOTE: v0.5 does NOT cache service results — serviceCacheKey (./services)
  // is the ready seam; only in-flight same-id coalescing dedupes calls.
  // -------------------------------------------------------------------------

  function ownsExpansion(id: NodeId, requestId: string): boolean {
    return expansionLedger.requestIdFor(id) === requestId;
  }

  /**
   * admission gate (the correctness gate — abort is an optimization):
   * dataset lineage must match, every DECLARED revision dimension must be
   * unchanged since issue (undeclared drift never invalidates — the local
   * service declares ['source'], so unrelated overlay publications do not
   * discard it), and every seed must still exist. Returns the denial reason
   * or null when admissible.
   */
  function expansionAdmissible(id: NodeId, ctx: RequestContext, at: RevisionSnapshot): string | null {
    if (destroyed) return 'instance destroyed';
    if (accepted === null || accepted.datasetKey !== ctx.datasetKey) {
      return 'dataset lineage changed';
    }
    if (
      !admitServiceResult({
        declared: expansionService.revisionDependencies,
        at,
        now: revisionSnapshot(),
      })
    ) {
      return 'declared revision dependencies drifted';
    }
    if (!accepted.nodeIndex.has(id)) return 'seed no longer exists';
    return null;
  }

  /** Response node ids NOT visible in the current render scope, deduped. */
  function revealedIdsOf(rows: readonly GraphNode<N>[]): NodeId[] {
    const view = renderModel();
    const out: NodeId[] = [];
    const seen = new Set<NodeId>();
    for (const row of rows) {
      const rid = (row as { id?: unknown }).id;
      if (typeof rid !== 'string' || seen.has(rid)) continue;
      seen.add(rid);
      if (view === null || !view.nodeIndex.has(rid)) out.push(rid);
    }
    return out;
  }

  /** Is any response edge NOT already accepted? Explicit ids are
   * checked directly. Id-less rows use the same response-local pair counters
   * as ingestion, so a second parallel edge maps to `#1` instead of being
   * mistaken for the already-accepted `#0` merely because its pair exists. */
  function anyUnknownEdge(rows: readonly GraphEdge<E>[]): boolean {
    if (rows.length === 0) return false;
    if (accepted === null) return true;
    const pairCounters: EdgePairCounters = new Map();
    for (const e of rows) {
      if (typeof e.id === 'string') {
        if (!edgeIndexById.has(e.id)) return true;
        continue;
      }
      const id = nextSynthesizedEdgeId(pairCounters, e.source, e.target);
      if (!edgeIndexById.has(id)) return true;
    }
    return false;
  }

  /** Discard a service result before admission: ONE 'service-aborted' info
   * diagnostic, the graph untouched, and a typed rejection. */
  function discardExpansion(id: NodeId, why: string): never {
    pushServiceDiagnostic(
      'service-aborted',
      'info',
      `expansion result for '${id}' discarded before admission: ${why}`,
    );
    throw new OrbitOperationError(
      { code: 'aborted', cause: why },
      `expandNode('${id}') result discarded: ${why}`,
    );
  }

  /**
   * Merge an admitted expansion result through ONE awaited `atomic:true`
   * overlay IngestSession (single-response and streaming take the SAME
   * path — a stream is consumed one batch at a time through this session).
   * The overlayId/batchIds carry the request id so rollback and
   * removeOverlay remove exactly this contribution. A mid-stream failure
   * aborts the session — atomic sessions never published, so ALL batches
   * roll back and the graph is untouched.
   */
  async function mergeExpansionSession(
    id: NodeId,
    ctx: RequestContext,
    at: RevisionSnapshot,
    batches: Iterable<ExpansionBatch<N, E>> | AsyncIterable<ExpansionBatch<N, E>>,
    provenance: unknown,
  ): Promise<ExpandNodeResult> {
    const requestId = ctx.requestId;
    const overlayId = `expand:${id}:${requestId}`;
    const ingest = beginIngest({
      purpose: 'overlay',
      datasetKey: ctx.datasetKey,
      baseModelRevision: store.getState().revisions.model,
      atomic: true,
      overlayId,
    });
    const allNodes: GraphNode<N>[] = [];
    let sequence = 0;
    try {
      for await (const b of batches) {
        if (!ownsExpansion(id, requestId)) {
          throw new OrbitOperationError({ code: 'aborted', cause: 'collapsed' });
        }
        const batch: IngestBatch<N, E> = { sequence, batchId: `${requestId}#${sequence}` };
        if (b.nodes !== undefined) {
          batch.nodes = b.nodes;
          allNodes.push(...b.nodes);
        }
        if (b.edges !== undefined) batch.edges = b.edges;
        sequence++;
        await ingest.append(batch);
      }
    } catch (err) {
      // Mid-stream failure: roll back ALL batches; graph untouched.
      if (ingest.state === 'open') await ingest.abort(err).catch(() => {});
      if (
        err instanceof OrbitOperationError &&
        (err.detail.code === 'aborted' || err.detail.code === 'ingest-session-closed')
      ) {
        // Collapse/invalidation, not a service fault — the caller promise
        // was already rejected (collapse) or rejects with this discard.
        throw err;
      }
      pushServiceDiagnostic(
        'service-error',
        'error',
        `expansion stream for '${id}' failed mid-stream; all batches rolled back: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    // Final admission decision, serialized at the acceptance queue.
    const denial = acceptanceQueue.admit(() => {
      if (!ownsExpansion(id, requestId)) return 'collapsed';
      return expansionAdmissible(id, ctx, at);
    });
    if (denial !== null) {
      await ingest.abort(denial).catch(() => {});
      if (denial === 'collapsed') {
        throw new OrbitOperationError({ code: 'aborted', cause: denial });
      }
      discardExpansion(id, denial);
    }

    const revealed = revealedIdsOf(allNodes);
    // Snapshot the effective-set state BEFORE this expansion
    // mutates it — the 'expansion' step's before-image. It EXCLUDES
    // the revealed ids: overlay DATA persists across an undo, so
    // restoring the pre-expansion effective set means hiding them.
    const beforeState = expansionStatePlain(revealed);
    // Record membership: ids this expansion ASSERTS into the
    // effective set — the newly revealed ids plus returned ids whose
    // presence is itself expansion-made (listed by another LIVE record), so
    // a node added by two expansions is owned by BOTH records and survives
    // collapsing either one.
    const revealedSet = new Set(revealed);
    const liveAdded = new Set<NodeId>();
    for (const r of expansionRecords) {
      for (const nid of r.addedNodeIds) liveAdded.add(nid);
    }
    const recordAdded: NodeId[] = [];
    {
      const seenIds = new Set<NodeId>();
      for (const row of allNodes) {
        const rid = (row as { id?: unknown }).id;
        if (typeof rid !== 'string' || seenIds.has(rid)) continue;
        seenIds.add(rid);
        if (revealedSet.has(rid) || liveAdded.has(rid)) recordAdded.push(rid);
      }
    }
    // scope accretion: under an active hard scope the revealed
    // neighbors join the resolved scope in the SAME commit publication (the
    // user's SubgraphSpec itself is never rewritten). A revealed id a past
    // A collapse EXCLUDED id re-enters the effective set here.
    const addedExtras: NodeId[] = [];
    const removedRestores: NodeId[] = [];
    for (const rid of revealed) {
      if (effectiveRemovedIds.delete(rid)) removedRestores.push(rid);
    }
    if (scopeSpec !== null) {
      for (const rid of revealed) {
        if (!scopeExtraIds.has(rid)) {
          scopeExtraIds.add(rid);
          addedExtras.push(rid);
        }
      }
    }
    // Pinned accretion: pin all PREVIOUSLY-placed nodes while the new
    // arrivals settle under 'force'; released on the next simulationEnd.
    if (layout === 'force' && scene !== null && revealed.length > 0) {
      accretionPinIds = new Set(scene.idByIndex);
    }
    try {
      await ingest.commit();
    } catch (err) {
      for (const rid of addedExtras) scopeExtraIds.delete(rid);
      for (const rid of removedRestores) effectiveRemovedIds.add(rid);
      accretionPinIds = null;
      pushServiceDiagnostic(
        'service-error',
        'error',
        `expansion merge for '${id}' failed and rolled back: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    const eng = engineIfReady();
    if (eng !== null && accretionPinIds !== null) {
      pushPinsToEngine(eng, store.getState().pins); // union with the placed set
    }

    const record: ExpansionOverlayRecord = { overlayId, requestId, revealedIds: revealed };
    if (provenance !== undefined) record.provenance = provenance;
    const records = expansionOverlays.get(id);
    if (records === undefined) expansionOverlays.set(id, [record]);
    else records.push(record);

    // Push the expansion record and interleave it with the
    // undo stack as ONE 'expansion' step (session-local either way
    // the record stack never reaches the store or view state). The depth
    // notification folds into this expansion's trailing publication.
    expansionRecords.push({ expandedId: id, addedNodeIds: recordAdded, overlayId });
    historyKernel.record('expansion', beforeState, expansionStatePlain());

    const view = renderModel();
    let added = 0;
    if (view !== null) {
      for (const rid of revealed) if (view.nodeIndex.has(rid)) added++;
    }
    return { added };
  }

  async function runExpansion(
    id: NodeId,
    hops: number,
    handle: RequestContextHandle,
    at: RevisionSnapshot,
  ): Promise<ExpandNodeResult> {
    const ctx = handle.context;
    const requestId = ctx.requestId;
    let response: ExpansionResponse<N, E>;
    try {
      response = await expansionService.neighbors([id], hops, ctx);
    } catch (err) {
      if (!ownsExpansion(id, requestId) || ctx.signal.aborted) {
        // Collapsed/destroyed while in flight — the caller promise was
        // already rejected; discard the late failure silently.
        throw err;
      }
      // service failure: 'service-error' diagnostic; the promise
      // rejects with the cause; the 'error' event never fires.
      pushServiceDiagnostic(
        'service-error',
        'error',
        `expansion service failed for '${id}': ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    if (!ownsExpansion(id, requestId) || ctx.signal.aborted) {
      // Collapsed while in flight: even a service that ignored the signal is
      // stopped HERE — nothing merges (abort optimizes, admission gates).
      throw new OrbitOperationError({ code: 'aborted', cause: 'collapsed' });
    }

    if ('batches' in response) {
      // Streaming: cheap pre-gate, then one batch at a time through ONE
      // atomic session (final admission re-checks before commit).
      const denial = acceptanceQueue.admit(() => expansionAdmissible(id, ctx, at));
      if (denial !== null) discardExpansion(id, denial);
      return mergeExpansionSession(id, ctx, at, response.batches, response.provenance);
    }

    const denial = acceptanceQueue.admit(() => expansionAdmissible(id, ctx, at));
    if (denial !== null) discardExpansion(id, denial);
    // When every returned neighbor is already visible in the current
    // scope (and every edge already accepted), resolve {noop:true} WITHOUT
    // opening a session — no revision advances, no overlay bookkeeping.
    const nodes = response.nodes ?? [];
    const edges = response.edges ?? [];
    const revealed = revealedIdsOf(nodes);
    if (revealed.length === 0 && !anyUnknownEdge(edges)) return { noop: true };
    const rows: ExpansionBatch<N, E> = {};
    if (response.nodes !== undefined) rows.nodes = response.nodes;
    if (response.edges !== undefined) rows.edges = response.edges;
    return mergeExpansionSession(id, ctx, at, [rows], response.provenance);
  }

  function expandNode(id: NodeId, expandOpts?: { hops?: number }): Promise<ExpandNodeResult> {
    if (destroyed) {
      return Promise.reject(
        new OrbitOperationError(
          { code: 'aborted', cause: 'destroyed' },
          'expandNode() called on a destroyed GraphInstance',
        ),
      );
    }
    // same-id coalescing: a second expandNode(id) while one is in
    // flight returns the IDENTICAL promise — its result serves both callers
    // and the service is called ONCE.
    const inFlight = expansionPromises.get(id);
    if (inFlight !== undefined) return inFlight;
    if (accepted === null) return Promise.resolve({ noop: true });

    const rawHops = expandOpts?.hops ?? 1;
    const hops = Number.isFinite(rawHops) ? Math.max(1, Math.floor(rawHops)) : 1;
    const at = revisionSnapshot();
    // RequestContext: dataset + the three revision dimensions at issue
    // time, a request id, and an AbortController-owned signal.
    const handle = createRequestContext({ datasetKey: accepted.datasetKey, revisions: at });
    const requestId = handle.context.requestId;
    expansionLedger.register(id, requestId);
    expansionHandles.set(requestId, handle);

    let settled = false;
    let resolveFn!: (r: ExpandNodeResult) => void;
    let rejectFn!: (e: unknown) => void;
    const promise = new Promise<ExpandNodeResult>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    // collapse/destroy settle the caller promise immediately; the late
    // service completion is then discarded by the ownership check.
    expansionRejectors.set(requestId, (e) => {
      if (!settled) {
        settled = true;
        rejectFn(e);
      }
    });
    expansionPromises.set(id, promise);
    publish({ pendingExpansions: expansionLedger.ids() }); // loading affordance

    /** Ledger/handle cleanup plus the trailing publication. MUST run
     * BEFORE the caller promise settles: `await expandNode(...)` has to
     * resume on a store that already reflects the expansion — its own
     * `pendingExpansions` clear and the folded depth notification
     * ride this publish, and a caller that awaited and then read either
     * would otherwise observe a one-microtask-stale store. A collapse +
     * re-expand may have replaced these entries, so only the still-owning
     * request cleans up (no residue either way, idempotent under the
     * abort path that already cleaned up). */
    const finishExpansion = (): void => {
      if (expansionPromises.get(id) === promise) expansionPromises.delete(id);
      expansionHandles.delete(requestId);
      expansionRejectors.delete(requestId);
      if (expansionLedger.resolve(id, requestId) && !destroyed) {
        publish({ pendingExpansions: expansionLedger.ids() });
      }
    };

    void runExpansion(id, hops, handle, at).then(
      (r) => {
        finishExpansion();
        if (!settled) {
          settled = true;
          resolveFn(r);
        }
      },
      (e: unknown) => {
        finishExpansion();
        if (!settled) {
          settled = true;
          rejectFn(e);
        }
      },
    );
    return promise;
  }

  function retractExpansion(id: NodeId): void {
    if (destroyed) return;
    // 1. Abort the pending expansion: reject the caller promise now,
    // cancel the RequestContext signal, drop the ledger slot. Abort is an
    // optimization — a service that ignores the signal is still discarded
    // at admission by the ownership check, so a late-resolving result
    // admits ZERO nodes.
    const requestId = expansionLedger.abort(id);
    if (requestId !== null) {
      expansionPromises.delete(id);
      const err = new OrbitOperationError(
        { code: 'aborted', cause: 'collapsed' },
        `expandNode('${id}') aborted by retractExpansion()`,
      );
      expansionHandles.get(requestId)?.abort(err);
      expansionRejectors.get(requestId)?.(err);
      pushServiceDiagnostic(
        'service-aborted',
        'info',
        `pending expansion of '${id}' aborted by retractExpansion()`,
      );
      publish({ pendingExpansions: expansionLedger.ids() });
    }
    // 2. Pop the most recent expansion record for `id` and remove
    // its addedNodeIds from the effective set, EXCEPT survivors — a queue
    // job like every other mutator (same global admission order).
    acceptanceQueue.admit(() => {
      collapseTopRecord(id);
    });
  }

  /**
   * Collapse core: pops the most recent record
   * whose expandedId is `id` and removes its addedNodeIds from the effective
   * set, EXCEPT
   * (a) ids re-added by another LIVE expansion record, and
   * (b) ids still REACHABLE from the remaining effective set WITHOUT
   * traversing `id` — BFS over the accepted adjacency restricted to
   * the effective set, `id` excluded as a traversal vertex.
   * Removal is normally a VISIBILITY trim (overlay data persists),
   * recorded as a 'expansion' step. EXCEPTION: when NOTHING survives,
   * the record's overlay is removed wholesale — the v0.5 explicit-removal
   * contract. That path is a model operation and deliberately NOT a
   * history step (model changes are never undoable here, like removeOverlay
   * itself). Fires 'subgraphChange' with the next effective set whenever the
   * displayed set changed (the reporting seam a future controlled subgraph
   * mode will own as its intent).
   */
  function collapseTopRecord(id: NodeId): void {
    let idx = -1;
    for (let i = expansionRecords.length - 1; i >= 0; i--) {
      if (expansionRecords[i]!.expandedId === id) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    const record = expansionRecords[idx]!;
    if (accepted === null) {
      expansionRecords.splice(idx, 1);
      return;
    }
    const view = renderModel() ?? accepted;
    // The record's added ids still displayed — departed/already-hidden ids
    // have nothing left to remove.
    const present = record.addedNodeIds.filter((nid) => view.nodeIndex.has(nid));
    // Exception (a): re-added by another live expansion record.
    const otherAdded = new Set<NodeId>();
    for (let i = 0; i < expansionRecords.length; i++) {
      if (i === idx) continue;
      for (const nid of expansionRecords[i]!.addedNodeIds) otherAdded.add(nid);
    }
    const candidates = new Set<NodeId>();
    for (const nid of present) {
      if (!otherAdded.has(nid)) candidates.add(nid);
    }
    // Exception (b): reachability over effective-set adjacency without `id`.
    const reached = reachableWithoutNode(view, candidates, id);
    const removal: NodeId[] = [];
    for (const nid of candidates) {
      if (!reached.has(nid)) removal.push(nid);
    }
    const anySurvivor = present.length > removal.length;
    const beforeState = expansionStatePlain();
    expansionRecords.splice(idx, 1);
    if (
      !anySurvivor &&
      record.overlayId !== null &&
      committedOverlayIds.includes(record.overlayId)
    ) {
      // No survivor at all: the overlay's contribution has no remaining
      // reason to stay loaded — explicit removal (data leaves; the
      // publication's record invalidation prunes any stragglers).
      for (const nid of removal) scopeExtraIds.delete(nid);
      removeOverlay(record.overlayId);
    } else if (removal.length > 0) {
      // Visibility trim: data persists; the effective set shrinks.
      for (const nid of removal) {
        scopeExtraIds.delete(nid);
        effectiveRemovedIds.add(nid);
      }
      historyKernel.record('expansion', beforeState, expansionStatePlain());
      publishEffectiveSetChange();
    } else {
      // Everything survived: the pop alone is the state change — still a
      // step (collapsing the OTHER expansion later must not resurrect this
      // one). Depths fold into one (otherwise empty) publication.
      historyKernel.record('expansion', beforeState, expansionStatePlain());
      publish({});
    }
    if (removal.length > 0) {
      const next = renderModel() ?? accepted;
      emit('subgraphChange', {
        subgraph: { seedIds: next === null ? [] : next.nodes.map((n) => n.id) },
      });
    }
  }

  /**
   * Collapse exception primitive: BFS over the ACCEPTED adjacency
   * restricted to the effective set `view`, never visiting `blockedId`.
   * Sources are every effective node OUTSIDE `candidates` (and not
   * blockedId); candidates are traversable once reached, so a chain hanging
   * off a reachable candidate survives with it. Returns the reached subset
   * of `candidates`.
   */
  function reachableWithoutNode(
    view: AcceptedGraph<N, E>,
    candidates: ReadonlySet<NodeId>,
    blockedId: NodeId,
  ): ReadonlySet<NodeId> {
    const reachedCandidates = new Set<NodeId>();
    if (candidates.size === 0 || accepted === null) return reachedCandidates;
    const adj = acceptedAdjacencyOf();
    const visited = new Set<number>();
    const queue: number[] = [];
    for (const node of view.nodes) {
      const nid = node.id;
      if (nid === blockedId || candidates.has(nid)) continue;
      const ai = accepted.nodeIndex.get(nid);
      if (ai !== undefined && !visited.has(ai)) {
        visited.add(ai);
        queue.push(ai);
      }
    }
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const nb of neighborsOf(adj, cur)) {
        if (visited.has(nb)) continue;
        const nbId = accepted.nodes[nb]!.id;
        if (nbId === blockedId || !view.nodeIndex.has(nbId)) continue;
        visited.add(nb);
        queue.push(nb);
        if (candidates.has(nbId)) reachedCandidates.add(nbId);
      }
    }
    return reachedCandidates;
  }

  /**
   * Republish after an effective-set change (collapse trim / history
   * 'expansion' replay via applyHistoryCommands' shared path): re-resolve
   * the scoped model, reconcile (structural diff — survivors keep cached
   * positions), rebuild masks, re-project, ONE commit + ONE publication.
   * Advances scope+render, NEVER model (the scope-driven rule the
   * group rewrite also follows).
   */
  function publishEffectiveSetChange(): void {
    if (accepted === null) {
      publish({});
      return;
    }
    const prev = store.getState();
    const eng = engineIfReady();
    if (eng !== null && scene !== null) {
      const pos = eng.getPositions();
      if (pos !== null) bankEnginePositions(pos); // survivors keep positions
    }
    scopedAccepted = computeScopedAccepted();
    const result = reconcileScene(scopedAccepted ?? accepted);
    labelPositionCache = null;
    adjacency = null;
    sceneIncidence = null;
    hardScopeGen += 1;
    visibleGen += 1;
    const filterDiagsChanged = rebuildMaskMemberships(prev.hiddenNodeIds);
    refreshCrossfilterExternalMask(prev.hiddenNodeIds);
    const buffers = projectChannelBuffers({
      nodeColor: true,
      nodeSize: true,
      linkColor: true,
      linkWidth: true,
    });
    const structure: EngineCommit['structure'] | undefined =
      (result.structuralChange || result.positionChange) && scene !== null
        ? { pointCount: scene.count, positions: scene.positions, links: scene.links }
        : undefined;
    const commitNeeded = structure !== undefined || buffers !== undefined;
    const revisions: Revisions = { ...prev.revisions };
    revisions.scope += 1;
    if (commitNeeded) revisions.render += 1;
    let simRestarted = false;
    if (commitNeeded && eng !== null) {
      const commit: EngineCommit = { revision: revisions.render };
      if (structure !== undefined) {
        commit.structure = structure;
        // I2: the trimmed roster ships with ITS point→slot index.
        const syncIndex = structuralPointImageIndex();
        if (syncIndex !== null) commit.resources = { pointImageIndex: syncIndex };
      }
      if (buffers !== undefined) commit.buffers = buffers;
      if (structure !== undefined && layout === 'force') {
        // reflow semantics: default restart; scopeSpec.reflow: false
        // keeps simulation state (a scope-less trim always reflows).
        if (scopeSpec === null || scopeSpec.reflow !== false) {
          commit.restart = { alpha: 1 };
          simRestarted = true;
        }
      }
      commitToEngine(eng, commit);
      revisions.appliedRender = eng.appliedRevision();
      const facade = session !== null ? session.edgePicking : null;
      if (facade !== null) {
        if (commit.restart !== undefined && commit.restart !== false) facade.disarm();
        else if (structure !== undefined && scene !== null) facade.arm(scene.positions, scene.links);
      }
    }
    const labelRerank = recomputeCandidates();
    const patch: Partial<GraphStoreState> = { revisions };
    const vis = computeVisibleCounts();
    if (!sameVisible(vis, prev.visible)) patch.visible = vis;
    if (simRestarted && !prev.simulationRunning) patch.simulationRunning = true;
    if (filterDiagsChanged || labelRerank.diagsChanged) patch.diagnostics = composeDiagnostics();
    publish(patch);
    // highlight remap after the structural swap.
    if (eng !== null && result.structuralChange) {
      const sel = store.getState().selection;
      if (sel.nodeIds.length > 0 || sel.groupIds.length > 0) {
        pushSelectionToEngine(eng, sel.nodeIds);
      }
      const pins = store.getState().pins;
      if (pins.size > 0 || store.getState().pinnedNodeIds.size > 0) {
        pushPinsToEngine(eng, pins);
      }
    }
    if (labelRerank.setChanged) notifyLabelSubs(candidateSubs);
  }

  // -------------------------------------------------------------------------
  // search. The instance owns the correctness
  // machinery around the pluggable SearchService: RequestContext creation,
  // revision-keyed LRU caching (in-flight coalescing per equal key),
  // supersede cancellation, and stale-result rejection at admission.
  // -------------------------------------------------------------------------

  /** The non-generic store/activation surfaces erase the caller's attr type
   * (GraphStoreState.search and SearchActivation carry the DEFAULT-generic
   * SearchResult; the id/score/label/node shape is identical). */
  function eraseSearchResults(rs: readonly SearchResult<N>[]): readonly SearchResult[] {
    return rs as unknown as readonly SearchResult[];
  }

  /** admission gate for a completed search (abort is an optimization):
   * dataset lineage must match and every DECLARED revision dimension must be
   * unchanged since issue. Returns the denial reason or null. */
  function searchAdmissible(ctx: RequestContext, at: RevisionSnapshot): string | null {
    if (destroyed) return 'instance destroyed';
    if (accepted === null || accepted.datasetKey !== ctx.datasetKey) {
      return 'dataset lineage changed';
    }
    if (
      !admitServiceResult({
        declared: searchService.revisionDependencies,
        at,
        now: revisionSnapshot(),
      })
    ) {
      return 'stale at admission: declared revision dependencies drifted';
    }
    return null;
  }

  /** Dataset swap or destroy: the in-flight search call rejects
   * 'aborted' and the revision-keyed cache empties (its keys are lineage-
   * scoped, so this is hygiene, not correctness — admission is the gate). */
  function abortSearchFlight(cause: string, message: string): void {
    searchCache.clear();
    if (searchFlight === null) return;
    const flight = searchFlight;
    searchFlight = null;
    const err = new OrbitOperationError({ code: 'aborted', cause }, message);
    flight.handle.abort(err);
    flight.reject(err);
  }

  /** One search service call: raw results, then the admission decision
   * serialized at the acceptance queue, then `node` population against the
   * (still-current) accepted model. Never publishes — the LATEST search
   * caller owns the single store publication. */
  async function runSearch(
    query: string,
    limit: number,
    handle: RequestContextHandle,
    at: RevisionSnapshot,
  ): Promise<readonly SearchResult<N>[]> {
    const ctx = handle.context;
    let raw: readonly SearchResult<N>[];
    try {
      raw = await searchService.search(query, { limit }, ctx);
    } catch (err) {
      if (!ctx.signal.aborted && !destroyed) {
        // service failure: 'service-error' diagnostic; the promise
        // rejects with the cause; the 'error' event never fires.
        pushServiceDiagnostic(
          'service-error',
          'error',
          `search service failed for '${query}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    }
    if (ctx.signal.aborted) {
      // Superseded/destroyed while in flight: even a service that ignored
      // the signal is stopped HERE (abort optimizes, admission gates). The
      // caller promise was already rejected by the supersede path.
      throw new OrbitOperationError(
        { code: 'aborted', cause: 'superseded' },
        `search('${query}') was superseded before admission`,
      );
    }
    // stale-result rule, serialized at the acceptance queue: a result
    // whose declared revisions drifted is DISCARDED — the promise rejects
    // with a typed 'aborted' error carrying a distinct staleness message.
    const denial = acceptanceQueue.admit(() => searchAdmissible(ctx, at));
    if (denial !== null) {
      throw new OrbitOperationError(
        { code: 'aborted', cause: denial },
        `search('${query}') result discarded: ${denial}`,
      );
    }
    if (accepted === null) return raw; // unreachable past admission; type guard
    // store contract: `node` populated for ids in the accepted model.
    const populated: SearchResult<N>[] = [];
    for (const r of raw) {
      const idx = accepted.nodeIndex.get(r.id);
      const node = idx === undefined ? undefined : accepted.nodes[idx];
      populated.push(node === undefined ? r : { ...r, node });
    }
    return populated;
  }

  function search(
    query: string,
    searchOpts?: { limit?: number },
  ): Promise<readonly SearchResult<N>[]> {
    if (destroyed) {
      return Promise.reject(
        new OrbitOperationError(
          { code: 'aborted', cause: 'destroyed' },
          'search() called on a destroyed GraphInstance',
        ),
      );
    }
    const token = ++searchSeq;
    const rawLimit = searchOpts?.limit ?? SEARCH_LIMIT_DEFAULT;
    const limit = Number.isFinite(rawLimit)
      ? Math.max(0, Math.floor(rawLimit))
      : SEARCH_LIMIT_DEFAULT;
    if (accepted === null) {
      // No accepted base: nothing to search against — an honest empty
      // completion (still the latest publication for navigator consumers).
      publish({ search: { query, results: [] } });
      return Promise.resolve([]);
    }
    const at = revisionSnapshot();
    // cache-key rule: service identity + canonical params + datasetKey
    // + EXACTLY the declared revision dimensions' current values.
    const key = serviceCacheKey({
      serviceId: 'search',
      // `fields` is defensive insurance: searchIndex is
      // construction-only (D7) so it cannot legitimately change, but keying
      // it here guarantees a cached result can never outlive the field
      // configuration it was computed under.
      params: { fields: (searchIndexFields ?? []).join(''), limit, q: query },
      datasetKey: accepted.datasetKey,
      declared: searchService.revisionDependencies,
      revisions: at,
    });
    // supersede: a NEWER query cancels the older in-flight call — its
    // callers reject 'aborted' and its (unsettled) cache entry evicts. An
    // equal key instead coalesces onto the in-flight promise below.
    if (searchFlight !== null && searchFlight.key !== key) {
      const flight = searchFlight;
      searchFlight = null;
      const err = new OrbitOperationError(
        { code: 'aborted', cause: 'superseded' },
        `search('${query}') superseded the older in-flight query`,
      );
      flight.handle.abort(err);
      flight.reject(err);
    }
    let shared = searchCache.get(key);
    if (shared !== undefined) {
      // LRU refresh: re-insert as most recent.
      searchCache.delete(key);
      searchCache.set(key, shared);
    } else {
      const handle = createRequestContext({ datasetKey: accepted.datasetKey, revisions: at });
      let settled = false;
      let resolveFn!: (r: readonly SearchResult<N>[]) => void;
      let rejectFn!: (e: unknown) => void;
      const promise = new Promise<readonly SearchResult<N>[]>((res, rej) => {
        resolveFn = res;
        rejectFn = rej;
      });
      const flight = {
        key,
        handle,
        reject: (e: unknown) => {
          if (settled) return;
          settled = true;
          // Failures are never served from the cache.
          if (searchCache.get(key) === promise) searchCache.delete(key);
          rejectFn(e);
        },
      };
      searchFlight = flight;
      searchCache.set(key, promise);
      while (searchCache.size > SEARCH_CACHE_LIMIT) {
        const oldest = searchCache.keys().next();
        if (oldest.done === true) break;
        searchCache.delete(oldest.value);
      }
      void runSearch(query, limit, handle, at)
        .then(
          (r) => {
            if (!settled) {
              settled = true;
              resolveFn(r);
            }
          },
          (e: unknown) => {
            flight.reject(e);
          },
        )
        .finally(() => {
          if (searchFlight === flight) searchFlight = null;
        });
      shared = promise;
    }
    const issuedDatasetKey = accepted.datasetKey;
    return shared.then((results) => {
      // ONE publish, owned by the LATEST search call: a superseded caller
      // or a replayed cache hit never clobbers a newer publication, and a
      // dataset swap between admission and this microtask never resurrects
      // the old dataset's results.
      if (
        !destroyed &&
        token === searchSeq &&
        accepted !== null &&
        accepted.datasetKey === issuedDatasetKey
      ) {
        publish({ search: { query, results: eraseSearchResults(results) } });
      }
      return results;
    });
  }

  function clearSearch(): void {
    if (destroyed) return;
    // Clearing SUPERSEDES active work — advance the publication
    // token so a flight that settles later can never republish the cleared
    // query (the token is the gate; the abort below is the optimization).
    // The flight's reject path also evicts its unsettled cache entry, so a
    // repeat of the same query after clear re-runs the service.
    searchSeq += 1;
    if (searchFlight !== null) {
      const flight = searchFlight;
      searchFlight = null;
      const err = new OrbitOperationError(
        { code: 'aborted', cause: 'cleared' },
        'search cleared while in flight',
      );
      flight.handle.abort(err);
      flight.reject(err);
    }
    if (store.getState().search !== null) publish({ search: null });
  }

  // -------------------------------------------------------------------------
  // findPath / clearPath. One findPath application is ONE
  // atomic action: path-node indices to the engine selection-highlight
  // channel plus a single buffers-only link commit whose dim complement is
  // composed INSIDE composeEdgeAlphaBuffer (the path owns the link lane
  // until clearPath or any selection mutation). Session-local by contract.
  // -------------------------------------------------------------------------

  function pathAdmissible(ctx: RequestContext, at: RevisionSnapshot): string | null {
    if (destroyed) return 'instance destroyed';
    if (accepted === null || accepted.datasetKey !== ctx.datasetKey) {
      return 'dataset lineage changed';
    }
    if (
      !admitServiceResult({
        declared: pathServiceImpl.revisionDependencies,
        at,
        now: revisionSnapshot(),
      })
    ) {
      return 'stale at admission: declared revision dependencies drifted';
    }
    return null;
  }

  /** Drop path state WITHOUT touching the engine (scene rebuild path — the
   * rebuild's own commit recomposes the link lane from scratch). */
  function dropPathState(): void {
    activePath = null;
    pathDimEdges = null;
  }

  /** Full clear: restore the selection highlight and recompose the link
   * lane in one buffers-only commit. No-op when no path is active. */
  function clearPathInternal(): void {
    if (activePath === null) return;
    dropPathState();
    const eng = engineIfReady();
    if (eng !== null && scene !== null) {
      const prev = store.getState();
      const revisions: Revisions = { ...prev.revisions };
      revisions.render += 1;
      commitToEngine(eng, {
        revision: revisions.render,
        buffers: { linkColor: composeEdgeAlphaBuffer(baseLinkColorBuffer()) },
      });
      revisions.appliedRender = eng.appliedRevision();
      pushSelectionToEngine(eng, prev.selection.nodeIds);
      publish({ revisions });
    }
  }

  function clearPath(): void {
    if (destroyed) return;
    pathSeq += 1; // supersede any in-flight findPath
    clearPathInternal();
  }

  function getActivePath(): PathResult | null {
    return activePath;
  }

  async function findPath(
    sourceId: NodeId,
    targetId: NodeId,
    options?: PathOptions,
  ): Promise<PathResult | null> {
    if (destroyed) {
      throw new OrbitOperationError(
        { code: 'aborted', cause: 'destroyed' },
        'findPath() called on a destroyed GraphInstance',
      );
    }
    const token = ++pathSeq;
    if (accepted === null) return null;
    const at = revisionSnapshot();
    const issuedDatasetKey = accepted.datasetKey;
    const handle = createRequestContext({ datasetKey: issuedDatasetKey, revisions: at });
    const result = await pathServiceImpl.find(sourceId, targetId, options ?? {}, handle.context);
    // admission is the gate — a result arriving after a dataset
    // replacement or revision drift is DISCARDED (typed rejection).
    const denial = acceptanceQueue.admit(() => pathAdmissible(handle.context, at));
    if (denial !== null) {
      throw new OrbitOperationError(
        { code: 'aborted', cause: 'stale' },
        `findPath('${sourceId}' → '${targetId}') discarded: ${denial}`,
      );
    }
    // Superseded by a newer findPath/clearPath: the RESULT still returns to
    // the caller, but emphasis belongs to the latest action only.
    if (token !== pathSeq || result === null) return result;
    if (scene !== null) {
      const plan = computePathEmphasis(result, {
        indexById: scene.indexById,
        edgeIdByIndex: scene.edgeIdByIndex,
        ...(softMask !== null
          ? { isEdgeVisible: (k: number) => softMask!.isEdgeVisible(k) }
          : {}),
      });
      activePath = result;
      pathDimEdges = new Set(plan.dimEdgeIndices);
      const eng = engineIfReady();
      if (eng !== null) {
        const prev = store.getState();
        const revisions: Revisions = { ...prev.revisions };
        revisions.render += 1;
        // ONE atomic link-channel commit (emphasis + dim complement) …
        commitToEngine(eng, {
          revision: revisions.render,
          buffers: { linkColor: composeEdgeAlphaBuffer(baseLinkColorBuffer()) },
        });
        revisions.appliedRender = eng.appliedRevision();
        // … plus the path-node highlight (path owns the channel until clear).
        eng.setSelectedIndices(plan.nodeIndices.length > 0 ? [...plan.nodeIndices] : null);
        publish({ revisions });
      }
    }
    return result;
  }

  /** Result contract. Classification only — NEVER mutates scope
   * or filters (the host reacts explicitly). */
  function activateSearchResult(result: SearchResult<N>): SearchActivation {
    const id = result.id;
    const plain = result as unknown as SearchResult;
    if (scene !== null) {
      const idx = scene.indexById.get(id);
      if (idx !== undefined) {
        if (softMask === null || softMask.isNodeVisible(idx)) {
          // In the rendered scene and mask-visible: select-and-fly.
          focusNode(id);
          return { status: 'focused', id };
        }
        return { status: 'unavailable', reason: 'filtered', result: plain };
      }
    }
    if (accepted !== null && accepted.nodeIndex.has(id)) {
      return { status: 'unavailable', reason: 'out-of-scope', result: plain };
    }
    return { status: 'unavailable', reason: 'not-loaded', result: plain };
  }

  /** isolate: hard-scope to the current selection through the SAME
   * path as the `subgraph` prop (uncontrolled-only — instance-owned).
   * isolate-as-unit: selected GROUP ids resolve to their
   * memberIds BEFORE scope resolution, so isolating a selection
   * containing a collapsed group hard-scopes to the members and the stage-3
   * rewrite renders the super-node as a unit. */
  function isolateSelection(): void {
    if (destroyed) return;
    const sel = store.getState().selection;
    const seedIds: NodeId[] = [...sel.nodeIds];
    for (const groupId of sel.groupIds) {
      const group = resolvedGroups.find((g) => g.id === groupId);
      if (group !== undefined) seedIds.push(...group.memberIds);
    }
    const seeds = dedupeFirstOccurrence(seedIds);
    if (seeds.length === 0) return; // an empty scope would render nothing
    applyHostUpdate({ subgraph: { seedIds: seeds } });
  }

  function resetIsolation(): void {
    if (destroyed) return;
    applyHostUpdate({ subgraph: null });
  }

  // -------------------------------------------------------------------------
  // applyHostUpdate — the atomic boundary
  // -------------------------------------------------------------------------

  function applyHostUpdate(update: GraphHostUpdate<N, E>): void {
    if (destroyed) throwDestroyedOperation('applyHostUpdate');
    // Every state publication routes through the acceptance queue.
    acceptanceQueue.admit(() => {
      applyHostUpdateInner(update);
      // a HOST update is the reflection channel for a staged
      // aggregate restore — matching values acknowledge, different values
      // diverge, unrelated updates pass through.
      checkRestoreAcknowledgement(update);
    });
  }

  function applyHostUpdateInner(
    update: GraphHostUpdate<N, E>,
    // A worker-derived acceptance re-enters here with the rows
    // already validated — validateSnapshot is skipped, everything else
    // (sessions, dataset-swap clearing, reconcile, commit, publish) runs
    // the ONE shared flow.
    preAccepted?: AcceptedGraph<N, E>,
  ): void {
    // phase clock (coarse, always-on: four performance.now()
    // reads per update). `validate` remains folded into `derive` until the
    // columnar lane splits acceptance from derivation, as documented
    // in the GraphPerfSnapshot JSDoc.
    const phaseT0 = performance.now();
    let phaseProjectStart = phaseT0;
    // I1: the model revision current when this update was ISSUED — the only
    // coordinate the host could have stamped async work with (an atomic
    // data+metrics update advances acceptedModelSeq before metrics admit,
    // but its columns were built at THIS revision).
    const issuedModelSeq = acceptedModelSeq;
    // D7: set when this update carried a (rejected) construction-only option
    // — forces the warning diagnostic into this update's single publish.
    let searchIndexRejected = false;
    // Set when a crossfilter spec replacement was rejected
    // same publish-forcing role.
    let crossfilterRejected = false;
    // set when a columnar snapshot failed structural validation — the
    // data lane changes NOTHING (prior scene intact) but the diagnostic must
    // reach this update's single publication.
    let columnarRejected = false;
    // Metrics are deferred WITH worker-routed data (they join the model
    // that data establishes — admitting them now would target the old one).
    let metricsDeferredToWorker = false;
    // a lane changed outside this update's own diffing (e.g. a group
    // op cleared its verdict) — force one diagnostics recompose.
    const diagnosticsForced = pendingDiagnosticsRefresh;
    pendingDiagnosticsRefresh = false;
    // --- 0. filter validation: reject BEFORE any work so a malformed
    // filter can never leave a partially-applied atomic host update. ---
    if (update.filter !== undefined && update.filter !== null) {
      const findings: string[] = [];
      const spec = update.filter;
      if (spec.nodes !== undefined && typeof spec.nodes !== 'function') {
        for (const f of validateFilterExpr(spec.nodes)) findings.push(`nodes.${f}`);
      }
      if (spec.edges !== undefined && typeof spec.edges !== 'function') {
        for (const f of validateFilterExpr(spec.edges)) findings.push(`edges.${f}`);
      }
      if (spec.mode !== undefined && spec.mode !== 'hide' && spec.mode !== 'dim') {
        findings.push(`mode: unknown filter mode '${String(spec.mode)}'`);
      }
      if (findings.length > 0) {
        throw new TypeError(`applyHostUpdate: invalid filter: ${findings.join('; ')}`);
      }
    }

    const prev = store.getState();
    const previousLayout = layout;
    const nextLayout = update.layout ?? previousLayout;
    const layoutChanged = nextLayout !== previousLayout;
    const freezesForceLayout = previousLayout === 'force' && nextLayout === 'fixed';
    const activatesForceLayout = previousLayout === 'fixed' && nextLayout === 'force';
    const eng = engineIfReady();
    let pausedForFixedLayout = false;

    /** A force → fixed transition must stop integration before its one
     * authoritative readback. Structural-update callers share this helper so
     * the transition never performs a redundant second O(n) readback. */
    const bankReadyEnginePositions = (): void => {
      if (eng === null || scene === null) return;
      if (freezesForceLayout && !pausedForFixedLayout) {
        eng.pause();
        pausedForFixedLayout = true;
      }
      const pos = eng.getPositions();
      if (pos !== null) bankEnginePositions(pos);
    };

    // --- 1. data: validate → reconcile (skipped entirely on idempotent replay).
    // The replay check runs against the BASE source coordinate, so replaying
    // the same base snapshot never clears overlays or aborts sessions; this
    // protects React re-renders. ---
    let dataChanged = false;
    let structuralChange = false;
    let positionChange = false;
    let datasetKeyChanged = false;
    let overlayIdsCleared = false;
    // columnar lane: resolve a columnar snapshot into the
    // object form BEFORE the shared acceptance logic, so duplicate-id/
    // dangling-edge/self-loop rules stay in exactly one place. Structural
    // corruption rejects the WHOLE data lane (prior scene intact, one error
    // diagnostic); a replay is idempotent and NEVER touches caller buffers.
    let data: GraphSnapshot<N, E> | undefined;
    if (update.data !== undefined && isColumnarSnapshot(update.data)) {
      const columnar = update.data;
      const isColumnarReplay =
        baseAccepted !== null &&
        baseAccepted.datasetKey === columnar.datasetKey &&
        baseAccepted.sourceRevision === columnar.sourceRevision;
      if (isColumnarReplay) {
        data = undefined; // same no-op as an object-lane replay
      } else {
        const issues = validateColumnarStructure(columnar);
        if (issues.length > 0) {
          columnarDiags = [
            {
              code: 'invalid-columnar-snapshot',
              severity: 'error',
              count: issues.length,
              sampleIds: issues.slice(0, DIAGNOSTIC_SAMPLE_CAP).map((i) => i.where),
              message: `columnar snapshot rejected whole: ${issues[0]!.where} — ${issues[0]!.detail}`,
            },
          ];
          columnarRejected = true;
          data = undefined;
        } else if (workerEligible()) {
          // Acceptance derives OFF-THREAD and lands through
          // the acceptance queue — this update's other lanes apply
          // now; the data lane follows asynchronously (stream-commit
          // semantics), and the DATA-COUPLED metrics lane defers with it.
          // Caller buffers untouched until that admission.
          scheduleWorkerAcceptance(columnar, update.metrics);
          metricsDeferredToWorker = true;
          data = undefined;
        } else {
          data = materializeColumnarSnapshot(columnar);
          // Detach ONLY after validation AND admission succeed.
          // Successful materialization above is the admission point on this
          // path, so a snapshot that reached here is admitted before detach.
          if (columnar.bufferOwnership === 'transfer') detachColumnarBuffers(columnar);
        }
      }
    } else {
      data = update.data;
    }
    if (data !== undefined) {
      const isReplay =
        baseAccepted !== null &&
        baseAccepted.datasetKey === data.datasetKey &&
        baseAccepted.sourceRevision === data.sourceRevision;
      if (!isReplay) {
        // Validation is pure and may reject a hostile/malformed object (for
        // example, a throwing property getter). Complete it before aborting
        // sessions, clearing overlays, pausing layout, or banking positions so
        // a rejected atomic host update has no observable side effects.
        const nextAccepted = preAccepted ?? validateSnapshot<N, E>(data);
        // a replacing declarative snapshot aborts ALL open sessions and
        // clears every overlay before the new base is accepted.
        abortAllSessions(null, 'replaced: a declarative snapshot was applied');
        overlayIdsCleared = clearOverlayState();
        datasetKeyChanged = baseAccepted !== null && baseAccepted.datasetKey !== data.datasetKey;
        if (datasetKeyChanged) {
          // new dataset — position caches, engine diagnostics, mask
          // state, history, timeline playback, domain freezes, metric
          // columns, and atlas state do not carry over.
          reconciler = new Reconciler();
          engineDiags = [];
          abortExpansionsForDatasetSwap();
          abortSearchFlight('dataset-changed', 'search aborted: the datasetKey changed');
          resetMaskState();
          historyKernel.clear();
          stopTimelineTimer();
          timelinePlayingKey = null;
          domainStore.clear();
          metricColumnGen.clear();
          metricDiags = [];
          churnDiags = [];
          resetImagePipelineState();
          // The groupBy collapsed residue is per-dataset state
          // (the SPEC lanes survive — host config, like filter/groups).
          groupByCollapsedKeys.clear();
          semanticZoomBand = null; // re-establish on the next threshold crossing
          // Expansion records and collapse exclusions are
          // per-dataset session state.
          expansionRecords = [];
          effectiveRemovedIds.clear();
        } else {
          // bank live engine positions so they survive the structural swap.
          bankReadyEnginePositions();
        }
        accepted = nextAccepted;
        // The publication pass invalidates expansion records
        // referencing nodes the new accepted snapshot no longer contains.
        invalidateExpansionRecords();
        // mirrors the revisions.model advance in step 6 — the metric/
        // domain freeze coordinate moves with the accepted model.
        acceptedModelSeq += 1;
        baseAccepted = nextAccepted;
        basePendingEdges = [];
        baseSource = 'declarative';
        edgeIndexById = new Map(nextAccepted.edges.map((e, k) => [e.id, k] as const));
        adjacency = null; // model changed — the CSR caches are stale
        sceneIncidence = null;
        acceptedAdjacency = null;
        dataDiags = nextAccepted.diagnostics;
        columnarDiags = []; // a successful acceptance clears the rejection
        // Supersession: ANY accepted data lane invalidates every
        // in-flight worker derive — a stale columnar acceptance must never
        // land over newer data (sync object path included). The landed
        // worker re-entry bumps too, harmlessly: its own token is done.
        pendingDeriveToken += 1;
        dataChanged = true;
      }
    }

    // --- 1b. hard scope. Ownership (v0.5): `subgraph` is
    // UNCONTROLLED-ONLY — this prop and isolateSelection/resetIsolation
    // write the SAME instance-owned state; last writer wins and omitting the
    // prop leaves the last written scope in place. ---
    let scopeChanged = false;
    if (datasetKeyChanged && scopeSpec !== null) {
      // the hard scope is per-dataset id-keyed state — a new dataset clears it.
      scopeSpec = null;
      scopeChanged = true;
    }
    if (update.subgraph !== undefined && !sameSubgraphSpec(update.subgraph, scopeSpec)) {
      // scope statements (subgraph prop / isolate / reset) record.
      historyKernel.record('scope', subgraphPlain(scopeSpec), subgraphPlain(update.subgraph));
      scopeSpec = update.subgraph;
      // An explicit scope statement resets expansion accretion AND
      // the effective set: every expansion record and collapse
      // exclusion clears.
      scopeExtraIds.clear();
      expansionRecords = [];
      effectiveRemovedIds.clear();
      scopeChanged = true;
    }
    if (scopeChanged) {
      // 'hard-scope' (and the stricter 'visible') domain scopes
      // recompute when the hard scope changes.
      hardScopeGen += 1;
      visibleGen += 1;
    }

    // --- 1b'. groups lanes. Manual `groups`: validate → resolve
    // BEFORE any scene rewrite (D4) — a violating array yields ONE
    // 'config-error' diagnostic and changes NOTHING else (the previous
    // groups and scene stay live, zero engine commits); `null` clears (D2);
    // a HOST update carrying the key at all flips the slice to CONTROLLED.
    // Derived `groupBy`:
    // boundary-validated (D4), reference-diffed; `null` clears. Both lanes
    // together is the config error — the ERROR wins and NEITHER
    // applies until the host removes one. ---
    let groupsDiagsChanged = false;
    let groupsSpecChanged = false;
    if (update.groups !== undefined && !groupsInternalWrite) groupsControlled = true;
    if (update.groups !== undefined) {
      if (update.groups === null) {
        if (groupsSpec !== null) {
          groupsSpec = null;
          groupsSpecChanged = true;
        }
        if (groupsDiags.length > 0) {
          groupsDiags = [];
          groupsDiagsChanged = true;
        }
      } else if (!sameGroupSpecArrays(update.groups, groupsSpec)) {
        const verdict = validateGroupSpecs(update.groups, accepted?.nodeIndex ?? null);
        if (verdict.diagnostic !== null) {
          groupsDiags = [verdict.diagnostic];
          groupsDiagsChanged = true;
        } else {
          groupsSpec = update.groups;
          groupsSpecChanged = true;
          if (groupsDiags.length > 0) {
            groupsDiags = [];
            groupsDiagsChanged = true;
          }
        }
      }
    }
    let groupByChanged = false;
    if (update.groupBy !== undefined) {
      if (update.groupBy === null) {
        if (groupBySpec !== null) {
          groupBySpec = null;
          groupByChanged = true;
          semanticZoomBand = null; // thresholds are gone
        }
        if (groupByDiags.length > 0) {
          groupByDiags = [];
          groupsDiagsChanged = true;
        }
      } else if (!sameGroupBySpec(update.groupBy, groupBySpec)) {
        // D4 boundary: a rejected spec (semanticZoom hysteresis violation,
        // non-function `by`) never lands — the previous groupBy stays live.
        const diag = validateGroupBySpec(update.groupBy);
        if (diag !== null) {
          groupByDiags = [diag];
          groupsDiagsChanged = true;
        } else {
          groupBySpec = update.groupBy;
          groupByChanged = true;
          // A NEW threshold pair re-establishes its band from scratch.
          semanticZoomBand = null;
          if (groupByDiags.length > 0) {
            groupByDiags = [];
            groupsDiagsChanged = true;
          }
        }
      }
    }
    if (groupsSpecChanged || groupByChanged) {
      const conflict = groupsSpec !== null && groupBySpec !== null;
      if (conflict && groupsConflictDiags.length === 0) {
        groupsConflictDiags = [
          {
            code: 'config-error',
            severity: 'error',
            count: 1,
            sampleIds: [],
            message:
              'groups and groupBy are mutually exclusive: NEITHER applies until the host removes one',
          },
        ];
        groupsDiagsChanged = true;
      } else if (!conflict && groupsConflictDiags.length > 0) {
        groupsConflictDiags = [];
        groupsDiagsChanged = true;
      }
      // A stale op verdict clears once any groups lane write applies.
      if (groupsOpDiags.length > 0) {
        groupsOpDiags = [];
        groupsDiagsChanged = true;
      }
    }
    // A data change re-resolves the RETAINED lanes (departed members drop
    // tolerantly — model drift is data, not a config error); ops signal
    // residue changes through pendingGroupsRefresh.
    let groupsResolutionChanged = false;
    const groupsResidueDirty = pendingGroupsRefresh;
    pendingGroupsRefresh = false;
    const deriveDiagsBefore = groupsDeriveDiags;
    if (groupsSpecChanged || groupByChanged || dataChanged || groupsResidueDirty) {
      groupsResolutionChanged = refreshGroupsResolution();
      if (groupsDeriveDiags !== deriveDiagsBefore) groupsDiagsChanged = true;
    }
    // Scene work is due only when a GROUP rewrite is (or was) materialized:
    // uncollapsed groups live in store.groups alone and never touch the
    // scene — zero commits when nothing is collapsed. (The
    // superNodes check keeps this gate group-specific when the composed
    // rewrite exists only for the parallel-edge pass.)
    // A FOLD is the same stage-3 containment change wearing a real
    // representative instead of a synthetic one, so it dirties this same
    // lane — the flag means "the stage-3 rewrite may have moved", not
    // "a group moved".
    const foldsSceneDirty = pendingFoldsRefresh;
    pendingFoldsRefresh = false;
    const groupsSceneDirty =
      foldsSceneDirty ||
      (groupsResolutionChanged &&
        ((groupRewrite !== null && groupRewrite.superNodes.length > 0) ||
          anyCollapsedIntersecting()));
    if (groupsSceneDirty) visibleGen += 1;

    // --- 1b''. parallel-edge grouping toggle, a
    // stage-3-adjacent lane. INOPERATIVE case: turning it ON while the
    // accepted edge list has zero same-pair multiplicity (edge ids
    // synthesized from (type,source,target)-style dedupe already collapsed
    // parallels at the source) emits ONE documented 'operation-rejected'
    // warning — once per instance — and changes NOTHING (no reconcile, no
    // revisions, no commit). With no accepted model yet the toggle is
    // stashed silently (detection needs an edge list); the next data
    // publication composes it through the normal reconcile. ---
    let parallelSceneDirty = false;
    let parallelRejected = false;
    if (
      update.parallelEdgeGrouping !== undefined &&
      update.parallelEdgeGrouping !== parallelEdgeGrouping
    ) {
      if (update.parallelEdgeGrouping && accepted !== null && !acceptedHasParallelEdges()) {
        if (!parallelInoperativeWarned) {
          parallelInoperativeWarned = true;
          engineDiags = [
            ...engineDiags,
            {
              code: 'operation-rejected',
              severity: 'warning',
              count: 1,
              sampleIds: [],
              message:
                'parallelEdgeGrouping is inoperative: the accepted edge list has no same-endpoint-pair parallels (ids synthesized from (type,source,target)-style dedupe already collapse them) — the toggle changed nothing',
            },
          ];
          parallelRejected = true;
        }
      } else {
        parallelEdgeGrouping = update.parallelEdgeGrouping;
        parallelSceneDirty = accepted !== null && !dataChanged;
        if (parallelSceneDirty) visibleGen += 1;
      }
    }

    // --- 1c. reconcile: rebuild the render scene when the accepted model,
    // its hard scope, OR the stage-3 group rewrite changed. ONLY the scoped
    // subset feeds stage 3 and then the reconciler; positions come from the
    // placement caches, so clearing (subgraph: null) restores
    // the full base with cached positions, a version switch keeps
    // overlapping ids where they were, and expanding a group returns
    // its members to their cached placements. ---
    if ((dataChanged || scopeChanged || groupsSceneDirty || parallelSceneDirty) && accepted !== null) {
      if (!dataChanged) {
        // Scope/groups-only swap: bank live engine positions so survivors
        // (and departing ids — collapsed members included — via the
        // departed cache) keep them.
        bankReadyEnginePositions();
      }
      if (dataChanged || scopeChanged) scopedAccepted = computeScopedAccepted();
      const result = reconcileScene(scopedAccepted ?? accepted);
      // the reconciled scene already merged the banked live cache; the
      // old readback buffer is misaligned with the new slot order.
      labelPositionCache = null;
      adjacency = null;
      sceneIncidence = null;
      structuralChange = result.structuralChange;
      positionChange = result.positionChange;
    }

    // A transition-only force → fixed update has no model diff to drive the
    // reconciler. Freeze first, bank the engine's current positions, and
    // rebuild the scene from that cache so the structure commit below carries
    // the exact frame at which integration stopped. Dataset/scope changes
    // already took the same readback path above (a dataset swap deliberately
    // does not carry positions across identities).
    if (freezesForceLayout) {
      if (eng !== null && !pausedForFixedLayout) {
        eng.pause();
        pausedForFixedLayout = true;
      }
      if (!dataChanged && !scopeChanged && !groupsSceneDirty && !parallelSceneDirty && accepted !== null) {
        bankReadyEnginePositions();
        const result = reconcileScene(scopedAccepted ?? accepted);
        labelPositionCache = null;
        adjacency = null;
        sceneIncidence = null;
        structuralChange = structuralChange || result.structuralChange;
        positionChange = positionChange || result.positionChange;
      }
    }

    // --- 1c'. stage-4 clusters. Runs AFTER the stage-3
    // rewrite + reconcile so it partitions the CURRENT physical scene, and
    // BEFORE the config assembly below so its payload rides this update's one
    // commit. Stage-4 dirty flags ONLY: a `by` accessor identity change (or
    // spec add/clear) and upstream TOPOLOGY changes. Stage-5 soft-mask
    // changes (filter/brush/legend/hidden) are evaluated further down and
    // deliberately never reach this block. ---
    // Membership already re-derived inside any reconcile above; this block
    // owns the SPEC lane only. `by` identity drives membership; strength and
    // centers are pure downstream mappings that re-emit the engine payload
    // without re-deriving (they cannot change who belongs to what).
    const clusterDiagsBefore = clusterDiags;
    let clusterConfigDirty = false;
    if (update.clusters !== undefined) {
      if (update.clusters === null) {
        if (clusterSpec !== null) {
          clusterSpec = null; // D2 explicit clear: the engine force clears too
          deriveClusterState();
          clusterConfigDirty = true;
        }
      } else if (clusterSpec === null || clusterSpec.by !== update.clusters.by) {
        clusterSpec = update.clusters;
        deriveClusterState();
        clusterConfigDirty = true;
      } else if (
        clusterSpec.strength !== update.clusters.strength ||
        clusterSpec.centers !== update.clusters.centers
      ) {
        clusterSpec = update.clusters;
        if (clusterDerivation !== null) {
          clusterForceCenters = resolveClusterCenters(clusterDerivation.keys, clusterSpec.centers);
          if (!clusterCentroidsSettled) clusterAnchors = new Float32Array(clusterForceCenters);
        }
        clusterConfigPending = true;
        clusterConfigDirty = true;
      }
    }
    if (clusterConfigPending) {
      clusterConfigDirty = true;
      // under a FIXED layout every position is known at commit, so
      // centroids compute immediately — there is no settle event to wait for.
      if (nextLayout === 'fixed' && scene !== null) {
        refreshClusterCentroids(labelPositionCache ?? scene.positions);
      }
      if (noteClusterDegradation()) groupsDiagsChanged = true;
    }
    if (clusterDiags !== clusterDiagsBefore) groupsDiagsChanged = true;

    // --- 1d. metric-column admission (joined against the model this
    // SAME atomic update established — before dirty logic so a just-admitted
    // column can dirty exactly the scale channels referencing it). ---
    let metricsAdmitted: ReadonlySet<string> | null = null;
    let metricsProcessed = false;
    if (!metricsDeferredToWorker && update.metrics !== undefined && update.metrics.length > 0) {
      metricsProcessed = true;
      if (accepted === null || !ensureMetricModel()) {
        metricDiags = [
          {
            code: 'metric-column-error',
            severity: 'warning',
            count: update.metrics.length,
            sampleIds: update.metrics.slice(0, DIAGNOSTIC_SAMPLE_CAP).map((c) => c.metric),
            message: 'metric columns discarded: no accepted model to join against',
          },
        ];
      } else {
        const res = metricStore.admitColumns(update.metrics, {
          nodeIndex: accepted.nodeIndex,
          count: accepted.nodes.length,
          // I1: columns must be stamped with the revision current at ISSUE
          // time — never the post-update revision (that made the gate
          // self-satisfying).
          modelRevision: issuedModelSeq,
        });
        metricDiags = res.diagnostics;
        if (res.admitted.length > 0) {
          const set = new Set(res.admitted);
          metricsAdmitted = set;
          // a (re)joined column changes the metric's values without a
          // model-revision change — bump its generation so frozen domains
          // referencing it recompute on the next resolve.
          for (const name of set) metricColumnGen.set(name, (metricColumnGen.get(name) ?? 0) + 1);
        }
      }
    }

    // --- 2. styling channels: dirty on accessor identity change (Scale
    // descriptors compare by canonical structural key — equal literals never
    // reproject); a data OR scope change dirties all (buffer
    // sizes/content may shift) ---
    let dirtyNodeColor = dataChanged || scopeChanged || groupsSceneDirty || parallelSceneDirty;
    let dirtyNodeSize = dataChanged || scopeChanged || groupsSceneDirty || parallelSceneDirty;
    let dirtyLinkColor = dataChanged || scopeChanged || groupsSceneDirty || parallelSceneDirty;
    let dirtyLinkWidth = dataChanged || scopeChanged || groupsSceneDirty || parallelSceneDirty;
    if (update.nodeColor !== undefined && !sameChannelValue(update.nodeColor, nodeColor)) {
      nodeColor = update.nodeColor;
      dirtyNodeColor = true;
    }
    if (update.nodeSize !== undefined && !sameChannelValue(update.nodeSize, nodeSize)) {
      nodeSize = update.nodeSize;
      dirtyNodeSize = true;
    }
    if (update.linkColor !== undefined && !Object.is(update.linkColor, linkColor)) {
      linkColor = update.linkColor;
      dirtyLinkColor = true;
    }
    if (update.linkWidth !== undefined && !Object.is(update.linkWidth, linkWidth)) {
      linkWidth = update.linkWidth;
      dirtyLinkWidth = true;
    }
    // later-arriving admitted columns dirty ONLY the scale channels
    // referencing those metric names.
    if (metricsAdmitted !== null) {
      if (!dirtyNodeColor && scaleReferencesMetric(nodeColor, metricsAdmitted)) {
        dirtyNodeColor = true;
      }
      if (!dirtyNodeSize && scaleReferencesMetric(nodeSize, metricsAdmitted)) {
        dirtyNodeSize = true;
      }
    }
    // a nodeImage identity change re-feeds the atlas ref lane (below).
    // `null` is the explicit CLEAR transition — the accessor
    // drops and the ref push below drains the atlas to placeholders.
    let nodeImageChanged = false;
    if (update.nodeImage !== undefined && !Object.is(update.nodeImage ?? undefined, nodeImage)) {
      nodeImage = update.nodeImage ?? undefined;
      nodeImageChanged = true;
    }

    // --- 3. config (theme tokens, arrows, link toggle
    // all config-only: never a buffer rebuild by themselves) ---
    let configPatch: EngineConfigUpdate | undefined;
    let themeChanged = false;
    let mutedAlphaChanged = false;
    let emphasisToggled = false;
    let nodeBaseInvalidated = false;
    let linkBaseInvalidated = false;
    {
      const c: EngineConfigUpdate = {};
      let any = false;
      if (update.simulation !== undefined && !Object.is(update.simulation, simulation)) {
        simulation = update.simulation;
        c.simulation = update.simulation;
        any = true;
      }
      if (update.theme !== undefined) {
        const nextTheme = resolveTheme(update.theme);
        if (!sameTheme(nextTheme, theme)) {
          if (nextTheme.background !== theme.background) {
            c.backgroundColor = nextTheme.background;
            any = true;
          }
          if (nextTheme.nodeDefault !== theme.nodeDefault) {
            c.defaultPointColor = nextTheme.nodeDefault;
            any = true;
            // Scale channels render null-metric fallbacks in nodeDefault
            // a changed token re-projects them.
            if (isScaleValue(nodeColor)) dirtyNodeColor = true;
            // I5: a SYNTHESIZED base fill was built from the old token
            // drop it so the next compose rebuilds from the new theme.
            if (basePointColorsSynthesized) {
              basePointColors = null;
              nodeBaseInvalidated = true;
            }
          }
          if (nextTheme.edgeDefault !== theme.edgeDefault) {
            c.defaultLinkColor = nextTheme.edgeDefault;
            any = true;
            if (baseLinkColorsSynthesized) {
              baseLinkColors = null;
              linkBaseInvalidated = true;
            }
          }
          if (nextTheme.emphasisRing !== theme.emphasisRing) {
            c.emphasisRingColor = nextTheme.emphasisRing;
            any = true;
          }
          mutedAlphaChanged = nextTheme.mutedAlpha !== theme.mutedAlpha;
          // aggregate channels read theme tokens (accent for super-
          // nodes, edgeDefault for meta-edges) — a token change repaints the
          // synthetic suffix through full channel re-projection.
          if (
            groupRewrite !== null &&
            (nextTheme.accent !== theme.accent || nextTheme.nodeDefault !== theme.nodeDefault)
          ) {
            dirtyNodeColor = true;
          }
          if (groupRewrite !== null && nextTheme.edgeDefault !== theme.edgeDefault) {
            dirtyLinkColor = true;
          }
          theme = nextTheme;
          themeChanged = true;
        }
      }
      if (update.edgeArrows !== undefined && update.edgeArrows !== edgeArrows) {
        edgeArrows = update.edgeArrows;
        c.linkArrows = edgeArrows;
        any = true;
      }
      // dataRef: stash-only (serialization metadata, not rendering).
      if (update.dataRef !== undefined) dataRef = update.dataRef;
      if (update.showLinks !== undefined && update.showLinks !== showLinks) {
        showLinks = update.showLinks;
        c.renderLinks = showLinks;
        any = true;
      }
      // emphasis-ring toggle: state flips here; the engine write (clear
      // on off, hover restore on on) happens in step 9 where `eng` is live.
      if (update.emphasisRing !== undefined && update.emphasisRing !== emphasisRingOn) {
        emphasisRingOn = update.emphasisRing;
        emphasisToggled = true;
      }
      // stage-4: the cluster force is CONFIG-only — never a buffer
      // rebuild, never a structural diff. `null` clears it (D2); an engine
      // without `clusterForce` never sees the key (the normalizer
      // strips it at the sink) while membership and labels keep working.
      if (clusterConfigDirty) {
        c.cluster = clusterConfigPayload();
        any = true;
      }
      if (layoutChanged) layout = nextLayout;
      if (any) configPatch = c;
    }

    // --- 3b. overlay lanes: label config dirties the candidate
    // set; accessibility is stashed for getters/navigator consumers ---
    let labelsDirty = false;
    if (update.labels !== undefined && !Object.is(update.labels, labelsConfig)) {
      labelsConfig = update.labels;
      labelsDirty = true;
    }
    if (update.accessibility !== undefined && !Object.is(update.accessibility, accessibilityConfig)) {
      accessibilityConfig = update.accessibility;
    }
    // D7: searchIndex is CONSTRUCTION-ONLY (spec host construction options
    // read once; changing it requires a keyed remount). A runtime attempt is
    // ignored, never silently stashed as if it took effect: one warning per
    // instance. (Untyped callers only — the lane no longer exists on
    // GraphHostUpdate.)
    if ((update as { searchIndex?: unknown }).searchIndex !== undefined) {
      if (!searchIndexChangeWarned) {
        searchIndexChangeWarned = true;
        engineDiags = [
          ...engineDiags,
          {
            code: 'operation-rejected',
            severity: 'warning',
            count: 1,
            sampleIds: [],
            message:
              "searchIndex is construction-only: pass it to createGraphInstance options (or key-remount <Graph>) — this update's searchIndex was ignored",
          },
        ];
        searchIndexRejected = true;
      }
    }

    // --- 4. interaction slices: a dataset change clears
    // selection, hiddenNodeIds, and pins; an accepted-model change prunes
    // departed ids in the SAME publish (survival: kept ids stay selected); a
    // host-provided selection flips the NODE namespace to controlled and wins ---
    let nextSelection = prev.selection;
    let nextHidden = prev.hiddenNodeIds;
    let nextPins = prev.pins;
    let nextPinned = prev.pinnedNodeIds;
    if (datasetKeyChanged) {
      nextSelection = EMPTY_SELECTION;
      nextHidden = EMPTY_HIDDEN;
      nextPins = EMPTY_PINS;
      nextPinned = EMPTY_PINNED;
    } else if (dataChanged && accepted !== null) {
      const prunedNodes = pruneIds(nextSelection.nodeIds, accepted.nodeIndex);
      const prunedEdges = pruneIds(nextSelection.edgeIds, edgeIndexById);
      if (prunedNodes !== nextSelection.nodeIds || prunedEdges !== nextSelection.edgeIds) {
        nextSelection = {
          nodeIds: prunedNodes,
          edgeIds: prunedEdges,
          groupIds: nextSelection.groupIds,
        };
      }
      let anyHiddenDropped = false;
      for (const id of nextHidden) {
        if (!accepted.nodeIndex.has(id)) {
          anyHiddenDropped = true;
          break;
        }
      }
      if (anyHiddenDropped) {
        const kept = new Set<NodeId>();
        for (const id of nextHidden) if (accepted.nodeIndex.has(id)) kept.add(id);
        nextHidden = kept;
      }
      let anyPinDropped = false;
      for (const id of nextPins.keys()) {
        if (!accepted.nodeIndex.has(id)) {
          anyPinDropped = true;
          break;
        }
      }
      if (anyPinDropped) {
        const kept = new Map<NodeId, readonly [number, number]>();
        for (const [id, xy] of nextPins) if (accepted.nodeIndex.has(id)) kept.set(id, xy);
        nextPins = kept;
      }
      // persistent pins prune departed ids through the SAME
      // ownership path (the store mirrors effective state in BOTH modes
      // the selection precedent).
      let anyPinnedDropped = false;
      for (const id of nextPinned) {
        if (!accepted.nodeIndex.has(id)) {
          anyPinnedDropped = true;
          break;
        }
      }
      if (anyPinnedDropped) {
        const kept = new Set<NodeId>();
        for (const id of nextPinned) if (accepted.nodeIndex.has(id)) kept.add(id);
        nextPinned = kept;
      }
    }
    // A changed groups RESOLUTION prunes selected
    // group ids that no longer name a resolved group — the SAME ownership
    // path in controlled and uncontrolled selection modes (the group
    // namespace is never host-controlled). Ids never resolved (tolerant raw
    // writes) also drop here, at the first resolution change.
    if (groupsResolutionChanged && nextSelection.groupIds.length > 0) {
      const keep = new Set<string>();
      for (const group of resolvedGroups) keep.add(group.id);
      const prunedGroupIds = nextSelection.groupIds.filter((id) => keep.has(id));
      if (prunedGroupIds.length !== nextSelection.groupIds.length) {
        nextSelection = { ...nextSelection, groupIds: prunedGroupIds };
      }
    }
    if (update.selection !== undefined) {
      selectionControlled = true;
      if (!sameIds(nextSelection.nodeIds, update.selection)) {
        nextSelection = { ...nextSelection, nodeIds: update.selection };
      }
    }
    // Persistent pins: a HOST
    // update carrying the lane (null included) flips it controlled — op
    // writes ride pinsInternalWrite and never flip. Ids validate against
    // the accepted model (unknown ids drop — there is no slot to pin);
    // `null` clears (D2). Only uncontrolled OP writes record history
    // (host-owned state is not undoable — the selection precedent).
    if (update.pinnedNodeIds !== undefined) {
      if (!pinsInternalWrite) pinnedControlled = true;
      const wanted = update.pinnedNodeIds ?? EMPTY_IDS;
      const next = new Set<NodeId>();
      if (accepted !== null) {
        for (const id of wanted) {
          if (accepted.nodeIndex.has(id)) next.add(id);
        }
      }
      if (!sameIdSet(next, nextPinned)) {
        if (pinsInternalWrite) {
          historyKernel.record('pinnedNodes', [...nextPinned], [...next]);
        }
        nextPinned = next;
      }
    }
    const selectionChanged = !sameSelection(nextSelection, prev.selection);
    const selectedNodesChanged = !sameIds(nextSelection.nodeIds, prev.selection.nodeIds);
    const hiddenChanged = nextHidden !== prev.hiddenNodeIds;
    const pinsChanged = nextPins !== prev.pins;
    const pinnedChanged = nextPinned !== prev.pinnedNodeIds;
    const hoverCleared =
      datasetKeyChanged && (prev.hover.nodeId !== null || prev.hover.edgeId !== null);

    // --- 4b. filter prop + crossfilter prop + mask maintenance.
    // Runs BEFORE projection so re-projected buffers compose the mask. ---
    let filterChanged = false;
    if (update.filter !== undefined) {
      if (update.filter === null) {
        if (activeFilterSpec !== null) {
          activeFilterSpec = null;
          activeFilterKey = null;
          activeFilterMode = 'hide';
          compiledNodeSelector = null;
          compiledEdgeSelector = null;
          filterChanged = true;
        }
      } else {
        const key = canonicalFilterKey(update.filter);
        if (key !== activeFilterKey) {
          activeFilterSpec = update.filter;
          activeFilterKey = key;
          activeFilterMode = update.filter.mode ?? 'hide';
          compiledNodeSelector = compileNodeFilter<N, E>(update.filter);
          compiledEdgeSelector = compileEdgeFilter<N, E>(update.filter);
          filterChanged = true;
        }
        // else: canonical-equal spec — ZERO re-evaluation, zero commits.
      }
    }

    let crossfilterResync = false;
    let crossfilterRebuilt = false;
    const specsChanged =
      update.crossfilter !== undefined && !sameDimensionSpecs(update.crossfilter, crossfilterSpecs);
    const prevCrossfilterSpecs = crossfilterSpecs;
    if (specsChanged) crossfilterSpecs = update.crossfilter!;
    if (crossfilterSpecs !== null) {
      if (accepted === null) {
        if (specsChanged && crossfilterEngine !== null) {
          disposeCrossfilter();
          crossfilterResync = true;
        }
      } else if (crossfilterEngine === null || specsChanged) {
        // Dimension-spec identity/shape change (or first data): full rebuild;
        // build clears brushes and the external mask. D3: a failed
        // candidate build restores the previous specs — the live engine,
        // brushes, and facade were never touched.
        const hadBrushHidden = crossfilterHiddenBase.size > 0;
        if (buildCrossfilterEngine()) {
          crossfilterResync = hadBrushHidden;
          crossfilterRebuilt = true;
        } else if (specsChanged) {
          crossfilterSpecs = prevCrossfilterSpecs;
          crossfilterRejected = true;
        } else {
          // First build over fresh data failed (e.g. a throwing `get`):
          // the specs are unusable — drop them rather than re-fail forever.
          crossfilterSpecs = null;
          crossfilterRejected = true;
        }
      } else if (dataChanged) {
        crossfilterResync = syncCrossfilterModel(datasetKeyChanged);
      }
    }

    const sceneRebuilt =
      (dataChanged || scopeChanged || groupsSceneDirty || parallelSceneDirty) && scene !== null;
    let maskMutated = false;
    let filterDiagsChanged = false;
    if (sceneRebuilt) {
      // Structural change: memberships rebuild from definitions (slot
      // indices shifted); the full re-projection below composes the mask.
      filterDiagsChanged = rebuildMaskMemberships(nextHidden);
    } else if ((filterChanged || crossfilterResync) && scene !== null) {
      if (activeFilterSpec !== null || softMask !== null) {
        const beforeDiags = filterDiags;
        ensureMask();
        if (filterChanged) evaluateFilterMembership();
        if (crossfilterResync) refreshBrushMembership();
        refreshGroupMaskMembership(nextHidden);
        cascadeNodeMask();
        maskMutated = true;
        filterDiagsChanged = filterDiags !== beforeDiags;
      }
    }
    if (
      crossfilterEngine !== null &&
      (sceneRebuilt || filterChanged || hiddenChanged || crossfilterResync || crossfilterRebuilt)
    ) {
      refreshCrossfilterExternalMask(nextHidden);
    }

    // fast path inside the atomic update: a filter/brush-membership
    // change WITHOUT a structural change drains into alpha-only buffers.
    let maskBuffers: EngineCommit['buffers'] | undefined;
    let maskAffected = false;
    if (maskMutated && softMask !== null && scene !== null) {
      const drain = softMask.drainDirty();
      const nodesAffected = drain.nodes.length > 0 || drain.nodesAlpha.length > 0;
      const edgesAffected = drain.edges.length > 0 || drain.edgesAlpha.length > 0;
      maskAffected = nodesAffected || edgesAffected;
      if (maskAffected) {
        nodeAlphaComposer.reset(); // drain unobserved by composers
        edgeAlphaComposer.reset();
        maskBuffers = {};
        if (nodesAffected) maskBuffers.pointColor = composeNodeAlphaBuffer(basePointColorBuffer());
        if (edgesAffected) maskBuffers.linkColor = composeEdgeAlphaBuffer(baseLinkColorBuffer());
      }
    }
    if (maskAffected) {
      // the visible set changed — 'visible'-scoped domains recompute
      // and their scale channels re-project in this same atomic update.
      visibleGen += 1;
      if (!dirtyNodeColor && scaleUsesVisibleDomain(nodeColor)) dirtyNodeColor = true;
      if (!dirtyNodeSize && scaleUsesVisibleDomain(nodeSize)) dirtyNodeSize = true;
    }
    // A mutedAlpha token change recomposes the dim alphas from the
    // cached bases (no re-projection, no scope-revision advance — only the
    // alpha REPRESENTATION changed, never visibility). I5 extends this to
    // theme default-token changes while masked: an invalidated SYNTHESIZED
    // base recomposes from the new theme so masked no-accessor scenes track
    // the active theme instead of a stale fill.
    if ((mutedAlphaChanged || nodeBaseInvalidated || linkBaseInvalidated) && softMask !== null && scene !== null) {
      maskBuffers = maskBuffers ?? {};
      if ((mutedAlphaChanged || nodeBaseInvalidated) && maskBuffers.pointColor === undefined) {
        maskBuffers.pointColor = composeNodeAlphaBuffer(basePointColorBuffer());
      }
      if ((mutedAlphaChanged || linkBaseInvalidated) && maskBuffers.linkColor === undefined) {
        maskBuffers.linkColor = composeEdgeAlphaBuffer(baseLinkColorBuffer());
      }
    }

    // --- 5. assemble at most one engine commit ---
    phaseProjectStart = performance.now();
    let buffers = projectChannelBuffers({
      nodeColor: dirtyNodeColor,
      nodeSize: dirtyNodeSize,
      linkColor: dirtyLinkColor,
      linkWidth: dirtyLinkWidth,
    });
    if (maskBuffers !== undefined) {
      // Freshly projected channels already composed the mask — they win.
      buffers = buffers === undefined ? maskBuffers : { ...maskBuffers, ...buffers };
    }
    let structure: EngineCommit['structure'] | undefined;
    if ((structuralChange || positionChange || freezesForceLayout) && scene !== null) {
      structure = { pointCount: scene.count, positions: scene.positions, links: scene.links };
    }
    const commitNeeded =
      structure !== undefined ||
      buffers !== undefined ||
      configPatch !== undefined ||
      (activatesForceLayout && scene !== null);

    // --- 6. revisions: model+scope on accepted model change; render on every
    // desired-render publication (even while detached — replay catches up).
    // scope/model split (first genuine divergence, v0.5): a SCOPE-ONLY
    // subgraph change advances scopeRevision AND render but NOT
    // modelRevision — the accepted model is untouched, only the rendered
    // subset changed. ---
    let revisions = prev.revisions;
    if (dataChanged || scopeChanged || groupsSceneDirty || parallelSceneDirty || commitNeeded) {
      revisions = { ...prev.revisions };
      if (dataChanged && accepted !== null) {
        revisions.model += 1;
        revisions.source = accepted.sourceRevision;
      }
      // mask-affecting publishes advance scope+render, NEVER model.
      // a group collapse/expand — and the parallel-edge
      // toggle — is a SCOPE-driven publication: it advances scopeRevision,
      // never modelRevision.
      if (
        (dataChanged && accepted !== null) ||
        scopeChanged ||
        maskAffected ||
        groupsSceneDirty ||
        parallelSceneDirty
      ) {
        revisions.scope += 1;
      }
      if (commitNeeded) revisions.render += 1;
    }

    // --- 7. at most one engine commit ---
    let simRestarted = false;
    let imageRefsPushed = false;
    if (commitNeeded && eng !== null) {
      const commit: EngineCommit = { revision: revisions.render };
      if (structure !== undefined) {
        commit.structure = structure;
        // Pair the new roster with ITS point→slot index in the
        // SAME commit — resolved+delivered slots, placeholders otherwise;
        // the async flush afterwards only promotes placeholders.
        const syncIndex = structuralPointImageIndex();
        if (syncIndex !== null) commit.resources = { pointImageIndex: syncIndex };
        imageRefsPushed = true;
      }
      if (buffers !== undefined) commit.buffers = buffers;
      if (configPatch !== undefined) commit.config = configPatch;
      if (activatesForceLayout && scene !== null) {
        // A kind transition explicitly activates the live layout. When the
        // model is unchanged this is a restart-only commit: the engine keeps
        // its banked positions and no structural buffers are reset.
        commit.restart = { alpha: 1 };
        simRestarted = true;
      } else if (structure !== undefined && layout === 'force') {
        // reflow: a scope-only commit restarts by default so the layout
        // reorganizes around what remains; `reflow: false` keeps simulation
        // state. Clearing (subgraph: null) always reflows the restored base.
        const scopeOnly = scopeChanged && !dataChanged;
        const reflow = !scopeOnly || scopeSpec === null || scopeSpec.reflow !== false;
        if (reflow) {
          commit.restart = { alpha: 1 };
          simRestarted = true;
        }
      }
      const phaseUploadStart = performance.now();
      commitToEngine(eng, commit);
      lastCommitMs = {
        kind: structure !== undefined ? (scopeChanged && !dataChanged ? 'scope' : 'model') : buffers !== undefined ? 'mask' : 'config',
        validate: 0,
        derive: phaseProjectStart - phaseT0,
        project: phaseUploadStart - phaseProjectStart,
        upload: performance.now() - phaseUploadStart,
      };
      revisions.appliedRender = eng.appliedRevision();
      // fallback picking: a restart makes targets move — DISARM until the
      // next settle; a structural commit WITHOUT a restart (fixed layout) is a
      // position sync — rebuild over the new scene snapshot.
      const facade = session !== null ? session.edgePicking : null;
      if (facade !== null) {
        if (commit.restart !== undefined && commit.restart !== false) {
          facade.disarm();
        } else if (structure !== undefined && scene !== null) {
          facade.arm(scene.positions, scene.links);
        }
      }
    }

    // --- 7b. candidate re-rank on accepted-model / label-config change
    // (throttled trigger class (b)/(c) — the store patch below folds in the
    // overload diagnostic so this stays ONE publication) ---
    let labelRerank: { setChanged: boolean; diagsChanged: boolean } = {
      setChanged: false,
      diagsChanged: false,
    };
    if (
      dataChanged ||
      scopeChanged ||
      groupsSceneDirty ||
      parallelSceneDirty ||
      labelsDirty ||
      maskAffected ||
      clusterConfigDirty
    ) {
      labelRerank = recomputeCandidates();
    }

    // --- 8. exactly one store publication ---
    const patch: Partial<GraphStoreState> = {};
    let changed = false;
    if (revisions !== prev.revisions) {
      patch.revisions = revisions;
      changed = true;
    }
    if (dataChanged && accepted !== null) {
      patch.nodeCount = accepted.nodes.length;
      patch.edgeCount = accepted.edges.length;
      changed = true;
    }
    {
      const nextVisible = computeVisibleCounts();
      if (!sameVisible(nextVisible, prev.visible)) {
        patch.visible = nextVisible;
        changed = true;
      }
    }
    if (datasetKeyChanged && prev.timeline.playingKey !== null) {
      patch.timeline = { playingKey: null };
      changed = true;
    }
    if (
      dataChanged ||
      datasetKeyChanged ||
      buffers !== undefined ||
      labelRerank.diagsChanged ||
      filterDiagsChanged ||
      metricsProcessed ||
      searchIndexRejected ||
      crossfilterRejected ||
      columnarRejected ||
      parallelRejected ||
      groupsDiagsChanged ||
      diagnosticsForced
    ) {
      patch.diagnostics = composeDiagnostics();
      changed = true;
    }
    // store.groups mirrors the current resolution (E1: this rides the
    // update's single publication).
    if (groupsResolutionChanged) {
      patch.groups = resolvedGroups;
      changed = true;
    }
    // folds ride the same single publication (E1).
    const nextFoldCounts = foldCountsIfChanged(prev.folds);
    if (nextFoldCounts !== null) {
      patch.folds = nextFoldCounts;
      changed = true;
    }
    if (themeChanged) {
      patch.theme = theme;
      changed = true;
    }
    if (overlayIdsCleared) {
      patch.overlayIds = EMPTY_OVERLAY_IDS;
      changed = true;
    }
    if (datasetKeyChanged && prev.pendingExpansions.size > 0) {
      patch.pendingExpansions = EMPTY_EXPANSIONS;
      changed = true;
    }
    // the search slice is per-dataset — a swap clears it.
    if (datasetKeyChanged && prev.search !== null) {
      patch.search = null;
      changed = true;
    }
    if (scopeChanged) {
      patch.scope = scopeSpec;
      changed = true;
    }
    if (freezesForceLayout && prev.simulationRunning) {
      patch.simulationRunning = false;
      changed = true;
    } else if (simRestarted && !prev.simulationRunning) {
      patch.simulationRunning = true;
      changed = true;
    }
    if (selectionChanged) {
      patch.selection = nextSelection;
      changed = true;
    }
    if (hiddenChanged) {
      patch.hiddenNodeIds = nextHidden;
      changed = true;
    }
    if (pinsChanged) {
      patch.pins = nextPins;
      changed = true;
    }
    if (pinnedChanged) {
      patch.pinnedNodeIds = nextPinned;
      changed = true;
    }
    if (hoverCleared) {
      patch.hover = { nodeId: null, edgeId: null };
      changed = true;
    }
    if (changed) publish(patch);

    // --- 9. non-commit engine pushes: highlight remap — selection, pins,
    // and hover focus are re-pushed with freshly mapped indices after any
    // structural change; changed slices are mirrored regardless ---
    if (eng !== null) {
      const selectedGroupsChanged = !sameIds(nextSelection.groupIds, prev.selection.groupIds);
      if (
        selectedNodesChanged ||
        selectedGroupsChanged ||
        (structuralChange &&
          (nextSelection.nodeIds.length > 0 || nextSelection.groupIds.length > 0))
      ) {
        pushSelectionToEngine(eng, nextSelection.nodeIds);
      }
      if (
        pinsChanged ||
        pinnedChanged ||
        (structuralChange && (nextPins.size > 0 || nextPinned.size > 0))
      ) {
        // Persistent pins re-push after every structural commit — indices
        // shift; the union sink reads the just-published slice.
        pushPinsToEngine(eng, nextPins);
      }
      if (structuralChange && emphasizedNodeId !== null && scene !== null && !scene.indexById.has(emphasizedNodeId)) {
        emphasizedNodeId = null; // departed — never resurrect
      }
      if (structuralChange && !hoverCleared && prev.hover.nodeId !== null && scene !== null) {
        const idx = scene.indexById.get(prev.hover.nodeId);
        if (idx !== undefined) applyEmphasis(eng, idx);
      } else if (structuralChange && emphasizedNodeId !== null && scene !== null) {
        const idx = scene.indexById.get(emphasizedNodeId);
        if (idx !== undefined) applyEmphasis(eng, idx);
      }
      // emphasis-ring toggle: OFF is the one clearing write applyEmphasis
      // will never make again; ON restores the current hover ring, else the
      // sticky keyboard target.
      if (emphasisToggled) {
        if (!emphasisRingOn) {
          eng.setFocusedIndex(null);
        } else if (!hoverCleared && prev.hover.nodeId !== null && scene !== null) {
          const idx = scene.indexById.get(prev.hover.nodeId);
          if (idx !== undefined) applyEmphasis(eng, idx);
        } else if (emphasizedNodeId !== null && scene !== null) {
          const idx = scene.indexById.get(emphasizedNodeId);
          if (idx !== undefined) applyEmphasis(eng, idx);
        }
      }
      if (commitNeeded) maybeFitView(eng);
    }

    // --- 9b. image refs: the roster or the accessor changed — re-feed
    // the atlas lane (batches land later as resources-only commits). ---
    if ((dataChanged || scopeChanged || nodeImageChanged) && !imageRefsPushed) pushImageRefs();

    // --- 10. candidate fan-out (after the store is consistent) ---
    if (labelRerank.setChanged) notifyLabelSubs(candidateSubs);

    // --- 11. groupBy is always instance-derived
    // (uncontrolled semantics) — a changed derivation NOTIFIES the host
    // after the store is consistent. Manual-lane changes notify from the
    // ops themselves; host `groups` prop writes never re-notify. ---
    if (groupsResolutionChanged && groupBySpec !== null && groupsSpec === null) {
      emit('groupsChange', { groups: resolvedGroups });
    }
  }

  // -------------------------------------------------------------------------
  // Engine lifecycle
  // -------------------------------------------------------------------------

  function createHostEvents(s: MountSession): EngineHostEvents {
    const active = (): boolean => session === s && s.alive && !destroyed;
    return {
      onPointClick(index, modifiers) {
        if (!active()) return;
        // a mask-hidden node is not there — background semantics.
        // Synthetic slots consult the SAME mask (stage-5 group source).
        if (index !== null && !maskNodeVisibleAt(index)) index = null;
        if (index === null) {
          // built-in follow-up (runs AFTER the listener chain): a
          // background click clears ALL namespaces; preventDefault cancels it.
          const prevented = emit('backgroundClick', {});
          if (!prevented) applySelectionIntent(EMPTY_SELECTION);
          return;
        }
        const meta = modifiers !== undefined && (modifiers.metaKey || modifiers.shiftKey);
        // Discriminated slot mapping — a super-node
        // hit fires the typed GROUP event with the ResolvedGroup payload
        // (internal scene keys never escape); physical hits keep firing the
        // caller-typed node callback below.
        const ref = scene === null ? null : scenePointRefAt(scene, index);
        if (ref !== null && ref.kind === 'group') {
          const prevented = emit('groupClick', { group: ref.group, metaKey: meta });
          if (prevented) return;
          // built-in follow-up: select the GROUP id into the groupIds
          // namespace (plain replaces, meta/shift toggles) — never nodeIds.
          const cur = store.getState().selection;
          applySelectionIntent({
            ...cur,
            groupIds: meta ? orderGroupIds(toggleId(cur.groupIds, ref.group.id)) : [ref.group.id],
          });
          return;
        }
        const node = nodeAtIndex(index);
        if (node === undefined) return;
        const prevented = emit('nodeClick', { node, metaKey: meta });
        if (prevented) return;
        // built-in follow-up: plain click replaces the node selection;
        // meta/shift click toggles the id (accepted-base order preserved).
        const cur = store.getState().selection;
        applySelectionIntent({
          ...cur,
          nodeIds: meta
            ? orderByAcceptedBase(toggleId(cur.nodeIds, node.id), nodeIndexBase())
            : [node.id],
        });
      },
      onPointHover(index) {
        if (!active()) return;
        // hovering a mask-hidden index reads as background (null).
        if (index !== null && !maskNodeVisibleAt(index)) index = null;
        const node = index === null ? null : (nodeAtIndex(index) ?? null);
        const nodeId = node === null ? null : node.id;
        const hover = store.getState().hover;
        if (hover.nodeId !== nodeId) publish({ hover: { nodeId, edgeId: hover.edgeId } });
        // Pointer activity over the canvas takes the emphasis channel: the
        // sticky keyboard target is superseded, never resurrected by replay.
        emphasizedNodeId = null;
        applyEmphasis(s.engine, node === null ? null : index);
        emit('nodeHover', { node });
      },
      // native-route edge events. Host onLink* events are
      // honored regardless of the committed route — an adapter that surfaces
      // them despite declaring linkPicking:false is a harmless pass-through
      // but only the 'native' route RELIES on them; the fallback route feeds
      // the same typed events through the pointer samplers.
      onLinkClick(linkIndex) {
        if (!active()) return;
        // native-route link events are filtered through the SAME
        // mask the fallback facade consults — both routes agree.
        if (!maskEdgeVisibleAt(linkIndex)) return;
        // A meta-edge hit fires the typed MetaEdge event;
        // synthetics never cast to E.
        const ref = scene === null ? null : sceneLinkRefAt(scene, linkIndex);
        if (ref !== null && ref.kind === 'meta-edge') {
          emit('metaEdgeClick', { metaEdge: ref.metaEdge }); // no follow-up
          return;
        }
        const edge = edgeAtLinkIndex(linkIndex);
        if (edge === undefined) return;
        emit('edgeClick', { edge }); // no built-in follow-up in this slice
      },
      onLinkHover(linkIndex) {
        // defer-link-picking: while engaged, edge hover is
        // armed only at rest — NEW hovers mid-simulation are dropped on
        // BOTH routes (the fallback samplers share the applyEdgeHover
        // gate). The CLEARING null always passes: a hover that started
        // before engagement must not linger as stale state.
        if (
          linkIndex !== null &&
          degradeController.isEngaged('defer-link-picking') &&
          store.getState().simulationRunning
        ) {
          return;
        }
        if (!active()) return;
        if (linkIndex !== null && !maskEdgeVisibleAt(linkIndex)) linkIndex = null;
        const edge = linkIndex === null ? null : (edgeAtLinkIndex(linkIndex) ?? null);
        applyEdgeHover(edge, false); // engine owns transition detection
      },
      onDragStart(index) {
        if (!active()) return;
        const node = nodeAtIndex(index);
        if (node === undefined) return;
        emit('nodeDragStart', { node }); // no built-in follow-up
      },
      onDragEnd(index, x, y) {
        if (!active()) return;
        const node = nodeAtIndex(index);
        if (node === undefined) return;
        // built-in follow-up (runs AFTER the listener chain): pin the
        // node at its release position; preventDefault cancels the pin. Pins
        // are always instance-owned, even under controlled selection.
        const prevented = emit('nodeDragEnd', { node, x, y });
        if (!prevented) writePin(node.id, [x, y]);
      },
      // Right-click or long-press → typed 'contextMenu' event. The
      // core adds NO built-in follow-up — components own the menu.
      onContextMenu(index, screen) {
        if (!active()) return;
        const screenPt = [screen[0], screen[1]] as const;
        if (index === null) {
          emit('contextMenu', { target: { kind: 'background' }, screen: screenPt });
          return;
        }
        const node = nodeAtIndex(index);
        if (node === undefined) return; // stale index — drop the gesture
        emit('contextMenu', { target: { kind: 'node', node }, screen: screenPt });
      },
      /**
       * Overlay scheduler tick (adapter activity clock). Per tick:
       * (1) sim-hot degradation — while the simulation runs, ONE getPositions
       * readback refreshes the CPU cache at a capped >=500ms cadence (M0:
       * tracked readback stalls ~18ms, so the lane NEVER reads back per
       * frame); (2) O(k) projection of the CURRENT candidate set through
       * spaceToScreen for the positions channel. No re-rank ever happens here.
       */
      onFrame(timeMs) {
        if (!active()) return;
        frameCadence += 1; // the ONE hit-test/overlay cadence clock
        // O(1) pressure accounting per tick; a tick while the
        // sim is settled is an idle wakeup (0 = the gated clock is honest).
        pressureSampler.noteFrame(timeMs, !store.getState().simulationRunning);
        flushCrossfilterNotify(); // batch-histograms: one batch per frame
        if (timeMs - lastPerfSampleAt >= PERF_SAMPLE_THROTTLE_MS) {
          lastPerfSampleAt = timeMs;
          // frame-pressure trigger: sustained EWMA over the
          // engage bound pulls the cheap steps in EARLY; recovery below the
          // clear bound releases them (asymmetric bounds + the controller's
          // dwell = the anti-flap stack).
          const ewma = pressureSampler.snapshot().frameEwmaMs;
          if (Number.isFinite(ewma)) {
            const vis = store.getState().visible;
            const visible = { nodes: vis.nodes, edges: vis.edges };
            if (ewma > FRAME_PRESSURE_ENGAGE_MS) {
              for (const step of ['cap-dom-labels', 'defer-link-picking'] as const) {
                const event = degradeController.engageForPressure(step, 'frame-pressure', visible);
                if (event !== null) applyDegradeEvent(event);
              }
            } else if (ewma < FRAME_PRESSURE_CLEAR_MS) {
              for (const step of ['cap-dom-labels', 'defer-link-picking'] as const) {
                const event = degradeController.clearPressure(step, visible);
                if (event !== null) applyDegradeEvent(event);
              }
            }
          }
          if ((listeners.get('perfSample')?.size ?? 0) > 0) {
            emit('perfSample', getPerfSnapshot());
          }
          pressureSampler.resetCounters(); // counters are per-sample-period
        }
        if (store.getState().simulationRunning && labelsEnabled()) {
          if (
            lastHotRefreshMs === null ||
            timeMs - lastHotRefreshMs >= SIM_HOT_REFRESH_MS ||
            timeMs < lastHotRefreshMs // clock went backwards (fresh adapter)
          ) {
            lastHotRefreshMs = timeMs;
            const pos = s.engine.getPositions();
            if (pos !== null) bankEnginePositions(pos);
          }
        }
        if (positionSubs.size > 0 && currentPlacements.length > 0) {
          projectPlacements(s.engine);
          notifyLabelSubs(positionSubs);
        }
      },
      onViewportChange(v) {
        if (!active()) return;
        publish({ viewport: v });
        emit('viewportChange', v);
        // semantic zoom: hysteresis band tracking over the
        // stashed groupBySpec.semanticZoom thresholds.
        trackSemanticZoomBand(v.zoom);
        scheduleViewportRerank(); // trigger (a): trailing 100ms throttle
      },
      onSimulationEnd() {
        if (!active()) return;
        // Release pinned accretion — the expansion's arrivals settled,
        // so the engine pin set returns to just the user pin slice.
        if (accretionPinIds !== null) {
          accretionPinIds = null;
          pushPinsToEngine(s.engine, store.getState().pins);
        }
        // per-event readback: settled positions feed the position cache
        // AND re-arm fallback edge picking over the same snapshot.
        const pos = s.engine.getPositions();
        if (pos !== null) {
          bankEnginePositions(pos);
          if (s.edgePicking !== null && scene !== null) {
            s.edgePicking.arm(pos, scene.links);
          }
          // Settle is where cluster centroids refresh — the ONLY
          // member scan in the overlay lane, over the SAME permitted
          // readback. Cluster labels re-anchor from forceCenter
          // to centroid on the re-rank/projection below.
          refreshClusterCentroids(pos);
        }
        // trigger (d): settle re-rank — folded with the simulationRunning
        // transition into one publish.
        const r = recomputeCandidates();
        const patch: Partial<GraphStoreState> = {};
        if (store.getState().simulationRunning) patch.simulationRunning = false;
        if (r.diagsChanged) patch.diagnostics = composeDiagnostics();
        if (patch.simulationRunning !== undefined || patch.diagnostics !== undefined) {
          publish(patch);
        }
        if (r.setChanged) notifyLabelSubs(candidateSubs);
        else if (clusterDerivation !== null && currentPlacements.length > 0) {
          // The cluster SET is unchanged but its anchors moved from force
          // centers to settled centroids — re-anchor through the position
          // channel (no re-render for a set that did not change).
          projectPlacements(s.engine);
          notifyLabelSubs(positionSubs);
        }
        emit('simulationEnd', {});
        armQuiescenceAssertion(); // dev-only tripwire (one-shot)
      },
      onError(error) {
        if (!active()) return;
        const status = store.getState().status;
        if (status === 'mounting') {
          emitInstanceError({ code: 'engine-unsupported', detail: error.message }, 'mount', error);
          return;
        }
        if (status === 'lost' || status === 'recovering') {
          emitInstanceError({ code: 'context-lost' }, 'recovery', error);
          return;
        }
        // v0.1 behavior: running-phase engine faults carry no GraphError detail.
        engineDiags = [
          ...engineDiags,
          {
            code: 'engine-error',
            severity: 'error',
            count: 1,
            sampleIds: [],
            message: error.message,
          },
        ];
        publish({ status: 'error', diagnostics: composeDiagnostics() });
        emit('error', { error });
      },
      onContextEvent(ev) {
        if (!active()) return;
        const status = store.getState().status;
        if (ev.type === 'lost') {
          // transient loss is a status transition + warning diagnostic,
          // never an 'error' event. Only meaningful from 'ready'.
          if (status !== 'ready') return;
          engineDiags = [
            ...engineDiags,
            {
              code: 'context-lost',
              severity: 'warning',
              count: 1,
              sampleIds: [],
              message: 'WebGL context lost; engine frozen, awaiting restore',
            },
          ];
          publish({ status: 'lost', diagnostics: composeDiagnostics() });
          return;
        }
        if (ev.type === 'restored') {
          if (status !== 'lost') return;
          publish({ status: 'recovering' });
          try {
            // Coalesced full replay: updates applied while lost advanced the
            // desired revisions CPU-side; ONE commit now realizes the latest.
            const restarted =
              buildAndCommitFullReplay(s, layout === 'force' ? RECOVERY_RESTART_ALPHA : null) &&
              accepted !== null &&
              layout === 'force';
            const { viewport } = store.getState();
            if (viewport !== null) s.engine.setViewport(viewport);
            // highlight remap: recovery re-applies selection, pins, and
            // hover focus from the store with freshly mapped indices.
            reapplyInteractionState(s.engine);
            publish({
              status: 'ready',
              revisions: { ...store.getState().revisions, appliedRender: s.engine.appliedRevision() },
              ...(restarted ? { simulationRunning: true } : {}),
            });
          } catch (err) {
            emitInstanceError({ code: 'context-lost' }, 'recovery', err as Error);
          }
          return;
        }
        // ev.type === 'failed': terminal only while a recovery is possible.
        if (status === 'lost' || status === 'recovering') {
          emitInstanceError({ code: 'context-lost' }, 'recovery', ev.error);
        }
      },
      onDiagnostic(d) {
        if (!active()) return;
        engineDiags = [
          ...engineDiags,
          { code: d.code, severity: d.severity, count: 1, sampleIds: [], message: d.message },
        ];
        publish({ diagnostics: composeDiagnostics() });
      },
    };
  }

  /**
   * Replay the LATEST desired state as ONE commit: re-reconcile so cached
   * positions (banked at detach / simulation end) land in the structure.
   * `restartAlpha` null = keep simulation state (fixed layout / no reheat).
   * Returns whether a commit was issued.
   */
  function buildAndCommitFullReplay(s: MountSession, restartAlpha: number | null): boolean {
    const eng = s.engine;
    // The replay IS a real commit — for a pre-ready data
    // apply it is the FIRST upload (the S-tier first-paint site), so the
    // phase clock stamps here too. `derive` covers the re-reconcile,
    // `project` the channel/atlas rebuild, `upload` the engine commit.
    const phaseT0 = performance.now();
    const renderRevision = store.getState().revisions.render;
    const replayModel = renderModel(); // the scoped subset replays, not the full model
    if (replayModel !== null) {
      // the replay re-runs stage 3 too (deterministic — same model +
      // resolved groups reproduce the same rewritten scene).
      reconcileScene(replayModel);
      const replayScene = scene!;
      const phaseProjectStart = performance.now();
      const commit: EngineCommit = {
        revision: renderRevision,
        structure: {
          pointCount: replayScene.count,
          positions: replayScene.positions,
          links: replayScene.links,
        },
      };
      const buffers = projectChannelBuffers({
        nodeColor: true,
        nodeSize: true,
        linkColor: true,
        linkWidth: true,
      });
      if (buffers !== undefined) commit.buffers = buffers;
      commit.config = fullConfig();
      // A replay re-sends the FULL delivered atlas state — the
      // restored GL machine is empty and slot references must resolve.
      const resources = replayAtlasResources();
      if (resources !== null) commit.resources = resources;
      // The index must align to the roster REPLAYED ABOVE, not
      // the roster that was live when the atlas last flushed (the model may
      // have changed while lost/pre-ready) — recompute it synchronously.
      const syncIndex = structuralPointImageIndex();
      if (syncIndex !== null) {
        commit.resources = { ...(commit.resources ?? {}), pointImageIndex: syncIndex };
      }
      if (restartAlpha !== null) commit.restart = { alpha: restartAlpha };
      const phaseUploadStart = performance.now();
      commitToEngine(eng, commit);
      lastCommitMs = {
        kind: 'model',
        validate: 0,
        derive: phaseProjectStart - phaseT0,
        project: phaseUploadStart - phaseProjectStart,
        upload: performance.now() - phaseUploadStart,
      };
      // a reheating replay disarms fallback picking until the next
      // settle; a no-restart replay (fixed layout) is a position sync.
      if (s.edgePicking !== null) {
        if (restartAlpha !== null) s.edgePicking.disarm();
        else s.edgePicking.arm(replayScene.positions, replayScene.links);
      }
      return true;
    }
    // No model yet: the theme/config tokens still flow (the background
    // is painted before data arrives).
    commitToEngine(eng, { revision: renderRevision, config: fullConfig() });
    return true;
  }

  function handleEngineReady(s: MountSession): void {
    const eng = s.engine;

    // resolve the capability policy ONCE per session from the
    // DECLARED record (never method sniffing). Each REQUESTED-but-
    // unsupported feature degrades loudly: one dev diagnostic per feature.
    s.policy = resolveEnginePolicy(eng.capabilities, {
      edgeArrows,
      images: nodeImage !== undefined,
      clusters: clusterSpec !== null,
    });
    policyDiags = s.policy.degradations.map((d) => ({
      code: `engine:capability-degraded` as const,
      severity: 'warning' as const,
      count: 1,
      sampleIds: [],
      message: `${d.feature} degraded: ${d.reason}`,
    }));
    // The mount policy is frozen, so a cluster spec that lands LATER
    // re-emits through noteClusterDegradation — exactly one per session
    // either way.
    clusterDegradationEmitted = s.policy.clusterForce === 'inert' && clusterSpec !== null;

    // edge-picking route: fixed ONCE per mount from the capability record
    // — never method sniffing, never re-evaluated after ready.
    const route: EdgePickRoute = eng.capabilities.linkPicking ? 'native' : 'fallback';
    s.edgePicking = new EdgePickingFacade({
      route,
      screenToSpace: (p) => eng.screenToSpace?.(p) ?? null,
      medianLinkWidthPx: () => medianLinkWidthPx(lastLinkWidths),
      // the facade's per-candidate visibility mask reads the LIVE
      // mask — no re-arm needed on mask changes.
      linkVisible: (linkIndex) => maskEdgeVisibleAt(linkIndex),
    });

    const restartAlpha = layout === 'force' ? 1 : null;
    const committed = buildAndCommitFullReplay(s, restartAlpha);
    const restarted = committed && accepted !== null && restartAlpha !== null;
    // Cosmos holds positions without start (max delta 0.00px over 2.5s), but the pause
    // is still issued so an INITIALLY-fixed mount reaches the same engine
    // state as a force→fixed transition, insulating against an engine whose
    // simulation free-runs by default.
    if (layout === 'fixed') eng.pause();

    publish({
      status: 'ready',
      revisions: { ...store.getState().revisions, appliedRender: eng.appliedRevision() },
      diagnostics: composeDiagnostics(),
      ...(restarted ? { simulationRunning: true } : {}),
    });

    // highlight remap: a fresh engine gets the surviving interaction
    // state (selection, pins, hover focus) re-pushed with fresh indices.
    reapplyInteractionState(eng);
    if (committed) maybeFitView(eng);
    // (re)feed the atlas ref lane now that the session policy is known.
    pushImageRefs();
    // initial candidate rank for a fresh engine (banked positions from a
    // previous session make labels placeable immediately).
    rerankAndNotify();
    emit('ready', {});
  }

  function attach(container: HTMLElement): Promise<void> {
    if (destroyed) throwDestroyedOperation('attach');
    // StrictMode tolerance: attach while mounting/ready is a no-op returning
    // the in-flight promise.
    if (mountPromise !== null) return mountPromise;

    const s: MountSession = {
      engine: engineFactory(),
      container,
      alive: true,
      fitDone: false,
      edgePicking: null,
      policy: null,
    };
    session = s;
    const ownsMount = (): boolean => s.alive && !destroyed && session === s;
    lastHotRefreshMs = null; // fresh adapter, fresh activity clock
    publish({ status: 'mounting' });
    mountPromise = s.engine
      .mount(container, createHostEvents(s))
      .then(() => {
        if (!ownsMount()) return;
        handleEngineReady(s);
      })
      .catch((err: unknown) => {
        // detach/destroy retire the session immediately, but an adapter's
        // asynchronous mount may reject later. Match the stale-success path:
        // the obsolete attach resolves inertly and cannot poison a newer
        // session (or surface as an unhandled rejection in its old host).
        if (!ownsMount()) return;
        // Dedupe: the adapter may have routed the same fault via onError first.
        if (store.getState().status !== 'error') {
          const message = err instanceof Error ? err.message : String(err);
          emitInstanceError(
            { code: 'engine-unsupported', detail: message },
            'mount',
            err instanceof Error ? err : undefined,
          );
        }
        throw err; // the current attach still rejects with the original error
      });
    return mountPromise;
  }

  function detach(): void {
    if (destroyed || session === null) return;
    const s = session;
    // Bank live positions so a future attach replays them.
    if (store.getState().status === 'ready' && scene !== null) {
      const pos = s.engine.getPositions();
      if (pos !== null) bankEnginePositions(pos);
    }
    s.alive = false;
    session = null;
    mountPromise = null;
    cancelRerankTimer();
    flushCrossfilterNotify(); // a queued histogram batch must not strand
    // A pending quiescence assertion belongs to the session that armed it
    // a detached instance must not install the page-global rAF wrapper and
    // blame another instance's (or the app's) animation on this one.
    if (quiescenceTimer !== null) {
      clearTimeout(quiescenceTimer);
      quiescenceTimer = null;
    }
    const timelinePatch = resetTimelineForPatch(); // no leaked timers
    s.edgePicking?.destroy();
    s.edgePicking = null;
    s.engine.destroy();
    publish({
      status: 'idle',
      revisions: { ...store.getState().revisions, appliedRender: null },
      simulationRunning: false,
      ...(timelinePatch ?? {}),
    });
    // no engine → no overlay; empties the candidate set for subscribers.
    rerankAndNotify();
  }

  /**
   * Dev-mode tripwire (one-shot per instance): 2s after a settle
   * with the scene untouched, count page-wide rAF SCHEDULING for 500ms — a
   * quiescent instance's page should register none. Arms only under
   * NODE_ENV === 'development' (never in tests — vitest runs as 'test'),
   * only in rAF-capable environments, and re-checks at fire time that the
   * scene is still at rest. console.warn, never a throw: the counter is
   * page-global, so an app-owned animation can legitimately trip it.
   */
  function armQuiescenceAssertion(): void {
    if (quiescenceAsserted || quiescenceTimer !== null || destroyed) return;
    // globalThis-routed env sniff: core is headless and carries no Node type
    // definitions, so a bare `process` reference would fail the dts build.
    const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
      ?.NODE_ENV;
    if (env !== 'development') return;
    const g = globalThis as {
      requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    };
    if (typeof g.requestAnimationFrame !== 'function') return;
    const armedRender = store.getState().revisions.render;
    quiescenceTimer = setTimeout(() => {
      quiescenceTimer = null;
      const state = store.getState();
      if (destroyed || state.simulationRunning || state.revisions.render !== armedRender) {
        return; // the scene moved on — a later settle re-arms
      }
      quiescenceAsserted = true;
      const native = g.requestAnimationFrame;
      if (typeof native !== 'function') return;
      let registrations = 0;
      const wrapper = (cb: FrameRequestCallback): number => {
        registrations += 1;
        return native.call(globalThis, cb);
      };
      g.requestAnimationFrame = wrapper;
      setTimeout(() => {
        // Restore only if nobody re-wrapped after us; a leaked wrapper
        // delegates to native and stays harmless.
        if (g.requestAnimationFrame === wrapper) g.requestAnimationFrame = native;
        if (registrations > 0 && !destroyed) {
          console.warn(
            `orbit: ${registrations} requestAnimationFrame registration(s) observed over ` +
              '500ms while this instance is quiescent. If no ' +
              'app-owned animation is running, a second frame loop is leaking.',
          );
        }
      }, 500);
    }, 2_000);
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    workerLane?.terminate(); // in-flight derives reject and the thread terminates
    workerLane = null;
    stopTimelineTimer(); // no leaked timers
    if (quiescenceTimer !== null) {
      clearTimeout(quiescenceTimer);
      quiescenceTimer = null;
    }
    timelinePlayingKey = null;
    // abort in-flight image resolves; no further batches can publish.
    imagePipeline?.dispose();
    imagePipeline = null;
    crossfilterEngine?.dispose();
    crossfilterEngine = null;
    crossfilterSessionFacade = null;
    // in-flight expansions are aborted and their promises reject.
    if (expansionHandles.size > 0) {
      const err = new OrbitOperationError(
        { code: 'aborted', cause: 'destroyed' },
        'GraphInstance destroyed with an expansion in flight',
      );
      for (const [reqId, handle] of expansionHandles) {
        handle.abort(err);
        expansionRejectors.get(reqId)?.(err);
      }
      expansionHandles.clear();
      expansionRejectors.clear();
      expansionPromises.clear();
    }
    accretionPinIds = null;
    // the in-flight search (if any) rejects; the cache empties.
    abortSearchFlight('destroyed', 'GraphInstance destroyed with a search in flight');
    // open ingest sessions are aborted (pending work rejects with
    // 'aborted'); no rollback publication — the instance is going away.
    abortAllSessions(null, 'destroyed');
    if (session !== null) {
      session.alive = false;
      session.edgePicking?.destroy();
      session.edgePicking = null;
      session.engine.destroy();
      session = null;
    }
    mountPromise = null;
    cancelRerankTimer();
    candidateSubs.clear();
    positionSubs.clear();
    listeners.clear();
    publish({ status: 'destroyed' });
  }

  // -------------------------------------------------------------------------
  // Camera methods
  // -------------------------------------------------------------------------

  /**
   * 1-hop neighbor ids of `id`: engine adjacency when the adapter
   * provides `neighborIndices`, else the core CSR adjacency built lazily per
   * accepted model (cached; invalidated on model change). Self excluded;
   * accepted-base order, so both sources produce identical results.
   */
  function neighborIdsOf(id: NodeId): NodeId[] {
    if (accepted === null || scene === null) return [];
    const idx = scene.indexById.get(id);
    if (idx === undefined) return [];
    const eng = engineIfReady();
    let neighborIdx: Iterable<number>;
    if (eng !== null && eng.neighborIndices !== undefined) {
      neighborIdx = eng.neighborIndices(idx);
    } else {
      if (adjacency === null) adjacency = buildAdjacency(scene.links, scene.count);
      neighborIdx = neighborsOf(adjacency, idx);
    }
    const out = new Set<NodeId>();
    for (const n of neighborIdx) {
      if (n === idx) continue; // self-loops are not neighbors
      const nid = scene.idByIndex[n];
      if (nid !== undefined) out.add(nid);
    }
    return orderByAcceptedBase([...out], accepted.nodeIndex);
  }

  /**
   * Focus neighborhood: v0.1 camera behavior (setFocusedIndex +
   * zoomToIndex) plus the 1-hop neighbor ids as the return value.
   *
   * Documented compromise: the engine has ONE highlight channel, so the
   * [id,...neighbors] ring is pushed through
   * setSelectedIndices ONLY when the selection visual stays truthful — when
   * selection is empty and uncontrolled. Never a store write; the next real
   * selection push overwrites the ring. `hops` is reserved at 1.
   */

  // -------------------------------------------------------------------------
  // View-state serialization and restoration. The shapes and capture rules
  // here are the wire commitment.
  // -------------------------------------------------------------------------

  /** One-shot dev warning for a styling value dropped from capture. */
  function warnViewStateDrop(channel: string, why: string): void {
    if (!DEV || viewStateDropWarned.has(channel)) return;
    viewStateDropWarned.add(channel);
    console.warn(`orbit: getViewState omitted ${channel} — ${why}`);
  }

  /** styling capture: Scales that are data by construction. */
  function serializableScaleOf<T extends string | number>(
    channel: 'nodeColor' | 'nodeSize',
    value: Accessor<GraphNode<N>, T> | Scale<T, N> | undefined,
  ): SerializableScale<T> | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'function') {
      warnViewStateDrop(channel, 'accessor functions do not serialize');
      return undefined;
    }
    if (!isScaleValue(value)) return undefined; // constants are app defaults, not captured
    const scale = value as Scale<T, N>;
    if (scale.kind === 'sequential') {
      return {
        kind: 'sequential',
        metric: scale.metric,
        range: scale.range,
        // The numeric-array domain form is data; a DomainPolicy is app
        // behavior config and stays with the app.
        ...(Array.isArray(scale.domain)
          ? { domain: scale.domain as readonly [number, number] }
          : {}),
      } as SerializableScale<T>;
    }
    if (scale.kind === 'diverging') {
      return {
        kind: 'diverging',
        metric: scale.metric,
        range: scale.range,
        mid: scale.mid,
      } as SerializableScale<T>;
    }
    // categorical: only the field-descriptor `by` form is data.
    if (typeof scale.by !== 'string') {
      warnViewStateDrop(channel, "a function-`by` categorical scale does not serialize");
      return undefined;
    }
    return {
      kind: 'categorical',
      by: scale.by,
      ...(scale.palette !== undefined ? { palette: scale.palette } : {}),
      ...(scale.domain !== undefined ? { domain: scale.domain } : {}),
    } as SerializableScale<T>;
  }

  /** Named-theme capture: only 'light'/'dark' serialize (custom GraphTheme
   * objects are app config, dropped with one dev warning). */
  function serializableThemeOf(): 'light' | 'dark' | undefined {
    const json = JSON.stringify(theme);
    if (json === JSON.stringify(GRAPH_THEME_DARK)) return 'dark';
    if (json === JSON.stringify(GRAPH_THEME_LIGHT)) return 'light';
    warnViewStateDrop('theme', 'custom GraphTheme objects do not serialize; use a named base');
    return undefined;
  }

  /** The synchronous serialization core shared by both overloads. */
  function captureViewState(): GraphViewState {
    const st = store.getState();

    // Groups: manual specs verbatim; under groupBy only the COLLAPSED keys
    // a key absent from the pairs restores expanded, which is the default.
    let groups: GraphViewState['groups'];
    if (groupBySpec !== null) {
      groups = [...groupByCollapsedKeys].map((key) => ({ key, collapsed: true }));
    } else {
      groups = groupsSpec ?? [];
    }

    // Crossfilter: declaration order; a dimension without a live brush is
    // simply absent. The wire form is TAGGED from the DimensionSpec kind.
    const crossfilter: Array<{ key: string; state: ViewBrushState }> = [];
    if (crossfilterSpecs !== null && crossfilterEngine !== null) {
      for (const spec of crossfilterSpecs) {
        const brush = crossfilterEngine.getBrush(spec.key);
        if (brush === null) continue;
        if ('excluded' in brush) {
          crossfilter.push({
            key: spec.key,
            state: { kind: 'categorical', excluded: [...brush.excluded] },
          });
        } else {
          crossfilter.push({
            key: spec.key,
            state: {
              kind: spec.kind === 'temporal' ? 'temporal' : 'numeric',
              range: [brush.min, brush.max] as const,
            },
          });
        }
      }
    }

    const styling: ViewStyling = {};
    const nodeColorScale = serializableScaleOf('nodeColor', nodeColor);
    if (nodeColorScale !== undefined) styling.nodeColor = nodeColorScale;
    const nodeSizeScale = serializableScaleOf('nodeSize', nodeSize);
    if (nodeSizeScale !== undefined) styling.nodeSize = nodeSizeScale;
    styling.showLinks = showLinks;
    styling.edgeArrows = edgeArrows;
    const namedTheme = serializableThemeOf();
    if (namedTheme !== undefined) styling.theme = namedTheme;

    return {
      v: 1,
      camera: st.viewport === null ? null : { ...st.viewport },
      selection: {
        nodeIds: [...st.selection.nodeIds],
        edgeIds: [...st.selection.edgeIds],
        groupIds: [...st.selection.groupIds],
      },
      hiddenNodeIds: [...st.hiddenNodeIds],
      subgraph: scopeSpec === null ? null : subgraphPlain(scopeSpec),
      groups,
      pinnedNodeIds: [...st.pinnedNodeIds],
      ...(folds.size > 0
        ? { folds: [...folds].map(([anchorId, memberIds]) => [anchorId, [...memberIds]] as const) }
        : {}),
      layout: { kind: layout },
      crossfilter,
      styling,
      ...(dataRef !== undefined ? { dataRef } : {}),
    };
  }

  function getViewState(opts?: { includePositions?: false }): GraphViewState;
  function getViewState(opts: {
    includePositions: true;
    maxPositions?: number;
  }): Promise<GraphViewState>;
  function getViewState(opts?: {
    includePositions?: boolean;
    maxPositions?: number;
  }): GraphViewState | Promise<GraphViewState> {
    if (opts?.includePositions !== true) return captureViewState();
    return (async () => {
      const base = captureViewState();
      const eng = engineIfReady();
      if (eng === null || scene === null) return base; // nothing placed yet
      const bound = physicalPointCount();
      const visible: NodeId[] = [];
      for (let i = 0; i < bound; i++) {
        if (softMask === null || softMask.isNodeVisible(i)) visible.push(scene.idByIndex[i]!);
      }
      const limit = opts.maxPositions ?? 100_000;
      if (visible.length > limit) {
        throw new OrbitOperationError(
          { code: 'export-materialization-too-large', rowCount: visible.length, limit },
          `includePositions over ${limit} nodes — persist the layout through the export lane and reference it from dataRef`,
        );
      }
      // ONE per-event readback — an explicit host call is an event.
      const pos = eng.getPositions();
      if (pos === null) return base;
      const positions: Array<readonly [string, number, number]> = [];
      for (const id of visible) {
        const idx = scene.indexById.get(id);
        if (idx === undefined) continue;
        const x = pos[2 * idx];
        const y = pos[2 * idx + 1];
        if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) continue;
        // Quantized: 2 decimals is sub-pixel at every zoom the demo reaches
        // and keeps a 100K payload ~40% smaller than raw float noise.
        positions.push([id, Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
      }
      return { ...base, positions };
    })();
  }
  /** Whether an aggregate restore consumer exists (the one signal
   * the core has that a host owns the reflection side). */
  function hasRestoreListener(): boolean {
    return (listeners.get('viewStateRestore')?.size ?? 0) > 0;
  }

  function failPendingRestore(code: 'restore-timeout' | 'restore-diverged'): void {
    const pending = pendingRestore;
    if (pending === null) return;
    pendingRestore = null;
    clearTimeout(pending.timer);
    pending.rollbackCursor?.();
    pending.resolve({
      status: 'rejected',
      code,
      problems: [
        code === 'restore-timeout'
          ? `the host did not reflect the restore intent within ${RESTORE_ACK_TIMEOUT_MS}ms`
          : 'the host reflected different values than the intent asked for',
      ],
    });
  }

  function commitPendingRestore(): void {
    const pending = pendingRestore;
    if (pending === null) return;
    pendingRestore = null;
    clearTimeout(pending.timer);
    if (pending.commands.length > 0) {
      if (pending.recordOnCommit) {
        historyKernel.begin('setViewState');
        for (const cmd of pending.commands) {
          historyKernel.record(cmd.slice, cmd.before, cmd.after);
        }
        historyKernel.end();
      }
      clearPathInternal();
      applyHistoryCommands(pending.commands);
    }
    pending.finish();
    pending.resolve({ status: 'applied' });
  }

  /**
   * Acknowledgement hook: called after a HOST update processed. Each awaited
   * controlled lane the update carried either matches (met) or diverges
   * (whole stage discarded). The transaction commits when nothing remains
   * awaited. Updates that do not touch awaited lanes are unrelated traffic
   * and pass through untouched.
   */
  function checkRestoreAcknowledgement(update: GraphHostUpdate<N, E>): void {
    const pending = pendingRestore;
    if (pending === null) return;
    const met = (lane: 'selection' | 'pinnedNodeIds' | 'groups'): void => {
      delete pending.awaiting[lane];
    };
    if (pending.awaiting.selection !== undefined && update.selection !== undefined) {
      if (sameIds(update.selection, pending.awaiting.selection)) met('selection');
      else return failPendingRestore('restore-diverged');
    }
    if (pending.awaiting.pinnedNodeIds !== undefined && update.pinnedNodeIds !== undefined) {
      const target = pending.awaiting.pinnedNodeIds;
      const got = update.pinnedNodeIds ?? [];
      if (sameIds(got, target)) met('pinnedNodeIds');
      else return failPendingRestore('restore-diverged');
    }
    if (pending.awaiting.groups !== undefined && update.groups !== undefined) {
      if (sameGroupSpecArrays(update.groups, pending.awaiting.groups)) met('groups');
      else return failPendingRestore('restore-diverged');
    }
    if (Object.keys(pending.awaiting).length === 0) commitPendingRestore();
  }

  /**
   * setViewState — the atomic restore (Wave 2: uncontrolled path).
   * See the interface doc for the gate order. Styling: with no aggregate
   * restore callback registered, showLinks/edgeArrows/theme/scales apply
   * through the instance's own internal config lanes — the "only
   * internally owned fields" clause resolved as callback-registration, which
   * is the one signal the core has for host ownership of styling props.
   */
  function setViewState(
    raw: unknown,
    opts?: {
      ignoreMismatch?: boolean;
      isDataRefEqual?: (stored: JsonValue | undefined, current: JsonValue | undefined) => boolean;
    },
  ): Promise<SetViewStateResult> {
    if (destroyed) {
      return Promise.resolve({
        status: 'rejected',
        code: 'invalid-view-state',
        problems: ['instance destroyed'],
      });
    }
    if (pendingRestore !== null) {
      return Promise.resolve({
        status: 'rejected',
        code: 'restore-pending',
        problems: ['another restore/history transaction is awaiting acknowledgement'],
      });
    }
    // 1. Structural validation + version gate — BEFORE anything else.
    const verdict = validateViewState(raw);
    if (!verdict.ok) {
      acceptanceQueue.admit(() => {
        engineDiags = [
          ...engineDiags,
          {
            code: 'invalid-view-state',
            severity: 'error',
            count: verdict.problems.length,
            sampleIds: [],
            message: `setViewState rejected (${verdict.code}): ${verdict.problems.slice(0, 3).join('; ')} — nothing was applied`,
          },
        ];
        pendingDiagnosticsRefresh = true;
        applyHostUpdateInner({});
      });
      return Promise.resolve({
        status: 'rejected',
        code: verdict.code,
        problems: verdict.problems,
      });
    }
    const state = verdict.state;

    // 2. dataRef gate — only a state that PASSED validation is consulted.
    if (state.dataRef !== undefined && opts?.ignoreMismatch !== true) {
      const equal = (opts?.isDataRefEqual ?? sameDataRef)(state.dataRef, dataRef);
      if (!equal) {
        emit('viewStateMismatch', { stored: state.dataRef, current: dataRef });
        return Promise.resolve({ status: 'mismatch' });
      }
    }

    return new Promise<SetViewStateResult>((resolve) => {
      acceptanceQueue.admit(() => {
        // 3. Ownership triage: which lanes must the HOST reflect?
        const st = store.getState();
        const wantsSelection =
          JSON.stringify(selectionPlain(state.selection)) !==
          JSON.stringify(selectionPlain(st.selection));
        const wantsPinned =
          JSON.stringify([...state.pinnedNodeIds].sort()) !==
          JSON.stringify([...st.pinnedNodeIds].sort());
        const manualGroups = state.groups.filter(
          (g): g is GroupSpec => 'id' in g && typeof (g as GroupSpec).id === 'string',
        );
        const wantsManualGroups =
          groupBySpec === null &&
          JSON.stringify(manualGroups) !== JSON.stringify(groupsSpec ?? []);

        const awaiting: PendingRestore['awaiting'] = {};
        if (wantsSelection && selectionControlled) awaiting.selection = state.selection.nodeIds;
        if (wantsPinned && pinnedControlled) awaiting.pinnedNodeIds = state.pinnedNodeIds;
        if (wantsManualGroups && groupsControlled) awaiting.groups = manualGroups;
        const needsHost = Object.keys(awaiting).length > 0;
        if (needsHost && !hasRestoreListener()) {
          resolve({
            status: 'rejected',
            code: 'missing-restore-callback',
            problems: Object.keys(awaiting).map((lane) => `${lane} is controlled`),
          });
          return;
        }

        // 4. Internal command list — value diffs through the SAME slices the
        // undo applier consumes. Controlled lanes are NOT commands: the host
        // writes them through its own reflection.
        interface Cmd {
          slice: string;
          before: unknown;
          after: unknown;
        }
        const commands: Cmd[] = [];
        if (wantsSelection && !selectionControlled) {
          commands.push({
            slice: 'selection',
            before: selectionPlain(st.selection),
            after: selectionPlain(state.selection),
          });
        }
        const hiddenNow = [...st.hiddenNodeIds].sort();
        const hiddenNext = [...state.hiddenNodeIds].sort();
        if (JSON.stringify(hiddenNow) !== JSON.stringify(hiddenNext)) {
          commands.push({ slice: 'hidden', before: hiddenNow, after: hiddenNext });
        }
        if (wantsPinned && !pinnedControlled) {
          commands.push({
            slice: 'pinnedNodes',
            before: [...st.pinnedNodeIds],
            after: [...state.pinnedNodeIds],
          });
        }
        const foldsNow = foldsStatePlain();
        const foldsNext = (state.folds ?? []).map(
          ([anchorId, memberIds]) => [anchorId, [...memberIds]] as [NodeId, NodeId[]],
        );
        if (JSON.stringify(foldsNow) !== JSON.stringify(foldsNext)) {
          commands.push({ slice: 'folds', before: foldsNow, after: foldsNext });
        }
        const scopeNow = scopeSpec === null ? null : subgraphPlain(scopeSpec);
        const scopeNext = state.subgraph === null ? null : subgraphPlain(state.subgraph);
        if (JSON.stringify(scopeNow) !== JSON.stringify(scopeNext)) {
          commands.push({ slice: 'scope', before: scopeNow, after: scopeNext });
        }
        if (crossfilterEngine !== null && crossfilterSpecs !== null) {
          const targetByKey = new Map(state.crossfilter.map((c) => [c.key, c.state]));
          for (const spec of crossfilterSpecs) {
            const now = crossfilterEngine.getBrush(spec.key);
            const wire = targetByKey.get(spec.key);
            const next: BrushState =
              wire === undefined
                ? null
                : wire.kind === 'categorical'
                  ? { excluded: [...wire.excluded] }
                  : { min: wire.range[0], max: wire.range[1] };
            if (JSON.stringify(now) !== JSON.stringify(next)) {
              commands.push({ slice: `brush:${spec.key}`, before: now, after: next });
            }
          }
        }

        // 5. The side lanes shared by both paths — everything that is CONFIG
        // or camera rather than a history command. Styling: when the host is
        // reflecting (needsHost), styling joins the intent and the host owns
        // it; otherwise the instance's internal config lanes apply it (the
        // "only internally owned fields" clause — see function doc).
        const finishTail = (): void => {
          if (groupBySpec !== null) {
            const pairKeys = new Set(
              state.groups
                .filter((g): g is { key: string; collapsed: boolean } => 'key' in g)
                .filter((g) => g.collapsed)
                .map((g) => g.key),
            );
            const same =
              pairKeys.size === groupByCollapsedKeys.size &&
              [...pairKeys].every((k) => groupByCollapsedKeys.has(k));
            if (!same) {
              groupByCollapsedKeys.clear();
              for (const k of pairKeys) groupByCollapsedKeys.add(k);
              pendingGroupsRefresh = true;
              applyHostUpdateInner({});
            }
          } else if (wantsManualGroups && !groupsControlled) {
            commitManualGroups(manualGroups.length > 0 ? manualGroups : null);
          }

          // The serialized layout kind must be applied, not merely captured:
          // APPLIED — restoring a fixed state into a force instance stayed
          // force-directed while reporting success. Routed through the same
          // host-update lane a caller's layout change takes (force→fixed
          // banks positions + pauses; fixed→force reheats), BEFORE the
          // positions lane so restored coordinates land into the restored
          // layout.
          if (state.layout.kind !== layout) {
            applyHostUpdateInner({ layout: state.layout.kind });
          }

          if (state.styling !== undefined && !needsHost) {
            const patch: GraphHostUpdate<N, E> = {};
            if (state.styling.showLinks !== undefined) patch.showLinks = state.styling.showLinks;
            if (state.styling.edgeArrows !== undefined) {
              patch.edgeArrows = state.styling.edgeArrows;
            }
            if (state.styling.theme !== undefined) patch.theme = { base: state.styling.theme };
            if (state.styling.nodeColor !== undefined) {
              patch.nodeColor = state.styling.nodeColor as unknown as Scale<string, N>;
            }
            if (state.styling.nodeSize !== undefined) {
              patch.nodeSize = state.styling.nodeSize as unknown as Scale<number, N>;
            }
            if (Object.keys(patch).length > 0) applyHostUpdateInner(patch);
          }

          if (state.positions !== undefined && scene !== null) {
            const eng = engineIfReady();
            if (eng !== null) {
              const next = new Float32Array(scene.positions);
              let touched = 0;
              for (const [id, x, y] of state.positions) {
                const idx = scene.indexById.get(id);
                if (idx === undefined) continue; // stale id — ignored per spec
                next[2 * idx] = x;
                next[2 * idx + 1] = y;
                touched++;
              }
              if (touched > 0) {
                reconciler.noteEnginePositions(next);
                scene = { ...scene, positions: next };
                const prevState = store.getState();
                const nextRevisions: Revisions = {
                  ...prevState.revisions,
                  render: prevState.revisions.render + 1,
                };
                commitToEngine(eng, {
                  revision: nextRevisions.render,
                  structure: {
                    pointCount: scene.count,
                    positions: next,
                    links: scene.links,
                  },
                });
                nextRevisions.appliedRender = eng.appliedRevision();
                eng.pause();
                const patch: Partial<GraphStoreState> = { revisions: nextRevisions };
                if (prevState.simulationRunning) patch.simulationRunning = false;
                publish(patch);
              }
            }
          }

          if (state.camera !== null) {
            const eng = engineIfReady();
            if (eng !== null) {
              if (effectiveReducedMotion()) eng.setViewport(state.camera, { durationMs: 0 });
              else eng.setViewport(state.camera);
            }
          }
        };

        // 6a. Host reflection needed: STAGE — nothing applies until the
        // matching values arrive; the previous scene stays live throughout.
        if (needsHost) {
          const transactionId = `restore-${++restoreTxSeq}`;
          pendingRestore = {
            transactionId,
            source: 'setViewState',
            commands: commands as readonly HistoryCommand[],
            awaiting,
            finish: finishTail,
            recordOnCommit: true,
            resolve,
            timer: setTimeout(() => failPendingRestore('restore-timeout'), RESTORE_ACK_TIMEOUT_MS),
          };
          emit('viewStateRestore', { transactionId, source: 'setViewState', next: state });
          return;
        }

        // 6b. All-internal: record + apply as one transaction, immediately.
        if (commands.length > 0) {
          historyKernel.begin('setViewState');
          for (const cmd of commands) historyKernel.record(cmd.slice, cmd.before, cmd.after);
          historyKernel.end();
          clearPathInternal();
          applyHistoryCommands(commands as readonly HistoryCommand[]);
        }
        finishTail();
        resolve({ status: 'applied' });
      });
    });
  }


  // -------------------------------------------------------------------------
  // Exports. Every operation pins ONE epoch — the
  // {accepted, scene, mask} references captured at call start — so a
  // concurrent commit or simulation tick never mixes revisions or coordinate
  // epochs mid-export. Streams release the pin when the generator closes.
  // -------------------------------------------------------------------------

  /** Visible physical slot indices under the CALLER-pinned scene/mask. */
  function visibleSlotsOf(pinScene: RenderScene, pinMask: SoftMask | null): number[] {
    const bound =
      pinScene.groups !== undefined ? pinScene.groups.physicalPointCount : pinScene.count;
    const out: number[] = [];
    for (let i = 0; i < bound; i++) {
      if (pinMask === null || pinMask.isNodeVisible(i)) out.push(i);
    }
    return out;
  }

  /** Pure base64 (no btoa/Buffer — environment-free per E2). */
  function base64Of(bytes: Uint8Array): string {
    const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i]!;
      const b = bytes[i + 1];
      const c = bytes[i + 2];
      out += ABC[a >> 2]! + ABC[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
      out += b === undefined ? '=' : ABC[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
      out += c === undefined ? '=' : ABC[c & 63]!;
    }
    return out;
  }

  /** rgba string from a 4-float slot of a projected color buffer. */
  function cssOfSlot(buf: Float32Array, slot: number): string {
    const o = 4 * slot;
    const r = Math.round((buf[o] ?? 0) * 255);
    const g = Math.round((buf[o + 1] ?? 0) * 255);
    const b = Math.round((buf[o + 2] ?? 0) * 255);
    const a = Math.round((buf[o + 3] ?? 1) * 1000) / 1000;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  async function exportImage(format: 'png'): Promise<Blob>;
  async function exportImage(
    format: 'svg',
    opts?: { maxSvgElements?: number; fallback?: 'raster-hybrid' },
  ): Promise<string>;
  async function exportImage(
    format: 'png' | 'svg',
    opts?: { maxSvgElements?: number; fallback?: 'raster-hybrid' },
  ): Promise<Blob | string> {
    if (format === 'png') {
      const eng = engineIfReady();
      if (eng === null || eng.captureScreenshot === undefined) {
        throw new OrbitOperationError(
          { code: 'aborted', cause: 'no screenshot capability' },
          'exportImage("png") requires an engine with screenshot capture',
        );
      }
      const blob = await eng.captureScreenshot();
      if (blob === null) {
        throw new OrbitOperationError(
          { code: 'aborted', cause: 'capture returned null' },
          'the engine could not capture the canvas (context lost or unmounted)',
        );
      }
      return blob;
    }

    // --- SVG: pin the epoch and read positions ONCE per export. ---
    const pinScene = scene;
    const pinMask = softMask;
    const eng = engineIfReady();
    if (pinScene === null || eng === null) {
      throw new OrbitOperationError(
        { code: 'invalid-view-state', detail: 'no scene' },
        'exportImage("svg") requires a mounted scene',
      );
    }
    const pos = eng.getPositions() ?? pinScene.positions;
    const slots = visibleSlotsOf(pinScene, pinMask);
    const slotSet = new Set(slots);

    // Visible edges: both PHYSICAL endpoints visible.
    const linkBound =
      pinScene.groups !== undefined ? pinScene.groups.physicalLinkCount : pinScene.linkCount;
    const visibleLinks: number[] = [];
    for (let j = 0; j < linkBound; j++) {
      const a = pinScene.links[2 * j]!;
      const b = pinScene.links[2 * j + 1]!;
      if (slotSet.has(a) && slotSet.has(b) && (pinMask === null || pinMask.isEdgeVisible(j))) {
        visibleLinks.push(j);
      }
    }

    // Labels: the CURRENT candidate set, re-anchored to node space coords so
    // the vector output is camera-independent.
    const labelPlacements = currentPlacements.filter(
      (c) => c.kind !== 'cluster' && pinScene.indexById.has(c.id),
    );

    const elementCount = slots.length + visibleLinks.length + labelPlacements.length;
    const limit = opts?.maxSvgElements ?? SVG_MAX_ELEMENTS_DEFAULT;
    if (elementCount > limit && opts?.fallback !== 'raster-hybrid') {
      throw new OrbitOperationError(
        { code: 'export-too-large', elementCount, limit },
        `SVG export of ${elementCount} elements exceeds ${limit} — filter/isolate first, or pass { fallback: 'raster-hybrid' }`,
      );
    }

    // Space-coordinate bounding box, padded 5%.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const i of slots) {
      const x = pos[2 * i]!;
      const y = pos[2 * i + 1]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = 1;
      maxY = 1;
    }
    const pad = Math.max((maxX - minX), (maxY - minY)) * 0.05 + 10;
    const ox = minX - pad;
    const oy = minY - pad;
    const width = maxX - minX + 2 * pad;
    const height = maxY - minY + 2 * pad;

    if (elementCount > limit) {
      // raster-hybrid: PNG base (the camera view) + label overlay in SCREEN
      // coordinates from the live candidate placements.
      const shot =
        eng.captureScreenshot !== undefined ? await eng.captureScreenshot().catch(() => null) : null;
      if (shot === null) {
        throw new OrbitOperationError(
          { code: 'export-too-large', elementCount, limit },
          'raster-hybrid fallback unavailable: the engine could not capture the canvas',
        );
      }
      // Environment-free data-URI encode: blob.arrayBuffer is universal
      // (browser AND Node ≥18), unlike FileReader — core stays E2-pure.
      const bytes = new Uint8Array(await shot.arrayBuffer());
      const href = `data:${shot.type || 'image/png'};base64,${base64Of(bytes)}`;
      // Raster-hybrid renders the CAMERA view; dims come from the mount
      // container when known, else a sane default (the raster scales).
      const el = session?.container ?? null;
      return renderSvg({
        width: el !== null && el.clientWidth > 0 ? el.clientWidth : 1280,
        height: el !== null && el.clientHeight > 0 ? el.clientHeight : 800,
        background: theme.background,
        nodes: [],
        edges: [],
        labels: labelPlacements.map((c) => ({
          x: c.x,
          y: c.y,
          text: c.text,
          color: theme.labelFg,
        })),
        rasterBase: { href },
      });
    }

    // Pure vector: colors from the SAME base caches the commits mask, sizes
    // via a one-off projection through the commit projector.
    const colorBuf = basePointColorBuffer();
    const linkColorBuf = baseLinkColorBuffer();
    const model = sceneModel();
    const physNodes =
      groupRewrite !== null ? groupRewrite.physicalNodes : (model?.nodes ?? []);
    let sizeOfSlot: (slot: number) => number = () => PHYSICAL_DEFAULT_POINT_SIZE;
    if (nodeSize !== undefined && model !== null) {
      const r = isScaleValue(nodeSize)
        ? projectSizes(physNodes, scaleSizeAccessor(nodeSize as Scale<number, N>))
        : projectSizes(physNodes, nodeSize);
      const buf = r.buffer;
      sizeOfSlot = (slot) => buf[slot] ?? PHYSICAL_DEFAULT_POINT_SIZE;
    }

    return renderSvg(
      {
        width,
        height,
        background: theme.background,
        nodes: slots.map((i) => ({
          x: pos[2 * i]! - ox,
          y: pos[2 * i + 1]! - oy,
          r: Math.max(sizeOfSlot(i) / 2, 0.5),
          color: cssOfSlot(colorBuf, i),
        })),
        edges: visibleLinks.map((j) => {
          const a = pinScene.links[2 * j]!;
          const b = pinScene.links[2 * j + 1]!;
          return {
            x1: pos[2 * a]! - ox,
            y1: pos[2 * a + 1]! - oy,
            x2: pos[2 * b]! - ox,
            y2: pos[2 * b + 1]! - oy,
            color: cssOfSlot(linkColorBuf, j),
            width: PHYSICAL_DEFAULT_LINK_WIDTH,
          };
        }),
        labels: labelPlacements.map((c) => {
          const i = pinScene.indexById.get(c.id)!;
          return {
            x: pos[2 * i]! - ox + 6,
            y: pos[2 * i + 1]! - oy - 6,
            text: c.text,
            color: theme.labelFg,
          };
        }),
      },
      { maxElements: limit },
    );
  }

  /**
   * The export pin, captured EAGERLY at call time — async generator bodies
   * are lazy (nothing runs until the first next), so the pin must be taken
   * in a plain wrapper or a commit landing between obtaining a stream and
   * first consuming it would silently swap epochs (the exact mixing
   * forbids). Plain references to immutable snapshots: releasing the pin is
   * the generator closing.
   */
  interface ExportPin {
    accepted: AcceptedGraph<N, E>;
    scene: RenderScene | null;
    /** Resolved at capture time: SoftMask mutates in place, so a
     * stored reference is not a pin — a filter change between obtaining
     * and consuming a stream would alter its supposedly frozen output. */
    visibleIds: ReadonlySet<NodeId> | null;
  }

  function captureExportPin(): ExportPin | null {
    if (accepted === null) return null;
    let visibleIds: ReadonlySet<NodeId> | null = null;
    if (scene !== null) {
      const slots = visibleSlotsOf(scene, softMask);
      const ids = new Set<NodeId>();
      for (const i of slots) ids.add(scene.idByIndex[i]!);
      visibleIds = ids;
    }
    return { accepted, scene, visibleIds };
  }

  /** Visible-node id set under a pin; null = everything visible (no scene). */
  function pinnedVisibleIds(pin: ExportPin): ReadonlySet<NodeId> | null {
    return pin.visibleIds;
  }

  /** Row COUNT for a pinned scope without materializing anything — the
   * "rejects before allocating" promise depends on this being
   * counting, not building. */
  function pinnedRowCount(pin: ExportPin, scope: 'visible' | 'accepted'): number {
    if (scope === 'accepted') return pin.accepted.nodes.length + pin.accepted.edges.length;
    const visible = pinnedVisibleIds(pin);
    if (visible === null) return pin.accepted.nodes.length + pin.accepted.edges.length;
    let count = visible.size;
    for (const e of pin.accepted.edges) {
      if (visible.has(e.source) && visible.has(e.target)) count++;
    }
    return count;
  }

  async function exportData(
    scope: 'visible' | 'accepted' = 'visible',
    opts?: { limit?: number },
  ): Promise<{ nodes: readonly GraphNode<N>[]; edges: readonly AcceptedEdge<E>[] }> {
    const pin = captureExportPin();
    if (pin === null) return { nodes: [], edges: [] };
    const rowCount = pinnedRowCount(pin, scope);
    const limit = opts?.limit ?? 100_000;
    if (rowCount > limit) {
      // Counted, never built: rejection precedes any O(n) materialization.
      throw new OrbitOperationError(
        { code: 'export-materialization-too-large', rowCount, limit },
        `exportData would materialize ${rowCount} rows (limit ${limit}) — use exportDataStream`,
      );
    }
    if (scope === 'accepted') return { nodes: pin.accepted.nodes, edges: pin.accepted.edges };
    const visible = pinnedVisibleIds(pin);
    if (visible === null) return { nodes: pin.accepted.nodes, edges: pin.accepted.edges };
    return {
      nodes: pin.accepted.nodes.filter((n) => visible.has(n.id)),
      edges: pin.accepted.edges.filter(
        (e) => visible.has(e.source) && visible.has(e.target),
      ),
    };
  }

  function exportDataStream(
    scope: 'visible' | 'accepted' = 'visible',
  ): AsyncGenerator<string, void, undefined> {
    const pin = captureExportPin(); // EAGER — see ExportPin
    return (async function* dataRows(): AsyncGenerator<string, void, undefined> {
      if (pin === null) return;
      const visible = scope === 'visible' ? pinnedVisibleIds(pin) : null;
      // Lazy row-at-a-time iteration over the pinned refs: peak memory is
      // one line, never an intermediate roster array.
      for (const n of pin.accepted.nodes) {
        if (visible !== null && !visible.has(n.id)) continue;
        yield JSON.stringify({ kind: 'node', value: n }) + '\n';
      }
      for (const e of pin.accepted.edges) {
        if (visible !== null && (!visible.has(e.source) || !visible.has(e.target))) continue;
        yield JSON.stringify({ kind: 'edge', value: e }) + '\n';
      }
    })();
  }

  /** Layout pin: the scene refs plus ONE position readback taken eagerly
   * the Float32Array IS the coordinate epoch. */
  function captureLayoutPin(): { scene: RenderScene; pos: Float32Array } | null {
    const pinScene = scene;
    if (pinScene === null) return null;
    const eng = engineIfReady();
    const pos = (eng !== null ? eng.getPositions() : null) ?? pinScene.positions;
    return { scene: pinScene, pos };
  }

  async function exportLayout(opts?: {
    limit?: number;
  }): Promise<ReadonlyMap<NodeId, readonly [number, number]>> {
    const pin = captureLayoutPin();
    if (pin === null) return new Map();
    const bound =
      pin.scene.groups !== undefined ? pin.scene.groups.physicalPointCount : pin.scene.count;
    const limit = opts?.limit ?? 100_000;
    if (bound > limit) {
      throw new OrbitOperationError(
        { code: 'export-materialization-too-large', rowCount: bound, limit },
        `exportLayout would materialize ${bound} rows (limit ${limit}) — use exportLayoutStream`,
      );
    }
    const out = new Map<NodeId, readonly [number, number]>();
    for (let i = 0; i < bound; i++) {
      const x = pin.pos[2 * i]!;
      const y = pin.pos[2 * i + 1]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      out.set(pin.scene.idByIndex[i]!, [x, y]);
    }
    return out;
  }

  function exportLayoutStream(): AsyncGenerator<string, void, undefined> {
    const pin = captureLayoutPin(); // EAGER readback — the epoch is fixed here
    return (async function* layoutRows(): AsyncGenerator<string, void, undefined> {
      if (pin === null) return;
      const bound =
        pin.scene.groups !== undefined ? pin.scene.groups.physicalPointCount : pin.scene.count;
      for (let i = 0; i < bound; i++) {
        const x = pin.pos[2 * i]!;
        const y = pin.pos[2 * i + 1]!;
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        yield JSON.stringify({ id: pin.scene.idByIndex[i]!, x, y }) + '\n';
      }
    })();
  }

  /** DOM-presenter context menu (see the interface doc): validate
   * the id, then feed the SAME typed channel the canvas gesture feeds. */
  function requestNodeContextMenu(id: NodeId, screen: readonly [number, number]): void {
    if (destroyed) return;
    const node = getNode(id);
    if (node === undefined) return; // stale presenter — drop the gesture
    emit('contextMenu', {
      target: { kind: 'node', node },
      screen: [screen[0], screen[1]] as const,
    });
  }

  function focusNode(
    id: NodeId,
    opts?: { highlightNeighbors?: boolean; hops?: 1 },
  ): readonly NodeId[] {
    const eng = engineIfReady();
    if (eng === null || scene === null) return EMPTY_IDS;
    const idx = scene.indexById.get(id);
    if (idx === undefined) return EMPTY_IDS;
    applyEmphasis(eng, idx);
    // reduced motion coerces the focus camera move to be instant.
    if (effectiveReducedMotion()) eng.zoomToIndex?.(idx, 0);
    else eng.zoomToIndex?.(idx);
    const neighbors = neighborIdsOf(id);
    const highlight = opts?.highlightNeighbors ?? true;
    if (
      highlight &&
      neighbors.length > 0 &&
      !selectionControlled &&
      store.getState().selection.nodeIds.length === 0
    ) {
      const ring = [idx];
      for (const nid of neighbors) {
        const ni = scene.indexById.get(nid);
        if (ni !== undefined) ring.push(ni);
      }
      eng.setSelectedIndices(ring);
    }
    return neighbors;
  }

  /** ring-only emphasis (see the interface JSDoc for the contract). */
  function emphasizeNode(id: NodeId | null): void {
    const eng = engineIfReady();
    if (eng === null) return;
    if (id === null) {
      emphasizedNodeId = null;
      applyEmphasis(eng, null);
      return;
    }
    if (scene === null) return;
    const idx = scene.indexById.get(id);
    if (idx !== undefined) {
      // The sticky target is only ever a RESOLVED id — an unknown id must
      // not lie in wait and ring a node that arrives in a later commit.
      emphasizedNodeId = id;
      applyEmphasis(eng, idx);
    }
  }

  /** assemble the telemetry snapshot (sync, allocation-light).
   * NEVER carries raw attrs or ids — counts, bytes, revisions, phases,
   * pressure only (pinned by a sentinel property test). */
  function getPerfSnapshot(): GraphPerfSnapshot {
    const st = store.getState();
    const p = pressureSampler.snapshot();
    const snap: GraphPerfSnapshot = {
      at: Date.now(),
      nodeCount: st.nodeCount,
      edgeCount: st.edgeCount,
      visibleNodeCount: st.visible.nodes,
      visibleEdgeCount: st.visible.edges,
      estimatedCpuBytes: estimateCpuBytes(),
      // The acceptance queue is synchronous: depth is 0 outside a job, and a
      // reader inside a job observes 1.
      queueDepth: acceptanceQueue.active ? 1 : 0,
      modelRevision: st.revisions.model,
      scopeRevision: st.revisions.scope,
      renderRevision: st.revisions.render,
      appliedRenderRevision: st.revisions.appliedRender,
      activeDegradations: degradeController.activeSteps(),
      // 'worker' iff the lane actually boots — a configured-but-unavailable
      // lane reports the honest 'main' (plus its worker-unavailable diag).
      execution: workerLane !== null && workerLane.available() === true ? 'worker' : 'main',
      rangeUpdates:
        session !== null && session.policy !== null ? [...session.policy.rangedChannels] : [],
      pressure: {
        frameEwmaMs: p.frameEwmaMs,
        droppedFrames: p.droppedFrames,
        idleWakeups: p.idleWakeups,
      },
    };
    if (lastCommitMs !== undefined) snap.lastCommitMs = { ...lastCommitMs };
    if (scene !== null) {
      // Engine-side estimate at current scene sizes: positions (2 f32/pt),
      // pointColor (4 f32), pointSize (1 f32), linkColor (4 f32),
      // linkWidth (1 f32), link endpoints (2 u32).
      snap.estimatedGpuBytes =
        scene.count * (2 + 4 + 1) * 4 + scene.linkCount * (4 + 1 + 2) * 4;
    }
    return snap;
  }

  /** Documented components of the CPU estimate (an estimate, not an
   * audit): scene buffers, base color/width caches, metric columns,
   * crossfilter columns, mask lanes. */
  function estimateCpuBytes(): number {
    let bytes = 0;
    if (scene !== null) bytes += scene.positions.byteLength + scene.links.byteLength;
    if (basePointColors !== null) bytes += basePointColors.byteLength;
    if (baseLinkColors !== null) bytes += baseLinkColors.byteLength;
    if (lastLinkWidths !== null) bytes += lastLinkWidths.byteLength;
    bytes += metricStore.estimatedBytes();
    if (crossfilterEngine !== null) bytes += crossfilterEngine.estimatedBytes();
    if (softMask !== null) bytes += softMask.estimatedBytes();
    return bytes;
  }

  /** camera durations coerce to 0 under effective reduced motion. */
  function cameraZoom(factor: number): void {
    const eng = engineIfReady();
    if (eng === null) return;
    if (effectiveReducedMotion()) eng.zoom(factor, 0);
    else eng.zoom(factor);
  }

  // -------------------------------------------------------------------------
  // Styling reads
  // -------------------------------------------------------------------------

  /** legend surface. v0.8 tier: categorical counts are TOTALS over the
   * accepted model; no mask- or scope-aware "filtered" count is exposed.
   * Domains resolve through the SAME frozen
   * DomainStore coordinates the projection uses (idempotent). */
  function getScaleInfo(channel: 'nodeColor' | 'nodeSize'): ScaleChannelInfo<N> | null {
    const raw: unknown = channel === 'nodeColor' ? nodeColor : nodeSize;
    if (!isScaleValue(raw)) return null;
    const scale = raw;
    if (scale.kind === 'categorical') {
      const palette =
        scale.palette ?? (channel === 'nodeColor' ? CATEGORICAL_PALETTE : ([] as const));
      const by = categoricalByGetter(scale.by as Parameters<typeof categoricalByGetter>[0]);
      const counts = new Map<string, number>();
      if (accepted !== null) {
        for (const node of accepted.nodes) {
          const v = by(node);
          if (v === null) continue;
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      }
      const rows: ScaleInfoRow[] = categoricalRows(scale.domain, counts.keys()).map((value) => ({
        value,
        count: counts.get(value) ?? 0,
        colorIndex: categoricalIndex(scale.domain, palette, value),
      }));
      return { scale, rows };
    }
    if (accepted === null) return { scale };
    const domain = resolveScaleDomain(scale);
    return domain === null ? { scale } : { scale, domain };
  }

  /** one metric value via the core id→index map (no public Map copy).
   * Degree-family values compute lazily on first use per model revision. */
  function getMetricValue(metric: MetricName, id: NodeId): number | null {
    if (accepted === null) return null;
    const idx = accepted.nodeIndex.get(id);
    if (idx === undefined) return null;
    if (!ensureMetricModel()) return null;
    return metricStore.getMetricValue(metric, idx);
  }

  return {
    store,
    labels: {
      subscribeCandidates: (cb) => subscribeLabelChannel(candidateSubs, cb),
      subscribePositions: (cb) => subscribeLabelChannel(positionSubs, cb),
    },
    applyHostUpdate,
    beginIngest,
    removeOverlay,
    getOverlayIds: () => store.getState().overlayIds,
    attach,
    detach,
    destroy,
    on,
    fitView: () => {
      const eng = engineIfReady();
      if (eng === null) return;
      if (effectiveReducedMotion()) eng.fitView({ durationMs: 0 });
      else eng.fitView();
    },
    zoomIn: () => {
      cameraZoom(ZOOM_STEP);
    },
    zoomOut: () => {
      cameraZoom(1 / ZOOM_STEP);
    },
    setViewport: (v: Partial<ViewportState>) => {
      const eng = engineIfReady();
      if (eng === null) return;
      if (effectiveReducedMotion()) eng.setViewport(v, { durationMs: 0 });
      else eng.setViewport(v);
    },
    focusNode,
    emphasizeNode,
    requestNodeContextMenu,
    getViewState,
    setViewState,
    exportImage,
    exportData,
    exportDataStream,
    exportLayout,
    exportLayoutStream,
    setSelection,
    selectNodes,
    selectEdges,
    selectGroups,
    selectNeighbors,
    selectAll,
    invertSelection,
    clearSelection,
    selectWithinPolygon,
    pickEdgeAt,
    sampleEdgeHover,
    sampleEdgeClick,
    getFrameCadence: () => frameCadence,
    getPerfCounters: () => perfCounters,
    getPerfSnapshot,
    hideNodes,
    showNodes,
    showAll,
    pinNode,
    unpinNode,
    clearPins,
    pinNodes,
    unpinNodes,
    groupNodes,
    ungroup,
    setGroupCollapsed,
    foldNode,
    unfoldNode,
    getFold,
    getClusters,
    selectCluster,
    isolateSelection,
    resetIsolation,
    expandNode,
    retractExpansion,
    getExpansionOverlays: (id: NodeId) => {
      const records = expansionOverlays.get(id);
      return records === undefined ? EMPTY_EXPANSION_RECORDS : [...records];
    },
    search,
    clearSearch,
    activateSearchResult,
    findPath,
    clearPath,
    getActivePath,
    pauseSimulation: () => {
      if (destroyed) return;
      const eng = engineIfReady();
      if (eng === null) return;
      eng.pause();
      if (store.getState().simulationRunning) publish({ simulationRunning: false });
    },
    resumeSimulation: () => {
      if (destroyed) return;
      const eng = engineIfReady();
      if (eng === null) return;
      eng.start();
      if (!store.getState().simulationRunning) publish({ simulationRunning: true });
    },
    isSimulationRunning: () => store.getState().simulationRunning,
    captureScreenshot: () => {
      const eng = engineIfReady();
      if (eng === null || eng.captureScreenshot === undefined) return Promise.resolve(null);
      return eng.captureScreenshot().catch(() => null);
    },
    setReducedMotion: (v: boolean | undefined) => {
      bindingReducedMotion = v;
    },
    getCrossfilterSession,
    playTimeline,
    pauseTimeline,
    undo,
    redo,
    getScaleInfo,
    getMetricValue,
    getRevisions: () => store.getState().revisions,
    getDiagnostics: () => store.getState().diagnostics,
    getNode,
    getEdge,
    getVisibleNodeIds: () => {
      if (scene === null) return EMPTY_IDS;
      // PHYSICAL slots only — internal scene keys of the
      // synthetic suffix never escape public payloads.
      const bound = physicalPointCount();
      if (softMask === null && bound === scene.count) return scene.idByIndex;
      // scene ids restricted to mask-visible slots (scope ∧ mask).
      const out: NodeId[] = [];
      for (let i = 0; i < bound; i++) {
        if (softMask === null || softMask.isNodeVisible(i)) out.push(scene.idByIndex[i]!);
      }
      return out;
    },
    getSceneNodeIds: () => {
      if (scene === null) return EMPTY_IDS;
      // the navigator roster stays physical; group entries arrive
      // with the event/namespace wiring.
      const bound = physicalPointCount();
      return bound === scene.count ? scene.idByIndex : scene.idByIndex.slice(0, bound);
    },
    getAccessibility: () => accessibilityConfig,
  };
}
