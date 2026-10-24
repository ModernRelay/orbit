import { readFileSync } from 'node:fs';
import { tableFromArrays, tableToIPC } from 'apache-arrow';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { columnarArrayBuffers, materializeColumnarSnapshot, validateColumnarStructure, validateSnapshot } from '@modernrelay/orbit-core';
import type { GraphSnapshot } from '@modernrelay/orbit-core';
import { prepareGraphData, serializePrepared, loadPrepared } from '../src/index';
import type { PreparedColumnarGraph, PreparedGraph } from '../src/index';
import { prepareArrowGraphData } from '../src/arrow';
import { prepareParquetGraphData } from '../src/parquet';
import {
  PARITY_MAPPING as mapping, PARITY_OPTIONS as options, PARITY_NODE_ROWS, PARITY_EDGE_ROWS,
  PARITY_NODES_CSV, PARITY_EDGES_CSV, PARITY_DOCUMENT,
} from './helpers';

const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

/** Columnar null bits intentionally normalize absent attrs into explicit null. */
function normalizedObject(prepared: PreparedGraph): GraphSnapshot {
  const fill = (attrs: Record<string, unknown> | undefined, names: string[]) =>
    Object.fromEntries(names.map((name) => [name, attrs?.[name] ?? null]));
  return {
    ...prepared.snapshot,
    nodes: prepared.snapshot.nodes.map((row) => ({ ...row, attrs: fill(row.attrs, Object.keys(prepared.summaries.nodes)) })),
    edges: prepared.snapshot.edges.map((row) => ({ ...row, attrs: fill(row.attrs, Object.keys(prepared.summaries.edges)) })),
  };
}

function assertParity(object: PreparedGraph, columnar: PreparedColumnarGraph): void {
  expect(validateColumnarStructure(columnar.snapshot)).toEqual([]);
  const decoded = materializeColumnarSnapshot(columnar.snapshot);
  const expected = validateSnapshot(normalizedObject(object));
  const actual = validateSnapshot(decoded);
  expect(actual.nodes).toEqual(expected.nodes);
  expect(actual.edges).toEqual(expected.edges);
  expect(columnar.summaries).toEqual(object.summaries);
  expect(columnar.mappingFingerprint).toBe(object.mappingFingerprint);
}

