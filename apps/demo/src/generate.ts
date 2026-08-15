/**
 * Seeded, deterministic clustered-graph generator for the demo app.
 *
 * Growth stability invariant: every node draws from its own rng stream seeded
 * by (seed, index), and only ever connects to LOWER-indexed nodes. Therefore
 * `generateGraph({...p, nodes: n + 500 })` is an exact superset of
 * `generateGraph({...p, nodes: n })` — same node ids, same edges, appended
 * tail — which is what the "Add 500 nodes" button relies on to exercise the
 * incremental diff and position preservation. (Degrees of existing nodes may
 * grow when new nodes attach to them; that is an attrs-only change.)
 */

import type { GraphEdge, GraphNode, GraphSnapshot } from '@modernrelay/orbit-core';

export interface DemoNodeAttrs {
  cluster: number;
  label: string;
  /** Computed after edge generation. */
  degree: number;
  /** Cluster-correlated pseudo-normal score (v0.7 histogram dimension). */
  score: number;
  /** Epoch ms inside a 180-day cluster-phased window (v0.7 timeline dimension). */
  createdAt: number;
}

export interface DemoEdgeAttrs {
  kind: 'intra' | 'inter';
}

export type DemoSnapshot = GraphSnapshot<DemoNodeAttrs, DemoEdgeAttrs>;

export interface GenerateParams {
  seed: number;
  nodes: number;
  clusters: number;
  /** Average intra-cluster edges created per node (e.g. 1.6). */
  intraEdgeFactor: number;
  /** Probability a node also gets one inter-cluster bridge edge. */
  interEdgeProb: number;
  datasetKey: string;
  sourceRevision: number | string;
}

export const DEFAULT_GENERATE = {
  nodes: 3000,
  clusters: 6,
  intraEdgeFactor: 1.6,
  interEdgeProb: 0.06,
} as const;

/** Classic mulberry32 PRNG — 32-bit state, deterministic across platforms. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic LCG step used by the UI to advance to a fresh seed. */
export function nextSeed(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

/** Independent per-node stream seed so edge draws never depend on node count. */
function nodeStreamSeed(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const CLUSTER_NAMES = ['alpha', 'bravo', 'coral', 'delta', 'ember', 'fjord', 'gale', 'helix'];

export function clusterName(cluster: number): string {
  return CLUSTER_NAMES[cluster % CLUSTER_NAMES.length] ?? `k${cluster}`;
}

const idOf = (i: number): string => `n${i}`;

// --- v0.7 metric attrs for the filtering demo -------------------------------

const DAY_MS = 86_400_000;
/** Fixed window end (2026-06-30T00:00:00Z) — deterministic, never Date.now. */
export const CREATED_AT_END_MS = Date.UTC(2026, 5, 30);
export const CREATED_AT_SPAN_DAYS = 180;
export const CREATED_AT_START_MS = CREATED_AT_END_MS - CREATED_AT_SPAN_DAYS * DAY_MS;
/** Width of each cluster's createdAt window (overlapping phases). */
const CREATED_AT_PHASE_DAYS = 60;

/**
 * Deterministic per-node metric attrs, on an INDEPENDENT rng stream (salted
 * node-stream seed) so edge draws stay byte-identical to pre-v0.7 output and
 * the superset invariant is untouched — metrics depend only on
 * (seed, index, cluster, clusters).
 *
 * `score`: cluster-correlated pseudo-normal (sum of three uniforms) around a
 * cluster mean spread across ~15..85, clamped to [0, 100].
 * `createdAt`: cluster-PHASED across the 180-day window — cluster k's window
 * starts at k · (span − phase)/(clusters − 1) days — so a timeline sweep
 * lights the clusters up in order, with overlap.
 */
export function nodeMetrics(
  seed: number,
  index: number,
  cluster: number,
  clusters: number,
): { score: number; createdAt: number } {
  const rng = mulberry32(nodeStreamSeed(seed ^ 0x5f356495, index));
  const spread = Math.max(1, clusters - 1);
  const mean = 15 + (70 * (cluster % clusters)) / spread;
  const noise = (rng() + rng() + rng() - 1.5) * 12;
  const score = Math.round(Math.min(100, Math.max(0, mean + noise)) * 100) / 100;
  const phaseDays = ((cluster % clusters) * (CREATED_AT_SPAN_DAYS - CREATED_AT_PHASE_DAYS)) / spread;
  const createdAt = Math.round(
    CREATED_AT_START_MS + (phaseDays + rng() * CREATED_AT_PHASE_DAYS) * DAY_MS,
  );
  return { score, createdAt };
}

export function generateGraph(p: GenerateParams): DemoSnapshot {
  const { seed, nodes: n, clusters, intraEdgeFactor, interEdgeProb } = p;
  const edges: GraphEdge<DemoEdgeAttrs>[] = [];
  const degree: number[] = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const rng = mulberry32(nodeStreamSeed(seed, i));
    const cluster = i % clusters;

    // Intra-cluster edges to earlier nodes of the same cluster (cluster = i % clusters,
    // so earlier peers are exactly i - clusters*m for m in [1.. floor(i/clusters)]).
    const earlierPeers = Math.floor(i / clusters);
    if (earlierPeers > 0) {
      const frac = intraEdgeFactor % 1;
      const k = Math.max(1, Math.floor(intraEdgeFactor) + (rng() < frac ? 1 : 0));
      const chosen = new Set<number>();
      for (let e = 0; e < k; e++) {
        const m = 1 + Math.floor(rng() * earlierPeers);
        const j = i - clusters * m;
        if (chosen.has(j)) continue;
        chosen.add(j);
        edges.push({ source: idOf(j), target: idOf(i), attrs: { kind: 'intra' } });
        degree[j] = (degree[j] ?? 0) + 1;
        degree[i] = (degree[i] ?? 0) + 1;
      }
    }

    // Occasional inter-cluster bridge to an earlier node of a different cluster.
    if (i > 0 && rng() < interEdgeProb) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const j = Math.floor(rng() * i);
        if (j % clusters !== cluster) {
          edges.push({ source: idOf(j), target: idOf(i), attrs: { kind: 'inter' } });
          degree[j] = (degree[j] ?? 0) + 1;
          degree[i] = (degree[i] ?? 0) + 1;
          break;
        }
      }
    }
  }

  const nodes: GraphNode<DemoNodeAttrs>[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const cluster = i % clusters;
    const { score, createdAt } = nodeMetrics(seed, i, cluster, clusters);
    nodes[i] = {
      id: idOf(i),
      attrs: {
        cluster,
        label: `${clusterName(cluster)}-${String(i).padStart(4, '0')}`,
        degree: degree[i] ?? 0,
        score,
        createdAt,
      },
    };
  }

  return {
    datasetKey: p.datasetKey,
    sourceRevision: p.sourceRevision,
    nodes,
    edges,
  };
}
