/**
 * `@modernrelay/orbit-react/components/Navigator` — `<GraphNavigator>`, the
 * bounded semantic navigator.
 *
 * The navigator is the keyboard/screen-reader equivalent surface for the
 * canvas: a visually compact panel with `role="listbox"` semantics driven by
 * a roving tabindex — exactly one item is tabbable at any time, and
 * `aria-activedescendant` on the listbox container mirrors the active item's
 * stable DOM id. It is bounded by design: every list is paged by
 * `accessibility.navigatorWindow` (default 50), so the DOM never grows one
 * row per entity.
 *
 * Sections:
 * - **Search results** — the last completed search
 * (`store.search`), shown whenever the slice is non-null (it clears on
 * `clearSearch` / dataset swap). Paged like every other list; Enter
 * routes through `instance.activateSearchResult` (result contract:
 * an in-scene, mask-visible id focuses; anything else is classification
 * only — the navigator never mutates scope/filters). Row text prefers the
 * service-supplied `label`.
 * - **Focused node** — the transiently focused root plus its paged 1-hop
 * neighborhood.
 * - **Selection** — the current node selection, paged.
 * - **All nodes** — the entry list (first `navigatorWindow` nodes in
 * accepted-base order, paged over the full set), shown when nothing is
 * focused.
 *
 * ## Keyboard model — `keyboardMode: 'topology'` (the v0.4 default and only mode)
 *
 * | Key | Action |
 * |---------------------|-------------------------------------------------------------------|
 * | ArrowDown / ArrowUp | move the active item within the current list |
 * | Home / End | move to the bounds of the current list |
 * | PageDown / PageUp | next / previous page of the active item's list |
 * | Enter | focus the node (`instance.focusNode` — camera fly) and re-root the neighborhood at it |
 * | Space | toggle the node's selection membership |
 * | Escape | clear the transient focus (returns to the entry list) |
 *
 * `keyboardMode: 'spatial'` (arrows move by screen direction) is a
 * documented post-v0.4 mode and intentionally NOT part of the accepted prop
 * union yet — only `'topology'` type-checks in v0.4.
 *
 * Text names resolve via `accessibility.getAccessibleLabel`, falling back to
 * `attrs.label` (when a string) and then the node id — always rendered as
 * TEXT NODES.
 * Each item exposes selection state (`aria-selected`), its neighbor count
 * when known, and pinned/hidden state in text (e.g. `hub · 5 neighbors ·
 * pinned`).
 *
 * Neighborhood semantics (v0.4): direction is UNDIRECTED — `focusNode`
 * resolves the 1-hop neighbor ids through the engine's adjacency when the
 * adapter provides one, else through the core CSR adjacency
 * (`buildAdjacency`/`neighborsOf`) built lazily per accepted model revision
 * and invalidated on model change; self-loops are excluded and parallel
 * edges deduplicate. The navigator caches the resolved neighborhood and the
 * per-node neighbor counts it has learned in refs keyed by
 * `revisions.model` and `revisions.scope`; a scene change drops the stale
 * transient root and returns to the entry list. Neighbor counts therefore appear on items whose
 * neighborhood has been resolved (the current and previously visited roots);
 * a public O(1) degree read is a post-v0.4 core surface.
 *
 * Focus never lives only in WebGL pixels: the active item carries a
 * visible DOM focus outline and receives real DOM focus on keyboard moves.
 * Sync is navigator → graph (Enter → `focusNode` camera fly); graph →
 * navigator focus sync is deferred past v0.4. Space routes through
 * `instance.selectNodes`, so a controlled selection surfaces intent only
 * — `aria-selected` always reflects the store.
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, KeyboardEvent, ReactElement } from 'react';
import type {
  AccessibilityConfig,
  GraphNode,
  NodeId,
  SearchResult,
  SelectionState,
} from '@modernrelay/orbit-core';
import { getSearchResultUnavailableCallback } from '../../hooks';
import { useResolvedInstance } from '../shared';
import type { AnyGraphInstance } from '../../GraphProvider';

/** default page size when `accessibility.navigatorWindow` is unset. */
const DEFAULT_NAVIGATOR_WINDOW = 50;

