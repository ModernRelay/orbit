/**
 * orbit-core public data model.
 *
 * The public model is object-based, id-keyed, and generic over caller attribute
 * types. A `GraphSnapshot` is the declarative source of truth; the core keeps a
 * derived index model and drives the engine imperatively.
 */

import type { GraphError } from './errors';

export type NodeId = string;
export type EdgeId = string;

/** Plain JSON value — the shape `dataRef` and other verbatim host payloads
 * must fit. Values are stored, round-tripped, compared canonically, and NEVER
 * interpreted. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface GraphNode<N = Record<string, unknown>> {
  id: NodeId;
  attrs?: N;
  /** Optional fixed/persisted position honored by the fixed layout. */
  x?: number;
  y?: number;
}

export interface GraphEdge<E = Record<string, unknown>> {
  /**
   * Optional stable id. When absent, the core synthesizes a deterministic id
   * `${escapedSource}→${escapedTarget}#${k}` where `\\`, `→`, and `#` are
   * backslash-escaped inside endpoint ids, and k disambiguates parallel edges
   * in first-occurrence order. Simple endpoint ids retain the familiar
   * `${source}→${target}#${k}` form.
   */
  id?: EdgeId;
  source: NodeId;
  target: NodeId;
  attrs?: E;
}

/** Versioned snapshot — the declarative source of truth. */
export interface GraphSnapshot<N = Record<string, unknown>, E = Record<string, unknown>> {
  /** Identity of the dataset; changing it clears all per-dataset state. */
  datasetKey: string;
  /** Caller-owned revision; same {datasetKey, sourceRevision} replays are idempotent. */
  sourceRevision: number | string;
  nodes: readonly GraphNode<N>[];
  edges: readonly GraphEdge<E>[];
}

// ---------------------------------------------------------------------------
// Diagnostics. Batched: one diagnostic per code per validation
// pass with a count and capped samples — O(categories), never O(bad rows).
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export type DiagnosticCode =
  | 'duplicate-node-id'
  | 'duplicate-edge-id'
  | 'dangling-edge-endpoint'
  | 'invalid-node'
  | 'invalid-edge'
  | 'self-loop-retained'
  /** A filter predicate threw or an expr referenced bad data; aggregated. */
  | 'filter-error'
  /** Async metric column rejected due to misalignment, duplicates, or unknown ids. */
  | 'metric-column-error'
  /** A channel reprojected repeatedly with identical outputs. */
  | 'accessor-churn'
  /** Image atlas resolve/decoding failures, cadence-batched. */
  | 'image-resolve-failed'
  | 'source-revision-reused'
  /** columnar lane: invalid structure (length mismatch, detached
   * buffer, out-of-range dictionary or endpoint index) — the WHOLE snapshot
   * is rejected before derivation; the previous accepted scene stays. */
  | 'invalid-columnar-snapshot'
  /** The worker lane could not boot — columnar acceptance runs
   * on the main lane instead (info under execution:'auto', error under
   * 'worker'). One-shot per instance. */
  | 'worker-unavailable'
  /** A host config lane was rejected at the boundary — e.g. a
   * groups array whose containment is cyclic or multiply parented); the
   * previous config stays live. */
  | 'config-error'
  /** a setViewState payload failed structural validation or carries
   * a version newer than this library; NOTHING was applied. */
  | 'invalid-view-state'
  | 'engine-error'
  | 'accessor-error'
  /** A user event listener threw; isolated so the listener chain continues. */
  | 'listener-error'
  /** showLabelsFor exceeded tracked-label capacity; omissions counted. */
  | 'label-overload'
  /** A same-id row from an earlier overlay won in admission order. */
  | 'overlay-node-shadowed'
  /** A service call was aborted/discarded before admission. */
  | 'service-aborted'
  /** A service call failed. */
  | 'service-error'
  | 'context-lost'
  | 'operation-rejected'
  /** Adapter-defined codes are namespaced. */
  | `engine:${string}`;

export const DIAGNOSTIC_SAMPLE_CAP = 10;

export interface GraphDiagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  /** Total occurrences in the pass this diagnostic summarizes. */
  count: number;
  /** At most DIAGNOSTIC_SAMPLE_CAP offending ids. */
  sampleIds: readonly string[];
  message: string;
}

// ---------------------------------------------------------------------------
// Revisions.
// ---------------------------------------------------------------------------

export interface Revisions {
  /** Last accepted caller sourceRevision (null before first accept). */
  source: number | string | null;
  /** Monotonic counter advanced on every accepted model change. */
  model: number;
  /** Filtering/subgraph scope revision. Advances with every accepted
   * model change AND on every hard-scope (subgraph) change; a SCOPE-ONLY
   * change advances `scope` and `render` but NOT `model` — the first genuine
   * scope/model split. */
  scope: number;
  /** Monotonic counter advanced on every desired-render publication. */
  render: number;
  /** Highest render revision the engine has visibly applied (null pre-mount). */
  appliedRender: number | null;
}

// ---------------------------------------------------------------------------
// Accepted graph — output of validation, input to the reconciler.
// ---------------------------------------------------------------------------

export interface AcceptedEdge<E = Record<string, unknown>> extends GraphEdge<E> {
  id: EdgeId;
}

export interface AcceptedGraph<N = Record<string, unknown>, E = Record<string, unknown>> {
  datasetKey: string;
  sourceRevision: number | string;
  /** Deduplicated (first-wins), in accepted-base order. */
  nodes: readonly GraphNode<N>[];
  /** Dangling endpoints dropped; ids present (synthesized when needed). */
  edges: readonly AcceptedEdge<E>[];
  /** id → position in `nodes` (accepted-base order). */
  nodeIndex: ReadonlyMap<NodeId, number>;
  diagnostics: readonly GraphDiagnostic[];
}

// ---------------------------------------------------------------------------
// RenderScene — compact typed scene the reconciler publishes. Public
// payloads never expose engine indices; this type is internal-ish but
// exported for FakeEngine-based testing.
// ---------------------------------------------------------------------------

