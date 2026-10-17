import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntakeService, INTAKE_MAX_OUTPUT_BYTES } from '../src/intake/service.js';
import { IntakeSlicingService, INTAKE_SLICING_RESULT_KIND, SLICING_HELPER, slicingIdentity, type IntakeSlicingDispatchInput } from '../src/intake/slicing.js';
import { validatePlan } from '../src/intake/planner.js';
import { slicingPlan } from '../src/intake/breakdown.js';
import { IntakeApprovalService } from '../src/intake/approval.js';
import { PipelineService } from '../src/dispatch/pipeline.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { DispatchService } from '../src/dispatch/service.js';
import { EventBus } from '../src/events/bus.js';
import { PacingGate } from '../src/runtime/pacing.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';
import { ownerAttentionFor } from '../src/notifications/attention.js';
import { loadBundledWorkflowRuntime } from '../src/workflows/runtime.js';
import { canonical, type Proposal } from '../src/intake/types.js';
import { ARCHITECTURE, EPIC } from './helpers/bmad-epic.js';

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gc-slicing-')));
  roots.push(root);
  const repo = join(root, 'workspace', 'shop');
  const dataDir = join(root, 'private-home');
  mkdirSync(join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const write = (path: string, text: string): void => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  write('epic-cart/epic-cart.md', EPIC);
  write('architecture-checkout/architecture-checkout.md', ARCHITECTURE);
  const intake = new IntakeService({ dataDir, workspaceRoot: join(root, 'workspace'), uploadsDir: join(dataDir, 'uploads'), managedRepos: () => [repo] });
  const db = new LedgerDb(join(root, 'ledger'));
  const ledger = new LedgerApi(db.handle);
  // The dispatcher records the job row before its first await.
  const dispatch = vi.fn(async (input: IntakeSlicingDispatchInput) => { ledger.addJob({ id: input.jobId, repo: 'shop', title: input.title, briefing: input.briefing, deliverable: input.deliverable }); return { settled: Promise.resolve() }; });
  const post = vi.fn();
  const log = vi.fn();
  const slicing = new IntakeSlicingService({ intake, ledger, dispatch, notifications: { post }, apiBase: () => 'http://127.0.0.1:4100', log });
  const pipeline = new PipelineService({ ledger, dispatch: { dispatch: vi.fn(async () => ({ settled: Promise.resolve() })) }, capacity: () => ({ capacity: 1, occupied: 1, available: 0, queued: 0 }) });
  const approval = new IntakeApprovalService({ intake, ledger, pipeline });
  cleanups.push(() => { pipeline.dispose(); db.close(); });
  const source = { kind: 'bmad' as const, document: { path: 'epic-cart/epic-cart.md' }, supporting: [{ path: 'architecture-checkout/architecture-checkout.md' }] };
  return { root, repo, write, intake, slicing, dispatch, post, log, ledger, approval, source };
}
const lineId = (proposal: Proposal, prefix: string): string => proposal.requirements.find(({ trace }) => trace.quote.startsWith(prefix))!.id;
/** The fake model boundary: what a planning minion reads (the captured
 * proposal) and what it submits (a breakdown naming inventory line ids). */
function minionBreakdown(proposal: Proposal, overrides: { readonly first?: Record<string, unknown>; readonly questions?: readonly string[] } = {}) {
  const covered = new Set(['- R1', '- R2', '- R3'].map((prefix) => lineId(proposal, prefix)));
  return {
    entries: [
      { id: '1', title: 'Cart service scaffold', description: 'Stands up one add-item path through UI, API and store.', verify: 'A shopper adds one item and sees it in the cart.', covers: [lineId(proposal, '- R1')], lane: 'cart', rationale: 'Tracer bullet.', ...overrides.first },
      { id: '2', title: 'Discount codes', description: 'Validates one code and shows the refusal reason.', verify: 'A valid code lowers the total; an expired one says why.', covers: [lineId(proposal, '- R2')], after: ['1'], unknown: 'Can the discount engine answer within 300 ms?' },
      { id: '3', title: 'Shown total is charged', description: 'Sends the shown total to payment unchanged.', verify: 'The payment request carries the shown total.', covers: [lineId(proposal, '- R3')], after: ['2'], hitl: true },
    ],
    context: proposal.requirements.filter(({ id, trace }) => trace.snapshotId === 's1' && !covered.has(id)).map(({ id }) => id),
    questions: overrides.questions ?? ['Source conflict: R2 — the epic allows one code vs AD-1 which allows stacking.'],
  };
}

