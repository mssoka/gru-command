import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { branchNameForRef } from '../src/dispatch/branch-idle.js';
import { freezeReviewInputs, repositoryGitEnv } from '../src/dispatch/perkins-review/artifacts.js';
import { headMovedSinceFreeze } from '../src/dispatch/perkins-review/whole.js';
import { prBranchCandidate, resolveFreshPrHead, type PrHeadProbe } from '../src/dispatch/perkins-review/fresh-head.js';
import { GhPrPoster, GitLabMrPoster, WaveRunner } from '../src/dispatch/perkins.js';
import { probeGitHubRemote, repoRemote, runReviewPreflight } from '../src/dispatch/review-path.js';
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

function manager(): { readonly ledger: LedgerApi; readonly worktrees: WorktreeManager; readonly root: string } {
  const db = new LedgerDb(directory());
  dbs.push(db);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  const root = directory();
  return {
    ledger, root,
    worktrees: new WorktreeManager({
      ledger, root, preserveRoot: directory(),
      setupTimeoutMs: 30_000, enumerateProcesses: () => [],
    }),
  };
}

async function waveFixture(repo: FixtureRepo, probe: PrHeadProbe, linkedPr = true) {
  const { ledger, worktrees } = manager();
  const job = ledger.addJob({
    id: 'git-env-job', repo: 'assigned', title: 'review assigned source',
    baseBranch: 'main', briefing: 'Acceptance: the assigned source is reviewed.',
  });
  await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
  ledger.setJobStatus(job.id, 'working');
  ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: {} });
  if (linkedPr) ledger.setJobPr(job.id, 'https://github.com/acme/assigned/pull/7');
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

function registerPrBranchLane(repo: FixtureRepo, ledger: LedgerApi, jobId: string): void {
  const path = join(directory(), 'pr-owner');
  git(repo.path, ['checkout', 'main']);
  git(repo.path, ['worktree', 'add', path, 'feature/shared']);
  ledger.registerWorktree({ id: jobId, kind: 'job', repoPath: repo.path, repoName: 'assigned', path,
    branch: 'feature/shared', sha: git(path, ['rev-parse', 'HEAD']), baseSource: null, jobId });
}

function terminalDirectiveHistory(ledger: LedgerApi, jobId: string): void {
  for (let n = 0; n < 200; n += 1) {
    const requestId = `a-history-${String(n).padStart(3, '0')}`;
    ledger.beginDirectiveIntent({ jobId, requestId, directive: 'old work', holder: 'fixture' });
    ledger.failDirective({ requestId, reason: 'terminal fixture history' });
  }
}

function failingCheckoutHook(repo: FixtureRepo): { readonly hook: string; readonly log: string } {
  const hook = join(repo.path, '.git', 'hooks', 'post-checkout');
  const log = join(directory(), 'checkout-path.txt');
  git(repo.path, ['config', 'core.hooksPath', join(repo.path, '.git', 'hooks')]);
  writeFileSync(hook, '#!/usr/bin/env node\n' +
    `require('node:fs').writeFileSync(${JSON.stringify(log)}, process.cwd()); process.exit(7);\n`);
  chmodSync(hook, 0o755);
  return { hook, log };
}

