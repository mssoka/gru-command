import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { BRIEFING_REVIEW_NOTIFICATION_KIND, BriefingReviewService, type BriefingReviewDispatchInput, type BriefingReviewServiceOptions } from '../src/briefing-review/service.js';
import {
  BRIEFING_REVIEW_ARMED,
  BRIEFING_REVIEW_REFUSED,
  BRIEFING_REVIEW_VERDICT,
  readArmed,
} from '../src/briefing-review/events.js';
import {
  briefingMarkers,
  briefingReviewIdentity,
  BriefingReviewError,
  lensJobId,
  reviewedBriefing,
  type BriefingReviewFinding,
  type BriefingReviewTier,
} from '../src/briefing-review/types.js';
import { loadBundledWorkflowRuntime } from '../src/workflows/runtime.js';
import { reconcileReportClosures } from '../src/dispatch/durable-reconcile.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Nefario, the pre-dispatch briefing review (GH-505): the service half —
 * commission identity and convergence, tier raises, evidence-bound results,
 * aggregation, push-back, the round cap and the staged dispatch gate. The
 * cockpit count derivations live in briefing-review-board.test.ts.
 */

/** A realistic draft briefing; findings must quote spans of it. */
const BRIEFING = [
  'Heist: add the refunds endpoint.',
  '- GET /api/refunds returns the caller\'s own refunds, newest first.',
  '- Acceptance: one test adds a refund then reads it back in the same order.',
  '- Do not touch the payments module sources.',
].join('\n');

const SPAN = 'GET /api/refunds returns the caller\'s own refunds';

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  readonly repo: FixtureRepo;
  readonly ledger: LedgerApi;
  readonly service: BriefingReviewService;
  readonly dispatch: ReturnType<typeof vi.fn>;
  readonly post: ReturnType<typeof vi.fn>;
  readonly notices: Map<string, Record<string, unknown>>;
  readonly log: ReturnType<typeof vi.fn>;
  readonly dispatchedJobIds: readonly string[];
  readonly briefing: string;
}

function harness(options: {
  readonly enabled?: boolean;
  readonly stage?: 1 | 2 | 3;
  readonly failOnce?: string;
  readonly workflow?: BriefingReviewServiceOptions['workflow'];
} = {}): Harness {
  const repo = makeFixtureRepo('refunds-api');
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-briefing-review-'));
  roots.push(dir);
  cleanups.push(() => repo.cleanup());
  const db = new LedgerDb(dir);
  const ledger = new LedgerApi(db.handle);
  cleanups.push(() => db.close());
  const dispatchedJobIds: string[] = [];
  let armedFailure = options.failOnce;
  const dispatch = vi.fn(async (input: BriefingReviewDispatchInput) => {
    // One shot only: the retry must be able to crash-repair the missing row.
    if (armedFailure !== undefined && input.jobId.endsWith(`-${armedFailure}`)) {
      armedFailure = undefined;
      throw new Error(`spawn refused for ${input.jobId}`);
    }
    ledger.addJob({
      id: input.jobId,
      repo: 'refunds-api',
      title: input.title,
      briefing: input.briefing,
      deliverable: input.deliverable,
    });
    dispatchedJobIds.push(input.jobId);
    return { settled: Promise.resolve() };
  });
  const notices = new Map<string, Record<string, unknown>>();
  const post = vi.fn((input: Record<string, unknown> & { readonly id?: string }) => {
    const id = input['id'] ?? `generated-${String(notices.size)}`;
    if (!notices.has(id)) notices.set(id, input);
    return notices.get(id);
  });
  const log = vi.fn();
  const service = new BriefingReviewService({
    config: { enabled: options.enabled ?? true, stage: options.stage ?? 1 },
    ledger,
    notifications: { post: post as never },
    dispatch,
    apiBase: () => 'http://127.0.0.1:4100',
    headSha: () => repo.head(),
    log,
    ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
  });
  return { repo, ledger, service, dispatch, post, notices, log, dispatchedJobIds, briefing: BRIEFING };
}

function commission(h: Harness, overrides: { title?: string; briefing?: string; tier?: BriefingReviewTier; justification?: string } = {}) {
  return {
    repoPath: h.repo.path,
    title: overrides.title ?? 'Refunds endpoint',
    briefing: overrides.briefing ?? h.briefing,
    tier: overrides.tier ?? 'low',
    justification: overrides.justification ?? 'Touches the refunds API and its tests.',
  };
}

function armedOf(h: Harness): { reviewId: string; briefingSha256: string; lenses: readonly string[] } {
  const events = h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] });
  const newest = readArmed(events[events.length - 1]!);
  if (newest === null) throw new Error('no armed review');
  return newest;
}

/** What a lens submits: its own job id, the review's sha and evidence quoted
 * from the marked briefing. */
function result(h: Harness, input: {
  readonly lens: string;
  readonly findings?: readonly BriefingReviewFinding[];
  readonly verdict?: 'READY' | 'CHANGES-NEEDED';
}) {
  const armed = armedOf(h);
  // The wire carries snake_case finding fields; the service reads them into
  // the internal camelCase shape.
  const findings = (input.findings ?? []).map((finding) => ({
    code: finding.code,
    severity: finding.severity,
    evidence: finding.evidence,
    why_it_blocks: finding.whyItBlocks,
  }));
  return {
    repoPath: h.repo.path,
    briefingSha256: armed.briefingSha256,
    jobId: lensJobId(armed.reviewId, input.lens as never),
    lens: input.lens,
    verdict: input.verdict ?? (findings.some((finding) => finding.severity === 'blocking') ? 'CHANGES-NEEDED' : 'READY'),
    findings,
  };
}

