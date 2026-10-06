import { describe, expect, it } from 'vitest';
import {
  incidentBasisOf,
  incidentKeyOf,
  incidentSignalOf,
  incidentSubjectOf,
  isHardFloorRow,
  normalizeIncidentTitle,
} from '../src/chat/incident.js';

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
    expect(incidentSignalOf({ kind: 'supervision.turn-orphaned.a2', title: 'Interrupted turn', routing: 'action-required' })).toBe(
      'supervision.turn-orphaned.a2',
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