export interface GraphNavigatorProps {
  /** Explicit instance (multi-instance pages); ambient context otherwise. */
  instance?: AnyGraphInstance;
  /**
   * Keyboard model. v0.4 ships `'topology'` (the default; documented above);
   * `'spatial'` (arrows-by-screen-direction) is post-v0.4 and not accepted
   * by this union yet.
   */
  keyboardMode?: 'topology';
  /** Accessible name of the navigator panel. Default 'Graph navigator'. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/** Which paged id list a row belongs to (drives PageUp/PageDown targeting). */
type PagedListKey = 'search' | 'neighbors' | 'selection' | 'entry';

interface NavRow {
  /** Stable identity across renders: `${list}:${nodeId}` (`root:` for the root row). */
  key: string;
  /** Stable DOM id (aria-activedescendant target). */
  domId: string;
  nodeId: NodeId;
  listKey: PagedListKey;
  text: string;
  selected: boolean;
}

interface NavSection {
  key: 'search' | 'focused' | 'selection' | 'entry';
  listKey: PagedListKey;
  label: string;
  /** Group accessible name; carries the 'page x of y' state. */
  groupLabel: string;
  rows: NavRow[];
  page: number;
  pageCount: number;
  /** Total pageable items (excludes the focused section's root chrome row). */
  total: number;
}

/** Transient navigator focus: the neighborhood root. */
interface NavRoot {
  id: NodeId;
  neighbors: readonly NodeId[];
  /** Model and scope revisions the neighborhood was resolved against. */
  model: number;
  scope: number;
}

interface NavStoreSlice {
  selection: SelectionState;
  pins: ReadonlyMap<NodeId, readonly [number, number]>;
  hidden: ReadonlySet<NodeId>;
  model: number;
  scope: number;
  nodeCount: number;
  /** Last completed search; null hides the section. */
  search: { query: string; results: readonly SearchResult[] } | null;
}

/** Narrow store subscription: re-renders only when a navigator-relevant slice
 * changes (never on per-frame viewport writes). */
function useNavStoreSlice(instance: AnyGraphInstance): NavStoreSlice {
  const cacheRef = useRef<NavStoreSlice | null>(null);
  const subscribe = useCallback(
    (cb: () => void) => instance.store.subscribe(cb),
    [instance],
  );
  const getSnapshot = useCallback((): NavStoreSlice => {
    const s = instance.store.getState();
    const prev = cacheRef.current;
    if (
      prev !== null &&
      prev.selection === s.selection &&
      prev.pins === s.pins &&
      prev.hidden === s.hiddenNodeIds &&
      prev.model === s.revisions.model &&
      prev.scope === s.revisions.scope &&
      prev.nodeCount === s.nodeCount &&
      prev.search === s.search
    ) {
      return prev;
    }
    const next: NavStoreSlice = {
      selection: s.selection,
      pins: s.pins,
      hidden: s.hiddenNodeIds,
      model: s.revisions.model,
      scope: s.revisions.scope,
      nodeCount: s.nodeCount,
      search: s.search,
    };
    cacheRef.current = next;
    return next;
  }, [instance]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

interface PageWindow {
  page: number;
  pageCount: number;
  items: readonly NodeId[];
}

/** Clamp a raw page into `[0, pageCount)` and slice that page's ids. */
function pageWindow(all: readonly NodeId[], rawPage: number, size: number): PageWindow {
  const pageCount = Math.max(1, Math.ceil(all.length / size));
  const page = Math.min(Math.max(rawPage, 0), pageCount - 1);
  return { page, pageCount, items: all.slice(page * size, page * size + size) };
}

// --- styling defaults (headless-styleable: className/style override) ---
const PANEL_STYLE: CSSProperties = {
  pointerEvents: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  maxWidth: 320,
  fontSize: 12,
};
const LIST_STYLE: CSSProperties = { overflowY: 'auto', maxHeight: 320 };
const HEADER_STYLE: CSSProperties = { fontWeight: 600, padding: '4px 6px' };
const ITEM_STYLE: CSSProperties = {
  padding: '2px 6px',
  cursor: 'default',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};
/** visible DOM focus ring on the active item. */
const ACTIVE_ITEM_STYLE: CSSProperties = {
  ...ITEM_STYLE,
  outline: '2px solid currentColor',
  outlineOffset: -2,
};
const PAGING_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const EMPTY_STYLE: CSSProperties = { padding: '4px 6px', fontStyle: 'italic' };

export function GraphNavigator(props: GraphNavigatorProps): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphNavigator>');
  const slice = useNavStoreSlice(instance);

  // 'topology' is the only v0.4 mode; the prop exists so the shape is stable
  // when 'spatial' lands post-v0.4 (no behavioral switch yet).
  void props.keyboardMode;

  const baseId = useId();
  const [storedRoot, setRoot] = useState<NavRoot | null>(null);
  const root =
    storedRoot?.model === slice.model && storedRoot.scope === slice.scope ? storedRoot : null;
  const [pages, setPages] = useState<Record<PagedListKey, number>>({
    search: 0,
    neighbors: 0,
    selection: 0,
    entry: 0,
  });
  /** Active row identity (roving target); null → first row. */
  const [activeKey, setActiveKey] = useState<string | null>(null);

  /** Stable per-node DOM-id tokens (node ids may contain arbitrary text). */
  const tokensRef = useRef<Map<NodeId, number>>(new Map());
  /** Neighborhoods depend on both the accepted model and scene rewrites. */
  const degreesRef = useRef<{ model: number; scope: number; counts: Map<NodeId, number> }>({
    model: -1,
    scope: -1,
    counts: new Map(),
  });
  const itemsRef = useRef<Map<string, HTMLElement>>(new Map());
  /** Set by keyboard handlers so the focus effect moves DOM focus once. */
  const pendingFocusRef = useRef(false);

  // Drop the transient root after a scope/fold/group or model change. The
  // render gate above already prevents one frame of stale neighborhood rows.
  useEffect(() => {
    if (storedRoot !== null && root === null) setRoot(null);
  }, [storedRoot, root]);

  // release the keyboard ring — but ONLY when no pointer hover owns the
  // shared channel (blur while the pointer rests on a canvas node must not
  // erase that node's hover ring; hover already superseded the sticky
  // keyboard target inside core, so there is nothing else to clear).
  const releaseEmphasis = useCallback((): void => {
    if (instance.store.getState().hover.nodeId === null) instance.emphasizeNode(null);
  }, [instance]);

  // A ring left by keyboard navigation must not outlive the navigator.
  useEffect(() => () => releaseEmphasis(), [releaseEmphasis]);

  // Idempotent render-time cache reset (ref only — safe under StrictMode).
  if (degreesRef.current.model !== slice.model || degreesRef.current.scope !== slice.scope) {
    degreesRef.current = { model: slice.model, scope: slice.scope, counts: new Map() };
  }

  const accessibility = instance.getAccessibility() as
    | AccessibilityConfig<Record<string, unknown>>
    | undefined;
  const rawWindow = accessibility?.navigatorWindow;
  const windowSize =
    typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow >= 1
      ? Math.floor(rawWindow)
      : DEFAULT_NAVIGATOR_WINDOW;

  const getAccessibleLabel = accessibility?.getAccessibleLabel;
  const nameOf = (id: NodeId): string => {
    const node = instance.getNode(id) as GraphNode<Record<string, unknown>> | undefined;
    if (node === undefined) return id;
    if (getAccessibleLabel !== undefined) {
      try {
        return getAccessibleLabel(node);
      } catch {
        // fall through to the built-in resolution
      }
    }
    const label = node.attrs?.['label'];
    return typeof label === 'string' ? label : node.id;
  };

  const selectedSet = new Set<NodeId>(slice.selection.nodeIds);

  /** '{name} · {n} neighbors · pinned · hidden' — always a single text node. */
  const rowText = (id: NodeId): string => {
    const parts = [nameOf(id)];
    const count = degreesRef.current.counts.get(id);
    if (count !== undefined) parts.push(count === 1 ? '1 neighbor' : `${count} neighbors`);
    if (slice.pins.has(id)) parts.push('pinned');
    if (slice.hidden.has(id)) parts.push('hidden');
    return parts.join(' · ');
  };

  const domIdFor = (listKey: string, id: NodeId): string => {
    const tokens = tokensRef.current;
    let token = tokens.get(id);
    if (token === undefined) {
      token = tokens.size;
      tokens.set(id, token);
    }
    return `${baseId}nav-${listKey}-${token}`;
  };

  const makeRow = (listKey: PagedListKey, id: NodeId): NavRow => ({
    key: `${listKey}:${id}`,
    domId: domIdFor(listKey, id),
    nodeId: id,
    listKey,
    text: rowText(id),
    selected: selectedSet.has(id),
  });

  // --- section/row model (all O(navigatorWindow) work) ---
  const searchResults: readonly SearchResult[] = slice.search === null ? [] : slice.search.results;
  const listItems: Record<PagedListKey, readonly NodeId[]> = {
    search: searchResults.map((r) => r.id),
    neighbors: root !== null ? root.neighbors : [],
    selection: slice.selection.nodeIds,
    // the entry list is the SCENE roster (scope applied, mask not)
    // hidden/filtered nodes stay listed with their state exposed in text.
    entry: root === null ? instance.getSceneNodeIds() : [],
  };

  const sections: NavSection[] = [];
  if (slice.search !== null) {
    const view = pageWindow(listItems.search, pages.search, windowSize);
    const count = searchResults.length;
    const start = view.page * windowSize;
    sections.push({
      key: 'search',
      listKey: 'search',
      label: 'Search results',
      groupLabel: `Search results for ${slice.search.query}: ${count} ${
        count === 1 ? 'result' : 'results'
      }, page ${view.page + 1} of ${view.pageCount}`,
      // row text prefers the service-supplied label (still a TEXT
      // NODE); results may name ids outside the model — nameOf falls back to
      // the id for those.
      rows: view.items.map((id, i) => {
        const row = makeRow('search', id);
        const label = searchResults[start + i]?.label;
        return label === undefined ? row : { ...row, text: label };
      }),
      page: view.page,
      pageCount: view.pageCount,
      total: count,
    });
  }
  if (root !== null) {
    const view = pageWindow(listItems.neighbors, pages.neighbors, windowSize);
    const rootRow: NavRow = {
      key: `root:${root.id}`,
      domId: domIdFor('root', root.id),
      nodeId: root.id,
      listKey: 'neighbors',
      text: rowText(root.id),
      selected: selectedSet.has(root.id),
    };
    const count = root.neighbors.length;
    sections.push({
      key: 'focused',
      listKey: 'neighbors',
      label: 'Focused node',
      groupLabel: `Focused node ${nameOf(root.id)}: ${count} ${
        count === 1 ? 'neighbor' : 'neighbors'
      }, page ${view.page + 1} of ${view.pageCount}`,
      rows: [rootRow, ...view.items.map((id) => makeRow('neighbors', id))],
      page: view.page,
      pageCount: view.pageCount,
      total: count,
    });
  }
  if (slice.selection.nodeIds.length > 0) {
    const view = pageWindow(listItems.selection, pages.selection, windowSize);
    const count = slice.selection.nodeIds.length;
    sections.push({
      key: 'selection',
      listKey: 'selection',
      label: 'Selection',
      groupLabel: `Selection: ${count} ${count === 1 ? 'node' : 'nodes'}, page ${
        view.page + 1
      } of ${view.pageCount}`,
      rows: view.items.map((id) => makeRow('selection', id)),
      page: view.page,
      pageCount: view.pageCount,
      total: count,
    });
  }
  if (root === null) {
    const view = pageWindow(listItems.entry, pages.entry, windowSize);
    const count = listItems.entry.length;
    sections.push({
      key: 'entry',
      listKey: 'entry',
      label: 'All nodes',
      groupLabel: `All nodes: ${count} ${count === 1 ? 'node' : 'nodes'}, page ${
        view.page + 1
      } of ${view.pageCount}`,
      rows: view.items.map((id) => makeRow('entry', id)),
      page: view.page,
      pageCount: view.pageCount,
      total: count,
    });
  }

  const rows: NavRow[] = sections.flatMap((s) => s.rows);
  let activeIndex = activeKey === null ? -1 : rows.findIndex((r) => r.key === activeKey);
  if (activeIndex === -1 && rows.length > 0) activeIndex = 0;
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const activeSection =
    activeRow !== undefined ? sections.find((s) => s.listKey === activeRow.listKey) : undefined;

  // Move real DOM focus to the active item after keyboard-driven changes so
  // the focus ring is a genuine DOM focus, never only a WebGL highlight.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    if (activeRow === undefined) return;
    itemsRef.current.get(activeRow.domId)?.focus();
  });

