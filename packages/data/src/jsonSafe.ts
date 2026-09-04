/**
 * Shared JSON-safe value normalization for the optional format parsers:
 * Arrow/Parquet scalar decoding surfaces BigInt, and LIST/
 * STRUCT columns surface arrays/objects whose LEAVES can be BigInt — a
 * shallow pass broke the promised JSON-safe `serializePrepared` path.
 * Safe integers become numbers, the rest become strings, containers
 * recurse; '__proto__' keys land as own properties (never the setter).
 */
export function normalizeJsonSafeValue(
  value: unknown,
  materialize?: (value: object) => unknown,
): unknown {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value === null || typeof value !== 'object') return value;
  if (materialize !== undefined) {
    const plain = materialize(value);
    if (plain !== value) return normalizeJsonSafeValue(plain, materialize);
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonSafeValue(item, materialize));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, {
        value: normalizeJsonSafeValue(v, materialize),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}
