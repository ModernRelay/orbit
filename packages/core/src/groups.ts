/**
 * stage-3 containment rewrite — pure derivation, no engine,
 * no DOM.
 *
 * ## The representative forest
 *
 * ONE structure drives both group collapse and node fold. Every entity — a
 * physical node id, or a synthetic group scene key — has AT MOST ONE
 * representative parent, and:
 *
 * > An entity is drawn iff no ancestor is collapsed. Each edge endpoint
 * > reroutes to its OUTERMOST COLLAPSED ancestor; edges whose endpoints
 * > rewrite to the same key are dropped; the rest merge per directed pair
 * > into one meta-edge carrying the underlying count. A SYNTHETIC
 * > representative materializes only while collapsed; a REAL one is always
 * > drawn.
 *
 * `collapsed` is a property of the REPRESENTATIVE, not of the node — which
 * is exactly why a folded anchor stays visible while its children hide, and
 * why nesting needs no special case (a fold inside a collapsed group hides
 * with it, and its members' edges route to the group).
 *
 * Contract summary:
 * - Groups are HIERARCHICAL but singly-parented: a member id may name another
 * group (nesting), but no entity has two parents. `validateGroupSpecs`
 * rejects a violating array with ONE batched 'config-error' diagnostic
 * BEFORE any scene rewrite — a rejected array changes nothing.
 * - `rewriteGroups` runs over the HARD-SCOPED model:
 * collapsed representatives replace their in-scope descendants with one row
 * (a synthetic super-node, or the fold anchor's existing physical row);
 * descendant edges re-route into meta-edge rows carrying the underlying-edge
 * count (the badge datum). The post-rewrite graph feeds the EXISTING
 * structural diff, so collapse/expand is a diff, never a reload.
 * - Group ids occupy a distinct PUBLIC namespace: synthetic rows carry
 * INTERNAL scene keys (NUL-prefixed — outside the documented caller id
 * contract) that never escape public payloads. A group id equal to a node
 * id coexists without collision. A FOLD anchor is a real node, so its
 * entity key IS its node id and it needs no synthetic slot at all.
 * - Synthetic rows are never cast to N/E: they carry only `id`, and consumers
 * identify them by slot position — synthetics are always a CONTIGUOUS
 * SUFFIX of the node/edge lists (physical prefix ordering is preserved), so
 * `slot >= physicalCount` is the discrimination rule.
 */

import type {
  AcceptedEdge,
  AcceptedGraph,
  GraphDiagnostic,
  GraphNode,
  GroupBySpec,
  GroupSpec,
  MetaEdge,
  NodeId,
  ResolvedGroup,
  SceneFold,
  SceneGroups,
  SceneLinkRef,
  ScenePointRef,
  RenderScene,
} from './types';
import { DIAGNOSTIC_SAMPLE_CAP } from './types';

// ---------------------------------------------------------------------------
// Internal scene-key codec. The NUL prefix keeps synthetic keys out of the
// caller id namespace by construction (caller ids containing U+0000 are
// outside the documented contract); the JSON body keeps keys deterministic
// and collision-free among themselves for any group id / endpoint pair.
// ---------------------------------------------------------------------------

const SCENE_KEY_PREFIX = '\u0000';

/** Internal scene key of a collapsed group's super-node row. NEVER public. */
export function groupSceneKey(groupId: string): string {
  return SCENE_KEY_PREFIX + JSON.stringify(['group', groupId]);
}

/** Internal scene key of a meta-edge row (directed rewritten endpoint pair). */
export function metaEdgeSceneKey(sourceKey: string, targetKey: string): string {
  return SCENE_KEY_PREFIX + JSON.stringify(['meta-edge', sourceKey, targetKey]);
}

/** PUBLIC meta-edge id: the collision-safe ordered endpoint tuple
 * `JSON.stringify(['meta-edge', source.kind, source.id, target.kind,
 * target.id])` — shared with the parallel-edge grouping toggle. */
export function metaEdgePublicId(
  sourceKind: 'node' | 'group',
  sourceId: string,
  targetKind: 'node' | 'group',
  targetId: string,
): string {
  return JSON.stringify(['meta-edge', sourceKind, sourceId, targetKind, targetId]);
}

// ---------------------------------------------------------------------------
// The representative forest — see the module header for the drawn/reroute
// rule it encodes.
// ---------------------------------------------------------------------------

/**
 * Entity key: a physical node id, or a synthetic group scene key. A fold
 * anchor IS its node id — that is the whole point of a real representative.
 */
export type EntityKey = string;

/** One node fold: `anchorId` stands for `memberIds` while folded. A fold
 * record exists only while folded — unfolding deletes it. */
export interface FoldRecord {
  anchorId: NodeId;
  memberIds: readonly NodeId[];
}