export interface RenderScene {
  count: number;
  linkCount: number;
  /** engine index → node id. */
  idByIndex: readonly NodeId[];
  /** node id → engine index. */
  indexById: ReadonlyMap<NodeId, number>;
  /** engine link index → edge id. */
  edgeIdByIndex: readonly EdgeId[];
  /**
   * 2*count floats. NaN pairs mean "no known position" — the engine seeds
   * them; known positions come from the position cache.
   */
  positions: Float32Array;
  /** 2*linkCount uint32 endpoint indices into the point set. */
  links: Uint32Array;
  /**
   * Synthetic suffix. Present iff the scene was rewritten
   * by collapsed groups: point slots >= physicalPointCount are super-nodes
   * and link slots >= physicalLinkCount are meta-edges (synthetics are always
   * a contiguous suffix). For those slots, idByIndex/edgeIdByIndex hold
   * INTERNAL scene keys that never escape public payloads — consumers
   * resolve slots through the discriminated ScenePointRef/SceneLinkRef
   * helpers instead.
   */
  groups?: SceneGroups;
}

/** compact synthetic-suffix descriptor attached to a rewritten scene. */
export interface SceneGroups {
  physicalPointCount: number;
  physicalLinkCount: number;
  /** Aligned to point slots physicalPointCount..count-1. */
  superNodes: readonly ResolvedGroup[];
  /** Aligned to link slots physicalLinkCount..linkCount-1. */
  metaEdges: readonly MetaEdge[];
  /**
   * node folds: representatives that are REAL nodes, so they carry no
   * synthetic slot and never appear in `superNodes`. A folded anchor keeps
   * its physical row (and its own caller-driven styling) — this
   * list only reports how many descendants it currently stands for, for
   * badge rendering. Empty when nothing is folded.
   */
  folds: readonly SceneFold[];
}

/** One drawn fold anchor and the descendant count it currently hides. */
export interface SceneFold {
  anchorId: NodeId;
  hiddenCount: number;
}

/** discriminated point ref: a physical node id or a resolved group
 * public namespaces only, never internal scene keys. */
export type ScenePointRef =
  | { kind: 'node'; id: NodeId }
  | { kind: 'group'; group: ResolvedGroup };

/** discriminated link ref: a physical edge id or a meta-edge record. */
export type SceneLinkRef =
  | { kind: 'edge'; id: EdgeId }
  | { kind: 'meta-edge'; metaEdge: MetaEdge };

// ---------------------------------------------------------------------------
// Styling accessors: constant or function of the typed node.
// Descriptor (FieldAccessor) forms arrive in later slices.
// ---------------------------------------------------------------------------

export type Accessor<T, V> = V | ((item: T) => V);

export type LayoutKind = 'force' | 'fixed';

/**
 * force tunables under stable, engine-neutral names — orbit maps them onto
 * the active engine's parameters through atomic config-only commits, so
 * a value here never resets positions or restarts the layout.
 *
 * Every field is optional and OMISSION MEANS "leave the engine's default
 * alone" — it is never written as an explicit value. The defaults quoted below
 * are cosmos 3.3.0's (`defaultConfigValues`), listed so a host knows what it is
 * overriding; an engine without a given force ignores that field.
 *
 * NOT here: `spaceSize` is a construction option on the adapter, not a runtime
 * tunable (cosmos documents that large values crash some devices, and the
 * seeding ring is derived from it).
 */
export interface SimulationConfig {
  /** Pull toward the layout centre. Default 0.25. */
  gravity?: number;
  /** How hard every node pushes every other away — the spread. Default 1. */
  repulsion?: number;
  /** Velocity retained per tick: lower settles sooner, higher keeps drifting.
   * Default 0.85. */
  friction?: number;
  /** Rest length of an edge spring. Default 10. */
  linkDistance?: number;
  /** Edge spring stiffness. Default 1. */
  linkSpring?: number;
  /**
   * Cool-down coefficient — how fast the run loses energy and comes to rest.
   * SMALLER cools slower (a longer, more thorough settle); larger snaps to a
   * stop. Default 5000.
   */
  decay?: number;
  /**
   * Overlap resolution: above 0, nodes push apart when their circles
   * intersect. Default 0 (OFF) — the reason dense clusters render as solid
   * blobs until you turn it on.
   */
  collision?: number;
  /** Collision circle radius. Default: derived from the point size. */
  collisionRadius?: number;
  /** Extra spacing added around each collision circle. Default 0. */
  collisionPadding?: number;
  /**
   * Barnes-Hut opening angle θ for the many-body approximation: larger is
   * coarser and faster, smaller is more exact and slower. Default 1.15.
   * @deprecated Ignored on cosmos >= 3.4 (grid-based repulsion replaced
   * Barnes-Hut; the engine emits `engine:repulsion-theta-deprecated` once).
   * Retained for engines with a Barnes-Hut many-body force.
   */
  repulsionTheta?: number;
  /** Attraction toward the scene's centre of mass. Default 0 (OFF). */
  center?: number;
  /** How strongly nodes shy away from the cursor. Default 2. */
  repulsionFromMouse?: number;
}

/**
 * Named simulation presets, measured on the reference protocol (800-node
 * clustered graph, max node displacement sampled at 500ms): the times below
 * are seconds until visible stillness (< 1.5 space units/s sustained).
 *
 * - `calm` — damped and settles in ~5s; the DEFAULT when no `simulation`
 *   value is given. The engine's own defaults (`lively`) keep visible motion
 *   alive for tens of seconds, which reads as jitter on first load.
 * - `spread` — airier inter-cluster spacing, ~7s to stillness.
 * - `tight` — compact clusters, ~6s to stillness.
 * - `lively` — the engine's own defaults: ambient continuous motion.
 */
export type SimulationPreset = 'calm' | 'spread' | 'tight' | 'lively';

/** The `simulation` input surface: a full config or a named preset. */
export type SimulationInput = SimulationConfig | SimulationPreset;

export const SIMULATION_PRESETS: Readonly<Record<SimulationPreset, Readonly<SimulationConfig>>> =
  Object.freeze({
    calm: Object.freeze({ repulsion: 1.4, gravity: 0.15, friction: 0.6, decay: 1000 }),
    spread: Object.freeze({ repulsion: 2, gravity: 0.1, friction: 0.6, decay: 1400 }),
    tight: Object.freeze({ repulsion: 0.8, gravity: 0.3, friction: 0.55, decay: 1200 }),
    lively: Object.freeze({ repulsion: 1, gravity: 0.25, friction: 0.85, decay: 5000 }),
  });