/** A finding as the wire carries it (snake_case, exactly four fields). */
function wire(finding: BriefingReviewFinding): Record<string, unknown> {
  return { code: finding.code, severity: finding.severity, evidence: finding.evidence, why_it_blocks: finding.whyItBlocks };
}

const blocking = (evidence = SPAN): BriefingReviewFinding => ({
  code: 'undefined-endpoint',
  severity: 'blocking',
  evidence,
  whyItBlocks: 'the lane cannot tell what the route returns for an empty history',
});

const advisory: BriefingReviewFinding = {
  code: 'thin-acceptance',
  severity: 'advisory',
  evidence: 'one test adds a refund then reads it back',
  whyItBlocks: 'one case only; an ordering bug would not fail it',
};

describe('Nefario briefing review — commission and identity', () => {
  it('arms one review and dispatches one read-only lens job per lens, carrying the verbatim briefing, its own helper section and the result contract', async () => {
    const h = harness();
    const outcome = await h.service.commission(commission(h));
    expect(outcome.status).toBe(202);
    expect(outcome.body).toMatchObject({
      round: 1,
      generation: 1,
      tier: 'low',
      lenses: ['stranger'],
      dispatched: true,
      upgraded: false,
      headSha: h.repo.head(),
    });
    const armed = armedOf(h);
    expect(outcome.body.reviewId).toBe(armed.reviewId);
    expect(outcome.body.jobs).toEqual([{ lens: 'stranger', jobId: lensJobId(armed.reviewId, 'stranger'), status: 'dispatched' }]);
    // Exactly one armed event, and it carries the documented provenance.
    const armedEvents = h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] });
    expect(armedEvents).toHaveLength(1);
    expect(armedEvents[0]!.payload).toMatchObject({
      review_id: armed.reviewId,
      commission_key: briefingReviewIdentity({ ...commission(h) }).commissionKey,
      briefing_sha_256: armed.briefingSha256,
      repo_path: h.repo.path,
      title: 'Refunds endpoint',
      tier: 'low',
      justification: 'Touches the refunds API and its tests.',
      round: 1,
      generation: 1,
      lenses: ['stranger'],
      head_sha: h.repo.head(),
    });
    // The lens job is a read-only investigation planning job whose row holds
    // the exact briefing between this review's markers.
    const job = h.ledger.getJob(lensJobId(armed.reviewId, 'stranger'))!;
    expect(job.deliverable).toBe('investigation');
    const prompt = job.briefing!;
    const { open, close } = briefingMarkers(armed.reviewId);
    expect(prompt).toContain(open);
    expect(prompt).toContain(close);
    expect(prompt).toContain(BRIEFING);
    expect(reviewedBriefing(prompt, armed.reviewId)).toBe(BRIEFING);
    // Its own verified helper section, named by package id and sha256.
    const helper = loadBundledWorkflowRuntime();
    expect(prompt).toContain(`${helper.id} skills/briefing-review/lenses.md, sha256 ${helper.manifest.files['skills/briefing-review/lenses.md']}`);
    expect(prompt).toContain('## Lens: stranger');
    expect(prompt).not.toContain('## Lens: acceptance');
    // The result contract: endpoint, bearer instruction, the exact body, the
    // retry rule.
    expect(prompt).toContain('POST http://127.0.0.1:4100/api/briefing-review/result');
    expect(prompt).toContain('Authorization: Bearer <token>');
    expect(prompt).toContain('"jobId":"' + lensJobId(armed.reviewId, 'stranger') + '"');
    expect(prompt).toContain('"briefingSha256":"' + armed.briefingSha256 + '"');
    expect(prompt).toContain('A 400 names the finding to fix');
    // Read-only standing orders, repeated in the briefing's own orders.
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('change nothing,');
    expect(prompt).toContain('commit nothing');
    expect(prompt).toContain('open no pull request');
    // Zero context: exactly one lens section, no other lens's question and no
    // prior-round finding.
    expect(prompt.match(/^## Lens: /gmu)).toHaveLength(1);
    expect(prompt).not.toContain('## Lens: acceptance');
    expect(prompt).not.toContain('undefined-endpoint');
    expect(prompt).not.toContain('round 2');
  });

  it('converges on the same commission: one review, one lens job set, no second row, and a missing lens row is crash-repaired', async () => {
    const h = harness({ failOnce: 'acceptance' });
    await expect(h.service.commission(commission(h, { tier: 'medium' }))).rejects.toThrow('spawn refused');
    // The armed record and the first lens job survive the failed dispatch.
    const failing = armedOf(h);
    expect(h.ledger.getJob(lensJobId(failing.reviewId, 'stranger'))).not.toBeNull();
    expect(h.ledger.getJob(lensJobId(failing.reviewId, 'acceptance'))).toBeNull();
    const repaired = await h.service.commission(commission(h, { tier: 'medium' }));
    expect(repaired.status).toBe(202);
    expect(repaired.body.jobs.map((entry) => entry.status)).toEqual(['dispatched', 'dispatched', 'dispatched']);
    const again = await h.service.commission(commission(h, { tier: 'medium' }));
    expect(again.status).toBe(200);
    expect(again.body.dispatched).toBe(false);
    expect(again.body.reviewId).toBe(repaired.body.reviewId);
    expect(again.body.round).toBe(repaired.body.round);
    // Two calls in the failed attempt (the second threw) plus two repairs.
    expect(h.dispatch).toHaveBeenCalledTimes(4);
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] })).toHaveLength(1);
  });

  it('a revised briefing is a new round with a new reviewId, sha and lens job ids, and leaves the prior round untouched', async () => {
    const h = harness();
    const first = await h.service.commission(commission(h));
    const revised = await h.service.commission(commission(h, { briefing: `${BRIEFING}\n- Add one 409 case for a foreign refund id.` }));
    expect(revised.body.reviewId).not.toBe(first.body.reviewId);
    expect(revised.body.briefingSha256).not.toBe(first.body.briefingSha256);
    expect(revised.body.round).toBe(2);
    expect(revised.body.jobs[0]!.jobId).not.toBe(first.body.jobs[0]!.jobId);
    // The prior round's armed record and job are unchanged.
    const armedEvents = h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] });
    expect(armedEvents).toHaveLength(2);
    expect(readArmed(armedEvents[0]!)).toMatchObject({ reviewId: first.body.reviewId, round: 1, briefingSha256: first.body.briefingSha256 });
    expect(h.ledger.getJob(first.body.jobs[0]!.jobId)!.briefing).toContain(BRIEFING);
  });

  it('a live tier raise unions the lenses, keeps the round and review, inherits the results already submitted, and dispatches only the new lenses', async () => {
    const h = harness();
    const medium = await h.service.commission(commission(h, { tier: 'medium' }));
    // One READY lens of three: the review is still pending, so it can raise.
    expect(h.service.submitResult(result(h, { lens: 'stranger', findings: [advisory] })).aggregate).toBeNull();
    const raised = await h.service.commission(commission(h, { tier: 'high' }));
    expect(raised.body.reviewId).toBe(medium.body.reviewId);
    expect(raised.body.round).toBe(1);
    expect(raised.body.generation).toBe(2);
    expect(raised.body.tier).toBe('high');
    expect(raised.body.upgraded).toBe(true);
    expect(raised.body.lenses).toEqual(['stranger', 'acceptance', 'verification', 'repo', 'scope']);
    expect(raised.body.jobs.map((entry) => entry.lens)).toEqual(['stranger', 'acceptance', 'verification', 'repo', 'scope']);
    // The three inherited lens jobs were never re-dispatched: only the two
    // lenses the raise added got jobs.
    expect(raised.body.jobs.slice(0, 3).map((entry) => entry.jobId)).toEqual(medium.body.jobs.map((entry) => entry.jobId));
    expect(h.dispatch).toHaveBeenCalledTimes(5);
    expect(raised.status).toBe(202);
    // The inherited READY result still counts: the remaining lenses decide
    // the raised generation.
    expect(h.service.submitResult(result(h, { lens: 'acceptance' })).aggregate).toBeNull();
    expect(h.service.submitResult(result(h, { lens: 'verification' })).aggregate).toBeNull();
    expect(h.service.submitResult(result(h, { lens: 'repo' })).aggregate).toBeNull();
    expect(h.service.submitResult(result(h, { lens: 'scope' }))).toMatchObject({ aggregate: 'READY', decisive: true });
  });

  it('a lower-tier re-commission returns the effective tier without removing a lens, and a decided review refuses a raise', async () => {
    const h = harness();
    await h.service.commission(commission(h, { tier: 'high' }));
    const lower = await h.service.commission(commission(h, { tier: 'low' }));
    expect(lower.status).toBe(200);
    expect(lower.body.tier).toBe('high');
    expect(lower.body.lenses).toHaveLength(5);
    // Any blocking result decides the review; a raise on it is refused.
    h.service.submitResult(result(h, { lens: 'repo', findings: [blocking()] }));
    await expect(h.service.commission(commission(h, { tier: 'high' }))).resolves.toMatchObject({ body: { tier: 'high' } });
    // A decided review cannot be re-opened by a tier change.
    const medium = harness();
    await medium.service.commission(commission(medium, { tier: 'low' }));
    medium.service.submitResult(result(medium, { lens: 'stranger', findings: [blocking()] }));
    await expect(medium.service.commission(commission(medium, { tier: 'high' }))).rejects.toMatchObject({
      code: 'briefing_review_decided',
      status: 409,
    });
  });

  it('refuses an out-of-bound commission before any side effect', async () => {
    const h = harness();
    const cases: readonly [Record<string, unknown>, RegExp][] = [
      [{ ...commission(h), tier: 'critical' }, /tier must be one of/u],
      [{ ...commission(h), justification: '' }, /justification must be at least 1/u],
      [{ ...commission(h), justification: 'x'.repeat(501) }, /justification must be at most 500/u],
      [{ ...commission(h), title: 'x'.repeat(201) }, /title must be at most 200/u],
      [{ ...commission(h), repoPath: `/${'x'.repeat(4096)}` }, /repoPath must be at most 4096/u],
      [{ ...commission(h), briefing: 'x'.repeat(131_073) }, /briefing exceeds 131072 bytes/u],
      [{ ...commission(h), extra: true }, /unknown field "extra"/u],
    ];
    for (const [body, message] of cases) {
      await expect(h.service.commission(body), JSON.stringify(body).slice(0, 40)).rejects.toThrow(message);
    }
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] })).toHaveLength(0);
  });
});

