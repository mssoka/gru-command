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
import { BoardView, RailIdentityError, jobFailing, makeGraphemeSplitter, minionSuffixes, railSuffix, visibleWord } from './board.js';

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
    wakes?: BoardSnapshot['wakes'];
    ownerPrs?: NonNullable<BoardSnapshot['ownerPrs']>;
    pipeline?: NonNullable<BoardSnapshot['pipeline']>;
    children?: BoardSnapshot['children'];
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
    children: options.children,
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

describe('minion heist identity in the crew rail', () => {
  beforeEach(mountBoardDom);

  it('shows stable names and distinct suffixes for all states, without changing full-ID transcript selection', () => {
    const view = new BoardView(() => {});
    const jobs = [baseJob({ id: 'wake', title: 'Full wake alert contract', displayName: 'Wake Alerts' }), baseJob({ id: 'model', title: 'Model repair with full details' })];
    const agents = [
      agent('worker-1234dec9', { role: 'minion', label: null, jobId: 'wake', state: 'idle' }),
      agent('worker-5678dec9', { role: 'minion', label: null, jobId: 'wake', state: 'error' }),
      agent('worker-9999dec9', { role: 'minion', label: null, jobId: 'wake', state: 'disposed' }),
      agent('worker-00009b2b', { role: 'minion', label: null, jobId: 'model', state: 'streaming' }),
      agent('worker-7777cafe', { role: 'minion', label: null, jobId: 'wake', state: 'idle' }),
      agent('unlinked-1111', { role: 'minion', label: null, jobId: null }),
      agent('orphaned-1111', { role: 'minion', label: null, jobId: 'missing-job' }),
      agent('lead-1234', { role: 'perkins', label: 'blind:001', jobId: 'wake' }),
    ];
    const board = snapshot({ jobs, agents });
    view.render(board);
    document.querySelector<HTMLButtonElement>('.board-agent-toggle')?.click();
    const rows = [...document.querySelectorAll<HTMLButtonElement>('#board-agents .board-agent')];
    const byId = (id: string) => rows.find((row) => row.title.includes(id))!;
    for (const id of ['worker-1234dec9', 'worker-5678dec9', 'worker-9999dec9']) {
      const row = byId(id);
      expect(row.querySelector('.board-agent__name')?.textContent).toBe('wake alerts');
      expect(row.querySelector('.board-agent__sub')?.textContent).toContain('minion ·');
      expect(row.title).toContain('Full wake alert contract');
      expect(row.getAttribute('aria-label')).toContain(id);
    }
    const collisions = ['worker-1234dec9', 'worker-5678dec9', 'worker-9999dec9'];
    const originalSuffixes = collisions.map((id) => byId(id).querySelector('.board-agent__hash')?.textContent);
    expect(new Set(originalSuffixes).size).toBe(3);
    expect(originalSuffixes.every((suffix) => suffix?.length === 5)).toBe(true);
    expect(byId('worker-00009b2b').querySelector('.board-agent__name')?.textContent).toBe('model repair with full');
    // A non-colliding peer on the same heist keeps its normal four
    // characters; only the colliding trio extends.
    expect(byId('worker-7777cafe').querySelector('.board-agent__hash')?.textContent).toBe('cafe');
    expect(byId('unlinked-1111').querySelector('.board-agent__name')?.textContent).toBe('unassigned');
    expect(byId('orphaned-1111').querySelector('.board-agent__name')?.textContent).toBe('unassigned');
    expect(byId('unlinked-1111').querySelector('.board-agent__hash')?.textContent).not.toBe(byId('orphaned-1111').querySelector('.board-agent__hash')?.textContent);
    expect(byId('lead-1234').querySelector('.board-agent__name')?.textContent).toBe('blind:001');
    // G7: every row has an accessible name; minions keep the full-identity
    // shape, non-minions announce label · id — role · state.
    expect(byId('worker-1234dec9').getAttribute('aria-label')).toBe('wake alerts · worker-1234dec9 — Full wake alert contract — minion · idle');
    expect(byId('lead-1234').getAttribute('aria-label')).toBe('blind:001 · lead-1234 — perkins · idle');
    view.render({ ...board, agents: [...agents].reverse() });
    const reordered = [...document.querySelectorAll<HTMLButtonElement>('#board-agents .board-agent')];
    expect(collisions.map((id) => reordered.find((row) => row.title.includes(id))?.querySelector('.board-agent__hash')?.textContent)).toEqual(originalSuffixes);
    expect(document.querySelectorAll('.board-agent__hash')).toHaveLength(8);
  });

  it('ignores invisible-only graphemes before shortening, keeping readable letters and ZWJ emoji', () => {
    const view = new BoardView(() => {});
    const jobs = [
      baseJob({ id: 'wake', title: 'Full wake alert contract', displayName: '\u200b'.repeat(24) + 'wake alerts' }),
      baseJob({ id: 'emoji', title: 'Emoji heist', displayName: '🧑\u200d🚀 launch' }),
      baseJob({ id: 'blank', title: 'Legacy title survives', displayName: '\u200b\u200b' }),
    ];
    const agents = [
      agent('worker-1234dec9', { role: 'minion', label: null, jobId: 'wake' }),
      agent('worker-5678cafe', { role: 'minion', label: null, jobId: 'emoji' }),
      agent('worker-9999fade', { role: 'minion', label: null, jobId: 'blank' }),
    ];
    view.render(snapshot({ jobs, agents }));
    const rows = [...document.querySelectorAll<HTMLButtonElement>('#board-agents .board-agent')];
    const byId = (id: string) => rows.find((row) => row.title.includes(id))!;
    // The 24 leading zero-width spaces no longer consume the rail bound:
    // the readable letters survive with the suffix and the full identity.
    expect(byId('worker-1234dec9').querySelector('.board-agent__name')?.textContent).toBe('wake alerts');
    expect(byId('worker-1234dec9').querySelector('.board-agent__hash')?.textContent).toBe('dec9');
    expect(byId('worker-1234dec9').getAttribute('aria-label')).toContain('wake alerts · worker-1234dec9');
    expect(byId('worker-1234dec9').title).toContain('Full wake alert contract');
    // A ZWJ emoji cluster is one grapheme and survives the filter intact.
    expect(byId('worker-5678cafe').querySelector('.board-agent__name')?.textContent).toBe('🧑\u200d🚀 launch');
    // A name with nothing visible after filtering degrades to the neutral
    // label instead of an empty-looking card.
    expect(byId('worker-9999fade').querySelector('.board-agent__name')?.textContent).toBe('unassigned');
  });

  it('bounds a single over-long word at 24 graphemes (no word boundary exists to cut on)', () => {
    const view = new BoardView(() => {});
    const jobs = [baseJob({ id: 'long', title: 'Long single word', displayName: 'x'.repeat(32) })];
    const agents = [agent('worker-1234beef', { role: 'minion', label: null, jobId: 'long' })];
    view.render(snapshot({ jobs, agents }));
    const row = document.querySelector<HTMLElement>('#board-agents .board-agent');
    expect(row?.querySelector('.board-agent__name')?.textContent).toBe('x'.repeat(24));
    // Full title stays reachable in the tooltip.
    expect(row?.title).toContain('Long single word');
  });

  it('opens transcripts under the rail name while the full-ID file drives the selection', () => {
    const opened = vi.fn();
    const view = new BoardView(opened);
    const jobs = [baseJob({ id: 'wake', title: 'Full wake alert contract', displayName: 'Wake Alerts' })];
    const agents = [
      agent('worker-5678dec9', { role: 'minion', label: null, jobId: 'wake', state: 'error' }),
      agent('lead-1234', { role: 'perkins', label: 'blind:001', jobId: 'wake' }),
    ];
    view.render(snapshot({ jobs, agents }));
    const byId = (id: string) => [...document.querySelectorAll<HTMLButtonElement>('#board-agents .board-agent')].find((row) => row.title.includes(id))!;
    byId('worker-5678dec9').click();
    expect(opened).toHaveBeenCalledWith({ file: '/sessions/worker-5678dec9.jsonl', label: 'wake alerts · dec9' });
    byId('lead-1234').click();
    expect(opened).toHaveBeenLastCalledWith({ file: '/sessions/lead-1234.jsonl', label: 'blind:001' });
  });

  it('cuts suffixes on grapheme boundaries, never halving an astral character', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [], agents: [agent('a😀bcd', { role: 'minion', label: null, jobId: null })] }));
    expect(document.querySelector('.board-agent__hash')?.textContent).toBe('😀bcd');
    view.render(snapshot({ jobs: [], agents: [
      agent('x😀bcde', { role: 'minion', label: null, jobId: null }),
      agent('y😀bcde', { role: 'minion', label: null, jobId: null }),
    ] }));
    expect([...document.querySelectorAll('.board-agent__hash')].map((node) => node.textContent)).toEqual(['x😀bcde', 'y😀bcde']);
  });

  it('resolves large groups with tail buckets: lone tails keep four, collisions extend deterministically', () => {
    const jobs = new Map([['swarm', baseJob({ id: 'swarm', title: 'Swarm review' })]]);
    const bulk = Array.from({ length: 1500 }, (_, index) =>
      agent(`bulk-${String(index).padStart(8, '0')}`, { role: 'minion', label: null, jobId: 'swarm' }));
    const collisions = [
      agent('worker-1234dec9', { role: 'minion', label: null, jobId: 'swarm' }),
      agent('worker-5678dec9', { role: 'minion', label: null, jobId: 'swarm' }),
      agent('worker-9999dec9', { role: 'minion', label: null, jobId: 'swarm' }),
      agent('worker-12dec9', { role: 'minion', label: null, jobId: 'swarm' }),
      agent('worker-22dec9', { role: 'minion', label: null, jobId: 'swarm' }),
      agent('ab', { role: 'minion', label: null, jobId: 'swarm' }),
    ];
    const agents = [...bulk, ...collisions];
    const suffixes = minionSuffixes(agents, jobs);
    // Lone tails never scan peers and keep the normal four characters.
    expect(suffixes.get('bulk-00000000')).toBe('0000');
    expect(suffixes.get('bulk-00001499')).toBe('1499');
    // A shared four-tail extends only as far as the collision requires.
    expect(suffixes.get('worker-1234dec9')).toBe('4dec9');
    expect(suffixes.get('worker-5678dec9')).toBe('8dec9');
    expect(suffixes.get('worker-9999dec9')).toBe('9dec9');
    expect(suffixes.get('worker-12dec9')).toBe('12dec9');
    expect(suffixes.get('worker-22dec9')).toBe('22dec9');
    // Shorter than four graphemes: the whole id, never a padded tail.
    expect(suffixes.get('ab')).toBe('ab');
    // Row order never changes an answer.
    const reversed = minionSuffixes([...agents].reverse(), jobs);
    for (const item of agents) expect(reversed.get(item.id)).toBe(suffixes.get(item.id));
  });

  it('renders exactly the suffixes the rail authority computes and fails loud on a miss', () => {
    const view = new BoardView(() => {});
    const jobs = [baseJob({ id: 'wake', title: 'Full wake alert contract', displayName: 'Wake Alerts' })];
    const agents = [
      agent('worker-1234dec9', { role: 'minion', label: null, jobId: 'wake' }),
      agent('worker-5678dec9', { role: 'minion', label: null, jobId: 'wake' }),
      agent('worker-9999dec9', { role: 'minion', label: null, jobId: 'wake' }),
      agent('unlinked-1111', { role: 'minion', label: null, jobId: null }),
    ];
    view.render(snapshot({ jobs, agents }));
    const expected = minionSuffixes(agents, new Map(jobs.map((job) => [job.id, job])));
    for (const item of agents) {
      const row = [...document.querySelectorAll<HTMLButtonElement>('#board-agents .board-agent')].find((entry) => entry.title.includes(item.id))!;
      expect(row.querySelector('.board-agent__hash')?.textContent).toBe(expected.get(item.id));
    }
    expect(railSuffix(expected, 'unlinked-1111')).toBe('1111');
    expect(() => railSuffix(new Map(), 'ghost')).toThrow(RailIdentityError);
    expect(() => railSuffix(new Map(), 'ghost')).toThrow('crew rail suffix missing for agent ghost');
  });

  it('keeps rendering with a code-point fallback when Intl.Segmenter is absent', () => {
    const real = Intl.Segmenter;
    const define = (value: typeof Intl.Segmenter | undefined) =>
      Object.defineProperty(Intl, 'Segmenter', { value, writable: true, configurable: true });
    try {
      define(undefined);
      const split = makeGraphemeSplitter();
      expect(split('a😀b')).toEqual(['a', '😀', 'b']);
    } finally {
      define(real);
    }
    expect(makeGraphemeSplitter()('a😀b')).toEqual(['a', '😀', 'b']);
  });

  it('visibleWord: drops invisible graphemes under a real segmenter but keeps a ZWJ cluster intact on the code-point fallback (2026-10-05 edge review)', () => {
    // Real segmenter: a zero-width space inside a word is dropped.
    expect(visibleWord(`x\u200by`, true)).toBe('xy');
    expect(visibleWord('\u200b\u200b', true)).toBe('');
    // Code-point fallback (no Intl.Segmenter): the word is returned
    // VERBATIM — code points cannot tell the ZWJ joiner of a family emoji
    // from a stray invisible, and stripping it would change the label.
    const family = '👩\u200d👩\u200d👧';
    expect(visibleWord(family, false)).toBe(family);
  });

  it('escapes and bounds special and grapheme-rich names, retaining full title and id for keyboard users', () => {
    const view = new BoardView(() => {});
    const title = '<img src=x onerror=alert(1)> 🧑‍🚀'.repeat(5);
    view.render(snapshot({ jobs: [baseJob({ id: 'unicode', title, displayName: '🧑‍🚀 Café <script> Hello extra words beyond the limit' })], agents: [agent('full-worker-id-fff1', { role: 'minion', jobId: 'unicode', label: null })] }));
    const row = document.querySelector<HTMLButtonElement>('#board-agents .board-agent')!;
    expect(row.querySelector('script')).toBeNull();
    expect(row.querySelector('.board-agent__name')?.textContent).toContain('🧑‍🚀 café <script>');
    expect(row.title).toContain(title);
    expect(row.getAttribute('aria-label')).toContain('full-worker-id-fff1');
    expect(row.querySelector('.board-agent__hash')?.textContent).toBe('fff1');
  });
});

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
    expect(sections[1]?.textContent).toContain('live machine queue is clear');
    expect(sections[1]?.textContent).not.toContain('Notice legacy-machine');
    expect(sections[2]?.textContent).toContain('Notice legacy-machine');
    expect(sections[2]?.querySelector('.board-notification__ack')).toBeNull();
  });

  it('g9: an empty notification feed renders the healthy FOR YOU / NEEDS GRU clear bands, never a bare skip', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ notifications: [] }));
    const panel = document.getElementById('notification-list')!;
    expect(panel.textContent).not.toContain('nothing needs attention');
    const heads = [...panel.querySelectorAll('.board-notification-section__head')].map((head) => head.textContent);
    expect(heads).toEqual(['FOR YOU', 'NEEDS GRU']);
    const sections = [...panel.querySelectorAll('.board-notification-section')];
    expect(sections[0]?.textContent).toContain('nothing needs you');
    expect(sections[1]?.textContent).toContain('live machine queue is clear');
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

