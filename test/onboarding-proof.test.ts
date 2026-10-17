import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SILAS_CONFIG, loadConfig, type Role } from '../src/config.js';
import { BranchBusyError, BRANCH_BUSY_ONBOARDING_HINT, laneIsBusy } from '../src/dispatch/branch-idle.js';
import type { GhIssueComment, RepoRef } from '../src/dispatch/github-poll.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { computeSilasDigest } from '../src/dispatch/silas-driver.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { onboardingJobId } from '../src/onboarding/briefing.js';
import { ONBOARDING_EVENTS } from '../src/onboarding/ledger.js';
import {
  appendOnboardingProof,
  onboardingProofMarker,
  onboardingProofPayload,
  renderOnboardingProofEvidence,
  runOnboardingProof,
  type OnboardingProofInput,
  type OnboardingProofOutcome,
  type OnboardingProofResult,
} from '../src/onboarding/proof.js';
import {
  ONBOARDING_PROOF_FAILING_KIND,
  OnboardingService,
  onboardingProofDirectiveId,
  type OnboardingProofDirective,
} from '../src/onboarding/service.js';
import { createVerificationServer, ONBOARDING_PROOF_SCOPE, type VerificationServer } from '../src/verify/server.js';
import { FROZEN_SPEC_MAX_BYTES } from '../src/dispatch/perkins-review/artifacts.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { GitReviewPort } from './helpers/git-review-port.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';

/**
 * Onboarding proof (#427 PR 1b): code proves an onboarding PR's manifest
 * before review. The proof itself runs for real here: a real repository
 * whose onboarding lane is a real linked worktree, a real throwaway clone,
 * the manifest's real commands, and the real verification server's budget.
 * The service's follow-through (PR comment, directive, Gru row) runs on a
 * real ledger with a stand-in proof, GitHub and directive path; the review
 * fence runs through the real WaveRunner and Silas digest.
 */

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const IDENTITY = ['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid'];
const JOB = onboardingJobId('fixture-app', 1);
const PR_URL = 'https://github.com/acme/fixture-app/pull/7';
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);

function bootLedger(): { readonly ledger: LedgerApi; readonly bus: EventBus; readonly dir: string } {
  const dir = temp('gru-onboarding-proof-db-');
  const db = new LedgerDb(dir);
  closers.push(() => db.close());
  const bus = new EventBus({});
  return { ledger: new LedgerApi(db.handle, { bus }), bus, dir };
}

/** An onboarding heist as the service records it: its job, then the
 * `onboarding.dispatched` event that alone makes the job an onboarding job. */
function onboardingJob(ledger: LedgerApi, jobId = JOB): void {
  ledger.addJob({ id: jobId, repo: 'fixture-app', title: 'Onboard fixture-app to GC', briefing: 'Write the manifest.' });
  ledger.setJobStatus(jobId, 'working');
  ledger.appendCustomEvent({ kind: ONBOARDING_EVENTS.dispatched, payload: { repo: 'fixture-app', job_id: jobId, launched_by: 'autonomous' } });
}

const deliver = (ledger: LedgerApi, head: string, jobId = JOB): void => {
  ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: head } });
};

// ------------------------------------------------------------------
// The real proof: throwaway checkout, setup, leased verify, measure
// ------------------------------------------------------------------

interface ProofLane {
  readonly repo: FixtureRepo;
  readonly head: string;
  readonly probes: string;
  readonly ledger: LedgerApi;
  readonly server: VerificationServer;
  /** The user's repository as git reports it (worktrees, branches, status). */
  userRepoState(): string;
  prove(overrides?: Partial<OnboardingProofInput>): Promise<OnboardingProofOutcome>;
}

/** A managed repository whose onboarding lane (a real linked worktree, as
 * GC's lanes are) committed `manifest`; a real verification server owns
 * the global budget. */
