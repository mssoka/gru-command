import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { DEFAULT_VECTOR_CONFIG, loadConfig, VECTOR_MODES, type VectorConfig } from '../src/config.js';
import { renderReferenceConfig } from '../src/config-reference.js';
import { ownerAttentionFor } from '../src/notifications/attention.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import type { PackageResolution } from '../src/property/types.js';
import { parseWorktreeManifest } from '../src/worktrees/manifest.js';
import { BoardEngine } from '../src/board/engine.js';
import { isValidSnapshot } from '../web/src/lib/board-protocol.js';
import { vectorBoardView, type VectorBoardView, type VectorOnBoardView } from '../src/vector/board.js';
import { buildRaidCandidates, rankScore } from '../src/vector/candidates.js';
import { VECTOR_EVENTS, VectorLedger, type RaidRecord } from '../src/vector/ledger.js';
import { createVectorServer } from '../src/vector/server.js';
import { FIX_PROPOSAL_KIND, RAID_CANDIDATES_KIND, RAID_LAUNCHED_KIND, RAID_PROPOSAL_KIND, startVectorHalves, VectorRefusal, VectorService } from '../src/vector/service.js';

/**
 * Vector's raids, planning half (#351 §1–2): config, the code-built
 * candidate list, Gru's picks and the FOR YOU proposals. Real git
 * repositories and a real ledger; only seam A capability resolution is
 * injected (a runnable adapter needs installed tooling).
 */

