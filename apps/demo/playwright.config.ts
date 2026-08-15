import { defineConfig } from '@playwright/test';

/**
 * Selection-workbench interaction smoke suite.
 *
 * Runs the real cosmos engine headless — SwiftShader WebGL is acceptable here
 * because these tests exercise interaction plumbing (selection algebra, lasso,
 * background clear), not GPU conformance. Run `pnpm e2e --headed` to watch.
 */
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 90_000,
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
      ]
    : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5199',
    browserName: 'chromium',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: [
        // Keep rAF unthrottled while the window is unfocused/occluded.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  },
  webServer: {
    command: 'pnpm exec vite --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199',
    // CI must always exercise this checkout, never an unrelated process that
    // happened to bind the demo port first.
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
