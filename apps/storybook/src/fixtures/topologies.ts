/**
 * Deterministic topology fixtures. Every generator emits DemoNodeAttrs-shaped
 * attrs (cluster, label, degree, score, createdAt), so the color scales,
 * crossfilter dimensions, and search index compose with EVERY shape. Fixed-
 * layout topologies additionally declare exact x/y positions.
 */

import type { GraphEdge, GraphNode } from '@modernrelay/orbit-core';
import { generateGraph, mulberry32, nodeMetrics } from './generate';
import type { DemoEdgeAttrs, DemoNodeAttrs, DemoSnapshot } from './generate';

export type TopologyKind =
  | 'clustered'
  | 'tree'
  | 'scale-free'
  | 'bipartite'
  | 'ring'
  | 'islands';

const idOf = (i: number): string => `n${i}`;

interface BuildArgs {
  seed: number;
  n: number;
  datasetKey: string;
  /** node index → cluster id (drives color + labels) */
  clusterOf: (i: number) => number;
  clusters: number;
  edges: GraphEdge<DemoEdgeAttrs>[];
  degree: Uint32Array;
  positions?: (i: number) => readonly [number, number];
}

function build(args: BuildArgs): DemoSnapshot {
  const nodes: GraphNode<DemoNodeAttrs>[] = new Array(args.n);
  for (let i = 0; i < args.n; i++) {
    const cluster = args.clusterOf(i);
    const { score, createdAt } = nodeMetrics(args.seed, i, cluster, args.clusters);
    const node: GraphNode<DemoNodeAttrs> = {
      id: idOf(i),
      attrs: {
        cluster,
        label: `${args.datasetKey}-${String(i).padStart(4, '0')}`,
        degree: args.degree[i] ?? 0,
        score,
        createdAt,
      },
    };
    if (args.positions !== undefined) {
      const [x, y] = args.positions(i);
      node.x = x;
      node.y = y;
    }
    nodes[i] = node;
  }
  return {
    datasetKey: args.datasetKey,
    sourceRevision: 1,
    nodes,
    edges: args.edges,
  };
}

/** the demo's clustered communities (delegates to the seeded generator). */
export function clustered(seed: number, n: number): DemoSnapshot {
  return generateGraph({
    seed,
    nodes: n,
    clusters: 6,
    intraEdgeFactor: 1.6,
    interEdgeProb: 0.06,
    datasetKey: 'clustered',
    sourceRevision: 1,
  });
}

/** branching tree; cluster = depth band. */
export function tree(seed: number, n: number): DemoSnapshot {
  const rng = mulberry32(seed);
  const edges: GraphEdge<DemoEdgeAttrs>[] = [];
  const degree = new Uint32Array(n);
  const depth = new Uint32Array(n);
  let maxDepth = 1;
  for (let i = 1; i < n; i++) {
    // parent among recent nodes → varied branching, moderate depth
    const span = Math.max(1, Math.floor(i * 0.35));
    const parent = i - 1 - Math.floor(rng() * span);
    const p = Math.max(0, parent);
    edges.push({ source: idOf(p), target: idOf(i), attrs: { kind: 'intra' } });
    degree[p] = (degree[p] ?? 0) + 1;
    degree[i] = (degree[i] ?? 0) + 1;
    const di = (depth[p] ?? 0) + 1;
    depth[i] = di;
    if (di > maxDepth) maxDepth = di;
  }
  return build({
    seed,
    n,
    datasetKey: 'tree',
    clusterOf: (i) => Math.min(5, Math.floor(((depth[i] ?? 0) / (maxDepth + 1)) * 6)),
    clusters: 6,
    edges,
    degree,
  });
}

