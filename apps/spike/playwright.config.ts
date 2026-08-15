import { defineConfig } from '@playwright/test';

/**
 * M0 spike probe suite.
 *
 * GPU-evidence policy: the eight GPU probes are meaningful only when run
 * headful on a real GPU (`PROBE_HEADFUL=1`, i.e. `pnpm probe` at the repo
 * root). Headless runs fall back to SwiftShader and are acceptable only as a
 * harness smoke test — never as conformance evidence.
 */
export default defineConfig({
  testDir: './probes',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  use: {
    browserName: 'chromium',
    headless: !process.env.PROBE_HEADFUL,
    viewport: { width: 1000, height: 800 },
    launchOptions: {
      args: [
        // Keep rAF unthrottled while the probe window is unfocused/occluded.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  },
  webServer: {
    command: 'pnpm exec vite',
    url: 'http://localhost:5299',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
