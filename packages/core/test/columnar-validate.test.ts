/**
 * Columnar-native acceptance rules against the object-lane
 * ORACLE: for adversarial twins (duplicate rows via shared codes AND via
 * equal-string dictionary entries, duplicate edge ids, self-loops, edges
 * addressing dropped duplicate rows), acceptColumnar's roster, links, and
 * diagnostics EQUAL what validateSnapshot produces for the materialized
 * twin. Message strings included — the parity capture compares diagnostics
 * whole.
 */

import { describe, expect, it } from 'vitest';

import { acceptColumnar } from '../src/columnarValidate';
import { materializeColumnarSnapshot } from '../src/columnar';
import { validateSnapshot } from '../src/validate';
import type { ColumnarGraphSnapshot } from '../src/types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function col(over: Partial<ColumnarGraphSnapshot> = {}): ColumnarGraphSnapshot {
  return {
    kind: 'columnar',
    datasetKey: 'cv',
    sourceRevision: 1,
    nodes: {
      ids: { kind: 'string', dictionary: ['a', 'b', 'c'], codes: Uint32Array.of(0, 1, 2) },
      columns: {},
      length: 3,
    },
    edges: {
      ids: { kind: 'string', dictionary: ['e1', 'e2'], codes: Uint32Array.of(0, 1) },
      source: Uint32Array.of(0, 1),
      target: Uint32Array.of(1, 2),
      columns: {},
      length: 2,
    },
    ...over,
  };
}

/** Oracle comparison: same rosters, links, and diagnostics both lanes. */
function expectOracleAgreement(snapshot: ColumnarGraphSnapshot): void {
  const native = acceptColumnar(snapshot);
  const oracle = validateSnapshot(materializeColumnarSnapshot(snapshot));

  // Rosters.
  const nativeNodeIds: string[] = [];
  for (let i = 0; i < snapshot.nodes.length; i++) {
    if (native.keepNodes[i] === 1) {
      nativeNodeIds.push(snapshot.nodes.ids.dictionary[snapshot.nodes.ids.codes[i]!]!);
    }
  }
  expect(nativeNodeIds).toEqual(oracle.nodes.map((n) => n.id));
  expect(native.acceptedNodeCount).toBe(oracle.nodes.length);
  expect(native.acceptedEdgeCount).toBe(oracle.edges.length);

  // Links resolve to the same ACCEPTED endpoint indices the oracle's
  // nodeIndex assigns.
  const oracleLinks: number[] = [];
  for (const e of oracle.edges) {
    oracleLinks.push(oracle.nodeIndex.get(e.source)!, oracle.nodeIndex.get(e.target)!);
  }
  expect([...native.links]).toEqual(oracleLinks);

  // Diagnostics — codes, severities, counts, samples, MESSAGES.
  expect(native.diagnostics).toEqual(oracle.diagnostics);
}

