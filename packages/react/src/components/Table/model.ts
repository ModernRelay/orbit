/**
 * Pure row/column/sort/filter helpers for `<GraphTable>`.
 * Framework-free so the sort-coercion contract and the bounded column
 * derivation stay unit-testable without a DOM.
 */

import { coerceNumeric } from '@modernrelay/orbit-core';
import type { GraphEdge, GraphNode } from '@modernrelay/orbit-core';

export type GraphTableMode = 'nodes' | 'edges';

export interface GraphTableColumn {
  /** Column key: 'id', 'source'/'target' (edge mode), or an attr key. */
  key: string;
  /** Header text; defaults to the key. Rendered as a TEXT NODE. */
  label?: string;
}

export interface GraphTableSort {
  key: string;
  direction: 'asc' | 'desc';
}

/**
 * One table row. Node rows: `key === id === NodeId`. Edge rows carry the
 * caller edge; `id` is null when the caller supplied no edge id (such rows
 * render and export but cannot write edge selection — the core-synthesized
 * id is not observable through the public surface).
 */
export interface GraphTableRowRef {
  /** Stable render identity (node id, edge id, or a positional edge key). */
  key: string;
  /** Public id usable for selection writes; null = unaddressable edge row. */
  id: string | null;
  edge?: GraphEdge<any>;
}

/** Attr value → display TEXT (never markup): strings verbatim, numbers via
 * String, null/undefined empty, structured values JSON (cycles degrade to
 * the String form) — the Inspector's convention. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function nodeCellValue(
  node: GraphNode<any> | undefined,
  id: string,
  key: string,
): unknown {
  if (key === 'id') return id;
  const attrs = node?.attrs as Record<string, unknown> | undefined;
  return attrs?.[key];
}

export function edgeCellValue(edge: GraphEdge<any>, key: string): unknown {
  if (key === 'id') return edge.id ?? '';
  if (key === 'source') return edge.source;
  if (key === 'target') return edge.target;
  const attrs = edge.attrs as Record<string, unknown> | undefined;
  return attrs?.[key];
}

export function normalizeColumns(
  pick: readonly (string | GraphTableColumn)[],
): readonly GraphTableColumn[] {
  return pick.map((c) => (typeof c === 'string' ? { key: c } : c));
}

/**
 * Derived columns: the identity keys for the mode ('id', plus
 * 'source'/'target' for edges) followed by the union of attr keys over the
 * SAMPLED PREFIX the caller passes (bounded — attrs seen only past the
 * sample do not create columns; use the `columns` prop to pin them).
 * First-seen key order.
 */
export function deriveColumns(
  mode: GraphTableMode,
  attrsSample: readonly (Record<string, unknown> | undefined)[],
): readonly GraphTableColumn[] {
  const keys: string[] = mode === 'edges' ? ['id', 'source', 'target'] : ['id'];
  const seen = new Set(keys);
  for (const attrs of attrsSample) {
    if (attrs === undefined) continue;
    for (const key of Object.keys(attrs)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys.map((key) => ({ key }));
}

// ---------------------------------------------------------------------------
// sort coercion. Three tiers:
// 0 numeric — values `coerceNumeric` admits (numbers, numeric strings);
// 1 string — everything else with content (plain strings, booleans,
// structured values by display text);
// 2 null — null/undefined, non-finite numbers, empty strings, and the
// sentinel strings 'NaN'/'Infinity'/'±Infinity'.
// Tier order is fixed (numeric block, then string block); `direction` flips
// ordering WITHIN each tier; the null tier is ALWAYS LAST regardless of
// direction. Ties preserve base row order (stable sort).
// ---------------------------------------------------------------------------

export interface SortKey {
  tier: 0 | 1 | 2;
  num: number;
  str: string;
}

const NULL_KEY: SortKey = { tier: 2, num: 0, str: '' };

/** Case-insensitive hygiene sentinels (mirrors `coerceNumeric`'s list). */
function isSentinelString(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return (
    lower === '' ||
    lower === 'nan' ||
    lower === 'infinity' ||
    lower === '-infinity' ||
    lower === '+infinity'
  );
}

export function sortKeyOf(value: unknown): SortKey {
  if (value === null || value === undefined) return NULL_KEY;
  const num = coerceNumeric(value);
  if (num !== null) return { tier: 0, num, str: '' };
  if (typeof value === 'number') return NULL_KEY; // non-finite
  if (typeof value === 'string') {
    return isSentinelString(value) ? NULL_KEY : { tier: 1, num: 0, str: value };
  }
  return { tier: 1, num: 0, str: cellText(value) };
}

export function compareSortKeys(a: SortKey, b: SortKey, direction: 1 | -1): number {
  if (a.tier !== b.tier) {
    if (a.tier === 2) return 1; // nulls last regardless of direction
    if (b.tier === 2) return -1;
    return a.tier - b.tier; // numeric block before string block, fixed
  }
  if (a.tier === 2) return 0;
  if (a.tier === 0) return direction * (a.num < b.num ? -1 : a.num > b.num ? 1 : 0);
  return direction * (a.str < b.str ? -1 : a.str > b.str ? 1 : 0);
}

/** Case-insensitive substring match over a row's rendered cell texts. */
export function textMatches(texts: readonly string[], queryLower: string): boolean {
  for (const text of texts) {
    if (text.toLowerCase().includes(queryLower)) return true;
  }
  return false;
}
