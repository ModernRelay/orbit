/**
 * Prepared-artifact round-trip: a versioned JSON envelope so repeated loads
 * can reuse prepared files without reparsing.
 *
 * v1 envelope: `{ formatVersion: 1, datasetKey, sourceRevision,
 * mappingFingerprint, snapshot, summaries }`. The version field is how the
 * A future columnar upgrade can slot in: v2 would carry a ColumnarGraphSnapshot
 * while v1 artifacts keep loading through this object lane.
 *
 * Revalidation contract:
 * - `loadPrepared(bytes, { expectedMappingFingerprint })` with a MATCHING
 * fingerprint skips structural revalidation entirely (the fast path — the
 * artifact was produced by `serializePrepared` under the same mapping);
 * - a MISMATCH throws, quoting both fingerprints;
 * - no expected fingerprint → full structural revalidation via
 * `validatePreparedEnvelope`.
 *
 * JSON transport caveat (documented): snapshot attrs must be JSON-safe
 * `bigint` throws (native JSON.stringify behavior) and `Date` flattens to an
 * ISO string. Prepared lanes that normalize values (arrow.ts/parquet.ts)
 * already produce JSON-safe attrs.
 */

import type { GraphSnapshot } from '@modernrelay/orbit-core';
import type { PreparedGraph, PreparedGraphSummaries } from './types';

export const PREPARED_ARTIFACT_FORMAT_VERSION = 1;

interface PreparedArtifactEnvelopeV1 {
  formatVersion: 1;
  datasetKey: string;
  sourceRevision: string | number;
  mappingFingerprint: string;
  snapshot: GraphSnapshot;
  summaries: PreparedGraphSummaries;
}

