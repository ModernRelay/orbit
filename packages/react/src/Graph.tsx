/**
 * <Graph> — the declarative React binding over a headless GraphInstance.
 *
 * Binding parity: one committed render that changes multiple declarative
 * props issues AT MOST ONE applyHostUpdate carrying exactly the changed keys,
 * so a multi-prop commit produces exactly one store revision and at most one
 * engine commit.
 */

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { CSSProperties, ForwardedRef, ReactElement, ReactNode, RefAttributes } from 'react';
import {
  canonicalJson,
  canonicalScaleKey,
  createGraphInstance,
  sameGroupSpecArrays,
} from '@modernrelay/orbit-core';
import type {
  Accessor,
  AcceptedEdge,
  AccessibilityConfig,
  BeginIngestOptions,
  ClusterSpec,
  CreateGraphInstanceOptions,
  CrossfilterSession,
  DimensionSpec,
  ExpandNodeResult,
  FilterExpr,
  FilterSpec,
  GraphDiagnostic,
  GraphHostUpdate,
  GraphInstance,
  GraphNode,
  GraphSnapshotInput,
  GraphTheme,
  GraphViewState,
  GroupBySpec,
  GroupSpec,
  IngestSession,
  JsonValue,
  LabelConfig,
  LayoutKind,
  MetaEdge,
  MetricColumn,
  PathOptions,
  PathResult,
  MetricName,
  NodeId,
  ResolvedCluster,
  ResolvedGroup,
  Revisions,
  Scale,
  ScaleChannelInfo,
  SearchResult,
  SearchUnavailableReason,
  SelectionState,
  ScaleLimits,
  WorkerFactoryOption,
  DegradeEvent,
  GraphPerfSnapshot,
  SetViewStateResult,
  SimulationConfig,
  SubgraphSpec,
  ThemeInput,
  TimelinePlayback,
  ViewportState,
} from '@modernrelay/orbit-core';
import type { EngineFactory, FitViewOptions } from '@modernrelay/orbit-core/engine';
import { GraphProvider } from './GraphProvider';
import { setSearchResultUnavailableCallback, useScaleInfoSubscription } from './hooks';
import { Lasso } from './Lasso';
import { LabelLayer } from './LabelLayer';
import { LiveRegion } from './LiveRegion';
import { overlaySurface, visuallyHiddenStyle } from './components/shared';

/** Snapshot handed to `renderLegend`: the active scale info per styling
 * channel (null when the channel is not scale-valued) plus the resolved
 * theme tokens. Recomputed on model/scope/render/theme store changes. */
export interface GraphLegendRenderInfo<N = Record<string, unknown>> {
  nodeColor: ScaleChannelInfo<N> | null;
  nodeSize: ScaleChannelInfo<N> | null;
  theme: GraphTheme;
}

