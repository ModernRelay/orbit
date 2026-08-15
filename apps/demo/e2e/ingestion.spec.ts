/**
 * Ingestion + hard-scope interaction smoke.
 *
 * Streams a REDUCED deterministic NDJSON feed (env-tunable via STREAM_ROWS,
 * default 30K rows for CI speed — the demo reads it from `?rows=`) through a
 * `purpose:'replace'` IngestSession, then exercises the hard scope:
 * isolate via the context menu's node Isolate item and restore via the Data
 * panel's Reset scope button. Assertions target DOM status text only
 * hit-testing node centers under a live force simulation is flaky, so the
 * right-click hunts a small grid of points until it lands on a node.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const READY_DOT = '[data-testid="status-dot"][title="ready"]';
const NODE_COUNT = '[data-testid="node-count"]';
const SCOPE_STATUS = '[data-testid="scope-status"]';
const ZOOM_VALUE = '[data-testid="zoom-value"]';
const METER = '[data-testid="stream-meter"]';
const CONTEXT_MENU = '[data-orbit-context-menu]';
const ISOLATE_ITEM = '[data-orbit-context-menu-item="isolate"]';

const STREAM_ROWS = Number.parseInt(process.env['STREAM_ROWS'] ?? '30000', 10);
/** Must mirror streamFeed.ts: nodes = round(rows * 0.8). */
const STREAM_NODES = Math.max(1, Math.round(STREAM_ROWS * 0.8));

const fmt = (n: number): string => n.toLocaleString('en-US');

async function zoomValue(page: Page): Promise<number> {
  const text = (await page.locator(ZOOM_VALUE).textContent()) ?? '';
  const match = /×([\d.]+)/.exec(text);
  return match === null ? Number.NaN : Number.parseFloat(match[1]!);
}

/** Right-click around the viewport center until the NODE context menu (the
 * one carrying the Isolate item) opens; background menus are dismissed. */
async function openNodeContextMenu(page: Page): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('viewport must be set by the config');
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  // Probe the whole canvas, not just the center: on a slow CI runner the
  // paused-early force layout can still be the SEED RING (dense band, empty
  // middle), so center-clustered candidates all miss. Center-out ordering
  // keeps the settled-blob case fast; the grid covers ring-shaped layouts.
  const dense: [number, number][] = [-24, 24, -48, 48, -72, 72, -96, 96].flatMap((dx) =>
    [-18, 18, -42, 42, 0].map((dy): [number, number] => [cx + dx, cy + dy]),
  );
  const grid: [number, number][] = [];
  for (const fy of [0.5, 0.38, 0.62, 0.26, 0.74, 0.18, 0.82]) {
    for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78, 0.14, 0.86]) {
      grid.push([viewport.width * fx, viewport.height * fy]);
    }
  }
  const candidates: readonly [number, number][] = [[cx, cy], ...dense, ...grid];
  for (const [x, y] of candidates) {
    await page.mouse.click(x, y, { button: 'right' });
    try {
      await expect(page.locator(CONTEXT_MENU)).toBeVisible({ timeout: 1_000 });
    } catch {
      continue; // click landed before pointer wiring settled — try the next
    }
    if ((await page.locator(ISOLATE_ITEM).count()) > 0) return; // node menu
    await page.keyboard.press('Escape'); // background menu — dismiss, retry
    await expect(page.locator(CONTEXT_MENU)).toHaveCount(0);
  }
  throw new Error('no right-click candidate landed on a node');
}

test('stream feed → live meter → commit → isolate via context menu → reset scope', async ({
  page,
}) => {
  // The suite's heaviest test: a 12K-row stream plus a multi-thousand-node
  // force reheat. On a slow CI runner the default 90s budget flakes: it can be
  // exceeded even when the same test passes on rerun. A blocking
  // gate that flakes is how gates get turned off. test.slow triples the
  // budget; the assertions are unchanged.
  test.slow();
  await page.goto(`/?rows=${STREAM_ROWS}`);
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await expect(page.locator(NODE_COUNT)).toHaveText('3,000'); // declarative base

  // --- stream the replace feed; the LIVE meter appears and completes ---
  await page.getByTestId('stream-feed').click();
  await expect(page.locator(METER)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(METER)).toHaveAttribute('data-phase', 'committed', {
    timeout: 45_000,
  });
  await expect(page.getByTestId('stream-rows')).toHaveText(fmt(STREAM_ROWS));
  await expect(page.getByTestId('stream-pending-bytes')).toHaveText('0 B');

  // The header count now reflects the streamed accepted model.
  await expect(page.locator(NODE_COUNT)).toHaveText(fmt(STREAM_NODES));
  await page.waitForSelector(READY_DOT, { timeout: 30_000 });

  // Pause the force simulation before the interaction phase. cosmos free-runs
  // its rAF while data is present, and on CI's software rasterizer
  // a fresh multi-thousand-node reheat saturates the runner enough to starve
  // Playwright's input events (this is why this spec timed out on CI while
  // passing on real GPUs). The scope assertions below don't need a live sim.
  const pauseSim = page.getByRole('button', { name: 'Pause simulation' });
  if ((await pauseSim.count()) > 0) {
    await pauseSim.click();
  }

  // --- the graph is still interactive: zoom in, then fit view ---
  const zoomBefore = await zoomValue(page);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect
    .poll(() => zoomValue(page), { message: 'zoom in should raise the zoom', timeout: 10_000 })
    .toBeGreaterThan(zoomBefore);
  await page.getByRole('button', { name: 'Fit view' }).click();
  await expect
    .poll(() => zoomValue(page), { message: 'fit view should re-frame', timeout: 10_000 })
    .not.toBeNaN();

  // --- isolate via the context menu's node Isolate item ---
  await expect(page.locator(SCOPE_STATUS)).toHaveText('full');
  await openNodeContextMenu(page);
  await page.locator(ISOLATE_ITEM).click();

  // The scope indicator flips to visible-of-model with a visibly reduced count.
  await expect(page.locator(SCOPE_STATUS)).toHaveText(new RegExp(`of ${fmt(STREAM_NODES)}$`), {
    timeout: 10_000,
  });
  const scopeText = (await page.locator(SCOPE_STATUS).textContent()) ?? '';
  const visible = Number.parseInt(scopeText.replace(/,/g, ''), 10);
  expect(visible).toBeGreaterThan(0);
  expect(visible).toBeLessThan(STREAM_NODES);

  // --- Reset scope (Data panel button, present only under an active scope) ---
  await page.getByTestId('reset-scope').click();
  await expect(page.locator(SCOPE_STATUS)).toHaveText('full', { timeout: 10_000 });
  await expect(page.locator(NODE_COUNT)).toHaveText(fmt(STREAM_NODES));
});
