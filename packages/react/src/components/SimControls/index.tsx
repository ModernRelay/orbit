/**
 * `@modernrelay/orbit-react/components/SimControls` — `<GraphSimControls>`,
 * the simulation control panel.
 *
 * Live sliders over the effective `SimulationConfig` fields (gravity,
 * repulsion, friction, linkDistance, linkSpring, collision, decay, center
 * repulsionTheta is omitted: inert on cosmos >= 3.4), a speed
 * preset toggle, and a reheat button. Every control write is ONE atomic
 * host update — `applyHostUpdate({ simulation: merged })`, the same lane the
 * `<Graph>` `simulation` prop uses — which sinks as a single config-only
 * `engine.commit`: no structure, no buffers, no restart, positions untouched.
 *
 * ## Current-value resolution (v0.10, investigated)
 * The store publishes NO simulation/layout lane and the instance exposes no
 * config getter — `layout`/`simulation` are instance-local in
 * `createGraphInstance`; `GraphStoreState` carries only `simulationRunning`.
 * The panel therefore mirrors the caller's `simulation` prop (the same
 * object handed to `<Graph>`) and merges control writes over that mirror; a
 * prop identity change re-seeds the mirror (the external writer wins). Like
 * `subgraph`, the lane is last-writer-wins: the panel and the
 * `<Graph>` prop write the same state. `onSimulationChange` fires with the
 * full merged config after every write so controlled callers can loop it
 * back through their `simulation` prop (the spec's `onLayoutChange` seam
 * traffics in the LayoutSpec object form and is post-v0.10).
 *
 * ## Applicability
 * Rendered ONLY under layout `'force'` — the `layout` prop mirrors the
 * caller's `<Graph>` prop for the same no-observable-lane reason, defaulting
 * to `'force'` (the instance construction default). Under `'fixed'` the
 * panel renders nothing. The spec's third case — `static` while its
 * convergence run is active — is N/A in v0.10: `LayoutKind` is
 * `'force' | 'fixed'` (core types.ts) and the store exposes no
 * convergence-run state; wire it when the `static` variant lands.
 *
 * ## Reheat
 * The spec names `reheat(alpha)`; the shipped instance surface is
 * `resumeSimulation` (simulation controls — sinks to
 * `engine.start` and publishes `simulationRunning`). The button calls
 * that; the alpha parameter follows when core grows the reheat API.
 *
 * ## Speed toggle
 * A preset over the `decay` lane — the cool-down tunable (cosmos
 * `simulationDecay`), which core exposes as of v0.10.2. ON writes a smaller
 * coefficient so the run cools SLOWER and stays lively; OFF restores the
 * pre-toggle value, or the engine default when the field was unset. The
 * toggle and the Cool-down slider are two views over one lane, so moving
 * either is reflected by the other. Same config-only commit discipline as
 * every slider. (Before v0.10.2 this proxied through `friction` because
 * `decay` had no core lane — that workaround is now retired.)
 *
 * ## Keyboard & ARIA
 * Native `<input type="range">`/checkbox controls with `<label htmlFor>`
 * wiring. Arrow/Home/End/Page keys are handled in `onKeyDown` with
 * `preventDefault` so stepping is deterministic both in browsers (never
 * double-steps against the native range keyboard model) and under jsdom
 * (which has no native range keyboard model at all).
 */