export interface GraphProps<N = Record<string, unknown>, E = Record<string, unknown>> {
  /** Engine factory; captured at first render — one factory per instance. */
  engine: EngineFactory;
  data?: GraphSnapshotInput<N, E>;
  /** Constant, accessor, or Scale descriptor. Scale-valued props compare
   * by canonical structural value — equal inline literals never reproject. */
  nodeColor?: Accessor<GraphNode<N>, string> | Scale<string, N>;
  nodeSize?: Accessor<GraphNode<N>, number> | Scale<number, N>;
  linkColor?: Accessor<AcceptedEdge<E>, string>;
  linkWidth?: Accessor<AcceptedEdge<E>, number>;
  layout?: LayoutKind;
  simulation?: SimulationConfig;
  /** theme tokens: full GraphTheme, Partial over a named base, or the
   * v0.1 `{background}` shorthand. Diffed structurally (JSON). */
  theme?: ThemeInput;
  /** async metric columns, joined once with revision-gated admission.
   * Diffed by array reference. */
  metrics?: readonly MetricColumn[];
  /** image sprites: synchronous string-ref accessor (URL/blob ref/cache
   * key — opaque to orbit). Diffed by reference. */
  nodeImage?: (node: GraphNode<N>) => string | null;
  /** instanced arrowheads (capability-gated; inert when unsupported). */
  edgeArrows?: boolean;
  /** runtime link-render toggle — a config-only commit. */
  showLinks?: boolean;
  /** emphasis-ring toggle (default true). False clears the ring once and
   * suppresses every driver (hover, focusNode, emphasizeNode). */
  emphasisRing?: boolean;
  /** legend escape hatch: rendered inside the provider in a positioned
   * wrapper (bottom-left) whenever provided; re-invoked when scale info or
   * theme changes. Return custom JSX, or compose <GraphLegend> from
   * '@modernrelay/orbit-react/components/Legend' for the built-in rendering. */
  renderLegend?: (info: GraphLegendRenderInfo<N>) => ReactNode;
  /** DOM label lane; forwarded through applyHostUpdate. `enabled: false`
   * also unmounts the <LabelLayer> overlay entirely. */
  labels?: LabelConfig<N>;
  /** accessibility runtime options; forwarded through applyHostUpdate
   * and mirrored onto the container ARIA surface / live region. */
  accessibility?: AccessibilityConfig<N>;
  /** Class hook applied to every DOM label div. */
  labelClassName?: string;
  /** Escape hatch: custom label content rendered INSIDE the positioned label
   * div, replacing the default text node. */
  renderNodeLabel?: (ctx: { node: GraphNode<N>; text: string }) => ReactNode;
  /** Class hook applied to cluster label divs, in addition to
   * `labelClassName`. */
  clusterLabelClassName?: string;
  /** Escape hatch: custom cluster-label content (replaces the default text
   * node; text-node-only rendering otherwise). `memberIds` are the ids a
   * click selects. */
  renderClusterLabel?: (ctx: {
    clusterKey: string;
    text: string;
    memberIds: readonly NodeId[];
  }) => ReactNode;
  /** Controlled selection of the NODE namespace; providing it once flips
   * ownership permanently. Edge/group namespaces stay instance-owned. */
  selection?: readonly NodeId[];
  /** hard scope: feed ONLY the resolved subset through the reconciler;
   * `null` restores the full accepted model. Diffed STRUCTURALLY (specs are
   * small), so a new-but-equal object is a no-op. UNCONTROLLED-ONLY in v0.5:
   * this prop and isolateSelection/resetIsolation write the same
   * instance-owned state — last writer wins, and omitting the prop leaves
   * the last written scope in place. */
  subgraph?: SubgraphSpec | null;
  /** soft filter: mask (hide/dim) with ZERO relayout; `null` clears.
   * Diffed by canonical structural compare — serializable exprs by JSON,
   * function predicates by reference — so a new-but-equal spec never
   * re-publishes (and the core no-ops canonical-equal specs regardless). */
  filter?: FilterSpec<N, E> | null;
  /** crossfilter dimensions (declarative; brushes live on the session
   * — reach it via useGraphCrossfilter or handle.getCrossfilterSession).
   * Forwarded on array-reference change; the core no-ops when every
   * DimensionSpec element is reference-equal. */
  crossfilter?: readonly DimensionSpec<N>[];
  /** manual groups; `null` clears. Diffed STRUCTURALLY (equal inline
   * literals never re-forward). Providing it once flips the groups slice to
   * CONTROLLED: handle ops then fire onGroupsChange with the next
   * array instead of writing — reflect it back here. Config error together
   * with `groupBy`. */
  groups?: readonly GroupSpec[] | null;
  /** derived grouping; `null` clears. Reference-diffed (the spec
   * carries a function accessor); the core additionally no-ops structurally
   * equal respecs. Membership under groupBy is derived and READ-ONLY
   * groupNodes/ungroup become config errors; setGroupCollapsed toggles the
   * instance-owned per-key collapsed residue. */
  groupBy?: GroupBySpec<N> | null;
  /** stage-4 non-collapsing clusters; `null` clears (D2).
   * Reference-diffed (the spec carries a function accessor). Clusters PRESERVE
   * every node and edge — they never collapse anything — so they coexist with
   * `groups`/`groupBy`. Their labels ride the overlay lane under
   * `labels.maxZoom` and select their member nodes on click. */
  clusters?: ClusterSpec<N> | null;
  /** PERSISTENT pins — independent of transient drag
   * pinning: the engine receives the UNION, so releasing a drag on a
   * persistently-pinned node leaves it pinned. Providing it once latches the
   * slice controlled: handle ops then fire onPinnedChange with the
   * next array instead of writing. `null` clears (D2). */
  pinnedNodeIds?: readonly NodeId[] | null;
  /** node attr fields the DEFAULT search service indexes (ids always).
   * Absent = id-only search — the service never guesses attr names.
   * CONSTRUCTION-ONLY (D7, spec host construction options): read once at
   * mount; changing it requires a keyed remount (a changed prop warns once
   * and is ignored). */
  searchIndex?: readonly string[];
  /** Degradation-ladder thresholds. CONSTRUCTION-ONLY: read
   * once at mount; a runtime change warns once and is ignored. */
  limits?: Partial<ScaleLimits>;
  /** Execution mode. CONSTRUCTION-ONLY: read once
   * at mount; a runtime change warns once and is ignored. Current worker
   * cargo: columnar acceptance off-thread. */
  execution?: 'auto' | 'main' | 'worker';
  /** Worker construction tri-option. CONSTRUCTION-ONLY. */
  workerFactory?: WorkerFactoryOption;
  /** result contract: the instance-wide DEFAULT for an activated
   * search result that cannot be focused ('not-loaded' | 'out-of-scope' |
   * 'filtered'). `<GraphSearch onResultUnavailable>` overrides it locally;
   * the host reacts explicitly (fetch/publish an overlay, reset isolation,
   * alter filters) — search never mutates scope/filters itself. */
  onSearchResultUnavailable?: (result: SearchResult, reason: SearchUnavailableReason) => void;
  /** Captured at first render (instance construction option). Default true. */
  fitViewOnFirstData?: boolean;
  /** service seam (instance construction option, D7): custom
   * revision-aware services — most usefully an async `expansion` service
   * backed by the host's own data source, so `expandNode`/the context menu's
   * Expand run against the network instead of the built-in local-adjacency
   * walk. CONSTRUCTION-ONLY: read once at mount; changing it requires a keyed
   * remount. */
  services?: CreateGraphInstanceOptions<N, E>['services'];
  /** Shift+drag freeform lasso selection overlay. Default true. */
  enableLasso?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Rendered inside the provider, above (after) the canvas container. */
  children?: ReactNode;
  onNodeClick?: (payload: { node: GraphNode<N>; metaKey?: boolean }) => void;
  onBackgroundClick?: () => void;
  onNodeHover?: (payload: { node: GraphNode<N> | null }) => void;
  onEdgeClick?: (payload: { edge: AcceptedEdge<E> }) => void;
  onEdgeHover?: (payload: { edge: AcceptedEdge<E> | null }) => void;
  onNodeDragStart?: (payload: { node: GraphNode<N> }) => void;
  onNodeDragEnd?: (payload: { node: GraphNode<N>; x: number; y: number }) => void;
  /** Fires with the full namespaced SelectionState. */
  onSelectionChange?: (payload: SelectionState) => void;
  /** ladder step engagement/disengagement (notification pattern). */
  onDegrade?: (event: DegradeEvent) => void;
  /** throttled telemetry sample — never per frame. */
  onPerfSample?: (snapshot: GraphPerfSnapshot) => void;
  /** Fires on a super-node hit with the resolved group payload, never a GraphNode. */
  onGroupClick?: (payload: { group: ResolvedGroup; metaKey?: boolean }) => void;
  /** Fires on a meta-edge hit with the MetaEdge record used by the count badge. */
  onMetaEdgeClick?: (payload: { metaEdge: MetaEdge }) => void;
  /** groups slice change callback: op results (uncontrolled), op
   * INTENTS (controlled — reflect the array back into `groups`), and groupBy
   * re-derivations (notification). Receives the resolved array. */
  onGroupsChange?: (groups: readonly ResolvedGroup[]) => void;
  /** durable source coordinate — forwarded verbatim; serialized into
   * view states and canonically compared on restore. Diffed by canonical
   * JSON, so a new-but-equal object never re-forwards. */
  dataRef?: JsonValue;
  /** aggregate restore intent (fires once per restore/history
   * transaction touching a controlled slice or serialized styling): reflect
   * every participating prop in ONE commit; matching values acknowledge. */
  onViewStateRestore?: (intent: {
    transactionId: string;
    source: 'setViewState' | 'undo' | 'redo';
    next: unknown;
  }) => void;
  /** fired INSTEAD of applying a state whose dataRef mismatches. */
  onViewStateMismatch?: (stored: JsonValue | undefined, current: JsonValue | undefined) => void;
  /** persistent-pin slice change: the applied set when
   * uncontrolled, the INTENT when controlled. */
  onPinnedChange?: (pinnedNodeIds: readonly NodeId[]) => void;
  onViewportChange?: (v: ViewportState) => void;
  onReady?: () => void;
  onError?: (payload: { error: Error }) => void;
}

