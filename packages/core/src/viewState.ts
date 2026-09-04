/**
 * View state — pure module: the serialized
 * schema, the canonical-JSON encoder, the structural validator, and the
 * version gate. No engine, no DOM, no store access; the instance wires
 * `getViewState`/`setViewState` on top.
 *
 * ## Compatibility contract
 *
 * Deep-links outlive library versions, so everything in this file is a
 * COMMITMENT, not an internal:
 * - The v1 wire shape below never changes incompatibly; breaking shape
 * changes bump `v` and ship an in-code migration from every prior version
 * in the same release (the registry seam is here from day one).
 * - Additive fields never bump `v` — an equal-`v` payload with unknown
 * fields applies cleanly with the unknowns ignored.
 * - A payload with `v` HIGHER than this library knows, or failing structural
 * validation (hand-edited URL, truncated paste), is rejected whole: a
 * half-restored view misrepresents what the sender saw.
 *
 * ## v1 shape notes
 *
 * - `folds` extends the v1 schema:
 * node folds are exploration state over stable public ids — a
 * deep-link that silently dropped them would misrepresent the sender's
 * view, the exact failure this feature exists to prevent. Session-local
 * expansion records, by contrast, are NEVER serialized.
 * - Brushes are TAGGED on the wire (`kind`) even though the runtime
 * BrushState is untagged: the tag comes from `DimensionSpec.kind` at
 * serialize time and lets restore validate shape-vs-dimension without
 * consulting the live spec first. Categorical stores EXCLUSIONS, so
 * categories that appear after the view was saved stay visible.
 * - `layout` is the normalized OBJECT form (`{ kind }`) even though the
 * runtime today carries only the bare kind string — the object is what
 * makes a future static seed or a layouts package additive.
 */

import type {
  GroupSpec,
  JsonValue,
  NodeId,
  SelectionState,
  SubgraphSpec,
  ViewportState,
} from './types';

export type { JsonValue } from './types';

// ---------------------------------------------------------------------------
// Wire types (v1).
// ---------------------------------------------------------------------------

/** Tagged wire form of a crossfilter brush for view-state serialization. */
export type ViewBrushState =
  | { kind: 'numeric' | 'temporal'; range: readonly [number, number] }
  | { kind: 'categorical'; excluded: readonly string[] };

/** Normalized layout descriptor — object form reserves room for a static
 * seed / structured layouts without a `v` bump. */
export interface ViewLayoutSpec {
  kind: 'force' | 'fixed';
}

type SerializableScaleFor<T extends string | number> =
  | {
      kind: 'sequential';
      metric: string;
      range: readonly [T, T];
      domain?: readonly [number, number];
    }
  | {
      kind: 'diverging';
      metric: string;
      range: readonly [T, T, T];
      mid: number;
    }
  | {
      kind: 'categorical';
      /** Field-descriptor form only — a function `by` is omitted upstream. */
      by: string;
      palette?: readonly T[];
      domain?: readonly string[];
    };

/** Scale subset that is data by construction (no functions). `T` is bound
 * by the styling channel: CSS strings for nodeColor, finite numbers for
 * nodeSize. Tuple arity mirrors the runtime Scale<T> contract exactly. The
 * conditional preserves homogeneous value collections when `T` is a union. */
export type SerializableScale<T extends string | number = string | number> =
  T extends unknown ? SerializableScaleFor<T> : never;

export interface ViewStyling {
  nodeColor?: SerializableScale<string>;
  nodeSize?: SerializableScale<number>;
  showLinks?: boolean;
  edgeArrows?: boolean;
  /** Named themes only; a custom GraphTheme object is omitted upstream. */
  theme?: 'light' | 'dark';
}

export interface GraphViewState {
  v: 1;
  camera: ViewportState | null;
  selection: SelectionState;
  hiddenNodeIds: readonly NodeId[];
  /** isolation; null = full scope. */
  subgraph: SubgraphSpec | null;
  /** Manual groups verbatim, or — under `groupBy` — `{key, collapsed}` pairs
   * only (membership recomputes from current data on restore). */
  groups: readonly GroupSpec[] | ReadonlyArray<{ key: string; collapsed: boolean }>;
  pinnedNodeIds: readonly NodeId[];
  /** node folds: anchor → declared members (v1 extension, see header). */
  folds?: ReadonlyArray<readonly [NodeId, readonly NodeId[]]>;
  layout: ViewLayoutSpec;
  /** Declaration order; a key absent here has no brush. */
  crossfilter: ReadonlyArray<{ key: string; state: ViewBrushState }>;
  /** Opt-in frozen layout (quantized, visible set); tuple form keeps opaque
   * ids safe. Restores as a fixed-equivalent regardless of engine
   * nondeterminism. */
  positions?: ReadonlyArray<readonly [string, number, number]>;
  styling?: ViewStyling;
  /** Host-owned durable source coordinate — stored verbatim, NEVER
   * interpreted; compared canonically on restore. */
  dataRef?: JsonValue;
}

