/**
 * degradation-ladder controller — pure state machine, no
 * engine, no store, injectable clock (the flap tests run on simulated time).
 *
 * Trigger model (the research-backed hybrid stack): count thresholds are
 * INITIAL HINTS — `evaluateCounts` is edge-triggered against the visible
 * counts; resource estimates and measured frame/input pressure may engage a
 * step EARLIER through their dedicated entry points. Every step carries:
 *
 * - separate engage/disengage thresholds: engage at > limit, disengage at
 * < limit × (1 − hysteresis) — the asymmetric band that prevents
 * boundary oscillation;
 * - a minimum dwell: once a step changes state it holds it for
 * `minimumDwellMs` regardless of the signal (the second flap guard).
 *
 * Resource steps engage strictly in `resourceDegradationOrder`;
 * `uniform-link-style` participates ONLY when explicitly listed — it can
 * erase data-encoded styling, so an order without it means resource
 * admission REJECTS before allocating rather than misrepresenting the
 * graph (`nextResourceStep` returns null when the order is exhausted).
 */

import type { DegradeEvent, DegradeStep, ResourceDegradeStep, ScaleLimits } from './types';

export const SCALE_LIMITS_DEFAULTS: ScaleLimits = Object.freeze({
  domLabelNodes: 100_000,
  pickingLinks: 250_000,
  histogramBatchNodes: 500_000,
  hysteresis: 0.1,
  minimumDwellMs: 1_000,
  resourceDegradationOrder: Object.freeze(['disable-transitions', 'defer-images'] as const),
});

const RESOURCE_STEPS: ReadonlySet<string> = new Set([
  'disable-transitions',
  'defer-images',
  'uniform-link-style',
]);

/**
 * Merge + sanitize a partial ScaleLimits over the defaults. Invalid fields
 * fall back to the default and are reported (the instance folds them into
 * ONE config warning — D7 read-once semantics live with the caller).
 */
export function resolveScaleLimits(input: Partial<ScaleLimits> | undefined): {
  limits: ScaleLimits;
  warnings: string[];
} {
  const warnings: string[] = [];
  const out = { ...SCALE_LIMITS_DEFAULTS } as {
    -readonly [K in keyof ScaleLimits]: ScaleLimits[K];
  };
  if (input === undefined) return { limits: out, warnings };
  const num = (key: 'domLabelNodes' | 'pickingLinks' | 'histogramBatchNodes' | 'minimumDwellMs'): void => {
    const v = input[key];
    if (v === undefined) return;
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
    else warnings.push(`limits.${key} must be a non-negative finite number (got ${String(v)})`);
  };
  num('domLabelNodes');
  num('pickingLinks');
  num('histogramBatchNodes');
  num('minimumDwellMs');
  if (input.hysteresis !== undefined) {
    const h = input.hysteresis;
    if (typeof h === 'number' && Number.isFinite(h) && h >= 0 && h < 1) out.hysteresis = h;
    else warnings.push(`limits.hysteresis must be in [0, 1) (got ${String(h)})`);
  }
  if (input.resourceDegradationOrder !== undefined) {
    const order = input.resourceDegradationOrder;
    const valid =
      Array.isArray(order) &&
      order.every((s) => RESOURCE_STEPS.has(s)) &&
      new Set(order).size === order.length;
    if (valid) out.resourceDegradationOrder = Object.freeze([...order]);
    else {
      warnings.push(
        'limits.resourceDegradationOrder must be unique resource steps ' +
          "('disable-transitions' | 'defer-images' | 'uniform-link-style')",
      );
    }
  }
  return { limits: Object.freeze(out), warnings };
}

interface StepState {
  engaged: boolean;
  /** Clock time of the last state CHANGE (dwell anchor). -Infinity = never. */
  changedAt: number;
  /** Why the current engagement happened (for correct disengage routing). */
  reason: DegradeEvent['reason'] | null;
}

export class DegradeController {
  private readonly steps = new Map<DegradeStep, StepState>();
  private activeCache: readonly DegradeStep[] = Object.freeze([]);

  constructor(
    readonly limits: ScaleLimits,
    private readonly now: () => number,
  ) {}

  isEngaged(step: DegradeStep): boolean {
    return this.steps.get(step)?.engaged === true;
  }

  /** Stable frozen list for GraphPerfSnapshot.activeDegradations. */
  activeSteps(): readonly DegradeStep[] {
    return this.activeCache;
  }

