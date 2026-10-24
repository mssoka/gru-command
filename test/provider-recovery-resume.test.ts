import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  admitBlindReview,
  blindCoverageOf,
  observeBlindSessionAccess,
  recordBlindAdmission,
  BLIND_ACCESS_EVENT,
} from '../src/dispatch/blind-review.js';
import type {
  AgentCapabilities,
  AgentHandle,
  AgentHealth,
  RuntimeEventListener,
  SpawnOptions,
} from '../src/runtime/types.js';
import type { Role } from '../src/config.js';
import { renderMinionBriefing } from '../src/dispatch/service.js';

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

const TARGET = 'f'.repeat(40);
const BASE = 'a'.repeat(40);
const BLIND_PACKAGE = { baseSha: BASE, targetSha: TARGET, files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }] };

/** A pi-session toolResult line (what the reviewer's session jsonl holds). */
/** One user entry: a transcript that holds a conversation. */
const CONVERSATION = `${JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'do the work' }] } })}\n`;
const sessionToolResult = (text: string): string =>
  `${JSON.stringify({ type: 'message', message: { role: 'toolResult', toolName: 'bash', content: text } })}\n`;

/** The same tool result as a Claude Code session persists it: the assistant's
 * Bash tool_use, then the user record carrying its tool_result (#374). */
