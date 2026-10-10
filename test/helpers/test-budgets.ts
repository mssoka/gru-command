/**
 * Workload-aware test budgets (owner-approved policy, journal j-829).
 *
 * The backend suite has two phases with one shared policy:
 *  - FAST: the default for unit/in-process suites. 30s test and hook
 *    ceiling, up to four workers (still clamped by any smaller scheduler
 *    pin). This is the unchanged pre-policy behavior.
 *  - HEAVY: process-heavy integration suites. 120s test and hook ceiling
 *    and at most two workers, still clamped by any smaller scheduler pin.
 *
 * The phases run SEQUENTIALLY (see package.json `test`), so the
 * aggregate worker count never exceeds the service's single global
 * verification budget at any moment, and the heavy phase never spawns
 * "two workers per project" alongside the fast pool.
 *
 * Classification criterion: the file's tests exercise real operating
 * system processes or durable system state as the subject or critical
 * path — product install/build/onboarding pipelines, spawned service or
 * CLI binaries, PTY sessions, real git repository/worktree flows, or the
 * verification runner's own subprocess execution — such that a loaded
 * host can push a single test past the fast 30s ceiling. Files that only
 * use in-process fakes, in-memory ports, sqlite temp files, or a handful
 * of short-lived git fixture commands for pure logic stay fast.
 *
 * Membership is deliberate and documented per file. Existing explicit
 * per-test allowances (larger or smaller than 120s) are preserved as
 * authored and are not touched by this policy.
 */

export const FAST_TEST_TIMEOUT_MS = 30_000;
export const HEAVY_TEST_TIMEOUT_MS = 120_000;
export const FAST_WORKER_CAP = 4;
export const HEAVY_WORKER_CAP = 2;

export interface HeavyTestEntry {
  /** Test file basename under test/ (kept flat on purpose). */
  readonly file: string;
  /** Why this file is process-heavy integration (real workload, not history). */
  readonly workload: string;
}

export const HEAVY_TESTS: readonly HeavyTestEntry[] = Object.freeze([
  { file: 'admission-retry-service.test.ts', workload: 'real service boot resuming a durable admission retry' },
  {
    file: 'attachments.test.ts',
    workload: 'spawns and reaps a real child process and streams large real files',
  },
  {
    file: 'bmad-legacy-retirement.test.ts',
    workload: 'runs the documented retirement commands (python, git worktrees, uv renders) against a disposable repo',
  },
  {
    file: 'bmad-onboarding.test.ts',
    workload: 'compiled GC setup CLI over many real Git repositories, including unchanged independent BMAD state',
  },
  {
    file: 'bmad-runtime-packaged.test.ts',
    workload: 'npm pack staging plus compiled-product uv renders over git worktrees',
  },
  {
    file: 'bmad-runtime.test.ts',
    workload: 'real uv renders of the bundled BMAD runtime over git repositories and worktrees',
  },
  { file: 'branch-idle-guard.test.ts', workload: 'real service and git lane lifecycle' },
  { file: 'claude-adapter.test.ts', workload: 'real CLI child processes over stdio per test' },
  {
    file: 'decisions-service-integration.test.ts',
    workload: 'boots and restarts the real service with compiled CLIs',
  },
  { file: 'dispatch-e2e.test.ts', workload: 'end-to-end dispatch arc over real git fixtures' },
  {
    file: 'dispatch-server.test.ts',
    workload: 'HTTP ops surface over real git fixture repositories',
  },
  { file: 'fix-directive.test.ts', workload: 'dispatch/fix flow over real git fixtures' },
  { file: 'gc-bootstrap-retirement.test.ts', workload: 'runs owner retirement/restore shell and Python commands over Git worktrees and backup corruption fixtures' },
  {
    file: 'harness-diagnostics.test.ts',
    workload: 'spawns a real Vitest child over a temp fixture to prove the timeout/failure wiring',
  },
  {
    file: 'harness-routing.test.ts',
    workload: 'spawns two real Vitest collection children as the runtime phase-partition guard',
  },
  { file: 'install-one-line.test.ts', workload: 'install.sh clone/build/service pipelines' },
  { file: 'install.test.ts', workload: 'install.sh CLI contracts through real subprocesses' },
  { file: 'lan-phone-raw-client.test.ts', workload: 'real service over sockets with the raw client' },
  { file: 'listener-probe.test.ts', workload: 'real child listeners and service port-guard probes' },
  { file: 'lessons-dream-service.test.ts', workload: 'real compiled service boots: a failing dream pass, and a proposal accepted over HTTP' },
  {
    file: 'perkins-admission-preflight.test.ts',
    workload: 'real git fixture freezes plus frozen-packet corruption scenarios',
  },
  {
    file: 'perkins-builtin-wave.test.ts',
    workload: 'wave/worktree/review flows over real git repositories',
  },
  {
    file: 'perkins-freeze-freshhead.test.ts',
    workload: 'fetch/freeze resolution over real git remotes',
  },
  {
    file: 'perkins-whole-review.test.ts',
    workload: 'whole-review engine over real worktrees and git',
  },
  { file: 'rehearsal.test.ts', workload: 'package/build/install rehearsal with real npm' },
  { file: 'service-port-guard.test.ts', workload: 'real service spawns and port behavior' },
  { file: 'shutdown.test.ts', workload: 'real service signal lifecycle' },
  {
    file: 'silas-followthrough.test.ts',
    workload: 'event-driven follow-through over real git/service state',
  },
  { file: 'uploads-dir.test.ts', workload: 'real service boot against real filesystem state' },
  { file: 'verification-server.test.ts', workload: 'verification runner spawning real declared commands' },
  { file: 'wake-e2e.test.ts', workload: 'real service wake-on-alert flow' },
  { file: 'workflow-runtime-packaged.test.ts', workload: 'extracts the actual npm archive and drives compiled workflow CLIs over a real git lane' },
  { file: 'wizard-interactive.test.ts', workload: 'PTY wizard session against the built CLI' },
  { file: 'wizard-register.test.ts', workload: 'install.sh service registration subprocess' },
  { file: 'wizard.test.ts', workload: 'built wizard CLI subprocesses' },
  { file: 'worktree-manager.test.ts', workload: 'git worktree manager with real subprocesses' },
  { file: 'worktrees-server.test.ts', workload: 'worktree HTTP surface over real git' },
]);