const cleanups: (() => void)[] = [];
afterAll(() => { for (const cleanup of cleanups.reverse()) cleanup(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

interface Workspace {
  readonly root: string;
  /** Commit a file and move origin/HEAD to the new commit. */
  commit(repo: string, path: string, content: string): string;
  /** Create a managed repo with a property config and an origin/HEAD. */
  repo(name: string, opts?: { readonly mode?: string; readonly optOut?: boolean; readonly originHead?: boolean }): void;
}

function workspace(): Workspace {
  const root = tempDir('gru-vector-ws-');
  const commit = (repo: string, path: string, content: string): string => {
    const dir = join(root, repo);
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `change ${path}`);
    const sha = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'update-ref', 'refs/remotes/origin/main', sha);
    return sha;
  };
  return {
    root,
    commit,
    repo(name, opts = {}) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      mkdirSync(join(dir, '.gru-command'), { recursive: true });
      writeFileSync(join(dir, '.gru-command', 'property.toml'), `mode = "${opts.mode ?? 'observation'}"\n`);
      if (opts.optOut === true) writeFileSync(join(dir, '.gru-command', 'worktree.toml'), '[vector]\nenabled = false\n');
      writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
      mkdirSync(join(dir, 'src', 'refunds'), { recursive: true });
      writeFileSync(join(dir, 'src', 'refunds', 'refund.js'), 'export const refund = (amount) => amount;\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'seed');
      if (opts.originHead !== false) {
        git(dir, 'update-ref', 'refs/remotes/origin/main', git(dir, 'rev-parse', 'HEAD'));
        git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
      }
    },
  };
}

/** Seam A stand-in: every repository has one runnable package at src/refunds. */
const runnable = (): readonly PackageResolution[] => [{
  packageDir: 'src/refunds',
  ecosystem: 'node',
  status: 'resolved',
  adapterId: 'vitest-fast-check',
  tooling: { runner: 'runnable', libraries: { 'fast-check': 'installed' }, executable: true, reasons: [] },
  reasons: [],
  evidence: [],
  resolutionKey: 'fixture',
}];

interface Harness {
  readonly ws: Workspace;
  readonly ledger: LedgerApi;
  readonly bus: EventBus;
  readonly notifications: NotificationCenter;
  readonly dataDir: string;
  service(overrides?: Partial<VectorConfig>, now?: () => Date): VectorService;
  rows(kind: string): ReturnType<LedgerApi['listNotifications']>;
}

function harness(repos: readonly string[] = ['billing']): Harness {
  const ws = workspace();
  for (const name of repos) ws.repo(name);
  const dataDir = tempDir('gru-vector-ledger-');
  const db = new LedgerDb(dataDir);
  cleanups.push(() => db.close());
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  return {
    ws, ledger, bus, notifications, dataDir,
    service(overrides = {}, now) {
      const service = new VectorService({
        vector: { ...DEFAULT_VECTOR_CONFIG, enabled: true, planIntervalMs: 0, ...overrides },
        workspaceRoot: ws.root,
        managedRepos: repos,
        ledger,
        bus,
        notifications,
        resolvePackages: runnable,
        ...(now === undefined ? {} : { now }),
      });
      cleanups.push(() => service.stop());
      return service;
    },
    rows: (kind) => ledger.listNotifications({ limit: 500 }).filter((row) => row.kind === kind),
  };
}

const pickRefunds = (reason = 'twelve commits landed since the last raid') => ({ repo: 'billing', packageDir: 'src/refunds', reason });

describe('[vector] config (#351 §1)', () => {
  const home = (): string => tempDir('gru-vector-home-');
  const load = (toml: string) => {
    const dir = home();
    writeFileSync(join(dir, 'config.toml'), toml);
    return loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  };

  it('is off by default, with proposed modes and documented budgets', () => {
    expect(load('').vector).toEqual({ enabled: false, raidMode: 'proposed', fixMode: 'proposed', planIntervalMs: 86_400_000, maxRounds: 4, maxRuns: 16, maxRaidMs: 1_800_000, maxRaidTokens: 400_000, maxRaidsPerDay: 2 });
    expect(load('[vector]\nenabled = true\nraid_mode = "autonomous"\nfix_mode = "autonomous"\nmax_runs = 9\n').vector).toMatchObject({ enabled: true, raidMode: 'autonomous', fixMode: 'autonomous', maxRuns: 9 });
  });

  it('fails at boot on an invalid mode, naming the valid set, and on unknown keys, a zero time cap or a run cap below one attack', () => {
    expect(() => load('[vector]\nraid_mode = "sometimes"\n')).toThrow(/vector\.raid_mode must be one of "proposed", "autonomous", got: "sometimes"/u);
    expect(() => load('[vector]\nfix_mode = true\n')).toThrow(/vector\.fix_mode must be one of "proposed", "autonomous", got: true/u);
    expect(() => load('[vector]\nraids = 3\n')).toThrow(/unknown key `raids` in \[vector\]/u);
    expect(() => load('[vector]\nmax_raid_ms = 0\n')).toThrow(/vector\.max_raid_ms must be positive/u);
    // One attack can need five sandboxed runs; a smaller cap would never attack.
    expect(() => load('[vector]\nmax_runs = 4\n')).toThrow(/vector\.max_runs must be at least 5: one attack can need that many sandboxed runs/u);
    expect(load('[vector]\nmax_runs = 5\n').vector.maxRuns).toBe(5);
  });

  it('regenerating the config keeps every [vector] value; zero and wrong-typed values fail by name, and plan_interval_ms = 0 means raids only on request', () => {
    const custom = load('[vector]\nenabled = true\nraid_mode = "autonomous"\nfix_mode = "autonomous"\nplan_interval_ms = 0\nmax_rounds = 7\nmax_runs = 21\nmax_raid_ms = 600000\nmax_raid_tokens = 9000\nmax_raids_per_day = 3\n');
    const text = renderReferenceConfig({ instanceDir: '/i', workspaceRoot: '/w', managedRepos: [], host: '127.0.0.1', port: 7665, token: 't', runtime: 'claude-code', model: 'default', thinkingLevel: 'default', roles: {} }, custom);
    expect((parseToml(text) as Record<string, unknown>)['vector']).toEqual({ enabled: true, raid_mode: 'autonomous', fix_mode: 'autonomous', plan_interval_ms: 0, max_rounds: 7, max_runs: 21, max_raid_ms: 600_000, max_raid_tokens: 9000, max_raids_per_day: 3 });
    expect(custom.vector.planIntervalMs).toBe(0);
    expect(() => load('[vector]\nmax_rounds = 0\n')).toThrow(/vector\.max_rounds must be a positive integer/u);
    expect(() => load('[vector]\nmax_raids_per_day = 0\n')).toThrow(/vector\.max_raids_per_day must be a positive integer/u);
    expect(() => load('[vector]\nenabled = "yes"\n')).toThrow(/vector\.enabled must be a boolean/u);
  });

  it('raid and fix proposals are registered owner decisions; a proposal with no typed decision is refused', () => {
    expect(ownerAttentionFor('vector.raid-proposal')).toBe('owner-required');
    expect(ownerAttentionFor('vector.fix-proposal')).toBe('owner-required');
    const h = harness();
    expect(() => h.notifications.post({ kind: 'vector.fix-proposal', routing: 'needs-owner', severity: 'info', title: 'no decision' })).toThrow(/requires typed decision metadata/u);
  });

  it('a repository opts out in its own worktree.toml; anything else there is refused by name', () => {
    expect(parseWorktreeManifest('[vector]\nenabled = false\n').vector).toEqual({ enabled: false });
    expect(parseWorktreeManifest('').vector).toBeUndefined();
    expect(() => parseWorktreeManifest('[vector]\nenabled = "no"\n')).toThrow(/\[vector\]\.enabled must be a boolean/u);
    expect(() => parseWorktreeManifest('[vector]\nmode = "x"\n')).toThrow(/\[vector\] has unknown key "mode"/u);
  });
});

describe('raid candidates: code ranks, Gru decides (#351 §2)', () => {
  it('lists runnable packages at the cached default head, and names every exclusion', () => {
    const ws = workspace();
    ws.repo('billing');
    ws.repo('ledger-svc', { optOut: true });
    ws.repo('docs-site', { mode: 'disabled' });
    ws.repo('fresh-clone', { originHead: false });
    mkdirSync(join(ws.root, 'not-a-repo'));
    const list = buildRaidCandidates({ workspaceRoot: ws.root, managedRepos: ['billing', 'ledger-svc', 'docs-site', 'fresh-clone', 'not-a-repo'], maxRaidsPerDay: 2,
      raids: [], perkinsFindings: () => 0, escapedRegressions: () => 0, resolvePackages: runnable, now: new Date() });
    expect(list.candidates.map((candidate) => `${candidate.target.repo}/${candidate.target.packageDir}`)).toEqual(['billing/src/refunds']);
    expect(list.candidates[0]!.headSha).toBe(git(join(ws.root, 'billing'), 'rev-parse', 'refs/remotes/origin/main'));
    expect(list.candidates[0]!.sourceIdentity).toBe(git(join(ws.root, 'billing'), 'rev-parse', 'HEAD:src/refunds'));
    expect(list.candidates[0]!.signals).toEqual({ commitsSinceLastRaid: 1, escapedRegressions: 0, perkinsFindings: 0, daysSinceLastRaid: null });
    expect(Object.fromEntries(list.exclusions.map((entry) => [entry.repo, entry.reason]))).toEqual({
      'docs-site': expect.stringMatching(/property execution is disabled/u),
      'fresh-clone': expect.stringMatching(/no cached origin default branch/u),
      'ledger-svc': 'opted out: [vector] enabled = false in .gru-command/worktree.toml',
      'not-a-repo': 'not a git checkout under the workspace root',
    });
  });

  it('ranks by the real signals: Perkins findings since the last raid, earlier break-ins, commits and age; never-raided first', async () => {
    const h = harness(['alpha', 'billing']);
    // billing was raided before (one break-in), then two changes-requested verdicts landed.
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.picked, payload: { raid_id: 'raid-old', repo: 'billing', package_dir: 'src/refunds', source_identity: 'old', head_sha: 'h', reason: 'r', requested_by: 'gru' } });
    for (const [kind, extra] of [[VECTOR_EVENTS.queued, { launched_by: 'autonomous' }], [VECTOR_EVENTS.started, { head_sha: 'h' }], [VECTOR_EVENTS.finished, { outcome: 'found', label: 'x', detail: 'd' }]] as const) {
      h.ledger.appendCustomEvent({ kind, payload: { raid_id: 'raid-old', ...extra } });
    }
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.breakIn, payload: { break_in_id: 'breakin-old-r1', raid_id: 'raid-old', repo: 'billing', package_dir: 'src/refunds', head_sha: 'h',
      source_identity: 'old', description: 'd', requirement_ref: 'r', invariant: 'i', frozen_sha256: 'f', evidence_dir: '/e', test_path: 't', test_sha256: 's' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (const n of [1, 2]) {
      h.ledger.addJob({ id: `heist-${String(n)}`, repo: 'billing', title: 'x' });
      const round = h.ledger.addRound({ jobId: `heist-${String(n)}`, lenses: [] });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
    }
    const list = h.service().candidates();
    expect(list.candidates.map((candidate) => [candidate.target.repo, candidate.signals.perkinsFindings, candidate.signals.escapedRegressions, candidate.signals.daysSinceLastRaid]))
      .toEqual([['alpha', 0, 0, null], ['billing', 2, 1, 0]]);
    for (const candidate of list.candidates) expect(candidate.score).toBe(rankScore(candidate.signals));
    // Weighted signals order raided targets; a never-raided target counts as 1,000 days old.
    const base = { commitsSinceLastRaid: 0, escapedRegressions: 0, perkinsFindings: 0, daysSinceLastRaid: 1 };
    expect(rankScore({ ...base, escapedRegressions: 1 })).toBeGreaterThan(rankScore({ ...base, commitsSinceLastRaid: 1 }));
    expect(rankScore({ ...base, commitsSinceLastRaid: 1 })).toBeGreaterThan(rankScore({ ...base, perkinsFindings: 1 }));
    expect(rankScore({ ...base, daysSinceLastRaid: null })).toBeGreaterThan(rankScore({ ...base, commitsSinceLastRaid: 100 }));
  });

  it('raids run only the vitest-fast-check adapter, and a package path is matched literally, never as a glob', () => {
    const ws = workspace();
    ws.repo('billing');
    // A directory literally named "a*", and a sibling a glob would also match.
    ws.commit('billing', 'src/a*/x.js', 'x\n');
    ws.commit('billing', 'src/ab/y.js', 'y\n');
    ws.commit('billing', 'src/ab/y.js', 'y2\n');
    const row = (packageDir: string, adapterId: string): PackageResolution => ({ ...runnable()[0]!, packageDir, adapterId });
    const list = buildRaidCandidates({ workspaceRoot: ws.root, managedRepos: ['billing'], maxRaidsPerDay: 2, raids: [], perkinsFindings: () => 0, escapedRegressions: () => 0,
      resolvePackages: () => [row('src/a*', 'vitest-fast-check'), row('src/ab', 'pytest-hypothesis')], now: new Date() });
    expect(list.exclusions).toEqual([{ repo: 'billing', packageDir: 'src/ab', reason: 'raids run only the vitest-fast-check adapter today (this package resolves to pytest-hypothesis)' }]);
    expect(list.candidates.map((candidate) => [candidate.target.packageDir, candidate.signals.commitsSinceLastRaid])).toEqual([['src/a*', 1]]);
  });

  it('its digest changes with the code, not with time', () => {
    const ws = workspace();
    ws.repo('billing');
    const build = (now: Date) => buildRaidCandidates({ workspaceRoot: ws.root, managedRepos: ['billing'], maxRaidsPerDay: 2, raids: [], perkinsFindings: () => 0, escapedRegressions: () => 0, resolvePackages: runnable, now });
    const before = build(new Date('2026-10-01T00:00:00Z'));
    expect(build(new Date('2026-10-09T00:00:00Z')).digest).toBe(before.digest);
    ws.commit('billing', 'README.md', 'outside the package\n');
    expect(build(new Date()).digest).toBe(before.digest);
    ws.commit('billing', 'src/refunds/refund.js', 'export const refund = (amount) => Math.abs(amount);\n');
    expect(build(new Date()).digest).not.toBe(before.digest);
  });
});

