import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
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

/** The ten timed-out cases from 78724dc, including every explicit
 * descendant of the two formerly grouped cases split on this branch. */
const OBSERVED_TIMEOUTS: readonly { readonly file: string; readonly name: string }[] = [
  {
    file: 'dispatch-server.test.ts',
    name: 'by=silas on the pr/review endpoints records silas attribution events',
  },
  {
    file: 'dispatch-server.test.ts',
    name: 'without by, the pr/review endpoints record no silas attribution events',
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
    name: 'refuses a foreign unit with the same public name',
  },
  {
    file: 'install-one-line.test.ts',
    name: 'restarts only an owned service unit',
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
    name: 'does not record a reconciled delivery when the ref moved during the lookup (T4a)',
  },
  {
    file: 'perkins-builtin-wave.test.ts',
    name: 'does not record a reconciled delivery when the run aborted during the lookup (T4b)',
  },
  {
    file: 'perkins-freeze-freshhead.test.ts',
    name: 'a non-PR origin/topic target FREEZES the fetched tip, never the stale local tracking ref (Perkins blocker)',
  },
  {
    file: 'perkins-whole-review.test.ts',
    name: 'report rejection: a missing verdict is refused',
  },
  {
    file: 'perkins-whole-review.test.ts',
    name: 'report rejection: an empty report is refused',
  },
  {
    file: 'perkins-whole-review.test.ts',
    name: 'report rejection: a report omitting the verdict line is refused',
  },
  {
    file: 'perkins-whole-review.test.ts',
    name: 'report rejection: a report omitting the frozen identity is refused',
  },
  {
    file: 'wizard.test.ts',
    name: '--answers rejects secrets (token) and non-object JSON with the documented errors',
  },
];

