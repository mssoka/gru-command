// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentView,
  BoardSnapshot,
  BuildView,
  JobView,
  NotificationView,
  RoundView,
  SelfHealView,
  SilasView,
  VerifyQueueView,
} from '../lib/board-protocol.js';
import { memoryStorage } from '../lib/chat-storage.js';
import { boardKpis } from '../lib/board-kpi.js';
import { BoardView, jobFailing } from './board.js';

type DecisionsOverrides = Partial<BoardSnapshot['decisions']>;

function notification(id: string, overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'test.notice',
    routing: 'action-required',
    severity: 'error',
    title: `Notice ${id}`,
    detail: null,
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

function agent(id: string, overrides: Partial<AgentView> = {}): AgentView {
  return {
    id,
    role: 'perkins',
    label: id,
    state: 'idle',
    lastActivity: '2026-01-01T00:00:00.000Z',
    sessionFile: `/sessions/${id}.jsonl`,
    jobId: null,
    roundId: null,
    supervision: null,
    ...overrides,
  };
}

function baseRound(overrides: Partial<RoundView> = {}): RoundView {
  return {
    id: 'job-1-r1',
    seq: 1,
    status: 'live',
    verdict: null,
    targetRef: 'abc',
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    updatedAt: '2026-01-01T00:30:00.000Z',
    lensAttempts: [
      { lens: 'blind', attempts: 2 },
      { lens: 'security', attempts: 1 },
    ],
    blockers: 1,
    lenses: [
      { lens: 'blind', state: 'done', agentId: 'a1', note: 'blocker — unsafe retry', verdict: 'blocker' },
      { lens: 'security', state: 'done', agentId: null, note: 'clean — nothing found', verdict: 'clean' },
    ],
    ...overrides,
  };
}

function baseJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    repo: 'demo',
    title: 'Review job',
    status: 'in-review',
    updatedAt: '2026-01-01T00:00:00.000Z',
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [baseRound()],
    lane: {
      branch: 'gru/job-1',
      sha: 'abc1234deadbeef',
      status: 'active',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    lastAgentActivity: new Date(Date.now() - 120_000).toISOString(),
    ...overrides,
  };
}

function snapshot(
  options: {
    notifications?: readonly NotificationView[];
    agents?: readonly AgentView[];
    jobs?: readonly JobView[];
    decisions?: DecisionsOverrides;
    unackedActionRequired?: number;
    build?: BuildView | null;
    silas?: SilasView | null;
    verify?: VerifyQueueView | null;
    selfHeal?: SelfHealView | null;
    repos?: readonly { readonly name: string; readonly jobs: readonly JobView[] }[];
    unackedNeedsOwner?: number;
    wakes?: { readonly count: number; readonly lastAt: string | null };
    ownerPrs?: NonNullable<BoardSnapshot['ownerPrs']>;
    pipeline?: NonNullable<BoardSnapshot['pipeline']>;
  } = {},
): BoardSnapshot {
  return {
    repos: options.repos ?? [{ name: 'demo', jobs: options.jobs ?? [baseJob()] }],
    agents: options.agents ?? [],
    notifications: options.notifications ?? [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'test-incarnation',
      generation: 0,
      ...options.decisions,
    },
    unackedActionRequired: options.unackedActionRequired ?? 0,
    build: options.build ?? null,
    silas: options.silas ?? null,
    verify: options.verify ?? null,
    selfHeal: options.selfHeal ?? null,
    unackedNeedsOwner: options.unackedNeedsOwner ?? 0,
    wakes: options.wakes ?? { count: 0, lastAt: null },
    ownerPrs: options.ownerPrs,
    pipeline: options.pipeline,
  };
}

/** FOR GRU and COLD are collapsed/count-only by default (owner approval
 * j-1064): classification-focused tests reveal the section they assert
 * on, exactly as an operator would. */
function expandForGru(): void {
  document.querySelector<HTMLButtonElement>('.board-band--needs-you .board-band__more')?.click();
}

function expandCold(): void {
  document.querySelector<HTMLButtonElement>('.board-band--cold .board-band__more')?.click();
}

function mountBoardDom(): void {
  document.body.innerHTML = `
    <div id="chip-rail" hidden>
      <span id="board-decisions"></span>
      <span id="board-unacked" hidden></span>
      <span id="board-wakes" hidden></span>
    </div>
    <nav id="board-nav" hidden></nav>
    <section id="board-owner" hidden></section>
    <div id="board-jobs"></div>
    <div id="board-agents"></div>
    <span id="rail-agents-count">0</span>
    <button id="notification-bell"><span id="notification-badge">0</span></button>
    <div id="notification-panel"><div id="notification-list"></div></div>
  `;
}

describe('board view resolved-notification rendering', () => {
  beforeEach(mountBoardDom);

  it('removes ack/badge/toast behavior for resolved rows while retaining active controls', () => {
    const toast = vi.fn();
    const view = new BoardView(() => {});
    view.setToastHandler(toast);
    const first = notification('first', { routing: 'needs-owner' });
    view.render(snapshot({ notifications: [first] }));
    expect(document.querySelectorAll('.board-notification__ack')).toHaveLength(1);

    const resolved = { ...first, resolvedAt: '2026-01-01T00:01:00.000Z', resolvedBy: 'runtime' };
    view.render(snapshot({ notifications: [resolved] }));
    expect(document.querySelector('.board-notification__title')?.textContent).toContain('resolved');
    expect(document.querySelectorAll('.board-notification__ack')).toHaveLength(0);
    expect(document.querySelector<HTMLElement>('#notification-bell')?.dataset.unread).toBe('0');
    expect(document.querySelector<HTMLElement>('#notification-badge')?.textContent).toBe('0');
    expect(toast).not.toHaveBeenCalled();

    view.render(
      snapshot({
        notifications: [
          resolved,
          notification('arrived-resolved', { resolvedAt: '2026-01-01T00:02:00.000Z', resolvedBy: 'runtime' }),
          notification('active', { routing: 'needs-owner' }),
        ],
      }),
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ id: 'active' }));
    expect(document.querySelectorAll('.board-notification__ack')).toHaveLength(1);
  });

  it('an informational owner stop remains in the bell until seen and is ackable; machine rows have no manual Ack', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ notifications: [notification('owner-stop', { routing: 'needs-owner', severity: 'info' }), notification('machine')] }));
    expect(document.querySelector<HTMLElement>('#notification-badge')?.textContent).toBe('1');
    const sections = [...document.querySelectorAll<HTMLElement>('.board-notification-section')];
    expect(sections[0]?.querySelector('.board-notification__title')?.textContent).toContain('owner-stop');
    expect(sections[0]?.querySelector('.board-notification__ack')).not.toBeNull();
    expect(sections[1]?.querySelector('.board-notification__ack')).toBeNull();
  });

  it('places pre-disposition acknowledged machine rows in FEED, not an unresolvable NEEDS GRU queue', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ notifications: [notification('legacy-machine', { ackedAt: '2026-01-01T00:01:00.000Z' })] }));
    const sections = [...document.querySelectorAll<HTMLElement>('.board-notification-section')];
    expect(sections[1]?.textContent).toContain('machine queue is clear');
    expect(sections[1]?.textContent).not.toContain('Notice legacy-machine');
    expect(sections[2]?.textContent).toContain('Notice legacy-machine');
    expect(sections[2]?.querySelector('.board-notification__ack')).toBeNull();
  });

  it('routing split: machine rows never ring the bell or toast; needs-owner rows do', () => {
    const toast = vi.fn();
    const view = new BoardView(() => {});
    view.setToastHandler(toast);
    view.render(snapshot({ notifications: [] })); // first snapshot suppresses history only
    view.render(snapshot({ notifications: [notification('machine'), notification('info', { routing: 'fyi' })] }));
    expect(toast).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('#notification-badge')?.textContent).toBe('0');
    expect(document.querySelector('.board-notification-section__head')?.textContent).toContain('FOR YOU');
    const sections = [...document.querySelectorAll('.board-notification-section__head')].map(
      (head) => head.textContent,
    );
    expect(sections).toEqual(['FOR YOU', 'NEEDS GRU', 'FEED']);

    view.render(
      snapshot({
        notifications: [
          notification('machine'),
          notification('info', { routing: 'fyi' }),
          notification('owner', { routing: 'needs-owner' }),
        ],
      }),
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner' }));
    const forYou = document.querySelector('.board-notification-section');
    expect(forYou?.querySelector('.board-notification__title')?.textContent).toContain('Notice owner');
    const needsGru = document.querySelectorAll('.board-notification-section')[1];
    expect(needsGru?.querySelector('.board-notification__title')?.textContent).toContain('Notice machine');
  });
});

