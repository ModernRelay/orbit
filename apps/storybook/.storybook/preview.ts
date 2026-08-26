import type { Preview } from '@storybook/react-vite';

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/,
      },
    },
    options: {
      storySort: {
        order: [
          'Introduction',
          ['What is orbit', 'Data shapes', 'Testing without WebGL'],
          'Graph',
          ['Minimal', 'Topologies', 'Nodes', 'Edges', 'Labels', 'Themes'],
          'Layouts',
          ['Force', 'Fixed', 'Fixed to force'],
          'Interaction',
          ['Selection', 'Hover & emphasis', 'Context menu'],
          'Exploration',
          'Analytics',
          'Components',
          'Persistence',
          'Scale',
        ],
      },
    },
  },
  tags: ['autodocs'],
  globalTypes: {
    theme: {
      description: 'Graph theme',
      toolbar: {
        icon: 'mirror',
        items: ['dark', 'light'],
        dynamicTitle: true,
      },
    },
    size: {
      description: 'Graph size (nodes)',
      toolbar: {
        icon: 'grow',
        items: [
          { value: 'S', title: 'S — 300 nodes' },
          { value: 'M', title: 'M — 1,500 nodes' },
          { value: 'L', title: 'L — 8,000 nodes' },
          { value: 'XL', title: 'XL — 40,000 nodes' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: {
    theme: 'dark',
    size: 'M',
  },
};

export default preview;