/** Resolve a `simulation` input to a concrete config. Omitted input resolves
 * to the `calm` preset — the measured-good default. Preset strings resolve to
 * frozen singletons, so identity comparison stays meaningful. */
export function resolveSimulation(input: SimulationInput | undefined): SimulationConfig {
  if (input === undefined) return SIMULATION_PRESETS.calm;
  if (typeof input === 'string') return SIMULATION_PRESETS[input] ?? SIMULATION_PRESETS.calm;
  return input;
}

// ---------------------------------------------------------------------------
// Host update — the atomic boundary: one call carries data + config +
// controlled state and publishes exactly one store revision and at most one
// engine commit.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// columnar snapshots — the supported large-data lane:
// transferable typed columns and PRE-INDEXED endpoints (source/target are
// node indices, not ids). Spec-verbatim shapes.
// ---------------------------------------------------------------------------

export type ColumnChange = {
  /** Unchanged revision permits index/cache reuse (assertion, not a hint). */
  revision?: string | number;
  /** Half-open, sorted, disjoint — MUST exhaust every changed row. */
  dirtyRanges?: readonly { start: number; end: number }[];
};

/** Dictionary-encoded strings. `nulls`: one byte per row, nonzero = null. */
export type StringColumn = ColumnChange & {
  kind: 'string';
  dictionary: readonly string[];
  codes: Uint32Array;
  nulls?: Uint8Array;
};

export type Column =
  | (ColumnChange & { kind: 'f64'; data: Float64Array; nulls?: Uint8Array })
  | (ColumnChange & { kind: 'i32'; data: Int32Array; nulls?: Uint8Array })
  | (ColumnChange & { kind: 'u32'; data: Uint32Array; nulls?: Uint8Array })
  | (ColumnChange & { kind: 'bool'; data: Uint8Array; nulls?: Uint8Array })
  | StringColumn;

/** Supported large-data lane: transferable columns and pre-indexed endpoints. */
export interface ColumnarGraphSnapshot<N = Record<string, unknown>, E = Record<string, unknown>> {
  kind: 'columnar';
  datasetKey: string;
  sourceRevision: string | number;
  /** Default 'borrowed'. 'transfer' detaches the supplied ArrayBuffers ONLY
   * after structural validation AND admission succeed; the
   * snapshot object is then single-use. */
  bufferOwnership?: 'borrowed' | 'transfer';
  nodes: {
    ids: StringColumn;
    columns: Readonly<Record<string, Column>>;
    length: number;
    /** Compile-time witness only; never materialized. */
    readonly __attrs?: N;
  };
  edges: {
    ids: StringColumn;
    source: Uint32Array;
    target: Uint32Array;
    endpointRevision?: string | number;
    endpointDirtyRanges?: readonly { start: number; end: number }[];
    columns: Readonly<Record<string, Column>>;
    length: number;
    readonly __attrs?: E;
  };
}

export type GraphSnapshotInput<N = Record<string, unknown>, E = Record<string, unknown>> =
  | GraphSnapshot<N, E>
  | ColumnarGraphSnapshot<N, E>;

export interface GraphHostUpdate<N = Record<string, unknown>, E = Record<string, unknown>> {
  data?: GraphSnapshotInput<N, E>;
  nodeColor?: Accessor<GraphNode<N>, string> | Scale<string, N>;
  nodeSize?: Accessor<GraphNode<N>, number> | Scale<number, N>;
  linkColor?: Accessor<AcceptedEdge<E>, string>;
  linkWidth?: Accessor<AcceptedEdge<E>, number>;
  /** async metric columns, joined once with revision-gated admission. */
  metrics?: readonly MetricColumn[];
  /**
   * image sprites: synchronous, string-valued ref accessor (URL/blob
   * ref/cache key — opaque to orbit). Refs feed the image-atlas pipeline when
   * the engine declares `pointImages`; otherwise refs are retained and the
   * placeholder shape renders.
   */
  /** image refs; `null` CLEARS the accessor and evicts the atlas back to
   * placeholders (D2 explicit reset — omission stays "no change"). */
  nodeImage?: ((node: GraphNode<N>) => string | null) | null;
  /** instanced arrowheads (capability-gated; inert when unsupported). */
  edgeArrows?: boolean;
  /** durable source coordinate for view states — stored VERBATIM,
   * never interpreted; serialized by getViewState and canonically compared
   * on setViewState. Stash-only lane: no publish, no commit. Omission means
   * no change (there is no clear form in v1 — set `{}` for emptiness). */
  dataRef?: JsonValue;
  /** runtime toggles — atomic config-only commits, no reprojection. */
  showLinks?: boolean;
  /** emphasis-ring toggle (default TRUE — the ring predates its name: it
   * has followed hover since v0.1). False clears the engine ring once and
   * suppresses every driver (hover, focusNode, emphasizeNode). */
  emphasisRing?: boolean;
  layout?: LayoutKind;
  simulation?: SimulationInput;
  /** Controlled selection (uncontrolled when never provided; subset). */
  selection?: readonly NodeId[];
  theme?: ThemeInput;
  /** DOM label lane configuration; strategy 'dom' only in v0.4. */
  labels?: LabelConfig<N>;
  /** accessibility runtime options. */
  accessibility?: AccessibilityConfig<N>;
  /** hard scope: feed ONLY the resolved subset through the reconciler;
   * null restores full scope. Positions come from the cache; reflow default
   * true restarts the layout around the remainder. */
  subgraph?: SubgraphSpec | null;
  /** soft filter: mask (hide/dim) with ZERO relayout; null clears. */
  filter?: FilterSpec<N, E> | null;
  /** crossfilter dimensions (declarative; brushes live on the session). */
  crossfilter?: readonly DimensionSpec<N>[];
  /** manual groups; null clears (D2). Config-error with groupBy. */
  groups?: readonly GroupSpec[] | null;
  /** derived grouping; null clears (D2). Config-error with groups. */
  groupBy?: GroupBySpec<N> | null;
  /** stage-4 non-collapsing layout clusters; null clears (D2). Clusters
   * COEXIST with groups — they preserve every node and edge. */
  clusters?: ClusterSpec<N> | null;
  /** persistent pins (independent of transient drag pinning); null
   * clears (D2). Departed ids prune through ownership. */
  pinnedNodeIds?: readonly NodeId[] | null;
  /** parallel-edge grouping toggle: same-pair edges collapse into one
   * count-weighted meta-edge. */
  parallelEdgeGrouping?: boolean;
  // NOTE (D7): `searchIndex` is a CONSTRUCTION option (spec host
  // construction options — read once; changing it requires a keyed remount).
  // It is deliberately NOT a host-update lane; a runtime attempt is ignored
  // with a one-shot 'operation-rejected' warning diagnostic.
}

