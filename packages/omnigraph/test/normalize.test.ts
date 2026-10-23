import type { ExportRecord } from '@modernrelay/omnigraph';
import { describe, expect, it } from 'vitest';
import {
  classifyExportLine,
  encodeSourceId,
  InvalidExportLineError,
  normalizeEdge,
  normalizeNode,
  ORBIT_TYPE_KEY,
  parsePgSchema,
  UnknownEdgeTypeError,
} from '../src/index';

const SCHEMA = parsePgSchema(`
  node Event {
    slug: String @key
    day: Date?
    at: DateTime?
    payload: Blob?
    status: enum(open, closed)
    weight: F64?
  }
  node Actor {
    slug: String @key
    name: String
  }
  edge Caused: Event -> Actor @card(0..*) {
    strength: F64?
    linked_on: Date?
  }
`);

describe('classifyExportLine export shapes', () => {
  it('classifies node lines', () => {
    expect(classifyExportLine({ type: 'Event', id: 'e1', data: { slug: 'e1' } })).toEqual({
      kind: 'node',
      type: 'Event',
      id: 'e1',
      data: { slug: 'e1' },
    });
  });

  it('classifies edge lines', () => {
    expect(
      classifyExportLine({ edge: 'Caused', from: 'e1', to: 'a1', id: 'x', data: {} }),
    ).toEqual({ kind: 'edge', edge: 'Caused', from: 'e1', to: 'a1', id: 'x', data: {} });
  });

  it.each([
    ['null', null],
    ['string', 'nope'],
    ['array', [1, 2]],
    ['missing data', { type: 'Event' }],
    ['non-object data', { type: 'Event', data: 'x' }],
    ['edge missing from/to', { edge: 'Caused', id: 'x', data: {} }],
    ['non-string type', { type: 7, data: {} }],
    ['empty object', {}],
  ])('returns unknown for %s', (_label, line) => {
    expect(classifyExportLine(line)).toEqual({ kind: 'unknown' });
  });

  it.each([
    { type: 'Event', data: { id: 'user-id' } },
    { edge: 'Caused', from: 'e1', to: 'a1', data: { id: 'user-id' } },
    { type: 'Event', id: 42, data: {} },
  ])('rejects recognized entities without a top-level string identity', (line) => {
    expect(() => classifyExportLine(line)).toThrow(InvalidExportLineError);
  });
});

