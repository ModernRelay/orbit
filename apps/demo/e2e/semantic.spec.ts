/**
 * v0.10 M5 semantic-exploration smoke — the graph-side half.
 *
 * Drives the demo's 'semantic' data mode (a 144-node / 171-edge clustered
 * fixture on a FIXED, force-free layout) through the lanes and asserts
 * ONE NAMED OBSERVABLE per interaction — a store-published readout
 * (`m5-groups`, `m5-collapsed`, `m5-clusters`, `m5-pinned`, `m5-visible-edges`,
 * `visible-nodes`, `selected-count`, `scope-status`), a ref-API read published
 * into the DOM (`m5-path` ← getActivePath), or a DOM state (menu items,
 * cluster-label elements).
 *
 * Screenshot diffs accompany three of them — group collapse, the
 * semantic-zoom band flip, and path emphasis. They are in-run comparisons of
 * quiesced captures rather than committed baselines: the fixture is
 * deterministic, but a byte baseline is a per-platform artifact (mac dev vs.
 * SwiftShader CI), so the assertion is that the picture CHANGES with the
 * interaction and RETURNS when the interaction is undone. See m5-helpers.ts.
 *
 * Each test re-enters the mode on its own page: a structural rebuild
 * (collapse/expand) leaves cosmos's hit-test index stale for right-clicks
 * until the next frame batch, so menu-driven tests never share a page.
 */

import { expect, test } from '@playwright/test';

import {
  CHANGED_MIN,
  CONTEXT_MENU,
  M5_BACKGROUND_POINT,
  M5_CLUSTER_SCREEN,
  RESTORED_MAX,
  ZOOM_VALUE,
  attachShot,
  closeMenu,
  diffRatio,
  enterSemantic,
  openBackgroundMenu,
  openNodeMenu,
  readNumber,
  stableShot,
} from './m5-helpers';

/** Fixture cardinalities (semantic.tsx): 6 clusters × 24 nodes. */
const NODES = 144;
const PER_CLUSTER = 24;
const EDGES = 171;
/** The parallel bundle: 3 EXTRA same-pair edges collapse into one meta-edge. */
const PARALLEL_EXTRA = 3;

test('groups: context-menu collapse is a structural diff; background expand restores it', async ({
  page,
}, testInfo) => {
  await enterSemantic(page);
  await page.getByTestId('m5-grouping-manual').check();

  // Manual groups resolve without collapsing anything (collapsed defaults false).
  await expect(page.getByTestId('m5-groups')).toHaveText('6', { timeout: 10_000 });
  await expect(page.getByTestId('m5-collapsed')).toHaveText('0');
  await expect(page.getByTestId('visible-nodes')).toHaveText(String(NODES));

  const before = await stableShot(page);
  await attachShot(testInfo, 'groups-expanded', before);

  // --- collapse the coral group through the node context menu ---
  const heading = await openNodeMenu(page, M5_CLUSTER_SCREEN['coral']!);
  expect(heading, 'the right-click should land on a coral member').toMatch(/^coral-\d{4}$/);
  const menu = page.locator(CONTEXT_MENU);
  const collapseItem = menu.locator('[data-orbit-context-menu-item="m5-collapse-group"]');
  await expect(collapseItem).toHaveText(/Collapse coral group/);
  await collapseItem.click();

  // Named observables: the store's collapsed-group count and the scene's
  // visible node count (24 members → 1 super-node).
  await expect(page.getByTestId('m5-collapsed')).toHaveText('1', { timeout: 10_000 });
  await expect(page.getByTestId('visible-nodes')).toHaveText(String(NODES - PER_CLUSTER + 1));
  // The accepted model is untouched — collapse is a scene rewrite, not a reload.
  await expect(page.getByTestId('node-count')).toHaveText(String(NODES));

  const collapsed = await stableShot(page);
  await attachShot(testInfo, 'groups-collapsed', collapsed);
  const collapseDiff = await diffRatio(page, before, collapsed);
  expect(collapseDiff, 'collapsing a group must change the picture').toBeGreaterThan(CHANGED_MIN);

  // --- expand it again through the BACKGROUND menu (a collapsed group's
  // members own no scene slot, so its super-node is not right-clickable) ---
  await openBackgroundMenu(page);
  const expandItem = menu.locator('[data-orbit-context-menu-item="m5-expand-group"]');
  await expect(expandItem).toHaveText(/Expand coral group/);
  await expandItem.click();

  await expect(page.getByTestId('m5-collapsed')).toHaveText('0', { timeout: 10_000 });
  await expect(page.getByTestId('visible-nodes')).toHaveText(String(NODES));

  const restored = await stableShot(page);
  await attachShot(testInfo, 'groups-restored', restored);
  expect(
    await diffRatio(page, before, restored),
    'expanding must restore the pre-collapse picture',
  ).toBeLessThan(RESTORED_MAX);
});

