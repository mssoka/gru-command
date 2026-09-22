import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { PiRuntime, normalizeSessionPath, type PiRuntimeOptions } from '../src/runtime/pi-adapter.js';
import { RuntimeRegistry, applyThinkingFallback } from '../src/runtime/registry.js';
import { LockBusyError, SessionStore } from '../src/sessions/store.js';
import { capabilitiesForModelInput, type AgentHandle, type RuntimeEvent } from '../src/runtime/types.js';
import { makeIsolatedModelRuntime, makeStubModelRuntime, StubScript, type StubResponder, type StubTurn } from './helpers/stub-model.js';
import { PerkinsHybridReview } from '../src/dispatch/perkins-review/hybrid.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { freezeReviewInputs } from '../src/dispatch/perkins-review/artifacts.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';

/**
 * Perkins r3 B1: a gated-twin mock for createAgentSession. Disarmed, it is
 * a transparent pass-through; armed, twin 0 stalls then FAILS while twin 1
 * stalls then proceeds — the one interleaving where the winner-ensures-
 * lock re-acquire leg must fire (the pre-acquiring twin releases in its
 * catch while the survivor is still in flight).
 */
const twinGate = vi.hoisted(() => ({
  armed: false,
  fail0: null as null | (() => void),
  release1: null as null | (() => void),
  lastOptions: null as unknown,
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@earendil-works/pi-coding-agent')
  >();
  let call = 0;
  return {
    ...actual,
    createAgentSession: async (opts: unknown) => {
      twinGate.lastOptions = opts;
      if (!twinGate.armed) {
        return actual.createAgentSession(opts as never);
      }
      const n = call++;
      if (n === 0) {
        await new Promise<never>((_, reject) => {
          twinGate.fail0 = () => reject(new Error('twin-0 infrastructure failure'));
        });
      }
      await new Promise<void>((resolveGate) => {
        twinGate.release1 = resolveGate;
      });
      return actual.createAgentSession(opts as never);
    },
  };
});

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  home: string;
  workspace: string;
  agentDir: string;
  store: SessionStore;
  script: StubScript;
  config: ReturnType<typeof loadConfig>;
  modelRuntime: Awaited<ReturnType<typeof makeStubModelRuntime>>;
}

interface FixtureOptions {
  readonly modelCatalogRefresh?: PiRuntimeOptions['modelCatalogRefresh'];
  readonly configExtra?: string;
  readonly log?: PiRuntimeOptions['log'];
}

async function fixture(
  turns: readonly StubTurn[] | StubResponder = [],
  modelInput: readonly ('text' | 'image')[] = ['text'],
  options: FixtureOptions = {},
): Promise<Fixture & { runtime: PiRuntime }> {
  const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
  const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
  cleanupDirs.push(home, workspace, agentDir);
  writeFileSync(
    configPathFor(home),
    `workspace_root = "${workspace}"\n[models]\ndefault = "gru-stub/stub-model"\n${options.configExtra ?? ''}`,
    'utf-8',
  );
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const store = new SessionStore(config.dataDir);
  const script = new StubScript(turns);
  const modelRuntime = await makeStubModelRuntime(script, { input: modelInput });
  const runtime = new PiRuntime({
    config,
    store,
    agentDir,
    modelRuntime,
    ...(options.modelCatalogRefresh !== undefined
      ? { modelCatalogRefresh: options.modelCatalogRefresh }
      : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
  });
  return { home, workspace, agentDir, store, script, config, modelRuntime, runtime };
}

function collect(handle: { subscribe(listener: (event: RuntimeEvent) => void): () => void }): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  handle.subscribe((event) => events.push(event));
  return events;
}

