/**
 * Core-side quiescence invariant for the stop-at-rest claim.
 *
 * Core owns NO requestAnimationFrame loop: every per-frame consumer (label
 * projection, sim-hot readback, hit-test cadence) rides the engine's onFrame
 * fan-out, so when a quiescent engine stops delivering frames, core schedules
 * nothing of its own. These tests pin that with the rafAudit instrument over
 * a settled 5s fake-timer window — registrations, not ticks: a stopped loop
 * SCHEDULES nothing (a tick count can read zero while a loop still re-arms).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { container, makeInstance, snap } from './helpers';
import { installRafAudit } from '../src/testing/index';
import type { RafAudit } from '../src/testing/index';

let audit: RafAudit | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  audit?.uninstall();
  audit = null;
  vi.useRealTimers();
});

describe('instance quiescence', () => {
  it('a settled, camera-idle instance registers ZERO rAF callbacks over 5s', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c'], [
        ['a', 'b'],
        ['b', 'c'],
      ]),
    });
    const engine = h.engines[0]!;
    engine.injectSimulationEnd(); // the scene settles

    audit = installRafAudit(globalThis as unknown as Window);
    vi.advanceTimersByTime(5_000);

    expect(audit.registrations()).toBe(0);
    expect(audit.ticks()).toBe(0);
  });

  it('interaction and writes at rest schedule no core-side rAF either (all work rides onFrame)', async () => {
    // The OTHER side of the contract: even active flows must not create a
    // second loop — hover, selection, brush-style host updates all route
    // through synchronous publishes and the engine's own frame channel.
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({
      data: snap(1, ['a', 'b', 'c', 'd'], [
        ['a', 'b'],
        ['c', 'd'],
      ]),
    });
    const engine = h.engines[0]!;
    engine.injectSimulationEnd();

    audit = installRafAudit(globalThis as unknown as Window);
    engine.injectPointHover(1);
    h.instance.selectNodes(['a']);
    h.instance.emphasizeNode('c');
    h.instance.hideNodes(['d']);
    h.instance.applyHostUpdate({ theme: { base: 'light' } });
    vi.advanceTimersByTime(2_000);

    expect(audit.registrations()).toBe(0);
  });

  it('detach within the arming window disarms the dev tripwire (no page-global wrapper)', async () => {
    // A detached instance must not install the
    // page-global rAF wrapper and blame another instance's animation on the
    // ended session. The tripwire arms only under NODE_ENV=development and
    // only when a global rAF exists — stub both.
    vi.stubEnv('NODE_ENV', 'development');
    const g = globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number };
    const fakeRaf = (cb: FrameRequestCallback): number =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number;
    g.requestAnimationFrame = fakeRaf;
    try {
      const h = makeInstance({ fitViewOnFirstData: false });
      await h.instance.attach(container);
      h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
      h.engines[0]!.injectSimulationEnd(); // arms the 2s tripwire

      h.instance.detach(); // …but the session ends first
      vi.advanceTimersByTime(3_000);

      // The wrapper never installed: the global is still OUR stub.
      expect(g.requestAnimationFrame).toBe(fakeRaf);
    } finally {
      delete g.requestAnimationFrame;
      vi.unstubAllEnvs();
    }
  });

  it('node hover and edge sampling share the ONE frame-cadence clock', async () => {
    const h = makeInstance({ fitViewOnFirstData: false });
    await h.instance.attach(container);
    h.instance.applyHostUpdate({ data: snap(1, ['a', 'b'], [['a', 'b']]) });
    const engine = h.engines[0]!;

    expect(h.instance.getFrameCadence()).toBe(0);
    engine.emitFrame();
    engine.emitFrame();
    engine.emitFrame();
    expect(h.instance.getFrameCadence()).toBe(3);

    // Both hit-test routes observe the SAME clock — neither advances a
    // private one: sampling between frames leaves the cadence untouched.
    engine.injectPointHover(0); // native node route
    h.instance.sampleEdgeHover([5, 0]); // CPU fallback edge route
    h.instance.pickEdgeAt([5, 0]);
    expect(h.instance.getFrameCadence()).toBe(3);

    engine.emitFrame();
    expect(h.instance.getFrameCadence()).toBe(4);
  });
});
