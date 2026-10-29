import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { loadConfig } from '../src/config.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { DispatchService } from '../src/dispatch/service.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { flipJobToWorking } from '../src/dispatch/fix-directive.js';
import { BLIND_RELEASED_EVENT, blindCoverageOf } from '../src/dispatch/blind-review.js';
import type { Role } from '../src/config.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Issue #513: the commissioner's audited release of the same-target blind
 * coverage a delivered blind report holds, so a corrected review of that
 * target can be commissioned. Every case drives the HTTP surface (the
 * commissioning gate and the release control); the ledger is read only to
 * prove what was and was not written. Deterministic fixtures, no paid reviewer.
 */

const TOKEN = 'release-token';
const PR = 'https://git.example.invalid/o/r/pull/513';
const TARGET = 'f'.repeat(40);
const BASE = 'a'.repeat(40);
const REASON = 'the package lacked material the commission required, so this report cannot serve as a completed review';
const RELEASE_KIND = 'review.blind-coverage-released';

const CAPS: AgentCapabilities = {
  streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false,
};

const cleanupRepos: FixtureRepo[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
});

interface Harness {
  readonly port: number;
  readonly ledger: LedgerApi;
  readonly dispatch: DispatchService;
  readonly repo: FixtureRepo;
  /** The raw event rows of one job, oldest first, exactly as stored. */
  rows(jobId: string): string[];
  /** Keep the reviewer turn of this job running until `releaseHeld` (it stays `working`). */
  hold(jobId: string): void;
  releaseHeld(jobId: string): void;
  /** The next reviewer sessions cannot be read by the access observer. */
  unreadableSessions(on: boolean): void;
}

async function boot(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-blind-release-'));
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  mkdirSync(join(dir, 'wtroot'));
  mkdirSync(join(dir, 'wtpreserve'));
  const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'), ledger);
  const held = new Map<string, { gate: Promise<void>; open: () => void }>();
  let unreadable = false;
  let spawns = 0;
  const spawner = async (role: Role): Promise<AgentHandle> => {
    spawns += 1;
    const id = `agent-${spawns}`;
    const sessionFile = join(dir, `${id}.jsonl`);
    writeFileSync(sessionFile, '');
    return {
      role, id, sessionFile, capabilities: CAPS,
      async prompt(text: string) {
        if (role !== 'minion') return;
        for (const [jobId, hold] of held) if (text.includes(jobId)) await hold.gate;
      },
      async steer() {}, async followUp() {},
      subscribe() { return () => {}; },
      health() { return { state: 'idle' as const, lastActivity: null, sessionFile }; },
      async dispose() {},
    };
  };
  const dispatch = new DispatchService({
    ledger,
    worktrees,
    spawner,
    sessionToolResults: () => (unreadable ? null : []),
    allowUnboundBlindPackages: true,
  });
  const wave = new WaveRunner({ ledger, worktrees, spawner, bus: new EventBus({}) });
  const server = createDispatchServer({ pendingProducerBlockers: () => [], config: cfg, dispatch, wave, ledger });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  closers.push(async () => {
    for (const hold of held.values()) hold.open();
    await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
    await wave.shutdown();
    db.close();
  });
  const repo = makeFixtureRepo('fixture-blind-release');
  cleanupRepos.push(repo);
  return {
    port: (http.address() as AddressInfo).port,
    ledger,
    dispatch,
    repo,
    rows: (jobId) => (db.handle.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq ASC').all(jobId) as unknown[]).map((row) => JSON.stringify(row)),
    hold(jobId) {
      let open!: () => void;
      const gate = new Promise<void>((resolveGate) => { open = resolveGate; });
      held.set(jobId, { gate, open });
    },
    releaseHeld(jobId) { held.get(jobId)?.open(); },
    unreadableSessions(on) { unreadable = on; },
  };
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { status: res.status, json: ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown> };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

const validPackage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  base_sha: BASE,
  target_sha: TARGET,
  files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }],
  ...overrides,
});

const blindReview = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  job_id: id,
  repo_path: '',
  title: 'review (blind)',
  briefing: 'Review the immutable package read-only.',
  deliverable: 'review',
  target_ref: PR,
  target_sha: TARGET,
  parent_job_id: 'parent',
  ...extra,
});

