import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutoVerdictPoster,
  GhPrPoster,
  GitLabMrPoster,
  WaveRunner,
  redactReviewForPublication,
  type FallbackGateOutcome,
  type WaveOutcome,
} from '../src/dispatch/perkins.js';
import { preflightFailure, type FallbackFinding } from '../src/dispatch/review-path.js';

/** These suites exercise the Perkins route (no pre-flight configured), so
 * every runRound result must be a wave outcome; the helper pins that. */
function asWave(outcome: WaveOutcome | FallbackGateOutcome): WaveOutcome {
  if (!('route' in outcome)) return outcome;
  throw new Error(`expected a Perkins wave outcome, got ${outcome.route}`);
}


import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from '../src/dispatch/worktree-port.js';
import type { AgentSpawner } from '../src/dispatch/service.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { lensAgentLabel } from '../src/dispatch/perkins.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeHybridSpawner, type LeadBrainOptions } from './helpers/perkins-hybrid-double.js';

class GitReviewPort implements WorktreePort {
  private readonly lanes = new Map<string, WorktreeLane>();
  constructor(private readonly root: string, private readonly branch: string, private readonly sha: string) {}

  async createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> {
    const lane: WorktreeLane = {
      id: input.jobId, kind: 'job', repoPath: input.repoPath, repoName: 'fixture', path: input.repoPath,
      branch: this.branch, sha: this.sha, jobId: input.jobId, roundId: null, status: 'active',
    };
    this.lanes.set(lane.id, lane);
    return lane;
  }

  async createReviewWorktree(input: { repoPath: string; roundId: string; ref: string; jobId?: string }): Promise<WorktreeLane> {
    const path = join(this.root, input.roundId);
    execFileSync('git', ['-C', input.repoPath, 'worktree', 'add', '--detach', path, input.ref], { stdio: 'ignore' });
    const lane: WorktreeLane = {
      id: input.roundId, kind: 'review', repoPath: input.repoPath, repoName: 'fixture', path,
      branch: null, sha: input.ref, jobId: input.jobId ?? null, roundId: input.roundId, status: 'active',
    };
    this.lanes.set(lane.id, lane);
    return lane;
  }

  getWorktree(id: string): WorktreeLane | null { return this.lanes.get(id) ?? null; }
  listWorktrees(options: { jobId?: string } = {}): readonly WorktreeLane[] {
    return [...this.lanes.values()].filter((lane) => options.jobId === undefined || lane.jobId === options.jobId);
  }
  async release(input: { worktreeId: string }): Promise<WorktreeSweepResult> {
    const lane = this.lanes.get(input.worktreeId);
    if (lane === undefined) throw new Error('missing lane');
    if (lane.kind === 'review' && existsSync(lane.path)) {
      execFileSync('git', ['-C', lane.repoPath, 'worktree', 'remove', '--force', lane.path], { stdio: 'ignore' });
    }
    this.lanes.set(lane.id, { ...lane, status: 'swept' });
    return { status: 'swept', preserved: null, branch: 'none', freshHead: this.sha };
  }
}

class DeferredReviewPort implements WorktreePort {
  constructor(
    private readonly delegate: GitReviewPort,
    private readonly created: () => void,
    private readonly releaseCreate: Promise<void>,
  ) {}

  createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> {
    return this.delegate.createJobWorktree(input);
  }

  async createReviewWorktree(input: { repoPath: string; roundId: string; ref: string; jobId?: string }): Promise<WorktreeLane> {
    const lane = await this.delegate.createReviewWorktree(input);
    this.created();
    await this.releaseCreate;
    return lane;
  }

  getWorktree(id: string): WorktreeLane | null { return this.delegate.getWorktree(id); }
  listWorktrees(options: { jobId?: string } = {}): readonly WorktreeLane[] { return this.delegate.listWorktrees(options); }
  release(input: { worktreeId: string }): Promise<WorktreeSweepResult> { return this.delegate.release(input); }
}

function sourceFor(prompt: string): string {
  if (prompt.includes('source=blind')) return 'blind';
  return /"source": "(blind|edge|acceptance|security|architecture|codebase|tests)"/.exec(prompt)?.[1] ?? 'unknown';
}

/**
 * Hybrid wave spawner: one scripted lead driving the REAL native tools,
 * plus children answering by lens. Security malforms once, then reports
 * the canonical verified blocker — mirroring the pre-hybrid contract.
 */
function makeSpawner(
  root: string,
  order: string[],
  onLeadStart?: () => void,
  answerOverride?: (prompt: string) => string | undefined,
): AgentSpawner {
  let securityAttempts = 0;
  const brain: LeadBrainOptions = {
    onLeadStart: () => {
      order.push('model:lead');
      onLeadStart?.();
    },
    childAnswer: (prompt) => {
      const source = sourceFor(prompt);
      order.push(`model:${source}`);
      return answerOverride?.(prompt) ?? (source === 'security' && securityAttempts++ === 0
        ? 'malformed first attempt'
        : source === 'security'
          ? JSON.stringify([{
              source: 'security', severity: 'blocker', category: 'auth', title: 'Verified security defect',
              location: 'src/main.ts:2', evidence: '  return 43;', detail: 'The changed line demonstrates the security defect.',
              recommended_fix: 'Correct the implementation and add a regression test.',
            }])
          : '[]');
    },
  };
  return fakeHybridSpawner(root, brain).spawner;
}

