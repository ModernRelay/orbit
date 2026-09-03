/**
 * Export loader against the REAL SDK: an injected
 * `FetchLike` replays the raw HTTP bodies recorded from a real
 * omnigraph-server (fixtures/omnigraph/recorded/ — see manifest.json), so
 * `Omnigraph`'s transport, camelization, and NDJSON iterator all do genuine
 * work. The ingest target is a REAL `createGraphInstance` over a FakeEngine.
 */

import { Omnigraph, OmnigraphError } from '@modernrelay/omnigraph';
import type { FetchLike } from '@modernrelay/omnigraph';
import { createGraphInstance, OrbitOperationError } from '@modernrelay/orbit-core';
import type { GraphInstance } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { describe, expect, it } from 'vitest';

import { createOmnigraphSource, OmnigraphDriftError, schemaFingerprint } from '../src/index';
import type {
  IngestTarget,
  OmnigraphLoadProgress,
  OmnigraphSourceOptions,
} from '../src/index';

// ---------------------------------------------------------------------------
// Recorded fixtures (real server responses, imported as verbatim text)
// ---------------------------------------------------------------------------

import commitsBody from '../../../fixtures/omnigraph/recorded/commits.json?raw';
import exportPartialBody from '../../../fixtures/omnigraph/recorded/export-partial.ndjson?raw';
import exportBody from '../../../fixtures/omnigraph/recorded/export.ndjson?raw';
import healthBody from '../../../fixtures/omnigraph/recorded/health.json?raw';
import manifestBody from '../../../fixtures/omnigraph/recorded/manifest.json?raw';
import schemaBody from '../../../fixtures/omnigraph/recorded/schema.json?raw';

const manifest = JSON.parse(manifestBody) as {
  headBefore: string;
  headAfter: string;
  serverVersion: string;
  rowCounts: Record<string, number>;
  exportLineCount: number;
};

const HEAD = manifest.headBefore;
const NODE_TOTAL = Object.entries(manifest.rowCounts)
  .filter(([k]) => k.startsWith('node:'))
  .reduce((n, [, c]) => n + c, 0);
const EDGE_TOTAL = Object.entries(manifest.rowCounts)
  .filter(([k]) => k.startsWith('edge:'))
  .reduce((n, [, c]) => n + c, 0);
const EXPECTED_FINGERPRINT = schemaFingerprint(
  (JSON.parse(schemaBody) as { schema_source: string }).schema_source,
);

/** The recorded commits body with the newest (head) commit id replaced. */
function commitsWithHead(head: string): string {
  const parsed = JSON.parse(commitsBody) as { commits: Array<Record<string, unknown>> };
  const newest = parsed.commits[0];
  if (newest === undefined) throw new Error('recorded commits body is empty');
  parsed.commits = [{ ...newest, graph_commit_id: head }, ...parsed.commits.slice(1)];
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// replayFetch — recorded HTTP through the real SDK
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body: string | null;
}

type Responder = (signal: AbortSignal | undefined) => Response;

/** A fresh JSON Response per call (Response bodies are single-use). */
function json(body: string, status = 200): Responder {
  return () =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Stream `text` as a web ReadableStream in 1 KiB byte chunks with a real
 * async hop between chunks, so the SDK's ndjson iterator does genuine
 * incremental decode/split work (lines straddle chunk boundaries). Honors
 * the request signal: an abort mid-stream errors the stream.
 */
function ndjson(text: string): Responder {
  const bytes = new TextEncoder().encode(text);
  return (signal) => {
    let offset = 0;
    const CHUNK = 1024;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + CHUNK));
        offset += CHUNK;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    });
  };
}

/**
 * Match `METHOD pathname` → recorded responder(s). An array is consumed in
 * call order with the last entry repeating. Every request is captured for
 * assertions on what the SDK actually sent.
 */
