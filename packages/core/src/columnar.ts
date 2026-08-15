/**
 * columnar snapshot lane — structural validation and
 * the materialization bridge.
 *
 * Validation is O(number of columns + rows) and runs BEFORE transfer or
 * admission. Columnar structural corruption is intentionally not repaired
 * row by row — offset/index misalignment can reinterpret every later row
 * so any structural issue rejects the WHOLE snapshot, the prior scene stays
 * intact, and nothing throws from a React render.
 *
 * The bridge materializes a VALID columnar snapshot into the object form and
 * feeds the existing pipeline, so duplicate-id / dangling-edge / self-loop
 * resolution stays in exactly one place (validate.ts) and the columnar lane
 * inherits every object-lane rule by construction. Under `execution: 'main'`
 * materialization remains synchronous; the worker lane can perform acceptance
 * off-thread before the same shared pipeline runs.
 *
 * Null semantics: `nulls` is one byte per row, nonzero = null. Null attr
 * values materialize as `null` (JSON-ish; every numeric/temporal consumer
 * already coerces). A null or out-of-range id CODE is structural corruption
 * — ids are identity, not data.
 */

import type {
  AcceptedEdge,
  AcceptedGraph,
  Column,
  ColumnarGraphSnapshot,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  GraphSnapshotInput,
  NodeId,
  StringColumn,
} from './types';
import type { ColumnarAcceptance } from './columnarValidate';

export function isColumnarSnapshot<N, E>(
  input: GraphSnapshotInput<N, E>,
): input is ColumnarGraphSnapshot<N, E> {
  return (input as { kind?: unknown }).kind === 'columnar';
}

/** One structural defect. `where` is '<entity>.<column>' or '<entity>.<field>'. */
export interface ColumnarIssue {
  where: string;
  problem:
    | 'not-a-string-column'
    | 'length-mismatch'
    | 'code-out-of-range'
    | 'null-id'
    | 'nulls-length-mismatch'
    | 'endpoint-out-of-range'
    | 'endpoint-length-mismatch'
    | 'bad-length'
    | 'bad-column-kind';
  detail: string;
}

const isTypedLength = (arr: { length: number } | undefined, n: number): boolean =>
  arr !== undefined && arr.length === n;

function checkStringColumn(
  col: StringColumn,
  rows: number,
  where: string,
  isIds: boolean,
  out: ColumnarIssue[],
): void {
  // Untyped JavaScript callers can omit the column entirely; that must
  // be a rejection issue, never a TypeError (reject-whole / no render throw).
  if (col === null || typeof col !== 'object') {
    out.push({ where, problem: 'not-a-string-column', detail: 'column missing or not an object' });
    return;
  }
  if (col.kind !== 'string' || !Array.isArray(col.dictionary) || !(col.codes instanceof Uint32Array)) {
    out.push({ where, problem: 'not-a-string-column', detail: 'expected {kind:"string", dictionary, codes}' });
    return;
  }
  if (col.codes.length !== rows) {
    const detached = col.codes.length === 0 && col.codes.buffer.byteLength === 0;
    out.push({
      where,
      problem: 'length-mismatch',
      detail: detached
        ? `codes buffer is DETACHED (a bufferOwnership:'transfer' snapshot is single-use)`
        : `codes.length ${col.codes.length} !== length ${rows}`,
    });
    return; // bounds scan over a misaligned column would be noise
  }
  if (col.nulls !== undefined) {
    if (col.nulls.length !== rows) {
      out.push({
        where,
        problem: 'nulls-length-mismatch',
        detail: `nulls.length ${col.nulls.length} !== length ${rows}`,
      });
    } else if (isIds) {
      for (let i = 0; i < rows; i++) {
        if (col.nulls[i] !== 0) {
          out.push({ where, problem: 'null-id', detail: `row ${i}: ids may not be null` });
          break; // one witness suffices — the snapshot is rejected whole
        }
      }
    }
  }
  const dictSize = col.dictionary.length;
  for (let i = 0; i < rows; i++) {
    if (col.codes[i]! >= dictSize) {
      out.push({
        where,
        problem: 'code-out-of-range',
        detail: `row ${i}: code ${col.codes[i]} >= dictionary size ${dictSize}`,
      });
      break;
    }
  }
}

function checkColumn(col: Column, rows: number, where: string, out: ColumnarIssue[]): void {
  if (col === null || typeof col !== 'object') {
    out.push({ where, problem: 'bad-column-kind', detail: 'column missing or not an object' });
    return;
  }
  switch (col.kind) {
    case 'string':
      checkStringColumn(col, rows, where, false, out);
      return;
    case 'f64':
    case 'i32':
    case 'u32':
    case 'bool': {
      if (!isTypedLength(col.data, rows)) {
        out.push({
          where,
          problem: 'length-mismatch',
          detail: `data.length ${col.data?.length ?? 'missing'} !== length ${rows}`,
        });
      }
      if (col.nulls !== undefined && col.nulls.length !== rows) {
        out.push({
          where,
          problem: 'nulls-length-mismatch',
          detail: `nulls.length ${col.nulls.length} !== length ${rows}`,
        });
      }
      return;
    }
    default:
      out.push({
        where,
        problem: 'bad-column-kind',
        detail: `unknown column kind '${String((col as { kind?: unknown }).kind)}'`,
      });
  }
}

