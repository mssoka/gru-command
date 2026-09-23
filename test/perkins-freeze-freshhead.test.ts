import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { makeFixtureRepo, attachBareOrigin, type FixtureRepo } from './helpers/fixture-repo.js';
import { GitReviewPort } from './helpers/git-review-port.js';
import { fakeHybridSpawner } from './helpers/perkins-hybrid-double.js';

/**
 * Hotfix pins: a Perkins round that reviews a PR branch freezes the LIVE
 * fetched branch tip and the live code-host head — never the recorded lane
 * pointer. Recorded != fetched uses fetched; a head disagreement aborts
 * before a round row, a review worktree, or any lens exists; the happy
 * path (recorded == fetched == PR head) and explicit commit pins are
 * unchanged. Every fixture is a real git repo with a real bare origin.
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

  it('rejects a code-host head branch that is not the reviewed branch', async () => {
    const repo = makeFixtureRepo('freeze-fresh-branch-mismatch');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lane']);
    const tip = repo.commitFile('src/one.ts', 'export const one = 1;\n');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/lane']);
    const failure = await captureFailure(() =>
      resolveFreshPrHead({
        repoPath: repo.path,
        prUrl: 'https://github.com/acme/fixture/pull/10',
        branchRef: 'feature/lane',
        probe: fixedProbe('other-branch', tip),
      }),
    );
    expect(failure).toBeInstanceOf(PrHeadVerificationError);
    expect((failure as PrHeadVerificationError).code).toBe('branch-mismatch');
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
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/13');
    const poster = {
      post: vi.fn(async (_input: { readonly targetSha: string }) => ({
        headSha: _input.targetSha,
        baseSha: 'stub-base',
      })),
    };
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeHybridSpawner(sessions, { childAnswer: () => '[]' }).spawner,
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
      escalate: (title, detail) => escalations.push({ title, detail }),
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
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/15');
    const probe = vi.fn(async () => {
      throw new Error('the host probe must not be reached for a commit pin');
    }) as unknown as PrHeadProbe;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fakeHybridSpawner(sessions, { childAnswer: () => '[]' }).spawner,
      poster: {
        post: vi.fn(async (input: { readonly targetSha: string }) => ({
          headSha: input.targetSha,
          baseSha: 'stub-base',
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
});
