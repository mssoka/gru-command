import { defineConfig } from 'vitest/config';
import {
  HEAVY_TEST_TIMEOUT_MS,
  HEAVY_WORKER_CAP,
  applyWorkerBudget,
  budgetBanner,
  heavyTestPaths,
} from './test/helpers/test-budgets.js';

// Heavy phase (workload-aware test budgets, owner-approved journal j-829).
//
// The classified process-heavy integration files from
// test/helpers/test-budgets.ts run here: a 120s test/hook ceiling (the
// approved initial budget) and at most two workers, still bounded by any
// smaller verification-scheduler pin. The fast phase (vitest.config.ts)
// ran before this one in the same `npm test` chain, so the two phases
// never overlap and the service's single global worker budget is never
// exceeded. Existing explicit per-test allowances stay untouched.
const effectiveWorkers = applyWorkerBudget(process.env, HEAVY_WORKER_CAP);
process.stdout.write(`${budgetBanner('heavy', effectiveWorkers)}\n`);

export default defineConfig({
  test: {
    include: heavyTestPaths(),
    setupFiles: ['test/helpers/env-setup.ts', 'test/helpers/timeout-diagnostics.ts'],
    testTimeout: HEAVY_TEST_TIMEOUT_MS,
    hookTimeout: HEAVY_TEST_TIMEOUT_MS,
  },
});
