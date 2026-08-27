import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { SIMULATION_PRESETS } from '@modernrelay/orbit-core';
import type { SimulationInput, SimulationPreset } from '@modernrelay/orbit-core';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import type { DemoGraphHandle } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { sizedCache } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { clustered } from '../fixtures/topologies';

const data = sizedCache(clustered, 21);

/**
 * A simulation-only update deliberately preserves positions and does NOT
 * restart the engine (core contract) — so once the calm preset settles,
 * changing a value would show nothing. The host-side answer is the shipped
 * reheat API: resume the simulation when the config changes.
 */
function ReheatingGraph(props: {
  globals: Record<string, unknown>;
  simulation: SimulationInput;
}): ReactElement {
  const ref = useRef<DemoGraphHandle | null>(null);
  const simKey = JSON.stringify(props.simulation);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ref.current?.instance.resumeSimulation();
  }, [simKey]);
  const active = themeFromGlobals(props.globals);
  return (
    <GraphFrame background={active.background}>
      <DemoGraph
        ref={ref}
        engine={cosmosEngine}
        data={data(props.globals)}
        theme={active.theme}
        linkColor={active.linkColor}
        layout="force"
        simulation={props.simulation}
      />
    </GraphFrame>
  );
}

interface PresetArgs {
  preset: SimulationPreset;
}

const presetMeta = {
  title: 'Layouts/Force',
  parameters: {
    docs: {
      description: {
        component:
          'The GPU force layout ships measured presets — calm (the default: ' +
          'visually still in about five seconds), spread, tight, and lively (the ' +
          "engine's own continuous-motion defaults). A full SimulationConfig is " +
          'accepted anywhere a preset is.',
      },
    },
  },
  args: {
    preset: 'calm',
  },
  argTypes: {
    preset: { control: 'radio', options: ['calm', 'spread', 'tight', 'lively'] },
  },
} satisfies Meta<PresetArgs>;

export default presetMeta;
type PresetStory = StoryObj<PresetArgs>;

export const Presets: PresetStory = {
  render: (args, { globals }) => <ReheatingGraph globals={globals} simulation={args.preset} />,
};

interface TunableArgs {
  repulsion: number;
  gravity: number;
  friction: number;
  decay: number;
}

export const Tunables: StoryObj<TunableArgs> = {
  args: {
    repulsion: SIMULATION_PRESETS.calm.repulsion ?? 1.4,
    gravity: SIMULATION_PRESETS.calm.gravity ?? 0.15,
    friction: SIMULATION_PRESETS.calm.friction ?? 0.6,
    decay: SIMULATION_PRESETS.calm.decay ?? 1000,
  },
  argTypes: {
    repulsion: { control: { type: 'range', min: 0, max: 2.5, step: 0.05 } },
    gravity: { control: { type: 'range', min: 0, max: 1, step: 0.05 } },
    friction: { control: { type: 'range', min: 0.1, max: 1, step: 0.05 } },
    decay: { control: { type: 'range', min: 200, max: 8000, step: 100 } },
  },
  render: (args, { globals }) => (
    <ReheatingGraph
      globals={globals}
      simulation={{
        repulsion: args.repulsion,
        gravity: args.gravity,
        friction: args.friction,
        decay: args.decay,
      }}
    />
  ),
};
