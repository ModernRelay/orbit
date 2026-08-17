/**
 * Data + search smoke for the v0.9 surface.
 *
 * Drives the packaged <GraphSearch>, the <GraphMinimap>, the
 * <GraphTooltip>, and the CSV prepared-data lane through the demo
 * app, asserting DOM status text and data attributes only:
 *
 * - typing lists seeded generator labels; Enter routes through
 * `activateSearchResult` → focusNode (the zoom readout changes);
 * - a host-filtered target activates to 'unavailable/filtered', surfaced by
 * the demo's status-bar `search-unavailable` line (the result
 * contract: search NEVER mutates scope/filters itself);
 * - the minimap rasterizes (the demo declares seeded node positions — the
 * documented v0.9 CPU-fallback scene source) and a corner click issues a
 * REAL `setViewport` pan, asserted via the status bar's data-viewport-x/y;
 * - hovering a node (grid hunt around the center — the same strategy as the
 * ingestion spec's right-click, hit-testing exact centers is flaky) shows
 * the hover card with label + attr rows;
 * - `setInputFiles` on the CSV panel's hidden input feeds a 50-row edges
 * fixture through `prepareGraphData` (deriveNodes) — the header counts
 * swap to the derived 51/50 and the summaries line renders.
 *
 * CI note (repo pattern): the force simulation is paused before interaction
 * phases — cosmos free-runs its rAF while data is present and on
 * CI's software rasterizer that can starve Playwright's input events.
 */

import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const READY_DOT = '[data-testid="status-dot"][title="ready"]';
const ZOOM_VALUE = '[data-testid="zoom-value"]';
const VISIBLE_NODES = '[data-testid="visible-nodes"]';
const SEARCH_INPUT = '[data-orbit-search-input]';
const SEARCH_OPTION = '[data-orbit-search-result]';
const SEARCH_LABEL = '[data-orbit-search-result-label]';
const SEARCH_SCORE = '[data-orbit-search-result-score]';
const SEARCH_UNAVAILABLE = '[data-testid="search-unavailable"]';
const MINIMAP_CANVAS = '[data-orbit-minimap-canvas]';
const MINIMAP_RECT = '[data-orbit-minimap-viewport]';
const TOOLTIP = '[data-orbit-tooltip]';
const TOOLTIP_LABEL = '[data-orbit-tooltip-label]';
const SIM_BUTTON = '[data-orbit-toolbar-button="simulation"]';

async function gotoReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  // The status bar renders '—' until the first viewport event lands.
  await expect(page.locator(ZOOM_VALUE)).toHaveText(/×/, { timeout: 15_000 });
}

/** Parses the '×1.23'-formatted zoom readout from the status bar. */
async function zoomText(page: Page): Promise<string> {
  return (await page.locator(ZOOM_VALUE).textContent()) ?? '';
}

/** Pauses the simulation through the toolbar toggle (no-op when settled). */
async function pauseSimulation(page: Page): Promise<void> {
  const sim = page.locator(SIM_BUTTON);
  if ((await sim.getAttribute('aria-pressed')) === 'true') {
    await sim.click();
    await expect(sim).toHaveAttribute('aria-pressed', 'false');
  }
}

