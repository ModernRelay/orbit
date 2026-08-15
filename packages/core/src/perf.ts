/**
 * frame/input pressure sampler — the shared state the
 * telemetry surface reports and the DegradeController consumes.
 *
 * Fed exclusively from the core's single onFrame fan-out (per Q11 the
 * sampler must be near-free or it worsens what it measures: every note is
 * O(1) arithmetic, no allocation, no timers of its own). Windows are
 * 250 ms of frame activity; per closed window the mean frame delta feeds an
 * EWMA and deltas beyond the dropped-frame bound count as drops — the
 * percentile-of-windows shape Chrome's smoothness guidance endorses over
 * average FPS. Under the gated activity clock a resting scene
 * produces NO frames: an empty stretch is not a stall, so windows close on
 * the next frame after the gap and gap time never inflates the EWMA.
 */

/** Window length for frame-time aggregation (ms). */
export const PRESSURE_WINDOW_MS = 250;

/** A frame delta at or beyond this counts as a dropped-frame stall (ms).
 * Two 60 Hz periods + slack: one missed vsync is jitter, two is a stall. */
export const DROPPED_FRAME_MS = 34;

/** Gaps at or beyond this are treated as the loop SLEEPING (quiescence),
 * not as a stall — the delta is discarded rather than aggregated. */
export const SLEEP_GAP_MS = 250;

export interface PressureSnapshot {
  /** EWMA of per-window mean frame deltas (ms); NaN until a window closes. */
  frameEwmaMs: number;
  /** Worst single frame delta observed since the last reset (ms). */
  worstFrameMs: number;
  /** Frames counted since the last reset. */
  frames: number;
  /** Deltas ≥ DROPPED_FRAME_MS since the last reset. */
  droppedFrames: number;
  /** Closed aggregation windows since the last reset. */
  windows: number;
  /** Frames observed while the scene was settled (idle wakeups) since the
   * last reset — 0 is the healthy reading under a gated clock. */
  idleWakeups: number;
}

export class PressureSampler {
  private lastFrameAt = NaN;
  private windowStart = NaN;
  private windowSum = 0;
  private windowCount = 0;
  private ewma = NaN;
  private worst = 0;
  private frames = 0;
  private dropped = 0;
  private windows = 0;
  private idleWakeups = 0;

  /**
   * Record one onFrame tick. `settled` marks a tick that arrived while the
   * scene was at rest (sim settled, no pending commit work) — the idle-
   * wakeup counter, which reads 0 when the gated activity clock is honest.
   */
  noteFrame(timeMs: number, settled: boolean): void {
    this.frames += 1;
    if (settled) this.idleWakeups += 1;
    const prev = this.lastFrameAt;
    this.lastFrameAt = timeMs;
    if (Number.isNaN(prev)) {
      this.windowStart = timeMs;
      return;
    }
    const delta = timeMs - prev;
    if (delta < 0) {
      // Clock went backwards (fresh adapter after recovery): restart cleanly.
      this.windowStart = timeMs;
      this.windowSum = 0;
      this.windowCount = 0;
      return;
    }
    if (delta >= SLEEP_GAP_MS) {
      // The loop slept (quiescence) — a gap is not a stall. Close any open
      // window without the gap and start fresh.
      this.closeWindow();
      this.windowStart = timeMs;
      return;
    }
    if (delta > this.worst) this.worst = delta;
    if (delta >= DROPPED_FRAME_MS) this.dropped += 1;
    this.windowSum += delta;
    this.windowCount += 1;
    if (timeMs - this.windowStart >= PRESSURE_WINDOW_MS) {
      this.closeWindow();
      this.windowStart = timeMs;
    }
  }

  snapshot(): PressureSnapshot {
    return {
      frameEwmaMs: this.ewma,
      worstFrameMs: this.worst,
      frames: this.frames,
      droppedFrames: this.dropped,
      windows: this.windows,
      idleWakeups: this.idleWakeups,
    };
  }

  /** Zero the accumulated counters (EWMA and frame anchor survive — the
   * smoothing is continuous; the counters are per-sample-period). */
  resetCounters(): void {
    this.worst = 0;
    this.frames = 0;
    this.dropped = 0;
    this.windows = 0;
    this.idleWakeups = 0;
  }

  private closeWindow(): void {
    if (this.windowCount === 0) return;
    const mean = this.windowSum / this.windowCount;
    this.windows += 1;
    // Alpha 0.3: ~4 windows (1s) to converge — responsive without flapping
    // on a single bad window (the degradation governor adds dwell on top).
    this.ewma = Number.isNaN(this.ewma) ? mean : this.ewma * 0.7 + mean * 0.3;
    this.windowSum = 0;
    this.windowCount = 0;
  }
}
