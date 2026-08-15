/**
 * nan-tombstones — NaN-ing a block of point positions must tombstone them:
 * hit-tests at their last screen coords miss, incident-link pixels render as
 * background, and fitView ignores them (matching a NaN-free control scene).
 */
import { test, expect } from '@playwright/test';
import { openWorkbench, waitFrames, hoverAt, approxEquals } from './util';
import { recordProbe, evidencePath, writeEvidenceJson } from './record';

const BG = { r: 16, g: 16, b: 24, a: 255 };

const INIT_CONFIG = {
  enableSimulation: false,
  fitViewOnInit: false,
  rescalePositions: false,
  backgroundColor: '#101018',
  pointDefaultColor: '#ff4040',
  pointDefaultSize: 14,
  linkDefaultColor: '#40ff40',
  linkDefaultWidth: 4,
  linkVisibilityDistanceRange: [1e6, 2e6],
};

test('nan-tombstones: hit-test, link pixels, fitView', async ({ page }) => {
  await openWorkbench(page);

  // --- Scene with outliers, pre-NaN ----------------------------------------
  const pre = await page.evaluate(async (config) => {
    const s = window.__spike;
    await s.init(config);
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    const scene = s.fixtures.nanScene(true);
    g.setPointPositions(scene.positions);
    g.setLinks(scene.links);
    g.render(0);
    g.fitView(0, 0.1, false);
    await new Promise((r) => setTimeout(r, 300));
    const outlierScreen: Array<[number, number]> = [];
    for (let k = 0; k < scene.outlierN; k += 1) {
      outlierScreen.push(s.spaceToScreen(scene.clusterN + k));
    }
    // Screen midpoints of the incident (straight) links.
    const linkMidScreen: Array<[number, number]> = [];
    for (let k = 0; k < scene.outlierN; k += 1) {
      const a = s.spaceToScreen(scene.clusterN + k);
      const b = s.spaceToScreen(k);
      linkMidScreen.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    const preLinkColors = await s.sampleNextFrame(linkMidScreen);
    return { outlierScreen, linkMidScreen, preLinkColors };
  }, INIT_CONFIG);
  await waitFrames(page, 5);

  const preScreenshot = evidencePath('nan-tombstones', 'pre-nan.png');
  await page.screenshot({ path: preScreenshot });

  // Sanity: pre-NaN, outlier index 35 must be clickable at its screen coords.
  const outlier5 = pre.outlierScreen[5];
  if (!outlier5) throw new Error('missing outlier screen coord');
  await hoverAt(page, outlier5[0], outlier5[1]);
  await page.mouse.click(outlier5[0], outlier5[1]);
  await page.waitForTimeout(150);
  const preHit = await page.evaluate(
    () => window.__spike.sinks.pointClicks[window.__spike.sinks.pointClicks.length - 1]?.index ?? null,
  );

  // --- NaN the outlier block ------------------------------------------------
  await page.evaluate(() => {
    const s = window.__spike;
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    const scene = s.fixtures.nanScene(true);
    const nanPositions = new Float32Array(scene.positions);
    for (let k = 0; k < scene.outlierN; k += 1) {
      nanPositions[(scene.clusterN + k) * 2] = NaN;
      nanPositions[(scene.clusterN + k) * 2 + 1] = NaN;
    }
    g.setPointPositions(nanPositions, true);
    g.render(undefined, 0);
  });
  await waitFrames(page, 10);
  await page.waitForTimeout(200);

  // Post-NaN hit-test at the tombstone's last screen coords must miss.
  const clicksBefore = await page.evaluate(() => ({
    clicks: window.__spike.sinks.clicks.length,
    pointClicks: window.__spike.sinks.pointClicks.length,
  }));
  await hoverAt(page, outlier5[0], outlier5[1]);
  await page.mouse.click(outlier5[0], outlier5[1]);
  await page.waitForTimeout(150);
  const postHit = await page.evaluate(
    ({ clicks, pointClicks }) => {
      const s = window.__spike.sinks;
      return {
        newClicks: s.clicks.slice(clicks).map((e) => e.index),
        newPointClicks: s.pointClicks.slice(pointClicks).map((e) => e.index),
      };
    },
    clicksBefore,
  );

  const postScreenshot = evidencePath('nan-tombstones', 'post-nan.png');
  await page.screenshot({ path: postScreenshot });

  // Incident-link and tombstone pixels must be background now.
  const postPixels = await page.evaluate(
    ({ linkMidScreen, outlierScreen }) =>
      window.__spike.sampleNextFrame([...linkMidScreen, ...outlierScreen]),
    { linkMidScreen: pre.linkMidScreen, outlierScreen: pre.outlierScreen },
  );

  // fitView with tombstones: viewport must match the NaN-free control scene.
  const nanView = await page.evaluate(async () => {
    const s = window.__spike;
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    g.fitView(0, 0.1, false);
    await new Promise((r) => setTimeout(r, 300));
    return { zoom: g.getZoomLevel(), center: s.screenToSpace(400, 300) };
  });

  const controlView = await page.evaluate(async (config) => {
    const s = window.__spike;
    await s.init(config);
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    const scene = s.fixtures.nanScene(false);
    g.setPointPositions(scene.positions);
    g.setLinks(scene.links);
    g.render(0);
    g.fitView(0, 0.1, false);
    await new Promise((r) => setTimeout(r, 300));
    return { zoom: g.getZoomLevel(), center: s.screenToSpace(400, 300) };
  }, INIT_CONFIG);

  // --- Verdict ----------------------------------------------------------------
  const preHitOk = preHit === 35;
  const missOk =
    postHit.newPointClicks.length === 0 &&
    postHit.newClicks.length > 0 &&
    postHit.newClicks.every((i) => i === null);
  const pixels = postPixels ?? [];
  const backgroundOk =
    pixels.length === 20 && pixels.every((c) => approxEquals(c, BG, 20) && c.a > 128);
  const zoomOk = Math.abs(nanView.zoom - controlView.zoom) <= 0.02 * Math.abs(controlView.zoom);
  const centerDist = Math.hypot(
    nanView.center[0] - controlView.center[0],
    nanView.center[1] - controlView.center[1],
  );
  const centerOk = centerDist <= 25;

  const pixelEvidence = writeEvidenceJson('nan-tombstones', 'pixel-samples.json', {
    preLinkColors: pre.preLinkColors,
    postPixels,
    background: BG,
  });

  const pass = preHitOk && missOk && backgroundOk && zoomOk && centerOk;

  recordProbe({
    capability: 'nan-tombstones',
    expected:
      'NaN positions tombstone points in place: hit-tests at their last coords miss ' +
      '(onClick undefined, no onPointClick), incident-link pixels become background, and ' +
      'fitView matches a NaN-free control scene (tombstones excluded from bounds).',
    observed: {
      preNanHitIndex: preHit,
      postNanNewClicks: postHit.newClicks,
      postNanNewPointClicks: postHit.newPointClicks,
      backgroundOk,
      nanView,
      controlView,
      zoomDelta: Math.abs(nanView.zoom - controlView.zoom),
      centerDistSpaceUnits: centerDist,
    },
    pass,
    evidence: [preScreenshot, postScreenshot, pixelEvidence],
    notes:
      '30 clustered points + 10 far outliers with incident links; the outlier block is NaN-ed ' +
      'via a full setPointPositions (dontRescale) + render(undefined, 0) snap with ' +
      'transitionDuration 0. Background is #101018 (non-black) so a failed pixel capture ' +
      '(transparent (0,0,0,0)) cannot masquerade as a passing background check.',
  });

  expect(pass).toBe(true);
});
