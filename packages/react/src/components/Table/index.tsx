/**
 * `@modernrelay/orbit-react/components/Table` — `<GraphTable>`, the
 * virtualized crossfiltered tabular view.
 *
 * Rows are nodes (default) or edges; columns derive from the union of attr
 * keys over a BOUNDED sampled prefix (`columnSample`, default 200) plus the
 * identity keys, or are picked explicitly via `columns`. Every cell renders
 * as a TEXT NODE; `renderCell` replaces cell content.
 *
 * ## Virtualization
 * Hand-rolled windowing (no external dependency): a fixed-height scroll
 * viewport over a full-height spacer with an absolutely positioned window of
 * `ceil(height/rowHeight) + 2*overscan` rows — the mounted row count is
 * BOUNDED regardless of row count (100K rows mount ~30 DOM rows). Row
 * geometry is prop-driven (`rowHeight`, `height`), never measured, so the
 * math is deterministic under jsdom; class hooks drop decorative styles but
 * MECHANICAL styles (viewport height, spacer, window offset, row height,
 * cell flex) always apply — geometry changes go through the props.
 *
 * ## Bidirectional sync
 * - graph → table: rows follow `instance.getVisibleNodeIds` (scope ∧
 * mask) via a store subscription; brushes, filters, legend toggles, and
 * hide/show narrow the rows. An edge row lists iff BOTH endpoints are
 * visible (the public surface exposes no per-edge visibility read
 * documented approximation).
 * - table → graph: the text/predicate filter registers through the
 * crossfilter session as a brush on `filterDimension` (default 'table')
 * the host opts in by configuring an ID-KEYED categorical dimension
 * `{ key: filterDimension, kind: 'categorical', get: (n) => n.id }`; the
 * filter then writes `{ excluded: nonMatchingIds }` over the scene roster
 * (null when the filter clears / matches everything), narrowing the graph
 * AND every other crossfilter view through the standard mask fast
 * path, with standard brush history coalescing. DEGRADATION is graceful
 * and documented: no session (host never set `crossfilter`), an unknown
 * dimension key, or edge mode filter rows LOCALLY only — the graph is
 * untouched. A dimension keyed by anything other than row ids degrades the
 * same way (unknown excluded keys mask nothing). Unmounting clears any
 * brush this table wrote.
 * - selection: row click (or Enter/Space) writes the SelectionState
 * through `selectNodes`/`selectEdges` (replace; meta/ctrl toggles
 * membership), so controlled selection emits intent without mutating state;
 * selected rows carry `aria-selected="true"`.
 *
 * ## Sorting
 * Header click cycles none → asc → desc → none. Values sort in three tiers
 * numeric (`coerceNumeric`-admitted), string (everything else with content),
 * null (null/undefined, non-finite, empty, and the 'NaN'/'Infinity' sentinel
 * strings). Tier order is fixed; direction flips order within a tier; the
 * null tier is ALWAYS LAST regardless of direction.
 *
 * ## CSV export
 * `exportCsv` on the forwarded ref returns an RFC-4180 string over the
 * CURRENT filtered + sorted rows and visible columns: CRLF records, quote
 * doubling, and formula-injection neutralization (see ./csv.ts). The
 * documented opt-out is `neutralizeFormulas={false}`.
 *
 * Edge-mode row sourcing (documented v0.10 compromise): the public instance
 * surface exposes no edge roster, so `mode="edges"` reads rows from the
 * `edges` prop — the same array the host passed in its snapshot. Edge rows
 * without a caller-supplied id render and export but cannot write selection.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  CSSProperties,
  ForwardedRef,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
  UIEvent,
} from 'react';
import type {
  BrushState,
  GraphEdge,
  GraphNode,
  GraphStoreState,
  SelectionState,
} from '@modernrelay/orbit-core';
import type { AnyGraphInstance } from '../../GraphProvider';
import { useResolvedInstance } from '../shared';
import {
  cellText,
  compareSortKeys,
  deriveColumns,
  edgeCellValue,
  nodeCellValue,
  normalizeColumns,
  sortKeyOf,
  textMatches,
} from './model';
import type { GraphTableColumn, GraphTableMode, GraphTableRowRef, GraphTableSort } from './model';
import { toCsvString } from './csv';

export type { GraphTableColumn, GraphTableMode, GraphTableRowRef, GraphTableSort } from './model';

/** tree-shake probe: importing `<Graph>` alone must not pull this. */
export const __ORBIT_TABLE_SENTINEL__ = 'orbit-react/components/Table';

