/**
 * soft-mask kernel — failure COUNTERS, never Sets and
 * never per-source bit positions (so there is no 32-dimension cap).
 *
 * The mask owns four Uint16 counter lanes: hideFailures and dimFailures for
 * nodes AND edges. Every acquired {@link MaskSource} contributes +1 to a
 * lane counter for each slot it currently fails and -1 when that slot
 * re-enters. A slot is visible iff hideFailures === 0 and dimmed iff visible
 * AND dimFailures > 0.
 *
 * Delta discipline: each source keeps its previous failing membership as
 * per-source Uint8 flag columns plus a dense slot list, so replacing a
 * membership touches counters ONLY for slots whose membership actually
 * changed (O(1) detection per presented slot). Counter transitions across
 * zero append the slot to reusable dirty lists; {@link SoftMask.drainDirty}
 * compares against the state at the previous drain, so a fail-then-restore
 * inside one drain period nets to no emission.
 *
 * {@link SoftMask.applyNodeCascadeToEdges} implements SINGLE edge-
 * survival rule over the mask lane: an edge hide-fails iff EITHER endpoint
 * hide-fails (equivalently: survives iff BOTH endpoints survive
 * scope.ts `cascadeEdges` is the hard-scope variant of the same rule). It is
 * fed through one dedicated internal cascade source from the node hide lane:
 * O(E) recompute per call, but only edges whose state changed produce
 * counter deltas.
 *
 * Overflow guard: increments clamp at 0xFFFF and latch a one-time
 * {@link SoftMask.overflowed} flag the caller reports (an implementation may
 * widen to Uint32 without changing semantics). Debug builds assert
 * balanced increments/decrements whenever a clear/release leaves zero
 * held memberships.
 */

import { incidentEdgesOf } from './adjacency';
import type { Incidence } from './adjacency';

/** Debug builds (vitest/vite dev) assert counter balance on clear/release. */
const DEBUG: boolean = Boolean((import.meta as { env?: { DEV?: unknown } }).env?.DEV);

/** Default muted alpha for dimmed entities. */
export const DIM_ALPHA_DEFAULT = 0.15;

const COUNTER_MAX = 0xffff;

/**
 * A handle contributing failure memberships to the mask. Setting a lane
 * REPLACES that lane's previous membership for this source (the kernel
 * applies only the delta). `null` = empty membership for that lane; an
 * omitted `dimIdx` leaves the dim lane untouched.
 */
export interface MaskSource {
  readonly name: string;
  setNodeFailures(hideIdx: Iterable<number> | null, dimIdx?: Iterable<number> | null): void;
  setEdgeFailures(hideIdx: Iterable<number> | null, dimIdx?: Iterable<number> | null): void;
  /**
   * O(Δ) delta form of the HIDE lane: adds/removes individual slots
   * from this source's membership without replaying the full set. Freely
   * composable with the replace form — a later setNodeFailures re-baselines.
   * `crossings`, when supplied, receives the slots whose hide counter
   * crossed zero DURING THIS CALL (callee-cleared first): the incremental
   * cascade's input, which per-drain `pending` tracking cannot provide.
   */
  updateNodeFailures(
    addHide: ArrayLike<number> | null,
    removeHide: ArrayLike<number> | null,
    crossings?: MaskCrossings,
  ): void;
  updateEdgeFailures(addHide: ArrayLike<number> | null, removeHide: ArrayLike<number> | null): void;
  /** Empties all four lane memberships (the source stays usable). */
  clear(): void;
  /** clear + permanently retires the handle (further set/clear throws;
   * release itself is idempotent). */
  release(): void;
}

/** Per-CALL zero-crossings reported by the delta ops (reused, callee-cleared). */
export interface MaskCrossings {
  /** Slots whose hide counter went 0 → nonzero in this call. */
  becameFailing: number[];
  /** Slots whose hide counter went nonzero → 0 in this call. */
  becameClear: number[];
}

/** O(Δ) operation counters (see resetStats/stats on SoftMask). */
export interface MaskStats {
  /** Slots visited by delta membership ops (add + remove attempts). */
  slotsVisited: number;
  /** Counter zero-crossings applied (both directions, all lanes). */
  zeroCrossings: number;
  /** Incident-edge visits performed by the delta cascade. */
  cascadeEdgesVisited: number;
}

