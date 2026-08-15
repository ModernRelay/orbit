/**
 * Identity codec.
 *
 * Omnigraph node ids are unique **per type only** (derived from the `@key`
 * tuple within each type's table), so unqualified ids are unsound as orbit
 * `NodeId`s. Every adapter path — nodes, edges, search results, view state,
 * services — MUST qualify ids through this one collision-proof tuple codec.
 * `JSON.stringify` of a fixed-arity string tuple is injective over its inputs
 * (quotes, brackets, commas, and unicode in either component are escaped), so
 * no `(kind, sourceId)` pair can collide with a different pair.
 *
 * Human-readable labels stay separate from identity; there is deliberately no
 * `namespaceIds:false` escape hatch.
 */

export interface DecodedSourceId {
  /** The namespace component: a node type name or an edge type name. */
  kind: string;
  /** The physical Omnigraph id within that type's table. */
  sourceId: string;
}

/**
 * Encode a `(kind, sourceId)` pair as a collision-proof orbit id.
 *
 * - Nodes: `encodeSourceId(NodeType, data.id)`
 * - Edges: `encodeSourceId(EdgeName, data.id)`; endpoints use
 * `encodeSourceId(endpointType, from|to)`.
 */
export function encodeSourceId(kind: string, sourceId: string): string {
  return JSON.stringify([kind, sourceId]);
}

/**
 * Decode an id produced by {@link encodeSourceId}.
 *
 * Returns `null` for anything that does not conform exactly (non-JSON input,
 * non-array JSON, wrong arity — including synthetic edge ids, which are
 * 4-tuples — or non-string elements). Never throws.
 */
export function decodeSourceId(id: string): DecodedSourceId | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(id);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [kind, sourceId] = parsed as unknown[];
  if (typeof kind !== 'string' || typeof sourceId !== 'string') return null;
  return { kind, sourceId };
}

/**
 * Synthetic edge id for **query-derived** subgraphs.
 *
 * The GQ grammar has no edge variable, so the query path can never surface
 * physical edge ids; query-derived edges are identified by
 * `['synthetic-edge', EdgeName, source, target]` where `source`/`target` are
 * the already-encoded endpoint node ids.
 *
 * Exported for the future query path.
 * Caveats: parallel edges collapse under this scheme, and a dataset
 * MUST NOT mix synthetic ids with physical `/export` ids for the same edges
 * one scheme per dataset, never both. Because a synthetic id is a 4-tuple,
 * {@link decodeSourceId} rejects it (`null`), keeping the two schemes
 * mechanically un-confusable.
 */
export function encodeSyntheticEdgeId(edgeName: string, source: string, target: string): string {
  return JSON.stringify(['synthetic-edge', edgeName, source, target]);
}
