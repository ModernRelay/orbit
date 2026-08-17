/**
 * Public types for the v1 export loader.
 *
 * The organizing rule of the v1 adapter: graphs load via `og.export()`;
 * queries only ever resolve ids. These types describe that one load path
 * its options, its ingestion target seam, and its revision-stamped result.
 */

import type { Omnigraph } from '@modernrelay/omnigraph';
import type {
  BeginIngestOptions,
  GraphDiagnostic,
  IngestSession,
  Revisions,
} from '@modernrelay/orbit-core';

/** Cumulative progress, reported after every appended batch. */
export interface OmnigraphLoadProgress {
  /** Export lines consumed so far (nodes + edges + skipped unknowns). */
  lines: number;
  /** Node lines normalized so far. */
  nodes: number;
  /** Edge lines normalized so far. */
  edges: number;
  /** Serialized UTF-8 NDJSON bytes consumed so far (including line breaks). */
  bytes: number;
}

/**
 * Revision-stamp drift policy: what to do when the branch head observed after
 * the export stream differs from the head observed before it.
 *
 * - `'reject'` (default): abort the session and throw — the graph is left
 * untouched. The right choice for durable/shareable sessions.
 * - `'accept-warn'`: buffer the export, then commit under the canonical final
 * revision once `headAfter` is known; both heads are recorded in `dataRef`
 * and a warning is added when they differ.
 * - `'retry-once'`: abort, restart the whole load once; a second drift
 * rejects.
 */
export type OmnigraphDriftPolicy = 'reject' | 'accept-warn' | 'retry-once';

export interface OmnigraphSourceOptions {
  /**
   * A **preconfigured** SDK client. In the browser this must be a safe
   * same-origin or public client — this option surface deliberately accepts
   * no `baseUrl`/`token` pair: authenticated client construction lives
   * ONLY in `@modernrelay/orbit-omnigraph/server`
   * (`createOmnigraphServerClient`), which is excluded from client bundles.
   */
  client: Omnigraph;
  /** Cluster graph id; every call is scoped to it via `client.graph(graphId)`. */
  graphId: string;
  /** Branch to export. Default `'main'`. */
  branch?: string;
  /**
   * Partial per-type load: forwarded as the SDK `ExportInput.typeNames`
   * field (wire form `type_names`). Omit to export every table.
   */
  typeNames?: readonly string[];
  /** Export lines per `IngestBatch` append. Must be a positive safe integer. Default 2000. */
  batchSize?: number;
  /**
   * Whole-load byte budget for the atomic replace. Because atomic staging
   * cannot drain before commit, exceeding this finite cap aborts the load
   * without publishing a partial graph. Must be a positive safe integer.
   * Default 512 MiB.
   */
  maxPendingBytes?: number;
  /** Revision-stamp drift policy. Default `'reject'`. */
  driftPolicy?: OmnigraphDriftPolicy;
  /** Called after every appended batch with cumulative counts. */
  onProgress?: (p: OmnigraphLoadProgress) => void;
}

/**
 * Branch-based view-state `dataRef`. This is the readable object behind the
 * canonical `sourceRevision` hash, retained so hosts can display or persist the
 * exact coordinates a session was loaded from. `headBefore !== headAfter`
 * only ever appears under `driftPolicy: 'accept-warn'`.
 */
export interface OmnigraphDataRef {
  graphId: string;
  branch: string;
  /** Branch head commit id captured before the export stream. */
  headBefore: string;
  /** Branch head commit id captured after the stream, before commit. */
  headAfter: string;
  /** Fingerprint of the `.pg` schema source (see `schemaFingerprint`). */
  schemaFingerprint: string;
  /**
   * Sorted node-type subset of a PARTIAL export; absent = full export.
   * Part of the identity coordinate: two partial exports at the same head
   * differing only by types must never replay as one another.
   */
  typeNames?: readonly string[];
}

export interface OmnigraphLoadCounts {
  lines: number;
  nodes: number;
  edges: number;
  /** Serialized UTF-8 NDJSON bytes streamed (including line breaks). */
  bytes: number;
}

export interface OmnigraphLoadResult {
  /**
   * The committed source coordinate: the canonical hash of `dataRef`.
   * Stable across identical replays — a second load of a quiescent branch
   * commits idempotently (the same `{datasetKey, sourceRevision}` publishes
   * nothing).
   */
  sourceRevision: string;
  dataRef: OmnigraphDataRef;
  counts: OmnigraphLoadCounts;
  /** `og.health().version` — the server build the load ran against. */
  serverVersion: string;
  /**
   * Non-fatal observations: SDK/server major.minor mismatch, accepted
   * drift, big-int identity hazards, and skipped unknown lines. Never
   * hides a retry or accepted-drift decision.
   */
  warnings: string[];
}

/**
 * Minimal structural ingestion target — deliberately decoupled from
 * `GraphInstance`. The loader needs exactly the ingest seam and nothing else,
 * so any object with these members works: a real `GraphInstance` (which
 * satisfies this interface structurally), a recorder, or a headless pipeline.
 */
export interface IngestTarget {
  beginIngest(opts: BeginIngestOptions): IngestSession;
  getRevisions(): Revisions;
  getDiagnostics?(): readonly GraphDiagnostic[];
}
