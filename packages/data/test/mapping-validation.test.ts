/**
 * Mapping validation: failures are ONE TypeError listing EVERY missing
 * column at once, raised before any row work.
 */

import { describe, expect, it } from 'vitest';
import { prepareGraphData } from '../src/index';
import { PARITY_MAPPING, PARITY_OPTIONS, textBytes } from './helpers';

describe('mapping validation', () => {
  it('lists all missing columns in a single TypeError', async () => {
    const nodes = [{ nodeKey: 'a', label: 'Alpha' }];
    const edges = [{ from: 'a', to: 'b' }];
    const attempt = prepareGraphData(
      { nodes, edges },
      { nodes: { id: 'id' }, edges: { source: 'source', target: 'target' } },
      PARITY_OPTIONS,
    );
    await expect(attempt).rejects.toThrow(TypeError);
    const error = (await attempt.then(
      () => new TypeError('unexpected resolve'),
      (e: unknown) => e,
    )) as TypeError;
    expect(error.message).toContain('node id column "id" not found');
    expect(error.message).toContain('edge source column "source" not found');
    expect(error.message).toContain('edge target column "target" not found');
    // Available columns are quoted for each failing role.
    expect(error.message).toContain('"nodeKey"');
    expect(error.message).toContain('"from"');
  });

  it('validates the CSV header before any row work', async () => {
    const csv = textBytes('a,b\n1,2\n').buffer as ArrayBuffer;
    await expect(
      prepareGraphData(
        { nodes: csv, edges: textBytes('source,target\na,b\n').buffer as ArrayBuffer },
        PARITY_MAPPING,
        { ...PARITY_OPTIONS, format: 'csv' },
      ),
    ).rejects.toThrow(/node id column "id" not found \(available: "a", "b"\)/);
  });

  it('requires mapping.nodes when a node source is supplied', async () => {
    await expect(
      prepareGraphData(
        { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'a' }] },
        { edges: { source: 'source', target: 'target' } },
        PARITY_OPTIONS,
      ),
    ).rejects.toThrow(/mapping\.nodes is required/);
  });

  it('treats empty sources as vacuously valid', async () => {
    const prepared = await prepareGraphData(
      { nodes: [], edges: [] },
      PARITY_MAPPING,
      PARITY_OPTIONS,
    );
    expect(prepared.snapshot.nodes).toEqual([]);
    expect(prepared.snapshot.edges).toEqual([]);
    expect(prepared.summaries).toEqual({ nodes: {}, edges: {} });
    expect(prepared.mappingFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects document input without documentPaths', async () => {
    await expect(
      prepareGraphData(
        { document: textBytes('{}').buffer as ArrayBuffer },
        PARITY_MAPPING,
        PARITY_OPTIONS,
      ),
    ).rejects.toThrow(/documentPaths/);
  });

  it('honors an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareGraphData(
        { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'a' }] },
        PARITY_MAPPING,
        { ...PARITY_OPTIONS, signal: controller.signal },
      ),
    ).rejects.toThrow();
  });

  it('throws with the row ordinal when an identity value is unusable', async () => {
    await expect(
      prepareGraphData(
        { nodes: [{ id: 'a' }, { id: null }], edges: [] },
        PARITY_MAPPING,
        PARITY_OPTIONS,
      ),
    ).rejects.toThrow(/node id in column "id" is missing or unusable at row 1/);
  });
});
