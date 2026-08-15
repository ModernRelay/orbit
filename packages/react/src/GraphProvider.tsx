/**
 * GraphProvider — context plumbing for the React binding.
 *
 * `<Graph>` renders this internally around its children; advanced hosts can
 * use it directly to compose against an externally created GraphInstance.
 */

import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { GraphInstance } from '@modernrelay/orbit-core';

// GraphInstance is invariant in its attribute generics (applyHostUpdate is
// contravariant, getNode covariant), so the context stores an `any`-erased
// instance; typed surfaces (hooks, GraphHandle) re-narrow at the edges.
export type AnyGraphInstance = GraphInstance<any, any>;

export const GraphInstanceContext = createContext<AnyGraphInstance | null>(null);

/**
 * Internal: resolve the ambient instance or throw a descriptive error naming
 * the calling hook. Must be called unconditionally (it is itself a hook).
 */
export function useAmbientGraphInstance(hookName: string): AnyGraphInstance {
  const instance = useContext(GraphInstanceContext);
  if (instance === null) {
    throw new Error(
      `orbit-react: ${hookName}() must be used within a <Graph> or <GraphProvider> subtree`,
    );
  }
  return instance;
}

export interface GraphProviderProps {
  instance: AnyGraphInstance;
  children?: ReactNode;
}

export function GraphProvider(props: GraphProviderProps): ReactElement {
  return (
    <GraphInstanceContext.Provider value={props.instance}>
      {props.children}
    </GraphInstanceContext.Provider>
  );
}
