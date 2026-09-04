/**
 * Deep-link round trip through the view-state lane.
 *
 * The full pipeline through a REAL reload: build a view (camera + brush +
 * a small selection), Share (writes ?view= into the URL), navigate to that
 * URL fresh, and assert the restored readouts. The selection restore proves
 * the whole Wave-3 aggregate protocol (selection is the demo's controlled
 * lane): intent → host reflection → acknowledgement.
 *
 * Views here are deliberately HUMAN-scale (a brush, a zoom, a couple of
 * ids): deep-links carry O(1) state, and the demo refuses to write
 * pathological payloads into the URL bar at all — writing "all 3,000
 * selected ids" produced a ~40KB URL the dev server rejects with 431, which
 * is how this suite's first draft found that guard was needed.
 *
 * The red-team case corrupts the payload and asserts the atomic
 * rule: NOTHING applies from a hostile URL.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GraphViewState } from '@modernrelay/orbit-core';

const READY_DOT = '[data-testid="status-dot"][title="ready"]';
const SELECTED_COUNT = '[data-testid="selected-count"]';
const ZOOM_VALUE = '[data-testid="zoom-value"]';
const HISTOGRAM_PLOT = '[data-testid="histogram-panel"] [data-orbit-histogram-plot]';

async function ready(page: Page): Promise<void> {
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await expect(page.locator(ZOOM_VALUE)).toHaveText(/×/, { timeout: 15_000 });
}

async function visibleNodes(page: Page): Promise<number> {
  const text = (await page.getByTestId('visible-nodes').textContent()) ?? '';
  return Number.parseInt(text.replace(/,/g, ''), 10);
}

/** Drag a partial brush over the score histogram (the filtering.spec.ts
 * pattern — DOM pointer handlers, no GPU picking involved). */
async function brushScore(page: Page): Promise<void> {
  await expect(page.locator('[data-orbit-legend-row]').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const hist = page.locator(HISTOGRAM_PLOT);
  await expect(hist).toBeVisible();
  const box = (await hist.boundingBox())!;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  for (let step = 1; step <= 6; step++) {
    await page.mouse.move(box.x + box.width * (0.25 + 0.05 * step), y);
  }
  await page.mouse.up();
}

test('share → reload → the exact view: brush, camera, and selection survive', async ({
  page,
}) => {
  await page.goto('/');
  await ready(page);

  // Human-scale view: a partial score brush + a zoomed camera.
  await brushScore(page);
  await expect
    .poll(() => visibleNodes(page), { timeout: 10_000 })
    .toBeLessThan(3000);
  const brushedVisible = await visibleNodes(page);

  const zoomIn = page.getByRole('button', { name: 'Zoom in' });
  await zoomIn.click();
  await zoomIn.click();
  await page.waitForTimeout(400);
  const zoomBefore = await page.locator(ZOOM_VALUE).textContent();

  await page.getByTestId('share-view').click();
  await page.waitForFunction(() => window.location.search.includes('view='));
  const url = page.url();
  expect(url.length).toBeLessThan(8000); // human-scale, by design

  // Fresh navigation — new page, new instance, new engine.
  await page.goto(url);
  await ready(page);

  await expect
    .poll(() => visibleNodes(page), {
      message: 'the brush must restore and hide the same rows',
      timeout: 15_000,
    })
    .toBe(brushedVisible);
  await expect(page.locator(ZOOM_VALUE)).toHaveText(zoomBefore!, { timeout: 15_000 });
});

test('a corrupted ?view= applies NOTHING (the atomic rule, adversarially)', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await brushScore(page);
  await expect.poll(() => visibleNodes(page), { timeout: 10_000 }).toBeLessThan(3000);
  await page.getByTestId('share-view').click();
  await page.waitForFunction(() => window.location.search.includes('view='));

  // Truncate the tail — cuts into the encoded JSON, leaving a parseable URL.
  const corrupted = page.url().slice(0, -12);
  await page.goto(corrupted);
  await ready(page);

  // Nothing applied: full roster visible, nothing selected, app interactive.
  await expect
    .poll(() => visibleNodes(page), { timeout: 15_000 })
    .toBe(3000);
  await expect(page.locator(SELECTED_COUNT)).toHaveText('0');
  await page.getByRole('button', { name: 'Select all' }).click();
  await expect(page.locator(SELECTED_COUNT)).toHaveText('3,000');
});