describe('board v7 — slim status strip (pill rail replaced)', () => {
  beforeEach(mountBoardDom);

  it('renders the slim status pairs and the three stable groups, disclosing the rail on the first snapshot', () => {
    const view = new BoardView(() => {});
    expect(document.getElementById('chip-rail')?.hidden).toBe(true);
    view.render(snapshot());
    const rail = document.getElementById('chip-rail');
    expect(rail?.hidden).toBe(false);
    const pairs = [...(rail?.querySelectorAll('.strip-pair') ?? [])].map((node) => node.getAttribute('data-chip'));
    expect(pairs).toEqual(['deploy', 'reviews', 'silas', 'alerts', 'verify', 'cure']);
    const groups = rail?.querySelectorAll('.strip-group') ?? [];
    expect(groups).toHaveLength(3);
    const names = [...groups].map((node) => node.querySelector('.strip-group__name')?.textContent);
    expect(names).toEqual(['HEISTS', 'PRS', 'CREW']);
    // Group heads are h2 (approved reference heading level, fixes the
    // h3-before-h2 document order).
    for (const head of document.querySelectorAll('.strip-group__head')) {
      expect(head.tagName).toBe('H2');
    }
  });

  it('renders deploy drift with the restart-pending flag when behind', () => {
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
    const deploy = document.querySelector<HTMLElement>('.strip-pair[data-chip="deploy"]');
    expect(deploy?.classList.contains('strip-pair--alert')).toBe(true);
    // The mutable number rides its own reserved slot, split from the unit.
    expect(deploy?.querySelector('.strip-value__num')?.textContent).toBe('43');
    expect(deploy?.querySelector('.strip-value')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('43 behind');
    expect(deploy?.querySelector('.strip-flag__txt')?.textContent).toBe('RESTART PENDING');
    // Preserved title text: the pair AND its flag carry the card's full
    // explanation for hover/AT users.
    expect(deploy?.title).toContain('rebuild + restart');
    expect(deploy?.querySelector('.strip-flag')?.getAttribute('title')).toContain('rebuild + restart');
  });

  it('renders n/a honestly for unwired sources (verify queue, cure efficacy)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    const textOf = (chip: string): string =>
      document
        .querySelector<HTMLElement>(`.strip-pair[data-chip="${chip}"] .strip-value`)
        ?.textContent?.replace(/\s+/g, ' ')
        .trim() ?? '';
    expect(textOf('deploy')).toBe('n/a');
    expect(textOf('verify')).toBe('n/a');
    expect(textOf('cure')).toBe('n/a');
    expect(textOf('alerts')).toBe('0');
    expect(textOf('reviews')).toBe('1 active'); // the base job carries a live round
  });

  it('renders the verify queue from the snapshot with its queued flag split into numeric parts', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        verify: { lockInUse: true, activeRuns: 1, queuedRuns: 2, workerBudget: 8, workersPerRun: 4 },
      }),
    );
    const verify = document.querySelector<HTMLElement>('.strip-pair[data-chip="verify"]');
    expect(verify?.querySelector('.strip-value')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('lock held');
    expect(verify?.querySelector('.strip-flag__num')?.textContent).toBe('2');
    expect(verify?.querySelector('.strip-flag__txt')?.textContent).toBe(' QUEUED');
  });

  it('folds the v4 KPI counts into the groups as data-kpi numbers matching boardKpis', () => {
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
    expect(values.get('jobs.binned')).toBe(kpis.jobs.binned);
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
    expect(conflicting?.classList.contains('strip-kpi__num--alert')).toBe(true);

    // v6.1 ruling 5 survives the re-face: every rendered number carries its
    // visible label — adjacency in the DOM, not a tooltip promise.
    const fields = [...document.querySelectorAll<HTMLElement>('.strip-kpi')];
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      const label = field.querySelector<HTMLElement>('.strip-kpi__k');
      const num = field.querySelector<HTMLElement>('[data-kpi]');
      expect(label?.textContent, `${num?.dataset.kpi} label text`).toBeTruthy();
      expect(num, `${label?.textContent} number`).not.toBeNull();
      expect(label?.nextElementSibling).toBe(num);
    }
    const groupNames = [...document.querySelectorAll<HTMLElement>('.strip-group__name')].map(
      (node) => node.textContent ?? '',
    );
    expect(groupNames).toEqual(['HEISTS', 'PRS', 'CREW']);
    expect(groupNames.some((text) => text.includes('MINIONS'))).toBe(false);
    // The trackers chip's long-form explanation survives the re-face.
    expect(document.querySelector<HTMLElement>('.strip-groups')?.title).toContain('Jev decision routing');
    // Per-group and per-KPI explanations (title/AT text) survive too.
    const firstPairs = document.querySelector<HTMLElement>('.strip-group__pairs');
    expect(firstPairs?.getAttribute('title')).toBeTruthy();
    const firstKpi = firstPairs?.querySelector<HTMLElement>('.strip-kpi');
    expect(firstKpi?.querySelector('.strip-kpi__k')?.getAttribute('title')).toBeTruthy();
    expect(firstKpi?.querySelector('.strip-kpi__num')?.getAttribute('title')).toBeTruthy();
  });

  it('keeps the Jev chip; the needs-Gru number renders once, on the ALERTS pair', () => {
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
    const chip = document.querySelector<HTMLElement>('#board-decisions');
    expect(chip?.textContent).toBe('Jev: READY');
    expect(chip?.dataset.state).toBe('ready');
    expect(chip?.classList.contains('pp-chip--done')).toBe(true);
    // Single visible instance: the tracker chip keeps id/text/title but
    // stays hidden — the number renders once, on the ALERTS pair.
    const unacked = document.querySelector<HTMLElement>('#board-unacked');
    expect(unacked?.hidden).toBe(true);
    expect(unacked?.textContent).toContain('2 needs Gru');
    // The count is the LIVE machine queue: the copy says so (A4).
    expect(unacked?.title).toContain('2 live machine-attention notifications awaiting a Gru disposition');
    expect(unacked?.title).toContain('closed receipts stay in the record');
    const alerts = document.querySelector<HTMLElement>('.strip-pair[data-chip="alerts"]');
    expect(alerts?.querySelector('.strip-value__num')?.textContent).toBe('2');
    expect(alerts?.querySelector('.strip-flag__txt')?.textContent).toBe('NEEDS GRU');
    expect(alerts?.classList.contains('strip-pair--alert')).toBe(true);
  });

  it('renders the four GRU wake truths, independent of Silas', () => {
    const silasAt = (iso: string | null): SilasView => ({
      lastWakeAt: iso,
      lastTickAt: null,
      lastReconcileAt: null,
      lastReconcileFailedAt: null,
      reconcileFailedNewer: false,
      lastUsefulActionAt: null,
      nextAction: null,
      openTurnSince: null,
      reconciliationsToday: 2,
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    const view = new BoardView(() => {});
    const wakes = document.querySelector<HTMLElement>('#board-wakes');
    // 0 + null: the honest no-wakes state, count still visible.
    view.render(
      snapshot({ wakes: { count: 0, lastAt: null }, silas: silasAt('2026-01-01T00:00:00.000Z') }),
    );
    expect(wakes?.hidden).toBe(false);
    expect(wakes?.textContent).toContain('no wakes yet');
    expect(wakes?.querySelector('.board-wakes__count')?.textContent).toBe('0');
    // count > 0 + null stamp: last wake UNKNOWN — never "no wakes yet".
    view.render(snapshot({ wakes: { count: 3, lastAt: null } }));
    expect(wakes?.textContent).toContain('3');
    expect(wakes?.textContent).toContain('last wake unknown');
    expect(wakes?.textContent).not.toContain('no wakes yet');
    // count 0 + a supplied valid stamp: the timestamp is NOT discarded —
    // only 0 + no stamp is the no-wakes state.
    view.render(snapshot({ wakes: { count: 0, lastAt: '2026-01-01T00:00:00.000Z' } }));
    expect(wakes?.textContent).not.toContain('no wakes yet');
    expect(wakes?.querySelector('.board-wakes__count')?.textContent).toBe('0');
    expect(wakes?.querySelector('.board-age-split__num')).not.toBeNull();
    expect(wakes?.title).toContain('last');
    // count > 0 + valid stamp: terse wake-age pair, digits in their slot.
    view.render(snapshot({ wakes: { count: 3, lastAt: '2026-01-01T00:00:00.000Z' } }));
    expect(wakes?.querySelector('.board-age-split__num')?.textContent).toBeTruthy();
    expect(wakes?.querySelector('.board-wakes__unknown')).toBeNull();
    expect(wakes?.title).toContain('wake turn');
    // invalid stamp: unknown again — never a fabricated time.
    view.render(snapshot({ wakes: { count: 3, lastAt: 'not-a-timestamp' } }));
    expect(wakes?.textContent).toContain('last wake unknown');
    expect(wakes?.title).toContain('last wake time unknown');
    // 0 + no stamp WITH deferred demand: still the honest no-wakes state —
    // no fire time exists, so it is not "unknown"; the deferred tally is a
    // separate fact beside it.
    view.render(
      snapshot({ wakes: { count: 0, lastAt: null, deferred: { count: 2, reasons: { 'quiet-hours': 2 } } } }),
    );
    expect(wakes?.textContent).toContain('no wakes yet');
    expect(wakes?.textContent).toContain('2 deferred');
    expect(wakes?.textContent).not.toContain('last wake unknown');
    expect(wakes?.title).toContain('deferred (avoided)');
    // Silas stays independent: its pair shows its own wake, never Gru's.
    view.render(
      snapshot({
        wakes: { count: 0, lastAt: null },
        silas: silasAt('2026-01-01T00:00:00.000Z'),
      }),
    );
    const silas = document.querySelector<HTMLElement>('.strip-pair[data-chip="silas"]');
    expect(silas?.textContent).toContain('wake');
    expect(silas?.textContent).not.toContain('last wake unknown');
    const silasNum = silas?.querySelector('.strip-value__num');
    expect(silasNum).not.toBeNull();
    expect(silasNum?.textContent).not.toBe('0');
    expect(silas?.querySelector('.strip-value__num')?.textContent).toMatch(/^\d+$/);
  });

  it('includes the CHILDREN group when the server reported counters and omits it when absent', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    expect(document.querySelectorAll('#chip-rail .strip-group')).toHaveLength(3);
    view.render(
      snapshot({
        // Present-but-zero is a real report; absent is unknown and omits
        // the group (never a claimed zero) — issue #161.
        children: { queued: 1, active: 2, finished: 3, lifetimeCreations: 6 },
      }),
    );
    const groups = [...document.querySelectorAll<HTMLElement>('#chip-rail .strip-group')];
    expect(groups).toHaveLength(4);
    expect(groups[3]?.querySelector('.strip-group__name')?.textContent).toBe('CHILDREN');
    expect(groups[3]?.querySelector('[data-kpi="children.active"]')?.textContent).toBe('2');
  });
});

