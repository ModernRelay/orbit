/**
 * @modernrelay/orbit-react — declarative React binding for orbit.
 * Re-exports nothing from core; consumers import @modernrelay/orbit-core
 * directly for data-model types.
 */

export { Graph } from './Graph';
export type { GraphProps, GraphHandle } from './Graph';

export { GraphProvider } from './GraphProvider';
export type { GraphProviderProps } from './GraphProvider';

// Overlays: rendered by <Graph> internally; exported so hosts composing
// <GraphProvider> directly can reuse them.
export { LabelLayer } from './LabelLayer';
export type { LabelLayerProps } from './LabelLayer';
export { LiveRegion } from './LiveRegion';
export type { LiveRegionProps } from './LiveRegion';

// Component foundation (packaged components live under ./components/*).
export { useResolvedInstance } from './components/shared';
export { DEFAULT_CORNER_OFFSET } from './components/shared';
export type { GraphCorner, GraphLabelsSurface, GraphOverlaySurface } from './components/shared';

export {
  useGraphInstance,
  useGraphSelection,
  useGraphHover,
  useGraphEdgeHover,
  useGraphPins,
  useGraphViewport,
  useGraphStatus,
  useGraphDiagnostics,
  useGraphSimulationRunning,
  // Hard scope + expansion, overlays.
  useGraphScope,
  useGraphPendingExpansions,
  useGraphOverlays,
  // Visibility, crossfilter/timeline, history.
  useGraphVisible,
  useGraphTimeline,
  useGraphHistory,
  useGraphCrossfilter,
} from './hooks';
export type { GraphCrossfilterDimension } from './hooks';

// Styling: theme hook + the renderLegend info payload. The
// built-in <GraphLegend> ships as its own entry point:
// '@modernrelay/orbit-react/components/Legend'.
export { useGraphTheme } from './hooks';
export type { GraphLegendRenderInfo } from './Graph';

// Search & exploration: the store.search hook + the
// callback type. The packaged components ship as their own entry
// points: '@modernrelay/orbit-react/components/{Search,Minimap,Tooltip,Inspector}'.
export { useGraphSearch } from './hooks';
export type { SearchResultUnavailableCallback } from './hooks';