/**
 * O(columns + rows) structural validation. Empty array ⇒ structurally sound
 * (duplicate ids, self-loops, and parallel-edge rules are NOT checked here
 * they are shared object-lane semantics applied after materialization).
 */
export function validateColumnarStructure(
  snapshot: ColumnarGraphSnapshot<unknown, unknown>,
): ColumnarIssue[] {
  const issues: ColumnarIssue[] = [];
  const nodeRows = snapshot.nodes?.length;
  const edgeRows = snapshot.edges?.length;
  if (!Number.isInteger(nodeRows) || nodeRows < 0) {
    issues.push({ where: 'nodes.length', problem: 'bad-length', detail: String(nodeRows) });
    return issues;
  }
  if (!Number.isInteger(edgeRows) || edgeRows < 0) {
    issues.push({ where: 'edges.length', problem: 'bad-length', detail: String(edgeRows) });
    return issues;
  }

  if (snapshot.nodes === null || typeof snapshot.nodes !== 'object') {
    issues.push({ where: 'nodes', problem: 'bad-length', detail: 'nodes lane missing' });
    return issues;
  }
  if (snapshot.edges === null || typeof snapshot.edges !== 'object') {
    issues.push({ where: 'edges', problem: 'bad-length', detail: 'edges lane missing' });
    return issues;
  }
  checkStringColumn(snapshot.nodes.ids, nodeRows, 'nodes.ids', true, issues);
  for (const [name, col] of Object.entries(snapshot.nodes.columns ?? {})) {
    checkColumn(col, nodeRows, `nodes.${name}`, issues);
  }

  checkStringColumn(snapshot.edges.ids, edgeRows, 'edges.ids', true, issues);
  for (const [name, col] of Object.entries(snapshot.edges.columns ?? {})) {
    checkColumn(col, edgeRows, `edges.${name}`, issues);
  }

  const { source, target } = snapshot.edges;
  if (!(source instanceof Uint32Array) || source.length !== edgeRows) {
    issues.push({
      where: 'edges.source',
      problem: 'endpoint-length-mismatch',
      detail: `source.length ${source?.length ?? 'missing'} !== length ${edgeRows}`,
    });
  }
  if (!(target instanceof Uint32Array) || target.length !== edgeRows) {
    issues.push({
      where: 'edges.target',
      problem: 'endpoint-length-mismatch',
      detail: `target.length ${target?.length ?? 'missing'} !== length ${edgeRows}`,
    });
  }
  if (issues.length === 0) {
    for (let i = 0; i < edgeRows; i++) {
      if (source[i]! >= nodeRows || target[i]! >= nodeRows) {
        issues.push({
          where: 'edges.endpoints',
          problem: 'endpoint-out-of-range',
          detail: `row ${i}: (${source[i]}, ${target[i]}) with ${nodeRows} nodes`,
        });
        break; // reject-whole: one witness suffices
      }
    }
  }
  return issues;
}

function columnValueAt(col: Column, i: number): unknown {
  if (col.nulls !== undefined && col.nulls[i] !== 0) return null;
  switch (col.kind) {
    case 'string':
      return col.dictionary[col.codes[i]!];
    case 'bool':
      return col.data[i] !== 0;
    default:
      return col.data[i];
  }
}

/**
 * Materialize a STRUCTURALLY VALID columnar snapshot into the object form.
 * Call only after `validateColumnarStructure` returned no issues — this
 * function trusts lengths and bounds.
 */
export function materializeColumnarSnapshot<N, E>(
  snapshot: ColumnarGraphSnapshot<N, E>,
): GraphSnapshot<N, E> {
  const nodeCols = Object.entries(snapshot.nodes.columns ?? {});
  const nodeIds = snapshot.nodes.ids;
  const nodes: GraphNode<N>[] = new Array(snapshot.nodes.length);
  for (let i = 0; i < snapshot.nodes.length; i++) {
    const attrs: Record<string, unknown> = {};
    for (const [name, col] of nodeCols) attrs[name] = columnValueAt(col, i);
    nodes[i] = { id: nodeIds.dictionary[nodeIds.codes[i]!]!, attrs: attrs as N };
  }

  const edgeCols = Object.entries(snapshot.edges.columns ?? {});
  const edgeIds = snapshot.edges.ids;
  const { source, target } = snapshot.edges;
  const edges: GraphEdge<E>[] = new Array(snapshot.edges.length);
  for (let i = 0; i < snapshot.edges.length; i++) {
    const attrs: Record<string, unknown> = {};
    for (const [name, col] of edgeCols) attrs[name] = columnValueAt(col, i);
    edges[i] = {
      id: edgeIds.dictionary[edgeIds.codes[i]!]!,
      source: nodes[source[i]!]!.id,
      target: nodes[target[i]!]!.id,
      attrs: attrs as E,
    };
  }

  return {
    datasetKey: snapshot.datasetKey,
    sourceRevision: snapshot.sourceRevision,
    nodes,
    edges,
  };
}

