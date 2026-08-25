/**
 * <GraphSimControls> simulation control panel tests
 * (jsdom + FakeEngine + real core).
 *
 * Covers: applicability gating (force renders, fixed renders nothing — the
 * spec's static-convergence case is N/A in v0.10: `LayoutKind` is
 * 'force' | 'fixed' and the store publishes no convergence-run state),
 * slider writes as exactly one config-only engine commit each, with no
 * structure, buffer, resource, or restart changes and byte-identical
 * positions; the merged-config round-trip through the host-update
 * lane (the store has no simulation slice — `revisions.render` is the
 * publication observable), reheat through the shipped API
 * (`resumeSimulation` → `engine.start`; `reheat(alpha)` is post-v0.10),
 * the speed preset over the decay lane, keyboard
 * operability on real range inputs, and the component foundation conventions
 * (label wiring, renderField replacement, explicit-instance resolution).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { createGraphInstance } from '@modernrelay/orbit-core';
import type { GraphInstance, GraphSnapshot, SimulationConfig } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { GraphProvider } from '../src/GraphProvider';
import {
  GraphSimControls,
  SIM_FIELDS,
  SPEED_FAST_DECAY,
  SPEED_NORMAL_DECAY,
} from '../src/components/SimControls/index';

// --- fixtures ----------------------------------------------------------------

const snapshot: GraphSnapshot = {
  datasetKey: 'sim-controls',
  sourceRevision: 1,
  nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
  edges: [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ],
};

// --- harness ------------------------------------------------------------------

const instances: GraphInstance[] = [];
const hosts: HTMLElement[] = [];

async function setup(
  props: Parameters<typeof GraphSimControls>[0] = {},
): Promise<{ instance: GraphInstance; engine: FakeEngine; view: RenderResult }> {
  const engine = new FakeEngine();
  const instance = createGraphInstance({ engine: () => engine });
  instances.push(instance);
  instance.applyHostUpdate({ data: snapshot });

  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  await instance.attach(host);

  const view = render(
    <GraphProvider instance={instance}>
      <GraphSimControls {...props} />
    </GraphProvider>,
  );
  return { instance, engine, view };
}

function slider(view: RenderResult, key: string): HTMLInputElement {
  const el = view.container.querySelector<HTMLInputElement>(
    `[data-orbit-simcontrols-input="${key}"]`,
  );
  if (el === null) throw new Error(`slider '${key}' not rendered`);
  return el;
}

/** The commits appended after `baseline`, for one-commit-per-write asserts. */
function commitsSince(engine: FakeEngine, baseline: number) {
  return engine.commits.slice(baseline);
}

/** Byte view of the engine's current positions (NaN payloads compare exactly). */
function positionBytes(engine: FakeEngine): Uint8Array {
  const pos = engine.getPositions();
  if (pos === null) throw new Error('engine holds no positions');
  return new Uint8Array(pos.buffer.slice(0));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const instance of instances) instance.destroy();
  instances.length = 0;
  for (const host of hosts) host.remove();
  hosts.length = 0;
});

// --- applicability gating ----------------------------------------

describe('<GraphSimControls> applicability gating', () => {
  it('renders the live panel under the default force layout with every SimConfig field', async () => {
    const { view } = await setup();
    const panel = view.container.querySelector('[data-orbit-simcontrols]');
    expect(panel).not.toBeNull();
    expect(panel!.getAttribute('role')).toBe('group');
    // one slider per SimulationConfig field.
    for (const field of SIM_FIELDS) {
      expect(slider(view, field.key).type).toBe('range');
    }
    // repulsionTheta is deliberately absent: inert on cosmos >= 3.4
    // (grid-based repulsion) — the SimulationConfig field survives for
    // engines that still run Barnes-Hut.
    expect(SIM_FIELDS.map((f) => f.key)).toEqual([
      'gravity',
      'repulsion',
      'friction',
      'linkDistance',
      'linkSpring',
      'collision',
      'decay',
      'center',
    ]);
  });

  it("renders nothing under layout 'fixed'", async () => {
    const { engine, view } = await setup({ layout: 'fixed' });
    expect(view.container.querySelector('[data-orbit-simcontrols]')).toBeNull();
    expect(view.container.textContent).toBe('');
    // Rendering the gated-off panel never touches the engine. (The mount
    // replay itself carries the resolved DEFAULT simulation config — the
    // 'calm' preset — so the assertion starts after setup.)
    const baseline = engine.commits.length;
    expect(view.container.querySelector('[data-orbit-simcontrols]')).toBeNull();
    const appended = engine.commits.slice(baseline).filter((c) => c.config?.simulation !== undefined);
    expect(appended).toEqual([]);
    // N/A note: the spec's "static while its convergence run is active" case
    // cannot be gated in v0.10 — `LayoutKind = 'force' | 'fixed'` (core
    // types.ts) has no 'static' variant and GraphStoreState publishes no
    // convergence-run field.
  });
});

