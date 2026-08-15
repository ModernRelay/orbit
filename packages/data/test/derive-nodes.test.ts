/**
 * deriveNodes: `{edges, deriveNodes: true}` synthesizes the node set
 * from edge endpoints — ids only, first-occurrence order.
 */

import { describe, expect, it } from 'vitest';
import { prepareGraphData } from '../src/index';
import { PARITY_OPTIONS, textBytes } from './helpers';

const EDGE_MAPPING = { edges: { source: 'source', target: 'target' } };

describe('deriveNodes', () => {
  it('synthesizes id-only nodes in endpoint first-occurrence order', async () => {
    const prepared = await prepareGraphData(
      {
        edges: [
          { source: 'b', target: 'a', w: 1 },
          { source: 'a', target: 'c', w: 2 },
          { source: 'c', target: 'b', w: 3 },
        ],
        deriveNodes: true,
      },
      EDGE_MAPPING,
      PARITY_OPTIONS,
    );
    expect(prepared.snapshot.nodes).toEqual([{ id: 'b' }, { id: 'a' }, { id: 'c' }]);
    expect(prepared.snapshot.edges).toEqual([
      { source: 'b', target: 'a', attrs: { w: 1 } },
      { source: 'a', target: 'c', attrs: { w: 2 } },
      { source: 'c', target: 'b', attrs: { w: 3 } },
    ]);
    expect(prepared.summaries.nodes).toEqual({});
    expect(prepared.summaries.edges['w']).toMatchObject({ count: 3, nullCount: 0, min: 1, max: 3 });
  });

  it('derives through the CSV lane too', async () => {
    const prepared = await prepareGraphData(
      { edges: textBytes('source,target\nx,y\ny,x\n').buffer as ArrayBuffer, deriveNodes: true },
      EDGE_MAPPING,
      { ...PARITY_OPTIONS, format: 'csv' },
    );
    expect(prepared.snapshot.nodes).toEqual([{ id: 'x' }, { id: 'y' }]);
    expect(prepared.snapshot.edges).toEqual([
      { source: 'x', target: 'y' },
      { source: 'y', target: 'x' },
    ]);
  });

  it('does not require mapping.nodes', async () => {
    const prepared = await prepareGraphData(
      { edges: [{ source: 's', target: 't' }], deriveNodes: true },
      { edges: { source: 'source', target: 'target' } },
      PARITY_OPTIONS,
    );
    expect(prepared.snapshot.nodes.map((n) => n.id)).toEqual(['s', 't']);
  });
});