async function proofLane(manifest: string, opts: { readonly lockWaitTimeoutMs?: number; readonly files?: Readonly<Record<string, string>> } = {}): Promise<ProofLane> {
  const repo = makeFixtureRepo('fixture-app');
  repos.push(repo);
  repo.commitFile('.gitignore', 'build/\n');
  const lane = join(temp('gru-onboarding-proof-lane-'), 'lane');
  repo.git(['worktree', 'add', '-q', '-b', `gru/${JOB}`, lane]);
  mkdirSync(join(lane, '.gru-command'));
  writeFileSync(join(lane, '.gru-command', 'worktree.toml'), manifest);
  for (const [rel, content] of Object.entries(opts.files ?? {})) writeFileSync(join(lane, rel), content);
  repo.git(['add', '-A'], lane);
  repo.git([...IDENTITY, 'commit', '-q', '-m', 'Onboard fixture-app to GC'], lane);
  const head = repo.git(['rev-parse', 'HEAD'], lane);
  const home = temp('gru-onboarding-proof-home-');
  writeFileSync(join(home, 'config.toml'), [
    '[auth]', 'token = "onboarding-proof-token"', '[verify]', 'max_concurrent = 1', 'worker_budget = 2',
    `lock_wait_timeout_ms = ${String(opts.lockWaitTimeoutMs ?? 5_000)}`, 'run_timeout_ms = 20000', '',
  ].join('\n'));
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const { ledger } = bootLedger();
  onboardingJob(ledger);
  deliver(ledger, head);
  const server = createVerificationServer({ config, ledger, worktrees: new InMemoryWorktreePort(temp('gru-onboarding-proof-wt-'), ledger) });
  closers.push(() => server.dispose());
  const probes = join(temp('gru-onboarding-proof-data-'), 'onboarding-probes');
  return {
    repo, head, probes, ledger, server,
    userRepoState: () => [
      repo.git(['worktree', 'list', '--porcelain']),
      repo.git(['for-each-ref', '--format=%(refname) %(objectname)']),
      repo.git(['status', '--porcelain', '--ignored']),
    ].join('\n---\n'),
    prove: (overrides = {}) => runOnboardingProof({
      jobId: JOB, head, repoPath: repo.path, probesDir: probes, setupTimeoutMs: 20_000, runTimeoutMs: 20_000,
      budget: () => server.budget(), signal: new AbortController().signal, ...overrides,
    }),
  };
}

function proven(outcome: OnboardingProofOutcome): OnboardingProofResult {
  if (outcome.kind !== 'proven') throw new Error(`expected a proof, got deferred: ${outcome.reason}`);
  return outcome.result;
}

const verificationEvents = (ledger: LedgerApi): readonly unknown[] =>
  ledger.listEvents({ limit: 1000 }).filter((event) => event.kind.startsWith('verification.'));

