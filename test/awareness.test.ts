import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  AWARENESS_STATE_NAME,
  GruAwareness,
  type AwarenessLimits,
} from '../src/chat/awareness.js';
import type { NotifyWakeMode, QuietHours, WakeMinSeverity } from '../src/config.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';

/**
 * Gru awareness: escalations and lane digests reaching the chat brain.
 * The unit under test is the ledger-derived context block (action-required
 * notes + a bounded digest) and the wake policy decision — both with the
 * ack contract intact and the default behavior silent.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-awareness-'));
  cleanupDirs.push(dir);
  return dir;
}

interface Rig {
  readonly dir: string;
  readonly api: LedgerApi;
  readonly notifications: NotificationCenter;
  readonly awareness: GruAwareness;
  readonly woke: number[];
}

function boot(options: {
  wakeMode?: NotifyWakeMode;
  limits?: Partial<AwarenessLimits>;
  dir?: string;
  wakeMinIntervalMs?: number;
  wakeMinSeverity?: WakeMinSeverity;
  wakeQuietHours?: QuietHours | null;
  morningDigestGapMs?: number;
  now?: () => number;
} = {}): Rig {
  const dir = options.dir ?? tmpDir();
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const api = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger: api, bus });
  const awareness = new GruAwareness({
    dir,
    ledger: api,
    bus,
    wakeMode: options.wakeMode ?? 'never',
    // Unit rig: no rate cap unless a test asks for one.
    wakeMinIntervalMs: options.wakeMinIntervalMs ?? 0,
    ...(options.wakeMinSeverity !== undefined ? { wakeMinSeverity: options.wakeMinSeverity } : {}),
    ...(options.wakeQuietHours !== undefined ? { wakeQuietHours: options.wakeQuietHours } : {}),
    ...(options.morningDigestGapMs !== undefined ? { morningDigestGapMs: options.morningDigestGapMs } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
  });
  const woke: number[] = [];
  awareness.setWakeSink(() => woke.push(woke.length));
  return { dir, api, notifications, awareness, woke };
}

describe('gru awareness — passive injection', () => {
  it('injects an unacknowledged action-required notification, once, after commit', () => {
    const rig = boot();
    rig.notifications.post({
      kind: 'review-escalation',
      routing: 'action-required',
      severity: 'error',
      title: 'Round j1-r1 is INCOMPLETE',
      detail: 'delivery proof failed',
    });
    const first = rig.awareness.prepare();
    expect(first).not.toBeNull();
    expect(first?.text).toContain('[gru awareness · service context — not a user message]');
    expect(first?.text).toContain('Action required (unacknowledged):');
    expect(first?.text).toContain('- ⚠ Round j1-r1 is INCOMPLETE — delivery proof failed');
    expect(first?.coveredThroughSeq).toBeGreaterThan(0);
    // prepare is read-only: the same block returns until it was delivered.
    expect(rig.awareness.prepare()?.text).toBe(first?.text);
    rig.awareness.commit(first!);
    // Nothing new happened — inject nothing.
    expect(rig.awareness.prepare()).toBeNull();
  });

  it('never injects an acknowledged or resolved action-required notification', () => {
    const rig = boot();
    const acked = rig.notifications.post({
      kind: 'supervision.breaker',
      routing: 'action-required',
      severity: 'error',
      title: 'Ack me first',
    });
    rig.notifications.ack(acked.id, 'human');
    const live = rig.notifications.post({
      kind: 'worktree-sweep-paused',
      routing: 'action-required',
      severity: 'info',
      title: 'Act on me',
    });
    const block = rig.awareness.prepare();
    expect(block?.text).toContain('Act on me');
    expect(block?.text).not.toContain('Ack me first');
    rig.awareness.commit(block!);
    // An ack AFTER injection must not bring the note back either.
    rig.notifications.ack(live.id, 'human');
    expect(rig.awareness.prepare()).toBeNull();
  });

  it('digests deliveries, verdicts, aborts, and lane changes one line each', () => {
    const rig = boot();
    rig.api.appendCustomEvent({ kind: 'job.delivered', jobId: 'j1', payload: { agentId: 'm1' } });
    rig.api.appendCustomEvent({ kind: 'job.status', jobId: 'j1', payload: { from: 'working', to: 'in-review' } });
    rig.api.appendCustomEvent({ kind: 'round.verdict', jobId: 'j1', roundId: 'j1-r1', payload: { verdict: 'approved' } });
    rig.api.appendCustomEvent({ kind: 'round.perkins-incomplete', jobId: 'j1', roundId: 'j1-r2', payload: { reason: 'lead crashed' } });
    rig.api.appendCustomEvent({ kind: 'worktree.status', payload: { id: 'j1-lane', from: 'active', to: 'paused' } });
    const block = rig.awareness.prepare();
    expect(block).not.toBeNull();
    expect(block?.text.split('\n')).toEqual([
      '[gru awareness · service context — not a user message]',
      'Since your last turn:',
      'job j1: briefing delivered to minion m1',
      'job j1: working → in-review',
      'round j1-r1: verdict approved',
      'round j1-r2: review INCOMPLETE — lead crashed',
      'lane j1-lane: active → paused',
    ]);
  });

  it('renders verdict blocker counts from the fallback gate triage and Perkins rounds', () => {
    const rig = boot();
    rig.api.appendCustomEvent({
      kind: 'job.fallback-review',
      jobId: 'j1',
      payload: { gate: true, phase: 'triaged', iteration: 2, blockers: 3, notes: 1 },
    });
    rig.api.appendCustomEvent({
      kind: 'job.fallback-review',
      jobId: 'j1',
      payload: { gate: true, phase: 'pass', iteration: 3, notes: 0, clearToMerge: true },
    });
    rig.api.appendCustomEvent({
      kind: 'round.perkins-review',
      jobId: 'j1',
      roundId: 'j1-r1',
      payload: { canonicalVerdict: 'NEEDS CHANGES', blockers: 2, complete: true },
    });
    const block = rig.awareness.prepare();
    expect(block?.text).toContain('job j1: bmad-review round 2 — 3 blocker(s), 1 note(s)');
    expect(block?.text).toContain('job j1: bmad-review PASS — clear to merge (merge stays user-held)');
    expect(block?.text).toContain('round j1-r1: Perkins NEEDS CHANGES — 2 blocker(s) (proof complete)');
  });

  it('keeps an older escalation visible even when newer events overflow the digest window', () => {
    const rig = boot({ limits: { maxEvents: 2 } });
    rig.notifications.post({
      kind: 'review-escalation',
      routing: 'action-required',
      severity: 'error',
      title: 'Old escalation',
    });
    for (let index = 0; index < 5; index += 1) {
      rig.api.appendCustomEvent({ kind: 'job.status', jobId: `j${index}`, payload: { from: 'a', to: 'b' } });
    }
    const block = rig.awareness.prepare();
    expect(block?.text).toContain('Old escalation');
    expect(block?.text.split('\n').filter((line) => line.startsWith('job j'))).toHaveLength(2);
    expect(block?.text).toContain('(further context omitted…)');
  });

  it('injects nothing when only unmapped noise happened', () => {
    const rig = boot();
    expect(rig.awareness.prepare()).toBeNull();
    rig.api.appendCustomEvent({ kind: 'worktree.note', payload: { id: 'w1', note: 'noise' } });
    expect(rig.awareness.prepare()).toBeNull();
  });

  it('bounds the digest to the newest N events and marks the overflow', () => {
    const rig = boot({ limits: { maxEvents: 5 } });
    for (let index = 1; index <= 12; index += 1) {
      rig.api.appendCustomEvent({
        kind: 'job.status',
        jobId: `j${index}`,
        payload: { from: 'working', to: 'blocked' },
      });
    }
    const block = rig.awareness.prepare();
    expect(block?.text).toContain('job j12:');
    expect(block?.text).not.toContain('job j1:');
    expect(block?.text.split('\n').filter((line) => line.startsWith('job '))).toHaveLength(5);
    expect(block?.text).toContain('(further context omitted…)');
  });

  it('truncates to the byte budget and clamps every line', () => {
    const rig = boot({ limits: { maxBytes: 200, maxLineChars: 60 } });
    for (let index = 0; index < 6; index += 1) {
      rig.api.appendCustomEvent({
        kind: 'job.minion-error',
        jobId: 'j1',
        payload: { error: 'e'.repeat(300) },
      });
    }
    const block = rig.awareness.prepare();
    expect(block).not.toBeNull();
    expect(Buffer.byteLength(block!.text, 'utf8')).toBeLessThanOrEqual(200);
    for (const line of block!.text.split('\n')) expect(line.length).toBeLessThanOrEqual(60);
    expect(block?.text).toContain('(further context omitted…)');
  });

  it('persists the cursor: a restarted awareness never re-injects covered events', () => {
    const dir = tmpDir();
    const first = boot({ dir });
    first.api.appendCustomEvent({ kind: 'job.status', jobId: 'j1', payload: { from: 'working', to: 'blocked' } });
    const block = first.awareness.prepare();
    first.awareness.commit(block!);
    expect(existsSync(join(dir, AWARENESS_STATE_NAME))).toBe(true);

    const restarted = boot({ dir });
    expect(restarted.awareness.prepare()).toBeNull();
    restarted.api.appendCustomEvent({ kind: 'job.status', jobId: 'j1', payload: { from: 'blocked', to: 'working' } });
    const next = restarted.awareness.prepare();
    expect(next?.text).toContain('job j1: blocked → working');
    expect(next?.text).not.toContain('working → blocked');
  });

  it('a corrupt awareness state file fails loud — never silently resets', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, AWARENESS_STATE_NAME), '{"coveredThroughSeq":', 'utf-8');
    expect(() => boot({ dir })).toThrowError(/unreadable/);
    writeFileSync(join(dir, AWARENESS_STATE_NAME), '{"coveredThroughSeq": null}\n', 'utf-8');
    expect(() => boot({ dir })).toThrowError(/invalid coveredThroughSeq/);
  });
});

describe('gru awareness — wake policy', () => {
  it("wake 'never' (default): notifications never start a turn", () => {
    const rig = boot();
    rig.notifications.post({
      kind: 'review-escalation',
      routing: 'action-required',
      severity: 'error',
      title: 'Escalation',
    });
    rig.notifications.post({ kind: 'round.verdict', routing: 'fyi', severity: 'info', title: 'FYI' });
    expect(rig.woke).toEqual([]);
  });

  it("wake 'action-required': escalations wake once; FYI stays passive", () => {
    const rig = boot({ wakeMode: 'action-required' });
    rig.notifications.post({ kind: 'round.verdict', routing: 'fyi', severity: 'info', title: 'FYI' });
    expect(rig.woke).toHaveLength(0);
    rig.notifications.post({
      kind: 'review-escalation',
      routing: 'action-required',
      severity: 'error',
      title: 'Escalation',
    });
    expect(rig.woke).toHaveLength(1);
    // A post-time FYI upgraded to action-required by triage wakes at that
    // point, and a row already acked before triage can never wake.
    const provisional = rig.notifications.post({
      kind: 'agent.state',
      routing: 'fyi',
      severity: 'error',
      title: 'Provisional',
    });
    rig.api.updateNotificationTriage(provisional.id, 'action-required', 'Jev triage');
    expect(rig.woke).toHaveLength(2);
    const closed = rig.notifications.post({
      kind: 'agent.error',
      routing: 'fyi',
      severity: 'error',
      title: 'Closed',
    });
    rig.notifications.ack(closed.id, 'human');
    expect(rig.api.updateNotificationTriage(closed.id, 'action-required', null)).toBeNull();
    expect(rig.woke).toHaveLength(2);
  });

  it("wake 'all': FYI notifications wake too", () => {
    const rig = boot({ wakeMode: 'all' });
    rig.notifications.post({ kind: 'round.verdict', routing: 'fyi', severity: 'info', title: 'FYI' });
    expect(rig.woke).toHaveLength(1);
  });

  it('rate limit: candidates inside the min interval coalesce into ONE trailing wake', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-23T12:00:00'));
      const rig = boot({
        wakeMode: 'action-required',
        wakeMinIntervalMs: 300_000,
        now: () => Date.now(),
      });
      rig.notifications.post({ kind: 'a', routing: 'action-required', severity: 'error', title: 'First' });
      expect(rig.woke).toHaveLength(1);
      rig.notifications.post({ kind: 'b', routing: 'action-required', severity: 'error', title: 'Second' });
      rig.notifications.post({ kind: 'c', routing: 'action-required', severity: 'error', title: 'Third' });
      expect(rig.woke).toHaveLength(1); // deferred, batched
      vi.advanceTimersByTime(300_000);
      expect(rig.woke).toHaveLength(2); // one coalesced trailing wake
      vi.advanceTimersByTime(600_000);
      expect(rig.woke).toHaveLength(2); // no re-fire after the claim
    } finally {
      vi.useRealTimers();
    }
  });

  it('quiet hours: a wake inside the window defers to the window end', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-23T23:00:00'));
      const rig = boot({
        wakeMode: 'action-required',
        wakeQuietHours: { startMinute: 22 * 60, endMinute: 7 * 60 },
        now: () => Date.now(),
      });
      rig.notifications.post({ kind: 'a', routing: 'action-required', severity: 'error', title: 'Night alert' });
      expect(rig.woke).toHaveLength(0);
      vi.advanceTimersByTime(8 * 3_600_000);
      expect(rig.woke).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backlog: unacked machine rows seed ONE wake when the sink binds (migration rule)', () => {
    const dir = tmpDir();
    const db = new LedgerDb(dir);
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    const notifications = new NotificationCenter({ ledger: api, bus });
    notifications.post({ kind: 'a', routing: 'action-required', severity: 'error', title: 'Old A' });
    notifications.post({ kind: 'b', routing: 'action-required', severity: 'error', title: 'Old B' });
    const awareness = new GruAwareness({
      dir,
      ledger: api,
      bus,
      wakeMode: 'action-required',
      wakeMinIntervalMs: 0,
    });
    const woke: number[] = [];
    awareness.setWakeSink(() => woke.push(woke.length));
    expect(woke).toHaveLength(1);
    const state = JSON.parse(readFileSync(awareness.file, 'utf-8')) as {
      wake: { woken: string[]; lastFiredAt: number | null };
    };
    expect(state.wake.woken).toHaveLength(2);
    expect(state.wake.lastFiredAt).not.toBeNull();
  });

  it('dedupe persists across restart: the same notification id never wakes twice', () => {
    const dir = tmpDir();
    const first = boot({ dir, wakeMode: 'action-required' });
    const posted = first.notifications.post({
      kind: 'a',
      routing: 'action-required',
      severity: 'error',
      title: 'One wake only',
    });
    expect(first.woke).toHaveLength(1);
    const restarted = boot({ dir, wakeMode: 'action-required' });
    expect(restarted.woke).toHaveLength(0); // backlog seed: already claimed
    restarted.api.updateNotificationTriage(posted.id, 'action-required', 'retriage');
    expect(restarted.woke).toHaveLength(0); // live triage event: still claimed
  });
});

describe('gru awareness — morning digest (owner ruling 2026-09-23)', () => {
  it('the first block after a quiet gap carries fires, actions, merges, and staged PRs', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-22T21:00:00'));
      const dir = tmpDir();
      const rig = boot({ dir, now: () => Date.now() });
      // Last night's delivered block stamps the gap start.
      rig.api.appendCustomEvent({ kind: 'job.status', jobId: 'j1', payload: { from: 'working', to: 'in-review' } });
      const evening = rig.awareness.prepare();
      expect(evening).not.toBeNull();
      rig.awareness.commit(evening!);
      expect(rig.awareness.prepare()).toBeNull(); // evening block consumed

      // Overnight: a wake fired, a job progressed, one merged, one PR staged.
      vi.setSystemTime(new Date('2026-09-23T07:00:00'));
      rig.api.appendCustomEvent({ kind: 'gru.wake', payload: { notification_ids: ['n1'], count: 1 } });
      rig.api.addJob({ id: 'j-merge', repo: 'demo', title: 'Merge me' });
      rig.api.setJobStatus('j-merge', 'working');
      rig.api.setJobPr('j-merge', 'https://example.invalid/pr/1');
      rig.api.setJobStatus('j-merge', 'in-review');
      rig.api.setJobStatus('j-merge', 'merged');
      rig.api.addJob({ id: 'j-staged', repo: 'demo', title: 'Review me' });
      rig.api.setJobStatus('j-staged', 'working');
      rig.api.setJobPr('j-staged', 'https://example.invalid/pr/2');

      const morning = rig.awareness.prepare();
      expect(morning).not.toBeNull();
      expect(morning?.text).toContain('While you were away (since 2026-09-22T');
      expect(morning?.text).toContain('- fires: 1 wake acted on');
      expect(morning?.text).toContain('- actions:');
      expect(morning?.text).toContain('- merges: j-merge');
      expect(morning?.text).toContain('- staged PRs: j-staged');

      // Committing consumes the digest: the next nearby block has none.
      rig.awareness.commit(morning!);
      rig.api.appendCustomEvent({ kind: 'job.status', jobId: 'j-staged', payload: { from: 'working', to: 'blocked' } });
      expect(rig.awareness.prepare() ?? { text: '' }).not.toMatchObject({ text: expect.stringContaining('While you were away') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('no digest on a fresh install (no delivery stamp yet) or when disabled', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-23T07:00:00'));
      const fresh = boot({ now: () => Date.now() });
      fresh.api.appendCustomEvent({ kind: 'job.status', jobId: 'j1', payload: { from: 'a', to: 'b' } });
      expect(fresh.awareness.prepare()?.text).not.toContain('While you were away');

      const disabled = boot({ now: () => Date.now(), morningDigestGapMs: 0 });
      disabled.api.appendCustomEvent({ kind: 'job.status', jobId: 'j1', payload: { from: 'a', to: 'b' } });
      const first = disabled.awareness.prepare();
      disabled.awareness.commit(first!);
      disabled.api.appendCustomEvent({ kind: 'job.status', jobId: 'j1', payload: { from: 'b', to: 'c' } });
      expect(disabled.awareness.prepare()?.text).not.toContain('While you were away');
    } finally {
      vi.useRealTimers();
    }
  });
});
