import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntakeApprovalService, IntakePartialFailure } from '../src/intake/approval.js';
import { IntakeService } from '../src/intake/service.js';
import { createManagedRepoIntakeResolver } from '../src/repos/managed-names.js';
import { resolvedIntakePlan } from './helpers/intake-plan.js';
import { PipelineService } from '../src/dispatch/pipeline.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb, MIGRATIONS } from '../src/ledger/db.js';
import { canonical, digest, type IntakeReviewRecord } from '../src/intake/types.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture(kind: 'issue' | 'spec' | 'bmad' = 'spec') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gc-approval-')));
  const repoPath = join(root, 'workspace', 'demo');
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-q', repoPath]);
  writeFileSync(join(repoPath, 'spec.md'), `${kind === 'bmad' ? '---\nstatus: done\n---\n' : ''}Implement the native capture feature.\nPreserve sources.\n`);
  const db = new LedgerDb(join(root, 'data'));
  const ledger = new LedgerApi(db.handle);
  const dispatch = vi.fn(async (_input: { jobId: string; title: string; briefing: string }) => ({ settled: Promise.resolve() }));
  const capacity = { capacity: 1, occupied: 1, available: 0, queued: 0 };
  const pipeline = new PipelineService({ ledger, dispatch: { dispatch }, capacity: () => capacity });
  const intake = new IntakeService({ dataDir: join(root, 'data'), workspaceRoot: join(root, 'workspace'), uploadsDir: join(root, 'data', 'uploads'), managedRepos: () => [repoPath], remote: () => ({ host: 'github.com', owner: 'owner', repo: 'demo' }), ghRunner: async () => ({ status: 0, stderr: '', stdout: JSON.stringify({ number: 1, html_url: 'https://github.com/owner/demo/issues/1', title: 'Capture', body: 'Implement native capture.', updated_at: '2026-10-10T12:00:00Z' }) }) });
  const approval = new IntakeApprovalService({ intake, ledger, pipeline });
  cleanups.push(() => { pipeline.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const source = kind === 'issue' ? { kind, reference: '#1' } : { kind, document: { path: 'spec.md' } };
  const request = { repoPath, intakeId: 'feature', requestId: 'r1', source };
  const first = await intake.preview(request);
  const proposal = await intake.revise({ repoPath, intakeId: 'feature', requestId: 'r2', previousRequestId: 'r1', revisionId: first.revisionId, plan: resolvedIntakePlan(first) });
  const decision = { repoPath, intakeId: 'feature', requestId: 'r2', revisionId: proposal.revisionId, expectedToken: null };
  const review = approval.review(decision).review!;
  const accept = { ...decision, expectedToken: review.token, selected: proposal.plan.heists.map(({ id }) => id) };
  return { root, repoPath, db, ledger, pipeline, capacity, dispatch, intake, approval, first, proposal, decision, review, accept, request };
}
describe('intake durable recovery integrity', () => {
  it('resolves one managed root for complete review and approval requests', async () => {
    const h = await fixture();
    const nextProposal = await h.intake.revise({
      repoPath: h.repoPath,
      intakeId: 'feature',
      requestId: 'r3',
      previousRequestId: 'r2',
      revisionId: h.proposal.revisionId,
      plan: h.proposal.plan,
    });
    let resolutions = 0;
    const resolveManagedRepo = createManagedRepoIntakeResolver(join(h.root, 'workspace'), ['demo']);
    const guardedIntake = new IntakeService({
      dataDir: join(h.root, 'data'),
      workspaceRoot: join(h.root, 'workspace'),
      uploadsDir: join(h.root, 'data', 'uploads'),
      managedRepos: (requestedPath) => {
        resolutions += 1;
        return resolveManagedRepo(requestedPath);
      },
    });
    const guardedApproval = new IntakeApprovalService({ intake: guardedIntake, ledger: h.ledger, pipeline: h.pipeline });
    const reviewed = guardedApproval.review({
      repoPath: h.repoPath,
      intakeId: 'feature',
      requestId: nextProposal.requestId,
      revisionId: nextProposal.revisionId,
      expectedToken: h.review.token,
    });
    expect(reviewed.review?.status).toBe('reviewed');
    expect(resolutions).toBe(1);

    resolutions = 0;
    const approved = guardedApproval.approve({
      repoPath: h.repoPath,
      intakeId: 'feature',
      requestId: nextProposal.requestId,
      revisionId: nextProposal.revisionId,
      expectedToken: reviewed.review!.token,
      selected: nextProposal.plan.heists.map(({ id }) => id),
    });
    expect(approved.review?.status).toBe('approved');
    expect(resolutions).toBe(1);
    await h.pipeline.whenIdle();
  });

  const missingCommittedRow = async (proof: 'job' | 'enqueue event'): Promise<void> => {
    const h = await fixture();
    const accepted = h.approval.approve(h.accept);
    const entry = accepted.review!.entries[0]!;
    h.db.handle.prepare('DELETE FROM pipeline_entries WHERE id = ?').run(entry.id);
    if (proof === 'job') {
      h.db.handle.prepare("DELETE FROM events WHERE kind = 'pipeline.enqueued'").run();
      h.ledger.addJob({ id: entry.id, repo: 'demo', title: entry.title, briefing: entry.briefing });
    }
    const events = h.ledger.listEvents();
    for (const operation of [() => h.approval.read(h.repoPath, 'feature', accepted.review!.token), () => h.approval.approve(h.accept)]) {
      let failure: unknown;
      try { operation(); } catch (error) { failure = error; }
      expect(failure).toMatchObject({ code: 'intake_acceptance_conflict', message: expect.stringMatching(/restore.*ledger/iu) });
    }
    expect(h.ledger.listPipelineEntries()).toEqual([]);
    expect(h.ledger.getIntakeReview(h.repoPath, 'feature')).toEqual(accepted.review);
    expect(h.ledger.listEvents()).toEqual(events);
    expect(h.dispatch).not.toHaveBeenCalled();
  };
  it('refuses a missing committed pipeline row proven by job without recreating it', () => missingCommittedRow('job'));
  it('refuses a missing committed pipeline row proven by enqueue event without recreating it', () => missingCommittedRow('enqueue event'));

  it('upgrades retained v26 history and uses intake/committed-enqueue indexes without rewriting records', async () => {
    const h = await fixture();
    const dir = join(h.root, 'old-ledger');
    const old = new LedgerDb(dir, { migrations: MIGRATIONS.slice(0, MIGRATIONS.findIndex(({ name }) => name === 'intake-recovery-query-indexes')) });
    const oldApi = new LedgerApi(old.handle);
    oldApi.recordIntakeReview(h.review);
    oldApi.enqueuePipelineEntry({ id: 'legacy-accepted', repoPath: h.repoPath, title: 'Legacy accepted', briefing: 'Immutable legacy bytes' });
    const records = old.handle.prepare('SELECT * FROM intake_reviews ORDER BY token').all();
    const events = old.handle.prepare('SELECT * FROM events ORDER BY seq').all();
    old.close();
    const upgraded = new LedgerDb(dir);
    try {
      expect(upgraded.handle.prepare('SELECT * FROM intake_reviews ORDER BY token').all()).toEqual(records);
      expect(upgraded.handle.prepare('SELECT * FROM events ORDER BY seq').all()).toEqual(events);
      const historyPlan = upgraded.handle.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(record AS BLOB))), 0) AS bytes FROM intake_reviews WHERE repo_path = ? AND intake_id = ?').all(h.repoPath, 'feature');
      expect(historyPlan.map((row) => String(row.detail)).join('\n')).toContain('idx_intake_reviews_scope');
      const enqueuePlan = upgraded.handle.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM events WHERE kind = 'pipeline.enqueued' AND json_valid(payload) AND json_extract(payload, '$.entry_id') = ? LIMIT 1").all('legacy-accepted');
      expect(enqueuePlan.map((row) => String(row.detail)).join('\n')).toContain('idx_pipeline_enqueued_entry');
      expect(new LedgerApi(upgraded.handle).getIntakeReview(h.repoPath, 'feature')).toEqual(h.review);
    } finally { upgraded.close(); }
  });

  const midwriteRollback = async (boundary: 'head' | 'event'): Promise<void> => {
    const h = await fixture();
    const proposal = await h.intake.preview({ ...h.request, intakeId: 'rollback', requestId: 'new-review' });
    const decision = { repoPath: h.repoPath, intakeId: proposal.intakeId, requestId: proposal.requestId, revisionId: proposal.revisionId, expectedToken: null };
    const before = { decisions: h.db.handle.prepare('SELECT * FROM intake_reviews ORDER BY token').all(), heads: h.db.handle.prepare('SELECT * FROM intake_review_heads ORDER BY intake_id').all(), events: h.ledger.listEvents() };
    h.db.handle.exec(boundary === 'head'
      ? "CREATE TRIGGER intake_midwrite BEFORE INSERT ON intake_review_heads BEGIN SELECT RAISE(ABORT, 'injected mid-write failure'); END"
      : "CREATE TRIGGER intake_midwrite BEFORE INSERT ON events WHEN NEW.kind = 'intake.reviewed' BEGIN SELECT RAISE(ABORT, 'injected mid-write failure'); END");
    expect(() => h.approval.review(decision)).toThrow('injected mid-write failure');
    expect(h.db.handle.prepare('SELECT * FROM intake_reviews ORDER BY token').all()).toEqual(before.decisions);
    expect(h.db.handle.prepare('SELECT * FROM intake_review_heads ORDER BY intake_id').all()).toEqual(before.heads);
    expect(h.ledger.listEvents()).toEqual(before.events);
    expect(h.ledger.getIntakeReview(h.repoPath, 'rollback')).toBeNull();
    h.db.handle.exec('DROP TRIGGER intake_midwrite');
    const retried = h.approval.review(decision);
    expect(h.ledger.getIntakeReview(h.repoPath, 'rollback')).toEqual(retried.review);
    expect(h.approval.review(decision)).toEqual(retried);
    expect(h.ledger.listEvents()).toHaveLength(before.events.length + 1);
    expect(h.ledger.listPipelineEntries()).toEqual([]);
    expect(h.dispatch).not.toHaveBeenCalled();
  };
  it('rolls back a real mid-write head failure and permits the identical review retry', () => midwriteRollback('head'));
  it('rolls back a real mid-write event failure and permits the identical review retry', () => midwriteRollback('event'));
});