describe('opt-in columnar preparation', () => {
  it.each(['rows', 'csv', 'json'] as const)('matches object values, identities and summaries for %s', async (format) => {
    const input = format === 'rows' ? { nodes: PARITY_NODE_ROWS, edges: PARITY_EDGE_ROWS }
      : format === 'csv' ? { nodes: bytes(PARITY_NODES_CSV), edges: bytes(PARITY_EDGES_CSV) }
      : { document: bytes(PARITY_DOCUMENT) };
    const selected = { ...mapping, ...(format === 'json' ? { documentPaths: { nodes: 'graph.nodes', edges: 'graph.links' } } : {}) };
    const object = await prepareGraphData(input, selected, { ...options, format });
    const columnar = await prepareGraphData(input, selected, { ...options, format, output: 'columnar' });
    expectTypeOf(object).toEqualTypeOf<PreparedGraph>();
    expectTypeOf(columnar).toEqualTypeOf<PreparedColumnarGraph>();
    assertParity(object, columnar);
    expect(loadPrepared(serializePrepared(object))).toEqual(object);
  });

  it('supports real Arrow IPC and tables without borrowing or detaching source buffers', async () => {
    const nodes = tableFromArrays({ id: ['a', 'b'], score: [1, 2], active: [true, false], empty: [null, null] });
    const edgeTable = tableFromArrays({ source: ['a', 'b'], target: ['b', 'a'], kind: ['x', 'y'] });
    const wire = tableToIPC(edgeTable);
    const edgeBytes = wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength) as ArrayBuffer;
    const input = { nodes, edges: edgeBytes };
    const object = await prepareArrowGraphData(input, mapping, options);
    const columnar = await prepareArrowGraphData(input, mapping, { ...options, output: 'columnar' });
    assertParity(object, columnar);
    expect(columnar.snapshot.bufferOwnership).toBe('borrowed');
    const copied = structuredClone(columnar.snapshot, { transfer: columnarArrayBuffers(columnar.snapshot) });
    expect(validateColumnarStructure(copied)).toEqual([]);
    expect(edgeBytes.byteLength).toBe(wire.byteLength);
    expect(nodes.getChild('score')?.get(0)).toBe(1);
  });

  it('supports real Parquet fixtures with the same summaries and synthesized edge IDs', async () => {
    const fixture = (name: string) => {
      const data = readFileSync(new URL(`./fixtures/parity-${name}.parquet`, import.meta.url));
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    };
    const input = { nodes: fixture('nodes'), edges: fixture('edges') };
    assertParity(await prepareParquetGraphData(input, mapping, options),
      await prepareParquetGraphData(input, mapping, { ...options, output: 'columnar' }));
  });

  it('preserves collision-safe synthesized IDs, explicit IDs, parallel edges and duplicate node semantics', async () => {
    const input = {
      nodes: [{ id: 'a→b' }, { id: 'c#0' }, { id: 'a→b' }],
      edges: [
        { source: 'a→b', target: 'c#0' }, { source: 'a→b', target: 'c#0' },
        { id: 'explicit', source: 'a→b', target: 'c#0' },
      ],
    };
    assertParity(await prepareGraphData(input, mapping, options),
      await prepareGraphData(input, mapping, { ...options, output: 'columnar' }));
  });

  it('handles derived nodes, empty inputs, late fields, null masks and selected attributes', async () => {
    const input = { edges: [
      { source: 'a', target: 'b', score: null },
      { source: 'b', target: 'c', score: 3, later: true },
      { source: 'c', target: 'a', score: null, later: false },
    ], deriveNodes: true as const };
    const selected = { edges: { source: 'source', target: 'target', includeFields: ['score', 'later'] } };
    const result = await prepareGraphData(input, selected, { ...options, output: 'columnar' });
    assertParity(await prepareGraphData(input, selected, options), result);
    expect(result.snapshot.edges.columns.score).toMatchObject({ kind: 'f64', nulls: new Uint8Array([1, 0, 1]) });
    expect(result.snapshot.edges.columns.later).toMatchObject({ kind: 'bool', data: new Uint8Array([0, 1, 0]), nulls: new Uint8Array([1, 0, 0]) });
    const empty = await prepareGraphData({ nodes: [], edges: [] }, mapping, { ...options, output: 'columnar' });
    expect(validateColumnarStructure(empty.snapshot)).toEqual([]);
  });

  it.each([
    [{ id: 'a', attr: { nested: 1 } }], [{ id: 'a', attr: ['x'] }],
    [{ id: 'a', attr: '1' }, { id: 'b', attr: 1 }],
    [JSON.parse('{"id":"a","__proto__":3}') as Record<string, unknown>],
  ].map((nodes) => ({ nodes })))('rejects unrepresentable attributes with an explicit object-output remedy', async ({ nodes }) => {
    await expect(prepareGraphData({ nodes, edges: [] }, mapping, { ...options, output: 'columnar' })).rejects.toThrow(/output:'object'/);
  });

  it('rejects missing endpoints instead of emitting corrupt typed indices', async () => {
    await expect(prepareGraphData({ nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'missing' }] }, mapping,
      { ...options, output: 'columnar' })).rejects.toThrow(/unknown endpoint.*missing/);
  });

  it('rejects columnar data at the v1 artifact boundary for JavaScript callers too', async () => {
    const prepared = await prepareGraphData({ nodes: [], edges: [] }, mapping, { ...options, output: 'columnar' });
    // @ts-expect-error The v1 artifact API intentionally accepts object output only.
    expect(() => serializePrepared(prepared)).toThrow(/v1 artifacts require output:'object'/);
  });
});