describe('the proof (real checkout, setup and leased verify)', () => {
  it('Pass: setup and verify succeed, reclaim build appears ignored; timings, sizes and lane size are measured; nothing is left and nothing is verification evidence', async () => {
    const lane = await proofLane([
      'reclaim = ["build"]',
      '[[setup]]',
      'command = "mkdir -p build && printf 12345 > build/out"',
      '[verify]',
      'full = "test -f build/out && echo tests passed"',
      '',
    ].join('\n'));
    const before = lane.userRepoState();
    const debtBefore = lane.ledger.correctiveVerificationDebt(JOB);
    const result = proven(await lane.prove());
    expect(result).toMatchObject({ head: lane.head, passed: true, failures: [], appearedCount: 1, outputTail: '' });
    expect(result.setup).toEqual([{ command: 'mkdir -p build && printf 12345 > build/out', ms: expect.any(Number), ok: true }]);
    expect(result.verify).toMatchObject({ command: 'test -f build/out && echo tests passed', exitCode: 0, timedOut: false, workers: 2, outputBytes: 13 });
    expect(result.appeared).toEqual([{ path: 'build/', bytes: 5 }]);
    expect(result.reclaim).toEqual([{ path: 'build', appeared: true, ignored: true, trackedFiles: 0, bytes: 5 }]);
    expect(result.laneBytes).toBeGreaterThan(5);
    // The proof leaves nothing behind and touches nothing of the user's.
    expect(readdirSync(lane.probes)).toEqual([]);
    expect(lane.userRepoState()).toBe(before);
    // A proof is never the job's verification evidence.
    expect(verificationEvents(lane.ledger)).toEqual([]);
    expect(lane.ledger.correctiveVerificationDebt(JOB)).toEqual(debtBefore);
    expect(lane.server.view()).toMatchObject({ activeRuns: 0, queuedRuns: 0 });
  });

  it('Setup fails: a setup command exits 2 — failed with its output tail; verify never runs', async () => {
    const lane = await proofLane('[[setup]]\ncommand = "echo cannot-install >&2; exit 2"\n[verify]\nfull = "echo never"\n');
    const before = lane.userRepoState();
    const result = proven(await lane.prove());
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(['setup command 1 failed: worktree setup command exited 2: echo cannot-install >&2; exit 2']);
    expect(result.outputTail).toContain('cannot-install');
    expect(result.verify).toBeNull();
    expect(result.setup).toEqual([{ command: 'echo cannot-install >&2; exit 2', ms: expect.any(Number), ok: false }]);
    expect(readdirSync(lane.probes)).toEqual([]);
    expect(lane.userRepoState()).toBe(before);
  });

  it('Empty verify: full = "true" exits 0 at once with no output — failed as suspiciously empty', async () => {
    const lane = await proofLane('[verify]\nfull = "true"\n');
    const result = proven(await lane.prove());
    expect(result.passed).toBe(false);
    expect(result.verify).toMatchObject({ command: 'true', exitCode: 0, outputBytes: 0 });
    expect(result.failures).toEqual([expect.stringContaining('suspiciously empty')]);
    expect(readdirSync(lane.probes)).toEqual([]);
  });

  it('Bad reclaim: a tracked folder, a folder nothing creates and a folder git does not ignore each fail by name; an empty ignored folder is sound', async () => {
    const lane = await proofLane([
      'reclaim = ["src", "missing", "cache", "build"]',
      '[[setup]]',
      'command = "mkdir -p build cache && echo x > cache/file"',
      '[verify]',
      'full = "echo tests passed"',
      '',
    ].join('\n'));
    const result = proven(await lane.prove());
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      'reclaim "src" holds 1 tracked file: GC would delete source',
      'reclaim "missing" did not appear after setup and verify.full',
      'reclaim "cache" is not git-ignored',
    ]);
    expect(result.reclaim.find((entry) => entry.path === 'build')).toEqual({ path: 'build', appeared: true, ignored: true, trackedFiles: 0, bytes: 0 });
    expect(readdirSync(lane.probes)).toEqual([]);
  });

  it('A manifest without verify.full passes that step as "no verify command declared"', async () => {
    const lane = await proofLane('[[setup]]\ncommand = "true"\n');
    const result = proven(await lane.prove());
    expect(result).toMatchObject({ passed: true, verify: { command: null } });
  });

  it('Budget busy: the slot wait times out — deferred, and no verification.* event is recorded for the proof scope', async () => {
    const lane = await proofLane('[verify]\nfull = "echo tests passed"\n', { lockWaitTimeoutMs: 200 });
    const budget = lane.server.budget();
    const held = await budget.acquire({ jobId: 'other-job', scope: 'full', command: 'npm test', cwd: lane.repo.path });
    try {
      const outcome = await lane.prove();
      expect(outcome).toEqual({ kind: 'deferred', reason: expect.stringContaining('verification budget wait timed out') });
      // The scheduler timed the wait out, and its record callback dropped it.
      expect(verificationEvents(lane.ledger)).toEqual([]);
      expect(readdirSync(lane.probes)).toEqual([]);
    } finally {
      budget.release(held);
    }
    expect(ONBOARDING_PROOF_SCOPE).toBe('onboarding-proof');
  });

  it('A stopping service defers a proof waiting for the budget, and the slot granted late is handed back', async () => {
    const lane = await proofLane('[verify]\nfull = "echo tests passed"\n', { lockWaitTimeoutMs: 30_000 });
    const budget = lane.server.budget();
    const held = await budget.acquire({ jobId: 'other-job', scope: 'full', command: 'npm test', cwd: lane.repo.path });
    const stop = new AbortController();
    const proving = lane.prove({ signal: stop.signal });
    for (let spins = 0; spins < 400 && lane.server.view().queuedRuns === 0; spins += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lane.server.view().queuedRuns).toBe(1);
    stop.abort();
    expect(await proving).toEqual({ kind: 'deferred', reason: 'the service is stopping' });
    budget.release(held);
    for (let spins = 0; spins < 400 && lane.server.view().activeRuns > 0; spins += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lane.server.view()).toMatchObject({ activeRuns: 0, queuedRuns: 0 });
    expect(readdirSync(lane.probes)).toEqual([]);
  });
});

// ------------------------------------------------------------------
// The service: triggers, once per head, comment, directive, Gru row
// ------------------------------------------------------------------

function result(head: string, failures: readonly string[] = [], outputTail = ''): OnboardingProofResult {
  return {
    head, passed: failures.length === 0, failures, outputTail,
    setup: [{ command: 'make deps', ms: 1200, ok: failures.length === 0 || !failures[0]!.startsWith('setup') }],
    verify: failures.length > 0 && failures[0]!.startsWith('setup') ? null
      : { command: 'make test', exitCode: failures.length === 0 ? 0 : 1, signal: null, timedOut: false, ms: 4200, queuedMs: 0, workers: 2, outputBytes: 900 },
    appeared: [{ path: 'build/', bytes: 2048 }], appearedCount: 1,
    reclaim: [{ path: 'build', appeared: true, ignored: true, trackedFiles: 0, bytes: 2048 }],
    laneBytes: 4096,
  };
}

interface ServiceHarness {
  readonly ledger: LedgerApi;
  readonly notifications: NotificationCenter;
  readonly probes: string;
  readonly runs: OnboardingProofInput[];
  readonly comments: (GhIssueComment & { readonly pr: string })[];
  readonly posts: string[];
  readonly lookups: number[];
  readonly directives: OnboardingProofDirective[];
  readonly intervals: (() => void)[];
  /** What the next proof ends in (default: passed). */
  outcome: (input: OnboardingProofInput) => OnboardingProofOutcome;
  /** Throw this from the next comment post after it lands (a crash before the receipt). */
  crashAfterPost: boolean;
  /** The directive path refuses with this while set. */
  refuseDirective: string | null;
  service(opts?: { readonly mode?: 'proposed' | 'autonomous' | 'off' }): OnboardingService;
}

