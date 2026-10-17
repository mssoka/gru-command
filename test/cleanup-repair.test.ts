import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESET_KEEPS, runResetCli, type ResetCliDeps } from '../src/cli/reset.js';
import { runServiceCli } from '../src/cli/service.js';
import { loadConfig } from '../src/config.js';
import { routeFixDirectiveToMinion } from '../src/dispatch/fix-directive.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type EventRecord, type NotificationRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { LogLevel } from '../src/logger.js';
import {
  EXPIRY_EVENTS,
  EXPIRY_RECONCILE_INTERVAL_MS,
  ExpiryService,
  PRESERVE_EXPIRY_KIND,
  PRESERVE_EXPIRY_MS,
  PRESERVE_REPROPOSE_MS,
  REVIEW_EXPIRY_MS,
} from '../src/maintenance/expiry.js';
import { REPO_MISMATCH_KIND, RepoMoveReconciler } from '../src/maintenance/repo-moves.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { ownerAttentionFor, requiresTypedDecision } from '../src/notifications/attention.js';
import { PacingGate } from '../src/runtime/pacing.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { captureCwdHandoff, WorktreeHandoffUnresolvedError } from '../src/worktrees/handoff.js';
import { PRESERVED_REF_PREFIX, REPO_IDENTITY_EVENT, WorktreeManager } from '../src/worktrees/manager.js';
import { laneLifecycleHooks } from '../src/worktrees/slimming.js';

/**
 * Cleanup and repair (#427 PR 2b), over real git fixtures and a real
 * ledger:
 *
 * - review folders of a job terminal for 14 days are deleted automatically
 *   and recorded (`reviews.expired`); an open job's are kept;
 * - preserve copies and snapshot refs of lanes whose job ended 30 days ago
 *   are proposed in one FOR YOU card per repository; Accept deletes exactly
 *   what it listed, Decline is proposed again 30 days later;
 * - a lane whose repository moved is reconnected (`git worktree repair`,
 *   its registry `repo_path` and its handoff follow), and a lane whose
 *   repository's name now holds a different repository is proposed for
 *   discard;
 * - `gru-service reset` refuses while the service runs and otherwise removes
 *   every GC lane and empties the data directory, keeping the config.
 */

const IDENTITY = ['-c', 'user.name=Cleanup Tests', '-c', 'user.email=cleanup@example.invalid'];
const DAY = 24 * 60 * 60_000;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // gone already
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A repository at `<workspace>/<name>` with one commit on main (its
 * README `readme`: two repositories made in the same second with the same
 * one share their root commit); with a bare origin it has pushed main to
 * (its URL `origin`, or a new one). */
function repoIn(workspace: string, name: string, opts: { readonly origin?: string | true; readonly readme?: string } = {}): string {
  const path = join(workspace, name);
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  writeFileSync(join(path, 'README.md'), opts.readme ?? `# ${name}\n`);
  git(path, ['add', '.']);
  git(path, ['commit', '-qm', `${name}: first`]);
  if (opts.origin !== undefined) {
    const origin = opts.origin === true ? join(tempDir('gru-cleanup-origin-'), `${name}.git`) : opts.origin;
    if (!existsSync(origin)) git(dirname(origin), ['init', '-q', '--bare', '-b', 'main', origin]);
    git(path, ['remote', 'add', 'origin', origin]);
    git(path, ['push', '-q', 'origin', 'main']);
  }
  return path;
}

type LogCall = { readonly level: LogLevel; readonly msg: string; readonly fields?: Record<string, unknown> };

interface Harness {
  readonly db: LedgerDb;
  readonly ledger: LedgerApi;
  readonly bus: EventBus;
  readonly notifications: NotificationCenter;
  readonly dataDir: string;
  readonly lanesRoot: string;
  readonly preserveRoot: string;
  readonly logs: LogCall[];
  /** A worktree manager over the harness's ledger (a new one is a service start). */
  manager(): WorktreeManager;
}

function harness(): Harness {
  const dataDir = tempDir('gru-cleanup-data-');
  const db = new LedgerDb(dataDir);
  cleanups.push(() => db.close());
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const lanesRoot = tempDir('gru-cleanup-lanes-');
  const preserveRoot = tempDir('gru-cleanup-preserve-');
  const logs: LogCall[] = [];
  const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => { logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); };
  return {
    db, ledger, bus, notifications, dataDir, lanesRoot, preserveRoot, logs,
    manager: () => new WorktreeManager({ ledger, root: lanesRoot, preserveRoot, setupTimeoutMs: 30_000, killGraceMs: 25, enumerateProcesses: () => [], log }),
  };
}

/** Fake only `Date` (the ledger's event times), at `at`; timers stay real. */
function dateAt(at: number): void {
  vi.useFakeTimers({ toFake: ['Date'], now: at });
  cleanups.push(() => { vi.useRealTimers(); });
}

function addJob(h: Harness, id: string, repo = 'app'): void {
  h.ledger.addJob({ id, repo, title: `job ${id}` });
  h.ledger.setJobStatus(id, 'working');
}

