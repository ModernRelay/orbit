/**
 * stage-4 non-collapsing clusters — pure derivation, no
 * engine, no DOM, no instance.
 *
 * Contract summary:
 * - Clusters are a categorical PARTITION of the current PHYSICAL scene, never
 * a rewrite: `deriveClusters` returns membership only. It synthesizes no
 * super-nodes and no meta-edges, so node and edge counts are identical
 * before and after a cluster spec lands — clusters coexist
 * with the stage-3 group rewrite by construction.
 * - `null` (and any non-string) from `by` means UNCLUSTERED: the slot carries
 * NaN in {@link ClusterDerivation.slotOrdinals} (the engine contract's
 * "not in any cluster" value, mirroring the NaN-position convention).
 * - Missing force centers generate deterministically from the ORDERED cluster
 * keys plus the layout seed. {@link generateClusterCenters} uses
 * only IEEE-754 correctly-rounded operations (+ - * / and integer ops) — no
 * transcendentals — so the same ordered keys and seed produce BIT-IDENTICAL
 * centers on any conforming engine, and a different seed produces different
 * ones.
 * - Overlay anchoring must never scan members per frame:
 * {@link clusterCentroids} is the ONLY member-scanning anchor path and runs
 * at settle (from the single permitted readback) or at commit under a
 * fixed layout. {@link clusterProbe} counts every member visit so tests can
 * pin "zero per-frame member iterations".
 */

import type { GraphDiagnostic, GraphNode, NodeId } from './types';
import { DIAGNOSTIC_SAMPLE_CAP } from './types';

// ---------------------------------------------------------------------------
// Instrumentation.
// ---------------------------------------------------------------------------

/**
 * Cluster-work counters. `memberVisits` counts EVERY per-member iteration the
 * cluster lane performs (derivation scans and centroid scans — the only two
 * O(members) passes); `derivations` counts stage-4 recomputations. Both are
 * unconditional O(1) increments so the instrumented and production paths are
 * identical code. Tests snapshot, act, and compare: a per-frame overlay tick
 * must add ZERO member visits and a stage-5 soft-mask change must
 * add ZERO derivations.
 */
export const clusterProbe = {
  derivations: 0,
  memberVisits: 0,
};

/** Reset both counters (per-test isolation). */
export function resetClusterProbe(): void {
  clusterProbe.derivations = 0;
  clusterProbe.memberVisits = 0;
}

// ---------------------------------------------------------------------------
// Deterministic force-center generation.
// ---------------------------------------------------------------------------

/**
 * The layout seed generated cluster centers key on.
 *
 * FINDING (investigation, recorded here because it is a contract
 * decision): the core owns NO numeric layout seed in v0.10. The only
 * layout-seeding knob on the config contract is
 * `EngineConfigUpdate.seedRadius` (the ring radius unknown/NaN positions seed
 * onto) and `instance.ts` never sets it — every adapter defaults it itself
 * (`CosmosEngine` → `spaceSize / 4`). `LayoutSpec.seed` (the
 * `static` layout's reproducibility seed) is not implemented in v0.10 either.
 * So this constant is the single named place the instance keys generated
 * centers on until normalized layout object lands and can supply
 * `LayoutSpec.seed` here.
 */
export const DEFAULT_LAYOUT_SEED = 0x5eed_1234;

/**
 * Radius of the square region generated centers spread over, in SPACE
 * coordinates. Mirrors the role of `EngineConfigUpdate.seedRadius` (see
 * {@link DEFAULT_LAYOUT_SEED}) and matches `CosmosEngine`'s own default
 * (`spaceSize / 4` = 4096 / 4).
 */
export const DEFAULT_CLUSTER_CENTER_RADIUS = 1024;

/** FNV-1a over the key mixed with the seed, finished with murmur3's fmix32. */
function hash32(key: string, seed: number): number {
  let h = (0x811c9dc5 ^ (seed | 0)) >>> 0;
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** 2^-32 — exact in binary64, so `hash * UNIT` is exact. */
const UNIT = 2.3283064365386963e-10;

/** van der Corput radical inverse — integer ops plus one division per digit,
 * all correctly rounded, so the result is reproducible bit-for-bit. */
function radicalInverse(index: number, base: number): number {
  let result = 0;
  let denominator = 1;
  let n = index;
  while (n > 0) {
    denominator *= base;
    result += (n % base) / denominator;
    n = Math.floor(n / base);
  }
  return result;
}

function frac(v: number): number {
  return v - Math.floor(v);
}

/**
 * Deterministic force centers for ORDERED cluster keys: a
 * low-discrepancy (Halton base 2/3) spread offset per key by a seeded hash,
 * mapped into `[-radius, radius]²`.
 *
 * Pure and total: same ordered keys + same seed ⇒ bit-identical output (only
 * IEEE-754 correctly-rounded arithmetic is used — no `Math.sin/cos`, whose
 * results are implementation-defined); a different seed ⇒ different output;
 * reordering or renaming keys ⇒ different output (both the ordinal and the
 * key text feed the placement).
 */
export function generateClusterCenters(
  keys: readonly string[],
  seed: number = DEFAULT_LAYOUT_SEED,
  radius: number = DEFAULT_CLUSTER_CENTER_RADIUS,
): Float32Array {
  const out = new Float32Array(2 * keys.length);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const u = frac(radicalInverse(i + 1, 2) + hash32(key, seed) * UNIT);
    const v = frac(radicalInverse(i + 1, 3) + hash32(key, (seed ^ 0x9e3779b9) | 0) * UNIT);
    out[2 * i] = radius * (2 * u - 1);
    out[2 * i + 1] = radius * (2 * v - 1);
  }
  return out;
}

