import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adviseFollowThrough,
  adviseRecurrence,
  blockerFingerprint,
  blockerLocationKey,
  buildWakePrompt,
  CAPTURE_HELPER_PATH,
  computeSilasDigest,
  consecutiveRecurrence,
  consolidatedBlockersFor,
  deliveredTargetSha,
  digestActionCount,
  followUpChangedTarget,
  loadSilasSkills,
  roundBlockerKeys,
  sameBlockerPairs,
  SilasDriver,
  supervisionLookup,
  type BlockersForRound,
  type DeterministicPassHook,
  type DigestLedger,
  type GitHubPollPort,
  type RoundBlocker,
  type SilasSlot,
  type SkillModule,
  type SameBlockerPair,
} from '../src/dispatch/silas-driver.js';
import { DECISION_SURFACE_SAME_BLOCKER } from '../src/decisions/questions.js';
import type { DecisionOutcome, QuestionSet } from '../src/decisions/types.js';
import type { DecisionService } from '../src/decisions/types.js';
import { EventBus } from '../src/events/bus.js';
import { createDurableReconcileHook, reconcileDurableWork } from '../src/dispatch/durable-reconcile.js';
import type { FollowThroughNotifications } from '../src/dispatch/obligations.js';
import { FIRING_RULES } from '../src/ledger/obligations.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb, MIGRATIONS } from '../src/ledger/db.js';
import { BRANCH_STATE_EVENT } from '../src/dispatch/github-poll.js';
import { DEFAULT_SILAS_CONFIG } from '../src/config.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';
import type { AgentSupervisionView } from '../src/supervision/supervisor.js';
import type { EventRecord, JobDeliverable, JobRecord, RoundRecord } from '../src/ledger/api.js';
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

  it('a shifted line range keeps the fingerprint: edits above a defect do not reset its streak (gh-216)', () => {
    // The carried blocker moves from 287-294 to 301-308 when a fix above it
    // lands; the identity that carries the ladder must survive the move.
    const before = blockerFingerprint(b('null deref on empty path', 'src/dispatch/pipeline.ts:287-294'));
    expect(blockerFingerprint(b('null deref on empty path', 'src/dispatch/pipeline.ts:301-308'))).toBe(before);
    // Recurrence count ADVANCES across the shift, and the ladder rung fires:
    // same defect in two consecutive rounds → advice `directive` (defaults 2/3/4).
    const history = [
      [b('null deref on empty path', 'src/dispatch/pipeline.ts:301-308')],
      [b('null deref on empty path', 'src/dispatch/pipeline.ts:287-294')],
    ];
    expect(consecutiveRecurrence(before, history)).toBe(2);
    expect(adviseRecurrence(2, DEFAULT_SILAS_CONFIG)).toBe('directive');
  });

  it('blockerLocationKey strips trailing line suffixes, normalizes separators and lowercases', () => {
    expect(blockerLocationKey('src/a.ts')).toBe('src/a.ts');
    expect(blockerLocationKey('src/a.ts:42')).toBe('src/a.ts');
    expect(blockerLocationKey('src/a.ts:42-48')).toBe('src/a.ts');
    expect(blockerLocationKey('src/a.ts#L42')).toBe('src/a.ts');
    expect(blockerLocationKey('src/a.ts#L42-L48')).toBe('src/a.ts');
    expect(blockerLocationKey('SRC\\A.TS:42')).toBe('src/a.ts');
    // padded input strips its suffix just the same: the findings parsers
    // accept surrounding whitespace without trimming it (boundedString)
    expect(blockerLocationKey('  src/a.ts:42-48  ')).toBe('src/a.ts');
    // only a TRAILING suffix is stripped — digits inside the path survive
    expect(blockerLocationKey('src/2.ts:7')).toBe('src/2.ts');
    expect(blockerLocationKey('src/file:42.ts')).toBe('src/file:42.ts');
  });

  it('two different blockers in one file stay distinct even at one identity path', () => {
    expect(blockerFingerprint(b('null deref on empty path', 'src/a.ts:10-20'))).not.toBe(
      blockerFingerprint(b('leaked handle on error path', 'src/a.ts:30-44')),
    );
    // same title, different file: still distinct
    expect(blockerFingerprint(b('null deref on empty path', 'src/a.ts:10-20'))).not.toBe(
      blockerFingerprint(b('null deref on empty path', 'src/b.ts:10-20')),
    );
  });

  it('a reworded title still mints a new fingerprint and breaks the streak (documented limit; semantic matching is gh-224)', () => {
    const before = blockerFingerprint(b('null deref on empty path', 'src/a.ts:10-20'));
    const after = blockerFingerprint(b('EMPTY_PATH dereference crashes render', 'src/a.ts:10-20'));
    expect(after).not.toBe(before);
    expect(
      consecutiveRecurrence(after, [
        [b('EMPTY_PATH dereference crashes render', 'src/a.ts:10-20')],
        [b('null deref on empty path', 'src/a.ts:10-20')],
      ]),
    ).toBe(1);
  });

  it('roundBlockerKeys: same-file same-title collisions tie-break on evidence; everyone else never sees it', () => {
    const left = { ...b('null deref on empty path', 'src/a.ts:10-20'), evidence: 'if (path === EMPTY) return path.length;' };
    const right = { ...b('null deref on empty path', 'src/a.ts:88-96'), evidence: 'const n = cache.get(EMPTY).size;' };
    const keys = roundBlockerKeys([left, right]);
    // distinct defects that share file/category/title stay distinct
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]?.startsWith(blockerFingerprint(left))).toBe(true);
    expect(keys[1]?.startsWith(blockerFingerprint(right))).toBe(true);
    // the tie-break is deterministic across rounds
    expect(roundBlockerKeys([left, right])).toEqual(keys);
    // a NON-colliding blocker never carries evidence in its key — evidence
    // churn between rounds can never reset its streak
    const solo = { ...b('same leak', 'src/a.ts:10-20'), evidence: 'totally different wording every round' };
    expect(roundBlockerKeys([solo])).toEqual([blockerFingerprint(b('same leak', 'src/a.ts:10-20'))]);
    expect(roundBlockerKeys([{ ...solo, evidence: 'other round other words' }])).toEqual(roundBlockerKeys([solo]));
  });

  it('roundBlockerKeys: indistinguishable collisions (missing or equal evidence) merge — documented limit', () => {
    const left = b('null deref on empty path', 'src/a.ts:10-20');
    const right = b('null deref on empty path', 'src/a.ts:88-96');
    const keys = roundBlockerKeys([left, right]);
    expect(keys[0]).toBe(keys[1]);
    const evLeft = { ...left, evidence: 'same quoted snippet' };
    const evRight = { ...right, evidence: 'SAME  quoted\nsnippet ' };
    const evKeys = roundBlockerKeys([evLeft, evRight]);
    // equal normalized evidence hashes to one augmented key — merge
    expect(evKeys[0]).toBe(evKeys[1]);
  });

  it('a colliding pair recurs on its augmented keys across rounds; a half-fixed pair breaks the streak', () => {
    const mk = (evidence: string) => ({ ...b('null deref on empty path', 'src/a.ts'), evidence });
    const left = mk('first defect snippet');
    const right = mk('second defect snippet');
    const keys = roundBlockerKeys([left, right]);
    if (keys[0] === undefined || keys[1] === undefined) {
      throw new Error('roundBlockerKeys must return one key per blocker');
    }
    const [leftKey, rightKey] = keys;
    expect(consecutiveRecurrence(leftKey, [[left, right], [left, right]])).toBe(2);
    expect(consecutiveRecurrence(rightKey, [[left, right], [left, right]])).toBe(2);
    // one defect fixed: the survivor no longer collides, drops its
    // augmentation — the augmented pair identity no longer exists in the
    // newest round, so the pair's streak ends and the survivor restarts
    // from its base key
    expect(consecutiveRecurrence(leftKey, [[left], [left, right]])).toBe(0);
    expect(
      consecutiveRecurrence(blockerFingerprint(left), [[left], [left, right]]),
    ).toBe(1);
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

  it('an unhandled verdict gets the first fix directive for a NEW blocker; recurrences keep the 2/3/4 ladder', () => {
    // The first NEEDS CHANGES verdict must hand the fix to the minion —
    // monitor here was the dead branch: no rung ever landed, no round 2 existed.
    expect(adviseFollowThrough(1, DEFAULT_SILAS_CONFIG)).toBe('directive');
    // same blocker twice → directive again; third → re-brief; fourth → escalate
    expect(adviseFollowThrough(2, DEFAULT_SILAS_CONFIG)).toBe('directive');
    expect(adviseFollowThrough(3, DEFAULT_SILAS_CONFIG)).toBe('rebrief');
    expect(adviseFollowThrough(4, DEFAULT_SILAS_CONFIG)).toBe('escalate');
    expect(adviseFollowThrough(9, DEFAULT_SILAS_CONFIG)).toBe('escalate');
    // no verdict rounds at all → nothing to direct
    expect(adviseFollowThrough(0, DEFAULT_SILAS_CONFIG)).toBe('monitor');
    // configured thresholds still floor at the first directive
    expect(adviseFollowThrough(1, { directiveAt: 5, rebriefAt: 6, escalateAt: 7 })).toBe('directive');
    expect(adviseFollowThrough(6, { directiveAt: 5, rebriefAt: 6, escalateAt: 7 })).toBe('rebrief');
  });
});

// ------------------------------------------------------------------
// Re-review freshness (the follow-up delivery signal)
// ------------------------------------------------------------------

describe('re-review freshness predicate', () => {
  const delivery = (payload: unknown): EventRecord => ({
    seq: 99,
    ts: '2026-09-21T00:00:00.000Z',
    kind: 'job.delivered',
    agentId: 'minion-1',
    jobId: 'job-x',
    roundId: null,
    lens: null,
    payload,
  });

  it('reads the head sha a delivery recorded, never a fabricated one', () => {
    expect(deliveredTargetSha(delivery({ sha: 'abc' }))).toBe('abc');
    expect(deliveredTargetSha(delivery({ agentId: 'a1' }))).toBeNull();
    expect(deliveredTargetSha(delivery({ sha: '' }))).toBeNull();
    expect(deliveredTargetSha(delivery({ sha: 7 }))).toBeNull();
    expect(deliveredTargetSha(delivery(null))).toBeNull();
  });

  it('warrants a round only when the delivery proves the head moved past the reviewed target', () => {
    // moved head → re-review due
    expect(followUpChangedTarget(delivery({ sha: 'sha-fixed' }), { targetRef: 'sha-reviewed' })).toBe(true);
    // same head the round already reviewed → no round
    expect(followUpChangedTarget(delivery({ sha: 'sha-reviewed' }), { targetRef: 'sha-reviewed' })).toBe(false);
    // no recorded head (initial dispatch deliveries) → cannot prove a move → no round
    expect(followUpChangedTarget(delivery({ agentId: 'a1' }), { targetRef: 'sha-reviewed' })).toBe(false);
    // no reviewed target → nothing to compare → no round
    expect(followUpChangedTarget(delivery({ sha: 'sha-fixed' }), { targetRef: null })).toBe(false);
    // event seqs are NOT freshness: this is the old always-true cross-domain bug
    const stale = delivery({ sha: 'sha-reviewed' });
    expect((stale as { seq: number }).seq > 50).toBe(true);
    expect(followUpChangedTarget(stale, { targetRef: 'sha-reviewed' })).toBe(false);
  });
});

// ------------------------------------------------------------------
// Conflicting PR rows (issue #215)
// ------------------------------------------------------------------

