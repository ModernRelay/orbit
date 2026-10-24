import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const csv = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Import CSV graph' });

async function ready(page: Page): Promise<void> {
  await page.goto('/?declNodes=100');
  await page.waitForSelector('[data-testid="status-dot"][title="ready"]');
}

// Delay actual File reads, preserving real CSV parsing and AbortSignal handling.
// This makes cancellation/replacement deterministic without waiting for a huge file.
async function slowFileReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const stream = File.prototype.stream;
    File.prototype.stream = function () {
      const source = stream.call(this);
      if (this.name !== 'slow.csv') return source;
      const reader = source.getReader();
      let cancelled = false;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          if (cancelled) return;
          const next = await reader.read();
          if (cancelled) return;
          if (next.done) controller.close(); else controller.enqueue(next.value);
        },
        async cancel() { cancelled = true; await reader.cancel(); },
      });
    };
  });
}
const slowCsv = () => csv('slow.csv', 'source,target,weight\n' + Array.from({ length: 20_000 }, (_, i) => `n${i},n${i + 1},${i}\n`).join(''));

test('preview and map custom headers, with node attributes and string IDs', async ({ page }) => {
  await ready(page);
  const before = await page.getByTestId('node-count').innerText();
  await page.getByTestId('csv-file-input').setInputFiles(csv('connections.csv',
    'relation,from_person,to_person,notes\nr1,001,002,"a,b"\nr2,002,003,hello\n'));
  await expect(dialog(page).getByRole('table', { name: 'Edges preview' })).toContainText('a,b');
  await expect(page.getByTestId('node-count')).toHaveText(before);
  await dialog(page).getByRole('combobox', { name: 'Source column', exact: true }).selectOption('from_person');
  await dialog(page).getByRole('combobox', { name: 'Target column', exact: true }).selectOption('to_person');
  await dialog(page).getByRole('combobox', { name: 'Edge ID column', exact: true }).selectOption('relation');
  await page.getByTestId('csv-nodes-input').setInputFiles(csv('people.csv',
    'person_id,name,cluster,degree\n001,Alice,west,many\n002,Bob,east,2\n003,Carol,north,3\n'));
  await expect(dialog(page).getByRole('table', { name: 'Nodes preview' })).toContainText('Alice');
  await dialog(page).getByRole('combobox', { name: 'Node ID column', exact: true }).selectOption('person_id');
  await dialog(page).getByRole('button', { name: 'Import graph', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  await expect(page.getByTestId('node-count')).toHaveText('3');
  await expect(page.getByTestId('csv-summary')).toContainText('2 edges');
  await page.locator('[data-orbit-search-input]').fill('Alice');
  await expect(page.locator('[data-orbit-search-result]').first()).toContainText('Alice');
  await page.getByTestId('explorer-toggle').click();
  const explorer = page.getByRole('region', { name: 'Graph exploration' });
  await expect(explorer.locator('[data-orbit-table-row="001"]')).toBeVisible();
});

test('cancelling an in-flight import keeps the current dataset', async ({ page }) => {
  await slowFileReads(page);
  await ready(page);
  const before = await page.getByTestId('node-count').innerText();
  await page.getByTestId('csv-file-input').setInputFiles(slowCsv());
  await dialog(page).getByRole('button', { name: 'Import graph', exact: true }).click();
  await expect(page.getByTestId('csv-progress')).toContainText('Preparing graph');
  await dialog(page).getByRole('button', { name: 'Cancel import', exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  await expect(page.getByTestId('csv-panel')).toContainText('Import cancelled');
  await expect(page.getByTestId('node-count')).toHaveText(before);
  // A subsequent successful import must remain authoritative when the old read settles.
  await page.getByTestId('csv-file-input').setInputFiles(csv('small.csv', 'source,target\na,b\n'));
  await dialog(page).getByRole('button', { name: 'Import graph', exact: true }).click();
  await expect(page.getByTestId('node-count')).toHaveText('2');
  await expect(page.getByTestId('csv-summary')).toContainText('small.csv');
});

test('a second upload replaces an active preparation instead of being ignored', async ({ page }) => {
  await slowFileReads(page);
  await ready(page);
  await page.getByTestId('csv-file-input').setInputFiles(slowCsv());
  await dialog(page).getByRole('button', { name: 'Import graph', exact: true }).click();
  await expect(page.getByTestId('csv-progress')).toBeVisible();
  const chooseReplacement = page.waitForEvent('filechooser');
  await dialog(page).getByRole('button', { name: 'Choose different edges file', exact: true }).click();
  await (await chooseReplacement).setFiles(csv('replacement.csv', 'source,target\nnew-a,new-b\nnew-b,new-c\n'));
  await expect(dialog(page)).toContainText('replacement.csv');
  await dialog(page).getByRole('button', { name: 'Import graph', exact: true }).click();
  await expect(page.getByTestId('csv-summary')).toContainText('replacement.csv');
  await expect(page.getByTestId('node-count')).toHaveText('3');
});

test('preview errors preserve the graph and the importer fits a narrow screen', async ({ page }) => {
  await ready(page);
  const before = await page.getByTestId('node-count').innerText();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('csv-file-input').setInputFiles(csv('empty.csv', ''));
  await expect(dialog(page).getByRole('alert')).toContainText(/header|empty/i);
  await expect(dialog(page).getByRole('button', { name: 'Import graph', exact: true })).toBeDisabled();
  await expect(page.getByTestId('node-count')).toHaveText(before);
  const bounds = await dialog(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).not.toBeVisible();
});