/**
 * Force centers for ordered keys with caller-supplied entries winning:
 * ONLY the missing keys generate. A non-finite explicit pair is
 * treated as missing (D4 boundary hygiene — a NaN center would poison the
 * engine's force field).
 */
export function resolveClusterCenters(
  keys: readonly string[],
  explicit: ReadonlyMap<string, readonly [number, number]> | undefined,
  seed: number = DEFAULT_LAYOUT_SEED,
  radius: number = DEFAULT_CLUSTER_CENTER_RADIUS,
): Float32Array {
  const out = generateClusterCenters(keys, seed, radius);
  if (explicit === undefined || explicit.size === 0) return out;
  for (let i = 0; i < keys.length; i++) {
    const pair = explicit.get(keys[i]!);
    if (pair === undefined) continue;
    const x = pair[0];
    const y = pair[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[2 * i] = x;
    out[2 * i + 1] = y;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derivation.
// ---------------------------------------------------------------------------

export interface ClusterDerivation {
  /** Distinct keys in FIRST-ENCOUNTER order over the physical scene (the
   * categorical-domain convention, shared with groupBy). Ordinal i ↔ keys[i]. */
  keys: readonly string[];
  /** key → ordinal (the reverse of `keys`). */
  ordinalByKey: ReadonlyMap<string, number>;
  /** key → member PHYSICAL node ids, scene order. Public ids only. */
  membersByKey: ReadonlyMap<string, readonly NodeId[]>;
  /**
   * PHYSICAL slot → cluster ordinal, NaN = unclustered. Length is the caller's
   * `sceneCount`, so synthetic suffix slots are
   * always NaN: aggregates are never members of a cluster. This IS the engine
   * `config.cluster.pointClusters` payload — no copy at the sink.
   */
  slotOrdinals: Float32Array;
  /** ONE aggregated 'accessor-error' warning when `by` threw (affected nodes
   * derive as unclustered — never silent loss, I3), else null. */
  diagnostic: GraphDiagnostic | null;
}

/**
 * stage-4 derivation over the PHYSICAL prefix of the current scene.
 *
 * `nodes` are the physical rows (post-group-rewrite when a rewrite is live)
 * aligned to scene slots `0..nodes.length-1`; `sceneCount` is the FULL scene
 * point count so the returned `slotOrdinals` covers the synthetic suffix too.
 * Preserves everything and synthesizes nothing.
 */
export function deriveClusters<N>(
  nodes: readonly GraphNode<N>[],
  by: (node: GraphNode<N>) => string | null,
  sceneCount: number = nodes.length,
): ClusterDerivation {
  clusterProbe.derivations++;
  const keys: string[] = [];
  const ordinalByKey = new Map<string, number>();
  const membersByKey = new Map<string, NodeId[]>();
  const slotOrdinals = new Float32Array(Math.max(sceneCount, nodes.length)).fill(NaN);
  let errorCount = 0;
  const errorSamples: string[] = [];

  for (let i = 0; i < nodes.length; i++) {
    clusterProbe.memberVisits++;
    const node = nodes[i]!;
    let raw: string | null;
    try {
      raw = by(node);
    } catch {
      errorCount++;
      if (errorSamples.length < DIAGNOSTIC_SAMPLE_CAP) errorSamples.push(node.id);
      continue;
    }
    if (typeof raw !== 'string') continue; // null / non-string ⇒ unclustered
    let ordinal = ordinalByKey.get(raw);
    if (ordinal === undefined) {
      ordinal = keys.length;
      keys.push(raw);
      ordinalByKey.set(raw, ordinal);
      membersByKey.set(raw, []);
    }
    membersByKey.get(raw)!.push(node.id);
    slotOrdinals[i] = ordinal;
  }

  return {
    keys,
    ordinalByKey,
    membersByKey,
    slotOrdinals,
    diagnostic:
      errorCount === 0
        ? null
        : {
            code: 'accessor-error',
            severity: 'warning',
            count: errorCount,
            sampleIds: errorSamples,
            message: 'clusters.by threw; the affected nodes derived as unclustered',
          },
  };
}

/**
 * Centroids of every cluster from a slot-aligned position buffer — the ONLY
 * member-scanning anchor path. Called at settle (over the single
 * permitted readback) and at commit under a FIXED layout; never per
 * frame. Slots with unknown (NaN) positions are skipped; a cluster with no
 * placeable member keeps its `fallback` entry (its force center), so a label
 * never jumps to the origin.
 */
export function clusterCentroids(
  slotOrdinals: Float32Array,
  positions: Float32Array,
  clusterCount: number,
  fallback: Float32Array,
): Float32Array {
  const out = new Float32Array(2 * clusterCount);
  const counts = new Float64Array(clusterCount);
  const slots = Math.min(slotOrdinals.length, Math.floor(positions.length / 2));
  for (let i = 0; i < slots; i++) {
    const ordinal = slotOrdinals[i]!;
    if (Number.isNaN(ordinal)) continue;
    clusterProbe.memberVisits++;
    const x = positions[2 * i]!;
    const y = positions[2 * i + 1]!;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    out[2 * ordinal] = out[2 * ordinal]! + x;
    out[2 * ordinal + 1] = out[2 * ordinal + 1]! + y;
    counts[ordinal] = counts[ordinal]! + 1;
  }
  for (let c = 0; c < clusterCount; c++) {
    const n = counts[c]!;
    if (n === 0) {
      out[2 * c] = fallback[2 * c] ?? 0;
      out[2 * c + 1] = fallback[2 * c + 1] ?? 0;
      continue;
    }
    out[2 * c] = out[2 * c]! / n;
    out[2 * c + 1] = out[2 * c + 1]! / n;
  }
  return out;
}
