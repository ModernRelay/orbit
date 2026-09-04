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

  it('preserves a CSV header literally named __proto__', async () => {
    const enc = new TextEncoder();
    const prepared = await prepareGraphData(
      {
        nodes: enc.encode('id,__proto__\na,safe\n').buffer as ArrayBuffer,
        edges: enc.encode('source,target\na,a\n').buffer as ArrayBuffer,
      },
      NODE_MAPPING,
      { ...PARITY_OPTIONS, format: 'csv' },
    );
    const attrs = prepared.snapshot.nodes[0]!.attrs as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(attrs, '__proto__')).toBe(true);
    expect(attrs['__proto__']).toBe('safe');
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype);
  });
});

describe('async source cleanup across preparation failures', () => {
  function hostileIterator<T>(
    values: readonly T[],
    state: { returns: number },
    options: {
      rejectAfterValues?: boolean;
      rejectReturn?: boolean;
      rejectSecondReturn?: boolean;
    } = {},
  ): AsyncIterable<T> {
    let index = 0;
    const iterator: AsyncIterableIterator<T> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        if (index < values.length) return { done: false as const, value: values[index++]! };
        if (options.rejectAfterValues) throw new Error('source next failed');
        return { done: true as const, value: undefined };
      },
      async return() {
        state.returns++;
        if (options.rejectReturn || (options.rejectSecondReturn && state.returns > 1)) {
          throw new Error('source return failed');
        }
        return { done: true as const, value: undefined };
      },
    };
    return iterator;
  }

  function tracked<T>(values: readonly T[], state: { closed: boolean }): AsyncIterable<T> {
    return (async function* () {
      try {
        for (const value of values) yield value;
      } finally {
        state.closed = true;
      }
    })();
  }

  it('closes both row sources when mapping validation fails after column peeks', async () => {
    const nodes = { closed: false };
    const edges = { closed: false };
    await expect(
      prepareGraphData(
        {
          nodes: tracked([{ wrong: 'a' }, { wrong: 'b' }], nodes),
          edges: tracked(
            [
              { source: 'a', target: 'b' },
              { source: 'b', target: 'a' },
            ],
            edges,
          ),
        },
        NODE_MAPPING,
        PARITY_OPTIONS,
      ),
    ).rejects.toThrow(/node id column "id" not found/);
    expect(nodes.closed).toBe(true);
    expect(edges.closed).toBe(true);
  });

  it('closes the failing edge row source and the unopened node materialization', async () => {
    const nodes = { closed: false };
    const edges = { closed: false };
    await expect(
      prepareGraphData(
        {
          nodes: tracked([{ id: 'a' }, { id: 'b' }], nodes),
          edges: tracked(
            [
              { source: null, target: 'a' },
              { source: 'a', target: 'b' },
            ],
            edges,
          ),
        },
        NODE_MAPPING,
        PARITY_OPTIONS,
      ),
    ).rejects.toThrow(/edge source.*row 0/);
    expect(nodes.closed).toBe(true);
    expect(edges.closed).toBe(true);
  });

  function trackedCsv(text: string, state: { closed: boolean }): AsyncIterable<Uint8Array> {
    return (async function* () {
      try {
        yield new TextEncoder().encode(text);
        yield new Uint8Array(); // keep the source suspended until its consumer advances
      } finally {
        state.closed = true;
      }
    })();
  }

  it('closes both CSV byte sources when header-based mapping validation fails', async () => {
    const nodes = { closed: false };
    const edges = { closed: false };
    await expect(
      prepareGraphData(
        {
          nodes: trackedCsv('wrong\na\n', nodes),
          edges: trackedCsv('source,target\na,a\n', edges),
        },
        NODE_MAPPING,
        { ...PARITY_OPTIONS, format: 'csv' },
      ),
    ).rejects.toThrow(/node id column "id" not found/);
    expect(nodes.closed).toBe(true);
    expect(edges.closed).toBe(true);
  });

  it('closes sampled CSV sources when the first materialized identity is invalid', async () => {
    const nodes = { closed: false };
    const edges = { closed: false };
    // Keep csvTable in its 1,000-row sample replay when the builder rejects
    // row zero; the private csvRecords iterator must still receive return().
    const invalidEdges = `source,target\n${',a\n'.repeat(1000)}`;
    await expect(
      prepareGraphData(
        {
          nodes: trackedCsv('id\na\n', nodes),
          edges: trackedCsv(invalidEdges, edges),
        },
        NODE_MAPPING,
        { ...PARITY_OPTIONS, format: 'csv' },
      ),
    ).rejects.toThrow(/edge source.*row 0/);
    expect(nodes.closed).toBe(true);
    expect(edges.closed).toBe(true);
  });

  it('closes a row iterator when next() rejects during materialization', async () => {
    const state = { returns: 0 };
    await expect(
      prepareGraphData(
        {
          nodes: [{ id: 'a' }],
          edges: hostileIterator([{ source: 'a', target: 'a' }], state, {
            rejectAfterValues: true,
            rejectReturn: true,
          }),
        },
        NODE_MAPPING,
        { ...PARITY_OPTIONS, format: 'rows' },
      ),
    ).rejects.toThrow(/source next failed/); // builder cleanup must not replace the read failure
    expect(state.returns).toBe(1);
  });

  it('keeps a node-resolution failure when closing the already-open edge lane also rejects', async () => {
    const nodes = { returns: 0 };
    const edges = { returns: 0 };
    await expect(
      prepareGraphData(
        {
          nodes: hostileIterator([], nodes, {
            rejectAfterValues: true,
            rejectReturn: true,
          }),
          edges: hostileIterator([{ source: 'a', target: 'a' }], edges, {
            rejectReturn: true,
          }),
        },
        NODE_MAPPING,
        PARITY_OPTIONS,
      ),
    ).rejects.toThrow(/source next failed/);
    expect(nodes.returns).toBe(1);
    expect(edges.returns).toBe(1);
  });

  it('closes the original iterator when inference fails on its first next()', async () => {
    const state = { returns: 0 };
    await expect(
      prepareGraphData(
        {
          nodes: [{ id: 'a' }],
          edges: hostileIterator([], state, {
            rejectAfterValues: true,
            rejectReturn: true,
          }),
        },
        NODE_MAPPING,
        PARITY_OPTIONS,
      ),
    ).rejects.toThrow(/source next failed/); // teardown failure must not mask the read failure
    expect(state.returns).toBe(1);
  });

  it('keeps invalid-first-row diagnostics when explicit and inferred source teardown rejects', async () => {
    for (const format of ['rows', undefined] as const) {
      const state = { returns: 0 };
      await expect(
        prepareGraphData(
          {
            nodes: hostileIterator([42], state, { rejectReturn: true }),
            edges: [],
          },
          NODE_MAPPING,
          { ...PARITY_OPTIONS, ...(format === undefined ? {} : { format }) },
        ),
      ).rejects.toThrow(/plain row objects.*got number/s);
      expect(state.returns).toBe(1);
    }
  });

  it('closes a CSV byte iterator when its first next() rejects', async () => {
    const state = { returns: 0 };
    const nodes = new TextEncoder().encode('id\na\n').buffer as ArrayBuffer;
    await expect(
      prepareGraphData(
        {
          nodes,
          edges: hostileIterator<Uint8Array>([], state, { rejectAfterValues: true }),
        },
        NODE_MAPPING,
        { ...PARITY_OPTIONS, format: 'csv' },
      ),
    ).rejects.toThrow(/source next failed/);
    expect(state.returns).toBe(1);
  });

  it('never calls an arbitrary return() twice across builder and caller cleanup', async () => {
    const nodes = { returns: 0 };
    const edges = { returns: 0 };
    await expect(
      prepareGraphData(
        {
          nodes: hostileIterator([{ wrong: 'a' }, { wrong: 'b' }], nodes, {
            rejectSecondReturn: true,
          }),
          edges: hostileIterator(
            [
              { source: 'a', target: 'b' },
              { source: 'b', target: 'a' },
            ],
            edges,
            { rejectSecondReturn: true },
          ),
        },
        NODE_MAPPING,
        { ...PARITY_OPTIONS, format: 'rows' },
      ),
    ).rejects.toThrow(/node id column "id" not found/);
    expect(nodes.returns).toBe(1);
    expect(edges.returns).toBe(1);
  });
});