describe('Nefario briefing review — evidence-bound results', () => {
  it('refuses a blocking finding whose evidence is not a verbatim span of the marked briefing, naming the finding', async () => {
    const h = harness();
    await h.service.commission(commission(h));
    const fromHelper: BriefingReviewFinding = { ...blocking('The five lens sections follow'), code: 'helper-quote' };
    expect(() => h.service.submitResult(result(h, { lens: 'stranger', findings: [fromHelper] }))).toThrow(
      /findings\[0\]\.evidence is not a verbatim span/u,
    );
    const tooShort = blocking('GET /ap');
    expect(() => h.service.submitResult(result(h, { lens: 'stranger', findings: [tooShort] }))).toThrow(
      /findings\[0\]\.evidence must be 8–2000 characters/u,
    );
    const tooLong = blocking('x'.repeat(2001));
    expect(() => h.service.submitResult(result(h, { lens: 'stranger', findings: [tooLong] }))).toThrow(
      /must be 8–2000 characters/u,
    );
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_VERDICT] })).toHaveLength(0);
  });

  it('enforces the finding shape and the verdict/severity consistency at the boundary', async () => {
    const h = harness();
    await h.service.commission(commission(h));
    const base = result(h, { lens: 'stranger' });
    const cases: readonly [Record<string, unknown>, RegExp][] = [
      [{ ...base, verdict: 'READY', findings: [wire(blocking())] }, /READY verdict may not carry a blocking finding/u],
      [{ ...base, verdict: 'CHANGES-NEEDED', findings: [wire(advisory)] }, /CHANGES-NEEDED verdict requires at least one blocking finding/u],
      [{ ...base, findings: [{ ...wire(advisory), code: '9bad' }] }, /findings\[0\]\.code must be 1–80/u],
      [{ ...base, findings: [{ ...wire(advisory), severity: 'critical' }] }, /findings\[0\]\.severity must be blocking\|advisory/u],
      [{ ...base, findings: [{ ...wire(advisory), why_it_blocks: '' }] }, /findings\[0\]\.why_it_blocks must be 1–1000/u],
      [{ ...base, findings: [{ ...wire(advisory), extra: 1 }] }, /findings\[0\] has unknown field "extra"/u],
      [{ ...base, findings: Array.from({ length: 51 }, () => wire(advisory)) }, /more than 50 entries/u],
      [{ ...base, verdict: 'PASS' }, /verdict must be one of READY\|CHANGES-NEEDED/u],
      [{ ...base, lens: 'architecture' }, /lens must be one of/u],
      [{ ...base, briefingSha256: 'abc' }, /briefingSha256 must be a lowercase sha256/u],
    ];
    for (const [body, message] of cases) {
      expect(() => h.service.submitResult(body), JSON.stringify(body).slice(0, 40)).toThrow(message);
    }
  });

  it('binds a result to the armed review: unknown lens, wrong job id and a missing job row are named refusals', async () => {
    const h = harness();
    await h.service.commission(commission(h));
    const armed = armedOf(h);
    expect(() => h.service.submitResult({ ...result(h, { lens: 'stranger' }), lens: 'acceptance' })).toThrow(
      expect.objectContaining({ code: 'briefing_review_lens_unknown', status: 400 }),
    );
    expect(() => h.service.submitResult({ ...result(h, { lens: 'stranger' }), jobId: 'briefing-review-elsewhere-stranger' })).toThrow(
      expect.objectContaining({ code: 'briefing_review_job_mismatch', status: 409 }),
    );
    expect(() => h.service.submitResult({ ...result(h, { lens: 'stranger' }), repoPath: '/elsewhere/refunds' })).toThrow(
      expect.objectContaining({ code: 'briefing_review_not_commissioned', status: 409 }),
    );
    // A job row that carries no marked briefing is not dispatched evidence.
    h.ledger.noteJob(lensJobId(armed.reviewId, 'stranger'), 'touched');
    expect(h.ledger.getJob(lensJobId(armed.reviewId, 'stranger'))).not.toBeNull();
    expect(() => h.service.submitResult({ ...result(h, { lens: 'stranger' }), briefingSha256: 'f'.repeat(64) })).toThrow(
      expect.objectContaining({ code: 'briefing_review_not_commissioned' }),
    );
  });

  it('converges an identical result retry with no second event or notification, and refuses a different one', async () => {
    const h = harness();
    await h.service.commission(commission(h));
    const first = h.service.submitResult(result(h, { lens: 'stranger', findings: [advisory] }));
    const retry = h.service.submitResult(result(h, { lens: 'stranger', findings: [advisory] }));
    expect(retry).toEqual(first);
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_VERDICT] })).toHaveLength(1);
    expect(() => h.service.submitResult(result(h, { lens: 'stranger' }))).toThrow(
      expect.objectContaining({ code: 'briefing_review_result_conflict', status: 409 }),
    );
  });

  it('any CHANGES-NEEDED is decisive at once, and later lens results stay non-decisive', async () => {
    const h = harness();
    await h.service.commission(commission(h, { tier: 'medium' }));
    const decision = h.service.submitResult(result(h, { lens: 'acceptance', findings: [blocking()] }));
    expect(decision).toMatchObject({ decisive: true, aggregate: 'CHANGES-NEEDED', caught: 0 });
    const later = h.service.submitResult(result(h, { lens: 'stranger' }));
    expect(later).toMatchObject({ decisive: false, aggregate: null });
    const decisiveEvents = h.ledger
      .listEventsAfter(0, { kinds: [BRIEFING_REVIEW_VERDICT] })
      .filter((event) => (event.payload as { decisive?: unknown }).decisive === true);
    expect(decisiveEvents).toHaveLength(1);
    expect(decisiveEvents[0]!.payload).toMatchObject({ aggregate: 'CHANGES-NEEDED', lens_verdict: 'CHANGES-NEEDED', round: 1, generation: 1 });
    // One notification, addressed to Gru's machine queue.
    expect(h.notices.size).toBe(1);
    const [notice] = [...h.notices.values()];
    expect(notice).toMatchObject({ kind: BRIEFING_REVIEW_NOTIFICATION_KIND, routing: 'action-required', severity: 'error' });
    expect(String(notice!['title'])).toContain('CHANGES-NEEDED');
    expect(String(notice!['detail'])).toContain('POST /api/notifications/needs-owner');
  });

  it('all lenses READY is one decisive verdict whose caught count is the blocking findings of the superseded round', async () => {
    const h = harness();
    await h.service.commission(commission(h, { tier: 'medium' }));
    h.service.submitResult(result(h, { lens: 'stranger', findings: [blocking(), advisory] }));
    h.service.submitResult(result(h, { lens: 'acceptance', findings: [blocking('Do not touch the payments module sources.'), advisory] }));
    h.service.submitResult(result(h, { lens: 'verification', findings: [blocking()] }));
    const revised = await h.service.commission(commission(h, { tier: 'medium', briefing: `${BRIEFING}\n- The empty history returns an empty array.` }));
    expect(revised.body.round).toBe(2);
    const decisions = ['stranger', 'acceptance'].map((lens) => h.service.submitResult(result(h, { lens, findings: [advisory] })));
    expect(decisions.every((entry) => entry.decisive === false)).toBe(true);
    const ready = h.service.submitResult(result(h, { lens: 'verification' }));
    expect(ready).toMatchObject({ decisive: true, aggregate: 'READY' });
    // Three lenses of the superseded round each reported one blocking finding.
    expect(ready.caught).toBe(3);
    const decisive = h.ledger
      .listEventsAfter(0, { kinds: [BRIEFING_REVIEW_VERDICT] })
      .map((event) => event.payload as { readonly decisive?: boolean; readonly caught?: number; readonly chain_key?: string })
      .filter((payload) => payload.decisive === true);
    expect(decisive).toHaveLength(2);
    expect(decisive[1]).toMatchObject({ caught: 3 });
    expect(decisive[1]!.chain_key).toBe(decisive[0]!.chain_key);
    // A converged retry adds nothing at all.
    const before = h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_VERDICT] }).length;
    h.service.submitResult(result(h, { lens: 'verification' }));
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_VERDICT] })).toHaveLength(before);
    expect(h.notices.size).toBe(2);
  });
});