describe('intake exact explicit acceptance', () => {
  const checkSource = async (kind: 'issue' | 'spec' | 'bmad'): Promise<void> => {
    const h = await fixture(kind);
    expect(h.ledger.listPipelineEntries()).toEqual([]);
    expect(h.ledger.listJobs()).toEqual([]);
    expect(h.dispatch).not.toHaveBeenCalled();
    const accepted = h.approval.approve(h.accept);
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.remaining).toEqual([]);
    const entry = h.ledger.listPipelineEntries()[0]!;
    const contract = JSON.parse(entry.briefing) as { heist: unknown; provenance: { snapshots: unknown } };
    expect(contract.heist).toEqual(h.proposal.plan.heists[0]);
    expect(contract.provenance.snapshots).toEqual(h.proposal.snapshots);
    expect(h.approval.approve(h.accept)).toEqual(accepted);
    expect(h.ledger.listPipelineEntries()).toHaveLength(1);
    expect(h.dispatch).not.toHaveBeenCalled();
  };
  it('previews and revises issues with zero work, then freezes the approved briefing', () => checkSource('issue'));
  it('previews and revises specs with zero work, then freezes the approved briefing', () => checkSource('spec'));
  it('previews and revises BMAD with zero work, then freezes the approved briefing', () => checkSource('bmad'));
  it('does not mistake cleared conservative questions for a concrete plan', async () => {
    const h = await fixture();
    const plan = { ...h.first.plan, questions: [], heists: h.first.plan.heists.map((heist) => ({ ...heist, unresolvedQuestions: [] })) };
    const p = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', revisionId: h.first.revisionId, requestId: 'incomplete', previousRequestId: 'r1', plan });
    const d = { ...h.decision, requestId: p.requestId, revisionId: p.revisionId, expectedToken: h.review.token };
    const reviewed = h.approval.review(d).review!;
    expect(() => h.approval.approve({ ...d, expectedToken: reviewed.token, selected: ['heist-1'] })).toThrow(/concrete/);
    expect(h.ledger.listPipelineEntries()).toEqual([]);
  });
  it('rejects changed revision bytes, unrelated acknowledgements and rejected/stale approvals', async () => {
    const h = await fixture();
    expect(() => h.approval.approve({ ...h.accept, revisionId: 'a'.repeat(64) })).toThrow(/bytes changed/);
    expect(() => h.approval.approve({ ...h.accept, approved: true })).toThrow(/unsupported/);
    const rejected = h.approval.reject({ ...h.decision, expectedToken: h.review.token });
    expect(rejected.review?.status).toBe('rejected');
    expect(() => h.approval.approve(h.accept)).toThrow(/changed or was rejected/);
    expect(() => h.approval.review({ ...h.decision, expectedToken: rejected.review!.token })).toThrow(/cannot be reopened/);
    expect(h.ledger.listPipelineEntries()).toEqual([]);
  });
  it('freezes stable identities before effects and names interrupted remaining work across a new service instance', async () => {
    const h = await fixture();
    const heist = h.proposal.plan.heists[0]!;
    const p = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', requestId: 'split', previousRequestId: 'r2', revisionId: h.proposal.revisionId, plan: { ...h.proposal.plan, heists: [{ ...heist, id: 'first' }, { ...heist, id: 'second', dependencies: [{ text: 'Wait for delivery of first.', traces: [], clarification: true, id: 'first', milestone: 'delivered' }] }] } });
    const d = { ...h.decision, requestId: p.requestId, revisionId: p.revisionId, expectedToken: h.review.token };
    const review = h.approval.review(d).review!;
    expect(() => h.approval.approve({ ...d, expectedToken: review.token, selected: ['second'] })).toThrow(/Select prerequisite/);
    const accept = { ...d, expectedToken: review.token, selected: ['second', 'first'] };
    const enqueue = h.pipeline.enqueue.bind(h.pipeline);
    const spy = vi.spyOn(h.pipeline, 'enqueue').mockImplementationOnce(enqueue).mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    let interrupted: IntakePartialFailure | undefined;
    try { h.approval.approve(accept); } catch (error) { interrupted = error as IntakePartialFailure; }
    expect(interrupted).toBeInstanceOf(IntakePartialFailure);
    expect(interrupted!.readback.accepted).toHaveLength(1);
    expect(interrupted!.readback.remaining).toHaveLength(1);
    const frozen = interrupted!.readback.review!;
    expect(h.ledger.listPipelineEntries()).toHaveLength(1);
    spy.mockRestore();
    const oldHandle = h.db.handle;
    h.pipeline.dispose(); h.db.close();
    const reopened = new LedgerDb(join(h.root, 'data'));
    const ledger = new LedgerApi(reopened.handle);
    const dispatch = vi.fn(async (input: { jobId: string; title: string; briefing: string }) => {
      ledger.addJob({ id: input.jobId, repo: 'demo', title: input.title, briefing: input.briefing });
      ledger.appendCustomEvent({ kind: 'job.minion-spawned', jobId: input.jobId, payload: {} });
      return { settled: Promise.resolve() };
    });
    const pipeline = new PipelineService({ ledger, dispatch: { dispatch }, capacity: () => h.capacity });
    cleanups.unshift(() => { pipeline.dispose(); reopened.close(); });
    expect(reopened.handle !== oldHandle).toBe(true);
    const recovered = new IntakeApprovalService({ intake: h.intake, ledger, pipeline });
    expect(recovered.read(h.repoPath, 'feature')).toEqual(interrupted!.readback);
    const completed = recovered.approve(accept);
    expect(completed.review?.token).toBe(frozen.token);
    expect(completed.remaining).toEqual([]);
    expect(ledger.listPipelineEntries()).toHaveLength(2);
    expect(ledger.listPipelineEntries()[1]!.prerequisites).toEqual([{ id: frozen.entries[0]!.id, milestone: 'delivered' }]);
    expect(() => recovered.approve({ ...accept, selected: ['first'] })).toThrow(/changed|immutable/);
    expect(dispatch).not.toHaveBeenCalled();
    h.capacity.available = 1; h.capacity.occupied = 0;
    pipeline.schedule(); await pipeline.whenIdle();
    expect(dispatch).toHaveBeenCalledTimes(1);
    ledger.setJobStatus(frozen.entries[0]!.id, 'working'); ledger.setJobStatus(frozen.entries[0]!.id, 'in-review');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: frozen.entries[0]!.id, payload: {} });
    pipeline.schedule(); await pipeline.whenIdle();
    recovered.approve(accept); await pipeline.whenIdle();
    expect(dispatch.mock.calls.map(([input]) => input.jobId)).toEqual(frozen.entries.map(({ id }) => id));
    expect(ledger.listJobs()).toHaveLength(2);
  });
  it('uses GC delivery evidence alone to release selected prerequisites despite imported done status', async () => {
    const h = await fixture('bmad');
    expect(h.first.snapshots[0]!.identifiers['status']).toBe('done');
    const base = h.proposal.plan.heists[0]!;
    const p = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', requestId: 'ordered', previousRequestId: 'r2', revisionId: h.proposal.revisionId, plan: { ...h.proposal.plan, heists: [{ ...base, id: 'first' }, { ...base, id: 'second', dependencies: [{ text: 'Wait for first delivery.', traces: [], clarification: true, id: 'first', milestone: 'delivered' }] }] } });
    const d = { ...h.decision, requestId: p.requestId, revisionId: p.revisionId, expectedToken: h.review.token };
    const reviewed = h.approval.review(d).review!;
    const result = h.approval.approve({ ...d, expectedToken: reviewed.token, selected: ['first', 'second'] });
    await h.pipeline.whenIdle();
    const [first, second] = result.review!.entries;
    expect(h.pipeline.view().entries.find(({ id }) => id === second!.id)?.reason).toContain('delivered');
    h.dispatch.mockImplementation(async (input: { jobId: string; title: string; briefing: string }) => {
      h.ledger.addJob({ id: input.jobId, repo: 'demo', title: input.title, briefing: input.briefing });
      h.ledger.appendCustomEvent({ kind: 'job.minion-spawned', jobId: input.jobId, payload: {} });
      return { settled: Promise.resolve() };
    });
    h.capacity.available = 1; h.capacity.occupied = 0;
    h.pipeline.schedule(); await h.pipeline.whenIdle();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    h.ledger.setJobStatus(first!.id, 'working'); h.ledger.setJobStatus(first!.id, 'in-review');
    h.pipeline.schedule(); await h.pipeline.whenIdle();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: first!.id, payload: {} });
    h.pipeline.schedule(); await h.pipeline.whenIdle();
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
  it('keeps captured edits and accepted contracts immutable after source refresh or foreign BMAD', async () => {
    const h = await fixture();
    h.approval.approve(h.accept);
    const entry = h.ledger.listPipelineEntries()[0]!;
    writeFileSync(join(h.repoPath, 'spec.md'), 'A different feature.\n');
    mkdirSync(join(h.repoPath, '_bmad'));
    writeFileSync(join(h.repoPath, '_bmad', 'runtime.json'), 'incompatible ambient bytes');
    const edited = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', requestId: 'r3', previousRequestId: 'r2', revisionId: h.proposal.revisionId, plan: h.proposal.plan });
    expect(edited.snapshots).toEqual(h.proposal.snapshots);
    const refreshed = await h.intake.preview({ ...h.request, requestId: 'refresh' });
    expect(refreshed.snapshots).not.toEqual(h.proposal.snapshots);
    expect(h.approval.approve(h.accept).accepted).toHaveLength(1);
    expect(h.ledger.listPipelineEntries()[0]).toEqual(entry);
    expect(readFileSync(join(h.repoPath, '_bmad', 'runtime.json'), 'utf8')).toBe('incompatible ambient bytes');
  });
  it('fails loud on damaged approval metadata and damaged proposal storage without more effects', async () => {
    const h = await fixture();
    const approved = h.approval.approve(h.accept).review!;
    h.db.handle.prepare('UPDATE intake_reviews SET record = ? WHERE token = ?').run('{}', approved.token);
    expect(() => h.approval.read(h.repoPath, 'feature')).toThrow(/Cannot verify/);
    expect(() => h.approval.approve(h.accept)).toThrow(/Cannot verify/);
    expect(h.ledger.listPipelineEntries()).toHaveLength(1);
  });
});

