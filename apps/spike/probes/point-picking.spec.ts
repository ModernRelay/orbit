/**
 * point-picking — a click at `spaceToScreenPosition(point)` must deliver the
 * exact point index through `onPointClick`/`onClick`; a background click must
 * deliver `undefined` (recorded as `null`) with no point event.
 */
import { test, expect } from '@playwright/test';
import { openWorkbench, waitFrames, hoverAt } from './util';
import { recordProbe, evidencePath } from './record';

test('point-picking: exact index on hit, undefined on miss', async ({ page }) => {
  await openWorkbench(page);

  await page.evaluate(async () => {
    const s = window.__spike;
    await s.init({
      enableSimulation: false,
      fitViewOnInit: false,
      rescalePositions: false,
      backgroundColor: '#101018',
      pointDefaultColor: '#ff4040',
      pointDefaultSize: 16,
    });
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    const scene = s.fixtures.grid(25);
    g.setPointPositions(scene.positions);
    g.setPointColors(scene.colors);
    g.setLinks(scene.links);
    g.render(0);
    g.fitView(0, 0.1, false);
  });
  await waitFrames(page, 10);
  await page.waitForTimeout(300);

  const targetIndex = 12; // center of the 5x5 grid
  const target = await page.evaluate((idx) => window.__spike.spaceToScreen(idx), targetIndex);

  // Hit: hover first so cosmos's frame-loop hover detection latches the point.
  await hoverAt(page, target[0], target[1]);
  await page.mouse.click(target[0], target[1]);
  await page.waitForTimeout(150);

  const afterHit = await page.evaluate(() => ({
    pointClicks: window.__spike.sinks.pointClicks.map((e) => e.index),
    clicks: window.__spike.sinks.clicks.map((e) => e.index),
  }));

  // Miss: top-left corner is empty after fitView with 10% padding.
  const miss: [number, number] = [8, 8];
  await hoverAt(page, miss[0], miss[1]);
  await page.mouse.click(miss[0], miss[1]);
  await page.waitForTimeout(150);

  const afterMiss = await page.evaluate(() => ({
    pointClicks: window.__spike.sinks.pointClicks.map((e) => e.index),
    clicks: window.__spike.sinks.clicks.map((e) => e.index),
  }));

  const screenshot = evidencePath('point-picking', 'scene.png');
  await page.screenshot({ path: screenshot });

  const hitDelivered = afterHit.pointClicks.length === 1 && afterHit.pointClicks[0] === targetIndex;
  const hitOnClickIndex = afterHit.clicks[afterHit.clicks.length - 1] ?? null;
  const missClickEntry = afterMiss.clicks[afterMiss.clicks.length - 1];
  const missDeliveredUndefined =
    afterMiss.clicks.length === afterHit.clicks.length + 1 &&
    missClickEntry === null &&
    afterMiss.pointClicks.length === afterHit.pointClicks.length;

  const pass = hitDelivered && hitOnClickIndex === targetIndex && missDeliveredUndefined;

  recordProbe({
    capability: 'point-picking',
    expected:
      'Click at spaceToScreenPosition(point) delivers that exact index via onPointClick and ' +
      'onClick; a background click delivers undefined via onClick and no onPointClick.',
    observed: {
      targetIndex,
      targetScreen: target,
      pointClickIndices: afterMiss.pointClicks,
      onClickIndices: afterMiss.clicks,
      hitDelivered,
      missDeliveredUndefined,
    },
    pass,
    evidence: [screenshot],
    notes:
      'Static 5x5 grid (enableSimulation: false, rescalePositions: false, pixelRatio 1). ' +
      'Cosmos resolves clicks from its frame-loop hover state (checked at most every 4 frames ' +
      'while the pointer is on the canvas), so the probe hovers and waits >4 frames before clicking.',
  });

  expect(pass).toBe(true);
});
