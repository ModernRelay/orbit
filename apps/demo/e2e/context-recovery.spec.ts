/**
 * Real-browser context-loss recovery across React -> core -> Cosmos.
 *
 * This deliberately uses the browser's WEBGL_lose_context extension rather
 * than synthetic DOM events. While the context is lost, React publishes a
 * larger snapshot into the core; recovery must recreate Cosmos' canvas and
 * apply that latest desired render before normal interaction resumes.
 */

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const STATUS_DOT = '[data-testid="status-dot"]';
const READY_DOT = `${STATUS_DOT}[title="ready"]`;
const LOST_DOT = `${STATUS_DOT}[title="lost"]`;

interface ContextLossProbeWindow extends Window {
  __orbitRestoreLostContext?: () => void;
}

async function numericAttribute(locator: Locator, name: string): Promise<number> {
  const raw = await locator.getAttribute(name);
  return raw === null ? Number.NaN : Number.parseInt(raw, 10);
}

async function zoomValue(page: Page): Promise<number> {
  const text = (await page.getByTestId('zoom-value').textContent()) ?? '';
  const match = /×([\d.]+)/.exec(text);
  return match === null ? Number.NaN : Number.parseFloat(match[1]!);
}

async function unobstructedCanvasPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-orbit-canvas] canvas');
    if (canvas === null) throw new Error('Orbit did not mount its engine canvas');
    const rect = canvas.getBoundingClientRect();

    // The demo has pointer-enabled panels around the edges and DOM labels over
    // a few nodes. Require the canvas itself to be topmost: merely checking
    // that the hit element belongs to the graph host also accepts an
    // interactive DOM label, and wheel events dispatched there do not reach
    // Cosmos' canvas listener.
    const xFractions = [0.5, 0.65, 0.35, 0.75, 0.25, 0.85, 0.15];
    const yFractions = [0.65, 0.5, 0.75, 0.35, 0.85, 0.2];
    for (const yFraction of yFractions) {
      for (const xFraction of xFractions) {
        const x = rect.left + rect.width * xFraction;
        const y = rect.top + rect.height * yFraction;
        const topmost = document.elementFromPoint(x, y);
        if (topmost === canvas) return { x, y };
      }
    }
    throw new Error('Could not find an unobstructed point on the Cosmos canvas');
  });
}

