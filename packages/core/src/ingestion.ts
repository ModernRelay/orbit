/**
 * revisioned ingestion — pure session/overlay bookkeeping plus the
 * instance-local acceptance queue.
 *
 * Everything here is data-structure work: no store, no engine, no DOM. The
 * GraphInstance wires these helpers into its publication path (instance.ts).
 *
 * Ordering model: every admission takes a monotonically increasing ticket from
 * the instance's AcceptanceQueue. Overlay rows are stamped with their
 * admission ticket, and the merge folds base + overlays strictly in ticket
 * order — arrival at the queue IS the global admission order.
 */

import { DIAGNOSTIC_SAMPLE_CAP } from './types';
import { nextSynthesizedEdgeId } from './edgeIdentity';
import type { EdgePairCounters } from './edgeIdentity';
import type {
  AcceptedEdge,
  AcceptedGraph,
  GraphDiagnostic,
  GraphEdge,
  GraphNode,
  IngestBatch,
  NodeId,
} from './types';

// ---------------------------------------------------------------------------
// Protocol defaults.
// ---------------------------------------------------------------------------

/** Byte backpressure budget default: 8 MiB of admitted-but-unflushed payload. */
export const INGEST_MAX_PENDING_BYTES_DEFAULT = 8_388_608;
/** Progressive-overlay coalesced flush latency cap default (ms). */
export const INGEST_MAX_FLUSH_LATENCY_MS_DEFAULT = 50;
/** A single batch larger than `factor × maxPendingBytes` rejects outright. */
export const INGEST_OVERFLOW_FACTOR = 4;

// ---------------------------------------------------------------------------
// Acceptance queue. One per instance: EVERY state publication
// applyHostUpdate, session admissions/flushes/commits/aborts, overlay
// removals, and (wave 2) service admissions — routes through it. Arrival at
// the queue defines the global admission order. v0.5 executes jobs
// synchronously in arrival order (no workers yet); the object exists as the
// serialization seam wave 2 builds on.
// ---------------------------------------------------------------------------

export class AcceptanceQueue {
  private ticket = 0;
  /** Depth guard: admissions made from inside a job run nested — arrival
   * order still equals call order under synchronous execution. */
  private depth = 0;

  /** Total admissions so far (the global admission-order clock). */
  get admissions(): number {
    return this.ticket;
  }

  /** True while a job admitted by this queue is executing. */
  get active(): boolean {
    return this.depth > 0;
  }

  /** Take the next admission-order ticket without running a job (row stamps). */
  nextTicket(): number {
    return ++this.ticket;
  }

  /**
   * Admit a job at the tail of the global order and execute it synchronously.
   * Exceptions propagate to the admitter (v0.5 synchronous execution).
   */
  admit<T>(job: () => T): T {
    this.ticket++;
    this.depth++;
    try {
      return job();
    } finally {
      this.depth--;
    }
  }
}

// ---------------------------------------------------------------------------
// Byte accounting.
// ---------------------------------------------------------------------------

/** Fallback per-row estimate when a payload cannot be JSON-serialized. */
const ROW_BYTE_FALLBACK = 64;