  /**
   * Edge-triggered count evaluation over the CURRENT visible counts.
   * Returns the events to emit (empty when nothing crossed its band or a
   * dwell is holding). Count-engaged steps disengage here; pressure- or
   * resource-engaged steps do NOT auto-disengage on counts — their signal
   * owns them (`clearPressure` / `releaseResourceSteps`).
   */
  evaluateCounts(visible: { nodes: number; edges: number }): DegradeEvent[] {
    const events: DegradeEvent[] = [];
    const counts: ReadonlyArray<readonly [DegradeStep, number, number]> = [
      ['cap-dom-labels', visible.nodes, this.limits.domLabelNodes],
      ['defer-link-picking', visible.edges, this.limits.pickingLinks],
      ['batch-histograms', visible.nodes, this.limits.histogramBatchNodes],
    ];
    for (const [step, value, limit] of counts) {
      const state = this.stateOf(step);
      if (!state.engaged) {
        if (value > limit && this.dwellOver(state)) {
          events.push(this.transition(step, state, true, 'count', visible));
        }
      } else if (state.reason === 'count') {
        if (value < limit * (1 - this.limits.hysteresis) && this.dwellOver(state)) {
          events.push(this.transition(step, state, false, 'count', visible));
        }
      }
    }
    return events;
  }

  /**
   * Pressure trigger (frame or input): engage a step EARLIER than its count
   * hint. No-op (null) when already engaged or dwell-held.
   */
  engageForPressure(
    step: DegradeStep,
    reason: 'frame-pressure' | 'input-pressure',
    visible: { nodes: number; edges: number },
  ): DegradeEvent | null {
    const state = this.stateOf(step);
    if (state.engaged || !this.dwellOver(state)) return null;
    return this.transition(step, state, true, reason, visible);
  }

  /** Release a pressure-engaged step once its signal normalizes. */
  clearPressure(step: DegradeStep, visible: { nodes: number; edges: number }): DegradeEvent | null {
    const state = this.stateOf(step);
    if (!state.engaged) return null;
    if (state.reason !== 'frame-pressure' && state.reason !== 'input-pressure') return null;
    if (!this.dwellOver(state)) return null;
    return this.transition(step, state, false, state.reason, visible);
  }

  /**
   * Resource-admission trigger: engage the NEXT not-yet-engaged step in the
   * declared order. Null when the order is exhausted — the caller must then
   * REJECT before allocating.
   */
  engageNextResourceStep(visible: { nodes: number; edges: number }): DegradeEvent | null {
    for (const step of this.limits.resourceDegradationOrder) {
      const state = this.stateOf(step);
      if (state.engaged) continue;
      // Admission pressure overrides dwell: rejecting a load because a
      // ladder step is dwell-held would fail data for a timer.
      return this.transition(step, state, true, 'resource-estimate', visible);
    }
    return null;
  }

  /** Release every resource-engaged step (pressure cleared / new budget). */
  releaseResourceSteps(visible: { nodes: number; edges: number }): DegradeEvent[] {
    const events: DegradeEvent[] = [];
    for (const step of this.limits.resourceDegradationOrder) {
      const state = this.stateOf(step);
      if (state.engaged && state.reason === 'resource-estimate') {
        events.push(this.transition(step, state, false, 'resource-estimate', visible));
      }
    }
    return events;
  }

  private stateOf(step: DegradeStep): StepState {
    let state = this.steps.get(step);
    if (state === undefined) {
      state = { engaged: false, changedAt: -Infinity, reason: null };
      this.steps.set(step, state);
    }
    return state;
  }

  private dwellOver(state: StepState): boolean {
    return this.now() - state.changedAt >= this.limits.minimumDwellMs || state.changedAt === -Infinity;
  }

  private transition(
    step: DegradeStep,
    state: StepState,
    engaged: boolean,
    reason: DegradeEvent['reason'],
    visible: { nodes: number; edges: number },
  ): DegradeEvent {
    state.engaged = engaged;
    state.changedAt = this.now();
    state.reason = engaged ? reason : null;
    const active: DegradeStep[] = [];
    for (const [s, st] of this.steps) if (st.engaged) active.push(s);
    this.activeCache = Object.freeze(active);
    return { step, engaged, reason, visible: { nodes: visible.nodes, edges: visible.edges } };
  }
}

export type { ResourceDegradeStep };