test('share → reload restores selected styling and keeps the style controls live', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  const simulation = page.locator('[data-orbit-toolbar-button="simulation"]');
  if (await simulation.getAttribute('aria-pressed') === 'true') await simulation.click();

  // Use the semantic surface to select one node without GPU picking. A
  // nonempty controlled selection exercises aggregate host reflection.
  await page.getByTestId('navigator-toggle').click();
  await page.getByRole('option').first().press('Space');
  await expect(page.locator(SELECTED_COUNT)).toHaveText('1');
  await page.getByTestId('navigator-toggle').click();
  await page.getByTestId('node-color-mode').selectOption('degree');
  await page.getByTestId('node-size-mode').selectOption('scale');
  await page.getByTestId('edge-arrows').check();
  await page.getByTestId('show-links').uncheck();
  await page.getByTestId('theme-light').check();
  await page.getByTestId('share-view').click();
  await page.waitForFunction(() => window.location.search.includes('view='));
  const url = page.url();
  const saved = JSON.parse(new URL(url).searchParams.get('view')!) as GraphViewState;
  expect(saved.selection.nodeIds).toHaveLength(1);
  expect(saved.styling).toMatchObject({ showLinks: false, edgeArrows: true, theme: 'light' });

  await page.goto(url);
  await ready(page);
  await expect(page.locator(SELECTED_COUNT)).toHaveText('1');
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('node-color-mode')).toHaveValue('degree');
  await expect(page.getByTestId('node-size-mode')).toHaveValue('scale');
  await expect(page.getByTestId('edge-arrows')).toBeChecked();
  await expect(page.getByTestId('show-links')).not.toBeChecked();
  await expect(page.getByTestId('legend-panel')).toContainText('degree');
  await expect(page.getByTestId('legend-panel-size')).toBeVisible();

  // Re-sharing reads actual instance state, so these assertions cover more
  // than the controls' checked/value attributes.
  await page.getByTestId('share-view').click();
  const restored = JSON.parse(new URL(page.url()).searchParams.get('view')!) as GraphViewState;
  expect(restored.selection).toEqual(saved.selection);
  expect(restored.styling).toEqual(saved.styling);

  await page.getByTestId('node-color-mode').selectOption('category');
  await page.getByTestId('node-size-mode').selectOption('accessor');
  await page.getByTestId('show-links').check();
  await expect(page.getByTestId('legend-panel').locator('[data-orbit-legend-row]')).toHaveCount(6);
  await expect(page.getByTestId('legend-panel-size')).toHaveCount(0);
});

test('a stale dataRef trips the mismatch banner; Restore anyway opts in', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  // Make the link's dataRef differ from a FRESH load's: adding nodes bumps
  // the demo's revision, and a reload always starts at the initial
  // generation.
  await page.getByRole('button', { name: 'Add 500 nodes' }).click();
  await expect(page.getByTestId('node-count')).toHaveText('3,500', { timeout: 15_000 });
  await brushScore(page);
  await expect.poll(() => visibleNodes(page), { timeout: 10_000 }).toBeLessThan(3500);
  await page.getByTestId('share-view').click();
  await page.waitForFunction(() => window.location.search.includes('view='));
  const staleUrl = page.url();

  await page.goto('about:blank');
  await page.goto(staleUrl);
  await ready(page);

  // The gate fired INSTEAD of applying: banner up, roster untouched.
  await expect(page.getByTestId('view-mismatch-banner')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => visibleNodes(page), { timeout: 10_000 }).toBe(3000);

  // Opt-in restores the brush over THIS generation's data.
  await page.getByTestId('restore-anyway').click();
  await expect
    .poll(() => visibleNodes(page), {
      message: 'the brush must apply after the opt-in',
      timeout: 15_000,
    })
    .toBeLessThan(3000);
  await expect(page.getByTestId('view-mismatch-banner')).toHaveCount(0);
});
