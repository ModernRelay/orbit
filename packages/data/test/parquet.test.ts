/**
 * Parquet entry: parity against checked-in fixtures generated once from the
 * same logical parity dataset with
 * `duckdb COPY... (FORMAT PARQUET, COMPRESSION UNCOMPRESSED)`; see
 * test/fixtures/. Also covers the missing-optional-dependency error path via
 * the _internals seam.
 *
 * hyparquet IS workable in the vitest node environment (pure-JS reader), so
 * the parity test is real, not a todo.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { _internals, prepareParquetGraphData } from '../src/parquet';
import {
  PARITY_EXPECTED_SNAPSHOT,
  PARITY_EXPECTED_SUMMARIES,
  PARITY_MAPPING,
  PARITY_OPTIONS,
} from './helpers';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(path.join(FIXTURES, name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const realImport = _internals.importHyparquet;
afterEach(() => {
  _internals.importHyparquet = realImport;
});

describe('prepareParquetGraphData', () => {
  it('matches the parity dataset from duckdb-written fixtures', async () => {
    const prepared = await prepareParquetGraphData(
      {
        nodes: fixtureBytes('parity-nodes.parquet'),
        edges: fixtureBytes('parity-edges.parquet'),
      },
      PARITY_MAPPING,
      PARITY_OPTIONS,
    );
    expect(prepared.snapshot).toEqual(PARITY_EXPECTED_SNAPSHOT);
    expect(prepared.summaries).toEqual(PARITY_EXPECTED_SUMMARIES);
  });

  it('streams chunked bytes and supports deriveNodes', async () => {
    const bytes = new Uint8Array(fixtureBytes('parity-edges.parquet'));
    const prepared = await prepareParquetGraphData(
      {
        edges: (async function* () {
          yield bytes.subarray(0, 100);
          yield bytes.subarray(100);
        })(),
        deriveNodes: true,
      },
      { edges: PARITY_MAPPING.edges },
      PARITY_OPTIONS,
    );
    expect(prepared.snapshot.nodes).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(prepared.snapshot.edges).toEqual(PARITY_EXPECTED_SNAPSHOT.edges);
  });

  it('reports a clear install hint when hyparquet is absent', async () => {
    _internals.importHyparquet = () =>
      Promise.reject(
        Object.assign(new Error("Cannot find package 'hyparquet'"), {
          code: 'ERR_MODULE_NOT_FOUND',
        }),
      );
    await expect(
      prepareParquetGraphData(
        { edges: new ArrayBuffer(0), deriveNodes: true },
        { edges: { source: 's', target: 't' } },
        PARITY_OPTIONS,
      ),
    ).rejects.toThrow(/optional peer dependency 'hyparquet'[\s\S]*pnpm add hyparquet/);
  });
});
