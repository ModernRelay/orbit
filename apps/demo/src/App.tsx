/**
 * Orbit demo — overlay/components workbench plus ingestion/scope workbench
 * over the cosmos engine.
 *
 * Two data modes:
 * - 'declarative' (default): the snapshot lives in React state and every
 * button produces a new snapshot. Selection stays CONTROLLED via the
 * `selection` prop; imperative set-algebra calls surface as
 * `selectionChange` intents which `onSelectionChange` writes back into
 * React state — the single selection owner.
 * - 'stream' ("Stream 250K feed"): a `purpose:'replace'` IngestSession
 * streams a deterministic NDJSON feed into a FRESH instance (the Graph
 * remounts via `key`). The remount matters: a replace session may not race
 * a declarative source, so streaming starts from an instance
 * that never had one. A LIVE meter renders from append receipts.
 *
 * Data controls include a stream feed, cluster isolation, scope reset,
 * the status-bar scope indicator, store-driven header
 * counts, and the context menu's Expand/Isolate items (in the package).
 *
 * v0.6: the Data panel grows an 'Omnigraph'
 * section — a third data mode that streams a real `og.export()` through
 * `createOmnigraphSource` into a fresh instance via the same-origin `/og`
 * dev proxy. Nodes are colored by the injected
 * `attrs['orbit:type']` and sized by a host-computed degree.
 *
 * v0.7: the Filters panel (per-cluster checkboxes → the `filter`
 * prop with a hide/dim mode toggle, hide-lane visible counts, Undo/Redo),
 * the `crossfilter` prop (score numeric ×30 bins, createdAt temporal
 * ×60 bins), and a collapsible chart strip (histogram + timeline) above the
 * status bar. A dev-only `?perf=1` hook feeds scripts/perf-lite.mjs.
 *
 * v0.8: the Style panel — theme base toggle (`theme={{base}}`),
 * nodeColor category/degree-ramp modes and nodeSize accessor/scale modes
 * (Scale descriptors over the built-in `degree` metric), edgeArrows
 * and showLinks toggles — plus <GraphLegend> bottom-right
 * above the chart strip. In omnigraph mode 'category' becomes a categorical
 * Scale by the adapter-injected `type` with the schema-known domain, so
 * the legend shows count-annotated type rows; in declarative mode it's a
 * categorical Scale by cluster-as-string. Legend category clicks wire to the
 * HOST's own filter state (toggleType / toggleCluster → the `filter`
 * prop), so the host owns actual filtering.
 *
 * v0.9: search + exploration panels + the prepared-data lane.
 * - <GraphSearch> (top-center, collapsible) over the `searchIndex`
 * prop — ['label'] for generated data, the intel attrs
 * ['name','title','brief'] in omnigraph mode; unavailable activations
 * surface in the status bar via the
 * `<Graph onSearchResultUnavailable>` fallback (data-testid
 * `search-unavailable`).
 * - <GraphMinimap> bottom-right above the legends. v0.9 trim: the CPU
 * fallback rasterizes DECLARED node positions, so the demo seeds every
 * generated/CSV node with a deterministic sunflower x/y (index-only
 * stable across the Add-500 superset; unchanged declarations defer to
 * live sim positions in the reconciler, so force layouts keep drifting).
 * - <GraphTooltip> always mounted; <GraphInspector> right dock behind a
 * toolbar toggle (it replaces the workbench sidebar while open).
 * - CSV drop (csvDrop.tsx): one edges CSV → `prepareGraphData`
 * edges-only/deriveNodes → applied as a declarative snapshot on a
 * fresh instance (`key` remount — the previous mode may have been a
 * replace-session stream), summaries as a panel line.
 *
 * v0.10: a fifth data mode, 'semantic' — the M5 semantic-exploration
 * workbench over a clustered fixture (semantic.tsx). It composes exactly like
 * the other modes: entering it remounts <Graph> through `graphKey`, so the
 * group/cluster/pin lanes start on a fresh instance and the mode can run
 * a FIXED layout (deterministic declared positions → stable screenshot
 * diffs) while every other mode keeps its force layout. Its controls live in
 * the left column (<SemanticPanel>), its equivalent views in a right dock
 * (<GraphTable> + <GraphSimControls>, which replaces the minimap/legend float
 * stack in this mode only), and its context menu adds the group collapse/
 * expand items plus the packaged find-path pair.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';

import type {
  AcceptedEdge,
  AccessibilityConfig,
  DimensionSpec,
  FilterMode,
  FilterSpec,
  GraphNode,
  GraphSnapshot,
  GraphPerfSnapshot,
  GraphStoreState,
  GroupSpec,
  InstanceStatus,
  LabelConfig,
  MetaEdge,
  NodeId,
  ResolvedGroup,
  Scale,
  SearchResult,
  SearchUnavailableReason,
  SimulationConfig,
  ThemeInput,
} from '@modernrelay/orbit-core';
import type { OmnigraphLoadResult } from '@modernrelay/orbit-omnigraph';
import { decodeSourceId, ORBIT_TYPE_KEY } from '@modernrelay/orbit-omnigraph';
import { CosmosEngine } from '@modernrelay/orbit-engine-cosmos';
import {
  Graph,
  useGraphEdgeHover,
  useGraphHistory,
  useGraphHover,
  useGraphInstance,
  useGraphPins,
  useGraphScope,
  useGraphSelection,
  useGraphStatus,
  useGraphTimeline,
  useGraphViewport,
  useGraphVisible,
} from '@modernrelay/orbit-react';
import type { GraphHandle } from '@modernrelay/orbit-react';
import { GraphContextMenu } from '@modernrelay/orbit-react/components/ContextMenu';
import { GraphHistogram } from '@modernrelay/orbit-react/components/Histogram';
import { GraphInspector } from '@modernrelay/orbit-react/components/Inspector';
import { GraphLegend } from '@modernrelay/orbit-react/components/Legend';
import { GraphMinimap } from '@modernrelay/orbit-react/components/Minimap';
import { GraphNavigator } from '@modernrelay/orbit-react/components/Navigator';
import { GraphSearch } from '@modernrelay/orbit-react/components/Search';
import { GraphSelectionActions } from '@modernrelay/orbit-react/components/SelectionActions';
import { GraphTimeline } from '@modernrelay/orbit-react/components/Timeline';
import { GraphToolbar } from '@modernrelay/orbit-react/components/Toolbar';
import { GraphTooltip } from '@modernrelay/orbit-react/components/Tooltip';

import { CsvDropZone, loadCsvEdgesFile } from './csvDrop';
import type { CsvDropResult } from './csvDrop';
import { DEFAULT_GENERATE, clusterName, generateGraph, nextSeed } from './generate';
import type { DemoEdgeAttrs, DemoNodeAttrs } from './generate';
import { OMNIGRAPH_FORM_DEFAULT, OmnigraphPanel, runOmnigraphLoad } from './omnigraphPanel';
import type {
  OmnigraphDisplayEdgeAttrs,
  OmnigraphDisplayNodeAttrs,
  OmnigraphFormState,
  OmnigraphMeter,
} from './omnigraphPanel';
import {
  M5_CLUSTER_COUNT,
  M5_CLUSTER_SPEC,
  M5_FROZEN_SIMULATION,
  M5_GROUP_BY,
  M5_LABELS,
  M5_MANUAL_GROUPS,
  M5_NODE_SIZE,
  M5_SIMULATION,
  M5_TABLE_DIMENSION,
  SemanticContextMenu,
  SemanticDock,
  SemanticPanel,
  buildSemanticSnapshot,
  metaEventText,
  toGroupSpecs,
} from './semantic';
import type { M5Grouping, M5Layout } from './semantic';
import {
  STREAM_CLUSTERS,
  STREAM_ROWS_DEFAULT,
  clampFamily,
  runStreamFeed,
  streamClusterNodeIds,
} from './streamFeed';
import type { StreamFamily, StreamProgress } from './streamFeed';
import * as S from './styles';
import { BACKGROUND, LIGHT_BACKGROUND, clusterColor, typeColor } from './styles';

/** Union attrs: generated demo shapes or Omnigraph-loaded shapes, discriminated
 * by the adapter-injected type field that demo attrs lack. */
type AppNodeAttrs = DemoNodeAttrs | OmnigraphDisplayNodeAttrs;
type AppEdgeAttrs = DemoEdgeAttrs | OmnigraphDisplayEdgeAttrs;

type NodeMap = ReadonlyMap<NodeId, GraphNode<AppNodeAttrs>>;

// --- stable (module-scope) Graph props: never re-projected across renders ---

const engineFactory = () => new CosmosEngine();

/** Theme bases use partial-over-base inputs. Dark keeps the demo's
 * historical canvas color; light overrides to the demo's light app token so
 * canvas and overlay chrome agree. Module-scope: structural theme identity
 * stays stable across renders. */
const DARK_THEME: ThemeInput = { base: 'dark', background: BACKGROUND };
const LIGHT_THEME: ThemeInput = { base: 'light', background: LIGHT_BACKGROUND };

type ThemeBase = 'dark' | 'light';

const SIMULATION: SimulationConfig = { repulsion: 0.6, gravity: 0.25 };

/** Categorical color: Omnigraph nodes by the adapter-injected node kind at
 * `attrs['orbit:type']` (the natural legend domain), demo nodes by generated
 * cluster.
 *
 * The narrowing MUST key on ORBIT_TYPE_KEY, not `type`: since the
 * discriminator moved to its namespaced key, an omnigraph schema's own
 * `type` property (e.g. `Company.type = 'developer'`) now flows through as
 * ordinary data, so `'type' in a` would match it and colour by the wrong
 * field entirely. */
const nodeColor = (node: GraphNode<AppNodeAttrs>): string => {
  const a = node.attrs;
  if (a === undefined) return clusterColor(0);
  if (ORBIT_TYPE_KEY in a) return typeColor(a[ORBIT_TYPE_KEY]);
  return clusterColor(a.cluster);
};

/** Degree-scaled size; omnigraph degree is host-computed during ingest and
 * absent attrs fall back to the base size. */
const nodeSize = (node: GraphNode<AppNodeAttrs>): number => {
  const a = node.attrs;
  const degree = a !== undefined && 'degree' in a ? a.degree ?? 0 : 0;
  return 2 + Math.sqrt(degree);
};

const LINK_COLOR = 'rgba(255,255,255,0.15)';
const LINK_COLOR_LIGHT = 'rgba(0,0,0,0.15)';

// --- style modes --------
// Scale objects are plain descriptors compared by canonical structural value,
// but module scope keeps their identities trivially stable anyway.

type ColorMode = 'category' | 'degree';
type SizeMode = 'accessor' | 'scale';

/** 'degree ramp' color mode: sequential blue→amber over the degree metric. */
const DEGREE_COLOR_SCALE: Scale<string, AppNodeAttrs> = {
  kind: 'sequential',
  metric: 'degree',
  range: ['#3b82f6', '#f59e0b'],
};

/** 'degree scale' size mode: sequential 2..14px over the degree metric. */
const DEGREE_SIZE_SCALE: Scale<number, AppNodeAttrs> = {
  kind: 'sequential',
  metric: 'degree',
  range: [2, 14],
};

/** Declared cluster domain for declarative 'category' mode: fixed order →
 * stable colors and stable legend rows. */
const CLUSTER_DOMAIN: readonly string[] = Array.from(
  { length: DEFAULT_GENERATE.clusters },
  (_, c) => String(c),
);

