/**
 * Arrow entry: IPC bytes and Table inputs produce the same prepared
 * output as the rows lane (fingerprint aside — format participates), plus
 * the missing-optional-dependency error path via the _internals seam.
 */

import { tableFromArrays, tableToIPC, type Table } from 'apache-arrow';
import { afterEach, describe, expect, it } from 'vitest';
import { _internals, prepareArrowGraphData, type ArrowTableLike } from '../src/arrow';
import { prepareGraphData } from '../src/index';
import {
  PARITY_EXPECTED_SNAPSHOT,
  PARITY_EXPECTED_SUMMARIES,
  PARITY_MAPPING,
  PARITY_OPTIONS,
} from './helpers';

const realImport = _internals.importArrow;
afterEach(() => {
  _internals.importArrow = realImport;
});

const asLike = (table: Table): ArrowTableLike => table as unknown as ArrowTableLike;

// Plain arrays (not typed arrays) so `null` becomes a REAL arrow null.
function parityNodesTable(): Table {
  return tableFromArrays({
    id: ['a', 'b', 'c'],
    label: ['Alpha', 'Beta', 'Gamma'],
    size: [1.5, 2, null] as unknown as number[],
    group: ['x', 'y', 'x'],
  });
}

function parityEdgesTable(): Table {
  return tableFromArrays({
    id: ['e1', 'e2', null] as unknown as string[],
    source: ['a', 'b', 'c'],
    target: ['b', 'c', 'a'],
    weight: [0.5, 1.25, 2],
    kind: ['follows', 'follows', 'likes'],
  });
}

describe('prepareArrowGraphData', () => {
  it('matches the rows lane from Table inputs', async () => {
    const prepared = await prepareArrowGraphData(
      { nodes: asLike(parityNodesTable()), edges: asLike(parityEdgesTable()) },
      PARITY_MAPPING,
      PARITY_OPTIONS,
    );
    expect(prepared.snapshot).toEqual(PARITY_EXPECTED_SNAPSHOT);
    expect(prepared.summaries).toEqual(PARITY_EXPECTED_SUMMARIES);
  });

  it('matches the rows lane from IPC bytes through every byte-source shape', async () => {
    const nodeBytes = tableToIPC(parityNodesTable());
    const edgeBytes = tableToIPC(parityEdgesTable());
    const prepared = await prepareArrowGraphData(
      {
        nodes: nodeBytes.buffer.slice(
          nodeBytes.byteOffset,
          nodeBytes.byteOffset + nodeBytes.byteLength,
        ) as ArrayBuffer,
        edges: (async function* () {
          // chunked async byte delivery
          yield edgeBytes.subarray(0, 64);
          yield edgeBytes.subarray(64);
        })(),
      },
      PARITY_MAPPING,
      PARITY_OPTIONS,
    );
    expect(prepared.snapshot).toEqual(PARITY_EXPECTED_SNAPSHOT);
    expect(prepared.summaries).toEqual(PARITY_EXPECTED_SUMMARIES);

    const fromRows = await prepareGraphData(
      {
        nodes: PARITY_EXPECTED_SNAPSHOT.nodes.map((n) => ({ id: n.id, ...n.attrs })),
        edges: PARITY_EXPECTED_SNAPSHOT.edges.map((e) => ({
          ...('id' in e && e.id !== undefined ? { id: e.id } : {}),
          source: e.source,
          target: e.target,
          ...e.attrs,
        })),
      },
      PARITY_MAPPING,
      PARITY_OPTIONS,
    );
    // Same mapping and columns; only the format label differs.
    expect(prepared.mappingFingerprint).not.toBe(fromRows.mappingFingerprint);
    expect(prepared.snapshot).toEqual(fromRows.snapshot);
  });

  it('supports deriveNodes', async () => {
    const prepared = await prepareArrowGraphData(
      { edges: asLike(parityEdgesTable()), deriveNodes: true },
      { edges: PARITY_MAPPING.edges },
      PARITY_OPTIONS,
    );
    expect(prepared.snapshot.nodes).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  });

  it('normalizes bigint columns to safe numbers', async () => {
    const nodes = tableFromArrays({
      id: ['a', 'b'],
      views: BigInt64Array.from([10n, 20n]),
    });
    const edges = tableFromArrays({ source: ['a'], target: ['b'] });
    const prepared = await prepareArrowGraphData(
      { nodes: asLike(nodes), edges: asLike(edges) },
      { nodes: { id: 'id' }, edges: { source: 'source', target: 'target' } },
      PARITY_OPTIONS,
    );
    expect(prepared.snapshot.nodes).toEqual([
      { id: 'a', attrs: { views: 10 } },
      { id: 'b', attrs: { views: 20 } },
    ]);
    expect(prepared.summaries.nodes['views']).toMatchObject({ min: 10, max: 20 });
  });

  it('preserves an Arrow schema column literally named __proto__ as own data', async () => {
    const table = (
      columns: ReadonlyArray<readonly [string, unknown]>,
    ): ArrowTableLike => ({
      numRows: 1,
      schema: { fields: columns.map(([name]) => ({ name })) },
      getChild: (name) => {
        const entry = columns.find(([column]) => column === name);
        return entry === undefined ? null : { get: () => entry[1] };
      },
    });
    const nodes = table([
      ['id', 'a'],
      ['__proto__', { evil: true }],
    ]);
    const edges = table([
      ['source', 'a'],
      ['target', 'a'],
    ]);

    const prepared = await prepareArrowGraphData(
      { nodes, edges },
      { nodes: { id: 'id' }, edges: { source: 'source', target: 'target' } },
      PARITY_OPTIONS,
    );
    const attrs = prepared.snapshot.nodes[0]!.attrs as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(attrs, '__proto__')).toBe(true);
    expect(attrs['__proto__']).toEqual({ evil: true });
    expect((attrs as { evil?: unknown }).evil).toBeUndefined();
    expect(Object.getPrototypeOf(attrs)).toBe(Object.prototype);
  });

  it('reports a clear install hint when apache-arrow is absent', async () => {
    _internals.importArrow = () =>
      Promise.reject(
        Object.assign(new Error("Cannot find package 'apache-arrow'"), {
          code: 'ERR_MODULE_NOT_FOUND',
        }),
      );
    await expect(
      prepareArrowGraphData(
        { edges: new ArrayBuffer(0), deriveNodes: true },
        { edges: { source: 's', target: 't' } },
        PARITY_OPTIONS,
      ),
    ).rejects.toThrow(/optional peer dependency 'apache-arrow'[\s\S]*pnpm add apache-arrow/);
  });
});
