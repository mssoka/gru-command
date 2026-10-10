import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBmadRuntimeBinder, readBmadRuntimeBinding } from '../src/bmad/runtime.js';
import { loadConfig } from '../src/config.js';
import { DispatchService } from '../src/dispatch/service.js';
import { rebriefFreshMinion, routeFixDirectiveToMinion } from '../src/dispatch/fix-directive.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { preflightFailure } from '../src/dispatch/review-path.js';
import { UnavailableWorktreePort } from '../src/dispatch/worktree-port.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { Role, RuntimeId } from '../src/config.js';
import { managedSkillsPromptNote, preferManagedSkills } from '../src/runtime/managed-skills.js';
import { RuntimeRegistry, serviceRegistryOptions } from '../src/runtime/registry.js';
import type { AgentHandle, AgentRuntime, SpawnOptions } from '../src/runtime/types.js';
import { SessionStore } from '../src/sessions/store.js';
import { createWorkflowSessionBinder, ownedFallbackReviewResources, registeredWorkflowLane, serviceWorkflowAuthority } from '../src/workflows/session.js';
import { loadBundledWorkflowRuntime, renderWorkflow, writeWorkflowManifest } from '../src/workflows/runtime.js';
import { makeWorkflowLane } from './helpers/workflow-lane.js';

const repoRoot = join(import.meta.dirname, '..');
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function fixture() { const f = makeWorkflowLane(); roots.push(f.root); return f; }
const caps = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };

function host(runtimeId: RuntimeId, f: ReturnType<typeof fixture>, authority?: Pick<ReturnType<typeof serviceWorkflowAuthority>, 'workflowLaneFor' | 'workflowBuildFor' | 'workflowAgentFor'>) {
  const config = loadConfig({ GRU_COMMAND_HOME: f.dataDir });
  const seen: SpawnOptions[] = [];
  const adapter: AgentRuntime = {
    id: runtimeId, capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
    spawn: async (role: Role, opts: SpawnOptions = {}): Promise<AgentHandle> => {
      seen.push(opts);
      return { id: opts.agentId ?? `worker-${seen.length}`, role, sessionFile: join(f.dataDir, 'worker.jsonl'), capabilities: caps,
        health: () => ({ state: 'idle', lastActivity: null, sessionFile: join(f.dataDir, 'worker.jsonl') }),
        subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {},
        hasLiveProcess: () => false, isCompacting: () => false, dispose: async () => {},
      };
    },
  };
  class HostRegistry extends RuntimeRegistry {
    override runtimeIdFor(): RuntimeId { return runtimeId; }
    override runtimeFor(): AgentRuntime { return adapter; }
  }
  const registry = new HostRegistry(serviceRegistryOptions({ config, store: new SessionStore(f.dataDir), ...(authority ?? { workflowLaneFor: () => f.lane }) }));
  return { seen, registry };
}

