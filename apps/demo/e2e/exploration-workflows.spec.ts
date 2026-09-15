import { expect, test } from '@playwright/test';

test('CSV exploration connects search, paths, table filtering, and checkpoint restore', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.waitForSelector('[data-testid="status-dot"][title="ready"]');
  await page.getByTestId('csv-file-input').setInputFiles({
    name: 'suppliers.csv', mimeType: 'text/csv',
    buffer: Buffer.from('source,target,type,evidence\nAcme,Beta,SUPPLIES,Contract\nBeta,Cedar,SUPPLIES,Invoice\n'),
  });
  await expect(page.getByTestId('node-count')).toHaveText('3');
  await page.getByTestId('explorer-toggle').click();
  const explorer = page.getByRole('region', { name: 'Graph exploration' });
  await expect(explorer).toBeVisible();
  await explorer.getByRole('combobox', { name: 'Search graph' }).fill('Acme');
  await explorer.getByRole('option', { name: /Acme/ }).click();
  await expect(explorer.getByRole('complementary')).toContainText('Acme');
  await explorer.locator('[data-orbit-table-row="Acme"]').click();
  await explorer.getByRole('button', { name: 'Hide selected', exact: true }).click();
  await explorer.getByRole('combobox', { name: 'Search graph' }).fill('Beta');
  await explorer.getByRole('combobox', { name: 'Search graph' }).fill('Acme');
  await explorer.getByRole('option', { name: /Acme/ }).click();
  await expect(explorer.getByRole('button', { name: 'Reveal filtered entity' })).toBeVisible();
  await explorer.getByRole('button', { name: 'Reveal filtered entity' }).click();
  await expect(explorer.getByRole('region', { name: 'Active constraints' })).toContainText('3 nodes');
  await explorer.getByLabel('Path source', { exact: true }).fill('Acme');
  await explorer.getByLabel('Path target', { exact: true }).fill('Cedar');
  await explorer.getByLabel('Path direction', { exact: true }).selectOption('outgoing');
  await explorer.getByRole('button', { name: 'Find connection', exact: true }).click();
  await expect(explorer.locator('[data-orbit-saved-path] li')).toHaveText(['Acme → SUPPLIES', 'Beta → SUPPLIES', 'Cedar']);
  await explorer.getByLabel('Investigation title').fill('Supplier evidence');
  await explorer.getByLabel('Investigation notes').fill('Verify the contract and invoice.');
  await explorer.locator('[data-orbit-table-filter]').fill('Beta');
  await expect(explorer.getByRole('region', { name: 'Active constraints' })).toContainText('1 nodes');
  await explorer.getByRole('button', { name: 'Save checkpoint', exact: true }).click();
  await expect(explorer.getByRole('button', { name: 'Restore Supplier evidence' })).toBeVisible();
  await explorer.locator('[data-orbit-table-filter]').fill('');
  await explorer.getByLabel('Investigation notes').fill('Changed');
  await explorer.getByRole('button', { name: 'Restore Supplier evidence' }).click();
  await expect(explorer.getByLabel('Investigation notes')).toHaveValue('Verify the contract and invoice.');
  await expect(explorer.locator('[data-orbit-table-filter]')).toHaveValue('Beta');
  await expect(explorer.getByRole('region', { name: 'Active constraints' })).toContainText('1 nodes');
  await page.screenshot({ path: testInfo.outputPath('exploration-workspace.png') });
  await page.setViewportSize({ width: 800, height: 900 });
  const panel = await explorer.boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(800);
  await expect(page.getByRole('button', { name: 'Close explorer' })).toBeVisible();
  await page.reload();
  await page.waitForSelector('[data-testid="status-dot"][title="ready"]');
  await page.getByTestId('explorer-toggle').click();
  await explorer.getByRole('button', { name: 'Restore Supplier evidence' }).click();
  await expect(explorer.getByRole('alert')).toContainText('Load the checkpoint source');
  await expect(explorer.getByLabel('Investigation notes')).toHaveValue('');
});
