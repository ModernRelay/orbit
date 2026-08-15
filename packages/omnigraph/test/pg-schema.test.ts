import { describe, expect, it } from 'vitest';
import {
  bigIntKeyWarnings,
  edgeEndpointTypes,
  parsePgSchema,
  schemaFingerprint,
  type PgEdgeType,
  type PgNodeType,
} from '../src/index';

/**
 * Verbatim copy of the real fixture at
 * ~/code/omnigraph/crates/omnigraph/tests/fixtures/context.pg (server 0.8.x).
 */
const CONTEXT_PG = `// Context graph: decisions, the people behind them,
// the evidence trail, and market signals that inform them.

// ── Nodes ────────────────────────────────────────────

node Actor {
    slug: String @key
    name: String
    email: String? @unique
}

node Decision {
    slug: String @key
    title: String @index
    body: String?
    status: enum(proposed, accepted, rejected, superseded)
    urgency: enum(low, normal, high, critical)
    decided_at: Date?
}

node Trace {
    slug: String @key
    title: String @index
    body: String?
    kind: enum(note, discussion, experiment, review, meeting, document)
    recorded_at: Date
    source: String?
}

node Signal {
    slug: String @key
    title: String @index
    body: String?
    category: enum(competitor, market, regulatory, technology, customer)
    strength: enum(strong, moderate, weak)
    observed_at: Date
    source: String?
}

node Artifact {
    slug: String @key
    title: String @index
    kind: enum(doc, presentation, proposal, spec, report, memo)
    url: String?
    created_at: Date
}

// ── Ownership / participation ────────────────────────

edge OwnedBy: Decision -> Actor @card(1..1)

edge ParticipatedIn: Actor -> Decision

edge RecordedBy: Trace -> Actor @card(1..1)

edge AuthoredBy: Artifact -> Actor @card(1..1)

// ── Evidence trail ───────────────────────────────────

edge Supports: Trace -> Decision

edge Attached: Artifact -> Decision

edge CitedIn: Artifact -> Trace

// ── Signal linkage ───────────────────────────────────

edge Triggered: Signal -> Decision

edge Correlates: Signal -> Signal {
    @unique(src, dst)
}

// ── Decision lineage ─────────────────────────────────

edge Supersedes: Decision -> Decision {
    @unique(src, dst)
}
`;

function node(schema: ReturnType<typeof parsePgSchema>, name: string): PgNodeType {
  const n = schema.nodes.find((x) => x.name === name);
  if (!n) throw new Error(`node ${name} not parsed`);
  return n;
}

function edge(schema: ReturnType<typeof parsePgSchema>, name: string): PgEdgeType {
  const e = schema.edges.find((x) => x.name === name);
  if (!e) throw new Error(`edge ${name} not parsed`);
  return e;
}

