/**
 * Copied from apps/demo/src/App.tsx (minimap seed positions) — keep in sync
 * by hand. Declares a deterministic golden-angle sunflower position for every
 * position-less node: the minimap's CPU fallback rasterizes DECLARED
 * coordinates, and under the force layout the declaration doubles as the
 * simulation's initial placement (unchanged declarations defer to live sim
 * positions on later revisions).
 */

import type { GraphSnapshot } from '@modernrelay/orbit-core';

const GOLDEN_ANGLE = 2.399963229728653;
/** Cosmos space is [0, 4096] with ring seeding at r=1024 around the center —
 * the sunflower disc matches that envelope. */
const SEED_CENTER = 2048;
const SEED_RADIUS_STEP = 17; // r = 17·√i → ≈1005 at i=3500

export function seedSnapshotPositions<N, E>(snap: GraphSnapshot<N, E>): GraphSnapshot<N, E> {
  const nodes = snap.nodes.map((node, i) => {
    if (node.x !== undefined && node.y !== undefined) return node;
    const r = SEED_RADIUS_STEP * Math.sqrt(i);
    const a = i * GOLDEN_ANGLE;
    return { ...node, x: SEED_CENTER + Math.cos(a) * r, y: SEED_CENTER + Math.sin(a) * r };
  });
  return { ...snap, nodes };
}
