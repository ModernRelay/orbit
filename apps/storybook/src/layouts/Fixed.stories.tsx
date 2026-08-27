import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import type { DemoSnapshot } from '../fixtures/generate';
import { CLUSTER_COLOR_SCALE } from '../fixtures/scales';
import { sizeFromGlobals } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { circularFixed, gridFixed, radialTreeFixed } from '../fixtures/topologies';

const cache = new Map<string, DemoSnapshot>();
function snapFor(
  kind: string,
  maker: (seed: number, n: number) => DemoSnapshot,
  n: number,
): DemoSnapshot {
  const key = `${kind}:${n}`;
  let snap = cache.get(key);
  if (snap === undefined) {
    snap = maker(7, n);
    cache.set(key, snap);
  }
  return snap;
}

function frame(globals: Record<string, unknown>, snap: DemoSnapshot): ReactElement {
  const active = themeFromGlobals(globals);
  return (
    <GraphFrame background={active.background}>
      <DemoGraph
        engine={cosmosEngine}
        data={snap}
        theme={active.theme}
        linkColor={active.linkColor}
        nodeColor={CLUSTER_COLOR_SCALE}
        layout="fixed"
      />
    </GraphFrame>
  );
}

const meta = {
  title: 'Layouts/Fixed',
  parameters: {
    docs: {
      description: {
        component:
          'The fixed layout renders declared x/y exactly — bring positions from any ' +
          'algorithm and orbit draws them pixel-faithfully, no simulation involved. ' +
          'These layouts are computed in fixture code: a circle, a tidy radial tree ' +
          '(children fan under parents by subtree share), and a lattice.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Circular: Story = {
  render: (_args, { globals }) =>
    frame(globals, snapFor('circular', circularFixed, sizeFromGlobals(globals))),
};

export const RadialTree: Story = {
  render: (_args, { globals }) =>
    frame(globals, snapFor('radial', radialTreeFixed, sizeFromGlobals(globals))),
};

export const Grid: Story = {
  render: (_args, { globals }) =>
    frame(globals, snapFor('grid', gridFixed, sizeFromGlobals(globals))),
};
