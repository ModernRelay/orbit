import { useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { NodeId } from '@modernrelay/orbit-core';
import { GraphContextMenu } from '@modernrelay/orbit-react/components/ContextMenu';
import type { GraphHandle } from '@modernrelay/orbit-react';
import { DemoGraph, GraphFrame } from '../fixtures/DemoGraph';
import { cosmosEngine } from '../fixtures/engines';
import type { DemoEdgeAttrs, DemoNodeAttrs } from '../fixtures/generate';
import { CLUSTER_COLOR_SCALE } from '../fixtures/scales';
import { sizedCache } from '../fixtures/sizes';
import { themeFromGlobals } from '../fixtures/themes';
import { clustered } from '../fixtures/topologies';

const data = sizedCache(clustered, 31);

function ContextMenuDemo(props: { globals: Record<string, unknown> }) {
  const ref = useRef<GraphHandle<DemoNodeAttrs, DemoEdgeAttrs> | null>(null);
  const active = themeFromGlobals(props.globals);
  const onFindPath = (sourceId: NodeId, targetId: NodeId): void => {
    void ref.current?.findPath(sourceId, targetId, { direction: 'either' }).catch(() => {});
  };
  return (
    <GraphFrame background={active.background}>
      <DemoGraph
        ref={ref}
        engine={cosmosEngine}
        data={data(props.globals)}
        theme={active.theme}
        linkColor={active.linkColor}
        nodeColor={CLUSTER_COLOR_SCALE}
      >
        <GraphContextMenu onFindPath={onFindPath} />
      </DemoGraph>
    </GraphFrame>
  );
}

const meta = {
  title: 'Interaction/Context menu',
  parameters: {
    docs: {
      description: {
        component:
          'Right-click (or long-press) a node for the typed context menu — select, ' +
          'isolate, expand, hide, and a two-step find-path flow: pick "find path ' +
          'from here" on one node, then a target on another, and the shortest path ' +
          'lights up through the path-emphasis lane.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const ContextMenu: Story = {
  render: (_args, { globals }) => <ContextMenuDemo globals={globals} />,
};
