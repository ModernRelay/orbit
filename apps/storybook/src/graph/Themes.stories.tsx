import type { Meta, StoryObj } from '@storybook/react-vite';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { generateGraph } from '../fixtures/generate';
import {
  BACKGROUND,
  DARK_THEME,
  LIGHT_BACKGROUND,
  LIGHT_THEME,
  LINK_COLOR,
  LINK_COLOR_LIGHT,
} from '../fixtures/themes';

const data = generateGraph({
  seed: 17,
  nodes: 800,
  clusters: 6,
  intraEdgeFactor: 1.6,
  interEdgeProb: 0.06,
  datasetKey: 'themes',
  sourceRevision: 1,
});

interface ThemesArgs {
  base: 'dark' | 'light';
}

const meta = {
  title: 'Graph/Themes',
  parameters: {
    docs: {
      description: {
        component:
          'Themes are partial-over-base inputs: pick the dark or light base and override ' +
          'only the tokens that differ (here: the canvas background). Swapping the theme ' +
          'prop restyles the live scene — no remount. This story drives the theme with ' +
          'its own control and ignores the global toolbar.',
      },
    },
  },
  args: {
    base: 'dark',
  },
  argTypes: {
    base: { control: 'radio', options: ['dark', 'light'] },
  },
} satisfies Meta<ThemesArgs>;

export default meta;
type Story = StoryObj<ThemesArgs>;

export const Themes: Story = {
  render: (args) => {
    const dark = args.base === 'dark';
    return (
      <GraphFrame background={dark ? BACKGROUND : LIGHT_BACKGROUND}>
        <DemoGraph
          engine={cosmosEngine}
          data={data}
          theme={dark ? DARK_THEME : LIGHT_THEME}
          linkColor={dark ? LINK_COLOR : LINK_COLOR_LIGHT}
        />
      </GraphFrame>
    );
  },
};
