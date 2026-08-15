/**
 * Fixed-drift probe for an initially fixed layout: does Cosmos integrate
 * positions when data is delivered WITHOUT an explicit start? The adapter
 * never sets `enableSimulation` (cosmos default governs) and the core's
 * initially-fixed ready path issues a no-restart commit and never pauses.
 * If positions move here, the core must pause on that path; if they hold,
 * the pause is still cheap insurance but the drift claim was theoretical.
 */
import { test, expect } from '@playwright/test';
import { openWorkbench } from './util';
import { recordProbe, writeEvidenceJson } from './record';

test('fixed-drift: no start() — do positions move under the cosmos default config?', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openWorkbench(page);

  const result = await page.evaluate(async () => {
    const s = window.__spike;
    // Mirror the ADAPTER's config surface: enableSimulation is NOT set
    // whatever cosmos defaults to is what an initially-fixed mount gets.
    await s.init({
      enableDrag: false,
      fitViewOnInit: false,
      backgroundColor: '#101018',
      pointDefaultSize: 14,
    });
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    const scene = s.fixtures.seeded(120, 160, 23);
    g.setPointPositions(scene.positions, true);
    g.setPointColors(scene.colorsA);
    g.setLinks(scene.links);
    g.render(0); // the commit path always renders once — but NO start()
    await new Promise((r) => setTimeout(r, 500));

    const read = (): number[] => {
      const p = g.getPointPositions();
      return Array.from(p.slice(0, 40)); // 20 points is plenty of witness
    };
    const before = read();
    await new Promise((r) => setTimeout(r, 2_500));
    const after = read();

    let maxDelta = 0;
    for (let i = 0; i < before.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(after[i]! - before[i]!));
    }
    return { maxDelta, sample: { before: before.slice(0, 6), after: after.slice(0, 6) } };
  });

  writeEvidenceJson('fixed-drift', 'fixed-drift.json', {
    probe: 'fixed-drift',
    question:
      'cosmos default config, positions set, render() called, start() NEVER called — drift over 2.5s?',
    maxDeltaPx: result.maxDelta,
    sample: result.sample,
    verdict: result.maxDelta > 0.5 ? 'DRIFTS — core must pause on initially-fixed' : 'HOLDS',
  });
  recordProbe({
    capability: 'fixed-drift',
    expected: 'positions HOLD without start() (else the core must pause on initially-fixed mounts)',
    observed: { maxDeltaPx: result.maxDelta, drifts: result.maxDelta > 0.5 },
    pass: result.maxDelta <= 0.5,
    notes: 'either outcome is evidence; pass tracks the HOLDS hypothesis',
  });

  // The probe RECORDS; the number decides the core fix. No budget assertion
  // either outcome is evidence.
  expect(result.maxDelta).toBeGreaterThanOrEqual(0);
});