describe('deep BigInt normalization in the Arrow/Parquet shared utility', () => {
  it('recurses into null-prototype records and records with an own constructor', () => {
    const nested = Object.assign(Object.create(null) as Record<string, unknown>, { value: 7n });
    const source = Object.fromEntries([['constructor', 1n], ['__proto__', nested]]);
    const normalized = normalizeJsonSafeValue(source) as Record<string, unknown>;
    expect(normalized).toEqual(Object.fromEntries([['constructor', 1], ['__proto__', { value: 7 }]]));
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(normalized, '__proto__')).toBe(true);
  });

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

  it('rejects lossy values instead of silently replacing or omitting them', async () => {
    const make = () =>
      prepareGraphData(
        { nodes: [{ id: 'a', nested: { value: 1 } }], edges: [] },
        NODE_MAPPING,
        PARITY_OPTIONS,
      );

    for (const value of [NaN, Infinity, -Infinity]) {
      const prepared = await make();
      (prepared.snapshot.nodes[0]!.attrs as { nested: { value: unknown } }).nested.value = value;
      expect(() => serializePrepared(prepared)).toThrow(/not JSON-safe \(non-finite number\)/);
    }

    const withNonFiniteRevision = await make();
    withNonFiniteRevision.snapshot.sourceRevision = Infinity;
    expect(() => serializePrepared(withNonFiniteRevision)).toThrow(
      /sourceRevision.*not JSON-safe \(non-finite number\)/,
    );

    for (const sourceRevision of [null, true, {}, []]) {
      const prepared = await make();
      Object.assign(prepared.snapshot, { sourceRevision });
      expect(() => serializePrepared(prepared)).toThrow(
        /sourceRevision must be a string or finite number/,
      );
    }

    const withUndefined = await make();
    (withUndefined.snapshot.nodes[0]!.attrs as { nested: { value: unknown } }).nested.value =
      undefined;
    expect(() => serializePrepared(withUndefined)).toThrow(/not JSON-safe \(undefined value\)/);

    const withDate = await make();
    (withDate.snapshot.nodes[0]!.attrs as { nested: { value: unknown } }).nested.value = new Date();
    expect(() => serializePrepared(withDate)).toThrow(/not JSON-safe \(non-plain object\)/);
  });
});
