/**
 * v0.6 omnigraph live-integration smoke.
 *
 * Boots the REAL `omnigraph-server` over the committed fixture cluster
 * (fixtures/omnigraph/cluster) and drives the demo's Omnigraph panel end to
 * end through the vite `/og` same-origin proxy: Load from Omnigraph → live
 * meter completes → header counts match the recorded manifest's rowCounts →
 * hovering a node surfaces a type-derived label → screenshot artifact.
 *
 * Skips cleanly (never fails) when the `omnigraph-server` binary or the
 * fixture cluster graph store is absent — CI installs neither and consumes
 * the recorded HTTP fixtures instead; this spec is the local full-stack
 * proof. Regenerate the cluster store with `node scripts/omnigraph-fixture.mjs`.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLUSTER_DIR = path.join(ROOT, 'fixtures', 'omnigraph', 'cluster');
const GRAPH_STORE = path.join(CLUSTER_DIR, 'graphs', 'demo.omni');
const MANIFEST_PATH = path.join(ROOT, 'fixtures', 'omnigraph', 'recorded', 'manifest.json');

const BIND = '127.0.0.1:8199';
const HEALTH_URL = `http://${BIND}/healthz`;

const READY_DOT = '[data-testid="status-dot"][title="ready"]';
const NODE_COUNT = '[data-testid="node-count"]';
const EDGE_COUNT = '[data-testid="edge-count"]';

/** Status-bar hover readout format for omnigraph nodes (App.tsx `labelOf`). */
const TYPE_LABEL = /^(Actor|Decision|Trace|Signal|Artifact) · .+/;

const fmt = (n: number): string => n.toLocaleString('en-US');

interface RecordedManifest {
  graphId: string;
  branch: string;
  rowCounts: Record<string, number>;
}

function hasServerBinary(): boolean {
  try {
    return spawnSync('omnigraph-server', ['--help'], { stdio: 'ignore' }).error === undefined;
  } catch {
    return false;
  }
}

const AVAILABLE = hasServerBinary() && existsSync(GRAPH_STORE) && existsSync(MANIFEST_PATH);
const SKIP_REASON =
  'omnigraph-server binary or fixture cluster store missing (CI) — ' +
  'recorded fixtures cover the adapter; run `node scripts/omnigraph-fixture.mjs` locally';

const manifest: RecordedManifest | null = AVAILABLE
  ? (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as RecordedManifest)
  : null;

function tableTotal(m: RecordedManifest, prefix: 'node:' | 'edge:'): number {
  return Object.entries(m.rowCounts)
    .filter(([key]) => key.startsWith(prefix))
    .reduce((sum, [, count]) => sum + count, 0);
}

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(HEALTH_URL)).ok;
  } catch {
    return false;
  }
}

/** Spawned only when nothing already answers on 8199 (reuse a dev server). */
let server: ChildProcess | null = null;

test.beforeAll(async () => {
  if (!AVAILABLE) return;
  if (await healthy()) return;
  server = spawn(
    'omnigraph-server',
    ['--cluster', CLUSTER_DIR, '--unauthenticated', '--bind', BIND],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await healthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`omnigraph-server did not become healthy on ${HEALTH_URL} within 20s`);
});

test.afterAll(() => {
  server?.kill();
  server = null;
});

/** Sweep a grid around the viewport center until the status bar shows an
 * omnigraph hover label (hit-testing exact node centers under a live force
 * layout is flaky — same hunt strategy as the ingestion spec's right-click). */
async function huntHoverLabel(page: Page): Promise<string | null> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('viewport must be set by the config');
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const offsets = [0, -18, 18, -36, 36, -54, 54, -76, 76, -100, 100, -128, 128];
  for (const dy of offsets) {
    for (const dx of offsets) {
      await page.mouse.move(cx + dx, cy + dy);
      await page.waitForTimeout(100);
      const text = (await page.getByTestId('hover-label').textContent()) ?? '';
      if (TYPE_LABEL.test(text)) return text;
    }
  }
  return null;
}

test('load from omnigraph → meter completes → counts match manifest → typed hover label', async ({
  page,
}, testInfo) => {
  test.skip(!AVAILABLE, SKIP_REASON);
  if (manifest === null) return; // unreachable past the skip; narrows the type
  const nodeTotal = tableTotal(manifest, 'node:');
  const edgeTotal = tableTotal(manifest, 'edge:');

  await page.goto('/');
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
  await expect(page.locator(NODE_COUNT)).toHaveText('3,000'); // declarative base

  // The panel defaults to the same-origin proxy path; pin graph/branch to the
  // manifest's coordinates (they match the defaults for the committed fixture).
  await expect(page.getByTestId('og-base-path')).toHaveValue('/og');
  await page.getByTestId('og-graph-id').fill(manifest.graphId);
  await page.getByTestId('og-branch').fill(manifest.branch);

  // --- load: live meter appears, then commits ---
  await page.getByTestId('og-load').click();
  await expect(page.getByTestId('og-meter')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('og-meter')).toHaveAttribute('data-phase', 'committed', {
    timeout: 45_000,
  });
  await expect(page.getByTestId('og-error')).toHaveCount(0);
  await expect(page.getByTestId('og-lines')).toHaveText(fmt(nodeTotal + edgeTotal));

  // --- header counts reflect the committed replace session, per manifest ---
  await expect(page.locator(NODE_COUNT)).toHaveText(fmt(nodeTotal), { timeout: 30_000 });
  await expect(page.locator(EDGE_COUNT)).toHaveText(fmt(edgeTotal));

  // --- dataRef readout: coordinates + abbreviated branch head ---
  await expect(page.getByTestId('og-dataref')).toContainText(
    `${manifest.graphId} · ${manifest.branch} @`,
  );
  await expect(page.getByTestId('og-count-summary')).toHaveText(
    `${fmt(nodeTotal)} nodes · ${fmt(edgeTotal)} edges`,
  );

  // --- hover a node: the status bar shows a type-derived label ---
  await page.waitForSelector(READY_DOT, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Fit view' }).click();
  await page.waitForTimeout(1_500); // let the force layout settle a little
  const label = await huntHoverLabel(page);

  // --- screenshot artifact (captured before the hover assertion so a hover
  // miss still leaves the visual evidence attached) ---
  const shotPath = testInfo.outputPath('omnigraph-loaded.png');
  await page.screenshot({ path: shotPath });
  await testInfo.attach('omnigraph-loaded', { path: shotPath, contentType: 'image/png' });

  expect(label, 'hovering a node should surface a type-derived label').toMatch(TYPE_LABEL);
});
