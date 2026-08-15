#!/usr/bin/env node
/**
 * Engine-independence fixture: the SVG exporter must run under plain
 * Node — no DOM, no engine, no browser globals — because the post-v1 server
 * snapshot path imports it in exactly this environment.
 *
 * Imports the BUILT dist module (what npm consumers get, not the TS source),
 * renders a scene with a hostile label, and asserts well-formedness. Any
 * accidental DOM/engine dependency crashes the import or the call, failing
 * the package job — the requirement stays enforced, not aspirational.
 */

import assert from 'node:assert/strict';

// Guard: prove the environment really is DOM-free before trusting the run.
assert.equal(typeof globalThis.document, 'undefined', 'fixture must run without a DOM');
assert.equal(typeof globalThis.HTMLCanvasElement, 'undefined', 'fixture must run without canvas');

const { renderSvg, SvgBudgetError } = await import(
  '../packages/core/dist/index.js'
);

const svg = renderSvg({
  width: 640,
  height: 480,
  background: '#0b0e14',
  nodes: [
    { x: 10, y: 20, r: 4, color: '#7aa2f7' },
    { x: 30, y: 40, r: 6, color: 'rgba(158,206,106,0.9)' },
  ],
  edges: [{ x1: 10, y1: 20, x2: 30, y2: 40, color: 'rgba(255,255,255,0.2)', width: 1 }],
  labels: [{ x: 12, y: 18, text: '<script>alert("x")</script>', color: '#e6e9f0' }],
});

assert.ok(svg.startsWith('<svg '), 'output must be an SVG document');
assert.ok(svg.endsWith('</svg>'), 'document must close');
assert.equal((svg.match(/<circle /g) ?? []).length, 2, 'two nodes render');
assert.ok(!svg.includes('<script'), 'hostile label must be escaped');
assert.ok(svg.includes('&lt;script&gt;'), 'escaped form must be present');

// The budget throws typed under Node too.
let threw = false;
try {
  renderSvg({
    width: 1,
    height: 1,
    background: '#000',
    nodes: Array.from({ length: 51_000 }, () => ({ x: 0, y: 0, r: 1, color: '#fff' })),
    edges: [],
  });
} catch (e) {
  threw = e instanceof SvgBudgetError;
}
assert.ok(threw, 'budget overflow must throw SvgBudgetError');

console.log('svg-node-fixture: engine-free render OK (M7)');
