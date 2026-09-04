/**
 * Export-line classification and normalization.
 *
 * `/export` streams NDJSON — one JSON object per line, `data` passed through
 * **verbatim** by the SDK. This module turns those lines into orbit
 * `GraphNode`/`GraphEdge` values:
 *
 * - ids are namespaced through the adapter identity codec (`encodeSourceId`),
 * - the node/edge KIND is injected as {@link ORBIT_TYPE_KEY} — namespaced so
 * a schema's own `type` property passes through as ordinary data,
 * - edge endpoint types are resolved from the `.pg` schema because edge lines
 * carry bare `from`/`to` ids,
 * - attr values are normalized to the query-path string forms so
 * generated types and temporal dimensions see one encoding
 * regardless of read path:
 * * `Date` — export sends **days since Unix epoch** (number) →
 * `'YYYY-MM-DD'` (UTC)
 * * `DateTime` — export sends **epoch milliseconds** (number) →
 * ISO 8601 (`'YYYY-MM-DDTHH:MM:SS.mmmZ'`)
 * * `Blob` — inline internal blobs arrive as `'base64:<data>'` →
 * `'data:application/octet-stream;base64,<data>'`;
 * external-URI refs pass through verbatim
 * * everything else — verbatim.
 *
 * Non-finite float sentinels (`'NaN'`/`'Infinity'`/`'-Infinity'`) are a
 * **query-path-only** encoding: a non-finite stored float aborts `/export`
 * server-side, so export-loaded data never contains the sentinels.
 * This module therefore does NOT special-case them.
 */

import type { GraphEdge, GraphNode } from '@modernrelay/orbit-core';
import { encodeSourceId } from './idCodec';
import {
  edgeEndpointTypes,
  type PgEdgeType,
  type PgNodeType,
  type PgProperty,
  type PgSchema,
  type PgType,
} from './pgSchema';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** An edge line names an edge type the `.pg` schema does not declare. */
export class UnknownEdgeTypeError extends Error {
  override readonly name = 'UnknownEdgeTypeError';
  readonly edgeName: string;
  constructor(edgeName: string) {
    super(
      `Unknown edge type '${edgeName}': not declared in the graph schema, so its ` +
        `endpoint node types cannot be resolved.`,
    );
    this.edgeName = edgeName;
  }
}

