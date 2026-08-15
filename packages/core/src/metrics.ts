/**
 * metrics (v0.8 subset): lazy degree-family primitives over the
 * maintained topology plus revision-gated admission of async metric columns.
 *
 * - The degree family (degree / inDegree / outDegree) is computed LAZILY on
 * first request per model revision, in ONE combined O(n + L) pass, and
 * cached as Float64Arrays until the model revision changes.
 * - SELF-LOOP SEMANTICS: a self-loop (a, a) contributes exactly 1 to each of
 * degree, inDegree, and outDegree of `a`. The CSR adjacency lists a
 * self-loop twice under its point (once per endpoint slot, see
 * adjacency.ts), so degree = CSR row length MINUS the point's self-loop
 * count; in/out come from a directed pass over the flat link pairs.
 * - Async columns join once against the accepted model: 'index' align
 * is positional over accepted-base order; 'ids' align joins by id with
 * unknown ids counted+sampled, duplicate ids counted (last occurrence
 * wins), and absent rows null. Every value routes through `coerceNumeric`.
 * A column computed for a stale model revision is
 * DISCARDED with a diagnostic — admission is the correctness gate, abort
 * is only an optimization.
 * - Storage encodes null as NaN inside Float64Arrays; `getMetricValue`
 * converts back at the boundary so NaN never escapes to callers.
 * - Admitted columns SHADOW the built-in degree family under the same name
 * (a precomputed/server 'degree' column wins; precomputed path).
 */

import { DIAGNOSTIC_SAMPLE_CAP } from './types';
import type { GraphDiagnostic, GraphNode, MetricColumn, MetricName, NodeId } from './types';
import type { Adjacency } from './adjacency';
import { coerceNumeric } from './hygiene';

/** Topology snapshot the degree family is computed from. */
export interface MetricModelInput<N = Record<string, unknown>> {
  /** Accepted nodes in accepted-base order (index i ↔ point i). */
  nodes: readonly GraphNode<N>[];
  /** CSR adjacency over `links` (self-loops listed twice; adjacency.ts). */
  adjacency: Adjacency;
  /** Flat `[src0, tgt0, src1, tgt1, …]` directed point-index pairs. */
  links: Uint32Array;
  datasetRevision: number | string;
  modelRevision: number;
}

export interface AdmitColumnsOptions {
  /** Accepted id → accepted-base index (the core map — no public copy). */
  nodeIndex: ReadonlyMap<NodeId, number>;
  /** Accepted node count ('index' align must match exactly). */
  count: number;
  /** The model revision current when the update carrying the columns was
   * ISSUED (the admission gate compares each column's own
   * `forModelRevision` stamp against this — I1). */
  modelRevision: number;
}

export interface AdmitColumnsResult {
  /** Metric names admitted by this call, in input order. */
  admitted: readonly string[];
  diagnostics: readonly GraphDiagnostic[];
}

interface DegreeCache {
  degree: Float64Array;
  inDegree: Float64Array;
  outDegree: Float64Array;
}

function isDegreeFamily(name: MetricName): name is 'degree' | 'inDegree' | 'outDegree' {
  return name === 'degree' || name === 'inDegree' || name === 'outDegree';
}

function columnDiagnostic(
  severity: GraphDiagnostic['severity'],
  count: number,
  sampleIds: readonly string[],
  message: string,
): GraphDiagnostic {
  return { code: 'metric-column-error', severity, count, sampleIds, message };
}

export class MetricStore<N = Record<string, unknown>> {
  private model: MetricModelInput<N> | null = null;
  private degreeCache: DegreeCache | null = null;
  /** Admitted async columns by metric name; NaN encodes null. */
  private readonly columns = new Map<string, Float64Array>();
  private degreePasses = 0;

  /** telemetry: estimated bytes of metric storage held. */
  estimatedBytes(): number {
    let bytes = 0;
    for (const col of this.columns.values()) bytes += col.byteLength;
    const dc = this.degreeCache;
    if (dc !== null) {
      bytes += dc.degree.byteLength + dc.inDegree.byteLength + dc.outDegree.byteLength;
    }
    return bytes;
  }

  /** Number of combined degree-family compute passes (test observability). */
  get degreeComputePasses(): number {
    return this.degreePasses;
  }

  /**
   * Installs the topology the degree family derives from. A changed
   * {datasetRevision, modelRevision} coordinate invalidates the lazy degree
   * cache AND drops every admitted column (their accepted-base alignment is
   * meaningless against a different model); re-setting the identical
   * coordinate keeps both.
   */
  setModel(model: MetricModelInput<N>): void {
    const prev = this.model;
    const changed =
      prev === null ||
      prev.modelRevision !== model.modelRevision ||
      prev.datasetRevision !== model.datasetRevision;
    this.model = model;
    if (changed) {
      this.degreeCache = null;
      this.columns.clear();
    }
  }