// --- slider writes ---------------------------------------------

describe('<GraphSimControls> slider writes', () => {
  it('a slider change lands exactly one config-only commit reflecting the value, with one store publication', async () => {
    const { instance, engine, view } = await setup();
    const baseline = engine.commits.length;
    const renderBefore = instance.store.getState().revisions.render;
    let publishes = 0;
    const unsubscribe = instance.store.subscribe(() => {
      publishes += 1;
    });

    fireEvent.change(slider(view, 'gravity'), { target: { value: '0.5' } });

    const appended = commitsSince(engine, baseline);
    expect(appended.length).toBe(1);
    const commit = appended[0]!;
    expect(commit.config?.simulation).toEqual({ gravity: 0.5 });
    // Config-ONLY: no structure, no buffers, no resources, no restart.
    expect(commit.structure).toBeUndefined();
    expect(commit.buffers).toBeUndefined();
    expect(commit.resources).toBeUndefined();
    expect(commit.restart).toBeUndefined();
    // E1: the atomic host update published exactly once (render revision +1).
    expect(publishes).toBe(1);
    expect(instance.store.getState().revisions.render).toBe(renderBefore + 1);
    unsubscribe();
  });

  it('positions are byte-identical across a slider write (no reset, no restart)', async () => {
    const { engine, view } = await setup();
    // Simulate live drift so the assert is about REAL engine positions, not
    // the seeded spawn grid.
    engine.nudgePositions(3.25, -7.5);
    const before = positionBytes(engine);

    fireEvent.change(slider(view, 'repulsion'), { target: { value: '1.5' } });
    fireEvent.change(slider(view, 'linkDistance'), { target: { value: '42' } });

    expect(positionBytes(engine)).toEqual(before);
  });

  it('round-trips prior writes: the second commit carries the merged SimulationConfig', async () => {
    const { engine, view } = await setup();
    const baseline = engine.commits.length;

    fireEvent.change(slider(view, 'gravity'), { target: { value: '0.5' } });
    fireEvent.change(slider(view, 'friction'), { target: { value: '0.7' } });

    const appended = commitsSince(engine, baseline);
    expect(appended.length).toBe(2);
    // The panel's mirror round-trips the first write into the second — the
    // store publishes no simulation slice (v0.10), so the host-update lane
    // itself is the round-trip surface.
    expect(appended[1]!.config?.simulation).toEqual({ gravity: 0.5, friction: 0.7 });
    // The readout reflects the merged state.
    expect(
      view.container.querySelector('[data-orbit-simcontrols-value="gravity"]')!.textContent,
    ).toBe('0.5');
    expect(
      view.container.querySelector('[data-orbit-simcontrols-value="friction"]')!.textContent,
    ).toBe('0.7');
  });

  it('onSimulationChange fires with the full merged config and a simulation prop change re-seeds the panel', async () => {
    const seen: SimulationConfig[] = [];
    const { instance, view } = await setup({
      simulation: { gravity: 0.1 },
      onSimulationChange: (next) => {
        seen.push(next);
      },
    });
    expect(slider(view, 'gravity').value).toBe('0.1');

    fireEvent.change(slider(view, 'friction'), { target: { value: '0.9' } });
    expect(seen).toEqual([{ gravity: 0.1, friction: 0.9 }]);

    // Controlled loop-back: a NEW prop identity re-seeds the mirror.
    view.rerender(
      <GraphProvider instance={instance}>
        <GraphSimControls
          simulation={{ gravity: 0.8 }}
          onSimulationChange={(next) => {
            seen.push(next);
          }}
        />
      </GraphProvider>,
    );
    expect(slider(view, 'gravity').value).toBe('0.8');
    // The re-seed dropped the un-looped decay write, as documented: the
    // external writer wins.
    expect(slider(view, 'decay').value).toBe(String(SPEED_NORMAL_DECAY));
  });
});