test('semantic zoom: a band flip collapses derived groups at a constant zoom', async ({
  page,
}, testInfo) => {
  await enterSemantic(page);

  // Zoom below collapseBelow FIRST, with no grouping configured: this is the
  // reference picture at the band's zoom level, so the diff below isolates the
  // band flip from the camera move.
  await page.getByTestId('m5-zoom-collapse').click();
  await expect(page.locator(ZOOM_VALUE)).toHaveText('×0.15', { timeout: 10_000 });
  const ungrouped = await stableShot(page);
  await attachShot(testInfo, 'zoom-band-ungrouped', ungrouped);

  // groupBy alone derives one group per cluster and collapses nothing.
  await page.getByTestId('m5-grouping-derived').check();
  await expect(page.getByTestId('m5-groups')).toHaveText('6', { timeout: 10_000 });
  await expect(page.getByTestId('m5-collapsed')).toHaveText('0');
  await expect(page.getByTestId('visible-nodes')).toHaveText(String(NODES));
  expect(
    await diffRatio(page, ungrouped, await stableShot(page)),
    'groupBy alone must not change the rendering',
  ).toBeLessThan(RESTORED_MAX);

  // Hysteresis: enter the expanded band, then cross back below collapseBelow.
  const collapsed = page.getByTestId('m5-collapsed');
  const thresholds = await collapsed.evaluate((el) => ({
    below: Number(el.getAttribute('data-collapse-below')),
    above: Number(el.getAttribute('data-expand-above')),
  }));
  expect(thresholds.above).toBeGreaterThan(thresholds.below);

  await page.getByTestId('m5-zoom-expand').click();
  await expect(page.locator(ZOOM_VALUE)).toHaveText('×2.00', { timeout: 10_000 });
  await expect(collapsed).toHaveText('0');

  await page.getByTestId('m5-zoom-collapse').click();
  await expect(page.locator(ZOOM_VALUE)).toHaveText('×0.15', { timeout: 10_000 });
  // Named observable: every derived group is collapsed and the scene holds
  // exactly one super-node per cluster.
  await expect(collapsed).toHaveText('6', { timeout: 10_000 });
  await expect(page.getByTestId('visible-nodes')).toHaveText('6');

  const flipped = await stableShot(page);
  await attachShot(testInfo, 'zoom-band-collapsed', flipped);
  expect(
    await diffRatio(page, ungrouped, flipped),
    'the band flip must change the picture at the same zoom',
  ).toBeGreaterThan(CHANGED_MIN);

  // Crossing back above expandAbove expands only the groups intersecting the
  // viewport (the expand camera frames cluster 0's disc), so the collapsed
  // count strictly drops and members return to the scene — never "all six".
  await page.getByTestId('m5-zoom-expand').click();
  await expect(page.locator(ZOOM_VALUE)).toHaveText('×2.00', { timeout: 10_000 });
  await expect
    .poll(() => readNumber(page, 'm5-collapsed'), {
      message: 'crossing expandAbove must expand the in-view groups',
      timeout: 10_000,
    })
    .toBeLessThan(6);
  expect(await readNumber(page, 'visible-nodes')).toBeGreaterThan(6);
});

test('paths: the context-menu pair emphasizes a path and clearPath releases it', async ({
  page,
}, testInfo) => {
  await enterSemantic(page);
  const base = await stableShot(page);
  await attachShot(testInfo, 'path-before', base);

  const from = await openNodeMenu(page, M5_CLUSTER_SCREEN['delta']!);
  expect(from).toMatch(/^delta-\d{4}$/);
  const menu = page.locator(CONTEXT_MENU);
  await menu.locator('[data-orbit-context-menu-item="find-path-from"]').click();
  await expect(menu).toHaveCount(0);

  const to = await openNodeMenu(page, M5_CLUSTER_SCREEN['bravo']!);
  expect(to).toMatch(/^bravo-\d{4}$/);
  // The 'to' item only exists once an anchor was set on a DIFFERENT node.
  await menu.locator('[data-orbit-context-menu-item="find-path-to"]').click();

  // Named observable: the demo publishes getActivePath into the readout.
  const pathReadout = page.getByTestId('m5-path');
  await expect(pathReadout).toHaveText(/^\d+ nodes · \d+ edges$/, { timeout: 15_000 });
  const nodesInPath = Number.parseInt((await pathReadout.textContent())!, 10);
  expect(nodesInPath, 'the fixture is connected — every pair resolves').toBeGreaterThanOrEqual(2);

  // Park the pointer off-canvas so hover state never enters the capture.
  await page.mouse.move(4, 796);
  const emphasized = await stableShot(page);
  await attachShot(testInfo, 'path-emphasized', emphasized);
  expect(
    await diffRatio(page, base, emphasized),
    'path emphasis must change the picture (dim mask + highlight)',
  ).toBeGreaterThan(CHANGED_MIN);

  await page.getByTestId('m5-clear-path').click();
  await expect(pathReadout).toHaveText('—', { timeout: 10_000 });
  const cleared = await stableShot(page);
  await attachShot(testInfo, 'path-cleared', cleared);
  expect(
    await diffRatio(page, base, cleared),
    'clearPath must restore the pre-path picture exactly',
  ).toBeLessThan(RESTORED_MAX);
});

