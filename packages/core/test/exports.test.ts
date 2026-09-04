/**
 * Instance export surface.
 *
 * The pure renderer is pinned in svg-export.test.ts; this suite pins the
 * INSTANCE contracts: visible-set sourcing, the one-pin-per-operation
 * revision rule, typed too-large rejections BEFORE allocation, and the
 * capability-gated PNG path.
 */

import { describe, expect, it } from 'vitest';

import { container, makeInstance, snap } from './helpers';

async function ready(engineOptions?: { screenshot?: Blob | null }) {
  const h = makeInstance({ fitViewOnFirstData: false, ...(engineOptions ? { engineOptions } : {}) });
  await h.instance.attach(container);
  h.instance.applyHostUpdate({
    data: snap(1, ['a', 'b', 'c', 'd'], [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ]),
  });
  return { ...h, engine: h.engines[0]! };
}

describe('exportImage("svg")', () => {
  it('renders the VISIBLE set: one circle per mask-visible node, edges need both ends', async () => {
    const { instance } = await ready();
    instance.hideNodes(['d']); // masks d AND cascades c-d
    const svg = await instance.exportImage('svg');

    expect(svg.match(/<circle /g)).toHaveLength(3);
    expect(svg.match(/<line /g)).toHaveLength(2); // a-b, b-c; c-d dropped
    expect(svg.startsWith('<svg ')).toBe(true);
  });

  it('rejects export-too-large with the element count, BEFORE assembling', async () => {
    const { instance } = await ready();
    await expect(
      instance.exportImage('svg', { maxSvgElements: 2 }),
    ).rejects.toMatchObject({
      detail: { code: 'export-too-large', elementCount: 7, limit: 2 },
    });
  });

  it('falls back to raster-hybrid through captureScreenshot when asked', async () => {
    const { instance } = await ready({ screenshot: new Blob(['png-bytes'], { type: 'image/png' }) });
    const svg = await instance.exportImage('svg', {
      maxSvgElements: 2,
      fallback: 'raster-hybrid',
    });
    expect(svg).toContain('<image href="data:');
    expect(svg).not.toContain('<circle'); // the raster carries the nodes
  });
});

describe('exportImage("png")', () => {
  it('delegates to the engine capture and rejects typed when unsupported', async () => {
    // FakeEngine default: capture resolves null (unsupported/not ready).
    const bare = await ready();
    await expect(bare.instance.exportImage('png')).rejects.toMatchObject({
      detail: { code: 'aborted' },
    });
    const capable = await ready({ screenshot: new Blob(['png'], { type: 'image/png' }) });
    const blob = await capable.instance.exportImage('png');
    expect(blob.type).toBe('image/png');
  });
});

