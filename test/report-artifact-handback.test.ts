import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { reconcileDurableWork } from '../src/dispatch/durable-reconcile.js';
import { admitNativeDirectiveFixture, nativeDirectiveFixtureDeliveryProof } from './helpers/directive-native-fixture.js';

const roots: string[] = [];
const databases: LedgerDb[] = [];
afterAll(() => {
  for (const db of databases) db.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
  readonly api: LedgerApi;
  readonly db: LedgerDb;
  readonly root: string;
  readonly jobId: string;
  readonly requestId: string;
  readonly deliverySeq: number;
  readonly nativeCompletion: ReturnType<typeof nativeDirectiveFixtureDeliveryProof>['native_completion'];
}

function fixture(jobId: string, opts: { readonly dirty?: boolean; readonly candidate?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'gru-report-native-handback-'));
  roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo);
  const git = (args: readonly string[]): string => execFileSync('git', [
    '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', ...args,
  ], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']);
  writeFileSync(join(repo, 'tracked.txt'), 'original report candidate\n');
  git(['add', 'tracked.txt']); git(['commit', '-q', '-m', 'fixture: original report head']);
  const head = git(['rev-parse', 'HEAD']);
  if (opts.dirty === true) writeFileSync(join(repo, 'tracked.txt'), 'dirty tracked report tree\n');

  const db = new LedgerDb(join(root, 'ledger'));
  databases.push(db);
  const api = new LedgerApi(db.handle, { bus: new EventBus() });
  api.addJob({ id: jobId, repo: 'fixture-app', title: 'Report', briefing: 'approved report',
    deliverable: 'investigation', commissioner: 'gru', targetRef: 'https://github.com/example/fixture-app/pull/1', targetSha: head });
  api.setJobStatus(jobId, 'working');
  const requestId = `native-report-${jobId}`;
  api.beginDirectiveIntent({ jobId, requestId, directive: 'return the approved report', holder: 'gru' });
  const nativeFile = join(root, 'native-session.jsonl');
  admitNativeDirectiveFixture(api, requestId, `minion-${jobId}`, nativeFile, { head, cwd: repo });
  const proof = nativeDirectiveFixtureDeliveryProof(api, requestId);
  const delivery = api.appendCustomEvent({ kind: 'job.delivered', jobId, agentId: proof.native_completion.binding.agentId,
    payload: { request_id: requestId, agentId: proof.native_completion.binding.agentId, source: 'silas-directive',
      sha: head, work_revision: api.getDirective(requestId)!.workRevision,
      candidate_delivery_proven: opts.candidate ?? !opts.dirty, native_completion: proof.native_completion } });
  return { api, db, root, jobId, requestId, deliverySeq: delivery.seq, nativeCompletion: proof.native_completion };
}

function settleSeededDirective(f: Fixture, markDelivered = true): void {
  f.api.appendCustomEvent({ kind: 'silas.directive-settled', jobId: f.jobId,
    payload: { request_id: f.requestId, delivery_seq: f.deliverySeq, candidate_delivery_proven: false } });
  f.db.handle.prepare("UPDATE pending_directives SET state = 'settled', delivery_seq = ?, updated_at = ? WHERE request_id = ?")
    .run(f.deliverySeq, new Date().toISOString(), f.requestId);
  if (markDelivered) f.api.setJobStatus(f.jobId, 'delivered');
}

function reconcile(f: Fixture) {
  const notifications = new NotificationCenter({ ledger: f.api, bus: new EventBus() });
  return reconcileDurableWork({ ledger: f.api, notifications });
}

