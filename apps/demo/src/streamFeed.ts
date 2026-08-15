/**
 * Deterministic NDJSON-style streaming feed for the ingestion demo.
 *
 * `generateStreamFeed` yields batches of NDJSON lines (node rows first, then
 * edge rows referencing only already-emitted nodes) — mulberry32-seeded, so
 * the same `{seed, rows}` always produces the identical feed, and
 * cluster-structured (cluster = index % STREAM_CLUSTERS) so "Isolate cluster"
 * has real communities to scope to.
 *
 * `runStreamFeed` drives the feed through a `purpose:'replace'`
 * IngestSession against a fresh `stream-<seed>` datasetKey. Byte
 * backpressure is honored the way: every `append` receipt is awaited
 * before the next batch is sent. A replace session is atomic — receipts
 * resolve at byte admission while the session stays under `maxPendingBytes`
 * and nothing publishes until commit — so the budget is sized for the FULL
 * atomic payload (an atomic session only drains at commit; a smaller budget
 * would park receipts until then).
 */

import type {
  AppendReceipt,
  BeginIngestOptions,
  GraphEdge,
  GraphNode,
  IngestBatch,
  IngestSession,
  Revisions,
} from '@modernrelay/orbit-core';

import { clusterName, mulberry32, nodeMetrics } from './generate';
import type { DemoEdgeAttrs, DemoNodeAttrs } from './generate';

export const STREAM_CLUSTERS = 8;
export const STREAM_BATCH_ROWS = 2_000;
/** Default feed size: ~200K node rows + 50K edge rows. */
export const STREAM_ROWS_DEFAULT = 250_000;
/** Node share of the row budget (the rest are edge rows). */
const NODE_ROW_SHARE = 0.8;
/** Probability an edge row bridges clusters instead of staying intra. */
const INTER_CLUSTER_PROB = 0.06;
/** Atomic-payload byte budget — see the module doc for why it must cover the
 * whole feed (replace sessions drain only at commit). */
const STREAM_MAX_PENDING_BYTES = 128 * 1024 * 1024;

/** Clamp an optional node-share override (perf tiers need 100K/250K
 * share 2/7 — which the fixed 4:1 default cannot reach). */
export function clampNodeShare(share: number | undefined): number {
  if (share === undefined || !Number.isFinite(share)) return NODE_ROW_SHARE;
  return Math.min(0.95, Math.max(0.05, share));
}

export function streamNodeTotal(rows: number, nodeShare?: number): number {
  return Math.max(1, Math.round(rows * clampNodeShare(nodeShare)));
}

export function streamEdgeTotal(rows: number, nodeShare?: number): number {
  return Math.max(0, rows - streamNodeTotal(rows, nodeShare));
}

const idOf = (i: number): string => `s${i}`;

/** Node ids of one stream cluster (deterministic: cluster = i % clusters). */
export function streamClusterNodeIds(rows: number, cluster: number, nodeShare?: number): string[] {
  const n = streamNodeTotal(rows, nodeShare);
  const ids: string[] = [];
  for (let i = ((cluster % STREAM_CLUSTERS) + STREAM_CLUSTERS) % STREAM_CLUSTERS; i < n; i += STREAM_CLUSTERS) {
    ids.push(idOf(i));
  }
  return ids;
}

/**
 * The deterministic feed: an async iterable of NDJSON-line batches
 * (STREAM_BATCH_ROWS rows each; the final batch may be short).
 */
/** Generator families, all deterministic per seed:
 * 'clustered' (the historical feed: round-robin clusters, mostly
 * intra-cluster edges), 'sparse' (uniform endpoints), 'powerlaw'
 * (quadratically biased to early nodes — hub-heavy degree tails). */
export type StreamFamily = 'clustered' | 'sparse' | 'powerlaw';

export function clampFamily(raw: string | null | undefined): StreamFamily {
  return raw === 'sparse' || raw === 'powerlaw' ? raw : 'clustered';
}

