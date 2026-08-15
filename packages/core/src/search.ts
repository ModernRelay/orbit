/**
 * search — the SearchService contract plus the built-in LOCAL indexed
 * service.
 *
 * The default service is client-side and field-scoped: it indexes the node id
 * ALWAYS plus `attrs[field]` (String-coerced) for each field the host
 * declared via `searchIndex` — it never guesses privileged attr names, so a
 * missing declaration leaves the service id-only. Matching is a
 * case-insensitive SUBSTRING scan over ONE precomputed lowercase haystack per
 * node (id + indexed field values joined with unit separators) — NOT a
 * per-keystroke re-tokenization: the index builds once per model revision
 * (lazily, on the first search that sees the new revision) and every query
 * against that revision reuses it.
 *
 * Scoring: exact-id match {@link SEARCH_SCORE_EXACT_ID}, id-prefix
 * {@link SEARCH_SCORE_ID_PREFIX}, field/id substring
 * {@link SEARCH_SCORE_SUBSTRING} (+{@link SEARCH_SCORE_TOKEN_START_BONUS}
 * when the match starts a token). Results sort score-desc then accepted-base
 * order; `label` is the first matching indexed field's ORIGINAL value (the id
 * when only the id matched).
 *
 * `ctx.signal` is honored between scan chunks (an awaited microtask every
 * {@link SEARCH_SCAN_CHUNK} nodes) — abort is an optimization; the instance's
 * admission gate is the correctness gate. Nothing here touches the
 * engine, the store, or the DOM.
 */

import { OrbitOperationError } from './errors';
import type { GraphNode, RequestContext, RevisionAwareService, SearchResult } from './types';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** Search resolver: custom services plug in server-side search; the instance
 * owns RequestContext creation, revision-keyed
 * caching, supersede cancellation, and stale-result rejection at admission. */
export interface SearchService<N = Record<string, unknown>> extends RevisionAwareService {
  search(
    q: string,
    options: { limit: number },
    ctx: RequestContext,
  ): Promise<readonly SearchResult<N>[]>;
}

/** Accepted-base view the local service indexes (thunked for lazy wiring
 * the instance re-reads it on every call, so the service can be constructed
 * before any data arrives). */
export interface LocalSearchBase<N = Record<string, unknown>> {
  /** Accepted-model nodes in accepted-base order (the tie-break order). */
  nodes: readonly GraphNode<N>[];
  /** declared attr fields; undefined = id-only search (the service
   * never guesses attr names). */
  searchIndex: readonly string[] | undefined;
}

/** The built-in service plus its test seam: how many times the index was
 * (re)built — pins "one build per model revision, not one per keystroke". */
export interface LocalSearchService<N = Record<string, unknown>> extends SearchService<N> {
  readonly buildCount: number;
}

// ---------------------------------------------------------------------------
// Scoring contract
// ---------------------------------------------------------------------------

export const SEARCH_SCORE_EXACT_ID = 3;
export const SEARCH_SCORE_ID_PREFIX = 2;
export const SEARCH_SCORE_SUBSTRING = 1;
/** A declared field EQUALS the query (case-insensitive): the strongest
 * field lane — an exact name match must outrank every id-substring flood. */
const SEARCH_SCORE_EXACT_FIELD = 2.5;
/** A declared field STARTS WITH the query. */
const SEARCH_SCORE_FIELD_PREFIX = 1.5;
export const SEARCH_SCORE_TOKEN_START_BONUS = 0.25;

/** Nodes scanned between cooperative yields (awaited microtask + signal check). */
export const SEARCH_SCAN_CHUNK = 4096;

/** Unit separator joining haystack lanes — prevents cross-value substring
 * matches (a query never legitimately contains U+001F). */
const UNIT_SEPARATOR = '';

// ---------------------------------------------------------------------------
// Index model
// ---------------------------------------------------------------------------

/** One indexed node: the precomputed lowercase haystack plus the per-field
 * lanes needed for scoring and label selection. */
interface IndexEntry {
  id: string;
  idLower: string;
  /** idLower + indexed field lowers, unit-separator joined. */
  haystack: string;
  /** ORIGINAL String-coerced values of present indexed fields, in declared
   * field order (label source). */
  fieldValues: readonly string[];
  /** Lowercase mirror of `fieldValues` (match/scoring lane). */
  fieldLowers: readonly string[];
}

function buildEntries<N>(
  nodes: readonly GraphNode<N>[],
  fields: readonly string[],
): IndexEntry[] {
  const entries: IndexEntry[] = new Array<IndexEntry>(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const idLower = node.id.toLowerCase();
    let fieldValues: string[];
    let fieldLowers: string[];
    let haystack: string;
    if (fields.length === 0) {
      fieldValues = [];
      fieldLowers = [];
      haystack = idLower;
    } else {
      fieldValues = [];
      fieldLowers = [];
      const attrs = node.attrs as Record<string, unknown> | undefined;
      for (const field of fields) {
        const raw = attrs?.[field];
        if (raw === undefined || raw === null) continue;
        const value = String(raw);
        fieldValues.push(value);
        fieldLowers.push(value.toLowerCase());
      }
      haystack =
        fieldLowers.length === 0 ? idLower : idLower + UNIT_SEPARATOR + fieldLowers.join(UNIT_SEPARATOR);
    }
    entries[i] = { id: node.id, idLower, haystack, fieldValues, fieldLowers };
  }
  return entries;
}

/** Match position starts a token when it is at index 0 or follows a
 * non-letter/digit character (word boundary). */
