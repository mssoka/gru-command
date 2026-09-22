import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adviseRecurrence,
  blockerFingerprint,
  buildWakePrompt,
  computeSilasDigest,
  consecutiveRecurrence,
  digestActionCount,
  loadSilasSkills,
  SilasDriver,
  type DigestLedger,
  type RoundBlocker,
  type SilasSlot,
  type SkillModule,
} from '../src/dispatch/silas-driver.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { DEFAULT_SILAS_CONFIG } from '../src/config.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';
import type { JobRecord, RoundRecord } from '../src/ledger/api.js';
import type { Role } from '../src/config.js';

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

/**
 * Silas ops driver (E8 follow-through): recurrence policy math, the
 * actionable-states digest, event/sweep wakes, and the one-slot queue.
 * The ledger is real (LedgerApi on a temp db) so the digest walks the same
 * rows production walks.
 */

// ------------------------------------------------------------------
// Recurrence policy (pure)
// ------------------------------------------------------------------

describe('blocker recurrence policy', () => {
  const b = (title: string, location = 'src/a.ts', category = 'correctness'): RoundBlocker => ({
    title,
    location,
    category,
  });

  it('fingerprints are canonical: case/whitespace-insensitive, evidence-free', () => {
    const left = blockerFingerprint(b('Null  deref on EMPTY path'));
    const right = blockerFingerprint({ ...b('null deref on empty path'), category: 'Correctness' });
    expect(left).toBe(right);
    expect(left).not.toBe(blockerFingerprint(b('null deref on empty path', 'src/b.ts')));
    expect(left).not.toBe(blockerFingerprint(b('null deref on empty path', 'src/a.ts', 'security')));
  });

  it('counts consecutive rounds carrying the same blocker; a gap breaks the streak', () => {
    const fp = blockerFingerprint(b('same leak'));
    expect(consecutiveRecurrence(fp, [[b('same leak')], [b('same leak')], [b('other')], [b('same leak')]])).toBe(2);
    expect(consecutiveRecurrence(fp, [[b('same leak')], [], [b('same leak')]])).toBe(1);
    expect(consecutiveRecurrence(fp, [])).toBe(0);
  });

  it('ladder defaults 2/3/4: directive, re-brief, escalate; evolving blockers keep looping', () => {
    expect(adviseRecurrence(0, DEFAULT_SILAS_CONFIG)).toBe('monitor');
    expect(adviseRecurrence(1, DEFAULT_SILAS_CONFIG)).toBe('monitor');
    expect(adviseRecurrence(2, DEFAULT_SILAS_CONFIG)).toBe('directive');
    expect(adviseRecurrence(3, DEFAULT_SILAS_CONFIG)).toBe('rebrief');
    expect(adviseRecurrence(4, DEFAULT_SILAS_CONFIG)).toBe('escalate');
    expect(adviseRecurrence(9, DEFAULT_SILAS_CONFIG)).toBe('escalate');
    // configurable thresholds hold exactly as configured
    expect(adviseRecurrence(2, { directiveAt: 2, rebriefAt: 5, escalateAt: 7 })).toBe('directive');
    expect(adviseRecurrence(5, { directiveAt: 2, rebriefAt: 5, escalateAt: 7 })).toBe('rebrief');
    expect(adviseRecurrence(7, { directiveAt: 2, rebriefAt: 5, escalateAt: 7 })).toBe('escalate');
  });
});

// ------------------------------------------------------------------
// Digest on a real ledger
// ------------------------------------------------------------------

interface Harness {
  ledger: LedgerApi & DigestLedger;
  bus: EventBus;
  cleanup(): void;
}

function makeLedger(): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), 'gru-command-silas-driver-'));
  const db = new LedgerDb(dataDir);
  // The driver bus is deliberately NOT wired into the ledger here: tests
  // publish bus events explicitly (production wires ledger→bus→driver in
  // main.ts; the follow-through integration test covers that full path).
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle) as LedgerApi & DigestLedger;
  return {
    ledger,
    bus,
    cleanup() {
      db.close();
    },
  };
}

function addJobWithDelivery(ledger: LedgerApi, jobId: string, opts: { prUrl?: string } = {}): JobRecord {
  const job = ledger.addJob({ id: jobId, repo: 'fixture-app', title: `t-${jobId}`, briefing: 'b' });
  ledger.setJobStatus(jobId, 'working');
  ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: {} });
  ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { agentId: 'a1' } });
  if (opts.prUrl !== undefined) ledger.setJobPr(jobId, opts.prUrl);
  return job;
}

