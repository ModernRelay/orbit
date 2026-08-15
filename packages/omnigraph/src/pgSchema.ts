/**
 * `.pg` schema model + tolerant parser.
 *
 * The adapter needs three things from the graph schema, all served here:
 * 1. edge endpoint-type resolution (export edge lines carry bare `from`/`to`
 * ids without endpoint types),
 * 2. per-property wire-type knowledge for temporal/blob normalization,
 * 3. a stable schema fingerprint for the export revision stamp.
 *
 * The parser is deliberately tolerant: it extracts the declarations it
 * understands (interfaces, node blocks, edge declarations, properties,
 * constraints) and preserves anything else — unknown annotations survive as
 * raw strings, unknown type spellings become `{ kind: 'unknown' }` — so a
 * newer server grammar degrades gracefully instead of failing the load.
 *
 * Browser-safe: no `node:` imports. The fingerprint is a pure FNV-1a 64-bit
 * hash rather than `node:crypto` sha256 so this module can sit on the
 * browser entry's critical path.
 */

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** Closed scalar set per the `.pg` grammar (docs/user/schema). */
export type PgScalarName =
  | 'String'
  | 'Blob'
  | 'Bool'
  | 'I32'
  | 'I64'
  | 'U32'
  | 'U64'
  | 'F32'
  | 'F64'
  | 'Date'
  | 'DateTime';

export type PgType =
  | PgScalarName
  | { kind: 'vector'; dim: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'list'; element: PgScalarName }
  | { kind: 'unknown'; raw: string };

export interface PgProperty {
  name: string;
  type: PgType;
  /** `T?` nullability. */
  optional: boolean;
  /** Set by inline `@key` or a body-level `@key(...)` naming this property. */
  key: boolean;
  /** Set by inline `@unique` or a body-level `@unique(...)` naming this property. */
  unique: boolean;
  /** Set by inline `@index` or a body-level `@index(...)` naming this property. */
  index: boolean;
  /** Every annotation as written (`'@key'`, `'@embed("body")'`) — unknown ones preserved verbatim. */
  annotations: readonly string[];
}

export interface PgInterfaceType {
  name: string;
  properties: readonly PgProperty[];
  /** Body-level constraint declarations preserved verbatim (e.g. `'@unique(a, b)'`). */
  constraints: readonly string[];
}

export interface PgNodeType {
  name: string;
  /** Interface names from the `implements` clause (already expanded into `properties`). */
  implements: readonly string[];
  properties: readonly PgProperty[];
  constraints: readonly string[];
}

export interface PgEdgeType {
  name: string;
  /** Source (from) node type name. */
  from: string;
  /** Destination (to) node type name. */
  to: string;
  /** Raw `@card` bounds, e.g. `'1..1'`, `'0..*'`. Absent means the default `0..*`. */
  card?: string;
  /** Header annotations as written (including the `@card(...)` one, if any). */
  annotations: readonly string[];
  properties: readonly PgProperty[];
  constraints: readonly string[];
}

export interface PgSchema {
  interfaces: readonly PgInterfaceType[];
  nodes: readonly PgNodeType[];
  edges: readonly PgEdgeType[];
}

const SCALARS: ReadonlySet<string> = new Set<PgScalarName>([
  'String',
  'Blob',
  'Bool',
  'I32',
  'I64',
  'U32',
  'U64',
  'F32',
  'F64',
  'Date',
  'DateTime',
]);

// ---------------------------------------------------------------------------
// Lexical helpers (string-aware; `.pg` strings are double-quoted with `\` escapes)
// ---------------------------------------------------------------------------

