import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, NotificationView, OwnerPrView } from './board-protocol.js';
import {
  OWNER_WINDOW_SIZE,
  ackConsequence,
  ackNextStep,
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
    expect(rows.map((row) => row.actionId)).toEqual(['owner-ack:owner', 'owner-ack:seen-ack']);
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
      'owner-ack:older', // 00:00 ack
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
    expect(rows.map((row) => row.actionId)).toEqual(['owner-ack:z-row', 'owner-pr:a-job']);
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

  it('absent ownerPrs (pre-upgrade server) degrades to ack rows only — no invented ready rows', () => {
    const rows = ownerRows(snapshot({ notifications: [notification('owner', { routing: 'needs-owner' })] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('ack');
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

describe('ack consequence copy — honest scope per kind, never parsed prose', () => {
  it('quota walls and breakers: ack re-arms the worker and does NOT clear holds', () => {
    const line = ackConsequence('supervision.provider-wall.agent-1.quota_exceeded');
    expect(line).toContain('re-arms this worker');
    expect(line).toContain('does NOT clear code/test/review holds');
    expect(ackConsequence('supervision.breaker')).toBe(line);
  });

  it('degraded decisions: the ack is a sighting record, not a fix', () => {
    expect(ackConsequence('decisions.degraded.timeout')).toContain('stays degraded');
  });

  it('sweep confirmations and port squats name the manual step', () => {
    expect(ackConsequence('worktree-sweep-paused')).toContain('removal');
    expect(ackConsequence('port-squat')).toContain('Stop the foreign process');
    expect(ackConsequence('roll-port-squat')).toContain('Stop the foreign process');
  });

  it('unknown kinds get the generic honest line (no fabricated semantics)', () => {
    expect(ackConsequence('gru.owner-escalation')).toContain('does not by itself prove');
    expect(ackConsequence('something.brand.new')).toContain('does not by itself prove');
  });

  it('the collapsed Next step and the expanded consequence agree on every kind family (one family map, never drifted)', () => {
    // The face shows ackNextStep; the expanded region shows
    // ackConsequence. They must classify kinds into the SAME families: a
    // family added to one and not the other would silently pass every
    // other test while the two surfaces tell different stories.
    const unknown = 'something.brand.new';
    const genericNext = ackNextStep(unknown);
    const genericConsequence = ackConsequence(unknown);
    const kinds = [
      'supervision.provider-wall.agent-1.quota_exceeded',
      'supervision.breaker',
      'decisions.degraded.timeout',
      'worktree-sweep-paused',
      'port-squat',
      'roll-port-squat',
      unknown,
    ];
    for (const kind of kinds) {
      const nextIsGeneric = ackNextStep(kind) === genericNext;
      const consequenceIsGeneric = ackConsequence(kind) === genericConsequence;
      expect(nextIsGeneric, `family drift for ${kind}`).toBe(consequenceIsGeneric);
    }
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

describe('ackNextStep (short typed face phrases)', () => {
  it('stays static per kind family, short, and never echoes prose', () => {
    expect(ackNextStep('supervision.provider-wall.a1.quota_exceeded')).toBe('Ack re-arms this worker.');
    expect(ackNextStep('supervision.breaker')).toBe('Ack re-arms this worker.');
    expect(ackNextStep('decisions.degraded.model')).toBe('Ack records that you saw this.');
    expect(ackNextStep('worktree-sweep-paused')).toBe('Check the worktree, then ack.');
    expect(ackNextStep('port-squat')).toBe('Stop the foreign process, then ack.');
    expect(ackNextStep('roll-port-squat')).toBe('Stop the foreign process, then ack.');
    // An ordinary unsupported free-form notice gets the neutral truthful step.
    expect(ackNextStep('some.free-form.notice')).toBe('Ack clears this notice.');
  });
});
