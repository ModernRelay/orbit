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
 * - attr values are normalized for generated types and temporal dimensions:
 * * `Date` — export sends `'YYYY-MM-DD'`; signed years use ISO's six digits
 * * `DateTime` — export sends a UTC string without a timezone suffix →
 * ISO 8601 with explicit UTC (`'YYYY-MM-DDTHH:MM:SS.mmmZ'`)
 * * `Blob` — inline internal blobs arrive as `'base64:<data>'` →
 * `'data:application/octet-stream;base64,<data>'`;
 * external-URI refs pass through verbatim
 * * missing nullable schema properties — explicit `null`
 * * everything else — verbatim. Physical identity is top-level `id`;
 * `data.id`, when present, is an ordinary user property.
 *
 * The server rejects non-finite stored floats during export. Computed
 * non-finite query values render as null; neither path uses string sentinels.
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

/** An export line is structurally unusable (e.g. missing/non-string `id`). */
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
  id: string;
  data: Record<string, unknown>;
}

export interface EdgeExportLine {
  kind: 'edge';
  edge: string;
  id: string;
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
 * - node line: `{"type": "<NodeType>", "id": <id>, "data": {…props}}`
 * - edge line: `{"edge": "<EdgeName>", "id": <id>, "from": <src id>, "to": <dst id>, "data": {…props}}`
 * Unknown envelopes return `{ kind: 'unknown' }`. Recognized entities without
 * a physical identity reject instead of falling back to a user property.
 */
export function classifyExportLine(line: unknown): ClassifiedExportLine {
  if (!isRecord(line) || !isRecord(line['data'])) return { kind: 'unknown' };
  const data = line['data'];
  if (
    typeof line['edge'] === 'string' &&
    typeof line['from'] === 'string' &&
    typeof line['to'] === 'string'
  ) {
    return {
      kind: 'edge', edge: line['edge'], id: requireStringId(line, `Edge '${line['edge']}'`),
      from: line['from'], to: line['to'], data,
    };
  }
  if (typeof line['type'] === 'string') {
    return { kind: 'node', type: line['type'], id: requireStringId(line, `Node '${line['type']}'`), data };
  }
  return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Value normalization
// ---------------------------------------------------------------------------

/** Chrono uses -0001/+10000; ECMAScript ISO dates require -000001/+010000. */
function isoYear(wireYear: string): string {
  const year = Number(wireYear);
  return year >= 0 && year <= 9999
    ? String(year).padStart(4, '0')
    : `${year < 0 ? '-' : '+'}${String(Math.abs(year)).padStart(6, '0')}`;
}

function normalizeValue(type: PgType | undefined, value: unknown): unknown {
  if (type === undefined || value === null || value === undefined) return value;
  if (typeof type === 'object' && type.kind === 'list' && Array.isArray(value)) {
    return value.map((item) => normalizeValue(type.element, item));
  }
  if (type === 'Date') {
    const date = typeof value === 'string' ? /^([+-]?\d{4,})(-\d{2}-\d{2})$/.exec(value) : null;
    if (date === null) {
      throw new InvalidExportLineError('Date export values must be calendar-date strings');
    }
    return `${isoYear(date[1]!)}${date[2]}`;
  }
  if (type === 'DateTime') {
    // Arrow's timestamp spelling is UTC despite omitting the zone. Letting
    // Date.parse consume it unchanged would use the consumer's local zone.
    const timestamp = typeof value === 'string'
      ? /^([+-]?\d{4,})(-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/.exec(value)
      : null;
    if (timestamp === null) {
      throw new InvalidExportLineError('DateTime export values must be UTC timestamp strings without a timezone suffix');
    }
    return `${isoYear(timestamp[1]!)}${timestamp[2]}.${(timestamp[3] ?? '').padEnd(3, '0')}Z`;
  }
  if (type === 'Blob' && typeof value === 'string' && value.startsWith('base64:')) {
    return `data:application/octet-stream;base64,${value.slice('base64:'.length)}`;
  }
  return value;
}

function propMap(t: PgNodeType | PgEdgeType | undefined): ReadonlyMap<string, PgProperty> {
  const map = new Map<string, PgProperty>();
  if (t) for (const p of t.properties) map.set(p.name, p);
  return map;
}

function normalizeData(
  data: Record<string, unknown>,
  properties: ReadonlyMap<string, PgProperty>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Source data can carry '__proto__' as an own key (JSON.parse creates it);
  // defineProperty writes the own property, never the setter.
  for (const [k, v] of Object.entries(data)) {
    Object.defineProperty(out, k, {
      value: normalizeValue(properties.get(k)?.type, v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  for (const property of properties.values()) {
    if (property.optional && !Object.prototype.hasOwnProperty.call(data, property.name)) {
      Object.defineProperty(out, property.name, { value: null, enumerable: true, writable: true, configurable: true });
    }
  }
  return out;
}

function requireStringId(line: { id?: unknown }, what: string): string {
  const id = line.id;
  if (typeof id !== 'string') {
    throw new InvalidExportLineError(
      `${what} export line has ${id === undefined ? 'no' : 'a non-string'} top-level 'id' — ` +
        `cannot build a stable orbit id; id must be a string, separate from user properties.`,
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
 * `id = encodeSourceId(type, id)`, `attrs = { …data, 'orbit:type' }`
 * with value normalization driven by the schema's property types. A node type
 * absent from the schema is tolerated — its attrs pass through verbatim
 * (identity never needs the schema on the node path).
 */
export function normalizeNode(
  line: { type: string; id: string; data: Record<string, unknown> },
  schema: PgSchema,
): GraphNode {
  const nodeType = schema.nodes.find((n) => n.name === line.type);
  const id = encodeSourceId(line.type, requireStringId(line, `Node '${line.type}'`));
  return {
    id,
    // The discriminator is adapter-owned identity metadata. It lands LAST so
    // a forward-compatible export field literally named `orbit:type` cannot
    // forge the value the generated attrs unions promise.
    attrs: { ...normalizeData(line.data, propMap(nodeType)), [ORBIT_TYPE_KEY]: line.type },
  };
}

/**
 * Normalize an edge export line to a `GraphEdge`:
 * `id = encodeSourceId(edge, id)`; `source`/`target` namespace the bare
 * `from`/`to` ids with the endpoint node types resolved from the schema.
 * Throws {@link UnknownEdgeTypeError} when the schema does not declare
 * the edge — endpoint identity cannot be constructed without it.
 */
export function normalizeEdge(
  line: { edge: string; id: string; from: string; to: string; data: Record<string, unknown> },
  schema: PgSchema,
): GraphEdge {
  const endpoints = edgeEndpointTypes(schema, line.edge);
  if (endpoints === null) throw new UnknownEdgeTypeError(line.edge);
  const lower = line.edge.toLowerCase();
  const edgeType =
    schema.edges.find((e) => e.name === line.edge) ??
    schema.edges.find((e) => e.name.toLowerCase() === lower);
  const id = encodeSourceId(line.edge, requireStringId(line, `Edge '${line.edge}'`));
  return {
    id,
    source: encodeSourceId(endpoints.from, line.from),
    target: encodeSourceId(endpoints.to, line.to),
    // As on nodes, the adapter's resolved edge name lands last and always
    // wins the discriminator key; a source `type` property is ordinary data.
    attrs: { ...normalizeData(line.data, propMap(edgeType)), [ORBIT_TYPE_KEY]: line.edge },
  };
}
