/**
 * projection (v0.1 subset): styling accessors → engine-ready typed buffers.
 *
 * Pure and DOM-free. Color parsing covers the CSS subset orbit documents
 * (hex, rgb/rgba, hsl/hsla, small named map); anything else is a
 * caller error surfaced as a batched 'accessor-error' diagnostic, never a
 * throw and never a NaN in a GPU buffer.
 */

import { DIAGNOSTIC_SAMPLE_CAP } from './types';
import type { Accessor, GraphDiagnostic } from './types';

export type RGBA = [number, number, number, number];

const DEFAULT_COLOR_FALLBACK: RGBA = [0.66, 0.66, 0.66, 1];
const DEFAULT_SIZE_FALLBACK = 4;
const COLOR_CACHE_CAP = 4096;

// ---------------------------------------------------------------------------
// parseColor
// ---------------------------------------------------------------------------

/** Values are shared tuples (also handed out by parseColor) — never mutate. */
const NAMED_COLORS: Record<string, RGBA> = {
  black: [0, 0, 0, 1],
  white: [1, 1, 1, 1],
  red: [1, 0, 0, 1],
  green: [0, 128 / 255, 0, 1],
  blue: [0, 0, 1, 1],
  gray: [128 / 255, 128 / 255, 128 / 255, 1],
  grey: [128 / 255, 128 / 255, 128 / 255, 1],
  orange: [1, 165 / 255, 0, 1],
  yellow: [1, 1, 0, 1],
  purple: [128 / 255, 0, 128 / 255, 1],
  cyan: [0, 1, 1, 1],
  magenta: [1, 0, 1, 1],
  lime: [0, 1, 0, 1],
  steelblue: [70 / 255, 130 / 255, 180 / 255, 1],
  tomato: [1, 99 / 255, 71 / 255, 1],
  teal: [0, 128 / 255, 128 / 255, 1],
  gold: [1, 215 / 255, 0, 1],
  transparent: [0, 0, 0, 0],
};

/** Successful parses only, keyed by the normalized (trim+lowercase) input. */
const colorCache = new Map<string, RGBA>();

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Strict finite-number parse; rejects '' (Number('') === 0) and junk. */
function num(token: string): number | null {
  if (token === '') return null;
  const v = Number(token);
  return Number.isFinite(v) ? v : null;
}

function parseHex(s: string): RGBA | null {
  const hex = s.slice(1);
  if (!/^[0-9a-f]{3,8}$/.test(hex)) return null;
  switch (hex.length) {
    case 3:
    case 4: {
      // #rgb → #rrggbb: each digit expands to d*17.
      const r = (parseInt(hex[0]!, 16) * 17) / 255;
      const g = (parseInt(hex[1]!, 16) * 17) / 255;
      const b = (parseInt(hex[2]!, 16) * 17) / 255;
      const a = hex.length === 4 ? (parseInt(hex[3]!, 16) * 17) / 255 : 1;
      return [r, g, b, a];
    }
    case 6:
    case 8: {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return [r, g, b, a];
    }
    default:
      return null; // 5 or 7 digits
  }
}

/**
 * Splits the inside of rgb/hsl parens into 3 channel tokens plus an
 * optional alpha token, accepting both the legacy comma syntax
 * (`r, g, b[, a]`) and the modern space syntax (`r g b[ / a]`).
 */
function splitArgs(inner: string): { channels: [string, string, string]; alpha: string | null } | null {
  const s = inner.trim();
  if (s === '') return null;
  if (s.includes(',')) {
    const parts = s.split(',').map((p) => p.trim());
    if (parts.some((p) => p === '')) return null;
    if (parts.length === 3) return { channels: parts as [string, string, string], alpha: null };
    if (parts.length === 4) return { channels: [parts[0]!, parts[1]!, parts[2]!], alpha: parts[3]! };
    return null;
  }
  const slash = s.split('/');
  if (slash.length > 2) return null;
  const channels = slash[0]!.trim().split(/\s+/);
  if (channels.length !== 3) return null;
  let alpha: string | null = null;
  if (slash.length === 2) {
    alpha = slash[1]!.trim();
    if (alpha === '') return null;
  }
  return { channels: channels as [string, string, string], alpha };
}

