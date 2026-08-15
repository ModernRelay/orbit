/**
 * @modernrelay/orbit-data public shapes.
 *
 * The prepared-data package turns caller-supplied rows/bytes into reusable
 * artifacts without adding parsers or networking to core. The package consumes
 * supplied bytes/streams, never fetches a URL, and remains Node-import-safe
 * without ambient browser globals.
 *
 * v0.9 TRIM (documented): core has no `ColumnarGraphSnapshot` yet — the
 * columnar lane remains separate, so the prepared artifact wraps an OBJECT
 * `GraphSnapshot` plus summaries and fingerprints. The serialized artifact
 * format is versioned (`formatVersion`, see artifact.ts) so the columnar
 * upgrade slots in without breaking stored artifacts.
 */

import type { GraphSnapshot } from '@modernrelay/orbit-core';

// ---------------------------------------------------------------------------
// Input sources.
// ---------------------------------------------------------------------------

export type GraphRowSource = readonly unknown[] | AsyncIterable<unknown>;
export type GraphByteSource = Blob | ArrayBuffer | AsyncIterable<Uint8Array>;
export type GraphTabularSource = GraphRowSource | GraphByteSource;

export type GraphPrepareInput =
  | { nodes: GraphTabularSource; edges: GraphTabularSource }
  | { edges: GraphTabularSource; deriveNodes: true }
  | { document: GraphByteSource }; // JSON object only

export type GraphColumnMapping = {
  nodes?: {
    id: string;
    includeFields?: readonly string[];
  };
  edges: {
    id?: string;
    source: string;
    target: string;
    includeFields?: readonly string[];
  };
  documentPaths?: { nodes: string; edges: string };
};

export type GraphPrepareFormat = 'rows' | 'csv' | 'json' | 'arrow' | 'parquet';

export interface GraphPrepareOptions {
  datasetKey: string;
  sourceRevision: string | number;
  format?: GraphPrepareFormat;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Column summaries.
//
// Defined LOCALLY as the public `ColumnSummary` shape — deliberately NOT
// imported from core: core's crossfilter summary is a different tier (it is
// revisioned against live model/scope/selection state and computed by a
// CrossfilterBackend), while this one is a static profile of the prepared
// artifact. The two share the same field vocabulary so external charts can
// consume either through the same field vocabulary.
// ---------------------------------------------------------------------------

export type ColumnSummary = {
  /** Total rows in the owning table (every summary of a table shares it). */
  count: number;
  /** Rows with no usable value: key absent, `null`/`undefined`, or a
   * non-finite number (core hygiene — NaN/±Infinity coerce to null). */
  nullCount: number;
  min?: number;
  max?: number;
  /** Exact [p25, p50, p75] while ≤ RESERVOIR_CAP numeric values were seen;
   * reservoir-approximate beyond (documented in summaries.ts). */
  quantiles?: readonly number[];
  /** Distinct primitive values, exact up to UNIQUE_CAP, then reported as the
   * cap itself (a lower bound). */
  approximateUnique?: number;
  categories?: readonly { value: string; count: number }[]; // bounded/top values
  categoriesTruncated?: boolean;
};

export interface PreparedGraphSummaries {
  readonly nodes: Readonly<Record<string, ColumnSummary>>;
  readonly edges: Readonly<Record<string, ColumnSummary>>;
}

// ---------------------------------------------------------------------------
// Prepared output.
// ---------------------------------------------------------------------------

export interface PreparedGraph<
  N = Record<string, unknown>,
  E = Record<string, unknown>,
> {
  /** v0.9 object-lane snapshot (see the trim note at the top of this file). */
  snapshot: GraphSnapshot<N, E>;
  summaries: PreparedGraphSummaries;
  /** fnv-1a-64 hex over canonical-JSON(mapping) + format + the ADMITTED
   * attr-field union across all rows (sorted; invariant I4) — see
   * fingerprint.ts. Artifact loads that present a matching fingerprint skip
   * revalidation (artifact.ts). */
  mappingFingerprint: string;
}