export interface RepForest {
  /** entity → its representative parent (at most one, by construction). */
  readonly parent: ReadonlyMap<EntityKey, EntityKey>;
  /** Representatives whose CHILDREN are hidden — never themselves. */
  readonly collapsed: ReadonlySet<EntityKey>;
  /** Synthetic representatives: scene key → the group it stands for. */
  readonly groupOf: ReadonlyMap<EntityKey, ResolvedGroup>;
  /** Fold anchors in declaration order (deterministic scene output). */
  readonly anchors: readonly NodeId[];
  /** Groups in array order (deterministic super-node suffix order). */
  readonly groups: readonly ResolvedGroup[];
}

const EMPTY_FOLDS: readonly FoldRecord[] = Object.freeze([]);

/** An empty forest — nothing collapsed, so `rewriteGroups` passes through. */
export const EMPTY_REP_FOREST: RepForest = Object.freeze({
  parent: new Map<EntityKey, EntityKey>(),
  collapsed: new Set<EntityKey>(),
  groupOf: new Map<EntityKey, ResolvedGroup>(),
  anchors: Object.freeze([]) as readonly NodeId[],
  groups: Object.freeze([]) as readonly ResolvedGroup[],
});

/**
 * Builds the forest from the resolved groups and the live folds.
 *
 * CLAIM ORDER (documented decision): **folds claim their members first**,
 * then groups claim what is left. A fold is a specific user gesture on one
 * node; a `groupBy` partition covers every node in the model. Claiming folds
 * first means toggling `groupBy` on never silently dissolves an existing fold
 * — the anchor keeps its children and, when the group collapses, the whole
 * folded subtree hides inside the group's bubble (the ancestor walk handles
 * it). A node already claimed keeps its first parent; the second claim is
 * skipped, which is what makes "at most one parent" true by construction
 * rather than by validation.
 */
export function buildRepForest(
  groups: readonly ResolvedGroup[],
  folds: readonly FoldRecord[] = EMPTY_FOLDS,
): RepForest {
  const parent = new Map<EntityKey, EntityKey>();
  const collapsed = new Set<EntityKey>();
  const groupOf = new Map<EntityKey, ResolvedGroup>();
  const keyByGroupId = new Map<string, EntityKey>();

  for (const group of groups) {
    const key = groupSceneKey(group.id);
    groupOf.set(key, group);
    keyByGroupId.set(group.id, key);
    if (group.collapsed) collapsed.add(key);
  }

  const anchors: NodeId[] = [];
  for (const fold of folds) {
    // A fold record exists only while folded, so the anchor is collapsed by
    // definition. Recorded even with zero present members: an anchor whose
    // members all left the model still owns the fold until it is unfolded.
    if (collapsed.has(fold.anchorId)) continue; // duplicate anchor: first wins
    collapsed.add(fold.anchorId);
    anchors.push(fold.anchorId);
    for (const member of fold.memberIds) {
      if (member === fold.anchorId) continue;
      if (parent.has(member)) continue;
      parent.set(member, fold.anchorId);
    }
  }

  for (const group of groups) {
    const key = keyByGroupId.get(group.id)!;
    for (const member of group.memberIds) {
      // A member naming another GROUP nests it; otherwise it names a node.
      const childKey = keyByGroupId.get(member) ?? member;
      if (childKey === key) continue; // self-membership (rejected at the boundary)
      if (parent.has(childKey)) continue; // already claimed — first parent wins
      parent.set(childKey, key);
    }
  }

  return { parent, collapsed, groupOf, anchors, groups };
}

/** Resolves an entity to the row that stands for it (see the module header). */
export type RepResolver = (key: EntityKey) => EntityKey;

/**
 * Memoized resolver over one forest: returns the OUTERMOST collapsed ancestor
 * of `key`, or `key` itself when no ancestor is collapsed. `key` being
 * collapsed does not hide `key` — a representative hides its children, not
 * itself — so a folded anchor resolves to itself and stays drawn.
 *
 * Carries a defensive cycle break: `validateGroupSpecs` rejects cycles at the
 * boundary, but a malformed forest must never spin the rewrite.
 */
export function createRepResolver(forest: RepForest): RepResolver {
  const memo = new Map<EntityKey, EntityKey>();
  return function resolve(key: EntityKey): EntityKey {
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let out = key;
    let cur = key;
    const seen = new Set<EntityKey>([key]);
    for (;;) {
      const next = forest.parent.get(cur);
      if (next === undefined || seen.has(next)) break;
      seen.add(next);
      cur = next;
      if (forest.collapsed.has(cur)) out = cur;
    }
    memo.set(key, out);
    return out;
  };
}

