/**
 * soft filtering — pure, engine-free expr evaluation,
 * validation, compilation, and canonical keying. The instance feeds compiled
 * filters into the SoftMask kernel (./mask); nothing here touches the store.
 *
 * Semantics:
 * - `field` addresses `attrs[field]`; the literal field 'id' addresses the
 * entity id (it wins even when `attrs.id` exists).
 * - The serializable expr path NEVER throws: junk shapes and numeric-hygiene
 * failures (non-numeric / non-finite values under 'range') simply fail the
 * item. `validateFilterExpr` is the reporting channel — the instance turns
 * its findings into validation errors at applyHostUpdate.
 * - eq/neq/in compare numbers with Object.is semantics EXCEPT that NaN is
 * never equal to anything (so ±0 are distinct and NaN ≠ NaN); everything
 * else compares with plain ===. No coercion, ever ('5' never equals 5).
 * - Function predicates are black boxes: throws are caught and aggregated
 * into ONE {count, samples} result the caller converts to a single
 * 'filter-error' diagnostic (batching — O(categories), never O(bad
 * rows)). A throwing predicate FAILS OPEN: the item stays visible, so a
 * buggy predicate can never blank the graph.
 * - Structural specs compare by canonical key (`canonicalFilterKey`) so
 * identity churn with equal structure never re-evaluates; function
 * predicates key by reference identity via a WeakMap-issued token.
 */

import { DIAGNOSTIC_SAMPLE_CAP } from './types';
import type { AcceptedEdge, FilterExpr, FilterSpec, GraphNode } from './types';

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a filter `field` against an entity: 'id' addresses the entity id;
 * any other field addresses `attrs[field]` (undefined when attrs are absent).
 */
export function resolveFilterField(
  item: GraphNode<unknown> | AcceptedEdge<unknown>,
  field: string,
): unknown {
  if (field === 'id') return item.id;
  const attrs = item.attrs as Record<string, unknown> | null | undefined;
  return attrs?.[field];
}

// ---------------------------------------------------------------------------
// Evaluation (never throws)
// ---------------------------------------------------------------------------

/**
 * equality: numbers use Object.is semantics EXCEPT NaN never equals
 * anything (±0 distinct, NaN ≠ NaN); non-numbers use plain ===.
 */
function filterValuesEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return Object.is(a, b) && !Number.isNaN(a);
  }
  return a === b;
}

/**
 * Evaluates one expr for one item via a field resolver. NEVER throws:
 * malformed shapes and numeric-hygiene failures fail the item (return false);
 * a malformed operand under 'not' also fails (junk never passes by double
 * negation). `range` requires a finite number value; missing bounds are
 * unbounded; includeMin/includeMax default true. `is-null` matches null OR
 * undefined (absent attr).
 */
export function evaluateFilterExpr(
  expr: FilterExpr,
  resolve: (field: string) => unknown,
): boolean {
  if (typeof expr !== 'object' || expr === null) return false;
  switch (expr.op) {
    case 'eq':
    case 'neq': {
      const equal = filterValuesEqual(resolve(expr.field), expr.value);
      return expr.op === 'eq' ? equal : !equal;
    }
    case 'in': {
      const { values } = expr;
      if (!Array.isArray(values)) return false;
      const v = resolve(expr.field);
      for (let i = 0; i < values.length; i++) {
        if (filterValuesEqual(v, values[i])) return true;
      }
      return false;
    }
    case 'range': {
      const v = resolve(expr.field);
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
      const { min, max } = expr;
      if (typeof min === 'number' && ((expr.includeMin ?? true) ? v < min : v <= min)) {
        return false;
      }
      if (typeof max === 'number' && ((expr.includeMax ?? true) ? v > max : v >= max)) {
        return false;
      }
      return true;
    }
    case 'is-null': {
      const v = resolve(expr.field);
      return v === null || v === undefined;
    }
    case 'not': {
      const inner: unknown = expr.expr;
      if (typeof inner !== 'object' || inner === null) return false;
      return !evaluateFilterExpr(inner as FilterExpr, resolve);
    }
    case 'and': {
      const terms = expr.exprs;
      if (!Array.isArray(terms)) return false;
      for (let i = 0; i < terms.length; i++) {
        if (!evaluateFilterExpr(terms[i] as FilterExpr, resolve)) return false;
      }
      return true; // vacuous truth: empty 'and' passes
    }
    case 'or': {
      const terms = expr.exprs;
      if (!Array.isArray(terms)) return false;
      for (let i = 0; i < terms.length; i++) {
        if (evaluateFilterExpr(terms[i] as FilterExpr, resolve)) return true;
      }
      return false; // empty 'or' fails
    }
    default:
      return false; // unknown op — validateFilterExpr is the reporting channel
  }
}

