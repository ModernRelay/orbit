/**
 * Concrete alias over the generic <Graph<N, E>> so stories get full prop
 * typing without generic-inference friction (Storybook's Meta/StoryObj work
 * against a concrete component type), plus the standard story frame.
 */

import { forwardRef } from 'react';
import type { ReactNode } from 'react';
import { Graph } from '@modernrelay/orbit-react';
import type { GraphHandle, GraphProps } from '@modernrelay/orbit-react';
import type { DemoEdgeAttrs, DemoNodeAttrs } from './generate';

export type DemoGraphProps = GraphProps<DemoNodeAttrs, DemoEdgeAttrs>;
export type DemoGraphHandle = GraphHandle<DemoNodeAttrs, DemoEdgeAttrs>;

export const DemoGraph = forwardRef<DemoGraphHandle, DemoGraphProps>(function DemoGraph(
  props,
  ref,
) {
  return <Graph<DemoNodeAttrs, DemoEdgeAttrs> ref={ref} {...props} />;
});

/** Standard story frame: the graph fills its parent, so stories mount inside
 * a fixed-height surface whose background matches the active theme. */
export function GraphFrame(props: { background: string; children: ReactNode }): ReactNode {
  return (
    <div
      style={{
        height: 520,
        width: '100%',
        position: 'relative',
        background: props.background,
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {props.children}
    </div>
  );
}
