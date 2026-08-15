/**
 * Stored-query `SearchService` integration.
 *
 * A stored query using `bm25`/`fuzzy`/`nearest`/`rrf` with
 * `order { score desc } limit K` returns entity rows plus a score column; this
 * module wires it as a `SearchService` via
 * `og.queries.invoke(name, { params, branch })`, passing
 * `RequestContext.signal` through SDK `CallOptions`. Core performs revision
 * admission — the service only declares `revisionDependencies: ['source']`
 * (results come from the server-side branch, so they are invalidated by a
 * source change, never by client-side model/scope drift).
 *
 * Identity: Omnigraph ids are unique per type only, and a query row
 * carries no type discriminator of its own — so the adapter REQUIRES a
 * caller-supplied column→node-type mapping (`typeOf`), either a
 * `{ column: NodeType }` record keyed by the projection columns that hold
 * bare-variable node structs, or a per-row function. Every returned id is
 * qualified through `encodeSourceId(nodeType, physicalId)` — the same codec
 * every other adapter path uses — so results round-trip `decodeSourceId` and
 * match export-loaded node ids exactly.
 *
 * Partial-load caveat: search runs server-side over the whole branch, so a
 * partial export load can return ids outside the loaded set.
 * `activateSearchResult` classifies those as `'not-loaded'`; constrain the
 * stored query to the loaded types, or load the full graph, to avoid the
 * mismatch.
 *
 * Error surface: SDK typed errors never cross this package's public
 * surface — they rethrow as plain `Error`s with the stable `omnigraph:`
 * prefix. Abort rejections pass through unchanged.
 */

import { OmnigraphError } from '@modernrelay/omnigraph';
import type { InvokeQueryInput, Omnigraph } from '@modernrelay/omnigraph';
import type { RequestContext, SearchResult, SearchService } from '@modernrelay/orbit-core';

import { encodeSourceId } from './idCodec';

/** One stored-query result row: projection column → value. Bare-variable
 * projections (`return { $s }`) hold whole-node structs including `id`. */
export type OmnigraphSearchRow = Record<string, unknown>;

/**
 * The required column→node-type mapping:
 *
 * - a record `{ '$s': 'Signal' }` — the FIRST listed column present in a row
 * with a node struct supplies the physical id, encoded under the mapped
 * type name;
 * - or a per-row function returning the node type name — the row's first
 * node-struct column (row key order) supplies the physical id.
 */
export type OmnigraphSearchTypeOf =
  | ((row: OmnigraphSearchRow) => string)
  | Readonly<Record<string, string>>;

