/**
 * Filtering + crossfilter + timeline + history smoke for v0.7.
 *
 * Drives the declarative 3,000-node graph through the Filters panel (cluster
 * checkboxes → the `filter` prop), a histogram drag-brush through the
 * crossfilter mask fast path, timeline playback, and undo — asserting
 * DOM status text only. The store's `visible` counts are HIDE-LANE only:
 * `mode:'dim'` survivors still count as visible, which this spec
 * asserts explicitly.
 *
 * CI note (same pattern as ingestion.spec.ts): the force simulation is paused
 * before the interaction phase — cosmos free-runs its rAF while data is
 * present and on CI's software rasterizer that can starve
 * Playwright's input events. None of the assertions here need a live sim.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const READY_DOT = '[data-testid="status-dot"][title="ready"]';
const NODE_COUNT = '[data-testid="node-count"]';
const VISIBLE_NODES = '[data-testid="visible-nodes"]';
/** The packaged component's brushable plot area (pointer handlers live here). */
const HISTOGRAM_PLOT = '[data-testid="histogram-panel"] [data-orbit-histogram-plot]';
const TIMELINE = '[data-testid="timeline-panel"]';

/** 3,000 nodes across 6 clusters (cluster = i % 6) → exactly 500 per cluster. */
const TOTAL = 3_000;
const PER_CLUSTER = 500;

const fmt = (n: number): string => n.toLocaleString('en-US');

async function visibleNodes(page: Page): Promise<number> {
  const text = (await page.locator(VISIBLE_NODES).textContent()) ?? '';
  const parsed = Number.parseInt(text.replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

test('cluster filter (hide/dim) → histogram brush → timeline play → undo', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await expect(page.locator(NODE_COUNT)).toHaveText(fmt(TOTAL));
  await expect(page.locator(VISIBLE_NODES)).toHaveText(fmt(TOTAL));

  // Nothing recorded yet: history depths gate the buttons.
  await expect(page.getByTestId('undo')).toBeDisabled();
  await expect(page.getByTestId('redo')).toBeDisabled();

  // Pause the sim before interacting (see the module doc's CI note).
  const pauseSim = page.getByRole('button', { name: 'Pause simulation' });
  if ((await pauseSim.count()) > 0) {
    await pauseSim.click();
  }

  // --- cluster checkbox, mode 'hide': mask drops visible, MODEL untouched ---
  await page.getByTestId('cluster-check-0').uncheck();
  await expect(page.locator(VISIBLE_NODES)).toHaveText(fmt(TOTAL - PER_CLUSTER), {
    timeout: 10_000,
  });
  // Header counts read the accepted model — a mask never changes data.
  await expect(page.locator(NODE_COUNT)).toHaveText(fmt(TOTAL));

  // --- mode 'dim': store.visible counts the HIDE lane only, so dim
  // survivors are still visible — the count RESTORES while the cluster stays
  // muted on screen. ---
  await page.getByTestId('filter-mode-dim').check();
  await expect(page.locator(VISIBLE_NODES)).toHaveText(fmt(TOTAL), { timeout: 10_000 });

  // Back to hide, then re-check the cluster: filter clears entirely.
  await page.getByTestId('filter-mode-hide').check();
  await expect(page.locator(VISIBLE_NODES)).toHaveText(fmt(TOTAL - PER_CLUSTER), {
    timeout: 10_000,
  });
  await page.getByTestId('cluster-check-0').check();
  await expect(page.locator(VISIBLE_NODES)).toHaveText(fmt(TOTAL), { timeout: 10_000 });

  // --- histogram drag-brush over part of the score axis ---
  // <GraphLegend> mounts asynchronously once scale info resolves, which
  // shifts the bottom strip AFTER an early boundingBox read — the drag
  // would land on stale coordinates. Wait for the legend rows to exist, let
  // the layout settle, and only then measure the plot.
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
  await expect
    .poll(() => visibleNodes(page), {
      message: 'a partial score brush should hide some nodes',
      timeout: 10_000,
    })
    .toBeLessThan(TOTAL);
  const brushed = await visibleNodes(page);
  expect(brushed).toBeGreaterThan(0);

  // The brush is an uncontrolled mutation → it entered the history stack.
  await expect(page.getByTestId('undo')).toBeEnabled();

  // Double-click clears the brush.
  await page.mouse.dblclick(box.x + box.width * 0.5, y);
  await expect(page.locator(VISIBLE_NODES)).toHaveText(fmt(TOTAL), { timeout: 10_000 });

  // --- timeline playback: one playing dimension, store-reflected ---
  const timeline = page.locator(TIMELINE);
  await expect(timeline).toBeVisible();
  await timeline.getByRole('button', { name: /play/i }).click();
  // The wrapper stamps the store's timeline.playingKey (button state source).
  await expect(timeline).toHaveAttribute('data-playing-key', 'createdAt', { timeout: 10_000 });

  // The sweeping window changes the visible count across a few polls.
  const samples = new Set<number>();
  await expect
    .poll(
      async () => {
        samples.add(await visibleNodes(page));
        return samples.size;
      },
      { message: 'playback should sweep the visible count', timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(2);

  await timeline.getByRole('button', { name: /pause/i }).click();
  await expect(timeline).toHaveAttribute('data-playing-key', '', { timeout: 10_000 });

  // --- undo: the play session coalesced into ONE history entry, so a
  // single undo reverts its createdAt brush and the full count returns. ---
  const undoButton = page.getByTestId('undo');
  await expect(undoButton).toBeEnabled();
  await undoButton.click();
  await expect(page.locator(VISIBLE_NODES)).toHaveText(fmt(TOTAL), { timeout: 10_000 });
  // The undone entry is redoable.
  await expect(page.getByTestId('redo')).toBeEnabled();
});
