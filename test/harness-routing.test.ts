import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runOwnedCommand } from './helpers/harness-diagnostics.mjs';
import {
  FAST_TEST_TIMEOUT_MS,
  FAST_WORKER_CAP,
  HEAVY_TEST_TIMEOUT_MS,
  HEAVY_WORKER_CAP,
} from './helpers/test-budgets.js';

/**
 * Runtime routing guard (classified process-heavy: it spawns real Vitest
 * children as its critical path). Proves that the two phase scripts
 * `npm test` actually runs select disjoint file sets whose union is every
 * on-disk test file, and that each phase's config resolves to its budgeted
 * timeouts, worker count and diagnostics setup — a narrowed include, a
 * dropped or swapped phase script, or a config that drifted from the
 * policy module cannot ship green. Every child runs under its own
 * deadline, sized so a test's two children fit inside the 120s ceiling.
 */

const repoRoot = join(import.meta.dirname, '..');
const VITEST_BIN = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');
const CHILD_DEADLINE_MS = 50_000;
const PHASES = [
  { script: 'test:backend', timeoutMs: FAST_TEST_TIMEOUT_MS, workers: FAST_WORKER_CAP },
  { script: 'test:backend:heavy', timeoutMs: HEAVY_TEST_TIMEOUT_MS, workers: HEAVY_WORKER_CAP },
] as const;

function packageScripts(): Record<string, string> {
  return (
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
}

/** Nested Vitest children never inherit this run's pool pins or worker state. */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST'))),
    CI: 'true',
  };
}

/** The arguments a phase script passes after `vitest run` (e.g. `--config …`). */
function phaseArgs(script: string): string[] {
  const words = (packageScripts()[script] ?? '').trim().split(/\s+/);
  expect(words.slice(0, 2), `${script} must be a plain "vitest run …" phase command`).toEqual([
    'vitest',
    'run',
  ]);
  return words.slice(2);
}

function repoRelative(path: string): string {
  return relative(repoRoot, path).split('\\').join('/');
}

async function listPhase(script: string): Promise<string[]> {
  const result = await runOwnedCommand(
    process.execPath,
    [VITEST_BIN, 'list', ...phaseArgs(script), '--filesOnly', '--json'],
    {
      label: `vitest list (${script})`,
      deadlineMs: CHILD_DEADLINE_MS,
      cwd: repoRoot,
      env: childEnv(),
    },
  );
  expect(result.status, result.stderr).toBe(0);
  // The budget banner goes to stderr, so stdout is the JSON listing alone.
  expect(result.stderr).toContain('[test-budgets] phase=');
  const entries = JSON.parse(result.stdout) as Array<{ file: string }>;
  return entries
    .map((entry) => repoRelative(entry.file.startsWith('file://') ? fileURLToPath(entry.file) : entry.file))
    .sort();
}

interface ResolvedPhase {
  readonly testTimeout: number;
  readonly hookTimeout: number;
  readonly setupFiles: readonly string[];
  readonly maxForks: number | undefined;
  readonly maxThreads: number | undefined;
}

/** Resolve a phase script's config exactly as Vitest does, in a clean child. */
async function resolvePhase(script: string): Promise<ResolvedPhase> {
  const args = phaseArgs(script);
  const configIndex = args.indexOf('--config');
  const options = configIndex === -1 ? { mode: 'test' } : { mode: 'test', config: args[configIndex + 1] };
  const program = [
    "import { resolveConfig } from 'vitest/node';",
    `const { vitestConfig: c } = await resolveConfig(${JSON.stringify(options)});`,
    'process.stdout.write(JSON.stringify({',
    '  testTimeout: c.testTimeout,',
    '  hookTimeout: c.hookTimeout,',
    '  setupFiles: c.setupFiles,',
    '  maxForks: c.poolOptions?.forks?.maxForks,',
    '  maxThreads: c.poolOptions?.threads?.maxThreads,',
    '}));',
  ].join('\n');
  const result = await runOwnedCommand(process.execPath, ['--input-type=module', '-e', program], {
    label: `resolve config (${script})`,
    deadlineMs: CHILD_DEADLINE_MS,
    cwd: repoRoot,
    env: childEnv(),
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ResolvedPhase;
}

describe('phase routing at runtime', () => {
  it('selects every on-disk test file exactly once across the two phase scripts', async () => {
    const fast = await listPhase('test:backend');
    const heavy = await listPhase('test:backend:heavy');
    const onDisk = readdirSync(join(repoRoot, 'test'), { recursive: true })
      .map((name) => String(name).split('\\').join('/'))
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => `test/${name}`)
      .sort();
    expect(fast.length).toBeGreaterThan(0);
    expect(heavy.length).toBeGreaterThan(0);
    expect(fast.filter((file) => heavy.includes(file)), 'a file runs in both phases').toEqual([]);
    expect([...fast, ...heavy].sort(), 'the phase union must equal the on-disk test files').toEqual(onDisk);
  });

  it('keeps the full npm chain running both phases and the web suite', () => {
    const segments = (packageScripts()['test'] ?? '').split('&&').map((part) => part.trim());
    // Exact, ordered chain: a substring oracle would accept test:backend:heavy
    // in place of test:backend and miss a dropped phase.
    expect(segments).toEqual([
      'npm run lint',
      'npm run typecheck',
      'npm run build',
      'npm run test:backend',
      'npm run test:backend:heavy',
      'npm run test:web',
    ]);
  });

  it('resolves each phase script to its budgeted timeouts, workers and diagnostics setup', async () => {
    for (const { script, timeoutMs, workers } of PHASES) {
      const resolved = await resolvePhase(script);
      expect(resolved.testTimeout, `${script} testTimeout`).toBe(timeoutMs);
      expect(resolved.hookTimeout, `${script} hookTimeout`).toBe(timeoutMs);
      expect(resolved.maxForks, `${script} forks`).toBe(workers);
      expect(resolved.maxThreads, `${script} threads`).toBe(workers);
      expect(resolved.setupFiles.map(repoRelative), `${script} setupFiles`).toEqual([
        'test/helpers/env-setup.ts',
        'test/helpers/timeout-diagnostics.ts',
      ]);
    }
  });
});
