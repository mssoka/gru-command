import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import {
  claimProviderRecoveryContinuation,
  type RecoveryClaimDeps,
} from '../src/provider-recovery/resume.js';
import type {
  AgentCapabilities,
  AgentHandle,
  AgentHealth,
  RuntimeEventListener,
  SpawnOptions,
} from '../src/runtime/types.js';
import type { Role } from '../src/config.js';

/**
 * The guarded eligible-state transition (acceptance 7): one recovered wait
 * becomes one actual continuation through the normal dispatch surface —
 * with every recheck failing visible, never silently.
 */

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

const cleanupDirs: string[] = [];
let sharedRepo: FixtureRepo | null = null;

function fixtureRepo(): FixtureRepo {
  sharedRepo ??= makeFixtureRepo('fixture-provider-recovery');
  return sharedRepo;
}

afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

afterAll(() => {
  sharedRepo?.cleanup();
  sharedRepo = null;
});

class FakeHandle implements AgentHandle {
  readonly role: Role;
  readonly id: string;
  readonly sessionFile: string | null;
  readonly capabilities = FAKE_CAPABILITIES;
  promptCount = 0;
  disposed = false;
  /** Settle-time terminal health the fallback verdict reads (#160 tests). */
  healthState: 'idle' | 'error' = 'idle';
  healthError: string | null = null;
  private readonly listeners = new Set<RuntimeEventListener>();