// ---------------------------------------------------------------------------
// Scales and metrics. Scales are plain descriptors and
// compare by CANONICAL STRUCTURAL VALUE — equal inline literals never
// reproject. The categorical `by` accepts a field name (addressing
// attrs[field], 'id' for the entity id — the FilterExpr convention) or a
// function compared by reference; FieldAccessor descriptors arrive with the
// columnar lane.
// ---------------------------------------------------------------------------

/** Built-in synchronous metrics plus caller-supplied async column names. */
export type MetricName = 'degree' | 'inDegree' | 'outDegree' | (string & {});

export interface DomainPolicy {
  /** Domain population. Default 'dataset' (frozen per dataset revision
   * masking/isolation never change what a color means). */
  scope?: 'dataset' | 'hard-scope' | 'visible';
  /** Streaming behavior. Default 'freeze-per-revision'; 'expand' permits
   * monotonic growth as batches arrive. */
  streaming?: 'freeze-per-revision' | 'expand';
}

export type Scale<T, N = Record<string, unknown>> =
  | {
      kind: 'sequential';
      metric: MetricName;
      range: readonly [T, T];
      domain?: readonly [number, number] | DomainPolicy;
    }
  | {
      kind: 'categorical';
      by: string | ((node: GraphNode<N>) => string | null);
      palette?: readonly T[];
      /** Fixed category order → stable colors and stable legend rows,
       * including empty categories; out-of-domain values hash stably. */
      domain?: readonly string[];
      domainPolicy?: DomainPolicy;
    }
  | {
      kind: 'diverging';
      metric: MetricName;
      mid: number;
      range: readonly [T, T, T];
    };

/** Async metric column joined against the accepted model. */
export interface MetricColumn {
  metric: string;
  /** 'ids' joins by the ids array; 'index' is accepted-base positional. */
  align: 'ids' | 'index';
  values: readonly (number | null)[];
  ids?: readonly NodeId[];
  /**
   * Issue-time stamp: the `getRevisions().model` value CURRENT WHEN
   * THE UPDATE CARRYING THIS COLUMN WAS BUILT. Capture it before starting an
   * async computation and deliver it with the result — admission rejects the
   * column (info diagnostic) when the model has moved since, so stale async
   * work can never join a newer roster. Columns delivered atomically with
   * their matching `data` in one update stamp the revision current at build
   * time (the pre-update revision): the transaction is atomic, so that stamp
   * uniquely names the roster the columns were derived from.
   */
  forModelRevision: number;
}

// ---------------------------------------------------------------------------
// theme tokens. The `theme` prop accepts a full GraphTheme, a partial over
// a named base, or the v0.1 `{background}` shorthand (kept compatible).
// ---------------------------------------------------------------------------

export interface GraphTheme {
  background: string;
  nodeDefault: string;
  edgeDefault: string;
  labelFg: string;
  accent: string;
  mutedAlpha: number;
  /** emphasis-ring color (pointer hover, `focusNode`, `emphasizeNode`).
   * Distinct from `accent` on purpose: accent is the SELECTION highlight, and
   * an emphasized node must not read as selected. */
  emphasisRing: string;
}

export type ThemeInput =
  | (Partial<GraphTheme> & { base?: 'light' | 'dark' })
  | GraphTheme;

// ---------------------------------------------------------------------------
// soft filtering — mask, never reflow. `field` addresses `attrs[field]`
// ('id' addresses the entity id). Serializable exprs compare by canonical
// structural value (identity churn with equal structure never re-evaluates);
// function predicates compare by reference and re-evaluate O(n) on change.
// ---------------------------------------------------------------------------

export type FilterMode = 'hide' | 'dim';

export type FilterValue = string | number | boolean | null;

export type FilterExpr =
  | { op: 'eq' | 'neq'; field: string; value: FilterValue }
  | { op: 'in'; field: string; values: readonly FilterValue[] }
  | {
      op: 'range';
      field: string;
      min?: number;
      max?: number;
      /** Default true. */
      includeMin?: boolean;
      /** Default true. */
      includeMax?: boolean;
    }
  | { op: 'is-null'; field: string }
  | { op: 'not'; expr: FilterExpr }
  | { op: 'and' | 'or'; exprs: readonly FilterExpr[] };

export interface FilterSpec<N = Record<string, unknown>, E = Record<string, unknown>> {
  nodes?: FilterExpr | ((node: GraphNode<N>) => boolean);
  edges?: FilterExpr | ((edge: AcceptedEdge<E>) => boolean);
  /** 'hide' removes from view (alpha 0 + picking); 'dim' mutes. Default 'hide'. */
  mode?: FilterMode;
}

// ---------------------------------------------------------------------------
// crossfilter (v0.7 subset: node dimensions, typed-column backend).
// ---------------------------------------------------------------------------

export type DimensionKind = 'numeric' | 'temporal' | 'categorical';

export interface DimensionSpec<N = Record<string, unknown>> {
  /** Stable dimension key (brushes rebase by this key across data updates). */
  key: string;
  kind: DimensionKind;
  /** Raw value accessor; hygiene applies (non-finite → excluded from bins).
   * Temporal accepts epoch-ms numbers, ISO strings, or 'YYYY-MM-DD'. */
  get: (node: GraphNode<N>) => unknown;
  /** Histogram bin count for numeric/temporal (default 24). */
  bins?: number;
}

/** Numeric/temporal brush (coordinates in the dimension's units — epoch ms
 * for temporal), or categorical EXCLUSIONS, or null = no brush. */
export type BrushState =
  | { min: number; max: number }
  | { excluded: readonly string[] }
  | null;

export interface HistogramBin {
  x0: number;
  x1: number;
  /** Rows in this bin regardless of any mask. */
  total: number;
  /** Rows in this bin passing every OTHER dimension's brush + the filter
   * prop's node mask (the joint "filtered" second layer). */
  filtered: number;
}

