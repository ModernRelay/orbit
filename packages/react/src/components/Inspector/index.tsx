/**
 * `@modernrelay/orbit-react/components/Inspector` — `<GraphInspector>`, the
 * docked detail panel.
 *
 * Subject: the SELECTED-SINGLE node (`store.selection.nodeIds.length === 1`)
 * — the node namespace is the focus proxy the store actually publishes.
 * Anything else (empty or multi selection) renders the empty state.
 *
 * Sections:
 * - **Attrs table** — every attr key/value as TEXT NODES (untrusted
 * content; hostile strings render literally); `renderAttrs` replaces it.
 * - **Neighbor list** — click → `instance.focusNode(neighborId)` (camera
 * fly). v0.9 resolution compromise: the public instance
 * surface resolves a 1-hop neighborhood ONLY through `focusNode`'s return
 * value (the same seam the navigator uses on Enter) — a passive
 * adjacency read is a post-v0.9 core surface. The section therefore
 * populates from a per-model-revision cache learned by focus operations,
 * with a 'Show neighbors' affordance that focuses the subject to resolve
 * its neighborhood on demand (flying to the inspected node is coherent
 * behavior, and it is the user's explicit action). A model change
 * drops the (now stale) cache.
 * - **Quick actions** — wired to the same public mutators as the
 * context menu: Expand (`expandNode`, busy while pending), Isolate
 * (1-hop ego hard scope via the `subgraph` path), Pin/Unpin (store pin
 * slice toggle), Hide (`hideNodes`). `quickActions` is a render-prop
 * REPLACEMENT receiving the defaults, so extension is
 * `[...defaultActions, mine]`.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import type { EdgeId, GraphNode, GraphStoreState, NodeId } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { useResolvedInstance } from '../shared';
import { PassiveInspector } from './passive';

/** An inspection subject is independent of selection and camera position. */
export type GraphInspectionSubject =
  | { kind: 'node'; id: NodeId }
  | { kind: 'edge'; id: EdgeId }
  | { kind: 'selection'; nodeIds: readonly NodeId[] }
  | null;

export interface GraphInspectorAction {
  /** Stable key; default actions use 'expand' | 'isolate' | 'pin' | 'unpin'
   * | 'hide'. */
  id: string;
  /** Rendered as a text node. */
  label: string;
  disabled?: boolean;
  onSelect(): void;
}