// --- keyboard operability ----------------------------------------------

describe('<GraphSimControls> keyboard operability', () => {
  it('ArrowRight on a focused slider steps the value through the same config-only lane', async () => {
    const { engine, view } = await setup();
    const input = slider(view, 'gravity');
    input.focus();
    const baseline = engine.commits.length;

    fireEvent.keyDown(input, { key: 'ArrowRight' });

    expect(input.value).toBe('0.26'); // fallback 0.25 + step 0.01, no float noise
    const appended = commitsSince(engine, baseline);
    expect(appended.length).toBe(1);
    expect(appended[0]!.config?.simulation).toEqual({ gravity: 0.26 });
    expect(appended[0]!.structure).toBeUndefined();
    expect(appended[0]!.buffers).toBeUndefined();
    expect(appended[0]!.restart).toBeUndefined();
  });

  it('Home/End jump to the bounds and a step at a bound writes nothing', async () => {
    const { engine, view } = await setup();
    const input = slider(view, 'gravity');
    input.focus();
    const baseline = engine.commits.length;

    fireEvent.keyDown(input, { key: 'End' });
    expect(input.value).toBe('1');
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // clamped: already at max
    fireEvent.keyDown(input, { key: 'Home' });
    expect(input.value).toBe('0');
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // clamped: already at min

    // Only the two moves that CHANGED the value committed (E1: no no-op writes).
    const appended = commitsSince(engine, baseline);
    expect(appended.map((c) => c.config?.simulation)).toEqual([
      { gravity: 1 },
      { gravity: 0 },
    ]);
  });

  it('every slider is label-wired for (htmlFor === input id)', async () => {
    const { view } = await setup();
    for (const field of SIM_FIELDS) {
      const input = slider(view, field.key);
      const label = view.container.querySelector<HTMLLabelElement>(
        `label[for="${input.id}"]`,
      );
      expect(label, `label for '${field.key}'`).not.toBeNull();
      expect(label!.textContent).toBe(field.label);
    }
  });
});

// --- reheat + speed toggle -----------------------------------------