/** `batch.bytes` when declared, else a rough JSON estimate of the payload. */
export function estimateBatchBytes(batch: IngestBatch<unknown, unknown>): number {
  const declared = batch.bytes;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared >= 0) {
    return declared;
  }
  let total = 0;
  if (batch.nodes !== undefined) {
    try {
      total += JSON.stringify(batch.nodes).length;
    } catch {
      total += batch.nodes.length * ROW_BYTE_FALLBACK;
    }
  }
  if (batch.edges !== undefined) {
    try {
      total += JSON.stringify(batch.edges).length;
    } catch {
      total += batch.edges.length * ROW_BYTE_FALLBACK;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Row tallies — batched accounting for commit-time diagnostics.
// ---------------------------------------------------------------------------

export interface RowTally {
  count: number;
  samples: string[];
}

export function newRowTally(): RowTally {
  return { count: 0, samples: [] };
}

function recordRow(tally: RowTally, sampleId: string): void {
  tally.count++;
  if (tally.samples.length < DIAGNOSTIC_SAMPLE_CAP) tally.samples.push(sampleId);
}

/** Per-session staging tallies; surfaced as diagnostics ONLY at commit. */
export interface StagingTallies {
  invalidNodes: RowTally;
  duplicateNodes: RowTally;
  invalidEdges: RowTally;
  duplicateEdges: RowTally;
}

export function newStagingTallies(): StagingTallies {
  return {
    invalidNodes: newRowTally(),
    duplicateNodes: newRowTally(),
    invalidEdges: newRowTally(),
    duplicateEdges: newRowTally(),
  };
}

// ---------------------------------------------------------------------------
// Session contribution — the per-session tag index.
// Retains the FULL admitted row set (shadowed rows included) so abort and
// removeOverlay can remove exactly this session's rows, never a whole-scene
// checkpoint.
// ---------------------------------------------------------------------------

export interface StampedNode<N> {
  /** Global admission-order ticket (queue arrival). */
  readonly order: number;
  readonly node: GraphNode<N>;
}

export interface StampedEdge<E> {
  readonly order: number;
  readonly edge: AcceptedEdge<E>;
}

export interface SessionContribution<N = Record<string, unknown>, E = Record<string, unknown>> {
  readonly overlayId: string;
  /** Session-deduped admitted node rows in admission order. */
  readonly nodes: StampedNode<N>[];
  /** Session-deduped admitted edge records (ids resolved) in admission order. */
  readonly edges: StampedEdge<E>[];
  readonly nodeIds: Set<NodeId>;
  readonly edgeIds: Set<string>;
  /** Exact ordered endpoint tuple → next synthesized-parallel-edge k. */
  readonly pairCounters: EdgePairCounters;
  /** Public prefix lengths: rows before these counts have been published
   * (progressive flush / commit); appends only grow the arrays, so a prefix
   * is sufficient. Atomic sessions stay at 0 until commit. */
  publicNodeCount: number;
  publicEdgeCount: number;
}

export function newContribution<N, E>(overlayId: string): SessionContribution<N, E> {
  return {
    overlayId,
    nodes: [],
    edges: [],
    nodeIds: new Set(),
    edgeIds: new Set(),
    pairCounters: new Map(),
    publicNodeCount: 0,
    publicEdgeCount: 0,
  };
}

export interface StageResult {
  admittedNodes: number;
  admittedEdges: number;
}

/**
 * Validate and stage one batch's rows into a session contribution.
 *
 * Object-lane-equivalent row validation WITHOUT endpoint checks — edges may arrive
 * before nodes: they occupy their eventual edge records here; endpoint
 * resolution happens at merge. Within a session, duplicate ids are
 * first-wins-dropped (tallied for commit diagnostics); cross-session
 * collisions are the merge's shadowing concern, not staging's.
 */
export function stageBatch<N, E>(
  contribution: SessionContribution<N, E>,
  batch: IngestBatch<N, E>,
  tallies: StagingTallies,
  nextOrder: () => number,
): StageResult {
  let admittedNodes = 0;
  let admittedEdges = 0;

  const rawNodes: readonly unknown[] =
    batch.nodes !== undefined && Array.isArray(batch.nodes) ? batch.nodes : [];
  for (let i = 0; i < rawNodes.length; i++) {
    const row = rawNodes[i];
    const id = typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || id.includes('\u0000')) {
      // U+0000 is reserved by the scene-key codec for collapsed-group
      // super-nodes. Streaming ingestion must enforce the same namespace
      // boundary as declarative snapshot validation; otherwise an overlay
      // row can collide with a synthetic scene row during group rewrite.
      recordRow(tallies.invalidNodes, `[${batch.sequence}:${i}]`);
      continue;
    }
    if (contribution.nodeIds.has(id)) {
      recordRow(tallies.duplicateNodes, id);
      continue;
    }
    contribution.nodeIds.add(id);
    contribution.nodes.push({ order: nextOrder(), node: row as GraphNode<N> });
    admittedNodes++;
  }

  const rawEdges: readonly unknown[] =
    batch.edges !== undefined && Array.isArray(batch.edges) ? batch.edges : [];
  for (let i = 0; i < rawEdges.length; i++) {
    const row = rawEdges[i];
    if (typeof row !== 'object' || row === null) {
      recordRow(tallies.invalidEdges, `[${batch.sequence}:${i}]`);
      continue;
    }
    const edge = row as { id?: unknown; source?: unknown; target?: unknown };
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') {
      recordRow(tallies.invalidEdges, typeof edge.id === 'string' ? edge.id : `[${batch.sequence}:${i}]`);
      continue;
    }
    if (typeof edge.id === 'string' && edge.id.includes('\u0000')) {
      // Explicit edge ids occupy the same rendered id lane as internal
      // meta-edge scene keys, whose reserved namespace begins with U+0000.
      recordRow(tallies.invalidEdges, `[${batch.sequence}:${i}]`);
      continue;
    }
    const hasExplicitId = typeof edge.id === 'string';
    let id: string;
    if (hasExplicitId) {
      id = edge.id as string;
    } else {
      // synthesis scheme with SESSION-scoped pair counters: deterministic
      // and stable per session. A synthesized id colliding with the base's
      // (or another overlay's) same-pair id is dropped at merge as a
      // duplicate — callers wanting cross-source parallel edges must use
      // their single explicit edge-id scheme.
      id = nextSynthesizedEdgeId(
        contribution.pairCounters,
        edge.source,
        edge.target,
      );
    }
    if (contribution.edgeIds.has(id)) {
      recordRow(tallies.duplicateEdges, id);
      continue;
    }
    contribution.edgeIds.add(id);
    const record: AcceptedEdge<E> = hasExplicitId
      ? (row as AcceptedEdge<E>)
      : { ...(row as GraphEdge<E>), id };
    contribution.edges.push({ order: nextOrder(), edge: record });
    admittedEdges++;
  }

  return { admittedNodes, admittedEdges };
}

