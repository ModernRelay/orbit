/**
 * link-picking — click and hover at the midpoint of a straight link between
 * pinned endpoints must deliver the correct linkIndex via onLinkClick /
 * onLinkMouseOver; a perpendicular offset sweep (0..8 px) measures the pick
 * tolerance. This evidence decides a future `linkPicking` capability flip.
 */
import { test, expect } from '@playwright/test';
import { openWorkbench, waitFrames, hoverAt } from './util';
import { recordProbe, evidencePath, writeEvidenceJson } from './record';

test('link-picking: linkIndex delivery and perpendicular tolerance', async ({ page }) => {
  await openWorkbench(page);

  await page.evaluate(async () => {
    const s = window.__spike;
    await s.init({
      enableSimulation: false,
      fitViewOnInit: false,
      rescalePositions: false,
      backgroundColor: '#101018',
      pointDefaultColor: '#ff4040',
      pointDefaultSize: 10,
      linkDefaultColor: '#40ff40',
      linkDefaultWidth: 2,
      linkVisibilityDistanceRange: [1e6, 2e6],
      curvedLinks: false,
    });
    const g = s.graph;
    if (!g) throw new Error('graph missing');
    // Two horizontal links: link 0 (points 0-1) and link 1 (points 2-3).
    g.setPointPositions(new Float32Array([1000, 1500, 3000, 1500, 1000, 2500, 3000, 2500]));
    g.setLinks(new Float32Array([0, 1, 2, 3]));
    g.render(0);
    g.setPinnedPoints([0, 1, 2, 3]);
    g.fitView(0, 0.1, false);
  });
  await waitFrames(page, 10);
  await page.waitForTimeout(300);

  // Screen midpoints of both links.
  const mids = await page.evaluate(() => {
    const s = window.__spike;
    return {
      link0: s.spaceToScreenXY(2000, 1500),
      link1: s.spaceToScreenXY(2000, 2500),
    };
  });
  const [midX, midY] = mids.link1;
  // Neutral park position: between the two links, far from both.
  const parkY = (mids.link0[1] + mids.link1[1]) / 2;

  // --- Hover semantics -----------------------------------------------------
  await hoverAt(page, midX, parkY);
  const hoversBefore = await page.evaluate(() => window.__spike.sinks.linkHovers.length);
  await hoverAt(page, midX, midY);
  const hoverEvents = await page.evaluate(
    (n) => window.__spike.sinks.linkHovers.slice(n),
    hoversBefore,
  );
  const hoverIndex =
    hoverEvents.find((e) => e.type === 'over')?.linkIndex ?? null;

  // Move away and verify onLinkMouseOut fires.
  const outBefore = await page.evaluate(() => window.__spike.sinks.linkHovers.length);
  await hoverAt(page, midX, parkY);
  const outFired = await page.evaluate(
    (n) => window.__spike.sinks.linkHovers.slice(n).some((e) => e.type === 'out'),
    outBefore,
  );

  // --- Click semantics -----------------------------------------------------
  await hoverAt(page, midX, midY);
  await page.mouse.click(midX, midY);
  await page.waitForTimeout(150);
  const clickState = await page.evaluate(() => ({
    linkClicks: window.__spike.sinks.linkClicks.map((e) => e.linkIndex),
    pointClicks: window.__spike.sinks.pointClicks.map((e) => e.index),
  }));
  const clickIndex = clickState.linkClicks[clickState.linkClicks.length - 1] ?? null;

  const screenshot = evidencePath('link-picking', 'scene.png');
  await page.screenshot({ path: screenshot });

  // --- Perpendicular tolerance sweep (0..8 px below the link) --------------
  const sweep: Array<{ offsetPx: number; hovered: boolean; linkIndex: number | null }> = [];
  for (let offset = 0; offset <= 8; offset += 1) {
    await hoverAt(page, midX, parkY);
    const mark = await page.evaluate(() => window.__spike.sinks.linkHovers.length);
    await hoverAt(page, midX, midY + offset);
    const events = await page.evaluate(
      (n) => window.__spike.sinks.linkHovers.slice(n),
      mark,
    );
    const over = events.find((e) => e.type === 'over');
    sweep.push({
      offsetPx: offset,
      hovered: over !== undefined,
      linkIndex: over?.linkIndex ?? null,
    });
  }
  let tolerancePx = -1;
  for (const entry of sweep) {
    if (entry.hovered && entry.linkIndex === 1) tolerancePx = entry.offsetPx;
    else break;
  }

  const sweepEvidence = writeEvidenceJson('link-picking', 'tolerance-sweep.json', sweep);

  const pass = hoverIndex === 1 && clickIndex === 1 && outFired;

  recordProbe({
    capability: 'link-picking',
    expected:
      'onLinkMouseOver/onLinkClick deliver the correct linkIndex (index of the source/target ' +
      'pair in the links array) at the midpoint of a straight link between pinned endpoints; ' +
      'onLinkMouseOut fires on leave; hit tolerance is a few px perpendicular to the link.',
    observed: {
      hoverLinkIndex: hoverIndex,
      clickLinkIndex: clickIndex,
      linkMouseOutFired: outFired,
      pointClicksDuringLinkClick: clickState.pointClicks,
      contiguousTolerancePx: tolerancePx,
      sweep,
    },
    pass,
    evidence: [screenshot, sweepEvidence],
    notes:
      'linkIndex is the pair index into the flat links array ([s0,t0,s1,t1,...] => link i = pair i). ' +
      'Link hover shares the frame-loop cadence of point hover (every <=4 frames, pointer on canvas) ' +
      'and points take precedence over links in click resolution. Sweep offsets are perpendicular ' +
      '(screen-vertical) to a horizontal 2px-wide link; contiguousTolerancePx is the largest offset ' +
      'in an unbroken run from 0 that still hovers link 1. This record is the evidence base for a ' +
      'future linkPicking capability flip.',
  });

  expect(pass).toBe(true);
});