function serviceHarness(): ServiceHarness {
  const { ledger, bus } = bootLedger();
  const notifications = new NotificationCenter({ ledger, bus });
  const probes = join(temp('gru-onboarding-proof-svc-'), 'onboarding-probes');
  const services: OnboardingService[] = [];
  closers.push(() => { for (const service of services) service.stop(); });
  const h: ServiceHarness = {
    ledger, notifications, probes,
    runs: [], comments: [], posts: [], lookups: [], directives: [], intervals: [],
    outcome: (input) => ({ kind: 'proven', result: result(input.head) }),
    crashAfterPost: false,
    refuseDirective: null,
    service(opts = {}) {
      const service = new OnboardingService({
        onboarding: { mode: opts.mode ?? 'proposed' },
        workspaceRoot: '/fixture/workspace',
        managedRepos: ['fixture-app'],
        instanceDir: temp('gru-onboarding-proof-instance-'),
        ledger, bus, notifications,
        dispatch: async () => { throw new Error('no dispatch in the proof harness'); },
        probe: async () => ({ state: 'unverified', reason: 'not probed in the proof harness' }),
        resolveRepoPath: async () => ({ kind: 'available', path: '/fixture/workspace/fixture-app' }),
        proof: {
          probesDir: probes, setupTimeoutMs: 1_000, runTimeoutMs: 1_000,
          budget: () => { throw new Error('the stand-in proof needs no budget'); },
          run: async (input) => {
            h.runs.push(input);
            return h.outcome(input);
          },
          github: {
            commentOnPull: async (input: { readonly repo: RepoRef; readonly number: number; readonly body: string }) => {
              const comment = { id: 100 + h.comments.length, body: input.body, url: `${PR_URL}#issuecomment-${String(100 + h.comments.length)}`, pr: `${input.repo.owner}/${input.repo.repo}#${String(input.number)}` };
              h.comments.push(comment);
              h.posts.push(input.body);
              if (h.crashAfterPost) throw new Error('the service died before the receipt');
              return comment;
            },
            listIssueComments: async (input: { readonly repo: RepoRef; readonly number: number }) => {
              h.lookups.push(input.number);
              return h.comments;
            },
          },
          direct: async (input) => {
            if (h.refuseDirective !== null) throw new Error(h.refuseDirective);
            h.directives.push(input);
            ledger.beginDirectiveIntent({ jobId: input.jobId, directive: input.directive, holder: 'onboarding-proof', requestId: input.requestId });
          },
        },
        setInterval: ((run: () => void) => { h.intervals.push(run); return { unref() {} }; }) as unknown as typeof setInterval,
        log: () => {},
      });
      services.push(service);
      return service;
    },
  };
  return h;
}

async function started(service: OnboardingService): Promise<OnboardingService> {
  service.start();
  await service.idle();
  return service;
}

const proofEvents = (ledger: LedgerApi, jobId = JOB): readonly Record<string, unknown>[] =>
  ledger.listJobEventsByKinds(jobId, [ONBOARDING_EVENTS.proof], { limit: 100 }).map((event) => event.payload as Record<string, unknown>).reverse();

