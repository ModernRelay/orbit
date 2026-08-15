/**
 * selection set algebra — pure helpers over id arrays.
 *
 * Selection namespaces are id-ordered "sets": first-occurrence deduped, and
 * once validated against an accepted base — stored in accepted-base order.
 * Everything here is allocation-only pure data work: no store, no engine.
 */

/** Keep the first occurrence of every id, preserving encounter order. */
export function dedupeFirstOccurrence<T>(ids: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Validate ids against an accepted base index (node or edge): unknown ids are
 * dropped, duplicates collapse to their first occurrence, and the result is
 * ordered by accepted-base position.
 */
export function orderByAcceptedBase(
  ids: readonly string[],
  baseIndex: ReadonlyMap<string, number>,
): string[] {
  const seen = new Set<string>();
  const known: string[] = [];
  for (const id of ids) {
    if (seen.has(id) || !baseIndex.has(id)) continue;
    seen.add(id);
    known.push(id);
  }
  known.sort((a, b) => baseIndex.get(a)! - baseIndex.get(b)!);
  return known;
}

/** a ∪ b, first-occurrence order (a's order wins, then b's new ids). */
export function unionIds<T>(a: readonly T[], b: readonly T[]): T[] {
  return dedupeFirstOccurrence([...a, ...b]);
}

/** a \ b, keeping a's (deduped) order. */
export function differenceIds<T>(a: readonly T[], b: readonly T[]): T[] {
  const drop = new Set(b);
  return dedupeFirstOccurrence(a).filter((id) => !drop.has(id));
}

/** a ∩ b, keeping a's (deduped) order. */
export function intersectionIds<T>(a: readonly T[], b: readonly T[]): T[] {
  const keep = new Set(b);
  return dedupeFirstOccurrence(a).filter((id) => keep.has(id));
}

/** Toggle membership of `id` in `ids` using meta-click semantics. */
export function toggleId<T>(ids: readonly T[], id: T): T[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...dedupeFirstOccurrence(ids), id];
}
