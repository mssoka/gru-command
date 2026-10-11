import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, NotificationView, OwnerPrView } from './board-protocol.js';
import {
  LESSONS_PROPOSAL_CONSEQUENCE,
  OWNER_WINDOW_SIZE,
  decidedOptionLabel,
  ownerNoticeGuidance,
  ownerPendingCount,
  ownerRows,
  ownerWindow,
  safePrUrl,
} from './owner-band.js';

function notification(id: string, overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id,
    ts: `2026-09-28T00:00:${String(10 + Number(id.slice(-2))).padStart(2, '0')}.000Z`,
    kind: 'test.notice',
    routing: 'fyi',
    severity: 'info',
    title: `Notice ${id}`,
    detail: null,
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

function pr(jobId: string, overrides: Partial<OwnerPrView> = {}): OwnerPrView {
  return {
    id: `owner-pr:${jobId}`,
    jobId,
    jobTitle: `Heist ${jobId}`,
    repo: 'demo',
    prUrl: 'https://github.com/example/demo/pull/7',
    sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    checkedAt: '2026-09-28T00:05:00.000Z',
    ...overrides,
  };
}

function snapshot(options: { notifications?: readonly NotificationView[]; ownerPrs?: readonly OwnerPrView[] } = {}): BoardSnapshot {
  return {
    repos: [],
    agents: [],
    notifications: options.notifications ?? [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'test',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
    ownerPrs: options.ownerPrs,
  };
}

describe('owner-band row model', () => {
  it('collects ONLY unacked, unresolved needs-owner rows — machine rows, acked rows and resolved rows never enter', () => {
    const rows = ownerRows(
      snapshot({
        notifications: [
          notification('owner', { routing: 'needs-owner' }),
          notification('machine', { routing: 'action-required' }),
          notification('seen-ack', { routing: 'needs-owner', shownAt: '2026-09-28T00:00:00.000Z' }),
          notification('acked', { routing: 'needs-owner', ackedAt: '2026-09-28T00:00:30.000Z' }),
          notification('resolved', { routing: 'needs-owner', resolvedAt: '2026-09-28T00:00:30.000Z' }),
          notification('fyi', { routing: 'fyi' }),
        ],
      }),
    );
    expect(rows.map((row) => row.actionId)).toEqual(['owner-notice:owner', 'owner-notice:seen-ack']);
  });

  it('a typed owner decision is a decision row and a decided row stays visible until settled', () => {
    const decision = {
      question: 'Approve the slim contract?',
      context: 'PR256 needs an owner-controlled integration route.',
      recommendation: 'Approve.',
      reservedClass: 'scope-design',
      whyNotDelegable: 'It changes the agreed scope.',
      options: [
        { id: 'approve', label: 'Approve the slim contract', consequence: 'Gru commissions the lane.' },
        { id: 'keep', label: 'Keep the current approach', consequence: 'Nothing moves.' },
      ],
      discussion: false,
    };
    const rows = ownerRows(
      snapshot({
        notifications: [
          notification('dec', { routing: 'needs-owner', kind: 'gru.owner-escalation', decision }),
          notification('decided', {
            routing: 'needs-owner',
            kind: 'gru.owner-escalation',
            decision,
            decidedAt: '2026-09-28T00:00:40.000Z',
            decidedBy: 'web',
            decidedOption: 'approve',
          }),
          notification('legacy', { routing: 'needs-owner', kind: 'port-squat' }),
        ],
      }),
    );
    expect(rows.map((row) => `${row.kind}:${row.actionId}`)).toEqual([
      'decision:owner-decision:dec',
      'decision:owner-decision:decided',
      'notice:owner-notice:legacy',
    ]);
    const decided = rows[1]!;
    expect(decided.kind === 'decision' ? decided.notification.decidedOption : null).toBe('approve');
    expect(decidedOptionLabel(decision, 'approve')).toBe('Approve the slim contract');
    expect(decidedOptionLabel(decision, null)).toBe('decision recorded');
    expect(decidedOptionLabel(decision, 'gone')).toBe('gone');
  });

  it('a Book of Lessons proposal is a decision row with Accept/Reject copy — never an Ack row (owner decision 2026-10-07)', () => {
    const rows = ownerRows(
      snapshot({
        notifications: [
          notification('p1', {
            routing: 'needs-owner',
            kind: 'lessons.proposal',
            ts: '2026-09-28T00:00:50.000Z',
            title: 'Book of Lessons: 2 lesson changes proposed',
          }),
          notification('p0', { routing: 'needs-owner', kind: 'lessons.proposal', resolvedAt: '2026-09-28T00:01:00.000Z' }),
          notification('stop', { routing: 'needs-owner', ts: '2026-09-28T00:00:20.000Z' }),
        ],
      }),
    );
    expect(rows.map((row) => `${row.kind}:${row.actionId}`)).toEqual(['proposal:owner-proposal:p1', 'notice:owner-notice:stop']);
    const proposal = rows[0]!;
    expect(proposal.kind === 'proposal' ? proposal.consequence : null).toBe(LESSONS_PROPOSAL_CONSEQUENCE);
    expect(LESSONS_PROPOSAL_CONSEQUENCE).toContain('Accept writes these changes into the Book of Lessons');
    expect(LESSONS_PROPOSAL_CONSEQUENCE).toContain('won’t be proposed again');
  });

  it('merges ack rows and PR rows newest-first with stable id tiebreak (deterministic across renders)', () => {
    const rows = ownerRows(
      snapshot({
        notifications: [notification('older', { routing: 'needs-owner', ts: '2026-09-28T00:00:00.000Z' })],
        ownerPrs: [pr('job-a'), pr('job-b', { checkedAt: '2026-09-27T00:00:00.000Z' })],
      }),
    );
    expect(rows.map((row) => row.actionId)).toEqual([
      'owner-pr:job-a', // 00:05 checkedAt — newest
      'owner-notice:older', // 00:00 notice
      'owner-pr:job-b', // yesterday
    ]);
  });

  it('treats an identical ts as a deterministic tiebreak by action id (never feed order)', () => {
    const rows = ownerRows(
      snapshot({
        notifications: [notification('z-row', { routing: 'needs-owner', ts: '2026-09-28T00:00:00.000Z' })],
        ownerPrs: [pr('a-job', { checkedAt: '2026-09-28T00:00:00.000Z' })],
      }),
    );
    expect(rows.map((row) => row.actionId)).toEqual(['owner-notice:z-row', 'owner-pr:a-job']);
  });

  it('ownerPendingCount counts owed actions, never unseen rows (shownAt does not reduce it)', () => {
    const snap = snapshot({
      notifications: [
        notification('a', { routing: 'needs-owner', shownAt: '2026-09-28T00:00:00.000Z' }),
        notification('b', { routing: 'needs-owner' }),
      ],
      ownerPrs: [pr('job-a')],
    });
    expect(ownerPendingCount(snap)).toBe(3);
  });

  it('absent ownerPrs (pre-upgrade server) degrades to notice rows only — no invented ready rows', () => {
    const rows = ownerRows(snapshot({ notifications: [notification('owner', { routing: 'needs-owner' })] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('notice');
  });

  it('the expander window keeps every obligation reachable and never hides more than the tail', () => {
    const many = ownerRows(
      snapshot({
        notifications: Array.from({ length: OWNER_WINDOW_SIZE + 3 }, (_, i) =>
          notification(`n${String(i).padStart(2, '0')}`, { routing: 'needs-owner' }),
        ),
      }),
    );
    const collapsed = ownerWindow(many, false);
    expect(collapsed.rows).toHaveLength(OWNER_WINDOW_SIZE);
    expect(collapsed.hidden).toBe(3);
    const expanded = ownerWindow(many, true);
    expect(expanded.rows).toHaveLength(many.length);
    expect(expanded.hidden).toBe(0);
  });
});

describe('owner-notice guidance — honest scope per kind, never parsed prose', () => {
  it('port squats name the manual external step and the evidence that clears it', () => {
    expect(ownerNoticeGuidance('port-squat')).toContain('Stop the foreign process yourself');
    expect(ownerNoticeGuidance('port-squat')).toContain('clears on a successful bind');
    expect(ownerNoticeGuidance('roll-port-squat')).toContain('Stop the foreign process yourself');
  });

  it('degraded decisions name the real remediation, not an ack', () => {
    const line = ownerNoticeGuidance('decisions.degraded.timeout');
    expect(line).toContain('Fix the decision-provider credential');
    expect(line).toContain('clears when the decision service recovers');
    expect(ownerNoticeGuidance('decisions.enforce-gate.triage')).toBe(line);
  });

  it('sweep confirmations and blocked wakes name the manual step', () => {
    expect(ownerNoticeGuidance('worktree-sweep-paused')).toContain('Confirm nothing live is rooted');
    expect(ownerNoticeGuidance('worktree-sweep-paused:lane-a:pause-1')).toContain('the notice clears when that worktree is swept');
    expect(ownerNoticeGuidance('gru.wake-blocked.n1')).toContain('Restart the service');
    expect(ownerNoticeGuidance('gru.wake-failed-escalation.job')).toContain('Restart the service');
  });

  it('unknown kinds get the generic honest line (no fabricated semantics, no fake control)', () => {
    expect(ownerNoticeGuidance('something.brand.new')).toContain('No in-app action is supported');
  });
});

describe('safePrUrl', () => {
  it('accepts https and rejects everything else', () => {
    expect(safePrUrl('https://github.com/x/y/pull/1')).toBe('https://github.com/x/y/pull/1');
    expect(safePrUrl('http://github.com/x/y/pull/1')).toBeNull();
    expect(safePrUrl('javascript:alert(1)')).toBeNull();
    expect(safePrUrl('https://')).toBeNull(); // no host — never a real target
    expect(safePrUrl('')).toBeNull();
    expect(safePrUrl('github.com/x/y/pull/1')).toBeNull();
  });
});
