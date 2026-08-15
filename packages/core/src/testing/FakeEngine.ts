/**
 * FakeEngine — the public headless test seam.
 *
 * Implements the full GraphEngine adapter contract with zero DOM/WebGL access
 * so consumer suites can run under node/jsdom. Every public method call is
 * recorded to `calls` in order; commits and camera calls get typed convenience
 * views. Test-only helpers (`stepFrame`, `nudgePositions`, `inject*`) let
 * suites observe applied-revision lag, simulate position drift, and drive
 * host events.
 *
 * The state MIRRORS (`pinnedIndices`, `selectedIndices`, `lastStructure`,
 * `lastBuffer`) answer "what does the engine currently hold?", which the raw
 * `calls`/`commits` logs cannot: pins, highlight, structure and each buffer
 * channel are committed on independent schedules, so the newest entry is
 * rarely the newest value for a given channel.
 */

import type {
  EngineCapabilities,
  EngineCommit,
  EngineDiagnostic,
  EngineHostEvents,
  FitViewOptions,
  GraphEngine,
} from '../engine/index';
import type { ViewportState } from '../types';

export interface FakeEngineOptions {
  /** Overrides merged over the defaults (linkPicking/trackedPositions false, rangeUpdates [], simulation true). */
  capabilities?: Partial<EngineCapabilities>;
  /**
   * When true, commits queue instead of applying immediately; `stepFrame`
   * applies the oldest queued commit. Lets tests observe the lag between the
   * desired-render revision and `appliedRevision`.
   */
  manualFrames?: boolean;
  /**
   * When set, `mount` records the call, does NOT store the host events, and
   * rejects with this error — simulates an engine that cannot initialize.
   */
  mountError?: Error;
  /** Resolved by `captureScreenshot`; default null (unsupported/not ready). */
  screenshot?: Blob | null;
}

/** One recorded public method invocation. */
export interface RecordedCall {
  method: string;
  args: readonly unknown[];
}

const DEFAULT_CAPABILITIES: EngineCapabilities = {
  linkPicking: false,
  rangeUpdates: [],
  trackedPositions: false,
  simulation: true,
  // the FakeEngine schedules nothing on its own — frames exist only
  // when a test calls stepFrame/emitFrame — so it is quiescent by
  // construction, and those calls apply-then-emit, which is genuinely
  // post-draw.
  idleFrames: 'stops',
  postDrawFrames: true,
};

const CAMERA_METHODS: ReadonlySet<string> = new Set([
  'fitView',
  'zoom',
  'setViewport',
  'zoomToIndex',
]);

/** Deterministic seed for an unknown (NaN) position: a 10px grid, 100 per row. */
function seedPosition(index: number): readonly [number, number] {
  return [(index % 100) * 10, Math.floor(index / 100) * 10];
}

