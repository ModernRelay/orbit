import type { Meta, StoryObj } from '@storybook/react-vite';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { generateGraph } from '../fixtures/generate';
import { themeFromGlobals } from '../fixtures/themes';

const data = generateGraph({
  seed: 21,
  nodes: 1500,
  clusters: 6,
  intraEdgeFactor: 1.6,
  interEdgeProb: 0.06,
  datasetKey: 'layout-force',
  sourceRevision: 1,
});

interface ForceArgs {
  repulsion: number;
  gravity: number;
}

const meta = {
  title: 'Graph/Layout: force',
  parameters: {
    docs: {
      description: {
        component:
          'The GPU force layout runs in the engine; the simulation prop exposes live ' +
          'tunables. Move the sliders — each change re-heats the running simulation.',
      },
    },
  },
  args: {
    repulsion: 0.6,
    gravity: 0.25,
  },
  argTypes: {
    repulsion: { control: { type: 'range', min: 0, max: 2, step: 0.05 } },
    gravity: { control: { type: 'range', min: 0, max: 1, step: 0.05 } },
  },
} satisfies Meta<ForceArgs>;

export default meta;
type Story = StoryObj<ForceArgs>;

export const Force: Story = {
  render: (args, { globals }) => {
    const active = themeFromGlobals(globals);
    return (
      <GraphFrame background={active.background}>
        <DemoGraph
          engine={cosmosEngine}
          data={data}
          theme={active.theme}
          linkColor={active.linkColor}
          layout="force"
          simulation={{ repulsion: args.repulsion, gravity: args.gravity }}
        />
      </GraphFrame>
    );
  },
};