test('clusters: labels own the overview band and a label click selects its members', async ({
  page,
}) => {
  await enterSemantic(page);
  await expect(page.locator('[data-orbit-cluster-label]')).toHaveCount(0);

  await page.getByTestId('m5-clusters-toggle').check();
  // Named observable: getClusters length, published into the readout.
  await expect(page.getByTestId('m5-clusters')).toHaveText('6', { timeout: 10_000 });
  // Clusters synthesize nothing — node and edge counts are untouched.
  await expect(page.getByTestId('node-count')).toHaveText(String(NODES));
  await expect(page.getByTestId('m5-visible-edges')).toHaveText(String(EDGES));

  const clusterLabels = page.locator('[data-orbit-cluster-label]');
  await expect(clusterLabels).toHaveCount(6, { timeout: 10_000 });
  // labels.maxZoom hands the overview band to cluster labels: node labels are
  // suppressed below it.
  await expect(page.locator('[data-orbit-label]')).toHaveCount(0);

  // a cluster-label click resolves to its MEMBER node ids.
  await clusterLabels.filter({ hasText: 'delta' }).click();
  await expect(page.getByTestId('selected-count')).toHaveText(String(PER_CLUSTER), {
    timeout: 10_000,
  });

  // Above labels.maxZoom the LOD hands back to node labels.
  await page.getByTestId('m5-zoom-expand').click();
  await expect(page.locator(ZOOM_VALUE)).toHaveText('×2.00', { timeout: 10_000 });
  await expect(clusterLabels).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('[data-orbit-label]').first()).toBeVisible({ timeout: 10_000 });
});

test('expansion: isolate → expandNode → retractExpansion walks the effective set', async ({
  page,
}) => {
  await enterSemantic(page);
  await expect(page.getByTestId('scope-status')).toHaveText('full');

  // Hard-scope to the seed's 1-hop ego network.
  await page.getByTestId('m5-isolate').click();
  await expect(page.getByTestId('visible-nodes')).toHaveText('8', { timeout: 15_000 });
  await expect(page.getByTestId('scope-status')).toHaveText(`8 of ${NODES}`);

  // expandNode accretes the frontier's neighbors into the resolved scope.
  await page.getByTestId('m5-expand').click();
  await expect(page.getByTestId('visible-nodes')).toHaveText('14', { timeout: 15_000 });

  // retractExpansion pops that expansion record; nothing else was re-added or
  // still reachable without traversing it, so the scope returns to 8.
  await page.getByTestId('m5-retract').click();
  await expect(page.getByTestId('visible-nodes')).toHaveText('8', { timeout: 15_000 });

  await page.getByTestId('reset-scope').click();
  await expect(page.getByTestId('visible-nodes')).toHaveText(String(NODES), { timeout: 15_000 });
  await expect(page.getByTestId('scope-status')).toHaveText('full');
});

