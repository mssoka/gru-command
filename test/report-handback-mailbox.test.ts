import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GruAwareness } from '../src/chat/awareness.js';
import { reconcileReportClosures } from '../src/dispatch/durable-reconcile.js';
import { EventBus } from '../src/events/bus.js';
import { GruMailbox } from '../src/gru-mailbox/service.js';
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

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const dir = mkdtempSync(join(tmpdir(), 'gru-report-handback-mailbox-'));
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const mailbox = new GruMailbox(ledger);
  const awareness = new GruAwareness({ dir, ledger, bus, mailbox, wakeMinIntervalMs: 0, mailboxReconcileIntervalMs: 1000 });
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
      correlation: {}, reason: 'a new report receipt is now required' });
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
    expect(r.ledger.getObligation(r.debt.id)?.state).toBe('settled');
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