  /**
   * Joins async metric columns against the accepted model.
   * Revision-gated PER COLUMN (I1): a column whose issue-time
   * `forModelRevision` stamp differs from `opts.modelRevision` is discarded
   * (info diagnostic — a normal async race outcome). A missing or
   * mismatched stamp is never defaulted to the current revision — that
   * would make the gate self-satisfying.
   * Structural rejections ('index' length mismatch, missing/mismatched ids)
   * emit ONE warning diagnostic per column; a joined column emits at most
   * one unknown-ids and one duplicate-ids diagnostic, each carrying a total
   * count and at most DIAGNOSTIC_SAMPLE_CAP sample ids.
   */
  admitColumns(
    columns: readonly MetricColumn[],
    opts: AdmitColumnsOptions,
  ): AdmitColumnsResult {
    const admitted: string[] = [];
    const diagnostics: GraphDiagnostic[] = [];

    for (const column of columns) {
      if (column.forModelRevision !== opts.modelRevision) {
        diagnostics.push(
          columnDiagnostic(
            'info',
            1,
            [column.metric],
            `metric column '${column.metric}' discarded: computed for model revision ${String(column.forModelRevision)} but the update was issued at revision ${String(opts.modelRevision)}`,
          ),
        );
        continue;
      }

      if (column.align === 'index') {
        if (column.values.length !== opts.count) {
          diagnostics.push(
            columnDiagnostic(
              'warning',
              1,
              [column.metric],
              `metric column '${column.metric}' rejected: 'index' align requires values.length === accepted node count (${column.values.length} !== ${opts.count})`,
            ),
          );
          continue;
        }
        const out = new Float64Array(opts.count);
        for (let i = 0; i < opts.count; i++) {
          const v = coerceNumeric(column.values[i]);
          out[i] = v === null ? NaN : v;
        }
        this.columns.set(column.metric, out);
        admitted.push(column.metric);
        continue;
      }

      // 'ids' align — join by the ids array.
      const ids = column.ids;
      if (ids === undefined) {
        diagnostics.push(
          columnDiagnostic(
            'warning',
            1,
            [column.metric],
            `metric column '${column.metric}' rejected: 'ids' align requires an ids array`,
          ),
        );
        continue;
      }
      if (ids.length !== column.values.length) {
        diagnostics.push(
          columnDiagnostic(
            'warning',
            1,
            [column.metric],
            `metric column '${column.metric}' rejected: ids length ${ids.length} !== values length ${column.values.length}`,
          ),
        );
        continue;
      }

      const out = new Float64Array(opts.count).fill(NaN);
      let unknown = 0;
      const unknownSamples: string[] = [];
      let duplicate = 0;
      const duplicateSamples: string[] = [];
      const seen = new Set<number>();

      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]!;
        const index = opts.nodeIndex.get(id);
        if (index === undefined) {
          unknown++;
          if (unknownSamples.length < DIAGNOSTIC_SAMPLE_CAP) unknownSamples.push(id);
          continue;
        }
        if (seen.has(index)) {
          duplicate++;
          if (duplicateSamples.length < DIAGNOSTIC_SAMPLE_CAP) duplicateSamples.push(id);
          // Last occurrence wins — fall through and overwrite.
        } else {
          seen.add(index);
        }
        const v = coerceNumeric(column.values[i]);
        out[index] = v === null ? NaN : v;
      }

      if (unknown > 0) {
        diagnostics.push(
          columnDiagnostic(
            'warning',
            unknown,
            unknownSamples,
            `metric column '${column.metric}': ${unknown} row(s) skipped — id not in the accepted model`,
          ),
        );
      }
      if (duplicate > 0) {
        diagnostics.push(
          columnDiagnostic(
            'warning',
            duplicate,
            duplicateSamples,
            `metric column '${column.metric}': ${duplicate} duplicate id row(s) — last occurrence wins`,
          ),
        );
      }

      this.columns.set(column.metric, out);
      admitted.push(column.metric);
    }

    return { admitted, diagnostics };
  }

  /**
   * Allocation-free hot path: one map lookup + one typed-array read.
   * NaN-encoded nulls convert back to `null` at this boundary; unknown
   * metrics and out-of-range indices are `null`, never NaN.
   */
  getMetricValue(metric: MetricName, index: number): number | null {
    const values = this.resolve(metric);
    if (values === null) return null;
    const v = values[index];
    return v === undefined || Number.isNaN(v) ? null : v;
  }

  /**
   * Raw column in accepted-base order, or null when unavailable. NaN encodes
   * null — consumers exclude NaN slots from domains. Do NOT mutate:
   * this is the live cache, not a copy.
   */
  metricValues(metric: MetricName): Float64Array | null {
    return this.resolve(metric);
  }

  /** True when the metric would resolve; never triggers a compute pass. */
  hasMetric(name: MetricName): boolean {
    if (this.columns.has(name)) return true;
    return isDegreeFamily(name) && this.model !== null;
  }

  private resolve(metric: MetricName): Float64Array | null {
    const custom = this.columns.get(metric);
    if (custom !== undefined) return custom;
    if (!isDegreeFamily(metric)) return null;
    const cache = this.ensureDegrees();
    return cache === null ? null : cache[metric];
  }

  /** One combined O(n + L) pass computes all three family members. */
  private ensureDegrees(): DegreeCache | null {
    if (this.degreeCache !== null) return this.degreeCache;
    const model = this.model;
    if (model === null) return null;
    this.degreePasses++;

    const offsets = model.adjacency.offsets;
    const n = offsets.length - 1;
    const degree = new Float64Array(n);
    const inDegree = new Float64Array(n);
    const outDegree = new Float64Array(n);

    // degree = CSR row length…
    for (let i = 0; i < n; i++) {
      degree[i] = offsets[i + 1]! - offsets[i]!;
    }
    // …minus one per self-loop (CSR lists (a, a) twice; counts it once).
    // The same directed pass yields in/out: self-loop → 1 to each.
    const links = model.links;
    for (let i = 0; i < links.length; i += 2) {
      const s = links[i]!;
      const t = links[i + 1]!;
      outDegree[s] = outDegree[s]! + 1;
      inDegree[t] = inDegree[t]! + 1;
      if (s === t) degree[s] = degree[s]! - 1;
    }

    this.degreeCache = { degree, inDegree, outDegree };
    return this.degreeCache;
  }
}
