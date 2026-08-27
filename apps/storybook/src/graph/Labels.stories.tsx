import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import type { DemoGraphProps } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import type { DemoNodeAttrs } from '../fixtures/generate';
import type { GraphNode, LabelConfig } from '@modernrelay/orbit-core';
import { CLUSTER_COLOR_SCALE, clusterColor } from '../fixtures/scales';
import { sizedCache } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { clustered } from '../fixtures/topologies';

const data = sizedCache(clustered, 17);

const labelOf = (node: GraphNode<DemoNodeAttrs>): string => node.attrs?.label ?? node.id;

/** labels appear once you zoom past 1.2, capped at the 48 top-ranked */
const LOD_LABELS: LabelConfig<DemoNodeAttrs> = { minZoom: 1.2, maxVisible: 48, getText: labelOf };
/** always-on labels for a handful of pinned ids */
const PINNED_LABELS: LabelConfig<DemoNodeAttrs> = {
  minZoom: 1.2,
  maxVisible: 24,
  showFor: ['n0', 'n1', 'n2', 'n3'],
  getText: labelOf,
};

function frame(globals: Record<string, unknown>, props: Partial<DemoGraphProps>): ReactElement {
  const active = themeFromGlobals(globals);
  return (
    <GraphFrame background={active.background}>
      <DemoGraph
        engine={cosmosEngine}
        data={data(globals)}
        theme={active.theme}
        linkColor={active.linkColor}
        nodeColor={CLUSTER_COLOR_SCALE}
        {...props}
      />
    </GraphFrame>
  );
}

const meta = {
  title: 'Graph/Labels',
  parameters: {
    docs: {
      description: {
        component:
          'The label lane is config, not markup: a zoom threshold, a ranked ' +
          'visibility cap, always-on ids, and a text accessor. `renderNodeLabel` is ' +
          'the JSX escape hatch — your component renders inside the label layer. ' +
          'Zoom in to see labels arrive.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const ZoomThreshold: Story = {
  render: (_args, { globals }) => frame(globals, { labels: LOD_LABELS }),
};

export const PinnedIds: Story = {
  render: (_args, { globals }) => frame(globals, { labels: PINNED_LABELS }),
};

export const CustomPills: Story = {
  render: (_args, { globals }) =>
    frame(globals, {
      labels: PINNED_LABELS,
      renderNodeLabel: ({ node, text }) => (
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            fontSize: 11,
            background: 'rgba(10, 14, 24, 0.85)',
            border: `1px solid ${clusterColor(node.attrs?.cluster ?? 0)}`,
            color: '#e8ebf2',
            whiteSpace: 'nowrap',
          }}
        >
          {text}
        </span>
      ),
    }),
};