describe('board v6 — status chip rail (v4 health row relocated)', () => {
  beforeEach(mountBoardDom);

  it('renders the seven chips and discloses the rail on the first snapshot', () => {
    const view = new BoardView(() => {});
    expect(document.getElementById('chip-rail')?.hidden).toBe(true);
    view.render(snapshot());
    const rail = document.getElementById('chip-rail');
    expect(rail?.hidden).toBe(false);
    const chips = [...(rail?.querySelectorAll('.rail-chip') ?? [])].map((node) => node.getAttribute('data-chip'));
    expect(chips).toEqual(['deploy', 'reviews', 'silas', 'alerts', 'verify', 'cure', 'trackers']);
  });

  it('renders the deploy-drift chip with the restart-pending flag when behind', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        build: {
          buildRev: 'a'.repeat(40),
          buildCommittedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
          originMainRev: 'b'.repeat(40),
          originMainCommittedAt: new Date().toISOString(),
          commitsBehind: 43,
          checkedAt: new Date().toISOString(),
          checkError: null,
        },
      }),
    );
    const deploy = document.querySelector<HTMLElement>('.rail-chip[data-chip="deploy"]');
    expect(deploy?.querySelector('.rail-chip__value')?.textContent).toBe('43 behind');
    expect(deploy?.querySelector('.rail-chip__flag')?.textContent).toBe('RESTART PENDING');
    expect(deploy?.classList.contains('rail-chip--alert')).toBe(true);
  });

  it('renders n/a honestly for unwired sources (verify queue, cure efficacy)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    const valueOf = (chip: string): string | undefined =>
      document.querySelector<HTMLElement>(`.rail-chip[data-chip="${chip}"] .rail-chip__value`)?.textContent ?? undefined;
    expect(valueOf('deploy')).toBe('n/a');
    expect(valueOf('verify')).toBe('n/a');
    expect(valueOf('cure')).toBe('n/a');
    expect(valueOf('alerts')).toBe('0');
    expect(valueOf('reviews')).toBe('1 active'); // the base job carries a live round
  });

  it('renders the verify queue from the snapshot when the scheduler is wired', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        verify: { lockInUse: true, activeRuns: 1, queuedRuns: 2, workerBudget: 8, workersPerRun: 4 },
      }),
    );
    const verify = document.querySelector<HTMLElement>('.rail-chip[data-chip="verify"]');
    expect(verify?.querySelector('.rail-chip__value')?.textContent).toBe('lock held');
    expect(verify?.querySelector('.rail-chip__flag')?.textContent).toBe('2 QUEUED');
  });

  it('folds the v4 KPI counts into the rail as data-kpi numbers matching boardKpis', () => {
    const jobs = [
      baseJob({ id: 'w1', status: 'working' }),
      baseJob({ id: 'w2', status: 'working' }),
      baseJob({ id: 'r1', status: 'in-review' }),
      baseJob({ id: 'm1', status: 'merged', prUrl: 'https://x/1', prState: 'merged' }),
      baseJob({ id: 'p1', status: 'parked' }),
      baseJob({ id: 'i1', status: 'in-review', prUrl: 'https://x/2', prState: 'conflicting' }),
    ];
    const agents = [
      agent('minion-live', { role: 'minion', state: 'streaming', lastActivity: new Date(Date.now() - 30_000).toISOString() }),
      agent('minion-idle', { role: 'minion', state: 'idle' }),
      agent('minion-dead', { role: 'minion', state: 'disposed' }),
      agent('lens', { role: 'perkins', state: 'streaming', lastActivity: new Date(Date.now() - 600_000).toISOString() }),
    ];
    const snapshotValue = snapshot({ jobs, agents });
    const kpis = boardKpis(snapshotValue);
    const view = new BoardView(() => {});
    view.render(snapshotValue);

    const values = new Map(
      [...document.querySelectorAll<HTMLElement>('[data-kpi]')].map((node) => [
        node.dataset.kpi ?? '',
        Number(node.textContent),
      ]),
    );
    expect(values.get('jobs.total')).toBe(kpis.jobs.total);
    expect(values.get('jobs.working')).toBe(kpis.jobs.working);
    expect(values.get('jobs.inReview')).toBe(kpis.jobs.inReview);
    expect(values.get('jobs.merged')).toBe(kpis.jobs.merged);
    expect(values.get('jobs.done')).toBe(kpis.jobs.done);
    expect(values.get('jobs.parked')).toBe(kpis.jobs.parked);
    expect(values.get('prs.open')).toBe(kpis.prs.open);
    expect(values.get('prs.conflicting')).toBe(kpis.prs.conflicting);
    expect(values.get('prs.mergedToday')).toBe(kpis.prs.mergedToday);
    expect(values.get('lanes.liveMinions')).toBe(kpis.lanes.liveMinions);
    expect(values.get('lanes.midTurn')).toBe(kpis.lanes.midTurn);
    expect(values.get('lanes.disposed')).toBe(kpis.lanes.disposed);
    // The numbers themselves (not a vacuous mirror).
    expect(values.get('jobs.total')).toBe(6);
    expect(values.get('jobs.working')).toBe(2);
    expect(values.get('prs.conflicting')).toBe(1);
    expect(values.get('lanes.liveMinions')).toBe(2);
    expect(values.get('lanes.disposed')).toBe(1);
    // A conflict is the loudest PR state: the number carries the alert ink.
    const conflicting = [...document.querySelectorAll<HTMLElement>('[data-kpi="prs.conflicting"]')][0];
    expect(conflicting?.classList.contains('rail-kpi__num--alert')).toBe(true);

    // v6.1 ruling 5: every rendered number carries its visible label —
    // adjacency in the DOM, not a tooltip promise.
    const fields = [...document.querySelectorAll<HTMLElement>('.rail-kpi__field')];
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      const label = field.querySelector<HTMLElement>('.rail-kpi__field-label');
      const num = field.querySelector<HTMLElement>('[data-kpi]');
      expect(label?.textContent, `${num?.dataset.kpi} label text`).toBeTruthy();
      expect(num, `${label?.textContent} number`).not.toBeNull();
      expect(label?.nextElementSibling).toBe(num);
    }
    const groupLabels = [...document.querySelectorAll<HTMLElement>('.rail-kpi__label')].map(
      (node) => node.textContent ?? '',
    );
    expect(groupLabels.some((text) => text.startsWith('HEISTS'))).toBe(true);
    expect(groupLabels.some((text) => text.startsWith('PRS'))).toBe(true);
    expect(groupLabels.some((text) => text.startsWith('CREW'))).toBe(true);
    expect(groupLabels.some((text) => text.includes('MINIONS'))).toBe(false);
  });

  it('keeps the Jev decisions chip and unacked badge inside the TRACKERS chip', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        decisions: {
          enabled: true,
          status: 'ready',
          reason: null,
          credentialPresent: true,
          credentialSource: 'file',
          checkedAt: '2026-01-01T00:00:00.000Z',
          generation: 3,
        },
        unackedActionRequired: 2,
      }),
    );
    const trackers = document.querySelector<HTMLElement>('.rail-chip[data-chip="trackers"]');
    expect(trackers).not.toBeNull();
    const chip = trackers?.querySelector<HTMLElement>('#board-decisions');
    expect(chip?.textContent).toBe('Jev: READY');
    expect(chip?.dataset.state).toBe('ready');
    expect(chip?.classList.contains('pp-chip--done')).toBe(true);
    const unacked = trackers?.querySelector<HTMLElement>('#board-unacked');
    expect(unacked?.hidden).toBe(false);
    expect(unacked?.textContent).toContain('2 needs Gru');
  });

  it('shows the NEEDS GRU machine-queue chip only when the table has pending rows', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ unackedActionRequired: 0 }));
    const chip = document.querySelector<HTMLElement>('.rail-chip[data-chip="trackers"] #board-unacked');
    expect(chip?.hidden).toBe(true);
    view.render(snapshot({ unackedActionRequired: 2 }));
    expect(chip?.hidden).toBe(false);
    expect(chip?.textContent).toContain('2 needs Gru');
  });

  it('shows the wake tracker inside TRACKERS with the durable count and last-fire stamp', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ wakes: { count: 0, lastAt: null } }));
    expect(document.querySelector<HTMLElement>('.rail-chip[data-chip="trackers"] #board-wakes')?.hidden).toBe(true);
    view.render(snapshot({ wakes: { count: 3, lastAt: '2026-01-01T00:00:00.000Z' } }));
    const chip = document.querySelector<HTMLElement>('.rail-chip[data-chip="trackers"] #board-wakes');
    expect(chip?.hidden).toBe(false);
    expect(chip?.textContent).toContain('3 wakes');
    expect(chip?.title).toContain('wake turn');
  });
});