test('search: results list, Enter focuses, a filtered result surfaces its reason', async ({
  page,
}) => {
  await gotoReady(page);
  await pauseSimulation(page);

  // --- type → debounced instance.search → result list from store.search ---
  const input = page.locator(SEARCH_INPUT);
  await expect(input).toBeVisible(); // search section is open by default
  await input.fill('bravo-000');
  const options = page.locator(SEARCH_OPTION);
  await expect(options.first()).toBeVisible({ timeout: 10_000 });
  // Seeded generator labels ('bravo-0001'-style), score rendered when present
  // (the local service always scores).
  await expect(page.locator(SEARCH_LABEL).first()).toHaveText(/^bravo-\d{4}$/);
  await expect(page.locator(SEARCH_SCORE).first()).toBeVisible();

  // --- Enter activates the first result: select-and-fly,
  // the listbox closes, and the camera move shows up in the zoom readout ---
  const zoomBefore = await zoomText(page);
  await input.press('Enter');
  await expect(options).toHaveCount(0);
  await expect
    .poll(() => zoomText(page), {
      message: 'activating a search result should fly the camera',
      timeout: 10_000,
    })
    .not.toBe(zoomBefore);
  await expect(page.locator(SEARCH_UNAVAILABLE)).toHaveText('—');

  // --- filter hides cluster 0 (alpha); its nodes stay searchable (the
  // service scans the accepted model) but activation reports 'filtered' ---
  await page.getByTestId('cluster-check-0').uncheck();
  await expect(page.locator(VISIBLE_NODES)).toHaveText('2,500', { timeout: 10_000 });

  await input.fill('alpha-0000'); // node n0, cluster 0 — now mask-hidden
  await expect(options.first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(SEARCH_LABEL).first()).toHaveText('alpha-0000');
  await input.press('Enter');
  // The demo's <Graph onSearchResultUnavailable> writes the status-bar line.
  await expect(page.locator(SEARCH_UNAVAILABLE)).toHaveText('alpha-0000: filtered', {
    timeout: 10_000,
  });
  // Unavailable ≠ focused: the listbox stays open for another pick.
  await expect(options.first()).toBeVisible();

  // Escape clears the input, the listbox, and the shared store slice.
  await input.press('Escape');
  await expect(input).toHaveValue('');
  await expect(options).toHaveCount(0);
});

test('minimap: canvas rasterizes and a corner click pans the real viewport', async ({
  page,
}) => {
  await gotoReady(page);
  await pauseSimulation(page);

  const canvas = page.locator(MINIMAP_CANVAS);
  await expect(canvas).toBeVisible();
  // The viewport RECTANGLE only displays once a frame has rasterized (the
  // demo's seeded declared positions are the v0.9 CPU-fallback scene source)
  // AND the store has a live viewport — so its visibility proves the blit.
  await expect(page.locator(MINIMAP_RECT)).toBeVisible({ timeout: 10_000 });

  const zoom = page.locator(ZOOM_VALUE);
  const xBefore = await zoom.getAttribute('data-viewport-x');
  const yBefore = await zoom.getAttribute('data-viewport-y');
  const zoomBefore = await zoomText(page);
  expect(xBefore).toBeTruthy();

  // A click near the thumbnail corner maps through minimapToWorld to a world
  // point far from the fitted center → a REAL setViewport({x, y}) pan.
  await canvas.click({ position: { x: 18, y: 18 } });
  await expect
    .poll(async () => {
      const x = await zoom.getAttribute('data-viewport-x');
      const y = await zoom.getAttribute('data-viewport-y');
      return x !== xBefore || y !== yBefore;
    }, { message: 'a minimap click should pan the camera (viewport x/y change)', timeout: 10_000 })
    .toBe(true);
  // Pan only: the zoom level is preserved by setViewport({x, y}).
  expect(await zoomText(page)).toBe(zoomBefore);
});

test('tooltip: hovering a node shows the hover card with label and attr rows', async ({
  page,
}) => {
  await gotoReady(page);
  await pauseSimulation(page);

  // Grid-hunt a hover hit around the viewport center (same strategy as the
  // ingestion spec's right-click hunt — exact node centers are flaky). The
  // mouse STAYS on the hit, so the 150ms delay lane promotes it to a card.
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('viewport must be set by the config');
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const offsets = [0, -18, 18, -36, 36, -54, 54, -76, 76, -100, 100, -128, 128];
  let hoverText: string | null = null;
  outer: for (const dy of offsets) {
    for (const dx of offsets) {
      await page.mouse.move(cx + dx, cy + dy);
      await page.waitForTimeout(100);
      const text = (await page.getByTestId('hover-label').textContent()) ?? '';
      if (/^[a-z0-9]+-\d{4}$/.test(text)) {
        hoverText = text;
        break outer;
      }
    }
  }
  expect(hoverText, 'the hover hunt should land on a node').not.toBeNull();

  const tooltip = page.locator(TOOLTIP);
  await expect(tooltip).toBeVisible({ timeout: 5_000 });
  // Default card: the node's `label` attr as the title (same text the status
  // bar shows) plus attr rows — TEXT NODES only.
  await expect(tooltip.locator(TOOLTIP_LABEL)).toHaveText(hoverText!);
  await expect(tooltip.locator('[data-orbit-tooltip-attr="cluster"]')).toBeVisible();

  // Moving off every node clears the hover — the card unmounts immediately.
  await page.mouse.move(8, viewport.height - 8);
  await expect
    .poll(async () => (await page.getByTestId('hover-label').textContent()) ?? '', {
      timeout: 10_000,
    })
    .toBe('—');
  await expect(tooltip).toHaveCount(0);
});

