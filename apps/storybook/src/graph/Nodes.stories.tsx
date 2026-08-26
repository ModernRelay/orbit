import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import type { DemoGraphProps } from '../fixtures/DemoGraph';
import type { DemoNodeAttrs } from '../fixtures/generate';
import { CLUSTER_COLOR_SCALE, DEGREE_COLOR_SCALE, DEGREE_SIZE_SCALE, clusterColor } from '../fixtures/scales';
import { sizedCache } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { clustered } from '../fixtures/topologies';

const data = sizedCache(clustered, 11);

function frame(
  globals: Record<string, unknown>,
  props: Partial<DemoGraphProps>,
): ReactElement {
  const active = themeFromGlobals(globals);
  return (
    <GraphFrame background={active.background}>
      <DemoGraph
        engine={cosmosEngine}
        data={data(globals)}
        theme={active.theme}
        linkColor={active.linkColor}
        {...props}
      />
    </GraphFrame>
  );
}

const meta = {
  title: 'Graph/Nodes',
  parameters: {
    docs: {
      description: {
        component:
          'Node color and size each accept a per-node function or a declarative ' +
          'scale descriptor. Scales are structural values — categorical over a ' +
          'field, sequential over a metric — and they also feed the legend.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** plain per-node accessor — full control, no legend integration */
const colorFn = (node: { attrs?: DemoNodeAttrs }): string =>
  clusterColor(node.attrs?.cluster ?? 0);

export const FunctionColor: Story = {
  render: (_args, { globals }) => frame(globals, { nodeColor: colorFn }),
};

export const CategoricalScale: Story = {
  render: (_args, { globals }) => frame(globals, { nodeColor: CLUSTER_COLOR_SCALE }),
};

export const SequentialScale: Story = {
  render: (_args, { globals }) => frame(globals, { nodeColor: DEGREE_COLOR_SCALE }),
};

export const DegreeSize: Story = {
  render: (_args, { globals }) =>
    frame(globals, { nodeColor: CLUSTER_COLOR_SCALE, nodeSize: DEGREE_SIZE_SCALE }),
};

const UNIFORM = (_node: { attrs?: DemoNodeAttrs }): number => 4;

export const UniformSize: Story = {
  render: (_args, { globals }) =>
    frame(globals, { nodeColor: CLUSTER_COLOR_SCALE, nodeSize: UNIFORM }),
};
