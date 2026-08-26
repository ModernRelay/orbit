/**
 * @modernrelay/orbit-core — headless, framework- and engine-agnostic core.
 * No React, WebGL, or concrete engine import; no module-scope DOM access.
 */

// Data model & shared types
export type {
  NodeId,
  PathOptions,
  PathResult,
  PathService,
  EdgeId,
  GraphNode,
  GraphEdge,
  GraphSnapshot,
  GraphSnapshotInput,
  ColumnarGraphSnapshot,
  Column,
  ColumnChange,
  StringColumn,
  DiagnosticSeverity,
  DiagnosticCode,
  GraphDiagnostic,
  Revisions,
  AcceptedEdge,
  AcceptedGraph,
  RenderScene,
  SceneGroups,
  ScenePointRef,
  SceneLinkRef,
  Accessor,
  LayoutKind,
  SimulationConfig,
  SimulationInput,
  SimulationPreset,
  GraphHostUpdate,
  LabelConfig,
  AccessibilityConfig,
  LabelPlacement,
  SubgraphSpec,
  SearchResult,
  SearchUnavailableReason,
  SearchActivation,
  MetricName,
  DomainPolicy,
  Scale,
  MetricColumn,
  GraphPerfSnapshot,
  ScaleLimits,
  DegradeStep,
  ResourceDegradeStep,
  DegradeEvent,
  EngineBufferChannel,
  MetaEdge,
  GraphTheme,
  GroupSpec,
  GroupBySpec,
  ClusterSpec,
  ResolvedCluster,
  ThemeInput,
  FilterMode,
  FilterValue,
  FilterExpr,
  FilterSpec,
  DimensionKind,
  DimensionSpec,
  BrushState,
  HistogramBin,
  CategoryBin,
  DimensionSummary,
  CrossfilterSession,
  TimelinePlayback,
  RequestContext,
  ResolvedGroup,
  RevisionDimension,
  RevisionAwareService,
  ExpansionBatch,
  ExpansionResponse,
  ExpansionService,
  BeginIngestOptions,
  IngestBatch,
  AppendReceipt,
  IngestCommitReceipt,
  IngestSessionState,
  IngestSession,
  ViewportState,
  InstanceStatus,
  SelectionState,
  GraphStoreState,
  GraphListenerControl,
  NodeEventPayload,
  GraphEventMap,
  GraphEventName,
} from './types';
export { DIAGNOSTIC_SAMPLE_CAP, SIMULATION_PRESETS, resolveSimulation } from './types';

// error taxonomy
export type {
  GraphError,
  GraphOperationError,
  ErrorPhase,
  ResourceAdmissionReport,
} from './errors';
export {
  OrbitOperationError,
  isFatalGraphError,
  resourceLimitFatal,
  graphErrorToError,
} from './errors';

// validation
export { validateSnapshot } from './validate';

// stage-3 group rewrite: validation, resolution, rewrite,
// scene-ref helpers, and the aggregate style channels for synthetics.
export {
  groupSceneKey,
  metaEdgeSceneKey,
  metaEdgePublicId,
  groupByDerivedId,
  deriveGroupsByKey,
  sameGroupBySpec,
  validateGroupBySpec,
  validateGroupSpecs,
  resolveManualGroups,
  rewriteGroups,
  collapseParallelEdges,
  sceneGroupsOf,
  scenePointRefAt,
  sceneLinkRefAt,
  sameGroupSpecArrays,
  superNodeSizeFor,
  metaEdgeWidthFor,
  PHYSICAL_DEFAULT_POINT_SIZE,
  PHYSICAL_DEFAULT_LINK_WIDTH,
  SUPER_NODE_MAX_SIZE,
  META_EDGE_MAX_WIDTH,
} from './groups';
export type {
  GroupByDerivation,
  GroupRewrite,
  GroupValidationResult,
  SuperNodeRecord,
  MetaEdgeRecord,
} from './groups';

// stage-4 clusters: pure derivation, deterministic force
// centers, and the settle-time centroid pass.
export {
  deriveClusters,
  generateClusterCenters,
  resolveClusterCenters,
  clusterCentroids,
  DEFAULT_LAYOUT_SEED,
  DEFAULT_CLUSTER_CENTER_RADIUS,
} from './clusters';
export type { ClusterDerivation } from './clusters';