describe('Nefario briefing review — push-back and the bounded loop', () => {
  it('a push-back is durable and idempotent, refused on a READY review, and conflicts on a different reason', async () => {
    const h = harness();
    await h.service.commission(commission(h));
    h.service.submitResult(result(h, { lens: 'stranger', findings: [blocking()] }));
    const pushback = h.service.pushback({
      repoPath: h.repo.path,
      briefingSha256: armedOf(h).briefingSha256,
      reason: 'Owner ruled the refunds shape in the consult; ship it as written.',
      by: 'gru',
    });
    expect(pushback).toMatchObject({ generation: 1, by: 'gru' });
    expect(h.service.pushback({
      repoPath: h.repo.path,
      briefingSha256: armedOf(h).briefingSha256,
      reason: 'Owner ruled the refunds shape in the consult; ship it as written.',
      by: 'gru',
    })).toEqual(pushback);
    expect(() => h.service.pushback({
      repoPath: h.repo.path,
      briefingSha256: armedOf(h).briefingSha256,
      reason: 'A different reason.',
      by: 'gru',
    })).toThrow(expect.objectContaining({ code: 'briefing_review_pushback_conflict', status: 409 }));
    // A READY review has nothing to push back: dispatch it.
    const ready = harness();
    await ready.service.commission(commission(ready));
    ready.service.submitResult(result(ready, { lens: 'stranger' }));
    expect(() => ready.service.pushback({
      repoPath: ready.repo.path,
      briefingSha256: armedOf(ready).briefingSha256,
      reason: 'skip it',
      by: 'gru',
    })).toThrow(expect.objectContaining({ code: 'briefing_review_already_ready', status: 409 }));
  });

  it('caps a chain at three trailing CHANGES-NEEDED rounds with an owner-escalation instruction, still converges an exact re-commission, and resets on READY', async () => {
    const h = harness();
    const revision = (n: number): string => `${BRIEFING}\n- Revision ${String(n)} settles the empty-history case.`;
    // Rounds 1 and 2 reach CHANGES-NEEDED; round 3 reaches READY, which ends
    // the streak so the cap starts counting again.
    for (const round of [1, 2]) {
      const outcome = await h.service.commission(commission(h, { briefing: round === 1 ? BRIEFING : revision(round) }));
      expect(outcome.body.round).toBe(round);
      h.service.submitResult(result(h, { lens: 'stranger', findings: [blocking()] }));
    }
    const third = await h.service.commission(commission(h, { briefing: revision(3) }));
    expect(third.body.round).toBe(3);
    expect(h.service.submitResult(result(h, { lens: 'stranger' })).aggregate).toBe('READY');
    // Three fresh trailing CHANGES-NEEDED rounds (4, 5, 6) reach the cap.
    for (const round of [4, 5, 6]) {
      const outcome = await h.service.commission(commission(h, { briefing: revision(round) }));
      expect(outcome.body.round).toBe(round);
      h.service.submitResult(result(h, { lens: 'stranger', findings: [blocking()] }));
    }
    const capped = commission(h, { briefing: revision(7) });
    await expect(h.service.commission(capped)).rejects.toMatchObject({ code: 'briefing_review_round_cap', status: 409 });
    await expect(h.service.commission(capped)).rejects.toThrow(/POST \/api\/notifications\/needs-owner/u);
    await expect(h.service.commission(capped)).rejects.toThrow(/scope-design/u);
    // The refused revision created nothing; an exact re-commission of the
    // decided sixth round still converges.
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] })).toHaveLength(6);
    const sixth = readArmed(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] }).at(-1)!)!;
    await expect(h.service.commission(commission(h, { briefing: revision(6) }))).resolves.toMatchObject({
      status: 200,
      body: { reviewId: sixth.reviewId, round: 6 },
    });
  });
});

