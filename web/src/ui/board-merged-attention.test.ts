// @vitest-environment happy-dom

// Rendered regression (owner ruling 2026-09-26): concluded merged/done
// jobs whose newest historical review round is aborted — or whose newest
// round never posted a verdict and carries errored lenses — must group
// under SETTLED/COLD, never NEEDS YOU. Live evidence: 17 merged jobs
// (PRs independently confirmed MERGED on GitHub) were promoted by stale
// review history alone. Current-state obligations (a separate unacked
// action-required notification, blocked/error status, a conflicting PR)
// and nonterminal work keep their attention. This is a DOM proof through
// BoardView, not a counting-helper check.
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentView,
  BoardSnapshot,
  JobView,
  NotificationView,
  RoundView,
} from '../lib/board-protocol.js';
import { BoardView } from './board.js';

const errorLens = { lens: 'blind', state: 'error', agentId: null, note: 'provider cap hit', verdict: null };

/** Generic #73/#74-shaped review tail (identities anonymized): an old
 * aborted round full of errored lenses, then a newer aborted round with
 * a null (INCOMPLETE) verdict — the live pattern that promoted merged
 * work into NEEDS YOU. */
function concludedHistory(overrides: { id: string } = { id: 'job-x' }): readonly RoundView[] {
  return [
    {
      id: `${overrides.id}-r1`,
      seq: 1,
      status: 'aborted',
      verdict: null,
      targetRef: 'b'.repeat(40),
      createdAt: new Date(Date.now() - 72 * 3_600_000).toISOString(),
      updatedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      lenses: [errorLens],
      lensAttempts: [{ lens: 'blind', attempts: 2 }],
      blockers: 0,
    },
    {
      id: `${overrides.id}-r2`,
      seq: 2,
      status: 'aborted',
      verdict: null,
      targetRef: 'a'.repeat(40),
      createdAt: new Date(Date.now() - 47 * 3_600_000).toISOString(),
      updatedAt: new Date(Date.now() - 46 * 3_600_000).toISOString(),
      lenses: [],
      lensAttempts: [],
      blockers: 0,
    },
  ];
}

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    repo: 'demo',
    title: 'Demo job',
    status: 'in-review',
    updatedAt: new Date().toISOString(),
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: null,
    lastAgentActivity: new Date().toISOString(),
    ...overrides,
  };
}

function notification(id: string, overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id,
    ts: new Date().toISOString(),
    kind: 'review.blocker',
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
    lastActivity: new Date().toISOString(),
    sessionFile: null,
    jobId: null,
    roundId: null,
    supervision: null,
    ...overrides,
  };
}

function snapshot(
  options: { jobs?: readonly JobView[]; agents?: readonly AgentView[]; notifications?: readonly NotificationView[] } = {},
): BoardSnapshot {
  return {
    repos: [{ name: 'demo', jobs: options.jobs ?? [] }],
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
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
    build: null,
    silas: null,
    verify: null,
    selfHeal: null,
  };
}

