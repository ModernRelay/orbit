/**
 * Columnar-native acceptance rules — the column-oriented twin of validate.ts,
 * built to run INSIDE the worker over typed
 * columns without materializing a single row object.
 *
 * Semantics mirror the object lane EXACTLY (the equivalence oracle pins
 * rosters AND diagnostics, message strings included):
 * - duplicate node ids drop, first occurrence wins ('duplicate-node-id',
 * warning) — and edges addressing a dropped duplicate ROW remap to the
 * surviving occurrence, because the object lane resolves endpoints by ID
 * STRING, which survives.
 * - duplicate edge ids drop, first wins ('duplicate-edge-id', warning).
 * - self-loops are RETAINED with 'self-loop-retained' (info).
 * - invalid-node / invalid-edge / dangling-edge cannot occur here: ids come
 * from a structurally validated dictionary column and endpoints are
 * in-bounds indices by prior validation (validateColumnarStructure).
 *
 * Duplicates hide in TWO encodings: two rows sharing a code, and two
 * DISTINCT dictionary entries holding equal strings. Both are handled by
 * canonicalizing the dictionary first (O(dictionary)), then scanning rows
 * with an integer seen-set (O(rows)) — no per-row string work.
 *
 * Worker-safe by construction: pure over typed arrays; no DOM, no instance
 * state, no Date/random.
 */

import { DIAGNOSTIC_SAMPLE_CAP } from './types';
import type { ColumnarGraphSnapshot, GraphDiagnostic, StringColumn } from './types';

export interface ColumnarAcceptance {
  /** 1 = the ORIGINAL row survives into the accepted roster. */
  keepNodes: Uint8Array;
  keepEdges: Uint8Array;
  acceptedNodeCount: number;
  acceptedEdgeCount: number;
  /** ORIGINAL node row → accepted index of its SURVIVING id (a dropped
   * duplicate row points at the first occurrence's accepted index). */
  nodeAcceptedIndex: Int32Array;
  /** Resolved links (2 × acceptedEdgeCount), endpoints in ACCEPTED node
   * indices, remapped through surviving occurrences. */
  links: Uint32Array;
  /** Batched, object-lane-identical diagnostics (codes, counts, capped
   * samples, message strings). */
  diagnostics: GraphDiagnostic[];
}

/** dictionary index → canonical (first) dictionary index for equal strings. */
function canonicalizeDictionary(dictionary: readonly string[]): Uint32Array {
  const canonical = new Uint32Array(dictionary.length);
  const firstByString = new Map<string, number>();
  for (let d = 0; d < dictionary.length; d++) {
    const existing = firstByString.get(dictionary[d]!);
    if (existing === undefined) {
      firstByString.set(dictionary[d]!, d);
      canonical[d] = d;
    } else {
      canonical[d] = existing;
    }
  }
  return canonical;
}

interface Tally {
  count: number;
  samples: string[];
}

function record(tally: Tally, sample: string): void {
  tally.count++;
  if (tally.samples.length < DIAGNOSTIC_SAMPLE_CAP) tally.samples.push(sample);
}

function pushDiagnostic(
  out: GraphDiagnostic[],
  code: GraphDiagnostic['code'],
  severity: GraphDiagnostic['severity'],
  tally: Tally,
  message: string,
): void {
  if (tally.count === 0) return;
  out.push({ code, severity, count: tally.count, sampleIds: tally.samples, message });
}

/**
 * Run the acceptance rules over a STRUCTURALLY VALID columnar snapshot
 * (validateColumnarStructure returned no issues — lengths and bounds are
 * trusted here).
 */
