/**
 * Stable mapping/schema fingerprint.
 *
 * `mappingFingerprint = fnv1a64Hex(canonicalJson(mapping) + '\n' + format +
 * '\n' + canonicalJson(columns))` where `columns` is, per role, the ADMITTED
 * attr-field union (invariant I4, semantic fingerprint completeness): the
 * seeded schema columns (CSV header / Arrow-Parquet schema / first-row keys,
 * minus identity, filtered by `includeFields`) UNIONED with every field any
 * row actually materialized into attrs — collected by builder.ts during the
 * single materialization pass. The lists are sorted here, so field discovery
 * order never moves the fingerprint; canonical JSON sorts object keys
 * recursively so key-order-insensitive equal mappings fingerprint
 * identically.
 */

import type { GraphColumnMapping, GraphPrepareFormat } from './types';

/** Recursively key-sorted JSON. Only JSON-safe values are expected (mappings
 * and column lists are plain strings/arrays/objects). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return (
    '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(record[k])).join(',') + '}'
  );
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over the UTF-8 bytes of `text`, as a 16-char lowercase hex string. */
export function fnv1a64Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let hash = FNV_OFFSET;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

export function computeMappingFingerprint(
  mapping: GraphColumnMapping,
  format: GraphPrepareFormat,
  columns: { nodes: readonly string[]; edges: readonly string[] },
): string {
  const columnList = {
    nodes: [...columns.nodes].sort(),
    edges: [...columns.edges].sort(),
  };
  return fnv1a64Hex(
    canonicalJson(mapping) + '\n' + format + '\n' + canonicalJson(columnList),
  );
}