// ---------------------------------------------------------------------------
// aggregate style channels (stage 6). Synthetics are styled here, never
// through caller accessors: super-node size grows with member
// count, meta-edge width with underlying count; colors come from
// GroupSpec.color or theme tokens at the projection site.
//
// A FOLD ANCHOR is a physical row and therefore keeps its caller-driven
// styling: Orbit never resizes it by hidden count. Hosts that want that read
// `SceneGroups.folds` (or `getFold`) from their own accessors.
// ---------------------------------------------------------------------------

/** Physical default size when no nodeSize accessor is configured but the
 * scene needs a full buffer for the synthetic suffix. */
export const PHYSICAL_DEFAULT_POINT_SIZE = 4;
/** Physical default width when no linkWidth accessor is configured. */
export const PHYSICAL_DEFAULT_LINK_WIDTH = 1;
export const SUPER_NODE_MAX_SIZE = 36;
export const META_EDGE_MAX_WIDTH = 8;

/** Aggregate super-node size: sublinear in member count, bounded. */
export function superNodeSizeFor(memberCount: number): number {
  const n = Number.isFinite(memberCount) && memberCount > 0 ? memberCount : 1;
  return Math.min(PHYSICAL_DEFAULT_POINT_SIZE + 2 * Math.sqrt(n), SUPER_NODE_MAX_SIZE);
}

/** Aggregate meta-edge width: sublinear in underlying-edge count, bounded. */
export function metaEdgeWidthFor(count: number): number {
  const n = Number.isFinite(count) && count > 0 ? count : 1;
  return Math.min(PHYSICAL_DEFAULT_LINK_WIDTH + Math.log2(n + 1), META_EDGE_MAX_WIDTH);
}

// ---------------------------------------------------------------------------
// Validation — ONE batched diagnostic per pass.
// ---------------------------------------------------------------------------

export interface GroupValidationResult {
  /** Null when the array is valid; otherwise ONE batched 'config-error'. */
  diagnostic: GraphDiagnostic | null;
}

/**
 * Validates a manual `groups` array against the FULL accepted model (members
 * may live outside the current hard scope). Violations, all collected into
 * one diagnostic:
 * - duplicate group id in the array;
 * - self-membership (a group naming its own id — rejected even when a node
 * with that id exists: the ambiguity itself is the error);
 * - duplicate membership (the same node twice in one group);
 * - overlapping membership (the same node in two groups);
 * - CYCLIC nesting (groups that contain each other, directly or through a
 * chain — the containment forest must stay acyclic);
 * - unknown members (ids absent from the accepted model AND not naming
 * another group; with no accepted model every non-group member is unknown).
 *
 * NESTING IS LEGAL: a member id naming another group id nests that group.
 * Containment is a forest, not a partition — but it stays SINGLY PARENTED,
 * so overlap remains an error.
 */
