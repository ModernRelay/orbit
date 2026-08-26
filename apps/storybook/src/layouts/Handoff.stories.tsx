import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { LayoutKind } from '@modernrelay/orbit-core';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import { CLUSTER_COLOR_SCALE } from '../fixtures/scales';
import { sizeFromGlobals } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { radialTreeFixed } from '../fixtures/topologies';
import type { DemoSnapshot } from '../fixtures/generate';

const cache = new Map<number, DemoSnapshot>();
function snapFor(n: number): DemoSnapshot {
  let snap = cache.get(n);
  if (snap === undefined) {
    snap = radialTreeFixed(7, n);
    cache.set(n, snap);
  }
  return snap;
}

function HandoffDemo(props: { globals: Record<string, unknown> }) {
  const [layout, setLayout] = useState<LayoutKind>('fixed');
  const active = themeFromGlobals(props.globals);
  return (
    <GraphFrame background={active.background}>
      <DemoGraph
        engine={cosmosEngine}
        data={snapFor(sizeFromGlobals(props.globals))}
        theme={active.theme}
        linkColor={active.linkColor}
        nodeColor={CLUSTER_COLOR_SCALE}
        layout={layout}
      />
      <button
        onClick={() => setLayout(layout === 'fixed' ? 'force' : 'fixed')}
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          padding: '8px 14px',
          borderRadius: 8,
          border: '1px solid rgba(140, 160, 210, 0.3)',
          background: 'rgba(10, 14, 24, 0.8)',
          color: '#e8ebf2',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        {layout === 'fixed' ? 'Release into force layout' : 'Back to fixed positions'}
      </button>
    </GraphFrame>
  );
}

const meta = {
  title: 'Layouts/Fixed to force',
  parameters: {
    docs: {
      description: {
        component:
          'Declared positions double as simulation seeds: switch the layout prop ' +
          'from fixed to force and the simulation relaxes FROM the drawn ' +
          'arrangement — no re-seed, no jump. Switch back and the declared design ' +
          'returns. Designed geometry and organic motion are one prop apart.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const FixedToForce: Story = {
  render: (_args, { globals }) => <HandoffDemo globals={globals} />,
};
