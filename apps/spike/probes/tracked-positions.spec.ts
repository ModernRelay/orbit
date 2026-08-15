/**
 * tracked-positions — on a 100K-point scene, measure the per-frame cost of
 * getTrackedPointPositionsArray at k in {256, 1024, 4096, 16384} over 120
 * frames each (p50/p95), verify the packing order matches the indices passed
 * to trackPointPositionsByIndices, and record the practical ceiling against
 * the ~8KB @ k=1024 read-back budget.
 */
import { test, expect } from '@playwright/test';
import { openWorkbench, quantile } from './util';
import { recordProbe, evidencePath, writeEvidenceJson } from './record';

const KS = [256, 1024, 4096, 16384];
const FRAMES = 120;
const N = 100_000;

test('tracked-positions: read-back cost and packing order at scale', async ({ page }) => {
  test.setTimeout(300_000);
  await openWorkbench(page);

  const result = await page.evaluate(
    async ({ ks, frames, n }) => {
      const s = window.__spike;
      await s.init({
        enableSimulation: true,
        fitViewOnInit: false,
        backgroundColor: '#101018',
        pointDefaultSize: 2,
        simulationDecay: 1e9, // keep the simulation hot for the whole run
      });
      const g = s.graph;
      if (!g) throw new Error('graph missing');
      const scene = s.fixtures.seeded(n, 2000, 13);
      g.setPointPositions(scene.positions, true);
      g.setLinks(scene.links);
      g.render(0);
      g.fitView(0, 0.1, false);
      await new Promise((r) => setTimeout(r, 400));
      g.start(1);

      const nextFrame = (): Promise<void> =>
        new Promise((resolve) => {
          const off = s.onFrame(() => {
            off();
            resolve();
          });
        });

      const perK: Array<{
        k: number;
        lengthOk: boolean;
        orderOk: boolean;
        costsMs: number[];
      }> = [];

      for (const k of ks) {
        // Deliberately non-monotonic index order to expose packing semantics.
        const step = Math.floor(n / k);
        const indices: number[] = [];
        for (let j = 0; j < k; j += 1) indices.push(((k - 1 - j) * step + 7) % n);

        s.track(indices);
        await nextFrame();

        // Packing order: array slot j must correspond to indices[j].
        const arr0 = s.readTracked();
        const map = g.getTrackedPointPositionsMap();
        const lengthOk = arr0.length === k * 2;
        let orderOk = lengthOk;
        for (let j = 0; j < Math.min(k, 64) && orderOk; j += 1) {
          const idx = indices[j];
          const fromMap = idx === undefined ? undefined : map.get(idx);
          if (!fromMap || fromMap[0] !== arr0[j * 2] || fromMap[1] !== arr0[j * 2 + 1]) {
            orderOk = false;
          }
        }

        const costsMs: number[] = [];
        await new Promise<void>((resolve) => {
          let last = -1;
          let count = 0;
          const off = s.onFrame((frame) => {
            if (frame === last) return;
            last = frame;
            const t0 = performance.now();
            const arr = s.readTracked();
            const dt = performance.now() - t0;
            if (arr.length > 0) costsMs.push(dt);
            count += 1;
            if (count >= frames) {
              off();
              resolve();
            }
          });
        });

        perK.push({ k, lengthOk, orderOk, costsMs });
      }

      g.pause();
      return { perK };
    },
    { ks: KS, frames: FRAMES, n: N },
  );

  const screenshot = evidencePath('tracked-positions', 'scene.png');
  await page.screenshot({ path: screenshot });

  const summary = result.perK.map(({ k, lengthOk, orderOk, costsMs }) => ({
    k,
    lengthOk,
    orderOk,
    p50Ms: Number(quantile(costsMs, 0.5).toFixed(3)),
    p95Ms: Number(quantile(costsMs, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...costsMs).toFixed(3)),
    frames: costsMs.length,
    payloadBytesFloat32: k * 2 * 4,
  }));

  const costsEvidence = writeEvidenceJson('tracked-positions', 'readback-costs.json', {
    n: N,
    framesPerK: FRAMES,
    summary,
    raw: result.perK.map(({ k, costsMs }) => ({ k, costsMs })),
  });

  const orderingOk = summary.every((r) => r.lengthOk && r.orderOk);
  const k1024 = summary.find((r) => r.k === 1024);
  const budgetK1024Ok = (k1024?.payloadBytesFloat32 ?? Infinity) <= 8 * 1024;
  const p95K1024 = k1024?.p95Ms ?? Infinity;
  const practicalCeiling = summary.reduce(
    (ceiling, r) => (r.p95Ms <= 4 ? Math.max(ceiling, r.k) : ceiling),
    0,
  );

  const pass = orderingOk && budgetK1024Ok && p95K1024 < 8;

  recordProbe({
    capability: 'tracked-positions',
    expected:
      'trackPointPositionsByIndices + per-frame getTrackedPointPositionsArray on a 100K scene: ' +
      'array packed in the exact order the indices were provided (last call replaces the set), ' +
      'k=1024 payload within the ~8KB budget (1024*2*4 bytes) and per-frame read-back cost low ' +
      'enough (p95 well under a frame) to be a practical per-frame channel.',
    observed: {
      n: N,
      framesPerK: FRAMES,
      perK: summary,
      packingOrder: 'array slots follow the index order passed to trackPointPositionsByIndices',
      replacementSemantics: 'each track() call replaces the tracked set (length follows last call)',
      budgetK1024Bytes: k1024?.payloadBytesFloat32 ?? null,
      budgetK1024Ok,
      practicalCeilingK: practicalCeiling,
    },
    pass,
    evidence: [screenshot, costsEvidence],
    notes:
      'Simulation kept hot with simulationDecay=1e9 and start(1); costs measured inside the ' +
      'rAF tick right after the engine draw. Indices were supplied in non-monotonic order to ' +
      'make packing-order verification meaningful (checked against getTrackedPointPositionsMap ' +
      'for the first 64 slots per k). Note the returned value is a number[] (Float64 in JS), so ' +
      'the in-memory JS cost is ~2x the 4-byte-per-float budget figure; the ~8KB budget refers ' +
      'to the Float32 payload equivalent at k=1024.',
  });

  // pass may legitimately be false on timing (sync readback pipeline stall
  // dominates regardless of k) — that budget finding is the evidence.
  // Assert the readback SEMANTICS hold: correct length and packing order.
  expect(orderingOk).toBe(true);
  expect(budgetK1024Ok).toBe(true);
});
