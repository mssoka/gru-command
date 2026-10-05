import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PrHeadVerificationError,
  prBranchCandidate,
  resolveFreshPrHead,
  type PrHeadProbe,
} from '../src/dispatch/perkins-review/fresh-head.js';
import { WaveRunner, type FallbackGateOutcome, type WaveOutcome } from '../src/dispatch/perkins.js';
import type { AgentSpawner } from '../src/dispatch/service.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { makeFixtureRepo, attachBareOrigin, type FixtureRepo } from './helpers/fixture-repo.js';
import { GitReviewPort } from './helpers/git-review-port.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';
import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from '../src/dispatch/worktree-port.js';

/** Wraps GitReviewPort so the JOB LANE lives at a real linked worktree
 * (path ≠ the host checkout) — the divergence shape the stock double
 * cannot model, and exactly how production lanes differ from the host
 * clone the resolver is handed (Perkins R3: worktree-relative refs must
 * resolve against the LANE, never the host). */
class LaneWorktreePort implements WorktreePort {
  private jobLane: WorktreeLane | null = null;

  constructor(
    private readonly delegate: GitReviewPort,
    private readonly lanePath: string,
  ) {}

  private withLanePath(lane: WorktreeLane): WorktreeLane {
    return this.jobLane !== null && lane.id === this.jobLane.id ? this.jobLane : lane;
  }

  async createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> {
    const lane = await this.delegate.createJobWorktree(input);
    this.jobLane = { ...lane, path: this.lanePath };
    return this.jobLane;
  }

  async resolveReviewTarget(input: { repoPath: string; ref: string }) {
    return this.delegate.resolveReviewTarget(input);
  }

  async createReviewWorktree(input: { repoPath: string; roundId: string; ref: string; jobId?: string }) {
    return this.delegate.createReviewWorktree(input);
  }

  getWorktree(id: string): WorktreeLane | null {
    const lane = this.delegate.getWorktree(id);
    return lane === null ? null : this.withLanePath(lane);
  }

  listWorktrees(options: { jobId?: string } = {}): readonly WorktreeLane[] {
    return this.delegate.listWorktrees(options).map((lane) => this.withLanePath(lane));
  }

  async release(input: { worktreeId: string }): Promise<WorktreeSweepResult> {
    return this.delegate.release(input);
  }
}

/**
 * Hotfix pins: a Perkins round that reviews a PR branch freezes the LIVE
 * fetched branch tip and the live code-host head — never the recorded lane
 * pointer, and never a branch name synthesized from the job id. The PR's
 * own `headRefName` decides WHICH branch is sourced; the fetched tip must
 * equal the PR head or the request aborts before a round row, a review
 * worktree, or any lens exists. The happy path and explicit commit pins
 * are unchanged; unlinked jobs keep the lane-local resolution. Every
 * fixture is a real git repo with a real bare origin.
 */

const repos: FixtureRepo[] = [];
const dbs: LedgerDb[] = [];
const cleanupDirs: string[] = [];

afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dbs.length > 0) dbs.pop()!.close();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

function asWave(outcome: WaveOutcome | FallbackGateOutcome): WaveOutcome {
  if (!('route' in outcome)) return outcome;
  throw new Error(`expected a Perkins wave outcome, got ${outcome.route}`);
}

/** Branch-idle guard (2026-09-23): a review arm is refused while the target
 * lane is busy — a dispatched/working job with no settled delivery for its
 * current attempt. These fixtures review already-delivered lanes, so record
 * the delivery each fixture implies and let the guard see an idle lane. */
function settleLane(ledger: LedgerApi, jobId: string): void {
  ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: 'fixture-settled' } });
}

function fixedProbe(headRefName: string, headSha: string): PrHeadProbe {
  return async () => ({ headRefName, headSha });
}

/** Advance `branch` on the bare origin from an isolated clone, leaving the
 * fixture's local branch behind: the recorded-vs-live split to freeze. */