function events(h: Harness, kind: string): readonly EventRecord[] {
  return h.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind === kind).reverse();
}

function payloadOf(event: EventRecord | undefined): Record<string, unknown> {
  return (event?.payload ?? {}) as Record<string, unknown>;
}

function openCards(h: Harness, kind: string): readonly NotificationRecord[] {
  return h.ledger.listOpenNotificationsByKinds([kind]);
}

function expiry(h: Harness, now: () => number): ExpiryService {
  const service = new ExpiryService({
    ledger: h.ledger,
    bus: h.bus,
    notifications: h.notifications,
    reviewsRoot: join(h.dataDir, 'reviews'),
    preserveRoot: h.preserveRoot,
    now,
    log: (level, msg, fields) => { h.logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); },
    setInterval: ((_callback: () => void, ms: number) => {
      expect(ms).toBe(EXPIRY_RECONCILE_INTERVAL_MS);
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
  });
  cleanups.push(() => service.stop());
  return service;
}

function folder(path: string, bytes = 4096): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'consolidated.json'), `${'x'.repeat(bytes)}\n`);
}

function preservedRefs(repoPath: string): string[] {
  return git(repoPath, ['for-each-ref', '--format=%(refname)', PRESERVED_REF_PREFIX]).split('\n').filter((ref) => ref !== '');
}

/** A job lane released with a tracked edit (a snapshot ref) and an untracked
 * file (a preserve copy), then the job done at `endedAt`. */
async function releasedLane(h: Harness, manager: WorktreeManager, repoPath: string, jobId: string, endedAt: number): Promise<{ readonly copy: string; readonly ref: string }> {
  addJob(h, jobId);
  const lane = await manager.createJobWorktree({ repoPath, jobId });
  writeFileSync(join(lane.path, 'README.md'), `an edit of ${jobId}\n`);
  writeFileSync(join(lane.path, 'notes.txt'), `notes of ${jobId}\n`);
  const result = await manager.release({ worktreeId: jobId });
  expect(result.status).toBe('swept');
  dateAt(endedAt);
  h.ledger.setJobStatus(jobId, 'done');
  vi.useRealTimers();
  const copy = result.preserved!.destination;
  const ref = preservedRefs(repoPath).find((name) => name.startsWith(`${PRESERVED_REF_PREFIX}/${jobId}/`))!;
  expect(existsSync(copy)).toBe(true);
  expect(ref).toBeDefined();
  return { copy, ref };
}