test('csv drop: a 50-row edges fixture derives nodes and swaps the dataset', async ({
  page,
}, testInfo) => {
  // 50 edge rows over a c0→c1→…→c50 chain → 51 derived nodes; the numeric
  // `weight` column becomes an edge attr with a column summary.
  const rows = ['source,target,weight'];
  for (let i = 0; i < 50; i++) rows.push(`c${i},c${i + 1},${i % 7}`);
  const fixture = testInfo.outputPath('edges.csv');
  writeFileSync(fixture, `${rows.join('\n')}\n`, 'utf8');

  await gotoReady(page);
  await expect(page.getByTestId('node-count')).toHaveText('3,000'); // declarative base

  // The drop-zone's hidden input is the testability seam for DnD.
  await page.setInputFiles('[data-testid="csv-file-input"]', fixture);

  // prepared snapshot applied on a fresh instance (key remount) → new counts.
  await expect(page.getByTestId('node-count')).toHaveText('51', { timeout: 20_000 });
  await expect(page.getByTestId('edge-count')).toHaveText('50');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });

  // Summaries panel line: counts + the weight column's summary fragment.
  const summary = page.getByTestId('csv-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('51 nodes');
  await expect(summary).toContainText('50 edges');
  await expect(summary).toContainText('weight');
  await expect(page.getByTestId('csv-error')).toHaveCount(0);

  // The CSV dataset is searchable by id (derived nodes carry no attrs, so
  // the index is id-only here).
  await pauseSimulation(page);
  await page.locator(SEARCH_INPUT).fill('c17');
  await expect(page.locator(SEARCH_OPTION).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(SEARCH_LABEL).first()).toHaveText(/^c17/);
});

test('a newer data-mode choice supersedes an in-flight CSV preparation', async ({
  page,
}, testInfo) => {
  // Make the otherwise-small fixture deterministically asynchronous. Orbit's
  // CSV lane consumes File.stream(), so delaying its first chunk leaves time
  // for the user to choose another mode before preparation resolves.
  await page.addInitScript(() => {
    const state = window as typeof window & { __orbitCsvStreamFinished?: boolean };
    state.__orbitCsvStreamFinished = false;
    const originalStream = Blob.prototype.stream;
    Blob.prototype.stream = function (this: Blob): ReadableStream<Uint8Array> {
      const original = originalStream.call(this);
      // Do not delay unrelated Blob consumers used while the app boots.
      if (!(this instanceof File) || this.name !== 'superseded.csv') return original;
      const reader = original.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 500);
          });
          const next = await reader.read();
          if (next.done) {
            state.__orbitCsvStreamFinished = true;
            controller.close();
          } else controller.enqueue(next.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
    };
  });

  const fixture = testInfo.outputPath('superseded.csv');
  writeFileSync(fixture, 'source,target,weight\na,b,1\nb,c,2\n', 'utf8');
  await gotoReady(page);

  await page.setInputFiles('[data-testid="csv-file-input"]', fixture);
  await page.getByTestId('semantic-mode').click();
  await expect(page.getByTestId('m5-panel')).toBeVisible({ timeout: 15_000 });

  // Wait for EOF rather than a wall-clock approximation, then give the
  // preparation promise and React commit a chance to drain. Its completion
  // must not replace the newer semantic mode or publish a CSV summary.
  await page.waitForFunction(
    () =>
      (window as typeof window & { __orbitCsvStreamFinished?: boolean })
        .__orbitCsvStreamFinished === true,
  );
  await page.waitForTimeout(250);
  await expect(page.getByTestId('m5-panel')).toBeVisible();
  await expect(page.getByTestId('csv-summary')).toHaveCount(0);
});