export interface GraphInspectorProps {
  /** Explicit instance (multi-instance pages); ambient context otherwise. */
  instance?: AnyGraphInstance;
  /** Omit for the legacy selected-single inspector; null shows an empty
   * panel. Explicit subjects use passive reads and never move the camera. */
  subject?: GraphInspectionSubject;
  onInspect?: (subject: GraphInspectionSubject) => void;
  /** 'panel' participates in its parent's layout; default 'dock'. */
  layout?: 'dock' | 'panel';
  /** Attribute containing relationship type. Default 'type'. */
  typeField?: string;
  /** Docking side. Default 'right'. */
  dock?: 'left' | 'right';
  /** Replaces the default attrs table. */
  renderAttrs?: (node: GraphNode<any>) => ReactNode;
  /** Render-prop REPLACEMENT for the quick-action row; receives the default
   * actions so extension is `[...defaultActions, mine]`. */
  quickActions?: (ctx: {
    node: GraphNode<any>;
    defaultActions: readonly GraphInspectorAction[];
  }) => readonly GraphInspectorAction[];
  /** Accessible name of the panel. Default 'Graph inspector'. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

interface InspectorSlice {
  selection: readonly NodeId[];
  pinned: boolean;
  hidden: boolean;
  expanding: boolean;
  model: number;
}

/** Narrow store subscription: subject id + the flags the panel displays. */
function useInspectorSlice(instance: AnyGraphInstance): InspectorSlice {
  const cacheRef = useRef<InspectorSlice | null>(null);
  const subscribe = useCallback(
    (onChange: () => void) => instance.store.subscribe(onChange),
    [instance],
  );
  const getSnapshot = useCallback((): InspectorSlice => {
    const s: GraphStoreState = instance.store.getState();
    const selection = s.selection.nodeIds;
    const id = selection.length === 1 ? selection[0]! : null;
    const next: InspectorSlice = {
      selection,
      pinned: id !== null && s.pins.has(id),
      hidden: id !== null && s.hiddenNodeIds.has(id),
      expanding: id !== null && s.pendingExpansions.has(id),
      model: s.revisions.model,
    };
    const prev = cacheRef.current;
    if (
      prev !== null &&
      prev.selection === next.selection &&
      prev.pinned === next.pinned &&
      prev.hidden === next.hidden &&
      prev.expanding === next.expanding &&
      prev.model === next.model
    ) {
      return prev;
    }
    cacheRef.current = next;
    return next;
  }, [instance]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Same derivation as the core label default: `attrs.label ?? id`. */
function nodeLabelText(node: GraphNode<any>): string {
  const attrs = node.attrs as Record<string, unknown> | undefined;
  const label = attrs?.['label'];
  return label === undefined || label === null ? String(node.id) : String(label);
}

/** Attr value → display TEXT (never markup): strings verbatim, structured
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

// --- styling defaults (headless-styleable: className/style override) ---
const PANEL_STYLE: CSSProperties = {
  position: 'absolute',
  top: 12,
  bottom: 12,
  width: 280,
  overflowY: 'auto',
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 10,
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.96)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  color: '#e8eaf0',
  font: '13px/1.4 system-ui, sans-serif',
};
const TITLE_STYLE: CSSProperties = {
  fontWeight: 600,
  fontSize: 14,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const SECTION_LABEL_STYLE: CSSProperties = { fontSize: 11, opacity: 0.65, marginTop: 4 };
const TABLE_STYLE: CSSProperties = { borderCollapse: 'collapse', width: '100%' };
const CELL_KEY_STYLE: CSSProperties = {
  textAlign: 'left',
  verticalAlign: 'top',
  padding: '2px 8px 2px 0',
  opacity: 0.65,
  fontWeight: 400,
  whiteSpace: 'nowrap',
};
const CELL_VALUE_STYLE: CSSProperties = { padding: '2px 0', overflowWrap: 'anywhere' };
const BUTTON_STYLE: CSSProperties = {
  appearance: 'none',
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: 'transparent',
  border: 'none',
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  padding: '4px 8px',
};
const ACTIONS_STYLE: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 };
const ACTION_BUTTON_STYLE: CSSProperties = {
  ...BUTTON_STYLE,
  display: 'inline-block',
  width: 'auto',
  border: '1px solid rgba(255, 255, 255, 0.2)',
};
const EMPTY_STYLE: CSSProperties = { fontStyle: 'italic', opacity: 0.8 };

export function GraphInspector(props: GraphInspectorProps): ReactElement {
  return props.subject !== undefined ? <PassiveInspector {...props} /> : <SelectedInspector {...props} />;
}

function SelectedInspector(props: GraphInspectorProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphInspector>');
  const slice = useInspectorSlice(instance);
  const dock = props.dock ?? 'right';

  /** Per-model neighbor cache learned from focus operations (module JSDoc). */
  const neighborsRef = useRef<{ model: number; byId: Map<NodeId, readonly NodeId[]> }>({
    model: -1,
    byId: new Map(),
  });
  /** Bump to re-render after imperative cache learns (focus clicks). */
  const [, setLearnTick] = useState(0);

  // Idempotent render-time cache reset (ref only — safe under StrictMode).
  if (neighborsRef.current.model !== slice.model) {
    neighborsRef.current = { model: slice.model, byId: new Map() };
  }

  const subjectId = slice.selection.length === 1 ? slice.selection[0]! : null;
  const subject =
    subjectId === null ? undefined : (instance.getNode(subjectId) as GraphNode<any> | undefined);

  /** Focus + learn: the single v0.9 neighborhood-resolution seam. */
  const focusAndLearn = (id: NodeId): void => {
    const neighbors = instance.focusNode(id);
    neighborsRef.current.byId.set(id, neighbors);
    setLearnTick((t) => t + 1);
  };

  const panelLabel = props.label ?? 'Graph inspector';
  const dockStyle: CSSProperties = props.layout === 'panel'
    ? { position: 'relative', width: '100%', top: 'auto', bottom: 'auto' }
    : dock === 'left' ? { left: 12 } : { right: 12 };

  if (subjectId === null || subject === undefined) {
    return (
      <div
        data-orbit-inspector=""
        role="complementary"
        aria-label={panelLabel}
        className={props.className}
        style={{ ...PANEL_STYLE, ...dockStyle, ...props.style }}
      >
        <div data-orbit-inspector-empty="" style={EMPTY_STYLE}>
          {slice.selection.length > 1
            ? `${slice.selection.length} nodes selected — select a single node to inspect`
            : 'Select a node to inspect'}
        </div>
      </div>
    );
  }

  const attrs = Object.entries((subject.attrs ?? {}) as Record<string, unknown>);
  const neighbors = neighborsRef.current.byId.get(subjectId);

  const defaultActions: GraphInspectorAction[] = [
    {
      id: 'expand',
      label: slice.expanding ? 'Expanding…' : 'Expand',
      disabled: slice.expanding,
      onSelect: () => {
        // A discard/collapse rejects the promise by design; the panel
        // fires-and-forgets — diagnostics carry the why.
        void instance.expandNode(subjectId).catch(() => {});
      },
    },
    {
      id: 'isolate',
      label: 'Isolate',
      onSelect: () => {
        // 1-hop ego hard scope — the same path as the menu item.
        instance.applyHostUpdate({ subgraph: { seedIds: [subjectId], hops: 1 } });
      },
    },
    slice.pinned
      ? {
          id: 'unpin',
          label: 'Unpin',
          onSelect: () => {
            instance.unpinNode(subjectId);
          },
        }
      : {
          id: 'pin',
          label: 'Pin',
          onSelect: () => {
            instance.pinNode(subjectId);
          },
        },
    {
      id: 'hide',
      label: 'Hide',
      onSelect: () => {
        instance.hideNodes([subjectId]);
      },
    },
  ];
  const actions =
    props.quickActions !== undefined
      ? props.quickActions({ node: subject, defaultActions })
      : defaultActions;

  const stateBadges = [
    ...(slice.pinned ? ['pinned'] : []),
    ...(slice.hidden ? ['hidden'] : []),
  ].join(' · ');

  return (
    <div
      data-orbit-inspector=""
      role="complementary"
      aria-label={panelLabel}
      className={props.className}
      style={{ ...PANEL_STYLE, ...dockStyle, ...props.style }}
    >
      {/* Untrusted node text renders as TEXT NODES only. */}
      <div data-orbit-inspector-title="" style={TITLE_STYLE}>
        {nodeLabelText(subject)}
      </div>
      {stateBadges !== '' ? (
        <div data-orbit-inspector-state="" style={SECTION_LABEL_STYLE}>
          {stateBadges}
        </div>
      ) : null}

      <div data-orbit-inspector-actions="" style={ACTIONS_STYLE}>
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            data-orbit-inspector-action={action.id}
            disabled={action.disabled === true}
            style={ACTION_BUTTON_STYLE}
            onClick={() => {
              if (action.disabled !== true) action.onSelect();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div style={SECTION_LABEL_STYLE}>Attributes</div>
      {props.renderAttrs !== undefined ? (
        props.renderAttrs(subject)
      ) : attrs.length === 0 ? (
        <div data-orbit-inspector-no-attrs="" style={EMPTY_STYLE}>
          No attributes
        </div>
      ) : (
        <table data-orbit-inspector-attrs="" style={TABLE_STYLE}>
          <tbody>
            {attrs.map(([key, value]) => (
              <tr key={key} data-orbit-inspector-attr={key}>
                <th scope="row" style={CELL_KEY_STYLE}>
                  {key}
                </th>
                <td style={CELL_VALUE_STYLE}>{attrValueText(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div style={SECTION_LABEL_STYLE}>Neighbors</div>
      {neighbors === undefined ? (
        <button
          type="button"
          data-orbit-inspector-resolve-neighbors=""
          style={BUTTON_STYLE}
          onClick={() => {
            focusAndLearn(subjectId);
          }}
        >
          Show neighbors (focuses the node)
        </button>
      ) : neighbors.length === 0 ? (
        <div data-orbit-inspector-no-neighbors="" style={EMPTY_STYLE}>
          No neighbors
        </div>
      ) : (
        <ul data-orbit-inspector-neighbors="" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {neighbors.map((id) => {
            const neighbor = instance.getNode(id) as GraphNode<any> | undefined;
            return (
              <li key={id}>
                <button
                  type="button"
                  data-orbit-inspector-neighbor={id}
                  style={BUTTON_STYLE}
                  onClick={() => {
                    focusAndLearn(id);
                  }}
                >
                  {neighbor === undefined ? id : nodeLabelText(neighbor)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
