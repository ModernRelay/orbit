/**
 * <GraphContextMenu> — right-click / long-press menu.
 *
 * Listens to the instance's typed 'contextMenu' event (the ONLY channel — the
 * instance has no openContextMenu method) and renders a portal-free,
 * absolutely-positioned menu at the event's container-relative screen
 * coordinates, so it must be composed inside the <Graph> container (or any
 * positioned ancestor sharing the canvas coordinate space).
 *
 * Fully keyboard reachable: the menu opens focused on its first item,
 * ArrowUp/ArrowDown rove (wrapping), Enter/Space activates, Escape closes and
 * returns focus to the previously focused element; it also closes on outside
 * pointerdown and window blur. All target-derived text (the node label
 * heading) renders as TEXT NODES — never markup.
 *
 * path pair: with `onFindPath` provided, node menus carry
 * 'Find path from here' / 'Find path to here'. The pending 'from' anchor is
 * stashed locally in the component (session-local); completing the pair
 * fires `onFindPath(anchorId, targetId)` and clears the anchor.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import type { GraphNode, GraphStoreState, NodeId, SubgraphSpec } from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { useResolvedInstance } from '../shared';

/** The typed 'contextMenu' event target (generics erased like AnyGraphInstance). */
export type GraphContextMenuTarget =
  | { kind: 'node'; node: GraphNode<any> }
  | { kind: 'background' };

export interface GraphContextMenuItem {
  /** Stable key; default items use 'focus' | 'select-neighbors' | 'expand' |
   * 'isolate' | 'fold' | 'unfold' | 'pin' | 'unpin' | 'hide' | 'copy-id' |
   * 'find-path-from' | 'find-path-to' | 'select-all' | 'clear-selection' |
   * 'fit-view' | 'reset-isolation'. */
  id: string;
  /** Rendered as a text node. */
  label: string;
  disabled?: boolean;
  onSelect(): void;
}

/** Pinned-interface alias. */
export type MenuItem = GraphContextMenuItem;

export interface GraphContextMenuProps {
  /** Explicit instance; defaults to the ambient <Graph>/<GraphProvider> one. */
  instance?: AnyGraphInstance;
  /** Class hook for the menu root; providing it drops the default chrome
   * (positioning is always applied). */
  className?: string;
  style?: CSSProperties;
  /** Class hook for each item; providing it drops the default item styles. */
  itemClassName?: string;
  /** Render-prop REPLACEMENT for the item list; receives the default items
   * so extension is `[...defaultItems, mine]`. */
  renderItems?: (ctx: {
    target: GraphContextMenuTarget;
    defaultItems: readonly GraphContextMenuItem[];
  }) => readonly GraphContextMenuItem[];
  /**
   * path pair: providing this adds 'Find path from here' /
   * 'Find path to here' to node menus. 'From here' stashes the anchor node
   * id locally (component state — session-local, never serialized); 'to
   * here' appears once an anchor exists on a DIFFERENT node, fires
   * `(anchorId, targetId)`, and clears the anchor. The component never
   * resolves paths itself — wire this to the ref API's findPath.
   */
  onFindPath?: (sourceId: NodeId, targetId: NodeId) => void;
}

interface OpenState {
  target: GraphContextMenuTarget;
  /** Container-relative CSS pixels from the context-menu event. */
  screen: readonly [number, number];
}

// --- default dark-theme styling (dropped when class hooks are provided) ---

const MENU_CHROME: CSSProperties = {
  minWidth: 160,
  display: 'flex',
  flexDirection: 'column',
  padding: 4,
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.96)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
  color: '#e8eaf0',
  font: '13px/1.4 system-ui, sans-serif',
  zIndex: 10,
};

const HEADING_STYLE: CSSProperties = {
  padding: '4px 10px',
  fontSize: 11,
  opacity: 0.65,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: 240,
};

const ITEM_STYLE: CSSProperties = {
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
  padding: '6px 10px',
};

/** Same derivation as the core label default: `attrs.label ?? id`. */
function nodeLabelText(node: GraphNode<any>): string {
  const attrs = node.attrs as Record<string, unknown> | undefined;
  const label = attrs?.['label'];
  return label === undefined || label === null ? String(node.id) : String(label);
}

function legacyCopy(text: string): void {
  if (typeof document === 'undefined') return;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* copy unavailable in this environment */
  }
  ta.remove();
}

/** navigator.clipboard.writeText with the execCommand('copy') fallback. */
function copyText(text: string): void {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    void clipboard.writeText(text).catch(() => {
      legacyCopy(text);
    });
    return;
  }
  legacyCopy(text);
}

/** path-pair state threaded into the node items when the host
 * provided `onFindPath` (null otherwise — the items don't render). */
