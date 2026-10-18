import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepoRef } from '../src/dispatch/github-poll.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type NotificationRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { DEFAULT_BRANCH_CI_FAILED_KIND } from '../src/chat/incident.js';
import {
  DEFAULT_BRANCH_CI_EVENT,
  DefaultBranchCiWatch,
  defaultBranchCiFailedKind,
  defaultBranchVerdicts,
} from '../src/repos/default-branch-ci.js';
import type { RepoOverviewRunRaw } from '../src/repos/overview.js';

/**
 * Default-branch CI alert (#446): every row of the spec's I/O matrix runs
 * against a real LedgerApi + NotificationCenter, so dedupe, restart and
 * resolution are the durable behavior, not a fake's.
 */

const ALPHA: RepoRef = { host: 'github.com', owner: 'acme', repo: 'alpha' };
const ALPHA_TWO: RepoRef = { host: 'github.com', owner: 'acme', repo: 'alpha-two' };
const W = 7;
const X = 71;
const S1 = '3684087c00000000000000000000000000000001';
const S2 = '3684087c00000000000000000000000000000002';
const S3 = '3684087c00000000000000000000000000000003';

function run(id: number, over: Partial<RepoOverviewRunRaw> = {}): RepoOverviewRunRaw {
  return {
    id,
    name: 'CI',
    status: 'completed',
    conclusion: 'success',
    url: `https://github.com/acme/alpha/actions/runs/${id}`,
    runNumber: id,
    // Creation order follows the id unless a test overrides it.
    createdAt: `2026-10-18T10:${String(id).padStart(2, '0')}:00.000Z`,
    startedAt: null,
    updatedAt: null,
    workflowId: W,
    headSha: S2,
    event: 'push',
    // The observed repository's own runs; null is "the provider omitted it".
    headRepository: null,
    ...over,
  };
}

const passed = (id: number, over: Partial<RepoOverviewRunRaw> = {}) => run(id, { conclusion: 'success', ...over });
const failed = (id: number, over: Partial<RepoOverviewRunRaw> = {}) => run(id, { conclusion: 'failure', ...over });
const pending = (id: number, status: string, over: Partial<RepoOverviewRunRaw> = {}) => run(id, { status, conclusion: null, ...over });

interface Rig {
  readonly dir: string;
  db: LedgerDb;
  ledger: LedgerApi;
  notifications: NotificationCenter;
  watch: DefaultBranchCiWatch;
  readonly woke: NotificationRecord[];
  readonly logs: Log[];
  observe(runs: readonly RepoOverviewRunRaw[], repo?: RepoRef): void;
  /** Close the ledger and boot a fresh ledger, center and watch over it. */
  restart(): void;
}

interface Log { readonly level: string; readonly msg: string; readonly fields: Record<string, unknown> | null }

const rigs: Rig[] = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) {
    rig.db.close();
    rmSync(rig.dir, { recursive: true, force: true });
  }
});

function boot(dir: string, rig: Pick<Rig, 'woke' | 'logs'>): Pick<Rig, 'db' | 'ledger' | 'notifications' | 'watch'> {
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus, onActionRequired: (row) => rig.woke.push(row) });
  const watch = new DefaultBranchCiWatch({
    ledger,
    notifications,
    log: (level, msg, fields) => rig.logs.push({ level, msg, fields: fields ?? null }),
  });
  return { db, ledger, notifications, watch };
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'gru-default-branch-ci-'));
  const state = { woke: [] as NotificationRecord[], logs: [] as Log[] };
  const created: Rig = {
    dir,
    ...state,
    ...boot(dir, state),
    observe(runs, repo = ALPHA) {
      created.watch.observe({ repo, branch: 'develop', runs });
    },
    restart() {
      created.db.close();
      Object.assign(created, boot(dir, created));
    },
  };
  rigs.push(created);
  return created;
}

function events(r: Rig): readonly Record<string, unknown>[] {
  return r.ledger
    .listEventsAfter(0, { kinds: [DEFAULT_BRANCH_CI_EVENT] })
    .map((event) => event.payload as Record<string, unknown>);
}

function rows(r: Rig): readonly NotificationRecord[] {
  return r.ledger
    .listNotifications({ limit: 200 })
    .filter((row) => row.kind.startsWith(`${DEFAULT_BRANCH_CI_FAILED_KIND}:`));
}