// ---------------------------------------------------------------------------
// Merge — overlays layered over the accepted base in global admission order
// with edge-before-node endpoint resolution.
// ---------------------------------------------------------------------------

/** The accepted base (declarative snapshot or committed replace session). */
export interface MergeBase<N = Record<string, unknown>, E = Record<string, unknown>> {
  datasetKey: string;
  sourceRevision: number | string;
  nodes: readonly GraphNode<N>[];
  /** id → position in `nodes`. */
  nodeIndex: ReadonlyMap<NodeId, number>;
  /** Endpoint-resolved base edges. */
  edges: readonly AcceptedEdge<E>[];
  /** Replace-session bases retain edge records whose endpoints were missing
   * at commit; a later overlay node can still resolve them. */
  pendingEdges: readonly StampedEdge<E>[];
  diagnostics: readonly GraphDiagnostic[];
}

/** Sentinel owner key for base pending edges in `pendingBySource`. */
export const BASE_PENDING_KEY = '';

export interface MergeResult<N = Record<string, unknown>, E = Record<string, unknown>> {
  accepted: AcceptedGraph<N, E>;
  /** Overlay node rows shadowed by an earlier admission (base included). */
  shadowedCount: number;
  shadowedSamples: readonly string[];
  /** Later same-id edge records dropped (first admission wins). */
  duplicateEdgeCount: number;
  duplicateEdgeSamples: readonly string[];
  /** overlayId (or BASE_PENDING_KEY) → edges still awaiting an endpoint. The
   * pending-endpoint index: these occupy edge records but never enter the
   * engine link buffer. */
  pendingBySource: ReadonlyMap<string, number>;
  pendingEdgeCount: number;
}

export function baseFromAccepted<N, E>(accepted: AcceptedGraph<N, E>): MergeBase<N, E> {
  return {
    datasetKey: accepted.datasetKey,
    sourceRevision: accepted.sourceRevision,
    nodes: accepted.nodes,
    nodeIndex: accepted.nodeIndex,
    edges: accepted.edges,
    pendingEdges: [],
    diagnostics: accepted.diagnostics,
  };
}

