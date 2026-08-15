/**
 * serializable field descriptors — the worker-lane
 * accessor forms: `FieldAccessor` + `SerializableTransform` + the `field`
 * manual-schema helper. Descriptors are DATA, never code: they cross the
 * worker boundary by structured clone, compare by canonical structural
 * value, and unknown transform ops are validation errors (spec: "descriptors
 * are never evaluated as code").
 *
 * This module ships the building blocks and their evaluation semantics; the
 * styling-accessor unions widen to accept descriptor forms in the wave that
 * makes projection consume them (accepting a form the projector ignores
 * would be a silent no-op, worse than absence).
 *
 * Path semantics (v1, deliberately flat): a path addresses `attrs[path]`,
 * with the FilterExpr convention that the literal `'id'` reads the entity
 * id. No dot traversal — columnar snapshots are flat columns, and the
 * prepared-data mapping validation rejects a missing column before
 * projection ever runs.
 */

import type { JsonValue } from './types';

/** Branded attr path — `field<A,T>` is a manual-schema ASSERTION for
 * compile-time narrowing in codegen/schema packages, not runtime validation. */
export type TypedFieldPath<A, T> = string & {
  readonly __attrs?: A;
  readonly __value?: T;
};

export function field<A, T>(path: string): TypedFieldPath<A, T> {
  return path as TypedFieldPath<A, T>;
}

/** transform whitelist. Closed set — extending it is a spec amendment. */
export type SerializableTransform =
  | { op: 'identity' }
  | { op: 'number' }
  | { op: 'lowercase' }
  | { op: 'date-to-epoch-ms' }
  | { op: 'coalesce'; value: JsonValue };

export interface FieldAccessor<A, T> {
  field: TypedFieldPath<A, T>;
  transform?: SerializableTransform;
}

const TRANSFORM_OPS = new Set(['identity', 'number', 'lowercase', 'date-to-epoch-ms', 'coalesce']);

/** Reasons a candidate failed `validateFieldAccessor` (typed, no throw). */
export type DescriptorIssue =
  | { kind: 'not-an-object' }
  | { kind: 'field-not-a-string' }
  | { kind: 'unknown-transform-op'; op: string }
  | { kind: 'transform-not-an-object' }
  | { kind: 'coalesce-missing-value' };

/**
 * Structural guard: is this value SHAPED like a FieldAccessor? Deliberately
 * strict about the transform whitelist (unknown ops are errors, not
 * passthroughs) and deliberately loose about extra keys (forward-compatible
 * clone targets). Functions are never descriptors.
 */
export function validateFieldAccessor(value: unknown): DescriptorIssue | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'not-an-object' };
  }
  const candidate = value as { field?: unknown; transform?: unknown };
  if (typeof candidate.field !== 'string') return { kind: 'field-not-a-string' };
  if (candidate.transform !== undefined) {
    const t = candidate.transform;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      return { kind: 'transform-not-an-object' };
    }
    const op = (t as { op?: unknown }).op;
    if (typeof op !== 'string' || !TRANSFORM_OPS.has(op)) {
      return { kind: 'unknown-transform-op', op: String(op) };
    }
    if (op === 'coalesce' && !('value' in (t as object))) {
      return { kind: 'coalesce-missing-value' };
    }
  }
  return null;
}

export function isFieldAccessor(value: unknown): value is FieldAccessor<unknown, unknown> {
  return validateFieldAccessor(value) === null;
}

/**
 * Canonical structural fingerprint (spec: descriptors "compare by canonical
 * structural value, invalidate only their dependent channel"). Stable across
 * key order and object identity; usable as a channel-invalidation key on
 * both sides of the worker boundary.
 */
export function descriptorKey(accessor: FieldAccessor<unknown, unknown>): string {
  const t = accessor.transform;
  if (t === undefined) return `f:${accessor.field}|identity`;
  if (t.op === 'coalesce') return `f:${accessor.field}|coalesce:${JSON.stringify(t.value ?? null)}`;
  return `f:${accessor.field}|${t.op}`;
}

/**
 * -"Value handling" coercions: attrs are JSON-ish and lossy encodings are
 * expected — every numeric/temporal consumption coerces non-finite values
 * (including the "NaN"/"Infinity" string sentinels) to null rather than
 * NaN-poisoning downstream bins/domains/buffers.
 */
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coerceEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * Evaluate a descriptor against an entity's `(id, attrs)` — the pure
 * function both lanes share (byte-exact parity starts with ONE
 * evaluation implementation, imported by both threads, never duplicated).
 */
export function evaluateFieldAccessor(
  accessor: FieldAccessor<unknown, unknown>,
  id: string,
  attrs: Readonly<Record<string, unknown>> | undefined,
): unknown {
  const raw = accessor.field === 'id' ? id : attrs?.[accessor.field];
  const t = accessor.transform;
  if (t === undefined || t.op === 'identity') return raw;
  switch (t.op) {
    case 'number':
      return coerceNumber(raw);
    case 'lowercase':
      return typeof raw === 'string' ? raw.toLowerCase() : null;
    case 'date-to-epoch-ms':
      return coerceEpochMs(raw);
    case 'coalesce':
      return raw === null || raw === undefined ? t.value : raw;
  }
}
