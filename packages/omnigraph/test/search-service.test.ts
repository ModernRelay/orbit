/**
 * Stored-query SearchService against the REAL SDK: an injected
 * `FetchLike` serves doctored `/queries/{name}` read envelopes through
 * `Omnigraph`'s genuine transport (camelization, opaque `rows`/`params`
 * handling, signal plumbing), and the integration test drives the service
 * through a REAL `createGraphInstance` loaded by the REAL export loader.
 */

import { Omnigraph, OmnigraphError } from '@modernrelay/omnigraph';
import type { FetchLike } from '@modernrelay/omnigraph';
import { createGraphInstance, createRequestContext } from '@modernrelay/orbit-core';
import type { RequestContextHandle, SearchResult } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { describe, expect, it } from 'vitest';

import {
  createOmnigraphSearchService,
  createOmnigraphSource,
  decodeSourceId,
  encodeSourceId,
} from '../src/index';
import type { OmnigraphSearchServiceOptions } from '../src/index';

// ---------------------------------------------------------------------------
// Recorded fixtures (the loader integration path reuses the real recordings)
// ---------------------------------------------------------------------------

import commitsBody from '../../../fixtures/omnigraph/recorded/commits.json?raw';
import exportPartialBody from '../../../fixtures/omnigraph/recorded/export-partial.ndjson?raw';
import healthBody from '../../../fixtures/omnigraph/recorded/health.json?raw';
import schemaBody from '../../../fixtures/omnigraph/recorded/schema.json?raw';

// ---------------------------------------------------------------------------
// replayFetch — doctored HTTP through the real SDK (loader.test.ts pattern,
// extended with async responders for abort-mid-flight and signal capture)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  body: string | null;
  hadSignal: boolean;
}

type Responder = (signal: AbortSignal | undefined) => Response | Promise<Response>;