describe('intake append-only coordination guards', () => {
  it('never reopens rejected A after reviewing B, while harmless historical replay remains readable', async () => {
    const h = await fixture();
    const rejected = h.approval.reject({ ...h.decision, expectedToken: h.review.token }).review!;
    const b = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', requestId: 'b', previousRequestId: h.proposal.requestId, revisionId: h.proposal.revisionId, plan: h.proposal.plan });
    const reviewedB = h.approval.review({ ...h.decision, requestId: b.requestId, revisionId: b.revisionId, expectedToken: rejected.token }).review!;
    expect(h.approval.review(h.decision).review).toEqual(h.review);
    expect(h.approval.read(h.repoPath, 'feature').review).toEqual(reviewedB);
    expect(() => h.approval.review({ ...h.decision, expectedToken: reviewedB.token })).toThrow(/cannot be reopened/);
    expect(() => h.approval.approve({ ...h.accept, expectedToken: reviewedB.token })).toThrow(/cannot be reopened/);
    expect(() => h.approval.approve(h.accept)).toThrow(/changed or was rejected/);
    expect(h.ledger.listPipelineEntries()).toEqual([]);
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('fails tokenless read, review and approval after head deletion without erasing historical readback', async () => {
    const h = await fixture();
    const accepted = h.approval.approve(h.accept);
    h.db.handle.prepare('DELETE FROM intake_review_heads WHERE repo_path = ? AND intake_id = ?').run(h.repoPath, 'feature');
    expect(h.approval.read(h.repoPath, 'feature', accepted.review!.token)).toEqual(accepted);
    for (const operation of [() => h.approval.read(h.repoPath, 'feature'), () => h.approval.review(h.decision), () => h.approval.approve(h.accept)]) {
      expect(operation).toThrowError(expect.objectContaining({ code: 'intake_storage_error' }));
    }
    expect(h.db.handle.prepare('SELECT * FROM intake_review_heads').all()).toEqual([]);
    expect(h.ledger.listPipelineEntries()).toHaveLength(1);
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('accepts concrete Confirm/Specify/Clarify statements, not conservative placeholders', async () => {
    const h = await fixture();
    const base = h.proposal.plan.heists[0]!;
    const p = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', requestId: 'concrete-verbs', previousRequestId: h.proposal.requestId, revisionId: h.proposal.revisionId, plan: { ...h.proposal.plan, heists: [{ ...base, goal: { text: 'Confirm GET /health returns HTTP 200', traces: [], clarification: true }, verification: [{ text: 'Specify curl --fail http://localhost/health as the HTTP 200 assertion.', traces: [], clarification: true }], splitMergeRationale: { text: 'Clarify the GET /health contract in one independently tested change.', traces: [], clarification: true } }] } });
    const d = { ...h.decision, requestId: p.requestId, revisionId: p.revisionId, expectedToken: h.review.token };
    const review = h.approval.review(d).review!;
    expect(h.approval.approve({ ...d, expectedToken: review.token, selected: [base.id] }).accepted).toHaveLength(1);
    expect(h.ledger.listPipelineEntries()).toHaveLength(1);
  });
});

it('refuses missing rejection ancestry beneath a valid B head before reopening or approval', async () => {
  const h = await fixture();
  const rejected = h.approval.reject({ ...h.decision, expectedToken: h.review.token }).review!;
  const b = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', requestId: 'ancestor-b', previousRequestId: h.proposal.requestId, revisionId: h.proposal.revisionId, plan: h.proposal.plan });
  const reviewB = h.approval.review({ ...h.decision, requestId: b.requestId, revisionId: b.revisionId, expectedToken: rejected.token }).review!;
  h.db.handle.prepare('DELETE FROM intake_reviews WHERE token = ?').run(rejected.token);
  for (const operation of [() => h.approval.read(h.repoPath, 'feature'), () => h.approval.read(h.repoPath, 'feature', reviewB.token), () => h.approval.review({ ...h.decision, expectedToken: reviewB.token }), () => h.approval.approve({ ...h.accept, expectedToken: reviewB.token })]) expect(operation).toThrowError(expect.objectContaining({ code: 'intake_storage_error' }));
  expect(h.approval.read(h.repoPath, 'feature', h.review.token).review).toEqual(h.review);
  expect(h.ledger.listPipelineEntries()).toEqual([]); expect(h.dispatch).not.toHaveBeenCalled();
});

it('rejects corrupt, wrong-bound and cyclic predecessor bytes beneath individually valid decisions', async () => {
  const h = await fixture();
  const accepted = h.approval.approve(h.accept);
  for (const ancestor of [{ ...h.review, repoPath: '/different/repository' }, { ...h.review, previousToken: h.review.token }, { ...h.review, token: 'f'.repeat(64) }]) {
    h.db.handle.prepare('UPDATE intake_reviews SET record = ? WHERE token = ?').run(JSON.stringify(ancestor), h.review.token);
    expect(() => h.approval.read(h.repoPath, 'feature', accepted.review!.token)).toThrowError(expect.objectContaining({ code: 'intake_storage_error' }));
    expect(() => h.approval.approve(h.accept)).toThrowError(expect.objectContaining({ code: 'intake_storage_error' }));
  }
  expect(h.ledger.listPipelineEntries()).toHaveLength(1);
});

it('normalizes trivial whitespace in conservative placeholders before refusing execution', async () => {
  const h = await fixture();
  const mutate = <T extends { readonly text: string }>(statement: T): T => ({ ...statement, text: ` \n${statement.text.replace(/ /gu, '  ')}\t ` });
  const plan = { ...h.first.plan, questions: [], heists: h.first.plan.heists.map((heist) => ({ ...heist, unresolvedQuestions: [], goal: mutate(heist.goal), scope: heist.scope.map(mutate), exclusions: heist.exclusions.map(mutate), acceptance: heist.acceptance.map(mutate), verification: heist.verification.map(mutate), splitMergeRationale: mutate(heist.splitMergeRationale) })) };
  const p = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', requestId: 'whitespace', previousRequestId: h.first.requestId, revisionId: h.first.revisionId, plan });
  const d = { ...h.decision, requestId: p.requestId, revisionId: p.revisionId, expectedToken: h.review.token };
  const reviewed = h.approval.review(d).review!;
  expect(() => h.approval.approve({ ...d, expectedToken: reviewed.token, selected: p.plan.heists.map(({ id }) => id) })).toThrowError(expect.objectContaining({ code: 'intake_incomplete_plan' }));
  expect(h.ledger.listPipelineEntries()).toEqual([]); expect(h.dispatch).not.toHaveBeenCalled();
});

it('refuses bounded large multi-heist standalone provenance before authority or effects', async () => {
  const h = await fixture();
  writeFileSync(join(h.repoPath, 'spec.md'), `Implement bounded capture ${'with exact source data '.repeat(400)}.\n`);
  const first = await h.intake.preview({ ...h.request, requestId: 'large-source' });
  const plan = resolvedIntakePlan(first), base = plan.heists[0]!;
  const p = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', requestId: 'large-plan', previousRequestId: first.requestId, revisionId: first.revisionId, plan: { ...plan, heists: Array.from({ length: 64 }, (_, index) => ({ ...base, id: `part-${index}` })) } });
  const d = { ...h.decision, requestId: p.requestId, revisionId: p.revisionId, expectedToken: h.review.token };
  const reviewed = h.approval.review(d).review!;
  const constructed = new Set<string>();
  const instrumented = { ...p, plan: { ...p.plan, heists: p.plan.heists.map((heist) => ({ ...heist, get title() { constructed.add(heist.id); return heist.title; } })) } };
  const originalScope = h.intake.createRequestScope.bind(h.intake);
  const createRequestScope = vi.spyOn(h.intake, 'createRequestScope');
  createRequestScope.mockImplementation((repoPath, intakeId) => {
    const request = originalScope(repoPath, intakeId);
    return { ...request, read: (requestId) => requestId === p.requestId ? instrumented : request.read(requestId) };
  });
  try {
    expect(() => h.approval.approve({ ...d, expectedToken: reviewed.token, selected: p.plan.heists.map(({ id }) => id) })).toThrowError(expect.objectContaining({ code: 'intake_output_bounds' }));
    expect(constructed.size).toBeGreaterThan(0); expect(constructed.size).toBeLessThan(p.plan.heists.length);
  } finally {
    createRequestScope.mockRestore();
  }
  expect(h.approval.read(h.repoPath, 'feature').review).toEqual(reviewed);
  expect(h.ledger.listPipelineEntries()).toEqual([]); expect(h.dispatch).not.toHaveBeenCalled();
});

it('retains a freeze with no committed enqueue after actual ledger reopen', async () => {
  const h = await fixture();
  const spy = vi.spyOn(h.pipeline, 'enqueue').mockImplementationOnce(() => { throw new Error('before enqueue'); });
  let failure!: IntakePartialFailure;
  try { h.approval.approve(h.accept); } catch (error) { failure = error as IntakePartialFailure; }
  spy.mockRestore(); expect(failure.readback.accepted).toEqual([]);
  h.pipeline.dispose(); h.db.close();
  const db = new LedgerDb(join(h.root, 'data')), ledger = new LedgerApi(db.handle);
  const pipeline = new PipelineService({ ledger, dispatch: { dispatch: h.dispatch }, capacity: () => h.capacity });
  cleanups.unshift(() => { pipeline.dispose(); db.close(); });
  const recovered = new IntakeApprovalService({ intake: h.intake, ledger, pipeline });
  expect(recovered.read(h.repoPath, 'feature')).toEqual(failure.readback);
  expect(ledger.listPipelineEntries()).toEqual([]);
  expect(recovered.approve(h.accept).review).toEqual(failure.readback.review);
  expect(ledger.listPipelineEntries()).toHaveLength(1);
  expect(recovered.approve(h.accept).remaining).toEqual([]);
  expect(ledger.listPipelineEntries()).toHaveLength(1);
});

it('refuses otherwise concrete plan-level unanswered questions without recording approval', async () => {
  const h = await fixture();
  const p = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', requestId: 'plan-question', previousRequestId: h.proposal.requestId, revisionId: h.proposal.revisionId, plan: { ...h.proposal.plan, questions: ['Which deployment is in scope?'] } });
  expect(p.plan.heists[0]!.unresolvedQuestions).toEqual([]);
  const d = { ...h.decision, requestId: p.requestId, revisionId: p.revisionId, expectedToken: h.review.token };
  const reviewed = h.approval.review(d).review!;
  expect(() => h.approval.approve({ ...d, expectedToken: reviewed.token, selected: ['heist-1'] })).toThrowError(expect.objectContaining({ code: 'intake_incomplete_plan' }));
  expect(h.approval.read(h.repoPath, 'feature').review).toEqual(reviewed);
  expect(h.ledger.listPipelineEntries()).toEqual([]);
});

it('refuses current/historical recovery and original retry of a drifted accepted pipeline briefing', async () => {
  const h = await fixture(); const accepted = h.approval.approve(h.accept);
  h.db.handle.prepare('UPDATE pipeline_entries SET briefing = ? WHERE id = ?').run('different accepted bytes', accepted.accepted[0]!.entryId);
  for (const operation of [() => h.approval.read(h.repoPath, 'feature'), () => h.approval.read(h.repoPath, 'feature', accepted.review!.token), () => h.approval.approve(h.accept)]) expect(operation).toThrowError(expect.objectContaining({ code: 'intake_acceptance_conflict' }));
  expect(h.ledger.listPipelineEntries()).toHaveLength(1); expect(h.dispatch).not.toHaveBeenCalled();
});

it('refuses case and terminal punctuation mutations of known conservative defaults', async () => {
  const h = await fixture();
  const mutate = <T extends { readonly text: string }>(s: T): T => ({ ...s, text: `${s.text.toUpperCase()}...?!` });
  const plan = { ...h.first.plan, questions: [], heists: h.first.plan.heists.map((heist) => ({ ...heist, unresolvedQuestions: [], goal: mutate(heist.goal), scope: heist.scope.map(mutate), exclusions: heist.exclusions.map(mutate), acceptance: heist.acceptance.map(mutate), verification: heist.verification.map(mutate), splitMergeRationale: mutate(heist.splitMergeRationale) })) };
  const p = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', requestId: 'cosmetic', previousRequestId: h.first.requestId, revisionId: h.first.revisionId, plan });
  const d = { ...h.decision, requestId: p.requestId, revisionId: p.revisionId, expectedToken: h.review.token };
  const reviewed = h.approval.review(d).review!;
  expect(() => h.approval.approve({ ...d, expectedToken: reviewed.token, selected: ['heist-1'] })).toThrowError(expect.objectContaining({ code: 'intake_incomplete_plan' }));
  expect(h.approval.read(h.repoPath, 'feature').review).toEqual(reviewed);
  expect(h.ledger.listPipelineEntries()).toEqual([]);
});

it('verifies every immutable acceptance field without freezing owner holds or lifecycle', async () => {
  const h = await fixture(); const accepted = h.approval.approve(h.accept);
  const id = accepted.accepted[0]!.entryId;
  h.db.handle.prepare("UPDATE pipeline_entries SET hold_reason = 'Owner pause', state = 'cancelled' WHERE id = ?").run(id);
  expect(h.approval.read(h.repoPath, 'feature').accepted[0]!.state).toBe('cancelled');
  expect(h.approval.approve(h.accept).accepted[0]!.state).toBe('cancelled');
  const mutations = [['priority', 9, 5], ['exclusive_scopes', '["private-lock"]', '[]'], ['repo', 'foreign', 'demo'], ['briefing_hash', 'bad', h.ledger.getPipelineEntry(id)!.briefingHash], ['payload_hash', 'bad', h.ledger.getPipelineEntry(id)!.payloadHash]] as const;
  for (const [field, changed, original] of mutations) {
    h.db.handle.prepare(`UPDATE pipeline_entries SET ${field} = ? WHERE id = ?`).run(changed, id);
    for (const operation of [() => h.approval.read(h.repoPath, 'feature'), () => h.approval.read(h.repoPath, 'feature', accepted.review!.token), () => h.approval.approve(h.accept)]) expect(operation).toThrowError(expect.objectContaining({ code: 'intake_acceptance_conflict' }));
    h.db.handle.prepare(`UPDATE pipeline_entries SET ${field} = ? WHERE id = ?`).run(original, id);
  }
  expect(h.ledger.listPipelineEntries()).toHaveLength(1);
});

it('refuses aggregate over-budget history before parsing any record and retains history', async () => {
  const h = await fixture();
  const huge = 'x'.repeat(1024 * 1024);
  const insert = h.db.handle.prepare('INSERT INTO intake_reviews(token, repo_path, intake_id, revision_id, status, record) VALUES (?, ?, ?, ?, ?, ?)');
  for (let index = 0; index < 9; index += 1) insert.run(index.toString(16).padStart(64, '0'), h.repoPath, 'feature', h.proposal.revisionId, 'reviewed', huge);
  const parse = vi.spyOn(JSON, 'parse');
  for (const operation of [() => h.ledger.getIntakeReview(h.repoPath, 'feature'), () => h.ledger.getIntakeReview(h.repoPath, 'feature', h.review.token), () => h.ledger.recordIntakeReview(h.review)]) expect(operation).toThrowError(expect.objectContaining({ code: 'intake_storage_error', message: expect.stringContaining('byte verification bound') }));
  expect(parse).not.toHaveBeenCalled(); parse.mockRestore();
  expect(h.db.handle.prepare('SELECT COUNT(*) AS count FROM intake_reviews').get()).toEqual({ count: 10 });
  expect(h.ledger.listPipelineEntries()).toEqual([]);
});

it('refuses selected-heist questions as the only unresolved material with unchanged head', async () => {
  const h = await fixture();
  const p = await h.intake.revise({ repoPath: h.repoPath, intakeId: 'feature', revisionId: h.proposal.revisionId, requestId: 'heist-question', previousRequestId: h.proposal.requestId, plan: { ...h.proposal.plan, heists: h.proposal.plan.heists.map((heist) => ({ ...heist, unresolvedQuestions: ['Which HTTP status is required?'] })) } });
  expect(p.gaps).toEqual([]); expect(p.plan.questions).toEqual([]); expect(p.plan.unmapped).toEqual([]);
  const d = { ...h.decision, requestId: p.requestId, revisionId: p.revisionId, expectedToken: h.review.token };
  const reviewed = h.approval.review(d).review!;
  expect(() => h.approval.approve({ ...d, expectedToken: reviewed.token, selected: ['heist-1'] })).toThrowError(expect.objectContaining({ code: 'intake_incomplete_plan' }));
  expect(h.approval.read(h.repoPath, 'feature').review).toEqual(reviewed); expect(h.ledger.listPipelineEntries()).toEqual([]);
});

it('refuses over-budget decision work before parsing and retains every historical row', async () => {
  const h = await fixture();
  const insert = h.db.handle.prepare('INSERT INTO intake_reviews(token, repo_path, intake_id, revision_id, status, record) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 4096; i += 1) insert.run(i.toString(16).padStart(64, '0'), h.repoPath, 'feature', h.proposal.revisionId, 'reviewed', '{}');
  const parse = vi.spyOn(JSON, 'parse');
  expect(() => h.ledger.getIntakeReview(h.repoPath, 'feature')).toThrowError(expect.objectContaining({ code: 'intake_storage_error', message: expect.stringContaining('4096-decision verification bound') }));
  expect(parse).not.toHaveBeenCalled(); parse.mockRestore();
  expect(h.db.handle.prepare('SELECT COUNT(*) AS count FROM intake_reviews').get()).toEqual({ count: 4097 }); expect(h.ledger.listPipelineEntries()).toEqual([]);
});

it('refuses a prospective aggregate history overflow atomically while the existing chain stays readable', async () => {
  const h = await fixture();
  let head = h.review;
  const freeze = (body: Omit<IntakeReviewRecord, 'token'>): IntakeReviewRecord => ({ ...body, token: digest(canonical(body)) });
  for (let i = 0; i < 7; i += 1) {
    const { token: _token, ...previous } = head;
    const reviewed = freeze({ ...previous, status: 'reviewed', requestId: `large-${i}`, revisionId: digest(`large-${i}`), previousToken: head.token, selected: [], entries: [] });
    h.ledger.recordIntakeReview(reviewed);
    const { token: _reviewedToken, ...reviewedBody } = reviewed;
    head = freeze({ ...reviewedBody, previousToken: reviewed.token, status: 'approved', selected: ['one'], entries: [{ id: `large-${i}`, requestId: `large-${i}`, repoPath: h.repoPath, title: 'Bounded history', briefing: 'x'.repeat(1024 * 1024), prerequisites: [] }] });
    h.ledger.recordIntakeReview(head);
  }
  const { token: _token, ...previous } = head;
  const reviewed = freeze({ ...previous, status: 'reviewed', requestId: 'overflow', revisionId: digest('overflow'), previousToken: head.token, selected: [], entries: [] });
  h.ledger.recordIntakeReview(reviewed);
  const { token: _reviewedToken, ...body } = reviewed;
  const overflow = freeze({ ...body, status: 'approved', previousToken: reviewed.token, selected: ['one'], entries: [{ id: 'overflow', requestId: 'overflow', repoPath: h.repoPath, title: 'Overflow', briefing: 'x'.repeat(1536 * 1024), prerequisites: [] }] });
  const before = h.db.handle.prepare('SELECT COUNT(*) AS count FROM intake_reviews').get();
  expect(() => h.ledger.recordIntakeReview(overflow)).toThrowError(expect.objectContaining({ code: 'intake_storage_error', message: expect.stringContaining('byte verification bound') }));
  expect(h.ledger.getIntakeReview(h.repoPath, 'feature')).toEqual(reviewed); expect(h.db.handle.prepare('SELECT COUNT(*) AS count FROM intake_reviews').get()).toEqual(before); expect(h.ledger.listPipelineEntries()).toEqual([]);
});
