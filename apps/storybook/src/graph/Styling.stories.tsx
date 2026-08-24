import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { generateGraph } from '../fixtures/generate';
import type { DemoNodeAttrs } from '../fixtures/generate';
import { CLUSTER_COLOR_SCALE, DEGREE_COLOR_SCALE, DEGREE_SIZE_SCALE } from '../fixtures/scales';
import { themeFromGlobals } from '../fixtures/themes';

const data = generateGraph({
  seed: 11,
  nodes: 800,
  clusters: 6,
  intraEdgeFactor: 1.6,
  interEdgeProb: 0.06,
  datasetKey: 'styling',
  sourceRevision: 1,
});

const UNIFORM_SIZE = (_node: { attrs?: DemoNodeAttrs }): number => 4;

interface StylingArgs {
  colorBy: 'cluster' | 'degree';
  sizeBy: 'uniform' | 'degree';
  edgeArrows: boolean;
  showLinks: boolean;
  onNodeClick: ReturnType<typeof fn>;
  onBackgroundClick: ReturnType<typeof fn>;
}

const meta = {
  title: 'Graph/Styling',
  parameters: {
    docs: {
      description: {
        component:
          'Node color and size take either a plain per-node function or a declarative ' +
          'Scale descriptor (categorical or sequential over a metric). Scales also feed ' +
          'the legend. Link color/width, arrows, and link visibility are props too.',
      },
    },
  },
  args: {
    colorBy: 'cluster',
    sizeBy: 'degree',
    edgeArrows: false,
    showLinks: true,
    onNodeClick: fn(),
    onBackgroundClick: fn(),
  },
  argTypes: {
    colorBy: { control: 'radio', options: ['cluster', 'degree'] },
    sizeBy: { control: 'radio', options: ['uniform', 'degree'] },
    onNodeClick: { table: { disable: true } },
    onBackgroundClick: { table: { disable: true } },
  },
} satisfies Meta<StylingArgs>;

export default meta;
type Story = StoryObj<StylingArgs>;

export const Styling: Story = {
  render: (args, { globals }) => {
    const active = themeFromGlobals(globals);
    return (
      <GraphFrame background={active.background}>
        <DemoGraph
          engine={cosmosEngine}
          data={data}
          theme={active.theme}
          linkColor={active.linkColor}
          nodeColor={args.colorBy === 'cluster' ? CLUSTER_COLOR_SCALE : DEGREE_COLOR_SCALE}
          nodeSize={args.sizeBy === 'degree' ? DEGREE_SIZE_SCALE : UNIFORM_SIZE}
          edgeArrows={args.edgeArrows}
          showLinks={args.showLinks}
          onNodeClick={args.onNodeClick}
          onBackgroundClick={args.onBackgroundClick}
        />
      </GraphFrame>
    );
  },
};