describe('planning and picks (#351 §2)', () => {
  it('with [vector] enabled = false: no list, no Gru turn, and a request is refused with the reason', async () => {
    const h = harness();
    const service = h.service({ enabled: false, planIntervalMs: 1000 });
    service.start();
    expect(() => service.candidates()).toThrow(VectorRefusal);
    expect(() => service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'owner-chat' })).toThrow(/Vector raids are disabled: set \[vector\] enabled = true/u);
    expect(h.ledger.listEventsAfter(0, { kinds: Object.values(VECTOR_EVENTS) })).toEqual([]);
    expect(h.rows(RAID_CANDIDATES_KIND)).toEqual([]);
  });

  it('no eligible candidate means no Gru turn; a changed list gets one turn, never twice', () => {
    const h = harness();
    const service = h.service();
    h.ws.commit('billing', '.gru-command/property.toml', 'mode = "disabled"\n');
    expect(service.planTick()).toEqual({ offered: false, digest: null });
    expect(h.rows(RAID_CANDIDATES_KIND)).toEqual([]);
    h.ws.commit('billing', '.gru-command/property.toml', 'mode = "observation"\n');
    const first = service.planTick();
    expect(first.offered).toBe(true);
    expect(h.rows(RAID_CANDIDATES_KIND)).toEqual([expect.objectContaining({ routing: 'action-required', detail: expect.stringContaining('billing/src/refunds') })]);
    // The same situation is never re-decided, nor offered twice while open.
    expect(service.planTick()).toEqual({ offered: false, digest: first.digest });
    expect(h.rows(RAID_CANDIDATES_KIND)).toHaveLength(1);
    // Gru answers with no pick: the turn closes and the list stays decided.
    service.pick({ picks: [], digest: first.digest!, requestedBy: 'gru' });
    expect(h.rows(RAID_CANDIDATES_KIND)[0]!.resolvedAt).not.toBeNull();
    expect(service.planTick().offered).toBe(false);
    // A changed package is a new situation: one new turn.
    h.ws.commit('billing', 'src/refunds/refund.js', 'export const refund = (amount) => -amount;\n');
    expect(service.planTick().offered).toBe(true);
    expect(h.rows(RAID_CANDIDATES_KIND).filter((row) => row.resolvedAt === null)).toHaveLength(1);
  });

  it('Gru cannot raid a target outside the code-built list; one bad pick refuses the whole request', () => {
    const h = harness(['billing', 'ledger-svc']);
    h.ws.commit('ledger-svc', '.gru-command/worktree.toml', '[vector]\nenabled = false\n');
    const service = h.service();
    expect(() => service.pick({ picks: [pickRefunds(), { repo: 'ledger-svc', packageDir: 'src/refunds', reason: 'r' }], digest: null, requestedBy: 'gru' }))
      .toThrow(/ledger-svc\/src\/refunds is not a raid candidate: opted out/u);
    expect(() => service.pick({ picks: [{ repo: 'billing', packageDir: 'src/payouts', reason: 'r' }], digest: null, requestedBy: 'gru' }))
      .toThrow(/billing\/src\/payouts is not a raid candidate/u);
    expect(() => service.pick({ picks: [pickRefunds('two\nlines')], digest: null, requestedBy: 'gru' })).toThrow(/reason must be one non-blank line of visible text/u);
    expect(service.raids()).toEqual([]);
  });

  it('proposed: one FOR YOU proposal per target and identity; a retry reuses it; Accept launches it', () => {
    const h = harness();
    const service = h.service();
    service.start();
    const [raid] = service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    expect(raid).toMatchObject({ state: 'proposed', notificationId: `vector-raid:${raid!.id}` });
    expect(service.pick({ picks: [pickRefunds('again')], digest: null, requestedBy: 'gru' }).raids).toEqual([raid]);
    const [card] = h.rows(RAID_PROPOSAL_KIND);
    expect(card).toMatchObject({ routing: 'needs-owner', decision: { reservedClass: 'authority-cost', options: [{ id: 'accept' }, { id: 'decline' }] } });
    expect(h.rows(RAID_PROPOSAL_KIND)).toHaveLength(1);
    h.notifications.decide(card!.id, 'accept', 'web', card!.decision!);
    expect(service.raids()[0]).toMatchObject({ state: 'queued', launchedBy: 'owner-accept' });
    expect(h.ledger.getNotification(card!.id)?.resolvedAt).not.toBeNull();
    expect(h.rows(RAID_LAUNCHED_KIND)).toEqual([expect.objectContaining({ routing: 'fyi' })]);
    // Launched: not a candidate while it waits or runs.
    expect(service.candidates().exclusions).toContainEqual({ repo: 'billing', packageDir: 'src/refunds', reason: 'a raid on it is queued or running' });
  });

  it('Decline is recorded and suppresses the target until its source identity changes', () => {
    const h = harness();
    const service = h.service();
    service.start();
    service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' });
    const [card] = h.rows(RAID_PROPOSAL_KIND);
    h.notifications.decide(card!.id, 'decline', 'web', card!.decision!);
    expect(service.raids()[0]).toMatchObject({ state: 'declined', closedDetail: 'declined by web' });
    expect(h.ledger.getNotification(card!.id)?.resolvedAt).not.toBeNull();
    expect(service.candidates().exclusions).toContainEqual({ repo: 'billing', packageDir: 'src/refunds', reason: 'declined at this source identity' });
    h.ws.commit('billing', 'src/refunds/refund.js', 'export const refund = (amount) => amount * 2;\n');
    expect(service.candidates().candidates.map((candidate) => candidate.target.packageDir)).toEqual(['src/refunds']);
  });

  it('a target that changes before a decision withdraws its pending proposal', () => {
    const h = harness();
    const service = h.service();
    service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' });
    h.ws.commit('billing', 'src/refunds/refund.js', 'export const refund = () => 0;\n');
    service.reconcile();
    expect(service.raids()[0]).toMatchObject({ state: 'withdrawn', closedDetail: expect.stringMatching(/^withdrawn: billing\/src\/refunds changed/u) });
    const [card] = h.rows(RAID_PROPOSAL_KIND);
    expect(card).toMatchObject({ resolvedBy: 'producer-withdrawn', decidedAt: null });
    expect(h.rows('vector.raid-proposal-withdrawn')).toHaveLength(1);
    // The withdrawn card can no longer take an answer.
    expect(() => h.notifications.decide(card!.id, 'accept', 'web', card!.decision!)).toThrow(/already resolved/u);
  });

  it('only a producer-withdrawable owner proposal can be withdrawn undecided; a decided one never is', () => {
    const h = harness();
    const decision = { question: 'q?', context: 'c', recommendation: null, reservedClass: 'scope-design' as const, whyNotDelegable: 'w', options: [{ id: 'go', label: 'Go', consequence: 'c' }], discussion: false };
    const escalation = h.notifications.post({ id: 'owner-esc', kind: 'gru.owner-escalation', routing: 'needs-owner', severity: 'info', title: 't', decision });
    expect(() => h.ledger.withdrawOwnerProposal(escalation.id, 'stale')).toThrow(/not a producer-withdrawable owner proposal/u);
    expect(h.ledger.getNotification(escalation.id)?.resolvedAt).toBeNull();
    const service = h.service();
    const [raid] = service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    h.ledger.recordNotificationDecision(raid!.notificationId!, 'accept', 'web');
    expect(() => h.ledger.withdrawOwnerProposal(raid!.notificationId!, 'stale')).toThrow(/already records decision "accept"; it is carried out, never withdrawn/u);
  });

  it('pending proposals survive a restart, and a decision recorded while down is carried out at boot', () => {
    const h = harness();
    const first = h.service();
    first.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' });
    first.stop();
    const [card] = h.rows(RAID_PROPOSAL_KIND);
    const restarted = h.service();
    restarted.start();
    expect(restarted.raids()[0]).toMatchObject({ state: 'proposed', notificationId: card!.id });
    expect(h.rows(RAID_PROPOSAL_KIND)).toHaveLength(1);
    restarted.stop();
    // Answered while no service listened: the next boot carries it out.
    h.ledger.recordNotificationDecision(card!.id, 'accept', 'web');
    const again = h.service();
    again.start();
    expect(again.raids()[0]).toMatchObject({ state: 'queued', launchedBy: 'owner-accept' });
  });

  it('a candidate Gru saw and did not pick is not offered again; an emptied list closes the open turn', () => {
    const h = harness(['alpha', 'billing']);
    const service = h.service();
    const first = service.planTick();
    expect(first.offered).toBe(true);
    // Gru picks one of the two: the other is not re-offered as a "new" list.
    service.pick({ picks: [{ repo: 'billing', packageDir: 'src/refunds', reason: 'fresh' }], digest: first.digest!, requestedBy: 'gru' });
    expect(service.planTick().offered).toBe(false);
    expect(h.rows(RAID_CANDIDATES_KIND)).toHaveLength(1);
    // A change makes a new situation: one new turn; the list then empties and the turn closes.
    h.ws.commit('alpha', 'src/refunds/refund.js', 'export const refund = (amount) => amount * 3;\n');
    expect(service.planTick().offered).toBe(true);
    h.ws.commit('alpha', '.gru-command/property.toml', 'mode = "disabled"\n');
    expect(service.planTick()).toEqual({ offered: false, digest: null });
    expect(h.rows(RAID_CANDIDATES_KIND).filter((row) => row.resolvedAt === null)).toEqual([]);
  });

  it('reconcile repairs every half-done proposal: a pick with no card, a card closed unanswered, a stale Accept, and an answer that lands mid-withdrawal', () => {
    const h = harness();
    const service = h.service();
    // A pick recorded with no card (a failure mid-pick) gets its card.
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.picked, payload: { raid_id: 'raid-cardless', repo: 'billing', package_dir: 'src/refunds', source_identity: git(join(h.ws.root, 'billing'), 'rev-parse', 'HEAD:src/refunds'), head_sha: 'h', reason: 'r', requested_by: 'gru' } });
    service.reconcile();
    expect(service.raids()[0]).toMatchObject({ id: 'raid-cardless', state: 'proposed', notificationId: 'vector-raid:raid-cardless' });
    // A card closed without an answer frees its raid.
    h.ledger.withdrawOwnerProposal('vector-raid:raid-cardless', 'closed elsewhere');
    service.reconcile();
    expect(service.raids()[0]).toMatchObject({ state: 'withdrawn', closedDetail: 'withdrawn: its card was closed without an answer' });
    // An Accept on a target that changed since the card launches nothing.
    const [raid] = service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    h.ws.commit('billing', 'src/refunds/refund.js', 'export const refund = () => 7;\n');
    h.ledger.recordNotificationDecision(raid!.notificationId!, 'accept', 'web');
    service.followDecision(raid!.notificationId!);
    expect(service.raids().find((entry) => entry.id === raid!.id)).toMatchObject({ state: 'withdrawn', launchedAt: null });
    expect(h.ledger.getNotification(raid!.notificationId!)?.resolvedAt).not.toBeNull();
  });

  it('one stored event that cannot apply is skipped and logged, never a wedge', () => {
    const h = harness();
    const logged: string[] = [];
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.queued, payload: { raid_id: 'raid-nobody', launched_by: 'autonomous' } });
    const store = new VectorLedger(h.ledger, (level, msg) => logged.push(`${level}: ${msg}`));
    expect(store.raids()).toEqual([]);
    expect(store.skipped()).toBe(1);
    expect(logged).toEqual(['error: vector event skipped: it does not apply to the raid projection']);
    // The service still plans and picks.
    expect(h.service({ raidMode: 'autonomous' }).pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids[0]!.state).toBe('queued');
  });

  it('autonomous: a pick launches with no FOR YOU item, visible as board activity', () => {
    const h = harness();
    const service = h.service({ raidMode: 'autonomous' });
    const [raid] = service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    expect(raid).toMatchObject({ state: 'queued', launchedBy: 'autonomous', notificationId: null });
    expect(h.rows(RAID_PROPOSAL_KIND)).toEqual([]);
    expect(h.ledger.listNotifications({ limit: 50 }).filter((row) => row.routing === 'needs-owner')).toEqual([]);
    expect(h.rows(RAID_LAUNCHED_KIND)).toEqual([expect.objectContaining({ routing: 'fyi', detail: expect.stringMatching(/raid_mode = "autonomous"/u) })]);
  });

  it('a chat request counts as the owner\'s Accept, also for a target already proposed', () => {
    const h = harness();
    const service = h.service();
    expect(service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'owner-chat' }).raids[0]).toMatchObject({ state: 'queued', launchedBy: 'owner-chat' });
    expect(h.rows(RAID_PROPOSAL_KIND)).toEqual([]);
    expect(h.rows(RAID_LAUNCHED_KIND)[0]!.detail).toMatch(/^Requested by the owner in chat, as Gru declared it/u);
    const other = harness();
    const fresh = other.service();
    const [proposed] = fresh.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    expect(proposed!.state).toBe('proposed');
    const [accepted] = fresh.pick({ picks: [pickRefunds('the owner asked in chat')], digest: null, requestedBy: 'owner-chat' }).raids;
    expect(accepted).toMatchObject({ id: proposed!.id, state: 'queued', launchedBy: 'owner-accept' });
    expect(other.ledger.getNotification(proposed!.notificationId!)).toMatchObject({ decidedOption: 'accept', decidedBy: 'owner-chat' });
  });

  it('the daily cap counts launched and started raids and frees up 24 hours after a start; one request may not name a target twice', () => {
    const h = harness(['billing', 'ledger-svc']);
    let now = new Date();
    const service = h.service({ raidMode: 'autonomous', maxRaidsPerDay: 1 }, () => now);
    expect(() => service.pick({ picks: [pickRefunds(), { repo: 'billing', packageDir: 'src/refunds', reason: 'twice' }], digest: null, requestedBy: 'gru' })).toThrow(/repeats/u);
    const [raid] = service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    h.ws.commit('billing', 'src/refunds/refund.js', 'export const refund = (amount) => amount - 0;\n');
    expect(service.candidates().exclusions).toContainEqual({ repo: 'billing', packageDir: null, reason: 'daily raid cap reached (1 in the last 24 hours)' });
    // Once it started (and finished), the cap frees 24 hours after the start.
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.started, payload: { raid_id: raid!.id, head_sha: 'h' } });
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.finished, payload: { raid_id: raid!.id, outcome: 'budget-exhausted', label: 'x', detail: 'd' } });
    expect(service.candidates().candidates.filter((candidate) => candidate.target.repo === 'billing')).toEqual([]);
    now = new Date(Date.now() + 25 * 3_600_000);
    expect(service.candidates().candidates.filter((candidate) => candidate.target.repo === 'billing')).toHaveLength(1);
  });

  it('several picks in one request for one repository cannot pass its cap together', () => {
    const h = harness();
    const runnableTwice = (): readonly PackageResolution[] => [...runnable(), { ...runnable()[0]!, packageDir: 'src' }];
    const two = new VectorService({ vector: { ...DEFAULT_VECTOR_CONFIG, enabled: true, raidMode: 'autonomous', planIntervalMs: 0, maxRaidsPerDay: 1 }, workspaceRoot: h.ws.root,
      managedRepos: ['billing'], ledger: h.ledger, bus: h.bus, notifications: h.notifications, resolvePackages: runnableTwice });
    expect(() => two.pick({ picks: [pickRefunds(), { repo: 'billing', packageDir: 'src', reason: 'the rest of src' }], digest: null, requestedBy: 'gru' }))
      .toThrow(/billing: 2 more raid\(s\) would pass the daily raid cap \(0 of 1 in the last 24 hours\)/u);
    expect(two.raids()).toEqual([]);
  });

  it('a refused raid counts toward the daily cap, so a target that keeps being refused is retried at most the cap a day', () => {
    const h = harness();
    let now = new Date();
    const service = h.service({ raidMode: 'autonomous', maxRaidsPerDay: 1 }, () => now);
    const [raid] = service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.finished, payload: { raid_id: raid!.id, outcome: 'refused', label: 'Raid not run: x', detail: 'not-run: no sandbox backend' } });
    expect(service.candidates().exclusions).toContainEqual({ repo: 'billing', packageDir: null, reason: 'daily raid cap reached (1 in the last 24 hours)' });
    now = new Date(Date.now() + 25 * 3_600_000);
    expect(service.candidates().candidates).toHaveLength(1);
  });

  it('a pick that reuses a pending card launches nothing, so it never counts toward the cap', () => {
    const h = harness();
    const [card] = h.service().pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    expect(card!.state).toBe('proposed');
    // raid_mode is now autonomous, and another raid on billing already fills its cap.
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.picked, payload: { raid_id: 'raid-other', repo: 'billing', package_dir: 'src/other', source_identity: 'x', head_sha: 'h', reason: 'r', requested_by: 'gru' } });
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.queued, payload: { raid_id: 'raid-other', launched_by: 'autonomous' } });
    const autonomous = h.service({ raidMode: 'autonomous', maxRaidsPerDay: 1 });
    expect(autonomous.pick({ picks: [pickRefunds('again')], digest: null, requestedBy: 'gru' }).raids).toEqual([expect.objectContaining({ id: card!.id, state: 'proposed' })]);
  });

  it('a chat request for a target the owner declined is refused, naming the decline', () => {
    const h = harness();
    const service = h.service();
    const [raid] = service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    h.ledger.recordNotificationDecision(raid!.notificationId!, 'decline', 'web');
    expect(() => service.pick({ picks: [pickRefunds('the owner asked in chat')], digest: null, requestedBy: 'owner-chat' })).toThrow(/declined at this source identity/u);
    expect(service.raids().find((entry) => entry.id === raid!.id)!.state).toBe('declined');
  });

  it('a list closed or superseded unanswered marks nothing seen, and a target whose raid ended retryable is offered again', () => {
    const h = harness(['alpha']);
    const service = h.service({ raidMode: 'autonomous' });
    expect(service.planTick().offered).toBe(true);
    // The list empties before Gru answers it: the turn closes unanswered.
    h.ws.commit('alpha', '.gru-command/property.toml', 'mode = "disabled"\n');
    expect(service.planTick().offered).toBe(false);
    // Back at the same source identity: Gru never answered, so it is offered again.
    h.ws.commit('alpha', '.gru-command/property.toml', 'mode = "observation"\n');
    const again = service.planTick();
    expect(again.offered).toBe(true);
    const [raid] = service.pick({ picks: [{ repo: 'alpha', packageDir: 'src/refunds', reason: 'never raided' }], digest: again.digest!, requestedBy: 'gru' }).raids;
    expect(service.planTick().offered).toBe(false);
    // The raid is refused (no sandbox on this host): the target is eligible, and offered again.
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.finished, payload: { raid_id: raid!.id, outcome: 'refused', label: 'Raid not run: x', detail: 'not-run: no sandbox backend' } });
    const retry = service.planTick();
    expect(retry.offered).toBe(true);
    expect(h.rows(RAID_CANDIDATES_KIND)).toHaveLength(3);
    // Gru answers that list too, picking nothing: the newer answer stands, and the target is not offered again.
    service.pick({ picks: [], digest: retry.digest!, requestedBy: 'gru' });
    expect(service.planTick().offered).toBe(false);
    expect(h.rows(RAID_CANDIDATES_KIND)).toHaveLength(3);
  });
});