describe('normalizeNode identity and value normalization', () => {
  it("encodes id via the codec and injects attrs['orbit:type']", () => {
    const node = normalizeNode({ type: 'Actor', id: 'a1', data: { slug: 'a1', name: 'Ada' } }, SCHEMA);
    expect(node.id).toBe(encodeSourceId('Actor', 'a1'));
    expect(node.attrs).toEqual({
      [ORBIT_TYPE_KEY]: 'Actor',
      slug: 'a1',
      name: 'Ada',
    });
  });

  it("a source-declared 'type' property passes through UNTOUCHED alongside the discriminator", () => {
    const node = normalizeNode(
      { type: 'Actor', id: 'a1', data: { slug: 'a1', name: 'Ada', type: 'investor' } },
      SCHEMA,
    );
    // The whole point of the namespaced key: no collision, no preservation
    // mechanism, no warning — the schema's own field is ordinary data.
    expect(node.attrs).toEqual({
      [ORBIT_TYPE_KEY]: 'Actor', // adapter-owned kind
      type: 'investor', // the schema's own property, verbatim
      slug: 'a1',
      name: 'Ada',
    });
  });

  it("a forged export 'orbit:type' field never displaces the adapter's discriminator", () => {
    const node = normalizeNode(
      {
        type: 'Actor',
        id: 'a1',
        data: { slug: 'a1', type: 'investor', [ORBIT_TYPE_KEY]: 'Forged' },
      },
      SCHEMA,
    );
    // The discriminator lands LAST in the spread — the guard the generated
    // attrs unions depend on.
    expect(node.attrs![ORBIT_TYPE_KEY]).toBe('Actor');
    expect(node.attrs!['type']).toBe('investor');
  });

  it('does not let exported data overwrite the adapter-owned node discriminator', () => {
    const node = normalizeNode(
      { type: 'Event', id: 'e1', data: { slug: 'e1', [ORBIT_TYPE_KEY]: 'Actor' } },
      SCHEMA,
    );
    expect((node.attrs as Record<string, unknown>)[ORBIT_TYPE_KEY]).toBe('Event');
  });

  it('retains exported Date calendar strings', () => {
    const attrs = (day: string) =>
      normalizeNode({ type: 'Event', id: 'e', data: { day } }, SCHEMA).attrs as Record<
        string,
        unknown
      >;
    expect(attrs('1970-01-01')['day']).toBe('1970-01-01'); // epoch day 0
    expect(attrs('1969-12-31')['day']).toBe('1969-12-31'); // negative days
    expect(attrs('2024-10-04')['day']).toBe('2024-10-04');
    expect(attrs('1970-01-20')['day']).toBe('1970-01-20');
    expect(attrs('-0001-01-01')['day']).toBe('-000001-01-01');
    expect(attrs('+10000-01-01')['day']).toBe('+010000-01-01');
  });

  it('normalizes timezone-less UTC DateTime strings to explicit ISO 8601 UTC', () => {
    const node = normalizeNode(
      { type: 'Event', id: 'e', data: { at: '2023-11-14T22:13:20.123' } },
      SCHEMA,
    );
    expect((node.attrs as Record<string, unknown>)['at']).toBe('2023-11-14T22:13:20.123Z');
  });

  it.each([
    ['2024-01-01T00:00:00', '2024-01-01T00:00:00.000Z'],
    ['2024-01-01T00:00:00.1', '2024-01-01T00:00:00.100Z'],
    ['2024-01-01T00:00:00.12', '2024-01-01T00:00:00.120Z'],
    ['-0001-01-01T00:00:00', '-000001-01-01T00:00:00.000Z'],
    ['+10000-01-01T00:00:00', '+010000-01-01T00:00:00.000Z'],
  ])('normalizes server timestamp %s to a parseable UTC instant', (at, expected) => {
    const node = normalizeNode({ type: 'Event', id: 'e', data: { at } }, SCHEMA);
    expect(node.attrs!['at']).toBe(expected);
    expect(new Date(node.attrs!['at'] as string).toISOString()).toBe(expected);
  });

  it.each(['day', 'at'])('rejects legacy numeric %s encoding', (property) => {
    expect(() => normalizeNode({ type: 'Event', id: 'e', data: { [property]: 0 } }, SCHEMA))
      .toThrow(InvalidExportLineError);
  });

  it('uses physical ids separately from numeric user id properties on nodes and edges', () => {
    const schema = parsePgSchema('node N { id: I64? } edge R: N -> N { id: U64? }');
    const lines = [
      { type: 'N', id: 'physical-node', data: { id: 42 } },
      { edge: 'R', id: 'physical-edge', from: 'physical-node', to: 'physical-node', data: { id: 7 } },
    ] satisfies ExportRecord[];
    const node = normalizeNode(lines[0] as Extract<ExportRecord, { type: string }>, schema);
    const edge = normalizeEdge(lines[1] as Extract<ExportRecord, { edge: string }>, schema);
    expect(node.id).toBe(encodeSourceId('N', 'physical-node'));
    expect(edge.id).toBe(encodeSourceId('R', 'physical-edge'));
    expect(edge.source).toBe(node.id);
    expect(node.attrs!['id']).toBe(42);
    expect(edge.attrs!['id']).toBe(7);
    expect(normalizeNode({ type: 'N', id: 'other', data: {} }, schema).attrs!['id']).toBeNull();
  });

  it.each(['node', 'edge'] as const)('normalizes scalar encodings inside %s list properties', (kind) => {
    const properties = 'days: [Date] times: [DateTime] payloads: [Blob] missing: [Date]? tags: [String]';
    const schema = parsePgSchema(`node Event { ${properties} } edge Next: Event -> Event { ${properties} }`);
    const data = {
      days: ['1970-01-01', '1969-12-31', null], times: ['1970-01-01T00:00:00', '1970-01-01T00:00:01', null],
      payloads: ['base64:aGVsbG8=', 's3://bucket/key.bin'], tags: ['one', 'two'],
    };
    const normalized = kind === 'node'
      ? normalizeNode({ type: 'Event', id: 'e', data }, schema)
      : normalizeEdge({ edge: 'Next', id: 'e', from: 'a', to: 'b', data }, schema);
    expect(normalized.attrs).toMatchObject({
      days: ['1970-01-01', '1969-12-31', null],
      times: ['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:01.000Z', null],
      payloads: ['data:application/octet-stream;base64,aGVsbG8=', 's3://bucket/key.bin'],
      missing: null,
      tags: ['one', 'two'],
    });
    expect(data.days).toEqual(['1970-01-01', '1969-12-31', null]); // normalization leaves source rows intact
  });

  it('converts inline base64: blobs to data: URIs, leaves URI refs verbatim', () => {
    const inline = normalizeNode(
      { type: 'Event', id: 'e', data: { payload: 'base64:aGVsbG8=' } },
      SCHEMA,
    );
    expect((inline.attrs as Record<string, unknown>)['payload']).toBe(
      'data:application/octet-stream;base64,aGVsbG8=',
    );
    const ref = normalizeNode(
      { type: 'Event', id: 'e', data: { payload: 's3://bucket/key.bin' } },
      SCHEMA,
    );
    expect((ref.attrs as Record<string, unknown>)['payload']).toBe('s3://bucket/key.bin');
  });

  it('passes nulls, enums, floats, and undeclared keys through verbatim', () => {
    const node = normalizeNode(
      {
        type: 'Event',
        id: 'e',
        data: { day: null, status: 'open', weight: 0.5, mystery: 42 },
      },
      SCHEMA,
    );
    expect(node.attrs).toEqual({
      [ORBIT_TYPE_KEY]: 'Event',
      day: null,
      at: null,
      payload: null,
      status: 'open',
      weight: 0.5,
      mystery: 42,
    });
  });

  it('tolerates node types absent from the schema (attrs verbatim)', () => {
    const node = normalizeNode({ type: 'Ghost', id: 'g', data: { day: 20000 } }, SCHEMA);
    expect(node.id).toBe(encodeSourceId('Ghost', 'g'));
    // no schema info — no temporal normalization possible
    expect(node.attrs).toEqual({ [ORBIT_TYPE_KEY]: 'Ghost', day: 20000 });
  });

  it('throws a typed error when top-level id is missing or non-string', () => {
    expect(() => normalizeNode({ type: 'Event', data: { id: 'user-id', slug: 'e' } } as never, SCHEMA)).toThrow(
      InvalidExportLineError,
    );
    expect(() => normalizeNode({ type: 'Event', id: 42, data: {} } as never, SCHEMA)).toThrow(
      InvalidExportLineError,
    );
  });
});

