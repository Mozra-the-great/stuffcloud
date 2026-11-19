import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { APP_ROOT, E2E_DIST } from './paths.ts';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

if (!existsSync(resolve(E2E_DIST, 'index.html'))) {
  throw new Error(
    'the end-to-end build is missing: run `pnpm e2e:build` (or `pnpm e2e` from web/)',
  );
}

// The tests run against the built app (`vite build`, then `vite preview`), never the dev server:
// what is tested is what ships, minified chunks, hashed assets and lazy routes included.
export default defineConfig({
  testDir: resolve(import.meta.dirname, 'specs'),
  outputDir: resolve(APP_ROOT, 'test-results'),
  fullyParallel: true,
  // Few workers: each opens its own browser, and a burst of them is what makes a loopback
  // connection time out on a busy machine, which looks like a broken page.
  workers: process.env['CI'] === undefined ? 4 : 2,
  forbidOnly: process.env['CI'] !== undefined,
  // No retries: a test that passes on the second try is a flaky test, and it stays red.
  retries: 0,
  reporter:
    process.env['CI'] === undefined
      ? [['list']]
      : [
          ['list'],
          ['html', { outputFolder: resolve(APP_ROOT, 'playwright-report'), open: 'never' }],
        ],
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    // Fixed so that the language, motion and colours do not depend on the machine.
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    command: `pnpm exec vite preview --config e2e/vite.config.ts --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
    cwd: APP_ROOT,
    url: BASE_URL,
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 60_000,
  },
});