/** Categorical `by` function (module-scope: compared by reference). The
 * legend value is the cluster id as a string; clicks parse it back. */
const clusterByString = (node: GraphNode<AppNodeAttrs>): string | null => {
  const a = node.attrs;
  return a !== undefined && 'cluster' in a ? String(a.cluster) : null;
};

/** Declarative 'category' mode: cluster-as-string categorical scale with the
 * palette aligned to the historical clusterColor assignment. */
const CLUSTER_COLOR_SCALE: Scale<string, AppNodeAttrs> = {
  kind: 'categorical',
  by: clusterByString,
  domain: CLUSTER_DOMAIN,
  palette: CLUSTER_DOMAIN.map((v) => clusterColor(Number(v))),
};

/** Shared text accessor for labels, the navigator, the live region, and the
 * status-bar hover readout. Omnigraph nodes get a type-derived label
 * (fixture schema: Actor carries `name`, every other node type `title`). */
const labelOf = (node: GraphNode<AppNodeAttrs>): string => {
  const a = node.attrs;
  if (a === undefined) return node.id;
  if (ORBIT_TYPE_KEY in a) {
    return `${a[ORBIT_TYPE_KEY]} · ${'title' in a ? a.title : a.name}`;
  }
  return a.label;
};

/** Hover-card title for an EDGE. Omnigraph edges carry the relationship name
 * at the adapter-injected discriminator (`PublishedBySource`, `RelevantCompany`
 * …), which is more useful than the raw type-qualified tuple id.
 * Generated/CSV edges fall back to `attrs.label`, then the id. */
const edgeLabelOf = (edge: { id: string; attrs?: unknown }): string => {
  const a = edge.attrs as Record<string, unknown> | undefined;
  const kind = a?.[ORBIT_TYPE_KEY];
  if (typeof kind === 'string') return kind;
  const label = a?.['label'];
  return typeof label === 'string' ? label : edge.id;
};

/** Split the "Kind · Name" string `labelOf` builds back into its parts so the
 * pill can style them independently. Falls back to name-only when the label
 * carries no kind prefix (generated / stream / CSV / M5 data). */
function splitLabel(text: string): { type: string | null; name: string } {
  const at = text.indexOf(' · ');
  return at < 0 ? { type: null, name: text } : { type: text.slice(0, at), name: text.slice(at + 3) };
}

/**
 * `<Graph renderNodeLabel>` — the escape hatch. Values land as JSX
 * children only, so the text-node-only rule holds: a hostile label renders
 * literally, never as markup.
 *
 * VISUAL ONLY. `labelOf` keeps returning the full "Kind · Name" for
 * `LabelConfig.getText` and `AccessibilityConfig.getAccessibleLabel`, so the
 * navigator, live region, tooltip, status-bar hover readout and selection
 * panel always carry the kind — hiding it here never costs a screen-reader
 * user the disambiguation. (Driving the toggle through `getText` instead
 * would change `LabelPlacement.text`, flipping the core's candidate-set
 * identity and forcing a full lane re-render on every toggle.)
 */
function renderPillLabel(text: string, showType: boolean, foldedCount: number): ReactNode {
  const { type, name } = splitLabel(text);
  return (
    <span style={S.labelPill}>
      {showType && type !== null && <span style={S.labelPillType}>{type}</span>}
      <span style={S.labelPillName}>{name}</span>
      {/* fold badge: this node is standing for `foldedCount` others. */}
      {foldedCount > 0 && <span style={S.labelPillBadge}>{`+${foldedCount}`}</span>}
    </span>
  );
}

/** label lane: zoom-LOD at 1.2, ranked cap 48 (sane at 250K rows too),
 * and the two cluster hubs (`n0`/`n1`) forced via showFor. */
const LABELS: LabelConfig<AppNodeAttrs> = {
  minZoom: 1.2,
  maxVisible: 48,
  showFor: ['n0', 'n1'],
  getText: labelOf,
};

/** Label lane for the (small) omnigraph fixture graph: no forced demo ids,
 * labels appear earlier. */
const OG_LABELS: LabelConfig<AppNodeAttrs> = {
  minZoom: 0.8,
  maxVisible: 64,
  getText: labelOf,
};

/** accessibility surface: container name + navigator/live-region text. */
const ACCESSIBILITY: AccessibilityConfig<AppNodeAttrs> = {
  label: 'orbit demo graph',
  getAccessibleLabel: labelOf,
};

// --- search -------------------------------------------------------------
// Module scope: searchIndex is CONSTRUCTION-ONLY (D7) — <Graph> reads it once
// at mount, and this demo's graphKey remounts per mode, so the per-mode value
// below takes effect on every mode switch. The default local service indexes
// node ids ALWAYS plus exactly these attr fields — it never guesses attr names.

/** Generated data (declarative/stream/CSV): the `label` attr. CSV-derived
 * nodes carry no attrs at all, so search degrades to id-only there. */
const SEARCH_INDEX: readonly string[] = ['label'];

/** Omnigraph mode: the intel-fixture content fields. */
const OG_SEARCH_INDEX: readonly string[] = ['name', 'title', 'brief'];

// --- minimap seed positions --------------------------------------------------

const GOLDEN_ANGLE = 2.399963229728653;
/** Cosmos space is [0, 4096] with unknown-position ring seeding at r=1024
 * around the center — the sunflower disc matches that envelope. */
const SEED_CENTER = 2048;
const SEED_RADIUS_STEP = 17; // r = 17·√i → ≈1005 at i=3500

/**
 * v0.9 minimap trim: the CPU fallback rasterizes DECLARED node
 * positions, so the demo declares a deterministic golden-angle sunflower
 * seed for every position-less node. Seeds depend ONLY on the node's array
 * index — stable across the Add-500 superset — and the reconciler defers
 * UNCHANGED declarations to live sim positions, so the force layout still
 * owns motion; the declaration doubles as the sim's initial placement.
 */
function seedSnapshotPositions<N, E>(snap: GraphSnapshot<N, E>): GraphSnapshot<N, E> {
  const nodes = snap.nodes.map((node, i) => {
    if (node.x !== undefined && node.y !== undefined) return node;
    const r = SEED_RADIUS_STEP * Math.sqrt(i);
    const a = i * GOLDEN_ANGLE;
    return { ...node, x: SEED_CENTER + Math.cos(a) * r, y: SEED_CENTER + Math.sin(a) * r };
  });
  return { ...snap, nodes };
}

// --- crossfilter dimensions (v0.7) -------------------------------------
// Module scope: an identity change would rebuild the dimension and clear its
// brush, so these must be stable across renders. Omnigraph nodes lack
// the metric attrs — `get` returns undefined and hygiene excludes them.

const SCORE_DIM: DimensionSpec<AppNodeAttrs> = {
  key: 'score',
  kind: 'numeric',
  bins: 30,
  get: (node) => {
    const a = node.attrs;
    return a !== undefined && 'score' in a ? a.score : undefined;
  },
};

const CREATED_DIM: DimensionSpec<AppNodeAttrs> = {
  key: 'createdAt',
  kind: 'temporal',
  bins: 60,
  get: (node) => {
    const a = node.attrs;
    return a !== undefined && 'createdAt' in a ? a.createdAt : undefined;
  },
};

const CROSSFILTER_DIMS: readonly DimensionSpec<AppNodeAttrs>[] = [SCORE_DIM, CREATED_DIM];

// Omnigraph mode: intel-style graphs carry no generated metrics, but the
// adapter injects `type`, most content nodes declare a `domain` enum, and the
// adapter normalizes DateTime to ISO strings, which the temporal dimension
// parses directly. Rows without the attr are hygiene-excluded.
const OG_DOMAIN_DIM: DimensionSpec<AppNodeAttrs> = {
  key: 'domain',
  kind: 'categorical',
  get: (node) => {
    const a = node.attrs as Record<string, unknown> | undefined;
    return a !== undefined && 'domain' in a ? a['domain'] : undefined;
  },
};

const OG_CREATED_DIM: DimensionSpec<AppNodeAttrs> = {
  key: 'createdAt',
  kind: 'temporal',
  bins: 60,
  get: (node) => {
    const a = node.attrs as Record<string, unknown> | undefined;
    return a !== undefined && 'createdAt' in a ? a['createdAt'] : undefined;
  },
};

const OG_CROSSFILTER_DIMS: readonly DimensionSpec<AppNodeAttrs>[] = [
  OG_DOMAIN_DIM,
  OG_CREATED_DIM,
];

/** M5 mode adds the id-keyed dimension `<GraphTable>`'s filter brushes
 * through to the generated-data dimensions. */
const M5_CROSSFILTER_DIMS: readonly DimensionSpec<AppNodeAttrs>[] = [
  SCORE_DIM,
  CREATED_DIM,
  M5_TABLE_DIMENSION,
];

const EMPTY_TYPE_SET: ReadonlySet<string> = new Set();

const EMPTY_CLUSTER_SET: ReadonlySet<number> = new Set();

// --- store selectors for the local useSyncExternalStore hooks ---------------

const selectNodeCount = (s: GraphStoreState): number => s.nodeCount;
const selectEdgeCount = (s: GraphStoreState): number => s.edgeCount;
const selectModelRevision = (s: GraphStoreState): number => s.revisions.model;
const selectRenderRevision = (s: GraphStoreState): number => s.revisions.render;
const selectAppliedRenderRevision = (s: GraphStoreState): number =>
  s.revisions.appliedRender ?? -1;

// --- generation state --------------------------------------------------------

interface GenState {
  seed: number;
  datasetKey: string;
  nodes: number;
  revision: number;
}

const DECL_OVERRIDE = readDeclOverride();
const INITIAL_GEN: GenState = {
  seed: 1337,
  datasetKey: 'demo',
  nodes: DECL_OVERRIDE.nodes ?? 3000,
  revision: 1,
};

/** Data mode: declarative snapshot (default), a streamed replace session, an
 * omnigraph export load, or a prepared-CSV snapshot. The
 * omnigraph member snapshots the form at click time so mid-load input edits
 * never restart the effect; the csv member carries the finished prepared
 * result (preparation happens BEFORE the mode flips). */
type DataMode =
  | { kind: 'declarative' }
  | { kind: 'stream'; seed: number }
  | { kind: 'omnigraph'; runId: number; form: OmnigraphFormState }
  | { kind: 'csv'; runId: number; result: CsvDropResult }
  /** M5: the layout rides the mode so switching it remounts — a force
   * run moves nodes off their declared positions, and freezing in place would
   * capture wherever the sim stopped instead of the deterministic fixture. */
  | { kind: 'semantic'; runId: number; layout: M5Layout };

const DECLARATIVE: DataMode = { kind: 'declarative' };

const EMPTY_NODE_MAP: NodeMap = new Map();
/** Stable empty fold-count map (identity matters to useState). */
const EMPTY_FOLD_COUNTS: ReadonlyMap<NodeId, number> = new Map();

/** `?rows=` overrides the feed size (the e2e suite streams a reduced feed). */
function readStreamRows(): number {
  if (typeof window === 'undefined') return STREAM_ROWS_DEFAULT;
  const raw = new URLSearchParams(window.location.search).get('rows');
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return STREAM_ROWS_DEFAULT;
  return Math.min(1_000_000, Math.max(1_000, parsed));
}

/** `?nodeShare=` overrides the feed's node-row share (perf tiers hit exact
 * cardinalities with it — L = 100K/250K via rows=350000&nodeShare=0.2857).
 * Absent/invalid → the feed's 0.8 default. */
