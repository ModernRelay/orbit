import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { CLUSTER_COLOR_SCALE } from '../fixtures/scales';
import { sizedCache } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { clustered } from '../fixtures/topologies';

const data = sizedCache(clustered, 29);

interface HoverArgs {
  emphasisRing: boolean;
  onNodeHover: ReturnType<typeof fn>;
  onEdgeHover: ReturnType<typeof fn>;
}

const meta = {
  title: 'Interaction/Hover & emphasis',
  parameters: {
    docs: {
      description: {
        component:
          'Pointer hover rings the node under the cursor (the emphasis ring — ' +
          'deliberately distinct from selection) and streams typed hover events. ' +
          'Toggle the ring off and hover becomes data-only.',
      },
    },
  },
  args: {
    emphasisRing: true,
    onNodeHover: fn(),
    onEdgeHover: fn(),
  },
  argTypes: {
    onNodeHover: { table: { disable: true } },
    onEdgeHover: { table: { disable: true } },
  },
} satisfies Meta<HoverArgs>;

export default meta;
type Story = StoryObj<HoverArgs>;

export const HoverEmphasis: Story = {
  render: (args, { globals }) => {
    const active = themeFromGlobals(globals);
    return (
      <GraphFrame background={active.background}>
        <DemoGraph
          engine={cosmosEngine}
          data={data(globals)}
          theme={active.theme}
          linkColor={active.linkColor}
          nodeColor={CLUSTER_COLOR_SCALE}
          emphasisRing={args.emphasisRing}
          onNodeHover={args.onNodeHover}
          onEdgeHover={args.onEdgeHover}
        />
      </GraphFrame>
    );
  },
};