describe('workload-aware test budgets', () => {
  // The exactly-once fast/heavy partition is proven at runtime against the
  // npm phase scripts in test/harness-routing.test.ts; this pins the list.
  it('classifies only existing, unique test files as heavy', () => {
    const files = readdirSync(import.meta.dirname)
      .filter((name) => name.endsWith('.test.ts'))
      .sort();
    expect(new Set(HEAVY_TEST_FILES).size).toBe(HEAVY_TEST_FILES.length);
    for (const file of HEAVY_TEST_FILES) {
      expect(files, `heavy classification names a missing file: ${file}`).toContain(file);
    }
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

  it('keeps the observed full-run ceiling file classified heavy (perkins-review-convergence)', () => {
    // Observed at 32817 ms against the 30 s fast ceiling under full-run
    // co-tenant load (19622/15079/11998 ms in the other preserved runs);
    // the classification is the documented mitigation and must not
    // silently drop back to the fast phase.
    expect(HEAVY_TEST_FILES).toContain('perkins-review-convergence.test.ts');
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

    // Every pinned knob counts, not just the max ones, and pins are parsed
    // strictly (no prefix parsing, empty assignments are absent).
    expect(resolveWorkerBudget({ VITEST_MAX_THREADS: '4', VITEST_MIN_THREADS: '2' }, FAST_WORKER_CAP)).toBe(2);
    expect(resolveWorkerBudget({ VITEST_MAX_FORKS: '3', VITEST_MIN_FORKS: '1' }, FAST_WORKER_CAP)).toBe(1);
    expect(resolveWorkerBudget({ VITEST_MAX_THREADS: '3abc' }, FAST_WORKER_CAP)).toBe(4);
    expect(resolveWorkerBudget({ VITEST_MAX_THREADS: '' }, FAST_WORKER_CAP)).toBe(4);
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
    expect(fast).toContain('exclude: [...configDefaults.exclude, ...heavyTestPaths()]');
    expect(heavy).toContain('HEAVY_TEST_TIMEOUT_MS');
    expect(heavy).toContain('include: heavyTestPaths()');
  });

  it('routes live scope segments that name heavy files through the heavy config, and only heavy files', () => {
    const manifest = parseToml(
      readFileSync(join(import.meta.dirname, '..', '.gru-command', 'worktree.toml'), 'utf-8'),
    ) as { verify?: Record<string, string> };
    const scopes = manifest.verify ?? {};
    expect(Object.keys(scopes).length).toBeGreaterThan(0);
    expect(scopes['perkins-stage1-baseline']).toBeDefined();
    const heavyPaths = heavyTestPaths();
    for (const [scope, command] of Object.entries(scopes)) {
      // These diagnostics intentionally run inside a pinned pre-policy git
      // archive without a heavy config. They are expected-RED baselines,
      // not current-tree verification segments; live scopes stay guarded.
      // Each exemption stays tied to the actual archived baseline: pinned
      // base SHA, archive command, isolated directory (and, where the
      // script ends unconditionally RED, exit 1) — restores the PR #179
      // isolation tie. wizard-bmad-retry-baseline archives base cee0ecb,
      // which predates the heavy/fast phase split entirely: that base has
      // no heavy config and its default config excludes nothing, so the
      // named files really run (no vacuous-pass risk the live guard
      // exists to catch); its expected RED comes from set -e propagating
      // the vitest exit, not an unconditional exit 1.
      if (scope === 'perkins-stage1-baseline') {
        expect(command).toContain('git archive "$base"');
        expect(command).toContain('base=9bb51b05af5d8f0a0cd389788d1d3f19607d5361');
        expect(command).toContain('cd "$d"');
        expect(command).toContain('exit 1');
        continue;
      }
      if (scope === 'wizard-bmad-retry-baseline') {
        expect(command).toContain('git archive "$base"');
        expect(command).toContain('base=cee0ecbe53229d05c13f909dd11d4b31e886db72');
        expect(command).toContain('cd "$d"');
        continue;
      }
      if (scope === 'perkins-stage1-baseline') {
        expect(command).toContain('git archive "$base"');
        expect(command).toContain('base=9bb51b05af5d8f0a0cd389788d1d3f19607d5361');
        expect(command).toContain('cd "$d"');
        expect(command).toContain('exit 1');
        continue;
      }
      if (scope === 'wizard-bmad-retry-baseline') {
        expect(command).toContain('git archive "$base"');
        expect(command).toContain('base=cee0ecbe53229d05c13f909dd11d4b31e886db72');
        continue;
      }
      for (const segment of command.split('&&').map((part) => part.trim())) {
        if (segment.includes('--config vitest.heavy.config.ts')) {
          // The heavy include is an explicit list: a fast file named here is
          // silently never run while the scope still exits 0.
          for (const path of segment.match(/\btest\/[\w./-]+\.test\.ts\b/g) ?? []) {
            expect(heavyPaths, `${scope} names a fast file in its heavy-config segment: ${path}`).toContain(path);
          }
          continue;
        }
        const namesHeavy = heavyPaths.some((path) => segment.includes(path));
        if (!namesHeavy) continue;
        expect(
          segment,
          `${scope} names a classified heavy file without --config vitest.heavy.config.ts: ${segment}`,
        ).toContain('--config vitest.heavy.config.ts');
      }
    }
  });

  it('keeps the ten-timeout-cases -t pattern matching every observed case', () => {
    const manifest = parseToml(
      readFileSync(join(import.meta.dirname, '..', '.gru-command', 'worktree.toml'), 'utf-8'),
    ) as { verify?: Record<string, string> };
    const command = (manifest.verify ?? {})['ten-timeout-cases'];
    expect(command, 'ten-timeout-cases scope is declared').toBeDefined();
    // The approved j-463 RPC patch runs first, like the other witnessed scopes.
    expect(command).toMatch(/^node tools\/patch-vitest-rpc-timeout\.mjs && /);
    expect(command).toContain('--config vitest.heavy.config.ts');
    const match = /-t\s+"([^"]+)"/.exec(command ?? '');
    expect(match, `no -t pattern in: ${command ?? '<missing>'}`).not.toBeNull();
    const pattern = new RegExp(match![1]!);
    for (const { file, name } of OBSERVED_TIMEOUTS) {
      expect(pattern.test(name), `${file}: -t pattern misses "${name}"`).toBe(true);
      // The pattern alone is not enough: the case's file must be selected too.
      expect(command, `ten-timeout-cases does not select test/${file}`).toContain(`test/${file}`);
    }
  });
});
