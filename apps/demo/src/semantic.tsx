/**
 * v0.10 M5 semantic-exploration surface: the clustered fixture, the
 * control panel, the context-menu extensions, and the right dock hosting
 * `<GraphTable>` + `<GraphSimControls>`.
 *
 * The surface is a DATA MODE of the demo ('semantic'), so it composes with the
 * existing declarative / stream / omnigraph / csv modes through the same
 * `graphKey` remount discipline — a mode switch always builds a fresh
 * instance, which is what keeps the construction-only `searchIndex` lane (D7)
 * honest and what lets this mode run a FIXED layout while the others run
 * force.
 *
 * Determinism contract: every node carries a declared
 * position derived only from (cluster index, member index), so under
 * `layout="fixed"` the rendered picture is a pure function of the fixture
 * no seeded force run, no settle race. The layout radio remounts (the mode
 * carries the layout) rather than switching in place: a force run moves nodes
 * away from their declared positions, and freezing in place afterwards would
 * capture wherever the sim happened to be.
 *
 * Every control writes through a PUBLIC surface — the `groups` / `groupBy` /
 * `clusters` / `pinnedNodeIds` props, the ref API (findPath/clearPath,
 * expandNode/retractExpansion, pinNodes/unpinNodes, setGroupCollapsed), or
 * `applyHostUpdate({ parallelEdgeGrouping })` — and every observable it
 * produces is rendered as a `data-testid` readout sourced from the STORE, so
 * the e2e suite asserts published state rather than app-local bookkeeping.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type {
  ClusterSpec,
  DimensionSpec,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  GraphStoreState,
  GroupBySpec,
  GroupSpec,
  LabelConfig,
  MetaEdge,
  NodeId,
  PathResult,
  ResolvedGroup,
  SimulationConfig,
} from '@modernrelay/orbit-core';
import { useGraphInstance, useGraphSelection, useGraphVisible } from '@modernrelay/orbit-react';
import { GraphContextMenu } from '@modernrelay/orbit-react/components/ContextMenu';
import type {
  GraphContextMenuItem,
  GraphContextMenuTarget,
} from '@modernrelay/orbit-react/components/ContextMenu';
import { GraphSimControls } from '@modernrelay/orbit-react/components/SimControls';
import { GraphTable } from '@modernrelay/orbit-react/components/Table';
import type { GraphTableHandle } from '@modernrelay/orbit-react/components/Table';

import { clusterName, nodeMetrics } from './generate';
import type { DemoEdgeAttrs, DemoNodeAttrs } from './generate';
import * as S from './styles';

// ---------------------------------------------------------------------------
// Fixture (deterministic; no rng at build time beyond the shared metric draw)
// ---------------------------------------------------------------------------

export const M5_DATASET_KEY = 'm5-semantic';
export const M5_CLUSTER_COUNT = 6;
export const M5_PER_CLUSTER = 24;
export const M5_NODE_COUNT = M5_CLUSTER_COUNT * M5_PER_CLUSTER; // 144
/** Extra same-pair edges on (M5_SEED_NODE → s1): the parallel-edge bundle. */
export const M5_PARALLEL_EXTRA = 3;
/** Cluster-0 hub — the isolate seed and the path source. */
export const M5_SEED_NODE: NodeId = 's0';
/** Cluster-1 hub — reachable from the seed over the inter-cluster bridge; the
 * expandNode frontier and the path target. */
export const M5_FRONTIER_NODE: NodeId = 's24';
/** Metric-draw seed (shared generator helpers): fixed, never Date.now. */
const M5_METRIC_SEED = 90_210;

const GOLDEN_ANGLE = 2.399963229728653;
/**
 * Cosmos space is [0, 4096]. With the home camera below (space center at
 * ×0.33) a ring radius of 600 puts the whole fixture — six discs on a ring
 * inside the canvas band the overlay chrome leaves free at 1280×800, so the
 * screen geometry is a pure function of these constants: that is what lets the
 * e2e suite aim right-clicks at cluster hubs.
 */
const SPACE_CENTER = 2048;
const CLUSTER_RING_RADIUS = 600;
/** Dense discs: 24 members inside 80 space units render as a compact blob, so
 * a right-click near a cluster center reliably lands ON a node (the
 * menu is the only channel into the group/path items). */
const CLUSTER_DISC_RADIUS = 80;

