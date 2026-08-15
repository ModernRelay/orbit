/**
 * Styling smoke for v0.8: scales, legend, theme, edge-arrow/link toggles.
 *
 * Drives the declarative 3,000-node graph through the Style panel:
 * - default 'category' mode is a categorical Scale (cluster-as-string,
 * declared domain '0'..'5') → <GraphLegend> renders count-annotated swatch
 * rows; clicking a row flows through the DEMO's filter wiring (host-owned
 * filtering, — the legend never filters by itself) and the visible
 * count drops.
 * - 'degree ramp' swaps nodeColor to a sequential Scale over the built-in
 * degree metric → the legend re-reads scale info and renders a
 * gradient ramp with the metric name and numeric min/max ticks.
 * - the theme toggle flips `theme={{base}}`: the app root's data-theme
 * attribute and background swap.
 * - edgeArrows + showLinks commit config-only updates:
 * the instance stays ready and no engine error surfaces.
 *
 * CI note (same pattern as filtering.spec.ts): the force simulation is paused
 * before the interaction phase — cosmos free-runs its rAF while data is
 * present and on CI's software rasterizer that can starve
 * Playwright's input events. None of the assertions here need a live sim.
 */

import { expect, test } from '@playwright/test';

const READY_DOT = '[data-testid="status-dot"][title="ready"]';
const NODE_COUNT = '[data-testid="node-count"]';
const VISIBLE_NODES = '[data-testid="visible-nodes"]';
const LEGEND = '[data-testid="legend-panel"]';

/** 3,000 nodes across 6 clusters (cluster = i % 6) → exactly 500 per cluster. */
const TOTAL = 3_000;
const PER_CLUSTER = 500;
const CLUSTERS = 6;

const fmt = (n: number): string => n.toLocaleString('en-US');

test('categorical legend + row click → degree ramp legend → size scale → arrows/links → theme flip', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await expect(page.locator(NODE_COUNT)).toHaveText(fmt(TOTAL));
  await expect(page.locator(VISIBLE_NODES)).toHaveText(fmt(TOTAL));

  // Pause the sim before interacting (see the module doc's CI note).
  const pauseSim = page.getByRole('button', { name: 'Pause simulation' });
  if ((await pauseSim.count()) > 0) {
    await pauseSim.click();
  }

  const legend = page.locator(LEGEND);

  // --- categorical legend: six swatch rows, each count-annotated (500) ------
  await expect(legend).toBeVisible();
  await expect
    .poll(
      async () => {
        const text = await legend.innerText();
        return (text.match(new RegExp(`\\b${PER_CLUSTER}\\b`, 'g')) ?? []).length;
      },
      {
        message: `the categorical legend should show ${CLUSTERS} rows counting ${PER_CLUSTER} each`,
        timeout: 15_000,
      },
    )
    .toBe(CLUSTERS);

  // --- legend row click → the demo's filter wiring hides that cluster ------
  // The row VALUE is the cluster id as a string (declared domain '0'..'5').
  await legend.getByText('0', { exact: true }).first().click();
  await expect(page.locator(VISIBLE_NODES)).toHaveText(fmt(TOTAL - PER_CLUSTER), {
    timeout: 10_000,
  });
  // Shared state: the Filters panel checkbox reflects the exclusion, and the
  // legend row survives as a dimmed excludedValues row (still clickable).
  await expect(page.getByTestId('cluster-check-0')).not.toBeChecked();
  await expect(legend.getByText('0', { exact: true }).first()).toBeVisible();

  // Click the dimmed row again → exclusion clears, full count returns.
  await legend.getByText('0', { exact: true }).first().click();
  await expect(page.locator(VISIBLE_NODES)).toHaveText(fmt(TOTAL), { timeout: 10_000 });
  await expect(page.getByTestId('cluster-check-0')).toBeChecked();

  // --- degree ramp: gradient bar + metric name + numeric min/max ticks -----
  await page.getByTestId('node-color-mode').selectOption('degree');
  await expect(legend).toContainText('degree', { timeout: 15_000 });
  await expect(
    legend.locator('[style*="gradient"]').first(),
    'the sequential legend should render a gradient ramp bar',
  ).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(
      async () => {
        // Distinct numeric tokens outside the metric name = domain ticks.
        const text = (await legend.innerText()).replace(/degree/g, ' ');
        return new Set(text.match(/-?\d+(?:\.\d+)?/g) ?? []).size;
      },
      { message: 'the ramp should show min/max domain ticks', timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(2);

  // --- nodeSize scale mode mounts the size legend, instance stays ready ----
  await page.getByTestId('node-size-mode').selectOption('scale');
  await expect(page.getByTestId('legend-panel-size')).toHaveCount(1);
  await expect(page.locator(READY_DOT)).toBeVisible();

  // --- edgeArrows + showLinks: config-only commits, no errors ---------------
  await page.getByTestId('edge-arrows').check();
  await page.getByTestId('show-links').uncheck();
  await page.waitForTimeout(500); // let the config commits apply
  await expect(page.locator(READY_DOT)).toBeVisible();
  await expect(page.getByText('engine error:')).toHaveCount(0);
  await page.getByTestId('show-links').check();
  await page.getByTestId('edge-arrows').uncheck();
  await expect(page.locator(READY_DOT)).toBeVisible();

  // --- theme flip: data-theme attribute + background swap ------------------
  const appRoot = page.getByTestId('app-root');
  await expect(appRoot).toHaveAttribute('data-theme', 'dark');
  const darkBg = await appRoot.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.getByTestId('theme-light').check();
  await expect(appRoot).toHaveAttribute('data-theme', 'light');
  await expect
    .poll(() => appRoot.evaluate((el) => getComputedStyle(el).backgroundColor), {
      message: 'the light base should change the app background',
      timeout: 10_000,
    })
    .not.toBe(darkBg);
  await expect(page.locator(READY_DOT)).toBeVisible();
  await expect(page.getByText('engine error:')).toHaveCount(0);
});
