/**
 * native-pinning — setPinnedPoints([a, b]) must hold those points bit-stable
 * across 60 simulation frames while unpinned points move; setPinnedPoints([])
 * frees them; repeated calls are idempotent; null behaves like [].
 */
import { test, expect } from '@playwright/test';
import { openWorkbench } from './util';
import { recordProbe, evidencePath, writeEvidenceJson } from './record';

test('native-pinning: bit-stable pinned points during simulation', async ({ page }) => {
  await openWorkbench(page);

  const result = await page.evaluate(async () => {
    const s = window.__spike;
    await s.init({
      enableSimulation: true,
      fitViewOnInit: false,
      backgroundColor: '#101018',
      pointDefaultColor: '#ff4040',
      pointDefaultSize: 8,
    });
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    const scene = s.fixtures.seeded(200, 250, 11);
    g.setPointPositions(scene.positions, true);
    g.setPointColors(scene.colorsA);
    g.setLinks(scene.links);
    g.render(0);
    g.fitView(0, 0.1, false);
    await new Promise((r) => setTimeout(r, 300));

    const a = 10;
    const b = 137;
    s.pin([a, b]);
    s.pin([a, b]); // repeat-call idempotence: same call twice must be harmless

    const readPoint = (positions: number[], i: number): [number, number] => [
      positions[i * 2] ?? NaN,
      positions[i * 2 + 1] ?? NaN,
    ];
    const p0 = g.getPointPositions();
    const a0 = readPoint(p0, a);
    const b0 = readPoint(p0, b);

    const waitFramesInPage = (n: number): Promise<void> =>
      new Promise((resolve) => {
        let count = 0;
        let last = -1;
        const off = s.onFrame((frame) => {
          if (frame === last) return;
          last = frame;
          count += 1;
          if (count >= n) {
            off();
            resolve();
          }
        });
      });

    g.start(1);

    // 60 frames in 6 reads of 10; re-call setPinnedPoints mid-run (read 3).
    const reads: Array<{
      framesElapsed: number;
      aStable: boolean;
      bStable: boolean;
      movedFraction: number;
    }> = [];
    let framesElapsed = 0;
    for (let readIdx = 0; readIdx < 6; readIdx += 1) {
      await waitFramesInPage(10);
      framesElapsed += 10;
      const p = g.getPointPositions();
      const aNow = readPoint(p, a);
      const bNow = readPoint(p, b);
      let moved = 0;
      let total = 0;
      for (let i = 0; i < 200; i += 1) {
        if (i === a || i === b) continue;
        total += 1;
        const dx = (p[i * 2] ?? NaN) - (p0[i * 2] ?? NaN);
        const dy = (p[i * 2 + 1] ?? NaN) - (p0[i * 2 + 1] ?? NaN);
        if (Math.hypot(dx, dy) > 0.5) moved += 1;
      }
      reads.push({
        framesElapsed,
        aStable: aNow[0] === a0[0] && aNow[1] === a0[1],
        bStable: bNow[0] === b0[0] && bNow[1] === b0[1],
        movedFraction: moved / total,
      });
      if (readIdx === 2) s.pin([a, b]); // idempotent re-call mid-simulation
    }

    // Free the pins and confirm a and b start moving.
    s.pin([]);
    g.start(1);
    await waitFramesInPage(30);
    const pAfter = g.getPointPositions();
    const aAfter = readPoint(pAfter, a);
    const bAfter = readPoint(pAfter, b);
    const aMovedAfterUnpin = Math.hypot(aAfter[0] - a0[0], aAfter[1] - a0[1]) > 0.5;
    const bMovedAfterUnpin = Math.hypot(bAfter[0] - b0[0], bAfter[1] - b0[1]) > 0.5;

    // null must behave like [] (no throw, everything stays free).
    let nullOk = true;
    try {
      s.pin(null);
    } catch {
      nullOk = false;
    }

    g.pause();
    return {
      a,
      b,
      a0,
      b0,
      reads,
      aMovedAfterUnpin,
      bMovedAfterUnpin,
      nullOk,
    };
  });

  const screenshot = evidencePath('native-pinning', 'scene.png');
  await page.screenshot({ path: screenshot });
  const readsEvidence = writeEvidenceJson('native-pinning', 'stability-reads.json', result);

  const pinnedStable = result.reads.every((r) => r.aStable && r.bStable);
  const othersMoved = (result.reads[result.reads.length - 1]?.movedFraction ?? 0) > 0.5;
  const pass =
    pinnedStable && othersMoved && result.aMovedAfterUnpin && result.bMovedAfterUnpin && result.nullOk;

  recordProbe({
    capability: 'native-pinning',
    expected:
      'setPinnedPoints([a,b]) holds a and b bit-stable (exact float equality) across 60 ' +
      'simulation frames while unpinned points move; setPinnedPoints([]) frees them; ' +
      'repeated calls (including mid-simulation) are idempotent; null behaves like [].',
    observed: {
      pinnedStableAcross60Frames: pinnedStable,
      perReadStability: result.reads,
      movedFractionAtFrame60: result.reads[result.reads.length - 1]?.movedFraction ?? 0,
      movedAfterUnpin: { a: result.aMovedAfterUnpin, b: result.bMovedAfterUnpin },
      setPinnedPointsNullOk: result.nullOk,
    },
    pass,
    evidence: [screenshot, readsEvidence],
    notes:
      '200-point seeded scene, start(1), positions read back via getPointPositions every 10 ' +
      'frames and compared with exact equality (Float32 bit-stability). setPinnedPoints was ' +
      'called twice up front and re-called with the same list at frame 30 to check idempotence.',
  });

  expect(pass).toBe(true);
});