/** Member index k of cluster c → node id (contiguous per cluster). */
export function m5NodeId(cluster: number, member: number): NodeId {
  return `s${cluster * M5_PER_CLUSTER + member}`;
}

/** Declared position of one member: a pure function of (cluster, member). */
function m5Position(cluster: number, member: number): readonly [number, number] {
  const a = (2 * Math.PI * cluster) / M5_CLUSTER_COUNT;
  const cx = SPACE_CENTER + Math.cos(a) * CLUSTER_RING_RADIUS;
  const cy = SPACE_CENTER + Math.sin(a) * CLUSTER_RING_RADIUS;
  const r = CLUSTER_DISC_RADIUS * Math.sqrt((member + 0.5) / M5_PER_CLUSTER);
  const t = member * GOLDEN_ANGLE;
  return [cx + Math.cos(t) * r, cy + Math.sin(t) * r];
}

/**
 * The M5 fixture: `M5_CLUSTER_COUNT` clusters of `M5_PER_CLUSTER` nodes, each
 * cluster a chain plus four hub spokes, the cluster hubs wired into a ring
 * (so every pair of nodes is connected for `findPath`), and one designated
 * PARALLEL BUNDLE of `M5_PARALLEL_EXTRA` extra same-pair edges so the
 * parallel-edge toggle is OPERATIVE (edge ids are caller-supplied — ids
 * synthesized from (type, source, target) would already have collapsed the
 * parallels, which is the documented inoperative case.
 */
export function buildSemanticSnapshot(): GraphSnapshot<DemoNodeAttrs, DemoEdgeAttrs> {
  const edges: GraphEdge<DemoEdgeAttrs>[] = [];
  const degree = new Map<NodeId, number>();
  const link = (source: NodeId, target: NodeId, kind: DemoEdgeAttrs['kind']): void => {
    edges.push({ id: `m${edges.length}`, source, target, attrs: { kind } });
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
  };

  for (let c = 0; c < M5_CLUSTER_COUNT; c++) {
    for (let k = 0; k + 1 < M5_PER_CLUSTER; k++) link(m5NodeId(c, k), m5NodeId(c, k + 1), 'intra');
    for (const spoke of [5, 10, 15, 20]) link(m5NodeId(c, 0), m5NodeId(c, spoke), 'intra');
  }
  // Hub ring across clusters: connected graph, deterministic bridge edges.
  for (let c = 0; c < M5_CLUSTER_COUNT; c++) {
    link(m5NodeId(c, 0), m5NodeId((c + 1) % M5_CLUSTER_COUNT, 0), 'inter');
  }
  // Parallel bundle on (s0 → s1) — the chain already carries one such edge.
  for (let i = 0; i < M5_PARALLEL_EXTRA; i++) {
    link(m5NodeId(0, 0), m5NodeId(0, 1), 'intra');
  }

  const nodes: GraphNode<DemoNodeAttrs>[] = [];
  for (let c = 0; c < M5_CLUSTER_COUNT; c++) {
    for (let k = 0; k < M5_PER_CLUSTER; k++) {
      const index = c * M5_PER_CLUSTER + k;
      const id = m5NodeId(c, k);
      const [x, y] = m5Position(c, k);
      const { score, createdAt } = nodeMetrics(M5_METRIC_SEED, index, c, M5_CLUSTER_COUNT);
      nodes.push({
        id,
        x,
        y,
        attrs: {
          cluster: c,
          label: `${clusterName(c)}-${String(index).padStart(4, '0')}`,
          degree: degree.get(id) ?? 0,
          score,
          createdAt,
        },
      });
    }
  }

  return { datasetKey: M5_DATASET_KEY, sourceRevision: 1, nodes, edges };
}

// ---------------------------------------------------------------------------
// Specs (module scope: identities never churn across renders)
// ---------------------------------------------------------------------------

/** Categorical key shared by groupBy and clusters: the cluster NAME. Typed
 * over `GraphNode<unknown>` so the spec is assignable to the demo's attr
 * union without re-declaring it here. */
function clusterKeyOf(node: GraphNode<unknown>): string | null {
  const attrs = node.attrs as { cluster?: unknown } | undefined;
  return typeof attrs?.cluster === 'number' ? clusterName(attrs.cluster) : null;
}

