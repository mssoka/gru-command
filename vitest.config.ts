import { defineConfig } from 'vitest/config';

// Co-tenant headroom on a shared host. The verify scheduler pins
// VITEST_MAX/MIN_THREADS/FORKS in the run environment (one cross-lane
// budget, cores - 2), but dispatched job lanes and service housekeeping
// run OUTSIDE that budget and burst hot on the same box. At the full pin
// the suite starves its own children: boot deadlines expire with zero
// bytes observed, vitest RPC calls time out, and tests fail on the 30s
// per-test ceiling with zero assertion failures. Clamp the effective pool
// size so the suite keeps headroom for load it cannot see. This changes
// harness parallelism ONLY — the tests, assertions, and every timeout
// stay exactly as authored. The scheduler's pin (if present) still acts
// as the upper bound; the config module executes before resolveConfig
// applies the environment, so clamping here composes with it.
const SUITE_WORKER_CAP = 4;
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
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/helpers/env-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
