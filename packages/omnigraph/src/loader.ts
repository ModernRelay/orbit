/**
 * v1 export loader.
 *
 * The organizing rule: graphs load via `og.export` — one streamed
 * NDJSON pass, edge lines first (lexicographic table-key order), driven
 * straight into a `purpose:'replace'` ingest session on the target. Queries
 * never introduce nodes or edges.
 *
 * Revision stamp: the canonical `sourceRevision` hashes
 * `{ graphId, branch, headBefore, headAfter, schemaFingerprint }` (plus the
 * sorted `typeNames` subset when the export is partial), but
 * `headAfter` is only knowable after the stream — while core's
 * `BeginIngestOptions` requires `sourceRevision` up front for a replace
 * session. Resolution: under the rejecting/retrying policies the session
 * begins under the PROVISIONAL revision (the canonical hash with
 * `headAfter:= headBefore`), the stream appends into it, and `headAfter` is
 * captured BEFORE `commit`. `accept-warn` is the exception: normalized
 * batches are buffered until `headAfter` is known, then appended once into a
 * session opened with the canonical FINAL revision:
 *
 * - equal heads → provisional === final; commit cleanly. The session only
 * ever commits a revision whose hash is truthful.
 * - drifted heads → `driftPolicy` decides: `'reject'` aborts the session
 * (graph untouched) and throws {@link OmnigraphDriftError};
 * `'accept-warn'` commits the buffered export under the
 * final revision, records BOTH heads in `dataRef`, and
 * adds a warning;
 * `'retry-once'` aborts and restarts the whole load once
 * (a second drift rejects).
 *
 * This is sound because a replace session is atomic and invisible until
 * commit: nothing is published under a revision the policy did not
 * explicitly accept.
 *
 * Error surface: SDK typed errors never cross this package's public
 * surface — they are mapped to plain `Error`s with a stable `omnigraph:`
 * message prefix.
 */

import { OmnigraphError, SERVER_VERSION } from '@modernrelay/omnigraph';
import type { CallOptions, ExportInput, Omnigraph } from '@modernrelay/omnigraph';
import { OrbitOperationError } from '@modernrelay/orbit-core';
import type { GraphEdge, GraphNode, IngestBatch, IngestSession } from '@modernrelay/orbit-core';

import { classifyExportLine, normalizeEdge, normalizeNode } from './normalize';
import { bigIntKeyWarnings, parsePgSchema, schemaFingerprint } from './pgSchema';
import type { PgSchema } from './pgSchema';
import type {
  IngestTarget,
  OmnigraphDataRef,
  OmnigraphLoadResult,
  OmnigraphSourceOptions,
} from './types';

const DEFAULT_BATCH_SIZE = 2000;

/**
 * Finite whole-export cap for the necessarily atomic replace session. A
 * whole-graph load stages EVERY row before commit, so this is a total-load
 * memory bound, not a backpressure window — real graphs routinely exceed
 * 100 MB of serialized rows (the intel fixture streams ~128 MB), so the
 * default is deliberately generous; callers with tighter memory budgets pass
 * `maxPendingBytes` explicitly.
 */
const DEFAULT_MAX_PENDING_BYTES = 512 * 1024 * 1024;

/** Stateless and safe to reuse; counts serialized UTF-8 rather than UTF-16 code units. */
const UTF8_ENCODER = new TextEncoder();

/**
 * Raised when a branch moves during export and the configured drift policy
 * rejects the load. The session is aborted and the target graph is untouched.
 */
export class OmnigraphDriftError extends Error {
  override readonly name = 'OmnigraphDriftError';
  readonly graphId: string;
  readonly branch: string;
  readonly headBefore: string;
  readonly headAfter: string;
  constructor(graphId: string, branch: string, headBefore: string, headAfter: string) {
    super(
      `omnigraph: branch '${branch}' of graph '${graphId}' changed during export ` +
        `(head ${headBefore} → ${headAfter}); session aborted per driftPolicy (` +
        `service:omnigraph-source-changed-during-export)`,
    );
    this.graphId = graphId;
    this.branch = branch;
    this.headBefore = headBefore;
    this.headAfter = headAfter;
  }
}

