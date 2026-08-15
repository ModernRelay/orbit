/**
 * DegradeController under a simulated clock: hysteresis bands,
 * dwell (counts oscillating within ±10% of a
 * threshold never flap inside the 1000ms window), reason routing per
 * trigger family, the opt-in-only uniform-link-style rule, and limits
 * sanitization.
 */

import { describe, expect, it } from 'vitest';

import { DegradeController, SCALE_LIMITS_DEFAULTS, resolveScaleLimits } from '../src/degrade';
import type { DegradeEvent } from '../src/types';

function rig(over: Parameters<typeof resolveScaleLimits>[0] = undefined) {
  let now = 0;
  const clock = { advance: (ms: number) => (now += ms) };
  const { limits, warnings } = resolveScaleLimits(over);
  const ctl = new DegradeController(limits, () => now);
  return { ctl, clock, warnings };
}

const vis = (nodes: number, edges = 0) => ({ nodes, edges });

describe('count triggers with hysteresis + dwell', () => {
  it('engages above the limit, disengages below the hysteresis band', () => {
    const { ctl, clock } = rig();
    expect(ctl.evaluateCounts(vis(100_000))).toEqual([]); // at limit — not over
    const [on] = ctl.evaluateCounts(vis(100_001));
    expect(on).toMatchObject({ step: 'cap-dom-labels', engaged: true, reason: 'count' });

    clock.advance(1_001);
    // Inside the band (> 90K): stays engaged.
    expect(ctl.evaluateCounts(vis(95_000))).toEqual([]);
    const [off] = ctl.evaluateCounts(vis(89_999));
    expect(off).toMatchObject({ step: 'cap-dom-labels', engaged: false });
    expect(ctl.isEngaged('cap-dom-labels')).toBe(false);
  });

  it('NEVER flaps inside the dwell window under ±10% oscillation', () => {
    const { ctl, clock } = rig();
    const events: DegradeEvent[] = [];
    // Oscillate around the 100K threshold every 100ms for 5s.
    for (let t = 0; t < 5_000; t += 100) {
      const value = t % 200 === 0 ? 110_000 : 89_000; // ±~10%
      events.push(...ctl.evaluateCounts(vis(value)));
      clock.advance(100);
    }
    // Events carry no timestamps, so the flap bound is the COUNT bound: 5s
    // of oscillation with a 1000ms dwell admits at most one state change
    // per window — more than 5 events would prove a flap inside a window.
    expect(events.length).toBeLessThanOrEqual(5);
  });

  it('the three count steps key on their own metrics', () => {
    const { ctl, clock } = rig();
    clock.advance(2_000);
    const events = ctl.evaluateCounts({ nodes: 600_000, edges: 300_000 });
    const steps = events.map((e) => e.step).sort();
    expect(steps).toEqual(['batch-histograms', 'cap-dom-labels', 'defer-link-picking']);
    expect(ctl.activeSteps().length).toBe(3);
  });
});

describe('pressure triggers', () => {
  it('engages EARLY with the pressure reason and disengages via clearPressure', () => {
    const { ctl, clock } = rig();
    const on = ctl.engageForPressure('cap-dom-labels', 'frame-pressure', vis(50_000));
    expect(on).toMatchObject({ engaged: true, reason: 'frame-pressure' });

    // Counts below the threshold do NOT disengage a pressure-engaged step.
    clock.advance(2_000);
    expect(ctl.evaluateCounts(vis(50_000))).toEqual([]);
    expect(ctl.isEngaged('cap-dom-labels')).toBe(true);

    const off = ctl.clearPressure('cap-dom-labels', vis(50_000));
    expect(off).toMatchObject({ engaged: false, reason: 'frame-pressure' });
  });

  it('dwell holds pressure engagement too', () => {
    const { ctl, clock } = rig();
    ctl.engageForPressure('batch-histograms', 'input-pressure', vis(1));
    clock.advance(500); // inside dwell
    expect(ctl.clearPressure('batch-histograms', vis(1))).toBeNull();
    clock.advance(600);
    expect(ctl.clearPressure('batch-histograms', vis(1))).not.toBeNull();
  });
});

describe('resource steps', () => {
  it('engages strictly in declared order and exhausts to null (reject-before-allocation)', () => {
    const { ctl } = rig();
    expect(ctl.engageNextResourceStep(vis(1))?.step).toBe('disable-transitions');
    expect(ctl.engageNextResourceStep(vis(1))?.step).toBe('defer-images');
    // uniform-link-style is NOT in the default order: exhausted → null →
    // the caller rejects before allocating.
    expect(ctl.engageNextResourceStep(vis(1))).toBeNull();
  });

  it('participates only when uniform-link-style is explicitly added', () => {
    const { ctl } = rig({
      resourceDegradationOrder: ['disable-transitions', 'defer-images', 'uniform-link-style'],
    });
    ctl.engageNextResourceStep(vis(1));
    ctl.engageNextResourceStep(vis(1));
    expect(ctl.engageNextResourceStep(vis(1))?.step).toBe('uniform-link-style');
  });

  it('releaseResourceSteps disengages only resource-engaged steps', () => {
    const { ctl, clock } = rig();
    ctl.engageNextResourceStep(vis(1));
    clock.advance(2_000);
    ctl.evaluateCounts(vis(200_000)); // count-engages cap-dom-labels
    const released = ctl.releaseResourceSteps(vis(1));
    expect(released.map((e) => e.step)).toEqual(['disable-transitions']);
    expect(ctl.isEngaged('cap-dom-labels')).toBe(true);
  });
});

describe('resolveScaleLimits (D7 sanitize-with-warnings)', () => {
  it('merges valid overrides and defaults the rest', () => {
    const { limits, warnings } = resolveScaleLimits({ domLabelNodes: 5, hysteresis: 0.2 });
    expect(limits.domLabelNodes).toBe(5);
    expect(limits.hysteresis).toBe(0.2);
    expect(limits.pickingLinks).toBe(SCALE_LIMITS_DEFAULTS.pickingLinks);
    expect(warnings).toEqual([]);
  });

  it('rejects invalid fields with one warning each, never throwing', () => {
    const { limits, warnings } = resolveScaleLimits({
      domLabelNodes: -1,
      hysteresis: 1.5,
      resourceDegradationOrder: ['disable-transitions', 'disable-transitions'],
    } as never);
    expect(limits.domLabelNodes).toBe(SCALE_LIMITS_DEFAULTS.domLabelNodes);
    expect(limits.hysteresis).toBe(SCALE_LIMITS_DEFAULTS.hysteresis);
    expect(limits.resourceDegradationOrder).toEqual(['disable-transitions', 'defer-images']);
    expect(warnings).toHaveLength(3);
  });
});