// ---------------------------------------------------------------------------
// Validation (the instance surfaces these at applyHostUpdate)
// ---------------------------------------------------------------------------

function isFilterValue(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function checkField(e: Record<string, unknown>, path: string, out: string[]): void {
  if (typeof e['field'] !== 'string' || e['field'].length === 0) {
    out.push(`${path}: 'field' must be a non-empty string`);
  }
}

function validateInto(value: unknown, path: string, out: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    out.push(`${path}: expected a FilterExpr object`);
    return;
  }
  const e = value as Record<string, unknown>;
  const op = e['op'];
  if (typeof op !== 'string') {
    out.push(`${path}: missing string 'op'`);
    return;
  }
  switch (op) {
    case 'eq':
    case 'neq':
      checkField(e, path, out);
      if (!isFilterValue(e['value'])) {
        out.push(`${path}: 'value' must be string | number | boolean | null`);
      }
      break;
    case 'in': {
      checkField(e, path, out);
      const values = e['values'];
      if (!Array.isArray(values)) {
        out.push(`${path}: 'values' must be an array`);
      } else {
        for (let i = 0; i < values.length; i++) {
          if (!isFilterValue(values[i])) {
            out.push(`${path}.values[${i}]: must be string | number | boolean | null`);
          }
        }
      }
      break;
    }
    case 'range': {
      checkField(e, path, out);
      for (const key of ['min', 'max'] as const) {
        const bound = e[key];
        if (bound !== undefined && (typeof bound !== 'number' || Number.isNaN(bound))) {
          out.push(`${path}.${key}: must be a number (not NaN)`);
        }
      }
      for (const key of ['includeMin', 'includeMax'] as const) {
        const flag = e[key];
        if (flag !== undefined && typeof flag !== 'boolean') {
          out.push(`${path}.${key}: must be a boolean`);
        }
      }
      break;
    }
    case 'is-null':
      checkField(e, path, out);
      break;
    case 'not':
      validateInto(e['expr'], `${path}.expr`, out);
      break;
    case 'and':
    case 'or': {
      const terms = e['exprs'];
      if (!Array.isArray(terms)) {
        out.push(`${path}: 'exprs' must be an array`);
      } else {
        for (let i = 0; i < terms.length; i++) {
          validateInto(terms[i], `${path}.exprs[${i}]`, out);
        }
      }
      break;
    }
    default:
      out.push(`${path}: unknown filter op '${op}'`);
  }
}

/**
 * Structural checker for serializable exprs: unknown ops and malformed
 * shapes are reported as `$`-rooted path strings ([] = valid). The instance
 * converts findings into validation errors at applyHostUpdate
 * evaluation itself never throws on the same junk, it just fails the item.
 */
