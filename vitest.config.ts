import { configDefaults, defineConfig } from 'vitest/config';
import {
  FAST_TEST_TIMEOUT_MS,
  FAST_WORKER_CAP,
  applyWorkerBudget,
  budgetBanner,
  heavyTestPaths,
} from './test/helpers/test-budgets.js';

// Fast phase (workload-aware test budgets, owner-approved journal j-829).
//
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
//
// Process-heavy integration files are classified in
// test/helpers/test-budgets.ts and run as a SEPARATE phase
// (vitest.heavy.config.ts, 120s budgets, at most two workers) after this
// one, so aggregate workers never exceed the same global budget.
const effectiveWorkers = applyWorkerBudget(process.env, FAST_WORKER_CAP);
// stderr: stdout stays clean for machine-readable output (`vitest list --json`).
process.stderr.write(`${budgetBanner('fast', effectiveWorkers)}\n`);

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Compose with Vitest's defaults (a user-supplied exclude REPLACES them
    // wholesale): the classified heavy files leave the fast phase, the
    // node_modules/dist/dot-dir/config-file defaults stay in force.
    exclude: [...configDefaults.exclude, ...heavyTestPaths()],
    setupFiles: ['test/helpers/env-setup.ts', 'test/helpers/timeout-diagnostics.ts'],
    testTimeout: FAST_TEST_TIMEOUT_MS,
    hookTimeout: FAST_TEST_TIMEOUT_MS,
  },
});