function readStreamNodeShare(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  const raw = new URLSearchParams(window.location.search).get('nodeShare');
  const parsed = raw === null ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `?family=` picks the generator family for the streamed feed. */
function readStreamFamily(): StreamFamily {
  if (typeof window === 'undefined') return 'clustered';
  return clampFamily(new URLSearchParams(window.location.search).get('family'));
}

/** `?declNodes=` / `?declEdgeFactor=` size the DECLARATIVE generator (the
 * S-tier first-paint scenario: object path, e.g. declNodes=10000&
 * declEdgeFactor=2.44 ≈ 10K/25K; actual counts are read from the header). */
function readDeclOverride(): { nodes?: number; intraEdgeFactor?: number } {
  if (typeof window === 'undefined') return {};
  const params = new URLSearchParams(window.location.search);
  const out: { nodes?: number; intraEdgeFactor?: number } = {};
  const n = Number.parseInt(params.get('declNodes') ?? '', 10);
  if (Number.isFinite(n) && n >= 10 && n <= 500_000) out.nodes = n;
  const f = Number.parseFloat(params.get('declEdgeFactor') ?? '');
  if (Number.isFinite(f) && f >= 0 && f <= 10) out.intraEdgeFactor = f;
  return out;
}

function fmtRows(rows: number): string {
  return rows % 1000 === 0 ? `${(rows / 1000).toLocaleString('en-US')}K` : rows.toLocaleString('en-US');
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** End-to-end hook (`?hostileLabel=1`): give n0 a hostile label so the
 * export specs can assert escaping end to end. Workbench-only, like ?rows=. */
function hostileLabelOverride<N extends { label: string }, E>(
  snap: GraphSnapshot<N, E>,
): GraphSnapshot<N, E> {
  if (!new URLSearchParams(window.location.search).has('hostileLabel')) return snap;
  const nodes = snap.nodes.map((n, i) =>
    i === 0
      ? { ...n, attrs: { ...(n.attrs as N), label: '<script>alert("x")</script>&\'' } }
      : n,
  );
  return { ...snap, nodes };
}

/** e2e observability: the demo mirrors each export here so specs can
 * assert content without wiring real browser downloads. */
declare global {
  interface Window {
    __lastExport?: { kind: 'svg' | 'jsonl'; text: string; lines?: number; error?: string };
  }
}

export function App() {
  const graphRef = useRef<GraphHandle<AppNodeAttrs, AppEdgeAttrs> | null>(null);
  const [gen, setGen] = useState<GenState>(INITIAL_GEN);
  const [mode, setMode] = useState<DataMode>(DECLARATIVE);
  const [meter, setMeter] = useState<StreamProgress | null>(null);
  const [selection, setSelection] = useState<readonly NodeId[]>([]);
  /** deep-link: the raw ?view= payload awaiting a mismatch decision. */
  const [mismatchRaw, setMismatchRaw] = useState<unknown | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [pendingIsolate, setPendingIsolate] = useState(false);
  const [dragNote, setDragNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- soft-filter state (Filters panel) ---
  const [excludedClusters, setExcludedClusters] = useState<ReadonlySet<number>>(EMPTY_CLUSTER_SET);
  const [excludedTypes, setExcludedTypes] = useState<ReadonlySet<string>>(EMPTY_TYPE_SET);
  const [filterMode, setFilterMode] = useState<FilterMode>('hide');
  const [chartsOpen, setChartsOpen] = useState(true);

  // --- style state (Style panel) ---
  const [themeBase, setThemeBase] = useState<ThemeBase>('dark');
  const [colorMode, setColorMode] = useState<ColorMode>('category');
  const [showLabelType, setShowLabelType] = useState(true);
  /**
   * fold counts mirrored from `store.folds` (subscribed below, once
   * `graphKey` exists). App sits ABOVE <Graph>, so it cannot use the provider
   * hooks the overlay components use — it subscribes through the handle
   * instead. Mirroring into state, rather than reading the ref inside
   * `renderNodeLabel`, is what makes the badge live: the label lane
   * re-renders on candidate-SET changes, and a fold changes neither an id nor
   * a label's text.
   */
  const [foldCounts, setFoldCounts] = useState<ReadonlyMap<NodeId, number>>(EMPTY_FOLD_COUNTS);
  const [sizeMode, setSizeMode] = useState<SizeMode>('accessor');
  const [edgeArrows, setEdgeArrows] = useState(false);
  const [showLinks, setShowLinks] = useState(true);

  // --- search / inspector / CSV state ---
  const [inspectorOpen, setInspectorOpen] = useState(false);
  /** Last unavailable activation ("<label>: <reason>") — sticky. */
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);

  // --- M5 semantic-exploration state (see semantic.tsx) ---
  const [m5Grouping, setM5Grouping] = useState<M5Grouping>('none');
  const [m5Clusters, setM5Clusters] = useState(false);
  const [m5Parallel, setM5Parallel] = useState(false);
  /** CONTROLLED `groups` prop: ops arrive as onGroupsChange intents. */
  const [m5Groups, setM5Groups] = useState<readonly GroupSpec[]>(M5_MANUAL_GROUPS);
  /** CONTROLLED `pinnedNodeIds` prop, same reflect-the-intent lane. */
  const [m5Pinned, setM5Pinned] = useState<readonly NodeId[]>([]);
  /** Bumped when a findPath/clearPath call settles — the path is session-local
   * (no store slice), so the readout re-reads getActivePath on this. */
  const [m5PathTick, setM5PathTick] = useState(0);
  const [m5MetaEvent, setM5MetaEvent] = useState<string | null>(null);
  const [m5SimGravity, setM5SimGravity] = useState<number | null>(null);

  // --- omnigraph load state ---
  const [ogForm, setOgForm] = useState<OmnigraphFormState>(OMNIGRAPH_FORM_DEFAULT);
  const [ogMeter, setOgMeter] = useState<OmnigraphMeter | null>(null);
  const [ogResult, setOgResult] = useState<OmnigraphLoadResult | null>(null);
  const [ogError, setOgError] = useState<string | null>(null);
  const [ogNodes, setOgNodes] = useState<NodeMap | null>(null);

  const streamRows = useMemo(readStreamRows, []);

  const snapshot = useMemo(
    () =>
      // Seeded declared positions (see seedSnapshotPositions): minimap scene
      // source + deterministic sim start; the force layout still owns motion.
      hostileLabelOverride(
        seedSnapshotPositions(
          generateGraph({
            seed: gen.seed,
            nodes: gen.nodes,
            clusters: DEFAULT_GENERATE.clusters,
            intraEdgeFactor: DECL_OVERRIDE.intraEdgeFactor ?? DEFAULT_GENERATE.intraEdgeFactor,
            interEdgeProb: DEFAULT_GENERATE.interEdgeProb,
            datasetKey: gen.datasetKey,
            sourceRevision: gen.revision,
          }),
        ),
      ),
    [gen],
  );

  const snapshotNodeById: NodeMap = useMemo(
    () => new Map<NodeId, GraphNode<AppNodeAttrs>>(snapshot.nodes.map((n) => [n.id, n])),
    [snapshot],
  );

  /** CSV mode: the prepared snapshot under the app's attr generics
   * safe because derived nodes carry NO attrs and edge attrs are never field-
   * accessed here; every accessor handles `attrs === undefined`. Seeded like
   * the generated data so the minimap rasterizes it. */
  const csvSnapshot = useMemo<GraphSnapshot<AppNodeAttrs, AppEdgeAttrs> | null>(
    () =>
      mode.kind === 'csv'
        ? seedSnapshotPositions(
            mode.result.prepared.snapshot as unknown as GraphSnapshot<AppNodeAttrs, AppEdgeAttrs>,
          )
        : null,
    [mode],
  );

  const csvNodeById: NodeMap = useMemo(
    () =>
      csvSnapshot === null
        ? EMPTY_NODE_MAP
        : new Map<NodeId, GraphNode<AppNodeAttrs>>(csvSnapshot.nodes.map((n) => [n.id, n])),
    [csvSnapshot],
  );

  /** M5 mode: the clustered fixture. Built once — it is a pure function of
   * module constants, so its identity is stable across every M5 render and
   * the data prop never re-forwards. */
  const semanticSnapshot = useMemo<GraphSnapshot<AppNodeAttrs, AppEdgeAttrs>>(
    buildSemanticSnapshot,
    [],
  );

  const semanticNodeById: NodeMap = useMemo(
    () => new Map<NodeId, GraphNode<AppNodeAttrs>>(semanticSnapshot.nodes.map((n) => [n.id, n])),
    [semanticSnapshot],
  );

  /** Hover/selection lookups: harvested omnigraph nodes in omnigraph mode,
   * the CSV snapshot in csv mode, the M5 fixture in semantic mode, the
   * declarative snapshot otherwise (stream ids miss and fall back). */
  const nodeById: NodeMap =
    mode.kind === 'omnigraph'
      ? ogNodes ?? EMPTY_NODE_MAP
      : mode.kind === 'csv'
        ? csvNodeById
        : mode.kind === 'semantic'
          ? semanticNodeById
          : snapshotNodeById;

  /** Leaving/re-entering omnigraph mode clears its meter/result/error state. */
  const resetOmnigraphState = useCallback(() => {
    setOgMeter(null);
    setOgResult(null);
    setOgError(null);
    setOgNodes(null);
  }, []);

  // --- soft filter (Filters panel → the filter prop) ---
  // Generated clusters exist in declarative AND stream data; omnigraph nodes
  // have no `cluster` attr, so the panel is inert there (clusterCount 0).
  const clusterCount =
    mode.kind === 'declarative'
      ? DEFAULT_GENERATE.clusters
      : mode.kind === 'stream'
        ? STREAM_CLUSTERS
        : mode.kind === 'semantic'
          ? M5_CLUSTER_COUNT
          : 0;

  /** Distinct injected node types of the loaded omnigraph dataset. */
  const ogTypes = useMemo<readonly string[]>(() => {
    if (mode.kind !== 'omnigraph' || ogNodes === null) return [];
    const seen = new Set<string>();
    for (const node of ogNodes.values()) {
      const a = node.attrs as Record<string, unknown> | undefined;
      const t = a !== undefined ? a[ORBIT_TYPE_KEY] : undefined;
      if (typeof t === 'string') seen.add(t);
    }
    return [...seen].sort();
  }, [mode.kind, ogNodes]);

  // --- styling channels ---
  // Omnigraph 'category' mode: categorical Scale by the adapter-injected
  // `'orbit:type'` FIELD (the FilterExpr convention) with the loaded type names as
  // the declared domain and the palette aligned to typeColor — <GraphLegend>
  // then shows count-annotated type rows in a stable order.
  const ogColorScale = useMemo<Scale<string, AppNodeAttrs> | null>(() => {
    if (ogTypes.length === 0) return null;
    return {
      kind: 'categorical',
      by: ORBIT_TYPE_KEY,
      domain: ogTypes,
      palette: ogTypes.map(typeColor),
    };
  }, [ogTypes]);

  // Stream mode keeps the plain accessor in 'category' mode (its cluster
  // count differs from the declared declarative domain).
  const nodeColorProp: Scale<string, AppNodeAttrs> | typeof nodeColor =
    colorMode === 'degree'
      ? DEGREE_COLOR_SCALE
      : mode.kind === 'omnigraph'
        ? ogColorScale ?? nodeColor
        : mode.kind === 'declarative'
          ? CLUSTER_COLOR_SCALE
          : nodeColor;

  // M5 keeps a fixed point size in accessor mode (see M5_NODE_SIZE); the
  // degree Scale still applies when the Style panel selects it.
  const nodeSizeProp: Scale<number, AppNodeAttrs> | typeof nodeSize | typeof M5_NODE_SIZE =
    sizeMode === 'scale' ? DEGREE_SIZE_SCALE : mode.kind === 'semantic' ? M5_NODE_SIZE : nodeSize;

  const filter = useMemo<FilterSpec<AppNodeAttrs, AppEdgeAttrs> | null>(() => {
    if (mode.kind === 'omnigraph') {
      if (ogTypes.length === 0 || excludedTypes.size === 0) return null;
      const values = ogTypes.filter((t) => !excludedTypes.has(t));
      return { nodes: { op: 'in', field: ORBIT_TYPE_KEY, values }, mode: filterMode };
    }
    if (clusterCount === 0 || excludedClusters.size === 0) return null;
    const values: number[] = [];
    for (let c = 0; c < clusterCount; c++) {
      if (!excludedClusters.has(c)) values.push(c);
    }
    return { nodes: { op: 'in', field: 'cluster', values }, mode: filterMode };
  }, [mode.kind, ogTypes, excludedTypes, clusterCount, excludedClusters, filterMode]);

  const toggleType = useCallback((t: string) => {
    setExcludedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);

  const toggleCluster = useCallback((cluster: number) => {
    setExcludedClusters((prev) => {
      const next = new Set(prev);
      if (next.has(cluster)) next.delete(cluster);
      else next.add(cluster);
      return next;
    });
  }, []);

  const toggleCharts = useCallback(() => setChartsOpen((v) => !v), []);

  // --- legend wiring: the HOST owns actual filtering — category
  // clicks drive the SAME state as the Filters panel checkboxes, which feeds
  // the `filter` prop.
  const legendExcluded = useMemo<readonly string[]>(
    () =>
      mode.kind === 'omnigraph' ? [...excludedTypes] : [...excludedClusters].map(String),
    [mode.kind, excludedTypes, excludedClusters],
  );

  const onLegendCategoryClick = useCallback(
    (value: string) => {
      if (mode.kind === 'omnigraph') {
        toggleType(value);
        return;
      }
      const cluster = Number.parseInt(value, 10);
      if (Number.isFinite(cluster)) toggleCluster(cluster);
    },
    [mode.kind, toggleType, toggleCluster],
  );

  // --- declarative data updates ---
  const regenerate = useCallback(() => {
    setGen((g) => {
      const seed = nextSeed(g.seed);
      // New datasetKey → full reset (positions, per-dataset state).
      return { seed, datasetKey: `demo-${seed}`, nodes: DEFAULT_GENERATE.nodes, revision: 1 };
    });
    // Also exits stream/omnigraph/csv mode: back to the declarative source.
    setMode(DECLARATIVE);
    setMeter(null);
    resetOmnigraphState();
    setCsvError(null);
    setSelection([]);
    setPendingIsolate(false);
    setDragNote(null);
    setExcludedClusters(EMPTY_CLUSTER_SET);
  }, [resetOmnigraphState]);

  const addNodes = useCallback(() => {
    // Same datasetKey, bumped sourceRevision, strict superset snapshot →
    // exercises the incremental diff + position preservation.
    setMode(DECLARATIVE);
    setMeter(null);
    resetOmnigraphState();
    setGen((g) => ({ ...g, nodes: g.nodes + 500, revision: g.revision + 1 }));
  }, [resetOmnigraphState]);

  // --- stream mode -------------------------------------------------------
  // Entering stream mode remounts <Graph> (key change) WITHOUT the data prop:
  // purpose:'replace' is rejected while a declarative source drives, so
  // the session begins against a fresh, never-declarative instance.
  const streamFeed = useCallback(() => {
    setSelection([]);
    setPendingIsolate(false);
    setDragNote(null);
    setError(null);
    setMeter(null);
    resetOmnigraphState();
    setExcludedClusters(EMPTY_CLUSTER_SET);
    setMode((m) => ({ kind: 'stream', seed: m.kind === 'stream' ? nextSeed(m.seed) : 20_26 }));
  }, [resetOmnigraphState]);

  useEffect(() => {
    if (mode.kind !== 'stream') return undefined;
    const handle = graphRef.current;
    if (handle === null) return undefined;
    let cancelled = false;
    void runStreamFeed(handle, {
      seed: mode.seed,
      rows: streamRows,
      nodeShare: readStreamNodeShare(),
      family: readStreamFamily(),
      shouldCancel: () => cancelled,
      onProgress: setMeter, // driver-throttled — receipts arrive far faster
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true; // aborts the session at the next batch boundary
    };
  }, [mode, streamRows]);

  // --- Omnigraph mode ------------------------------------------------------
  // Same remount discipline as stream mode: the loader begins a
  // `purpose:'replace'` session, which may not race a declarative source,
  // so each load targets a fresh instance (`key` change).
  const loadOmnigraph = useCallback(() => {
    setSelection([]);
    setPendingIsolate(false);
    setDragNote(null);
    setError(null);
    setMeter(null);
    resetOmnigraphState();
    setExcludedClusters(EMPTY_CLUSTER_SET);
    setMode((m) => ({
      kind: 'omnigraph',
      runId: m.kind === 'omnigraph' ? m.runId + 1 : 1,
      form: ogForm,
    }));
  }, [ogForm, resetOmnigraphState]);

  useEffect(() => {
    if (mode.kind !== 'omnigraph') return undefined;
    const handle = graphRef.current;
    if (handle === null) return undefined;
    const controller = new AbortController();
    const started = performance.now();
    setOgMeter({ phase: 'loading', lines: 0, nodes: 0, edges: 0, bytes: 0, elapsedMs: 0 });
    setExcludedTypes(EMPTY_TYPE_SET);
    runOmnigraphLoad(
      handle,
      mode.form,
      (p) => {
        if (!controller.signal.aborted) {
          setOgMeter({ phase: 'loading', ...p, elapsedMs: performance.now() - started });
        }
      },
      controller.signal,
    )
      .then(({ result, nodeById: loaded }) => {
        if (controller.signal.aborted) return;
        setOgResult(result);
        setOgNodes(loaded);
        setOgMeter({
          phase: 'committed',
          ...result.counts,
          elapsedMs: performance.now() - started,
        });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setOgError(err instanceof Error ? err.message : String(err));
        setOgMeter((m) => (m === null ? null : { ...m, phase: 'error' }));
      });
    return () => {
      controller.abort(); // aborts the HTTP stream AND the session (loader)
    };
  }, [mode]);

  // --- CSV drop (prepared-data lane; see csvDrop.tsx) ----------------
  // Preparation runs BEFORE the mode flips: only a successful PreparedGraph
  // swaps the dataset (a bad file leaves the running graph untouched). The
  // mode change remounts <Graph> (`key`) — the previous mode may have been a
  // replace-session stream, and a fresh instance takes the declarative
  // prepared snapshot without racing it.
  const csvBusyRef = useRef(false);
  const onCsvFile = useCallback(
    (file: File) => {
      if (csvBusyRef.current) return; // one prepare at a time
      csvBusyRef.current = true;
      setCsvError(null);
      loadCsvEdgesFile(file)
        .then((result) => {
          setSelection([]);
          setPendingIsolate(false);
          setDragNote(null);
          setError(null);
          setMeter(null);
          resetOmnigraphState();
          setExcludedClusters(EMPTY_CLUSTER_SET);
          setExcludedTypes(EMPTY_TYPE_SET);
          setMode((m) => ({ kind: 'csv', runId: m.kind === 'csv' ? m.runId + 1 : 1, result }));
        })
        .catch((err: unknown) => {
          setCsvError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          csvBusyRef.current = false;
        });
    },
    [resetOmnigraphState],
  );

  // --- M5 semantic mode -----------------------------------------------
  // Same remount discipline as every other mode switch (`graphKey`): the M5
  // lanes (groups/clusters/pins) start on a fresh instance, which also lets
  // this mode run a FIXED layout while the others stay on force.
  const enterSemantic = useCallback(
    (layout: M5Layout) => {
      setSelection([]);
      setPendingIsolate(false);
      setDragNote(null);
      setError(null);
      setMeter(null);
      resetOmnigraphState();
      setCsvError(null);
      setExcludedClusters(EMPTY_CLUSTER_SET);
      setExcludedTypes(EMPTY_TYPE_SET);
      setM5Groups(M5_MANUAL_GROUPS);
      setM5Pinned([]);
      setM5MetaEvent(null);
      setM5SimGravity(null);
      setMode((m) => ({
        kind: 'semantic',
        runId: m.kind === 'semantic' ? m.runId + 1 : 1,
        layout,
      }));
    },
    [resetOmnigraphState],
  );

  const enterSemanticDefault = useCallback(() => enterSemantic('fixed'), [enterSemantic]);

  /** groups slice: the M5 `groups` prop is CONTROLLED, so op intents
   * arrive here and this is the write. groupBy re-derivations fire the same
   * callback as a NOTIFICATION — they must never be reflected back into the
   * manual array, hence the mode guard. */
  const m5GroupingRef = useRef(m5Grouping);
  m5GroupingRef.current = m5Grouping;
  const onGroupsChange = useCallback((groups: readonly ResolvedGroup[]) => {
    if (m5GroupingRef.current !== 'manual') return;
    setM5Groups(toGroupSpecs(groups));
  }, []);

  /** persistent-pin slice: same controlled reflect-the-intent lane. */
  const onPinnedChange = useCallback((pinnedNodeIds: readonly NodeId[]) => {
    setM5Pinned(pinnedNodeIds);
  }, []);

  /** super-node / meta-edge hits carry the GROUP payloads, never
   * caller node/edge objects. */
  const onGroupClick = useCallback((payload: { group: ResolvedGroup }) => {
    setM5MetaEvent(metaEventText(payload));
  }, []);
  const onMetaEdgeClick = useCallback((payload: { metaEdge: MetaEdge }) => {
    setM5MetaEvent(metaEventText(payload));
  }, []);

  /** path pair from <GraphContextMenu> → the ref API. Direction
   * 'either' matches the fixture's undirected reading; a null result is a
   * RESULT (unreachable), not an error. */
  const m5FindPath = useCallback((sourceId: NodeId, targetId: NodeId) => {
    void graphRef.current
      ?.findPath(sourceId, targetId, { direction: 'either' })
      .then(() => setM5PathTick((t) => t + 1))
      .catch(() => setM5PathTick((t) => t + 1));
  }, []);

  const m5ClearPath = useCallback(() => {
    graphRef.current?.clearPath();
    setM5PathTick((t) => t + 1);
  }, []);

  /** The controlled owner writing the whole array at once — the one op the
   * per-group context-menu item cannot batch (each intent is computed from
   * the array the instance last saw). */
  const m5ExpandAllGroups = useCallback(() => {
    setM5Groups((specs) => specs.map((s) => ({ ...s, collapsed: false })));
  }, []);

  const m5OnLayoutChange = useCallback(
    (layout: M5Layout) => {
      setMode((m) =>
        m.kind === 'semantic' && m.layout !== layout
          ? { kind: 'semantic', runId: m.runId + 1, layout }
          : m,
      );
      setM5Groups(M5_MANUAL_GROUPS);
      setM5Pinned([]);
    },
    [],
  );

  const m5OnSimulationChange = useCallback((next: SimulationConfig) => {
    setM5SimGravity(next.gravity ?? null);
  }, []);

  // parallel-edge grouping has no <Graph> prop — it rides the host
  // update lane directly (the toggle is a scene rewrite, not a config flag).
  useEffect(() => {
    if (mode.kind !== 'semantic') return;
    graphRef.current?.instance.applyHostUpdate({ parallelEdgeGrouping: m5Parallel });
  }, [mode, m5Parallel]);

  // --- result contract: the demo shows the last unavailable reason in
  // the status bar (search NEVER mutates scope/filters behind the user). ---
  const onSearchUnavailable = useCallback(
    (result: SearchResult, reason: SearchUnavailableReason) => {
      setSearchNote(`${result.label ?? result.id}: ${reason}`);
    },
    [],
  );

  const toggleInspector = useCallback(() => setInspectorOpen((v) => !v), []);

  // --- isolate: hard-scope to one cluster's nodes ---
  // Selection is CONTROLLED, so the flow is: write the cluster ids into React
  // state (the prop applies them to the store during this commit's layout
  // effects), then isolateSelection from a passive effect — which runs
  // after, so the store selection is already in place.
  const isolateCluster = useCallback(() => {
    // Only generated data has clusters to scope to (omnigraph/csv do not).
    if (mode.kind !== 'declarative' && mode.kind !== 'stream') return;
    const ids =
      mode.kind === 'stream'
        ? streamClusterNodeIds(streamRows, 0)
        : snapshot.nodes.filter((n) => n.attrs?.cluster === 0).map((n) => n.id);
    if (ids.length === 0) return;
    setSelection(ids);
    setPendingIsolate(true);
  }, [mode, streamRows, snapshot]);

  useEffect(() => {
    if (!pendingIsolate) return;
    setPendingIsolate(false);
    graphRef.current?.isolateSelection();
  }, [pendingIsolate]);

  // --- selection algebra: imperative calls emit intents; the
  // controlled owner (React state) applies them via onSelectionChange. ---
  const selectAll = useCallback(() => graphRef.current?.selectAll(), []);
  const unpinAll = useCallback(() => {
    graphRef.current?.clearPins();
    setDragNote(null);
  }, []);

  // --- context-loss drills ---
  const loseExtRef = useRef<WEBGL_lose_context | null>(null);
  const loseContext = useCallback((restoreAfterMs: number | null) => {
    // Scoped to the engine host — the minimap adds a second (2D) canvas.
    const canvas = document.querySelector<HTMLCanvasElement>('[data-orbit-canvas] canvas');
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
    const ext = gl?.getExtension('WEBGL_lose_context') ?? loseExtRef.current;
    if (!ext) return;
    loseExtRef.current = ext;
    if (gl?.isContextLost()) {
      ext.restoreContext();
      return;
    }
    ext.loseContext();
    if (restoreAfterMs !== null) setTimeout(() => ext.restoreContext(), restoreAfterMs);
  }, []);
  const simulateGpuReset = useCallback(() => loseContext(1500), [loseContext]);
  const killContext = useCallback(() => loseContext(null), [loseContext]);

  // --- interaction → controlled selection ---
  const onSelectionChange = useCallback(
    (payload: { nodeIds: readonly NodeId[] }) => setSelection(payload.nodeIds),
    [],
  );
  const onBackgroundClick = useCallback(() => setSelection([]), []);
  const onEdgeClick = useCallback(
    ({ edge }: { edge: AcceptedEdge<AppEdgeAttrs> }) => setSelection([edge.source, edge.target]),
    [],
  );
  const onNodeDragStart = useCallback(({ node }: { node: GraphNode<AppNodeAttrs> }) => {
    setDragNote(`dragging ${labelOf(node)}…`);
  }, []);
  const onNodeDragEnd = useCallback(
    ({ node, x, y }: { node: GraphNode<AppNodeAttrs>; x: number; y: number }) => {
      setDragNote(`pinned ${labelOf(node)} @ ${x.toFixed(0)}, ${y.toFixed(0)}`);
    },
    [],
  );
  const onError = useCallback(({ error: err }: { error: Error }) => setError(err.message), []);

  /** durable source coordinate. Regenerating or adding nodes changes
   * it, which is exactly what makes a stale share-link trip the mismatch
   * gate instead of restoring over different data. Declarative mode only in
   * this demo — other modes share fine but without mismatch protection. */
  const dataRef = useMemo(
    () =>
      mode.kind === 'declarative'
        ? { mode: 'declarative', datasetKey: gen.datasetKey, seed: gen.seed, nodes: gen.nodes, revision: gen.revision }
        : undefined,
    [mode.kind, gen],
  );

  /** aggregate reflection: selection is this app's ONE controlled
   * lane, so the intent reduces to reflecting it in one commit. */
  const onViewStateRestore = useCallback((intent: { next: unknown }) => {
    const next = intent.next as { selection?: { nodeIds?: readonly string[] } };
    setSelection([...(next.selection?.nodeIds ?? [])]);
  }, []);

  /** Share the current view: ?view= in the URL bar + clipboard best-effort. */
  const shareView = useCallback(() => {
    const handle = graphRef.current;
    if (handle === null) return;
    const state = handle.getViewState();
    const url = new URL(window.location.href);
    url.searchParams.set('view', JSON.stringify(state));
    // Deep-links are for HUMAN-scale state. A pathological state (say, all
    // 3,000 nodes selected) produces a URL the dev server rejects outright
    // (431) — so past a sane bound, clipboard-only and say so. Bulk state
    // belongs to the export lane, not the URL bar.
    const text = url.toString();
    if (text.length <= 8000) {
      window.history.replaceState(null, '', url);
      setShareNote('link ready');
    } else {
      setShareNote('state too large for the URL bar — copied to clipboard only');
    }
    void navigator.clipboard?.writeText(text).catch(() => {});
    window.setTimeout(() => setShareNote(null), 4000);
  }, []);

  /** exports. Each mirrors its output onto window.__lastExport (the
   * e2e observability hook) and triggers a real download. The ?svgcap= param
   * lets the e2e drive the too-large path deterministically. */
  const downloadBlob = useCallback((name: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, []);

  const exportSvg = useCallback(() => {
    const handle = graphRef.current;
    if (handle === null) return;
    const cap = Number(new URLSearchParams(window.location.search).get('svgcap') ?? '');
    void handle
      .exportImage('svg', Number.isFinite(cap) && cap > 0 ? { maxSvgElements: cap } : undefined)
      .then((svg) => {
        window.__lastExport = { kind: 'svg', text: svg };
        downloadBlob('orbit-graph.svg', new Blob([svg], { type: 'image/svg+xml' }));
      })
      .catch((err: Error) => {
        window.__lastExport = { kind: 'svg', text: '', error: err.message };
        setError(err.message);
      });
  }, [downloadBlob]);

  const exportJsonl = useCallback(() => {
    const handle = graphRef.current;
    if (handle === null) return;
    void (async () => {
      const lines: string[] = [];
      for await (const line of handle.exportDataStream('visible')) lines.push(line);
      const text = lines.join('');
      window.__lastExport = { kind: 'jsonl', text, lines: lines.length };
      downloadBlob('orbit-data.jsonl', new Blob([text], { type: 'application/x-ndjson' }));
    })().catch((err: Error) => {
      window.__lastExport = { kind: 'jsonl', text: '', error: err.message };
      setError(err.message);
    });
  }, [downloadBlob]);

  /** Restore a ?view= deep-link once the instance is READY (camera and
   * engine lanes need a mounted engine; the acceptance queue orders us
   * after the initial data commit). */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || mode.kind !== 'declarative') return undefined;
    const param = new URLSearchParams(window.location.search).get('view');
    if (param === null) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(param);
    } catch {
      restoredRef.current = true;
      return undefined; // hostile URL: the instance-side validator is the gate
    }
    const instance = graphRef.current?.instance;
    if (instance === undefined) return undefined;
    const attempt = (): void => {
      if (restoredRef.current) return;
      const st = instance.store.getState();
      // Gate on the FIRST viewport event, not just readiness: the mount-time
      // fitView animation lands asynchronously after 'ready', and restoring
      // the camera before it means the fit clobbers the restored viewport a
      // beat later. Once a viewport has been published, the fit is done and
      // the restored camera wins.
      if (st.status !== 'ready' || st.viewport === null) return;
      restoredRef.current = true;
      void instance.setViewState(raw).then((result) => {
        if (result.status === 'mismatch') setMismatchRaw(raw);
      });
    };
    attempt();
    const unsubscribe = instance.store.subscribe(attempt);
    return unsubscribe;
  }, [mode.kind]);

  const restoreAnyway = useCallback(() => {
    const raw = mismatchRaw;
    setMismatchRaw(null);
    if (raw === null) return;
    void graphRef.current?.instance.setViewState(raw, { ignoreMismatch: true });
  }, [mismatchRaw]);

    const graphKey =
    mode.kind === 'stream'
      ? `stream-${mode.seed}`
      : mode.kind === 'omnigraph'
        ? `omnigraph-${mode.runId}`
        : mode.kind === 'csv'
          ? `csv-${mode.runId}`
          : mode.kind === 'semantic'
            ? `semantic-${mode.runId}-${mode.layout}`
            : 'declarative';
  // fold counts mirrored from `store.folds`, re-subscribed per remount.
  // `graphKey` is the dependency, not `[]`: a mode switch REMOUNTS <Graph>
  // through that key, so the ref points at a NEW instance and a one-shot
  // subscription would keep listening to the dead one — folds on the
  // replacement graph would hide nodes with no badge to show for it.
  useEffect(() => {
    const instance = graphRef.current?.instance;
    if (instance === undefined) return undefined;
    const sync = (): void => setFoldCounts(instance.store.getState().folds);
    sync();
    return instance.store.subscribe(sync);
  }, [graphKey]);
  const semantic = mode.kind === 'semantic';
  const streaming = meter !== null && meter.phase === 'streaming';
  // In stream mode the cluster ids exist only once the replace committed;
  // omnigraph data has no generated clusters at all.
  const canIsolateCluster =
    mode.kind === 'declarative' || (mode.kind === 'stream' && meter?.phase === 'committed');

  return (
    <div
      style={{ ...S.appRoot, ...S.themeVars(themeBase) }}
      data-theme={themeBase}
      data-testid="app-root"
    >
      <style>{BUTTON_CSS}</style>
      {mismatchRaw !== null && (
        <div data-testid="view-mismatch-banner" style={S.mismatchBanner}>
          This view was saved over different data — restoring it may not show what the sender saw.
          <button style={S.mismatchButton} data-testid="restore-anyway" onClick={restoreAnyway}>
            Restore anyway
          </button>
          <button style={S.mismatchButton} onClick={() => setMismatchRaw(null)}>
            Dismiss
          </button>
        </div>
      )}
      <Graph<AppNodeAttrs, AppEdgeAttrs>
        key={graphKey}
        ref={graphRef}
        engine={engineFactory}
        {...(mode.kind === 'declarative'
          ? { data: snapshot }
          : mode.kind === 'csv' && csvSnapshot !== null
            ? { data: csvSnapshot }
            : semantic
              ? { data: semanticSnapshot }
              : null)}
        nodeColor={nodeColorProp}
        nodeSize={nodeSizeProp}
        linkColor={themeBase === 'dark' ? LINK_COLOR : LINK_COLOR_LIGHT}
        linkWidth={1}
        edgeArrows={edgeArrows}
        showLinks={showLinks}
        layout={mode.kind === 'semantic' ? mode.layout : 'force'}
        simulation={
          mode.kind === 'semantic'
            ? mode.layout === 'fixed'
              ? M5_FROZEN_SIMULATION
              : M5_SIMULATION
            : SIMULATION
        }
        theme={themeBase === 'dark' ? DARK_THEME : LIGHT_THEME}
        filter={filter}
        crossfilter={
          mode.kind === 'omnigraph'
            ? OG_CROSSFILTER_DIMS
            : semantic
              ? M5_CROSSFILTER_DIMS
              : CROSSFILTER_DIMS
        }
        labels={
          mode.kind === 'omnigraph' || mode.kind === 'csv'
            ? OG_LABELS
            : semantic
              ? M5_LABELS
              : LABELS
        }
        // The badge reads the published `store.folds` slice, NOT getFold:
        // a fold changes no id and no label text, so the label lane would
        // never re-render a ref-read badge. Threading the slice through state
        // is what keeps it live.
        renderNodeLabel={({ node, text }) =>
          renderPillLabel(text, showLabelType, foldCounts.get(node.id) ?? 0)
        }
        // The manual and derived grouping lanes are mutually exclusive,
        // so the radio drives exactly one of them non-null.
        // Outside semantic mode neither lane is stated (omission = no change).
        {...(semantic
          ? {
              groups: m5Grouping === 'manual' ? m5Groups : null,
              groupBy: m5Grouping === 'derived' ? M5_GROUP_BY : null,
              clusters: m5Clusters ? M5_CLUSTER_SPEC : null,
              pinnedNodeIds: m5Pinned,
            }
          : null)}
        onGroupsChange={onGroupsChange}
        onPinnedChange={onPinnedChange}
        onGroupClick={onGroupClick}
        onMetaEdgeClick={onMetaEdgeClick}
        accessibility={ACCESSIBILITY}
        searchIndex={mode.kind === 'omnigraph' ? OG_SEARCH_INDEX : SEARCH_INDEX}
        onSearchResultUnavailable={onSearchUnavailable}
        // The FIXED M5 layout states its own camera (M5_HOME_VIEW) once the
        // engine is live, so the mount-time fit — a heuristic over whatever the
        // engine holds at that instant — must not race it. Every other mode
        // (the M5 force variant included, where the sim owns positions) keeps
        // the fit. Construction-only; the mode's key remount is what makes the
        // per-instance value take effect.
        fitViewOnFirstData={!(mode.kind === 'semantic' && mode.layout === 'fixed')}
        selection={selection}
        {...(dataRef !== undefined ? { dataRef } : {})}
        onViewStateRestore={onViewStateRestore}
        enableLasso
        onSelectionChange={onSelectionChange}
        onBackgroundClick={onBackgroundClick}
        onEdgeClick={onEdgeClick}
        onNodeDragStart={onNodeDragStart}
        onNodeDragEnd={onNodeDragEnd}
        onError={onError}
        style={S.graphStyle}
      >
        <div style={S.overlayRoot}>
          <div style={S.topRow}>
            <div style={S.headerColumn}>
              {/* FIRST in DOM (Tab reaches its toggle first); CSS `order`
                  renders it below the header + Data panel. */}
              <NavigatorSection />
              <header style={S.headerPanel}>
                <span style={S.title}>orbit demo</span>
                <HeaderCounts />
              </header>
              <DataPanel
                streaming={streaming}
                canIsolateCluster={canIsolateCluster}
                meter={meter}
                streamRows={streamRows}
                onStreamFeed={streamFeed}
                onExportSvg={exportSvg}
                onExportJsonl={exportJsonl}
                onIsolateCluster={isolateCluster}
                onSemanticMode={enterSemanticDefault}
                ogForm={ogForm}
                onOgFormChange={setOgForm}
                ogMeter={ogMeter}
                ogResult={ogResult}
                ogError={ogError}
                onOgLoad={loadOmnigraph}
              />
              <FiltersPanel
                clusterCount={clusterCount}
                excluded={excludedClusters}
                onToggleCluster={toggleCluster}
                types={ogTypes}
                excludedTypes={excludedTypes}
                onToggleType={toggleType}
                mode={filterMode}
                onModeChange={setFilterMode}
              />
              <StylePanel
                themeBase={themeBase}
                onThemeBaseChange={setThemeBase}
                colorMode={colorMode}
                onColorModeChange={setColorMode}
                sizeMode={sizeMode}
                onSizeModeChange={setSizeMode}
                edgeArrows={edgeArrows}
                onEdgeArrowsChange={setEdgeArrows}
                showLinks={showLinks}
                onShowLinksChange={setShowLinks}
                showLabelType={showLabelType}
                onShowLabelTypeChange={setShowLabelType}
              />
              {/* M5 controls — mounted only in the semantic mode, whose
                  fixture and lanes they drive. */}
              {mode.kind === 'semantic' && (
                <SemanticPanel
                  layout={mode.layout}
                  onLayoutChange={m5OnLayoutChange}
                  grouping={m5Grouping}
                  onGroupingChange={setM5Grouping}
                  clusters={m5Clusters}
                  onClustersChange={setM5Clusters}
                  parallelEdges={m5Parallel}
                  onParallelEdgesChange={setM5Parallel}
                  onExpandAllGroups={m5ExpandAllGroups}
                  onClearPath={m5ClearPath}
                />
              )}
              {/* CSV drop lane: drop overlay + hidden-input seam. */}
              <CsvDropZone
                summary={mode.kind === 'csv' ? mode.result.summaryLine : null}
                error={csvError}
                onFile={onCsvFile}
              />
            </div>
            <div style={S.toolbarColumn}>
              <div style={S.toolbarRow}>
                {/* Packaged camera/sim toolbar replaces the hand-rolled
                    Fit/Zoom buttons; data + GPU drills stay custom. */}
                <GraphToolbar style={S.embeddedOverlay} />
                <div style={S.toolbar}>
                  <ToolButton onClick={regenerate}>Regenerate</ToolButton>
                  <ToolButton onClick={addNodes}>Add 500 nodes</ToolButton>
                  <ToolButton onClick={simulateGpuReset}>Simulate GPU reset</ToolButton>
                  <ToolButton onClick={killContext}>Kill context</ToolButton>
                </div>
              </div>
              <div style={S.toolbar}>
                <ToolButton onClick={selectAll}>Select all</ToolButton>
                <ToolButton onClick={unpinAll}>Unpin all</ToolButton>
                <ToolButton testId="inspector-toggle" onClick={toggleInspector}>
                  {inspectorOpen ? 'Hide inspector' : 'Inspector'}
                </ToolButton>
                <ToolButton testId="share-view" onClick={shareView}>
                  Share view
                </ToolButton>
                {shareNote !== null && <span style={S.toolbarHintText}>{shareNote}</span>}
                <span style={S.toolbarHintText}>pin mode: drag a node to pin it</span>
              </div>
              {/* Renders only while the selection is non-empty. */}
              <GraphSelectionActions style={S.embeddedOverlay} />
            </div>
          </div>

          {/* Search box: top-center, collapsible. AFTER the top row
              in DOM so the navigator toggle stays the first tabbable. */}
          <SearchSection omnigraph={mode.kind === 'omnigraph'} />

          {error !== null && <div style={S.errorBanner}>engine error: {error}</div>}

          {/* The docked inspector replaces the workbench sidebar while open;
              in M5 mode the semantic dock (table + sim controls) owns the
              right edge instead — all three live below the toolbar rows. */}
          {inspectorOpen ? (
            <GraphInspector dock="right" style={S.inspectorOverride} />
          ) : mode.kind === 'semantic' ? (
            <SemanticDock
              layout={mode.layout}
              onSimulationChange={m5OnSimulationChange}
              pathTick={m5PathTick}
              metaEvent={m5MetaEvent}
              simGravity={m5SimGravity}
            />
          ) : (
            <WorkbenchSidebar nodeById={nodeById} dragNote={dragNote} />
          )}

          <div style={S.bottomStack}>
            {/* Right float column: the minimap above the
                legends, both floating over the canvas at the right edge.
                Categorical legend rows click through to the demo's own
                filter state (host-owned filtering); the size legend
                appears only when nodeSize is a Scale. Suppressed in M5 mode:
                the semantic dock claims the same edge. */}
            {!semantic && <div style={S.rightFloatStack}>
              <div style={S.minimapWrap} data-testid="minimap-panel">
                <GraphMinimap size={180} style={S.embeddedOverlay} />
              </div>
              <div style={S.legendRow}>
                {sizeMode === 'scale' && (
                  <div style={S.legendWrap} data-testid="legend-panel-size">
                    <GraphLegend channel="nodeSize" style={S.embeddedOverlay} />
                  </div>
                )}
                <div style={S.legendWrap} data-testid="legend-panel">
                  <GraphLegend
                    excludedValues={legendExcluded}
                    onCategoryClick={onLegendCategoryClick}
                    style={S.embeddedOverlay}
                  />
                </div>
              </div>
            </div>}
            {/* Chart strip: histogram + timeline sit ABOVE the status bar
                (no overlap), collapsible via the small toggle. */}
            <div style={S.chartsToggleRow}>
              <ToolButton testId="charts-toggle" onClick={toggleCharts}>
                {chartsOpen ? 'Hide charts' : 'Show charts'}
              </ToolButton>
            </div>
            {chartsOpen && (
              <div style={S.chartStrip} data-testid="chart-strip">
                <div style={S.chartPanel} data-testid="histogram-panel">
                  <GraphHistogram dimension={mode.kind === 'omnigraph' ? 'domain' : 'score'} />
                </div>
                <TimelinePanel />
              </div>
            )}
            <div style={S.bottomRow}>
              <StatusBar nodeById={nodeById} searchNote={searchNote} />
              <footer style={S.hint}>
                shift+drag: lasso · meta+click: toggle · click background: clear ·
                right-click: menu · drag/scroll: pan &amp; zoom
              </footer>
            </div>
          </div>
          <PerfProbe />
        </div>
        {/* hover card: its own pointer-inert layer over the canvas.
            Serves BOTH hover namespaces — a hovered edge titles its card with
            the relationship name rather than the raw synthesized id. */}
        <GraphTooltip getEdgeText={edgeLabelOf} />
        {/* After the overlay root in DOM so the menu paints above it; it
            positions itself at the event's container-relative coords. M5 mode
            swaps in the same component with the group items and the
            find-path pair wired to the ref API. */}
        {mode.kind === 'semantic' ? (
          <SemanticContextMenu onFindPath={m5FindPath} />
        ) : (
          <GraphContextMenu />
        )}
      </Graph>
    </div>
  );
}

// --- overlay components (hooks require being under <Graph>'s provider) ------

/** Store-slice number subscription (local demo hook; module-scope selectors). */
function useStoreNumber(select: (s: GraphStoreState) => number): number {
  const instance = useGraphInstance();
  const subscribe = useCallback(
    (onChange: () => void) => instance.store.subscribe(onChange),
    [instance],
  );
  const selectRef = useRef(select);
  selectRef.current = select;
  const getSnapshot = useCallback(
    () => selectRef.current(instance.store.getState()),
    [instance],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Nodes visible in the current render scope (never more than the accepted model count). */
function useVisibleNodeCount(): number {
  const instance = useGraphInstance();
  const subscribe = useCallback(
    (onChange: () => void) => instance.store.subscribe(onChange),
    [instance],
  );
  const getSnapshot = useCallback(() => instance.getVisibleNodeIds().length, [instance]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Accepted-model counts from the store — correct in BOTH data modes (the
 * streamed replace session never flows through the snapshot state). */
function HeaderCounts() {
  const nodeCount = useStoreNumber(selectNodeCount);
  const edgeCount = useStoreNumber(selectEdgeCount);
  return (
    <span style={S.counts}>
      <span data-testid="node-count">{nodeCount.toLocaleString('en-US')}</span> nodes ·{' '}
      <span data-testid="edge-count">{edgeCount.toLocaleString('en-US')}</span> edges
    </span>
  );
}

/** Data panel: stream feed, isolate cluster, reset scope, live meter
 * plus the v0.6 Omnigraph section. */
function DataPanel({
  streaming,
  canIsolateCluster,
  meter,
  streamRows,
  onStreamFeed,
  onExportSvg,
  onExportJsonl,
  onIsolateCluster,
  onSemanticMode,
  ogForm,
  onOgFormChange,
  ogMeter,
  ogResult,
  ogError,
  onOgLoad,
}: {
  streaming: boolean;
  canIsolateCluster: boolean;
  meter: StreamProgress | null;
  streamRows: number;
  onStreamFeed: () => void;
  onExportSvg: () => void;
  onExportJsonl: () => void;
  onIsolateCluster: () => void;
  /** Enter the M5 semantic-exploration mode (clustered fixture). */
  onSemanticMode: () => void;
  ogForm: OmnigraphFormState;
  onOgFormChange: (form: OmnigraphFormState) => void;
  ogMeter: OmnigraphMeter | null;
  ogResult: OmnigraphLoadResult | null;
  ogError: string | null;
  onOgLoad: () => void;
}) {
  const instance = useGraphInstance();
  const scope = useGraphScope();
  const resetScope = useCallback(() => {
    instance.resetIsolation();
  }, [instance]);

  return (
    <section style={S.dataPanel} data-testid="data-panel" aria-label="Data">
      <div style={S.dataPanelTitle}>data</div>
      <div style={S.dataPanelRow}>
        <ToolButton testId="stream-feed" onClick={onStreamFeed} disabled={streaming}>
          Stream {fmtRows(streamRows)} feed
        </ToolButton>

        <ToolButton
          testId="isolate-cluster"
          onClick={onIsolateCluster}
          disabled={!canIsolateCluster}
        >
          Isolate cluster
        </ToolButton>
        {scope !== null && (
          <ToolButton testId="reset-scope" onClick={resetScope}>
            Reset scope
          </ToolButton>
        )}
        <ToolButton testId="semantic-mode" onClick={onSemanticMode}>
          M5 semantic
        </ToolButton>
      </div>
      {/* exports on their OWN row: widening the stream row pushed the
          translucent panel into the M5 screenshot clip (x=380) and its blur
          backdrop turned path-emphasis diffs into pixel noise. */}
      <div style={S.dataPanelRow}>
        <ToolButton testId="export-svg" onClick={onExportSvg}>
          Export SVG
        </ToolButton>
        <ToolButton testId="export-jsonl" onClick={onExportJsonl}>
          Export JSONL
        </ToolButton>
      </div>
      {meter !== null && (
        <div style={S.streamMeter} data-testid="stream-meter" data-phase={meter.phase}>
          <span style={S.statusMuted}>rows</span>
          <span style={S.streamMeterValue} data-testid="stream-rows">
            {meter.rows.toLocaleString('en-US')}
          </span>
          <span style={S.statusMuted}>batches</span>
          <span style={S.streamMeterValue} data-testid="stream-batches">
            {meter.batches.toLocaleString('en-US')}
          </span>
          <span style={S.statusMuted}>pending</span>
          <span style={S.streamMeterValue} data-testid="stream-pending-bytes">
            {fmtBytes(meter.pendingBytes)}
          </span>
          <span style={S.statusMuted}>elapsed</span>
          <span style={S.streamMeterValue} data-testid="stream-elapsed">
            {(meter.elapsedMs / 1000).toFixed(1)}s
          </span>
          <span style={S.statusMuted}>state</span>
          <span style={S.streamMeterValue} data-testid="stream-state">
            {meter.phase}
          </span>
        </div>
      )}
      <OmnigraphPanel
        form={ogForm}
        onFormChange={onOgFormChange}
        meter={ogMeter}
        result={ogResult}
        error={ogError}
        onLoad={onOgLoad}
      />
    </section>
  );
}

/** Filters panel: per-cluster checkboxes drive the `filter` prop
 * (hide/dim), the visible line reads the store's hide-lane counts, and
 * Undo/Redo walk the history kernel (depths gate the buttons). */
function FiltersPanel({
  clusterCount,
  excluded,
  onToggleCluster,
  types,
  excludedTypes,
  onToggleType,
  mode,
  onModeChange,
}: {
  clusterCount: number;
  excluded: ReadonlySet<number>;
  onToggleCluster: (cluster: number) => void;
  /** Omnigraph mode: injected node types driving a type filter. */
  types: readonly string[];
  excludedTypes: ReadonlySet<string>;
  onToggleType: (t: string) => void;
  mode: FilterMode;
  onModeChange: (mode: FilterMode) => void;
}) {
  const instance = useGraphInstance();
  const visible = useGraphVisible();
  const history = useGraphHistory();
  const nodeCount = useStoreNumber(selectNodeCount);
  const undo = useCallback(() => {
    instance.undo();
  }, [instance]);
  const redo = useCallback(() => {
    instance.redo();
  }, [instance]);

  return (
    <section style={S.filtersPanel} data-testid="filters-panel" aria-label="Filters">
      <div style={S.dataPanelTitle}>filters</div>
      {clusterCount > 0 ? (
        <div style={S.filterClusterGrid}>
          {Array.from({ length: clusterCount }, (_, c) => (
            <label key={c} style={S.filterCheckLabel}>
              <input
                type="checkbox"
                data-testid={`cluster-check-${c}`}
                checked={!excluded.has(c)}
                onChange={() => onToggleCluster(c)}
              />
              <span style={{ ...S.chip, background: clusterColor(c) }} />
              {clusterName(c)}
            </label>
          ))}
        </div>
      ) : types.length > 0 ? (
        <div style={S.filterClusterGrid}>
          {types.map((t) => (
            <label key={t} style={S.filterCheckLabel}>
              <input
                type="checkbox"
                data-testid={`type-check-${t}`}
                checked={!excludedTypes.has(t)}
                onChange={() => onToggleType(t)}
              />
              <span style={{ ...S.chip, background: typeColor(t) }} />
              {t}
            </label>
          ))}
        </div>
      ) : (
        <span style={S.statusMuted}>no filterable attrs in this data mode</span>
      )}
      <div style={S.filterModeRow} role="radiogroup" aria-label="Filter mode">
        <span style={S.statusMuted}>mode</span>
        {(['hide', 'dim'] as const).map((m) => (
          <label key={m} style={S.filterCheckLabel}>
            <input
              type="radio"
              name="filter-mode"
              data-testid={`filter-mode-${m}`}
              checked={mode === m}
              onChange={() => onModeChange(m)}
            />
            {m}
          </label>
        ))}
      </div>
      {/* Hide-lane visibility: dim survivors still COUNT as visible. */}
      <div style={S.filterVisibleLine}>
        visible <span data-testid="visible-nodes">{visible.nodes.toLocaleString('en-US')}</span> of{' '}
        <span data-testid="visible-total">{nodeCount.toLocaleString('en-US')}</span>
      </div>
      <div style={S.dataPanelRow}>
        <ToolButton testId="undo" onClick={undo} disabled={history.undoDepth === 0}>
          Undo
        </ToolButton>
        <ToolButton testId="redo" onClick={redo} disabled={history.redoDepth === 0}>
          Redo
        </ToolButton>
      </div>
    </section>
  );
}

/** Style panel: theme base toggle, nodeColor/nodeSize channel modes
 * (accessor vs Scale), plus the edgeArrows and showLinks
 * toggles. Pure controlled inputs — all state lives in <App>. */
function StylePanel({
  themeBase,
  onThemeBaseChange,
  colorMode,
  onColorModeChange,
  sizeMode,
  onSizeModeChange,
  edgeArrows,
  onEdgeArrowsChange,
  showLinks,
  onShowLinksChange,
  showLabelType,
  onShowLabelTypeChange,
}: {
  themeBase: ThemeBase;
  onThemeBaseChange: (base: ThemeBase) => void;
  colorMode: ColorMode;
  onColorModeChange: (mode: ColorMode) => void;
  sizeMode: SizeMode;
  onSizeModeChange: (mode: SizeMode) => void;
  edgeArrows: boolean;
  onEdgeArrowsChange: (on: boolean) => void;
  showLinks: boolean;
  onShowLinksChange: (on: boolean) => void;
  showLabelType: boolean;
  onShowLabelTypeChange: (on: boolean) => void;
}) {
  return (
    <section style={S.stylePanel} data-testid="style-panel" aria-label="Style">
      <div style={S.dataPanelTitle}>style</div>
      <div style={S.styleRow} role="radiogroup" aria-label="Theme">
        <span style={S.statusMuted}>theme</span>
        {(['dark', 'light'] as const).map((b) => (
          <label key={b} style={S.filterCheckLabel}>
            <input
              type="radio"
              name="theme-base"
              data-testid={`theme-${b}`}
              checked={themeBase === b}
              onChange={() => onThemeBaseChange(b)}
            />
            {b}
          </label>
        ))}
      </div>
      <label style={S.styleField}>
        <span style={S.statusMuted}>node color</span>
        <select
          data-testid="node-color-mode"
          style={S.select}
          value={colorMode}
          onChange={(e) => onColorModeChange(e.target.value as ColorMode)}
        >
          <option value="category">category</option>
          <option value="degree">degree ramp</option>
        </select>
      </label>
      <label style={S.styleField}>
        <span style={S.statusMuted}>node size</span>
        <select
          data-testid="node-size-mode"
          style={S.select}
          value={sizeMode}
          onChange={(e) => onSizeModeChange(e.target.value as SizeMode)}
        >
          <option value="accessor">degree accessor</option>
          <option value="scale">degree scale</option>
        </select>
      </label>
      <div style={S.styleRow}>
        <label style={S.filterCheckLabel}>
          <input
            type="checkbox"
            data-testid="label-show-type"
            checked={showLabelType}
            onChange={(e) => onShowLabelTypeChange(e.target.checked)}
          />
          show type on labels
        </label>
      </div>
      <div style={S.styleRow}>
        <label style={S.filterCheckLabel}>
          <input
            type="checkbox"
            data-testid="edge-arrows"
            checked={edgeArrows}
            onChange={(e) => onEdgeArrowsChange(e.target.checked)}
          />
          edge arrows
        </label>
        <label style={S.filterCheckLabel}>
          <input
            type="checkbox"
            data-testid="show-links"
            checked={showLinks}
            onChange={(e) => onShowLinksChange(e.target.checked)}
          />
          show links
        </label>
      </div>
    </section>
  );
}

/** Timeline cell of the chart strip. The wrapper stamps the store's playing
 * key as a data attribute so the e2e suite can assert playback state
 * without depending on the packaged component's internals. */
function TimelinePanel() {
  const timeline = useGraphTimeline();
  return (
    <div
      style={S.chartPanel}
      data-testid="timeline-panel"
      data-playing-key={timeline.playingKey ?? ''}
    >
      <GraphTimeline dimension="createdAt" />
    </div>
  );
}

// --- perf-lite instrumentation (dev-only, `?perf=1`) --------------------

interface OrbitPerfMark {
  render: number;
  applied: number | null;
  t: number;
}

interface OrbitPerfApi {
  /** One entry per render-revision publication (store subscribe cadence). */
  marks: OrbitPerfMark[];
  clear(): void;
  renderRevision(): number;
  appliedRenderRevision(): number | null;
  visibleNodes(): number;
  /** Scene roster size (scope applied, mask not) — the structural readout a
   * driver checks after a containment change. */
  sceneNodes(): number;
  /**
   * containment ops, exposed so a driver can exercise fold/unfold
   * WITHOUT canvas picking. GPU picking does not work under SwiftShader (the
   * limitation), so a headless driver cannot right-click a node to
   * reach the context menu — but the op underneath is the same one the menu
   * item calls.
   */
  foldNode(id: string): void;
  unfoldNode(id: string): void;
  getFold(id: string): { memberIds: readonly string[] } | null;
  /**
   * first-paint readout: `totalMs` is `performance.now()` at the FIRST
   * non-null appliedRender publication — i.e. navigation-start → first data
   * actually uploaded to the engine — and `phases` is the lastCommitMs
   * decomposition captured at that same moment. Null until it happens.
   */
  firstPaint(): { totalMs: number; phases: GraphPerfSnapshot['lastCommitMs'] } | null;
  /** The live snapshot (memory estimates, pressure, degradations)
   * recorded into perf-lite artifacts per run. */
  perfSnapshot(): GraphPerfSnapshot;
  /** idle/re-arm probe: park the sim so the driver can count rAF
   * registrations at rest at ANY tier (natural settle takes minutes at L),
   * then wake it to assert the ≥1-frame re-arm. */
  pauseSimulation(): void;
  resumeSimulation(): void;
}

declare global {
  interface Window {
    /** Registered ONLY in dev builds with `?perf=1` (scripts/perf-lite.mjs). */
    __orbitPerf?: OrbitPerfApi;
  }
}

/** Tiny dev-only hook for scripts/perf-lite.mjs: timestamps every
 * render-revision publication (`performance.now()` at store notification) so the
 * driver can measure brush→publish latency. Guarded twice — production
 * builds compile it out (`import.meta.env.DEV`) and dev serves it only under
 * `?perf=1`. */
function PerfProbe() {
  const instance = useGraphInstance();
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined;
    if (!new URLSearchParams(window.location.search).has('perf')) return undefined;
    const marks: OrbitPerfMark[] = [];
    let last = instance.store.getState().revisions.render;
    let firstPaint: { totalMs: number; phases: GraphPerfSnapshot['lastCommitMs'] } | null =
      null;
    const captureFirstPaint = () => {
      if (firstPaint !== null) return;
      firstPaint = {
        totalMs: performance.now(),
        phases: instance.getPerfSnapshot().lastCommitMs,
      };
    };
    // The initial declarative apply can beat this effect (mount ordering)
    // capture immediately if the first upload already happened.
    if (instance.store.getState().revisions.appliedRender !== null) captureFirstPaint();
    const unsubscribe = instance.store.subscribe(() => {
      const r = instance.store.getState().revisions;
      if (r.appliedRender !== null) captureFirstPaint();
      if (r.render === last) return;
      last = r.render;
      marks.push({ render: r.render, applied: r.appliedRender, t: performance.now() });
      if (marks.length > 10_000) marks.splice(0, 5_000); // bound the buffer
    });
    window.__orbitPerf = {
      marks,
      clear: () => {
        marks.length = 0;
      },
      renderRevision: () => instance.store.getState().revisions.render,
      appliedRenderRevision: () => instance.store.getState().revisions.appliedRender,
      visibleNodes: () => instance.store.getState().visible.nodes,
      sceneNodes: () => instance.getSceneNodeIds().length,
      foldNode: (id: string) => {
        instance.foldNode(id);
      },
      unfoldNode: (id: string) => {
        instance.unfoldNode(id);
      },
      getFold: (id: string) => instance.getFold(id),
      firstPaint: () => firstPaint,
      perfSnapshot: () => instance.getPerfSnapshot(),
      pauseSimulation: () => {
        instance.pauseSimulation();
      },
      resumeSimulation: () => {
        instance.resumeSimulation();
      },
    };
    return () => {
      unsubscribe();
      delete window.__orbitPerf;
    };
  }, [instance]);
  return null;
}

/** Omnigraph-mode result renderer: ids are `["Kind","source-id"]` JSON
 * tuples — raw, they read as noise. Decode to `Kind · label` (the indexed
 * field label when the match produced one, else the decoded source id).
 * Text nodes only — result content is untrusted. */
function renderOmnigraphResult(r: SearchResult): ReactNode {
  const decoded = decodeSourceId(r.id);
  const friendly =
    r.label !== undefined && r.label !== r.id ? r.label : (decoded?.sourceId ?? r.id);
  return (
    <>
      <span data-orbit-search-result-label="" style={S.searchResultText}>
        {decoded !== null && <span style={S.searchResultKind}>{decoded.kind} · </span>}
        {friendly}
      </span>
      {r.score !== undefined && (
        <span data-orbit-search-result-score="" style={S.searchResultScore}>
          {String(r.score)}
        </span>
      )}
    </>
  );
}

/** Top-center collapsible search box. Open by default; the toggle
 * collapses it to a single button. <GraphSearch> owns input/debounce/results
 * and falls back to the <Graph onSearchResultUnavailable> prop, so this
 * wrapper is pure chrome. */
function SearchSection({ omnigraph }: { omnigraph: boolean }) {
  const [open, setOpen] = useState(true);
  const panelId = useId();
  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div style={S.searchContainer}>
      <button
        type="button"
        className="demo-btn"
        style={S.searchToggle}
        data-testid="search-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        {open ? 'Hide search' : 'Search'}
      </button>
      {open && (
        <div id={panelId} style={S.searchPanel} data-testid="search-panel">
          <GraphSearch
            className="demo-search"
            placeholder="Search nodes…"
            {...(omnigraph ? { renderResult: renderOmnigraphResult } : {})}
          />
        </div>
      )}
    </div>
  );
}

/** Collapsible left panel hosting the <GraphNavigator>. Collapsed by
 * default; the toggle is the page's first tabbable element. */
function NavigatorSection() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div style={S.navigatorContainer}>
      <button
        type="button"
        className="demo-btn"
        style={S.button}
        data-testid="navigator-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        {open ? 'Hide navigator' : 'Show navigator'}
      </button>
      {open && (
        <div id={panelId} style={S.navigatorPanel}>
          <GraphNavigator />
        </div>
      )}
    </div>
  );
}

