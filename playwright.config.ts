import { defineConfig, devices } from '@playwright/test';

/**
 * E2E configuration.
 *
 * WHY the server is started by Playwright rather than assumed to be running: a suite that requires
 * a manually started dev server fails on CI with a confusing connection error, and a suite that
 * silently skips when the server is absent would report green while testing nothing (AGENTS.md
 * forbids that). Playwright starts it, waits for a real HTTP 200, and fails loudly otherwise.
 *
 * WHY `reuseExistingServer: false`: a developer's already-running `npm run dev` serves a DIFFERENT
 * artifact (Fast Refresh preamble, no CSP). Reusing it would make these tests assert nothing about
 * the thing they exist to verify.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // WHY a single worker: these tests share one static server and one browser profile. Parallelism
  // here buys little and makes CSP/console-assertion failures harder to read.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // WHY a desktop project only: the site is a desktop-first 3D portfolio and there is no responsive
    // layout to assert yet. Adding a mobile project now would assert behaviour that does not exist.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: [
    {
      command: 'node tests/e2e/static-server.mjs',
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: false,
      timeout: 30_000,
      env: { E2E_PORT: '4173' },
    },
    {
      // WHY the real stack and not a stub: the chat tests must exercise real SSE and real retrieval
      // through the gateway. Playwright waits for BOTH entries to be healthy before running, so a
      // stack that fails to boot fails the suite loudly instead of producing confusing 404s that a
      // streaming assertion could mistake for "an answer appeared".
      command: 'node scripts/e2e-stack.mjs',
      url: 'http://127.0.0.1:8082/healthz',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});