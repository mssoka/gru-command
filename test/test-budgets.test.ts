import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAST_TEST_TIMEOUT_MS,
  FAST_WORKER_CAP,
  HEAVY_TESTS,
  HEAVY_TEST_FILES,
  HEAVY_TEST_TIMEOUT_MS,
  HEAVY_WORKER_CAP,
  applyWorkerBudget,
  budgetBanner,
  heavyTestPaths,
  resolveWorkerBudget,
} from './helpers/test-budgets.js';

/**
 * Policy guard for workload-aware test budgets (owner-approved journal
 * j-829): the routing must partition every test file exactly once, the
 * approved budgets/caps must stay pinned, and the ten externally
 * observed 30s timeouts must stay classified as heavy BY NAME so a
 * rename surfaces here instead of silently dropping out of the policy.
 */

/** The ten Test-timed-out cases from the failed host run on 78724dc. */
const OBSERVED_TIMEOUTS: readonly { readonly file: string; readonly name: string }[] = [
  {
    file: 'dispatch-server.test.ts',
    name: 'by=silas on the pr/review endpoints records silas attribution events; without by it does not',
  },
  {
    file: 'install-one-line.test.ts',
    name: 'second run fast-forwards the existing clean checkout, preserves config, and does not re-run wizard',
  },
  {
    file: 'install-one-line.test.ts',
    name: 'refuses a non-fast-forward divergent checkout without reset',
  },
  {
    file: 'install-one-line.test.ts',
    name: 'restarts only an owned service and refuses a foreign unit with the same public name',
  },
  {
    file: 'perkins-builtin-wave.test.ts',
    name: 'terminalizes a workflow schema exception and preserves an INCOMPLETE report before sweep',
  },
  {
    file: 'perkins-builtin-wave.test.ts',
    name: 'fails loudly when the newest completed predecessor record is missing (B9)',
  },
  {
    file: 'perkins-builtin-wave.test.ts',
    name: 'does not record a reconciled delivery when the ref moved or the run aborted during the lookup (T4)',
  },
  {
    file: 'perkins-freeze-freshhead.test.ts',
    name: 'a non-PR origin/topic target FREEZES the fetched tip, never the stale local tracking ref (Perkins blocker)',
  },
  {
    file: 'perkins-whole-review.test.ts',
    name: 'rejects an empty/missing verdict, an empty report, and a report omitting the verdict line or frozen identity',
  },
  {
    file: 'wizard.test.ts',
    name: '--answers rejects secrets (token) and non-object JSON with the documented errors',
  },
];

describe('workload-aware test budgets', () => {
  it('partitions every test file exactly once between fast and heavy', () => {
    const files = readdirSync(import.meta.dirname)
      .filter((name) => name.endsWith('.test.ts'))
      .sort();
    expect(new Set(HEAVY_TEST_FILES).size).toBe(HEAVY_TEST_FILES.length);
    for (const file of HEAVY_TEST_FILES) {
      expect(files, `heavy classification names a missing file: ${file}`).toContain(file);
    }
    const heavy = new Set(HEAVY_TEST_FILES);
    const fast = files.filter((file) => !heavy.has(file));
    expect([...fast, ...HEAVY_TEST_FILES].sort()).toEqual(files);
    expect(heavyTestPaths()).toEqual(HEAVY_TEST_FILES.map((file) => `test/${file}`));
  });

  it('pins the approved fast and heavy budgets and worker caps', () => {
    expect(FAST_TEST_TIMEOUT_MS).toBe(30_000);
    expect(HEAVY_TEST_TIMEOUT_MS).toBe(120_000);
    expect(HEAVY_TEST_TIMEOUT_MS).toBeGreaterThan(FAST_TEST_TIMEOUT_MS);
    expect(FAST_WORKER_CAP).toBe(4);
    expect(HEAVY_WORKER_CAP).toBe(2);
  });

  it('documents a real-workload reason for every heavy file', () => {
    for (const entry of HEAVY_TESTS) {
      expect(entry.workload.length, `${entry.file} has no workload reason`).toBeGreaterThan(20);
    }
    expect(HEAVY_TESTS.map((entry) => entry.file)).toEqual(HEAVY_TEST_FILES);
  });

  it('classifies the ten observed 30s timeouts as heavy by exact test name', () => {
    for (const { file, name } of OBSERVED_TIMEOUTS) {
      expect(HEAVY_TEST_FILES, `${file} must be heavy`).toContain(file);
      const source = readFileSync(join(import.meta.dirname, file), 'utf-8');
      const registeredCase = `it${"("}'${name}'`;
      expect(source, `${file} lost the registered case: ${name}`).toContain(registeredCase);
    }
  });

  it('clamps each phase by any smaller scheduler pin and never below one worker', () => {
    expect(resolveWorkerBudget({}, HEAVY_WORKER_CAP)).toBe(2);
    expect(resolveWorkerBudget({}, FAST_WORKER_CAP)).toBe(4);
    expect(resolveWorkerBudget({ VITEST_MAX_THREADS: '1' }, HEAVY_WORKER_CAP)).toBe(1);
    expect(resolveWorkerBudget({ VITEST_MAX_THREADS: '3' }, HEAVY_WORKER_CAP)).toBe(2);
    expect(resolveWorkerBudget({ VITEST_MAX_FORKS: '3' }, HEAVY_WORKER_CAP)).toBe(2);
    expect(resolveWorkerBudget({ VITEST_MAX_THREADS: '2', VITEST_MAX_FORKS: '6' }, FAST_WORKER_CAP)).toBe(2);
    expect(resolveWorkerBudget({ VITEST_MAX_THREADS: '0' }, FAST_WORKER_CAP)).toBe(1);
    expect(resolveWorkerBudget({ VITEST_MAX_THREADS: 'not-a-number' }, FAST_WORKER_CAP)).toBe(4);

    const env: NodeJS.ProcessEnv = { VITEST_MAX_THREADS: '3' };
    expect(applyWorkerBudget(env, HEAVY_WORKER_CAP)).toBe(2);
    expect(env).toMatchObject({
      VITEST_MAX_THREADS: '2',
      VITEST_MIN_THREADS: '2',
      VITEST_MAX_FORKS: '2',
      VITEST_MIN_FORKS: '2',
    });
  });

  it('emits one greppable budget banner per phase with runner context', () => {
    expect(budgetBanner('fast', 4)).toContain('phase=fast workers=4 testTimeout=30000ms');
    const heavy = budgetBanner('heavy', 2);
    expect(heavy).toContain('phase=heavy workers=2');
    expect(heavy).toContain(`testTimeout=${HEAVY_TEST_TIMEOUT_MS}ms`);
    expect(heavy).toContain(`heavyFiles=${HEAVY_TEST_FILES.length}`);
  });

  it('keeps both phase configs derived from this module', () => {
    const root = join(import.meta.dirname, '..');
    const fast = readFileSync(join(root, 'vitest.config.ts'), 'utf-8');
    const heavy = readFileSync(join(root, 'vitest.heavy.config.ts'), 'utf-8');
    for (const source of [fast, heavy]) {
      expect(source).toContain("'./test/helpers/test-budgets.js'");
      expect(source).toContain('heavyTestPaths()');
      expect(source).toContain('applyWorkerBudget(process.env');
    }
    expect(fast).toContain('FAST_TEST_TIMEOUT_MS');
    expect(fast).toContain('exclude: heavyTestPaths()');
    expect(heavy).toContain('HEAVY_TEST_TIMEOUT_MS');
    expect(heavy).toContain('include: heavyTestPaths()');
  });
});