const COLUMN_SAMPLE_DEFAULT = 200;
const ROW_HEIGHT_DEFAULT = 28;
const HEIGHT_DEFAULT = 320;
const OVERSCAN_DEFAULT = 8;
/** Default crossfilter dimension key the table filter registers on. */
export const TABLE_FILTER_DIMENSION_DEFAULT = 'table';

export interface GraphTableCellContext {
  row: GraphTableRowRef;
  /** Resolved node for node rows (undefined for edge rows / unknown ids). */
  node?: GraphNode<any>;
  column: GraphTableColumn;
  value: unknown;
  /** The default display text (always safe to render as a text node). */
  text: string;
}

export interface GraphTableHandle {
  /** RFC-4180 CSV over the current filtered+sorted rows (see module doc). */
  exportCsv(): string;
}

export interface GraphTableProps {
  /** Explicit instance (multi-instance pages); ambient context otherwise. */
  instance?: AnyGraphInstance;
  /** Row source. Default 'nodes'. */
  mode?: GraphTableMode;
  /** Edge-mode rows (documented compromise — see module doc). */
  edges?: readonly GraphEdge<any>[];
  /** Explicit column pick; replaces derivation entirely. */
  columns?: readonly (string | GraphTableColumn)[];
  /** Bounded derivation prefix (rows sampled for the attr-key union). Default 200. */
  columnSample?: number;
  /** Controlled filter text; uncontrolled via the built-in input otherwise. */
  filterText?: string;
  onFilterTextChange?: (text: string) => void;
  /** Composed AND with the text filter; receives the underlying item. */
  filterPredicate?: (item: GraphNode<any> | GraphEdge<any>) => boolean;
  /** Crossfilter dimension key the filter registers on. Default 'table'. */
  filterDimension?: string;
  /** CSV formula-injection neutralization opt-out. Default true (safe). */
  neutralizeFormulas?: boolean;
  /** Row height in CSS px (mechanical — drives the window math). Default 28. */
  rowHeight?: number;
  /** Scroll viewport height in CSS px (mechanical). Default 320. */
  height?: number;
  /** Extra rows mounted on each side of the viewport. Default 8. */
  overscan?: number;
  /** Replaces default cell content (rendered inside the cell element). */
  renderCell?: (ctx: GraphTableCellContext) => ReactNode;
  /** Accessible name of the table. Default 'Graph table'. */
  label?: string;
  /** Class hook for the root; providing it drops the decorative styles. */
  className?: string;
  style?: CSSProperties;
  /** Class hook for body rows; providing it drops their decorative styles. */
  rowClassName?: string;
}

// ---------------------------------------------------------------------------
// Store subscriptions
// ---------------------------------------------------------------------------

/**
 * Version string that changes whenever the row model could: revisions,
 * visible counts, accepted counts, status, and session availability. The
 * session listener re-attaches on every store publication (the
 * _shared/crossfilter convention — engine rebuilds swap subscribers).
 */