export const VIEW_STATE_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Canonical JSON — recursive sorted keys, JSON value semantics. Used for
// dataRef comparison; exported for hosts building their own equality.
// ---------------------------------------------------------------------------

/**
 * Canonical encoding of a JSON value: object keys recursively sorted, arrays
 * order-preserving, JSON semantics for scalars (so `undefined` members are
 * dropped exactly as JSON.stringify drops them). Two values compare equal iff
 * their canonical strings are identical.
 */
export function canonicalJson(value: JsonValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  return encode(value, new Set());
}

/**
 * Defensive against the PUBLIC-API shape of the input: `setViewState` takes
 * `unknown`, so a host can hand this a cyclic object, a BigInt, a function
 * things a real deep-link (which arrives through JSON.parse) never carries.
 * Cycles throw a plain RangeError the caller turns into a rejection; every
 * other non-JSON leaf encodes exactly as JSON.stringify treats it (functions/
 * undefined drop as members, become null in arrays; non-finite numbers are
 * null), so canonical comparison always matches wire reality.
 */
function encode(value: JsonValue, seen: Set<object>): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return 'null'; // function/bigint/symbol leaf in an array
  if (seen.has(value)) {
    throw new RangeError('canonicalJson: cyclic value — not a JSON value');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((v) => (v === undefined ? 'null' : encode(v, seen))).join(',')}]`;
    }
    const keys = Object.keys(value).sort();
    const members: string[] = [];
    for (const key of keys) {
      const v = value[key];
      if (v === undefined || typeof v === 'function') continue; // JSON.stringify drops these
      members.push(`${JSON.stringify(key)}:${encode(v, seen)}`);
    }
    return `{${members.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/** Canonical equality for dataRef values: key order never matters.
 * A non-JSON value (cycles included) is never equal to anything — the
 * "compared, never interpreted" rule extended to malformed input. */
export function sameDataRef(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Structural validation. Never throws; returns every problem found. This is
// the deep-link attack surface: payloads arrive from URLs and hand-edited
// JSON, so every field is checked before ANY of it is applied (atomic
// rule). Unknown fields at the current version are legal and ignored.
// ---------------------------------------------------------------------------

export type ViewStateVerdict =
  | { ok: true; state: GraphViewState }
  | { ok: false; code: 'invalid-view-state' | 'unsupported-version'; problems: readonly string[] };

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isNumArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(isNum);

function validateBrush(v: unknown, at: string, problems: string[]): void {
  if (!isObj(v)) {
    problems.push(`${at}: not an object`);
    return;
  }
  if (v['kind'] === 'numeric' || v['kind'] === 'temporal') {
    const r = v['range'];
    if (!Array.isArray(r) || r.length !== 2 || !isNum(r[0]) || !isNum(r[1])) {
      problems.push(`${at}: range must be [min, max] finite numbers`);
    }
    return;
  }
  if (v['kind'] === 'categorical') {
    if (!isStrArray(v['excluded'])) problems.push(`${at}: excluded must be string[]`);
    return;
  }
  problems.push(`${at}: unknown brush kind`);
}

function validateScale(
  v: unknown,
  at: string,
  valueKind: 'string' | 'number',
  problems: string[],
): void {
  if (!isObj(v)) {
    problems.push(`${at}: not an object`);
    return;
  }
  const isValueArray = valueKind === 'string' ? isStrArray : isNumArray;
  const valueLabel = valueKind === 'string' ? 'string' : 'finite number';
  if (v['kind'] === 'sequential') {
    if (!isStr(v['metric'])) problems.push(`${at}: metric must be a string`);
    if (!isValueArray(v['range']) || v['range'].length !== 2) {
      problems.push(`${at}: sequential range must be a [${valueLabel}, ${valueLabel}] tuple`);
    }
    if (
      v['domain'] !== undefined &&
      (!isNumArray(v['domain']) || v['domain'].length !== 2)
    ) {
      problems.push(`${at}: sequential domain must be a [min, max] finite-number tuple`);
    }
    return;
  }
  if (v['kind'] === 'diverging') {
    if (!isStr(v['metric'])) problems.push(`${at}: metric must be a string`);
    if (!isValueArray(v['range']) || v['range'].length !== 3) {
      problems.push(
        `${at}: diverging range must be a [${valueLabel}, ${valueLabel}, ${valueLabel}] tuple`,
      );
    }
    if (!isNum(v['mid'])) {
      problems.push(`${at}: diverging mid must be a finite number`);
    }
    return;
  }
  if (v['kind'] === 'categorical') {
    if (!isStr(v['by'])) problems.push(`${at}: categorical 'by' must be a field string`);
    if (v['domain'] !== undefined && !isStrArray(v['domain'])) {
      problems.push(`${at}: categorical domain must be a string[]`);
    }
    if (v['palette'] !== undefined && !isValueArray(v['palette'])) {
      problems.push(`${at}: categorical palette must be a ${valueLabel}[]`);
    }
    return;
  }
  problems.push(`${at}: unknown scale kind`);
}

/**
 * Full structural validation + version gate. Order per version first
 * (higher-than-known and non-numeric reject as `unsupported-version` /
 * `invalid-view-state` BEFORE field checks), then per-field structure. Lower
 * versions run the migration registry, then re-validate at the current shape.
 */
export function validateViewState(raw: unknown): ViewStateVerdict {
  if (!isObj(raw)) {
    return { ok: false, code: 'invalid-view-state', problems: ['payload is not an object'] };
  }
  const v = raw['v'];
  if (!isNum(v) || !Number.isInteger(v) || v < 1) {
    return { ok: false, code: 'invalid-view-state', problems: ['v must be a positive integer'] };
  }
  if (v > VIEW_STATE_VERSION) {
    return {
      ok: false,
      code: 'unsupported-version',
      problems: [`v ${v} is newer than this library understands (${VIEW_STATE_VERSION})`],
    };
  }
  let candidate: Record<string, unknown> = raw;
  if (v < VIEW_STATE_VERSION) {
    const migrated = migrate(candidate, v);
    if (!isObj(migrated)) {
      return { ok: false, code: 'invalid-view-state', problems: [`migration from v${v} failed`] };
    }
    candidate = migrated;
  }

  const problems: string[] = [];

  // camera and subgraph are REQUIRED members whose value may be null
  // omission is a truncated payload, not an empty value. Accepting omission
  // here would push `undefined` into apply paths the gate promised were
  // fully validated (the exact half-validated failure forbids).
  const camera = candidate['camera'];
  if (camera === undefined) {
    problems.push('camera: required (null for "no viewport", never omitted)');
  } else if (camera !== null) {
    if (!isObj(camera) || !isNum(camera['x']) || !isNum(camera['y']) || !isNum(camera['zoom'])) {
      problems.push('camera: must be null or {x, y, zoom} finite numbers');
    }
  }

  const selection = candidate['selection'];
  if (
    !isObj(selection) ||
    !isStrArray(selection['nodeIds']) ||
    !isStrArray(selection['edgeIds']) ||
    !isStrArray(selection['groupIds'])
  ) {
    problems.push('selection: must be {nodeIds, edgeIds, groupIds} string arrays');
  }

  if (!isStrArray(candidate['hiddenNodeIds'])) problems.push('hiddenNodeIds: must be string[]');
  if (!isStrArray(candidate['pinnedNodeIds'])) problems.push('pinnedNodeIds: must be string[]');

  const subgraph = candidate['subgraph'];
  if (subgraph === undefined) {
    problems.push('subgraph: required (null for "full scope", never omitted)');
  } else if (subgraph !== null) {
    if (!isObj(subgraph) || !isStrArray(subgraph['seedIds'])) {
      problems.push('subgraph: must be null or {seedIds: string[], hops?, reflow?}');
    } else {
      if (subgraph['hops'] !== undefined && !isNum(subgraph['hops'])) {
        problems.push('subgraph.hops: must be a finite number');
      }
      if (subgraph['reflow'] !== undefined && !isBool(subgraph['reflow'])) {
        problems.push('subgraph.reflow: must be a boolean');
      }
    }
  }

  const groups = candidate['groups'];
  if (!Array.isArray(groups)) {
    problems.push('groups: must be an array');
  } else {
    for (let i = 0; i < groups.length; i++) {
      const g: unknown = groups[i];
      if (!isObj(g)) {
        problems.push(`groups[${i}]: not an object`);
        continue;
      }
      const manual = isStr(g['id']) && isStrArray(g['memberIds']);
      const derived = isStr(g['key']) && isBool(g['collapsed']);
      if (!manual && !derived) {
        problems.push(`groups[${i}]: neither a GroupSpec nor a {key, collapsed} pair`);
      }
    }
  }

  const folds = candidate['folds'];
  if (folds !== undefined) {
    if (!Array.isArray(folds)) {
      problems.push('folds: must be an array of [anchorId, memberIds] tuples');
    } else {
      for (let i = 0; i < folds.length; i++) {
        const f: unknown = folds[i];
        if (!Array.isArray(f) || f.length !== 2 || !isStr(f[0]) || !isStrArray(f[1])) {
          problems.push(`folds[${i}]: must be [anchorId, memberIds[]]`);
        }
      }
    }
  }

  const layout = candidate['layout'];
  if (!isObj(layout) || (layout['kind'] !== 'force' && layout['kind'] !== 'fixed')) {
    problems.push("layout: must be { kind: 'force' | 'fixed' }");
  }

  const crossfilter = candidate['crossfilter'];
  if (!Array.isArray(crossfilter)) {
    problems.push('crossfilter: must be an array');
  } else {
    for (let i = 0; i < crossfilter.length; i++) {
      const c: unknown = crossfilter[i];
      if (!isObj(c) || !isStr(c['key'])) {
        problems.push(`crossfilter[${i}]: must be {key, state}`);
        continue;
      }
      validateBrush(c['state'], `crossfilter[${i}].state`, problems);
    }
  }

  const positions = candidate['positions'];
  if (positions !== undefined) {
    if (!Array.isArray(positions)) {
      problems.push('positions: must be an array of [id, x, y] tuples');
    } else {
      for (let i = 0; i < positions.length; i++) {
        const p: unknown = positions[i];
        if (!Array.isArray(p) || p.length !== 3 || !isStr(p[0]) || !isNum(p[1]) || !isNum(p[2])) {
          problems.push(`positions[${i}]: must be [id, x, y] with finite coordinates`);
          break; // one sample is enough — payloads can be O(n)
        }
      }
    }
  }

  const styling = candidate['styling'];
  if (styling !== undefined) {
    if (!isObj(styling)) {
      problems.push('styling: must be an object');
    } else {
      if (styling['nodeColor'] !== undefined) {
        validateScale(styling['nodeColor'], 'styling.nodeColor', 'string', problems);
      }
      if (styling['nodeSize'] !== undefined) {
        validateScale(styling['nodeSize'], 'styling.nodeSize', 'number', problems);
      }
      for (const flag of ['showLinks', 'edgeArrows'] as const) {
        if (styling[flag] !== undefined && !isBool(styling[flag])) {
          problems.push(`styling.${flag}: must be a boolean`);
        }
      }
      const theme = styling['theme'];
      if (theme !== undefined && theme !== 'light' && theme !== 'dark') {
        problems.push("styling.theme: must be 'light' or 'dark'");
      }
    }
  }

  // dataRef is stored verbatim and never interpreted — but it must BE a JSON
  // value: setViewState takes `unknown`, so cycles/BigInt/functions can
  // arrive from a host even though a parsed deep-link never carries them.
  const ref = candidate['dataRef'];
  if (ref !== undefined) {
    try {
      canonicalJson(ref as JsonValue);
    } catch {
      problems.push('dataRef: not a JSON value (cyclic or non-serializable)');
    }
  }

  if (problems.length > 0) return { ok: false, code: 'invalid-view-state', problems };
  return { ok: true, state: candidate as unknown as GraphViewState };
}

// ---------------------------------------------------------------------------
// Migration registry. Empty at v1 by definition; every release that bumps
// VIEW_STATE_VERSION MUST register the migration from each prior version in
// the same change. Kept here so the seam exists from day one
// and the version gate above already exercises it.
// ---------------------------------------------------------------------------

type Migration = (state: Record<string, unknown>) => Record<string, unknown>;

/** version N → the migration that lifts an N-shaped payload to N+1. */
const MIGRATIONS = new Map<number, Migration>();

function migrate(state: Record<string, unknown>, from: number): Record<string, unknown> | null {
  let cur = state;
  for (let v = from; v < VIEW_STATE_VERSION; v++) {
    const step = MIGRATIONS.get(v);
    if (step === undefined) return null; // no path — reject upstream
    cur = { ...step(cur), v: v + 1 };
  }
  return cur;
}

// ---------------------------------------------------------------------------
// setViewState result surface (typed outcomes — never throws for
// payload problems; the promise resolves with the verdict).
// ---------------------------------------------------------------------------

export type SetViewStateResult =
  | { status: 'applied' }
  /** dataRef differed: `viewStateMismatch` fired INSTEAD of applying.
   * Re-call with `ignoreMismatch: true` to opt in. */
  | { status: 'mismatch' }
  | {
      status: 'rejected';
      code:
        | 'invalid-view-state'
        | 'unsupported-version'
        /** The state touches a controlled slice or carries styling the
         * host must reflect, and no aggregate restore callback exists. */
        | 'missing-restore-callback'
        /** Another restore/history transaction is awaiting acknowledgement. */
        | 'restore-pending'
        /** The host never reflected the intent within the window. */
        | 'restore-timeout'
        /** The host reflected different values, or dataset replacement /
         * destruction invalidated the staged transaction. */
        | 'restore-diverged';
      problems: readonly string[];
    };
