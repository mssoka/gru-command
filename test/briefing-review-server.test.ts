import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Role } from '../src/config.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { DispatchService } from '../src/dispatch/service.js';
import type { WaveRunner } from '../src/dispatch/perkins.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { BriefingReviewService } from '../src/briefing-review/service.js';
import { BRIEFING_REVIEW_ARMED, BRIEFING_REVIEW_DISPATCHED, BRIEFING_REVIEW_REFUSED, readArmed } from '../src/briefing-review/events.js';
import { lensJobId } from '../src/briefing-review/types.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Nefario's HTTP surface (GH-505): the three briefing-review endpoints behind
 * the pairing token, the dispatch gate running BEFORE any job row, and the
 * provenance a dispatched lane carries. The gate and aggregation logic are
 * unit-tested in briefing-review.test.ts; this suite proves the wire shape.
 */

const TOKEN = 'briefing-review-token';
const FAKE_CAPABILITIES = { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false } as const;

const BRIEFING = [
  'Heist: add the refunds endpoint.',
  '- GET /api/refunds returns the caller\'s own refunds, newest first.',
  '- Acceptance: one test adds a refund then reads it back in the same order.',
].join('\n');

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Harness {
  readonly port: number;
  readonly ledger: LedgerApi;
  readonly prompts: string[];
  readonly repo: FixtureRepo;
  close(): Promise<void>;
}

async function boot(options: { stage?: 1 | 2; disabled?: boolean; hosted?: boolean } = {}): Promise<Harness> {
  const repo = makeFixtureRepo('refunds-api');
  cleanups.push(() => repo.cleanup());
  const dir = mkdtempSync(join(tmpdir(), 'gru-briefing-review-http-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'config.toml'),
    `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n[briefing_review]\nenabled = ${String(!(options.disabled ?? false))}\nstage = ${String(options.stage ?? 1)}\n`,
    'utf-8',
  );
  const config = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  cleanups.push(() => db.close());
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'), ledger);
  const prompts: string[] = [];
  let spawned = 0;
  const spawner = async (role: Role): Promise<AgentHandle> => {
    spawned += 1;
    const id = `agent-${String(spawned)}`;
    return {
      role,
      id,
      sessionFile: null,
      capabilities: FAKE_CAPABILITIES,
      async prompt(text: string) { prompts.push(text); },
      async steer() {},
      async followUp() {},
      subscribe() { return () => {}; },
      health() { return { state: 'idle' as const, lastActivity: null, sessionFile: null }; },
      async dispose() {},
    } as unknown as AgentHandle;
  };
  const dispatch = new DispatchService({ ledger, worktrees, spawner });
  const briefingReview = new BriefingReviewService({
    config: config.briefingReview,
    ledger,
    notifications: { post: (input) => ({ id: input.id ?? 'generated', ts: new Date().toISOString(), ...input }) as never },
    dispatch: (input) => dispatch.dispatch(input),
    apiBase: () => 'http://127.0.0.1:4100',
    headSha: () => repo.head(),
  });
  const wave = { activeReview: () => null, shutdown: async () => {} } as unknown as WaveRunner;
  const server = createDispatchServer({
    config,
    dispatch,
    wave,
    ledger,
    pendingProducerBlockers: () => [],
    ...(options.hosted === false ? {} : { briefingReview }),
  });
  const http: HttpServer = createServer((request, response) => {
    if (server.requestHook(request, response, new URL(request.url ?? '/', 'http://localhost').pathname)) return;
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    ledger,
    prompts,
    repo,
    close: async () => {
      await new Promise<void>((resolve) => http.close(() => resolve()));
      server.dispose();
    },
  };
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

const commissionBody = (h: Harness, overrides: Record<string, unknown> = {}) => ({
  repoPath: h.repo.path,
  title: 'Refunds endpoint',
  briefing: BRIEFING,
  tier: 'low',
  justification: 'Touches the refunds API and its tests.',
  ...overrides,
});

function armedOf(h: Harness) {
  const events = h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] });
  return readArmed(events[events.length - 1]!)!;
}

async function readyResult(h: Harness): Promise<{ lens: string; body: Record<string, unknown> }> {
  const armed = armedOf(h);
  return {
    lens: 'stranger',
    body: {
      repoPath: h.repo.path,
      briefingSha256: armed.briefingSha256,
      jobId: lensJobId(armed.reviewId, 'stranger'),
      lens: 'stranger',
      verdict: 'READY',
      findings: [{
        code: 'thin-acceptance',
        severity: 'advisory',
        evidence: 'one test adds a refund then reads it back',
        why_it_blocks: 'one case only; an ordering bug would not fail it',
      }],
    },
  };
}

