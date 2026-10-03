import { defineConfig } from 'vitest/config';

/**
 * WHY a single root vitest config: every JS test in the repo (gateway, contracts, web) must share
 * one runner so `npm run verify:fast` is a single command. `globals: true` keeps test files free
 * of boilerplate imports, which matters when a test file is mostly assertions about behaviour.
 *
 * ALTERNATIVES: per-workspace vitest configs (three configs to keep in sync, and a test in
 * packages/contracts would need the right one selected by hand).
 * WHY NOT: the duplication risk is larger than the value of separation here.
 *
 * TRADE-OFF: globals must be declared in TypeScript via `types: ["vitest/globals"]` for editor
 * support; that is handled in tsconfig.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['{apps,services,packages,tests}/**/*.test.js'],
    // WHY tests/integration is EXCLUDED here: it spawns three real processes and binds real ports,
    // so falling into this glob made `npm run verify:fast` boot a server stack and run its files
    // under a 20s timeout meant for unit tests. It has its own config and its own task.
    // tests/e2e is listed for the same reason, though it is doubly excluded already: its files are
    // `.spec.ts`, which this `*.test.js` include would never match.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.venv/**',
      'tests/integration/**',
      'tests/e2e/**',
    ],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'reports/junit.xml' },
    testTimeout: 20000,
    hookTimeout: 20000,
    // WHY pool isolation matters here: several suites bind real TCP ports (the fake providers).
    // With the default shared pool, a suite holding :8090 while another tries to bind it fails
    // for the wrong reason. `forks` gives each file its own process and its own port space.
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
  },
});