/**
 * semantic-zoom band thresholds. The home camera's zoom sits strictly
 * INSIDE the corridor, so arriving at it — and enabling groupBy on top of it
 * flips nothing; the two panel buttons below drive real
 * viewport events across each threshold.
 */
export const M5_SEMANTIC_ZOOM = { collapseBelow: 0.25, expandAbove: 1.2 } as const;

/**
 * Home camera for the FIXED layout, applied once when the instance reaches
 * ready. The mount-time fit is a heuristic over whatever the engine holds at
 * that moment; stating the camera makes the whole screen geometry a documented
 * function of the fixture — space point (x, y) lands at
 * `(640 + (x − 2048)·zoom, 400 − (y − 2048)·zoom)` in the 1280×800 e2e
 * viewport — which is what lets the suite aim right-clicks at cluster centers.
 * The zoom sits strictly inside the semantic-zoom corridor, so arriving home
 * never flips a band.
 */
export const M5_HOME_VIEW = { x: SPACE_CENTER, y: SPACE_CENTER, zoom: 0.33 } as const;

/**
 * Panel zoom targets — comfortably past each threshold, each with an explicit
 * CAMERA so a band flip is reproducible: the collapse band always views the
 * whole fixture from the space center, and the expand band always views
 * cluster 0's disc (the ring's hollow center holds no nodes, so a centered
 * zoom-in would leave the viewport empty — nothing in view to expand, and no
 * node labels to hand the LOD back to).
 */
export const M5_ZOOM_COLLAPSE = {
  x: SPACE_CENTER,
  y: SPACE_CENTER,
  zoom: 0.15,
} as const;
export const M5_ZOOM_EXPAND = {
  x: SPACE_CENTER + CLUSTER_RING_RADIUS,
  y: SPACE_CENTER,
  zoom: 2,
} as const;

export const M5_GROUP_BY: GroupBySpec<unknown> = {
  by: clusterKeyOf,
  semanticZoom: M5_SEMANTIC_ZOOM,
};

export const M5_CLUSTER_SPEC: ClusterSpec<unknown> = { by: clusterKeyOf, strength: 0.7 };

/**
 * Fixed point size for M5 (the other modes keep the degree accessor): the
 * context menu is reachable only through a real right-click on a point,
 * so the fixture's nodes must be pointer-sized targets — and a collapsing disc
 * then reads as a real pixel delta in the diffs.
 */
export const M5_NODE_SIZE = (): number => 9;

/** One manual group per cluster — flat, disjoint, covering every node, so a
 * right-click anywhere lands on a group member. */
export const M5_MANUAL_GROUPS: readonly GroupSpec[] = Array.from(
  { length: M5_CLUSTER_COUNT },
  (_, c) => ({
    id: `g-${clusterName(c)}`,
    label: `${clusterName(c)} group`,
    memberIds: Array.from({ length: M5_PER_CLUSTER }, (_, k) => m5NodeId(c, k)),
  }),
);

/**
 * label lane for M5: cluster labels own the overview band (`maxZoom`),
 * node labels take over above it (`minZoom`). Both thresholds sit above the
 * home zoom, so the cluster-label LOD is what a fresh M5 mount shows and the
 * expand-band camera is what hands the lane back to node labels.
 */
export const M5_LABEL_MAX_ZOOM = 1.5;
export const M5_LABELS: LabelConfig<unknown> = {
  minZoom: 1.6,
  maxZoom: M5_LABEL_MAX_ZOOM,
  maxVisible: 48,
};

/** Id-keyed categorical dimension the `<GraphTable>` filter brushes through:
 * without it the table filters LOCALLY only (documented degradation
 * in the component). */
export const M5_TABLE_DIMENSION: DimensionSpec<unknown> = {
  key: 'table',
  kind: 'categorical',
  get: (node) => node.id,
};

/** Stable `simulation` seed for both `<Graph>` and `<GraphSimControls>`: the
 * component owns every later write, so this identity never changes and the
 * prop lane never re-commits behind the panel. */
export const M5_SIMULATION: SimulationConfig = { repulsion: 0.6, gravity: 0.25 };

/**
 * FIXED-layout force config: every force zeroed. `layout: 'fixed'` states the
 * host's intent, but cosmos owns a simulation loop that keeps integrating
 * across commits (see {@link useFrozenLayout}); with no forces there is
 * nothing to integrate, so the declared positions survive whatever frames run
 * before the freeze lands.
 */
