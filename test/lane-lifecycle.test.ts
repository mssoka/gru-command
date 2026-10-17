import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { routeFixDirectiveToMinion } from '../src/dispatch/fix-directive.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type EventRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { LogLevel } from '../src/logger.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { claimProviderRecoveryContinuation, type RecoveryClaimDeps } from '../src/provider-recovery/resume.js';
import { PacingGate, type PacingLease } from '../src/runtime/pacing.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { createVerificationServer, type VerificationServer } from '../src/verify/server.js';
import {
  LaneOperationInProgressError,
  LaneSparseCheckoutError,
  LaneSubmoduleWorkError,
  PRESERVED_REF_PREFIX,
  WorktreeManager,
  type TreeProcess,
} from '../src/worktrees/manager.js';
import { treeBytes, treeUsage } from '../src/worktrees/reclaim.js';
import { LANE_SLIMMER_STOP_WAIT_MS } from '../src/shutdown-budget.js';
import { laneLifecycleHooks, ReportLaneSlimmer, SLIM_MIN_IDLE_MS, SLIM_RECONCILE_INTERVAL_MS, type LaneLifecycleHooks } from '../src/worktrees/slimming.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Lane lifecycle (#427 PR 2a), over real git fixtures:
 *
 * - every release saves the lane's uncommitted tracked work (edits and
 *   deletions; untracked files go to the preserve copy) to
 *   `refs/gru/preserved/<id>/<stamp>` before `worktree remove --force`, built
 *   from a copy of the lane's index, and refuses, before anything is copied
 *   or killed, while a git operation is unfinished or a submodule holds work
 *   that survives nowhere else;
 * - a delivered, idle report job's lane is slimmed (the reclaim folders of
 *   the manifest it was built from deleted), and that manifest's `[[setup]]`
 *   runs again before the next minion turn or verification in it.
 */

const IDENTITY = ['-c', 'user.name=Lane Tests', '-c', 'user.email=lane@example.invalid'];
const MODULE = 'module.exports = 1;\n';
const SETUP = 'if [ -e slow-setup ]; then echo $$ > setup.pid; sleep 30; fi; ' +
  'if [ -e long-line.txt ]; then cat long-line.txt >&2; exit 1; fi; ' +
  "if [ -e fail-setup ]; then echo 'setup failed: token=supersecretvalue123' >&2; exit 1; fi; " +
  "mkdir -p node_modules/pkg && echo 'module.exports = 1;' > node_modules/pkg/index.js && echo ran >> setup-runs.log";
const IGNORED = 'node_modules/\nsetup-runs.log\nfail-setup\nslow-setup\nsetup.pid\nlong-line.txt\n';
/** A clock past the slimmer's minimum idle time for anything that happened now. */
const IDLE_CLOCK = (): number => Date.now() + SLIM_MIN_IDLE_MS + 60_000;
/** The slimmer's reason while the job's last activity is recent. */
const RECENT = 'the job\'s last activity (a minion turn\'s end, its delivery, a restore or a verification) was less than 30 minutes ago';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Harness {
  readonly repo: FixtureRepo;
  readonly db: LedgerDb;
  readonly ledger: LedgerApi;
  readonly bus: EventBus;
  readonly manager: WorktreeManager;
  /** The lane hooks, made as main.ts makes them. */
  readonly hooks: LaneLifecycleHooks;
  /** The service's stop the hooks were given. */
  readonly stop: AbortController;
  readonly notifications: NotificationCenter;
  readonly enumerator: ReturnType<typeof vi.fn<(treePath: string) => readonly TreeProcess[]>>;
  readonly logs: LogCall[];
  readonly dataDir: string;
  readonly preserveRoot: string;
}

function manifestWith(lines: readonly string[] = []): string {
  return ['reclaim = ["node_modules"]', ...lines, '', '[[setup]]', `command = "${SETUP}"`, '', '[verify]', 'full = "test -f node_modules/pkg/index.js && echo restored"', ''].join('\n');
}

function harness(opts: {
  readonly manifest?: string | null;
  readonly gitignore?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly repoName?: string;
} = {}): Harness {
  const repo = makeFixtureRepo(opts.repoName ?? 'lane-lifecycle');
  cleanups.push(() => repo.cleanup());
  // Files first: a file under an ignored folder can only be added before the ignore rule.
  for (const [file, content] of Object.entries(opts.files ?? {})) repo.commitFile(file, content);
  repo.commitFile('.gitignore', opts.gitignore ?? IGNORED);
  if (opts.manifest !== null) repo.commitFile('.gru-command/worktree.toml', opts.manifest ?? manifestWith());
  const dataDir = tempDir('gru-lane-lifecycle-data-');
  const db = new LedgerDb(dataDir);
  cleanups.push(() => db.close());
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const enumerator = vi.fn<(treePath: string) => readonly TreeProcess[]>(() => []);
  const preserveRoot = tempDir('gru-lane-lifecycle-preserve-');
  const logs: LogCall[] = [];
  // As main.ts makes them: one factory for every lane hook.
  const stop = new AbortController();
  const hooks = laneLifecycleHooks({ manager: () => manager, notifications, ledger, stopSignal: stop.signal });
  const manager: WorktreeManager = new WorktreeManager({
    ledger,
    root: tempDir('gru-lane-lifecycle-root-'),
    preserveRoot,
    setupTimeoutMs: 30_000,
    killGraceMs: 25,
    enumerateProcesses: (treePath) => enumerator(treePath),
    onSwept: hooks.onSwept,
    onWorkSaved: hooks.onWorkSaved,
    onSubmoduleWorkRefused: hooks.onSubmoduleWorkRefused,
    onRestoreIncomplete: hooks.onRestoreIncomplete,
    log: (level, msg, fields) => { logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); },
  });
  return { repo, db, ledger, bus, manager, hooks, stop, notifications, enumerator, logs, dataDir, preserveRoot };
}

function addJob(h: Harness, jobId: string, deliverable: 'pr' | 'review' = 'review'): void {
  h.ledger.addJob({ id: jobId, repo: 'lane-lifecycle', title: `job ${jobId}`, deliverable });
  h.ledger.setJobStatus(jobId, 'working');
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Run git expecting it to stop on a conflict (a non-zero exit). */
function gitConflict(cwd: string, args: readonly string[]): void {
  const run = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf-8' });
  expect(run.status, `git ${args.join(' ')} should stop on a conflict: ${run.stdout}${run.stderr}`).not.toBe(0);
}

function gitPath(lanePath: string, name: string): string {
  return resolve(lanePath, git(lanePath, ['rev-parse', '--git-path', name]));
}

function preservedRefs(repo: FixtureRepo): string[] {
  return repo.git(['for-each-ref', '--format=%(refname)', PRESERVED_REF_PREFIX]).split('\n').filter((ref) => ref !== '');
}

function events(h: Harness, kind: string): readonly EventRecord[] {
  return h.ledger.listEvents({ limit: 500 }).filter((event) => event.kind === kind).reverse();
}

function payloadOf(event: EventRecord | undefined): Record<string, unknown> {
  return (event?.payload ?? {}) as Record<string, unknown>;
}

function setupRuns(lanePath: string): number {
  return existsSync(join(lanePath, 'setup-runs.log')) ? readFileSync(join(lanePath, 'setup-runs.log'), 'utf-8').split('\n').filter((line) => line !== '').length : 0;
}

/** The blob of the manifest committed at the fixture's HEAD. */
function manifestBlob(h: Harness): string {
  return h.repo.git(['rev-parse', 'HEAD:.gru-command/worktree.toml']);
}

/** A source repository added at deps/lib as a submodule of the fixture;
 * returns the source's path (the submodule's origin). */
function addSubmodule(h: Harness): string {
  const sub = tempDir('gru-lane-lifecycle-sub-');
  git(sub, ['init', '-q', '-b', 'main']);
  writeFileSync(join(sub, 'lib.txt'), 'library\n');
  git(sub, ['add', '.']);
  git(sub, ['commit', '-qm', 'library']);
  git(h.repo.path, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'deps/lib']);
  git(h.repo.path, ['commit', '-qm', 'add the library']);
  return sub;
}

function initSubmodule(lanePath: string): void {
  git(lanePath, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q']);
}

/** A delivered report job with a lane whose setup made node_modules. */
async function deliveredReportLane(h: Harness, jobId: string): Promise<string> {
  addJob(h, jobId);
  const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId });
  expect(readFileSync(join(lane.path, 'node_modules', 'pkg', 'index.js'), 'utf-8')).toBe(MODULE);
  h.ledger.setJobStatus(jobId, 'delivered');
  return lane.path;
}

type LogCall = { readonly level: LogLevel; readonly msg: string; readonly fields?: Record<string, unknown> };

