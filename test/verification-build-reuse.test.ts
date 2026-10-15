import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { planCommand } from '../src/verify/build-reuse.js';
import { renderRecordedVerification } from '../src/verify/evidence.js';
import {
  VerificationScheduler,
  outcomePayload,
  type VerificationOutcome,
  type VerificationProgress,
  type VerificationRecord,
} from '../src/verify/scheduler.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Issue #318: compatible gates (build+static, build+docs) share ONE build
 * execution while every gate-specific check still runs and is reported.
 * The "fake runner" is a fixture lane whose npm scripts are tiny node
 * programs appending to an out-of-tree step log.
 */

const STATIC = 'node tools/patch-vitest-rpc-timeout.mjs && npm run lint && npm run typecheck && npm run build';
const DOCS = 'npm run build && npm run config:docs';

const cleanups: Array<() => void> = [];
afterEach(() => {
  delete process.env['GRU_FIXTURE_BUILD_ENV'];
  while (cleanups.length > 0) cleanups.pop()!();
});

const STEP_SCRIPT = `
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const name = process.argv[2];
const ctl = process.env.GRU_FIXTURE_CTL ?? JSON.parse((await import('node:fs')).readFileSync(new URL('./ctl.json', import.meta.url), 'utf8')).dir;
appendFileSync(join(ctl, 'steps.log'), name + '\\n');
if (existsSync(join(ctl, 'fail-' + name))) { console.error('fixture failure: ' + name); process.exit(3); }
if (existsSync(join(ctl, 'slow-' + name))) await new Promise((r) => setTimeout(r, 30000));
if (name === 'build') {
  mkdirSync('dist/runtime', { recursive: true });
  writeFileSync('dist/build-rev.json', JSON.stringify({ n: Date.now() + Math.random() }));
  writeFileSync('dist/runtime/review-mcp-server.mjs', '// built ' + Math.random());
}
console.log('step ' + name + ' ok');
`;

interface Lane {
  readonly repo: FixtureRepo;
  readonly ctl: string;
  steps(): string[];
  flag(name: string): void;
  unflag(name: string): void;
}

function makeLane(): Lane {
  const repo = makeFixtureRepo('build-reuse-lane');
  const ctl = mkdtempSync(join(tmpdir(), 'gru-build-reuse-ctl-'));
  cleanups.push(() => rmSync(ctl, { recursive: true, force: true }), () => repo.cleanup());
  writeFileSync(join(ctl, 'steps.log'), '');
  repo.commitFile('.gitignore', 'dist/\n.npmrc\n');
  repo.commitFile('tools/step.mjs', STEP_SCRIPT);
  repo.commitFile('tools/ctl.json', JSON.stringify({ dir: ctl }));
  repo.commitFile('tools/patch-vitest-rpc-timeout.mjs', "import './step.mjs';\n");
  repo.commitFile(
    'package.json',
    JSON.stringify({
      name: 'lane',
      scripts: {
        lint: 'node tools/step.mjs lint',
        typecheck: 'node tools/step.mjs typecheck',
        build: 'node tools/step.mjs build',
        'config:docs': 'node tools/step.mjs config-docs',
      },
    }),
  );
  return {
    repo,
    ctl,
    steps: () => readFileSync(join(ctl, 'steps.log'), 'utf8').split('\n').filter((line) => line !== ''),
    flag: (name) => writeFileSync(join(ctl, name), ''),
    unflag: (name) => unlinkSync(join(ctl, name)),
  };
}

function makeScheduler(opts: { maxConcurrent?: number; runTimeoutMs?: number } = {}): VerificationScheduler {
  const storage = mkdtempSync(join(tmpdir(), 'gru-build-reuse-sched-'));
  const scheduler = new VerificationScheduler({
    storageDir: join(storage, 'verify'),
    limits: {
      maxConcurrent: opts.maxConcurrent ?? 1,
      workerBudget: 4,
      lockWaitTimeoutMs: 30_000,
      runTimeoutMs: opts.runTimeoutMs ?? 30_000,
    },
    sweepIntervalMs: 50,
    killGraceMs: 100,
    disposeGraceMs: 500,
  });
  cleanups.push(
    () => rmSync(storage, { recursive: true, force: true }),
    () => void scheduler.dispose(),
  );
  return scheduler;
}

