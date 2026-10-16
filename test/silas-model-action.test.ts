import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { PiRuntime } from '../src/runtime/pi-adapter.js';
import { SessionStore } from '../src/sessions/store.js';
import { createSilasModelActionTool, SILAS_ACTION_LIMITS, SILAS_MODEL_ACTION_TOOL, spawnSilasWithActionTool } from '../src/dispatch/silas-model-action.js';
import type { SilasOpsDigest } from '../src/dispatch/silas-driver.js';
import { makeStubModelRuntime, StubScript } from './helpers/stub-model.js';
import type { AgentHandle, NativeAgentTool, NativeAgentToolResult, SpawnOptions } from '../src/runtime/types.js';

/**
 * Issue #243 H6 — the product-owned native Silas model-action tool.
 *
 * The real installed SDK model turn dispatches `silas_action` through the
 * adapter's actual `createAgentSession({ customTools })` path; the host binds
 * it to the live handle/session incarnation + `pendingTurn`, observes the
 * canonical digest, and records a durable host-callback receipt. The SDK's
 * ephemeral tool-call id is deliberately NOT used as identity.
 */

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};

const emptyDigest = (): SilasOpsDigest => ({
  computedAt: '2026-10-14T00:00:00.000Z',
  trigger: 'api',
  deliveredWithoutPr: [],
  prWithoutReview: [],
  verdictsAwaitingDirective: [],
  stalledWorking: [],
  minionErrors: [],
  verificationFailures: [],
  verificationWaits: [],
  providerRecoveryPending: [],
  conflictingPrs: [],
  releaseEligible: [],
  revisionContinuations: [],
  verificationsOwed: [],
});

function makeLedger(): { ledger: LedgerApi; eventKinds: () => { kind: string; payload: unknown }[] } {
  const db = new LedgerDb(temp('h6-db-'));
  const ledger = new LedgerApi(db.handle, {});
  return {
    ledger,
    eventKinds: () =>
      db.handle
        .prepare("select kind, payload from events where kind like 'silas.model-%' order by seq")
        .all() as { kind: string; payload: unknown }[],
  };
}

