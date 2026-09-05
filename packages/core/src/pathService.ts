/**
 * path resolution — the built-in LOCAL PathService plus the
 * pure emphasis-plan helper the instance wires into `findPath`.
 *
 * The default service runs deterministic unweighted BFS over visible or
 * loaded relationships. It never fetches or changes scope/filters. Direction,
 * exact relationship types, and an optional hop budget constrain traversal.
 * Detailed results distinguish missing endpoints, visibility obstacles,
 * unreachable targets, and exhausted hop budgets; the legacy find method
 * maps every non-found outcome to null.
 *
 * Adjacency is rebuilt per query. Every PATH_SCAN_CHUNK scanned edges yields
 * to a browser task, permitting input and cancellation. The service declares
 * source/model/scope dependencies; the instance discards revision drift at
 * admission, regardless of whether the producer honored cancellation.
 *
 * EMPHASIS CONTRACT ({@link computePathEmphasis}, wired by the integrator):
 * one findPath application is ONE atomic action — path-node point indices to
 * the engine highlight channel, plus a single link-channel commit carrying
 * path-edge emphasis and the non-path dim complement through the
 * mutedAlpha mask. While active, the path OWNS engine emphasis state:
 * `clearPath` or ANY selection mutation restores selection highlight.
 * Path highlight is session-local — cleared by undo/redo, never recorded as
 * a history step, never serialized into GraphViewState.
 */

import { nextSynthesizedEdgeId } from './edgeIdentity';
import type { EdgePairCounters } from './edgeIdentity';
import { OrbitOperationError } from './errors';
import { validatePath, matchesRelationship } from './exploration';
import type {
  EdgeId,
  GraphEdge,
  GraphNode,
  NodeId,
  PathOptions,
  PathResult,
  PathOutcome,
  AcceptedEdge,
  PathService,
  RequestContext,
} from './types';

// ---------------------------------------------------------------------------
// Local service contract
// ---------------------------------------------------------------------------

/** Loaded-base view the local service traverses (thunked for lazy wiring
 * re-read on every call, so the service can be constructed before data
 * arrives and always sees the live visibility). */
export interface LocalPathBase<N = Record<string, unknown>, E = Record<string, unknown>> {
  /** Loaded nodes in accepted-base order (the BFS tie-break order). */
  nodes: readonly GraphNode<N>[];
  /** Loaded edges in accepted-base order; ids are synthesized when absent. */
  edges: readonly GraphEdge<E>[];
  /** visibility by EDGE ID; absent = every loaded edge is traversable.
   * BFS walks only edges for which this returns true. */
  isEdgeVisible?: (id: EdgeId) => boolean;
  isNodeVisible?: (id: NodeId) => boolean;
}

/** Edges scanned between cooperative task yields and abort checks. */
export const PATH_SCAN_CHUNK = 4096;

function throwAborted(signal: AbortSignal, sourceId: NodeId, targetId: NodeId): never {
  const reason = (signal as { reason?: unknown }).reason;
  throw new OrbitOperationError(
    reason === undefined ? { code: 'aborted' } : { code: 'aborted', cause: reason },
    `local find('${sourceId}' → '${targetId}') aborted mid-scan`,
  );
}

// ---------------------------------------------------------------------------
// The built-in local BFS service
// ---------------------------------------------------------------------------

/**
 * Creates the default local path service over the loaded base.
 * Unweighted BFS; shortest path by hop count; `null` when unreachable
 * (including an endpoint id absent from the base). Edge ids missing from the
 * base are synthesized in base order with the codec, so results match the
 * accepted model's ids whichever base form the wiring passes.
 */