describe('review artifacts expire 14 days after their job ends (#427 PR 2b)', () => {
  it('deletes the round and fallback-gate folders of a job merged 20 days ago and records reviews.expired; an open job\'s folders, a job ended 10 days ago, and another job\'s look-alike fallback-gate folder are kept', async () => {
    const h = harness();
    const reviews = join(h.dataDir, 'reviews');
    const t0 = Date.now();
    dateAt(t0);
    addJob(h, 'job-merged');
    const rounds = [1, 2, 3].map(() => h.ledger.addRound({ jobId: 'job-merged' }).id).sort();
    h.ledger.setJobStatus('job-merged', 'in-review');
    h.ledger.setJobStatus('job-merged', 'merged');
    addJob(h, 'job-open');
    const openRound = h.ledger.addRound({ jobId: 'job-open' }).id;
    addJob(h, 'job-merged-2');
    addJob(h, 'job-recent');
    const recentRound = h.ledger.addRound({ jobId: 'job-recent' }).id;
    vi.setSystemTime(t0 + 10 * DAY);
    h.ledger.setJobStatus('job-recent', 'done');
    vi.useRealTimers();
    for (const round of [...rounds, openRound, recentRound]) folder(join(reviews, round));
    folder(join(reviews, 'fallback-gate', 'job-merged-1700000000000-abc123'));
    folder(join(reviews, 'fallback-gate', 'job-merged-2-1700000000000-x1y2z3'));
    folder(join(reviews, 'fallback-gate', 'job-open-1700000000000-q9'));
    writeFileSync(join(reviews, '.review-capture-state.json'), '{"rounds":[]}\n');

    await expiry(h, () => t0 + 20 * DAY).reconcile();

    for (const round of rounds) expect(existsSync(join(reviews, round))).toBe(false);
    expect(existsSync(join(reviews, 'fallback-gate', 'job-merged-1700000000000-abc123'))).toBe(false);
    expect(existsSync(join(reviews, openRound))).toBe(true);
    expect(existsSync(join(reviews, recentRound))).toBe(true);
    expect(existsSync(join(reviews, 'fallback-gate', 'job-merged-2-1700000000000-x1y2z3'))).toBe(true);
    expect(existsSync(join(reviews, 'fallback-gate', 'job-open-1700000000000-q9'))).toBe(true);
    expect(existsSync(join(reviews, '.review-capture-state.json'))).toBe(true);
    const expired = events(h, EXPIRY_EVENTS.reviewsExpired);
    expect(expired).toHaveLength(1);
    expect(expired[0]!.jobId).toBe('job-merged');
    expect(payloadOf(expired[0])).toEqual({ job_id: 'job-merged', rounds, fallback_gates: ['job-merged-1700000000000-abc123'], bytes: expect.any(Number) });
    expect(payloadOf(expired[0])['bytes']).toBeGreaterThanOrEqual(4 * 4096);

    // A later pass finds nothing more of it, and the recent job expires on its own day.
    await expiry(h, () => t0 + 10 * DAY + REVIEW_EXPIRY_MS + 1).reconcile();
    expect(existsSync(join(reviews, recentRound))).toBe(false);
    expect(events(h, EXPIRY_EVENTS.reviewsExpired).map((event) => event.jobId)).toEqual(['job-merged', 'job-recent']);
    expect(existsSync(join(reviews, openRound))).toBe(true);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('a delete that fails is retried at the next reconcile, and only what was deleted is recorded', async () => {
    const h = harness();
    const reviews = join(h.dataDir, 'reviews');
    addJob(h, 'job-locked');
    const round = h.ledger.addRound({ jobId: 'job-locked' }).id;
    h.ledger.setJobStatus('job-locked', 'done');
    folder(join(reviews, round));
    chmodSync(reviews, 0o500);
    cleanups.push(() => { if (existsSync(reviews)) chmodSync(reviews, 0o700); });
    const service = expiry(h, () => Date.now() + REVIEW_EXPIRY_MS + DAY);

    await service.reconcile();

    expect(existsSync(join(reviews, round))).toBe(true);
    expect(events(h, EXPIRY_EVENTS.reviewsExpired)).toEqual([]);
    expect(h.logs.some((log) => log.level === 'warn' && log.msg.includes('could not be deleted'))).toBe(true);

    chmodSync(reviews, 0o700);
    await service.reconcile();

    expect(existsSync(join(reviews, round))).toBe(false);
    expect(events(h, EXPIRY_EVENTS.reviewsExpired).map((event) => payloadOf(event)['rounds'])).toEqual([[round]]);
  });
});

describe('saved work of jobs ended 30 days ago is proposed, never deleted on its own (#427 PR 2b)', () => {
  it('posts one typed FOR YOU card per repository listing each expired preserve copy and snapshot ref with its size and restore command; a lane whose job ended 10 days ago is not listed', async () => {
    const h = harness();
    const workspace = tempDir('gru-cleanup-ws-');
    const app = repoIn(workspace, 'app');
    const api = repoIn(workspace, 'api');
    const manager = h.manager();
    const t0 = Date.now();
    const old = await releasedLane(h, manager, app, 'job-old', t0);
    const other = await releasedLane(h, manager, api, 'job-api', t0);
    const recent = await releasedLane(h, manager, app, 'job-new', t0 + 30 * DAY);

    await expiry(h, () => t0 + 40 * DAY).reconcile();

    const cards = openCards(h, PRESERVE_EXPIRY_KIND);
    expect(cards).toHaveLength(2);
    expect(ownerAttentionFor(PRESERVE_EXPIRY_KIND)).toBe('owner-required');
    expect(requiresTypedDecision(PRESERVE_EXPIRY_KIND)).toBe(true);
    const appCard = cards.find((card) => card.title.endsWith(' app'))!;
    expect(appCard.routing).toBe('needs-owner');
    expect(appCard.decision?.reservedClass).toBe('destructive');
    expect(appCard.decision?.options.map((option) => option.id)).toEqual(['accept', 'decline']);
    expect(appCard.detail).toContain(old.copy);
    expect(appCard.detail).toContain(`cp -R ${old.copy}/. ${app}`);
    expect(appCard.detail).toContain(old.ref);
    expect(appCard.detail).toContain(`git -C ${app} cherry-pick --no-commit ${old.ref}`);
    expect(appCard.detail).toMatch(/\(lane job-old, \d+(\.\d)? (B|KB)\)/u);
    expect(appCard.detail).not.toContain(recent.copy);
    expect(appCard.detail).not.toContain(recent.ref);
    expect(appCard.detail).not.toContain(other.ref);
    const proposed = events(h, EXPIRY_EVENTS.preservesProposed).map(payloadOf);
    expect(proposed.find((payload) => payload['repo_path'] === app)).toMatchObject({
      notification_id: appCard.id,
      proposal: 1,
      copies: [{ lane: 'job-old', path: old.copy, bytes: expect.any(Number) }],
      refs: [{ lane: 'job-old', ref: old.ref, sha: git(app, ['rev-parse', old.ref]), bytes: expect.any(Number) }],
    });
    // Nothing is deleted before an answer, and a second pass posts no second card.
    await expiry(h, () => t0 + 41 * DAY).reconcile();
    expect(openCards(h, PRESERVE_EXPIRY_KIND)).toHaveLength(2);
    expect(existsSync(old.copy)).toBe(true);
    expect(preservedRefs(app)).toContain(old.ref);
  });

  it('Accept deletes exactly the listed copies and refs and nothing else: work that expired after the card, and a ref moved since, are kept', async () => {
    const h = harness();
    const workspace = tempDir('gru-cleanup-ws-');
    const app = repoIn(workspace, 'app');
    const manager = h.manager();
    const t0 = Date.now();
    const first = await releasedLane(h, manager, app, 'job-a', t0);
    const second = await releasedLane(h, manager, app, 'job-b', t0);
    const later = await releasedLane(h, manager, app, 'job-c', t0 + 20 * DAY);
    const service = expiry(h, () => t0 + 40 * DAY);
    await service.reconcile();
    const [card] = openCards(h, PRESERVE_EXPIRY_KIND);
    expect(card).toBeDefined();
    expect(card!.detail).not.toContain(later.copy);
    // Since the card: job-b's ref moved to another commit.
    git(app, ['update-ref', second.ref, 'main']);

    h.notifications.decide(card!.id, 'accept', 'owner');
    await service.reconcile();

    expect(h.ledger.getNotification(card!.id)?.resolvedAt).not.toBeNull();

    expect(existsSync(first.copy)).toBe(false);
    expect(existsSync(second.copy)).toBe(false);
    expect(preservedRefs(app)).not.toContain(first.ref);
    expect(preservedRefs(app)).toContain(second.ref);
    expect(existsSync(later.copy)).toBe(true);
    expect(preservedRefs(app)).toContain(later.ref);
    const deleted = payloadOf(events(h, EXPIRY_EVENTS.preservesDeleted)[0]);
    expect(deleted).toMatchObject({ notification_id: card!.id, copies: [first.copy, second.copy], refs: [first.ref] });
    expect(deleted['kept']).toEqual([{ item: second.ref, reason: expect.stringContaining('not the listed') }]);
    expect(h.ledger.getNotification(card!.id)?.decidedOption).toBe('accept');
    // The moved ref is not what the owner accepted: it is proposed again
    // as it is now, and job-c's work, not yet expired, is not.
    const next = openCards(h, PRESERVE_EXPIRY_KIND);
    expect(next).toHaveLength(1);
    expect(next[0]!.detail).toContain(`${second.ref} at ${git(app, ['rev-parse', 'main']).slice(0, 12)}`);
    expect(next[0]!.detail).not.toContain(later.copy);
    expect(next[0]!.detail).not.toContain(later.ref);
  });

  it('Decline keeps everything and closes the card; GC proposes again 30 days later, not before', async () => {
    const h = harness();
    const workspace = tempDir('gru-cleanup-ws-');
    const app = repoIn(workspace, 'app');
    const manager = h.manager();
    const t0 = Date.now();
    const saved = await releasedLane(h, manager, app, 'job-kept', t0);
    await expiry(h, () => t0 + 40 * DAY).reconcile();
    const [card] = openCards(h, PRESERVE_EXPIRY_KIND);

    dateAt(t0 + 40 * DAY);
    h.notifications.decide(card!.id, 'decline', 'owner');
    vi.useRealTimers();
    await expiry(h, () => t0 + 40 * DAY).reconcile();

    expect(h.ledger.getNotification(card!.id)?.resolvedAt).not.toBeNull();
    expect(existsSync(saved.copy)).toBe(true);
    expect(preservedRefs(app)).toContain(saved.ref);
    expect(events(h, EXPIRY_EVENTS.preservesDeclined)).toHaveLength(1);
    const declinedAt = Date.parse(h.ledger.getNotification(card!.id)!.decidedAt!);
    await expiry(h, () => declinedAt + PRESERVE_REPROPOSE_MS - DAY).reconcile();
    expect(openCards(h, PRESERVE_EXPIRY_KIND)).toEqual([]);

    await expiry(h, () => declinedAt + PRESERVE_REPROPOSE_MS + DAY).reconcile();

    const again = openCards(h, PRESERVE_EXPIRY_KIND);
    expect(again).toHaveLength(1);
    expect(again[0]!.id).not.toBe(card!.id);
    expect(again[0]!.detail).toContain(saved.copy);
    expect(again[0]!.detail).toContain(saved.ref);
    expect(PRESERVE_EXPIRY_MS).toBe(30 * DAY);
  });
});

describe('a moved repository\'s lanes are repaired by identity (#427 PR 2b)', () => {
  it('a managed repository moved to a new workspace root, config updated: at start its lane is reconnected with git worktree repair, its repo_path moves, worktree.repo-moved is recorded, and a turn, a restore and a release in it succeed', async () => {
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app', { origin: true });
    addJob(h, 'job-moved');
    const lane = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-moved' });
    expect(payloadOf(events(h, REPO_IDENTITY_EVENT)[0])).toEqual({ id: 'job-moved', repo_path: app, roots: [git(app, ['rev-list', '--max-parents=0', 'HEAD'])], origin: git(app, ['remote', 'get-url', 'origin']) });
    writeFileSync(join(lane.path, 'work.txt'), 'uncommitted work\n');
    const after = tempDir('gru-cleanup-ws-src-');
    renameSync(app, join(after, 'app'));
    const moved = join(after, 'app');
    // Before the repair the lane is unusable: git and the turn's custody both refuse.
    expect(() => git(lane.path, ['status'])).toThrow();
    expect(() => captureCwdHandoff(lane.path)).toThrow(WorktreeHandoffUnresolvedError);

    const manager = h.manager();
    // Not a managed name, or a workspace root that does not hold it: only logged, nothing changes.
    expect(manager.checkMovedRepositories({ managedRepos: [], resolve: () => ({ kind: 'available', path: moved }) }).map((outcome) => outcome.status)).toEqual(['unresolved']);
    expect(new RepoMoveReconciler({ worktrees: manager, ledger: h.ledger, bus: h.bus, notifications: h.notifications, workspaceRoot: before, managedRepos: ['app'] }).check().map((outcome) => outcome.status)).toEqual(['unresolved']);
    expect(h.ledger.getWorktree('job-moved')?.repoPath).toBe(app);
    expect(h.logs.filter((log) => log.msg.includes('cannot be reconnected now'))).toHaveLength(2);

    const outcomes = new RepoMoveReconciler({ worktrees: manager, ledger: h.ledger, bus: h.bus, notifications: h.notifications, workspaceRoot: after, managedRepos: ['app'] }).check();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['repaired']);
    expect(h.ledger.getWorktree('job-moved')?.repoPath).toBe(moved);
    expect(events(h, 'worktree.repo-moved').map(payloadOf)).toEqual([{ id: 'job-moved', from: app, to: moved }]);
    expect(events(h, 'worktree.handoff-rebound')).toHaveLength(1);
    expect(openCards(h, REPO_MISMATCH_KIND)).toEqual([]);
    expect(git(lane.path, ['status', '--porcelain'])).toContain('work.txt');
    expect(() => captureCwdHandoff(lane.path)()).not.toThrow();
    // A turn through the real directive route, its restore included.
    const hooks = laneLifecycleHooks({ manager: () => manager, notifications: h.notifications, ledger: h.ledger, stopSignal: new AbortController().signal });
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 0, maxConcurrentReviewTurns: 0, prepareWorkerTurn: hooks.beforeWorkerTurn });
    let prompts = 0;
    const handle = { id: 'minion-job-moved', prompt: async () => { prompts += 1; } } as unknown as AgentHandle;
    const routed = await routeFixDirectiveToMinion({
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
      ledger: {
        listImplementerMinions: () => [{ id: handle.id, jobId: 'job-moved', role: 'minion' } as unknown as ReturnType<LedgerApi['listImplementerMinions']>[number]],
        listAgents: () => [],
        registerAgent: (() => undefined) as unknown as LedgerApi['registerAgent'],
        getJob: (id: string) => h.ledger.getJob(id),
        getAgent: () => null,
      },
      worktrees: manager,
      jobId: 'job-moved',
      directive: 'carry on',
      signal: new AbortController().signal,
      workerGate: gate,
    });
    expect(routed).toMatchObject({ delivered: true });
    expect(prompts).toBe(1);
    git(lane.path, ['add', 'work.txt']);
    git(lane.path, ['commit', '-qm', 'work after the move']);
    expect(await manager.ensureReady('job-moved')).toEqual([{ id: 'job-moved', status: 'ready' }]);
    const released = await manager.release({ worktreeId: 'job-moved' });
    expect(released.status).toBe('swept');
    expect(existsSync(lane.path)).toBe(false);
    expect(git(moved, ['worktree', 'list', '--porcelain'])).not.toContain(lane.path);
    // A second check has nothing to do.
    expect(manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: moved }) })).toEqual([]);
  });

  it('a repair stopped between its record and its receipt is finished by the next check, and a lane made before identities were recorded is matched by its base commit', async () => {
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app');
    addJob(h, 'job-legacy');
    const lane = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-legacy' });
    // As a ledger written before identities were recorded.
    h.db.handle.prepare('DELETE FROM events WHERE kind = ?').run(REPO_IDENTITY_EVENT);
    const after = tempDir('gru-cleanup-ws-src-');
    renameSync(app, join(after, 'app'));
    const moved = join(after, 'app');
    const manager = h.manager();
    const receiptFile = join(moved, '.git', 'worktrees', basename(lane.path), 'gru-creation-handoff.json');
    const receipt = (): string => readFileSync(receiptFile, 'utf-8');
    const original = receipt();

    const outcomes = manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: moved }) });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['repaired']);
    expect(receipt()).not.toBe(original);
    // A stop before the receipt was published: put the old receipt back.
    writeFileSync(receiptFile, original);
    expect(() => captureCwdHandoff(lane.path)).toThrow(WorktreeHandoffUnresolvedError);

    expect(manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: moved }) })).toEqual([]);

    expect(receipt()).not.toBe(original);
    expect(() => captureCwdHandoff(lane.path)()).not.toThrow();
    expect(h.logs.some((log) => log.msg.includes('re-bound handoff receipt was published'))).toBe(true);
  });

  it('the name now resolves to a different repository: one FOR YOU discard card; Decline keeps the lane and asks no more, Accept deletes the lane and marks it swept', async () => {
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app');
    addJob(h, 'job-kept');
    addJob(h, 'job-gone');
    const kept = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-kept' });
    const gone = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-gone' });
    rmSync(app, { recursive: true, force: true });
    const after = tempDir('gru-cleanup-ws-src-');
    repoIn(after, 'app', { readme: '# another project that took the name\n' });
    const manager = h.manager();
    const reconciler = new RepoMoveReconciler({ worktrees: manager, ledger: h.ledger, bus: h.bus, notifications: h.notifications, workspaceRoot: after, managedRepos: ['app'] });
    reconciler.start();
    cleanups.push(() => reconciler.stop());

    const outcomes = reconciler.check();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['mismatch', 'mismatch']);
    const cards = openCards(h, REPO_MISMATCH_KIND);
    expect(cards).toHaveLength(2);
    expect(ownerAttentionFor(REPO_MISMATCH_KIND)).toBe('owner-required');
    expect(requiresTypedDecision(REPO_MISMATCH_KIND)).toBe(true);
    expect(cards.every((card) => card.routing === 'needs-owner' && card.decision?.reservedClass === 'destructive')).toBe(true);
    const cardOf = (laneId: string): NotificationRecord => cards.find((card) => card.title.startsWith(`Lane ${laneId} `))!;
    expect(cardOf('job-kept').detail).toContain('shares no root commit');
    expect(h.ledger.getWorktree('job-kept')?.repoPath).toBe(app);

    h.notifications.decide(cardOf('job-kept').id, 'decline', 'owner');
    h.notifications.decide(cardOf('job-gone').id, 'accept', 'owner');
    await vi.waitFor(() => expect(openCards(h, REPO_MISMATCH_KIND)).toEqual([]));
    await reconciler.followCards();

    expect(existsSync(kept.path)).toBe(true);
    expect(h.ledger.getWorktree('job-kept')?.status).toBe('active');
    expect(existsSync(gone.path)).toBe(false);
    expect(h.ledger.getWorktree('job-gone')?.status).toBe('swept');
    expect(payloadOf(events(h, 'worktree.discarded')[0])).toMatchObject({ id: 'job-gone', path: gone.path, repo_path: app });
    // The declined lane is not asked about again while the name holds that repository.
    reconciler.check();
    expect(openCards(h, REPO_MISMATCH_KIND)).toEqual([]);
  });

  it('the same root commit with another origin is a different repository; the same origin reconnects; a card a repair made moot is withdrawn', async () => {
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app', { origin: true });
    const originUrl = git(app, ['remote', 'get-url', 'origin']);
    addJob(h, 'job-fork');
    const lane = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-fork' });
    const after = tempDir('gru-cleanup-ws-src-');
    renameSync(app, join(after, 'app'));
    const moved = join(after, 'app');
    git(moved, ['remote', 'set-url', 'origin', join(tempDir('gru-cleanup-fork-'), 'fork.git')]);
    const reconciler = new RepoMoveReconciler({ worktrees: h.manager(), ledger: h.ledger, bus: h.bus, notifications: h.notifications, workspaceRoot: after, managedRepos: ['app'] });

    expect(reconciler.check().map((outcome) => outcome.status)).toEqual(['mismatch']);
    const [card] = openCards(h, REPO_MISMATCH_KIND);
    expect(card!.detail).toContain(`the lane's repository's was ${originUrl}`);
    expect(h.ledger.getWorktree('job-fork')?.repoPath).toBe(app);

    git(moved, ['remote', 'set-url', 'origin', originUrl]);
    expect(reconciler.check().map((outcome) => outcome.status)).toEqual(['repaired']);

    expect(h.ledger.getWorktree('job-fork')?.repoPath).toBe(moved);
    expect(h.ledger.getNotification(card!.id)?.resolvedBy).toBe('producer-withdrawn');
    expect(() => captureCwdHandoff(lane.path)()).not.toThrow();
  });
});

