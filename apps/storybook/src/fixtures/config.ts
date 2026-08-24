/**
 * Copied from apps/demo/src/App.tsx module-scope config constants, simplified
 * to DemoNodeAttrs (no omnigraph union) — keep in sync by hand. All values are
 * module-scope: dimension/label identity changes would rebuild sessions.
 */

import type {
  AccessibilityConfig,
  DimensionSpec,
  GraphNode,
  LabelConfig,
  SimulationConfig,
} from '@modernrelay/orbit-core';
import type { DemoNodeAttrs } from './generate';

export const SIMULATION: SimulationConfig = { repulsion: 0.6, gravity: 0.25 };

export const labelOf = (node: GraphNode<DemoNodeAttrs>): string =>
  node.attrs?.label ?? node.id;

/** label lane: zoom-LOD at 1.2, ranked cap 48, cluster hubs forced. */
export const LABELS: LabelConfig<DemoNodeAttrs> = {
  minZoom: 1.2,
  maxVisible: 48,
  showFor: ['n0', 'n1'],
  getText: labelOf,
};

export const ACCESSIBILITY: AccessibilityConfig<DemoNodeAttrs> = {
  label: 'orbit storybook graph',
  getAccessibleLabel: labelOf,
};

/** construction-only: <Graph> reads searchIndex once at mount. */
export const SEARCH_INDEX: readonly string[] = ['label'];

export const SCORE_DIM: DimensionSpec<DemoNodeAttrs> = {
  key: 'score',
  kind: 'numeric',
  bins: 30,
  get: (node) => node.attrs?.score,
};

export const CREATED_DIM: DimensionSpec<DemoNodeAttrs> = {
  key: 'createdAt',
  kind: 'temporal',
  bins: 60,
  get: (node) => node.attrs?.createdAt,
};

export const CROSSFILTER_DIMS: readonly DimensionSpec<DemoNodeAttrs>[] = [SCORE_DIM, CREATED_DIM];