/** The unresolved alert kinds, order-free. */
function expectOpen(r: Rig, kinds: readonly string[]): void {
  expect(rows(r).filter((row) => row.resolvedAt === null).map((row) => row.kind).sort()).toEqual([...kinds].sort());
}

const kindOf = (sha: string, workflowId = W, repo = ALPHA) => defaultBranchCiFailedKind(repo, workflowId, sha);

describe('default-branch verdicts (#446)', () => {
  it('takes the newest decisive run per workflow by (createdAt, id), never list order', () => {
    const verdicts = defaultBranchVerdicts([
      passed(8),
      failed(9),
      passed(12, { workflowId: X }),
      failed(10, { workflowId: X, createdAt: '2026-10-18T09:00:00.000Z' }),
    ], ALPHA);
    expect(verdicts.map((verdict) => [verdict.workflowId, verdict.verdict, verdict.runId])).toEqual([
      [W, 'red', 9],
      [X, 'passed', 12],
    ]);
    // Equal creation: the larger id wins, in either list order.
    const tie = '2026-10-18T10:00:00.000Z';
    expect(defaultBranchVerdicts([failed(5, { createdAt: tie }), passed(6, { createdAt: tie })], ALPHA)[0]?.runId).toBe(6);
    expect(defaultBranchVerdicts([passed(6, { createdAt: tie }), failed(5, { createdAt: tie })], ALPHA)[0]?.runId).toBe(6);
  });

  it('reads failed, timed-out and startup-failure as red', () => {
    for (const [conclusion, state] of [['failure', 'failed'], ['timed_out', 'timed-out'], ['startup_failure', 'startup-failure']] as const) {
      expect(defaultBranchVerdicts([run(9, { conclusion })], ALPHA)[0]).toMatchObject({ verdict: 'red', state, sha: S2 });
    }
  });

  it('pending, cancelled, skipped, neutral, action-required and stale runs never mask the verdict', () => {
    const maskers = [
      pending(10, 'queued'),
      pending(11, 'in_progress'),
      pending(12, 'waiting'),
      run(13, { conclusion: 'cancelled' }),
      run(14, { conclusion: 'skipped' }),
      run(15, { conclusion: 'neutral' }),
      run(16, { conclusion: 'action_required' }),
      run(17, { conclusion: 'stale' }),
      run(18, { conclusion: 'mystery' }),
    ];
    expect(defaultBranchVerdicts([...maskers, failed(9)], ALPHA).map((verdict) => verdict.runId)).toEqual([9]);
    expect(defaultBranchVerdicts(maskers, ALPHA)).toEqual([]);
  });

  it('a pull-request or fork run sharing the branch name never counts; every other event does', () => {
    // A fork PR from `develop`, or a gitflow develop→main PR, matches `branch=develop`.
    for (const event of ['pull_request', 'pull_request_target']) {
      expect(defaultBranchVerdicts([failed(10, { event }), passed(9)], ALPHA)[0], event).toMatchObject({ verdict: 'passed', runId: 9 });
    }
    expect(defaultBranchVerdicts([failed(10, { headRepository: 'someone/alpha' }), passed(9)], ALPHA)[0]).toMatchObject({ runId: 9 });
    // The observed repository's own head counts, compared case-insensitively.
    expect(defaultBranchVerdicts([failed(10, { headRepository: 'ACME/Alpha' })], ALPHA)[0]).toMatchObject({ verdict: 'red', runId: 10 });
    // Bots and other triggers count: "whatever the check is named".
    for (const event of ['push', 'schedule', 'workflow_dispatch', 'workflow_run', 'merge_group', 'dynamic', null]) {
      expect(defaultBranchVerdicts([failed(10, { event, headRepository: 'acme/alpha' })], ALPHA)[0], String(event)).toMatchObject({ verdict: 'red' });
    }
  });

  it('ignores a run without an id, workflow id or head sha', () => {
    expect(defaultBranchVerdicts([failed(9, { id: null }), failed(10, { workflowId: null }), failed(11, { headSha: null })], ALPHA)).toEqual([]);
    // An ignored newer run does not mask an older decisive one either.
    expect(defaultBranchVerdicts([failed(11, { headSha: null }), passed(8)], ALPHA)[0]).toMatchObject({ verdict: 'passed', runId: 8 });
  });
});