const repos: FixtureRepo[] = [];
const dbs: LedgerDb[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('GitHub SHA-bound Perkins delivery', () => {
  it('validates host/head/base and posts a commit-bound review payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gh-poster-'));
    const log = join(root, 'calls.jsonl');
    const binary = join(root, 'gh-double.mjs');
    const repoPath = join(root, 'repo');
    execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://git.example.test/acme/widget.git']);
    const head = '1'.repeat(40);
    const base = '2'.repeat(40);
    writeFileSync(binary, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');\nif (!process.argv.includes('--method')) process.stdout.write(${JSON.stringify(`${head}\t${base}\n`)});\n`, 'utf8');
    chmodSync(binary, 0o755);
    const poster = new GhPrPoster(binary);
    await poster.post({
      prUrl: 'https://git.example.test/acme/widget/pull/42', host: 'git.example.test', repoPath,
      body: 'review body\n', targetSha: head, baseSha: base,
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; input: string });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.argv).toEqual(['api', '--hostname', 'git.example.test', 'repos/acme/widget/pulls/42', '--jq', '[.head.sha,.base.sha] | @tsv']);
    expect(calls[1]?.argv).toEqual(['api', '--hostname', 'git.example.test', '--method', 'POST', 'repos/acme/widget/pulls/42/reviews', '--input', '-']);
    expect(JSON.parse(calls[1]!.input)).toEqual({ body: 'review body\n', event: 'COMMENT', commit_id: head });
    await expect(poster.post({
      prUrl: 'https://evil.example/acme/widget/pull/42', host: 'git.example.test', repoPath,
      body: 'x', targetSha: head, baseSha: base,
    })).rejects.toThrow(/host-mismatched/);
    await expect(poster.post({
      prUrl: 'https://git.example.test/acme/widget/pull/42', host: 'git.example.test', repoPath,
      body: 'x', targetSha: head, baseSha: '3'.repeat(40),
    })).rejects.toThrow(/identity moved/);
    execFileSync('git', ['-C', repoPath, 'remote', 'set-url', 'origin', 'https://git.example.test/acme/other.git']);
    await expect(poster.post({
      prUrl: 'https://git.example.test/acme/widget/pull/42', host: 'git.example.test', repoPath,
      body: 'x', targetSha: head, baseSha: base,
    })).rejects.toThrow(/reviewed repository origin/);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('review publication redaction', () => {
  it('masks credential-shaped evidence with a fixed placeholder', () => {
    const token = `${['gh', 'p_'].join('')}${'A'.repeat(24)}`;
    const published = redactReviewForPublication(`Evidence: ${token}\n`);
    expect(published).not.toContain(token);
    expect(published).toBe('Evidence: [REDACTED]\n');
  });

  it('covers every credential pattern including quoted assignments and vendor PATs', () => {
    const githubPat = `${['github', '_pat_'].join('')}${'B'.repeat(22)}`;
    const gitlabToken = `${['glpat', '-'].join('')}${'C'.repeat(22)}`;
    const cases: ReadonlyArray<[string, RegExp]> = [
      ['-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', /\[REDACTED\]/u],
      [`${['sk', '-proj-'].join('')}${'D'.repeat(20)}`, /\[REDACTED\]/u],
      [`AKIA${'E'.repeat(16)}`, /\[REDACTED\]/u],
      [githubPat, /\[REDACTED\]/u],
      [gitlabToken, /\[REDACTED\]/u],
      ['password: "hunter2"', /\[REDACTED\]/u],
      ["api_key = 's3cret value'", /\[REDACTED\]/u],
      ['secret: plainvalue', /\[REDACTED\]/u],
    ];
    for (const [secret, marker] of cases) {
      const published = redactReviewForPublication(`evidence ${secret} end`);
      expect(published).not.toContain(secret);
      expect(published).toMatch(marker);
      expect(published.startsWith('evidence ')).toBe(true);
      expect(published.endsWith(' end')).toBe(true);
    }
  });
});

describe('WaveRunner built-in Perkins production path', () => {
  it('fails closed on bundled-policy setup errors before a round or reviewer spawn', async () => {
    const repo = makeFixtureRepo('perkins-policy-setup-error');
    repos.push(repo);
    const target = repo.head();
    const root = mkdtempSync(join(tmpdir(), 'perkins-policy-setup-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-policy-setup-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-policy-setup-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-policy-error' });
    const job = ledger.addJob({
      id: 'job-policy-error', repo: 'fixture', title: 'policy error', baseBranch: 'main', briefing: 'review this',
    });
    ledger.setJobStatus(job.id, 'working');
    const spawner = vi.fn() as unknown as AgentSpawner;
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts,
      reviewPolicyLoader: () => { throw new Error('bundled perkins-code-review integrity mismatch'); },
    });
    await expect(wave.beginRound({ jobId: job.id })).rejects.toThrow(/integrity mismatch/);
    expect(ledger.getJob(job.id)?.status).toBe('working');
    expect(ledger.listRounds(job.id)).toHaveLength(0);
    expect(port.listWorktrees({ jobId: job.id })).toHaveLength(1);
    expect(spawner).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('rejects an empty/unreviewable diff before promising a live round and releases setup state', async () => {
    const repo = makeFixtureRepo('perkins-wave-empty');
    repos.push(repo);
    const target = repo.head();
    const root = mkdtempSync(join(tmpdir(), 'perkins-empty-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-empty-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-empty-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-empty' });
    const job = ledger.addJob({
      id: 'job-empty', repo: 'fixture', title: 'empty review', baseBranch: 'main', briefing: 'review this',
    });
    ledger.setJobStatus(job.id, 'working');
    const spawner = vi.fn() as unknown as AgentSpawner;
    const wave = new WaveRunner({ ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts });
    await expect(wave.beginRound({ jobId: job.id })).rejects.toThrow(/frozen review diff is empty/);
    const [round] = ledger.listRounds(job.id);
    expect(round?.status).toBe('aborted');
    expect(ledger.getJob(job.id)?.status).toBe('working');
    expect(port.getWorktree(round!.id)?.status).toBe('swept');
    expect(spawner).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('shutdown waits for active setup, aborts its pending round, and releases the created lane', async () => {
    const repo = makeFixtureRepo('perkins-setup-shutdown');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/setup-shutdown']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-setup-shutdown-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-setup-shutdown-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-setup-shutdown-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const delegate = new GitReviewPort(root, 'feature/setup-shutdown', target);
    let markCreated!: () => void;
    const created = new Promise<void>((resolve) => { markCreated = resolve; });
    let releaseCreate!: () => void;
    const release = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const port = new DeferredReviewPort(delegate, markCreated, release);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-setup-shutdown' });
    const job = ledger.addJob({
      id: 'job-setup-shutdown', repo: 'fixture', title: 'setup shutdown', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner, reviewArtifactRoot: artifacts,
    });
    const beginning = wave.beginRound({ jobId: job.id });
    const observedBeginning = beginning.then((value) => value, (error: unknown) => error);
    await created;
    const round = ledger.listRounds(job.id)[0]!;
    let shutdownSettled = false;
    const shutdown = wave.shutdown().then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    releaseCreate();
    await shutdown;
    expect(await observedBeginning).toBeInstanceOf(Error);
    expect(ledger.getRound(round.id)?.status).toBe('aborted');
    expect(ledger.latestRoundEvent(round.id, 'round.perkins-incomplete')?.payload).toMatchObject({
      reason: 'service_shutdown_setup',
    });
    expect(readFileSync(join(artifacts, round.id, 'perkins-report.md'), 'utf8')).toContain('INCOMPLETE');
    expect(port.getWorktree(round.id)?.status).toBe('swept');
    expect(ledger.getJob(job.id)?.status).toBe('working');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('shutdown aborts an active blocked lead with durable INCOMPLETE proof and lane cleanup', async () => {
    const repo = makeFixtureRepo('perkins-blocked-shutdown');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/blocked-shutdown']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-blocked-shutdown-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-blocked-shutdown-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-blocked-shutdown-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-blocked-shutdown-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/blocked-shutdown', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-blocked-shutdown' });
    const job = ledger.addJob({
      id: 'job-blocked-shutdown', repo: 'fixture', title: 'blocked shutdown', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    let leadStarted!: () => void;
    const started = new Promise<void>((resolve) => { leadStarted = resolve; });
    const never = new Promise<void>(() => {});
    let disposed = false;
    const spawner: AgentSpawner = async (_role, options = {}): Promise<AgentHandle> => {
      const sessionFile = join(sessions, 'blocked-lead.jsonl');
      writeFileSync(sessionFile, '', 'utf8');
      return {
        role: 'perkins', id: 'blocked-lead', sessionFile, reviewIsolation: true,
        capabilities: {
          streaming: true, steer: 'native', resume: 'file', images: false,
          thinking: false, thinkingLevelControl: false, followUp: false,
        },
        async prompt() { if (options.reviewLead !== undefined) leadStarted(); await never; },
        async steer() {}, async followUp() {}, subscribe() { return () => {}; },
        health() { return { state: 'streaming', lastActivity: null, sessionFile }; },
        async dispose() { disposed = true; },
      };
    };
    const wave = new WaveRunner({ ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts });
    const running = wave.runRound({ jobId: job.id });
    await started;
    await wave.shutdown();
    const outcome = asWave(await running);
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.round.status).toBe('aborted');
    expect(readFileSync(outcome.reportFile, 'utf8')).toContain('INCOMPLETE');
    expect(port.getWorktree(outcome.round.id)?.status).toBe('swept');
    expect(disposed).toBe(true);
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });

  it('reconciles an interrupted live round as durable INCOMPLETE before startup continues', async () => {
    const repo = makeFixtureRepo('perkins-wave-restart');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/restart']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-restart-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-restart-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-restart-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/restart', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-restart' });
    const job = ledger.addJob({ id: 'job-restart', repo: 'fixture', title: 'restart', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'in-review');
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind', 'security'], targetRef: target });
    await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    ledger.setRoundStatus(round.id, 'live');
    ledger.markLensLive(round.id, 'blind');
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: artifacts,
      escalate: (title) => escalations.push(title),
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(round.id)?.status).toBe('aborted');
    expect(ledger.getRound(round.id)?.lenses.every((chip) => chip.state === 'error')).toBe(true);
    expect(port.getWorktree(round.id)?.status).toBe('swept');
    expect(existsSync(join(artifacts, round.id, 'restart-recovery.json'))).toBe(true);
    expect(existsSync(join(artifacts, round.id, 'perkins-report.md'))).toBe(true);
    expect(escalations[0]).toContain('INCOMPLETE');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('reconciles a pending round when restart happened before review-lane registration', async () => {
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-missing-lane-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const job = ledger.addJob({ id: 'job-missing-lane', repo: 'fixture', title: 'missing lane', baseBranch: 'main', briefing: 'review' });
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind', 'security'], targetRef: 'abc123' });
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-missing-lane-artifacts-'));
    dirs.push(artifacts);
    const portRoot = mkdtempSync(join(tmpdir(), 'perkins-missing-lane-port-'));
    dirs.push(portRoot);
    const port = new GitReviewPort(portRoot, 'main', 'abc123');
    const wave = new WaveRunner({ ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner, reviewArtifactRoot: artifacts });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(round.id)?.status).toBe('aborted');
    expect(ledger.getRound(round.id)?.lenses.every((chip) => chip.state === 'error')).toBe(true);
    expect(existsSync(join(artifacts, round.id, 'restart-recovery.json'))).toBe(true);
  });

  it('does not let a swept lane hide an interrupted pending round during recovery', async () => {
    const repo = makeFixtureRepo('perkins-wave-swept-pending');
    repos.push(repo);
    const target = repo.head();
    const root = mkdtempSync(join(tmpdir(), 'perkins-swept-pending-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-swept-pending-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-swept-pending-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-swept-pending' });
    const job = ledger.addJob({ id: 'job-swept-pending', repo: 'fixture', title: 'swept pending', baseBranch: 'main', briefing: 'review' });
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind'], targetRef: target });
    await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    await port.release({ worktreeId: round.id });
    const wave = new WaveRunner({ ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner, reviewArtifactRoot: artifacts });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(round.id)?.status).toBe('aborted');
    expect(existsSync(join(artifacts, round.id, 'restart-recovery.json'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('sweeps a detached review lane left behind after its round was already terminalized', async () => {
    const repo = makeFixtureRepo('perkins-wave-terminal-cleanup');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/terminal-cleanup']);
    const target = repo.commitFile('src/main.ts', 'export const terminal = true;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-terminal-port-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-terminal-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/terminal-cleanup', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-terminal-cleanup' });
    const job = ledger.addJob({ id: 'job-terminal-cleanup', repo: 'fixture', title: 'terminal', baseBranch: 'main', briefing: 'review' });
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind'], targetRef: target });
    await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    ledger.setRoundStatus(round.id, 'aborted');
    const wave = new WaveRunner({ ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(round.id)?.status).toBe('aborted');
    expect(port.getWorktree(round.id)?.status).toBe('swept');
    rmSync(root, { recursive: true, force: true });
  });

  it('completes a delivered verdict after restart without reposting or marking it incomplete', async () => {
    const repo = makeFixtureRepo('perkins-wave-post-recovery');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/post-recovery']);
    const target = repo.commitFile('src/main.ts', 'export const delivered = true;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-post-recovery-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-post-recovery-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-post-recovery-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/post-recovery', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-post-recovery' });
    const job = ledger.addJob({ id: 'job-post-recovery', repo: 'fixture', title: 'post recovery', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'in-review');
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind'], targetRef: target });
    await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    ledger.setRoundStatus(round.id, 'live');
    ledger.markLensLive(round.id, 'blind');
    ledger.setLensOutcome(round.id, 'blind', 'done', 'delivered');
    ledger.appendCustomEvent({
      kind: 'round.posted', jobId: job.id, roundId: round.id,
      payload: { verdict: 'changes-requested', canonicalVerdict: 'NEEDS CHANGES', url: 'https://example.invalid/pr/1' },
    });
    const poster = { post: vi.fn() };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: artifacts, poster,
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(round.id)).toMatchObject({ status: 'verdict-posted', verdict: 'changes-requested' });
    expect(ledger.latestRoundEvent(round.id, 'round.post-recovered')).not.toBeNull();
    expect(ledger.latestRoundEvent(round.id, 'round.perkins-incomplete')).toBeNull();
    expect(poster.post).not.toHaveBeenCalled();
    expect(port.getWorktree(round.id)?.status).toBe('swept');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('terminalizes a workflow schema exception and preserves an INCOMPLETE report before sweep', async () => {
    const repo = makeFixtureRepo('perkins-wave-workflow-error');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/workflow-error']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-workflow-error-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-workflow-error-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-workflow-error-sessions-'));
    dirs.push(sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-workflow-error-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/workflow-error', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-workflow-error' });
    const job = ledger.addJob({ id: 'job-workflow-error', repo: 'fixture', title: 'workflow error', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    const wave = new WaveRunner({ ledger, worktrees: port, spawner: makeSpawner(sessions, []), reviewArtifactRoot: artifacts });
    const first = asWave(await wave.runRound({ jobId: job.id }));
    expect(first.round.status).toBe('verdict-posted');
    const priorFile = join(first.artifactDirectory!, 'consolidated.json');
    const prior = JSON.parse((await import('node:fs')).readFileSync(priorFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(priorFile, `${JSON.stringify({ ...prior, findings: [{}] }, null, 2)}\n`, 'utf8');

    const second = asWave(await wave.runRound({ jobId: job.id }));
    expect(second.canonicalVerdict).toBe('INCOMPLETE');
    expect(second.round.status).toBe('aborted');
    const directory = join(artifacts, second.round.id);
    expect((await import('node:fs')).readFileSync(join(directory, 'perkins-report.md'), 'utf8')).toContain('INCOMPLETE');
    expect(existsSync(join(directory, 'workflow-error.json'))).toBe(true);
    expect(port.getWorktree(second.round.id)?.status).toBe('swept');
  });

  it('audits the last complete predecessor across an incomplete middle round', async () => {
    const repo = makeFixtureRepo('perkins-wave-prior-continuity');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/prior-continuity']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-prior-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-prior-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-prior-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/prior-continuity', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-prior-continuity' });
    const job = ledger.addJob({
      id: 'job-prior-continuity', repo: 'fixture', title: 'prior continuity', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');

    const firstSessions = mkdtempSync(join(tmpdir(), 'perkins-prior-first-'));
    const first = asWave(await new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(firstSessions, []), reviewArtifactRoot: artifacts,
    }).runRound({ jobId: job.id }));
    expect(first.canonicalVerdict).toBe('NEEDS CHANGES');

    const secondSessions = mkdtempSync(join(tmpdir(), 'perkins-prior-second-'));
    const second = asWave(await new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(secondSessions, [], undefined, (prompt) => {
        if (sourceFor(prompt) === 'security') return 'malformed';
        return '[]';
      }),
      reviewArtifactRoot: artifacts,
    }).runRound({ jobId: job.id }));
    expect(second.canonicalVerdict).toBe('INCOMPLETE');
    expect(second.round.status).toBe('aborted');

    let thirdAuditSeen = false;
    const thirdSessions = mkdtempSync(join(tmpdir(), 'perkins-prior-third-'));
    const third = asWave(await new WaveRunner({
      ledger,
      worktrees: port,
      spawner: (() => {
        const fake = fakeHybridSpawner(thirdSessions, {
          childAnswer: () => '[]',
          priorAudit: () => {
            thirdAuditSeen = true;
            return [{ prior_index: 0, status: 'still-present', evidence: '  return 43;', reason: 'defect remains' }];
          },
        });
        return fake.spawner;
      })(),
      reviewArtifactRoot: artifacts,
    }).runRound({ jobId: job.id }));
    expect(thirdAuditSeen).toBe(true);
    expect(third.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(third.round.status).toBe('verdict-posted');
    const consolidated = JSON.parse(readFileSync(join(third.artifactDirectory!, 'consolidated.json'), 'utf8')) as {
      findings: { title: string; roundOrigin: number }[];
    };
    expect(consolidated.findings).toEqual([
      expect.objectContaining({ title: 'Verified security defect', roundOrigin: 1 }),
    ]);
    for (const directory of [root, artifacts, firstSessions, secondSessions, thirdSessions]) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('withholds a built-in verdict when PR delivery rejects or is absent', async () => {
    for (const mode of ['rejecting', 'absent'] as const) {
    const repo = makeFixtureRepo(`perkins-wave-post-${mode}`);
    repos.push(repo);
    repo.git(['checkout', '-b', `feature/post-${mode}`]);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), `perkins-post-${mode}-port-`));
    const artifacts = mkdtempSync(join(tmpdir(), `perkins-post-${mode}-artifacts-`));
    const sessions = mkdtempSync(join(tmpdir(), `perkins-post-${mode}-sessions-`));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), `perkins-post-${mode}-db-`)));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, `feature/post-${mode}`, target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: `job-post-${mode}` });
    const job = ledger.addJob({
      id: `job-post-${mode}`, repo: 'fixture', title: 'delivery gate', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/10');
    const escalations: string[] = [];
    const poster = mode === 'rejecting'
      ? { post: vi.fn(async () => { throw new Error('posting denied'); }) }
      : undefined;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(sessions, []),
      reviewArtifactRoot: artifacts,
      ...(poster === undefined ? {} : { poster }),
      escalate: (title) => escalations.push(title),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.verdict).toBeNull();
    expect(outcome.posted).toBe(false);
    expect(outcome.round.status).toBe('aborted');
    expect(existsSync(outcome.reportFile!)).toBe(true);
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')?.payload)
      .toMatchObject({ reason: 'report_not_posted' });
    expect(escalations.some((title) => title.includes('NOT posted'))).toBe(true);
    expect(port.getWorktree(outcome.round.id)?.status).toBe('swept');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
    }
  });

  it('freezes a detached tree, runs one lead plus tracked children, posts the exact-head report, and sweeps', async () => {
    const repo = makeFixtureRepo('perkins-wave-built-in');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-wave-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-wave-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-wave-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-wave-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/review', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-built-in' });
    const job = ledger.addJob({
      id: 'job-built-in', repo: 'fixture', title: 'full review', baseBranch: 'main',
      briefing: 'Acceptance: answer returns 43.',
    });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/9');
    const order: string[] = [];
    const poster = { post: vi.fn(async (_input: { readonly prUrl: string; readonly body: string; readonly targetSha: string }) => {
      expect(ledger.listRounds(job.id).at(-1)).toMatchObject({ status: 'live', verdict: null });
    }) };
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(sessions, order),
      poster,
      reviewArtifactRoot: artifacts,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(outcome.verdict).toBe('changes-requested');
    expect(outcome.round.lenses.every((chip) => chip.state === 'done' && chip.agentId === null)).toBe(true);
    expect(outcome.headMoved).toBe(false);
    expect(order.filter((entry) => entry.startsWith('model:'))).toHaveLength(9);
    // The retried security lens registers TWO distinct agent rows: the
    // second attempt is attempt-suffixed, never a duplicate label.
    const roundLabels = ledger
      .listAgents()
      .filter((agent) => agent.roundId === outcome.round.id)
      .map((agent) => agent.label);
    const securityLabels = roundLabels.filter((label) => label?.startsWith('security:'));
    expect(securityLabels).toHaveLength(2);
    expect(securityLabels.some((label) => label?.endsWith('#2'))).toBe(true);
    expect(new Set(roundLabels).size).toBe(roundLabels.length);
    expect(order[0]).toBe('model:lead');
    expect(poster.post).toHaveBeenCalledTimes(1);
    expect(poster.post.mock.calls[0]![0]).toMatchObject({ targetSha: target });
    expect(poster.post.mock.calls[0]![0].body).toContain('NEEDS CHANGES');
    expect(port.getWorktree(outcome.round.id)?.status).toBe('swept');
    expect(existsSync(outcome.reportFile)).toBe(true);
    const events = ledger.listEvents({ limit: 200 });
    expect(events.some((event) => event.kind === 'round.perkins-review')).toBe(true);
    expect(events.some((event) => event.kind === 'round.head-moved')).toBe(false);
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });

  it('freezes recorded verification evidence into the review spec context (tests lens ground truth)', async () => {
    const repo = makeFixtureRepo('perkins-verification-evidence');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/evidence']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-evidence-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-evidence-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-evidence-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-evidence-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/evidence', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-evidence' });
    const job = ledger.addJob({
      id: 'job-evidence', repo: 'fixture', title: 'evidence', baseBranch: 'main',
      briefing: 'Acceptance: answer returns 43.',
    });
    ledger.setJobStatus(job.id, 'working');
    // The scheduler's recorded run on the exact frozen target.
    ledger.appendCustomEvent({
      kind: 'verification.completed',
      jobId: job.id,
      payload: {
        run_id: 'run-evidence',
        scope: 'full',
        command: 'npm test',
        sha: target,
        tracked_dirty: false,
        ok: true,
        exit_code: 0,
        signal: null,
        timed_out: false,
        duration_ms: 4321,
        workers: 6,
        output_bytes: 128,
        output_sha256: 'c'.repeat(64),
      },
    });
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(sessions, []),
      reviewArtifactRoot: artifacts,
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    const specContext = readFileSync(join(outcome.artifactDirectory, 'spec-context.md'), 'utf-8');
    expect(specContext).toContain('Acceptance: answer returns 43.');
    expect(specContext).toContain('HOST-RECORDED VERIFICATION');
    expect(specContext).toContain('result: PASS (exit 0)');
    expect(specContext).toContain(`sha: ${target} (matches the frozen review target)`);
    expect(specContext).toContain('duration_ms: 4321');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });

  it('invalidates a round when the source ref moves during lead work and never posts approval', async () => {
    const repo = makeFixtureRepo('perkins-wave-head-move');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-wave-move-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-wave-move-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-wave-move-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-wave-move-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/review', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-head-move' });
    const job = ledger.addJob({
      id: 'job-head-move', repo: 'fixture', title: 'movement', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/10');
    let moved = false;
    const poster = { post: vi.fn(async () => {}) };
    const spawner = makeSpawner(sessions, [], () => {
      if (moved) return;
      moved = true;
      repo.commitFile('src/later.ts', 'export const later = true;\n', 'move during review');
    });
    const wave = new WaveRunner({ ledger, worktrees: port, spawner, poster, reviewArtifactRoot: artifacts });

    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(moved).toBe(true);
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.verdict).toBeNull();
    expect(outcome.posted).toBe(false);
    expect(outcome.round.status).toBe('aborted');
    expect(poster.post).not.toHaveBeenCalled();
    expect(readFileSync(outcome.reportFile, 'utf8')).toContain('INCOMPLETE');
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.posted')).toBeNull();
    expect(port.getWorktree(outcome.round.id)?.status).toBe('swept');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });
});

describe('bmad-review fallback gate (user amendment 2026-09-20, fork-3)', () => {
  interface GateHarness {
    wave: WaveRunner;
    job: { readonly id: string };
    ledger: LedgerApi;
    port: GitReviewPort;
    root: string;
    artifacts: string;
    sessions: string;
    db: LedgerDb;
    escalations: string[];
    reviews: number[];
    directives: string[];
    repo: FixtureRepo;
  }

  function gateHarness(rounds: FallbackFinding[][]): GateHarness {
    const repo = makeFixtureRepo('perkins-fallback-gate');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/fallback']);
    const target = repo.commitFile('src/fix.ts', 'export const fix = 1;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-gate-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-gate-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-gate-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-gate-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/fallback', target);
    const escalations: string[] = [];
    const reviews: number[] = [];
    const directives: string[] = [];
    const skillFile = join(artifacts, 'skills', 'bmad-review', 'SKILL.md');
    mkdirSync(dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, '---\nname: bmad-review\n---\ninstalled skill bytes', 'utf8');
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(sessions, []),
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({
        ok: false,
        failures: [preflightFailure('model-provider', 'review model provider is not authenticated: acme')],
      }),
      fallbackGate: {
        skillPath: skillFile,
        runFallbackReview: async (input) => {
          reviews.push(input.iteration);
          writeFileSync(input.reportFile, JSON.stringify(rounds[input.iteration - 1] ?? []), 'utf8');
          return rounds[input.iteration - 1] ?? [];
        },
        fixDirectiveSink: async (input) => {
          directives.push(input.directive);
          return { delivered: true, minionId: 'minion-1' };
        },
      },
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const job = ledger.addJob({ id: 'job-fallback-gate', repo: 'fixture', title: 'fallback', baseBranch: 'main' });
    return { wave, job, ledger, port, root, artifacts, sessions, db, escalations, reviews, directives, repo };
  }

  function gateEvents(harness: GateHarness): Array<Record<string, unknown>> {
    return harness.ledger
      .listEvents({ limit: 200 })
      .filter((event) => event.kind === 'job.fallback-review' && event.jobId === harness.job.id)
      .map((event) => event.payload as Record<string, unknown>);
  }

  function cleanupGate(harness: GateHarness): void {
    rmSync(harness.root, { recursive: true, force: true });
    rmSync(harness.artifacts, { recursive: true, force: true });
    rmSync(harness.sessions, { recursive: true, force: true });
  }

  it('triages, routes the blocker fix directive to the minion, re-reviews, and passes clean', async () => {
    const harness = gateHarness([
      [
        { title: 'broken build', category: 'broken-build', location: 'src/fix.ts:1', evidence: 'export const fix = 1;', detail: 'does not compile' },
        { title: 'naming nit', category: 'style', location: 'src/fix.ts:1', evidence: 'export const fix = 1;', detail: 'prefer clearer name' },
      ],
      [],
    ]);
    try {
      await harness.port.createJobWorktree({ repoPath: harness.repo.path, jobId: harness.job.id });
      const outcome = await harness.wave.runRound({ jobId: harness.job.id });
      if (!('route' in outcome)) throw new Error('expected the bmad-review fallback route');
      expect(outcome.skillInstalled).toBe(true);
      expect(outcome.failedLegs.map((leg) => leg.leg)).toEqual(['model-provider']);
      expect(harness.reviews).toEqual([1, 2]);
      expect(harness.directives).toHaveLength(1);
      expect(harness.directives[0]).toContain('broken build');
      expect(harness.directives[0]).not.toContain('naming nit');
      expect(outcome.clearToMerge).toBe(true);
      expect(outcome.blockers).toBe(0);
      expect(outcome.notes).toBe(0); // final round triaged clean
      expect(outcome.iterations).toBe(2);
      expect(outcome.reportFiles).toHaveLength(2);
      const phases = gateEvents(harness).map((payload) => payload['phase']).reverse();
      expect(phases).toEqual(['started', 'triaged', 'fix-directive', 'triaged', 'pass']);
      expect(harness.escalations.some((line) => line.includes('clear to merge'))).toBe(true);
      // The fallback gate never creates a Perkins round or verdict.
      expect(harness.ledger.listRounds(harness.job.id)).toHaveLength(0);
    } finally {
      cleanupGate(harness);
    }
  });

  it('terminates blocked when blockers survive the review bound', async () => {
    const blocker: FallbackFinding = {
      title: 'persistent defect', category: 'correctness', location: 'src/fix.ts:1',
      evidence: 'export const fix = 1;', detail: 'still wrong',
    };
    const harness = gateHarness([[blocker], [blocker], [blocker], [blocker]]);
    try {
      await harness.port.createJobWorktree({ repoPath: harness.repo.path, jobId: harness.job.id });
      const outcome = await harness.wave.runRound({ jobId: harness.job.id });
      if (!('route' in outcome)) throw new Error('expected the bmad-review fallback route');
      expect(outcome.clearToMerge).toBe(false);
      expect(outcome.iterations).toBe(4);
      expect(outcome.blockers).toBe(1);
      expect(harness.reviews).toEqual([1, 2, 3, 4]);
      expect(harness.directives).toHaveLength(3);
      const phases = gateEvents(harness).map((payload) => payload['phase']).reverse();
      expect(phases.at(-1)).toBe('blocked');
      expect(harness.escalations.some((line) => line.includes('BLOCKED'))).toBe(true);
    } finally {
      cleanupGate(harness);
    }
  });

  it('reports both options when the skill is not installed and never reviews', async () => {
    const repo = makeFixtureRepo('perkins-fallback-no-skill');
    repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'perkins-gate-noskill-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-gate-noskill-artifacts-'));
    const noskillSessions = mkdtempSync(join(tmpdir(), 'perkins-gate-noskill-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-gate-noskill-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-no-skill' });
    const job = ledger.addJob({ id: 'job-no-skill', repo: 'fixture', title: 'no skill', baseBranch: 'main' });
    let reviewed = 0;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(noskillSessions, []),
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({ ok: false, failures: [preflightFailure('review-policy', 'the Perkins review gate is disabled in config')] }),
      fallbackGate: {
        skillPath: join(artifacts, 'missing', 'SKILL.md'),
        runFallbackReview: async () => {
          reviewed += 1;
          return [];
        },
        fixDirectiveSink: async () => ({ delivered: true }),
      },
      escalate: () => {},
    });
    try {
      const outcome = await wave.runRound({ jobId: job.id });
      if (!('route' in outcome)) throw new Error('expected the bmad-review fallback route');
      expect(outcome.skillInstalled).toBe(false);
      expect(outcome.clearToMerge).toBe(false);
      expect(reviewed).toBe(0);
      expect(outcome.note).toContain('install the BMAD review skill via onboarding');
      expect(outcome.note).toContain('[review] enabled = true');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
      rmSync(noskillSessions, { recursive: true, force: true });
    }
  });

  it('refuses a direct beginRound when the pre-flight routes to the fallback gate', async () => {
    const harness = gateHarness([[]]);
    try {
      await harness.port.createJobWorktree({ repoPath: harness.repo.path, jobId: harness.job.id });
      await expect(harness.wave.beginRound({ jobId: harness.job.id })).rejects.toThrow(/bmad-review fallback gate/u);
      expect(harness.ledger.listRounds(harness.job.id)).toHaveLength(0);
    } finally {
      cleanupGate(harness);
    }
  });
});

describe('GitLab SHA-bound merge-request delivery', () => {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const mrUrl = 'https://gitlab.example.test/acme/widget/-/merge_requests/7';

  function fixture(): { repoPath: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gl-poster-'));
    const repoPath = join(root, 'repo');
    execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://gitlab.example.test/acme/widget.git']);
    return { repoPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  function fetchDouble(response: { status: number; body?: string }, calls: Array<{ url: string; init?: unknown }>) {
    return async (url: string, init?: unknown): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
      calls.push({ url, init });
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        text: async () => response.body ?? '',
      };
    };
  }

  it('binds host/origin/head/base and posts a commit-bound note', async () => {
    const { repoPath, cleanup } = fixture();
    try {
      const calls: Array<{ url: string; init?: unknown }> = [];
      const poster = new GitLabMrPoster({
        token: 'glpat-token',
        fetchImpl: fetchDouble({ status: 200, body: JSON.stringify({ sha: head, diff_refs: { base_sha: base } }) }, calls),
      });
      await poster.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'review body\n', targetSha: head, baseSha: base });
      // identity probe, note POST, post-delivery confirmation probe
      expect(calls).toHaveLength(3);
      expect(calls[0]?.url).toBe('https://gitlab.example.test/api/v4/projects/acme%2Fwidget/merge_requests/7');
      expect((calls[0]?.init as { headers: Record<string, string> }).headers['PRIVATE-TOKEN']).toBe('glpat-token');
      expect(calls[1]?.url).toContain('/notes');
      expect(JSON.parse((calls[1]?.init as { body: string }).body)).toEqual({ body: 'review body\n' });
      expect(calls[2]?.url).toBe(calls[0]?.url);
    } finally {
      cleanup();
    }
  });

  it('fails closed on moved identity, missing token, origin mismatch, and HTTP failure', async () => {
    const { repoPath, cleanup } = fixture();
    try {
      const calls: Array<{ url: string; init?: unknown }> = [];
      const moved = new GitLabMrPoster({
        token: 'glpat-token',
        fetchImpl: fetchDouble({ status: 200, body: JSON.stringify({ sha: head, diff_refs: { base_sha: 'c'.repeat(40) } }) }, calls),
      });
      await expect(moved.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'x', targetSha: head, baseSha: base }))
        .rejects.toThrow(/identity moved/u);
      expect(calls).toHaveLength(1);

      const noToken = new GitLabMrPoster({ fetchImpl: fetchDouble({ status: 200, body: '{}' }, []) });
      await expect(noToken.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'x', targetSha: head, baseSha: base }))
        .rejects.toThrow(/GITLAB_TOKEN/u);

      const poster = new GitLabMrPoster({ token: 't', fetchImpl: fetchDouble({ status: 200, body: JSON.stringify({ sha: head, diff_refs: { base_sha: base } }) }, []) });
      await expect(poster.post({
        prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'x', targetSha: head, baseSha: base,
      })).resolves.toBeUndefined();

      const wrongRepo = mkdtempSync(join(tmpdir(), 'perkins-gl-wrong-'));
      try {
        const other = join(wrongRepo, 'repo');
        execFileSync('git', ['init', other], { stdio: 'ignore' });
        execFileSync('git', ['-C', other, 'remote', 'add', 'origin', 'https://gitlab.example.test/acme/other.git']);
        await expect(poster.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath: other, body: 'x', targetSha: head, baseSha: base }))
          .rejects.toThrow(/does not match the reviewed repository origin/u);
      } finally {
        rmSync(wrongRepo, { recursive: true, force: true });
      }

      const failing = new GitLabMrPoster({ token: 't', fetchImpl: fetchDouble({ status: 500, body: 'boom' }, []) });
      await expect(failing.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'x', targetSha: head, baseSha: base }))
        .rejects.toThrow(/HTTP 500/u);
    } finally {
      cleanup();
    }
  });

  it('routes by code host and refuses unsupported hosts', async () => {
    const github = { post: vi.fn(async () => {}) };
    const gitlab = { post: vi.fn(async () => {}) };
    const poster = new AutoVerdictPoster(github, gitlab);
    const base = { prUrl: 'https://x', host: 'x', repoPath: '/r', body: 'b', targetSha: 'h', baseSha: 'b' };
    await poster.post({ ...base, prUrl: 'https://github.com/acme/widget/pull/1', host: 'github.com' });
    expect(github.post).toHaveBeenCalledTimes(1);
    await poster.post({ ...base, prUrl: 'https://gitlab.com/acme/widget/-/merge_requests/2', host: 'gitlab.com' });
    expect(gitlab.post).toHaveBeenCalledTimes(1);
    await expect(poster.post({ ...base, prUrl: 'https://code.company.test/acme/widget/-/merge_requests/3', host: 'code.company.test' }))
      .rejects.toThrow(/unsupported code host/u);
    expect(github.post).toHaveBeenCalledTimes(1);
    expect(gitlab.post).toHaveBeenCalledTimes(1);
  });
});

