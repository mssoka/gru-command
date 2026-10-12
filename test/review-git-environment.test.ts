import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { branchNameForRef } from '../src/dispatch/branch-idle.js';
import { repositoryGitEnv } from '../src/dispatch/perkins-review/artifacts.js';
import { prBranchCandidate, resolveFreshPrHead, type PrHeadProbe } from '../src/dispatch/perkins-review/fresh-head.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { attachBareOrigin, makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';

const repos: FixtureRepo[] = [];
const dirs: string[] = [];
const dbs: LedgerDb[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  while (dbs.length > 0) dbs.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  while (repos.length > 0) repos.pop()!.cleanup();
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'gru-review-git-env-'));
  dirs.push(path);
  return path;
}

function fixture(name: string): FixtureRepo {
  const repo = makeFixtureRepo(name);
  repos.push(repo);
  return repo;
}

/** Fixture reads must not repeat the product's environment-routing defect. */
function git(repoPath: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8', env: repositoryGitEnv(false), stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function poison(foreign: FixtureRepo): void {
  const gitDir = git(foreign.path, ['rev-parse', '--absolute-git-dir']);
  vi.stubEnv('GIT_DIR', gitDir);
  vi.stubEnv('GIT_WORK_TREE', foreign.path);
  vi.stubEnv('GIT_INDEX_FILE', join(gitDir, 'index'));
}

function foreignState(repo: FixtureRepo): unknown {
  return {
    refs: git(repo.path, ['for-each-ref', '--format=%(refname) %(objectname)']),
    status: git(repo.path, ['status', '--porcelain']),
    worktrees: git(repo.path, ['worktree', 'list', '--porcelain']),
    index: createHash('sha256').update(readFileSync(join(repo.path, '.git', 'index'))).digest('hex'),
  };
}

function origin(repo: FixtureRepo): string {
  const path = attachBareOrigin(repo);
  repo.git(['push', '--quiet', 'origin', 'main']);
  repo.git(['symbolic-ref', 'HEAD', 'refs/heads/main'], path);
  return path;
}

function manager(): { readonly ledger: LedgerApi; readonly worktrees: WorktreeManager } {
  const db = new LedgerDb(directory());
  dbs.push(db);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  return {
    ledger,
    worktrees: new WorktreeManager({
      ledger, root: directory(), preserveRoot: directory(),
      setupTimeoutMs: 30_000, enumerateProcesses: () => [],
    }),
  };
}

async function waveFixture(repo: FixtureRepo, probe: PrHeadProbe) {
  const { ledger, worktrees } = manager();
  const job = ledger.addJob({
    id: 'git-env-job', repo: 'assigned', title: 'review assigned source',
    baseBranch: 'main', briefing: 'Acceptance: the assigned source is reviewed.',
  });
  await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
  ledger.setJobStatus(job.id, 'working');
  ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: {} });
  ledger.setJobPr(job.id, 'https://github.com/acme/assigned/pull/7');
  const artifactRoot = directory();
  const runtime = fakeWholeSpawner(directory(), { specialists: [], childAnswer: () => '[]' });
  const wave = new WaveRunner({
    ledger, worktrees, spawner: runtime.spawner,
    poster: {
      post: async ({ targetSha, body }) => ({
        reviewId: 'fixture-review', actor: 'fixture-bot', event: 'COMMENTED',
        commitId: targetSha, headSha: targetSha, baseSha: 'fixture-base',
        bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      }),
    },
    reviewArtifactRoot: artifactRoot, prHeadProbe: probe,
  });
  return { ledger, worktrees, job, wave, runtime, artifactRoot };
}