describe('columnar-native acceptance vs the object-lane oracle', () => {
  it('clean snapshot: everything survives, zero diagnostics', () => {
    const snapshot = col();
    expectOracleAgreement(snapshot);
    const native = acceptColumnar(snapshot);
    expect(native.acceptedNodeCount).toBe(3);
    expect(native.diagnostics).toEqual([]);
  });

  it('duplicate node rows via a SHARED code: dropped first-wins, edges remap to the survivor', () => {
    const snapshot = col();
    snapshot.nodes.ids.codes[2] = 0; // row 2 duplicates 'a'; e2 targets row 2
    expectOracleAgreement(snapshot);
    const native = acceptColumnar(snapshot);
    expect(native.acceptedNodeCount).toBe(2);
    // e2 (b → dropped-row-2) remaps to (b → a): accepted indices (1, 0).
    expect([...native.links]).toEqual([0, 1, 1, 0]);
  });

  it('duplicate node ids via EQUAL-STRING dictionary entries (distinct codes)', () => {
    const snapshot = col();
    (snapshot.nodes.ids as { dictionary: readonly string[] }).dictionary = ['a', 'b', 'a'];
    // codes stay 0,1,2 — row 2's id string 'a' duplicates row 0's.
    expectOracleAgreement(snapshot);
    expect(acceptColumnar(snapshot).acceptedNodeCount).toBe(2);
  });

  it('duplicate edge ids drop first-wins; self-loops are RETAINED with the info diagnostic', () => {
    const snapshot = col({
      edges: {
        ids: {
          kind: 'string',
          dictionary: ['e1', 'e1', 'loop'],
          codes: Uint32Array.of(0, 1, 2),
        },
        source: Uint32Array.of(0, 1, 2),
        target: Uint32Array.of(1, 2, 2), // third edge: c → c self-loop
        columns: {},
        length: 3,
      },
    });
    expectOracleAgreement(snapshot);
    const native = acceptColumnar(snapshot);
    expect(native.acceptedEdgeCount).toBe(2); // dup 'e1' dropped, loop kept
    expect(native.diagnostics.map((d) => d.code).sort()).toEqual([
      'duplicate-edge-id',
      'self-loop-retained',
    ]);
  });

  it('NUL-reserved explicit edge ids drop identically in native and object lanes', () => {
    const snapshot = col();
    (snapshot.edges.ids as { dictionary: readonly string[] }).dictionary = [
      '\u0000["meta-edge","a","b"]',
      'safe',
    ];

    expectOracleAgreement(snapshot);
    const native = acceptColumnar(snapshot);
    expect(native.acceptedEdgeCount).toBe(1);
    expect(native.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'invalid-edge', count: 1, sampleIds: ['[0]'] }),
    );
  });

  it('a dangling edge does not reserve its id ahead of a later valid edge', () => {
    const snapshot = col({
      nodes: {
        ids: {
          kind: 'string',
          dictionary: ['bad\u0000node', 'b', 'c'],
          codes: Uint32Array.of(0, 1, 2),
        },
        columns: {},
        length: 3,
      },
      edges: {
        ids: { kind: 'string', dictionary: ['same'], codes: Uint32Array.of(0, 0) },
        source: Uint32Array.of(0, 1),
        target: Uint32Array.of(1, 2),
        columns: {},
        length: 2,
      },
    });

    expectOracleAgreement(snapshot);
    const native = acceptColumnar(snapshot);
    expect(native.acceptedEdgeCount).toBe(1);
    expect([...native.keepEdges]).toEqual([0, 1]);
    expect(native.diagnostics.map((diag) => diag.code)).toEqual([
      'invalid-node',
      'dangling-edge-endpoint',
    ]);
  });

  it('a duplicate-row COLLAPSE creating a self-loop matches the object lane', () => {
    // Edge (row0 → row2) where row 2 duplicates row 0's id: both lanes see
    // source string == target string → retained self-loop.
    const snapshot = col();
    snapshot.nodes.ids.codes[2] = 0;
    snapshot.edges.source[1] = 0;
    snapshot.edges.target[1] = 2;
    expectOracleAgreement(snapshot);
    expect(acceptColumnar(snapshot).diagnostics.some((d) => d.code === 'self-loop-retained')).toBe(
      true,
    );
  });

  it('adversarial id strings (quotes, brackets, arrows, hash) round the oracle unchanged', () => {
    const ids = ['"q"', '["group","red"]', 'a→b#0', 'plain', '"q"']; // last duplicates first
    const snapshot = col({
      nodes: {
        ids: {
          kind: 'string',
          dictionary: ids,
          codes: Uint32Array.of(0, 1, 2, 3, 4),
        },
        columns: {},
        length: 5,
      },
      edges: {
        ids: { kind: 'string', dictionary: ['e1'], codes: Uint32Array.of(0) },
        source: Uint32Array.of(4), // the dropped duplicate row → remaps to row 0
        target: Uint32Array.of(3),
        columns: {},
        length: 1,
      },
    });
    expectOracleAgreement(snapshot);
  });

  it('seeded random duplicate storms agree with the oracle (property sweep)', () => {
    for (const seed of [1, 2026, 0xbeef]) {
      const rng = mulberry32(seed);
      const nodeRows = 200;
      const dictSize = 120; // guaranteed collisions
      const dict = Array.from({ length: dictSize }, (_, i) => `n${i}`);
      const codes = Uint32Array.from({ length: nodeRows }, () =>
        Math.floor(rng() * dictSize),
      );
      const edgeRows = 300;
      const edgeDict = Array.from({ length: 220 }, (_, i) => `e${i}`);
      const edgeCodes = Uint32Array.from({ length: edgeRows }, () =>
        Math.floor(rng() * edgeDict.length),
      );
      const source = Uint32Array.from({ length: edgeRows }, () => Math.floor(rng() * nodeRows));
      const target = Uint32Array.from({ length: edgeRows }, () => Math.floor(rng() * nodeRows));
      expectOracleAgreement(
        col({
          nodes: {
            ids: { kind: 'string', dictionary: dict, codes },
            columns: {},
            length: nodeRows,
          },
          edges: {
            ids: { kind: 'string', dictionary: edgeDict, codes: edgeCodes },
            source,
            target,
            columns: {},
            length: edgeRows,
          },
        }),
      );
    }
  });
});