describe('parsePgSchema on the real context.pg fixture', () => {
  const schema = parsePgSchema(CONTEXT_PG);

  it('parses every node type', () => {
    expect(schema.nodes.map((n) => n.name)).toEqual([
      'Actor',
      'Decision',
      'Trace',
      'Signal',
      'Artifact',
    ]);
  });

  it('parses every edge declaration with correct endpoints', () => {
    expect(schema.edges.map((e) => [e.name, e.from, e.to])).toEqual([
      ['OwnedBy', 'Decision', 'Actor'],
      ['ParticipatedIn', 'Actor', 'Decision'],
      ['RecordedBy', 'Trace', 'Actor'],
      ['AuthoredBy', 'Artifact', 'Actor'],
      ['Supports', 'Trace', 'Decision'],
      ['Attached', 'Artifact', 'Decision'],
      ['CitedIn', 'Artifact', 'Trace'],
      ['Triggered', 'Signal', 'Decision'],
      ['Correlates', 'Signal', 'Signal'],
      ['Supersedes', 'Decision', 'Decision'],
    ]);
  });

  it('parses Actor properties, @key, optionality, and @unique', () => {
    const actor = node(schema, 'Actor');
    expect(actor.properties).toEqual([
      { name: 'slug', type: 'String', optional: false, key: true, unique: false, index: false, annotations: ['@key'] },
      { name: 'name', type: 'String', optional: false, key: false, unique: false, index: false, annotations: [] },
      { name: 'email', type: 'String', optional: true, key: false, unique: true, index: false, annotations: ['@unique'] },
    ]);
  });

  it('parses enums with declared value order', () => {
    const decision = node(schema, 'Decision');
    const status = decision.properties.find((p) => p.name === 'status');
    expect(status?.type).toEqual({
      kind: 'enum',
      values: ['proposed', 'accepted', 'rejected', 'superseded'],
    });
    const kind = node(schema, 'Trace').properties.find((p) => p.name === 'kind');
    expect(kind?.type).toEqual({
      kind: 'enum',
      values: ['note', 'discussion', 'experiment', 'review', 'meeting', 'document'],
    });
  });

  it('parses Date properties and optionality', () => {
    const decidedAt = node(schema, 'Decision').properties.find((p) => p.name === 'decided_at');
    expect(decidedAt).toMatchObject({ type: 'Date', optional: true });
    const recordedAt = node(schema, 'Trace').properties.find((p) => p.name === 'recorded_at');
    expect(recordedAt).toMatchObject({ type: 'Date', optional: false });
  });

  it('parses @index flags', () => {
    for (const name of ['Decision', 'Trace', 'Signal', 'Artifact']) {
      const title = node(schema, name).properties.find((p) => p.name === 'title');
      expect(title?.index).toBe(true);
    }
  });

  it('parses @card and edge body constraints', () => {
    expect(edge(schema, 'OwnedBy').card).toBe('1..1');
    expect(edge(schema, 'RecordedBy').card).toBe('1..1');
    expect(edge(schema, 'ParticipatedIn').card).toBeUndefined();
    expect(edge(schema, 'Correlates').constraints).toEqual(['@unique(src, dst)']);
    expect(edge(schema, 'Supersedes').constraints).toEqual(['@unique(src, dst)']);
  });
});

describe('parsePgSchema grammar coverage beyond the fixture', () => {
  it('parses interfaces, implements expansion, vectors, lists, and block comments', () => {
    const schema = parsePgSchema(`
      /* block comment
         spanning lines */
      interface Named {
        name: String @index
      }
      node Doc implements Named {
        slug: String @key
        embedding: Vector(768) @embed("name")
        tags: [String]
        score: F64?
        raw: Blob?
        created: DateTime
      }
      edge Rel: Doc -> Doc @card(0..*) @custom("x, y")
    `);
    const doc = schema.nodes[0];
    expect(doc?.name).toBe('Doc');
    expect(doc?.implements).toEqual(['Named']);
    // interface property expanded ahead of the node's own
    expect(doc?.properties.map((p) => p.name)).toEqual([
      'name',
      'slug',
      'embedding',
      'tags',
      'score',
      'raw',
      'created',
    ]);
    expect(doc?.properties.find((p) => p.name === 'embedding')?.type).toEqual({
      kind: 'vector',
      dim: 768,
    });
    expect(doc?.properties.find((p) => p.name === 'tags')?.type).toEqual({
      kind: 'list',
      element: 'String',
    });
    expect(doc?.properties.find((p) => p.name === 'score')).toMatchObject({
      type: 'F64',
      optional: true,
    });
    expect(schema.interfaces.map((i) => i.name)).toEqual(['Named']);
    const rel = schema.edges[0];
    expect(rel).toMatchObject({ name: 'Rel', from: 'Doc', to: 'Doc', card: '0..*' });
    // unknown annotation preserved verbatim (string args untouched)
    expect(rel?.annotations).toContain('@custom("x, y")');
  });

  it('preserves unknown annotations and unknown types instead of failing', () => {
    const schema = parsePgSchema(`
      node Weird {
        a: String @key @frobnicate(1, "two")
        b: Quux?
      }
    `);
    const weird = schema.nodes[0];
    const a = weird?.properties.find((p) => p.name === 'a');
    expect(a?.key).toBe(true);
    expect(a?.annotations).toEqual(['@key', '@frobnicate(1, "two")']);
    expect(weird?.properties.find((p) => p.name === 'b')?.type).toEqual({
      kind: 'unknown',
      raw: 'Quux',
    });
  });

  it('applies body-level @key(...) constraints to the named properties', () => {
    const schema = parsePgSchema(`
      node Composite {
        region: String
        num: I64
        @key(region, num)
      }
    `);
    const composite = schema.nodes[0];
    expect(composite?.properties.find((p) => p.name === 'region')?.key).toBe(true);
    expect(composite?.properties.find((p) => p.name === 'num')?.key).toBe(true);
    expect(composite?.constraints).toEqual(['@key(region, num)']);
  });
});

