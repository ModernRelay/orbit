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

  // --- screen-space declutter (overlap: 'hide', the default) ---------------
  // Greedy occupancy in RANK order: an estimated label box that intersects
  // an already-claimed box loses its slot to the next-ranked candidate.
  // Boxes are estimates (fixed per-character width) — the goal is
  // decluttering, not typesetting. A uniform cell grid prunes the
  // intersection tests; without a projectable viewport there are no boxes
  // and selection stays overlap-blind.
  const declutter = config.overlap !== 'allow' && project !== undefined;
  // non-finite padding would give the occupancy grid infinite loop bounds
  // (a main-thread hang) — degenerate input falls back to the default.
  const configuredPad = config.overlapPadding ?? 2;
  const pad = Number.isFinite(configuredPad) ? Math.max(0, configuredPad) : 2;
  const CELL = 64;
  const CHAR_W = 7;
  const BOX_H = 18;
  const keptBoxes: number[] = []; // x0,y0,x1,y1 quads
  const cells = new Map<number, number[]>();
  const cellKey = (cx: number, cy: number): number => cx * 100003 + cy;
  const boxOf = (i: number, text: string): readonly [number, number, number, number] | null => {
    const x = positions[2 * i];
    const y = positions[2 * i + 1];
    if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) return null;
    const sPt = project!([x, y]);
    if (sPt === null) return null;
    const w = CHAR_W * text.length + 8 + 2 * pad;
    const h = BOX_H + 2 * pad;
    return [sPt[0] - w / 2, sPt[1] - h / 2, sPt[0] + w / 2, sPt[1] + h / 2];
  };
  const collides = (b: readonly [number, number, number, number]): boolean => {
    const cx0 = Math.floor(b[0] / CELL);
    const cy0 = Math.floor(b[1] / CELL);
    const cx1 = Math.floor(b[2] / CELL);
    const cy1 = Math.floor(b[3] / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const bucket = cells.get(cellKey(cx, cy));
        if (bucket === undefined) continue;
        for (const q of bucket) {
          const x0 = keptBoxes[q]!;
          const y0 = keptBoxes[q + 1]!;
          const x1 = keptBoxes[q + 2]!;
          const y1 = keptBoxes[q + 3]!;
          if (b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0) return true;
        }
      }
    }
    return false;
  };
  const claim = (b: readonly [number, number, number, number]): void => {
    const q = keptBoxes.length;
    keptBoxes.push(b[0], b[1], b[2], b[3]);
    const cx0 = Math.floor(b[0] / CELL);
    const cy0 = Math.floor(b[1] / CELL);
    const cx1 = Math.floor(b[2] / CELL);
    const cy1 = Math.floor(b[3] / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const key = cellKey(cx, cy);
        const bucket = cells.get(key);
        if (bucket === undefined) cells.set(key, [q]);
        else bucket.push(q);
      }
    }
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
      const text = textOf(i);
      if (declutter) {
        // forced ids always render; they claim space so ranked fills avoid
        // stacking onto them (forced-on-forced overlap is the host's call).
        const b = boxOf(i, text);
        if (b !== null) claim(b);
      }
      out.push({ id: scene.idByIndex[i]!, text, forced: true });
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
    for (let j = 0; j < ranked.length && out.length < k; j++) {
      const i = ranked[j]!.i;
      const text = textOf(i);
      if (declutter) {
        const b = boxOf(i, text);
        // unprojectable here ⇒ visibility already fell back — keep the label
        if (b !== null) {
          if (collides(b)) continue; // the slot passes to the next-ranked
          claim(b);
        }
      }
      out.push({ id: scene.idByIndex[i]!, text, forced: false });
    }
  }

  return { placements: out, overloadCount };
}
