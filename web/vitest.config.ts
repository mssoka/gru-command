import { defineConfig } from 'vitest/config';

// Same co-tenant headroom clamp as the root vitest.config.ts: under
// scheduled verification the environment pins the pool to the cross-lane
// budget (cores - 2), while dispatched lanes and housekeeping burst
// outside it on the same host. Clamp the effective pool so the web suite
// keeps headroom; tests, assertions, and timeouts are untouched.
const SUITE_WORKER_CAP = 6;
const pinnedPools = [process.env.VITEST_MAX_THREADS, process.env.VITEST_MAX_FORKS]
  .map((value) => (value === undefined ? Number.NaN : Number.parseInt(value, 10)))
  .filter((value) => Number.isFinite(value));
const effectiveCap =
  pinnedPools.length > 0 ? Math.min(...pinnedPools, SUITE_WORKER_CAP) : SUITE_WORKER_CAP;
process.env.VITEST_MAX_THREADS = String(effectiveCap);
process.env.VITEST_MIN_THREADS = String(effectiveCap);
process.env.VITEST_MAX_FORKS = String(effectiveCap);
process.env.VITEST_MIN_FORKS = String(effectiveCap);

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
