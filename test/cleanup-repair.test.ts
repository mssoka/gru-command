import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESET_KEEPS, runResetCli, type ResetCliDeps } from '../src/cli/reset.js';
import { runServiceCli } from '../src/cli/service.js';
import { loadConfig } from '../src/config.js';
import { extractSameBlockerCases } from '../src/decisions/cases/same-blocker-extract.js';
import { routeFixDirectiveToMinion } from '../src/dispatch/fix-directive.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type EventRecord, type NotificationRecord } from '../src/ledger/api.js';
import { LedgerDb, ResetRunningError } from '../src/ledger/db.js';
import type { LogLevel } from '../src/logger.js';
import {
  EXPIRY_EVENTS,
  EXPIRY_RECONCILE_INTERVAL_MS,
  ExpiryService,
  PRESERVE_EXPIRY_KIND,
  PRESERVE_EXPIRY_MS,
  PRESERVE_REPROPOSE_MS,
  REVIEW_EXPIRY_MS,
  REVIEW_KEPT_FILES,
  preserveExpiryCard,
  startExpiry,
} from '../src/maintenance/expiry.js';
import { LANE_TAMPERED_KIND, laneTamperedRowId, REPO_MISMATCH_KIND, RepoMoveReconciler } from '../src/maintenance/repo-moves.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { ownerAttentionFor, requiresTypedDecision } from '../src/notifications/attention.js';
import { PacingGate } from '../src/runtime/pacing.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { captureCwdHandoff, WorktreeHandoffUnresolvedError, type Receipt } from '../src/worktrees/handoff.js';
import { normalizedOriginUrl, PRESERVED_REF_PREFIX, REPO_IDENTITY_EVENT, WorktreeManager, type ProcessEnumerator } from '../src/worktrees/manager.js';
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
  manager(opts?: { readonly enumerateProcesses?: ProcessEnumerator }): WorktreeManager;
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
    manager: (opts = {}) => new WorktreeManager({ ledger, root: lanesRoot, preserveRoot, setupTimeoutMs: 30_000, killGraceMs: 25, enumerateProcesses: opts.enumerateProcesses ?? (() => []), log }),
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

/** A review folder: its consolidated report and a transcript of `bytes`. */
function folder(path: string, bytes = 4096): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'consolidated.json'), '{"schemaVersion":3,"findings":[]}\n');
  writeFileSync(join(path, 'transcript.md'), `${'x'.repeat(bytes)}\n`);
}

/** The resolution detail a card was closed with. */
function resolution(h: Harness, id: string): string {
  return String(payloadOf(events(h, 'notification.resolved').find((event) => payloadOf(event)['id'] === id))['detail'] ?? '');
}