describe('native report artifact handback', () => {
  it('native-report-dirty-code-tree-commissioner-close', () => {
    const f = fixture('dirty-native-report', { dirty: true, candidate: false });
    f.api.recordDirectiveDelivery({ requestId: f.requestId, eventSeq: f.deliverySeq });
    f.api.setJobStatus(f.jobId, 'delivered');
    f.api.addJob({ id: 'downstream-repair', repo: 'fixture-app', title: 'Repair', briefing: 'routed findings' });

    expect(execFileSync('git', ['-C', join(f.root, 'repo'), 'status', '--porcelain'], { encoding: 'utf8' })).toContain('tracked.txt');
    expect(f.api.latestReportHandbackDelivery(f.jobId)?.seq).toBe(f.deliverySeq);
    expect(f.api.findReportObligation(f.jobId)).toMatchObject({ state: 'open', firstOriginSeq: f.deliverySeq });
    expect(f.api.latestCandidateDelivery(f.jobId)).toBeNull();
    expect(f.api.workRevisionState(f.jobId)).toEqual({ required: 0, delivered: 0 });

    const closed = f.api.settleReportDisposition({ jobId: f.jobId, outcome: 'acted', directiveJobId: 'downstream-repair', by: 'gru' });
    expect(closed.job.status).toBe('done');
    expect(closed.obligation.state).toBe('settled');
    expect(f.api.latestJobEvent(f.jobId, 'job.report-disposition')?.payload)
      .toMatchObject({ outcome: 'acted', directive_job_id: 'downstream-repair', obligation_id: closed.obligation.id });
    expect(() => f.api.settleReportDisposition({ jobId: f.jobId, outcome: 'acted', directiveJobId: 'downstream-repair', by: 'gru' }))
      .toThrow(/is done/);
    expect(f.api.listJobEventsByKinds(f.jobId, ['job.report-disposition'])).toHaveLength(1);
  });

  it('report-handback-backstop-once', () => {
    const f = fixture('backstop-native-report', { dirty: true, candidate: false });
    // The exact delivery and settlement survived an older code-gate decision,
    // but its matching handback open was lost. Keep that crash-window state in
    // this fixture rather than backdating or manufacturing a new receipt.
    settleSeededDirective(f, false);
    expect(f.api.getJob(f.jobId)?.status).toBe('working');
    expect(f.api.findReportObligation(f.jobId)).toBeNull();
    expect(f.api.latestReportHandbackDelivery(f.jobId)?.seq).toBe(f.deliverySeq);

    const first = reconcile(f);
    const second = reconcile(f);
    expect(first.reports.opened).toBe(1);
    expect(second.reports.opened).toBe(0);
    expect(f.api.getJob(f.jobId)?.status).toBe('delivered');
    expect(f.api.listObligations({ jobId: f.jobId })).toHaveLength(1);
    const lineage = f.api.listJobEventsByKinds(f.jobId, ['job.report-handback']);
    expect(lineage).toHaveLength(1);
    expect(lineage[0]?.payload).toMatchObject({ delivered_seq: f.deliverySeq });
    expect(f.api.latestCandidateDelivery(f.jobId)).toBeNull();
  });

  it('report-disposition-requires-actual-routed-job', () => {
    const f = fixture('route-required-report', { candidate: true });
    f.api.recordDirectiveDelivery({ requestId: f.requestId, eventSeq: f.deliverySeq });
    f.api.setJobStatus(f.jobId, 'delivered');
    expect(() => f.api.settleReportDisposition({ jobId: f.jobId, outcome: 'acted', by: 'gru' })).toThrow(/requires directive_job_id/);
    f.api.addJob({ id: 'wrong-repo-target', repo: 'other-repo', title: 'Wrong repo', briefing: 'routed findings' });
    expect(() => f.api.settleReportDisposition({ jobId: f.jobId, outcome: 'acted', directiveJobId: 'wrong-repo-target', by: 'gru' }))
      .toThrow(/belongs to repo/);
    expect(f.api.getJob(f.jobId)?.status).toBe('delivered');
    expect(f.api.listJobEventsByKinds(f.jobId, ['job.report-disposition'])).toEqual([]);
  });

  it('report-acceptance-is-not-delivery', () => {
    const f = fixture('accepted-only-report', { candidate: false });
    f.api.setJobStatus(f.jobId, 'delivered');
    expect(f.api.latestReportHandbackDelivery(f.jobId)).toBeNull();
    expect(reconcile(f).reports.opened).toBe(0);
    expect(f.api.findReportObligation(f.jobId)).toBeNull();
    expect(f.api.latestCandidateDelivery(f.jobId)).toBeNull();
  });

  it('mismatched-native-report-proof-refused', () => {
    const f = fixture('mismatched-native-report', { dirty: true, candidate: false });
    const delivery = f.api.getEvent(f.deliverySeq)!;
    const payload = delivery.payload as Record<string, unknown>;
    const native = payload['native_completion'] as Record<string, unknown>;
    const mismatched = { ...native, identity: { ...(native['identity'] as Record<string, unknown>), requestId: 'foreign-request' } };
    const bad = f.api.appendCustomEvent({ kind: 'job.delivered', jobId: f.jobId,
      payload: { ...payload, native_completion: mismatched } });
    f.db.handle.prepare("UPDATE pending_directives SET state = 'settled', delivery_seq = ?, updated_at = ? WHERE request_id = ?")
      .run(bad.seq, new Date().toISOString(), f.requestId);
    f.api.setJobStatus(f.jobId, 'delivered');

    expect(f.api.latestReportHandbackDelivery(f.jobId)).toBeNull();
    expect(reconcile(f).reports.opened).toBe(0);
    expect(f.api.findReportObligation(f.jobId)).toBeNull();
  });

  it('pr-candidate-gates-unchanged', () => {
    const f = fixture('candidate-gates-report', { dirty: true, candidate: false });
    f.api.recordDirectiveDelivery({ requestId: f.requestId, eventSeq: f.deliverySeq });
    f.api.setJobStatus(f.jobId, 'delivered');
    expect(f.api.findReportObligation(f.jobId)).toMatchObject({ state: 'open' });
    expect(f.api.latestCandidateDelivery(f.jobId)).toBeNull();
    expect(f.api.workRevisionState(f.jobId)).toEqual({ required: 0, delivered: 0 });

    f.api.addJob({ id: 'generic-noncandidate-code', repo: 'fixture-app', title: 'Code', briefing: 'code' });
    f.api.setJobStatus('generic-noncandidate-code', 'working');
    f.api.appendCustomEvent({ kind: 'job.delivered', jobId: 'generic-noncandidate-code',
      payload: { sha: 'a'.repeat(40), candidate_delivery_proven: false } });
    f.api.setJobStatus('generic-noncandidate-code', 'delivered');
    expect(f.api.latestCandidateDelivery('generic-noncandidate-code')).toBeNull();
    expect(f.api.latestReportHandbackDelivery('generic-noncandidate-code')).toBeNull();
  });
});