/** Standard even-odd ray cast (screen == space in the FakeEngine). */
function pointInPolygon(x: number, y: number, polygon: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

export class FakeEngine implements GraphEngine {
  readonly capabilities: EngineCapabilities;

  /** Every public method call, in order. */
  readonly calls: RecordedCall[] = [];
  /** Every commit passed to `commit`, in call order (queued or applied). */
  readonly commits: EngineCommit[] = [];
  /** The fitView/zoom/setViewport/zoomToIndex entries of `calls`, in order. */
  readonly cameraCalls: RecordedCall[] = [];

  private readonly manualFrames: boolean;
  private readonly mountError: Error | null;
  private readonly screenshot: Blob | null;
  private events: EngineHostEvents | null = null;
  /** Auto-advancing activity clock for emitFrame/stepFrame (ms). */
  private frameClock = 0;
  private destroyedFlag = false;
  private viewport: ViewportState = { x: 0, y: 0, zoom: 1 };
  private applied: number | null = null;
  private positions: Float32Array | null = null;
  /** Links of the most recent structure-bearing commit (commit-time, even in
   * manualFrames mode) — the adjacency source for neighborIndices. */
  private lastLinks: Uint32Array | null = null;
  private pinned: readonly number[] | null = null;
  private selected: readonly number[] | null = null;
  /** Commits awaiting stepFrame in manualFrames mode (oldest first). */
  private readonly pendingFrames: EngineCommit[] = [];

  constructor(options: FakeEngineOptions = {}) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    this.manualFrames = options.manualFrames ?? false;
    this.mountError = options.mountError ?? null;
    this.screenshot = options.screenshot ?? null;
  }

  /** Most recent commit, if any. */
  get lastCommit(): EngineCommit | undefined {
    return this.commits[this.commits.length - 1];
  }

  get destroyed(): boolean {
    return this.destroyedFlag;
  }

  /** Last setPinnedIndices value (null = unpinned / never pinned). */
  get pinnedIndices(): readonly number[] | null {
    return this.pinned;
  }

  /** Last setSelectedIndices value (null = cleared / never selected) — the
   * highlight mirror of {@link pinnedIndices}. */
  get selectedIndices(): readonly number[] | null {
    return this.selected;
  }

  /**
   * Structure of the most recent structure-bearing commit — the geometry the
   * engine currently holds. Buffer channels commit independently of structure,
   * so the newest commit often carries none.
   */
  get lastStructure(): NonNullable<EngineCommit['structure']> | undefined {
    for (let i = this.commits.length - 1; i >= 0; i--) {
      const structure = this.commits[i]!.structure;
      if (structure !== undefined) return structure;
    }
    return undefined;
  }

  /**
   * Most recently committed value of ONE buffer channel — the engine's current
   * content for it. Channels are committed independently (a mask drain may
   * carry `pointColor` alone), so scanning back per channel is the only way to
   * read composed state; the newest commit alone is not the whole picture.
   */
  lastBuffer(channel: keyof NonNullable<EngineCommit['buffers']>): Float32Array | undefined {
    // Newest FULL upload seeds the channel; any LATER ranged patches replay
    // over a copy in commit order — the return is what the engine
    // currently holds either way.
    let baseIndex = -1;
    let base: Float32Array | undefined;
    for (let i = this.commits.length - 1; i >= 0; i--) {
      const value = this.commits[i]!.buffers?.[channel];
      if (value !== undefined) {
        baseIndex = i;
        base = value;
        break;
      }
    }
    if (base === undefined) return undefined;
    let out = base;
    let copied = false;
    for (let i = baseIndex + 1; i < this.commits.length; i++) {
      const patches = this.commits[i]!.bufferPatches?.[channel];
      if (patches === undefined) continue;
      if (!copied) {
        out = out.slice();
        copied = true;
      }
      for (const patch of patches) out.set(patch.data, patch.start);
    }
    return out;
  }

  // --- GraphEngine contract ---

  /** Headless: never touches `container` — a dummy cast works under node. */
  mount(container: HTMLElement, events: EngineHostEvents): Promise<void> {
    this.record('mount', [container, events]);
    if (this.mountError !== null) return Promise.reject(this.mountError);
    this.events = events;
    return Promise.resolve();
  }

  commit(update: EngineCommit): void {
    if (this.destroyedFlag) {
      throw new Error('FakeEngine: commit() called after destroy()');
    }
    // tripwires: ranged patches are legal only on DECLARED channels,
    // never alongside a full buffer for the same channel in one commit, and
    // only after a full upload seeded the channel. Each is a producer bug
    // fail the test loudly instead of rendering stale state silently.
    if (update.bufferPatches !== undefined) {
      for (const [channel, patches] of Object.entries(update.bufferPatches)) {
        if (patches === undefined) continue;
        const ch = channel as keyof NonNullable<EngineCommit['buffers']>;
        if (!this.capabilities.rangeUpdates.includes(ch)) {
          throw new Error(`FakeEngine: bufferPatches.${channel} without the declared capability`);
        }
        if (update.buffers?.[ch] !== undefined) {
          throw new Error(
            `FakeEngine: commit carries BOTH buffers.${channel} and bufferPatches.${channel}`,
          );
        }
        const seeded = this.commits.some((c) => c.buffers?.[ch] !== undefined);
        if (!seeded) {
          throw new Error(
            `FakeEngine: bufferPatches.${channel} before any full upload seeded the channel`,
          );
        }
      }
    }
    this.record('commit', [update]);
    this.commits.push(update);
    if (update.structure !== undefined) this.lastLinks = update.structure.links;
    if (this.manualFrames) {
      this.pendingFrames.push(update);
    } else {
      this.apply(update);
    }
  }

  appliedRevision(): number | null {
    this.record('appliedRevision', []);
    return this.applied;
  }

  fitView(opts?: FitViewOptions): void {
    this.record('fitView', [opts]);
  }

  zoom(factor: number, durationMs?: number): void {
    this.record('zoom', [factor, durationMs]);
  }

  setViewport(v: Partial<ViewportState>, opts?: { durationMs?: number }): void {
    this.record('setViewport', [v, opts]);
    this.viewport = { ...this.viewport, ...v };
  }

  getViewport(): ViewportState | null {
    this.record('getViewport', []);
    return { ...this.viewport };
  }

  zoomToIndex(index: number, durationMs?: number): void {
    this.record('zoomToIndex', [index, durationMs]);
  }

  start(alpha?: number): void {
    this.record('start', [alpha]);
  }

  pause(): void {
    this.record('pause', []);
  }

  setSelectedIndices(indices: readonly number[] | null): void {
    this.record('setSelectedIndices', [indices]);
    this.selected = indices === null ? null : [...indices];
  }

  setFocusedIndex(index: number | null): void {
    this.record('setFocusedIndex', [index]);
  }

  /** Screen == space in the FakeEngine: ray-cast over current positions,
   * skipping NaN pairs (not-yet-applied structure in manualFrames mode). */
  pointsInPolygon(screenPolygon: readonly [number, number][]): number[] {
    this.record('pointsInPolygon', [screenPolygon]);
    const pos = this.positions;
    const out: number[] = [];
    if (pos === null || screenPolygon.length < 3) return out;
    for (let i = 0; i < pos.length / 2; i++) {
      const x = pos[2 * i]!;
      const y = pos[2 * i + 1]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      if (pointInPolygon(x, y, screenPolygon)) out.push(i);
    }
    return out;
  }

  /** Screen == space: point indices inside `[x0, y0, x1, y1]` (bounds
   * normalized), skipping NaN pairs (not-yet-applied structure). */
  pointsInRect(screenRect: readonly [number, number, number, number]): number[] {
    this.record('pointsInRect', [screenRect]);
    const pos = this.positions;
    const out: number[] = [];
    if (pos === null) return out;
    const minX = Math.min(screenRect[0], screenRect[2]);
    const maxX = Math.max(screenRect[0], screenRect[2]);
    const minY = Math.min(screenRect[1], screenRect[3]);
    const maxY = Math.max(screenRect[1], screenRect[3]);
    for (let i = 0; i < pos.length / 2; i++) {
      const x = pos[2 * i]!;
      const y = pos[2 * i + 1]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(i);
    }
    return out;
  }

  /** Resolves the constructor's `screenshot` option (null by default). */
  captureScreenshot(): Promise<Blob | null> {
    this.record('captureScreenshot', []);
    return Promise.resolve(this.screenshot);
  }

  /** 1-hop adjacency from the last committed links (self-loops excluded). */
  neighborIndices(index: number): number[] {
    this.record('neighborIndices', [index]);
    const links = this.lastLinks;
    if (links === null) return [];
    const out = new Set<number>();
    for (let k = 0; k < links.length; k += 2) {
      const s = links[k]!;
      const t = links[k + 1]!;
      if (s === index && t !== index) out.add(t);
      if (t === index && s !== index) out.add(s);
    }
    return [...out];
  }

  /** Identity transform: FakeEngine screen coordinates ARE space coordinates. */
  screenToSpace(p: readonly [number, number]): [number, number] | null {
    this.record('screenToSpace', [p]);
    return [p[0], p[1]];
  }

  /** Identity transform: FakeEngine screen coordinates ARE space coordinates. */
  spaceToScreen(p: readonly [number, number]): [number, number] | null {
    this.record('spaceToScreen', [p]);
    return [p[0], p[1]];
  }

  setPinnedIndices(indices: readonly number[] | null): void {
    this.record('setPinnedIndices', [indices]);
    this.pinned = indices === null ? null : [...indices];
  }

  getPositions(): Float32Array | null {
    this.record('getPositions', []);
    return this.positions === null ? null : new Float32Array(this.positions);
  }

  destroy(): void {
    this.record('destroy', []);
    this.destroyedFlag = true;
    this.events = null;
  }

  // --- test helpers (not part of GraphEngine) ---

  /**
   * manualFrames mode: apply the oldest queued commit, making its revision
   * visible via appliedRevision. No-op on the queue when empty. A drawn
   * frame is also an activity-clock sample, so a mounted engine gets an
   * `onFrame` tick.
   */
  stepFrame(): void {
    this.record('stepFrame', []);
    const next = this.pendingFrames.shift();
    if (next !== undefined) this.apply(next);
    if (this.events !== null) {
      this.frameClock += 16;
      this.events.onFrame?.(this.frameClock);
    }
  }

  /**
   * Drive the host `onFrame` activity clock. `timeMs` sets the clock
   * explicitly; omitted, the clock auto-advances by 16ms per call.
   */
  emitFrame(timeMs?: number): void {
    const events = this.requireMounted('emitFrame');
    this.frameClock = timeMs ?? this.frameClock + 16;
    this.record('emitFrame', [this.frameClock]);
    events.onFrame?.(this.frameClock);
  }

  /** Simulate simulation drift: shift every current position by (dx, dy). */
  nudgePositions(dx: number, dy: number): void {
    this.record('nudgePositions', [dx, dy]);
    const pos = this.positions;
    if (pos === null) return;
    for (let i = 0; i < pos.length; i += 2) {
      pos[i] = pos[i]! + dx;
      pos[i + 1] = pos[i + 1]! + dy;
    }
  }

  injectPointClick(index: number | null, modifiers?: { metaKey: boolean; shiftKey: boolean }): void {
    const events = this.requireMounted('injectPointClick');
    this.record('injectPointClick', [index, modifiers]);
    events.onPointClick?.(index, modifiers);
  }

  injectPointHover(index: number | null): void {
    const events = this.requireMounted('injectPointHover');
    this.record('injectPointHover', [index]);
    events.onPointHover?.(index);
  }

  injectLinkClick(linkIndex: number): void {
    const events = this.requireMounted('injectLinkClick');
    this.record('injectLinkClick', [linkIndex]);
    events.onLinkClick?.(linkIndex);
  }

  injectLinkHover(linkIndex: number | null): void {
    const events = this.requireMounted('injectLinkHover');
    this.record('injectLinkHover', [linkIndex]);
    events.onLinkHover?.(linkIndex);
  }

  injectDragStart(index: number): void {
    const events = this.requireMounted('injectDragStart');
    this.record('injectDragStart', [index]);
    events.onDragStart?.(index);
  }

  injectDragEnd(index: number, x: number, y: number): void {
    const events = this.requireMounted('injectDragEnd');
    this.record('injectDragEnd', [index, x, y]);
    events.onDragEnd?.(index, x, y);
  }

  injectContextMenu(index: number | null, screen: readonly [number, number]): void {
    const events = this.requireMounted('injectContextMenu');
    this.record('injectContextMenu', [index, screen]);
    events.onContextMenu?.(index, screen);
  }

  injectViewportChange(v: ViewportState): void {
    const events = this.requireMounted('injectViewportChange');
    this.record('injectViewportChange', [v]);
    this.viewport = { ...v };
    events.onViewportChange?.(v);
  }

  injectSimulationEnd(): void {
    const events = this.requireMounted('injectSimulationEnd');
    this.record('injectSimulationEnd', []);
    events.onSimulationEnd?.();
  }

  injectError(error: Error): void {
    const events = this.requireMounted('injectError');
    this.record('injectError', [error]);
    events.onError?.(error);
  }

  injectContextLost(): void {
    const events = this.requireMounted('injectContextLost');
    this.record('injectContextLost', []);
    events.onContextEvent?.({ type: 'lost' });
  }

  injectContextRestored(): void {
    const events = this.requireMounted('injectContextRestored');
    this.record('injectContextRestored', []);
    events.onContextEvent?.({ type: 'restored' });
  }

  injectContextFailed(error: Error): void {
    const events = this.requireMounted('injectContextFailed');
    this.record('injectContextFailed', [error]);
    events.onContextEvent?.({ type: 'failed', error });
  }

  injectEngineDiagnostic(d: EngineDiagnostic): void {
    const events = this.requireMounted('injectEngineDiagnostic');
    this.record('injectEngineDiagnostic', [d]);
    events.onDiagnostic?.(d);
  }

  // --- internals ---

  private record(method: string, args: unknown[]): void {
    // Trim trailing omitted optionals so `args` matches the caller's shape.
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    const call: RecordedCall = { method, args };
    this.calls.push(call);
    if (CAMERA_METHODS.has(method)) this.cameraCalls.push(call);
  }

  private requireMounted(helper: string): EngineHostEvents {
    const events = this.events;
    if (events === null) {
      throw new Error(`FakeEngine: ${helper}() requires a mounted engine — call mount() first`);
    }
    return events;
  }

  /**
   * Make a commit visible: rebuild positions when structure is present (NaN
   * pairs seeded deterministically, known coordinates kept verbatim) and
   * advance the applied revision.
   */
  private apply(update: EngineCommit): void {
    const structure = update.structure;
    if (structure !== undefined) {
      const { pointCount, positions } = structure;
      const next = new Float32Array(2 * pointCount);
      for (let i = 0; i < pointCount; i++) {
        const x = positions[2 * i]!;
        const y = positions[2 * i + 1]!;
        if (Number.isNaN(x) || Number.isNaN(y)) {
          const [sx, sy] = seedPosition(i);
          next[2 * i] = sx;
          next[2 * i + 1] = sy;
        } else {
          next[2 * i] = x;
          next[2 * i + 1] = y;
        }
      }
      this.positions = next;
    }
    this.applied = update.revision;
  }
}