const STATUS_COLOR: Record<InstanceStatus, string> = {
  idle: '#8b949e',
  mounting: '#f2cc60',
  ready: '#3fb950',
  lost: '#f0883e',
  recovering: '#a371f7',
  destroyed: '#8b949e',
  error: '#f85149',
};

function StatusBar({
  nodeById,
  searchNote,
}: {
  nodeById: NodeMap;
  /** Last unavailable activation ("<label>: <reason>"), sticky. */
  searchNote: string | null;
}) {
  const status = useGraphStatus();
  const hoverId = useGraphHover();
  const edgeHoverId = useGraphEdgeHover();
  const selection = useGraphSelection();
  const viewport = useGraphViewport();
  const scope = useGraphScope();
  const nodeCount = useStoreNumber(selectNodeCount);
  const visibleCount = useVisibleNodeCount();
  const modelRevision = useStoreNumber(selectModelRevision);
  const renderRevision = useStoreNumber(selectRenderRevision);
  const appliedRenderRevision = useStoreNumber(selectAppliedRenderRevision);

  const hovered = hoverId !== null ? nodeById.get(hoverId) : undefined;

  return (
    <div style={S.statusBar}>
      <span
        style={S.statusDot(STATUS_COLOR[status])}
        title={status}
        data-testid="status-dot"
        data-model-revision={modelRevision}
        data-render-revision={renderRevision}
        data-applied-render-revision={appliedRenderRevision}
      />
      <span>
        <span style={S.statusMuted}>hover </span>
        <span data-testid="hover-label">
          {hovered !== undefined ? labelOf(hovered) : hoverId ?? '—'}
        </span>
      </span>
      <span>
        <span style={S.statusMuted}>edge </span>
        {edgeHoverId ?? '—'}
      </span>
      <span>
        <span style={S.statusMuted}>selected </span>
        <span data-testid="selected-count">
          {selection.nodeIds.length.toLocaleString('en-US')}
        </span>
      </span>
      {/* hard-scope indicator: visible-of-model while a scope is active. */}
      <span>
        <span style={S.statusMuted}>scope </span>
        <span data-testid="scope-status">
          {scope === null
            ? 'full'
            : `${visibleCount.toLocaleString('en-US')} of ${nodeCount.toLocaleString('en-US')}`}
        </span>
      </span>
      {/* result contract: the LAST unavailable activation (sticky). */}
      <span>
        <span style={S.statusMuted}>search </span>
        <span data-testid="search-unavailable">{searchNote ?? '—'}</span>
      </span>
      <span>
        <span style={S.statusMuted}>zoom </span>
        {/* data-viewport-x/y: e2e seam — a minimap click pans the real
            camera, asserted from these attrs (rounded, tabular churn only). */}
        <span
          data-testid="zoom-value"
          data-viewport-x={viewport !== null ? viewport.x.toFixed(1) : ''}
          data-viewport-y={viewport !== null ? viewport.y.toFixed(1) : ''}
        >
          {viewport !== null ? `×${viewport.zoom.toFixed(2)}` : '—'}
        </span>
      </span>
    </div>
  );
}