export function createLocalPathService<N = Record<string, unknown>, E = Record<string, unknown>>(
  getBase: () => LocalPathBase<N, E>,
): PathService {
  async function findDetailed(
    sourceId: NodeId,
    targetId: NodeId,
    rawOptions: PathOptions,
    ctx: RequestContext,
  ): Promise<PathOutcome> {
    const options = validatePath(rawOptions);
    if (ctx.signal.aborted) throwAborted(ctx.signal, sourceId, targetId);
    const direction = options.direction ?? 'outgoing';
    const { nodes, edges, isEdgeVisible, isNodeVisible } = getBase();
    const ordinalOf = new Map<NodeId, number>();
    for (let i = 0; i < nodes.length; i++) if (!ordinalOf.has(nodes[i]!.id)) ordinalOf.set(nodes[i]!.id, i);
    const missing = [...new Set([sourceId, targetId])].filter((id) => !ordinalOf.has(id));
    if (missing.length > 0) return { status: 'not-loaded', nodeIds: missing };
    const filtered = options.universe === 'loaded' ? [] : [...new Set([sourceId, targetId])].filter((id) => isNodeVisible !== undefined && !isNodeVisible(id));
    if (filtered.length > 0) return { status: 'filtered', nodeIds: filtered };
    const src = ordinalOf.get(sourceId)!;
    const dst = ordinalOf.get(targetId)!;
    if (src === dst) return { status: 'found', path: { nodeIds: [sourceId], edgeIds: [] } };
    const adjacency: number[][] = new Array<number[]>(nodes.length);
    const edgeIds: EdgeId[] = new Array<EdgeId>(edges.length);
    const counters: EdgePairCounters = new Map();
    let scanned = 0;
    for (let e = 0; e < edges.length; e++) {
      if (++scanned % PATH_SCAN_CHUNK === 0) {
        // A task yield lets input/paint and cancellation run, unlike a microtask.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (ctx.signal.aborted) throwAborted(ctx.signal, sourceId, targetId);
      }
      const edge = edges[e]!;
      const id = edge.id ?? nextSynthesizedEdgeId(counters, edge.source, edge.target);
      edgeIds[e] = id;
      if (!matchesRelationship({ ...edge, id } as AcceptedEdge<E>, options)) continue;
      if (options.universe !== 'loaded' && ((isEdgeVisible !== undefined && !isEdgeVisible(id)) || (isNodeVisible !== undefined && (!isNodeVisible(edge.source) || !isNodeVisible(edge.target))))) continue;
      const s = ordinalOf.get(edge.source);
      const t = ordinalOf.get(edge.target);
      if (s === undefined || t === undefined) continue;
      if (direction !== 'incoming') (adjacency[s] ??= []).push(t, e);
      if (direction !== 'outgoing') (adjacency[t] ??= []).push(s, e);
    }
    const prevNode = new Int32Array(nodes.length).fill(-1);
    const prevEdge = new Int32Array(nodes.length).fill(-1);
    const depth = new Int32Array(nodes.length).fill(-1);
    depth[src] = 0;
    const queue: number[] = [src];
    let found = false;
    let limited = false;
    outer: for (let head = 0; head < queue.length; head++) {
      const u = queue[head]!;
      const list = adjacency[u];
      if (list === undefined) continue;
      for (let j = 0; j < list.length; j += 2) {
        if (++scanned % PATH_SCAN_CHUNK === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (ctx.signal.aborted) throwAborted(ctx.signal, sourceId, targetId);
        }
        const v = list[j]!;
        if (depth[v]! >= 0) continue;
        if (options.maxHops !== undefined && depth[u]! >= options.maxHops) { limited = true; continue; }
        depth[v] = depth[u]! + 1;
        prevNode[v] = u;
        prevEdge[v] = list[j + 1]!;
        if (v === dst) { found = true; break outer; }
        queue.push(v);
      }
    }
    if (ctx.signal.aborted) throwAborted(ctx.signal, sourceId, targetId);
    if (!found) {
      if (!limited && options.universe !== 'loaded' && (isNodeVisible !== undefined || isEdgeVisible !== undefined)) {
        const loaded = await findDetailed(sourceId, targetId, { ...options, universe: 'loaded' }, ctx);
        if (loaded.status === 'found') return { status: 'filtered', nodeIds: loaded.path.nodeIds.filter((id) => isNodeVisible !== undefined && !isNodeVisible(id)) };
      }
      return { status: limited ? 'hop-limit' : 'unreachable' };
    }
    const nodeIds: NodeId[] = [];
    const pathEdgeIds: EdgeId[] = [];
    for (let at = dst; at !== src; at = prevNode[at]!) {
      nodeIds.push(nodes[at]!.id);
      pathEdgeIds.push(edgeIds[prevEdge[at]!]!);
    }
    nodeIds.push(nodes[src]!.id);
    nodeIds.reverse();
    pathEdgeIds.reverse();
    return { status: 'found', path: { nodeIds, edgeIds: pathEdgeIds } };
  }
  return {
    revisionDependencies: ['source', 'model', 'scope'],
    findDetailed,
    async find(sourceId, targetId, options, ctx) {
      const outcome = await findDetailed(sourceId, targetId, options, ctx);
      return outcome.status === 'found' ? outcome.path : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Emphasis plan (pure — the instance turns it into ONE atomic action)
// ---------------------------------------------------------------------------

/** Scene view the emphasis planner reads — structurally a RenderScene subset
 * plus the optional hide-lane probe, so instance wiring passes the live
 * scene straight through. */
export interface PathEmphasisScene {
  /** node id → engine point index (RenderScene.indexById). */
  indexById: ReadonlyMap<NodeId, number>;
  /** engine link index → edge id (RenderScene.edgeIdByIndex). */
  edgeIdByIndex: readonly EdgeId[];
  /** hide lane (SoftMask.isEdgeVisible); absent = all links visible.
   * Hidden links are excluded from the dim complement (they already render
   * at alpha 0 — dimming them would be redundant work in the mask). */
  isEdgeVisible?: (linkIndex: number) => boolean;
}

/** One findPath application, as engine-facing index sets. */
export interface PathEmphasisPlan {
  /** Path-node POINT indices in path order (engine highlight channel). */
  nodeIndices: readonly number[];
  /** Path-edge LINK indices in path order (the emphasis half of the single
   * atomic link-channel commit). */
  pathEdgeIndices: readonly number[];
  /** Dim complement: every OTHER visible link, ascending (the
   * mutedAlpha mask half). Disjoint from `pathEdgeIndices` by construction. */
  dimEdgeIndices: readonly number[];
}

/**
 * Projects a resolved path onto the current scene as index sets — O(path +
 * linkCount), no engine or store access. Ids absent from the scene are
 * skipped: under the wiring's revision admission a resolved path and the
 * scene share a revision, so a miss is unreachable there; the helper stays
 * total for direct callers.
 */
export function computePathEmphasis(path: PathResult, scene: PathEmphasisScene): PathEmphasisPlan {
  const nodeIndices: number[] = [];
  for (const id of path.nodeIds) {
    const index = scene.indexById.get(id);
    if (index !== undefined) nodeIndices.push(index);
  }
  const pathEdgeIdSet = new Set<EdgeId>(path.edgeIds);
  const pathEdgeIndexById = new Map<EdgeId, number>();
  const dimEdgeIndices: number[] = [];
  const { edgeIdByIndex, isEdgeVisible } = scene;
  for (let link = 0; link < edgeIdByIndex.length; link++) {
    const id = edgeIdByIndex[link]!;
    if (pathEdgeIdSet.has(id)) {
      // First slot wins for a duplicated id (scene ids are expected to be unique).
      if (!pathEdgeIndexById.has(id)) pathEdgeIndexById.set(id, link);
      continue;
    }
    if (isEdgeVisible !== undefined && !isEdgeVisible(link)) continue;
    dimEdgeIndices.push(link);
  }
  // Path order, not scene order, for the emphasis lane (badge/walk order).
  const pathEdgeIndices: number[] = [];
  for (const id of path.edgeIds) {
    const index = pathEdgeIndexById.get(id);
    if (index !== undefined) pathEdgeIndices.push(index);
  }
  return { nodeIndices, pathEdgeIndices, dimEdgeIndices };
}