describe('<GraphSimControls> reheat and speed toggle', () => {
  it('reheat invokes the shipped API (resumeSimulation → engine.start) and flips simulationRunning', async () => {
    const { instance, engine, view } = await setup();
    // The attach replay restarted the force layout; reheat's scenario is a
    // settled/paused simulation.
    act(() => {
      instance.pauseSimulation();
    });
    expect(instance.store.getState().simulationRunning).toBe(false);
    const resumeSpy = vi.spyOn(instance, 'resumeSimulation');
    const baseline = engine.commits.length;
    const startsBefore = engine.calls.filter((c) => c.method === 'start').length;

    fireEvent.click(view.container.querySelector('[data-orbit-simcontrols-reheat]')!);

    // The documented v0.10 reheat API: resumeSimulation (reheat(alpha) is
    // not on the instance surface — module JSDoc). It is an engine start,
    // never a commit.
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(engine.calls.filter((c) => c.method === 'start').length).toBe(startsBefore + 1);
    expect(engine.commits.length).toBe(baseline);
    expect(instance.store.getState().simulationRunning).toBe(true);
  });

  it('the speed toggle writes the decay preset as one config-only commit and the mirror round-trips it', async () => {
    const { engine, view } = await setup();
    const checkbox = view.container.querySelector<HTMLInputElement>(
      '[data-orbit-simcontrols-speed]',
    )!;
    expect(checkbox.checked).toBe(false);
    const baseline = engine.commits.length;

    fireEvent.click(checkbox);

    let appended = commitsSince(engine, baseline);
    expect(appended.length).toBe(1);
    expect(appended[0]!.config?.simulation).toEqual({ decay: SPEED_FAST_DECAY });
    expect(appended[0]!.structure).toBeUndefined();
    expect(appended[0]!.buffers).toBeUndefined();
    expect(appended[0]!.restart).toBeUndefined();
    expect(checkbox.checked).toBe(true);

    // Round-trip: a following slider write carries the toggled decay.
    fireEvent.change(slider(view, 'gravity'), { target: { value: '0.4' } });
    appended = commitsSince(engine, baseline);
    expect(appended[1]!.config?.simulation).toEqual({
      decay: SPEED_FAST_DECAY,
      gravity: 0.4,
    });

    // Release restores the engine-default constant (the field was unset
    // pre-toggle — module JSDoc).
    fireEvent.click(checkbox);
    appended = commitsSince(engine, baseline);
    expect(appended[2]!.config?.simulation).toEqual({
      decay: SPEED_NORMAL_DECAY,
      gravity: 0.4,
    });
    expect(checkbox.checked).toBe(false);
  });

  it('the speed toggle restores a user-set decay on release', async () => {
    const { engine, view } = await setup();
    const checkbox = view.container.querySelector<HTMLInputElement>(
      '[data-orbit-simcontrols-speed]',
    )!;
    fireEvent.change(slider(view, 'decay'), { target: { value: '2000' } });
    const baseline = engine.commits.length;

    fireEvent.click(checkbox);
    expect(commitsSince(engine, baseline)[0]!.config?.simulation).toEqual({
      decay: SPEED_FAST_DECAY,
    });
    fireEvent.click(checkbox);
    expect(commitsSince(engine, baseline)[1]!.config?.simulation).toEqual({ decay: 2000 });
    // …and the slider reflects the restored value, not the preset.
    expect(slider(view, 'decay').value).toBe('2000');
  });
});

// --- foundation conventions ------------------------------------------------------

describe('<GraphSimControls> foundation conventions', () => {
  it('renderField replaces the default row while keeping the write wiring', async () => {
    const { engine, view } = await setup({
      renderField: ({ field, value, set }) =>
        field.key === 'gravity' ? (
          <button
            type="button"
            data-custom-field=""
            onClick={() => {
              set(value + 0.05);
            }}
          >
            {`${field.label}:${value}`}
          </button>
        ) : null,
    });
    // Default rows are fully replaced.
    expect(view.container.querySelector('[data-orbit-simcontrols-input="gravity"]')).toBeNull();
    const custom = view.container.querySelector<HTMLButtonElement>('[data-custom-field]')!;
    expect(custom.textContent).toBe('Gravity:0.25');

    const baseline = engine.commits.length;
    fireEvent.click(custom);
    const appended = commitsSince(engine, baseline);
    expect(appended.length).toBe(1);
    expect(appended[0]!.config?.simulation).toEqual({ gravity: 0.3 });
  });

  it('resolves an explicit instance prop without a provider', async () => {
    const engine = new FakeEngine();
    const instance = createGraphInstance({ engine: () => engine });
    instances.push(instance);
    instance.applyHostUpdate({ data: snapshot });
    const host = document.createElement('div');
    document.body.appendChild(host);
    hosts.push(host);
    await instance.attach(host);

    const view = render(<GraphSimControls instance={instance} />);
    expect(view.container.querySelector('[data-orbit-simcontrols]')).not.toBeNull();

    act(() => {
      fireEvent.change(slider(view, 'gravity'), { target: { value: '0.33' } });
    });
    expect(engine.lastCommit?.config?.simulation).toEqual({ gravity: 0.33 });
  });
});