describe('Nefario briefing review — the staged dispatch gate', () => {
  it('stage 1 admits a dispatch without provenance and attaches a matching READY review automatically', async () => {
    const h = harness();
    await h.service.commission(commission(h));
    // Pending is fine at stage 1: readiness is advisory here.
    expect(h.service.admitDispatch({
      jobId: 'job-1',
      repoPath: h.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    })).toBeNull();
    h.service.submitResult(result(h, { lens: 'stranger' }));
    const attached = h.service.admitDispatch({
      jobId: 'job-1',
      repoPath: h.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    });
    expect(attached).toMatchObject({ verdict: 'READY', round: 1, generation: 1, tier: 'low', pushbackReason: null });
    // A false claim is refused in stage 1 too.
    expect(() => h.service.admitDispatch({
      jobId: 'job-1',
      repoPath: h.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: { rounds: 1, verdict: 'CHANGES-NEEDED', briefingSha256: armedOf(h).briefingSha256 },
    })).toThrow(expect.objectContaining({ code: 'briefing_review_pending', status: 409 }));
    // ...and so is a different briefing's sha, naming both values.
    expect(() => h.service.admitDispatch({
      jobId: 'job-1',
      repoPath: h.repo.path,
      title: 'Refunds endpoint',
      briefing: `${BRIEFING}\n- Late edit.`,
      requested: { rounds: 1, verdict: 'READY', briefingSha256: armedOf(h).briefingSha256 },
    })).toThrow(/does not match|differs from|but the briefing being dispatched is/u);
    // A matching CHANGES-NEEDED review is admitted at stage 1 (advisory).
    const advisoryStage = harness();
    await advisoryStage.service.commission(commission(advisoryStage));
    advisoryStage.service.submitResult(result(advisoryStage, { lens: 'stranger', findings: [blocking()] }));
    expect(advisoryStage.service.admitDispatch({
      jobId: 'job-2',
      repoPath: advisoryStage.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: { rounds: 1, verdict: 'CHANGES-NEEDED', briefingSha256: armedOf(advisoryStage).briefingSha256 },
    })).toMatchObject({ verdict: 'CHANGES-NEEDED' });
  });

  it('stage 1 admits a truthful CHANGES-NEEDED provenance and refuses a block once the review is pushed back', async () => {
    const h = harness();
    await h.service.commission(commission(h));
    h.service.submitResult(result(h, { lens: 'stranger', verdict: 'CHANGES-NEEDED', findings: [blocking()] }));
    const armed = armedOf(h);
    const requested = { rounds: 1, verdict: 'CHANGES-NEEDED' as const, briefingSha256: armed.briefingSha256 };
    const provenance = h.service.admitDispatch({
      jobId: 'heist-stage1-changes',
      repoPath: h.repo.path,
      title: 'Refunds endpoint',
      briefing: h.briefing,
      requested,
    });
    expect(provenance).toMatchObject({ verdict: 'CHANGES-NEEDED', reviewId: armed.reviewId, round: 1, generation: 1 });
    h.service.pushback({
      repoPath: h.repo.path,
      briefingSha256: armed.briefingSha256,
      reason: 'the reviewer misread the owner ruling',
      by: 'gru',
    });
    let refusal: unknown;
    try {
      h.service.admitDispatch({
        jobId: 'heist-stage1-changes-2',
        repoPath: h.repo.path,
        title: 'Refunds endpoint',
        briefing: h.briefing,
        requested,
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(BriefingReviewError);
    expect(refusal).toMatchObject({ code: 'briefing_review_invalid_request', status: 400 });
  });

  it('stage 2 refuses a high-tier pending, CHANGES-NEEDED or older-round dispatch before any job and records the refusal', async () => {
    const h = harness({ stage: 2 });
    await h.service.commission(commission(h, { tier: 'high' }));
    const attempt = () => h.service.admitDispatch({
      jobId: 'job-9',
      repoPath: h.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    });
    expect(attempt).toThrow(expect.objectContaining({ code: 'briefing_review_pending', status: 409 }));
    h.service.submitResult(result(h, { lens: 'stranger', findings: [blocking()] }));
    expect(attempt).toThrow(expect.objectContaining({ code: 'briefing_review_not_ready', status: 409 }));
    // A revised briefing is a new sha: the older round does not cover it.
    const revised = `${BRIEFING}\n- The empty history returns an empty array.`;
    expect(() => h.service.admitDispatch({
      jobId: 'job-9',
      repoPath: h.repo.path,
      title: 'Refunds endpoint',
      briefing: revised,
      requested: undefined,
    })).toThrow(expect.objectContaining({ code: 'briefing_review_required', status: 409 }));
    const refusals = h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_REFUSED] });
    expect(refusals.map((event) => (event.payload as { readonly reason?: string }).reason)).toEqual(['pending', 'changes-needed', 'missing']);
    expect(refusals[0]!.payload).toMatchObject({ job_id: 'job-9', tier: 'high' });
    expect(refusals[2]!.payload).toMatchObject({ repo_path: h.repo.path, title: 'Refunds endpoint', job_id: 'job-9', tier: 'high' });
    // A build that never reached the service leaves no job row behind.
    expect(h.ledger.getJob('job-9')).toBeNull();
  });

  it('stage 3 enforces medium as well as high; low stays advisory, and stage 2 leaves medium advisory', async () => {
    // Stage 2: a pending medium review is advisory, and a truthful
    // CHANGES-NEEDED block for it is admitted and recorded (not a 409).
    const s2 = harness({ stage: 2 });
    await s2.service.commission(commission(s2, { tier: 'medium' }));
    const m2 = armedOf(s2);
    expect(s2.service.admitDispatch({
      jobId: 'job-medium-s2',
      repoPath: s2.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    })).toBeNull();
    s2.service.submitResult(result(s2, { lens: 'stranger', findings: [blocking()] }));
    expect(s2.service.admitDispatch({
      jobId: 'job-medium-s2-changes',
      repoPath: s2.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: { rounds: 1, verdict: 'CHANGES-NEEDED', briefingSha256: m2.briefingSha256 },
    })).toMatchObject({ verdict: 'CHANGES-NEEDED', tier: 'medium', round: 1 });

    // Stage 3: the same medium review is held pending, then CHANGES-NEEDED.
    const s3 = harness({ stage: 3 });
    await s3.service.commission(commission(s3, { tier: 'medium' }));
    expect(() => s3.service.admitDispatch({
      jobId: 'job-medium-s3',
      repoPath: s3.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    })).toThrow(expect.objectContaining({ code: 'briefing_review_pending', status: 409 }));
    s3.service.submitResult(result(s3, { lens: 'stranger', findings: [blocking()] }));
    expect(() => s3.service.admitDispatch({
      jobId: 'job-medium-s3',
      repoPath: s3.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    })).toThrow(expect.objectContaining({ code: 'briefing_review_not_ready', status: 409 }));
    expect(s3.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_REFUSED] })[0]!.payload).toMatchObject({ tier: 'medium', reason: 'pending' });

    // Low is advisory even at stage 3: a pending low review never holds a dispatch.
    const low = harness({ stage: 3 });
    await low.service.commission(commission(low, { tier: 'low' }));
    expect(low.service.admitDispatch({
      jobId: 'job-low-s3',
      repoPath: low.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    })).toBeNull();
  });

  it('stage 3 still enforces high, and the enforced-tier chain fallback cannot be bypassed by a medium revision', async () => {
    // Stage 3 high: pending and CHANGES-NEEDED are held exactly like stage 2.
    const high = harness({ stage: 3 });
    await high.service.commission(commission(high, { tier: 'high' }));
    expect(() => high.service.admitDispatch({
      jobId: 'job-high-s3',
      repoPath: high.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    })).toThrow(expect.objectContaining({ code: 'briefing_review_pending', status: 409 }));
    high.service.submitResult(result(high, { lens: 'stranger', findings: [blocking()] }));
    expect(() => high.service.admitDispatch({
      jobId: 'job-high-s3',
      repoPath: high.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    })).toThrow(expect.objectContaining({ code: 'briefing_review_not_ready', status: 409 }));

    // Stage 3 medium: a revised briefing under the reviewed chain is refused
    // as required (with the medium tier on the refusal event), not admitted.
    const medium = harness({ stage: 3 });
    await medium.service.commission(commission(medium, { tier: 'medium' }));
    medium.service.submitResult(result(medium, { lens: 'stranger', findings: [blocking()] }));
    const revised = `${BRIEFING}\n- The empty history returns an empty array.`;
    expect(() => medium.service.admitDispatch({
      jobId: 'job-medium-revised-s3',
      repoPath: medium.repo.path,
      title: 'Refunds endpoint',
      briefing: revised,
      requested: undefined,
    })).toThrow(expect.objectContaining({ code: 'briefing_review_required', status: 409 }));
    expect(medium.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_REFUSED] })[0]!.payload).toMatchObject({ tier: 'medium', reason: 'missing' });

    // Stage 2 leaves medium advisory: the same revised briefing is admitted.
    const s2 = harness({ stage: 2 });
    await s2.service.commission(commission(s2, { tier: 'medium' }));
    s2.service.submitResult(result(s2, { lens: 'stranger', findings: [blocking()] }));
    expect(s2.service.admitDispatch({
      jobId: 'job-medium-revised-s2',
      repoPath: s2.repo.path,
      title: 'Refunds endpoint',
      briefing: revised,
      requested: undefined,
    })).toBeNull();
  });

  it('stage 2 admits the exact READY sha or a recorded push-back, and never auto-attaches another repository\'s review', async () => {
    const h = harness({ stage: 2 });
    await h.service.commission(commission(h, { tier: 'high' }));
    for (const lens of ['stranger', 'acceptance', 'verification', 'repo']) {
      expect(h.service.submitResult(result(h, { lens, findings: [advisory] })).aggregate).toBeNull();
    }
    expect(h.service.submitResult(result(h, { lens: 'scope', findings: [advisory] })).aggregate).toBe('READY');
    expect(h.service.admitDispatch({
      jobId: 'job-10',
      repoPath: h.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: { rounds: 1, verdict: 'READY', briefingSha256: armedOf(h).briefingSha256 },
    })).toMatchObject({ verdict: 'READY' });
    // A push-back admits the exact sha without a block.
    const pushed = harness({ stage: 2 });
    await pushed.service.commission(commission(pushed, { tier: 'high' }));
    pushed.service.submitResult(result(pushed, { lens: 'stranger', findings: [blocking()] }));
    pushed.service.pushback({
      repoPath: pushed.repo.path,
      briefingSha256: armedOf(pushed).briefingSha256,
      reason: 'The owner ruled this exact shape.',
      by: 'gru',
    });
    expect(pushed.service.admitDispatch({
      jobId: 'job-11',
      repoPath: pushed.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    })).toMatchObject({ verdict: 'PUSHED-BACK', pushbackReason: 'The owner ruled this exact shape.' });
    // The same briefing text reviewed in another repository never attaches.
    expect(h.service.admitDispatch({
      jobId: 'job-12',
      repoPath: '/somewhere/else/refunds-api',
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    })).toBeNull();
  });
});