/** An export line is structurally unusable (e.g. missing/non-string `data.id`). */
export class InvalidExportLineError extends Error {
  override readonly name = 'InvalidExportLineError';
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface NodeExportLine {
  kind: 'node';
  type: string;
  data: Record<string, unknown>;
}

export interface EdgeExportLine {
  kind: 'edge';
  edge: string;
  from: string;
  to: string;
  data: Record<string, unknown>;
}

export type ClassifiedExportLine = NodeExportLine | EdgeExportLine | { kind: 'unknown' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Classify one parsed export line using the adapter's wire shapes:
 * - node line: `{"type": "<NodeType>", "data": {"id", …props}}`
 * - edge line: `{"edge": "<EdgeName>", "from": <src id>, "to": <dst id>, "data": {"id", …props}}`
 * Anything else is `{ kind: 'unknown' }`.
 */
export function classifyExportLine(line: unknown): ClassifiedExportLine {
  if (!isRecord(line) || !isRecord(line['data'])) return { kind: 'unknown' };
  const data = line['data'];
  if (
    typeof line['edge'] === 'string' &&
    typeof line['from'] === 'string' &&
    typeof line['to'] === 'string'
  ) {
    return { kind: 'edge', edge: line['edge'], from: line['from'], to: line['to'], data };
  }
  if (typeof line['type'] === 'string') {
    return { kind: 'node', type: line['type'], data };
  }
  return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Format an epoch-day count as `'YYYY-MM-DD'` (UTC). Handles negative days. */
function formatEpochDay(days: number): string {
  const d = new Date(days * MS_PER_DAY);
  const t = d.getTime();
  if (!Number.isFinite(t)) return String(days); // out of Date range — leave a readable value
  const y = d.getUTCFullYear();
  const year =
    y < 0
      ? `-${String(-y).padStart(6, '0')}`
      : y > 9999
        ? `+${String(y).padStart(6, '0')}`
        : String(y).padStart(4, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeValue(type: PgType | undefined, value: unknown): unknown {
  if (type === undefined || value === null || value === undefined) return value;
  if (typeof type === 'object' && type.kind === 'list' && Array.isArray(value)) {
    return value.map((item) => normalizeValue(type.element, item));
  }
  if (type === 'Date' && typeof value === 'number' && Number.isInteger(value)) {
    return formatEpochDay(value);
  }
  if (type === 'DateTime' && typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : value;
  }
  if (type === 'Blob' && typeof value === 'string' && value.startsWith('base64:')) {
    return `data:application/octet-stream;base64,${value.slice('base64:'.length)}`;
  }
  return value;
}

function propTypeMap(t: PgNodeType | PgEdgeType | undefined): ReadonlyMap<string, PgType> {
  const map = new Map<string, PgType>();
  if (t) for (const p of t.properties as readonly PgProperty[]) map.set(p.name, p.type);
  return map;
}

function normalizeData(
  data: Record<string, unknown>,
  types: ReadonlyMap<string, PgType>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Source data can carry '__proto__' as an own key (JSON.parse creates it);
  // defineProperty writes the own property, never the setter.
  for (const [k, v] of Object.entries(data)) {
    Object.defineProperty(out, k, {
      value: normalizeValue(types.get(k), v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function requireStringId(data: Record<string, unknown>, what: string): string {
  const id = data['id'];
  if (typeof id !== 'string') {
    throw new InvalidExportLineError(
      `${what} export line has ${id === undefined ? 'no' : 'a non-string'} 'data.id' — ` +
        `cannot build a stable orbit id; data.id must be a string.`,
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Node / edge normalization
// ---------------------------------------------------------------------------

/**
 * The adapter's node/edge KIND discriminator key.
 *
 * Namespaced on purpose: the adapter injects this field into someone else's
 * data, so it takes the awkward key and leaves the generic word `type` to the
 * schema author, who means something real by it (`Company.type = investor`).
 * A colon is illegal in `.pg` identifiers, so no schema property can ever
 * claim this key — the collision class is closed by construction, and a
 * source-declared `type` now flows through untouched with no preservation
 * mechanism, no warning, and no schema migration. Same convention as
 * GraphQL's `__typename` / JSON-LD's `@type`.
 */
export const ORBIT_TYPE_KEY = 'orbit:type';

/**
 * Normalize a node export line to a `GraphNode`:
 * `id = encodeSourceId(type, data.id)`, `attrs = { …data, 'orbit:type' }`
 * with value normalization driven by the schema's property types. A node type
 * absent from the schema is tolerated — its attrs pass through verbatim
 * (identity never needs the schema on the node path).
 */
export function normalizeNode(
  line: { type: string; data: Record<string, unknown> },
  schema: PgSchema,
): GraphNode {
  const nodeType = schema.nodes.find((n) => n.name === line.type);
  const id = encodeSourceId(line.type, requireStringId(line.data, `Node '${line.type}'`));
  return {
    id,
    // The discriminator is adapter-owned identity metadata. It lands LAST so
    // a forward-compatible export field literally named `orbit:type` cannot
    // forge the value the generated attrs unions promise.
    attrs: { ...normalizeData(line.data, propTypeMap(nodeType)), [ORBIT_TYPE_KEY]: line.type },
  };
}

/**
 * Normalize an edge export line to a `GraphEdge`:
 * `id = encodeSourceId(edge, data.id)`; `source`/`target` namespace the bare
 * `from`/`to` ids with the endpoint node types resolved from the schema.
 * Throws {@link UnknownEdgeTypeError} when the schema does not declare
 * the edge — endpoint identity cannot be constructed without it.
 */
export function normalizeEdge(
  line: { edge: string; from: string; to: string; data: Record<string, unknown> },
  schema: PgSchema,
): GraphEdge {
  const endpoints = edgeEndpointTypes(schema, line.edge);
  if (endpoints === null) throw new UnknownEdgeTypeError(line.edge);
  const lower = line.edge.toLowerCase();
  const edgeType =
    schema.edges.find((e) => e.name === line.edge) ??
    schema.edges.find((e) => e.name.toLowerCase() === lower);
  const id = encodeSourceId(line.edge, requireStringId(line.data, `Edge '${line.edge}'`));
  return {
    id,
    source: encodeSourceId(endpoints.from, line.from),
    target: encodeSourceId(endpoints.to, line.to),
    // As on nodes, the adapter's resolved edge name lands last and always
    // wins the discriminator key; a source `type` property is ordinary data.
    attrs: { ...normalizeData(line.data, propTypeMap(edgeType)), [ORBIT_TYPE_KEY]: line.edge },
  };
}