async function dispatchParent(h: Harness): Promise<void> {
  const parent = await call(h.port, 'POST', '/api/dispatch', { job_id: 'parent', repo_path: h.repo.path, title: 'feature', briefing: 'Build the feature.' });
  expect(parent.status).toBe(202);
  await waitFor(() => h.ledger.latestJobEvent('parent', 'job.delivered') !== null);
}

/** Commission an isolated blind reviewer; resolves once it admitted (202). */
async function commission(h: Harness, id: string, extra: Record<string, unknown> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  return call(h.port, 'POST', '/api/dispatch', blindReview(id, { repo_path: h.repo.path, input_package: validPackage(), ...extra }));
}

/** A blind reviewer that delivered a clean report (status `delivered`). */
async function deliveredReviewer(h: Harness, id: string): Promise<void> {
  const created = await commission(h, id);
  expect(created.status, JSON.stringify(created.json)).toBe(202);
  await waitFor(() => h.ledger.latestJobEvent(id, 'job.delivered') !== null);
  await waitFor(() => h.ledger.getJob(id)?.status === 'delivered');
}

async function dismiss(h: Harness, id: string): Promise<void> {
  const settled = await call(h.port, 'POST', `/api/jobs/${id}/disposition`, { outcome: 'dismissed', note: 'the report could not be used', by: 'parent' });
  expect(settled.status, JSON.stringify(settled.json)).toBe(200);
  expect(h.ledger.getJob(id)?.status).toBe('done');
}

const releasePath = (id: string): string => `/api/dispatch/jobs/${id}/blind-coverage/release`;
const coveragePath = (id: string): string => `/api/dispatch/jobs/${id}/blind-coverage`;
const RELEASE_BODY = { reason: REASON, by: 'gru' };
const release = (h: Harness, id: string, body: unknown = RELEASE_BODY) => call(h.port, 'POST', releasePath(id), body);