describe('orphan review-lane recovery', () => {
  it('sweeps a review lane whose ledger round is missing', async () => {
    const repo = makeFixtureRepo('perkins-orphan-lane');
    const root = mkdtempSync(join(tmpdir(), 'perkins-orphan-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-orphan-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-orphan-db-')));
    dbs.push(db);
    dirs.push(root, artifacts);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', repo.head());
    await port.createReviewWorktree({ repoPath: repo.path, roundId: 'orphan-round', ref: 'HEAD' });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(mkdtempSync(join(tmpdir(), 'perkins-orphan-sessions-')), []),
      reviewArtifactRoot: artifacts,
      escalate: () => {},
    });
    const recovered = await wave.recoverInterruptedRounds();
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(port.getWorktree('orphan-round')?.status).toBe('swept');
  });
});

describe('WaveRunner request guards', () => {
  it('rejects terminal jobs and lane-less jobs at request time without touching state', async () => {
    const repo = makeFixtureRepo('perkins-guard-terminals');
    repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'perkins-guards-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-guards-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-guards-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-guards-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', repo.head());
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), reviewArtifactRoot: artifacts,
    });
    for (const status of ['merged', 'done'] as const) {
      await port.createJobWorktree({ repoPath: repo.path, jobId: `job-${status}` });
      const job = ledger.addJob({ id: `job-${status}`, repo: 'fixture', title: status, baseBranch: 'main', briefing: 'b' });
      // Legal path into the terminal states is via in-review.
      ledger.setJobStatus(job.id, 'working');
      ledger.setJobStatus(job.id, 'in-review');
      ledger.setJobStatus(job.id, status);
      await expect(wave.runRound({ jobId: job.id })).rejects.toThrow(/terminal lanes do not go back under review/u);
    }
    const laneless = ledger.addJob({ id: 'job-laneless', repo: 'fixture', title: 'no lane', baseBranch: 'main', briefing: 'b' });
    await expect(wave.runRound({ jobId: laneless.id })).rejects.toThrow(/no job worktree lane/u);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-missing-briefing' });
    const noBriefing = ledger.addJob({ id: 'job-missing-briefing', repo: 'fixture', title: 'no briefing', baseBranch: 'main' });
    await expect(wave.runRound({ jobId: noBriefing.id })).rejects.toThrow(/requires the job briefing\/spec or explicit noSpec/u);
    await expect(wave.runRound({ jobId: noBriefing.id, noSpec: true, lenses: ['blind'] }))
      .rejects.toThrow(/canonical and cannot be reduced/u);
  });

  it('records a verdict when the job has no PR link, without posting or INCOMPLETE noise', async () => {
    const repo = makeFixtureRepo('perkins-wave-no-pr');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/no-pr']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-no-pr-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-no-pr-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-no-pr-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-no-pr-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/no-pr', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-no-pr' });
    const job = ledger.addJob({ id: 'job-no-pr', repo: 'fixture', title: 'no pr', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    const poster = { post: vi.fn(async () => {}) };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), poster, reviewArtifactRoot: artifacts,
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.verdict).toBe('changes-requested');
    expect(outcome.posted).toBe(false);
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.perkins-review')).not.toBeNull();
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')).toBeNull();
    expect(poster.post).not.toHaveBeenCalled();
  });
});