export function serializePrepared(prepared: PreparedGraph<unknown, unknown>): Uint8Array {
  const snapshot = prepared.snapshot as GraphSnapshot;
  const envelope: PreparedArtifactEnvelopeV1 = {
    formatVersion: PREPARED_ARTIFACT_FORMAT_VERSION,
    datasetKey: snapshot.datasetKey,
    sourceRevision: snapshot.sourceRevision,
    mappingFingerprint: prepared.mappingFingerprint,
    snapshot,
    summaries: prepared.summaries,
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export function loadPrepared<N = Record<string, unknown>, E = Record<string, unknown>>(
  bytes: Uint8Array,
  options?: { expectedMappingFingerprint?: string },
): PreparedGraph<N, E> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new TypeError(
      `loadPrepared: artifact is not valid JSON (${(cause as Error).message})`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('loadPrepared: artifact must be a JSON object envelope');
  }
  const envelope = parsed as Partial<PreparedArtifactEnvelopeV1>;
  if (envelope.formatVersion !== PREPARED_ARTIFACT_FORMAT_VERSION) {
    throw new TypeError(
      `loadPrepared: unsupported artifact formatVersion ${JSON.stringify(envelope.formatVersion)} ` +
        `(this build reads v${PREPARED_ARTIFACT_FORMAT_VERSION})`,
    );
  }
  if (typeof envelope.mappingFingerprint !== 'string') {
    throw new TypeError('loadPrepared: artifact is missing its mappingFingerprint');
  }

  const expected = options?.expectedMappingFingerprint;
  if (expected !== undefined) {
    if (expected !== envelope.mappingFingerprint) {
      throw new Error(
        `loadPrepared: mapping fingerprint mismatch — expected ${expected}, ` +
          `artifact has ${envelope.mappingFingerprint}; the artifact was prepared ` +
          'under a different mapping/format/schema',
      );
    }
    // Fingerprint match: fast path, revalidation skipped by contract.
  } else {
    _internals.validate(envelope);
  }

  const valid = envelope as PreparedArtifactEnvelopeV1;
  return {
    snapshot: valid.snapshot as GraphSnapshot<N, E>,
    summaries: valid.summaries,
    mappingFingerprint: valid.mappingFingerprint,
  };
}

/**
 * Structural revalidation of a parsed v1 envelope. O(rows); throws TypeError
 * on the first violation. Full semantic validation (duplicate ids, dangling
 * endpoints, …) stays core's job at ingestion.
 */
export function validatePreparedEnvelope(envelope: Partial<PreparedArtifactEnvelopeV1>): void {
  const snapshot = envelope.snapshot as Partial<GraphSnapshot> | undefined;
  if (typeof snapshot !== 'object' || snapshot === null) {
    throw new TypeError('loadPrepared: artifact snapshot is missing');
  }
  if (typeof snapshot.datasetKey !== 'string' || snapshot.datasetKey === '') {
    throw new TypeError('loadPrepared: snapshot.datasetKey must be a non-empty string');
  }
  if (typeof snapshot.sourceRevision !== 'string' && typeof snapshot.sourceRevision !== 'number') {
    throw new TypeError('loadPrepared: snapshot.sourceRevision must be a string or number');
  }
  if (envelope.datasetKey !== snapshot.datasetKey) {
    throw new TypeError('loadPrepared: envelope datasetKey disagrees with its snapshot');
  }
  if (envelope.sourceRevision !== snapshot.sourceRevision) {
    throw new TypeError('loadPrepared: envelope sourceRevision disagrees with its snapshot');
  }
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges)) {
    throw new TypeError('loadPrepared: snapshot nodes/edges must be arrays');
  }
  for (let i = 0; i < snapshot.nodes.length; i++) {
    const node = snapshot.nodes[i] as { id?: unknown; attrs?: unknown } | null;
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '') {
      throw new TypeError(`loadPrepared: snapshot node ${i} lacks a string id`);
    }
    if (node.attrs !== undefined && (typeof node.attrs !== 'object' || node.attrs === null)) {
      throw new TypeError(`loadPrepared: snapshot node ${i} attrs must be an object`);
    }
  }
  for (let i = 0; i < snapshot.edges.length; i++) {
    const edge = snapshot.edges[i] as
      | { id?: unknown; source?: unknown; target?: unknown; attrs?: unknown }
      | null;
    if (
      edge === null ||
      typeof edge !== 'object' ||
      typeof edge.source !== 'string' ||
      edge.source === '' ||
      typeof edge.target !== 'string' ||
      edge.target === ''
    ) {
      throw new TypeError(`loadPrepared: snapshot edge ${i} lacks string endpoints`);
    }
    if (edge.id !== undefined && (typeof edge.id !== 'string' || edge.id === '')) {
      throw new TypeError(`loadPrepared: snapshot edge ${i} id must be a non-empty string`);
    }
    if (edge.attrs !== undefined && (typeof edge.attrs !== 'object' || edge.attrs === null)) {
      throw new TypeError(`loadPrepared: snapshot edge ${i} attrs must be an object`);
    }
  }
  const summaries = envelope.summaries as Partial<PreparedGraphSummaries> | undefined;
  if (typeof summaries !== 'object' || summaries === null) {
    throw new TypeError('loadPrepared: artifact summaries are missing');
  }
  for (const side of ['nodes', 'edges'] as const) {
    const table = summaries[side];
    if (typeof table !== 'object' || table === null || Array.isArray(table)) {
      throw new TypeError(`loadPrepared: summaries.${side} must be a record`);
    }
    for (const [column, summary] of Object.entries(table)) {
      if (
        typeof summary !== 'object' ||
        summary === null ||
        typeof summary.count !== 'number' ||
        typeof summary.nullCount !== 'number'
      ) {
        throw new TypeError(
          `loadPrepared: summaries.${side}[${JSON.stringify(column)}] lacks numeric count/nullCount`,
        );
      }
    }
  }
}

/**
 * Test seam: `loadPrepared` routes revalidation through this indirection so
 * suites can pin the fingerprint fast path with a spy (vi.spyOn(_internals,
 * 'validate')). Not part of the public index.
 */
export const _internals = { validate: validatePreparedEnvelope };