export interface GraphHandle<N = Record<string, unknown>, E = Record<string, unknown>> {
  /** `opts` is accepted for forward compatibility; core v0.1 ignores it. */
  fitView(opts?: FitViewOptions): void;
  zoomIn(): void;
  zoomOut(): void;
  /** `opts` is accepted for forward compatibility; core v0.1 ignores it. */
  setViewport(v: Partial<ViewportState>, opts?: { durationMs?: number }): void;
  focusNode(id: NodeId): void;
  /** ring-only emphasis, no camera move (null clears; unknown ids
   * no-op). The keyboard-navigation analog of hover. */
  emphasizeNode(id: NodeId | null): void;
  /** telemetry snapshot (never raw attrs or ids). */
  getPerfSnapshot(): GraphPerfSnapshot;
  /** Open the typed context menu for a node from host chrome (a list row, a
   * custom label) — the same 'contextMenu' event the canvas gesture emits.
   * `screen` is container-relative CSS px. */
  requestNodeContextMenu(id: NodeId, screen: readonly [number, number]): void;
  /** serialize the exploration state (see core docs). */
  getViewState(opts?: { includePositions?: false }): GraphViewState;
  /** atomic restore; typed results, never partial. */
  setViewState(
    raw: unknown,
    opts?: { ignoreMismatch?: boolean },
  ): Promise<SetViewStateResult>;
  /** picture export: 'png' via the engine screenshot; 'svg' via the
   * engine-free exporter (typed export-too-large past the bound;
   * raster-hybrid fallback available). */
  exportImage(format: 'png'): Promise<Blob>;
  exportImage(
    format: 'svg',
    opts?: { maxSvgElements?: number; fallback?: 'raster-hybrid' },
  ): Promise<string>;
  /** bounded object export; typed rejection past the limit. */
  exportData(
    scope?: 'visible' | 'accepted',
    opts?: { limit?: number },
  ): Promise<{ nodes: readonly GraphNode<N>[]; edges: readonly AcceptedEdge<E>[] }>;
  /** memory-bounded JSONL stream over one pinned revision. */
  exportDataStream(scope?: 'visible' | 'accepted'): AsyncGenerator<string, void, undefined>;
  /** bounded id → [x, y] map (one position readback). */
  exportLayout(opts?: { limit?: number }): Promise<ReadonlyMap<NodeId, readonly [number, number]>>;
  /** layout JSONL stream over one pinned readback. */
  exportLayoutStream(): AsyncGenerator<string, void, undefined>;
  setSelection(ids: readonly NodeId[]): void;
  clearSelection(): void;
  // --- persistent pins ---
  /** Hold nodes at their CURRENT position (independent of drag pinning). */
  pinNodes(ids: readonly NodeId[]): void;
  unpinNodes(ids: readonly NodeId[]): void;
  // --- paths ---
  /** Resolve + atomically emphasize a path; null = unreachable (a result).
   * Emphasis is session-local — released by clearPath, any selection
   * mutation, undo/redo, or a scene rebuild; never in history/view state. */
  findPath(sourceId: NodeId, targetId: NodeId, options?: PathOptions): Promise<PathResult | null>;
  clearPath(): void;
  // --- selection algebra ---
  /** Expand to the 1-hop neighborhood of `id` (or of the current selection). */
  selectNeighbors(id?: NodeId): void;
  selectAll(): void;
  invertSelection(): void;
  /** Resolve a SCREEN-coordinate polygon to node ids and replace (default) or
   * union (`additive`) the node selection; returns the resolved ids. */
  selectWithinPolygon(
    polygon: readonly [number, number][],
    opts?: { additive?: boolean },
  ): readonly NodeId[];
  // --- pin / hide slices ---
  /** Pin at `xy` (space coords) or at the node's current position. */
  pinNode(id: NodeId, xy?: readonly [number, number]): void;
  unpinNode(id: NodeId): void;
  clearPins(): void;
  hideNodes(ids: readonly NodeId[]): void;
  showAll(): void;
  // --- hard scope + expansion ---
  /** Hard-scope to the current node selection; no-op when empty. */
  isolateSelection(): void;
  /** Clear the hard scope — the full accepted model returns. */
  resetIsolation(): void;
  /** Ego-expand `id` through the configured ExpansionService. */
  expandNode(id: NodeId, opts?: { hops?: number }): Promise<ExpandNodeResult>;
  /** Abort `id`'s pending expansion and remove its committed expansion
   * overlays. */
  retractExpansion(id: NodeId): void;
  // --- group operations ---
  /** Add one group (same acyclic/singly-parented validation as the `groups` prop).
   * Controlled mode fires onGroupsChange with the next array instead. */
  groupNodes(spec: GroupSpec): void;
  /** Remove one group definition; its id prunes from selection.groupIds. */
  ungroup(groupId: string): void;
  /** Collapse/expand one group as a structural diff — the ONE op allowed on
   * groupBy-derived groups (toggles the per-key collapsed residue). */
  setGroupCollapsed(groupId: string, collapsed: boolean): void;
  // --- node folds: an EXISTING node stands for its own neighbourhood.
  // Distinct from `expandNode`/`retractExpansion`, which navigate the data
  // source; a fold is pure containment over what is already loaded. ---
  /** Hide `id`'s neighbourhood behind `id`, rerouting the members' outside
   * edges onto it. Members default to unclaimed neighbours (first fold wins). */
  foldNode(id: NodeId, opts?: { memberIds?: readonly NodeId[] }): void;
  /** Return `id`'s folded members to the scene. No-op when not folded. */
  unfoldNode(id: NodeId): void;
  /** The members `id` stands for, or null when it is not folded. */
  getFold(id: NodeId): { memberIds: readonly NodeId[] } | null;
  // --- stage-4 clusters ---
  /** Current clusters over the physical scene (keys, members, force center,
   * settled centroid). Empty when no `clusters` prop is active. */
  getClusters(): readonly ResolvedCluster[];
  /** Select a cluster's MEMBER node ids; `additive` unions. */
  selectCluster(key: string, opts?: { additive?: boolean }): void;
  // --- revisioned ingestion ---
  /** Begin a bounded, cancellable ingest session. */
  beginIngest(opts: BeginIngestOptions): IngestSession<N, E>;
  /** Atomically remove exactly one committed overlay; unknown ids are an
   * idempotent `{ removed: false }`. */
  removeOverlay(overlayId: string): { removed: boolean };
  // --- history ---
  /** Undo the most recent uncontrolled mutation entry (selection / hidden /
   * pins / scope / brushes). Returns false when there is nothing to undo. */
  undo(): boolean;
  /** Re-apply the most recently undone entry. False when nothing to redo. */
  redo(): boolean;
  // --- timeline playback ---
  /** Play a brush window across a numeric/temporal dimension's domain
   * (crossfilter mask fast path; one playing dimension at a time). */
  playTimeline(key: string, playback?: Partial<TimelinePlayback>): void;
  pauseTimeline(): void;
  // --- crossfilter ---
  /** The crossfilter session facade, or null until the `crossfilter` prop
   * has configured dimensions over an accepted base. */
  getCrossfilterSession(): CrossfilterSession | null;
  // --- styling reads ---
  /** legend surface: the active Scale on a styling channel plus its
   * resolved domain or categorical rows; null when not scale-valued. */
  getScaleInfo(channel: 'nodeColor' | 'nodeSize'): ScaleChannelInfo<N> | null;
  /** metric read for one node id (built-in degree family + admitted
   * columns); null for unknown ids or metrics and for null/non-finite values. */
  getMetricValue(metric: MetricName, id: NodeId): number | null;
  getRevisions(): Revisions;
  getDiagnostics(): readonly GraphDiagnostic[];
  instance: GraphInstance<N, E>;
}

