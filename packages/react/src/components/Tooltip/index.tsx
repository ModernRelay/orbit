/**
 * `@modernrelay/orbit-react/components/Tooltip` — `<GraphTooltip>`, the
 * hover card.
 *
 * Visibility rides the store hover slice: a
 * non-null hover arms a `delayMs` timer (default 150); the card mounts when
 * it fires and unmounts IMMEDIATELY when hover clears — no flicker-out delay.
 *
 * BOTH hover namespaces are served: `hover.nodeId` and `hover.edgeId`. A node
 * WINS when both are set — it is the more specific target and sits on top of
 * its own links. Edges have no entry in the overlay position lane (that lane
 * tracks labeled NODE slots), so an edge card always rides the cursor
 * fallback, which is exactly right: the hovered edge is under the pointer.
 *
 * Positioning is imperative (transform writes on a ref — never a React
 * re-render per movement), fed by two lanes:
 * 1. the overlay position lane (`instance.labels.subscribePositions`,
 * the same public seam <LabelLayer> renders from): when the hovered id is
 * in the tracked candidate set, each scheduler tick writes its fresh
 * container-relative screen x/y, so the card follows the node through
 * simulation drift and camera moves;
 * 2. the pointer fallback: when the hovered id is NOT label-tracked (the
 * common case — labels cover k ranked nodes), a window `pointermove`
 * listener (attached only while hovering) pins the card to the cursor
 * + a fixed offset. The engine's `spaceToScreen` is not reachable through
 * the public instance surface in v0.9, so cursor-anchoring is the
 * documented fallback — the hovered node is by definition under the
 * cursor.
 *
 * Default content: the target's label (`attrs.label` string, else id) plus up
 * to {@link TOOLTIP_ATTR_ROWS} attr rows (label excluded — it is the title),
 * every key/value rendered as TEXT NODES only (untrusted-content rule;
 * hostile attr strings appear literally). `render` / `renderEdge` replace the
 * card content entirely, and `getEdgeText` retitles an edge card without
 * taking over its body — useful where the meaningful name lives in an
 * adapter-injected attr rather than `label` (an Omnigraph edge's relationship
 * type is at `attrs['orbit:type']`, for instance). The card is pointer-inert
 * (it must never steal canvas hover).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { AcceptedEdge, GraphNode, NodeId } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { overlaySurface, useResolvedInstance } from '../shared';

const DELAY_MS_DEFAULT = 150;
/** Max attr rows in the default card content. */
export const TOOLTIP_ATTR_ROWS = 6;
/** Cursor-anchored offset (px) so the card never sits under the pointer. */
const POINTER_OFFSET_PX = 12;

export interface GraphTooltipProps {
  /** Explicit instance (multi-instance pages); ambient context otherwise. */
  instance?: AnyGraphInstance;
  /** Replaces the default card content for a NODE (label + attr rows). */
  render?: (node: GraphNode<any>) => ReactNode;
  /** Replaces the default card content for an EDGE. */
  renderEdge?: (edge: AcceptedEdge<any>) => ReactNode;
  /** Title text for an edge card. Default `attrs.label ?? id`. */
  getEdgeText?: (edge: AcceptedEdge<any>) => string;
  /** Set false to ignore edge hovers entirely (nodes only). Default true. */
  edges?: boolean;
  /** Hover → show delay in ms. Default 150. */
  delayMs?: number;
  className?: string;
  style?: CSSProperties;
}

const LAYER_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
};

const CARD_STYLE: CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  maxWidth: 280,
  padding: '6px 10px',
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.96)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  color: '#e8eaf0',
  font: '12px/1.5 system-ui, sans-serif',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
  willChange: 'transform',
};

const TITLE_STYLE: CSSProperties = {
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const ROW_STYLE: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  overflow: 'hidden',
};

const ROW_KEY_STYLE: CSSProperties = { opacity: 0.65 };
const ROW_VALUE_STYLE: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis' };

