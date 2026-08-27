import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import type { DemoGraphProps } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import type { DemoEdgeAttrs } from '../fixtures/generate';
import { sizedCache } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { clustered } from '../fixtures/topologies';

const data = sizedCache(clustered, 13);

function frame(globals: Record<string, unknown>, props: Partial<DemoGraphProps>): ReactElement {
  const active = themeFromGlobals(globals);
  return (
    <GraphFrame background={active.background}>
      <DemoGraph
        engine={cosmosEngine}
        data={data(globals)}
        theme={active.theme}
        {...props}
      />
    </GraphFrame>
  );
}

const meta = {
  title: 'Graph/Edges',
  parameters: {
    docs: {
      description: {
        component:
          'Link color and width are per-edge accessors over your typed edge attrs; ' +
          'arrows and link visibility are plain props. Here intra-community edges ' +
          'stay quiet while bridges between communities read as bright strands.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** bridges bright, intra-community edges quiet */
const bridgeColor = (edge: { attrs?: DemoEdgeAttrs }): string =>
  edge.attrs?.kind === 'inter' ? 'rgba(122, 162, 247, 0.9)' : 'rgba(148, 163, 184, 0.15)';
const bridgeWidth = (edge: { attrs?: DemoEdgeAttrs }): number =>
  edge.attrs?.kind === 'inter' ? 2.5 : 1;

export const PerEdgeColor: Story = {
  render: (_args, { globals }) => frame(globals, { linkColor: bridgeColor }),
};

export const PerEdgeWidth: Story = {
  render: (_args, { globals }) =>
    frame(globals, { linkColor: bridgeColor, linkWidth: bridgeWidth }),
};

export const Arrows: Story = {
  render: (_args, { globals }) => {
    const active = themeFromGlobals(globals);
    return frame(globals, { linkColor: active.linkColor, edgeArrows: true });
  },
};

export const HiddenLinks: Story = {
  render: (_args, { globals }) => frame(globals, { showLinks: false }),
};