describe('board v6 — dense job rows', () => {
  beforeEach(mountBoardDom);

  it('renders one row pair: line 1 dot/title/status, line 2 branch/ages/PR link', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ prUrl: 'https://example.invalid/pr/7' })] }));
    const row = document.querySelector<HTMLElement>('.board-job');
    if (row === null) throw new Error('row missing');
    expect(row.dataset.jobId).toBe('job-1');
    expect(row.dataset.expanded).toBe('false');

    const head = row.querySelector('.board-job__head');
    expect(head?.querySelector('.board-job__dot')?.className).toContain('board-job__dot--rev');
    expect(head?.querySelector('.board-job__chevron')?.textContent).toBe('▸');
    expect(head?.querySelector('.board-job__name')?.textContent).toBe('Review job');
    expect(head?.querySelector('.board-job__status')?.textContent).toBe('in-review');

    const meta = row.querySelector('.board-job__meta');
    expect(meta?.querySelector('.board-job__repo')?.textContent).toBe('📦 demo');
    expect(meta?.querySelector('.board-job__branch')?.textContent).toContain('gru/job-1');
    expect(meta?.querySelector('.board-job__lane-age')?.textContent).toMatch(/^heist \d+[smhd]$/);
    expect(meta?.querySelector('.board-job__agent-age')?.textContent).toMatch(/^minion \d+[smhd]$/);
    expect(meta?.querySelector<HTMLAnchorElement>('.board-job__pr')?.getAttribute('href')).toBe(
      'https://example.invalid/pr/7',
    );

    // No detail nodes exist until the row is expanded.
    expect(row.querySelector('.board-job__body')).toBeNull();
    expect(document.querySelector('.board-lane, .board-round, .board-lens, .board-job__note')).toBeNull();
  });

  it('tints failing rows with the alert accent (left border) and leaves clean rows calm', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'clean', status: 'in-review' }),
          baseJob({ id: 'blocked', status: 'blocked' }),
          baseJob({ id: 'aborted', status: 'in-review', rounds: [baseRound({ status: 'aborted', verdict: null })] }),
          baseJob({
            id: 'lens-error',
            status: 'in-review',
            rounds: [baseRound({ status: 'live', lenses: [{ lens: 'blind', state: 'error', agentId: null, note: null, verdict: null }] })],
          }),
        ],
      }),
    );
    expandForGru();
    const failing = new Map(
      [...document.querySelectorAll<HTMLElement>('.board-job')].map((row) => [row.dataset.jobId, row.classList.contains('board-job--alert')]),
    );
    expect(failing.get('clean')).toBe(false);
    expect(failing.get('blocked')).toBe(true);
    expect(failing.get('aborted')).toBe(true);
    expect(failing.get('lens-error')).toBe(true);
    // A verdict-posted round closes the alarm.
    expect(jobFailing(baseJob({ rounds: [baseRound({ status: 'verdict-posted' })] }))).toBe(false);
    expect(jobFailing(baseJob({ status: 'done', rounds: [] }))).toBe(false);
  });

  it('expands inline from a click anywhere on the summary and collapses again; the PR link does not toggle', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ prUrl: 'https://example.invalid/pr/7' })] }));
    const row = document.querySelector<HTMLElement>('.board-job');
    if (row === null) throw new Error('row missing');
    const control = row.querySelector<HTMLButtonElement>('.board-job__toggle');
    if (control === null) throw new Error('toggle missing');

    row.querySelector<HTMLElement>('.board-job__meta')?.click();
    expect(row.dataset.expanded).toBe('true');
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(row.querySelector('.board-job__body')).not.toBeNull();
    expect(row.querySelector('.board-lane')).not.toBeNull();
    expect(row.querySelector('.board-round')).not.toBeNull();
    expect(row.querySelector('.board-job__chevron')?.textContent).toBe('▾');

    const pr = row.querySelector<HTMLAnchorElement>('.board-job__pr');
    pr?.addEventListener('click', (event) => event.preventDefault());
    pr?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(row.dataset.expanded).toBe('true');

    control.click();
    expect(row.dataset.expanded).toBe('false');
    expect(row.querySelector('.board-job__body')).toBeNull();
    expect(row.querySelector('.board-job__chevron')?.textContent).toBe('▸');
  });

  it('persists per-job expansion in storage and restores it for a fresh view (reload)', () => {
    const storage = memoryStorage();
    const view = new BoardView(() => {}, null, storage);
    view.render(snapshot());
    expect(storage.getItem('gru-board-expanded-jobs')).toBeNull();

    document.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    expect(JSON.parse(storage.getItem('gru-board-expanded-jobs') ?? 'null')).toEqual(['job-1']);

    // A fresh view over the same storage = a page reload.
    const reloaded = new BoardView(() => {}, null, storage);
    reloaded.render(snapshot());
    const row = document.querySelector<HTMLElement>('.board-job');
    expect(row?.dataset.expanded).toBe('true');
    expect(row?.querySelector('.board-job__body')).not.toBeNull();

    document.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    expect(storage.getItem('gru-board-expanded-jobs')).toBeNull();
    const collapsedAgain = new BoardView(() => {}, null, storage);
    collapsedAgain.render(snapshot());
    expect(document.querySelector<HTMLElement>('.board-job')?.dataset.expanded).toBe('false');
  });

  it('keeps actionable state on the collapsed face: unacked action-required + failed live round', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            rounds: [
              baseRound({
                lenses: [
                  { lens: 'blind', state: 'done', agentId: 'lens-agent', note: 'blocker — unsafe retry', verdict: 'blocker' },
                  { lens: 'security', state: 'error', agentId: 'lens-agent-2', note: 'provider cap hit', verdict: null },
                  { lens: 'tests', state: 'live', agentId: 'lens-agent-3', note: null, verdict: null },
                ],
              }),
            ],
          }),
        ],
        notifications: [notification('n1', { agentId: 'lens-agent' })],
        agents: [agent('lens-agent', { jobId: 'job-1' })],
        unackedActionRequired: 1,
      }),
    );
    expandForGru();
    const signal = document.querySelector('.board-job__signal');
    expect(signal?.textContent).toContain('1 needs Gru');
    expect(signal?.textContent).toContain('1 blocker');
    expect(signal?.textContent).toContain('1 lens failure');
    expect(signal?.classList.contains('pp-chip--alert')).toBe(true);
    expect(document.querySelector('.board-job__body')).toBeNull();
  });

  it('marks an aborted latest round on the collapsed row', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ rounds: [baseRound({ status: 'aborted', verdict: null })] })] }));
    const signal = document.querySelector('.board-job__signal');
    expect(signal?.textContent).toContain('round 1 aborted');
    expect(signal?.classList.contains('pp-chip--alert')).toBe(true);
    expect(document.querySelector('.board-job__body')).toBeNull();
  });

  it('a new live round updates the collapsed signal without auto-expanding', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ rounds: [baseRound({ status: 'pending' })] })] }));
    expect(document.querySelector('.board-job__signal')?.textContent).toContain('pending');

    view.render(snapshot());
    const row = document.querySelector<HTMLElement>('.board-job');
    expect(row?.dataset.expanded).toBe('false');
    expect(row?.querySelector('.board-job__body')).toBeNull();
    expect(row?.querySelector('.board-job__signal')?.textContent).toContain('live');
  });

  it('slides in only the rows new to the view (8px enter animation)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ id: 'first', status: 'in-review' })] }));
    expect(document.querySelector('.board-job--enter')).toBeNull();

    view.render(
      snapshot({ jobs: [baseJob({ id: 'first', status: 'in-review' }), baseJob({ id: 'second', status: 'in-review' })] }),
    );
    const entering = [...document.querySelectorAll<HTMLElement>('.board-job--enter')].map(
      (node) => node.dataset.jobId,
    );
    expect(entering).toEqual(['second']);
  });
});

describe('board round progress labels (R9/T14/N8)', () => {
  beforeEach(mountBoardDom);

  it('renders the truthful lenses-ran label counting failed-and-ran lenses, with the failure history on the chip', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({
      jobs: [baseJob({
        status: 'in-review',
        rounds: [baseRound({
          status: 'live',
          lensAttempts: [{ lens: 'blind', attempts: 2 }, { lens: 'security', attempts: 1 }, { lens: 'edge', attempts: 2 }],
          lenses: [
            { lens: 'blind', state: 'done', agentId: null, note: 'blocker — unsafe retry; earlier failed attempt: a1 timeout', verdict: 'blocker' },
            { lens: 'security', state: 'done', agentId: null, note: 'clean — nothing found', verdict: 'clean' },
            { lens: 'edge', state: 'error', agentId: null, note: 'specialist attempts failed: a1 timeout: x; a2 timeout: y', verdict: null },
            { lens: 'tests', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
          ],
        })],
      })],
    }));
    const row = document.querySelector<HTMLElement>('.board-job');
    if (row === null) throw new Error('row missing');
    // Reveal the round body to render the round header row.
    row.querySelector<HTMLElement>('.board-job__meta')?.click();
    const label = row.querySelector<HTMLElement>('.board-round__lens-progress');
    if (label === null) throw new Error('lens progress label missing');
    // blind + security + edge actually ran (edge failed): 3 ran, 1 failed,
    // 1 not used — the label must mean what it counts.
    expect(label.textContent).toBe('3/4 lenses ran · 1 failed · 1 not used');
    // Reveal the per-lens chips: the failure history stays visible on the
    // errored chip after the later success of its siblings (T12).
    row.querySelector<HTMLButtonElement>('.board-round__toggle')?.click();
    const edgeChip = [...row.querySelectorAll<HTMLElement>('.board-lens')].find((chip) => chip.textContent?.includes('edge'));
    expect(edgeChip?.title).toContain('specialist attempts failed');
    const blindChip = [...row.querySelectorAll<HTMLElement>('.board-lens')].find((chip) => chip.textContent?.includes('blind'));
    expect(blindChip?.title).toContain('earlier failed attempt');
  });

  it('keeps the clean full-usage label unchanged (7/7 lenses)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({
      jobs: [baseJob({
        status: 'in-review',
        rounds: [baseRound({
          status: 'live',
          lensAttempts: [],
          lenses: [
            { lens: 'blind', state: 'done', agentId: null, note: 'blocker — x', verdict: 'blocker' },
            { lens: 'security', state: 'done', agentId: null, note: 'clean', verdict: 'clean' },
          ],
        })],
      })],
    }));
    const row = document.querySelector<HTMLElement>('.board-job');
    if (row === null) throw new Error('row missing');
    row.querySelector<HTMLElement>('.board-job__meta')?.click();
    const label = row.querySelector<HTMLElement>('.board-round__lens-progress');
    expect(label?.textContent).toBe('2/2 lenses');
  });
});

