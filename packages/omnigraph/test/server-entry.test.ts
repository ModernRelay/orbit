/**
 * Entry-boundary contract: the `/server` entry is the ONLY place for
 * authenticated construction; the browser entry exposes no token-accepting
 * API anywhere. (The bundle-level exclusion is enforced by the
 * `treeshake:omnigraph-client` gate in scripts/pack-smoke.mjs.)
 */

import { HTTP_API_CONTRACT, HTTP_API_CONTRACT_HEADER, Omnigraph } from '@modernrelay/omnigraph';
import type { FetchLike } from '@modernrelay/omnigraph';
import { describe, expect, it } from 'vitest';

import * as browserEntry from '../src/index';
import type { OmnigraphSourceOptions } from '../src/index';
import { createOmnigraphServerClient } from '../src/server';

describe('createOmnigraphServerClient in the server-only entry', () => {
  it('authenticates graph requests while contract discovery and health remain public', async () => {
    const seen: Array<{ url: string; method: string; auth: string | null; contract: string | null }> = [];
    const fetch: FetchLike = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      seen.push({
        url,
        method,
        auth: new Headers(init?.headers).get('authorization'),
        contract: new Headers(init?.headers).get(HTTP_API_CONTRACT_HEADER),
      });
      return new Response(
        method === 'HEAD' ? null : JSON.stringify(url.endsWith('/schema')
          ? { schema_source: 'node Actor { slug: String @key }' }
          : { status: 'ok', version: '0.14.0', internal_schema_version: 16 }),
        { status: 200, headers: { 'content-type': 'application/json', [HTTP_API_CONTRACT_HEADER]: HTTP_API_CONTRACT } },
      );
    };

    const client = createOmnigraphServerClient({
      baseUrl: 'http://og.internal:8080',
      token: 'secret-token',
      fetch,
    });

    expect(client).toBeInstanceOf(Omnigraph);
    const health = await client.health();
    expect(health.version).toBe('0.14.0');
    await client.graph('demo').schema.get();
    expect(seen).toEqual([
      { url: 'http://og.internal:8080/healthz', method: 'GET', auth: null, contract: '0.14' },
      { url: 'http://og.internal:8080/healthz', method: 'HEAD', auth: null, contract: '0.14' },
      { url: 'http://og.internal:8080/graphs/demo/schema', method: 'GET', auth: 'Bearer secret-token', contract: '0.14' },
    ]);
  });
});

describe('browser entry accepts no raw credentials', () => {
  it('does not export createOmnigraphServerClient (runtime absence)', () => {
    const keys = Object.keys(browserEntry);
    expect(keys).not.toContain('createOmnigraphServerClient');
    expect(keys).toContain('createOmnigraphSource');
  });

  it('type-level: the source options carry a preconfigured client, never credentials', () => {
    // These constants fail `tsc` if a raw-credential option ever appears on
    // the browser options surface: no bearer-token option is allowed.
    const noToken: 'token' extends keyof OmnigraphSourceOptions ? never : true = true;
    const noBaseUrl: 'baseUrl' extends keyof OmnigraphSourceOptions ? never : true = true;
    const hasClient: 'client' extends keyof OmnigraphSourceOptions ? true : never = true;
    expect(noToken).toBe(true);
    expect(noBaseUrl).toBe(true);
    expect(hasClient).toBe(true);
  });
});
