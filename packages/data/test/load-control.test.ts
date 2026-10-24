import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareGraphData, previewCsv } from '../src/index';
import type { GraphPrepareProgress } from '../src/index';
import { _internals, prepareParquetGraphData } from '../src/parquet';

const mapping = { nodes: { id: 'id' }, edges: { source: 'source', target: 'target' } };
const options = { datasetKey: 'control', sourceRevision: 1 };
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const realImport = _internals.importHyparquet;
afterEach(() => { _internals.importHyparquet = realImport; vi.restoreAllMocks(); });

describe('preparation cancellation and budgets', () => {
  it('rejects cancellation during Parquet decoding, including an empty decoded table', async () => {
    for (const rows of [[], [{ source: 'a', target: 'b' }]]) {
      const controller = new AbortController();
      _internals.importHyparquet = async () => ({ parquetReadObjects: async () => {
        controller.abort();
        return rows;
      } });
      await expect(prepareParquetGraphData({ edges: new ArrayBuffer(0), deriveNodes: true }, mapping,
        { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    }
  });

  it('checks Parquet cancellation again while rows are normalized', async () => {
    const controller = new AbortController();
    let secondRead = false;
    _internals.importHyparquet = async () => ({ parquetReadObjects: async () => [
      { source: 'a', get target() { controller.abort('cancelled'); return 'b'; } },
      { get source() { secondRead = true; return 'b'; }, target: 'c' },
    ] });
    await expect(prepareParquetGraphData({ edges: new ArrayBuffer(0), deriveNodes: true }, mapping,
      { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(secondRead).toBe(false);
  });

  it('does not wait for a stalled decoder or source after cancellation', async () => {
    const decoderController = new AbortController();
    _internals.importHyparquet = async () => ({ parquetReadObjects: () => {
      queueMicrotask(() => decoderController.abort());
      return new Promise(() => {});
    } });
    await expect(prepareParquetGraphData({ edges: new ArrayBuffer(0), deriveNodes: true }, mapping,
      { ...options, signal: decoderController.signal })).rejects.toMatchObject({ name: 'AbortError' });

    const controller = new AbortController();
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source: AsyncIterable<unknown> = { [Symbol.asyncIterator]: () => ({
      next: () => {
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
      },
      return: close,
    }) };
    await expect(prepareGraphData({ edges: source, deriveNodes: true }, mapping,
      { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('yields a task so a timer can cancel resident row input and closes its iterator', async () => {
    const controller = new AbortController();
    let seen = 0;
    let closed = false;
    async function* edges() {
      try {
        for (let i = 0; i < 100_000; i++) { seen++; yield { source: 'a', target: 'b' }; }
      } finally { closed = true; }
    }
    const timer = setTimeout(() => controller.abort(), 0);
    try {
      await expect(prepareGraphData({ edges: edges(), deriveNodes: true }, mapping,
        { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(seen).toBeLessThan(100_000);
      expect(closed).toBe(true);
    } finally { clearTimeout(timer); }
  });

  it('enforces combined byte budgets and closes a source when the next chunk exceeds the cap', async () => {
    let closed = false;
    async function* edges() {
      try { yield new Uint8Array(bytes('source,target\n')); yield new Uint8Array(bytes('a,b\n')); }
      finally { closed = true; }
    }
    await expect(prepareGraphData({ edges: edges(), deriveNodes: true }, mapping,
      { ...options, format: 'csv', maxBytes: 14 })).rejects.toThrow(/maxBytes.*exceeded/);
    expect(closed).toBe(true);
    await expect(prepareGraphData({ nodes: bytes('id\na\n'), edges: bytes('source,target\na,a\n') }, mapping,
      { ...options, maxBytes: 20 })).rejects.toThrow(/maxBytes.*exceeded/);
  });

  it('counts derived unique nodes and actual edge rows before retaining an over-limit row', async () => {
    const input = { edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'b' }], deriveNodes: true as const };
    await expect(prepareGraphData(input, mapping, { ...options, maxNodes: 2, maxEdges: 2 })).resolves.toMatchObject({ snapshot: { nodes: [{ id: 'a' }, { id: 'b' }] } });
    await expect(prepareGraphData(input, mapping, { ...options, maxNodes: 1 })).rejects.toThrow(/maxNodes/);
    await expect(prepareGraphData(input, mapping, { ...options, maxEdges: 1 })).rejects.toThrow(/maxEdges/);
    await expect(prepareGraphData({ nodes: [{ id: 'a' }, { id: 'a' }], edges: [] }, mapping,
      { ...options, maxNodes: 1 })).rejects.toThrow(/maxNodes/);
  });

  it('validates budgets before opening an input', async () => {
    const open = vi.fn();
    const source = { [Symbol.asyncIterator]() { open(); throw new Error('opened'); } };
    for (const maxBytes of [0, -1, Infinity, NaN, 1.5]) {
      await expect(prepareGraphData({ edges: source, deriveNodes: true }, mapping,
        { ...options, maxBytes })).rejects.toThrow(/positive safe integer/);
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('throttles progress but always reports exact completed totals', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const progress: GraphPrepareProgress[] = [];
    const csv = 'source,target\n' + 'a,b\n'.repeat(2000);
    await prepareGraphData({ edges: bytes(csv), deriveNodes: true }, mapping,
      { ...options, onProgress: (p) => progress.push(p) });
    expect(progress).toHaveLength(2);
    expect(progress[0]?.phase).toBe('reading');
    expect(progress[1]).toEqual({ phase: 'complete', bytes: new TextEncoder().encode(csv).byteLength, nodes: 2, edges: 2000 });
  });

  it('closes inputs when a progress callback cancels the operation', async () => {
    const controller = new AbortController();
    let closed = false;
    async function* edges() { try { yield { source: 'a', target: 'b' }; } finally { closed = true; } }
    await expect(prepareGraphData({ edges: edges(), deriveNodes: true }, mapping,
      { ...options, signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(closed).toBe(true);
  });
});

describe('bounded CSV preview', () => {
  it('reuses quoted CSV parsing, keeps raw identifiers and closes after the sample', async () => {
    let readTail = false;
    let closed = false;
    async function* source() {
      try {
        yield new Uint8Array(bytes('source,target,label\n01,2,"line\nwith ""quote"""\n'));
        readTail = true;
        yield new Uint8Array(bytes('3,4,extra\n'));
      } finally { closed = true; }
    }
    expect(await previewCsv(source(), { maxRows: 1 })).toEqual({
      columns: ['source', 'target', 'label'],
      rows: [{ source: '01', target: '2', label: 'line\nwith "quote"' }], truncated: true,
    });
    expect(readTail).toBe(false);
    expect(closed).toBe(true);
  });

  it('previews the prefix of a large resident file without requiring its entire size budget', async () => {
    const value = await previewCsv(bytes('s,t\na,b\n' + 'x,y\n'.repeat(100_000)), { maxRows: 1, maxBytes: 20 });
    expect(value.rows).toEqual([{ s: 'a', t: 'b' }]);
  });

  it('rejects an over-budget quoted record and closes its source', async () => {
    let closed = false;
    async function* source() { try { yield new Uint8Array(bytes('a,b\n"' + 'x'.repeat(100) + '",b\n')); } finally { closed = true; } }
    await expect(previewCsv(source(), { maxBytes: 10 })).rejects.toThrow(/maxBytes/);
    expect(closed).toBe(true);
    await expect(previewCsv(bytes('a,b\n"unfinished'))).rejects.toThrow(/unterminated/);
  });
});
