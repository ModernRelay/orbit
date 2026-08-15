/**
 * hard subgraph scope — pure resolution over the accepted base.
 *
 * `resolveScope` turns a `SubgraphSpec` into the exact node/edge subset the
 * reconciler should be fed: seeds validated against the accepted base
 * (unknown ids dropped, duplicates collapsed), optional `hops` expansion via
 * BFS over the CSR adjacency of the ACCEPTED BASE (not the scene — the
 * default expansion service walks this same index), and edges cascaded
 * through `cascadeEdges`, the single edge-survival primitive (an edge
 * survives iff BOTH endpoints survive) that soft masks reuse.
 *
 * Everything here is synchronous and engine-free. The async
 * `ExpansionService` seam (./services) exists for `expandNode`; `hops`
 * resolution inside a host update takes this local path directly.
 */

import { buildAdjacency, neighborsOf } from './adjacency';
import type { Adjacency } from './adjacency';
import type { AcceptedEdge, AcceptedGraph, GraphNode, NodeId, SubgraphSpec } from './types';

/**
 * THE edge-cascade primitive: an edge survives iff BOTH of its
 * endpoints survive. O(E); the only allocation is the output array, which
 * holds references to the input edge objects (never copies).
 *
 * Exported for reuse by soft masks and any other subset producer.
 */
export function cascadeEdges<E>(
  edges: readonly AcceptedEdge<E>[],
  survives: (id: NodeId) => boolean,
): AcceptedEdge<E>[] {
  const out: AcceptedEdge<E>[] = [];
  for (const edge of edges) {
    if (survives(edge.source) && survives(edge.target)) out.push(edge);
  }
  return out;
}

/**
 * Builds the CSR adjacency of an accepted base: endpoints are positions
 * in `accepted.nodes` (accepted-base order). Every accepted edge has resolved
 * endpoints by contract, so this cannot throw on
 * a well-formed `AcceptedGraph`.
 */
export function buildAcceptedAdjacency(accepted: AcceptedGraph<unknown, unknown>): Adjacency {
  const { edges, nodeIndex } = accepted;
  const links = new Uint32Array(edges.length * 2);
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    const source = nodeIndex.get(edge.source);
    const target = nodeIndex.get(edge.target);
    if (source === undefined || target === undefined) {
      throw new RangeError(
        `buildAcceptedAdjacency: edge '${edge.id}' references an unknown endpoint (accepted graphs must not contain dangling edges)`,
      );
    }
    links[i * 2] = source;
    links[i * 2 + 1] = target;
  }
  return buildAdjacency(links, accepted.nodes.length);
}

/** Output of `resolveScope`: the exact subset to feed the reconciler. */
export interface ResolvedScope<N = Record<string, unknown>, E = Record<string, unknown>> {
  /** Surviving node ids (seeds + hop expansion), membership-query form. */
  nodeIds: ReadonlySet<NodeId>;
  /** Surviving nodes in accepted-base order (same objects, never copies). */
  nodes: readonly GraphNode<N>[];
  /** Edges whose BOTH endpoints survive, in accepted-base order. */
  edges: readonly AcceptedEdge<E>[];
}

/**
 * Depth-limited BFS over the accepted-base adjacency: marks every node
 * reachable from `seedIndices` within `hops` undirected steps (seeds are
 * depth 0 and always marked). Mutates and returns `visited` (length =
 * pointCount, 1 = in scope). O(V + E) worst case, no per-node allocation
 * beyond the two frontier arrays.
 */
function markWithinHops(
  adjacency: Adjacency,
  seedIndices: readonly number[],
  hops: number,
  visited: Uint8Array,
): Uint8Array {
  let frontier: number[] = [];
  for (const index of seedIndices) {
    if (visited[index] === 0) {
      visited[index] = 1;
      frontier.push(index);
    }
  }
  for (let depth = 0; depth < hops && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const index of frontier) {
      const neighbors = neighborsOf(adjacency, index);
      for (let k = 0; k < neighbors.length; k++) {
        const neighbor = neighbors[k]!;
        if (visited[neighbor] === 0) {
          visited[neighbor] = 1;
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return visited;
}

/**
 * Resolves a hard-scope spec against the accepted base.
 *
 * - `spec.seedIds` are validated against `accepted.nodeIndex`: ids unknown to
 * the accepted base are dropped, duplicates collapse to one seed.
 * - `spec.hops` (default 0; negative/non-finite values clamp to 0, fractions
 * floor) expands the survivor set by BFS over the accepted-base adjacency.
 * This is the synchronous local path — the default `ExpansionService`
 * walks the same index for `expandNode`.
 * - `adjacency` may be a caller-cached `buildAcceptedAdjacency(accepted)`
 * result; pass `null` to have one built on demand (only when `hops > 0`
 * and there are surviving seeds — hop-0 resolution never builds it).
 * - Output preserves accepted-base order for both nodes and edges; edges are
 * cascaded through {@link cascadeEdges}.
 */
export function resolveScope<N, E>(
  accepted: AcceptedGraph<N, E>,
  spec: SubgraphSpec,
  adjacency: Adjacency | null,
): ResolvedScope<N, E> {
  const { nodeIndex } = accepted;

  // Seed validation: drop unknown, dedupe (Set keys), keep index for BFS.
  const nodeIds = new Set<NodeId>();
  const seedIndices: number[] = [];
  for (const id of spec.seedIds) {
    const index = nodeIndex.get(id);
    if (index !== undefined && !nodeIds.has(id)) {
      nodeIds.add(id);
      seedIndices.push(index);
    }
  }

  const rawHops = spec.hops ?? 0;
  const hops = Number.isFinite(rawHops) ? Math.max(0, Math.floor(rawHops)) : 0;

  if (hops > 0 && seedIndices.length > 0) {
    const adj = adjacency ?? buildAcceptedAdjacency(accepted);
    const visited = markWithinHops(
      adj,
      seedIndices,
      hops,
      new Uint8Array(accepted.nodes.length),
    );
    for (let index = 0; index < visited.length; index++) {
      if (visited[index] === 1) nodeIds.add(accepted.nodes[index]!.id);
    }
  }

  // Accepted-base order: filter the base arrays, never re-sort.
  const nodes: GraphNode<N>[] = [];
  for (const node of accepted.nodes) {
    if (nodeIds.has(node.id)) nodes.push(node);
  }
  const edges = cascadeEdges(accepted.edges, (id) => nodeIds.has(id));

  return { nodeIds, nodes, edges };
}