export function validateGroupSpecs(
  specs: readonly GroupSpec[],
  nodeIndex: ReadonlyMap<NodeId, number> | null,
): GroupValidationResult {
  const problems: string[] = [];
  const samples: string[] = [];
  let count = 0;
  const note = (kind: string, sample: string): void => {
    count++;
    problems.push(kind);
    if (samples.length < DIAGNOSTIC_SAMPLE_CAP) samples.push(sample);
  };

  const groupIds = new Set<string>();
  for (const spec of specs) {
    if (groupIds.has(spec.id)) note('duplicate group id', spec.id);
    groupIds.add(spec.id);
  }

  /** member id → owning group id (overlap detection across groups). */
  const owner = new Map<string, string>();
  /** child GROUP id → parent group id, for the cycle walk below. */
  const groupParent = new Map<string, string>();
  for (const spec of specs) {
    const seen = new Set<string>();
    for (const member of spec.memberIds) {
      if (member === spec.id) {
        note('self-membership', `${spec.id} ∋ ${member}`);
        continue;
      }
      if (seen.has(member)) {
        note('duplicate membership', `${spec.id} ∋ ${member}`);
        continue;
      }
      seen.add(member);
      const prevOwner = owner.get(member);
      if (prevOwner !== undefined && prevOwner !== spec.id) {
        note('overlapping groups', `${member} ∈ ${prevOwner} ∧ ${spec.id}`);
        continue;
      }
      owner.set(member, spec.id);
      // Distinct namespaces: a member id equal to ANOTHER group's id nests
      // that group (and is therefore not looked up as a node at all).
      if (groupIds.has(member)) {
        groupParent.set(member, spec.id);
        continue;
      }
      if (nodeIndex === null || !nodeIndex.has(member)) {
        note('unknown member', `${spec.id} ∋ ${member}`);
      }
    }
  }

  // Containment must be acyclic. Walk each group upward; a repeat visit
  // inside one walk is a cycle. `settled` memoizes ids already proven
  // acyclic so the whole pass stays linear in the nesting edges.
  if (groupParent.size > 0) {
    const settled = new Set<string>();
    for (const start of groupParent.keys()) {
      if (settled.has(start)) continue;
      const path = new Set<string>();
      let cur: string | undefined = start;
      while (cur !== undefined && !settled.has(cur)) {
        if (path.has(cur)) {
          note('cyclic nesting', `${start} ↻ ${cur}`);
          break;
        }
        path.add(cur);
        cur = groupParent.get(cur);
      }
      for (const id of path) settled.add(id);
    }
  }

  if (count === 0) return { diagnostic: null };
  const kinds = [...new Set(problems)].join(', ');
  return {
    diagnostic: {
      code: 'config-error',
      severity: 'error',
      count,
      sampleIds: samples,
      message: `groups rejected before scene rewrite: ${kinds} — the previous group configuration stays active`,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution — the store surface: manual specs → ResolvedGroup[].
// ---------------------------------------------------------------------------

/**
 * Resolves a VALIDATED manual groups array against the accepted model.
 * Tolerant by design: members that later departed the model drop out of the
 * resolved membership (model drift is data, not a config error — mirrors
 * selection pruning). Spec order and member order are preserved.
 */
export function resolveManualGroups(
  specs: readonly GroupSpec[],
  nodeIndex: ReadonlyMap<NodeId, number>,
): ResolvedGroup[] {
  return specs.map((spec) => {
    const memberIds = spec.memberIds.filter((id) => nodeIndex.has(id));
    return {
      id: spec.id,
      memberIds,
      collapsed: spec.collapsed === true,
      derived: false,
      ...(spec.label !== undefined ? { label: spec.label } : {}),
      ...(spec.color !== undefined ? { color: spec.color } : {}),
    };
  });
}

/** Canonical structural equality for the groups HOST LANE (GroupSpec is a
 * plain descriptor like Scale — equal literals never re-rewrite). */
export function sameGroupSpecArrays(
  a: readonly GroupSpec[] | null,
  b: readonly GroupSpec[] | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.label !== y.label ||
      x.collapsed !== y.collapsed ||
      x.color !== y.color ||
      x.memberIds.length !== y.memberIds.length
    ) {
      return false;
    }
    for (let k = 0; k < x.memberIds.length; k++) {
      if (x.memberIds[k] !== y.memberIds[k]) return false;
    }
  }
  return true;
}

export function sameResolvedGroups(
  a: readonly ResolvedGroup[],
  b: readonly ResolvedGroup[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.label !== y.label ||
      x.collapsed !== y.collapsed ||
      x.derived !== y.derived ||
      x.color !== y.color ||
      x.memberIds.length !== y.memberIds.length
    ) {
      return false;
    }
    for (let k = 0; k < x.memberIds.length; k++) {
      if (x.memberIds[k] !== y.memberIds[k]) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// groupBy derivation — pure, over the ACCEPTED model.
// Membership under groupBy is derived and READ-ONLY; the instance owns only
// the per-KEY collapsed residue.
// ---------------------------------------------------------------------------

/**
 * collision-safe derived-group id codec: `JSON.stringify(['group',
 * key])`. Injective over keys (JSON string encoding), never equal to the raw
 * key itself (every output starts with `["group",`), and round-trippable via
 * JSON.parse. Labels stay separate — the derived group's `label` is the raw
 * key. Group ids remain a distinct public namespace, so a NODE id that
 * happens to equal a derived id still coexists without collision.
 */
export function groupByDerivedId(key: string): string {
  return JSON.stringify(['group', key]);
}

/** Canonical identity for the groupBy HOST LANE: `by` compares by function
 * reference (a new inline lambda re-derives), semanticZoom structurally. */
export function sameGroupBySpec<N>(
  a: GroupBySpec<N> | null,
  b: GroupBySpec<N> | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.by !== b.by) return false;
  const sa = a.semanticZoom;
  const sb = b.semanticZoom;
  if (sa === undefined || sb === undefined) return sa === sb;
  return sa.collapseBelow === sb.collapseBelow && sa.expandAbove === sb.expandAbove;
}

/**
 * D4 boundary validation for a groupBy spec: `by` must be a function and
 * `semanticZoom.expandAbove` must be STRICTLY greater than `collapseBelow`.
 * Returns ONE batched
 * 'config-error' diagnostic (the rejected spec never lands — the previous
 * groupBy configuration stays active) or null when valid.
 */
export function validateGroupBySpec<N>(spec: GroupBySpec<N>): GraphDiagnostic | null {
  const problems: string[] = [];
  if (typeof spec.by !== 'function') problems.push('`by` must be a function');
  const sz = spec.semanticZoom;
  if (sz !== undefined) {
    const collapseOk = typeof sz.collapseBelow === 'number' && Number.isFinite(sz.collapseBelow);
    const expandOk = typeof sz.expandAbove === 'number' && Number.isFinite(sz.expandAbove);
    if (!collapseOk) problems.push('semanticZoom.collapseBelow must be a finite number');
    if (!expandOk) problems.push('semanticZoom.expandAbove must be a finite number');
    if (collapseOk && expandOk && !(sz.expandAbove > sz.collapseBelow)) {
      problems.push(
        'semanticZoom.expandAbove must be strictly greater than collapseBelow to provide a hysteresis gap',
      );
    }
  }
  if (problems.length === 0) return null;
  return {
    code: 'config-error',
    severity: 'error',
    count: problems.length,
    sampleIds: [],
    message: `groupBy rejected: ${problems.join('; ')} — the previous groupBy configuration stays active`,
  };
}

export interface GroupByDerivation {
  /** One derived group per distinct key, first-encounter order over the
   * model's node list. `collapsed` comes from the caller's residue lookup. */
  groups: readonly ResolvedGroup[];
  /** Derived PUBLIC id → derived key (the setGroupCollapsed reverse map;
   * the residue is keyed by KEY, never by id). */
  keyById: ReadonlyMap<string, string>;
  /** ONE aggregated 'accessor-error' warning when `by` threw (the affected
   * nodes derive as ungrouped — never silent loss, I3), else null. */
  diagnostic: GraphDiagnostic | null;
}

/**
 * groupBy derivation: one GroupSpec-shaped ResolvedGroup per distinct
 * string key returned by `by` (first-encounter order, matching
 * categorical-domain conventions); `null` — and any non-string value — means
 * ungrouped. Derived ids use {@link groupByDerivedId}; `label` is the raw
 * key; `derived: true` marks membership read-only. `collapsed` defaults to
 * whatever `isCollapsedKey` reports — with an empty residue everything is
 * expanded, so adding groupBy alone changes no rendering.
 */
export function deriveGroupsByKey<N>(
  nodes: readonly GraphNode<N>[],
  by: (node: GraphNode<N>) => string | null,
  isCollapsedKey: (key: string) => boolean,
): GroupByDerivation {
  const order: string[] = [];
  const members = new Map<string, NodeId[]>();
  let errorCount = 0;
  const errorSamples: string[] = [];
  for (const node of nodes) {
    let raw: string | null;
    try {
      raw = by(node);
    } catch {
      errorCount++;
      if (errorSamples.length < DIAGNOSTIC_SAMPLE_CAP) errorSamples.push(node.id);
      continue;
    }
    if (typeof raw !== 'string') continue; // null / non-string ⇒ ungrouped
    let bucket = members.get(raw);
    if (bucket === undefined) {
      bucket = [];
      members.set(raw, bucket);
      order.push(raw);
    }
    bucket.push(node.id);
  }
  const groups: ResolvedGroup[] = [];
  const keyById = new Map<string, string>();
  for (const key of order) {
    const id = groupByDerivedId(key);
    keyById.set(id, key);
    groups.push({
      id,
      label: key,
      memberIds: members.get(key)!,
      collapsed: isCollapsedKey(key),
      derived: true,
    });
  }
  return {
    groups,
    keyById,
    diagnostic:
      errorCount === 0
        ? null
        : {
            code: 'accessor-error',
            severity: 'warning',
            count: errorCount,
            sampleIds: errorSamples,
            message: 'groupBy.by threw; the affected nodes derived as ungrouped',
          },
  };
}

// ---------------------------------------------------------------------------
// Stage-3 rewrite.
// ---------------------------------------------------------------------------

export interface SuperNodeRecord {
  /** Internal scene key of the super-node row (never public). */
  sceneKey: string;
  group: ResolvedGroup;
  /** TRANSITIVE descendants present in the REWRITTEN model's input
   * (hard-scoped set) — the stage-5 mask and aggregate size read this, not
   * the full declared membership. Transitive and direct coincide unless
   * something is nested underneath. */
  presentMemberIds: readonly NodeId[];
}

export interface MetaEdgeRecord {
  /** Internal scene key of the meta-edge row (never public). */
  sceneKey: string;
  /** Public record: endpoints are PUBLIC ids — a
   * group id or a node id — and `count` is the badge datum. */
  metaEdge: MetaEdge;
  /** Indices of the rerouted edges in the PRE-rewrite model's edge list
   * the stage-5 "any underlying edge passes" rule evaluates these. */
  underlying: readonly number[];
}

export interface GroupRewrite<N = Record<string, unknown>, E = Record<string, unknown>> {
  /** The post-rewrite scene model — what feeds the structural diff. */
  graph: AcceptedGraph<N, E>;
  /** Physical rows (same objects as the input model's, members removed). */
  physicalNodes: readonly GraphNode<N>[];
  physicalEdges: readonly AcceptedEdge<E>[];
  /** Scene slots >= these counts are synthetic (contiguous-suffix rule). */
  physicalNodeCount: number;
  physicalEdgeCount: number;
  /** Aligned to point slots physicalNodeCount..count-1, in groups order. */
  superNodes: readonly SuperNodeRecord[];
  /** Aligned to link slots physicalEdgeCount..linkCount-1, first-encounter
   * order over the input edge scan. */
  metaEdges: readonly MetaEdgeRecord[];
  /** Drawn fold anchors and the descendant count each currently hides. These
   * are PHYSICAL rows — they occupy no synthetic slot. */
  folds: readonly SceneFold[];
  /** hidden node id → the entity key of the row standing for it (a super-node
   * scene key, or a fold anchor's node id). */
  hiddenOwner: ReadonlyMap<NodeId, EntityKey>;
}

/**
 * Rewrites the collapsed representatives of `forest` over the hard-scoped
 * model. Returns null when nothing collapsed intersects the
 * model — an uncollapsed group exists only in store.groups and never
 * rewrites the scene.
 *
 * Deterministic: physical rows keep model order; super-nodes append in
 * groups-array order; meta-edges append in first-encounter order. Edges whose
 * endpoints land on the SAME representative drop — that covers both a
 * same-group internal edge and an anchor's edge to its own folded member,
 * which would otherwise emit a self-loop. Dropped edges are internal state,
 * cached by construction: they re-derive from the unchanged accepted model on
 * expand. Synthetic rows carry no positions; the reconciler's departed cache
 * restores a re-collapsed super-node (stable scene key) and returning members
 * exactly like any other leave-and-return.
 */
export function rewriteGroups<N, E>(
  model: AcceptedGraph<N, E>,
  forest: RepForest,
): GroupRewrite<N, E> | null {
  if (forest.collapsed.size === 0) return null;
  const resolve = createRepResolver(forest);

  // --- partition the model's nodes by the row that stands for each. ---
  const physicalNodes: GraphNode<N>[] = [];
  const hiddenOwner = new Map<NodeId, EntityKey>();
  /** representative → its TRANSITIVE hidden descendants present in the model. */
  const descendants = new Map<EntityKey, NodeId[]>();
  for (const node of model.nodes) {
    const rep = resolve(node.id);
    if (rep === node.id) {
      physicalNodes.push(node);
      continue;
    }
    hiddenOwner.set(node.id, rep);
    let bucket = descendants.get(rep);
    if (bucket === undefined) {
      bucket = [];
      descendants.set(rep, bucket);
    }
    bucket.push(node.id);
  }
  // Nothing collapsed actually reaches this model — pass through.
  if (hiddenOwner.size === 0) return null;

  // --- synthetic suffix: only the OUTERMOST collapsed group materializes (a
  // collapsed group nested inside another is itself hidden). Fold anchors are
  // real rows already in the physical prefix, so they never append here. ---
  const supers: SuperNodeRecord[] = [];
  for (const group of forest.groups) {
    if (!group.collapsed) continue;
    const key = groupSceneKey(group.id);
    if (resolve(key) !== key) continue;
    const present = descendants.get(key);
    if (present === undefined || present.length === 0) continue;
    supers.push({ sceneKey: key, group, presentMemberIds: present });
  }
  const folds: SceneFold[] = [];
  for (const anchorId of forest.anchors) {
    if (resolve(anchorId) !== anchorId) continue; // the anchor is itself hidden
    const present = descendants.get(anchorId);
    if (present === undefined || present.length === 0) continue;
    folds.push({ anchorId, hiddenCount: present.length });
  }

  const nodes: GraphNode<N>[] = physicalNodes.slice();
  for (const rec of supers) nodes.push({ id: rec.sceneKey });
  const nodeIndex = new Map<NodeId, number>();
  for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i]!.id, i);

  // --- edges: kept physical prefix + meta-edge suffix. A meta-edge
  // aggregates every underlying edge sharing the same DIRECTED rewritten
  // endpoint pair. ---
  const physicalEdges: AcceptedEdge<E>[] = [];
  interface Bucket {
    sourceKey: string;
    targetKey: string;
    metaEdge: { id: string; source: string; target: string; count: number };
    underlying: number[];
  }
  const buckets = new Map<string, Bucket>();
  const order: Bucket[] = [];
  /** Entity key → the PUBLIC endpoint it names: a group id for a
   * synthetic representative, the node id itself for a physical one. */
  const publicEndpoint = (key: EntityKey): { kind: 'node' | 'group'; id: string } => {
    const group = forest.groupOf.get(key);
    return group === undefined ? { kind: 'node', id: key } : { kind: 'group', id: group.id };
  };
  for (let k = 0; k < model.edges.length; k++) {
    const edge = model.edges[k]!;
    const sourceKey = resolve(edge.source);
    const targetKey = resolve(edge.target);
    if (sourceKey === edge.source && targetKey === edge.target) {
      physicalEdges.push(edge);
      continue;
    }
    // Both endpoints stand behind ONE row — a same-group internal edge, or a
    // fold anchor's edge to its own member, which would become a self-loop.
    if (sourceKey === targetKey) continue;
    const pairKey = `${sourceKey}\u0000${targetKey}`;
    let bucket = buckets.get(pairKey);
    if (bucket === undefined) {
      const src = publicEndpoint(sourceKey);
      const tgt = publicEndpoint(targetKey);
      bucket = {
        sourceKey,
        targetKey,
        metaEdge: {
          id: metaEdgePublicId(src.kind, src.id, tgt.kind, tgt.id),
          source: src.id,
          target: tgt.id,
          count: 0,
        },
        underlying: [],
      };
      buckets.set(pairKey, bucket);
      order.push(bucket);
    }
    bucket.metaEdge.count++;
    bucket.underlying.push(k);
  }

  const edges: AcceptedEdge<E>[] = physicalEdges.slice();
  const metaRecords: MetaEdgeRecord[] = [];
  for (const bucket of order) {
    const sceneKey = metaEdgeSceneKey(bucket.sourceKey, bucket.targetKey);
    edges.push({ id: sceneKey, source: bucket.sourceKey, target: bucket.targetKey });
    metaRecords.push({ sceneKey, metaEdge: bucket.metaEdge, underlying: bucket.underlying });
  }

  return {
    graph: {
      datasetKey: model.datasetKey,
      sourceRevision: model.sourceRevision,
      nodes,
      edges,
      nodeIndex,
      diagnostics: model.diagnostics,
    },
    physicalNodes,
    physicalEdges,
    physicalNodeCount: physicalNodes.length,
    physicalEdgeCount: physicalEdges.length,
    superNodes: supers,
    metaEdges: metaRecords,
    folds,
    hiddenOwner,
  };
}

