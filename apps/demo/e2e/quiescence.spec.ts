/**
 * Quiescence — the product-level stop-at-rest acceptance. A pre-load
 * requestAnimationFrame wrapper shared with the probe suite
 * counts SCHEDULING calls: a truly stopped loop registers nothing — cosmos'
 * on-demand renderer AND orbit's gated activity clock both silent.
 *
 * The write re-arm halves assert the OTHER side of the contract: a
 * soft-filter alpha write and a selection write applied at rest each produce
 * at least one rendered frame, and the loop re-freezes afterwards.
 *
 * Works under SwiftShader: no GPU picking is involved — writes are driven
 * through DOM controls, and the instrument observes scheduling, not pixels.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

declare global {
  interface Window {
    __rafAudit?: { registrations: number; ticks: number };
  }
}

const READY_DOT = '[data-testid="status-dot"][title="ready"]';

/** Registrations counted since page load. */
async function registrations(page: Page): Promise<number> {
  return page.evaluate(() => window.__rafAudit?.registrations ?? -1);
}

/** Wait (bounded) until no rAF is scheduled across a settle window. */
async function waitForRest(page: Page, windowMs = 1_000, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const before = await registrations(page);
        await page.waitForTimeout(windowMs);
        const after = await registrations(page);
        return after - before;
      },
      { timeout: timeoutMs },
    )
    .toBe(0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const audit = { registrations: 0, ticks: 0 };
    (window as Window).__rafAudit = audit;
    const native = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
      audit.registrations += 1;
      return native((t) => {
        audit.ticks += 1;
        cb(t);
      });
    };
  });
});

test('a settled graph registers ZERO rAF callbacks over 5 seconds', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });

  // Stop the force simulation deterministically (the toolbar pause), then
  // park the pointer off-canvas so hover work cannot hold frames.
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.mouse.move(5, 780);
  await waitForRest(page);

  // THE claim: five seconds of genuine silence — no cosmos loop, no adapter
  // activity clock, no component-owned rAF anywhere in the tree.
  const before = await registrations(page);
  await page.waitForTimeout(5_000);
  expect(await registrations(page)).toBe(before);
});

test('a soft-filter write at rest re-arms >= 1 frame, then the loop re-freezes', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.mouse.move(5, 780);
  await waitForRest(page);

  // mask write from rest: uncheck a cluster filter (buffers-only commit).
  const before = await registrations(page);
  await page.getByTestId('cluster-check-0').uncheck();
  await expect.poll(() => registrations(page), { timeout: 10_000 }).toBeGreaterThan(before);

  await waitForRest(page); // and silence returns
});

test('a selection write at rest re-arms >= 1 frame, then the loop re-freezes', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Pause simulation' }).click();
  await page.mouse.move(5, 780);
  await waitForRest(page);

  // selection from rest (setHighlightedIndices path via Select all).
  const before = await registrations(page);
  await page.getByRole('button', { name: 'Select all' }).click();
  await expect.poll(() => registrations(page), { timeout: 10_000 }).toBeGreaterThan(before);

  await waitForRest(page);
});