/** Await a spawn that MUST fail and return its message for content pins. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected the promise to reject');
}

describe('PiRuntime over the stub model (offline SDK round-trip)', () => {
  it('spawns a session persisted under the instance sessions dir', async () => {
    const fx = await fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      expect(handle.role).toBe('gru');
      const expectedDir = fx.store.sessionDirFor('gru', fx.workspace);
      expect(handle.sessionFile).toContain(expectedDir);
      expect(handle.sessionFile).toMatch(/\.jsonl$/);
      // pi-standard file naming: <timestamp>_<uuid>.jsonl
      const sessionFile = handle.sessionFile!;
      const name = sessionFile.split('/').pop()!;
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T[\dT:.Z-]+_[0-9a-f-]{36}\.jsonl$/);
      // The session file is locked for the handle's lifetime.
      expect(existsSync(`${sessionFile}.lock`)).toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it('enforces isolated-review tools and strips ambient Pi resources', async () => {
    const fx = await fixture();
    writeFileSync(join(fx.workspace, 'AGENTS.md'), 'PROJECT-CONTEXT-CANARY', 'utf8');
    mkdirSync(join(fx.agentDir, 'skills', 'canary'), { recursive: true });
    writeFileSync(join(fx.agentDir, 'skills', 'canary', 'SKILL.md'), '---\nname: canary\ndescription: secret canary\n---\nCANARY', 'utf8');
    const handle = await fx.runtime.spawn('perkins', {
      isolatedReview: { systemPrompt: 'isolated policy', tools: [] },
    });
    try {
      const options = twinGate.lastOptions as {
        noTools?: string;
        tools?: string[];
        resourceLoader: {
          getSkills(): { skills: unknown[] };
          getPrompts(): { prompts: unknown[] };
          getAgentsFiles(): { agentsFiles: unknown[] };
          getExtensions(): { extensions: unknown[] };
          getSystemPrompt(): string | undefined;
          getAppendSystemPrompt(): string[];
        };
      };
      expect(options.noTools).toBe('all');
      expect(options.tools).toEqual([]);
      expect(options.resourceLoader.getSkills().skills).toEqual([]);
      expect(options.resourceLoader.getPrompts().prompts).toEqual([]);
      expect(options.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
      expect(options.resourceLoader.getExtensions().extensions).toEqual([]);
      expect(options.resourceLoader.getAppendSystemPrompt()).toEqual([]);
      expect(options.resourceLoader.getSystemPrompt()).toBe('isolated policy');
      expect(handle.reviewIsolation).toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it('wires requested isolated-review native tools and declares them on the handle', async () => {
    const fx = await fixture();
    const tool = {
      name: 'perkins_submit_findings',
      description: 'structured findings child tool',
      inputSchema: { type: 'object', additionalProperties: false },
      execute: async () => ({ text: JSON.stringify({ accepted: true }) }),
    };
    const handle = await fx.runtime.spawn('perkins', {
      isolatedReview: { systemPrompt: 'isolated policy', tools: [], nativeTools: [tool] },
    });
    try {
      const options = twinGate.lastOptions as {
        tools?: string[];
        customTools?: Array<{ name: string; execute(...args: unknown[]): Promise<unknown> }>;
      };
      expect(options.tools).toEqual(['perkins_submit_findings']);
      expect(options.customTools?.map((entry) => entry.name)).toEqual(['perkins_submit_findings']);
      expect(handle.reviewTools).toEqual(['perkins_submit_findings']);
      await expect(options.customTools![0]!.execute('call', {}, undefined, undefined))
        .resolves.toSatisfy((result: unknown) => JSON.stringify(result).includes('accepted'));
    } finally {
      await handle.dispose();
    }
    const textOnly = await fx.runtime.spawn('perkins', {
      isolatedReview: { systemPrompt: 'isolated policy', tools: [] },
    });
    try {
      expect(textOnly.reviewTools).toBeUndefined();
    } finally {
      await textOnly.dispose();
    }
  });

  it('runs a hybrid Perkins lead through the production registry and real Pi adapter', async () => {
    let leadTurns = 0;
    const confirmed = new Map<string, { candidate_ref: string }>();
    const harvest = (prompt: string): void => {
      for (const markerText of prompt.split('[TOOL_RESULT perkins_run_lenses]').slice(1)) {
        const payload = markerText.split(/\n\[TOOL_RESULT /)[0]!.trim();
        try {
          const parsed = JSON.parse(payload) as { results: Array<{ findings: Array<{ ref: string }> }> };
          for (const result of parsed.results) {
            for (const candidate of result.findings) confirmed.set(candidate.ref, { candidate_ref: candidate.ref });
          }
        } catch { /* non-JSON tool text */ }
      }
    };
    const fx = await fixture((prompt) => {
      if (prompt.includes('REQUIRED CHILD COVERAGE')) {
        leadTurns += 1;
        harvest(prompt);
        if (leadTurns === 1) {
          return {
            deltas: [],
            toolCall: { id: 'lead-read-1', name: 'perkins_read_chunk', args: { chunk: '001' } },
          };
        }
        if (leadTurns === 2) {
          return {
            deltas: [],
            toolCall: {
              id: 'lead-run-1', name: 'perkins_run_lenses',
              args: { runs: ['blind', 'edge', 'acceptance', 'security'].map((lens) => ({ lens, chunk: '001' })) },
            },
          };
        }
        if (leadTurns === 3) {
          return {
            deltas: [],
            toolCall: {
              id: 'lead-run-2', name: 'perkins_run_lenses',
              args: { runs: ['architecture', 'codebase', 'tests'].map((lens) => ({ lens, chunk: '001' })) },
            },
          };
        }
        if (leadTurns >= 5) return { deltas: ['hybrid lead complete'] };
        const targetSha = /^Frozen target SHA: (.+)$/m.exec(prompt)?.[1] ?? '';
        const baseSha = /^Frozen diff base SHA: (.+)$/m.exec(prompt)?.[1] ?? '';
        return {
          deltas: [],
          toolCall: {
            id: 'lead-submit', name: 'perkins_submit_review',
            args: {
              canonical_verdict: 'READY TO MERGE',
              candidate_decisions: [...confirmed.values()].map((candidate) => ({
                ...candidate,
                disposition: 'confirmed',
                evidence: 'export function answer(): number {',
                reason: 'lead verified against the frozen tree',
              })),
              prior_audit: [],
              report_markdown: [
                '# Perkins Code Review',
                '',
                '**Verdict: READY TO MERGE**',
                `Target: ${targetSha}`,
                `Base: ${baseSha}`,
                'Coverage: blind edge acceptance security architecture codebase tests',
                'warning Verified adapter finding src/main.ts:2',
                '  return 43;',
                'Retain verification coverage for this path.',
              ].join('\n'),
            },
          },
        };
      }
      const lens = /Your lens id is "(blind|edge|acceptance|security|architecture|codebase|tests)"/u.exec(prompt)?.[1];
      // Native-tool children submit structured findings through the product
      // tool; assistant text is never the findings channel on pi.
      const childFindings = lens === 'security'
        ? [{
            severity: 'warning', category: 'coverage', title: 'Verified adapter finding',
            location: 'src/main.ts:2', evidence: '  return 43;',
            detail: 'The changed line is independently reviewable.',
            recommended_fix: 'Retain verification coverage for this path.',
          }]
        : lens === 'tests'
          ? [{
              severity: 'warning', category: 'coverage-gate', title: 'Coverage gate: CONCERNS',
              location: 'N/A', evidence: 'N/A',
              detail: 'Changed behavior has no executed live-credential smoke proof.',
              recommended_fix: 'Run the opt-in live-credential smoke test before release.',
            }]
          : [];
      return {
        deltas: [],
        toolCall: {
          id: `child-submit-${lens ?? 'unknown'}`,
          name: 'perkins_submit_findings',
          args: { findings: childFindings },
        },
      };
    });
    const repo = makeFixtureRepo('pi-perkins-hybrid');
    let registry: RuntimeRegistry | null = null;
    const owned: AgentHandle[] = [];
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    try {
      const frozen = freezeReviewInputs({
        roundId: 'pi-hybrid-round', repoPath: repo.path, artifactRoot: join(fx.home, 'review-artifacts'),
        baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'Acceptance: answer returns 43.',
      });
      registry = new RuntimeRegistry({
        config: fx.config,
        store: fx.store,
        pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime },
      });
      const engine = new PerkinsHybridReview({
        spawner: async (role, options) => {
          const handle = await registry!.spawn(role, options);
          owned.push(handle);
          return handle;
        },
        policy: loadPerkinsPolicy(),
      });
      const result = await engine.run({
        roundId: 'pi-hybrid-round', roundNumber: 1, frozenReview: frozen,
        movementRef: 'feature/review', noSpec: false,
      });
      expect(result.canonicalVerdict).toBe('READY TO MERGE');
      expect(result.completeness).toMatchObject({ requiredLensRuns: 7, validLensRuns: 7 });
      expect(leadTurns).toBe(4);
      expect(fx.script.calls.filter((call) => !call.prompt.includes('REQUIRED CHILD COVERAGE'))).toHaveLength(7);
      expect(result.findings).toHaveLength(1);
      expect(owned).toHaveLength(8);
      expect(new Set(owned.map((handle) => handle.id)).size).toBe(8);
      expect(new Set(owned.map((handle) => handle.sessionFile)).size).toBe(8);
      expect(owned.every((handle) => handle.reviewIsolation === true)).toBe(true);
      expect(registry.status().activeSessions).toBe(0);
    } finally {
      await registry?.dispose();
      await fx.runtime.dispose();
      repo.cleanup();
    }
  });

  it('confines isolated-review read tools to the review working directory', async () => {
    const fx = await fixture();
    const outsideDir = mkdtempSync(join(tmpdir(), 'pi-review-outside-'));
    cleanupDirs.push(outsideDir);
    const outside = join(outsideDir, 'secret.txt');
    writeFileSync(outside, 'must not be readable', 'utf8');
    const linkedOutside = join(fx.workspace, 'linked-secret.txt');
    symlinkSync(outside, linkedOutside);
    const handle = await fx.runtime.spawn('perkins', {
      cwd: fx.workspace,
      isolatedReview: { systemPrompt: 'isolated policy', tools: ['read'] },
    });
    try {
      const options = twinGate.lastOptions as {
        tools?: string[];
        customTools?: Array<{ execute(...args: unknown[]): Promise<unknown> }>;
      };
      expect(options.tools).toEqual(['review_read']);
      expect(options.customTools).toHaveLength(1);
      const inside = join(fx.workspace, 'inside-review.txt');
      writeFileSync(inside, 'inside review canary', 'utf8');
      await expect(options.customTools![0]!.execute('call', { path: inside }, undefined, undefined, { cwd: fx.workspace }))
        .resolves.toSatisfy((result: unknown) => JSON.stringify(result).includes('inside review canary'));
      await expect(options.customTools![0]!.execute('call', { path: outside }, undefined, undefined, { cwd: fx.workspace }))
        .rejects.toThrow(/escapes the review working directory/);
      await expect(options.customTools![0]!.execute('call', { path: linkedOutside }, undefined, undefined, { cwd: fx.workspace }))
        .rejects.toThrow(/escapes the review working directory/);
    } finally {
      await handle.dispose();
    }
  });

  it('injects exactly the declared native tools into an isolated lens session, in-process', async () => {
    const fx = await fixture([
      {
        deltas: [],
        toolCall: { id: 'submit-1', name: 'perkins_submit_findings', args: { findings: [{ title: 'candidate' }] } },
      },
      { deltas: ['lens done'] },
    ]);
    const executions: unknown[] = [];
    const submitFindings = {
      name: 'perkins_submit_findings',
      description: 'submit structured lens findings',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['findings'],
        properties: { findings: { type: 'array', items: { type: 'object' } } },
      },
      execute: async (input: unknown) => {
        executions.push(input);
        return { text: JSON.stringify({ accepted: true }), details: { accepted: true } };
      },
    };
    const handle = await fx.runtime.spawn('perkins', {
      cwd: fx.workspace,
      isolatedReview: {
        systemPrompt: 'isolated lens policy',
        tools: ['read', 'grep', 'find', 'ls'],
        nativeTools: [submitFindings],
      },
    });
    try {
      const options = twinGate.lastOptions as {
        tools?: string[];
        customTools?: Array<{ name: string }>;
      };
      // The declared set is exposed EXACTLY: confined read tools plus the one
      // declared native tool — never the lead's orchestration tools.
      expect(options.tools).toEqual([
        'review_read',
        'review_grep',
        'review_find',
        'review_ls',
        'perkins_submit_findings',
      ]);
      expect(options.customTools!.map((tool) => tool.name)).toEqual([
        'review_read',
        'review_grep',
        'review_find',
        'review_ls',
        'perkins_submit_findings',
      ]);
      expect(options.customTools!.some((tool) => tool.name === 'perkins_run_lenses')).toBe(false);
      // The session really calls the injected callback: the stub model emits
      // the tool call, the SDK executes it, and the next turn sees the result.
      await handle.prompt('submit the lens findings');
      expect(executions).toEqual([{ findings: [{ title: 'candidate' }] }]);
      expect(fx.script.calls).toHaveLength(2);
      expect(fx.script.calls[1]!.prompt).toContain('[TOOL_RESULT perkins_submit_findings]');
      expect(fx.script.calls[1]!.prompt).toContain('{"accepted":true}');
    } finally {
      await handle.dispose();
    }
  });

  it('rejects resume for isolated reviews so ambient history cannot cross the boundary', async () => {
    const fx = await fixture();
    const ordinary = await fx.runtime.spawn('perkins');
    const file = ordinary.sessionFile!;
    await ordinary.dispose();
    await expect(fx.runtime.spawn('perkins', {
      resumeFile: file,
      isolatedReview: { systemPrompt: 'isolated', tools: [] },
    })).rejects.toThrow(/must be fresh/);
  });

  it('round-trips a prompt with ordered deltas, turn lifecycle, and a durable session file', async () => {
    const fx = await fixture([{ deltas: ['Hello', ' ', 'world'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('say hi', { owner: 'alice' });
      const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);
      expect(deltas).toEqual(['Hello', ' ', 'world']);
      expect(events.filter((e) => e.type === 'turn_start').length).toBe(1);
      expect(events.filter((e) => e.type === 'turn_end').length).toBe(1);
      const states = events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
      expect(states).toContain('streaming');
      expect(states[states.length - 1]).toBe('idle');
      expect(handle.health().lastActivity).not.toBeNull();
      // Durable jsonl: header + user message + assistant message, at least.
      const lines = readFileSync(handle.sessionFile!, 'utf-8').trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      const header = JSON.parse(lines[0]!) as { type: string; cwd: string };
      expect(header.type).toBe('session');
      expect(header.cwd).toBe(fx.workspace);
    } finally {
      await handle.dispose();
    }
  });

  it('exposes native context usage and a failed native compact keeps the same session usable', async () => {
    const fx = await fixture([{ deltas: ['one'] }, { deltas: ['two'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('first turn');
      const usage = handle.getContextUsage?.();
      const nativeUsage = (
        handle as unknown as {
          session: {
            getContextUsage(): {
              tokens: number | null;
              contextWindow: number;
              percent: number | null;
            } | undefined;
          };
        }
      ).session.getContextUsage();
      expect(usage).not.toBeNull();
      expect(nativeUsage?.tokens).not.toBeNull();
      expect(nativeUsage?.percent).not.toBeNull();
      expect(usage).toEqual({
        tokens: nativeUsage?.tokens,
        contextWindow: nativeUsage?.contextWindow,
        percent: Math.max(0, Math.min(100, nativeUsage!.percent!)),
      });
      expect(handle.canCompact?.()).toBe(true);
      const id = handle.id;
      const file = handle.sessionFile;
      await expect(handle.compact?.()).rejects.toThrow(/Nothing to compact|Already compacted/);
      expect(handle.id).toBe(id);
      expect(handle.sessionFile).toBe(file);
      expect(events.some((event) => event.type === 'compaction_start')).toBe(true);
      expect(
        events.some((event) => event.type === 'compaction_end' && !event.success),
      ).toBe(true);
      await handle.prompt('still usable');
      expect(fx.script.calls.map((call) => call.prompt)).toContain('still usable');
    } finally {
      await handle.dispose();
    }
  });

  it('successfully compacts through the installed Pi SDK without changing session identity', async () => {
    const fx = await fixture([
      { deltas: ['first answer'] },
      { deltas: ['second answer'] },
      { deltas: ['## Goal\nKeep the tested conversation usable.'] },
      { deltas: ['after compact'] },
    ]);
    writeFileSync(
      join(fx.agentDir, 'settings.json'),
      `${JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 100 } })}\n`,
      'utf-8',
    );
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('first turn');
      await handle.prompt('second turn');
      const id = handle.id;
      const file = handle.sessionFile;
      await handle.compact?.();
      expect(handle.id).toBe(id);
      expect(handle.sessionFile).toBe(file);
      expect(events.some((event) => event.type === 'compaction_end' && event.success)).toBe(true);
      expect(
        readFileSync(file!, 'utf-8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { type?: string })
          .some((entry) => entry.type === 'compaction'),
      ).toBe(true);
      // Pi deliberately withholds post-compaction usage until another model response.
      expect(handle.getContextUsage?.()).toBeNull();
      await handle.prompt('continue after compact');
      expect(handle.getContextUsage?.()).not.toBeNull();

      type InternalSession = {
        compact(): Promise<unknown>;
        readonly sessionId: string;
        readonly sessionFile: string | undefined;
        readonly isIdle: boolean;
        readonly isCompacting: boolean;
      };
      const internal = handle as unknown as { session: InternalSession };
      const nativeSession = internal.session;
      let release!: () => void;
      const heldSession = new Proxy(nativeSession, {
        get(target, key) {
          if (key === 'compact') {
            return () => new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return Reflect.get(target, key, target);
        },
      });
      internal.session = heldSession;
      const compacting = handle.compact!();
      expect(handle.isCompacting?.()).toBe(true);
      await expect(handle.compact?.()).rejects.toThrow(/busy/);
      await expect(handle.prompt('must not overlap')).rejects.toThrow(/compacting/);
      release();
      await expect(compacting).rejects.toThrow(/without a terminal event/);

      internal.session = new Proxy(nativeSession, {
        get(target, key) {
          if (key === 'compact') return async () => {};
          if (key === 'sessionId') return 'foreign-session-id';
          return Reflect.get(target, key, target);
        },
      });
      await expect(handle.compact?.()).rejects.toThrow(/changed session identity/);
      expect(handle.health().state).toBe('disposed');
      internal.session = nativeSession;
    } finally {
      await handle.dispose();
    }
  });

  it('resolves native compaction terminal failure when dispose races compact', async () => {
    const fx = await fixture([{ deltas: ['first answer'] }]);
    const handle = await fx.runtime.spawn('gru');
    const events = collect(handle);
    type InternalSession = {
      compact(): Promise<unknown>;
      dispose(): void;
      readonly sessionId: string;
      readonly sessionFile: string | undefined;
      readonly isIdle: boolean;
      readonly isCompacting: boolean;
    };
    const internal = handle as unknown as { session: InternalSession };
    const nativeSession = internal.session;
    let release!: () => void;
    internal.session = new Proxy(nativeSession, {
      get(target, key) {
        if (key === 'compact') {
          return () => new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Reflect.get(target, key, target);
      },
    });
    const compacting = handle.compact!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const disposing = handle.dispose();
    release();
    await expect(compacting).rejects.toThrow(/disposed during native compaction/);
    await disposing;
    expect(
      events.filter((event) => event.type === 'compaction_end' && !event.success),
    ).toHaveLength(1);
  });

  it('emits thinking deltas before text when the model reasons', async () => {
    const fx = await fixture([{ thinking: ['pondering'], deltas: ['answer'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('think hard');
      const kinds = events
        .filter((e) => e.type === 'thinking_delta' || e.type === 'text_delta')
        .map((e) => e.type);
      expect(kinds).toEqual(['thinking_delta', 'text_delta']);
    } finally {
      await handle.dispose();
    }
  });

  it('single-writer: a second owner while a turn is live queues, then delivers in order', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([
      { deltas: ['first-turn'], hold },
      { deltas: ['second-turn'] },
    ]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      const alice = handle.prompt('q1', { owner: 'alice' });
      const bob = handle.prompt('q2', { owner: 'bob' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['q1']);
      expect(events.some((e) => e.type === 'queued' && e.owner === 'bob')).toBe(true);
      release();
      await Promise.all([alice, bob]);
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['q1', 'q2']);
      // Turns never interleave: bob's turn starts strictly after alice's ends.
      const turnEnds = events.filter((e) => e.type === 'turn_end').length;
      const stateIdleAfterFirst = events.some((e) => e.type === 'state' && (e as { state: string }).state === 'idle');
      expect(turnEnds).toBe(2);
      expect(stateIdleAfterFirst).toBe(true);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('pi queue honors opt-in timeoutMs: the caller rejects, the queue survives', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([
      { deltas: ['first'], hold },
      { deltas: ['later'] },
    ]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const alice = handle.prompt('q1', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const impatient = handle.prompt('q-impatient', { owner: 'bob', timeoutMs: 20 });
      const patient = handle.prompt('q-patient', { owner: 'carol' });
      await expect(impatient).rejects.toThrow(/queued wait timed out after 20ms/);
      release();
      await Promise.all([alice, patient]);
      // The timed-out caller never reached the model; the patient one did.
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['q1', 'q-patient']);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it("owner steer and followUp during the owner's live turn pass through natively", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['base'], hold }, { deltas: ['steer'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      const alice = handle.prompt('go', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Owner channels: no queueing, no throw.
      await handle.steer('adjust course', { owner: 'alice' });
      await handle.followUp('then summarize', { owner: 'alice' });
      release();
      await alice;
      // No single-writer queue events: owner channels are native.
      expect(events.some((e) => e.type === 'queued')).toBe(false);
      // The steering/followUp texts reach the model as delivered user turns
      // (pi delivers them after the in-flight tool call window).
      const delivered = fx.script.calls.map((c) => c.prompt);
      expect(delivered[0]).toBe('go');
      expect(delivered).toContain('adjust course');
      expect(delivered).toContain('then summarize');
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('non-owner steer while live queues instead of interleaving', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['a'], hold }, { deltas: ['b'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const alice = handle.prompt('mine', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const bobSteer = handle.steer('bob tries', { owner: 'bob' });
      release();
      await Promise.all([alice, bobSteer]);
      // bob's steer became a queued follow-on prompt, delivered after idle.
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['mine', 'bob tries']);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('resumes a previous session file with history intact (process restart)', async () => {
    const fx = await fixture([{ deltas: ['first'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('remember this', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    const entriesBefore = readFileSync(file, 'utf-8').trim().split('\n').length;

    // "New process": same instance data dir, fresh store + adapter.
    const config = loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester');
    const secondStore = new SessionStore(config.dataDir);
    const second = new PiRuntime({
      config,
      store: secondStore,
      agentDir: fx.agentDir,
      modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['second'] }])),
    });
    const resumed = await second.spawn('gru', { resumeFile: file });
    try {
      expect(resumed.sessionFile).toBe(file); // same file, no duplicate session
      await resumed.prompt('continue', { owner: 'alice' });
      const entriesAfter = readFileSync(file, 'utf-8').trim().split('\n').length;
      expect(entriesAfter).toBeGreaterThan(entriesBefore);
    } finally {
      await resumed.dispose();
    }
  });

  it('fails loud on an unknown model reference', async () => {
    const fx = await fixture([], ['text'], {
      configExtra: '[runtimes.pi]\nmodel_refresh = false\n',
    });
    await expect(fx.runtime.spawn('gru', { model: 'nope/no-such-model' })).rejects.toThrow(
      /unknown model "nope\/no-such-model"/,
    );
  });

  it('resolves a live-catalog model through ONE bounded refresh (deepseek-flash shape)', async () => {
    // Reproduces the owner report: the offline catalog misses the model
    // (`getModel` returns undefined) while the live catalog has it. The
    // adapter must refresh once, re-resolve, and spawn — without ever
    // putting the network on the healthy-spawn path.
    const refresher = vi.fn(async () => ({
      attempted: true,
      detail: 'completed within the 10000 ms budget',
    }));
    const fx = await fixture([{ deltas: ['live catalog model'] }], ['text'], {
      modelCatalogRefresh: refresher,
    });
    const original = fx.modelRuntime.getModel.bind(fx.modelRuntime);
    const getModel = vi
      .spyOn(fx.modelRuntime, 'getModel')
      .mockImplementationOnce(() => undefined)
      .mockImplementation((provider, modelId) => original(provider, modelId));
    try {
      const handle = await fx.runtime.spawn('gru', { model: 'gru-stub/stub-model' });
      try {
        const events = collect(handle);
        await handle.prompt('live check', { owner: 'alice' });
        expect(
          events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta),
        ).toEqual(['live catalog model']);
      } finally {
        await handle.dispose();
      }
      expect(refresher).toHaveBeenCalledTimes(1);
      expect(refresher).toHaveBeenCalledWith(fx.modelRuntime, {
        provider: 'gru-stub',
        timeoutMs: 10_000,
      });
    } finally {
      getModel.mockRestore();
    }
  });

  it('healthy resolutions never touch the catalog refresh path (no added latency)', async () => {
    const refresher = vi.fn(async () => ({ attempted: true, detail: 'must not run' }));
    const fx = await fixture([{ deltas: ['ok'] }], ['text'], { modelCatalogRefresh: refresher });
    const handle = await fx.runtime.spawn('gru');
    await handle.dispose();
    expect(refresher).not.toHaveBeenCalled();
  });

  it('unknown-model errors name the model, the refresh outcome, and the near matches', async () => {
    const refresher = vi.fn(async () => ({
      attempted: true,
      detail: 'completed within the 10000 ms budget',
    }));
    const fx = await fixture([], ['text'], { modelCatalogRefresh: refresher });
    const error = await rejection(
      fx.runtime.spawn('gru', { model: 'gru-stub/no-such-model' }),
    );
    expect(error.message).toContain('unknown model "gru-stub/no-such-model"');
    expect(error.message).toContain(
      'catalog refresh attempted — completed within the 10000 ms budget',
    );
    expect(error.message).toContain('nearest registered models for "gru-stub": stub-model');
    expect(refresher).toHaveBeenCalledTimes(1);
  });

  it('reports a skipped refresh when [runtimes.pi] model_refresh = false', async () => {
    const refresher = vi.fn(async () => {
      throw new Error('must not run');
    });
    const fx = await fixture([], ['text'], {
      modelCatalogRefresh: refresher,
      configExtra: '[runtimes.pi]\nmodel_refresh = false\n',
    });
    const error = await rejection(fx.runtime.spawn('gru', { model: 'nope/whatever' }));
    expect(error.message).toContain('unknown model "nope/whatever"');
    expect(error.message).toContain('catalog refresh skipped ([runtimes.pi] model_refresh = false)');
    expect(error.message).toContain('provider "nope" is not registered');
    expect(refresher).not.toHaveBeenCalled();
  });

  it('bounds the network refresh with model_refresh_timeout_ms', async () => {
    const fx = await fixture([], ['text'], {
      configExtra: '[runtimes.pi]\nmodel_refresh_timeout_ms = 25\n',
    });
    const refresh = vi.spyOn(fx.modelRuntime, 'refresh').mockImplementation(
      (options) =>
        new Promise((resolve) => {
          const signal = options?.signal;
          const settle = (): void => resolve({ aborted: true, errors: new Map<string, Error>() });
          if (signal?.aborted === true) settle();
          else signal?.addEventListener('abort', settle);
        }),
    );
    try {
      const startedAt = Date.now();
      const error = await rejection(fx.runtime.spawn('gru', { model: 'gru-stub/live-only' }));
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(error.message).toContain('timed out after 25 ms');
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith(
        expect.objectContaining({ allowNetwork: true, providers: ['gru-stub'] }),
      );
    } finally {
      refresh.mockRestore();
    }
  });

  it('accepts an explicit thinking level and fails loud on an invalid one (ruling 16)', async () => {
    const fx = await fixture([{ deltas: ['ok'] }]);
    const handle = await fx.runtime.spawn('gru', { thinkingLevel: 'high' });
    await handle.dispose();
    await expect(fx.runtime.spawn('gru', { thinkingLevel: 'banana' })).rejects.toThrow(
      /unknown thinking level "banana" for pi/,
    );
  });

  it('the "default" model sentinel passes through to the runtime harness', async () => {
    // No [models] default configured: policy resolves to "default", which
    // means "whatever pi itself would pick". pi's own resolution reads the
    // settings default — so we point the harness default at the stub
    // provider and prove the full passthrough path end-to-end.
    const fx = await fixture([{ deltas: ['passthrough'] }]);
    writeFileSync(
      join(fx.agentDir, 'settings.json'),
      `${JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' })}\n`,
      'utf-8',
    );
    const handle = await fx.runtime.spawn('gru', { model: 'default' });
    try {
      const events = collect(handle);
      await handle.prompt('sentinel check', { owner: 'alice' });
      expect(
        events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta),
      ).toEqual(['passthrough']);
    } finally {
      await handle.dispose();
    }
  });

  it('the sentinel path fails LOUD when nothing is configured (no silent fallback)', async () => {
    // Stub-FREE isolated runtime: no provider is configured at all, so the
    // "default" sentinel resolves to nothing and prompt fails loudly
    // instead of silently rerouting to some other model.
    const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
    cleanupDirs.push(home, workspace, agentDir);
    writeFileSync(
      configPathFor(home),
      `workspace_root = "${workspace}"\n`,
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const runtime = new PiRuntime({
      config,
      store,
      agentDir,
      modelRuntime: await makeIsolatedModelRuntime(),
    });
    const handle = await runtime.spawn('gru', { model: 'default' });
    await expect(handle.prompt('anyone there?', { owner: 'alice' })).rejects.toThrow(
      /No API key found for the selected model|no models available/i,
    );
    await handle.dispose();
  });

  it('resolves the settings default eagerly when the auth snapshot is stale (2026-09-20 probe shape)', async () => {
    // User report: chat + Bob consolidation died with "No API key found for
    // the selected model" although the user's settings and auth were valid.
    // The shared offline ModelRuntime (refreshOnCreate: false) never builds
    // its auth snapshot, so pi's own settings-default path — gated on
    // hasConfiguredAuth() — rejected the user's configured default and fell
    // through to "first available"/nothing. The adapter must resolve the
    // settings default ITSELF and pass the explicit model. Hermetic repro:
    // stub runtime with a COLD auth cache — hasConfiguredAuth() is false
    // for every provider, exactly like the user's runtime; prompting an
    // explicitly-passed model still works (probe P2).
    const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
    cleanupDirs.push(home, workspace, agentDir);
    // No [models] section: the product path resolves the "default" sentinel.
    writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
    writeFileSync(
      join(agentDir, 'settings.json'),
      `${JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' })}\n`,
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const logs: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const runtime = new PiRuntime({
      config,
      store,
      agentDir,
      modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['settings default'] }]), {
        refreshAuthCache: false,
      }),
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
    });
    const handle = await runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('sentinel check', { owner: 'alice' });
      expect(
        events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta),
      ).toEqual(['settings default']);
      // Spawn logs the RESOLVED model so future complaints name the model.
      const spawnLog = logs.find((l) => l.msg.includes('model resolved'));
      expect(spawnLog).toBeDefined();
      expect(spawnLog?.level).toBe('info');
      expect(spawnLog?.fields?.['model']).toBe('gru-stub/stub-model');
    } finally {
      await handle.dispose();
    }
  });

  it('fails loud when the settings default names an unregistered model', async () => {
    // A settings default that misses the catalog must never silently
    // reroute to "first available" (the 2026-09-20 bug shape); it names
    // the stale reference like the explicit path does — plus the refresh
    // outcome and the nearest registered alternatives.
    const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
    cleanupDirs.push(home, workspace, agentDir);
    writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
    writeFileSync(
      join(agentDir, 'settings.json'),
      `${JSON.stringify({ defaultProvider: 'nope', defaultModel: 'no-such-model' })}\n`,
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const runtime = new PiRuntime({
      config,
      store,
      agentDir,
      modelRuntime: await makeStubModelRuntime(new StubScript([]), { refreshAuthCache: false }),
      modelCatalogRefresh: async () => ({
        attempted: true,
        detail: 'failed (no network in tests)',
      }),
    });
    const error = await rejection(runtime.spawn('gru'));
    expect(error.message).toContain('settings default "nope/no-such-model" is not a registered model');
    expect(error.message).toContain('catalog refresh attempted — failed (no network in tests)');
    expect(error.message).toContain('provider "nope" is not registered');
    expect(error.message).toContain(join(agentDir, 'settings.json'));
  });

  it('dispose releases the session lock', async () => {
    const fx = await fixture();
    const handle = await fx.runtime.spawn('gru');
    const file = handle.sessionFile!;
    await handle.dispose();
    const fresh = new SessionStore(fx.store.dataDir);
    expect(() => fresh.acquireLock(file)).not.toThrow();
    fresh.releaseLock(file);
    expect(handle.health().state).toBe('disposed');
  });

  it('declares pi capabilities honestly in the matrix', async () => {
    const fx = await fixture();
    expect(fx.runtime.capabilities).toEqual({
      streaming: true,
      steer: 'native',
      resume: 'file',
      images: true,
      thinking: true,
      thinkingLevelControl: true,
      followUp: true,
    });
    expect(fx.runtime.health()).toEqual({ state: 'ok' });
    // Model metadata cannot grant a modality the adapter transport lacks.
    expect(
      capabilitiesForModelInput({ ...fx.runtime.capabilities, images: false }, ['text', 'image']).images,
    ).toBe(false);
  });

  it('B1 fails-pre-fix discriminator: a text-only resolved model makes the spawned handle vision-incapable', async () => {
    const fx = await fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      expect(handle.capabilities.images).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it('B1 positive discriminator: an image-capable resolved model keeps vision enabled and transports images', async () => {
    const fx = await fixture([{ deltas: ['seen'] }], ['text', 'image']);
    const handle = await fx.runtime.spawn('gru');
    try {
      expect(handle.capabilities.images).toBe(true);
      await handle.prompt('look at this', {
        owner: 'alice',
        images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
      });
      expect(fx.script.calls.length).toBe(1);
      expect(fx.script.calls[0]!.imageCount).toBe(1);
    } finally {
      await handle.dispose();
    }
  });

  it('unnamed steer queues behind a NAMED owner (handle principal is not an alias)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['a'], hold }, { deltas: ['b'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const alice = handle.prompt('mine', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // An UNNAMED steer while alice's turn is live: not alice's channel.
      const anon = handle.steer('anonymous nudge');
      release();
      await Promise.all([alice, anon]);
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['mine', 'anonymous nudge']);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('unnamed steer during the handle OWN turn passes natively (one brain per session)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['a'], hold }, { deltas: ['steered'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const first = handle.prompt('mine');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await handle.steer('course correct');
      release();
      await first;
      // steered natively — the follow-up arrives as its own model turn
      expect(fx.script.calls.map((c) => c.prompt)).toContain('course correct');
    } finally {
      release();
      await handle.dispose();
    }
  });
});

describe('RuntimeRegistry', () => {
  it('boots with growth detection, resolves roles to the configured runtime, and reports status', async () => {
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      pi: {
        agentDir: fx.agentDir,
        modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['ok'] }])),
      },
    });
    const growth = registry.boot();
    expect(growth.findings).toEqual([]);
    expect(growth.snapshotState).toBe('missing'); // first boot ever
    expect(registry.runtimeIdFor('gru')).toBe('pi');
    expect(registry.runtimeIdFor('minion')).toBe('pi');

    const before = registry.status();
    expect(before.agentSession.state).toBe('no-session');
    expect(before.activeSessions).toBe(0);
    expect(before.adapters).toEqual([]); // adapters are created lazily

    const handle = await registry.spawn('gru');
    try {
      await handle.prompt('status check', { owner: 'alice' });
      const after = registry.status();
      expect(after.agentSession.state).toBe('idle');
      expect(after.agentSession.lastActivity).not.toBeNull();
      expect(after.activeSessions).toBe(1);
      expect(after.adapters).toEqual([{ id: 'pi', state: 'ok' }]);
    } finally {
      await registry.disposeHandle(handle);
    }
    expect(registry.status().activeSessions).toBe(0);
    await registry.dispose();
  });

  it('forwards isolatedReview through the production registry to the adapter', async () => {
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: fx.config,
      store: fx.store,
      pi: { agentDir: fx.agentDir, modelRuntime: fx.modelRuntime },
    });
    registry.boot();
    const handle = await registry.spawn('perkins', {
      isolatedReview: { systemPrompt: 'registry-isolated-policy', tools: [] },
    });
    try {
      const options = twinGate.lastOptions as {
        noTools?: string;
        resourceLoader: { getSystemPrompt(): string | undefined; getSkills(): { skills: unknown[] } };
      };
      expect(options.noTools).toBe('all');
      expect(options.resourceLoader.getSystemPrompt()).toBe('registry-isolated-policy');
      expect(options.resourceLoader.getSkills().skills).toEqual([]);
    } finally {
      await registry.disposeHandle(handle);
      await registry.dispose();
    }
  });

  it('resolves claude-code to a fallback-wrapped adapter and still rejects unknown ids', () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), 'gru-command-reg-')));
    cleanupDirs.push(store.dataDir);
    // Minimal config stand-in: the registry only reads runtimes for this
    // path; constructing the claude-code adapter must not touch disk or
    // probe the binary (that happens lazily at spawn).
    const registry = new RuntimeRegistry({
      config: { runtimes: { default: 'pi', roles: {} } } as never,
      store,
    });
    // Pre-E3 this threw "no adapter implementation yet" (red → green flip):
    const adapter = registry.runtimeFor('claude-code');
    expect(adapter.id).toBe('claude-code');
    expect(adapter.capabilities.steer).toBe('queued'); // fallback-wrapped
    expect(() => registry.runtimeFor('bogus' as never)).toThrow(/unknown runtime/);
  });

  it('self-heals: a handle disposed directly leaves the registry set', async () => {
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      pi: {
        agentDir: fx.agentDir,
        modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['ok'] }])),
      },
    });
    registry.boot();
    const handle = await registry.spawn('gru');
    expect(registry.status().activeSessions).toBe(1);
    await handle.dispose(); // direct dispose, NOT registry.disposeHandle
    expect(registry.status().activeSessions).toBe(0);
    expect(registry.status().agentSession.state).toBe('no-session');
    await registry.dispose();
  });

  it('thinking fallback: a control-less adapter gets warn + default (ruling 16)', () => {
    const warns: string[] = [];
    const fakeAdapter = {
      id: 'fake',
      capabilities: {
        streaming: true,
        steer: 'queued' as const,
        resume: 'none' as const,
        images: false,
        thinking: false,
        thinkingLevelControl: false,
        followUp: false,
      },
    };
    const log = (level: string, msg: string) => {
      if (level === 'warn') warns.push(msg);
    };
    expect(applyThinkingFallback(fakeAdapter as never, 'high', log)).toBe('default');
    expect(warns.length).toBe(1);
    expect(warns[0]!).toContain('cannot set thinking level');
    // The sentinel and capable adapters pass through untouched:
    expect(applyThinkingFallback(fakeAdapter as never, 'default', log)).toBe('default');
    const capable = {
      id: 'capable',
      capabilities: { ...fakeAdapter.capabilities, thinkingLevelControl: true },
    };
    expect(applyThinkingFallback(capable as never, 'max', log)).toBe('max');
  });
});