test('folds: the context-menu pair hides a neighbourhood behind its anchor and restores it', async ({
  page,
}, testInfo) => {
  await enterSemantic(page);
  await expect(page.getByTestId('visible-nodes')).toHaveText(String(NODES), { timeout: 15_000 });

  const before = await stableShot(page);
  const menu = page.locator(CONTEXT_MENU);

  // --- fold through the node context menu ---
  const heading = await openNodeMenu(page, M5_CLUSTER_SCREEN['coral']!);
  expect(heading, 'the right-click should land on a coral member').toMatch(/^coral-\d{4}$/);
  const foldItem = menu.locator('[data-orbit-context-menu-item="fold"]');
  // Distinct wording from 'expand', which FETCHES rather than contains.
  await expect(foldItem).toHaveText('Collapse neighborhood');
  await foldItem.click();

  // The anchor KEEPS its slot — unlike a collapsed group, whose members are
  // replaced by a synthetic super-node. So the drop is exactly the member
  // count, and the accepted model never moves.
  const folded = await readNumber(page, 'visible-nodes');
  expect(folded, 'folding must hide at least one neighbour').toBeLessThan(NODES);
  await expect(page.getByTestId('node-count')).toHaveText(String(NODES));
  await expect(page.getByTestId('m5-collapsed')).toHaveText('0'); // no GROUP collapsed

  const foldedShot = await stableShot(page);
  await attachShot(testInfo, 'fold-collapsed', foldedShot);
  expect(
    await diffRatio(page, before, foldedShot),
    'folding a neighbourhood must change the picture',
  ).toBeGreaterThan(CHANGED_MIN);

  // --- unfold through the SAME node: the anchor is still right-clickable,
  // which is the whole point of a real representative ---
  const again = await openNodeMenu(page, M5_CLUSTER_SCREEN['coral']!);
  expect(again, 'the anchor keeps its slot while folded').toMatch(/^coral-\d{4}$/);
  const unfoldItem = menu.locator('[data-orbit-context-menu-item="unfold"]');
  await expect(unfoldItem).toHaveText('Expand neighborhood');
  await unfoldItem.click();

  await expect(page.getByTestId('visible-nodes')).toHaveText(String(NODES), { timeout: 15_000 });
  // Park the pointer off-graph first: this test's last interaction was a
  // right-click ON the anchor, so it would otherwise be left hover-highlighted
  // and the comparison would measure the highlight, not the restoration.
  await page.mouse.move(M5_BACKGROUND_POINT[0], M5_BACKGROUND_POINT[1]);
  const restored = await stableShot(page);
  await attachShot(testInfo, 'fold-restored', restored);
  expect(
    await diffRatio(page, before, restored),
    'unfolding must restore the pre-fold picture',
  ).toBeLessThan(RESTORED_MAX);
});

test('pins: pinNodes/unpinNodes round-trip through the controlled pinnedNodeIds prop', async ({
  page,
}) => {
  await enterSemantic(page);
  await expect(page.getByTestId('m5-pinned')).toHaveText('0');

  await page.getByRole('button', { name: 'Select all' }).click();
  await expect(page.getByTestId('selected-count')).toHaveText(String(NODES), { timeout: 10_000 });

  // The op fires the INTENT, the demo reflects it into `pinnedNodeIds`,
  // and the readout reads the STORE slice back — the full round trip.
  await page.getByTestId('m5-pin-selection').click();
  await expect(page.getByTestId('m5-pinned')).toHaveText(String(NODES), { timeout: 10_000 });

  await page.getByTestId('m5-unpin-all').click();
  await expect(page.getByTestId('m5-pinned')).toHaveText('0', { timeout: 10_000 });
});

test('parallel edges: the toggle collapses the same-pair bundle into one meta-edge', async ({
  page,
}) => {
  await enterSemantic(page);
  await expect(page.getByTestId('m5-visible-edges')).toHaveText(String(EDGES));

  await page.getByTestId('m5-parallel-toggle').check();
  // Named observable: the scene's visible link count drops by exactly the
  // extra parallels (4 same-pair edges → 1 count-weighted meta-edge).
  await expect(page.getByTestId('m5-visible-edges')).toHaveText(String(EDGES - PARALLEL_EXTRA), {
    timeout: 10_000,
  });
  // The accepted model still holds every edge — the toggle is a scene rewrite.
  await expect(page.getByTestId('edge-count')).toHaveText(String(EDGES));

  await page.getByTestId('m5-parallel-toggle').uncheck();
  await expect(page.getByTestId('m5-visible-edges')).toHaveText(String(EDGES), { timeout: 10_000 });
});

test('modes: leaving and re-entering M5 keeps the declarative workbench intact', async ({
  page,
}) => {
  await enterSemantic(page);
  await expect(page.getByTestId('m5-panel')).toBeVisible();

  // Regenerate returns to the declarative mode on a fresh instance (graphKey).
  await page.getByRole('button', { name: 'Regenerate' }).click();
  await expect(page.getByTestId('node-count')).toHaveText('3,000', { timeout: 30_000 });
  await expect(page.getByTestId('m5-panel')).toHaveCount(0);
  await expect(page.getByTestId('m5-dock')).toHaveCount(0);
  // The minimap/legend float stack returns with the declarative mode.
  await expect(page.getByTestId('minimap-panel')).toBeVisible();
  await closeMenu(page);

  await page.getByTestId('semantic-mode').click();
  await expect(page.getByTestId('node-count')).toHaveText(String(NODES), { timeout: 30_000 });
  await expect(page.getByTestId('m5-dock')).toBeVisible();
  expect(await readNumber(page, 'm5-groups')).toBe(0);
});
