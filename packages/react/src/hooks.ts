/**
 * Public hooks — thin useSyncExternalStore selectors over the ambient
 * GraphInstance's vanilla zustand store. All throw a descriptive error when
 * used outside a <Graph>/<GraphProvider> subtree.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';
import type {
  BrushState,
  DimensionSummary,
  EdgeId,
  GraphDiagnostic,
  GraphInstance,
  GraphStoreState,
  GraphTheme,
  InstanceStatus,
  NodeId,
  SearchResult,
  SearchUnavailableReason,
  SelectionState,
  SubgraphSpec,
  ViewportState,
} from '@modernrelay/orbit-core';
import { useAmbientGraphInstance } from './GraphProvider';
import type { AnyGraphInstance } from './GraphProvider';
import { useCrossfilterDimension, useSessionSetBrush } from './components/_shared/crossfilter';

interface SelectorCache<T> {
  hasValue: boolean;
  value: T;
}

/**
 * Subscribe to a projection of the store. The snapshot is memoized with
 * Object.is so selectors that recompute to the same value keep a stable
 * reference (required by useSyncExternalStore to avoid render loops).
 */
function useStoreSelector<T>(instance: AnyGraphInstance, selector: (s: GraphStoreState) => T): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<SelectorCache<T>>({ hasValue: false, value: undefined as T });

  const subscribe = useCallback(
    (onStoreChange: () => void) => instance.store.subscribe(onStoreChange),
    [instance],
  );
  const getSnapshot = useCallback(() => {
    const next = selectorRef.current(instance.store.getState());
    const cache = cacheRef.current;
    if (cache.hasValue && Object.is(cache.value, next)) return cache.value;
    cache.hasValue = true;
    cache.value = next;
    return next;
  }, [instance]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const selectSelection = (s: GraphStoreState): SelectionState => s.selection;
// Read `simulationRunning` tolerantly so
// the hook is correct both before and after the core field lands.
const selectSimulationRunning = (s: GraphStoreState): boolean =>
  (s as GraphStoreState & { simulationRunning?: boolean }).simulationRunning ?? false;
const selectHover = (s: GraphStoreState): NodeId | null => s.hover.nodeId;
const selectEdgeHover = (s: GraphStoreState): EdgeId | null => s.hover.edgeId;
const selectPins = (s: GraphStoreState): ReadonlyMap<NodeId, readonly [number, number]> => s.pins;
const selectViewport = (s: GraphStoreState): ViewportState | null => s.viewport;
const selectStatus = (s: GraphStoreState): InstanceStatus => s.status;
const selectDiagnostics = (s: GraphStoreState): readonly GraphDiagnostic[] => s.diagnostics;
const selectScope = (s: GraphStoreState): SubgraphSpec | null => s.scope;
const selectPendingExpansions = (s: GraphStoreState): ReadonlySet<NodeId> => s.pendingExpansions;
const selectOverlayIds = (s: GraphStoreState): readonly string[] => s.overlayIds;
const selectVisible = (s: GraphStoreState): { nodes: number; edges: number } => s.visible;
const selectTimeline = (s: GraphStoreState): { playingKey: string | null } => s.timeline;
const selectHistory = (s: GraphStoreState): { undoDepth: number; redoDepth: number } => s.history;
// Resolved theme tokens + the scale-info invalidation signal.
const selectTheme = (s: GraphStoreState): GraphTheme => s.theme;
const selectScaleVersion = (s: GraphStoreState): string =>
  `${s.revisions.model}:${s.revisions.scope}:${s.revisions.render}`;

export function useGraphInstance<
  N = Record<string, unknown>,
  E = Record<string, unknown>,
>(): GraphInstance<N, E> {
  return useAmbientGraphInstance('useGraphInstance') as GraphInstance<N, E>;
}

/** The full namespaced SelectionState; was `readonly NodeId[]` before
 * v0.3 — read `.nodeIds` for the node namespace. */
export function useGraphSelection(): SelectionState {
  return useStoreSelector(useAmbientGraphInstance('useGraphSelection'), selectSelection);
}

export function useGraphHover(): NodeId | null {
  return useStoreSelector(useAmbientGraphInstance('useGraphHover'), selectHover);
}

export function useGraphEdgeHover(): EdgeId | null {
  return useStoreSelector(useAmbientGraphInstance('useGraphEdgeHover'), selectEdgeHover);
}

/** The pin slice: node id → pinned space position. */
export function useGraphPins(): ReadonlyMap<NodeId, readonly [number, number]> {
  return useStoreSelector(useAmbientGraphInstance('useGraphPins'), selectPins);
}

export function useGraphViewport(): ViewportState | null {
  return useStoreSelector(useAmbientGraphInstance('useGraphViewport'), selectViewport);
}

export function useGraphStatus(): InstanceStatus {
  return useStoreSelector(useAmbientGraphInstance('useGraphStatus'), selectStatus);
}

export function useGraphDiagnostics(): readonly GraphDiagnostic[] {
  return useStoreSelector(useAmbientGraphInstance('useGraphDiagnostics'), selectDiagnostics);
}

/** Whether the engine force simulation is currently running (drives the
 * toolbar pause/resume affordance). */
export function useGraphSimulationRunning(): boolean {
  return useStoreSelector(
    useAmbientGraphInstance('useGraphSimulationRunning'),
    selectSimulationRunning,
  );
}

/** The active hard scope (`subgraph`); null while the full accepted
 * model is in view. Uncontrolled-only in v0.5: the `subgraph` prop and
 * isolateSelection/resetIsolation write this same instance-owned state. */
export function useGraphScope(): SubgraphSpec | null {
  return useStoreSelector(useAmbientGraphInstance('useGraphScope'), selectScope);
}

/** Node ids with an expansion in flight (loading affordance — drive
 * spinners/ghost skeletons from this set). */
export function useGraphPendingExpansions(): ReadonlySet<NodeId> {
  return useStoreSelector(
    useAmbientGraphInstance('useGraphPendingExpansions'),
    selectPendingExpansions,
  );
}

/** Committed overlay ids for the current dataset. */
export function useGraphOverlays(): readonly string[] {
  return useStoreSelector(useAmbientGraphInstance('useGraphOverlays'), selectOverlayIds);
}

/** soft-mask visibility counts: scene entities with zero hide-failures
 * (equals the accepted counts when nothing masks). */
export function useGraphVisible(): { nodes: number; edges: number } {
  return useStoreSelector(useAmbientGraphInstance('useGraphVisible'), selectVisible);
}

/** timeline playback state — at most one playing dimension key. */
export function useGraphTimeline(): { playingKey: string | null } {
  return useStoreSelector(useAmbientGraphInstance('useGraphTimeline'), selectTimeline);
}

/** History kernel depths for the full undo/redo walk. */
export function useGraphHistory(): { undoDepth: number; redoDepth: number } {
  return useStoreSelector(useAmbientGraphInstance('useGraphHistory'), selectHistory);
}

/** Resolved theme tokens: the merged GraphTheme currently driving
 * engine config, projection fallbacks, and mask dim alpha (`store.theme`).
 * Style legend chrome, tooltips, and other host overlays from these tokens. */
export function useGraphTheme(): GraphTheme {
  return useStoreSelector(useAmbientGraphInstance('useGraphTheme'), selectTheme);
}

/**
 * INTERNAL: subscription surface for `instance.getScaleInfo` readers
 * (<GraphLegend>, the `renderLegend` slot). `version` changes whenever a
 * store publication could change scale info (model/scope/render revisions);
 * `theme` is the stable-by-value theme reference. Consumers recompute
 * getScaleInfo in a memo keyed on both. Not re-exported from the package
 * root — subject to change without notice.
 */
export function useScaleInfoSubscription(instance: AnyGraphInstance): {
  version: string;
  theme: GraphTheme;
} {
  const version = useStoreSelector(instance, selectScaleVersion);
  const theme = useStoreSelector(instance, selectTheme);
  return { version, theme };
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const selectSearch = (
  s: GraphStoreState,
): { query: string; results: readonly SearchResult[] } | null => s.search;

/** The last completed search (`store.search`): `{query, results}` after
 * a successful `instance.search`, null after `clearSearch` / a dataset
 * swap. Drives `<GraphSearch>`'s result list and the navigator's
 * search-results section. */
export function useGraphSearch(): { query: string; results: readonly SearchResult[] } | null {
  return useStoreSelector(useAmbientGraphInstance('useGraphSearch'), selectSearch);
}

/** `onSearchResultUnavailable` callback type: fired when an activated result
 * cannot be focused; `reason` is
 * 'not-loaded' | 'out-of-scope' | 'filtered'. The host reacts explicitly;
 * Orbit never changes scope/filters behind the user's back. */
export type SearchResultUnavailableCallback = (
  result: SearchResult,
  reason: SearchUnavailableReason,
) => void;

/**
 * INTERNAL: the `<Graph onSearchResultUnavailable>` → `<GraphSearch>`
 * default-callback channel. `<Graph>` registers its prop here per instance;
 * `<GraphSearch>` (and other activation surfaces) fall back to it when they
 * have no local `onResultUnavailable` prop. A WeakMap keyed by the instance
 * not a React context — so packaged component entries can resolve it without
 * `<Graph>` in their import graph (treeshake sentinels stay clean) and
 * registration never re-renders subscribers. Not re-exported from the package
 * root — subject to change without notice.
 */
const searchUnavailableCallbacks = new WeakMap<AnyGraphInstance, SearchResultUnavailableCallback>();

/** INTERNAL: register/clear the instance's default unavailable-result
 * callback (undefined clears). See {@link searchUnavailableCallbacks}. */
export function setSearchResultUnavailableCallback(
  instance: AnyGraphInstance,
  cb: SearchResultUnavailableCallback | undefined,
): void {
  if (cb === undefined) searchUnavailableCallbacks.delete(instance);
  else searchUnavailableCallbacks.set(instance, cb);
}

/** INTERNAL: resolve the instance's default unavailable-result callback. */
export function getSearchResultUnavailableCallback(
  instance: AnyGraphInstance,
): SearchResultUnavailableCallback | undefined {
  return searchUnavailableCallbacks.get(instance);
}

/** One crossfilter dimension: live summary + brush + a setter. */
export interface GraphCrossfilterDimension {
  /** Null until the `crossfilter` prop builds the dimension over data. */
  summary: DimensionSummary | null;
  brush: BrushState;
  setBrush: (brush: BrushState) => void;
}

/**
 * Subscribe to one crossfilter dimension by key. Re-reads
 * summarize/getBrush on session notify; resolves the session lazily (null
 * summary until the `crossfilter` prop builds dimensions over an accepted
 * base — the store publishes when they do).
 */
export function useGraphCrossfilter(key: string): GraphCrossfilterDimension {
  const instance = useAmbientGraphInstance('useGraphCrossfilter');
  const snapshot = useCrossfilterDimension(instance, key);
  const setBrush = useSessionSetBrush(instance, key);
  return { summary: snapshot.summary, brush: snapshot.brush, setBrush };
}
