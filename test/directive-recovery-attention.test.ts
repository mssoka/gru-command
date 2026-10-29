import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardEngine } from '../src/board/engine.js';
import { createBoardServer } from '../src/board/server.js';
import { GruAwareness } from '../src/chat/awareness.js';
import { incidentBasisOf, incidentSignalOf, incidentSubjectOf, isHardFloorRow } from '../src/chat/incident.js';
import { loadConfig } from '../src/config.js';
import { DirectiveProgressService, surfaceDirectiveRecovery } from '../src/dispatch/directive-progress.js';
import type { DirectiveRegistry } from '../src/dispatch/fix-directive.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type NotificationRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { DECISION_SIGNAL_MAX_LENGTH, type DecisionRecord } from '../src/ledger/decision-memory.js';
import type { MailboxItem } from '../src/ledger/mailbox.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { TranscriptService } from '../src/transcripts/service.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';

/**
 * Directive recovery card attention (#523, second PR): the reconsider-driven
 * `silas.directive-unreconciled.<request>` card is not raised again after Gru
 * resolves it while nothing about the request changed, a recorded mailbox
 * disposition of it survives a text-only refresh, and its decision signal
 * fits the decision API however long the request id is. Real ledger on a
 * temp database, the real board routes over HTTP, no providers, no lanes.
 */

const TOKEN = 'attention-token';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length > 0) await cleanups.pop()!(); });

interface Rig {
  readonly dir: string;
  readonly port: number;
  readonly api: LedgerApi;
  readonly bus: EventBus;
  readonly notifications: NotificationCenter;
  readonly worktrees: InMemoryWorktreePort;
}

