import { issueFixtureHandoff } from './helpers/fixture-handoff.js';
import * as handoffProof from '../src/worktrees/handoff.js';
import { ChildWorkerService } from '../src/dispatch/child-workers.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import { stageSpawnRegistration } from '../src/runtime/spawn-registration.js';
import { observeDisposalSettlement } from '../src/runtime/disposal-observation.js';
import { SessionStore } from '../src/sessions/store.js';
import { loadConfig, type Role, type RuntimeId } from '../src/config.js';
import type { AgentHandle, AgentRuntime, RuntimeEventListener } from '../src/runtime/types.js';
import { rebriefFreshMinion } from '../src/dispatch/fix-directive.js';
import { PacingGate } from '../src/runtime/pacing.js';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { branchNameForRef } from '../src/dispatch/branch-idle.js';
import { freezeReviewInputs, repositoryGitEnv, sourceMovementSinceFreeze } from '../src/dispatch/perkins-review/artifacts.js';
import { headMovedSinceFreeze } from '../src/dispatch/perkins-review/whole.js';
import { prBranchCandidate, resolveFreshPrHead, type PrHeadProbe } from '../src/dispatch/perkins-review/fresh-head.js';
import { enactedStateFor, GhPrPoster, GitLabMrPoster, WaveRunner, type VerdictReviewEvent } from '../src/dispatch/perkins.js';
import { probeGitHubRemote, repoRemote, runReviewPreflight } from '../src/dispatch/review-path.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { writeCreationIntent } from '../src/worktrees/creation-intent.js';
import { attachBareOrigin, makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';
import { directiveRetirementInputs } from './helpers/directive-native-fixture.js';

const repos: FixtureRepo[] = [];
const dirs: string[] = [];
const dbs: LedgerDb[] = [];

afterEach(() => {
  vi.useRealTimers();
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
    // CI runners have no global identity; fixture commits must not depend on one.
    encoding: 'utf8', env: { ...repositoryGitEnv(false), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** The repository's real common directory, as git reports it. */
function commonDir(repo: FixtureRepo): string {
  return git(repo.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
}

/** Retained creation receipts for this repository (#453). */
function receiptFiles(repo: FixtureRepo): string[] {
  const dir = join(commonDir(repo), 'gru-creation');
  return existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith('.json')) : [];
}

/** The stalled owned child must be gone, not merely unreferenced: a
 * regression that drops the SIGKILL escalation would otherwise pass. */
function assertOwnedChildDead(proxy: { readonly proof: string }): void {
  expect(() => process.kill(JSON.parse(readFileSync(proxy.proof, 'utf8')).pid, 0)).toThrow();
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

/** Lanes apply their own committed manifest (#427): commit it in the parent
 * lane and fast-forward main to it, so job lanes (main) and writer children
 * (the parent's HEAD) both carry it, at the same commit. */
function commitLaneManifest(repo: FixtureRepo, parentPath: string, manifest: string): void {
  mkdirSync(join(parentPath, '.gru-command'), { recursive: true });
  writeFileSync(join(parentPath, '.gru-command', 'worktree.toml'), manifest);
  git(parentPath, ['add', '.gru-command/worktree.toml']);
  git(parentPath, ['commit', '-qm', 'lane manifest']);
  git(repo.path, ['merge', '--quiet', '--ff-only', git(parentPath, ['rev-parse', 'HEAD'])]);
}

function origin(repo: FixtureRepo): string {
  const path = attachBareOrigin(repo);
  repo.git(['push', '--quiet', 'origin', 'main']);
  repo.git(['symbolic-ref', 'HEAD', 'refs/heads/main'], path);
  return path;
}

function manager(): { readonly ledger: LedgerApi; readonly worktrees: WorktreeManager; readonly root: string; readonly dbPath: string; readonly bus: EventBus } {
  const dbPath = directory();
  const db = new LedgerDb(dbPath);
  dbs.push(db);
  const bus = new EventBus();
  const ledger = new LedgerApi(db.handle, { bus });
  const root = directory();
  return {
    ledger, root, dbPath, bus,
    worktrees: new WorktreeManager({
      ledger, root, preserveRoot: directory(),
      setupTimeoutMs: 30_000, enumerateProcesses: () => [],
    }),
  };
}

async function waveFixture(repo: FixtureRepo, probe: PrHeadProbe, linkedPr = true) {
  const { ledger, worktrees, dbPath, bus } = manager();
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
      post: async ({ targetSha, body, reviewEvent }) => ({
        reviewId: 'fixture-review', actor: 'fixture-bot', event: enactedStateFor(reviewEvent),
        commitId: targetSha, headSha: targetSha, baseSha: 'fixture-base',
        bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      }),
    },
    reviewArtifactRoot: artifactRoot, prHeadProbe: probe,
  });
  return { ledger, worktrees, job, wave, runtime, artifactRoot, dbPath, bus };
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
  async function rollbackRaceFixture(name: string, authority: 'job' | 'writer') {
    const repo = fixture(name);
    const h = manager();
    const parentJob = h.ledger.addJob({ id: 'r8-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
    const job = h.ledger.addJob({ id: 'r8-job', repo: 'assigned', title: 'rollback', baseBranch: 'main' });
    const id = authority === 'job' ? job.id : 'r8-child';
    const ref = authority === 'job' ? `refs/heads/gru/${id}` : `refs/heads/gru/${parentJob.id}-child-${id}`;
    const create = () => authority === 'job' ? h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: id })
      : h.worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
    return { repo, ...h, parent, id, ref, create };
  }

  it('keeps original parent custody through queued bootstrap and registration child boundaries (final review)', async () => {
    for (const authority of ['writer', 'read-only'] as const) for (const seam of ['queue', 'bootstrap', 'registration', 'healthy'] as const) {
      if (authority === 'read-only' && seam === 'bootstrap') continue; // readers never bootstrap
      const repo = fixture(`final-parent-${authority}-${seam}`), h = manager();
      const job = h.ledger.addJob({ id: 'parent', repo: 'assigned', title: 'original parent' });
      const parent = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      const admin = git(parent.path, ['rev-parse', '--absolute-git-dir']);
      const ready = join(directory(), 'ready'), release = `${ready}.release`, script = `${ready}.cjs`;
      const blocking = seam === 'queue' || seam === 'bootstrap';
      writeFileSync(join(parent.path, 'advance'), 'healthy parent advance');
      if (blocking) {
        writeFileSync(script, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},process.cwd());let n=0;const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);}else if(++n===1000){clearInterval(timer);process.exitCode=7;}},10);`);
        const manifest = `[[setup]]\ncommand = ${JSON.stringify(`"${process.execPath}" "${script}"`)}\n`;
        // Lanes apply their own committed manifest (#427): the writer child
        // carries it from the parent's advance, the queue's blocker from main.
        mkdirSync(join(parent.path, '.gru-command'), { recursive: true });
        writeFileSync(join(parent.path, '.gru-command/worktree.toml'), manifest);
        git(parent.path, ['add', '.gru-command/worktree.toml']);
        repo.commitFile('.gru-command/worktree.toml', manifest);
      }
      git(parent.path, ['add', 'advance']); git(parent.path, ['commit', '-qm', 'advance original writer']);
      const advanced = git(parent.path, ['rev-parse', 'HEAD']);
      git(repo.path, ['branch', 'foreign-parent', advanced]);
      const mutate = () => { writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/foreign-parent\n'); writeFileSync(join(parent.path, 'foreign-data'), 'retain parent'); };
      const blocker = h.ledger.addJob({ id: 'locker', repo: 'assigned', title: 'holds repo lock' });
      const stop = h.bus.subscribe((event) => { if (seam === 'registration' && event.kind === 'worktree.created' && h.ledger.getWorktree('child') !== null) mutate(); });
      const operations: Promise<unknown>[] = [];
      try {
        if (seam === 'queue') {
          const holding = h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: blocker.id }); operations.push(holding);
          await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
        }
        const child = h.worktrees.createChildWorktree({ repoPath: repo.path, jobId: job.id, childId: 'child', parentPath: parent.path, authority })
          .then((lane) => ({ lane, error: null }), (error: unknown) => ({ lane: null, error }));
        operations.push(child);
        if (seam === 'bootstrap') await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
        if (seam === 'queue' || seam === 'bootstrap') { mutate(); writeFileSync(release, 'release owned setup'); }
        const result = await child;
        if (seam === 'healthy') {
          expect(result.error).toBeNull(); expect(result.lane?.sha).toBe(advanced);
          handoffProof.capturePortLaneHandoff(h.worktrees, parent)();
        } else {
          expect(String(result.error), `${authority}:${seam}`).toMatch(/handoff unresolved/);
          expect(result.lane).toBeNull();
          const row = h.ledger.getWorktree('child');
          if (seam === 'registration') {
            expect(row?.status).toBe('active');
            expect(() => handoffProof.capturePortLaneHandoff(h.worktrees, row!)()).toThrow(/handoff unresolved/);
          } else expect(row).toBeNull();
          expect(readFileSync(join(parent.path, 'foreign-data'), 'utf8')).toBe('retain parent');
          expect(readFileSync(join(admin, 'HEAD'), 'utf8')).toBe('ref: refs/heads/foreign-parent\n');
          expect(h.ledger.getWorktree(parent.id)?.status).toBe('active');
          expect(git(repo.path, ['rev-parse', 'refs/heads/foreign-parent'])).toBe(advanced);
        }
      } finally { stop(); writeFileSync(release, 'fixture finally'); await Promise.allSettled(operations); }
    }
  });

  it('refuses direct ChildWorkerService unresolved parents without a child or prompt and allows original writer advances (final review)', async () => {
    for (const lost of [false, true]) {
      const repo = fixture(`final-direct-parent-${lost}`), h = manager();
      const job = h.ledger.addJob({ id: 'service-parent', repo: 'assigned', title: 'parent', briefing: 'implement parent' });
      const parent = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      h.ledger.setJobStatus(job.id, 'working');
      h.ledger.registerAgent({ id: 'parent-agent', role: 'minion', jobId: job.id, parentage: 'top-level' });
      writeFileSync(join(parent.path, 'advance'), 'valid original writer'); git(parent.path, ['add', 'advance']); git(parent.path, ['commit', '-qm', 'advance']);
      const advanced = git(parent.path, ['rev-parse', 'HEAD']), admin = git(parent.path, ['rev-parse', '--absolute-git-dir']);
      if (lost) writeFileSync(join(admin, 'locked'), 'foreign retained parent');
      const sessionFile = join(directory(), 'child.jsonl'); writeFileSync(sessionFile, '');
      let ceased = false;
      const prompt = vi.fn(async () => { writeFileSync(sessionFile, JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Final report: completed isolated task.' }] } }) + '\n'); });
      const spawner = vi.fn(async (role: Role, options?: { agentId?: string }): Promise<AgentHandle> => ({ id: options?.agentId ?? 'child', role, sessionFile,
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        prompt, steer: async () => {}, followUp: async () => {}, cessationEvidence: () => (ceased ? 'ceased' as const : 'unknown' as const), subscribe: () => () => {},
        health: () => ({ state: ceased ? 'disposed' : 'idle', lastActivity: null, sessionFile }), dispose: async () => { ceased = true; } }));
      const createChild = vi.spyOn(h.worktrees, 'createChildWorktree');
      const children = new ChildWorkerService({ ledger: h.ledger, worktrees: h.worktrees, spawner });
      const child = children.request({ parentAgentId: 'parent-agent', jobId: job.id, purpose: 'isolated task', task: 'report completion', authority: 'writer', idempotencyKey: 'one' });
      try {
        await vi.waitFor(() => expect(h.ledger.getChildWorker(child.record.id)?.resultState).toBe(lost ? 'error' : 'done'));
        expect(createChild).toHaveBeenCalledTimes(lost ? 0 : 1);
        expect(spawner).toHaveBeenCalledTimes(lost ? 0 : 1); expect(prompt).toHaveBeenCalledTimes(lost ? 0 : 1);
        if (lost) {
          expect(h.ledger.getWorktree(child.record.id)).toBeNull();
          expect(existsSync(join(h.root, parent.repoName, `child-${child.record.id}`))).toBe(false);
          expect(git(repo.path, ['branch', '--list', `gru/${job.id}-child-${child.record.id}`])).toBe('');
          expect(readFileSync(join(admin, 'locked'), 'utf8')).toBe('foreign retained parent');
        }
        else expect(h.ledger.getWorktree(child.record.id)?.sha).toBe(advanced);
        expect(existsSync(parent.path)).toBe(true); expect(h.ledger.getWorktree(parent.id)?.status).toBe('active');
      } finally { await children.dispose(); }
    }
  });

  it('refuses successful job and writer bootstrap FIFO HEAD and loose refs before Git with finite owned unblock (final review)', async () => {
    const failures: { metadata: string; authority: string; fifo: boolean; error: unknown }[] = [];
    for (const metadata of ['HEAD', 'loose-ref'] as const) for (const authority of ['job', 'writer'] as const) for (const fifo of [false, true]) {
      const h = await rollbackRaceFixture(`final-success-fifo-${authority}-${fifo}`, authority);
      const root = directory(), ready = join(root, 'ready.json'), finished = join(root, 'finished'), unblocked = join(root, 'unblocked'), script = join(root, 'setup.cjs');
      writeFileSync(script, `const fs=require('node:fs'),cp=require('node:child_process'),p=require('node:path');const admin=cp.execFileSync('git',['rev-parse','--absolute-git-dir'],{encoding:'utf8'}).trim(),common=fs.realpathSync(p.resolve(admin,fs.readFileSync(p.join(admin,'commondir'),'utf8').trim())),file=${metadata === 'HEAD' ? "p.join(admin,'HEAD')" : "p.join(common,cp.execFileSync('git',['symbolic-ref','HEAD'],{encoding:'utf8'}).trim())"},head=fs.readFileSync(file,'utf8');fs.writeFileSync(p.join(process.cwd(),'retained-data'),'owned successful setup');${fifo ? "fs.unlinkSync(file);cp.execFileSync('mkfifo',[file]);" : ''}fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({file,head,tree:process.cwd(),admin}));`);
      commitLaneManifest(h.repo, h.parent.path, `[[setup]]\ncommand = ${JSON.stringify(`"${process.execPath}" "${script}"`)}\n`);
      const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');let n=0;const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finished)})){clearInterval(poll);}else if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(poll);setTimeout(()=>{if(fs.existsSync(${JSON.stringify(finished)}))return;const r=JSON.parse(fs.readFileSync(${JSON.stringify(ready)},'utf8'));if(!fs.lstatSync(r.file).isFIFO())return;const fd=fs.openSync(r.file,fs.constants.O_RDWR|fs.constants.O_NONBLOCK);fs.writeSync(fd,r.head);fs.closeSync(fd);fs.unlinkSync(r.file);fs.writeFileSync(r.file,r.head);fs.writeFileSync(${JSON.stringify(unblocked)},'owned unblock');},800);}else if(++n===1000){clearInterval(poll);process.exitCode=9;}},10);`], { stdio: 'pipe' });
      console.error(`[final-bootstrap-fifo] owned child pid=${child.pid}`);
      const settled = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', (code) => { console.error(`[final-bootstrap-fifo] child closed pid=${child.pid} code=${code}`); done(code); }); });
      try {
        const creation = h.create();
        if (fifo) {
          const error = await creation.then(() => null, (failure: unknown) => failure);
          expect(existsSync(unblocked)).toBe(false);
          await expect(Promise.reject(error)).rejects.toThrow(/custody unconfirmed/);
          expect(h.ledger.getWorktree(h.id)).toBeNull();
          const state = JSON.parse(readFileSync(ready, 'utf8')) as { tree: string; admin: string; file: string; head: string };
          expect(readFileSync(join(state.tree, 'retained-data'), 'utf8')).toBe('owned successful setup');
          expect(existsSync(join(state.admin, 'locked'))).toBe(true);
          if (metadata === 'HEAD') expect(git(h.repo.path, ['rev-parse', h.ref])).toBe(h.repo.head());
          else { expect(lstatSync(state.file).isFIFO()).toBe(true); expect(state.head.trim()).toBe(h.repo.head()); }
          const allocate = vi.fn<AgentRuntime['spawn']>(async () => { throw new Error('unresolved checkout must not reach an adapter'); });
          const adapter: AgentRuntime = { id: 'pi', capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
            health: () => ({ state: 'ok' }), dispose: async () => {}, spawn: allocate };
          class Registry extends RuntimeRegistry { override runtimeIdFor(): RuntimeId { return 'pi'; } override runtimeFor(): AgentRuntime { return adapter; } }
          const registry = new Registry({ config: loadConfig({ GRU_COMMAND_HOME: directory() }), store: new SessionStore(directory()) });
          try { await expect(registry.spawn('minion', { cwd: state.tree })).rejects.toThrow(/handoff unresolved/); expect(allocate).not.toHaveBeenCalled(); }
          finally { await registry.dispose(); }
        } else {
          const lane = await creation; handoffProof.capturePortLaneHandoff(h.worktrees, lane)();
          expect(readFileSync(join(lane.path, 'retained-data'), 'utf8')).toBe('owned successful setup');
        }
      } catch (error) { failures.push({ metadata, authority, fifo, error }); }
      finally {
        writeFileSync(finished, 'creation settled');
        try { expect(await settled).toBe(0); }
        finally { if (existsSync(ready)) { const state = JSON.parse(readFileSync(ready, 'utf8')) as { file: string; head: string }; if (existsSync(join(state.file, '..'))) { rmSync(state.file, { force: true }); writeFileSync(state.file, state.head); } } }
      }
    }
    expect(failures).toEqual([]); // report every authority, never stop at the first FIFO
  });

  it('retains original forced verification authority after admission resident and pacing waits without rearming (final review)', async () => {
    for (const seam of ['admission', 'resident', 'pacing'] as const) for (const replacement of [false, true]) {
      const repo = fixture(`final-force-${seam}-${replacement}`); origin(repo);
      const h = await waveFixture(repo, async () => { throw new Error('local target must not probe PR'); }, false);
      const lane = h.worktrees.getWorktree(h.job.id)!;
      writeFileSync(join(lane.path, 'change'), 'review change'); git(lane.path, ['add', 'change']); git(lane.path, ['commit', '-qm', 'review change']);
      h.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: h.job.id, payload: { run_id: 'audited-A' } });
      h.ledger.appendCustomEvent({ kind: 'verification.started', jobId: h.job.id, payload: { run_id: 'audited-A' } });
      const replace = () => { if (replacement) h.ledger.appendCustomEvent({ kind: 'verification.started', jobId: h.job.id, payload: { run_id: 'new-B' } }); };
      const adapter: AgentRuntime = { id: 'pi', capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        health: () => ({ state: 'ok' }), dispose: async () => {}, spawn: h.runtime.spawner };
      class Registry extends RuntimeRegistry { override runtimeIdFor(): RuntimeId { return 'pi'; } override runtimeFor(): AgentRuntime { return adapter; } }
      const config = loadConfig({ GRU_COMMAND_HOME: directory() });
      const registry = new Registry({ config: { ...config, concurrency: { ...config.concurrency, maxWorkers: 2 } }, store: new SessionStore(directory()) });
      const holdOne = seam === 'resident' ? await registry.reserveResident() : null;
      const holdTwo = seam === 'resident' ? await registry.reserveResident() : null;
      const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 0, maxConcurrentReviewTurns: 1 });
      let holdTurn = seam === 'pacing' ? await gate.acquireReviewTurn({ id: 'held', label: 'owned fixture turn' }) : null;
      let admissionSeen = false;
      const stop = h.bus.subscribe((event) => { if (event.kind === 'round.admission-preflight') { admissionSeen = true; if (seam === 'admission') replace(); } });
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner, reviewArtifactRoot: h.artifactRoot,
        ...(seam === 'resident' ? { reserveReviewRound: (signal: AbortSignal) => registry.reserveReviewRound(signal) } : {}),
        ...(seam === 'pacing' ? { reviewGate: gate } : {}) });
      try {
        const admitted = await wave.requestReview({ jobId: h.job.id, force: true });
        expect(admitted.route).toBe('perkins');
        if (admitted.route !== 'perkins') throw new Error('fixture expected native Perkins admission');
        // Attach immediately: admission-observer refusal can settle before the waiter resumes.
        const outcome = admitted.run.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
        expect(admissionSeen).toBe(true);
        if (seam === 'resident') {
          await vi.waitFor(() => expect(registry.residencySnapshot().queued).toBeGreaterThan(0)); replace(); holdOne!(); holdTwo!();
        } else if (seam === 'pacing') {
          await vi.waitFor(() => expect(gate.view().review.queued.length).toBeGreaterThan(0)); replace(); holdTurn!.release(); holdTurn = null;
        }
        const settled = await outcome;
        if (!replacement) {
          expect(settled.error).toBeNull();
          expect(h.runtime.leadCalls[0]?.prompt).toEqual(expect.any(String));
        }
        expect(h.runtime.leadCalls, `${seam}:${replacement}`).toHaveLength(replacement ? 0 : 1);
        expect(h.runtime.childCalls).toHaveLength(0);
        expect(h.ledger.latestRoundEvent(admitted.round.id, 'round.admission-preflight')?.payload).toMatchObject({ ok: true });
        expect(h.ledger.hasUnsettledVerificationRun(h.job.id)).toBe(true);
        // A's valid past audit remains; B never receives a new force override.
        const audits = h.ledger.listJobEvents(h.job.id).filter((event) => event.kind === 'branch-idle.forced');
        expect(audits.length).toBeGreaterThan(0);
        const b = h.ledger.latestJobEvent(h.job.id, 'verification.started');
        if (replacement) expect(audits.every((event) => event.seq < b!.seq)).toBe(true);
      } finally { stop(); holdOne?.(); holdTwo?.(); holdTurn?.release(); await wave.shutdown(); await h.wave.shutdown(); await registry.dispose(); }
    }
  });

  it('accepts exhaustive authentic handoff history beyond 1000 and rejects later-page incomplete or duplicate proof (ordinary review)', async () => {
    const repo = fixture('ordinary-history'), h = manager();
    const originalJob = h.ledger.addJob({ id: 'history-original', repo: 'assigned', title: 'independent original' });
    const original = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: originalJob.id });
    const guardedJob = h.ledger.addJob({ id: 'history-guard', repo: 'assigned', title: 'early-page conflict control' });
    const guarded = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: guardedJob.id });
    const guardedFact = h.ledger.listEventsAfter(0, { kinds: ['worktree.handoff-completed'], order: 'desc', limit: 1 })[0]!;
    const serialRoot = directory();
    let path = join(serialRoot, 'serial-0');
    git(repo.path, ['worktree', 'add', '-b', 'fixture-history', path]);
    const admin = git(path, ['rev-parse', '--absolute-git-dir']);
    let prior: ReturnType<typeof issueFixtureHandoff> | undefined;
    for (let index = 0; index < 1001; index += 1) {
      if (prior !== undefined) {
        handoffProof.captureLaneHandoff(prior)();
        const receipt = join(admin, 'gru-creation-handoff.json');
        const proved = readFileSync(receipt, 'utf8');
        h.ledger.setWorktreeStatus(prior.id, 'swept', 'fixture retires original registration before serial checkout reuse');
        const moved = join(serialRoot, `serial-${index}`);
        git(repo.path, ['worktree', 'move', path, moved]);
        path = moved;
        expect(git(path, ['rev-parse', '--absolute-git-dir'])).toBe(admin);
        expect(realpathSync(readFileSync(join(admin, 'gitdir'), 'utf8').trim())).toBe(realpathSync(join(path, '.git')));
        expect(readFileSync(receipt, 'utf8')).toBe(proved);
        rmSync(receipt);
      }
      const id = `history-${String(index).padStart(4, '0')}`;
      h.ledger.addJob({ id, repo: 'assigned', title: 'authentic serial fixture owner' });
      prior = issueFixtureHandoff({ id, kind: 'job', repoPath: repo.path, repoName: 'assigned', path,
        branch: 'fixture-history', sha: original.sha, jobId: id, roundId: null, status: 'active' }, h.ledger);
    }
    if (prior === undefined) throw new Error('fixture history was not issued');
    expect(h.ledger.countEvents('worktree.handoff-completed')).toBe(1003);
    handoffProof.captureLaneHandoff(prior)();
    const db = new LedgerDb(h.dbPath); dbs.push(db);
    const ledger = new LedgerApi(db.handle);
    const reopened = new WorktreeManager({ ledger, root: h.root, preserveRoot: directory(), setupTimeoutMs: 30_000, enumerateProcesses: () => [] });
    writeFileSync(join(original.path, 'advance'), 'legitimate writer advance');
    git(original.path, ['add', 'advance']); git(original.path, ['commit', '-qm', 'advance']);
    handoffProof.capturePortLaneHandoff(reopened, reopened.getWorktree(original.id)!)();
    const list = ledger.listEventsAfter.bind(ledger);
    const missing = vi.spyOn(ledger, 'listEventsAfter').mockImplementation((seq, options) => {
      const page = list(seq, options);
      return options?.kinds?.includes('worktree.handoff-completed') && seq > 0 ? [] : page;
    });
    expect(() => handoffProof.capturePortLaneHandoff(reopened, reopened.getWorktree(original.id)!)()).toThrow(/handoff unresolved/);
    missing.mockRestore();
    expect((await reopened.release({ worktreeId: original.id })).status).toBe('swept');
    expect(existsSync(original.path)).toBe(false);
    // An early-page match cannot hide a later-page duplicate or conflict.
    ledger.appendCustomEvent({ kind: guardedFact.kind, jobId: guardedFact.jobId, roundId: guardedFact.roundId, payload: guardedFact.payload });
    expect(() => handoffProof.capturePortLaneHandoff(reopened, reopened.getWorktree(guarded.id)!)()).toThrow(/handoff unresolved/);
    const last = ledger.listEventsAfter(0, { kinds: ['worktree.handoff-completed'], order: 'desc', limit: 2 }).find((event) => event.jobId === prior.id)!;
    if (typeof last?.payload !== 'object' || last.payload === null) throw new Error('last authentic issuance is unavailable');
    ledger.appendCustomEvent({ kind: last.kind, jobId: last.jobId, roundId: last.roundId, payload: { ...last.payload, repo: 'foreign repository' } });
    expect(() => handoffProof.capturePortLaneHandoff(reopened, reopened.getWorktree(prior.id)!)()).toThrow(/handoff unresolved/);
    expect(existsSync(path)).toBe(true); expect(existsSync(guarded.path)).toBe(true);
  });

  it('guards trusted owning ancestors for descendant cwd aliases awaits and retained or replaced roots (ordinary review)', async () => {
    const repo = fixture('ordinary-descendant'), h = manager();
    const job = h.ledger.addJob({ id: 'descendant-owner', repo: 'assigned', title: 'trusted ancestor' });
    const lane = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const cwd = join(lane.path, 'nested', 'src'); mkdirSync(cwd, { recursive: true });
    const alias = join(directory(), 'alias'); symlinkSync(lane.path, alias);
    const parentAlias = join(directory(), 'parent-alias'); symlinkSync(join(lane.path, 'nested'), parentAlias);
    const semanticCwd = `${parentAlias}/..`;
    expect(execFileSync(process.execPath, ['-e', 'console.log(process.cwd())'], { cwd: semanticCwd, encoding: 'utf8' }).trim()).toBe(realpathSync(lane.path));
    handoffProof.captureCwdHandoff(join(alias, 'nested', 'src'))();
    const prompted = vi.fn(async () => {});
    let spawnCount = 0;
    const adapter: AgentRuntime = { id: 'pi', capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
      health: () => ({ state: 'ok' }), dispose: async () => {}, spawn: vi.fn(async (role: Role): Promise<AgentHandle> => {
        let ceased = false;
        const listeners = new Set<RuntimeEventListener>();
        const id = `descendant-minion-${++spawnCount}`;
        return { id, role, sessionFile: null, capabilities: adapter.capabilities, prompt: prompted,
          steer: async () => {}, followUp: async () => {}, cessationEvidence: () => (ceased ? 'ceased' as const : 'unknown' as const), health: () => ({ state: ceased ? 'disposed' : 'idle', lastActivity: null, sessionFile: null }),
          hasLiveProcess: () => !ceased, isCompacting: () => false,
          subscribe: (listener: RuntimeEventListener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
          dispose: async () => { ceased = true; for (const listener of listeners) listener({ type: 'state', state: 'disposed' }); } };
      }) };
    class Registry extends RuntimeRegistry { override runtimeIdFor(): RuntimeId { return 'pi'; } override runtimeFor(): AgentRuntime { return adapter; } }
    const config = loadConfig({ GRU_COMMAND_HOME: directory() });
    const registry = new Registry({ config: { ...config, concurrency: { ...config.concurrency, maxWorkers: 2 } }, store: new SessionStore(directory()) });
    const healthy = await registry.spawn('minion', { cwd: semanticCwd });
    await healthy.prompt('genuine completed descendant');
    expect(prompted).toHaveBeenCalledTimes(1);
    const admin = git(lane.path, ['rev-parse', '--absolute-git-dir']);
    const held = await registry.reserveResident();
    const waiting = registry.spawn('minion', { cwd: semanticCwd }).then(() => false, (error: unknown) => String(error).includes('handoff unresolved'));
    try {
      await vi.waitFor(() => expect(registry.residencySnapshot().queued).toBe(1));
      writeFileSync(join(admin, 'locked'), 'foreign queued custody');
      held();
      expect(await waiting).toBe(true);
      expect(adapter.spawn).toHaveBeenCalledTimes(1);
      await expect(healthy.prompt('queued alias lost custody')).rejects.toThrow(/handoff unresolved/);
    } finally { held(); }
    rmSync(join(admin, 'locked')); // restore only fixture-owned mutation for the independent observer control
    const unsubscribe = registry.onAgentEvent((event) => { if (event.phase === 'spawned') writeFileSync(join(admin, 'locked'), 'foreign observer custody'); });
    await expect(registry.spawn('minion', { cwd: semanticCwd })).rejects.toThrow(/handoff unresolved/);
    unsubscribe();
    expect(adapter.spawn).toHaveBeenCalledTimes(2);
    expect(registry.getHandle('descendant-minion-2')).toBeNull();
    await expect(healthy.prompt('obsolete descendant prompt')).rejects.toThrow(/handoff unresolved/);
    await healthy.dispose();
    for (const path of [cwd, semanticCwd, `${parentAlias}/../missing/descendant`, join(alias, 'nested', 'src'), join(lane.path, 'missing', 'descendant')]) {
      await expect(registry.spawn('minion', { cwd: path })).rejects.toThrow(/handoff unresolved/);
    }
    expect(adapter.spawn).toHaveBeenCalledTimes(2); expect(prompted).toHaveBeenCalledTimes(1);
    rmSync(lane.path, { recursive: true, force: true });
    expect(() => handoffProof.captureCwdHandoff(cwd)()).toThrow(/handoff unresolved/);
    mkdirSync(cwd, { recursive: true }); mkdirSync(join(lane.path, '.git'));
    writeFileSync(join(cwd, 'foreign-data'), 'retain replacement');
    for (const path of [cwd, join(alias, 'nested', 'src')]) expect(() => handoffProof.captureCwdHandoff(path)()).toThrow(/handoff unresolved/);
    expect(readFileSync(join(cwd, 'foreign-data'), 'utf8')).toBe('retain replacement');
    expect(readFileSync(join(admin, 'locked'), 'utf8')).toBe('foreign observer custody');
    const unmanaged = directory(); mkdirSync(join(unmanaged, 'src'));
    handoffProof.captureCwdHandoff(join(unmanaged, 'src'))();
    await registry.dispose();
  });

  it('refuses FIFO creation and orphan custody metadata before an owned finite unblock is needed (ordinary review)', async () => {
    for (const orphan of [false, true]) {
      const repo = fixture(`ordinary-fifo-${orphan}`), h = manager();
      const job = h.ledger.addJob({ id: 'fifo-owner', repo: 'assigned', title: 'retain foreign FIFO' });
      const { hook, log } = failingCheckoutHook(repo);
      const ready = `${log}.ready`, unblocked = `${log}.unblocked`, finished = `${log}.finished`;
      writeFileSync(hook, '#!/usr/bin/env node\nconst fs=require("node:fs"),cp=require("node:child_process"),p=require("node:path");\n' +
        `const tree=process.cwd(),admin=cp.execFileSync('git',['rev-parse','--absolute-git-dir'],{encoding:'utf8'}).trim();
        fs.writeFileSync(${JSON.stringify(log)},tree);fs.writeFileSync(p.join(admin,'retained-data'),'foreign metadata');
        const file=p.join(admin,'locked');fs.unlinkSync(file);cp.execFileSync('mkfifo',[file]);
        ${orphan ? 'fs.rmSync(tree,{recursive:true,force:true});' : ''}
        fs.writeFileSync(${JSON.stringify(ready)},file);process.exit(7);\n`);
      // This exact owned child opens RDWR/nonblocking after a finite delay;
      // even the authentic blocking RED must settle and cannot strand Vitest.
      const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');let attempts=0,writes=0;
        const done=()=>fs.existsSync(${JSON.stringify(finished)});
        const unblock=()=>{if(done())return;if(++writes>100){process.exitCode=8;return;}
          const fd=fs.openSync(fs.readFileSync(${JSON.stringify(ready)},'utf8'),fs.constants.O_RDWR|fs.constants.O_NONBLOCK);
          fs.writeFileSync(${JSON.stringify(unblocked)},'owned finite unblock');fs.writeSync(fd,'foreign nonce\\n');fs.closeSync(fd);
          setTimeout(unblock,50);};
        const poll=setInterval(()=>{if(done()){clearInterval(poll);}else if(fs.existsSync(${JSON.stringify(ready)})){
          clearInterval(poll);setTimeout(unblock,800);
        }else if(++attempts===1000){clearInterval(poll);process.exitCode=9;}},10);`], { stdio: 'pipe' });
      console.error(`[ordinary-fifo] owned unblock child pid=${child.pid}`);
      const settled = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', (code) => { console.error(`[ordinary-fifo] owned unblock child closed pid=${child.pid} code=${code}`); done(code); }); });
      try {
        await expect(h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })).rejects.toThrow(/custody unconfirmed/);
        expect(existsSync(unblocked)).toBe(false);
        expect(h.ledger.getWorktree(job.id)).toBeNull();
        expect(existsSync(join(readFileSync(ready, 'utf8'), '..', 'retained-data'))).toBe(true);
        expect(git(repo.path, ['rev-parse', `refs/heads/gru/${job.id}`])).toBe(repo.head());
      } finally {
        writeFileSync(finished, 'creation settled');
        try { expect(await settled).toBe(0); }
        finally {
          // Teardown must remove only its own deliberately retained FIFO even
          // when the settled unblock child failed, or Git inventory blocks too.
          if (existsSync(ready)) rmSync(readFileSync(ready, 'utf8'), { force: true });
        }
      }
    }
  });

  it('reproves original PR-linked local names independently of live refresh at each admission boundary (ordinary review)', async () => {
    for (const seam of ['preflight', 'refresh', 'freeze', 'admission', 'unchanged'] as const) for (const mutation of ['delete', 'alias'] as const) {
      const repo = fixture(`ordinary-pr-identity-${seam}-${mutation}`);
      origin(repo); repo.git(['checkout', '-b', 'feature/live']);
      const target = repo.commitFile('src/assigned.ts', 'export const reviewed = true;\n');
      repo.git(['push', '--quiet', 'origin', 'feature/live']); repo.git(['tag', 'same-target', target]);
      const h = await waveFixture(repo, async () => ({ headSha: target, headRefName: 'feature/live' }));
      const candidate = `refs/heads/gru/${h.job.id}`;
      const mutate = () => {
        if (mutation === 'delete') git(repo.path, ['update-ref', '-d', candidate]);
        else git(repo.path, ['symbolic-ref', candidate, 'refs/tags/same-target']);
      };
      const original = h.worktrees.createReviewWorktree.bind(h.worktrees);
      if (seam === 'freeze') vi.spyOn(h.worktrees, 'createReviewWorktree').mockImplementation(async (input) => { const lane = await original(input); mutate(); return lane; });
      const probe = vi.fn(async () => { if (seam === 'refresh') mutate(); return { headSha: target, headRefName: 'feature/live' }; });
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner, reviewArtifactRoot: h.artifactRoot,
        prHeadProbe: probe, reviewPreflight: async () => { if (seam === 'preflight') mutate(); return { ok: true, failures: [] }; },
        ...(seam === 'admission' ? { reviewFreezeObserver: mutate } : {}) });
      const request = wave.requestReview({ jobId: h.job.id, targetRef: candidate, noSpec: true });
      if (seam === 'unchanged') {
        const admitted = await request; await admitted.run;
        expect(h.runtime.leadCalls).toHaveLength(1);
        expect(h.ledger.latestJobEvent(h.job.id, 'round.admission-preflight')?.payload).toMatchObject({ ok: true });
        expect(probe).toHaveBeenCalledTimes(1);
      } else {
        await expect(request).rejects.toThrow(/identity/);
        expect(h.runtime.leadCalls).toHaveLength(0);
        expect(h.runtime.childCalls).toHaveLength(0);
        expect(h.ledger.listJobEvents(h.job.id).some((event) => event.kind === 'round.admission-preflight')).toBe(false);
        expect(probe).toHaveBeenCalledTimes(seam === 'preflight' ? 0 : 1);
      }
      expect(h.ledger.listJobEvents(h.job.id).some((event) => event.kind === 'branch-idle.forced')).toBe(false);
      await wave.shutdown(); await h.wave.shutdown();
    }
  });

  it('rechecks original reflog receipt under the prepared deletion lock before touching same-SHA foreign replacements (R8)', async () => {
    const servicePath = process.env.PATH ?? '';
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    for (const authority of ['job', 'writer'] as const) {
      const h = await rollbackRaceFixture(`r8-foreign-receipt-${authority}`, authority);
      const { log } = failingCheckoutHook(h.repo);
      const root = directory(), counter = join(root, 'transactions');
      writeFileSync(join(root, 'git'), '#!/usr/bin/env node\nconst cp=require("node:child_process"),fs=require("node:fs"),args=process.argv.slice(2);\n' +
        `if(args[0]==='update-ref'&&args.includes('--stdin')) { const n=fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)}))+1:1; fs.writeFileSync(${JSON.stringify(counter)},String(n));
        if(n===2){ cp.execFileSync(${JSON.stringify(realGit)},['update-ref','-d',${JSON.stringify(h.ref)}]); cp.execFileSync(${JSON.stringify(realGit)},['update-ref','--create-reflog','-m','foreign-recreated',${JSON.stringify(h.ref)},${JSON.stringify(h.repo.head())}]); }}
        const r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);\n`);
      chmodSync(join(root, 'git'), 0o755); vi.stubEnv('PATH', `${root}:${servicePath}`);
      const creation = h.create(); await expect(creation).rejects.toThrow();
      vi.stubEnv('PATH', servicePath);
      expect(git(h.repo.path, ['branch', '--list', h.ref.slice('refs/heads/'.length)])).not.toBe('');
      await expect(creation).rejects.toThrow(/custody unconfirmed/);
      expect(git(h.repo.path, ['reflog', 'show', '-1', '--format=%gs', h.ref])).toBe('foreign-recreated');
      expect(git(h.repo.path, ['rev-parse', h.ref])).toBe(h.repo.head());
      expect(existsSync(readFileSync(log, 'utf8'))).toBe(true);
      expect(git(h.repo.path, ['worktree', 'list', '--porcelain'])).toContain('locked gru-creation:');
      expect(h.ledger.getWorktree(h.id)).toBeNull();
    }
  });

  it('reproves checkout and orphan admin custody after settled deletion hooks and retains replacement data (R8)', async () => {
    for (const authority of ['job', 'writer'] as const) for (const orphan of [false, true]) {
      const h = await rollbackRaceFixture(`r8-replaced-admin-${authority}-${orphan}`, authority);
      const { log } = failingCheckoutHook(h.repo);
      if (orphan) {
        const checkoutHook = join(h.repo.path, '.git/hooks/post-checkout');
        writeFileSync(checkoutHook, '#!/usr/bin/env node\nconst fs=require("node:fs"),p=require("node:path");\n' +
          `fs.writeFileSync(${JSON.stringify(log)},process.cwd());fs.rmSync(process.cwd(),{recursive:true,force:true});process.exit(7);\n`);
      }
      const hook = join(h.repo.path, '.git/hooks/reference-transaction');
      const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      writeFileSync(hook, '#!/usr/bin/env node\nconst fs=require("node:fs"),p=require("node:path"),cp=require("node:child_process");const fields=fs.readFileSync(0,"utf8").trim().split(" ");\n' +
        `if(process.argv[2]==='committed'&&fields[2]===${JSON.stringify(h.ref)}&&/^0+$/.test(fields[1])) {
          const checkout=fs.readFileSync(${JSON.stringify(log)},'utf8'), common=${JSON.stringify(join(h.repo.path, '.git/worktrees'))};
          const admin=fs.readdirSync(common).map(n=>p.join(common,n)).find(a=>fs.readFileSync(p.join(a,'gitdir'),'utf8').trim()===p.join(checkout,'.git'));
          fs.writeFileSync(${JSON.stringify(log + '.admin')},admin);fs.renameSync(admin,admin+'-previous');fs.cpSync(admin+'-previous',admin,{recursive:true});fs.writeFileSync(p.join(admin,'locked'),'foreign-reservation');fs.writeFileSync(p.join(admin,'replacement-data'),'retain admin');
          if(${JSON.stringify(!orphan)}){fs.rmSync(checkout,{recursive:true,force:true});fs.mkdirSync(checkout,{recursive:true});fs.writeFileSync(p.join(checkout,'.git'),'gitdir: '+admin+'\\n');fs.writeFileSync(p.join(checkout,'replacement-data'),'retain checkout');}
          cp.execFileSync(${JSON.stringify(realGit)},['update-ref','--create-reflog','-m','foreign-after-settlement',${JSON.stringify(h.ref)},${JSON.stringify(h.repo.head())}]);
        }\n`);
      chmodSync(hook, 0o755);
      const creation = h.create(); await expect(creation).rejects.toThrow();
      const checkout = readFileSync(log, 'utf8');
      const admin = readFileSync(log + '.admin', 'utf8');
      expect(existsSync(admin)).toBe(true);
      await expect(creation).rejects.toThrow(/custody unconfirmed/);
      expect(readFileSync(join(admin, 'locked'), 'utf8')).toBe('foreign-reservation');
      expect(readFileSync(join(admin, 'replacement-data'), 'utf8')).toBe('retain admin');
      if (!orphan) expect(readFileSync(join(checkout, 'replacement-data'), 'utf8')).toBe('retain checkout');
      expect(git(h.repo.path, ['reflog', 'show', '-1', '--format=%gs', h.ref])).toBe('foreign-after-settlement');
      expect(git(h.repo.path, ['rev-parse', h.ref])).toBe(h.repo.head());
      expect(existsSync(admin + '-previous')).toBe(true);
      expect(h.ledger.getWorktree(h.id)).toBeNull();
    }
  });

  it('keeps explicit non-origin tracking pins source-bound without PR selection while origin and heads refresh live (R8)', async () => {
    for (const targetRef of ['refs/remotes/upstream/topic', 'refs/remotes/origin/topic', 'refs/heads/topic']) {
      const repo = fixture('r8-nonorigin-pin'); origin(repo);
      repo.git(['checkout', '-b', 'topic']);
      const pin = repo.commitFile('src/pin.ts', 'export const pin = true;\n');
      const live = repo.commitFile('src/live.ts', 'export const live = true;\n');
      repo.git(['push', '--quiet', 'origin', 'topic']);
      repo.git(['update-ref', 'refs/remotes/upstream/topic', pin]);
      const probe = vi.fn(async () => ({ headRefName: 'topic', headSha: live }));
      const h = await waveFixture(repo, probe);
      const admitted = await h.wave.requestReview({ jobId: h.job.id, targetRef });
      await admitted.run;
      const round = h.ledger.listRounds(h.job.id)[0]!;
      const manifest = JSON.parse(readFileSync(join(h.artifactRoot, round.id, 'manifest.json'), 'utf8'));
      expect(manifest.targetSha).toBe(targetRef.includes('/upstream/') ? pin : live);
      expect(manifest.targetRef).toBe(targetRef.includes('/upstream/') ? targetRef : 'refs/remotes/origin/topic');
      expect(probe.mock.calls.length).toBe(targetRef.includes('/upstream/') ? 0 : 1);
      await h.wave.shutdown();
    }
  });

  it('rejects same-SHA named aliases at terminal submission and finalization with unchanged canonical controls (R8)', async () => {
    // The shared equality-shortcut path must protect canonical local heads,
    // not just the tracking ref used by the publishable PR control.
    const repo = fixture('r8-terminal-local-head'); repo.git(['checkout', '-b', 'terminal-head']);
    const target = repo.commitFile('src/local.ts', 'export const local = true;\n');
    repo.git(['tag', 'same-head', target]);
    const checkout = join(directory(), 'detached'); repo.git(['worktree', 'add', '--detach', checkout, target]);
    const frozen = freezeReviewInputs({ repoPath: checkout, artifactRoot: directory(), roundId: 'r8-head',
      baseRef: 'main', targetRef: target, movementRef: 'refs/heads/terminal-head', noSpec: true });
    vi.stubEnv('GIT_TRACE', '1');
    expect(sourceMovementSinceFreeze(frozen)).toBeNull();
    expect(headMovedSinceFreeze(frozen, frozen.manifest.targetRef)).toBeNull();
    repo.git(['symbolic-ref', 'refs/heads/terminal-head', 'refs/tags/same-head']);
    expect(sourceMovementSinceFreeze(frozen)).toMatchObject({ cause: 'target-moved' });
    expect(headMovedSinceFreeze(frozen, frozen.manifest.targetRef)).toMatchObject({ cause: 'target-moved' });
    vi.unstubAllEnvs();
    for (const seam of ['unchanged', 'submission', 'finalization'] as const) {
      const repo = fixture(`r8-terminal-identity-${seam}`); origin(repo);
      repo.git(['checkout', '-b', 'topic']);
      const target = repo.commitFile('src/terminal.ts', 'export const terminal = true;\n');
      repo.git(['tag', 'terminal-tip', target]);
      repo.git(['push', '--quiet', 'origin', 'topic']);
      const probe = async () => ({ headRefName: 'topic', headSha: target });
      const h = await waveFixture(repo, probe);
      const alias = () => git(repo.path, ['symbolic-ref', 'refs/remotes/origin/topic', 'refs/tags/terminal-tip']);
      const runtime = fakeWholeSpawner(directory(), { childAnswer: () => '[]', ...(seam === 'submission' ? { beforeSubmit: alias } : {}) });
      const post = vi.fn(async ({ targetSha, body, reviewEvent }: { targetSha: string; body: string; reviewEvent: VerdictReviewEvent }) => ({ reviewId: 'r8-review', actor: 'fixture-bot', event: enactedStateFor(reviewEvent),
        commitId: targetSha, headSha: targetSha, baseSha: repo.git(['rev-parse', 'main']), bodySha256: createHash('sha256').update(body).digest('hex') }));
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, reviewArtifactRoot: h.artifactRoot, poster: { post }, prHeadProbe: probe,
        spawner: async (role, options) => {
          const handle = await runtime.spawner(role, options);
          return { ...handle, prompt: async (prompt, promptOptions) => {
            await handle.prompt(prompt, promptOptions);
            if (options?.reviewLead !== undefined && seam === 'finalization') alias();
          } };
        },
      });
      const admitted = await wave.requestReview({ jobId: h.job.id, targetRef: 'refs/heads/topic' });
      const outcome = await admitted.run;
      expect(runtime.leadCalls).toHaveLength(1);
      if (seam === 'unchanged') { expect(outcome).toMatchObject({ verdict: 'approved' }); expect(post).toHaveBeenCalledTimes(1); }
      else {
        expect(outcome).toMatchObject({ verdict: null, posted: false }); expect(post).not.toHaveBeenCalled();
        if (seam === 'submission') expect(runtime.toolErrors.some((error) => /source changed.*named identity/u.test(error.error))).toBe(true);
        else expect(h.ledger.latestJobEvent(h.job.id, 'round.head-moved')?.payload).toMatchObject({ cause: 'target-moved' });
        expect(git(repo.path, ['rev-parse', 'refs/remotes/origin/topic'])).toBe(target);
        expect(git(repo.path, ['symbolic-ref', '--no-recurse', 'refs/remotes/origin/topic'])).toBe('refs/tags/terminal-tip');
      }
      await wave.shutdown();
    }

  });

  it('keeps the event loop responsive during a prepared exact-name metadata query (R8)', async () => {
    const repo = fixture('r8-async-metadata');
    const { ledger, worktrees } = manager(); ledger.addJob({ id: 'r8-query', repo: 'assigned', title: 'query', baseBranch: 'main' });
    const root = directory(), heartbeat = join(root, 'heartbeat'), proof = join(root, 'proof');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(heartbeat, '0');
    writeFileSync(join(root, 'git'), '#!/usr/bin/env node\nconst fs=require("node:fs"),cp=require("node:child_process"),a=process.argv.slice(2);\n' +
      `if(a[0]==='symbolic-ref'&&a.includes('--no-recurse')&&fs.existsSync(${JSON.stringify(join(repo.path, '.git/refs/heads/gru/r8-query.lock'))})) {
        const before=fs.readFileSync(${JSON.stringify(heartbeat)},'utf8');let elapsed=0;const timer=setInterval(()=>{elapsed+=10;const responsive=fs.readFileSync(${JSON.stringify(heartbeat)},'utf8')!==before;if(responsive||elapsed>=1000){fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify({responsive}));clearInterval(timer);process.exit(1);}},10);
      }else{const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);}\n`);
    chmodSync(join(root, 'git'), 0o755); vi.stubEnv('PATH', `${root}:${process.env.PATH ?? ''}`);
    let ticks = 0; const pulse = setInterval(() => writeFileSync(heartbeat, String(++ticks)), 10);
    try { await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'r8-query' }); }
    finally { clearInterval(pulse); }
    expect(JSON.parse(readFileSync(proof, 'utf8'))).toEqual({ responsive: true });
  });

  it('bounds prepared metadata floods and TERM-ignoring queries without authority or unrelated-child signals (R8)', async () => {
    const servicePath = process.env.PATH ?? '';
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    for (const mode of ['symbolic-stdout', 'symbolic-stderr', 'receipt-stdout', 'receipt-stderr', 'deadline', 'exit-pipes', 'symbolic-mixed', 'receipt-mixed'] as const) {
      const h = await rollbackRaceFixture(`r8-query-${mode}`, 'job');
      const { log } = failingCheckoutHook(h.repo);
      const root = directory(), proof = join(root, 'query'), term = join(root, 'term');
      writeFileSync(join(root, 'git'), '#!/usr/bin/env node\nconst fs=require("node:fs"),cp=require("node:child_process"),a=process.argv.slice(2);\n' +
        `const lock=${JSON.stringify(join(h.repo.path, '.git', `${h.ref}.lock`))};
        if(fs.existsSync(lock)&&(a[0]==='symbolic-ref'&&a.includes('--no-recurse')&&${JSON.stringify(!mode.startsWith('receipt'))}||a[0]==='reflog'&&${JSON.stringify(mode.startsWith('receipt'))})) {
          fs.writeFileSync(${JSON.stringify(proof)},String(process.pid));process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(term)},'owned TERM'));
          ${mode === 'exit-pipes' ? `cp.spawn(process.execPath,['-e',${JSON.stringify(`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(root, 'pipe-started'))},'started');setTimeout(()=>fs.writeFileSync(${JSON.stringify(join(root, 'pipe-done'))},'done'),5500);`)}],{stdio:'inherit'});process.exit(1);` : ''}
          ${mode.endsWith('mixed') ? 'process.stdout.write(Buffer.alloc(9*1024*1024,120));process.stderr.write(Buffer.alloc(9*1024*1024,120));'
            : mode === 'deadline' || mode === 'exit-pipes' ? '' : `process.${mode.endsWith('stderr') ? 'stderr' : 'stdout'}.write(Buffer.alloc(17*1024*1024,120));`}
          setTimeout(()=>process.exit(1),6000);setInterval(()=>{},1000);
        }else{const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);}\n`);
      chmodSync(join(root, 'git'), 0o755);
      git(h.repo.path, ['update-ref', 'refs/heads/unrelated-live', h.repo.head()]);
      const unrelated = spawn(realGit, ['update-ref', '--stdin', '--no-deref'], { cwd: h.repo.path, stdio: ['pipe', 'pipe', 'pipe'] });
      let replies = ''; unrelated.stdout.on('data', (chunk: Buffer) => { replies += chunk.toString(); });
      unrelated.stdin.write(`start\nupdate refs/heads/unrelated-live ${h.repo.head()} ${h.repo.head()}\nprepare\n`);
      for (let tick = 0; tick < 100 && !replies.includes('prepare: ok'); tick++) await new Promise((done) => setTimeout(done, 10));
      expect(replies).toContain('prepare: ok');
      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      const active = new Map<ReturnType<typeof setTimeout>, () => void>();
      if (mode === 'deadline' || mode === 'exit-pipes') {
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((cb: () => void, delay?: number) => {
          const timer = originalSetTimeout(cb, delay); if (delay === 30_000) active.set(timer, cb); return timer;
        }) as typeof setTimeout);
        vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => { active.delete(timer as ReturnType<typeof setTimeout>); originalClearTimeout(timer); });
      }
      try {
        vi.stubEnv('PATH', `${root}:${servicePath}`);
        const creation = h.create(); const assertion = expect(creation).rejects.toThrow(mode === 'symbolic-mixed'
          ? /combined output exceeded 16 MiB/ : /authority unconfirmed|custody unconfirmed/);
        if (mode === 'deadline' || mode === 'exit-pipes') {
          for (let tick = 0; tick < 200 && (!existsSync(proof) || mode === 'exit-pipes' && !existsSync(join(root, 'pipe-started'))); tick++) await new Promise((done) => originalSetTimeout(done, 10));
          expect(existsSync(proof)).toBe(true); expect(active.size).toBe(1);
          for (const cb of active.values()) cb();
        }
        await assertion;
        if (mode === 'receipt-mixed') await expect(creation).rejects.toMatchObject({ errors: [expect.anything(),
          expect.objectContaining({ message: expect.stringContaining('combined output exceeded 16 MiB') })] });
        vi.stubEnv('PATH', servicePath);
        if (mode === 'exit-pipes') expect(existsSync(term)).toBe(false);
        else expect(readFileSync(term, 'utf8')).toBe('owned TERM');
        const pid = Number(readFileSync(proof, 'utf8')); expect(() => process.kill(pid, 0)).toThrow();
        expect(unrelated.exitCode).toBeNull(); expect(unrelated.signalCode).toBeNull();
        expect(existsSync(join(h.repo.path, '.git/refs/heads/unrelated-live.lock'))).toBe(true);
        expect(h.ledger.getWorktree(h.id)).toBeNull();
        if (mode.startsWith('receipt')) { expect(existsSync(readFileSync(log, 'utf8'))).toBe(true); expect(git(h.repo.path, ['rev-parse', h.ref])).toBe(h.repo.head()); }
        else expect(git(h.repo.path, ['branch', '--list', 'gru/r8-job'])).toBe('');
      } finally {
        vi.restoreAllMocks(); vi.stubEnv('PATH', servicePath);
        const stopped = new Promise<void>((done) => unrelated.once('close', () => done())); unrelated.stdin.end('abort\n'); await stopped;
        if (mode === 'exit-pipes') {
          for (let tick = 0; tick < 1000 && !existsSync(join(root, 'pipe-done')); tick++) await new Promise((done) => originalSetTimeout(done, 10));
          expect(existsSync(join(root, 'pipe-done'))).toBe(true);
        }
      }
    }
  });

  it('rechecks post-registration identity and nonce before unlock across all authorities with unchanged controls (R8 coverage gap)', async () => {
    const repo = fixture('r8-published-handoff');
    const { ledger, worktrees, bus } = manager();
    const parentJob = ledger.addJob({ id: 'r8-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
    git(repo.path, ['update-ref', 'refs/heads/foreign-handoff', repo.head()]);
    const refs = git(repo.path, ['rev-parse', 'refs/heads/foreign-handoff']);
    for (const authority of ['job', 'review', 'writer', 'read-only'] as const) for (const mutation of ['unchanged', 'identity', 'nonce'] as const) {
      const job = ledger.addJob({ id: `r8-${authority}-${mutation}`, repo: 'assigned', title: 'handoff', baseBranch: 'main' });
      const round = ledger.addRound({ jobId: job.id, targetRef: repo.head() });
      const id = authority === 'review' ? round.id : job.id;
      let admin = '';
      const unsubscribe = bus.subscribe((event) => {
        if (event.kind !== 'worktree.created') return;
        const lane = ledger.getWorktree(id); if (lane === null) return;
        admin = git(lane.path, ['rev-parse', '--absolute-git-dir']);
        writeFileSync(join(lane.path, 'published-data'), 'retain');
        if (mutation === 'identity') {
          if (authority === 'job' || authority === 'writer') git(lane.path, ['checkout', '--detach', 'HEAD']);
          else git(lane.path, ['symbolic-ref', 'HEAD', 'refs/heads/foreign-handoff']);
        }
        if (mutation === 'nonce') writeFileSync(join(admin, 'locked'), 'foreign-handoff-nonce');
      });
      const creation = authority === 'job' ? worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })
        : authority === 'review' ? worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: repo.head() })
          : worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
      try {
        if (mutation === 'unchanged') { await creation; expect(existsSync(join(admin, 'locked'))).toBe(false); }
        else { await expect(creation).rejects.toThrow(/registered lane retained/); expect(readFileSync(join(admin, 'locked'), 'utf8')).toMatch(mutation === 'nonce' ? /foreign-handoff-nonce/ : /^gru-creation:/); }
        const lane = ledger.getWorktree(id)!; expect(lane.status).toBe('active');
        expect(readFileSync(join(lane.path, 'published-data'), 'utf8')).toBe('retain');
        expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(repo.head());
        expect(git(repo.path, ['rev-parse', 'refs/heads/foreign-handoff'])).toBe(refs);
      } finally { unsubscribe(); }
    }
  });

  it('refuses cached writer reuse of a retained failed handoff during publication and after restart (R9)', async () => {
    const evidence: { observer: boolean; restart: boolean; directive: boolean; spawns: number; prompts: number }[] = [];
    const refused = (operation: Promise<unknown>) => operation.then(() => false, (error: unknown) => String(error).includes('handoff unresolved'));
    for (const mutation of ['identity', 'nonce'] as const) {
      const repo = fixture(`r9-reuse-${mutation}`);
      const h = manager();
      const job = h.ledger.addJob({ id: `r9-${mutation}`, repo: 'assigned', title: 'retained lane', baseBranch: 'main' });
      h.ledger.setJobStatus(job.id, 'working');
      repo.git(['branch', 'foreign-handoff']);
      const prompt = vi.fn(async () => {}), dispose = vi.fn(async () => {});
      const handle = { id: `r9-worker-${mutation}`, role: 'minion' as const, sessionFile: null,
        capabilities: { streaming: true, steer: 'native' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        prompt, steer: async () => {}, followUp: async () => {}, dispose, subscribe: () => () => {},
        health: () => ({ state: 'idle' as const, lastActivity: null, sessionFile: null }) };
      const registry = { getHandle: () => null, spawn: vi.fn(async () => handle), disposeHandle: vi.fn(async () => {}) };
      let observerAttempt: Promise<unknown> | undefined, admin = '';
      const unsubscribe = h.bus.subscribe((event) => {
        if (event.kind !== 'worktree.created') return;
        const lane = h.ledger.getWorktree(job.id)!;
        admin = git(lane.path, ['rev-parse', '--absolute-git-dir']);
        writeFileSync(join(lane.path, 'foreign-data'), 'retain');
        if (mutation === 'identity') git(lane.path, ['symbolic-ref', 'HEAD', 'refs/heads/foreign-handoff']);
        else writeFileSync(join(admin, 'locked'), 'foreign nonce');
        observerAttempt = rebriefFreshMinion({ ...h, registry, jobId: job.id, note: 'observer reuse', briefing: null });
        void observerAttempt.catch(() => {});
      });
      await expect(h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })).rejects.toThrow(/registered lane retained/);
      unsubscribe();
      if (observerAttempt === undefined) throw new Error('fixture never observed registry publication');
      const observer = await refused(observerAttempt);
      const lane = h.ledger.getWorktree(job.id)!;
      expect(lane.status).toBe('active'); expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(repo.head());
      expect(readFileSync(join(lane.path, 'foreign-data'), 'utf8')).toBe('retain');
      expect(existsSync(join(admin, 'locked'))).toBe(true);
      // Fresh module instances have no prior manager/readiness cache.
      vi.resetModules();
      const { WorktreeManager: RestartedManager } = await import('../src/worktrees/manager.js');
      const { rebriefFreshMinion: restartRebrief, routeFixDirectiveToMinion: restartDirective } = await import('../src/dispatch/fix-directive.js');
      const restarted = new RestartedManager({ ledger: h.ledger, root: h.root, preserveRoot: directory(), setupTimeoutMs: 30_000, enumerateProcesses: () => [] });
      const forwarded = { ...restarted, listWorktrees: (scope?: { jobId?: string }) => restarted.listWorktrees(scope),
        getWorktree: (id: string) => restarted.getWorktree(id), createJobWorktree: restarted.createJobWorktree.bind(restarted),
        createReviewWorktree: restarted.createReviewWorktree.bind(restarted), createChildWorktree: restarted.createChildWorktree.bind(restarted),
        resolveReviewTarget: restarted.resolveReviewTarget.bind(restarted), release: restarted.release.bind(restarted) };
      const restart = await refused(restartRebrief({ ledger: h.ledger, worktrees: forwarded, registry, jobId: job.id, note: 'boot reuse', briefing: null }));
      const directive = await refused(restartDirective({ ledger: h.ledger, worktrees: forwarded, registry, jobId: job.id, directive: 'fix', signal: new AbortController().signal }));
      evidence.push({ observer, restart, directive, spawns: registry.spawn.mock.calls.length, prompts: prompt.mock.calls.length });
      expect(h.ledger.getWorktree(job.id)?.status).toBe('active');
      expect(git(repo.path, ['rev-parse', 'refs/heads/foreign-handoff'])).toBe(repo.head());
      expect(readFileSync(join(lane.path, 'foreign-data'), 'utf8')).toBe('retain');
    }
    expect(evidence).toEqual(Array.from({ length: 2 }, () => ({ observer: true, restart: true, directive: true, spawns: 0, prompts: 0 })));
  });

  it('rechecks captured handoff readiness across admission, spawn and registration with completed writer positives (R9)', async () => {
    for (const seam of ['unchanged', 'admission', 'spawn', 'registration', 'missing', 'malformed', 'non-linked', 'foreign-admin', 'generation', 'removed-git', 'orphan', 'dangling', 'cleanup-lock', 'refresh-replacement', 'receipt-symlink', 'receipt-fifo', 'receipt-oversized', 'receipt-fields', 'receipt-phase', 'receipt-types', 'receipt-duplicate'] as const) {
      const repo = fixture(`r9-ready-${seam}`), h = manager();
      const job = h.ledger.addJob({ id: `r9-${seam}`, repo: 'assigned', title: 'ready lane', baseBranch: 'main' });
      h.ledger.setJobStatus(job.id, 'working');
      const lane = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      const admin = git(lane.path, ['rev-parse', '--absolute-git-dir']), receipt = join(admin, 'gru-creation-handoff.json');
      const original = readFileSync(receipt, 'utf8');
      const prompt = vi.fn(async () => {}), dispose = vi.fn(async () => {});
      const handle = { id: `r9-worker-${seam}`, role: 'minion' as const, sessionFile: null,
        capabilities: { streaming: true, steer: 'native' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        prompt, steer: async () => {}, followUp: async () => {}, dispose, subscribe: () => () => {},
        health: () => ({ state: 'idle' as const, lastActivity: null, sessionFile: null }) };
      const mutate = () => writeFileSync(join(admin, 'locked'), 'foreign nonce');
      const registry = { getHandle: () => null, spawn: vi.fn(async () => { if (seam === 'spawn') mutate(); return handle; }), disposeHandle: vi.fn(async () => {}) };
      const unsubscribe = h.bus.subscribe((event) => { if (seam === 'registration' && event.kind === 'agent.spawned') mutate(); });
      if (seam === 'missing') rmSync(receipt);
      if (seam === 'receipt-symlink') {
        const target = join(directory(), 'copied-receipt'); writeFileSync(target, readFileSync(receipt));
        rmSync(receipt); symlinkSync(target, receipt);
      }
      if (seam === 'receipt-fifo') { rmSync(receipt); execFileSync('mkfifo', [receipt]); }
      if (seam === 'receipt-oversized') writeFileSync(receipt, ' '.repeat(64 * 1024 + 1));
      if (seam === 'receipt-fields') writeFileSync(receipt, JSON.stringify({ ...JSON.parse(readFileSync(receipt, 'utf8')), authorized: true }));
      if (seam === 'receipt-phase') writeFileSync(receipt, JSON.stringify({ ...JSON.parse(readFileSync(receipt, 'utf8')), state: 'ready', createdAt: null }));
      if (seam === 'receipt-types') writeFileSync(receipt, JSON.stringify({ ...JSON.parse(readFileSync(receipt, 'utf8')), token: 123 }));
      if (seam === 'receipt-duplicate') writeFileSync(receipt, readFileSync(receipt, 'utf8').replace('{', '{"state":"pending",'));

      if (seam === 'malformed') writeFileSync(receipt, '{bad');
      if (seam === 'generation') writeFileSync(receipt, JSON.stringify({ ...JSON.parse(original), createdAt: 'foreign generation' }));
      if (seam === 'cleanup-lock') {
        const cleanup = h.worktrees.release({ worktreeId: job.id }); void cleanup.catch(() => {});
        mutate(); await expect(cleanup).rejects.toThrow(/handoff unresolved/);
      }
      if (seam === 'orphan' || seam === 'dangling') {
        rmSync(lane.path, { recursive: true });
        if (seam === 'dangling') symlinkSync(join(directory(), 'missing'), lane.path);
        await expect(h.worktrees.release({ worktreeId: job.id })).rejects.toThrow(/handoff unresolved/);
        expect(existsSync(admin)).toBe(true);
      }
      if (seam === 'refresh-replacement') {
        git(repo.path, ['worktree', 'remove', '--force', lane.path]);
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), root = directory();
        const servicePath = process.env.PATH ?? '', marker = join(root, 'created');
        writeFileSync(join(root, 'git'), '#!/usr/bin/env node\nconst fs=require("node:fs"),cp=require("node:child_process"),a=process.argv.slice(2);\n' +
          `if(a[0]==='rev-parse'&&a[1]==='HEAD'&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'actor');cp.execFileSync(${JSON.stringify(realGit)},['worktree','add','--detach',${JSON.stringify(lane.path)},'HEAD']);fs.writeFileSync(${JSON.stringify(join(lane.path, 'replacement-data'))},'retain');}\n` +
          `const r=cp.spawnSync(${JSON.stringify(realGit)},a,{stdio:'inherit'});process.exit(r.status??1);\n`);
        chmodSync(join(root, 'git'), 0o755); vi.stubEnv('PATH', `${root}:${servicePath}`);
        try { await expect(h.worktrees.release({ worktreeId: job.id })).rejects.toThrow(/handoff unresolved/); }
        finally { vi.stubEnv('PATH', servicePath); }
        expect(readFileSync(join(lane.path, 'replacement-data'), 'utf8')).toBe('retain');
        expect(git(repo.path, ['rev-parse', `refs/heads/${lane.branch}`])).toBe(lane.sha);
      }
      if (seam === 'removed-git') rmSync(join(lane.path, '.git'));
      if (seam === 'non-linked') { rmSync(join(lane.path, '.git')); mkdirSync(join(lane.path, '.git')); }
      if (seam === 'foreign-admin') { const foreign = fixture('r9-foreign-admin'); writeFileSync(join(lane.path, '.git'), `gitdir: ${join(foreign.path, '.git')}\n`); }
      if (seam === 'unchanged') {
        writeFileSync(join(lane.path, 'advance.txt'), 'legitimate writer advance'); git(lane.path, ['add', 'advance.txt']); git(lane.path, ['commit', '-qm', 'writer advance']);
        git(repo.path, ['pack-refs', '--all']);
      }
      const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
      let holder = seam === 'admission' ? await gate.acquireWorkerTurn({ id: 'holder', label: 'holder' }) : null;
      try {
        const forwarded = new Proxy(h.worktrees, { get(target, property) {
          if (property === 'listWorktrees') return (scope?: { jobId?: string }) => target.listWorktrees(scope).map((record) => {
            const copy = { ...record }; Reflect.deleteProperty(copy, 'createdAt'); return copy;
          });
          const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
        } });
        const reuse = rebriefFreshMinion({ ...h, worktrees: seam === 'removed-git' ? forwarded : h.worktrees,
          registry, jobId: job.id, note: 'fresh reuse', briefing: null, workerGate: gate });
        void reuse.catch(() => {});
        if (holder !== null) { await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1)); mutate(); holder.release(); holder = null; }
        if (seam === 'unchanged') { await reuse; expect(registry.spawn).toHaveBeenCalledTimes(1); expect(prompt).toHaveBeenCalledTimes(1); }
        else {
          await expect(reuse).rejects.toThrow(/handoff unresolved/); expect(prompt).not.toHaveBeenCalled();
          if (seam === 'spawn' || seam === 'registration') expect(dispose).toHaveBeenCalledTimes(1);
          else expect(registry.spawn).not.toHaveBeenCalled();
        }
        expect(h.ledger.getWorktree(job.id)?.status).toBe('active');
      } finally { holder?.release(); unsubscribe(); }
    }
  });

  it('refuses successful checkout-hook custody loss before registration across all authorities with unchanged positives (R9 coverage gap)', async () => {
    const repo = fixture('r9-success-hook'), h = manager();
    const parentJob = h.ledger.addJob({ id: 'r9-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
    repo.git(['branch', 'foreign-hook']);
    for (const authority of ['job', 'review', 'writer', 'read-only'] as const) for (const mutation of ['unchanged', 'nonce', 'removed'] as const) {
      const job = h.ledger.addJob({ id: `r9-hook-${authority}-${mutation}`, repo: 'assigned', title: 'successful hook', baseBranch: 'main' });
      const round = h.ledger.addRound({ jobId: job.id, targetRef: repo.head() });
      const id = authority === 'review' ? round.id : job.id;
      const { hook, log } = failingCheckoutHook(repo);
      writeFileSync(hook, '#!/usr/bin/env node\nconst fs=require("node:fs"),cp=require("node:child_process"),p=require("node:path");\n' +
        `fs.writeFileSync(${JSON.stringify(log)},process.cwd());const admin=cp.execFileSync('git',['rev-parse','--absolute-git-dir'],{encoding:'utf8'}).trim();\n` +
        `fs.writeFileSync('foreign-hook-data','retain');${mutation === 'nonce' ? "fs.writeFileSync(p.join(admin,'locked'),'foreign hook nonce');" : mutation === 'removed' ? "fs.unlinkSync(p.join(admin,'locked'));" : ''}process.exit(0);\n`);
      let published = 0;
      const unsubscribe = h.bus.subscribe((event) => { if (event.kind === 'worktree.created') published += 1; });
      const creation = authority === 'job' ? h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })
        : authority === 'review' ? h.worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: repo.head() })
          : h.worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
      try {
        if (mutation === 'unchanged') { await creation; expect(published).toBe(1); }
        else { await expect(creation).rejects.toThrow(/custody unconfirmed/); expect(published).toBe(0); expect(h.ledger.getWorktree(id)).toBeNull(); }
        const path = readFileSync(log, 'utf8'), admin = git(path, ['rev-parse', '--absolute-git-dir']);
        expect(readFileSync(join(path, 'foreign-hook-data'), 'utf8')).toBe('retain');
        expect(existsSync(admin)).toBe(true); expect(git(repo.path, ['rev-parse', 'refs/heads/foreign-hook'])).toBe(repo.head());
        if (mutation === 'nonce') expect(readFileSync(join(admin, 'locked'), 'utf8')).toBe('foreign hook nonce');
        else expect(existsSync(join(admin, 'locked'))).toBe(false);
      } finally { unsubscribe(); }
    }
  });

  it('retains actual resident ownership on post-adapter handoff refusal for single, reserved, pair and extra permits (R9)', async () => {
    for (const path of ['single', 'reserved', 'pair', 'extra'] as const) for (const mode of ['terminal', 'false-probes', 'live', 'missing', 'throwing', 'rejected'] as const) {
      const repo = fixture(`r9-resident-${path}-${mode}`), h = manager();
      const job = h.ledger.addJob({ id: 'r9-resident', repo: 'assigned', title: 'resident fence', baseBranch: 'main' });
      const lane = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      const admin = git(lane.path, ['rev-parse', '--absolute-git-dir']);
      const config = loadConfig({ GRU_COMMAND_HOME: directory() });
      const controls: { handle: AgentHandle; cease: () => void }[] = [];
      const prompt = vi.fn(async () => {});
      const adapter: AgentRuntime = { id: 'pi', capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        health: () => ({ state: 'ok' }), dispose: async () => {}, spawn: async (role, options = {}) => {
          const target = options.cwd === lane.path;
          let ceased = false;
          const listeners = new Set<RuntimeEventListener>();
          const cease = () => { ceased = true; for (const listener of listeners) { listener({ type: 'state', state: 'disposed' }); if (ceased) listener({ type: 'cessation_evidence', evidence: 'ceased' }); }; };
          const probe = () => { if (mode === 'throwing' && target) throw new Error('probe unknown'); return target && mode !== 'terminal' && mode !== 'false-probes'; };
          const handle: AgentHandle = { id: `r9-resident-${controls.length}`, role, sessionFile: null, capabilities: adapter.capabilities, prompt,
            steer: async () => {}, followUp: async () => {}, cessationEvidence: () => (ceased ? 'ceased' as const : 'unknown' as const), subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            health: () => ({ state: ceased ? 'disposed' : 'idle', lastActivity: null, sessionFile: null }),
            ...(target && mode === 'missing' ? {} : { hasLiveProcess: probe, isCompacting: probe }),
            dispose: async () => { if (!target || mode === 'terminal') cease(); else if (mode === 'rejected') throw new Error('stop unknown'); } };
          controls.push({ handle, cease });
          // A real adapter-await boundary, before the registry can publish the resident.
          if (target) { await Promise.resolve(); writeFileSync(join(admin, 'locked'), 'foreign custody'); }
          return handle;
        } };
      class Registry extends RuntimeRegistry {
        override runtimeIdFor(): RuntimeId { return 'pi'; }
        override runtimeFor(): AgentRuntime { return adapter; }
      }
      const registry = new Registry({ config: { ...config, concurrency: { ...config.concurrency, maxWorkers: 4 } }, store: new SessionStore(directory()), closeSettleMs: 1000 });
      const unrelated = await registry.spawn('minion');
      const round = path === 'pair' || path === 'extra' ? await registry.reserveReviewRound() : null;
      if (path === 'extra') {
        await round!.spawn({ reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } });
        round!.beginChildren(2);
        await round!.spawn({});
      }
      const callerRelease = path === 'reserved' ? await registry.reserveResident() : null;
      const operation = path === 'single' ? registry.spawn('minion', { cwd: lane.path })
        : callerRelease !== null ? registry.spawnWithResident('minion', { cwd: lane.path }, callerRelease)
          : round!.spawn({ cwd: lane.path, ...(path === 'pair' ? { reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } } : {}) });
      if (callerRelease !== null) {
        callerRelease(); // caller catch/finally during the adapter await cannot free the claimed slot
        expect(registry.residencySnapshot().occupied).toBe(2);
        await expect(registry.spawnWithResident('minion', {}, callerRelease)).rejects.toThrow(/already claimed/);
      }
      await expect(operation).rejects.toThrow(/handoff unresolved/);
      callerRelease?.(); callerRelease?.(); // outer caller still holds the identical callback after rejection
      expect(prompt).not.toHaveBeenCalled();
      expect(unrelated.health().state).toBe('idle');
      const target = controls[controls.length - 1]!;
      const positive = mode === 'terminal'; // Option A (#341): explicit-false probes without adapter 'ceased' evidence remain debt
      if (round !== null) {
        if (!positive) {
          expect(round.cleanupDebt()).toContain(target.handle.id);
          if (path === 'pair') await expect(round.spawn({ cwd: lane.path, reviewLead: { systemPrompt: 'duplicate', tools: [], nativeTools: [] } })).rejects.toThrow();
          await expect(round.close()).rejects.toThrow(/capacity|debt|disposal/);
        } else await round.close();
      }
      expect(registry.residencySnapshot().occupied).toBe(positive ? 1 : (path === 'pair' ? 3 : 2));
      if (!positive) {
        expect(registry.getHandle(target.handle.id)).toBeNull(); // refused publication is never dispatchable
        expect(registry.residencySnapshot().handles).toContainEqual(expect.objectContaining({ agentId: target.handle.id }));
        target.cease();
        round?.reconcileCleanup();
        expect(round?.cleanupDebt() ?? []).toEqual([]);
        expect(registry.residencySnapshot().occupied).toBe(1);
      }
      const unused = await registry.reserveResident(); unused(); unused();
      await expect(registry.spawnWithResident('minion', {}, unused)).rejects.toThrow(/already claimed or released/);
      const noResident = await registry.reserveResident();
      await expect(registry.spawnWithResident('minion', { cwd: lane.path }, noResident)).rejects.toThrow(/handoff unresolved/);
      noResident();
      await unrelated.dispose();
      expect(registry.residencySnapshot().occupied).toBe(0);
      expect(h.ledger.getWorktree(job.id)?.status).toBe('active');
      expect(readFileSync(join(admin, 'locked'), 'utf8')).toBe('foreign custody');
    }
    for (const consumer of ['child-service', 'wave-round'] as const) for (const stop of ['unknown', 'terminal'] as const) {
      const repo = fixture(`r9-forwarding-${consumer}-${stop}`), h = manager();
      const job = h.ledger.addJob({ id: 'r9-forward', repo: 'assigned', title: 'forwarded ownership', baseBranch: 'main' });
      h.ledger.setJobStatus(job.id, 'working');
      await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      const controls: { id: string; cease: () => void }[] = [];
      const prompted = vi.fn(async () => {}), post = vi.fn();
      const config = loadConfig({ GRU_COMMAND_HOME: directory() });
      const adapter: AgentRuntime = { id: 'pi', capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        health: () => ({ state: 'ok' }), dispose: async () => {}, spawn: async (role, options = {}) => {
          let ceased = false;
          const listeners = new Set<RuntimeEventListener>();
          const id = `forwarded-${controls.length}`;
          const cease = () => { ceased = true; for (const listener of listeners) { listener({ type: 'state', state: 'disposed' }); if (ceased) listener({ type: 'cessation_evidence', evidence: 'ceased' }); }; };
          controls.push({ id, cease });
          const admin = git(options.cwd!, ['rev-parse', '--absolute-git-dir']);
          await Promise.resolve(); writeFileSync(join(admin, 'locked'), 'foreign post-adapter custody');
          return { id, role, sessionFile: null, capabilities: adapter.capabilities, prompt: prompted,
            steer: async () => {}, followUp: async () => {}, cessationEvidence: () => (ceased ? 'ceased' as const : 'unknown' as const), subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            health: () => ({ state: ceased ? 'disposed' : 'idle', lastActivity: null, sessionFile: null }),
            hasLiveProcess: () => !ceased, isCompacting: () => false,
            dispose: async () => { if (stop === 'terminal') cease(); } };
        } };
      class Registry extends RuntimeRegistry { override runtimeIdFor(): RuntimeId { return 'pi'; } override runtimeFor(): AgentRuntime { return adapter; } }
      const registry = new Registry({ config: { ...config, concurrency: { ...config.concurrency, maxWorkers: 4 } }, store: new SessionStore(directory()), closeSettleMs: 1000 });
      if (consumer === 'child-service') {
        h.ledger.registerAgent({ id: 'r9-parent', role: 'minion', jobId: job.id, parentage: 'top-level' });
        const children = new ChildWorkerService({ ledger: h.ledger, worktrees: h.worktrees,
          reserveResident: (signal) => registry.reserveResident(signal),
          // Same exact callback forwarding as main.ts:1150-1157.
          spawner: (role, options, release) => release !== undefined ? registry.spawnWithResident(role, options ?? {}, release) : registry.spawn(role, options ?? {}) });
        const child = children.request({ parentAgentId: 'r9-parent', jobId: job.id, purpose: 'separate task', task: 'do not run', authority: 'writer', idempotencyKey: 'one' });
        await vi.waitFor(() => expect(h.ledger.getChildWorker(child.record.id)?.resultState).toBe('error'));
        expect(registry.residencySnapshot().occupied).toBe(stop === 'unknown' ? 1 : 0);
        await children.dispose();
      } else {
        const implementing = h.worktrees.getWorktree(job.id)!;
        writeFileSync(join(implementing.path, 'review-change.txt'), 'review this committed change');
        git(implementing.path, ['add', 'review-change.txt']); git(implementing.path, ['commit', '-qm', 'review change']);
        h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: {} });
        const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, reviewArtifactRoot: directory(), poster: { post },
          spawner: (role, options) => registry.spawn(role, options ?? {}), reserveReviewRound: (signal) => registry.reserveReviewRound(signal) });
        const review = await wave.requestReview({ jobId: job.id, targetRef: `refs/heads/gru/${job.id}`, noSpec: true });
        await Promise.allSettled([review.run]);
        expect(registry.residencySnapshot().occupied).toBe(stop === 'unknown' ? 2 : 0);
        await wave.shutdown();
      }
      expect(controls).toHaveLength(1); expect(prompted).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
      if (stop === 'unknown') {
        expect(registry.getHandle(controls[0]!.id)).toBeNull(); // retained ownership is not publication
        expect(registry.residencySnapshot().handles).toContainEqual(expect.objectContaining({ agentId: controls[0]!.id }));
        controls[0]!.cease();
        expect(registry.residencySnapshot().occupied).toBe(0);
      }
      expect(h.worktrees.listWorktrees({ jobId: job.id }).filter((lane) => lane.kind !== 'job').every((lane) => lane.status === 'active')).toBe(true);
    }
  });

  it('rejects valid-shaped forged ready promotion without service issuance across publication restart and forwarding (contained A)', async () => {
    const observations: { observer: boolean; restart: boolean; directive: boolean; spawns: number; prompts: number }[] = [];
    for (const forged of [true, false]) {
      const repo = fixture('contained-promotion'), h = manager();
      const job = h.ledger.addJob({ id: 'contained-owner', repo: 'assigned', title: 'issued owner', briefing: 'implement the contract' });
      h.ledger.setJobStatus(job.id, 'working');
      const prompt = vi.fn(async () => {});
      const registry = { getHandle: () => null, spawn: vi.fn(async () => ({ id: `issued-${registry.spawn.mock.calls.length}`, role: 'minion' as const,
        sessionFile: null, capabilities: { streaming: true, steer: 'native' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        prompt, steer: async () => {}, followUp: async () => {}, dispose: async () => {}, subscribe: () => () => {},
        health: () => ({ state: 'idle' as const, lastActivity: null, sessionFile: null }) })), disposeHandle: async () => {} };
      const refused = (operation: Promise<unknown>) => operation.then(() => false, (error: unknown) => String(error).includes('handoff unresolved'));
      let observer: Promise<boolean> | undefined, admin = '';
      const unsubscribe = h.bus.subscribe((event) => {
        if (event.kind !== 'worktree.created') return;
        const row = h.ledger.getWorktree(job.id)!;
        admin = git(row.path, ['rev-parse', '--absolute-git-dir']);
        writeFileSync(join(row.path, 'retained-data'), 'retain');
        if (forged) {
          const file = join(admin, 'gru-creation-handoff.json');
          const pending = JSON.parse(readFileSync(file, 'utf8'));
          writeFileSync(file, JSON.stringify({ ...pending, state: 'ready', createdAt: row.createdAt }));
          rmSync(join(admin, 'locked'));
        }
        observer = refused(rebriefFreshMinion({ ...h, registry, jobId: job.id, note: 'publication reuse', briefing: null }));
      });
      const creation = h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      if (forged) await expect(creation).rejects.toThrow(/registered lane retained/); else await creation;
      unsubscribe();
      if (observer === undefined) throw new Error('publication control was not observed');
      const duringPublication = await observer;
      const row = h.ledger.getWorktree(job.id)!;
      expect(git(row.path, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/${row.branch}`);
      expect(git(row.path, ['rev-parse', 'HEAD'])).toBe(repo.head());
      vi.resetModules();
      const { WorktreeManager: FreshManager } = await import('../src/worktrees/manager.js');
      const { rebriefFreshMinion: freshRebrief, routeFixDirectiveToMinion: freshDirective } = await import('../src/dispatch/fix-directive.js');
      const reopened = new LedgerDb(h.dbPath); dbs.push(reopened);
      const ledger = new LedgerApi(reopened.handle);
      const worktrees = new FreshManager({ ledger, root: h.root, preserveRoot: directory(), setupTimeoutMs: 30_000, enumerateProcesses: () => [] });
      const forwarded = new Proxy(worktrees, { get(target, key) {
        if (key === 'listWorktrees') return (scope?: { jobId?: string }) => target.listWorktrees(scope).map((lane) => {
          const presented = { ...lane }; Reflect.deleteProperty(presented, 'createdAt'); return presented;
        });
        const value: unknown = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const restart = await refused(freshRebrief({ ledger, worktrees: forwarded, registry, jobId: job.id, note: 'reopened service ledger', briefing: null }));
      const directive = await refused(freshDirective({ ledger, worktrees: forwarded, registry, jobId: job.id, directive: 'accepted repair', signal: new AbortController().signal }));
      observations.push({ observer: duringPublication, restart, directive, spawns: registry.spawn.mock.calls.length, prompts: prompt.mock.calls.length });
      // Exercise the merged LIVE path: custody precedes exactly one physical
      // prompt, and main's observer follows its real completion, not a race.
      const sessionFile = join(directory(), 'directive-live.jsonl'); writeFileSync(sessionFile, '');
      let finish!: () => void;
      const physical = new Promise<void>((done) => { finish = done; });
      const livePrompt = vi.fn(async () => { await physical; writeFileSync(sessionFile, 'physical completion'); });
      const liveHandle: AgentHandle = { id: 'contained-live', role: 'minion', sessionFile,
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        prompt: livePrompt, steer: async () => {}, followUp: async () => {}, dispose: async () => {}, subscribe: () => () => {},
        health: () => ({ state: 'idle', lastActivity: null, sessionFile }) };
      ledger.registerAgent({ id: liveHandle.id, role: 'minion', jobId: job.id, parentage: 'top-level', sessionFile });
      const observe = vi.fn(() => readFileSync(sessionFile, 'utf8'));
      const liveRegistry = { ...registry, getHandle: (id: string) => id === liveHandle.id ? liveHandle : null };
      const routing = freshDirective({ ledger, worktrees: forwarded, registry: liveRegistry, jobId: job.id, directive: 'one physical continuation',
        signal: new AbortController().signal, observeBlindTurn: observe });
      try {
        if (forged) await expect(routing).rejects.toThrow(/handoff unresolved/);
        else {
          await vi.waitFor(() => expect(livePrompt).toHaveBeenCalledTimes(1));
          expect(observe).not.toHaveBeenCalled();
          finish();
          await expect(routing).resolves.toMatchObject({ delivered: true, outcome: 'completed', minionId: liveHandle.id });
          expect(observe).toHaveBeenCalledExactlyOnceWith(job.id, sessionFile);
          expect(observe).toHaveReturnedWith('physical completion'); // outside the observer's swallowed-error boundary
        }
        expect(livePrompt).toHaveBeenCalledTimes(forged ? 0 : 1);
        expect(observe).toHaveBeenCalledTimes(forged ? 0 : 1);
      } finally { finish(); await Promise.allSettled([routing]); }
      expect(ledger.getWorktree(job.id)?.status).toBe('active');
      expect(readFileSync(join(row.path, 'retained-data'), 'utf8')).toBe('retain');
      expect(existsSync(admin)).toBe(true); expect(existsSync(join(admin, 'locked'))).toBe(false);
    }
    expect(observations).toEqual([
      { observer: true, restart: true, directive: true, spawns: 0, prompts: 0 },
      { observer: true, restart: false, directive: false, spawns: 2, prompts: 2 },
    ]);
  });

  it('preserves genuine completed issuance across service reopen writer advance and cleanup (contained A healthy)', async () => {
    const repo = fixture('contained-genuine'), h = manager();
    const job = h.ledger.addJob({ id: 'genuine-owner', repo: 'assigned', title: 'genuine issuance' });
    const row = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    writeFileSync(join(row.path, 'advance'), 'legitimate writer advance'); git(row.path, ['add', 'advance']); git(row.path, ['commit', '-qm', 'advance']);
    git(repo.path, ['pack-refs', '--all']);
    const db = new LedgerDb(h.dbPath); dbs.push(db);
    const ledger = new LedgerApi(db.handle);
    const worktrees = new WorktreeManager({ ledger, root: h.root, preserveRoot: directory(), setupTimeoutMs: 30_000, enumerateProcesses: () => [] });
    handoffProof.capturePortLaneHandoff(worktrees, worktrees.getWorktree(job.id)!)();
    expect((await worktrees.release({ worktreeId: job.id })).status).toBe('swept');
    expect(existsSync(row.path)).toBe(false);
  });

  it('requires complete unique owner issuance and preserves committed notification-error facts without retry issuance (contained A)', async () => {
    for (const mode of ['duplicate', 'stale', 'foreign', 'incomplete', 'notification', 'substitution'] as const) {
      const repo = fixture(`contained-fact-${mode}`), h = manager();
      const job = h.ledger.addJob({ id: 'fact-owner', repo: 'assigned', title: 'completion fact' });
      const publish = h.bus.publish.bind(h.bus);
      if (mode === 'notification') vi.spyOn(h.bus, 'publish').mockImplementation((event) => {
        publish(event); if (event.kind === 'worktree.handoff-completed') throw new Error('owned notification failure after commit');
      });
      const creation = h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      if (mode === 'notification') await expect(creation).rejects.toThrow(/registered lane retained/); else await creation;
      const row = h.worktrees.getWorktree(job.id)!;
      const facts = h.ledger.listEventsAfter(0, { kinds: ['worktree.handoff-completed'], limit: 1001 });
      expect(facts).toHaveLength(1);
      const original = facts[0]!;
      if (typeof original.payload !== 'object' || original.payload === null) throw new Error('fixture completion fact lacks its binding');
      if (mode === 'duplicate') h.ledger.appendCustomEvent({ kind: original.kind, jobId: row.jobId, roundId: row.roundId, payload: original.payload });
      if (mode === 'stale' || mode === 'foreign') h.ledger.appendCustomEvent({ kind: original.kind, jobId: row.jobId, roundId: row.roundId,
        payload: { ...original.payload, [mode === 'stale' ? 'createdAt' : 'repo']: 'unrelated original authority' } });
      if (mode === 'incomplete') for (let i = 0; i < 1000; i += 1) h.ledger.appendCustomEvent({ kind: original.kind, payload: { owner: `other-${i}` } });
      if (mode === 'substitution') { git(repo.path, ['branch', 'foreign']); git(row.path, ['symbolic-ref', 'HEAD', 'refs/heads/foreign']); }
      if (mode === 'notification') {
        handoffProof.capturePortLaneHandoff(h.worktrees, row)();
        expect(h.ledger.listEventsAfter(0, { kinds: [original.kind], limit: 1001 })).toHaveLength(1);
      } else expect(() => handoffProof.capturePortLaneHandoff(h.worktrees, row)()).toThrow(/handoff unresolved/);
      expect(existsSync(row.path)).toBe(true); expect(h.ledger.getWorktree(job.id)?.status).toBe('active');
      vi.restoreAllMocks();
    }
  });

  it('retains unknown cessation on contrary late disposed across reserved pair extra and actual child forwarding (contained C)', async () => {
    for (const path of ['single', 'reserved', 'pair', 'extra', 'forwarded'] as const) for (const mode of ['live', 'missing', 'throwing', 'rejected', 'health-missing', 'health-throwing'] as const) {
      const repo = fixture('contained-contrary'), h = manager();
      const job = h.ledger.addJob({ id: 'contrary-owner', repo: 'assigned', title: 'contrary event' });
      h.ledger.setJobStatus(job.id, 'working');
      const lane = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      const admin = git(lane.path, ['rev-parse', '--absolute-git-dir']);
      const controls: { id: string; event: () => void; cease: () => void }[] = [];
      const prompted = vi.fn(async () => {});
      const adapter: AgentRuntime = { id: 'pi', capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        health: () => ({ state: 'ok' }), dispose: async () => {}, spawn: async (role, options = {}) => {
          const target = options.cwd !== undefined;
          let ceased = false;
          const listeners = new Set<RuntimeEventListener>();
          const event = () => { for (const listener of listeners) { listener({ type: 'state', state: 'disposed' }); if (ceased) listener({ type: 'cessation_evidence', evidence: 'ceased' }); }; };
          const id = `contrary-${controls.length}`;
          controls.push({ id, event, cease: () => { ceased = true; event(); } });
          const handle: AgentHandle = { id, role, sessionFile: null, capabilities: adapter.capabilities, prompt: prompted,
            steer: async () => {}, followUp: async () => {}, cessationEvidence: () => (ceased ? 'ceased' as const : 'unknown' as const), subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            health: () => {
              if (!ceased && target && mode === 'health-throwing') throw new Error('unknown health');
              const snapshot = { state: ceased ? 'disposed' as const : 'idle' as const, lastActivity: null, sessionFile: null };
              if (!ceased && target && mode === 'health-missing') Reflect.deleteProperty(snapshot, 'state');
              return snapshot;
            },
            ...(target && mode === 'missing' ? {} : { hasLiveProcess: () => { if (target && mode === 'throwing') throw new Error('unknown probe'); return !ceased; }, isCompacting: () => false }),
            dispose: async () => { if (!target) { ceased = true; event(); } else if (mode === 'rejected') throw new Error('unknown stop'); } };
          if (target) { await Promise.resolve(); writeFileSync(join(git(options.cwd!, ['rev-parse', '--absolute-git-dir']), 'locked'), 'foreign custody'); }
          return handle;
        } };
      class Registry extends RuntimeRegistry { override runtimeIdFor(): RuntimeId { return 'pi'; } override runtimeFor(): AgentRuntime { return adapter; } }
      const config = loadConfig({ GRU_COMMAND_HOME: directory() });
      const registry = new Registry({ config: { ...config, concurrency: { ...config.concurrency, maxWorkers: 4 } }, store: new SessionStore(directory()), closeSettleMs: 1000 });
      const unrelated = await registry.spawn('minion');
      const round = path === 'pair' || path === 'extra' ? await registry.reserveReviewRound() : null;
      if (path === 'extra') { round!.beginChildren(2); await round!.spawn({}); }
      if (path === 'forwarded') {
        h.ledger.registerAgent({ id: 'parent', role: 'minion', jobId: job.id, parentage: 'top-level' });
        const children = new ChildWorkerService({ ledger: h.ledger, worktrees: h.worktrees, reserveResident: (signal) => registry.reserveResident(signal),
          spawner: (role, options, release) => release !== undefined ? registry.spawnWithResident(role, options ?? {}, release) : registry.spawn(role, options ?? {}) });
        const child = children.request({ parentAgentId: 'parent', jobId: job.id, task: 'never execute', purpose: 'contrary ownership', authority: 'writer', idempotencyKey: 'one' });
        await vi.waitFor(() => expect(h.ledger.getChildWorker(child.record.id)?.resultState).toBe('error'));
        await children.dispose();
      } else {
        const release = path === 'reserved' ? await registry.reserveResident() : null;
        const operation = round !== null ? round.spawn({ cwd: lane.path }) : release !== null ? registry.spawnWithResident('minion', { cwd: lane.path }, release) : registry.spawn('minion', { cwd: lane.path });
        await expect(operation).rejects.toThrow(mode === 'health-throwing' ? /unknown health|handoff unresolved/ : /handoff unresolved/); release?.(); release?.();
      }
      const target = controls.at(-1)!;
      const occupied = registry.residencySnapshot().occupied;
      expect(occupied, `${path}:${mode} retains every acquired resident permit`).toBe(path === 'pair' ? 3 : path === 'extra' ? 4 : 2);
      target.event(); target.event();
      expect(registry.residencySnapshot().occupied).toBe(occupied);
      expect(registry.getHandle(target.id), `${path}:${mode}`).toBeNull();
      expect(registry.residencySnapshot().handles).toContainEqual(expect.objectContaining({ agentId: target.id }));
      if (round !== null) {
        expect(round.cleanupDebt()).toContain(target.id);
        await expect(round.spawn({})).rejects.toThrow(/parallelism/);
        target.cease();
        if (path === 'extra') controls[1]!.cease(); // finish the already-running pair child before reusing its slot
        const replacement = await round.spawn({});
        expect(replacement.id).not.toBe(target.id);
        await replacement.dispose();
        if (mode === 'rejected') await expect(round.close()).rejects.toThrow(/disposal/); else await round.close();
      } else { target.cease(); target.event(); }
      expect(registry.residencySnapshot().occupied).toBe(1);
      expect(prompted).not.toHaveBeenCalled(); expect(unrelated.health().state).toBe('idle');
      await unrelated.dispose(); expect(registry.residencySnapshot().occupied).toBe(0);
      expect(h.ledger.getWorktree(job.id)?.status).toBe('active'); expect(existsSync(admin)).toBe(true);
    }
  });

  it('rechecks delayed supervised publication while preserving exact disposal acknowledgement and unknown resident debt (GH270 main union)', async () => {
    for (const seam of ['healthy', 'before-publication', 'publication-listener'] as const) for (const stop of ['live', 'unknown', 'throwing', 'rejected'] as const) {
      const repo = fixture(`union-publication-${seam}`), h = manager();
      const job = h.ledger.addJob({ id: 'union-owner', repo: 'assigned', title: 'supervised publication' });
      const lane = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      const admin = git(lane.path, ['rev-parse', '--absolute-git-dir']);
      const listeners = new Set<RuntimeEventListener>();
      let ceased = false;
      const prompt = vi.fn(async () => {});
      const adapter: AgentRuntime = { id: 'pi', capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        health: () => ({ state: 'ok' }), dispose: async () => {}, spawn: async (role) => ({
          id: `union-${seam}-${stop}`, role, sessionFile: null, capabilities: adapter.capabilities, prompt,
          steer: async () => {}, followUp: async () => {}, cessationEvidence: () => (ceased ? 'ceased' as const : 'unknown' as const), dispose: async () => { if (stop === 'rejected') throw new Error('owned disposal rejected'); },
          subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
          health: () => { if (!ceased && stop === 'throwing') throw new Error('unknown health'); return { state: ceased ? 'disposed' : 'idle', lastActivity: null, sessionFile: null }; },
          ...(stop === 'unknown' ? {} : { hasLiveProcess: () => !ceased, isCompacting: () => false }),
        }) };
      class Registry extends RuntimeRegistry { override runtimeIdFor(): RuntimeId { return 'pi'; } override runtimeFor(): AgentRuntime { return adapter; } }
      const registry = new Registry({ config: loadConfig({ GRU_COMMAND_HOME: directory() }), store: new SessionStore(directory()) });
      const stages: { publish?: () => void } = {};
      const published: string[] = [];
      const forwarded: string[] = [];
      const stopTap = registry.onAgentEvent((event) => {
        if (event.phase !== 'spawned') { if (event.event?.type === 'text_delta') forwarded.push(event.event.delta); return; }
        published.push(event.agentId);
        for (const listener of listeners) listener({ type: 'text_delta', delta: 'inside publication' });
        if (seam === 'publication-listener') writeFileSync(join(admin, 'locked'), 'foreign publication custody');
      });
      const handle = await registry.spawn('minion', stageSpawnRegistration({ cwd: lane.path }, (_handle, publish) => { stages.publish = publish; }));
      expect(registry.getHandle(handle.id)).toBeNull();
      expect(published).toEqual([]); expect(registry.residencySnapshot().occupied).toBe(1);
      const publish = stages.publish;
      if (publish === undefined) throw new Error('fixture supervised owner never received its publication stage');
      for (const listener of listeners) listener({ type: 'text_delta', delta: 'buffered before publication' });
      if (seam === 'before-publication') writeFileSync(join(admin, 'locked'), 'foreign staged custody');
      if (seam === 'healthy') {
        publish(); expect(registry.getHandle(handle.id)).toBe(handle);
        await handle.prompt('authorized original lane'); expect(prompt).toHaveBeenCalledTimes(1);
      } else {
        expect(publish).toThrow(/handoff unresolved/);
        await expect(handle.prompt('never execute')).rejects.toThrow(/handoff unresolved/);
        expect(prompt).not.toHaveBeenCalled();
        expect(registry.getHandle(handle.id)).toBeNull();
        expect(publish).toThrow(/handoff unresolved/); // Supervisor retries must remain terminal.
        // A quarantine after a failed publication keeps the original refusal (#352).
        registry.quarantineHandle(handle);
        expect(publish).toThrow(/handoff unresolved/);
        expect(readFileSync(join(admin, 'locked'), 'utf8')).toMatch(/foreign/);
        rmSync(join(admin, 'locked')); // fixture actor restores bytes, not publication authority
        expect(publish).toThrow(/handoff unresolved/);
        await expect(handle.prompt('still terminal after restoration')).rejects.toThrow(/handoff unresolved/);
        expect(registry.getHandle(handle.id)).toBeNull();
      }
      for (const listener of listeners) listener({ type: 'text_delta', delta: 'after publication attempt' });
      // In the order they happened (#353): the held frame, then the one a `spawned` listener made.
      expect(forwarded).toEqual(seam === 'healthy' ? ['buffered before publication', 'inside publication', 'after publication attempt'] : []);
      expect(published).toEqual(seam === 'before-publication' ? [] : [handle.id]);
      const acknowledgements: boolean[] = [];
      const stopSettlement = observeDisposalSettlement(handle, (acknowledged) => { acknowledgements.push(acknowledged); });
      if (stop === 'rejected') await expect(handle.dispose()).rejects.toThrow(/owned disposal rejected/);
      else await handle.dispose();
      expect(acknowledgements).toEqual([stop !== 'rejected']); // acknowledgement is not cessation
      expect(registry.residencySnapshot().occupied).toBe(1);
      expect(registry.residencySnapshot().handles).toContainEqual(expect.objectContaining({ agentId: handle.id }));
      ceased = true;
      for (const listener of listeners) { listener({ type: 'state', state: 'disposed' }); if (ceased) listener({ type: 'cessation_evidence', evidence: 'ceased' }); };
      expect(registry.residencySnapshot().occupied).toBe(0);
      expect(acknowledgements).toEqual([stop !== 'rejected']);
      stopSettlement(); stopTap();
    }
  });

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
      targetSha: target, baseSha: target, body: 'assigned review\n', reviewEvent: 'COMMENT' as const,
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
      host: 'gitlab.example.test', targetSha: target, baseSha: target, body: 'assigned review\n', reviewEvent: 'COMMENT' as const,
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

  it('verifies actual relative backlinks before orphan cleanup and same-ID retry for every authority', async () => {
    const repo = fixture('assigned-relative-custody');
    repo.git(['config', 'worktree.useRelativePaths', 'true']);
    const { ledger, worktrees } = manager();
    const parentJob = ledger.addJob({ id: 'relative-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
    writeFileSync(join(parent.path, 'parent-data.txt'), 'retain parent');
    const unrelated = join(directory(), 'unrelated');
    git(repo.path, ['worktree', 'add', '--detach', unrelated, repo.head()]);
    writeFileSync(join(unrelated, 'unrelated-data.txt'), 'retain unrelated');
    const job = ledger.addJob({ id: 'relative-job', repo: 'assigned', title: 'relative custody', baseBranch: 'main' });
    const round = ledger.addRound({ jobId: job.id, targetRef: repo.head() });
    for (const authority of ['job', 'review', 'writer', 'read-only'] as const) {
      const id = authority === 'job' ? job.id : authority === 'review' ? round.id : `relative-${authority}`;
      const branch = authority === 'job' ? `gru/${job.id}` : authority === 'writer' ? `gru/${parentJob.id}-child-${id}` : null;
      const create = () => authority === 'job' ? worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })
        : authority === 'review' ? worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: repo.head() })
          : worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
      const beforeTrees = git(repo.path, ['worktree', 'list', '--porcelain']);
      const beforeRefs = git(repo.path, ['for-each-ref', '--format=%(refname) %(objectname)']);
      const { hook, log } = failingCheckoutHook(repo);
      writeFileSync(hook, '#!/usr/bin/env node\nconst fs = require("node:fs"), p = require("node:path");\n' +
        'const path = process.cwd(), gitdir = fs.readFileSync(p.join(path, ".git"), "utf8").trim().slice(8);\n' +
        'const admin = fs.realpathSync(p.resolve(path, gitdir)), backlink = fs.readFileSync(p.join(admin, "gitdir"), "utf8").trim();\n' +
        `fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ path, gitdir, admin, backlink, locked: fs.readFileSync(p.join(admin, 'locked'), 'utf8').trim() }));\n` +
        'fs.rmSync(path, {recursive:true, force:true}); process.exit(7);\n');
      await expect(create()).rejects.toThrow(/exit 7/);
      const proof = JSON.parse(readFileSync(log, 'utf8')) as { path: string; gitdir: string; admin: string; backlink: string; locked: string };
      expect(isAbsolute(proof.gitdir)).toBe(false);
      expect(isAbsolute(proof.backlink)).toBe(false);
      expect(resolve(proof.path, proof.gitdir)).toBe(proof.admin);
      expect(resolve(proof.admin, proof.backlink)).toBe(join(proof.path, '.git'));
      expect(proof.locked).toMatch(/^gru-creation:/u);
      expect(existsSync(proof.path)).toBe(false);
      expect(existsSync(proof.admin)).toBe(false);
      expect(ledger.getWorktree(id)).toBeNull();
      if (branch !== null) expect(git(repo.path, ['branch', '--list', branch])).toBe('');
      expect(git(repo.path, ['worktree', 'list', '--porcelain'])).toBe(beforeTrees);
      expect(git(repo.path, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(beforeRefs);
      expect(readFileSync(join(parent.path, 'parent-data.txt'), 'utf8')).toBe('retain parent');
      expect(readFileSync(join(unrelated, 'unrelated-data.txt'), 'utf8')).toBe('retain unrelated');
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

  function transactionProxy(repo: FixtureRepo, mode: 'stdout' | 'protocol' | 'prepare-timeout' | 'commit-stop' | 'commit-stop-once' | 'trailing', branch = 'gru/bounded-job') {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const root = directory();
    const proof = join(root, 'prepared.json');
    const term = join(root, 'term');
    const stall = join(root, 'stalled');
    const refLock = join(repo.path, '.git/refs/heads', `${branch}.lock`);
    writeFileSync(join(root, 'git'), '#!/usr/bin/env node\n' +
      'const cp = require("node:child_process"), fs = require("node:fs"); const args = process.argv.slice(2);\n' +
      `const mode = ${JSON.stringify(mode)}, proof = ${JSON.stringify(proof)}, term = ${JSON.stringify(term)}, stallFile = ${JSON.stringify(stall)};\n` +
      `if (args[0] !== 'update-ref' || !args.includes('--stdin')) { const r = cp.spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'}); process.exit(r.status ?? 1); }\n` +
      `const r = cp.spawn(${JSON.stringify(realGit)}, args, {stdio:['pipe','pipe','pipe']});\n` +
      'const stall = mode !== "prepare-timeout" && mode !== "trailing" && (mode !== "commit-stop-once" || !fs.existsSync(stallFile)); if (mode === "commit-stop-once") fs.writeFileSync(stallFile, "1");\n' +
      'r.stdin.on("error", () => {}); process.stdin.pipe(r.stdin); r.stderr.pipe(process.stderr);\n' +
      'let pending = "", exited = false, forced = false;\n' +
      'process.on("SIGTERM", () => fs.writeFileSync(term, "owned SIGTERM"));\n' +
      'const backstop = setTimeout(() => { forced = true; r.stdin.end("abort\\n"); if (exited) process.exit(0); }, 6000);\n' +
      'r.stdout.setEncoding("utf8").on("data", text => { pending += text; let n; while ((n = pending.indexOf("\\n")) !== -1) {\n' +
      ' const line = pending.slice(0,n); pending = pending.slice(n+1);\n' +
      ` if (line === 'prepare: ok') { fs.writeFileSync(proof, JSON.stringify({pid:process.pid, gitPid:r.pid, lock:fs.existsSync(${JSON.stringify(refLock)}), receipts:(() => { try { return fs.readdirSync(${JSON.stringify(join(repo.path, '.git/gru-creation'))}).filter(f => f.endsWith('.json')).length; } catch (e) { return 0; } })()}));\n` +
      '  if (mode === "prepare-timeout") continue; if (mode === "protocol") { process.stdout.write("wrong: ok\\n"); continue; }\n' +
      '  if (mode === "stdout") { process.stdout.write(Buffer.alloc(17*1024*1024, 120)); process.stdout.write("\\n"); continue; } }\n' +
      ' process.stdout.write(line+"\\n"); if (mode === "trailing" && line === "commit: ok") process.stdout.write("junk"); } });\n' +
      `r.on("close", code => { exited = true; if (mode === 'protocol') { fs.mkdirSync(${JSON.stringify(join(repo.path, '.git/refs/heads/gru'))}, {recursive:true}); fs.writeFileSync(${JSON.stringify(refLock)}, 'unrelated replacement lock'); } if (!stall || forced) { clearTimeout(backstop); process.exit(code ?? 1); }\n` +
      ' setInterval(() => {}, 1000); });\n');
    chmodSync(join(root, 'git'), 0o755);
    return { root, proof, term, realGit };
  }

  function noisyReferenceHook(repo: FixtureRepo, flood: 'create' | 'delete' | 'none') {
    const log = join(directory(), 'reference-hook.jsonl');
    const hook = join(repo.path, '.git/hooks/reference-transaction');
    writeFileSync(hook, '#!/usr/bin/env node\nconst fs = require("node:fs");\n' +
      'const input = fs.readFileSync(0,"utf8").trim().split(" "), phase = process.argv[2];\n' +
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({phase, ref:input[2], lock:fs.existsSync(${JSON.stringify(join(repo.path, '.git'))}+'/'+input[2]+'.lock'), auth:process.env.SSH_AUTH_SOCK})+'\\n');\n` +
      `if (phase === 'prepared' && input[2] === 'refs/heads/gru/bounded-job' && (${JSON.stringify(flood)} === 'create' && /^0+$/.test(input[0]) || ${JSON.stringify(flood)} === 'delete' && /^0+$/.test(input[1]))) process.stderr.write(Buffer.alloc(17*1024*1024,120));\n` +
      'else { process.stdout.write("configured hook stdout\\n"); process.stderr.write("configured hook stderr\\n"); }\n');
    chmodSync(hook, 0o755);
    return { hook, log };
  }

  it('bounds prepared transaction stderr floods without granting creation authority and keeps normal hooks and credentials', async () => {
    const repo = fixture('bounded-stderr-create');
    const { ledger, worktrees } = manager();
    ledger.addJob({ id: 'bounded-job', repo: 'assigned', title: 'bounded', baseBranch: 'main' });
    const before = foreignState(repo);
    const { hook, log } = noisyReferenceHook(repo, 'create');
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'bounded-job' })).rejects.toThrow(/stderr output exceeded 16 MiB/);
    // Git >= 2.46 also runs the hook in a 'preparing' phase first; the ref lock is only held from 'prepared'.
    const phases = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { phase: string; lock: boolean });
    expect(phases.find((entry) => entry.phase === 'prepared')).toMatchObject({ phase: 'prepared', lock: true });
    expect(foreignState(repo)).toEqual(before);
    expect(existsSync(join(repo.path, '.git/refs/heads/gru/bounded-job.lock'))).toBe(false);
    expect(ledger.getWorktree('bounded-job')).toBeNull();
    rmSync(hook);
    vi.stubEnv('SSH_AUTH_SOCK', '/fixture/bounded-auth');
    const normal = noisyReferenceHook(repo, 'none');
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'bounded-job' });
    const events = readFileSync(normal.log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(events.map((event) => event.phase)).toEqual(expect.arrayContaining(['prepared', 'committed']));
    expect(events.every((event) => event.auth === '/fixture/bounded-auth')).toBe(true);
    expect(git(lane.path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/gru/bounded-job');
    expect(ledger.getWorktree('bounded-job')?.status).toBe('active');
  });

  it('bounds destructive transaction stderr floods and retains the checkout reservation and original ref', async () => {
    const repo = fixture('bounded-stderr-delete');
    const { ledger, worktrees } = manager();
    ledger.addJob({ id: 'bounded-job', repo: 'assigned', title: 'bounded', baseBranch: 'main' });
    const { log } = failingCheckoutHook(repo);
    noisyReferenceHook(repo, 'delete');
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'bounded-job' })).rejects.toThrow(/custody unconfirmed/);
    const path = readFileSync(log, 'utf8');
    expect(existsSync(path)).toBe(true);
    expect(git(repo.path, ['rev-parse', 'refs/heads/gru/bounded-job'])).toBe(repo.head());
    expect(git(repo.path, ['worktree', 'list', '--porcelain'])).toContain('locked gru-creation:');
    expect(existsSync(join(repo.path, '.git/refs/heads/gru/bounded-job.lock'))).toBe(false);
    expect(ledger.getWorktree('bounded-job')).toBeNull();
  });

  it('bounds stdout and malformed transaction replies, terminates only its owned child and preserves unrelated locks', async () => {
    const servicePath = process.env.PATH ?? '';
    for (const mode of ['stdout', 'protocol'] as const) {
      const repo = fixture(`bounded-protocol-${mode}`);
      const { ledger, worktrees } = manager();
      ledger.addJob({ id: 'bounded-job', repo: 'assigned', title: 'bounded', baseBranch: 'main' });
      // No pre-seeded symbolic alias here: Git >= 2.5x refuses `create` over a dangling symref at prepare,
      // before any confirmation could be bounded. Alias preservation has its own atomic-refusal tests.
      git(repo.path, ['update-ref', 'refs/heads/unrelated', repo.head()]);
      const proxy = transactionProxy(repo, mode);
      const unrelated = spawn(proxy.realGit, ['update-ref', '--stdin', '--no-deref'], {
        cwd: repo.path, env: repositoryGitEnv(false), stdio: ['pipe', 'pipe', 'pipe'],
      });
      let replies = '';
      unrelated.stdout.setEncoding('utf8').on('data', (text: string) => { replies += text; });
      const stopped = new Promise<void>((done) => unrelated.on('close', () => done()));
      unrelated.stdin.write(`start\nverify refs/heads/unrelated ${repo.head()}\nprepare\n`);
      try {
        await vi.waitFor(() => expect(replies).toContain('prepare: ok'));
        vi.stubEnv('PATH', `${proxy.root}:${servicePath}`);
        await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'bounded-job' })).rejects.toThrow(
          mode === 'stdout' ? /stdout confirmation exceeded 64 bytes/ : /invalid prepare confirmation/,
        );
        const proof = JSON.parse(readFileSync(proxy.proof, 'utf8'));
        expect(proof.lock).toBe(true);
        // The owned child receives SIGTERM asynchronously after the rejection: await the real signal and exit.
        await vi.waitFor(() => expect(readFileSync(proxy.term, 'utf8')).toBe('owned SIGTERM'));
        await vi.waitFor(() => expect(() => process.kill(proof.pid, 0)).toThrow());
        expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
        expect(existsSync(join(repo.path, '.git/refs/heads/unrelated.lock'))).toBe(true);
        const refLock = join(repo.path, '.git/refs/heads/gru/bounded-job.lock');
        expect(existsSync(refLock)).toBe(mode === 'protocol');
        if (mode === 'protocol') expect(readFileSync(refLock, 'utf8')).toBe('unrelated replacement lock');
        expect(ledger.getWorktree('bounded-job')).toBeNull();
      } finally {
        vi.stubEnv('PATH', servicePath);
        unrelated.stdin.end('abort\n');
        await stopped;
      }
    }
  });

  it('times out a missing prepared confirmation and aborts the owned locked transaction without committing', async () => {
    const repo = fixture('bounded-confirmation-timeout');
    const { ledger, worktrees } = manager();
    ledger.addJob({ id: 'bounded-job', repo: 'assigned', title: 'bounded', baseBranch: 'main' });
    const before = foreignState(repo);
    const proxy = transactionProxy(repo, 'prepare-timeout');
    vi.stubEnv('PATH', `${proxy.root}:${process.env.PATH ?? ''}`);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const request = worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'bounded-job' });
    const refusal = expect(request).rejects.toThrow(/prepare confirmation timed out after 30000ms/);
    await vi.waitFor(() => expect(existsSync(proxy.proof)).toBe(true));
    expect(JSON.parse(readFileSync(proxy.proof, 'utf8')).lock).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    await refusal;
    vi.useRealTimers();
    expect(foreignState(repo)).toEqual(before);
    expect(existsSync(join(repo.path, '.git/refs/heads/gru/bounded-job.lock'))).toBe(false);
    expect(ledger.getWorktree('bounded-job')).toBeNull();
  });

  it('refuses authority when confirmed commit output never settles or has trailing protocol bytes and retains the ref', async () => {
    const servicePath = process.env.PATH ?? '';
    for (const mode of ['commit-stop', 'trailing'] as const) {
      const repo = fixture(`bounded-commit-stop-${mode}`);
      const { ledger, worktrees } = manager();
      ledger.addJob({ id: 'bounded-job', repo: 'assigned', title: 'bounded', baseBranch: 'main' });
      const proxy = transactionProxy(repo, mode);
      vi.stubEnv('PATH', `${proxy.root}:${process.env.PATH ?? ''}`);
      await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'bounded-job' })).rejects.toThrow(mode === 'commit-stop' ? /did not close within 1000ms/ : /unterminated confirmation/);
      const proof = JSON.parse(readFileSync(proxy.proof, 'utf8'));
      if (mode === 'commit-stop') expect(readFileSync(proxy.term, 'utf8')).toBe('owned SIGTERM');
      expect(() => process.kill(proof.pid, 0)).toThrow();
      expect(git(repo.path, ['rev-parse', 'refs/heads/gru/bounded-job'])).toBe(repo.head());
      expect(existsSync(join(repo.path, '.git/refs/heads/gru/bounded-job.lock'))).toBe(false);
      expect(ledger.getWorktree('bounded-job')).toBeNull();
      expect(git(repo.path, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
      vi.stubEnv('PATH', servicePath);
    }
  });

  it('records durable custody before the ref transaction it authorizes (#453)', async () => {
    const repo = fixture('issue-453-before-ref');
    const { ledger, worktrees } = manager();
    ledger.addJob({ id: 'before-ref-job', repo: 'assigned', title: 'before ref', baseBranch: 'main' });
    const proxy = transactionProxy(repo, 'commit-stop', 'gru/before-ref-job');
    vi.stubEnv('PATH', `${proxy.root}:${process.env.PATH ?? ''}`);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'before-ref-job' })).rejects.toThrow(/did not close within 1000ms/);
    vi.stubEnv('PATH', process.env.PATH ?? '');
    assertOwnedChildDead(proxy);
    // At `prepare: ok` the branch still did not exist: the receipt was already on disk.
    expect(JSON.parse(readFileSync(proxy.proof, 'utf8')).receipts).toBe(1);
  });

  it('adopts an interrupted branch creation from its own receipt, never creating it twice (#453)', async () => {
    const repo = fixture('issue-453-adopt');
    const { ledger, worktrees, root } = manager();
    ledger.addJob({ id: 'resume-job', repo: 'assigned', title: 'resume', baseBranch: 'main' });
    const branch = 'gru/resume-job';
    const proxy = transactionProxy(repo, 'commit-stop-once', branch);
    const servicePath = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${proxy.root}:${servicePath}`);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'resume-job' })).rejects.toThrow(/did not close within 1000ms/);
    // The interrupted state: the ref exists at the fixed base, nothing else.
    const base = git(repo.path, ['rev-parse', branch]);
    const lanePath = join(root, realpathSync(repo.path).split('/').pop()!, 'job-resume-job');
    expect(existsSync(lanePath)).toBe(false);
    expect(ledger.getWorktree('resume-job')).toBeNull();
    assertOwnedChildDead(proxy);
    expect(receiptFiles(repo)).toHaveLength(1);
    // The retry finishes that same transaction instead of authoring a new one.
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'resume-job' });
    vi.stubEnv('PATH', servicePath);
    expect(lane.branch).toBe(branch);
    expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(base);
    expect(git(repo.path, ['reflog', 'show', '--format=%H', `refs/heads/${branch}`]).split('\n').filter(Boolean)).toHaveLength(1);
    expect(ledger.getWorktree('resume-job')?.status).toBe('active');
    expect(receiptFiles(repo)).toHaveLength(0);
  });

  it('refuses a retained creation whose ref moved, and keeps the foreign ref (#453)', async () => {
    const repo = fixture('issue-453-changed-ref');
    const { ledger, worktrees } = manager();
    ledger.addJob({ id: 'moved-job', repo: 'assigned', title: 'moved', baseBranch: 'main' });
    const branch = 'gru/moved-job';
    const proxy = transactionProxy(repo, 'commit-stop-once', branch);
    const servicePath = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${proxy.root}:${servicePath}`);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'moved-job' })).rejects.toThrow(/did not close within 1000ms/);
    vi.stubEnv('PATH', servicePath);
    assertOwnedChildDead(proxy);
    // A later actor moves the retained branch: it is no longer our transaction.
    writeFileSync(join(repo.path, 'moved.txt'), 'foreign\n');
    git(repo.path, ['add', 'moved.txt']);
    git(repo.path, ['commit', '-qm', 'foreign move']);
    const moved = git(repo.path, ['rev-parse', 'HEAD']);
    git(repo.path, ['update-ref', `refs/heads/${branch}`, moved]);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'moved-job' })).rejects.toThrow(/retained creation receipt for branch .* names base/);
    expect(git(repo.path, ['rev-parse', branch])).toBe(moved);
    expect(ledger.getWorktree('moved-job')).toBeNull();
  });

  it('refuses a retained creation whose path holds a checkout it does not own (#453)', async () => {
    const repo = fixture('issue-453-foreign-path');
    const { ledger, worktrees, root } = manager();
    ledger.addJob({ id: 'held-job', repo: 'assigned', title: 'held', baseBranch: 'main' });
    const branch = 'gru/held-job';
    const proxy = transactionProxy(repo, 'commit-stop-once', branch);
    const servicePath = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${proxy.root}:${servicePath}`);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'held-job' })).rejects.toThrow(/did not close within 1000ms/);
    vi.stubEnv('PATH', servicePath);
    assertOwnedChildDead(proxy);
    const lanePath = join(root, realpathSync(repo.path).split('/').pop()!, 'job-held-job');
    mkdirSync(lanePath, { recursive: true });
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'held-job' })).rejects.toThrow(/checkout at .* that this receipt does not own/);
    expect(git(repo.path, ['rev-parse', branch])).toBe(git(repo.path, ['rev-parse', 'main']));
    expect(ledger.getWorktree('held-job')).toBeNull();
  });

  it('closes a receipt whose transaction never committed and creates the lane fresh (#453)', async () => {
    const repo = fixture('issue-453-spent');
    const { ledger, worktrees } = manager();
    ledger.addJob({ id: 'spent-job', repo: 'assigned', title: 'spent', baseBranch: 'main' });
    const branch = 'gru/spent-job';
    const proxy = transactionProxy(repo, 'commit-stop-once', branch);
    const servicePath = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${proxy.root}:${servicePath}`);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'spent-job' })).rejects.toThrow(/did not close within 1000ms/);
    vi.stubEnv('PATH', servicePath);
    assertOwnedChildDead(proxy);
    // The transaction left no ref behind: the receipt protects nothing.
    git(repo.path, ['update-ref', '-d', `refs/heads/${branch}`]);
    expect(receiptFiles(repo)).toHaveLength(1);
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'spent-job' });
    expect(lane.branch).toBe(branch);
    expect(ledger.getWorktree('spent-job')?.status).toBe('active');
    expect(receiptFiles(repo)).toHaveLength(0);
  });

  it('adopts at the recorded base even after the repository head moved (#453)', async () => {
    const repo = fixture('issue-453-moved-base');
    const { ledger, worktrees } = manager();
    ledger.addJob({ id: 'rebased-job', repo: 'assigned', title: 'rebased', baseBranch: 'main' });
    const branch = 'gru/rebased-job';
    const proxy = transactionProxy(repo, 'commit-stop-once', branch);
    const servicePath = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${proxy.root}:${servicePath}`);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'rebased-job' })).rejects.toThrow(/did not close within 1000ms/);
    vi.stubEnv('PATH', servicePath);
    assertOwnedChildDead(proxy);
    const recorded = git(repo.path, ['rev-parse', branch]);
    writeFileSync(join(repo.path, 'after.txt'), 'later work\n');
    git(repo.path, ['add', 'after.txt']);
    git(repo.path, ['commit', '-qm', 'later work']);
    const moved = git(repo.path, ['rev-parse', 'HEAD']);
    expect(moved).not.toBe(recorded);
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'rebased-job' });
    // The interrupted creation keeps ITS base: reconciliation never re-bases.
    expect(lane.sha).toBe(recorded);
    expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(recorded);
  });

  it('adopts an interrupted WRITER child creation from its own receipt (#453)', async () => {
    const repo = fixture('issue-453-child');
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'child-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const branch = `gru/${job.id}-child-kid`;
    const proxy = transactionProxy(repo, 'commit-stop-once', branch);
    const servicePath = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${proxy.root}:${servicePath}`);
    const child = () => worktrees.createChildWorktree({ repoPath: repo.path, jobId: job.id, childId: 'kid', parentPath: parent.path, authority: 'writer' });
    await expect(child()).rejects.toThrow(/did not close within 1000ms/);
    vi.stubEnv('PATH', servicePath);
    assertOwnedChildDead(proxy);
    const parentHead = git(parent.path, ['rev-parse', 'HEAD']);
    const lane = await child();
    expect(lane.branch).toBe(branch);
    expect(lane.sha).toBe(parentHead);
    expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(parentHead);
    expect(ledger.getWorktree('kid')?.kind).toBe('child');
    expect(receiptFiles(repo)).toHaveLength(0);
  });

  it('refuses every retained creation it cannot attribute, keeping the resources (#453)', async () => {
    type Case = { readonly name: string; readonly tamper: (repo: FixtureRepo, branch: string, base: string, scratch: string) => void; readonly error: RegExp };
    const cases: readonly Case[] = [
      { name: 'unsettled-lock', error: /has an unsettled ref transaction/,
        tamper: (repo, branch) => writeFileSync(join(commonDir(repo), 'refs/heads', `${branch}.lock`), '') },
      { name: 'foreign-lane', error: /belongs to another lane/,
        tamper: (repo) => {
          const file = join(commonDir(repo), 'gru-creation', receiptFiles(repo)[0]!);
          const receipt = JSON.parse(readFileSync(file, 'utf8')) as { lane: { id: string; jobId: string } };
          receipt.lane.id = 'some-other-lane';
          receipt.lane.jobId = 'some-other-lane';
          writeFileSync(file, JSON.stringify(receipt));
        } },
      { name: 'dropped-reflog-token', error: /no longer carries its own creation reflog entry/,
        tamper: (repo, branch, base) => {
          // A same-value update writes no reflog entry: move the ref away and
          // back so the top entry is genuinely someone else's.
          writeFileSync(join(repo.path, 'foreign.txt'), 'foreign\n');
          git(repo.path, ['add', 'foreign.txt']);
          git(repo.path, ['commit', '-qm', 'foreign commit']);
          git(repo.path, ['update-ref', '-m', 'someone else', `refs/heads/${branch}`, git(repo.path, ['rev-parse', 'HEAD'])]);
          git(repo.path, ['update-ref', '-m', 'someone else', `refs/heads/${branch}`, base]);
        } },
      { name: 'foreign-holder', error: /is held by a worktree that this receipt does not own/,
        tamper: (repo, branch, _base, scratch) => { git(repo.path, ['worktree', 'add', '--quiet', join(scratch, 'holder'), branch]); } },
    ];
    for (const entry of cases) {
      const repo = fixture(`issue-453-refuse-${entry.name}`);
      const { ledger, worktrees } = manager();
      ledger.addJob({ id: 'refused-job', repo: 'assigned', title: 'refused', baseBranch: 'main' });
      const branch = 'gru/refused-job';
      const proxy = transactionProxy(repo, 'commit-stop-once', branch);
      const servicePath = process.env.PATH ?? '';
      vi.stubEnv('PATH', `${proxy.root}:${servicePath}`);
      await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'refused-job' }), entry.name).rejects.toThrow(/did not close within 1000ms/);
      vi.stubEnv('PATH', servicePath);
      assertOwnedChildDead(proxy);
      const base = git(repo.path, ['rev-parse', branch]);
      entry.tamper(repo, branch, base, directory());
      await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'refused-job' }), entry.name).rejects.toThrow(entry.error);
      // Resources retained: the branch is exactly where it was, no lane row.
      expect(git(repo.path, ['rev-parse', branch]), entry.name).toBe(base);
      expect(ledger.getWorktree('refused-job'), entry.name).toBeNull();
      expect(receiptFiles(repo), entry.name).toHaveLength(1);
      vi.stubEnv('PATH', servicePath);
    }
  });

  it('closes a receipt that protects nothing when the lane root moved, and creates at the new root (#453)', async () => {
    const repo = fixture('issue-453-moved-root');
    const { ledger, worktrees } = manager();
    ledger.addJob({ id: 'moved-root-job', repo: 'assigned', title: 'moved root', baseBranch: 'main' });
    const branch = 'gru/moved-root-job';
    const proxy = transactionProxy(repo, 'commit-stop-once', branch);
    const servicePath = process.env.PATH ?? '';
    vi.stubEnv('PATH', `${proxy.root}:${servicePath}`);
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'moved-root-job' })).rejects.toThrow(/did not close within 1000ms/);
    vi.stubEnv('PATH', servicePath);
    assertOwnedChildDead(proxy);
    // Nothing survives the interrupted attempt except its receipt.
    git(repo.path, ['update-ref', '-d', `refs/heads/${branch}`]);
    expect(receiptFiles(repo)).toHaveLength(1);
    // A different configured root: the receipt's recorded path no longer exists.
    const movedRoot = directory();
    const moved = new WorktreeManager({ ledger, root: movedRoot, preserveRoot: directory(), setupTimeoutMs: 30_000, enumerateProcesses: () => [] });
    const lane = await moved.createJobWorktree({ repoPath: repo.path, jobId: 'moved-root-job' });
    expect(lane.path).toBe(join(movedRoot, realpathSync(repo.path).split('/').pop()!, 'job-moved-root-job'));
    expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(lane.sha);
    expect(ledger.getWorktree('moved-root-job')?.status).toBe('active');
    // The spent receipt was closed, not carried into the new root.
    expect(receiptFiles(repo)).toHaveLength(0);
  });

  it('names a torn, foreign or duplicated worktree administration that claims the lane path (#453)', async () => {
    const plant = (repo: FixtureRepo, lanePath: string, name: string, locked: string, head: boolean): void => {
      const admin = join(commonDir(repo), 'worktrees', name);
      mkdirSync(admin, { recursive: true });
      writeFileSync(join(admin, 'gitdir'), `${join(lanePath, '.git')}\n`);
      if (head) writeFileSync(join(admin, 'HEAD'), 'ref: refs/heads/gru/administration-job\n');
      writeFileSync(join(admin, 'commondir'), '../..\n');
      writeFileSync(join(admin, 'locked'), `${locked}\n`);
    };
    type Case = { readonly name: string; readonly plant: (repo: FixtureRepo, lanePath: string) => void; readonly error: RegExp };
    const cases: readonly Case[] = [
      { name: 'foreign-token', error: /but is locked for another creation/,
        plant: (repo, lanePath) => plant(repo, lanePath, 'foreign-claim', `gru-creation:${randomUUID()}`, true) },
      { name: 'torn-metadata', error: /belongs to .* but ENOENT|belongs to .* but .*no such file/,
        plant: (repo, lanePath) => plant(repo, lanePath, 'torn-claim', 'gru-creation:unused', false) },
      { name: 'duplicate-claims', error: /several worktree administrations claim/,
        plant: (repo, lanePath) => {
          plant(repo, lanePath, 'first-claim', `gru-creation:${randomUUID()}`, true);
          plant(repo, lanePath, 'second-claim', `gru-creation:${randomUUID()}`, true);
        } },
    ];
    for (const entry of cases) {
      const repo = fixture(`issue-453-administration-${entry.name}`);
      const { ledger, worktrees, root } = manager();
      ledger.addJob({ id: 'administration-job', repo: 'assigned', title: 'administration', baseBranch: 'main' });
      const branch = 'gru/administration-job';
      const proxy = transactionProxy(repo, 'commit-stop-once', branch);
      const servicePath = process.env.PATH ?? '';
      vi.stubEnv('PATH', `${proxy.root}:${servicePath}`);
      await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'administration-job' }), entry.name).rejects.toThrow(/did not close within 1000ms/);
      vi.stubEnv('PATH', servicePath);
      assertOwnedChildDead(proxy);
      const lanePath = join(root, realpathSync(repo.path).split('/').pop()!, 'job-administration-job');
      entry.plant(repo, lanePath);
      await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'administration-job' }), entry.name)
        .rejects.toThrow(/lane administration .* belongs to|several worktree administrations claim/);
      expect(git(repo.path, ['rev-parse', branch]), entry.name).toBe(git(repo.path, ['rev-parse', 'main']));
      expect(receiptFiles(repo), entry.name).toHaveLength(1);
      vi.stubEnv('PATH', servicePath);
    }
  });

  it('refuses a retained receipt that names a lane the ledger already registered (#453)', async () => {
    const repo = fixture('issue-453-registered');
    const { ledger, worktrees } = manager();
    ledger.addJob({ id: 'registered-job', repo: 'assigned', title: 'registered', baseBranch: 'main' });
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'registered-job' });
    // A crash between publication and receipt cleanup leaves both behind.
    writeCreationIntent(commonDir(repo), { lane: { id: 'registered-job', kind: 'job', jobId: 'registered-job', roundId: null, path: lane.path },
      repoPath: realpathSync(repo.path), branch: 'gru/registered-job', sha: lane.sha, baseSource: lane.baseSource, token: `gru-creation:${randomUUID()}` });
    await expect(worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'registered-job' }))
      .rejects.toThrow(/names a lane the ledger already holds as active/);
    // Publication still owns the lane and everything it points at.
    expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(lane.sha);
    expect(ledger.getWorktree('registered-job')?.status).toBe('active');
  });

  async function assertSymbolicBranchCollision(authority: 'job' | 'writer', timing: 'existing' | 'concurrent'): Promise<void> {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const servicePath = process.env.PATH ?? '';
    for (const occupiedReferent of [false, true]) {
      const repo = fixture(`assigned-symbolic-${authority}-${timing}-${occupiedReferent}`);
      const { ledger, worktrees } = manager();
      const parentJob = ledger.addJob({ id: 'alias-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
      const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
      const job = ledger.addJob({ id: 'alias-job', repo: 'assigned', title: 'collision', baseBranch: 'main' });
      const id = authority === 'job' ? job.id : 'alias-child';
      const branch = authority === 'job' ? `gru/${id}` : `gru/${parentJob.id}-child-${id}`;
      const ref = `refs/heads/${branch}`, foreignRef = 'refs/heads/foreign-owned';
      if (occupiedReferent) git(repo.path, ['update-ref', foreignRef, repo.head()]);
      writeFileSync(join(parent.path, 'parent-data.txt'), 'preserve');
      const stableState = () => {
        const state = foreignState(repo) as { readonly refs: string };
        return { ...state, refs: state.refs.split('\n').filter((line) => !line.startsWith(`${ref} `)).join('\n') };
      };
      const before = stableState();
      const wrapperRoot = directory();
      const marker = join(wrapperRoot, 'alias-installed');
      if (timing === 'existing') git(repo.path, ['symbolic-ref', ref, foreignRef]);
      else {
        writeFileSync(join(wrapperRoot, 'git'), '#!/usr/bin/env node\nconst fs = require("node:fs"), cp = require("node:child_process"); const args = process.argv.slice(2);\n' +
          `if (args[0] === 'update-ref' && !fs.existsSync(${JSON.stringify(marker)})) { cp.execFileSync(${JSON.stringify(realGit)}, ['symbolic-ref', ${JSON.stringify(ref)}, ${JSON.stringify(foreignRef)}]); fs.writeFileSync(${JSON.stringify(marker)}, 'installed'); }\n` +
          `const r = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`);
        chmodSync(join(wrapperRoot, 'git'), 0o755);
        vi.stubEnv('PATH', `${wrapperRoot}:${servicePath}`);
      }
      const create = () => authority === 'job' ? worktrees.createJobWorktree({ repoPath: repo.path, jobId: id })
        : worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
      await expect(create()).rejects.toThrow();
      expect(git(repo.path, ['symbolic-ref', '--no-recurse', ref])).toBe(foreignRef);
      if (occupiedReferent) expect(git(repo.path, ['rev-parse', foreignRef])).toBe(repo.head());
      else expect(git(repo.path, ['branch', '--list', 'foreign-owned'])).toBe('');
      expect(stableState()).toEqual(before);
      expect(existsSync(join(repo.path, '.git', `${ref}.lock`))).toBe(false);
      expect(ledger.getWorktree(id)).toBeNull();
      expect(readFileSync(join(parent.path, 'parent-data.txt'), 'utf8')).toBe('preserve');
      vi.stubEnv('PATH', servicePath);
      git(repo.path, ['symbolic-ref', '--delete', ref]);
      const lane = await create();
      expect(lane.branch).toBe(branch);
      expect(git(lane.path, ['symbolic-ref', 'HEAD'])).toBe(ref);
    }
  }

  it('atomically refuses an existing foreign symbolic job branch without changing its referent', async () => {
    await assertSymbolicBranchCollision('job', 'existing');
  });

  it('atomically refuses a concurrent foreign symbolic job branch without changing its referent', async () => {
    await assertSymbolicBranchCollision('job', 'concurrent');
  });

  it('atomically refuses an existing foreign symbolic writer-child branch without changing its referent', async () => {
    await assertSymbolicBranchCollision('writer', 'existing');
  });

  it('atomically refuses a concurrent foreign symbolic writer-child branch without changing its referent', async () => {
    await assertSymbolicBranchCollision('writer', 'concurrent');
  });

  it('never follows a replacement symbolic alias during destructive job or writer-child rollback', async () => {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const servicePath = process.env.PATH ?? '';
    for (const authority of ['job', 'writer'] as const) {
      const repo = fixture(`assigned-symbolic-rollback-${authority}`);
      const { ledger, worktrees } = manager();
      const parentJob = ledger.addJob({ id: 'rollback-alias-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
      const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
      const job = ledger.addJob({ id: 'rollback-alias-job', repo: 'assigned', title: 'rollback', baseBranch: 'main' });
      const id = authority === 'job' ? job.id : 'rollback-alias-child';
      const ref = authority === 'job' ? `refs/heads/gru/${id}` : `refs/heads/gru/${parentJob.id}-child-${id}`;
      const foreignRef = 'refs/heads/foreign-rollback';
      git(repo.path, ['update-ref', foreignRef, repo.head()]);
      const { log } = failingCheckoutHook(repo);
      const wrapperRoot = directory();
      const counter = join(wrapperRoot, 'updates');
      writeFileSync(join(wrapperRoot, 'git'), '#!/usr/bin/env node\nconst fs = require("node:fs"), cp = require("node:child_process"); const args = process.argv.slice(2);\n' +
        `if (args[0] === 'update-ref') { const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1 : 1; fs.writeFileSync(${JSON.stringify(counter)}, String(n));\n` +
        ` if (n === 2) cp.execFileSync(${JSON.stringify(realGit)}, ['symbolic-ref', ${JSON.stringify(ref)}, ${JSON.stringify(foreignRef)}]); }\n` +
        `const r = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1);\n`);
      chmodSync(join(wrapperRoot, 'git'), 0o755);
      vi.stubEnv('PATH', `${wrapperRoot}:${servicePath}`);
      const create = authority === 'job' ? worktrees.createJobWorktree({ repoPath: repo.path, jobId: id })
        : worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
      await expect(create).rejects.toThrow(/custody unconfirmed/);
      expect(git(repo.path, ['symbolic-ref', '--no-recurse', ref])).toBe(foreignRef);
      expect(git(repo.path, ['rev-parse', foreignRef])).toBe(repo.head());
      expect(existsSync(readFileSync(log, 'utf8'))).toBe(true);
      expect(ledger.getWorktree(id)).toBeNull();
      vi.stubEnv('PATH', servicePath);
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

  it('refuses same-SHA branch attachment of detached creation authorities without deleting foreign branches', async () => {
    const repo = fixture('assigned-detached-attachment');
    const { ledger, worktrees } = manager();
    const job = ledger.addJob({ id: 'attach-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const round = ledger.addRound({ jobId: job.id, targetRef: repo.head() });
    const before = git(repo.path, ['for-each-ref', '--format=%(refname) %(objectname)']);
    for (const authority of ['review', 'read-only'] as const) {
      const { hook, log } = failingCheckoutHook(repo);
      writeFileSync(hook, '#!/usr/bin/env node\nconst fs = require("node:fs"), cp = require("node:child_process");\n' +
        `fs.writeFileSync(${JSON.stringify(log)}, process.cwd()); cp.execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main']);\n`);
      const create = () => authority === 'review' ? worktrees.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: repo.head() })
        : worktrees.createChildWorktree({ repoPath: repo.path, jobId: job.id, childId: 'attach-reader', parentPath: parent.path, authority });
      await expect(create()).rejects.toThrow(/target changed/);
      expect(ledger.getWorktree(authority === 'review' ? round.id : 'attach-reader')).toBeNull();
      expect(existsSync(readFileSync(log, 'utf8'))).toBe(false);
      expect(git(repo.path, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(before);
      rmSync(hook);
      const lane = await create();
      expect(git(lane.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    }
  });

  it('refuses bootstrap retargeting before registration and retains unknown branch custody and data', async () => {
    const repo = fixture('assigned-bootstrap-retarget');
    const { ledger, worktrees, root } = manager();
    const job = ledger.addJob({ id: 'bootstrap-retarget', repo: 'assigned', title: 'retarget', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    commitLaneManifest(repo, parent.path, `[[setup]]\ncommand = 'git symbolic-ref HEAD refs/heads/main; printf retain > .setup-data'\n`);
    const before = git(repo.path, ['rev-parse', 'refs/heads/main']);
    const other = ledger.addJob({ id: 'bootstrap-new-job', repo: 'assigned', title: 'new', baseBranch: 'main' });
    for (const authority of ['job', 'writer'] as const) {
      const id = authority === 'job' ? other.id : 'bootstrap-retarget-child';
      const create = authority === 'job' ? worktrees.createJobWorktree({ repoPath: repo.path, jobId: id })
        : worktrees.createChildWorktree({ repoPath: repo.path, jobId: job.id, childId: id, parentPath: parent.path, authority });
      await expect(create).rejects.toThrow(/target changed.*custody unconfirmed/s);
      expect(ledger.getWorktree(id)).toBeNull();
      const path = join(root, repo.path.split('/').at(-1)!, `${authority === 'job' ? 'job' : 'child'}-${id}`);
      expect(readFileSync(join(path, '.setup-data'), 'utf8')).toBe('retain');
      expect(git(path, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
      expect(git(repo.path, ['rev-parse', 'refs/heads/main'])).toBe(before);
      const branch = authority === 'job' ? `gru/${id}` : `gru/${job.id}-child-${id}`;
      expect(git(repo.path, ['rev-parse', `refs/heads/${branch}`])).toBe(before);
    }
  });

  it('cleans owned orphaned job and writer-child registrations and retries with no branch debris', async () => {
    const repo = fixture('assigned-orphan-writers');
    const { ledger, worktrees } = manager();
    const parentJob = ledger.addJob({ id: 'orphan-writer-parent', repo: 'assigned', title: 'parent', baseBranch: 'main' });
    const parent = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: parentJob.id });
    const job = ledger.addJob({ id: 'orphan-job', repo: 'assigned', title: 'orphan', baseBranch: 'main' });
    for (const authority of ['job', 'writer'] as const) {
      const { hook } = failingCheckoutHook(repo);
      writeFileSync(hook, '#!/usr/bin/env node\nrequire("node:fs").rmSync(process.cwd(), {recursive:true, force:true}); process.exit(7);\n');
      const id = authority === 'job' ? job.id : 'orphan-writer-child';
      const branch = authority === 'job' ? `gru/${id}` : `gru/${parentJob.id}-child-${id}`;
      const create = () => authority === 'job' ? worktrees.createJobWorktree({ repoPath: repo.path, jobId: id })
        : worktrees.createChildWorktree({ repoPath: repo.path, jobId: parentJob.id, childId: id, parentPath: parent.path, authority });
      await expect(create()).rejects.toThrow(/exit 7/);
      expect(ledger.getWorktree(id)).toBeNull();
      expect(git(repo.path, ['branch', '--list', branch])).toBe('');
      expect(git(repo.path, ['worktree', 'list', '--porcelain'])).not.toContain('locked');
      rmSync(hook);
      expect((await create()).branch).toBe(branch);
    }
  });

  it('fences a late tag-shadowed canonical local owner at both idle checks', async () => {
    for (const seam of ['preflight', 'preflight-freeze', 'preflight-probe', 'freeze', 'probe'] as const) {
      const repo = fixture(`assigned-local-idle-${seam}`);
      origin(repo);
      repo.git(['checkout', '-b', 'feature/shared']);
      repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
      const h = await waveFixture(repo, async () => { throw new Error('local target must not probe PR'); }, false);
      const owner = h.ledger.addJob({ id: 'local-owner', repo: 'assigned', title: 'owner', baseBranch: 'main' });
      registerPrBranchLane(repo, h.ledger, owner.id);
      h.ledger.setJobStatus(owner.id, 'working');
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: owner.id, payload: {} });
      h.ledger.setJobStatus(owner.id, 'delivered');
      const preflightShadow = seam.startsWith('preflight');
      const shadow = () => { git(repo.path, ['tag', 'feature/shared', 'refs/heads/feature/shared']); };
      const reopen = () => {
        if (!preflightShadow) shadow();
        h.ledger.setJobStatus(owner.id, 'working');
      };
      const original = h.worktrees.createReviewWorktree.bind(h.worktrees);
      if (seam === 'freeze' || seam === 'preflight-freeze') vi.spyOn(h.worktrees, 'createReviewWorktree').mockImplementation(async (input) => {
        const lane = await original(input); reopen(); return lane;
      });
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
        reviewArtifactRoot: h.artifactRoot,
        ...(preflightShadow ? { reviewPreflight: async () => { shadow(); if (seam === 'preflight') reopen(); return { ok: true, failures: [] }; } } : {}),
        ...(seam === 'probe' || seam === 'preflight-probe' ? { reviewFreezeObserver: reopen } : {}),
      });
      await expect(wave.requestReview({ jobId: h.job.id, targetRef: 'feature/shared' }))
        .rejects.toMatchObject({ name: 'BranchBusyError', targetBranch: 'feature/shared' });
      expect(git(repo.path, ['tag', '--list', 'feature/shared'])).toBe('feature/shared');
      expect(h.ledger.getJob(owner.id)?.status).toBe('working');
      expect(h.runtime.leadCalls).toHaveLength(0);
      expect(h.ledger.listJobEvents(h.job.id).some((event) => event.kind === 'round.admission-preflight')).toBe(false);
    }
  });

  it('revalidates same-SHA named identity at freeze and after probe while preserving unchanged audited authority', async () => {
    for (const seam of ['unchanged', 'post-freeze', 'freeze'] as const) {
      const repo = fixture(`assigned-late-alias-${seam}`);
      origin(repo);
      repo.git(['checkout', '-b', 'feature/shared']);
      const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
      repo.git(['tag', 'late-alias-target', target]);
      const h = await waveFixture(repo, async () => { throw new Error('local target must not probe PR'); }, false);
      const owner = h.ledger.addJob({ id: 'late-alias-owner', repo: 'assigned', title: 'audited owner', baseBranch: 'main' });
      h.ledger.setJobStatus(owner.id, 'working');
      h.ledger.setJobStatus(owner.id, 'delivered');
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: owner.id, payload: { sha: target } });
      h.ledger.appendCustomEvent({ kind: 'verification.started', jobId: owner.id, payload: { run_id: 'audited-run' } });
      const verification = h.ledger.latestJobEvent(owner.id, 'verification.started');
      repo.git(['checkout', 'main']);
      const path = join(directory(), 'audited-owner');
      git(repo.path, ['worktree', 'add', path, 'feature/shared']);
      writeFileSync(join(path, 'owner-data.txt'), 'retain owner');
      h.ledger.registerWorktree({ id: owner.id, kind: 'job', repoPath: repo.path, repoName: 'assigned', path,
        branch: 'feature/shared', sha: target, baseSource: null, jobId: owner.id });
      const retarget = () => { git(repo.path, ['symbolic-ref', 'refs/heads/feature/shared', 'refs/tags/late-alias-target']); };
      const original = h.worktrees.createReviewWorktree.bind(h.worktrees);
      if (seam === 'freeze') vi.spyOn(h.worktrees, 'createReviewWorktree').mockImplementation(async (input) => {
        const lane = await original(input); retarget(); return lane;
      });
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
        reviewArtifactRoot: h.artifactRoot, ...(seam === 'post-freeze' ? { reviewFreezeObserver: retarget } : {}),
      });
      const request = wave.requestReview({ jobId: h.job.id, targetRef: 'feature/shared', force: true });
      if (seam === 'unchanged') {
        const admitted = await request; await admitted.run;
        expect(h.runtime.leadCalls).toHaveLength(1);
        expect(h.ledger.latestJobEvent(h.job.id, 'round.admission-preflight')?.payload).toMatchObject({ ok: true });
        expect(git(repo.path, ['rev-parse', '--symbolic-full-name', 'refs/heads/feature/shared'])).toBe('refs/heads/feature/shared');
      } else {
        await expect(request).rejects.toThrow(/identity.*changed/u);
        expect(h.runtime.leadCalls).toHaveLength(0);
        expect(h.ledger.listJobEvents(h.job.id).some((event) => event.kind === 'round.admission-preflight')).toBe(false);
        expect(git(repo.path, ['symbolic-ref', '--no-recurse', 'refs/heads/feature/shared'])).toBe('refs/tags/late-alias-target');
      }
      expect(git(repo.path, ['rev-parse', 'refs/heads/feature/shared'])).toBe(target);
      expect(readFileSync(join(path, 'owner-data.txt'), 'utf8')).toBe('retain owner');
      expect(h.ledger.latestJobEvent(owner.id, 'verification.started')).toEqual(verification);
      expect(h.ledger.hasUnsettledVerificationRun(owner.id)).toBe(true);
      expect(h.ledger.listJobEvents(h.job.id).filter((event) => event.kind === 'branch-idle.forced')).toHaveLength(seam === 'freeze' ? 1 : 2);
    }
  });

  it('keeps same-SHA delivery generations isolated from an audited unsettled verification', async () => {
    for (const seam of ['unchanged', 'preflight', 'post-freeze'] as const) {
      const repo = fixture(`assigned-delivery-generation-${seam}`);
      origin(repo);
      const h = await waveFixture(repo, async () => { throw new Error('local target must not probe PR'); }, false);
      const lane = h.worktrees.listWorktrees({ jobId: h.job.id }).find((entry) => entry.kind === 'job')!;
      writeFileSync(join(lane.path, 'review-change.txt'), 'review change');
      git(lane.path, ['add', 'review-change.txt']);
      git(lane.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'review change']);
      const sha = git(lane.path, ['rev-parse', 'HEAD']);
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: h.job.id, payload: { sha } });
      h.ledger.appendCustomEvent({ kind: 'verification.started', jobId: h.job.id, payload: { run_id: 'old-run' } });
      const delivered = h.ledger.latestJobEvent(h.job.id, 'job.delivered')!;
      const verification = h.ledger.latestJobEvent(h.job.id, 'verification.started')!;
      const replace = () => { h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: h.job.id, payload: { sha } }); };
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
        reviewArtifactRoot: h.artifactRoot,
        ...(seam === 'preflight' ? { reviewPreflight: async () => { replace(); return { ok: true, failures: [] }; } } : {}),
        ...(seam === 'post-freeze' ? { reviewFreezeObserver: replace } : {}),
      });
      const request = wave.requestReview({ jobId: h.job.id, force: true });
      if (seam === 'unchanged') {
        const admitted = await request; await admitted.run;
        expect(h.runtime.leadCalls).toHaveLength(1);
        expect(h.ledger.latestJobEvent(h.job.id, 'round.admission-preflight')?.payload).toMatchObject({ ok: true });
        expect(h.ledger.latestJobEvent(h.job.id, 'job.delivered')).toEqual(delivered);
      } else {
        await expect(request).rejects.toMatchObject({ name: 'BranchBusyError' });
        expect(h.runtime.leadCalls).toHaveLength(0);
        expect(h.ledger.listJobEvents(h.job.id).some((event) => event.kind === 'round.admission-preflight')).toBe(false);
        expect(h.ledger.latestJobEvent(h.job.id, 'job.delivered')!.seq).toBeGreaterThan(delivered.seq);
        expect(h.ledger.latestJobEvent(h.job.id, 'job.delivered')!.payload).toEqual(delivered.payload);
      }
      expect(h.ledger.latestJobEvent(h.job.id, 'verification.started')).toEqual(verification);
      expect(h.ledger.hasUnsettledVerificationRun(h.job.id)).toBe(true);
      expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(sha);
    }
  });

  it('refuses initially ambiguous local branch/tag identity instead of inventing a SHA pin', async () => {
    for (const trace of ['0', '1']) {
      for (const warnings of ['false', 'true']) {
        const repo = fixture(`assigned-ambiguous-local-identity-${warnings}-${trace}`);
        origin(repo);
        repo.git(['config', 'core.warnAmbiguousRefs', warnings]);
        repo.git(['checkout', '-b', 'feature/shared']);
        const sha = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
        repo.git(['tag', 'feature/shared', sha]);
        vi.stubEnv('GIT_TRACE', trace);
        const h = await waveFixture(repo, async () => { throw new Error('local target must not probe PR'); }, false);
        const preflight = vi.fn(async () => ({ ok: true as const, failures: [] }));
        const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
          reviewArtifactRoot: h.artifactRoot, reviewPreflight: preflight,
        });
        await expect(wave.requestReview({ jobId: h.job.id, targetRef: 'feature/shared' })).rejects.toThrow(/identity.*ambiguous/u);
        expect(preflight).not.toHaveBeenCalled();
        expect(h.runtime.leadCalls).toHaveLength(0);
        expect(h.ledger.listJobEvents(h.job.id).some((event) => event.kind === 'round.admission-preflight')).toBe(false);
        expect(h.ledger.listRounds(h.job.id)).toHaveLength(0);
        expect(repo.git(['config', '--get', 'core.warnAmbiguousRefs'])).toBe(warnings);
      }
    }
  });


  it('preserves genuine tag, source-relative revision and SHA pins with inherited benign Git tracing', async () => {
    for (const kind of ['tag', 'revision', 'sha', 'abbreviated-sha'] as const) {
      const repo = fixture(`assigned-traced-pin-${kind}`);
      origin(repo);
      repo.git(['checkout', '-b', 'feature/pinned']);
      const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
      repo.git(['tag', 'trace-pin', target]);
      const h = await waveFixture(repo, async () => { throw new Error('intentional pin must not probe'); }, false);
      const lane = h.worktrees.listWorktrees({ jobId: h.job.id }).find((entry) => entry.kind === 'job')!;
      git(lane.path, ['reset', '--hard', target]);
      writeFileSync(join(lane.path, 'newer.txt'), 'newer\n');
      git(lane.path, ['add', 'newer.txt']);
      git(lane.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'newer lane head']);
      const sourceHead = git(lane.path, ['rev-parse', 'HEAD']);
      vi.stubEnv('GIT_TRACE', '1');
      const targetRef = kind === 'tag' ? 'trace-pin' : kind === 'revision' ? 'HEAD~1'
        : kind === 'sha' ? target : target.slice(0, 12);
      const request = await h.wave.requestReview({ jobId: h.job.id, targetRef });
      if (request.route !== 'perkins') throw new Error(`expected native request, got ${request.route}`);
      const outcome = await request.run;
      expect(outcome.headMoved).toBe(false);
      expect(h.runtime.leadCalls).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(h.artifactRoot, outcome.round.id, 'manifest.json'), 'utf8'))).toMatchObject({
        targetSha: target, targetRef: kind === 'tag' ? 'refs/tags/trace-pin' : target,
      });
      expect(git(lane.path, ['rev-parse', 'HEAD'])).toBe(sourceHead);
      expect(process.env.GIT_TRACE).toBe('1');
    }
  });

  it('refuses same-SHA head/tag identity replacement during preflight without changing pin or PR classification', async () => {
    for (const direction of ['head-to-tag', 'tag-to-head'] as const) {
      const repo = fixture(`assigned-changed-local-identity-${direction}`);
      origin(repo);
      repo.git(['checkout', '-b', 'feature/shared']);
      const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
      repo.git(['tag', 'identity-replacement', target]);
      const probe = vi.fn(async () => { throw new Error('local tag intent must not become PR authority'); });
      const h = await waveFixture(repo, probe, direction === 'tag-to-head');
      const fromRef = direction === 'head-to-tag' ? 'refs/heads/feature/shared' : 'refs/tags/identity-replacement';
      const toRef = direction === 'head-to-tag' ? 'refs/tags/identity-replacement' : 'refs/heads/feature/shared';
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
        reviewArtifactRoot: h.artifactRoot, prHeadProbe: probe, reviewPreflight: async () => {
          git(repo.path, ['symbolic-ref', fromRef, toRef]);
          return { ok: true, failures: [] };
        },
      });
      await expect(wave.requestReview({ jobId: h.job.id, targetRef: fromRef })).rejects.toThrow(/identity.*changed/u);
      expect(probe).not.toHaveBeenCalled();
      expect(h.runtime.leadCalls).toHaveLength(0);
      expect(h.ledger.listJobEvents(h.job.id).some((event) => event.kind === 'round.admission-preflight')).toBe(false);
      expect(h.ledger.listRounds(h.job.id)).toHaveLength(0);
      expect(git(repo.path, ['symbolic-ref', '--no-recurse', fromRef])).toBe(toRef);
      expect(git(repo.path, ['rev-parse', toRef])).toBe(target);
    }
  });

  it('refuses lost or changed named local identity between identity and commit lookups instead of inventing a pin', async () => {
    const servicePath = process.env.PATH ?? '';
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    for (const change of ['delete', 'alias'] as const) {
      const repo = fixture(`assigned-vanished-local-identity-${change}`);
      origin(repo);
      repo.git(['checkout', '-b', 'feature/shared']);
      const target = repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
      repo.git(['tag', 'lookup-replacement', target]);
      const h = await waveFixture(repo, async () => { throw new Error('local target must not probe PR'); }, false);
      const wrapperRoot = directory();
      const armed = join(wrapperRoot, 'preflight-finished');
      const removed = join(wrapperRoot, 'removed');
      writeFileSync(join(wrapperRoot, 'git'), '#!/usr/bin/env node\nconst fs = require("node:fs"), cp = require("node:child_process"); const args = process.argv.slice(2);\n' +
        `const r = cp.spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'utf8' });\n` +
        `if (fs.existsSync(${JSON.stringify(armed)}) && !fs.existsSync(${JSON.stringify(removed)}) && r.status === 0 && args.includes('rev-parse') && args.some(a => a === 'feature/shared' || a === 'refs/heads/feature/shared' || a === 'feature/shared^{commit}' || a === 'refs/heads/feature/shared^{commit}')) {\n` +
        ` cp.execFileSync(${JSON.stringify(realGit)}, ['-C', ${JSON.stringify(repo.path)}, ...${JSON.stringify(change === 'delete' ? ['update-ref', '--no-deref', '-d', 'refs/heads/feature/shared'] : ['symbolic-ref', 'refs/heads/feature/shared', 'refs/tags/lookup-replacement'])}]); fs.writeFileSync(${JSON.stringify(removed)}, JSON.stringify(args)); }\n` +
        'process.stdout.write(r.stdout ?? ""); process.stderr.write(r.stderr ?? ""); process.exit(r.status ?? 1);\n');
      chmodSync(join(wrapperRoot, 'git'), 0o755);
      vi.stubEnv('PATH', `${wrapperRoot}:${servicePath}`);
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
        reviewArtifactRoot: h.artifactRoot, reviewPreflight: async () => { writeFileSync(armed, 'armed'); return { ok: true, failures: [] }; },
      });
      await expect(wave.requestReview({ jobId: h.job.id, targetRef: 'feature/shared' })).rejects.toThrow();
      expect(JSON.parse(readFileSync(removed, 'utf8'))).toContain('--symbolic-full-name');
      expect(h.runtime.leadCalls).toHaveLength(0);
      expect(h.ledger.listJobEvents(h.job.id).some((event) => event.kind === 'round.admission-preflight')).toBe(false);
      expect(h.ledger.listRounds(h.job.id)).toHaveLength(0);
      vi.stubEnv('PATH', servicePath);
    }
  });

  it('rejects new verification while an audited run stays unsettled and accepts its unchanged-run control', async () => {
    for (const replacement of [null, 'verification.requested', 'verification.started'] as const) {
      const repo = fixture(`assigned-verification-generation-${replacement ?? 'unchanged'}`);
      origin(repo);
      const h = await waveFixture(repo, async () => { throw new Error('local target must not probe PR'); }, false);
      const lane = h.worktrees.listWorktrees({ jobId: h.job.id }).find((entry) => entry.kind === 'job')!;
      writeFileSync(join(lane.path, 'review-change.txt'), 'review change');
      git(lane.path, ['add', 'review-change.txt']);
      git(lane.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'review change']);
      h.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: h.job.id, payload: { run_id: 'old-run' } });
      h.ledger.appendCustomEvent({ kind: 'verification.started', jobId: h.job.id, payload: { run_id: 'old-run' } });
      const wave = new WaveRunner({ ledger: h.ledger, worktrees: h.worktrees, spawner: h.runtime.spawner,
        reviewArtifactRoot: h.artifactRoot, reviewFreezeObserver: () => {
          expect(h.ledger.hasUnsettledVerificationRun(h.job.id)).toBe(true);
          if (replacement !== null) h.ledger.appendCustomEvent({ kind: replacement, jobId: h.job.id, payload: { run_id: 'new-run' } });
        },
      });
      const request = wave.requestReview({ jobId: h.job.id, force: true });
      if (replacement !== null) {
        await expect(request).rejects.toMatchObject({ name: 'BranchBusyError' });
        expect(h.runtime.leadCalls).toHaveLength(0);
        expect(h.ledger.listJobEvents(h.job.id).some((event) => event.kind === 'round.admission-preflight')).toBe(false);
      } else {
        const admitted = await request;
        await admitted.run;
        expect(h.runtime.leadCalls).toHaveLength(1);
        expect(h.ledger.listJobEvents(h.job.id).find((event) => event.kind === 'round.admission-preflight')?.payload).toMatchObject({ ok: true });
      }
      expect(h.ledger.hasUnsettledVerificationRun(h.job.id)).toBe(true);
    }
  });

  it('keeps arm authority sampled before audit observers and rejects independently admitted freeze work', async () => {
    for (const seam of ['arm-audit', 'freeze-sample'] as const) {
      const repo = fixture(`assigned-independent-generation-${seam}`);
      origin(repo);
      repo.git(['checkout', '-b', 'feature/shared']);
      repo.commitFile('src/assigned.ts', 'export const assigned = true;\n');
      const h = await waveFixture(repo, async () => { throw new Error('local target must not probe PR'); }, false);
      const owner = h.ledger.addJob({ id: 'independent-owner', repo: 'assigned', title: 'owner', baseBranch: 'main' });
      registerPrBranchLane(repo, h.ledger, owner.id);
      const ledger = h.ledger;
      const otherDb = new LedgerDb(h.dbPath); dbs.push(otherDb);
      const independent = new LedgerApi(otherDb.handle, { bus: new EventBus() });
      ledger.setJobStatus(owner.id, 'working');
      let freeze = false; let inserted = false; let freezeReads = 0;
      const insert = () => {
        if (inserted) return; inserted = true;
        independent.beginDirectiveIntent({ jobId: owner.id, requestId: 'new-independent-work', directive: 'new', holder: 'fixture' });
      };
      const append = ledger.appendCustomEvent.bind(ledger);
      vi.spyOn(ledger, 'appendCustomEvent').mockImplementation((input) => {
        const event = append(input);
        if (seam === 'arm-audit' && input.kind === 'branch-idle.forced') insert();
        return event;
      });
      const original = h.worktrees.createReviewWorktree.bind(h.worktrees);
      vi.spyOn(h.worktrees, 'createReviewWorktree').mockImplementation(async (input) => {
        const lane = await original(input); freeze = true; return lane;
      });
      const read = ledger.listJobs.bind(ledger);
      vi.spyOn(ledger, 'listJobs').mockImplementation(() => {
        // The competing implementation proved one freeze snapshot, then
        // resampled and force-audited a second. New work enters that gap.
        if (seam === 'freeze-sample' && freeze && ++freezeReads === 2) insert();
        return read();
      });
      const wave = new WaveRunner({ ledger, worktrees: h.worktrees, spawner: h.runtime.spawner, reviewArtifactRoot: h.artifactRoot });
      await expect(wave.requestReview({ jobId: h.job.id, targetRef: 'feature/shared', force: true })).rejects.toMatchObject({ name: 'BranchBusyError' });
      expect(inserted).toBe(true);
      expect(h.runtime.leadCalls).toHaveLength(0);
      expect(ledger.listJobEvents(h.job.id).filter((event) => event.kind === 'branch-idle.forced')).toHaveLength(seam === 'arm-audit' ? 1 : 2);
      expect(ledger.listJobEvents(h.job.id).some((event) => event.kind === 'round.admission-preflight')).toBe(false);
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
            ...directiveRetirementInputs(h.ledger, record.requestId), lane: { id: lane.id, resolvedHead: lane.sha },
            reason: 'interrupted request', by: 'fixture' });
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