/** A custody event written straight into the ledger, as no API may: a forger's. */
function forgeEvent(h: Harness, kind: string, jobId: string, payload: unknown): number {
  const run = h.db.handle.prepare('INSERT INTO events (ts, kind, agent_id, job_id, round_id, lens, payload) VALUES (?, ?, NULL, ?, NULL, NULL, ?)')
    .run(new Date().toISOString(), kind, jobId, JSON.stringify(payload));
  return Number(run.lastInsertRowid);
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

    // Each round keeps only what readers outlive the job for.
    expect(REVIEW_KEPT_FILES).toEqual(['consolidated.json']);
    for (const round of rounds) expect(readdirSync(join(reviews, round))).toEqual(['consolidated.json']);
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
    expect(readdirSync(join(reviews, recentRound))).toEqual(['consolidated.json']);
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
    chmodSync(join(reviews, round), 0o500);
    cleanups.push(() => { if (existsSync(join(reviews, round))) chmodSync(join(reviews, round), 0o700); });
    const service = expiry(h, () => Date.now() + REVIEW_EXPIRY_MS + DAY);

    await service.reconcile();

    expect(existsSync(join(reviews, round, 'transcript.md'))).toBe(true);
    expect(events(h, EXPIRY_EVENTS.reviewsExpired)).toEqual([]);
    expect(h.logs.some((log) => log.level === 'warn' && log.msg.includes('could not be deleted'))).toBe(true);

    chmodSync(join(reviews, round), 0o700);
    await service.reconcile();

    expect(readdirSync(join(reviews, round))).toEqual(['consolidated.json']);
    expect(events(h, EXPIRY_EVENTS.reviewsExpired).map((event) => payloadOf(event)['rounds'])).toEqual([[round]]);
  });

  it('keeps what outlives the job: after expiry, the decision backtest\'s same-blocker corpus of an old job is unchanged', async () => {
    const h = harness();
    const reviews = join(h.dataDir, 'reviews');
    addJob(h, 'job-corpus');
    const [first, second] = [1, 2].map(() => h.ledger.addRound({ jobId: 'job-corpus' }).id);
    h.ledger.setJobStatus('job-corpus', 'in-review');
    h.ledger.setJobStatus('job-corpus', 'merged');
    const finding = (title: string, line: number, roundOrigin: number): Record<string, unknown> =>
      ({ title, category: 'correctness', location: `src/app.ts:${String(line)}`, severity: 'blocker', detail: `${title} in detail`, roundOrigin });
    const round = (id: string, createdAt: string, findings: readonly Record<string, unknown>[]): void => {
      folder(join(reviews, id), 8192);
      writeFileSync(join(reviews, id, 'consolidated.json'), JSON.stringify({ schemaVersion: 3, findings, frozen: { targetSha: 'a'.repeat(40), createdAt } }));
      mkdirSync(join(reviews, id, 'specialists'));
      writeFileSync(join(reviews, id, 'specialists', 'edge.json'), '{"lens":"edge"}\n');
    };
    round(first!, '2026-09-01T00:00:00.000Z', [finding('Null read', 10, 1)]);
    round(second!, '2026-09-02T00:00:00.000Z', [finding('Null read', 10, 1), finding('Lost write', 20, 2)]);
    const corpus = extractSameBlockerCases(reviews);
    expect(corpus.length).toBeGreaterThan(0);

    await expiry(h, () => Date.now() + REVIEW_EXPIRY_MS + DAY).reconcile();

    expect(extractSameBlockerCases(reviews)).toEqual(corpus);
    for (const id of [first!, second!]) expect(readdirSync(join(reviews, id))).toEqual(['consolidated.json']);
    expect(payloadOf(events(h, EXPIRY_EVENTS.reviewsExpired)[0])['rounds']).toEqual([first, second].sort());
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

  it('Accept deletes only what the card listed when it was posted, re-checked: a later record under the card, or a card whose own list names the user\'s branch or folder, deletes neither', async () => {
    const h = harness();
    const workspace = tempDir('gru-cleanup-ws-');
    const app = repoIn(workspace, 'app');
    const manager = h.manager();
    const t0 = Date.now();
    const saved = await releasedLane(h, manager, app, 'job-a', t0);
    const service = expiry(h, () => t0 + 40 * DAY);
    await service.reconcile();
    const [card] = openCards(h, PRESERVE_EXPIRY_KIND);
    const main = git(app, ['rev-parse', 'refs/heads/main']);
    // A later record under the real card names the user's branch: never what the owner saw.
    h.ledger.appendCustomEvent({
      kind: EXPIRY_EVENTS.preservesProposed,
      payload: { repo_path: app, repo: 'app', notification_id: card!.id, proposal: 1, copies: [], refs: [{ lane: 'job-a', ref: 'refs/heads/main', sha: main, bytes: 0 }] },
    });
    // A card whose own (first) list names the user's branch, a ref outside the lane's, and the repository's own folder.
    const forged = 'worktree-preserve-expiry:app:forged:1';
    h.ledger.appendCustomEvent({
      kind: EXPIRY_EVENTS.preservesProposed,
      payload: {
        repo_path: app, repo: 'app', notification_id: forged, proposal: 1,
        copies: [{ lane: 'job-a', path: app, bytes: 0 }],
        refs: [{ lane: 'job-a', ref: 'refs/heads/main', sha: main, bytes: 0 }, { lane: 'job-a', ref: `${PRESERVED_REF_PREFIX}/job-b/20261017T000000Z`, sha: main, bytes: 0 }],
      },
    });
    h.notifications.post(preserveExpiryCard(forged, { repoPath: app, repoName: 'app', copies: [], refs: [] }));
    git(app, ['update-ref', `${PRESERVED_REF_PREFIX}/job-b/20261017T000000Z`, main]);

    h.notifications.decide(card!.id, 'accept', 'owner');
    h.notifications.decide(forged, 'accept', 'owner');
    await service.reconcile();

    expect(git(app, ['rev-parse', 'refs/heads/main'])).toBe(main);
    expect(preservedRefs(app)).toContain(`${PRESERVED_REF_PREFIX}/job-b/20261017T000000Z`);
    expect(readFileSync(join(app, 'README.md'), 'utf-8')).toBe('# app\n');
    expect(preservedRefs(app)).not.toContain(saved.ref);
    expect(existsSync(saved.copy)).toBe(false);
    const deleted = events(h, EXPIRY_EVENTS.preservesDeleted).map(payloadOf);
    expect(deleted.find((payload) => payload['notification_id'] === card!.id)).toMatchObject({ copies: [saved.copy], refs: [saved.ref], kept: [] });
    expect(deleted.find((payload) => payload['notification_id'] === forged)).toMatchObject({
      copies: [],
      refs: [],
      kept: [
        { item: app, reason: 'it is not a preserve copy of a released lane this card lists' },
        { item: 'refs/heads/main', reason: 'it is not a snapshot ref of a released lane of this repository' },
        { item: `${PRESERVED_REF_PREFIX}/job-b/20261017T000000Z`, reason: 'it is not a snapshot ref of a released lane of this repository' },
      ],
    });
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('an accepted card whose delete fails stays open, and the pass that finishes records everything deleted and the bytes of every pass', async () => {
    const h = harness();
    const workspace = tempDir('gru-cleanup-ws-');
    const app = repoIn(workspace, 'app');
    const manager = h.manager();
    const t0 = Date.now();
    const saved = await releasedLane(h, manager, app, 'job-f', t0);
    const service = expiry(h, () => t0 + 40 * DAY);
    await service.reconcile();
    const [card] = openCards(h, PRESERVE_EXPIRY_KIND);
    const listed = payloadOf(events(h, EXPIRY_EVENTS.preservesProposed)[0]) as { copies: { bytes: number }[]; refs: { bytes: number | null }[] };
    const laneCopies = dirname(saved.copy);
    chmodSync(laneCopies, 0o500);
    cleanups.push(() => { if (existsSync(laneCopies)) chmodSync(laneCopies, 0o700); });
    h.notifications.decide(card!.id, 'accept', 'owner');

    await service.reconcile();

    expect(h.ledger.getNotification(card!.id)?.resolvedAt).toBeNull();
    expect(events(h, EXPIRY_EVENTS.preservesDeleted)).toEqual([]);
    expect(existsSync(saved.copy)).toBe(true);
    expect(preservedRefs(app)).not.toContain(saved.ref);
    expect(h.logs.some((log) => log.level === 'warn' && log.msg.includes('the card stays open'))).toBe(true);
    // A pass that fails the same way again adds no record.
    await service.reconcile();
    expect(events(h, EXPIRY_EVENTS.preservesDeleteIncomplete)).toHaveLength(1);

    chmodSync(laneCopies, 0o700);
    await service.reconcile();

    expect(h.ledger.getNotification(card!.id)?.resolvedAt).not.toBeNull();
    expect(existsSync(saved.copy)).toBe(false);
    expect(payloadOf(events(h, EXPIRY_EVENTS.preservesDeleted)[0])).toMatchObject({
      copies: [saved.copy],
      refs: [saved.ref],
      kept: [],
      bytes: listed.copies[0]!.bytes + (listed.refs[0]!.bytes ?? 0),
    });
  });

  it('start() follows the owner\'s answers, runs a pass at once and every hour with the moved-repository check first; startExpiry starts both and never throws', async () => {
    const h = harness();
    const reviews = join(h.dataDir, 'reviews');
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app');
    const manager = h.manager();
    const t0 = Date.now();
    addJob(h, 'job-reviewed');
    const round = h.ledger.addRound({ jobId: 'job-reviewed' }).id;
    h.ledger.setJobStatus('job-reviewed', 'done');
    folder(join(reviews, round));
    const saved = await releasedLane(h, manager, app, 'job-saved', t0);
    addJob(h, 'job-running');
    const lane = await manager.createJobWorktree({ repoPath: app, jobId: 'job-running' });
    const after = tempDir('gru-cleanup-ws-src-');
    const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => { h.logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); };
    const repoMoves = new RepoMoveReconciler({ worktrees: h.manager(), ledger: h.ledger, bus: h.bus, notifications: h.notifications, workspaceRoot: after, managedRepos: ['app'], log });
    let hourly: (() => void) | null = null;
    let every = 0;
    let checks = 0;
    const service = new ExpiryService({
      ledger: h.ledger,
      bus: h.bus,
      notifications: h.notifications,
      reviewsRoot: reviews,
      preserveRoot: h.preserveRoot,
      onReconcile: async () => { checks += 1; await repoMoves.reconcile(); },
      now: () => t0 + 40 * DAY,
      log,
      setInterval: ((callback: () => void, ms: number) => { hourly = callback; every = ms; return { unref: () => {} } as unknown as ReturnType<typeof setInterval>; }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
    });
    cleanups.push(() => { service.stop(); repoMoves.stop(); });

    startExpiry({ expiry: service, repoMoves }, log);

    await vi.waitFor(() => expect(openCards(h, PRESERVE_EXPIRY_KIND)).toHaveLength(1));
    expect(checks).toBe(1);
    expect(every).toBe(EXPIRY_RECONCILE_INTERVAL_MS);
    expect(readdirSync(join(reviews, round))).toEqual(['consolidated.json']);
    // The owner's answer is carried out without waiting for the hour.
    h.notifications.decide(openCards(h, PRESERVE_EXPIRY_KIND)[0]!.id, 'accept', 'owner');
    await vi.waitFor(() => expect(openCards(h, PRESERVE_EXPIRY_KIND)).toEqual([]));
    expect(existsSync(saved.copy)).toBe(false);
    // The repository moves while the service runs: the hourly pass reconnects its lane.
    renameSync(app, join(after, 'app'));
    hourly!();
    await vi.waitFor(() => expect(h.ledger.getWorktree('job-running')?.repoPath).toBe(join(after, 'app')));
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(() => captureCwdHandoff(lane.path)()).not.toThrow();

    // A part that fails to start is logged, never thrown.
    const failed: string[] = [];
    startExpiry({ expiry: { start: () => { throw new Error('timer refused'); } }, repoMoves: { start: () => {} } }, (_level, msg) => { failed.push(msg); });
    expect(failed).toEqual(['expiry failed to start']);
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
    // Its repository was gone before any check recorded an identity: matched by root commit only, and said so.
    expect(h.logs.some((log) => log.msg.includes('matched by its base commit\'s root commits only') && log.fields?.['id'] === 'job-legacy')).toBe(true);
  });

  it('a rebinding recorded and never published is finished after a second move: the repository moves A to B, B\'s receipt is not written, then B to C, and the lane works on C', async () => {
    const h = harness();
    const a = repoIn(tempDir('gru-cleanup-ws-a-'), 'app', { origin: true });
    addJob(h, 'job-twice');
    const lane = await h.manager().createJobWorktree({ repoPath: a, jobId: 'job-twice' });
    const b = join(tempDir('gru-cleanup-ws-b-'), 'app');
    renameSync(a, b);
    const manager = h.manager();
    const receiptIn = (repo: string): string => join(repo, '.git', 'worktrees', basename(lane.path), 'gru-creation-handoff.json');
    const original = readFileSync(receiptIn(b), 'utf-8');
    expect(manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: b }) }).map((outcome) => outcome.status)).toEqual(['repaired']);
    // The move to B is recorded, its receipt never written (a stop, or a write refused).
    writeFileSync(receiptIn(b), original);
    // Before any check finishes it, the repository moves again.
    const c = join(tempDir('gru-cleanup-ws-c-'), 'app');
    renameSync(b, c);
    expect(() => captureCwdHandoff(lane.path)).toThrow(WorktreeHandoffUnresolvedError);

    const outcomes = manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: c }) });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['repaired']);
    expect(h.ledger.getWorktree('job-twice')?.repoPath).toBe(c);
    expect(events(h, 'worktree.repo-moved').map(payloadOf)).toEqual([{ id: 'job-twice', from: a, to: b }, { id: 'job-twice', from: b, to: c }]);
    expect(JSON.parse(readFileSync(receiptIn(c), 'utf-8'))).toMatchObject({ repo: c, common: join(c, '.git'), admin: join(c, '.git', 'worktrees', basename(lane.path)) });
    expect(() => captureCwdHandoff(lane.path)()).not.toThrow();
    expect(await manager.ensureReady('job-twice')).toEqual([{ id: 'job-twice', status: 'ready' }]);
    expect(manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: c }) })).toEqual([]);
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

  it('a repository moved with a link left at its old place: the lane, whose link still works, is re-bound to where its repository really is and follows the managed name; a turn in it succeeds', async () => {
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app', { origin: true });
    addJob(h, 'job-linked');
    const lane = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-linked' });
    const after = tempDir('gru-cleanup-ws-src-');
    const moved = join(after, 'app');
    renameSync(app, moved);
    symlinkSync(moved, app);
    // git still works through the link; the turn's custody does not: its receipt names the old place.
    expect(() => git(lane.path, ['status'])).not.toThrow();
    expect(() => captureCwdHandoff(lane.path)).toThrow(WorktreeHandoffUnresolvedError);
    const manager = h.manager();

    const outcomes = manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: moved }) });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['repaired']);
    expect(h.ledger.getWorktree('job-linked')?.repoPath).toBe(moved);
    expect(events(h, 'worktree.repo-moved').map(payloadOf)).toEqual([{ id: 'job-linked', from: app, to: moved }]);
    expect(payloadOf(events(h, 'worktree.handoff-rebound')[0])['to']).toMatchObject({ repo: moved, common: join(moved, '.git') });
    expect(() => captureCwdHandoff(lane.path)()).not.toThrow();
    expect(await manager.ensureReady('job-linked')).toEqual([{ id: 'job-linked', status: 'ready' }]);
    expect(manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: moved }) })).toEqual([]);
  });

  it('a repository whose own git directory (--separate-git-dir) moved, its folder in place: the lane is repaired and re-bound to the moved git directory, its repo_path unchanged', async () => {
    const h = harness();
    const workspace = tempDir('gru-cleanup-ws-');
    const gitdirs = tempDir('gru-cleanup-gitdirs-');
    const app = join(workspace, 'app');
    git(workspace, ['init', '-q', '-b', 'main', '--separate-git-dir', join(gitdirs, 'app.git'), app]);
    writeFileSync(join(app, 'README.md'), '# app\n');
    git(app, ['add', '.']);
    git(app, ['commit', '-qm', 'app: first']);
    addJob(h, 'job-gitdir');
    const lane = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-gitdir' });
    const movedGitdir = join(tempDir('gru-cleanup-gitdirs-new-'), 'app.git');
    renameSync(join(gitdirs, 'app.git'), movedGitdir);
    writeFileSync(join(app, '.git'), `gitdir: ${movedGitdir}\n`);
    expect(() => captureCwdHandoff(lane.path)).toThrow(WorktreeHandoffUnresolvedError);
    const manager = h.manager();

    const outcomes = manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: app }) });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['repaired']);
    expect(h.ledger.getWorktree('job-gitdir')?.repoPath).toBe(app);
    expect(events(h, 'worktree.repo-moved').map(payloadOf)).toEqual([{ id: 'job-gitdir', from: app, to: app }]);
    expect(payloadOf(events(h, 'worktree.handoff-rebound')[0])['to']).toMatchObject({ repo: app, common: movedGitdir, admin: join(movedGitdir, 'worktrees', basename(lane.path)) });
    expect(() => captureCwdHandoff(lane.path)()).not.toThrow();
    expect(await manager.ensureReady('job-gitdir')).toEqual([{ id: 'job-gitdir', status: 'ready' }]);
  });

  it('the same repository by every root commit and a normalised origin: an orphan branch checked out in the main checkout, and https and ssh spellings of one origin, still reconnect', async () => {
    expect(normalizedOriginUrl('https://Example.invalid/o/r.git')).toBe('example.invalid/o/r');
    expect(normalizedOriginUrl('git@example.invalid:o/r')).toBe('example.invalid/o/r');
    expect(normalizedOriginUrl('ssh://git@EXAMPLE.invalid:22/o/r/')).toBe('example.invalid/o/r');
    expect(normalizedOriginUrl('https://user@example.invalid/o/r/')).toBe('example.invalid/o/r');
    expect(normalizedOriginUrl('/srv/git/r.git')).toBe('/srv/git/r');
    expect(normalizedOriginUrl('https://example.invalid/o/other')).not.toBe(normalizedOriginUrl('git@example.invalid:o/r'));
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app', { origin: true });
    // The origin as https (fetched from the local bare repository through insteadOf).
    const bare = git(app, ['remote', 'get-url', 'origin']);
    git(app, ['config', `url.${bare}.insteadOf`, 'https://example.invalid/o/r.git']);
    git(app, ['remote', 'set-url', 'origin', 'https://example.invalid/o/r.git']);
    addJob(h, 'job-orphan');
    const lane = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-orphan' });
    expect(payloadOf(events(h, REPO_IDENTITY_EVENT)[0])['origin']).toBe('https://example.invalid/o/r.git');
    const after = tempDir('gru-cleanup-ws-src-');
    const moved = join(after, 'app');
    renameSync(app, moved);
    // Since then: gh-pages, an orphan branch, is checked out; origin is spelled the ssh way.
    git(moved, ['checkout', '-q', '--orphan', 'gh-pages']);
    git(moved, ['commit', '-q', '--allow-empty', '-m', 'pages']);
    expect(git(moved, ['rev-list', '--max-parents=0', 'HEAD'])).not.toContain((payloadOf(events(h, REPO_IDENTITY_EVENT)[0])['roots'] as string[])[0]!);
    git(moved, ['remote', 'set-url', 'origin', 'git@example.invalid:o/r']);

    const outcomes = new RepoMoveReconciler({ worktrees: h.manager(), ledger: h.ledger, bus: h.bus, notifications: h.notifications, workspaceRoot: after, managedRepos: ['app'] }).check();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['repaired']);
    expect(openCards(h, REPO_MISMATCH_KIND)).toEqual([]);
    expect(() => captureCwdHandoff(lane.path)()).not.toThrow();
  });

  it('a lane made before identities were recorded gets the origin check: its first check records the identity while its repository is in place, and a move to another origin is then a mismatch', async () => {
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app', { origin: true });
    const originUrl = git(app, ['remote', 'get-url', 'origin']);
    addJob(h, 'job-old-lane');
    await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-old-lane' });
    h.db.handle.prepare('DELETE FROM events WHERE kind = ?').run(REPO_IDENTITY_EVENT);
    const manager = h.manager();

    expect(manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: app }) })).toEqual([]);

    expect(events(h, REPO_IDENTITY_EVENT).map(payloadOf)).toEqual([{ id: 'job-old-lane', repo_path: app, roots: [git(app, ['rev-list', '--max-parents=0', 'HEAD'])], origin: originUrl }]);
    const after = tempDir('gru-cleanup-ws-src-');
    const moved = join(after, 'app');
    renameSync(app, moved);
    git(moved, ['remote', 'set-url', 'origin', join(tempDir('gru-cleanup-fork-'), 'fork.git')]);
    const outcomes = manager.checkMovedRepositories({ managedRepos: ['app'], resolve: () => ({ kind: 'available', path: moved }) });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['mismatch']);
    expect(h.ledger.getWorktree('job-old-lane')?.repoPath).toBe(app);
  });

  it('an accepted discard never runs over live processes: a paused lane, or one with a process rooted in it, is kept with the card open until the next reconcile can; a lane whose repository is reachable again is not deleted', async () => {
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app');
    addJob(h, 'job-busy');
    addJob(h, 'job-back');
    const busy = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-busy' });
    const back = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-back' });
    const away = join(before, 'app-away');
    renameSync(app, away);
    const after = tempDir('gru-cleanup-ws-src-');
    repoIn(after, 'app', { readme: '# another project that took the name\n' });
    let rooted: { pid: number; command: string; evidence: 'cwd' }[] = [];
    const manager = h.manager({ enumerateProcesses: (tree) => (tree === busy.path ? rooted : []) });
    const reconciler = new RepoMoveReconciler({ worktrees: manager, ledger: h.ledger, bus: h.bus, notifications: h.notifications, workspaceRoot: after, managedRepos: ['app'], log: (level, msg, fields) => { h.logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); } });
    expect(reconciler.check().map((outcome) => outcome.status)).toEqual(['mismatch', 'mismatch']);
    const cardOf = (laneId: string): NotificationRecord => openCards(h, REPO_MISMATCH_KIND).find((card) => card.title.startsWith(`Lane ${laneId} `))!;
    const busyCard = cardOf('job-busy').id;
    const backCard = cardOf('job-back').id;
    h.ledger.setWorktreeStatus('job-busy', 'paused', 'paused over a live dev server');
    h.notifications.decide(busyCard, 'accept', 'owner');

    await reconciler.followCards();

    expect(existsSync(busy.path)).toBe(true);
    expect(h.ledger.getNotification(busyCard)?.resolvedAt).toBeNull();
    expect(h.logs.some((log) => log.msg.includes('an accepted lane discard waits') && log.fields?.['reason'] === 'the lane is paused over processes that still run in it')).toBe(true);

    // Resumed, but a process still runs in it.
    h.ledger.setWorktreeStatus('job-busy', 'active', 'resumed');
    rooted = [{ pid: 4242, command: 'node server.js', evidence: 'cwd' }];
    await reconciler.followCards();
    expect(existsSync(busy.path)).toBe(true);
    expect(h.ledger.getNotification(busyCard)?.resolvedAt).toBeNull();
    expect(h.logs.some((log) => log.fields?.['reason'] === '1 process(es) are rooted in the lane (pids 4242)')).toBe(true);
    expect(events(h, 'worktree.discarded')).toEqual([]);

    // Nothing runs in it now: the Accept is carried out.
    rooted = [];
    await reconciler.followCards();
    expect(existsSync(busy.path)).toBe(false);
    expect(h.ledger.getWorktree('job-busy')?.status).toBe('swept');
    expect(resolution(h, busyCard)).toBe('lane job-busy discarded');

    // Accepted, and before it is carried out the repository comes back: nothing is deleted.
    h.notifications.decide(backCard, 'accept', 'owner');
    renameSync(away, app);
    await reconciler.followCards();
    expect(existsSync(back.path)).toBe(true);
    expect(h.ledger.getWorktree('job-back')?.status).toBe('active');
    expect(resolution(h, backCard)).toBe('nothing discarded: lane job-back reaches its repository again');
    expect(events(h, 'worktree.discarded').map((event) => payloadOf(event)['id'])).toEqual(['job-busy']);
  });

  it('a withdrawn card is never re-posted: the name resolves elsewhere and then back, and a new card asks; a swept lane\'s undecided card is withdrawn', async () => {
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app');
    addJob(h, 'job-again');
    await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-again' });
    rmSync(app, { recursive: true, force: true });
    const one = tempDir('gru-cleanup-ws-one-');
    repoIn(one, 'app', { readme: '# first project that took the name\n' });
    const two = tempDir('gru-cleanup-ws-two-');
    repoIn(two, 'app', { readme: '# second project that took the name\n' });
    const manager = h.manager();
    const at = (workspaceRoot: string): RepoMoveReconciler => new RepoMoveReconciler({ worktrees: manager, ledger: h.ledger, bus: h.bus, notifications: h.notifications, workspaceRoot, managedRepos: ['app'] });

    at(one).check();
    const [first] = openCards(h, REPO_MISMATCH_KIND);
    at(two).check();
    const [second] = openCards(h, REPO_MISMATCH_KIND);
    expect(second!.id).not.toBe(first!.id);
    expect(h.ledger.getNotification(first!.id)?.resolvedBy).toBe('producer-withdrawn');

    at(one).check();

    const open = openCards(h, REPO_MISMATCH_KIND);
    expect(open).toHaveLength(1);
    expect([first!.id, second!.id]).not.toContain(open[0]!.id);
    expect(open[0]!.detail).toContain(`now resolves to ${join(one, 'app')}`);
    expect(h.ledger.getNotification(second!.id)?.resolvedBy).toBe('producer-withdrawn');

    h.ledger.setWorktreeStatus('job-again', 'swept', 'released elsewhere');
    at(one).check();
    expect(openCards(h, REPO_MISMATCH_KIND)).toEqual([]);
    expect(h.ledger.getNotification(open[0]!.id)?.resolvedBy).toBe('producer-withdrawn');
  });

  it('a released lane follows its moved repository: its snapshot refs there are still proposed, and the card\'s restore commands name where the repository is now', async () => {
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app');
    const manager = h.manager();
    const t0 = Date.now();
    const saved = await releasedLane(h, manager, app, 'job-released', t0);
    const after = tempDir('gru-cleanup-ws-src-');
    const moved = join(after, 'app');
    renameSync(app, moved);

    await new RepoMoveReconciler({ worktrees: h.manager(), ledger: h.ledger, bus: h.bus, notifications: h.notifications, workspaceRoot: after, managedRepos: ['app'] }).reconcile();

    expect(h.ledger.getWorktree('job-released')?.repoPath).toBe(moved);
    expect(events(h, 'worktree.repo-moved').map(payloadOf)).toEqual([{ id: 'job-released', from: app, to: moved }]);
    await expiry(h, () => t0 + 40 * DAY).reconcile();
    const [card] = openCards(h, PRESERVE_EXPIRY_KIND);
    expect(card!.detail).toContain(`git -C ${moved} cherry-pick --no-commit ${saved.ref}`);
    expect(card!.detail).toContain(`cp -R ${saved.copy}/. ${moved}`);
    expect(card!.detail).not.toContain(before);
  });

  it('released lanes follow off the event loop: 200 swept rows over three base commits take a handful of rev-list calls while a timer keeps firing, and rows found different are not judged again', async () => {
    const h = harness();
    const before = tempDir('gru-cleanup-ws-code-');
    const app = repoIn(before, 'app');
    const bases = [git(app, ['rev-parse', 'HEAD'])];
    for (const n of [2, 3]) {
      git(app, ['commit', '-q', '--allow-empty', '-m', `commit ${String(n)}`]);
      bases.push(git(app, ['rev-parse', 'HEAD']));
    }
    addJob(h, 'job-many');
    // Released lanes made before identities were recorded, and ten whose base commit the repository does not hold.
    const insert = h.db.handle.prepare(`INSERT INTO worktrees (id, kind, repo_path, repo_name, path, branch, sha, job_id, round_id, status, note, created_at, updated_at, base_source)
      VALUES (?, 'child', ?, 'app', ?, NULL, ?, 'job-many', NULL, 'swept', NULL, ?, ?, NULL)`);
    const at = new Date().toISOString();
    h.db.handle.exec('BEGIN');
    for (let n = 0; n < 210; n += 1) insert.run(`swept-${String(n)}`, app, join(h.lanesRoot, 'app', `child-${String(n)}`), n < 200 ? bases[n % 3]! : 'f'.repeat(40), at, at);
    h.db.handle.exec('COMMIT');
    const after = tempDir('gru-cleanup-ws-src-');
    const moved = join(after, 'app');
    renameSync(app, moved);
    const manager = h.manager();
    const names = { managedRepos: ['app'], resolve: () => ({ kind: 'available' as const, path: moved }) };
    /** The git commands run while `run` runs, as git itself traces them. */
    const traced = async (run: () => Promise<void>): Promise<string[]> => {
      const trace = join(tempDir('gru-cleanup-trace-'), 'git.trace');
      vi.stubEnv('GIT_TRACE', trace);
      try {
        await run();
      } finally {
        vi.unstubAllEnvs();
      }
      return existsSync(trace) ? readFileSync(trace, 'utf-8').split('\n').filter((line) => line.includes('trace: built-in: git ')) : [];
    };
    const count = (lines: readonly string[], command: string): number => lines.filter((line) => line.includes(`trace: built-in: git ${command} `)).length;
    let ticks = 0;
    let last = performance.now();
    let longest = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      ticks += 1;
    }, 1);

    let first: string[];
    try {
      first = await traced(() => manager.followSweptLanes(names));
    } finally {
      clearInterval(timer);
    }

    expect(h.ledger.listWorktrees().filter((row) => row.repoPath === moved)).toHaveLength(200);
    expect(h.ledger.listWorktrees().filter((row) => row.repoPath === app).map((row) => row.id).sort()).toEqual(Array.from({ length: 10 }, (_, n) => `swept-${String(200 + n)}`));
    // One identity read, and one per base commit: never one per row.
    expect(count(first, 'rev-list')).toBeLessThanOrEqual(4);
    expect(count(first, 'rev-parse')).toBeLessThanOrEqual(4);
    expect(ticks).toBeGreaterThan(0);
    expect(longest).toBeLessThan(1_000);
    expect(h.logs.filter((log) => log.msg.includes('released lanes follow their moved repository')).map((log) => log.fields)).toEqual([
      { from: app, to: moved, lanes: 200, matched_by_base_commit_only: 200 },
    ]);

    // The next check reads the repository's identity once and judges no row it found different again.
    const second = await traced(() => manager.followSweptLanes(names));
    expect(count(second, 'rev-list')).toBe(1);
    expect(count(second, 'rev-parse')).toBe(0);
    expect(h.ledger.listWorktrees().filter((row) => row.repoPath === app)).toHaveLength(10);
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

    // The checkout moving with it is no repository move (paired with a move, as a real rebinding is).
    const pathMove = forgeEvent(h, 'worktree.repo-moved', 'job-path', { id: 'job-path', from: app, to: app });
    forgeEvent(h, 'worktree.handoff-rebound', 'job-path', { id: 'job-path', from: issued('job-path'), to: { ...issued('job-path'), path: join(workspace, 'elsewhere') }, move_seq: pathMove });
    // A rebinding from a binding that was never issued.
    const chainMove = forgeEvent(h, 'worktree.repo-moved', 'job-chain', { id: 'job-chain', from: app, to: app });
    forgeEvent(h, 'worktree.handoff-rebound', 'job-chain', { id: 'job-chain', from: { ...issued('job-chain'), repo: join(workspace, 'other') }, to: issued('job-chain'), move_seq: chainMove });

    expect(() => captureCwdHandoff(moved.path)).toThrow(WorktreeHandoffUnresolvedError);
    expect(() => captureCwdHandoff(chained.path)).toThrow(WorktreeHandoffUnresolvedError);
  });

  it('a rebinding no move of the lane\'s repository recorded, in its transaction, is refused, even one that changes nothing; no custom event may write either kind', async () => {
    const h = harness();
    const workspace = tempDir('gru-cleanup-ws-');
    const app = repoIn(workspace, 'app');
    addJob(h, 'job-alone');
    addJob(h, 'job-other');
    const manager = h.manager();
    const alone = await manager.createJobWorktree({ repoPath: app, jobId: 'job-alone' });
    const other = await manager.createJobWorktree({ repoPath: app, jobId: 'job-other' });
    const issued = (id: string): Record<string, unknown> => payloadOf(events(h, 'worktree.handoff-completed').find((event) => payloadOf(event)['id'] === id));
    expect(() => h.ledger.appendCustomEvent({ kind: 'worktree.handoff-rebound', jobId: 'job-alone', payload: { id: 'job-alone', from: issued('job-alone'), to: issued('job-alone') } }))
      .toThrow(/recorded only with a lane's repository move/u);
    expect(() => h.ledger.appendCustomEvent({ kind: 'worktree.repo-moved', jobId: 'job-alone', payload: { id: 'job-alone', from: app, to: app } })).toThrow(/never as a custom event/u);
    expect(events(h, 'worktree.handoff-rebound')).toEqual([]);

    // No move at all: the binding would not even change.
    forgeEvent(h, 'worktree.handoff-rebound', 'job-alone', { id: 'job-alone', from: issued('job-alone'), to: issued('job-alone') });
    // A move, but of another lane.
    const otherMove = forgeEvent(h, 'worktree.repo-moved', 'job-other', { id: 'job-alone', from: app, to: app });
    forgeEvent(h, 'worktree.handoff-rebound', 'job-other', { id: 'job-other', from: issued('job-other'), to: issued('job-other'), move_seq: otherMove });

    expect(() => captureCwdHandoff(alone.path)).toThrow(WorktreeHandoffUnresolvedError);
    expect(() => captureCwdHandoff(other.path)).toThrow(WorktreeHandoffUnresolvedError);
  });

  it('an administration swapped with no move is not re-bound: a forged worktrees/evil pointing back at the lane, with the lane\'s .git pointed at it, records no move, leaves custody refused and posts Gru one action-required row naming the lane', async () => {
    const h = harness();
    const app = repoIn(tempDir('gru-cleanup-ws-'), 'app');
    addJob(h, 'job-swapped');
    const lane = await h.manager().createJobWorktree({ repoPath: app, jobId: 'job-swapped' });
    const original = join(app, '.git', 'worktrees', basename(lane.path));
    const evil = join(app, '.git', 'worktrees', 'evil');
    // Written from inside the lane, as a minion can: a copy of its administration, receipt included.
    cpSync(original, evil, { recursive: true });
    writeFileSync(join(lane.path, '.git'), `gitdir: ${evil}\n`);
    expect(() => git(lane.path, ['status'])).not.toThrow();
    const reconciler = new RepoMoveReconciler({ worktrees: h.manager(), ledger: h.ledger, bus: h.bus, notifications: h.notifications, workspaceRoot: dirname(app), managedRepos: ['app'] });

    const outcomes = reconciler.check();

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['tampered']);
    expect(events(h, 'worktree.repo-moved')).toEqual([]);
    expect(events(h, 'worktree.handoff-rebound')).toEqual([]);
    expect(readFileSync(join(lane.path, '.git'), 'utf-8')).toBe(`gitdir: ${evil}\n`);
    expect(() => captureCwdHandoff(lane.path)).toThrow(WorktreeHandoffUnresolvedError);
    const rows = openCards(h, LANE_TAMPERED_KIND);
    expect(rows.map((row) => [row.id, row.routing])).toEqual([[laneTamperedRowId('job-swapped'), 'action-required']]);
    expect(rows[0]!.title).toContain('Lane job-swapped (app)');
    expect(rows[0]!.detail).toContain(`${evil}, not the one its handoff was issued with (${original})`);
    // The next check posts no second row.
    expect(reconciler.check().map((outcome) => outcome.status)).toEqual(['tampered']);
    expect(openCards(h, LANE_TAMPERED_KIND)).toHaveLength(1);
    // The ledger itself refuses a move to the same place that moves nothing.
    const issued = payloadOf(events(h, 'worktree.handoff-completed')[0]) as unknown as Receipt;
    expect(() => h.ledger.moveWorktreeRepo({ id: 'job-swapped', repoPath: app, rebind: null })).toThrow(/did not move/u);
    expect(() => h.ledger.moveWorktreeRepo({ id: 'job-swapped', repoPath: app, rebind: { from: issued, to: { ...issued, admin: evil } } })).toThrow(/did not move/u);
    expect(events(h, 'worktree.repo-moved')).toEqual([]);
  });
});