const claudeToolResult = (text: string): string => [
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fixture_resume', name: 'Bash', input: { command: 'grep -rn assessment docs' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture_resume', content: text }] } },
].map((record) => `${JSON.stringify(record)}\n`).join('');

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
  readonly prompts: string[] = [];
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
  /** Issue #339: the side effect a REAL turn has on its session — writing the
   * tool results it read. Tests append the prohibited read HERE (inside the
   * delivery) so a scan that ran before the prompt cannot see it. */
  promptEffect: ((text: string) => void) | null = null;
  async prompt(text?: string): Promise<void> {
    this.promptCount += 1;
    this.prompts.push(text ?? '');
    this.promptEffect?.(text ?? '');
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
  readonly worktrees: InMemoryWorktreePort;
  readonly slotReArmCalls: { agentId: string; waitId: string }[] = [];
  slotReArmResult = true;

  constructor() {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-pr-claim-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    const bus = new EventBus();
    this.ledger = new LedgerApi(db.handle, { bus });
    this.worktrees = new InMemoryWorktreePort(mkdtempSync(join(tmpdir(), 'pr-wt-')), this.ledger);
    this.notifications = new NotificationCenter({ ledger: this.ledger, bus });
    cleanupDirs.push(this.worktrees.root);
  }

  /** Scan faults the observer boundary swallowed (issue #339/P5): the
   * production `DispatchService.observeBlindSession` must never fail a
   * delivered turn on a bookkeeping fault. */
  readonly observeErrors: string[] = [];

  deps(overrides: Partial<RecoveryClaimDeps> = {}): RecoveryClaimDeps {
    return {
      registry: this.registry as unknown as RecoveryClaimDeps['registry'],
      ledger: this.ledger,
      worktrees: this.worktrees,
      // Issue #339: the same blind-coverage observation the dispatch settle
      // seam runs, wired to the resume settle seam — through the error
      // boundary the production observer owns (a scan fault is logged and
      // swallowed, never thrown into the delivery).
      observeBlindTurn: (jobId, sessionFile) => {
        try {
          observeBlindSessionAccess(this.ledger, jobId, sessionFile);
        } catch (error) {
          this.observeErrors.push(String(error));
        }
      },
      slotReArm: {
        ownedProviderReArm: (agentId, waitId) => {
          this.slotReArmCalls.push({ agentId, waitId });
          return this.slotReArmResult;
        },
      },
      ...overrides,
    };
  }

  /** Admit `jobId` as a blind review (issue #316) so the resume settle seam
   * has an isolation rule to judge the resumed session's tool access
   * against. */
  admitBlind(jobId: string, repoName: string, keepPackage = true): void {
    const admission = admitBlindReview({
      ledger: this.ledger,
      jobId,
      title: 'review (blind)',
      deliverable: 'review',
      briefing: 'Review the immutable package read-only.',
      targetSha: TARGET,
      repoName,
      inputPackage: BLIND_PACKAGE,
    });
    if (admission === null) throw new Error(`job "${jobId}" was not admitted as a blind review`);
    recordBlindAdmission(this.ledger, jobId, admission, keepPackage ? BLIND_PACKAGE : undefined);
  }

  /** A job with a lane, a minion agent, and a recovered wait on it. Each
   * call mints a unique job id (the shared fixture repo's worktree
   * branches collide otherwise). */
  /** `review`: the job is a review job (a blind admission's is). */
  async recoveredMinionWait(opts: { sessionFile?: string | null; jobId?: string; writeSession?: boolean; promptText?: string; review?: boolean } = {}): Promise<string> {
    const jobId = opts.jobId ?? `job-${++ClaimHarness.jobs}`;
    const repo = fixtureRepo();
    this.ledger.addJob({
      id: jobId,
      repo: repo.path,
      title: `job ${jobId}`,
      briefing: 'do the work',
      ...(opts.review === true ? { deliverable: 'review' as const } : {}),
    });
    await this.worktrees.createJobWorktree({ repoPath: repo.path, jobId });
    this.ledger.setJobStatus(jobId, 'working');
    this.ledger.registerAgent({ id: `agent-${jobId}`, role: 'minion', jobId });
    const sessionFile = opts.sessionFile ?? null;
    if (sessionFile !== null && opts.writeSession !== false) {
      mkdirSync(dirname(sessionFile), { recursive: true });
      // A resumable session: its transcript holds a conversation.
      writeFileSync(sessionFile, CONVERSATION);
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
      continuation: { promptText: opts.promptText ?? 'continue the work', promptOwner: 'minion-brief', hadOpenTurn: true },
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
  it('a RESUMED session receives the pending material amendments once, after its interrupted prompt', async () => {
    const h = new ClaimHarness();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-session-amended-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'minion.jsonl');
    const jobId = 'j-resumed-amended';
    const waitId = await h.recoveredMinionWait({ sessionFile, jobId });
    const amended = h.ledger.addJobAmendment({
      jobId, body: 'RESUMED-CORRECTION: restore the strict viewport tests.', effect: 'material',
      approval: { by: 'gru', reference: 'j-amend-resume' }, expectedContractSha256: h.ledger.effectiveContract(jobId)!.contractSha256,
    });
    expect(amended.status).toBe('accepted');
    expect(await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas')).toMatchObject({ outcome: 'continued', path: 'resumed' });
    const prompted = [...h.registry.handles.values()].flatMap((handle) => handle.prompts);
    expect(prompted).toHaveLength(1);
    expect(prompted[0]).toContain('continue the work');
    expect(prompted[0]!.split('RESUMED-CORRECTION: restore the strict viewport tests.')).toHaveLength(2);
    expect(prompted[0]).toContain('CONTRACT REVISION 1');
    expect(prompted[0]).not.toContain('records the delivery of this turn');
  });

  it('a resumed interrupted turn carries the approved material amendments it has not delivered (owner rule 4)', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-amended';
    const waitId = await h.recoveredMinionWait({ jobId });
    const amended = h.ledger.addJobAmendment({
      jobId, body: 'PENDING-CORRECTION: drop the broad import.', effect: 'material',
      approval: { by: 'gru', reference: 'j-amend' }, expectedContractSha256: h.ledger.effectiveContract(jobId)!.contractSha256,
    });
    expect(amended.status).toBe('accepted');
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'continued' });
    const prompted = [...h.registry.handles.values()].flatMap((handle) => handle.prompts);
    expect(prompted).toHaveLength(1);
    // No session to resume: the FRESH worker reads the effective contract
    // (original briefing + the amendment) and the interrupted prompt.
    expect(prompted[0]).toContain('do the work');
    expect(prompted[0]).toContain('continue the work');
    expect(prompted[0]!.split('PENDING-CORRECTION: drop the broad import.')).toHaveLength(2);
    expect(prompted[0]).toMatch(/the lane is reviewed only after a delivery carries contract revision 1/i);
    expect(prompted[0]).not.toContain('records the delivery of this turn');
  });

  it('resumes the interrupted session and re-delivers the continuation prompt #contract:provider-recovery-continuation:neutral', async () => {
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
    expect(h.ledger.listJobEvents(jobId, { limit: 20 }).find((event) => event.kind === 'provider.continuation-completed')?.payload)
      .toMatchObject({ wait_id: waitId });
    expect(h.ledger.listOpenProviderWaitsForJob(jobId)).toEqual([]);
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
    // A durable claimed receipt is NOT perpetual runtime ownership: the
    // spawn failed and its reservation was released on the error path.
    h.ledger.setAgentState(`agent-${jobId}`, 'idle');
    h.ledger.setJobStatus(jobId, 'binned');
    expect(h.ledger.getJob(jobId)?.status).toBe('binned');
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
  it('an admitted provider continuation blocks a concurrent bin until its spawn and turn settle', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-inflight-claim';
    const waitId = await h.recoveredMinionWait({ jobId });
    h.ledger.setAgentState(`agent-${jobId}`, 'idle'); // the old worker has ceased
    let enterSpawn!: () => void;
    let releaseSpawn!: () => void;
    const entered = new Promise<void>((resolve) => { enterSpawn = resolve; });
    const gate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
    h.registry.spawn = async () => {
      enterSpawn();
      await gate;
      const handle = new FakeHandle('minion', 'new-provider-minion', null);
      h.registry.handles.set(handle.id, handle);
      return handle;
    };
    const claiming = claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    await entered;
    try {
      const before = h.ledger.listJobEvents(jobId);
      expect(() => h.ledger.setJobStatus(jobId, 'binned')).toThrow(/live work|continuation/u);
      expect(h.ledger.listJobEvents(jobId)).toEqual(before);
      expect(h.ledger.getJob(jobId)?.status).toBe('working');
    } finally {
      releaseSpawn();
    }
    const result = await claiming;
    expect(result).toMatchObject({ outcome: 'continued', minionId: 'new-provider-minion' });
    expect(h.registry.handles.get('new-provider-minion')?.promptCount).toBe(1);
    h.ledger.setAgentState('new-provider-minion', 'idle');
    h.ledger.setJobStatus(jobId, 'binned');
    expect(h.ledger.getJob(jobId)?.status).toBe('binned');
    expect(await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas'))
      .toMatchObject({ outcome: 'not-recovered', status: 'claimed' });
  });

  it('an owner hold during the asynchronous spawn refuses the continuation before prompt delivery', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-held-during-spawn';
    const waitId = await h.recoveredMinionWait({ jobId });
    h.ledger.setAgentState(`agent-${jobId}`, 'idle');
    const spawned = new FakeHandle('minion', 'held-replacement', null);
    h.registry.spawnImpl = () => {
      h.ledger.setJobStatus(jobId, 'parked');
      h.registry.handles.set(spawned.id, spawned);
      return spawned;
    };
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'skipped', why: 'continuation authority changed after atomic claim (recorded; no automatic replay)' });
    expect(spawned.disposed).toBe(true);
    expect(spawned.promptCount).toBe(0);
    expect(h.ledger.getJob(jobId)?.status).toBe('parked');
    expect(h.ledger.latestJobEvent(jobId, 'provider.continuation-admitted')).toBeNull();
  });

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
    discarded.ledger.setAgentState('agent-j-binned', 'idle'); // no live producer at discard
    discarded.ledger.setJobStatus(binnedJobId, 'binned');
    const binnedResult = await claimProviderRecoveryContinuation(discarded.deps(), binnedWaitId, 'silas');
    expect(binnedResult).toMatchObject({ outcome: 'skipped', why: 'job is binned — no continuation' });
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

