/** Passive exploration reads and shared public-query validation. */
import { OrbitOperationError } from './errors';
import type {
  AcceptedGraph, AcceptedEdge, ExpansionOptions, NeighborhoodOptions,
  NeighborhoodResult, NodeId, NodeVisibility, PathOptions, RelationshipOptions,
} from './types';

export function invalidQuery(detail: string): never {
  throw new OrbitOperationError({ code: 'invalid-operation', detail }, detail);
}

export function boundedInteger(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) {
    invalidQuery(`${name} must be an integer from ${min} to ${max}`);
  }
  return result;
}

export function validateRelationships<T extends RelationshipOptions>(options: T): T {
  if (options.direction !== undefined && !['outgoing', 'incoming', 'either'].includes(options.direction)) {
    invalidQuery('direction must be outgoing, incoming, or either');
  }
  if (options.relationshipTypeField !== undefined && (typeof options.relationshipTypeField !== 'string' || options.relationshipTypeField.length === 0)) {
    invalidQuery('relationshipTypeField must be a non-empty string');
  }
  if (options.relationshipTypes !== undefined && (!Array.isArray(options.relationshipTypes) || options.relationshipTypes.some((v) => typeof v !== 'string'))) {
    invalidQuery('relationshipTypes must be an array of strings');
  }
  return {
    ...options,
    ...(options.relationshipTypes === undefined ? {} : { relationshipTypes: [...new Set(options.relationshipTypes)].sort() }),
  };
}

export function validateCursor(cursor: string | undefined): void {
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 100000)) {
    invalidQuery('cursor must be a non-empty continuation token');
  }
}

export function validateExpansion(options: ExpansionOptions): ExpansionOptions {
  const result = validateRelationships(options);
  boundedInteger(options.hops, 1, 1, 1000, 'hops');
  boundedInteger(options.limit, 50, 1, 1000, 'limit');
  boundedInteger(options.edgeLimit, 10000, 1, 10000, 'edgeLimit');
  validateCursor(options.cursor);
  if (options.preserveLayout !== undefined && typeof options.preserveLayout !== 'boolean') invalidQuery('preserveLayout must be boolean');
  if (options.onProgress !== undefined && typeof options.onProgress !== 'function') invalidQuery('onProgress must be a function');
  return result;
}

export function validatePath(options: PathOptions): PathOptions {
  const result = validateRelationships(options);
  if (options.universe !== undefined && options.universe !== 'visible' && options.universe !== 'loaded') invalidQuery('universe must be visible or loaded');
  if (options.maxHops !== undefined) boundedInteger(options.maxHops, 0, 0, 1000, 'maxHops');
  return result;
}

export function relationshipType<E>(edge: AcceptedEdge<E>, field = 'type'): string {
  const attrs = edge.attrs as Record<string, unknown> | undefined;
  const value = attrs?.[field];
  return typeof value === 'string' ? value : '';
}

export function matchesRelationship<E>(edge: AcceptedEdge<E>, options: RelationshipOptions): boolean {
  return options.relationshipTypes === undefined || options.relationshipTypes.includes(relationshipType(edge, options.relationshipTypeField));
}

export function pageOffset(cursor: string | undefined, key: string): number {
  if (cursor === undefined) return 0;
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (Array.isArray(parsed) && parsed.length === 2 && parsed[0] === key && Number.isSafeInteger(parsed[1]) && parsed[1] >= 0) return parsed[1] as number;
  } catch { /* typed failure below */ }
  return invalidQuery('cursor is stale or belongs to a different query');
}

export function neighborhoodOf<N, E>(
  accepted: AcceptedGraph<N, E> | null,
  seedId: NodeId,
  rawOptions: NeighborhoodOptions,
  revisionKey: string,
  visibilityOf: (id: NodeId) => NodeVisibility,
  edgeVisible: (id: string) => boolean,
): NeighborhoodResult<N, E> {
  const options = validateRelationships(rawOptions);
  const limit = boundedInteger(options.limit, 50, 1, 1000, 'limit');
  const edgeLimit = boundedInteger(options.edgeLimit, 200, 1, 10000, 'edgeLimit');
  validateCursor(options.cursor);
  if (options.visibility !== undefined && options.visibility !== 'loaded' && options.visibility !== 'visible') invalidQuery('visibility must be loaded or visible');
  const key = JSON.stringify([revisionKey, seedId, options.direction ?? 'either', options.relationshipTypes ?? null, options.relationshipTypeField ?? 'type', options.visibility ?? 'loaded', limit, edgeLimit]);
  const offset = pageOffset(options.cursor, key);
  const empty: NeighborhoodResult<N, E> = { seedId, status: 'not-loaded', nodes: [], edges: [], visibility: new Map(), relationshipTypes: [], totalNeighbors: 0, totalEdges: 0, edgesTruncated: false };
  if (accepted === null || !accepted.nodeIndex.has(seedId)) return empty;
  const neighbors = new Set<NodeId>();
  const matched: AcceptedEdge<E>[] = [];
  const counts = new Map<string, number>();
  const direction = options.direction ?? 'either';
  for (const edge of accepted.edges) {
    let neighbor: NodeId | undefined;
    if (edge.source === seedId && direction !== 'incoming') neighbor = edge.target;
    else if (edge.target === seedId && direction !== 'outgoing') neighbor = edge.source;
    if (neighbor === undefined || !accepted.nodeIndex.has(neighbor)) continue;
    if (options.visibility === 'visible' && (!edgeVisible(edge.id) || visibilityOf(neighbor) !== 'visible' || visibilityOf(seedId) !== 'visible')) continue;
    const type = relationshipType(edge, options.relationshipTypeField);
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (!matchesRelationship(edge, options)) continue;
    if (neighbor !== seedId) neighbors.add(neighbor);
    matched.push(edge);
  }
  const ids = [...neighbors].slice(offset, offset + limit);
  const pageIds = new Set([seedId, ...ids]);
  const pageEdges = matched.filter((e) => pageIds.has(e.source) && pageIds.has(e.target));
  const result: NeighborhoodResult<N, E> = {
    seedId, status: 'loaded', nodes: ids.map((id) => accepted.nodes[accepted.nodeIndex.get(id)!]!),
    edges: pageEdges.slice(0, edgeLimit), visibility: new Map(ids.map((id) => [id, visibilityOf(id)])),
    relationshipTypes: [...counts].map(([type, count]) => ({ type, count })),
    totalNeighbors: neighbors.size, totalEdges: matched.length, edgesTruncated: pageEdges.length > edgeLimit,
  };
  if (offset + limit < neighbors.size) result.nextCursor = JSON.stringify([key, offset + limit]);
  return result;
}
