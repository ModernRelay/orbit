/**
 * Shared component foundation: instance resolution + tiny styling
 * primitives every packaged component (`Toolbar`, `ContextMenu`,
 * `SelectionActions`, `Navigator`) and the built-in overlays use.
 */

import { useContext } from 'react';
import type { CSSProperties } from 'react';
import type { LabelPlacement } from '@modernrelay/orbit-core';
import { GraphInstanceContext } from '../GraphProvider';
import type { AnyGraphInstance } from '../GraphProvider';

/**
 * Resolve the GraphInstance a component operates on: an explicit `instance`
 * prop wins, else the ambient <Graph>/<GraphProvider> context. Throws a
 * descriptive error naming the component when neither exists.
 *
 * Must be called unconditionally (it is itself a hook).
 */
export function useResolvedInstance(
  explicit?: AnyGraphInstance,
  componentName = 'This component',
): AnyGraphInstance {
  const ambient = useContext(GraphInstanceContext);
  const resolved = explicit ?? ambient;
  if (resolved === null || resolved === undefined) {
    throw new Error(
      `orbit-react: ${componentName} requires a GraphInstance — render it inside a ` +
        '<Graph> or <GraphProvider> subtree, or pass an explicit `instance` prop.',
    );
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Placement. Floating components are positioned by a
// PROP, not by CSS the host has to reverse-engineer.
// ---------------------------------------------------------------------------

/** Corner a floating component anchors to inside the graph container. */
export type GraphCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Default distance from the two anchored edges, in CSS px. */
export const DEFAULT_CORNER_OFFSET = 12;

/**
 * Absolute-position style for one corner. Only the TWO insets that corner
 * needs are emitted — never all four — so a caller-supplied inset in `style`
 * has nothing to fight with.
 */
export function cornerStyle(
  corner: GraphCorner,
  offset: number = DEFAULT_CORNER_OFFSET,
): CSSProperties {
  const [vertical, horizontal] = corner.split('-') as ['top' | 'bottom', 'left' | 'right'];
  return { position: 'absolute', [vertical]: offset, [horizontal]: offset };
}

const OPPOSITE_INSET = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
} as const;

/**
 * Merge a component's default style UNDER a caller override, resolving inset
 * conflicts per AXIS: an inset the caller supplies drops the default's
 * opposite.
 *
 * Plain spreading layers them instead, which is a silent partial application
 * `{ right: 8 }` over a default `left: 12` leaves BOTH live, `left` wins in
 * LTR, and the caller's value sits in the DOM doing nothing. Per-axis (rather
 * than dropping every inset) keeps the perpendicular anchor, so a lone
 * `{ top: 20 }` nudges vertically instead of jumping to the container edge.
 */
export function mergeStyle(base: CSSProperties, override?: CSSProperties): CSSProperties {
  if (override === undefined) return base;
  const out: CSSProperties = { ...base };
  for (const inset of ['top', 'bottom', 'left', 'right'] as const) {
    if (override[inset] !== undefined) delete out[OPPOSITE_INSET[inset]];
  }
  return { ...out, ...override };
}

// ---------------------------------------------------------------------------
// Pinned core↔react overlay interface. These members live on
// GraphInstance; until the core type surface catches up, components reach
// them through this structural view with optional access, which stays exactly
// signature-compatible once the members are required on GraphInstance.
// ---------------------------------------------------------------------------

/** `instance.labels` — the DOM label lane subscription surface. */
export interface GraphLabelsSurface {
  /** Fires ONLY when the candidate SET changes (throttled re-rank; React
   * re-renders label content). Replays current state on subscribe. */
  subscribeCandidates(cb: (list: readonly LabelPlacement[]) => void): () => void;
  /** Fires on scheduler ticks with fresh x/y for the SAME set (imperative
   * transform writes — never a React re-render). Replays on subscribe. */
  subscribePositions(cb: (list: readonly LabelPlacement[]) => void): () => void;
}

/** Instance members components rely on beyond the v0.3 GraphInstance type. */
export interface GraphOverlaySurface {
  labels?: GraphLabelsSurface;
  /** Binding-detected reduced-motion media preference. */
  setReducedMotion?(v: boolean | undefined): void;
  pauseSimulation?(): void;
  resumeSimulation?(): void;
  isSimulationRunning?(): boolean;
  /** Delegates to the engine; resolves null when unsupported/not ready. */
  captureScreenshot?(): Promise<Blob | null>;
}

/** Structural view of the overlay surface on a GraphInstance. */
export function overlaySurface(instance: AnyGraphInstance): GraphOverlaySurface {
  return instance as unknown as GraphOverlaySurface;
}

// ---------------------------------------------------------------------------
// Styling primitives
// ---------------------------------------------------------------------------

/** Screen-reader-only content (the classic visually-hidden clip pattern). */
export const visuallyHiddenStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** A full-bleed overlay layer above the canvas that never eats pointevents
 * unless a child opts back in with `pointerEvents: 'auto'`. */
export const overlayLayerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  pointerEvents: 'none',
};