  constructor(role: Role, id: string, sessionFile: string | null) {
    this.role = role;
    this.id = id;
    this.sessionFile = sessionFile;
  }
  /** Fire a turn_start for the admission recorder. */
  turnStart(): void {
    for (const listener of this.listeners) listener({ type: 'turn_start' });
  }
  async prompt(): Promise<void> {
    this.promptCount += 1;
    // Realistic admission: the turn STARTS when the prompt is delivered.
    this.turnStart();
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  health(): AgentHealth {
    return {
      state: this.healthState,
      lastActivity: new Date().toISOString(),
      sessionFile: this.sessionFile,
      ...(this.healthError === null ? {} : { error: this.healthError }),
    };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeRegistry {
  readonly handles = new Map<string, FakeHandle>();
  readonly spawnCalls: { resumeFile: string | null }[] = [];
  spawnImpl: (resumeFile: string | null) => FakeHandle = (resumeFile) => {
    const handle = new FakeHandle('minion', `agent-${this.handles.size + 1}`, resumeFile);
    this.handles.set(handle.id, handle);
    return handle;
  };
  getHandle(agentId: string): FakeHandle | null {
    return this.handles.get(agentId) ?? null;
  }
  async spawn(_role: Role, options?: SpawnOptions): Promise<AgentHandle> {
    this.spawnCalls.push({ resumeFile: options?.resumeFile ?? null });
    return this.spawnImpl(options?.resumeFile ?? null);
  }
  async disposeHandle(handle: AgentHandle): Promise<void> {
    this.handles.delete(handle.id);
    await handle.dispose();
  }
}

class ClaimHarness {
  static jobs = 0;
  readonly ledger: LedgerApi;
  readonly notifications: NotificationCenter;
  readonly registry = new FakeRegistry();
  readonly worktrees = new InMemoryWorktreePort(mkdtempSync(join(tmpdir(), 'pr-wt-')));
  readonly slotReArmCalls: { agentId: string; waitId: string }[] = [];
  slotReArmResult = true;

  constructor() {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-pr-claim-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    const bus = new EventBus();
    this.ledger = new LedgerApi(db.handle, { bus });
    this.notifications = new NotificationCenter({ ledger: this.ledger, bus });
    cleanupDirs.push(this.worktrees.root);
  }

  deps(): RecoveryClaimDeps {
    return {
      registry: this.registry as unknown as RecoveryClaimDeps['registry'],
      ledger: this.ledger,
      worktrees: this.worktrees,
      slotReArm: {
        ownedProviderReArm: (agentId, waitId) => {
          this.slotReArmCalls.push({ agentId, waitId });
          return this.slotReArmResult;
        },
      },
    };
  }

  /** A job with a lane, a minion agent, and a recovered wait on it. Each
   * call mints a unique job id (the shared fixture repo's worktree
   * branches collide otherwise). */
  async recoveredMinionWait(opts: { sessionFile?: string | null; jobId?: string; writeSession?: boolean } = {}): Promise<string> {
    const jobId = opts.jobId ?? `job-${++ClaimHarness.jobs}`;
    const repo = fixtureRepo();
    await this.worktrees.createJobWorktree({ repoPath: repo.path, jobId });
    this.ledger.addJob({
      id: jobId,
      repo: repo.path,
      title: `job ${jobId}`,
      briefing: 'do the work',
    });
    this.ledger.setJobStatus(jobId, 'working');
    this.ledger.registerAgent({ id: `agent-${jobId}`, role: 'minion', jobId });
    const sessionFile = opts.sessionFile ?? null;
    if (sessionFile !== null && opts.writeSession !== false) {
      mkdirSync(dirname(sessionFile), { recursive: true });
      writeFileSync(sessionFile, '{}\n');
    }
    this.ledger.recordProviderWait({
      id: 'wait-1',
      routeKey: 'zai-coding-cn/glm-5.3@fp1',
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4',
      credentialFingerprint: 'fp1',
      jobStatusAtEstablishment: 'working',
      lineageKey: `job:${jobId}`,
      waiterKind: 'job-minion',
      jobId,
      agentId: `agent-${jobId}`,
      slotId: null,
      sessionFile,
      continuation: { promptText: 'continue the work', promptOwner: 'minion-brief', hadOpenTurn: true },
      incidentId: 'incident-1',
      incidentGeneration: 1,
      reasonClass: 'temporary-recoverable:429',
    });
    // The atomic recovery batch (r1 #7/#8): marker + one provider.restored
    // event + the waiter flip commit in ONE transaction. The claim guard
    // verifies batch membership by the stamped batch id.
    this.ledger.commitProviderRecoveryBatch({
      id: 'p1',
      routeKey: 'zai-coding-cn/glm-5.3@fp1',
      incidentGenerations: [1],
      evidence: { stopReason: 'stop' },
      waiters: [{ id: 'wait-1', jobId }],
    });
    return 'wait-1';
  }
}

describe('guarded claim — happy path', () => {
  it('resumes the interrupted session and re-delivers the continuation prompt', async () => {
    const h = new ClaimHarness();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-session-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'minion.jsonl');
    writeFileSync(sessionFile, '{}\n');
    const jobId = 'j-resume';
    const waitId = await h.recoveredMinionWait({ sessionFile, jobId });
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'continued', path: 'resumed' });
    expect(h.registry.spawnCalls[0]?.resumeFile).toBe(sessionFile);
    const claimed = h.ledger.getProviderWait(waitId);
    expect(claimed?.status).toBe('claimed');
    const claimedEvent = h.ledger
      .listJobEvents(jobId, { limit: 20 })
      .find((event) => event.kind === 'provider.recovery-claimed');
    expect(claimedEvent).toBeDefined();
    // ACTUAL admission recorded separately from the claim/delivery.
    const admitted = h.ledger
      .listJobEvents(jobId, { limit: 20 })
      .find((event) => event.kind === 'provider.continuation-admitted');
    expect(admitted).toBeDefined();
    // The continuation prompt was delivered exactly once.
    const spawned = [...h.registry.handles.values()].find((handle) => handle.promptCount > 0);
    expect(spawned?.promptCount).toBe(1);
  });

  it('a continuation turn that settles with an in-band error is recorded, never reported as continued (#160)', async () => {
    const h = new ClaimHarness();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-session-inband-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'minion.jsonl');
    writeFileSync(sessionFile, '{}\n');
    const jobId = 'j-inband';
    const waitId = await h.recoveredMinionWait({ sessionFile, jobId });
    h.registry.spawnImpl = (resumeFile) => {
      const handle = new FakeHandle('minion', `agent-inband-${h.registry.handles.size + 1}`, resumeFile);
      handle.healthState = 'error';
      handle.healthError = 'assistant stopReason error';
      h.registry.handles.set(handle.id, handle);
      return handle;
    };
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    // The prompt settled but the turn failed in-band: NOT a continuation.
    expect(result.outcome).toBe('skipped');
    expect(result.outcome === 'skipped' ? result.why : '').toContain('in-band');
    // Durable non-success evidence, no delivery, claim kept (no replay).
    const events = h.ledger.listJobEvents(jobId, { limit: 50 });
    expect(events.some((event) => event.kind === 'provider.continuation-failed')).toBe(true);
    expect(events.some((event) => event.kind === 'job.minion-error')).toBe(true);
    expect(events.some((event) => event.kind === 'job.delivered')).toBe(false);
    expect(h.ledger.getProviderWait(waitId)?.status).toBe('claimed');
    // The lane does not stay 'working' with nobody driving it (#160).
    expect(h.ledger.getJob(jobId)?.status).toBe('blocked');
  });