export async function* generateStreamFeed(
  seed: number,
  rows: number,
  nodeShare?: number,
  family: StreamFamily = 'clustered',
): AsyncGenerator<readonly string[], void, undefined> {
  const nodeTotal = streamNodeTotal(rows, nodeShare);
  const edgeTotal = streamEdgeTotal(rows, nodeShare);
  const rng = mulberry32(seed);
  let batch: string[] = [];

  for (let i = 0; i < nodeTotal; i++) {
    const cluster = i % STREAM_CLUSTERS;
    // v0.7 metric attrs ride the feed too, so the streamed L-tier graph has
    // real histogram/timeline dimensions (same deterministic helper as the
    // declarative generator).
    const { score, createdAt } = nodeMetrics(seed, i, cluster, STREAM_CLUSTERS);
    batch.push(
      `{"type":"node","id":"${idOf(i)}","cluster":${cluster},"label":"${clusterName(cluster)}-${i}","score":${score},"createdAt":${createdAt}}`,
    );
    if (batch.length === STREAM_BATCH_ROWS) {
      yield batch;
      batch = [];
    }
  }
  for (let e = 0; e < edgeTotal; e++) {
    // Target any node but s0; source an earlier node — mostly a same-cluster
    // peer, occasionally a cross-cluster bridge. Earlier-only sources mean
    // no edge ever dangles at commit.
    const t = 1 + Math.floor(rng() * (nodeTotal - 1));
    let s: number;
    if (family === 'sparse') {
      // Uniform earlier endpoint — no community or degree structure.
      s = Math.floor(rng() * t);
    } else if (family === 'powerlaw') {
      // Quadratic bias toward early nodes: early ids accumulate degree,
      // producing the hub-heavy tail without a degree ledger (cheap
      // preferential-attachment approximation, still seed-deterministic).
      s = Math.floor(rng() * rng() * t);
    } else {
      const earlierPeers = Math.floor(t / STREAM_CLUSTERS);
      const intra = earlierPeers > 0 && rng() >= INTER_CLUSTER_PROB;
      s = intra
        ? t - STREAM_CLUSTERS * (1 + Math.floor(rng() * earlierPeers))
        : Math.floor(rng() * t);
    }
    batch.push(`{"type":"edge","source":"${idOf(s)}","target":"${idOf(t)}"}`);
    if (batch.length === STREAM_BATCH_ROWS) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

interface StreamNodeRow {
  type: 'node';
  id: string;
  cluster: number;
  label: string;
  score: number;
  createdAt: number;
}

interface StreamEdgeRow {
  type: 'edge';
  source: string;
  target: string;
}

type StreamRow = StreamNodeRow | StreamEdgeRow;

export type StreamPhase = 'streaming' | 'committed' | 'aborted';

/** LIVE meter payload — built from append/commit receipts. */
export interface StreamProgress {
  phase: StreamPhase;
  /** Rows admitted so far (nodes + edges). */
  rows: number;
  nodes: number;
  edges: number;
  batches: number;
  /** Bytes admitted but not yet flushed, from the latest receipt. */
  pendingBytes: number;
  elapsedMs: number;
}

/** The slice of GraphHandle/GraphInstance the driver needs. */
export interface StreamIngestHost {
  beginIngest(opts: BeginIngestOptions): IngestSession<DemoNodeAttrs, DemoEdgeAttrs>;
  getRevisions(): Revisions;
}

export interface RunStreamFeedOptions {
  seed: number;
  /** Total feed rows (nodes + edges). */
  rows: number;
  /** generator family (default 'clustered'). */
  family?: StreamFamily;
  /** Optional node-row share override (default 0.8; clamped 0.05–0.95).
   * Perf tiers use it to hit exact node/edge cardinalities (L =
   * 100K/250K → rows 350000, share 2/7). */
  nodeShare?: number | undefined;
  /** Receives throttled meter updates plus the terminal state. */
  onProgress: (progress: StreamProgress) => void;
  /** Polled between batches; true aborts the session (phase 'aborted'). */
  shouldCancel?: () => boolean;
  /** Meter cadence in ms (receipts arrive far faster). Default 100. */
  throttleMs?: number;
}

const now = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/**
 * Stream the feed through one replace IngestSession. Resolves with the
 * terminal progress ('committed', or 'aborted' when cancelled); rejects on a
 * session/protocol failure after aborting the session.
 */
export async function runStreamFeed(
  host: StreamIngestHost,
  opts: RunStreamFeedOptions,
): Promise<StreamProgress> {
  const throttleMs = opts.throttleMs ?? 100;
  const session = host.beginIngest({
    purpose: 'replace',
    datasetKey: `stream-${opts.seed}`,
    sourceRevision: 1,
    baseModelRevision: host.getRevisions().model,
    maxPendingBytes: STREAM_MAX_PENDING_BYTES,
  });

  const started = now();
  const progress: StreamProgress = {
    phase: 'streaming',
    rows: 0,
    nodes: 0,
    edges: 0,
    batches: 0,
    pendingBytes: 0,
    elapsedMs: 0,
  };
  let lastEmitAt = Number.NEGATIVE_INFINITY;
  const emit = (force: boolean): void => {
    progress.elapsedMs = now() - started;
    if (!force && progress.elapsedMs - lastEmitAt < throttleMs) return;
    lastEmitAt = progress.elapsedMs;
    opts.onProgress({ ...progress });
  };

  let sequence = 0;
  try {
    for await (const lines of generateStreamFeed(opts.seed, opts.rows, opts.nodeShare, opts.family)) {
      if (opts.shouldCancel?.() === true) {
        await session.abort('cancelled by the host').catch(() => {});
        progress.phase = 'aborted';
        emit(true);
        return { ...progress };
      }
      const nodes: GraphNode<DemoNodeAttrs>[] = [];
      const edges: GraphEdge<DemoEdgeAttrs>[] = [];
      let bytes = 0;
      for (const line of lines) {
        bytes += line.length + 1; // + '\n' — NDJSON framing
        const row = JSON.parse(line) as StreamRow;
        if (row.type === 'node') {
          nodes.push({
            id: row.id,
            attrs: {
              cluster: row.cluster,
              label: row.label,
              degree: 0,
              score: row.score,
              createdAt: row.createdAt,
            },
          });
        } else {
          edges.push({ source: row.source, target: row.target });
        }
      }
      const batch: IngestBatch<DemoNodeAttrs, DemoEdgeAttrs> = {
        sequence,
        batchId: `feed-${opts.seed}-${sequence}`,
        bytes,
      };
      if (nodes.length > 0) batch.nodes = nodes;
      if (edges.length > 0) batch.edges = edges;
      // backpressure: never send batch n+1 before receipt n resolves.
      const receipt: AppendReceipt = await session.append(batch);
      sequence += 1;
      progress.rows += receipt.admittedNodes + receipt.admittedEdges;
      progress.nodes += receipt.admittedNodes;
      progress.edges += receipt.admittedEdges;
      progress.batches += 1;
      progress.pendingBytes = receipt.pendingBytes;
      emit(false);
      // Yield a macrotask so the meter (and the rest of the UI) can paint.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    const committed = await session.commit();
    progress.phase = 'committed';
    progress.nodes = committed.admittedNodes;
    progress.edges = committed.admittedEdges;
    progress.rows = committed.admittedNodes + committed.admittedEdges;
    progress.pendingBytes = 0;
    emit(true);
    return { ...progress };
  } catch (err) {
    await session.abort(err).catch(() => {});
    progress.phase = 'aborted';
    emit(true);
    throw err;
  }
}