describe('the service: once per (job, head), after the PR, with its comment', () => {
  it('Pass: the PR link triggers one proof of the delivered head; the fence lifts and one marked comment carries the evidence', async () => {
    const h = serviceHarness();
    onboardingJob(h.ledger);
    const service = await started(h.service());
    deliver(h.ledger, H1);
    await service.idle();
    // No PR yet: nothing is proven, and review is fenced on the head.
    expect(h.runs).toEqual([]);
    expect(h.ledger.onboardingProofDebt(JOB)).toEqual({ head: H1, failed: false });
    h.ledger.setJobStatus(JOB, 'delivered');
    expect(laneIsBusy(h.ledger, h.ledger.getJob(JOB)!)).toBe(true);
    h.ledger.setJobPr(JOB, PR_URL);
    await service.idle();
    expect(h.runs.map((input) => [input.jobId, input.head, input.repoPath, input.probesDir])).toEqual([[JOB, H1, '/fixture/workspace/fixture-app', h.probes]]);
    expect(proofEvents(h.ledger)).toEqual([expect.objectContaining({ repo: 'fixture-app', job_id: JOB, head: H1, outcome: 'passed' })]);
    expect(h.ledger.onboardingProofDebt(JOB)).toBeNull();
    expect(laneIsBusy(h.ledger, h.ledger.getJob(JOB)!)).toBe(false);
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]!.pr).toBe('acme/fixture-app#7');
    expect(h.comments[0]!.body.split('\n')[0]).toBe(onboardingProofMarker(JOB, H1));
    expect(h.comments[0]!.body).toContain('GC onboarding proof: passed');
    expect(h.comments[0]!.body).toContain('`make deps`: ok in 1.2 s');
    expect(h.comments[0]!.body).toContain('`make test`: exit 0 in 4.2 s');
    expect(h.comments[0]!.body).toContain('reclaim `build`: 2.0 KiB, git-ignored');
    expect(h.comments[0]!.body).toContain('lane size without `.git`: 4.0 KiB');
    expect(h.directives).toEqual([]);
    // Every later trigger finds the head proven and posted: nothing repeats.
    h.intervals[0]!();
    deliver(h.ledger, H1);
    await service.idle();
    expect(h.runs).toHaveLength(1);
    expect(h.comments).toHaveLength(1);
  });

  it('Setup fails: a failed proof; the directive carries the failure and output tail, the comment says failed, and the fence stays', async () => {
    const h = serviceHarness();
    onboardingJob(h.ledger);
    h.ledger.setJobPr(JOB, PR_URL);
    h.outcome = (input) => ({ kind: 'proven', result: result(input.head, ['setup command 1 failed: worktree setup command exited 2: make deps'], 'npm ERR! missing token') });
    const service = await started(h.service());
    deliver(h.ledger, H1);
    await service.idle();
    expect(proofEvents(h.ledger)).toEqual([expect.objectContaining({ head: H1, outcome: 'failed', failures: ['setup command 1 failed: worktree setup command exited 2: make deps'] })]);
    expect(h.ledger.onboardingProofDebt(JOB)).toEqual({ head: H1, failed: true });
    expect(laneIsBusy(h.ledger, h.ledger.getJob(JOB)!)).toBe(true);
    expect(h.comments.map((comment) => comment.body)).toEqual([expect.stringContaining('GC onboarding proof: failed')]);
    expect(h.comments[0]!.body).toContain('npm ERR! missing token');
    expect(h.directives).toHaveLength(1);
    expect(h.directives[0]).toMatchObject({ jobId: JOB, requestId: onboardingProofDirectiveId(JOB, H1, 1) });
    expect(h.directives[0]!.directive).toContain(`onboarding proof of your manifest FAILED at ${H1}`);
    expect(h.directives[0]!.directive).toContain('setup command 1 failed');
    expect(h.directives[0]!.directive).toContain('npm ERR! missing token');
    expect(h.ledger.getDirective(onboardingProofDirectiveId(JOB, H1, 1))?.state).toBe('dispatching');
    // The failed head is never proven again, and the minion is told once.
    h.intervals[0]!();
    await service.idle();
    expect(h.runs).toHaveLength(1);
    expect(h.directives).toHaveLength(1);
  });

  it('New head: a re-delivery is proven on its own; the earlier head\'s pass no longer lifts the fence', async () => {
    const h = serviceHarness();
    onboardingJob(h.ledger);
    h.ledger.setJobPr(JOB, PR_URL);
    const service = await started(h.service());
    deliver(h.ledger, H1);
    await service.idle();
    expect(h.ledger.onboardingProofDebt(JOB)).toBeNull();
    h.outcome = (input) => ({ kind: 'proven', result: result(input.head, ['verify.full exited 1'], 'FAIL test/app.test.ts') });
    deliver(h.ledger, H2);
    expect(h.ledger.onboardingProofDebt(JOB)).toEqual({ head: H2, failed: false });
    await service.idle();
    expect(h.runs.map((input) => input.head)).toEqual([H1, H2]);
    expect(h.ledger.onboardingProofDebt(JOB)).toEqual({ head: H2, failed: true });
    expect(h.comments.map((comment) => comment.body.split('\n')[0])).toEqual([onboardingProofMarker(JOB, H1), onboardingProofMarker(JOB, H2)]);
  });

  it('Deferred: no event, no comment, no directive; the reconcile proves it later', async () => {
    const h = serviceHarness();
    onboardingJob(h.ledger);
    h.ledger.setJobPr(JOB, PR_URL);
    h.outcome = () => ({ kind: 'deferred', reason: 'the verification budget wait timed out after 900000 ms' });
    const service = await started(h.service());
    deliver(h.ledger, H1);
    await service.idle();
    expect(h.runs).toHaveLength(1);
    expect(proofEvents(h.ledger)).toEqual([]);
    expect(h.comments).toEqual([]);
    expect(h.directives).toEqual([]);
    expect(h.ledger.onboardingProofDebt(JOB)).toEqual({ head: H1, failed: false });
    h.outcome = (input) => ({ kind: 'proven', result: result(input.head) });
    h.intervals[0]!();
    await service.idle();
    expect(h.runs).toHaveLength(2);
    expect(proofEvents(h.ledger)).toEqual([expect.objectContaining({ head: H1, outcome: 'passed' })]);
    expect(h.ledger.onboardingProofDebt(JOB)).toBeNull();
  });

  it('Crash after post: the attempt stands without a receipt; the restart finds the marked comment and posts no second one', async () => {
    const h = serviceHarness();
    onboardingJob(h.ledger);
    h.ledger.setJobPr(JOB, PR_URL);
    h.crashAfterPost = true;
    const first = await started(h.service());
    deliver(h.ledger, H1);
    await first.idle();
    first.stop();
    expect(h.posts).toHaveLength(1);
    expect(h.ledger.listJobEventsByKinds(JOB, [ONBOARDING_EVENTS.proofCommentAttempt])).toHaveLength(1);
    expect(h.ledger.listJobEventsByKinds(JOB, [ONBOARDING_EVENTS.proofCommented])).toEqual([]);
    h.crashAfterPost = false;
    await started(h.service());
    expect(h.lookups).toEqual([7]);
    expect(h.posts).toHaveLength(1);
    expect(h.ledger.latestJobEvent(JOB, ONBOARDING_EVENTS.proofCommented)?.payload).toMatchObject({
      head: H1, comment_id: 100, detail: 'found by its marker after an interrupted post',
    });
  });

  it('Non-onboarding job: a normal heist with a PR and a delivery gets no proof and no fence', async () => {
    const h = serviceHarness();
    h.ledger.addJob({ id: 'heist-1', repo: 'fixture-app', title: 'Ordinary heist', briefing: 'Ship it.' });
    h.ledger.setJobStatus('heist-1', 'working');
    const service = await started(h.service());
    h.ledger.setJobPr('heist-1', PR_URL);
    deliver(h.ledger, H1, 'heist-1');
    h.ledger.setJobStatus('heist-1', 'delivered');
    await service.idle();
    expect(h.runs).toEqual([]);
    expect(h.ledger.onboardingProofDebt('heist-1')).toBeNull();
    expect(laneIsBusy(h.ledger, h.ledger.getJob('heist-1')!)).toBe(false);
  });

  it('Third failure: the third failed proof on a job also reaches Gru as one action-required row naming the job and the last failure', async () => {
    const h = serviceHarness();
    onboardingJob(h.ledger);
    h.ledger.setJobPr(JOB, PR_URL);
    let n = 0;
    h.outcome = (input) => ({ kind: 'proven', result: result(input.head, [`verify.full exited ${String(++n)}`]) });
    const service = await started(h.service());
    for (const head of [H1, H2]) {
      deliver(h.ledger, head);
      await service.idle();
      // The minion answered the directive with a new head.
      h.ledger.failDirective({ requestId: onboardingProofDirectiveId(JOB, head, 1), reason: 'answered by a new delivery in this fixture' });
    }
    expect(h.ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === ONBOARDING_PROOF_FAILING_KIND)).toEqual([]);
    deliver(h.ledger, H3);
    await service.idle();
    const rows = h.ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === ONBOARDING_PROOF_FAILING_KIND);
    expect(rows).toEqual([expect.objectContaining({ routing: 'action-required', severity: 'error', title: 'Onboarding proof failed 3 times: fixture-app' })]);
    expect(rows[0]!.detail).toContain(JOB);
    expect(rows[0]!.detail).toContain('verify.full exited 3');
    expect(h.directives.map((input) => input.requestId)).toEqual([H1, H2, H3].map((head) => onboardingProofDirectiveId(JOB, head, 1)));
  });

  it('A directive the lane cannot take now is retried by the reconcile under the same request id', async () => {
    const h = serviceHarness();
    onboardingJob(h.ledger);
    h.ledger.setJobPr(JOB, PR_URL);
    h.outcome = (input) => ({ kind: 'proven', result: result(input.head, ['verify.full exited 1']) });
    h.refuseDirective = 'a review owns this lane';
    const service = await started(h.service());
    deliver(h.ledger, H1);
    await service.idle();
    expect(h.directives).toEqual([]);
    expect(h.ledger.getDirective(onboardingProofDirectiveId(JOB, H1, 1))).toBeNull();
    h.refuseDirective = null;
    h.intervals[0]!();
    await service.idle();
    expect(h.directives.map((input) => input.requestId)).toEqual([onboardingProofDirectiveId(JOB, H1, 1)]);
    expect(h.runs).toHaveLength(1);
  });

  it('Proofs run with onboarding off: "off" stops new onboarding, never the gate on an open heist; boot removes leftover checkouts', async () => {
    const h = serviceHarness();
    onboardingJob(h.ledger);
    h.ledger.setJobPr(JOB, PR_URL);
    deliver(h.ledger, H1);
    mkdirSync(join(h.probes, `${JOB}-${H1.slice(0, 12)}`, 'node_modules'), { recursive: true });
    writeFileSync(join(h.probes, `${JOB}-${H1.slice(0, 12)}`, 'node_modules', 'left.js'), 'crash leftover');
    await started(h.service({ mode: 'off' }));
    expect(readdirSync(h.probes)).toEqual([]);
    expect(h.runs.map((input) => input.head)).toEqual([H1]);
    expect(h.ledger.onboardingProofDebt(JOB)).toBeNull();
  });
});