// reconciler
export { Reconciler } from './reconciler';
export type { ReconcileResult } from './reconciler';

// projection (v0.1 subset)
export { projectColors, projectSizes, parseColor } from './projection';

// instance
export { createGraphInstance } from './instance';
export type {
  GraphInstance,
  CreateGraphInstanceOptions,
  LabelSubscriptions,
  GraphServices,
  ExpandNodeResult,
  ExpansionOverlayRecord,
} from './instance';

// Label lane: pure candidate selector + overlay types
export {
  selectLabelCandidates,
  LABEL_MAX_VISIBLE_DEFAULT,
  LABEL_MAX_VISIBLE_CAP,
} from './labels';
export type {
  LabelCandidate,
  LabelCandidateViewport,
  SelectLabelCandidatesArgs,
  LabelCandidateResult,
} from './labels';

// Spatial modules
export { buildAdjacency, neighborsOf } from './adjacency';
export type { Adjacency } from './adjacency';
export { LinkPickIndex, pointSegmentDistanceSquared } from './linkPick';
export type { LinkVisibilityMask, LinkPickGridSnapshot } from './linkPick';

// edge-picking facade
export { EdgePickingFacade, EDGE_PICK_TOLERANCE_PX, medianLinkWidthPx } from './edgePicking';
export type { EdgePickRoute, EdgePickingFacadeOptions } from './edgePicking';

// Revisioned ingestion: acceptance queue + session/overlay helpers
export {
  AcceptanceQueue,
  INGEST_MAX_PENDING_BYTES_DEFAULT,
  INGEST_MAX_FLUSH_LATENCY_MS_DEFAULT,
  INGEST_OVERFLOW_FACTOR,
  BASE_PENDING_KEY,
  estimateBatchBytes,
  newContribution,
  newStagingTallies,
  stageBatch,
  mergeModel,
  mergeDiagnostics,
  sessionCommitDiagnostics,
  baseFromAccepted,
  baseFromContribution,
} from './ingestion';
export type {
  RowTally,
  StagingTallies,
  StampedNode,
  StampedEdge,
  SessionContribution,
  StageResult,
  MergeBase,
  MergeResult,
} from './ingestion';

// scope & services
export { cascadeEdges, resolveScope, buildAcceptedAdjacency } from './scope';
export type { ResolvedScope } from './scope';
export {
  createRequestContext,
  nextRequestId,
  admitServiceResult,
  serviceCacheKey,
  createLocalExpansionService,
  PendingExpansions,
} from './services';
export type {
  RevisionSnapshot,
  CreateRequestContextArgs,
  RequestContextHandle,
  AdmitServiceResultArgs,
  ServiceCacheKeyArgs,
  LocalExpansionBase,
  RegisterExpansionResult,
} from './services';

// history kernel
export { HistoryKernel, HISTORY_LIMIT_DEFAULT } from './history';
export type { HistoryCommand, HistoryDepths, HistoryKernelOptions } from './history';

// filter + mask kernel
export {
  resolveFilterField,
  evaluateFilterExpr,
  validateFilterExpr,
  compileNodeFilter,
  compileEdgeFilter,
  canonicalFilterKey,
} from './filter';
export type { CompiledFilter, FilterErrorAggregate } from './filter';
export { SoftMask, DIM_ALPHA_DEFAULT } from './mask';
export type { MaskSource, MaskDrain } from './mask';

// crossfilter backend
export { TypedColumnCrossfilter, DEFAULT_BIN_COUNT } from './crossfilter';
export type { BrushDelta, CrossfilterStats } from './crossfilter';

// Instance wiring: mask fast path, timeline, history
export {
  BRUSH_HISTORY_COALESCE_MS,
  TIMELINE_TICK_MS_DEFAULT,
  TIMELINE_STEP_DEFAULT,
} from './instance';

// scales & domains
export {
  canonicalScaleKey,
  CATEGORICAL_PALETTE,
  SEQUENTIAL_RANGE_DEFAULT,
  DIVERGING_RANGE_DEFAULT,
  interpolateColor,
  sequentialColor,
  divergingColor,
  sequentialSize,
  computeNumericDomain,
  DomainStore,
  categoricalIndex,
  categoricalRows,
} from './scale';
export type {
  SequentialScale,
  CategoricalScale,
  DivergingScale,
  ResolveDomainArgs,
} from './scale';