/**
 * One drain payload. The four index arrays are REUSED across drains — copy
 * before the next drainDirty call if you need to keep them.
 */
export interface MaskDrain {
  /** Node slots whose hide-visibility (hideFailures 0 ↔ nonzero) flipped
   * since the previous drain. */
  nodes: readonly number[];
  /** Edge slots whose hide-visibility flipped since the previous drain. */
  edges: readonly number[];
  /** Node slots whose dim state (dimFailures 0 ↔ nonzero) flipped — the
   * alpha lane. Consumers recompute alpha over `nodes ∪ nodesAlpha` (a hide
   * flip also changes the effective alpha; a slot may appear in both). */
  nodesAlpha: readonly number[];
  /** Edge slots whose dim state flipped. */
  edgesAlpha: readonly number[];
  nodeVisibleCount: number;
  edgeVisibleCount: number;
}

/** One counter lane: counters + zero-crossing dirty tracking. */
class Lane {
  counters: Uint16Array;
  /** 0 = not dirty; 1 = dirty & counter was ZERO at the previous drain;
   * 2 = dirty & counter was NONZERO at the previous drain. */
  pending: Uint8Array;
  readonly candidates: number[] = [];
  /** Reused output buffer returned by drain. */
  readonly out: number[] = [];
  /** Slots with counter === 0 (visible count for hide lanes). */
  zeroCount: number;

  constructor(
    readonly label: string,
    capacity: number,
  ) {
    this.counters = new Uint16Array(capacity);
    this.pending = new Uint8Array(capacity);
    this.zeroCount = capacity;
  }

  grow(capacity: number): void {
    const old = this.counters.length;
    if (capacity <= old) return;
    const counters = new Uint16Array(capacity);
    counters.set(this.counters);
    this.counters = counters;
    const pending = new Uint8Array(capacity);
    pending.set(this.pending);
    this.pending = pending;
    this.zeroCount += capacity - old; // new slots start at zero failures
  }
}

/** Per-source, per-lane membership: bit0 = current member; bit1 = transient
 * incoming mark during a replace pass. `list` may carry HOLES (stale entries
 * whose bit0 was cleared by a delta remove) and re-add duplicates; `holes`
 * counts them and compaction filters by bit0 when they exceed half the
 * list. Every list consumer must therefore treat bit0 as the truth. */
interface LaneMembership {
  flags: Uint8Array;
  list: number[];
  holes: number;
}

function newMembership(capacity: number): LaneMembership {
  return { flags: new Uint8Array(capacity), list: [], holes: 0 };
}

function growMembership(mem: LaneMembership, capacity: number): void {
  if (capacity <= mem.flags.length) return;
  const flags = new Uint8Array(capacity);
  flags.set(mem.flags);
  mem.flags = flags;
}

interface SourceState {
  readonly name: string;
  alive: boolean;
  nodeHide: LaneMembership;
  nodeDim: LaneMembership;
  edgeHide: LaneMembership;
  edgeDim: LaneMembership;
}

function checkCapacity(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`SoftMask: ${label} must be a non-negative integer, got ${value}`);
  }
}

export class SoftMask {
  private nodeCap: number;
  private edgeCap: number;
  private readonly nodeHideLane: Lane;
  private readonly nodeDimLane: Lane;
  private readonly edgeHideLane: Lane;
  private readonly edgeDimLane: Lane;
  private readonly sources = new Set<SourceState>();
  /** Dedicated internal source implementing the node→edge cascade. */
  private cascadeSource: MaskSource | null = null;
  private overflowedFlag = false;
  /** Total memberships currently held across all sources and lanes. */
  private totalHeld = 0;
  /** O(Δ) op counters. */
  private readonly statsBox: MaskStats = {
    slotsVisited: 0,
    zeroCrossings: 0,
    cascadeEdgesVisited: 0,
  };

  constructor(nodeCapacity: number, edgeCapacity: number) {
    checkCapacity(nodeCapacity, 'nodeCapacity');
    checkCapacity(edgeCapacity, 'edgeCapacity');
    this.nodeCap = nodeCapacity;
    this.edgeCap = edgeCapacity;
    this.nodeHideLane = new Lane('node hideFailures', nodeCapacity);
    this.nodeDimLane = new Lane('node dimFailures', nodeCapacity);
    this.edgeHideLane = new Lane('edge hideFailures', edgeCapacity);
    this.edgeDimLane = new Lane('edge dimFailures', edgeCapacity);
  }

