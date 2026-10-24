import { describe, expect, it } from 'vitest';
import {
  incidentBasisOf,
  incidentKeyOf,
  incidentSignalOf,
  incidentSubjectOf,
  isHardFloorRow,
  legacyIncidentSignalOf,
  normalizeIncidentTitle,
} from '../src/chat/incident.js';
import { validateDecisionSignal, validateDecisionSubject } from '../src/ledger/decision-memory.js';
import { defaultBranchCiFailedKind } from '../src/repos/default-branch-ci.js';

/**
 * Incident identity (issue #219): the wake dedupes and consults hold
 * coverage on (alert kind, subject, head SHA where applicable) — derived
 * from the durable notification row alone. These pins are the contract
 * the decision writers (roles/gru.md, roles/silas.md) and the wake path
 * must agree on; a drift here silently re-opens held subjects.
 */

describe('incident identity (issue #219)', () => {
  it('keys scoped producer kinds on the kind itself — the head SHA included', () => {
    expect(incidentKeyOf({ kind: 'github.ci-failed:j-1:abc123', title: 'CI failed on main', routing: 'action-required' })).toBe(
      'github.ci-failed:j-1:abc123',
    );
    // A re-detection under a NEW row id with the SAME kind is the SAME incident.
    expect(incidentKeyOf({ kind: 'github.ci-failed:j-1:abc123', title: 'CI failed on main (retry)', routing: 'action-required' })).toBe(
      'github.ci-failed:j-1:abc123',
    );
    // A NEW head is a NEW incident by construction.
    expect(incidentKeyOf({ kind: 'github.ci-failed:j-1:def456', title: 'CI failed on main', routing: 'action-required' })).toBe(
      'github.ci-failed:j-1:def456',
    );
  });

  it('keys unscoped kinds on kind + normalized title', () => {
    expect(incidentKeyOf({ kind: 'supervision.breaker', title: 'Crash-loop breaker tripped', routing: 'needs-owner' })).toBe(
      'supervision.breaker:crash-loop-breaker-tripped',
    );
    expect(normalizeIncidentTitle('  Crash-Loop   Breaker TRIPPED! ')).toBe('crash-loop-breaker-tripped');
    expect(normalizeIncidentTitle('???')).toBe('untitled');
    expect(normalizeIncidentTitle('x'.repeat(200))).toHaveLength(80);
  });

  it('maps job-scoped kinds to the job subject; others to the incident subject', () => {
    expect(incidentSubjectOf({ kind: 'github.ci-failed:j-1:abc123', title: 'CI failed', routing: 'action-required' })).toBe('job:j-1');
    expect(incidentSubjectOf({ kind: 'github.pr-conflict:j-7', title: 'PR #3 conflicts', routing: 'fyi' })).toBe('job:j-7');
    expect(incidentSubjectOf({ kind: 'supervision.provider-wall.a1.quota_wall', title: 'Agent a1 stopped: quota wall', routing: 'action-required' })).toBe(
      'incident:supervision.provider-wall.a1.quota_wall:agent-a1-stopped-quota-wall',
    );
  });

  it('derives the signal family: namespace and scope stripped', () => {
    expect(incidentSignalOf({ kind: 'github.ci-failed:j-1:abc123', title: 'CI failed', routing: 'action-required' })).toBe('ci-failed');
    expect(incidentSignalOf({ kind: 'github.pr-conflict:j-7', title: 'PR conflicts', routing: 'fyi' })).toBe('pr-conflict');
    // Issue #503: the dot-scoped lane id is instance identity, not family.
    expect(incidentSignalOf({ kind: 'supervision.turn-orphaned.a2', title: 'Interrupted turn', routing: 'action-required' })).toBe(
      'supervision.turn-orphaned',
    );
  });

  it('derives the basis: the embedded head SHA, else the stable incident key', () => {
    expect(incidentBasisOf({ kind: 'github.ci-failed:j-1:abc123', title: 'CI failed', routing: 'action-required' })).toBe('abc123');
    // Multi-segment shas survive (a colon inside the sha is not a producer convention).
    expect(incidentBasisOf({ kind: 'github.ci-failed:j-1:abc:def', title: 'CI failed', routing: 'action-required' })).toBe('abc:def');
    expect(incidentBasisOf({ kind: 'supervision.turn-orphaned.a2', title: 'Interrupted turn', routing: 'action-required' })).toBe(
      'supervision.turn-orphaned.a2:interrupted-turn',
    );
  });

  it('hard floors: needs-owner routing, breakers, provider walls, false-recovery', () => {
    expect(isHardFloorRow({ kind: 'supervision.breaker', title: 'x', routing: 'needs-owner' })).toBe(true);
    expect(isHardFloorRow({ kind: 'anything.else', title: 'x', routing: 'needs-owner' })).toBe(true);
    expect(isHardFloorRow({ kind: 'supervision.provider-wall.a1.quota_wall', title: 'x', routing: 'action-required' })).toBe(true);
    expect(isHardFloorRow({ kind: 'provider.false-recovery.route-x', title: 'x', routing: 'action-required' })).toBe(true);
    expect(isHardFloorRow({ kind: 'supervision.breaker', title: 'x', routing: 'action-required' })).toBe(true);
    // A fenced re-arm is the same recovery-control family: its successor
    // alert must wake Gru even when the incident key was claimed before.
    expect(isHardFloorRow({ kind: 'supervision.rearm-fenced', title: 'Re-arm fenced', routing: 'action-required' })).toBe(true);
    // Ordinary machine work stays deferrable.
    expect(isHardFloorRow({ kind: 'github.ci-failed:j-1:abc', title: 'x', routing: 'action-required' })).toBe(false);
    expect(isHardFloorRow({ kind: 'supervision.turn-orphaned.a2', title: 'x', routing: 'action-required' })).toBe(false);
  });
});

