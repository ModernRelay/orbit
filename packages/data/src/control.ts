import { throwIfAborted } from './sources';
import type { GraphPrepareAnyOptions, GraphPrepareProgress } from './types';

/** One invocation owns all counters, including both node and edge sources. */
export class PreparationControl {
  private bytes = 0;
  private nodes = 0;
  private edges = 0;
  private lastProgress = -Infinity;
  private lastYield = Date.now();
  private work = 0;

  constructor(readonly options: GraphPrepareAnyOptions) {
    if (typeof options.datasetKey !== 'string' || options.datasetKey === '') {
      throw new TypeError('prepareGraphData: options.datasetKey must be a non-empty string');
    }
    if ((typeof options.sourceRevision !== 'string' && typeof options.sourceRevision !== 'number') ||
        (typeof options.sourceRevision === 'number' && !Number.isFinite(options.sourceRevision))) {
      throw new TypeError('prepareGraphData: options.sourceRevision must be a string or finite number');
    }
    for (const key of ['maxBytes', 'maxNodes', 'maxEdges'] as const) {
      const limit = options[key];
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
        throw new TypeError(`prepareGraphData: ${key} must be a positive safe integer`);
      }
    }
    if (options.output !== undefined && options.output !== 'object' && options.output !== 'columnar') {
      throw new TypeError('prepareGraphData: output must be object or columnar');
    }
    this.check();
  }

  check(): void { throwIfAborted(this.options.signal); }

  private bounded(next: number, key: 'maxBytes' | 'maxNodes' | 'maxEdges'): number {
    this.check();
    const limit = this.options[key];
    if (!Number.isSafeInteger(next) || (limit !== undefined && next > limit)) {
      throw new RangeError(`prepareGraphData: ${key} limit ${limit ?? Number.MAX_SAFE_INTEGER} exceeded (${next})`);
    }
    return next;
  }

  read(bytes: number): void {
    this.bytes = this.bounded(this.bytes + bytes, 'maxBytes');
    this.report('reading');
  }

  admit(role: 'nodes' | 'edges'): void {
    if (role === 'nodes') this.nodes = this.bounded(this.nodes + 1, 'maxNodes');
    else this.edges = this.bounded(this.edges + 1, 'maxEdges');
    this.report('preparing');
  }

  /** Yield a task, not only a microtask, so browser cancellation can run. */
  async checkpoint(): Promise<void> {
    this.check();
    if ((++this.work & 255) === 0 && Date.now() - this.lastYield >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      this.lastYield = Date.now();
      this.check();
    }
  }

  report(phase: GraphPrepareProgress['phase']): void {
    this.check();
    const now = Date.now();
    if (phase !== 'complete' && now - this.lastProgress < 100) return;
    this.lastProgress = now;
    this.options.onProgress?.({ phase, bytes: this.bytes, nodes: this.nodes, edges: this.edges });
    this.check();
  }
}
