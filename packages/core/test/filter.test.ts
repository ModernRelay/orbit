import { describe, expect, it } from 'vitest';
import {
  canonicalFilterKey,
  compileEdgeFilter,
  compileNodeFilter,
  evaluateFilterExpr,
  resolveFilterField,
  validateFilterExpr,
} from '../src/filter';
import { DIAGNOSTIC_SAMPLE_CAP } from '../src/types';
import type { AcceptedEdge, FilterExpr, GraphNode } from '../src/types';

function node(id: string, attrs?: Record<string, unknown>): GraphNode {
  return attrs === undefined ? { id } : { id, attrs };
}

function edge(id: string, attrs?: Record<string, unknown>): AcceptedEdge {
  const base: AcceptedEdge = { id, source: 'a', target: 'b' };
  return attrs === undefined ? base : { ...base, attrs };
}

/** Evaluates an expr against a node built from `attrs`. */
function evalOn(expr: FilterExpr, attrs?: Record<string, unknown>, id = 'n1'): boolean {
  const item = node(id, attrs);
  return evaluateFilterExpr(expr, (field) => resolveFilterField(item, field));
}

/** Casts junk into the expr type — evaluation must never throw on it. */
function junk(value: unknown): FilterExpr {
  return value as FilterExpr;
}

describe('resolveFilterField', () => {
  it("'id' addresses the entity id, even when attrs.id exists", () => {
    expect(resolveFilterField(node('n1', { id: 'shadow' }), 'id')).toBe('n1');
    expect(resolveFilterField(edge('e1', { id: 'shadow' }), 'id')).toBe('e1');
  });

  it('other fields address attrs[field]', () => {
    expect(resolveFilterField(node('n1', { kind: 'x', n: 0 }), 'kind')).toBe('x');
    expect(resolveFilterField(node('n1', { kind: 'x', n: 0 }), 'n')).toBe(0);
    expect(resolveFilterField(edge('e1', { w: 2 }), 'w')).toBe(2);
  });

  it('missing attrs or missing key resolve to undefined', () => {
    expect(resolveFilterField(node('n1'), 'kind')).toBeUndefined();
    expect(resolveFilterField(node('n1', {}), 'kind')).toBeUndefined();
  });
});

describe('eq / neq', () => {
  it('compares strings, booleans, and null with ===', () => {
    expect(evalOn({ op: 'eq', field: 'k', value: 'a' }, { k: 'a' })).toBe(true);
    expect(evalOn({ op: 'eq', field: 'k', value: 'a' }, { k: 'b' })).toBe(false);
    expect(evalOn({ op: 'eq', field: 'k', value: true }, { k: true })).toBe(true);
    expect(evalOn({ op: 'eq', field: 'k', value: null }, { k: null })).toBe(true);
    expect(evalOn({ op: 'neq', field: 'k', value: 'a' }, { k: 'b' })).toBe(true);
  });

  it('never coerces across types', () => {
    expect(evalOn({ op: 'eq', field: 'k', value: 5 }, { k: '5' })).toBe(false);
    expect(evalOn({ op: 'eq', field: 'k', value: '5' }, { k: 5 })).toBe(false);
    expect(evalOn({ op: 'eq', field: 'k', value: null }, {})).toBe(false); // undefined !== null
  });

  it('NaN is never equal (neq is therefore always true for NaN)', () => {
    expect(evalOn({ op: 'eq', field: 'k', value: NaN }, { k: NaN })).toBe(false);
    expect(evalOn({ op: 'neq', field: 'k', value: NaN }, { k: NaN })).toBe(true);
    expect(evalOn({ op: 'eq', field: 'k', value: NaN }, { k: 1 })).toBe(false);
  });

  it('±0 are distinct (Object.is number semantics)', () => {
    expect(evalOn({ op: 'eq', field: 'k', value: 0 }, { k: -0 })).toBe(false);
    expect(evalOn({ op: 'eq', field: 'k', value: -0 }, { k: -0 })).toBe(true);
    expect(evalOn({ op: 'eq', field: 'k', value: 0 }, { k: 0 })).toBe(true);
  });
});