describe('poster transport negatives and fallback-gate terminals', () => {
  it('rejects unparseable URLs, missing gh binaries, and failed probes', async () => {
    const poster = new GhPrPoster('/nonexistent/gh-binary');
    await expect(poster.post({
      prUrl: 'not a url', host: 'x', repoPath: '/r', body: 'b', targetSha: 'h', baseSha: 'b',
    })).rejects.toThrow(/cannot parse pull request URL/u);
    await expect(poster.post({
      prUrl: 'https://github.com/acme/widget/pull/1', host: 'github.com', repoPath: '/r',
      body: 'b', targetSha: 'h', baseSha: 'b',
    })).rejects.toThrow(/unavailable|origin/u);
  });

  it('resolves the GitLab token as GITLAB_TOKEN falling back to GL_TOKEN', async () => {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gl-token-'));
    const originalGitlab = process.env['GITLAB_TOKEN'];
    const originalGl = process.env['GL_TOKEN'];
    try {
      const repoPath = join(root, 'repo');
      execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
      execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://gitlab.example.test/acme/widget.git']);
      const seen: string[] = [];
      const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
        seen.push(init?.headers?.['PRIVATE-TOKEN'] ?? '');
        return { ok: true, status: 200, text: async () => JSON.stringify({ sha: 'h', diff_refs: { base_sha: 'b' } }) };
      };
      process.env['GITLAB_TOKEN'] = 'primary-token';
      process.env['GL_TOKEN'] = 'fallback-token';
      const primary = new GitLabMrPoster({ fetchImpl });
      await primary.post({
        prUrl: 'https://gitlab.example.test/acme/widget/-/merge_requests/7',
        host: 'gitlab.example.test', repoPath, body: 'x', targetSha: 'h', baseSha: 'b',
      });
      expect(seen[0]).toBe('primary-token');
      delete process.env['GITLAB_TOKEN'];
      const fallback = new GitLabMrPoster({ fetchImpl });
      await fallback.post({
        prUrl: 'https://gitlab.example.test/acme/widget/-/merge_requests/7',
        host: 'gitlab.example.test', repoPath, body: 'x', targetSha: 'h', baseSha: 'b',
      });
      expect(seen.at(-1)).toBe('fallback-token');
    } finally {
      if (originalGitlab === undefined) delete process.env['GITLAB_TOKEN'];
      else process.env['GITLAB_TOKEN'] = originalGitlab;
      if (originalGl === undefined) delete process.env['GL_TOKEN'];
      else process.env['GL_TOKEN'] = originalGl;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the not-configured variant when no fallbackGate option exists', async () => {
    const repo = makeFixtureRepo('perkins-gate-unconfigured');
    const root = mkdtempSync(join(tmpdir(), 'perkins-gate-unconf-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-gate-unconf-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-gate-unconf-db-')));
    dbs.push(db);
    dirs.push(root, artifacts);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-unconfigured' });
    const job = ledger.addJob({ id: 'job-unconfigured', repo: 'fixture', title: 'unconfigured', baseBranch: 'main' });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(mkdtempSync(join(tmpdir(), 'perkins-gate-unconf-sessions-')), []),
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({
        ok: false,
        failures: [{ leg: 'model-provider', detail: 'no provider', remediation: 'configure one' }],
      }),
      escalate: () => {},
    });
    const outcome = await wave.runRound({ jobId: job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.skillInstalled).toBe(false);
    expect(outcome.note).toContain('not configured');
    expect(outcome.clearToMerge).toBe(false);
  });
});

