/**
 * reconciler — id↔index model, structural diff, position cache.
 *
 * v0.1 implements the 'rebuild' index policy only: every reconcile
 * rebuilds the flat buffers from scratch in accepted-base order, preserving
 * positions by id via the live/departed caches. Pure data-structure work: no
 * DOM, no engine import.
 */

import type { AcceptedGraph, EdgeId, NodeId, RenderScene } from './types';

export interface ReconcileResult {
  scene: RenderScene;
  /**
   * True when the node id sequence OR the edge endpoint/id sequence differs
   * from the previous reconcile. The first reconcile is always structural.
   */
  structuralChange: boolean;
  /**
   * True when the resolved position buffer differs from the previous live
   * position mirror. NaN pairs compare equal so attr-only updates on
   * unseeded nodes do not spuriously dirty the engine structure.
   */
  positionChange: boolean;
  /** Nodes whose position was restored from the live or departed cache. */
  reusedPositions: number;
}

/** departed-position LRU cap (entries). A single reconcile's removals
 * are always retained in full, even when that transiently exceeds the cap. */
const DEPARTED_CAP = 262_144;

const EMPTY_INDEX: ReadonlyMap<NodeId, number> = new Map();

export class Reconciler {
  private datasetKey: string | null = null;
  private hasScene = false;

  // Previous scene, kept for the structural diff.
  private prevIdByIndex: readonly NodeId[] = [];
  private prevIndexById: ReadonlyMap<NodeId, number> = EMPTY_INDEX;
  private prevEdgeIdByIndex: readonly EdgeId[] = [];
  private prevLinks: Uint32Array = new Uint32Array(0);

  /**
   * Declared node.x/y as of the previous reconcile, for nodes that declared
   * them. Lets Priority 1 distinguish a CHANGED declaration (caller intent
   * wins over any cache) from an unchanged one (defers to live drift). Fresh
   * per pass, so departed ids drop and a re-add treats its declaration as new.
   */
  private prevDeclared: ReadonlyMap<NodeId, readonly [number, number]> = new Map();

  /**
   * CPU position mirror for the CURRENT scene, indexed by slot.
   * Owned copy — never aliases a published scene's positions array, so
   * noteEnginePositions never mutates an already-published RenderScene.
   */
  private livePositions: Float32Array = new Float32Array(0);

  /**
   * Ids removed from the scene → last known finite position, preserving the
   * leave-and-return guarantee. Map insertion order doubles as LRU order;
   * invariant: never overlaps the current scene's id set.
   */
  private readonly departed = new Map<NodeId, [number, number]>();