export function acceptColumnar(
  snapshot: ColumnarGraphSnapshot<unknown, unknown>,
): ColumnarAcceptance {
  const nodeIds: StringColumn = snapshot.nodes.ids;
  const edgeIds: StringColumn = snapshot.edges.ids;
  const nodeRows = snapshot.nodes.length;
  const edgeRows = snapshot.edges.length;

  const duplicateNode: Tally = { count: 0, samples: [] };
  const duplicateEdge: Tally = { count: 0, samples: [] };
  const selfLoop: Tally = { count: 0, samples: [] };
  const invalidNode: Tally = { count: 0, samples: [] };
  const danglingEdge: Tally = { count: 0, samples: [] };

  // --- Nodes: first occurrence per canonical id wins. -----------------------
  const nodeCanonical = canonicalizeDictionary(nodeIds.dictionary);
  // As in validate.ts, NUL-containing ids collide with
  // the internal scene-key codec — their ROWS drop as invalid-node. One
  // O(dictionary) scan marks the offending entries.
  const nulDict = new Uint8Array(nodeIds.dictionary.length);
  for (let d = 0; d < nodeIds.dictionary.length; d++) {
    if (nodeIds.dictionary[d]!.includes('\u0000')) nulDict[d] = 1;
  }
  const keepNodes = new Uint8Array(nodeRows);
  const nodeAcceptedIndex = new Int32Array(nodeRows).fill(-1);
  // canonical dictionary index → accepted index of the surviving row
  // (-1 = unseen). Sized to the dictionary, integer-indexed — O(1) per row.
  const acceptedByCanonical = new Int32Array(nodeIds.dictionary.length).fill(-1);
  let acceptedNodeCount = 0;
  for (let i = 0; i < nodeRows; i++) {
    if (nulDict[nodeIds.codes[i]!] !== 0) {
      record(invalidNode, `[${i}]`);
      continue; // nodeAcceptedIndex stays -1: edges to this row will drop
    }
    const canonical = nodeCanonical[nodeIds.codes[i]!]!;
    const survivor = acceptedByCanonical[canonical]!;
    if (survivor === -1) {
      acceptedByCanonical[canonical] = acceptedNodeCount;
      nodeAcceptedIndex[i] = acceptedNodeCount;
      keepNodes[i] = 1;
      acceptedNodeCount += 1;
    } else {
      // Dropped duplicate ROW — its id string survives at the first
      // occurrence, so edges addressing this row remap there.
      nodeAcceptedIndex[i] = survivor;
      record(duplicateNode, nodeIds.dictionary[nodeIds.codes[i]!]!);
    }
  }

  // --- Edges: first occurrence per canonical edge id wins; self-loops kept. -
  const edgeCanonical = canonicalizeDictionary(edgeIds.dictionary);
  const keepEdges = new Uint8Array(edgeRows);
  const seenEdgeByCanonical = new Uint8Array(edgeIds.dictionary.length);
  const { source, target } = snapshot.edges;
  const linksOut = new Uint32Array(edgeRows * 2); // trimmed after the scan
  let acceptedEdgeCount = 0;
  for (let e = 0; e < edgeRows; e++) {
    const canonical = edgeCanonical[edgeIds.codes[e]!]!;
    if (seenEdgeByCanonical[canonical] !== 0) {
      record(duplicateEdge, edgeIds.dictionary[edgeIds.codes[e]!]!);
      continue;
    }
    seenEdgeByCanonical[canonical] = 1;
    const s = nodeAcceptedIndex[source[e]!]!;
    const t = nodeAcceptedIndex[target[e]!]!;
    if (s === -1 || t === -1) {
      // Object-lane mirror: an endpoint whose row was invalid records the
      // ENDPOINT ID STRING, exactly like validate.ts's dangling tally.
      record(
        danglingEdge,
        nodeIds.dictionary[nodeIds.codes[(s === -1 ? source : target)[e]!]!]!,
      );
      continue;
    }
    if (s === t) {
      // Same ACCEPTED node = same id string (the object lane compares
      // source/target strings) — retained, reported.
      record(selfLoop, nodeIds.dictionary[nodeIds.codes[source[e]!]!]!);
    }
    keepEdges[e] = 1;
    linksOut[acceptedEdgeCount * 2] = s;
    linksOut[acceptedEdgeCount * 2 + 1] = t;
    acceptedEdgeCount += 1;
  }

  // Message strings MATCH validate.ts verbatim — the parity oracle compares
  // diagnostics whole.
  const diagnostics: GraphDiagnostic[] = [];
  pushDiagnostic(
    diagnostics,
    'invalid-node',
    'error',
    invalidNode,
    `${invalidNode.count} node row(s) dropped: missing, non-string, or NUL-containing id`,
  );
  pushDiagnostic(
    diagnostics,
    'duplicate-node-id',
    'warning',
    duplicateNode,
    `${duplicateNode.count} duplicate node id(s) dropped (first occurrence wins)`,
  );
  pushDiagnostic(
    diagnostics,
    'dangling-edge-endpoint',
    'warning',
    danglingEdge,
    `${danglingEdge.count} edge(s) dropped: endpoint not in accepted node set`,
  );
  pushDiagnostic(
    diagnostics,
    'duplicate-edge-id',
    'warning',
    duplicateEdge,
    `${duplicateEdge.count} duplicate edge id(s) dropped (first occurrence wins)`,
  );
  pushDiagnostic(
    diagnostics,
    'self-loop-retained',
    'info',
    selfLoop,
    `${selfLoop.count} self-loop edge(s) retained`,
  );

  return {
    keepNodes,
    keepEdges,
    acceptedNodeCount,
    acceptedEdgeCount,
    nodeAcceptedIndex,
    links: linksOut.subarray(0, acceptedEdgeCount * 2).slice(),
    diagnostics,
  };
}