describe('exportData / exportDataStream', () => {
  it.each([false, true])(
    'pins edge masks, counts exportable rows, and preserves accepted edges (parallel grouping: %s)',
    async (parallelEdgeGrouping) => {
      const { instance } = makeInstance({ fitViewOnFirstData: false });
      try {
        instance.applyHostUpdate({
          data: {
            ...snap(1, ['a', 'b', 'c']),
            edges: [
              { id: 'hidden', source: 'a', target: 'b', attrs: { weight: 1 } },
              { id: 'shown', source: 'a', target: 'b', attrs: { weight: 2 } },
              { id: 'other', source: 'b', target: 'c', attrs: { weight: 1 } },
            ],
          },
          parallelEdgeGrouping,
          filter: { edges: (edge) => edge.attrs?.weight === 2 },
        });
        const visible = await instance.exportData('visible', { limit: 4 });
        expect(visible.nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
        expect(visible.edges.map((edge) => edge.id)).toEqual(['shown']);
        await expect(instance.exportData('visible', { limit: 3 })).rejects.toMatchObject({
          detail: { code: 'export-materialization-too-large', rowCount: 4, limit: 3 },
        });
        const accepted = await instance.exportData('accepted');
        expect(accepted.edges.map((edge) => edge.id)).toEqual(['hidden', 'shown', 'other']);

        const visibleStream = instance.exportDataStream('visible');
        const acceptedStream = instance.exportDataStream('accepted');
        instance.applyHostUpdate({ filter: { edges: () => false } });
        expect((await instance.exportData('visible', { limit: 3 })).edges).toEqual([]);
        // Change the live mask before the first read, then again mid-stream.
        const first = await visibleStream.next();
        expect(JSON.parse(first.value!).value.id).toBe('a');
        instance.applyHostUpdate({ filter: null });
        const streamedEdges: string[] = [];
        for await (const line of visibleStream) {
          const row = JSON.parse(line) as { kind: string; value: { id: string } };
          if (row.kind === 'edge') streamedEdges.push(row.value.id);
        }
        expect(streamedEdges).toEqual(['shown']);
        const acceptedEdges: string[] = [];
        for await (const line of acceptedStream) {
          const row = JSON.parse(line) as { kind: string; value: { id: string } };
          if (row.kind === 'edge') acceptedEdges.push(row.value.id);
        }
        expect(acceptedEdges).toEqual(['hidden', 'shown', 'other']);

        instance.applyHostUpdate({ filter: { mode: 'dim', edges: () => false } });
        expect((await instance.exportData('visible')).edges.map((edge) => edge.id))
          .toEqual(['hidden', 'shown', 'other']);
      } finally {
        instance.destroy();
      }
    },
  );

  it('visible scope honors the mask; accepted scope is the full model', async () => {
    const { instance } = await ready();
    instance.hideNodes(['d']);

    const visible = await instance.exportData('visible');
    expect(visible.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(visible.edges).toHaveLength(2);

    const accepted = await instance.exportData('accepted');
    expect(accepted.nodes).toHaveLength(4);
    expect(accepted.edges).toHaveLength(3);
  });

  it('rejects export-materialization-too-large BEFORE materializing', async () => {
    const { instance } = await ready();
    await expect(instance.exportData('accepted', { limit: 3 })).rejects.toMatchObject({
      detail: { code: 'export-materialization-too-large', rowCount: 7, limit: 3 },
    });
  });

  it('REVISION PIN: a commit mid-stream never mixes epochs', async () => {
    const { instance } = await ready();
    const stream = instance.exportDataStream('accepted');

    // Consume ONE line, then replace the whole dataset.
    const first = await stream.next();
    expect(JSON.parse(first.value!).value.id).toBe('a');
    instance.applyHostUpdate({ data: snap(2, ['x', 'y'], [['x', 'y']]) });

    // The stream finishes with the PINNED epoch's rows — the old model.
    const rest: string[] = [];
    for await (const line of stream) rest.push(line);
    // Order-proof assertions: no new-epoch ids anywhere, old count intact.
    expect(rest.join('')).not.toContain('"x"');
    expect(rest.join('')).not.toContain('"y"');
    // And the full line count matches the OLD epoch (3 remaining nodes + 3 edges).
    expect(rest).toHaveLength(6);
  });

  it('PINS AT CALL TIME: a commit before the FIRST next() still exports the old epoch', async () => {
    // Async generator bodies are lazy, so a
    // body-scoped pin would capture whatever epoch exists at first next.
    // The pin must be taken when the stream is OBTAINED.
    const { instance } = await ready();
    const stream = instance.exportDataStream('accepted');

    // Nothing consumed yet — replace the dataset entirely.
    instance.applyHostUpdate({ data: snap(2, ['x', 'y'], [['x', 'y']]) });

    const lines: string[] = [];
    for await (const line of stream) lines.push(line);
    expect(lines).toHaveLength(7); // 4 old nodes + 3 old edges
    expect(lines.join('')).not.toContain('"x"');
    expect(JSON.parse(lines[0]!).value.id).toBe('a');
  });

  it('layout stream pins its readback at call time too', async () => {
    const { instance } = await ready();
    const stream = instance.exportLayoutStream();
    instance.applyHostUpdate({ data: snap(2, ['x', 'y'], [['x', 'y']]) });
    const lines: string[] = [];
    for await (const line of stream) lines.push(line);
    expect(lines).toHaveLength(4); // the OLD scene's four nodes
    const ids = lines.map((l) => (JSON.parse(l) as { id: string }).id);
    expect(ids).toEqual(['a', 'b', 'c', 'd']); // never the new epoch's x/y
  });

  it('JSONL lines parse and carry the kind tags', async () => {
    const { instance } = await ready();
    const lines: Array<{ kind: string }> = [];
    for await (const line of instance.exportDataStream('accepted')) {
      expect(line.endsWith('\n')).toBe(true);
      lines.push(JSON.parse(line));
    }
    expect(lines.filter((l) => l.kind === 'node')).toHaveLength(4);
    expect(lines.filter((l) => l.kind === 'edge')).toHaveLength(3);
  });
});

describe('exportLayout / exportLayoutStream', () => {
  it('returns an id-keyed coordinate map over the scene', async () => {
    const { instance } = await ready();
    const layout = await instance.exportLayout();
    expect(layout.size).toBe(4);
    const a = layout.get('a')!;
    expect(Number.isFinite(a[0])).toBe(true);
    expect(Number.isFinite(a[1])).toBe(true);
  });

  it('rejects typed past the limit; the stream is the remedy', async () => {
    const { instance } = await ready();
    await expect(instance.exportLayout({ limit: 2 })).rejects.toMatchObject({
      detail: { code: 'export-materialization-too-large', rowCount: 4, limit: 2 },
    });
    const lines: string[] = [];
    for await (const line of instance.exportLayoutStream()) lines.push(line);
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: 'a' });
  });
});