function WorkbenchSidebar({ nodeById, dragNote }: { nodeById: NodeMap; dragNote: string | null }) {
  const selection = useGraphSelection();
  const pins = useGraphPins();

  const selected = selection.nodeIds;
  if (selected.length === 0 && pins.size === 0 && dragNote === null) return null;

  const shown = selected.slice(0, 10);
  return (
    <aside style={S.selectionPanel}>
      <div style={S.pinnedRow}>
        <span style={S.statusMuted}>pinned</span>
        <span data-testid="pinned-count">{pins.size}</span>
      </div>
      {dragNote !== null && <div style={S.selectionMore}>{dragNote}</div>}
      {selected.length > 0 && (
        <>
          <div style={S.selectionHeader}>selected · {selected.length}</div>
          {shown.map((id) => {
            const node = nodeById.get(id);
            return (
              <div key={id} style={S.selectionRow}>
                <span
                  style={{
                    ...S.chip,
                    background: node !== undefined ? nodeColor(node) : clusterColor(0),
                  }}
                />
                <span style={S.selectionLabel}>{node !== undefined ? labelOf(node) : id}</span>
              </div>
            );
          })}
          {selected.length > shown.length && (
            <div style={S.selectionMore}>+{selected.length - shown.length} more</div>
          )}
        </>
      )}
    </aside>
  );
}

function ToolButton({
  onClick,
  disabled,
  testId,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="demo-btn"
      style={S.button}
      data-testid={testId}
      disabled={disabled === true}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const BUTTON_CSS = `
.demo-btn:hover { background: var(--btn-bg-hover); }
.demo-btn:active { background: var(--btn-bg-active); }
.demo-btn:disabled { opacity: 0.45; cursor: default; }
.demo-search input {
  appearance: none;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  background: var(--btn-bg);
  color: var(--fg);
  font: inherit;
  font-size: 12.5px;
  padding: 6px 11px;
  min-width: 260px;
}
`;
