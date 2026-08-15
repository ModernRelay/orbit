/**
 * Mapping validation — runs BEFORE any row work.
 *
 * `mapping.nodes.id` and `mapping.edges.source`/`target` must exist in the
 * discovered input columns (see rowTable.ts for how each lane discovers
 * them). Failures throw ONE TypeError listing EVERY missing column at once,
 * so a caller fixes the whole mapping in a single round trip.
 *
 * Deliberately lenient by design:
 * - `mapping.edges.id` and `includeFields` entries are NOT required to exist
 * (optional column; absent fields simply never materialize);
 * - an empty source (`columns === null`) is vacuously valid — there is no
 * schema to check and no rows to mis-map.
 */

import type { GraphColumnMapping } from './types';

export interface MappingValidationInput {
  mapping: GraphColumnMapping;
  /** Discovered node columns (null = empty source or derived nodes). */
  nodeColumns: readonly string[] | null;
  /** Discovered edge columns (null = empty source). */
  edgeColumns: readonly string[] | null;
  /** True for the `{edges, deriveNodes: true}` input variant. */
  deriveNodes: boolean;
}

export function validateMapping(input: MappingValidationInput): void {
  const { mapping, nodeColumns, edgeColumns, deriveNodes } = input;
  const problems: string[] = [];

  if (!deriveNodes) {
    if (mapping.nodes === undefined) {
      problems.push('mapping.nodes is required when a node source is supplied');
    } else if (nodeColumns !== null && !nodeColumns.includes(mapping.nodes.id)) {
      problems.push(
        `node id column ${JSON.stringify(mapping.nodes.id)} not found ` +
          `(available: ${formatColumns(nodeColumns)})`,
      );
    }
  }

  if (edgeColumns !== null) {
    const missing: string[] = [];
    if (!edgeColumns.includes(mapping.edges.source)) missing.push('source');
    if (!edgeColumns.includes(mapping.edges.target)) missing.push('target');
    for (const role of missing) {
      const column = role === 'source' ? mapping.edges.source : mapping.edges.target;
      problems.push(
        `edge ${role} column ${JSON.stringify(column)} not found ` +
          `(available: ${formatColumns(edgeColumns)})`,
      );
    }
  }

  if (problems.length > 0) {
    throw new TypeError(
      `prepareGraphData: mapping validation failed — ${problems.join('; ')}`,
    );
  }
}

function formatColumns(columns: readonly string[]): string {
  if (columns.length === 0) return 'none';
  return columns.map((c) => JSON.stringify(c)).join(', ');
}
