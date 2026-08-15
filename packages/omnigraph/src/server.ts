/**
 * @modernrelay/orbit-omnigraph/server — **SERVER-ONLY** entry.
 *
 * This module is the ONLY place in the adapter where an authenticated
 * Omnigraph client is constructed. It must never be imported from browser
 * code: `omnigraph-server` ships no CORS configuration and uses static
 * bearer tokens (secret material), so browser deployments pass a
 * preconfigured safe same-origin/public client to `createOmnigraphSource`
 * instead — typically routing reads through a proxy/BFF. The client-bundle
 * exclusion gate in `scripts/pack-smoke.mjs` checks the
 * `createOmnigraphServerClient` sentinel and enforces that the browser entry
 * never pulls this module in.
 */

import { Omnigraph } from '@modernrelay/omnigraph';
import type { FetchLike, OmnigraphOptions } from '@modernrelay/omnigraph';

export interface OmnigraphServerClientOptions {
  /** Base URL of the omnigraph-server, e.g. `http://127.0.0.1:8080`. */
  baseUrl: string;
  /** Static bearer token — secret material; must stay server-side. */
  token: string;
  /** Inject a custom fetch (tracing, agents, testing). */
  fetch?: FetchLike;
}

/**
 * Construct an authenticated Omnigraph SDK client for server-only use. Pass
 * the result to `createOmnigraphSource({ client,... })` in server code, or
 * hand graph-scoped clones out via `client.graph(id)`.
 */
export function createOmnigraphServerClient(options: OmnigraphServerClientOptions): Omnigraph {
  const opts: OmnigraphOptions = { baseUrl: options.baseUrl, token: options.token };
  if (options.fetch !== undefined) opts.fetch = options.fetch;
  return new Omnigraph(opts);
}
