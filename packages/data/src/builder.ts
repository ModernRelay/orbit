/**
 * Shared prepared-graph builder: every lane (rows/CSV/JSON/Arrow/
 * Parquet) funnels normalized RowTables through here.
 *
 * Order of operations: mapping validation FIRST (before any row
 * work, against the discovered columns), then a single streaming pass per
 * table building snapshot rows and column summaries, then the fingerprint.
 * The fingerprint is FINALIZED only after materialization (invariant I4,
 * semantic fingerprint completeness): it covers the union of ADMITTED attr
 * fields across ALL rows — seeded columns plus every field a row actually
 * materialized — not the header/first-row projection used for validation.
 * Late-appearing fields flow into attrs and summaries, so they must move the
 * fingerprint too, or artifact revalidation skipping (artifact.ts) could
 * serve stale structure.
 *
 * Attr selection: identity columns (node id; edge id/source/target) are
 * consumed for identity and excluded from attrs — unless `includeFields`
 * names them explicitly. When `includeFields` is present it is the exact
 * attr allowlist; otherwise attrs = all non-identity columns. Rows with no
 * attrs omit the `attrs` key entirely (exactOptionalPropertyTypes-friendly).
 *
 * Identity values must be strings, finite numbers, or bigints (stringified);
 * a row with a missing/unusable id/source/target throws a TypeError with the
 * row ordinal — prepared data must be well-keyed, and silent row drops would
 * corrupt summaries.
 */

import type { GraphEdge, GraphNode, GraphSnapshot } from '@modernrelay/orbit-core';
import { computeMappingFingerprint } from './fingerprint';
import type { RowTable } from './rowTable';
import { TableSummarizer } from './summaries';
import type {
  GraphColumnMapping,
  GraphPrepareFormat,
  GraphPrepareOptions,
  PreparedGraph,
} from './types';
import { validateMapping } from './validate';

type Row = Readonly<Record<string, unknown>>;
type Attrs = Record<string, unknown>;

export interface BuildArgs {
  /** null = `{edges, deriveNodes: true}` — nodes synthesized from endpoints. */
  nodeTable: RowTable | null;
  edgeTable: RowTable;
  mapping: GraphColumnMapping;
  /** Resolved lane label; part of the fingerprint. */
  format: GraphPrepareFormat;
  options: GraphPrepareOptions;
}

export async function buildPrepared(args: BuildArgs): Promise<PreparedGraph> {
  const { nodeTable, edgeTable, mapping, format, options } = args;
  validateOptions(options);
  validateMapping({
    mapping,
    nodeColumns: nodeTable === null ? null : nodeTable.columns,
    edgeColumns: edgeTable.columns,
    deriveNodes: nodeTable === null,
  });
  const nodeSummarizer = new TableSummarizer();
  const edgeSummarizer = new TableSummarizer();

  // --- edges (first, so deriveNodes sees endpoint order) ------------------
  const edgeIdentity = new Set<string>(
    [mapping.edges.id, mapping.edges.source, mapping.edges.target].filter(
      (c): c is string => c !== undefined,
    ),
  );
  const edgeAttrPick = attrPicker(edgeTable.columns, edgeIdentity, mapping.edges.includeFields);
  if (edgeTable.columns !== null) {
    edgeSummarizer.seed(edgeAttrPick.seedColumns);
    for (const column of edgeAttrPick.seedColumns) edgeAttrPick.admitted.add(column);
  }
  const edges: GraphEdge[] = [];
  const endpointOrder = new Set<string>();
  let edgeOrdinal = 0;
  for await (const row of edgeTable.rows) {
    const source = identityString(row[mapping.edges.source], 'edge source', edgeOrdinal, mapping.edges.source);
    const target = identityString(row[mapping.edges.target], 'edge target', edgeOrdinal, mapping.edges.target);
    const edge: GraphEdge = { source, target };
    if (mapping.edges.id !== undefined) {
      const raw = row[mapping.edges.id];
      if (raw !== undefined && raw !== null) {
        edge.id = identityString(raw, 'edge id', edgeOrdinal, mapping.edges.id);
      }
    }
    const attrs = edgeAttrPick.pick(row);
    if (attrs !== undefined) edge.attrs = attrs;
    edgeSummarizer.addRow(attrs);
    edges.push(edge);
    if (nodeTable === null) {
      endpointOrder.add(source);
      endpointOrder.add(target);
    }
    edgeOrdinal++;
  }

  // --- nodes ---------------------------------------------------------------
  const nodes: GraphNode[] = [];
  let nodeAdmitted: ReadonlySet<string> = new Set<string>();
  if (nodeTable === null) {
    // deriveNodes: ids only, first-occurrence order over edge endpoints.
    for (const id of endpointOrder) nodes.push({ id });
  } else {
    const nodeMapping = mapping.nodes!; // validated above
    const nodeIdentity = new Set<string>([nodeMapping.id]);
    const nodeAttrPick = attrPicker(nodeTable.columns, nodeIdentity, nodeMapping.includeFields);
    nodeAdmitted = nodeAttrPick.admitted;
    if (nodeTable.columns !== null) {
      nodeSummarizer.seed(nodeAttrPick.seedColumns);
      for (const column of nodeAttrPick.seedColumns) nodeAttrPick.admitted.add(column);
    }
    let nodeOrdinal = 0;
    for await (const row of nodeTable.rows) {
      const id = identityString(row[nodeMapping.id], 'node id', nodeOrdinal, nodeMapping.id);
      const node: GraphNode = { id };
      const attrs = nodeAttrPick.pick(row);
      if (attrs !== undefined) node.attrs = attrs;
      nodeSummarizer.addRow(attrs);
      nodes.push(node);
      nodeOrdinal++;
    }
  }

  // Fingerprint AFTER materialization (I4): the admitted union is only known
  // once every row has streamed through. computeMappingFingerprint sorts the
  // lists, so field DISCOVERY order can never move the fingerprint.
  const mappingFingerprint = computeMappingFingerprint(mapping, format, {
    nodes: [...nodeAdmitted],
    edges: [...edgeAttrPick.admitted],
  });

  const snapshot: GraphSnapshot = {
    datasetKey: options.datasetKey,
    sourceRevision: options.sourceRevision,
    nodes,
    edges,
  };
  return {
    snapshot,
    summaries: { nodes: nodeSummarizer.finalize(), edges: edgeSummarizer.finalize() },
    mappingFingerprint,
  };
}