function useTableVersion(instance: AnyGraphInstance): string {
  const subscribe = useCallback(
    (onChange: () => void) => {
      let sessionUnsub: (() => void) | null = null;
      const attach = (): void => {
        sessionUnsub?.();
        sessionUnsub = null;
        const session = instance.getCrossfilterSession();
        if (session !== null) sessionUnsub = session.subscribe(onChange);
      };
      attach();
      const storeUnsub = instance.store.subscribe(() => {
        attach();
        onChange();
      });
      return () => {
        storeUnsub();
        sessionUnsub?.();
        sessionUnsub = null;
      };
    },
    [instance],
  );
  const getSnapshot = useCallback((): string => {
    const s: GraphStoreState = instance.store.getState();
    const hasSession = instance.getCrossfilterSession() !== null ? 1 : 0;
    return `${s.status}:${s.revisions.model}:${s.revisions.scope}:${s.revisions.render}:${s.visible.nodes}:${s.visible.edges}:${s.nodeCount}:${s.edgeCount}:${hasSession}`;
  }, [instance]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The store keeps `selection` referentially stable across unrelated
 * publishes, so the raw field is a valid useSyncExternalStore snapshot. */
function useSelection(instance: AnyGraphInstance): SelectionState {
  const subscribe = useCallback(
    (onChange: () => void) => instance.store.subscribe(onChange),
    [instance],
  );
  const getSnapshot = useCallback(
    (): SelectionState => instance.store.getState().selection,
    [instance],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Styling defaults (decorative styles drop when the class hooks are given;
// mechanical geometry always applies — see module doc).
// ---------------------------------------------------------------------------

const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 8,
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.96)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  color: '#e8eaf0',
  font: '12px/1.4 system-ui, sans-serif',
};
const TOOLBAR_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const FILTER_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'rgba(255, 255, 255, 0.06)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  borderRadius: 6,
  color: 'inherit',
  font: 'inherit',
  padding: '3px 8px',
};
const COUNT_STYLE: CSSProperties = { opacity: 0.65, whiteSpace: 'nowrap' };
const HEADER_ROW_STYLE: CSSProperties = { borderBottom: '1px solid rgba(255, 255, 255, 0.2)' };
const HEADER_BUTTON_STYLE: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
  padding: '2px 4px',
  textAlign: 'left',
  width: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const ROW_STYLE: CSSProperties = { cursor: 'pointer' };
const ROW_SELECTED_STYLE: CSSProperties = {
  ...ROW_STYLE,
  background: 'rgba(122, 162, 255, 0.22)',
};
const CELL_STYLE: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  padding: '0 4px',
};
const EMPTY_STYLE: CSSProperties = { fontStyle: 'italic', opacity: 0.8, padding: 4 };

/** Mechanical (always applied) flex geometry for header/body cells. */
const CELL_MECHANICS: CSSProperties = { flex: 1, minWidth: 0 };

function GraphTableInner(
  props: GraphTableProps,
  ref: ForwardedRef<GraphTableHandle>,
): ReactElement {
  const instance = useResolvedInstance(props.instance, '<GraphTable>');
  const version = useTableVersion(instance);
  const selection = useSelection(instance);

  const mode: GraphTableMode = props.mode ?? 'nodes';
  const rowHeight = props.rowHeight ?? ROW_HEIGHT_DEFAULT;
  const height = props.height ?? HEIGHT_DEFAULT;
  const overscan = props.overscan ?? OVERSCAN_DEFAULT;
  const dimensionKey = props.filterDimension ?? TABLE_FILTER_DIMENSION_DEFAULT;
  const neutralize = props.neutralizeFormulas ?? true;
  const predicate = props.filterPredicate;

  const [internalFilter, setInternalFilter] = useState('');
  const filterText = props.filterText ?? internalFilter;
  const query = filterText.trim().toLowerCase();
  const [sort, setSort] = useState<GraphTableSort | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  // --- row model -------------------------------------------------------------

  const edgesProp = props.edges;
  const baseRows = useMemo<readonly GraphTableRowRef[]>(() => {
    void version; // rebuild on every relevant store publication
    if (mode === 'edges') {
      const visible = new Set(instance.getVisibleNodeIds());
      const out: GraphTableRowRef[] = [];
      (edgesProp ?? []).forEach((edge, i) => {
        if (!visible.has(edge.source) || !visible.has(edge.target)) return;
        if (edge.id !== undefined) out.push({ key: edge.id, id: edge.id, edge });
        else out.push({ key: `${i}:${edge.source}→${edge.target}`, id: null, edge });
      });
      return out;
    }
    return instance.getVisibleNodeIds().map((id) => ({ key: id, id }));
  }, [instance, version, mode, edgesProp]);

  const columnSample = props.columnSample ?? COLUMN_SAMPLE_DEFAULT;
  const columnsProp = props.columns;
  const columns = useMemo<readonly GraphTableColumn[]>(() => {
    if (columnsProp !== undefined) return normalizeColumns(columnsProp);
    const sample = baseRows.slice(0, columnSample).map((row) => {
      return row.edge !== undefined
        ? (row.edge.attrs as Record<string, unknown> | undefined)
        : ((instance.getNode(row.key) as GraphNode<any> | undefined)?.attrs as
            | Record<string, unknown>
            | undefined);
    });
    return deriveColumns(mode, sample);
  }, [instance, baseRows, mode, columnsProp, columnSample]);

  const valueOf = useCallback(
    (row: GraphTableRowRef, key: string): unknown =>
      row.edge !== undefined
        ? edgeCellValue(row.edge, key)
        : nodeCellValue(instance.getNode(row.key) as GraphNode<any> | undefined, row.key, key),
    [instance],
  );

  /** Text/predicate match for one row over the visible columns. */
  const matchesRow = useCallback(
    (row: GraphTableRowRef): boolean => {
      if (predicate !== undefined) {
        const item =
          row.edge !== undefined
            ? row.edge
            : (instance.getNode(row.key) as GraphNode<any> | undefined);
        if (item === undefined || !predicate(item)) return false;
      }
      if (query === '') return true;
      return textMatches(
        columns.map((col) => cellText(valueOf(row, col.key))),
        query,
      );
    },
    [instance, predicate, query, columns, valueOf],
  );

  const filterActive = query !== '' || predicate !== undefined;
  const filteredRows = useMemo<readonly GraphTableRowRef[]>(
    () => (filterActive ? baseRows.filter(matchesRow) : baseRows),
    [baseRows, filterActive, matchesRow],
  );

  const sortedRows = useMemo<readonly GraphTableRowRef[]>(() => {
    if (sort === null || !columns.some((c) => c.key === sort.key)) return filteredRows;
    const direction: 1 | -1 = sort.direction === 'asc' ? 1 : -1;
    const decorated = filteredRows.map((row) => ({
      row,
      key: sortKeyOf(valueOf(row, sort.key)),
    }));
    decorated.sort((a, b) => compareSortKeys(a.key, b.key, direction)); // stable → base-order ties
    return decorated.map((d) => d.row);
  }, [filteredRows, sort, columns, valueOf]);

  // --- table → graph: crossfilter registration (see module doc) ---------------

  /** Set once this table wrote a non-null brush; unmount clears it. */
  const wroteBrushRef = useRef<{ instance: AnyGraphInstance; key: string } | null>(null);

  useEffect(() => {
    if (mode !== 'nodes') return;
    const session = instance.getCrossfilterSession();
    if (session === null) return;
    try {
      session.getBrush(dimensionKey);
    } catch {
      return; // dimension not configured — degrade to local-only filtering
    }
    let brush: BrushState = null;
    if (filterActive) {
      const excluded: string[] = [];
      for (const id of instance.getSceneNodeIds()) {
        if (!matchesRow({ key: id, id })) excluded.push(id);
      }
      if (excluded.length > 0) brush = { excluded };
    }
    if (brush !== null) wroteBrushRef.current = { instance, key: dimensionKey };
    // Deep-equal brushes no-op inside the engine, so re-runs are cheap.
    void session.setBrush(dimensionKey, brush).catch(() => undefined);
  }, [instance, version, mode, dimensionKey, filterActive, matchesRow]);

  // Clearing only on final unmount left the previous dimension's
  // brush active across `dimensionKey`/`mode`/`instance` transitions,
  // silently intersecting later filters. The cleanup now runs on every
  // identity change (and still on unmount); the write effect above re-arms
  // the new identity immediately after.
  useEffect(
    () => () => {
      const wrote = wroteBrushRef.current;
      if (wrote === null) return;
      wroteBrushRef.current = null;
      const session = wrote.instance.getCrossfilterSession();
      if (session !== null) void session.setBrush(wrote.key, null).catch(() => undefined);
    },
    [instance, mode, dimensionKey],
  );

  // --- selection ---------------------------------------------------------------

  const selectedNodes = useMemo(() => new Set(selection.nodeIds), [selection]);
  const selectedEdges = useMemo(() => new Set(selection.edgeIds), [selection]);
  const isSelected = (row: GraphTableRowRef): boolean =>
    row.edge !== undefined
      ? row.id !== null && selectedEdges.has(row.id)
      : selectedNodes.has(row.key);

  const activateRow = (row: GraphTableRowRef, additive: boolean): void => {
    if (row.edge !== undefined) {
      if (row.id === null) return; // unaddressable (no caller edge id)
      const id = row.id;
      if (additive) {
        const current = selection.edgeIds;
        instance.selectEdges(
          current.includes(id) ? current.filter((e) => e !== id) : [...current, id],
        );
      } else {
        instance.selectEdges([id]);
      }
      return;
    }
    if (additive) {
      const current = selection.nodeIds;
      instance.selectNodes(
        current.includes(row.key) ? current.filter((n) => n !== row.key) : [...current, row.key],
      );
    } else {
      instance.selectNodes([row.key]);
    }
  };

  // --- CSV export ---------------------------------------------------------------

  const exportStateRef = useRef({ columns, rows: sortedRows, valueOf, neutralize });
  exportStateRef.current = { columns, rows: sortedRows, valueOf, neutralize };
  useImperativeHandle(
    ref,
    (): GraphTableHandle => ({
      exportCsv: (): string => {
        const s = exportStateRef.current;
        return toCsvString(
          s.columns.map((col) => col.label ?? col.key),
          s.rows.map((row) => s.columns.map((col) => s.valueOf(row, col.key))),
          s.neutralize,
        );
      },
    }),
    [],
  );

  // --- windowing -----------------------------------------------------------------

  const total = sortedRows.length;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const windowSize = Math.ceil(height / rowHeight) + overscan * 2;
  const windowRows = sortedRows.slice(first, first + windowSize);

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    setScrollTop(e.currentTarget.scrollTop);
  };

  const cycleSort = (key: string): void => {
    setSort((prev) => {
      if (prev === null || prev.key !== key) return { key, direction: 'asc' };
      if (prev.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
  };

  const onFilterChange = (text: string): void => {
    if (props.filterText === undefined) setInternalFilter(text);
    props.onFilterTextChange?.(text);
  };

  const styled = props.className === undefined;
  const rowStyled = props.rowClassName === undefined;
  const label = props.label ?? 'Graph table';

  const renderRow = (row: GraphTableRowRef, index: number): ReactElement => {
    const selected = isSelected(row);
    const node =
      row.edge === undefined
        ? (instance.getNode(row.key) as GraphNode<any> | undefined)
        : undefined;
    const mechanics: CSSProperties = {
      height: rowHeight,
      display: 'flex',
      alignItems: 'center',
      boxSizing: 'border-box',
    };
    return (
      <div
        key={row.key}
        role="row"
        aria-rowindex={first + index + 2}
        aria-selected={selected}
        data-orbit-table-row={row.key}
        tabIndex={0}
        className={props.rowClassName}
        style={
          rowStyled ? { ...mechanics, ...(selected ? ROW_SELECTED_STYLE : ROW_STYLE) } : mechanics
        }
        onClick={(e: MouseEvent<HTMLDivElement>) => {
          activateRow(row, e.metaKey || e.ctrlKey);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          activateRow(row, e.metaKey || e.ctrlKey);
        }}
      >
        {columns.map((col) => {
          const value = valueOf(row, col.key);
          const text = cellText(value);
          const ctx: GraphTableCellContext =
            node !== undefined
              ? { row, node, column: col, value, text }
              : { row, column: col, value, text };
          return (
            <div
              key={col.key}
              role="cell"
              data-orbit-table-cell={col.key}
              style={styled ? { ...CELL_MECHANICS, ...CELL_STYLE } : CELL_MECHANICS}
            >
              {props.renderCell !== undefined ? props.renderCell(ctx) : text}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div
      data-orbit-table={mode}
      role="group"
      aria-label={label}
      className={props.className}
      style={styled ? { ...ROOT_STYLE, ...props.style } : props.style}
    >
      <div data-orbit-table-toolbar="" style={styled ? TOOLBAR_STYLE : undefined}>
        <input
          type="text"
          data-orbit-table-filter=""
          aria-label="Filter rows"
          value={filterText}
          style={styled ? FILTER_STYLE : undefined}
          onChange={(e) => {
            onFilterChange(e.currentTarget.value);
          }}
        />
        <span data-orbit-table-count="" style={styled ? COUNT_STYLE : undefined}>
          {`${total} of ${baseRows.length} rows`}
        </span>
      </div>
      <div role="table" aria-label={`${label} rows`} aria-rowcount={total + 1}>
        <div role="rowgroup">
          <div
            role="row"
            aria-rowindex={1}
            data-orbit-table-head=""
            style={styled ? { display: 'flex', ...HEADER_ROW_STYLE } : { display: 'flex' }}
          >
            {columns.map((col) => {
              const active = sort !== null && sort.key === col.key;
              const ariaSort = active
                ? sort.direction === 'asc'
                  ? 'ascending'
                  : 'descending'
                : 'none';
              return (
                <div
                  key={col.key}
                  role="columnheader"
                  aria-sort={ariaSort}
                  data-orbit-table-header={col.key}
                  style={CELL_MECHANICS}
                >
                  <button
                    type="button"
                    data-orbit-table-sort={col.key}
                    style={styled ? HEADER_BUTTON_STYLE : undefined}
                    onClick={() => {
                      cycleSort(col.key);
                    }}
                  >
                    {col.label ?? col.key}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div
          role="rowgroup"
          data-orbit-table-viewport=""
          onScroll={onScroll}
          style={{ height, overflowY: 'auto', position: 'relative' }}
        >
          {total === 0 ? (
            <div data-orbit-table-empty="" style={styled ? EMPTY_STYLE : undefined}>
              No rows
            </div>
          ) : (
            <div
              data-orbit-table-spacer=""
              style={{ height: total * rowHeight, position: 'relative' }}
            >
              <div
                data-orbit-table-window=""
                style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}
              >
                {windowRows.map((row, i) => renderRow(row, i))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const GraphTable = forwardRef<GraphTableHandle, GraphTableProps>(GraphTableInner);
GraphTable.displayName = 'GraphTable';
