/**
 * Live OmniGraph 0.14 integration. The fixture script creates a fresh local
 * cluster, seeds it through HTTP, and owns its server until teardown.
 * Optional locally; OMNIGRAPH_LIVE_REQUIRED=1 makes missing binaries fail CI.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Omnigraph } from '@modernrelay/omnigraph';
import { createGraphInstance } from '@modernrelay/orbit-core';
import { FakeEngine } from '@modernrelay/orbit-core/testing';
import { createOmnigraphSearchService, createOmnigraphSource, encodeSourceId } from '@modernrelay/orbit-omnigraph';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = process.env.OMNIGRAPH_BIN || 'omnigraph';
const SERVER = process.env.OMNIGRAPH_SERVER_BIN || 'omnigraph-server';
const BASE = 'http://127.0.0.1:8199';
const REQUIRED = process.env.OMNIGRAPH_LIVE_REQUIRED === '1';
const cliVersion = spawnSync(CLI, ['version'], { encoding: 'utf8' });
const AVAILABLE = cliVersion.status === 0 && cliVersion.stdout.split('\n').includes('omnigraph 0.14.0') &&
  spawnSync(SERVER, ['--help'], { stdio: 'ignore' }).status === 0;
const SKIP_REASON = 'Set OMNIGRAPH_BIN and OMNIGRAPH_SERVER_BIN to the pinned 0.14.0 binaries; OMNIGRAPH_LIVE_REQUIRED=1 requires the live test.';
const READY_DOT = '[data-testid="status-dot"][title="ready"]';
const NODE_COUNT = '[data-testid="node-count"]';
const EDGE_COUNT = '[data-testid="edge-count"]';
const TYPE_LABEL = /^(Actor|Decision|Trace|Signal|Artifact) · .+/;
const fmt = (n: number): string => n.toLocaleString('en-US');

interface RecordedManifest {
  graphId: string;
  branch: string;
  rowCounts: Record<string, number>;
}
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'fixtures/omnigraph/recorded/manifest.json'), 'utf8')) as RecordedManifest;
function tableTotal(m: RecordedManifest, prefix: 'node:' | 'edge:'): number {
  return Object.entries(m.rowCounts).filter(([key]) => key.startsWith(prefix)).reduce((sum, [, count]) => sum + count, 0);
}

let fixture: ChildProcess | null = null;
let fixtureClosed: Promise<unknown> | null = null;
let fixtureLog = '';

test.skip(!AVAILABLE && !REQUIRED, SKIP_REASON);
test.beforeAll(async () => {
  test.setTimeout(60_000);
  if (!AVAILABLE) throw new Error(SKIP_REASON);
  fixture = spawn(process.execPath, [path.join(ROOT, 'scripts/omnigraph-fixture.mjs'), '--serve'], {
    cwd: ROOT, env: { ...process.env, OMNIGRAPH_FIXTURE_PORT: '8199' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  fixtureClosed = once(fixture, 'close');
  for (const output of [fixture.stdout, fixture.stderr]) output?.on('data', (chunk) => { fixtureLog = (fixtureLog + chunk).slice(-16000); });
  const deadline = Date.now() + 45_000;
  while (!fixtureLog.includes('FIXTURE_READY')) {
    if (fixture.exitCode !== null || fixture.signalCode !== null || Date.now() > deadline) throw new Error(`Fixture failed to start: ${fixtureLog}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const response = await fetch(`${BASE}/readyz`, { headers: { 'Omnigraph-Http-Api': '0.14' } });
  expect(response.ok).toBe(true);
  expect(response.headers.get('Omnigraph-Http-Api')).toBe('0.14');
});

test.afterAll(async () => {
  if (fixture !== null && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill('SIGTERM');
    await fixtureClosed;
  }
  fixture = null;
});

test('live export and stored search share system identity while retaining user id data', async () => {
  const client = new Omnigraph({ baseUrl: BASE });
  const search = createOmnigraphSearchService({
    client, graphId: 'demo', queryName: 'search_signals', typeOf: { s: 'Signal' },
    labelColumn: 's.title', params: (q) => ({ q }),
  });
  const instance = createGraphInstance({ engine: () => new FakeEngine(), services: { search } });
  try {
    const loaded = await createOmnigraphSource({ client, graphId: 'demo' }).load(instance);
    expect(loaded.serverVersion).toBe('0.14.0');
    expect(loaded.counts).toMatchObject({ nodes: 300, edges: 500 });
    expect(loaded.warnings).toEqual([]);
    const id = encodeSourceId('Signal', 'signal-001');
    expect(instance.getNode(id)?.attrs?.id).toBe(1);
    expect(instance.getNode(encodeSourceId('Signal', 'signal-003'))?.attrs?.id).toBeNull();
    expect(instance.getNode(encodeSourceId('Actor', 'actor-001'))?.attrs).not.toHaveProperty('id');
    expect(instance.getNode(encodeSourceId('Decision', 'decision-001'))?.attrs?.updated_at).toMatch(/T.*\.\d{3}Z$/);
    const hits = await instance.search('Signal 1:', { limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id, label: 'Signal 1: search admission' });
    expect(instance.getNode(hits[0]!.id)).toBeDefined();
  } finally { instance.destroy(); }
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