function gate(
  lane: Lane,
  scope: string,
  command: string,
  sink?: (frame: VerificationProgress) => void,
  head: string = lane.repo.head(),
): { spec: Parameters<VerificationScheduler['submit']>[0]; sink: (frame: VerificationProgress) => void } {
  return {
    spec: { jobId: 'j-318', scope, command, cwd: lane.repo.path, head },
    sink: sink ?? (() => {}),
  };
}

async function run(
  scheduler: VerificationScheduler,
  lane: Lane,
  scope: string,
  command: string,
  sink?: (frame: VerificationProgress) => void,
): Promise<VerificationOutcome> {
  const g = gate(lane, scope, command, sink);
  return scheduler.submit(g.spec, g.sink);
}

const count = (steps: readonly string[], name: string): number => steps.filter((step) => step === name).length;

describe('planCommand — narrow decomposition', () => {
  it('decomposes only simple chains with exactly one reusable build step', () => {
    expect(planCommand(STATIC)).toMatchObject({ buildIndex: 3, refusal: null });
    expect(planCommand(DOCS)).toMatchObject({ buildIndex: 0, refusal: null, steps: ['npm run build', 'npm run config:docs'] });
  });

  it('treats unknown prerequisites and opaque shell as non-reusable', () => {
    expect(planCommand('npm run setup-things && npm run build && npm run x').refusal).toMatch(/^unknown-prerequisite/);
    expect(planCommand('cd web && npm run build && npm run x')).toMatchObject({ buildIndex: null, steps: ['cd web && npm run build && npm run x'] });
    expect(planCommand('npm run build || true').buildIndex).toBeNull();
    expect(planCommand('set -e; npm run build && npm run x').buildIndex).toBeNull();
    expect(planCommand('npm run build && npm run build').buildIndex).toBeNull();
    expect(planCommand('npm run lint && echo "a" && npm run build').buildIndex).toBeNull();
    expect(planCommand('npm run build').buildIndex).toBeNull();
  });
});