// capability policy: mount-time native-vs-fallback
export {
  resolveEnginePolicy,
  assertCapabilityMethodParity,
  normalizeCommitForCapabilities,
} from './capabilityPolicy';
export type {
  EnginePolicy,
  EnginePolicyDegradation,
  RequestedEngineFeatures,
} from './capabilityPolicy';

// Numeric hygiene + metric store
export { coerceNumeric, coerceNumericInto } from './hygiene';
export { MetricStore } from './metrics';
export type { MetricModelInput, AdmitColumnsOptions, AdmitColumnsResult } from './metrics';

// image-atlas pipeline
export {
  ImageAtlasPipeline,
  ATLAS_MAX_CONCURRENT_DEFAULT,
  ATLAS_MAX_RETRIES_DEFAULT,
  ATLAS_MAX_ENTRIES_DEFAULT,
} from './imageAtlas';
export type {
  ImageResolver,
  ImageDecode,
  FetchLike,
  ImageAtlasBatch,
  ImageAtlasPipelineOptions,
} from './imageAtlas';

// Instance styling wiring: theme resolution + legend surface
export { resolveTheme, GRAPH_THEME_DARK, GRAPH_THEME_LIGHT } from './instance';
export type { ScaleChannelInfo, ScaleInfoRow } from './instance';

// search seam: contract + the built-in local indexed service
export {
  createLocalSearchService,
  SEARCH_SCORE_EXACT_ID,
  SEARCH_SCORE_ID_PREFIX,
  SEARCH_SCORE_SUBSTRING,
  SEARCH_SCORE_TOKEN_START_BONUS,
  SEARCH_SCAN_CHUNK,
} from './search';
export type { SearchService, LocalSearchBase, LocalSearchService } from './search';
export { SEARCH_LIMIT_DEFAULT, SEARCH_CACHE_LIMIT } from './instance';

// minimap overview lane: CPU fallback rasterizer + refresh throttle
export {
  OverviewController,
  OVERVIEW_SIZE_DEFAULT,
  OVERVIEW_HOT_INTERVAL_MS,
  OVERVIEW_IDLE_INTERVAL_MS,
} from './overview';
export type {
  OverviewScene,
  OverviewControllerOptions,
  OverviewBounds,
  OverviewRaster,
} from './overview';

// --- view state ---
export { canonicalJson, sameDataRef, validateViewState, VIEW_STATE_VERSION } from './viewState';
export type {
  GraphViewState,
  JsonValue,
  SerializableScale,
  SetViewStateResult,
  ViewBrushState,
  ViewLayoutSpec,
  ViewStateVerdict,
  ViewStyling,
} from './viewState';

// --- SVG export (engine-free module) ---
export { escapeXml, renderSvg, SVG_MAX_ELEMENTS_DEFAULT, SvgBudgetError } from './svgExport';
export type {
  RenderSvgOptions,
  SvgScene,
  SvgSceneEdge,
  SvgSceneLabel,
  SvgSceneNode,
} from './svgExport';

// --- columnar snapshot lane ---
export {
  columnarArrayBuffers,
  detachColumnarBuffers,
  isColumnarSnapshot,
  materializeColumnarSnapshot,
  validateColumnarStructure,
} from './columnar';
export type { ColumnarIssue } from './columnar';

// --- worker lane: columnar-native acceptance and wire protocol ---
export { acceptColumnar } from './columnarValidate';
export type { ColumnarAcceptance } from './columnarValidate';
export { buildAcceptedFromColumnar } from './columnar';
export {
  collectTransfers,
  decodeStringTable,
  encodeStringTable,
  judgeEpoch,
} from './workerProtocol';
export type {
  EncodedStringTable,
  RequestClass,
  WorkerEntity,
  WorkerEnvelope,
} from './workerProtocol';
export type { WorkerFactoryOption, WorkerTransport } from './worker/lane';

// --- serializable field descriptors ---
export {
  descriptorKey,
  evaluateFieldAccessor,
  field,
  isFieldAccessor,
  validateFieldAccessor,
} from './descriptors';
export type {
  DescriptorIssue,
  FieldAccessor,
  SerializableTransform,
  TypedFieldPath,
} from './descriptors';