/** The one load path a v1 source exposes. */
export interface OmnigraphSource {
  /**
   * Stream one export of the configured graph/branch into `target` via a
   * `purpose:'replace'` ingest session. Resolves with the revision-stamped
   * result; rejects with the session aborted and the target untouched.
   * `signal` aborts both the HTTP stream and the session.
   */
  load(target: IngestTarget, signal?: AbortSignal): Promise<OmnigraphLoadResult>;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** FNV-1a 64-bit over the UTF-8 bytes of `s`, as 16 lowercase hex chars. */
function hash64(s: string): string {
  const MASK64 = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * The canonical adapter source revision: a hash of the readable `dataRef` object
 * `{ graphId, branch, headBefore, headAfter, schemaFingerprint, typeNames? }`
 * (`dataRef` itself retains the readable form).
 */
function canonicalSourceRevision(ref: OmnigraphDataRef): string {
  // typeNames joins the tuple ONLY when present, so full-export
  // hashes stay byte-identical to every previously persisted revision.
  const tuple: unknown[] = [
    ref.graphId,
    ref.branch,
    ref.headBefore,
    ref.headAfter,
    ref.schemaFingerprint,
  ];
  if (ref.typeNames !== undefined) tuple.push(ref.typeNames);
  return `og:${hash64(JSON.stringify(tuple))}`;
}

/** `'0.8.1'` → `'0.8'`; null when unparseable. */
function majorMinor(version: string): string | null {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** CallOptions without an explicit-undefined signal (exactOptionalPropertyTypes). */
function callOpts(signal: AbortSignal | undefined): CallOptions {
  return signal ? { signal } : {};
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('omnigraph: load aborted by caller signal', 'AbortError');
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * SDK typed errors (`NetworkError`, `ConflictError`, …) never leak across the
 * public surface; they rethrow as plain `Error`s with a stable prefix.
 * Abort rejections and this package's own errors pass through unchanged.
 */
function mapError(err: unknown): unknown {
  if (err instanceof OmnigraphError && !isAbortError(err)) {
    return new Error(`omnigraph: ${err.name} (status ${err.status}): ${err.message}`);
  }
  return err;
}

function pushUnique(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

// ---------------------------------------------------------------------------
// createOmnigraphSource
// ---------------------------------------------------------------------------

interface AttemptSuccess {
  kind: 'done';
  sourceRevision: string;
  dataRef: OmnigraphDataRef;
  counts: { lines: number; nodes: number; edges: number; bytes: number };
}

interface AttemptRetry {
  kind: 'retry';
}

/**
 * Create a v1 export-backed data source. The client must be
 * preconfigured. In the browser, use a safe same-origin or public client;
 * there is deliberately no `baseUrl`/`token` option here. Authenticated
 * construction lives only in `@modernrelay/orbit-omnigraph/server`.
 */
export function createOmnigraphSource(options: OmnigraphSourceOptions): OmnigraphSource {
  const graphId = options.graphId;
  const branch = options.branch ?? 'main';
  const batchSize =
    options.batchSize === undefined ? DEFAULT_BATCH_SIZE : options.batchSize;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError('createOmnigraphSource: batchSize must be a positive safe integer');
  }
  const maxPendingBytes =
    options.maxPendingBytes === undefined ? DEFAULT_MAX_PENDING_BYTES : options.maxPendingBytes;
  if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes <= 0) {
    throw new TypeError(
      'createOmnigraphSource: maxPendingBytes must be a positive safe integer',
    );
  }
  const driftPolicy = options.driftPolicy ?? 'reject';
  const onProgress = options.onProgress;
  // Sorted canonical form: ['B','A'] and ['A','B'] are the SAME subset and
  // must produce the same identity coordinate.
  const typeNames =
    options.typeNames === undefined ? undefined : [...options.typeNames].sort();
  /** Every call is scoped to the graph (SDK cluster routing). */
  const client: Omnigraph = options.client.graph(graphId);
  // A partial export is a DIFFERENT dataset lifetime than the full graph;
  // positions, selection, and history must not carry across subsets.
  const datasetKey =
    typeNames === undefined
      ? `og:${graphId}:${branch}`
      : `og:${graphId}:${branch}:types=${typeNames.join(',')}`;

  async function newestHead(signal: AbortSignal | undefined): Promise<string> {
    const commits = await client.commits.list({ branch }, callOpts(signal));
    const newest = commits[0]; // SDK: most recent first
    if (newest === undefined) {
      throw new Error(
        `omnigraph: branch '${branch}' of graph '${graphId}' has no commits — nothing to export`,
      );
    }
    return newest.graphCommitId;
  }

  async function runAttempt(
    target: IngestTarget,
    signal: AbortSignal | undefined,
    warnings: string[],
    attempt: number,
  ): Promise<AttemptSuccess | AttemptRetry> {
    throwIfAborted(signal);
    // Pin the target's SOURCE lineage before any remote work: a competing
    // replace/snapshot landing mid-stream must fail the load. Overlay-only
    // model advances are benign for a replace commit (it supersedes overlays
    // anyway), so the CAS base itself is read fresh at each beginIngest
    // pinning it here made long accept-warn streams fail late (and livelock)
    // under unrelated concurrent overlay traffic.
    const baseSource = target.getRevisions().source;

    // The before/after head bracket must enclose BOTH the schema read and the
    // export. Otherwise a schema migration between schema.get and the first
    // head sample could look quiescent while we normalize with stale types.
    const headBefore = await newestHead(signal);

    // Endpoint-type resolution + wire-type normalization + the fingerprint
    // half of the revision stamp.
    const schemaSource = (await client.schema.get(callOpts(signal))).schemaSource;
    const schema: PgSchema = parsePgSchema(schemaSource);
    const fingerprint = schemaFingerprint(schemaSource);
    for (const hazard of bigIntKeyWarnings(schema)) {
      pushUnique(
        warnings,
        `omnigraph: ${hazard.type}.${hazard.property} is a 64-bit integer used as identity — ` +
          `JSON parsing silently rounds values past ±2^53, which can collapse distinct ids`,
      );
    }
    // NOTE: a schema-declared `type` property needs no warning — the
    // adapter's discriminator lives at the namespaced ORBIT_TYPE_KEY, so the
    // source's own `type` loads as ordinary data with nothing to report.

    const provisionalRef: OmnigraphDataRef = {
      graphId,
      branch,
      headBefore,
      headAfter: headBefore, // provisional: assume quiescence, verify after the stream
      schemaFingerprint: fingerprint,
      ...(typeNames !== undefined ? { typeNames } : {}),
    };
    const provisionalRevision = canonicalSourceRevision(provisionalRef);

    function beginSession(sourceRevision: string): IngestSession {
      const now = target.getRevisions();
      if (now.source !== baseSource) {
        throw new Error(
          `omnigraph: the target's source lineage changed while the load was streaming ` +
            `(a competing replace or snapshot landed); aborting instead of overwriting it`,
        );
      }
      return target.beginIngest({
        purpose: 'replace',
        datasetKey,
        sourceRevision,
        baseModelRevision: now.model,
        maxPendingBytes,
      });
    }

    // `accept-warn` cannot open a truthful session until headAfter is known.
    // Buffer only that opt-in policy; rejecting/retrying loads keep streaming
    // directly into the atomic target under the provisional revision.
    let session: IngestSession | undefined =
      driftPolicy === 'accept-warn' ? undefined : beginSession(provisionalRevision);
    const requestId = hash64(`${datasetKey}|${provisionalRevision}|${attempt}`);

    interface BufferedBatch {
      nodes: GraphNode[];
      edges: GraphEdge[];
      bytes: number;
      progress: { lines: number; nodes: number; edges: number; bytes: number };
    }
    const bufferedBatches: Array<BufferedBatch | undefined> | undefined =
      driftPolicy === 'accept-warn' ? [] : undefined;

    let lines = 0;
    let nodeCount = 0;
    let edgeCount = 0;
    let bytes = 0;
    let unknown = 0;
    let sequence = 0;
    let pendingNodes: GraphNode[] = [];
    let pendingEdges: GraphEdge[] = [];
    let pendingBytes = 0;
    let acceptedBytes = 0;

    /**
     * Replace ingestion is atomic, so neither core staging nor accept-warn's
     * adapter buffer can drain before commit. Enforce the same finite
     * whole-load budget before retaining the next normalized row.
     */
    function accountAcceptedBytes(lineBytes: number): void {
      const next = acceptedBytes + lineBytes;
      if (next > maxPendingBytes) {
        throw new OrbitOperationError(
          { code: 'queue-overflow', queuedBytes: next, limit: maxPendingBytes },
          `omnigraph: export rows require at least ${next} bytes, exceeding ` +
            `maxPendingBytes ${maxPendingBytes}; load aborted before commit`,
        );
      }
      acceptedBytes = next;
      pendingBytes += lineBytes;
    }

    /** Await every append; retain bounded adapter-side pending batches. */
    async function flush(): Promise<void> {
      if (pendingNodes.length === 0 && pendingEdges.length === 0) return;
      const nodes = pendingNodes;
      const edges = pendingEdges;
      const batchBytes = pendingBytes;
      const progress = { lines, nodes: nodeCount, edges: edgeCount, bytes };
      pendingNodes = [];
      pendingEdges = [];
      pendingBytes = 0;

      if (bufferedBatches !== undefined) {
        bufferedBatches.push({ nodes, edges, bytes: batchBytes, progress });
        return;
      }

      const activeSession = session;
      if (activeSession === undefined) throw new Error('omnigraph: internal missing ingest session');
      const batch: IngestBatch = {
        sequence,
        batchId: `og:${requestId}:${sequence}`,
        bytes: batchBytes,
      };
      if (edges.length > 0) batch.edges = edges;
      if (nodes.length > 0) batch.nodes = nodes;
      sequence += 1;
      await activeSession.append(batch);
      onProgress?.(progress);
    }

    /** Commit buffered accept-warn rows once, under the now-known final revision. */
    async function commitBuffered(sourceRevision: string): Promise<void> {
      if (bufferedBatches === undefined) {
        throw new Error('omnigraph: internal missing accept-warn batch buffer');
      }
      const finalSession = beginSession(sourceRevision);
      session = finalSession;
      const finalRequestId = hash64(`${datasetKey}|${sourceRevision}|${attempt}`);
      for (let i = 0; i < bufferedBatches.length; i++) {
        throwIfAborted(signal);
        const buffered = bufferedBatches[i];
        if (buffered === undefined) continue;
        // Release the buffer's array slot as soon as ownership passes to the
        // target session; the local `buffered` reference dies this iteration.
        bufferedBatches[i] = undefined;
        const batch: IngestBatch = {
          sequence: i,
          batchId: `og:${finalRequestId}:${i}`,
          bytes: buffered.bytes,
        };
        if (buffered.edges.length > 0) batch.edges = buffered.edges;
        if (buffered.nodes.length > 0) batch.nodes = buffered.nodes;
        await finalSession.append(batch);
        onProgress?.(buffered.progress);
      }
      bufferedBatches.length = 0;
      throwIfAborted(signal);
      await finalSession.commit();
    }

    // Bind the iterator ONCE and
    // make sure early exits cancel the underlying stream via `return`.
    const exportInput: ExportInput = { branch, ...(typeNames !== undefined ? { typeNames } : {}) };
    const iterator = client
      .export<Record<string, unknown>>(exportInput, callOpts(signal))
      [Symbol.asyncIterator]();

    try {
      for (;;) {
        throwIfAborted(signal);
        const step = await iterator.next();
        if (step.done === true) break;
        const line = step.value;
        lines += 1;
        // The SDK exposes parsed rows rather than raw chunks. Re-serialize to
        // UTF-8 and include one NDJSON newline: a conservative, consistent
        // accounting unit for progress, batches, and the whole-load cap.
        const lineBytes = UTF8_ENCODER.encode(JSON.stringify(line)).byteLength + 1;
        bytes += lineBytes;
        const classified = classifyExportLine(line);
        if (classified.kind === 'node') {
          const node = normalizeNode(classified, schema);
          accountAcceptedBytes(lineBytes);
          pendingNodes.push(node);
          nodeCount += 1;
        } else if (classified.kind === 'edge') {
          const edge = normalizeEdge(classified, schema);
          accountAcceptedBytes(lineBytes);
          pendingEdges.push(edge);
          edgeCount += 1;
        } else {
          unknown += 1;
        }
        if (pendingNodes.length + pendingEdges.length >= batchSize) await flush();
      }
      await flush();

      if (unknown > 0) {
        pushUnique(warnings, `omnigraph: skipped ${unknown} unrecognized export line(s)`);
      }

      // Revision stamp, second half: the head AFTER the stream, captured
      // BEFORE commit.
      throwIfAborted(signal);
      const headAfter = await newestHead(signal);
      throwIfAborted(signal);
      const counts = { lines, nodes: nodeCount, edges: edgeCount, bytes };

      if (driftPolicy === 'accept-warn') {
        const finalRef: OmnigraphDataRef = { ...provisionalRef, headAfter };
        const finalRevision = canonicalSourceRevision(finalRef);
        if (headAfter !== headBefore) {
          pushUnique(
            warnings,
            `omnigraph: branch '${branch}' advanced during export (head ${headBefore} → ` +
              `${headAfter}); committed under the canonical final revision per ` +
              `driftPolicy:'accept-warn' — dataRef records both heads`,
          );
        }
        await commitBuffered(finalRevision);
        return { kind: 'done', sourceRevision: finalRevision, dataRef: finalRef, counts };
      }

      if (headAfter === headBefore) {
        const activeSession = session;
        if (activeSession === undefined) throw new Error('omnigraph: internal missing ingest session');
        await activeSession.commit();
        return { kind: 'done', sourceRevision: provisionalRevision, dataRef: provisionalRef, counts };
      }

      // Branch drift maps to service:omnigraph-source-changed-during-export.
      const activeSession = session;
      if (activeSession === undefined) throw new Error('omnigraph: internal missing ingest session');
      await activeSession.abort('omnigraph: source changed during export');
      if (driftPolicy === 'retry-once' && attempt === 1) {
        pushUnique(
          warnings,
          `omnigraph: branch '${branch}' advanced during export (head ${headBefore} → ` +
            `${headAfter}); load restarted once per driftPolicy:'retry-once'`,
        );
        return { kind: 'retry' };
      }
      throw new OmnigraphDriftError(graphId, branch, headBefore, headAfter);
    } catch (err) {
      if (session?.state === 'open') {
        try {
          await session.abort(err);
        } catch {
          // the original failure wins
        }
      }
      throw mapError(err);
    } finally {
      // Cancel the underlying NDJSON stream on any non-exhausted exit.
      try {
        await iterator.return?.();
      } catch {
        // stream teardown must never mask the outcome
      }
    }
  }

  async function load(target: IngestTarget, signal?: AbortSignal): Promise<OmnigraphLoadResult> {
    const warnings: string[] = [];

    // Surface an SDK/server major.minor mismatch as a warning, never a hard
    // failure.
    let serverVersion: string;
    try {
      serverVersion = (await client.health(callOpts(signal))).version;
    } catch (err) {
      throw mapError(err);
    }
    const server = majorMinor(serverVersion);
    const sdk = majorMinor(SERVER_VERSION);
    if (server === null || server !== sdk) {
      warnings.push(
        `omnigraph: server version ${serverVersion} does not match the SDK-pinned server ` +
          `version ${SERVER_VERSION} (major.minor differ) — SDK behavior is undefined ` +
          `against this server`,
      );
    }

    for (let attempt = 1; ; attempt += 1) {
      let outcome: AttemptSuccess | AttemptRetry;
      try {
        outcome = await runAttempt(target, signal, warnings, attempt);
      } catch (err) {
        // Covers SDK errors thrown before the session/stream phase
        // (schema.get, commits.list); mapError is a no-op on already-mapped
        // or package-owned errors.
        throw mapError(err);
      }
      if (outcome.kind === 'retry') continue;
      return {
        sourceRevision: outcome.sourceRevision,
        dataRef: outcome.dataRef,
        counts: outcome.counts,
        serverVersion,
        warnings,
      };
    }
  }

  return { load };
}