  get nodeCapacity(): number {
    return this.nodeCap;
  }

  get edgeCapacity(): number {
    return this.edgeCap;
  }

  /** One-time latch: some counter hit 0xFFFF and an increment was dropped.
   * Counts may drift afterwards; the caller reports it. */
  get overflowed(): boolean {
    return this.overflowedFlag;
  }

  // Live counter columns (read-only views by convention — do not mutate;
  // references are replaced on grow).
  get nodeHideFailures(): Uint16Array {
    return this.nodeHideLane.counters;
  }

  get nodeDimFailures(): Uint16Array {
    return this.nodeDimLane.counters;
  }

  get edgeHideFailures(): Uint16Array {
    return this.edgeHideLane.counters;
  }

  get edgeDimFailures(): Uint16Array {
    return this.edgeDimLane.counters;
  }

  /**
   * Grows capacities for structure changes (existing slot state is
   * preserved; new slots start fully visible). Capacities never shrink
   * a smaller value is a no-op for that dimension.
   */
  grow(nodeCapacity: number, edgeCapacity: number): void {
    checkCapacity(nodeCapacity, 'nodeCapacity');
    checkCapacity(edgeCapacity, 'edgeCapacity');
    if (nodeCapacity > this.nodeCap) {
      this.nodeHideLane.grow(nodeCapacity);
      this.nodeDimLane.grow(nodeCapacity);
      for (const source of this.sources) {
        growMembership(source.nodeHide, nodeCapacity);
        growMembership(source.nodeDim, nodeCapacity);
      }
      this.nodeCap = nodeCapacity;
    }
    if (edgeCapacity > this.edgeCap) {
      this.edgeHideLane.grow(edgeCapacity);
      this.edgeDimLane.grow(edgeCapacity);
      for (const source of this.sources) {
        growMembership(source.edgeHide, edgeCapacity);
        growMembership(source.edgeDim, edgeCapacity);
      }
      this.edgeCap = edgeCapacity;
    }
  }

  /** Registers a new failure source. No cap on source count. */
  acquire(name: string): MaskSource {
    const state: SourceState = {
      name,
      alive: true,
      nodeHide: newMembership(this.nodeCap),
      nodeDim: newMembership(this.nodeCap),
      edgeHide: newMembership(this.edgeCap),
      edgeDim: newMembership(this.edgeCap),
    };
    this.sources.add(state);
    const ensureAlive = (): void => {
      if (!state.alive) {
        throw new Error(`SoftMask: source '${name}' used after release()`);
      }
    };
    return {
      name,
      setNodeFailures: (hideIdx, dimIdx) => {
        ensureAlive();
        this.applyMembership(this.nodeHideLane, state.nodeHide, hideIdx);
        if (dimIdx !== undefined) {
          this.applyMembership(this.nodeDimLane, state.nodeDim, dimIdx);
        }
      },
      setEdgeFailures: (hideIdx, dimIdx) => {
        ensureAlive();
        this.applyMembership(this.edgeHideLane, state.edgeHide, hideIdx);
        if (dimIdx !== undefined) {
          this.applyMembership(this.edgeDimLane, state.edgeDim, dimIdx);
        }
      },
      updateNodeFailures: (addHide, removeHide, crossings) => {
        ensureAlive();
        this.applyMembershipDelta(this.nodeHideLane, state.nodeHide, addHide, removeHide, crossings);
      },
      updateEdgeFailures: (addHide, removeHide) => {
        ensureAlive();
        this.applyMembershipDelta(this.edgeHideLane, state.edgeHide, addHide, removeHide);
      },
      clear: () => {
        ensureAlive();
        this.clearSource(state);
        this.assertBalancedIfIdle();
      },
      release: () => {
        if (!state.alive) return;
        this.clearSource(state);
        state.alive = false;
        this.sources.delete(state);
        this.assertBalancedIfIdle();
      },
    };
  }

