// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardSnapshot, JobView, RoundView } from '../lib/board-protocol.js';
import { renderConnectionDot } from './chat.js';
import { CommandBar } from './command-bar.js';

/**
 * The command bar's two pills (cockpit rework 2026-10-17): the controller
 * writes RADAR and ROUND in place — the connection dot inside RADAR is the
 * same node before and after every write, so the state the board socket
 * gave it survives a snapshot push.
 */

function mount(): void {
  document.body.innerHTML = `
    <div id="command-ticker">
      <span class="command-pill command-pill--plain" id="command-radar"><span class="conn-dot" id="conn-dot" role="img" aria-label="socket: idle"></span><span id="command-radar-label">RADAR IDLE</span></span>
      <span class="command-pill command-pill--round-none" id="command-round"><span id="command-round-label">NO ROUND</span></span>
    </div>`;
}

function round(seq: number, status: string): RoundView {
  return {
    id: `r${seq}`,
    seq,
    status,
    verdict: null,
    targetRef: null,
    createdAt: '2026-10-17T10:00:00.000Z',
    updatedAt: '2026-10-17T10:00:00.000Z',
    lenses: [],
    lensAttempts: [],
    blockers: 0,
  };
}

function job(rounds: readonly RoundView[]): JobView {
  return {
    id: 'j',
    repo: 'demo',
    title: 'j',
    status: 'in-review',
    updatedAt: '2026-10-17T10:00:00.000Z',
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds,
    lane: null,
    lastAgentActivity: null,
  };
}

function snapshot(jobs: readonly JobView[]): BoardSnapshot {
  return {
    repos: [{ name: 'demo', jobs }],
    agents: [],
    notifications: [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://example.invalid',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'test',
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

const radarPill = (): HTMLElement => document.getElementById('command-radar')!;
const roundPill = (): HTMLElement => document.getElementById('command-round')!;

beforeEach(mount);

describe('command bar (cockpit rework)', () => {
  it('starts idle with no round, before any board socket or snapshot', () => {
    new CommandBar();
    expect(radarPill().className).toBe('command-pill command-pill--plain');
    expect(radarPill().textContent).toBe('RADAR IDLE');
    expect(roundPill().className).toBe('command-pill command-pill--round-none');
    expect(roundPill().textContent).toBe('NO ROUND');
  });

  it('follows the board socket in word and tone, keeping the connection dot node and its state', () => {
    const bar = new CommandBar();
    const dot = document.getElementById('conn-dot');
    renderConnectionDot('open');
    bar.setBoardState('open');
    expect(radarPill().className).toBe('command-pill command-pill--ok');
    expect(document.getElementById('command-radar-label')?.textContent).toBe('RADAR LIVE');
    // Written in place: the same dot, still carrying the socket's state.
    expect(document.getElementById('conn-dot')).toBe(dot);
    expect(dot?.classList.contains('conn-dot--open')).toBe(true);
    expect(dot?.getAttribute('aria-label')).toBe('socket: open');
    bar.setBoardState('stale');
    expect(radarPill().className).toBe('command-pill command-pill--warn');
    expect(radarPill().textContent).toBe('RADAR STALE');
    bar.setBoardState('offline');
    expect(radarPill().className).toBe('command-pill command-pill--alert');
    expect(radarPill().textContent).toBe('RADAR DOWN');
    expect(document.getElementById('conn-dot')).toBe(dot);
  });

  it('shows the top review round from each snapshot, live before pending', () => {
    const bar = new CommandBar();
    const dot = document.getElementById('conn-dot');
    bar.setSnapshot(snapshot([job([round(2, 'pending')])]));
    expect(roundPill().className).toBe('command-pill command-pill--round-pending');
    expect(roundPill().textContent).toBe('ROUND 2 PENDING');
    // The number sits in its own slot (CSS reserves two digits for it).
    expect(roundPill().querySelector('.command-pill__num')?.textContent).toBe('2');
    bar.setSnapshot(snapshot([job([round(2, 'pending'), round(1, 'live')])]));
    expect(roundPill().className).toBe('command-pill command-pill--round-live');
    expect(roundPill().textContent).toBe('ROUND 1 LIVE');
    bar.setSnapshot(snapshot([]));
    expect(roundPill().textContent).toBe('NO ROUND');
    expect(roundPill().querySelector('.command-pill__num')).toBeNull();
    // A snapshot push never rebuilds RADAR.
    expect(document.getElementById('conn-dot')).toBe(dot);
  });
});