/**
 * Build the AcceptedGraph DIRECTLY from clean columns + the acceptance
 * verdicts (worker or main produced — same module either way): only kept
 * rows materialize, `nodeIndex` falls out of the same pass, and
 * `validateSnapshot`'s O(rows) object scan never runs. The verdicts are
 * trusted — callers pass an acceptance produced from THIS snapshot.
 */
export function buildAcceptedFromColumnar<N, E>(
  snapshot: ColumnarGraphSnapshot<N, E>,
  acceptance: Pick<
    ColumnarAcceptance,
    'keepNodes' | 'keepEdges' | 'acceptedNodeCount' | 'acceptedEdgeCount' | 'diagnostics'
  >,
): AcceptedGraph<N, E> {
  const nodeCols = Object.entries(snapshot.nodes.columns ?? {});
  const nodeIds = snapshot.nodes.ids;
  const nodes: GraphNode<N>[] = new Array(acceptance.acceptedNodeCount);
  const nodeIndex = new Map<NodeId, number>();
  let outN = 0;
  for (let i = 0; i < snapshot.nodes.length; i++) {
    if (acceptance.keepNodes[i] !== 1) continue;
    const attrs: Record<string, unknown> = {};
    for (const [name, col] of nodeCols) attrs[name] = columnValueAt(col, i);
    const id = nodeIds.dictionary[nodeIds.codes[i]!]!;
    nodeIndex.set(id, outN);
    nodes[outN] = { id, attrs: attrs as N };
    outN += 1;
  }

  const edgeCols = Object.entries(snapshot.edges.columns ?? {});
  const edgeIds = snapshot.edges.ids;
  const { source, target } = snapshot.edges;
  const edges: AcceptedEdge<E>[] = new Array(acceptance.acceptedEdgeCount);
  let outE = 0;
  for (let e = 0; e < snapshot.edges.length; e++) {
    if (acceptance.keepEdges[e] !== 1) continue;
    const attrs: Record<string, unknown> = {};
    for (const [name, col] of edgeCols) attrs[name] = columnValueAt(col, e);
    edges[outE] = {
      id: edgeIds.dictionary[edgeIds.codes[e]!]!,
      // Endpoint STRINGS resolve through the original row (a dropped
      // duplicate row shares its survivor's id string by construction).
      source: nodeIds.dictionary[nodeIds.codes[source[e]!]!]!,
      target: nodeIds.dictionary[nodeIds.codes[target[e]!]!]!,
      attrs: attrs as E,
    };
    outE += 1;
  }

  return {
    datasetKey: snapshot.datasetKey,
    sourceRevision: snapshot.sourceRevision,
    nodes,
    edges,
    nodeIndex,
    diagnostics: acceptance.diagnostics,
  };
}

/** Every distinct underlying ArrayBuffer reachable from the snapshot's typed
 * arrays — the detach set for `bufferOwnership: 'transfer'` and the
 * byteLength witness set for its tests. */
export function columnarArrayBuffers(
  snapshot: ColumnarGraphSnapshot<unknown, unknown>,
): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (view: { buffer: ArrayBufferLike } | undefined) => {
    if (view !== undefined && view.buffer instanceof ArrayBuffer) buffers.add(view.buffer);
  };
  const addColumn = (col: Column) => {
    if (col.kind === 'string') add(col.codes);
    else add(col.data);
    add(col.nulls);
  };
  addColumn(snapshot.nodes.ids);
  for (const col of Object.values(snapshot.nodes.columns ?? {})) addColumn(col);
  addColumn(snapshot.edges.ids);
  for (const col of Object.values(snapshot.edges.columns ?? {})) addColumn(col);
  add(snapshot.edges.source);
  add(snapshot.edges.target);
  return [...buffers];
}

/**
 * `bufferOwnership: 'transfer'` — detach every underlying ArrayBuffer.
 * Called ONLY after validation and admission both succeeded:
 * reject-before-allocation extends to reject-before-detach). Returns the
 * number of buffers detached. SharedArrayBuffer-backed views are skipped
 * (they cannot detach and remain shared by contract).
 */
export function detachColumnarBuffers(
  snapshot: ColumnarGraphSnapshot<unknown, unknown>,
): number {
  let detached = 0;
  for (const buffer of columnarArrayBuffers(snapshot)) {
    if (buffer.byteLength === 0) continue; // already detached (idempotent)
    const transferable = buffer as ArrayBuffer & { transfer?: () => ArrayBuffer };
    if (typeof transferable.transfer === 'function') {
      transferable.transfer(); // ES2024 in-place detach; the clone is dropped
    } else {
      // Pre-ES2024 engines: structuredClone with a transfer list detaches
      // the source (supported everywhere the WebGL2 floor reaches).
      structuredClone(buffer, { transfer: [buffer] });
    }
    detached += 1;
  }
  return detached;
}