function isTokenStart(value: string, index: number): boolean {
  if (index <= 0) return true;
  const before = value.charAt(index - 1);
  return !/[\p{L}\p{N}]/u.test(before);
}

interface ScoredMatch {
  score: number;
  label: string;
}

/** Score one entry against the lowercased needle, or null when it does not
 * match. The haystack test is the single cheap gate; scoring then looks at
 * the individual lanes. */
function scoreEntry(entry: IndexEntry, needle: string): ScoredMatch | null {
  if (!entry.haystack.includes(needle)) return null;
  // First matching indexed field (declared order) supplies the label and the
  // field-substring score lane.
  let fieldLabel: string | null = null;
  let fieldScore = 0;
  for (let i = 0; i < entry.fieldLowers.length; i++) {
    const lower = entry.fieldLowers[i]!;
    const at = lower.indexOf(needle);
    if (at < 0) continue;
    fieldLabel = entry.fieldValues[i]!;
    // Tiered field lane (declared-field order picks the label; the BEST
    // tier across fields would cost another pass — first match wins, which
    // is deterministic and cheap):
    if (lower === needle) {
      fieldScore = SEARCH_SCORE_EXACT_FIELD;
    } else if (lower.startsWith(needle)) {
      fieldScore = SEARCH_SCORE_FIELD_PREFIX;
    } else {
      fieldScore =
        SEARCH_SCORE_SUBSTRING +
        (isTokenStart(lower, at) ? SEARCH_SCORE_TOKEN_START_BONUS : 0);
    }
    break;
  }
  let score: number;
  if (entry.idLower === needle) {
    score = SEARCH_SCORE_EXACT_ID;
  } else if (entry.idLower.startsWith(needle)) {
    score = SEARCH_SCORE_ID_PREFIX;
  } else if (fieldLabel !== null) {
    score = fieldScore;
  } else {
    const at = entry.idLower.indexOf(needle);
    // The haystack matched but no individual lane did: the needle spanned a
    // unit separator (it contained U+001F) — not a real match.
    if (at < 0) return null;
    score =
      SEARCH_SCORE_SUBSTRING +
      (isTokenStart(entry.idLower, at) ? SEARCH_SCORE_TOKEN_START_BONUS : 0);
  }
  return { score, label: fieldLabel ?? entry.id };
}

function throwAborted(signal: AbortSignal, query: string): never {
  const reason = (signal as { reason?: unknown }).reason;
  throw new OrbitOperationError(
    reason === undefined ? { code: 'aborted' } : { code: 'aborted', cause: reason },
    `local search('${query}') aborted mid-scan`,
  );
}

// ---------------------------------------------------------------------------
// The built-in local search service
// ---------------------------------------------------------------------------

/**
 * Creates the default indexed search service over the accepted model.
 * Declares `revisionDependencies: ['source', 'model']` — the index keys on
 * `ctx.modelRevision` (plus the declared field list), so it builds at most
 * once per model revision and a stale-model result is discarded by the
 * instance's admission gate. `getBase` is a thunk re-read on every call so
 * the instance can wire the service before data arrives.
 */
export function createLocalSearchService<N = Record<string, unknown>>(
  getBase: () => LocalSearchBase<N>,
): LocalSearchService<N> {
  let entries: IndexEntry[] = [];
  let indexedModelRevision: number | null = null;
  let indexedFieldsKey: string | null = null;
  let buildCount = 0;

  /** Lazily (re)build the index: once per {model revision, declared fields}
   * coordinate — never per query. */
  function ensureIndex(modelRevision: number): IndexEntry[] {
    const base = getBase();
    const fields = base.searchIndex ?? [];
    const fieldsKey = fields.join(UNIT_SEPARATOR);
    if (indexedModelRevision === modelRevision && indexedFieldsKey === fieldsKey) {
      return entries;
    }
    entries = buildEntries(base.nodes, fields);
    indexedModelRevision = modelRevision;
    indexedFieldsKey = fieldsKey;
    buildCount++;
    return entries;
  }

  return {
    revisionDependencies: ['source', 'model'],
    get buildCount(): number {
      return buildCount;
    },
    async search(
      q: string,
      options: { limit: number },
      ctx: RequestContext,
    ): Promise<readonly SearchResult<N>[]> {
      if (ctx.signal.aborted) throwAborted(ctx.signal, q);
      const limit = Number.isFinite(options.limit) ? Math.floor(options.limit) : 0;
      const needle = q.toLowerCase();
      const index = ensureIndex(ctx.modelRevision);
      if (needle.length === 0 || limit <= 0) return [];
      const matches: { id: string; score: number; label: string; order: number }[] = [];
      for (let i = 0; i < index.length; i++) {
        if (i > 0 && i % SEARCH_SCAN_CHUNK === 0) {
          // Cooperative yield between scan chunks; the signal is the
          // cancellation seam.
          await Promise.resolve();
          if (ctx.signal.aborted) throwAborted(ctx.signal, q);
        }
        const entry = index[i]!;
        const hit = scoreEntry(entry, needle);
        if (hit !== null) matches.push({ id: entry.id, score: hit.score, label: hit.label, order: i });
      }
      // Score desc, then accepted-base order (deterministic tie-break).
      matches.sort((a, b) => b.score - a.score || a.order - b.order);
      const bounded = matches.length > limit ? matches.slice(0, limit) : matches;
      return bounded.map(({ id, score, label }) => ({ id, score, label }));
    },
  };
}
