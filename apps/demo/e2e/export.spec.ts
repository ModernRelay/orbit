/**
 * Exports through the real demo pipeline.
 *
 * All DOM-driven (buttons + the window.__lastExport mirror), so every case
 * gates in CI. The hostile-label case is the rule proven END TO END: a
 * node whose label is literally `<script>…` flows generator → accepted model
 * → label lane → SVG exporter, and comes out escaped.
 */

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const READY_DOT = '[data-testid="status-dot"][title="ready"]';

async function ready(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await page.waitForSelector(READY_DOT, { timeout: 60_000 });
}

async function lastExport(
  page: Page,
): Promise<{ kind: string; text: string; lines?: number; error?: string }> {
  await page.waitForFunction(() => window.__lastExport !== undefined, undefined, {
    timeout: 15_000,
  });
  return page.evaluate(() => {
    const out = window.__lastExport!;
    delete window.__lastExport;
    return out;
  });
}

async function visibleNodes(page: Page): Promise<number> {
  const text = (await page.getByTestId('visible-nodes').textContent()) ?? '';
  return Number.parseInt(text.replace(/,/g, ''), 10);
}

test('SVG export: one circle per visible node, well-formed document', async ({ page }) => {
  await ready(page);
  const visible = await visibleNodes(page);
  expect(visible).toBe(3000);

  await page.getByTestId('export-svg').click();
  const out = await lastExport(page);
  expect(out.error).toBeUndefined();
  expect(out.text.startsWith('<svg ')).toBe(true);
  expect(out.text.endsWith('</svg>')).toBe(true);
  expect(out.text.match(/<circle /g)).toHaveLength(visible);
});

test('hostile label is ESCAPED in the exported SVG — end to end', async ({ page }) => {
  await ready(page, '?hostileLabel=1');

  // Force the hostile node's label into the lane: n0 is showFor-forced, so
  // its label renders at any zoom — no LOD stepping needed.
  await page.getByTestId('export-svg').click();
  const out = await lastExport(page);
  expect(out.error).toBeUndefined();
  expect(out.text).not.toContain('<script');
  expect(out.text).toContain('&lt;script&gt;');
});

test('over-bound export rejects typed and downloads nothing', async ({ page }) => {
  await ready(page, '?svgcap=10');
  await page.getByTestId('export-svg').click();
  const out = await lastExport(page);
  expect(out.error).toBeDefined();
  expect(out.error).toContain('exceeds 10');
  expect(out.text).toBe('');
});

test('JSONL export: line count matches the visible scope', async ({ page }) => {
  await ready(page);
  // Narrow the visible set first so 'visible' scope is proven, not assumed:
  // hide one cluster via the filter checkboxes (DOM, deterministic).
  await page.getByTestId('cluster-check-0').uncheck();
  await expect
    .poll(() => visibleNodes(page), { timeout: 15_000 })
    .toBeLessThan(3000);
  const visible = await visibleNodes(page);

  await page.getByTestId('export-jsonl').click();
  const out = await lastExport(page);
  expect(out.error).toBeUndefined();
  const lines = out.text.trimEnd().split('\n').map((l) => JSON.parse(l) as { kind: string });
  const nodeLines = lines.filter((l) => l.kind === 'node');
  const edgeLines = lines.filter((l) => l.kind === 'edge');
  expect(nodeLines).toHaveLength(visible);
  expect(edgeLines.length).toBeGreaterThan(0);
  expect(out.lines).toBe(lines.length);
});