function assertNoPartialLane(repo: FixtureRepo, ledger: LedgerApi, id: string, log: string, before: string, branch?: string): void {
  const path = readFileSync(log, 'utf8'); // Git really checked out the partial lane before its hook failed.
  expect(existsSync(path)).toBe(false);
  expect(git(repo.path, ['worktree', 'list', '--porcelain'])).toBe(before);
  expect(ledger.getWorktree(id)).toBeNull();
  if (branch !== undefined) expect(git(repo.path, ['branch', '--list', branch])).toBe('');
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

  it('checks the assigned origin in real code-host preflight and never borrows a foreign origin', async () => {
    const repo = fixture('assigned-code-host');
    repo.git(['remote', 'add', 'origin', 'https://github.com/acme/assigned.git']);
    const noOrigin = fixture('assigned-no-origin');
    const foreign = fixture('foreign-code-host');
    foreign.git(['remote', 'add', 'origin', 'https://github.com/foreign/unrelated.git']);
    const before = foreignState(foreign);
    const binary = join(directory(), 'gh');
    writeFileSync(binary, `#!/usr/bin/env node
const expected = ['api', '--hostname', 'github.com', 'repos/acme/assigned', '--jq', '.full_name'];
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) process.exit(1);
process.stdout.write('acme/assigned');
`);
    chmodSync(binary, 0o755);
    poison(foreign);
    const result = await runReviewPreflight({
      'resource-integrity': () => {}, 'model-provider': () => {}, 'review-policy': () => {},
      'code-host': () => {
        const remote = repoRemote(repo.path);
        if (remote === null) throw new Error('assigned origin is unavailable');
        probeGitHubRemote(remote, binary);
      },
    });
    expect(result).toEqual({ ok: true, failures: [] });
    expect(repoRemote(repo.path)).toEqual({ host: 'github.com', owner: 'acme', repo: 'assigned' });
    expect(repoRemote(noOrigin.path)).toBeNull();
    // Explicit caller-owned environments remain complete, not merged with the service environment.
    expect(repoRemote(repo.path, 'git', repositoryGitEnv(false)))
      .toEqual({ host: 'github.com', owner: 'acme', repo: 'assigned' });
    expect(foreignState(foreign)).toEqual(before);
  });

  it('posts GitHub verdicts against the assigned origin and still refuses a mismatched PR', async () => {
    const repo = fixture('assigned-github-post');
    repo.git(['remote', 'add', 'origin', 'https://github.com/acme/assigned.git']);
    const foreign = fixture('foreign-github-post');
    foreign.git(['remote', 'add', 'origin', 'https://github.com/foreign/unrelated.git']);
    const before = foreignState(foreign);
    const target = repo.head();
    const binary = join(directory(), 'gh');
    writeFileSync(binary, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('POST')) {
  const body = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
  process.stdout.write(JSON.stringify({ id: 7, user: { login: 'fixture-bot' }, state: 'COMMENTED', commit_id: body.commit_id, body: body.body }));
} else if (argv.includes('user')) {
  process.stdout.write('fixture-bot');
} else {
  process.stdout.write(${JSON.stringify(`${target}\t${target}\n`)});
}
`);
    chmodSync(binary, 0o755);
    const poster = new GhPrPoster(binary);
    const input = {
      repoPath: repo.path, prUrl: 'https://github.com/acme/assigned/pull/7', host: 'github.com',
      targetSha: target, baseSha: target, body: 'assigned review\n',
    };
    poison(foreign);
    await expect(poster.post(input)).resolves.toMatchObject({ reviewId: '7', headSha: target, commitId: target });
    await expect(poster.post({ ...input, prUrl: 'https://github.com/foreign/unrelated/pull/7' }))
      .rejects.toThrow('pull request URL does not match the reviewed repository origin');
    expect(foreignState(foreign)).toEqual(before);
  });

  it('posts GitLab verdicts against the assigned origin and still refuses a mismatched MR', async () => {
    const repo = fixture('assigned-gitlab-post');
    repo.git(['remote', 'add', 'origin', 'https://gitlab.example.test/acme/assigned.git']);
    const foreign = fixture('foreign-gitlab-post');
    foreign.git(['remote', 'add', 'origin', 'https://gitlab.example.test/foreign/unrelated.git']);
    const before = foreignState(foreign);
    const target = repo.head();
    const calls: string[] = [];
    const poster = new GitLabMrPoster({
      token: 'fixture-token',
      fetchImpl: async (url, init) => {
        calls.push(url);
        const body = url.endsWith('/user') ? { username: 'fixture-bot' }
          : init?.method === 'POST' ? { id: 7, author: { username: 'fixture-bot' }, body: 'assigned review\n' }
            : { sha: target, diff_refs: { base_sha: target } };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      },
    });
    const input = {
      repoPath: repo.path, prUrl: 'https://gitlab.example.test/acme/assigned/-/merge_requests/7',
      host: 'gitlab.example.test', targetSha: target, baseSha: target, body: 'assigned review\n',
    };
    poison(foreign);
    await expect(poster.post(input)).resolves.toMatchObject({ reviewId: '7', headSha: target, commitId: null });
    expect(calls).toContain('https://gitlab.example.test/api/v4/projects/acme%2Fassigned/merge_requests/7/notes');
    const postedCalls = calls.length;
    await expect(poster.post({ ...input, prUrl: 'https://gitlab.example.test/foreign/unrelated/-/merge_requests/7' }))
      .rejects.toThrow('merge request URL does not match the reviewed repository origin');
    expect(calls).toHaveLength(postedCalls);
    expect(foreignState(foreign)).toEqual(before);
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

  it('tracks the canonical PR branch when an origin-prefixed tag shadows that same branch', async () => {
    const repo = fixture('assigned-pr-movement-shadow');
    origin(repo);
    repo.git(['checkout', '-b', 'feature/shared']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'feature/shared']);
    repo.git(['tag', 'origin/feature/shared', 'main']);
    const foreign = fixture('foreign-pr-movement-shadow');
    const before = foreignState(foreign);
    const h = await waveFixture(repo, async () => ({ headRefName: 'feature/shared', headSha: target }));
    poison(foreign);
    const request = await h.wave.requestReview({ jobId: h.job.id, targetRef: 'feature/shared' });
    if (request.route !== 'perkins') throw new Error(`expected native request, got ${request.route}`);
    const outcome = await request.run;
    expect(outcome.canonicalVerdict).toBe('READY TO MERGE');
    expect(h.runtime.leadCalls).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(h.artifactRoot, outcome.round.id, 'manifest.json'), 'utf8')) as {
      readonly targetRef: string; readonly targetSha: string;
    };
    expect(manifest).toMatchObject({ targetRef: 'refs/remotes/origin/feature/shared', targetSha: target });
    expect(foreignState(foreign)).toEqual(before);
  });

  it('fences the refreshed PR branch instead of the stale request branch', async () => {
    const repo = fixture('assigned-pr-idle-identity');
    origin(repo);
    repo.git(['checkout', '-b', 'feature/shared']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'feature/shared']);
    const h = await waveFixture(repo, async () => ({ headRefName: 'feature/shared', headSha: target }));
    const other = h.ledger.addJob({ id: 'busy-pr-owner', repo: 'assigned', title: 'busy PR writer', baseBranch: 'main' });
    registerPrBranchLane(repo, h.ledger, other.id);
    h.ledger.setJobStatus(other.id, 'working');
    await expect(h.wave.requestReview({ jobId: h.job.id })).rejects.toMatchObject({ name: 'BranchBusyError', targetBranch: 'feature/shared' });
    expect(h.runtime.leadCalls).toHaveLength(0);
  });

  it('never carries force authority from the requested branch to a newly discovered PR blocker', async () => {
    const repo = fixture('assigned-pr-force-identity');
    origin(repo);
    repo.git(['checkout', '-b', 'feature/shared']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'feature/shared']);
    const h = await waveFixture(repo, async () => ({ headRefName: 'feature/shared', headSha: target }));
    const other = h.ledger.addJob({ id: 'busy-force-owner', repo: 'assigned', title: 'busy PR writer', baseBranch: 'main' });
    registerPrBranchLane(repo, h.ledger, other.id);
    h.ledger.setJobStatus(other.id, 'working');
    await expect(h.wave.requestReview({ jobId: h.job.id, force: true })).rejects.toMatchObject({ name: 'BranchBusyError', targetBranch: 'feature/shared' });
    expect(h.runtime.leadCalls).toHaveLength(0);
    const forced = h.ledger.listJobEvents(h.job.id).filter((event) => event.kind === 'branch-idle.forced');
    expect(forced.every((event) => (event.payload as { targetBranch: string }).targetBranch !== 'feature/shared')).toBe(true);
  });

  it('retains the refreshed PR branch for the post-probe admission idle check', async () => {
    const repo = fixture('assigned-pr-post-probe');
    origin(repo);
    repo.git(['checkout', '-b', 'feature/shared']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'feature/shared']);
    const h = await waveFixture(repo, async () => ({ headRefName: 'feature/shared', headSha: target }));
    const other = h.ledger.addJob({ id: 'post-probe-owner', repo: 'assigned', title: 'late PR writer', baseBranch: 'main' });
    registerPrBranchLane(repo, h.ledger, other.id);
    h.ledger.setJobStatus(other.id, 'working');
    h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: other.id, payload: {} });
    // The freeze observer runs immediately before the awaited advertised probe.
    const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
      reviewArtifactRoot: h.artifactRoot, prHeadProbe: async () => ({ headRefName: 'feature/shared', headSha: target }),
      reviewFreezeObserver: () => { h.ledger.setJobStatus(other.id, 'blocked'); h.ledger.setJobStatus(other.id, 'working'); },
    });
    await expect(wave.requestReview({ jobId: h.job.id, force: true })).rejects.toMatchObject({ name: 'BranchBusyError', targetBranch: 'feature/shared' });
    expect(h.runtime.leadCalls).toHaveLength(0);
  });

  it('requires fresh force authority when an already-audited PR owner opens a new attempt', async () => {
    const repo = fixture('assigned-pr-force-new-attempt');
    origin(repo);
    repo.git(['checkout', '-b', 'feature/shared']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'feature/shared']);
    const h = await waveFixture(repo, async () => ({ headRefName: 'feature/shared', headSha: target }));
    const other = h.ledger.addJob({ id: 'audited-owner', repo: 'assigned', title: 'audited writer', baseBranch: 'main' });
    registerPrBranchLane(repo, h.ledger, other.id);
    h.ledger.setJobStatus(other.id, 'working');
    const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
      reviewArtifactRoot: h.artifactRoot, prHeadProbe: async () => ({ headRefName: 'feature/shared', headSha: target }),
      reviewFreezeObserver: () => { h.ledger.setJobStatus(other.id, 'blocked'); h.ledger.setJobStatus(other.id, 'working'); },
    });
    await expect(wave.requestReview({ jobId: h.job.id, targetRef: 'feature/shared', force: true }))
      .rejects.toMatchObject({ name: 'BranchBusyError', targetBranch: 'feature/shared' });
    expect(h.runtime.leadCalls).toHaveLength(0);
  });

  it('freezes a tag-shadowed non-PR tracking target with its exact fetched identity', async () => {
    const repo = fixture('assigned-nopr-shadow');
    origin(repo);
    repo.git(['checkout', '-b', 'topic']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'topic']);
    repo.git(['tag', 'origin/topic', 'main']);
    const h = await waveFixture(repo, async () => { throw new Error('non-PR must not probe'); }, false);
    const request = await h.wave.requestReview({ jobId: h.job.id, targetRef: 'origin/topic' });
    if (request.route !== 'perkins') throw new Error(`expected native request, got ${request.route}`);
    const outcome = await request.run;
    expect(outcome.headMoved).toBe(false);
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE'); // Non-PR reviews retain the publication refusal.
    expect(readFileSync(outcome.reportFile!, 'utf8')).toContain('the job has no pull request link');
    expect(h.runtime.leadCalls).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(h.artifactRoot, outcome.round.id, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ targetRef: 'refs/remotes/origin/topic', targetSha: target });
  });

  it('proves advertised non-PR movement despite a tag shadow and an unchanged local tracking ref', async () => {
    const repo = fixture('assigned-nopr-advertised');
    const remote = origin(repo);
    repo.git(['checkout', '-b', 'topic']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'topic']);
    repo.git(['tag', 'origin/topic', target]);
    const h = await waveFixture(repo, async () => { throw new Error('non-PR must not probe'); }, false);
    const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
      reviewArtifactRoot: h.artifactRoot,
      reviewFreezeObserver: () => { git(remote, ['update-ref', 'refs/heads/topic', git(repo.path, ['rev-parse', 'main'])]); },
    });
    await expect(wave.requestReview({ jobId: h.job.id, targetRef: 'origin/topic' })).rejects.toMatchObject({ name: 'ReviewAdmissionError' });
    expect(git(repo.path, ['rev-parse', 'refs/remotes/origin/topic'])).toBe(target);
    expect(h.runtime.leadCalls).toHaveLength(0);
  });

  it('carries the live origin/HEAD default identity rather than a stale cached symref', async () => {
    const repo = fixture('assigned-nopr-live-default');
    const remote = origin(repo);
    repo.git(['checkout', '-b', 'trunk']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'trunk']);
    repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
    const h = await waveFixture(repo, async () => { throw new Error('non-PR must not probe'); }, false);
    const request = await h.wave.requestReview({ jobId: h.job.id, targetRef: 'origin/HEAD' });
    if (request.route !== 'perkins') throw new Error(`expected native request, got ${request.route}`);
    const outcome = await request.run;
    expect(outcome.headMoved).toBe(false);
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE'); // Non-PR reviews retain the publication refusal.
    expect(readFileSync(outcome.reportFile!, 'utf8')).toContain('the job has no pull request link');
    expect(h.runtime.leadCalls).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(h.artifactRoot, outcome.round.id, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ targetRef: 'refs/remotes/origin/trunk', targetSha: target });
  });

  it('sanitizes the secondary movement-ref proof when the frozen target is an exact commit pin', async () => {
    const repo = fixture('assigned-secondary-movement');
    repo.git(['checkout', '-b', 'feature/shared']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    const foreign = fixture('foreign-secondary-movement');
    foreign.git(['branch', 'feature/shared']);
    const before = foreignState(foreign);
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'secondary-movement', repo: 'assigned', title: 'commit pin movement', baseBranch: 'main' });
    const round = ledger.addRound({ jobId: job.id, targetRef: target });
    const lane = await worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    const frozen = freezeReviewInputs({
      repoPath: lane.path, roundId: round.id, artifactRoot: directory(), baseRef: 'main', targetRef: target, noSpec: true,
    });
    poison(foreign);
    expect(headMovedSinceFreeze(frozen, 'refs/heads/feature/shared')).toBeNull();
    expect(headMovedSinceFreeze(frozen, 'refs/heads/main')).toMatchObject({ cause: 'target-moved' });
    expect(foreignState(foreign)).toEqual(before);
  });

  it('rolls back a job lane after a failed checkout hook and retries the same id without touching foreign state', async () => {
    const repo = fixture('assigned-hook-job');
    origin(repo);
    const foreign = fixture('foreign-hook-job');
    const state = foreignState(foreign);
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'hook-job', repo: 'assigned', title: 'checkout hook refusal', baseBranch: 'main' });
    const before = git(repo.path, ['worktree', 'list', '--porcelain']);
    const { hook, log } = failingCheckoutHook(repo);
    poison(foreign);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })).rejects.toThrow(/git worktree add/);
    assertNoPartialLane(repo, ledger, job.id, log, before, `gru/${job.id}`);
    rmSync(hook);
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    expect(lane.branch).toBe(`gru/${job.id}`);
    expect(git(repo.path, ['worktree', 'list', '--porcelain'])).not.toContain('locked');
    // Existing lane ownership refusals must not roll back somebody else's prior lane.
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })).rejects.toThrow(/already exists/);
    expect(existsSync(lane.path)).toBe(true);
    expect(ledger.getWorktree(job.id)).toMatchObject({ path: lane.path, status: 'active' });
    expect(await worktrees.release({ worktreeId: job.id })).toMatchObject({ status: 'swept' });
    expect(foreignState(foreign)).toEqual(state);
  });

  it('rolls back a detached review lane after a failed checkout hook and retries the same round', async () => {
    const repo = fixture('assigned-hook-review');
    const target = repo.head();
    const foreign = fixture('foreign-hook-review');
    const state = foreignState(foreign);
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'hook-review-job', repo: 'assigned', title: 'checkout hook refusal', baseBranch: 'main' });
    const round = ledger.addRound({ jobId: job.id, targetRef: target });
    const input = { repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id };
    const before = git(repo.path, ['worktree', 'list', '--porcelain']);
    const { hook, log } = failingCheckoutHook(repo);
    poison(foreign);
    await expect(worktrees.createReviewWorktree(input)).rejects.toThrow(/git worktree add/);
    assertNoPartialLane(repo, ledger, round.id, log, before);
    rmSync(hook);
    const lane = await worktrees.createReviewWorktree(input);
    expect(lane.branch).toBeNull();
    await expect(worktrees.createReviewWorktree(input)).rejects.toThrow(/already exists/);
    expect(existsSync(lane.path)).toBe(true);
    expect(await worktrees.release({ worktreeId: round.id })).toMatchObject({ status: 'swept' });
    expect(foreignState(foreign)).toEqual(state);
  });

  it('rolls back writer and read-only child lanes after failed checkout hooks while preserving their parent', async () => {
    const repo = fixture('assigned-hook-children');
    origin(repo);
    const foreign = fixture('foreign-hook-children');
    const state = foreignState(foreign);
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'hook-child-job', repo: 'assigned', title: 'checkout hook refusal', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const before = git(repo.path, ['worktree', 'list', '--porcelain']);
    const parentSha = git(parent.path, ['rev-parse', 'HEAD']);
    for (const authority of ['writer', 'read-only'] as const) {
      const childId = `hook-${authority}`;
      const input = { repoPath: repo.path, jobId: job.id, childId, parentPath: parent.path, authority };
      const { hook, log } = failingCheckoutHook(repo);
      poison(foreign);
      await expect(worktrees.createChildWorktree(input)).rejects.toThrow(/git worktree add/);
      assertNoPartialLane(repo, ledger, childId, log, before,
        authority === 'writer' ? `gru/${job.id}-child-${childId}` : undefined);
      rmSync(hook);
      const child = await worktrees.createChildWorktree(input);
      expect(child.sha).toBe(parentSha);
      await expect(worktrees.createChildWorktree(input)).rejects.toThrow(/already exists/);
      expect(existsSync(child.path)).toBe(true);
      expect(await worktrees.release({ worktreeId: child.id })).toMatchObject({ status: 'swept' });
      expect(git(parent.path, ['rev-parse', 'HEAD'])).toBe(parentSha);
    }
    expect(await worktrees.release({ worktreeId: job.id })).toMatchObject({ status: 'swept' });
    expect(foreignState(foreign)).toEqual(state);
  });

  it('preserves concurrent external trees, branches and data for every creation authority', async () => {
    const repo = fixture('assigned-external-race');
    origin(repo);
    const { ledger, worktrees, root } = manager();
    const job = ledger.addJob({ id: 'external-race', repo: 'assigned', title: 'external custody', baseBranch: 'main' });
    const parentJob = ledger.addJob({ id: 'external-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
    const round = ledger.addRound({ jobId: job.id, targetRef: repo.head() });
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const servicePath = process.env.PATH ?? '';
    for (const authority of ['job', 'review', 'writer', 'read-only'] as const) {
      const id = authority === 'job' ? job.id : authority === 'review' ? round.id : `external-${authority}`;
      const path = join(root, 'assigned-external-race', `${authority === 'job' ? 'job' : authority === 'review' ? 'review' : 'child'}-${id}`);
      const branch = authority === 'job' ? `gru/${job.id}` : authority === 'writer' ? `gru/${parentJob.id}-child-${id}` : `external-${authority}`;
      const wrapperRoot = directory();
      const marker = join(wrapperRoot, 'external-created');
      const wrapper = join(wrapperRoot, 'git');
      writeFileSync(wrapper, '#!/usr/bin/env node\n' +
        'const fs = require("node:fs"), cp = require("node:child_process"); const args = process.argv.slice(2);\n' +
        `if ((args[0] === 'update-ref' || (args[0] === 'worktree' && args[1] === 'add')) && !fs.existsSync(${JSON.stringify(marker)})) {\n` +
        ` fs.writeFileSync(${JSON.stringify(marker)}, 'external creator');\n` +
        ` cp.execFileSync(${JSON.stringify(realGit)}, ['worktree', 'add', '-b', ${JSON.stringify(branch)}, ${JSON.stringify(path)}, 'HEAD']);\n` +
        ` fs.writeFileSync(require('node:path').join(${JSON.stringify(path)}, 'external-data.txt'), 'external owner'); }\n` +
        `const r = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`);
      chmodSync(wrapper, 0o755);
      vi.stubEnv('PATH', `${wrapperRoot}:${servicePath}`);
      const create = authority === 'job' ? worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })
        : authority === 'review' ? worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: repo.head() })
          : worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
      await expect(create).rejects.toThrow();
      expect(readFileSync(join(path, 'external-data.txt'), 'utf8')).toBe('external owner');
      expect(git(repo.path, ['worktree', 'list', '--porcelain'])).toContain(path);
      expect(git(repo.path, ['rev-parse', `refs/heads/${branch}`])).toBe(repo.head());
      expect(ledger.getWorktree(id)).toBeNull();
      vi.stubEnv('PATH', servicePath);
    }
  });

  it('fails loudly without cleanup when a failed hook removes creation custody', async () => {
    const repo = fixture('assigned-unknown-custody');
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'unknown-custody', repo: 'assigned', title: 'unknown custody', baseBranch: 'main' });
    const round = ledger.addRound({ jobId: job.id, targetRef: repo.head() });
    const { hook, log } = failingCheckoutHook(repo);
    writeFileSync(hook, '#!/usr/bin/env node\n' +
      `const fs = require('node:fs'), cp = require('node:child_process'); fs.writeFileSync(${JSON.stringify(log)}, process.cwd());\n` +
      `cp.spawnSync('git', ['worktree', 'unlock', process.cwd()]); fs.writeFileSync('unknown-data.txt', 'retain'); process.exit(7);\n`);
    await expect(worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: repo.head() }))
      .rejects.toThrow(/custody/);
    const path = readFileSync(log, 'utf8');
    expect(readFileSync(join(path, 'unknown-data.txt'), 'utf8')).toBe('retain');
    expect(ledger.getWorktree(round.id)).toBeNull();
  });

  it('preserves tree and branch when a failed hook changes the branch custody receipt', async () => {
    const repo = fixture('assigned-hook-branch-custody');
    const original = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'changed-branch', repo: 'assigned', title: 'changed custody', baseBranch: 'main' });
    const { hook, log } = failingCheckoutHook(repo);
    writeFileSync(hook, '#!/usr/bin/env node\n' +
      `const fs = require('node:fs'), cp = require('node:child_process'); fs.writeFileSync(${JSON.stringify(log)}, process.cwd());\n` +
      `cp.execFileSync('git', ['update-ref', 'HEAD', 'HEAD~1']); fs.writeFileSync('changed-data.txt', 'retain'); process.exit(7);\n`);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })).rejects.toThrow(/custody unconfirmed/);
    const path = readFileSync(log, 'utf8');
    expect(readFileSync(join(path, 'changed-data.txt'), 'utf8')).toBe('retain');
    expect(git(repo.path, ['rev-parse', `refs/heads/gru/${job.id}`])).not.toBe(original);
    expect(git(repo.path, ['worktree', 'list', '--porcelain'])).toContain('locked gru-creation:');
    expect(ledger.getWorktree(job.id)).toBeNull();
  });

  it('sees a new live directive beyond terminal history in native force admission', async () => {
    const repo = fixture('assigned-force-directive-history');
    origin(repo);
    repo.git(['checkout', '-b', 'feature/shared']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    repo.git(['push', '--quiet', 'origin', 'feature/shared']);
    const h = await waveFixture(repo, async () => ({ headRefName: 'feature/shared', headSha: target }));
    const other = h.ledger.addJob({ id: 'history-owner', repo: 'assigned', title: 'busy owner', baseBranch: 'main' });
    registerPrBranchLane(repo, h.ledger, other.id);
    h.ledger.setJobStatus(other.id, 'working');
    terminalDirectiveHistory(h.ledger, other.id);
    const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
      reviewArtifactRoot: h.artifactRoot, prHeadProbe: async () => ({ headRefName: 'feature/shared', headSha: target }),
      reviewPreflight: async () => {
        h.ledger.beginDirectiveIntent({ jobId: other.id, requestId: 'z-new-work', directive: 'new work', holder: 'fixture' });
        return { ok: true, failures: [] };
      },
    });
    await expect(wave.requestReview({ jobId: h.job.id, targetRef: 'feature/shared', force: true }))
      .rejects.toMatchObject({ name: 'BranchBusyError' });
    expect(h.runtime.leadCalls).toHaveLength(0);
    expect(h.ledger.listJobEvents(h.job.id).filter((event) => event.kind === 'branch-idle.forced')).toHaveLength(1);
  });

  it('does not carry fallback force authority to a new directive on an audited busy job', async () => {
    const repo = fixture('assigned-fallback-force-directive');
    origin(repo);
    const h = await waveFixture(repo, async () => { throw new Error('fallback must not probe'); }, false);
    h.ledger.setJobStatus(h.job.id, 'blocked');
    h.ledger.setJobStatus(h.job.id, 'working');
    terminalDirectiveHistory(h.ledger, h.job.id);
    const skillPath = join(directory(), 'SKILL.md');
    writeFileSync(skillPath, '---\nname: bmad-review\n---\nfixture review\n');
    let fallbackRuns = 0;
    const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
      reviewArtifactRoot: h.artifactRoot,
      reviewPreflight: async () => {
        h.ledger.beginDirectiveIntent({ jobId: h.job.id, requestId: 'z-new-work', directive: 'new work', holder: 'fixture' });
        return { ok: false, failures: [{ leg: 'review-policy', detail: 'fixture refusal', remediation: 'fixture repair' }] };
      },
      fallbackGate: { skillPath, runFallbackReview: async () => { fallbackRuns += 1; return []; },
        fixDirectiveSink: async () => ({ delivered: true }) },
    });
    await expect(wave.requestReview({ jobId: h.job.id, force: true })).rejects.toThrow(/new busy lane/);
    expect(fallbackRuns).toBe(0);
    expect(h.ledger.listJobEvents(h.job.id).filter((event) => event.kind === 'branch-idle.forced')).toHaveLength(1);
  });

  it('rejects replacement of an audited rebrief at preflight and post-freeze seams', async () => {
    for (const seam of ['preflight', 'post-freeze'] as const) {
      const repo = fixture(`assigned-force-rebrief-${seam}`);
      origin(repo);
      repo.git(['checkout', '-b', 'feature/rebrief']);
      const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
      repo.git(['push', '--quiet', 'origin', 'feature/rebrief']);
      const h = await waveFixture(repo, async () => ({ headRefName: 'feature/rebrief', headSha: target }));
      const old = h.ledger.beginPendingRebrief({ jobId: h.job.id, note: 'old blocker', briefing: 'old work' });
      const replace = () => {
        h.ledger.clearPendingRebriefs(old.map((marker) => marker.id));
        h.ledger.beginPendingRebrief({ jobId: h.job.id, note: 'replacement', briefing: 'new work' });
      };
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
        reviewArtifactRoot: h.artifactRoot, prHeadProbe: async () => ({ headRefName: 'feature/rebrief', headSha: target }),
        ...(seam === 'preflight' ? { reviewPreflight: async () => { replace(); return { ok: true, failures: [] }; } }
          : { reviewFreezeObserver: replace }),
      });
      await expect(wave.requestReview({ jobId: h.job.id, force: true })).rejects.toMatchObject({ name: 'BranchBusyError' });
      expect(h.runtime.leadCalls).toHaveLength(0);
      expect(h.ledger.listJobEvents(h.job.id).filter((event) => event.kind === 'branch-idle.forced')).toHaveLength(seam === 'preflight' ? 1 : 2);
    }
  });

  it('supports relative backlinks and failed-hook retry for every creation authority', async () => {
    const repo = fixture('assigned-relative-custody');
    repo.git(['config', 'worktree.useRelativePaths', 'true']);
    const { ledger, worktrees } = manager();
    const parentJob = ledger.addJob({ id: 'relative-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
    const job = ledger.addJob({ id: 'relative-job', repo: 'assigned', title: 'relative custody', baseBranch: 'main' });
    const round = ledger.addRound({ jobId: job.id, targetRef: repo.head() });
    for (const authority of ['job', 'review', 'writer', 'read-only'] as const) {
      const id = authority === 'job' ? job.id : authority === 'review' ? round.id : `relative-${authority}`;
      const create = () => authority === 'job' ? worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })
        : authority === 'review' ? worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: repo.head() })
          : worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
      const { hook, log } = failingCheckoutHook(repo);
      await expect(create()).rejects.toThrow();
      expect(existsSync(readFileSync(log, 'utf8'))).toBe(false);
      expect(ledger.getWorktree(id)).toBeNull();
      rmSync(hook);
      const lane = await create();
      expect(ledger.getWorktree(id)?.status).toBe('active');
      expect(git(repo.path, ['worktree', 'list', '--porcelain'])).not.toContain('locked');
      expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(repo.head());
    }
  });

  it('keeps the owned checkout reservation until branch rollback has completed', async () => {
    const repo = fixture('assigned-rollback-adoption-race');
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'rollback-adoption', repo: 'assigned', title: 'rollback race', baseBranch: 'main' });
    const { hook } = failingCheckoutHook(repo);
    const branch = `gru/${job.id}`;
    const external = join(directory(), 'external-holder');
    const wrapperRoot = directory();
    const marker = join(wrapperRoot, 'adoption-result');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(wrapperRoot, 'git'), '#!/usr/bin/env node\n' +
      'const fs = require("node:fs"), cp = require("node:child_process"); const args = process.argv.slice(2);\n' +
      `const r = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });\n` +
      `if (args[0] === 'worktree' && args[1] === 'remove' && r.status === 0) {\n` +
      ` const a = cp.spawnSync(${JSON.stringify(realGit)}, ['worktree', 'add', ${JSON.stringify(external)}, ${JSON.stringify(branch)}]);\n` +
      ` fs.writeFileSync(${JSON.stringify(marker)}, String(a.status)); if (a.status === 0) fs.writeFileSync(${JSON.stringify(join(external, 'external-data.txt'))}, 'external owner'); }\n` +
      'process.exit(r.status ?? 1);\n');
    chmodSync(join(wrapperRoot, 'git'), 0o755);
    vi.stubEnv('PATH', `${wrapperRoot}:${process.env.PATH ?? ''}`);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })).rejects.toThrow();
    if (readFileSync(marker, 'utf8') === '0') {
      // If another creator won, its unchanged-tip branch must still exist.
      expect(git(repo.path, ['rev-parse', `refs/heads/${branch}`])).toBe(repo.head());
      expect(readFileSync(join(external, 'external-data.txt'), 'utf8')).toBe('external owner');
    } else {
      expect(git(repo.path, ['branch', '--list', branch])).toBe('');
      rmSync(hook);
      const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      expect(lane.branch).toBe(branch);
    }
  });

  it('retains unchanged-tip adoption before add for job and writer-child branches', async () => {
    const repo = fixture('assigned-before-add-adoption');
    const { ledger, worktrees } = manager();
    const parentJob = ledger.addJob({ id: 'adoption-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
    const job = ledger.addJob({ id: 'adoption-job', repo: 'assigned', title: 'adoption', baseBranch: 'main' });
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const servicePath = process.env.PATH ?? '';
    for (const authority of ['job', 'writer'] as const) {
      const id = authority === 'job' ? job.id : 'adopted-child';
      const branch = authority === 'job' ? `gru/${job.id}` : `gru/${parentJob.id}-child-${id}`;
      const external = join(directory(), 'adopter');
      const wrapperRoot = directory();
      const marker = join(wrapperRoot, 'adopted');
      writeFileSync(join(wrapperRoot, 'git'), '#!/usr/bin/env node\n' +
        'const fs = require("node:fs"), cp = require("node:child_process"); const args = process.argv.slice(2);\n' +
        `if (args[0] === 'worktree' && args[1] === 'add' && !fs.existsSync(${JSON.stringify(marker)})) {\n` +
        ` cp.execFileSync(${JSON.stringify(realGit)}, ['worktree', 'add', ${JSON.stringify(external)}, ${JSON.stringify(branch)}]);\n` +
        ` fs.writeFileSync(${JSON.stringify(marker)}, 'adopted'); fs.writeFileSync(${JSON.stringify(join(external, 'external-data.txt'))}, 'external owner'); }\n` +
        `const r = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`);
      chmodSync(join(wrapperRoot, 'git'), 0o755);
      vi.stubEnv('PATH', `${wrapperRoot}:${servicePath}`);
      const create = authority === 'job' ? worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })
        : worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
      await expect(create).rejects.toThrow(/custody unconfirmed/);
      expect(git(external, ['rev-parse', 'HEAD'])).toBe(repo.head());
      expect(git(repo.path, ['rev-parse', `refs/heads/${branch}`])).toBe(repo.head());
      expect(readFileSync(join(external, 'external-data.txt'), 'utf8')).toBe('external owner');
      expect(ledger.getWorktree(id)).toBeNull();
      vi.stubEnv('PATH', servicePath);
    }
  });

  it('retains registered lanes when post-registration unlock fails for every authority', async () => {
    const repo = fixture('assigned-registered-handoff');
    const { ledger, worktrees } = manager();
    const parentJob = ledger.addJob({ id: 'handoff-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
    const job = ledger.addJob({ id: 'handoff-job', repo: 'assigned', title: 'handoff', baseBranch: 'main' });
    const round = ledger.addRound({ jobId: job.id, targetRef: repo.head() });
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapperRoot = directory();
    writeFileSync(join(wrapperRoot, 'git'), '#!/usr/bin/env node\n' +
      'const fs = require("node:fs"), cp = require("node:child_process"), p = require("node:path"); const args = process.argv.slice(2);\n' +
      `if (args[0] === 'worktree' && args[1] === 'unlock') { fs.writeFileSync(p.join(args[2], 'registered-data.txt'), 'retain'); process.exit(9); }\n` +
      `const r = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`);
    chmodSync(join(wrapperRoot, 'git'), 0o755);
    vi.stubEnv('PATH', `${wrapperRoot}:${process.env.PATH ?? ''}`);
    for (const authority of ['job', 'review', 'writer', 'read-only'] as const) {
      const id = authority === 'job' ? job.id : authority === 'review' ? round.id : `handoff-${authority}`;
      const create = authority === 'job' ? worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })
        : authority === 'review' ? worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: repo.head() })
          : worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
      await expect(create).rejects.toThrow(/registered lane retained/);
      const record = ledger.getWorktree(id);
      expect(record?.status).toBe('active');
      expect(readFileSync(join(record!.path, 'registered-data.txt'), 'utf8')).toBe('retain');
      expect(git(record!.path, ['rev-parse', 'HEAD'])).toBe(repo.head());
      expect(git(repo.path, ['worktree', 'list', '--porcelain'])).toContain('locked gru-creation:');
    }
  });

  it('cleans owned orphaned detached registrations after a hook removes the checkout', async () => {
    const repo = fixture('assigned-orphaned-checkout');
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'orphan-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const round = ledger.addRound({ jobId: job.id, targetRef: repo.head() });
    for (const kind of ['review', 'read-only'] as const) {
      const { hook } = failingCheckoutHook(repo);
      writeFileSync(hook, '#!/usr/bin/env node\nrequire("node:fs").rmSync(process.cwd(), {recursive:true, force:true}); process.exit(7);\n');
      const create = () => kind === 'review' ? worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: repo.head() })
        : worktrees.createChildWorktree({ repoPath: repo.path, jobId: job.id, childId: 'orphan-reader', parentPath: parent.path, authority: kind });
      await expect(create()).rejects.toThrow();
      expect(git(repo.path, ['worktree', 'list', '--porcelain'])).not.toContain('locked');
      rmSync(hook);
      const lane = await create();
      expect(ledger.getWorktree(lane.id)?.status).toBe('active');
    }
  });

  it('isolates Git bootstrap commands for job and writer-child lanes while retaining credentials', async () => {
    const repo = fixture('assigned-bootstrap-environment');
    repo.commitFile('.gru-command/worktree.toml', `[[setup]]\ncommand = 'git rev-parse --show-toplevel > .setup-repo; printf "$SSH_AUTH_SOCK" > .setup-auth'\n`);
    const foreign = fixture('foreign-bootstrap-environment');
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'bootstrap-owner', repo: 'assigned', title: 'bootstrap', baseBranch: 'main' });
    const before = foreignState(foreign);
    poison(foreign);
    vi.stubEnv('SSH_AUTH_SOCK', '/fixture/ssh-agent');
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const child = await worktrees.createChildWorktree({ repoPath: repo.path, jobId: job.id, childId: 'bootstrap-child', parentPath: parent.path, authority: 'writer' });
    for (const lane of [parent, child]) {
      expect(readFileSync(join(lane.path, '.setup-repo'), 'utf8').trim()).toBe(realpathSync(lane.path));
      expect(readFileSync(join(lane.path, '.setup-auth'), 'utf8')).toBe('/fixture/ssh-agent');
    }
    expect(foreignState(foreign)).toEqual(before);
  });

  it('binds worktree-relative revision pins once rather than against detached target HEAD', async () => {
    const repo = fixture('assigned-relative-revision-pin');
    origin(repo);
    repo.git(['checkout', '-b', 'feature/pinned']);
    const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    const h = await waveFixture(repo, async () => { throw new Error('intentional pin must not probe'); }, false);
    const lane = h.worktrees.listWorktrees({ jobId: h.job.id }).find((item) => item.kind === 'job')!;
    git(lane.path, ['reset', '--hard', target]);
    writeFileSync(join(lane.path, 'newer.txt'), 'newer\n');
    git(lane.path, ['add', 'newer.txt']);
    git(lane.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'newer lane head']);
    const request = await h.wave.requestReview({ jobId: h.job.id, targetRef: 'HEAD~1' });
    if (request.route !== 'perkins') throw new Error(`expected native request, got ${request.route}`);
    const outcome = await request.run;
    expect(outcome.headMoved).toBe(false);
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE'); // No PR publication authority is invented.
    expect(h.runtime.leadCalls).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(h.artifactRoot, outcome.round.id, 'manifest.json'), 'utf8'))).toMatchObject({ targetSha: target, targetRef: target });
  });

  it('refuses successful checkout hooks that retarget detached HEAD or a writer branch', async () => {
    const repo = fixture('assigned-successful-retarget');
    repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'retarget-parent', repo: 'assigned', title: 'retarget', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const round = ledger.addRound({ jobId: job.id, targetRef: repo.head() });
    const { hook, log } = failingCheckoutHook(repo);
    writeFileSync(hook, '#!/usr/bin/env node\nconst fs = require("node:fs"), cp = require("node:child_process");\n' +
      `fs.writeFileSync(${JSON.stringify(log)}, process.cwd()); cp.execFileSync('git', ['update-ref', 'HEAD', 'HEAD~1']); process.exit(0);\n`);
    await expect(worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: repo.head() })).rejects.toThrow(/target changed/);
    expect(ledger.getWorktree(round.id)).toBeNull();
    expect(existsSync(readFileSync(log, 'utf8'))).toBe(false);
    writeFileSync(hook, '#!/usr/bin/env node\nconst fs = require("node:fs"), cp = require("node:child_process");\n' +
      `fs.writeFileSync(${JSON.stringify(log)}, process.cwd()); cp.execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main']); process.exit(0);\n`);
    await expect(worktrees.createChildWorktree({ repoPath: repo.path, jobId: job.id, childId: 'retarget-writer', parentPath: parent.path, authority: 'writer' })).rejects.toThrow(/custody unconfirmed/);
    expect(ledger.getWorktree('retarget-writer')).toBeNull();
    expect(existsSync(readFileSync(log, 'utf8'))).toBe(true);
    expect(git(repo.path, ['worktree', 'list', '--porcelain'])).toContain('locked gru-creation:');
  });

  it('fences new provider recovery claims on audited native and fallback owners', async () => {
    for (const route of ['native', 'fallback'] as const) {
      const repo = fixture(`assigned-recovery-generation-${route}`);
      origin(repo);
      repo.git(['checkout', '-b', 'feature/shared']);
      const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
      repo.git(['push', '--quiet', 'origin', 'feature/shared']);
      const h = await waveFixture(repo, async () => ({ headRefName: 'feature/shared', headSha: target }));
      const other = h.ledger.addJob({ id: 'recovery-owner', repo: 'assigned', title: 'busy owner', baseBranch: 'main' });
      registerPrBranchLane(repo, h.ledger, other.id);
      h.ledger.setJobStatus(other.id, 'working');
      const skillPath = join(directory(), 'SKILL.md');
      writeFileSync(skillPath, '---\nname: bmad-review\n---\nfixture review\n');
      let fallbackRuns = 0;
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
        reviewArtifactRoot: h.artifactRoot, prHeadProbe: async () => ({ headRefName: 'feature/shared', headSha: target }),
        reviewPreflight: async () => {
          h.ledger.appendCustomEvent({ kind: 'provider.recovery-claimed', jobId: other.id, payload: { wait_id: 'new-continuation' } });
          return route === 'native' ? { ok: true, failures: [] } : { ok: false, failures: [{ leg: 'review-policy', detail: 'fixture refusal', remediation: 'fixture repair' }] };
        },
        fallbackGate: { skillPath, runFallbackReview: async () => { fallbackRuns += 1; return []; }, fixDirectiveSink: async () => ({ delivered: true }) },
      });
      await expect(wave.requestReview({ jobId: h.job.id, targetRef: 'feature/shared', force: true })).rejects.toThrow(route === 'native' ? /busy/ : /new busy lane/);
      expect(h.runtime.leadCalls).toHaveLength(0);
      expect(fallbackRuns).toBe(0);
      expect(h.ledger.listJobEvents(h.job.id).filter((event) => event.kind === 'branch-idle.forced')).toHaveLength(1);
    }
  });

  it('fences live default-branch owners before freeze and after the advertised probe', async () => {
    for (const seam of ['freeze', 'probe'] as const) {
      const repo = fixture(`assigned-default-idle-${seam}`);
      const remote = origin(repo);
      repo.git(['checkout', '-b', 'trunk']);
      repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
      repo.git(['push', '--quiet', 'origin', 'trunk']);
      repo.git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
      git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
      const h = await waveFixture(repo, async () => { throw new Error('non-PR must not probe'); }, false);
      const other = h.ledger.addJob({ id: 'default-owner', repo: 'assigned', title: 'trunk owner', baseBranch: 'main' });
      git(repo.path, ['checkout', 'main']);
      const path = join(directory(), 'trunk-owner');
      git(repo.path, ['worktree', 'add', path, 'trunk']);
      h.ledger.registerWorktree({ id: other.id, kind: 'job', repoPath: repo.path, repoName: 'assigned', path, branch: 'trunk', sha: git(path, ['rev-parse', 'HEAD']), baseSource: null, jobId: other.id });
      if (seam === 'freeze') h.ledger.setJobStatus(other.id, 'working');
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
        reviewArtifactRoot: h.artifactRoot, ...(seam === 'probe' ? { reviewFreezeObserver: () => { h.ledger.setJobStatus(other.id, 'working'); } } : {}),
      });
      await expect(wave.requestReview({ jobId: h.job.id, targetRef: 'origin/HEAD' })).rejects.toMatchObject({ name: 'BranchBusyError', targetBranch: 'trunk' });
      expect(h.runtime.leadCalls).toHaveLength(0);
    }
  });

  it('never waives own new work or a retirement hold for foreign-target fallback', async () => {
    for (const change of ['directive', 'retirement'] as const) {
      const repo = fixture(`assigned-foreign-fallback-${change}`);
      origin(repo);
      const h = await waveFixture(repo, async () => { throw new Error('fallback must not probe'); }, false);
      const lane = h.worktrees.listWorktrees({ jobId: h.job.id }).find((item) => item.kind === 'job')!;
      const skillPath = join(directory(), 'SKILL.md');
      writeFileSync(skillPath, '---\nname: bmad-review\n---\nfixture review\n');
      let fallbackRuns = 0;
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner, reviewArtifactRoot: h.artifactRoot,
        reviewPreflight: async () => {
          const { record } = h.ledger.beginDirectiveIntent({ jobId: h.job.id, directive: 'new own work', holder: 'fixture' });
          if (change === 'retirement') h.ledger.retireInterruptedDirective({ requestId: record.requestId, expectedJobId: h.job.id,
            expectedState: 'dispatching', expectedPayloadHash: record.payloadHash, expectedHead: lane.sha,
            lane: { id: lane.id, resolvedHead: lane.sha }, reason: 'interrupted request', by: 'fixture' });
          return { ok: false, failures: [{ leg: 'review-policy', detail: 'fixture refusal', remediation: 'fixture repair' }] };
        },
        fallbackGate: { skillPath, runFallbackReview: async () => { fallbackRuns += 1; return []; }, fixDirectiveSink: async () => ({ delivered: true }) },
      });
      await expect(wave.requestReview({ jobId: h.job.id, targetRef: 'refs/heads/main', force: true })).rejects.toThrow(change === 'directive' ? /new busy lane/ : /recovery hold/);
      expect(fallbackRuns).toBe(0);
      expect(h.ledger.listJobEvents(h.job.id).filter((event) => event.kind === 'branch-idle.forced')).toHaveLength(1);
    }
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