  // --- keyboard model ('topology'; see module JSDoc) ---
  const focusItemSoon = (): void => {
    pendingFocusRef.current = true;
  };

  const moveTo = (index: number): void => {
    if (rows.length === 0) return;
    const row = rows[Math.min(Math.max(index, 0), rows.length - 1)];
    if (row === undefined) return;
    setActiveKey(row.key);
    // Keyboard parity with pointer hover: ring the active row
    // WITHOUT flying the camera (that stays on Enter via focusNode).
    instance.emphasizeNode(row.nodeId);
    focusItemSoon();
  };

  const pageBy = (delta: number): void => {
    if (activeRow === undefined) return;
    const listKey = activeRow.listKey;
    const items = listItems[listKey];
    const pageCount = Math.max(1, Math.ceil(items.length / windowSize));
    const current = Math.min(Math.max(pages[listKey], 0), pageCount - 1);
    const next = Math.min(Math.max(current + delta, 0), pageCount - 1);
    if (next === current) return;
    setPages((p) => ({ ...p, [listKey]: next }));
    const first = items[next * windowSize];
    if (first !== undefined) {
      setActiveKey(`${listKey}:${first}`);
      instance.emphasizeNode(first);
    }
    focusItemSoon();
  };

  /** Enter: focus the node in the graph (camera fly) and re-root the
   * neighborhood. The returned ids come from the core adjacency resolution
   * (undirected; see module JSDoc). Search rows route through the
   * result contract instead: `activateSearchResult` focuses an in-scene,
   * mask-visible id and otherwise only CLASSIFIES — the navigator never
   * mutates scope/filters (the host reacts through its own channels). */
  const activate = (row: NavRow): void => {
    if (row.listKey === 'search') {
      const result = searchResults.find((r) => r.id === row.nodeId);
      if (result !== undefined) {
        const activation = instance.activateSearchResult(result);
        if (activation.status === 'unavailable') {
          getSearchResultUnavailableCallback(instance)?.(result, activation.reason);
        }
      }
      return;
    }
    const neighbors = instance.focusNode(row.nodeId);
    degreesRef.current.counts.set(row.nodeId, neighbors.length);
    setRoot({ id: row.nodeId, neighbors, model: slice.model, scope: slice.scope });
    setPages((p) => ({ ...p, neighbors: 0 }));
    setActiveKey(`root:${row.nodeId}`);
    focusItemSoon();
  };