/** Blank out line and block comments, preserving newlines and string literals. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src.charAt(i);
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = src.charAt(i);
        out += c;
        i++;
        if (c === '\\' && i < n) {
          out += src.charAt(i);
          i++;
        } else if (c === '"') break;
      }
    } else if (ch === '/' && src.charAt(i + 1) === '/') {
      while (i < n && src.charAt(i) !== '\n') i++;
    } else if (ch === '/' && src.charAt(i + 1) === '*') {
      i += 2;
      while (i < n && !(src.charAt(i) === '*' && src.charAt(i + 1) === '/')) {
        out += src.charAt(i) === '\n' ? '\n' : ' ';
        i++;
      }
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Index just past the `}` matching the `{` at `openIdx`, or `src.length` if unbalanced. */
function findBlockEnd(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  const n = src.length;
  while (i < n) {
    const ch = src.charAt(i);
    if (ch === '"') {
      i++;
      while (i < n) {
        const c = src.charAt(i);
        i++;
        if (c === '\\') i++;
        else if (c === '"') break;
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return n;
}

/** Split a block body into statements at newlines that sit outside parens/brackets/strings. */
function splitStatements(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  let i = 0;
  const n = body.length;
  while (i < n) {
    const ch = body.charAt(i);
    if (ch === '"') {
      current += ch;
      i++;
      while (i < n) {
        const c = body.charAt(i);
        current += c;
        i++;
        if (c === '\\' && i < n) {
          current += body.charAt(i);
          i++;
        } else if (c === '"') break;
      }
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === '\n' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
    i++;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

interface RawAnnotation {
  name: string;
  args?: string;
  raw: string;
}

/** Scan a run of `@ident` / `@ident(...)` annotations starting at `start`. */
function scanAnnotations(src: string, start: number): { anns: RawAnnotation[]; end: number } {
  const anns: RawAnnotation[] = [];
  let i = start;
  const n = src.length;
  for (;;) {
    let j = i;
    while (j < n && /\s/.test(src.charAt(j))) j++;
    if (src.charAt(j) !== '@') break;
    const m = /^@([A-Za-z_]\w*)/.exec(src.slice(j));
    if (!m || m[1] === undefined) break;
    const name = m[1];
    let end = j + m[0].length;
    let args: string | undefined;
    if (src.charAt(end) === '(') {
      let depth = 0;
      let k = end;
      while (k < n) {
        const ch = src.charAt(k);
        if (ch === '"') {
          k++;
          while (k < n) {
            const c = src.charAt(k);
            k++;
            if (c === '\\') k++;
            else if (c === '"') break;
          }
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            k++;
            break;
          }
        }
        k++;
      }
      args = src.slice(end + 1, k - 1);
      end = k;
    }
    const entry: RawAnnotation = { name, raw: src.slice(j, end) };
    if (args !== undefined) entry.args = args;
    anns.push(entry);
    i = end;
  }
  return { anns, end: i };
}

/** Split on top-level commas (outside parens/strings), trim, drop empties. */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < args.length; i++) {
    const ch = args.charAt(i);
    if (ch === '"') {
      current += ch;
      i++;
      while (i < args.length) {
        const c = args.charAt(i);
        current += c;
        if (c === '\\') {
          i++;
          current += args.charAt(i);
        } else if (c === '"') break;
        i++;
      }
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Statement parsing
// ---------------------------------------------------------------------------

interface MutableTypeBody {
  properties: PgProperty[];
  constraints: string[];
}

function parseTypeRef(text: string): { type: PgType; optional: boolean; end: number } {
  let i = 0;
  const n = text.length;
  while (i < n && /\s/.test(text.charAt(i))) i++;
  let type: PgType;
  if (text.charAt(i) === '[') {
    const m = /^\[\s*([A-Za-z_]\w*)\s*\]/.exec(text.slice(i));
    if (m && m[1] !== undefined && SCALARS.has(m[1])) {
      type = { kind: 'list', element: m[1] as PgScalarName };
      i += m[0].length;
    } else {
      const close = text.indexOf(']', i);
      const end = close === -1 ? n : close + 1;
      type = { kind: 'unknown', raw: text.slice(i, end).trim() };
      i = end;
    }
  } else {
    const m = /^([A-Za-z_]\w*)/.exec(text.slice(i));
    if (!m || m[1] === undefined) {
      return { type: { kind: 'unknown', raw: text.trim() }, optional: false, end: n };
    }
    const ident = m[1];
    i += m[0].length;
    if ((ident === 'enum' || ident === 'Vector') && text.charAt(i) === '(') {
      let depth = 0;
      let k = i;
      while (k < n) {
        const ch = text.charAt(k);
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) {
            k++;
            break;
          }
        }
        k++;
      }
      const inner = text.slice(i + 1, k - 1);
      i = k;
      if (ident === 'enum') {
        const values = splitArgs(inner).map((v) => v.replace(/^"(.*)"$/s, '$1'));
        type = { kind: 'enum', values };
      } else {
        const dim = Number.parseInt(inner.trim(), 10);
        type = Number.isFinite(dim)
          ? { kind: 'vector', dim }
          : { kind: 'unknown', raw: `Vector(${inner})` };
      }
    } else if (SCALARS.has(ident)) {
      type = ident as PgScalarName;
    } else {
      type = { kind: 'unknown', raw: ident };
    }
  }
  let optional = false;
  if (text.charAt(i) === '?') {
    optional = true;
    i++;
  }
  return { type, optional, end: i };
}

function parseBody(body: string): MutableTypeBody {
  const properties: PgProperty[] = [];
  const constraints: string[] = [];
  for (const stmt of splitStatements(body)) {
    if (stmt.startsWith('@')) {
      const { anns } = scanAnnotations(stmt, 0);
      for (const a of anns) constraints.push(a.raw);
      continue;
    }
    // A statement may carry SEVERAL whitespace-separated properties
    // (`id: String when: DateTime`); a single parse would keep only the first
    // and silently drop the rest. Loop until the trailer
    // stops looking like another property head; junk trailers stay
    // tolerant-skipped as before.
    let cursor = stmt;
    for (;;) {
      const head = /^([A-Za-z_]\w*)\s*:\s*/.exec(cursor);
      if (!head || head[1] === undefined) break; // tolerant: skip unrecognized statements
      const name = head[1];
      const rest = cursor.slice(head[0].length);
      const { type, optional, end } = parseTypeRef(rest);
      const { anns, end: annsEnd } = scanAnnotations(rest, end);
      properties.push({
        name,
        type,
        optional,
        key: anns.some((a) => a.name === 'key'),
        unique: anns.some((a) => a.name === 'unique'),
        index: anns.some((a) => a.name === 'index'),
        annotations: anns.map((a) => a.raw),
      });
      cursor = rest.slice(annsEnd).trimStart();
      if (cursor === '') break;
    }
  }
  // Body-level @key(a, b) / @unique(a) / @index(a) constraints flag the named properties.
  for (const raw of constraints) {
    const m = /^@(key|unique|index)\((.*)\)$/s.exec(raw);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const flag = m[1] as 'key' | 'unique' | 'index';
    for (const propName of splitArgs(m[2])) {
      const prop = properties.find((p) => p.name === propName);
      if (prop) prop[flag] = true;
    }
  }
  return { properties, constraints };
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

/**
 * Parse `.pg` source into a {@link PgSchema}. Tolerant by design: malformed
 * or unrecognized declarations are skipped, not fatal; `implements` clauses
 * are expanded into node properties (node-declared properties win on name
 * collisions, matching the server's table layout).
 */
export function parsePgSchema(source: string): PgSchema {
  const src = stripComments(source);
  const interfaces: PgInterfaceType[] = [];
  const nodes: (PgNodeType & { properties: PgProperty[] })[] = [];
  const edges: PgEdgeType[] = [];

  const headRe = /\b(interface|node|edge)\s+([A-Za-z_]\w*)/g;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(src)) !== null) {
    const kw = m[1];
    const name = m[2];
    if (kw === undefined || name === undefined) continue;
    let pos = headRe.lastIndex;

    if (kw === 'edge') {
      const em = /^\s*:\s*([A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*)/.exec(src.slice(pos));
      if (!em || em[1] === undefined || em[2] === undefined) continue; // tolerant skip
      pos += em[0].length;
      const { anns, end } = scanAnnotations(src, pos);
      pos = end;
      let body: MutableTypeBody = { properties: [], constraints: [] };
      let braceIdx = pos;
      while (braceIdx < src.length && /\s/.test(src.charAt(braceIdx))) braceIdx++;
      if (src.charAt(braceIdx) === '{') {
        const blockEnd = findBlockEnd(src, braceIdx);
        body = parseBody(src.slice(braceIdx + 1, blockEnd - 1));
        pos = blockEnd;
      }
      const card = anns.find((a) => a.name === 'card')?.args?.trim();
      const edge: PgEdgeType = {
        name,
        from: em[1],
        to: em[2],
        annotations: anns.map((a) => a.raw),
        properties: body.properties,
        constraints: body.constraints,
        ...(card !== undefined ? { card } : {}),
      };
      edges.push(edge);
      headRe.lastIndex = pos;
      continue;
    }

    // interface / node: optional `implements A, B` (node only), then a block.
    let impls: string[] = [];
    // The grammar carries head annotations (`@card`/`@unique` prove the
    // family). `node Account @rename_from("User") { … }` previously hit the
    // tolerant skip and silently dropped the whole declaration.
    // Annotations are consumed (and ignored — migration metadata) on either
    // side of `implements`, through the SAME scanner the body lane uses. It
    // honors nested parens and escaped quotes; a first-`)` regex would
    // truncate `@rename_from("User (legacy)")` and drop the node.
    const skipAnnotations = (): void => {
      pos = scanAnnotations(src, pos).end;
    };
    skipAnnotations();
    if (kw === 'node') {
      const im = /^\s*implements\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/.exec(src.slice(pos));
      if (im && im[1] !== undefined) {
        impls = im[1].split(',').map((s) => s.trim());
        pos += im[0].length;
      }
      skipAnnotations();
    }
    let braceIdx = pos;
    while (braceIdx < src.length && /\s/.test(src.charAt(braceIdx))) braceIdx++;
    if (src.charAt(braceIdx) !== '{') continue; // tolerant skip
    const blockEnd = findBlockEnd(src, braceIdx);
    const body = parseBody(src.slice(braceIdx + 1, blockEnd - 1));
    headRe.lastIndex = blockEnd;
    if (kw === 'interface') {
      interfaces.push({ name, properties: body.properties, constraints: body.constraints });
    } else {
      nodes.push({
        name,
        implements: impls,
        properties: body.properties,
        constraints: body.constraints,
      });
    }
  }

  // Expand implements clauses: interface properties precede the node's own,
  // except where the node re-declares a name (node declaration wins).
  for (const node of nodes) {
    if (node.implements.length === 0) continue;
    const own = new Set(node.properties.map((p) => p.name));
    const inherited: PgProperty[] = [];
    for (const ifaceName of node.implements) {
      const iface = interfaces.find((i) => i.name === ifaceName);
      if (!iface) continue; // tolerant: unknown interface
      for (const p of iface.properties) {
        if (!own.has(p.name) && !inherited.some((q) => q.name === p.name)) inherited.push(p);
      }
    }
    node.properties = [...inherited, ...node.properties];
  }

  return { interfaces, nodes, edges };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an edge type's declared endpoint node types. Export edge
 * lines carry bare `from`/`to` ids, so endpoint types come from here. Edge
 * names match exactly first, then case-insensitively (the server matches edge
 * names case-insensitively). Returns `null` for an unknown edge name.
 */
export function edgeEndpointTypes(
  schema: PgSchema,
  edgeName: string,
): { from: string; to: string } | null {
  const lower = edgeName.toLowerCase();
  const edge =
    schema.edges.find((e) => e.name === edgeName) ??
    schema.edges.find((e) => e.name.toLowerCase() === lower);
  return edge ? { from: edge.from, to: edge.to } : null;
}

/**
 * Stable fingerprint of `.pg` source for the adapter revision stamp: FNV-1a
 * 64-bit over the UTF-8 bytes of the source, as 16 lowercase hex chars.
 *
 * Pure and browser-safe (no `node:crypto`). Hashes the source **verbatim**:
 * any textual change — including comments or whitespace — changes the
 * fingerprint, which is the conservative choice for drift detection.
 */
export function schemaFingerprint(source: string): string {
  const MASK64 = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(source);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

export interface BigIntKeyWarning {
  /** Node or edge type name. */
  type: string;
  /** The hazardous property. */
  property: string;
}

/**
 * Find `I64`/`U64` properties used as identity (`@key` or named `id`). The
 * HTTP path emits native JSON numbers even past ±2^53, where `JSON.parse`
 * silently rounds them, so two distinct big-int ids can collapse. Surface
 * these hazards before loading.
 */
export function bigIntKeyWarnings(schema: PgSchema): BigIntKeyWarning[] {
  const out: BigIntKeyWarning[] = [];
  for (const t of [...schema.nodes, ...schema.edges]) {
    for (const p of t.properties) {
      if ((p.type === 'I64' || p.type === 'U64') && (p.key || p.name === 'id')) {
        out.push({ type: t.name, property: p.name });
      }
    }
  }
  return out;
}