/** Same derivation as the core label default: `attrs.label ?? id`. */
function nodeLabelText(node: GraphNode<any>): string {
  const attrs = node.attrs as Record<string, unknown> | undefined;
  const label = attrs?.['label'];
  return label === undefined || label === null ? String(node.id) : String(label);
}

/** Attr value → display TEXT (never markup): primitives verbatim, structured
 * values JSON (guarded — cycles degrade to the String form). */
function attrValueText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** The hovered target, node-first. Encoded as a STRING (`'node\u0000id'`)
 * rather than an object so `useSyncExternalStore` compares by value — a fresh
 * object every publication would loop. */
type HoverKey = string;

function encodeHover(kind: 'node' | 'edge', id: string): HoverKey {
  return `${kind}\u0000${id}`;
}

function decodeHover(key: HoverKey): { kind: 'node' | 'edge'; id: string } {
  const at = key.indexOf('\u0000');
  return { kind: key.slice(0, at) as 'node' | 'edge', id: key.slice(at + 1) };
}

function useHoveredTarget(instance: AnyGraphInstance, edges: boolean): HoverKey | null {
  const subscribe = useCallback(
    (onChange: () => void) => instance.store.subscribe(onChange),
    [instance],
  );
  const getSnapshot = useCallback((): HoverKey | null => {
    const hover = instance.store.getState().hover;
    // Node wins: it is the more specific target and sits above its links.
    if (hover.nodeId !== null) return encodeHover('node', hover.nodeId);
    if (edges && hover.edgeId !== null) return encodeHover('edge', hover.edgeId);
    return null;
  }, [instance, edges]);
  // The same hovered ID can receive new attrs in a newer snapshot. Refresh
  // content on that publication without changing the hover key, so neither
  // an already visible card nor its pending delay restarts.
  const getModelRevision = useCallback(() => instance.store.getState().revisions.model, [instance]);
  useSyncExternalStore(subscribe, getModelRevision, getModelRevision);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Same derivation as the node default: `attrs.label ?? id`. */
function edgeLabelText(edge: AcceptedEdge<any>): string {
  const attrs = edge.attrs as Record<string, unknown> | undefined;
  const label = attrs?.['label'];
  return label === undefined || label === null ? String(edge.id) : String(label);
}

export function GraphTooltip(props: GraphTooltipProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphTooltip>');
  const labels = overlaySurface(instance).labels;
  const delayMs = props.delayMs ?? DELAY_MS_DEFAULT;

  const edgesEnabled = props.edges ?? true;
  const hoverKey = useHoveredTarget(instance, edgesEnabled);
  /** The target the mounted card shows — hoverKey promoted after delayMs. */
  const [visibleKey, setVisibleKey] = useState<HoverKey | null>(null);

  const layerRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** Freshest label-lane screen position per tracked id (container-relative). */
  const trackedRef = useRef(new Map<NodeId, readonly [number, number]>());
  /** Freshest cursor position (container-relative, offset applied). */
  const pointerRef = useRef<readonly [number, number] | null>(null);

  /** One place decides the transform: label lane wins when it tracks the id. */
  const position = useCallback(
    (id: NodeId): void => {
      const el = cardRef.current;
      if (el === null) return;
      const at = trackedRef.current.get(id) ?? pointerRef.current;
      if (at === null || at === undefined) return;
      el.style.transform = `translate3d(${at[0]}px, ${at[1]}px, 0)`;
    },
    [],
  );

  // Delay lane: arm on hover, cancel/hide immediately on unhover OR target
  // replacement. Keeping the previous card mounted while a new target's
  // timer runs presents stale content for an item that is no longer hovered.
  useEffect(() => {
    if (hoverKey === null) {
      setVisibleKey(null);
      return undefined;
    }
    setVisibleKey((current) => (current === hoverKey ? current : null));
    const timer = setTimeout(() => {
      setVisibleKey(hoverKey);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [hoverKey, delayMs]);

  // Position lane 1: the overlay position lane (same seam as LabelLayer).
  useLayoutEffect(() => {
    if (labels === undefined) return undefined;
    return labels.subscribePositions((list) => {
      const tracked = trackedRef.current;
      tracked.clear();
      for (const p of list) tracked.set(p.id, [p.x, p.y]);
      const id = instance.store.getState().hover.nodeId;
      if (id !== null && tracked.has(id)) position(id);
    });
  }, [labels, instance, position]);

  // Position lane 2: cursor fallback. The listener lives for the component's
  // lifetime (storing two numbers per move) so a hover that lands WITHOUT a
  // subsequent move still knows where the cursor already is; it only writes
  // the card transform while a node is hovered and the id is untracked.
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      // Container-relative like the label lane: subtract the positioned
      // ancestor's origin (zero-rect hosts — jsdom — degrade to client px).
      const host = layerRef.current?.offsetParent;
      const origin = host instanceof Element ? host.getBoundingClientRect() : null;
      pointerRef.current = [
        e.clientX - (origin?.left ?? 0) + POINTER_OFFSET_PX,
        e.clientY - (origin?.top ?? 0) + POINTER_OFFSET_PX,
      ];
      const hover = instance.store.getState().hover;
      if (hover.nodeId !== null) {
        if (!trackedRef.current.has(hover.nodeId)) position(hover.nodeId);
      } else if (hover.edgeId !== null) {
        // Edges never appear in the label lane — always cursor-anchored.
        position(hover.edgeId);
      }
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
    };
  }, [instance, position]);

  // Place the card the moment it mounts (before paint — no corner flash).
  useLayoutEffect(() => {
    if (visibleKey !== null) position(decodeHover(visibleKey).id);
  }, [visibleKey, position]);

  // Render-gate synchronously as well as clearing state in the effect: on the
  // first commit for a replacement hover, effects have not run yet and
  // `visibleKey` still names the previous target.
  const target = visibleKey === null || visibleKey !== hoverKey ? null : decodeHover(visibleKey);
  const node =
    target?.kind === 'node'
      ? (instance.getNode(target.id) as GraphNode<any> | undefined)
      : undefined;
  const edge =
    target?.kind === 'edge'
      ? (instance.getEdge(target.id) as AcceptedEdge<any> | undefined)
      : undefined;
  const item = node ?? edge;
  const isEdge = edge !== undefined;

  /** Title + custom body, shared by both kinds — only the text derivation and
   * the `data-orbit-tooltip-edge` marker differ. Computed ONLY when a target
   * actually resolved: `visibleKey` can name an id the model no longer holds
   * (a hover surviving a dataset swap), and `target` is null whenever nothing
   * is hovered at all. */
  const title =
    item === undefined
      ? ''
      : isEdge
        ? (props.getEdgeText ?? edgeLabelText)(edge)
        : nodeLabelText(node as GraphNode<any>);
  const custom =
    item === undefined
      ? undefined
      : isEdge
        ? props.renderEdge?.(edge)
        : props.render?.(node as GraphNode<any>);

  return (
    <div ref={layerRef} data-orbit-tooltip-layer="" style={LAYER_STYLE}>
      {item !== undefined ? (
        <div
          ref={cardRef}
          data-orbit-tooltip=""
          {...(isEdge ? { 'data-orbit-tooltip-edge': '' } : {})}
          role="tooltip"
          className={props.className}
          style={{ ...CARD_STYLE, ...props.style }}
        >
          {custom !== undefined ? (
            custom
          ) : (
            <>
              {/* Untrusted text renders as TEXT NODES only. */}
              <div data-orbit-tooltip-label="" style={TITLE_STYLE}>
                {title}
              </div>
              {Object.entries((item.attrs ?? {}) as Record<string, unknown>)
                .filter(([key]) => key !== 'label')
                .slice(0, TOOLTIP_ATTR_ROWS)
                .map(([key, value]) => (
                  <div key={key} data-orbit-tooltip-attr={key} style={ROW_STYLE}>
                    <span style={ROW_KEY_STYLE}>{key}</span>
                    <span style={ROW_VALUE_STYLE}>{attrValueText(value)}</span>
                  </div>
                ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