  /** Space: toggle membership through the selection ownership path.
   * Search rows may name ids outside the accepted model — those no-op. */
  const toggleSelection = (row: NavRow): void => {
    if (row.listKey === 'search' && instance.getNode(row.nodeId) === undefined) return;
    const current = slice.selection.nodeIds;
    const next = current.includes(row.nodeId)
      ? current.filter((id) => id !== row.nodeId)
      : [...current, row.nodeId];
    instance.selectNodes(next);
  };

  const clearTransientFocus = (): void => {
    setRoot(null);
    setActiveKey(null);
    releaseEmphasis();
    focusItemSoon();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (activeRow === undefined) return;
    switch (e.key) {
      case 'ArrowDown':
        moveTo(activeIndex + 1);
        break;
      case 'ArrowUp':
        moveTo(activeIndex - 1);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(rows.length - 1);
        break;
      case 'PageDown':
        pageBy(1);
        break;
      case 'PageUp':
        pageBy(-1);
        break;
      case 'Enter':
        activate(activeRow);
        break;
      case ' ':
        toggleSelection(activeRow);
        break;
      case 'Escape':
        if (root === null) return; // nothing transient — let it bubble
        clearTransientFocus();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const panelLabel = props.label ?? 'Graph navigator';

  return (
    <div
      data-orbit-navigator=""
      role="group"
      aria-label={panelLabel}
      className={props.className}
      style={{ ...PANEL_STYLE, ...props.style }}
      onBlur={(e) => {
        // Focus left the panel entirely (paging buttons stay inside): the
        // keyboard ring clears, mirroring pointer hover leaving the canvas.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          releaseEmphasis();
        }
      }}
    >
      <div
        role="listbox"
        aria-label={`${panelLabel} items`}
        aria-activedescendant={activeRow?.domId}
        aria-keyshortcuts="ArrowUp ArrowDown Home End PageUp PageDown Enter Space Escape"
        onKeyDown={onKeyDown}
        style={LIST_STYLE}
      >
        {rows.length === 0 ? (
          <div role="presentation" style={EMPTY_STYLE}>
            No nodes
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.key} role="group" aria-label={section.groupLabel}>
              <div role="presentation" style={HEADER_STYLE}>
                {section.label}
              </div>
              {section.rows.map((row) => {
                const isActive = row.key === activeRow?.key;
                return (
                  <div
                    key={row.key}
                    id={row.domId}
                    role="option"
                    aria-selected={row.selected}
                    tabIndex={isActive ? 0 : -1}
                    ref={(el) => {
                      if (el === null) itemsRef.current.delete(row.domId);
                      else itemsRef.current.set(row.domId, el);
                    }}
                    onClick={() => {
                      setActiveKey(row.key);
                      instance.emphasizeNode(row.nodeId); // active row = ringed row
                      focusItemSoon();
                    }}
                    style={isActive ? ACTIVE_ITEM_STYLE : ITEM_STYLE}
                  >
                    {row.text}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      {activeSection !== undefined ? (
        <div data-orbit-navigator-paging="" style={PAGING_STYLE}>
          <button
            type="button"
            onClick={() => pageBy(-1)}
            disabled={activeSection.page === 0}
            aria-keyshortcuts="PageUp"
          >
            Previous page
          </button>
          <span role="status" data-orbit-navigator-page-status="">
            {`${activeSection.label}: page ${activeSection.page + 1} of ${
              activeSection.pageCount
            } (${activeSection.total} ${activeSection.total === 1 ? 'item' : 'items'})`}
          </span>
          <button
            type="button"
            onClick={() => pageBy(1)}
            disabled={activeSection.page >= activeSection.pageCount - 1}
            aria-keyshortcuts="PageDown"
          >
            Next page
          </button>
        </div>
      ) : null}
    </div>
  );
}
