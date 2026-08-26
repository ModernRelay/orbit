import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { sizedCache } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { clustered } from '../fixtures/topologies';

const data = sizedCache(clustered, 33);

interface SelectionArgs {
  enableLasso: boolean;
  onSelectionChange: ReturnType<typeof fn>;
  onNodeClick: ReturnType<typeof fn>;
  onBackgroundClick: ReturnType<typeof fn>;
}

const meta = {
  title: 'Interaction/Selection',
  parameters: {
    docs: {
      description: {
        component:
          'Click a node to select it; meta-click accumulates; click the background to ' +
          'clear. With lasso enabled, shift-drag draws a polygon selection. Selection ' +
          'changes stream into the Actions panel via onSelectionChange. A host can also ' +
          'control selection fully through the `selection` prop (not shown here).',
      },
    },
  },
  args: {
    enableLasso: true,
    onSelectionChange: fn(),
    onNodeClick: fn(),
    onBackgroundClick: fn(),
  },
  argTypes: {
    onSelectionChange: { table: { disable: true } },
    onNodeClick: { table: { disable: true } },
    onBackgroundClick: { table: { disable: true } },
  },
} satisfies Meta<SelectionArgs>;

export default meta;
type Story = StoryObj<SelectionArgs>;

export const Selection: Story = {
  render: (args, { globals }) => {
    const active = themeFromGlobals(globals);
    return (
      <GraphFrame background={active.background}>
        <DemoGraph
          engine={cosmosEngine}
          data={data(globals)}
          theme={active.theme}
          linkColor={active.linkColor}
          enableLasso={args.enableLasso}
          onSelectionChange={args.onSelectionChange}
          onNodeClick={args.onNodeClick}
          onBackgroundClick={args.onBackgroundClick}
        />
      </GraphFrame>
    );
  },
};
