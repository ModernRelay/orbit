/**
 * Mapping-fingerprint completeness: the fingerprint
 * covers the union of ADMITTED fields across ALL rows — not the first-row
 * projection — so two inputs whose snapshots or summaries differ in a
 * late-appearing field never share a fingerprint. Discovery order is
 * irrelevant, excluded `includeFields` sources never participate, and every
 * row-object-shaped lane (array, async iterable, JSON document) feeds the
 * identical union into computeMappingFingerprint.
 */

import { describe, expect, it } from 'vitest';
import { computeMappingFingerprint, prepareGraphData } from '../src/index';
import type { GraphColumnMapping } from '../src/types';
import { rowStreamOf, textBytes } from './helpers';

const MAPPING: GraphColumnMapping = {
  nodes: { id: 'id' },
  edges: { source: 'source', target: 'target' },
};
const OPTIONS = { datasetKey: 'fp', sourceRevision: 1 } as const;
const EDGES = [{ source: 'a', target: 'b' }] as const;

async function fingerprintOf(
  nodes: readonly unknown[],
  mapping: GraphColumnMapping = MAPPING,
): Promise<string> {
  const prepared = await prepareGraphData({ nodes, edges: EDGES }, mapping, OPTIONS);
  return prepared.mappingFingerprint;
}

describe('mapping fingerprint completeness (I4)', () => {
  it('distinguishes inputs that differ only in a late-appearing field', async () => {
    const withoutLate = await fingerprintOf([{ id: 'a' }, { id: 'b' }]);
    const lateRisk = await fingerprintOf([{ id: 'a' }, { id: 'b', risk: 3 }]);
    const lateScore = await fingerprintOf([{ id: 'a' }, { id: 'b', score: 3 }]);
    expect(lateRisk).not.toBe(withoutLate);
    expect(lateScore).not.toBe(withoutLate);
    expect(lateRisk).not.toBe(lateScore);
  });

  it('ignores field discovery order when the admitted union is equal', async () => {
    const split = await fingerprintOf([{ id: 'a', x: 1 }, { id: 'b', y: 2 }]);
    const upfront = await fingerprintOf([{ id: 'a', x: 1, y: 2 }, { id: 'b' }]);
    const reversed = await fingerprintOf([{ id: 'a', y: 2 }, { id: 'b', x: 1 }]);
    expect(upfront).toBe(split);
    expect(reversed).toBe(split);
  });

  it('feeds the identical admitted union through array, async-iterable, and document lanes', async () => {
    const nodes = [{ id: 'a', x: 1 }, { id: 'b', late: 'yes' }];
    const edges = [
      { source: 'a', target: 'b', w: 1 },
      { source: 'b', target: 'a', lateEdge: true },
    ];

    const fromArray = await prepareGraphData({ nodes, edges }, MAPPING, OPTIONS);
    const fromAsync = await prepareGraphData(
      { nodes: rowStreamOf(nodes), edges: rowStreamOf(edges) },
      MAPPING,
      OPTIONS,
    );
    const documentMapping: GraphColumnMapping = {
      ...MAPPING,
      documentPaths: { nodes: 'g.n', edges: 'g.e' },
    };
    const fromDocument = await prepareGraphData(
      { document: textBytes(JSON.stringify({ g: { n: nodes, e: edges } })).buffer as ArrayBuffer },
      documentMapping,
      OPTIONS,
    );

    // Both row lanes resolve to format 'rows' → identical fingerprints.
    expect(fromAsync.mappingFingerprint).toBe(fromArray.mappingFingerprint);

    // Every lane admits the same union, LATE fields included; the preimage
    // differs only by the pinned lane label (and, for documents, the
    // mapping's documentPaths) — parity.test.ts pins that split.
    const union = { nodes: ['late', 'x'], edges: ['lateEdge', 'w'] };
    expect(fromArray.mappingFingerprint).toBe(computeMappingFingerprint(MAPPING, 'rows', union));
    expect(fromDocument.mappingFingerprint).toBe(
      computeMappingFingerprint(documentMapping, 'json', union),
    );
  });

  it('covers the EFFECTIVE allowlist under includeFields — excluded fields never participate', async () => {
    const allowMapping: GraphColumnMapping = {
      nodes: { id: 'id', includeFields: ['x'] },
      edges: MAPPING.edges,
    };
    const bare = await fingerprintOf([{ id: 'a', x: 1 }], allowMapping);
    const withExcluded = await fingerprintOf(
      [{ id: 'a', x: 1, junk: 'z' }, { id: 'b', moreJunk: 2 }],
      allowMapping,
    );
    // Supersets with the same admitted union match the bare input...
    expect(withExcluded).toBe(bare);
    //...even when the allowed field itself appears late.
    const lateAllowed = await fingerprintOf([{ id: 'a' }, { id: 'b', x: 2, junk: 'z' }], allowMapping);
    expect(lateAllowed).toBe(bare);
    // Same allowlist, but the allowed field never materializes → the
    // admitted union differs, so the fingerprint must too.
    const neverAdmitted = await fingerprintOf([{ id: 'a' }, { id: 'b', junk: 'z' }], allowMapping);
    expect(neverAdmitted).not.toBe(bare);
  });
});