  it('a deterministic spawn failure after the claim records the error durably and blocks the lane (#160)', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-spawnfail';
    const waitId = await h.recoveredMinionWait({ sessionFile: null, jobId });
    h.registry.spawnImpl = () => {
      throw new Error('spawn exploded');
    };
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result.outcome).toBe('skipped');
    expect(result.outcome === 'skipped' ? result.why : '').toContain('no automatic replay');
    // Both failure paths leave the same durable non-success evidence.
    const events = h.ledger.listJobEvents(jobId, { limit: 50 });
    expect(events.some((event) => event.kind === 'provider.continuation-failed')).toBe(true);
    expect(events.some((event) => event.kind === 'job.minion-error')).toBe(true);
    expect(events.some((event) => event.kind === 'job.delivered')).toBe(false);
    expect(h.ledger.getProviderWait(waitId)?.status).toBe('claimed');
    expect(h.ledger.getJob(jobId)?.status).toBe('blocked');
  });

  it('a missing session file falls back to a fresh worker on the same lane', async () => {
    const h = new ClaimHarness();
    // A nonexistent path exercises the fallback without creating it.
    const waitId = await h.recoveredMinionWait({
      sessionFile: join(tmpdir(), `pr-missing-${Date.now()}-${Math.random()}`, 'minion.jsonl'),
      jobId: 'j-fresh',
      writeSession: false,
    });
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'continued', path: 'redispatched' });
    expect(h.registry.spawnCalls[0]?.resumeFile).toBeNull();
  });
});

describe('guarded claim — every recheck fails visible', () => {
  it('a cancelled/terminal job skips the claim and retires the wait', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-done';
    const waitId = await h.recoveredMinionWait({ jobId });
    h.ledger.setJobStatus(jobId, 'done');
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(h.ledger.getProviderWait(waitId)?.status).toBe('cancelled');
    expect(h.registry.spawnCalls).toHaveLength(0);

    // A binned (discarded) lane cancels the continuation the same way —
    // recovery never resurrects a discarded lane.
    const discarded = new ClaimHarness();
    const binnedJobId = 'j-binned';
    const binnedWaitId = await discarded.recoveredMinionWait({ jobId: binnedJobId });
    discarded.ledger.setJobStatus(binnedJobId, 'binned');
    const binnedResult = await claimProviderRecoveryContinuation(discarded.deps(), binnedWaitId, 'silas');
    expect(binnedResult).toMatchObject({ outcome: 'skipped' });
    expect(discarded.ledger.getProviderWait(binnedWaitId)?.status).toBe('cancelled');
    expect(discarded.registry.spawnCalls).toHaveLength(0);
  });

  it('an owner hold placed JUST before admission cancels the continuation', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-parked';
    const waitId = await h.recoveredMinionWait({ jobId });
    h.ledger.setJobStatus(jobId, 'parked');
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'skipped', why: expect.stringContaining('parked') });
    expect(h.ledger.getProviderWait(waitId)?.status).toBe('cancelled');
  });

  it('a wall-settled blocked job resumes instead of cancelling, and the lane re-opens (r4)', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-wall-blocked';
    const waitId = await h.recoveredMinionWait({ jobId });
    // The dispatch settle raced the wait: this wait's own failing turn
    // writes the minion error, then the job flips blocked.
    h.ledger.appendCustomEvent({
      kind: 'job.minion-error',
      jobId,
      payload: { agentId: `agent-${jobId}`, error: 'runtime error: 429: ...' },
    });
    h.ledger.setJobStatus(jobId, 'blocked');
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'continued' });
    expect(h.ledger.getProviderWait(waitId)?.status).toBe('claimed');
    expect(h.ledger.getJob(jobId)?.status).toBe('working');
    expect(h.registry.spawnCalls).toHaveLength(1);
  });

  it('a blocked job with no wall-settled attribution still cancels at claim (owner/ops hold)', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-foreign-block';
    const waitId = await h.recoveredMinionWait({ jobId });
    h.ledger.setJobStatus(jobId, 'blocked');
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'skipped', why: expect.stringContaining('blocked') });
    expect(h.ledger.getProviderWait(waitId)?.status).toBe('cancelled');
    expect(h.registry.spawnCalls).toHaveLength(0);
  });

  it('stale recovery evidence (marker cleared) skips the claim', async () => {
    const h = new ClaimHarness();
    const waitId = await h.recoveredMinionWait({ jobId: 'j-stale' });
    h.ledger.clearPendingProviderRecovery('p1');
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'skipped', why: 'recovery evidence no longer current' });
  });

  it('a live replacement minion supersedes the wait (already-live replacement)', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-replaced';
    const waitId = await h.recoveredMinionWait({ jobId });
    h.ledger.registerAgent({ id: 'agent-minion-new', role: 'minion', jobId });
    h.registry.handles.set('agent-minion-new', new FakeHandle('minion', 'agent-minion-new', null));
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'skipped', why: expect.stringContaining('replacement') });
    expect(h.ledger.getProviderWait(waitId)?.status).toBe('superseded');
  });

  it('a live REVIEW-ONLY session does not supersede the implementer\'s wait (2026-10-05 review)', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-reviewer-live';
    const waitId = await h.recoveredMinionWait({ jobId });
    // A newer round-bound review session WITH a live handle: it is not the
    // lane's writer, so the interrupted implementer's claim proceeds.
    const round = h.ledger.addRound({ jobId, lenses: ['blind'] });
    h.ledger.registerAgent({ id: 'agent-review-live', role: 'minion', jobId, roundId: round.id });
    h.registry.handles.set('agent-review-live', new FakeHandle('minion', 'agent-review-live', null));
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).not.toMatchObject({ why: expect.stringContaining('replacement') });
    expect(h.ledger.getProviderWait(waitId)?.status).not.toBe('superseded');
  });

  it('the original actor being live again supersedes the wait', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-originlive';
    const waitId = await h.recoveredMinionWait({ jobId });
    h.registry.handles.set(`agent-${jobId}`, new FakeHandle('minion', `agent-${jobId}`, null));
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'skipped', why: 'original actor is live again' });
  });

  it('a swept lane cancels the wait (nothing to resume into)', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-swept';
    const waitId = await h.recoveredMinionWait({ jobId });
    await h.worktrees.release({ worktreeId: jobId });
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'skipped', why: expect.stringContaining('swept') });
  });

  it('a wait that never recovered answers not-recovered', async () => {
    const h = new ClaimHarness();
    const waitId = await h.recoveredMinionWait({ jobId: 'j-notrec' });
    h.ledger.setProviderWaitStatus(waitId, 'waiting');
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'not-recovered', status: 'waiting' });
  });

  it('an unknown wait id answers not-found', async () => {
    const h = new ClaimHarness();
    const result = await claimProviderRecoveryContinuation(h.deps(), 'missing', 'silas');
    expect(result).toMatchObject({ outcome: 'not-found' });
  });
});