describe('intake slicing by a commissioned planning minion (#429)', () => {
  it('commissions one tracked investigation job bound to the exact revision, with the verified GC slicing helper', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    const commission = await h.slicing.commission(request);
    const identity = slicingIdentity(preview);
    expect(commission).toEqual({ ...request, ...identity, dispatched: true, jobStatus: 'dispatched' });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const input = h.dispatch.mock.calls[0]![0];
    expect(input).toMatchObject({ jobId: identity.jobId, repoPath: h.repo, deliverable: 'investigation', title: 'Slice intake cart into heists' });
    const runtime = loadBundledWorkflowRuntime();
    expect(runtime.id).toBe('gru-command-workflows@2');
    expect(input.briefing).toContain(`GC slicing helper (gru-command-workflows@2 ${SLICING_HELPER}, sha256 ${runtime.manifest.files[SLICING_HELPER]!}):`);
    expect(input.briefing).toContain(runtime.files.get(SLICING_HELPER)!.toString('utf-8'));
    expect(input.briefing).toContain(`- revisionId: ${preview.revisionId}`);
    expect(input.briefing).toContain(`- result requestId: ${identity.resultRequestId} (GC assigns it)`);
    expect(input.briefing).toContain(`GET http://127.0.0.1:4100/api/intake/cart/requests/r1?repoPath=${encodeURIComponent(h.repo)}`);
    expect(input.briefing).toContain(`POST http://127.0.0.1:4100/api/intake/slice/result with {"repoPath":${JSON.stringify(h.repo)},"intakeId":"cart","requestId":"r1","revisionId":"${preview.revisionId}","breakdown":<your breakdown>}`);
    // Retries converge on the one job; no second minion is dispatched.
    expect(await h.slicing.commission(request)).toEqual({ ...request, ...identity, dispatched: false, jobStatus: 'dispatched' });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    await expect(h.slicing.commission({ ...request, revisionId: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'intake_stale_revision', status: 409 });
  });

  it('refuses to slice sources with gaps, and to accept a breakdown nobody commissioned', async () => {
    const h = fixture();
    const missing = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: { ...h.source, supporting: [] } });
    expect(missing.gaps.map(({ code }) => code)).toEqual(['intake_missing_architecture']);
    await expect(h.slicing.commission({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: missing.revisionId })).rejects.toMatchObject({ code: 'intake_incomplete_sources', status: 409 });
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', source: h.source });
    await expect(h.slicing.submit({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', revisionId: preview.revisionId, breakdown: minionBreakdown(preview) })).rejects.toMatchObject({ code: 'intake_slicing_not_commissioned', status: 409 });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('the breakdown arrives as a refinement with previousRequestId; human steps, unknowns and conflicts surface as questions and in FOR YOU', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    const { jobId, resultRequestId } = await h.slicing.commission(request);
    const read = h.intake.read(h.repo, 'cart', 'r1');
    const sliced = await h.slicing.submit({ ...request, breakdown: minionBreakdown(read) });
    expect(sliced).toMatchObject({ executable: false, requestId: resultRequestId, previousRequestId: 'r1' });
    expect(sliced.snapshots).toEqual(preview.snapshots);
    expect(h.intake.read(h.repo, 'cart', resultRequestId)).toEqual(sliced);
    expect(validatePlan(sliced.plan, sliced)).toEqual(sliced.plan);
    expect(sliced.plan.heists.map(({ id, dependencies }) => [id, dependencies.map(({ id: dep, milestone }) => `${dep}@${milestone}`)])).toEqual([['entry-1', []], ['entry-2', ['entry-1@merged']], ['entry-3', ['entry-2@merged']]]);
    const [one, two, three] = sliced.plan.heists;
    expect(one!.acceptance[0]!.traces.map(({ quote }) => quote)).toEqual(['- R1: Add, remove, and change quantity of any item; the total updates at once.']);
    expect(one!.splitMergeRationale).toMatchObject({ text: 'Lane cart. Tracer bullet.', clarification: true });
    expect(one!.unresolvedQuestions).toEqual([]);
    expect(two!.unresolvedQuestions).toEqual(['Entry 2 has an unknown to settle before it starts: Can the discount engine answer within 300 ms?']);
    expect(three!.unresolvedQuestions).toEqual([expect.stringMatching(/^Entry 3 has a human step \(hitl\)/u)]);
    expect(sliced.plan.questions).toEqual(['Source conflict: R2 — the epic allows one code vs AD-1 which allows stacking.']);
    expect(sliced.plan.unmapped).toEqual([]);
    expect(h.post).toHaveBeenCalledTimes(1);
    const card = h.post.mock.calls[0]![0] as { id: string; kind: string; routing: string; title: string; detail: string };
    expect(card).toMatchObject({ id: `intake-slicing:${jobId}`, kind: INTAKE_SLICING_RESULT_KIND, routing: 'needs-owner', title: 'Sliced plan has 1 source conflict(s): cart' });
    expect(card.detail.split('\n').slice(1, 3)).toEqual([
      '1 source conflict(s) and 2 other open question(s) block approval until a refinement settles them:',
      '- Source conflict: R2 — the epic allows one code vs AD-1 which allows stacking.',
    ]);
    // The identical breakdown converges; a different one cannot replace the result.
    expect(await h.slicing.submit({ ...request, breakdown: minionBreakdown(read) })).toEqual(sliced);
    await expect(h.slicing.submit({ ...request, breakdown: minionBreakdown(read, { questions: [] }) })).rejects.toMatchObject({ code: 'intake_replay_conflict', status: 409 });
  });

  it('untraced acceptance is refused before anything is written, then a corrected breakdown lands', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    const { resultRequestId } = await h.slicing.commission(request);
    const untraced = minionBreakdown(preview, { first: { covers: [] } });
    await expect(h.slicing.submit({ ...request, breakdown: untraced })).rejects.toMatchObject({ code: 'intake_invalid_plan', message: 'acceptance requires source traces or an explicit proposed clarification' });
    expect(() => h.intake.read(h.repo, 'cart', resultRequestId)).toThrow(expect.objectContaining({ code: 'intake_not_found' }));
    for (const [breakdown, message] of [
      [{ ...untraced, entries: [] }, /at least one entry/u],
      [minionBreakdown(preview, { first: { covers: ['s9-r0'] } }), /covers "s9-r0" is not a requirement id/u],
      [minionBreakdown(preview, { first: { after: ['3'] } }), /in a cycle: 1 → 3 → 2 → 1/u],
      [minionBreakdown(preview, { first: { after: ['7'] } }), /entry 1 is after "7", which names no entry/u],
      [minionBreakdown(preview, { first: { status: 'approved' } }), /unsupported fields status/u],
    ] as const) await expect(h.slicing.submit({ ...request, breakdown })).rejects.toMatchObject({ code: 'intake_invalid_plan', message: expect.stringMatching(message) });
    expect(h.post).not.toHaveBeenCalled();
    // An explicitly proposed entry stands without a captured line.
    const stub = await h.slicing.submit({ ...request, breakdown: minionBreakdown(preview, { first: { covers: [], clarification: true } }) });
    expect(stub.plan.heists[0]!.acceptance[0]).toMatchObject({ traces: [], clarification: true, requirementIds: [] });
    expect(stub.plan.unmapped.map(({ question }) => question)).toEqual(['epic-cart/epic-cart.md: "- R1: Add, remove, and change quantity of any item; the total updates at once." is a requirement no entry covers. Place it in an entry, or confirm it is out of scope.']);
  });

  it('a changed epic is a new request: the earlier proposal stays, and its slicing is a different minion', async () => {
    const h = fixture();
    const first = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const a = await h.slicing.commission({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: first.revisionId });
    h.write('epic-cart/epic-cart.md', EPIC.replace('before tax', 'including tax'));
    const second = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', previousRequestId: 'r1', source: h.source });
    expect(second.snapshots[0]!.sha256).not.toBe(first.snapshots[0]!.sha256);
    expect(h.intake.read(h.repo, 'cart', 'r1')).toEqual(first);
    const b = await h.slicing.commission({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', revisionId: second.revisionId });
    expect(b.jobId).not.toBe(a.jobId);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });
  it('posts its FOR YOU card through a registered owner kind, counting each open question once', async () => {
    expect(ownerAttentionFor(INTAKE_SLICING_RESULT_KIND)).toBe('owner-required');
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    await h.slicing.commission(request);
    // R1 uncovered: one unmapped line, which plan.questions already lists.
    await h.slicing.submit({ ...request, breakdown: minionBreakdown(preview, { first: { covers: [], clarification: true }, questions: [] }) });
    const card = h.post.mock.calls[0]![0] as { detail: string };
    expect(card.detail).toContain('0 source conflict(s) and 3 other open question(s) block approval');
    expect(card.detail.split('\n').filter((line) => line.includes('is a requirement no entry covers'))).toHaveLength(1);
  });

  it('a mistyped human step is refused, never read as no step', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    await h.slicing.commission(request);
    await expect(h.slicing.submit({ ...request, breakdown: minionBreakdown(preview, { first: { hitl: 'true' } }) })).rejects.toMatchObject({ code: 'intake_invalid_plan', message: 'breakdown entry 1 hitl must be true or false' });
  });

  it('a dispatch that fails before recording the job is a named 503, and the identical retry dispatches it', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    h.dispatch.mockRejectedValueOnce(new Error('worktree creation failed'));
    await expect(h.slicing.commission(request)).rejects.toMatchObject({ code: 'intake_slicing_dispatch_failed', status: 503, message: expect.stringContaining('worktree creation failed') });
    expect(await h.slicing.commission(request)).toMatchObject({ dispatched: true, jobStatus: 'dispatched' });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it('answers once the job is recorded, without waiting on the dispatch, and later reports its status', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    let fail!: (error: Error) => void;
    h.dispatch.mockImplementationOnce((input) => {
      h.ledger.addJob({ id: input.jobId, repo: 'shop', title: input.title, briefing: input.briefing, deliverable: input.deliverable });
      return new Promise((_resolve, reject) => { fail = reject; });
    });
    expect(await h.slicing.commission(request)).toMatchObject({ dispatched: true, jobStatus: 'dispatched' });
    fail(new Error('spawn failed'));
    const { jobId } = slicingIdentity(preview);
    h.ledger.setJobStatus(jobId, 'blocked');
    expect(await h.slicing.commission(request)).toMatchObject({ dispatched: false, jobStatus: 'blocked', jobId });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('refuses without the slicing helper, and for a revision that already has accepted work', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    const runtime = loadBundledWorkflowRuntime();
    const { [SLICING_HELPER]: _helper, ...files } = runtime.manifest.files;
    const older = { ...runtime, manifest: { ...runtime.manifest, files }, files: new Map([...runtime.files].filter(([path]) => path !== SLICING_HELPER)) };
    const withoutHelper = new IntakeSlicingService({ intake: h.intake, ledger: h.ledger, dispatch: h.dispatch, notifications: { post: h.post }, workflow: () => older });
    await expect(withoutHelper.commission(request)).rejects.toMatchObject({ code: 'intake_workflow_unavailable', status: 503, message: expect.stringContaining(SLICING_HELPER) });
    const plan = { ...preview.plan, questions: [], heists: preview.plan.heists.map((heist) => ({ ...heist, unresolvedQuestions: [] })) };
    expect(plan.heists).toHaveLength(1);
    const refined = await h.intake.revise({ ...request, requestId: 'r2', previousRequestId: 'r1', plan: { ...plan, heists: plan.heists.map((heist) => ({ ...heist, goal: { text: 'Shoppers manage their cart.', traces: [], clarification: true }, scope: [{ text: 'The cart UI.', traces: [], clarification: true }], exclusions: [{ text: 'Pricing and tax.', traces: [], clarification: true }], acceptance: heist.acceptance.map((item) => ({ ...item, text: `Delivered: ${item.traces[0]!.quote}` })), verification: [{ text: 'The cart end-to-end suite passes.', traces: [], clarification: true }], splitMergeRationale: { text: 'One cohesive cart change.', traces: [], clarification: true } })) } });
    const decision = { repoPath: h.repo, intakeId: 'cart', requestId: 'r2', revisionId: refined.revisionId, expectedToken: null };
    h.approval.approve({ ...decision, expectedToken: h.approval.review(decision).review!.token, selected: [plan.heists[0]!.id] });
    await expect(h.slicing.commission({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', revisionId: refined.revisionId })).rejects.toMatchObject({ code: 'intake_slicing_approved', status: 409 });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('an oversized plan is refused without writing the result request, so a corrected breakdown still lands', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    const { resultRequestId } = await h.slicing.commission(request);
    const base = minionBreakdown(preview);
    const words = 'w'.repeat(4000);
    const huge = { ...base, entries: Array.from({ length: 200 }, (_, index) => ({ ...base.entries[0], id: String(index + 1), description: words, verify: words, rationale: words })) };
    await expect(h.slicing.submit({ ...request, breakdown: huge })).rejects.toMatchObject({ code: 'intake_output_bounds' });
    expect(() => h.intake.read(h.repo, 'cart', resultRequestId)).toThrow(expect.objectContaining({ code: 'intake_not_found' }));
    expect((await h.slicing.submit({ ...request, breakdown: base })).requestId).toBe(resultRequestId);
  });

  it('the owner settles a sliced plan by refinement and approves a slice from it', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    const { resultRequestId } = await h.slicing.commission(request);
    const sliced = await h.slicing.submit({ ...request, breakdown: minionBreakdown(preview) });
    // The owner settles the recorded conflict: the plan-level question goes.
    const settled = await h.intake.revise({ repoPath: h.repo, intakeId: 'cart', requestId: 'r3', previousRequestId: resultRequestId, revisionId: sliced.revisionId, plan: { ...sliced.plan, questions: [] } });
    const decision = { repoPath: h.repo, intakeId: 'cart', requestId: 'r3', revisionId: settled.revisionId, expectedToken: null };
    const token = h.approval.review(decision).review!.token;
    expect(() => h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-2'] })).toThrow(expect.objectContaining({ code: 'intake_incomplete_plan' }));
    const readback = h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-1'] });
    expect(readback.accepted.map(({ heistId }) => heistId)).toEqual(['entry-1']);
    expect(h.ledger.listPipelineEntries().map(({ title }) => title)).toEqual(['Cart service scaffold']);
  });
  it('refuses a breakdown for a revision that gained accepted work after its minion was commissioned', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    await h.slicing.commission(request);
    const heist = preview.plan.heists[0]!;
    const concrete = { ...heist, unresolvedQuestions: [], goal: { text: 'Shoppers manage their cart.', traces: [], clarification: true }, scope: [{ text: 'The cart UI.', traces: [], clarification: true }], exclusions: [{ text: 'Pricing and tax.', traces: [], clarification: true }], acceptance: heist.acceptance.map((item) => ({ ...item, text: `Delivered: ${item.traces[0]!.quote}` })), verification: [{ text: 'The cart end-to-end suite passes.', traces: [], clarification: true }], splitMergeRationale: { text: 'One cohesive cart change.', traces: [], clarification: true } };
    const refined = await h.intake.revise({ ...request, requestId: 'r2', previousRequestId: 'r1', plan: { ...preview.plan, questions: [], heists: [concrete] } });
    await h.slicing.commission({ ...request, requestId: 'r2', revisionId: refined.revisionId });
    const decision = { repoPath: h.repo, intakeId: 'cart', requestId: 'r2', revisionId: refined.revisionId, expectedToken: null };
    h.approval.approve({ ...decision, expectedToken: h.approval.review(decision).review!.token, selected: [heist.id] });
    const reread = h.intake.read(h.repo, 'cart', 'r2');
    await expect(h.slicing.submit({ ...request, requestId: 'r2', revisionId: refined.revisionId, breakdown: minionBreakdown(reread) })).rejects.toMatchObject({ code: 'intake_slicing_approved', status: 409 });
  });

  it('a dispatch that returns without recording the job is a named 503', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    h.dispatch.mockImplementationOnce(async () => ({ settled: Promise.resolve() }));
    await expect(h.slicing.commission({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId })).rejects.toMatchObject({ code: 'intake_slicing_dispatch_failed', status: 503, message: expect.stringContaining('without recording planning job') });
  });
  it('an identical breakdown retried after approval still converges on the landed revision', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const heist = preview.plan.heists[0]!;
    const concrete = { ...heist, unresolvedQuestions: [], goal: { text: 'Shoppers manage their cart.', traces: [], clarification: true }, scope: [{ text: 'The cart UI.', traces: [], clarification: true }], exclusions: [{ text: 'Pricing and tax.', traces: [], clarification: true }], acceptance: heist.acceptance.map((item) => ({ ...item, text: `Delivered: ${item.traces[0]!.quote}` })), verification: [{ text: 'The cart end-to-end suite passes.', traces: [], clarification: true }], splitMergeRationale: { text: 'One cohesive cart change.', traces: [], clarification: true } };
    const refined = await h.intake.revise({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', previousRequestId: 'r1', revisionId: preview.revisionId, plan: { ...preview.plan, questions: [], heists: [concrete] } });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r2', revisionId: refined.revisionId };
    await h.slicing.commission(request);
    const breakdown = minionBreakdown(h.intake.read(h.repo, 'cart', 'r2'));
    const landed = await h.slicing.submit({ ...request, breakdown });
    const decision = { ...request, expectedToken: null };
    h.approval.approve({ ...decision, expectedToken: h.approval.review(decision).review!.token, selected: [heist.id] });
    expect(await h.slicing.submit({ ...request, breakdown })).toEqual(landed);
    await expect(h.slicing.submit({ ...request, breakdown: { ...breakdown, questions: [] } })).rejects.toMatchObject({ code: 'intake_replay_conflict', status: 409 });
  });

  it('bounds the exact proposal it would publish, unmapped questions included, before writing the result request', async () => {
    const h = fixture();
    // Many uncovered lines: their questions appear in plan.unmapped and again in plan.questions.
    const lines = Array.from({ length: 3000 }, (_, index) => `- Note ${String(index).padStart(4, '0')}: a captured epic line that no slice covers, long enough to weigh.`).join('\n');
    h.write('epic-cart/epic-cart.md', `${EPIC}\n## Appendix\n\n${lines}\n`);
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    const { resultRequestId } = await h.slicing.commission(request);
    const base = minionBreakdown(preview);
    const appendix = new Set(preview.requirements.filter(({ trace }) => trace.quote.startsWith('- Note ')).map(({ id }) => id));
    const loose = { ...base, context: base.context.filter((id) => !appendix.has(id)) };
    const plan = slicingPlan(loose, preview);
    // The plan alone fits; only the published proposal, with its merged questions, overflows.
    expect(Buffer.byteLength(canonical({ snapshots: preview.snapshots, gaps: preview.gaps, requirements: preview.requirements, plan }))).toBeLessThan(INTAKE_MAX_OUTPUT_BYTES - 64 * 1024);
    await expect(h.slicing.submit({ ...request, breakdown: loose })).rejects.toMatchObject({ code: 'intake_output_bounds' });
    expect(() => h.intake.read(h.repo, 'cart', resultRequestId)).toThrow(expect.objectContaining({ code: 'intake_not_found' }));
    expect((await h.slicing.submit({ ...request, breakdown: base })).requestId).toBe(resultRequestId);
  });
  it('logs a dispatch failure after the job is recorded, on the inline and the awaited path', async () => {
    const h = fixture();
    const preview = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source });
    const request = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId };
    const { jobId } = slicingIdentity(preview);
    h.dispatch.mockImplementationOnce(async (input) => {
      await Promise.resolve();
      h.ledger.addJob({ id: input.jobId, repo: 'shop', title: input.title, briefing: input.briefing, deliverable: input.deliverable });
      throw new Error('spawn failed after recording');
    });
    expect(await h.slicing.commission(request)).toMatchObject({ dispatched: true, jobStatus: 'dispatched' });
    expect(h.log).toHaveBeenCalledWith('error', 'intake planning minion dispatch failed after its job was recorded', { job: jobId, error: 'spawn failed after recording' });
    const other = await h.intake.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', source: h.source });
    h.dispatch.mockImplementationOnce((input) => {
      h.ledger.addJob({ id: input.jobId, repo: 'shop', title: input.title, briefing: input.briefing, deliverable: input.deliverable });
      return Promise.reject(new Error('worktree failed'));
    });
    const inline = await h.slicing.commission({ ...request, requestId: 'r2', revisionId: other.revisionId });
    expect(inline.dispatched).toBe(true);
    await vi.waitFor(() => expect(h.log).toHaveBeenCalledWith('error', 'intake planning minion dispatch failed after its job was recorded', { job: inline.jobId, error: 'worktree failed' }));
  });
});