describe('incident identity — review additions (issue #219)', () => {
  it('maps the dot-scoped rebrief producer onto its job subject and family signal', () => {
    const row = { kind: 'silas.rebrief-unreconciled.j-42', title: 'Re-brief unreconciled', routing: 'action-required' as const };
    expect(incidentSubjectOf(row)).toBe('job:j-42');
    expect(incidentSignalOf(row)).toBe('rebrief-unreconciled');
    // Key + basis remain the stable incident identity (no sha in the kind;
    // the unscoped title normalization applies).
    expect(incidentKeyOf(row)).toBe('silas.rebrief-unreconciled.j-42:re-brief-unreconciled');
    expect(incidentBasisOf(row)).toBe('silas.rebrief-unreconciled.j-42:re-brief-unreconciled');
  });

  it('does not mistake other dot-scoped kinds for job subjects', () => {
    const row = { kind: 'supervision.provider-wall.a1.quota_wall', title: 'Agent a1 stopped: quota wall', routing: 'action-required' as const };
    expect(incidentSubjectOf(row)).toBe(
      'incident:supervision.provider-wall.a1.quota_wall:agent-a1-stopped-quota-wall',
    );
  });
});

it('concrete directive and historical rebrief recovery debt cannot be covered by a generic Ops hold', () => {
  expect(isHardFloorRow({ kind: 'silas.directive-unreconciled.request-286', title: 'recovery owed', routing: 'action-required' })).toBe(true);
  expect(isHardFloorRow({ kind: 'silas.rebrief-unreconciled.job-286', title: 'recovery owed', routing: 'action-required' })).toBe(true);
});