  /**
   * edge cascade over the mask lane: recomputes, from the CURRENT node
   * hide lane, the set of edges with at least one hidden endpoint, and feeds
   * it to the dedicated internal cascade source (edge hide lane only).
   * `links` is the flat `[src0, tgt0, src1, tgt1, …]` node-slot pair buffer;
   * edge slot i has endpoints at links[2i]/[2i+1].
   * O(E) scan per call — typically once per drain — but only edges whose
   * cascade state changed produce counter deltas (and thus dirty entries).
   * Edges beyond `links.length / 2` are treated as having no hidden
   * endpoint (their previous cascade contribution, if any, is removed).
   */
  applyNodeCascadeToEdges(links: Uint32Array): void {
    if ((links.length & 1) !== 0) {
      throw new RangeError(
        `SoftMask: links length must be even ([src, tgt] pairs), got ${links.length}`,
      );
    }
    const edgeCount = links.length >>> 1;
    if (edgeCount > this.edgeCap) {
      throw new RangeError(
        `SoftMask: links describe ${edgeCount} edges but edgeCapacity is ${this.edgeCap}`,
      );
    }
    const hide = this.nodeHideLane.counters;
    const nodeCap = this.nodeCap;
    const failing: number[] = [];
    for (let i = 0; i < edgeCount; i++) {
      const source = links[i * 2]!;
      const target = links[i * 2 + 1]!;
      if (source >= nodeCap || target >= nodeCap) {
        throw new RangeError(
          `SoftMask: link endpoint out of range at edge ${i} (nodeCapacity ${nodeCap})`,
        );
      }
      if (hide[source]! !== 0 || hide[target]! !== 0) failing.push(i);
    }
    this.cascadeSource ??= this.acquire('node→edge cascade');
    this.cascadeSource.setEdgeFailures(failing);
  }

  /**
   * O(incident-edges) delta form of the cascade: for each node
   * whose HIDE visibility crossed zero, recompute only its incident edges'
   * cascade state from the CURRENT node counters and apply the delta through
   * the same internal cascade source the full form uses — the two compose
   * freely (the full form re-baselines). Edges shared by two crossed nodes
   * are visited twice; the membership delta is idempotent, so the second
   * visit is an O(1) no-op. `incidence` must describe the SAME `links`
   * buffer (edge slot i ↔ links[2i]/[2i+1]).
   */
  applyNodeCascadeToEdgesDelta(
    links: Uint32Array,
    incidence: Incidence,
    crossedNodes: readonly number[],
  ): void {
    if (crossedNodes.length === 0) return;
    const hide = this.nodeHideLane.counters;
    this.cascadeSource ??= this.acquire('node→edge cascade');
    const nowFailing: number[] = [];
    const nowClear: number[] = [];
    for (let k = 0; k < crossedNodes.length; k++) {
      const edges = incidentEdgesOf(incidence, crossedNodes[k]!);
      for (let j = 0; j < edges.length; j++) {
        const edge = edges[j]!;
        this.statsBox.cascadeEdgesVisited += 1;
        const failing = hide[links[edge * 2]!]! !== 0 || hide[links[edge * 2 + 1]!]! !== 0;
        if (failing) nowFailing.push(edge);
        else nowClear.push(edge);
      }
    }
    this.cascadeSource.updateEdgeFailures(nowFailing, nowClear);
  }

  /**
   * Drains the zero-crossing dirty lists accumulated since the previous
   * drain. Only NET flips are emitted (state compared against the previous
   * drain). The returned index arrays are reused by the next drain.
   */
  drainDirty(): MaskDrain {
    return {
      nodes: this.drainLane(this.nodeHideLane),
      edges: this.drainLane(this.edgeHideLane),
      nodesAlpha: this.drainLane(this.nodeDimLane),
      edgesAlpha: this.drainLane(this.edgeDimLane),
      nodeVisibleCount: this.nodeHideLane.zeroCount,
      edgeVisibleCount: this.edgeHideLane.zeroCount,
    };
  }

  /** telemetry: estimated bytes of mask storage held:
   * four counter lanes (+pending trackers) and per-source flag columns. */
  estimatedBytes(): number {
    let bytes = 0;
    for (const lane of [this.nodeHideLane, this.nodeDimLane, this.edgeHideLane, this.edgeDimLane]) {
      bytes += lane.counters.byteLength + lane.pending.byteLength;
    }
    for (const src of this.sources) {
      bytes +=
        src.nodeHide.flags.byteLength +
        src.nodeDim.flags.byteLength +
        src.edgeHide.flags.byteLength +
        src.edgeDim.flags.byteLength;
    }
    return bytes;
  }

  /** O(Δ) op counters (live object — snapshot before comparing). */
  get stats(): Readonly<MaskStats> {
    return this.statsBox;
  }

