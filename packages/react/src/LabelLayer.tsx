/**
 * LabelLayer — the DOM label lane.
 *
 * Two-channel rendering against the pinned overlay interface:
 * - `labels.subscribeCandidates` fires only when the candidate SET changes →
 * React state → one absolutely-positioned <div> per candidate. Label text
 * is rendered as a TEXT NODE only (never markup), so hostile strings in
 * node attrs appear literally.
 * - `labels.subscribePositions` fires on scheduler ticks with fresh x/y for
 * the SAME set → imperative `style.transform` writes through refs keyed by
 * id. No React re-render per tick (M0: the label lane is pure CPU O(k)).
 *
 * The layer is pointer-inert; label divs opt back in and drive the
 * click-selection path through the same public mutators (replace on plain
 * click and toggle on meta/shift).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactElement, ReactNode } from 'react';
import type { GraphNode, LabelPlacement, NodeId } from '@modernrelay/orbit-core';
import { useAmbientGraphInstance } from './GraphProvider';
import { overlaySurface, overlayLayerStyle } from './components/shared';

export interface LabelLayerProps {
  /** Class hook applied to every label div. */
  labelClassName?: string | undefined;
  /** Escape hatch rendered INSIDE the positioned div instead of the text node. */
  renderNodeLabel?: ((ctx: { node: GraphNode<any>; text: string }) => ReactNode) | undefined;
  /** Class hook applied to CLUSTER label divs (in addition to
   * `labelClassName`), so the coarse layer can be styled apart. */
  clusterLabelClassName?: string | undefined;
  /** Escape hatch for cluster labels; `memberIds` are the ids a click
   * selects. */
  renderClusterLabel?:
    | ((ctx: { clusterKey: string; text: string; memberIds: readonly NodeId[] }) => ReactNode)
    | undefined;
}

/** Placements come from two id namespaces (node ids and cluster keys), so
 * element/position maps and React keys are keyed on `(kind, id)`. */
function placementKey(p: LabelPlacement): string {
  return p.kind === 'cluster' ? `cluster\u0000${p.id}` : `node\u0000${p.id}`;
}

const LAYER_STYLE: CSSProperties = { ...overlayLayerStyle, overflow: 'hidden' };

const LABEL_BASE_STYLE: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  pointerEvents: 'auto',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  userSelect: 'none',
  willChange: 'transform',
};

function transformOf(x: number, y: number): string {
  return `translate3d(${x}px, ${y}px, 0)`;
}

/** Internal to <Graph> (gated by `labels.enabled`); reads the ambient
 * instance so hosts composing GraphProvider directly can reuse it. */
export function LabelLayer(props: LabelLayerProps): ReactElement {
  const instance = useAmbientGraphInstance('LabelLayer');
  const labels = overlaySurface(instance).labels;

  const [candidates, setCandidates] = useState<readonly LabelPlacement[]>([]);
  /** Live label elements, keyed by `(kind, id)` (populated via ref callbacks). */
  const elementsRef = useRef(new Map<string, HTMLDivElement>());
  /** Freshest known screen position per candidate — written by BOTH channels
   * so a candidate re-render never snaps back to a stale x/y. */
  const positionsRef = useRef(new Map<string, readonly [number, number]>());

  // Candidate SET changes: throttled re-rank → React re-render of the content.
  useEffect(() => {
    if (labels === undefined) return undefined;
    return labels.subscribeCandidates((list) => {
      const positions = positionsRef.current;
      const keep = new Set<string>();
      for (const p of list) {
        const key = placementKey(p);
        keep.add(key);
        positions.set(key, [p.x, p.y]);
      }
      for (const key of [...positions.keys()]) {
        if (!keep.has(key)) positions.delete(key);
      }
      // The core REUSES the emitted array/placement objects across ticks
      // copy so React state gets a fresh identity (no Object.is bail-out).
      setCandidates(list.map((p) => ({ ...p })));
    });
  }, [labels]);

  // Scheduler position ticks: imperative transform writes, no re-render.
  useLayoutEffect(() => {
    if (labels === undefined) return undefined;
    return labels.subscribePositions((list) => {
      const elements = elementsRef.current;
      const positions = positionsRef.current;
      for (const p of list) {
        const key = placementKey(p);
        positions.set(key, [p.x, p.y]);
        const el = elements.get(key);
        if (el !== undefined) el.style.transform = transformOf(p.x, p.y);
      }
    });
  }, [labels]);

  // Click-selection semantics through the public mutators:
  // plain click replaces the node selection; meta/shift click toggles the id.
  const onLabelClick = (id: NodeId, e: ReactMouseEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    if (e.metaKey || e.shiftKey) {
      const cur = instance.store.getState().selection.nodeIds;
      instance.setSelection(cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
      return;
    }
    instance.setSelection([id]);
  };

  // a cluster label resolves to its MEMBER node ids through the
  // core mutator — clusters never enter the group selection namespace.
  const onClusterLabelClick = (key: string, e: ReactMouseEvent<HTMLDivElement>): void => {
    e.stopPropagation();
    instance.selectCluster(key, { additive: e.metaKey || e.shiftKey });
  };

  // Right-click routes into the SAME typed 'contextMenu' channel the canvas
  // gesture feeds. Label divs are pointerEvents:'auto' (click-to-focus), so
  // without this the gesture dies here and the browser's native menu opens
  // on exactly the nodes prominent enough to carry labels. Coordinates are
  // container-relative CSS px (the layer fills the container), matching the
  // payload contract the canvas path uses.
  const layerRef = useRef<HTMLDivElement | null>(null);
  const onLabelContextMenu = (id: NodeId, e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    const rect = layerRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    instance.requestNodeContextMenu(id, [e.clientX - rect.left, e.clientY - rect.top]);
  };

  const clusterMembers = (key: string): readonly NodeId[] =>
    instance.getClusters().find((c) => c.key === key)?.memberIds ?? [];

  return (
    <div data-orbit-label-layer="" ref={layerRef} style={LAYER_STYLE}>
      {candidates.map((p) => {
        const key = placementKey(p);
        const [x, y] = positionsRef.current.get(key) ?? [p.x, p.y];
        const isCluster = p.kind === 'cluster';
        const className = isCluster
          ? [props.labelClassName, props.clusterLabelClassName].filter(Boolean).join(' ') ||
            undefined
          : props.labelClassName;
        return (
          <div
            key={key}
            {...(isCluster ? { 'data-orbit-cluster-label': p.id } : { 'data-orbit-label': p.id })}
            className={className}
            style={{ ...LABEL_BASE_STYLE, transform: transformOf(x, y) }}
            ref={(el) => {
              if (el === null) elementsRef.current.delete(key);
              else elementsRef.current.set(key, el);
            }}
            onClick={(e) => (isCluster ? onClusterLabelClick(p.id, e) : onLabelClick(p.id, e))}
            // Cluster labels keep the browser menu for now: their click
            // already selects members, and no cluster menu target exists.
            onContextMenu={isCluster ? undefined : (e) => onLabelContextMenu(p.id, e)}
          >
            {/* text-node-only rendering holds for both kinds: a hostile
                key or label appears literally, never as markup. */}
            {isCluster
              ? props.renderClusterLabel !== undefined
                ? props.renderClusterLabel({
                    clusterKey: p.id,
                    text: p.text,
                    memberIds: clusterMembers(p.id),
                  })
                : p.text
              : props.renderNodeLabel !== undefined
                ? props.renderNodeLabel({
                    node: instance.getNode(p.id) ?? { id: p.id },
                    text: p.text,
                  })
                : p.text}
          </div>
        );
      })}
    </div>
  );
}
