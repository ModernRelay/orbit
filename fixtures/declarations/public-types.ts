/**
 * A downstream library should be able to infer and emit these return types
 * without naming Orbit's private declaration chunks. Compile against packed
 * exports: source aliases cannot expose a missing public type re-export.
 */
import type { SceneGroups } from '@modernrelay/orbit-core';
import type { GraphContextMenuProps } from '@modernrelay/orbit-react/components/ContextMenu';
import type { GraphExplorerProps } from '@modernrelay/orbit-react/components/Explorer';
import type { GraphHistogramProps } from '@modernrelay/orbit-react/components/Histogram';
import type { GraphInspectorProps } from '@modernrelay/orbit-react/components/Inspector';
import type { GraphLegendProps } from '@modernrelay/orbit-react/components/Legend';
import type { GraphMinimapProps } from '@modernrelay/orbit-react/components/Minimap';
import type { GraphNavigatorProps } from '@modernrelay/orbit-react/components/Navigator';
import type { GraphSearchProps } from '@modernrelay/orbit-react/components/Search';
import type { GraphSelectionActionsProps } from '@modernrelay/orbit-react/components/SelectionActions';
import type { GraphSimControlsProps } from '@modernrelay/orbit-react/components/SimControls';
import type { GraphTableProps } from '@modernrelay/orbit-react/components/Table';
import type { GraphTimelineProps } from '@modernrelay/orbit-react/components/Timeline';
import type { GraphToolbarProps } from '@modernrelay/orbit-react/components/Toolbar';
import type { GraphTooltipProps } from '@modernrelay/orbit-react/components/Tooltip';

export const folds = (scene: SceneGroups) => scene.folds;
export const contextMenuInstance = (props: GraphContextMenuProps) => props.instance;
export const explorerInstance = (props: GraphExplorerProps) => props.instance;
export const histogramInstance = (props: GraphHistogramProps) => props.instance;
export const inspectorInstance = (props: GraphInspectorProps) => props.instance;
export const legendInstance = (props: GraphLegendProps) => props.instance;
export const minimapInstance = (props: GraphMinimapProps) => props.instance;
export const navigatorInstance = (props: GraphNavigatorProps) => props.instance;
export const searchInstance = (props: GraphSearchProps) => props.instance;
export const selectionActionsInstance = (props: GraphSelectionActionsProps) => props.instance;
export const simControlsInstance = (props: GraphSimControlsProps) => props.instance;
export const tableInstance = (props: GraphTableProps) => props.instance;
export const timelineInstance = (props: GraphTimelineProps) => props.instance;
export const toolbarInstance = (props: GraphToolbarProps) => props.instance;
export const tooltipInstance = (props: GraphTooltipProps) => props.instance;
