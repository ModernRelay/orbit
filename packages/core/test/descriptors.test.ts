/**
 * serializable field descriptors: the transform
 * whitelist is CLOSED (unknown ops are validation errors, never
 * passthroughs), evaluation applies the JSON-ish coercion rules: lossy
 * encodings coerce to null, never NaN-poison, and
 * canonical keys compare by structural value across identity and key order.
 */

import { describe, expect, it } from 'vitest';

import {
  descriptorKey,
  evaluateFieldAccessor,
  field,
  isFieldAccessor,
  validateFieldAccessor,
} from '../src/descriptors';
import type { FieldAccessor } from '../src/descriptors';

const fa = (path: string, transform?: FieldAccessor<unknown, unknown>['transform']) =>
  ({ field: field(path), ...(transform !== undefined ? { transform } : {}) }) as FieldAccessor<
    unknown,
    unknown
  >;

describe('validation (descriptors are data, never code)', () => {
  it('accepts every whitelisted transform op', () => {
    for (const transform of [
      undefined,
      { op: 'identity' as const },
      { op: 'number' as const },
      { op: 'lowercase' as const },
      { op: 'date-to-epoch-ms' as const },
      { op: 'coalesce' as const, value: 0 },
    ]) {
      expect(validateFieldAccessor(fa('score', transform))).toBeNull();
    }
  });

  it('REJECTS unknown transform ops — extension is a spec amendment, not a passthrough', () => {
    expect(validateFieldAccessor({ field: 'score', transform: { op: 'uppercase' } })).toEqual({
      kind: 'unknown-transform-op',
      op: 'uppercase',
    });
    // The classic injection shape: an op that names code is still just an
    // unknown string.
    expect(
      validateFieldAccessor({ field: 'score', transform: { op: 'eval' } }),
    ).toEqual({ kind: 'unknown-transform-op', op: 'eval' });
  });

  it('rejects functions, arrays, null, and non-string fields', () => {
    expect(isFieldAccessor(() => 'red')).toBe(false);
    expect(isFieldAccessor(null)).toBe(false);
    expect(isFieldAccessor(['field'])).toBe(false);
    expect(isFieldAccessor({ field: 7 })).toBe(false);
    expect(validateFieldAccessor({ field: 7 })).toEqual({ kind: 'field-not-a-string' });
  });

  it('coalesce requires an explicit value key', () => {
    expect(validateFieldAccessor({ field: 'x', transform: { op: 'coalesce' } })).toEqual({
      kind: 'coalesce-missing-value',
    });
    // null IS a legal coalesce value — present but null passes.
    expect(
      validateFieldAccessor({ field: 'x', transform: { op: 'coalesce', value: null } }),
    ).toBeNull();
  });
});

describe('evaluation through the one implementation both lanes import', () => {
  const attrs = {
    score: 41.5,
    label: 'Alpha CLUSTER',
    created: '2026-03-01T12:00:00.000Z',
    bad: 'NaN',
    missing: null,
  };

  it("reads attrs[path], with 'id' addressing the entity id (FilterExpr convention)", () => {
    expect(evaluateFieldAccessor(fa('score'), 'n1', attrs)).toBe(41.5);
    expect(evaluateFieldAccessor(fa('id'), 'n1', attrs)).toBe('n1');
    expect(evaluateFieldAccessor(fa('absent'), 'n1', attrs)).toBeUndefined();
    expect(evaluateFieldAccessor(fa('score'), 'n1', undefined)).toBeUndefined();
  });

  it('number coerces JSON-ish junk to null, never NaN', () => {
    expect(evaluateFieldAccessor(fa('score', { op: 'number' }), 'n1', attrs)).toBe(41.5);
    // The Omnigraph string sentinel class: "NaN"/"Infinity" → null.
    expect(evaluateFieldAccessor(fa('bad', { op: 'number' }), 'n1', attrs)).toBeNull();
    expect(evaluateFieldAccessor(fa('label', { op: 'number' }), 'n1', attrs)).toBeNull();
    expect(evaluateFieldAccessor(fa('missing', { op: 'number' }), 'n1', attrs)).toBeNull();
    expect(
      evaluateFieldAccessor(fa('x', { op: 'number' }), 'n1', { x: Infinity }),
    ).toBeNull();
    expect(evaluateFieldAccessor(fa('x', { op: 'number' }), 'n1', { x: '12.5' })).toBe(12.5);
  });

  it('date-to-epoch-ms parses ISO strings and passes finite numbers through', () => {
    expect(evaluateFieldAccessor(fa('created', { op: 'date-to-epoch-ms' }), 'n1', attrs)).toBe(
      Date.parse('2026-03-01T12:00:00.000Z'),
    );
    expect(
      evaluateFieldAccessor(fa('x', { op: 'date-to-epoch-ms' }), 'n1', { x: 1_700_000_000_000 }),
    ).toBe(1_700_000_000_000);
    expect(evaluateFieldAccessor(fa('label', { op: 'date-to-epoch-ms' }), 'n1', attrs)).toBeNull();
  });

  it('lowercase applies to strings only; coalesce fills null/undefined only', () => {
    expect(evaluateFieldAccessor(fa('label', { op: 'lowercase' }), 'n1', attrs)).toBe(
      'alpha cluster',
    );
    expect(evaluateFieldAccessor(fa('score', { op: 'lowercase' }), 'n1', attrs)).toBeNull();
    expect(evaluateFieldAccessor(fa('missing', { op: 'coalesce', value: 7 }), 'n1', attrs)).toBe(7);
    expect(evaluateFieldAccessor(fa('absent', { op: 'coalesce', value: 7 }), 'n1', attrs)).toBe(7);
    // Falsy-but-present values are NOT coalesced.
    expect(evaluateFieldAccessor(fa('x', { op: 'coalesce', value: 7 }), 'n1', { x: 0 })).toBe(0);
  });
});

describe('canonical keys (compare by structural value, not identity)', () => {
  it('equal structure → equal key, across identity and key order', () => {
    const a = { field: 'score', transform: { op: 'number' } } as FieldAccessor<unknown, number>;
    const b = { transform: { op: 'number' }, field: 'score' } as unknown as FieldAccessor<
      unknown,
      number
    >;
    expect(descriptorKey(a)).toBe(descriptorKey(b));
    expect(descriptorKey(fa('score'))).toBe(descriptorKey(fa('score', { op: 'identity' })));
  });

  it('different field, op, or coalesce value → different key', () => {
    expect(descriptorKey(fa('a'))).not.toBe(descriptorKey(fa('b')));
    expect(descriptorKey(fa('a', { op: 'number' }))).not.toBe(
      descriptorKey(fa('a', { op: 'lowercase' })),
    );
    expect(descriptorKey(fa('a', { op: 'coalesce', value: 1 }))).not.toBe(
      descriptorKey(fa('a', { op: 'coalesce', value: 2 })),
    );
  });
});