describe('incident identity — red default branch (#446)', () => {
  const sha = '3684087c00000000000000000000000000000002';
  const row = (kind: string) => ({ kind, title: 'Default branch develop is red: CI (acme/alpha)', routing: 'action-required' as const });

  it('the producer kind maps to the repository subject, the ci-failed family and its head sha', () => {
    const kind = defaultBranchCiFailedKind({ host: 'github.com', owner: 'acme', repo: 'alpha' }, 7, sha);
    expect(kind).toBe(`github.default-branch-ci-failed:acme/alpha:7:${sha}`);
    // Never a job subject: no lane owns a default branch.
    expect(incidentSubjectOf(row(kind))).toBe('incident:github.default-branch-ci-failed:acme/alpha');
    expect(incidentSignalOf(row(kind))).toBe('ci-failed');
    // The basis is the sha alone, never `<workflowId>:<sha>`.
    expect(incidentBasisOf(row(kind))).toBe(sha);
    // The wake dedupe key stays the full kind: one incident per workflow + head.
    expect(incidentKeyOf(row(kind))).toBe(kind);
    expect(isHardFloorRow(row(kind))).toBe(false);
  });

  it('every workflow of one repository shares the subject; another repository does not', () => {
    const subject = (repo: string, workflowId: number) =>
      incidentSubjectOf(row(defaultBranchCiFailedKind({ host: 'github.com', owner: 'acme', repo }, workflowId, sha)));
    expect(subject('alpha', 7)).toBe(subject('alpha', 71));
    expect(subject('alpha-two', 7)).toBe('incident:github.default-branch-ci-failed:acme/alpha-two');
  });

  it('a decision recorded on the mapped subject passes the write-boundary validator', () => {
    const kind = defaultBranchCiFailedKind({ host: 'github.com', owner: 'Acme-Org', repo: 'right.tenantry' }, 123456789, sha);
    expect(validateDecisionSubject(incidentSubjectOf(row(kind)))).toBe('incident:github.default-branch-ci-failed:Acme-Org/right.tenantry');
    expect(validateDecisionSignal(incidentSignalOf(row(kind)))).toBe('ci-failed');
  });
});