describe('board lens chips — unused lenses are neutral, never a pass', () => {
  beforeEach(mountBoardDom);

  const notUsed = (lens: string): { lens: string; state: string; agentId: null; note: string; verdict: string } => ({
    lens,
    state: 'done',
    agentId: null,
    note: 'not used — lead-owned whole-PR review',
    verdict: 'clean',
  });

  function expandFirstRound(): HTMLElement {
    const row = document.querySelector<HTMLElement>('.board-job');
    if (row === null) throw new Error('job row missing');
    row.querySelector<HTMLElement>('.board-job__meta')?.click();
    row.querySelector<HTMLButtonElement>('.board-round__toggle')?.click();
    return row;
  }

  function chip(row: HTMLElement, lens: string): HTMLElement {
    const found = [...row.querySelectorAll<HTMLElement>('.board-lens')].find((node) =>
      node.textContent?.includes(lens),
    );
    if (found === undefined) throw new Error(`lens chip missing: ${lens}`);
    return found;
  }

  it('renders the screenshot round honestly: four unused gray with no tick, blind/edge/tests green', () => {
    const round5 = baseRound({
      status: 'verdict-posted',
      verdict: 'changes-requested',
      lensAttempts: [],
      lenses: [
        { lens: 'blind', state: 'done', agentId: null, note: 'clean — nothing found', verdict: 'clean' },
        { lens: 'edge', state: 'done', agentId: null, note: 'clean — nothing found', verdict: 'clean' },
        { lens: 'tests', state: 'done', agentId: null, note: 'clean — nothing found', verdict: 'clean' },
        notUsed('acceptance'),
        notUsed('security'),
        notUsed('architecture'),
        notUsed('codebase'),
      ],
    });
    const view = new BoardView(() => {});
    const push = (): void => {
      view.render(snapshot({ jobs: [baseJob({ status: 'in-review', rounds: [round5] })] }));
    };
    push();
    const row = expandFirstRound();
    // All seven pills stay visible.
    expect([...row.querySelectorAll<HTMLElement>('.board-lens')]).toHaveLength(7);
    expect(row.querySelectorAll('.board-lens.pp-chip--unused')).toHaveLength(4);
    expect(row.querySelectorAll('.board-lens.pp-chip--done')).toHaveLength(3);
    for (const lens of ['acceptance', 'security', 'architecture', 'codebase']) {
      const node = chip(row, lens);
      expect(node.classList.contains('pp-chip--unused')).toBe(true);
      expect(node.classList.contains('pp-chip--done')).toBe(false);
      expect(node.textContent).toContain('not used');
      expect(node.textContent).not.toContain('✓');
      expect(node.title).toBe('not used — lead-owned whole-PR review');
    }
    for (const lens of ['blind', 'edge', 'tests']) {
      const node = chip(row, lens);
      expect(node.classList.contains('pp-chip--done')).toBe(true);
      expect(node.textContent).toContain('✓');
      expect(node.textContent).not.toContain('not used');
    }
    expect(row.querySelector('.board-round__lens-progress')?.textContent).toBe('3/7 lenses ran · 4 not used');
    // A repeat snapshot push re-renders the same honest classification
    // (no stale green: the view keeps the job/round expanded).
    push();
    const pushed = document.querySelector<HTMLElement>('.board-job');
    if (pushed === null) throw new Error('job row missing after push');
    expect(pushed.querySelectorAll('.board-lens.pp-chip--unused')).toHaveLength(4);
    expect(pushed.querySelectorAll('.board-lens.pp-chip--done')).toHaveLength(3);
    expect(pushed.querySelector('.board-round__lens-progress')?.textContent).toBe('3/7 lenses ran · 4 not used');
  });

  it('keeps the four-unused/three-errors round distinct: unused gray, timeouts alert with attempts', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({
      jobs: [baseJob({
        status: 'in-review',
        rounds: [baseRound({
          status: 'verdict-posted',
          verdict: 'changes-requested',
          lensAttempts: [{ lens: 'edge', attempts: 2 }, { lens: 'codebase', attempts: 1 }, { lens: 'tests', attempts: 1 }],
          lenses: [
            notUsed('blind'),
            notUsed('acceptance'),
            notUsed('security'),
            notUsed('architecture'),
            { lens: 'edge', state: 'error', agentId: null, note: 'specialist attempts failed: a1 timeout; a2 timeout', verdict: null },
            { lens: 'codebase', state: 'error', agentId: null, note: 'specialist attempts failed: a1 timeout', verdict: null },
            { lens: 'tests', state: 'error', agentId: null, note: 'specialist attempts failed: a1 timeout', verdict: null },
          ],
        })],
      })],
    }));
    const row = expandFirstRound();
    expect(row.querySelectorAll('.board-lens.pp-chip--unused')).toHaveLength(4);
    expect(row.querySelectorAll('.board-lens.pp-chip--alert')).toHaveLength(3);
    for (const lens of ['blind', 'acceptance', 'security', 'architecture']) {
      const node = chip(row, lens);
      expect(node.classList.contains('pp-chip--unused')).toBe(true);
      expect(node.textContent).not.toContain('✓');
      expect(node.textContent).not.toContain('✕');
    }
    for (const lens of ['edge', 'codebase', 'tests']) {
      const node = chip(row, lens);
      expect(node.classList.contains('pp-chip--alert')).toBe(true);
      expect(node.textContent).toContain('✕');
      expect(node.title).toContain('specialist attempts failed');
    }
    // Attempt counts survive the failure (no used execution silently erased).
    expect(chip(row, 'edge').textContent).toContain('×2');
    expect(row.querySelector('.board-round__lens-progress')?.textContent).toBe('3/7 lenses ran · 3 failed · 4 not used');
  });

  it('keeps every state distinct in one mixed round: unused, clean, legacy done, live, pending, blocker, error', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({
      jobs: [baseJob({
        status: 'in-review',
        rounds: [baseRound({
          status: 'live',
          lensAttempts: [],
          lenses: [
            { lens: 'blind', state: 'done', agentId: null, note: 'blocker — unsafe retry', verdict: 'blocker' },
            { lens: 'edge', state: 'done', agentId: null, note: 'clean — nothing found', verdict: 'clean' },
            { lens: 'tests', state: 'done', agentId: null, note: null, verdict: null },
            notUsed('acceptance'),
            { lens: 'security', state: 'live', agentId: null, note: null, verdict: null },
            { lens: 'codebase', state: 'pending', agentId: null, note: null, verdict: null },
            { lens: 'architecture', state: 'error', agentId: null, note: 'provider cap', verdict: null },
          ],
        })],
      })],
    }));
    const row = expandFirstRound();
    const blocker = chip(row, 'blind');
    expect(blocker.classList.contains('board-lens--blocker')).toBe(true);
    expect(blocker.classList.contains('pp-chip--done')).toBe(true);
    expect(blocker.textContent).toContain('✓');
    const clean = chip(row, 'edge');
    expect(clean.classList.contains('pp-chip--done')).toBe(true);
    expect(clean.textContent).toContain('✓');
    // A legacy done record with a null note keeps the normal pass face.
    const legacyDone = chip(row, 'tests');
    expect(legacyDone.classList.contains('pp-chip--done')).toBe(true);
    expect(legacyDone.textContent).toContain('✓');
    const unused = chip(row, 'acceptance');
    expect(unused.classList.contains('pp-chip--unused')).toBe(true);
    expect(unused.textContent).not.toContain('✓');
    const live = chip(row, 'security');
    expect(live.classList.contains('pp-chip--work')).toBe(true);
    expect(live.textContent).toContain('◉');
    const pending = chip(row, 'codebase');
    expect(pending.classList.contains('pp-chip--park')).toBe(true);
    expect(pending.textContent).toContain('○');
    expect(pending.textContent).not.toContain('not used');
    const errored = chip(row, 'architecture');
    expect(errored.classList.contains('pp-chip--alert')).toBe(true);
    expect(errored.textContent).toContain('✕');
  });

  it('raw unknown unused state keeps the defensive ? + park face and honest counts', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({
      jobs: [baseJob({
        status: 'in-review',
        rounds: [baseRound({
          status: 'verdict-posted',
          verdict: 'changes-requested',
          lensAttempts: [],
          lenses: [
            { lens: 'blind', state: 'done', agentId: null, note: 'clean — nothing found', verdict: 'clean' },
            { lens: 'edge', state: 'unused', agentId: null, note: null, verdict: null },
            { lens: 'tests', state: 'unused', agentId: null, note: 'not used — prose', verdict: null },
            notUsed('acceptance'),
            { lens: 'security', state: 'pending', agentId: null, note: null, verdict: null },
            { lens: 'architecture', state: 'pending', agentId: null, note: null, verdict: null },
            { lens: 'codebase', state: 'pending', agentId: null, note: null, verdict: null },
          ],
        })],
      })],
    }));
    const row = expandFirstRound();
    // Seven pills stay visible; the two drift records show the frozen
    // unknown face — never the derived unused class, marker or wording.
    expect([...row.querySelectorAll<HTMLElement>('.board-lens')]).toHaveLength(7);
    for (const lens of ['edge', 'tests']) {
      const node = chip(row, lens);
      expect(node.classList.contains('pp-chip--park')).toBe(true);
      expect(node.classList.contains('pp-chip--unused')).toBe(false);
      expect(node.textContent).toContain('?');
      expect(node.textContent).not.toContain('not used');
      expect(node.textContent).not.toContain('—');
    }
    // Only the canonical record is unused; used/ran stay non-negative
    // (pre-fix the drift records drove ran to 0 and stole the unused slot).
    expect(row.querySelectorAll('.board-lens.pp-chip--unused')).toHaveLength(1);
    expect(row.querySelector('.board-round__lens-progress')?.textContent).toBe('1/7 lenses ran · 1 not used');
  });
});