describe('board v6 — dense job rows', () => {
  beforeEach(mountBoardDom);

  it('renders one row pair: line 1 dot/title/status, line 2 branch/ages/PR link', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ prUrl: 'https://github.com/acme/demo/pull/7' })] }));
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
    const pr = meta?.querySelector<HTMLAnchorElement>('.board-job__pr');
    expect(pr?.getAttribute('href')).toBe('https://github.com/acme/demo/pull/7');
    expect(pr?.textContent).toBe('PR #7 ↗');
    expect(pr?.target).toBe('_blank');
    expect(pr?.rel).toBe('noreferrer');

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

  it("labels each heist's PR link with its own canonical number; unprovable or absent URLs stay generic", () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        repos: [
          {
            name: 'demo',
            jobs: [
              baseJob({ id: 'gh', prUrl: 'https://github.com/acme/demo/pull/138' }),
              baseJob({ id: 'gl', prUrl: 'https://gitlab.example.test/group/demo/-/merge_requests/42' }),
              baseJob({ id: 'generic', prUrl: 'https://example.invalid/pr/43' }),
              baseJob({ id: 'none', prUrl: null }),
            ],
          },
        ],
      }),
    );
    const rows = [...document.querySelectorAll<HTMLElement>('.board-job')];
    const read = (id: string): { readonly label: string | null; readonly href: string | null } => {
      const row = rows.find((candidate) => candidate.dataset.jobId === id);
      if (row === undefined) throw new Error(`row ${id} missing`);
      const link = row.querySelector<HTMLAnchorElement>('.board-job__pr');
      return { label: link?.textContent ?? null, href: link?.getAttribute('href') ?? null };
    };
    // Each heist shows its OWN number (never a shared/stale constant) and
    // the href stays exactly the URL the snapshot carried.
    expect(read('gh')).toEqual({ label: 'PR #138 ↗', href: 'https://github.com/acme/demo/pull/138' });
    expect(read('gl')).toEqual({ label: 'PR #42 ↗', href: 'https://gitlab.example.test/group/demo/-/merge_requests/42' });
    expect(read('generic')).toEqual({ label: 'PR ↗', href: 'https://example.invalid/pr/43' });
    expect(read('none')).toEqual({ label: null, href: null });
  });

  it('keeps concluded rows calm even when their stale history is failing', () => {
    const view = new BoardView(() => {});
    const erroredLenses = [{ lens: 'blind', state: 'error' as const, agentId: null, note: null, verdict: null }];
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'merged-aborted', status: 'merged', rounds: [baseRound({ status: 'aborted', verdict: null })] }),
          baseJob({ id: 'done-lens-error', status: 'done', rounds: [baseRound({ status: 'live', lenses: erroredLenses })] }),
        ],
      }),
    );
    // Settled renders its preview; COLD is count-only until revealed
    // (owner approval j-1064) — both concluded lanes must be inspectable.
    expandCold();
    const alert = new Map(
      [...document.querySelectorAll<HTMLElement>('.board-job')].map((row) => [
        row.dataset.jobId,
        row.classList.contains('board-job--alert'),
      ]),
    );
    // The concluded guard is load-bearing: without it an aborted newest
    // round / errored lens would tint each merged/done row with the alert
    // accent (a closed receipt is history, not a live alarm).
    expect(jobFailing(baseJob({ status: 'merged', rounds: [baseRound({ status: 'aborted', verdict: null })] }))).toBe(false);
    expect(jobFailing(baseJob({ status: 'done', rounds: [baseRound({ status: 'live', lenses: erroredLenses })] }))).toBe(false);
    expect(alert.get('merged-aborted')).toBe(false);
    expect(alert.get('done-lens-error')).toBe(false);
  });

  it('expands inline from a click anywhere on the summary and collapses again; the PR link does not toggle', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ prUrl: 'https://github.com/acme/demo/pull/7' })] }));
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
    expect(pr?.textContent).toBe('PR #7 ↗');
    pr?.addEventListener('click', (event) => event.preventDefault());
    pr?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(row.dataset.expanded).toBe('true');
    expect(pr?.textContent).toBe('PR #7 ↗');

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
    expandForGru();
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
    expandForGru();
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
    // A mixed round (errored lens) lands in FOR GRU; reveal it first.
    expandForGru();
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

  it('hides binned rows behind an explicit disclosure, badges them distinctly, and keeps full history inspectable', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'parked-1', status: 'parked' }),
          baseJob({
            id: 'binned-1',
            status: 'binned',
            note: 'discarded by the owner',
            rounds: [
              baseRound({ id: 'binned-1-r1', seq: 1 }),
              baseRound({ id: 'binned-1-r2', seq: 2, status: 'aborted' }),
            ],
          }),
        ],
      }),
    );
    // Default view: COLD is count-only and its count INCLUDES the binned
    // row — the filter can never silently lose it.
    expect(document.querySelector('.board-band--cold .board-job')).toBeNull();
    expect(document.querySelector('.board-band--cold .board-band__count')?.textContent).toBe('2 heists');
    expandCold();
    // Expanding COLD alone still does not expose the discarded row.
    expect(document.querySelector('.board-band--cold [data-job-id="parked-1"]')).not.toBeNull();
    expect(document.querySelector('.board-band--cold [data-job-id="binned-1"]')).toBeNull();
    const binnedToggle = document.querySelector<HTMLButtonElement>('.board-band--cold .board-band__more--binned');
    expect(binnedToggle).not.toBeNull();
    expect(binnedToggle?.textContent).toBe('Show 1 binned record');
    expect(binnedToggle?.getAttribute('aria-expanded')).toBe('false');
    const collapsedRegionId = binnedToggle?.getAttribute('aria-controls') ?? '';
    expect(collapsedRegionId).not.toBe('');
    expect(document.getElementById(collapsedRegionId)?.hidden).toBe(true);

    binnedToggle?.click();
    const reopened = document.querySelector<HTMLButtonElement>('.board-band--cold .board-band__more--binned');
    expect(reopened?.textContent).toBe('Hide binned');
    expect(reopened?.getAttribute('aria-expanded')).toBe('true');
    const expandedRegionId = reopened?.getAttribute('aria-controls') ?? '';
    expect(expandedRegionId).not.toBe('');
    expect(document.getElementById(expandedRegionId)?.hidden).toBe(false);
    const binnedRow = document.querySelector<HTMLElement>('.board-band--cold [data-job-id="binned-1"]');
    expect(binnedRow).not.toBeNull();
    // Accessible distinct badge: the visible chip names the discard and
    // carries its own tone (never the parked or success fill).
    const badge = binnedRow?.querySelector('.board-job__status');
    expect(badge?.textContent).toBe('binned');
    expect(badge?.classList.contains('pp-chip--binned')).toBe(true);
    expect(badge?.classList.contains('pp-chip--park')).toBe(false);
    // A discarded lane is a closed receipt: even with an aborted newest
    // round it never carries the live alert accent.
    expect(binnedRow?.classList.contains('board-job--alert')).toBe(false);
    // Complete history stays inspectable on the discarded lane.
    binnedRow?.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    expect(binnedRow?.querySelectorAll('.board-round')).toHaveLength(2);
    expect(binnedRow?.textContent).toContain('discarded by the owner');
    // Reversible: the disclosure closes again and the rows go back behind it.
    document.querySelector<HTMLButtonElement>('.board-band--cold .board-band__more--binned')?.click();
    expect(document.querySelector('.board-band--cold [data-job-id="binned-1"]')).toBeNull();
  });

  it('labels the binned disclosure with its count and preserves it across snapshot pushes', () => {
    const view = new BoardView(() => {});
    const first = snapshot({
      jobs: [
        baseJob({ id: 'binned-a', status: 'binned' }),
        baseJob({ id: 'binned-b', status: 'binned' }),
      ],
    });
    view.render(first);
    expandCold();
    const toggle = document.querySelector<HTMLButtonElement>('.board-band--cold .board-band__more--binned');
    expect(toggle?.textContent).toBe('Show 2 binned records');
    toggle?.click();
    expect(document.querySelectorAll('.board-band--cold [data-job-id^="binned-"]')).toHaveLength(2);
    // Disclosures are session state: a live snapshot push never reopens or
    // force-closes the operator's view (the COLD disclosure convention).
    view.render(
      snapshot({
        jobs: [...first.repos[0]!.jobs, baseJob({ id: 'binned-c', status: 'binned' })],
      }),
    );
    const reopened = document.querySelector<HTMLButtonElement>('.board-band--cold .board-band__more--binned');
    expect(reopened?.textContent).toBe('Hide binned');
    expect(reopened?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.board-band--cold [data-job-id^="binned-"]')).toHaveLength(3);
    // ... and the disclosure stays reversible.
    reopened?.click();
    expect(document.querySelectorAll('.board-band--cold [data-job-id^="binned-"]')).toHaveLength(0);
    expect(document.querySelector<HTMLButtonElement>('.board-band--cold .board-band__more--binned')?.textContent)
      .toBe('Show 3 binned records');
    // Session persistence is the COLD/FOR GRU convention: a snapshot that
    // drops every binned row removes the control, and a later binned lane
    // returns under the state the operator last chose (collapsed here).
    view.render(snapshot({ jobs: [baseJob({ id: 'parked-3', status: 'parked' })] }));
    expect(document.querySelector('.board-band__more--binned')).toBeNull();
    view.render(snapshot({ jobs: [baseJob({ id: 'binned-d', status: 'binned' })] }));
    expect(document.querySelector<HTMLButtonElement>('.board-band--cold .board-band__more--binned')?.textContent)
      .toBe('Show 1 binned record');
  });

  it('focus falls to the COLD shortcut when the binned disclosure disappears from a push', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ id: 'binned-focus', status: 'binned' })] }));
    expandCold();
    const toggle = document.querySelector<HTMLElement>('.board-band--cold .board-band__more--binned');
    expect(toggle?.dataset.focusKey).toBe('section:cold-binned');
    toggle?.focus();
    expect(document.activeElement).toBe(toggle);
    // The next snapshot has no binned rows: the disclosure is gone.
    view.render(snapshot({ jobs: [baseJob({ id: 'parked-focus', status: 'parked' })] }));
    const active = document.activeElement;
    expect(active).toBeInstanceOf(HTMLElement);
    expect((active as HTMLElement).classList.contains('board-nav__link')).toBe(true);
    expect((active as HTMLElement).getAttribute('data-nav')).toBe('cold');
  });

  it('renders no binned disclosure when the snapshot has no binned rows', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [] }));
    expect(document.querySelector('.board-band__more--binned')).toBeNull();
    view.render(snapshot({ jobs: [baseJob({ id: 'parked-2', status: 'parked' })] }));
    expandCold();
    expect(document.querySelector('.board-band__more--binned')).toBeNull();
    expect(document.querySelector('.board-band--cold [data-job-id="parked-2"]')).not.toBeNull();
    expect(document.querySelector('.board-band--cold .board-band__count')?.textContent).toBe('1 heist');
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
    expandForGru();
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
    // No repos, no jobs, and a wired-but-empty pipeline: every shortcut
    // keeps a valid target.
    view.render(snapshot({ repos: [], pipeline: { entries: [], pending: 0 } }));
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
    expect(row?.querySelector('.board-agent__name')?.textContent).toBe('unassigned');
    expect(row?.querySelector('.board-agent__hash')?.textContent).toBe('live');
    expect(row?.querySelector('.board-agent__sub')?.textContent).toContain('minion · streaming');
    expect(row?.querySelector('.board-agent__state')?.textContent).toBe('streaming');
  });

  it('distinguishes child workers from top-level minions with a parent link and family counters', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [
          agent('parent-minion', {
            role: 'minion',
            label: 'Payment lane',
            parentage: 'top-level',
            childCounts: { queued: 1, active: 1, finished: 2, lifetimeCreations: 4 },
          }),
          agent('child-agent', {
            role: 'minion',
            label: 'child of Payment lane',
            parentage: 'child',
            parentAgentId: 'parent-minion',
            child: {
              id: 'child_1',
              agentId: 'child-agent',
              parentAgentId: 'parent-minion',
              jobId: 'job-1',
              purpose: 'audit',
              authority: 'read-only',
              state: 'done',
              worktreeId: 'child_1',
              branch: null,
              resultState: 'done',
              resultSummary: 'all clear',
              resultRef: '/sessions/child.jsonl',
              createdAt: '2026-01-01T00:00:00.000Z',
              admittedAt: '2026-01-01T00:00:01.000Z',
              startedAt: '2026-01-01T00:00:02.000Z',
              finishedAt: '2026-01-01T00:01:00.000Z',
            },
          }),
          agent('legacy-minion', { role: 'minion', label: 'legacy lane' }),
        ],
      }),
    );
    const rows = [...document.querySelectorAll<HTMLElement>('#board-agents .board-agent')];
    // Crew-heist-labels: a minion's primary name is its heist, not its
    // label — locate rows by the #171-stable dataset.agentId identity.
    const byAgentId = new Map(rows.map((row) => [row.dataset.agentId, row]));
    // The parent renders its family counters and the top-level marker.
    const parent = byAgentId.get('parent-minion')!;
    expect(parent.dataset.parentage).toBe('top-level');
    expect(parent.querySelector('.board-agent__parentage')?.textContent).toBe('top-level');
    expect(parent.querySelector('.board-agent__child-counts')?.textContent).toContain('4 children');
    // A child row is labeled as a child and links back to its parent.
    const child = byAgentId.get('child-agent')!;
    expect(child.dataset.parentage).toBe('child');
    expect(child.querySelector('.board-agent__role')?.textContent).toContain('child ·');
    expect(child.querySelector('.board-agent__parent-link')?.textContent).toContain('Payment lane');
    // A legacy row (no parentage field) is never claimed either way.
    const legacy = byAgentId.get('legacy-minion')!;
    expect(legacy.dataset.parentage).toBe('unknown');
    expect(legacy.querySelector('.board-agent__parentage')).toBeNull();
  });

  it('navigates to a collapsed parent and activates rows from the keyboard', () => {
    const opened: string[] = [];
    const view = new BoardView(({ file }) => opened.push(file));
    const childView = {
      id: 'child_1',
      agentId: 'child-agent',
      parentAgentId: 'old-parent',
      jobId: 'job-1',
      purpose: 'audit',
      authority: 'read-only' as const,
      state: 'done' as const,
      worktreeId: 'child_1',
      branch: null,
      resultState: 'done' as const,
      resultSummary: 'all clear',
      resultRef: '/sessions/child.jsonl',
      createdAt: '2026-01-01T00:00:00.000Z',
      admittedAt: '2026-01-01T00:00:01.000Z',
      startedAt: '2026-01-01T00:00:02.000Z',
      finishedAt: '2026-01-01T00:01:00.000Z',
    };
    view.render(
      snapshot({
        agents: [
          agent('child-agent', {
            role: 'minion',
            label: 'child of archived lane',
            parentage: 'child',
            parentAgentId: 'old-parent',
            sessionFile: '/sessions/child-agent.jsonl',
            child: childView,
          }),
          agent('old-parent', { role: 'minion', label: 'archived parent', parentage: 'top-level', state: 'disposed' }),
        ],
      }),
    );
    // The disposed parent row is collapsed: only the child is visible.
    expect(document.querySelectorAll('#board-agents .board-agent')).toHaveLength(1);
    const link = document.querySelector<HTMLButtonElement>('.board-agent__parent-link');
    expect(link?.tagName).toBe('BUTTON');
    // Keys pressed ON the nested link must not be hijacked by the row's
    // transcript action (Enter bubbles; target !== row → ignored).
    link?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(opened).toEqual([]);
    link?.click();
    const rows = [...document.querySelectorAll<HTMLElement>('#board-agents .board-agent')];
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.dataset.agentId === 'old-parent')).toBe(true);
    // Rows carry button semantics and activate on Enter (div + keydown).
    const childRow = rows.find((row) => row.dataset.agentId === 'child-agent')!;
    expect(childRow.getAttribute('role')).toBe('button');
    expect(childRow.tabIndex).toBe(0);
    childRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(opened).toEqual(['/sessions/child-agent.jsonl']);
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