describe('intake slicing through the real dispatch service (#429)', () => {
  it('answers with the recorded investigation job while the worker gate holds the minion back', async () => {
    const repo = makeFixtureRepo('intake-slicing-dispatch');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gc-slicing-dispatch-')));
    roots.push(root);
    const repoPath = realpathSync(repo.path);
    mkdirSync(join(repoPath, 'epic-cart'), { recursive: true });
    mkdirSync(join(repoPath, 'architecture-checkout'), { recursive: true });
    writeFileSync(join(repoPath, 'epic-cart/epic-cart.md'), EPIC);
    writeFileSync(join(repoPath, 'architecture-checkout/architecture-checkout.md'), ARCHITECTURE);
    const db = new LedgerDb(join(root, 'ledger'));
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    cleanups.push(() => { db.close(); repo.cleanup(); });
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0, record: () => {} });
    const handle = (id: string) => ({ id, role: 'minion' as const, sessionFile: join(root, `${id}.jsonl`), prompt: () => new Promise<void>(() => {}) }) as unknown as AgentHandle;
    let spawned = 0;
    const dispatcher = new DispatchService({ ledger, worktrees: new InMemoryWorktreePort(join(root, 'lanes'), ledger), spawner: async () => handle(`minion-${++spawned}`), workerGate: gate });
    // Another heist holds the only worker slot.
    await dispatcher.dispatch({ jobId: 'busy', repoPath, title: 'Busy', briefing: 'busy' });
    const intake = new IntakeService({ dataDir: join(root, 'private-home'), workspaceRoot: dirname(repoPath), uploadsDir: join(root, 'private-home', 'uploads'), managedRepos: () => [repoPath] });
    mkdirSync(join(root, 'private-home', 'uploads'), { recursive: true, mode: 0o700 });
    const slicing = new IntakeSlicingService({ intake, ledger, dispatch: (input) => dispatcher.dispatch(input), notifications: { post: vi.fn() } });
    const preview = await intake.preview({ repoPath, intakeId: 'cart', requestId: 'r1', source: { kind: 'bmad', document: { path: 'epic-cart/epic-cart.md' }, supporting: [{ path: 'architecture-checkout/architecture-checkout.md' }] } });
    const commission = await slicing.commission({ repoPath, intakeId: 'cart', requestId: 'r1', revisionId: preview.revisionId });
    expect(commission).toMatchObject({ dispatched: true, jobId: slicingIdentity(preview).jobId, jobStatus: expect.any(String) });
    expect(ledger.getJob(commission.jobId)).toMatchObject({ deliverable: 'investigation', commissioner: 'gru' });
    expect(gate.view().worker.queued.map(({ id }) => id)).toEqual([commission.jobId]);
    expect(spawned).toBe(1);
  });
});