describe('board v6 — bands', () => {
  beforeEach(mountBoardDom);

  it('renders the six sections in the approved owner-first order with counts', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'cold-1', status: 'parked' }),
          baseJob({ id: 'settled-1', status: 'delivered' }),
          baseJob({ id: 'flight-1', status: 'in-review' }),
          baseJob({ id: 'needs-1', status: 'blocked' }),
        ],
        pipeline: {
          entries: [
            { id: 'pipe-1', repo: 'demo', title: 'Queued one', priority: 3, enqueueSeq: 1, state: 'waiting', reason: 'waiting for dep — not enqueued', queuedAt: '2026-01-01T00:00:00.000Z' },
          ],
          pending: 1,
        },
      }),
    );
    // The jobs mount carries the five ordered sections; FOR YOU lives in
    // its own mount above (and stays first in document order).
    const bands = [...document.querySelectorAll<HTMLElement>('#board-jobs .board-band')];
    expect(bands.map((band) => band.querySelector('.board-band__label')?.textContent)).toEqual([
      'IN FLIGHT',
      'PIPELINE',
      'FOR GRU',
      'SETTLED',
      'COLD',
    ]);
    const owner = document.querySelector<HTMLElement>('#board-owner');
    expect(owner?.querySelector('.board-band__label')?.textContent).toBe('FOR YOU');
    expect(owner?.nextElementSibling?.id).toBe('board-jobs');
    for (const band of bands) {
      expect(band.querySelector('.board-band__head')).not.toBeNull();
    }
    expect(document.querySelector('.board-band--in-flight .board-job')?.getAttribute('data-job-id')).toBe('flight-1');
    expect(document.querySelector('.board-band--pipeline .board-pipeline__title')?.textContent).toBe('Queued one');
    expect(document.querySelector('.board-band--needs-you .board-job')).toBeNull(); // FOR GRU starts collapsed
    expandForGru();
    expect(document.querySelector('.board-band--needs-you .board-job')?.getAttribute('data-job-id')).toBe('needs-1');
    expect(document.querySelector('.board-band--settled .board-job')?.getAttribute('data-job-id')).toBe('settled-1');
    expect(document.querySelector('.board-band--cold .board-job')).toBeNull(); // count-only by default
    expect(document.querySelector('.board-band--settled .board-band__count')?.textContent).toBe('1 heist');

    // The sticky shortcut strip lists every section with its full count.
    const nav = [...document.querySelectorAll<HTMLAnchorElement>('#board-nav .board-nav__link')];
    expect(nav.map((link) => link.dataset.nav)).toEqual(['for-you', 'in-flight', 'pipeline', 'for-gru', 'settled', 'cold']);
    expect(nav.map((link) => link.querySelector('.board-nav__label')?.textContent)).toEqual([
      'For you',
      'In flight',
      'Pipeline',
      'For Gru',
      'Settled',
      'Cold',
    ]);
    expect(nav.map((link) => link.querySelector('.board-nav__count')?.textContent)).toEqual(['0', '1', '1', '1', '1', '1']);
    expect(nav.map((link) => link.getAttribute('href'))).toEqual([
      '#board-owner',
      '#board-section-in-flight',
      '#board-section-pipeline',
      '#board-section-for-gru',
      '#board-section-settled',
      '#board-section-cold',
    ]);
    expect(document.getElementById('board-nav')?.hidden).toBe(false);
    // Dense rows, not a card grid.
    expect(document.querySelector('.board-band__grid')).toBeNull();
  });

  it('promotes a conflicting PR to FOR GRU and demotes a stalled working lane to COLD with a stale flag', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'conflicting-job',
            status: 'in-review',
            prUrl: 'https://x/1',
            prState: 'conflicting',
          }),
          baseJob({
            id: 'stalled-job',
            status: 'working',
            lastAgentActivity: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
          baseJob({ id: 'fresh-job', status: 'working' }),
        ],
      }),
    );
    expect(document.querySelector('.board-band--needs-you .board-job')?.getAttribute('data-job-id')).toBe('conflicting-job');
    expect(document.querySelector('.board-band--in-flight .board-job')?.getAttribute('data-job-id')).toBe('fresh-job');
    const stalled = document.querySelector<HTMLElement>('.board-band--cold .board-job');
    expect(stalled).toBeNull(); // cold stays count-only until expanded
    const coldToggle = document.querySelector<HTMLButtonElement>('.board-band--cold .board-band__more');
    expect(coldToggle?.getAttribute('aria-expanded')).toBe('false');
    coldToggle?.click();
    const stalledRow = document.querySelector<HTMLElement>('.board-band--cold .board-job');
    expect(stalledRow?.getAttribute('data-job-id')).toBe('stalled-job');
    expect(stalledRow?.querySelector('.board-job__stale')?.textContent).toBe('stalled');
    // v6.1 vocabulary rides the flag's tooltip too: the worker word is
    // minion, never agent (owner ruling 3).
    expect(stalledRow?.querySelector<HTMLElement>('.board-job__stale')?.title).toBe(
      'working with no minion frames past the stall window',
    );
  });

  it('attributes unacked action-required notifications through agent bindings', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'quiet-job', status: 'parked' })],
        agents: [agent('minion-1', { role: 'minion', jobId: 'quiet-job' })],
        notifications: [notification('n1', { agentId: 'minion-1' })],
        unackedActionRequired: 1,
      }),
    );
    expandForGru();
    const band = document.querySelector<HTMLElement>('.board-band--needs-you');
    expect(band?.querySelector('.board-band__label')?.textContent).toBe('FOR GRU');
    expect(band?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('quiet-job');
  });

  it('credits every row with its repo — grouping rides the rows, not wrapper shells', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        repos: [
          {
            name: 'alpha',
            jobs: [
              baseJob({ id: 'a-needs', repo: 'alpha', status: 'blocked' }),
              baseJob({ id: 'a-flight', repo: 'alpha', status: 'in-review' }),
            ],
          },
          { name: 'beta', jobs: [baseJob({ id: 'b-needs', repo: 'beta', status: 'blocked' })] },
        ],
      }),
    );
    expandForGru();
    const needsYou = document.querySelector<HTMLElement>('.board-band--needs-you');
    expect(needsYou?.querySelector('.board-band__label')?.textContent).toBe('FOR GRU');
    const needsRepos = [...(needsYou?.querySelectorAll('.board-job__repo') ?? [])].map((node) => node.textContent);
    expect(needsRepos).toContain('📦 alpha');
    expect(needsRepos).toContain('📦 beta');
    const flight = document.querySelector<HTMLElement>('.board-band--in-flight');
    expect(flight?.querySelector('.board-job__repo')?.textContent).toBe('📦 alpha');
  });

  it('previews the 3 newest settled jobs with a show-older control; expansion and collapse are reversible session state', () => {
    const jobs = Array.from({ length: 12 }, (_, index) =>
      baseJob({
        id: `settled-${String(index).padStart(2, '0')}`,
        status: 'delivered',
        updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
      }),
    );
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs }));

    const settled = document.querySelector('.board-band--settled');
    expect(settled?.querySelectorAll('.board-job')).toHaveLength(3);
    expect(settled?.querySelector('.board-band__count')?.textContent).toBe('12 heists');
    const more = settled?.querySelector<HTMLButtonElement>('.board-band__more');
    expect(more?.textContent).toBe('Show older settled (+9)');
    expect(more?.getAttribute('aria-expanded')).toBe('false');
    expect(more?.getAttribute('aria-controls')).toBe('board-section-settled-body');

    more?.click();
    const expanded = document.querySelector('.board-band--settled');
    expect(expanded?.querySelectorAll('.board-job')).toHaveLength(12);
    const fewer = expanded?.querySelector<HTMLButtonElement>('.board-band__more');
    expect(fewer?.textContent).toBe('Show fewer');
    expect(fewer?.getAttribute('aria-expanded')).toBe('true');

    // Expanded is a session state: the next snapshot push keeps it open...
    view.render(snapshot({ jobs }));
    expect(document.querySelectorAll('.board-band--settled .board-job')).toHaveLength(12);
    // ...and Show fewer closes it again.
    document.querySelector<HTMLButtonElement>('.board-band--settled .board-band__more')?.click();
    expect(document.querySelectorAll('.board-band--settled .board-job')).toHaveLength(3);
  });

  it('keeps an empty FOR GRU section visible as a calm compact state', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ id: 'flight', status: 'in-review' })] }));
    const needsYou = document.querySelector('.board-band--needs-you');
    expect(needsYou?.querySelector('.board-band__label')?.textContent).toBe('FOR GRU');
    expect(needsYou?.querySelector('.board-band__clear-text')?.textContent).toBe('nothing needs Gru');
    expect(needsYou?.querySelector('.board-band__clear-mark')?.textContent).toBe('✓');
  });

  it('renders compact empty states for every section when the board is quiet', () => {
    const view = new BoardView(() => {});
    // No repos, no jobs, no pipeline: every shortcut keeps a valid target.
    view.render(snapshot({ repos: [] }));
    const labels = [...document.querySelectorAll<HTMLElement>('#board-jobs .board-band__label')].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(['IN FLIGHT', 'PIPELINE', 'FOR GRU', 'SETTLED', 'COLD']);
    expect(document.querySelectorAll('#board-jobs .board-band__empty')).toHaveLength(4);
    expect(document.querySelector('.board-band--needs-you .board-band__clear-text')?.textContent).toBe('nothing needs Gru');
    expect(document.querySelector('.board-band--pipeline .board-band__empty')?.textContent).toBe('no approved work waiting');

    // Jobs on the board but nobody aboard: the crew rail says crew, not agents.
    view.render(snapshot({ jobs: [baseJob({ id: 'solo', status: 'working' })], agents: [] }));
    expect(document.querySelector('#board-agents')?.textContent).toContain('no crew yet');
    expect(document.getElementById('rail-agents-count')?.textContent).toBe('0');
  });
});