/** Last-committed declarative props. Fields are `| undefined` (not optional)
 * so the diff record is assignable under exactOptionalPropertyTypes. */
interface CommittedProps<N, E> {
  data: GraphSnapshotInput<N, E> | undefined;
  nodeColor: Accessor<GraphNode<N>, string> | Scale<string, N> | undefined;
  /** Canonical structural key when the committed nodeColor is a Scale;
   * undefined for accessor/constant forms (those diff by reference). */
  nodeColorKey: string | undefined;
  nodeSize: Accessor<GraphNode<N>, number> | Scale<number, N> | undefined;
  nodeSizeKey: string | undefined;
  linkColor: Accessor<AcceptedEdge<E>, string> | undefined;
  linkWidth: Accessor<AcceptedEdge<E>, number> | undefined;
  layout: LayoutKind | undefined;
  simulation: SimulationConfig | undefined;
  /** JSON form of the last committed `theme` prop (small token set). */
  themeJson: string | undefined;
  metrics: readonly MetricColumn[] | undefined;
  nodeImage: ((node: GraphNode<N>) => string | null) | undefined;
  edgeArrows: boolean | undefined;
  showLinks: boolean | undefined;
  emphasisRing: boolean | undefined;
  selection: readonly NodeId[] | undefined;
  labels: LabelConfig<N> | undefined;
  accessibility: AccessibilityConfig<N> | undefined;
  /** JSON form of the last committed `subgraph` prop — specs are small, so
   * the diff is a structural string compare ('null' when scope cleared). */
  subgraphJson: string | undefined;
  /** Last committed `filter` prop + its canonical key: exprs compare
   * by JSON, function predicates by reference. */
  filter: FilterSpec<N, E> | null | undefined;
  filterKey: string | undefined;
  /** Last committed `crossfilter` prop, compared by array reference. */
  crossfilter: readonly DimensionSpec<N>[] | undefined;
  /** Last committed `groups` prop (structural diff via sameGroupSpecArrays;
   * — equal inline literals never re-forward). */
  groups: readonly GroupSpec[] | null | undefined;
  dataRef: JsonValue | undefined;
  /** Last committed `groupBy` prop (reference diff — function-bearing). */
  groupBy: GroupBySpec<N> | null | undefined;
  /** Last committed `clusters` prop (reference diff — function-bearing). */
  clusters: ClusterSpec<N> | null | undefined;
  /** Last committed `pinnedNodeIds` prop, compared by shallow element diff. */
  pinnedNodeIds: readonly NodeId[] | null | undefined;
  /** Last committed `searchIndex` prop (shallow element diff). */
  searchIndex: readonly string[] | undefined;
}

/**
 * Canonical key of a scale-valued styling channel: `canonicalScaleKey`
 * when the value is a Scale descriptor, undefined for constant/accessor forms
 * (which diff by reference). Equal inline scale literals therefore never
 * re-forward; a function `by` keys by reference identity inside the core.
 */
function scaleKeyOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== 'sequential' && kind !== 'categorical' && kind !== 'diverging') return undefined;
  return canonicalScaleKey(value as Scale<unknown>);
}

/** Diff one nodeColor/nodeSize channel: scale forms compare by canonical key,
 * everything else by reference (a scale↔accessor flip always differs). */
function styleChannelChanged(
  prevValue: unknown,
  prevKey: string | undefined,
  nextValue: unknown,
  nextKey: string | undefined,
): boolean {
  if (nextKey !== undefined || prevKey !== undefined) return nextKey !== prevKey;
  return prevValue !== nextValue;
}

/** Canonical key of one filter side: 'u' absent, 'fn' a function predicate
 * (paired with a reference compare), else the expr JSON. */
function filterSideKey(side: FilterExpr | ((item: never) => boolean) | undefined): string {
  if (side === undefined) return 'u';
  if (typeof side === 'function') return 'fn';
  return JSON.stringify(side);
}

function filterKeyOf<N, E>(spec: FilterSpec<N, E> | null): string {
  if (spec === null) return 'null';
  return `${spec.mode ?? 'hide'}|${filterSideKey(spec.nodes)}|${filterSideKey(spec.edges)}`;
}

/** Canonical-equal check: keys match AND any function sides are the SAME
 * references (a changed predicate function must re-evaluate). */
function sameFilterSpec<N, E>(
  prev: FilterSpec<N, E> | null | undefined,
  prevKey: string | undefined,
  next: FilterSpec<N, E> | null,
  nextKey: string,
): boolean {
  if (prevKey === undefined || prevKey !== nextKey) return false;
  if (next === null) return prev === null;
  if (prev === null || prev === undefined) return false;
  if (typeof next.nodes === 'function' && next.nodes !== prev.nodes) return false;
  if (typeof next.edges === 'function' && next.edges !== prev.edges) return false;
  return true;
}

interface CallbackHolder<N, E> {
  onNodeClick: ((payload: { node: GraphNode<N>; metaKey?: boolean }) => void) | undefined;
  onBackgroundClick: (() => void) | undefined;
  onNodeHover: ((payload: { node: GraphNode<N> | null }) => void) | undefined;
  onEdgeClick: ((payload: { edge: AcceptedEdge<E> }) => void) | undefined;
  onEdgeHover: ((payload: { edge: AcceptedEdge<E> | null }) => void) | undefined;
  onNodeDragStart: ((payload: { node: GraphNode<N> }) => void) | undefined;
  onNodeDragEnd: ((payload: { node: GraphNode<N>; x: number; y: number }) => void) | undefined;
  onSelectionChange: ((payload: SelectionState) => void) | undefined;
  onDegrade: ((event: DegradeEvent) => void) | undefined;
  onPerfSample: ((snapshot: GraphPerfSnapshot) => void) | undefined;
  onGroupClick: ((payload: { group: ResolvedGroup; metaKey?: boolean }) => void) | undefined;
  onMetaEdgeClick: ((payload: { metaEdge: MetaEdge }) => void) | undefined;
  onGroupsChange: ((groups: readonly ResolvedGroup[]) => void) | undefined;
  onViewStateRestore:
    | ((intent: {
        transactionId: string;
        source: 'setViewState' | 'undo' | 'redo';
        next: unknown;
      }) => void)
    | undefined;
  onViewStateMismatch:
    | ((stored: JsonValue | undefined, current: JsonValue | undefined) => void)
    | undefined;
  onPinnedChange: ((pinnedNodeIds: readonly NodeId[]) => void) | undefined;
  onViewportChange: ((v: ViewportState) => void) | undefined;
  onReady: (() => void) | undefined;
  onError: ((payload: { error: Error }) => void) | undefined;
}