  resetStats(): void {
    this.statsBox.slotsVisited = 0;
    this.statsBox.zeroCrossings = 0;
    this.statsBox.cascadeEdgesVisited = 0;
  }

  visibleNodeCount(): number {
    return this.nodeHideLane.zeroCount;
  }

  visibleEdgeCount(): number {
    return this.edgeHideLane.zeroCount;
  }

  /** Visible iff hideFailures === 0 (out-of-range slots read not-visible). */
  isNodeVisible(index: number): boolean {
    return this.nodeHideLane.counters[index] === 0;
  }

  isEdgeVisible(index: number): boolean {
    return this.edgeHideLane.counters[index] === 0;
  }

  /** Dimmed iff visible AND dimFailures > 0. */
  isNodeDimmed(index: number): boolean {
    return this.isNodeVisible(index) && (this.nodeDimLane.counters[index] ?? 0) > 0;
  }

  isEdgeDimmed(index: number): boolean {
    return this.isEdgeVisible(index) && (this.edgeDimLane.counters[index] ?? 0) > 0;
  }

  /** 1 (fully visible) | dimAlpha (dimmed) | 0 (hidden). */
  nodeAlpha(index: number, dimAlpha: number = DIM_ALPHA_DEFAULT): number {
    if (!this.isNodeVisible(index)) return 0;
    return (this.nodeDimLane.counters[index] ?? 0) > 0 ? dimAlpha : 1;
  }