// ---------------------------------------------------------------------------
// parallel-edge grouping — a stage-3-ADJACENT
// rewrite pass over the POST-group-rewrite edge list.
//
// ORDERING CONTRACT (documented decision): the group rewrite runs FIRST and
// this pass collapses over its output. Group meta-edges already aggregate
// every underlying edge per DIRECTED rewritten endpoint pair by construction
// (one bucket per pair in `rewriteGroups`), so group-derived meta-edges are
// bundled without further work and this pass only needs the kept PHYSICAL
// edges — a physical pair (node, node) can never collide with a group meta
// pair (which always has at least one group endpoint). Pairs are DIRECTED,
// matching directed bucketing: an A→B and a B→A edge remain two rows.
// ---------------------------------------------------------------------------

/**
 * Collapses same-DIRECTED-endpoint-pair physical edges into ONE meta-edge
 * per pair, composing with an existing group rewrite (or synthesizing a
 * groups-empty rewrite when none is active). Returns `base` unchanged when
 * no pair has multiplicity > 1 — the toggle is then a scene no-op.
 *
 * Meta-edge identity reuses the group codecs: public id
 * `metaEdgePublicId('node', source, 'node', target)`,
 * internal scene key `metaEdgeSceneKey(source, target)`. `count` (the badge
 * datum) is the collapsed multiplicity and drives the aggregate width
 * channel; `underlying` indexes the PRE-rewrite model's edge list so the
 * "any underlying edge passes" mask rule applies unchanged.
 */
