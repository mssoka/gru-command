import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, NotificationDecisionRefusal } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import {
  parseNotificationDecision,
  parseStoredNotificationDecision,
  serializeNotificationDecision,
  type NotificationDecision,
} from '../src/ledger/notification-decision.js';
import { ownerAttentionFor, requiresTypedDecision, resolveNotificationRouting } from '../src/notifications/attention.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { reconcileLegacyOwnerAttention } from '../src/notifications/legacy-owner.js';

/**
 * Owner release 2026-10-11: the responsibility chain
 * (Silas → Gru → owner), the typed owner-decision record, and the
 * backwards-compatible legacy re-triage. These tests pin the routing
 * matrix, the decision side-effect boundary and the honest handling of
 * legacy/unknown rows.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-owner-decisions-'));
  cleanupDirs.push(dir);
  return dir;
}

function boot(): { api: LedgerApi; bus: EventBus; center: NotificationCenter; needsOwner: string[]; actionRequired: string[] } {
  const db = new LedgerDb(tmpDir());
  const bus = new EventBus();
  const api = new LedgerApi(db.handle, { bus });
  const needsOwner: string[] = [];
  const actionRequired: string[] = [];
  const center = new NotificationCenter({
    ledger: api,
    bus,
    onNeedsOwner: (row) => needsOwner.push(row.id),
    onActionRequired: (row) => actionRequired.push(row.id),
  });
  return { api, bus, center, needsOwner, actionRequired };
}

function decision(overrides: Partial<NotificationDecision> = {}): NotificationDecision {
  return {
    question: 'Approve the slim contract?',
    context: 'PR256 needs an owner-controlled integration route before anything moves.',
    recommendation: 'Approve the slim contract.',
    reservedClass: 'scope-design',
    whyNotDelegable: 'It changes the agreed product scope, which is the owner’s call.',
    options: [
      { id: 'approve', label: 'Approve the slim contract', consequence: 'Gru commissions the slim lane and reports back.' },
      { id: 'keep', label: 'Keep the current approach', consequence: 'The lane stays parked; nothing is re-armed.' },
    ],
    discussion: false,
    ...overrides,
  };
}

describe('owner attention registry (Silas → Gru → owner)', () => {
  it('classifies registered owner kinds, allowed kinds and machine/unknown kinds', () => {
    for (const kind of [
      'lessons.proposal',
      'lessons.proposal-conflict',
      'gru.owner-escalation',
      'port-squat',
      'roll-port-squat',
      'worktree-sweep-paused',
      'gru.wake-blocked.n1',
      'gru.wake-failed-escalation.job1',
    ]) {
      expect(ownerAttentionFor(kind), kind).toBe('owner-required');
    }
    expect(ownerAttentionFor('decisions.degraded.credential_missing')).toBe('owner-allowed');
    expect(ownerAttentionFor('decisions.enforce-gate.triage')).toBe('owner-required');
    for (const kind of [
      'supervision.breaker',
      'supervision.provider-wall.agent1.authentication_wall',
      'supervision.turn-orphaned.agent1',
      'silas.directive-unreconciled.req1',
      'provider.false-recovery.route',
      'job.status',
      'test.unregistered',
    ]) {
      expect(ownerAttentionFor(kind), kind).toBe('owner-forbidden');
    }
    expect(requiresTypedDecision('gru.owner-escalation')).toBe(true);
    expect(requiresTypedDecision('port-squat')).toBe(false);
  });

  it('resolves routing: owner-required forces owner, machine requests downgrade to Gru, ordinary requests pass through', () => {
    expect(resolveNotificationRouting('port-squat', 'action-required')).toEqual({ routing: 'needs-owner', overridden: true });
    expect(resolveNotificationRouting('lessons.proposal', 'fyi')).toEqual({ routing: 'needs-owner', overridden: true });
    expect(resolveNotificationRouting('decisions.degraded.timeout', 'needs-owner')).toEqual({ routing: 'needs-owner', overridden: false });
    expect(resolveNotificationRouting('decisions.degraded.timeout', 'fyi')).toEqual({ routing: 'fyi', overridden: false });
    expect(resolveNotificationRouting('supervision.breaker', 'needs-owner')).toEqual({ routing: 'action-required', overridden: true });
    expect(resolveNotificationRouting('test.unregistered', 'needs-owner')).toEqual({ routing: 'action-required', overridden: true });
    expect(resolveNotificationRouting('test.unregistered', 'action-required')).toEqual({ routing: 'action-required', overridden: false });
    expect(resolveNotificationRouting('test.unregistered', 'fyi')).toEqual({ routing: 'fyi', overridden: false });
  });

  it('refuses a bare owner escalation: typed reserved-decision metadata is required', () => {
    const rig = boot();
    expect(() =>
      rig.center.post({ kind: 'gru.owner-escalation', routing: 'needs-owner', severity: 'error', title: 'Coordination note', detail: 'ops work' }),
    ).toThrow(/typed decision metadata/);
    expect(rig.needsOwner).toEqual([]);
  });

  it('records the typed decision on a Gru escalation and rings the owner exactly once', () => {
    const rig = boot();
    const row = rig.center.post({
      kind: 'gru.owner-escalation',
      routing: 'needs-owner',
      severity: 'error',
      title: 'Approve the slim contract?',
      detail: 'Evidence: manifest.json, sha a40…',
      decision: decision(),
    });
    expect(row.routing).toBe('needs-owner');
    expect(row.decision).toMatchObject({ reservedClass: 'scope-design', options: expect.any(Array) });
    expect(rig.needsOwner).toEqual([row.id]);
    expect(rig.actionRequired).toEqual([]);
  });
});

describe('typed decision validation', () => {
  it('rejects malformed shapes with actionable messages', () => {
    expect(() => parseNotificationDecision(undefined)).toThrow(/decision must be an object/);
    expect(() => parseNotificationDecision({ ...decision(), question: '' })).toThrow(/question must not be blank/);
    expect(() => parseNotificationDecision({ ...decision(), reservedClass: 'anything' })).toThrow(/reservedClass must be one of/);
    expect(() => parseNotificationDecision({ ...decision(), whyNotDelegable: undefined })).toThrow(/whyNotDelegable/);
    expect(() => parseNotificationDecision({ ...decision(), options: [] })).toThrow(/at least one option/);
    expect(() =>
      parseNotificationDecision({
        ...decision(),
        options: [
          { id: 'same', label: 'A', consequence: 'a' },
          { id: 'same', label: 'B', consequence: 'b' },
        ],
      }),
    ).toThrow(/duplicated/);
    expect(() => parseNotificationDecision({ ...decision(), options: [{ id: 'Bad ID', label: 'A', consequence: 'a' }] })).toThrow(/lowercase slug/);
    expect(() => parseNotificationDecision({ ...decision(), options: new Array(5).fill(0).map((_, i) => ({ id: `o${i}`, label: 'A', consequence: 'a' })) })).toThrow(/at most 4/);
    expect(() => parseNotificationDecision({ ...decision(), question: 'x'.repeat(301) })).toThrow(/at most 300/);
  });

  it('allows a discussion-only decision (no safe one-click option)', () => {
    const parsed = parseNotificationDecision({ ...decision(), options: [], discussion: true });
    expect(parsed.discussion).toBe(true);
    expect(parsed.options).toEqual([]);
  });

  it('round-trips through storage and reads corrupt columns as no decision', () => {
    const parsed = parseNotificationDecision(decision());
    expect(parseStoredNotificationDecision(serializeNotificationDecision(parsed))).toEqual(parsed);
    expect(parseStoredNotificationDecision(null)).toBeNull();
    expect(parseStoredNotificationDecision('')).toBeNull();
    expect(parseStoredNotificationDecision('{not json')).toBeNull();
    expect(parseStoredNotificationDecision('{"question":"x"}')).toBeNull();
  });
});

describe('recordNotificationDecision — the side-effect boundary', () => {
  function seedDecision(rig: ReturnType<typeof boot>): string {
    return rig.center.post({
      kind: 'gru.owner-escalation',
      routing: 'needs-owner',
      severity: 'error',
      title: 'Approve the slim contract?',
      detail: 'evidence',
      decision: decision(),
    }).id;
  }

  it('records the option durably, emits one audit event, and never acks or resolves the row', () => {
    const rig = boot();
    const id = seedDecision(rig);
    const recorded = rig.center.decide(id, 'approve', 'web');
    expect(recorded).toMatchObject({ decidedOption: 'approve', decidedBy: 'web', ackedAt: null, resolvedAt: null });
    expect(recorded?.decidedAt).not.toBeNull();
    const events = rig.api
      .listEvents({ limit: 100 })
      .filter((event) => event.kind === 'notification.decision' && (event.payload as { id?: string }).id === id);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ optionId: 'approve', by: 'web' });
  });

  it('is idempotent for the same option and refuses a different one (a decision is never silently replaced)', () => {
    const rig = boot();
    const id = seedDecision(rig);
    rig.center.decide(id, 'approve', 'web');
    const replay = rig.center.decide(id, 'approve', 'web');
    expect(replay?.decidedOption).toBe('approve');
    const decisionEvents = rig.api
      .listEvents({ limit: 100 })
      .filter((event) => event.kind === 'notification.decision' && (event.payload as { id?: string }).id === id);
    expect(decisionEvents).toHaveLength(1);
    expect(() => rig.center.decide(id, 'keep', 'web')).toThrow(NotificationDecisionRefusal);
    try {
      rig.center.decide(id, 'keep', 'web');
      expect.unreachable();
    } catch (error) {
      expect((error as NotificationDecisionRefusal).code).toBe('decision_recorded');
    }
    expect(rig.api.getNotification(id)?.decidedOption).toBe('approve');
  });

  it('refuses unknown options, machine rows, no-decision rows and resolved rows with typed codes', () => {
    const rig = boot();
    const id = seedDecision(rig);
    const codeOf = (fn: () => unknown): string => {
      try {
        fn();
      } catch (error) {
        if (error instanceof NotificationDecisionRefusal) return error.code;
        throw error;
      }
      return 'no-error';
    };
    expect(codeOf(() => rig.center.decide(id, 'nope', 'web'))).toBe('unknown_option');
    const machine = rig.center.post({ kind: 'supervision.breaker', routing: 'needs-owner', severity: 'error', title: 'Breaker' });
    expect(machine.routing).toBe('action-required');
    expect(codeOf(() => rig.center.decide(machine.id, 'approve', 'web'))).toBe('not_owner_decision');
    const notice = rig.center.post({ kind: 'port-squat', routing: 'needs-owner', severity: 'error', title: 'Squat' });
    expect(codeOf(() => rig.center.decide(notice.id, 'approve', 'web'))).toBe('no_decision');
    rig.api.resolveNotificationById(id, 'producer');
    expect(codeOf(() => rig.center.decide(id, 'approve', 'web'))).toBe('not_open');
    expect(rig.center.decide('missing', 'approve', 'web')).toBeNull();
  });
});

describe('legacy owner-attention reconciliation', () => {
  it('re-triages legacy coordination notes and unknown kinds to Gru without dropping the stop', () => {
    const rig = boot();
    const legacyEscalation = rig.api.recordNotification({
      id: 'legacy-escalation',
      kind: 'gru.owner-escalation',
      routing: 'needs-owner',
      severity: 'error',
      title: 'PR256 resumption requested',
      detail: 'Operational coordination: this is not a decision.',
    });
    const unknownKind = rig.api.recordNotification({
      id: 'legacy-unknown',
      kind: 'legacy.unregistered.stop',
      routing: 'needs-owner',
      severity: 'error',
      title: 'Unknown stop',
      detail: 'details',
    });
    const report = reconcileLegacyOwnerAttention({ ledger: rig.api });
    expect(report.examined).toBe(2);
    expect(report.retriaged).toBe(2);
    expect(report.kept).toBe(0);
    const moved = rig.api.getNotification(legacyEscalation.id);
    expect(moved).toMatchObject({ routing: 'action-required', ackedAt: null, resolvedAt: null });
    expect(moved?.detail).toContain('Operational coordination: this is not a decision.');
    expect(moved?.detail).toContain('[owner-attention migration 2026-10-11]');
    expect(rig.api.getNotification(unknownKind.id)).toMatchObject({ routing: 'action-required', ackedAt: null });
    // The move is auditable and idempotent: a second pass finds nothing.
    expect(rig.api.listEvents({ limit: 100 }).filter((event) => event.kind === 'notification.triaged')).toHaveLength(2);
    expect(reconcileLegacyOwnerAttention({ ledger: rig.api }).retriaged).toBe(0);
  });

  it('keeps registered owner kinds: notices, allowed degradations, proposals and typed escalations', () => {
    const rig = boot();
    const portSquat = rig.api.recordNotification({ id: 'keep-squat', kind: 'port-squat', routing: 'needs-owner', severity: 'error', title: 'Squat' });
    const degraded = rig.api.recordNotification({
      id: 'keep-degraded', kind: 'decisions.degraded.credential_missing', routing: 'needs-owner', severity: 'error', title: 'Degraded',
    });
    const proposal = rig.api.recordNotification({ id: 'keep-proposal', kind: 'lessons.proposal', routing: 'needs-owner', severity: 'info', title: 'Proposal' });
    const typed = rig.center.post({
      kind: 'gru.owner-escalation',
      routing: 'needs-owner',
      severity: 'error',
      title: 'Typed',
      detail: 'evidence',
      decision: decision(),
    });
    const report = reconcileLegacyOwnerAttention({ ledger: rig.api });
    expect(report.retriaged).toBe(0);
    expect(report.kept).toBe(4);
    for (const id of [portSquat.id, degraded.id, proposal.id, typed.id]) {
      expect(rig.api.getNotification(id)?.routing).toBe('needs-owner');
    }
  });

  it('never touches acked or resolved rows (history stays exact)', () => {
    const rig = boot();
    rig.api.recordNotification({
      id: 'already-acked',
      kind: 'gru.owner-escalation',
      routing: 'needs-owner',
      severity: 'error',
      title: 'Old stop',
      detail: 'old',
    });
    rig.center.ack('already-acked', 'operator');
    const report = reconcileLegacyOwnerAttention({ ledger: rig.api });
    expect(report.examined).toBe(0);
    expect(rig.api.getNotification('already-acked')).toMatchObject({ routing: 'needs-owner', ackedBy: 'operator', resolvedAt: null });
  });
});
