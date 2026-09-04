/**
 * `.pg` → TypeScript code generation.
 *
 * The `.pg` scalar set is closed, so typed attrs for the `N`/`E` generics
 * generate mechanically: one interface per node/edge type, a `NodeAttrs` /
 * `EdgeAttrs` discriminated union on the adapter-injected `'orbit:type'`
 * field (namespaced so a schema's own `type` property emits as an ordinary
 * member), and a `TypeMap` lookup interface.
 *
 * Generated shapes describe attrs **after** the adapter's wire normalization
 * (the v1 loader rewrites export-path wire values to the query-path string
 * forms before populating attrs — see `normalize.ts`), so one encoding holds
 * regardless of read path:
 *
 * `Date` → `string` (`'YYYY-MM-DD'`)
 * `DateTime` → `string` (ISO 8601, `'YYYY-MM-DDTHH:MM:SS.mmmZ'`)
 * `enum(...)` → string-literal union
 * `I64`/`U64` → `number` (beware silent rounding past ±2^53)
 * `F32`/`F64` → `number`
 * `Vector(n)` → `number[]`
 * `Blob` → `string` (`data:` URI for inline blobs, stored URI refs verbatim)
 * `T?` → `T | null`
 *
 * Output is a self-contained module (no imports), safe under the strictest
 * tsconfig (`strict`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`,
 * `isolatedModules`). The file carries a DO-NOT-EDIT header with the
 * schema fingerprint. Generation is deterministic — no timestamps — so the
 * output is committable and diff-stable.
 *
 * Browser-safe: no `node:` imports (the CLI wrapper in `codegen-cli.ts` owns
 * file I/O).
 */

import { ORBIT_TYPE_KEY } from './normalize';
import {
  parsePgSchema,
  schemaFingerprint,
  type PgProperty,
  type PgScalarName,
  type PgSchema,
  type PgType,
} from './pgSchema';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GenerateTypesOptions {
  /**
   * Extra provenance lines for the DO-NOT-EDIT banner (e.g. the schema file
   * path or server URL). May be multi-line; lines are comment-prefixed as
   * needed.
   */
  header?: string;
  /**
   * The schema fingerprint of the `.pg` **source** (from
   * {@link schemaFingerprint}). When omitted, a fingerprint of the canonical
   * parsed model is used instead and labelled as such — prefer
   * {@link generateTypesFromPgSource}, which always stamps the source
   * fingerprint.
   */
  fingerprint?: string;
}

// ---------------------------------------------------------------------------
// Wire value → TypeScript mapping (post-normalization)
// ---------------------------------------------------------------------------

const SCALAR_TS: Record<PgScalarName, string> = {
  String: 'string',
  Blob: 'string',
  Bool: 'boolean',
  I32: 'number',
  I64: 'number',
  U32: 'number',
  U64: 'number',
  F32: 'number',
  F64: 'number',
  Date: 'string',
  DateTime: 'string',
};

/** Single-quoted TS string literal with escapes. */
function tsStringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

function tsType(type: PgType): string {
  if (typeof type === 'string') return SCALAR_TS[type];
  switch (type.kind) {
    case 'vector':
      return 'number[]';
    case 'enum':
      return type.values.length === 0 ? 'string' : type.values.map(tsStringLiteral).join(' | ');
    case 'list':
      return `${SCALAR_TS[type.element]}[]`;
    case 'unknown':
      return 'unknown';
  }
}