async function boot(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-directive-attention-'));
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const api = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger: api, bus });
  const board = createBoardServer({
    config: cfg, engine: new BoardEngine({ ledger: api, bus }), ledger: api, bus, notifications,
    transcripts: new TranscriptService(join(dir, 'sessions'), { ledger: api }), pushDebounceMs: 10,
  });
  const http: HttpServer = createServer((req, res) => {
    if (board.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  board.attach(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    await board.dispose();
    await new Promise<void>((resolve) => { http.closeAllConnections(); http.close(() => resolve()); });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, port: (http.address() as AddressInfo).port, api, bus, notifications, worktrees: new InMemoryWorktreePort(join(dir, 'lanes'), api) };
}

async function call(rig: Rig, method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${rig.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) };
}

/** A live request with no admission minion: its card is not folded into a job item. */
function seed(rig: Rig, jobId: string, requestId: string): void {
  rig.api.addJob({ id: jobId, repo: 'demo-repo', title: jobId, briefing: `briefing for ${jobId}` });
  rig.api.setJobStatus(jobId, 'working');
  rig.api.beginDirectiveIntent({ jobId, requestId, directive: 'finish the approved correction', holder: 'gru' });
}

const kindOf = (requestId: string): string => `silas.directive-unreconciled.${requestId}`;
const surface = (rig: Rig, requestId: string, reason: string): void =>
  surfaceDirectiveRecovery({ ledger: rig.api, notifications: rig.notifications }, requestId, reason);
const rowsOf = (rig: Rig, requestId: string): readonly NotificationRecord[] =>
  rig.api.listNotifications({ limit: 500 }).filter((row) => row.kind === kindOf(requestId));
const activeCard = (rig: Rig, requestId: string): NotificationRecord => {
  const card = rig.api.findNotificationByKind(kindOf(requestId), 'active');
  if (card === null) throw new Error(`expected an active card for ${requestId}`);
  return card;
};
const createdEvents = (rig: Rig, requestId: string): readonly unknown[] =>
  rig.api.listEvents({ limit: 5000 }).filter((event) => event.kind === 'notification.created'
    && String((event.payload as { title?: unknown }).title).includes(`Directive ${requestId}`));
const debtOf = (rig: Rig, jobId: string, requestId: string) => {
  const debt = rig.api.recoveryObligation(jobId, 'directive', requestId);
  if (debt === null) throw new Error(`expected a recovery debt for ${requestId}`);
  return debt;
};
const identityLineOf = (row: NotificationRecord): string | undefined => row.detail?.split('\n', 1)[0];
const identity = (requestId: string, generation: number): string => `incident: ${requestId} generation ${generation}`;

/** One reconsider pass, run to completion. A request with no native
 * association fails recovery the same way on every pass. */
function passes(rig: Rig): { readonly pass: () => Promise<void>; readonly service: DirectiveProgressService } {
  const registry: DirectiveRegistry = {
    getHandle: () => null,
    spawn: async () => { throw new Error('recovery card attention must never spawn'); },
    disposeHandle: async () => {},
  };
  const service = new DirectiveProgressService({ ledger: rig.api, registry, worktrees: rig.worktrees, notifications: rig.notifications,
    pendingProducerBlockers: () => [], signal: new AbortController().signal });
  cleanups.push(() => service.dispose());
  return { service, pass: async () => { service.reconsider(); await service.settled(); } };
}

async function mailboxItemOf(rig: Rig, notificationId: string): Promise<MailboxItem> {
  const page = await call(rig, 'GET', '/api/mailbox');
  expect(page.status).toBe(200);
  const item = (page.body as { items: MailboxItem[] }).items.find((candidate) => candidate.notificationIds.includes(notificationId));
  if (item === undefined) throw new Error(`no mailbox item carries notification ${notificationId}`);
  return item;
}

describe('directive recovery card attention (#523)', () => {
  it('A1. a resolved card is not raised again by later reconsider passes while the request is unchanged', async () => {
    const rig = await boot();
    seed(rig, 'job-a1', 'req-a1');
    const { pass } = passes(rig);
    for (let i = 0; i < 3; i += 1) await pass();
    const [card] = rowsOf(rig, 'req-a1');
    expect(rowsOf(rig, 'req-a1')).toHaveLength(1);
    const debt = debtOf(rig, 'job-a1', 'req-a1');
    rig.api.resolveNotificationById(card!.id, 'gru');
    for (let i = 0; i < 2; i += 1) await pass();
    expect(rowsOf(rig, 'req-a1').map((row) => row.id)).toEqual([card!.id]);
    expect(rowsOf(rig, 'req-a1')[0]).toMatchObject({ resolvedBy: 'gru', ackedAt: null });
    expect(createdEvents(rig, 'req-a1')).toHaveLength(1);
    // Resolving the card settled, retired and replayed nothing: the debt, its generation and the request stand.
    expect(debtOf(rig, 'job-a1', 'req-a1')).toMatchObject({ id: debt.id, generation: debt.generation, state: debt.state });
    expect(['open', 'waiting']).toContain(debt.state);
    expect(rig.api.getDirective('req-a1')).toMatchObject({ state: 'dispatching' });
    expect(rig.api.findNotificationByKind(kindOf('req-a1'), 'active')).toBeNull();
  });

  it('A2. a text-only refresh keeps the card, the mailbox basis and a recorded mailbox disposition', async () => {
    const rig = await boot();
    seed(rig, 'job-a2', 'req-a2');
    surface(rig, 'req-a2', 'first blocker: native admission unproven');
    const card = activeCard(rig, 'req-a2');
    const before = await mailboxItemOf(rig, card.id);
    const written = await call(rig, 'POST', `/api/mailbox/${encodeURIComponent(before.id)}/disposition`, {
      basis: before.basis, state: 'needs-gru', owner: 'gru', detail: 'Gru is inspecting the native evidence', references: [],
    });
    expect(written.status).toBe(200);
    surface(rig, 'req-a2', 'second blocker: producer ownership unknown');
    const refreshed = activeCard(rig, 'req-a2');
    expect(refreshed.id).toBe(card.id);
    expect(refreshed.detail).toContain('second blocker');
    expect(refreshed.detail).not.toContain('first blocker');
    expect(rowsOf(rig, 'req-a2')).toHaveLength(1);
    const after = await mailboxItemOf(rig, card.id);
    expect(after.id).toBe(before.id);
    expect(after.basis).toBe(before.basis);
    expect(after.disposition).toMatchObject({ basis: before.basis, state: 'needs-gru', owner: 'gru', detail: 'Gru is inspecting the native evidence' });
  });

  it('A3. a resolved card of another generation is followed by one new card naming the current generation', async () => {
    const rig = await boot();
    seed(rig, 'job-a3', 'req-a3');
    const { generation } = rig.api.openDirectiveRecoveryDebt('req-a3', 'recovery owed');
    const prior = rig.notifications.postIncident({ kind: kindOf('req-a3'), routing: 'action-required', severity: 'error',
      title: 'Directive req-a3: concrete Gru recovery decision owed (job job-a3)',
      detail: `${identity('req-a3', generation + 1)}\nRequest req-a3; an earlier generation`, dedupe: 'active' });
    rig.api.resolveNotificationById(prior.id, 'gru');
    surface(rig, 'req-a3', 'recovery owed');
    const rows = rowsOf(rig, 'req-a3');
    expect(rows).toHaveLength(2);
    const fresh = rows.filter((row) => row.id !== prior.id);
    expect(fresh).toHaveLength(1);
    expect(identityLineOf(fresh[0]!)).toBe(identity('req-a3', generation));
    expect(fresh[0]).toMatchObject({ resolvedAt: null });
    expect(rig.api.getNotification(prior.id)).toMatchObject({ resolvedBy: 'gru' });
  });

  it('A4. a long request id keeps the family signal, so a decision covers its exact basis and the wake still opens', async () => {
    const rig = await boot();
    const requestId = `req-${'a4'.repeat(28)}`;
    expect(`directive-unreconciled.${requestId}`.length).toBeGreaterThan(DECISION_SIGNAL_MAX_LENGTH);
    seed(rig, 'job-a4', requestId);
    surface(rig, requestId, 'native admission unproven');
    const card = activeCard(rig, requestId);
    expect(incidentSignalOf(card)).toBe('directive-unreconciled');
    const item = await mailboxItemOf(rig, card.id);
    expect(item.reasons.map((reason) => reason.signal)).toEqual(['directive-unreconciled']);
    expect(item.producerOwned).toBe(false);
    const decide = (basis: string, clientKey: string) => call(rig, 'POST', '/api/decisions', {
      subject: item.subject, decision: 'acted', covers: ['directive-unreconciled'], basis_fingerprint: basis,
      reason: 'Attention accounted for this exact recovery card', by: 'gru', client_key: clientKey,
    });
    const written = await decide(item.basis, 'a4-exact');
    expect(written.status).toBe(201);
    const decision = written.body as DecisionRecord;
    expect(rig.api.coveringDecision({ subject: item.subject, signal: 'directive-unreconciled', basis: item.basis })?.id).toBe(decision.id);
    expect(rig.api.coveringDecision({ subject: item.subject, signal: 'directive-unreconciled', basis: 'changed-basis' })).toBeNull();
    // A decision recorded against another basis does not let the exact item resolve.
    const other = await decide('changed-basis', 'a4-other');
    expect(other.status).toBe(201);
    const refused = await call(rig, 'POST', `/api/mailbox/${encodeURIComponent(item.id)}/disposition`, {
      basis: item.basis, state: 'resolved', owner: 'gru', detail: 'Exact attention accounted',
      references: [{ kind: 'decision', id: (other.body as DecisionRecord).id }],
    });
    expect(refused.status).toBe(409);
    const resolved = await call(rig, 'POST', `/api/mailbox/${encodeURIComponent(item.id)}/disposition`, {
      basis: item.basis, state: 'resolved', owner: 'gru', detail: 'Exact attention accounted',
      references: [{ kind: 'decision', id: decision.id }],
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ id: item.id, basis: item.basis, state: 'resolved' });
    // The kind stays a hard floor: a hold on its subject never defers the wake.
    const hold = rig.api.recordDecision({ subject: incidentSubjectOf(card), decision: 'hold', covers: [incidentSignalOf(card)],
      basisFingerprint: null, reason: 'a hold must not defer a concrete recovery debt', by: 'gru', clientKey: 'a4-hold' });
    expect(rig.api.coveringDecision({ subject: incidentSubjectOf(card), signal: incidentSignalOf(card), basis: incidentBasisOf(card) })?.id).toBe(hold.id);
    expect(isHardFloorRow(card)).toBe(true);
    const woke: number[] = [];
    const awareness = new GruAwareness({ dir: rig.dir, ledger: rig.api, bus: rig.bus, wakeMode: 'all', wakeMinIntervalMs: 0 });
    cleanups.push(() => awareness.dispose());
    awareness.setWakeSink(() => {
      const injection = awareness.prepare('wake');
      woke.push(woke.length);
      if (injection !== null) awareness.noteWakeOutcome(true, undefined, injection);
    });
    rig.api.resolveNotificationById(card.id, 'gru');
    rig.notifications.post({ kind: card.kind, routing: card.routing, severity: card.severity, title: card.title, detail: card.detail });
    expect(woke).toHaveLength(1);
    expect(rig.api.listEventsAfter(0, { kinds: ['gru.wake-deferred'] })).toHaveLength(0);
  });

  it('A5. an open card of another generation is refreshed in place to the current generation', async () => {
    const rig = await boot();
    seed(rig, 'job-a5', 'req-a5');
    const { generation } = rig.api.openDirectiveRecoveryDebt('req-a5', 'recovery owed');
    const open = rig.notifications.postIncident({ kind: kindOf('req-a5'), routing: 'action-required', severity: 'error',
      title: 'Directive req-a5: concrete Gru recovery decision owed (job job-a5)',
      detail: `${identity('req-a5', generation + 1)}\nRequest req-a5; an earlier generation`, dedupe: 'active' });
    surface(rig, 'req-a5', 'recovery owed');
    expect(rowsOf(rig, 'req-a5')).toHaveLength(1);
    const refreshed = activeCard(rig, 'req-a5');
    expect(refreshed.id).toBe(open.id);
    expect(identityLineOf(refreshed)).toBe(identity('req-a5', generation));
    expect(refreshed.detail).not.toContain('an earlier generation');
  });

  it('A6. a resolved legacy card without an identity line is followed by one card with the line, then nothing', async () => {
    const rig = await boot();
    seed(rig, 'job-a6', 'req-a6');
    const legacy = rig.notifications.postIncident({ kind: kindOf('req-a6'), routing: 'action-required', severity: 'error',
      title: 'Directive req-a6: concrete Gru recovery decision owed (job job-a6)', detail: 'Request req-a6; a card from before the identity line', dedupe: 'active' });
    rig.api.resolveNotificationById(legacy.id, 'gru');
    const { pass } = passes(rig);
    await pass();
    const rows = rowsOf(rig, 'req-a6');
    expect(rows).toHaveLength(2);
    const fresh = rows.find((row) => row.id !== legacy.id)!;
    const { generation } = debtOf(rig, 'job-a6', 'req-a6');
    expect(identityLineOf(fresh)).toBe(identity('req-a6', generation));
    rig.api.resolveNotificationById(fresh.id, 'gru');
    await pass();
    await pass();
    expect(rowsOf(rig, 'req-a6').map((row) => row.id).sort()).toEqual([legacy.id, fresh.id].sort());
    expect(createdEvents(rig, 'req-a6')).toHaveLength(1);
  });
});

describe('directive recovery card attention — edges (#523)', () => {
  it('an active card of the same identity is reused: the pass posts nothing and keeps its id', async () => {
    const rig = await boot();
    seed(rig, 'job-e1', 'req-e1');
    surface(rig, 'req-e1', 'blocker');
    const card = activeCard(rig, 'req-e1');
    surface(rig, 'req-e1', 'blocker');
    expect(rowsOf(rig, 'req-e1')).toHaveLength(1);
    expect(activeCard(rig, 'req-e1')).toMatchObject({ id: card.id, detail: card.detail });
  });

  it('the suppression is per request: resolving one request card never silences another', async () => {
    const rig = await boot();
    seed(rig, 'job-e2a', 'req-e2a');
    seed(rig, 'job-e2b', 'req-e2b');
    surface(rig, 'req-e2a', 'blocker');
    rig.api.resolveNotificationById(activeCard(rig, 'req-e2a').id, 'gru');
    surface(rig, 'req-e2b', 'blocker');
    expect(rowsOf(rig, 'req-e2a')).toHaveLength(1);
    expect(rowsOf(rig, 'req-e2b')).toHaveLength(1);
    expect(identityLineOf(activeCard(rig, 'req-e2b'))).toBe(identity('req-e2b', debtOf(rig, 'job-e2b', 'req-e2b').generation));
  });

  it('the card keeps its reason text after the identity line, which is the first line', async () => {
    const rig = await boot();
    seed(rig, 'job-e3', 'req-e3');
    surface(rig, 'req-e3', 'the exact blocker text');
    const lines = activeCard(rig, 'req-e3').detail!.split('\n');
    expect(lines[0]).toBe(identity('req-e3', debtOf(rig, 'job-e3', 'req-e3').generation));
    expect(lines.slice(1).join('\n')).toContain('blocker/evidence: the exact blocker text');
  });

  it('a card without the identity line keeps a detail-sensitive basis, and a refresh that adds the line changes it once', async () => {
    const rig = await boot();
    seed(rig, 'job-e4', 'req-e4');
    const legacy = rig.notifications.postIncident({ kind: kindOf('req-e4'), routing: 'action-required', severity: 'error',
      title: 'Directive req-e4: concrete Gru recovery decision owed (job job-e4)', detail: 'legacy text one', dedupe: 'active' });
    const one = await mailboxItemOf(rig, legacy.id);
    rig.api.updateNotificationDetail(legacy.id, 'legacy text two');
    const two = await mailboxItemOf(rig, legacy.id);
    expect(two.basis).not.toBe(one.basis);
    surface(rig, 'req-e4', 'first blocker');
    const withLine = await mailboxItemOf(rig, legacy.id);
    expect(withLine.basis).not.toBe(two.basis);
    surface(rig, 'req-e4', 'second blocker');
    expect((await mailboxItemOf(rig, legacy.id)).basis).toBe(withLine.basis);
  });

  it('a different identity line changes the basis; only the text after the line is ignored', async () => {
    const rig = await boot();
    seed(rig, 'job-e5', 'req-e5');
    const card = rig.notifications.postIncident({ kind: kindOf('req-e5'), routing: 'action-required', severity: 'error',
      title: 'Directive req-e5: concrete Gru recovery decision owed (job job-e5)', detail: `${identity('req-e5', 1)}\ntext one`, dedupe: 'active' });
    const base = (await mailboxItemOf(rig, card.id)).basis;
    rig.api.updateNotificationDetail(card.id, `${identity('req-e5', 1)}\ntext two`);
    expect((await mailboxItemOf(rig, card.id)).basis).toBe(base);
    rig.api.updateNotificationDetail(card.id, `${identity('req-e5', 2)}\ntext one`);
    expect((await mailboxItemOf(rig, card.id)).basis).not.toBe(base);
  });

  it('only the recovery kind reads the line: the rebrief kind and a line naming another request keep the full-detail basis', async () => {
    const rig = await boot();
    seed(rig, 'job-e6', 'req-e6');
    const rebrief = rig.notifications.postIncident({ kind: 'silas.rebrief-unreconciled.job-e6', routing: 'action-required', severity: 'error',
      title: 'Rebrief job-e6 unreconciled', detail: `${identity('job-e6', 1)}\ntext one`, dedupe: 'unacked' });
    const rebriefBase = (await mailboxItemOf(rig, rebrief.id)).basis;
    rig.api.updateNotificationDetail(rebrief.id, `${identity('job-e6', 1)}\ntext two`);
    expect((await mailboxItemOf(rig, rebrief.id)).basis).not.toBe(rebriefBase);
    const foreign = rig.notifications.postIncident({ kind: kindOf('req-e6'), routing: 'action-required', severity: 'error',
      title: 'Directive req-e6: concrete Gru recovery decision owed (job job-e6)', detail: `${identity('someone-else', 1)}\ntext one`, dedupe: 'active' });
    const foreignBase = (await mailboxItemOf(rig, foreign.id)).basis;
    rig.api.updateNotificationDetail(foreign.id, `${identity('someone-else', 1)}\ntext two`);
    expect((await mailboxItemOf(rig, foreign.id)).basis).not.toBe(foreignBase);
  });

  it('the rebrief family signal and the colon-scoped families are unchanged', () => {
    const row = (kind: string) => ({ kind, title: 'x', routing: 'action-required' as const });
    expect(incidentSignalOf(row('silas.rebrief-unreconciled.job-1'))).toBe('rebrief-unreconciled');
    expect(incidentSignalOf(row('github.ci-failed:job-1:abc'))).toBe('ci-failed');
    expect(incidentSignalOf(row('silas.directive-unreconciled.req-1'))).toBe('directive-unreconciled');
    expect(incidentSignalOf(row(`silas.directive-unreconciled.${'r'.repeat(300)}`))).toBe('directive-unreconciled');
  });
});
