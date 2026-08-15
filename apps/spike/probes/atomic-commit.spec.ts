/**
 * atomic-commit — a mid-simulation A→B scene swap applied as one synchronous
 * batch (setPointPositions + setPointColors + setLinks + render) must never
 * produce a torn frame: classifying 120 frames via pinned sentinel pixels
 * must yield only A frames, then only B frames, with zero MIXED frames.
 *
 * A calibration pass (static two-color scene) validates the same-tick
 * drawImage pixel sampler before the measurement is trusted.
 */
import { test, expect } from '@playwright/test';
import { openWorkbench, isRed, isBlue } from './util';
import { recordProbe, evidencePath, writeEvidenceJson } from './record';
import type { RGBALike } from './util';

test('atomic-commit: zero MIXED frames across a batched A/B swap', async ({ page }) => {
  test.setTimeout(180_000);
  await openWorkbench(page);

  // --- Calibration: validate the sampler on a static two-color scene -------
  const calibration = await page.evaluate(async () => {
    const s = window.__spike;
    await s.init({
      enableSimulation: false,
      fitViewOnInit: false,
      rescalePositions: false,
      backgroundColor: '#101018',
      pointDefaultSize: 40,
    });
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    g.setPointPositions(new Float32Array([1200, 2048, 2900, 2048]));
    g.setPointColors(new Float32Array([1, 0.08, 0.08, 1, 0.08, 0.08, 1, 1]));
    g.render(0);
    g.fitView(0, 0.3, false);
    await new Promise((r) => setTimeout(r, 300));
    const coords: Array<[number, number]> = [s.spaceToScreen(0), s.spaceToScreen(1)];
    const colors = await s.sampleNextFrame(coords);
    return { coords, colors };
  });

  const calColors = calibration.colors ?? [];
  const c0 = calColors[0];
  const c1 = calColors[1];
  const calibrationOk = !!c0 && !!c1 && isRed(c0) && isBlue(c1);

  const calibrationShot = evidencePath('atomic-commit', 'calibration.png');
  await page.screenshot({ path: calibrationShot });

  // --- Main measurement -----------------------------------------------------
  const run = await page.evaluate(async () => {
    const s = window.__spike;
    await s.init({
      enableSimulation: true,
      fitViewOnInit: false,
      rescalePositions: false,
      backgroundColor: '#101018',
    });
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    const scene = s.fixtures.sentinelScene(300, 150, 21);
    g.setPointPositions(scene.positions, true);
    g.setPointColors(scene.colorsA);
    g.setLinks(scene.links);
    g.setPointSizes(scene.sizes);
    g.render(0);
    g.fitView(0, 0.05, false);
    await new Promise((r) => setTimeout(r, 400));
    s.pin(scene.sentinelIndices);

    const coords = scene.sentinelSpacePositions.map(([x, y]) => s.spaceToScreenXY(x, y));

    g.start(1);
    const samplerId = s.registerFrameSampler(coords);

    const waitForSamples = (count: number): Promise<void> =>
      new Promise((resolve) => {
        const off = s.onFrame(() => {
          if (s.readSampler(samplerId).length >= count) {
            off();
            resolve();
          }
        });
      });

    await waitForSamples(20);
    const commitFrame = s.frameCount();
    // The commit: one synchronous batch, mid-simulation.
    s.applyCommit({
      positions: scene.positionsB,
      colors: scene.colorsB,
      links: scene.linksB,
    });
    // Same synchronous task (still pre-frame): keep the sentinels pinned in
    // case a full position upload resets the pinned set.
    s.pin(scene.sentinelIndices);

    await waitForSamples(140);
    s.stopSampler(samplerId);
    g.pause();
    return {
      commitFrame,
      sentinelScreen: coords,
      samples: s.readSampler(samplerId),
    };
  });

  const postCommitShot = evidencePath('atomic-commit', 'post-commit.png');
  await page.screenshot({ path: postCommitShot });

  // --- Classification ---------------------------------------------------------
  type FrameClass = 'A' | 'B' | 'MIXED';
  const classify = (colors: RGBALike[]): FrameClass => {
    const reds = colors.filter((c) => isRed(c)).length;
    const blues = colors.filter((c) => isBlue(c)).length;
    if (reds === colors.length) return 'A';
    if (blues === colors.length) return 'B';
    return 'MIXED';
  };

  const timeline = run.samples.map((sample) => ({
    frame: sample.frame,
    class: classify(sample.colors),
  }));

  const mixedFrames = timeline.filter((t) => t.class === 'MIXED');
  const aFrames = timeline.filter((t) => t.class === 'A').length;
  const bFrames = timeline.filter((t) => t.class === 'B').length;
  const firstB = timeline.find((t) => t.class === 'B')?.frame ?? null;
  // Monotonic: once B appears, no A frame may follow.
  let monotonic = true;
  let seenB = false;
  for (const t of timeline) {
    if (t.class === 'B') seenB = true;
    else if (t.class === 'A' && seenB) monotonic = false;
  }

  const timelineEvidence = writeEvidenceJson('atomic-commit', 'frame-classification.json', {
    calibration,
    commitFrame: run.commitFrame,
    sentinelScreen: run.sentinelScreen,
    timeline,
    samples: run.samples,
  });

  const pass =
    calibrationOk && mixedFrames.length === 0 && aFrames > 0 && bFrames > 0 && monotonic;

  recordProbe({
    capability: 'atomic-commit',
    expected:
      'A mid-simulation scene swap batched as setPointPositions + setPointColors + setLinks + ' +
      'render(undefined, 0) in one task commits atomically: per-frame sentinel classification ' +
      'over 120+ frames shows only A frames then only B frames — zero MIXED frames.',
    observed: {
      calibrationOk,
      calibrationColors: calColors,
      framesClassified: timeline.length,
      aFrames,
      bFrames,
      mixedFrames: mixedFrames.length,
      mixedFrameNumbers: mixedFrames.map((t) => t.frame).slice(0, 20),
      commitFrame: run.commitFrame,
      firstBFrame: firstB,
      monotonicSwitch: monotonic,
    },
    pass,
    evidence: [calibrationShot, postCommitShot, timelineEvidence],
    notes:
      'Four pinned size-36 sentinels at the space corners have identical positions in states A ' +
      'and B and only change color (red -> blue) with the commit; every other point/link stays ' +
      'in the center band so nothing else touches the sentinel pixels. Sampling happens ' +
      'synchronously inside the same rAF tick as the engine draw (drawImage of the WebGL ' +
      'canvas into a 2D canvas before compositing) — the atomic-commit capture method. The ' +
      'calibration pass validates that pipeline before the measurement counts.',
  });

  expect(pass).toBe(true);
});