describe('silas digest (the four actionable states)', () => {
  it('lists a delivered job with no PR as follow-through due, and not after registration', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-a');
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(digest.deliveredWithoutPr.map((row) => row.jobId)).toEqual(['job-a']);
      expect(digestActionCount(digest)).toBe(1);

      h.ledger.setJobPr('job-a', 'https://git.example.invalid/o/r/pull/1');
      const after = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(after.deliveredWithoutPr).toEqual([]);
      // registration alone flips the state to review-due
      expect(after.prWithoutReview.map((row) => row.jobId)).toEqual(['job-a']);
    } finally {
      h.cleanup();
    }
  });

  it('a working job with neither delivery nor PR is NOT actionable (minion still running)', async () => {
    const h = makeLedger();
    try {
      const job = h.ledger.addJob({ id: 'job-run', repo: 'fixture-app', title: 't', briefing: 'b' });
      void job;
      h.ledger.setJobStatus('job-run', 'working');
      h.ledger.registerAgent({ id: 'min-1', role: 'minion', jobId: 'job-run' });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
        now: () => Date.now(),
      });
      expect(digestActionCount(digest)).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('flags a stalled working lane past the threshold, with the minion idle age', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-slow', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-slow', 'working');
      h.ledger.registerAgent({ id: 'min-slow', role: 'minion', jobId: 'job-slow' });
      h.ledger.setAgentState('min-slow', 'idle');
      const now = Date.now();
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
        now: () => now + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1_000,
      });
      expect(digest.stalledWorking).toHaveLength(1);
      expect(digest.stalledWorking[0]?.jobId).toBe('job-slow');
      expect(digest.stalledWorking[0]?.minionId).toBe('min-slow');
    } finally {
      h.cleanup();
    }
  });

  it('a fresh delivery after a changes-requested verdict is re-review due, not directive-due', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-fix', { prUrl: 'https://git.example.invalid/o/r/pull/7' });
      const round: RoundRecord = h.ledger.addRound({ jobId: 'job-fix', lenses: ['blind'] });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('job-fix', 'in-review');
      // Silas directive rung lands; the lane returns to working; minion delivers again.
      h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-fix', payload: {} });
      h.ledger.setJobStatus('job-fix', 'working');
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-fix', payload: {} });

      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(digest.verdictsAwaitingDirective).toEqual([]);
      expect(digest.prWithoutReview.map((row) => row.jobId)).toEqual(['job-fix']);
      expect(digest.prWithoutReview[0]?.priorRounds).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('recurring same blocker climbs the ladder; evolving blockers stay on monitor', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-loop', { prUrl: 'https://git.example.invalid/o/r/pull/9' });
      const reports = new Map<string, RoundBlocker[]>();
      const blockersForRound = async (roundId: string) => ({
        blockers: reports.get(roundId) ?? [],
        note: null,
      });
      // round 1: blocker A alone → verdict, in-review, nothing delivered since
      const r1 = h.ledger.addRound({ jobId: 'job-loop', lenses: ['blind'] });
      reports.set(r1.id, [{ title: 'same leak', location: 'src/a.ts', category: 'correctness' }]);
      h.ledger.setRoundStatus(r1.id, 'live');
      h.ledger.setRoundStatus(r1.id, 'verdict-posted');
      h.ledger.setRoundVerdict(r1.id, 'changes-requested');
      h.ledger.setJobStatus('job-loop', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-loop', roundId: r1.id, payload: { verdict: 'changes-requested' } });

      const first = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound,
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'round.verdict',
      });
      expect(first.verdictsAwaitingDirective).toHaveLength(1);
      expect(first.verdictsAwaitingDirective[0]?.recurringBlockers[0]?.consecutiveRounds).toBe(1);
      expect(first.verdictsAwaitingDirective[0]?.recurringBlockers[0]?.advice).toBe('monitor');

      // round 2: same blocker again → directive rung
      const r2 = h.ledger.addRound({ jobId: 'job-loop', lenses: ['blind'] });
      reports.set(r2.id, [{ title: 'same leak', location: 'src/a.ts', category: 'correctness' }]);
      h.ledger.setRoundStatus(r2.id, 'live');
      h.ledger.setRoundStatus(r2.id, 'verdict-posted');
      h.ledger.setRoundVerdict(r2.id, 'changes-requested');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-loop', roundId: r2.id, payload: { verdict: 'changes-requested' } });
      const second = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound,
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'round.verdict',
      });
      expect(second.verdictsAwaitingDirective[0]?.recurringBlockers[0]?.advice).toBe('directive');

      // round 3: the blocker EVOLVED (fixed) and a NEW blocker appeared —
      // the loop continues: the new blocker is on monitor, not the ladder.
      const r3 = h.ledger.addRound({ jobId: 'job-loop', lenses: ['blind'] });
      reports.set(r3.id, [{ title: 'brand new defect', location: 'src/b.ts', category: 'security' }]);
      h.ledger.setRoundStatus(r3.id, 'live');
      h.ledger.setRoundStatus(r3.id, 'verdict-posted');
      h.ledger.setRoundVerdict(r3.id, 'changes-requested');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-loop', roundId: r3.id, payload: { verdict: 'changes-requested' } });
      const third = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound,
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'round.verdict',
      });
      expect(third.verdictsAwaitingDirective[0]?.recurringBlockers).toHaveLength(1);
      expect(third.verdictsAwaitingDirective[0]?.recurringBlockers[0]?.advice).toBe('monitor');

      // once a silas rung lands after the verdict, the state stops firing
      h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-loop', payload: {} });
      const handled = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound,
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(handled.verdictsAwaitingDirective).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a minion error newer than any delivery surfaces with its context', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-err', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-err', 'working');
      h.ledger.appendCustomEvent({ kind: 'job.minion-error', jobId: 'job-err', payload: { error: 'provider down' } });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'job.minion-error',
      });
      expect(digest.minionErrors.map((row) => row.jobId)).toEqual(['job-err']);
      expect(digest.minionErrors[0]?.error).toBe('provider down');
    } finally {
      h.cleanup();
    }
  });
});