describe('silas digest conflictingPrs rows (issue #215)', () => {
  const dirtyCursor = (sha: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    repo: 'acme/app',
    branch: 'gru/job-conf',
    sha,
    merged: false,
    pr_open: true,
    mergeable_state: 'dirty',
    pr_number: 11,
    pr_url: 'https://github.com/acme/app/pull/11',
    ...overrides,
  });
  const digestOf = (h: Harness) =>
    computeSilasDigest({
      ledger: h.ledger,
      blockersForRound: async () => ({ blockers: [], note: null }),
      config: DEFAULT_SILAS_CONFIG,
      trigger: 'sweep',
    });
  const addDirtyJob = (
    h: Harness,
    jobId: string,
    sha = 'sha-11',
    cursorOverrides: Record<string, unknown> = {},
    opts: { deliverable?: JobDeliverable } = {},
  ): void => {
    h.ledger.addJob({
      id: jobId, repo: 'acme/app', title: `t-${jobId}`, briefing: 'b',
      ...(opts.deliverable !== undefined ? { deliverable: opts.deliverable } : {}),
    });
    h.ledger.setJobStatus(jobId, 'working');
    h.ledger.setJobPr(jobId, 'https://github.com/acme/app/pull/11');
    h.ledger.appendCustomEvent({ kind: BRANCH_STATE_EVENT, jobId, payload: dirtyCursor(sha, cursorOverrides) });
  };

  it('a dirty branch-state lists exactly one conflicting PR row and counts it actionable', async () => {
    const h = makeLedger();
    try {
      addDirtyJob(h, 'job-conf');
      const d = await digestOf(h);
      expect(d.conflictingPrs).toHaveLength(1);
      expect(d.conflictingPrs[0]).toMatchObject({
        jobId: 'job-conf',
        repo: 'acme/app',
        branch: 'gru/job-conf',
        prNumber: 11,
        prUrl: 'https://github.com/acme/app/pull/11',
        headSha: 'sha-11',
      });
      // No pr-conflict transition in the ledger (pre-#215 history): the
      // dirty cursor itself is the honest first-seen timestamp.
      expect(d.conflictingPrs[0]?.firstSeenAt).toBe(h.ledger.latestJobEvent('job-conf', BRANCH_STATE_EVENT)?.ts);
      expect(digestActionCount(d)).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('firstSeenAt is the oldest consecutive dirty cursor for the head, not a possibly-older transition', async () => {
    const h = makeLedger();
    try {
      addDirtyJob(h, 'job-conf');
      // The pr-conflict transition carries no head identity, so it must
      // not be attributed to this head's first-seen: the cursor walk owns
      // that timestamp.
      h.ledger.appendCustomEvent({
        kind: 'github.pr-conflict', jobId: 'job-conf', payload: { pr: 11, mergeable_state: 'dirty' },
      });
      const cursorTs = h.ledger.latestJobEvent('job-conf', BRANCH_STATE_EVENT)?.ts;
      const d = await digestOf(h);
      expect(d.conflictingPrs[0]?.firstSeenAt).toBe(cursorTs);
      // A dirty→dirty head move re-arms under the NEW head's own
      // first-observed cursor, never the previous head's history.
      const moved = h.ledger.appendCustomEvent({
        kind: BRANCH_STATE_EVENT, jobId: 'job-conf', payload: dirtyCursor('sha-12'),
      });
      const d2 = await digestOf(h);
      expect(d2.conflictingPrs.map((row) => row.headSha)).toEqual(['sha-12']);
      expect(d2.conflictingPrs[0]?.firstSeenAt).toBe(moved.ts);
    } finally {
      h.cleanup();
    }
  });

  it('a dirty cursor with no head SHA lists no row (no fingerprint, no retirement — fail closed)', async () => {
    const h = makeLedger();
    try {
      addDirtyJob(h, 'job-nosha', '', { sha: '' });
      const d = await digestOf(h);
      expect(d.conflictingPrs).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a dirty PR on a DELIVERED repair lane keeps its row through the publish boundary', async () => {
    const h = makeLedger();
    try {
      // Delivered lane whose phase carries a directive-admission repair
      // start: the recorded phase seq is nonzero, so a publish recheck
      // that substitutes zero for delivered lanes would drop the row.
      addJobWithDelivery(h.ledger, 'job-delivered-dirty');
      h.ledger.setJobStatus('job-delivered-dirty', 'delivered');
      h.ledger.setJobPr('job-delivered-dirty', 'https://github.com/acme/app/pull/31');
      h.ledger.appendCustomEvent({
        kind: BRANCH_STATE_EVENT, jobId: 'job-delivered-dirty', payload: dirtyCursor('sha-31'),
      });
      const d = await digestOf(h);
      expect(d.conflictingPrs.map((row) => row.jobId)).toEqual(['job-delivered-dirty']);
    } finally {
      h.cleanup();
    }
  });

  it('a conflict offer is retracted when a directive is admitted during the compute await', async () => {
    const h = makeLedger();
    try {
      // The await job is created first and the conflict candidate a second
      // later, so the candidate is deterministically visited first.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
      h.ledger.addJob({ id: 'job-await', repo: 'fixture-app', title: 'other', briefing: 'b' });
      h.ledger.setJobStatus('job-await', 'working');
      const round = h.ledger.addRound({ jobId: 'job-await', lenses: ['blind'] });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('job-await', 'in-review');
      vi.setSystemTime(new Date('2026-10-04T10:00:01.000Z'));
      addDirtyJob(h, 'job-race-conf');
      vi.useRealTimers();
      let raced = false;
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => {
          if (!raced) {
            raced = true;
            const intent = h.ledger.beginDirectiveIntent({ jobId: 'job-race-conf', directive: 'rebase', holder: 'silas-ops' });
            const sent = h.ledger.appendCustomEvent({
              kind: 'silas.directive-sent', jobId: 'job-race-conf', payload: { request_id: intent.record.requestId, minion_id: 'min-race' },
            });
            h.ledger.recordDirectiveAdmission({ requestId: intent.record.requestId, minionId: 'min-race', eventSeq: sent.seq });
          }
          return { blockers: [], note: null };
        },
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(raced).toBe(true);
      expect(digest.conflictingPrs).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a pre-#215 dirty stretch (no transition event) still retires on its head directive', async () => {
    const h = makeLedger();
    try {
      addDirtyJob(h, 'job-legacy-dirty');
      // No github.pr-conflict event exists; the dirty cursor itself is
      // the retirement watermark.
      h.ledger.appendCustomEvent({
        kind: 'silas.directive-sent', jobId: 'job-legacy-dirty', payload: { blocker_fingerprint: 'pr-conflict:sha-11' },
      });
      expect((await digestOf(h)).conflictingPrs).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('clean, merged, closed or absent states list no row', async () => {
    const h = makeLedger();
    try {
      addDirtyJob(h, 'job-clean', 'sha-11', { mergeable_state: 'clean' });
      addDirtyJob(h, 'job-merged', 'sha-11', { merged: true });
      addDirtyJob(h, 'job-closed', 'sha-11', { pr_open: false });
      const d = await digestOf(h);
      expect(d.conflictingPrs).toEqual([]);
      expect(digestActionCount(d)).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it('review deliverables and non-live lanes never list a conflict', async () => {
    const h = makeLedger();
    try {
      addDirtyJob(h, 'job-review', 'sha-11', {}, { deliverable: 'review' });
      h.ledger.addJob({ id: 'job-blocked', repo: 'acme/app', title: 't-blocked', briefing: 'b' });
      h.ledger.setJobStatus('job-blocked', 'working');
      h.ledger.setJobPr('job-blocked', 'https://github.com/acme/app/pull/12');
      h.ledger.appendCustomEvent({ kind: BRANCH_STATE_EVENT, jobId: 'job-blocked', payload: dirtyCursor('sha-12') });
      h.ledger.setJobStatus('job-blocked', 'blocked');
      const d = await digestOf(h);
      expect(d.conflictingPrs).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a live directive or pending re-brief suppresses the row; a failed directive releases it', async () => {
    const h = makeLedger();
    try {
      addDirtyJob(h, 'job-directive');
      const intent = h.ledger.beginDirectiveIntent({ jobId: 'job-directive', directive: 'rebase the lane', holder: 'silas-ops' });
      expect((await digestOf(h)).conflictingPrs).toEqual([]);
      h.ledger.failDirective({ requestId: intent.record.requestId, reason: 'no lane and no minion' });
      expect((await digestOf(h)).conflictingPrs.map((row) => row.jobId)).toEqual(['job-directive']);
    } finally {
      h.cleanup();
    }
    const h2 = makeLedger();
    try {
      addDirtyJob(h2, 'job-rebrief');
      h2.ledger.beginPendingRebrief({ jobId: 'job-rebrief', note: 'retry the repair', briefing: 'b' });
      expect((await digestOf(h2)).conflictingPrs).toEqual([]);
    } finally {
      h2.cleanup();
    }
  });

  it('an in-flight verification suppresses the row; its settlement releases it', async () => {
    const h = makeLedger();
    try {
      addDirtyJob(h, 'job-verify');
      h.ledger.appendCustomEvent({ kind: 'verification.started', jobId: 'job-verify', payload: { run_id: 'run-1', scope: 'full' } });
      expect((await digestOf(h)).conflictingPrs).toEqual([]);
      h.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: 'job-verify', payload: { run_id: 'run-1', scope: 'full' } });
      expect((await digestOf(h)).conflictingPrs.map((row) => row.jobId)).toEqual(['job-verify']);
    } finally {
      h.cleanup();
    }
  });

  it('a pr-conflict directive retires exactly its head after the conflict; a new dirty head re-arms', async () => {
    const h = makeLedger();
    try {
      addDirtyJob(h, 'job-fp');
      // A rung BEFORE the conflict transition answers nothing.
      h.ledger.appendCustomEvent({
        kind: 'silas.directive-sent', jobId: 'job-fp', payload: { blocker_fingerprint: 'pr-conflict:sha-11' },
      });
      h.ledger.appendCustomEvent({ kind: 'github.pr-conflict', jobId: 'job-fp', payload: { pr: 11 } });
      expect((await digestOf(h)).conflictingPrs.map((row) => row.jobId)).toEqual(['job-fp']);
      // An unrelated fingerprint after the conflict retires nothing either.
      h.ledger.appendCustomEvent({
        kind: 'silas.directive-sent', jobId: 'job-fp', payload: { blocker_fingerprint: 'verification-failure:full@run-1' },
      });
      expect((await digestOf(h)).conflictingPrs.map((row) => row.jobId)).toEqual(['job-fp']);
      // The exact head fingerprint after the conflict retires the row.
      h.ledger.appendCustomEvent({
        kind: 'silas.directive-sent', jobId: 'job-fp', payload: { blocker_fingerprint: 'pr-conflict:sha-11' },
      });
      expect((await digestOf(h)).conflictingPrs).toEqual([]);
      // A later dirty cursor at a NEW head re-arms the row.
      h.ledger.appendCustomEvent({ kind: BRANCH_STATE_EVENT, jobId: 'job-fp', payload: dirtyCursor('sha-12') });
      expect((await digestOf(h)).conflictingPrs.map((row) => row.headSha)).toEqual(['sha-12']);
    } finally {
      h.cleanup();
    }
  });
});

// ------------------------------------------------------------------
// Digest on a real ledger
// ------------------------------------------------------------------

interface Harness {
  ledger: LedgerApi & DigestLedger;
  bus: EventBus;
  /** Raw handle for deterministic test-seam row timestamps. */
  db: LedgerDb;
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
    db,
    cleanup() {
      db.close();
    },
  };
}

function addJobWithDelivery(ledger: LedgerApi, jobId: string, opts: { prUrl?: string; deliverable?: JobDeliverable } = {}): JobRecord {
  const job = ledger.addJob({
    id: jobId, repo: 'fixture-app', title: `t-${jobId}`, briefing: 'b',
    ...(opts.deliverable !== undefined ? { deliverable: opts.deliverable } : {}),
  });
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

  it('an upgraded pre-deliverable delivered implementation keeps null deliverable and stays PR-overdue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-e18-upgrade-'));
    try {
      // A database shaped before migration 19: null deliverable is the only
      // pre-existing value, and it must remain PR-owing through the upgrade.
      const legacy = new LedgerDb(dir, { migrations: MIGRATIONS.filter((migration) => migration.id <= 18) });
      const legacyApi = new LedgerApi(legacy.handle);
      // The pre-18 schema has no deliverable column, so the legacy row is
      // inserted at its own shape (the product's current addJob correctly
      // writes the column the old schema cannot carry).
      const ts = new Date().toISOString();
      legacy.handle
        .prepare(`INSERT INTO jobs (id, repo, title, status, base_branch, pr_url, note, briefing, created_at, updated_at)
                  VALUES (?, ?, ?, 'working', NULL, NULL, NULL, ?, ?, ?)`)
        .run('legacy-impl', 'fixture-app', 't', 'b', ts, ts);
      legacyApi.appendCustomEvent({ kind: 'job.status', jobId: 'legacy-impl', payload: { from: 'dispatched', to: 'working' } });
      legacyApi.appendCustomEvent({ kind: 'job.handoff', jobId: 'legacy-impl', payload: {} });
      legacyApi.appendCustomEvent({ kind: 'job.delivered', jobId: 'legacy-impl', payload: { agentId: 'a1' } });
      legacy.close();
      const upgraded = new LedgerDb(dir);
      const api = new LedgerApi(upgraded.handle);
      try {
        expect(api.getJob('legacy-impl')?.deliverable).toBeNull();
        const digest = await computeSilasDigest({
          ledger: api,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
        });
        expect(digest.deliveredWithoutPr.map((row) => row.jobId)).toEqual(['legacy-impl']);
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes a delivered review/artifact job from PR-overdue follow-through (E19 carve-out)', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'review-job', { deliverable: 'review' });
      addJobWithDelivery(h.ledger, 'artifact-job', { deliverable: 'artifact' });
      addJobWithDelivery(h.ledger, 'investigation-job', { deliverable: 'investigation' });
      addJobWithDelivery(h.ledger, 'impl-job');
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      // Only the PR-owing lane is follow-through due; a reviewer's findings
      // handback and an artifact handback are their own deliverables and
      // must never be chased as a missing PR.
      expect(digest.deliveredWithoutPr.map((row) => row.jobId)).toEqual(['impl-job']);
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

  it('the delivered-without-PR row carries the lane and session coordinates the skill sends Silas to', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-lane', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-lane', 'working');
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-lane', payload: { agentId: 'a1' } });
      h.ledger.registerAgent({
        id: 'min-lane',
        role: 'minion',
        jobId: 'job-lane',
        sessionFile: '/sessions/min-lane.jsonl',
      });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        worktrees: {
          listWorktrees: (scope?: { jobId?: string }) =>
            scope?.jobId === 'job-lane'
              ? [
                  { kind: 'job' as const, status: 'active' as const, path: '/lanes/job-lane', branch: 'gru/job-lane' },
                  { kind: 'review' as const, status: 'active' as const, path: '/lanes/rev', branch: null },
                ]
              : [],
        },
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'job.delivered',
      });
      expect(digest.deliveredWithoutPr).toEqual([
        {
          jobId: 'job-lane',
          repo: 'fixture-app',
          branch: 'gru/job-lane',
          lanePath: '/lanes/job-lane',
          minionSessionFile: '/sessions/min-lane.jsonl',
          deliveredAt: expect.any(String),
        },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it('the delivered-without-PR pick never lands on a review-only session (Gru ruling 2026-09-29)', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-reviewer-safe', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-reviewer-safe', 'working');
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-reviewer-safe', payload: { agentId: 'a1' } });
      h.ledger.registerAgent({ id: 'min-impl', role: 'minion', jobId: 'job-reviewer-safe', sessionFile: '/sessions/min-impl.jsonl' });
      // The fallback review worker registers as the review-worker role and
      // is NEWEST — it must never win the digest's minion-session pick.
      h.ledger.registerAgent({ id: 'rev-fallback', role: 'perkins', jobId: 'job-reviewer-safe', sessionFile: '/sessions/rev-fallback.jsonl' });
      const bump = h.db.handle.prepare('UPDATE agents SET created_at = ?, updated_at = ? WHERE id = ?');
      bump.run('2026-09-29T12:00:01.000Z', '2026-09-29T12:00:01.000Z', 'min-impl');
      bump.run('2026-09-29T12:00:02.000Z', '2026-09-29T12:00:02.000Z', 'rev-fallback');
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        worktrees: { listWorktrees: () => [] },
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(digest.deliveredWithoutPr).toHaveLength(1);
      expect(digest.deliveredWithoutPr[0]?.minionSessionFile).toBe('/sessions/min-impl.jsonl');
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

  it('the stalled-lane pick never lands on a review-only session (Gru ruling 2026-09-29)', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-stall-safe', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-stall-safe', 'working');
      h.ledger.registerAgent({ id: 'min-stalled', role: 'minion', jobId: 'job-stall-safe' });
      h.ledger.setAgentState('min-stalled', 'idle');
      const round = h.ledger.addRound({ jobId: 'job-stall-safe', lenses: ['blind'] });
      h.ledger.registerAgent({ id: 'rev-fresh', role: 'minion', roundId: round.id, jobId: 'job-stall-safe' });
      const bump = h.db.handle.prepare('UPDATE agents SET created_at = ?, updated_at = ? WHERE id = ?');
      bump.run('2026-09-29T12:00:01.000Z', '2026-09-29T12:00:01.000Z', 'min-stalled');
      bump.run('2026-09-29T12:00:02.000Z', '2026-09-29T12:00:02.000Z', 'rev-fresh');
      const now = Date.now();
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
        now: () => now + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1_000,
      });
      expect(digest.stalledWorking).toHaveLength(1);
      expect(digest.stalledWorking[0]?.minionId).toBe('min-stalled');
    } finally {
      h.cleanup();
    }
  });
  it('a supervision-stopped worker waits, never stalls — and a live worker still flags', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-walled', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-walled', 'working');
      h.ledger.registerAgent({ id: 'min-walled', role: 'minion', jobId: 'job-walled' });
      h.ledger.setAgentState('min-walled', 'idle');
      const now = Date.now();
      const base = {
        agentId: 'min-walled',
        role: 'minion' as const,
        slotId: null,
        restarts: 2,
        openTurn: false,
        openToolCalls: 0,
        lastEventAt: null,
        lastFileBytes: null,
      };
      let view: AgentSupervisionView | null = {
        ...base,
        state: 'stopped',
        breakerOpen: true,
        stopReason: 'quota_wall',
      };
      const digestOf = () =>
        computeSilasDigest({
          ledger: h.ledger,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
          now: () => now + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1_000,
          supervisionFor: (agentId) =>
            (agentId === 'min-other-live' || agentId === 'min-disposed' || agentId === 'min-only-dead'
              ? null
              : view),
        });

      // Stopped worker: waiting on a human re-arm with a recorded cause —
      // the board says waiting, so the digest must not fire a stall wake.
      expect((await digestOf()).stalledWorking).toHaveLength(0);
      // Breaker-open alone is the same wait even before the state settles.
      view = { ...base, state: 'watching', breakerOpen: true, stopReason: null };
      expect((await digestOf()).stalledWorking).toHaveLength(0);
      // No stop record: the genuine stall still flags (the exemption is not
      // a blanket mute).
      view = null;
      expect((await digestOf()).stalledWorking).toHaveLength(1);
      // The shared-value arm (literally one fixture file now carries the
      // ids/stamps for both suites — see the fixture-driven test below):
      // a stopped worker newer than the older live record marks the lane
      // WAITING on the board, so this stall channel must NOT wake it.
      // Stamps are seeded under fake timers so the strict-newer relation
      // never depends on the wall clock advancing between two writes.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-09-23T08:00:00.000Z'));
        h.ledger.registerAgent({ id: 'min-other-live', role: 'minion', jobId: 'job-walled' });
        h.ledger.setAgentState('min-other-live', 'idle');
        view = { ...base, state: 'stopped', breakerOpen: true, stopReason: 'quota_wall' };
        // Make the stopped worker the newest record: the stop is the lane's
        // current worker, and the board pins the same expectation.
        vi.setSystemTime(new Date('2026-09-23T09:00:00.000Z'));
        h.ledger.setAgentState('min-walled', 'idle');
      } finally {
        vi.useRealTimers();
      }
      const mixed = await digestOf();
      expect(mixed.stalledWorking).toHaveLength(0);
      // The mirrored direction: a stop OLDER than the live worker does not
      // wait, and the live worker's silence stalls again.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-09-23T10:00:00.000Z'));
        h.ledger.setAgentState('min-other-live', 'idle');
      } finally {
        vi.useRealTimers();
      }
      const reDispatched = await digestOf();
      expect(reDispatched.stalledWorking).toHaveLength(1);
      expect(reDispatched.stalledWorking[0]?.minionId).toBe('min-other-live');
      // A DISPOSED unsupervised record is not a live worker: a lane with a
      // current stopped worker plus a dead record stays waiting and is
      // never woken as stalled (round-3 finding).
      h.ledger.addJob({ id: 'job-dead', repo: 'fixture-app', title: 'dead', briefing: 'b' });
      h.ledger.setJobStatus('job-dead', 'working');
      h.ledger.registerAgent({ id: 'min-stopped-dead', role: 'minion', jobId: 'job-dead' });
      h.ledger.setAgentState('min-stopped-dead', 'idle');
      h.ledger.registerAgent({ id: 'min-disposed', role: 'minion', jobId: 'job-dead' });
      h.ledger.setAgentState('min-disposed', 'disposed');
      const dead = await digestOf();
      expect(dead.stalledWorking.filter((row) => row.jobId === 'job-dead')).toHaveLength(0);
      // A lane whose ONLY worker is a dead record has no stop to wait on:
      // the board shows COLD and the digest still wakes — both surfaces
      // agree the lane is not running (round-4 definition).
      h.ledger.addJob({ id: 'job-only-dead', repo: 'fixture-app', title: 'dead-only', briefing: 'b' });
      h.ledger.setJobStatus('job-only-dead', 'working');
      h.ledger.registerAgent({ id: 'min-only-dead', role: 'minion', jobId: 'job-only-dead' });
      h.ledger.setAgentState('min-only-dead', 'disposed');
      const onlyDead = await digestOf();
      expect(onlyDead.stalledWorking.filter((row) => row.jobId === 'job-only-dead')).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('the stall boundary matches the board (>): exactly at the threshold is not stalled', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-edge', repo: 'fixture-app', title: 'edge', briefing: 'b' });
      h.ledger.setJobStatus('job-edge', 'working');
      h.ledger.registerAgent({ id: 'min-edge', role: 'minion', jobId: 'job-edge' });
      h.ledger.setAgentState('min-edge', 'idle');
      const activity = h.ledger.getAgent('min-edge')!.lastActivity!;
      const at = Date.parse(activity);
      const digestAt = (nowMs: number) =>
        computeSilasDigest({
          ledger: h.ledger,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
          now: () => nowMs,
        });
      // The board's isStalledWorking uses `>` ("past the window"); the
      // digest must agree exactly at the boundary (round-5 finding).
      expect(
        (await digestAt(at + DEFAULT_SILAS_CONFIG.stallThresholdMs)).stalledWorking,
      ).toHaveLength(0);
      expect(
        (await digestAt(at + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1)).stalledWorking,
      ).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('the shared cross-surface fixture drives the digest exactly as the board pins it', async () => {
    // ONE fixture file is consumed by this suite and by
    // web/src/lib/board-bands.test.ts: same ids/stamps/views for both the
    // web waiting predicate and this digest stall predicate (followup
    // review A0/edge0/V2). Stamps are seeded deterministically under fake
    // timers — never by racing the wall clock between two writes.
    const fixture = JSON.parse(
      readFileSync(join(import.meta.dirname, 'fixtures', 'stop-attribution.json'), 'utf-8'),
    ) as {
      readonly digestNow: string;
      readonly freshRegistrationAt: string;
      readonly cases: readonly {
        readonly name: string;
        readonly agents: readonly {
          readonly id: string;
          readonly jobId: string;
          readonly state: string;
          readonly lastActivity: string | null;
          readonly createdAt: string;
          readonly supervision: {
            readonly state: 'watching' | 'restarting' | 'stopped';
            readonly restarts: number;
            readonly breakerOpen: boolean;
            readonly stopReason: string | null;
            readonly stoppedAt?: string | null;
          };
        }[];
        readonly digest: { readonly stalled: boolean };
      }[];
    };
    expect(fixture.cases.length).toBeGreaterThan(2);
    for (const testCase of fixture.cases) {
      const h = makeLedger();
      try {
        h.ledger.addJob({ id: 'job-1', repo: 'fixture-app', title: testCase.name, briefing: 'b' });
        h.ledger.setJobStatus('job-1', 'working');
        const supervisionById = new Map(testCase.agents.map((agent) => [agent.id, agent]));
        vi.useFakeTimers();
        try {
          for (const agent of testCase.agents) {
            // Registration stamps the row's createdAt; an inactive worker
            // keeps last_activity NULL and orders by that createdAt.
            vi.setSystemTime(new Date(agent.lastActivity ?? agent.createdAt ?? fixture.freshRegistrationAt));
            h.ledger.registerAgent({ id: agent.id, role: 'minion', jobId: agent.jobId });
            if (agent.lastActivity !== null) h.ledger.setAgentState(agent.id, 'idle');
          }
        } finally {
          vi.useRealTimers();
        }
        const digest = await computeSilasDigest({
          ledger: h.ledger,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
          now: () => Date.parse(fixture.digestNow),
          supervisionFor: (agentId) => {
            const agent = supervisionById.get(agentId);
            if (agent === undefined) return null;
            const view: AgentSupervisionView = {
              agentId,
              role: 'minion',
              slotId: null,
              ...agent.supervision,
              openTurn: false,
              openToolCalls: 0,
              lastEventAt: null,
              lastFileBytes: null,
            };
            return view;
          },
        });
        expect(
          digest.stalledWorking.length,
          `${testCase.name}: digest ${testCase.digest.stalled ? 'must' : 'must not'} stall`,
        ).toBe(testCase.digest.stalled ? 1 : 0);
      } finally {
        h.cleanup();
      }
    }
  });

  it('supervisionLookup binds the supervisor views exactly as main.ts wires them', () => {
    // Final independent review T2: the factory is the tested seam; a
    // dropped or broken binding would silently re-enable stall wakes for
    // stopped lanes. Twelve-followthrough A4: the lookup is LATE-BOUND —
    // the getter is read per call, so a handle assigned after construction
    // is seen instead of freezing a null supervisor.
    const view: AgentSupervisionView = {
      agentId: 'wired', role: 'minion', slotId: null, state: 'stopped', restarts: 2,
      breakerOpen: true, stopReason: 'quota_wall', openTurn: false, openToolCalls: 0,
      lastEventAt: null, lastFileBytes: null,
    };
    let current: { readonly viewFor: (agentId: string) => AgentSupervisionView | null } | null = null;
    const lookup = supervisionLookup(() => current);
    // A missing supervisor (not yet constructed at boot) reads as no view.
    expect(lookup('wired')).toBeNull();
    current = { viewFor: (agentId) => (agentId === 'wired' ? view : null) };
    expect(lookup('wired')).toBe(view);
    expect(lookup('other')).toBeNull();
    expect(supervisionLookup(() => null)('wired')).toBeNull();
  });

  it('the main assembly wires the supervisor stop truth into the driver (assembly alarm)', () => {
    // Tracked-review V2: the behavior has unit coverage but no assembly
    // pin — dropping the supervisionFor wiring in main.ts would silently
    // re-enable stall wakes for stopped lanes and no behavioral test would
    // fail. Twelve-followthrough A4: the pin requires the late-bound
    // getter form, not an early-captured value. This is the repo's
    // established source-drift alarm pattern.
    const mainSource = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(mainSource).toMatch(/supervisionFor:\s*supervisionLookup\(\s*\(\)\s*=>\s*supervisor\s*\)/);
    expect(mainSource).toMatch(/import\s*\{[^}]*\bsupervisionLookup\b[^}]*\}\s*from\s*'\.\/dispatch\/silas-driver\.js'/);
  });

  it('a fresh delivery after a changes-requested verdict is re-review due, not directive-due', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-fix', { prUrl: 'https://git.example.invalid/o/r/pull/7' });
      const round: RoundRecord = h.ledger.addRound({ jobId: 'job-fix', lenses: ['blind'], targetRef: 'sha-reviewed' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('job-fix', 'in-review');
      // Silas directive rung lands; the lane returns to working; the minion's
      // follow-up turn produces a NEW head (the delivery signal records it).
      h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-fix', payload: {} });
      h.ledger.setJobStatus('job-fix', 'working');
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-fix', payload: { sha: 'sha-fixed' } });

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

  it('re-arms only a proven same-head service-restart abort once, not cancelled or unexplained aborts', async () => {
    const h = makeLedger();
    try {
      const digestOf = () => computeSilasDigest({ ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
      addJobWithDelivery(h.ledger, 'clean', { prUrl: 'https://git.example.invalid/pull/clean' });
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'clean', payload: { sha: 'sha-clean' } });
      const round = h.ledger.addRound({ jobId: 'clean', targetRef: 'sha-clean' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setJobStatus('clean', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'silas.review-triggered', jobId: 'clean', payload: { route: 'perkins', round_id: round.id } });
      h.ledger.setRoundStatus(round.id, 'aborted');
      expect((await digestOf()).prWithoutReview).toEqual([]);
      h.ledger.appendCustomEvent({ kind: 'round.perkins-incomplete', jobId: 'clean', roundId: round.id, payload: { reason: 'cancelled' } });
      expect((await digestOf()).prWithoutReview).toEqual([]);
      h.ledger.appendCustomEvent({ kind: 'round.perkins-incomplete', jobId: 'clean', roundId: round.id, payload: { reason: 'service_restart' } });
      expect((await digestOf()).prWithoutReview).toMatchObject([
        { jobId: 'clean', cleanAbort: { roundId: round.id, ruleId: 'clean-abort-service-restart' } },
      ]);
      h.ledger.appendCustomEvent({ kind: 'silas.review-triggered', jobId: 'clean', payload: {
        route: 'perkins', rule_id: 'clean-abort-service-restart', source_round_id: round.id,
      } });
      expect((await digestOf()).prWithoutReview).toEqual([]);
    } finally { h.cleanup(); }
  });

  it('retires a clean-abort re-arm on the state it was answered by, keeping failed and deferred attempts eligible', async () => {
    const h = makeLedger();
    try {
      const digestOf = () => computeSilasDigest({ ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
      const abortProof = (jobId: string, sha: string): ReturnType<LedgerApi['addRound']> => {
        addJobWithDelivery(h.ledger, jobId, { prUrl: `https://git.example.invalid/pull/${jobId}` });
        h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha } });
        const round = h.ledger.addRound({ jobId, targetRef: sha });
        h.ledger.setRoundStatus(round.id, 'live');
        h.ledger.setJobStatus(jobId, 'in-review');
        h.ledger.setRoundStatus(round.id, 'aborted');
        h.ledger.appendCustomEvent({ kind: 'round.perkins-incomplete', jobId, roundId: round.id, payload: { reason: 'service_restart' } });
        return round;
      };

      // Failed fallback attempts and 409 deferrals answer nothing.
      const answered = abortProof('clean-answered', 'sha-answered');
      expect((await digestOf()).prWithoutReview).toMatchObject([{ jobId: 'clean-answered', cleanAbort: { roundId: answered.id } }]);
      h.ledger.appendCustomEvent({ kind: 'job.fallback-review', jobId: 'clean-answered', payload: { gate: true, phase: 'unavailable' } });
      expect((await digestOf()).prWithoutReview).toMatchObject([{ jobId: 'clean-answered' }]);
      h.ledger.appendCustomEvent({ kind: 'job.fallback-review', jobId: 'clean-answered', payload: { gate: true, phase: 'blocked' } });
      expect((await digestOf()).prWithoutReview).toMatchObject([{ jobId: 'clean-answered' }]);
      h.ledger.appendCustomEvent({ kind: 'silas.review-deferred', jobId: 'clean-answered', payload: {
        reason: 'fallback_unavailable', rule_id: 'clean-abort-service-restart', source_round_id: answered.id,
      } });
      expect((await digestOf()).prWithoutReview).toMatchObject([{ jobId: 'clean-answered' }]);

      // An intervening ACCEPTED request without the rule receipt retires it.
      h.ledger.appendCustomEvent({ kind: 'silas.review-triggered', jobId: 'clean-answered', payload: { route: 'bmad-review-fallback' } });
      expect((await digestOf()).prWithoutReview).toEqual([]);

      // A fallback that engaged and then failed releases the row again.
      const lost = abortProof('clean-gate-lost', 'sha-lost');
      h.ledger.appendCustomEvent({ kind: 'silas.review-triggered', jobId: 'clean-gate-lost', payload: { route: 'bmad-review-fallback' } });
      h.ledger.appendCustomEvent({ kind: 'job.fallback-review', jobId: 'clean-gate-lost', payload: { gate: true, phase: 'started' } });
      expect((await digestOf()).prWithoutReview).toEqual([]);
      h.ledger.appendCustomEvent({ kind: 'job.fallback-review', jobId: 'clean-gate-lost', payload: { gate: true, phase: 'blocked' } });
      expect((await digestOf()).prWithoutReview).toMatchObject([{ jobId: 'clean-gate-lost', cleanAbort: { roundId: lost.id } }]);
    } finally { h.cleanup(); }
  });

  it('an unavailable fallback does not retire the generic review-overdue row; a blocked gate still does', async () => {
    const h = makeLedger();
    try {
      const digestOf = () => computeSilasDigest({ ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
      addJobWithDelivery(h.ledger, 'job-unavailable', { prUrl: 'https://git.example.invalid/o/r/pull/31' });
      addJobWithDelivery(h.ledger, 'job-gate-blocked', { prUrl: 'https://git.example.invalid/o/r/pull/32' });
      const due = async (): Promise<string[]> =>
        (await digestOf()).prWithoutReview.map((row) => row.jobId).sort();
      expect(await due()).toEqual(['job-gate-blocked', 'job-unavailable']);
      // The gate never engaged: nothing reviewed the state, the row stays.
      h.ledger.appendCustomEvent({ kind: 'job.fallback-review', jobId: 'job-unavailable', payload: { gate: true, phase: 'unavailable' } });
      expect(await due()).toEqual(['job-gate-blocked', 'job-unavailable']);
      // The gate engaged and owns the lane even when it gives up.
      h.ledger.appendCustomEvent({ kind: 'job.fallback-review', jobId: 'job-gate-blocked', payload: { gate: true, phase: 'blocked' } });
      expect(await due()).toEqual(['job-unavailable']);
    } finally { h.cleanup(); }
  });

  it('a queued-route trigger answers only while its handoff arms a review', async () => {
    const h = makeLedger();
    try {
      const digestOf = () => computeSilasDigest({ ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
      addJobWithDelivery(h.ledger, 'clean-queued', { prUrl: 'https://git.example.invalid/pull/clean-queued' });
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'clean-queued', payload: { sha: 'sha-queued' } });
      const round = h.ledger.addRound({ jobId: 'clean-queued', targetRef: 'sha-queued' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setJobStatus('clean-queued', 'in-review');
      h.ledger.setRoundStatus(round.id, 'aborted');
      h.ledger.appendCustomEvent({ kind: 'round.perkins-incomplete', jobId: 'clean-queued', roundId: round.id, payload: { reason: 'service_restart' } });
      expect((await digestOf()).prWithoutReview).toMatchObject([{ jobId: 'clean-queued', cleanAbort: { roundId: round.id } }]);

      // A queued handoff owns the intent while it is pending...
      h.ledger.appendCustomEvent({ kind: 'silas.review-triggered', jobId: 'clean-queued', payload: { route: 'queued' } });
      expect((await digestOf()).prWithoutReview).toEqual([]);
      // ...but a handoff that ended without arming answers nothing.
      h.ledger.appendCustomEvent({ kind: 'job.review-handoff-failed', jobId: 'clean-queued', payload: { error: 'no fallback gate' } });
      expect((await digestOf()).prWithoutReview).toMatchObject([{ jobId: 'clean-queued', cleanAbort: { roundId: round.id } }]);
      // A NEWER queued request is not negated by the older handoff failure.
      h.ledger.appendCustomEvent({ kind: 'silas.review-triggered', jobId: 'clean-queued', payload: { route: 'queued' } });
      expect((await digestOf()).prWithoutReview).toEqual([]);
      // An armed handoff is the authoritative answer.
      h.ledger.appendCustomEvent({ kind: 'job.review-handoff-started', jobId: 'clean-queued', payload: { requestSeq: 1, route: 'perkins' } });
      expect((await digestOf()).prWithoutReview).toEqual([]);
    } finally { h.cleanup(); }
  });

  it('treats service_restart_missing_review_lane as the same proven clean abort (#113)', async () => {
    const h = makeLedger();
    try {
      const digestOf = () => computeSilasDigest({ ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
      addJobWithDelivery(h.ledger, 'lane-missing', { prUrl: 'https://git.example.invalid/pull/lane-missing' });
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'lane-missing', payload: { sha: 'sha-lane' } });
      const round = h.ledger.addRound({ jobId: 'lane-missing', targetRef: 'sha-lane' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setJobStatus('lane-missing', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'silas.review-triggered', jobId: 'lane-missing', payload: { route: 'perkins', round_id: round.id } });
      h.ledger.setRoundStatus(round.id, 'aborted');
      h.ledger.appendCustomEvent({ kind: 'round.perkins-incomplete', jobId: 'lane-missing', roundId: round.id, payload: { reason: 'service_restart_missing_review_lane' } });
      expect((await digestOf()).prWithoutReview).toMatchObject([
        { jobId: 'lane-missing', cleanAbort: { roundId: round.id, ruleId: 'clean-abort-service-restart' } },
      ]);
      h.ledger.appendCustomEvent({ kind: 'silas.review-triggered', jobId: 'lane-missing', payload: {
        route: 'perkins', rule_id: 'clean-abort-service-restart', source_round_id: round.id,
      } });
      expect((await digestOf()).prWithoutReview).toEqual([]);
    } finally { h.cleanup(); }
  });

  it('an unresolved re-brief fences first and changed-head reviews; a late delivery cannot clear it', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-first', { prUrl: 'https://git.example.invalid/o/r/pull/21' });
      addJobWithDelivery(h.ledger, 'job-moved', { prUrl: 'https://git.example.invalid/o/r/pull/22' });
      const round = h.ledger.addRound({ jobId: 'job-moved', lenses: ['blind'], targetRef: 'sha-reviewed' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setJobStatus('job-moved', 'in-review');
      h.ledger.setJobStatus('job-moved', 'working');
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-moved', payload: { sha: 'sha-fixed' } });
      const digestOf = () =>
        computeSilasDigest({
          ledger: h.ledger,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
        });

      // Both are review-due states before the re-brief requests land.
      expect((await digestOf()).prWithoutReview.map((row) => row.jobId).sort()).toEqual(['job-first', 'job-moved']);

      // The re-brief requests are admitted (durable markers, workers live).
      h.ledger.beginPendingRebrief({ jobId: 'job-first', note: 'n1', briefing: 'b' });
      const movedMarkers = h.ledger.beginPendingRebrief({ jobId: 'job-moved', note: 'n2', briefing: 'b' });
      const fenced = await digestOf();
      expect(fenced.prWithoutReview).toEqual([]);
      expect(digestActionCount(fenced)).toBe(0);

      // A late delivery from the pre-re-brief worker, and status transitions
      // around it, do not release the fence.
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-first', payload: { sha: 'late-old-head' } });
      h.ledger.setJobStatus('job-first', 'delivered');
      h.ledger.setJobStatus('job-first', 'in-review');
      expect((await digestOf()).prWithoutReview).toEqual([]);

      // Marker retirement releases exactly this projection; the real
      // finalizer's delivery/settlement is exercised by the guard suite.
      h.ledger.clearPendingRebriefs(
        h.ledger.listPendingRebriefs({ jobId: 'job-first' }).map((marker) => marker.id),
      );
      expect((await digestOf()).prWithoutReview.map((row) => row.jobId)).toEqual(['job-first']);

      h.ledger.clearPendingRebriefs(movedMarkers.map((marker) => marker.id));
      expect((await digestOf()).prWithoutReview.map((row) => row.jobId).sort()).toEqual(['job-first', 'job-moved']);
    } finally {
      h.cleanup();
    }
  });

  it('does not offer a later job whose re-brief was admitted during an earlier blocker-history wait', async () => {
    const h = makeLedger();
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    try {
      // listJobs orders by updated_at DESC: create the offered job first,
      // then update the verdict job so its awaited history runs first.
      addJobWithDelivery(h.ledger, 'later', { prUrl: 'https://git.example.invalid/pull/2' });
      addJobWithDelivery(h.ledger, 'earlier', { prUrl: 'https://git.example.invalid/pull/1' });
      const round = h.ledger.addRound({ jobId: 'earlier' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundStatus(round.id, 'verdict-posted');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('earlier', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'earlier', roundId: round.id, payload: {} });
      const digestPromise = computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => { entered(); await wait; return { blockers: [], note: null }; },
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      await waiting;
      h.ledger.beginPendingRebrief({ jobId: 'later', note: 'new work', briefing: 'b' });
      release();
      expect((await digestPromise).prWithoutReview.map((row) => row.jobId)).not.toContain('later');
    } finally { release(); h.cleanup(); }
  });

  it('retracts a previously accumulated review offer if its job becomes terminal during a later history wait', async () => {
    const h = makeLedger();
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    try {
      addJobWithDelivery(h.ledger, 'history-wait', { prUrl: 'https://git.example.invalid/pull/4' });
      const round = h.ledger.addRound({ jobId: 'history-wait' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundStatus(round.id, 'verdict-posted');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('history-wait', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'history-wait', roundId: round.id, payload: {} });
      // The newer job is visited and offered before the older history wait.
      addJobWithDelivery(h.ledger, 'terminal-offer', { prUrl: 'https://git.example.invalid/pull/5' });
      const digest = computeSilasDigest({ ledger: h.ledger,
        blockersForRound: async () => { entered(); await wait; return { blockers: [], note: null }; },
        config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
      await waiting;
      h.ledger.setJobStatus('terminal-offer', 'done');
      release();
      expect((await digest).prWithoutReview.map((row) => row.jobId)).not.toContain('terminal-offer');
    } finally { release(); h.cleanup(); }
  });

  it('retracts a candidate that slid to blocked or parked while a later history wait ran (gh-187)', async () => {
    const h = makeLedger();
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    try {
      // The candidates are OLDER than the verdict job, so the compute visits
      // them only after the history wait resolves — by then the listJobs
      // snapshot each intake row is computed from still reads the pre-
      // mutation review-eligible status ('working'; addJobWithDelivery
      // records the delivery as an event and never flips the status). The
      // 'z-' id prefix keeps every mutated/control candidate AFTER
      // 'history-wait' even under a same-millisecond updated_at tie
      // (listJobs breaks ties by id ascending), so the stale-snapshot path
      // is structural, not clock luck.
      addJobWithDelivery(h.ledger, 'eligible-offer', { prUrl: 'https://git.example.invalid/pull/7' });
      addJobWithDelivery(h.ledger, 'z-parked-offer', { prUrl: 'https://git.example.invalid/pull/8' });
      addJobWithDelivery(h.ledger, 'z-blocked-offer', { prUrl: 'https://git.example.invalid/pull/9' });
      // PR-less lanes share the same publish fence (deliveredWithoutPr):
      // one is flipped to blocked during the wait, one stays untouched.
      addJobWithDelivery(h.ledger, 'z-blocked-no-pr');
      addJobWithDelivery(h.ledger, 'z-plain-no-pr');
      addJobWithDelivery(h.ledger, 'history-wait', { prUrl: 'https://git.example.invalid/pull/6' });
      const round = h.ledger.addRound({ jobId: 'history-wait' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundStatus(round.id, 'verdict-posted');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('history-wait', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'history-wait', roundId: round.id, payload: {} });
      const digestPromise = computeSilasDigest({ ledger: h.ledger,
        blockersForRound: async () => { entered(); await wait; return { blockers: [], note: null }; },
        config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
      await waiting;
      // The recoverable side-states land DURING the deferred await: intake
      // still sees the pre-mutation review-eligible status in the stale
      // snapshot, so only the publish boundary can retract these offers.
      h.ledger.setJobStatus('z-blocked-offer', 'blocked');
      h.ledger.setJobStatus('z-parked-offer', 'parked');
      h.ledger.setJobStatus('z-blocked-no-pr', 'blocked');
      release();
      const digest = await digestPromise;
      expect(digest.prWithoutReview.map((row) => row.jobId)).toEqual(['eligible-offer']);
      // The shared fence guards the PR-less projection too: the blocked
      // lane's PR-registration offer is retracted; the untouched control
      // remains.
      expect(digest.deliveredWithoutPr.map((row) => row.jobId)).toEqual(['z-plain-no-pr']);
    } finally { release(); h.cleanup(); }
  });

  it('retracts an earlier review offer when its own blocker-history wait admits a re-brief', async () => {
    const h = makeLedger();
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    try {
      addJobWithDelivery(h.ledger, 'same-job', { prUrl: 'https://git.example.invalid/pull/3' });
      const round = h.ledger.addRound({ jobId: 'same-job', targetRef: 'old-sha' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundStatus(round.id, 'verdict-posted');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('same-job', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'same-job', roundId: round.id, payload: {} });
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'same-job', payload: { sha: 'new-sha' } });
      const digestPromise = computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => { entered(); await wait; return { blockers: [], note: null }; },
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      await waiting;
      h.ledger.beginPendingRebrief({ jobId: 'same-job', note: 'reopen', briefing: 'b' });
      release();
      expect((await digestPromise).prWithoutReview).toEqual([]);
    } finally { release(); h.cleanup(); }
  });

  it('an unresolved re-brief suppresses the proven clean-abort rearm until the request settles', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'clean-rebrief', { prUrl: 'https://git.example.invalid/o/r/pull/23' });
      h.ledger.setJobStatus('clean-rebrief', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'clean-rebrief', payload: { sha: 'sha-clean' } });
      const round = h.ledger.addRound({ jobId: 'clean-rebrief', targetRef: 'sha-clean' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundStatus(round.id, 'aborted');
      h.ledger.appendCustomEvent({
        kind: 'round.perkins-incomplete',
        jobId: 'clean-rebrief',
        roundId: round.id,
        payload: { reason: 'service_restart' },
      });
      const digestOf = () =>
        computeSilasDigest({
          ledger: h.ledger,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
        });
      expect((await digestOf()).prWithoutReview).toMatchObject([
        { jobId: 'clean-rebrief', cleanAbort: { roundId: round.id, ruleId: 'clean-abort-service-restart' } },
      ]);

      const markers = h.ledger.beginPendingRebrief({ jobId: 'clean-rebrief', note: 'n', briefing: 'b' });
      expect((await digestOf()).prWithoutReview).toEqual([]);

      h.ledger.clearPendingRebriefs(markers.map((marker) => marker.id));
      expect((await digestOf()).prWithoutReview).toMatchObject([
        { jobId: 'clean-rebrief', cleanAbort: { roundId: round.id, ruleId: 'clean-abort-service-restart' } },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it('re-review fires only for a moved head: the reviewed head and a missing head stay quiet', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-fresh', { prUrl: 'https://git.example.invalid/o/r/pull/8' });
      const round = h.ledger.addRound({ jobId: 'job-fresh', lenses: ['blind'], targetRef: 'sha-reviewed' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setJobStatus('job-fresh', 'in-review');
      h.ledger.setJobStatus('job-fresh', 'working');
      const digestOf = () =>
        computeSilasDigest({
          ledger: h.ledger,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
        });

      // The follow-up turn settled on exactly the head the round reviewed: no round.
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-fresh', payload: { sha: 'sha-reviewed' } });
      expect((await digestOf()).prWithoutReview).toEqual([]);

      // A delivery with no recorded head cannot prove a move: still no round.
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-fresh', payload: { agentId: 'a9' } });
      expect((await digestOf()).prWithoutReview).toEqual([]);

      // The next follow-up delivery moved the lane: re-review due.
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-fresh', payload: { sha: 'sha-fixed' } });
      const moved = await digestOf();
      expect(moved.prWithoutReview.map((row) => row.jobId)).toEqual(['job-fresh']);
      expect(moved.prWithoutReview[0]?.priorRounds).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it('a requested fallback review retires the review-overdue row; a later delivery re-arms it', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-fallback', { prUrl: 'https://git.example.invalid/o/r/pull/11' });
      const digestOf = () =>
        computeSilasDigest({
          ledger: h.ledger,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
        });

      // PR registered, no round: review overdue.
      expect((await digestOf()).prWithoutReview.map((row) => row.jobId)).toEqual(['job-fallback']);

      // The bmad-review fallback gate answered this state: it creates no
      // round and never flips the job, so only its own event can retire
      // the row — otherwise every sweep re-triggers the gate.
      h.ledger.appendCustomEvent({
        kind: 'job.fallback-review',
        jobId: 'job-fallback',
        payload: { phase: 'started', gate: true },
      });
      expect((await digestOf()).prWithoutReview).toEqual([]);

      // A delivery AFTER the request is a new, unreviewed state → due again.
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-fallback', payload: { agentId: 'a2' } });
      expect((await digestOf()).prWithoutReview.map((row) => row.jobId)).toEqual(['job-fallback']);
    } finally {
      h.cleanup();
    }
  });

  it('a requested re-review retires the moved-head row; the next delivery re-arms it', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-re', { prUrl: 'https://git.example.invalid/o/r/pull/12' });
      const round = h.ledger.addRound({ jobId: 'job-re', lenses: ['blind'], targetRef: 'sha-reviewed' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setJobStatus('job-re', 'in-review');
      h.ledger.setJobStatus('job-re', 'working');
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-re', payload: { sha: 'sha-fixed' } });
      const digestOf = () =>
        computeSilasDigest({
          ledger: h.ledger,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
        });
      expect((await digestOf()).prWithoutReview.map((row) => row.jobId)).toEqual(['job-re']);

      // The re-review request landed (fallback route: no round row to read).
      h.ledger.appendCustomEvent({
        kind: 'silas.review-triggered',
        jobId: 'job-re',
        payload: { route: 'bmad-review-fallback' },
      });
      expect((await digestOf()).prWithoutReview).toEqual([]);

      // The next fix delivery moved the head again → the re-review is due.
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-re', payload: { sha: 'sha-second-fix' } });
      expect((await digestOf()).prWithoutReview.map((row) => row.jobId)).toEqual(['job-re']);
    } finally {
      h.cleanup();
    }
  });

  it('a first or evolving blocker gets the first fix directive; the same blocker twice keeps the ladder; a landed rung stops the state', async () => {
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
      // the FIRST verdict must open the loop — monitor here was the dead branch
      expect(first.verdictsAwaitingDirective[0]?.recurringBlockers[0]?.advice).toBe('directive');

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
      // the loop continues: the new blocker gets its own first directive.
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
      expect(third.verdictsAwaitingDirective[0]?.recurringBlockers[0]?.advice).toBe('directive');

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

  it('a carried blocker climbs the ladder through SHIFTED line ranges at the digest level (gh-216, end to end)', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-shift', { prUrl: 'https://git.example.invalid/o/r/pull/11' });
      // The same defect carried across three verdict rounds while fixes above
      // it keep shifting its lines. If the digest ever lost the history (e.g.
      // supplied only the newest round to the recurrence read), rounds 1–2
      // would both say directive and this test would miss the regression.
      const locations = ['src/dispatch/pipeline.ts:287-294', 'src/dispatch/pipeline.ts:301-308', 'src/dispatch/pipeline.ts:310-317'];
      const reports = new Map<string, RoundBlocker[]>();
      const blockersForRound = async (roundId: string) => ({
        blockers: reports.get(roundId) ?? [],
        note: null,
      });
      const advices = [];
      for (const location of locations) {
        const round = h.ledger.addRound({ jobId: 'job-shift', lenses: ['blind'] });
        h.ledger.setRoundStatus(round.id, 'live');
        h.ledger.setRoundStatus(round.id, 'verdict-posted');
        h.ledger.setRoundVerdict(round.id, 'changes-requested');
        h.ledger.setJobStatus('job-shift', 'in-review');
        h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-shift', roundId: round.id, payload: { verdict: 'changes-requested' } });
        reports.set(round.id, [{ title: 'same leak', location, category: 'correctness' }]);
        const digest = await computeSilasDigest({
          ledger: h.ledger,
          blockersForRound,
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'round.verdict',
        });
        const row = digest.verdictsAwaitingDirective[0]?.recurringBlockers[0];
        advices.push(row?.advice);
        if (location === locations[2]) {
          expect(row?.consecutiveRounds).toBe(3);
          expect(row?.advice).toBe('rebrief');
        }
      }
      expect(advices).toEqual(['directive', 'directive', 'rebrief']);
    } finally {
      h.cleanup();
    }
  });

  it('the digest keeps two same-file same-title blockers distinct via the evidence tie-break', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-collide', { prUrl: 'https://git.example.invalid/o/r/pull/12' });
      const round = h.ledger.addRound({ jobId: 'job-collide', lenses: ['blind'] });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundStatus(round.id, 'verdict-posted');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('job-collide', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-collide', roundId: round.id, payload: { verdict: 'changes-requested' } });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({
          blockers: [
            { title: 'null deref on empty path', location: 'src/a.ts:10-20', category: 'correctness', evidence: 'if (p === EMPTY) return p.length;' },
            { title: 'null deref on empty path', location: 'src/a.ts:88-96', category: 'correctness', evidence: 'const n = cache.get(EMPTY).size;' },
          ],
          note: null,
        }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'round.verdict',
      });
      const rows = digest.verdictsAwaitingDirective[0]?.recurringBlockers ?? [];
      expect(rows).toHaveLength(2);
      expect(rows[0]?.fingerprint).not.toBe(rows[1]?.fingerprint);
      // indistinguishable members (no evidence) still merge to one row
      const merged = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({
          blockers: [
            { title: 'null deref on empty path', location: 'src/a.ts:10-20', category: 'correctness' },
            { title: 'null deref on empty path', location: 'src/a.ts:88-96', category: 'correctness' },
          ],
          note: null,
        }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'round.verdict',
      });
      expect(merged.verdictsAwaitingDirective[0]?.recurringBlockers).toHaveLength(1);
      expect(merged.verdictsAwaitingDirective[0]?.blockerCount).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  it('unrelated job traffic cannot age a landed rung marker out of the handled check (gh-216 AC4)', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-window', { prUrl: 'https://git.example.invalid/o/r/pull/13' });
      const round = h.ledger.addRound({ jobId: 'job-window', lenses: ['blind'] });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundStatus(round.id, 'verdict-posted');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('job-window', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-window', roundId: round.id, payload: { verdict: 'changes-requested' } });
      h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-window', payload: {} });
      // More than the old fixed window of 50 UNRELATED job events after the
      // rung marker: a mixed newest-50 read would lose the marker and offer
      // the verdict again. The kinds-scoped read must not.
      for (let i = 0; i < 60; i += 1) {
        h.ledger.appendCustomEvent({ kind: 'job.transcript', jobId: 'job-window', payload: { n: i } });
      }
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [{ title: 'same leak', location: 'src/a.ts', category: 'correctness' }], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(digest.verdictsAwaitingDirective).toEqual([]);
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

  it('surfaces a failed verification as repair-due and retires it on a repair rung or a later pass', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-verify', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-verify', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-verify',
        payload: { ok: false, exit_code: 1, scope: 'full', run_id: 'run-1', sha: 'head-1' },
      });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(digest.verificationFailures).toHaveLength(1);
      expect(digest.verificationFailures[0]).toMatchObject({
        jobId: 'job-verify',
        scope: 'full',
        runId: 'run-1',
        head: 'head-1',
        detail: 'exit 1',
      });
      expect(digestActionCount(digest)).toBe(1);

      // A repair rung after the failure retires the row — only with the
      // EXACT failure identity (an unscoped rung retires nothing).
      h.ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId: 'job-verify',
        payload: { request_id: 'req-1', minion_id: 'm1', blocker_fingerprint: 'verification-failure:full@run-1' },
      });
      const handled = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(handled.verificationFailures).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a later same-scope verification activity retires the failed row; a PASS never re-arms it', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-verify-2', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-verify-2', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-verify-2',
        payload: { ok: false, scope: 'focused', run_id: 'run-1' },
      });
      h.ledger.appendCustomEvent({
        kind: 'verification.requested',
        jobId: 'job-verify-2',
        payload: { scope: 'focused', run_id: 'run-2' },
      });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(digest.verificationFailures).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('names a verification queue timeout as reconsideration-due, distinct from a failure', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-wait', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-wait', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.lock-timeout',
        jobId: 'job-wait',
        payload: { scope: 'full', request_id: 'req-9', wait_ms: 900_000 },
      });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(digest.verificationWaits).toEqual([
        expect.objectContaining({ jobId: 'job-wait', scope: 'full', requestId: 'req-9', waitMs: 900_000 }),
      ]);
      expect(digest.verificationFailures).toEqual([]);

      // A newer submission for the same scope is the reconsideration: the
      // wait row retires (never an automatic rerun).
      h.ledger.appendCustomEvent({
        kind: 'verification.requested',
        jobId: 'job-wait',
        payload: { scope: 'full', request_id: 'req-10' },
      });
      const resubmitted = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(resubmitted.verificationWaits).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('tracks failures and waits per scope: an unrelated PASS or resubmission cannot hide another scope', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-scopes', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-scopes', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-scopes',
        payload: { ok: false, scope: 'full', run_id: 'run-full', exit_code: 1 },
      });
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-scopes',
        payload: { ok: true, scope: 'focused', run_id: 'run-focused', exit_code: 0 },
      });
      h.ledger.appendCustomEvent({
        kind: 'verification.lock-timeout',
        jobId: 'job-scopes',
        payload: { scope: 'full', request_id: 'req-a', head: 'head-a', wait_ms: 1_000 },
      });
      h.ledger.appendCustomEvent({
        kind: 'verification.lock-timeout',
        jobId: 'job-scopes',
        payload: { scope: 'focused', request_id: 'req-b', head: 'head-b', wait_ms: 2_000 },
      });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      // The focused PASS does not hide the failed full scope, and both
      // timed-out scopes stay visible.
      expect(digest.verificationFailures.map((row) => row.scope)).toEqual(['full']);
      expect(digest.verificationWaits.map((row) => row.scope).sort()).toEqual(['focused', 'full']);
      expect(digest.verificationWaits.map((row) => row.head).sort()).toEqual(['head-a', 'head-b']);

      // Resubmitting only the newer (focused) scope AT ITS PINNED HEAD
      // retires only its row.
      h.ledger.appendCustomEvent({
        kind: 'verification.requested',
        jobId: 'job-scopes',
        payload: { scope: 'focused', request_id: 'req-c', head: 'head-b' },
      });
      const after = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(after.verificationWaits.map((row) => row.scope)).toEqual(['full']);
      expect(after.verificationFailures.map((row) => row.scope)).toEqual(['full']);
    } finally {
      h.cleanup();
    }
  });

  it('a fingerprinted repair rung retires only its own failed scope; an unrelated rung cannot', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-rung', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-rung', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-rung',
        payload: { ok: false, scope: 'full', run_id: 'run-77', exit_code: 1 },
      });
      h.ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId: 'job-rung',
        payload: { request_id: 'req-other', blocker_fingerprint: 'lint:src/other.ts' },
      });
      const unrelated = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(unrelated.verificationFailures.map((row) => row.scope)).toEqual(['full']);

      h.ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId: 'job-rung',
        payload: { request_id: 'req-verify', blocker_fingerprint: 'verification-failure:full@run-77' },
      });
      const handled = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(handled.verificationFailures).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('reports the real failure detail: timeout/signal/error outrank a zero exit code', async () => {
    const h = makeLedger();
    try {
      for (const [id, payload] of [
        ['job-detail-1', { ok: false, scope: 'full', exit_code: 0, error: 'spawn ENOENT' }],
        ['job-detail-2', { ok: false, scope: 'full', exit_code: 0, signal: 'SIGKILL' }],
        ['job-detail-3', { ok: false, scope: 'full', exit_code: 0, timed_out: true }],
      ] as const) {
        h.ledger.addJob({ id, repo: 'fixture-app', title: 't', briefing: 'b' });
        h.ledger.setJobStatus(id, 'working');
        h.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: id, payload });
      }
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      const detail = new Map(digest.verificationFailures.map((row) => [row.jobId, row.detail]));
      expect(detail.get('job-detail-1')).toBe('spawn ENOENT');
      expect(detail.get('job-detail-2')).toBe('signal SIGKILL');
      expect(detail.get('job-detail-3')).toBe('timed out');
    } finally {
      h.cleanup();
    }
  });
});

