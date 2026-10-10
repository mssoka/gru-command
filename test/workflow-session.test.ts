import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createBmadRuntimeBinder, readBmadRuntimeBinding } from '../src/bmad/runtime.js';
import { loadConfig } from '../src/config.js';
import type { Role, RuntimeId } from '../src/config.js';
import { managedSkillsPromptNote, preferManagedSkills } from '../src/runtime/managed-skills.js';
import { RuntimeRegistry, serviceRegistryOptions } from '../src/runtime/registry.js';
import type { AgentHandle, AgentRuntime, SpawnOptions } from '../src/runtime/types.js';
import { SessionStore } from '../src/sessions/store.js';
import { createWorkflowSessionBinder, ownedFallbackReviewResources, registeredWorkflowLane } from '../src/workflows/session.js';
import { loadBundledWorkflowRuntime, renderWorkflow, writeWorkflowManifest } from '../src/workflows/runtime.js';
import { makeWorkflowLane } from './helpers/workflow-lane.js';

const repoRoot = join(import.meta.dirname, '..');
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function fixture() { const f = makeWorkflowLane(); roots.push(f.root); return f; }
const caps = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };

function host(runtimeId: RuntimeId, f: ReturnType<typeof fixture>) {
  const config = loadConfig({ GRU_COMMAND_HOME: f.dataDir });
  const seen: SpawnOptions[] = [];
  const adapter: AgentRuntime = {
    id: runtimeId, capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
    spawn: async (role: Role, opts: SpawnOptions = {}): Promise<AgentHandle> => {
      seen.push(opts);
      return { id: opts.agentId ?? 'original-worker', role, sessionFile: join(f.dataDir, 'worker.jsonl'), capabilities: caps,
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
  const registry = new HostRegistry(serviceRegistryOptions({ config, store: new SessionStore(f.dataDir), workflowLaneFor: () => f.lane }));
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
      expect(review).toContain('tracked child runs');
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
    const records = [{ id: 'worker', jobId: f.lane.id, sessionFile: '/private/session.jsonl' }];
    const ledger = { getAgent: (id: string) => records.find((r) => r.id === id) ?? null, listAgents: () => records };
    const port = { getWorktree: (id: string) => id === f.lane.id ? f.lane : null, listWorktrees: () => [f.lane] };
    const resolve = (options: SpawnOptions) => registeredWorkflowLane(options, port, ledger);
    expect(resolve({ resumeFile: records[0]!.sessionFile })).toEqual(f.lane);
    expect(resolve({ cwd: f.lane.path })).toEqual(f.lane);
    expect(() => resolve({ agentId: 'worker', cwd: '/foreign' })).toThrow(/conflicts/u);
    records.push({ id: 'other', jobId: 'j-other', sessionFile: records[0]!.sessionFile });
    expect(() => resolve({ resumeFile: records[0]!.sessionFile })).toThrow(/ambiguous/u);
    expect(resolve({ cwd: join(f.lane.path, '..', 'guessed-job') })).toBeNull();
  });
});