// ------------------------------------------------------------------
// The review fence: unforceable, queued self-review replayed, digest
// ------------------------------------------------------------------

/** A laned onboarding heist with a real wave and no spawner: the fence's
 * arm/queue paths (the review-supersession plain-lane harness). */
async function fencedLane(): Promise<{ readonly ledger: LedgerApi; readonly wave: WaveRunner }> {
  const repo = makeFixtureRepo('onboarding-proof-fence');
  repos.push(repo);
  repo.git(['checkout', '-b', 'feature/review']);
  const target = repo.commitFile('.gru-command/worktree.toml', '[verify]\nfull = "npm test"\n');
  const bus = new EventBus();
  const db = new LedgerDb(temp('gru-onboarding-proof-fence-db-'));
  closers.push(() => db.close());
  const ledger = new LedgerApi(db.handle, { bus });
  const port = new GitReviewPort(temp('gru-onboarding-proof-fence-port-'), 'feature/review', target, ledger);
  await port.createJobWorktree({ repoPath: repo.path, jobId: JOB });
  onboardingJob(ledger);
  ledger.registerWorktree(port.listWorktrees({ jobId: JOB })[0]!);
  deliver(ledger, 'fixture-settled');
  const wave = new WaveRunner({
    ledger, worktrees: port, bus,
    spawner: async (role: Role) => { throw new Error(`no ${role} spawn in the fence harness`); },
    reviewArtifactRoot: temp('gru-onboarding-proof-fence-artifacts-'),
  });
  closers.push(() => wave.shutdown());
  return { ledger, wave };
}

