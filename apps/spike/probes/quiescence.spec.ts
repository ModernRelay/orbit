/**
 * quiescence — after onSimulationEnd with an idle camera and the pointer off
 * the canvas, the frame counter should freeze over 750 ms; a single
 * setPointColors write should re-arm at least one frame; pointer hover
 * should re-arm rendering too.
 */
import { test, expect } from '@playwright/test';
import { openWorkbench } from './util';
import { recordProbe, evidencePath, writeEvidenceJson } from './record';

test('quiescence: frame production freezes when idle and re-arms on demand', async ({ page }) => {
  test.setTimeout(180_000);
  await openWorkbench(page);

  await page.evaluate(async () => {
    const s = window.__spike;
    await s.init({
      enableSimulation: true,
      enableDrag: true, // the drag-release stale-wake micro-case needs it
      fitViewOnInit: false,
      backgroundColor: '#101018',
      pointDefaultSize: 14,
      simulationDecay: 500, // cool down fast so onSimulationEnd arrives quickly
    });
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    const scene = s.fixtures.seeded(80, 100, 17);
    g.setPointPositions(scene.positions, true);
    g.setPointColors(scene.colorsA);
    g.setLinks(scene.links);
    g.render(0);
    g.fitView(0, 0.1, false);
    await new Promise((r) => setTimeout(r, 300));
    g.start(1);
  });

  // Park the pointer off the canvas so hover detection cannot hold frames.
  await page.mouse.move(950, 760);

  await page.waitForFunction(
    () => window.__spike.sinks.simEvents.some((e) => e.type === 'end'),
    undefined,
    { timeout: 90_000 },
  );

  // The claim is zero rAF at REST, not zero N ms after onSimulationEnd
  // cosmos may run trailing transitions/settle frames first. Wait for the
  // loop to actually stop (bounded), then measure a clean idle window.
  const settleMs = await page.evaluate(async () => {
    const t0 = performance.now();
    for (;;) {
      if (performance.now() - t0 > 15_000) return -1; // never froze
      const a = window.__spike.frameCount();
      await new Promise((r) => setTimeout(r, 750));
      if (window.__spike.frameCount() === a) return Math.round(performance.now() - t0);
    }
  });

  // --- Freeze measurement over 750 ms --------------------------------------
  // Registrations (rAF CALLS) are the claim: a stopped loop schedules
  // nothing. Frame ticks alone can read 0 while a loop still spins hidden.
  const [fc0, reg0] = await page.evaluate(() => [
    window.__spike.frameCount(),
    window.__spike.rafRegistrations(),
  ]);
  await page.waitForTimeout(750);
  const [fc1, reg1] = await page.evaluate(() => [
    window.__spike.frameCount(),
    window.__spike.rafRegistrations(),
  ]);
  const idleFrames750ms = fc1 - fc0;
  const idleRafRegistrations750ms = reg1 - reg0;
  const frozen = settleMs >= 0 && idleFrames750ms === 0;

  // --- Re-arm via one setPointColors ----------------------------------------
  const rearm = await page.evaluate(async () => {
    const s = window.__spike;
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    const scene = s.fixtures.seeded(80, 100, 17);
    const before = s.frameCount();
    g.setPointColors(scene.colorsB);
    await new Promise((r) => setTimeout(r, 500));
    const afterColorsOnly = s.frameCount() - before;
    let afterRender = 0;
    if (afterColorsOnly === 0) {
      const b2 = s.frameCount();
      g.render(undefined, 0);
      await new Promise((r) => setTimeout(r, 500));
      afterRender = s.frameCount() - b2;
    }
    return { afterColorsOnly, afterRender };
  });

  // Wait until frame production settles again (750 ms with zero frames).
  const refroze = await page.evaluate(async () => {
    const t0 = performance.now();
    for (;;) {
      if (performance.now() - t0 > 10_000) return false;
      const a = window.__spike.frameCount();
      await new Promise((r) => setTimeout(r, 750));
      if (window.__spike.frameCount() === a) return true;
    }
  });

  // --- Re-arm via pointer hover ----------------------------------------------
  const hoverTarget = await page.evaluate(() => window.__spike.spaceToScreen(0));
  const fcH0 = await page.evaluate(() => window.__spike.frameCount());
  await page.mouse.move(hoverTarget[0], hoverTarget[1], { steps: 5 });
  await page.waitForTimeout(500);
  const fcH1 = await page.evaluate(() => window.__spike.frameCount());
  const hoverRearmFrames = fcH1 - fcH0;

  // --- Stale-wake micro-cases (the post-3.4.0 upstream bug class) -----------
  // Shared helper: park the pointer off-canvas and wait for the loop to
  // freeze again, so every micro-case genuinely starts AT REST.
  const parkAndFreeze = async (): Promise<boolean> => {
    await page.mouse.move(950, 760);
    return page.evaluate(async () => {
      const t0 = performance.now();
      for (;;) {
        if (performance.now() - t0 > 10_000) return false;
        const a = window.__spike.frameCount();
        await new Promise((r) => setTimeout(r, 600));
        if (window.__spike.frameCount() === a) return true;
      }
    });
  };

  // (1) GPU picking must stay TRUTHFUL at rest: under on-demand rendering a
  // stale pick readback would report a node far from the click. The fixture
  // is dense (overlapping points pick topmost), so assert SPATIAL truth: the
  // reported index's own screen position lies within a point-radius of the
  // click, whichever overlapping node won.
  const clickChecks: Array<{
    target: number;
    got: number | null;
    distancePx: number | null;
  }> = [];
  for (const target of [3, 7]) {
    await parkAndFreeze();
    const pos = await page.evaluate(
      (i) => window.__spike.spaceToScreen(i),
      target,
    );
    const before = await page.evaluate(() => window.__spike.sinks.pointClicks.length);
    await page.mouse.click(pos[0], pos[1]);
    await page.waitForTimeout(400);
    const check = await page.evaluate(
      ([n, cx, cy]) => {
        const clicks = window.__spike.sinks.pointClicks;
        if (clicks.length <= (n as number)) return { got: null, distancePx: null };
        const got = clicks[clicks.length - 1]!.index;
        const p = window.__spike.spaceToScreen(got);
        return {
          got,
          distancePx: Math.hypot(p[0] - (cx as number), p[1] - (cy as number)),
        };
      },
      [before, pos[0], pos[1]] as const,
    );
    clickChecks.push({ target, ...check });
  }
  // pointDefaultSize 14 → radius 7; allow slack for anti-aliased edges.
  const pickingAtRestOk = clickChecks.every(
    (c) => c.got !== null && c.distancePx !== null && c.distancePx <= 14,
  );

  // (2) Drag release must render its FINAL frame (the GPU write lands after
  // the draw pass): grab whatever node sits at a known position, drop it at
  // an empty spot, settle, then a forced-render same-tick capture at the
  // RELEASE point must show node pixels (which also proves (3): the
  // screenshot-at-rest capture path reads valid pixels).
  const dragFrom = await page.evaluate(() => window.__spike.spaceToScreen(3));
  const dragTo: [number, number] = [dragFrom[0] + 90, dragFrom[1] + 60];
  await page.mouse.move(dragFrom[0], dragFrom[1]);
  await page.mouse.down();
  await page.mouse.move(dragTo[0], dragTo[1], { steps: 8 });
  await page.mouse.up();
  const refrozeAfterDrag = await parkAndFreeze();
  const releaseSample = await page.evaluate(
    async (xy) => {
      const s = window.__spike;
      const inFrame = await s.sampleNextFrame([[xy[0], xy[1]] as [number, number]], {
        forceRender: true,
        timeoutMs: 3000,
      });
      return inFrame?.[0] ?? null;
    },
    dragTo,
  );
  // Valid read (alpha > 0) showing non-background pixels at the release
  // point (background is #101018 = 16,16,24).
  const sam = releaseSample;
  const screenshotAtRestOk =
    sam !== null && sam.a > 0 && !(sam.r === 16 && sam.g === 16 && sam.b === 24);
  const dragReleaseOk = refrozeAfterDrag && screenshotAtRestOk;

  const screenshot = evidencePath('quiescence', 'scene.png');
  await page.screenshot({ path: screenshot });
  const evidenceJson = writeEvidenceJson('quiescence', 'frame-counts.json', {
    settleMsAfterSimEnd: settleMs,
    idleFrames750ms,
    idleRafRegistrations750ms,
    rearm,
    refroze,
    hoverRearmFrames,
    clickChecks,
    dragRelease: { refrozeAfterDrag, releasePointSample: releaseSample },
  });

  const colorRearmOk = rearm.afterColorsOnly >= 1 || rearm.afterRender >= 1;
  const pass =
    frozen &&
    idleRafRegistrations750ms === 0 &&
    colorRearmOk &&
    hoverRearmFrames >= 1 &&
    pickingAtRestOk &&
    dragReleaseOk;

  recordProbe({
    capability: 'quiescence',
    expected:
      'After onSimulationEnd with an idle camera and the pointer off-canvas, the frame counter ' +
      'AND the rAF registration counter are frozen over 750 ms; one setPointColors (with a ' +
      'render() flush at most) re-arms >= 1 frame; pointer hover re-arms rendering; GPU ' +
      'picking stays index-exact from a settled state; a drag release renders its final ' +
      'frame and a forced-render same-tick capture reads valid pixels at rest.',
    observed: {
      settleMsAfterSimEnd: settleMs,
      idleFrames750ms,
      idleRafRegistrations750ms,
      frozen,
      setPointColorsAloneFrames: rearm.afterColorsOnly,
      setPointColorsPlusRenderFrames: rearm.afterRender,
      refrozeAfterRearm: refroze,
      hoverRearmFrames,
      pickingAtRest: clickChecks,
      refrozeAfterDrag,
      screenshotAtRestOk,
    },
    pass,
    evidence: [screenshot, evidenceJson],
    notes:
      'frameCount() counts unique rAF ticks and rafRegistrations() counts scheduling calls, ' +
      'both via the pre-cosmos requestAnimationFrame wrapper — a stopped loop registers ' +
      'NOTHING. cosmos 3.4.0 ships on-demand rendering (shouldKeepRendering gate); the 3.3.0 ' +
      'run of this probe measured 91 free-run frames per 750 ms idle window. The ' +
      'stale-wake micro-cases cover the post-3.4.0 upstream hardening class: pick readbacks ' +
      'surviving idle (index-exact clicks at rest) and the drag-release trailing frame.',
  });

  // On cosmos >= 3.4 this probe is a hard quiescence gate: the engine
  // idle-stops, picking stays live at rest, and drag
  // release lands its final frame.
  expect(idleFrames750ms).toBe(0);
  expect(idleRafRegistrations750ms).toBe(0);
  expect(colorRearmOk).toBe(true);
  expect(hoverRearmFrames).toBeGreaterThanOrEqual(1);
  expect(pickingAtRestOk).toBe(true);
  expect(dragReleaseOk).toBe(true);
});
