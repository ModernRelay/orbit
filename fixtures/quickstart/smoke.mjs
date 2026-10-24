import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'MutationObserver']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// React DOM must load after the DOM exists, so its event system is active.
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { FakeEngine } = await import('@modernrelay/orbit-core/testing');
const { CosmosEngine } = await import('@modernrelay/orbit-engine-cosmos');
const { default: App, createEngine } = await import('./App.js');

// Resolve and construct the real public adapter before using the WebGL-free seam.
const cosmos = await createEngine();
assert.ok(cosmos instanceof CosmosEngine);
cosmos.destroy();

const engine = new FakeEngine();
const root = createRoot(document.getElementById('root'));
try {
  await act(async () => root.render(createElement(App, { engine: () => engine })));
  assert.equal(engine.lastStructure?.pointCount, 3, 'the documented graph reaches the engine');
  assert.equal(engine.lastStructure?.links.length, 4, 'two edges reach the engine');

  // Exercise selection intents and the host's controlled prop round-trip.
  await act(async () => engine.injectPointClick(0));
  assert.match(document.querySelector('p[role="status"]').textContent, /Selected: ada/);
  assert.deepEqual(Array.from(engine.selectedIndices ?? []), [0]);

  const search = document.querySelector('[role="combobox"]');
  assert.ok(search, 'the packaged search component is mounted inside Graph context');
  await act(async () => {
    // Use the native setter so React observes an actual user edit.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, 'Grace');
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  // The documented component uses the public default 200 ms debounce.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
  const option = document.querySelector('[role="option"]');
  assert.ok(option?.textContent.includes('Grace'), 'search indexes the declared label attribute');
  await act(async () => {
    search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  assert.match(document.querySelector('p[role="status"]').textContent, /Selected: grace/);
  assert.deepEqual(Array.from(engine.selectedIndices ?? []), [1]);

  await act(async () => document.querySelector('button').click());
  assert.match(document.querySelector('p[role="status"]').textContent, /Selected: none/);
  assert.deepEqual(Array.from(engine.selectedIndices ?? []), []);
  assert.equal(document.querySelector('[role="alert"]'), null);
} finally {
  await act(async () => root.unmount());
  dom.window.close();
}
assert.ok(engine.destroyed, 'unmount releases the engine');
console.log('quickstart: mount, click, search, controlled selection, clear, and teardown passed');
