import type { Meta, StoryObj } from '@storybook/react-vite';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { generateGraph } from '../fixtures/generate';
import { themeFromGlobals } from '../fixtures/themes';

const data = generateGraph({
  seed: 7,
  nodes: 300,
  clusters: 4,
  intraEdgeFactor: 1.6,
  interEdgeProb: 0.06,
  datasetKey: 'minimal',
  sourceRevision: 1,
});

const meta = {
  title: 'Graph/Minimal',
  component: DemoGraph,
  parameters: {
    docs: {
      description: {
        component:
          'The smallest possible orbit graph: an engine factory and a data snapshot. ' +
          'Everything else — layout, theme, interaction — is defaults.',
      },
      source: {
        code: `import { Graph } from '@modernrelay/orbit-react';
import { CosmosEngine } from '@modernrelay/orbit-engine-cosmos';

<Graph engine={() => new CosmosEngine()} data={snapshot} />`,
      },
    },
  },
  argTypes: {
    engine: { table: { disable: true } },
    data: { table: { disable: true } },
  },
} satisfies Meta<typeof DemoGraph>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Minimal: Story = {
  args: {
    engine: cosmosEngine,
    data,
  },
  render: (args, { globals }) => {
    const active = themeFromGlobals(globals);
    return (
      <GraphFrame background={active.background}>
        <DemoGraph {...args} theme={active.theme} linkColor={active.linkColor} />
      </GraphFrame>
    );
  },
};
