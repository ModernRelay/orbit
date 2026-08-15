/**
 * security fixture — the REUSABLE script-payload-label dataset.
 *
 * Every attr-derived string orbit itself puts into the DOM (labels, context
 * menu text, navigator items, live-region announcements, tooltips, table
 * cells) must render as a TEXT NODE — never via innerHTML. This fixture is
 * the shared hostile dataset those
 * assertions run against: node/edge attrs carry script tags, event-handler
 * injections, `javascript:` URLs, pre-escaped HTML entities, a CDATA
 * terminator, unicode bidi controls, and CSV formula prefixes.
 *
 * Framework-free: core types only (type-only relative import, erased at
 * runtime), no test-runner imports — `expectInert` throws plain Errors so any
 * suite (vitest core/react today, Playwright later) can consume it.
 *
 * Extend this fixture rather than recreating it: CSV/SVG export
 * neutralization assertions should use this same dataset. The CSV formula
 * prefixes below exist for that purpose; exports must neutralize
 * them (e.g. quote/prefix) rather than emit live spreadsheet formulas.
 */

import type { GraphSnapshot } from '../../packages/core/src/types';

/**
 * The global property name the executable payloads would define if any of
 * them ever ran. Tests assert `globalThis[PAYLOAD_SENTINEL]` stays undefined.
 */
export const PAYLOAD_SENTINEL = '__xss';

/** Hostile strings by attack class. Object order is accepted-base node order. */
export const SCRIPT_PAYLOADS = {
  /** Classic script-tag injection. */
  scriptTag: `<script>window.${PAYLOAD_SENTINEL}=1</script>`,
  /** Markup smuggling an inline event handler. */
  imgOnerror: `<img src=x onerror=window.${PAYLOAD_SENTINEL}=1>`,
  /** URL-scheme injection (must never land in a live href/src). */
  javascriptUrl: 'javascript:alert(1)',
  /** Pre-escaped entities — must NOT be double-decoded into live markup. */
  htmlEntities: '&lt;script&gt;&amp;quot;entities&amp;#39;&gt;',
  /** CDATA terminator for XML/SVG export contexts. */
  cdataTerminator: ']]>',
  /** Unicode bidi controls (RLO spoofing + isolates + directional marks). */
  bidiControls: '\u202Egnp.exe\u202C \u2066isolated\u2069 \u200F\u200E',
  /** CSV formula prefixes. */
  csvFormulaEquals: '=cmd',
  csvFormulaPlus: '+1',
  csvFormulaMinus: '-1',
  csvFormulaAt: '@x',
} as const;

export type PayloadKind = keyof typeof SCRIPT_PAYLOADS;

/** Every hostile string in the fixture, in node order. */
export const ALL_PAYLOADS: readonly string[] = Object.values(SCRIPT_PAYLOADS);

export interface PayloadNodeAttrs {
  /** Default label-lane text (`attrs.label ?? id`) — the hostile string. */
  label: string;
  /** Which attack class this node carries. */
  kind: PayloadKind;
  /** Second attr surface (inspector/table/tooltip cells render attr values). */
  note: string;
}

export interface PayloadEdgeAttrs {
  label: string;
  note: string;
}

const KINDS = Object.keys(SCRIPT_PAYLOADS) as readonly PayloadKind[];

/**
 * One node per attack class (ids `payload-<kind>`, safe for CSS attribute
 * selectors), chained by edges whose attrs are hostile too. Node index 0 (the
 * accepted-base first node) carries the script-tag payload — convenient for
 * engine-index-based event injection in tests.
 */
export const payloadDataset: GraphSnapshot<PayloadNodeAttrs, PayloadEdgeAttrs> = {
  datasetKey: 'security-payload-fixture',
  sourceRevision: 1,
  nodes: KINDS.map((kind) => ({
    id: `payload-${kind}`,
    attrs: {
      label: SCRIPT_PAYLOADS[kind],
      kind,
      note: `${SCRIPT_PAYLOADS[kind]} ${SCRIPT_PAYLOADS.javascriptUrl}`,
    },
  })),
  edges: KINDS.slice(1).map((kind, i) => ({
    source: `payload-${KINDS[i]!}`,
    target: `payload-${kind}`,
    attrs: {
      label: SCRIPT_PAYLOADS[kind],
      note: SCRIPT_PAYLOADS.imgOnerror,
    },
  })),
};

function fail(message: string): never {
  throw new Error(`security fixture: ${message}`);
}

/**
 * Assert a rendered DOM subtree treated every fixture payload as inert text:
 *
 * 1. no `<script>` element exists (the script-tag payload never parsed),
 * 2. no `<img src="x">` and no element with an inline `onerror` attribute
 * (the event-handler payload never parsed),
 * 3. no live `href`/`src`/`xlink:href` carries a `javascript:` URL,
 * 4. the executable payloads never ran: `globalThis[PAYLOAD_SENTINEL]` is
 * undefined.
 *
 * Throws a descriptive Error on the first violation (framework-free — works
 * under any test runner). Pass the widest container available (e.g.
 * `document.body`) so portaled overlays (menus, tooltips) are covered.
 */
export function expectInert(container: ParentNode): void {
  if (container.querySelector('script') !== null) {
    fail('a <script> element was created from an attr string');
  }
  if (container.querySelector('img[src="x"]') !== null) {
    fail('the <img src=x onerror=…> payload was parsed into a live element');
  }
  if (container.querySelector('[onerror]') !== null) {
    fail('an element carries an inline onerror attribute derived from attr strings');
  }
  const urlCarriers = container.querySelectorAll('[href], [src], [xlink\\:href]');
  for (const el of Array.from(urlCarriers)) {
    for (const attr of ['href', 'src', 'xlink:href']) {
      const value = el.getAttribute(attr);
      if (value !== null && value.trim().toLowerCase().startsWith('javascript:')) {
        fail(`a javascript: URL reached a live ${attr} attribute`);
      }
    }
  }
  if ((globalThis as Record<string, unknown>)[PAYLOAD_SENTINEL] !== undefined) {
    fail(`a payload executed: globalThis.${PAYLOAD_SENTINEL} is defined`);
  }
}