describe('in', () => {
  it('matches membership with eq semantics', () => {
    expect(evalOn({ op: 'in', field: 'k', values: ['a', 'b'] }, { k: 'b' })).toBe(true);
    expect(evalOn({ op: 'in', field: 'k', values: ['a', 'b'] }, { k: 'c' })).toBe(false);
    expect(evalOn({ op: 'in', field: 'k', values: [null, 2] }, { k: null })).toBe(true);
  });

  it('empty values never match; NaN never matches', () => {
    expect(evalOn({ op: 'in', field: 'k', values: [] }, { k: 'a' })).toBe(false);
    expect(evalOn({ op: 'in', field: 'k', values: [NaN] }, { k: NaN })).toBe(false);
  });
});

describe('range', () => {
  const v = (n: unknown): Record<string, unknown> => ({ v: n });

  it('bounds default to inclusive', () => {
    expect(evalOn({ op: 'range', field: 'v', min: 5 }, v(5))).toBe(true);
    expect(evalOn({ op: 'range', field: 'v', max: 5 }, v(5))).toBe(true);
    expect(evalOn({ op: 'range', field: 'v', min: 1, max: 5 }, v(3))).toBe(true);
    expect(evalOn({ op: 'range', field: 'v', min: 1, max: 5 }, v(0.999))).toBe(false);
    expect(evalOn({ op: 'range', field: 'v', min: 1, max: 5 }, v(5.001))).toBe(false);
  });

  it('honors every includeMin/includeMax combination at the boundary', () => {
    for (const includeMin of [true, false]) {
      for (const includeMax of [true, false]) {
        const expr: FilterExpr = { op: 'range', field: 'v', min: 1, max: 5, includeMin, includeMax };
        expect(evalOn(expr, v(1)), `min ${includeMin}/${includeMax}`).toBe(includeMin);
        expect(evalOn(expr, v(5)), `max ${includeMin}/${includeMax}`).toBe(includeMax);
        expect(evalOn(expr, v(3)), `mid ${includeMin}/${includeMax}`).toBe(true);
      }
    }
  });

  it('exclusive bounds reject the boundary but keep the interior', () => {
    expect(evalOn({ op: 'range', field: 'v', min: 1, includeMin: false }, v(1))).toBe(false);
    expect(evalOn({ op: 'range', field: 'v', min: 1, includeMin: false }, v(1.0001))).toBe(true);
    expect(evalOn({ op: 'range', field: 'v', max: 5, includeMax: false }, v(5))).toBe(false);
    expect(evalOn({ op: 'range', field: 'v', max: 5, includeMax: false }, v(4.9999))).toBe(true);
  });

  it('an unbounded range passes any finite number', () => {
    expect(evalOn({ op: 'range', field: 'v' }, v(-1e12))).toBe(true);
    expect(evalOn({ op: 'range', field: 'v' }, v(0))).toBe(true);
  });

  it('hygiene: non-numeric and non-finite values fail, never throw', () => {
    expect(evalOn({ op: 'range', field: 'v', min: 0 }, v('5'))).toBe(false);
    expect(evalOn({ op: 'range', field: 'v', min: 0 }, v(NaN))).toBe(false);
    expect(evalOn({ op: 'range', field: 'v', min: 0 }, v(Infinity))).toBe(false);
    expect(evalOn({ op: 'range', field: 'v', min: 0 }, v(-Infinity))).toBe(false);
    expect(evalOn({ op: 'range', field: 'v', min: 0 }, v(true))).toBe(false);
    expect(evalOn({ op: 'range', field: 'v', min: 0 }, v(null))).toBe(false);
    expect(evalOn({ op: 'range', field: 'v', min: 0 }, {})).toBe(false); // missing attr
  });
});