// ------------------------------------------------------------------
// Stalled CURRENT phase (issue #162): phase-aware, fence-preserving
// ------------------------------------------------------------------

describe('silas digest: stalled current phases (issue #162)', () => {
  /** Open a repair phase on top of a truthful older delivery: the job
   * delivered once (the historical event), then an explicit repair
   * transition put it back to `working`. The old `delivered === null`
   * predicate could never see this lane. */
  const reopenRepairPhase = (h: Harness, jobId: string): void => {
    addJobWithDelivery(h.ledger, jobId);
    h.ledger.setJobStatus(jobId, 'delivered');
    h.ledger.setJobStatus(jobId, 'working');
  };

  const digestAt = (h: Harness, at: number) =>
    computeSilasDigest({
      ledger: h.ledger,
      blockersForRound: async () => ({ blockers: [], note: null }),
      config: DEFAULT_SILAS_CONFIG,
      trigger: 'sweep',
      now: () => at,
    });

  const idleAt = (h: Harness, minionId: string): number =>
    Date.parse(h.ledger.getAgent(minionId)!.lastActivity!);

  /** A clock far past every stamp the fixture just wrote (fence tests do
   * not care about the exact boundary; the boundary tests above do). */
  const farFuture = (): number => Date.now() + DEFAULT_SILAS_CONFIG.stallThresholdMs * 2;

  it('the original blind spot: a legitimately reopened phase with an older delivery becomes visible past the stall threshold', async () => {
    const h = makeLedger();
    try {
      reopenRepairPhase(h, 'job-repair');
      expect(h.ledger.getJob('job-repair')?.status).toBe('working');
      expect(h.ledger.latestJobEvent('job-repair', 'job.delivered')).not.toBeNull();
      h.ledger.registerAgent({ id: 'min-repair', role: 'minion', jobId: 'job-repair' });
      h.ledger.setAgentState('min-repair', 'idle');
      const idle = idleAt(h, 'min-repair');
      // Inside the grace window: nothing is offered.
      expect((await digestAt(h, idle + DEFAULT_SILAS_CONFIG.stallThresholdMs)).stalledWorking).toEqual([]);
      // Past it: the CURRENT repair phase is surfaced despite the older delivery.
      const past = await digestAt(h, idle + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1);
      expect(past.stalledWorking.map((row) => row.jobId)).toEqual(['job-repair']);
      expect(past.stalledWorking[0]?.minionId).toBe('min-repair');
      // Historical delivery evidence is preserved, never deleted or rewritten.
      expect(h.ledger.listJobEvents('job-repair').filter((event) => event.kind === 'job.delivered')).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('a genuinely current delivery stays excluded — a worker exiting after delivery is normal', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-current');
      h.ledger.registerAgent({ id: 'min-current', role: 'minion', jobId: 'job-current' });
      h.ledger.setAgentState('min-current', 'idle');
      const digest = await digestAt(h, idleAt(h, 'min-current') + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1);
      expect(digest.stalledWorking).toEqual([]);
      // The state still reaches its real owner: the delivery-without-PR row.
      expect(digest.deliveredWithoutPr.map((row) => row.jobId)).toEqual(['job-current']);
    } finally {
      h.cleanup();
    }
  });

  it('terminal, parked, blocked and delivered lanes are never offered for stalled recovery', async () => {
    const h = makeLedger();
    try {
      const jobs: readonly { id: string; status: string[] }[] = [
        { id: 'job-terminal-done', status: ['done'] },
        { id: 'job-terminal-merged', status: ['in-review', 'merged'] },
        { id: 'job-parked', status: ['parked'] },
        { id: 'job-blocked', status: ['blocked'] },
        { id: 'job-delivered', status: ['delivered'] },
      ];
      for (const { id, status } of jobs) {
        addJobWithDelivery(h.ledger, id, { prUrl: 'https://git.example.invalid/o/r/pull/1' });
        for (const step of status) h.ledger.setJobStatus(id, step);
        h.ledger.registerAgent({ id: `min-${id}`, role: 'minion', jobId: id });
        h.ledger.setAgentState(`min-${id}`, 'idle');
      }
      const far = Math.max(...jobs.map(({ id }) => idleAt(h, `min-${id}`))) + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1;
      const digest = await digestAt(h, far);
      expect(digest.stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('the no-minion-record variant is visible past the grace window, never silently invisible', async () => {
    const h = makeLedger();
    try {
      reopenRepairPhase(h, 'job-no-worker');
      const startedAt = Date.parse(h.ledger.latestJobEvent('job-no-worker', 'job.status')!.ts);
      // Exactly at the grace boundary is not stalled; past it the absent
      // worker record no longer hides the phase.
      expect((await digestAt(h, startedAt + DEFAULT_SILAS_CONFIG.stallThresholdMs)).stalledWorking).toEqual([]);
      const past = await digestAt(h, startedAt + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1);
      expect(past.stalledWorking).toEqual([
        {
          jobId: 'job-no-worker',
          repo: 'fixture-app',
          minionId: null,
          minionState: null,
          lastActivity: null,
          idleMs: DEFAULT_SILAS_CONFIG.stallThresholdMs + 1,
        },
      ]);
    } finally {
      h.cleanup();
    }
  });

  it('a pending re-brief request owns the lane: accepted work awaiting startup is never called lost', async () => {
    const h = makeLedger();
    try {
      reopenRepairPhase(h, 'job-rebrief');
      h.ledger.beginPendingRebrief({ jobId: 'job-rebrief', note: 'retry the repair', briefing: 'b' });
      const startedAt = Date.parse(h.ledger.latestJobEvent('job-rebrief', 'job.status')!.ts);
      expect((await digestAt(h, startedAt + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1)).stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a live directive request fences the lane while ownership is uncertain, in BOTH live states', async () => {
    const h = makeLedger();
    try {
      reopenRepairPhase(h, 'job-directive');
      const intent = h.ledger.beginDirectiveIntent({ jobId: 'job-directive', directive: 'fix it', holder: 'silas-ops' });
      const at = farFuture();
      // `dispatching` = side effects possible, admission unknown: reconcile, never duplicate.
      expect((await digestAt(h, at)).stalledWorking).toEqual([]);
      const sent = h.ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId: 'job-directive',
        payload: { request_id: intent.record.requestId, minion_id: 'min-live' },
      });
      h.ledger.recordDirectiveAdmission({ requestId: intent.record.requestId, minionId: 'min-live', eventSeq: sent.seq });
      // `admitted` = a bound turn is still in flight: same fence.
      expect((await digestAt(h, at)).stalledWorking).toEqual([]);
      // A durable failure with positive no-effect proof releases the fence.
      h.ledger.failDirective({ requestId: intent.record.requestId, reason: 'no lane and no minion' });
      expect((await digestAt(h, at)).stalledWorking.map((row) => row.jobId)).toEqual(['job-directive']);
    } finally {
      h.cleanup();
    }
  });

  it('an in-flight verification owns the checkout; only its own run settlement releases it', async () => {
    const h = makeLedger();
    try {
      reopenRepairPhase(h, 'job-verify');
      // A started run owns the checkout regardless of how old it is.
      h.ledger.appendCustomEvent({ kind: 'verification.started', jobId: 'job-verify', payload: { run_id: 'run-1', scope: 'full' } });
      const at = farFuture();
      expect((await digestAt(h, at)).stalledWorking).toEqual([]);
      // A duplicate caller attaching to the same attempt is NOT a settlement.
      h.ledger.appendCustomEvent({ kind: 'verification.attached', jobId: 'job-verify', payload: { run_id: 'run-1', scope: 'full', state: 'running' } });
      expect((await digestAt(h, at)).stalledWorking).toEqual([]);
      // Run 2 starts while run 1 is open; run 1's later settlement must not
      // release run 2's checkout (per-run identity, not job-level order).
      h.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: 'job-verify', payload: { run_id: 'run-2', scope: 'web' } });
      h.ledger.appendCustomEvent({ kind: 'verification.started', jobId: 'job-verify', payload: { run_id: 'run-2', scope: 'web' } });
      h.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: 'job-verify', payload: { run_id: 'run-1', scope: 'full' } });
      expect((await digestAt(h, at)).stalledWorking).toEqual([]);
      // Run 2's own settlement releases the lane.
      h.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: 'job-verify', payload: { run_id: 'run-2', scope: 'web' } });
      expect((await digestAt(h, at)).stalledWorking.map((row) => row.jobId)).toEqual(['job-verify']);
    } finally {
      h.cleanup();
    }
  });

  it('an unsettled queued verification keeps its ownership fence (uncertain ownership fails closed)', async () => {
    const h = makeLedger();
    try {
      reopenRepairPhase(h, 'job-queue');
      const requested = h.ledger.appendCustomEvent({
        kind: 'verification.requested', jobId: 'job-queue', payload: { run_id: 'run-queued', scope: 'full' },
      });
      const at = Date.parse(requested.ts) + 3 * DEFAULT_SILAS_CONFIG.stallThresholdMs;
      // Long past the stall threshold the accepted queue still owns the
      // checkout: the scheduler's lock-timeout/stale record is the terminal
      // evidence, and guessing cessation would risk competing writers.
      expect((await digestAt(h, at)).stalledWorking).toEqual([]);
      // The scheduler's own terminal record for THIS run releases it.
      h.ledger.appendCustomEvent({ kind: 'verification.lock-timeout', jobId: 'job-queue', payload: { run_id: 'run-queued', scope: 'full' } });
      expect((await digestAt(h, at)).stalledWorking.map((row) => row.jobId)).toEqual(['job-queue']);
    } finally {
      h.cleanup();
    }
  });

  it('a busy verification history cannot hide an unsettled run from the ownership query', async () => {
    const h = makeLedger();
    try {
      reopenRepairPhase(h, 'job-tail');
      h.ledger.appendCustomEvent({ kind: 'verification.started', jobId: 'job-tail', payload: { run_id: 'run-active', scope: 'full' } });
      // 650 newer lifecycle events (325 settled runs) plus a busy activity
      // tail: the durable per-run query still sees the open run.
      for (let index = 0; index < 325; index += 1) {
        h.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: 'job-tail', payload: { run_id: `run-${index}`, scope: 'web' } });
        h.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: 'job-tail', payload: { run_id: `run-${index}`, scope: 'web' } });
      }
      for (let index = 0; index < 450; index += 1) {
        h.ledger.appendCustomEvent({ kind: 'agent.state', jobId: 'job-tail', payload: { index } });
      }
      const at = farFuture();
      expect((await digestAt(h, at)).stalledWorking).toEqual([]);
      h.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: 'job-tail', payload: { run_id: 'run-active', scope: 'full' } });
      expect((await digestAt(h, at)).stalledWorking.map((row) => row.jobId)).toEqual(['job-tail']);
    } finally {
      h.cleanup();
    }
  });

  it('a claimed provider continuation opens a repair phase without a status hop', async () => {
    const h = makeLedger();
    try {
      // Delivered lane that never left `working` (fallback-review shape).
      addJobWithDelivery(h.ledger, 'job-recovered');
      const claim = h.ledger.appendCustomEvent({
        kind: 'provider.recovery-claimed', jobId: 'job-recovered', payload: { wait_id: 'w-1', path: 'resumed' },
      });
      const claimedAt = Date.parse(claim.ts);
      expect((await digestAt(h, claimedAt + DEFAULT_SILAS_CONFIG.stallThresholdMs)).stalledWorking).toEqual([]);
      expect(
        (await digestAt(h, claimedAt + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1)).stalledWorking.map((row) => row.jobId),
      ).toEqual(['job-recovered']);
    } finally {
      h.cleanup();
    }
  });

  it('a directive intent that never admitted work cannot reopen a genuinely delivered phase', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-noop');
      const intent = h.ledger.beginDirectiveIntent({ jobId: 'job-noop', directive: 'no-op', holder: 'silas-ops' });
      h.ledger.failDirective({ requestId: intent.record.requestId, reason: 'no lane and no minion' });
      // Delivery is newer than the working hop and no admission ever landed:
      // the phase is still delivered, not stalled.
      expect((await digestAt(h, farFuture())).stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a fresh dispatch with no worker record is accepted startup, not lost work', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-dispatch', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-dispatch', 'working');
      const startedAt = Date.parse(h.ledger.latestJobEvent('job-dispatch', 'job.status')!.ts);
      // The dispatch turn owns its accepted startup (a queued worker-gate
      // admission is not lost work); a deterministic failure blocks the
      // lane with error evidence instead. Repair phases are the case where
      // a missing record means lost work — covered above.
      expect((await digestAt(h, startedAt + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1)).stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('an in-review attempt that never delivered is still assessed when its worker dies', async () => {
    const h = makeLedger();
    try {
      // A PR link flips a still-working attempt to in-review before its
      // delivery: laneIsBusy still treats it as a writer, so the stall
      // channel must not strand it behind the in-review status.
      h.ledger.addJob({ id: 'job-linked', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-linked', 'working');
      h.ledger.setJobPr('job-linked', 'https://git.example.invalid/o/r/pull/3');
      h.ledger.setJobStatus('job-linked', 'in-review');
      h.ledger.registerAgent({ id: 'min-linked', role: 'minion', jobId: 'job-linked' });
      h.ledger.setAgentState('min-linked', 'idle');
      const at = idleAt(h, 'min-linked') + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1;
      expect((await digestAt(h, at)).stalledWorking.map((row) => row.jobId)).toEqual(['job-linked']);
      // Once the attempt delivers, the review owns it: no stall offer.
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-linked', payload: { sha: 'sha-linked' } });
      expect((await digestAt(h, at)).stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a reopened phase binds its grace to the phase start, not the old idle worker stamp', async () => {
    const h = makeLedger();
    try {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
        addJobWithDelivery(h.ledger, 'job-grace');
        h.ledger.registerAgent({ id: 'min-old', role: 'minion', jobId: 'job-grace' });
        h.ledger.setAgentState('min-old', 'idle');
        const workerIdleAt = idleAt(h, 'min-old');
        // Reopen five minutes later: the old idle stamp is older than the
        // phase opening, so the fresh grace starts at the reopen.
        vi.setSystemTime(new Date(workerIdleAt + 5 * 60_000));
        h.ledger.setJobStatus('job-grace', 'delivered');
        h.ledger.setJobStatus('job-grace', 'working');
        const reopenedAt = Date.parse(h.ledger.latestJobEvent('job-grace', 'job.status')!.ts);
        expect((await digestAt(h, reopenedAt + DEFAULT_SILAS_CONFIG.stallThresholdMs)).stalledWorking).toEqual([]);
        // One millisecond past the reopen's own grace: visible.
        expect(
          (await digestAt(h, reopenedAt + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1)).stalledWorking.map((row) => row.jobId),
        ).toEqual(['job-grace']);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      h.cleanup();
    }
  });

  it('a supervised open turn owns the lane even when the ledger stamp is old; closing it lets the stall surface', async () => {
    const h = makeLedger();
    try {
      reopenRepairPhase(h, 'job-open-turn');
      h.ledger.registerAgent({ id: 'min-open', role: 'minion', jobId: 'job-open-turn' });
      h.ledger.setAgentState('min-open', 'idle');
      const at = farFuture();
      const base: AgentSupervisionView = {
        agentId: 'min-open', role: 'minion', slotId: null, state: 'watching', restarts: 0,
        breakerOpen: false, stopReason: null, openTurn: true, openToolCalls: 0,
        lastEventAt: null, lastFileBytes: null,
      };
      const digestOf = (view: AgentSupervisionView | null) =>
        computeSilasDigest({
          ledger: h.ledger,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
          now: () => at,
          supervisionFor: (agentId) => (agentId === 'min-open' ? view : null),
        });
      // A live open turn is active work, never a lost worker.
      expect((await digestOf(base)).stalledWorking).toEqual([]);
      // Each independent ownership field fences on its own.
      expect((await digestOf({ ...base, openTurn: false, openControl: true })).stalledWorking).toEqual([]);
      expect((await digestOf({ ...base, openTurn: false, openControl: false, openToolCalls: 1 })).stalledWorking).toEqual([]);
      // The same worker with the turn closed and only a stale stamp is silent.
      expect((await digestOf({ ...base, openTurn: false })).stalledWorking.map((row) => row.jobId)).toEqual(['job-open-turn']);
    } finally {
      h.cleanup();
    }
  });

  it('fresh supervisor activity keeps a closed-turn worker out of its silent window', async () => {
    const h = makeLedger();
    try {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-10-04T00:00:00.000Z'));
        addJobWithDelivery(h.ledger, 'job-sup');
        h.ledger.registerAgent({ id: 'min-sup', role: 'minion', jobId: 'job-sup' });
        h.ledger.setAgentState('min-sup', 'idle');
        const idle = idleAt(h, 'min-sup');
        vi.setSystemTime(new Date(idle + 10 * 60_000));
        h.ledger.setJobStatus('job-sup', 'delivered');
        h.ledger.setJobStatus('job-sup', 'working');
        const reopenedAt = Date.parse(h.ledger.latestJobEvent('job-sup', 'job.status')!.ts);
        const base: AgentSupervisionView = {
          agentId: 'min-sup', role: 'minion', slotId: null, state: 'watching', restarts: 0,
          breakerOpen: false, stopReason: null, openTurn: false, openToolCalls: 0,
          lastEventAt: null, lastFileBytes: null,
        };
        const digestOf = (view: AgentSupervisionView | null, at: number) =>
          computeSilasDigest({
            ledger: h.ledger,
            blockersForRound: async () => ({ blockers: [], note: null }),
            config: DEFAULT_SILAS_CONFIG,
            trigger: 'sweep',
            now: () => at,
            supervisionFor: (agentId) => (agentId === 'min-sup' ? view : null),
          });
        // The ledger stamp is past the threshold, but the supervisor's own
        // event clock is inside the silence window.
        const fresh = { ...base, lastEventAt: new Date(idle + 20 * 60_000).toISOString() };
        expect((await digestOf(fresh, reopenedAt + 35 * 60_000)).stalledWorking).toEqual([]);
        // The supervisor clock itself ages past the window: silent again.
        expect((await digestOf(fresh, reopenedAt + 55 * 60_000)).stalledWorking.map((row) => row.jobId)).toEqual(['job-sup']);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      h.cleanup();
    }
  });

  it('a later working hop is a genuine repair even when a clean abort is on the record', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-abort', { prUrl: 'https://git.example.invalid/o/r/pull/9' });
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-abort', payload: { sha: 'sha-same' } });
      const round = h.ledger.addRound({ jobId: 'job-abort', targetRef: 'sha-same' });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setJobStatus('job-abort', 'in-review');
      h.ledger.setRoundStatus(round.id, 'aborted');
      h.ledger.appendCustomEvent({
        kind: 'round.perkins-incomplete', jobId: 'job-abort', roundId: round.id, payload: { reason: 'service_restart' },
      });
      // The in-review → working restore leaves the lane on an old head the
      // branch guard refuses to re-arm (the restore hop keeps the attempt
      // open): the lane is surfaced for assessment, never offered an
      // unarmable clean-abort review row.
      h.ledger.setJobStatus('job-abort', 'working');
      const rearmed = await digestAt(h, farFuture());
      expect(rearmed.prWithoutReview).toEqual([]);
      expect(rearmed.stalledWorking.map((row) => row.jobId)).toEqual(['job-abort']);
      // A LATER delivered → working hop is a genuine reopen: the old abort
      // must not hide it, and the old head must not be offered for review.
      h.ledger.setJobStatus('job-abort', 'delivered');
      h.ledger.setJobStatus('job-abort', 'working');
      h.ledger.registerAgent({ id: 'min-abort', role: 'minion', jobId: 'job-abort' });
      h.ledger.setAgentState('min-abort', 'idle');
      const reopened = await digestAt(h, idleAt(h, 'min-abort') + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1);
      expect(reopened.stalledWorking.map((row) => row.jobId)).toEqual(['job-abort']);
      expect(reopened.prWithoutReview).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a live directive or pending re-brief fences the PR/review offers on a delivered lane', async () => {
    const h = makeLedger();
    try {
      // Row (1): delivered, no PR yet.
      addJobWithDelivery(h.ledger, 'job-offer1');
      expect((await digestAt(h, farFuture())).deliveredWithoutPr.map((row) => row.jobId)).toEqual(['job-offer1']);
      const intent = h.ledger.beginDirectiveIntent({ jobId: 'job-offer1', directive: 'no-op', holder: 'silas-ops' });
      expect((await digestAt(h, farFuture())).deliveredWithoutPr).toEqual([]);
      h.ledger.failDirective({ requestId: intent.record.requestId, reason: 'no lane and no minion' });
      expect((await digestAt(h, farFuture())).deliveredWithoutPr.map((row) => row.jobId)).toEqual(['job-offer1']);
      h.ledger.beginPendingRebrief({ jobId: 'job-offer1', note: 'retry', briefing: 'b' });
      expect((await digestAt(h, farFuture())).deliveredWithoutPr).toEqual([]);
      // Row (2): PR-linked, review due.
      addJobWithDelivery(h.ledger, 'job-offer2', { prUrl: 'https://git.example.invalid/o/r/pull/2' });
      expect((await digestAt(h, farFuture())).prWithoutReview.map((row) => row.jobId)).toEqual(['job-offer2']);
      h.ledger.beginDirectiveIntent({ jobId: 'job-offer2', directive: 'no-op', holder: 'silas-ops' });
      expect((await digestAt(h, farFuture())).prWithoutReview).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a stalled offer is retracted when a new repair phase opens during the await', async () => {
    const h = makeLedger();
    try {
      // The await job is created first and the stalled candidate a second
      // later, so the candidate is deterministically visited first.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
      h.ledger.addJob({ id: 'job-other3', repo: 'fixture-app', title: 'other', briefing: 'b' });
      h.ledger.setJobStatus('job-other3', 'working');
      const round = h.ledger.addRound({ jobId: 'job-other3', lenses: ['blind'] });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('job-other3', 'in-review');
      vi.setSystemTime(new Date('2026-10-04T10:00:01.000Z'));
      reopenRepairPhase(h, 'job-race-claim');
      h.ledger.registerAgent({ id: 'min-race-claim', role: 'minion', jobId: 'job-race-claim' });
      h.ledger.setAgentState('min-race-claim', 'idle');
      vi.useRealTimers();
      let raced = false;
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => {
          if (!raced) {
            raced = true;
            h.ledger.appendCustomEvent({ kind: 'provider.recovery-claimed', jobId: 'job-race-claim', payload: { wait_id: 'w' } });
          }
          return { blockers: [], note: null };
        },
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
        now: () => farFuture(),
      });
      expect(raced).toBe(true);
      expect(digest.stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a stalled offer is retracted when its worker resumes activity during the await', async () => {
    const h = makeLedger();
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
      h.ledger.addJob({ id: 'job-other4', repo: 'fixture-app', title: 'other', briefing: 'b' });
      h.ledger.setJobStatus('job-other4', 'working');
      const round = h.ledger.addRound({ jobId: 'job-other4', lenses: ['blind'] });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('job-other4', 'in-review');
      vi.setSystemTime(new Date('2026-10-04T10:00:01.000Z'));
      reopenRepairPhase(h, 'job-race-worker');
      h.ledger.registerAgent({ id: 'min-race-worker', role: 'minion', jobId: 'job-race-worker' });
      h.ledger.setAgentState('min-race-worker', 'idle');
      vi.useRealTimers();
      let raced = false;
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => {
          if (!raced) {
            raced = true;
            // The worker resumed while the digest awaited the other job.
            h.ledger.setAgentState('min-race-worker', 'idle');
          }
          return { blockers: [], note: null };
        },
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
        now: () => farFuture(),
      });
      expect(raced).toBe(true);
      expect(digest.stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a stalled offer is retracted when an owner lands while another job\'s blocker history is awaited', async () => {
    const h = makeLedger();
    try {
      // The other job is created FIRST so its blocker report is awaited
      // AFTER job-race (the more recently updated row) is visited.
      h.ledger.addJob({ id: 'job-other', repo: 'fixture-app', title: 'other', briefing: 'b' });
      h.ledger.setJobStatus('job-other', 'working');
      const round = h.ledger.addRound({ jobId: 'job-other', lenses: ['blind'] });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('job-other', 'in-review');
      reopenRepairPhase(h, 'job-race');
      const at = farFuture();
      let raced = false;
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => {
          if (!raced) {
            raced = true;
            // An accepted directive owns job-race while the await is open.
            h.ledger.beginDirectiveIntent({ jobId: 'job-race', directive: 'repair', holder: 'silas-ops' });
          }
          return { blockers: [], note: null };
        },
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
        now: () => at,
      });
      expect(raced).toBe(true);
      expect(digest.stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('an answering review request fences the phase; a failed fallback request does not', async () => {
    const h = makeLedger();
    try {
      reopenRepairPhase(h, 'job-review');
      const at = farFuture();
      h.ledger.appendCustomEvent({ kind: 'silas.review-triggered', jobId: 'job-review', payload: { route: 'perkins' } });
      expect((await digestAt(h, at)).stalledWorking).toEqual([]);
      // A terminal fallback failure newer than the trigger answers nothing.
      h.ledger.appendCustomEvent({ kind: 'job.fallback-review', jobId: 'job-review', payload: { phase: 'blocked' } });
      expect((await digestAt(h, at)).stalledWorking.map((row) => row.jobId)).toEqual(['job-review']);
    } finally {
      h.cleanup();
    }
  });

  it('a stalled offer is retracted when its phase delivers during the await', async () => {
    const h = makeLedger();
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
      h.ledger.addJob({ id: 'job-other5', repo: 'fixture-app', title: 'other', briefing: 'b' });
      h.ledger.setJobStatus('job-other5', 'working');
      const round = h.ledger.addRound({ jobId: 'job-other5', lenses: ['blind'] });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('job-other5', 'in-review');
      vi.setSystemTime(new Date('2026-10-04T10:00:01.000Z'));
      reopenRepairPhase(h, 'job-race-delivery');
      h.ledger.registerAgent({ id: 'min-race-delivery', role: 'minion', jobId: 'job-race-delivery' });
      h.ledger.setAgentState('min-race-delivery', 'idle');
      vi.useRealTimers();
      let raced = false;
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => {
          if (!raced) {
            raced = true;
            h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-race-delivery', payload: { sha: 'sha-delivered' } });
          }
          return { blockers: [], note: null };
        },
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
        now: () => farFuture(),
      });
      expect(raced).toBe(true);
      expect(digest.stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a stalled offer is retracted when verification takes ownership during the await', async () => {
    const h = makeLedger();
    try {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
      h.ledger.addJob({ id: 'job-other6', repo: 'fixture-app', title: 'other', briefing: 'b' });
      h.ledger.setJobStatus('job-other6', 'working');
      const round = h.ledger.addRound({ jobId: 'job-other6', lenses: ['blind'] });
      h.ledger.setRoundStatus(round.id, 'live');
      h.ledger.setRoundVerdict(round.id, 'changes-requested');
      h.ledger.setJobStatus('job-other6', 'in-review');
      vi.setSystemTime(new Date('2026-10-04T10:00:01.000Z'));
      reopenRepairPhase(h, 'job-race-verify');
      h.ledger.registerAgent({ id: 'min-race-verify', role: 'minion', jobId: 'job-race-verify' });
      h.ledger.setAgentState('min-race-verify', 'idle');
      vi.useRealTimers();
      let raced = false;
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => {
          if (!raced) {
            raced = true;
            h.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: 'job-race-verify', payload: { run_id: 'run-race', scope: 'full' } });
          }
          return { blockers: [], note: null };
        },
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
        now: () => farFuture(),
      });
      expect(raced).toBe(true);
      expect(digest.stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('repeated sweeps report one row for the phase and add no writers of their own; an accepted continuation retires it', async () => {
    const h = makeLedger();
    try {
      reopenRepairPhase(h, 'job-repeat');
      const at = farFuture();
      const first = await digestAt(h, at);
      const eventsBefore = h.ledger.listJobEvents('job-repeat', { limit: 200 }).length;
      const second = await digestAt(h, at);
      expect(first.stalledWorking.map((row) => row.jobId)).toEqual(['job-repeat']);
      expect(second.stalledWorking.map((row) => row.jobId)).toEqual(['job-repeat']);
      // The detector is read-only: no delivery, directive or rebrief event is minted.
      expect(h.ledger.listJobEvents('job-repeat', { limit: 200 }).length).toBe(eventsBefore);
      // The existing guarded continuation path (Silas' accepted directive) owns the phase from here.
      h.ledger.beginDirectiveIntent({ jobId: 'job-repeat', directive: 'repair', holder: 'silas-ops' });
      expect((await digestAt(h, at)).stalledWorking).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

// ------------------------------------------------------------------
// Consolidated blockers port (the digest's first-fix input)
// ------------------------------------------------------------------

describe('consolidated blockers port', () => {
  it('reads blocker findings from the round report; missing or malformed reports are loud notes, never silent empties', async () => {
    const h = makeLedger();
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-consolidated-'));
    try {
      h.ledger.addJob({ id: 'job-port', repo: 'fixture-app', title: 't', briefing: 'b' });
      const round = h.ledger.addRound({ jobId: 'job-port', lenses: ['blind'] });
      h.ledger.appendCustomEvent({
        kind: 'round.perkins-review',
        jobId: 'job-port',
        roundId: round.id,
        payload: { artifactDirectory: dir },
      });
      writeFileSync(
        join(dir, 'consolidated.json'),
        JSON.stringify({
          findings: [
            { severity: 'blocker', category: 'correctness', title: 'boom', location: 'src/a.ts' },
            { severity: 'warning', category: 'style', title: 'meh', location: 'src/b.ts' },
            { severity: 'blocker', category: 'security', location: 'src/c.ts' },
            { severity: 'blocker', category: 'security', title: 'injection', location: 'src/d.ts:12', evidence: 'exec(userInput)' },
          ],
        }),
      );
      const port = consolidatedBlockersFor(h.ledger);
      const read = await port(round.id);
      expect(read.blockers).toEqual([
        { category: 'correctness', title: 'boom', location: 'src/a.ts' },
        { category: 'security', title: '', location: 'src/c.ts' },
        // evidence rides along when present — it only ever breaks same-key ties
        { category: 'security', title: 'injection', location: 'src/d.ts:12', evidence: 'exec(userInput)' },
      ]);
      expect(read.note).toBeNull();

      // No recorded report → a loud note, never a silent empty.
      const bare = h.ledger.addRound({ jobId: 'job-port', lenses: ['blind'] });
      const missing = await port(bare.id);
      expect(missing.blockers).toEqual([]);
      expect(missing.note).toContain('no consolidated report recorded');

      // A malformed report → a loud note too.
      writeFileSync(join(dir, 'consolidated.json'), JSON.stringify({ notFindings: true }));
      const malformed = await port(round.id);
      expect(malformed.blockers).toEqual([]);
      expect(malformed.note).toContain('no findings array');

      // An unreadable file → loud note, never a throw that blinds the sweep.
      rmSync(join(dir, 'consolidated.json'));
      const unreadable = await port(round.id);
      expect(unreadable.blockers).toEqual([]);
      expect(unreadable.note).toContain('blockers unavailable');
    } finally {
      h.cleanup();
      rmSync(dir, { recursive: true, force: true });
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
    // The ops skill carries the current ordinary non-draft PR rule.
    const ops = skills.find((skill) => skill.name === 'ops-dispatch')!.body.replace(/\s+/gu, ' ');
    expect(ops).toContain('New pull requests are ordinary');
    expect(ops).toContain('`gh pr create` without `--draft`/`-d`');
    // Issue #125: the skill must not promise a per-lens retry — in-round
    // lens retries are Perkins-owned machinery; Silas only has the
    // wave-level review request. The rule list is pinned verbatim so a
    // retry variant cannot reappear under different wording.
    expect(ops).not.toContain('a lens retry');
    expect(ops).toContain('recorded rule (a documented retry, a re-brief on a known protocol break)');
    expect(ops).toContain('In-round lens retries are Perkins-owned machinery');
    expect(ops).toContain('wave-level request (`POST /api/dispatch/review`)');
    // Issue #162: the stalled guidance is phase-aware — an older delivery is
    // history, accepted operations fence the lane, and a null-minion row
    // (no worker record at all) is named for the lane inspection path.
    expect(ops).toContain('A truthful older delivery is history, not proof the current repair phase delivered');
    expect(ops).toContain('A row with `minionId: null` has no worker record at all');
    expect(() => loadSilasSkills(['nope'])).toThrow(/unreadable/);
  });

  it('assembles shipped skills with one scoped merge authority and exact clean-abort rule', () => {
    const prompt = buildWakePrompt({ digest: { computedAt: '2026-09-24T00:00:00Z', trigger: 'sweep',
      deliveredWithoutPr: [], prWithoutReview: [{ jobId: 'clean', repo: 'gru-command', prUrl: 'https://example.invalid/1',
        priorRounds: 1, cleanAbort: { roundId: 'clean-r1', ruleId: 'clean-abort-service-restart' } }],
      verdictsAwaitingDirective: [], stalledWorking: [], minionErrors: [],
      verificationFailures: [], verificationWaits: [], providerRecoveryPending: [], conflictingPrs: [] },
      trigger: { kind: 'sweep' }, skills: loadSilasSkills(), ops: { baseUrl: 'http://127.0.0.1:1', configPath: '/tmp/test-config' } });
    expect(prompt).toContain('You NEVER merge a pull request');
    expect(prompt).toContain('The owner holds every merge');
    expect(prompt).not.toContain('Gru may merge gru-command only');
    expect(prompt).toContain('fallback PASS is not that clearance');
    expect(prompt).not.toContain('owner holds merges elsewhere');
    expect(prompt).toContain('clean-abort-service-restart');
    expect(prompt).toContain('source_round_id');
    // Issue #125: the assembled prompt never instructs the phantom action
    // (whitespace-normalized, so a line-broken spelling cannot slip past).
    const flatPrompt = prompt.replace(/\s+/gu, ' ');
    expect(flatPrompt).not.toContain('a lens retry');
    expect(flatPrompt).toContain('In-round lens retries are Perkins-owned machinery');
    expect(prompt).not.toContain('human holds the merge);');
    // Verification capture (issue #159): the wake prompt names the shipped
    // helper absolutely so no lane hand-rolls a watcher — the resolved path
    // must be the package's own compiled CLI, not merely a matching basename.
    expect(prompt).toContain('Verification capture helper');
    expect(CAPTURE_HELPER_PATH).toBe(join(import.meta.dirname, '..', 'dist', 'verify', 'capture-cli.js'));
    expect(prompt).toContain(`${CAPTURE_HELPER_PATH} run --job`);
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
        verificationFailures: [],
        verificationWaits: [],
        providerRecoveryPending: [],
        conflictingPrs: [],
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
  pollIntervalMs?: number;
  githubPoll?: GitHubPollPort;
  bus?: boolean;
  skills?: readonly SkillModule[];
  timers?: {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
  /** The board's live stop truth, wired through to the digest the same way
   * main.ts wires it (final independent review T0). */
  supervisionFor?: (agentId: string) => AgentSupervisionView | null;
  now?: () => number;
  onDeterministicPass?: DeterministicPassHook;
  /** Issue #224 shadow wiring pass-through. */
  decisions?: Pick<DecisionService, 'decide'>;
  readyForSurface?: (surface: string) => boolean;
  blockersForRound?: BlockersForRound;
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
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_SILAS_CONFIG.pollIntervalMs,
    },
    ops: { baseUrl: 'http://127.0.0.1:7665', configPath: '/instance/config.toml' },
    ...(opts.bus === false ? {} : { bus: h.bus }),
    ...(opts.githubPoll !== undefined ? { githubPoll: opts.githubPoll } : {}),
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
    ...(opts.timers !== undefined ? { setInterval: opts.timers.setInterval, clearInterval: opts.timers.clearInterval } : {}),
    ...(opts.supervisionFor !== undefined ? { supervisionFor: opts.supervisionFor } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.onDeterministicPass !== undefined ? { onDeterministicPass: opts.onDeterministicPass } : {}),
    ...(opts.decisions !== undefined ? { decisions: opts.decisions } : {}),
    ...(opts.readyForSurface !== undefined ? { readyForSurface: opts.readyForSurface } : {}),
    ...(opts.blockersForRound !== undefined ? { blockersForRound: opts.blockersForRound } : {}),
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

  it('a recorded clean-abort event wakes Silas with the bounded same-head rule', async () => {
    const h = makeDriver();
    try {
      h.driver.start();
      addJobWithDelivery(h.ledger, 'abort-wake', { prUrl: 'https://example.invalid/1' });
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'abort-wake', payload: { sha: 'same-head' } });
      const round = h.ledger.addRound({ jobId: 'abort-wake', targetRef: 'same-head' });
      h.ledger.setRoundStatus(round.id, 'aborted');
      h.ledger.setJobStatus('abort-wake', 'in-review');
      const event = h.ledger.appendCustomEvent({ kind: 'round.perkins-incomplete', roundId: round.id,
        jobId: 'abort-wake', payload: { reason: 'service_restart' } });
      h.bus.publish(event);
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
      expect(h.prompts[0]?.text).toContain('clean-abort-service-restart');
      expect(h.prompts[0]?.text).toContain('"roundId": "abort-wake-r1"');
    } finally { h.cleanup(); }
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

  it('the supervisionFor wiring reaches the digest: a stopped worker never wakes as stalled', async () => {
    // main.ts injects the supervisor views into the DRIVER; a broken wiring
    // would silently re-enable stall wakes for stopped lanes (final
    // independent review T0). The stop truth travels the real path here.
    const realNow = Date.now();
    const future = (): number => realNow + DEFAULT_SILAS_CONFIG.stallThresholdMs + 1_000;
    const base = {
      agentId: 'min-wired',
      role: 'minion' as const,
      slotId: null,
      restarts: 1,
      openTurn: false,
      openToolCalls: 0,
      lastEventAt: null,
      lastFileBytes: null,
    };
    let view: AgentSupervisionView | null = {
      ...base,
      state: 'stopped',
      breakerOpen: true,
      stopReason: 'quota_wall',
    };
    const h = makeDriver({ now: future, supervisionFor: (agentId) => (agentId === 'min-wired' ? view : null) });
    try {
      h.ledger.addJob({ id: 'job-wired', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-wired', 'working');
      h.ledger.registerAgent({ id: 'min-wired', role: 'minion', jobId: 'job-wired' });
      h.ledger.setAgentState('min-wired', 'idle');
      // A waiting lane: the sweep has nothing to wake Silas about.
      await h.driver.trigger({ kind: 'sweep' });
      expect(h.prompts).toHaveLength(0);
      expect(h.ledger.listEvents({ limit: 50 }).filter((event) => event.kind === 'silas.wake')).toHaveLength(0);
      // The same wiring with no stop record: the genuine stall wakes.
      view = null;
      await h.driver.trigger({ kind: 'sweep' });
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
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

// ------------------------------------------------------------------
// Sweep timer + bus subscription surface (injected seams)
// ------------------------------------------------------------------

describe('silas driver sweep timer and wake kinds', () => {
  it('start schedules the configured sweep; a tick wakes actionable lanes; stop clears and unsubscribes', async () => {
    const ticks: Array<() => void> = [];
    let cleared = 0;
    const h = makeDriver({
      sweepIntervalMs: 1234,
      timers: {
        setInterval: ((callback: () => void) => {
          ticks.push(callback);
          return { unref() {} } as unknown as ReturnType<typeof setInterval>;
        }) as unknown as typeof setInterval,
        clearInterval: (() => {
          cleared += 1;
        }) as unknown as typeof clearInterval,
      },
    });
    try {
      h.driver.start();
      expect(h.driver.running).toBe(true);
      expect(ticks).toHaveLength(1);
      // an empty sweep tick does not wake
      ticks[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.prompts).toHaveLength(0);
      // an actionable tick wakes the slot with the sweep trigger
      addJobWithDelivery(h.ledger, 'job-tick');
      ticks[0]?.();
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
      expect(h.prompts[0]?.text).toContain('trigger: sweep');
      h.driver.stop();
      expect(h.driver.running).toBe(false);
      expect(cleared).toBe(1);
      // stopped: neither later ticks nor bus events wake the slot
      ticks[0]?.();
      h.bus.publish({
        seq: 1,
        ts: new Date().toISOString(),
        kind: 'job.delivered',
        agentId: null,
        jobId: 'job-tick',
        roundId: null,
        lens: null,
        payload: {},
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.prompts).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('subscribes to every wake kind: job.delivered, round.verdict, and job.minion-error', async () => {
    const h = makeDriver();
    try {
      h.driver.start();
      h.bus.publish({
        seq: 1,
        ts: new Date().toISOString(),
        kind: 'round.verdict',
        agentId: null,
        jobId: 'job-v',
        roundId: 'job-v-r1',
        lens: null,
        payload: { verdict: 'changes-requested' },
      });
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
      expect(h.prompts[0]?.text).toContain('trigger: round.verdict');
      h.bus.publish({
        seq: 2,
        ts: new Date().toISOString(),
        kind: 'job.minion-error',
        agentId: null,
        jobId: 'job-e',
        roundId: null,
        lens: null,
        payload: { error: 'provider down' },
      });
      await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
      expect(h.prompts[1]?.text).toContain('trigger: job.minion-error');
    } finally {
      h.cleanup();
    }
  });
});

// ------------------------------------------------------------------
// Driver: the fast github signal poll timer
// ------------------------------------------------------------------

describe('silas driver github signal poll', () => {
  const emptyTick = {
    tracked: 0,
    observed: 0,
    calls: 0,
    budgetExhausted: false,
    rateLimited: false,
    signals: [],
  };

  it('ticks the poll on poll_interval_ms and stops with the driver; 0 disables the timer', async () => {
    const ticks: Array<() => void> = [];
    let polls = 0;
    let clears = 0;
    const githubPoll: GitHubPollPort = {
      pollOnce: async () => {
        polls += 1;
        return emptyTick;
      },
    };
    const timers = {
      setInterval: ((callback: () => void) => {
        ticks.push(callback);
        return { unref() {} } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        clears += 1;
      }) as unknown as typeof clearInterval,
    };
    const h = makeDriver({ sweepIntervalMs: 0, pollIntervalMs: 5_000, githubPoll, timers });
    try {
      h.driver.start();
      expect(h.driver.pollRunning).toBe(true);
      expect(ticks).toHaveLength(1);
      ticks[0]?.();
      await vi.waitFor(() => expect(polls).toBe(1));
      h.driver.stop();
      expect(h.driver.pollRunning).toBe(false);
      expect(clears).toBe(1);
    } finally {
      h.cleanup();
    }

    const off = makeDriver({ sweepIntervalMs: 0, pollIntervalMs: 0, githubPoll, timers });
    try {
      off.driver.start();
      expect(off.driver.pollRunning).toBe(false);
      expect(ticks).toHaveLength(1); // nothing new registered
    } finally {
      off.cleanup();
    }
  });

  it('a failing poll tick is logged and never thrown; the next tick retries', async () => {
    const ticks: Array<() => void> = [];
    let polls = 0;
    const githubPoll: GitHubPollPort = {
      pollOnce: async () => {
        polls += 1;
        throw new Error('gh down');
      },
    };
    const h = makeDriver({
      sweepIntervalMs: 0,
      pollIntervalMs: 5_000,
      githubPoll,
      timers: {
        setInterval: ((callback: () => void) => {
          ticks.push(callback);
          return { unref() {} } as unknown as ReturnType<typeof setInterval>;
        }) as unknown as typeof setInterval,
        clearInterval: (() => {}) as unknown as typeof clearInterval,
      },
    });
    try {
      h.driver.start();
      ticks[0]?.();
      await vi.waitFor(() => expect(polls).toBe(1));
      // the failure settled without throwing and the next interval retried
      ticks[0]?.();
      await vi.waitFor(() => expect(polls).toBe(2));
      expect(h.driver.pollRunning).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});

// ------------------------------------------------------------------

// Deterministic pass health + open-turn independence (issue #163)
// ------------------------------------------------------------------

describe('silas deterministic pass observation (issue #163)', () => {
  const kinds = (h: DriverHarness, kind: string): EventRecord[] =>
    h.ledger.listEvents({ limit: 200 }).filter((event) => event.kind === kind);

  it('keeps reconciling while a model prompt is held open; one queued wake follows settlement', async () => {
    const passes: { trigger: string; wakeInFlight: boolean }[] = [];
    const h = makeDriver({
      onDeterministicPass: (context) => {
        passes.push({ trigger: context.trigger, wakeInFlight: context.wakeInFlight });
        return { examined: 1, advanced: 1 };
      },
    });
    try {
      // An actionable row so the coalesced wake after settlement actually prompts.
      addJobWithDelivery(h.ledger, 'job-open');
      h.hold();
      const first = h.driver.trigger({ kind: 'job.delivered', jobId: 'job-open' });
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));

      // Two sweep ticks land while the prompt is unresolved. The pass runs
      // for each (there is no in-flight pass to coalesce onto), the wake is
      // not stacked, and no second prompt exists.
      await h.driver.trigger({ kind: 'sweep' });
      await h.driver.trigger({ kind: 'sweep' });
      expect(h.prompts).toHaveLength(1);
      expect(passes.map((p) => p.trigger)).toEqual(['job.delivered', 'sweep', 'sweep']);
      expect(passes[1]?.wakeInFlight).toBe(true);
      // Every tick left a durable observation and every pass a completed
      // reconciliation; the open turn cannot hide either.
      const ticks = kinds(h, 'silas.tick');
      expect(ticks).toHaveLength(3);
      expect(ticks[1]?.payload).toMatchObject({ trigger: 'sweep', wake_in_flight: true });
      const reconciles = kinds(h, 'silas.reconcile');
      expect(reconciles).toHaveLength(3);
      expect(reconciles.every((event) => (event.payload as { ok?: unknown }).ok === true)).toBe(true);
      expect((reconciles[1]?.payload as { counts?: unknown }).counts).toEqual({ examined: 1, advanced: 1 });
      // The wake marker still means "wake start": only the first wake exists.
      expect(kinds(h, 'silas.wake')).toHaveLength(1);

      h.settle();
      await first;
      // Exactly ONE coalesced wake runs at settlement — no stacked wakes.
      await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
      expect(kinds(h, 'silas.wake')).toHaveLength(2);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.prompts).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('coalesces overlapping passes onto ONE execution and never spawns a second turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invocations = 0;
    const h = makeDriver({
      onDeterministicPass: async () => {
        invocations += 1;
        await gate;
        return { examined: 0, advanced: 0 };
      },
    });
    try {
      addJobWithDelivery(h.ledger, 'job-overlap');
      const first = h.driver.trigger({ kind: 'job.delivered', jobId: 'job-overlap' });
      await vi.waitFor(() => expect(kinds(h, 'silas.tick')).toHaveLength(1));
      const second = h.driver.trigger({ kind: 'sweep' });
      await vi.waitFor(() => expect(kinds(h, 'silas.tick')).toHaveLength(2));
      // Both triggers are blocked on the SAME pass: one execution, zero
      // wake markers, zero completed reconciliations yet.
      expect(invocations).toBe(1);
      expect(kinds(h, 'silas.wake')).toHaveLength(0);
      expect(kinds(h, 'silas.reconcile')).toHaveLength(0);
      release();
      await first;
      await second;
      // One wake plus exactly one coalesced wake at settlement; no third.
      await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.prompts).toHaveLength(2);
      expect(kinds(h, 'silas.reconcile')).toHaveLength(2); // one per accepted trigger, never a stacked pass
    } finally {
      release();
      h.cleanup();
    }
  });

  it('records a failed pass as ok:false and never as a completed reconciliation', async () => {
    const h = makeDriver({
      onDeterministicPass: () => {
        throw new Error('ledger exploded');
      },
    });
    try {
      addJobWithDelivery(h.ledger, 'job-fail-pass');
      await h.driver.trigger({ kind: 'sweep' });
      const reconciles = kinds(h, 'silas.reconcile-failed');
      expect(reconciles).toHaveLength(1);
      expect(reconciles[0]?.payload).toMatchObject({ ok: false, error: 'Error: ledger exploded' });
      // A failure is never recorded as a completed reconciliation.
      expect(kinds(h, 'silas.reconcile')).toHaveLength(0);
      // The failed pass never blocks the wake path.
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
    } finally {
      h.cleanup();
    }
  });
  it('a partial pass (ok:false with failures) is recorded as failed, never as a completed reconciliation', async () => {
    const h = makeDriver({
      onDeterministicPass: () => ({ ok: false, failures: 2, advanced: 1 }),
    });
    try {
      addJobWithDelivery(h.ledger, 'job-partial-pass');
      await h.driver.trigger({ kind: 'sweep' });
      expect(kinds(h, 'silas.reconcile')).toHaveLength(0);
      const failed = kinds(h, 'silas.reconcile-failed');
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({ ok: false, counts: { ok: false, failures: 2, advanced: 1 } });
    } finally {
      h.cleanup();
    }
  });

  it('the REAL durable pass advances an approved lane while the model prompt is held open', async () => {
    // Production composition: the hook is exactly the reconcileDurableWork
    // call main.ts wires. A completion that lands DURING the open turn is
    // settled by the independent pass; one coalesced wake follows.
    const posts: { kind: string }[] = [];
    const notifications: FollowThroughNotifications = {
      postIncident: (input) => {
        posts.push({ kind: input.kind });
        return { id: `notice-${posts.length}` };
      },
    };
    const h = makeDriver({
      // The production factory, invoked lazily because it needs the
      // harness's ledger instance (made inside makeDriver).
      onDeterministicPass: (context) =>
        createDurableReconcileHook({ ledger: h.ledger, notifications })(context),
    });
    try {
      const job = h.ledger.addJob({ id: 'job-midturn', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus(job.id, 'working');
      const phase = h.ledger.beginPhaseHandoff({
        jobId: job.id,
        source: 'silas-rebrief',
        intent: { kind: 'gru-decision', decision: 'rule on the mid-turn completion' },
      }).record;
      h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId: job.id, payload: { phase_id: phase.phaseId } });
      // An actionable lane so the one queued wake after settlement prompts.
      addJobWithDelivery(h.ledger, 'job-open-wake');
      h.hold();
      const first = h.driver.trigger({ kind: 'job.delivered', jobId: 'job-open-wake' });
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));

      // The correlated completion lands while the prompt is unresolved.
      h.ledger.appendCustomEvent({
        kind: 'job.delivered',
        jobId: job.id,
        payload: { phase_id: phase.phaseId, source: 'silas-rebrief' },
      });
      await h.driver.trigger({ kind: 'sweep' });
      expect(h.ledger.getPhaseHandoff(phase.phaseId)?.state).toBe('completed');
      expect(h.ledger.listObligations({ jobId: job.id })).toHaveLength(1);
      expect(posts).toHaveLength(1);
      expect(h.prompts).toHaveLength(1); // still the one held turn

      h.settle();
      await first;
      await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.prompts).toHaveLength(2); // exactly one coalesced wake, no second session
    } finally {
      h.cleanup();
    }
  });

  it('wakes on a failed verification or capacity timeout, never on a routine PASS', async () => {
    const h = makeDriver();
    try {
      h.driver.start();
      const publish = (kind: string, payload: unknown): void => {
        h.bus.publish({
          seq: 1,
          ts: new Date().toISOString(),
          kind,
          agentId: null,
          jobId: 'job-verify-wake',
          roundId: null,
          lens: null,
          payload,
        });
      };
      publish('verification.completed', { ok: true, scope: 'full' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(h.prompts).toHaveLength(0);
      publish('verification.completed', { ok: false, scope: 'full' });
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
      publish('verification.lock-timeout', { scope: 'full', request_id: 'req-wake' });
      await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    } finally {
      h.cleanup();
    }
  });

  it('a lone verification timeout is actionable on a sweep (no unrelated event needed)', async () => {
    const h = makeDriver();
    try {
      h.ledger.addJob({ id: 'job-wait-wake', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-wait-wake', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.lock-timeout',
        jobId: 'job-wait-wake',
        payload: { scope: 'full', request_id: 'req-lone', head: 'head-lone', wait_ms: 900_000 },
      });
      await h.driver.trigger({ kind: 'sweep' });
      await vi.waitFor(() => expect(h.prompts).toHaveLength(1));
      expect(h.prompts[0]?.text).toContain('req-lone');
    } finally {
      h.cleanup();
    }
  });

  it('the main assembly wires the durable reconciliation pass into the driver (assembly alarm)', () => {
    const mainSource = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(mainSource).toMatch(
      /import\s*\{[^}]*\bcreateProductionDeterministicPass\b[^}]*\}\s*from\s*'\.\/dispatch\/durable-reconcile\.js'/,
    );
    expect(mainSource).toMatch(/onDeterministicPass:\s*createProductionDeterministicPass\(\{/);
    expect(mainSource).toMatch(/getWave:\s*\(\)\s*=>\s*state\.wave/);
  });
  it('a wait row is bound to its pinned head: another head cannot retire it, the same head can', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-head', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-head', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.lock-timeout',
        jobId: 'job-head',
        payload: { scope: 'full', request_id: 'req-head', head: 'head-a', wait_ms: 1_000 },
      });
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-head',
        payload: { ok: true, scope: 'full', run_id: 'other-run', sha: 'head-b' },
      });
      const otherHead = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      // A result for a different revision is not the timed-out submission.
      expect(otherHead.verificationWaits.map((row) => row.requestId)).toEqual(['req-head']);

      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-head',
        payload: { ok: true, scope: 'full', run_id: 'pinned-run', sha: 'head-a' },
      });
      const sameHead = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(sameHead.verificationWaits).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a reconciled replay never retires a failed run, and an earlier matching rung survives a later unrelated one', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-rung2', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-rung2', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-rung2',
        payload: { ok: false, scope: 'full', run_id: 'run-9', exit_code: 1 },
      });
      // A replay of an older run is not a new attempt.
      h.ledger.appendCustomEvent({
        kind: 'verification.reconciled',
        jobId: 'job-rung2',
        payload: { scope: 'full', request_id: 'old-req' },
      });
      const replayed = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(replayed.verificationFailures.map((row) => row.scope)).toEqual(['full']);

      // The matching rung lands, then an unrelated fingerprint-less rung:
      // the matching disposition is not forgotten.
      h.ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId: 'job-rung2',
        payload: { request_id: 'req-fix', blocker_fingerprint: 'verification-failure:full@run-9' },
      });
      h.ledger.appendCustomEvent({
        kind: 'silas.rebrief',
        jobId: 'job-rung2',
        payload: { request_id: 'req-other' },
      });
      const handled = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(handled.verificationFailures).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('bounds the follow-up pass: many triggers during one slow pass run at most one extra pass each interval', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let invocations = 0;
    let active = 0;
    let maxActive = 0;
    const h = makeDriver({
      onDeterministicPass: async () => {
        invocations += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await gate;
        active -= 1;
        return { examined: 0, advanced: 0 };
      },
    });
    try {
      addJobWithDelivery(h.ledger, 'job-bound');
      // Hold the model turn so the queued triggers cannot chain passes
      // through wake drains; the count then isolates pass coalescing.
      h.hold();
      const first = h.driver.trigger({ kind: 'job.delivered', jobId: 'job-bound' });
      await vi.waitFor(() => expect(invocations).toBe(1));
      const rest = [
        h.driver.trigger({ kind: 'sweep' }),
        h.driver.trigger({ kind: 'sweep' }),
        h.driver.trigger({ kind: 'sweep' }),
        h.driver.trigger({ kind: 'sweep' }),
      ];
      await vi.waitFor(() => expect(maxActive).toBe(1));
      release();
      // Four mid-pass observations produced exactly ONE follow-up pass.
      await vi.waitFor(() => expect(invocations).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(invocations).toBe(2);
      expect(maxActive).toBe(1); // passes never overlap
      h.settle();
      await Promise.all([first, ...rest]);
      expect(invocations).toBeLessThanOrEqual(3); // at most one queued-wake pass
    } finally {
      h.settle();
      release();
      h.cleanup();
    }
  });

  it('fences synchronous re-entry: a hook that publishes a wake event starts no second pass', async () => {
    let invocations = 0;
    let active = 0;
    let maxActive = 0;
    const h = makeDriver({
      onDeterministicPass: () => {
        invocations += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (invocations === 1) {
          // A wake-kind event published from the hook's SYNC portion.
          h.bus.publish({
            seq: 1,
            ts: new Date().toISOString(),
            kind: 'job.delivered',
            agentId: null,
            jobId: 'job-reentry',
            roundId: null,
            lens: null,
            payload: {},
          });
        }
        active -= 1;
        return { examined: 0, advanced: 0 };
      },
    });
    try {
      await h.driver.trigger({ kind: 'sweep' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(maxActive).toBe(1);
      expect(invocations).toBeLessThanOrEqual(3);
    } finally {
      h.cleanup();
    }
  });

  it('never claims or executes silas-mechanical debt: the closed registry mints none today', async () => {
    // The issue's plan allows routing an ALREADY-AUTHORIZED next step; the
    // closed firing-rule registry contains no rule that grants a
    // silas-mechanical action, so the pass cannot enumerate one. This pin
    // fails the moment a mechanical rule is added without an executor.
    expect(FIRING_RULES.some((rule) => rule.nextAction.kind === 'silas-mechanical')).toBe(false);
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-mech', repo: 'fixture-app', title: 't', briefing: 'b' });
      // A VALID chief ruling makes the authority verifiable/executable in
      // the ledger — the pass still does not claim it, because no executor
      // port exists for any closed mechanical action (the missing piece is
      // an execution port, not the reconciliation).
      h.ledger.appendCustomEvent({
        kind: 'ruling.recorded',
        jobId: 'job-mech',
        payload: { ref: 'r-mech', version: '1' },
      });
      const obligation = h.ledger.recordBlockedObservation('job-mech', {
        logicalStep: 'implementation',
        category: { kind: 'known', category: 'quality-gate' },
        incidentKey: 'mechanical-pin',
        observedAtSeq: h.ledger.latestEventSeq(),
        nextAction: { kind: 'silas-mechanical', action: 'register-pr' },
        authority: { source: 'chief-ruling', rulingRef: 'r-mech', version: '1' },
      });
      expect(h.ledger.verifyObligationAuthority(obligation.id).executable).toBe(true);
      const report = reconcileDurableWork({
        ledger: h.ledger,
        notifications: { postIncident: () => ({ id: 'notice-pin' }) },
      });
      expect(
        h.ledger.listEvents({ limit: 100 }).filter((event) => event.kind === 'job.obligation-claimed'),
      ).toHaveLength(0);
      expect(h.ledger.listObligations({ jobId: 'job-mech' }).every((row) => row.claim === null)).toBe(true);
      expect(report.ok).toBe(true); // the pass completed without touching mechanical debt
    } finally {
      h.cleanup();
    }
  });
  it('only the EXACT canonical fingerprint retires a failed run; embedded or suffixed markers do not', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-exact', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-exact', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-exact',
        payload: { ok: false, scope: 'full', run_id: 'run-9', exit_code: 1 },
      });
      for (const fingerprint of [
        'lint:verification-failure:full@run-9',
        'verification-failure:full@run-9@extra',
        'verification-failure:full@run-90',
      ]) {
        h.ledger.appendCustomEvent({
          kind: 'silas.directive-sent',
          jobId: 'job-exact',
          payload: { request_id: `req-${fingerprint}`, blocker_fingerprint: fingerprint },
        });
      }
      const embedded = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(embedded.verificationFailures.map((row) => row.scope)).toEqual(['full']);

      h.ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId: 'job-exact',
        payload: { request_id: 'req-exact', blocker_fingerprint: 'verification-failure:full@run-9' },
      });
      const exact = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(exact.verificationFailures).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
  it('a same-head but different-scope submission does not retire a failure or wait', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-samehead', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-samehead', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-samehead',
        payload: { ok: false, scope: 'full', run_id: 'run-full', sha: 'head-h', exit_code: 1 },
      });
      h.ledger.appendCustomEvent({
        kind: 'verification.lock-timeout',
        jobId: 'job-samehead',
        payload: { scope: 'focused', request_id: 'req-focused', head: 'head-h', wait_ms: 1_000 },
      });
      // A focused request at the SAME head is another operation, not a
      // full retry or an answer to the focused wait.
      h.ledger.appendCustomEvent({
        kind: 'verification.requested',
        jobId: 'job-samehead',
        payload: { scope: 'focused', request_id: 'req-focused-2', head: 'head-h' },
      });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(digest.verificationFailures.map((row) => row.scope)).toEqual(['full']);
      // The focused wait IS retired by the focused request (same scope+head).
      expect(digest.verificationWaits).toEqual([]);

      // A full-scope request at the same head retires the full failure.
      h.ledger.appendCustomEvent({
        kind: 'verification.requested',
        jobId: 'job-samehead',
        payload: { scope: 'full', request_id: 'req-full-2', head: 'head-h' },
      });
      const retried = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(retried.verificationFailures).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
  it('records pass-attributed progress only when the pass actually advanced work', async () => {
    const h = makeDriver({
      onDeterministicPass: (context) => ({ ok: true, advanced: context.trigger === 'sweep' ? 1 : 0 }),
    });
    try {
      addJobWithDelivery(h.ledger, 'job-advanced');
      await h.driver.trigger({ kind: 'sweep' });
      const marks = h.ledger.listEvents({ limit: 100 }).filter((event) => event.kind === 'silas.reconcile-advanced');
      expect(marks).toHaveLength(1);
      expect(marks[0]?.payload).toMatchObject({ trigger: 'sweep', advanced: 1 });
      await h.driver.trigger({ kind: 'job.delivered', jobId: 'job-advanced' });
      expect(h.ledger.listEvents({ limit: 100 }).filter((event) => event.kind === 'silas.reconcile-advanced')).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('attachments and pre-existing attempts starting do NOT answer a headless verification debt', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-started', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-started', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-started',
        payload: { ok: false, scope: 'full', run_id: 'run-s', exit_code: 1 },
      });
      h.ledger.appendCustomEvent({
        kind: 'verification.lock-timeout',
        jobId: 'job-started',
        payload: { scope: 'full', request_id: 'req-s', wait_ms: 1_000 },
      });
      for (const kind of ['verification.started', 'verification.attached']) {
        h.ledger.appendCustomEvent({ kind, jobId: 'job-started', payload: { scope: 'full', run_id: 'run-old' } });
      }
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(digest.verificationFailures.map((row) => row.scope)).toEqual(['full']);
      expect(digest.verificationWaits.map((row) => row.requestId)).toEqual(['req-s']);
    } finally {
      h.cleanup();
    }
  });

  it('a same-head completion in another scope does not answer a wait; the matching completion does', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-wait-scope', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-wait-scope', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.lock-timeout',
        jobId: 'job-wait-scope',
        payload: { scope: 'full', request_id: 'req-full-wait', head: 'head-w', wait_ms: 1_000 },
      });
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-wait-scope',
        payload: { ok: true, scope: 'focused', run_id: 'run-f', sha: 'head-w' },
      });
      const otherScope = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(otherScope.verificationWaits.map((row) => row.requestId)).toEqual(['req-full-wait']);

      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-wait-scope',
        payload: { ok: true, scope: 'full', run_id: 'run-ok', sha: 'head-w' },
      });
      const answered = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(answered.verificationWaits).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('a scoped request never retires a scope-less (legacy) verification debt', async () => {
    const h = makeLedger();
    try {
      h.ledger.addJob({ id: 'job-scopeless', repo: 'fixture-app', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('job-scopeless', 'working');
      h.ledger.appendCustomEvent({
        kind: 'verification.completed',
        jobId: 'job-scopeless',
        payload: { ok: false, run_id: 'run-noscope', exit_code: 1 },
      });
      h.ledger.appendCustomEvent({
        kind: 'verification.requested',
        jobId: 'job-scopeless',
        payload: { scope: 'full', request_id: 'req-other-scope' },
      });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
      expect(digest.verificationFailures).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });
});

// ------------------------------------------------------------------
// Issue #224: same-blocker identity surface (shadow)
// ------------------------------------------------------------------

describe('same-blocker identity candidates (issue #224)', () => {
  const b = (title: string, location = 'src/a.ts', category = 'correctness', extra: Partial<RoundBlocker> = {}): RoundBlocker => ({
    title,
    location,
    category,
    ...extra,
  });

  it('pairs blockers whose fingerprints differ but file and category overlap', () => {
    const latest = [b('null deref on empty path', 'src/a.ts:42')];
    const priorRounds = [[b('null deref', 'src/a.ts:10'), b('unrelated other file', 'src/b.ts:1', 'security')]];
    const pairs = sameBlockerPairs(latest, priorRounds);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.prior.title).toBe('null deref');
    expect(pairs[0]?.current.title).toBe('null deref on empty path');
  });

  it('never pairs identical fingerprints, different files, or different categories', () => {
    const same = b('same leak', 'src/a.ts');
    expect(sameBlockerPairs([same], [[b('same leak', 'src/a.ts:999')]])).toEqual([]);
    expect(sameBlockerPairs([b('x', 'src/a.ts')], [[b('y', 'src/b.ts')]])).toEqual([]);
    expect(sameBlockerPairs([b('x', 'src/a.ts', 'correctness')], [[b('y', 'src/a.ts', 'security')]])).toEqual([]);
  });

  it('searches prior rounds newest-first, one prior match per current blocker, capped', () => {
    const latest = [b('current', 'src/a.ts')];
    const pairs = sameBlockerPairs(latest, [[b('newer prior', 'src/a.ts:2')], [b('older prior', 'src/a.ts:1')]]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.prior.title).toBe('newer prior');
    // Current blockers dedupe by fingerprint and the cap bounds the list.
    const manyCurrents = Array.from({ length: 12 }, (_, index) => b(`defect ${index}`, `src/f${index}.ts`, 'security'));
    const onePrior = [manyCurrents.slice(0, 11).map((blocker, index) => b(`prior ${index}`, `src/f${index}.ts`, 'security'))];
    const capped = sameBlockerPairs(manyCurrents, onePrior);
    expect(capped).toHaveLength(8);
  });

  it('the digest invokes the observer for a real overlap and never for identical fingerprints', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-pair', { prUrl: 'https://git.example.invalid/o/r/pull/12' });
      const reports = new Map<string, RoundBlocker[]>();
      const blockersForRound = async (roundId: string) => ({ blockers: reports.get(roundId) ?? [], note: null });
      const r1 = h.ledger.addRound({ jobId: 'job-pair', lenses: ['blind'] });
      reports.set(r1.id, [b('null deref', 'src/a.ts:10', 'correctness', { detail: 'crash on empty input' })]);
      h.ledger.setRoundStatus(r1.id, 'live');
      h.ledger.setRoundStatus(r1.id, 'verdict-posted');
      h.ledger.setRoundVerdict(r1.id, 'changes-requested');
      h.ledger.setJobStatus('job-pair', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-pair', roundId: r1.id, payload: { verdict: 'changes-requested' } });

      // Round 2: an evolved title at the same file+category (different
      // fingerprint) and an identical re-report (same fingerprint).
      const r2 = h.ledger.addRound({ jobId: 'job-pair', lenses: ['blind'] });
      reports.set(r2.id, [
        b('null deref', 'src/a.ts', 'correctness'),
        b('null deref on empty path', 'src/a.ts:44', 'correctness', { detail: 'still crashes' }),
      ]);
      h.ledger.setRoundStatus(r2.id, 'live');
      h.ledger.setRoundStatus(r2.id, 'verdict-posted');
      h.ledger.setRoundVerdict(r2.id, 'changes-requested');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-pair', roundId: r2.id, payload: { verdict: 'changes-requested' } });

      const observed: (string)[] = [];
      const pairs: SameBlockerPair[] = [];
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound,
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'round.verdict',
        onSameBlockerPair: (jobId, pair) => {
          observed.push(jobId);
          pairs.push(pair);
        },
      });
      // Only the different-fingerprint overlap pairs; the identical
      // re-report is the ladder's own job (same fingerprint), never a
      // question.
      expect(observed).toEqual(['job-pair']);
      expect(pairs[0]?.current.title).toBe('null deref on empty path');
      expect(pairs[0]?.prior.title).toBe('null deref');
      // The digest itself is unchanged: same recurring-blocker rows.
      expect(digest.verdictsAwaitingDirective).toHaveLength(1);
      expect(digest.verdictsAwaitingDirective[0]?.recurringBlockers).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });

  it('a throwing observer never breaks the digest', async () => {
    const h = makeLedger();
    try {
      addJobWithDelivery(h.ledger, 'job-throw', { prUrl: 'https://git.example.invalid/o/r/pull/13' });
      const reports = new Map<string, RoundBlocker[]>();
      const blockersForRound = async (roundId: string) => ({ blockers: reports.get(roundId) ?? [], note: null });
      const r1 = h.ledger.addRound({ jobId: 'job-throw', lenses: ['blind'] });
      reports.set(r1.id, [b('old defect', 'src/a.ts:1')]);
      h.ledger.setRoundStatus(r1.id, 'live');
      h.ledger.setRoundStatus(r1.id, 'verdict-posted');
      h.ledger.setRoundVerdict(r1.id, 'changes-requested');
      h.ledger.setJobStatus('job-throw', 'in-review');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-throw', roundId: r1.id, payload: { verdict: 'changes-requested' } });
      const r2 = h.ledger.addRound({ jobId: 'job-throw', lenses: ['blind'] });
      reports.set(r2.id, [b('new defect', 'src/a.ts:2')]);
      h.ledger.setRoundStatus(r2.id, 'live');
      h.ledger.setRoundStatus(r2.id, 'verdict-posted');
      h.ledger.setRoundVerdict(r2.id, 'changes-requested');
      h.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-throw', roundId: r2.id, payload: { verdict: 'changes-requested' } });
      const digest = await computeSilasDigest({
        ledger: h.ledger,
        blockersForRound,
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'round.verdict',
        onSameBlockerPair: () => {
          throw new Error('observer bug');
        },
      });
      expect(digest.verdictsAwaitingDirective).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it('the driver asks the same_blocker surface in shadow, dedupes per pair, and isolates provider failures', async () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const reports = new Map<string, RoundBlocker[]>();
    const asks: { readonly surface: string | undefined; readonly state: string }[] = [];
    let failNext = false;
    // The driver never reads the outcome; the fixed stand-in keeps the
    // fake honest without widening the real contract.
    const fakeDecide: Pick<DecisionService, 'decide'>['decide'] = async (request, opts) => {
      if (failNext) {
        failNext = false;
        throw new Error('provider down');
      }
      asks.push({ surface: opts?.surface, state: request.state });
      return deterministicShadowOutcome() as never;
    };
    const h = makeDriver({
      blockersForRound: async (roundId: string) => ({ blockers: reports.get(roundId) ?? [], note: null }),
      decisions: { decide: fakeDecide },
      readyForSurface: (surface) => surface === DECISION_SURFACE_SAME_BLOCKER,
    });
    try {
      const ledger = h.ledger;
      addJobWithDelivery(ledger, 'job-shadow', { prUrl: 'https://git.example.invalid/o/r/pull/14' });
      const r1 = ledger.addRound({ jobId: 'job-shadow', lenses: ['blind'] });
      reports.set(r1.id, [b('prior defect', 'src/a.ts:10', 'correctness', { detail: 'evidence one' })]);
      ledger.setRoundStatus(r1.id, 'live');
      ledger.setRoundStatus(r1.id, 'verdict-posted');
      ledger.setRoundVerdict(r1.id, 'changes-requested');
      ledger.setJobStatus('job-shadow', 'in-review');
      ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-shadow', roundId: r1.id, payload: { verdict: 'changes-requested' } });
      const r2 = ledger.addRound({ jobId: 'job-shadow', lenses: ['blind'] });
      reports.set(r2.id, [b('evolved defect', 'src/a.ts:20', 'correctness', { detail: 'evidence two' })]);
      ledger.setRoundStatus(r2.id, 'live');
      ledger.setRoundStatus(r2.id, 'verdict-posted');
      ledger.setRoundVerdict(r2.id, 'changes-requested');
      ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-shadow', roundId: r2.id, payload: { verdict: 'changes-requested' } });

      await h.driver.trigger({ kind: 'round.verdict' });
      await flush();
      expect(asks).toHaveLength(1);
      expect(asks[0]?.surface).toBe(DECISION_SURFACE_SAME_BLOCKER);
      // The request state carries BOTH sides' facts, including detail —
      // the exact shape the labelled extractor measures.
      expect(asks[0]?.state).toContain('prior defect');
      expect(asks[0]?.state).toContain('evolved defect');
      expect(asks[0]?.state).toContain('evidence one');
      expect(asks[0]?.state).toContain('evidence two');

      // A second identical sweep dedupes: no second ask.
      await h.driver.trigger({ kind: 'sweep' });
      await flush();
      expect(asks).toHaveLength(1);

      // A provider failure is isolated: a new pair's ask fails, is logged,
      // and the driver keeps running.
      failNext = true;
      const r3 = ledger.addRound({ jobId: 'job-shadow', lenses: ['blind'] });
      reports.set(r3.id, [b('evolved defect again', 'src/a.ts:30', 'correctness', { detail: 'evidence three' })]);
      ledger.setRoundStatus(r3.id, 'live');
      ledger.setRoundStatus(r3.id, 'verdict-posted');
      ledger.setRoundVerdict(r3.id, 'changes-requested');
      ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-shadow', roundId: r3.id, payload: { verdict: 'changes-requested' } });
      await h.driver.trigger({ kind: 'round.verdict' });
      await flush();
      expect(asks).toHaveLength(1); // the failed ask never landed
    } finally {
      h.cleanup();
    }
  });

  it('no decisions dependency or a not-ready surface keeps the driver fully inert', async () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
    const overlap = async (roundId: string): Promise<{ blockers: RoundBlocker[]; note: null }> => {
      void roundId;
      return { blockers: [b('prior', 'src/a.ts:1'), b('current', 'src/a.ts:2')], note: null };
    };
    let asked = 0;
    const inertDecide: Pick<DecisionService, 'decide'>['decide'] = async () => {
      asked += 1;
      return deterministicShadowOutcome() as never;
    };
    const notReady = makeDriver({
      blockersForRound: overlap,
      decisions: { decide: inertDecide },
      readyForSurface: () => false,
    });
    const unwired = makeDriver({ blockersForRound: overlap });
    try {
      for (const harness of [notReady, unwired]) {
        addJobWithDelivery(harness.ledger, 'job-inert', { prUrl: 'https://git.example.invalid/o/r/pull/15' });
        const r1 = harness.ledger.addRound({ jobId: 'job-inert', lenses: ['blind'] });
        harness.ledger.setRoundStatus(r1.id, 'live');
        harness.ledger.setRoundStatus(r1.id, 'verdict-posted');
        harness.ledger.setRoundVerdict(r1.id, 'changes-requested');
        harness.ledger.setJobStatus('job-inert', 'in-review');
        harness.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-inert', roundId: r1.id, payload: { verdict: 'changes-requested' } });
        const r2 = harness.ledger.addRound({ jobId: 'job-inert', lenses: ['blind'] });
        harness.ledger.setRoundStatus(r2.id, 'live');
        harness.ledger.setRoundStatus(r2.id, 'verdict-posted');
        harness.ledger.setRoundVerdict(r2.id, 'changes-requested');
        harness.ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'job-inert', roundId: r2.id, payload: { verdict: 'changes-requested' } });
        await harness.driver.trigger({ kind: 'round.verdict' });
      }
      await flush();
      expect(asked).toBe(0);
    } finally {
      notReady.cleanup();
      unwired.cleanup();
    }
  });
});

/** Minimal DecisionOutcome stand-in for driver-level ask fakes: the
 * driver NEVER reads the outcome, so its shape only needs to satisfy the
 * type. */
function deterministicShadowOutcome(): DecisionOutcome<QuestionSet> {
  return {
    answers: {},
    routes: {},
    provenance: {
      source: 'deterministic',
      fallbackReason: null,
      model: null,
      latencyMs: 0,
      usage: null,
      profile: null,
    },
  };
}