export function collapseParallelEdges<N, E>(
  model: AcceptedGraph<N, E>,
  base: GroupRewrite<N, E> | null,
): GroupRewrite<N, E> | null {
  const physical = base !== null ? base.physicalEdges : model.edges;
  const multiplicity = new Map<string, number>();
  for (const edge of physical) {
    const key = `${edge.source}\u0000${edge.target}`;
    multiplicity.set(key, (multiplicity.get(key) ?? 0) + 1);
  }
  let anyParallel = false;
  for (const n of multiplicity.values()) {
    if (n > 1) {
      anyParallel = true;
      break;
    }
  }
  if (!anyParallel) return base;

  /** Pre-rewrite edge index by id — `underlying` must address model.edges. */
  const modelEdgeIndex = new Map<string, number>();
  for (let k = 0; k < model.edges.length; k++) modelEdgeIndex.set(model.edges[k]!.id, k);

  interface Bucket {
    source: string;
    target: string;
    metaEdge: { id: string; source: string; target: string; count: number };
    underlying: number[];
  }
  const kept: AcceptedEdge<E>[] = [];
  const buckets = new Map<string, Bucket>();
  const order: Bucket[] = [];
  for (const edge of physical) {
    const key = `${edge.source}\u0000${edge.target}`;
    if (multiplicity.get(key)! < 2) {
      kept.push(edge);
      continue;
    }
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        source: edge.source,
        target: edge.target,
        metaEdge: {
          id: metaEdgePublicId('node', edge.source, 'node', edge.target),
          source: edge.source,
          target: edge.target,
          count: 0,
        },
        underlying: [],
      };
      buckets.set(key, bucket);
      order.push(bucket);
    }
    bucket.metaEdge.count++;
    bucket.underlying.push(modelEdgeIndex.get(edge.id)!);
  }

  // Suffix layout: [group meta rows][parallel meta rows] — records align to
  // link slots physicalEdgeCount..linkCount-1 (contiguous-suffix rule).
  const groupMetaRecords = base !== null ? base.metaEdges : [];
  const groupMetaRows: AcceptedEdge<E>[] = [];
  if (base !== null) {
    for (let j = base.physicalEdgeCount; j < base.graph.edges.length; j++) {
      groupMetaRows.push(base.graph.edges[j]!);
    }
  }
  const parallelRecords: MetaEdgeRecord[] = [];
  const parallelRows: AcceptedEdge<E>[] = [];
  for (const bucket of order) {
    const sceneKey = metaEdgeSceneKey(bucket.source, bucket.target);
    parallelRows.push({ id: sceneKey, source: bucket.source, target: bucket.target });
    parallelRecords.push({ sceneKey, metaEdge: bucket.metaEdge, underlying: bucket.underlying });
  }

  const nodes = base !== null ? base.graph.nodes : model.nodes;
  const nodeIndex = base !== null ? base.graph.nodeIndex : model.nodeIndex;
  return {
    graph: {
      datasetKey: model.datasetKey,
      sourceRevision: model.sourceRevision,
      nodes,
      edges: [...kept, ...groupMetaRows, ...parallelRows],
      nodeIndex,
      diagnostics: model.diagnostics,
    },
    physicalNodes: base !== null ? base.physicalNodes : model.nodes,
    physicalEdges: kept,
    physicalNodeCount: base !== null ? base.physicalNodeCount : model.nodes.length,
    physicalEdgeCount: kept.length,
    superNodes: base !== null ? base.superNodes : [],
    metaEdges: [...groupMetaRecords, ...parallelRecords],
    folds: base !== null ? base.folds : [],
    hiddenOwner: base !== null ? base.hiddenOwner : new Map<NodeId, EntityKey>(),
  };
}