describe('is-null', () => {
  it('matches null AND undefined (missing attr / missing attrs object)', () => {
    expect(evalOn({ op: 'is-null', field: 'k' }, { k: null })).toBe(true);
    expect(evalOn({ op: 'is-null', field: 'k' }, {})).toBe(true);
    expect(evalOn({ op: 'is-null', field: 'k' })).toBe(true); // no attrs at all
  });

  it('falsy non-null values do not match', () => {
    expect(evalOn({ op: 'is-null', field: 'k' }, { k: 0 })).toBe(false);
    expect(evalOn({ op: 'is-null', field: 'k' }, { k: '' })).toBe(false);
    expect(evalOn({ op: 'is-null', field: 'k' }, { k: false })).toBe(false);
  });
});

describe('and / or / not composition', () => {
  const attrs = { kind: 'a', v: 3 };

  it('composes nested expressions', () => {
    const expr: FilterExpr = {
      op: 'and',
      exprs: [
        { op: 'eq', field: 'kind', value: 'a' },
        {
          op: 'or',
          exprs: [
            { op: 'range', field: 'v', min: 10 },
            { op: 'not', expr: { op: 'is-null', field: 'v' } },
          ],
        },
      ],
    };
    expect(evalOn(expr, attrs)).toBe(true);
    expect(evalOn(expr, { kind: 'b', v: 3 })).toBe(false);
    expect(evalOn(expr, { kind: 'a' })).toBe(false); // v missing → both or-terms fail
  });

  it('not inverts', () => {
    expect(evalOn({ op: 'not', expr: { op: 'eq', field: 'kind', value: 'a' } }, attrs)).toBe(false);
    expect(evalOn({ op: 'not', expr: { op: 'eq', field: 'kind', value: 'z' } }, attrs)).toBe(true);
  });

  it('empty and is vacuously true; empty or is false', () => {
    expect(evalOn({ op: 'and', exprs: [] }, attrs)).toBe(true);
    expect(evalOn({ op: 'or', exprs: [] }, attrs)).toBe(false);
  });
});

describe('evaluateFilterExpr on junk (never throws)', () => {
  it('fails malformed shapes instead of throwing', () => {
    expect(evalOn(junk(null))).toBe(false);
    expect(evalOn(junk('eq'))).toBe(false);
    expect(evalOn(junk(42))).toBe(false);
    expect(evalOn(junk({ op: 'bogus', field: 'k' }))).toBe(false);
    expect(evalOn(junk({ op: 'not' }))).toBe(false); // missing operand never passes
    expect(evalOn(junk({ op: 'not', expr: 'nope' }))).toBe(false);
    expect(evalOn(junk({ op: 'in', field: 'k', values: 'nope' }), { k: 'n' })).toBe(false);
    expect(evalOn(junk({ op: 'and', exprs: 'nope' }))).toBe(false);
    expect(evalOn(junk({ op: 'or', exprs: null }))).toBe(false);
  });
});

