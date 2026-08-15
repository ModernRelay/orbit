import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_SAMPLE_CAP } from '../src/types';
import { parseColor, projectColors, projectSizes } from '../src/projection';

function expectRgba(
  actual: readonly number[] | null,
  expected: readonly [number, number, number, number],
): void {
  expect(actual).not.toBeNull();
  const a = actual as readonly number[];
  expect(a).toHaveLength(4);
  for (let i = 0; i < 4; i++) expect(a[i]).toBeCloseTo(expected[i]!, 5);
}

describe('parseColor', () => {
  describe('hex', () => {
    it('parses #rgb with digit expansion', () => {
      expectRgba(parseColor('#f00'), [1, 0, 0, 1]);
      expectRgba(parseColor('#0f0'), [0, 1, 0, 1]);
      expectRgba(parseColor('#abc'), [170 / 255, 187 / 255, 204 / 255, 1]);
    });

    it('parses #rgba with alpha expansion', () => {
      expectRgba(parseColor('#f008'), [1, 0, 0, 136 / 255]);
      expectRgba(parseColor('#000f'), [0, 0, 0, 1]);
    });

    it('parses #rrggbb', () => {
      expectRgba(parseColor('#ff0000'), [1, 0, 0, 1]);
      expectRgba(parseColor('#4682b4'), [70 / 255, 130 / 255, 180 / 255, 1]);
    });

    it('parses #rrggbbaa', () => {
      expectRgba(parseColor('#ff000080'), [1, 0, 0, 128 / 255]);
      expectRgba(parseColor('#00000000'), [0, 0, 0, 0]);
    });

    it('is case-insensitive and trims whitespace', () => {
      expectRgba(parseColor('  #FF00FF  '), [1, 0, 1, 1]);
      expectRgba(parseColor('#AbCdEf'), [171 / 255, 205 / 255, 239 / 255, 1]);
    });

    it('rejects malformed hex', () => {
      expect(parseColor('#ggg')).toBeNull();
      expect(parseColor('#12345')).toBeNull(); // 5 digits
      expect(parseColor('#1234567')).toBeNull(); // 7 digits
      expect(parseColor('#')).toBeNull();
      expect(parseColor('#ff00zz')).toBeNull();
    });
  });

  describe('rgb()/rgba()', () => {
    it('parses comma syntax with 0-255 channels', () => {
      expectRgba(parseColor('rgb(255, 0, 0)'), [1, 0, 0, 1]);
      expectRgba(parseColor('rgb(0,128,255)'), [0, 128 / 255, 1, 1]);
    });

    it('parses comma syntax with alpha (number and percent)', () => {
      expectRgba(parseColor('rgba(255, 0, 0, 0.5)'), [1, 0, 0, 0.5]);
      expectRgba(parseColor('rgba(0, 0, 0, 50%)'), [0, 0, 0, 0.5]);
    });

    it('parses percentage channels', () => {
      expectRgba(parseColor('rgb(100%, 0%, 50%)'), [1, 0, 0.5, 1]);
      expectRgba(parseColor('rgba(50%, 50%, 50%, 25%)'), [0.5, 0.5, 0.5, 0.25]);
    });

    it('parses space syntax with slash alpha', () => {
      expectRgba(parseColor('rgb(255 0 0)'), [1, 0, 0, 1]);
      expectRgba(parseColor('rgb(255 0 0 / 0.5)'), [1, 0, 0, 0.5]);
      expectRgba(parseColor('rgb(100% 50% 0% / 50%)'), [1, 0.5, 0, 0.5]);
      expectRgba(parseColor('rgba(0 0 255/25%)'), [0, 0, 1, 0.25]);
    });

    it('clamps out-of-range values like CSS', () => {
      expectRgba(parseColor('rgb(300, -20, 0)'), [1, 0, 0, 1]);
      expectRgba(parseColor('rgba(0, 0, 0, 5)'), [0, 0, 0, 1]);
      expectRgba(parseColor('rgba(0, 0, 0, -1)'), [0, 0, 0, 0]);
    });

    it('rejects malformed rgb()', () => {
      expect(parseColor('rgb(1, 2)')).toBeNull();
      expect(parseColor('rgb(1, 2, 3, 4, 5)')).toBeNull();
      expect(parseColor('rgb(a, b, c)')).toBeNull();
      expect(parseColor('rgb()')).toBeNull();
      expect(parseColor('rgb(0 0 0 / )')).toBeNull();
      expect(parseColor('rgb(0, , 0)')).toBeNull();
    });
  });

  describe('hsl()/hsla()', () => {
    it('parses primary hues at round numbers', () => {
      expectRgba(parseColor('hsl(0, 100%, 50%)'), [1, 0, 0, 1]); // red
      expectRgba(parseColor('hsl(120, 100%, 50%)'), [0, 1, 0, 1]); // lime
      expectRgba(parseColor('hsl(240, 100%, 50%)'), [0, 0, 1, 1]); // blue
    });

    it('parses space syntax, deg suffix, and alpha', () => {
      expectRgba(parseColor('hsl(240 100% 50%)'), [0, 0, 1, 1]);
      expectRgba(parseColor('hsl(120deg 100% 50%)'), [0, 1, 0, 1]);
      expectRgba(parseColor('hsla(0, 100%, 50%, 0.25)'), [1, 0, 0, 0.25]);
      expectRgba(parseColor('hsl(0 100% 50% / 50%)'), [1, 0, 0, 0.5]);
    });

    it('wraps hue outside [0, 360)', () => {
      expectRgba(parseColor('hsl(480, 100%, 50%)'), [0, 1, 0, 1]);
      expectRgba(parseColor('hsl(-240, 100%, 50%)'), [0, 1, 0, 1]);
    });

    it('handles achromatic and gray values', () => {
      expectRgba(parseColor('hsl(0, 0%, 0%)'), [0, 0, 0, 1]);
      expectRgba(parseColor('hsl(0, 0%, 100%)'), [1, 1, 1, 1]);
      expectRgba(parseColor('hsl(37, 0%, 50%)'), [0.5, 0.5, 0.5, 1]);
    });

    it('rejects malformed hsl()', () => {
      expect(parseColor('hsl(0, 100%)')).toBeNull();
      expect(parseColor('hsl(x, 100%, 50%)')).toBeNull();
      expect(parseColor('hsl(0, x%, 50%)')).toBeNull();
    });
  });

  describe('named colors', () => {
    it('parses the required named map', () => {
      expectRgba(parseColor('black'), [0, 0, 0, 1]);
      expectRgba(parseColor('white'), [1, 1, 1, 1]);
      expectRgba(parseColor('red'), [1, 0, 0, 1]);
      expectRgba(parseColor('green'), [0, 128 / 255, 0, 1]);
      expectRgba(parseColor('blue'), [0, 0, 1, 1]);
      expectRgba(parseColor('gray'), [128 / 255, 128 / 255, 128 / 255, 1]);
      expectRgba(parseColor('grey'), [128 / 255, 128 / 255, 128 / 255, 1]);
      expectRgba(parseColor('orange'), [1, 165 / 255, 0, 1]);
      expectRgba(parseColor('yellow'), [1, 1, 0, 1]);
      expectRgba(parseColor('purple'), [128 / 255, 0, 128 / 255, 1]);
      expectRgba(parseColor('cyan'), [0, 1, 1, 1]);
      expectRgba(parseColor('magenta'), [1, 0, 1, 1]);
      expectRgba(parseColor('steelblue'), [70 / 255, 130 / 255, 180 / 255, 1]);
      expectRgba(parseColor('tomato'), [1, 99 / 255, 71 / 255, 1]);
      expectRgba(parseColor('teal'), [0, 128 / 255, 128 / 255, 1]);
      expectRgba(parseColor('gold'), [1, 215 / 255, 0, 1]);
      expectRgba(parseColor('transparent'), [0, 0, 0, 0]);
    });

    it('is case-insensitive for names', () => {
      expectRgba(parseColor('GREY'), [128 / 255, 128 / 255, 128 / 255, 1]);
      expectRgba(parseColor(' SteelBlue '), [70 / 255, 130 / 255, 180 / 255, 1]);
    });
  });

  describe('invalid inputs', () => {
    it('returns null for unrecognized strings', () => {
      expect(parseColor('notacolor')).toBeNull();
      expect(parseColor('')).toBeNull();
      expect(parseColor('   ')).toBeNull();
      expect(parseColor('hwb(0 0% 0%)')).toBeNull();
      expect(parseColor('rgb 255 0 0')).toBeNull();
      expect(parseColor('color(srgb 1 0 0)')).toBeNull();
    });
  });

  describe('memoization', () => {
    it('returns the identical cached tuple for repeat parses', () => {
      const a = parseColor('rgb(12, 34, 56)');
      const b = parseColor('rgb(12, 34, 56)');
      expect(a).not.toBeNull();
      expect(b).toBe(a);
    });

    it('normalizes case/whitespace to the same cache entry', () => {
      const a = parseColor('rgb(12, 34, 57)');
      const b = parseColor('  RGB(12, 34, 57)  ');
      expect(b).toBe(a);
    });

    it('survives cache overflow (clears and keeps parsing correctly)', () => {
      for (let i = 0; i < 5000; i++) {
        const hex = `#${i.toString(16).padStart(6, '0')}`;
        expect(parseColor(hex)).not.toBeNull();
      }
      expectRgba(parseColor('#123456'), [18 / 255, 52 / 255, 86 / 255, 1]);
      expectRgba(parseColor('tomato'), [1, 99 / 255, 71 / 255, 1]);
    });
  });
});