describe('review Git repository environment isolation (GH-270)', () => {
  it('strips routing overrides without mutating the service environment or losing transport/configuration', () => {
    const routing = [
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX',
      'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS',
      'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM', 'GIT_QUARANTINE_PATH',
    ];
    const transport = {
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_ASKPASS: '/fixture/askpass',
      GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: 'fixture-helper', LC_ALL: 'fixture-locale',
    };
    for (const key of routing) vi.stubEnv(key, 'foreign-routing');
    for (const [key, value] of Object.entries(transport)) vi.stubEnv(key, value);
    const clean = repositoryGitEnv(false);
    for (const key of routing) {
      expect(clean[key], key).toBeUndefined();
      expect(process.env[key], key).toBe('foreign-routing');
    }
    expect(clean).toMatchObject(transport);
    expect(repositoryGitEnv(true)).toMatchObject({ ...transport, LC_ALL: 'C' });
  });

  it('discovers the assigned branch instead of a foreign tag or foreign-only branch', () => {
    const repo = fixture('assigned-discovery');
    repo.git(['branch', 'feature/shared']);
    const foreign = fixture('foreign-discovery');
    foreign.git(['tag', 'feature/shared']);
    foreign.git(['branch', 'feature/foreign-only']);
    poison(foreign);
    expect(branchNameForRef(repo.path, 'feature/shared')).toBe('feature/shared');
    expect(branchNameForRef(repo.path, 'feature/foreign-only')).toBeNull();
    expect(branchNameForRef(null, 'feature/shared')).toBeNull();
  });

  it('classifies a PR branch against the assigned repository, retaining commit-pin semantics', () => {
    const repo = fixture('assigned-pr-classification');
    repo.git(['branch', 'feature/shared']);
    const target = repo.head();
    const foreign = fixture('foreign-pr-classification');
    foreign.git(['tag', 'feature/shared']);
    poison(foreign);
    expect(prBranchCandidate(repo.path, 'feature/shared')).toBe('feature/shared');
    expect(prBranchCandidate(repo.path, target)).toBeNull();
  });

  it('fetches and cross-checks the assigned PR origin, leaving foreign refs and index unchanged', async () => {
    const repo = fixture('assigned-fresh-head');
    origin(repo);
    repo.git(['checkout', '-b', 'feature/shared']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'feature/shared']);
    repo.git(['update-ref', '-d', 'refs/remotes/origin/feature/shared']);
    const foreign = fixture('foreign-fresh-head');
    origin(foreign);
    foreign.git(['checkout', '-b', 'feature/shared']);
    foreign.commitFile('src/foreign.ts', 'export const foreign = true;\n');
    foreign.git(['push', '--quiet', 'origin', 'feature/shared']);
    const before = foreignState(foreign);
    poison(foreign);
    const fresh = await resolveFreshPrHead({
      repoPath: repo.path, prUrl: 'https://github.com/acme/assigned/pull/7',
      branchRef: 'feature/shared', probe: async () => ({ headRefName: 'feature/shared', headSha: target }),
    });
    expect(fresh.targetSha).toBe(target);
    expect(git(repo.path, ['rev-parse', 'refs/remotes/origin/feature/shared'])).toBe(target);
    expect(foreignState(foreign)).toEqual(before);
  });

  it('selects, creates and sweeps assigned worktrees under inherited foreign routing', async () => {
    const repo = fixture('assigned-worktrees');
    origin(repo);
    repo.git(['checkout', '-b', 'topic']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'topic']);
    repo.git(['update-ref', '-d', 'refs/remotes/origin/topic']);
    const foreign = fixture('foreign-worktrees');
    origin(foreign);
    foreign.git(['checkout', '-b', 'topic']);
    foreign.commitFile('src/foreign.ts', 'export const foreign = true;\n');
    foreign.git(['push', '--quiet', 'origin', 'topic']);
    const before = foreignState(foreign);
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'env-lane', repo: 'assigned', title: 'assigned lane', baseBranch: 'main' });
    poison(foreign);
    expect(await worktrees.resolveReviewTarget({ repoPath: repo.path, ref: 'origin/topic' }))
      .toMatchObject({ sha: target, baseSource: 'origin' });
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(git(repo.path, ['rev-parse', 'main']));
    const round = ledger.addRound({ jobId: job.id, targetRef: target });
    const review = await worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    expect(git(review.path, ['rev-parse', 'HEAD'])).toBe(target);
    expect(git(review.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(await worktrees.release({ worktreeId: round.id })).toMatchObject({ status: 'swept' });
    expect(await worktrees.release({ worktreeId: job.id })).toMatchObject({ status: 'swept', branch: 'deleted' });
    expect(existsSync(review.path)).toBe(false);
    expect(existsSync(lane.path)).toBe(false);
    expect(foreignState(foreign)).toEqual(before);
  });

  it('runs an ordinary requestReview through real assigned discovery, freeze, detached creation and release', async () => {
    const repo = fixture('assigned-ordinary-request');
    origin(repo);
    repo.git(['checkout', '-b', 'feature/shared']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'feature/shared']);
    const foreign = fixture('foreign-ordinary-request');
    origin(foreign);
    foreign.git(['checkout', '-b', 'feature/shared']);
    foreign.commitFile('src/foreign.ts', 'export const foreign = true;\n');
    foreign.git(['push', '--quiet', 'origin', 'feature/shared']);
    const before = foreignState(foreign);
    const probe = vi.fn(async () => ({ headRefName: 'feature/shared', headSha: target }));
    const h = await waveFixture(repo, probe);
    poison(foreign);
    const request = await h.wave.requestReview({ jobId: h.job.id, targetRef: 'feature/shared' });
    if (request.route !== 'perkins') throw new Error(`expected native request, got ${request.route}`);
    const outcome = await request.run;
    expect(outcome.round.targetRef).toBe(target);
    expect(outcome.canonicalVerdict).toBe('READY TO MERGE');
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ branchRef: 'feature/shared' }));
    expect(h.runtime.leadCalls).toHaveLength(1);
    const review = h.worktrees.getWorktree(outcome.round.id)!;
    expect(review.sha).toBe(target);
    expect(review.status).toBe('swept');
    const diff = readFileSync(join(h.artifactRoot, outcome.round.id, 'diff.patch'), 'utf8');
    expect(diff).toContain('export const assigned = true;');
    expect(diff).not.toContain('export const foreign = true;');
    expect(foreignState(foreign)).toEqual(before);
  });

  it('keeps an intentional local origin-prefixed tag pinned even if foreign refs classify it as a branch', async () => {
    const repo = fixture('assigned-local-pin');
    origin(repo);
    repo.git(['checkout', '-b', 'feature/assigned']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['tag', 'origin/topic', target]); // No topic branch on the assigned origin.
    const foreign = fixture('foreign-tracking-ref');
    origin(foreign);
    foreign.git(['push', '--quiet', 'origin', 'main:topic']);
    const probe = vi.fn(async () => { throw new Error('an intentional local tag must not probe a PR'); });
    const h = await waveFixture(repo, probe);
    poison(foreign);
    const request = await h.wave.requestReview({ jobId: h.job.id, targetRef: 'origin/topic' });
    if (request.route !== 'perkins') throw new Error(`expected native request, got ${request.route}`);
    expect((await request.run).round.targetRef).toBe(target);
    expect(probe).not.toHaveBeenCalled();
  });

  it('checks origin/tag collisions on the assigned remote instead of authorizing a stale local tag', async () => {
    const repo = fixture('assigned-remote-collision');
    origin(repo);
    repo.git(['tag', 'origin/topic', 'main']);
    repo.git(['push', '--quiet', 'origin', 'main:topic']);
    repo.git(['update-ref', '-d', 'refs/remotes/origin/topic']);
    repo.git(['checkout', '-b', 'feature/assigned']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'feature/assigned']);
    const foreign = fixture('foreign-no-collision');
    origin(foreign);
    foreign.git(['tag', 'origin/topic', 'main']); // Foreign origin has no topic branch.
    const probe = vi.fn(async () => ({ headRefName: 'feature/assigned', headSha: target }));
    const h = await waveFixture(repo, probe);
    poison(foreign);
    const request = await h.wave.requestReview({ jobId: h.job.id, targetRef: 'origin/topic' });
    if (request.route !== 'perkins') throw new Error(`expected native request, got ${request.route}`);
    expect((await request.run).round.targetRef).toBe(target);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('merges noninteractive flags into sanitized worktree Git environment while retaining authentication', async () => {
    const repo = fixture('assigned-transport');
    origin(repo);
    const foreign = fixture('foreign-transport');
    const wrapperRoot = directory();
    const log = join(wrapperRoot, 'git-env.ndjson');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapper = join(wrapperRoot, 'git');
    writeFileSync(wrapper, '#!/usr/bin/env node\n' +
      'const { appendFileSync } = require("node:fs");\n' +
      'const { spawnSync } = require("node:child_process");\n' +
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("GIT_"))) }) + "\\n");\n` +
      `const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });\n` +
      'if (result.error) throw result.error; process.exit(result.status ?? 1);\n');
    chmodSync(wrapper, 0o755);
    vi.stubEnv('PATH', `${wrapperRoot}:${process.env.PATH ?? ''}`);
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh -o BatchMode=yes');
    vi.stubEnv('GIT_ASKPASS', '/fixture/askpass');
    vi.stubEnv('GIT_TERMINAL_PROMPT', '1');
    poison(foreign);
    const { worktrees } = manager();
    expect(await worktrees.resolveReviewTarget({ repoPath: repo.path, ref: 'origin/main' }))
      .toMatchObject({ sha: git(repo.path, ['rev-parse', 'main']) });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      readonly args: string[]; readonly env: Record<string, string>;
    });
    expect(calls.some(({ args }) => args[0] === 'fetch')).toBe(true);
    for (const { env } of calls) {
      expect(env['GIT_DIR']).toBeUndefined();
      expect(env['GIT_WORK_TREE']).toBeUndefined();
      expect(env['GIT_INDEX_FILE']).toBeUndefined();
      expect(env['GIT_SSH_COMMAND']).toBe('ssh -o BatchMode=yes');
      expect(env['GIT_ASKPASS']).toBe('/fixture/askpass');
    }
    const fetch = calls.find(({ args }) => args[0] === 'fetch')!;
    expect(fetch.env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(process.env['GIT_TERMINAL_PROMPT']).toBe('1');
  });
});