/** preferential attachment; cluster = hub tier (log-degree band). */
export function scaleFree(seed: number, n: number): DemoSnapshot {
  const rng = mulberry32(seed);
  const edges: GraphEdge<DemoEdgeAttrs>[] = [];
  const degree = new Uint32Array(n);
  const bag: number[] = [0];
  for (let i = 1; i < n; i++) {
    const m = 1 + (rng() < 0.35 ? 1 : 0);
    const chosen = new Set<number>();
    for (let e = 0; e < m; e++) {
      const t = bag[Math.floor(rng() * bag.length)] ?? 0;
      if (t === i || chosen.has(t)) continue;
      chosen.add(t);
      edges.push({ source: idOf(t), target: idOf(i), attrs: { kind: 'intra' } });
      degree[t] = (degree[t] ?? 0) + 1;
      degree[i] = (degree[i] ?? 0) + 1;
      bag.push(t, i);
    }
    if (chosen.size === 0) {
      edges.push({ source: idOf(i - 1), target: idOf(i), attrs: { kind: 'intra' } });
      degree[i - 1] = (degree[i - 1] ?? 0) + 1;
      degree[i] = (degree[i] ?? 0) + 1;
      bag.push(i - 1, i);
    }
  }
  return build({
    seed,
    n,
    datasetKey: 'hubs',
    clusterOf: (i) => Math.min(5, Math.floor(Math.log2((degree[i] ?? 0) + 1))),
    clusters: 6,
    edges,
    degree,
  });
}

/** two partitions, edges only across; cluster = side. */
export function bipartite(seed: number, n: number): DemoSnapshot {
  const rng = mulberry32(seed);
  const left = Math.floor(n * 0.4);
  const edges: GraphEdge<DemoEdgeAttrs>[] = [];
  const degree = new Uint32Array(n);
  for (let i = left; i < n; i++) {
    const links = 1 + Math.floor(rng() * 3);
    const chosen = new Set<number>();
    for (let e = 0; e < links; e++) {
      const t = Math.floor(rng() * left);
      if (chosen.has(t)) continue;
      chosen.add(t);
      edges.push({ source: idOf(t), target: idOf(i), attrs: { kind: 'inter' } });
      degree[t] = (degree[t] ?? 0) + 1;
      degree[i] = (degree[i] ?? 0) + 1;
    }
  }
  return build({
    seed,
    n,
    datasetKey: 'bipartite',
    clusterOf: (i) => (i < left ? 0 : 2),
    clusters: 6,
    edges,
    degree,
  });
}

/** one big cycle with sparse chords; cluster = arc segment. */
export function ring(seed: number, n: number): DemoSnapshot {
  const rng = mulberry32(seed);
  const edges: GraphEdge<DemoEdgeAttrs>[] = [];
  const degree = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    edges.push({ source: idOf(i), target: idOf(j), attrs: { kind: 'intra' } });
    degree[i] = (degree[i] ?? 0) + 1;
    degree[j] = (degree[j] ?? 0) + 1;
    if (rng() < 0.04) {
      const far = (i + Math.floor(n / 3) + Math.floor(rng() * (n / 3))) % n;
      edges.push({ source: idOf(i), target: idOf(far), attrs: { kind: 'inter' } });
      degree[i] = (degree[i] ?? 0) + 1;
      degree[far] = (degree[far] ?? 0) + 1;
    }
  }
  return build({
    seed,
    n,
    datasetKey: 'ring',
    clusterOf: (i) => Math.floor((i / n) * 6),
    clusters: 6,
    edges,
    degree,
  });
}

/** disconnected components — one clustered blob per island. */
export function islands(seed: number, n: number): DemoSnapshot {
  const rng = mulberry32(seed);
  const k = 5;
  const per = Math.floor(n / k);
  const edges: GraphEdge<DemoEdgeAttrs>[] = [];
  const degree = new Uint32Array(n);
  for (let island = 0; island < k; island++) {
    const b = island * per;
    const size = island === k - 1 ? n - b : per;
    for (let v = 1; v < size; v++) {
      const g = b + v;
      const links = 1 + (rng() < 0.5 ? 1 : 0);
      for (let e = 0; e < links; e++) {
        const t = b + Math.floor(rng() * v);
        edges.push({ source: idOf(t), target: idOf(g), attrs: { kind: 'intra' } });
        degree[t] = (degree[t] ?? 0) + 1;
        degree[g] = (degree[g] ?? 0) + 1;
      }
    }
  }
  return build({
    seed,
    n,
    datasetKey: 'islands',
    clusterOf: (i) => Math.min(5, Math.floor(i / per)),
    clusters: 6,
    edges,
    degree,
  });
}

