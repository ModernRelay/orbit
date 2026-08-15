/**
 * label-lane context menu.
 *
 * Label divs are `pointerEvents: 'auto'` (click-to-focus), so a right-click
 * on one never reaches the engine canvas — before this fix it fell through
 * to the browser's native menu on exactly the nodes prominent enough to
 * carry labels. The label path must feed the SAME typed 'contextMenu'
 * channel the canvas gesture feeds.
 *
 * Deliberately DOM-driven end to end: the right-click targets the label
 * element, not canvas coordinates, so this spec is immune to the SwiftShader
 * hit-test limitation that keeps the lasso assertion local-only.
 */

import { expect, test } from '@playwright/test';

const READY_DOT = '[data-testid="status-dot"][title="ready"]';
const SIM_BUTTON = '[data-orbit-toolbar-button="simulation"]';
const LABEL_DIV = '[data-orbit-label]';
const CONTEXT_MENU = '[data-orbit-context-menu]';
const MENU_HEADING = '[data-orbit-context-menu-heading]';

test('right-clicking a label opens the node context menu, not the browser menu', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });

  // Freeze the layout (standard pre-input stabilization) so the label under
  // the pointer is the label we asserted on.
  const sim = page.locator(SIM_BUTTON);
  if ((await sim.getAttribute('aria-pressed')) === 'true') {
    await sim.click();
  }

  // The demo forces labels for the hub nodes (labels.showFor), so at least
  // one label div exists at ANY zoom — no LOD stepping needed.
  await expect(page.locator(LABEL_DIV).first()).toBeVisible({ timeout: 15_000 });

  // The forced hub labels can OVERLAP at the blob center (both hubs are
  // central), and Playwright refuses a click whose point another label
  // intercepts. Pick the one that owns its own center per elementFromPoint
  // the same unobstructed-point discipline the other specs use.
  const target = await page.evaluate((selector) => {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit !== null && el.contains(hit)) {
        return { x, y, text: el.textContent?.trim() ?? '' };
      }
    }
    throw new Error('no label owns its own center point');
  }, LABEL_DIV);
  const labelText = target.text;

  await page.mouse.click(target.x, target.y, { button: 'right' });

  // Orbit's menu, for THAT node: the heading carries the label text, and the
  // items are the node-target set (menuitems present, first item focused).
  const menu = page.locator(CONTEXT_MENU);
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(MENU_HEADING)).toHaveText(labelText);
  const items = menu.getByRole('menuitem');
  expect(await items.count()).toBeGreaterThan(0);
  await expect(items.first()).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});