function advanceOriginBranch(origin: string, branch: string, file: string, content: string): string {
  const clone = mkdtempSync(join(tmpdir(), 'gru-freeze-clone-'));
  cleanupDirs.push(clone);
  execFileSync('git', ['clone', '--quiet', '--branch', branch, origin, clone], { stdio: 'ignore' });
  writeFileSync(join(clone, file), content, 'utf-8');
  const identity = ['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid'];
  execFileSync('git', ['-C', clone, 'add', file], { stdio: 'ignore' });
  execFileSync('git', ['-C', clone, ...identity, 'commit', '-m', 'advance origin head'], { stdio: 'ignore' });
  execFileSync('git', ['-C', clone, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { stdio: 'ignore' });
  return execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

/** Fixture where the local reviewed branch is STALE: origin advanced from a
 * clone, the local ref was left behind. Returns the live origin tip. */
function staleLocalFixture(name: string): { repo: FixtureRepo; stale: string; tip: string } {
  const repo = makeFixtureRepo(name);
  repos.push(repo);
  repo.git(['checkout', '-b', 'feature/lane']);
  const stale = repo.commitFile('src/one.ts', 'export const one = 1;\n');
  const origin = attachBareOrigin(repo);
  repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
  const tip = advanceOriginBranch(origin, 'feature/lane', 'src/two.ts', 'export const two = 2;\n');
  return { repo, stale, tip };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (error: unknown) => error,
  );
}

describe('fresh PR head resolution (freeze source of truth)', () => {
  it('uses the freshly fetched origin tip when the recorded local branch is stale', async () => {
    const { repo, stale, tip } = staleLocalFixture('freeze-fresh-unit');
    const fresh = await resolveFreshPrHead({
      repoPath: repo.path,
      prUrl: 'https://github.com/acme/fixture/pull/7',
      branchRef: 'feature/lane',
      probe: fixedProbe('feature/lane', tip),
    });
    expect(fresh.targetSha).toBe(tip);
    expect(fresh.prHeadSha).toBe(tip);
    expect(fresh.movementRef).toBe('origin/feature/lane');
    expect(repo.git(['rev-parse', 'refs/remotes/origin/feature/lane'])).toBe(tip);
    // The recorded local ref is a hint only: it is never rewritten.
    expect(repo.git(['rev-parse', 'refs/heads/feature/lane'])).toBe(stale);
  });

  it('keeps the happy path intact when recorded == fetched == PR head', async () => {
    const repo = makeFixtureRepo('freeze-fresh-happy');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    const tip = repo.commitFile('src/one.ts', 'export const one = 1;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
    const fresh = await resolveFreshPrHead({
      repoPath: repo.path,
      prUrl: 'https://github.com/acme/fixture/pull/8',
      branchRef: 'feature/lane',
      probe: fixedProbe('feature/lane', tip),
    });
    expect(fresh.targetSha).toBe(tip);
    expect(fresh.movementRef).toBe('origin/feature/lane');
  });

  it('rejects a fetched tip that disagrees with the live code-host head', async () => {
    const { repo, stale, tip } = staleLocalFixture('freeze-fresh-mismatch');
    const failure = await captureFailure(() =>
      resolveFreshPrHead({
        repoPath: repo.path,
        prUrl: 'https://github.com/acme/fixture/pull/9',
        branchRef: 'feature/lane',
        // The probe reports the stale recorded head while origin is at tip.
        probe: fixedProbe('feature/lane', stale),
      }),
    );
    expect(failure).toBeInstanceOf(PrHeadVerificationError);
    expect((failure as PrHeadVerificationError).code).toBe('head-mismatch');
    expect((failure as Error).message).toContain(tip);
    expect((failure as Error).message).toContain(stale);
  });

  it('freezes the PR head branch even when the lane candidate names another branch', async () => {
    const repo = makeFixtureRepo('freeze-fresh-lane-vs-pr');
    repos.push(repo);
    repo.git(['checkout', '-b', 'gru/job-lane']);
    repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/gru/job-lane']);
    repo.git(['checkout', '-b', 'gru/pr-head']);
    const tip = repo.commitFile('src/pr.ts', 'export const pr = true;\n');
    repo.git(['push', '--quiet', 'origin', 'refs/heads/gru/pr-head']);
    const fresh = await resolveFreshPrHead({
      repoPath: repo.path,
      prUrl: 'https://github.com/acme/fixture/pull/10',
      // The default arm's candidate is the lane ref `gru/<jobId>` — a name
      // the PR was never opened from. BOTH branches exist on origin, so only
      // the PR identity may choose the freeze source.
      branchRef: 'gru/job-lane',
      probe: fixedProbe('gru/pr-head', tip),
    });
    expect(fresh.prHeadRefName).toBe('gru/pr-head');
    expect(fresh.targetSha).toBe(tip);
    expect(fresh.movementRef).toBe('origin/gru/pr-head');
    expect(repo.git(['rev-parse', 'refs/remotes/origin/gru/pr-head'])).toBe(tip);
  });

  it('fails closed when the branch cannot be fetched fresh', async () => {
    const repo = makeFixtureRepo('freeze-fresh-nofetch');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    repo.commitFile('src/one.ts', 'export const one = 1;\n');
    // No origin remote at all: the freeze source cannot be read, even
    // though the local branch resolves.
    const failure = await captureFailure(() =>
      resolveFreshPrHead({
        repoPath: repo.path,
        prUrl: 'https://github.com/acme/fixture/pull/11',
        branchRef: 'feature/lane',
        probe: fixedProbe('feature/lane', '0'.repeat(40)),
      }),
    );
    expect(failure).toBeInstanceOf(PrHeadVerificationError);
    expect((failure as PrHeadVerificationError).code).toBe('fetch-failed');
  });

  it('wraps a failing host probe as probe-failed', async () => {
    const repo = makeFixtureRepo('freeze-fresh-probefail');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    repo.commitFile('src/one.ts', 'export const one = 1;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
    const failure = await captureFailure(() =>
      resolveFreshPrHead({
        repoPath: repo.path,
        prUrl: 'https://github.com/acme/fixture/pull/12',
        branchRef: 'feature/lane',
        probe: async () => {
          throw new Error('host API down');
        },
      }),
    );
    expect(failure).toBeInstanceOf(PrHeadVerificationError);
    expect((failure as PrHeadVerificationError).code).toBe('probe-failed');
    expect((failure as Error).message).toContain('host API down');
  });

  it('classifies branch candidates and leaves SHAs, tags, and expressions as pins', async () => {
    const repo = makeFixtureRepo('freeze-fresh-candidates');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/here']);
    const sha = repo.commitFile('src/one.ts', 'export const one = 1;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/here']);
    repo.git(['fetch', '--quiet', 'origin']);
    repo.git(['tag', 'v1']);
    expect(prBranchCandidate(repo.path, 'feature/here')).toBe('feature/here');
    expect(prBranchCandidate(repo.path, 'refs/heads/feature/here')).toBe('feature/here');
    expect(prBranchCandidate(repo.path, 'origin/feature/here')).toBe('feature/here');
    expect(prBranchCandidate(repo.path, 'refs/remotes/origin/feature/here')).toBe('feature/here');
    expect(prBranchCandidate(repo.path, sha)).toBeNull();
    expect(prBranchCandidate(repo.path, 'v1')).toBeNull();
    expect(prBranchCandidate(repo.path, 'HEAD~1')).toBeNull();
  });
});

describe('freeze-time integration on PR rounds', () => {
  function makeLedger(): LedgerApi {
    const db = new LedgerDb(tempDir('gru-freeze-db-'));
    dbs.push(db);
    return new LedgerApi(db.handle, { bus: new EventBus() });
  }

  it('runs a PR round against the fetched origin tip, not the recorded lane ref', async () => {
    const { repo, stale, tip } = staleLocalFixture('freeze-fresh-wave');
    const root = tempDir('gru-freeze-port-');
    const artifacts = tempDir('gru-freeze-artifacts-');
    const sessions = tempDir('gru-freeze-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', stale);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-fresh' });
    const job = ledger.addJob({
      id: 'job-fresh', repo: 'fixture', title: 'fresh head', baseBranch: 'main',
      briefing: 'Acceptance: two returns 2.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/13');
    const poster = {
      post: vi.fn(async (input: { readonly targetSha: string; readonly body: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: input.targetSha,
        headSha: input.targetSha, baseSha: 'stub-base',
        bodySha256: createHash('sha256').update(input.body, 'utf8').digest('hex'),
      })),
    };
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      poster,
      reviewArtifactRoot: artifacts,
      prHeadProbe: fixedProbe('feature/lane', tip),
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('READY TO MERGE');
    expect(outcome.round.targetRef).toBe(tip);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string; readonly targetRef: string };
    expect(manifest.targetSha).toBe(tip);
    expect(manifest.targetRef).toBe('origin/feature/lane');
    expect(poster.post).toHaveBeenCalledTimes(1);
    expect(poster.post.mock.calls[0]![0]).toMatchObject({ targetSha: tip });
  });

  it('aborts a PR round before any lens when the code-host head disagrees with the fetched tip', async () => {
    const { repo, stale, tip } = staleLocalFixture('freeze-fresh-abort');
    const root = tempDir('gru-freeze-abort-port-');
    const artifacts = tempDir('gru-freeze-abort-artifacts-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', stale);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-abort' });
    const job = ledger.addJob({
      id: 'job-abort', repo: 'fixture', title: 'mystery sha', baseBranch: 'main',
      briefing: 'Acceptance: two returns 2.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/14');
    const spawner = vi.fn() as unknown as AgentSpawner;
    const escalations: { title: string; detail: string }[] = [];
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner,
      reviewArtifactRoot: artifacts,
      // The host reports the STALE recorded head: fetched tip and PR head
      // disagree, so no lens may run on either identity.
      prHeadProbe: fixedProbe('feature/lane', stale),
      escalate: (title, detail): void => { escalations.push({ title, detail }); },
    });

    await expect(wave.runRound({ jobId: job.id })).rejects.toBeInstanceOf(PrHeadVerificationError);
    expect(spawner).not.toHaveBeenCalled();
    expect(ledger.listRounds(job.id)).toHaveLength(0);
    expect(port.listWorktrees({ jobId: job.id }).filter((lane) => lane.kind === 'review')).toHaveLength(0);
    // The failed setup leaves the lane exactly where it was.
    expect(ledger.getJob(job.id)?.status).toBe('working');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.title).toContain('blocked before any round');
    expect(escalations[0]!.detail).toContain(tip);
    const blocked = ledger.listJobEvents(job.id).find((event) => event.kind === 'job.review-freeze-blocked');
    expect(blocked?.payload).toMatchObject({ code: 'head-mismatch', branchRef: 'feature/lane' });
  });

  it('keeps an explicit commit pin reviewable without fetching or probing the host', async () => {
    const repo = makeFixtureRepo('freeze-fresh-pin');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    const pin = repo.commitFile('src/one.ts', 'export const one = 1;\n');
    const root = tempDir('gru-freeze-pin-port-');
    const artifacts = tempDir('gru-freeze-pin-artifacts-');
    const sessions = tempDir('gru-freeze-pin-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', pin);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-pin' });
    const job = ledger.addJob({
      id: 'job-pin', repo: 'fixture', title: 'pinned target', baseBranch: 'main',
      briefing: 'Acceptance: one returns 1.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/15');
    const probe = vi.fn(async () => {
      throw new Error('the host probe must not be reached for a commit pin');
    }) as unknown as PrHeadProbe;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      poster: {
        post: vi.fn(async (input: { readonly targetSha: string; readonly body: string }) => ({
          reviewId: '9002', actor: 'gru-bot', event: 'COMMENTED', commitId: input.targetSha,
          headSha: input.targetSha, baseSha: 'stub-base',
          bodySha256: createHash('sha256').update(input.body, 'utf8').digest('hex'),
        })),
      },
      reviewArtifactRoot: artifacts,
      prHeadProbe: probe,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: pin }));
    expect(outcome.round.targetRef).toBe(pin);
    expect(outcome.verdict).toBe('approved');
    expect(probe).not.toHaveBeenCalled();
  });

  it('freezes a rebase-style lane on the PR head branch, not the un-pushed job lane', async () => {
    const repo = makeFixtureRepo('freeze-pr-head-lane');
    repos.push(repo);
    repo.git(['checkout', '-b', 'gru/job-rebase']);
    const laneSha = repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    // The PR's actual head lives on another branch; the job lane branch is
    // local-only — the rebase-60 shape: the work was pushed to the PR branch.
    repo.git(['checkout', '-b', 'feature/pr-head']);
    const tip = repo.commitFile('src/pr.ts', 'export const pr = true;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/pr-head']);
    const root = tempDir('gru-freeze-prhead-port-');
    const artifacts = tempDir('gru-freeze-prhead-artifacts-');
    const sessions = tempDir('gru-freeze-prhead-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'gru/job-rebase', laneSha);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-rebase' });
    const job = ledger.addJob({
      id: 'job-rebase', repo: 'fixture', title: 'rebase lane', baseBranch: 'main',
      briefing: 'Acceptance: pr returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/16');
    const poster = {
      post: vi.fn(async (input: { readonly targetSha: string; readonly body: string }) => ({
        reviewId: '9003', actor: 'gru-bot', event: 'COMMENTED', commitId: input.targetSha,
        headSha: input.targetSha, baseSha: 'stub-base',
        bodySha256: createHash('sha256').update(input.body, 'utf8').digest('hex'),
      })),
    };
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      poster,
      reviewArtifactRoot: artifacts,
      // The PR reports its real head branch; `gru/job-rebase` is never fetched.
      prHeadProbe: fixedProbe('feature/pr-head', tip),
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('READY TO MERGE');
    expect(outcome.round.targetRef).toBe(tip);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string; readonly targetRef: string };
    expect(manifest.targetSha).toBe(tip);
    expect(manifest.targetRef).toBe('origin/feature/pr-head');
    expect(poster.post).toHaveBeenCalledTimes(1);
  });

  it('keeps the lane-local resolution for a job with no linked PR', async () => {
    const repo = makeFixtureRepo('freeze-no-pr');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    const laneSha = repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    // No origin remote at all: a non-PR round must not need one.
    const root = tempDir('gru-freeze-nopr-port-');
    const artifacts = tempDir('gru-freeze-nopr-artifacts-');
    const sessions = tempDir('gru-freeze-nopr-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', laneSha);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-no-pr' });
    const job = ledger.addJob({
      id: 'job-no-pr', repo: 'fixture', title: 'no pr', baseBranch: 'main',
      briefing: 'Acceptance: lane returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const probe = vi.fn(async () => {
      throw new Error('the host probe must not run without a linked PR');
    }) as unknown as PrHeadProbe;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
      prHeadProbe: probe,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.round.targetRef).toBe(laneSha);
    expect(probe).not.toHaveBeenCalled();
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string; readonly targetRef: string };
    expect(manifest.targetSha).toBe(laneSha);
    expect(manifest.targetRef).toBe('feature/lane');
  });

  it('a non-PR origin/topic target FREEZES the fetched tip, never the stale local tracking ref (Perkins blocker)', async () => {
    const repo = makeFixtureRepo('freeze-nopr-moving');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    const origin = attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane:refs/heads/topic']);
    // origin/topic advances from an isolated clone — the local tracking
    // ref is left behind (the remote-ahead round shape).
    const tip = advanceOriginBranch(origin, 'topic', 'src/moved.ts', 'export const moved = true;\n');
    const stale = repo.git(['rev-parse', 'refs/remotes/origin/topic']);
    expect(tip).not.toBe(stale);
    const root = tempDir('gru-freeze-nopr-move-port-');
    const artifacts = tempDir('gru-freeze-nopr-move-artifacts-');
    const sessions = tempDir('gru-freeze-nopr-move-sessions-');
    const ledger = makeLedger();
    // Exercise the production manager through the WHOLE round, not the
    // copied GitReviewPort resolver. Job creation fetches main only;
    // origin/topic is still stale until freeze resolves it.
    const port = new WorktreeManager({
      ledger, root, preserveRoot: tempDir('gru-freeze-nopr-move-preserves-'),
      setupTimeoutMs: 30_000, enumerateProcesses: () => [],
    });
    const resolveTarget = vi.spyOn(port, 'resolveReviewTarget');
    const job = ledger.addJob({
      id: 'job-nopr-moving', repo: 'fixture', title: 'moving origin target', baseBranch: 'main',
      briefing: 'Acceptance: moved returns true.',
    });
    await port.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    expect(repo.git(['rev-parse', 'refs/remotes/origin/topic'])).toBe(stale);
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const probe = vi.fn(async () => {
      throw new Error('the host probe must not run without a linked PR');
    }) as unknown as PrHeadProbe;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
      prHeadProbe: probe,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: 'origin/topic' }));
    expect(probe).not.toHaveBeenCalled();
    // The round, the manifest, and the bytes under review are ALL the
    // FETCHED tip — one fetch-aware resolution, never the stale ref.
    expect(outcome.round.targetRef).toBe(tip);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string; readonly targetRef: string };
    expect(manifest.targetSha).toBe(tip);
    // Freeze called the real manager's fetch-aware resolver. Its real
    // detached worktree registered the same SHA as the frozen manifest.
    expect(resolveTarget).toHaveBeenCalledWith({ repoPath: realpathSync(repo.path), ref: 'origin/topic' });
    expect(port.getWorktree(outcome.round.id)?.sha).toBe(tip);
    expect(repo.git(['rev-parse', 'refs/remotes/origin/topic'])).toBe(tip);
  });

  it('a non-PR origin/topic that was NEVER tracked locally still freezes the remote tip', async () => {
    const repo = makeFixtureRepo('freeze-nopr-untracked');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    const origin = attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    // topic exists ONLY on the remote: pushed from an isolated clone, never
    // fetched — the local repo cannot resolve it at all.
    const clone = mkdtempSync(join(tmpdir(), 'gru-freeze-remote-only-'));
    cleanupDirs.push(clone);
    execFileSync('git', ['clone', '--quiet', '--branch', 'main', origin, clone], { stdio: 'ignore' });
    execFileSync('git', ['-C', clone, 'checkout', '--quiet', '-b', 'topic'], { stdio: 'ignore' });
    writeFileSync(join(clone, 'src/remote-only.ts'), 'export const remoteOnly = 1;\n', 'utf-8');
    const identity = ['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid'];
    execFileSync('git', ['-C', clone, 'add', 'src/remote-only.ts'], { stdio: 'ignore' });
    execFileSync('git', ['-C', clone, ...identity, 'commit', '-m', 'remote-only topic tip'], { stdio: 'ignore' });
    execFileSync('git', ['-C', clone, 'push', '--quiet', 'origin', 'HEAD:refs/heads/topic'], { stdio: 'ignore' });
    const tip = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    expect(() => repo.git(['show-ref', '--verify', 'refs/remotes/origin/topic'])).toThrow();
    const root = tempDir('gru-freeze-nopr-untracked-port-');
    const artifacts = tempDir('gru-freeze-nopr-untracked-artifacts-');
    const sessions = tempDir('gru-freeze-nopr-untracked-sessions-');
    const ledger = makeLedger();
    const laneSha = repo.git(['rev-parse', 'HEAD']);
    const port = new GitReviewPort(root, 'feature/lane', laneSha);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-nopr-untracked' });
    const job = ledger.addJob({
      id: 'job-nopr-untracked', repo: 'fixture', title: 'remote-only target', baseBranch: 'main',
      briefing: 'Acceptance: remoteOnly returns 1.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: 'origin/topic' }));
    expect(outcome.round.targetRef).toBe(tip);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string };
    expect(manifest.targetSha).toBe(tip);
    expect(repo.git(['rev-parse', 'refs/remotes/origin/topic'])).toBe(tip);
  });

  it('a non-PR origin/topic whose fetch fails REFUSES before any round exists', async () => {
    const repo = makeFixtureRepo('freeze-nopr-refuse');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane:refs/heads/topic']);
    repo.git(['remote', 'set-url', 'origin', join(repo.path, '..', 'missing-origin.git')]);
    const root = tempDir('gru-freeze-nopr-refuse-port-');
    const artifacts = tempDir('gru-freeze-nopr-refuse-artifacts-');
    const ledger = makeLedger();
    const port = new WorktreeManager({
      ledger, root, preserveRoot: tempDir('gru-freeze-nopr-refuse-preserves-'),
      setupTimeoutMs: 30_000, enumerateProcesses: () => [],
    });
    const resolveTarget = vi.spyOn(port, 'resolveReviewTarget');
    const spawner = vi.fn() as unknown as AgentSpawner;
    const job = ledger.addJob({
      id: 'job-nopr-refuse', repo: 'fixture', title: 'unfetchable target', baseBranch: 'main',
      briefing: 'Acceptance: lane returns true.',
    });
    await port.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner,
      reviewArtifactRoot: artifacts,
    });

    const failure = await captureFailure(() => wave.runRound({ jobId: job.id, targetRef: 'origin/topic' }));
    expect((failure as Error).message).toMatch(/refusing to check out a possibly stale origin tip/);
    expect(resolveTarget).toHaveBeenCalledWith({ repoPath: realpathSync(repo.path), ref: 'origin/topic' });
    expect(spawner).not.toHaveBeenCalled();
    expect(port.listWorktrees({ jobId: job.id }).filter((lane) => lane.kind === 'review')).toHaveLength(0);
    expect(ledger.listRounds(job.id)).toHaveLength(0);
    expect(ledger.getJob(job.id)?.status).toBe('working');
  });

  it('an explicit HEAD target freezes the LANE commit when host and lane HEADs diverged (Perkins R3)', async () => {
    const repo = makeFixtureRepo('freeze-head-lane');
    repos.push(repo);
    // Lane work happens on its own branch; the host checkout stays on
    // main — host HEAD and lane HEAD genuinely diverge.
    repo.git(['checkout', '--quiet', '-b', 'feature/lane']);
    const laneCommit = repo.commitFile('src/lane-ahead.ts', 'export const laneAhead = true;\n');
    repo.git(['checkout', '--quiet', 'main']);
    const hostHead = repo.git(['rev-parse', 'HEAD']);
    expect(laneCommit).not.toBe(hostHead); // the divergence is real
    const lanePath = tempDir('gru-freeze-head-lanepath-');
    cleanupDirs.push(lanePath);
    repo.git(['worktree', 'add', '--quiet', lanePath, 'feature/lane']);
    expect(repo.git(['rev-parse', 'HEAD'], lanePath)).toBe(laneCommit);

    const root = tempDir('gru-freeze-head-port-');
    const artifacts = tempDir('gru-freeze-head-artifacts-');
    const sessions = tempDir('gru-freeze-head-sessions-');
    const ledger = makeLedger();
    const port = new LaneWorktreePort(new GitReviewPort(root, 'feature/lane', laneCommit), lanePath);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-head-lane' });
    const job = ledger.addJob({
      id: 'job-head-lane', repo: 'fixture', title: 'explicit head on a diverged lane', baseBranch: 'main',
      briefing: 'Acceptance: laneAhead returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const probe = vi.fn(async () => {
      throw new Error('the host probe must not run without a linked PR');
    }) as unknown as PrHeadProbe;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
      prHeadProbe: probe,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: 'HEAD' }));
    expect(probe).not.toHaveBeenCalled();
    // HEAD is WORKTREE-RELATIVE: the frozen target is the LANE commit,
    // never the host checkout's (behind) HEAD.
    expect(outcome.round.targetRef).toBe(laneCommit);
    expect(outcome.round.targetRef).not.toBe(hostHead);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string; readonly targetRef: string };
    expect(manifest.targetSha).toBe(laneCommit);
    expect(manifest.targetRef).toBe('HEAD');
  });

  it('a remote-only origin/topic on a linked PR NEVER bypasses PR-head verification — the PR head is frozen (Perkins R3)', async () => {
    const repo = makeFixtureRepo('freeze-remoteonly-pr');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    const laneSha = repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    const origin = attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
    // A remote-only topic branch at a DIFFERENT commit than the PR head —
    // pushed from an isolated clone, never fetched into the fixture.
    const clone = mkdtempSync(join(tmpdir(), 'gru-freeze-decoy-'));
    cleanupDirs.push(clone);
    execFileSync('git', ['clone', '--quiet', '--branch', 'feature/lane', origin, clone], { stdio: 'ignore' });
    execFileSync('git', ['-C', clone, 'checkout', '--quiet', '-b', 'topic'], { stdio: 'ignore' });
    writeFileSync(join(clone, 'src/decoy.ts'), 'export const decoy = true;\n', 'utf-8');
    const identity = ['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid'];
    execFileSync('git', ['-C', clone, 'add', 'src/decoy.ts'], { stdio: 'ignore' });
    execFileSync('git', ['-C', clone, ...identity, 'commit', '-m', 'decoy topic tip'], { stdio: 'ignore' });
    execFileSync('git', ['-C', clone, 'push', '--quiet', 'origin', 'HEAD:refs/heads/topic'], { stdio: 'ignore' });
    const decoy = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    expect(decoy).not.toBe(laneSha); // the refetch would freeze UNRELATED bytes
    expect(() => repo.git(['show-ref', '--verify', 'refs/remotes/origin/topic'])).toThrow(); // remote-only

    const root = tempDir('gru-freeze-decoy-port-');
    const artifacts = tempDir('gru-freeze-decoy-artifacts-');
    const sessions = tempDir('gru-freeze-decoy-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', laneSha);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-decoy-topic' });
    const job = ledger.addJob({
      id: 'job-decoy-topic', repo: 'fixture', title: 'remote-only origin ref on a linked PR', baseBranch: 'main',
      briefing: 'Acceptance: lane returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/21');
    const probe = vi.fn(fixedProbe('feature/lane', laneSha));
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
      prHeadProbe: probe,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: 'origin/topic' }));
    // The live PR head was verified and frozen — the decoy topic tip never.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(outcome.round.targetRef).toBe(laneSha);
    expect(outcome.round.targetRef).not.toBe(decoy);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string; readonly targetRef: string };
    expect(manifest.targetSha).toBe(laneSha);
    expect(manifest.targetRef).toBe('origin/feature/lane');
  });

  it('an origin-prefixed REVISION PIN (origin/feature/lane~1) on a linked PR freezes the named ancestor, never the live PR tip (Perkins R4)', async () => {
    const repo = makeFixtureRepo('freeze-pin-expr-pr');
    repos.push(repo);
    repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    repo.git(['checkout', '-b', 'feature/lane']);
    const laneFirst = repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    const laneTip = repo.commitFile('src/lane2.ts', 'export const lane2 = true;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
    const ancestor = repo.git(['rev-parse', 'origin/feature/lane~1']);
    expect(ancestor).toBe(laneFirst);
    expect(ancestor).not.toBe(laneTip); // the ancestor is NOT the PR head

    const root = tempDir('gru-freeze-expr-pr-port-');
    const artifacts = tempDir('gru-freeze-expr-pr-artifacts-');
    const sessions = tempDir('gru-freeze-expr-pr-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', laneTip);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-pin-expr-pr' });
    const job = ledger.addJob({
      id: 'job-pin-expr-pr', repo: 'fixture', title: 'origin-prefixed revision pin on a linked PR', baseBranch: 'main',
      briefing: 'Acceptance: lane returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/22');
    const probe = vi.fn(async () => {
      throw new Error('a revision pin must not probe the host');
    }) as unknown as PrHeadProbe;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
      prHeadProbe: probe,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: 'origin/feature/lane~1' }));
    expect(probe).not.toHaveBeenCalled();
    // The NAMED ANCESTOR is the frozen target — not the live PR tip.
    expect(outcome.round.targetRef).toBe(ancestor);
    expect(outcome.round.targetRef).not.toBe(laneTip);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string; readonly targetRef: string };
    expect(manifest.targetSha).toBe(ancestor);
    expect(manifest.targetRef).toBe('origin/feature/lane~1');
  });

  it('an origin-prefixed REVISION PIN (origin/feature/lane~1) on a non-PR round resolves the named ancestor — no literal branch fetch (Perkins R4)', async () => {
    const repo = makeFixtureRepo('freeze-pin-expr-nopr');
    repos.push(repo);
    repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 44;\n}\n');
    repo.git(['checkout', '-b', 'feature/lane']);
    const laneFirst = repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    const laneTip = repo.commitFile('src/lane2.ts', 'export const lane2 = true;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
    const ancestor = repo.git(['rev-parse', 'origin/feature/lane~1']);
    expect(ancestor).toBe(laneFirst);
    expect(ancestor).not.toBe(laneTip);

    const root = tempDir('gru-freeze-expr-nopr-port-');
    const artifacts = tempDir('gru-freeze-expr-nopr-artifacts-');
    const sessions = tempDir('gru-freeze-expr-nopr-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', laneTip);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-pin-expr-nopr' });
    const job = ledger.addJob({
      id: 'job-pin-expr-nopr', repo: 'fixture', title: 'origin-prefixed revision pin, non-PR', baseBranch: 'main',
      briefing: 'Acceptance: lane returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: 'origin/feature/lane~1' }));
    // The named ancestor freezes — the pre-fix code FETCHED a literal
    // branch named "feature/lane~1" and refused.
    expect(outcome.round.targetRef).toBe(ancestor);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string };
    expect(manifest.targetSha).toBe(ancestor);
  });

  it('a SHORT origin/topic spelling COLLIDING with a real remote branch follows PR verification — the local tag never bypasses it (Perkins r6 B2)', async () => {
    const repo = makeFixtureRepo('freeze-collide-pr');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    const laneFirst = repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    const laneTip = repo.commitFile('src/lane2.ts', 'export const lane2 = true;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
    // The remote REALLY HAS a branch named topic (the collision), and the
    // local tag origin/topic points at UNRELATED bytes. The tracking ref
    // is absent so the tag wins DWIM cleanly — the exploitable shape
    // (a tracking ref would make the lookup ambiguous and safe).
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main:refs/heads/topic']);
    repo.git(['update-ref', '-d', 'refs/remotes/origin/topic']);
    repo.git(['tag', 'origin/topic', laneFirst]);
    expect(repo.git(['rev-parse', 'origin/topic'])).toBe(laneFirst);
    expect(repo.git(['rev-parse', '--symbolic-full-name', '--verify', 'origin/topic'])).toBe(
      'refs/tags/origin/topic',
    );

    const root = tempDir('gru-freeze-collide-port-');
    const artifacts = tempDir('gru-freeze-collide-artifacts-');
    const sessions = tempDir('gru-freeze-collide-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', laneTip);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-collide' });
    const job = ledger.addJob({
      id: 'job-collide', repo: 'fixture', title: 'short origin spelling colliding with a remote branch', baseBranch: 'main',
      briefing: 'Acceptance: lane returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/24');
    const probe = vi.fn(fixedProbe('feature/lane', laneTip));
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
      prHeadProbe: probe,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: 'origin/topic' }));
    // The colliding SHORT spelling means the REMOTE branch: PR-head
    // verification ran (probe called) and the VERIFIED PR head froze —
    // the local tag never substituted its unrelated bytes.
    expect(probe).toHaveBeenCalledTimes(1);
    expect(outcome.round.targetRef).toBe(laneTip);
    expect(outcome.round.targetRef).not.toBe(laneFirst);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string };
    expect(manifest.targetSha).toBe(laneTip);
  });

  it('a FULLY QUALIFIED refs/tags/origin/topic pin is preserved even when the remote branch collides (Perkins r6 B2)', async () => {
    const repo = makeFixtureRepo('freeze-collide-qualified');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    const laneFirst = repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    const laneTip = repo.commitFile('src/lane2.ts', 'export const lane2 = true;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main:refs/heads/topic']);
    repo.git(['tag', 'origin/topic', laneFirst]);

    const root = tempDir('gru-freeze-collideq-port-');
    const artifacts = tempDir('gru-freeze-collideq-artifacts-');
    const sessions = tempDir('gru-freeze-collideq-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', laneTip);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-collide-qualified' });
    const job = ledger.addJob({
      id: 'job-collide-qualified', repo: 'fixture', title: 'fully qualified tag pin beside a colliding remote branch', baseBranch: 'main',
      briefing: 'Acceptance: lane returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/25');
    const probe = vi.fn(async () => {
      throw new Error('a fully qualified tag pin must not probe the host');
    }) as unknown as PrHeadProbe;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
      prHeadProbe: probe,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: 'refs/tags/origin/topic' }));
    expect(probe).not.toHaveBeenCalled();
    // The caller was explicit about the tag: those exact bytes freeze,
    // collision or not.
    expect(outcome.round.targetRef).toBe(laneFirst);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string };
    expect(manifest.targetSha).toBe(laneFirst);
  });

  it('an explicit TAG pin origin/v1 on a linked PR stays frozen — never silently replaced by the live PR head (Perkins R5)', async () => {
    const repo = makeFixtureRepo('freeze-tag-pin-pr');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    const laneFirst = repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    const laneTip = repo.commitFile('src/lane2.ts', 'export const lane2 = true;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
    // The explicit pin is a local TAG named origin/v1 at the lane's FIRST
    // commit — a different commit than the live PR head.
    repo.git(['tag', 'origin/v1', laneFirst]);
    const tagSha = repo.git(['rev-parse', 'origin/v1']);
    expect(repo.git(['rev-parse', '--symbolic-full-name', '--verify', 'origin/v1'])).toBe(
      'refs/tags/origin/v1',
    );
    expect(tagSha).not.toBe(laneTip); // the tag and the PR head differ

    const root = tempDir('gru-freeze-tagpin-port-');
    const artifacts = tempDir('gru-freeze-tagpin-artifacts-');
    const sessions = tempDir('gru-freeze-tagpin-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', laneTip);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-tag-pin-pr' });
    const job = ledger.addJob({
      id: 'job-tag-pin-pr', repo: 'fixture', title: 'explicit tag pin on a linked PR', baseBranch: 'main',
      briefing: 'Acceptance: lane returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/23');
    const probe = vi.fn(async () => {
      throw new Error('an explicit tag pin must not probe the host');
    }) as unknown as PrHeadProbe;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
      prHeadProbe: probe,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: 'origin/v1' }));
    expect(probe).not.toHaveBeenCalled();
    // The TAG SHA stays frozen — never the substituted live PR head.
    expect(outcome.round.targetRef).toBe(tagSha);
    expect(outcome.round.targetRef).not.toBe(laneTip);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string; readonly targetRef: string };
    expect(manifest.targetSha).toBe(tagSha);
    expect(manifest.targetRef).toBe('origin/v1');
  });

  it('an explicit TAG pin origin/v1 on a non-PR round freezes the tag — consistent routing', async () => {
    const repo = makeFixtureRepo('freeze-tag-pin-nopr');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    const laneFirst = repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    const laneTip = repo.commitFile('src/lane2.ts', 'export const lane2 = true;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
    repo.git(['tag', 'origin/v1', laneFirst]);
    const tagSha = repo.git(['rev-parse', 'origin/v1']);
    expect(tagSha).not.toBe(laneTip);

    const root = tempDir('gru-freeze-tagpin-nopr-port-');
    const artifacts = tempDir('gru-freeze-tagpin-nopr-artifacts-');
    const sessions = tempDir('gru-freeze-tagpin-nopr-sessions-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'feature/lane', laneTip);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-tag-pin-nopr' });
    const job = ledger.addJob({
      id: 'job-tag-pin-nopr', repo: 'fixture', title: 'explicit tag pin, non-PR', baseBranch: 'main',
      briefing: 'Acceptance: lane returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      reviewArtifactRoot: artifacts,
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: 'origin/v1' }));
    expect(outcome.round.targetRef).toBe(tagSha);
    const manifest = JSON.parse(
      readFileSync(join(artifacts, outcome.round.id, 'manifest.json'), 'utf8'),
    ) as { readonly targetSha: string };
    expect(manifest.targetSha).toBe(tagSha);
  });

  it('aborts before any round when the resolved PR head ref fetches nothing', async () => {
    const repo = makeFixtureRepo('freeze-unfetchable');
    repos.push(repo);
    repo.git(['checkout', '-b', 'gru/job-lane']);
    const laneSha = repo.commitFile('src/lane.ts', 'export const lane = true;\n');
    attachBareOrigin(repo); // origin exists, but the reported head branch is not pushed
    const root = tempDir('gru-freeze-unfetchable-port-');
    const artifacts = tempDir('gru-freeze-unfetchable-artifacts-');
    const ledger = makeLedger();
    const port = new GitReviewPort(root, 'gru/job-lane', laneSha);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-missing' });
    const job = ledger.addJob({
      id: 'job-missing', repo: 'fixture', title: 'unfetchable head', baseBranch: 'main',
      briefing: 'Acceptance: lane returns true.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/17');
    const spawner = vi.fn() as unknown as AgentSpawner;
    const escalations: { title: string; detail: string }[] = [];
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner,
      reviewArtifactRoot: artifacts,
      // The PR reports a head branch origin does not carry: the resolved ref
      // fetches nothing, so the round must not start.
      prHeadProbe: fixedProbe('gru/pr-head', laneSha),
      escalate: (title, detail): void => { escalations.push({ title, detail }); },
    });

    const failure = await captureFailure(() => wave.runRound({ jobId: job.id }));
    expect(failure).toBeInstanceOf(PrHeadVerificationError);
    expect((failure as PrHeadVerificationError).code).toBe('fetch-failed');
    expect(spawner).not.toHaveBeenCalled();
    expect(ledger.listRounds(job.id)).toHaveLength(0);
    expect(port.listWorktrees({ jobId: job.id }).filter((lane) => lane.kind === 'review')).toHaveLength(0);
    // The failed setup leaves the lane exactly where it was.
    expect(ledger.getJob(job.id)?.status).toBe('working');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.title).toContain('blocked before any round');
    expect(escalations[0]!.detail).toContain('gru/pr-head');
    const blocked = ledger.listJobEvents(job.id).find((event) => event.kind === 'job.review-freeze-blocked');
    expect(blocked?.payload).toMatchObject({ code: 'fetch-failed', branchRef: 'gru/job-lane' });
  });
});