function mountBoardDom(): void {
  // Mirrors web/index.html's mounts, including the FOR YOU owner band and
  // the wakes chip the BoardView constructor requires on current main.
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

function bandIds(band: string): string[] {
  return [...document.querySelectorAll<HTMLElement>(`.board-band--${band} .board-job`)].map(
    (row) => row.dataset.jobId ?? '',
  );
}

/** FOR GRU is collapsed by default (owner approval j-1064); these tests
 * assert CLASSIFICATION, so the machine queue is deliberately revealed
 * first — an empty band keeps its calm clear state either way. COLD is
 * count-only by default for the same reason. */
function expandForGru(): void {
  const toggle = document.querySelector<HTMLButtonElement>('.board-band--needs-you .board-band__more');
  if (toggle !== null && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
}

function expandCold(): void {
  const toggle = document.querySelector<HTMLButtonElement>('.board-band--cold .board-band__more');
  if (toggle !== null && toggle.getAttribute('aria-expanded') === 'false') toggle.click();
}

describe('board rendered regression — concluded jobs and stale review history', () => {
  beforeEach(mountBoardDom);

  it('merged jobs with aborted latest rounds render in SETTLED/COLD, and NEEDS GRU reports calm', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          job({
            id: 'lane-parity-fix',
            title: 'Runtime model resolution parity',
            status: 'merged',
            prState: 'merged',
            prUrl: 'https://example.invalid/pr/73',
            updatedAt: new Date().toISOString(), // merged today
            rounds: concludedHistory({ id: 'lane-parity-fix' }),
          }),
          job({
            id: 'lane-audit-fix',
            title: 'Perkins indirect fix audit',
            status: 'merged',
            prState: 'merged',
            prUrl: 'https://example.invalid/pr/74',
            updatedAt: new Date(Date.now() - 48 * 3_600_000).toISOString(), // merged earlier
            rounds: concludedHistory({ id: 'lane-audit-fix' }),
          }),
        ],
      }),
    );
    expect(bandIds('needs-you')).toEqual([]);
    // The band's calm clear copy carries current main's Gru-theme label.
    expect(document.querySelector('.board-band--needs-you .board-band__clear-text')?.textContent).toBe(
      'nothing needs Gru',
    );
    expect(bandIds('settled')).toEqual(['lane-parity-fix']);
    expandCold();
    expect(bandIds('cold')).toEqual(['lane-audit-fix']);
  });

  it('a done job with an aborted latest round renders in COLD, not NEEDS YOU', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({ jobs: [job({ id: 'lane-archive', status: 'done', rounds: concludedHistory({ id: 'lane-archive' }) })] }),
    );
    expect(bandIds('needs-you')).toEqual([]);
    expandCold();
    expect(bandIds('cold')).toEqual(['lane-archive']);
  });

  it('renders a concluded job’s leftover machine row as a closed receipt — never live NEEDS GRU attention', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [job({ id: 'lane-merged-owed', status: 'merged', prState: 'merged', rounds: concludedHistory({ id: 'lane-merged-owed' }) })],
        agents: [agent('perkins-1', { jobId: 'lane-merged-owed' })],
        notifications: [notification('n1', { agentId: 'perkins-1', title: 'Owner decision required' })],
      }),
    );
    // Section-truth ruling (2026-09-29) supersedes the 2026-09-26
    // current-state clause for terminal jobs: the bound machine row is a
    // closed receipt — the lane stays settled and the record moves to FEED.
    expect(bandIds('needs-you')).toEqual([]);
    expect(bandIds('settled')).toEqual(['lane-merged-owed']);
    const receipt = document.querySelector<HTMLElement>('.board-notification[data-receipt="closed"]');
    expect(receipt?.textContent).toContain('Owner decision required');
    expect(receipt?.textContent).toContain('closed receipt');
  });

  it('preserves legitimate NEEDS YOU attention for active work and retained delivered/parked cases', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          // Reopened after a prior merge: current implementation, PR state
          // still merged, review aborted again — attention stays.
          job({
            id: 'lane-reopened',
            status: 'in-review',
            prState: 'merged',
            prUrl: 'https://example.invalid/pr/70',
            rounds: concludedHistory({ id: 'lane-reopened' }),
          }),
          job({ id: 'lane-blocked', status: 'blocked' }),
          job({ id: 'lane-error', status: 'error' }),
          job({
            id: 'lane-conflict',
            status: 'in-review',
            prState: 'conflicting',
            prUrl: 'https://example.invalid/pr/71',
          }),
          job({ id: 'lane-delivered', status: 'delivered', rounds: concludedHistory({ id: 'lane-delivered' }) }),
          job({ id: 'lane-parked', status: 'parked', rounds: concludedHistory({ id: 'lane-parked' }) }),
        ],
      }),
    );
    expandForGru();
    const expected = ['lane-blocked', 'lane-error', 'lane-conflict', 'lane-reopened', 'lane-delivered', 'lane-parked'];
    expect([...bandIds('needs-you')].sort()).toEqual([...expected].sort());
  });

  it('leaves the review record intact on the concluded ledger view', () => {
    const view = new BoardView(() => {});
    const merged = job({
      id: 'lane-parity-fix',
      status: 'merged',
      prState: 'merged',
      updatedAt: new Date().toISOString(),
      rounds: concludedHistory({ id: 'lane-parity-fix' }),
    });
    view.render(snapshot({ jobs: [merged] }));
    document.querySelector<HTMLButtonElement>('.board-band--settled .board-job__toggle')?.click();
    const body = document.querySelector('.board-job__body');
    expect(body).not.toBeNull();
    // The concluded view shows the newest round, quiescent, unrewritten:
    // aborted stays aborted, the INCOMPLETE verdict stays null.
    expect(body?.querySelectorAll('.board-round')).toHaveLength(1);
    expect(body?.querySelector('.board-round__status')?.textContent).toBe('aborted');
    expect(body?.querySelector('.board-job__reviewed')?.textContent).toContain('review history on the ledger');
    // The snapshot the view carries is untouched by bucketing.
    expect(view.current?.repos[0]?.jobs[0]?.rounds).toHaveLength(2);
  });
});
