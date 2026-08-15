/**
 * RestoreDeadline — a visibility-aware countdown used while a WebGL context is
 * lost. Browsers routinely defer `webglcontextrestored` for backgrounded tabs,
 * so the budget must only burn while the document is visible: hidden time is
 * banked (timer cleared, remaining ms kept) and the countdown re-arms from the
 * remainder when the tab becomes visible again.
 */
export class RestoreDeadline {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Unspent budget in ms; recomputed each time the timer is disarmed. */
  private remaining: number;
  /** Timestamp when the current timer was armed (for banking on hide). */
  private armedAt = 0;
  private started = false;
  /** Terminal: set on expiry or cancel; guarantees onExpire fires at most once. */
  private done = false;

  private readonly handleVisibilityChange = (): void => {
    if (this.done) return;
    if (this.doc.visibilityState === 'visible') this.arm();
    else this.disarm();
  };

  constructor(
    private readonly doc: Document,
    ms: number,
    private readonly onExpire: () => void,
  ) {
    this.remaining = ms;
  }

  start(): void {
    if (this.done || this.started) return;
    this.started = true;
    this.doc.addEventListener('visibilitychange', this.handleVisibilityChange);
    if (this.doc.visibilityState === 'visible') this.arm();
  }

  cancel(): void {
    if (this.done) return;
    this.done = true;
    if (this.timer !== null) {
      globalThis.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.started) {
      this.doc.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
  }

  private arm(): void {
    if (this.timer !== null) return;
    this.armedAt = Date.now();
    this.timer = globalThis.setTimeout(() => {
      this.timer = null;
      this.done = true;
      this.doc.removeEventListener('visibilitychange', this.handleVisibilityChange);
      this.onExpire();
    }, this.remaining);
  }

  private disarm(): void {
    if (this.timer === null) return;
    globalThis.clearTimeout(this.timer);
    this.timer = null;
    this.remaining = Math.max(0, this.remaining - (Date.now() - this.armedAt));
  }
}