describe('H6 silas_action tool bindings (unit seams)', () => {
  it('refuses when unbound and when no live turn owns the session', async () => {
    const { ledger } = makeLedger();
    const job = ledger.addJob({ id: 'job-unbound', repo: 'r', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    const unbound = createSilasModelActionTool({ getHandle: () => null, ledger, digest: async () => emptyDigest() });
    const unboundResult = JSON.parse((await unbound.execute({ action: 'hold', jobId: job.id })).text) as {
      ok: boolean;
      reason: string;
    };
    expect(unboundResult).toMatchObject({ ok: false, reason: 'unbound' });

    const noTurn: AgentHandle = {
      id: 'silas-no-turn',
      role: 'silas',
      sessionFile: null,
      async prompt() {},
      capabilities: {
        streaming: true,
        steer: 'native',
        resume: 'file',
        images: false,
        thinking: false,
        thinkingLevelControl: false,
        followUp: false,
      },
      async steer() {},
      async followUp() {},
      subscribe() {
        return () => {};
      },
      health() {
        return { state: 'idle' as const, lastActivity: null, sessionFile: null };
      },
      async dispose() {},
    };
    const noTurnTool = createSilasModelActionTool({ getHandle: () => noTurn, ledger, digest: async () => emptyDigest() });
    expect(JSON.parse((await noTurnTool.execute({ action: 'hold', jobId: job.id })).text)).toMatchObject({
      ok: false,
      reason: 'no-live-turn',
    });
  });

  it('refuses an unknown job row instead of inventing one', async () => {
    const { ledger } = makeLedger();
    const handle = {
      id: 'silas-x',
      pendingTurn: () => ({ text: 'live', owner: 'silas' }),
    } as unknown as AgentHandle;
    const tool = createSilasModelActionTool({ getHandle: () => handle, ledger, digest: async () => emptyDigest() });
    expect(JSON.parse((await tool.execute({ action: 'dispatch', jobId: 'nope' })).text)).toMatchObject({
      ok: false,
      reason: 'unknown-job',
    });
  });

  it('is advisory, bounds every free-text field and accepts only a full commit SHA as head (#369)', async () => {
    const { ledger, eventKinds } = makeLedger();
    const job = ledger.addJob({ id: 'job-bounds', repo: 'r', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    const handle = { id: 'silas-b', pendingTurn: () => ({ text: 'live', owner: 'silas' }) } as unknown as AgentHandle;
    const tool = createSilasModelActionTool({ getHandle: () => handle, ledger, digest: async () => emptyDigest() });
    expect(tool.description).toMatch(/ADVISORY/);
    expect(tool.description).toMatch(/executes nothing/);
    const reason = async (input: Record<string, unknown>) => (JSON.parse((await tool.execute(input)).text) as { reason?: string; ok: boolean });
    for (const [field, limit] of Object.entries(SILAS_ACTION_LIMITS)) {
      if (field === 'jobId') continue;
      expect(await reason({ action: 'hold', jobId: job.id, [field]: 'x'.repeat(limit + 1) }), field).toMatchObject({ ok: false, reason: 'bad-field' });
      expect(await reason({ action: 'hold', jobId: job.id, [field]: 'x'.repeat(limit) }), field).toMatchObject({ ok: true });
    }
    expect(await reason({ action: 'hold', jobId: 'j'.repeat(SILAS_ACTION_LIMITS.jobId + 1) })).toMatchObject({ ok: false, reason: 'bad-field' });
    for (const head of ['HEAD', 'abc123', 'A'.repeat(40), 7]) {
      expect(await reason({ action: 'hold', jobId: job.id, head }), String(head)).toMatchObject({ ok: false, reason: 'bad-field' });
    }
    expect(await reason({ action: 'hold', jobId: job.id, head: 'a'.repeat(40) })).toMatchObject({ ok: true });
    // Refusals record nothing; only the accepted calls left receipts.
    expect(eventKinds().filter((row) => row.kind === 'silas.model-action')).toHaveLength(4);
  });

  it('refuses non-object input, blank fields and control characters, and counts length in code points (#369)', async () => {
    const { ledger, eventKinds } = makeLedger();
    const job = ledger.addJob({ id: 'job-shape', repo: 'r', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    const handle = { id: 'silas-s', pendingTurn: () => ({ text: 'live', owner: 'silas' }) } as unknown as AgentHandle;
    const tool = createSilasModelActionTool({ getHandle: () => handle, ledger, digest: async () => emptyDigest() });
    const outcome = async (input: unknown) => JSON.parse((await tool.execute(input as Record<string, unknown>)).text) as { reason?: string; ok: boolean; message?: string };
    for (const input of [[], 'hold', 7, true]) {
      expect(await outcome(input), JSON.stringify(input)).toMatchObject({ ok: false, reason: 'bad-input' });
    }
    const refusedFields: readonly (readonly [string, unknown])[] = [
      ['family', ''], ['debt', '   '], ['family', 7], ['debt', 'a\u0000b'], ['family', 'esc\u001b[31m'], ['jobId', `${job.id}\u0085`], ['rationale', 'bell\u0007'],
      // Format and separator characters spoof or break a rendered audit line.
      ['rationale', 'safe\u202eevil'], ['family', 'zero\u200bwidth'], ['debt', 'line\u2028break'], ['rationale', 'para\u2029graph'], ['family', 'tag\u{e0041}'],
      // A carriage return could overwrite a rendered line, even in the rationale.
      ['rationale', 'overwritten\rforged'],
      // A lone surrogate would not survive its JSON round trip.
      ['debt', 'half\ud800'],
    ];
    for (const [field, value] of refusedFields) {
      expect(await outcome({ action: 'hold', jobId: job.id, [field]: value }), `${field}=${JSON.stringify(value)}`).toMatchObject({ ok: false, reason: 'bad-field' });
    }
    // The rationale alone may break lines; length is in code points, the
    // unit JSON Schema maxLength counts.
    expect(await outcome({ action: 'hold', jobId: job.id, rationale: 'line one\n\tline two\n' })).toMatchObject({ ok: true });
    // The schema the model sees states the same rules.
    const schema = (tool.inputSchema as { properties: Record<string, { minLength?: number; description?: string }> }).properties;
    for (const field of ['jobId', 'family', 'debt', 'rationale']) {
      expect(schema[field], field).toMatchObject({ minLength: 1, description: expect.stringContaining('no control, format or separator characters') });
    }
    const astral = '\u{1F600}';
    expect(await outcome({ action: 'hold', jobId: job.id, rationale: astral.repeat(SILAS_ACTION_LIMITS.rationale) })).toMatchObject({ ok: true });
    expect(await outcome({ action: 'hold', jobId: job.id, rationale: astral.repeat(SILAS_ACTION_LIMITS.rationale + 1) }))
      .toMatchObject({ ok: false, reason: 'bad-field', message: `rationale must be at most ${String(SILAS_ACTION_LIMITS.rationale)} characters` });
    expect(eventKinds().filter((row) => row.kind === 'silas.model-action')).toHaveLength(2);
  });

  it('refuses a missing or unknown action and a missing job, and a failed digest leaves no receipt (#368)', async () => {
    const { ledger, eventKinds } = makeLedger();
    const job = ledger.addJob({ id: 'job-branches', repo: 'r', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    const handle = { id: 'silas-r', pendingTurn: () => ({ text: 'live', owner: 'silas' }) } as unknown as AgentHandle;
    const tool = createSilasModelActionTool({ getHandle: () => handle, ledger, digest: async () => emptyDigest() });
    const reason = async (input: unknown) => JSON.parse((await tool.execute(input as Record<string, unknown>)).text) as { reason?: string; ok: boolean };
    for (const action of [undefined, 'launch', 7, '']) {
      expect(await reason({ action, jobId: job.id }), String(action)).toMatchObject({ ok: false, reason: 'bad-action' });
    }
    expect(await reason(undefined)).toMatchObject({ ok: false, reason: 'bad-action' });
    for (const jobId of [undefined, 42]) {
      expect(await reason({ action: 'hold', jobId }), String(jobId)).toMatchObject({ ok: false, reason: 'bad-job' });
    }
    const failing = createSilasModelActionTool({
      getHandle: () => handle,
      ledger,
      digest: async () => {
        throw new Error('digest unavailable');
      },
    });
    await expect(failing.execute({ action: 'hold', jobId: job.id })).rejects.toThrow('digest unavailable');
    expect(eventKinds()).toEqual([]);
  });

  it('binds the EXACT incarnation: two spawns get distinct tools, never a late lookup', async () => {
    const { ledger, eventKinds } = makeLedger();
    const job = ledger.addJob({ id: 'job-inc', repo: 'r', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    let boundA: AgentHandle | null = null;
    let boundB: AgentHandle | null = null;
    const toolA = createSilasModelActionTool({ getHandle: () => boundA, ledger, digest: async () => emptyDigest() });
    const toolB = createSilasModelActionTool({ getHandle: () => boundB, ledger, digest: async () => emptyDigest() });
    boundA = { id: 'silas-inc-a', pendingTurn: () => ({ text: 'a', owner: 'silas' }) } as unknown as AgentHandle;
    boundB = { id: 'silas-inc-b', pendingTurn: () => ({ text: 'b', owner: 'silas' }) } as unknown as AgentHandle;
    const resultA = (await toolA.execute({ action: 'hold', jobId: job.id })) as NativeAgentToolResult;
    expect(JSON.parse(resultA.text)).toMatchObject({ ok: true });
    const resultB = (await toolB.execute({ action: 'hold', jobId: job.id })) as NativeAgentToolResult;
    expect(JSON.parse(resultB.text)).toMatchObject({ ok: true });
    // Each tool recorded ITS OWN incarnation, even though both are bound here.
    const rows = eventKinds();
    const observations = rows
      .filter((row) => row.kind === 'silas.model-observation')
      .map((row) => JSON.parse(String(row.payload)) as Record<string, unknown>);
    expect(observations).toHaveLength(2);
    expect(observations[0]!['handle_id']).toBe('silas-inc-a');
    expect(observations[1]!['handle_id']).toBe('silas-inc-b');
  });
});

describe('H6 the Silas slot spawn wiring (#368)', () => {
  it('appends silas_action to the caller tools and binds each spawn to its own handle', async () => {
    const { ledger, eventKinds } = makeLedger();
    const job = ledger.addJob({ id: 'job-wire', repo: 'r', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    const spawned: { readonly role: string; readonly options: SpawnOptions | undefined }[] = [];
    let next = 0;
    const registry = {
      spawn: async (role: string, options?: SpawnOptions): Promise<AgentHandle> => {
        spawned.push({ role, options });
        next += 1;
        return { id: `silas-${String(next)}`, sessionFile: null, pendingTurn: () => ({ text: 'live', owner: 'silas' }) } as unknown as AgentHandle;
      },
    };
    const existing = { name: 'existing_tool' } as unknown as NativeAgentTool;
    const first = await spawnSilasWithActionTool({ registry, ledger, digest: async () => emptyDigest() }, { cwd: '/w', nativeTools: [existing] });
    const second = await spawnSilasWithActionTool({ registry, ledger, digest: async () => emptyDigest() });
    expect(spawned.map((row) => row.role)).toEqual(['silas', 'silas']);
    expect(spawned[0]?.options?.cwd).toBe('/w');
    expect(spawned[0]?.options?.nativeTools?.map((tool) => tool.name)).toEqual(['existing_tool', SILAS_MODEL_ACTION_TOOL]);
    expect(spawned[1]?.options?.nativeTools?.map((tool) => tool.name)).toEqual([SILAS_MODEL_ACTION_TOOL]);
    const firstTool = spawned[0]!.options!.nativeTools![1]!;
    const secondTool = spawned[1]!.options!.nativeTools![0]!;
    await firstTool.execute({ action: 'hold', jobId: job.id });
    await secondTool.execute({ action: 'hold', jobId: job.id });
    const receipts = eventKinds().filter((row) => row.kind === 'silas.model-observation')
      .map((row) => (JSON.parse(String(row.payload)) as { handle_id: string }).handle_id);
    expect(receipts).toEqual([first.id, second.id]);
  });

  it('refuses before its spawn resolves, and a caller tool of the same name is refused before any spawn', async () => {
    const { ledger, eventKinds } = makeLedger();
    const job = ledger.addJob({ id: 'job-pending', repo: 'r', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    let captured: SpawnOptions | undefined;
    let finish: (handle: AgentHandle) => void = () => {};
    let spawns = 0;
    const registry = {
      spawn: (_role: string, options?: SpawnOptions): Promise<AgentHandle> => {
        spawns += 1;
        captured = options;
        return new Promise<AgentHandle>((resolve) => { finish = resolve; });
      },
    };
    const spawning = spawnSilasWithActionTool({ registry, ledger, digest: async () => emptyDigest() });
    const tool = captured!.nativeTools![0]!;
    expect(JSON.parse((await tool.execute({ action: 'hold', jobId: job.id })).text)).toMatchObject({ ok: false, reason: 'unbound' });
    expect(eventKinds()).toEqual([]);
    finish({ id: 'silas-late', sessionFile: null, pendingTurn: () => ({ text: 'live', owner: 'silas' }) } as unknown as AgentHandle);
    await spawning;
    expect(JSON.parse((await tool.execute({ action: 'hold', jobId: job.id })).text)).toMatchObject({ ok: true });
    const stale = { name: SILAS_MODEL_ACTION_TOOL } as unknown as NativeAgentTool;
    await expect(spawnSilasWithActionTool({ registry, ledger, digest: async () => emptyDigest() }, { nativeTools: [stale] }))
      .rejects.toThrow(/already carries a silas_action tool — each spawn binds its own/u);
    await expect(spawnSilasWithActionTool({ registry, ledger, digest: async () => emptyDigest() }, { nativeTools: 'not tools' as never }))
      .rejects.toThrow(/nativeTools must be an array/u);
    expect(spawns).toBe(1);
  });

  it('is the spawn main.ts declares for the Silas slot (wiring alarm)', () => {
    const mainSource = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(mainSource).toMatch(/id: 'silas-ops',[\s\S]{0,200}spawn: \(spawnOptions\) => spawnSilasWithActionTool\(/);
  });
});

describe('H6 real installed-runtime model dispatch through customTools', () => {
  it('executes silas_action from a genuine model turn and records a host-bound durable receipt', async () => {
    const home = temp('h6-home-');
    const workspace = temp('h6-ws-');
    const agentDir = temp('h6-agentdir-');
    const { ledger, eventKinds } = makeLedger();
    const job = ledger.addJob({ id: 'job-h6', repo: 'r', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    writeFileSync(
      configPathFor(home),
      `workspace_root = "${workspace}"\n[models]\ndefault = "gru-stub/stub-model"\n`,
      'utf-8',
    );
    mkdirSync(agentDir, { recursive: true });
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const script = new StubScript([
      { deltas: [], toolCall: { id: 'sdk-call-1', name: SILAS_MODEL_ACTION_TOOL, args: { action: 'hold', jobId: job.id } } },
      { deltas: ['action recorded'] },
    ]);
    const runtime = new PiRuntime({ config, store, agentDir, modelRuntime: await makeStubModelRuntime(script) });
    // Exactly the main.ts per-spawn binding: the closure assigns the handle
    // returned by THIS spawn.
    let bound: AgentHandle | null = null;
    const inner = createSilasModelActionTool({ getHandle: () => bound, ledger, digest: async () => emptyDigest() });
    let lastResult: NativeAgentToolResult | null = null;
    const tool = {
      ...inner,
      execute: async (input: unknown, signal?: AbortSignal) => {
        const result = await inner.execute(input, signal);
        lastResult = result;
        return result;
      },
    };
    const handle = await runtime.spawn('silas', { cwd: workspace, nativeTools: [tool] });
    bound = handle;
    await handle.prompt('record the current arbitration');
    expect(lastResult).not.toBeNull();
    const result = lastResult as unknown as NativeAgentToolResult;
    const details = result.details as { ok: boolean; host_callback_invocation_id: number; event_seq: number };
    expect(details.ok).toBe(true);
    const events = eventKinds();
    expect(events.map((event) => event.kind)).toEqual(['silas.model-observation', 'silas.model-action']);
    const action = JSON.parse(String(events[1]!.payload)) as Record<string, unknown>;
    expect(action).toMatchObject({
      action: 'hold',
      job_id: job.id,
      sdk_tool_call_id: null,
      host_callback_invocation_id: details.host_callback_invocation_id,
    });
    expect(action['action_id']).toBe(`silas-action:${details.host_callback_invocation_id}`);
    // The recorded agent id is the REAL live handle, not the raw SDK call id.
    expect(action['action_id']).not.toContain('sdk-call-1');
    await handle.dispose();
    store.dispose();
  }, 60_000);
});
