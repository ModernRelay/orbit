import type { Meta, StoryObj } from '@storybook/react-vite';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { sizeFromGlobals } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { FORCE_TOPOLOGIES } from '../fixtures/topologies';
import type { TopologyKind } from '../fixtures/topologies';
import type { DemoSnapshot } from '../fixtures/generate';

const cache = new Map<string, DemoSnapshot>();
function snapFor(kind: TopologyKind, n: number): DemoSnapshot {
  const key = `${kind}:${n}`;
  let snap = cache.get(key);
  if (snap === undefined) {
    snap = FORCE_TOPOLOGIES[kind](7, n);
    cache.set(key, snap);
  }
  return snap;
}

interface TopologyArgs {
  topology: TopologyKind;
}

const meta = {
  title: 'Graph/Topologies',
  parameters: {
    docs: {
      description: {
        component:
          'The same component, props, scales, and dimensions across very different ' +
          'structures — communities, a tree, a hub-and-spoke network, a bipartite ' +
          'graph, a ring, and disconnected islands. Structure comes from the data; ' +
          'orbit lays it out and keeps every feature working.',
      },
    },
  },
  args: {
    topology: 'tree',
  },
  argTypes: {
    topology: {
      control: 'radio',
      options: ['clustered', 'tree', 'scale-free', 'bipartite', 'ring', 'islands'],
    },
  },
} satisfies Meta<TopologyArgs>;

export default meta;
type Story = StoryObj<TopologyArgs>;

export const Topologies: Story = {
  render: (args, { globals }) => {
    const active = themeFromGlobals(globals);
    return (
      <GraphFrame background={active.background}>
        <DemoGraph
          engine={cosmosEngine}
          data={snapFor(args.topology, sizeFromGlobals(globals))}
          theme={active.theme}
          linkColor={active.linkColor}
        />
      </GraphFrame>
    );
  },
};