describe('board agent rail — truthful runtime status (#171)', () => {
  beforeEach(mountBoardDom);

  it('verified-historical sessions never count or sort as live crew; their transcripts stay reachable', () => {
    const opened: { file: string }[] = [];
    const view = new BoardView((_request) => {
      opened.push(_request);
    });
    view.render(
      snapshot({
        agents: [
          // The observed defect: a September Silas frozen in `streaming`
          // next to the one live Silas, plus a stale lens worker.
          agent('silas-sept', { role: 'silas', state: 'streaming', runtime: 'historical', lastActivity: '2026-09-29T00:00:00.000Z' }),
          agent('lens-sept', { state: 'streaming', runtime: 'historical', lastActivity: '2026-09-29T00:00:00.000Z' }),
          agent('silas-now', { role: 'silas', state: 'idle', runtime: 'current' }),
          agent('gru-old', { role: 'gru', state: 'disposed' }),
        ],
      }),
    );
    // Live rail = current rows only; history and graveyard sit behind
    // their own disclosures; the CREW count agrees with the rail.
    const rail = document.getElementById('board-agents')!;
    expect(rail.querySelectorAll('.board-agent:not(.board-agent--disposed):not(.board-agent--historical)')).toHaveLength(1);
    expect(document.getElementById('rail-agents-count')?.textContent).toBe('1');
    const historyToggle = [
      ...rail.querySelectorAll<HTMLButtonElement>('.board-agent-toggle'),
    ].find((toggle) => toggle.textContent?.includes('history'))!;
    expect(historyToggle.textContent).toContain('2 history');
    expect(historyToggle.getAttribute('aria-expanded')).toBe('false');
    expect(rail.querySelectorAll('.board-agent--historical')).toHaveLength(0);

    historyToggle.click();
    const historicalRows = [...rail.querySelectorAll<HTMLElement>('.board-agent--historical')];
    expect(historicalRows).toHaveLength(2);
    // The history marker is explicit, and the transcript click survives.
    for (const row of historicalRows) {
      expect(row.querySelector('.board-agent__runtime--historical')?.textContent).toBe('🕘 history');
      expect(row.title).toContain('historical');
    }
    historicalRows[0]?.click();
    expect(opened).toHaveLength(1); // the transcript history stays accessible
  });

  it('a raw-idle agent with open supervision work shows the work it is doing', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [
          agent('silas-working', {
            role: 'silas',
            state: 'idle',
            status: 'streaming',
            runtime: 'current',
            lastActivity: '2026-09-29T00:00:00.000Z',
            supervision: {
              state: 'watching',
              restarts: 0,
              breakerOpen: false,
              openTurn: true,
              lastEventAt: new Date(Date.now() - 30_000).toISOString(),
            },
          }),
        ],
      }),
    );
    const row = document.querySelector<HTMLElement>('#board-agents .board-agent');
    // Chip + subline + dataset read the DERIVED status; the stale ledger
    // stamp never shows days-quiet while supervision sees fresh events.
    expect(row?.dataset.state).toBe('streaming');
    expect(row?.querySelector('.board-agent__state')?.textContent).toBe('streaming');
    expect(row?.querySelector('.board-agent__role')?.textContent).toContain('silas · streaming');
    const age = row?.querySelector('.board-agent__age')?.textContent ?? '';
    expect(age).toMatch(/^\d+s quiet$/);
  });

  it('ambiguous ownership stays visible and marked, but only confirmed current owners count as crew', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [
          // A classifying snapshot (some row carries runtime) with one
          // row missing the field and one explicitly unverified, plus a
          // confirmed current owner.
          agent('legacy-row', { state: 'idle' }),
          agent('probed-row', { state: 'idle', runtime: 'unverified' }),
          agent('current-row', { state: 'idle', runtime: 'current' }),
        ],
      }),
    );
    const rows = [...document.querySelectorAll<HTMLElement>('#board-agents .board-agent')];
    expect(rows).toHaveLength(3); // conservative: ambiguous rows stay visible
    // The active count claims only what the runtime proves (AC5).
    expect(document.getElementById('rail-agents-count')?.textContent).toBe('1');
    const marked = rows.filter((row) => row.querySelector('.board-agent__runtime--unknown') !== null);
    expect(marked).toHaveLength(2);
    for (const row of marked) {
      expect(row.querySelector('.board-agent__runtime--unknown')?.textContent).toBe('❓ unverified');
    }
    // No history/disposed disclosures were fabricated from ambiguity.
    expect(document.querySelector('.board-agent-toggle')).toBeNull();
  });

  it('a pre-upgrade snapshot (no runtime classification at all) keeps the legacy board: every live row counts and none is marked', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [agent('old-a', { state: 'idle' }), agent('old-b', { role: 'minion', state: 'streaming' })],
      }),
    );
    expect(document.getElementById('rail-agents-count')?.textContent).toBe('2');
    expect(document.querySelector('.board-agent__runtime--unknown')).toBeNull();
    expect(document.querySelector('.board-agent-toggle')).toBeNull();
  });

  it('an owner-held stop stays in the live crew and counts even when the released handle left the record disposed', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [
          // Breaker trip: handle disposed → ledger state disposed, while
          // the current supervisor still owns the lane awaiting re-arm.
          agent('minion-stopped', {
            role: 'minion',
            state: 'disposed',
            runtime: 'current',
            supervision: { state: 'stopped', restarts: 3, breakerOpen: true, stopReason: 'crash loop' },
          }),
          // A genuinely disposed past record keeps the graveyard.
          agent('minion-old', { role: 'minion', state: 'disposed', runtime: 'historical' }),
        ],
      }),
    );
    const rail = document.getElementById('board-agents')!;
    const liveRow = rail.querySelector<HTMLElement>('.board-agent:not(.board-agent--disposed):not(.board-agent--historical)');
    // Crew-heist-labels: a minion's primary name is its heist (unassigned
    // here — no job binding); the full id rides the accessible name.
    expect(liveRow?.getAttribute('aria-label')).toContain('minion-stopped');
    expect(liveRow?.querySelector('.board-agent__supervision--alert')?.textContent).toBe('⛔ stopped');
    // The active count includes the held lane; the graveyard toggle does
    // not.
    expect(document.getElementById('rail-agents-count')?.textContent).toBe('1');
    const disposedToggle = [...rail.querySelectorAll<HTMLButtonElement>('.board-agent-toggle')].find(
      (toggle) => toggle.textContent?.includes('disposed'),
    );
    expect(disposedToggle?.textContent).toContain('1 disposed');
  });

  it('a genuine duplicate current singleton owner is surfaced as an anomaly; a historical epoch or review pool is not', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [
          agent('silas-a', { role: 'silas', state: 'idle', runtime: 'current' }),
          agent('silas-b', { role: 'silas', state: 'idle', runtime: 'current' }),
          agent('silas-sept', { role: 'silas', state: 'streaming', runtime: 'historical' }),
          agent('minion-1', { role: 'minion', state: 'idle', runtime: 'current' }),
          agent('minion-2', { role: 'minion', state: 'idle', runtime: 'current' }),
          // A review round legitimately runs lead + specialists under the
          // same role concurrently — never a duplicate-owner anomaly.
          agent('perkins-lead', { role: 'perkins', state: 'idle', runtime: 'current' }),
          agent('perkins-blind', { role: 'perkins', state: 'idle', runtime: 'current' }),
        ],
      }),
    );
    const flagged = [...document.querySelectorAll<HTMLElement>('#board-agents .board-agent')].filter(
      (row) => row.querySelector('.board-agent__runtime--alert') !== null,
    );
    // Both CURRENT Silas owners carry the anomaly; the historical epoch,
    // the minions and the concurrent Perkins review pool never do.
    expect(flagged.map((row) => row.querySelector('.board-agent__name')?.textContent)).toEqual([
      'silas-a',
      'silas-b',
    ]);
    expect(flagged[0]?.title).toContain('more than one current silas');
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

