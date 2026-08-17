/**
 * Overlay + accessibility smoke.
 *
 * Drives the real demo app (cosmos engine, SwiftShader WebGL when headless)
 * through the packaged overlay components: the DOM label lane, the
 * <GraphToolbar> camera/sim controls, the <GraphContextMenu> typed-event
 * channel, the collapsible <GraphNavigator> keyboard surface, and the
 * reduced-motion coercion.
 *
 * The axe audit is a required gate. Manual landmark/aria assertions complement
 * it with checks for Orbit-specific contracts that generic rules cannot infer.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const READY_DOT = '[data-testid="status-dot"][title="ready"]';
const ZOOM_VALUE = '[data-testid="zoom-value"]';
const NAV_TOGGLE = '[data-testid="navigator-toggle"]';
const SIM_BUTTON = '[data-orbit-toolbar-button="simulation"]';
const ZOOM_IN_BUTTON = '[data-orbit-toolbar-button="zoom-in"]';
const FIT_VIEW_BUTTON = '[data-orbit-toolbar-button="fit-view"]';
const LABEL_DIV = '[data-orbit-label]';
const CONTEXT_MENU = '[data-orbit-context-menu]';

async function gotoReady(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  // The status bar renders '—' until the first viewport event lands.
  await expect(page.locator(ZOOM_VALUE)).toHaveText(/×/, { timeout: 15_000 });
}

/** Parses the '×1.23'-formatted zoom readout from the status bar. */
async function zoomValue(page: Page): Promise<number> {
  const text = (await page.locator(ZOOM_VALUE).textContent()) ?? '';
  const match = /×([\d.]+)/.exec(text);
  if (match === null) throw new Error(`unparseable zoom readout: "${text}"`);
  return Number.parseFloat(match[1]!);
}

/** Pauses the simulation through the toolbar toggle (no-op when settled). */
async function pauseSimulation(page: Page): Promise<void> {
  const sim = page.locator(SIM_BUTTON);
  if ((await sim.getAttribute('aria-pressed')) === 'true') {
    await sim.click();
    await expect(sim).toHaveAttribute('aria-pressed', 'false');
  }
}

test('labels: zooming past minZoom reveals DOM labels with literal text', async ({ page }) => {
  await gotoReady(page);
  // Instant camera steps make the zoom loop deterministic; label visibility
  // itself is what this test is about, not motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await pauseSimulation(page);

  // labels.minZoom is 1.2 — step the camera up until the LOD gate opens.
  for (let i = 0; i < 12 && (await zoomValue(page)) < 1.25; i++) {
    await page.locator(ZOOM_IN_BUTTON).click();
    await page.waitForTimeout(150);
  }
  expect(await zoomValue(page)).toBeGreaterThanOrEqual(1.25);

  const label = page.locator(LABEL_DIV).first();
  await expect(label).toBeVisible({ timeout: 15_000 });
  // Literal generator text ('alpha-0012'-style) rendered as a text node.
  await expect(label).toHaveText(/^[a-z0-9]+-\d{4}$/);
});

test('context menu: right-click opens the typed-event menu; Escape closes it', async ({
  page,
}) => {
  await gotoReady(page);

  // PAUSE THE SIM FIRST (the repo's standard pre-input stabilization), then
  // right-click a point that is REALLY the canvas. A blind viewport-center
  // click lands on a forced hub label (`labels.showFor` keeps n0/n1 labeled
  // at any zoom, and they sit at the blob's center) whenever the layout has
  // not spread — always under CI's slow SwiftShader sim, and immediately
  // after an early pause. Label divs are `pointerEvents: 'auto'` by design
  // (click-to-focus), so they swallow the right-click and cosmos never sees
  // it. The contract under test is the typed-event menu; a background-point
  // right-click opens the background variant of the same menu.
  const pauseSim = page.getByRole('button', { name: 'Pause simulation' });
  if ((await pauseSim.count()) > 0) {
    await pauseSim.click();
  }
  const target = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-orbit-canvas] canvas');
    if (canvas === null) throw new Error('Orbit did not mount its engine canvas');
    const rect = canvas.getBoundingClientRect();
    // Same unobstructed-point hunt as selection.spec.ts: topmost element at
    // the candidate must be the canvas itself — not a label, not a panel.
    for (const yFraction of [0.5, 0.4, 0.6, 0.35, 0.3]) {
      for (const xFraction of [0.5, 0.44, 0.56, 0.4, 0.62]) {
        const x = rect.left + rect.width * xFraction;
        const y = rect.top + rect.height * yFraction;
        if (document.elementFromPoint(x, y) === canvas) return { x, y };
      }
    }
    throw new Error('no unobstructed canvas point found for the right-click');
  });

  // Under full-suite load the first right-click can land before cosmos's
  // pointer wiring settles; retry a couple of times before failing.
  const menu = page.locator(CONTEXT_MENU);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.mouse.click(target.x, target.y, { button: 'right' });
    try {
      await expect(menu).toBeVisible({ timeout: 2_000 });
      break;
    } catch {
      if (attempt === 2) throw new Error('context menu did not open after 3 right-clicks');
      await page.waitForTimeout(500);
    }
  }
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  expect(await items.count()).toBeGreaterThan(0);
  // The menu opens focused on its first item; ArrowDown roves.
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('navigator: Tab to toggle, open, arrow through items, Enter focuses a node', async ({
  page,
}) => {
  await gotoReady(page);

  const toggle = page.locator(NAV_TOGGLE);
  // Labels are legitimate keyboard controls and precede the overlay children
  // in Graph's DOM. Prove the toggle is reachable by sequential keyboard
  // navigation without coupling this test to the current number of labels.
  let reachedToggle = false;
  for (let tabs = 0; tabs < 64; tabs++) {
    await page.keyboard.press('Tab');
    if (await toggle.evaluate((element) => element === document.activeElement)) {
      reachedToggle = true;
      break;
    }
  }
  expect(reachedToggle, 'Tab should reach the navigator toggle').toBe(true);
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const listbox = page.getByRole('listbox', { name: 'Graph navigator items' });
  await expect(listbox).toBeVisible();

  // Tab reaches the roving-tabindex active item (exactly one is tabbable).
  await page.keyboard.press('Tab');
  const options = page.getByRole('option');
  await expect(options.first()).toBeFocused();

  // Arrow keys move both the DOM focus and aria-activedescendant.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(2)).toBeFocused();
  const activeId = await options.nth(2).getAttribute('id');
  expect(activeId).toBeTruthy();
  await expect(listbox).toHaveAttribute('aria-activedescendant', activeId!);

  // Enter → instance.focusNode: camera fly (zoom readout changes — cosmos
  // zooms to the focused point) and the neighborhood re-roots the list.
  const zoomBefore = await zoomValue(page);
  await page.keyboard.press('Enter');
  const focusedGroup = page.getByRole('group', { name: /^Focused node / });
  await expect(focusedGroup).toBeVisible();
  await expect(focusedGroup.getByRole('option').first()).toBeFocused();
  await expect
    .poll(() => zoomValue(page), {
      message: 'focusNode should fly the camera (zoom readout changes)',
      timeout: 10_000,
    })
    .not.toBe(zoomBefore);
});

