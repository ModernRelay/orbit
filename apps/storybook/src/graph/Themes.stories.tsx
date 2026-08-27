import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ThemeInput } from '@modernrelay/orbit-core';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { sizedCache } from '../fixtures/sizes';
import {
  BACKGROUND,
  DARK_THEME,
  LIGHT_BACKGROUND,
  LIGHT_THEME,
  LINK_COLOR,
  LINK_COLOR_LIGHT,
} from '../fixtures/themes';
import { clustered } from '../fixtures/topologies';

const data = sizedCache(clustered, 17);

interface ThemesArgs {
  base: 'dark' | 'light';
}

const meta = {
  title: 'Graph/Themes',
  parameters: {
    docs: {
      description: {
        component:
          'Themes are partial-over-base inputs: pick the dark or light base and ' +
          'override only the tokens that differ. Swapping the theme prop restyles ' +
          'the live scene — no remount. This page drives themes with its own ' +
          'controls and ignores the global toolbar.',
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

export const BaseSwap: Story = {
  render: (args, { globals }) => {
    const dark = args.base === 'dark';
    return (
      <GraphFrame background={dark ? BACKGROUND : LIGHT_BACKGROUND}>
        <DemoGraph
          engine={cosmosEngine}
          data={data(globals)}
          theme={dark ? DARK_THEME : LIGHT_THEME}
          linkColor={dark ? LINK_COLOR : LINK_COLOR_LIGHT}
        />
      </GraphFrame>
    );
  },
};

/** every token stated: a custom brand theme over the dark base */
const MIDNIGHT: ThemeInput = {
  base: 'dark',
  background: '#020617',
  nodeDefault: '#7dd3fc',
  edgeDefault: 'rgba(125, 211, 252, 0.16)',
  accent: '#f472b6',
  emphasisRing: '#facc15',
};

export const CustomTokens: StoryObj = {
  render: (_args, { globals }) => (
    <GraphFrame background="#020617">
      <DemoGraph engine={cosmosEngine} data={data(globals)} theme={MIDNIGHT} />
    </GraphFrame>
  ),
};