export interface CategoryBin {
  key: string;
  total: number;
  filtered: number;
  excluded: boolean;
}

export interface DimensionSummary {
  key: string;
  kind: DimensionKind;
  /** Numeric/temporal domain (finite rows only); undefined when empty. */
  domain?: { min: number; max: number };
  bins: readonly HistogramBin[];
  categories: readonly CategoryBin[];
  /** Rows excluded by hygiene (non-finite / unparseable). */
  excludedRows: number;
}

export interface CrossfilterSession {
  /** Monotonic from 0; advances exactly once per observable selection change. */
  readonly selectionRevision: number;
  /** Latest-call-wins coalescing per dimension; resolves once observable. */
  setBrush(key: string, brush: BrushState): Promise<void>;
  getBrush(key: string): BrushState;
  summarize(key: string): DimensionSummary;
  /** Fires once per observable selection/summary change. */
  subscribe(cb: () => void): () => void;
}

// ---------------------------------------------------------------------------
// timeline playback (headless controller; v0.7).
// ---------------------------------------------------------------------------

export interface TimelinePlayback {
  /** 'sliding' plays a fixed window; 'cumulative' grows from the domain start. */
  mode: 'sliding' | 'cumulative';
  /** Window width in dimension units (sliding; default domain/10). */
  window?: number;
  /** Tick interval in ms (default 100). */
  tickMs?: number;
  /** Fraction of the domain traversed per tick (default 0.01). */
  step?: number;
  loop?: boolean;
}

// ---------------------------------------------------------------------------
// hard scope + expansion services.
// ---------------------------------------------------------------------------

export interface SubgraphSpec {
  seedIds: readonly NodeId[];
  /** Expand N hops from the seeds via the expansion service (default 0). */
  hops?: number;
  /** Restart the layout around the subset (default true). */
  reflow?: boolean;
}

// ---------------------------------------------------------------------------
// search. The default service is client-side, field-scoped over the
// declared searchIndex (id-only when absent — it never guesses attr names);
// custom services plug in server-side search. Search NEVER
// changes scope/filters or fetches graph data.
// ---------------------------------------------------------------------------

export interface SearchResult<N = Record<string, unknown>> {
  id: string;
  score?: number;
  label?: string;
  node?: GraphNode<N>;
}

/** Why an activated result could not be focused. */
export type SearchUnavailableReason = 'not-loaded' | 'out-of-scope' | 'filtered';

export type SearchActivation =
  | { status: 'focused'; id: NodeId }
  | { status: 'unavailable'; reason: SearchUnavailableReason; result: SearchResult };

/** Context every async service call receives. */
export interface RequestContext {
  datasetKey: string;
  sourceRevision: number | string | null;
  modelRevision: number;
  scopeRevision: number;
  requestId: string;
  /** Abort is an optimization; admission is the correctness gate. */
  signal: AbortSignal;
}

export type RevisionDimension = 'source' | 'model' | 'scope';

/** A service declares exactly the revision dimensions it consumes. */
export interface RevisionAwareService {
  readonly revisionDependencies: readonly RevisionDimension[];
}

export interface ExpansionBatch<N = Record<string, unknown>, E = Record<string, unknown>> {
  nodes?: readonly GraphNode<N>[];
  edges?: readonly GraphEdge<E>[];
}

export type ExpansionResponse<N = Record<string, unknown>, E = Record<string, unknown>> =
  | (ExpansionBatch<N, E> & { provenance?: unknown })
  | { batches: AsyncIterable<ExpansionBatch<N, E>>; provenance?: unknown };

/**
 * path resolver seam. `find` resolves the node/edge id path
 * between two loaded nodes or null when unreachable (null is a RESULT, not
 * an error). Extends the revision-aware contract: abort is advisory,
 * revision admission at delivery is authoritative.
 */
export interface PathService extends RevisionAwareService {
  find(
    sourceId: NodeId,
    targetId: NodeId,
    options: PathOptions,
    ctx: RequestContext,
  ): Promise<PathResult | null>;
}

export interface ExpansionService<N = Record<string, unknown>, E = Record<string, unknown>>
  extends RevisionAwareService {
  neighbors(
    seedIds: readonly NodeId[],
    hops: number,
    ctx: RequestContext,
  ): Promise<ExpansionResponse<N, E>>;
}

// ---------------------------------------------------------------------------
// revisioned ingestion — bounded, cancellable sessions serialized
// through the instance-local acceptance queue.
// ---------------------------------------------------------------------------

export interface BeginIngestOptions {
  /** 'replace' commits a new source coordinate atomically; 'overlay' advances
   * only modelRevision and may be progressive. */
  purpose: 'replace' | 'overlay';
  datasetKey: string;
  /** Required for 'replace': the source coordinate the commit establishes. */
  sourceRevision?: number | string;
  /** CAS precondition: the model revision current when the session begins
   * (zero on an empty instance). Mismatch rejects with 'stale-revision'. */
  baseModelRevision: number;
  /** Overlays only (replace is always atomic). Default true. */
  atomic?: boolean;
  /** Caller-supplied stable overlay id; generated when omitted. */
  overlayId?: string;
  /** Progressive overlays: flush no later than this while running (default 50). */
  maxFlushLatencyMs?: number;
  /** Byte backpressure budget. Progressive receipts await drainage past this;
   * atomic sessions terminally reject an append that would exceed it because
   * atomic staging cannot drain before commit. */
  maxPendingBytes?: number;
}

export interface IngestBatch<N = Record<string, unknown>, E = Record<string, unknown>> {
  /** Consecutive, strictly monotonic from zero. */
  sequence: number;
  /** Idempotency key: an admitted {sequence, batchId} replay returns its
   * original receipt; same sequence + different batchId rejects. */
  batchId: string;
  nodes?: readonly GraphNode<N>[];
  edges?: readonly GraphEdge<E>[];
  /** Caller-declared payload size; estimated when omitted. */
  bytes?: number;
}

export interface AppendReceipt {
  sequence: number;
  batchId: string;
  admittedNodes: number;
  admittedEdges: number;
  /** Present once the flush containing this batch became public (progressive
   * overlays resolve only then, so exact replays return complete receipts). */
  publishedModelRevision?: number;
  /** Bytes admitted but not yet flushed (the backpressure signal). */
  pendingBytes: number;
}