test('toolbar: simulation pause/resume toggles aria-pressed state', async ({ page }) => {
  await gotoReady(page);

  const sim = page.locator(SIM_BUTTON);
  // Fresh data restarts the layout, so the toggle starts pressed (running).
  await expect(sim).toHaveAttribute('aria-pressed', 'true');
  await expect(sim).toHaveAttribute('aria-label', 'Pause simulation');

  await sim.click();
  await expect(sim).toHaveAttribute('aria-pressed', 'false');
  await expect(sim).toHaveAttribute('aria-label', 'Resume simulation');

  await sim.click();
  await expect(sim).toHaveAttribute('aria-pressed', 'true');
});

test('reduced motion: Fit view settles immediately (no long camera animation)', async ({
  page,
}) => {
  await gotoReady(page);
  await pauseSimulation(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });

  // Move away from the fitted viewport (instant under reduced motion).
  await page.locator(ZOOM_IN_BUTTON).click();
  await page.locator(ZOOM_IN_BUTTON).click();
  await page.waitForTimeout(250);
  const zoomedIn = await zoomValue(page);

  await page.locator(FIT_VIEW_BUTTON).click();
  // reduced motion coerces camera durations to 0 — the viewport must
  // already be at its final value within 200ms of the click...
  await page.waitForTimeout(200);
  const settled = await zoomValue(page);
  expect(settled).not.toBe(zoomedIn);
  //...and stay there (no ongoing animation still easing toward a target).
  await page.waitForTimeout(300);
  expect(await zoomValue(page)).toBe(settled);
});

// ---------------------------------------------------------------------------
// Accessibility audit: mandatory axe gate plus manual landmark/aria checks.
// ---------------------------------------------------------------------------

test('accessibility: axe audit and manual landmark/aria checks', async ({
  page,
}) => {
  await gotoReady(page);

  // The demo is a dark-theme WebGL canvas — contrast tuning is tracked
  // separately; structural/aria violations are the required gate here.
  const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
  const severe = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(severe, JSON.stringify(severe, null, 2)).toEqual([]);

  // --- manual landmark/aria assertion set ---
  // Canvas container: application role with the host-provided name.
  const canvas = page.locator('[data-orbit-canvas]');
  await expect(canvas).toHaveAttribute('role', 'application');
  await expect(canvas).toHaveAttribute('aria-label', 'orbit demo graph');

  // Toolbar landmark: named toolbar whose buttons all carry accessible names.
  const toolbar = page.getByRole('toolbar', { name: 'Graph controls' });
  await expect(toolbar).toBeVisible();
  const buttons = toolbar.locator('button');
  const buttonCount = await buttons.count();
  expect(buttonCount).toBeGreaterThanOrEqual(7);
  for (let i = 0; i < buttonCount; i++) {
    const name = await buttons.nth(i).getAttribute('aria-label');
    expect(name?.trim(), `toolbar button ${i} must have an aria-label`).toBeTruthy();
  }

  // Live region: polite, atomic, store-driven — exactly one.
  const liveRegion = page.locator('[data-orbit-live-region]');
  await expect(liveRegion).toHaveCount(1);
  await expect(liveRegion).toHaveAttribute('role', 'status');
  await expect(liveRegion).toHaveAttribute('aria-live', 'polite');
  await expect(liveRegion).toHaveAttribute('aria-atomic', 'true');

  // Navigator disclosure: aria-expanded/aria-controls pair, listbox with a
  // name and roving aria-selected options once opened.
  const toggle = page.locator(NAV_TOGGLE);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const panelId = await toggle.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  await expect(page.locator(`[id="${panelId}"]`)).toBeVisible();
  const listbox = page.getByRole('listbox', { name: 'Graph navigator items' });
  await expect(listbox).toBeVisible();
  const firstOption = listbox.getByRole('option').first();
  await expect(firstOption).toHaveAttribute('aria-selected', /^(true|false)$/);
});
