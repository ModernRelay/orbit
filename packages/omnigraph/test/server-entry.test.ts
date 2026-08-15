/**
 * Entry-boundary contract: the `/server` entry is the ONLY place for
 * authenticated construction; the browser entry exposes no token-accepting
 * API anywhere. (The bundle-level exclusion is enforced by the
 * `treeshake:omnigraph-client` gate in scripts/pack-smoke.mjs.)
 */

import { Omnigraph } from '@modernrelay/omnigraph';
import type { FetchLike } from '@modernrelay/omnigraph';
import { describe, expect, it } from 'vitest';

import * as browserEntry from '../src/index';
import type { OmnigraphSourceOptions } from '../src/index';
import { createOmnigraphServerClient } from '../src/server';

describe('createOmnigraphServerClient in the server-only entry', () => {
  it('constructs a real SDK client that authenticates with the bearer token', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetch: FetchLike = async (input, init) => {
      seen.push({
        url: input instanceof Request ? input.url : String(input),
        auth: new Headers(init?.headers).get('authorization'),
      });
      return new Response(
        JSON.stringify({ status: 'ok', version: '0.8.1', internal_schema_version: 4 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const client = createOmnigraphServerClient({
      baseUrl: 'http://og.internal:8080',
      token: 'secret-token',
      fetch,
    });

    expect(client).toBeInstanceOf(Omnigraph);
    const health = await client.health();
    expect(health.version).toBe('0.8.1');
    expect(seen).toEqual([
      { url: 'http://og.internal:8080/healthz', auth: 'Bearer secret-token' },
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
