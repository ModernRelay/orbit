import { describe, expect, it } from 'vitest';
import { coerceNumeric, coerceNumericInto } from '../src/hygiene';

/** Deterministic PRNG (mulberry32) so property runs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('coerceNumeric — numbers', () => {
  it('passes finite numbers through unchanged', () => {
    expect(coerceNumeric(0)).toBe(0);
    expect(coerceNumeric(5)).toBe(5);
    expect(coerceNumeric(-3.25)).toBe(-3.25);
    expect(coerceNumeric(Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    expect(coerceNumeric(Number.MIN_VALUE)).toBe(Number.MIN_VALUE);
    expect(coerceNumeric(-0)).toBe(-0);
  });

  it('rejects non-finite numbers', () => {
    expect(coerceNumeric(NaN)).toBeNull();
    expect(coerceNumeric(Infinity)).toBeNull();
    expect(coerceNumeric(-Infinity)).toBeNull();
  });
});

describe('coerceNumeric — string sentinels (every casing)', () => {
  const sentinels = [
    'NaN', 'nan', 'NAN', 'nAn',
    'Infinity', 'infinity', 'INFINITY',
    '-Infinity', '-infinity', '-INFINITY',
    '+Infinity', '+infinity',
    '  NaN  ', '\tInfinity\n', ' -Infinity ',
  ];
  for (const s of sentinels) {
    it(`${JSON.stringify(s)} → null`, () => {
      expect(coerceNumeric(s)).toBeNull();
    });
  }
});

describe('coerceNumeric — numeric strings', () => {
  it('parses plain and signed decimals', () => {
    expect(coerceNumeric('42')).toBe(42);
    expect(coerceNumeric('-3.5')).toBe(-3.5);
    expect(coerceNumeric('+7')).toBe(7);
    expect(coerceNumeric('.5')).toBe(0.5);
    expect(coerceNumeric('5.')).toBe(5);
    expect(coerceNumeric('0')).toBe(0);
  });

  it("parses scientific notation ('1e3' → 1000)", () => {
    expect(coerceNumeric('1e3')).toBe(1000);
    expect(coerceNumeric('1E3')).toBe(1000);
    expect(coerceNumeric('-2.5e-2')).toBe(-0.025);
  });

  it('trims surrounding whitespace', () => {
    expect(coerceNumeric('  7  ')).toBe(7);
    expect(coerceNumeric('\t-1.5\n')).toBe(-1.5);
  });

  it('parses hex/binary/octal literals (Number semantics, not parseFloat)', () => {
    expect(coerceNumeric('0x10')).toBe(16);
    expect(coerceNumeric('0b101')).toBe(5);
    expect(coerceNumeric('0o17')).toBe(15);
  });

  it('rejects empty / whitespace-only strings', () => {
    expect(coerceNumeric('')).toBeNull();
    expect(coerceNumeric('   ')).toBeNull();
    expect(coerceNumeric('\t\n')).toBeNull();
  });

  it('rejects partial-prefix and junk strings (no parseFloat laxity)', () => {
    expect(coerceNumeric('12px')).toBeNull();
    expect(coerceNumeric('1.2.3')).toBeNull();
    expect(coerceNumeric('abc')).toBeNull();
    expect(coerceNumeric('1e')).toBeNull();
    expect(coerceNumeric('- 5')).toBeNull();
    expect(coerceNumeric('五')).toBeNull();
  });

  it('rejects strings that overflow to Infinity', () => {
    expect(coerceNumeric('1e999')).toBeNull();
    expect(coerceNumeric('-1e999')).toBeNull();
  });
});

describe('coerceNumeric — non-number, non-string inputs', () => {
  it('rejects booleans (no Number(true) === 1 side channel)', () => {
    expect(coerceNumeric(true)).toBeNull();
    expect(coerceNumeric(false)).toBeNull();
  });

  it('rejects null and undefined', () => {
    expect(coerceNumeric(null)).toBeNull();
    expect(coerceNumeric(undefined)).toBeNull();
  });

  it('rejects objects even when valueOf/toString would yield a number', () => {
    expect(coerceNumeric({})).toBeNull();
    expect(coerceNumeric({ valueOf: () => 5 })).toBeNull();
    expect(coerceNumeric({ toString: () => '7' })).toBeNull();
    expect(coerceNumeric(new Number(3))).toBeNull();
    expect(coerceNumeric(new Date(0))).toBeNull();
  });

  it("rejects arrays even when string coercion would parse (['5'])", () => {
    expect(coerceNumeric([])).toBeNull();
    expect(coerceNumeric([5])).toBeNull();
    expect(coerceNumeric(['5'])).toBeNull();
    expect(coerceNumeric([1, 2])).toBeNull();
  });

  it('rejects bigints, symbols, and functions', () => {
    expect(coerceNumeric(5n)).toBeNull();
    expect(coerceNumeric(Symbol('5'))).toBeNull();
    expect(coerceNumeric(() => 5)).toBeNull();
  });
});

describe('coerceNumeric — property: null or finite, never NaN', () => {
  it('holds over 2000 randomized mixed-type inputs', () => {
    const rand = mulberry32(0xc0ffee);
    const junkStrings = ['NaN', 'Infinity', '-Infinity', '', ' ', 'abc', '12px', '1e', '--1'];
    const generators: ReadonlyArray<() => unknown> = [
      () => (rand() - 0.5) * 2 ** Math.floor(rand() * 64),
      () => [NaN, Infinity, -Infinity][Math.floor(rand() * 3)],
      () => String((rand() - 0.5) * 1e6),
      () => `${rand() > 0.5 ? ' ' : ''}${Math.floor(rand() * 100)}e${Math.floor(rand() * 400)}`,
      () => junkStrings[Math.floor(rand() * junkStrings.length)],
      () => rand() > 0.5,
      () => null,
      () => undefined,
      () => ({ v: rand() }),
      () => [rand()],
      () => BigInt(Math.floor(rand() * 100)),
    ];
    for (let i = 0; i < 2000; i++) {
      const gen = generators[Math.floor(rand() * generators.length)]!;
      const input = gen();
      const out = coerceNumeric(input);
      if (out !== null) {
        expect(Number.isFinite(out)).toBe(true);
      }
      expect(Number.isNaN(out as number)).toBe(false);
    }
  });
});

describe('coerceNumericInto', () => {
  it('writes the coerced value and returns true on admission', () => {
    const buf = new Float32Array(3);
    expect(coerceNumericInto(buf, 1, '2.5', 9)).toBe(true);
    expect(buf[1]).toBe(2.5);
    expect(coerceNumericInto(buf, 0, 4, 9)).toBe(true);
    expect(buf[0]).toBe(4);
  });

  it('writes the fallback and returns false on rejection', () => {
    const buf = new Float32Array(2);
    expect(coerceNumericInto(buf, 0, 'NaN', 7)).toBe(false);
    expect(buf[0]).toBe(7);
    expect(coerceNumericInto(buf, 1, undefined, 3)).toBe(false);
    expect(buf[1]).toBe(3);
  });

  it('never writes NaN even when the fallback itself is non-finite', () => {
    const buf = new Float32Array(1).fill(5);
    expect(coerceNumericInto(buf, 0, {}, NaN)).toBe(false);
    expect(buf[0]).toBe(0);
    expect(coerceNumericInto(buf, 0, 'junk', Infinity)).toBe(false);
    expect(buf[0]).toBe(0);
  });

  it('property: the buffer never contains NaN after any write sequence', () => {
    const rand = mulberry32(0xbeef);
    const buf = new Float32Array(8);
    const inputs: ReadonlyArray<unknown> = [
      1, NaN, Infinity, 'NaN', '3', '', {}, [], true, null, undefined, '1e3', '-Infinity',
    ];
    const fallbacks = [0, 4, NaN, Infinity, -1];
    for (let i = 0; i < 1000; i++) {
      const value = inputs[Math.floor(rand() * inputs.length)];
      const fallback = fallbacks[Math.floor(rand() * fallbacks.length)]!;
      coerceNumericInto(buf, Math.floor(rand() * buf.length), value, fallback);
      for (let j = 0; j < buf.length; j++) {
        expect(Number.isNaN(buf[j]!)).toBe(false);
      }
    }
  });
});