test('real WebGL loss coalesces a React data update and restores the latest interactive scene', async ({
  page,
}) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await expect(page.getByTestId('node-count')).toHaveText('3,000');

  // Start from a known camera value, then establish non-default viewport and
  // selection slices which recovery must replay into the replacement graph.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Reset view' }).click();
  await expect.poll(() => zoomValue(page), { timeout: 10_000 }).toBe(1);
  for (let i = 0; i < 3; i++) {
    const before = await zoomValue(page);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(() => zoomValue(page), { timeout: 10_000 }).toBeGreaterThan(before);
  }
  const replayZoom = await zoomValue(page);
  expect(replayZoom).toBeGreaterThan(1.7);

  await page.getByRole('button', { name: 'Select all' }).click();
  await expect(page.getByTestId('selected-count')).toHaveText('3,000');

  const status = page.locator(STATUS_DOT);
  const initialModel = await numericAttribute(status, 'data-model-revision');
  const initialRender = await numericAttribute(status, 'data-render-revision');
  const initialApplied = await numericAttribute(status, 'data-applied-render-revision');
  expect(initialModel).toBeGreaterThan(0);
  expect(initialApplied).toBe(initialRender);

  const extensionAvailable = await page.evaluate(() => {
    // Scoped to the engine host: the minimap adds a second (2D) canvas.
    const canvas = document.querySelector<HTMLCanvasElement>('[data-orbit-canvas] canvas');
    if (canvas === null) throw new Error('Cosmos did not mount a canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (gl === null) return false;
    const extension = gl.getExtension('WEBGL_lose_context');
    if (extension === null) return false;

    canvas.dataset['contextLossProbe'] = 'original';
    const probeWindow = window as ContextLossProbeWindow;
    probeWindow.__orbitRestoreLostContext = () => extension.restoreContext();
    extension.loseContext();
    return true;
  });
  expect(extensionAvailable, 'Chromium must expose WEBGL_lose_context for this test').toBe(true);

  await page.waitForSelector(LOST_DOT, { timeout: 15_000 });

  // React publishes a strict-superset snapshot while the engine is frozen.
  await page.getByRole('button', { name: 'Add 500 nodes' }).click();
  await expect(page.getByTestId('node-count')).toHaveText('3,500');
  await expect(status).toHaveAttribute('title', 'lost');
  await expect(page.getByTestId('selected-count')).toHaveText('3,000');

  // Selection algebra is store-owned and remains live while the GPU is gone.
  // Inverting the old full selection against the new model selects exactly
  // the 500 arrivals; those fresh indices must be mapped during full replay.
  await page.getByRole('button', { name: 'Invert' }).click();
  await expect(page.getByTestId('selected-count')).toHaveText('500');

  const lostModel = await numericAttribute(status, 'data-model-revision');
  const lostRender = await numericAttribute(status, 'data-render-revision');
  const lostApplied = await numericAttribute(status, 'data-applied-render-revision');
  expect(lostModel).toBe(initialModel + 1);
  expect(lostRender).toBeGreaterThan(initialRender);
  expect(lostApplied).toBe(initialApplied);
  expect(lostApplied).toBeLessThan(lostRender);

  await page.evaluate(() => {
    const probeWindow = window as ContextLossProbeWindow;
    const restore = probeWindow.__orbitRestoreLostContext;
    if (restore === undefined) throw new Error('context restore callback was not retained');
    restore();
    delete probeWindow.__orbitRestoreLostContext;
  });

  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await expect(page.getByTestId('node-count')).toHaveText('3,500');
  await expect(page.locator('canvas[data-context-loss-probe="original"]')).toHaveCount(0);
  // Exactly one ENGINE canvas (the replacement) — the minimap contributes
  // its own, separate 2D canvas outside the engine host.
  await expect(page.locator('[data-orbit-canvas] canvas')).toHaveCount(1);
  await expect(page.getByTestId('selected-count')).toHaveText('500');
  expect(await zoomValue(page)).toBe(replayZoom);

  const restoredModel = await numericAttribute(status, 'data-model-revision');
  const restoredRender = await numericAttribute(status, 'data-render-revision');
  const restoredApplied = await numericAttribute(status, 'data-applied-render-revision');
  expect(restoredModel).toBe(lostModel);
  expect(restoredRender).toBe(lostRender);
  expect(restoredApplied).toBe(restoredRender);

  // Pause the recovered force simulation before the input phase: on CI's
  // software rasterizer the post-recovery reheat (alpha ≤ 0.1) plus the
  // chart strip saturates the runner enough to starve wheel delivery (the
  // same failure mode the ingestion spec hit — see its CI note). Input
  // handling is what this assertion proves; it does not need a live sim.
  const pauseSim = page.getByRole('button', { name: 'Pause simulation' });
  if ((await pauseSim.count()) > 0) {
    await pauseSim.click();
  }

  // A real browser wheel gesture must be handled by the newly-created
  // canvas. Besides proving its input listeners were reattached, requiring
  // the resulting value to advance from the known replay zoom verifies that
  // Cosmos itself (not just the React store) resumed from the restored camera.
  // The whole gesture lives inside the poll: DOM labels can still slide
  // under a point chosen an instant earlier (TOCTOU) and swallow a single
  // wheel. Each iteration re-picks a currently-unobstructed point and
  // wheels again until the zoom demonstrably advances.
  await expect
    .poll(
      async () => {
        const inputPoint = await unobstructedCanvasPoint(page);
        await page.mouse.move(inputPoint.x, inputPoint.y);
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(150);
        return zoomValue(page);
      },
      {
        message: 'replacement canvas should handle wheel input from the replayed viewport',
        timeout: 20_000,
      },
    )
    .toBeGreaterThan(replayZoom);

  await expect(page.getByText(/^engine error:/)).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
