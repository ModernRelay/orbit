/**
 * SVG export — the engine-free pure module.
 *
 * ENGINE-INDEPENDENT BY CONSTRUCTION, not by discipline: positions and
 * projected styles come IN as a plain descriptor, vector markup goes OUT as a
 * string. No engine, no instance, no DOM — the post-v1 server snapshot path
 * reuses this verbatim under plain Node, and the test
 * suite runs it exactly that way. Keeping it engine-free is an M7
 * requirement, which is why it is a standalone module rather than instance
 * code that might one day be extracted.
 *
 * Output discipline:
 * - One element per node/edge/label, assembled OFF-DOM by chunked
 * array-join — O(elements), never a live DOM node per element.
 * - Every label and attribute string is XML-escaped (untrusted-content
 * rule in its XML form): a hostile label renders as literal text in every
 * downstream vector tool, never as markup.
 * - Bounded: above `maxElements` (default 50 000 — the practical ceiling for
 * downstream vector editors) rendering THROWS before assembling anything;
 * the instance wraps that into the typed `export-too-large` rejection, and
 * the raster-hybrid form (a PNG base layer plus a small vector overlay) is
 * the sanctioned way past it.
 */

// ---------------------------------------------------------------------------
// Scene descriptor — plain data, everything pre-projected by the caller.
// ---------------------------------------------------------------------------

export interface SvgSceneNode {
  x: number;
  y: number;
  /** Radius in output px (the caller halves its size-buffer diameter). */
  r: number;
  /** Any CSS color string (the caller projects RGBA buffers to rgba). */
  color: string;
}

export interface SvgSceneEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
}

export interface SvgSceneLabel {
  x: number;
  y: number;
  /** UNTRUSTED text — escaped here, never pre-escaped by callers (double
   * escaping is a rendering bug, missing escaping is an injection). */
  text: string;
  color: string;
  /** Font size in px. Default 11. */
  size?: number;
}

export interface SvgScene {
  width: number;
  height: number;
  background: string;
  nodes: readonly SvgSceneNode[];
  edges: readonly SvgSceneEdge[];
  labels?: readonly SvgSceneLabel[];
  /**
   * Raster-hybrid base layer: a data URI (typically the engine screenshot).
   * When present, `nodes` and `edges` are expected to be EMPTY — the raster
   * carries them — and only labels/overlay chrome emit as vectors.
   */
  rasterBase?: { href: string };
}

export interface RenderSvgOptions {
  /** Element budget across nodes+edges+labels. Default 50 000. */
  maxElements?: number;
}

export const SVG_MAX_ELEMENTS_DEFAULT = 50_000;

/** Thrown (not returned) on budget overflow — a pure module has no
 * diagnostics lane; the instance converts this into `export-too-large`. */
export class SvgBudgetError extends Error {
  constructor(
    readonly elementCount: number,
    readonly limit: number,
  ) {
    super(
      `SVG export of ${elementCount} elements exceeds the ${limit}-element budget — ` +
        `filter/isolate first, or use the raster-hybrid fallback`,
    );
    this.name = 'SvgBudgetError';
  }
}

// ---------------------------------------------------------------------------
// Escaping. Attribute AND text contexts use the same conservative set — the
// five XML-significant characters — so one helper serves both. Raw control
// characters (legal in JS strings, ILLEGAL in XML 1.0) drop rather than
// poisoning the whole document.
// ---------------------------------------------------------------------------

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(text: string): string {
  let out = '';
  for (const ch of text) {
    const escaped = XML_ESCAPES[ch];
    if (escaped !== undefined) {
      out += escaped;
      continue;
    }
    const code = ch.codePointAt(0)!;
    // XML 1.0 Char production: control chars other than tab/LF/CR are
    // unrepresentable even as entities; lone surrogates never reach here
    // because for..of iterates by code point (an unpaired surrogate becomes
    // U+FFFD at the string level, which is legal).
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    out += ch;
  }
  return out;
}

/** Numbers are caller-computed; NaN/Infinity would corrupt attributes, so
 * they render as 0 — a visibly wrong-but-parseable document beats an
 * unparseable one. */
function num(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '0';
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/**
 * Render a scene to an SVG document string. Pure: same input, same output,
 * byte for byte. Throws {@link SvgBudgetError} when the element budget is
 * exceeded — BEFORE assembling any markup.
 */
export function renderSvg(scene: SvgScene, opts?: RenderSvgOptions): string {
  const limit = opts?.maxElements ?? SVG_MAX_ELEMENTS_DEFAULT;
  const labelCount = scene.labels?.length ?? 0;
  const elementCount = scene.nodes.length + scene.edges.length + labelCount;
  if (elementCount > limit) throw new SvgBudgetError(elementCount, limit);

  // Chunked assembly: fixed-size flushes keep peak memory at
  // O(chunk + output) rather than O(2 × output) from repeated concat.
  const CHUNK = 4096;
  const chunks: string[] = [];
  let buffer: string[] = [];
  const push = (s: string): void => {
    buffer.push(s);
    if (buffer.length >= CHUNK) {
      chunks.push(buffer.join(''));
      buffer = [];
    }
  };

  push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(scene.width)}" ` +
      `height="${num(scene.height)}" viewBox="0 0 ${num(scene.width)} ${num(scene.height)}">`,
  );
  push(`<rect width="100%" height="100%" fill="${escapeXml(scene.background)}"/>`);

  if (scene.rasterBase !== undefined) {
    // Data URIs are caller-produced (canvas.toDataURL) but escaped anyway
    // defense in depth costs one pass.
    push(
      `<image href="${escapeXml(scene.rasterBase.href)}" x="0" y="0" ` +
        `width="${num(scene.width)}" height="${num(scene.height)}"/>`,
    );
  }

  // Edges under nodes, nodes under labels — the canvas z-order.
  for (const e of scene.edges) {
    push(
      `<line x1="${num(e.x1)}" y1="${num(e.y1)}" x2="${num(e.x2)}" y2="${num(e.y2)}" ` +
        `stroke="${escapeXml(e.color)}" stroke-width="${num(e.width)}"/>`,
    );
  }
  for (const n of scene.nodes) {
    push(`<circle cx="${num(n.x)}" cy="${num(n.y)}" r="${num(n.r)}" fill="${escapeXml(n.color)}"/>`);
  }
  if (scene.labels !== undefined) {
    for (const l of scene.labels) {
      push(
        `<text x="${num(l.x)}" y="${num(l.y)}" fill="${escapeXml(l.color)}" ` +
          `font-family="system-ui, sans-serif" font-size="${num(l.size ?? 11)}">` +
          `${escapeXml(l.text)}</text>`,
      );
    }
  }
  push('</svg>');

  if (buffer.length > 0) chunks.push(buffer.join(''));
  return chunks.join('');
}