import { Fragment, useCallback, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { LayoutKind, SimulationConfig } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { cornerStyle, mergeStyle, useResolvedInstance } from '../shared';
import type { GraphCorner } from '../shared';

export type SimFieldKey = keyof SimulationConfig;

export interface SimFieldDescriptor {
  key: SimFieldKey;
  /** Visible label text (rendered as a text node). */
  label: string;
  min: number;
  max: number;
  step: number;
  /** Displayed when the field is unset — the engine default the simulation
   * is actually running with (cosmos 3.3.0 `defaultConfigValues`). Never
   * WRITTEN unless the user moves the control. */
  fallback: number;
}

/** slider roster = the full v0.10 `SimulationConfig` field list. */
export const SIM_FIELDS: readonly SimFieldDescriptor[] = [
  { key: 'gravity', label: 'Gravity', min: 0, max: 1, step: 0.01, fallback: 0.25 },
  { key: 'repulsion', label: 'Repulsion', min: 0, max: 2, step: 0.01, fallback: 1 },
  { key: 'friction', label: 'Friction', min: 0, max: 1, step: 0.01, fallback: 0.85 },
  { key: 'linkDistance', label: 'Link distance', min: 1, max: 100, step: 1, fallback: 10 },
  { key: 'linkSpring', label: 'Link spring', min: 0, max: 2, step: 0.01, fallback: 1 },
  // v0.10.2: the rest of the tunable set. `collision` and `center` ship
  // OFF at the engine default, so their sliders start at 0 — moving one is
  // what turns the force on.
  { key: 'collision', label: 'Collision', min: 0, max: 2, step: 0.01, fallback: 0 },
  { key: 'decay', label: 'Cool-down', min: 100, max: 20000, step: 100, fallback: 5000 },
  // repulsionTheta is deliberately absent: cosmos >= 3.4 ignores it
  // (grid-based repulsion) — a slider that visibly does nothing is worse
  // than no slider. The SimulationConfig field survives for other engines.
  { key: 'center', label: 'Centering', min: 0, max: 1, step: 0.01, fallback: 0 },
];

/** Speed-preset friction values (module JSDoc: the toggle's documented
 * simulation field is `friction` until core ships `decay`). */
export const SPEED_NORMAL_DECAY = 5000;
/** A smaller decay coefficient cools SLOWER, so the run keeps moving
 * "fast" here means "stays lively", matching the semantics. */
export const SPEED_FAST_DECAY = 1000;

export interface GraphSimControlsProps {
  /** Explicit instance (multi-instance pages); ambient context otherwise. */
  instance?: AnyGraphInstance;
  /** Active layout kind — mirror of the caller's <Graph> `layout` prop
   * (no observable lane exists; module JSDoc). Default 'force'. */
  layout?: LayoutKind;
  /** Current simulation config seed — the same object passed to <Graph>.
   * An identity change re-seeds the panel's mirror. */
  simulation?: SimulationConfig;
  /** Fires with the FULL merged SimulationConfig after every write. */
  onSimulationChange?: (next: SimulationConfig) => void;
  /** Render-prop REPLACEMENT for a field row; the default renders
   * label + native range input + value readout. `set` clamps/quantizes to
   * the descriptor's bounds and step before writing. */
  renderField?: (ctx: {
    field: SimFieldDescriptor;
    value: number;
    /** Stable id for `htmlFor` wiring in custom rows. */
    inputId: string;
    set: (value: number) => void;
  }) => ReactNode;
  /** Accessible name of the panel. Default 'Simulation controls'. */
  label?: string;
  /** Corner this panel anchors to. Default 'bottom-left'. */
  position?: GraphCorner;
  /** Distance from the two anchored edges in CSS px. Default 12. */
  offset?: number;
  /** Class hook for the root; providing it drops the default styles
   * INCLUDING placement — position it yourself in CSS. */
  className?: string;
  /** Style overrides merged over the defaults; an inset you set here
   * wins over the one `position` implies (resolved per axis). */
  style?: CSSProperties;
}

/** Decimal places of `step` — the quantization grid for keyboard stepping. */
function stepDecimals(step: number): number {
  const s = String(step);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Clamp to [min, max] and quantize to the step's decimal grid so repeated
 * keyboard steps never accumulate float noise (0.25 + 0.01 stays 0.26). */
function quantize(field: SimFieldDescriptor, raw: number): number {
  const clamped = Math.min(field.max, Math.max(field.min, raw));
  return Number(clamped.toFixed(stepDecimals(field.step)));
}

/** keyboard model for a slider; null = key not handled (let it pass). */
function keyboardTarget(field: SimFieldDescriptor, value: number, key: string): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return quantize(field, value + field.step);
    case 'ArrowLeft':
    case 'ArrowDown':
      return quantize(field, value - field.step);
    case 'PageUp':
      return quantize(field, value + field.step * 10);
    case 'PageDown':
      return quantize(field, value - field.step * 10);
    case 'Home':
      return field.min;
    case 'End':
      return field.max;
    default:
      return null;
  }
}

// --- styling defaults (headless-styleable: className/style override) ---
const PANEL_STYLE: CSSProperties = {
  width: 250,
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 10,
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.96)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  color: '#e8eaf0',
  font: '12px/1.4 system-ui, sans-serif',
};
const TITLE_STYLE: CSSProperties = { fontWeight: 600, fontSize: 13 };
const ROW_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };
const LABEL_STYLE: CSSProperties = { flex: 'none', width: 86, opacity: 0.8 };
const SLIDER_STYLE: CSSProperties = { flex: 1, minWidth: 0 };
const VALUE_STYLE: CSSProperties = {
  flex: 'none',
  width: 38,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};
const BUTTON_STYLE: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  padding: '4px 10px',
};
const STATUS_STYLE: CSSProperties = { opacity: 0.65 };

