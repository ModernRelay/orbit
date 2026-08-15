/**
 * v0.10 M5 equivalent views — `<GraphTable>` and
 * `<GraphSimControls>` docked beside the M5 graph.
 *
 * Interaction flows assert ONE NAMED OBSERVABLE each: a store-published
 * readout (`visible-nodes`, `selected-count`, `m5-sim-gravity`), a DOM state
 * the component owns (`aria-selected`, `aria-sort`, the row count line, the
 * sim-control value outputs, the simulation-status line), or the CSV export
 * summary. The gates — axe with zero violations, plus a scripted
 * KEYBOARD-ONLY run over both components — close the slice.
 *
 * The keyboard runs start at the document and Tab their way in: reaching the
 * control at all is part of the contract, so `tabUntil` is both the navigation
 * and the assertion (it throws when the bound is exhausted).
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  RESTORED_MAX,
  diffRatio,
  enterSemantic,
  readNumber,
  stableShot,
  tabUntil,
} from './m5-helpers';

const NODES = 144;
const PER_CLUSTER = 24;

const TABLE = '[data-orbit-table]';
const TABLE_ROW = '[data-orbit-table-row]';
const TABLE_FILTER = '[data-orbit-table-filter]';
const TABLE_COUNT = '[data-orbit-table-count]';
const SIM = '[data-orbit-simcontrols]';
const SIM_GRAVITY = '[data-orbit-simcontrols-input="gravity"]';
const SIM_GRAVITY_VALUE = '[data-orbit-simcontrols-value="gravity"]';
const SIM_FRICTION_VALUE = '[data-orbit-simcontrols-value="friction"]';
const SIM_DECAY_VALUE = '[data-orbit-simcontrols-value="decay"]';
const SIM_SPEED = '[data-orbit-simcontrols-speed]';
const SIM_REHEAT = '[data-orbit-simcontrols-reheat]';
const SIM_STATUS = '[data-orbit-simcontrols-status]';

test('table: rows are virtualized, a row click writes selection, and the row reads selected', async ({
  page,
}) => {
  await enterSemantic(page);

  // Rows follow the visible scene roster; the mounted row count stays bounded
  // — 144 rows, a 200px viewport of 24px rows.
  await expect(page.locator(TABLE_COUNT)).toHaveText(`${NODES} of ${NODES} rows`);
  const mounted = await page.locator(TABLE_ROW).count();
  expect(mounted, 'the window must mount far fewer rows than the roster').toBeLessThan(40);
  expect(mounted).toBeGreaterThan(0);

  const firstRow = page.locator(TABLE_ROW).first();
  await expect(firstRow).toHaveAttribute('data-orbit-table-row', 's0');
  await expect(firstRow).toHaveAttribute('aria-selected', 'false');

  await firstRow.click();
  // Named observables: the store's selection count and the row's ARIA state.
  await expect(page.getByTestId('selected-count')).toHaveText('1', { timeout: 10_000 });
  await expect(firstRow).toHaveAttribute('aria-selected', 'true');
});

test('table: the filter brushes the graph and graph-side masks narrow the rows', async ({
  page,
}) => {
  await enterSemantic(page);

  // table → graph: the filter registers as a crossfilter brush on the
  // id-keyed 'table' dimension, so the GRAPH narrows to the matching cluster.
  await page.locator(TABLE_FILTER).fill('bravo');
  await expect(page.getByTestId('visible-nodes')).toHaveText(String(PER_CLUSTER), {
    timeout: 15_000,
  });
  await expect(page.locator(TABLE_COUNT)).toHaveText(`${PER_CLUSTER} of ${PER_CLUSTER} rows`);

  await page.locator(TABLE_FILTER).fill('');
  await expect(page.getByTestId('visible-nodes')).toHaveText(String(NODES), { timeout: 15_000 });

  // graph → table: the demo's cluster filter hides a cluster and the
  // table's row source (the visible roster) follows.
  await page.getByTestId('cluster-check-0').uncheck();
  await expect(page.getByTestId('visible-nodes')).toHaveText(String(NODES - PER_CLUSTER), {
    timeout: 15_000,
  });
  await expect(page.locator(TABLE_COUNT)).toHaveText(
    `${NODES - PER_CLUSTER} of ${NODES - PER_CLUSTER} rows`,
  );

  await page.getByTestId('cluster-check-0').check();
  await expect(page.locator(TABLE_COUNT)).toHaveText(`${NODES} of ${NODES} rows`, {
    timeout: 15_000,
  });
});

test('table: header sort follows the coercion order and exportCsv emits every row', async ({
  page,
}) => {
  await enterSemantic(page);

  const degreeCell = page.locator(`${TABLE_ROW} [data-orbit-table-cell="degree"]`).first();
  const header = page.locator('[data-orbit-table-header="degree"]');
  await expect(header).toHaveAttribute('aria-sort', 'none');

  await page.locator('[data-orbit-table-sort="degree"]').click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  // Chain tails carry a single edge; the numeric tier sorts them first.
  await expect(degreeCell).toHaveText('1');

  await page.locator('[data-orbit-table-sort="degree"]').click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  // s0 carries the chain + 4 spokes + 2 bridges + 3 parallel extras.
  await expect(degreeCell).toHaveText('10');

  // CSV export covers the current filtered+sorted rows: 1 header + 144 records.
  await page.getByTestId('m5-export-csv').click();
  await expect(page.getByTestId('m5-csv')).toHaveText(/^145 records · \d+ B$/);
});

test('sim controls: sliders commit config-only updates that never move the layout', async ({
  page,
}) => {
  await enterSemantic(page, { layout: 'force' });

  // applicability: the panel renders under a live force layout.
  await expect(page.locator(SIM)).toBeVisible();
  await expect(page.locator(SIM_STATUS)).toHaveText('settled'); // paused by enterSemantic

  const before = await stableShot(page);
  const gravityValue = page.locator(SIM_GRAVITY_VALUE);
  const initial = await gravityValue.textContent();

  await page.locator(SIM_GRAVITY).focus();
  await page.keyboard.press('ArrowRight');
  // Named observables: the component's own value output AND the demo's mirror
  // of `onSimulationChange` (proving the write left the component).
  await expect(gravityValue).not.toHaveText(initial!);
  await expect(page.getByTestId('m5-sim-gravity')).toHaveText((await gravityValue.textContent())!);

  // a config-only commit never resets positions — the picture is
  // unchanged by the slider write.
  const after = await stableShot(page);
  expect(
    await diffRatio(page, before, after),
    'a simulation config write must not move the layout',
  ).toBeLessThan(RESTORED_MAX);

  // Speed boost writes its documented field: `decay` → SPEED_FAST_DECAY
  // (v0.10.2 — this formerly proxied through `friction`, and this
  // assertion sat red for three releases because e2e was not a CI gate).
  const frictionBefore = await page.locator(SIM_FRICTION_VALUE).textContent();
  await page.locator(SIM_SPEED).check();
  await expect(page.locator(SIM_DECAY_VALUE)).toHaveText('1000');
  // Friction is UNTOUCHED — the boost no longer proxies through it.
  await expect(page.locator(SIM_FRICTION_VALUE)).toHaveText(frictionBefore!);
  // Unchecking restores the pre-boost cool-down.
  await page.locator(SIM_SPEED).uncheck();
  await expect(page.locator(SIM_DECAY_VALUE)).toHaveText('5000');
  await page.locator(SIM_SPEED).check(); // boosted again for the reheat below

  // Reheat resumes the simulation: the status line reads the store's
  // `simulationRunning` slice.
  await page.locator(SIM_REHEAT).click();
  await expect(page.locator(SIM_STATUS)).toHaveText('simulation running', { timeout: 10_000 });

  // under a fixed layout the panel renders nothing at all.
  await page.getByTestId('m5-layout-fixed').check();
  await expect(page.locator(SIM)).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(TABLE)).toBeVisible(); // the table is layout-agnostic
});

test('a11y: axe reports no violations on the table or the sim controls', async ({ page }) => {
  await enterSemantic(page, { layout: 'force' });
  await expect(page.locator(SIM)).toBeVisible();
  await expect(page.locator(TABLE)).toBeVisible();

  // Contrast tuning of the demo's dark chrome is tracked separately;
  // structural and ARIA violations are the required gate here.
  const table = await new AxeBuilder({ page })
    .include(TABLE)
    .disableRules(['color-contrast'])
    .analyze();
  expect(table.violations, JSON.stringify(table.violations, null, 2)).toEqual([]);

  const sim = await new AxeBuilder({ page })
    .include(SIM)
    .disableRules(['color-contrast'])
    .analyze();
  expect(sim.violations, JSON.stringify(sim.violations, null, 2)).toEqual([]);
});

test('keyboard: the sim controls are fully operable without a pointer', async ({ page }) => {
  await enterSemantic(page, { layout: 'force' });
  await expect(page.locator(SIM)).toBeVisible();

  // Tab in from the document (reachability is part of the contract).
  await tabUntil(page, SIM_GRAVITY);
  const gravityValue = page.locator(SIM_GRAVITY_VALUE);
  const before = await gravityValue.textContent();
  await page.keyboard.press('ArrowRight');
  await expect(gravityValue).not.toHaveText(before!);
  await page.keyboard.press('End');
  await expect(gravityValue).toHaveText('1'); // the descriptor's max

  await tabUntil(page, SIM_SPEED, 40);
  await page.keyboard.press('Space');
  await expect(page.locator(SIM_SPEED)).toBeChecked();
  // The boost's documented field is `decay` since v0.10.2 (see the pointer
  // test for the full contract; here the point is keyboard reachability).
  await expect(page.locator(SIM_DECAY_VALUE)).toHaveText('1000');

  await tabUntil(page, SIM_REHEAT, 40);
  await page.keyboard.press('Enter');
  await expect(page.locator(SIM_STATUS)).toHaveText('simulation running', { timeout: 10_000 });
});

test('keyboard: the table is fully operable without a pointer', async ({ page }) => {
  await enterSemantic(page);

  await tabUntil(page, TABLE_FILTER);
  await page.keyboard.type('coral');
  await expect(page.locator(TABLE_COUNT)).toHaveText(`${PER_CLUSTER} of ${PER_CLUSTER} rows`, {
    timeout: 15_000,
  });

  // Header sort buttons are the next stops; Enter activates the sort cycle.
  await tabUntil(page, '[data-orbit-table-sort="degree"]', 20);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-orbit-table-header="degree"]')).toHaveAttribute(
    'aria-sort',
    'ascending',
  );

  // Rows take focus (tabindex 0) and Enter writes the selection.
  await tabUntil(page, TABLE_ROW, 20);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('selected-count')).toHaveText('1', { timeout: 10_000 });
  expect(await readNumber(page, 'visible-nodes')).toBe(PER_CLUSTER);
});
