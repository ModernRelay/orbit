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
import { ColumnarBuilder } from './columnar';
import type { PreparationControl } from './control';
import { computeMappingFingerprint } from './fingerprint';
import type { RowTable } from './rowTable';
import { TableSummarizer } from './summaries';
import type {
  GraphColumnMapping,
  GraphPrepareFormat,
  GraphPrepareAnyOptions,
  PreparedColumnarGraph,
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
  options: GraphPrepareAnyOptions;
  control: PreparationControl;
}

export async function buildPrepared(args: BuildArgs): Promise<PreparedGraph | PreparedColumnarGraph> {
  const { nodeTable, edgeTable, mapping, format, options, control } = args;
  let failed = false;
  try {
    control.check();
    const columnar = options.output === 'columnar' ? new ColumnarBuilder() : undefined;
    validateMapping({
      mapping,
      nodeColumns: nodeTable === null ? null : nodeTable.columns,
      edgeColumns: edgeTable.columns,
      deriveNodes: nodeTable === null,
    });
    const nodeSummarizer = new TableSummarizer();
    const edgeSummarizer = new TableSummarizer();

    // --- edges (first, so deriveNodes sees endpoint order) ----------------
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
    columnar?.edgeAttributes.seed(edgeAttrPick.seedColumns);
    const edges: GraphEdge[] = [];
    const endpointOrder = new Set<string>();
    let edgeOrdinal = 0;
    for await (const row of edgeTable.rows) {
      await control.checkpoint();
      control.admit('edges');
      const source = identityString(
        row[mapping.edges.source],
        'edge source',
        edgeOrdinal,
        mapping.edges.source,
        true,
      );
      const target = identityString(
        row[mapping.edges.target],
        'edge target',
        edgeOrdinal,
        mapping.edges.target,
        true,
      );
      let edgeId: string | undefined;
      if (mapping.edges.id !== undefined) {
        const raw = row[mapping.edges.id];
        if (raw !== undefined && raw !== null) {
          edgeId = identityString(raw, 'edge id', edgeOrdinal, mapping.edges.id, true);
        }
      }
      const attrs = edgeAttrPick.pick(row);
      edgeSummarizer.addRow(attrs);
      if (columnar !== undefined) columnar.edge(source, target, edgeId, attrs);
      else edges.push({ source, target, ...(edgeId === undefined ? {} : { id: edgeId }), ...(attrs === undefined ? {} : { attrs }) });
      if (nodeTable === null) {
        for (const endpoint of [source, target]) {
          if (!endpointOrder.has(endpoint)) {
            control.admit('nodes');
            endpointOrder.add(endpoint);
          }
        }
      }
      edgeOrdinal++;
    }

    // --- nodes -------------------------------------------------------------
    const nodes: GraphNode[] = [];
    let nodeAdmitted: ReadonlySet<string> = new Set<string>();
    if (nodeTable === null) {
      // deriveNodes: ids only, first-occurrence order over edge endpoints.
      for (const id of endpointOrder) {
        await control.checkpoint();
        if (columnar !== undefined) columnar.node(id);
        else nodes.push({ id });
      }
    } else {
      const nodeMapping = mapping.nodes!; // validated above
      const nodeIdentity = new Set<string>([nodeMapping.id]);
      const nodeAttrPick = attrPicker(nodeTable.columns, nodeIdentity, nodeMapping.includeFields);
      nodeAdmitted = nodeAttrPick.admitted;
      if (nodeTable.columns !== null) {
        nodeSummarizer.seed(nodeAttrPick.seedColumns);
        for (const column of nodeAttrPick.seedColumns) nodeAttrPick.admitted.add(column);
      }
      columnar?.nodeAttributes.seed(nodeAttrPick.seedColumns);
      let nodeOrdinal = 0;
      for await (const row of nodeTable.rows) {
        await control.checkpoint();
        control.admit('nodes');
        const id = identityString(row[nodeMapping.id], 'node id', nodeOrdinal, nodeMapping.id, true);
        const attrs = nodeAttrPick.pick(row);
        nodeSummarizer.addRow(attrs);
        if (columnar !== undefined) columnar.node(id, attrs);
        else nodes.push({ id, ...(attrs === undefined ? {} : { attrs }) });
        nodeOrdinal++;
      }
    }

    // Fingerprint AFTER materialization (I4): the admitted union is only
    // known once every row has streamed through. computeMappingFingerprint
    // sorts the lists, so field DISCOVERY order can never move it.
    const mappingFingerprint = computeMappingFingerprint(mapping, format, {
      nodes: [...nodeAdmitted],
      edges: [...edgeAttrPick.admitted],
    });

    const snapshot = columnar !== undefined ? await columnar.finish(control) : {
      datasetKey: options.datasetKey,
      sourceRevision: options.sourceRevision,
      nodes,
      edges,
    } satisfies GraphSnapshot;
    control.report('complete');
    return {
      snapshot,
      summaries: { nodes: nodeSummarizer.finalize(), edges: edgeSummarizer.finalize() },
      mappingFingerprint,
    } as PreparedGraph | PreparedColumnarGraph;
  } catch (cause) {
    failed = true;
    throw cause;
  } finally {
    // Column discovery peeks async sources before validation. Always release
    // both tables so mapping errors, an error in either materialization pass,
    // and successful exhaustion all settle caller-owned iterators. Both
    // closes run even if one rejects. A teardown failure is surfaced after a
    // successful build, but must never replace the useful validation/read
    // failure already escaping the try block.
    const closes = await Promise.allSettled([
      Promise.resolve().then(() => edgeTable.close?.()),
      Promise.resolve().then(() => nodeTable?.close?.()),
    ]);
    if (!failed) {
      const rejected = closes.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (rejected !== undefined) throw rejected.reason;
    }
  }
}

function identityString(
  value: unknown,
  role: string,
  ordinal: number,
  column: string,
  rejectNul = false,
): string {
  if (typeof value === 'string') {
    if (value === '') {
      throw new TypeError(
        `prepareGraphData: ${role} in column ${JSON.stringify(column)} is empty at row ${ordinal}`,
      );
    }
    if (rejectNul && value.includes('\u0000')) {
      throw new TypeError(
        `prepareGraphData: ${role} in column ${JSON.stringify(column)} contains reserved NUL ` +
          `at row ${ordinal}`,
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
