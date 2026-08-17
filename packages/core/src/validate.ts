/**
 * snapshot validation — deterministic malformed-input resolution.
 *
 * Pure function: same input → structurally identical output; never throws on
 * malformed input. Diagnostics are batched — at most one GraphDiagnostic per
 * code per pass, with a total count and at most DIAGNOSTIC_SAMPLE_CAP samples
 * (O(categories) work/allocation, never O(bad rows)).
 */

import {
  DIAGNOSTIC_SAMPLE_CAP,
  type AcceptedEdge,
  type AcceptedGraph,
  type DiagnosticCode,
  type DiagnosticSeverity,
  type EdgeId,
  type GraphDiagnostic,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type NodeId,
} from './types';
import { nextSynthesizedEdgeId } from './edgeIdentity';
import type { EdgePairCounters } from './edgeIdentity';

/** Per-code accumulator: one counter + capped samples, no per-row objects. */
interface Tally {
  count: number;
  samples: string[];
}

function newTally(): Tally {
  return { count: 0, samples: [] };
}

function record(tally: Tally, sampleId: string): void {
  tally.count++;
  if (tally.samples.length < DIAGNOSTIC_SAMPLE_CAP) tally.samples.push(sampleId);
}

function pushDiagnostic(
  out: GraphDiagnostic[],
  code: DiagnosticCode,
  severity: DiagnosticSeverity,
  tally: Tally,
  message: string,
): void {
  if (tally.count === 0) return;
  out.push({ code, severity, count: tally.count, sampleIds: tally.samples, message });
}

export function validateSnapshot<N = Record<string, unknown>, E = Record<string, unknown>>(
  snapshot: GraphSnapshot<N, E>,
): AcceptedGraph<N, E> {
  // Defensive: malformed callers may hand us non-arrays; never throw.
  const rawNodes: readonly unknown[] = Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const rawEdges: readonly unknown[] = Array.isArray(snapshot.edges) ? snapshot.edges : [];

  const invalidNode = newTally();
  const duplicateNode = newTally();
  const invalidEdge = newTally();
  const danglingEdge = newTally();
  const duplicateEdge = newTally();
  const selfLoop = newTally();

  // --- Nodes: first occurrence wins; accepted order = first-occurrence order.
  const nodes: GraphNode<N>[] = [];
  const nodeIndex = new Map<NodeId, number>();
  for (let i = 0; i < rawNodes.length; i++) {
    const row = rawNodes[i];
    const id =
      typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined;
    if (typeof id !== 'string') {
      // No usable id to sample — sample the row position instead.
      record(invalidNode, `[${i}]`);
      continue;
    }
    if (id.includes('\u0000')) {
      // U+0000 prefixes the internal scene-key codec
      // (collapsed-group super-nodes) — a caller id containing NUL could
      // collide with a synthetic key and corrupt scene indexing. Rejected
      // explicitly here instead of silently colliding.
      record(invalidNode, `[${i}]`);
      continue;
    }
    if (nodeIndex.has(id)) {
      record(duplicateNode, id);
      continue;
    }
    nodeIndex.set(id, nodes.length);
    nodes.push(row as GraphNode<N>);
  }

  // --- Edges.
  const edges: AcceptedEdge<E>[] = [];
  const edgeIds = new Set<EdgeId>();
  // Parallel-edge counter per ordered (source, target) pair. Nested maps keep
  // the keying collision-proof for arbitrary node id contents.
  const pairCounters: EdgePairCounters = new Map();

  for (let i = 0; i < rawEdges.length; i++) {
    const row = rawEdges[i];
    if (typeof row !== 'object' || row === null) {
      record(invalidEdge, `[${i}]`);
      continue;
    }
    const edge = row as { id?: unknown; source?: unknown; target?: unknown };
    const source = edge.source;
    const target = edge.target;
    if (typeof source !== 'string' || typeof target !== 'string') {
      record(invalidEdge, typeof edge.id === 'string' ? edge.id : `[${i}]`);
      continue;
    }
    if (typeof edge.id === 'string' && edge.id.includes('\u0000')) {
      // U+0000 prefixes the internal meta-edge scene-key codec. Physical
      // edge ids share the rendered edge-id lane with those synthetic rows,
      // so an explicit caller id in that namespace could alias a meta-edge.
      record(invalidEdge, `[${i}]`);
      continue;
    }
    if (!nodeIndex.has(source)) {
      record(danglingEdge, source);
      continue;
    }
    if (!nodeIndex.has(target)) {
      record(danglingEdge, target);
      continue;
    }

    const hasExplicitId = typeof edge.id === 'string';
    let id: EdgeId;
    if (hasExplicitId) {
      id = edge.id as EdgeId;
    } else {
      // Deterministic synthesis: k counts this ordered pair's synthesized
      // edges in first-occurrence order (a later duplicate drop does not
      // reclaim its k).
      id = nextSynthesizedEdgeId(pairCounters, source, target);
    }

    // First-wins over the FINAL id set — covers explicit/explicit,
    // synthesized/explicit, and synthesized/synthesized collisions alike.
    if (edgeIds.has(id)) {
      record(duplicateEdge, id);
      continue;
    }
    edgeIds.add(id);

    if (source === target) record(selfLoop, source);

    edges.push(
      hasExplicitId
        ? (row as AcceptedEdge<E>)
        : // `id` after the spread so it wins even if the input row carried an
          // explicit `id: undefined` key.
          { ...(row as GraphEdge<E>), id },
    );
  }

  const diagnostics: GraphDiagnostic[] = [];
  pushDiagnostic(
    diagnostics,
    'invalid-node',
    'error',
    invalidNode,
    `${invalidNode.count} node row(s) dropped: missing, non-string, or NUL-containing id`,
  );
  pushDiagnostic(
    diagnostics,
    'duplicate-node-id',
    'warning',
    duplicateNode,
    `${duplicateNode.count} duplicate node id(s) dropped (first occurrence wins)`,
  );
  pushDiagnostic(
    diagnostics,
    'invalid-edge',
    'error',
    invalidEdge,
    `${invalidEdge.count} edge row(s) dropped: missing or non-string source/target, or NUL-containing explicit id`,
  );
  pushDiagnostic(
    diagnostics,
    'dangling-edge-endpoint',
    'warning',
    danglingEdge,
    `${danglingEdge.count} edge(s) dropped: endpoint not in accepted node set`,
  );
  pushDiagnostic(
    diagnostics,
    'duplicate-edge-id',
    'warning',
    duplicateEdge,
    `${duplicateEdge.count} duplicate edge id(s) dropped (first occurrence wins)`,
  );
  pushDiagnostic(
    diagnostics,
    'self-loop-retained',
    'info',
    selfLoop,
    `${selfLoop.count} self-loop edge(s) retained`,
  );

  return {
    datasetKey: snapshot.datasetKey,
    sourceRevision: snapshot.sourceRevision,
    nodes,
    edges,
    nodeIndex,
    diagnostics,
  };
}