describe('default-branch CI watch (#446)', () => {
  it('turns red: records the change and posts one action-required incident that wakes Gru', () => {
    const r = rig();
    r.observe([failed(9), passed(8)]);
    expect(events(r)).toEqual([
      expect.objectContaining({ scope: 'acme/alpha:7', verdict: 'red', state: 'failed', run_id: 9, sha: S2, branch: 'develop' }),
    ]);
    const [row] = rows(r);
    expect(rows(r)).toHaveLength(1);
    expect(row).toMatchObject({
      kind: `github.default-branch-ci-failed:acme/alpha:7:${S2}`,
      routing: 'action-required',
      severity: 'error',
      agentId: null,
      resolvedAt: null,
    });
    expect(row?.title).toBe('Default branch develop is red: CI (acme/alpha)');
    expect(row?.detail).toContain('https://github.com/acme/alpha/actions/runs/9');
    expect(row?.detail).toContain('incident:github.default-branch-ci-failed:acme/alpha');
    expect(r.woke.map((woke) => woke.id)).toEqual([row?.id]);
  });

  it('turns red again after a pass: a new head raises a new incident', () => {
    const r = rig();
    r.observe([failed(9), passed(8)]);
    r.observe([passed(10), failed(9)]);
    expectOpen(r, []);
    r.observe([failed(11, { headSha: S3 }), passed(10)]);
    expect(events(r).map((payload) => [payload['verdict'], payload['run_id']])).toEqual([['red', 9], ['passed', 10], ['red', 11]]);
    expectOpen(r, [kindOf(S3)]);
    expect(r.woke).toHaveLength(2);
  });

  it('a queued run never masks the verdict: the failed run beneath it alerts', () => {
    const r = rig();
    r.observe([pending(10, 'queued'), failed(9)]);
    expect(events(r)).toEqual([expect.objectContaining({ verdict: 'red', run_id: 9 })]);
    expectOpen(r, [kindOf(S2)]);
  });

  it('non-decisive runs never resolve an open incident', () => {
    const r = rig();
    r.observe([failed(9)]);
    r.observe([run(10, { conclusion: 'cancelled' }), run(11, { conclusion: 'skipped' }), pending(12, 'in_progress'), failed(9)]);
    r.observe([run(13, { conclusion: 'neutral' }), run(14, { conclusion: 'stale' })]);
    expect(events(r)).toHaveLength(1);
    expectOpen(r, [kindOf(S2)]);
  });

  it('the same failure re-observed, or after a restart, writes nothing', () => {
    const r = rig();
    r.observe([failed(9)]);
    r.observe([failed(9)]);
    expect(events(r)).toHaveLength(1);
    expect(rows(r)).toHaveLength(1);
    // A real restart: a fresh ledger handle, center and watch over the same data.
    r.restart();
    r.observe([failed(9)]);
    expect(events(r)).toHaveLength(1);
    expect(rows(r)).toHaveLength(1);
    expect(rows(r).filter((row) => row.routing === 'action-required' && row.resolvedAt === null)).toHaveLength(1);
    expect(r.woke).toHaveLength(1);
  });

  it('a re-run in progress writes nothing: the older pass beneath it never resolves', () => {
    const r = rig();
    r.observe([failed(9), passed(8)]);
    r.observe([pending(9, 'in_progress'), passed(8)]);
    expect(events(r)).toHaveLength(1);
    expectOpen(r, [kindOf(S2)]);
  });

  it('the failing run re-run green resolves its incidents', () => {
    const r = rig();
    r.observe([failed(9)]);
    r.observe([passed(9)]);
    expect(events(r).map((payload) => [payload['verdict'], payload['run_id']])).toEqual([['red', 9], ['passed', 9]]);
    expectOpen(r, []);
    expect(rows(r)[0]?.resolvedBy).toBe('default-branch-ci');
  });

  it('a fix landing resolves the workflow', () => {
    const r = rig();
    r.observe([failed(9)]);
    r.observe([passed(11, { headSha: S3 }), failed(9)]);
    expect(events(r).at(-1)).toMatchObject({ verdict: 'passed', run_id: 11, sha: S3 });
    expectOpen(r, []);
  });

  it('still red at a new head: a new incident for the new sha supersedes the old one', () => {
    const r = rig();
    r.observe([failed(9)]);
    r.observe([failed(11, { headSha: S3 }), failed(9)]);
    expect(events(r).at(-1)).toMatchObject({ verdict: 'red', run_id: 11, sha: S3 });
    expectOpen(r, [kindOf(S3)]);
    expect(rows(r).find((row) => row.kind === kindOf(S2))?.resolvedBy).toBe('default-branch-ci');
    expect(r.woke).toHaveLength(2);
    // The superseding head resolves once the workflow passes.
    r.observe([passed(12, { headSha: S3 })]);
    expectOpen(r, []);
  });

  it('superseding resolves only that workflow\'s exact old head', () => {
    const r = rig();
    r.observe([failed(9), failed(10, { workflowId: X })]);
    r.observe([failed(9)], ALPHA_TWO);
    r.observe([failed(11, { headSha: S3 }), failed(10, { workflowId: X })]);
    expectOpen(r, [kindOf(S3), kindOf(S2, X), kindOf(S2, W, ALPHA_TWO)]);
  });

  it('red at one head, a pass at the next, then a newer failure at that head opens a row for it', () => {
    const r = rig();
    r.observe([failed(9, { headSha: S1 })]);
    r.observe([passed(10), failed(9, { headSha: S1 })]);
    r.observe([failed(11), passed(10)]);
    expectOpen(r, [kindOf(S2)]);
  });

  it('timed-out and startup-failure verdicts raise through the watch', () => {
    const r = rig();
    r.observe([run(9, { conclusion: 'timed_out' }), run(10, { conclusion: 'startup_failure', workflowId: X })]);
    expectOpen(r, [kindOf(S2), kindOf(S2, X)]);
    expect(events(r).map((payload) => [payload['workflow_id'], payload['state']])).toEqual([[W, 'timed-out'], [X, 'startup-failure']]);
    expect(r.woke).toHaveLength(2);
  });

  it('a pull-request run on the branch name never alerts through the watch', () => {
    const r = rig();
    r.observe([failed(10, { event: 'pull_request' }), failed(11, { headRepository: 'someone/alpha' })]);
    expect(events(r)).toEqual([]);
    expect(rows(r)).toEqual([]);
  });

  it('a pass with no cursor resolves an orphaned row and writes nothing', () => {
    const r = rig();
    // The row a crash between post and cursor leaves behind.
    r.notifications.postIncident({ kind: kindOf(S2), routing: 'action-required', severity: 'error', title: 'orphan', dedupe: 'active' });
    r.observe([passed(10)]);
    expectOpen(r, []);
    expect(rows(r)[0]?.resolvedBy).toBe('default-branch-ci');
    expect(events(r)).toEqual([]);
  });

  it('a post that throws once leaves nothing behind; the re-observe leaves exactly one open row', () => {
    const r = rig();
    let failPost = true;
    const watch = new DefaultBranchCiWatch({
      ledger: r.ledger,
      notifications: {
        postIncident: (input) => {
          if (failPost) {
            failPost = false;
            throw new Error('database is locked');
          }
          return r.notifications.postIncident(input);
        },
        resolveIncidents: (prefix, by) => r.notifications.resolveIncidents(prefix, by),
        resolveExactKind: (kind, by) => r.notifications.resolveExactKind(kind, by),
      },
    });
    watch.observe({ repo: ALPHA, branch: 'develop', runs: [failed(9)] });
    expect(rows(r)).toEqual([]);
    expect(events(r)).toEqual([]);
    watch.observe({ repo: ALPHA, branch: 'develop', runs: [failed(9)] });
    expectOpen(r, [kindOf(S2)]);
    expect(events(r)).toHaveLength(1);
  });

  it('a cursor append that throws once after the post leaves exactly one open row on re-observe', () => {
    const r = rig();
    let failAppend = true;
    const watch = new DefaultBranchCiWatch({
      ledger: {
        latestEventByPayloadField: (kind, field, value) => r.ledger.latestEventByPayloadField(kind, field, value),
        appendCustomEvent: (fields) => {
          if (failAppend) {
            failAppend = false;
            throw new Error('disk I/O error');
          }
          return r.ledger.appendCustomEvent(fields);
        },
      },
      notifications: r.notifications,
    });
    watch.observe({ repo: ALPHA, branch: 'develop', runs: [failed(9)] });
    expectOpen(r, [kindOf(S2)]);
    expect(events(r)).toEqual([]);
    watch.observe({ repo: ALPHA, branch: 'develop', runs: [failed(9)] });
    expect(rows(r)).toHaveLength(1);
    expectOpen(r, [kindOf(S2)]);
    expect(events(r)).toHaveLength(1);
  });

  it('one workflow that throws is logged and never skips the repository\'s other workflows', () => {
    const r = rig();
    const watch = new DefaultBranchCiWatch({
      ledger: {
        latestEventByPayloadField: (kind, field, value) => {
          if (value === 'acme/alpha:7') throw new Error('malformed JSON in events.payload');
          return r.ledger.latestEventByPayloadField(kind, field, value);
        },
        appendCustomEvent: (fields) => r.ledger.appendCustomEvent(fields),
      },
      notifications: r.notifications,
      log: (level, msg, fields) => r.logs.push({ level, msg, fields: fields ?? null }),
    });
    watch.observe({ repo: ALPHA, branch: 'develop', runs: [failed(9), failed(10, { workflowId: X })] });
    expectOpen(r, [kindOf(S2, X)]);
    expect(r.logs).toContainEqual({
      level: 'error',
      msg: 'default-branch CI: workflow verdict could not be applied — retried next pass',
      fields: { repo: 'acme/alpha', workflow_id: W, error: 'malformed JSON in events.payload' },
    });
  });

  it('a newer failing run at the same head advances the cursor without a second incident', () => {
    const r = rig();
    r.observe([failed(9)]);
    r.observe([failed(11), passed(10), failed(9)]);
    expect(events(r).at(-1)).toMatchObject({ verdict: 'red', run_id: 11 });
    expect(rows(r)).toHaveLength(1);
    expect(r.woke).toHaveLength(1);
    // #11 re-running: the older #10 pass beneath it is behind the cursor.
    r.observe([pending(11, 'in_progress'), passed(10), failed(9)]);
    expectOpen(r, [kindOf(S2)]);
  });

  it('never steps back to an older run when newer ones leave the page', () => {
    const r = rig();
    r.observe([failed(9)]);
    r.observe([passed(10), failed(9)]);
    r.observe([failed(9)]);
    expect(events(r)).toHaveLength(2);
    expectOpen(r, []);
  });

  it('another workflow passing later leaves the red one red and is tracked on its own', () => {
    const r = rig();
    r.observe([failed(9)]);
    r.observe([passed(12, { workflowId: X }), failed(9)]);
    expect(events(r)).toHaveLength(1); // X's first green is not a change
    expectOpen(r, [kindOf(S2)]);
    r.observe([failed(13, { workflowId: X }), failed(9)]);
    expectOpen(r, [kindOf(S2), kindOf(S2, X)]);
    r.observe([passed(14), failed(13, { workflowId: X })]);
    expectOpen(r, [kindOf(S2, X)]);
  });

  it('a first-ever green writes nothing', () => {
    const r = rig();
    r.observe([passed(8)]);
    expect(events(r)).toEqual([]);
    expect(rows(r)).toEqual([]);
  });

  it('a run lacking an id, workflow id or head sha is ignored', () => {
    const r = rig();
    r.observe([failed(9, { id: null }), failed(10, { workflowId: null }), failed(11, { headSha: null })]);
    expect(events(r)).toEqual([]);
    expect(rows(r)).toEqual([]);
  });

  it('resolving one workflow leaves rows of other workflows and repos sharing its prefix open', () => {
    const r = rig();
    r.observe([failed(9), failed(10, { workflowId: X })]);
    r.observe([failed(9)], ALPHA_TWO);
    expectOpen(r, [kindOf(S2, W, ALPHA), kindOf(S2, X, ALPHA), kindOf(S2, W, ALPHA_TWO)]);
    r.observe([passed(11), failed(10, { workflowId: X })]);
    expectOpen(r, [kindOf(S2, X, ALPHA), kindOf(S2, W, ALPHA_TWO)]);
  });

  it('a run link on another host never reaches the record or the incident', () => {
    const r = rig();
    r.observe([failed(9, { url: 'https://evil.example/acme/alpha/actions/runs/9' })]);
    expect(events(r)[0]?.['url']).toBeNull();
    expect(rows(r)[0]?.detail).not.toContain('evil.example');
  });

  it('a malformed cursor re-observes loudly instead of trusting it', () => {
    const r = rig();
    r.ledger.appendCustomEvent({ kind: DEFAULT_BRANCH_CI_EVENT, payload: { scope: 'acme/alpha:7', verdict: 'maybe' } });
    r.observe([failed(9)]);
    expect(r.logs).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'default-branch CI: cursor event has a malformed payload — re-observing' }));
    expectOpen(r, [kindOf(S2)]);
  });
});