describe('blind coverage release (issue #513)', () => {
  it('A1: a dismissed blind report releases its coverage and a corrected same-target commission is admitted, naming it in replaces', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    await dismiss(h, 'rev-1');
    const before = h.rows('rev-1');

    const released = await release(h, 'rev-1');
    expect(released.status, JSON.stringify(released.json)).toBe(200);
    expect(released.json).toMatchObject({ job_id: 'rev-1', idempotent: false });
    const after = h.rows('rev-1');
    // Everything recorded before the release is untouched; exactly one event was added.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(JSON.parse(after.at(-1)!)).toMatchObject({ job_id: 'rev-1', kind: RELEASE_KIND });
    expect(h.ledger.latestJobEvent('rev-1', RELEASE_KIND)?.payload).toEqual({
      reason: REASON,
      by: 'gru',
      target_sha: TARGET,
      package_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });

    const corrected = await commission(h, 'rev-2');
    expect(corrected.status, `the corrected commission was refused: ${JSON.stringify(corrected.json)}`).toBe(202);
    expect(h.ledger.latestJobEvent('rev-2', 'review.blind-input-admitted')?.payload).toMatchObject({ role: 'blind', replaces: ['rev-1'] });
    expect(h.ledger.getJob('rev-1')?.status).toBe('done');
  });

  it('A2: without a release the corrected commission is refused blind_coverage_owned, before and after the handback is dismissed', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    const beforeDismissal = await commission(h, 'rev-2');
    expect(beforeDismissal.status).toBe(409);
    expect(beforeDismissal.json).toMatchObject({ error: 'blind_coverage_owned', coverage_job_id: 'rev-1' });
    expect(String(beforeDismissal.json['correction'])).toContain(`POST /api/dispatch/jobs/rev-1/blind-coverage/release`);

    await dismiss(h, 'rev-1');
    expect((await call(h.port, 'GET', coveragePath('rev-1'))).json).toMatchObject({ state: 'qualifying', qualifying: true, released: null });
    const afterDismissal = await commission(h, 'rev-3');
    expect(afterDismissal.status).toBe(409);
    expect(afterDismissal.json).toMatchObject({ error: 'blind_coverage_owned', coverage_job_id: 'rev-1' });
    expect(h.ledger.getJob('rev-2')).toBeNull();
    expect(h.ledger.getJob('rev-3')).toBeNull();
  });

  it('A3: a live sibling cannot be released and still owns the coverage', async () => {
    const h = await boot();
    await dispatchParent(h);
    h.hold('rev-live');
    const created = await commission(h, 'rev-live');
    expect(created.status).toBe(202);
    await waitFor(() => h.ledger.getJob('rev-live')?.status === 'working');
    const before = h.rows('rev-live');

    const refused = await release(h, 'rev-live');
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: 'blind_coverage_live', job_status: 'working' });
    expect(h.rows('rev-live')).toEqual(before);

    const replacement = await commission(h, 'rev-2');
    expect(replacement.status).toBe(409);
    expect(replacement.json).toMatchObject({ error: 'blind_coverage_owned', coverage_job_id: 'rev-live' });
    h.releaseHeld('rev-live');
  });

  it('A4 blind_coverage_not_blind: a claims, an unclassified and a never-admitted job hold no coverage to release', async () => {
    const h = await boot();
    await dispatchParent(h);
    for (const [id, extra] of [
      ['rev-claims', { review_role: 'claims', title: 'review (claims)', input_package: undefined }],
      ['rev-plain', { title: 'edge review', input_package: undefined }],
    ] as const) {
      const created = await commission(h, id, extra);
      expect(created.status, JSON.stringify(created.json)).toBe(202);
      await waitFor(() => h.ledger.getJob(id)?.status === 'delivered');
    }
    for (const id of ['rev-claims', 'rev-plain', 'parent']) {
      const before = h.rows(id);
      const refused = await release(h, id);
      expect(refused.status, id).toBe(409);
      expect(refused.json, id).toMatchObject({ error: 'blind_coverage_not_blind' });
      expect(h.rows(id), id).toEqual(before);
    }
  });

  it('A4 blind_coverage_live: a reviewer that has not delivered is never released, whatever else its status says', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    // delivered -> in-review -> blocked -> parked -> binned are all legal moves.
    for (const status of ['in-review', 'blocked', 'parked', 'binned'] as const) {
      h.ledger.setJobStatus('rev-1', status);
      const before = h.rows('rev-1');
      const refused = await release(h, 'rev-1');
      expect(refused.status, status).toBe(409);
      expect(refused.json, status).toMatchObject({ error: 'blind_coverage_live', job_status: status });
      expect(h.rows('rev-1'), status).toEqual(before);
    }
    expect(h.ledger.latestJobEvent('rev-1', RELEASE_KIND)).toBeNull();
  });

  it('A4 blind_coverage_not_owned: a report that is invalidated, unattested or unobserved owns no coverage to release', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-invalidated');
    await call(h.port, 'POST', '/api/dispatch/blind-access', {
      job_id: 'rev-invalidated', tool_results: [{ tool_name: 'bash', text: 'docs/issues/305-review.md:1:x' }],
    });
    const unattested = await commission(h, 'rev-unattested', { input_package: undefined, target_sha: 'e'.repeat(40) });
    expect(unattested.status, JSON.stringify(unattested.json)).toBe(202);
    await waitFor(() => h.ledger.getJob('rev-unattested')?.status === 'delivered');
    h.unreadableSessions(true);
    const unobserved = await commission(h, 'rev-unobserved', { target_sha: 'd'.repeat(40), input_package: validPackage({ target_sha: 'd'.repeat(40) }) });
    expect(unobserved.status, JSON.stringify(unobserved.json)).toBe(202);
    await waitFor(() => h.ledger.getJob('rev-unobserved')?.status === 'delivered');

    for (const [id, state] of [['rev-invalidated', 'invalidated'], ['rev-unattested', 'unattested'], ['rev-unobserved', 'unobserved']] as const) {
      const before = h.rows(id);
      const refused = await release(h, id);
      expect(refused.status, id).toBe(409);
      expect(refused.json, id).toMatchObject({ error: 'blind_coverage_not_owned', coverage_state: state });
      expect(h.rows(id), id).toEqual(before);
    }
  });

  it('A4 invalid_request: a missing, empty, blank, over-long or non-string reason, a by other than gru, or an unreadable body is a 400', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    await dismiss(h, 'rev-1');
    const before = h.rows('rev-1');
    const longest = 'r'.repeat(500);
    const bodies: readonly [string, unknown][] = [
      ['no body', undefined],
      ['empty object', {}],
      ['missing reason', { by: 'gru' }],
      ['empty reason', { reason: '', by: 'gru' }],
      ['blank reason', { reason: '  \n\t ', by: 'gru' }],
      ['numeric reason', { reason: 7, by: 'gru' }],
      ['over-long reason', { reason: 'r'.repeat(501), by: 'gru' }],
      ['missing by', { reason: REASON }],
      ['by silas', { reason: REASON, by: 'silas' }],
      ['by owner', { reason: REASON, by: 'owner' }],
      ['numeric by', { reason: REASON, by: 1 }],
      ['malformed JSON', '{"reason": '],
      ['a JSON array', '[1]'],
    ];
    for (const [name, body] of bodies) {
      // Called directly: an undefined body must stay absent, not become the default.
      const refused = await call(h.port, 'POST', releasePath('rev-1'), body);
      expect(refused.status, name).toBe(400);
      expect(refused.json, name).toMatchObject({ error: 'invalid_request' });
      expect(typeof refused.json['correction'], name).toBe('string');
      expect(h.rows('rev-1'), name).toEqual(before);
    }
    // 500 characters is the longest reason; it is kept as sent (trimmed).
    const accepted = await release(h, 'rev-1', { reason: `  ${longest}  `, by: 'gru' });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    expect(h.ledger.latestJobEvent('rev-1', RELEASE_KIND)?.payload).toMatchObject({ reason: longest });
  });

  it('A4 blind_coverage_already_released: a different reason after a release is refused and writes nothing', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    expect((await release(h, 'rev-1')).status).toBe(200);
    const before = h.rows('rev-1');
    const refused = await release(h, 'rev-1', { reason: 'a different reason', by: 'gru' });
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ error: 'blind_coverage_already_released', released: { by: 'gru', reason: REASON } });
    expect(h.rows('rev-1')).toEqual(before);
  });

  it('A4 request shape: an unknown job is 404 and an unauthenticated request is 401, neither writing anything', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    const before = h.rows('rev-1');
    const missing = await release(h, 'no-such-job');
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ error: 'job_not_found' });
    const anonymous = await call(h.port, 'POST', releasePath('rev-1'), { reason: REASON, by: 'gru' }, {});
    expect(anonymous.status).toBe(401);
    const wrongToken = await call(h.port, 'POST', releasePath('rev-1'), { reason: REASON, by: 'gru' }, { authorization: 'Bearer nope' });
    expect(wrongToken.status).toBe(401);
    // A GET on the control is not the control.
    expect((await call(h.port, 'GET', releasePath('rev-1'))).status).not.toBe(200);
    expect(h.rows('rev-1')).toEqual(before);
    expect(h.ledger.latestJobEvent('rev-1', RELEASE_KIND)).toBeNull();
  });

  it('A5: readback keeps state, shows the release, and no longer qualifies', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    const unreleased = (await call(h.port, 'GET', coveragePath('rev-1'))).json;
    expect(unreleased).toMatchObject({ state: 'qualifying', qualifying: true, released: null, reasons: [] });

    expect((await release(h, 'rev-1')).status).toBe(200);
    const event = h.ledger.latestJobEvent('rev-1', RELEASE_KIND)!;
    const released = (await call(h.port, 'GET', coveragePath('rev-1'))).json;
    expect(released).toMatchObject({
      jobId: 'rev-1',
      state: 'qualifying',
      qualifying: false,
      role: 'blind',
      targetSha: TARGET,
      released: { by: 'gru', reason: REASON, at: event.ts, event_seq: event.seq },
      reasons: [`coverage released by gru: ${REASON}`],
    });
    // Nothing but the release differs from the unreleased readback.
    const withoutRelease = (coverage: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(coverage).filter(([key]) => !['qualifying', 'released', 'reasons'].includes(key)));
    expect(withoutRelease(released)).toEqual(withoutRelease(unreleased));

    // A later prohibited read still invalidates it: the state moves, the release stays.
    await call(h.port, 'POST', '/api/dispatch/blind-access', { job_id: 'rev-1', tool_results: [{ tool_name: 'bash', text: 'docs/issues/305-review.md:1:x' }] });
    expect((await call(h.port, 'GET', coveragePath('rev-1'))).json).toMatchObject({
      state: 'invalidated', qualifying: false, released: { event_seq: event.seq },
    });
  });

  it('A6: the same release twice yields one event; a different reason afterwards is refused', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    const first = await release(h, 'rev-1');
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ idempotent: false });
    const again = await release(h, 'rev-1', { reason: `  ${REASON}\n`, by: 'gru' });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ idempotent: true });
    expect(again.json['event']).toEqual(first.json['event']);
    expect(h.rows('rev-1').filter((row) => (JSON.parse(row) as { kind: string }).kind === RELEASE_KIND)).toHaveLength(1);

    const different = await release(h, 'rev-1', { reason: 'something else entirely', by: 'gru' });
    expect(different.status).toBe(409);
    expect(different.json).toMatchObject({ error: 'blind_coverage_already_released' });
    expect(h.rows('rev-1').filter((row) => (JSON.parse(row) as { kind: string }).kind === RELEASE_KIND)).toHaveLength(1);
    expect(h.ledger.latestJobEvent('rev-1', RELEASE_KIND)?.payload).toMatchObject({ reason: REASON });
  });

  it('A7: a released job re-opened by a directive and delivered again stays released, and its replacement stays admitted', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    const released = await release(h, 'rev-1');
    expect(released.status).toBe(200);
    const releasedAt = (await call(h.port, 'GET', coveragePath('rev-1'))).json['released'];

    // A directive re-opens the delivered lane (delivered -> working).
    flipJobToWorking(h.ledger, 'rev-1');
    expect(h.ledger.getJob('rev-1')?.status).toBe('working');
    const replacement = await commission(h, 'rev-2');
    expect(replacement.status, JSON.stringify(replacement.json)).toBe(202);
    expect(h.ledger.latestJobEvent('rev-2', 'review.blind-input-admitted')?.payload).toMatchObject({ replaces: ['rev-1'] });
    await waitFor(() => h.ledger.getJob('rev-2')?.status === 'delivered');

    // It delivers again: a clean settle scan, then the delivered status.
    h.dispatch.observeBlindSession('rev-1', null);
    h.ledger.setJobStatus('rev-1', 'delivered');
    expect((await call(h.port, 'GET', coveragePath('rev-1'))).json).toMatchObject({ state: 'qualifying', qualifying: false, released: releasedAt });
    // A repeat of the release reads it back, whatever the lane did meanwhile.
    expect((await release(h, 'rev-1')).json).toMatchObject({ idempotent: true });
    expect(h.rows('rev-1').filter((row) => (JSON.parse(row) as { kind: string }).kind === RELEASE_KIND)).toHaveLength(1);

    // With the replacement out of the way, a further corrected commission is still admitted.
    h.ledger.setJobStatus('rev-2', 'binned');
    const third = await commission(h, 'rev-3');
    expect(third.status, JSON.stringify(third.json)).toBe(202);
    expect(h.ledger.latestJobEvent('rev-3', 'review.blind-input-admitted')?.payload).toMatchObject({ replaces: ['rev-1'] });
  });

  it('a release frees only the released report: its replacement owns the coverage', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    expect((await release(h, 'rev-1')).status).toBe(200);
    const replacement = await commission(h, 'rev-2');
    expect(replacement.status).toBe(202);
    await waitFor(() => h.ledger.getJob('rev-2')?.status === 'delivered');
    // Settling the replacement's handback is not releasing it.
    await dismiss(h, 'rev-2');
    const third = await commission(h, 'rev-3');
    expect(third.status).toBe(409);
    expect(third.json).toMatchObject({ error: 'blind_coverage_owned', coverage_job_id: 'rev-2' });
    expect((await call(h.port, 'GET', coveragePath('rev-2'))).json).toMatchObject({ qualifying: true, released: null });
  });

  it('a release record that cannot be read fails loud by name instead of reading as not released', async () => {
    const h = await boot();
    await dispatchParent(h);
    await deliveredReviewer(h, 'rev-1');
    h.ledger.appendCustomEvent({ kind: BLIND_RELEASED_EVENT, jobId: 'rev-1', payload: { reason: '', by: 'owner' } });
    expect(() => blindCoverageOf(h.ledger, 'rev-1')).toThrow(/review\.blind-coverage-released record \(event \d+\) is malformed/u);
    const replacement = await commission(h, 'rev-2');
    expect(replacement.status).toBe(409);
    expect(replacement.json).toMatchObject({ error: 'blind_coverage_unreadable', coverage_job_id: 'rev-1' });
    expect(String(replacement.json['detail'])).toContain('review.blind-coverage-released');
    expect(h.ledger.getJob('rev-2')).toBeNull();
  });
});