export function GraphSimControls(props: GraphSimControlsProps): ReactElement | null {
  const instance = useResolvedInstance(props.instance, '<GraphSimControls>');
  const baseId = useId();

  // Mirror of the last-known SimulationConfig (module JSDoc: no store lane
  // exists to subscribe to). Prop identity change re-seeds — external
  // writer wins (the React-documented derive-during-render pattern).
  const [mirror, setMirror] = useState<SimulationConfig>(() => props.simulation ?? {});
  const [seededFrom, setSeededFrom] = useState(props.simulation);
  if (seededFrom !== props.simulation) {
    setSeededFrom(props.simulation);
    setMirror(props.simulation ?? {});
  }

  /** Decay the speed preset restores on release; undefined = the field was
   * unset pre-toggle (restore the engine-default constant). */
  const preSpeedDecayRef = useRef<number | undefined>(undefined);

  // The one simulation lane the store DOES publish.
  const subscribe = useCallback(
    (onStoreChange: () => void) => instance.store.subscribe(onStoreChange),
    [instance],
  );
  const getRunning = useCallback(
    () => instance.store.getState().simulationRunning,
    [instance],
  );
  const simulationRunning = useSyncExternalStore(subscribe, getRunning, getRunning);

  // applicability gate — after hooks, per the rules of hooks.
  if ((props.layout ?? 'force') !== 'force') return null;

  /** ONE atomic config-only host update per control write. */
  const write = (next: SimulationConfig): void => {
    setMirror(next);
    instance.applyHostUpdate({ simulation: next });
    props.onSimulationChange?.(next);
  };

  const setField = (key: SimFieldKey, value: number): void => {
    const next: SimulationConfig = { ...mirror };
    next[key] = value;
    write(next);
  };

  // The preset holds exactly while decay sits at the fast value — the toggle
  // and the cool-down slider are two views over the same lane.
  const speedOn = mirror.decay === SPEED_FAST_DECAY;
  const toggleSpeed = (): void => {
    if (speedOn) {
      const restored = preSpeedDecayRef.current ?? SPEED_NORMAL_DECAY;
      preSpeedDecayRef.current = undefined;
      setField('decay', restored);
    } else {
      preSpeedDecayRef.current = mirror.decay;
      setField('decay', SPEED_FAST_DECAY);
    }
  };

  const panelLabel = props.label ?? 'Simulation controls';
  const speedId = `${baseId}-speed`;

  return (
    <div
      data-orbit-simcontrols=""
      role="group"
      aria-label={panelLabel}
      className={props.className}
      style={
        props.className !== undefined
          ? props.style
          : mergeStyle(
              { ...cornerStyle(props.position ?? 'bottom-left', props.offset), ...PANEL_STYLE },
              props.style,
            )
      }
    >
      <div data-orbit-simcontrols-title="" style={TITLE_STYLE}>
        {panelLabel}
      </div>

      {SIM_FIELDS.map((field) => {
        const value = mirror[field.key] ?? field.fallback;
        const inputId = `${baseId}-${field.key}`;
        const set = (v: number): void => {
          setField(field.key, quantize(field, v));
        };
        if (props.renderField !== undefined) {
          return (
            <Fragment key={field.key}>
              {props.renderField({ field, value, inputId, set })}
            </Fragment>
          );
        }
        return (
          <div key={field.key} data-orbit-simcontrols-field={field.key} style={ROW_STYLE}>
            <label htmlFor={inputId} style={LABEL_STYLE}>
              {field.label}
            </label>
            <input
              id={inputId}
              type="range"
              data-orbit-simcontrols-input={field.key}
              min={field.min}
              max={field.max}
              step={field.step}
              value={value}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) set(v);
              }}
              onKeyDown={(e) => {
                const target = keyboardTarget(field, value, e.key);
                if (target === null) return;
                // Suppress the browser's native range step so the write goes
                // through this handler exactly once (module JSDoc).
                e.preventDefault();
                if (target !== value) setField(field.key, target);
              }}
              style={SLIDER_STYLE}
            />
            <output
              htmlFor={inputId}
              data-orbit-simcontrols-value={field.key}
              style={VALUE_STYLE}
            >
              {String(value)}
            </output>
          </div>
        );
      })}

      <div data-orbit-simcontrols-speed-row="" style={ROW_STYLE}>
        <input
          id={speedId}
          type="checkbox"
          data-orbit-simcontrols-speed=""
          checked={speedOn}
          onChange={toggleSpeed}
        />
        <label htmlFor={speedId}>Speed boost</label>
      </div>

      <div style={ROW_STYLE}>
        <button
          type="button"
          data-orbit-simcontrols-reheat=""
          style={BUTTON_STYLE}
          onClick={() => {
            instance.resumeSimulation();
          }}
        >
          Reheat
        </button>
        <span data-orbit-simcontrols-status="" style={STATUS_STYLE}>
          {simulationRunning ? 'simulation running' : 'settled'}
        </span>
      </div>
    </div>
  );
}

/** tree-shake probe — must never reach a root-only consumer bundle. */
export const __ORBIT_SIMCONTROLS_SENTINEL__ = 'orbit-react/components/SimControls';