  reconcile<N, E>(accepted: AcceptedGraph<N, E>): ReconcileResult {
    // a datasetKey change clears all per-dataset id-keyed state.
    if (this.datasetKey !== null && this.datasetKey !== accepted.datasetKey) {
      this.resetDatasetState();
    }
    this.datasetKey = accepted.datasetKey;

    const nodes = accepted.nodes;
    const edges = accepted.edges;
    const count = nodes.length;
    const linkCount = edges.length;
    // Under 'rebuild', the scene order IS accepted-base order, so the accepted
    // nodeIndex is exactly the scene's indexById — no rebuild needed.
    const indexById = accepted.nodeIndex;

    // --- 1. Removals: bank last known finite positions into departed (O(Δ)).
    const prevIds = this.prevIdByIndex;
    const prevLive = this.livePositions;
    const departed = this.departed;
    const prevDeclared = this.prevDeclared;
    const nextDeclared = new Map<NodeId, readonly [number, number]>();
    let insertedThisPass = 0;
    for (let i = 0; i < prevIds.length; i++) {
      const id = prevIds[i]!;
      if (indexById.has(id)) continue;
      const x = prevLive[2 * i]!;
      const y = prevLive[2 * i + 1]!;
      // NaN pair = position was never known; nothing to preserve.
      if (x === x && y === y) {
        // A removed id was in the prev scene, so it cannot already be in
        // departed (invariant above) — plain set keeps LRU order correct.
        departed.set(id, [x, y]);
        insertedThisPass++;
      }
    }

    // --- 2. Build id order + positions in one pass (hot loop: no closures,
    // no per-node allocations beyond the output arrays).
    const idByIndex: NodeId[] = new Array(count);
    const positions = new Float32Array(2 * count);
    const prevIndexById = this.prevIndexById;
    let reusedPositions = 0;

    for (let i = 0; i < count; i++) {
      const node = nodes[i]!;
      const id = node.id;
      idByIndex[i] = id;

      let x = NaN;
      let y = NaN;
      let fromCache = false;

      const prevSlot = prevIndexById.get(id);
      if (prevSlot !== undefined) {
        // Kept id → live cache (posBuf mirror).
        const lx = prevLive[2 * prevSlot]!;
        const ly = prevLive[2 * prevSlot + 1]!;
        if (lx === lx && ly === ly) {
          x = lx;
          y = ly;
          fromCache = true;
        }
      } else {
        // (Re-)added id → consume any departed entry unconditionally, even if
        // fixed coordinates win below, so departed never overlaps the scene.
        const dep = departed.get(id);
        if (dep !== undefined) {
          departed.delete(id);
          x = dep[0];
          y = dep[1];
          fromCache = true;
        }
      }

      // Priority 1: finite snapshot coordinates assert caller intent when the
      // node has no cached placement OR the declaration CHANGED since the
      // last accepted snapshot. An UNCHANGED declaration defers to the
      // live cache: under force those coordinates are seeds, and re-asserting
      // them on every attrs-only revision would snap drifted layouts back and
      // trigger a spurious position re-upload + reheat.
      const fx = node.x;
      const fy = node.y;
      if (fx !== undefined && fy !== undefined && Number.isFinite(fx) && Number.isFinite(fy)) {
        const prev = prevDeclared.get(id);
        const declaredChanged = prev === undefined || prev[0] !== fx || prev[1] !== fy;
        if (!fromCache || declaredChanged) {
          x = fx;
          y = fy;
          fromCache = false;
        }
        nextDeclared.set(id, declaredChanged ? [fx, fy] : prev!);
      }

      positions[2 * i] = x;
      positions[2 * i + 1] = y;
      if (fromCache) reusedPositions++;
    }
    this.prevDeclared = nextDeclared;

    // --- 3. Links: endpoint indices in accepted edge order.
    const links = new Uint32Array(2 * linkCount);
    const edgeIdByIndex: EdgeId[] = new Array(linkCount);
    for (let k = 0; k < linkCount; k++) {
      const edge = edges[k]!;
      edgeIdByIndex[k] = edge.id;
      // AcceptedGraph guarantees dangling endpoints were dropped, so a
      // miss here is programmer error upstream — assert via non-null.
      links[2 * k] = indexById.get(edge.source)!;
      links[2 * k + 1] = indexById.get(edge.target)!;
    }

    // --- 4. Structural + resolved-position diffs against the previous scene.
    const structuralChange =
      !this.hasScene ||
      !sameStringSequence(this.prevIdByIndex, idByIndex) ||
      !sameStringSequence(this.prevEdgeIdByIndex, edgeIdByIndex) ||
      !sameUint32(this.prevLinks, links);
    const positionChange = !this.hasScene || !sameFloat32WithNaN(this.livePositions, positions);

    // --- 5. Evict departed LRU overflow, but never this reconcile's removals
    // (they are the newest entries; evict only older ones, from the front).
    let evictBudget = departed.size - DEPARTED_CAP;
    const evictable = departed.size - insertedThisPass;
    if (evictBudget > evictable) evictBudget = evictable;
    if (evictBudget > 0) {
      for (const oldId of departed.keys()) {
        departed.delete(oldId);
        if (--evictBudget === 0) break;
      }
    }

    const scene: RenderScene = {
      count,
      linkCount,
      idByIndex,
      indexById,
      edgeIdByIndex,
      positions,
      links,
    };

    this.prevIdByIndex = idByIndex;
    this.prevIndexById = indexById;
    this.prevEdgeIdByIndex = edgeIdByIndex;
    this.prevLinks = links;
    this.livePositions = new Float32Array(positions);
    this.hasScene = true;

    return { scene, structuralChange, positionChange, reusedPositions };
  }

  /**
   * Copy engine-read positions into the live cache for the CURRENT scene's
   * slots.
   * Extra trailing floats are ignored; a short buffer updates a prefix.
   */
  noteEnginePositions(positions: Float32Array): void {
    const live = this.livePositions;
    const n = Math.min(live.length, positions.length);
    if (n === 0) return;
    live.set(positions.subarray(0, n));
  }

  private resetDatasetState(): void {
    this.prevIdByIndex = [];
    this.prevIndexById = EMPTY_INDEX;
    this.prevEdgeIdByIndex = [];
    this.prevLinks = new Uint32Array(0);
    this.livePositions = new Float32Array(0);
    this.departed.clear();
    this.prevDeclared = new Map();
    this.hasScene = false;
  }
}

function sameStringSequence(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameUint32(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameFloat32WithNaN(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    if (av !== bv && !(Number.isNaN(av) && Number.isNaN(bv))) return false;
  }
  return true;
}