describe('raid service wiring (#351)', () => {
  it('starting the two raid halves: one failing never keeps the other from starting, and the failure is logged', () => {
    for (const failing of ['planning', 'runner'] as const) {
      const started: string[] = [];
      const logged: string[] = [];
      const half = (name: 'planning' | 'runner') => ({ start: () => { started.push(name); if (name === failing) throw new Error(`${name} broke`); } });
      startVectorHalves({ planning: half('planning'), runner: half('runner') }, (level, msg) => logged.push(`${level}: ${msg}`));
      expect(started, failing).toEqual(['planning', 'runner']);
      expect(logged, failing).toEqual([`error: vector raid ${failing} failed to start`]);
    }
  });
});

describe('the board view: the cockpit raids card (#351)', () => {
  const breakInPayload = (raidId: string, breakInId: string, invariant = 'refund(x) === x') => ({
    break_in_id: breakInId, raid_id: raidId, repo: 'billing', package_dir: 'src/refunds', head_sha: 'h', source_identity: 's',
    description: 'refund drops the cents', requirement_ref: 'REQ-1', invariant, frozen_sha256: 'f',
    evidence_dir: '/evidence', test_path: 'refund.property.test.js', test_sha256: 't',
  });
  const on = (view: VectorBoardView): VectorOnBoardView => {
    if (!view.enabled) throw new Error('expected the raids-on block');
    return view;
  };

  it('follows one raid from proposal to a running attack; an answered card waits for nobody', () => {
    const h = harness();
    let now = new Date();
    // Not started: decisions are followed by hand, so the gap between an
    // answer and its follow-through is observable.
    const service = h.service({ maxRounds: 4, maxRaidsPerDay: 2 }, () => now);
    expect(service.boardView()).toEqual({
      enabled: true, raidMode: 'proposed', proposed: 0, queued: 0, running: [], capUse: [], maxRaidsPerDay: 2, breakIns: 0, fixesAwaitingOwner: 0,
    });
    const [raid] = service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    // A proposal waits in FOR YOU and does not count toward the cap.
    expect(on(service.boardView())).toMatchObject({ proposed: 1, queued: 0, capUse: [] });
    h.ledger.recordNotificationDecision(raid!.notificationId!, 'accept', 'web');
    expect(on(service.boardView()).proposed).toBe(0);
    service.followDecision(raid!.notificationId!);
    // Queued: it counts toward the cap exactly as a pick is refused.
    expect(on(service.boardView())).toMatchObject({ proposed: 0, queued: 1, running: [], capUse: [{ repo: 'billing', used: 1 }] });
    const started = h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.started, payload: { raid_id: raid!.id, head_sha: 'h' } });
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.round, payload: { raid_id: raid!.id, outcome: 'rejected', verdict: 'rejected' } });
    expect(on(service.boardView())).toMatchObject({
      queued: 0,
      running: [{ repo: 'billing', packageDir: 'src/refunds', roundsDone: 1, maxRounds: 4, startedAt: started.ts }],
      capUse: [{ repo: 'billing', used: 1 }],
    });
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.finished, payload: { raid_id: raid!.id, outcome: 'budget-exhausted', label: 'x', detail: 'd' } });
    expect(on(service.boardView())).toMatchObject({ running: [], capUse: [{ repo: 'billing', used: 1 }] });
    // The rolling day ends exactly 24 hours after the start.
    now = new Date(Date.parse(started.ts) + 86_400_000 - 1);
    expect(on(service.boardView()).capUse).toEqual([{ repo: 'billing', used: 1 }]);
    now = new Date(Date.parse(started.ts) + 86_400_000);
    expect(on(service.boardView()).capUse).toEqual([]);
  });

  it('counts a fix as waiting only while its FOR YOU card is unanswered: never before its card, never after a decline or an Accept', async () => {
    const h = harness();
    const service = h.service();
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.breakIn, payload: breakInPayload('raid-1', 'bi-1') });
    // Found, but its card is not posted yet: nothing waits for the owner.
    expect(on(service.boardView())).toMatchObject({ breakIns: 1, fixesAwaitingOwner: 0 });
    await service.onBreakIn('bi-1');
    const [first] = h.rows(FIX_PROPOSAL_KIND);
    expect(on(service.boardView()).fixesAwaitingOwner).toBe(1);
    h.notifications.decide(first!.id, 'decline', 'web', first!.decision!);
    service.followDecision(first!.id);
    expect(service.breakIns().find((entry) => entry.id === 'bi-1')?.fix?.state).toBe('declined');
    expect(on(service.boardView())).toMatchObject({ breakIns: 1, fixesAwaitingOwner: 0 });
    // A second break-in the owner accepted before its dispatch ran: the fix
    // stays proposed in the record, yet nobody is asked any more.
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.breakIn, payload: breakInPayload('raid-1', 'bi-2', 'refund(x) >= 0') });
    await service.onBreakIn('bi-2');
    const second = h.rows(FIX_PROPOSAL_KIND).find((row) => row.id !== first!.id)!;
    expect(on(service.boardView()).fixesAwaitingOwner).toBe(1);
    h.ledger.recordNotificationDecision(second.id, 'accept', 'web');
    expect(service.breakIns().find((entry) => entry.id === 'bi-2')?.fix?.state).toBe('proposed');
    expect(on(service.boardView())).toMatchObject({ breakIns: 2, fixesAwaitingOwner: 0 });
  });

  it('two running raids are both shown, newest start first; cap use lists the busiest repository first', () => {
    const record = (id: string, repo: string, state: RaidRecord['state'], startedAt: string | null): RaidRecord => ({
      id, target: { repo, packageDir: 'src/x' }, sourceIdentity: 's', headSha: 'h', reason: 'r', requestedBy: 'gru',
      signals: { commitsSinceLastRaid: 0, escapedRegressions: 0, perkinsFindings: 0, daysSinceLastRaid: null },
      pickedAt: '2026-10-17T10:00:00.000Z', state, notificationId: null, launchedBy: 'autonomous', launchedAt: '2026-10-17T10:00:00.000Z',
      closedDetail: null, startedAt, runHeadSha: null, rounds: [], outcome: null, outcomeLabel: null, finishedAt: null, reportFile: null, metrics: null,
    });
    const view = vectorBoardView({
      config: { enabled: true, raidMode: 'autonomous', maxRounds: 4, maxRaidsPerDay: 2 },
      raids: [
        record('older', 'billing', 'running', '2026-10-17T11:00:00.000Z'),
        record('newer', 'ledger-svc', 'running', '2026-10-17T12:00:00+00:00'),
        record('waiting', 'billing', 'queued', null),
        // A proposal whose card was never posted waits for nobody.
        record('cardless', 'billing', 'proposed', null),
      ],
      breakIns: [],
      now: new Date('2026-10-17T13:00:00.000Z'),
      awaitingOwner: () => true,
    });
    expect(on(view).running.map((entry) => entry.repo)).toEqual(['ledger-svc', 'billing']);
    expect(on(view).capUse).toEqual([{ repo: 'billing', used: 2 }, { repo: 'ledger-svc', used: 1 }]);
    expect(on(view).proposed).toBe(0);
  });

  it('with raids off the block says only that: nothing follows decisions or closes raids, so no live count is claimed', () => {
    const h = harness();
    const live = h.service({ raidMode: 'autonomous' });
    live.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' });
    const off = h.service({ enabled: false, raidMode: 'autonomous', maxRaidsPerDay: 3 });
    off.start();
    expect(off.boardView()).toEqual({ enabled: false, raidMode: 'autonomous', maxRaidsPerDay: 3 });
  });

  it('reaches the board snapshot, and the web validator accepts what the server built; a failing read shows no card', async () => {
    const h = harness();
    const service = h.service({ raidMode: 'autonomous' });
    const [raid] = service.pick({ picks: [pickRefunds()], digest: null, requestedBy: 'gru' }).raids;
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.started, payload: { raid_id: raid!.id, head_sha: 'h' } });
    h.ledger.appendCustomEvent({ kind: VECTOR_EVENTS.breakIn, payload: breakInPayload(raid!.id, 'bi-1') });
    await service.onBreakIn('bi-1');
    const engine = new BoardEngine({ ledger: h.ledger, bus: h.bus, vector: () => service.boardView() });
    const snapshot = JSON.parse(JSON.stringify(engine.snapshot())) as Record<string, unknown>;
    expect(snapshot['vector']).toEqual(service.boardView());
    expect(on(service.boardView()).running).toHaveLength(1);
    expect(isValidSnapshot(snapshot)).toBe(true);
    // Every mode the server can send passes the web validator (a one-sided
    // addition would make the web reject the WHOLE board), on and off.
    for (const raidMode of VECTOR_MODES) {
      expect(isValidSnapshot({ ...snapshot, vector: { ...(snapshot['vector'] as object), raidMode } }), raidMode).toBe(true);
      expect(isValidSnapshot({ ...snapshot, vector: { enabled: false, raidMode, maxRaidsPerDay: 2 } }), `${raidMode} off`).toBe(true);
    }
    const logged: string[] = [];
    const broken = new BoardEngine({
      ledger: h.ledger, bus: h.bus, log: (level, msg) => logged.push(`${level}: ${msg}`),
      vector: () => { throw new Error('projection broke'); },
    });
    expect(broken.snapshot().vector).toBeNull();
    expect(logged).toContain('error: vector view read failed');
    expect(new BoardEngine({ ledger: h.ledger, bus: h.bus }).snapshot().vector).toBeNull();
  });
});