interface Item {
  id: string;
  attrs: { color: string; size: number };
}

function makeItems(n: number): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < n; i++) {
    items.push({ id: `n${i}`, attrs: { color: i % 2 === 0 ? 'red' : 'blue', size: i } });
  }
  return items;
}

describe('projectColors', () => {
  it('constant accessor fills 4 floats per item', () => {
    const items = makeItems(10);
    const { buffer, diagnostics } = projectColors(items, 'red');
    expect(buffer.length).toBe(40);
    expect(diagnostics).toEqual([]);
    for (let i = 0; i < 10; i++) {
      expect(buffer[i * 4]).toBeCloseTo(1);
      expect(buffer[i * 4 + 1]).toBeCloseTo(0);
      expect(buffer[i * 4 + 2]).toBeCloseTo(0);
      expect(buffer[i * 4 + 3]).toBeCloseTo(1);
    }
  });

  it('function accessor projects per item', () => {
    const items = makeItems(6);
    const { buffer, diagnostics } = projectColors(items, (it) => it.attrs.color);
    expect(buffer.length).toBe(24);
    expect(diagnostics).toEqual([]);
    for (let i = 0; i < 6; i++) {
      const [r, g, b, a] = [buffer[i * 4], buffer[i * 4 + 1], buffer[i * 4 + 2], buffer[i * 4 + 3]];
      if (i % 2 === 0) {
        expect([r, g, b, a]).toEqual([1, 0, 0, 1]); // red
      } else {
        expect([r, g, b, a]).toEqual([0, 0, 1, 1]); // blue
      }
    }
  });

  it('unparseable constant falls back with one aggregated diagnostic', () => {
    const items = makeItems(5);
    const { buffer, diagnostics } = projectColors(items, 'definitely-not-a-color');
    expect(diagnostics).toHaveLength(1);
    const d = diagnostics[0]!;
    expect(d.code).toBe('accessor-error');
    expect(d.severity).toBe('warning');
    expect(d.count).toBe(5);
    expect(d.sampleIds.length).toBeLessThanOrEqual(DIAGNOSTIC_SAMPLE_CAP);
    expect(d.sampleIds[0]).toBe('n0');
    for (let i = 0; i < 5; i++) {
      expect(buffer[i * 4]).toBeCloseTo(0.66);
      expect(buffer[i * 4 + 1]).toBeCloseTo(0.66);
      expect(buffer[i * 4 + 2]).toBeCloseTo(0.66);
      expect(buffer[i * 4 + 3]).toBe(1);
    }
  });

  it('1000 throwing items produce exactly one diagnostic with capped samples', () => {
    const items = makeItems(1000);
    const { buffer, diagnostics } = projectColors(items, () => {
      throw new Error('boom');
    });
    expect(diagnostics).toHaveLength(1);
    const d = diagnostics[0]!;
    expect(d.code).toBe('accessor-error');
    expect(d.severity).toBe('warning');
    expect(d.count).toBe(1000);
    expect(d.sampleIds).toHaveLength(DIAGNOSTIC_SAMPLE_CAP);
    expect(d.sampleIds).toEqual(items.slice(0, DIAGNOSTIC_SAMPLE_CAP).map((it) => it.id));
    // Every slot holds the default fallback — no NaN anywhere.
    for (let i = 0; i < buffer.length; i++) {
      expect(Number.isFinite(buffer[i])).toBe(true);
    }
    expect(buffer[0]).toBeCloseTo(0.66);
    expect(buffer[3]).toBe(1);
  });

  it('mixed good/bad results count only the bad ones', () => {
    const items = makeItems(10);
    const { diagnostics } = projectColors(items, (it) =>
      Number(it.id.slice(1)) < 3 ? 'nope' : 'gold',
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.count).toBe(3);
    expect(diagnostics[0]!.sampleIds).toEqual(['n0', 'n1', 'n2']);
  });

  it('uses the item index as sample id when there is no string id', () => {
    const items = [{ v: 'x' }, { v: 'y' }] as const;
    const { diagnostics } = projectColors(items, (it) => it.v);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.sampleIds).toEqual(['0', '1']);
  });

  it('honors a custom fallback', () => {
    const items = makeItems(2);
    const { buffer } = projectColors(items, 'nope', [0.1, 0.2, 0.3, 0.4]);
    expect(buffer[0]).toBeCloseTo(0.1);
    expect(buffer[1]).toBeCloseTo(0.2);
    expect(buffer[2]).toBeCloseTo(0.3);
    expect(buffer[3]).toBeCloseTo(0.4);
  });

  it('never writes NaN even when the accessor returns runtime junk', () => {
    const junk = [null, undefined, 42, {}, [], NaN, 'nope', '#zzz'] as unknown[];
    const items = makeItems(200);
    const { buffer } = projectColors(items, (it) => junk[Number(it.id.slice(1)) % junk.length] as string);
    for (let i = 0; i < buffer.length; i++) {
      expect(Number.isFinite(buffer[i])).toBe(true);
    }
  });

  it('empty items yield an empty buffer and no diagnostics', () => {
    const good = projectColors([], 'red');
    expect(good.buffer.length).toBe(0);
    expect(good.diagnostics).toEqual([]);
    const bad = projectColors([], 'nope');
    expect(bad.buffer.length).toBe(0);
    expect(bad.diagnostics).toEqual([]);
  });
});