describe('guarded claim — silas logical slot', () => {
  async function recoveredSilasWait(h: ClaimHarness): Promise<string> {
    h.ledger.recordProviderWait({
      id: 'wait-silas',
      routeKey: 'zai-coding-cn/glm-5.3@fp1',
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4',
      credentialFingerprint: 'fp1',
      jobStatusAtEstablishment: null,
      lineageKey: 'slot:silas-ops',
      waiterKind: 'silas-slot',
      jobId: null,
      agentId: 'agent-silas',
      slotId: 'silas-ops',
      sessionFile: null,
      continuation: null,
      incidentId: 'incident-silas',
      incidentGeneration: 1,
      reasonClass: 'temporary-recoverable:429',
    });
    h.ledger.commitProviderRecoveryBatch({
      id: 'p-silas',
      routeKey: 'zai-coding-cn/glm-5.3@fp1',
      incidentGenerations: [1],
      evidence: { stopReason: 'stop' },
      waiters: [{ id: 'wait-silas', jobId: null }],
    });
    return 'wait-silas';
  }

  it('re-arms the SAME logical slot through the guarded owned path', async () => {
    const h = new ClaimHarness();
    const waitId = await recoveredSilasWait(h);
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'rearmed', agentId: 'agent-silas' });
    expect(h.slotReArmCalls).toEqual([{ agentId: 'agent-silas', waitId }]);
    expect(h.ledger.getProviderWait(waitId)?.status).toBe('claimed');
  });

  it('a refused re-arm (slot no longer provider-stopped) supersedes the wait', async () => {
    const h = new ClaimHarness();
    const waitId = await recoveredSilasWait(h);
    h.slotReArmResult = false;
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'skipped', why: 'slot no longer provider-stopped' });
    expect(h.ledger.getProviderWait(waitId)?.status).toBe('superseded');
  });
});