describe('validateFilterExpr', () => {
  it('accepts every well-formed op', () => {
    const exprs: FilterExpr[] = [
      { op: 'eq', field: 'k', value: 'a' },
      { op: 'neq', field: 'k', value: null },
      { op: 'in', field: 'k', values: ['a', 1, true, null] },
      { op: 'range', field: 'v', min: 0, max: 1, includeMin: false, includeMax: false },
      { op: 'range', field: 'v' },
      { op: 'is-null', field: 'k' },
      { op: 'not', expr: { op: 'eq', field: 'k', value: 1 } },
      { op: 'and', exprs: [{ op: 'or', exprs: [] }] },
    ];
    for (const expr of exprs) {
      expect(validateFilterExpr(expr), JSON.stringify(expr)).toEqual([]);
    }
  });

  it('reports non-object roots and missing ops', () => {
    expect(validateFilterExpr(junk(null))).toHaveLength(1);
    expect(validateFilterExpr(junk('eq'))).toHaveLength(1);
    expect(validateFilterExpr(junk([]))).toHaveLength(1);
    expect(validateFilterExpr(junk({}))[0]).toContain("missing string 'op'");
    expect(validateFilterExpr(junk({ op: 42 }))[0]).toContain("missing string 'op'");
  });

  it('reports unknown ops', () => {
    expect(validateFilterExpr(junk({ op: 'between', field: 'v' }))[0]).toContain(
      "unknown filter op 'between'",
    );
  });

  it('reports malformed operands with paths', () => {
    expect(validateFilterExpr(junk({ op: 'eq', value: 1 }))[0]).toContain("'field'");
    expect(validateFilterExpr(junk({ op: 'eq', field: 'k', value: { x: 1 } }))[0]).toContain(
      "'value'",
    );
    expect(validateFilterExpr(junk({ op: 'in', field: 'k', values: 'nope' }))[0]).toContain(
      "'values' must be an array",
    );
    const deepValues = validateFilterExpr(junk({ op: 'in', field: 'k', values: ['ok', {}] }));
    expect(deepValues[0]).toContain('.values[1]');
    expect(validateFilterExpr(junk({ op: 'range', field: 'v', min: '0' }))[0]).toContain('.min');
    expect(validateFilterExpr(junk({ op: 'range', field: 'v', min: NaN }))[0]).toContain('.min');
    expect(
      validateFilterExpr(junk({ op: 'range', field: 'v', includeMin: 'yes' }))[0],
    ).toContain('.includeMin');
    expect(validateFilterExpr(junk({ op: 'is-null' }))[0]).toContain("'field'");
    expect(validateFilterExpr(junk({ op: 'not' }))[0]).toContain('$.expr');
    expect(validateFilterExpr(junk({ op: 'and', exprs: 'nope' }))[0]).toContain(
      "'exprs' must be an array",
    );
  });

  it('recurses with index paths and accumulates multiple errors', () => {
    const errors = validateFilterExpr(
      junk({
        op: 'and',
        exprs: [
          { op: 'eq', field: 'k', value: 1 },
          { op: 'huh' },
          { op: 'not', expr: { op: 'range', field: 'v', min: 'x', includeMax: 3 } },
        ],
      }),
    );
    expect(errors).toHaveLength(3);
    expect(errors[0]).toContain('$.exprs[1]');
    expect(errors[1]).toContain('$.exprs[2].expr.min');
    expect(errors[2]).toContain('$.exprs[2].expr.includeMax');
  });
});

describe('compileNodeFilter / compileEdgeFilter', () => {
  it('an absent selector passes everything', () => {
    const nodes = compileNodeFilter({});
    const edges = compileEdgeFilter({});
    expect(nodes.test(node('n1'))).toBe(true);
    expect(edges.test(edge('e1'))).toBe(true);
    expect(nodes.errors.count).toBe(0);
  });

  it('compiles the expr path (never throws, no error tallies)', () => {
    const compiled = compileNodeFilter({
      nodes: { op: 'and', exprs: [{ op: 'eq', field: 'kind', value: 'a' }] },
      mode: 'hide',
    });
    expect(compiled.test(node('n1', { kind: 'a' }))).toBe(true);
    expect(compiled.test(node('n2', { kind: 'b' }))).toBe(false);
    expect(compiled.test(node('n3'))).toBe(false);
    expect(compiled.errors.count).toBe(0);
  });

  it('node compilation uses the node lane; edge compilation the edge lane', () => {
    const spec = {
      nodes: { op: 'eq', field: 'id', value: 'n1' } as FilterExpr,
      edges: { op: 'eq', field: 'id', value: 'e1' } as FilterExpr,
    };
    expect(compileNodeFilter(spec).test(node('n1'))).toBe(true);
    expect(compileNodeFilter(spec).test(node('e1'))).toBe(false);
    expect(compileEdgeFilter(spec).test(edge('e1'))).toBe(true);
    expect(compileEdgeFilter(spec).test(edge('n1'))).toBe(false);
  });

  it('wraps function predicates and coerces their result to boolean', () => {
    const compiled = compileNodeFilter<Record<string, unknown>>({
      nodes: (n) => (n.attrs?.['keep'] as boolean | undefined) ?? false,
    });
    expect(compiled.test(node('n1', { keep: true }))).toBe(true);
    expect(compiled.test(node('n2', { keep: false }))).toBe(false);
    expect(compiled.test(node('n3'))).toBe(false);
  });

  it('aggregates predicate throws into ONE {count, samples} result (1000 throws → count 1000)', () => {
    const compiled = compileNodeFilter({
      nodes: () => {
        throw new Error('boom');
      },
    });
    for (let i = 0; i < 1000; i++) {
      // Fail-open: a throwing predicate keeps the item visible.
      expect(compiled.test(node(`n${i}`))).toBe(true);
    }
    expect(compiled.errors.count).toBe(1000);
    expect(compiled.errors.samples).toHaveLength(DIAGNOSTIC_SAMPLE_CAP);
    expect(compiled.errors.samples).toEqual(
      Array.from({ length: DIAGNOSTIC_SAMPLE_CAP }, (_, i) => `n${i}`),
    );
  });

  it('edge predicate throws tally on the edge compilation independently', () => {
    const compiled = compileEdgeFilter({
      edges: () => {
        throw new Error('boom');
      },
    });
    expect(compiled.test(edge('e9'))).toBe(true);
    expect(compiled.errors.count).toBe(1);
    expect(compiled.errors.samples).toEqual(['e9']);
  });
});