function slimmerFor(h: Harness, gate: PacingGate, opts: {
  readonly verificationBusy?: (jobId: string) => boolean;
  readonly timers?: { tick?: () => void };
  readonly now?: () => number;
  readonly logs?: LogCall[];
} = {}): ReportLaneSlimmer {
  const timers = opts.timers ?? {};
  const slimmer = new ReportLaneSlimmer({
    ledger: h.ledger,
    bus: h.bus,
    worktrees: h.manager,
    workerTurns: (jobId) => gate.workerTurnsFor(jobId),
    verificationBusy: opts.verificationBusy ?? (() => false),
    now: opts.now ?? IDLE_CLOCK,
    log: (level, msg, fields) => { opts.logs?.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); },
    setInterval: ((callback: () => void, ms: number) => {
      expect(ms).toBe(SLIM_RECONCILE_INTERVAL_MS);
      timers.tick = callback;
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
  });
  cleanups.push(() => slimmer.stop());
  return slimmer;
}

function restoringGate(h: Harness): PacingGate {
  return new PacingGate({
    enabled: true,
    maxConcurrentMinions: 0,
    maxConcurrentReviewTurns: 0,
    prepareWorkerTurn: h.hooks.beforeWorkerTurn,
  });
}

/** One directive to the job's live minion through the real directive route. */
async function directive(h: Harness, jobId: string, gate: PacingGate, onPrompt: () => void): Promise<unknown> {
  const handle = {
    id: `minion-${jobId}`,
    prompt: async () => { onPrompt(); },
  } as unknown as AgentHandle;
  return routeFixDirectiveToMinion({
    registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
    ledger: {
      listImplementerMinions: () => [{ id: handle.id, jobId, role: 'minion' } as unknown as ReturnType<LedgerApi['listImplementerMinions']>[number]],
      listAgents: () => [],
      registerAgent: (() => undefined) as unknown as LedgerApi['registerAgent'],
      getJob: (id: string) => h.ledger.getJob(id),
      getAgent: () => null,
    },
    worktrees: h.manager,
    jobId,
    directive: 'fix the report',
    signal: new AbortController().signal,
    workerGate: gate,
  });
}

async function verifyServer(h: Harness, ensureReady: (jobId: string, signal: AbortSignal) => Promise<void> = h.hooks.beforeVerification): Promise<{
  readonly server: VerificationServer;
  readonly verify: (jobId: string) => Promise<readonly Record<string, unknown>[]>;
}> {
  const home = tempDir('gru-lane-lifecycle-home-');
  writeFileSync(join(home, 'config.toml'), [
    '[auth]', 'token = "lane-token"',
    '[verify]', 'max_concurrent = 1', 'worker_budget = 2', 'lock_wait_timeout_ms = 60000', 'run_timeout_ms = 30000', '',
  ].join('\n'));
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const server = createVerificationServer({ config, ledger: h.ledger, worktrees: h.manager, ensureReady });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  cleanups.push(async () => {
    await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
    await server.dispose();
  });
  const port = (http.address() as AddressInfo).port;
  const verify = async (jobId: string): Promise<readonly Record<string, unknown>[]> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/verify`, {
      method: 'POST',
      headers: { authorization: 'Bearer lane-token', 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    });
    return (await res.text()).split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  return { server, verify };
}

/** Fake only `Date` (the ledger's event times and the slimmer's clock), at
 * `at`; timers stay real. Undone after the test. */
function useDateAt(at: number): void {
  vi.useFakeTimers({ toFake: ['Date'], now: at });
  cleanups.push(() => { vi.useRealTimers(); });
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The git every shim runs, found before any shim is on PATH. */
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();

/** Put a `git` first on PATH that logs each call's arguments and runs
 * `script` (shell, `$*` the arguments) before the real git, until `restore`
 * (or the test's end). `calls`: the calls logged so far. */
function gitShim(script = ''): { readonly calls: () => string[]; readonly restore: () => void } {
  const dir = tempDir('gru-lane-lifecycle-git-shim-');
  const log = join(dir, 'calls.log');
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${script}\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
  const path = process.env['PATH'] ?? '';
  process.env['PATH'] = `${dir}:${path}`;
  const restore = (): void => { process.env['PATH'] = path; };
  cleanups.push(restore);
  return { calls: () => (existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter((line) => line !== '') : []), restore };
}

describe('lossless sweep: uncommitted work is saved before removal (#427)', () => {
  it('an autopilot release of a merged job saves its edits to refs/gru/preserved, and git cherry-pick --no-commit applies them; no branch or tag is created', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-auto');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-auto' });
    writeFileSync(join(lane.path, 'README.md'), 'an edit the autopilot used to refuse over\n');
    const branchesAndTags = (): string[] => h.repo.git(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags']).split('\n').filter((ref) => ref !== '');
    expect(branchesAndTags()).toEqual(['refs/heads/gru/job-auto', 'refs/heads/main']);

    const result = await h.manager.release({ worktreeId: 'job-auto', requireReleaseProofs: true });

    expect(result.status).toBe('swept');
    expect(existsSync(lane.path)).toBe(false);
    // The merged lane's branch is gone and nothing new names the edit there.
    expect(branchesAndTags()).toEqual(['refs/heads/main']);
    expect(h.repo.git(['stash', 'list'])).toBe('');
    const [ref] = preservedRefs(h.repo);
    expect(ref).toMatch(/^refs\/gru\/preserved\/job-auto\/\d{8}T\d{6}\.\d{3}Z$/u);
    const sha = h.repo.git(['rev-parse', ref!]);
    expect(result.status === 'swept' ? result.snapshot : undefined).toEqual({ ref, sha, files: 1 });
    expect(payloadOf(events(h, 'worktree.swept')[0])['snapshot']).toEqual({ ref, sha, files: 1 });
    // One commit on the lane's HEAD, authored by GC.
    expect(h.repo.git(['log', '-1', '--format=%an <%ae> %P', ref!])).toBe(`Gru Command <gru-command@localhost> ${lane.sha}`);
    git(h.repo.path, ['cherry-pick', '--no-commit', ref!]);
    expect(readFileSync(join(h.repo.path, 'README.md'), 'utf-8')).toBe('an edit the autopilot used to refuse over\n');
  });

  it('an operator release saves staged, unstaged and newly added tracked files that remove --force used to destroy; an untracked file goes to the preserve copy only', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-oper');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-oper' });
    writeFileSync(join(lane.path, 'src', 'main.ts'), 'export const staged = true;\n');
    git(lane.path, ['add', 'src/main.ts']);
    writeFileSync(join(lane.path, 'src', 'main.ts'), 'export const staged = true;\nexport const unstaged = true;\n');
    writeFileSync(join(lane.path, 'NEW.md'), 'added to the index\n');
    git(lane.path, ['add', 'NEW.md']);
    writeFileSync(join(lane.path, 'notes.txt'), 'an untracked deliverable\n');
    mkdirSync(join(lane.path, 'node_modules'));
    writeFileSync(join(lane.path, 'node_modules', 'ignored.js'), 'never in a snapshot\n');

    const result = await h.manager.release({ worktreeId: 'job-oper' });

    expect(result.status).toBe('swept');
    const [ref] = preservedRefs(h.repo);
    expect(result.status === 'swept' ? result.snapshot?.files : null).toBe(2);
    // Untracked deliverables keep their own preserve path, and only that.
    expect(result.preserved?.count).toBe(1);
    expect(readFileSync(join(result.preserved!.destination, 'notes.txt'), 'utf-8')).toBe('an untracked deliverable\n');
    const saved = h.repo.git(['ls-tree', '-r', '--name-only', ref!]).split('\n');
    expect(saved).not.toContain('notes.txt');
    expect(saved).not.toContain('node_modules/ignored.js');
    const restore = mkdtempSync(join(tmpdir(), 'gru-lane-restore-'));
    cleanups.push(() => rmSync(restore, { recursive: true, force: true }));
    git(h.repo.path, ['worktree', 'add', '--detach', join(restore, 'tree'), 'main']);
    cleanups.push(() => { h.repo.git(['worktree', 'remove', '--force', join(restore, 'tree')]); });
    git(join(restore, 'tree'), ['cherry-pick', '--no-commit', ref!]);
    expect(readFileSync(join(restore, 'tree', 'src', 'main.ts'), 'utf-8')).toBe('export const staged = true;\nexport const unstaged = true;\n');
    expect(readFileSync(join(restore, 'tree', 'NEW.md'), 'utf-8')).toBe('added to the index\n');
    expect(existsSync(join(restore, 'tree', 'notes.txt'))).toBe(false);
  });

  it('a writer-child release and a review-lane release snapshot their edits too', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-family');
    const parent = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-family' });
    const child = await h.manager.createChildWorktree({ repoPath: h.repo.path, jobId: 'job-family', childId: 'kid-1', parentPath: parent.path, authority: 'writer' });
    const round = h.ledger.addRound({ jobId: 'job-family', targetRef: 'main' });
    const review = await h.manager.createReviewWorktree({ repoPath: h.repo.path, roundId: round.id, ref: 'main', jobId: 'job-family' });
    writeFileSync(join(child.path, 'README.md'), 'child edit\n');
    writeFileSync(join(review.path, 'README.md'), 'review edit\n');

    expect((await h.manager.release({ worktreeId: 'kid-1' })).status).toBe('swept');
    expect((await h.manager.release({ worktreeId: round.id })).status).toBe('swept');

    const refs = preservedRefs(h.repo);
    expect(refs.filter((ref) => ref.startsWith(`${PRESERVED_REF_PREFIX}/kid-1/`))).toHaveLength(1);
    expect(refs.filter((ref) => ref.startsWith(`${PRESERVED_REF_PREFIX}/${round.id}/`))).toHaveLength(1);
    const shown = (prefix: string): string => h.repo.git(['show', `${refs.find((ref) => ref.startsWith(prefix))!}:README.md`]);
    expect(shown(`${PRESERVED_REF_PREFIX}/kid-1/`)).toBe('child edit');
    expect(shown(`${PRESERVED_REF_PREFIX}/${round.id}/`)).toBe('review edit');
  });

  it('a clean sweep writes no ref and records snapshot: null', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-clean');
    await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-clean' });

    const result = await h.manager.release({ worktreeId: 'job-clean', requireReleaseProofs: true });

    expect(result.status === 'swept' ? result.snapshot : undefined).toBeNull();
    expect(preservedRefs(h.repo)).toEqual([]);
    const swept = events(h, 'worktree.swept');
    expect(swept).toHaveLength(1);
    expect(payloadOf(swept[0])).toHaveProperty('snapshot', null);
  });

  it('a lane with an intent-to-add entry snapshots it: the real index is never used', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-ita');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-ita' });
    writeFileSync(join(lane.path, 'INTENT.md'), 'added with git add -N\n');
    git(lane.path, ['add', '-N', 'INTENT.md']);

    const result = await h.manager.release({ worktreeId: 'job-ita', requireReleaseProofs: true });

    expect(result.status).toBe('swept');
    const [ref] = preservedRefs(h.repo);
    expect(h.repo.git(['show', `${ref!}:INTENT.md`])).toBe('added with git add -N');
  });

  it('a lane with a stale index.lock (a killed git commit) snapshots: the lock is never taken', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-lock');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-lock' });
    writeFileSync(join(lane.path, 'README.md'), 'edited before the commit was killed\n');
    writeFileSync(gitPath(lane.path, 'index.lock'), '');

    const result = await h.manager.release({ worktreeId: 'job-lock', requireReleaseProofs: true });

    expect(result.status).toBe('swept');
    const [ref] = preservedRefs(h.repo);
    expect(h.repo.git(['show', `${ref!}:README.md`])).toBe('edited before the commit was killed');
  });

  it('snapshots tracked work only: a deletion is in the snapshot, an untracked file is not (it is in the preserve copy), and ignored files are in neither', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-untracked');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-untracked' });
    mkdirSync(join(lane.path, 'docs'));
    writeFileSync(join(lane.path, 'docs', 'report.md'), 'a new report\n');
    rmSync(join(lane.path, 'src', 'main.ts'));
    writeFileSync(join(lane.path, 'setup-runs.log'), 'ignored\n');

    const result = await h.manager.release({ worktreeId: 'job-untracked' });

    expect(result.status === 'swept' ? result.snapshot?.files : null).toBe(1);
    const [ref] = preservedRefs(h.repo);
    const files = h.repo.git(['ls-tree', '-r', '--name-only', ref!]).split('\n');
    expect(files).not.toContain('docs/report.md');
    expect(files).not.toContain('src/main.ts');
    expect(files).not.toContain('setup-runs.log');
    expect(readFileSync(join(result.preserved!.destination, 'docs', 'report.md'), 'utf-8')).toBe('a new report\n');
    expect(existsSync(join(result.preserved!.destination, 'setup-runs.log'))).toBe(false);
  });

  it('an untracked nested git repository with no commit never blocks a release: it goes to the preserve copy, and the snapshot holds the tracked edit', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-nested');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-nested' });
    mkdirSync(join(lane.path, 'tmp'));
    git(join(lane.path, 'tmp'), ['init', '-q', 'fixture']);
    writeFileSync(join(lane.path, 'tmp', 'fixture', 'script.sh'), 'echo testing a script\n');
    writeFileSync(join(lane.path, 'README.md'), 'a tracked edit beside it\n');

    const result = await h.manager.release({ worktreeId: 'job-nested', requireReleaseProofs: true });

    expect(result.status).toBe('swept');
    const [ref] = preservedRefs(h.repo);
    expect(h.repo.git(['ls-tree', '-r', '--name-only', ref!]).split('\n')).not.toContain('tmp/fixture');
    expect(h.repo.git(['show', `${ref!}:README.md`])).toBe('a tracked edit beside it');
    expect(readFileSync(join(result.preserved!.destination, 'tmp', 'fixture', 'script.sh'), 'utf-8')).toBe('echo testing a script\n');
  });

  it('builds the snapshot from a copy of the lane\'s index, so an unchanged tracked file is not hashed again (a clean filter counts what git hashes)', async () => {
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`data/file-${String(index).padStart(2, '0')}.txt`, `content ${String(index)}\n`]));
    const h = harness({ manifest: null, files: { '.gitattributes': '*.txt filter=counted\n', ...files } });
    const hashed = join(tempDir('gru-lane-lifecycle-hashed-'), 'hashed.log');
    // The repository's own config, which GC's git reads in the lane.
    h.repo.git(['config', 'filter.counted.clean', `sh -c 'echo "$1" >> ${hashed}; cat' counted %f`]);
    addJob(h, 'job-stat');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-stat' });
    // Files older than the lane's index, and an index that knows it: none of
    // them is racily clean, so only a missing stat cache makes git hash them.
    const old = new Date('2020-01-01T00:00:00Z');
    for (const file of Object.keys(files)) utimesSync(join(lane.path, file), old, old);
    git(lane.path, ['status', '--porcelain']);
    writeFileSync(join(lane.path, 'data', 'file-07.txt'), 'edited\n');
    rmSync(hashed, { force: true });

    const result = await h.manager.release({ worktreeId: 'job-stat', requireReleaseProofs: true });

    expect(result.status === 'swept' ? result.snapshot?.files : null).toBe(1);
    const seen = new Set(readFileSync(hashed, 'utf-8').split('\n').filter((line) => line !== ''));
    expect([...seen]).toEqual(['data/file-07.txt']);
  });

  it('refuses mid-merge with the tree retained and names the merge and git merge --abort; it sweeps once the merge is aborted', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-merge');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-merge' });
    writeFileSync(join(lane.path, 'README.md'), 'lane side\n');
    git(lane.path, ['commit', '-am', 'lane side']);
    h.repo.commitFile('README.md', 'main side\n');
    gitConflict(lane.path, ['merge', 'main']);

    for (const requireReleaseProofs of [false, true]) {
      const refused = h.manager.release({ worktreeId: 'job-merge', requireReleaseProofs });
      await expect(refused).rejects.toBeInstanceOf(LaneOperationInProgressError);
      await expect(h.manager.release({ worktreeId: 'job-merge', requireReleaseProofs })).rejects.toThrow(/a merge \(MERGE_HEAD\) is in progress .* `git merge --abort`.*the tree is retained/u);
    }
    expect(existsSync(join(lane.path, 'README.md'))).toBe(true);
    expect(h.ledger.getWorktree('job-merge')?.status).toBe('active');
    expect(preservedRefs(h.repo)).toEqual([]);
    expect(events(h, 'worktree.preserved')).toHaveLength(0);

    git(lane.path, ['merge', '--abort']);
    expect((await h.manager.release({ worktreeId: 'job-merge' })).status).toBe('swept');
  });

  it('refuses mid-rebase (rebase-merge and rebase-apply), mid-cherry-pick, mid-revert, mid-bisect, with a sequence still to go, and on unmerged entries, naming the command that clears each', async () => {
    const h = harness({ manifest: null });
    const base = h.repo.head();
    h.repo.commitFile('README.md', 'main moved\n');
    const moved = h.repo.head();
    h.repo.commitFile('OTHER.md', 'another commit\n');
    const other = h.repo.head();
    const lane = async (jobId: string, edit = true): Promise<string> => {
      addJob(h, jobId);
      const row = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId });
      git(row.path, ['reset', '-q', '--hard', base]);
      if (edit) {
        writeFileSync(join(row.path, 'README.md'), `${jobId} side\n`);
        git(row.path, ['commit', '-qam', `${jobId} side`]);
      }
      return row.path;
    };
    const rebasing = await lane('job-rebase');
    gitConflict(rebasing, ['rebase', 'main']);
    const applying = await lane('job-apply');
    gitConflict(applying, ['rebase', '--apply', 'main']);
    const picking = await lane('job-pick');
    gitConflict(picking, ['cherry-pick', moved]);
    git(picking, ['add', 'README.md']); // resolved and staged, not continued
    const reverting = await lane('job-revert');
    writeFileSync(join(reverting, 'README.md'), 'a later edit the revert conflicts with\n');
    git(reverting, ['commit', '-qam', 'a later edit']);
    gitConflict(reverting, ['revert', '--no-edit', 'HEAD~1']);
    git(reverting, ['add', 'README.md']); // resolved and staged, not continued
    const bisecting = await lane('job-bisect', false);
    git(bisecting, ['bisect', 'start']);
    git(bisecting, ['bisect', 'bad', other]);
    git(bisecting, ['bisect', 'good', base]);
    const sequencing = await lane('job-sequence');
    gitConflict(sequencing, ['cherry-pick', moved, other]);
    writeFileSync(join(sequencing, 'README.md'), 'resolved\n');
    git(sequencing, ['add', 'README.md']);
    git(sequencing, ['commit', '-q', '--no-edit']); // CHERRY_PICK_HEAD gone, the sequence still pending
    const conflicted = await lane('job-conflict');
    writeFileSync(join(conflicted, 'README.md'), 'stashed edit\n');
    git(conflicted, ['stash']);
    writeFileSync(join(conflicted, 'README.md'), 'committed edit\n');
    git(conflicted, ['commit', '-qam', 'committed edit']);
    gitConflict(conflicted, ['stash', 'apply']);

    const refusals: Array<[string, RegExp]> = [
      ['job-rebase', /a rebase \(rebase-merge\) is in progress .*`git rebase --abort`/u],
      ['job-apply', /a rebase or `git am` \(rebase-apply\) is in progress .*`git rebase --abort` or `git am --abort`/u],
      ['job-pick', /a cherry-pick \(CHERRY_PICK_HEAD\) is in progress .*`git cherry-pick --abort`/u],
      ['job-revert', /a revert \(REVERT_HEAD\) is in progress .*`git revert --abort`/u],
      ['job-bisect', /a bisect \(BISECT_LOG\) is in progress .*`git bisect reset`/u],
      ['job-sequence', /a multi-commit cherry-pick or revert \(sequencer\) is in progress .*`git cherry-pick --continue`/u],
      ['job-conflict', /an unresolved conflict \(1 unmerged path\(s\) in the index: README\.md\) is in progress .*`git reset --merge`/u],
    ];
    for (const [jobId, message] of refusals) {
      await expect(h.manager.release({ worktreeId: jobId, requireReleaseProofs: true }), jobId).rejects.toThrow(message);
      expect(h.ledger.getWorktree(jobId)?.status, jobId).toBe('active');
    }
    expect(existsSync(picking) && existsSync(bisecting) && existsSync(sequencing)).toBe(true);
    expect(preservedRefs(h.repo)).toEqual([]);
  });

  it('a refusal after the untracked files were copied leaves no new folder under the preserve root, and no preserve record', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-late');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-late' });
    writeFileSync(join(lane.path, 'deliverable.txt'), 'an untracked deliverable\n');
    const before = readdirSync(h.preserveRoot);
    // A merge starts while the release enumerates the lane's processes,
    // after its deliverables were copied: the removal tail refuses.
    h.enumerator.mockImplementation((treePath) => {
      if (treePath === lane.path) writeFileSync(gitPath(lane.path, 'MERGE_HEAD'), `${lane.sha}\n`);
      return [];
    });

    await expect(h.manager.release({ worktreeId: 'job-late' })).rejects.toBeInstanceOf(LaneOperationInProgressError);

    expect(readdirSync(h.preserveRoot)).toEqual(before);
    expect(events(h, 'worktree.preserved')).toHaveLength(0);
    expect(readFileSync(join(lane.path, 'deliverable.txt'), 'utf-8')).toBe('an untracked deliverable\n');
    expect(h.ledger.getWorktree('job-late')?.status).toBe('active');
  });

  it('refuses a lane whose submodule holds an unpushed commit, by name and with its digest, recorded, with nothing removed; an operator discard carrying that digest removes it, audited, and only then is the commit gone', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    addJob(h, 'job-sub');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-sub' });
    initSubmodule(lane.path);
    const sub = join(lane.path, 'deps', 'lib');
    writeFileSync(join(sub, 'lib.txt'), 'library, improved\n');
    git(sub, ['commit', '-qam', 'improve the library']);
    const commit = git(sub, ['rev-parse', 'HEAD']);
    const subGitDir = git(sub, ['rev-parse', '--absolute-git-dir']);
    writeFileSync(join(lane.path, 'deliverable.txt'), 'an untracked deliverable\n');

    let digest = '';
    for (const requireReleaseProofs of [true, false]) {
      const refusal = await h.manager.release({ worktreeId: 'job-sub', requireReleaseProofs }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(LaneSubmoduleWorkError);
      expect(String((refusal as Error).message)).toMatch(new RegExp(`deps/lib: commit ${commit} \\(its HEAD\\) is on no remote-tracking ref or tag and not in the main checkout's copy.*push the submodule commit.*discard_submodule_work: "[0-9a-f]{16}"`, 'u'));
      digest = (refusal as LaneSubmoduleWorkError).digest;
    }
    expect(existsSync(lane.path)).toBe(true);
    expect(git(sub, ['cat-file', '-t', commit])).toBe('commit');
    expect(readdirSync(h.preserveRoot)).toEqual([]);
    expect(preservedRefs(h.repo)).toEqual([]);
    // Recorded once: the same work refused twice is one record.
    const refused = events(h, 'worktree.submodule-work-refused');
    expect(refused).toHaveLength(1);
    expect(payloadOf(refused[0])).toMatchObject({ id: 'job-sub', digest, submodules: [{ path: 'deps/lib', head: commit }] });

    const result = await h.manager.release({ worktreeId: 'job-sub', discardSubmoduleWork: digest });

    expect(result.status).toBe('swept');
    expect(existsSync(lane.path)).toBe(false);
    expect(existsSync(subGitDir)).toBe(false);
    const discarded = events(h, 'worktree.submodule-work-discarded');
    expect(discarded).toHaveLength(1);
    expect(payloadOf(discarded[0])).toMatchObject({ id: 'job-sub', digest, submodules: [{ path: 'deps/lib', head: commit }] });
    expect(discarded[0]!.seq).toBeLessThan(events(h, 'worktree.swept')[0]!.seq);
  });

  it('a discard covers only the work the operator saw: new submodule work since the refusal, or a discard with no digest, is refused again', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    addJob(h, 'job-moved-on');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-moved-on' });
    initSubmodule(lane.path);
    const sub = join(lane.path, 'deps', 'lib');
    git(sub, ['commit', '-q', '--allow-empty', '-m', 'first unpushed commit']);
    const first = await h.manager.release({ worktreeId: 'job-moved-on' }).catch((error: unknown) => error) as LaneSubmoduleWorkError;
    expect(first).toBeInstanceOf(LaneSubmoduleWorkError);
    // The minion goes on working while the operator decides.
    git(sub, ['commit', '-q', '--allow-empty', '-m', 'a second commit, never shown']);

    const stale = await h.manager.release({ worktreeId: 'job-moved-on', discardSubmoduleWork: first.digest }).catch((error: unknown) => error) as LaneSubmoduleWorkError;
    expect(stale).toBeInstanceOf(LaneSubmoduleWorkError);
    expect(stale.digest).not.toBe(first.digest);
    expect(stale.message).toContain(`the discard named ${first.digest}, which is not the work the lane holds now`);
    await expect(h.manager.release({ worktreeId: 'job-moved-on', discardSubmoduleWork: '' })).rejects.toBeInstanceOf(LaneSubmoduleWorkError);
    expect(existsSync(lane.path)).toBe(true);
    expect(events(h, 'worktree.submodule-work-discarded')).toHaveLength(0);
    expect(events(h, 'worktree.submodule-work-refused').map((event) => payloadOf(event)['digest'])).toEqual([first.digest, stale.digest]);
  });

  it('refuses each submodule state on its own, by name: modified tracked content and a staged gitlink to an unpushed commit', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    const cases: Array<[string, (lanePath: string, sub: string) => void, RegExp]> = [
      ['job-sub-modified', (_lane, sub) => { writeFileSync(join(sub, 'lib.txt'), 'an uncommitted edit\n'); }, /deps\/lib: modified tracked content/u],
      ['job-sub-staged', (lanePath, sub) => {
        git(sub, ['commit', '-q', '--allow-empty', '-m', 'unpushed']);
        git(lanePath, ['add', 'deps/lib']);
      }, /deps\/lib: commit [0-9a-f]{40} \(its HEAD\) is on no remote-tracking ref/u],
    ];
    for (const [jobId, make, refusal] of cases) {
      addJob(h, jobId);
      const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId });
      initSubmodule(lane.path);
      make(lane.path, join(lane.path, 'deps', 'lib'));
      await expect(h.manager.release({ worktreeId: jobId, requireReleaseProofs: true }), jobId).rejects.toThrow(refusal);
      expect(h.ledger.getWorktree(jobId)?.status, jobId).toBe('active');
    }
  });

  it('refuses a committed gitlink bump to an unpushed submodule commit with a clean status; the same commit pushed is released, and so is git submodule update --remote', async () => {
    const h = harness({ manifest: null });
    const source = addSubmodule(h);
    const bump = async (jobId: string): Promise<{ readonly lanePath: string; readonly sub: string; readonly commit: string }> => {
      addJob(h, jobId);
      const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId });
      initSubmodule(lane.path);
      const sub = join(lane.path, 'deps', 'lib');
      writeFileSync(join(sub, 'lib.txt'), `${jobId}\n`);
      git(sub, ['commit', '-qam', `${jobId} improves the library`]);
      git(lane.path, ['commit', '-qam', 'record the new library commit']);
      expect(git(lane.path, ['status', '--porcelain'])).toBe('');
      return { lanePath: lane.path, sub, commit: git(sub, ['rev-parse', 'HEAD']) };
    };

    const unpushed = await bump('job-bump');
    await expect(h.manager.release({ worktreeId: 'job-bump', requireReleaseProofs: true }))
      .rejects.toThrow(new RegExp(`deps/lib: commit ${unpushed.commit} \\(its HEAD\\) is on no remote-tracking ref or tag`, 'u'));
    expect(existsSync(unpushed.lanePath)).toBe(true);

    const pushed = await bump('job-pushed');
    git(pushed.sub, ['push', '-q', 'origin', 'HEAD:refs/heads/job-pushed']);
    expect((await h.manager.release({ worktreeId: 'job-pushed', requireReleaseProofs: true })).status).toBe('swept');
    expect(git(source, ['cat-file', '-t', pushed.commit])).toBe('commit');

    addJob(h, 'job-remote');
    const remote = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-remote' });
    initSubmodule(remote.path);
    writeFileSync(join(source, 'upstream.txt'), 'an upstream change\n');
    git(source, ['add', 'upstream.txt']);
    git(source, ['commit', '-qm', 'upstream moves on']);
    git(remote.path, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--remote', 'deps/lib']);
    const result = await h.manager.release({ worktreeId: 'job-remote', requireReleaseProofs: true });
    expect(result.status).toBe('swept');
    // The moved gitlink is the lane's tracked work: the snapshot holds it.
    expect(result.status === 'swept' ? result.snapshot?.files : null).toBe(1);
  });

  it('a staged git rm of a submodule is released (no commit is at risk), and a submodule whose .gitmodules says ignore = untracked keeps no build leftover from a release', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    git(h.repo.path, ['config', '-f', '.gitmodules', 'submodule.deps/lib.ignore', 'untracked']);
    git(h.repo.path, ['commit', '-qam', 'the library leaves build output behind']);
    addJob(h, 'job-rm');
    const removing = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-rm' });
    initSubmodule(removing.path);
    git(removing.path, ['rm', '-q', 'deps/lib']);
    expect(git(removing.path, ['status', '--porcelain=v2'])).toMatch(/^1 D\. /mu);
    addJob(h, 'job-leftover');
    const building = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-leftover' });
    initSubmodule(building.path);
    writeFileSync(join(building.path, 'deps', 'lib', 'lib.o'), 'a build leftover\n');

    const removed = await h.manager.release({ worktreeId: 'job-rm', requireReleaseProofs: true });
    const built = await h.manager.release({ worktreeId: 'job-leftover', requireReleaseProofs: true });

    expect(removed.status).toBe('swept');
    // The staged removal is the lane's tracked work: the snapshot holds it.
    const [ref] = preservedRefs(h.repo);
    expect(h.repo.git(['ls-tree', '-r', '--name-only', ref!]).split('\n')).not.toContain('deps/lib');
    expect(built.status).toBe('swept');
    // Declared disposable: not copied either.
    expect(built.preserved).toBeNull();
  });

  it('refuses submodule work before any process is reaped, paused on or asked about', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    addJob(h, 'job-sub-live');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-sub-live' });
    initSubmodule(lane.path);
    git(join(lane.path, 'deps', 'lib'), ['commit', '-q', '--allow-empty', '-m', 'unpushed']);
    h.enumerator.mockReturnValue([{ pid: 4242, command: 'node watcher.js', evidence: 'cwd' }]);

    await expect(h.manager.release({ worktreeId: 'job-sub-live' })).rejects.toBeInstanceOf(LaneSubmoduleWorkError);

    expect(h.enumerator).not.toHaveBeenCalled();
    expect(events(h, 'worktree.paused')).toHaveLength(0);
    expect(h.ledger.listWorktreeProcesses('job-sub-live')).toEqual([]);
    expect(h.ledger.getWorktree('job-sub-live')?.status).toBe('active');
  });

  it('a live process writing a tracked file pauses the release, named, instead of refusing it; confirm_kill reaches the kill, and the release completes with a proven snapshot', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-writer');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-writer' });
    const writer = spawn('sh', ['-c', 'while :; do echo appended >> README.md; done'], { cwd: lane.path, stdio: 'ignore' });
    cleanups.push(() => { writer.kill('SIGKILL'); });
    const pid = writer.pid!;
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    h.enumerator.mockImplementation((treePath) => (treePath === lane.path && alive() ? [{ pid, command: 'sh -c while :; do echo appended >> README.md; done', evidence: 'cwd' }] : []));
    await vi.waitFor(() => expect(readFileSync(join(lane.path, 'README.md'), 'utf-8')).toContain('appended'));

    const paused = await h.manager.release({ worktreeId: 'job-writer' });

    expect(paused).toMatchObject({ status: 'paused', processes: [{ pid }] });
    expect(payloadOf(events(h, 'worktree.paused')[0])).toMatchObject({ id: 'job-writer', processes: [{ pid }] });

    const swept = await h.manager.release({ worktreeId: 'job-writer', confirmKill: true });

    expect(swept.status).toBe('swept');
    expect(alive()).toBe(false);
    const snapshot = swept.status === 'swept' ? swept.snapshot! : null;
    expect(snapshot?.files).toBe(1);
    expect(h.repo.git(['show', `${snapshot!.ref}:README.md`])).toContain('appended');
  });

  it('writes the snapshot ref last: a ledger write the removal depends on that throws leaves no ref behind', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-unrecorded-sweep');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-unrecorded-sweep' });
    writeFileSync(join(lane.path, 'README.md'), 'a tracked edit\n');
    writeFileSync(join(lane.path, 'deliverable.txt'), 'an untracked deliverable\n');
    const append = h.ledger.appendCustomEvent.bind(h.ledger);
    const spy = vi.spyOn(h.ledger, 'appendCustomEvent').mockImplementation((input) => {
      if (input.kind === 'worktree.preserved') throw new Error('SQLITE_BUSY: database is locked');
      return append(input);
    });

    await expect(h.manager.release({ worktreeId: 'job-unrecorded-sweep' })).rejects.toThrow(/SQLITE_BUSY/u);

    expect(preservedRefs(h.repo)).toEqual([]);
    // The copy no record names is withdrawn.
    expect(readdirSync(h.preserveRoot)).toEqual([]);
    expect(existsSync(join(lane.path, 'README.md'))).toBe(true);
    expect(h.ledger.getWorktree('job-unrecorded-sweep')?.status).toBe('active');
    spy.mockRestore();
    expect((await h.manager.release({ worktreeId: 'job-unrecorded-sweep' })).status).toBe('swept');
    expect(preservedRefs(h.repo)).toHaveLength(1);
  });

  it('tells the owner once per release with an FYI row naming the lane, job, ref, count of tracked files, a restore command that works and the preserve copy', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-told');
    addJob(h, 'job-quiet');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-told' });
    await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-quiet' });
    writeFileSync(join(lane.path, 'README.md'), 'half of a fix\n');
    rmSync(join(lane.path, 'src', 'main.ts'));
    writeFileSync(join(lane.path, 'FIX.md'), 'the other half\n');
    git(lane.path, ['add', 'FIX.md']);
    writeFileSync(join(lane.path, 'scratch.txt'), 'an untracked note, not counted\n');

    const swept = await h.manager.release({ worktreeId: 'job-told', requireReleaseProofs: true });
    await h.manager.release({ worktreeId: 'job-told' });
    await h.manager.release({ worktreeId: 'job-quiet' });

    const rows = h.ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === 'worktree-work-saved');
    expect(rows).toHaveLength(1);
    const [row] = rows;
    const snapshot = swept.status === 'swept' ? swept.snapshot! : null;
    const preserved = swept.status === 'swept' ? swept.preserved! : null;
    expect(row).toMatchObject({ routing: 'fyi', severity: 'info' });
    expect(row!.title).toContain('job-told');
    for (const fact of ['Lane job-told (job job-told)', snapshot!.ref, '3 tracked file(s) changed and not committed', `Its 1 untracked file(s) were copied to ${preserved!.destination}.`]) expect(row!.detail).toContain(fact);
    const command = /To apply the tracked changes to a checkout: (git -C .*)$/u.exec(row!.detail ?? '')?.[1];
    expect(command).toBe(`git -C ${h.ledger.getWorktree('job-told')!.repoPath} cherry-pick --no-commit ${snapshot!.ref}`);
    execFileSync('sh', ['-c', command!], { cwd: tmpdir(), env: { ...process.env, GIT_AUTHOR_NAME: 'Lane Tests', GIT_AUTHOR_EMAIL: 'lane@example.invalid', GIT_COMMITTER_NAME: 'Lane Tests', GIT_COMMITTER_EMAIL: 'lane@example.invalid' } });
    expect(readFileSync(join(h.repo.path, 'README.md'), 'utf-8')).toBe('half of a fix\n');
    expect(readFileSync(join(h.repo.path, 'FIX.md'), 'utf-8')).toBe('the other half\n');
    expect(existsSync(join(h.repo.path, 'src', 'main.ts'))).toBe(false);
    expect(existsSync(join(h.repo.path, 'scratch.txt'))).toBe(false);
  });

  it('shell-quotes the restore command, so it works for a repository whose path holds a space and a quote', async () => {
    const h = harness({ manifest: null, repoName: "lane lifecycle's app" });
    addJob(h, 'job-spaced');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-spaced' });
    writeFileSync(join(lane.path, 'README.md'), 'saved from a spaced path\n');

    await h.manager.release({ worktreeId: 'job-spaced' });

    const [row] = h.ledger.listNotifications({ limit: 50 }).filter((notice) => notice.kind === 'worktree-work-saved');
    const command = /To apply the tracked changes to a checkout: (git -C .*)$/u.exec(row!.detail ?? '')?.[1];
    const repoPath = h.ledger.getWorktree('job-spaced')!.repoPath;
    expect(repoPath).toContain("lane lifecycle's app");
    expect(command).toContain(`'${repoPath.replace(/'/gu, `'\\''`)}'`);
    execFileSync('sh', ['-c', command!], { cwd: tmpdir() });
    expect(readFileSync(join(h.repo.path, 'README.md'), 'utf-8')).toBe('saved from a spaced path\n');
  });

  it('keeps git\'s racy-clean check: a file staged and then rewritten at the same size within the index\'s own second is saved as rewritten, never as staged', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-racy');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-racy' });
    // Only whole-second mtimes and sizes tell this rewrite apart (ctime is not trusted here).
    h.repo.git(['config', 'core.trustctime', 'false']);
    const second = new Date('2020-01-01T00:00:00Z');
    const readme = join(lane.path, 'README.md');
    writeFileSync(readme, 'version 1.2.4\n');
    utimesSync(readme, second, second);
    git(lane.path, ['add', 'README.md']);
    writeFileSync(readme, 'version 1.2.5\n');
    utimesSync(readme, second, second);
    // The index was written in that same second; a stale lock keeps any git from rewriting it.
    utimesSync(gitPath(lane.path, 'index'), second, second);
    writeFileSync(gitPath(lane.path, 'index.lock'), '');

    const result = await h.manager.release({ worktreeId: 'job-racy' });

    expect(result.status).toBe('swept');
    const [ref] = preservedRefs(h.repo);
    expect(h.repo.git(['show', `${ref!}:README.md`])).toBe('version 1.2.5');
  });

  it('saves an edit behind an assume-unchanged bit and one behind a skip-worktree bit', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-hidden');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-hidden' });
    git(lane.path, ['update-index', '--assume-unchanged', 'README.md']);
    git(lane.path, ['update-index', '--skip-worktree', 'src/main.ts']);
    writeFileSync(join(lane.path, 'README.md'), 'edited behind assume-unchanged\n');
    writeFileSync(join(lane.path, 'src', 'main.ts'), 'edited behind skip-worktree\n');
    expect(git(lane.path, ['status', '--porcelain'])).toBe('');

    const result = await h.manager.release({ worktreeId: 'job-hidden', requireReleaseProofs: true });

    expect(result.status === 'swept' ? result.snapshot?.files : null).toBe(2);
    const [ref] = preservedRefs(h.repo);
    expect(h.repo.git(['show', `${ref!}:README.md`])).toBe('edited behind assume-unchanged');
    expect(h.repo.git(['show', `${ref!}:src/main.ts`])).toBe('edited behind skip-worktree');
  });

  it('refuses a sparse checkout by name before anything is copied or killed, with the tree retained', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-sparse');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-sparse' });
    git(lane.path, ['sparse-checkout', 'set', 'src']);
    writeFileSync(join(lane.path, 'src', 'main.ts'), 'an edit inside the cone\n');
    writeFileSync(join(lane.path, 'notes.txt'), 'an untracked deliverable\n');
    h.enumerator.mockReturnValue([{ pid: 4242, command: 'node watcher.js', evidence: 'cwd' }]);

    await expect(h.manager.release({ worktreeId: 'job-sparse' })).rejects.toThrow(LaneSparseCheckoutError);
    await expect(h.manager.release({ worktreeId: 'job-sparse' })).rejects.toThrow(/is a sparse checkout \(core\.sparseCheckout is on\).*git sparse-checkout disable.*the tree is retained/u);

    expect(h.enumerator).not.toHaveBeenCalled();
    expect(readdirSync(h.preserveRoot)).toEqual([]);
    expect(preservedRefs(h.repo)).toEqual([]);
    expect(readFileSync(join(lane.path, 'src', 'main.ts'), 'utf-8')).toBe('an edit inside the cone\n');
    expect(h.ledger.getWorktree('job-sparse')?.status).toBe('active');
  });

  it('builds the snapshot from HEAD only when the lane\'s index cannot be copied (it is gone), with one warn, and saves the tracked edit', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-no-index');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-no-index' });
    writeFileSync(join(lane.path, 'README.md'), 'edited, and the index is gone\n');
    rmSync(gitPath(lane.path, 'index'));

    const result = await h.manager.release({ worktreeId: 'job-no-index', requireReleaseProofs: true });

    expect(result.status).toBe('swept');
    const [ref] = preservedRefs(h.repo);
    expect(h.repo.git(['show', `${ref!}:README.md`])).toBe('edited, and the index is gone');
    expect(h.logs.filter((line) => line.msg.startsWith('the snapshot could not be built from a copy of the lane\'s index'))).toHaveLength(1);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('a tracked file git cannot read never refuses before the pause; once the processes are handled the tail refuses by name, never building from HEAD instead, with the tree retained and no ref; once it can be read the release completes', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-unreadable');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-unreadable' });
    const readme = join(lane.path, 'README.md');
    writeFileSync(readme, 'an edit git cannot read\n');
    chmodSync(readme, 0o000);
    cleanups.push(() => { if (existsSync(readme)) chmodSync(readme, 0o644); });
    const sleeper = spawn('sleep', ['30'], { cwd: lane.path, stdio: 'ignore' });
    cleanups.push(() => { sleeper.kill('SIGKILL'); });
    const pid = sleeper.pid!;
    const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    h.enumerator.mockImplementation((treePath) => (treePath === lane.path && alive() ? [{ pid, command: 'sleep 30', evidence: 'cwd' }] : []));

    // What the snapshot would meet is a race until the processes are handled: the release pauses.
    expect(await h.manager.release({ worktreeId: 'job-unreadable' })).toMatchObject({ status: 'paused', processes: [{ pid }] });
    await expect(h.manager.release({ worktreeId: 'job-unreadable', confirmKill: true }))
      .rejects.toThrow(/the snapshot of the uncommitted work in .* could not be built: git could not read README\.md .*the tree is retained/u);

    expect(alive()).toBe(false);
    expect(existsSync(readme)).toBe(true);
    expect(preservedRefs(h.repo)).toEqual([]);
    expect(h.logs.filter((line) => line.msg.startsWith('the snapshot could not be built from a copy'))).toEqual([]);
    chmodSync(readme, 0o644);
    const result = await h.manager.release({ worktreeId: 'job-unreadable' });
    expect(result.status).toBe('swept');
    expect(h.repo.git(['show', `${result.status === 'swept' ? result.snapshot!.ref : ''}:README.md`])).toBe('an edit git cannot read');
  }, 30_000);

  it('refuses a snapshot its proof finds different from the working tree (a clean filter whose output changes on every run): the tree is retained, with no ref and no preserve folder', async () => {
    const h = harness({ manifest: null, files: { '.gitattributes': 'README.md filter=restless\n' } });
    h.repo.git(['config', 'filter.restless.clean', 'sh -c \'cat; echo $$\'']);
    addJob(h, 'job-restless');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-restless' });
    writeFileSync(join(lane.path, 'README.md'), 'an edit\n');
    writeFileSync(join(lane.path, 'deliverable.txt'), 'an untracked deliverable\n');
    // A modification time ahead of every index write: git reads the file again at every check.
    const ahead = new Date(Date.now() + 3_600_000);
    utimesSync(join(lane.path, 'README.md'), ahead, ahead);

    await expect(h.manager.release({ worktreeId: 'job-restless' })).rejects.toThrow(/the snapshot of the uncommitted work in .* does not match the working tree/u);

    expect(readFileSync(join(lane.path, 'README.md'), 'utf-8')).toBe('an edit\n');
    expect(preservedRefs(h.repo)).toEqual([]);
    expect(readdirSync(h.preserveRoot)).toEqual([]);
    expect(h.ledger.getWorktree('job-restless')?.status).toBe('active');
  });

  it('copies every untracked file however the repository sets status.showUntrackedFiles', async () => {
    const h = harness({ manifest: null });
    h.repo.git(['config', 'status.showUntrackedFiles', 'no']);
    addJob(h, 'job-hidden-untracked');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-hidden-untracked' });
    mkdirSync(join(lane.path, 'docs'));
    writeFileSync(join(lane.path, 'docs', 'report.md'), 'a report git status does not show\n');
    expect(git(lane.path, ['status', '--porcelain'])).toBe('');

    const result = await h.manager.release({ worktreeId: 'job-hidden-untracked' });

    expect(result.status).toBe('swept');
    expect(readFileSync(join(result.preserved!.destination, 'docs', 'report.md'), 'utf-8')).toBe('a report git status does not show\n');
  });

  it('never refuses the base\'s own pin: a submodule pinned at a commit only a tag reaches, the main checkout\'s submodule never initialized, is released', async () => {
    const h = harness({ manifest: null });
    const source = addSubmodule(h);
    // A release commit only tag v1 reaches (its branch is gone upstream).
    git(source, ['checkout', '-q', '--detach']);
    git(source, ['commit', '-q', '--allow-empty', '-m', 'release 1']);
    git(source, ['tag', 'v1']);
    const pin = git(source, ['rev-parse', 'HEAD']);
    git(source, ['checkout', '-q', 'main']);
    const mainSub = join(h.repo.path, 'deps', 'lib');
    git(mainSub, ['fetch', '-q', '--tags', 'origin']);
    git(mainSub, ['checkout', '-q', 'v1']);
    git(h.repo.path, ['commit', '-qam', 'pin the library at v1']);
    git(h.repo.path, ['submodule', 'deinit', '-f', 'deps/lib']);
    rmSync(join(h.repo.path, '.git', 'modules', 'deps', 'lib'), { recursive: true, force: true });
    addJob(h, 'job-tag-pin');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-tag-pin' });
    initSubmodule(lane.path);
    const sub = join(lane.path, 'deps', 'lib');
    expect(git(sub, ['rev-parse', 'HEAD'])).toBe(pin);
    expect(git(sub, ['for-each-ref', `--contains=${pin}`, 'refs/remotes'])).toBe('');

    expect((await h.manager.release({ worktreeId: 'job-tag-pin', requireReleaseProofs: true })).status).toBe('swept');
  });

  it('releases a lane whose submodule moved to a commit only a tag of its remote reaches: the tag outlives the lane', async () => {
    const h = harness({ manifest: null });
    const source = addSubmodule(h);
    addJob(h, 'job-tagged');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-tagged' });
    git(source, ['checkout', '-q', '--detach']);
    git(source, ['commit', '-q', '--allow-empty', '-m', 'release 2']);
    git(source, ['tag', 'v2']);
    const tagged = git(source, ['rev-parse', 'HEAD']);
    git(source, ['checkout', '-q', 'main']);
    initSubmodule(lane.path);
    const sub = join(lane.path, 'deps', 'lib');
    git(sub, ['fetch', '-q', '--tags', 'origin']);
    git(sub, ['checkout', '-q', 'v2']);
    expect(git(sub, ['for-each-ref', '--format=%(refname)', `--contains=${tagged}`])).toBe('refs/tags/v2');

    expect((await h.manager.release({ worktreeId: 'job-tagged', requireReleaseProofs: true })).status).toBe('swept');
  });

  it('never refuses the base\'s own pin: a shallow submodule whose pinned commit was fetched by its sha (on no ref) is released', async () => {
    const h = harness({ manifest: null });
    const source = tempDir('gru-lane-lifecycle-shallow-');
    git(source, ['init', '-q', '-b', 'main']);
    writeFileSync(join(source, 'lib.txt'), 'first\n');
    git(source, ['add', '.']);
    git(source, ['commit', '-qm', 'first']);
    const pin = git(source, ['rev-parse', 'HEAD']);
    writeFileSync(join(source, 'lib.txt'), 'second\n');
    git(source, ['commit', '-qam', 'second']);
    git(h.repo.path, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', `file://${source}`, 'deps/lib']);
    git(join(h.repo.path, 'deps', 'lib'), ['checkout', '-q', pin]);
    git(h.repo.path, ['config', '-f', '.gitmodules', 'submodule.deps/lib.shallow', 'true']);
    git(h.repo.path, ['add', '.gitmodules', 'deps/lib']);
    git(h.repo.path, ['commit', '-qm', 'a shallow library at its first commit']);
    git(h.repo.path, ['submodule', 'deinit', '-f', 'deps/lib']);
    rmSync(join(h.repo.path, '.git', 'modules', 'deps', 'lib'), { recursive: true, force: true });
    addJob(h, 'job-shallow');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-shallow' });
    initSubmodule(lane.path);
    const sub = join(lane.path, 'deps', 'lib');
    expect(git(sub, ['rev-parse', 'HEAD'])).toBe(pin);
    expect(existsSync(join(git(sub, ['rev-parse', '--absolute-git-dir']), 'shallow'))).toBe(true);
    expect(git(sub, ['for-each-ref', `--contains=${pin}`])).toBe('');

    expect((await h.manager.release({ worktreeId: 'job-shallow', requireReleaseProofs: true })).status).toBe('swept');
  });

  it('releases a lane whose submodule commit is on no remote-tracking ref or tag but is in the main checkout\'s own copy', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    const mainSub = join(h.repo.path, 'deps', 'lib');
    git(mainSub, ['commit', '-q', '--allow-empty', '-m', 'a commit only the main checkout has']);
    const commit = git(mainSub, ['rev-parse', 'HEAD']);
    addJob(h, 'job-main-copy');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-main-copy' });
    initSubmodule(lane.path);
    const sub = join(lane.path, 'deps', 'lib');
    git(sub, ['fetch', '-q', join(h.repo.path, '.git', 'modules', 'deps', 'lib'), 'main']);
    git(sub, ['checkout', '-q', commit]);
    expect(git(sub, ['for-each-ref', `--contains=${commit}`])).toBe('');

    const result = await h.manager.release({ worktreeId: 'job-main-copy', requireReleaseProofs: true });

    expect(result.status).toBe('swept');
  });

  it('refuses a commit on a submodule\'s side branch with its HEAD back at the pin, and a stash in a submodule', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    addJob(h, 'job-side');
    const side = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-side' });
    initSubmodule(side.path);
    const sideSub = join(side.path, 'deps', 'lib');
    const pin = git(sideSub, ['rev-parse', 'HEAD']);
    git(sideSub, ['switch', '-q', '-c', 'fix']);
    writeFileSync(join(sideSub, 'lib.txt'), 'a fix on a side branch\n');
    git(sideSub, ['commit', '-qam', 'fix the library']);
    const fix = git(sideSub, ['rev-parse', 'HEAD']);
    git(sideSub, ['checkout', '-q', pin]);
    addJob(h, 'job-stashed');
    const stashed = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-stashed' });
    initSubmodule(stashed.path);
    const stashedSub = join(stashed.path, 'deps', 'lib');
    writeFileSync(join(stashedSub, 'lib.txt'), 'work put aside\n');
    git(stashedSub, ['stash', '-q']);
    for (const lane of [side, stashed]) expect(git(lane.path, ['status', '--porcelain'])).toBe('');

    await expect(h.manager.release({ worktreeId: 'job-side', requireReleaseProofs: true }))
      .rejects.toThrow(new RegExp(`deps/lib: commit ${fix} \\(branch fix\\) is on no remote-tracking ref or tag`, 'u'));
    await expect(h.manager.release({ worktreeId: 'job-stashed', requireReleaseProofs: true }))
      .rejects.toThrow(/deps\/lib: commit [0-9a-f]{40} \(stash@\{0\}\) is on no remote-tracking ref or tag/u);
    expect(existsSync(side.path) && existsSync(stashed.path)).toBe(true);
  });

  it('decides on submodule content by GC\'s policy, whatever the config shows: modified content under ignore = dirty or a global diff.ignoreSubmodules = all is refused, and untracked content is copied, never refused', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    git(h.repo.path, ['config', '-f', '.gitmodules', 'submodule.deps/lib.ignore', 'dirty']);
    git(h.repo.path, ['commit', '-qam', 'quiet the vendored library']);
    addJob(h, 'job-dirty');
    const dirty = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-dirty' });
    initSubmodule(dirty.path);
    writeFileSync(join(dirty.path, 'deps', 'lib', 'lib.txt'), 'a fix git status does not show\n');
    expect(git(dirty.path, ['status', '--porcelain'])).toBe('');
    await expect(h.manager.release({ worktreeId: 'job-dirty' })).rejects.toThrow(/deps\/lib: modified tracked content/u);

    const globalConfig = join(tempDir('gru-lane-lifecycle-global-'), 'gitconfig');
    writeFileSync(globalConfig, '[diff]\n\tignoreSubmodules = all\n');
    const saved = process.env['GIT_CONFIG_GLOBAL'];
    process.env['GIT_CONFIG_GLOBAL'] = globalConfig;
    cleanups.push(() => { if (saved === undefined) delete process.env['GIT_CONFIG_GLOBAL']; else process.env['GIT_CONFIG_GLOBAL'] = saved; });
    await expect(h.manager.release({ worktreeId: 'job-dirty' })).rejects.toThrow(/deps\/lib: modified tracked content/u);
    expect(existsSync(join(dirty.path, 'deps', 'lib', 'lib.txt'))).toBe(true);

    addJob(h, 'job-sub-untracked');
    const untracked = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-sub-untracked' });
    initSubmodule(untracked.path);
    writeFileSync(join(untracked.path, 'deps', 'lib', 'new.c'), 'a new source file\n');
    const result = await h.manager.release({ worktreeId: 'job-sub-untracked' });
    expect(result.status).toBe('swept');
    expect(readFileSync(join(result.preserved!.destination, 'deps', 'lib', 'new.c'), 'utf-8')).toBe('a new source file\n');
  });

  it('a digest covers the submodule\'s content: more edits after a refusal change it, and a discard naming the old one is refused', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    addJob(h, 'job-more-edits');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-more-edits' });
    initSubmodule(lane.path);
    const sub = join(lane.path, 'deps', 'lib');
    writeFileSync(join(sub, 'lib.txt'), 'the edit the operator saw\n');
    const first = await h.manager.release({ worktreeId: 'job-more-edits' }).catch((error: unknown) => error) as LaneSubmoduleWorkError;
    expect(first).toBeInstanceOf(LaneSubmoduleWorkError);
    writeFileSync(join(sub, 'lib.txt'), 'the edit the operator saw, and ten more lines\n');

    const stale = await h.manager.release({ worktreeId: 'job-more-edits', discardSubmoduleWork: first.digest }).catch((error: unknown) => error) as LaneSubmoduleWorkError;

    expect(stale).toBeInstanceOf(LaneSubmoduleWorkError);
    expect(stale.submodules).toEqual(first.submodules);
    expect(stale.digest).not.toBe(first.digest);
    expect(readFileSync(join(sub, 'lib.txt'), 'utf-8')).toBe('the edit the operator saw, and ten more lines\n');
    expect(events(h, 'worktree.submodule-work-discarded')).toHaveLength(0);
  });

  it('records a submodule refusal once per lane and digest for a lane with no job', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    addJob(h, 'job-reviewed');
    const round = h.ledger.addRound({ jobId: 'job-reviewed', targetRef: 'main' });
    // A review lane created with no job of its own.
    const review = await h.manager.createReviewWorktree({ repoPath: h.repo.path, roundId: round.id, ref: 'main' });
    expect(review.jobId).toBeNull();
    initSubmodule(review.path);
    git(join(review.path, 'deps', 'lib'), ['commit', '-q', '--allow-empty', '-m', 'unpushed']);

    for (let attempt = 0; attempt < 3; attempt += 1) await expect(h.manager.release({ worktreeId: round.id })).rejects.toBeInstanceOf(LaneSubmoduleWorkError);

    expect(events(h, 'worktree.submodule-work-refused')).toHaveLength(1);
  });

  it('tells Gru once per lane and digest with an action-required row naming the submodule, its commit, what to do and the digest; a newer digest replaces the row, and the lane\'s release closes it', async () => {
    const h = harness({ manifest: null });
    addSubmodule(h);
    addJob(h, 'job-told-gru');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-told-gru' });
    initSubmodule(lane.path);
    const sub = join(lane.path, 'deps', 'lib');
    git(sub, ['commit', '-q', '--allow-empty', '-m', 'unpushed']);
    const commit = git(sub, ['rev-parse', 'HEAD']);
    const rows = (): ReturnType<LedgerApi['listNotifications']> => h.ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === 'worktree.submodule-work');

    const first = await h.manager.release({ worktreeId: 'job-told-gru', requireReleaseProofs: true }).catch((error: unknown) => error) as LaneSubmoduleWorkError;
    await expect(h.manager.release({ worktreeId: 'job-told-gru' })).rejects.toBeInstanceOf(LaneSubmoduleWorkError);

    expect(rows()).toHaveLength(1);
    const [row] = rows();
    expect(row).toMatchObject({ routing: 'action-required', resolvedAt: null });
    for (const fact of [`deps/lib: commit ${commit} (its HEAD)`, 'Tell the minion to push the submodule commit', `discard_submodule_work: "${first.digest}"`, `Digest: ${first.digest}.`]) expect(row!.detail).toContain(fact);

    git(sub, ['commit', '-q', '--allow-empty', '-m', 'another unpushed commit']);
    const second = await h.manager.release({ worktreeId: 'job-told-gru' }).catch((error: unknown) => error) as LaneSubmoduleWorkError;
    expect(second.digest).not.toBe(first.digest);
    const open = (): readonly string[] => rows().filter((notice) => notice.resolvedAt === null).map((notice) => notice.detail ?? '');
    expect(rows()).toHaveLength(2);
    expect(open()).toHaveLength(1);
    expect(open()[0]).toContain(second.digest);

    expect((await h.manager.release({ worktreeId: 'job-told-gru', discardSubmoduleWork: second.digest })).status).toBe('swept');
    expect(open()).toEqual([]);
  });

  it('runs no submodule listing in a repository with no .gitmodules: no ls-tree, ls-files -s or submodule status', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-no-modules');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-no-modules' });
    writeFileSync(join(lane.path, 'README.md'), 'a tracked edit\n');
    const shim = gitShim();

    const result = await h.manager.release({ worktreeId: 'job-no-modules' });

    shim.restore();
    expect(result.status).toBe('swept');
    const ran = shim.calls();
    // The spy sees GC's git: the snapshot ran through it.
    expect(ran.some((call) => call.includes('write-tree'))).toBe(true);
    expect(ran.filter((call) => / ls-tree | ls-files -s |status --porcelain=v2/u.test(` ${call} `))).toEqual([]);
  });

  it('a snapshot ref that cannot be written aborts the release after its records: worktree.release-aborted names the preserve copy, which stays, and retries reuse it, with no new folder, ref or record', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-ref-blocked');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-ref-blocked' });
    writeFileSync(join(lane.path, 'README.md'), 'a tracked edit\n');
    writeFileSync(join(lane.path, 'deliverable.txt'), 'an untracked deliverable\n');
    // A ref at the lane's own prefix: no snapshot ref can be made under it.
    h.repo.git(['update-ref', `${PRESERVED_REF_PREFIX}/job-ref-blocked`, 'HEAD']);

    await expect(h.manager.release({ worktreeId: 'job-ref-blocked' })).rejects.toThrow(/update-ref/u);

    const recorded = payloadOf(events(h, 'worktree.preserved')[0]);
    const destination = String(recorded['destination']);
    expect(events(h, 'worktree.release-aborted').map(payloadOf)).toEqual([{
      id: 'job-ref-blocked', path: lane.path, preserved: { destination, files: 1 }, snapshot: null, discarded: null, error: expect.stringMatching(/update-ref/u),
    }]);
    expect(readFileSync(join(destination, 'deliverable.txt'), 'utf-8')).toBe('an untracked deliverable\n');
    expect(readFileSync(join(lane.path, 'README.md'), 'utf-8')).toBe('a tracked edit\n');
    const folders = readdirSync(join(h.preserveRoot, 'job-ref-blocked'));
    expect(folders).toHaveLength(1);

    // The same failure again: the copy is reused and nothing new is recorded.
    await expect(h.manager.release({ worktreeId: 'job-ref-blocked' })).rejects.toThrow(/update-ref/u);
    expect(events(h, 'worktree.release-aborted')).toHaveLength(1);

    h.repo.git(['update-ref', '-d', `${PRESERVED_REF_PREFIX}/job-ref-blocked`]);
    const result = await h.manager.release({ worktreeId: 'job-ref-blocked' });

    expect(result).toMatchObject({ status: 'swept', preserved: { destination, count: 1 } });
    expect(readdirSync(join(h.preserveRoot, 'job-ref-blocked'))).toEqual(folders);
    expect(events(h, 'worktree.preserved')).toHaveLength(1);
    expect(preservedRefs(h.repo)).toHaveLength(1);
  });

  it('a removal that fails aborts the release after its snapshot ref: worktree.release-aborted names the copy and the ref, and the retry reuses both', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-busy-mount');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-busy-mount' });
    writeFileSync(join(lane.path, 'README.md'), 'a tracked edit\n');
    writeFileSync(join(lane.path, 'deliverable.txt'), 'an untracked deliverable\n');
    // git worktree remove fails (a busy mount in the lane), and the tree stays.
    const busy = gitShim('case "$*" in *"worktree remove"*) echo "error: failed to delete: Resource busy" >&2; exit 1;; esac');

    await expect(h.manager.release({ worktreeId: 'job-busy-mount' })).rejects.toThrow(/worktree remove/u);

    busy.restore();
    expect(busy.calls().some((call) => call.includes('worktree remove'))).toBe(true);
    const [ref] = preservedRefs(h.repo);
    const destination = String(payloadOf(events(h, 'worktree.preserved')[0])['destination']);
    expect(payloadOf(events(h, 'worktree.release-aborted')[0])).toMatchObject({
      preserved: { destination, files: 1 }, snapshot: { ref, sha: h.repo.git(['rev-parse', ref!]) }, error: expect.stringMatching(/Resource busy/u),
    });
    const result = await h.manager.release({ worktreeId: 'job-busy-mount' });

    expect(result).toMatchObject({ status: 'swept', preserved: { destination }, snapshot: { ref } });
    expect(preservedRefs(h.repo)).toEqual([ref]);
    expect(readdirSync(join(h.preserveRoot, 'job-busy-mount'))).toHaveLength(1);
    expect(events(h, 'worktree.preserved')).toHaveLength(1);
    expect(events(h, 'worktree.release-aborted')).toHaveLength(1);
  });

  it('tells the owner about a lane whose only work is untracked: the FYI row names the preserve folder and its file count', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-untracked-only');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-untracked-only' });
    mkdirSync(join(lane.path, 'docs'));
    writeFileSync(join(lane.path, 'docs', 'report.md'), 'the report\n');

    const result = await h.manager.release({ worktreeId: 'job-untracked-only' });

    expect(result.status === 'swept' ? result.snapshot : undefined).toBeNull();
    const rows = h.ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === 'worktree-work-saved');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toBe(`Lane job-untracked-only (job job-untracked-only) was released with 1 untracked file(s), copied to ${result.preserved!.destination}.`);
  });
});