/** A fresh JSON Response per call (Response bodies are single-use). */
function json(body: string, status = 200): Responder {
  return () =>
    new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** Never resolves; rejects with AbortError when the request signal fires. */
function hanging(): Responder {
  return (signal) =>
    new Promise<Response>((_resolve, reject) => {
      const fail = (): void =>
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener('abort', fail, { once: true });
    });
}

/** Stream `text` as NDJSON in one chunk (enough realism for the loader leg). */
function ndjson(text: string): Responder {
  return () =>
    new Response(text, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

function replayFetch(routes: Record<string, Responder>): {
  fetch: FetchLike;
  calls: RecordedRequest[];
} {
  const calls: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      path: url.pathname,
      body: typeof init?.body === 'string' ? init.body : null,
      hadSignal: init?.signal !== undefined && init.signal !== null,
    });
    const responder = routes[`${method} ${url.pathname}`];
    if (responder === undefined) {
      return new Response(
        JSON.stringify({ error: `replayFetch: no recording for ${method} ${url.pathname}` }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    return responder(init?.signal ?? undefined);
  };
  return { fetch, calls };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const QUERY = 'search-intel';
const INVOKE_ROUTE = `POST /graphs/demo/queries/${QUERY}`;

/** A stored-read envelope in wire form (snake_case, opaque rows). */
function readEnvelope(rows: readonly unknown[]): string {
  return JSON.stringify({
    query_name: QUERY,
    row_count: rows.length,
    columns: rows.length > 0 ? Object.keys(rows[0] as object) : [],
    rows,
    target: { branch: 'main' },
  });
}

function harness(
  routes: Record<string, Responder>,
  opts: Partial<Omit<OmnigraphSearchServiceOptions, 'client' | 'graphId'>> = {},
): { service: ReturnType<typeof createOmnigraphSearchService>; calls: RecordedRequest[] } {
  const replay = replayFetch(routes);
  const client = new Omnigraph({ baseUrl: 'http://replay.invalid', fetch: replay.fetch });
  const service = createOmnigraphSearchService({
    client,
    graphId: 'demo',
    queryName: QUERY,
    typeOf: { $s: 'Signal' },
    ...opts,
  });
  return { service, calls: replay.calls };
}

function context(): RequestContextHandle {
  return createRequestContext({
    datasetKey: 'og:demo:main',
    revisions: { source: 'og:fixture', model: 1, scope: 1 },
  });
}

const invokeCalls = (calls: RecordedRequest[]): RecordedRequest[] =>
  calls.filter((c) => c.method === 'POST' && c.path === `/graphs/demo/queries/${QUERY}`);

// ---------------------------------------------------------------------------
// Invocation shape
// ---------------------------------------------------------------------------

describe('createOmnigraphSearchService — invocation', () => {
  it('invokes the stored query with branch, default {q, limit} params, and the ctx signal', async () => {
    const { service, calls } = harness(
      { [INVOKE_ROUTE]: json(readEnvelope([])) },
      { branch: 'feature' },
    );

    const results = await service.search('alpha load', { limit: 7 }, context().context);

    expect(results).toEqual([]);
    const invokes = invokeCalls(calls);
    expect(invokes).toHaveLength(1);
    expect(JSON.parse(invokes[0]!.body!)).toEqual({
      branch: 'feature',
      params: { q: 'alpha load', limit: 7 },
    });
    expect(invokes[0]!.hadSignal).toBe(true);
  });

  it('a custom params builder shapes the stored-query params verbatim', async () => {
    const { service, calls } = harness(
      { [INVOKE_ROUTE]: json(readEnvelope([])) },
      { params: (q, limit) => ({ text: q, k: limit, kinds: ['Signal'] }) },
    );

    await service.search('drift', { limit: 3 }, context().context);

    expect(JSON.parse(invokeCalls(calls)[0]!.body!)).toEqual({
      branch: 'main',
      params: { text: 'drift', k: 3, kinds: ['Signal'] },
    });
  });

  it('an empty query or non-positive limit resolves [] without a network call', async () => {
    const { service, calls } = harness({ [INVOKE_ROUTE]: json(readEnvelope([])) });

    expect(await service.search('', { limit: 5 }, context().context)).toEqual([]);
    expect(await service.search('alpha', { limit: 0 }, context().context)).toEqual([]);
    expect(await service.search('alpha', { limit: Number.NaN }, context().context)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("declares revisionDependencies ['source']", () => {
    const { service } = harness({ [INVOKE_ROUTE]: json(readEnvelope([])) });
    expect(service.revisionDependencies).toEqual(['source']);
  });
});

// ---------------------------------------------------------------------------
// Row mapping: identity, score, and label
// ---------------------------------------------------------------------------

describe('row mapping', () => {
  it('encodes type-qualified ids that round-trip through decodeSourceId and maps score and label', async () => {
    const rows = [
      { $s: { id: 'signal-001', slug: 'signal-001' }, score: 7.5, '$s.title': 'Alpha spike' },
      { $s: { id: 'signal-002', slug: 'signal-002' }, '$s.title': 'Beta drift' }, // no score column
      { $s: { id: 'signal-003', slug: 'signal-003' }, score: 'high' }, // non-numeric score, no string column
    ];
    const { service } = harness({ [INVOKE_ROUTE]: json(readEnvelope(rows)) });

    const results = await service.search('alpha', { limit: 10 }, context().context);

    expect(results).toEqual([
      { id: encodeSourceId('Signal', 'signal-001'), score: 7.5, label: 'Alpha spike' },
      { id: encodeSourceId('Signal', 'signal-002'), label: 'Beta drift' },
      { id: encodeSourceId('Signal', 'signal-003') },
    ]);
    expect(decodeSourceId(results[0]!.id)).toEqual({ kind: 'Signal', sourceId: 'signal-001' });
  });

  it('labelColumn overrides the first-string-column default', async () => {
    const rows = [
      { $s: { id: 'signal-004' }, '$s.title': 'Title wins by order', '$s.slug': 'slug-004' },
    ];
    const { service } = harness(
      { [INVOKE_ROUTE]: json(readEnvelope(rows)) },
      { labelColumn: '$s.slug' },
    );

    const results = await service.search('slug', { limit: 5 }, context().context);
    expect(results[0]!.label).toBe('slug-004');
  });

  it('a column→type record maps the first listed column carrying a node struct', async () => {
    const rows = [
      { $s: { id: 'signal-005' }, $a: { id: 'actor-001' } }, // $s listed first → Signal wins
      { $a: { id: 'actor-002' } }, // only $a present → Actor
    ];
    const { service } = harness(
      { [INVOKE_ROUTE]: json(readEnvelope(rows)) },
      { typeOf: { $s: 'Signal', $a: 'Actor' } },
    );

    const results = await service.search('mixed', { limit: 5 }, context().context);
    expect(results.map((r) => r.id)).toEqual([
      encodeSourceId('Signal', 'signal-005'),
      encodeSourceId('Actor', 'actor-002'),
    ]);
  });

  it('a typeOf function names the type per row; the first node-struct column supplies the id', async () => {
    const rows = [{ score: 1.25, $t: { id: 'trace-001' } }];
    const { service } = harness(
      { [INVOKE_ROUTE]: json(readEnvelope(rows)) },
      { typeOf: () => 'Trace' },
    );

    const results = await service.search('trace', { limit: 5 }, context().context);
    expect(results).toEqual([{ id: encodeSourceId('Trace', 'trace-001'), score: 1.25 }]);
  });

  it('mapRow fully overrides the default mapping; null skips the row', async () => {
    const rows = [
      { $s: { id: 'signal-006' } },
      { $s: { id: 'signal-007' } },
    ];
    const { service } = harness(
      { [INVOKE_ROUTE]: json(readEnvelope(rows)) },
      {
        mapRow: (row) => {
          const struct = row['$s'] as { id: string };
          if (struct.id === 'signal-006') return null;
          return { id: encodeSourceId('Signal', struct.id), label: 'custom', score: 0.5 };
        },
      },
    );

    const results = await service.search('custom', { limit: 5 }, context().context);
    expect(results).toEqual([
      { id: encodeSourceId('Signal', 'signal-007'), label: 'custom', score: 0.5 },
    ]);
  });

  it('caps results at the requested limit even when the query returns more', async () => {
    const rows = [1, 2, 3, 4].map((n) => ({ $s: { id: `signal-00${n}` } }));
    const { service } = harness({ [INVOKE_ROUTE]: json(readEnvelope(rows)) });

    const results = await service.search('many', { limit: 2 }, context().context);
    expect(results).toHaveLength(2);
  });

  it('a row without a node struct under the mapped columns is a hard error', async () => {
    const rows = [{ score: 3, '$s.title': 'no struct projected' }];
    const { service } = harness({ [INVOKE_ROUTE]: json(readEnvelope(rows)) });

    await expect(service.search('bad', { limit: 5 }, context().context)).rejects.toThrow(
      /^omnigraph: .*no node struct/,
    );
  });

  it('a stored MUTATION envelope (no rows) is a hard error', async () => {
    const changeEnvelope = JSON.stringify({
      affected_nodes: 1,
      affected_edges: 0,
      graph_commit_id: '01ZZFAKECOMMIT000000000000',
    });
    const { service } = harness({ [INVOKE_ROUTE]: json(changeEnvelope) });

    await expect(service.search('oops', { limit: 5 }, context().context)).rejects.toThrow(
      /^omnigraph: .*read envelope/,
    );
  });
});

// ---------------------------------------------------------------------------
// Error surface and cancellation
// ---------------------------------------------------------------------------

describe('error surface and cancellation', () => {
  it('maps SDK typed errors to plain omnigraph:-prefixed Errors', async () => {
    const { service } = harness({
      [INVOKE_ROUTE]: json(JSON.stringify({ error: 'boom', code: 'internal' }), 500),
    });

    const err = await service.search('alpha', { limit: 5 }, context().context).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OmnigraphError); // never leaks SDK classes
    expect((err as Error).message).toMatch(/^omnigraph: InternalServerError/);
  });

  it('abort mid-flight rejects with AbortError (ctx.signal reaches the HTTP layer)', async () => {
    const { service, calls } = harness({ [INVOKE_ROUTE]: hanging() });
    const handle = context();

    const pending = service.search('alpha', { limit: 5 }, handle.context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(invokeCalls(calls)).toHaveLength(1); // the request is in flight
    handle.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('an already-aborted context rejects without a network call', async () => {
    const { service, calls } = harness({ [INVOKE_ROUTE]: json(readEnvelope([])) });
    const handle = context();
    handle.abort();

    await expect(service.search('alpha', { limit: 5 }, handle.context)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Real-core integration: services.search with a partial export load
// ---------------------------------------------------------------------------

describe('real core integration with partial-load results', () => {
  it('instance.search returns encoded ids; an id outside the partial load classifies as not-loaded', async () => {
    // Search rows straddle the partial load: signal-001 is in the loaded
    // Signal table; actor-001 belongs to the UNLOADED Actor table (the stored
    // query searches the whole branch server-side).
    const searchRows = [
      { $s: { id: 'signal-001', slug: 'signal-001' }, score: 9.1, '$s.title': 'Signal 1' },
      { $a: { id: 'actor-001', slug: 'actor-001' }, score: 4.2, '$a.name': 'Søren Nguyễn' },
    ];
    const replay = replayFetch({
      'GET /healthz': json(healthBody),
      'GET /graphs/demo/schema': json(schemaBody),
      'GET /graphs/demo/commits': json(commitsBody),
      'POST /graphs/demo/export': ndjson(exportPartialBody),
      [INVOKE_ROUTE]: json(readEnvelope(searchRows)),
    });
    const client = new Omnigraph({ baseUrl: 'http://replay.invalid', fetch: replay.fetch });
    const searchService = createOmnigraphSearchService({
      client,
      graphId: 'demo',
      queryName: QUERY,
      typeOf: { $s: 'Signal', $a: 'Actor' },
    });
    const instance = createGraphInstance({
      engine: () => new FakeEngine(),
      services: { search: searchService },
    });

    // Partial per-type load through the REAL export loader.
    const source = createOmnigraphSource({
      client,
      graphId: 'demo',
      typeNames: ['Correlates', 'Signal'],
    });
    await source.load(instance);

    const results = await instance.search('signal', { limit: 10 });
    expect(results.map((r: SearchResult) => r.id)).toEqual([
      encodeSourceId('Signal', 'signal-001'),
      encodeSourceId('Actor', 'actor-001'),
    ]);
    expect(results[0]).toMatchObject({ score: 9.1, label: 'Signal 1' });

    // The loaded Signal id decodes back to the export-loaded node identity.
    expect(decodeSourceId(results[0]!.id)).toEqual({ kind: 'Signal', sourceId: 'signal-001' });

    // The Actor id was never export-loaded, so activation reports 'not-loaded'.
    const activation = await instance.activateSearchResult(results[1]!);
    expect(activation).toMatchObject({ status: 'unavailable', reason: 'not-loaded' });
  });
});