describe('normalizeEdge endpoint resolution', () => {
  const line = {
    edge: 'Caused',
    from: 'e1',
    to: 'a1',
    id: 'edge-1', data: { strength: 0.9, linked_on: '2024-10-04' },
  };

  it('namespaces edge id and endpoint ids with schema-resolved types', () => {
    const edge = normalizeEdge(line, SCHEMA);
    expect(edge.id).toBe(encodeSourceId('Caused', 'edge-1'));
    expect(edge.source).toBe(encodeSourceId('Event', 'e1'));
    expect(edge.target).toBe(encodeSourceId('Actor', 'a1'));
  });

  it("injects attrs['orbit:type'] and normalizes edge property values", () => {
    const edge = normalizeEdge(line, SCHEMA);
    expect(edge.attrs).toEqual({
      [ORBIT_TYPE_KEY]: 'Caused',
      strength: 0.9,
      linked_on: '2024-10-04',
    });
  });

  it('does not let exported data overwrite the adapter-owned edge discriminator', () => {
    const edge = normalizeEdge(
      {
        ...line,
        data: { ...line.data, [ORBIT_TYPE_KEY]: 'ForgedEdgeType' },
      },
      SCHEMA,
    );
    expect((edge.attrs as Record<string, unknown>)[ORBIT_TYPE_KEY]).toBe('Caused');
  });

  it('throws UnknownEdgeTypeError for edge names the schema does not declare', () => {
    expect(() =>
      normalizeEdge({ edge: 'Nope', from: 'a', to: 'b', id: 'x', data: {} }, SCHEMA),
    ).toThrow(UnknownEdgeTypeError);
    try {
      normalizeEdge({ edge: 'Nope', from: 'a', to: 'b', id: 'x', data: {} }, SCHEMA);
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownEdgeTypeError);
      expect((err as UnknownEdgeTypeError).edgeName).toBe('Nope');
      expect((err as UnknownEdgeTypeError).name).toBe('UnknownEdgeTypeError');
    }
  });

  it('throws a typed error when edge top-level id is missing', () => {
    expect(() =>
      normalizeEdge({ edge: 'Caused', from: 'e1', to: 'a1', data: {} } as never, SCHEMA),
    ).toThrow(InvalidExportLineError);
  });
});

describe('classify → normalize pipeline over a mixed NDJSON batch', () => {
  it('handles edge-first streams in lexicographic table-key order', () => {
    const lines: ExportRecord[] = [
      { edge: 'Caused', from: 'e1', to: 'a1', id: 'c1', data: {} },
      { type: 'Actor', id: 'a1', data: { slug: 'a1', name: 'Ada' } },
      { type: 'Event', id: 'e1', data: { slug: 'e1', day: '1970-01-01' } },
    ];
    const nodes = [];
    const edges = [];
    for (const raw of lines) {
      const c = classifyExportLine(raw);
      if (c.kind === 'node') nodes.push(normalizeNode(c, SCHEMA));
      else if (c.kind === 'edge') edges.push(normalizeEdge(c, SCHEMA));
    }
    expect(edges).toHaveLength(1);
    expect(nodes).toHaveLength(2);
    expect(edges[0]?.source).toBe(nodes[1]?.id);
    expect(edges[0]?.target).toBe(nodes[0]?.id);
  });
});