/**
 * Build a MergeBase from a replace session's staged contribution. Edges whose
 * endpoints exist in the session's own node set resolve immediately; the rest
 * stay pending (they may resolve through later overlays).
 */
export function baseFromContribution<N, E>(
  datasetKey: string,
  sourceRevision: number | string,
  contribution: SessionContribution<N, E>,
  diagnostics: readonly GraphDiagnostic[],
): MergeBase<N, E> {
  const nodes: GraphNode<N>[] = new Array(contribution.nodes.length);
  const nodeIndex = new Map<NodeId, number>();
  for (let i = 0; i < contribution.nodes.length; i++) {
    const node = contribution.nodes[i]!.node;
    nodes[i] = node;
    nodeIndex.set(node.id, i);
  }
  const edges: AcceptedEdge<E>[] = [];
  const pendingEdges: StampedEdge<E>[] = [];
  for (const se of contribution.edges) {
    if (nodeIndex.has(se.edge.source) && nodeIndex.has(se.edge.target)) {
      edges.push(se.edge);
    } else {
      pendingEdges.push(se);
    }
  }
  return { datasetKey, sourceRevision, nodes, nodeIndex, edges, pendingEdges, diagnostics };
}

interface OwnedStampedEdge<E> {
  readonly order: number;
  readonly edge: AcceptedEdge<E>;
  readonly owner: string;
}

/**
 * Merge the accepted base with every overlay contribution's PUBLIC rows.
 *
 * - Node collisions: earliest admission (ticket order; base first) wins.
 * Later rows stay retained-but-shadowed in their contribution and are
 * tallied for the single count-aggregated 'overlay-node-shadowed' info
 * diagnostic.
 * - Edge ids: first admission wins; later same-id records are dropped
 * (tallied). An edge whose endpoints are not all present in the merged
 * node set is pending — it occupies its record and the pending-endpoint
 * accounting but is excluded from `accepted.edges` (and therefore from the
 * engine link buffer). Endpoints arriving later resolve it on the next
 * merge (same or different batch/overlay).
 *
 * Deterministic: output depends only on the base and the stamped rows.
 */
