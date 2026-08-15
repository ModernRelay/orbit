/**
 * DOM label lane — pure candidate selection.
 *
 * `selectLabelCandidates` is a pure, deterministic ranking function: no engine,
 * no DOM, no store. The instance-side overlay scheduler calls it on THROTTLED
 * re-rank triggers only (viewport idle, model change, config change, settle)
 * NEVER per frame. Positions are the reconciler's CPU cache (space coords);
 * per-frame work elsewhere is a pure O(k) projection of the winners.
 *
 * Selection rules:
 * - Zoom-LOD: below `minZoom` the lane is empty EXCEPT `showFor` ids, which
 * bypass the zoom gate but stay viewport-culled.
 * - `showFor` claims capacity FIRST in accepted-base order. When the
 * in-viewport `showFor` set alone exceeds capacity k, accepted-base order
 * wins deterministically and `overloadCount` reports the omissions (one
 * `label-overload` diagnostic upstream — no winner churn).
 * - Remaining capacity fills with viewport-visible nodes ranked by
 * `getWeight` (else degree), ties broken by accepted-base order.
 * - Visibility comes from the engine's `pointsInRect` when available, else a
 * CPU cull of cached positions through the viewport transform. Nodes with
 * unknown (NaN) cached positions are unplaceable on the CPU path.
 */

import type { GraphNode, LabelConfig, LabelPlacement, RenderScene } from './types';

/** A capacity winner before per-frame projection assigns screen coordinates. */
export type LabelCandidate = Omit<LabelPlacement, 'x' | 'y'>;

/** default ranked-candidate cap. */
export const LABEL_MAX_VISIBLE_DEFAULT = 64;
/** policy maximum for `maxVisible`. */
export const LABEL_MAX_VISIBLE_CAP = 1024;

export interface LabelCandidateViewport {
  zoom: number;
  /** Visible screen rect `[x0, y0, x1, y1]` (CSS px). Omit = size unknown → no viewport cull. */
  screenRect?: readonly [number, number, number, number];
  /** space → screen projection for the CPU cull path (null = not projectable). */
  spaceToScreen?: (p: readonly [number, number]) => readonly [number, number] | null;
}

export interface SelectLabelCandidatesArgs<N = Record<string, unknown>> {
  scene: RenderScene;
  /**
   * Accepted nodes in accepted-base order. Under the 'rebuild' index policy
   * scene index i IS accepted-base position i, so `nodes[i]` is the
   * node behind `scene.idByIndex[i]`.
   */
  nodes: readonly GraphNode<N>[];
  /** Space positions from the CPU cache (2*count floats; NaN pair = unknown). */
  positions: Float32Array;
  viewport: LabelCandidateViewport;
  config: LabelConfig<N>;
  /** Degree of scene index i — the default ranking weight. */
  degreeOf?: (index: number) => number;
  /**
   * Engine-accelerated visibility: point indices inside a screen rect. A null
   * return (engine not ready) falls back to the CPU cull.
   */
  pointsInRect?: (rect: readonly [number, number, number, number]) => number[] | null;
}

export interface LabelCandidateResult {
  /** Capacity-ordered winners: forced (accepted-base order) then ranked fills. */
  placements: readonly LabelCandidate[];
  /** In-viewport `showFor` ids omitted because they alone exceed capacity. */
  overloadCount: number;
}

const EMPTY_RESULT: LabelCandidateResult = { placements: [], overloadCount: 0 };

export function selectLabelCandidates<N = Record<string, unknown>>(
  args: SelectLabelCandidatesArgs<N>,
): LabelCandidateResult {
  const { scene, nodes, positions, viewport, config } = args;
  if (config.enabled === false || scene.count === 0) return EMPTY_RESULT;

  const k = Math.max(0, Math.min(Math.floor(config.maxVisible ?? LABEL_MAX_VISIBLE_DEFAULT), LABEL_MAX_VISIBLE_CAP));
  if (k === 0) return EMPTY_RESULT;

  const minZoom = config.minZoom ?? 1;
  const aboveLod = viewport.zoom >= minZoom;
  const showFor = config.showFor;
  const hasForced = showFor !== undefined && showFor.length > 0;
  if (!aboveLod && !hasForced) return EMPTY_RESULT;

  // --- visibility: engine rect query when possible, else CPU cull ---
  const rect = viewport.screenRect;
  let visibleSet: ReadonlySet<number> | null = null;
  if (rect !== undefined && args.pointsInRect !== undefined) {
    const hit = args.pointsInRect(rect);
    if (hit !== null) visibleSet = new Set(hit);
  }
  const project = viewport.spaceToScreen;
  const isVisible = (i: number): boolean => {
    if (visibleSet !== null) return visibleSet.has(i);
    const x = positions[2 * i];
    const y = positions[2 * i + 1];
    if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) return false;
    if (rect !== undefined && project !== undefined) {
      const s = project([x, y]);
      if (s === null) return false;
      return s[0] >= rect[0] && s[0] <= rect[2] && s[1] >= rect[1] && s[1] <= rect[3];
    }
    return true; // no cull information → every known position is "visible"
  };

  // --- accessors (isolated: a throwing accessor ranks 0 / falls back to id) ---
  const getText = config.getText;
  const textOf = (i: number): string => {
    const node = nodes[i];
    if (node === undefined) return scene.idByIndex[i]!;
    if (getText !== undefined) {
      try {
        return getText(node);
      } catch {
        return node.id;
      }
    }
    const label = (node.attrs as Record<string, unknown> | undefined)?.['label'];
    return label === undefined || label === null ? node.id : String(label);
  };
  const getWeight = config.getWeight;
  const degreeOf = args.degreeOf;
  const weightOf = (i: number): number => {
    if (getWeight !== undefined) {
      const node = nodes[i];
      if (node !== undefined) {
        try {
          const w = getWeight(node);
          if (Number.isFinite(w)) return w;
        } catch {
          /* rank as 0 */
        }
      }
      return 0;
    }
    return degreeOf !== undefined ? degreeOf(i) : 0;
  };

  const out: LabelCandidate[] = [];
  const chosen = new Set<number>();
  let overloadCount = 0;

  // --- 1. showFor claims capacity first, accepted-base order ---
  if (hasForced) {
    const forcedIdx: number[] = [];
    const seen = new Set<number>();
    for (const id of showFor) {
      const i = scene.indexById.get(id);
      if (i === undefined || seen.has(i)) continue;
      seen.add(i);
      if (isVisible(i)) forcedIdx.push(i);
    }
    forcedIdx.sort((a, b) => a - b); // accepted-base order wins deterministically
    overloadCount = Math.max(0, forcedIdx.length - k);
    const take = Math.min(forcedIdx.length, k);
    for (let j = 0; j < take; j++) {
      const i = forcedIdx[j]!;
      chosen.add(i);
      out.push({ id: scene.idByIndex[i]!, text: textOf(i), forced: true });
    }
  }

  // --- 2. remaining capacity: ranked fill (zoom-LOD gated) ---
  if (aboveLod && out.length < k) {
    const ranked: { i: number; w: number }[] = [];
    for (let i = 0; i < scene.count; i++) {
      if (chosen.has(i) || !isVisible(i)) continue;
      ranked.push({ i, w: weightOf(i) });
    }
    ranked.sort((a, b) => b.w - a.w || a.i - b.i); // weight desc, accepted-base tie-break
    const need = k - out.length;
    for (let j = 0; j < need && j < ranked.length; j++) {
      const i = ranked[j]!.i;
      out.push({ id: scene.idByIndex[i]!, text: textOf(i), forced: false });
    }
  }

  return { placements: out, overloadCount };
}
