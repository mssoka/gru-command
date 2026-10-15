import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { GruMailbox } from '../src/gru-mailbox/service.js';
import { branchStatePayload } from '../src/dispatch/github-poll.js';
import { DirectiveNativeFixture } from './helpers/directive-native-fixture.js';
import { inspectDirectiveAdmission } from '../src/runtime/directive-checkpoint.js';

const ids = [
  'perkins-integration-review-coverage-20261009', 'dashboard-slim-strip-current-main-20261007',
  'guarded-directive-recovery-r2-verification-gap', 'guarded-directive-recovery-r2-edge-cases',
  'guarded-directive-recovery-r2-blind-hunter', 'review-closeout-r6b-verification-gap-889e65b',
  'review-closeout-r6b-edge-case-889e65b', 'dashboard-slim-strip',
  'review-closeout-r5-blind-hunter-9511478', 'review-closeout-r4-blind-hunter-14fe2a1',
  'job-status-binned', 'gc-packaged-build-playbook-20261002',
];
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gru-mailbox-'));
  const db = new LedgerDb(dir);
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const ledger = new LedgerApi(db.handle);
  let now = Date.parse('2026-10-11T00:20:01Z');
  const mailbox = new GruMailbox(ledger, () => now);
  return { dir, db, ledger, mailbox, advance: (ms: number) => { now += ms; } };
}