describe('edgeEndpointTypes', () => {
  const schema = parsePgSchema(CONTEXT_PG);

  it('resolves declared endpoints', () => {
    expect(edgeEndpointTypes(schema, 'OwnedBy')).toEqual({ from: 'Decision', to: 'Actor' });
    expect(edgeEndpointTypes(schema, 'Correlates')).toEqual({ from: 'Signal', to: 'Signal' });
  });

  it('matches edge names case-insensitively (server behavior)', () => {
    expect(edgeEndpointTypes(schema, 'ownedby')).toEqual({ from: 'Decision', to: 'Actor' });
  });

  it('returns null for unknown edges', () => {
    expect(edgeEndpointTypes(schema, 'Nope')).toBeNull();
  });
});

describe('schemaFingerprint revision stamp', () => {
  it('matches FNV-1a 64-bit known vectors', () => {
    expect(schemaFingerprint('')).toBe('cbf29ce484222325');
    expect(schemaFingerprint('foobar')).toBe('85944171f73967e8');
  });

  it('is stable across calls and 16 lowercase hex chars', () => {
    const a = schemaFingerprint(CONTEXT_PG);
    expect(a).toBe(schemaFingerprint(CONTEXT_PG));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is sensitive to any textual change', () => {
    expect(schemaFingerprint(CONTEXT_PG)).not.toBe(schemaFingerprint(CONTEXT_PG + ' '));
    expect(schemaFingerprint(CONTEXT_PG)).not.toBe(
      schemaFingerprint(CONTEXT_PG.replace('email: String?', 'email: String')),
    );
  });
});

describe('bigIntKeyWarnings for the ≥2^53 hazard', () => {
  it('flags I64/U64 properties that are @key or named id', () => {
    const schema = parsePgSchema(`
      node Account {
        acct_num: I64 @key
        balance: U64
      }
      node Device {
        id: U64
        label: String
      }
      node Safe {
        slug: String @key
        count: I64
      }
      edge Linked: Account -> Device
    `);
    expect(bigIntKeyWarnings(schema)).toEqual([
      { type: 'Account', property: 'acct_num' },
      { type: 'Device', property: 'id' },
    ]);
  });

  it('reports nothing for the real fixture (string keys only)', () => {
    expect(bigIntKeyWarnings(parsePgSchema(CONTEXT_PG))).toEqual([]);
  });
});


describe('head annotations and same-line properties', () => {
  it('a node with a head annotation parses instead of vanishing', () => {
    const schema = parsePgSchema(
      'node Account @rename_from("User") {\n  id: String @key\n}\n' +
        'node Plain implements Base @tag(x) {\n  id: String @key\n}\n' +
        'interface Base {\n  id: String\n}\n',
    );
    const names = schema.nodes.map((n) => n.name).sort();
    expect(names).toEqual(['Account', 'Plain']);
    expect(schema.nodes.find((n) => n.name === 'Plain')?.implements).toEqual(['Base']);
  });

  it('head annotations with quoted/nested parens parse whole', () => {
    const schema = parsePgSchema(
      'node Account @rename_from("User (legacy)") @note("a)b", (1)) {\n  id: String @key\n}\n',
    );
    expect(schema.nodes.map((n) => n.name)).toEqual(['Account']);
    expect(schema.nodes[0]!.properties.map((p) => p.name)).toEqual(['id']);
  });

  it('same-line whitespace-separated properties all parse', () => {
    const schema = parsePgSchema('node N {\n  id: String @key when: DateTime score: Float?\n}\n');
    const props = schema.nodes[0]!.properties;
    expect(props.map((p) => p.name)).toEqual(['id', 'when', 'score']);
    expect(props[0]!.key).toBe(true);
    expect(props[2]!.optional).toBe(true);
  });
});