export interface IngestCommitReceipt {
  overlayId?: string;
  modelRevision: number;
  sourceRevision?: number | string;
  admittedNodes: number;
  admittedEdges: number;
  /** Dangling edges dropped at commit; diagnostics are emitted only then. */
  danglingEdges: number;
}

export type IngestSessionState = 'open' | 'committing' | 'committed' | 'aborted';

export interface IngestSession<N = Record<string, unknown>, E = Record<string, unknown>> {
  readonly state: IngestSessionState;
  readonly overlayId: string | undefined;
  append(batch: IngestBatch<N, E>): Promise<AppendReceipt>;
  commit(): Promise<IngestCommitReceipt>;
  abort(reason?: unknown): Promise<void>;
}

/** label lane configuration (zoom-LOD, ranking, forced ids). */
export interface LabelConfig<N = Record<string, unknown>> {
  enabled?: boolean;
  /** Labels appear only at/above this zoom (LOD threshold). Default 1. */
  minZoom?: number;
  /**
   * cluster-label LOD ceiling. At or BELOW this zoom the active
   * cluster labels render and NODE labels are suppressed; above it
   * cluster labels stop and node-label LOD (`minZoom`) takes over. Absent ⇒
   * no LOD hand-off: cluster labels (when a spec is active) and node labels
   * coexist, each on its own gate.
   */
  maxZoom?: number;
  /** Ranked-candidate cap k (viewport-culled). Default 64, policy max 1024. */
  maxVisible?: number;
  /** Ids that claim capacity FIRST, bypassing ranking. */
  showFor?: readonly NodeId[];
  /** Label text; default attrs.label ?? id. Rendered as a TEXT NODE. */
  getText?: (node: GraphNode<N>) => string;
  /** Ranking weight; default nodeSize result order, else degree. */
  getWeight?: (node: GraphNode<N>) => number;
  /**
   * Screen-space overlap policy for ranked labels. 'hide' (default)
   * declutters: a candidate whose estimated label box intersects an
   * already-placed label loses its slot to the next-ranked candidate, so
   * dense clusters stop stacking text. `showFor` ids always render and claim
   * their space first. 'allow' restores overlap-blind selection. Boxes are
   * width ESTIMATES (fixed per-character size) — decluttering, not
   * typesetting — and require a projectable viewport; with an engine that
   * cannot project screen coordinates, selection stays overlap-blind.
   */
  overlap?: 'hide' | 'allow';
  /** Extra padding (CSS px) inflating each estimated label box. Default 2. */
  overlapPadding?: number;
}

/** accessibility runtime options. */
export interface AccessibilityConfig<N = Record<string, unknown>> {
  /** Canvas aria-label. Default 'Graph visualization'. */
  label?: string;
  description?: string;
  /** Max items per navigator relationship page. Default 50. */
  navigatorWindow?: number;
  /** Gate live-region announcements (default true). */
  announcements?: boolean;
  /** Text name for a node in the navigator/live region; default label/id. */
  getAccessibleLabel?: (node: GraphNode<N>) => string;
  /**
   * Reduced-motion override: true forces reduced, false forces full motion,
   * undefined follows the host binding's media-query detection.
   */
  reducedMotion?: boolean;
}

/** One positioned label emitted to the overlay lane per scheduler tick. */
export interface LabelPlacement {
  /** Node id — or, for `kind: 'cluster'`, the CLUSTER KEY. */
  id: NodeId;
  text: string;
  /** Screen coordinates (CSS px, container-relative). */
  x: number;
  y: number;
  forced: boolean;
  /**
   * placement kind. 'node' (default) anchors to the node's cached
   * position; 'cluster' anchors to the cluster's force center while the
   * simulation is hot and to its settled centroid afterwards, and selects its
   * MEMBER node ids when activated. Ids are drawn from
   * different namespaces, so consumers must key on `(kind, id)`.
   */
  kind?: 'node' | 'cluster';
}

// ---------------------------------------------------------------------------
// Store state (vanilla Zustand subset).
// ---------------------------------------------------------------------------

export interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

export type InstanceStatus =
  | 'idle'
  | 'mounting'
  | 'ready'
  /** WebGL context lost; engine frozen, CPU model stays live. */
  | 'lost'
  /** Context restored; the full-scene replay commit is in flight. */
  | 'recovering'
  | 'destroyed'
  | 'error';

/**
 * Namespaced selection. Namespaces are independent: node-set algebra
 * never mutates edge selection. `groupIds` is populated by group operations.
 */