/** Whether the temporary directory's volume ignores letter case (macOS's default). */
const caseInsensitiveTmp = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'gru-cleanup-case-'));
  try {
    writeFileSync(join(dir, 'probe'), '');
    return existsSync(join(dir, 'PROBE'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe('gru-service reset (#427 PR 2b)', () => {
  interface Instance {
    readonly home: string;
    readonly workspace: string;
    readonly app: string;
    /** A repository not in managed_repos, with a lane GC made in it (with `unmanaged`). */
    readonly api: string | null;
    readonly lanesRoot: string;
    readonly out: string[];
    readonly err: string[];
    deps(overrides?: Partial<ResetCliDeps>): Partial<ResetCliDeps>;
  }

  /** An instance whose data directory is its home (the default), with a
   * managed repository holding two GC lanes, a GC branch and ref, and the
   * user's own branch and worktree. */
  async function instance(port = 7999, opts: { readonly unmanaged?: boolean } = {}): Promise<Instance> {
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
    let api: string | null = null;
    if (opts.unmanaged === true) {
      api = repoIn(workspace, 'api');
      ledger.addJob({ id: 'job-api', repo: 'api', title: 'job-api' });
      await manager.createJobWorktree({ repoPath: api, jobId: 'job-api' });
    }
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
      home, workspace, app, api, lanesRoot: config.worktrees.root, out, err,
      deps: (overrides = {}) => ({
        loadConfig: () => loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester'),
        probeListeners: async () => [],
        fetchFn: async () => { throw refusedFetch(); },
        stdout: (line) => { out.push(line); },
        stderr: (line) => { err.push(line); },
        confirm: null,
        homeDir: '/home/tester',
        ...overrides,
      }),
    };
  }

  /** fetch's failure when nothing listens: a refused connection. */
  const refusedFetch = (): Error => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7999'), { code: 'ECONNREFUSED' }) });

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
    expect(readdirSync(at.home).sort()).toEqual(['config.toml', 'credentials', 'identity', 'logs', 'perkins', 'reset.lock']);
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

    // gru-service routes reset, with its seams: reset's own help exits 0
    // (the roll parser gives 2 for an unknown command), and its output is seen.
    const usage: string[] = [];
    expect(await runServiceCli(['reset', '--help'], { stderr: (line) => { usage.push(line); } })).toBe(0);
    expect(usage.join('\n')).toContain('usage: gru-service reset [--yes] [--delete-branches] [--delete-refs]');
    at.err.length = 0;
    expect(await runServiceCli(['reset'], { reset: at.deps() })).toBe(1);
    expect(at.err.join('\n')).toContain('Pass --yes');

    at.err.length = 0;
    const refused = await runResetCli(['--yes'], at.deps({ loadConfig: () => ({ ...loadConfig({ GRU_COMMAND_HOME: at.home }, '/home/tester'), dataDir: dirname(at.workspace) }) }));
    expect(refused).toBe(1);
    expect(at.err.join('\n')).toContain(`holds the workspace root ${at.workspace}`);
    expect(existsSync(at.app)).toBe(true);
  });

  it('removes a lane GC holds locked, and a lane of a repository that is not managed from that repository, then empties the data directory', async () => {
    const at = await instance(7999, { unmanaged: true });
    const lane = laneTrees(at.app, at.lanesRoot)[0]!.slice('worktree '.length);
    git(at.app, ['worktree', 'lock', '--reason', `gru-creation:${randomUUID()}`, lane]);
    expect(git(at.app, ['worktree', 'list', '--porcelain'])).toContain('locked gru-creation:');
    const apiLane = laneTrees(at.api!, at.lanesRoot)[0]!.slice('worktree '.length);
    expect(existsSync(apiLane)).toBe(true);

    const code = await runResetCli(['--yes'], at.deps());

    expect(at.err).toEqual([]);
    expect(code).toBe(0);
    expect(laneTrees(at.app, at.lanesRoot)).toEqual([]);
    // The unmanaged repository no longer registers its lane: removed there, not left dangling.
    expect(laneTrees(at.api!, at.lanesRoot)).toEqual([]);
    expect(existsSync(apiLane)).toBe(false);
    expect(at.out.join('\n')).toContain(`removed lane ${apiLane} from ${realpathSync(join(at.api!, '.git'))}`);
    expect(readdirSync(at.home).sort()).toEqual(['config.toml', 'credentials', 'identity', 'logs', 'perkins', 'reset.lock']);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('a lane that cannot be removed leaves the data directory as it was, names the lane and exits 1', async () => {
    const at = await instance();
    const lanes = laneTrees(at.app, at.lanesRoot).map((line) => line.slice('worktree '.length));
    chmodSync(join(at.lanesRoot, 'app'), 0o500);
    cleanups.push(() => { chmodSync(join(at.lanesRoot, 'app'), 0o700); });

    const code = await runResetCli(['--yes'], at.deps());

    expect(code).toBe(1);
    expect(at.err.join('\n')).toContain(`lane ${lanes[0]!} could not be removed from app`);
    expect(at.err.join('\n')).toContain('was left as it was');
    for (const kept of ['reviews', 'ledger', 'worktrees', 'logs']) expect(existsSync(join(at.home, kept))).toBe(true);
    expect(readFileSync(join(at.home, 'logs', 'service.log'), 'utf-8')).toBe('old log\n');
  });

  it('never touches a worktree of the user\'s own under the lanes root, keeps it in the data directory, and keeps the user\'s missing worktree registered by skipping the prune', async () => {
    const at = await instance();
    git(at.app, ['branch', 'mine-too']);
    const ownTree = join(at.lanesRoot, 'app', 'my-own');
    git(at.app, ['worktree', 'add', '-q', ownTree, 'mine-too']);
    cleanups.push(() => { try { git(at.app, ['worktree', 'remove', '--force', ownTree]); } catch { /* removed */ } });
    writeFileSync(join(ownTree, 'draft.txt'), 'mine\n');
    // The user's other worktree is on a volume that is not mounted now.
    rmSync(join(at.workspace, 'my-tree'), { recursive: true, force: true });

    const code = await runResetCli(['--yes'], at.deps());

    expect(at.err).toEqual([]);
    expect(code).toBe(0);
    expect(laneTrees(at.app, at.lanesRoot)).toEqual([`worktree ${ownTree}`]);
    expect(readFileSync(join(ownTree, 'draft.txt'), 'utf-8')).toBe('mine\n');
    expect(readdirSync(at.home).sort()).toEqual(['config.toml', 'credentials', 'identity', 'logs', 'perkins', 'reset.lock', 'worktrees']);
    expect(readdirSync(join(at.home, 'worktrees', 'app'))).toEqual(['my-own']);
    expect(git(at.app, ['worktree', 'list', '--porcelain'])).toContain(join(at.workspace, 'my-tree'));
    const said = at.out.join('\n');
    expect(said).toContain(`${ownTree} is a worktree or folder of your own: it is kept`);
    expect(said).toContain(`skipped git worktree prune in app: it would also drop your own worktree(s) whose folder is missing: ${join(at.workspace, 'my-tree')}`);
  });

  it('refuses a data directory that is or holds the home directory, that holds the install when reached through a link, or that holds the workspace spelled `..code`', async () => {
    const at = await instance();
    const untouched = (): void => {
      expect(existsSync(join(at.home, 'reviews'))).toBe(true);
      expect(laneTrees(at.app, at.lanesRoot)).toHaveLength(2);
    };

    expect(await runResetCli(['--yes'], at.deps({ homeDir: at.home }))).toBe(1);
    expect(at.err.join('\n')).toContain(`is your home directory ${at.home}`);
    untouched();

    mkdirSync(join(at.home, 'someone'));
    at.err.length = 0;
    expect(await runResetCli(['--yes'], at.deps({ homeDir: join(at.home, 'someone') }))).toBe(1);
    expect(at.err.join('\n')).toContain(`holds your home directory ${join(at.home, 'someone')}`);
    untouched();

    // ~/.gru-command a link to the real folder, and the install inside it.
    const link = join(tempDir('gru-cleanup-link-'), 'instance');
    symlinkSync(at.home, link);
    mkdirSync(join(at.home, 'app-install'));
    writeFileSync(join(at.home, 'app-install', 'package.json'), '{}\n');
    at.err.length = 0;
    expect(await runResetCli(['--yes'], at.deps({ loadConfig: () => loadConfig({ GRU_COMMAND_HOME: link }, '/home/tester'), packageRoot: join(link, 'app-install') }))).toBe(1);
    expect(at.err.join('\n')).toContain(`the data directory ${link} (${at.home}) holds the install ${join(link, 'app-install')}`);
    expect(existsSync(join(at.home, 'app-install', 'package.json'))).toBe(true);
    untouched();
    rmSync(join(at.home, 'app-install'), { recursive: true });

    // A workspace whose name only starts with two dots lies inside the data directory.
    mkdirSync(join(at.home, '..code'));
    at.err.length = 0;
    expect(await runResetCli(['--yes'], at.deps({ loadConfig: () => ({ ...loadConfig({ GRU_COMMAND_HOME: at.home }, '/home/tester'), workspaceRoot: join(at.home, '..code') }) }))).toBe(1);
    expect(at.err.join('\n')).toContain(`holds the workspace root ${join(at.home, '..code')}`);
    expect(existsSync(join(at.home, '..code'))).toBe(true);
    untouched();
  });

  it('refuses unless the service is provably stopped: a /health that times out, a service that starts while the prompt waits, a ledger a running process holds', async () => {
    const at = await instance();
    const untouched = (): void => {
      expect(existsSync(join(at.home, 'reviews'))).toBe(true);
      expect(laneTrees(at.app, at.lanesRoot)).toHaveLength(2);
    };

    const timedOut = await runResetCli(['--yes'], at.deps({ fetchFn: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } }));
    expect(timedOut).toBe(1);
    expect(at.err.join('\n')).toContain('the service may be running: http://127.0.0.1:7999/health did not refuse the connection (TimeoutError');
    untouched();

    // It starts while reset waits at its prompt: the check before the first change refuses.
    let started = false;
    at.err.length = 0;
    const raced = await runResetCli([], at.deps({
      confirm: async () => { started = true; return true; },
      fetchFn: async () => { if (started) return new Response('ok'); throw refusedFetch(); },
    }));
    expect(raced).toBe(1);
    expect(at.err.join('\n')).toContain('/health answered (HTTP 200) (checked again before changing anything; nothing changed)');
    untouched();

    // A running service holds its ledger open (it keeps no pid file); one that opens it during the prompt is caught too.
    const held = new LedgerDb(at.home);
    at.err.length = 0;
    expect(await runResetCli(['--yes'], at.deps())).toBe(1);
    expect(at.err.join('\n')).toContain('is held open by a running process');
    held.close();
    let late: LedgerDb | null = null;
    cleanups.push(() => { late?.close(); });
    at.err.length = 0;
    expect(await runResetCli([], at.deps({ confirm: async () => { late = new LedgerDb(at.home); return true; } }))).toBe(1);
    expect(at.err.join('\n')).toContain('is held open by a running process');
    expect(at.err.join('\n')).toContain('checked again before changing anything');
    untouched();
  });

  it('keeps a worktree of the user\'s at any depth in the data directory, with the folders that lead to it, and one nested beside a repository\'s .git with that repository; only their siblings are deleted', async () => {
    const at = await instance();
    // The user's own repository outside the data directory, with a worktree four levels deep in it.
    const other = repoIn(at.workspace, 'other');
    const deep = join(at.home, 'scratch', 'a', 'b', 'wt');
    mkdirSync(dirname(deep), { recursive: true });
    git(other, ['worktree', 'add', '-q', '-b', 'deep', deep]);
    writeFileSync(join(deep, 'draft.txt'), 'deep work\n');
    writeFileSync(join(at.home, 'scratch', 'junk.txt'), 'junk\n');
    mkdirSync(join(at.home, 'scratch', 'a', 'old'));
    writeFileSync(join(at.home, 'scratch', 'a', 'old', 'f.txt'), 'old\n');
    // A repository of the user's in the data directory, its worktree beside its .git.
    const x = repoIn(at.home, 'x');
    git(x, ['worktree', 'add', '-q', '-b', 'nested', join(x, 'wt')]);
    writeFileSync(join(x, 'wt', 'draft.txt'), 'nested work\n');

    const code = await runResetCli(['--yes'], at.deps());

    expect(at.err).toEqual([]);
    expect(code).toBe(0);
    expect(git(deep, ['status', '--porcelain'])).toBe('?? draft.txt');
    expect(readdirSync(join(at.home, 'scratch'))).toEqual(['a']);
    expect(readdirSync(join(at.home, 'scratch', 'a'))).toEqual(['b']);
    expect(git(join(x, 'wt'), ['status', '--porcelain'])).toBe('?? draft.txt');
    expect(git(x, ['log', '--format=%s'])).toBe('x: first');
    expect(readdirSync(at.home).sort()).toEqual(['config.toml', 'credentials', 'identity', 'logs', 'perkins', 'reset.lock', 'scratch', 'x']);
    const said = at.out.join('\n');
    expect(said).toContain(`${deep} is a worktree or folder of your own: it is kept`);
    expect(said).toContain(`${x} is a worktree or folder of your own: it is kept`);
  });

  it.skipIf(!caseInsensitiveTmp)('on a case-insensitive volume, refuses a data directory spelled in another letter case than the workspace it is, and changes nothing', async () => {
    const at = await instance();
    const shouted = join(dirname(at.workspace), basename(at.workspace).toUpperCase());
    expect(shouted).not.toBe(at.workspace);

    const code = await runResetCli(['--yes'], at.deps({ loadConfig: () => ({ ...loadConfig({ GRU_COMMAND_HOME: at.home }, '/home/tester'), dataDir: shouted }) }));

    expect(code).toBe(1);
    expect(at.err.join('\n')).toContain(`the data directory ${shouted} (${at.workspace}) holds the workspace root ${at.workspace}`);
    expect(readFileSync(join(at.app, 'my-notes.txt'), 'utf-8')).toBe('mine\n');
    expect(laneTrees(at.app, at.lanesRoot)).toHaveLength(2);
  });

  it('deletes the ledger last, after the lanes and the preserve copies, and holds reset.lock until it ends: a service starting meanwhile cannot open its ledger', async () => {
    const at = await instance();
    const copy = join(at.home, 'worktree-preserves', 'job-three', '20261017T000000Z');
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, 'notes.txt'), 'saved\n');
    const said: string[] = [];
    const starts: string[] = [];

    const code = await runResetCli(['--yes'], at.deps({
      stdout: (line) => {
        said.push(line);
        if (!line.startsWith('deleted ')) return;
        // A service starting while reset deletes.
        try {
          new LedgerDb(at.home).close();
          starts.push('started');
        } catch (error) {
          starts.push(error instanceof ResetRunningError ? 'refused' : String(error));
        }
      },
    }));

    expect(at.err).toEqual([]);
    expect(code).toBe(0);
    const deleted = said.filter((line) => line.startsWith('deleted ')).map((line) => line.slice('deleted '.length));
    expect(deleted).toEqual(expect.arrayContaining([join(at.home, 'worktrees'), join(at.home, 'worktree-preserves'), join(at.home, 'reviews')]));
    expect(deleted.at(-1)).toBe(join(at.home, 'ledger'));
    const lanesRemoved = said.map((line, index) => (line.startsWith('removed lane ') ? index : -1)).filter((index) => index >= 0);
    expect(lanesRemoved).toHaveLength(2);
    expect(Math.max(...lanesRemoved)).toBeLessThan(said.indexOf(`deleted ${join(at.home, 'ledger')}`));
    expect(starts).toEqual(deleted.map(() => 'refused'));
    // Once reset has ended, the service starts on a fresh ledger.
    new LedgerDb(at.home).close();
    expect(existsSync(join(at.home, 'ledger', 'ledger.db'))).toBe(true);
  });
});