describe('Nefario HTTP surface', () => {
  it('requires the pairing token, answers 503 when the review is not hosted, and names an unknown subpath', async () => {
    const h = await boot();
    const unauthenticated = await call(h.port, 'POST', '/api/briefing-review', commissionBody(h), null);
    expect(unauthenticated.status).toBe(401);
    expect((await call(h.port, 'POST', '/api/briefing-review/elsewhere', {})).json).toMatchObject({
      error: 'briefing_review_not_found',
      detail: 'unsupported briefing-review route',
    });
    const unhosted = await boot({ hosted: false });
    expect((await call(unhosted.port, 'POST', '/api/briefing-review', commissionBody(unhosted))).json).toMatchObject({
      error: 'briefing_review_not_hosted',
    });
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] })).toHaveLength(0);
    await h.close();
    await unhosted.close();
  });

  it('commissions, records a lens result, and refuses a malformed commission with the named 400 before anything is created', async () => {
    const h = await boot();
    const malformed = await call(h.port, 'POST', '/api/briefing-review', commissionBody(h, { tier: 'critical' }));
    expect(malformed.status).toBe(400);
    expect(malformed.json).toMatchObject({ error: 'briefing_review_invalid_request' });
    expect(String(malformed.json['detail'])).toContain('tier must be one of low|medium|high');
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED] })).toHaveLength(0);

    const commissioned = await call(h.port, 'POST', '/api/briefing-review', commissionBody(h));
    expect(commissioned.status).toBe(202);
    expect(commissioned.json).toMatchObject({ tier: 'low', round: 1, generation: 1, dispatched: true, lenses: ['stranger'] });
    const replay = await call(h.port, 'POST', '/api/briefing-review', commissionBody(h));
    expect(replay.status).toBe(200);
    expect(replay.json['reviewId']).toBe(commissioned.json['reviewId']);

    const submission = await readyResult(h);
    const result = await call(h.port, 'POST', '/api/briefing-review/result', submission.body);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ lens: 'stranger', verdict: 'READY', aggregate: 'READY', decisive: true, caught: 0 });
    // A different result for the same lens is a conflict, not a revision.
    const conflicting = await call(h.port, 'POST', '/api/briefing-review/result', {
      ...submission.body,
      findings: [{ code: 'other-concern', severity: 'advisory', evidence: 'Acceptance: one test adds a refund', why_it_blocks: 'one case only' }],
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.json).toMatchObject({ error: 'briefing_review_result_conflict' });
    // The lens job carries the review markers and the read-only orders.
    const armed = armedOf(h);
    const job = h.ledger.getJob(lensJobId(armed.reviewId, 'stranger'))!;
    expect(job.briefing).toContain(`<<<NEFARIO-BRIEFING ${armed.reviewId}>>>`);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain('READ-ONLY');
    expect(h.prompts[0]).toContain('open no pull request');
    await h.close();
  });

  it('refuses a high-tier dispatch at stage 2 before any job row, records the refusal, and admits the identical dispatch after READY with provenance', async () => {
    const h = await boot({ stage: 2 });
    const commissioned = await call(h.port, 'POST', '/api/briefing-review', commissionBody(h, { tier: 'high' }));
    expect(commissioned.status).toBe(202);
    const armed = armedOf(h);
    const dispatchBody = {
      job_id: 'job-refunds',
      repo_path: h.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
    };
    const held = await call(h.port, 'POST', '/api/dispatch', dispatchBody);
    expect(held.status).toBe(409);
    expect(held.json).toMatchObject({ error: 'briefing_review_pending' });
    expect(h.ledger.getJob('job-refunds')).toBeNull();
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_REFUSED] })).toHaveLength(1);

    // A false claim is refused too, and nothing is dispatched either way.
    const falseClaim = await call(h.port, 'POST', '/api/dispatch', {
      ...dispatchBody,
      briefing_review: { rounds: 1, verdict: 'READY', briefing_sha256: armed.briefingSha256 },
    });
    expect(falseClaim.status).toBe(409);
    expect(falseClaim.json).toMatchObject({ error: 'briefing_review_pending' });

    // Every lens reports READY, then the identical dispatch is admitted.
    for (const lens of armed.lenses) {
      const findings = lens === 'stranger'
        ? [{ code: 'thin-acceptance', severity: 'advisory', evidence: 'one test adds a refund then reads it back', why_it_blocks: 'one case only' }]
        : [];
      const submitted = await call(h.port, 'POST', '/api/briefing-review/result', {
        repoPath: h.repo.path,
        briefingSha256: armed.briefingSha256,
        jobId: lensJobId(armed.reviewId, lens),
        lens,
        verdict: 'READY',
        findings,
      });
      expect(submitted.status).toBe(200);
    }
    const admitted = await call(h.port, 'POST', '/api/dispatch', {
      ...dispatchBody,
      briefing_review: { rounds: 1, verdict: 'READY', briefing_sha256: armed.briefingSha256 },
    });
    expect(admitted.status).toBe(202);
    expect(admitted.json).toMatchObject({ job_id: 'job-refunds' });
    const recorded = h.ledger
      .listEventsAfter(0, { kinds: [BRIEFING_REVIEW_DISPATCHED] })
      .map((event) => event.payload as Record<string, unknown>);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      job_id: 'job-refunds',
      review_id: armed.reviewId,
      briefing_sha_256: armed.briefingSha256,
      round: 1,
      generation: 1,
      verdict: 'READY',
      tier: 'high',
    });
    // The dispatched lane's own prompt carries the reviewed briefing verbatim.
    const dispatchedPrompt = h.prompts.at(-1)!;
    expect(dispatchedPrompt).toContain('Dispatch briefing — job job-refunds');
    expect(dispatchedPrompt).toContain(BRIEFING);
    await h.close();
  });

  it('answers the documented 503 for a disabled install and still admits the dispatch', async () => {
    const h = await boot({ disabled: true });
    const disabled = await call(h.port, 'POST', '/api/briefing-review', commissionBody(h));
    expect(disabled.status).toBe(503);
    expect(disabled.json).toMatchObject({ error: 'briefing_review_disabled' });
    const admitted = await call(h.port, 'POST', '/api/dispatch', {
      job_id: 'job-disabled',
      repo_path: h.repo.path,
      title: 'Refunds endpoint',
      briefing: BRIEFING,
    });
    expect(admitted.status).toBe(202);
    expect(h.ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_DISPATCHED] })).toHaveLength(0);
    await h.close();
  });
});
