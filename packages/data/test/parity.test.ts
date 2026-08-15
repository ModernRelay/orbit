/**
 * Rows / CSV / JSON parity: the same logical data through all
 * three built-in lanes yields deep-equal snapshots and summaries. The
 * mappingFingerprint intentionally DIFFERS across lanes (format is part of
 * the fingerprint input), which is also pinned here.
 */

import { describe, expect, it } from 'vitest';
import { prepareGraphData } from '../src/index';
import {
  byteStream,
  chunked,
  PARITY_DOCUMENT,
  PARITY_EDGE_ROWS,
  PARITY_EDGES_CSV,
  PARITY_EXPECTED_SNAPSHOT,
  PARITY_EXPECTED_SUMMARIES,
  PARITY_MAPPING,
  PARITY_NODE_ROWS,
  PARITY_NODES_CSV,
  PARITY_OPTIONS,
  rowStreamOf,
  textBytes,
} from './helpers';

const DOCUMENT_MAPPING = {
  ...PARITY_MAPPING,
  documentPaths: { nodes: 'graph.nodes', edges: 'graph.links' },
};

describe('rows/CSV/JSON parity', () => {
  it('prepares identical snapshots and summaries through every built-in lane', async () => {
    const fromRows = await prepareGraphData(
      { nodes: PARITY_NODE_ROWS, edges: PARITY_EDGE_ROWS },
      PARITY_MAPPING,
      PARITY_OPTIONS,
    );
    const fromAsyncRows = await prepareGraphData(
      { nodes: rowStreamOf(PARITY_NODE_ROWS), edges: rowStreamOf(PARITY_EDGE_ROWS) },
      PARITY_MAPPING,
      PARITY_OPTIONS,
    );
    const fromCsv = await prepareGraphData(
      {
        nodes: byteStream(chunked(textBytes(PARITY_NODES_CSV), [7, 19, 20])),
        edges: byteStream(chunked(textBytes(PARITY_EDGES_CSV), [3, 30])),
      },
      PARITY_MAPPING,
      { ...PARITY_OPTIONS, format: 'csv' },
    );
    const fromDocument = await prepareGraphData(
      { document: textBytes(PARITY_DOCUMENT).buffer as ArrayBuffer },
      DOCUMENT_MAPPING,
      PARITY_OPTIONS,
    );

    for (const prepared of [fromRows, fromAsyncRows, fromCsv, fromDocument]) {
      expect(prepared.snapshot).toEqual(PARITY_EXPECTED_SNAPSHOT);
      expect(prepared.summaries).toEqual(PARITY_EXPECTED_SUMMARIES);
    }

    // Same mapping+columns, same lane → identical fingerprint.
    expect(fromAsyncRows.mappingFingerprint).toBe(fromRows.mappingFingerprint);
    // Format participates in the fingerprint, so lanes differ.
    expect(fromCsv.mappingFingerprint).not.toBe(fromRows.mappingFingerprint);
    expect(fromDocument.mappingFingerprint).not.toBe(fromRows.mappingFingerprint);
  });

  it('infers csv vs rows for AsyncIterable sources by peeking the first element', async () => {
    const inferredCsv = await prepareGraphData(
      {
        nodes: byteStream(chunked(textBytes(PARITY_NODES_CSV), [11])),
        edges: byteStream(chunked(textBytes(PARITY_EDGES_CSV), [23])),
      },
      PARITY_MAPPING,
      PARITY_OPTIONS, // no format
    );
    expect(inferredCsv.snapshot).toEqual(PARITY_EXPECTED_SNAPSHOT);
    expect(inferredCsv.summaries).toEqual(PARITY_EXPECTED_SUMMARIES);
  });

  it('accepts Blob byte sources', async () => {
    const prepared = await prepareGraphData(
      { nodes: new Blob([PARITY_NODES_CSV]), edges: new Blob([PARITY_EDGES_CSV]) },
      PARITY_MAPPING,
      { ...PARITY_OPTIONS, format: 'csv' },
    );
    expect(prepared.snapshot).toEqual(PARITY_EXPECTED_SNAPSHOT);
    expect(prepared.summaries).toEqual(PARITY_EXPECTED_SUMMARIES);
  });

  it('routes arrow/parquet format requests to their dedicated entries', async () => {
    await expect(
      prepareGraphData({ nodes: [], edges: [] }, PARITY_MAPPING, {
        ...PARITY_OPTIONS,
        format: 'arrow',
      }),
    ).rejects.toThrow(/@modernrelay\/orbit-data\/arrow/);
    await expect(
      prepareGraphData({ nodes: [], edges: [] }, PARITY_MAPPING, {
        ...PARITY_OPTIONS,
        format: 'parquet',
      }),
    ).rejects.toThrow(/@modernrelay\/orbit-data\/parquet/);
  });
});