describe('lane slimming: delivered report lanes lose their reclaim folders (#427)', () => {
  it('slims a delivered, idle review job when it delivers: node_modules goes, the lane, branch and edits stay, and worktree.slimmed carries the bytes and the manifest blob', async () => {
    const h = harness();
    const gate = restoringGate(h);
    slimmerFor(h, gate).start();
    addJob(h, 'job-report');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-report' });
    writeFileSync(join(lane.path, 'README.md'), 'the report draft\n');
    const bytes = await treeBytes(join(lane.path, 'node_modules'));

    h.ledger.setJobStatus('job-report', 'delivered');

    await vi.waitFor(() => expect(events(h, 'worktree.slimmed')).toHaveLength(1), { timeout: 30_000 });
    expect(existsSync(join(lane.path, 'node_modules'))).toBe(false);
    expect(readFileSync(join(lane.path, 'README.md'), 'utf-8')).toBe('the report draft\n');
    expect(h.repo.git(['status', '--porcelain'], lane.path)).toBe('M README.md');
    expect(h.repo.git(['branch', '--list', 'gru/job-report'])).toContain('gru/job-report');
    expect(h.ledger.getWorktree('job-report')?.status).toBe('active');
    expect(h.manager.isSlim('job-report')).toBe(true);
    const slimmed = events(h, 'worktree.slimmed')[0]!;
    expect(slimmed.jobId).toBe('job-report');
    expect(payloadOf(slimmed)).toEqual({
      id: 'job-report',
      manifest: manifestBlob(h),
      entries: [{ path: 'node_modules', bytes }],
      planned_bytes: bytes,
      skipped: [],
    });
    // What was really freed follows the deletes.
    const done = events(h, 'worktree.slim-done');
    expect(done).toHaveLength(1);
    expect(payloadOf(done[0])).toEqual({ id: 'job-report', freed_bytes: bytes, shared_bytes: 0 });
    expect(done[0]!.seq).toBeGreaterThan(slimmed.seq);
  });

  it('slims at start, and only report jobs: a delivered PR job keeps its folders', async () => {
    const h = harness();
    const report = await deliveredReportLane(h, 'job-at-start');
    addJob(h, 'job-pr', 'pr');
    const pr = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-pr' });
    h.ledger.setJobStatus('job-pr', 'delivered');
    const slimmer = slimmerFor(h, restoringGate(h));

    slimmer.start();
    await slimmer.idle();

    expect(existsSync(join(report, 'node_modules'))).toBe(false);
    expect(existsSync(join(pr.path, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(events(h, 'worktree.slimmed').map((event) => payloadOf(event)['id'])).toEqual(['job-at-start']);
  });

  it('does not slim while a worker turn is held, a process is rooted in the lane or a verification is queued; a declined lane is not enumerated again until the job has news, then it is slimmed', async () => {
    const h = harness();
    const gate = restoringGate(h);
    const { server, verify } = await verifyServer(h);
    const timers: { tick?: () => void } = {};
    const slimmer = slimmerFor(h, gate, { verificationBusy: (jobId) => server.jobHasRun(jobId), timers });
    const lanePath = await deliveredReportLane(h, 'job-busy');
    const turn = await gate.acquireWorkerTurn({ id: 'job-busy', label: 'a running turn', jobId: 'job-busy' });

    slimmer.start();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(true);
    turn.release();

    h.enumerator.mockReturnValue([{ pid: 4242, command: 'node watcher.js', evidence: 'cwd' }]);
    timers.tick!();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(true);
    const enumerated = h.enumerator.mock.calls.length;
    h.enumerator.mockReturnValue([]);
    // Nothing happened in the job since: the answer is not asked for again.
    timers.tick!();
    await slimmer.idle();
    expect(h.enumerator.mock.calls.length).toBe(enumerated);
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(true);

    // Another job holds the only verification slot, so this job's run queues.
    h.ledger.addJob({ id: 'job-other', repo: 'lane-lifecycle', title: 'holds the slot' });
    const budget = server.budget();
    const holder = await budget.acquire({ jobId: 'job-other', scope: 'full', command: 'true', cwd: h.dataDir });
    const run = verify('job-busy');
    await vi.waitFor(() => expect(server.view().queuedRuns).toBe(1), { timeout: 30_000 });
    expect(server.jobHasRun('job-busy')).toBe(true);
    timers.tick!();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(true);
    budget.release(holder);
    const frames = await run;
    expect(frames.find((frame) => frame.type === 'completed')).toBeDefined();
    expect(server.jobHasRun('job-busy')).toBe(false);

    // The verification is news: the lane is asked again, and is slimmed.
    timers.tick!();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(false);
    expect(events(h, 'worktree.slimmed')).toHaveLength(1);
  });

  it('waits until the job\'s last minion turn or delivery ended 30 minutes ago (injected clock)', async () => {
    const h = harness();
    const timers: { tick?: () => void } = {};
    let clock = Date.now();
    const logs: LogCall[] = [];
    const slimmer = slimmerFor(h, restoringGate(h), { timers, now: () => clock, logs });
    const lanePath = await deliveredReportLane(h, 'job-recent');

    slimmer.start();
    await slimmer.idle();
    clock += SLIM_MIN_IDLE_MS - 60_000;
    timers.tick!();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(true);
    expect(logs.filter((line) => line.msg === 'lane not slimmed')).toEqual([
      { level: 'info', msg: 'lane not slimmed', fields: { lane: 'job-recent', reason: RECENT } },
    ]);

    clock += 2 * 60_000;
    timers.tick!();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(false);
  });

  it('a job with an open provider wait is busy: its lane is not slimmed', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-waiting');
    h.ledger.registerAgent({ id: 'agent-job-waiting', role: 'minion', jobId: 'job-waiting' });
    recordWait(h, 'job-waiting');
    const logs: LogCall[] = [];
    const slimmer = slimmerFor(h, restoringGate(h), { logs });

    slimmer.start();
    await slimmer.idle();

    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(logs.map((line) => line.fields?.['reason'])).toEqual(['a provider wait of the job is open (its continuation is a minion turn)']);
  });

  it('the end of a minion turn after the delivery (its agent.state) restarts the 30 minutes', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-talking');
    const delivered = Date.now();
    const timers: { tick?: () => void } = {};
    const logs: LogCall[] = [];
    useDateAt(delivered + SLIM_MIN_IDLE_MS + 60_000);
    const slimmer = slimmerFor(h, restoringGate(h), { timers, logs, now: () => Date.now() });
    // A directive turn on the delivered job ends: the minion goes idle.
    h.ledger.registerAgent({ id: 'agent-job-talking', role: 'minion', jobId: 'job-talking' });
    h.ledger.setAgentState('agent-job-talking', 'streaming');
    h.ledger.setAgentState('agent-job-talking', 'idle');

    slimmer.start();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(true);
    expect(logs.map((line) => line.fields?.['reason'])).toEqual([RECENT]);

    vi.setSystemTime(delivered + 2 * SLIM_MIN_IDLE_MS + 120_000);
    timers.tick!();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(false);
  });

  it('a restore of the job\'s lanes (as a verification runs one) and the end of a verification run restart the 30 minutes', async () => {
    const h = harness();
    const restored = await deliveredReportLane(h, 'job-restored');
    const verified = await deliveredReportLane(h, 'job-verified');
    const delivered = Date.now();
    const timers: { tick?: () => void } = {};
    useDateAt(delivered + SLIM_MIN_IDLE_MS + 60_000);
    const slimmer = slimmerFor(h, restoringGate(h), { timers, now: () => Date.now() });
    expect((await h.manager.slim({ worktreeId: 'job-restored', idle: () => null })).status).toBe('slimmed');
    vi.setSystemTime(delivered + SLIM_MIN_IDLE_MS + 10 * 60_000);
    expect((await h.manager.ensureReady('job-restored'))[0]).toMatchObject({ status: 'rehydrated' });
    h.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: 'job-verified', payload: { run_id: 'run-verified' } });

    vi.setSystemTime(delivered + SLIM_MIN_IDLE_MS + 15 * 60_000);
    slimmer.start();
    await slimmer.idle();
    expect(existsSync(join(restored, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(existsSync(join(verified, 'node_modules', 'pkg', 'index.js'))).toBe(true);

    vi.setSystemTime(delivered + 2 * SLIM_MIN_IDLE_MS + 11 * 60_000);
    timers.tick!();
    await slimmer.idle();
    expect(existsSync(join(restored, 'node_modules'))).toBe(false);
    expect(existsSync(join(verified, 'node_modules'))).toBe(false);
  });

  it('an activity whose time cannot be read counts as recent, with one warn, never as idle', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-unreadable');
    const last = h.ledger.listJobEventsByKinds('job-unreadable', ['job.status'], { limit: 1 })[0]!;
    h.db.handle.prepare('UPDATE events SET ts = ? WHERE seq = ?').run('not a time', last.seq);
    const timers: { tick?: () => void } = {};
    const logs: LogCall[] = [];
    const slimmer = slimmerFor(h, restoringGate(h), { timers, logs });

    slimmer.start();
    await slimmer.idle();
    timers.tick!();
    await slimmer.idle();

    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(logs.filter((line) => line.level === 'warn')).toEqual([{
      level: 'warn',
      msg: 'a job activity event has a timestamp that cannot be read; its lanes count as not idle',
      fields: { job: 'job-unreadable', seq: last.seq, kind: 'job.status', ts: 'not a time' },
    }]);
    expect(logs.filter((line) => line.msg === 'lane not slimmed').map((line) => line.fields?.['reason'])).toEqual([`the job's last activity (event ${String(last.seq)}) has a timestamp that cannot be read`]);
  });

  it('a lane declined for a passing reason (a stray process that then exits) is asked again after one reconcile interval, with no news in the job', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-stray');
    const timers: { tick?: () => void } = {};
    let clock = IDLE_CLOCK();
    const slimmer = slimmerFor(h, restoringGate(h), { timers, now: () => clock });
    h.enumerator.mockReturnValue([{ pid: 4242, command: 'tsc --watch', evidence: 'cwd' }]);

    slimmer.start();
    await slimmer.idle();
    h.enumerator.mockReturnValue([]);
    timers.tick!();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(true);

    clock += SLIM_RECONCILE_INTERVAL_MS;
    timers.tick!();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(false);
  });

  it('a git failure reading the base manifest declines the slim for now, never for good', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-git-down');
    renameSync(join(lanePath, '.git'), join(lanePath, '.git-away'));

    const declined = await h.manager.slim({ worktreeId: 'job-git-down', idle: () => null });

    expect(declined).toMatchObject({ status: 'not-slimmed', permanent: false, reason: expect.stringMatching(/^the manifest the lane was built from could not be read: git ls-tree/u) });
    renameSync(join(lanePath, '.git-away'), join(lanePath, '.git'));
    expect((await h.manager.slim({ worktreeId: 'job-git-down', idle: () => null })).status).toBe('slimmed');
  });

  it('is quiet: reconciles of an already-slim lane log nothing, and a lane that can never be slimmed is logged once', async () => {
    const h = harness();
    const timers: { tick?: () => void } = {};
    const logs: LogCall[] = [];
    const slimmer = slimmerFor(h, restoringGate(h), { timers, logs });
    await deliveredReportLane(h, 'job-quiet');
    expect((await h.manager.slim({ worktreeId: 'job-quiet', idle: () => null })).status).toBe('slimmed');

    slimmer.start();
    await slimmer.idle();
    timers.tick!();
    await slimmer.idle();
    expect(logs).toEqual([]);

    const noSetup = harness({ manifest: 'reclaim = ["node_modules"]\n' });
    const unslimmableTimers: { tick?: () => void } = {};
    const unslimmableLogs: LogCall[] = [];
    const unslimmable = slimmerFor(noSetup, restoringGate(noSetup), { timers: unslimmableTimers, logs: unslimmableLogs });
    addJob(noSetup, 'job-no-setup');
    await noSetup.manager.createJobWorktree({ repoPath: noSetup.repo.path, jobId: 'job-no-setup' });
    noSetup.ledger.setJobStatus('job-no-setup', 'delivered');
    unslimmable.start();
    await unslimmable.idle();
    unslimmableTimers.tick!();
    await unslimmable.idle();
    unslimmableTimers.tick!();
    await unslimmable.idle();
    expect(unslimmableLogs).toEqual([{
      level: 'info',
      msg: 'lane not slimmed',
      fields: { lane: 'job-no-setup', reason: 'the manifest the lane was built from has no [[setup]], so nothing could restore its reclaim folders' },
    }]);
  });

  it('skips an unsafe entry by name (tracked files, a link, a link on the path, not ignored, a check that throws) and slims the others; a missing entry is skipped silently', async () => {
    const outside = tempDir('gru-lane-lifecycle-outside-');
    mkdirSync(join(outside, 'inner'));
    writeFileSync(join(outside, 'keep.txt'), 'outside the lane\n');
    writeFileSync(join(outside, 'inner', 'keep.txt'), 'outside the lane too\n');
    const h = harness({
      gitignore: `${IGNORED}vendor/\nlinked\nthrough\n`,
      files: { 'vendor/keep.txt': 'a tracked file under an ignored folder\n' },
      manifest: [
        'reclaim = ["vendor", "linked", "through/inner", "scratch", "missing", "node_modules"]',
        '',
        '[[setup]]',
        `command = "${SETUP}"`,
        '',
      ].join('\n'),
    });
    const lanePath = await deliveredReportLane(h, 'job-unsafe');
    symlinkSync(outside, join(lanePath, 'linked'));
    symlinkSync(outside, join(lanePath, 'through'));
    mkdirSync(join(lanePath, 'scratch'));
    writeFileSync(join(lanePath, 'scratch', 'notes.txt'), 'untracked, not ignored\n');
    const bytes = await treeBytes(join(lanePath, 'node_modules'));
    const slimmer = slimmerFor(h, restoringGate(h));

    slimmer.start();
    await slimmer.idle();

    expect(existsSync(join(lanePath, 'node_modules'))).toBe(false);
    expect(readFileSync(join(lanePath, 'vendor', 'keep.txt'), 'utf-8')).toBe('a tracked file under an ignored folder\n');
    expect(readFileSync(join(outside, 'keep.txt'), 'utf-8')).toBe('outside the lane\n');
    expect(readFileSync(join(outside, 'inner', 'keep.txt'), 'utf-8')).toBe('outside the lane too\n');
    expect(readFileSync(join(lanePath, 'scratch', 'notes.txt'), 'utf-8')).toBe('untracked, not ignored\n');
    expect(payloadOf(events(h, 'worktree.slimmed')[0])).toEqual({
      id: 'job-unsafe',
      manifest: manifestBlob(h),
      entries: [{ path: 'node_modules', bytes }],
      planned_bytes: bytes,
      skipped: [
        { path: 'vendor', reason: 'git tracks 1 file(s) under it' },
        { path: 'linked', reason: 'it is, or lies under, a link' },
        { path: 'through/inner', reason: 'it is, or lies under, a link' },
        { path: 'scratch', reason: 'git does not ignore it' },
      ],
    });
  });

  it('a check that throws (a reclaim path inside a submodule) skips that entry by name; the others are recorded before they are deleted, the lane is slim, and the next turn runs setup', async () => {
    const h = harness({ manifest: ['reclaim = ["node_modules", "deps/lib/node_modules"]', '', '[[setup]]', `command = "${SETUP}"`, ''].join('\n') });
    addSubmodule(h);
    const lanePath = await deliveredReportLane(h, 'job-throws');
    initSubmodule(lanePath);
    mkdirSync(join(lanePath, 'deps', 'lib', 'node_modules'));

    const result = await h.manager.slim({ worktreeId: 'job-throws', idle: () => null });

    expect(result.status).toBe('slimmed');
    expect(result.skipped).toEqual([{ path: 'deps/lib/node_modules', reason: expect.stringMatching(/^its check failed: git check-ignore exited 128: .*in submodule/u) }]);
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(false);
    expect(h.manager.isSlim('job-throws')).toBe(true);
    const seen: boolean[] = [];
    await directive(h, 'job-throws', restoringGate(h), () => { seen.push(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))); });
    expect(seen).toEqual([true]);
    expect(h.manager.isSlim('job-throws')).toBe(false);
  });

  it('records the slim before the first delete: a slim whose record cannot be written deletes nothing', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-unrecorded');
    const append = h.ledger.appendCustomEvent.bind(h.ledger);
    vi.spyOn(h.ledger, 'appendCustomEvent').mockImplementation((input) => {
      if (input.kind === 'worktree.slimmed') throw new Error('SQLITE_FULL: database or disk is full');
      return append(input);
    });

    const result = await h.manager.slim({ worktreeId: 'job-unrecorded', idle: () => null });

    expect(result).toMatchObject({ status: 'not-slimmed', reason: expect.stringMatching(/^the slim could not be recorded, so nothing was deleted: .*SQLITE_FULL/u) });
    expect(readFileSync(join(lanePath, 'node_modules', 'pkg', 'index.js'), 'utf-8')).toBe(MODULE);
    expect(h.manager.isSlim('job-unrecorded')).toBe(false);
  });

  it('never deletes a [[link]] or [[copy]] destination: an entry holding one is skipped by name', async () => {
    const models = tempDir('gru-lane-lifecycle-models-');
    writeFileSync(join(models, 'weights.bin'), 'shared model weights\n');
    const h = harness({
      gitignore: `${IGNORED}cache/\nseeded/\n.env.local\n`,
      manifest: [
        'reclaim = ["node_modules", "cache", "seeded"]',
        '',
        '[[link]]', 'at = "cache/models"', `to = "${models}"`,
        '',
        '[[copy]]', 'from = ".env.local"', 'to = "./seeded/.env.local"',
        '',
        '[[setup]]', `command = "${SETUP}"`,
        '',
      ].join('\n'),
    });
    writeFileSync(join(h.repo.path, '.env.local'), 'SEED=1\n');
    const lanePath = await deliveredReportLane(h, 'job-linked');
    writeFileSync(join(lanePath, 'cache', 'downloaded.txt'), 'a cache file beside the link\n');

    const result = await h.manager.slim({ worktreeId: 'job-linked', idle: () => null });

    expect(result.status).toBe('slimmed');
    expect(result.skipped).toEqual([
      { path: 'cache', reason: 'the manifest\'s [[link]] or [[copy]] destination cache/models lies at or under it, and a restore runs only [[setup]]' },
      { path: 'seeded', reason: 'the manifest\'s [[link]] or [[copy]] destination seeded/.env.local lies at or under it, and a restore runs only [[setup]]' },
    ]);
    expect(lstatSync(join(lanePath, 'cache', 'models')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(lanePath, 'seeded', '.env.local'), 'utf-8')).toBe('SEED=1\n');
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(false);
  });

  it('reads reclaim and setup from the manifest the lane was built from: an uncommitted or committed edit in the lane adds nothing, and a base manifest without reclaim or setup is never slimmed', async () => {
    const noReclaim = harness({ manifest: ['[[setup]]', `command = "${SETUP}"`, ''].join('\n') });
    const lanePath = await deliveredReportLane(noReclaim, 'job-no-reclaim');
    writeFileSync(join(lanePath, '.gru-command', 'worktree.toml'), manifestWith());
    expect(await noReclaim.manager.slim({ worktreeId: 'job-no-reclaim', idle: () => null }))
      .toEqual({ status: 'not-slimmed', reason: 'the manifest the lane was built from declares no reclaim', permanent: true, planned: false, skipped: [] });
    git(lanePath, ['commit', '-qam', 'a minion adds reclaim']);
    expect(await noReclaim.manager.slim({ worktreeId: 'job-no-reclaim', idle: () => null }))
      .toMatchObject({ status: 'not-slimmed', permanent: true });

    const noSetup = harness({ manifest: 'reclaim = ["node_modules"]\n' });
    addJob(noSetup, 'job-no-setup');
    const bare = await noSetup.manager.createJobWorktree({ repoPath: noSetup.repo.path, jobId: 'job-no-setup' });
    mkdirSync(join(bare.path, 'node_modules'));
    writeFileSync(join(bare.path, 'node_modules', 'dep.js'), MODULE);
    expect(await noSetup.manager.slim({ worktreeId: 'job-no-setup', idle: () => null })).toEqual({
      status: 'not-slimmed',
      reason: 'the manifest the lane was built from has no [[setup]], so nothing could restore its reclaim folders',
      permanent: true,
      planned: false,
      skipped: [],
    });

    const none = harness({ manifest: null });
    addJob(none, 'job-no-manifest');
    const unmanaged = await none.manager.createJobWorktree({ repoPath: none.repo.path, jobId: 'job-no-manifest' });
    mkdirSync(join(unmanaged.path, 'node_modules'));
    expect(await none.manager.slim({ worktreeId: 'job-no-manifest', idle: () => null }))
      .toEqual({ status: 'not-slimmed', reason: 'the lane was built from no manifest', permanent: true, planned: false, skipped: [] });

    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(readFileSync(join(bare.path, 'node_modules', 'dep.js'), 'utf-8')).toBe(MODULE);
    expect(existsSync(join(unmanaged.path, 'node_modules'))).toBe(true);
    for (const h of [noReclaim, noSetup, none]) expect(events(h, 'worktree.slimmed')).toHaveLength(0);
  });

  it('a slim and a release of the same lane never overlap: a release arriving mid-slim waits for it', async () => {
    const h = harness();
    await deliveredReportLane(h, 'job-overlap');
    const order: string[] = [];
    let release = null as Promise<unknown> | null;

    const slim = h.manager.slim({
      worktreeId: 'job-overlap',
      idle: () => {
        // The commissioner accepts the report while the slim runs.
        release = h.manager.release({ worktreeId: 'job-overlap' }).then((result) => { order.push('release'); return result; });
        return null;
      },
    }).then((result) => { order.push('slim'); return result; });

    expect((await slim).status).toBe('slimmed');
    expect(await release).toMatchObject({ status: 'swept' });
    expect(order).toEqual(['slim', 'release']);
    expect(events(h, 'worktree.slimmed')[0]!.seq).toBeLessThan(events(h, 'worktree.swept')[0]!.seq);
  });

  it('counts bytes on disk, a hard-linked file once', async () => {
    const dir = tempDir('gru-lane-lifecycle-bytes-');
    writeFileSync(join(dir, 'a.bin'), 'x'.repeat(10_000));
    linkSync(join(dir, 'a.bin'), join(dir, 'b.bin'));
    const allocated = (path: string): number => {
      const stat = lstatSync(path);
      return typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
    };

    expect(await treeBytes(dir)).toBe(allocated(dir) + allocated(join(dir, 'a.bin')));
  });

  it('counts a file hard-linked from outside the tree as shared, never freed: worktree.slimmed carries it as shared_bytes', async () => {
    const store = tempDir('gru-lane-lifecycle-store-');
    writeFileSync(join(store, 'package.bin'), 'p'.repeat(64_000));
    const dir = tempDir('gru-lane-lifecycle-shared-');
    linkSync(join(store, 'package.bin'), join(dir, 'linked.bin'));
    writeFileSync(join(dir, 'own.bin'), 'o'.repeat(10_000));
    const allocated = (path: string): number => {
      const stat = lstatSync(path);
      return typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size;
    };
    expect(await treeUsage(dir)).toEqual({ bytes: allocated(dir) + allocated(join(dir, 'own.bin')), sharedBytes: allocated(join(dir, 'linked.bin')) });

    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-store');
    linkSync(join(store, 'package.bin'), join(lanePath, 'node_modules', 'pkg', 'package.bin'));
    const usage = await treeUsage(join(lanePath, 'node_modules'));
    expect(usage.sharedBytes).toBe(allocated(join(store, 'package.bin')));

    const result = await h.manager.slim({ worktreeId: 'job-store', idle: () => null });

    expect(result).toMatchObject({ status: 'slimmed', freedBytes: usage.bytes, sharedBytes: usage.sharedBytes });
    expect(payloadOf(events(h, 'worktree.slimmed')[0])).toMatchObject({ entries: [{ path: 'node_modules', bytes: usage.bytes }], planned_bytes: usage.bytes });
    expect(payloadOf(events(h, 'worktree.slim-done')[0])).toEqual({ id: 'job-store', freed_bytes: usage.bytes, shared_bytes: usage.sharedBytes });
    expect(readFileSync(join(store, 'package.bin'), 'utf-8')).toHaveLength(64_000);
  });

  it('re-checks each entry before its delete: one that became a link after the slim was planned is not followed, and is recorded in worktree.slim-incomplete with only what was freed', async () => {
    const outside = tempDir('gru-lane-lifecycle-outside-');
    mkdirSync(join(outside, 'inner'));
    writeFileSync(join(outside, 'inner', 'keep.txt'), 'outside the lane\n');
    const h = harness({ gitignore: `${IGNORED}through/\n`, manifest: ['reclaim = ["through/inner", "node_modules"]', '', '[[setup]]', `command = "${SETUP}"`, ''].join('\n') });
    const lanePath = await deliveredReportLane(h, 'job-swapped');
    mkdirSync(join(lanePath, 'through', 'inner'), { recursive: true });
    writeFileSync(join(lanePath, 'through', 'inner', 'built.js'), 'built\n');
    const nodeModules = await treeBytes(join(lanePath, 'node_modules'));
    const append = h.ledger.appendCustomEvent.bind(h.ledger);
    vi.spyOn(h.ledger, 'appendCustomEvent').mockImplementation((input) => {
      const written = append(input);
      if (input.kind === 'worktree.slimmed') {
        // Between the record and the deletes, the planned folder's parent becomes a link out of the lane.
        rmSync(join(lanePath, 'through'), { recursive: true, force: true });
        symlinkSync(outside, join(lanePath, 'through'));
      }
      return written;
    });

    const result = await h.manager.slim({ worktreeId: 'job-swapped', idle: () => null });

    expect(readFileSync(join(outside, 'inner', 'keep.txt'), 'utf-8')).toBe('outside the lane\n');
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(false);
    expect(result).toMatchObject({ status: 'slimmed', freedBytes: nodeModules, entries: [{ path: 'node_modules', bytes: nodeModules }] });
    expect(payloadOf(events(h, 'worktree.slim-incomplete')[0])).toEqual({
      id: 'job-swapped',
      failed: [{ path: 'through/inner', reason: 'deleting it failed: a link appeared on its path after the slim was planned' }],
      freed_bytes: nodeModules,
      shared_bytes: 0,
    });
    expect(h.manager.isSlim('job-swapped')).toBe(true);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('a delete that fails is recorded in worktree.slim-incomplete, and the lane is slim so its next turn runs setup', async () => {
    const h = harness({ gitignore: `${IGNORED}locked/\n`, manifest: ['reclaim = ["locked/deep", "node_modules"]', '', '[[setup]]', `command = "${SETUP}"`, ''].join('\n') });
    const lanePath = await deliveredReportLane(h, 'job-locked');
    mkdirSync(join(lanePath, 'locked', 'deep'), { recursive: true });
    writeFileSync(join(lanePath, 'locked', 'deep', 'built.js'), 'built\n');
    // Its parent is read-only, so the entry cannot be unlinked from it.
    chmodSync(join(lanePath, 'locked'), 0o500);
    cleanups.push(() => { chmodSync(join(lanePath, 'locked'), 0o700); });

    const result = await h.manager.slim({ worktreeId: 'job-locked', idle: () => null });

    expect(result.status).toBe('slimmed');
    expect(existsSync(join(lanePath, 'locked', 'deep', 'built.js'))).toBe(true);
    const incomplete = payloadOf(events(h, 'worktree.slim-incomplete')[0]);
    expect(incomplete['failed']).toEqual([{ path: 'locked/deep', reason: expect.stringMatching(/^deleting it failed: .*(EACCES|EPERM)/u) }]);
    expect(incomplete['freed_bytes']).toBe(result.status === 'slimmed' ? result.freedBytes : -1);
    expect(h.manager.isSlim('job-locked')).toBe(true);
    expect((await h.manager.ensureReady('job-locked'))[0]).toMatchObject({ status: 'rehydrated', notRecreated: [] });
  });

  it('a stop between entries leaves the rest: the slim is on the record, what was not deleted is in worktree.slim-incomplete, and the next turn restores the lane', async () => {
    const h = harness({ gitignore: `${IGNORED}cache/\n`, manifest: ['reclaim = ["node_modules", "cache"]', '', '[[setup]]', `command = "${SETUP}"`, ''].join('\n') });
    const lanePath = await deliveredReportLane(h, 'job-stopped-pass');
    mkdirSync(join(lanePath, 'cache'));
    writeFileSync(join(lanePath, 'cache', 'blob'), 'cached\n');
    const slimmer = slimmerFor(h, restoringGate(h));
    const append = h.ledger.appendCustomEvent.bind(h.ledger);
    vi.spyOn(h.ledger, 'appendCustomEvent').mockImplementation((input) => {
      const written = append(input);
      // The service stops once the slim is recorded, before its deletes.
      if (input.kind === 'worktree.slimmed') void slimmer.stop();
      return written;
    });

    slimmer.start();
    await slimmer.idle();

    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(existsSync(join(lanePath, 'cache', 'blob'))).toBe(true);
    expect(payloadOf(events(h, 'worktree.slim-incomplete')[0])['failed']).toEqual([
      { path: 'node_modules', reason: 'the service stopped before it was deleted' },
      { path: 'cache', reason: 'the service stopped before it was deleted' },
    ]);
    expect(h.manager.isSlim('job-stopped-pass')).toBe(true);
    expect((await h.manager.ensureReady('job-stopped-pass'))[0]).toMatchObject({ status: 'rehydrated', notRecreated: [] });
  });

  it('logs the reclaim entries a slim skipped, with their reasons, once per change of them', async () => {
    const outside = tempDir('gru-lane-lifecycle-outside-');
    const h = harness({
      gitignore: `${IGNORED}vendor/\nlinked\n`,
      files: { 'vendor/keep.txt': 'a tracked file under an ignored folder\n' },
      manifest: ['reclaim = ["vendor", "linked", "node_modules"]', '', '[[setup]]', `command = "${SETUP}"`, ''].join('\n'),
    });
    const lanePath = await deliveredReportLane(h, 'job-skips');
    const timers: { tick?: () => void } = {};
    const logs: LogCall[] = [];
    const slimmer = slimmerFor(h, restoringGate(h), { timers, logs });
    const skipLogs = (): readonly LogCall[] => logs.filter((line) => line.msg === 'lane slimming skipped reclaim entries');
    const vendor = { path: 'vendor', reason: 'git tracks 1 file(s) under it' };

    slimmer.start();
    await slimmer.idle();
    expect(skipLogs()).toEqual([{ level: 'warn', msg: 'lane slimming skipped reclaim entries', fields: { lane: 'job-skips', skipped: [vendor] } }]);

    await h.manager.ensureReady('job-skips');
    timers.tick!();
    await slimmer.idle();
    expect(events(h, 'worktree.slimmed')).toHaveLength(2);
    expect(skipLogs()).toHaveLength(1);

    await h.manager.ensureReady('job-skips');
    symlinkSync(outside, join(lanePath, 'linked'));
    timers.tick!();
    await slimmer.idle();
    expect(events(h, 'worktree.slimmed')).toHaveLength(3);
    expect(skipLogs().map((line) => line.fields?.['skipped'])).toEqual([[vendor], [vendor, { path: 'linked', reason: 'it is, or lies under, a link' }]]);
  });

  it('a stop mid-delete ends the delete at its next path: the pass returns at once, worktree.slimmed carries planned_bytes and no freed_bytes, no slim-done is recorded, and the lane is slim', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-cut-short');
    const nodeModules = join(lanePath, 'node_modules');
    for (let index = 0; index < 3_000; index += 1) {
      mkdirSync(join(nodeModules, `dep-${String(index)}`));
      writeFileSync(join(nodeModules, `dep-${String(index)}`, 'index.js'), MODULE);
    }
    const before = readdirSync(nodeModules).length;
    const slimmer = slimmerFor(h, restoringGate(h));
    let stopping: Promise<void> | null = null;
    let askedAt = 0;
    // The service stops as soon as the delete has begun.
    const watch = setInterval(() => {
      if (stopping === null && existsSync(nodeModules) && readdirSync(nodeModules).length < before) {
        askedAt = Date.now();
        stopping = slimmer.stop();
      }
    }, 10);
    cleanups.push(() => { clearInterval(watch); });

    slimmer.start();
    await vi.waitFor(() => expect(stopping).not.toBeNull(), { timeout: 30_000 });
    await stopping;

    expect(Date.now() - askedAt).toBeLessThan(LANE_SLIMMER_STOP_WAIT_MS);
    expect(readdirSync(nodeModules).length).toBeGreaterThan(0);
    const slimmed = payloadOf(events(h, 'worktree.slimmed')[0]);
    expect(slimmed['planned_bytes']).toEqual(expect.any(Number));
    expect(slimmed).not.toHaveProperty('freed_bytes');
    expect(events(h, 'worktree.slim-done')).toHaveLength(0);
    expect(payloadOf(events(h, 'worktree.slim-incomplete')[0])).toMatchObject({ failed: [{ path: 'node_modules', reason: 'the service stopped while it was being deleted' }], freed_bytes: 0 });
    expect(h.manager.isSlim('job-cut-short')).toBe(true);
  }, 60_000);

  it('a lane declined at one reconcile is asked again at the next, however long the declined slim took (the clock moves during the pass)', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-slow-decline');
    const timers: { tick?: () => void } = {};
    const started = IDLE_CLOCK();
    let clock = started;
    const slimmer = slimmerFor(h, restoringGate(h), { timers, now: () => clock });
    // The slim's enumeration takes twenty seconds of the clock, and finds a stray process.
    h.enumerator.mockImplementation(() => {
      clock += 20_000;
      return [{ pid: 4242, command: 'tsc --watch', evidence: 'cwd' }];
    });

    slimmer.start();
    await slimmer.idle();
    expect(existsSync(join(lanePath, 'node_modules'))).toBe(true);
    h.enumerator.mockImplementation(() => []);
    // The next reconcile fires one interval after the first one began.
    clock = started + SLIM_RECONCILE_INTERVAL_MS;
    timers.tick!();
    await slimmer.idle();

    expect(existsSync(join(lanePath, 'node_modules'))).toBe(false);
  });

  it('logs skipped entries only from a pass that ran its plan: declines between slims with the same skips log nothing new', async () => {
    const h = harness({
      gitignore: `${IGNORED}vendor/\n`,
      files: { 'vendor/keep.txt': 'a tracked file under an ignored folder\n' },
      manifest: ['reclaim = ["vendor", "node_modules"]', '', '[[setup]]', `command = "${SETUP}"`, ''].join('\n'),
    });
    await deliveredReportLane(h, 'job-skips-steady');
    const timers: { tick?: () => void } = {};
    const logs: LogCall[] = [];
    let clock = IDLE_CLOCK();
    const slimmer = slimmerFor(h, restoringGate(h), { timers, logs, now: () => clock });
    const skipLogs = (): readonly LogCall[] => logs.filter((line) => line.msg === 'lane slimming skipped reclaim entries');
    const stray = [{ pid: 4242, command: 'tsc --watch', evidence: 'cwd' as const }];
    const pass = async (rooted: boolean): Promise<void> => {
      h.enumerator.mockReturnValue(rooted ? stray : []);
      clock += SLIM_RECONCILE_INTERVAL_MS;
      timers.tick!();
      await slimmer.idle();
    };

    h.enumerator.mockReturnValue(stray);
    slimmer.start();
    await slimmer.idle();
    await pass(false);
    expect(events(h, 'worktree.slimmed')).toHaveLength(1);
    await h.manager.ensureReady('job-skips-steady');
    await pass(true);
    await pass(false);

    expect(events(h, 'worktree.slimmed')).toHaveLength(2);
    expect(skipLogs()).toHaveLength(1);
  });

  it('GC\'s own manifest reclaims node_modules and web/node_modules, and keeps dist', () => {
    const manifest = parseToml(readFileSync(join(import.meta.dirname, '..', '.gru-command', 'worktree.toml'), 'utf-8')) as { reclaim?: unknown };
    expect(manifest.reclaim).toEqual(['node_modules', 'web/node_modules']);
  });
});