/** One-line doc note for types whose TS shape hides a wire subtlety. */
function wireNote(type: PgType): string | null {
  if (typeof type === 'string') {
    switch (type) {
      case 'Date':
        return "`Date` — normalized to 'YYYY-MM-DD' (UTC) on load.";
      case 'DateTime':
        return '`DateTime` — normalized to ISO 8601 UTC on load.';
      case 'Blob':
        return "`Blob` — `data:` URI for inline blobs, stored URI refs verbatim.";
      case 'I64':
      case 'U64':
        return `\`${type}\` — JSON numbers round silently past ±2^53.`;
      default:
        return null;
    }
  }
  switch (type.kind) {
    case 'vector':
      return `\`Vector(${type.dim})\`.`;
    case 'unknown':
      return `Unrecognized \`.pg\` type \`${type.raw}\` — value passes through verbatim.`;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(name: string): string {
  return IDENT_RE.test(name) ? name : tsStringLiteral(name);
}

function emitProperty(lines: string[], prop: PgProperty): void {
  const note = wireNote(prop.type);
  if (note !== null) lines.push(`  /** ${note} */`);
  const base = tsType(prop.type);
  lines.push(`  ${propertyKey(prop.name)}: ${prop.optional ? `${base} | null` : base};`);
}

function emitPropsInterface(
  lines: string[],
  interfaceName: string,
  kindLabel: 'node' | 'edge',
  typeName: string,
  properties: readonly PgProperty[],
): void {
  lines.push(`/** Normalized attrs for ${kindLabel} type \`${typeName}\`. */`);
  lines.push(`export interface ${interfaceName} {`);
  if (!properties.some((p) => p.name === 'id')) {
    lines.push(
      `  /** Physical Omnigraph id — injected into every export line's \`data\`; unique per ${kindLabel} type only. */`,
    );
    lines.push('  id: string;');
  }
  for (const prop of properties) {
    if (prop.name === 'id') {
      // Export normalization requires `data.id` to be a string regardless of
      // a schema declaration. Emitting the declared wire scalar here (for
      // example I64 -> number) would make generated attrs unsound.
      lines.push(
        `  /** Physical Omnigraph id — normalized as a required string regardless of its schema wire type. */`,
      );
      lines.push('  id: string;');
      continue;
    }
    // Every schema property emits normally — including one named `type`: the
    // adapter's discriminator lives at the namespaced ORBIT_TYPE_KEY, so
    // there is nothing to shadow.
    emitProperty(lines, prop);
  }
  lines.push('}');
  lines.push('');
}

function emitAttrsUnion(
  lines: string[],
  unionName: string,
  doc: string,
  members: ReadonlyArray<{ typeName: string; interfaceName: string }>,
): void {
  lines.push(`/** ${doc} */`);
  if (members.length === 0) {
    lines.push(`export type ${unionName} = never;`);
  } else {
    lines.push(`export type ${unionName} =`);
    members.forEach(({ typeName, interfaceName }, i) => {
      const tail = i === members.length - 1 ? ';' : '';
      lines.push(
        `  | ({ ${tsStringLiteral(ORBIT_TYPE_KEY)}: ${tsStringLiteral(typeName)} } & ${interfaceName})${tail}`,
      );
    });
  }
  lines.push('');
}

function headerBanner(fingerprintLine: string, extra: string | undefined): string[] {
  const lines = [
    '// AUTO-GENERATED — DO NOT EDIT.',
    '//',
    '// .pg → TypeScript typed attrs (wire-normalized), generated by',
    '// @modernrelay/orbit-omnigraph (`orbit-omnigraph-codegen`).',
    `// ${fingerprintLine}`,
  ];
  if (extra !== undefined && extra.length > 0) {
    for (const raw of extra.split('\n')) {
      lines.push(raw.startsWith('//') ? raw : `// ${raw}`.trimEnd());
    }
  }
  lines.push(
    '//',
    "// Shapes describe attrs AFTER the adapter's wire normalization (both read",
    '// paths converge on the query-path string encodings):',
    "//   Date → 'YYYY-MM-DD' · DateTime → ISO 8601 · enum(...) → literal union",
    '//   I64/U64/F32/F64 → number · Vector(n) → number[] · T? → T | null',
    "//   Blob → string ('data:' URI for inline blobs, stored URI for external)",
    '',
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained TypeScript module of typed attrs from a parsed
 * `.pg` schema: one `<Name>Props` interface per node type, one
 * `<Name>EdgeProps` per edge type (with an additional numeric suffix when
 * either preferred name is already used), `NodeAttrs`/`EdgeAttrs` discriminated unions on the
 * adapter-injected `'orbit:type'` field, and a `TypeMap` lookup interface with
 * `NodeTypeName`/`EdgeTypeName` key unions.
 *
 * Deterministic: identical input (schema + options) yields identical output.
 */
export function generateTypes(schema: PgSchema, opts?: GenerateTypesOptions): string {
  const fingerprintLine =
    opts?.fingerprint !== undefined
      ? `Schema fingerprint: ${opts.fingerprint}.`
      : `Schema fingerprint: ${schemaFingerprint(JSON.stringify(schema))} (parsed model — regenerate from .pg source for the source fingerprint).`;
  const lines = headerBanner(fingerprintLine, opts?.header);

  // Reserve every preferred name before allocating collision suffixes, so
  // disambiguating one member cannot steal a later member's public name.
  const reserved = new Set([
    'NodeAttrs', 'EdgeAttrs', 'TypeMap', 'NodeTypeName', 'EdgeTypeName',
    ...schema.nodes.map((n) => `${n.name}Props`),
    ...schema.edges.map((e) => `${e.name}EdgeProps`),
  ]);
  const used = new Set<string>();
  function allocateName(preferred: string): string {
    let name = preferred;
    let suffix = 2;
    while (used.has(name)) {
      do {
        name = `${preferred}_${suffix++}`;
      } while (reserved.has(name));
    }
    used.add(name);
    return name;
  }
  const nodeMembers = schema.nodes.map((n) => ({
    typeName: n.name,
    interfaceName: allocateName(`${n.name}Props`),
  }));
  const edgeMembers = schema.edges.map((e) => ({
    typeName: e.name,
    interfaceName: allocateName(`${e.name}EdgeProps`),
  }));

  schema.nodes.forEach((n, i) => {
    const member = nodeMembers[i];
    if (member) emitPropsInterface(lines, member.interfaceName, 'node', n.name, n.properties);
  });
  schema.edges.forEach((e, i) => {
    const member = edgeMembers[i];
    if (member) emitPropsInterface(lines, member.interfaceName, 'edge', e.name, e.properties);
  });

  emitAttrsUnion(
    lines,
    'NodeAttrs',
    "Discriminated union over every node type's normalized attrs — `'orbit:type'` is injected by the adapter.",
    nodeMembers,
  );
  emitAttrsUnion(
    lines,
    'EdgeAttrs',
    "Discriminated union over every edge type's normalized attrs — `'orbit:type'` is the edge name.",
    edgeMembers,
  );

  lines.push('/** Type-name → props lookup for both kinds (closed sets from the schema — the wire contract). */');
  lines.push('export interface TypeMap {');
  lines.push('  nodes: {');
  for (const m of nodeMembers) lines.push(`    ${propertyKey(m.typeName)}: ${m.interfaceName};`);
  lines.push('  };');
  lines.push('  edges: {');
  for (const m of edgeMembers) lines.push(`    ${propertyKey(m.typeName)}: ${m.interfaceName};`);
  lines.push('  };');
  lines.push('}');
  lines.push('');
  lines.push("export type NodeTypeName = keyof TypeMap['nodes'];");
  lines.push("export type EdgeTypeName = keyof TypeMap['edges'];");
  lines.push('');
  return lines.join('\n');
}

/**
 * Parse `.pg` source and generate typed attrs (see {@link generateTypes}),
 * stamping the header with the source fingerprint
 * ({@link schemaFingerprint} over the verbatim source).
 */
export function generateTypesFromPgSource(
  source: string,
  opts?: Omit<GenerateTypesOptions, 'fingerprint'>,
): string {
  const schema = parsePgSchema(source);
  const options: GenerateTypesOptions = { fingerprint: schemaFingerprint(source) };
  if (opts?.header !== undefined) options.header = opts.header;
  return generateTypes(schema, options);
}