describe('canonicalFilterKey', () => {
  it('equal structure with different identity yields the same key', () => {
    const a: FilterExpr = { op: 'and', exprs: [{ op: 'eq', field: 'k', value: 1 }] };
    const b: FilterExpr = { op: 'and', exprs: [{ op: 'eq', field: 'k', value: 1 }] };
    expect(a).not.toBe(b);
    expect(canonicalFilterKey(a)).toBe(canonicalFilterKey(b));
  });

  it('is insensitive to object key order', () => {
    const a = { op: 'eq', field: 'k', value: 1 };
    const b = { value: 1, field: 'k', op: 'eq' };
    expect(canonicalFilterKey(a)).toBe(canonicalFilterKey(b));
    const specA = { mode: 'dim', nodes: a };
    const specB = { nodes: b, mode: 'dim' };
    expect(canonicalFilterKey(specA)).toBe(canonicalFilterKey(specB));
  });

  it('preserves array order', () => {
    expect(canonicalFilterKey({ op: 'in', field: 'k', values: [1, 2] })).not.toBe(
      canonicalFilterKey({ op: 'in', field: 'k', values: [2, 1] }),
    );
  });

  it('treats undefined-valued keys as absent', () => {
    expect(canonicalFilterKey({ op: 'range', field: 'v', min: 1, max: undefined })).toBe(
      canonicalFilterKey({ op: 'range', field: 'v', min: 1 }),
    );
  });

  it('distinguishes structurally different specs (mode included)', () => {
    const expr = { op: 'eq', field: 'k', value: 1 };
    expect(canonicalFilterKey({ nodes: expr })).not.toBe(
      canonicalFilterKey({ nodes: expr, mode: 'hide' }),
    );
    expect(canonicalFilterKey({ op: 'eq', field: 'k', value: 0 })).not.toBe(
      canonicalFilterKey({ op: 'eq', field: 'k', value: -0 }),
    );
  });

  it('keys function predicates by reference identity', () => {
    const f1 = (): boolean => true;
    const f2 = (): boolean => true; // identical source, different identity
    expect(canonicalFilterKey(f1)).toBe(canonicalFilterKey(f1)); // stable per reference
    expect(canonicalFilterKey(f1)).not.toBe(canonicalFilterKey(f2));
    expect(canonicalFilterKey({ nodes: f1, mode: 'hide' })).toBe(
      canonicalFilterKey({ mode: 'hide', nodes: f1 }),
    );
    expect(canonicalFilterKey({ nodes: f1 })).not.toBe(canonicalFilterKey({ nodes: f2 }));
  });

  it('function tokens never collide with structural encodings', () => {
    const f = (): boolean => true;
    const token = canonicalFilterKey(f);
    expect(token).toMatch(/^fn#\d+$/);
    expect(canonicalFilterKey(token)).toBe(JSON.stringify(token)); // string form is quoted
    expect(canonicalFilterKey(token)).not.toBe(token);
  });
});