// ------------------------------------------------------------------
// Skills + wake prompt
// ------------------------------------------------------------------

describe('silas skills and wake prompt', () => {
  it('loads both shipped skills from repo resources, loud on a missing one', () => {
    const skills = loadSilasSkills();
    expect(skills.map((s) => s.name)).toEqual(['ops-dispatch', 'ledger-closeout']);
    for (const skill of skills) {
      expect(skill.body.length).toBeGreaterThan(200);
      expect(skill.body).toContain('## ');
    }
    expect(() => loadSilasSkills(['nope'])).toThrow(/unreadable/);
  });

  it('the wake prompt carries skills, ops surface, digest, and the no-cap ladder', () => {
    const skills: SkillModule[] = [{ name: 'ops-dispatch', body: 'SKILL BODY MARKER' }];
    const prompt = buildWakePrompt({
      digest: {
        computedAt: '2026-09-21T00:00:00.000Z',
        trigger: 'job.delivered',
        deliveredWithoutPr: [],
        prWithoutReview: [],
        verdictsAwaitingDirective: [],
        stalledWorking: [],
        minionErrors: [],
      },
      trigger: { kind: 'job.delivered', jobId: 'job-a' },
      skills,
      ops: { baseUrl: 'http://127.0.0.1:7665', configPath: '/instance/config.toml' },
    });
    expect(prompt).toContain('Silas ops wake — trigger: job.delivered (job job-a)');
    expect(prompt).toContain('SKILL BODY MARKER');
    expect(prompt).toContain('http://127.0.0.1:7665');
    expect(prompt).toContain('/instance/config.toml');
    expect(prompt).toContain('by":"silas');
    expect(prompt).toContain('no hard round cap');
    expect(prompt).toContain('Never act on the Gru chat session');
  });
});

// ------------------------------------------------------------------
// Driver: wakes, sweeps, one-slot queue
// ------------------------------------------------------------------

interface DriverHarness {
  driver: SilasDriver;
  prompts: { text: string; owner?: string }[];
  bus: EventBus;
  ledger: LedgerApi & DigestLedger;
  /** Make every subsequent prompt hold its turn open until settle(). */
  hold: () => void;
  settle: () => void;
  failNext: (error: Error) => void;
  cleanup(): void;
}