describe('the raid API (#351)', () => {
  async function call(server: Server, method: string, path: string, body?: unknown, token = 'vector-token'): Promise<{ status: number; json: Record<string, unknown> }> {
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += String(chunk); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) as Record<string, unknown> }));
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  async function serve(service: VectorService): Promise<Server> {
    const vector = createVectorServer({ token: 'vector-token', service });
    const server = createServer((req, res) => {
      if (!vector.requestHook(req, res, new URL(req.url ?? '/', 'http://x').pathname)) { res.writeHead(404); res.end('{}'); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => server.close());
    return server;
  }

  it('reads the list, records picks, and answers refusals by name', async () => {
    const h = harness();
    const server = await serve(h.service());
    expect((await call(server, 'GET', '/api/vector/candidates', undefined, 'wrong')).status).toBe(401);
    const listed = await call(server, 'GET', '/api/vector/candidates');
    expect(listed.status).toBe(200);
    expect(listed.json['candidates']).toEqual([expect.objectContaining({ repo: 'billing', package_dir: 'src/refunds', adapter_id: 'vitest-fast-check' })]);
    const bad = await call(server, 'POST', '/api/vector/raids', { picks: [{ repo: 'billing', package_dir: 'nope', reason: 'r' }] });
    expect(bad).toMatchObject({ status: 422, json: { error: 'not_a_candidate' } });
    const unknownField = await call(server, 'POST', '/api/vector/raids', { picks: [], verdict: 'pass' });
    expect(unknownField).toMatchObject({ status: 422, json: { error: 'invalid_pick', detail: expect.stringMatching(/unknown field "verdict"/u) } });
    const picked = await call(server, 'POST', '/api/vector/raids', { digest: listed.json['digest'], picks: [{ repo: 'billing', package_dir: 'src/refunds', reason: 'fresh refunds code' }] });
    expect(picked).toMatchObject({ status: 201, json: { raids: [expect.objectContaining({ state: 'proposed', reason: 'fresh refunds code' })] } });
    expect((await call(server, 'GET', '/api/vector/raids')).json).toMatchObject({ enabled: true, raids: [expect.objectContaining({ state: 'proposed' })] });
    expect((await call(server, 'GET', '/api/vector/rollup', undefined, 'wrong')).status).toBe(401);
    expect(await call(server, 'GET', '/api/vector/rollup')).toMatchObject({ status: 200, json: { rollup: [] } });
    const oversize = await call(server, 'POST', '/api/vector/raids', { picks: [], pad: 'x'.repeat(70 * 1024) });
    expect(oversize).toMatchObject({ status: 413, json: { error: 'payload_too_large' } });
  });

  it('a disabled instance refuses with 409 and the way to turn raids on', async () => {
    const h = harness();
    const server = await serve(h.service({ enabled: false }));
    const refused = await call(server, 'POST', '/api/vector/raids', { picks: [{ repo: 'billing', package_dir: 'src/refunds', reason: 'r' }], requested_by: 'owner-chat' });
    expect(refused).toMatchObject({ status: 409, json: { error: 'vector_disabled', detail: expect.stringMatching(/\[vector\] enabled = true/u) } });
  });
});