describe('a rebinding is taken only as a move of the repository (#427 PR 2b)', () => {
  it('a turn\'s custody refuses a rebinding that moves more than the repository, or does not start from the issued binding', async () => {
    const h = harness();
    const workspace = tempDir('gru-cleanup-ws-');
    const app = repoIn(workspace, 'app');
    addJob(h, 'job-path');
    addJob(h, 'job-chain');
    const manager = h.manager();
    const moved = await manager.createJobWorktree({ repoPath: app, jobId: 'job-path' });
    const chained = await manager.createJobWorktree({ repoPath: app, jobId: 'job-chain' });
    for (const lane of [moved, chained]) expect(() => captureCwdHandoff(lane.path)()).not.toThrow();
    const issued = (id: string): Record<string, unknown> => payloadOf(events(h, 'worktree.handoff-completed').find((event) => payloadOf(event)['id'] === id));

    // The checkout moving with it is no repository move.
    h.ledger.appendCustomEvent({ kind: 'worktree.handoff-rebound', jobId: 'job-path', payload: { id: 'job-path', from: issued('job-path'), to: { ...issued('job-path'), path: join(workspace, 'elsewhere') } } });
    // A rebinding from a binding that was never issued.
    h.ledger.appendCustomEvent({ kind: 'worktree.handoff-rebound', jobId: 'job-chain', payload: { id: 'job-chain', from: { ...issued('job-chain'), repo: join(workspace, 'other') }, to: issued('job-chain') } });

    expect(() => captureCwdHandoff(moved.path)).toThrow(WorktreeHandoffUnresolvedError);
    expect(() => captureCwdHandoff(chained.path)).toThrow(WorktreeHandoffUnresolvedError);
  });
});

