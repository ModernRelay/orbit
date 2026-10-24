import { nextSynthesizedEdgeId } from '@modernrelay/orbit-core';
import type { Column, ColumnarGraphSnapshot, EdgePairCounters, StringColumn } from '@modernrelay/orbit-core';
import type { PreparationControl } from './control';

/** Grow typed storage geometrically; never retain a GraphNode/GraphEdge array. */
class Values {
  private kind: 'number' | 'boolean' | 'string' | undefined;
  private data = new Float64Array(0);
  private nulls = new Uint8Array(0);
  private dictionary: string[] = [];
  private codes = new Map<string, number>();

  constructor(private readonly name: string) {}

  set(index: number, raw: unknown): void {
    const value = typeof raw === 'number' && !Number.isFinite(raw) ? null : raw;
    if (value === null || value === undefined) return;
    const kind = typeof value;
    if (kind !== 'number' && kind !== 'boolean' && kind !== 'string') {
      throw new TypeError(`prepareGraphData: columnar ${this.name} at row ${index} cannot represent ${kind}; use output:'object' for nested or non-primitive attributes`);
    }
    if (this.kind !== undefined && this.kind !== kind) {
      throw new TypeError(`prepareGraphData: columnar ${this.name} mixes ${this.kind} and ${kind} at row ${index}; use output:'object'`);
    }
    this.kind = kind;
    this.grow(index + 1);
    this.nulls[index] = 0;
    if (typeof value === 'string') {
      let code = this.codes.get(value);
      if (code === undefined) {
        code = this.dictionary.length;
        this.codes.set(value, code);
        this.dictionary.push(value);
      }
      this.data[index] = code;
    } else this.data[index] = typeof value === 'boolean' ? Number(value) : value as number;
  }

  private grow(length: number): void {
    if (length <= this.data.length) return;
    const capacity = Math.max(length, this.data.length * 2, 16);
    const data = new Float64Array(capacity);
    data.set(this.data);
    const nulls = new Uint8Array(capacity).fill(1);
    nulls.set(this.nulls);
    this.data = data;
    this.nulls = nulls;
  }

  finish(length: number): Column {
    this.grow(length);
    const mask = this.nulls.slice(0, length);
    const nullable = mask.includes(1) ? { nulls: mask } : {};
    if (this.kind === 'string') {
      return { kind: 'string', dictionary: this.dictionary, codes: Uint32Array.from(this.data.subarray(0, length)), ...nullable };
    }
    if (this.kind === 'boolean') return { kind: 'bool', data: Uint8Array.from(this.data.subarray(0, length)), ...nullable };
    return { kind: 'f64', data: this.data.slice(0, length), ...nullable };
  }
}

class Attributes {
  private columns = new Map<string, Values>();
  constructor(private readonly role: string) {}

  seed(names: readonly string[]): void {
    for (const name of names) this.column(name);
  }

  private column(name: string): Values {
    // Core currently materializes attributes using plain assignment. This
    // special setter cannot faithfully survive that bridge; fail explicitly.
    if (name === '__proto__') throw new TypeError("prepareGraphData: columnar __proto__ attributes require output:'object'");
    let column = this.columns.get(name);
    if (column === undefined) {
      column = new Values(`${this.role}.${name}`);
      this.columns.set(name, column);
    }
    return column;
  }

  add(attrs: Record<string, unknown> | undefined, row: number): void {
    if (attrs === undefined) return;
    for (const name of Object.keys(attrs)) this.column(name).set(row, attrs[name]);
  }

  finish(length: number): Record<string, Column> {
    return Object.fromEntries([...this.columns].map(([name, column]) => [name, column.finish(length)]));
  }
}

function ids(values: readonly string[]): StringColumn {
  const dictionary: string[] = [];
  const index = new Map<string, number>();
  const codes = new Uint32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    let code = index.get(value);
    if (code === undefined) {
      code = dictionary.length;
      dictionary.push(value);
      index.set(value, code);
    }
    codes[i] = code;
  }
  return { kind: 'string', dictionary, codes };
}

export class ColumnarBuilder {
  private nodeIds: string[] = [];
  private edgeIds: (string | undefined)[] = [];
  private sources: string[] = [];
  private targets: string[] = [];
  readonly nodeAttributes = new Attributes('nodes');
  readonly edgeAttributes = new Attributes('edges');

  node(id: string, attrs?: Record<string, unknown>): void {
    this.nodeAttributes.add(attrs, this.nodeIds.length);
    this.nodeIds.push(id);
  }

  edge(source: string, target: string, id: string | undefined, attrs?: Record<string, unknown>): void {
    this.edgeAttributes.add(attrs, this.edgeIds.length);
    this.edgeIds.push(id);
    this.sources.push(source);
    this.targets.push(target);
  }

  async finish(control: PreparationControl): Promise<ColumnarGraphSnapshot> {
    const nodeIndex = new Map<string, number>();
    for (let i = 0; i < this.nodeIds.length; i++) {
      if (!nodeIndex.has(this.nodeIds[i]!)) nodeIndex.set(this.nodeIds[i]!, i);
    }
    const source = new Uint32Array(this.edgeIds.length);
    const target = new Uint32Array(this.edgeIds.length);
    const edgeIds: string[] = [];
    const counters: EdgePairCounters = new Map();
    for (let i = 0; i < this.edgeIds.length; i++) {
      await control.checkpoint();
      const from = this.sources[i]!;
      const to = this.targets[i]!;
      const s = nodeIndex.get(from);
      const t = nodeIndex.get(to);
      if (s === undefined || t === undefined) {
        throw new TypeError(`prepareGraphData: columnar edge ${i} has an unknown endpoint ${JSON.stringify(s === undefined ? from : to)}; supply its node or use output:'object' for core's dangling-edge diagnostics`);
      }
      source[i] = s;
      target[i] = t;
      edgeIds.push(this.edgeIds[i] ?? nextSynthesizedEdgeId(counters, from, to));
    }
    return {
      kind: 'columnar',
      datasetKey: control.options.datasetKey,
      sourceRevision: control.options.sourceRevision,
      bufferOwnership: 'borrowed',
      nodes: { ids: ids(this.nodeIds), columns: this.nodeAttributes.finish(this.nodeIds.length), length: this.nodeIds.length },
      edges: { ids: ids(edgeIds), source, target, columns: this.edgeAttributes.finish(edgeIds.length), length: edgeIds.length },
    };
  }
}
