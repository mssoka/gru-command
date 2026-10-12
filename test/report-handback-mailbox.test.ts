import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GruAwareness } from '../src/chat/awareness.js';
import { reconcileReportClosures } from '../src/dispatch/durable-reconcile.js';
import { EventBus } from '../src/events/bus.js';
import { GruMailbox } from '../src/gru-mailbox/service.js';
import { mailboxBasis } from '../src/gru-mailbox/projection.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';

const START = Date.parse('2026-10-12T10:20:00.000Z');
const RECHECK = '2026-10-12T10:41:41.000Z';
const JOB = 'review-handback';
const KIND = `silas.report-handback.${JOB}`;
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
  vi.useRealTimers();
});

function fixture(wakeMinSeverity: 'info' | 'error' = 'info') {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const dir = mkdtempSync(join(tmpdir(), 'gru-report-handback-mailbox-'));
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const mailbox = new GruMailbox(ledger);
  const awareness = new GruAwareness({ dir, ledger, bus, mailbox, wakeMinIntervalMs: 0, mailboxReconcileIntervalMs: 1000, wakeMinSeverity });
  closes.push(() => { awareness.dispose(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  ledger.addJob({ id: JOB, repo: 'demo', title: 'review report', deliverable: 'review', commissioner: 'writer',
    targetRef: 'https://github.com/example/demo/pull/1', targetSha: 'a'.repeat(40) });
  ledger.setJobStatus(JOB, 'working');
  ledger.setJobStatus(JOB, 'delivered');
  const delivery = ledger.appendCustomEvent({ kind: 'job.delivered', jobId: JOB, payload: { report: 'original findings' } });
  const debt = ledger.openReportObligation({ jobId: JOB, observedAtSeq: delivery.seq }).obligation;
  const reconcile = () => reconcileReportClosures({ ledger, notifications });
  expect(reconcile().published).toBe(1);
  const original = mailbox.snapshot().items.find((item) => item.kind === 'incident')!;
  const wait = (item = original, recheckAt = RECHECK) => {
    const hold = ledger.recordDecision({ subject: item.subject, decision: 'hold', covers: item.reasons.map((reason) => reason.signal),
      basisFingerprint: item.basis, reason: 'commissioner completing scheduled verification before collecting report', by: 'gru', recheckAt });
    return mailbox.disposition(item.id, { basis: item.basis, state: 'waiting', owner: 'writer', detail: 'report still owed',
      dependency: 'commissioner verification and report collection', recheckAt, references: [{ kind: 'decision', id: hold.id }] });
  };
  const replace = () => {
    const current = ledger.findNotificationByKind(KIND, 'active')!;
    ledger.resolveNotificationById(current.id, 'gru');
    expect(ledger.findReportObligation(JOB)?.state).toBe('open');
    expect(reconcile().published).toBe(1);
    return ledger.findNotificationByKind(KIND, 'active')!;
  };
  return { db, dir, ledger, mailbox, awareness, original, debt, wait, replace, reconcile };
}

function seedLegacyWait(r: ReturnType<typeof fixture>, recordRuling = true, notificationId = r.original.notificationIds[0]!) {
  const row = r.ledger.getNotification(notificationId)!;
  const key = `notification:${row.id}`;
  const id = `incident:${mailboxBasis(key)}`;
  const reason = { ...r.original.reasons[0]!, basis: mailboxBasis([mailboxBasis([key, mailboxBasis([key, row.kind, row.detail, row.severity])]), null]) };
  const basis = mailboxBasis([[reason.signal, reason.basis]]);
  const hold = r.ledger.recordDecision({ subject: r.original.subject, decision: 'hold', covers: [reason.signal],
    basisFingerprint: basis, reason: 'pre-upgrade commissioner custody', by: 'gru', recheckAt: RECHECK });
  const disposition = { basis, state: 'waiting' as const, owner: 'writer', detail: 'pre-upgrade report custody',
    dependency: 'commissioner verification', recheckAt: RECHECK, references: [{ kind: 'decision' as const, id: hold.id }], recordedAt: new Date().toISOString() };
  const legacy = { ...r.original, id, basis, reasons: [reason], disposition, state: 'waiting', producerOwned: false, attentionKey: `${id}@${basis}` };
  if (recordRuling) r.ledger.appendCustomEvent({ kind: 'mailbox.disposition', payload: { id, disposition } });
  // Simulate the real pre-GH313 persisted projection, not a new-format ruling.
  r.db.handle.prepare('DELETE FROM gru_mailbox WHERE id = ?').run(r.original.id);
  r.db.handle.prepare('INSERT INTO gru_mailbox (id, item, updated_at) VALUES (?, ?, ?)').run(id, JSON.stringify(legacy), new Date().toISOString());
  return legacy;
}

describe('GH-313 report-handback custody', () => {
  it('preserves exact custody and T across repeated reconciler notification replacements', () => {
    const r = fixture();
    const held = r.wait();
    const ids = new Set(held.notificationIds);
    for (let index = 0; index < 3; index += 1) {
      vi.advanceTimersByTime(60_000);
      const replacement = r.replace();
      ids.add(replacement.id);
      const item = r.mailbox.snapshot().items.find((row) => row.notificationIds.includes(replacement.id))!;
      expect(item.id).toBe(held.id);
      expect(item.basis).toBe(held.basis);
      expect(item.state).toBe('waiting');
      expect(item.disposition).toEqual(held.disposition);
      expect(item.notificationIds).toEqual([replacement.id]);
      expect(r.reconcile().published).toBe(0);
      expect(r.ledger.getObligation(r.debt.id)?.settlement).toBeNull();
    }
    expect(ids.size).toBe(4);
    expect(new GruMailbox(r.ledger).snapshot().items.find((row) => row.id === held.id)?.disposition).toEqual(held.disposition);
    expect(r.ledger.listEventsAfter(0, { kinds: ['mailbox.disposition'], limit: 100 })).toHaveLength(1);
  });

  it('retains pending custody and its original recheck during a notification replacement gap', () => {
    const r = fixture();
    const held = r.wait();
    r.ledger.resolveNotificationById(held.notificationIds[0]!, 'gru');
    for (let index = 0; index < 2; index += 1) {
      const retained = r.mailbox.snapshot().items.find((row) => row.id === held.id)!;
      expect(retained.state).toBe('waiting');
      expect(retained.disposition).toEqual(held.disposition);
      expect(retained.notificationIds).toEqual([]);
      expect(r.mailbox.attentionPage(50).some((row) => row.id === held.id)).toBe(false);
    }
    r.reconcile();
    expect(r.mailbox.snapshot().items.find((row) => row.id === held.id)?.state).toBe('waiting');
  });

  it('reopens the same custody at T without settling the report', () => {
    const r = fixture();
    const held = r.wait();
    r.replace();
    vi.advanceTimersByTime(Date.parse(RECHECK) - START - 1);
    expect(r.mailbox.attentionPage(50).some((row) => row.id === held.id)).toBe(false);
    vi.advanceTimersByTime(1);
    const due = r.mailbox.attentionPage(50).find((row) => row.id === held.id)!;
    expect(due.state).toBe('needs-gru');
    expect(due.basis).toBe(held.basis);
    expect(due.disposition?.recheckAt).toBe(RECHECK);
    expect(r.ledger.getObligation(r.debt.id)?.state).toBe('open');
  });

  it('changes the basis and restores attention for new notification evidence', () => {
    const r = fixture();
    const held = r.wait();
    r.ledger.resolveNotificationById(held.notificationIds[0]!, 'gru');
    const changed = r.ledger.recordNotification({ id: 'changed-report', kind: KIND, title: r.original.title,
      detail: 'new findings require a different directive', routing: 'action-required', severity: 'error' });
    const item = r.mailbox.attentionPage(50).find((row) => row.notificationIds.includes(changed.id))!;
    expect(item.id).toBe(held.id);
    expect(item.basis).not.toBe(held.basis);
    expect(item.state).toBe('needs-gru');
  });

  it('reopens changed report source even when the notification bytes did not change', () => {
    const r = fixture();
    const held = r.wait();
    r.ledger.armReceiptExpectation({ obligationId: r.debt.id, receiptKind: 'job.delivered', deadlineAt: RECHECK,
      correlation: { requestId: 'new-report-request' }, reason: 'a new report receipt is now required' });
    const item = r.mailbox.snapshot().items.find((row) => row.notificationIds.includes(held.notificationIds[0]!))!;
    expect(item.id).toBe(held.id);
    expect(item.basis).not.toBe(held.basis);
    expect(item.state).toBe('needs-gru');
  });

  it('closes custody only when the report is actually settled, including across a replacement gap', () => {
    const r = fixture();
    const held = r.wait();
    r.replace();
    r.ledger.settleReportDisposition({ jobId: JOB, outcome: 'dismissed', note: 'commissioner inspected the findings', by: 'writer' });
    expect(r.ledger.getJob(JOB)?.status).toBe('done');
    expect(r.ledger.getObligation(r.debt.id)?.state).toBe('closed');
    expect(r.mailbox.snapshot().items.find((row) => row.id === held.id)?.state).toBe('resolved');
    expect(r.mailbox.attentionPage(50)).toEqual([]);
    expect(r.reconcile().published).toBe(0);
  });

  it('does not manufacture a wait when a replacement has no recorded custody', () => {
    const r = fixture();
    const replacement = r.replace();
    const item = r.mailbox.attentionPage(50).find((row) => row.notificationIds.includes(replacement.id))!;
    expect(item.state).toBe('needs-gru');
    expect(item.disposition).toBeNull();
  });

  it('invalidated wait references restore debt rather than reusing unsupported custody', () => {
    const r = fixture();
    const held = r.wait();
    r.ledger.clearDecision({ id: held.disposition!.references[0]!.id, by: 'gru', reason: 'dependency is no longer justified' });
    const replacement = r.replace();
    expect(r.mailbox.attentionPage(50).find((row) => row.notificationIds.includes(replacement.id))?.state).toBe('needs-gru');
  });

  it('keeps distinct reports and unrelated dot-scoped notifications independent', () => {
    const r = fixture();
    const held = r.wait();
    for (const [id, kind] of [['other-report', 'silas.report-handback.other-review'], ['unbound-1', 'other.unbound'], ['unbound-2', 'other.unbound']]) {
      r.ledger.recordNotification({ id: id!, kind: kind!, title: r.original.title, detail: 'identical detail', routing: 'action-required', severity: 'info' });
    }
    const independent = r.mailbox.attentionPage(50).filter((row) => row.kind === 'incident');
    expect(independent).toHaveLength(3);
    expect(independent.every((row) => row.id !== held.id)).toBe(true);
  });

  it('preserves custody through presentation-only title changes', () => {
    const r = fixture();
    const held = r.wait();
    const replacement = r.replace();
    r.ledger.updateNotificationDetail(replacement.id, replacement.detail!, 'Review is ready for collection');
    const item = r.mailbox.snapshot().items.find((row) => row.id === held.id)!;
    expect(item.subject).toBe(held.subject);
    expect(item.basis).toBe(held.basis);
    expect(item.state).toBe('waiting');
    expect(item.disposition).toEqual(held.disposition);
  });

  it('refuses a resolved mailbox ruling while its actual report debt remains open', () => {
    const r = fixture();
    const decision = r.ledger.recordDecision({ subject: r.original.subject, decision: 'dismissed', covers: r.original.reasons.map((reason) => reason.signal),
      basisFingerprint: r.original.basis, reason: 'attention alone cannot settle a report', by: 'gru' });
    expect(() => r.mailbox.disposition(r.original.id, { basis: r.original.basis, state: 'resolved', owner: 'writer', detail: 'false report closure',
      references: [{ kind: 'decision', id: decision.id }] })).toThrow(/producer/);
    const replacement = r.replace();
    expect(r.mailbox.attentionPage(50).find((row) => row.notificationIds.includes(replacement.id))?.state).toBe('needs-gru');
    expect(r.ledger.getObligation(r.debt.id)?.settlement).toBeNull();
  });

  it('uses the latest inserted evidence during a same-timestamp replacement gap', () => {
    const r = fixture();
    const held = r.wait();
    const original = r.ledger.getNotification(held.notificationIds[0]!)!;
    r.ledger.resolveNotificationById(original.id, 'gru');
    r.ledger.recordNotification({ id: 'zzzz-new-evidence', kind: KIND, title: original.title, detail: 'changed findings',
      severity: 'error', routing: 'action-required' });
    expect(r.ledger.getNotification('zzzz-new-evidence')?.ts).toBe(original.ts);
    const changed = r.mailbox.snapshot().items.find((row) => row.id === held.id)!;
    expect(changed.state).toBe('needs-gru');
    r.ledger.resolveNotificationById('zzzz-new-evidence', 'gru');
    const gap = r.mailbox.snapshot().items.find((row) => row.id === held.id)!;
    expect(gap.basis).toBe(changed.basis);
    expect(gap.state).toBe('needs-gru');
    expect(gap.notificationIds).toEqual([]);
  });

  it('does not resurrect old custody when an older card stays active after newer evidence is resolved', () => {
    const r = fixture();
    const held = r.wait();
    r.ledger.recordNotification({ id: 'newer-with-older-active', kind: KIND, title: r.original.title, detail: 'new evidence',
      severity: 'error', routing: 'action-required' });
    const changed = r.mailbox.snapshot().items.find((row) => row.id === held.id)!;
    expect(changed.state).toBe('needs-gru');
    r.ledger.resolveNotificationById('newer-with-older-active', 'gru');
    const retained = r.mailbox.snapshot().items.find((row) => row.id === held.id)!;
    expect(retained.state).toBe('needs-gru');
    expect(retained.basis).toBe(changed.basis);
    expect(retained.notificationIds).toEqual(held.notificationIds);
  });

  it('actual report settlement closes custody even if a duplicate transport card remains', () => {
    const r = fixture();
    const held = r.wait();
    const original = r.ledger.getNotification(held.notificationIds[0]!)!;
    r.ledger.recordNotification({ id: 'duplicate-at-settlement', kind: KIND, title: original.title, detail: original.detail!,
      routing: 'action-required', severity: original.severity });
    r.ledger.settleReportDisposition({ jobId: JOB, outcome: 'dismissed', note: 'commissioner collected both copies', by: 'writer' });
    expect(r.mailbox.snapshot().items.find((row) => row.id === held.id)?.state).toBe('resolved');
    expect(r.mailbox.attentionPage(50)).toEqual([]);
  });

  it('retains a receipt-waiting report obligation during a notification gap', () => {
    const r = fixture();
    r.ledger.armReceiptExpectation({ obligationId: r.debt.id, receiptKind: 'job.delivered', deadlineAt: RECHECK,
      correlation: { requestId: 'waiting-report' }, reason: 'await actual commissioner receipt' });
    const held = r.wait(r.mailbox.snapshot().items.find((row) => row.kind === 'incident')!);
    r.ledger.resolveNotificationById(held.notificationIds[0]!, 'gru');
    const gap = r.mailbox.snapshot().items.find((row) => row.id === held.id)!;
    expect(gap.state).toBe('waiting');
    expect(gap.disposition).toEqual(held.disposition);
    expect(r.ledger.getObligation(r.debt.id)?.state).toBe('waiting');
  });

  it('reopens on a new delivery alone without changing notification or obligation bytes', () => {
    const r = fixture();
    const held = r.wait();
    const before = r.ledger.getObligation(r.debt.id);
    r.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: JOB, payload: { report: 'corrected findings' } });
    const changed = r.mailbox.attentionPage(50).find((row) => row.id === held.id)!;
    expect(changed.basis).not.toBe(held.basis);
    expect(changed.state).toBe('needs-gru');
    expect(r.ledger.getObligation(r.debt.id)).toEqual(before);
    expect(changed.notificationIds).toEqual(held.notificationIds);
  });

  it('resumed nonterminal report work invalidates rather than closes gap custody', () => {
    const r = fixture();
    const held = r.wait();
    r.ledger.resolveNotificationById(held.notificationIds[0]!, 'gru');
    r.ledger.setJobStatus(JOB, 'working');
    const changed = r.mailbox.snapshot().items.find((row) => row.id === held.id)!;
    expect(changed.basis).not.toBe(held.basis);
    expect(changed.state).toBe('needs-gru');
    expect(r.ledger.getObligation(r.debt.id)?.state).toBe('open');
  });

  it('coalesces same-report transport agents without losing custody when one card is resolved', () => {
    const r = fixture();
    const held = r.wait();
    const original = r.ledger.getNotification(held.notificationIds[0]!)!;
    r.ledger.registerAgent({ id: 'transport-minion', role: 'minion', jobId: JOB });
    r.ledger.recordNotification({ id: 'transport-replacement', kind: KIND, agentId: 'transport-minion', title: original.title,
      detail: original.detail!, severity: original.severity, routing: 'action-required' });
    r.ledger.resolveNotificationById(original.id, 'gru');
    const item = r.mailbox.snapshot().items.find((row) => row.notificationIds.includes('transport-replacement'))!;
    expect(item.id).toBe(held.id);
    expect(item.basis).toBe(held.basis);
    expect(item.state).toBe('waiting');
    r.ledger.resolveNotificationById('transport-replacement', 'gru');
    expect(r.mailbox.snapshot().items.find((row) => row.id === held.id)?.state).toBe('waiting');
  });

  it('uses already-loaded jobs instead of querying each terminal historical report', () => {
    const r = fixture();
    for (let index = 0; index < 100; index += 1) {
      const id = `archived-${index}`;
      r.ledger.addJob({ id, repo: 'demo', title: id, deliverable: 'review', commissioner: 'writer' });
      r.ledger.setJobStatus(id, 'working');
      r.ledger.setJobStatus(id, 'done');
      const item = { ...r.original, id: `historical-${index}`, state: 'resolved', reasons: [{ ...r.original.reasons[0]!, label: `silas.report-handback.${id}` }] };
      r.db.handle.prepare('INSERT INTO gru_mailbox (id, item, updated_at) VALUES (?, ?, ?)').run(item.id, JSON.stringify(item), new Date().toISOString());
    }
    const lookup = vi.spyOn(r.ledger, 'getJob');
    r.mailbox.snapshot();
    expect(lookup.mock.calls.some(([id]) => id.startsWith('archived-'))).toBe(false);
    lookup.mockRestore();
  });

  it('authenticates and adopts an unchanged pre-upgrade wait without resetting T', () => {
    const r = fixture();
    const legacy = seedLegacyWait(r);
    const upgraded = r.mailbox.snapshot().items.find((row) => row.id === r.original.id)!;
    expect(upgraded.state).toBe('waiting');
    expect(upgraded.disposition).toEqual({ ...legacy.disposition, basis: upgraded.basis });
    r.replace();
    expect(r.mailbox.snapshot().items.find((row) => row.id === upgraded.id)?.disposition).toEqual(upgraded.disposition);
    expect(r.ledger.listEventsAfter(0, { kinds: ['mailbox.report-custody-migrated'], limit: 100 })).toHaveLength(1);
    expect(r.ledger.getDecision(legacy.disposition.references[0]!.id)?.basisFingerprint).toBe(legacy.basis);
  });

  it('does not adopt legacy coverage after a material source write', () => {
    const r = fixture();
    seedLegacyWait(r);
    r.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: JOB, payload: { report: 'changed after old ruling' } });
    expect(r.mailbox.snapshot().items.find((row) => row.id === r.original.id)?.state).toBe('needs-gru');
    expect(r.ledger.latestEventOfKind('mailbox.report-custody-migrated')).toBeNull();
  });

  it('refuses unauthenticated legacy metadata rather than inventing a custody ruling', () => {
    const r = fixture();
    const legacy = seedLegacyWait(r);
    const tampered = { ...legacy, disposition: { ...legacy.disposition, owner: 'invented-owner' } };
    r.db.handle.prepare('UPDATE gru_mailbox SET item = ? WHERE id = ?').run(JSON.stringify(tampered), legacy.id);
    expect(r.mailbox.snapshot().items.find((row) => row.id === r.original.id)?.state).toBe('needs-gru');
    expect(r.ledger.latestEventOfKind('mailbox.report-custody-migrated')).toBeNull();
  });

  it('allows legacy adoption after metadata-only job mailbox receipts and dispositions', () => {
    const r = fixture();
    const legacy = seedLegacyWait(r);
    const before = r.ledger.getObligation(r.debt.id);
    // Model authentic old-runtime bookkeeping after the incident ruling, before upgrade.
    r.ledger.appendCustomEvent({ kind: 'mailbox.received', jobId: JOB, payload: { id: `job:${JOB}`, receipt: { deliveryId: 'job-receipt' } } });
    r.ledger.appendCustomEvent({ kind: 'mailbox.disposition', jobId: JOB, payload: { id: `job:${JOB}`, disposition: legacy.disposition } });
    const upgraded = r.mailbox.snapshot().items.find((row) => row.id === r.original.id)!;
    expect(upgraded.state).toBe('waiting');
    expect(upgraded.disposition?.recheckAt).toBe(RECHECK);
    expect(r.ledger.getObligation(r.debt.id)).toEqual(before);
    expect(r.ledger.latestEventOfKind('mailbox.report-custody-migrated')).not.toBeNull();
  });

  it('does not resurrect a legacy wait over a newer report-wide needs-gru ruling', () => {
    const r = fixture();
    seedLegacyWait(r);
    const replacement = r.replace();
    const later = seedLegacyWait(r, true, replacement.id);
    const disposition = { ...later.disposition, state: 'needs-gru', owner: 'gru', detail: 'explicitly reevaluate report now',
      dependency: null, recheckAt: null, references: [] };
    r.ledger.appendCustomEvent({ kind: 'mailbox.disposition', payload: { id: later.id, disposition } });
    r.db.handle.prepare('UPDATE gru_mailbox SET item = ? WHERE id = ?').run(JSON.stringify({ ...later, state: 'needs-gru', disposition }), later.id);
    expect(r.mailbox.snapshot().items.find((row) => row.id === r.original.id)?.state).toBe('needs-gru');
    expect(r.ledger.latestEventOfKind('mailbox.report-custody-migrated')).toBeNull();
  });

  it('refuses legacy metadata that has no original durable disposition ruling', () => {
    const r = fixture();
    seedLegacyWait(r, false);
    expect(r.mailbox.snapshot().items.find((row) => row.id === r.original.id)?.state).toBe('needs-gru');
    expect(r.ledger.latestEventOfKind('mailbox.report-custody-migrated')).toBeNull();
  });

  it('uses authoritative report severity instead of an older active error card at the wake floor', () => {
    const r = fixture('error');
    const original = r.ledger.getNotification(r.original.notificationIds[0]!)!;
    r.ledger.recordNotification({ id: 'obsolete-error', kind: KIND, title: original.title, detail: 'past diagnosis',
      routing: 'action-required', severity: 'error' });
    r.ledger.recordNotification({ id: 'current-info', kind: KIND, title: original.title, detail: original.detail!,
      routing: 'action-required', severity: 'info' });
    expect(r.mailbox.snapshot().items.find((row) => row.id === r.original.id)?.severity).toBe('info');
    let turns = 0;
    r.awareness.setWakeSink(() => { turns += 1; });
    vi.advanceTimersByTime(1000);
    expect(turns).toBe(0);
    expect(r.mailbox.snapshot().items.find((row) => row.id === r.original.id)?.state).toBe('needs-gru');
  });

  it('loads retained custody from a separately reopened durable ledger connection', () => {
    const r = fixture();
    const held = r.wait();
    r.replace();
    const reopened = new LedgerDb(r.dir);
    closes.unshift(() => { reopened.close(); });
    const snapshot = new GruMailbox(new LedgerApi(reopened.handle)).snapshot();
    expect(snapshot.items.find((row) => row.id === held.id)?.disposition).toEqual(held.disposition);
    expect(snapshot.items.find((row) => row.id === held.id)?.state).toBe('waiting');
  });

  it('admits no extra Gru turn from ID churn before T and admits one at T through awareness', () => {
    const r = fixture();
    // Account for both the source job's obligation and its independently scoped report card.
    for (const item of r.mailbox.snapshot().items) r.wait(item);
    let turns = 0;
    r.awareness.setWakeSink(() => {
      if (!r.awareness.admitWake()) throw new Error('report wake was not admitted');
      const injection = r.awareness.prepare('wake')!;
      turns += 1;
      r.awareness.commit(injection, 'wake');
      r.awareness.noteWakeOutcome(true, undefined, injection);
    });
    for (let index = 0; index < 3; index += 1) {
      vi.advanceTimersByTime(60_000);
      r.replace();
      vi.advanceTimersByTime(1000);
      expect(turns).toBe(0);
    }
    vi.advanceTimersByTime(Date.parse(RECHECK) - Date.now());
    expect(turns).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(turns).toBe(1);
    expect(r.ledger.getObligation(r.debt.id)?.settlement).toBeNull();
  });
});
