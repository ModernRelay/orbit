/**
 * path resolution — the built-in LOCAL PathService plus the
 * pure emphasis-plan helper the instance wires into `findPath`.
 *
 * The default service runs an unweighted BFS over the LOADED VISIBLE edge
 * list — it never fetches, never touches scope/filters, and never reads the
 * engine. `null` is a RESULT (unreachable), not an error; an endpoint id not
 * in the loaded base is unreachable by definition and also resolves `null`.
 * Direction ('outgoing' default | 'incoming' | 'either') decides which way
 * an edge may be walked. Ties break deterministically: neighbors are visited
 * in base edge order, so among equal-length paths the first in edge order
 * wins. `ctx.signal` is honored between scan chunks (an awaited microtask
 * every {@link PATH_SCAN_CHUNK} scanned edges, as in search.ts) — abort is
 * an optimization; the instance's revision admission gate is authoritative.
 * Declares `revisionDependencies: ['source', 'model', 'scope']`: a
 * path is a point-in-scene answer, so ANY revision drift discards it.
 *
 * Nothing is cached across calls: visibility is mask-derived and moves
 * WITHOUT advancing any revision dimension, so a revision-keyed adjacency
 * cache would serve stale reachability. One O(V + E) build per call is the
 * "O(n) per action" budget.
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
import type {
  EdgeId,
  GraphEdge,
  GraphNode,
  NodeId,
  PathOptions,
  PathResult,
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
}

/** Edges scanned between cooperative yields (awaited microtask + signal
 * check) — same cadence as SEARCH_SCAN_CHUNK. */
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
  return {
    revisionDependencies: ['source', 'model', 'scope'],
    async find(
      sourceId: NodeId,
      targetId: NodeId,
      options: PathOptions,
      ctx: RequestContext,
    ): Promise<PathResult | null> {
      if (ctx.signal.aborted) throwAborted(ctx.signal, sourceId, targetId);
      const direction = options.direction ?? 'outgoing';
      const { nodes, edges, isEdgeVisible } = getBase();

      // Ordinal index over the loaded nodes (first-wins, matching dedup).
      const ordinalOf = new Map<NodeId, number>();
      for (let i = 0; i < nodes.length; i++) {
        const id = nodes[i]!.id;
        if (!ordinalOf.has(id)) ordinalOf.set(id, i);
      }
      const src = ordinalOf.get(sourceId);
      const dst = ordinalOf.get(targetId);
      if (src === undefined || dst === undefined) return null; // unloaded = unreachable
      if (src === dst) return { nodeIds: [nodes[src]!.id], edgeIds: [] };

      // Directed adjacency over VISIBLE edges: adj[u] holds [v, edgeOrdinal]
      // pairs flat, filled in base edge order (the determinism tie-break).
      // Synthesized-id counters advance for EVERY id-less edge — visible or
      // not — so ordinals match the accepted model's synthesis.
      const adjacency: number[][] = new Array<number[]>(nodes.length);
      const edgeIds: EdgeId[] = new Array<EdgeId>(edges.length);
      const counters: EdgePairCounters = new Map();
      let scanned = 0;
      for (let e = 0; e < edges.length; e++) {
        if (++scanned % PATH_SCAN_CHUNK === 0) {
          // Cooperative yield between scan chunks; the signal is the
          // cancellation seam.
          await Promise.resolve();
          if (ctx.signal.aborted) throwAborted(ctx.signal, sourceId, targetId);
        }
        const edge = edges[e]!;
        const id = edge.id ?? nextSynthesizedEdgeId(counters, edge.source, edge.target);
        edgeIds[e] = id;
        if (isEdgeVisible !== undefined && !isEdgeVisible(id)) continue;
        const s = ordinalOf.get(edge.source);
        const t = ordinalOf.get(edge.target);
        if (s === undefined || t === undefined) continue; // dangling endpoint
        if (direction !== 'incoming') (adjacency[s] ??= []).push(t, e);
        if (direction !== 'outgoing') (adjacency[t] ??= []).push(s, e);
      }

      // BFS with predecessor arrays; queue is an array with a head cursor.
      const prevNode = new Int32Array(nodes.length).fill(-1);
      const prevEdge = new Int32Array(nodes.length).fill(-1);
      const visited = new Uint8Array(nodes.length);
      visited[src] = 1;
      const queue: number[] = [src];
      let found = false;
      outer: for (let head = 0; head < queue.length; head++) {
        const u = queue[head]!;
        const list = adjacency[u];
        if (list === undefined) continue;
        for (let j = 0; j < list.length; j += 2) {
          if (++scanned % PATH_SCAN_CHUNK === 0) {
            await Promise.resolve();
            if (ctx.signal.aborted) throwAborted(ctx.signal, sourceId, targetId);
          }
          const v = list[j]!;
          if (visited[v] !== 0) continue;
          visited[v] = 1;
          prevNode[v] = u;
          prevEdge[v] = list[j + 1]!;
          if (v === dst) {
            found = true;
            break outer;
          }
          queue.push(v);
        }
      }
      if (!found) return null;

      // Reconstruct dst → src, then reverse into path order.
      const nodeIds: NodeId[] = [];
      const pathEdgeIds: EdgeId[] = [];
      for (let at = dst; at !== src; at = prevNode[at]!) {
        nodeIds.push(nodes[at]!.id);
        pathEdgeIds.push(edgeIds[prevEdge[at]!]!);
      }
      nodeIds.push(nodes[src]!.id);
      nodeIds.reverse();
      pathEdgeIds.reverse();
      return { nodeIds, edgeIds: pathEdgeIds };
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