describe('Nefario briefing review — stop state and missing helper', () => {
  it('enabled = false refuses a commission with 503, admits every dispatch and sends a zeroed card', async () => {
    const h = harness({ enabled: false });
    await expect(h.service.commission(commission(h))).rejects.toMatchObject({ code: 'briefing_review_disabled', status: 503 });
    expect(h.service.admitDispatch({
      jobId: 'job-1',
      repoPath: h.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: undefined,
    })).toBeNull();
    // A stale provenance block is ignored, not turned into a 503: the stop
    // state admits every dispatch (a rollback must not break dispatch).
    expect(h.service.admitDispatch({
      jobId: 'job-2',
      repoPath: h.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
      requested: { rounds: 1, verdict: 'READY', briefingSha256: 'a'.repeat(64) },
    })).toBeNull();
    expect(h.log).toHaveBeenCalledWith(
      'warn',
      'ignoring briefing_review provenance while the briefing review is disabled',
      { job: 'job-2' },
    );
    expect(h.service.boardView()).toEqual({
      armed: 0,
      round: null,
      tier: null,
      verdictsToday: 0,
      caught: 0,
      refusalsToday: 0,
      stage: 'advisory',
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] })).toHaveLength(0);
  });

  it('a workflow package without the verified lens helper refuses the commission with a named 503 and dispatches nothing', async () => {
    const bundle = loadBundledWorkflowRuntime();
    const withoutHelper = {
      ...bundle,
      files: new Map([...bundle.files].filter(([path]) => path !== 'skills/briefing-review/lenses.md')),
    };
    const h = harness({ workflow: () => withoutHelper as typeof bundle });
    await expect(h.service.commission(commission(h))).rejects.toMatchObject({
      code: 'briefing_review_workflow_unavailable',
      status: 503,
    });
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] })).toHaveLength(0);
  });

  it('settles a lens job\'s report debt from the accepted result when the lane delivers afterwards, so no action-required row is carded', async () => {
    const h = harness();
    await h.service.commission(commission(h));
    const jobId = lensJobId(armedOf(h).reviewId, 'stranger');
    h.service.submitResult(result(h, { lens: 'stranger', findings: [advisory] }));
    // The lane's turn ends after it submitted: the debt opens on the next
    // reconcile, and that same pass answers it from the accepted result.
    h.ledger.setJobStatus(jobId, 'working');
    const delivered = h.ledger.setJobStatus(jobId, 'delivered');
    h.ledger.openReportObligation({ jobId, observedAtSeq: delivered === null ? 0 : 1 });
    const postIncident = vi.fn(() => ({ id: 'incident-1' }));
    const report = reconcileReportClosures({ ledger: h.ledger, notifications: { postIncident } });
    expect(report.answered).toBe(1);
    expect(postIncident).not.toHaveBeenCalled();
    expect(h.ledger.findReportObligation(jobId)?.state).toBe('settled');
  });

  it('a lens result answers its own job\'s report debt so a commission leaves no action-required row per lens', async () => {
    const h = harness();
    await h.service.commission(commission(h));
    const armed = armedOf(h);
    const jobId = lensJobId(armed.reviewId, 'stranger');
    // The lane delivered before its result arrived: the report debt is open.
    h.ledger.setJobStatus(jobId, 'working');
    const delivered = h.ledger.setJobStatus(jobId, 'delivered');
    h.ledger.openReportObligation({ jobId, observedAtSeq: delivered === null ? 0 : 1 });
    expect(h.ledger.findReportObligation(jobId)?.state).toBe('open');
    h.service.submitResult(result(h, { lens: 'stranger', findings: [advisory] }));
    // The accepted result answers its own debt; nothing is left for Gru.
    expect(h.ledger.findReportObligation(jobId)?.state).toBe('settled');
    expect(armed.reviewId).toBe(armedOf(h).reviewId);
  });
});

describe('Nefario briefing review — refusal vocabulary', () => {
  it('is a named error with the status that says what to fix', () => {
    const error = new BriefingReviewError('briefing_review_not_hosted', 'not hosted', 503);
    expect(error).toMatchObject({ name: 'BriefingReviewError', code: 'briefing_review_not_hosted', status: 503 });
    expect(error.message).toBe('not hosted');
  });
});