interface PathPairContext {
  onFindPath: (sourceId: NodeId, targetId: NodeId) => void;
  anchorId: NodeId | null;
  setAnchor: (id: NodeId | null) => void;
}

/** Default node-target items. Pin/Unpin toggles on the store's pin slice at
 * open/render time; Expand shows a busy state while the node's expansion is
 * in flight; Isolate hard-scopes to the node's
 * 1-hop ego network; Collapse/Expand folds the node's neighbourhood
 * behind it (containment, distinct from Expand neighbors, which
 * fetches). */
function defaultNodeItems(
  instance: AnyGraphInstance,
  node: GraphNode<any>,
  pendingExpansions: ReadonlySet<NodeId>,
  pathPair: PathPairContext | null,
): GraphContextMenuItem[] {
  const pinned = instance.store.getState().pins.has(node.id);
  const expanding = pendingExpansions.has(node.id);
  const folded = instance.getFold(node.id) !== null;
  const items: GraphContextMenuItem[] = [
    {
      id: 'focus',
      label: 'Focus',
      onSelect: () => {
        instance.focusNode(node.id);
      },
    },
    {
      id: 'select-neighbors',
      label: 'Select neighbors',
      onSelect: () => {
        instance.selectNeighbors(node.id);
      },
    },
    {
      id: 'expand',
      label: expanding ? 'Expanding…' : 'Expand neighbors',
      disabled: expanding,
      onSelect: () => {
        // A discard/collapse rejects the promise by design; the menu
        // fires-and-forgets, so swallow it here — diagnostics carry the why.
        void instance.expandNode(node.id).catch(() => {});
      },
    },
    {
      id: 'isolate',
      label: 'Isolate',
      onSelect: () => {
        instance.applyHostUpdate({ subgraph: { seedIds: [node.id], hops: 1 } });
      },
    },
    folded
      ? {
          id: 'unfold',
          label: 'Expand neighborhood',
          onSelect: () => {
            instance.unfoldNode(node.id);
          },
        }
      : {
          id: 'fold',
          label: 'Collapse neighborhood',
          onSelect: () => {
            instance.foldNode(node.id);
          },
        },
    pinned
      ? {
          id: 'unpin',
          label: 'Unpin',
          onSelect: () => {
            instance.unpinNode(node.id);
          },
        }
      : {
          id: 'pin',
          label: 'Pin',
          onSelect: () => {
            instance.pinNode(node.id);
          },
        },
    {
      id: 'hide',
      label: 'Hide',
      onSelect: () => {
        instance.hideNodes([node.id]);
      },
    },
    {
      id: 'copy-id',
      label: 'Copy id',
      onSelect: () => {
        copyText(String(node.id));
      },
    },
  ];
  if (pathPair !== null) {
    items.push({
      id: 'find-path-from',
      label: 'Find path from here',
      onSelect: () => {
        // Re-selecting on another node re-anchors (last 'from' wins).
        pathPair.setAnchor(node.id);
      },
    });
    if (pathPair.anchorId !== null && pathPair.anchorId !== node.id) {
      const anchorId = pathPair.anchorId;
      items.push({
        id: 'find-path-to',
        label: 'Find path to here',
        onSelect: () => {
          // A completed pair consumes the anchor (one findPath per pair).
          pathPair.setAnchor(null);
          pathPair.onFindPath(anchorId, node.id);
        },
      });
    }
  }
  return items;
}

function defaultBackgroundItems(
  instance: AnyGraphInstance,
  scope: SubgraphSpec | null,
): GraphContextMenuItem[] {
  const items: GraphContextMenuItem[] = [
    {
      id: 'select-all',
      label: 'Select all',
      onSelect: () => {
        instance.selectAll();
      },
    },
    {
      id: 'clear-selection',
      label: 'Clear selection',
      onSelect: () => {
        instance.clearSelection();
      },
    },
    {
      id: 'fit-view',
      label: 'Fit view',
      onSelect: () => {
        instance.fitView();
      },
    },
  ];
  if (scope !== null) {
    items.push({
      id: 'reset-isolation',
      label: 'Reset isolation',
      onSelect: () => {
        instance.resetIsolation();
      },
    });
  }
  return items;
}

const selectScope = (s: GraphStoreState): SubgraphSpec | null => s.scope;
const selectPendingExpansions = (s: GraphStoreState): ReadonlySet<NodeId> => s.pendingExpansions;

/** Store slice subscription local to this component (the ambient hooks in
 * ../../hooks require the provider; here the instance may be an explicit prop). */
