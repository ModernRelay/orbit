/**
 * @modernrelay/orbit-data public shapes.
 *
 * The prepared-data package turns caller-supplied rows/bytes into reusable
 * artifacts without adding parsers or networking to core. The package consumes
 * supplied bytes/streams, never fetches a URL, and remains Node-import-safe
 * without ambient browser globals.
 *
 * Object snapshots remain the default and the serialized v1 artifact format.
 * Opt-in columnar preparation owns its buffers and uses core's columnar lane.
 */

import type { ColumnarGraphSnapshot, GraphSnapshot } from '@modernrelay/orbit-core';

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
  /** Input bytes across byte sources; rows and existing Arrow tables have no wire bytes. */
  maxBytes?: number;
  /** Admitted rows, including derived unique nodes; duplicates count as rows. */
  maxNodes?: number;
  maxEdges?: number;
  /** At most one notification per 100ms, plus the final completion. */
  onProgress?: (progress: GraphPrepareProgress) => void;
  output?: 'object';
}

export interface GraphPrepareProgress {
  phase: 'reading' | 'preparing' | 'complete';
  bytes: number;
  nodes: number;
  edges: number;
}

export interface GraphPrepareColumnarOptions extends Omit<GraphPrepareOptions, 'output'> {
  output: 'columnar';
}

export type GraphPrepareAnyOptions = GraphPrepareOptions | GraphPrepareColumnarOptions;

export interface PreparedColumnarGraph<N = Record<string, unknown>, E = Record<string, unknown>> {
  /** Fresh owned buffers, marked borrowed for repeatable admission; inputs are never detached. */
  snapshot: ColumnarGraphSnapshot<N, E>;
  summaries: PreparedGraphSummaries;
  mappingFingerprint: string;
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
  /** Default object snapshot; accepted by the v1 artifact serializer. */
  snapshot: GraphSnapshot<N, E>;
  summaries: PreparedGraphSummaries;
  /** fnv-1a-64 hex over canonical-JSON(mapping) + format + the ADMITTED
   * attr-field union across all rows (sorted; invariant I4) — see
   * fingerprint.ts. Artifact loads that present a matching fingerprint skip
   * revalidation (artifact.ts). */
  mappingFingerprint: string;
}
