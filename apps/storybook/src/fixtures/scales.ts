/**
 * Copied from apps/demo (styles.ts palette + App.tsx scale descriptors),
 * simplified to DemoNodeAttrs — keep in sync by hand. Scale descriptors are
 * module-scope so their identities stay trivially stable across renders.
 */

import type { GraphNode, Scale } from '@modernrelay/orbit-core';
import { DEFAULT_GENERATE } from './generate';
import type { DemoNodeAttrs } from './generate';

export const CLUSTER_PALETTE = [
  '#58a6ff', // blue
  '#f77f5f', // coral
  '#3fb950', // green
  '#d2a8ff', // lavender
  '#f2cc60', // gold
  '#39c5cf', // teal
] as const;

export function clusterColor(cluster: number): string {
  return CLUSTER_PALETTE[
    ((cluster % CLUSTER_PALETTE.length) + CLUSTER_PALETTE.length) % CLUSTER_PALETTE.length
  ]!;
}

/** degree ramp: sequential blue→amber over the degree metric. */
export const DEGREE_COLOR_SCALE: Scale<string, DemoNodeAttrs> = {
  kind: 'sequential',
  metric: 'degree',
  range: ['#3b82f6', '#f59e0b'],
};

/** degree size ramp: sequential 2..14px over the degree metric. */
export const DEGREE_SIZE_SCALE: Scale<number, DemoNodeAttrs> = {
  kind: 'sequential',
  metric: 'degree',
  range: [2, 14],
};

const CLUSTER_DOMAIN: readonly string[] = Array.from(
  { length: DEFAULT_GENERATE.clusters },
  (_, c) => String(c),
);

const clusterByString = (node: GraphNode<DemoNodeAttrs>): string | null => {
  const a = node.attrs;
  return a !== undefined ? String(a.cluster) : null;
};

/** cluster-as-string categorical scale; fixed domain order keeps colors and
 * legend rows stable. */
export const CLUSTER_COLOR_SCALE: Scale<string, DemoNodeAttrs> = {
  kind: 'categorical',
  by: clusterByString,
  domain: CLUSTER_DOMAIN,
  palette: CLUSTER_DOMAIN.map((v) => clusterColor(Number(v))),
};