describe('guarded claim — blind coverage scan at the resume settle seam (issue #339)', () => {
  const PROHIBITED = 'docs/issues/305-review.md:1:prior assessment';

  /** The resumed continuation handle whose turn appends the transcript it
   * "read" — the real ordering (a scan before delivery reads a clean file). */
  function resumeTurnThatReads(h: ClaimHarness, sessionFile: string, text: string, record: (text: string) => string = sessionToolResult): void {
    h.registry.spawnImpl = (resumeFile) => {
      const handle = new FakeHandle('minion', `agent-blind-${h.registry.handles.size + 1}`, resumeFile);
      handle.promptEffect = () => appendFileSync(sessionFile, record(text));
      h.registry.handles.set(handle.id, handle);
      return handle;
    };
  }

  it('a FRESH replacement blind reviewer is briefed with its source and package once; a resumed one already holds them (#360 R5-B3)', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-blind-fresh';
    // The interrupted turn was the dispatch briefing itself, which already
    // carried the REVIEW SOURCE and package blocks.
    // The verified source is the lane's own commit, which the lane can read.
    const head = execFileSync('git', ['-C', fixtureRepo().path, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const binding = { objectStore: '', repoPath: fixtureRepo().path, targetSha: head, targetBase: null, rangeCommits: null, inputs: [], source: 'repository' as const, packageSha256: null };
    const waitId = await h.recoveredMinionWait({ review: true, jobId, promptText: renderMinionBriefing({
      jobId, repoName: 'fixture', branch: `gru/${jobId}`, worktreePath: '/wt', sha: head, briefing: 'do the work',
      deliverable: 'review', reviewRole: 'blind', reviewSource: binding, blindPackage: BLIND_PACKAGE,
    }) });
    h.ledger.appendCustomEvent({ kind: 'job.review-source-verified', jobId, payload: {
      object_store: '/recorded/store', target_sha: head, target_base: null, range_commits: null, inputs: [], source: 'repository', package_sha256: null,
    } });
    h.admitBlind(jobId, fixtureRepo().path);
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'continued', path: 'redispatched' });
    const prompted = [...h.registry.handles.values()].flatMap((handle) => handle.prompts);
    expect(prompted).toHaveLength(1);
    expect(prompted[0]).toContain('do the work');
    expect(prompted[0]!.split('REVIEW SOURCE (')).toHaveLength(2);
    expect(prompted[0]!.split('BLIND INPUT PACKAGE (')).toHaveLength(2);
    expect(prompted[0]!.split('File src/feature.ts (at the target):')).toHaveLength(2);
    expect(prompted[0]).toContain(`Base: ${BASE}  Target: ${TARGET}`);
    expect(prompted[0]).toContain('File src/feature.ts (at the target):\n```\nexport const feature = 1;\n\n```');
    // A resumed session was briefed at its first spawn: no second copy.
    const resumed = new ClaimHarness();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-blind-session-resumed-'));
    cleanupDirs.push(sessionDir);
    const resumedJob = 'j-blind-resumed';
    const resumedWait = await resumed.recoveredMinionWait({ review: true, sessionFile: join(sessionDir, 'reviewer.jsonl'), jobId: resumedJob });
    resumed.admitBlind(resumedJob, fixtureRepo().path);
    expect(await claimProviderRecoveryContinuation(resumed.deps(), resumedWait, 'silas')).toMatchObject({ outcome: 'continued', path: 'resumed' });
    expect([...resumed.registry.handles.values()].flatMap((handle) => handle.prompts).join('\n')).not.toContain('BLIND INPUT PACKAGE');
    // An attested package that was never kept refuses the fresh continuation
    // by name before the claim: the wait is cancelled and nothing spawns.
    const unkept = new ClaimHarness();
    const unkeptJob = 'j-blind-unkept';
    const unkeptWait = await unkept.recoveredMinionWait({ review: true, jobId: unkeptJob });
    unkept.admitBlind(unkeptJob, fixtureRepo().path, false);
    const failed = await claimProviderRecoveryContinuation(unkept.deps(), unkeptWait, 'silas');
    expect(failed).toMatchObject({ outcome: 'skipped', why: expect.stringMatching(/^fresh reviewer input unavailable: .*was not kept/u) });
    expect(unkept.registry.spawnCalls).toEqual([]);
    expect(unkept.ledger.getProviderWait(unkeptWait)?.status).toBe('cancelled');
    expect(unkept.ledger.latestJobEvent(unkeptJob, 'provider.recovery-claimed')).toBeNull();
    expect(unkept.ledger.latestJobEvent(unkeptJob, 'provider.continuation-failed')?.payload)
      .toMatchObject({ stage: 'input', error: expect.stringMatching(/its attested blind input package was not kept/u) });
  });

  it('a review job\'s empty or header-only session file is a fresh session that gets its input once, not a resume', async () => {
    const header = `${JSON.stringify({ type: 'session', version: 3, id: 'reviewer-session', timestamp: '2026-10-24T00:00:00.000Z', cwd: '/wt' })}\n`;
    for (const [shape, content] of [['0-byte', ''], ['header-only', header]] as const) {
      const h = new ClaimHarness();
      const sessionDir = mkdtempSync(join(tmpdir(), 'pr-blind-session-empty-'));
      cleanupDirs.push(sessionDir);
      const sessionFile = join(sessionDir, 'reviewer.jsonl');
      const jobId = `j-blind-${shape}`;
      const waitId = await h.recoveredMinionWait({ review: true, sessionFile, jobId, writeSession: false });
      writeFileSync(sessionFile, content);
      h.admitBlind(jobId, fixtureRepo().path);
      expect(await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas'), shape).toMatchObject({ outcome: 'continued', path: 'redispatched' });
      expect(h.registry.spawnCalls, shape).toEqual([{ resumeFile: null }]);
      const prompted = [...h.registry.handles.values()].flatMap((handle) => handle.prompts);
      expect(prompted, shape).toHaveLength(1);
      expect(prompted[0]!.split('BLIND INPUT PACKAGE (your review input'), shape).toHaveLength(2);
      expect(prompted[0], shape).toContain('this brief is READ-ONLY');
    }
  });

  it('a git fault reading a fresh reviewer\'s input leaves the wait for the next pass, never cancelled', async () => {
    const h = new ClaimHarness();
    const jobId = 'j-blind-git-fault';
    const waitId = await h.recoveredMinionWait({ review: true, jobId });
    const lane = h.worktrees.listWorktrees({ jobId })[0]!;
    h.ledger.appendCustomEvent({ kind: 'job.review-source-verified', jobId, payload: {
      object_store: '/recorded/store', target_sha: execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
      target_base: null, range_commits: null, inputs: [], source: 'repository', package_sha256: null,
    } });
    h.admitBlind(jobId, fixtureRepo().path);
    const path = process.env['PATH'];
    process.env['PATH'] = join(lane.path, 'no-git-here');
    let result: Awaited<ReturnType<typeof claimProviderRecoveryContinuation>>;
    try { result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas'); }
    finally { process.env['PATH'] = path; }
    expect(result).toMatchObject({ outcome: 'skipped', why: expect.stringMatching(/^fresh reviewer input could not be read: .*git cannot read lane/u) });
    expect(h.ledger.getProviderWait(waitId)?.status).toBe('recovered-pending');
    expect(h.registry.spawnCalls).toEqual([]);
    expect(h.ledger.latestJobEvent(jobId, 'provider.continuation-failed')).toBeNull();
  });

  it('a prohibited read during the resumed TURN invalidates blind coverage instead of leaving it qualifying #contract:blind-resumed-turn-scan:pi', async () => {
    const h = new ClaimHarness();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-blind-session-prohibited-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'reviewer.jsonl');
    const jobId = 'j-blind-prohibited';
    const waitId = await h.recoveredMinionWait({ review: true, sessionFile, jobId });
    h.admitBlind(jobId, fixtureRepo().path);
    // The prohibited read is written BY the resumed turn, not pre-written: a
    // scan that ran before the prompt would read a clean session and pass.
    resumeTurnThatReads(h, sessionFile, PROHIBITED);
    expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'qualifying', qualifying: true, accessObserved: false });
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'continued', path: 'resumed' });
    // The prohibited read happened during THIS resumed turn's session: the
    // resume settle seam must scan it and invalidate the coverage.
    expect(h.ledger.latestJobEvent(jobId, BLIND_ACCESS_EVENT)).not.toBeNull();
    expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({
      state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
    });
  });

  it('a prohibited read in a resumed Claude Code turn\'s own record shape invalidates blind coverage too #contract:blind-resumed-turn-scan:claude-code', async () => {
    const h = new ClaimHarness();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-blind-session-claude-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'reviewer.jsonl');
    const jobId = 'j-blind-claude';
    const waitId = await h.recoveredMinionWait({ review: true, sessionFile, jobId });
    h.admitBlind(jobId, fixtureRepo().path);
    resumeTurnThatReads(h, sessionFile, PROHIBITED, claudeToolResult);
    expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({ state: 'qualifying', qualifying: true, accessObserved: false });
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'continued', path: 'resumed' });
    expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({
      state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
    });
  });

  it('a clean resumed turn keeps coverage qualifying (and is still observed)', async () => {
    const h = new ClaimHarness();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-blind-session-clean-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'reviewer.jsonl');
    const jobId = 'j-blind-clean';
    const waitId = await h.recoveredMinionWait({ review: true, sessionFile, jobId });
    h.admitBlind(jobId, fixtureRepo().path);
    resumeTurnThatReads(h, sessionFile, 'src/feature.ts:1:export const feature = 1;');
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'continued', path: 'resumed' });
    // The scan ran (an observation is recorded) and found nothing prohibited.
    expect(h.ledger.latestJobEvent(jobId, BLIND_ACCESS_EVENT)).not.toBeNull();
    expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({
      state: 'qualifying', qualifying: true, accessObserved: true, prohibitedAccess: 0,
    });
  });

  it('the scan awaits automatic retry settlement, so a RETRY turn\'s prohibited read is observed (P2)', async () => {
    const h = new ClaimHarness();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-blind-session-retry-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'reviewer.jsonl');
    const jobId = 'j-blind-retry-read';
    const waitId = await h.recoveredMinionWait({ review: true, sessionFile, jobId });
    h.admitBlind(jobId, fixtureRepo().path);
    // The FIRST delivery reads nothing; the supervisor-scheduled retry turn
    // reads the prohibited file DURING settlement, after the prompt settled.
    let settlementAsked = 0;
    const result = await claimProviderRecoveryContinuation(h.deps({
      retrySettlement: async () => {
        settlementAsked += 1;
        appendFileSync(sessionFile, sessionToolResult(PROHIBITED));
        return 'recovered';
      },
    }), waitId, 'silas');
    expect(result).toMatchObject({ outcome: 'continued' });
    // The recovery path forwarded the settlement hook (without it the scan
    // runs before the retry turn and the read is never observed).
    expect(settlementAsked).toBe(1);
    expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({
      state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
    });
  });

  it('a resumed turn whose automatic retries EXHAUST still invalidates coverage (the scan precedes the failure exit, P1)', async () => {
    const h = new ClaimHarness();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-blind-session-exhausted-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'reviewer.jsonl');
    const jobId = 'j-blind-exhausted';
    const waitId = await h.recoveredMinionWait({ review: true, sessionFile, jobId });
    h.admitBlind(jobId, fixtureRepo().path);
    resumeTurnThatReads(h, sessionFile, PROHIBITED);
    let settlementAsked = 0;
    const result = await claimProviderRecoveryContinuation(h.deps({
      retrySettlement: async () => { settlementAsked += 1; return 'exhausted'; },
    }), waitId, 'silas');
    // The continuation failed before delivery...
    expect(settlementAsked).toBe(1);
    expect(result).toMatchObject({ outcome: 'skipped' });
    // ...but the prohibited read is still observed: only a future successful
    // resume would otherwise heal the coverage.
    expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({
      state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
    });
  });

  it('a resumed turn that settles with an in-band error after a prohibited read still invalidates coverage (P5)', async () => {
    const h = new ClaimHarness();
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-blind-session-inband-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'reviewer.jsonl');
    const jobId = 'j-blind-inband';
    const waitId = await h.recoveredMinionWait({ review: true, sessionFile, jobId });
    h.admitBlind(jobId, fixtureRepo().path);
    h.registry.spawnImpl = (resumeFile) => {
      const handle = new FakeHandle('minion', `agent-blind-inband-${h.registry.handles.size + 1}`, resumeFile);
      handle.healthState = 'error';
      handle.healthError = 'assistant stopReason error';
      handle.promptEffect = () => appendFileSync(sessionFile, sessionToolResult(PROHIBITED));
      h.registry.handles.set(handle.id, handle);
      return handle;
    };
    const result = await claimProviderRecoveryContinuation(h.deps(), waitId, 'silas');
    expect(result.outcome).toBe('skipped');
    expect(result.outcome === 'skipped' ? result.why : '').toContain('in-band');
    // The observer runs before the in-band-error return: the read still counts.
    expect(blindCoverageOf(h.ledger, jobId)).toMatchObject({
      state: 'invalidated', qualifying: false, accessObserved: true, prohibitedAccess: 1,
    });
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
