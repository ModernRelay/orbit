/**
 * context-loss — force a WebGL context loss via WEBGL_lose_context, record
 * which canvas events surface and whether rendering revives on
 * restoreContext alone, then determine the minimal replay set (positions,
 * colors, links, config) needed to restore pre-loss pixels. evidence.
 */
import { test, expect } from '@playwright/test';
import { openWorkbench, approxEquals } from './util';
import type { RGBALike } from './util';
import { recordProbe, evidencePath, writeEvidenceJson } from './record';

function matchFraction(colors: RGBALike[] | null, ref: RGBALike[]): number {
  if (!colors || colors.length !== ref.length || ref.length === 0) return 0;
  let matched = 0;
  for (let i = 0; i < ref.length; i += 1) {
    const c = colors[i];
    const r = ref[i];
    if (c && r && c.a > 128 && approxEquals(c, r, 30)) matched += 1;
  }
  return matched / ref.length;
}

test('context-loss: surfaced events, revive-on-restore, minimal replay set', async ({ page }) => {
  test.setTimeout(180_000);
  await openWorkbench(page);

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });

  // --- Baseline scene ---------------------------------------------------------
  const setup = await page.evaluate(async () => {
    const s = window.__spike;
    await s.init({
      enableSimulation: false,
      fitViewOnInit: false,
      rescalePositions: false,
      backgroundColor: '#101018',
      pointDefaultColor: '#ff4040',
      pointDefaultSize: 14,
      linkDefaultColor: '#40ff40',
      linkDefaultWidth: 3,
      linkVisibilityDistanceRange: [1e6, 2e6],
    });
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    const scene = s.fixtures.grid(36);
    g.setPointPositions(scene.positions);
    g.setPointColors(scene.colors);
    g.setLinks(scene.links);
    g.render(0);
    g.fitView(0, 0.1, false);
    await new Promise((r) => setTimeout(r, 300));
    const coords: Array<[number, number]> = [];
    for (let i = 0; i < 36; i += 1) coords.push(s.spaceToScreen(i));
    const ref = await s.sampleNextFrame(coords);
    return { coords, ref };
  });
  if (!setup.ref) throw new Error('baseline pixel capture failed');
  const ref = setup.ref;

  const preShot = evidencePath('context-loss', 'pre-loss.png');
  await page.screenshot({ path: preShot });

  // --- Lose the context --------------------------------------------------------
  const loss = await page.evaluate(async (coords) => {
    const s = window.__spike;
    const extAvailable = s.loseContext();
    await new Promise((r) => setTimeout(r, 600));
    const colors = await s.sampleNextFrame(coords, { timeoutMs: 800 });
    return {
      extAvailable,
      events: s.sinks.contextEvents.map((e) => e.type),
      postLossColors: colors,
    };
  }, setup.coords);

  const lostShot = evidencePath('context-loss', 'post-loss.png');
  await page.screenshot({ path: lostShot });

  // --- Restore and check revival without any replay -----------------------------
  const restore = await page.evaluate(async (coords) => {
    const s = window.__spike;
    const restored = s.restoreContext();
    await new Promise((r) => setTimeout(r, 1000));
    const colors = await s.sampleNextFrame(coords, { timeoutMs: 1200 });
    return {
      restored,
      events: s.sinks.contextEvents.map((e) => e.type),
      colors,
    };
  }, setup.coords);
  const reviveAloneFraction = matchFraction(restore.colors, ref);
  const revivesOnRestoreAlone = reviveAloneFraction >= 0.9;

  // --- Minimal replay set: re-apply state stepwise until pixels match -----------
  interface StepResult {
    step: string;
    error: string | null;
    matchFraction: number;
  }
  let steps: StepResult[] = [];
  let minimalReplaySet: string[] | null = null;

  if (!revivesOnRestoreAlone) {
    const replay = await page.evaluate(
      async ({ coords, refColors }) => {
        const s = window.__spike;
        const g = s.graph;
        if (!g) throw new Error('graph missing');
        const scene = s.fixtures.grid(36);

        const localMatch = (
          colors: Array<{ r: number; g: number; b: number; a: number }> | null,
        ): number => {
          if (!colors || colors.length !== refColors.length) return 0;
          let ok = 0;
          for (let i = 0; i < refColors.length; i += 1) {
            const c = colors[i];
            const r = refColors[i];
            if (
              c &&
              r &&
              c.a > 128 &&
              Math.abs(c.r - r.r) <= 30 &&
              Math.abs(c.g - r.g) <= 30 &&
              Math.abs(c.b - r.b) <= 30
            ) {
              ok += 1;
            }
          }
          return ok / refColors.length;
        };

        const stepDefs: Array<{ step: string; run: () => void }> = [
          {
            step: 'render',
            run: () => {
              g.render(undefined, 0);
            },
          },
          {
            step: 'render+positions',
            run: () => {
              g.setPointPositions(scene.positions, true);
              g.render(undefined, 0);
            },
          },
          {
            step: 'render+positions+colors',
            run: () => {
              g.setPointPositions(scene.positions, true);
              g.setPointColors(scene.colors);
              g.render(undefined, 0);
            },
          },
          {
            step: 'render+positions+colors+links',
            run: () => {
              g.setPointPositions(scene.positions, true);
              g.setPointColors(scene.colors);
              g.setLinks(scene.links);
              g.render(undefined, 0);
            },
          },
          {
            step: 'render+positions+colors+links+config',
            run: () => {
              if (s.lastConfig) g.setConfigPartial(s.lastConfig);
              g.setPointPositions(scene.positions, true);
              g.setPointColors(scene.colors);
              g.setLinks(scene.links);
              g.render(undefined, 0);
            },
          },
        ];

        const results: Array<{ step: string; error: string | null; matchFraction: number }> = [];
        for (const def of stepDefs) {
          let error: string | null = null;
          try {
            def.run();
          } catch (e) {
            error = String(e);
          }
          await new Promise((r) => setTimeout(r, 350));
          const colors = await s.sampleNextFrame(coords, { timeoutMs: 900 });
          const fraction = localMatch(colors);
          results.push({ step: def.step, error, matchFraction: fraction });
          if (fraction >= 0.9) return { results, recoveredBy: def.step };
        }

        // Last resort: full re-mount (destroy + new Graph + full state).
        let reinitError: string | null = null;
        try {
          if (s.lastConfig) await s.init(s.lastConfig);
          const g2 = s.graph;
          if (!g2) throw new Error('graph missing after re-init');
          g2.setPointPositions(scene.positions);
          g2.setPointColors(scene.colors);
          g2.setLinks(scene.links);
          g2.render(0);
          g2.fitView(0, 0.1, false);
          await new Promise((r) => setTimeout(r, 400));
        } catch (e) {
          reinitError = String(e);
        }
        const colors = await s.sampleNextFrame(coords, { timeoutMs: 1200 });
        const fraction = localMatch(colors);
        results.push({ step: 'full-reinit', error: reinitError, matchFraction: fraction });
        return { results, recoveredBy: fraction >= 0.9 ? 'full-reinit' : null };
      },
      { coords: setup.coords, refColors: ref },
    );
    steps = replay.results;
    if (replay.recoveredBy && replay.recoveredBy !== 'full-reinit') {
      minimalReplaySet = replay.recoveredBy.split('+');
    } else if (replay.recoveredBy === 'full-reinit') {
      minimalReplaySet = ['full-reinit'];
    }
  } else {
    minimalReplaySet = [];
  }

  const finalShot = evidencePath('context-loss', 'post-recovery.png');
  await page.screenshot({ path: finalShot });

  const detailEvidence = writeEvidenceJson('context-loss', 'recovery-detail.json', {
    lossEvents: loss.events,
    restoreEvents: restore.events,
    reviveAloneFraction,
    steps,
    minimalReplaySet,
    pageErrors: pageErrors.slice(0, 40),
    pageErrorCount: pageErrors.length,
  });

  const recovered =
    revivesOnRestoreAlone ||
    (minimalReplaySet !== null && minimalReplaySet[0] !== 'full-reinit');
  const eventsSurfaced = loss.events.includes('lost');
  const pass = loss.extAvailable && eventsSurfaced && recovered;

  recordProbe({
    capability: 'context-loss',
    expected:
      'webglcontextlost/webglcontextrestored surface on the engine canvas; after ' +
      'restoreContext() the scene is recoverable by replaying {positions, colors, links, ' +
      'config} through the already-mounted engine — never a second mount.',
    observed: {
      loseContextExtensionAvailable: loss.extAvailable,
      surfacedEvents: { afterLoss: loss.events, afterRestore: restore.events },
      revivesOnRestoreAlone,
      reviveAloneMatchFraction: Number(reviveAloneFraction.toFixed(3)),
      replaySteps: steps,
      minimalReplaySet,
      pageErrorCount: pageErrors.length,
    },
    pass,
    evidence: [preShot, lostShot, finalShot, detailEvidence],
    notes:
      'Context loss forced via WEBGL_lose_context on the engine canvas (the workbench listener ' +
      'calls preventDefault() on webglcontextlost, as an embedding app must to allow restore). ' +
      'Recovery is judged by 3x3 pixel samples at the 36 grid points matching the pre-loss ' +
      'capture (>=90% of coords within 30/channel). The stepwise replay is cumulative: render ' +
      'alone, then +positions, +colors, +links, +config, then a full destroy/re-mount as the ' +
      'last resort. pass requires recovery WITHOUT the full re-mount; if only full-reinit ' +
      'recovers, the 13.1 no-second-mount protocol is not viable on this engine version.',
  });

  // pass=false is itself valid evidence (recorded, not hidden): it means
  // only full re-init recovers, which the adapter's recreate-on-restore
  // design already assumes. Assert harness integrity instead.
  expect(restore.events).toContain('restored');
  const fullReinit = steps.find((s) => s.step === 'full-reinit');
  expect(fullReinit?.matchFraction ?? 0).toBeGreaterThanOrEqual(0.9);
});
