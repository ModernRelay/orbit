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
          ['Minimal', 'Styling', 'Themes', 'Layout: force'],
          'Interaction',
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
  },
  initialGlobals: {
    theme: 'dark',
  },
};

export default preview;