describe('production defaultFallbackReview (BLOCKER-1 fix)', () => {
  async function makeProductionGateHarness(options: {
    findingToWrite: readonly Record<string, string>[];
    skillContent?: string;
  }): Promise<{
    wave: WaveRunner;
    job: { readonly id: string };
    ledger: LedgerApi;
    port: GitReviewPort;
    root: string;
    artifacts: string;
    sessions: string;
    repo: FixtureRepo;
    skillPath: string;
    prompts: string[];
    spawnCwds: string[];
    escalations: string[];
  }> {
    const repo = makeFixtureRepo('perkins-prod-gate');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/prod-gate']);
    repo.commitFile('src/prod.ts', 'export const prod = 1;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-prod-gate-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/prod-gate', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-prod-gate' });
    const job = ledger.addJob({ id: 'job-prod-gate', repo: 'fixture', title: 'prod gate', baseBranch: 'main' });
    const skillPath = join(artifacts, 'skills', 'bmad-review', 'SKILL.md');
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, options.skillContent ?? '---\nname: bmad-review\n---\nreview skill bytes', 'utf8');
    const prompts: string[] = [];
    const spawnCwds: string[] = [];
    const escalations: string[] = [];
    const spawner: AgentSpawner = async (role, spawnOptions = {}) => {
      spawnCwds.push(spawnOptions.cwd ?? '');
      const file = join(sessions, `prod-${spawnCwds.length}.jsonl`);
      writeFileSync(file, '', 'utf8');
      return {
        role,
        id: `prod-minion-${spawnCwds.length}`,
        sessionFile: file,
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        reviewIsolation: undefined,
        async prompt(text: string) {
          prompts.push(text);
          // The minion writes the findings JSON to the requested report file
          const reportMatch = /Write your findings as ONE JSON array to exactly this file: (.+)$/mu.exec(text);
          if (reportMatch !== null) {
            writeFileSync(reportMatch[1]!, JSON.stringify(options.findingToWrite), 'utf8');
          }
        },
        async steer() {},
        async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle', lastActivity: null, sessionFile: file }; },
        async dispose() {},
      };
    };
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner,
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({
        ok: false,
        failures: [preflightFailure('review-policy', 'the Perkins review gate is disabled')],
      }),
      // NO runFallbackReview — the production default runs
      fallbackGate: {
        skillPath,
        fixDirectiveSink: async () => ({ delivered: true, minionId: 'prod-1' }),
      },
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    return { wave, job, ledger, port, root, artifacts, sessions, repo, skillPath, prompts, spawnCwds, escalations };
  }

  it('spawns a minion with the skill prompt, parses findings, and reports clear-to-merge on clean', async () => {
    const h = await makeProductionGateHarness({ findingToWrite: [] });
    try {
      const outcome = await h.wave.runRound({ jobId: h.job.id });
      if (!('route' in outcome)) throw new Error('expected fallback route');
      expect(h.prompts).toHaveLength(1);
      expect(h.prompts[0]).toContain(h.skillPath);
      expect(h.prompts[0]).toContain('WORKING DIFF');
      expect(h.spawnCwds[0]).toBe(h.repo.path);
      expect(outcome.clearToMerge).toBe(true);
      expect(outcome.iterations).toBe(1);
      expect(outcome.reportFiles).toHaveLength(1);
      const phases = h.ledger.listEvents({ limit: 100 })
        .filter((event) => event.kind === 'job.fallback-review')
        .map((event) => (event.payload as { phase?: string }).phase)
        .reverse();
      expect(phases).toEqual(['started', 'triaged', 'pass']);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
      rmSync(h.artifacts, { recursive: true, force: true });
      rmSync(h.sessions, { recursive: true, force: true });
    }
  });

  it('terminalizes blocked when the minion never writes the report file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-nores-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-nores-art-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-nores-ses-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-prod-gate-nores-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', makeFixtureRepo('perkins-prod-gate-nores-repo').head());
    await port.createJobWorktree({ repoPath: makeFixtureRepo('perkins-prod-gate-nores-repo2').path, jobId: 'job-nores' });
    const job = ledger.addJob({ id: 'job-nores', repo: 'fixture', title: 'no report', baseBranch: 'main' });
    const skillPath = join(artifacts, 'SKILL.md');
    writeFileSync(skillPath, 'skill', 'utf8');
    let promptText = '';
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: async (role) => {
        const file = join(sessions, 'prod-nres.jsonl');
        writeFileSync(file, '', 'utf8');
        return {
          role, id: 'prod-nres', sessionFile: file,
          capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
          async prompt(text: string) { promptText = text; /* deliberately does NOT write the report */ },
          async steer() {}, async followUp() {},
          subscribe() { return () => {}; },
          health() { return { state: 'idle', lastActivity: null, sessionFile: file }; },
          async dispose() {},
        };
      },
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({
        ok: false,
        failures: [{ leg: 'model-provider', detail: 'not authed', remediation: 'auth' }],
      }),
      fallbackGate: {
        skillPath,
        fixDirectiveSink: async () => ({ delivered: true }),
      },
      escalate: () => {},
    });
    const outcome = await wave.runRound({ jobId: job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(false);
    expect(outcome.iterations).toBe(1); // first round throws (no report file) → blocked immediately
    expect(outcome.skillInstalled).toBe(true);
    expect(promptText).toContain('WORKING DIFF');
    const phases = ledger.listEvents({ limit: 200 })
      .filter((event) => event.kind === 'job.fallback-review')
      .map((event) => (event.payload as { phase?: string }).phase);
    expect(phases[0]).toBe('blocked'); // newest-first order
  });
});