export const HEAVY_TEST_FILES: readonly string[] = Object.freeze(
  HEAVY_TESTS.map((entry) => entry.file),
);

/** Repo-relative paths for the heavy phase / fast-phase exclusion. */
export function heavyTestPaths(): string[] {
  return HEAVY_TEST_FILES.map((file) => `test/${file}`);
}

/**
 * The documented worker clamp: the phase cap bounded by every pinned pool
 * knob in the environment (the verification scheduler pins all four to
 * the one cross-lane budget). A smaller pin always wins; the result is
 * never below one worker. Values are parsed strictly — a non-integer
 * pin (or an empty assignment) is ignored rather than prefix-parsed.
 */
export function resolveWorkerBudget(env: NodeJS.ProcessEnv, cap: number): number {
  const pinned = [
    env['VITEST_MAX_THREADS'],
    env['VITEST_MIN_THREADS'],
    env['VITEST_MAX_FORKS'],
    env['VITEST_MIN_FORKS'],
  ]
    .map((value) => (value === undefined || value.trim() === '' ? Number.NaN : Number(value)))
    .filter((value) => Number.isInteger(value));
  return pinned.length > 0 ? Math.max(1, Math.min(...pinned, cap)) : cap;
}

/**
 * Pin the pool knobs for this phase (both pool families) and return the
 * effective worker count. Runs while the config module is evaluated, so
 * the values are in place before resolveConfig applies the environment.
 */
export function applyWorkerBudget(env: NodeJS.ProcessEnv, cap: number): number {
  const effective = resolveWorkerBudget(env, cap);
  env['VITEST_MAX_THREADS'] = String(effective);
  env['VITEST_MIN_THREADS'] = String(effective);
  env['VITEST_MAX_FORKS'] = String(effective);
  env['VITEST_MIN_FORKS'] = String(effective);
  return effective;
}

/** One bounded, greppable line per phase so receipts carry runner context. */
export function budgetBanner(phase: 'fast' | 'heavy', effectiveWorkers: number): string {
  const timeout = phase === 'fast' ? FAST_TEST_TIMEOUT_MS : HEAVY_TEST_TIMEOUT_MS;
  const count = phase === 'fast' ? undefined : heavyTestPaths().length;
  return (
    `[test-budgets] phase=${phase} workers=${effectiveWorkers} ` +
    `testTimeout=${timeout}ms hookTimeout=${timeout}ms` +
    (count === undefined ? '' : ` heavyFiles=${count}`)
  );
}