/** 0–255 number or percentage → [0,1], clamped like CSS. */
function parseRgbChannel(token: string): number | null {
  if (token.endsWith('%')) {
    const v = num(token.slice(0, -1));
    return v === null ? null : clamp01(v / 100);
  }
  const v = num(token);
  return v === null ? null : clamp01(v / 255);
}

/** Alpha: 0–1 number or percentage → [0,1], clamped. */
function parseAlpha(token: string): number | null {
  if (token.endsWith('%')) {
    const v = num(token.slice(0, -1));
    return v === null ? null : clamp01(v / 100);
  }
  const v = num(token);
  return v === null ? null : clamp01(v);
}

/** Hue in degrees (optional `deg` suffix); any finite value, wrapped later. */
function parseHue(token: string): number | null {
  return num(token.endsWith('deg') ? token.slice(0, -3) : token);
}

/** Saturation/lightness: percentage (or bare 0–100 number) → [0,1]. */
function parseSatLight(token: string): number | null {
  const v = num(token.endsWith('%') ? token.slice(0, -1) : token);
  return v === null ? null : clamp01(v / 100);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g] = [c, x];
  else if (hp < 2) [r, g] = [x, c];
  else if (hp < 3) [g, b] = [c, x];
  else if (hp < 4) [g, b] = [x, c];
  else if (hp < 5) [r, b] = [x, c];
  else [r, b] = [c, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

const FUNCTIONAL_RE = /^(rgb|rgba|hsl|hsla)\((.*)\)$/;

/** `key` is already trimmed and lowercased. */
function parseColorUncached(key: string): RGBA | null {
  if (key.startsWith('#')) return parseHex(key);
  const named = NAMED_COLORS[key];
  if (named !== undefined) return named;
  const m = FUNCTIONAL_RE.exec(key);
  if (m === null) return null;
  const args = splitArgs(m[2]!);
  if (args === null) return null;
  const alpha = args.alpha === null ? 1 : parseAlpha(args.alpha);
  if (alpha === null) return null;
  const [c0, c1, c2] = args.channels;
  if (m[1] === 'rgb' || m[1] === 'rgba') {
    const r = parseRgbChannel(c0);
    const g = parseRgbChannel(c1);
    const b = parseRgbChannel(c2);
    if (r === null || g === null || b === null) return null;
    return [r, g, b, alpha];
  }
  const h = parseHue(c0);
  const s = parseSatLight(c1);
  const l = parseSatLight(c2);
  if (h === null || s === null || l === null) return null;
  const [r, g, b] = hslToRgb(h, s, l);
  return [r, g, b, alpha];
}

/**
 * Pure, DOM-free CSS color parse → RGBA floats in [0,1], or null when the
 * string is not a recognized color. Successful parses are memoized (cache
 * capped at 4096 entries; cleared wholesale on overflow). The returned tuple
 * is shared across calls — treat it as immutable.
 */
export function parseColor(css: string): RGBA | null {
  if (typeof css !== 'string') return null; // runtime hygiene for untyped accessor output
  const key = css.trim().toLowerCase();
  if (key === '') return null;
  const hit = colorCache.get(key);
  if (hit !== undefined) return hit;
  const parsed = parseColorUncached(key);
  if (parsed !== null) {
    if (colorCache.size >= COLOR_CACHE_CAP) colorCache.clear();
    colorCache.set(key, parsed);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/** Sample id: the item's string `id` when present, else its index. */
function sampleIdOf(item: unknown, index: number): string {
  if (item !== null && typeof item === 'object') {
    const id = (item as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return String(index);
}

function accessorDiagnostic(count: number, total: number, channel: string, sampleIds: string[]): GraphDiagnostic {
  return {
    code: 'accessor-error',
    severity: 'warning',
    count,
    sampleIds,
    message: `${channel} accessor failed or produced an invalid value for ${count} of ${total} item(s); fallback applied.`,
  };
}

/** First min(cap, total) sample ids — used when a constant affects every item. */
function leadingSampleIds<T>(items: readonly T[]): string[] {
  const n = Math.min(items.length, DIAGNOSTIC_SAMPLE_CAP);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(sampleIdOf(items[i], i));
  return out;
}

// ---------------------------------------------------------------------------
// projectColors
// ---------------------------------------------------------------------------

export function projectColors<T>(
  items: readonly T[],
  accessor: Accessor<T, string>,
  fallback: [number, number, number, number] = DEFAULT_COLOR_FALLBACK,
): { buffer: Float32Array; diagnostics: GraphDiagnostic[] } {
  const n = items.length;
  const buffer = new Float32Array(n * 4);
  // A non-finite fallback would defeat the NaN-never-in-buffer guarantee.
  const fb: RGBA = fallback.every(Number.isFinite) ? (fallback as RGBA) : DEFAULT_COLOR_FALLBACK;
  const diagnostics: GraphDiagnostic[] = [];

  if (typeof accessor !== 'function') {
    // Constant path: parse once, fill.
    const parsed = parseColor(accessor);
    const c = parsed ?? fb;
    const [r, g, b, a] = c;
    for (let o = 0; o < buffer.length; o += 4) {
      buffer[o] = r;
      buffer[o + 1] = g;
      buffer[o + 2] = b;
      buffer[o + 3] = a;
    }
    if (parsed === null && n > 0) {
      diagnostics.push(accessorDiagnostic(n, n, 'color', leadingSampleIds(items)));
    }
    return { buffer, diagnostics };
  }

  const fn = accessor as (item: T) => string;
  const fb0 = fb[0];
  const fb1 = fb[1];
  const fb2 = fb[2];
  const fb3 = fb[3];
  let errorCount = 0;
  const samples: string[] = [];
  for (let i = 0; i < n; i++) {
    const item = items[i] as T;
    let rgba: RGBA | null;
    try {
      rgba = parseColor(fn(item));
    } catch {
      rgba = null;
    }
    const o = i * 4;
    if (rgba === null) {
      errorCount++;
      if (samples.length < DIAGNOSTIC_SAMPLE_CAP) samples.push(sampleIdOf(item, i));
      buffer[o] = fb0;
      buffer[o + 1] = fb1;
      buffer[o + 2] = fb2;
      buffer[o + 3] = fb3;
    } else {
      buffer[o] = rgba[0];
      buffer[o + 1] = rgba[1];
      buffer[o + 2] = rgba[2];
      buffer[o + 3] = rgba[3];
    }
  }
  if (errorCount > 0) diagnostics.push(accessorDiagnostic(errorCount, n, 'color', samples));
  return { buffer, diagnostics };
}

// ---------------------------------------------------------------------------
// projectSizes
// ---------------------------------------------------------------------------

export function projectSizes<T>(
  items: readonly T[],
  accessor: Accessor<T, number>,
  fallbackSize: number = DEFAULT_SIZE_FALLBACK,
): { buffer: Float32Array; diagnostics: GraphDiagnostic[] } {
  const n = items.length;
  const buffer = new Float32Array(n);
  // Sanitize the fallback itself so NaN can never enter the buffer through it.
  const fb = Number.isFinite(fallbackSize) && fallbackSize >= 0 ? fallbackSize : DEFAULT_SIZE_FALLBACK;
  const diagnostics: GraphDiagnostic[] = [];

  if (typeof accessor !== 'function') {
    const valid = typeof accessor === 'number' && Number.isFinite(accessor) && accessor >= 0;
    buffer.fill(valid ? accessor : fb);
    if (!valid && n > 0) {
      diagnostics.push(accessorDiagnostic(n, n, 'size', leadingSampleIds(items)));
    }
    return { buffer, diagnostics };
  }

  const fn = accessor as (item: T) => number;
  let errorCount = 0;
  const samples: string[] = [];
  for (let i = 0; i < n; i++) {
    const item = items[i] as T;
    let v: number;
    try {
      v = fn(item);
    } catch {
      v = NaN;
    }
    // typeof guard: untyped runtime data can smuggle strings past the types.
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      buffer[i] = v;
    } else {
      errorCount++;
      if (samples.length < DIAGNOSTIC_SAMPLE_CAP) samples.push(sampleIdOf(item, i));
      buffer[i] = fb;
    }
  }
  if (errorCount > 0) diagnostics.push(accessorDiagnostic(errorCount, n, 'size', samples));
  return { buffer, diagnostics };
}