describe('board v4.1/v6 — stale review pills on concluded jobs', () => {
  beforeEach(mountBoardDom);

  it('suppresses stale review liveness pills on merged/done rows', () => {
    const view = new BoardView(() => {});
    const quietRound = { blockers: 0, lenses: [], lensAttempts: [] } as const;
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'merged-live', status: 'merged', rounds: [baseRound({ ...quietRound, status: 'live' })] }),
          baseJob({ id: 'done-pending', status: 'done', rounds: [baseRound({ ...quietRound, status: 'pending' })] }),
        ],
      }),
    );
    expandCold();
    expect(document.querySelector('.board-job__signal')).toBeNull();
  });

  it('renders a merged job’s history quiescent: no blocker/failure chips, one ledger pointer', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'merged-aborted',
            status: 'merged',
            rounds: [
              baseRound({ status: 'aborted', verdict: null }),
              baseRound({ id: 'job-1-r2', seq: 2, status: 'verdict-posted', verdict: 'approved', blockers: 0, lenses: [] }),
            ],
          }),
        ],
      }),
    );
    expandCold();
    document.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    const body = document.querySelector('.board-job__body');
    expect(body).not.toBeNull();
    // Only the LAST round survives, quiet: no blockers/failures chips.
    expect(body?.querySelectorAll('.board-round')).toHaveLength(1);
    expect(body?.querySelector('.board-round--quiescent')).not.toBeNull();
    expect(body?.querySelector('.board-round__blockers')).toBeNull();
    expect(body?.querySelector('.board-round__failures')).toBeNull();
    expect(body?.querySelector('.board-job__reviewed')?.textContent).toContain('review history on the ledger');
  });

  it('keeps live rounds alarming on in-flight jobs (the suppression is scoped to concluded)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    document.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    const round = document.querySelector('.board-round');
    expect(round?.classList.contains('board-round--quiescent')).toBe(false);
    expect(document.querySelector('.board-round__blockers')?.textContent).toContain('1 blocker');
  });
});

describe('board agent rail — dense rows, tabs count, disposed collapse', () => {
  beforeEach(mountBoardDom);

  it('collapses disposed rows by default, expands on toggle, and keeps the toggle across pushes', () => {
    const view = new BoardView(() => {});
    const agents = [
      agent('live-lens', { state: 'streaming', label: 'blind:001' }),
      agent('live-gru', { role: 'gru', state: 'idle' }),
      agent('old-gru', { role: 'gru', state: 'disposed', label: 'gru · old epoch' }),
      agent('old-lens', { state: 'disposed', label: 'blind:001#2' }),
    ];
    view.render(snapshot({ agents }));
    // Live rows only — the graveyard is behind the toggle.
    expect(document.querySelectorAll('#board-agents .board-agent')).toHaveLength(2);
    expect(document.querySelector('#board-agents .board-agent--disposed')).toBeNull();
    const toggle = document.querySelector<HTMLButtonElement>('.board-agent-toggle');
    expect(toggle?.textContent).toContain('2 disposed');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    // The AGENTS tab counts the live crew.
    expect(document.getElementById('rail-agents-count')?.textContent).toBe('2');

    toggle?.click();
    expect(document.querySelectorAll('#board-agents .board-agent')).toHaveLength(4);
    expect(document.querySelectorAll('#board-agents .board-agent--disposed')).toHaveLength(2);
    expect(document.querySelector('.board-agent-toggle')?.getAttribute('aria-expanded')).toBe('true');

    // A snapshot push re-renders: the expanded state survives.
    view.render(snapshot({ agents }));
    expect(document.querySelectorAll('#board-agents .board-agent--disposed')).toHaveLength(2);

    document.querySelector<HTMLButtonElement>('.board-agent-toggle')?.click();
    expect(document.querySelectorAll('#board-agents .board-agent')).toHaveLength(2);
  });

  it('renders dense rows: dot + name + hash + role·state subline + right chip', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [agent('minion-live', { role: 'minion', label: 'Payment lane', state: 'streaming' })],
      }),
    );
    const row = document.querySelector<HTMLElement>('#board-agents .board-agent');
    expect(row?.dataset.state).toBe('streaming');
    expect(row?.querySelector('.board-agent__dot')).not.toBeNull();
    expect(row?.querySelector('.board-agent__name')?.textContent).toBe('Payment lane');
    expect(row?.querySelector('.board-agent__hash')?.textContent).toBe('minion-live'.slice(0, 8));
    expect(row?.querySelector('.board-agent__sub')?.textContent).toContain('minion · streaming');
    expect(row?.querySelector('.board-agent__state')?.textContent).toBe('streaming');
  });

  it('tints error rows with the alert accent', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [
          agent('faulty', { state: 'error' }),
          agent('healthy', { state: 'idle' }),
        ],
      }),
    );
    const rows = [...document.querySelectorAll<HTMLElement>('#board-agents .board-agent')];
    const byId = new Map(rows.map((row) => [row.querySelector('.board-agent__name')?.textContent, row]));
    expect(byId.get('faulty')?.classList.contains('board-agent--error')).toBe(true);
    expect(byId.get('healthy')?.classList.contains('board-agent--error')).toBe(false);
  });

  it('shows a turn-age counter on streaming agents only', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [
          agent('streaming-lens', { state: 'streaming', lastActivity: new Date(Date.now() - 90_000).toISOString() }),
          agent('idle-lens', { state: 'idle' }),
          agent('disposed-lens', { state: 'disposed' }),
        ],
      }),
    );
    const streaming = document.querySelector('#board-agents .board-agent');
    expect(streaming?.textContent).toContain('streaming-lens');
    expect(streaming?.querySelector('.board-agent__age')?.textContent).toMatch(/^\d+[smhd] quiet$/);
    expect(document.querySelectorAll('#board-agents .board-agent__age')).toHaveLength(1);
  });
});

describe('board v6 — job status tones', () => {
  beforeEach(mountBoardDom);

  it('renders the delivered chip in the work color family and its dot in the same tone', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ status: 'delivered' })] }));
    const row = document.querySelector('#board-jobs .board-job');
    const chip = row?.querySelector('.board-job__status');
    expect(chip?.textContent).toBe('delivered');
    expect(chip?.className).toContain('pp-chip--work');
    expect(chip?.className).not.toContain('pp-chip--rev');
    expect(row?.querySelector('.board-job__dot')?.className).toContain('board-job__dot--work');
  });
});