describe('gru-service reset (#427 PR 2b)', () => {
  interface Instance {
    readonly home: string;
    readonly workspace: string;
    readonly app: string;
    readonly lanesRoot: string;
    readonly out: string[];
    readonly err: string[];
    deps(overrides?: Partial<ResetCliDeps>): Partial<ResetCliDeps>;
  }

  /** An instance whose data directory is its home (the default), with a
   * managed repository holding two GC lanes, a GC branch and ref, and the
   * user's own branch and worktree. */
  async function instance(port = 7999): Promise<Instance> {
    const home = tempDir('gru-cleanup-home-');
    const workspace = tempDir('gru-cleanup-ws-');
    const app = repoIn(workspace, 'app');
    writeFileSync(join(home, 'config.toml'), [
      `workspace_root = ${JSON.stringify(workspace)}`,
      'managed_repos = ["app"]',
      '[server]', `port = ${String(port)}`,
      '[auth]', 'token = "reset-token"', '',
    ].join('\n'));
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const db = new LedgerDb(home);
    const bus = new EventBus({});
    const ledger = new LedgerApi(db.handle, { bus });
    const manager = new WorktreeManager({ ledger, root: config.worktrees.root, preserveRoot: config.worktrees.preserveRoot, setupTimeoutMs: 30_000, enumerateProcesses: () => [] });
    for (const jobId of ['job-one', 'job-two']) {
      ledger.addJob({ id: jobId, repo: 'app', title: jobId });
      await manager.createJobWorktree({ repoPath: app, jobId });
    }
    const third = await (async () => {
      ledger.addJob({ id: 'job-three', repo: 'app', title: 'job-three' });
      return manager.createJobWorktree({ repoPath: app, jobId: 'job-three' });
    })();
    writeFileSync(join(third.path, 'README.md'), 'saved\n');
    await manager.release({ worktreeId: 'job-three' });
    db.close();
    git(app, ['branch', 'gru/leftover']);
    git(app, ['branch', 'mine']);
    git(app, ['worktree', 'add', '-q', join(workspace, 'my-tree'), 'mine']);
    cleanups.push(() => { try { git(app, ['worktree', 'remove', '--force', join(workspace, 'my-tree')]); } catch { /* removed */ } });
    writeFileSync(join(workspace, 'app', 'my-notes.txt'), 'mine\n');
    for (const kept of ['identity', 'credentials', 'perkins', 'logs']) mkdirSync(join(home, kept), { recursive: true });
    writeFileSync(join(home, 'identity', 'identity.json'), '{}\n');
    writeFileSync(join(home, 'credentials', 'openrouter.key'), 'key\n');
    writeFileSync(join(home, 'perkins', 'config'), '{}\n');
    writeFileSync(join(home, 'logs', 'launchd.out.log'), '');
    writeFileSync(join(home, 'logs', 'service.log'), 'old log\n');
    mkdirSync(join(home, 'reviews', 'r-1'), { recursive: true });
    const out: string[] = [];
    const err: string[] = [];
    return {
      home, workspace, app, lanesRoot: config.worktrees.root, out, err,
      deps: (overrides = {}) => ({
        loadConfig: () => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester'),
        probeListeners: async () => [],
        fetchFn: async () => { throw new Error('connect ECONNREFUSED'); },
        stdout: (line) => { out.push(line); },
        stderr: (line) => { err.push(line); },
        confirm: null,
        homeDir: '/home/tester',
        ...overrides,
      }),
    };
  }

  const laneTrees = (app: string, lanesRoot: string): string[] =>
    git(app, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ') && line.includes(lanesRoot));

  it('refuses while the service runs (something answers on its port), naming how to stop it, and changes nothing', async () => {
    const server: HttpServer = createServer((_req, res) => { res.writeHead(404); res.end(); });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    cleanups.push(() => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); }));
    const port = (server.address() as AddressInfo).port;
    const at = await instance(port);
    const lanes = laneTrees(at.app, at.lanesRoot);
    expect(lanes).toHaveLength(2);

    const code = await runResetCli(['--yes'], at.deps({ probeListeners: async () => [{ pid: 4242, command: 'node' }] }));

    expect(code).toBe(1);
    expect(at.err.join('\n')).toContain('the service is running: pid 4242 (node) listens on port');
    expect(at.err.join('\n')).toContain('systemctl --user stop gru-command');
    expect(at.err.join('\n')).toContain('launchctl bootout');
    expect(laneTrees(at.app, at.lanesRoot)).toEqual(lanes);
    expect(existsSync(join(at.home, 'reviews'))).toBe(true);

    // With no listener the probe sees, a /health that answers is the service too.
    at.err.length = 0;
    expect(await runResetCli(['--yes'], at.deps({ fetchFn: (input, init) => fetch(input, init) }))).toBe(1);
    expect(at.err.join('\n')).toContain('/health answered (HTTP 404)');
    expect(existsSync(join(at.home, 'reviews'))).toBe(true);
  });

  it('with the service stopped and --yes: every GC lane is removed and pruned, the data directory keeps only config.toml and the install\'s files, and the user\'s own branches, worktrees and files are untouched', async () => {
    const at = await instance();
    const userBranches = git(at.app, ['for-each-ref', '--format=%(refname)', 'refs/heads']);
    expect(laneTrees(at.app, at.lanesRoot)).toHaveLength(2);
    expect(git(at.app, ['for-each-ref', '--format=%(refname)', 'refs/gru/'])).not.toBe('');

    const code = await runResetCli(['--yes'], at.deps());

    expect(at.err).toEqual([]);
    expect(code).toBe(0);
    expect(laneTrees(at.app, at.lanesRoot)).toEqual([]);
    expect(git(at.app, ['worktree', 'list', '--porcelain'])).toContain(join(at.workspace, 'my-tree'));
    expect(git(at.app, ['for-each-ref', '--format=%(refname)', 'refs/heads'])).toBe(userBranches);
    expect(git(at.app, ['for-each-ref', '--format=%(refname)', 'refs/gru/'])).not.toBe('');
    expect(readFileSync(join(at.app, 'my-notes.txt'), 'utf-8')).toBe('mine\n');
    expect(readdirSync(at.home).sort()).toEqual(['config.toml', 'credentials', 'identity', 'logs', 'perkins']);
    expect(readdirSync(join(at.home, 'logs'))).toEqual(['launchd.out.log']);
    expect(readFileSync(join(at.home, 'config.toml'), 'utf-8')).toContain('managed_repos = ["app"]');
    expect(RESET_KEEPS).toContain('config.toml');
    const said = at.out.join('\n');
    expect(said).toContain('gru-service reset will:');
    expect(said).toContain('remove 2 GC lane(s)');
    expect(said).toContain('keep gru/* branches (--delete-branches deletes them)');
    expect(said).toMatch(/removed lane .*job-one from app/u);
    expect(said).toContain(`deleted ${join(at.home, 'worktrees')}`);
    expect(said).toContain('reset done');
  });

  it('--delete-branches and --delete-refs delete gru/* branches and refs/gru/*, never a branch checked out in a worktree of the user\'s', async () => {
    const at = await instance();
    git(join(at.workspace, 'my-tree'), ['checkout', '-q', '-b', 'gru/mine-checked-out']);

    const code = await runResetCli(['--yes', '--delete-branches', '--delete-refs'], at.deps());

    expect(code).toBe(0);
    const heads = git(at.app, ['for-each-ref', '--format=%(refname)', 'refs/heads']).split('\n');
    expect(heads).toContain('refs/heads/gru/mine-checked-out');
    expect(heads).not.toContain('refs/heads/gru/leftover');
    expect(heads).not.toContain('refs/heads/gru/job-one');
    expect(heads).toContain('refs/heads/mine');
    expect(heads).toContain('refs/heads/main');
    expect(git(at.app, ['for-each-ref', '--format=%(refname)', 'refs/gru/'])).toBe('');
    expect(at.err).toEqual([]);
    expect(at.out.join('\n')).toContain(`keep gru/mine-checked-out (checked out in your worktree ${join(at.workspace, 'my-tree')})`);
  });

  it('changes nothing without --yes when there is no terminal to confirm at, or when the confirmation is declined; and refuses a data directory that holds the workspace', async () => {
    const at = await instance();
    const lanes = laneTrees(at.app, at.lanesRoot);

    expect(await runResetCli([], at.deps())).toBe(1);
    expect(at.err.join('\n')).toContain('Pass --yes');
    const asked: string[] = [];
    expect(await runResetCli([], at.deps({ confirm: async (question) => { asked.push(question); return false; } }))).toBe(1);
    expect(asked).toEqual(['Proceed? [y/N] ']);
    expect(at.out.join('\n')).toContain('reset cancelled; nothing changed.');
    expect(laneTrees(at.app, at.lanesRoot)).toEqual(lanes);
    expect(existsSync(join(at.home, 'reviews'))).toBe(true);

    // gru-service routes reset, and its usage names it.
    expect(await runServiceCli(['reset', '--frobnicate'])).toBe(2);

    at.err.length = 0;
    const refused = await runResetCli(['--yes'], at.deps({ loadConfig: () => ({ ...loadConfig({ GRU_COMMAND_HOME: at.home }, '/home/tester'), dataDir: dirname(at.workspace) }) }));
    expect(refused).toBe(1);
    expect(at.err.join('\n')).toContain(`holds the workspace root ${at.workspace}`);
    expect(existsSync(at.app)).toBe(true);
  });
});