  edgeAlpha(index: number, dimAlpha: number = DIM_ALPHA_DEFAULT): number {
    if (!this.isEdgeVisible(index)) return 0;
    return (this.edgeDimLane.counters[index] ?? 0) > 0 ? dimAlpha : 1;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Replaces one source-lane membership with `incoming` (null = empty),
   * applying counter deltas ONLY for slots whose membership changed.
   * Incoming slots are validated up front so a RangeError never leaves the
   * membership partially applied; duplicates within `incoming` count once.
   */
  private applyMembership(
    lane: Lane,
    mem: LaneMembership,
    incoming: Iterable<number> | null,
  ): void {
    const capacity = lane.counters.length;
    const buffered: number[] = [];
    if (incoming !== null) {
      for (const slot of incoming) {
        if (!Number.isInteger(slot) || slot < 0 || slot >= capacity) {
          throw new RangeError(
            `SoftMask: ${lane.label} slot ${slot} out of range [0, ${capacity})`,
          );
        }
        buffered.push(slot);
      }
    }
    const flags = mem.flags;
    const next: number[] = [];
    for (let i = 0; i < buffered.length; i++) {
      const slot = buffered[i]!;
      const f = flags[slot]!;
      if ((f & 2) !== 0) continue; // duplicate within incoming
      flags[slot] = f | 2;
      next.push(slot);
      if ((f & 1) === 0) this.increment(lane, slot); // newly failing
    }
    const prev = mem.list;
    for (let i = 0; i < prev.length; i++) {
      const slot = prev[i]!;
      const f = flags[slot]!;
      if ((f & 2) !== 0) continue; // staying in the membership
      // bit0 guard: hole entries (delta-removed) and re-add duplicates read
      // bit0 = 0 here — decrementing them again would unbalance the books.
      if ((f & 1) !== 0) this.decrement(lane, slot);
      flags[slot] = 0;
    }
    for (let i = 0; i < next.length; i++) flags[next[i]!] = 1;
    mem.list = next;
    mem.holes = 0; // the list was fully rebuilt
  }

  /**
   * O(Δ) delta ops on one lane membership. Adds and removes are
   * idempotent per slot (adding a member / removing a non-member is a
   * no-op); removed slots leave HOLES in `list` (compacted past 50%), so
   * replace/clear passes must honor the bit0 guard above. `crossings`, when
   * given, is cleared and then receives this CALL's hide zero-crossings.
   */
  private applyMembershipDelta(
    lane: Lane,
    mem: LaneMembership,
    add: ArrayLike<number> | null,
    remove: ArrayLike<number> | null,
    crossings?: MaskCrossings,
  ): void {
    if (crossings !== undefined) {
      crossings.becameFailing.length = 0;
      crossings.becameClear.length = 0;
    }
    const capacity = lane.counters.length;
    const flags = mem.flags;
    const check = (slot: number): void => {
      if (!Number.isInteger(slot) || slot < 0 || slot >= capacity) {
        throw new RangeError(`SoftMask: ${lane.label} slot ${slot} out of range [0, ${capacity})`);
      }
    };
    // Validate up front so a RangeError never leaves a partial delta.
    if (add !== null) for (let i = 0; i < add.length; i++) check(add[i]!);
    if (remove !== null) for (let i = 0; i < remove.length; i++) check(remove[i]!);

    if (add !== null) {
      for (let i = 0; i < add.length; i++) {
        const slot = add[i]!;
        this.statsBox.slotsVisited += 1;
        if ((flags[slot]! & 1) !== 0) continue; // already a member
        flags[slot] = 1;
        mem.list.push(slot);
        this.increment(lane, slot, crossings);
      }
    }
    if (remove !== null) {
      for (let i = 0; i < remove.length; i++) {
        const slot = remove[i]!;
        this.statsBox.slotsVisited += 1;
        if ((flags[slot]! & 1) === 0) continue; // not a member
        flags[slot] = 0;
        mem.holes += 1; // the list entry becomes a hole
        this.decrement(lane, slot, crossings);
      }
    }
    if (mem.holes > mem.list.length >> 1) {
      mem.list = mem.list.filter((slot) => (flags[slot]! & 1) !== 0);
      mem.holes = 0;
    }
  }

  private increment(lane: Lane, slot: number, crossings?: MaskCrossings): void {
    this.totalHeld += 1;
    const before = lane.counters[slot]!;
    if (before === COUNTER_MAX) {
      this.overflowedFlag = true; // clamp: drop the increment, latch the flag
      return;
    }
    lane.counters[slot] = before + 1;
    if (before === 0) {
      lane.zeroCount -= 1;
      this.statsBox.zeroCrossings += 1;
      crossings?.becameFailing.push(slot);
      this.markDirty(lane, slot, true);
    }
  }

  private decrement(lane: Lane, slot: number, crossings?: MaskCrossings): void {
    this.totalHeld -= 1;
    const before = lane.counters[slot]!;
    if (before === 0) return; // post-overflow drift; clamp at zero
    lane.counters[slot] = before - 1;
    if (before === 1) {
      lane.zeroCount += 1;
      this.statsBox.zeroCrossings += 1;
      crossings?.becameClear.push(slot);
      this.markDirty(lane, slot, false);
    }
  }

  /** Records the first zero-crossing of a slot per drain period, remembering
   * whether the counter was zero at the previous drain. */
  private markDirty(lane: Lane, slot: number, wasZero: boolean): void {
    if (lane.pending[slot] === 0) {
      lane.pending[slot] = wasZero ? 1 : 2;
      lane.candidates.push(slot);
    }
  }

  private drainLane(lane: Lane): number[] {
    const out = lane.out;
    out.length = 0;
    const { candidates, pending, counters } = lane;
    for (let i = 0; i < candidates.length; i++) {
      const slot = candidates[i]!;
      const zeroAtLastDrain = pending[slot] === 1;
      const zeroNow = counters[slot] === 0;
      if (zeroAtLastDrain !== zeroNow) out.push(slot); // net flip only
      pending[slot] = 0;
    }
    candidates.length = 0;
    return out;
  }

  private clearSource(state: SourceState): void {
    this.applyMembership(this.nodeHideLane, state.nodeHide, null);
    this.applyMembership(this.nodeDimLane, state.nodeDim, null);
    this.applyMembership(this.edgeHideLane, state.edgeHide, null);
    this.applyMembership(this.edgeDimLane, state.edgeDim, null);
  }

  /** Debug balanced-increment assert: whenever no source holds any
   * membership, every counter must read zero (skipped once overflowed
   * clamped increments legitimately drift the books). */
  private assertBalancedIfIdle(): void {
    if (!DEBUG || this.overflowedFlag || this.totalHeld !== 0) return;
    for (const lane of [this.nodeHideLane, this.nodeDimLane, this.edgeHideLane, this.edgeDimLane]) {
      const counters = lane.counters;
      for (let i = 0; i < counters.length; i++) {
        if (counters[i] !== 0) {
          throw new Error(
            `SoftMask: unbalanced ${lane.label} counter ${counters[i]} at slot ${i} with zero held memberships`,
          );
        }
      }
    }
  }
}
