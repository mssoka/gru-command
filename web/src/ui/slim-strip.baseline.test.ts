// Dashboard slim-strip BASELINE (fail-before) proof — R3-05 classification.
//
// @vitest-environment happy-dom
//
// This file is the identified feature-absence instrument for the two
// baseline scopes: overlaid onto the recorded execution base
// (49b558f243c7bacbfb46c7bc04f749bf131cefea, which predates the slim
// strip), every test below must fail on an ASSERTION that names the
// missing slim-strip surface — after a setup proof shows the base board
// itself rendered (a dead mount proves nothing). At the feature head the
// same assertions pass, so the unit scope may also run this file as a
// regular regression.
//
// Import discipline: this file imports ONLY modules and symbols the BASE
// already exports (BoardView, base protocol types). It must never import
// a slim-added symbol (e.g. `ackNextStep`, `valueSplit`) — a missing
// export is a collection/import error, which is a SETUP failure, not
// behavioral evidence. Slim-added behavior is asserted through the
// rendered DOM only.

import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardSnapshot, JobView, NotificationView } from '../lib/board-protocol.js';
import { BoardView } from './board.js';

function job(id: string, overrides: Partial<JobView> = {}): JobView {
  return {
    id,
    repo: 'demo',
    title: `Heist ${id}`,
    status: 'working',
    updatedAt: '2026-01-01T00:00:00.000Z',
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: { branch: 'gru/x', sha: 'a1b2c3d4e5f6a7b8', status: 'active', createdAt: new Date(Date.now() - 300_000).toISOString() },
    lastAgentActivity: new Date(Date.now() - 60_000).toISOString(),
    children: null,
    ...overrides,
  } as JobView;
}

function snap(overrides: { jobs?: readonly JobView[]; notifications?: readonly NotificationView[] } = {}): BoardSnapshot {
  return {
    repos: [{ name: 'demo', jobs: overrides.jobs ?? [job('h1'), job('h2')] }],
    agents: [],
    notifications: overrides.notifications ?? [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: null,
      endpoint: null,
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: null,
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: overrides.notifications?.length ?? 0,
    wakes: { count: 0, lastAt: null },
    pipeline: { entries: [], pending: 0 },
  } as unknown as BoardSnapshot;
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
    <div id="board-repos"></div>
    <div id="board-agents"></div>
    <span id="rail-agents-count">0</span>
    <button id="notification-bell"><span id="notification-badge">0</span></button>
    <div id="notification-panel"><div id="notification-list"></div></div>
  `;
}

describe('slim strip — fail-before feature absence on the recorded base', () => {
  beforeEach(mountBoardDom);

  it('the rail carries the slim status pairs and count groups (base has neither)', () => {
    const view = new BoardView(() => {});
    view.render(snap());
    // Setup proof: the board mount itself rendered real sections on the base.
    expect(document.getElementById('board-jobs')?.children.length, 'board sections rendered (setup proof)').toBeGreaterThan(0);
    // The slim feature: labelled status pairs + count groups.
    expect(document.querySelector('.strip-status'), 'slim strip labelled status pairs').toBeTruthy();
    expect(document.querySelector('.strip-groups'), 'slim strip Heists/PRs/Crew count groups').toBeTruthy();
  });

  it('every strip number keeps its reserved tabular slot (base renders bare chips)', () => {
    const view = new BoardView(() => {});
    view.render(snap());
    expect(document.getElementById('chip-rail')?.children.length, 'rail mounted (setup proof)').toBeGreaterThan(0);
    expect(document.querySelector('.num.strip-kpi__num'), 'reserved numeric slot for strip KPIs').toBeTruthy();
  });

  it('FOR YOU rows are compact faces with a reveal-only disclosure (base shows the ack inline)', () => {
    const view = new BoardView(() => {});
    view.render(
      snap({
        notifications: [
          {
            id: 'stop-1',
            kind: 'supervision.breaker',
            routing: 'needs-owner',
            severity: 'info',
            title: 'Worker stopped',
            detail: 'quota wall',
            ts: new Date(Date.now() - 5_000).toISOString(),
            ackedAt: null,
            resolvedAt: null,
            shownAt: null,
          } as NotificationView,
        ],
      }),
    );
    expect(document.getElementById('board-owner')?.textContent, 'band rendered (setup proof)').toContain('Worker stopped');
    expect(document.querySelector('#board-owner [data-control="disclose"]'), 'reveal-only compact disclosure').toBeTruthy();
  });
});
