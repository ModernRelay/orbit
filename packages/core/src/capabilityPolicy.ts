/**
 * capability-policy module.
 *
 * (normative): for capabilities where the core owns a fallback path, the
 * core selects native-vs-fallback ONCE at mount from the engine's declared
 * `capabilities` record — never by sniffing method presence — and unsupported
 * *requested* props degrade loudly (a diagnostic), never as silent no-ops.
 *
 * This module is the single place those decisions are made:
 * - {@link resolveEnginePolicy} turns the capability record + the host's
 * requested features into one frozen {@link EnginePolicy} at mount.
 * - {@link assertCapabilityMethodParity} is the mount-time dev-mode record
 * vs. method-surface assertion, restricted to honestly checkable pairs.
 * - {@link normalizeCommitForCapabilities} strips commit payload an engine
 * declared it cannot honor, so incapable adapters never see it.
 */

import type {
  EngineBufferChannel,
  EngineCapabilities,
  EngineCommit,
  EngineConfigUpdate,
  GraphEngine,
} from './engine/index';

/** One loud degradation: a feature the host requested that the mounted engine
 * does not declare. Feeds the dev diagnostic at mount. */
export interface EnginePolicyDegradation {
  readonly feature: string;
  readonly reason: string;
}

/** Host-requested capability-gated features, gathered from mount-time props
 * (`edgeArrows` prop → edgeArrows; image-bearing nodeStyle/atlas → images). */
export interface RequestedEngineFeatures {
  edgeArrows?: boolean;
  images?: boolean;
  /** stage-4: a `clusters` spec is active this session. */
  clusters?: boolean;
}

/**
 * The cluster-force degradation text. Exported so the mount-time policy
 * and a LATER cluster activation (a spec applied after ready, which the frozen
 * mount policy cannot see) emit the byte-identical message — the instance
 * emits it at most ONCE per session either way.
 */
export const CLUSTER_FORCE_DEGRADATION_REASON =
  'clusters requested but the engine capability record does not declare clusterForce; the cluster force is inert while membership, cluster labels, and centroids still work';

/**
 * The frozen mount-time native-vs-fallback record. Evaluated exactly
 * once per mount from `EngineCapabilities` and never revisited — capability
 * records are static declarations fixed at engine construction, so the policy
 * must not drift even if a caller mutates the input record afterwards.
 */
export interface EnginePolicy {
  /** arrowheads: engine-drawn, or the prop is inert (+ dev warning). */
  readonly edgeArrows: 'native' | 'inert';
  /** image sprites: atlas-backed, or the placeholder glyph with refs
   * retained for a future compatible engine. */
  readonly images: 'native' | 'placeholder';
  /** link hover/click: engine events, or the core's CPU grid fallback. */
  readonly linkPicking: 'native' | 'cpu-fallback';
  /** stage-4 cluster force: engine-applied, or inert (membership,
   * labels, and centroids are core-owned and unaffected). */
  readonly clusterForce: 'native' | 'inert';
  /** Channels eligible for ranged (partial) uploads; empty = full replaces. */
  readonly rangedChannels: ReadonlySet<EngineBufferChannel>;
  /** stop-at-rest: 'stops' when the engine declares idleFrames:'stops'.
   * Observability only (telemetry/harness read it) — an idle-spinning engine
   * is a documented state, never a degradation entry: nothing was
   * host-REQUESTED, so there is nothing to warn about. */
  readonly quiescence: 'stops' | 'free-running';
  /** Exactly one entry per REQUESTED-but-unsupported feature; requested and
   * supported — or simply never requested — contributes nothing. */
  readonly degradations: readonly EnginePolicyDegradation[];
}

function degradation(feature: string, reason: string): EnginePolicyDegradation {
  return Object.freeze({ feature, reason });
}

/**
 * Resolve the mount-time engine policy from the declared capability record.
 *
 * Decisions come from `capabilities` ONLY — method sniffing is forbidden by
 * The result is deep-frozen and holds a defensive copy of
 * `rangeUpdates`, so mutating the input record afterwards changes nothing.
 * A degradation entry exists only for features the host actually requested
 * that the engine does not declare; unrequested gaps stay silent.
 */
export function resolveEnginePolicy(
  capabilities: EngineCapabilities,
  requested: RequestedEngineFeatures,
): EnginePolicy {
  const edgeArrowsNative = capabilities.edgeArrows === true;
  const imagesNative = capabilities.pointImages === true;
  const clusterForceNative = capabilities.clusterForce === true;

  const degradations: EnginePolicyDegradation[] = [];
  if (requested.edgeArrows === true && !edgeArrowsNative) {
    degradations.push(
      degradation(
        'edgeArrows',
        'edgeArrows requested but the engine capability record does not declare edgeArrows; the prop is inert',
      ),
    );
  }
  if (requested.images === true && !imagesNative) {
    degradations.push(
      degradation(
        'images',
        'node images requested but the engine capability record does not declare pointImages; placeholder glyphs render and image refs are retained',
      ),
    );
  }

  if (requested.clusters === true && !clusterForceNative) {
    degradations.push(degradation('clusters', CLUSTER_FORCE_DEGRADATION_REASON));
  }

  const policy: EnginePolicy = {
    edgeArrows: edgeArrowsNative ? 'native' : 'inert',
    images: imagesNative ? 'native' : 'placeholder',
    linkPicking: capabilities.linkPicking ? 'native' : 'cpu-fallback',
    clusterForce: clusterForceNative ? 'native' : 'inert',
    quiescence: capabilities.idleFrames === 'stops' ? 'stops' : 'free-running',
    // Defensive snapshot: the policy must not alias the caller's array.
    rangedChannels: new Set(capabilities.rangeUpdates),
    degradations: Object.freeze(degradations),
  };
  return Object.freeze(policy);
}