describe('GH-305 canonical durable mailbox', () => {
  it('reproduces twelve historical threads, two source notifications and a separate incident', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'parent', repo: 'r', title: 'parent' });
    ledger.setJobStatus('parent', 'working');
    ledger.setJobStatus('parent', 'done');
    for (const [index, id] of ids.entries()) {
      ledger.addJob({ id, repo: 'r', title: id, ...(index === 2 ? { parentJobId: 'parent', deliverable: 'review' as const } : {}) });
      if (index === 0 || index === 1 || index === 11) {
        const round = ledger.addRound({ jobId: id, lenses: ['blind'], targetRef: `head-${index}` });
        ledger.setRoundStatus(round.id, 'aborted');
      } else ledger.setJobStatus(id, 'blocked');
    }
    ledger.registerAgent({ id: 'bound', role: 'minion', jobId: ids[0]! });
    for (const id of ['n1']) ledger.recordNotification({ id, kind: `silas.escalated:${ids[0]}`, title: 'same title', routing: 'action-required', severity: 'error', agentId: 'bound' });
    ledger.recordNotification({ id: 'dream', kind: 'lessons.dream-failed', title: 'Book dream failed', routing: 'action-required', severity: 'error' });
    const view = mailbox.snapshot();
    expect(view.items.filter((item) => item.kind === 'job').map((item) => item.jobId).sort()).toEqual([...ids].sort());
    expect(view.counts).toEqual({ threads: 12, incidents: 1, notifications: 2, needsGru: 13 });
    expect(view.items.find((item) => item.jobId === ids[0])?.notificationIds).toEqual(['n1']);
    expect(view.items.find((item) => item.jobId === ids[2])?.reasons.map((reason) => reason.label)).toContain('blocked');
  });
  it('delivery is a durable receipt, not a disposition; unchanged basis deduplicates', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    const item = mailbox.snapshot().items[0]!;
    mailbox.received(item.id, item.basis, 'chat', 'delivery-1');
    expect(mailbox.snapshot().items[0]?.state).toBe('needs-gru');
    expect(mailbox.attentionPage(8)).toHaveLength(0);
    expect(mailbox.snapshot().items[0]?.receipt?.deliveryId).toBe('delivery-1');
  });
  it('unhandled delivery gets a bounded durable recheck, not permanent silence or immediate duplicate turns', () => {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'unhandled', repo: 'r', title: 'no next action recorded' });
    ledger.setJobStatus('unhandled', 'blocked');
    const original = mailbox.snapshot().items[0]!;
    mailbox.received(original.id, original.basis, 'wake', 'first-delivery');
    advance(299999);
    expect(mailbox.attentionPage(8)).toHaveLength(0);
    advance(1);
    const due = mailbox.attentionPage(8)[0]!;
    expect(due?.id).toBe(original.id);
    expect(due?.basis).toBe(original.basis);
    expect(due?.attentionKey).not.toBe(original.attentionKey);
    expect(due?.state).toBe('needs-gru');
    mailbox.received(due.id, due.basis, 'wake', 'second-delivery');
    expect(mailbox.attentionPage(8)).toHaveLength(0);
    advance(300000);
    expect(mailbox.attentionPage(8)).toHaveLength(1);
    expect(ledger.getJob('unhandled')?.status).toBe('blocked');
    expect(ledger.listNotifications()).toHaveLength(0);
  });
  it('waiting requires a real dependency, exact basis and future recheck; due reopens without changing job state', () => {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    const item = mailbox.snapshot().items[0]!;
    const decision = ledger.recordDecision({ subject: 'job:j', decision: 'hold', covers: ['blocked'], reason: 'owner permission required', by: 'owner' });
    const input = { state: 'waiting', basis: item.basis, owner: 'owner', detail: 'do not restart', dependency: 'owner continuation ruling', recheckAt: '2026-10-11T00:25:01.000Z', references: [{ kind: 'decision', id: decision.id }] };
    expect(() => mailbox.disposition(item.id, { ...input, basis: 'stale' })).toThrow(/basis/);
    expect(() => mailbox.disposition(item.id, { ...input, references: [{ kind: 'decision', id: 'missing' }] })).toThrow(/reference/);
    mailbox.disposition(item.id, input);
    expect(mailbox.snapshot().items[0]?.state).toBe('waiting');
    advance(300000);
    expect(mailbox.snapshot().items[0]?.state).toBe('needs-gru');
    expect(mailbox.attentionPage(8)).toHaveLength(1);
    expect(ledger.getJob('j')?.status).toBe('blocked');
  });
  it('rejects unsupported producer closure and never treats a wildcard hold as a receipt', () => {
    const { ledger, mailbox } = fixture();
    ledger.recordNotification({ id: 'dream', kind: 'lessons.dream-failed', title: 'failure', routing: 'action-required', severity: 'error' });
    const item = mailbox.snapshot().items[0]!;
    expect(item.receipt).toBeNull();
    const hold = ledger.recordDecision({ subject: item.subject, decision: 'hold', covers: item.reasons.map((reason) => reason.signal), reason: 'producer repair required', by: 'gru' });
    mailbox.disposition(item.id, { state: 'waiting', basis: item.basis, owner: 'producer', detail: 'producer alone closes this', dependency: 'successful Book dream', recheckAt: '2026-10-11T00:25:01.000Z', references: [{ kind: 'decision', id: hold.id }] });
    expect(mailbox.snapshot().items[0]?.references).toContainEqual({ kind: 'decision', id: hold.id });
    expect(mailbox.snapshot().items[0]?.restrictions).toContain('gru: producer repair required');
    expect(() => mailbox.disposition(item.id, { state: 'resolved', basis: item.basis, owner: 'gru', detail: 'read it', references: [] })).toThrow(/producer/);
    expect(ledger.getNotification('dream')?.resolvedAt).toBeNull();
  });
  it('exact-basis accounted work stays quiet but a new review round or changed failure reopens it', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    const item = mailbox.snapshot().items[0]!;
    const decision = ledger.recordDecision({ subject: item.subject, decision: 'acted', covers: item.reasons.map((reason) => reason.signal), basisFingerprint: item.basis, reason: 'inspected correlated replacement report', by: 'gru' });
    mailbox.disposition(item.id, { state: 'resolved', basis: item.basis, owner: 'gru', detail: 'attention accounted by existing inspected report', references: [{ kind: 'decision', id: decision.id }] });
    expect(mailbox.attentionPage(8)).toHaveLength(0);
    expect(mailbox.snapshot().items[0]?.state).toBe('resolved');
    ledger.addRound({ jobId: 'j', lenses: ['blind'], targetRef: 'new-head' });
    expect(mailbox.snapshot().items[0]?.state).toBe('needs-gru');
    expect(mailbox.attentionPage(8)).toHaveLength(1);
    expect(ledger.getJob('j')?.status).toBe('blocked');
  });

  it('same-titled unbound notifications remain independent and duplicate scoped basis coalesces', () => {
    const { ledger, mailbox } = fixture();
    for (const id of ['a', 'b']) ledger.recordNotification({ id, kind: 'unbound.test', title: 'identical title', detail: id, routing: 'action-required', severity: 'error' });
    expect(mailbox.snapshot().counts.incidents).toBe(2);
    const old = mailbox.snapshot().items.find((item) => item.notificationIds.includes('a'))!;
    mailbox.received(old.id, old.basis, 'wake', 'accepted');
    ledger.recordNotification({ id: 'c', kind: 'unbound.test', title: 'identical title', detail: 'new evidence', routing: 'action-required', severity: 'error' });
    expect(mailbox.snapshot().counts.incidents).toBe(3);
    expect(mailbox.attentionPage(8)).toHaveLength(2);
    ledger.addJob({ id: 'scoped', repo: 'r', title: 'scoped' });
    ledger.registerAgent({ id: 'scoped-agent', role: 'minion', jobId: 'scoped' });
    ledger.recordNotification({ id: 'scoped-a', agentId: 'scoped-agent', kind: 'github.pr-conflict:scoped', title: 'duplicate title', detail: 'first head', routing: 'action-required', severity: 'error' });
    const scoped = mailbox.snapshot().items.find((item) => item.jobId === 'scoped')!;
    mailbox.received(scoped.id, scoped.basis, 'wake', 'scoped-receipt');
    ledger.recordNotification({ id: 'scoped-b', agentId: 'scoped-agent', kind: 'github.pr-conflict:scoped', title: 'duplicate title', detail: 'first head', routing: 'action-required', severity: 'error' });
    expect(mailbox.attentionPage(8).some((item) => item.jobId === 'scoped')).toBe(false);
    ledger.recordNotification({ id: 'scoped-c', agentId: 'scoped-agent', kind: 'github.pr-conflict:scoped', title: 'duplicate title', detail: 'changed head evidence', routing: 'action-required', severity: 'error' });
    expect(mailbox.attentionPage(8).some((item) => item.jobId === 'scoped')).toBe(true);
  });

  it('rejects invented delegation and malformed PR evidence before any metadata closure', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    const item = mailbox.snapshot().items[0]!;
    expect(() => mailbox.disposition(item.id, { state: 'delegated', basis: item.basis, owner: 'imaginary-minion', detail: 'delegated', dependency: 'report', recheckAt: '2026-10-11T00:25:01.000Z', references: [{ kind: 'obligation', id: item.references.find((ref) => ref.kind === 'obligation')!.id }] })).toThrow(/actual live control/);
    ledger.appendCustomEvent({ kind: 'github.branch-state', jobId: 'j', payload: 'malformed' });
    expect(() => mailbox.snapshot()).toThrow(/malformed PR evidence/);
  });

  it('admits obligation-only Gru decisions, never healthy mechanical/owner/external debt or owner-only notices', () => {
    const { ledger, mailbox } = fixture();
    const cases = [
      { id: 'gru', nextAction: { kind: 'gru-decision' as const, decision: 'rule on findings' } },
      { id: 'owner', nextAction: { kind: 'owner-decision' as const, decision: 'owner alone decides' } },
      { id: 'external', nextAction: { kind: 'external-wait' as const, condition: 'provider recovers' } },
      { id: 'mechanical', nextAction: { kind: 'silas-mechanical' as const, action: 'register-pr' as const } },
    ];
    for (const { id, nextAction } of cases) {
      ledger.addJob({ id, repo: 'r', title: id });
      ledger.setJobStatus(id, 'working');
      const control = ledger.beginDirectiveIntent({ jobId: id, directive: 'existing bounded work', holder: 'silas', requestId: `control-${id}` });
      ledger.recordBlockedObservation(id, { logicalStep: 'operation', category: { kind: 'unknown' }, incidentKey: id,
        observedAtSeq: ledger.latestEventSeq(), nextAction, ...(id === 'mechanical' ? { authority: { source: 'accepted-operation', operationId: control.record.requestId, version: '1' } as const } : {}) });
    }
    ledger.recordNotification({ id: 'owner-only', kind: 'supervision.breaker', title: 'owner stop', routing: 'needs-owner', severity: 'error' });
    expect(mailbox.snapshot().items.filter((item) => item.state !== 'resolved').map((item) => item.jobId)).toEqual(['gru']);
    expect(ledger.getNotification('owner-only')?.ackedAt).toBeNull();
    expect(mailbox.attentionRows()[0]?.severity).toBe('info');
  });

  it('healthy delegated Gru follow-up stays quiet until its recorded receipt deadline is due', () => {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'existing writer' });
    ledger.setJobStatus('j', 'working');
    ledger.registerAgent({ id: 'actual-writer', role: 'minion', jobId: 'j' });
    ledger.setAgentState('actual-writer', 'streaming');
    const followUp = ledger.recordBlockedObservation('j', { logicalStep: 'audit', category: { kind: 'known', category: 'verification-failure' }, incidentKey: 'bounded-work', observedAtSeq: ledger.latestEventSeq() });
    ledger.armReceiptExpectation({ obligationId: followUp.id, receiptKind: 'job.delivered', deadlineAt: '2026-10-11T00:25:01.000Z', correlation: { minionId: 'actual-writer' }, reason: 'existing writer owes a report, then Gru rules' });
    expect(mailbox.attentionPage(8)).toHaveLength(0);
    advance(300000);
    expect(mailbox.attentionPage(8).map((item) => item.jobId)).toEqual(['j']);
    expect(ledger.getAgent('actual-writer')?.state).toBe('streaming');
    expect(ledger.getObligation(followUp.id)?.state).toBe('waiting');
  });

  it('delegation links the actual writer and an existing follow-up without executing or settling work', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    ledger.registerAgent({ id: 'writer', role: 'minion', jobId: 'j' });
    ledger.setAgentState('writer', 'streaming');
    const item = mailbox.snapshot().items[0]!;
    const followUp = item.references.find((ref) => ref.kind === 'obligation')!;
    mailbox.disposition(item.id, { state: 'delegated', basis: item.basis, owner: 'writer', detail: 'reuse already-running control', dependency: 'correlated writer report', recheckAt: '2026-10-11T00:25:01.000Z', references: [{ kind: 'agent', id: 'writer' }, followUp] });
    expect(mailbox.snapshot().items[0]?.state).toBe('delegated');
    expect(mailbox.attentionPage(8)).toHaveLength(0);
    expect(ledger.getObligation(followUp.id)?.state).toBe('open');
    ledger.setAgentState('writer', 'idle');
    expect(mailbox.snapshot().items[0]?.state).toBe('needs-gru');
    expect(ledger.getJob('j')?.status).toBe('blocked');
  });

  it('G01 traverses mixed-case and punctuation identities without omissions', () => {
    const { ledger, mailbox } = fixture();
    for (const id of ['a', 'A', 'Z', 'z', 'a_', 'a-', 'a.B']) {
      ledger.addJob({ id, repo: 'r', title: id });
      ledger.setJobStatus(id, 'blocked');
    }
    const expected = mailbox.snapshot().items.map((item) => item.id);
    const found: string[] = [];
    let cursor = '';
    for (let pass = 0; pass < 20; pass++) {
      const page = mailbox.page(cursor, 1);
      found.push(...page.items.map((item) => item.id));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(found).toEqual(expected);
    expect(new Set(found).size).toBe(7);
  });

  it('G02 selects insertion-newest implementer, never reviewers or children', () => {
    const { db, ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.registerAgent({ id: 'z-old', role: 'minion', jobId: 'j' });
    ledger.registerAgent({ id: 'a-new', role: 'minion', jobId: 'j' });
    ledger.setAgentState('a-new', 'error');
    const round = ledger.addRound({ jobId: 'j', lenses: ['blind'], targetRef: 'head' });
    ledger.registerAgent({ id: 'review', role: 'minion', jobId: 'j', roundId: round.id });
    ledger.registerAgent({ id: 'child', role: 'minion', jobId: 'j', parentAgentId: 'a-new' });
    db.handle.prepare('UPDATE agents SET created_at = ?').run('2026-10-11T00:00:00.000Z');
    expect(ledger.listImplementerMinions('j')[0]?.id).toBe('a-new');
    const item = mailbox.snapshot().items[0];
    expect(item?.reasons.map((reason) => reason.signal)).toContain('worker-error');
    expect(item?.references).toContainEqual({ kind: 'agent', id: 'a-new' });
    expect(item?.references).not.toContainEqual({ kind: 'agent', id: 'child' });
    expect(item?.references).not.toContainEqual({ kind: 'agent', id: 'review' });
  });

  it('G03 refreshes cached evidence after eventless existing-agent writes', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.registerAgent({ id: 'worker', role: 'minion', jobId: 'j' });
    ledger.setAgentState('worker', 'error');
    expect(mailbox.snapshot().items[0]?.reasons.map((reason) => reason.signal)).toContain('worker-error');
    const round = ledger.addRound({ jobId: 'j', lenses: ['blind'], targetRef: 'head' });
    mailbox.snapshot();
    const beforeAgentWrite = ledger.latestEventSeq();
    ledger.registerAgent({ id: 'worker', role: 'minion', roundId: round.id });
    expect(ledger.latestEventSeq()).toBe(beforeAgentWrite);
    expect(mailbox.snapshot().items.filter((item) => item.state !== 'resolved')).toHaveLength(0);
  });

  it('G03 refreshes cached controls after an eventless directive admission', () => {
    const { dir, ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    const sessionFile = join(dir, 'original-worker.jsonl');
    ledger.registerAgent({ id: 'worker', role: 'minion', jobId: 'j', sessionFile });
    ledger.beginDirectiveIntent({ jobId: 'j', directive: 'existing work', holder: 'silas', requestId: 'control' });
    ledger.prepareDirectiveTarget('control', { agentId: 'worker', sessionFile });
    const native = new DirectiveNativeFixture(sessionFile, 'worker');
    const recordAdmission = ledger.recordDirectiveAdmission.bind(ledger);
    let beforeBasis: string | undefined;
    let watermark = -1;
    // The supported binder records the native sent event before its eventless
    // admission transition. Observe that exact seam, never fabricate a binding.
    const admission = vi.spyOn(ledger, 'recordDirectiveAdmission').mockImplementation((input) => {
      beforeBasis = mailbox.snapshot().items[0]!.basis;
      watermark = ledger.latestEventSeq();
      return recordAdmission(input);
    });
    try {
      native.begin('existing approved work', { directive: {
        identity: ledger.directiveTurnIdentity('control'), beforeAdmission: () => {},
        onAdmitted: (binding) => { ledger.bindDirectiveNativeAdmission(binding); },
      } });
      expect(admission).toHaveBeenCalledTimes(1);
      expect(inspectDirectiveAdmission(sessionFile, ledger.directiveTurnIdentity('control'))).toEqual(ledger.getDirective('control')!.nativeBinding);
      expect(ledger.getDirective('control')?.state).toBe('admitted');
      expect(ledger.latestEventSeq()).toBe(watermark);
      expect(mailbox.snapshot().items[0]?.basis).not.toBe(beforeBasis);
    } finally { admission.mockRestore(); }
  });

  it('G04 reopens waiting when supporting decisions are cleared', () => assertRevokedDisposition('waiting'));
  it('G04 reopens resolved when supporting decisions are cleared', () => assertRevokedDisposition('resolved'));
  function assertRevokedDisposition(state: 'waiting' | 'resolved'): void {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    const item = mailbox.snapshot().items[0]!;
    const decision = ledger.recordDecision({ subject: item.subject, decision: state === 'waiting' ? 'hold' : 'acted',
      basisFingerprint: state === 'waiting' ? null : item.basis, covers: item.reasons.map((reason) => reason.signal), reason: 'inspected', by: 'owner' });
    mailbox.disposition(item.id, { basis: item.basis, state, owner: 'owner', detail: 'owner ruling',
      ...(state === 'waiting' ? { dependency: 'owner permission', recheckAt: '2026-10-11T00:25:01.000Z' } : {}), references: [{ kind: 'decision', id: decision.id }] });
    expect(mailbox.snapshot().items[0]?.state).toBe(state);
    ledger.clearDecision({ id: decision.id, by: 'owner', reason: 'revoked' });
    const reopened = mailbox.snapshot().items[0]!;
    expect(reopened.basis).toBe(item.basis);
    expect(reopened.state).toBe('needs-gru');
    expect(reopened.owner).toBe('gru');
    expect(reopened.references).not.toContainEqual({ kind: 'decision', id: decision.id });
    expect(ledger.getJob('j')?.status).toBe('blocked');
  }

  it('G05 carries durable stops only on independently eligible threads until owner rearm', () => {
    const { ledger, mailbox } = fixture();
    for (const id of ['stopped', 'healthy']) {
      ledger.addJob({ id, repo: 'r', title: id });
      ledger.registerAgent({ id: `${id}-worker`, role: 'minion', jobId: id });
    }
    ledger.setAgentState('stopped-worker', 'error');
    const stop = ledger.appendCustomEvent({ kind: 'supervision.breaker', agentId: 'stopped-worker', jobId: 'stopped', payload: { reason: 'owner restart approval', restarts: 3 } });
    ledger.appendCustomEvent({ kind: 'supervision.escalated', agentId: 'healthy-worker', jobId: 'healthy', payload: { reason: 'owner only' } });
    const item = mailbox.snapshot().items[0]!;
    expect(mailbox.snapshot().items.map((row) => row.jobId)).toEqual(['stopped']);
    expect(item.restrictions.join(' ')).toMatch(/owner.*restart.*approval/);
    expect(item.references).toContainEqual({ kind: 'event', id: String(stop.seq) });
    ledger.appendCustomEvent({ kind: 'supervision.rearmed', agentId: 'stopped-worker', jobId: 'stopped', payload: {} });
    expect(mailbox.snapshot().items[0]?.restrictions.join(' ')).not.toMatch(/owner restart approval/);
  });

  it('G20 expired identical waiting replay preserves the original deadline and event watermark', () => assertExpiredReplay('waiting'));
  it('G20 expired identical delegated replay preserves the original deadline and event watermark', () => assertExpiredReplay('delegated'));
  function assertExpiredReplay(state: 'waiting' | 'delegated'): void {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    ledger.registerAgent({ id: 'writer', role: 'minion', jobId: 'j' });
    ledger.setAgentState('writer', 'streaming');
    const item = mailbox.snapshot().items[0]!;
    const hold = ledger.recordDecision({ subject: item.subject, decision: 'hold', covers: ['blocked'], reason: 'permission', by: 'owner' });
    const input = { basis: item.basis, state, owner: state === 'waiting' ? 'owner' : 'writer', detail: 'wait', dependency: 'permission', recheckAt: '2026-10-11T00:25:01.000Z', references: state === 'waiting' ? [{ kind: 'decision', id: hold.id }] : [{ kind: 'agent', id: 'writer' }, item.references.find((ref) => ref.kind === 'obligation')!] };
    const first = mailbox.disposition(item.id, input).disposition;
    advance(300001);
    const watermark = ledger.latestEventSeq();
    expect(() => mailbox.disposition(item.id, input)).not.toThrow();
    expect(mailbox.disposition(item.id, input).disposition).toEqual(first);
    expect(mailbox.snapshot().items[0]?.state).toBe('needs-gru');
    expect(ledger.latestEventSeq()).toBe(watermark);
    expect(() => mailbox.disposition(item.id, { ...input, detail: 'new stale write' })).toThrow(/future/);
    expect(ledger.latestEventSeq()).toBe(watermark);
  }

  it('G22 admits authentic dirty PR evidence without an action-required notification', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobPr('j', 'https://github.com/org/repo/pull/22');
    ledger.appendCustomEvent({ kind: 'github.branch-state', jobId: 'j', payload: branchStatePayload({ jobId: 'j', repo: { host: 'github.com', owner: 'org', repo: 'repo' }, branch: 'j', prNumber: 22, prUrl: 'https://github.com/org/repo/pull/22' }, { sha: 'abc123', merged: false, prNumber: 22, prUrl: 'https://github.com/org/repo/pull/22', prOpen: true, mergeableState: 'dirty', mergeCommitSha: null, ci: null }) });
    expect(ledger.listNotifications()).toHaveLength(0);
    expect(mailbox.snapshot().items[0]?.reasons.map((reason) => reason.signal)).toEqual(['pr-conflict']);
    expect(mailbox.attentionPage(8)[0]?.jobId).toBe('j');
  });

  it('F03 malformed object field values cannot certify closure of a dirty-PR-only thread', () => {
    for (const invalid of [{ pr_open: 'true' }, { pr_url: 22 }, { mergeable_state: [] }, { sha: 123 }, { pr_open: undefined }]) {
      const { ledger, mailbox } = fixture();
      const prUrl = 'https://github.com/org/repo/pull/22';
      ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
      ledger.setJobPr('j', prUrl);
      const observed = branchStatePayload({ jobId: 'j', repo: { host: 'github.com', owner: 'org', repo: 'repo' }, branch: 'j', prNumber: 22, prUrl }, { sha: 'abc123', merged: false, prNumber: 22, prUrl, prOpen: true, mergeableState: 'dirty', mergeCommitSha: null, ci: null });
      ledger.appendCustomEvent({ kind: 'github.branch-state', jobId: 'j', payload: observed });
      const before = mailbox.snapshot().items[0]!;
      expect(before.reasons.map((reason) => reason.signal)).toEqual(['pr-conflict']);
      ledger.appendCustomEvent({ kind: 'github.branch-state', jobId: 'j', payload: { ...observed, ...invalid } });
      expect(() => mailbox.snapshot()).toThrow(/malformed PR evidence/);
      expect(ledger.listMailboxItems()).toEqual([before]);
      expect(ledger.latestEventOfKind('mailbox.disposition')).toBeNull();
    }
  });

  it('F03 preserves initial legacy unknown-open observations until a genuine poll observation', () => {
    const { ledger, mailbox } = fixture();
    const prUrl = 'https://github.com/org/repo/pull/22';
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobPr('j', prUrl);
    const observed = branchStatePayload({ jobId: 'j', repo: { host: 'github.com', owner: 'org', repo: 'repo' }, branch: 'j', prNumber: 22, prUrl }, { sha: 'abc123', merged: false, prNumber: 22, prUrl, prOpen: true, mergeableState: 'dirty', mergeCommitSha: null, ci: null });
    const { pr_open: legacyOpen, ...legacy } = observed;
    void legacyOpen;
    ledger.appendCustomEvent({ kind: 'github.branch-state', jobId: 'j', payload: legacy });
    expect(mailbox.snapshot().items).toEqual([]);
    ledger.appendCustomEvent({ kind: 'github.branch-state', jobId: 'j', payload: observed });
    expect(mailbox.snapshot().items[0]?.reasons.map((reason) => reason.signal)).toEqual(['pr-conflict']);
    ledger.appendCustomEvent({ kind: 'github.branch-state', jobId: 'j', payload: { ...observed, pr_open: false, mergeable_state: null, sha: null } });
    expect(mailbox.snapshot().items[0]?.state).toBe('resolved');
    expect(mailbox.snapshot().items[0]?.receipt).toBeNull();
  });

  it('F03 unknown PR observations cannot certify closure of previously surfaced conflicts', () => {
    for (const unknown of [{ pr_open: null }, { pr_url: null }, { pr_url: 'https://github.com/org/repo/pull/23' }, { sha: 'new-head', mergeable_state: null }, { mergeable_state: 'unknown' }]) {
      const { ledger, mailbox } = fixture();
      const prUrl = 'https://github.com/org/repo/pull/22';
      ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
      ledger.setJobPr('j', prUrl);
      const observed = branchStatePayload({ jobId: 'j', repo: { host: 'github.com', owner: 'org', repo: 'repo' }, branch: 'j', prNumber: 22, prUrl }, { sha: 'abc123', merged: false, prNumber: 22, prUrl, prOpen: true, mergeableState: 'dirty', mergeCommitSha: null, ci: null });
      ledger.appendCustomEvent({ kind: 'github.branch-state', jobId: 'j', payload: observed });
      const before = mailbox.snapshot().items[0]!;
      ledger.appendCustomEvent({ kind: 'github.branch-state', jobId: 'j', payload: { ...observed, ...unknown } });
      expect(() => mailbox.snapshot()).toThrow(/PR closure evidence unavailable/);
      expect(ledger.listMailboxItems()).toEqual([before]);
      expect(ledger.latestEventOfKind('mailbox.disposition')).toBeNull();
    }
  });

  it('G23 rejects a partial exact-basis multi-reason resolution without changing metadata', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    ledger.registerAgent({ id: 'worker', role: 'minion', jobId: 'j' });
    ledger.setAgentState('worker', 'error');
    const item = mailbox.snapshot().items[0]!;
    expect(item.reasons.map((reason) => reason.signal)).toEqual(expect.arrayContaining(['blocked', 'worker-error']));
    const partial = ledger.recordDecision({ subject: item.subject, decision: 'acted', basisFingerprint: item.basis, covers: ['blocked'], reason: 'partial accounting', by: 'gru' });
    const before = mailbox.snapshot().items[0];
    const watermark = ledger.latestEventSeq();
    expect(() => mailbox.disposition(item.id, { basis: item.basis, state: 'resolved', owner: 'gru', detail: 'partial', references: [{ kind: 'decision', id: partial.id }] })).toThrow(/every reason/);
    expect(mailbox.snapshot().items[0]).toEqual(before);
    expect(ledger.latestEventSeq()).toBe(watermark);
  });

  it('G25 keeps surfaced future receipt debt delegated with its actual writer, then reopens at deadline', () => {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'working');
    ledger.registerAgent({ id: 'writer', role: 'minion', jobId: 'j' });
    ledger.setAgentState('writer', 'streaming');
    const obligation = ledger.recordBlockedObservation('j', { logicalStep: 'audit', category: { kind: 'known', category: 'verification-failure' }, incidentKey: 'actual-debt', observedAtSeq: ledger.latestEventSeq() });
    expect(mailbox.attentionPage(8).map((item) => item.jobId)).toEqual(['j']);
    ledger.armReceiptExpectation({ obligationId: obligation.id, receiptKind: 'job.delivered', deadlineAt: '2026-10-11T00:25:01.000Z', correlation: { minionId: 'writer' }, reason: 'writer owes report then Gru rules' });
    const waiting = mailbox.snapshot().items[0]!;
    expect(waiting.state).toBe('delegated');
    expect(waiting.owner).toBe('writer');
    expect(waiting.disposition?.dependency).toMatch(/job.delivered/);
    expect(waiting.disposition?.detail).toMatch(/source-derived/);
    expect(waiting.disposition?.recheckAt).toBe('2026-10-11T00:25:01.000Z');
    expect(mailbox.attentionPage(8)).toHaveLength(0);
    expect(ledger.getObligation(obligation.id)?.state).toBe('waiting');
    advance(300000);
    expect(mailbox.snapshot().items[0]?.state).toBe('needs-gru');
    expect(ledger.getObligation(obligation.id)?.settlement).toBeNull();
  });

  it('G06/G27 receipts immutable captured deliveries after evidence changes, preserving original time and source IDs', () => {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    ledger.registerAgent({ id: 'worker', role: 'minion', jobId: 'j' });
    ledger.recordNotification({ id: 'mailbox:genuine', kind: 'silas.escalated:j', agentId: 'worker', title: 'source', routing: 'action-required', severity: 'error' });
    const rows = mailbox.attentionRows();
    const captured = mailbox.captureDelivery(rows);
    const originalAt = '2026-10-11T00:20:01.000Z';
    ledger.addRound({ jobId: 'j', lenses: ['blind'], targetRef: 'new-head' });
    advance(120000);
    mailbox.receiptCaptured(captured, 'chat', 'accepted', originalAt);
    expect(ledger.listEvents({ limit: 50 }).filter((event) => event.kind === 'mailbox.received')).toHaveLength(1);
    const historical = ledger.listEvents({ limit: 50 }).find((event) => event.kind === 'mailbox.received')!;
    expect(historical.payload).toMatchObject({ id: 'job:j', receipt: { basis: captured[0]!.basis, attentionKey: captured[0]!.attentionKey, receivedAt: originalAt }, delivery: { notificationIds: ['mailbox:genuine'], reasons: captured[0]!.reasons } });
    expect(mailbox.attentionPage(8)).toHaveLength(1);
    expect(mailbox.snapshot().items[0]?.receipt).toBeNull();
    const watermark = ledger.latestEventSeq();
    mailbox.receiptCaptured(JSON.parse(JSON.stringify(captured)), 'chat', 'accepted', originalAt);
    expect(ledger.latestEventSeq()).toBe(watermark);
    const reordered = captured.map(({ deliveryKey, id, jobId, basis, attentionKey, reasons, notificationIds }) => ({
      notificationIds, reasons: reasons.map(({ basis, label, signal }) => ({ basis, label, signal })), attentionKey, basis, jobId, id, deliveryKey,
    }));
    expect(() => mailbox.receiptCaptured(reordered, 'chat', 'accepted', originalAt)).not.toThrow();
    expect(ledger.latestEventSeq()).toBe(watermark);
    expect(ledger.getNotification('mailbox:genuine')?.shownAt).toBeNull();
  });

  it('G27 delayed matching capture uses original acceptance time for the five-minute bound', () => {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    const captured = mailbox.captureDelivery(mailbox.attentionRows());
    advance(240000);
    mailbox.receiptCaptured(captured, 'wake', 'recovered', '2026-10-11T00:20:01.000Z');
    expect(mailbox.snapshot().items[0]?.receipt?.receivedAt).toBe('2026-10-11T00:20:01.000Z');
    expect(mailbox.attentionPage(8)).toHaveLength(0);
    advance(60000);
    expect(mailbox.attentionPage(8)).toHaveLength(1);
    expect(mailbox.attentionPage(8)[0]?.attentionKey).not.toBe(captured[0]?.attentionKey);
  });

  it('G25 retains surfaced owner-decision debt quietly without settlement or new authority', () => assertRetainedDebt({ kind: 'owner-decision', decision: 'owner permission' }));
  it('G25 retains surfaced external-wait debt quietly without settlement or new authority', () => assertRetainedDebt({ kind: 'external-wait', condition: 'provider recovery' }));
  it('G25 retains surfaced silas-mechanical debt quietly without settlement or new authority', () => assertRetainedDebt({ kind: 'silas-mechanical', action: 'register-pr' }));
  function assertRetainedDebt(nextAction: { readonly kind: 'owner-decision'; readonly decision: string } | { readonly kind: 'external-wait'; readonly condition: string } | { readonly kind: 'silas-mechanical'; readonly action: 'register-pr' }): void {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'working');
    const control = ledger.beginDirectiveIntent({ jobId: 'j', directive: 'existing work', holder: 'silas', requestId: 'existing-control' }).record;
    const context = { logicalStep: 'audit' as const, category: { kind: 'unknown' as const }, incidentKey: 'same-live-debt', observedAtSeq: ledger.latestEventSeq() };
    const first = ledger.recordBlockedObservation('j', context);
    expect(mailbox.attentionPage(8).map((item) => item.jobId)).toEqual(['j']);
    const change = ledger.appendCustomEvent({ kind: 'test.obligation-owner-change', jobId: 'j', payload: { nextAction } });
    const transitioned = ledger.recordBlockedObservation('j', { ...context, observedAtSeq: change.seq, nextAction,
      ...(nextAction.kind === 'silas-mechanical' ? { authority: { source: 'accepted-operation' as const, operationId: control.requestId, version: '1' } } : {}) });
    expect(transitioned.id).toBe(first.id);
    expect(transitioned.nextAction).toEqual(nextAction);
    const retained = mailbox.snapshot().items[0]!;
    expect(retained.state).toBe('waiting');
    expect(retained.owner).toBe(nextAction.kind === 'owner-decision' ? 'owner' : nextAction.kind === 'silas-mechanical' ? 'silas' : 'external');
    expect(retained.disposition?.detail).toMatch(/source-derived.*code-only monitoring/);
    expect(retained.disposition?.dependency).toContain(nextAction.kind === 'external-wait' ? nextAction.condition : nextAction.kind === 'owner-decision' ? nextAction.decision : nextAction.action);
    for (let pass = 0; pass < 3; pass++) {
      advance(300000);
      expect(mailbox.attentionPage(8)).toHaveLength(0);
      expect(mailbox.snapshot().items[0]?.state).toBe('waiting');
    }
    expect(ledger.getObligation(first.id)?.settlement).toBeNull();
    expect(ledger.getJob('j')?.status).toBe('working');
    expect(ledger.getDirective(control.requestId)).toEqual(control);
    const returned = ledger.appendCustomEvent({ kind: 'test.gru-debt-restored', jobId: 'j', payload: {} });
    ledger.recordBlockedObservation('j', { ...context, observedAtSeq: returned.seq });
    expect(mailbox.attentionPage(8).map((item) => item.jobId)).toEqual(['j']);
  }

  it('G04 revocation cannot reuse a pre-hold receipt to suppress restored debt', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    const original = mailbox.snapshot().items[0]!;
    mailbox.received(original.id, original.basis, 'chat', 'pre-hold');
    const hold = ledger.recordDecision({ subject: original.subject, decision: 'hold', covers: ['blocked'], reason: 'permission', by: 'owner' });
    mailbox.disposition(original.id, { basis: original.basis, state: 'waiting', owner: 'owner', detail: 'wait', dependency: 'permission', recheckAt: '2026-10-11T00:25:01.000Z', references: [{ kind: 'decision', id: hold.id }] });
    ledger.clearDecision({ id: hold.id, by: 'owner', reason: 'revoked' });
    expect(mailbox.attentionPage(8)).toHaveLength(1);
    expect(mailbox.attentionPage(8)[0]?.attentionKey).not.toBe(original.attentionKey);
  });

  it('G25 rejects forged source provenance and preserves genuine exact-basis waiting rulings', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'working');
    const obligation = ledger.recordBlockedObservation('j', { logicalStep: 'audit', category: { kind: 'unknown' }, incidentKey: 'debt', observedAtSeq: ledger.latestEventSeq() });
    mailbox.snapshot();
    ledger.armReceiptExpectation({ obligationId: obligation.id, receiptKind: 'job.delivered', deadlineAt: '2026-10-11T00:25:01.000Z' });
    const item = mailbox.snapshot().items[0]!;
    const input = { basis: item.basis, state: 'waiting', owner: 'owner', detail: 'genuine permission ruling', dependency: 'owner permission', recheckAt: '2026-10-11T00:30:01.000Z', references: [{ kind: 'obligation', id: obligation.id }] };
    const watermark = ledger.latestEventSeq();
    expect(() => mailbox.disposition(item.id, { ...input, sourceObligationId: obligation.id })).toThrow(/server-owned/);
    expect(ledger.latestEventSeq()).toBe(watermark);
    mailbox.disposition(item.id, input);
    expect(mailbox.snapshot().items[0]?.disposition?.detail).toBe('genuine permission ruling');
    expect(mailbox.snapshot().items[0]?.disposition?.sourceObligationId).toBeUndefined();
    expect(mailbox.snapshot().items[0]?.owner).toBe('owner');
  });

  it('captured-delivery discriminator rejects genuine rows even with identical synthetic id/kind/detail', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    const synthetic = mailbox.attentionRows()[0]!;
    const genuine = ledger.recordNotification({ id: synthetic.id, kind: synthetic.kind, detail: synthetic.detail!, title: 'genuine collision', routing: 'fyi', severity: 'info' });
    expect(mailbox.captureDelivery([genuine])).toEqual([]);
    expect(mailbox.captureDelivery([JSON.parse(JSON.stringify(synthetic))])).toEqual([]);
    expect(mailbox.captureDelivery([synthetic])).toHaveLength(1);
    expect(mailbox.captureRow(genuine)).toBeNull();
    expect(mailbox.captureRow(mailbox.getAttentionRow(synthetic.id)!)).toMatchObject({ deliveryKey: synthetic.id, id: 'job:j' });
  });

  it('G25 explicit owner-dependency recheck restores Gru attention, unlike derived monitoring, without authority changes', () => {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'working');
    const context = { logicalStep: 'audit' as const, category: { kind: 'unknown' as const }, incidentKey: 'permission', observedAtSeq: ledger.latestEventSeq() };
    const debt = ledger.recordBlockedObservation('j', context);
    mailbox.snapshot();
    const change = ledger.appendCustomEvent({ kind: 'test.owner-debt', jobId: 'j', payload: {} });
    ledger.recordBlockedObservation('j', { ...context, observedAtSeq: change.seq, nextAction: { kind: 'owner-decision', decision: 'owner permission to continue' } });
    const item = mailbox.snapshot().items[0]!;
    expect(item.disposition?.sourceObligationId).toBe(debt.id);
    mailbox.disposition(item.id, { basis: item.basis, state: 'waiting', owner: 'owner', detail: 'Gru explicitly owes dependency reevaluation', dependency: 'owner permission to continue', recheckAt: '2026-10-11T00:25:01.000Z', references: [{ kind: 'obligation', id: debt.id }] });
    const before = ledger.getObligation(debt.id);
    advance(300000);
    const due = mailbox.attentionPage(8)[0]!;
    expect(due.state).toBe('needs-gru');
    expect(due.owner).toBe('owner');
    expect(due.disposition?.sourceObligationId).toBeUndefined();
    expect(due.disposition?.detail).toBe('Gru explicitly owes dependency reevaluation');
    expect(ledger.getObligation(debt.id)).toEqual(before);
    expect(ledger.getJob('j')?.status).toBe('working');
    expect(ledger.listPendingDirectives()).toHaveLength(0);
    ledger.setJobStatus('j', 'blocked');
    expect(mailbox.attentionPage(8)[0]?.reasons.map((reason) => reason.signal)).toContain('blocked');
  });

  it('compatible current-key receipt adapter ignores genuine IDs and preserves identical replay time', () => {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    ledger.recordNotification({ id: 'genuine', kind: 'owner.notice', routing: 'needs-owner', title: 'owner', severity: 'info' });
    ledger.recordNotification({ id: 'mailbox:genuine', kind: 'owner.notice', routing: 'needs-owner', title: 'owner prefix', severity: 'info' });
    const key = mailbox.attentionRows()[0]!.id;
    expect(() => mailbox.receiptForKeys(['genuine', 'mailbox:genuine', key], 'chat', 'compatible')).not.toThrow();
    const first = mailbox.snapshot().items[0]?.receipt;
    advance(120000);
    expect(() => mailbox.receiptForKeys([key], 'chat', 'compatible')).not.toThrow();
    expect(mailbox.snapshot().items[0]?.receipt).toEqual(first);
    expect(ledger.getNotification('mailbox:genuine')?.shownAt).toBeNull();
  });

  it('G25 correlated live work cannot replace the actual owner of retained permission debt', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'working');
    ledger.registerAgent({ id: 'writer', role: 'minion', jobId: 'j' });
    ledger.setAgentState('writer', 'streaming');
    const context = { logicalStep: 'audit' as const, category: { kind: 'unknown' as const }, incidentKey: 'permission', observedAtSeq: ledger.latestEventSeq() };
    const debt = ledger.recordBlockedObservation('j', context);
    mailbox.snapshot();
    ledger.armReceiptExpectation({ obligationId: debt.id, receiptKind: 'job.delivered', deadlineAt: '2026-10-11T00:25:01.000Z', correlation: { minionId: 'writer' } });
    expect(mailbox.snapshot().items[0]?.state).toBe('delegated');
    const change = ledger.appendCustomEvent({ kind: 'test.owner-permission', jobId: 'j', payload: {} });
    ledger.recordBlockedObservation('j', { ...context, observedAtSeq: change.seq, nextAction: { kind: 'owner-decision', decision: 'owner permission' } });
    const retained = mailbox.snapshot().items[0]!;
    expect(retained.state).toBe('waiting');
    expect(retained.owner).toBe('owner');
    expect(mailbox.attentionPage(8)).toHaveLength(0);
    expect(ledger.getAgent('writer')?.state).toBe('streaming');
    expect(ledger.getJob('j')?.status).toBe('working');
  });

  it('G15 compatibility receipt keys never mistake an exact genuine collision for synthetic coverage', () => {
    const { ledger, mailbox } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'blocked');
    const row = mailbox.attentionRows()[0]!;
    ledger.recordNotification({ id: row.id, kind: 'owner.notice', routing: 'needs-owner', title: 'genuine collision', severity: 'info' });
    mailbox.receiptForKeys([row.id], 'chat', 'ambiguous-compatibility');
    expect(mailbox.snapshot().items[0]?.receipt).toBeNull();
    expect(ledger.latestEventOfKind('mailbox.received')).toBeNull();
    mailbox.receiptCaptured(mailbox.captureDelivery([row]), 'chat', 'branded-proof', '2026-10-11T00:20:01.000Z');
    expect(mailbox.snapshot().items[0]?.receipt?.deliveryId).toBe('branded-proof');
    expect(ledger.getNotification(row.id)?.ackedAt).toBeNull();
  });

  it('G25 retained owner debt honors an attached explicit Gru decision follow-up, not just monitoring', () => {
    const { ledger, mailbox, advance } = fixture();
    ledger.addJob({ id: 'j', repo: 'r', title: 'j' });
    ledger.setJobStatus('j', 'working');
    const context = { logicalStep: 'audit' as const, category: { kind: 'unknown' as const }, incidentKey: 'permission', observedAtSeq: ledger.latestEventSeq() };
    const debt = ledger.recordBlockedObservation('j', context);
    mailbox.snapshot();
    const change = ledger.appendCustomEvent({ kind: 'test.owner-debt', jobId: 'j', payload: {} });
    ledger.recordBlockedObservation('j', { ...context, observedAtSeq: change.seq, nextAction: { kind: 'owner-decision', decision: 'owner permission' } });
    const retained = mailbox.snapshot().items[0]!;
    const followUp = ledger.recordDecision({ subject: retained.subject, decision: 'hold', covers: ['obligation'], basisFingerprint: retained.basis, reason: 'Gru must reevaluate owner dependency', by: 'gru', recheckAt: '2026-10-11T00:25:01.000Z' });
    expect(mailbox.attentionPage(8)).toHaveLength(0);
    const before = ledger.getObligation(debt.id);
    advance(300000);
    expect(mailbox.attentionPage(8)[0]?.state).toBe('needs-gru');
    expect(mailbox.snapshot().items[0]?.references).toContainEqual({ kind: 'decision', id: followUp.id });
    expect(ledger.getObligation(debt.id)).toEqual(before);
    expect(ledger.getJob('j')?.status).toBe('working');
  });

});