export interface SelectionState {
  nodeIds: readonly NodeId[];
  edgeIds: readonly EdgeId[];
  groupIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Semantic exploration: groups, groupBy, meta-edges, paths.
// ---------------------------------------------------------------------------

/** manual group definition. Flat and disjoint: membership may not
 * nest, overlap, duplicate, self-reference, or name unknown ids — violations
 * are config-error diagnostics BEFORE any scene rewrite. */
export interface GroupSpec {
  /** Public group id — its own namespace, never colliding with node ids. */
  id: string;
  memberIds: readonly NodeId[];
  label?: string;
  /** Collapsed groups rewrite to super-nodes with meta-edges (stage 3). */
  collapsed?: boolean;
  color?: string;
}

/** derived grouping: one group per distinct accessor key (null =
 * ungrouped). Membership is derived and READ-ONLY; collapsed defaults false
 * so adding groupBy alone changes no rendering. */
export interface GroupBySpec<N = Record<string, unknown>> {
  by: (node: GraphNode<N>) => string | null;
  /** Hysteresis semantic zoom: crossing below collapseBelow collapses all
   * derived groups; crossing above expandAbove expands only groups
   * intersecting the viewport; between the thresholds the band holds.
   * expandAbove must be strictly greater than collapseBelow. */
  semanticZoom?: { collapseBelow: number; expandAbove: number };
}

/**
 * stage-4 non-collapsing layout clusters: a categorical `by` accessor
 * partitions the PHYSICAL scene (`null` ⇒ unclustered) into force-clustered,
 * centroid-labelled sets. Clusters preserve every node and edge and therefore
 * NEVER synthesize super-nodes or meta-edges; they coexist with
 * groups and re-derive over the post-group-rewrite physical scene.
 */
export interface ClusterSpec<N = Record<string, unknown>> {
  /** Membership accessor, compared by function REFERENCE (a new inline lambda
   * re-derives — the groupBy convention). */
  by: (node: GraphNode<N>) => string | null;
  /** Cluster-force strength handed to the engine. Inert (with ONE loud
   * degradation diagnostic) on engines that do not declare `clusterForce`;
   * membership, labels, and centroids still work. */
  strength?: number;
  /** Explicit force centers per key, in SPACE coordinates. Keys omitted here
   * generate deterministically from the ordered keys + layout seed; see
   * `resolveClusterCenters`. */
  centers?: ReadonlyMap<string, readonly [number, number]>;
}

/** Resolved cluster surface for overlays/selection (public ids only). */
export interface ResolvedCluster {
  /** The categorical key — also the cluster label's text and overlay id. */
  key: string;
  /** Member PHYSICAL node ids in scene order. */
  memberIds: readonly NodeId[];
  /** The force center labels anchor to while the simulation is HOT. */
  forceCenter: readonly [number, number];
  /** Settled centroid from the last permitted readback (or the commit
   * under a fixed layout); null until one has landed. */
  centroid: readonly [number, number] | null;
}

/** Resolved group surface for events/selection/store (public namespace). */
export interface ResolvedGroup {
  id: string;
  label?: string;
  memberIds: readonly NodeId[];
  collapsed: boolean;
  /** True for groupBy-derived groups (membership read-only). */
  derived: boolean;
  color?: string;
}

/** rerouted member edge on a collapsed group (stage 3), or a grouped
 * parallel-edge bundle. Count is the badge datum. */
export interface MetaEdge {
  id: string;
  /** Node id OR group id endpoint (public namespaces). */
  source: string;
  target: string;
  /** Underlying (rerouted / collapsed-parallel) edge count. */
  count: number;
}

/** path query options (PathService). */
export interface PathOptions {
  /** Edge-direction rule for traversal. Default 'outgoing'. */
  direction?: 'outgoing' | 'incoming' | 'either';
}

/** A resolved path: node ids in order plus the edge ids walked. */
export interface PathResult {
  nodeIds: readonly NodeId[];
  edgeIds: readonly EdgeId[];
}

export interface GraphStoreState {
  status: InstanceStatus;
  revisions: Revisions;
  nodeCount: number;
  edgeCount: number;
  selection: SelectionState;
  hover: { nodeId: NodeId | null; edgeId: EdgeId | null };
  /** id → pinned space position. */
  pins: ReadonlyMap<NodeId, readonly [number, number]>;
  /** PERSISTENT pins: ids held at their CURRENT position via
   * engine.setPinnedIndices. Independent lifecycle from the transient
   * drag-pin `pins` slice — the engine receives the UNION; releasing a drag
   * pin on a persistently-pinned node leaves it pinned. No position payload
   * in v0.10: a persistent pin freezes the node wherever it currently is. */
  pinnedNodeIds: ReadonlySet<NodeId>;
  hiddenNodeIds: ReadonlySet<NodeId>;
  /** Active hard scope; null = full scope. */
  scope: SubgraphSpec | null;
  /** Soft-mask visibility counts: RENDERED SCENE entities with zero
   * hide-failures — the synthetic suffix INCLUDED, so a collapsed
   * group contributes its one drawn super-node. Equals nodeCount/edgeCount
   * when nothing masks, scopes, or groups.
   *
   * NOT the same question as `getVisibleNodeIds()`, which lists PUBLIC
   * physical ids only. Pair a count with that list via
   * `getVisibleNodeIds().length`; use `visible` for "how much is on screen". */
  visible: { nodes: number; edges: number };
  /** Timeline playback state: at most one playing dimension. */
  timeline: { playingKey: string | null };
  /** history kernel depths. */
  history: { undoDepth: number; redoDepth: number };
  /** Node ids with an expansion in flight. */
  pendingExpansions: ReadonlySet<NodeId>;
  /**
   * node folds: anchor id → how many members it stands for. Empty when
   * nothing is folded.
   *
   * Published so folds are OBSERVABLE. A fold changes neither an anchor's id
   * nor its label text, so the label lane — which re-renders content only
   * when the candidate SET changes — would otherwise never re-render a badge
   * that depends on fold state. Subscribing to this slice is how a host keeps
   * fold-derived chrome (badges, affordances) in step.
   */
  folds: ReadonlyMap<NodeId, number>;
  /** Committed overlay ids for the current dataset. */
  overlayIds: readonly string[];
  /** resolved groups (manual or groupBy-derived); [] when ungrouped.
   * Path highlight is deliberately NOT here: session-local, never
   * serialized. */
  groups: readonly ResolvedGroup[];
  /** Last completed search: feeds <GraphSearch> and the
   * navigator's search-results section. Cleared on datasetKey change. */
  search: { query: string; results: readonly SearchResult[] } | null;
  viewport: ViewportState | null;
  /** Live force-simulation activity — true after a commit with
   * restart or resumeSimulation; false on settle or pauseSimulation. */
  simulationRunning: boolean;
  /** Resolved theme tokens: the merged GraphTheme currently driving
   * engine config, projection fallbacks, and mask dim alpha. Published on
   * change; defaults to the dark base. */
  theme: GraphTheme;
  diagnostics: readonly GraphDiagnostic[];
}

// ---------------------------------------------------------------------------
// Typed events: payloads carry caller objects, never indices.
// Listener chains run synchronously in registration order; the second
// argument's preventDefault cancels ONLY the built-in follow-up action
// (e.g. click-selection), never other listeners.
// ---------------------------------------------------------------------------

export interface GraphListenerControl {
  preventDefault(): void;
}

export interface NodeEventPayload<N = Record<string, unknown>> {
  node: GraphNode<N>;
}

// ---------------------------------------------------------------------------
// telemetry + degradation ladder. Spec-verbatim shapes.
// ---------------------------------------------------------------------------

/** engine buffer channels. Canonical home (engine/index.ts re-exports
 * the engine seam imports from types, never the reverse). */
export type EngineBufferChannel =
  | 'pointPosition'
  | 'link'
  | 'pointColor'
  | 'pointSize'
  | 'linkColor'
  | 'linkWidth';

/** performance snapshot — NEVER carries raw attrs or ids. */
export interface GraphPerfSnapshot {
  at: number;
  nodeCount: number;
  edgeCount: number;
  visibleNodeCount: number;
  visibleEdgeCount: number;
  /** Estimated bytes of CPU-side typed storage the instance holds (scene
   * buffers, base color caches, crossfilter columns, metric columns, mask
   * lanes). An estimate, not an audit — documented components only. */
  estimatedCpuBytes: number;
  /** Estimated bytes of engine-side channel storage (positions + the four
   * style channels at current scene sizes). Absent pre-scene. */
  estimatedGpuBytes?: number;
  queueDepth: number;
  modelRevision: number;
  scopeRevision: number;
  renderRevision: number;
  /** null while detached; may lag in mount/recovery. */
  appliedRenderRevision: number | null;
  lastCommitMs?: {
    kind: 'model' | 'scope' | 'config' | 'mask' | 'recovery';
    validate: number;
    derive: number;
    project: number;
    upload: number;
    firstDraw?: number;
  };
  activeDegradations: readonly DegradeStep[];
  execution: 'main' | 'worker';
  rangeUpdates: readonly EngineBufferChannel[];
  /** pressure-sampler mirror: EWMA of per-window mean frame
   * deltas, dropped-frame count, and idle wakeups since the last sample.
   * Zero idle wakeups is the healthy reading under the gated activity clock. */
  pressure: {
    frameEwmaMs: number;
    droppedFrames: number;
    idleWakeups: number;
  };
}

/** `limits` — construction-time thresholds for the ladder (construction-only:
 * read once; a runtime change warns and is ignored). */
export interface ScaleLimits {
  /** Default 100_000. */
  domLabelNodes: number;
  /** Default 250_000. */
  pickingLinks: number;
  /** Default 500_000. */
  histogramBatchNodes: number;
  /** Per-step engage/disengage band as a fraction. Default 0.10. */
  hysteresis: number;
  /** Minimum time a step holds its state. Default 1_000. */
  minimumDwellMs: number;
  /** Resource steps in engagement order. `uniform-link-style` participates
   * ONLY when explicitly listed — it can erase data-encoded styling, so
   * omission means resource admission rejects instead. */
  resourceDegradationOrder: readonly ResourceDegradeStep[];
}

export type ResourceDegradeStep = 'disable-transitions' | 'defer-images' | 'uniform-link-style';

export type DegradeStep =
  | 'cap-dom-labels'
  | 'defer-link-picking'
  | 'batch-histograms'
  | ResourceDegradeStep;

export interface DegradeEvent {
  step: DegradeStep;
  engaged: boolean;
  reason: 'count' | 'resource-estimate' | 'frame-pressure' | 'input-pressure';
  visible: { nodes: number; edges: number };
}

export interface GraphEventMap<N = Record<string, unknown>, E = Record<string, unknown>> {
  /** throttled telemetry sample — never per frame. */
  perfSample: GraphPerfSnapshot;
  /** Ladder step engagement/disengagement. This is a notification pattern,
   * not a controlled state lane. */
  degrade: DegradeEvent;
  nodeClick: NodeEventPayload<N> & { metaKey?: boolean };
  backgroundClick: Record<string, never>;
  nodeHover: { node: GraphNode<N> | null };
  edgeClick: { edge: AcceptedEdge<E> };
  edgeHover: { edge: AcceptedEdge<E> | null };
  nodeDragStart: NodeEventPayload<N>;
  /** Fired on drag release with the final space position; the built-in
   * follow-up pins the node there (preventDefault cancels the pin). */
  nodeDragEnd: NodeEventPayload<N> & { x: number; y: number };
  /** a setViewState dataRef mismatch — fired INSTEAD of applying.
   * Restoration proceeds only when the caller re-invokes with the opt-in. */
  viewStateMismatch: { stored: JsonValue | undefined; current: JsonValue | undefined };
  /** aggregate restore intent: fired ONCE per restore/history
   * transaction touching any controlled slice or serialized styling
   * never fanned out per lane. The host reflects every participating prop in
   * one commit; the transaction commits when the reflected values match, and
   * times out / diverges / supersedes as typed results otherwise. `next` is
   * the full target view state. */
  viewStateRestore: {
    transactionId: string;
    source: 'setViewState' | 'undo' | 'redo';
    next: unknown;
  };
  /** Right-click / long-press; built-in follow-up opens <GraphContextMenu>. */
  contextMenu: {
    target: { kind: 'node'; node: GraphNode<N> } | { kind: 'background' };
    /** Container-relative CSS px. */
    screen: readonly [number, number];
  };
  viewportChange: ViewportState;
  selectionChange: SelectionState;
  /** A super-node hit carries the resolved GROUP
   * never a GraphNode, never an internal scene key. Built-in follow-up
   * selects the group id into SelectionState.groupIds (preventDefault
   * cancels it, mirroring nodeClick). */
  groupClick: { group: ResolvedGroup; metaKey?: boolean };
  /** A meta-edge hit carries the MetaEdge record (public
   * endpoint ids + the underlying count badge datum). No built-in follow-up. */
  metaEdgeClick: { metaEdge: MetaEdge };
  /** groups slice change: op results (uncontrolled), op intents
   * (controlled — the host reflects the array back through the `groups`
   * prop), and groupBy re-derivations (notification; groupBy is always
   * instance-derived). Host `groups` prop writes and manual
   * model-drift re-resolutions are store-only and do NOT fire this. */
  groupsChange: { groups: readonly ResolvedGroup[] };
  /** persistent-pin slice change, the groups-latch mirror:
   * op results (uncontrolled) and op INTENTS (controlled — the host
   * reflects the array back through the `pinnedNodeIds` prop). Host prop
   * writes and model-drift prunes are store-only and do NOT fire this. */
  pinnedChange: { pinnedNodeIds: readonly NodeId[] };
  /** effective-set reporting seam: retractExpansion fires this
   * with the NEXT effective set as a SubgraphSpec whenever a collapse
   * changed what is displayed. v0.10 keeps `subgraph` UNCONTROLLED-ONLY, so
   * this is a notification today; a future controlled subgraph mode turns
   * it into the intent without changing the payload shape. */
  subgraphChange: { subgraph: SubgraphSpec };
  ready: Record<string, never>;
  error: { error: Error; detail?: GraphError };
  simulationEnd: Record<string, never>;
}

export type GraphEventName = keyof GraphEventMap;
