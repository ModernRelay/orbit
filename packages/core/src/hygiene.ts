/**
 * shared numeric hygiene — THE single coercion layer for every
 * numeric consumer in orbit-core.
 *
 * Wherever a caller-supplied value feeds a numeric sink — size/width
 * projection buffers, scale domains, metric columns,
 * crossfilter bins, table lanes — the value is REQUIRED to route
 * through `coerceNumeric` / `coerceNumericInto`. Non-numeric and non-finite
 * inputs (including the string sentinels `"NaN"` / `"Infinity"` /
 * `"-Infinity"` that JSON transports smuggle through) coerce to `null`:
 * the row falls back to the default style and is excluded from domain
 * computation. NaN NEVER escapes this module — not as a return value and not
 * into a GPU buffer.
 *
 * Coercion rules:
 * - numbers pass iff `Number.isFinite` (NaN / ±Infinity → null);
 * - strings are trimmed; empty → null; the case-insensitive sentinels
 * 'NaN' / 'Infinity' / '-Infinity' / '+Infinity' → null; anything else
 * parses via `Number(...)` and passes iff finite (so '1e3' → 1000 but
 * '12px' → null — `Number`, not `parseFloat`, so no partial prefixes);
 * - booleans, objects, arrays, functions, symbols, bigints, null, and
 * undefined → null (no `valueOf`/`toString` coercion side channels).
 *
 * `crossfilter.ts` predates this module and retains its own inline finite
 * checks. Any consolidation must route through `coerceNumeric` so the
 * sentinel-string rules stay defined in exactly one place.
 */

export function coerceNumeric(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const lower = trimmed.toLowerCase();
    if (lower === 'nan' || lower === 'infinity' || lower === '-infinity' || lower === '+infinity') {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Buffer-writer variant for hot projection loops: coerces `value` and writes
 * it at `target[index]`, falling back to `fallback` when coercion yields
 * null. Returns true iff the caller's value was admitted (false = fallback
 * was written).
 *
 * The fallback itself is hygiene-checked (a non-finite fallback writes 0) so
 * NaN cannot reach the buffer through EITHER argument. Allocation-free.
 */
export function coerceNumericInto(
  target: Float32Array,
  index: number,
  value: unknown,
  fallback: number,
): boolean {
  const coerced = coerceNumeric(value);
  if (coerced === null) {
    target[index] = Number.isFinite(fallback) ? fallback : 0;
    return false;
  }
  target[index] = coerced;
  return true;
}
