import type {
  ExpansionQuery,
  ExpansionResponse,
  GraphInstance,
  GraphServices,
  RequestContext,
} from '@modernrelay/orbit-core';
import { catalogEdges, catalogNodes, delay } from './supplyChain';
import type { Entity, Relationship } from './supplyChain';

export interface ServiceEvent {
  request: string;
  operation: string;
  status: 'started' | 'completed' | 'cancelled' | 'failed';
}

/**
 * A small backend simulator. It owns the FULL catalog, while Orbit starts with
 * six nodes. Requests really await a timer, observe AbortSignal, paginate, and
 * return async batches. In production these bodies can use fetch({ signal }).
 */
export function createSupplyChainServices(
  report: (event: ServiceEvent) => void = () => undefined,
): GraphServices<Entity, Relationship> {
  async function queryNeighbors(
    seeds: readonly string[],
    options: ExpansionQuery,
    ctx: RequestContext,
  ): Promise<ExpansionResponse<Entity, Relationship>> {
    const operation = `Neighbors of ${seeds.join(', ')}`;
    const record = (status: ServiceEvent['status']): void => report({ request: ctx.requestId, operation, status });
    record('started');
    try {
      await delay(450, ctx.signal);
      if ((options.hops ?? 1) !== 1) throw new Error('This example backend supports one hop per request. Expand the next entity to continue.');
      const seedSet = new Set(seeds);
      const direction = options.direction ?? 'either';
      const typeField = options.relationshipTypeField ?? 'type';
      const relationshipTypes = options.relationshipTypes;
      const matching = catalogEdges.filter((e) => {
        if (relationshipTypes !== undefined && !relationshipTypes.includes(String(e.attrs?.[typeField]))) return false;
        return (direction !== 'incoming' && seedSet.has(e.source)) ||
          (direction !== 'outgoing' && seedSet.has(e.target));
      });
      const neighborIds = new Set(matching.flatMap((e) => [e.source, e.target]));
      const neighbors = catalogNodes.filter((n) => neighborIds.has(n.id) && !seedSet.has(n.id)).map((n) => n.id);
      // Bind the opaque cursor to its query so another seed/type cannot reuse it.
      const fingerprint = JSON.stringify([ctx.datasetKey, ctx.sourceRevision, seeds, direction, relationshipTypes ?? null, typeField, options.limit ?? 2, options.edgeLimit ?? 10000]);
      let offset = 0;
      if (options.cursor !== undefined) {
        const parsed: unknown = JSON.parse(options.cursor);
        if (!Array.isArray(parsed) || parsed[0] !== fingerprint || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0) {
          throw new Error('Cursor does not belong to this neighborhood request.');
        }
        offset = parsed[1] as number;
      }
      const limit = Math.min(50, Math.max(1, options.limit ?? 2));
      const selected = neighbors.slice(offset, offset + limit);
      const endpoints = new Set([...seeds, ...selected]);
      const nodes = catalogNodes.filter((n) => endpoints.has(n.id));
      const edges = matching.filter((e) => endpoints.has(e.source) && endpoints.has(e.target));
      if (edges.length > (options.edgeLimit ?? 10000)) throw new Error('Relationship budget is too small for this page. Request fewer neighbors or raise edgeLimit.');
      const nextOffset = offset + selected.length;
      const nextCursor = nextOffset < neighbors.length ? JSON.stringify([fingerprint, nextOffset]) : undefined;
      return {
        provenance: { source: 'fictional-supplier-catalog', revision: ctx.sourceRevision, request: ctx.requestId },
        page: {
          returnedNodes: selected.length,
          returnedEdges: edges.length,
          totalNeighbors: neighbors.length,
          truncated: nextCursor !== undefined,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        },
        batches: (async function* () {
          try {
            // Two bounded batches demonstrate atomic staging before publication.
            await delay(150, ctx.signal);
            yield { nodes };
            await delay(150, ctx.signal);
            yield { edges };
            record('completed');
          } catch (error) {
            record(ctx.signal.aborted ? 'cancelled' : 'failed');
            throw error;
          }
        })(),
      };
    } catch (error) {
      record(ctx.signal.aborted ? 'cancelled' : 'failed');
      throw error;
    }
  }

  return {
    expansion: {
      revisionDependencies: ['source'],
      neighbors: (seeds, hops, ctx) => queryNeighbors(seeds, { hops, direction: 'either', limit: 50 }, ctx),
      queryNeighbors,
    },
    search: {
      // The catalog is source-bound; hiding/loading nodes cannot change its hits.
      revisionDependencies: ['source'],
      async search(query, { limit }, ctx) {
        const operation = `Search “${query}”`;
        report({ request: ctx.requestId, operation, status: 'started' });
        try {
          await delay(240, ctx.signal);
          const needle = query.trim().toLowerCase();
          const hits = catalogNodes
            .filter((n) => `${n.id} ${n.attrs?.label ?? ''}`.toLowerCase().includes(needle))
            .slice(0, Math.min(limit, 20))
            .map((n) => ({ id: n.id, label: n.attrs?.label ?? n.id }));
          report({ request: ctx.requestId, operation, status: 'completed' });
          return hits;
        } catch (error) {
          report({ request: ctx.requestId, operation, status: ctx.signal.aborted ? 'cancelled' : 'failed' });
          throw error;
        }
      },
    },
  };
}

/** Explicit host action for a not-loaded search hit; never a search side effect. */
export async function loadCatalogEntity(
  instance: GraphInstance<Entity, Relationship>,
  id: string,
  signal: AbortSignal,
): Promise<void> {
  await delay(350, signal);
  const node = catalogNodes.find((n) => n.id === id);
  if (node === undefined) throw new Error(`Unknown catalog entity: ${id}`);
  const edges = catalogEdges.filter((e) =>
    (e.source === id && instance.getNode(e.target) !== undefined) ||
    (e.target === id && instance.getNode(e.source) !== undefined));
  const session = instance.beginIngest({
    purpose: 'overlay',
    datasetKey: 'storybook:supply-chain',
    baseModelRevision: instance.store.getState().revisions.model,
    atomic: true,
  });
  try {
    await session.append({ sequence: 0, batchId: `search:${id}`, nodes: [node], edges });
    if (signal.aborted) throw new DOMException('Search recovery cancelled.', 'AbortError');
    await session.commit();
  } catch (error) {
    await session.abort(error);
    throw error;
  }
}
