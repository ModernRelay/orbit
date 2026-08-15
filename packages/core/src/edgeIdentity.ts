/**
 * Collision-safe identity helpers for synthesized edges.
 *
 * Simple ids retain the documented `source→target#k` shape. The three
 * framing characters are backslash-escaped inside endpoint components, making
 * the concatenation injective for arbitrary JavaScript strings (including
 * strings that themselves contain backslashes, arrows, hashes, or NULs).
 */

import type { EdgeId, NodeId } from './types';

export type EdgePairCounters = Map<NodeId, Map<NodeId, number>>;

function escapeEdgeIdComponent(value: string): string {
  let out = '';
  for (const char of value) {
    if (char === '\\' || char === '→' || char === '#') out += '\\';
    out += char;
  }
  return out;
}

/** Build one deterministic synthesized id from an ordered endpoint pair. */
export function synthesizeEdgeId(source: NodeId, target: NodeId, k: number): EdgeId {
  return `${escapeEdgeIdComponent(source)}→${escapeEdgeIdComponent(target)}#${k}`;
}

/** Take and advance the next parallel-edge ordinal for an exact endpoint tuple. */
export function nextSynthesizedEdgeId(
  counters: EdgePairCounters,
  source: NodeId,
  target: NodeId,
): EdgeId {
  let byTarget = counters.get(source);
  if (byTarget === undefined) {
    byTarget = new Map<NodeId, number>();
    counters.set(source, byTarget);
  }
  const k = byTarget.get(target) ?? 0;
  byTarget.set(target, k + 1);
  return synthesizeEdgeId(source, target, k);
}