describe('the report-lane slimmer\'s lifecycle (#427)', () => {
  it('stop() waits for the pass that is running', async () => {
    const h = harness({ manifest: null });
    addJob(h, 'job-stopping');
    h.ledger.setJobStatus('job-stopping', 'delivered');
    const lane = { id: 'job-stopping', kind: 'job', branch: 'gru/job-stopping' } as ReturnType<WorktreeManager['listWorktrees']>[number];
    const entered = deferred();
    const finish = deferred();
    const slimmer = new ReportLaneSlimmer({
      ledger: h.ledger,
      bus: h.bus,
      worktrees: {
        listWorktrees: () => [lane],
        isSlim: () => false,
        slim: async () => {
          entered.resolve();
          await finish.promise;
          return { status: 'slimmed', entries: [], freedBytes: 0, sharedBytes: 0, skipped: [] };
        },
      },
      workerTurns: () => ({ held: 0, queued: 0 }),
      verificationBusy: () => false,
      now: IDLE_CLOCK,
    });
    slimmer.start();
    await entered.promise;

    let stopped = false;
    const stopping = Promise.resolve(slimmer.stop()).then(() => { stopped = true; });
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    expect(stopped).toBe(false);
    finish.resolve();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('runs one pass at a time across the service: a start over many delivered jobs never slims two lanes at once', async () => {
    const h = harness({ manifest: null });
    let running = 0;
    let most = 0;
    for (const jobId of ['job-1', 'job-2', 'job-3']) {
      addJob(h, jobId);
      h.ledger.setJobStatus(jobId, 'delivered');
    }
    const slimmer = new ReportLaneSlimmer({
      ledger: h.ledger,
      bus: h.bus,
      worktrees: {
        listWorktrees: (filter) => [{ id: filter?.jobId ?? '', kind: 'job', branch: `gru/${filter?.jobId ?? ''}` } as ReturnType<WorktreeManager['listWorktrees']>[number]],
        isSlim: () => false,
        slim: async () => {
          running += 1;
          most = Math.max(most, running);
          await new Promise((resolveTick) => setTimeout(resolveTick, 10));
          running -= 1;
          return { status: 'slimmed', entries: [], freedBytes: 0, sharedBytes: 0, skipped: [] };
        },
      },
      workerTurns: () => ({ held: 0, queued: 0 }),
      verificationBusy: () => false,
      now: IDLE_CLOCK,
    });
    cleanups.push(() => slimmer.stop());

    slimmer.start();
    await slimmer.idle();

    expect(most).toBe(1);
  });
});

/** A recovered provider wait on the job's minion (the claim harness shape). */
function recordWait(h: Harness, jobId: string, opts: { readonly recovered?: boolean } = {}): string {
  h.ledger.recordProviderWait({
    id: `wait-${jobId}`,
    routeKey: 'zai-coding-cn/glm-5.3@fp1',
    provider: 'zai-coding-cn',
    model: 'glm-5.3',
    endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4',
    credentialFingerprint: 'fp1',
    jobStatusAtEstablishment: 'working',
    lineageKey: `job:${jobId}`,
    waiterKind: 'job-minion',
    jobId,
    agentId: `agent-${jobId}`,
    slotId: null,
    sessionFile: null,
    continuation: { promptText: 'continue the report', promptOwner: 'minion-brief', hadOpenTurn: true },
    incidentId: `incident-${jobId}`,
    incidentGeneration: 1,
    reasonClass: 'temporary-recoverable:429',
  });
  if (opts.recovered === true) {
    h.ledger.commitProviderRecoveryBatch({
      id: `batch-${jobId}`,
      routeKey: 'zai-coding-cn/glm-5.3@fp1',
      incidentGenerations: [1],
      evidence: { stopReason: 'stop' },
      waiters: [{ id: `wait-${jobId}`, jobId }],
    });
  }
  return `wait-${jobId}`;
}

describe('a slim lane is restored before its next turn or verification (#427)', () => {
  it('runs setup before a fix directive\'s prompt, records worktree.rehydrated, and the turn runs', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-turn');
    expect((await h.manager.slim({ worktreeId: 'job-turn', idle: () => null })).status).toBe('slimmed');
    const gate = restoringGate(h);
    const seen: { restored: boolean; rehydrated: boolean }[] = [];

    const routed = await directive(h, 'job-turn', gate, () => {
      seen.push({
        restored: existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js')),
        rehydrated: h.ledger.latestJobEventByPayloadField('job-turn', 'worktree.rehydrated', 'id', 'job-turn') !== null,
      });
    });

    expect(routed).toMatchObject({ delivered: true });
    expect(seen).toEqual([{ restored: true, rehydrated: true }]);
    expect(h.manager.isSlim('job-turn')).toBe(false);
    expect(setupRuns(lanePath)).toBe(2);
    expect(payloadOf(events(h, 'worktree.rehydrated')[0])).toEqual({ id: 'job-turn', ms: expect.any(Number) });
  });

  it('a provider-recovery continuation on a slim lane runs setup before its prompt', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-recovered');
    expect((await h.manager.slim({ worktreeId: 'job-recovered', idle: () => null })).status).toBe('slimmed');
    h.ledger.registerAgent({ id: 'agent-job-recovered', role: 'minion', jobId: 'job-recovered' });
    const waitId = recordWait(h, 'job-recovered', { recovered: true });
    const seen: boolean[] = [];
    const handle = {
      id: 'minion-recovered',
      sessionFile: null,
      prompt: async () => { seen.push(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))); },
      health: () => ({ state: 'idle', lastActivity: new Date().toISOString(), sessionFile: null }),
      subscribe: () => () => {},
      dispose: async () => {},
    } as unknown as AgentHandle;
    const deps: RecoveryClaimDeps = {
      registry: { getHandle: () => null, spawn: async () => handle, disposeHandle: async () => {} } as unknown as RecoveryClaimDeps['registry'],
      ledger: h.ledger,
      worktrees: h.manager,
      ensureReady: h.hooks.beforeContinuation,
    };

    expect(await claimProviderRecoveryContinuation(deps, waitId, 'silas')).toMatchObject({ outcome: 'continued' });

    expect(seen).toEqual([true]);
    expect(h.manager.isSlim('job-recovered')).toBe(false);
    expect(events(h, 'worktree.rehydrated')).toHaveLength(1);
  });

  it('when setup fails it records worktree.rehydrate-failed (redacted), the turn still runs, the lane stays slim, and the next turn retries', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-fail');
    expect((await h.manager.slim({ worktreeId: 'job-fail', idle: () => null })).status).toBe('slimmed');
    writeFileSync(join(lanePath, 'fail-setup'), '');
    const gate = restoringGate(h);
    let prompts = 0;

    await expect(directive(h, 'job-fail', gate, () => { prompts += 1; })).resolves.toMatchObject({ delivered: true });

    expect(prompts).toBe(1);
    expect(h.manager.isSlim('job-fail')).toBe(true);
    const failed = payloadOf(events(h, 'worktree.rehydrate-failed')[0]);
    expect(failed['id']).toBe('job-fail');
    expect(failed['manifest']).toBe(manifestBlob(h));
    expect(String(failed['error'])).toContain('setup failed');
    expect(String(failed['error'])).toContain('[REDACTED]');
    expect(String(failed['error'])).not.toContain('supersecretvalue123');

    rmSync(join(lanePath, 'fail-setup'));
    await directive(h, 'job-fail', gate, () => { prompts += 1; });
    expect(prompts).toBe(2);
    expect(h.manager.isSlim('job-fail')).toBe(false);
    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  });

  it('a failed restore whose error ends in one line longer than the kept tail records that line\'s last words, never only "…"', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-long');
    expect((await h.manager.slim({ worktreeId: 'job-long', idle: () => null })).status).toBe('slimmed');
    // One 10 KiB line of words (three-byte characters), ending in a newline.
    writeFileSync(join(lanePath, 'long-line.txt'), `${'€€€€€€€€ '.repeat(400)}\n`);

    const [outcome] = await h.manager.ensureReady('job-long');

    expect(outcome).toMatchObject({ status: 'rehydrate-failed' });
    const recorded = String(payloadOf(events(h, 'worktree.rehydrate-failed')[0])['error']);
    expect(recorded).toMatch(/^worktree setup command exited 1: .*\noutput tail:\n\(output tail starts mid-line\)\n(€€€€€€€€ )+/u);
    expect(Buffer.byteLength(recorded, 'utf8')).toBeLessThanOrEqual(4 * 1024);
  });

  it('restores from the manifest blob the slim recorded, even after the lane\'s HEAD changed its manifest', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-rewritten');
    expect((await h.manager.slim({ worktreeId: 'job-rewritten', idle: () => null })).status).toBe('slimmed');
    writeFileSync(join(lanePath, '.gru-command', 'worktree.toml'), [
      'reclaim = ["node_modules"]', '', '[[setup]]', 'command = "echo a minion chose this > minion-setup-ran"', '',
    ].join('\n'));
    git(lanePath, ['commit', '-qam', 'a minion rewrites the setup']);

    const [outcome] = await h.manager.ensureReady('job-rewritten');

    expect(outcome).toMatchObject({ status: 'rehydrated' });
    expect(existsSync(join(lanePath, 'minion-setup-ran'))).toBe(false);
    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(setupRuns(lanePath)).toBe(2);
  });

  it('a restore whose setup succeeded is a restore: an entry only a build or verify makes (target) is recorded as not recreated, the lane is not slim, and a later slim of it works', async () => {
    const h = harness({
      gitignore: `${IGNORED}target/\n`,
      manifest: ['reclaim = ["target", "node_modules"]', '', '[[setup]]', `command = "${SETUP}"`, '', '[verify]', 'full = "mkdir -p target && echo built > target/out"', ''].join('\n'),
    });
    const lanePath = await deliveredReportLane(h, 'job-target');
    // What verify.full builds.
    mkdirSync(join(lanePath, 'target'));
    writeFileSync(join(lanePath, 'target', 'out'), 'built\n');
    expect((await h.manager.slim({ worktreeId: 'job-target', idle: () => null })).status).toBe('slimmed');

    const [outcome] = await h.manager.ensureReady('job-target');

    expect(outcome).toEqual({ id: 'job-target', status: 'rehydrated', ms: expect.any(Number), notRecreated: ['target'] });
    expect(payloadOf(events(h, 'worktree.rehydrated')[0])).toEqual({ id: 'job-target', ms: expect.any(Number), not_recreated: ['target'] });
    expect(events(h, 'worktree.rehydrate-failed')).toHaveLength(0);
    expect(h.manager.isSlim('job-target')).toBe(false);
    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);

    // The next verify builds it again, and the next slim takes it again.
    mkdirSync(join(lanePath, 'target'));
    writeFileSync(join(lanePath, 'target', 'out'), 'built\n');
    const again = await h.manager.slim({ worktreeId: 'job-target', idle: () => null });
    expect(again.status).toBe('slimmed');
    expect(again.status === 'slimmed' ? again.entries.map((entry) => entry.path) : []).toEqual(['target', 'node_modules']);
    expect(again.skipped).toEqual([]);
  });

  it('a restore whose setup succeeds without recreating what it made at bootstrap (a make-style stamp outside reclaim) is a failed restore: the lane stays slim, Gru gets one row, and the lane is never slimmed again', async () => {
    const stamped = '[ -e deps.stamp ] || { mkdir -p node_modules/pkg && echo stamped > node_modules/pkg/index.js && touch deps.stamp; }';
    const h = harness({ gitignore: `${IGNORED}deps.stamp\n`, manifest: ['reclaim = ["node_modules"]', '', '[[setup]]', `command = "${stamped}"`, ''].join('\n') });
    addJob(h, 'job-stamped');
    const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: 'job-stamped' });
    expect(payloadOf(events(h, 'worktree.bootstrapped')[0])).toEqual({ id: 'job-stamped', manifest_blob: manifestBlob(h), setup_made: ['node_modules'] });
    h.ledger.setJobStatus('job-stamped', 'delivered');
    expect((await h.manager.slim({ worktreeId: 'job-stamped', idle: () => null })).status).toBe('slimmed');
    const rows = (): ReturnType<LedgerApi['listNotifications']> => h.ledger.listNotifications({ limit: 50 }).filter((row) => row.kind === 'worktree.restore-incomplete');

    for (let turn = 0; turn < 2; turn += 1) {
      const [outcome] = await h.manager.ensureReady('job-stamped');
      expect(outcome).toMatchObject({ status: 'rehydrate-failed', error: expect.stringMatching(/^setup did not recreate node_modules, which it made when the lane was bootstrapped/u) });
    }

    expect(h.manager.isSlim('job-stamped')).toBe(true);
    expect(payloadOf(events(h, 'worktree.rehydrate-failed')[0])).toMatchObject({ id: 'job-stamped', manifest: manifestBlob(h), missing: ['node_modules'], reason: 'setup-incomplete' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ routing: 'action-required', resolvedAt: null });
    expect(rows()[0]!.detail).toContain('a stamp file outside reclaim');
    // The minion rebuilds what is missing: the next restore succeeds, and the lane is never slimmed again.
    rmSync(join(lane.path, 'deps.stamp'));
    expect((await h.manager.ensureReady('job-stamped'))[0]).toMatchObject({ status: 'rehydrated', notRecreated: [] });
    expect(await h.manager.slim({ worktreeId: 'job-stamped', idle: () => null })).toMatchObject({ status: 'not-slimmed', permanent: true, reason: expect.stringMatching(/never slimmed again/u) });
    expect(readFileSync(join(lane.path, 'node_modules', 'pkg', 'index.js'), 'utf-8')).toBe('stamped\n');
    // The lane's release closes the row.
    expect((await h.manager.release({ worktreeId: 'job-stamped' })).status).toBe('swept');
    expect(rows()[0]!.resolvedAt).not.toBeNull();
  });

  it('never slims a lane with no bootstrap record (one made before GC recorded what its setup makes)', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-old-lane');
    h.db.handle.prepare("DELETE FROM events WHERE kind = 'worktree.bootstrapped'").run();

    expect(await h.manager.slim({ worktreeId: 'job-old-lane', idle: () => null })).toEqual({
      status: 'not-slimmed',
      reason: 'the lane has no bootstrap record (it was made before GC recorded what its setup makes), so a restore could not tell what it must bring back',
      permanent: true,
      planned: false,
      skipped: [],
    });
    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  });

  it('a failed restore whose error ends in one unbroken line longer than the kept tail (no word to start at) records a note that the line is not shown, never a fragment of it', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-token');
    expect((await h.manager.slim({ worktreeId: 'job-token', idle: () => null })).status).toBe('slimmed');
    // One unbroken 10 KiB token: a minified line, a base64 blob, a long path.
    writeFileSync(join(lanePath, 'long-line.txt'), `${'Q'.repeat(10 * 1024)}\n`);

    const [outcome] = await h.manager.ensureReady('job-token');

    expect(outcome).toMatchObject({ status: 'rehydrate-failed' });
    const recorded = String(payloadOf(events(h, 'worktree.rehydrate-failed')[0])['error']);
    expect(recorded).toMatch(/^worktree setup command exited 1: .*\noutput tail:\n\(last line longer than \d KiB, not shown\)\n$/u);
    expect(recorded).not.toContain('QQQQ');
    expect(Buffer.byteLength(recorded, 'utf8')).toBeLessThanOrEqual(4 * 1024);
  });

  it('a slim recorded without a manifest blob (an earlier build) still restores, from the manifest the lane was built from, with a warn', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-legacy');
    rmSync(join(lanePath, 'node_modules'), { recursive: true, force: true });
    h.ledger.appendCustomEvent({ kind: 'worktree.slimmed', jobId: 'job-legacy', payload: { id: 'job-legacy', entries: [{ path: 'node_modules', bytes: 4096 }], freed_bytes: 4096, skipped: [] } });
    expect(h.manager.isSlim('job-legacy')).toBe(true);

    const [outcome] = await h.manager.ensureReady('job-legacy');

    expect(outcome).toMatchObject({ status: 'rehydrated', notRecreated: [] });
    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(h.manager.isSlim('job-legacy')).toBe(false);
    expect(h.logs.filter((line) => line.level === 'warn').map((line) => line.msg)).toContain('slim record names no manifest blob; restoring from the manifest the lane was built from');
  });

  it('a stop or cancel of the turn ends a restore\'s setup process group, and the lane stays slim', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-stopped');
    expect((await h.manager.slim({ worktreeId: 'job-stopped', idle: () => null })).status).toBe('slimmed');
    writeFileSync(join(lanePath, 'slow-setup'), '');
    const gate = restoringGate(h);
    const cancel = new AbortController();

    const turn = gate.acquireWorkerTurn({ id: 'job-stopped', label: 'a cancelled turn', jobId: 'job-stopped', signal: cancel.signal });
    await vi.waitFor(() => expect(existsSync(join(lanePath, 'setup.pid'))).toBe(true), { timeout: 10_000 });
    const pid = Number(readFileSync(join(lanePath, 'setup.pid'), 'utf-8').trim());
    const started = Date.now();
    cancel.abort();
    const lease = await turn;

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(() => process.kill(-pid, 0)).toThrow();
    expect(String(payloadOf(events(h, 'worktree.rehydrate-failed')[0])['error'])).toMatch(/stopped/u);
    expect(h.manager.isSlim('job-stopped')).toBe(true);
    lease.release();
  }, 30_000);

  it('cancelling a verification while it restores a slim lane ends setup\'s process group and releases the slot', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-verify-cancel');
    expect((await h.manager.slim({ worktreeId: 'job-verify-cancel', idle: () => null })).status).toBe('slimmed');
    writeFileSync(join(lanePath, 'slow-setup'), '');
    const { server, verify } = await verifyServer(h);

    const run = verify('job-verify-cancel').catch(() => []);
    await vi.waitFor(() => expect(existsSync(join(lanePath, 'setup.pid'))).toBe(true), { timeout: 10_000 });
    const pid = Number(readFileSync(join(lanePath, 'setup.pid'), 'utf-8').trim());
    expect(server.jobHasRun('job-verify-cancel')).toBe(true);
    const started = Date.now();
    await server.dispose();

    await vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow(), { timeout: 10_000 });
    await vi.waitFor(() => expect(server.jobHasRun('job-verify-cancel')).toBe(false), { timeout: 10_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(String(payloadOf(events(h, 'worktree.rehydrate-failed')[0])['error'])).toMatch(/stopped/u);
    expect(h.manager.isSlim('job-verify-cancel')).toBe(true);
    await run;
    // The run's command never started: it settled as a no-start.
    expect(events(h, 'verification.started')).toHaveLength(0);
    expect(events(h, 'verification.no-start')).toHaveLength(1);
  }, 30_000);

  it('the service\'s stop ends a provider continuation\'s restore (its setup process group) and the continuation: nothing is spawned or prompted', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-recovery-stop');
    expect((await h.manager.slim({ worktreeId: 'job-recovery-stop', idle: () => null })).status).toBe('slimmed');
    writeFileSync(join(lanePath, 'slow-setup'), '');
    h.ledger.registerAgent({ id: 'agent-job-recovery-stop', role: 'minion', jobId: 'job-recovery-stop' });
    const waitId = recordWait(h, 'job-recovery-stop', { recovered: true });
    let prompts = 0;
    let spawns = 0;
    const handle = {
      id: 'minion-recovery-stop',
      sessionFile: null,
      prompt: async () => { prompts += 1; },
      health: () => ({ state: 'idle', lastActivity: new Date().toISOString(), sessionFile: null }),
      subscribe: () => () => {},
      dispose: async () => {},
    } as unknown as AgentHandle;
    // The factory's continuation hook, as main.ts wires it: its stop is the
    // one the harness gave the factory (the service's, in main.ts).
    const deps: RecoveryClaimDeps = {
      registry: { getHandle: () => null, spawn: async () => { spawns += 1; return handle; }, disposeHandle: async () => {} } as unknown as RecoveryClaimDeps['registry'],
      ledger: h.ledger,
      worktrees: h.manager,
      ensureReady: h.hooks.beforeContinuation,
    };

    const claim = claimProviderRecoveryContinuation(deps, waitId, 'silas');
    await vi.waitFor(() => expect(existsSync(join(lanePath, 'setup.pid'))).toBe(true), { timeout: 10_000 });
    const pid = Number(readFileSync(join(lanePath, 'setup.pid'), 'utf-8').trim());
    const started = Date.now();
    h.stop.abort();

    expect(await claim).toMatchObject({ outcome: 'skipped', why: expect.stringMatching(/the service stopped before the continuation spawned/u) });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(() => process.kill(-pid, 0)).toThrow();
    expect(spawns).toBe(0);
    expect(prompts).toBe(0);
    expect(String(payloadOf(events(h, 'worktree.rehydrate-failed')[0])['error'])).toMatch(/stopped/u);
    expect(payloadOf(events(h, 'provider.continuation-failed')[0])).toMatchObject({ wait_id: waitId, stage: 'authorization', error: expect.stringMatching(/the service is stopping/u) });
  }, 30_000);

  it('POST /api/verify on a slim lane restores it inside its verification slot, then runs', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-verify');
    expect((await h.manager.slim({ worktreeId: 'job-verify', idle: () => null })).status).toBe('slimmed');
    const { verify } = await verifyServer(h);

    const frames = await verify('job-verify');

    const completed = frames.find((frame) => frame.type === 'completed');
    expect((completed?.['outcome'] as Record<string, unknown> | undefined)?.['exitCode']).toBe(0);
    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    const rehydrated = events(h, 'worktree.rehydrated')[0]!;
    expect(rehydrated.seq).toBeGreaterThan(events(h, 'verification.requested')[0]!.seq);
    expect(rehydrated.seq).toBeLessThan(events(h, 'verification.started')[0]!.seq);
  });

  it('two verifications of slim lanes with max_concurrent = 1 restore one at a time, and a slim tried during a restore is refused as busy', async () => {
    const h = harness();
    const first = await deliveredReportLane(h, 'job-v1');
    const second = await deliveredReportLane(h, 'job-v2');
    for (const jobId of ['job-v1', 'job-v2']) expect((await h.manager.slim({ worktreeId: jobId, idle: () => null })).status).toBe('slimmed');
    const gate = restoringGate(h);
    const hold = deferred();
    const entered: string[] = [];
    let inside = 0;
    let most = 0;
    const firstRestored = deferred();
    const { server, verify } = await verifyServer(h, async (jobId) => {
      entered.push(jobId);
      inside += 1;
      most = Math.max(most, inside);
      await h.manager.ensureReady(jobId);
      if (jobId === 'job-v1') {
        firstRestored.resolve();
        await hold.promise;
      }
      inside -= 1;
    });
    const timers: { tick?: () => void } = {};
    const slimmer = slimmerFor(h, gate, { verificationBusy: (jobId) => server.jobHasRun(jobId), timers });

    const runOne = verify('job-v1');
    await firstRestored.promise;
    const runTwo = verify('job-v2');
    await vi.waitFor(() => expect(server.view().queuedRuns).toBe(1), { timeout: 10_000 });
    expect(entered).toEqual(['job-v1']);
    // The first lane is restored and its run holds the slot: a slim now is refused as busy.
    expect(server.jobHasRun('job-v1')).toBe(true);
    slimmer.start();
    await slimmer.idle();
    expect(existsSync(join(first, 'node_modules', 'pkg', 'index.js'))).toBe(true);

    hold.resolve();
    const [framesOne, framesTwo] = await Promise.all([runOne, runTwo]);

    expect(most).toBe(1);
    expect(entered).toEqual(['job-v1', 'job-v2']);
    for (const frames of [framesOne, framesTwo]) {
      expect((frames.find((frame) => frame.type === 'completed')?.['outcome'] as Record<string, unknown> | undefined)?.['exitCode']).toBe(0);
    }
    expect(existsSync(join(second, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  });

  it('a turn granted while the slim holds the lane lock waits for it, then runs setup before its lease is handed over', async () => {
    const h = harness();
    const lanePath = await deliveredReportLane(h, 'job-race');
    const gate = restoringGate(h);
    const order: string[] = [];
    let turn = null as Promise<PacingLease> | null;

    const slim = h.manager.slim({
      worktreeId: 'job-race',
      idle: () => {
        // Idle at the check; a turn is granted right after it, mid-slim.
        turn = gate.acquireWorkerTurn({ id: 'job-race', label: 'racing turn', jobId: 'job-race' });
        void turn.then(() => order.push('turn'));
        return null;
      },
    }).then((result) => { order.push('slim'); return result; });

    expect(gate.workerTurnsFor('job-race')).toEqual({ held: 0, queued: 0 });
    expect((await slim).status).toBe('slimmed');
    const lease = await turn!;
    expect(order).toEqual(['slim', 'turn']);
    expect(existsSync(join(lanePath, 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(setupRuns(lanePath)).toBe(2);
    expect(events(h, 'worktree.rehydrated')[0]!.seq).toBeGreaterThan(events(h, 'worktree.slimmed')[0]!.seq);
    expect(gate.workerTurnsFor('job-race')).toEqual({ held: 1, queued: 0 });
    lease.release();
    expect(gate.workerTurnsFor('job-race')).toEqual({ held: 0, queued: 0 });
  });
});