describe('verification build reuse (#318)', () => {
  it('runs the shared build once for build+static then build+docs and reports each check', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler();
    const first = await run(scheduler, lane, 'static', STATIC);
    const second = await run(scheduler, lane, 'docs', DOCS);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const steps = lane.steps();
    expect(count(steps, 'build')).toBe(1);
    expect(count(steps, 'lint')).toBe(1);
    expect(count(steps, 'typecheck')).toBe(1);
    expect(count(steps, 'config-docs')).toBe(1);

    expect(first.checks?.map((c) => [c.command, c.status, c.ran])).toEqual([
      ['node tools/patch-vitest-rpc-timeout.mjs', 'passed', true],
      ['npm run lint', 'passed', true],
      ['npm run typecheck', 'passed', true],
      ['npm run build', 'passed', true],
    ]);
    expect(second.checks).toEqual([
      expect.objectContaining({ command: 'npm run build', status: 'reused', ran: false, reusedFromRunId: first.runId, exitCode: null }),
      expect.objectContaining({ command: 'npm run config:docs', status: 'passed', ran: true, exitCode: 0, reusedFromRunId: null }),
    ]);
    // Queue time and execution time are separate numbers on every outcome.
    expect(typeof second.queuedMs).toBe('number');
    expect(typeof second.durationMs).toBe('number');
  });

  it('R15 received unsupported generated-output symlink cannot qualify whole-output build reuse', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler();
    const first = await run(scheduler, lane, 'static', STATIC);
    expect(first.ok).toBe(true);
    const externalOutput = join(lane.ctl, 'original-output.js');
    writeFileSync(externalOutput, '// original fixture output\n');
    symlinkSync(externalOutput, join(lane.repo.path, 'dist', 'linked-output.js'));
    writeFileSync(externalOutput, '// changed fixture output behind the original link\n');
    const docs = await run(scheduler, lane, 'docs', DOCS);
    expect(docs.ok).toBe(true);
    expect(docs.checks?.[0]).toMatchObject({ status: 'passed', ran: true, reuseRefusal: 'outputs-missing', reusedFromRunId: null });
    expect(count(lane.steps(), 'build')).toBe(2);
    expect(count(lane.steps(), 'config-docs')).toBe(1);
  });

  it('R16 received timeout cannot signal a settled native step across an actual reused-output await', async () => {
    const lane = makeLane(); const storage = mkdtempSync(join(tmpdir(), 'gru-r16-owned-step-'));
    const settled: number[] = [];
    const scheduler = new VerificationScheduler({ storageDir: storage,
      limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 30_000, runTimeoutMs: 30_000 },
      sweepIntervalMs: 50, killGraceMs: 100, disposeGraceMs: 500,
      onSettled: ({ pid }) => { if (pid !== null) settled.push(pid); } });
    let release!: () => void; const paused = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void; const reused = new Promise<void>((resolve) => { reached = resolve; });
    const signals: { readonly pid: number; readonly signal: string }[] = [];
    const originalKill = process.kill.bind(process);
    let running: Promise<VerificationOutcome> | null = null;
    try {
      expect((await run(scheduler, lane, 'warm', DOCS)).ok).toBe(true);
      settled.length = 0;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      // Harness safety: record real production attempts to signal the exact
      // exited native PID; never deliver a number-based signal to a stranger.
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') { signals.push({ pid, signal }); return true; }
        return originalKill(pid, signal);
      });
      running = run(scheduler, lane, 'after-original-step', 'npm run lint && npm run build && npm run config:docs', async (frame) => {
        if (frame.type === 'output' && frame.text.includes('[gru-verify] npm run build reused')) { reached(); await paused; }
      });
      await reused;
      expect(settled).toHaveLength(1);
      expect(() => originalKill(settled[0]!, 0)).toThrow();
      vi.advanceTimersByTime(30_000); vi.advanceTimersByTime(100);
      release(); const result = await running;
      expect(result.timedOut).toBe(true);
      expect(signals).toEqual([]);
      expect(count(lane.steps(), 'lint')).toBe(1);
      expect(count(lane.steps(), 'config-docs')).toBe(1);
    } finally {
      release(); if (running !== null) await running.catch(() => {});
      vi.restoreAllMocks(); vi.useRealTimers(); await scheduler.dispose(); rmSync(storage, { recursive: true, force: true });
    }
  });

  it('R16 received childless shutdown during reuse preserves original no-start through persistent readback', async () => {
    const lane = makeLane(); const storage = mkdtempSync(join(tmpdir(), 'gru-r16-reuse-no-start-'));
    const records: VerificationRecord[] = []; const frames: VerificationProgress[] = [];
    const options = { storageDir: storage,
      limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 30_000, runTimeoutMs: 30_000 },
      sweepIntervalMs: 50, killGraceMs: 100, disposeGraceMs: 500,
      record: (record: VerificationRecord) => { records.push(record); } };
    const scheduler = new VerificationScheduler(options);
    let release!: () => void; const paused = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void; const reused = new Promise<void>((resolve) => { reached = resolve; });
    const requestId = 'r16-original-childless-reuse'; let running: Promise<VerificationOutcome | Error> | null = null;
    let reopened: VerificationScheduler | null = null;
    try {
      expect((await run(scheduler, lane, 'warm', DOCS)).ok).toBe(true);
      const input = { ...gate(lane, 'childless-reuse', DOCS).spec, requestId };
      running = scheduler.submit(input, async (frame) => {
        frames.push(frame);
        if (frame.type === 'output' && frame.text.includes('[gru-verify] npm run build reused')) { reached(); await paused; }
      }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
      await reused;
      const original = scheduler.attemptStatus({ requestId })!;
      expect(original.started).toBe(false);
      await scheduler.dispose();
      expect(records.filter((record) => record.kind === 'verification.no-start')).toHaveLength(1);
      release(); await running;
      const immediate = scheduler.attemptStatus({ requestId });
      expect(immediate).toMatchObject({ runId: original.runId, state: 'admission-failed', started: false, error: { code: 'scheduler_disposed' } });
      expect(Object.hasOwn(immediate, 'outcome')).toBe(false);
      expect(immediate.outcome).toBeUndefined();
      expect(frames.some((frame) => frame.type === 'completed')).toBe(false);
      expect(records.filter((record) => record.kind === 'verification.completed' && record.payload['run_id'] === original.runId)).toEqual([]);
      reopened = new VerificationScheduler(options);
      reopened.start();
      const restored = reopened.attemptStatus({ requestId });
      expect(restored).toMatchObject({ runId: original.runId, state: 'admission-failed', started: false, error: { code: 'scheduler_disposed' } });
      expect(Object.hasOwn(restored, 'outcome')).toBe(false);
      expect(restored.outcome).toBeUndefined();
      expect(count(lane.steps(), 'config-docs')).toBe(1);
    } finally {
      release(); if (running !== null) await running; await reopened?.dispose(); await scheduler.dispose(); rmSync(storage, { recursive: true, force: true });
    }
  });

  async function assertR16OriginalNativeGrace(ignoreTerm: boolean): Promise<void> {
    const lane = makeLane(); const storage = mkdtempSync(join(tmpdir(), 'gru-r16-native-grace-'));
    let pid: number | null = null;
    const scheduler = new VerificationScheduler({ storageDir: storage,
      limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 30_000, runTimeoutMs: 30_000 },
      sweepIntervalMs: 50, killGraceMs: 100, disposeGraceMs: 500,
      onSpawn: (info) => { pid = info.pid; } });
    let reached!: () => void; const ready = new Promise<void>((resolve) => { reached = resolve; });
    const signals: string[] = []; const originalKill = process.kill.bind(process);
    let running: Promise<VerificationOutcome> | null = null;
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          expect(target).toBe(-pid!); signals.push(signal);
        }
        return originalKill(target, signal);
      });
      const body = `${ignoreTerm ? 'process.on("SIGTERM",()=>{});' : ''}console.log("r16-owned-ready");setInterval(()=>{},1000)`;
      running = run(scheduler, lane, 'actual-owned-child', `exec node -e '${body}'`, (frame) => {
        if (frame.type === 'output' && frame.text.includes('r16-owned-ready')) reached();
      });
      await ready;
      expect(pid).not.toBeNull(); expect(originalKill(pid!, 0)).toBe(true);
      vi.advanceTimersByTime(30_000);
      if (ignoreTerm) vi.advanceTimersByTime(100);
      const result = await running;
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe(ignoreTerm ? 'SIGKILL' : 'SIGTERM');
      expect(() => originalKill(pid!, 0)).toThrow();
      vi.advanceTimersByTime(100);
      expect(signals).toEqual(ignoreTerm ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM']);
    } finally {
      vi.restoreAllMocks(); vi.useRealTimers(); await scheduler.dispose();
      if (running !== null) await running.catch(() => {});
      rmSync(storage, { recursive: true, force: true });
    }
  }

  it('PR334 later-step spawn failure keeps the consumed request identity non-replayable', async () => {
    const lane = makeLane(); const storage = mkdtempSync(join(tmpdir(), 'gru-pr334-later-step-'));
    const moved = `${lane.repo.path}.moved`;
    let settledSteps = 0;
    const scheduler = new VerificationScheduler({ storageDir: storage,
      limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 30_000, runTimeoutMs: 30_000 },
      sweepIntervalMs: 50, killGraceMs: 100, disposeGraceMs: 500,
      onSettled: () => { settledSteps += 1; if (settledSteps === 1) renameSync(lane.repo.path, moved); } });
    const submit = () => scheduler.submit({ jobId: 'j-334', scope: 'docs', command: DOCS, cwd: lane.repo.path, head: lane.repo.head(), requestId: 'pr334-later-step' }, () => {});
    try {
      const first = await submit().catch((error: unknown) => error);
      renameSync(moved, lane.repo.path);
      expect(lane.steps()).toEqual(['build']);
      const second = await submit().catch((error: unknown) => error);
      // The consumed identity is never replayable: the original executed
      // step must not run again whatever the first attempt reported.
      expect(lane.steps()).toEqual(['build']);
      expect((first as VerificationOutcome).ok).toBe(false); expect(second).toBeDefined();
    } finally {
      await scheduler.dispose(); rmSync(storage, { recursive: true, force: true });
    }
  });

  it('R16 post-source healthy owned native exit detaches before the original grace callback', async () => {
    await assertR16OriginalNativeGrace(false);
  });

  it('R16 post-source healthy still-owned native child retains the original force-kill grace', async () => {
    await assertR16OriginalNativeGrace(true);
  });

  it('works in the other order (docs first, static reuses the build)', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler();
    const docs = await run(scheduler, lane, 'docs', DOCS);
    const stat = await run(scheduler, lane, 'static', STATIC);
    expect(docs.ok && stat.ok).toBe(true);
    expect(count(lane.steps(), 'build')).toBe(1);
    expect(stat.checks?.map((c) => [c.command, c.status])).toEqual([
      ['node tools/patch-vitest-rpc-timeout.mjs', 'passed'],
      ['npm run lint', 'passed'],
      ['npm run typecheck', 'passed'],
      ['npm run build', 'reused'],
    ]);
  });

  it('a reused build never implies the gate-specific check passed', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler();
    await run(scheduler, lane, 'static', STATIC);
    lane.flag('fail-config-docs');
    const docs = await run(scheduler, lane, 'docs', DOCS);
    expect(docs.ok).toBe(false);
    expect(docs.exitCode).toBe(3);
    expect(docs.checks?.map((c) => [c.command, c.status])).toEqual([
      ['npm run build', 'reused'],
      ['npm run config:docs', 'failed'],
    ]);
    expect(count(lane.steps(), 'config-docs')).toBe(1);
  });

  it('a failing static prerequisite leaves no build record and later steps unrun', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler();
    lane.flag('fail-lint');
    const stat = await run(scheduler, lane, 'static', STATIC);
    expect(stat.ok).toBe(false);
    expect(stat.checks?.map((c) => [c.command, c.status, c.ran])).toEqual([
      ['node tools/patch-vitest-rpc-timeout.mjs', 'passed', true],
      ['npm run lint', 'failed', true],
      ['npm run typecheck', 'not-run', false],
      ['npm run build', 'not-run', false],
    ]);
    expect(count(lane.steps(), 'build')).toBe(0);
    const docs = await run(scheduler, lane, 'docs', DOCS);
    expect(docs.ok).toBe(true);
    expect(count(lane.steps(), 'build')).toBe(1);
    expect(docs.checks?.[0]).toMatchObject({ status: 'passed', ran: true, reuseRefusal: 'no-prior-build' });
  });

  it('a failed build is not reusable and not retried automatically', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler();
    lane.flag('fail-build');
    const first = await run(scheduler, lane, 'docs', DOCS);
    expect(first.ok).toBe(false);
    expect(first.checks?.map((c) => [c.command, c.status])).toEqual([
      ['npm run build', 'failed'],
      ['npm run config:docs', 'not-run'],
    ]);
    expect(count(lane.steps(), 'build')).toBe(1);
    lane.unflag('fail-build');
    const second = await run(scheduler, lane, 'static', STATIC);
    expect(second.ok).toBe(true);
    expect(second.checks?.[3]).toMatchObject({ status: 'passed', ran: true, reuseRefusal: 'no-prior-build' });
  });

  describe('inputs that must not inherit the prior build', () => {
    async function warm(): Promise<{ lane: Lane; scheduler: VerificationScheduler }> {
      const lane = makeLane();
      const scheduler = makeScheduler();
      const first = await run(scheduler, lane, 'static', STATIC);
      expect(first.ok).toBe(true);
      expect(count(lane.steps(), 'build')).toBe(1);
      return { lane, scheduler };
    }

    async function expectRebuild(lane: Lane, scheduler: VerificationScheduler, refusal: string): Promise<void> {
      const docs = await run(scheduler, lane, 'docs', DOCS);
      expect(docs.ok).toBe(true);
      expect(count(lane.steps(), 'build')).toBe(2);
      expect(docs.checks?.[0]).toMatchObject({ status: 'passed', ran: true, reuseRefusal: refusal });
      expect(docs.checks?.[1]).toMatchObject({ status: 'passed', ran: true });
    }

    it('changed head', async () => {
      const { lane, scheduler } = await warm();
      lane.repo.commitFile('src/other.ts', 'export const other = 1;\n');
      await expectRebuild(lane, scheduler, 'head-changed');
    });

    it('dirty tracked input', async () => {
      const { lane, scheduler } = await warm();
      writeFileSync(join(lane.repo.path, 'README.md'), 'edited\n');
      await expectRebuild(lane, scheduler, 'dirty-input');
    });

    it('untracked input', async () => {
      const { lane, scheduler } = await warm();
      writeFileSync(join(lane.repo.path, 'src', 'new-untracked.ts'), 'export {};\n');
      await expectRebuild(lane, scheduler, 'dirty-input');
    });

    it('changed (ignored) configuration', async () => {
      const { lane, scheduler } = await warm();
      writeFileSync(join(lane.repo.path, '.npmrc'), 'foo=bar\n');
      await expectRebuild(lane, scheduler, 'config-changed');
    });

    it('changed environment', async () => {
      const { lane, scheduler } = await warm();
      process.env['GRU_FIXTURE_BUILD_ENV'] = 'different';
      await expectRebuild(lane, scheduler, 'env-changed');
    });

    it('missing outputs', async () => {
      const { lane, scheduler } = await warm();
      rmSync(join(lane.repo.path, 'dist'), { recursive: true, force: true });
      await expectRebuild(lane, scheduler, 'outputs-missing');
    });

    it('altered outputs names the first changed file', async () => {
      const { lane, scheduler } = await warm();
      writeFileSync(join(lane.repo.path, 'dist', 'build-rev.json'), '{"tampered":true}');
      await expectRebuild(lane, scheduler, 'outputs-changed: dist/build-rev.json');
    });

    it('an unsampled new output file also refuses reuse', async () => {
      const { lane, scheduler } = await warm();
      writeFileSync(join(lane.repo.path, 'dist', 'unsampled-output.js'), '// not one of the old samples\n');
      await expectRebuild(lane, scheduler, 'outputs-changed: dist/unsampled-output.js');
    });

    it('a different lane directory', async () => {
      const { lane, scheduler } = await warm();
      const other = makeLane();
      const docs = await run(scheduler, other, 'docs', DOCS);
      expect(docs.checks?.[0]).toMatchObject({ status: 'passed', ran: true, reuseRefusal: 'no-prior-build' });
      expect(count(lane.steps(), 'build')).toBe(1);
      expect(count(other.steps(), 'build')).toBe(1);
    });
  });

  it('unknown prerequisites run the declared command normally (no reuse, no decomposition)', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler();
    const opaque = 'node tools/step.mjs setup && npm run build && npm run config:docs';
    const one = await run(scheduler, lane, 'docs-a', opaque);
    const two = await run(scheduler, lane, 'docs-b', opaque);
    expect(one.ok && two.ok).toBe(true);
    expect(count(lane.steps(), 'build')).toBe(2);
    expect(one.checks).toBeUndefined();
    // And an opaque run never donates a record to a later compatible gate.
    const docs = await run(scheduler, lane, 'docs', DOCS);
    expect(count(lane.steps(), 'build')).toBe(3);
    expect(docs.checks?.[0]).toMatchObject({ status: 'passed', ran: true });
  });

  it('a timeout mid-build kills the run, leaves later steps unrun and is not inherited', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler({ runTimeoutMs: 1_500 });
    lane.flag('slow-build');
    const timed = await run(scheduler, lane, 'docs', DOCS);
    expect(timed.ok).toBe(false);
    expect(timed.timedOut).toBe(true);
    expect(timed.checks?.map((c) => [c.command, c.status])).toEqual([
      ['npm run build', 'failed'],
      ['npm run config:docs', 'not-run'],
    ]);
    expect(count(lane.steps(), 'config-docs')).toBe(0);
    lane.unflag('slow-build');
    const next = await run(scheduler, lane, 'static', STATIC);
    expect(next.ok).toBe(true);
    expect(next.checks?.[3]).toMatchObject({ status: 'passed', ran: true, reuseRefusal: 'no-prior-build' });
    expect(count(lane.steps(), 'build')).toBe(2);
  });

  it('keeps FIFO admission and the concurrency bound while reusing', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler({ maxConcurrent: 1 });
    const order: string[] = [];
    let maxActive = 0;
    const watch = (label: string) => (frame: VerificationProgress): void => {
      if (frame.type === 'started') order.push(label);
      maxActive = Math.max(maxActive, scheduler.activeCount());
    };
    const a = run(scheduler, lane, 'static', STATIC, watch('static'));
    const b = run(scheduler, lane, 'docs', DOCS, watch('docs'));
    const [first, second] = await Promise.all([a, b]);
    expect(order).toEqual(['static', 'docs']);
    expect(maxActive).toBe(1);
    expect(count(lane.steps(), 'build')).toBe(1);
    expect(second.checks?.[0]).toMatchObject({ status: 'reused', reusedFromRunId: first.runId });
    // The queued second run reports its wait apart from its execution time.
    expect(second.queuedMs).toBeGreaterThanOrEqual(first.durationMs - 5);
  });

  it('never reuses a build that another run is still producing in the same lane', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler({ maxConcurrent: 2 });
    lane.flag('slow-build');
    // Both start at once; the slow build is mid-flight when the other arrives.
    const a = run(scheduler, lane, 'docs', DOCS);
    const waitStart = async (): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (count(lane.steps(), 'build') < 1) {
        if (Date.now() > deadline) throw new Error('build never started');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await waitStart();
    lane.unflag('slow-build');
    const b = run(scheduler, lane, 'static', STATIC);
    const waitSecond = async (): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (count(lane.steps(), 'typecheck') < 1) {
        if (Date.now() > deadline) throw new Error('static never reached typecheck');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await waitSecond();
    const second = await b;
    expect(second.checks?.[3]).toMatchObject({ status: 'passed', ran: true, reuseRefusal: 'build-in-flight' });
    expect(count(lane.steps(), 'build')).toBe(2);
    await scheduler.dispose();
    await a.catch(() => undefined);
  }, 30_000);

  it('keeps the streamed capture and the exact-output proof consistent when a build is reused', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler();
    await run(scheduler, lane, 'static', STATIC);
    let streamed = '';
    const docs = await run(scheduler, lane, 'docs', DOCS, (frame) => {
      if (frame.type === 'output') streamed += frame.text;
    });
    expect(Buffer.byteLength(streamed)).toBe(docs.outputBytes);
    expect(createHash('sha256').update(streamed).digest('hex')).toBe(docs.outputSha256);
    expect(streamed).toContain('step config-docs ok');
    expect(streamed).toContain('npm run build reused');
    expect(streamed).not.toContain('step build ok');
    expect(docs.sha).toBe(lane.repo.head());
    expect(docs.trackedDirty).toBe(false);
  });

  it('records per-check evidence in the ledger payload and the rendered evidence block', async () => {
    const lane = makeLane();
    const scheduler = makeScheduler();
    await run(scheduler, lane, 'static', STATIC);
    const docs = await run(scheduler, lane, 'docs', DOCS);
    const payload = outcomePayload(docs);
    expect(payload['checks']).toEqual(docs.checks);
    const rendered = renderRecordedVerification({ ts: '2026-10-12T00:00:00Z', payload }, lane.repo.head());
    expect(rendered).not.toBeNull();
    expect(rendered).toContain('queued_ms:');
    expect(rendered).toContain('duration_ms:');
    expect(rendered).toContain('check: reused (not executed; build from run');
    expect(rendered).toContain('check: passed (exit 0) npm run config:docs');
    // A payload with no checks (historical record) renders unchanged.
    const { checks: _drop, ...legacy } = payload;
    const legacyRendered = renderRecordedVerification({ ts: 't', payload: legacy }, lane.repo.head());
    expect(legacyRendered).not.toContain('check:');
  });

  it('can be disabled: every declared step runs', async () => {
    const lane = makeLane();
    const storage = mkdtempSync(join(tmpdir(), 'gru-build-reuse-off-'));
    cleanups.push(() => rmSync(storage, { recursive: true, force: true }));
    const scheduler = new VerificationScheduler({
      storageDir: join(storage, 'verify'),
      limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 30_000, runTimeoutMs: 30_000 },
      buildReuse: false,
    });
    cleanups.push(() => void scheduler.dispose());
    await run(scheduler, lane, 'static', STATIC);
    const docs = await run(scheduler, lane, 'docs', DOCS);
    expect(docs.ok).toBe(true);
    expect(count(lane.steps(), 'build')).toBe(2);
    expect(existsSync(join(lane.repo.path, 'dist', 'build-rev.json'))).toBe(true);
  });
});
