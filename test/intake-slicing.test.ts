import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntakeService } from '../src/intake/service.js';
import { IntakeSlicingService, INTAKE_SLICING_RESULT_KIND, SLICING_HELPER, slicingIdentity, type IntakeSlicingDispatchInput } from '../src/intake/slicing.js';
import { validatePlan } from '../src/intake/planner.js';
import type { LedgerApi } from '../src/ledger/api.js';
import { loadBundledWorkflowRuntime } from '../src/workflows/runtime.js';
import type { Proposal } from '../src/intake/types.js';
import { ARCHITECTURE, EPIC } from './helpers/bmad-epic.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
  const jobs = new Map<string, IntakeSlicingDispatchInput>();
  const dispatch = vi.fn(async (input: IntakeSlicingDispatchInput) => { jobs.set(input.jobId, input); return { settled: Promise.resolve() }; });
  const post = vi.fn();
  const ledger = { getJob: (id: string) => (jobs.has(id) ? { id } : null) } as unknown as Pick<LedgerApi, 'getJob'>;
  const slicing = new IntakeSlicingService({ intake, ledger, dispatch, notifications: { post }, apiBase: () => 'http://127.0.0.1:4100' });
  const source = { kind: 'bmad' as const, document: { path: 'epic-cart/epic-cart.md' }, supporting: [{ path: 'architecture-checkout/architecture-checkout.md' }] };
  return { root, repo, write, intake, slicing, dispatch, post, jobs, source };
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
    expect(commission).toEqual({ ...request, ...identity, dispatched: true });
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
    expect(await h.slicing.commission(request)).toEqual({ ...request, ...identity, dispatched: false });
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
});