function sameIdArrays(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const CONTAINER_BASE_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
};

// The canvas layer fills the outer div; children render after it in DOM order
// so they naturally stack above the canvas.
const CANVAS_STYLE: CSSProperties = { position: 'absolute', inset: 0 };

/** Positioned wrapper for the `renderLegend` slot: bottom-left, above
 * the canvas, interactive (category rows are clickable). */
const LEGEND_SLOT_STYLE: CSSProperties = {
  position: 'absolute',
  left: 12,
  bottom: 12,
};

/** `renderLegend` slot host: re-reads getScaleInfo on every store publication
 * that can move scale info (model/scope/render revisions) or theme change,
 * and re-invokes the host's render function with the fresh snapshot. */
function LegendSlot<N, E>(props: {
  instance: GraphInstance<N, E>;
  renderLegend: (info: GraphLegendRenderInfo<N>) => ReactNode;
}): ReactElement {
  const { instance } = props;
  const { version, theme } = useScaleInfoSubscription(instance);
  const info = useMemo<GraphLegendRenderInfo<N>>(
    () => ({
      nodeColor: instance.getScaleInfo('nodeColor'),
      nodeSize: instance.getScaleInfo('nodeSize'),
      theme,
    }),
    // `version` is the invalidation token: a new store revision can change
    // what getScaleInfo returns without changing any other dependency.
    [instance, theme, version],
  );
  return (
    <div data-orbit-legend-slot="" style={LEGEND_SLOT_STYLE}>
      {props.renderLegend(info)}
    </div>
  );
}