describe('board v6 — section truth: closed receipts never queue, stopped lanes never lie', () => {
  beforeEach(mountBoardDom);

  it('the shortcut strip and the section bodies count the SAME truth (one derivation)', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'walled', status: 'working', rounds: [] })],
        agents: [
          agent('minion-walled', {
            role: 'minion',
            jobId: 'walled',
            supervision: { state: 'stopped', restarts: 0, breakerOpen: true, stopReason: 'quota_wall' },
          }),
        ],
        notifications: [notification('n-escalation', { agentId: 'minion-walled' })],
        unackedActionRequired: 1,
      }),
    );
    // The stopped lane sits in NEEDS GRU (main's stop truth) — the strip
    // count and the section head count must agree because BOTH read the
    // single per-render sections derivation (stopped/live maps included).
    const navCount = document.querySelector<HTMLElement>('.board-nav__link[data-nav="for-gru"] .board-nav__count');
    expect(navCount?.textContent).toBe('1');
    const sectionCount = document.querySelector<HTMLElement>('.board-band--needs-you .board-band__count');
    expect(sectionCount?.textContent).toContain('1');
    expandForGru();
    const row = document.querySelector<HTMLElement>('.board-band--needs-you .board-job');
    expect(row?.getAttribute('data-job-id')).toBe('walled');
  });

  it('focus falls back to the section disclosure when its job moves into a collapsed section', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'walled', status: 'working', rounds: [] })],
        agents: [
          agent('minion-walled', {
            role: 'minion',
            jobId: 'walled',
            supervision: { state: 'stopped', restarts: 0, breakerOpen: true, stopReason: 'quota_wall' },
          }),
        ],
        notifications: [notification('n-escalation', { agentId: 'minion-walled' })],
        unackedActionRequired: 1,
      }),
    );
    expandForGru();
    const toggle = document.querySelector<HTMLElement>('.board-band--needs-you .board-job__toggle');
    toggle?.focus();
    expect(document.activeElement).toBe(toggle);
    // The next snapshot resolves the stop and the lane goes silent-cold:
    // the focused row leaves the expanded section entirely and COLD is
    // count-only — the exact focus target disappears, so focus must fall
    // back to a section disclosure toggle, never to <body>.
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'walled',
            status: 'working',
            rounds: [],
            lastAgentActivity: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
        ],
        agents: [agent('minion-walled', { role: 'minion', jobId: 'walled', state: 'streaming', lastActivity: new Date(Date.now() - 45 * 60_000).toISOString() })],
      }),
    );
    const active = document.activeElement;
    expect(active).toBeInstanceOf(HTMLElement);
    expect((active as HTMLElement).tagName).toBe('BUTTON');
    expect((active as HTMLElement).className).toContain('board-band__more');
    expect((active as HTMLElement).getAttribute('aria-expanded')).toBe('false');
  });

  it('a merged lane with a leftover unacked escalation leaves NEEDS GRU and renders as a closed receipt', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'merged-leftover', status: 'merged', rounds: [] })],
        agents: [agent('minion-merged', { role: 'minion', jobId: 'merged-leftover' })],
        notifications: [notification('n-leftover', { agentId: 'minion-merged' })],
        unackedActionRequired: 0, // the service counts LIVE rows only
      }),
    );
    expandCold();
    const needsYou = document.querySelector('.board-band--needs-you');
    // The calm green clear state is the truth: nothing needs Gru.
    expect(needsYou?.querySelector('.board-job')).toBeNull();
    expect(needsYou?.querySelector('.board-band__clear-text')?.textContent).toBe('nothing needs Gru');
    // The merged lane renders as a closed receipt in its settle band —
    // present for the record, never as an active queue entry.
    const receipt = document.querySelector<HTMLElement>('.board-band--cold .board-job, .board-band--settled .board-job');
    expect(receipt?.getAttribute('data-job-id')).toBe('merged-leftover');
    expect(receipt?.getAttribute('data-status')).toBe('merged');
    expect(receipt?.querySelector('.board-job__signal')).toBeNull(); // no 🔔 alert chip
  });

  it('the unacked chip counts only live rows while the record keeps every durable row', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'live-walled', status: 'working', rounds: [] }),
          baseJob({ id: 'merged-leftover', status: 'merged', rounds: [] }),
        ],
        agents: [
          agent('minion-live', { role: 'minion', jobId: 'live-walled' }),
          agent('minion-merged', { role: 'minion', jobId: 'merged-leftover' }),
        ],
        notifications: [
          notification('n-live', { agentId: 'minion-live' }),
          notification('n-closed', { agentId: 'minion-merged' }),
        ],
        unackedActionRequired: 1, // the live row only — the closed one is a receipt
      }),
    );
    // FOR GRU is collapsed and COLD is count-only by default (j-1064):
    // reveal both before asserting classification and record truth.
    expandForGru();
    expandCold();
    const unacked = document.querySelector<HTMLElement>('#board-unacked');
    // The number renders once, on the ALERTS pair; the tracker chip keeps
    // its id/text but stays hidden (no duplicate instance).
    expect(unacked?.hidden).toBe(true);
    expect(unacked?.textContent).toContain('1 needs Gru');
    expect(document.querySelector<HTMLElement>('.strip-pair[data-chip="alerts"] .strip-value__num')?.textContent).toBe('1');
    // The record keeps BOTH durable rows. Machine rows clear through a Gru
    // disposition, not a human Ack, so neither carries an ack control.
    const rows = [...document.querySelectorAll('.board-notification')];
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.querySelector('.board-notification__ack') !== null)).toHaveLength(0);
    // The closed receipt renders under FEED with its marker — never in the
    // live NEEDS GRU queue the operator acts on; the live row stays queued.
    const sectionOf = (needle: string): string | undefined =>
      rows
        .find((row) => row.textContent?.includes(needle))
        ?.closest('.board-notification-section')
        ?.querySelector('.board-notification-section__head')?.textContent ?? undefined;
    const closedRow = rows.find((row) => row.textContent?.includes('Notice n-closed'));
    expect(closedRow?.textContent).toContain('closed receipt');
    expect(closedRow?.getAttribute('data-receipt')).toBe('closed');
    expect(sectionOf('Notice n-closed')).toBe('FEED');
    expect(sectionOf('Notice n-live')).toBe('NEEDS GRU');
    // The live lane still carries its machine signal; the receipt carries none.
    const live = document.querySelector<HTMLElement>('.board-band--needs-you .board-job');
    expect(live?.getAttribute('data-job-id')).toBe('live-walled');
    expect(live?.querySelector('.board-job__signal')?.textContent).toContain('1 needs Gru');
    expect(document.querySelector('.board-band--cold .board-job__signal, .board-band--settled .board-job__signal')).toBeNull();
  });

  it('a quota-walled lane shows its true waiting state instead of plain working', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'walled',
            status: 'working',
            rounds: [],
            lastAgentActivity: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
        ],
        agents: [
          agent('minion-walled', {
            role: 'minion',
            jobId: 'walled',
            supervision: { state: 'stopped', restarts: 2, breakerOpen: true, stopReason: 'quota_wall' },
          }),
        ],
      }),
    );
    const row = document.querySelector<HTMLElement>('.board-job');
    expect(row?.getAttribute('data-job-id')).toBe('walled');
    expect(row?.getAttribute('data-worker-state')).toBe('waiting');
    // Not COLD, not flagged stalled: the silence has a recorded cause.
    expect(row?.getAttribute('data-band')).toBe('in-flight');
    expect(row?.querySelector('.board-job__stale')).toBeNull();
    const chip = row?.querySelector('.board-job__status');
    expect(chip?.textContent).toBe('waiting · quota wall');
    expect(chip?.className).toContain('pp-chip--park');
    expect(chip?.getAttribute('title')).toContain('worker stopped by supervision (quota wall)');
  });

  it('an aborted isolated review never marks a working lane as waiting', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'reworking', status: 'working', rounds: [] })],
        agents: [
          agent('minion-working', { role: 'minion', jobId: 'reworking', state: 'streaming', lastActivity: new Date().toISOString() }),
          agent('perkins-aborted', {
            role: 'perkins',
            roundId: 'r1',
            jobId: 'reworking',
            supervision: { state: 'stopped', restarts: 0, breakerOpen: false, stopReason: 'review aborted' },
          }),
        ],
      }),
    );
    const row = document.querySelector<HTMLElement>('.board-job');
    expect(row?.getAttribute('data-job-id')).toBe('reworking');
    // The workflow-owned stop belongs to the round lifecycle: the lane
    // keeps its true working state (and its own minion's stop would still
    // swap it to waiting).
    expect(row?.getAttribute('data-worker-state')).toBeNull();
    expect(row?.querySelector('.board-job__status')?.textContent).toBe('working');
    expect(row?.getAttribute('data-band')).toBe('in-flight');
  });

  it('a recent non-minion frame never keeps a silent minion out of COLD (code review V1)', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'mixed-role', status: 'working', rounds: [] })],
        agents: [
          // The minion has been silent past the window...
          agent('minion-silent', {
            role: 'minion',
            jobId: 'mixed-role',
            state: 'streaming',
            lastActivity: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
          // ...while a bound review agent spoke seconds ago. The digest
          // watches minions only, so the board must agree: COLD + stalled.
          agent('perkins-recent', {
            role: 'perkins',
            roundId: 'r1',
            jobId: 'mixed-role',
            lastActivity: new Date().toISOString(),
          }),
        ],
      }),
    );
    expandCold();
    const row = document.querySelector<HTMLElement>('.board-job');
    expect(row?.getAttribute('data-band')).toBe('cold');
    expect(row?.querySelector('.board-job__stale')?.textContent).toBe('stalled');
  });

  it('a verified-historical minion stamp never keeps a dead lane warm (#171)', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'stale-lane',
            status: 'working',
            rounds: [],
            lastAgentActivity: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
        ],
        agents: [
          // The only minion record is a VERIFIED-historical session whose
          // frozen September stamp is recent-looking. It is not live work:
          // the lane reads on its own recency — COLD + stalled.
          agent('minion-sept', {
            role: 'minion',
            jobId: 'stale-lane',
            state: 'streaming',
            runtime: 'historical',
            lastActivity: new Date(Date.now() - 60_000).toISOString(),
          }),
        ],
      }),
    );
    expandCold();
    const row = document.querySelector<HTMLElement>('.board-job');
    expect(row?.getAttribute('data-band')).toBe('cold');
    expect(row?.querySelector('.board-job__stale')?.textContent).toBe('stalled');
  });

  it('a verified-historical minion never masks a current stop as live work (#171)', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'stopped-lane',
            status: 'working',
            rounds: [],
            lastAgentActivity: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
        ],
        agents: [
          agent('minion-stopped', {
            role: 'minion',
            jobId: 'stopped-lane',
            supervision: { state: 'stopped', restarts: 2, breakerOpen: true, stopReason: 'quota_wall' },
          }),
          // A stale historical epoch of the same lane, frozen mid-stream,
          // must not clear the stop with its frozen stamp.
          agent('minion-epoch', {
            role: 'minion',
            jobId: 'stopped-lane',
            state: 'streaming',
            runtime: 'historical',
            lastActivity: new Date(Date.now() - 30_000).toISOString(),
          }),
        ],
      }),
    );
    const row = document.querySelector<HTMLElement>('.board-job');
    expect(row?.getAttribute('data-worker-state')).toBe('waiting');
    expect(row?.querySelector('.board-job__status')?.textContent).toBe('waiting · quota wall');
  });

  it('loads older receipts on demand and merges them into FEED (D3)', async () => {
    const older = notification('older-receipt');
    const client = {
      ackNotification: vi.fn(() => Promise.resolve()),
      markNotificationShown: vi.fn(() => Promise.resolve(true)),
      fetchReceipts: vi.fn(() => Promise.resolve({ receipts: [older], nextOffset: 1, hasMore: false })),
    } as unknown as import('../lib/board-client.js').BoardClient;
    const view = new BoardView(() => {});
    view.bindClient(client);
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'receipt-lane', status: 'merged', rounds: [] })],
        agents: [agent('minion-receipt-lane', { role: 'minion', jobId: 'receipt-lane' })],
        notifications: [notification('snapshot-receipt', { agentId: 'minion-receipt-lane' })],
      }),
    );
    const more = document.querySelector<HTMLButtonElement>('.board-notification__more');
    expect(more).not.toBeNull();
    expect(document.getElementById('notification-list')?.textContent).not.toContain('Notice older-receipt');
    more!.click();
    await vi.waitFor(() =>
      expect(document.getElementById('notification-list')?.textContent).toContain('Notice older-receipt'),
    );
    expect(client.fetchReceipts).toHaveBeenCalledWith(0);
  });

  it('a re-pair clears fetched older receipts instead of leaking them into the new server FEED', async () => {
    const older = notification('older-receipt');
    const clientA = {
      ackNotification: vi.fn(() => Promise.resolve()),
      markNotificationShown: vi.fn(() => Promise.resolve(true)),
      fetchReceipts: vi.fn(() => Promise.resolve({ receipts: [older], nextOffset: 1, hasMore: false })),
    } as unknown as import('../lib/board-client.js').BoardClient;
    const view = new BoardView(() => {});
    view.bindClient(clientA);
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'receipt-lane', status: 'merged', rounds: [] })],
        agents: [agent('minion-receipt-lane', { role: 'minion', jobId: 'receipt-lane' })],
        notifications: [notification('snapshot-receipt', { agentId: 'minion-receipt-lane' })],
      }),
    );
    document.querySelector<HTMLButtonElement>('.board-notification__more')!.click();
    await vi.waitFor(() =>
      expect(document.getElementById('notification-list')?.textContent).toContain('Notice older-receipt'),
    );

    // A re-pair mints a fresh server: the old page is not this server's record.
    const clientB = {
      ackNotification: vi.fn(() => Promise.resolve()),
      markNotificationShown: vi.fn(() => Promise.resolve(true)),
      fetchReceipts: vi.fn(() => Promise.resolve({ receipts: [], nextOffset: 0, hasMore: true })),
    } as unknown as import('../lib/board-client.js').BoardClient;
    view.bindClient(clientB);
    view.render(snapshot({ notifications: [] }));
    expect(document.getElementById('notification-list')?.textContent).not.toContain('Notice older-receipt');
  });

  it('a re-pair during an in-flight receipt fetch drops the stale page instead of merging it', async () => {
    const older = notification('older-receipt');
    let resolvePage: (page: { receipts: NotificationView[]; nextOffset: number; hasMore: boolean }) => void = () => {};
    const pending = new Promise<{ receipts: NotificationView[]; nextOffset: number; hasMore: boolean }>((resolve) => {
      resolvePage = resolve;
    });
    const clientA = {
      ackNotification: vi.fn(() => Promise.resolve()),
      markNotificationShown: vi.fn(() => Promise.resolve(true)),
      fetchReceipts: vi.fn(() => pending),
    } as unknown as import('../lib/board-client.js').BoardClient;
    const view = new BoardView(() => {});
    view.bindClient(clientA);
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'receipt-lane', status: 'merged', rounds: [] })],
        agents: [agent('minion-receipt-lane', { role: 'minion', jobId: 'receipt-lane' })],
        notifications: [notification('snapshot-receipt', { agentId: 'minion-receipt-lane' })],
      }),
    );
    document.querySelector<HTMLButtonElement>('.board-notification__more')!.click();
    expect(clientA.fetchReceipts).toHaveBeenCalledTimes(1);

    const clientB = {
      ackNotification: vi.fn(() => Promise.resolve()),
      markNotificationShown: vi.fn(() => Promise.resolve(true)),
      fetchReceipts: vi.fn(() => Promise.resolve({ receipts: [], nextOffset: 0, hasMore: true })),
    } as unknown as import('../lib/board-client.js').BoardClient;
    view.bindClient(clientB);
    view.render(snapshot({ notifications: [] }));
    resolvePage({ receipts: [older], nextOffset: 1, hasMore: false });
    await pending;
    expect(document.getElementById('notification-list')?.textContent).not.toContain('Notice older-receipt');
  });

  it('a stopped lane with an unacked escalation sits in NEEDS GRU — waiting chip, honest section', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'walled', status: 'working', rounds: [] })],
        agents: [
          agent('minion-walled', {
            role: 'minion',
            jobId: 'walled',
            supervision: { state: 'stopped', restarts: 0, breakerOpen: true, stopReason: 'quota_wall' },
          }),
        ],
        notifications: [notification('n-escalation', { agentId: 'minion-walled' })],
        unackedActionRequired: 1,
      }),
    );
    expandForGru();
    const row = document.querySelector<HTMLElement>('.board-band--needs-you .board-job');
    expect(row?.getAttribute('data-job-id')).toBe('walled');
    expect(row?.getAttribute('data-worker-state')).toBe('waiting');
    expect(row?.querySelector('.board-job__status')?.textContent).toBe('waiting · quota wall');
    expect(row?.querySelector('.board-job__signal')?.textContent).toContain('1 needs Gru');
    const unacked = document.querySelector<HTMLElement>('#board-unacked');
    expect(unacked?.textContent).toContain('1 needs Gru');
  });

  it('the waiting truth is scoped to working lanes: an in-review lane with a live round keeps its true chip', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'reviewing', status: 'in-review' })],
        agents: [
          agent('minion-reviewing', {
            role: 'minion',
            jobId: 'reviewing',
            supervision: { state: 'stopped', restarts: 3, breakerOpen: true, stopReason: 'crash loop' },
          }),
        ],
      }),
    );
    const row = document.querySelector<HTMLElement>('.board-job');
    expect(row?.getAttribute('data-worker-state')).toBeNull();
    expect(row?.querySelector('.board-job__status')?.textContent).toBe('in-review');
  });

  it('without a stop the same silent lane still demotes to COLD with the stalled flag (COLD stays honest)', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'silent',
            status: 'working',
            rounds: [],
            lastAgentActivity: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
        ],
      }),
    );
    expandCold();
    const row = document.querySelector<HTMLElement>('.board-band--cold .board-job');
    expect(row?.getAttribute('data-job-id')).toBe('silent');
    expect(row?.querySelector('.board-job__stale')?.textContent).toBe('stalled');
    expect(row?.getAttribute('data-worker-state')).toBeNull();
    expect(row?.querySelector('.board-job__status')?.textContent).toBe('working');
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
    const controls = [...band.querySelectorAll<HTMLElement>('[data-action-id]')].map(
      (node) => `${node.dataset.actionId}/${node.dataset.control}`,
    );
    // One action, two explicit controls (reveal-only disclosure + Ack); the
    // machine incident contributes neither, and no other action leaks in.
    expect(controls.sort()).toEqual(['owner-ack:owner-stop/ack', 'owner-ack:owner-stop/disclose']);
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
    // The Ack control lives in the expanded region: reveal first — the
    // reveal itself must not touch the client (asserted below).
    const disclose = band.querySelector<HTMLButtonElement>('[data-control="disclose"]')!;
    disclose.click();
    const button = band.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:ack-me"][data-control="ack"]')!;
    // Honest consequence copy rides the expanded region (quota ack scope).
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
    expect(band.querySelector('[data-action-id="owner-ack:ack-me"][data-control="ack"]')).not.toBeNull();
    // Success → STILL pending until the authoritative snapshot lands.
    const okClient = stubClient();
    const view2 = new BoardView(() => {}, okClient);
    view2.render(snapshot({ notifications: [stop] }));
    document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('[data-control="disclose"]')!.click();
    const button2 = document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('[data-control="ack"]')!;
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
    // The older-pending count rides its own reserved numeric subpart.
    expect(more.querySelector<HTMLElement>('.board-band__more-num')?.textContent).toBe('3');
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
    const button = document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:focus-me"][data-control="disclose"]')!;
    button.focus();
    expect(document.activeElement).toBe(button);
    // A refresh of the SAME data re-renders the band: no new arrival, so
    // no toast — and the focused control keeps its place (same action id
    // AND same control kind, never a lookalike).
    view.render(snapshot({ notifications: [stop] }));
    expect(toast).not.toHaveBeenCalled();
    const refocused = document.getElementById('board-owner')!.querySelector<HTMLElement>('[data-action-id="owner-ack:focus-me"][data-control="disclose"]');
    expect(document.activeElement).toBe(refocused);
    expect((document.activeElement as HTMLElement)?.dataset.actionId).toBe('owner-ack:focus-me');
    expect((document.activeElement as HTMLElement)?.dataset.control).toBe('disclose');
  });

  it('rows disclose independently; reveal sends no request and changes no pending count', () => {
    const client = stubClient();
    const view = new BoardView(() => {}, client);
    const stops = [
      notification('row-a', { routing: 'needs-owner', kind: 'supervision.breaker' }),
      notification('row-b', { routing: 'needs-owner' }),
    ];
    view.render(snapshot({ notifications: stops }));
    // The mounted band starts hidden, so the FIRST render sees no visible
    // surface; the upgrade render below is the first that receives the
    // display receipt (pre-existing shown:true behavior — see the visible-
    // band receipt test above). Reveal itself must never add one.
    view.render(snapshot({ notifications: stops }));
    const band = document.getElementById('board-owner')!;
    const rows = [...band.querySelectorAll<HTMLElement>('.board-owner__row')];
    const discloseA = rows[0]!.querySelector<HTMLButtonElement>('[data-control="disclose"]')!;
    const discloseB = rows[1]!.querySelector<HTMLButtonElement>('[data-control="disclose"]')!;
    // Collapsed by default: details hidden, aria-expanded false.
    for (const row of rows) {
      expect(row.querySelector<HTMLElement>('.board-owner__detail')?.hidden).toBe(true);
    }
    expect(discloseA.getAttribute('aria-expanded')).toBe('false');
    // Reveal row A only; rows disclose independently.
    discloseA.click();
    expect(discloseA.getAttribute('aria-expanded')).toBe('true');
    expect(rows[0]!.querySelector<HTMLElement>('.board-owner__detail')?.hidden).toBe(false);
    expect(rows[1]!.querySelector<HTMLElement>('.board-owner__detail')?.hidden).toBe(true);
    expect(discloseB.getAttribute('aria-expanded')).toBe('false');
    // Reveal is local only: no ack, no extra receipt, no count change.
    expect(client.ackNotification).not.toHaveBeenCalled();
    expect(client.markNotificationShown).toHaveBeenCalledTimes(2); // one web-board receipt per row, unchanged by reveal
    expect(band.querySelector('.board-band__count')?.textContent).toBe('2 pending');
    // The disclosure is a real button with aria wiring (native Enter/Space).
    expect(discloseA.tagName).toBe('BUTTON');
    expect(discloseA.getAttribute('aria-controls')).toMatch(/^fy-detail-\d+$/);
    // Unique accessible name per row (row title + stable action id).
    expect(discloseA.getAttribute('aria-label')).toBe('Review decision: Notice row-a (owner-ack:row-a)');
    expect(discloseB.getAttribute('aria-label')).toBe('Review decision: Notice row-b (owner-ack:row-b)');
  });

  it('rows that share a title still get distinct disclosure names (unique per action id)', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        notifications: [
          notification('dup-1', { routing: 'needs-owner', title: 'Repeated notice' }),
          notification('dup-2', { routing: 'needs-owner', title: 'Repeated notice' }),
        ],
      }),
    );
    const labels = [...document.getElementById('board-owner')!.querySelectorAll<HTMLElement>('[data-control="disclose"]')].map(
      (node) => node.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Review decision: Repeated notice (owner-ack:dup-1)',
      'Review decision: Repeated notice (owner-ack:dup-2)',
    ]);
    expect(new Set(labels).size).toBe(2);
  });

  it('the collapsed face stays short: title as Problem + typed Next step; full detail and consequence live expanded', () => {
    const view = new BoardView(() => {});
    const stop = notification('short-face', {
      routing: 'needs-owner',
      kind: 'supervision.provider-wall.a1.quota_exceeded',
      detail: 'the long original notice body',
    });
    view.render(snapshot({ notifications: [stop] }));
    const row = document.getElementById('board-owner')!.querySelector<HTMLElement>('.board-owner__row')!;
    const face = row.querySelector<HTMLElement>('.board-owner__face')!;
    // Face: supplied title + SHORT typed next step — no duplication, no
    // full consequence paragraph.
    expect(face.querySelector('.board-owner__title')?.textContent).toBe('Notice short-face');
    expect(face.textContent).toContain('Next step:');
    expect(face.textContent).toContain('Ack re-arms this worker.');
    expect(face.textContent).not.toContain('does NOT clear code/test/review holds');
    expect(face.textContent).not.toContain('the long original notice body');
    expect(face.textContent).not.toContain('owner ack owed');
    // Expanded: verbatim detail, timestamp/kind metadata, full consequence.
    row.querySelector<HTMLButtonElement>('[data-control="disclose"]')!.click();
    const detail = row.querySelector<HTMLElement>('.board-owner__detail')!;
    expect(detail.textContent).toContain('the long original notice body');
    expect(detail.textContent).toContain('does NOT clear code/test/review holds');
    expect(detail.textContent).toContain('kind supervision.provider-wall.a1.quota_exceeded');
    expect(detail.textContent).toContain('Reviewing never acks or approves');
    // PR face: title + readiness + OPEN PR + short next step; evidence expanded.
    view.render(
      snapshot({
        notifications: [],
        ownerPrs: [ownerPr('face-pr')],
      }),
    );
    const prRow = document.getElementById('board-owner')!.querySelector<HTMLElement>('.board-owner__row--pr')!;
    const prFace = prRow.querySelector<HTMLElement>('.board-owner__face')!;
    expect(prFace.querySelector('.board-owner__title')?.textContent).toBe('Heist face-pr');
    expect(prFace.textContent).toContain('ready for you');
    expect(prFace.textContent).toContain('Open the pull request on GitHub');
    expect(prFace.textContent).not.toContain('CI green');
    expect(prRow.querySelector('[data-control="disclose"]')?.getAttribute('aria-label')).toBe(
      'Review decision: Heist face-pr (owner-pr:face-pr)',
    );
    prRow.querySelector<HTMLButtonElement>('[data-control="disclose"]')!.click();
    expect(prRow.querySelector<HTMLElement>('.board-owner__detail')?.textContent).toContain('CI green');
  });

  it('an emptied band keeps focus inside the band (never <body>) when the focused row settles', () => {
    const view = new BoardView(() => {});
    const only = notification('only-row', { routing: 'needs-owner' });
    view.render(snapshot({ notifications: [only] }));
    const disclose = document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:only-row"][data-control="disclose"]')!;
    disclose.focus();
    expect(document.activeElement).toBe(disclose);
    view.render(snapshot({ notifications: [{ ...only, ackedAt: '2026-01-01T00:09:00.000Z' }] }));
    const band = document.getElementById('board-owner')!;
    expect(band.querySelector('.board-owner__row')).toBeNull();
    expect(band.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(band.querySelector('.board-band__head'));
    // The fallback anchor is itself recreated on every render: the NEXT
    // push must keep focus in the band too (the head is re-detected).
    view.render(snapshot({ notifications: [{ ...only, ackedAt: '2026-01-01T00:09:00.000Z' }] }));
    expect(band.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(band.querySelector('.board-band__head'));
    // And when rows RETURN while the head holds focus, focus moves to the
    // live control (the head is not a resting place once rows exist).
    view.render(snapshot({ notifications: [only] }));
    expect(document.activeElement).toBe(
      band.querySelector('[data-action-id="owner-ack:only-row"][data-control="disclose"]'),
    );
  });

  it('settling the focused row with rows remaining keeps focus on a remaining band control', () => {
    const view = new BoardView(() => {});
    const stay = notification('stay', { routing: 'needs-owner' });
    const leave = notification('leave', { routing: 'needs-owner' });
    view.render(snapshot({ notifications: [stay, leave] }));
    const leaveDisclose = document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:leave"][data-control="disclose"]')!;
    leaveDisclose.focus();
    view.render(snapshot({ notifications: [stay, { ...leave, ackedAt: '2026-01-01T00:09:00.000Z' }] }));
    const band = document.getElementById('board-owner')!;
    expect(band.querySelector('.board-band__more')).toBeNull();
    expect(document.activeElement).toBe(
      band.querySelector('[data-action-id="owner-ack:stay"][data-control="disclose"]'),
    );
  });

  it('keeps focus intentional when the older-pending control itself re-renders or disappears', () => {
    const view = new BoardView(() => {});
    const stops = Array.from({ length: 9 }, (_, i) =>
      notification(`m-${String(i).padStart(2, '0')}`, { routing: 'needs-owner', ts: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z` }),
    );
    view.render(snapshot({ notifications: stops }));
    document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('.board-band__more')!.focus();
    view.render(snapshot({ notifications: stops }));
    expect(document.activeElement).toBe(document.getElementById('board-owner')!.querySelector('.board-band__more'));
    document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('.board-band__more')!.click();
    // Activating the expander lands focus on the FIRST newly revealed row
    // (m-02; the six visible before expansion are m-08..m-03).
    expect(document.activeElement).toBe(
      document.getElementById('board-owner')!.querySelector('[data-action-id="owner-ack:m-02"][data-control="disclose"]'),
    );
  });

  it('region ids are allocated per action id — `a_b` and `a-b` never collide', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        notifications: [
          notification('a_b', { routing: 'needs-owner' }),
          notification('a-b', { routing: 'needs-owner' }),
        ],
      }),
    );
    const rows = [...document.getElementById('board-owner')!.querySelectorAll<HTMLElement>('.board-owner__row')];
    const controls = rows.map((row) => row.querySelector<HTMLButtonElement>('[data-control="disclose"]')!);
    const ids = controls.map((control) => control.getAttribute('aria-controls'));
    expect(ids[0]).not.toBe(ids[1]);
    expect(new Set(ids).size).toBe(2);
    // Distinct focus targets and independent regions.
    controls[0]!.click();
    controls[1]!.click();
    expect(rows[0]!.querySelector('.board-owner__detail')?.id).toBe(ids[0]);
    expect(rows[1]!.querySelector('.board-owner__detail')?.id).toBe(ids[1]);
    expect(rows[0]!.querySelector('.board-owner__detail')?.id).not.toBe(rows[1]!.querySelector('.board-owner__detail')?.id);
  });

  it('disclosure state and focus survive a snapshot push; a settled row retires without disturbing the others', () => {
    const view = new BoardView(() => {});
    const stopA = notification('keep-a', { routing: 'needs-owner' });
    const stopB = notification('keep-b', { routing: 'needs-owner' });
    view.render(snapshot({ notifications: [stopA, stopB] }));
    const rowsBefore = [...document.getElementById('board-owner')!.querySelectorAll<HTMLElement>('.board-owner__row')];
    const discloseA = rowsBefore[0]!.querySelector<HTMLButtonElement>('[data-control="disclose"]')!;
    const discloseB = rowsBefore[1]!.querySelector<HTMLButtonElement>('[data-control="disclose"]')!;
    discloseA.click();
    discloseB.click();
    discloseA.focus();
    const idA = discloseA.getAttribute('aria-controls');
    const idB = discloseB.getAttribute('aria-controls');
    // A new snapshot re-renders: both stay expanded, A keeps focus, ids stable.
    view.render(snapshot({ notifications: [stopA, stopB] }));
    const rowsAfter = [...document.getElementById('board-owner')!.querySelectorAll<HTMLElement>('.board-owner__row')];
    const afterA = rowsAfter[0]!.querySelector<HTMLButtonElement>('[data-control="disclose"]')!;
    const afterB = rowsAfter[1]!.querySelector<HTMLButtonElement>('[data-control="disclose"]')!;
    expect(afterA.getAttribute('aria-expanded')).toBe('true');
    expect(afterB.getAttribute('aria-expanded')).toBe('true');
    expect(afterA.getAttribute('aria-controls')).toBe(idA);
    expect(afterB.getAttribute('aria-controls')).toBe(idB);
    expect(rowsAfter[0]!.querySelector<HTMLElement>('.board-owner__detail')?.hidden).toBe(false);
    expect(document.activeElement).toBe(afterA);
    // B settles (acked) and leaves the owner list while A STAYS pending:
    // A's identity, state and region survive; B's retire.
    view.render(
      snapshot({ notifications: [stopA, { ...stopB, ackedAt: '2026-01-01T00:09:00.000Z' }] }),
    );
    const rowsFinal = [...document.getElementById('board-owner')!.querySelectorAll<HTMLElement>('.board-owner__row')];
    expect(rowsFinal).toHaveLength(1);
    const finalA = rowsFinal[0]!.querySelector<HTMLButtonElement>('[data-control="disclose"]')!;
    expect(finalA.getAttribute('aria-controls')).toBe(idA);
    expect(finalA.getAttribute('aria-expanded')).toBe('true');
    expect(rowsFinal[0]!.querySelector<HTMLElement>('.board-owner__detail')?.hidden).toBe(false);
    // B returns as a NEW pending row: the retired identity is gone, so the
    // fresh row starts collapsed and allocates a NEW region id — never a
    // resurrected lookalike carrying the dead row's state.
    view.render(snapshot({ notifications: [stopA, stopB] }));
    const readdedB = document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:keep-b"][data-control="disclose"]')!;
    expect(readdedB.getAttribute('aria-controls')).not.toBe(idB);
    expect(readdedB.getAttribute('aria-expanded')).toBe('false');
    expect(readdedB.closest('.board-owner__row')?.querySelector<HTMLElement>('.board-owner__detail')?.hidden).toBe(true);
  });

  it('a row pushed OUTSIDE the older-pending window keeps its identity and disclosure state', () => {
    const view = new BoardView(() => {});
    const stops = Array.from({ length: 6 }, (_, i) =>
      notification(`win-${String(i).padStart(2, '0')}`, { routing: 'needs-owner', ts: `2026-01-01T00:0${i}:00.000Z` }),
    );
    view.render(snapshot({ notifications: stops }));
    const band = document.getElementById('board-owner')!;
    expect(band.querySelectorAll('.board-owner__row')).toHaveLength(6);
    const target = band.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:win-00"][data-control="disclose"]')!;
    const hiddenId = target.getAttribute('aria-controls');
    target.click();
    target.focus();
    expect(target.getAttribute('aria-expanded')).toBe('true');
    // Newer obligations arrive: win-00 falls OUTSIDE the visible six.
    const newer = Array.from({ length: 3 }, (_, i) =>
      notification(`new-${i}`, { routing: 'needs-owner', ts: `2026-01-01T01:0${i}:00.000Z` }),
    );
    view.render(snapshot({ notifications: [...newer, ...stops] }));
    const bandAfter = document.getElementById('board-owner')!;
    expect(bandAfter.querySelectorAll('.board-owner__row')).toHaveLength(6);
    expect(bandAfter.querySelector('[data-action-id="owner-ack:win-00"]')).toBeNull(); // hidden by the window, not retired
    // The focused control fell OUT of the rendered window: focus moves to
    // the older-pending control, never silently to <body>.
    expect(document.activeElement).toBe(bandAfter.querySelector('.board-band__more'));
    // Reveal the older tail: the same row returns with retained id AND state.
    bandAfter.querySelector<HTMLButtonElement>('.board-band__more')!.click();
    const rows = [...document.getElementById('board-owner')!.querySelectorAll<HTMLElement>('.board-owner__row')];
    expect(rows).toHaveLength(9);
    const again = document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('[data-action-id="owner-ack:win-00"][data-control="disclose"]')!;
    expect(again.getAttribute('aria-controls')).toBe(hiddenId);
    expect(again.getAttribute('aria-expanded')).toBe('true');
  });

  it('explicit Ack and OPEN PR controls restore focus across a snapshot push', () => {
    const view = new BoardView(() => {});
    const ackNotice = notification('ack-focus', { routing: 'needs-owner' });
    // COMPLETE authoritative snapshots: both rows stay pending throughout —
    // no refresh drops the PR row.
    const state = () =>
      snapshot({
        notifications: [ackNotice],
        ownerPrs: [ownerPr('open-focus')],
      });
    view.render(state());
    const q = (sel: string): HTMLElement => document.getElementById('board-owner')!.querySelector<HTMLElement>(sel)!;
    // Reveal each row separately; capture ACTION-SPECIFIC region identities.
    q('[data-action-id="owner-ack:ack-focus"][data-control="disclose"]').click();
    q('[data-action-id="owner-pr:open-focus"][data-control="disclose"]').click();
    const ackRegion = q('[data-action-id="owner-ack:ack-focus"][data-control="disclose"]').closest('.board-owner__row')!.querySelector<HTMLElement>('.board-owner__detail')!;
    const prRegion = q('[data-action-id="owner-pr:open-focus"][data-control="disclose"]').closest('.board-owner__row')!.querySelector<HTMLElement>('.board-owner__detail')!;
    const ackId = ackRegion.id;
    const prId = prRegion.id;
    expect(ackId).not.toBe(prId);
    // Ack focus survives a complete-snapshot refresh.
    q('[data-action-id="owner-ack:ack-focus"][data-control="ack"]').focus();
    view.render(state());
    expect(document.activeElement).toBe(q('[data-action-id="owner-ack:ack-focus"][data-control="ack"]'));
    // OPEN PR focus survives too, and BOTH regions keep their stable,
    // distinct, still-revealed identities.
    q('[data-action-id="owner-pr:open-focus"][data-control="open"]').focus();
    view.render(state());
    expect(document.activeElement).toBe(q('[data-action-id="owner-pr:open-focus"][data-control="open"]'));
    const bandNow = document.getElementById('board-owner')!;
    expect(bandNow.querySelector<HTMLElement>(`#${ackId}`)?.hidden).toBe(false);
    expect(bandNow.querySelector<HTMLElement>(`#${prId}`)?.hidden).toBe(false);
    expect(bandNow.querySelectorAll(`#${ackId}`)).toHaveLength(1);
    expect(bandNow.querySelectorAll(`#${prId}`)).toHaveLength(1);
  });

  it('band and bell PR rows are surface-scoped: one region id, no disclosure in the panel', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ notifications: [], ownerPrs: [ownerPr('dual-surface')] }));
    const band = document.getElementById('board-owner')!;
    const bandRegion = band.querySelector<HTMLElement>('.board-owner__row--pr .board-owner__detail')!;
    const bandDisclose = band.querySelector<HTMLButtonElement>('[data-action-id="owner-pr:dual-surface"][data-control="disclose"]')!;
    expect(bandDisclose.getAttribute('aria-controls')).toBe(bandRegion.id);
    // Bell panel: same projection, PRIOR presentation, no second region.
    (document.getElementById('notification-bell') as HTMLButtonElement).click();
    const panelRow = document.getElementById('notification-list')!.querySelector<HTMLElement>('.board-owner__row--pr')!;
    expect(panelRow.classList.contains('board-owner__row--panel')).toBe(true);
    expect(panelRow.querySelector('.board-owner__disclose')).toBeNull();
    expect(panelRow.querySelector('.board-owner__detail')).toBeNull();
    expect(panelRow.textContent).toContain('CI green'); // prior inline evidence
    expect(panelRow.querySelector<HTMLAnchorElement>('[data-control="open"]')?.dataset.actionId).toBe('owner-pr:dual-surface');
    // Exactly ONE region with that id exists in the whole document.
    expect(document.querySelectorAll(`#${bandRegion.id}`)).toHaveLength(1);
    // No cross-surface ambiguity: the band refocus path only ever searches
    // the band mount, and the panel row carries no region target.
    bandDisclose.focus();
    view.render(snapshot({ notifications: [], ownerPrs: [ownerPr('dual-surface')] }));
    expect(document.activeElement).toBe(
      document.getElementById('board-owner')!.querySelector<HTMLButtonElement>('[data-action-id="owner-pr:dual-surface"][data-control="disclose"]'),
    );
    // Panel fail-closed branch: an unsafe URL never becomes a link there
    // either (browser defense-in-depth; the server refuses it first).
    view.render(snapshot({ notifications: [], ownerPrs: [ownerPr('bad-panel', { prUrl: 'javascript:alert(1)' })] }));
    const badPanel = document.getElementById('notification-list')!.querySelector<HTMLElement>('.board-owner__row--pr');
    expect(badPanel?.classList.contains('board-owner__row--panel')).toBe(true);
    expect(badPanel?.querySelector('a')).toBeNull();
    expect(badPanel?.textContent).toContain('PR link unavailable');
  });

  it('g10: an owner row already acked on another device arrives with no toast and no web-toast receipt', () => {
    const toast = vi.fn();
    const client = stubClient();
    const view = new BoardView(() => {}, client);
    view.setToastHandler(toast);
    view.render(snapshot({ notifications: [] })); // first snapshot primes history: nothing toasts yet
    const acked = notification('acked-elsewhere', { routing: 'needs-owner', ackedAt: '2026-01-01T00:05:00.000Z' });
    view.render(snapshot({ notifications: [acked] }));
    expect(toast).not.toHaveBeenCalled();
    expect(client.markNotificationShown).not.toHaveBeenCalledWith('acked-elsewhere', 'web-toast');
    // Scoped to handled rows: a fresh owner arrival in the same push still toasts.
    view.render(snapshot({ notifications: [acked, notification('fresh-owner', { routing: 'needs-owner' })] }));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ id: 'fresh-owner' }));
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

  it('terminal machine receipts stay in FEED while terminal-bound owner stops and ready PRs keep FOR YOU parity', () => {
    for (const status of ['merged', 'done']) {
      const client = stubClient();
      const view = new BoardView(() => {}, client);
      const machine = notification('closed-machine', { agentId: 'minion-closed' });
      const owner = notification('owner-stop', { routing: 'needs-owner', agentId: 'minion-closed' });
      view.render(snapshot({
        jobs: [baseJob({ id: 'closed', status, rounds: [] })],
        agents: [agent('minion-closed', { role: 'minion', jobId: 'closed' })],
        notifications: [machine, owner, notification('live-global')],
        unackedActionRequired: 1,
        unackedNeedsOwner: 1,
        ownerPrs: [ownerPr('ready')],
      }));

      const band = document.getElementById('board-owner')!;
      expect(band.querySelector('.board-band__count')?.textContent, status).toBe('2 pending');
      expect(band.querySelector('[data-action-id="owner-ack:owner-stop"]')).not.toBeNull();
      expect(band.querySelector('[data-action-id="owner-pr:ready"]')).not.toBeNull();
      const sections = [...document.querySelectorAll('.board-notification-section')];
      const section = (label: string) => sections.find((node) =>
        node.querySelector('.board-notification-section__head')?.textContent === label,
      )!;
      expect(section('FOR YOU').textContent).toContain('Notice owner-stop');
      expect(section('FOR YOU').querySelector('.board-owner__open')).not.toBeNull();
      expect(section('NEEDS GRU').textContent).toContain('Notice live-global');
      expect(section('NEEDS GRU').textContent).not.toContain('Notice closed-machine');
      expect(section('FEED').querySelector('[data-receipt="closed"]')?.textContent).toContain('Notice closed-machine');
      expect(section('FEED').querySelector('.board-notification__ack')).toBeNull();
      expect(document.getElementById('board-unacked')?.textContent).toContain('1 needs Gru');
      expect(document.querySelector('.board-band--needs-you .board-job')).toBeNull();
      expect(client.ackNotification).not.toHaveBeenCalled();
      expect(machine.ackedAt).toBeNull();
      expect(machine.resolvedAt).toBeNull();
      expect(owner.ackedAt).toBeNull();
      expect(owner.resolvedAt).toBeNull();
    }
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
    // One shared clock for every recency input: updatedAt carries the
    // intended strict 60s ordering while agent activity and lane age stay
    // strictly older, so jobRecency can never tie at `now - 2m` (the
    // baseJob default let wall-clock drift reorder the band).
    const now = Date.now();
    const jobs = Array.from({ length: 6 }, (_, index) =>
      baseJob({
        id: `flight-${index}`,
        status: 'in-review',
        updatedAt: new Date(now - index * 60_000).toISOString(),
        lastAgentActivity: new Date(now - 24 * 3_600_000).toISOString(),
        lane: {
          branch: `gru/flight-${index}`,
          sha: 'abc1234deadbeef',
          status: 'active',
          createdAt: new Date(now - 48 * 3_600_000).toISOString(),
        },
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

describe('board v6 — one worker-aware derivation for strip and sections (Perkins r1 blockers 6-7)', () => {
  beforeEach(mountBoardDom);

  it('a fresh minion on an old lane counts In flight in BOTH the strip and the section', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'old-lane-fresh-worker',
            status: 'working',
            rounds: [],
            lastAgentActivity: new Date(Date.now() - 90 * 60_000).toISOString(),
          }),
        ],
        agents: [
          agent('minion-fresh', {
            role: 'minion',
            jobId: 'old-lane-fresh-worker',
            state: 'streaming',
            lastActivity: new Date().toISOString(),
          }),
        ],
      }),
    );
    // The live-worker stamp keeps the lane on the stall clock's floor:
    // In flight (no alert) in the section rows AND the strip count.
    const row = document.querySelector<HTMLElement>('.board-band--in-flight .board-job');
    expect(row?.getAttribute('data-job-id')).toBe('old-lane-fresh-worker');
    expect(row?.querySelector('.board-job__stale')).toBeNull();
    expect(document.querySelector<HTMLElement>('.board-nav__link[data-nav="in-flight"] .board-nav__count')?.textContent).toBe('1');
    expect(document.querySelector<HTMLElement>('.board-nav__link[data-nav="cold"] .board-nav__count')?.textContent).toBe('0');
  });

  it('focus falls to the section shortcut when the disclosure it was on disappears (count drop)', () => {
    const view = new BoardView(() => {});
    const entry = (index: number): Record<string, unknown> => ({
      id: `pipe-${index}`,
      repo: 'demo',
      title: `Queued ${index}`,
      priority: 5,
      enqueueSeq: index,
      state: 'waiting',
      reason: null,
      queuedAt: '2026-01-01T00:00:00.000Z',
    });
    const six = Array.from({ length: 6 }, (_, index) => entry(index + 1));
    view.render(snapshot({ jobs: [], pipeline: { entries: six as never, pending: 6 } }));
    const toggle = document.querySelector<HTMLElement>('.board-band--pipeline .board-band__more');
    expect(toggle?.dataset.focusKey).toBe('section:pipeline');
    toggle?.focus();
    expect(document.activeElement).toBe(toggle);
    // The next snapshot has five entries: the Show all toggle is gone.
    view.render(snapshot({ jobs: [], pipeline: { entries: six.slice(0, 5) as never, pending: 5 } }));
    const active = document.activeElement;
    expect(active).toBeInstanceOf(HTMLElement);
    expect((active as HTMLElement).classList.contains('board-nav__link')).toBe(true);
    expect((active as HTMLElement).getAttribute('data-nav')).toBe('pipeline');
  });

  it('focus falls to the section shortcut when the pipeline empties under the focused disclosure', () => {
    const view = new BoardView(() => {});
    const entry = (index: number): Record<string, unknown> => ({
      id: `pipe-${index}`,
      repo: 'demo',
      title: `Queued ${index}`,
      priority: 5,
      enqueueSeq: index,
      state: 'waiting',
      reason: null,
      queuedAt: '2026-01-01T00:00:00.000Z',
    });
    const six = Array.from({ length: 6 }, (_, index) => entry(index + 1));
    view.render(snapshot({ jobs: [], pipeline: { entries: six as never, pending: 6 } }));
    document.querySelector<HTMLElement>('.board-band--pipeline .board-band__more')?.focus();
    view.render(snapshot({ jobs: [], pipeline: { entries: [], pending: 0 } }));
    const active = document.activeElement;
    expect((active as HTMLElement).classList.contains('board-nav__link')).toBe(true);
    expect((active as HTMLElement).getAttribute('data-nav')).toBe('pipeline');
  });
});