describe('production owned workflow session binding', () => {
  async function assertHost(runtimeId: RuntimeId): Promise<void> {
    const f = fixture();
    const h = host(runtimeId, f);
    const worker = await h.registry.spawn('minion', { cwd: f.lane.path, agentId: 'original-worker' });
    await worker.dispose();
    const managed = h.seen[0]!.managedSkills!;
    expect(managed).toMatchObject({ source: 'gru-command-workflows', runtimeId: loadBundledWorkflowRuntime().id, skills: ['gc-build'], laneBound: true });
    expect(h.seen[0]!.cwd).toBe(f.lane.path);
    const workflow = managed.workflow!;
    expect(workflow.context).toMatchObject({ projectRoot: f.lane.repoPath, worktreeRoot: f.lane.path, jobId: f.lane.id,
      knowledgeRoot: join(f.lane.path, 'gru-output') });
    expect(workflow.context.artifactRoot).toBe(join(f.dataDir, 'projects', workflow.context.projectId, 'jobs', f.lane.id, 'operational'));
    expect(JSON.parse(readFileSync(workflow.contextFile, 'utf8'))).toEqual(workflow.context);
    const note = managedSkillsPromptNote(managed, runtimeId);
    expect(note).toContain(workflow.invocation.entrypoint);
    expect(note).toContain(workflow.contextFile);
    expect(note).toContain('Honor its AGENTS.md');
    expect(note).toContain(runtimeId === 'pi' ? '`gc-build`' : '`gru-command-workflows:gc-build`');
    for (const route of ['normal', 'small-change', 'review'] as const) {
      const rendered = renderWorkflow({ id: managed.runtimeId, dir: managed.root, contentSha256: managed.contentSha256,
        skillsDir: managed.skillsDir, skills: managed.skills }, workflow.context, route);
      expect(existsSync(rendered.entrypoint)).toBe(true);
      const review = readFileSync(join(rendered.snapshotDir, 'skills/gc-build/review.md'), 'utf8');
      expect(review).toContain('service-tracked');
      expect(review).toContain('POST /api/dispatch');
      expect(review).toContain(`parent_job_id: "${f.lane.id}"`);
      expect(review).toContain('recorded findings');
      expect(review).toContain('Fix all actionable in-scope defects');
      expect(readFileSync(join(rendered.snapshotDir, 'skills/gc-build/present.md'), 'utf8')).toContain('verification');
    }
    const resumed = await h.registry.spawn('minion', { agentId: 'original-worker', resumeFile: worker.sessionFile! });
    expect(resumed.id).toBe(worker.id);
    await resumed.dispose();
    expect(h.seen[1]!.managedSkills).toEqual(managed);
    expect(h.seen[1]!.cwd).toBe(f.lane.path);
    const isolated = await h.registry.spawn('minion', { cwd: f.lane.path, isolatedReview: { systemPrompt: 'frozen native policy', tools: [] } });
    await isolated.dispose();
    expect(h.seen[2]!.managedSkills).toBeUndefined();
  }

  it('Pi registry spawn carries exact identity/context and resumes the same cwd/worker', async () => assertHost('pi'));
  it('Claude registry spawn carries exact identity/context and resumes the same cwd/worker', async () => assertHost('claude-code'));

  it('canonicalizes adapter-supported file URIs before resolving recorded resume ownership', async () => {
    const f = fixture();
    const file = join(f.dataDir, 'worker.jsonl'); writeFileSync(file, '');
    const worker = { id: 'worker', jobId: f.lane.id, sessionFile: file, role: 'minion' as const, parentage: 'top-level' as const };
    const records = { getAgent: () => worker, listAgents: () => [worker],
      getJob: () => ({ id: f.lane.id, deliverable: 'pr' as const }),
      getWorktree: (id: string) => id === f.lane.id ? f.lane : null, listWorktrees: () => [f.lane],
    };
    const h = host('pi', f, serviceWorkflowAuthority(f.dataDir, () => records));
    try {
      const resumed = await h.registry.spawn('minion', { resumeFile: `file://${file}` });
      expect(resumed.id).toBe(worker.id);
      expect(h.seen[0]!.cwd).toBe(f.lane.path);
      expect(h.seen[0]!.managedSkills!.workflow!.context.jobId).toBe(f.lane.id);
      await resumed.dispose();
    } finally { await h.registry.dispose(); }
  });

  it('production dispatch/registry selects PR builds but excludes new review/artifact workflows', async () => {
    const a = makeWorkflowLane('j-pr'); const b = makeWorkflowLane('j-review'); const c = makeWorkflowLane('j-artifact');
    roots.push(a.root, b.root, c.root);
    const db = new LedgerDb(a.dataDir);
    const ledger = new LedgerApi(db.handle);
    class Port extends UnavailableWorktreePort {
      override async createJobWorktree(input?: { jobId: string }) {
        if (input === undefined) throw new Error('fixture dispatch requires a job identity');
        const f = [a, b, c].find((item) => item.lane.id === input.jobId)!;
        return ledger.registerWorktree(f.lane);
      }
      override getWorktree(id: string) { return ledger.getWorktree(id); }
      override listWorktrees(options?: { jobId?: string }) { return ledger.listWorktrees(options); }
    }
    const authority = serviceWorkflowAuthority(a.dataDir, () => ledger);
    const h = host('pi', a, authority);
    const dispatch = new DispatchService({ ledger, worktrees: new Port(), spawner: (role, options) => h.registry.spawn(role, options) });
    try {
      for (const [f, deliverable] of [[a, 'pr'], [b, 'review'], [c, 'artifact']] as const) {
        const outcome = await dispatch.dispatch({ jobId: f.lane.id, repoPath: f.lane.repoPath,
          title: deliverable, briefing: `bounded ${deliverable}`, deliverable,
          ...(deliverable === 'review' ? { targetRef: 'https://git.example.invalid/a/b/pull/1', targetSha: f.lane.sha } : {}),
        });
        expect(await outcome.settled).toEqual({ ok: true });
      }
      expect(h.seen[0]!.managedSkills!.workflow!.context.jobId).toBe(a.lane.id);
      expect(h.seen[1]!.managedSkills).toBeUndefined();
      expect(h.seen[2]!.managedSkills).toBeUndefined();
      expect(h.seen.map((opts) => opts.cwd)).toEqual([a.lane.path, b.lane.path, c.lane.path]);
      expect(readBmadRuntimeBinding(b.lane.path, join(a.dataDir, 'bmad-runtime'))).toBeNull();
      expect(readBmadRuntimeBinding(c.lane.path, join(a.dataDir, 'bmad-runtime'))).toBeNull();
      // Helper retention is not build execution: fallback can pin owned bytes,
      // but subsequent report-worker sessions still receive no build workflow.
      for (const f of [b, c]) {
        const resources = authority.resolveReviewResources(f.lane.id);
        expect(resources.artifactRoot).toContain(join('jobs', f.lane.id, 'operational'));
        const owner = ledger.listAgents().find((agent) => agent.jobId === f.lane.id)!;
        const worker = await h.registry.spawn('minion', { agentId: owner.id, cwd: f.lane.path });
        await worker.dispose();
        expect(h.seen.at(-1)!.managedSkills).toBeUndefined();
        expect(authority.resolveReviewResources(f.lane.id)).toEqual(resources);
      }
    } finally { await h.registry.dispose(); db.close(); }
  });

  it('production fallback gates select each registered job retained package and private report root', async () => {
    const historicalGuide = readFileSync(join(repoRoot, 'docs/BMAD-RUNTIME.md'), 'utf8');
    expect(historicalGuide).toContain('production fallback gate selects the verified GC-owned helper');
    expect(historicalGuide).not.toContain('It reads an installed global');
    const a = makeWorkflowLane('j-gate-a'); const b = makeWorkflowLane('j-gate-b'); const historical = makeWorkflowLane('j-gate-history');
    roots.push(a.root, b.root, historical.root);
    const db = new LedgerDb(a.dataDir);
    const ledger = new LedgerApi(db.handle);
    for (const f of [a, b, historical]) {
      ledger.addJob({ id: f.lane.id, repo: 'app', title: 'review', baseBranch: 'main' });
      ledger.registerWorktree(f.lane);
      ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.lane.id, payload: {} });
    }
    const first = serviceWorkflowAuthority(a.dataDir, () => ledger).resolveReviewResources(a.lane.id);
    const pkg = join(b.root, 'package-b');
    cpSync(join(repoRoot, 'resources/gc-workflows'), join(pkg, 'resources/gc-workflows'), { recursive: true });
    writeWorkflowManifest(pkg, 2);
    const authority = serviceWorkflowAuthority(a.dataDir, () => ledger, pkg);
    const second = authority.resolveReviewResources(b.lane.id);
    const old = createBmadRuntimeBinder(join(a.dataDir, 'bmad-runtime'))(historical.lane.path);
    const retained = authority.resolveReviewResources(historical.lane.id);
    expect(retained.artifactRoot).toBe(join(a.dataDir, 'reviews'));
    const seen: SpawnOptions[] = [];
    class Port extends UnavailableWorktreePort {
      override getWorktree(id: string) { return ledger.getWorktree(id); }
      override listWorktrees() { return ledger.listWorktrees(); }
    }
    const wave = new WaveRunner({ ledger, worktrees: new Port(),
      reviewPreflight: async () => ({ ok: false, failures: [preflightFailure('review-policy', 'fixture disabled')] }),
      fallbackGate: { resolveReviewResources: authority.resolveReviewResources, fixDirectiveSink: async () => ({ delivered: false }) },
      spawner: async (role, opts = {}) => {
        seen.push(opts);
        return { id: `fallback-${seen.length}`, role, sessionFile: null, capabilities: caps,
          reviewTools: opts.isolatedReview?.nativeTools?.map((tool) => tool.name),
          prompt: async () => { await opts.isolatedReview!.nativeTools![0]!.execute({ findings: [] }); },
          subscribe: () => () => {}, steer: async () => {}, followUp: async () => {}, dispose: async () => {},
          health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }),
        };
      },
    });
    try {
      for (const [f, resources] of [[a, first], [b, second], [historical, retained]] as const) {
        const outcome = await wave.runRound({ jobId: f.lane.id });
        if (!('route' in outcome)) throw new Error('expected fallback');
        expect(outcome.clearToMerge).toBe(true);
        expect(outcome.reportFiles[0]).toContain(join(resources.artifactRoot, 'fallback-gate'));
        expect(readFileSync(outcome.reportFiles[0]!, 'utf8').trim()).toBe('[]');
      }
      expect(first.artifactRoot).not.toBe(second.artifactRoot);
      expect(seen[0]!.isolatedReview!.systemPrompt).toContain(first.skillPath);
      expect(seen[1]!.isolatedReview!.systemPrompt).toContain(second.skillPath);
      expect(readBmadRuntimeBinding(a.lane.path, join(a.dataDir, 'bmad-runtime'))!.id).toBe(loadBundledWorkflowRuntime().id);
      expect(readBmadRuntimeBinding(b.lane.path, join(a.dataDir, 'bmad-runtime'))!.id).toBe(loadBundledWorkflowRuntime(pkg).id);
      expect(authority.resolveReviewResources(a.lane.id)).toEqual(first);
      expect(seen[2]!.isolatedReview!.systemPrompt).toContain(retained.skillPath);
      expect(readBmadRuntimeBinding(historical.lane.path, join(a.dataDir, 'bmad-runtime'))!.id).toBe(old.runtimeId);
      expect(() => authority.resolveReviewResources('j-missing')).toThrow(/live registered job worktree/u);
    } finally { await wave.shutdown(); db.close(); }
  });

  it('refuses retained helper corruption before capturing any fallback instructions', () => {
    const f = fixture();
    const bound = createWorkflowSessionBinder(f.dataDir, () => f.lane)({ cwd: f.lane.path });
    const helper = join(bound.managedSkills!.root, 'skills/gc-build/review-prompts/adversarial.md');
    chmodSync(helper, 0o600); writeFileSync(helper, 'unverified retained helper before capture');
    expect(() => ownedFallbackReviewResources(bound, f.dataDir)).toThrow(/failed verification|retained identity/u);
    expect(readBmadRuntimeBinding(f.lane.path, join(f.dataDir, 'bmad-runtime'))!.contentSha256).toBe(bound.managedSkills!.contentSha256);
  });

  it('ambient name collisions/malformed BMAD answers cannot replace authority or write paths', () => {
    const f = fixture();
    mkdirSync(join(f.lane.path, '_bmad/custom'), { recursive: true });
    writeFileSync(join(f.lane.path, '_bmad/custom/config.toml'), 'NOT TOML!');
    writeFileSync(join(f.lane.path, '_bmad/config.toml'), 'broken legacy answers');
    const bind = createWorkflowSessionBinder(f.dataDir, () => f.lane);
    const first = bind({ cwd: f.lane.path }).managedSkills!;
    const base = { skills: [{ name: 'gc-build', filePath: '/hostile/global/gc-build/SKILL.md' },
      { name: 'bmad-build', filePath: '/hostile/project/bmad-build/SKILL.md' }], diagnostics: [] };
    const preferred = preferManagedSkills(base as unknown as Parameters<typeof preferManagedSkills>[0], first);
    expect(preferred.skills.find((skill) => skill.name === 'gc-build')!.filePath).toBe(join(first.skillsDir, 'gc-build/SKILL.md'));
    expect(bind({ cwd: f.lane.path })).toEqual({ cwd: f.lane.path, managedSkills: first });
    expect(readFileSync(join(f.lane.path, '_bmad/custom/config.toml'), 'utf8')).toBe('NOT TOML!');
    expect(existsSync(join(f.lane.path, '_bmad/render'))).toBe(false);
    const fallback = ownedFallbackReviewResources({ cwd: f.lane.path, managedSkills: first }, f.dataDir);
    expect(fallback.skillPath).toContain(first.workflow!.invocation.snapshotDir);
    expect(fallback.artifactRoot).toBe(first.workflow!.context.artifactRoot);
  });

  it('a retained owned A wins after B ships or disappears; missing A refuses restoration instead of switching', () => {
    const f = fixture();
    const a = createWorkflowSessionBinder(f.dataDir, () => f.lane)({ cwd: f.lane.path });
    const pkg = join(f.root, 'package-b');
    cpSync(join(repoRoot, 'resources/gc-workflows'), join(pkg, 'resources/gc-workflows'), { recursive: true });
    writeWorkflowManifest(pkg, 2);
    const bindB = createWorkflowSessionBinder(f.dataDir, () => f.lane, pkg);
    expect(bindB({ cwd: f.lane.path })).toEqual(a);
    rmSync(join(pkg, 'resources'), { recursive: true });
    expect(bindB({ cwd: f.lane.path })).toEqual(a);
    rmSync(a.managedSkills!.root, { recursive: true });
    expect(() => bindB({ cwd: f.lane.path })).toThrow(/restore that exact retained package.*same worker\/lane/u);
    expect(readBmadRuntimeBinding(f.lane.path, join(f.dataDir, 'bmad-runtime'))!.id).toBe(a.managedSkills!.runtimeId);
  });

  it('historical schema-1 jobs keep their original skills/references and missing retained bytes refuse', () => {
    const f = fixture();
    const old = createBmadRuntimeBinder(join(f.dataDir, 'bmad-runtime'))(f.lane.path);
    const bind = createWorkflowSessionBinder(f.dataDir, () => f.lane, join(f.root, 'no-current-package'));
    expect(bind({ cwd: f.lane.path })).toEqual({ cwd: f.lane.path, managedSkills: old });
    expect(existsSync(join(f.dataDir, 'projects'))).toBe(false);
    const fallback = ownedFallbackReviewResources({ cwd: f.lane.path, managedSkills: old }, f.dataDir);
    expect(fallback.skillPath).toContain('gru-command-workflows-');
    expect(readBmadRuntimeBinding(f.lane.path, join(f.dataDir, 'bmad-runtime'))!.id).toBe(old.runtimeId);
    rmSync(old.root, { recursive: true });
    expect(() => bind({ cwd: f.lane.path })).toThrow(/restore that exact retained package/u);
  });

  it('retains historical report/artifact bindings even when the new build predicate excludes them', () => {
    const f = fixture();
    const old = createBmadRuntimeBinder(join(f.dataDir, 'bmad-runtime'))(f.lane.path);
    const bind = createWorkflowSessionBinder(f.dataDir, () => f.lane, undefined, () => false);
    expect(bind({ resumeFile: '/historical-report.jsonl' })).toEqual({ cwd: f.lane.path, managedSkills: old });
    rmSync(old.root, { recursive: true });
    expect(() => bind({ resumeFile: '/historical-report.jsonl' })).toThrow(/restore that exact retained package/u);
  });

  it('rejects invalid artifact paths before publishing a new lane workflow binding', () => {
    const f = fixture();
    symlinkSync(f.dataDir, join(f.lane.path, 'gru-output'));
    expect(() => createWorkflowSessionBinder(f.dataDir, () => f.lane)({ cwd: f.lane.path })).toThrow(/symlink/u);
    expect(readBmadRuntimeBinding(f.lane.path, join(f.dataDir, 'bmad-runtime'))).toBeNull();
    rmSync(join(f.lane.path, 'gru-output'));
    const pkg = join(f.root, 'package-b');
    cpSync(join(repoRoot, 'resources/gc-workflows'), join(pkg, 'resources/gc-workflows'), { recursive: true });
    writeWorkflowManifest(pkg, 2);
    expect(createWorkflowSessionBinder(f.dataDir, () => f.lane, pkg)({ cwd: f.lane.path }).managedSkills!.runtimeId).toBe(loadBundledWorkflowRuntime(pkg).id);
  });

  it('isolates projects/jobs, rejects missing/unsafe context and preserves bounded child/report tasks', () => {
    const a = fixture(); const b = fixture();
    const aa = createWorkflowSessionBinder(a.dataDir, () => a.lane)({ cwd: a.lane.path }).managedSkills!;
    const bb = createWorkflowSessionBinder(a.dataDir, () => b.lane)({ cwd: b.lane.path }).managedSkills!;
    expect(aa.workflow!.context.artifactRoot).not.toBe(bb.workflow!.context.artifactRoot);
    expect(() => createWorkflowSessionBinder(a.dataDir, () => null)({})).toThrow(/live registered assignment/u);
    expect(createWorkflowSessionBinder(a.dataDir, () => ({ ...a.lane, kind: 'child' }))({ cwd: a.lane.path })).toEqual({ cwd: a.lane.path });
    expect(createWorkflowSessionBinder(a.dataDir, () => a.lane)({ roleTools: ['read', 'write'] })).toEqual({ cwd: a.lane.path });
    expect(createWorkflowSessionBinder(a.dataDir, () => a.lane, undefined, () => false)({ resumeFile: '/report-session.jsonl' })).toEqual({ cwd: a.lane.path });
    chmodSync(aa.workflow!.context.artifactRoot, 0o755);
    expect(() => createWorkflowSessionBinder(a.dataDir, () => a.lane)({ cwd: a.lane.path })).toThrow(/private/u);
    expect(execFileSync('git', ['-C', b.lane.path, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('');
  });

  it('resolves resumes only through recorded ownership, refusing conflicts and swept/missing assignments', () => {
    const f = fixture();
    const records = [{ id: 'worker', jobId: f.lane.id, sessionFile: '/private/session.jsonl', role: 'minion' as const, parentage: 'top-level' as const }];
    const ledger = { getAgent: (id: string) => records.find((r) => r.id === id) ?? null, listAgents: () => records };
    const port = { getWorktree: (id: string) => id === f.lane.id ? f.lane : null, listWorktrees: () => [f.lane] };
    const resolve = (options: SpawnOptions) => registeredWorkflowLane(options, port, ledger);
    expect(resolve({ resumeFile: records[0]!.sessionFile })).toEqual(f.lane);
    expect(() => resolve({ cwd: f.lane.path })).toThrow(/already has a logical worker/u);
    expect(() => resolve({ agentId: 'unknown-fresh-id', cwd: f.lane.path })).toThrow(/already has a logical worker/u);
    expect(registeredWorkflowLane({ agentId: 'admitted-fresh', cwd: f.lane.path }, port,
      { getAgent: () => null, listAgents: () => [] })).toEqual(f.lane);
    expect(() => resolve({ agentId: 'worker', cwd: '/foreign' })).toThrow(/conflicts/u);
    expect(() => resolve({ resumeFile: '/private/unowned.jsonl', cwd: f.lane.path })).toThrow(/registered session owner/u);
    expect(() => resolve({ resumeFile: '/private/unowned.jsonl', agentId: 'worker' })).toThrow(/registered session owner/u);
    expect(() => resolve({ resumeFile: records[0]!.sessionFile, agentId: 'unknown' })).toThrow(/identity conflicts/u);
    records.push({ id: 'other', jobId: 'j-other', sessionFile: records[0]!.sessionFile, role: 'minion', parentage: 'top-level' });
    expect(() => resolve({ resumeFile: records[0]!.sessionFile })).toThrow(/ambiguous/u);
    expect(resolve({ cwd: join(f.lane.path, '..', 'guessed-job') })).toBeNull();
  });

  it('production sessionless fix and re-brief recovery preserve the recorded identity, parentage and retained owned lane', async () => {
    for (const mode of ['fix', 'rebrief'] as const) for (const parentage of [null, 'top-level'] as const) {
      const f = fixture(); const db = new LedgerDb(f.dataDir); const ledger = new LedgerApi(db.handle);
      ledger.addJob({ id: f.lane.id, repo: f.lane.repoName, title: 'original job', briefing: 'original contract' });
      ledger.registerWorktree(f.lane);
      ledger.registerAgent({ id: 'original-minion', role: 'minion', jobId: f.lane.id, sessionFile: null, parentage });
      const authority = serviceWorkflowAuthority(f.dataDir, () => ledger);
      authority.resolveReviewResources(f.lane.id);
      const retained = readBmadRuntimeBinding(f.lane.path, join(f.dataDir, 'bmad-runtime'))!;
      class Port extends UnavailableWorktreePort {
        override getWorktree(id: string) { return id === f.lane.id ? f.lane : null; }
        override listWorktrees() { return [f.lane]; }
      }
      const h = host('pi', f, authority); const worktrees = new Port();
      try {
        const result = mode === 'fix'
          ? await routeFixDirectiveToMinion({ registry: h.registry, ledger, worktrees, jobId: f.lane.id,
              directive: 'accepted fix', contract: 'effective contract', signal: new AbortController().signal })
          : await rebriefFreshMinion({ registry: h.registry, ledger, worktrees, jobId: f.lane.id,
              note: 'accepted re-brief', briefing: 'effective contract' });
        expect(result.minionId).toBe('original-minion');
        expect(h.seen[0]!.resumeFile).toBeUndefined();
        expect(h.seen[0]!.cwd).toBe(f.lane.path);
        expect(h.seen[0]!.managedSkills!.contentSha256).toBe(retained.contentSha256);
        expect(ledger.getAgent('original-minion')!.parentage).toBe(parentage);
        expect(ledger.listImplementerMinions(f.lane.id).map((agent) => agent.id)).toEqual(['original-minion']);
      } finally { await h.registry.dispose(); db.close(); }
    }
  });

  it('refuses cross-job ID collisions and never redirects a missing child assignment into the parent lane', () => {
    const a = fixture(); const b = fixture();
    const records = [
      { id: 'worker', jobId: a.lane.id, sessionFile: '/owner.jsonl', role: 'minion' as const, parentage: 'top-level' as const },
      { id: 'child', jobId: a.lane.id, sessionFile: '/child.jsonl', role: 'minion' as const, parentage: 'child' as const },
    ];
    const ledger = { getAgent: (id: string) => records.find((record) => record.id === id) ?? null, listAgents: () => records };
    const port = { getWorktree: (id: string) => id === 'worker' ? { ...b.lane, id: 'worker', jobId: 'worker' } : id === a.lane.id ? a.lane : null,
      listWorktrees: () => [a.lane, b.lane],
    };
    expect(() => registeredWorkflowLane({ agentId: 'worker', resumeFile: '/owner.jsonl' }, port, ledger)).toThrow(/does not belong/u);
    expect(registeredWorkflowLane({ agentId: 'child', resumeFile: '/child.jsonl' }, port, ledger)).toBeNull();
  });
});