export const FORCE_TOPOLOGIES: Record<TopologyKind, (seed: number, n: number) => DemoSnapshot> = {
  clustered,
  tree,
  'scale-free': scaleFree,
  bipartite,
  ring,
  islands,
};

// --- fixed-layout topologies: exact declared positions ----------------------

const CX = 2048;
const CY = 2048;

/** perfect circle; sequential edges + sparse chords (ring topology, exact). */
export function circularFixed(seed: number, n: number): DemoSnapshot {
  const snap = ring(seed, n);
  const r = 1500;
  const nodes = snap.nodes.map((node, i) => ({
    ...node,
    x: CX + r * Math.cos((i / n) * 2 * Math.PI),
    y: CY + r * Math.sin((i / n) * 2 * Math.PI),
  }));
  return { ...snap, datasetKey: 'circular', nodes };
}

/** square lattice with right/down edges; cluster = 3x2 region. */
export function gridFixed(seed: number, n: number): DemoSnapshot {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const cell = 3000 / Math.max(cols, rows);
  const x0 = CX - (cols * cell) / 2;
  const y0 = CY - (rows * cell) / 2;
  const edges: GraphEdge<DemoEdgeAttrs>[] = [];
  const degree = new Uint32Array(n);
  const link = (a: number, b: number): void => {
    edges.push({ source: idOf(a), target: idOf(b), attrs: { kind: 'intra' } });
    degree[a] = (degree[a] ?? 0) + 1;
    degree[b] = (degree[b] ?? 0) + 1;
  };
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const rw = Math.floor(i / cols);
    if (c + 1 < cols && i + 1 < n) link(i, i + 1);
    if (rw + 1 < rows && i + cols < n) link(i, i + cols);
  }
  return build({
    seed,
    n,
    datasetKey: 'grid',
    clusterOf: (i) =>
      Math.min(2, Math.floor(((i % cols) / cols) * 3)) + 3 * Math.min(1, Math.floor((Math.floor(i / cols) / rows) * 2)),
    clusters: 6,
    edges,
    degree,
    positions: (i) => [x0 + (i % cols) * cell, y0 + Math.floor(i / cols) * cell],
  });
}

/** tidy radial tree: concentric depth rings, children fan under parents. */
export function radialTreeFixed(seed: number, n: number): DemoSnapshot {
  const snap = tree(seed, n);
  // recover parents from the tree edge list (source = parent)
  const parent = new Int32Array(n).fill(-1);
  const childrenOf: number[][] = Array.from({ length: n }, () => []);
  for (const e of snap.edges) {
    const p = Number(e.source.slice(1));
    const c = Number(e.target.slice(1));
    parent[c] = p;
    childrenOf[p]!.push(c);
  }
  // subtree sizes → angular share
  const sizeOf = new Float64Array(n).fill(1);
  for (let i = n - 1; i >= 1; i--) {
    const pi = parent[i]!;
    sizeOf[pi] = (sizeOf[pi] ?? 0) + (sizeOf[i] ?? 0);
  }
  const angle = new Float64Array(n);
  const depth = new Uint32Array(n);
  const span = new Float64Array(n);
  angle[0] = 0;
  span[0] = 2 * Math.PI;
  let maxDepth = 1;
  // children partition the parent's angular span by subtree share
  for (let i = 0; i < n; i++) {
    const kids = childrenOf[i]!;
    if (kids.length === 0) continue;
    let cursor = angle[i]! - span[i]! / 2;
    for (const kid of kids) {
      const share = (sizeOf[kid]! / (sizeOf[i]! - 1)) * span[i]!;
      angle[kid] = cursor + share / 2;
      span[kid] = share;
      depth[kid] = depth[i]! + 1;
      if (depth[kid]! > maxDepth) maxDepth = depth[kid]!;
      cursor += share;
    }
  }
  const ringStep = 1500 / (maxDepth + 1);
  const nodes = snap.nodes.map((node, i) => ({
    ...node,
    x: CX + depth[i]! * ringStep * Math.cos(angle[i]!),
    y: CY + depth[i]! * ringStep * Math.sin(angle[i]!),
  }));
  return { ...snap, datasetKey: 'radial-tree', nodes };
}