const proofEvent = (ledger: LedgerApi, head: string, passed: boolean): void => {
  ledger.appendCustomEvent({ kind: ONBOARDING_EVENTS.proof, jobId: JOB,
    payload: onboardingProofPayload('fixture-app', JOB, result(head, passed ? [] : ['verify.full exited 1'])) });
};

describe('the review fence', () => {
  it('Force: the owner forcing review before a pass is refused with the onboarding reason, at every entry, and audited unforced', async () => {
    const { ledger, wave } = await fencedLane();
    for (const entry of ['requestReview', 'beginRound'] as const) {
      const request = wave[entry]({ jobId: JOB, force: true });
      await expect(request).rejects.toBeInstanceOf(BranchBusyError);
      await expect(request).rejects.toThrow(/force cannot skip the proof/);
    }
    try {
      await wave.requestReview({ jobId: JOB, force: true });
      throw new Error('unreachable');
    } catch (error) {
      expect((error as BranchBusyError).refusal()).toEqual({
        error: 'branch_busy',
        blockers: [expect.objectContaining({ job_id: JOB, onboarding_proof_required_head: 'fixture-settled' })],
        hint: BRANCH_BUSY_ONBOARDING_HINT,
      });
    }
    expect(ledger.latestJobEvent(JOB, 'branch-idle.refused')?.payload).toMatchObject({
      forced: false, blockers: [{ jobId: JOB, onboardingProof: { head: 'fixture-settled', failed: false } }],
    });
    expect(ledger.latestJobEvent(JOB, 'branch-idle.forced')).toBeNull();
    // A failed proof of the head is no more forceable.
    proofEvent(ledger, 'fixture-settled', false);
    await expect(wave.requestReview({ jobId: JOB, force: true })).rejects.toThrow(/force cannot skip the proof/);
    expect(ledger.latestJobEvent(JOB, 'branch-idle.forced')).toBeNull();
    expect(ledger.listRounds(JOB)).toHaveLength(0);
  });

  it('A minion\'s self-review request is queued, not refused, and replayed on the onboarding.proof event', async () => {
    const { ledger, wave } = await fencedLane();
    const queued = await wave.requestReview({ jobId: JOB, handoff: true });
    expect(queued.route).toBe('queued');
    proofEvent(ledger, 'fixture-settled', true);
    for (let spins = 0; spins < 200 && ledger.latestJobEvent(JOB, 'job.review-handoff-claimed') === null; spins += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(ledger.latestJobEvent(JOB, 'job.review-handoff-claimed')).not.toBeNull();
  });

  it('The Silas digest withholds the review offer until the head\'s proof passes; the PR offer is never withheld', async () => {
    const { ledger } = bootLedger();
    onboardingJob(ledger);
    deliver(ledger, H1);
    ledger.setJobStatus(JOB, 'delivered');
    const digest = () => computeSilasDigest({ ledger, blockersForRound: async () => ({ blockers: [], note: null }), config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
    // The proof runs only once a PR exists, so the PR offer stands.
    expect((await digest()).deliveredWithoutPr.map((row) => row.jobId)).toEqual([JOB]);
    ledger.setJobPr(JOB, PR_URL);
    ledger.setJobStatus(JOB, 'in-review');
    expect((await digest()).prWithoutReview).toEqual([]);
    proofEvent(ledger, H1, false);
    expect((await digest()).prWithoutReview).toEqual([]);
    deliver(ledger, H2);
    proofEvent(ledger, H2, true);
    expect((await digest()).prWithoutReview.map((row) => row.jobId)).toEqual([JOB]);
  });
});

// ------------------------------------------------------------------
// The Perkins packet
// ------------------------------------------------------------------

describe('the Perkins packet', () => {
  it('a round on a proven head freezes the ONBOARDING PROOF block between the recorded verification and the CI evidence', async () => {
    const repo = makeFixtureRepo('onboarding-proof-packet');
    repos.push(repo);
    const branch = 'feature/onboard';
    repo.git(['checkout', '-b', branch]);
    const target = repo.commitFile('.gru-command/worktree.toml', '[verify]\nfull = "npm test"\n');
    const { ledger } = bootLedger();
    const port = new GitReviewPort(temp('gru-onboarding-proof-packet-port-'), branch, target, ledger);
    await port.createJobWorktree({ repoPath: repo.path, jobId: JOB });
    const origin = join(temp('gru-onboarding-proof-packet-origin-'), 'origin.git');
    repo.git(['init', '--bare', '--quiet', origin]);
    repo.git(['remote', 'add', 'origin', origin]);
    repo.git(['push', '--quiet', 'origin', `refs/heads/${branch}`]);
    onboardingJob(ledger);
    deliver(ledger, target);
    ledger.setJobPr(JOB, 'https://git.example.invalid/acme/fixture-app/pull/7');
    proofEvent(ledger, 'f'.repeat(40), true);
    proofEvent(ledger, target, true);
    const artifacts = temp('gru-onboarding-proof-packet-artifacts-');
    const wave = new WaveRunner({
      ledger, worktrees: port, reviewArtifactRoot: artifacts,
      spawner: fakeWholeSpawner(temp('gru-onboarding-proof-packet-sessions-'), { specialists: [], childAnswer: () => '[]' }).spawner,
      prHeadProbe: async () => ({ headRefName: branch, headSha: target }),
    });
    closers.push(() => wave.shutdown());
    await expect(wave.runRound({ jobId: JOB })).resolves.toBeTruthy();
    const round = ledger.listRounds(JOB)[0]!;
    expect(round.targetRef).toBe(target);
    const frozen = readFileSync(join(artifacts, round.id, 'spec-context.md'), 'utf8');
    const verification = frozen.indexOf('--- HOST-RECORDED VERIFICATION');
    const proof = frozen.indexOf('--- ONBOARDING PROOF');
    const ci = frozen.indexOf('--- HOST-RECORDED CI EVIDENCE');
    expect(verification).toBeGreaterThan(-1);
    expect(proof).toBeGreaterThan(verification);
    expect(ci).toBeGreaterThan(proof);
    expect(frozen.match(/--- ONBOARDING PROOF/gu)).toHaveLength(1);
    expect(frozen).toContain(`head: ${target} (matches the frozen review target)`);
  });

  it('renders only a proof of the exact reviewed sha, and an oversized block gives way to a notice that leaves the CI section room', () => {
    const event = { ts: '2026-10-17T12:00:00.000Z', payload: onboardingProofPayload('fixture-app', JOB, result(H1)) };
    const block = renderOnboardingProofEvidence(event, H1);
    expect(block).toContain('result: PASS');
    expect(block).toContain('setup[1]: ok 1200 ms make deps');
    expect(block).toContain('verify.full: make test: exit 0 in 4.2 s');
    expect(block).toContain('reclaim: build appeared=true ignored=true tracked_files=0 bytes=2048');
    expect(renderOnboardingProofEvidence(event, H2)).toBeNull();
    expect(renderOnboardingProofEvidence(null, H1)).toBeNull();
    expect(renderOnboardingProofEvidence({ ts: 'x', payload: { head: H1 } }, H1)).toBeNull();
    const spec = 'Acceptance: the manifest sets up the repo.';
    expect(appendOnboardingProof({ spec, block, maxBytes: FROZEN_SPEC_MAX_BYTES })).toBe(`${spec}\n\n${block!}`);
    expect(appendOnboardingProof({ spec, block: null, maxBytes: FROZEN_SPEC_MAX_BYTES })).toBe(spec);
    const crowded = 'x'.repeat(FROZEN_SPEC_MAX_BYTES - 1024 - Buffer.byteLength(block!, 'utf8'));
    const omitted = appendOnboardingProof({ spec: crowded, block, maxBytes: FROZEN_SPEC_MAX_BYTES });
    expect(omitted.startsWith(crowded)).toBe(true);
    expect(omitted).toContain('state: OMITTED (frozen spec bound)');
  });
});
