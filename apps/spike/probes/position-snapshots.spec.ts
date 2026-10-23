/** The adapter relies on Cosmos 3.5's flat readback being an owned snapshot. */
import { test, expect } from '@playwright/test';
import { openWorkbench } from './util';
import { recordProbe } from './record';

test('position-snapshots: flat readbacks stay owned across reads and roster updates', async ({ page }) => {
  await openWorkbench(page);
  const result = await page.evaluate(async () => {
    const s = window.__spike;
    await s.init({ enableSimulation: false, fitViewOnInit: false, rescalePositions: false });
    const g = s.graph;
    if (!g) throw new Error('graph missing');

    const initial = Float32Array.of(100, 200, NaN, NaN, 300, 400);
    g.setPointPositions(initial, true);
    g.render(0, 0);
    await s.sampleNextFrame([]);
    const first = g.getPointPositionsArray();
    const same = (a: Float32Array, b: Float32Array): boolean =>
      a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    const initialOk = first instanceof Float32Array && same(first, initial);

    // Mirror the core's pinned-coordinate overlay on a caller-owned snapshot.
    first[0] = 999;
    const second = g.getPointPositionsArray();
    const independentReads = first.buffer !== second.buffer && same(second, initial);
    const firstExpected = Float32Array.of(999, 200, NaN, NaN, 300, 400);

    const replacement = Float32Array.of(10, 20);
    g.setPointPositions(replacement, true);
    g.render(0, 0);
    await s.sampleNextFrame([]);
    const current = g.getPointPositionsArray();
    const replacementOk = same(current, replacement);
    const oldSnapshotsStable = same(first, firstExpected) && same(second, initial);
    return { initialOk, independentReads, replacementOk, oldSnapshotsStable };
  });

  recordProbe({
    capability: 'position-snapshots',
    expected: 'getPointPositionsArray() returns owned Float32 snapshots, preserves NaN tombstones, ' +
      'and keeps earlier snapshots unchanged across caller mutations, later reads and roster replacement.',
    observed: result,
    pass: Object.values(result).every(Boolean),
    notes: 'No reusable out array is passed; Orbit callers may mutate their snapshot to overlay pinned coordinates.',
  });
  expect(result).toEqual({
    initialOk: true, independentReads: true, replacementOk: true, oldSnapshotsStable: true,
  });
});