function GraphInner<N, E>(
  props: GraphProps<N, E>,
  ref: ForwardedRef<GraphHandle<N, E>>,
): ReactElement {
  // Lazy, once per mounted component. `engine`/`fitViewOnFirstData`/
  // `searchIndex` are construction options (D7); later changes to them are
  // intentionally ignored (searchIndex additionally warns once below).
  const [instance] = useState<GraphInstance<N, E>>(() => {
    const options: CreateGraphInstanceOptions<N, E> = { engine: props.engine };
    if (props.fitViewOnFirstData !== undefined) {
      options.fitViewOnFirstData = props.fitViewOnFirstData;
    }
    if (props.searchIndex !== undefined) options.searchIndex = props.searchIndex;
    if (props.limits !== undefined) options.limits = props.limits;
    if (props.execution !== undefined) options.execution = props.execution;
    if (props.workerFactory !== undefined) options.workerFactory = props.workerFactory;
    if (props.services !== undefined) options.services = props.services;
    return createGraphInstance<N, E>(options);
  });
  const searchIndexWarnedRef = useRef(false);
  const limitsWarnedRef = useRef(false);
  const initialLimitsRef = useRef(props.limits);
  if (props.limits !== initialLimitsRef.current && !limitsWarnedRef.current) {
    limitsWarnedRef.current = true;
    console.warn(
      'orbit: `limits` is a construction-only prop — the runtime change is ignored; remount with a key to apply new thresholds.',
    );
  }
  const executionWarnedRef = useRef(false);
  const initialExecutionRef = useRef(props.execution);
  if (props.execution !== initialExecutionRef.current && !executionWarnedRef.current) {
    executionWarnedRef.current = true;
    console.warn(
      'orbit: `execution` is a construction-only prop — the runtime change is ignored; remount with a key to switch lanes.',
    );
  }

  const containerRef = useRef<HTMLDivElement | null>(null);

  // --- latest-callback holder: event subscriptions read through this ref so
  // per-render callback identity churn never resubscribes ---
  const callbacksRef = useRef<CallbackHolder<N, E>>({
    onNodeClick: undefined,
    onBackgroundClick: undefined,
    onNodeHover: undefined,
    onEdgeClick: undefined,
    onEdgeHover: undefined,
    onNodeDragStart: undefined,
    onNodeDragEnd: undefined,
    onSelectionChange: undefined,
    onDegrade: undefined,
    onPerfSample: undefined,
    onGroupClick: undefined,
    onMetaEdgeClick: undefined,
    onGroupsChange: undefined,
    onViewStateRestore: undefined,
    onViewStateMismatch: undefined,
    onPinnedChange: undefined,
    onViewportChange: undefined,
    onReady: undefined,
    onError: undefined,
  });
  useLayoutEffect(() => {
    callbacksRef.current = {
      onNodeClick: props.onNodeClick,
      onBackgroundClick: props.onBackgroundClick,
      onNodeHover: props.onNodeHover,
      onEdgeClick: props.onEdgeClick,
      onEdgeHover: props.onEdgeHover,
      onNodeDragStart: props.onNodeDragStart,
      onNodeDragEnd: props.onNodeDragEnd,
      onSelectionChange: props.onSelectionChange,
      onDegrade: props.onDegrade,
      onPerfSample: props.onPerfSample,
      onGroupClick: props.onGroupClick,
      onMetaEdgeClick: props.onMetaEdgeClick,
      onGroupsChange: props.onGroupsChange,
      onViewStateRestore: props.onViewStateRestore,
      onViewStateMismatch: props.onViewStateMismatch,
      onPinnedChange: props.onPinnedChange,
      onViewportChange: props.onViewportChange,
      onReady: props.onReady,
      onError: props.onError,
    };
  });

  // --- event subscriptions: keyed on the instance only; identity churn of
  // the props is absorbed by callbacksRef. A LAYOUT effect so it commits
  // BEFORE the prop-diff layout effect of the NEXT render pass — and on the
  // first pass the subscriptions land in the same commit as the initial
  // host update's effects; events fired during that first applyHostUpdate
  // (e.g. a mount-time 'degrade' engagement) are re-emittable states
  // that the ladder re-evaluates, but ordering here still matters for any
  // strictly edge-triggered channel, so subscriptions must not lag a frame
  // behind the data. ---
  useLayoutEffect(() => {
    const offs = [
      instance.on('nodeClick', (p) => callbacksRef.current.onNodeClick?.(p)),
      instance.on('backgroundClick', () => callbacksRef.current.onBackgroundClick?.()),
      instance.on('nodeHover', (p) => callbacksRef.current.onNodeHover?.(p)),
      instance.on('edgeClick', (p) => callbacksRef.current.onEdgeClick?.(p)),
      instance.on('edgeHover', (p) => callbacksRef.current.onEdgeHover?.(p)),
      instance.on('nodeDragStart', (p) => callbacksRef.current.onNodeDragStart?.(p)),
      instance.on('nodeDragEnd', (p) => callbacksRef.current.onNodeDragEnd?.(p)),
      instance.on('selectionChange', (p) => callbacksRef.current.onSelectionChange?.(p)),
      instance.on('degrade', (p) => callbacksRef.current.onDegrade?.(p)),
      instance.on('perfSample', (p) => callbacksRef.current.onPerfSample?.(p)),
      instance.on('groupClick', (p) => callbacksRef.current.onGroupClick?.(p)),
      instance.on('metaEdgeClick', (p) => callbacksRef.current.onMetaEdgeClick?.(p)),
      instance.on('groupsChange', (p) => callbacksRef.current.onGroupsChange?.(p.groups)),
      instance.on('viewStateRestore', (p) => callbacksRef.current.onViewStateRestore?.(p)),
      instance.on('viewStateMismatch', (p) =>
        callbacksRef.current.onViewStateMismatch?.(p.stored, p.current),
      ),
      instance.on('pinnedChange', (p) => callbacksRef.current.onPinnedChange?.(p.pinnedNodeIds)),
      instance.on('viewportChange', (v) => callbacksRef.current.onViewportChange?.(v)),
      instance.on('ready', () => callbacksRef.current.onReady?.()),
      instance.on('error', (p) => callbacksRef.current.onError?.(p)),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [instance]);

  // --- prop → host update: diff against the previous committed render and
  // issue at most one applyHostUpdate with exactly the changed keys ---
  const prevRef = useRef<CommittedProps<N, E> | null>(null);
  useLayoutEffect(() => {
    const prev = prevRef.current;
    const update: GraphHostUpdate<N, E> = {};
    let dirty = false;

    if (props.data !== undefined && (prev === null || prev.data !== props.data)) {
      update.data = props.data;
      dirty = true;
    }
    // scale-aware channels: Scale descriptors diff by canonical
    // structural key (equal inline literals never re-forward); accessor and
    // constant forms keep the reference diff.
    const nodeColorKey = scaleKeyOf(props.nodeColor);
    if (
      props.nodeColor !== undefined &&
      (prev === null ||
        styleChannelChanged(prev.nodeColor, prev.nodeColorKey, props.nodeColor, nodeColorKey))
    ) {
      update.nodeColor = props.nodeColor;
      dirty = true;
    }
    const nodeSizeKey = scaleKeyOf(props.nodeSize);
    if (
      props.nodeSize !== undefined &&
      (prev === null ||
        styleChannelChanged(prev.nodeSize, prev.nodeSizeKey, props.nodeSize, nodeSizeKey))
    ) {
      update.nodeSize = props.nodeSize;
      dirty = true;
    }
    if (props.linkColor !== undefined && (prev === null || prev.linkColor !== props.linkColor)) {
      update.linkColor = props.linkColor;
      dirty = true;
    }
    if (props.linkWidth !== undefined && (prev === null || prev.linkWidth !== props.linkWidth)) {
      update.linkWidth = props.linkWidth;
      dirty = true;
    }
    if (props.layout !== undefined && (prev === null || prev.layout !== props.layout)) {
      update.layout = props.layout;
      dirty = true;
    }
    if (
      props.simulation !== undefined &&
      (prev === null || prev.simulation !== props.simulation)
    ) {
      update.simulation = props.simulation;
      dirty = true;
    }
    // theme: a small token set — diffed structurally (JSON), so a
    // new-but-equal inline object never re-publishes.
    let themeJson: string | undefined;
    if (props.theme !== undefined) {
      themeJson = JSON.stringify(props.theme);
      if (prev === null || prev.themeJson !== themeJson) {
        update.theme = props.theme;
        dirty = true;
      }
    }
    // metric columns: array-reference diff (columns are one-shot joins).
    if (props.metrics !== undefined && (prev === null || prev.metrics !== props.metrics)) {
      update.metrics = props.metrics;
      dirty = true;
    }
    // image refs: function-prop contract — reference diff.
    if (props.nodeImage !== undefined && (prev === null || prev.nodeImage !== props.nodeImage)) {
      update.nodeImage = props.nodeImage;
      dirty = true;
    } else if (props.nodeImage === undefined && prev !== null && prev.nodeImage !== undefined) {
      // Removing the prop forwards the explicit clear; the natural
      // React idiom must not silently freeze the last accessor's images.
      update.nodeImage = null;
      dirty = true;
    }
    // Display toggles use plain value diffing for config-only commits.
    if (props.edgeArrows !== undefined && (prev === null || prev.edgeArrows !== props.edgeArrows)) {
      update.edgeArrows = props.edgeArrows;
      dirty = true;
    }
    if (props.showLinks !== undefined && (prev === null || prev.showLinks !== props.showLinks)) {
      update.showLinks = props.showLinks;
      dirty = true;
    }
    if (
      props.emphasisRing !== undefined &&
      (prev === null || prev.emphasisRing !== props.emphasisRing)
    ) {
      update.emphasisRing = props.emphasisRing;
      dirty = true;
    } else if (
      props.emphasisRing === undefined &&
      prev !== null &&
      prev.emphasisRing !== undefined
    ) {
      // Removing the prop restores the documented default (true); the
      // natural React idiom must not leave the ring silently disabled.
      update.emphasisRing = true;
      dirty = true;
    }
    if (
      props.selection !== undefined &&
      (prev === null ||
        prev.selection === undefined ||
        !sameIdArrays(prev.selection, props.selection))
    ) {
      update.selection = props.selection;
      dirty = true;
    }
    if (props.labels !== undefined && (prev === null || prev.labels !== props.labels)) {
      update.labels = props.labels;
      dirty = true;
    }
    if (
      props.accessibility !== undefined &&
      (prev === null || prev.accessibility !== props.accessibility)
    ) {
      update.accessibility = props.accessibility;
      dirty = true;
    }
    // hard scope: structural (JSON) diff — a new-but-equal spec object
    // never re-publishes. An omitted prop is never forwarded (uncontrolled).
    let subgraphJson: string | undefined;
    if (props.subgraph !== undefined) {
      subgraphJson = JSON.stringify(props.subgraph);
      if (prev === null || prev.subgraphJson !== subgraphJson) {
        update.subgraph = props.subgraph;
        dirty = true;
      }
    }
    // soft filter: canonical structural diff (exprs by JSON, function
    // predicates by reference). An omitted prop is never forwarded.
    let filterKey: string | undefined;
    if (props.filter !== undefined) {
      filterKey = filterKeyOf(props.filter);
      if (
        prev === null ||
        !sameFilterSpec(prev.filter, prev.filterKey, props.filter, filterKey)
      ) {
        update.filter = props.filter;
        dirty = true;
      }
    }
    // crossfilter dimensions: forwarded on array-reference change; the
    // core no-ops when every DimensionSpec element is reference-equal.
    if (
      props.crossfilter !== undefined &&
      (prev === null || prev.crossfilter !== props.crossfilter)
    ) {
      update.crossfilter = props.crossfilter;
      dirty = true;
    }
    // groups: structural diff (equal inline literals never
    // re-forward). An omitted prop is never forwarded — but ONCE provided
    // the core latches the slice controlled.
    if (props.dataRef !== undefined) {
      const prevRef = prev === null ? undefined : prev.dataRef;
      if (prevRef === undefined || canonicalJson(props.dataRef) !== canonicalJson(prevRef)) {
        update.dataRef = props.dataRef;
        dirty = true;
      }
    }
    if (props.groups !== undefined) {
      const prevGroups = prev === null ? undefined : prev.groups;
      if (prevGroups === undefined || !sameGroupSpecArrays(prevGroups, props.groups)) {
        update.groups = props.groups;
        dirty = true;
      }
    }
    // groupBy: reference diff (the spec carries a function accessor);
    // the core additionally no-ops structurally equal respecs.
    if (props.groupBy !== undefined && (prev === null || prev.groupBy !== props.groupBy)) {
      update.groupBy = props.groupBy;
      dirty = true;
    }
    // clusters: reference diff (function-bearing spec); the core
    // re-derives membership only on a `by` identity change.
    if (props.clusters !== undefined && (prev === null || prev.clusters !== props.clusters)) {
      update.clusters = props.clusters;
      dirty = true;
    }
    // pinnedNodeIds: shallow element diff (a small id list); ONCE
    // provided the core latches the slice controlled.
    if (props.pinnedNodeIds !== undefined) {
      const prevPinned = prev === null ? undefined : prev.pinnedNodeIds;
      const changed =
        prevPinned === undefined ||
        prevPinned === null ||
        props.pinnedNodeIds === null ||
        !sameIdArrays(prevPinned, props.pinnedNodeIds);
      if (changed) {
        update.pinnedNodeIds = props.pinnedNodeIds;
        dirty = true;
      }
    }
    // searchIndex is construction-only and is read once above. A
    // changed prop cannot take effect without a keyed remount — warn once
    // (shallow element diff, so a new-but-equal inline literal is fine).
    if (
      prev !== null &&
      !sameIdArrays(prev.searchIndex ?? [], props.searchIndex ?? []) &&
      !searchIndexWarnedRef.current
    ) {
      searchIndexWarnedRef.current = true;
      console.warn(
        '[orbit] searchIndex is construction-only: the changed value was ignored — key-remount <Graph> to change it',
      );
    }

    prevRef.current = {
      data: props.data,
      nodeColor: props.nodeColor,
      nodeColorKey,
      nodeSize: props.nodeSize,
      nodeSizeKey,
      linkColor: props.linkColor,
      linkWidth: props.linkWidth,
      layout: props.layout,
      simulation: props.simulation,
      themeJson,
      metrics: props.metrics,
      nodeImage: props.nodeImage,
      edgeArrows: props.edgeArrows,
      showLinks: props.showLinks,
      emphasisRing: props.emphasisRing,
      selection: props.selection,
      labels: props.labels,
      accessibility: props.accessibility,
      subgraphJson,
      filter: props.filter,
      filterKey,
      crossfilter: props.crossfilter,
      groups: props.groups,
      dataRef: props.dataRef,
      groupBy: props.groupBy,
      clusters: props.clusters,
      pinnedNodeIds: props.pinnedNodeIds,
      searchIndex: props.searchIndex,
    };

    if (dirty) instance.applyHostUpdate(update);
  });

  // Register the instance-wide default unavailable-result
  // callback so <GraphSearch> (and bespoke activation UIs) resolve it without
  // <Graph> in their import graph. Identity churn is fine — registration is a
  // WeakMap write, never a re-render.
  useLayoutEffect(() => {
    setSearchResultUnavailableCallback(instance, props.onSearchResultUnavailable);
  });


  // --- attach/detach: StrictMode's simulated remount detaches (destroying
  // the first engine) and re-attaches (fresh engine + full state replay) ---
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    // Each StrictMode setup (and each real mount) owns exactly one attach
    // result. Its promise may settle after cleanup because engine mounting is
    // asynchronous; a discarded generation must never inspect the newer
    // instance state or call the latest component callbacks.
    let active = true;
    void instance.attach(container).catch((err: unknown) => {
      if (!active) return;
      // A fatal mount fault already reached onError via the 'error' event.
      if (instance.store.getState().status === 'error') return;
      const error = err instanceof Error ? err : new Error(String(err));
      callbacksRef.current.onError?.({ error });
    });
    return () => {
      active = false;
      instance.detach();
    };
  }, [instance]);

  // --- destroy on true unmount only. destroy is irreversible, so the
  // cleanup defers it one microtask; a StrictMode remount re-runs the setup
  // synchronously first and cancels it, leaving detach/attach replay to
  // restore the engine. A real unmount has no re-setup, so destroy fires. ---
  const destroyGateRef = useRef({ pendingDestroy: false });
  useEffect(() => {
    const gate = destroyGateRef.current;
    gate.pendingDestroy = false;
    return () => {
      gate.pendingDestroy = true;
      queueMicrotask(() => {
        if (gate.pendingDestroy) instance.destroy();
      });
    };
  }, [instance]);

  // --- reduced motion: the binding detects the media preference and
  // reports it via instance.setReducedMotion; accessibility.reducedMotion
  // overrides inside the core. Subscribed for live preference changes. ---
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const surface = overlaySurface(instance);
    surface.setReducedMotion?.(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => {
      surface.setReducedMotion?.(e.matches);
    };
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => {
        mq.removeEventListener('change', onChange);
      };
    }
    // Legacy MediaQueryList (Safari < 14).
    if (typeof mq.addListener === 'function') {
      mq.addListener(onChange);
      return () => {
        mq.removeListener(onChange);
      };
    }
    return undefined;
  }, [instance]);

  useImperativeHandle(
    ref,
    (): GraphHandle<N, E> => ({
      fitView: (_opts?: FitViewOptions) => {
        instance.fitView();
      },
      zoomIn: () => {
        instance.zoomIn();
      },
      zoomOut: () => {
        instance.zoomOut();
      },
      setViewport: (v: Partial<ViewportState>, _opts?: { durationMs?: number }) => {
        instance.setViewport(v);
      },
      requestNodeContextMenu: (id: NodeId, screen: readonly [number, number]) => {
        instance.requestNodeContextMenu(id, screen);
      },
      getViewState: (opts?: { includePositions?: false }): GraphViewState =>
        instance.getViewState(opts),
      setViewState: (
        raw: unknown,
        opts?: { ignoreMismatch?: boolean },
      ): Promise<SetViewStateResult> => instance.setViewState(raw, opts),
      exportImage: ((format: 'png' | 'svg', opts?: { maxSvgElements?: number; fallback?: 'raster-hybrid' }) =>
        format === 'png' ? instance.exportImage('png') : instance.exportImage('svg', opts)) as GraphHandle<N, E>['exportImage'],
      exportData: (scope?: 'visible' | 'accepted', opts?: { limit?: number }) =>
        instance.exportData(scope, opts),
      exportDataStream: (scope?: 'visible' | 'accepted') => instance.exportDataStream(scope),
      exportLayout: (opts?: { limit?: number }) => instance.exportLayout(opts),
      exportLayoutStream: () => instance.exportLayoutStream(),
      focusNode: (id: NodeId) => {
        instance.focusNode(id);
      },
      emphasizeNode: (id: NodeId | null) => {
        instance.emphasizeNode(id);
      },
      getPerfSnapshot: () => instance.getPerfSnapshot(),
      setSelection: (ids: readonly NodeId[]) => {
        instance.setSelection(ids);
      },
      findPath: (sourceId: NodeId, targetId: NodeId, options?: PathOptions) =>
        instance.findPath(sourceId, targetId, options),
      clearPath: () => {
        instance.clearPath();
      },
      clearSelection: () => {
        instance.clearSelection();
      },
      selectNeighbors: (id?: NodeId) => {
        instance.selectNeighbors(id);
      },
      selectAll: () => {
        instance.selectAll();
      },
      invertSelection: () => {
        instance.invertSelection();
      },
      selectWithinPolygon: (
        polygon: readonly [number, number][],
        opts?: { additive?: boolean },
      ): readonly NodeId[] => instance.selectWithinPolygon(polygon, opts),
      pinNode: (id: NodeId, xy?: readonly [number, number]) => {
        instance.pinNode(id, xy);
      },
      unpinNode: (id: NodeId) => {
        instance.unpinNode(id);
      },
      clearPins: () => {
        instance.clearPins();
      },
      hideNodes: (ids: readonly NodeId[]) => {
        instance.hideNodes(ids);
      },
      showAll: () => {
        instance.showAll();
      },
      isolateSelection: () => {
        instance.isolateSelection();
      },
      resetIsolation: () => {
        instance.resetIsolation();
      },
      expandNode: (id: NodeId, opts?: { hops?: number }): Promise<ExpandNodeResult> =>
        instance.expandNode(id, opts),
      retractExpansion: (id: NodeId) => {
        instance.retractExpansion(id);
      },
      pinNodes: (ids: readonly NodeId[]) => {
        instance.pinNodes(ids);
      },
      unpinNodes: (ids: readonly NodeId[]) => {
        instance.unpinNodes(ids);
      },
      groupNodes: (spec: GroupSpec) => {
        instance.groupNodes(spec);
      },
      ungroup: (groupId: string) => {
        instance.ungroup(groupId);
      },
      setGroupCollapsed: (groupId: string, collapsed: boolean) => {
        instance.setGroupCollapsed(groupId, collapsed);
      },
      foldNode: (id: NodeId, opts?: { memberIds?: readonly NodeId[] }) => {
        instance.foldNode(id, opts);
      },
      unfoldNode: (id: NodeId) => {
        instance.unfoldNode(id);
      },
      getFold: (id: NodeId): { memberIds: readonly NodeId[] } | null => instance.getFold(id),
      getClusters: (): readonly ResolvedCluster[] => instance.getClusters(),
      selectCluster: (key: string, opts?: { additive?: boolean }) => {
        instance.selectCluster(key, opts);
      },
      beginIngest: (opts: BeginIngestOptions): IngestSession<N, E> => instance.beginIngest(opts),
      removeOverlay: (overlayId: string): { removed: boolean } =>
        instance.removeOverlay(overlayId),
      undo: (): boolean => instance.undo(),
      redo: (): boolean => instance.redo(),
      playTimeline: (key: string, playback?: Partial<TimelinePlayback>) => {
        instance.playTimeline(key, playback);
      },
      pauseTimeline: () => {
        instance.pauseTimeline();
      },
      getCrossfilterSession: (): CrossfilterSession | null => instance.getCrossfilterSession(),
      getScaleInfo: (channel: 'nodeColor' | 'nodeSize'): ScaleChannelInfo<N> | null =>
        instance.getScaleInfo(channel),
      getMetricValue: (metric: MetricName, id: NodeId): number | null =>
        instance.getMetricValue(metric, id),
      getRevisions: () => instance.getRevisions(),
      getDiagnostics: () => instance.getDiagnostics(),
      instance,
    }),
    [instance],
  );

  // --- container ARIA surface ---
  const descriptionId = useId();
  const description = props.accessibility?.description;

  return (
    <div className={props.className} style={{ ...CONTAINER_BASE_STYLE, ...props.style }}>
      <GraphProvider instance={instance}>
        {/* Engine-owned canvas layer: must never contain React children. */}
        <div
          ref={containerRef}
          data-orbit-canvas=""
          style={CANVAS_STYLE}
          role="application"
          aria-label={props.accessibility?.label ?? 'Graph visualization'}
          aria-describedby={description !== undefined ? descriptionId : undefined}
        />
        {description !== undefined ? (
          <div id={descriptionId} style={visuallyHiddenStyle}>
            {description}
          </div>
        ) : null}
        {/* DOM label lane: candidates via React, positions imperative. */}
        {props.labels?.enabled !== false ? (
          <LabelLayer
            labelClassName={props.labelClassName}
            renderNodeLabel={props.renderNodeLabel}
            clusterLabelClassName={props.clusterLabelClassName}
            renderClusterLabel={props.renderClusterLabel}
          />
        ) : null}
        {/* Lasso overlay: above the canvas, pointer-inert unless Shift-drag. */}
        {props.enableLasso !== false ? <Lasso /> : null}
        {/* live region: store-driven, coalesced, visually hidden. */}
        <LiveRegion announcements={props.accessibility?.announcements} />
        {/* legend slot: positioned wrapper re-rendered on scale/theme
            changes; the host returns custom JSX (or composes <GraphLegend>). */}
        {props.renderLegend !== undefined ? (
          <LegendSlot instance={instance} renderLegend={props.renderLegend} />
        ) : null}
        {props.children}
      </GraphProvider>
    </div>
  );
}

/** forwardRef erases generics; restore them with a typed call signature. */
type GraphComponent = <N = Record<string, unknown>, E = Record<string, unknown>>(
  props: GraphProps<N, E> & RefAttributes<GraphHandle<N, E>>,
) => ReactElement;

export const Graph = forwardRef(GraphInner) as GraphComponent;