export function mergeModel<N, E>(
  base: MergeBase<N, E>,
  overlays: readonly SessionContribution<N, E>[],
): MergeResult<N, E> {
  // --- nodes: base first (earliest admission), then overlay rows by ticket.
  const nodes: GraphNode<N>[] = [...base.nodes];
  const nodeIndex = new Map<NodeId, number>(base.nodeIndex);
  const stampedNodes: StampedNode<N>[] = [];
  for (const c of overlays) {
    for (let i = 0; i < c.publicNodeCount; i++) stampedNodes.push(c.nodes[i]!);
  }
  stampedNodes.sort((a, b) => a.order - b.order);
  const shadowed = newRowTally();
  for (const sn of stampedNodes) {
    const id = sn.node.id;
    if (nodeIndex.has(id)) {
      recordRow(shadowed, id);
      continue;
    }
    nodeIndex.set(id, nodes.length);
    nodes.push(sn.node);
  }

  // --- edges: base resolved edges first, then base pending + overlay edges
  // in ticket order, deduped by id and endpoint-resolved against the merged
  // node set.
  const edges: AcceptedEdge<E>[] = [...base.edges];
  const edgeIds = new Set<string>();
  for (const e of base.edges) edgeIds.add(e.id);

  const stampedEdges: OwnedStampedEdge<E>[] = [];
  for (const se of base.pendingEdges) {
    stampedEdges.push({ order: se.order, edge: se.edge, owner: BASE_PENDING_KEY });
  }
  for (const c of overlays) {
    for (let i = 0; i < c.publicEdgeCount; i++) {
      const se = c.edges[i]!;
      stampedEdges.push({ order: se.order, edge: se.edge, owner: c.overlayId });
    }
  }
  stampedEdges.sort((a, b) => a.order - b.order);

  const duplicates = newRowTally();
  const pendingBySource = new Map<string, number>();
  let pendingEdgeCount = 0;
  for (const se of stampedEdges) {
    const edge = se.edge;
    if (edgeIds.has(edge.id)) {
      recordRow(duplicates, edge.id);
      continue;
    }
    edgeIds.add(edge.id);
    if (nodeIndex.has(edge.source) && nodeIndex.has(edge.target)) {
      edges.push(edge);
    } else {
      pendingBySource.set(se.owner, (pendingBySource.get(se.owner) ?? 0) + 1);
      pendingEdgeCount++;
    }
  }

  const accepted: AcceptedGraph<N, E> = {
    datasetKey: base.datasetKey,
    sourceRevision: base.sourceRevision,
    nodes,
    edges,
    nodeIndex,
    diagnostics: base.diagnostics,
  };
  return {
    accepted,
    shadowedCount: shadowed.count,
    shadowedSamples: shadowed.samples,
    duplicateEdgeCount: duplicates.count,
    duplicateEdgeSamples: duplicates.samples,
    pendingBySource,
    pendingEdgeCount,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics builders.
// ---------------------------------------------------------------------------

/** Recomputed per merge: ONE count-aggregated shadow info + edge-dedupe note. */
export function mergeDiagnostics(merge: MergeResult<unknown, unknown>): GraphDiagnostic[] {
  const out: GraphDiagnostic[] = [];
  if (merge.shadowedCount > 0) {
    out.push({
      code: 'overlay-node-shadowed',
      severity: 'info',
      count: merge.shadowedCount,
      sampleIds: merge.shadowedSamples,
      message: `${merge.shadowedCount} overlay node row(s) shadowed by a same-id row admitted earlier; rows retained`,
    });
  }
  if (merge.duplicateEdgeCount > 0) {
    out.push({
      code: 'duplicate-edge-id',
      severity: 'warning',
      count: merge.duplicateEdgeCount,
      sampleIds: merge.duplicateEdgeSamples,
      message: `${merge.duplicateEdgeCount} overlay edge record(s) dropped: id already admitted (first admission wins)`,
    });
  }
  return out;
}

/**
 * Commit-time diagnostics for one session: staging tallies plus the dangling
 * (still-pending-endpoint) count — emitted ONLY at session commit.
 */
export function sessionCommitDiagnostics(
  tallies: StagingTallies,
  danglingCount: number,
  danglingSamples: readonly string[] = [],
): GraphDiagnostic[] {
  const out: GraphDiagnostic[] = [];
  const push = (
    code: GraphDiagnostic['code'],
    severity: GraphDiagnostic['severity'],
    tally: RowTally,
    message: string,
  ): void => {
    if (tally.count === 0) return;
    out.push({ code, severity, count: tally.count, sampleIds: tally.samples, message });
  };
  push(
    'invalid-node',
    'error',
    tallies.invalidNodes,
    `${tallies.invalidNodes.count} ingested node row(s) dropped: missing, non-string, or NUL-containing id`,
  );
  push(
    'duplicate-node-id',
    'warning',
    tallies.duplicateNodes,
    `${tallies.duplicateNodes.count} duplicate node id(s) dropped within the session (first occurrence wins)`,
  );
  push(
    'invalid-edge',
    'error',
    tallies.invalidEdges,
    `${tallies.invalidEdges.count} ingested edge row(s) dropped: missing or non-string source/target, or NUL-containing explicit id`,
  );
  push(
    'duplicate-edge-id',
    'warning',
    tallies.duplicateEdges,
    `${tallies.duplicateEdges.count} duplicate edge id(s) dropped within the session (first occurrence wins)`,
  );
  if (danglingCount > 0) {
    out.push({
      code: 'dangling-edge-endpoint',
      severity: 'warning',
      count: danglingCount,
      sampleIds: danglingSamples.slice(0, DIAGNOSTIC_SAMPLE_CAP),
      message: `${danglingCount} ingested edge(s) still awaiting an endpoint at commit (the endpoint was not ingested before the session committed)`,
    });
  }
  return out;
}