function replayFetch(routes: Record<string, Responder | readonly Responder[]>): {
  fetch: FetchLike;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const counters = new Map<string, number>();
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    const key = `${method} ${url.pathname}`;
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const route = routes[key];
    if (route === undefined) {
      return new Response(JSON.stringify({ error: `replayFetch: no recording for ${key}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const seen = counters.get(key) ?? 0;
    counters.set(key, seen + 1);
    const list = Array.isArray(route) ? (route as readonly Responder[]) : [route as Responder];
    const responder = list[Math.min(seen, list.length - 1)]!;
    return responder(init?.signal ?? undefined);
  };
  return { fetch, calls };
}

function recordedRoutes(
  overrides: Record<string, Responder | readonly Responder[]> = {},
): Record<string, Responder | readonly Responder[]> {
  return {
    'GET /healthz': json(healthBody),
    'GET /graphs/demo/schema': json(schemaBody),
    'GET /graphs/demo/commits': json(commitsBody),
    'POST /graphs/demo/export': ndjson(exportBody),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness: real SDK client + real GraphInstance target
// ---------------------------------------------------------------------------

interface Harness {
  instance: GraphInstance;
  source: ReturnType<typeof createOmnigraphSource>;
  calls: RecordedRequest[];
}

function harness(
  routes: Record<string, Responder | readonly Responder[]>,
  opts: Partial<Omit<OmnigraphSourceOptions, 'client' | 'graphId'>> = {},
): Harness {
  const replay = replayFetch(routes);
  const client = new Omnigraph({ baseUrl: 'http://replay.invalid', fetch: replay.fetch });
  const instance = createGraphInstance({ engine: () => new FakeEngine() });
  const source = createOmnigraphSource({ client, graphId: 'demo', ...opts });
  return { instance, source, calls: replay.calls };
}

/** Record the ingest budget/byte declarations while delegating to real core. */
function recordingTarget(instance: GraphInstance): {
  target: IngestTarget;
  maxPendingBytes: number[];
  batchBytes: number[];
} {
  const maxPendingBytes: number[] = [];
  const batchBytes: number[] = [];
  const target: IngestTarget = {
    getRevisions: () => instance.getRevisions(),
    beginIngest: (opts) => {
      maxPendingBytes.push(opts.maxPendingBytes ?? -1);
      const inner = instance.beginIngest(opts);
      return {
        get state() {
          return inner.state;
        },
        get overlayId() {
          return inner.overlayId;
        },
        append(batch) {
          batchBytes.push(batch.bytes ?? -1);
          return inner.append(batch);
        },
        commit: () => inner.commit(),
        abort: (reason) => inner.abort(reason),
      };
    },
  };
  return { target, maxPendingBytes, batchBytes };
}

const exportCalls = (calls: RecordedRequest[]): RecordedRequest[] =>
  calls.filter((c) => c.method === 'POST' && c.path === '/graphs/demo/export');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('source option validation', () => {
  it('rejects batchSize values that cannot define a finite batch boundary', () => {
    for (const batchSize of [
      NaN,
      Infinity,
      -Infinity,
      0,
      -1,
      1.5,
      Number.MAX_VALUE,
      null as unknown as number,
    ]) {
      expect(() => harness(recordedRoutes(), { batchSize })).toThrow(
        /batchSize must be a positive safe integer/,
      );
    }
    expect(() => harness(recordedRoutes(), { batchSize: 1 })).not.toThrow();
  });

  it('rejects non-numeric maxPendingBytes instead of treating null as the default', () => {
    expect(() =>
      harness(recordedRoutes(), { maxPendingBytes: null as unknown as number }),
    ).toThrow(/maxPendingBytes must be a positive safe integer/);
  });
});

describe('partial-export identity includes typeNames', () => {
  it('same head, different typeNames → DIFFERENT datasetKey and sourceRevision; order canonicalizes', async () => {
    const runLoad = async (typeNames?: readonly string[]) => {
      const { instance, source } = harness(
        recordedRoutes(),
        typeNames !== undefined ? { typeNames } : {},
      );
      const result = await source.load(instance);
      return { result, revisions: instance.getRevisions() };
    };

    const full = await runLoad();
    const signals = await runLoad(['Signal']);
    const accounts = await runLoad(['Account']);
    const accountsReversed = await runLoad(['Account']); // determinism twin

    // Two partial exports at the same head are DIFFERENT coordinates.
    expect(signals.result.sourceRevision).not.toBe(accounts.result.sourceRevision);
    expect(signals.result.sourceRevision).not.toBe(full.result.sourceRevision);
    // Same subset → same coordinate (idempotent replay stays possible).
    expect(accountsReversed.result.sourceRevision).toBe(accounts.result.sourceRevision);
    // The ref DISCLOSES the subset; full exports stay shape-compatible.
    expect(signals.result.dataRef.typeNames).toEqual(['Signal']);
    expect(full.result.dataRef.typeNames).toBeUndefined();
  });

  it('a sorted subset equals its unsorted spelling (canonical form)', async () => {
    const load = async (typeNames: readonly string[]) => {
      const { instance, source } = harness(recordedRoutes(), { typeNames });
      return (await source.load(instance)).sourceRevision;
    };
    expect(await load(['B_Type', 'A_Type'])).toBe(await load(['A_Type', 'B_Type']));
  });
});

describe('createOmnigraphSource().load — full export', () => {
  it('streams the recorded export into a replace session; counts match the manifest', async () => {
    const progress: OmnigraphLoadProgress[] = [];
    const { instance, source, calls } = harness(recordedRoutes(), {
      batchSize: 100,
      onProgress: (p) => progress.push({ ...p }),
    });

    const result = await source.load(instance);

    expect(result.counts.lines).toBe(manifest.exportLineCount);
    expect(result.counts.nodes).toBe(NODE_TOTAL);
    expect(result.counts.edges).toBe(EDGE_TOTAL);
    expect(result.counts.bytes).toBeGreaterThan(0);
    expect(result.serverVersion).toBe(manifest.serverVersion);
    expect(result.warnings).toEqual([]);
    expect(result.dataRef).toEqual({
      graphId: 'demo',
      branch: 'main',
      headBefore: HEAD,
      headAfter: HEAD,
      schemaFingerprint: EXPECTED_FINGERPRINT,
    });

    // The replace session landed the whole graph on the instance.
    const state = instance.store.getState();
    expect(state.nodeCount).toBe(NODE_TOTAL);
    expect(state.edgeCount).toBe(EDGE_TOTAL);
    expect(state.revisions.source).toBe(result.sourceRevision);

    // Edge lines all arrived BEFORE node lines (lexicographic table-key
    // order); core's pending-endpoint index resolved every edge — nothing
    // dangled at commit.
    expect(
      instance.getDiagnostics().filter((d) => d.code === 'dangling-edge-endpoint'),
    ).toEqual([]);

    // Progress is cumulative, per appended batch: 500 edges then 300 nodes
    // at batchSize 100 → exactly 8 batches.
    expect(progress).toHaveLength(8);
    expect(progress.at(-1)).toEqual({
      lines: manifest.exportLineCount,
      nodes: NODE_TOTAL,
      edges: EDGE_TOTAL,
      bytes: result.counts.bytes,
    });
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!.lines).toBeGreaterThan(progress[i - 1]!.lines);
    }

    // The SDK issued exactly one export request, scoped and branch-targeted.
    const exports = exportCalls(calls);
    expect(exports).toHaveLength(1);
    expect(JSON.parse(exports[0]!.body!)).toEqual({ branch: 'main' });
  });

  it('declares truthful nonzero batch bytes and forwards the whole-load budget', async () => {
    const budget = 2 * 1024 * 1024;
    const { instance, source } = harness(recordedRoutes(), {
      batchSize: 100,
      maxPendingBytes: budget,
    });
    const recorded = recordingTarget(instance);

    const result = await source.load(recorded.target);

    expect(recorded.maxPendingBytes).toEqual([budget]);
    expect(recorded.batchBytes).toHaveLength(8);
    expect(recorded.batchBytes.every((n) => n > 0)).toBe(true);
    expect(recorded.batchBytes.reduce((sum, n) => sum + n, 0)).toBe(result.counts.bytes);
    expect(instance.store.getState().nodeCount).toBe(NODE_TOTAL);
  });

  it('accounts for serialized UTF-8 bytes rather than UTF-16 string length', async () => {
    const row = { type: 'Actor', data: { id: 'é', slug: 'é', name: 'Ada 😀' } };
    const body = `${JSON.stringify(row)}\n`;
    const utf8Bytes = new TextEncoder().encode(body).byteLength;
    const { instance, source } = harness(
      recordedRoutes({ 'POST /graphs/demo/export': ndjson(body) }),
      {
        driftPolicy: 'accept-warn',
        maxPendingBytes: utf8Bytes - 1,
      },
    );
    const recorded = recordingTarget(instance);

    await expect(source.load(recorded.target)).rejects.toMatchObject({
      detail: {
        code: 'queue-overflow',
        queuedBytes: utf8Bytes,
        limit: utf8Bytes - 1,
      },
    });
    expect(recorded.maxPendingBytes).toEqual([]);
  });

  it('rejects an oversized atomic export before commit, including accept-warn buffering', async () => {
    const { instance, source } = harness(recordedRoutes(), {
      driftPolicy: 'accept-warn',
      maxPendingBytes: 1,
    });
    const recorded = recordingTarget(instance);

    const err = await source.load(recorded.target).then(
      () => null,
      (error: unknown) => error,
    );

    expect(err).toBeInstanceOf(OrbitOperationError);
    expect((err as OrbitOperationError).detail).toMatchObject({
      code: 'queue-overflow',
      limit: 1,
    });
    // accept-warn exceeded the cap while buffering, before a target session
    // could be opened and before any graph state became visible.
    expect(recorded.maxPendingBytes).toEqual([]);
    expect(instance.store.getState().revisions.model).toBe(0);
    expect(instance.store.getState().nodeCount).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects invalid maxPendingBytes=%s at source creation',
    (maxPendingBytes) => {
      expect(() => harness(recordedRoutes(), { maxPendingBytes })).toThrow(
        /maxPendingBytes must be a positive safe integer/,
      );
    },
  );

  it('a second identical load replays idempotently — nothing publishes', async () => {
    const { instance, source } = harness(recordedRoutes());

    const first = await source.load(instance);
    const modelAfterFirst = instance.store.getState().revisions.model;
    expect(modelAfterFirst).toBeGreaterThan(0);

    const second = await source.load(instance);

    // Same coordinates → same canonical revision → idempotent replay.
    expect(second.sourceRevision).toBe(first.sourceRevision);
    expect(second.dataRef).toEqual(first.dataRef);
    const state = instance.store.getState();
    expect(state.revisions.model).toBe(modelAfterFirst);
    expect(state.revisions.source).toBe(first.sourceRevision);
    expect(state.nodeCount).toBe(NODE_TOTAL);
  });

  it('flags unrecognized export lines with a warning instead of failing', async () => {
    const doctored = `${exportBody}{"weird":true}\n`;
    const { instance, source } = harness(
      recordedRoutes({ 'POST /graphs/demo/export': ndjson(doctored) }),
    );

    const result = await source.load(instance);

    expect(result.counts.lines).toBe(manifest.exportLineCount + 1);
    expect(result.counts.nodes).toBe(NODE_TOTAL);
    expect(result.counts.edges).toBe(EDGE_TOTAL);
    expect(result.warnings.some((w) => w.includes('skipped 1 unrecognized'))).toBe(true);
  });
});

describe('source-revision drift policy', () => {
  const DRIFT_HEAD = '01ZZDRIFTED000000000000000';

  it('samples headBefore before schema so a schema/export race is detected', async () => {
    let currentHead = HEAD;
    const commitsAtCurrentHead: Responder = () =>
      new Response(commitsWithHead(currentHead), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const schemaThenAdvance: Responder = (signal) => {
      const response = json(schemaBody)(signal);
      // Models a migration/commit after the first head sample but during the
      // schema read. With schema fetched before headBefore, both samples
      // would see DRIFT_HEAD and the stale-schema load would look stable.
      currentHead = DRIFT_HEAD;
      return response;
    };
    const { instance, source, calls } = harness(
      recordedRoutes({
        'GET /graphs/demo/commits': commitsAtCurrentHead,
        'GET /graphs/demo/schema': schemaThenAdvance,
      }),
    );

    await expect(source.load(instance)).rejects.toBeInstanceOf(OmnigraphDriftError);
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'GET /healthz',
      'GET /graphs/demo/commits',
      'GET /graphs/demo/schema',
      'POST /graphs/demo/export',
      'GET /graphs/demo/commits',
    ]);
    expect(instance.store.getState().revisions.model).toBe(0);
  });

  it("'reject' (default): aborts the session and leaves the graph untouched", async () => {
    const { instance, source } = harness(
      recordedRoutes({
        'GET /graphs/demo/commits': [json(commitsBody), json(commitsWithHead(DRIFT_HEAD))],
      }),
    );

    const err = await source.load(instance).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OmnigraphDriftError);
    expect(err).toMatchObject({ headBefore: HEAD, headAfter: DRIFT_HEAD });
    expect((err as Error).message).toMatch(/^omnigraph: /);

    const state = instance.store.getState();
    expect(state.nodeCount).toBe(0);
    expect(state.revisions.model).toBe(0);
    expect(state.revisions.source).toBeNull();
  });

  it("'accept-warn': commits drift under its distinct canonical final revision", async () => {
    const { instance, source } = harness(
      recordedRoutes({
        // First load is stable. The second reads the same headBefore but a
        // drifted headAfter; it must not collide with the first load's
        // idempotency coordinate.
        'GET /graphs/demo/commits': [
          json(commitsBody),
          json(commitsBody),
          json(commitsBody),
          json(commitsWithHead(DRIFT_HEAD)),
        ],
      }),
      { driftPolicy: 'accept-warn' },
    );

    const clean = await source.load(instance);
    const modelAfterClean = instance.store.getState().revisions.model;
    const result = await source.load(instance);

    expect(result.dataRef.headBefore).toBe(HEAD);
    expect(result.dataRef.headAfter).toBe(DRIFT_HEAD);
    expect(result.warnings.some((w) => w.includes("accept-warn"))).toBe(true);
    expect(result.sourceRevision).not.toBe(clean.sourceRevision);
    const state = instance.store.getState();
    expect(state.revisions.model).toBeGreaterThan(modelAfterClean);
    expect(state.revisions.source).toBe(result.sourceRevision);
    expect(state.nodeCount).toBe(NODE_TOTAL);
  });

  it("'accept-warn': an overlay-only model advance mid-stream does not fail the deferred session", async () => {
    // The deferred beginIngest reads a FRESH CAS base: unrelated overlay
    // publications during a long stream must not make a replace load fail
    // late (or livelock) — only a SOURCE-lineage change may (next test).
    let currentModel = 0;
    let headReads = 0;
    const commitsThenRace: Responder = () => {
      headReads += 1;
      if (headReads === 2) currentModel = 3; // overlays raced the export stream
      return new Response(commitsBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { source } = harness(
      recordedRoutes({ 'GET /graphs/demo/commits': commitsThenRace }),
      { driftPolicy: 'accept-warn' },
    );
    const openedWith: number[] = [];
    const target: IngestTarget = {
      getRevisions: () => ({
        source: null,
        model: currentModel,
        scope: currentModel,
        render: currentModel,
        appliedRender: null,
      }),
      beginIngest: (opts) => {
        openedWith.push(opts.baseModelRevision);
        if (opts.baseModelRevision !== currentModel) {
          throw new OrbitOperationError(
            { code: 'stale-revision', expected: currentModel, actual: opts.baseModelRevision },
            'simulated CAS enforcement',
          );
        }
        return {
          state: 'open',
          overlayId: undefined,
          append: async (b) => ({
            sequence: b.sequence,
            batchId: b.batchId,
            admittedNodes: b.nodes?.length ?? 0,
            admittedEdges: b.edges?.length ?? 0,
            pendingBytes: 0,
          }),
          commit: async () => ({
            modelRevision: currentModel + 1,
            admittedNodes: NODE_TOTAL,
            admittedEdges: 0,
            danglingEdges: 0,
          }),
          abort: async () => {},
        };
      },
    };

    const result = await source.load(target);
    expect(openedWith).toEqual([3]); // fresh CAS base at deferred-open time
    expect(result.sourceRevision).toBeTruthy();
  });

  it("'accept-warn': a SOURCE-lineage change mid-stream fails the load instead of overwriting it", async () => {
    let currentSource: string | null = null;
    let headReads = 0;
    const commitsThenReplace: Responder = () => {
      headReads += 1;
      if (headReads === 2) currentSource = 'competing-replace'; // another replace landed
      return new Response(commitsBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const { source } = harness(
      recordedRoutes({ 'GET /graphs/demo/commits': commitsThenReplace }),
      { driftPolicy: 'accept-warn' },
    );
    const target: IngestTarget = {
      getRevisions: () => ({
        source: currentSource,
        model: 0,
        scope: 0,
        render: 0,
        appliedRender: null,
      }),
      beginIngest: () => {
        throw new Error('test expected the source-lineage guard to fire before beginIngest');
      },
    };

    await expect(source.load(target)).rejects.toThrow(/source lineage changed/);
  });

  it("does NOT warn when the schema declares a property named 'type' (namespaced discriminator)", async () => {
    const original = (JSON.parse(schemaBody) as { schema_source: string }).schema_source;
    const doctored = JSON.stringify({
      schema_source: `${original}\n\nnode Shadowy {\n    slug: String @key\n    type: String\n}\n`,
    });
    const { instance, source } = harness(
      recordedRoutes({ 'GET /graphs/demo/schema': json(doctored) }),
    );

    // The discriminator lives at 'orbit:type', so a schema `type` property
    // collides with nothing and there is nothing to report.
    const result = await source.load(instance);
    expect(result.warnings.some((w) => w.includes('Shadowy'))).toBe(false);
    expect(result.warnings.some((w) => w.includes("property named 'type'"))).toBe(false);
  });

  it("'retry-once': re-streams once and succeeds when the second pass is stable", async () => {
    const drifted = commitsWithHead(DRIFT_HEAD);
    const { instance, source, calls } = harness(
      recordedRoutes({
        // attempt 1: before=HEAD, after=DRIFT (drift); attempt 2: before=DRIFT,
        // after=DRIFT (stable).
        'GET /graphs/demo/commits': [json(commitsBody), json(drifted), json(drifted)],
      }),
      { driftPolicy: 'retry-once' },
    );

    const result = await source.load(instance);

    expect(exportCalls(calls)).toHaveLength(2);
    expect(result.dataRef.headBefore).toBe(DRIFT_HEAD);
    expect(result.dataRef.headAfter).toBe(DRIFT_HEAD);
    expect(result.warnings.some((w) => w.includes("retry-once"))).toBe(true);
    const state = instance.store.getState();
    expect(state.nodeCount).toBe(NODE_TOTAL);
    expect(state.revisions.source).toBe(result.sourceRevision);
  });

  it("'retry-once': a second drift rejects", async () => {
    const drift1 = commitsWithHead(DRIFT_HEAD);
    const drift2 = commitsWithHead('01ZZDRIFTEDAGAIN0000000000');
    const { instance, source, calls } = harness(
      recordedRoutes({
        'GET /graphs/demo/commits': [json(commitsBody), json(drift1), json(drift1), json(drift2)],
      }),
      { driftPolicy: 'retry-once' },
    );

    await expect(source.load(instance)).rejects.toBeInstanceOf(OmnigraphDriftError);
    expect(exportCalls(calls)).toHaveLength(2); // retried exactly once
    expect(instance.store.getState().nodeCount).toBe(0);
    expect(instance.store.getState().revisions.model).toBe(0);
  });
});

describe('cancellation and error surface', () => {
  it('abort mid-stream aborts the session — no partial graph', async () => {
    const controller = new AbortController();
    const { instance, source } = harness(recordedRoutes(), {
      batchSize: 50,
      onProgress: () => controller.abort(), // abort after the FIRST appended batch
    });

    await expect(source.load(instance, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    const state = instance.store.getState();
    expect(state.nodeCount).toBe(0);
    expect(state.edgeCount).toBe(0);
    expect(state.revisions.model).toBe(0);
    expect(state.revisions.source).toBeNull();
  });

  it('maps SDK typed errors to plain omnigraph:-prefixed errors', async () => {
    const { instance, source } = harness(
      recordedRoutes({
        'GET /graphs/demo/schema': json(JSON.stringify({ error: 'boom', code: 'internal' }), 500),
      }),
    );

    const err = await source.load(instance).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OmnigraphError); // never leaks SDK classes
    expect((err as Error).message).toMatch(/^omnigraph: InternalServerError/);
    expect(instance.store.getState().revisions.model).toBe(0);
  });
});

describe('server and SDK version mismatch surfacing', () => {
  it('the recorded fixture server and the SDK pin share major.minor — no warning', async () => {
    // The fixture is regenerated with the same server generation the SDK
    // pins (currently 0.10.x) — a mismatch here means the pin and the
    // fixture drifted apart and one of them needs regenerating/bumping.
    const { instance, source } = harness(recordedRoutes());
    const result = await source.load(instance);
    expect(result.warnings).toEqual([]);
  });

  it('a different major.minor is a warning, never a hard failure', async () => {
    const { instance, source } = harness(
      recordedRoutes({
        'GET /healthz': json(
          JSON.stringify({ status: 'ok', version: '0.11.0', internal_schema_version: 6 }),
        ),
      }),
    );

    const result = await source.load(instance);

    expect(result.serverVersion).toBe('0.11.0');
    expect(result.warnings.some((w) => w.includes('0.11.0') && w.includes('0.10.0'))).toBe(true);
    expect(instance.store.getState().nodeCount).toBe(NODE_TOTAL); // load still succeeded
  });
});

describe('partial per-type load through typeNames', () => {
  it('forwards the filter as wire-form type_names and loads only those tables', async () => {
    const { instance, source, calls } = harness(
      recordedRoutes({ 'POST /graphs/demo/export': ndjson(exportPartialBody) }),
      { typeNames: ['Correlates', 'Signal'] },
    );

    const result = await source.load(instance);

    const exports = exportCalls(calls);
    expect(exports).toHaveLength(1);
    // The SDK snake_cases the body: typeNames → type_names (verified against
    // the recorded export-partial request in scripts/omnigraph-fixture.mjs).
    expect(JSON.parse(exports[0]!.body!)).toEqual({
      branch: 'main',
      type_names: ['Correlates', 'Signal'],
    });

    expect(result.counts.lines).toBe(110);
    expect(result.counts.edges).toBe(manifest.rowCounts['edge:Correlates']);
    expect(result.counts.nodes).toBe(manifest.rowCounts['node:Signal']);
    const state = instance.store.getState();
    expect(state.nodeCount).toBe(manifest.rowCounts['node:Signal']);
    expect(state.edgeCount).toBe(manifest.rowCounts['edge:Correlates']); // Signal→Signal, all resolved
    expect(
      instance.getDiagnostics().filter((d) => d.code === 'dangling-edge-endpoint'),
    ).toEqual([]);
  });
});