/**
 * Mount-time dev-mode assertion: does the declared capability record agree
 * with the engine's method surface? Returns a list of human-readable
 * mismatches (empty = consistent).
 *
 * Why so few checks? An illustrative parity assertion
 * (`capabilities.linkPicking === (typeof engine.linkAt === 'function')`)
 * presumes a broader method surface; the v0.1 adapter contract
 * deliberately narrows it, leaving most capabilities with NO honestly
 * checkable method pair. Those are instead covered by engine probes that
 * validate declared records against observed behavior:
 *
 * - `linkPicking`: native picking arrives through mount-time host events
 * (`onLinkClick`/`onLinkHover`), not a probeable `linkAt` method — there
 * is nothing on the engine object to compare the record against.
 * - `edgeArrows` / `pointImages` / `rangeUpdates`: honored inside
 * `commit()` payload handling (`config.linkArrows`, `resources`, ranged
 * uploads) with no distinguishing method; only behavior can validate them.
 * - `simulation`: `start()`/`pause()` are mandatory on every engine (static
 * engines no-op them), so method presence carries no signal either way.
 * - `pointsInPolygon`-family (`pointsInRect`, `captureScreenshot`,
 * `neighborIndices`, `screenToSpace`/`spaceToScreen`, `setPinnedIndices`,
 * `zoomToIndex`): optional-by-contract with no declaring capability bit —
 * absence is legitimate, so no check is fabricated for them.
 *
 * The one honest pair on this surface: `trackedPositions` declares position
 * readback works, so `getPositions` must actually be present.
 */
export function assertCapabilityMethodParity(engine: GraphEngine): string[] {
  const mismatches: string[] = [];
  // Runtime-defensive views: JS consumers can hand us structurally partial
  // adapters even though the TS type says these members exist.
  const capabilities = (engine as { capabilities?: unknown }).capabilities;
  if (capabilities === null || typeof capabilities !== 'object') {
    mismatches.push('engine.capabilities is missing or not an object');
    return mismatches;
  }
  const caps = capabilities as Partial<EngineCapabilities>;
  const getPositions = (engine as { getPositions?: unknown }).getPositions;
  if (caps.trackedPositions === true && typeof getPositions !== 'function') {
    mismatches.push(
      'capabilities.trackedPositions is declared but engine.getPositions is absent',
    );
  }
  return mismatches;
}

/**
 * Strip commit payload the engine's capability record says it cannot honor:
 * - `resources` (image atlas + per-point image index) unless `pointImages`;
 * - `config.linkArrows` unless `edgeArrows`;
 * - `config.cluster` unless `clusterForce` (stage 4 — the core keeps
 * membership, labels, and centroids; only the FORCE is engine-side).
 * A `config` left empty by the strip is dropped entirely.
 *
 * IDENTITY-PRESERVING: when nothing needs stripping the SAME commit object
 * reference is returned, so downstream dirty/equality checks stay cheap. The
 * input commit is never mutated. `dropped` names each stripped payload path.
 */
export function normalizeCommitForCapabilities(
  commit: EngineCommit,
  capabilities: EngineCapabilities,
): { commit: EngineCommit; dropped: readonly string[] } {
  const config = commit.config;
  // patches for a channel the engine never declared ranged are a
  // producer bug — strip them LOUDLY (dropped entry) rather than hand an
  // engine a payload it cannot apply. Core's producer gates on the policy,
  // so a non-empty drop here means a discipline violation upstream.
  const declaredRanged = new Set(capabilities.rangeUpdates);
  const undeclaredPatches =
    commit.bufferPatches !== undefined
      ? Object.keys(commit.bufferPatches).filter(
          (ch) => !declaredRanged.has(ch as EngineBufferChannel),
        )
      : [];
  const dropResources = capabilities.pointImages !== true && commit.resources !== undefined;
  const dropLinkArrows =
    capabilities.edgeArrows !== true && config !== undefined && config.linkArrows !== undefined;
  const dropCluster =
    capabilities.clusterForce !== true && config !== undefined && config.cluster !== undefined;

  if (!dropResources && !dropLinkArrows && !dropCluster && undeclaredPatches.length === 0) {
    return { commit, dropped: [] };
  }

  const dropped: string[] = [];
  const next: EngineCommit = { ...commit };
  if (undeclaredPatches.length > 0) {
    const kept = { ...next.bufferPatches };
    for (const ch of undeclaredPatches) {
      delete kept[ch as keyof typeof kept];
      dropped.push(`bufferPatches.${ch}`);
    }
    if (Object.keys(kept).length > 0) next.bufferPatches = kept;
    else delete next.bufferPatches;
  }
  if (dropResources) {
    delete next.resources;
    dropped.push('resources');
  }
  if ((dropLinkArrows || dropCluster) && config !== undefined) {
    const rest: EngineConfigUpdate = { ...config };
    if (dropLinkArrows) {
      delete rest.linkArrows;
      dropped.push('config.linkArrows');
    }
    if (dropCluster) {
      delete rest.cluster;
      dropped.push('config.cluster');
    }
    if (Object.keys(rest).length > 0) {
      next.config = rest;
    } else {
      delete next.config;
    }
  }
  return { commit: next, dropped };
}