export function validateFilterExpr(expr: FilterExpr): string[] {
  const out: string[] = [];
  validateInto(expr, '$', out);
  return out;
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/** ONE aggregated throw tally per compiled filter → one 'filter-error'
 * diagnostic (count + capped samples), never O(bad rows) diagnostics. */
export interface FilterErrorAggregate {
  count: number;
  /** At most DIAGNOSTIC_SAMPLE_CAP offending entity ids. */
  samples: string[];
}

export interface CompiledFilter<T> {
  /** True = item passes (stays fully visible); false = item fails the mask. */
  test(item: T): boolean;
  /** Live tally of predicate throws (function specs only; the expr path
   * never throws). The caller converts a nonzero count to a 'filter-error'
   * diagnostic after the evaluation pass. */
  readonly errors: FilterErrorAggregate;
}

function compileSelector<T extends GraphNode<unknown> | AcceptedEdge<unknown>>(
  selector: FilterExpr | ((item: T) => boolean) | undefined,
): CompiledFilter<T> {
  const errors: FilterErrorAggregate = { count: 0, samples: [] };
  if (selector === undefined) {
    return { errors, test: () => true };
  }
  if (typeof selector === 'function') {
    return {
      errors,
      test(item: T): boolean {
        try {
          return Boolean(selector(item));
        } catch {
          errors.count += 1;
          if (errors.samples.length < DIAGNOSTIC_SAMPLE_CAP) errors.samples.push(item.id);
          return true; // fail open: a throwing predicate never hides data
        }
      },
    };
  }
  // Expr path: one reused resolver closure — zero per-item allocation.
  let current: T | null = null;
  const resolve = (field: string): unknown =>
    current === null ? undefined : resolveFilterField(current, field);
  return {
    errors,
    test(item: T): boolean {
      current = item;
      const pass = evaluateFilterExpr(selector, resolve);
      current = null;
      return pass;
    },
  };
}

/** Compiles the node lane of a FilterSpec (absent selector = pass-all). */
export function compileNodeFilter<N = Record<string, unknown>, E = Record<string, unknown>>(
  spec: FilterSpec<N, E>,
): CompiledFilter<GraphNode<N>> {
  return compileSelector<GraphNode<N>>(spec.nodes);
}

/** Compiles the edge lane of a FilterSpec (absent selector = pass-all). */
export function compileEdgeFilter<N = Record<string, unknown>, E = Record<string, unknown>>(
  spec: FilterSpec<N, E>,
): CompiledFilter<AcceptedEdge<E>> {
  return compileSelector<AcceptedEdge<E>>(spec.edges);
}

// ---------------------------------------------------------------------------
// Canonical keying
// ---------------------------------------------------------------------------

/** Function predicates key by reference identity: a WeakMap-issued counter
 * token (unique, deliberately non-canonical) — equal source text is NOT
 * equal identity, and re-using the same reference IS. */
const functionTokens = new WeakMap<object, number>();
let nextFunctionToken = 0;

function functionToken(fn: object): string {
  let token = functionTokens.get(fn);
  if (token === undefined) {
    token = nextFunctionToken;
    nextFunctionToken += 1;
    functionTokens.set(fn, token);
  }
  return `fn#${token}`;
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'function':
      return functionToken(value as object);
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Object.is(value, -0) ? '-0' : String(value); // 'NaN'/'Infinity' are bare tokens
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
      return 'undefined';
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return String(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    let out = '[';
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out += ',';
      out += canonicalize(value[i]);
    }
    return `${out}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  let out = '{';
  let first = true;
  for (const key of keys) {
    const v = obj[key];
    if (v === undefined) continue; // absent and undefined-valued keys are equal
    if (!first) out += ',';
    first = false;
    out += `${JSON.stringify(key)}:${canonicalize(v)}`;
  }
  return `${out}}`;
}

/**
 * Canonical structural key for a FilterSpec or FilterExpr: object keys are
 * sorted, arrays preserve order, undefined-valued keys are omitted, and
 * function predicates map to a unique reference-identity token. Two inputs
 * with equal keys are semantically equivalent — the instance skips re-evaluation
 * when the key of an incoming filter matches the active one (identity churn
 * with equal structure never re-evaluates; swapping a function reference
 * always does).
 */
export function canonicalFilterKey(specOrExpr: unknown): string {
  return canonicalize(specOrExpr);
}