describe('FOR YOU owner band (permanent, top of board)', () => {
  beforeEach(mountBoardDom);

  function ownerPr(jobId: string, overrides: Partial<NonNullable<BoardSnapshot['ownerPrs']>[number]> = {}) {
    return {
      id: `owner-pr:${jobId}`,
      jobId,
      jobTitle: `Heist ${jobId}`,
      repo: 'demo',
      prUrl: 'https://github.com/example/demo/pull/7',
      sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
      checkedAt: '2026-01-01T00:05:00.000Z',
      ...overrides,
    };
  }

  function stubClient(ackResult: Promise<void> | Error = Promise.resolve()) {
    return {
      ackNotification: vi.fn(() => (ackResult instanceof Error ? Promise.reject(ackResult) : ackResult)),
      markNotificationShown: vi.fn(() => Promise.resolve(true)),
    } as unknown as import('../lib/board-client.js').BoardClient;
  }

  it('shows only the owner stop under FOR YOU with count; the machine incident stays in NEEDS GRU (bell), not the band', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        notifications: [
          notification('owner-stop', { routing: 'needs-owner', kind: 'supervision.breaker', severity: 'info' }),
          notification('machine', { routing: 'action-required' }),
        ],
        unackedActionRequired: 1,
        unackedNeedsOwner: 1,
      }),
    );
    const band = document.getElementById('board-owner')!;
    expect(band.hidden).toBe(false);
    expect(band.querySelector('.board-band__label')?.textContent).toBe('FOR YOU');
    expect(band.querySelector('.board-band__count')?.textContent).toBe('1 pending');
    const actionIds = [...band.querySelectorAll('[data-action-id]')].map((node) => (node as HTMLElement).dataset.actionId);
    expect(actionIds).toEqual(['owner-ack:owner-stop']);
    // The machine row is in the bell panel's NEEDS GRU section, never in the band.
    expect(document.getElementById('notification-list')?.textContent).toContain('Notice machine');
    expect(band.textContent).not.toContain('Notice machine');
    // The other board groups still render below the band.
    expect(document.getElementById('board-jobs')!.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });

  it('an empty owner list is the calm clear state — never hidden, never an alarm', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ notifications: [] }));
    const band = document.getElementById('board-owner')!;
    expect(band.hidden).toBe(false);
    expect(band.querySelector('.board-band__count')?.textContent).toBe('0 pending');
    expect(band.querySelector('.board-band__clear-text')?.textContent).toBe('nothing needs you');
  });

  it('seen/opened does not reduce the pending count (only an authoritative ack closes a row)', () => {
    const view = new BoardView(() => {});
    const seen = notification('seen-stop', { routing: 'needs-owner', shownAt: '2026-01-01T00:00:00.000Z' });
    view.render(snapshot({ notifications: [seen], unackedNeedsOwner: 1 }));
    // Opening the bell panel marks seen but completes nothing.
    (document.getElementById('notification-bell') as HTMLButtonElement).click();
    expect(document.getElementById('board-owner')!.querySelector('.board-band__count')?.textContent).toBe('1 pending');
    view.render(snapshot({ notifications: [seen], unackedNeedsOwner: 1 }));
    expect(document.getElementById('board-owner')!.querySelector('.board-band__count')?.textContent).toBe('1 pending');
    // The authoritative snapshot (ack from ANY device) is what closes it.
    view.render(snapshot({ notifications: [{ ...seen, ackedAt: '2026-01-01T00:09:00.000Z' }], unackedNeedsOwner: 0 }));
    expect(document.getElementById('board-owner')!.querySelector('.board-band__count')?.textContent).toBe('0 pending');
  });

  it('ack click: optimistic pending state, stays pending on failure (control reverts), closes only on the authoritative snapshot', async () => {
    const client = stubClient(new Error('network ambiguity'));
    const view = new BoardView(() => {}, client);
    const stop = notification('ack-me', { routing: 'needs-owner', kind: 'supervision.provider-wall.a1.quota_exceeded' });
    view.render(snapshot({ notifications: [stop] }));
    const band = document.getElementById('board-owner')!;
    const button = band.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:ack-me"]')!;
    // Honest consequence copy rides the row (quota ack scope).
    expect(band.textContent).toContain('does NOT clear code/test/review holds');
    button.click();
    expect(button.textContent).toBe('acking…');
    expect(button.disabled).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.ackNotification).toHaveBeenCalledWith('ack-me');
    // Failed HTTP → the obligation stands and the control returns.
    expect(button.textContent).toBe('Ack');
    expect(button.disabled).toBe(false);
    view.render(snapshot({ notifications: [stop] }));
    expect(band.querySelector('[data-action-id="owner-ack:ack-me"]')).not.toBeNull();
    // Success → STILL pending until the authoritative snapshot lands.
    const okClient = stubClient();
    const view2 = new BoardView(() => {}, okClient);
    view2.render(snapshot({ notifications: [stop] }));
    const button2 = document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('.board-owner__ack')!;
    button2.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById('board-owner')!.querySelector('[data-action-id="owner-ack:ack-me"]')).not.toBeNull();
    view2.render(snapshot({ notifications: [{ ...stop, ackedAt: '2026-01-01T00:09:00.000Z' }] }));
    expect(document.getElementById('board-owner')!.querySelector('[data-action-id="owner-ack:ack-me"]')).toBeNull();
  });

  it('ready PR row: affected heist + exact-head reason + OPEN PR external link; non-https URLs fail closed', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ ownerPrs: [ownerPr('job-ready')] }));
    const band = document.getElementById('board-owner')!;
    expect(band.querySelector('.board-band__count')?.textContent).toBe('1 pending');
    const row = band.querySelector('.board-owner__row--pr')!;
    expect(row.textContent).toContain('Heist job-ready');
    expect(row.textContent).toContain('aaaa1111');
    expect(row.textContent).toContain('CI green');
    const link = row.querySelector<HTMLAnchorElement>('.board-owner__open');
    expect(link?.href).toBe('https://github.com/example/demo/pull/7');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toContain('noreferrer');
    // Fail closed on an unsafe URL: no link is fabricated.
    view.render(snapshot({ ownerPrs: [ownerPr('bad-url', { prUrl: 'javascript:alert(1)' })] }));
    const badRow = document.getElementById('board-owner')!.querySelectorAll('.board-owner__row--pr')[0]!;
    expect(badRow.querySelector('a')).toBeNull();
    expect(badRow.textContent).toContain('PR link unavailable');
  });

  it('older pending obligations stay reachable behind the +N older expander', () => {
    const view = new BoardView(() => {});
    const stops = Array.from({ length: 9 }, (_, i) =>
      notification(`old-${String(i).padStart(2, '0')}`, { routing: 'needs-owner', ts: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z` }),
    );
    view.render(snapshot({ notifications: stops }));
    const band = document.getElementById('board-owner')!;
    expect(band.querySelectorAll('.board-owner__row')).toHaveLength(6);
    const more = band.querySelector<HTMLButtonElement>('.board-band__more')!;
    expect(more.textContent).toBe('+3 older pending');
    more.click();
    expect(document.getElementById('board-owner')!.querySelectorAll('.board-owner__row')).toHaveLength(9);
  });

  it('a snapshot re-render preserves focus on the same action and fires no toast', () => {
    const toast = vi.fn();
    const view = new BoardView(() => {});
    view.setToastHandler(toast);
    const stop = notification('focus-me', { routing: 'needs-owner' });
    view.render(snapshot({ notifications: [stop] }));
    const button = document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:focus-me"]')!;
    button.focus();
    expect(document.activeElement).toBe(button);
    // A refresh of the SAME data re-renders the band: no new arrival, so
    // no toast — and the focused control keeps its place.
    view.render(snapshot({ notifications: [stop] }));
    expect(toast).not.toHaveBeenCalled();
    const refocused = document.getElementById('board-owner')!.querySelector<HTMLElement>('[data-action-id="owner-ack:focus-me"]');
    expect(document.activeElement).toBe(refocused);
    expect((document.activeElement as HTMLElement)?.dataset.actionId).toBe('owner-ack:focus-me');
  });

  it('FOR YOU r1 parity: a PR-only obligation shows on BOTH the board band and the bell — never a contradiction', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ notifications: [], ownerPrs: [ownerPr('job-only-pr')] }));
    // Board band: 1 pending, OPEN PR row.
    const band = document.getElementById('board-owner')!;
    expect(band.querySelector('.board-band__count')?.textContent).toBe('1 pending');
    expect(band.querySelector('.board-owner__open')?.textContent).toContain('OPEN PR');
    // Bell panel: the SAME authoritative projection — the FOR YOU section
    // carries the PR row instead of claiming "nothing needs you".
    (document.getElementById('notification-bell') as HTMLButtonElement).click();
    const panel = document.getElementById('notification-list')!;
    expect(panel.textContent).not.toContain('nothing needs attention');
    expect(panel.textContent).not.toContain('nothing needs you');
    const heads = [...panel.querySelectorAll('.board-notification-section__head')].map((node) => node.textContent);
    expect(heads[0]).toBe('FOR YOU');
    expect(panel.querySelector('.board-owner__row--pr')?.textContent).toContain('Heist job-only-pr');
    expect(panel.querySelector('.board-owner__open')).not.toBeNull();
    // Alert semantics preserved: the badge counts unseen needs-owner
    // NOTIFICATIONS only — a ready PR never rings the bell.
    expect(document.getElementById('notification-badge')?.textContent).toBe('0');
  });

  it('FOR YOU r1 parity: an empty projection shows the honest empty state on BOTH surfaces', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ notifications: [notification('fyi-1', { routing: 'fyi' })] }));
    expect(document.getElementById('board-owner')!.querySelector('.board-band__count')?.textContent).toBe('0 pending');
    (document.getElementById('notification-bell') as HTMLButtonElement).click();
    expect(document.getElementById('notification-list')!.textContent).toContain('nothing needs you');
  });

  it('a visible band sends one web-board shown receipt per notification; a hidden band sends none', async () => {
    const client = stubClient();
    const stop = notification('show-me', { routing: 'needs-owner' });
    const view = new BoardView(() => {}, client);
    view.render(snapshot({ notifications: [stop] }));
    // Visible band → receipt once; a re-render of the same row never repeats it.
    view.render(snapshot({ notifications: [stop] }));
    expect(client.markNotificationShown).toHaveBeenCalledTimes(1);
    expect(client.markNotificationShown).toHaveBeenCalledWith('show-me', 'web-board');

    // Hidden ancestor (pre-pairing board) → nothing was displayed.
    const client2 = stubClient();
    document.body.innerHTML = `<div hidden><section id="board-owner"></section></div>
      <div id="chip-rail" hidden><span id="board-decisions"></span><span id="board-unacked" hidden></span><span id="board-wakes" hidden></span></div>
      <div id="board-jobs"></div><div id="board-agents"></div><span id="rail-agents-count">0</span>
      <nav id="board-nav" hidden></nav>
      <button id="notification-bell"><span id="notification-badge">0</span></button>
      <div id="notification-panel"><div id="notification-list"></div></div>`;
    const view2 = new BoardView(() => {}, client2);
    view2.render(snapshot({ notifications: [stop] }));
    expect(client2.markNotificationShown).not.toHaveBeenCalled();
  });
});

describe('board — compact owner-first presentation (j-1064)', () => {
  beforeEach(mountBoardDom);

  const pipeEntry = (
    id: string,
    overrides: Partial<NonNullable<BoardSnapshot['pipeline']>['entries'][number]> = {},
  ): NonNullable<BoardSnapshot['pipeline']>['entries'][number] => ({
    id,
    repo: 'demo',
    title: `Queued ${id}`,
    priority: 5,
    enqueueSeq: 1,
    state: 'waiting',
    reason: 'waiting for dep — not enqueued',
    queuedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  it('For Gru is collapsed by default with the complete count and zero rows; expanding and hiding are reversible', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'm1', status: 'blocked' }),
          baseJob({ id: 'm2', status: 'blocked' }),
          baseJob({ id: 'm3', status: 'blocked' }),
        ],
      }),
    );
    const section = document.querySelector<HTMLElement>('.board-band--needs-you')!;
    expect(section.querySelector('.board-band__count')?.textContent).toBe('3 heists');
    expect(section.querySelectorAll('.board-job')).toHaveLength(0);
    const toggle = section.querySelector<HTMLButtonElement>('.board-band__more')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toBe('Show machine queue');
    expect(toggle.getAttribute('aria-controls')).toBe('board-section-for-gru-body');

    toggle.click();
    const expanded = document.querySelector<HTMLElement>('.board-band--needs-you')!;
    expect(expanded.querySelectorAll('.board-job')).toHaveLength(3);
    expect(expanded.querySelector<HTMLButtonElement>('.board-band__more')?.textContent).toBe('Hide machine queue');
    expanded.querySelector<HTMLButtonElement>('.board-band__more')!.click();
    expect(document.querySelector('.board-band--needs-you .board-job')).toBeNull();
    expect(document.querySelector('.board-band--needs-you .board-band__count')?.textContent).toBe('3 heists');
  });

  it('Cold is COUNT ONLY by default: zero job rows until deliberately expanded, hide restores zero', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: Array.from({ length: 4 }, (_, index) => baseJob({ id: `cold-${index}`, status: 'done' })),
      }),
    );
    const section = document.querySelector<HTMLElement>('.board-band--cold')!;
    expect(section.querySelector('.board-band__count')?.textContent).toBe('4 heists');
    expect(section.querySelectorAll('.board-job')).toHaveLength(0);
    const toggle = section.querySelector<HTMLButtonElement>('.board-band__more')!;
    expect(toggle.textContent).toBe('Show records');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    const expanded = document.querySelector<HTMLElement>('.board-band--cold')!;
    expect(expanded.querySelectorAll('.board-job')).toHaveLength(4);
    expanded.querySelector<HTMLButtonElement>('.board-band__more')!.click();
    expect(document.querySelectorAll('.board-band--cold .board-job')).toHaveLength(0);
  });

  it('In flight previews 5 of 6 in the authoritative order, then Show all / Show fewer', () => {
    const jobs = Array.from({ length: 6 }, (_, index) =>
      baseJob({
        id: `flight-${index}`,
        status: 'in-review',
        updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
      }),
    );
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs }));
    const section = document.querySelector<HTMLElement>('.board-band--in-flight')!;
    const ids = [...section.querySelectorAll<HTMLElement>('.board-job')].map((row) => row.dataset.jobId);
    expect(ids).toEqual(['flight-0', 'flight-1', 'flight-2', 'flight-3', 'flight-4']);
    const more = section.querySelector<HTMLButtonElement>('.board-band__more')!;
    expect(more.textContent).toBe('Show all 6 (1 more)');
    more.click();
    expect(document.querySelectorAll('.board-band--in-flight .board-job')).toHaveLength(6);
    const fewer = document.querySelector<HTMLButtonElement>('.board-band--in-flight .board-band__more')!;
    expect(fewer.textContent).toBe('Show fewer');
    fewer.click();
    expect(document.querySelectorAll('.board-band--in-flight .board-job')).toHaveLength(5);
  });

  it('Pipeline previews 5 in server order; waiting rows carry exact reasons and ready rows are labelled', () => {
    const entries = [
      pipeEntry('p1', { priority: 0, enqueueSeq: 1, state: 'ready', reason: null }),
      pipeEntry('p2', { priority: 0, enqueueSeq: 2, reason: 'owner hold: deciding' }),
      pipeEntry('p3', { priority: 1, enqueueSeq: 3, reason: 'prerequisite p-dead cancelled' }),
      pipeEntry('p4', { priority: 2, enqueueSeq: 4, reason: 'dependency cycle: p4 → p5 → p4' }),
      pipeEntry('p5', { priority: 3, enqueueSeq: 5, reason: 'exclusive scope "repo:demo" held by p1' }),
      pipeEntry('p6', { priority: 4, enqueueSeq: 6, reason: 'waiting for p-ghost — not enqueued' }),
    ];
    const view = new BoardView(() => {});
    view.render(snapshot({ pipeline: { entries, pending: entries.length } }));
    const section = document.querySelector<HTMLElement>('.board-band--pipeline')!;
    expect(section.querySelector('.board-band__count')?.textContent).toBe('6 queued');
    expect([...section.querySelectorAll<HTMLElement>('.board-pipeline')].map((row) => row.dataset.entryId)).toEqual([
      'p1',
      'p2',
      'p3',
      'p4',
      'p5',
    ]);
    const first = section.querySelector<HTMLElement>('.board-pipeline')!;
    expect(first.dataset.state).toBe('ready');
    expect(first.querySelector('.board-pipeline__state')?.textContent).toBe('ready');
    expect(first.querySelector('.board-pipeline__reason')).toBeNull();
    const held = section.querySelectorAll<HTMLElement>('.board-pipeline')[1]!;
    expect(held.querySelector('.board-pipeline__state')?.textContent).toBe('waiting');
    expect(held.querySelector('.board-pipeline__reason')?.textContent).toBe('owner hold: deciding');
    expect(held.querySelector('.board-pipeline__priority')?.textContent).toBe('P0');
    expect(held.querySelector('.board-pipeline__seq')?.textContent).toBe('#2');

    const more = section.querySelector<HTMLButtonElement>('.board-band__more')!;
    expect(more.textContent).toBe('Show all 6 (1 more)');
    more.click();
    expect(document.querySelectorAll('.board-band--pipeline .board-pipeline')).toHaveLength(6);
    expect(document.querySelector('.board-band--pipeline .board-band__more')?.textContent).toBe('Show fewer');
  });

  it('global counts stay full even when the pipeline preview and entries differ; admitted work is absent', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ pipeline: { entries: [pipeEntry('p1', { state: 'ready', reason: null })], pending: 9 } }));
    expect(document.querySelector('.board-band--pipeline .board-band__count')?.textContent).toBe('9 queued');
    expect(document.querySelectorAll('.board-band--pipeline .board-pipeline')).toHaveLength(1);
    const nav = [...document.querySelectorAll<HTMLAnchorElement>('#board-nav .board-nav__link')].find(
      (link) => link.dataset.nav === 'pipeline',
    )!;
    expect(nav.querySelector('.board-nav__count')?.textContent).toBe('9');
  });

  it('renders a pre-upgrade server honestly: pipeline count unknown, compact unavailable state', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    const nav = [...document.querySelectorAll<HTMLAnchorElement>('#board-nav .board-nav__link')].find(
      (link) => link.dataset.nav === 'pipeline',
    )!;
    expect(nav.querySelector('.board-nav__count')?.textContent).toBe('—');
    expect(document.querySelector('.board-band--pipeline .board-band__empty')?.textContent).toBe(
      'pipeline queue unavailable on this server',
    );
  });

  it('keeps focus and disclosure state across ordinary live snapshot pushes', () => {
    const entries = Array.from({ length: 6 }, (_, index) => pipeEntry(`p${index}`));
    const view = new BoardView(() => {});
    view.render(snapshot({ pipeline: { entries, pending: 6 } }));
    const more = document.querySelector<HTMLButtonElement>('.board-band--pipeline .board-band__more')!;
    more.focus();
    more.click();
    expect(document.activeElement).toBe(document.querySelector('.board-band--pipeline .board-band__more'));
    expect(document.activeElement?.getAttribute('aria-expanded')).toBe('true');
    // A live push re-renders everything; the operator's control keeps focus
    // and the expanded disclosure stays open.
    view.render(snapshot({ pipeline: { entries, pending: 6 } }));
    const restored = document.activeElement as HTMLElement | null;
    expect(restored?.dataset.focusKey).toBe('section:pipeline');
    expect(restored?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.board-band--pipeline .board-pipeline')).toHaveLength(6);
  });

  it('renders untrusted pipeline titles and wait reasons as text, never markup or instructions', () => {
    const html = '<img src=x onerror=alert(1)>';
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        pipeline: {
          entries: [pipeEntry('evil', { title: html, reason: '<b>owner hold</b>' })],
          pending: 1,
        },
      }),
    );
    const row = document.querySelector<HTMLElement>('.board-pipeline')!;
    expect(row.querySelector('.board-pipeline__title')?.textContent).toBe(html);
    expect(row.querySelector('.board-pipeline__reason')?.textContent).toBe('<b>owner hold</b>');
    expect(row.querySelectorAll('img, b')).toHaveLength(0);
  });

  it('every shortcut points at a real labelled target, even when all sections are empty', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ repos: [] }));
    const links = [...document.querySelectorAll<HTMLAnchorElement>('#board-nav .board-nav__link')];
    expect(links).toHaveLength(6);
    for (const link of links) {
      const href = link.getAttribute('href')!;
      const target = document.querySelector<HTMLElement>(href);
      expect(target, `shortcut target ${href}`).not.toBeNull();
      expect(target?.hidden).toBe(false);
      expect(link.querySelector('.board-nav__label')?.textContent).not.toBe('');
      expect(link.querySelector('.board-nav__count')?.textContent).not.toBe('');
    }
  });
});