function makeDriver(opts: {
  enabled?: boolean;
  sweepIntervalMs?: number;
  bus?: boolean;
  skills?: readonly SkillModule[];
} = {}): DriverHarness {
  const h = makeLedger();
  const prompts: { text: string; owner?: string }[] = [];
  const state: { hold?: () => Promise<void>; failWith?: Error } = {};
  let heldResolve: (() => void) | null = null;
  const handle: AgentHandle = {
    role: 'silas' as Role,
    id: 'silas-1',
    sessionFile: null,
    capabilities: FAKE_CAPABILITIES,
    prompt(text: string, options?: { owner?: string }) {
      if (state.failWith !== undefined) {
        const error = state.failWith;
        state.failWith = undefined;
        return Promise.reject(error);
      }
      prompts.push({ text, owner: options?.owner });
      const hold = state.hold;
      return hold !== undefined ? hold() : Promise.resolve();
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
  const slot: SilasSlot = { ensure: async () => handle };
  const driver = new SilasDriver({
    slot,
    ledger: h.ledger,
    config: {
      ...DEFAULT_SILAS_CONFIG,
      enabled: opts.enabled ?? true,
      sweepIntervalMs: opts.sweepIntervalMs ?? 0,
    },
    ops: { baseUrl: 'http://127.0.0.1:7665', configPath: '/instance/config.toml' },
    ...(opts.bus === false ? {} : { bus: h.bus }),
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
    log: () => {},
  });
  return {
    driver,
    prompts,
    bus: h.bus,
    ledger: h.ledger,
    hold: () => {
      state.hold = () =>
        new Promise<void>((resolve) => {
          heldResolve = resolve;
        });
    },
    settle: () => {
      state.hold = undefined;
      heldResolve?.();
      heldResolve = null;
    },
    failNext: (error: Error) => {
      state.failWith = error;
    },
    cleanup: h.cleanup,
  };
}

describe('silas driver wakes', () => {
  it('wakes the slot on a job.delivered bus event with the digest naming the job', async () => {
    const h = makeDriver();
    try {
      h.driver.start();
      addJobWithDelivery(h.ledger, 'job-wake');
      h.bus.publish({
        seq: 999,
        ts: new Date().toISOString(),
        kind: 'job.delivered',
        agentId: null,
        jobId: 'job-wake',
        roundId: null,
        lens: null,
        payload: {},
      });
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
      expect(h.prompts[0]?.owner).toBe('silas-driver');
      expect(h.prompts[0]?.text).toContain('job-wake');
      // the wake is on the record
      expect(h.ledger.latestJobEvent('job-wake', 'silas.wake')).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it('a sweep with an empty digest does not wake; an event trigger always does', async () => {
    const h = makeDriver();
    try {
      h.driver.start();
      await h.driver.trigger({ kind: 'sweep' });
      expect(h.prompts).toHaveLength(0);
      await h.driver.trigger({ kind: 'round.verdict', jobId: 'nothing' });
      expect(h.prompts).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('queues exactly ONE latest trigger while a turn is open (one-slot replay)', async () => {
    const h = makeDriver();
    try {
      h.ledger.addJob({ id: 'job-q1', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-q1', 'working');
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-q1', payload: {} });
      // the first wake holds its turn open
      h.hold();
      const first = h.driver.trigger({ kind: 'job.delivered', jobId: 'job-q1' });
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
      // two triggers land mid-turn: only the LATEST may survive the queue
      await h.driver.trigger({ kind: 'sweep' });
      await h.driver.trigger({ kind: 'job.minion-error', jobId: 'job-q1' });
      expect(h.prompts).toHaveLength(1);
      h.settle();
      await first;
      // the queued wake runs with the LATEST trigger kind
      await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
      expect(h.prompts[1]?.text).toContain('trigger: job.minion-error');
      // and the queue is drained: no third wake
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.prompts).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('a failed wake is settled and retried by the next trigger, never thrown', async () => {
    const h = makeDriver();
    try {
      h.driver.start();
      addJobWithDelivery(h.ledger, 'job-fail');
      h.failNext(new Error('model unreachable'));
      await h.driver.trigger({ kind: 'job.delivered', jobId: 'job-fail' });
      expect(h.prompts).toHaveLength(0);
      await h.driver.trigger({ kind: 'sweep' });
      expect(h.prompts).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('disabled config: no wake, no sweep timer, no slot use', async () => {
    const h = makeDriver({ enabled: false, sweepIntervalMs: 5 });
    try {
      h.driver.start();
      expect(h.driver.running).toBe(false);
      addJobWithDelivery(h.ledger, 'job-off');
      await h.driver.trigger({ kind: 'job.delivered', jobId: 'job-off' });
      expect(h.prompts).toHaveLength(0);
      h.bus.publish({
        seq: 1,
        ts: new Date().toISOString(),
        kind: 'job.delivered',
        agentId: null,
        jobId: 'job-off',
        roundId: null,
        lens: null,
        payload: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.prompts).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it('sweep interval 0 leaves the timer off while event wakes stay live', async () => {
    const h = makeDriver({ sweepIntervalMs: 0 });
    try {
      h.driver.start();
      expect(h.driver.running).toBe(false);
      addJobWithDelivery(h.ledger, 'job-nosweep');
      await h.driver.trigger({ kind: 'job.delivered', jobId: 'job-nosweep' });
      expect(h.prompts).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('injected skills are the prompt body; the shipped default loader is not required', async () => {
    const h = makeDriver({
      skills: [{ name: 'test-skill', body: 'INJECTED SKILL MARKER' }],
    });
    try {
      h.driver.start();
      addJobWithDelivery(h.ledger, 'job-skill');
      await h.driver.trigger({ kind: 'job.delivered', jobId: 'job-skill' });
      expect(h.prompts[0]?.text).toContain('INJECTED SKILL MARKER');
      expect(h.prompts[0]?.text).not.toContain('ops-dispatch');
    } finally {
      h.cleanup();
    }
  });
});