function useInstanceStore<T>(instance: AnyGraphInstance, selector: (s: GraphStoreState) => T): T {
  const subscribe = useCallback(
    (onChange: () => void) => instance.store.subscribe(onChange),
    [instance],
  );
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const getSnapshot = useCallback(() => selectorRef.current(instance.store.getState()), [instance]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function GraphContextMenu(props: GraphContextMenuProps): ReactElement | null {
  const instance = useResolvedInstance(props.instance, '<GraphContextMenu>');
  // state the default items reflect live while the menu is open: the
  // expand item's busy flag and the background reset-isolation gate.
  const scope = useInstanceStore(instance, selectScope);
  const pendingExpansions = useInstanceStore(instance, selectPendingExpansions);

  const [open, setOpen] = useState<OpenState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  /** Element focused when the menu opened; Escape/activation restores it. */
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  /** pending 'Find path from here' anchor. A ref, not state: it only
   * changes via item activation, which closes the menu — the next open
   * re-renders and reads it fresh. Session-local, never serialized. */
  const pathAnchorRef = useRef<NodeId | null>(null);

  const close = useCallback((restoreFocus: boolean): void => {
    setOpen(null);
    const el = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restoreFocus && el !== null && el.isConnected) el.focus();
  }, []);

  // The typed 'contextMenu' event is the only open channel.
  useEffect(() => {
    const off = instance.on('contextMenu', (payload) => {
      restoreFocusRef.current =
        typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setOpen({ target: payload.target, screen: payload.screen });
      setActiveIndex(0);
    });
    return off;
  }, [instance]);

  // Outside pointerdown (capture, so it runs before anything swallows it) and
  // window blur both dismiss without stealing focus back.
  useEffect(() => {
    if (open === null) return undefined;
    const onDocPointerDown = (e: Event): void => {
      const root = rootRef.current;
      if (root !== null && e.target instanceof Node && root.contains(e.target)) return;
      close(false);
    };
    const onWindowBlur = (): void => {
      close(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [open, close]);

  // The menu opens focused; roving focus follows activeIndex.
  useEffect(() => {
    if (open === null) return;
    const el = itemRefs.current[activeIndex] ?? itemRefs.current[0] ?? rootRef.current;
    el?.focus();
  }, [open, activeIndex]);

  if (open === null) return null;

  const onFindPath = props.onFindPath;
  const defaultItems =
    open.target.kind === 'node'
      ? defaultNodeItems(
          instance,
          open.target.node,
          pendingExpansions,
          onFindPath !== undefined
            ? {
                onFindPath,
                anchorId: pathAnchorRef.current,
                setAnchor: (id) => {
                  pathAnchorRef.current = id;
                },
              }
            : null,
        )
      : defaultBackgroundItems(instance, scope);
  const items =
    props.renderItems !== undefined
      ? props.renderItems({ target: open.target, defaultItems })
      : defaultItems;
  const heading = open.target.kind === 'node' ? nodeLabelText(open.target.node) : null;

  const activate = (item: GraphContextMenuItem): void => {
    close(true);
    item.onSelect();
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const count = items.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((i) => (count === 0 ? 0 : (i + 1) % count));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((i) => (count === 0 ? 0 : (i - 1 + count) % count));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(0);
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(count === 0 ? 0 : count - 1);
        break;
      case 'Enter':
      case ' ': {
        e.preventDefault();
        const item = items[activeIndex];
        if (item !== undefined && item.disabled !== true) activate(item);
        break;
      }
      case 'Escape':
        e.preventDefault();
        close(true);
        break;
      case 'Tab':
        e.preventDefault(); // focus stays inside the menu while open
        break;
      default:
        break;
    }
  };

  const positionStyle: CSSProperties = {
    position: 'absolute',
    left: open.screen[0],
    top: open.screen[1],
  };

  return (
    <div
      ref={rootRef}
      data-orbit-context-menu=""
      role="menu"
      aria-label={heading ?? 'Graph'}
      tabIndex={-1}
      className={props.className}
      style={
        props.className !== undefined
          ? { ...positionStyle, ...props.style }
          : { ...MENU_CHROME, ...positionStyle, ...props.style }
      }
      onKeyDown={onKeyDown}
    >
      {heading !== null ? (
        // Target-derived text renders as a TEXT NODE.
        <div data-orbit-context-menu-heading="" role="presentation" style={HEADING_STYLE}>
          {heading}
        </div>
      ) : null}
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(el) => {
            itemRefs.current[index] = el;
          }}
          type="button"
          role="menuitem"
          data-orbit-context-menu-item={item.id}
          tabIndex={index === activeIndex ? 0 : -1}
          disabled={item.disabled === true}
          className={props.itemClassName}
          style={props.itemClassName !== undefined ? undefined : ITEM_STYLE}
          onClick={() => {
            if (item.disabled !== true) activate(item);
          }}
          onPointerEnter={() => {
            setActiveIndex(index);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
