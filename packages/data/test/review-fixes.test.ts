/**
 * Data-package regression coverage: a first yielded undefined is malformed
 * row zero (not an empty
 * source), peeked iterators close on early exit AND validation failure,
 * '__proto__' row keys land as own properties (never the prototype setter),
 * and Arrow/Parquet BigInt normalization reaches nested list/struct leaves.
 */

import { describe, expect, it } from 'vitest';

import { peekAsyncIterable } from '../src/sources';
import { normalizeJsonSafeValue } from '../src/jsonSafe';
import { prepareGraphData, serializePrepared } from '../src/index';
import { PARITY_MAPPING, PARITY_OPTIONS } from './helpers';

async function* yields(...values: unknown[]): AsyncGenerator<unknown> {
  for (const v of values) yield v;
}

const NODE_MAPPING = PARITY_MAPPING; // node+edge mapping; the edges lanes here are empty

describe('first-row undefined vs completed source', () => {
  it('peek distinguishes done from a yielded undefined', async () => {
    const empty = await peekAsyncIterable(yields());
    expect(empty.done).toBe(true);

    const undef = await peekAsyncIterable(yields(undefined, { id: 'a' }));
    expect(undef.done).toBe(false);
    expect(undef.first).toBeUndefined();
  });

  it('a yielded undefined first row REPORTS malformed row zero instead of silently emptying', async () => {
    await expect(
      prepareGraphData(
        { nodes: yields(undefined, { id: 'a' }), edges: [] },
        NODE_MAPPING,
        PARITY_OPTIONS,
      ),
    ).rejects.toThrow(/plain row objects.*got undefined/s);
  });
});

describe('peeked iterators close on failure and early exit', () => {
  it('a validation throw closes the underlying source (finally runs)', async () => {
    let closed = false;
    async function* source(): AsyncGenerator<unknown> {
      try {
        yield 42; // not a plain row object → validation throws
        yield { id: 'never' };
      } finally {
        closed = true;
      }
    }
    await expect(
      prepareGraphData({ nodes: source(), edges: [] }, NODE_MAPPING, PARITY_OPTIONS),
    ).rejects.toThrow(/plain row objects/);
    expect(closed).toBe(true);
  });

  it('an early-exit consumer of the peeked rest closes the source', async () => {
    let closed = false;
    async function* source(): AsyncGenerator<unknown> {
      try {
        yield { id: 'a' };
        yield { id: 'b' };
        yield { id: 'c' };
      } finally {
        closed = true;
      }
    }
    const { rest } = await peekAsyncIterable(source());
    for await (const row of rest) {
      void row;
      break; // early exit — return() must forward to the source
    }
    expect(closed).toBe(true);
  });
});

describe("'__proto__' keys land as own properties", () => {
  it('a JSON row with __proto__ keeps the field and a clean prototype', async () => {
    // JSON.parse creates __proto__ as an OWN key — the exact NDJSON shape.
    const row = JSON.parse('{"id":"a","__proto__":{"evil":1},"ok":2}') as Record<string, unknown>;
    const prepared = await prepareGraphData({ nodes: [row], edges: [] }, NODE_MAPPING, PARITY_OPTIONS);
    const node = prepared.snapshot.nodes[0]!;
    const attrs = node.attrs as Record<string, unknown>;
    expect(attrs.ok).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(attrs, '__proto__')).toBe(true);
    expect((attrs as { evil?: unknown }).evil).toBeUndefined(); // prototype NOT swapped
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype);
  });
});

describe('deep BigInt normalization in the Arrow/Parquet shared utility', () => {
  it('reaches list/struct leaves; safe integers become numbers, wide ones strings', () => {
    const nested = normalizeJsonSafeValue({
      scalar: 7n,
      wide: 2n ** 60n,
      list: [1n, [2n]],
      struct: { deep: { v: 3n } },
      plain: 'x',
    }) as Record<string, unknown>;
    expect(nested.scalar).toBe(7);
    expect(nested.wide).toBe((2n ** 60n).toString());
    expect(nested.list).toEqual([1, [2]]);
    expect(nested.struct).toEqual({ deep: { v: 3 } });
    expect(() => JSON.stringify(nested)).not.toThrow();
  });
});

describe('serializePrepared stays JSON-safe with prepared attrs', () => {
  it('prepared output with nested structures serializes', async () => {
    const prepared = await prepareGraphData(
      { nodes: [{ id: 'a', nested: { list: [1, 2], deep: { x: 'y' } } }], edges: [] },
      NODE_MAPPING,
      PARITY_OPTIONS,
    );
    expect(() => serializePrepared(prepared)).not.toThrow();
  });
});
