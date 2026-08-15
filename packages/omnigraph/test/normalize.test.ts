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
    expect(classifyExportLine({ type: 'Event', data: { id: 'e1', slug: 'e1' } })).toEqual({
      kind: 'node',
      type: 'Event',
      data: { id: 'e1', slug: 'e1' },
    });
  });

  it('classifies edge lines', () => {
    expect(
      classifyExportLine({ edge: 'Caused', from: 'e1', to: 'a1', data: { id: 'x' } }),
    ).toEqual({ kind: 'edge', edge: 'Caused', from: 'e1', to: 'a1', data: { id: 'x' } });
  });

  it.each([
    ['null', null],
    ['string', 'nope'],
    ['array', [1, 2]],
    ['missing data', { type: 'Event' }],
    ['non-object data', { type: 'Event', data: 'x' }],
    ['edge missing from/to', { edge: 'Caused', data: { id: 'x' } }],
    ['non-string type', { type: 7, data: {} }],
    ['empty object', {}],
  ])('returns unknown for %s', (_label, line) => {
    expect(classifyExportLine(line)).toEqual({ kind: 'unknown' });
  });
});

describe('normalizeNode identity and value normalization', () => {
  it("encodes id via the codec and injects attrs['orbit:type']", () => {
    const node = normalizeNode({ type: 'Actor', data: { id: 'a1', slug: 'a1', name: 'Ada' } }, SCHEMA);
    expect(node.id).toBe(encodeSourceId('Actor', 'a1'));
    expect(node.attrs).toEqual({
      [ORBIT_TYPE_KEY]: 'Actor',
      id: 'a1',
      slug: 'a1',
      name: 'Ada',
    });
  });

  it("a source-declared 'type' property passes through UNTOUCHED alongside the discriminator", () => {
    const node = normalizeNode(
      { type: 'Actor', data: { id: 'a1', slug: 'a1', name: 'Ada', type: 'investor' } },
      SCHEMA,
    );
    // The whole point of the namespaced key: no collision, no preservation
    // mechanism, no warning — the schema's own field is ordinary data.
    expect(node.attrs).toEqual({
      [ORBIT_TYPE_KEY]: 'Actor', // adapter-owned kind
      type: 'investor', // the schema's own property, verbatim
      id: 'a1',
      slug: 'a1',
      name: 'Ada',
    });
  });

  it("a forged export 'orbit:type' field never displaces the adapter's discriminator", () => {
    const node = normalizeNode(
      {
        type: 'Actor',
        data: { id: 'a1', slug: 'a1', type: 'investor', [ORBIT_TYPE_KEY]: 'Forged' },
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
      { type: 'Event', data: { id: 'e1', slug: 'e1', [ORBIT_TYPE_KEY]: 'Actor' } },
      SCHEMA,
    );
    expect((node.attrs as Record<string, unknown>)[ORBIT_TYPE_KEY]).toBe('Event');
  });

  it('normalizes Date day-numbers to YYYY-MM-DD (UTC)', () => {
    const attrs = (day: number) =>
      normalizeNode({ type: 'Event', data: { id: 'e', day } }, SCHEMA).attrs as Record<
        string,
        unknown
      >;
    expect(attrs(0)['day']).toBe('1970-01-01'); // epoch day 0
    expect(attrs(-1)['day']).toBe('1969-12-31'); // negative days
    expect(attrs(20000)['day']).toBe('2024-10-04');
    expect(attrs(19)['day']).toBe('1970-01-20');
  });

  it('normalizes DateTime epoch-ms to ISO 8601', () => {
    const node = normalizeNode(
      { type: 'Event', data: { id: 'e', at: 1_700_000_000_123 } },
      SCHEMA,
    );
    expect((node.attrs as Record<string, unknown>)['at']).toBe('2023-11-14T22:13:20.123Z');
  });

  it('converts inline base64: blobs to data: URIs, leaves URI refs verbatim', () => {
    const inline = normalizeNode(
      { type: 'Event', data: { id: 'e', payload: 'base64:aGVsbG8=' } },
      SCHEMA,
    );
    expect((inline.attrs as Record<string, unknown>)['payload']).toBe(
      'data:application/octet-stream;base64,aGVsbG8=',
    );
    const ref = normalizeNode(
      { type: 'Event', data: { id: 'e', payload: 's3://bucket/key.bin' } },
      SCHEMA,
    );
    expect((ref.attrs as Record<string, unknown>)['payload']).toBe('s3://bucket/key.bin');
  });

  it('passes nulls, enums, floats, and undeclared keys through verbatim', () => {
    const node = normalizeNode(
      {
        type: 'Event',
        data: { id: 'e', day: null, status: 'open', weight: 0.5, mystery: 42 },
      },
      SCHEMA,
    );
    expect(node.attrs).toEqual({
      [ORBIT_TYPE_KEY]: 'Event',
      id: 'e',
      day: null,
      status: 'open',
      weight: 0.5,
      mystery: 42,
    });
  });

  it('tolerates node types absent from the schema (attrs verbatim)', () => {
    const node = normalizeNode({ type: 'Ghost', data: { id: 'g', day: 20000 } }, SCHEMA);
    expect(node.id).toBe(encodeSourceId('Ghost', 'g'));
    // no schema info — no temporal normalization possible
    expect(node.attrs).toEqual({ [ORBIT_TYPE_KEY]: 'Ghost', id: 'g', day: 20000 });
  });

  it('throws a typed error when data.id is missing or non-string', () => {
    expect(() => normalizeNode({ type: 'Event', data: { slug: 'e' } }, SCHEMA)).toThrow(
      InvalidExportLineError,
    );
    expect(() => normalizeNode({ type: 'Event', data: { id: 9007199254740993 } }, SCHEMA)).toThrow(
      InvalidExportLineError,
    );
  });
});

describe('normalizeEdge endpoint resolution', () => {
  const line = {
    edge: 'Caused',
    from: 'e1',
    to: 'a1',
    data: { id: 'edge-1', strength: 0.9, linked_on: 20000 },
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
      id: 'edge-1',
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
      normalizeEdge({ edge: 'Nope', from: 'a', to: 'b', data: { id: 'x' } }, SCHEMA),
    ).toThrow(UnknownEdgeTypeError);
    try {
      normalizeEdge({ edge: 'Nope', from: 'a', to: 'b', data: { id: 'x' } }, SCHEMA);
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownEdgeTypeError);
      expect((err as UnknownEdgeTypeError).edgeName).toBe('Nope');
      expect((err as UnknownEdgeTypeError).name).toBe('UnknownEdgeTypeError');
    }
  });

  it('throws a typed error when edge data.id is missing', () => {
    expect(() =>
      normalizeEdge({ edge: 'Caused', from: 'e1', to: 'a1', data: {} }, SCHEMA),
    ).toThrow(InvalidExportLineError);
  });
});

describe('classify → normalize pipeline over a mixed NDJSON batch', () => {
  it('handles edge-first streams in lexicographic table-key order', () => {
    const lines: unknown[] = [
      { edge: 'Caused', from: 'e1', to: 'a1', data: { id: 'c1' } },
      { type: 'Actor', data: { id: 'a1', slug: 'a1', name: 'Ada' } },
      { type: 'Event', data: { id: 'e1', slug: 'e1', day: 0 } },
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
