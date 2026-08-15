/**
 * `.pg` → TypeScript codegen — golden-file style tests.
 *
 * Two real schemas drive the assertions:
 * - the verbatim server fixture `context.pg` (embedded below), and
 * - the workspace fixture `fixtures/omnigraph/cluster/demo.pg` (imported
 * `?raw`), whose generated output is COMMITTED at
 * `apps/demo/src/omnigraph-types.generated.ts` and byte-compared here
 * the demo package's `tsc --noEmit` then validates compilability
 * end-to-end.
 *
 * The context.pg output is additionally written to `test/__generated__/`
 * (gitignored) at test time, so the package's own `tsc --noEmit` — whose
 * `include` covers `test/` — typechecks a fresh artifact on any machine that
 * has run the tests.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { generateTypes, generateTypesFromPgSource } from '../src/codegen';
import { parsePgSchema, schemaFingerprint } from '../src/index';

import committedDemoTypes from '../../../apps/demo/src/omnigraph-types.generated.ts?raw';
import demoPg from '../../../fixtures/omnigraph/cluster/demo.pg?raw';

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

const CONTEXT_NODES = ['Actor', 'Decision', 'Trace', 'Signal', 'Artifact'] as const;
const CONTEXT_EDGES = [
  'OwnedBy',
  'ParticipatedIn',
  'RecordedBy',
  'AuthoredBy',
  'Supports',
  'Attached',
  'CitedIn',
  'Triggered',
  'Correlates',
  'Supersedes',
] as const;

/** The body of `export interface <Name> { … }` in `out`. */
function interfaceBody(out: string, name: string): string {
  const m = new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(out);
  expect(m, `interface ${name} not found`).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

describe('generateTypesFromPgSource — real context.pg', () => {
  const out = generateTypesFromPgSource(CONTEXT_PG, { header: 'Source: context.pg (test)' });

  it('stamps a DO-NOT-EDIT header with the source fingerprint', () => {
    expect(out).toContain('AUTO-GENERATED — DO NOT EDIT.');
    expect(out).toContain(`Schema fingerprint: ${schemaFingerprint(CONTEXT_PG)}.`);
    expect(out).toContain('// Source: context.pg (test)');
  });

  it('emits one props interface per node type with wire value mappings', () => {
    for (const n of CONTEXT_NODES) expect(out).toContain(`export interface ${n}Props {`);

    const actor = interfaceBody(out, 'ActorProps');
    expect(actor).toContain('id: string;'); // injected physical id
    expect(actor).toContain('slug: string;');
    expect(actor).toContain('email: string | null;'); // String?

    const decision = interfaceBody(out, 'DecisionProps');
    expect(decision).toContain(
      "status: 'proposed' | 'accepted' | 'rejected' | 'superseded';",
    );
    expect(decision).toContain("urgency: 'low' | 'normal' | 'high' | 'critical';");
    expect(decision).toContain('decided_at: string | null;'); // Date? → 'YYYY-MM-DD' | null

    const trace = interfaceBody(out, 'TraceProps');
    expect(trace).toContain('recorded_at: string;'); // Date → 'YYYY-MM-DD'
    expect(trace).toContain("normalized to 'YYYY-MM-DD'");
  });

  it('emits edge props interfaces — empty ones still carry the physical id', () => {
    for (const e of CONTEXT_EDGES) expect(out).toContain(`export interface ${e}EdgeProps {`);
    const correlates = interfaceBody(out, 'CorrelatesEdgeProps');
    expect(correlates).toContain('id: string;');
    // @unique(src, dst) is a constraint, not a property
    expect(correlates).not.toContain('src');
  });

  it("emits NodeAttrs/EdgeAttrs discriminated unions on the injected 'orbit:type' field", () => {
    for (const n of CONTEXT_NODES) {
      expect(out).toContain(`| ({ 'orbit:type': '${n}' } & ${n}Props)`);
    }
    for (const e of CONTEXT_EDGES) {
      expect(out).toContain(`| ({ 'orbit:type': '${e}' } & ${e}EdgeProps)`);
    }
    expect(out).toContain('export type NodeAttrs =');
    expect(out).toContain('export type EdgeAttrs =');
  });

  it('emits the TypeMap lookup and type-name unions', () => {
    expect(out).toContain('export interface TypeMap {');
    for (const n of CONTEXT_NODES) expect(out).toContain(`    ${n}: ${n}Props;`);
    for (const e of CONTEXT_EDGES) expect(out).toContain(`    ${e}: ${e}EdgeProps;`);
    expect(out).toContain("export type NodeTypeName = keyof TypeMap['nodes'];");
    expect(out).toContain("export type EdgeTypeName = keyof TypeMap['edges'];");
  });

  it('is deterministic and self-contained (no imports, trailing newline)', () => {
    expect(generateTypesFromPgSource(CONTEXT_PG, { header: 'Source: context.pg (test)' })).toBe(
      out,
    );
    expect(out).not.toMatch(/^import /m);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('writes the artifact into test/__generated__ for local tsc coverage', () => {
    const dir = fileURLToPath(new URL('./__generated__/', import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'context-types.ts'), out);
  });
});

describe('demo.pg fixture — committed golden file', () => {
  it('matches apps/demo/src/omnigraph-types.generated.ts byte-for-byte', () => {
    const regenerated = generateTypesFromPgSource(demoPg, {
      header: 'Source: fixtures/omnigraph/cluster/demo.pg',
    });
    expect(committedDemoTypes).toBe(regenerated);
  });

  it('covers every wire encoding in the fixture schema', () => {
    const out = generateTypesFromPgSource(demoPg);
    expect(out).toContain(`Schema fingerprint: ${schemaFingerprint(demoPg)}.`);

    const actor = interfaceBody(out, 'ActorProps');
    expect(actor).toContain('joined_at: string;'); // Date

    const decision = interfaceBody(out, 'DecisionProps');
    expect(decision).toContain('updated_at: string;'); // DateTime → ISO 8601
    expect(decision).toContain('decided_at: string | null;'); // Date?

    const trace = interfaceBody(out, 'TraceProps');
    expect(trace).toContain('word_count: number;'); // I64
    expect(trace).toContain('`I64` — JSON numbers round silently past ±2^53.');

    const signal = interfaceBody(out, 'SignalProps');
    expect(signal).toContain('strength: number;'); // F64

    const supports = interfaceBody(out, 'SupportsEdgeProps');
    expect(supports).toContain('weight: number | null;'); // F64? edge property

    const correlates = interfaceBody(out, 'CorrelatesEdgeProps');
    expect(correlates).toContain('confidence: number;'); // F64 edge property
  });
});

describe('generateTypes — mapping edge cases', () => {
  it('maps Vector(n), [T] lists, Bool, Blob, and unknown types', () => {
    const out = generateTypesFromPgSource(`
node Embedding {
    slug: String @key
    vec: Vector(3)
    maybe_vec: Vector(4)?
    tags: [String]
    flag: Bool
    payload: Blob
    weird: Wat
}
`);
    const body = interfaceBody(out, 'EmbeddingProps');
    expect(body).toContain('vec: number[];');
    expect(body).toContain('/** `Vector(3)`. */');
    expect(body).toContain('maybe_vec: number[] | null;');
    expect(body).toContain('tags: string[];');
    expect(body).toContain('flag: boolean;');
    expect(body).toContain('payload: string;'); // Exported Blob values normalize to strings.
    expect(body).toContain('weird: unknown;');
  });

  it("does not duplicate a schema-declared id and emits a schema-declared 'type' NORMALLY", () => {
    const out = generateTypesFromPgSource(`
node Odd {
    id: String @key
    type: String
}
`);
    const body = interfaceBody(out, 'OddProps');
    expect(body.match(/^ {2}id: string;$/gm)).toHaveLength(1);
    // The discriminator is namespaced, so a schema property named `type` is
    // an ordinary member — no omission, no shadow key, no special case.
    expect(body).toMatch(/^ {2}type: string;$/m);
    expect(body).not.toContain("'og:type'");
    // …and it never collides with the injected discriminator.
    expect(out).toContain("| ({ 'orbit:type': 'Odd' } & OddProps);");
  });

  it('collapses to never-unions and an empty TypeMap for an empty schema', () => {
    const out = generateTypes({ interfaces: [], nodes: [], edges: [] });
    expect(out).toContain('export type NodeAttrs = never;');
    expect(out).toContain('export type EdgeAttrs = never;');
    expect(out).toContain('(parsed model'); // fallback fingerprint labelled as such
  });

  it('threads an explicit fingerprint and comment-prefixes multi-line headers', () => {
    const schema = parsePgSchema('node A { slug: String @key }');
    const out = generateTypes(schema, {
      fingerprint: 'deadbeefdeadbeef',
      header: 'Source: somewhere\n// already a comment',
    });
    expect(out).toContain('Schema fingerprint: deadbeefdeadbeef.');
    expect(out).toContain('// Source: somewhere');
    expect(out).toContain('// already a comment');
  });
});