// ---------------------------------------------------------------------------
// RenderScene discriminated refs. The scene stores the compact
// suffix descriptor; these helpers materialize per-slot refs on demand so
// consumers never touch internal scene keys.
// ---------------------------------------------------------------------------

/** The RenderScene.groups descriptor for a rewrite. */
export function sceneGroupsOf(rewrite: GroupRewrite<unknown, unknown>): SceneGroups {
  return {
    physicalPointCount: rewrite.physicalNodeCount,
    physicalLinkCount: rewrite.physicalEdgeCount,
    superNodes: rewrite.superNodes.map((rec) => rec.group),
    metaEdges: rewrite.metaEdges.map((rec) => rec.metaEdge),
    folds: rewrite.folds,
  };
}

/** Discriminated point ref: physical node id or the ResolvedGroup — never an
 * internal scene key. Null when out of range. */
export function scenePointRefAt(scene: RenderScene, index: number): ScenePointRef | null {
  if (index < 0 || index >= scene.count) return null;
  const groups = scene.groups;
  if (groups !== undefined && index >= groups.physicalPointCount) {
    const group = groups.superNodes[index - groups.physicalPointCount];
    return group === undefined ? null : { kind: 'group', group };
  }
  const id = scene.idByIndex[index];
  return id === undefined ? null : { kind: 'node', id };
}

/** Discriminated link ref: physical edge id or the MetaEdge record. */
export function sceneLinkRefAt(scene: RenderScene, linkIndex: number): SceneLinkRef | null {
  if (linkIndex < 0 || linkIndex >= scene.linkCount) return null;
  const groups = scene.groups;
  if (groups !== undefined && linkIndex >= groups.physicalLinkCount) {
    const metaEdge = groups.metaEdges[linkIndex - groups.physicalLinkCount];
    return metaEdge === undefined ? null : { kind: 'meta-edge', metaEdge };
  }
  const id = scene.edgeIdByIndex[linkIndex];
  return id === undefined ? null : { kind: 'edge', id };
}