describe('Perkins r1 regressions', () => {
  it('B3: images round-trip in the EXACT SDK shape (data + mimeType)', async () => {
    const fx = await fixture([{ deltas: ['seen'] }], ['text', 'image']);
    const handle = await fx.runtime.spawn('gru');
    try {
      await handle.prompt('look', {
        owner: 'alice',
        images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
      });
      expect(fx.script.calls[0]!.images).toEqual([
        { data: 'aGVsbG8=', mimeType: 'image/png' },
      ]);
    } finally {
      await handle.dispose();
    }
  });

  it('W6: tool lifecycle events map through (tool_start/tool_end with callId)', async () => {
    const fx = await fixture([
      { deltas: [], toolCall: { id: 'call-1', name: 'ls', args: {} } },
      { deltas: ['listed'] },
    ]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('list my files', { owner: 'alice' });
      const starts = events.filter((e) => e.type === 'tool_start') as {
        callId: string;
        tool: string;
      }[];
      expect(starts).toEqual([{ type: 'tool_start', callId: 'call-1', tool: 'ls' }] as never);
      const ends = events.filter((e) => e.type === 'tool_end') as {
        callId: string;
        isError: boolean;
      }[];
      expect(ends.length).toBe(1);
      expect(ends[0]!.callId).toBe('call-1');
      expect(typeof ends[0]!.isError).toBe('boolean');
      // The second model call (post-tool) delivered the text:
      expect(fx.script.calls.length).toBe(2);
    } finally {
      await handle.dispose();
    }
  });

  it('E7 follow-up: a long quiet bash run heartbeats and reports a live process', async () => {
    const fx = await fixture([
      { deltas: [], toolCall: { id: 'call-quiet', name: 'bash', args: { command: 'sleep 0.3' } } },
      { deltas: ['quiet tool done'] },
    ]);
    // Short heartbeat cadence: the production derivation is exercised by
    // tool-heartbeat.test.ts; this proves the pi wiring end to end.
    const runtime = new PiRuntime({
      config: fx.config,
      store: fx.store,
      agentDir: fx.agentDir,
      modelRuntime: fx.modelRuntime,
      toolHeartbeatMs: 40,
    });
    const handle = await runtime.spawn('gru');
    try {
      const events = collect(handle);
      const turn = handle.prompt('run the quiet tool', { owner: 'alice' });
      // The quiet bash child is the live-process probe's evidence.
      await vi.waitFor(() => expect(handle.hasLiveProcess?.()).toBe(true));
      await turn;
      expect(handle.hasLiveProcess?.()).toBe(false);
      const heartbeats = events.filter(
        (event) => event.type === 'tool_update' && event.callId === 'call-quiet',
      );
      // The bash tool itself emits only its empty start update; the
      // periodic still-running updates prove the heartbeat fired.
      expect(heartbeats.length).toBeGreaterThanOrEqual(3);
    } finally {
      await handle.dispose();
      await runtime.dispose();
    }
  });

  it('W7: error turn — in-band completion: error event + state error, then recovers', async () => {
    const fx = await fixture([{ deltas: [], error: 'model exploded' }, { deltas: ['recovered'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      // The SDK contract: failures AFTER acceptance surface through the
      // event/message stream, not a rejection — prompt() resolves, the
      // error is in-band, and the session stays usable (robustness, R3).
      await handle.prompt('boom', { owner: 'alice' });
      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect((errorEvents[0] as { error: string }).error).toContain('model exploded');
      expect(handle.health().state).toBe('error');
      expect(handle.health().error).toBeTruthy();
      // The handle recovers: next prompt works and ends idle.
      await handle.prompt('again', { owner: 'alice' });
      expect(handle.health().state).toBe('idle');
      const states = events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
      expect(states).toContain('error');
      expect(states[states.length - 1]).toBe('idle');
    } finally {
      await handle.dispose();
    }
  });

  it('W10: registry status aggregates streaming while a turn is live', async () => {
    let release!: () => void;
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      pi: {
        agentDir: fx.agentDir,
        modelRuntime: await makeStubModelRuntime(
          new StubScript([{ deltas: ['held'], hold: new Promise<void>((r) => (release = r)) }]),
        ),
      },
    });
    registry.boot();
    const handle = await registry.spawn('gru');
    const p = handle.prompt('hold it', { owner: 'alice' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(registry.status().agentSession.state).toBe('streaming');
    expect(registry.status().agentSession.lastActivity).not.toBeNull();
    release();
    await p;
    expect(registry.status().agentSession.state).toBe('idle');
    await registry.dispose();
  });

  it('B4: double-resume of one session file in one process is rejected loudly', async () => {
    const fx = await fixture([{ deltas: ['one'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write something', { owner: 'alice' });
    const file = first.sessionFile!;
    await expect(fx.runtime.spawn('gru', { resumeFile: file })).rejects.toThrow(
      /already hosted by this process/,
    );
    // After the first handle disposes, the file can be re-hosted.
    await first.dispose();
    const resumed = await fx.runtime.spawn('gru', { resumeFile: file });
    await resumed.dispose();
  });

  it('N16: resume of a file locked by another process rejects without touching the file', async () => {
    const fx = await fixture([{ deltas: ['one'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    // Another "process" (fresh store instance, own bootId) holds the lock:
    const other = new SessionStore(fx.store.dataDir);
    other.acquireLock(file);
    const linesBefore = readFileSync(file, 'utf-8').split('\n').length;
    try {
      await expect(fx.runtime.spawn('gru', { resumeFile: file })).rejects.toThrow(/locked by pid/);
      expect(readFileSync(file, 'utf-8').split('\n').length).toBe(linesBefore);
      expect(existsSync(`${file}.lock`)).toBe(true); // theirs, intact
    } finally {
      other.releaseLock(file);
      other.dispose();
    }
  });

  it('N24: resumeFile outside the session store is refused', async () => {
    const fx = await fixture([]);
    await expect(
      fx.runtime.spawn('gru', { resumeFile: join(fx.home, 'elsewhere.jsonl') }),
    ).rejects.toThrow(/must live under the session store/);
  });

  it('N17: adapter health goes down on infrastructure failure and recovers', async () => {
    const fx = await fixture([{ deltas: ['ok'] }], ['text'], {
      configExtra: '[runtimes.pi]\nmodel_refresh = false\n',
    });
    // Poison the sessions dir for the gru role: a FILE where the dir must be.
    const roleDir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(join(roleDir, '..'), { recursive: true });
    writeFileSync(roleDir, 'not a dir', 'utf-8');
    await expect(fx.runtime.spawn('gru')).rejects.toThrow();
    expect(fx.runtime.health().state).toBe('down');
    // Next attempt clears it:
    rmSync(roleDir);
    const handle = await fx.runtime.spawn('gru');
    expect(fx.runtime.health().state).toBe('ok');
    await handle.dispose();
    // And validation errors (bad model refs) never latch 'down':
    await expect(fx.runtime.spawn('gru', { model: 'nope/nope' })).rejects.toThrow(/unknown model/);
    expect(fx.runtime.health().state).toBe('ok');
  });
});

describe('Perkins r1 boot-surface pins', () => {
  it('N12/N13: boot backs up tracked sessions and logs grown files with kind + byte delta', async () => {
    const fx = await fixture();
    // Seed a session file, snapshot it, then grow it "while down":
    const dir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '2026-09-15T00-00-00-000Z_11111111-1111-1111-1111-111111111111.jsonl');
    writeFileSync(file, '{"type":"session","version":3}\n', 'utf-8');
    fx.store.persistSnapshot();
    writeFileSync(file, '{"type":"session","version":3}\n{"type":"message"}\n', 'utf-8');

    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
      pi: { agentDir: fx.agentDir, modelRuntime: await makeStubModelRuntime(new StubScript([])) },
    });
    const growth = registry.boot();
    expect(growth.findings.length).toBe(1);
    expect(growth.findings[0]!.kind).toBe('grew');
    // N13: the warn log names file + kind + byte delta:
    const warn = logs.find((l) => l.level === 'warn' && l.msg.includes('changed while service was down'));
    expect(warn).toBeDefined();
    expect(warn!.fields).toMatchObject({ file, kind: 'grew', byte_delta: 19 });
    // N12: the boot backup pass left a copy in the backups dir:
    const backupsDir = join(fx.store.sessionsDir, 'backups');
    const backups = readdirSync(backupsDir).filter((n) => n.endsWith('.bak'));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(backupsDir, backups[0]!), 'utf-8')).toContain('"type":"message"');
    // And the snapshot now covers the grown file (clean next boot):
    expect(new SessionStore(fx.store.dataDir).detectGrowth().findings).toEqual([]);
    registry.dispose();
  });
});

describe('path normalization', () => {
  it('W3: resume paths normalize like the SDK (tilde, file://, resolve)', () => {
    const home = process.env['HOME'] ?? '';
    expect(normalizeSessionPath('~/x/s.jsonl')).toBe(join(home, 'x', 's.jsonl'));
    expect(normalizeSessionPath('file:///tmp/a%20b/s.jsonl')).toBe(resolve('/tmp/a b/s.jsonl'));
    expect(normalizeSessionPath('./rel/s.jsonl')).toBe(resolve('./rel/s.jsonl'));
  });
});

describe('Perkins r2: concurrent double-resume race (B4-race)', () => {
  it('the loser never deletes the winner\'s lock; a foreign writer stays locked out; health stays ok', async () => {
    // Seed one durable session file in the store.
    const fx = await fixture([{ deltas: ['one'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write something', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    expect(existsSync(`${file}.lock`)).toBe(false);

    // TWO concurrent resume spawns: both pass the pre-check before either
    // registers (the r2 race window). Exactly one may win.
    const results = await Promise.allSettled([
      fx.runtime.spawn('gru', { resumeFile: file }),
      fx.runtime.spawn('gru', { resumeFile: file }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /already hosted by this process/,
    );

    // THE R2 BLOCKER: the winner's lock file must SURVIVE the loser's
    // rejection cleanup.
    expect(existsSync(`${file}.lock`)).toBe(true);
    // A foreign store (other bootId) is still locked out:
    const foreign = new SessionStore(fx.store.dataDir);
    expect(() => foreign.acquireLock(file)).toThrow(LockBusyError);
    foreign.dispose();
    // W1-latch pin: losing a race is a state conflict, not adapter health:
    expect(fx.runtime.health().state).toBe('ok');

    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof fx.runtime.spawn>>>).value;
    await winner.dispose();
    expect(existsSync(`${file}.lock`)).toBe(false); // released by the winner
  });
});

describe('Perkins r3: gated-twin scenario (winner-ensures-lock leg)', () => {
  it('the surviving twin re-acquires the released lock before hosting', async () => {
    // Seed a durable session file.
    const fx = await fixture([{ deltas: ['one'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('seed', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    expect(existsSync(`${file}.lock`)).toBe(false);

    twinGate.armed = true;
    try {
      // Twin 0 (pre-acquirer) stalls inside createAgentSession; twin 1
      // (skipped the pre-lock — same store already held it) stalls too.
      const twin0 = fx.runtime.spawn('gru', { resumeFile: file });
      const twin1 = fx.runtime.spawn('gru', { resumeFile: file });
      await vi.waitFor(() => expect(twinGate.fail0).not.toBeNull());
      await vi.waitFor(() => expect(twinGate.release1).not.toBeNull());

      // Twin 0 fails: its catch releases the pre-lock (nobody hosts yet).
      twinGate.fail0!();
      await expect(twin0).rejects.toThrow(/twin-0 infrastructure failure/);
      // THE PRE-LOCK IS GONE — the survivor must re-acquire at registration:
      expect(existsSync(`${file}.lock`)).toBe(false);

      // Twin 1 proceeds and hosts — the winner-ensures-lock leg fires here.
      twinGate.release1!();
      const survivor = await twin1;
      expect(survivor.sessionFile).toBe(file);
      expect(existsSync(`${file}.lock`)).toBe(true); // re-acquired
      // Cross-process single-writer still enforced after the re-acquire:
      const foreign = new SessionStore(fx.store.dataDir);
      expect(() => foreign.acquireLock(file)).toThrow(LockBusyError);
      foreign.dispose();
      await survivor.dispose();
      expect(existsSync(`${file}.lock`)).toBe(false);
    } finally {
      twinGate.armed = false;
      twinGate.fail0 = null;
      twinGate.release1 = null;
    }
  });
});

describe('spawn cwd (SPEC ruling 17 — dispatch roots in the project)', () => {
  it('hosts the session rooted at an explicit project cwd, not the workspace root', async () => {
    const fx = await fixture();
    const project = join(fx.workspace, 'fixture-project');
    mkdirSync(project, { recursive: true });
    const handle = await fx.runtime.spawn('minion', { cwd: project });
    try {
      const expectedDir = fx.store.sessionDirFor('minion', project);
      expect(handle.sessionFile).toContain(expectedDir);
      expect(handle.sessionFile).not.toContain(fx.store.sessionDirFor('minion', fx.workspace));
    } finally {
      await handle.dispose();
    }
  });

  it('fails loud on a relative or nonexistent cwd (never a silent fallback)', async () => {
    const fx = await fixture();
    await expect(fx.runtime.spawn('minion', { cwd: 'relative/path' })).rejects.toThrowError(
      /absolute path/,
    );
    await expect(fx.runtime.spawn('minion', { cwd: join(fx.workspace, 'missing') })).rejects.toThrowError(
      /does not exist/,
    );
    // Neither failure dents adapter health (caller-facing, not infra).
    expect(fx.runtime.health().state).toBe('ok');
  });
});
