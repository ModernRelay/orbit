import type { Meta, StoryObj } from '@storybook/react-vite';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { sizedCache } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { clustered } from '../fixtures/topologies';

const data = sizedCache(clustered, 7);

const meta = {
  title: 'Graph/Minimal',
  component: DemoGraph,
  parameters: {
    docs: {
      description: {
        component:
          'The smallest possible orbit graph: an engine factory and a data snapshot. ' +
          'Everything else — layout, camera, theme, interaction — is defaults: the ' +
          'calm simulation preset, the settle-following camera, the fit zoom clamp.',
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
  },
  render: (args, { globals }) => {
    const active = themeFromGlobals(globals);
    return (
      <GraphFrame background={active.background}>
        <DemoGraph {...args} data={data(globals)} theme={active.theme} linkColor={active.linkColor} />
      </GraphFrame>
    );
  },
};