describe('board v6 — snapshot-resolved focus fallback (Perkins r2 warning)', () => {
  beforeEach(mountBoardDom);

  it('a job moving into collapsed Cold focuses Cold — never the populated FOR GRU disclosure', () => {
    const view = new BoardView(() => {});
    const coldJob = {
      id: 'gone-cold',
      status: 'working' as const,
      rounds: [],
      lastAgentActivity: new Date(Date.now() - 90 * 60_000).toISOString(),
    };
    view.render(
      snapshot({
        jobs: [baseJob(coldJob)],
        agents: [
          agent('minion-moved', {
            role: 'minion',
            jobId: 'gone-cold',
            state: 'streaming',
            lastActivity: new Date().toISOString(),
          }),
        ],
      }),
    );
    const toggle = document.querySelector<HTMLElement>('.board-band--in-flight .board-job__toggle');
    expect(toggle).not.toBeNull();
    toggle?.focus();
    // Next push: gone-cold went silent-cold while an unrelated machine row
    // populates FOR GRU. Cold is count-only, so the focused row vanishes.
    view.render(
      snapshot({
        jobs: [
          baseJob({ ...coldJob }),
          baseJob({ id: 'machine-row', status: 'working', rounds: [] }),
        ],
        agents: [
          agent('minion-moved', {
            role: 'minion',
            jobId: 'gone-cold',
            state: 'streaming',
            lastActivity: new Date(Date.now() - 90 * 60_000).toISOString(),
          }),
          agent('minion-machine', {
            role: 'minion',
            jobId: 'machine-row',
            supervision: { state: 'stopped', restarts: 0, breakerOpen: true, stopReason: 'quota_wall' },
          }),
        ],
        notifications: [notification('n-machine', { agentId: 'minion-machine' })],
        unackedActionRequired: 1,
      }),
    );
    const active = document.activeElement;
    expect(active).toBeInstanceOf(HTMLElement);
    // The fallback must be COLD's own disclosure (or its shortcut) — the
    // old first-match fallback would land on the unrelated FOR GRU toggle.
    const coldToggle = document.querySelector<HTMLElement>('.board-band[data-section="cold"] .board-band__more');
    const forGruToggle = document.querySelector<HTMLElement>('.board-band[data-section="for-gru"] .board-band__more');
    expect(active).not.toBe(forGruToggle);
    const isColdToggle = active === coldToggle;
    const isColdNav = (active as HTMLElement).classList.contains('board-nav__link') &&
      (active as HTMLElement).getAttribute('data-nav') === 'cold';
    expect(isColdToggle || isColdNav).toBe(true);
  });

  it('a round control whose row is gone resolves its owning job section from the snapshot', () => {
    const view = new BoardView(() => {});
    const job = baseJob({
      id: 'round-owner',
      status: 'in-review',
      rounds: [baseRound({ id: 'r-owner', status: 'live' })],
    });
    view.render(snapshot({ jobs: [job] }));
    document.querySelector<HTMLElement>('.board-job__meta')?.click(); // expand rounds
    const roundToggle = document.querySelector<HTMLElement>('.board-round__toggle');
    expect(roundToggle?.dataset.focusKey).toBe('round:r-owner');
    roundToggle?.focus();
    // The job moves to collapsed Cold: the round control is gone.
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'round-owner',
            status: 'working',
            rounds: [baseRound({ id: 'r-owner', status: 'live' })],
            lastAgentActivity: new Date(Date.now() - 90 * 60_000).toISOString(),
          }),
        ],
        agents: [
          agent('minion-round', {
            role: 'minion',
            jobId: 'round-owner',
            state: 'streaming',
            lastActivity: new Date(Date.now() - 90 * 60_000).toISOString(),
          }),
        ],
      }),
    );
    const active = document.activeElement;
    expect(active).toBeInstanceOf(HTMLElement);
    expect(active?.tagName).toBe('BUTTON');
    expect((active as HTMLElement).className).toContain('board-band__more');
    expect((active as HTMLElement).closest('.board-band')?.getAttribute('data-section')).toBe('cold');
  });
});