describe('incident identity — signal families (issue #503)', () => {
  const row = (kind: string, title = 'Recovery owed') => ({ kind, title, routing: 'action-required' as const });
  // Caller-chosen ids: long, mixed case and punctuated. The pre-#503 signal
  // embedded them whole and overran the decision write boundary.
  const request = `Fix-Reviews-${'r'.repeat(60)}.v2`;
  const agent = `minion_${'8889b879'.repeat(5)}`;

  function expectFamily(kind: string, family: string): void {
    const incident = row(kind);
    expect(incidentSignalOf(incident), kind).toBe(family);
    expect(validateDecisionSignal(incidentSignalOf(incident)), kind).toBe(family);
    // The instance stays exact in the subject and basis the queries pin.
    expect(incidentSubjectOf(incident), kind).toBe(`incident:${kind}:recovery-owed`);
    expect(incidentBasisOf(incident), kind).toBe(`${kind}:recovery-owed`);
  }

  it('silas recovery kinds drop the request, phase and transfer ids', () => {
    expectFamily(`silas.directive-unreconciled.${request}`, 'directive-unreconciled');
    expectFamily(`silas.phase-handback.${request}@4831`, 'phase-handback');
    expectFamily(`silas.phase-handback.${request}`, 'phase-handback');
    expectFamily(`silas.recovery-owner-transfer.directive.${request}.3`, 'recovery-owner-transfer');
  });

  it('supervision, provider, wake and decisions kinds keep their namespace and drop the instance', () => {
    expectFamily(`supervision.provider-wall.${agent}.authentication_wall`, 'supervision.provider-wall');
    expectFamily(`supervision.turn-orphaned.${agent}`, 'supervision.turn-orphaned');
    expectFamily('provider.false-recovery.anthropic/claude-opus', 'provider.false-recovery');
    expectFamily(`provider-recovery.recovery-off.${request}`, 'provider-recovery.recovery-off');
    expectFamily('provider.waiting.anthropic/claude-opus', 'provider.waiting');
    expectFamily(`gru.wake-failed-escalation.${request}`, 'gru.wake-failed-escalation');
    expectFamily('decisions.degraded.provider-unreachable', 'decisions.degraded');
    expectFamily('decisions.enforce-gate.escalation-triage', 'decisions.enforce-gate');
  });

  it('short stable kinds keep the signal they always had', () => {
    expect(incidentSignalOf(row('github.ci-failed:j-1:abc123'))).toBe('ci-failed');
    expect(incidentSignalOf(row('github.pr-conflict:j-7'))).toBe('pr-conflict');
    expect(incidentSignalOf(row('github.default-branch-ci-failed:acme/alpha:7:abc'))).toBe('ci-failed');
    expect(incidentSignalOf(row('silas.rebrief-unreconciled.j-42'))).toBe('rebrief-unreconciled');
    expect(incidentSignalOf(row('silas.escalation'))).toBe('escalation');
    expect(incidentSignalOf(row('silas.escalated:j-1'))).toBe('escalated');
    expect(incidentSignalOf(row('supervision.breaker'))).toBe('supervision.breaker');
    expect(incidentSignalOf(row('supervision.rearm-fenced'))).toBe('supervision.rearm-fenced');
    expect(incidentSignalOf(row('lessons.dream-failed'))).toBe('lessons.dream-failed');
    expect(incidentSignalOf(row('worktree.sweep-answer-waiting'))).toBe('worktree.sweep-answer-waiting');
    expect(incidentSignalOf(row('review-escalation'))).toBe('review-escalation');
    expect(incidentSignalOf(row('job-stop-unproven:j-1'))).toBe('job-stop-unproven');
    // #314: a report's signal is its exact, case-preserved job identity.
    const job = `Review-${'A'.repeat(121)}`;
    expect(incidentSignalOf(row(`silas.report-handback.${job}`))).toBe(`report-handback.${job}`);
    expect(validateDecisionSignal(incidentSignalOf(row(`silas.report-handback.${job}`)))).toBe(`report-handback.${job}`);
  });

  it('names the storable pre-family token only where the family replaced it', () => {
    // A stored decision could name these: each was a valid decision signal.
    expect(legacyIncidentSignalOf(row('supervision.turn-orphaned.a2'))).toBe('supervision.turn-orphaned.a2');
    expect(legacyIncidentSignalOf(row('silas.directive-unreconciled.0b1c2d3e-0000-4000-8000-000000000000')))
      .toBe('directive-unreconciled.0b1c2d3e-0000-4000-8000-000000000000');
    expect(legacyIncidentSignalOf(row('provider.waiting.route-x'))).toBe('provider.waiting.route-x');
    // The write boundary never accepted these, and reads re-validate every
    // stored token, so no decision row can hold them.
    expect(legacyIncidentSignalOf(row(`silas.directive-unreconciled.${request}`))).toBeNull();
    expect(legacyIncidentSignalOf(row('silas.phase-handback.j-1@17'))).toBeNull();
    expect(legacyIncidentSignalOf(row(`supervision.provider-wall.${agent}.authentication_wall`))).toBeNull();
    // Unchanged signals have no alias, and re-briefs were a family already.
    expect(legacyIncidentSignalOf(row('github.ci-failed:j-1:abc123'))).toBeNull();
    expect(legacyIncidentSignalOf(row('github.default-branch-ci-failed:acme/alpha:7:abc'))).toBeNull();
    expect(legacyIncidentSignalOf(row('silas.rebrief-unreconciled.j-42'))).toBeNull();
    expect(legacyIncidentSignalOf(row('silas.report-handback.review-old'))).toBeNull();
    expect(legacyIncidentSignalOf(row('supervision.breaker'))).toBeNull();
  });

  it('a family never widens hard floors or merges two instances', () => {
    for (const kind of [`silas.directive-unreconciled.${request}`, `supervision.provider-wall.${agent}.quota_wall`, 'provider.false-recovery.route-x']) {
      expect(isHardFloorRow(row(kind)), kind).toBe(true);
    }
    const first = row('supervision.turn-orphaned.lane-a', 'Interrupted turn on lane-a');
    const second = row('supervision.turn-orphaned.lane-b', 'Interrupted turn on lane-b');
    expect(incidentSignalOf(first)).toBe(incidentSignalOf(second));
    expect(incidentSubjectOf(first)).not.toBe(incidentSubjectOf(second));
    expect(incidentBasisOf(first)).not.toBe(incidentBasisOf(second));
  });
});