describe('projectSizes', () => {
  it('constant accessor fills 1 float per item', () => {
    const items = makeItems(8);
    const { buffer, diagnostics } = projectSizes(items, 7);
    expect(buffer.length).toBe(8);
    expect(diagnostics).toEqual([]);
    for (let i = 0; i < 8; i++) expect(buffer[i]).toBe(7);
  });

  it('function accessor projects per item', () => {
    const items = makeItems(5);
    const { buffer, diagnostics } = projectSizes(items, (it) => it.attrs.size * 2);
    expect(diagnostics).toEqual([]);
    expect(Array.from(buffer)).toEqual([0, 2, 4, 6, 8]);
  });

  it('coerces NaN/Infinity/negative to the fallback with one diagnostic', () => {
    const items = makeItems(4);
    const bad = [NaN, Infinity, -Infinity, -5];
    const { buffer, diagnostics } = projectSizes(items, (it) => bad[Number(it.id.slice(1))]!);
    expect(Array.from(buffer)).toEqual([4, 4, 4, 4]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.code).toBe('accessor-error');
    expect(diagnostics[0]!.severity).toBe('warning');
    expect(diagnostics[0]!.count).toBe(4);
    expect(diagnostics[0]!.sampleIds).toEqual(['n0', 'n1', 'n2', 'n3']);
  });

  it('throwing accessor aggregates into a single capped diagnostic', () => {
    const items = makeItems(1000);
    const { buffer, diagnostics } = projectSizes(items, () => {
      throw new Error('boom');
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.count).toBe(1000);
    expect(diagnostics[0]!.sampleIds).toHaveLength(DIAGNOSTIC_SAMPLE_CAP);
    for (let i = 0; i < buffer.length; i++) expect(buffer[i]).toBe(4);
  });

  it('invalid constant fills fallback with an aggregated diagnostic', () => {
    const items = makeItems(3);
    const { buffer, diagnostics } = projectSizes(items, NaN);
    expect(Array.from(buffer)).toEqual([4, 4, 4]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.count).toBe(3);
  });

  it('honors a custom fallback size', () => {
    const items = makeItems(2);
    const { buffer } = projectSizes(items, () => NaN, 9);
    expect(Array.from(buffer)).toEqual([9, 9]);
  });

  it('sanitizes a non-finite fallback so NaN still never enters the buffer', () => {
    const items = makeItems(2);
    const { buffer } = projectSizes(items, () => NaN, NaN);
    expect(Array.from(buffer)).toEqual([4, 4]);
  });

  it('property: random junk accessor outputs never produce NaN in the buffer', () => {
    const junk = [NaN, Infinity, -Infinity, -1, -0.001, 'not-a-number', undefined, null, {}, 3, 0, 12.5];
    const items = makeItems(500);
    const { buffer } = projectSizes(
      items,
      (it) => junk[(Number(it.id.slice(1)) * 7) % junk.length] as number,
    );
    expect(buffer.length).toBe(500);
    for (let i = 0; i < buffer.length; i++) {
      const v = buffer[i]!;
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('zero is a valid size, not coerced', () => {
    const items = makeItems(1);
    const { buffer, diagnostics } = projectSizes(items, () => 0);
    expect(buffer[0]).toBe(0);
    expect(diagnostics).toEqual([]);
  });

  it('empty items yield an empty buffer and no diagnostics', () => {
    const { buffer, diagnostics } = projectSizes([], NaN);
    expect(buffer.length).toBe(0);
    expect(diagnostics).toEqual([]);
  });
});