export interface OmnigraphSearchServiceOptions<N = Record<string, unknown>> {
  /** A **preconfigured** SDK client — no `baseUrl`/`token` here. */
  client: Omnigraph;
  /** Cluster graph id; the invoke is scoped via `client.graph(graphId)`. */
  graphId: string;
  /** Branch the stored query reads. Default `'main'`. */
  branch?: string;
  /** Registry name of the stored search query (`POST /queries/{name}`).
   * Invoking a known name works whether or not it is `mcp.expose`d. */
  queryName: string;
  /** Builds the stored query's `params` object from the call.
   * Default: `(q, limit) => ({ q, limit })`. */
  params?: (q: string, limit: number) => Record<string, unknown>;
  /** REQUIRED mapping from row to node type — see
   * {@link OmnigraphSearchTypeOf}. */
  typeOf: OmnigraphSearchTypeOf;
  /** Column whose value becomes `label` (String-coerced when present).
   * Default: the first string-valued column in row key order. */
  labelColumn?: string;
  /** Full custom row→result escape hatch: overrides the default mapping
   * (including `typeOf`/`labelColumn`); return `null` to skip a row. The
   * returned `id` MUST already be type-qualified via `encodeSourceId`. */
  mapRow?: (row: OmnigraphSearchRow) => SearchResult<N> | null;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function defaultParams(q: string, limit: number): Record<string, unknown> {
  return { q, limit };
}

function throwIfAborted(signal: AbortSignal, queryName: string): void {
  if (signal.aborted) {
    throw new DOMException(
      `omnigraph: search query '${queryName}' aborted by request signal`,
      'AbortError',
    );
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** SDK typed errors rethrow as plain prefixed `Error`s; abort rejections
 * and everything else pass through unchanged. */
function mapError(err: unknown): unknown {
  if (err instanceof OmnigraphError && !isAbortError(err)) {
    return new Error(`omnigraph: ${err.name} (status ${err.status}): ${err.message}`);
  }
  return err;
}

/** A bare-variable projection value: a whole-node struct carrying its
 * physical id (`return { $s }` yields `{ id,...props }`). */
function isNodeStruct(value: unknown): value is { id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/** The invoke response must be a READ envelope with tabular rows — a stored
 * mutation (Change envelope) or malformed body is a hard error. */
function extractRows(response: unknown, queryName: string): readonly OmnigraphSearchRow[] {
  const rows = (response as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) {
    throw new Error(
      `omnigraph: stored query '${queryName}' did not return a read envelope with rows — ` +
        `the configured search query must be a stored READ query (not a mutation)`,
    );
  }
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(
        `omnigraph: stored query '${queryName}' returned a non-object row — ` +
          `expected column→value row objects`,
      );
    }
  }
  return rows as OmnigraphSearchRow[];
}

interface ResolvedIdentity {
  kind: string;
  sourceId: string;
}

/** Resolve the `(nodeType, physicalId)` pair for one row via `typeOf`. */
function resolveIdentity(
  row: OmnigraphSearchRow,
  typeOf: OmnigraphSearchTypeOf,
  queryName: string,
): ResolvedIdentity {
  if (typeof typeOf === 'function') {
    const kind = typeOf(row);
    if (typeof kind !== 'string' || kind.length === 0) {
      throw new Error(
        `omnigraph: typeOf returned ${JSON.stringify(kind)} for a '${queryName}' search row — ` +
          `typeOf must return a non-empty node type name`,
      );
    }
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (isNodeStruct(value)) return { kind, sourceId: value.id };
    }
    throw new Error(
      `omnigraph: '${queryName}' search row has no node-struct column (an object with a ` +
        `string 'id') — project the matched entity bare (return { $s }) so its physical ` +
        `id is available`,
    );
  }
  for (const [column, kind] of Object.entries(typeOf)) {
    const value = row[column];
    if (isNodeStruct(value)) return { kind, sourceId: value.id };
  }
  throw new Error(
    `omnigraph: '${queryName}' search row has no node struct under the mapped column(s) ` +
      `${JSON.stringify(Object.keys(typeOf))} — the typeOf record must key the ` +
      `columns that contain bare-variable node projections`,
  );
}

// ---------------------------------------------------------------------------
// createOmnigraphSearchService
// ---------------------------------------------------------------------------

/**
 * Create the stored-query search service. Plug it into core as
 * `services.search`; the instance owns `RequestContext` creation,
 * revision-keyed caching, supersede cancellation, and stale-result rejection
 * at admission.
 */
export function createOmnigraphSearchService<N = Record<string, unknown>>(
  options: OmnigraphSearchServiceOptions<N>,
): SearchService<N> {
  const { graphId, queryName, typeOf, labelColumn, mapRow } = options;
  const branch = options.branch ?? 'main';
  const buildParams = options.params ?? defaultParams;
  /** Every call is scoped to the graph (SDK cluster routing). */
  const client: Omnigraph = options.client.graph(graphId);

  function mapRowDefault(row: OmnigraphSearchRow): SearchResult<N> {
    const { kind, sourceId } = resolveIdentity(row, typeOf, queryName);
    const result: SearchResult<N> = { id: encodeSourceId(kind, sourceId) };

    const score = row['score'];
    if (typeof score === 'number' && Number.isFinite(score)) result.score = score;

    if (labelColumn !== undefined) {
      const value = row[labelColumn];
      if (typeof value === 'string' || typeof value === 'number') result.label = String(value);
    } else {
      for (const key of Object.keys(row)) {
        if (key === 'score') continue; // the score lane never doubles as a label
        const value = row[key];
        if (typeof value === 'string') {
          result.label = value;
          break;
        }
      }
    }
    return result;
  }

  return {
    revisionDependencies: ['source'],
    async search(
      q: string,
      searchOptions: { limit: number },
      ctx: RequestContext,
    ): Promise<readonly SearchResult<N>[]> {
      throwIfAborted(ctx.signal, queryName);
      const limit = Number.isFinite(searchOptions.limit) ? Math.floor(searchOptions.limit) : 0;
      if (q.length === 0 || limit <= 0) return [];

      const input: InvokeQueryInput = { branch, params: buildParams(q, limit) };
      let response: unknown;
      try {
        response = await client.queries.invoke(queryName, input, { signal: ctx.signal });
      } catch (err) {
        throw mapError(err);
      }
      throwIfAborted(ctx.signal, queryName);

      const rows = extractRows(response, queryName);
      const results: SearchResult<N>[] = [];
      for (const row of rows) {
        if (results.length >= limit) break; // defensive cap — the query owns K
        const mapped = mapRow !== undefined ? mapRow(row) : mapRowDefault(row);
        if (mapped !== null) results.push(mapped);
      }
      return results;
    },
  };
}
