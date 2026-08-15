/**
 * requestAnimationFrame audit — the quiescence instrument.
 *
 * Wraps a window's `requestAnimationFrame` and counts SCHEDULING calls
 * (registrations) separately from delivered ticks: the stop-at-rest claim is
 * about registrations — a truly stopped loop schedules nothing at all, while
 * tick counts alone can read zero under fake timers even though a loop is
 * still re-arming itself.
 *
 * Used three ways: core/react quiescence tests (install, drive the instance,
 * assert `registrations === 0` over a settled window), the demo e2e's
 * page-side counterpart (same shape, injected via addInitScript), and the
 * dev-mode runtime assertion in the instance. The M0 spike's instrument.ts
 * pioneered the wrapper; this is its reusable, uninstallable form.
 */

export interface RafAudit {
  /** requestAnimationFrame CALLS observed since install (scheduling). */
  registrations(): number;
  /** Callbacks actually delivered since install (ticks). */
  ticks(): number;
  /** Zero both counters without uninstalling. */
  reset(): void;
  /** Restore the original requestAnimationFrame. Idempotent. */
  uninstall(): void;
}

/**
 * Install the audit on `win` (default: globalThis). Under jsdom + vitest
 * fake timers, rAF is timer-backed, so `vi.advanceTimersByTime` drives
 * deliveries — registrations count regardless. In a rAF-less environment
 * (plain-Node core tests) a 16ms setTimeout shim delivers: without the
 * audit, any rAF call there would simply crash — with it, the call is
 * COUNTED, which is exactly the evidence a quiescence test wants.
 */
export function installRafAudit(win: Window = globalThis as unknown as Window): RafAudit {
  const target = win as Window & {
    requestAnimationFrame?: typeof requestAnimationFrame;
  };
  const original = target.requestAnimationFrame;
  const native: typeof requestAnimationFrame =
    original !== undefined
      ? original.bind(target)
      : (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
  let registrations = 0;
  let ticks = 0;
  let installed = true;

  const wrapper = (callback: FrameRequestCallback): number => {
    registrations += 1;
    return native((time) => {
      ticks += 1;
      callback(time);
    });
  };
  target.requestAnimationFrame = wrapper;

  return {
    registrations: () => registrations,
    ticks: () => ticks,
    reset: () => {
      registrations = 0;
      ticks = 0;
    },
    uninstall: () => {
      if (!installed) return;
      installed = false;
      // Only restore if nobody else re-wrapped after us — otherwise leave
      // the newer wrapper in place and simply stop counting (native is
      // already bound into it).
      if (target.requestAnimationFrame === wrapper) {
        if (original !== undefined) target.requestAnimationFrame = original;
        else Reflect.deleteProperty(target, 'requestAnimationFrame');
      }
    },
  };
}