export const M5_FROZEN_SIMULATION: SimulationConfig = {
  gravity: 0,
  repulsion: 0,
  friction: 0,
  linkSpring: 0,
};

export type M5Layout = 'force' | 'fixed';
export type M5Grouping = 'none' | 'manual' | 'derived';

// ---------------------------------------------------------------------------
// Store readouts (every M5 observable is published state, not app state)
// ---------------------------------------------------------------------------

function useStoreValue<T>(select: (s: GraphStoreState) => T): T {
  const instance = useGraphInstance();
  const selectRef = useRef(select);
  selectRef.current = select;
  const subscribe = useCallback(
    (onChange: () => void) => instance.store.subscribe(onChange),
    [instance],
  );
  const getSnapshot = useCallback(
    () => selectRef.current(instance.store.getState()),
    [instance],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const selectGroups = (s: GraphStoreState): readonly ResolvedGroup[] => s.groups;
const selectPinnedCount = (s: GraphStoreState): number => s.pinnedNodeIds.size;
const selectSelectedGroups = (s: GraphStoreState): readonly string[] => s.selection.groupIds;

/** Cluster count is a ref-API read (clusters synthesize nothing, so they have
 * no store slice); re-read on every publication. */
function useClusterCount(): number {
  const instance = useGraphInstance();
  const subscribe = useCallback(
    (onChange: () => void) => instance.store.subscribe(onChange),
    [instance],
  );
  const getSnapshot = useCallback(() => instance.getClusters().length, [instance]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Demo-side freeze for the FIXED layout.
 *
 * cosmos keeps its own simulation loop alive across commits — the adapter
 * pauses it only when the host asks — so `layout="fixed"` alone still lets the
 * engine integrate away from the declared positions (and cosmos additionally
 * RESCALES committed positions into its own space, so the drift is visible).
 * Pausing after every publication is the host-level "this layout is static"
 * statement: it keeps the fixture's declared geometry authoritative and makes
 * the screenshot diffs a function of the fixture alone. `pauseSimulation`
 * is idempotent and publishes only on a true→false transition.
 */
function useFrozenLayout(active: boolean): void {
  const instance = useGraphInstance();
  useEffect(() => {
    if (!active) return undefined;
    /** One-shot: the home camera is stated once the engine is live. */
    let homed = false;
    const settle = (): void => {
      instance.pauseSimulation();
      if (!homed && instance.store.getState().status === 'ready') {
        homed = true;
        instance.setViewport(M5_HOME_VIEW);
      }
    };
    settle();
    return instance.store.subscribe(settle);
  }, [instance, active]);
}

/**
 * FORCE-variant framing: the mount fit runs before the simulation has spread
 * the fixture, so the first settle is when a fit is actually meaningful. One
 * shot per instance — later settles (a reheat from the sim controls) leave the
 * camera where the user put it.
 */
function useFitOnSettle(active: boolean): void {
  const instance = useGraphInstance();
  useEffect(() => {
    if (!active) return undefined;
    let fitted = false;
    return instance.on('simulationEnd', () => {
      if (fitted) return;
      fitted = true;
      instance.fitView();
    });
  }, [instance, active]);
}

/**
 * The active path. Path emphasis is SESSION-LOCAL (never a store slice),
 * so this re-reads on every store publication — the lanes that clear it
 * (selection mutation, undo/redo, scene rebuild) all publish — plus on `tick`,
 * which the host bumps when a findPath/clearPath call settles.
 */
function useActivePath(tick: number): PathResult | null {
  const instance = useGraphInstance();
  const [path, setPath] = useState<PathResult | null>(() => instance.getActivePath());
  useEffect(() => {
    const read = (): void => setPath(instance.getActivePath());
    read();
    return instance.store.subscribe(read);
  }, [instance, tick]);
  return path;
}

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------

export interface SemanticPanelProps {
  layout: M5Layout;
  onLayoutChange: (layout: M5Layout) => void;
  grouping: M5Grouping;
  onGroupingChange: (grouping: M5Grouping) => void;
  clusters: boolean;
  onClustersChange: (on: boolean) => void;
  parallelEdges: boolean;
  onParallelEdgesChange: (on: boolean) => void;
  /** Controlled-owner reset: expand every manual group in one prop write. */
  onExpandAllGroups: () => void;
  onClearPath: () => void;
}

export function SemanticPanel(props: SemanticPanelProps): ReactNode {
  const instance = useGraphInstance();
  const selection = useGraphSelection();
  useFrozenLayout(props.layout === 'fixed');
  useFitOnSettle(props.layout === 'force');

  const zoomTo = (v: { x: number; y: number; zoom: number }): void => {
    instance.setViewport(v);
  };
  const isolateSeed = (): void => {
    instance.applyHostUpdate({ subgraph: { seedIds: [M5_SEED_NODE], hops: 1 } });
  };
  const expandFrontier = (): void => {
    // A collapse/discard rejects by design — the readouts carry the why.
    void instance.expandNode(M5_FRONTIER_NODE).catch(() => {});
  };
  const retractFrontier = (): void => {
    instance.retractExpansion(M5_FRONTIER_NODE);
  };
  const pinSelection = (): void => {
    if (selection.nodeIds.length > 0) instance.pinNodes(selection.nodeIds);
  };
  const unpinAllPersistent = (): void => {
    const pinned = [...instance.store.getState().pinnedNodeIds];
    if (pinned.length > 0) instance.unpinNodes(pinned);
  };

  return (
    <section style={S.m5Panel} data-testid="m5-panel" aria-label="Semantic exploration">
      <div style={S.dataPanelTitle}>semantic (M5)</div>

      <div style={S.styleRow} role="radiogroup" aria-label="M5 layout">
        <span style={S.statusMuted}>layout</span>
        {(['fixed', 'force'] as const).map((l) => (
          <label key={l} style={S.filterCheckLabel}>
            <input
              type="radio"
              name="m5-layout"
              data-testid={`m5-layout-${l}`}
              checked={props.layout === l}
              onChange={() => props.onLayoutChange(l)}
            />
            {l}
          </label>
        ))}
      </div>

      <div style={S.styleRow} role="radiogroup" aria-label="M5 grouping">
        <span style={S.statusMuted}>groups</span>
        {(['none', 'manual', 'derived'] as const).map((g) => (
          <label key={g} style={S.filterCheckLabel}>
            <input
              type="radio"
              name="m5-grouping"
              data-testid={`m5-grouping-${g}`}
              checked={props.grouping === g}
              onChange={() => props.onGroupingChange(g)}
            />
            {g}
          </label>
        ))}
      </div>

      <div style={S.styleRow}>
        <label style={S.filterCheckLabel}>
          <input
            type="checkbox"
            data-testid="m5-clusters-toggle"
            checked={props.clusters}
            onChange={(e) => props.onClustersChange(e.target.checked)}
          />
          clusters
        </label>
        <label style={S.filterCheckLabel}>
          <input
            type="checkbox"
            data-testid="m5-parallel-toggle"
            checked={props.parallelEdges}
            onChange={(e) => props.onParallelEdgesChange(e.target.checked)}
          />
          parallel edges
        </label>
      </div>

      <div style={S.dataPanelRow}>
        <M5Button testId="m5-zoom-collapse" onClick={() => zoomTo(M5_ZOOM_COLLAPSE)}>
          Zoom out (collapse band)
        </M5Button>
        <M5Button testId="m5-zoom-expand" onClick={() => zoomTo(M5_ZOOM_EXPAND)}>
          Zoom in (expand band)
        </M5Button>
      </div>

      <div style={S.dataPanelRow}>
        <M5Button testId="m5-isolate" onClick={isolateSeed}>
          Isolate seed
        </M5Button>
        <M5Button testId="m5-expand" onClick={expandFrontier}>
          Expand frontier
        </M5Button>
        <M5Button testId="m5-retract" onClick={retractFrontier}>
          Retract expansion
        </M5Button>
      </div>

      <div style={S.dataPanelRow}>
        <M5Button testId="m5-pin-selection" onClick={pinSelection}>
          Pin selection
        </M5Button>
        <M5Button testId="m5-unpin-all" onClick={unpinAllPersistent}>
          Unpin all
        </M5Button>
        <M5Button testId="m5-expand-all-groups" onClick={props.onExpandAllGroups}>
          Expand all groups
        </M5Button>
        <M5Button testId="m5-clear-path" onClick={props.onClearPath}>
          Clear path
        </M5Button>
      </div>

    </section>
  );
}

/**
 * The M5 observable surface, docked under the equivalent views: every value is
 * the STORE's (or, for the two lanes with no store slice, the ref-API read
 * `getClusters` and the session-local `getActivePath`), so the e2e suite
 * asserts published state rather than app-local bookkeeping.
 */
export function SemanticReadouts(props: {
  /** Bumped by the host when a findPath/clearPath call settles. */
  pathTick: number;
  /** Last group / meta-edge typed event, or null. */
  metaEvent: string | null;
  /** Live `gravity` mirrored from `<GraphSimControls onSimulationChange>`. */
  simGravity: number | null;
}): ReactNode {
  const visible = useGraphVisible();
  const groups = useStoreValue(selectGroups);
  const pinnedCount = useStoreValue(selectPinnedCount);
  const selectedGroups = useStoreValue(selectSelectedGroups);
  const clusterCount = useClusterCount();
  const path = useActivePath(props.pathTick);
  const collapsedCount = groups.reduce((n, g) => n + (g.collapsed ? 1 : 0), 0);

  return (
    <div style={S.m5Readouts} data-testid="m5-readouts">
      <span style={S.statusMuted}>groups</span>
      <span style={S.streamMeterValue} data-testid="m5-groups">
        {groups.length}
      </span>
      <span style={S.statusMuted}>collapsed</span>
      <span
        style={S.streamMeterValue}
        data-testid="m5-collapsed"
        data-collapse-below={M5_SEMANTIC_ZOOM.collapseBelow}
        data-expand-above={M5_SEMANTIC_ZOOM.expandAbove}
      >
        {collapsedCount}
      </span>
      <span style={S.statusMuted}>clusters</span>
      <span style={S.streamMeterValue} data-testid="m5-clusters">
        {clusterCount}
      </span>
      <span style={S.statusMuted}>visible edges</span>
      <span style={S.streamMeterValue} data-testid="m5-visible-edges">
        {visible.edges}
      </span>
      <span style={S.statusMuted}>pinned</span>
      <span style={S.streamMeterValue} data-testid="m5-pinned">
        {pinnedCount}
      </span>
      <span style={S.statusMuted}>path</span>
      <span style={S.streamMeterValue} data-testid="m5-path">
        {path === null ? '—' : `${path.nodeIds.length} nodes · ${path.edgeIds.length} edges`}
      </span>
      <span style={S.statusMuted}>groups selected</span>
      <span style={S.streamMeterValue} data-testid="m5-selected-groups">
        {selectedGroups.length}
      </span>
      <span style={S.statusMuted}>meta event</span>
      <span style={S.streamMeterValue} data-testid="m5-meta-event">
        {props.metaEvent ?? '—'}
      </span>
      <span style={S.statusMuted}>sim gravity</span>
      <span style={S.streamMeterValue} data-testid="m5-sim-gravity">
        {props.simGravity === null ? '—' : String(props.simGravity)}
      </span>
    </div>
  );
}

function M5Button({
  onClick,
  testId,
  children,
}: {
  onClick: () => void;
  testId: string;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      className="demo-btn"
      style={S.button}
      data-testid={testId}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

/**
 * `<GraphContextMenu>` with the M5 additions:
 * - a NODE menu on a group member gains 'Collapse group' (the
 * structural-diff op through `setGroupCollapsed`);
 * - a BACKGROUND menu gains 'Expand group' while any group is collapsed
 * a collapsed group's members own no scene slot, so its super-node cannot
 * be right-clicked (contextMenu resolves physical nodes only), and the
 * background menu is the reachable expand affordance. ONE group per
 * activation: under the controlled `groups` prop each op emits an INTENT
 * computed from the current array, so a loop would collapse into a single
 * reflected write.
 * - `onFindPath` wires the packaged find-path-from/to pair to the host's
 * `GraphHandle.findPath`.
 */
export function SemanticContextMenu({
  onFindPath,
}: {
  onFindPath: (sourceId: NodeId, targetId: NodeId) => void;
}): ReactNode {
  const instance = useGraphInstance();
  const renderItems = useCallback(
    (ctx: {
      target: GraphContextMenuTarget;
      defaultItems: readonly GraphContextMenuItem[];
    }): readonly GraphContextMenuItem[] => {
      const groups = instance.store.getState().groups;
      if (ctx.target.kind === 'background') {
        const collapsed = groups.find((g) => g.collapsed);
        if (collapsed === undefined) return ctx.defaultItems;
        return [
          ...ctx.defaultItems,
          {
            id: 'm5-expand-group',
            label: `Expand ${collapsed.label ?? collapsed.id}`,
            onSelect: () => {
              instance.setGroupCollapsed(collapsed.id, false);
            },
          },
        ];
      }
      const nodeId = ctx.target.node.id;
      const group = groups.find((g) => !g.collapsed && g.memberIds.includes(nodeId));
      if (group === undefined) return ctx.defaultItems;
      return [
        ...ctx.defaultItems,
        {
          id: 'm5-collapse-group',
          label: `Collapse ${group.label ?? group.id}`,
          onSelect: () => {
            instance.setGroupCollapsed(group.id, true);
          },
        },
      ];
    },
    [instance],
  );

  return <GraphContextMenu renderItems={renderItems} onFindPath={onFindPath} />;
}

// ---------------------------------------------------------------------------
// Right dock: <GraphTable> + <GraphSimControls>
// ---------------------------------------------------------------------------

const M5_TABLE_COLUMNS: readonly string[] = ['id', 'label', 'cluster', 'degree', 'score'];

/**
 * The M5 equivalent views, docked beside the canvas.
 *
 * DOM order is sim-controls-first / table-second with the visual order flipped
 * by CSS `order` (the navigator's convention): the table mounts a windowed but
 * still sizeable set of tabbable rows, so putting the panel after it would bury
 * the sim controls deep in the tab ring for the keyboard run.
 */
export function SemanticDock({
  layout,
  onSimulationChange,
  pathTick,
  metaEvent,
  simGravity,
}: {
  layout: M5Layout;
  onSimulationChange: (next: SimulationConfig) => void;
  pathTick: number;
  metaEvent: string | null;
  simGravity: number | null;
}): ReactNode {
  const tableRef = useRef<GraphTableHandle | null>(null);
  const [csvNote, setCsvNote] = useState<string | null>(null);

  const exportCsv = useCallback(() => {
    const csv = tableRef.current?.exportCsv() ?? '';
    const lines = csv === '' ? 0 : csv.split('\r\n').filter((l) => l !== '').length;
    setCsvNote(`${lines} records · ${csv.length} B`);
  }, []);

  return (
    <aside style={S.m5Dock} data-testid="m5-dock" aria-label="M5 views">
      <div style={S.m5SimWrap}>
        <GraphSimControls
          layout={layout}
          simulation={M5_SIMULATION}
          onSimulationChange={onSimulationChange}
          style={S.m5SimControls}
        />
      </div>
      <div style={S.m5TableWrap}>
        <GraphTable
          ref={tableRef}
          columns={M5_TABLE_COLUMNS}
          height={150}
          rowHeight={24}
          label="M5 node table"
          style={S.m5Table}
        />
        <div style={S.dataPanelRow}>
          <M5Button testId="m5-export-csv" onClick={exportCsv}>
            Export CSV
          </M5Button>
          <span style={S.statusMuted} data-testid="m5-csv">
            {csvNote ?? '—'}
          </span>
        </div>
        <SemanticReadouts pathTick={pathTick} metaEvent={metaEvent} simGravity={simGravity} />
      </div>
    </aside>
  );
}

/** Text form of a group / meta-edge typed event for the panel readout. */
export function metaEventText(
  payload: { group: ResolvedGroup } | { metaEdge: MetaEdge },
): string {
  if ('group' in payload) {
    return `group ${payload.group.id} · ${payload.group.memberIds.length} members`;
  }
  return `meta-edge ${payload.metaEdge.source}→${payload.metaEdge.target} ×${payload.metaEdge.count}`;
}

/** ResolvedGroup[] → GroupSpec[] for the controlled `groups` prop (
 * op INTENTS arrive resolved and the host reflects them back). */
export function toGroupSpecs(groups: readonly ResolvedGroup[]): readonly GroupSpec[] {
  return groups.map((g) => ({
    id: g.id,
    memberIds: g.memberIds,
    collapsed: g.collapsed,
    ...(g.label !== undefined ? { label: g.label } : {}),
    ...(g.color !== undefined ? { color: g.color } : {}),
  }));
}
