import { defineConfig } from 'vitest/config';

/**
 * Integration configuration.
 *
 * WHY a separate config instead of an include flag on the unit config: these tests boot real
 * processes and bind real ports. Sharing a config with the unit suite would let a leaked child
 * process from one file interfere with the next, and the unit suite is supposed to stay fast and
 * hermetic. A separate project makes the boundary explicit.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.js'],
    // WHY a single worker and a long timeout: each test file boots three processes and waits for
    // health. Parallel files would fight over ports and multiply startup cost.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ['default'],
  },
});