describe('fallback diff includes untracked files (V3 revert-mutation pin)', () => {
  it('round-2 diff includes new-file fixes created by the fix directive', async () => {
    const repo = makeFixtureRepo('perkins-untracked-fix');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/untracked']);
    repo.commitFile('src/base.ts', 'export const base = 1;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-untracked-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-untracked-art-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-untracked-ses-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-untracked-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/untracked', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-untracked-fix' });
    const job = ledger.addJob({ id: 'job-untracked-fix', repo: 'fixture', title: 'untracked', baseBranch: 'main' });
    const skillFile = join(artifacts, 'SKILL.md');
    writeFileSync(skillFile, 'skill', 'utf8');
    const escalations: string[] = [];
    const diffsSeen: string[] = [];
    const blocker: FallbackFinding[] = [
      { title: 'missing feature', category: 'correctness', location: 'src/new.ts:1', evidence: 'N/A', detail: 'new file needed' },
    ];
    const wave = new WaveRunner({
      ledger, worktrees: port,
      spawner: makeSpawner(sessions, []),
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({
        ok: false,
        failures: [preflightFailure('review-policy', 'disabled')],
      }),
      fallbackGate: {
        skillPath: skillFile,
        runFallbackReview: async (input) => {
          diffsSeen.push(input.diff);
          const findings = input.iteration === 1 ? blocker : [];
          writeFileSync(input.reportFile, JSON.stringify(findings), 'utf8');
          return findings;
        },
        fixDirectiveSink: async () => {
          writeFileSync(join(repo.path, 'src', 'new-feature.ts'), 'export const fixed = true;\n');
          return { delivered: true, minionId: 'm1' };
        },
      },
      escalate: (title) => escalations.push(title),
    });
    const outcome = await wave.runRound({ jobId: job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(true);
    expect(diffsSeen.length).toBe(2);
    expect(diffsSeen[0]).not.toContain('new-feature.ts');
    expect(diffsSeen[1]).toContain('new-feature.ts');
  });
});

describe('fallback review timeout constant is exported and positive (V4 pin)', () => {
  it('pins the 15-minute wall-clock bound', async () => {
    const { FALLBACK_REVIEW_TIMEOUT_MS } = await import('../src/dispatch/perkins.js');
    expect(FALLBACK_REVIEW_TIMEOUT_MS).toBe(15 * 60 * 1_000);
    expect(FALLBACK_REVIEW_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('lens agent labels are unique across retries', () => {
  it('mints the classic label on attempt 1 and the attempt-suffixed label on retry', () => {
    expect(lensAgentLabel('blind', '001', 1)).toBe('blind:001');
    expect(lensAgentLabel('blind', '001', 2)).toBe('blind:001#2');
    // A retry never collides with its first attempt.
    expect(lensAgentLabel('blind', '001', 2)).not.toBe(lensAgentLabel('blind', '001', 1));
    expect(lensAgentLabel('edge', 'a-01', 2)).toBe('edge:a-01#2');
  });
});