function validateOptions(options: GraphPrepareOptions): void {
  if (typeof options.datasetKey !== 'string' || options.datasetKey === '') {
    throw new TypeError('prepareGraphData: options.datasetKey must be a non-empty string');
  }
  const rev = options.sourceRevision;
  if (typeof rev !== 'string' && typeof rev !== 'number') {
    throw new TypeError('prepareGraphData: options.sourceRevision must be a string or number');
  }
}

function identityString(
  value: unknown,
  role: string,
  ordinal: number,
  column: string,
): string {
  if (typeof value === 'string') {
    if (value === '') {
      throw new TypeError(
        `prepareGraphData: ${role} in column ${JSON.stringify(column)} is empty at row ${ordinal}`,
      );
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  throw new TypeError(
    `prepareGraphData: ${role} in column ${JSON.stringify(column)} is missing or unusable ` +
      `at row ${ordinal} (got ${value === null ? 'null' : typeof value})`,
  );
}

interface AttrPicker {
  /** Columns to pre-seed summaries with (known-schema lanes). */
  seedColumns: readonly string[];
  /**
   * Union of admitted attr field names (I4 fingerprint input): every key
   * `pick` materialized into attrs, plus — added by the builder alongside
   * summary seeding — the seeded columns. Mirrors the summary key set
   * exactly; identity columns and allowlist-excluded fields never enter.
   */
  admitted: Set<string>;
  /** Row → attrs object, or undefined when the row has no attr values. */
  pick(row: Row): Attrs | undefined;
}

function attrPicker(
  columns: readonly string[] | null,
  identity: ReadonlySet<string>,
  includeFields: readonly string[] | undefined,
): AttrPicker {
  const admitted = new Set<string>();
  if (includeFields !== undefined) {
    const allow = new Set(includeFields);
    return {
      seedColumns: columns === null ? [...allow] : columns.filter((c) => allow.has(c)),
      admitted,
      pick: (row) => {
        let attrs: Attrs | undefined;
        for (const key of Object.keys(row)) {
          if (!allow.has(key)) continue;
          const value = row[key];
          if (value === undefined) continue;
          admitted.add(key);
          // JSON.parse rows carry '__proto__' as an own key;
          // plain assignment would invoke the legacy prototype setter
          // (field lost, prototype swapped). defineProperty writes the own
          // property regardless of the key.
          attrs ??= {};
          Object.defineProperty(attrs, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return attrs;
      },
    };
  }
  return {
    seedColumns: columns === null ? [] : columns.filter((c) => !identity.has(c)),
    admitted,
    pick: (row) => {
      let attrs: Attrs | undefined;
      for (const key of Object.keys(row)) {
        if (identity.has(key)) continue;
        const value = row[key];
        if (value === undefined) continue;
        admitted.add(key);
        // Same guard as the includeFields branch above.
        attrs ??= {};
        Object.defineProperty(attrs, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return attrs;
    },
  };
}
