/**
 * <GraphSelectionActions> — selection action panel.
 *
 * Renders ONLY while the selection is non-empty: a count plus Select
 * neighbors / Invert / Clear / Hide selected / Pin selected / Unpin selected,
 * all driven through the instance mutators so it stays correct under
 * controlled selection. Headless-
 * styleable via `className`/`buttonClassName` (providing them drops the
 * default dark-theme inline styles).
 */

import { useCallback, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { AnyGraphInstance } from '../../GraphProvider';
import { cornerStyle, mergeStyle, useResolvedInstance } from '../shared';
import type { GraphCorner } from '../shared';

export interface GraphSelectionActionsProps {
  /** Explicit instance; defaults to the ambient <Graph>/<GraphProvider> one. */
  instance?: AnyGraphInstance;
  /** Class hook for the panel root; providing it drops the default styles. */
  /** Corner this panel anchors to. Default 'bottom-left'. */
  position?: GraphCorner;
  /** Distance from the two anchored edges in CSS px. Default 12. */
  offset?: number;
  /** Class hook for the root; providing it drops the default styles
   * INCLUDING placement — position it yourself in CSS. */
  className?: string;
  /** Style overrides merged over the defaults; an inset you set here
   * wins over the one `position` implies (resolved per axis). */
  style?: CSSProperties;
  /** Class hook for each button; providing it drops the default styles. */
  buttonClassName?: string;
}

interface SelectionAction {
  id: string;
  label: string;
  run(): void;
}

// --- default dark-theme styling (dropped when class hooks are provided) ---

const PANEL_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 2,
  padding: 4,
  borderRadius: 8,
  background: 'rgba(23, 25, 32, 0.92)',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
  color: '#e8eaf0',
  font: '12px/1.4 system-ui, sans-serif',
};

const COUNT_STYLE: CSSProperties = {
  padding: '2px 8px',
  opacity: 0.75,
  whiteSpace: 'nowrap',
};

const BUTTON_STYLE: CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  borderRadius: 6,
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  minHeight: 26,
  padding: '2px 8px',
  whiteSpace: 'nowrap',
};

export function GraphSelectionActions(props: GraphSelectionActionsProps): ReactElement | null {
  const instance = useResolvedInstance(props.instance, '<GraphSelectionActions>');

  // The store keeps `selection` referentially stable across unrelated
  // publishes, so the raw field is a valid useSyncExternalStore snapshot.
  const subscribe = useCallback(
    (onStoreChange: () => void) => instance.store.subscribe(onStoreChange),
    [instance],
  );
  const getSelection = useCallback(() => instance.store.getState().selection, [instance]);
  const selection = useSyncExternalStore(subscribe, getSelection, getSelection);

  const count = selection.nodeIds.length + selection.edgeIds.length + selection.groupIds.length;
  if (count === 0) return null;

  const nodeIds = selection.nodeIds;
  const actions: SelectionAction[] = [
    {
      id: 'select-neighbors',
      label: 'Select neighbors',
      run: () => {
        instance.selectNeighbors();
      },
    },
    {
      id: 'invert',
      label: 'Invert',
      run: () => {
        instance.invertSelection();
      },
    },
    {
      id: 'clear',
      label: 'Clear',
      run: () => {
        instance.clearSelection();
      },
    },
    {
      id: 'hide',
      label: 'Hide selected',
      run: () => {
        instance.hideNodes(nodeIds);
      },
    },
    {
      id: 'pin',
      label: 'Pin selected',
      run: () => {
        for (const id of nodeIds) instance.pinNode(id);
      },
    },
    {
      id: 'unpin',
      label: 'Unpin selected',
      run: () => {
        for (const id of nodeIds) instance.unpinNode(id);
      },
    },
  ];

  return (
    <div
      data-orbit-selection-actions=""
      role="group"
      aria-label="Selection actions"
      className={props.className}
      style={
        props.className !== undefined
          ? props.style
          : mergeStyle(
              { ...cornerStyle(props.position ?? 'bottom-left', props.offset), ...PANEL_STYLE, },
              props.style,
            )
      }
    >
      <span data-orbit-selection-count="" style={props.className !== undefined ? undefined : COUNT_STYLE}>
        {count} selected
      </span>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          data-orbit-selection-action={action.id}
          className={props.buttonClassName}
          style={props.buttonClassName !== undefined ? undefined : BUTTON_STYLE}
          onClick={() => {
            action.run();
          }}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
