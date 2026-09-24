/**
 * Board view (E6): the live dashboard. v6 ("the cockpit") renders the
 * board as a DENSE ROW LIST, not a card grid: one single-line row pair
 * per job, sticky attention-band separators, inline disclosure.
 *
 * The surface stack:
 *   - the status chip rail (v4 health row relocated; `board-rail.ts`)
 *     under the command bar carries whole-system state incl. the folded
 *     jobs/PRs/lane counts and the Jev/unacked trackers;
 *   - attention-bucketed job rows (NEEDS GRU / IN FLIGHT / SETTLED /
 *     COLD) with sticky headers and counts;
 *   - the agents/transcripts rail (tabs, dense rows, disposed overflow);
 *   - the notification center (bell + panel).
 *
 * v3 semantics survive the redesign: rows collapse to their summary face
 * and expand inline; actionable state (unacked action-required, failed or
 * aborted rounds) rides the collapsed face. v4.1's rolling settled window
 * (latest 10 + expand footer, stale pills suppressed on concluded jobs)
 * is carried here; the v5 fill/hover restraint stays.
 */

import {
  agentStateTone,
  jobChipTone,
  jobStatusTone,
  lensChipTone,
  type AgentView,
  type BoardSnapshot,
  type JobView,
  type NotificationView,
  type RoundView,
} from '../lib/board-protocol.js';
import { loadExpandedJobs, saveExpandedJobs } from '../lib/board-collapse.js';
import {
  BAND_LABELS,
  BAND_ORDER,
  bucketSnapshot,
  settledWindow,
  type BandId,
} from '../lib/board-bands.js';
import { railChips, type RailChip } from '../lib/board-rail.js';
import { formatAge } from '../lib/board-time.js';
import { jobSignal, pluralCount, roundSummary, unackedByJob } from '../lib/board-signals.js';
import type { BoardClient } from '../lib/board-client.js';
import type { StorageLike } from '../theme.js';
import { DECISION_LABELS, decisionChipTone } from './decisions-status.js';
import { el, mustGet } from './dom.js';

const ROLE_EMOJI: Readonly<Record<string, string>> = {
  gru: '🧠',
  silas: '📋',
  minion: '🔧',
  perkins: '🔍',
  bob: '🌙',
};

const LENS_STATE_LABEL: Readonly<Record<string, string>> = {
  pending: '○',
  live: '◉',
  done: '✓',
  error: '✕',
};

export interface TranscriptOpenRequest {
  readonly file: string;
  readonly label: string;
}

export class BoardView {
  private readonly mount: HTMLElement;
  private readonly chipRail: HTMLElement;
  private readonly agentsCount: HTMLElement;
  private readonly notificationBell: HTMLButtonElement;
  private readonly notificationBadge: HTMLElement;
  private readonly notificationPanel: HTMLElement;
  private readonly decisionsChip: HTMLElement;
  private readonly unackedChip: HTMLElement;
  private readonly wakesChip: HTMLElement;
  private readonly onOpenTranscript: (request: TranscriptOpenRequest) => void;
  /** v3: collapsed-by-default job rows. The expanded set loads once from
   * the injected storage (null = session-only) and persists on every
   * operator toggle; a snapshot push re-reads it and never auto-expands. */
  private readonly collapseStorage: StorageLike | null;
  private readonly expandedJobs: Set<string>;
  /** Rounds whose lens chips the operator revealed (transient per view). */
  private readonly expandedRounds = new Set<string>();
  /** Unique aria-controls ids for lazily built bodies / lens-chip rows. */
  private nextRegionId = 0;
  /** Disposed rows are collapsed by default; the toggle state survives
   * snapshot pushes so a live board does not re-open the graveyard. */
  private disposedExpanded = false;
  /** Age counters (lane age, round elapsed, streaming turn age): registered
   * per render and refreshed by one shared ticker. */
  private readonly ageNodes = new Set<HTMLElement>();
  private ageTimer: ReturnType<typeof setInterval> | null = null;
  /** E7: notification receipts + acks ride the board client (optional —
   * the mock feed carries ack-ready rows without a client; rebound on
   * re-pair). */
  private boardClient: BoardClient | null;
  /** Toast + browser-notification surface (E7). */
  private onToast: ((notification: NotificationView) => void) | null = null;
  private snapshot: BoardSnapshot | null = null;
  /** Owner notification ids seen in the panel; every pending owner stop,
   * including informational destructive-op asks, earns a bell badge. */
  private readonly seenOwnerIds = new Set<string>();
  /** E7: display receipts already sent (id → surfaces sent). */
  private readonly sentShown = new Map<string, Set<string>>();
  /** E7: notification ids previously seen (new arrivals toast). */
  private readonly knownNotificationIds = new Set<string>();
  /** v4.1/v5: the SETTLED rolling window — expanded for this session only. */
  private settledExpanded = false;
  /** v5: job ids already on screen (new rows slide in; old ones do not). */
  private readonly knownJobIds = new Set<string>();
  private firstJobsRender = true;

  constructor(
    onOpenTranscript: (request: TranscriptOpenRequest) => void,
    boardClient: BoardClient | null = null,
    collapseStorage: StorageLike | null = null,
  ) {
    this.mount = mustGet('board-jobs');
    this.chipRail = mustGet('chip-rail');
    this.agentsCount = mustGet('rail-agents-count');
    this.notificationBell = mustGet<HTMLButtonElement>('notification-bell');
    this.notificationBadge = mustGet('notification-badge');
    this.notificationPanel = mustGet('notification-panel');
    this.decisionsChip = mustGet('board-decisions');
    this.unackedChip = mustGet('board-unacked');
    this.wakesChip = mustGet('board-wakes');
    this.onOpenTranscript = onOpenTranscript;
    this.boardClient = boardClient;
    this.collapseStorage = collapseStorage;
    this.expandedJobs = collapseStorage === null ? new Set() : loadExpandedJobs(collapseStorage);
    this.notificationBell.addEventListener('click', () => {
      this.notificationPanel.hidden = !this.notificationPanel.hidden;
      this.notificationBell.dataset.open = String(!this.notificationPanel.hidden);
      if (!this.notificationPanel.hidden) {
        // Opening the panel proves display of every current row: mark
        // seen (badge) AND send one receipt per surface (shown:true).
        for (const notification of this.snapshot?.notifications ?? []) {
          if (notification.routing === 'needs-owner') {
            this.seenOwnerIds.add(notification.id);
          }
          this.sendShown(notification, 'web-panel');
        }
        this.updateBadge(this.snapshot?.notifications ?? []);
      }
    });
  }

  /** E7: wire the live toast surface (main wires toasts + browser
   * notifications after construction). */
  setToastHandler(handler: (notification: NotificationView) => void): void {
    this.onToast = handler;
  }

  /** E7: bind the board client (receipts + acks) — rebound on re-pair. */
  bindClient(client: BoardClient): void {
    this.boardClient = client;
    this.sentShown.clear();
  }

  render(snapshot: BoardSnapshot): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    this.renderRail(snapshot);
    this.renderJobs(snapshot);
    this.renderAgents(snapshot.agents);
    this.renderNotifications(snapshot.notifications);
    this.surfaceNewNotifications(previous, snapshot.notifications);
  }

  // ------------------------------------------------------------------
  // Status chip rail (v6: the v4 health row, relocated + counts folded)
  // ------------------------------------------------------------------

  /** The global rail: seven chips — deploy → reviews → silas → alerts →
   * verify → cure → trackers. Same snapshot as the rows below, so the
   * rail can never disagree with the board. */
  private renderRail(snapshot: BoardSnapshot): void {
    this.chipRail.hidden = false;
    this.renderTrackers(snapshot);
    this.chipRail.replaceChildren();
    for (const chip of railChips(snapshot)) {
      this.chipRail.append(chip.id === 'trackers' ? this.trackersChipNode(chip) : this.railChipNode(chip));
    }
  }

  private railChipNode(chip: RailChip): HTMLElement {
    const node = el('span', `rail-chip rail-chip--${chip.tone}`);
    node.dataset.chip = chip.id;
    node.title = chip.titleAttr;
    node.append(
      el('span', 'rail-chip__label', chip.label),
      el('span', 'rail-chip__value', chip.value),
    );
    if (chip.flag !== null) {
      node.append(el('span', 'pp-chip pp-chip--alert rail-chip__flag', chip.flag));
    }
    return node;
  }

  /** TRACKERS: the folded KPI count strips plus the Jev + unacked chips the
   * v4 tracker strip carried (their ids/behavior survive the move). */
  private trackersChipNode(chip: RailChip): HTMLElement {
    const node = el('span', `rail-chip rail-chip--trackers rail-chip--${chip.tone}`);
    node.dataset.chip = 'trackers';
    node.title = chip.titleAttr;
    node.append(el('span', 'rail-chip__label', chip.label));
    for (const group of chip.kpis ?? []) {
      const groupNode = el('span', 'rail-kpi');
      groupNode.title = group.title;
      const label = el('span', 'rail-kpi__label', group.label);
      if (group.total !== undefined) {
        const total = el('b', 'rail-kpi__total', String(group.total.value));
        total.dataset.kpi = group.total.kpi;
        total.title = group.total.title;
        label.append(document.createTextNode(' '), total);
      }
      groupNode.append(label);
      const nums = el('span', 'rail-kpi__nums');
      group.values.forEach((value, index) => {
        if (index > 0) nums.append(el('span', 'rail-kpi__sep', '/'));
        const number = el('span', 'rail-kpi__num', String(value.value));
        number.dataset.kpi = value.kpi;
        number.title = value.title;
        if (value.kpi === 'prs.conflicting' && value.value > 0) {
          number.classList.add('rail-kpi__num--alert');
        }
        nums.append(number);
      });
      groupNode.append(nums);
      node.append(groupNode);
    }
    node.append(this.decisionsChip, this.unackedChip, this.wakesChip);
    return node;
  }

  // ------------------------------------------------------------------
  // Trackers: decisions chip + NEEDS GRU queue + wake count
  // ------------------------------------------------------------------

  private renderTrackers(snapshot: BoardSnapshot): void {
    const decisions = snapshot.decisions;
    this.decisionsChip.className = `pp-chip board-decisions ${decisionChipTone(decisions.status)}`;
    this.decisionsChip.dataset.state = decisions.status;
    this.decisionsChip.textContent = `Jev: ${DECISION_LABELS[decisions.status]}`;
    this.decisionsChip.title =
      decisions.status === 'ready'
        ? 'Decision routing is active (Jev triage).'
        : decisions.reason === null
          ? `Decision routing: ${decisions.status}.`
          : `Decision routing: ${decisions.status} (${decisions.reason}).`;
    // NEEDS GRU is the machine queue: action-required rows awaiting a
    // machine disposition. It never rings the owner bell — the FOR YOU
    // band (bell + toasts) is the only human-facing surface.
    const needsGru = snapshot.unackedActionRequired;
    this.unackedChip.hidden = needsGru === 0;
    this.unackedChip.textContent = `🛠 ${needsGru} needs Gru`;
    this.unackedChip.title = `${needsGru} machine-attention notification${needsGru === 1 ? '' : 's'} awaiting a Gru disposition — the machine queue clears itself; the owner bell is not rung.`;
    // Wake tracker: every autonomous wake is a durable `gru.wake` event;
    // the count/last fire stamp makes the wake path visible on the board.
    const wakes = snapshot.wakes;
    this.wakesChip.hidden = wakes.count === 0;
    this.wakesChip.textContent = `⚡ ${wakes.count} wake${wakes.count === 1 ? '' : 's'}`;
    this.wakesChip.title =
      wakes.count === 0
        ? 'No autonomous Gru wakes yet.'
        : `${wakes.count} autonomous Gru wake turn${wakes.count === 1 ? '' : 's'} opened; last ${wakes.lastAt !== null ? formatTs(wakes.lastAt) : '—'}.`;
  }

  // ------------------------------------------------------------------
  // Client-side age counters
  // ------------------------------------------------------------------

  private ageNode(className: string, since: string | null, prefix = '', suffix = ''): HTMLElement {
    const node = el('span', className);
    node.dataset.since = since ?? '';
    node.dataset.prefix = prefix;
    node.dataset.suffix = suffix;
    this.refreshAge(node);
    this.ageNodes.add(node);
    return node;
  }

  private refreshAge(node: HTMLElement): void {
    const since = node.dataset.since !== undefined && node.dataset.since !== '' ? node.dataset.since : null;
    node.textContent = `${node.dataset.prefix ?? ''}${formatAge(since)}${node.dataset.suffix ?? ''}`;
  }

  private ensureAgeTicker(): void {
    if (this.ageTimer !== null) return;
    this.ageTimer = setInterval(() => {
      for (const node of this.ageNodes) {
        if (!node.isConnected) {
          this.ageNodes.delete(node);
          continue;
        }
        this.refreshAge(node);
      }
    }, 1_000);
  }

  get current(): BoardSnapshot | null {
    return this.snapshot;
  }

  // ------------------------------------------------------------------
  // Attention-bucketed dense job rows
  // ------------------------------------------------------------------

  /** Banded job rows: NEEDS GRU / IN FLIGHT / SETTLED / COLD, recency
   * within each band. Every band is a full-width row list; band headers
   * are sticky separators with counts, so the operator never loses the
   * band they are reading. NEEDS GRU is always on screen (its clear
   * state is information); SETTLED is a rolling window over its
   * recency-sorted tail (v4.1). */
  private renderJobs(snapshot: BoardSnapshot): void {
    this.mount.replaceChildren();
    if (snapshot.repos.length === 0 || snapshot.repos.every((repo) => repo.jobs.length === 0)) {
      const empty = el('div', 'board-empty');
      empty.append(
        el('div', 'board-empty__title', 'The board is quiet'),
        el(
          'div',
          'board-empty__hint',
          'Jobs land here once work is dispatched — the ledger is the record, this board is the window.',
        ),
      );
      this.mount.append(empty);
      return;
    }
    const unacked = unackedByJob(snapshot);
    const bands = bucketSnapshot(snapshot, { now: Date.now(), unackedByJob: unacked });
    const seenIds = new Set<string>();
    for (const band of BAND_ORDER) {
      const jobs = bands.find((group) => group.band === band)?.jobs ?? [];
      if (band !== 'needs-you' && jobs.length === 0) continue;
      const section = el('section', `board-band board-band--${band}`);
      const head = el('h2', 'board-band__head');
      head.append(
        el('span', 'board-band__label', BAND_LABELS[band]),
        el('span', 'board-band__count lbl', `${jobs.length} job${jobs.length === 1 ? '' : 's'}`),
      );
      section.append(head);
      if (band === 'needs-you' && jobs.length === 0) {
        section.append(this.clearNeedsYou());
      } else {
        const window = band === 'settled' ? settledWindow(jobs, this.settledExpanded) : { jobs, hidden: 0 };
        const rows = el('div', 'board-band__rows');
        for (const entry of window.jobs) {
          rows.append(this.jobRow(entry.job, unacked.get(entry.job.id) ?? 0, entry.stale, band));
        }
        section.append(rows);
        if (window.hidden > 0) {
          const more = el('button', 'board-band__more', `+${window.hidden} older settled`);
          more.type = 'button';
          more.setAttribute('aria-expanded', 'false');
          more.addEventListener('click', () => {
            this.settledExpanded = true;
            if (this.snapshot !== null) this.render(this.snapshot);
          });
          section.append(more);
        }
      }
      this.mount.append(section);
    }
    for (const group of bands) for (const entry of group.jobs) seenIds.add(entry.job.id);
    for (const id of seenIds) this.knownJobIds.add(id);
    this.firstJobsRender = false;
  }

  /** An empty NEEDS GRU band is good news, not absence: a calm green
   * satisfied state (never hidden, never a false alarm). */
  private clearNeedsYou(): HTMLElement {
    const node = el('div', 'board-band__clear');
    node.append(
      el('span', 'board-band__clear-mark', '✓'),
      el('div', 'board-band__clear-text', 'nothing needs Gru'),
      el('div', 'lbl board-band__clear-hint', 'the crew is on it'),
    );
    return node;
  }

  /**
   * One dense row. Line 1: status dot + chevron + title + (stale flag /
   * compact signal) + status chip, right-aligned. Line 2 (small, muted):
   * repo + branch + lane age + agent age + PR link. Clicking anywhere on
   * the summary expands the v3 detail inline — the row is never a card
   * until it is expanded. Error/failing rows carry the alert accent.
   */
  private jobRow(job: JobView, unackedActionRequired: number, stale: boolean, band: BandId): HTMLElement {
    const row = el('article', 'board-job');
    row.dataset.jobId = job.id;
    row.dataset.band = band;
    row.dataset.status = job.status;
    if (jobFailing(job)) row.classList.add('board-job--alert');
    // v5: a job that was not on screen slides in (8px); a snapshot push
    // re-rendering known rows stays still.
    if (!this.firstJobsRender && !this.knownJobIds.has(job.id)) {
      row.classList.add('board-job--enter');
    }

    const head = el('div', 'board-job__head');
    const toggle = el('button', 'board-job__toggle');
    toggle.type = 'button';
    const chevron = el('span', 'board-job__chevron', '▸');
    chevron.setAttribute('aria-hidden', 'true');
    const dot = el('span', `board-job__dot board-job__dot--${jobStatusTone(job.status)}`);
    dot.setAttribute('aria-hidden', 'true');
    const name = el('span', 'board-job__name', job.title);
    name.title = job.title;
    toggle.append(dot, chevron, name);
    if (stale) {
      const flag = el('span', 'pp-chip pp-chip--alert board-job__stale', 'stalled');
      flag.title = 'working with no agent frames past the stall window';
      toggle.append(flag);
    }
    const signal = jobSignal(job, unackedActionRequired);
    if (signal !== null) {
      const chip = el('span', `pp-chip board-job__signal pp-chip--${signal.tone}`, signal.label);
      chip.title = signal.title;
      toggle.append(chip);
    }
    toggle.append(el('span', `pp-chip board-job__status ${jobChipTone(job.status)}`, job.status));
    head.append(toggle);
    row.append(head);

    const meta = el('div', 'board-job__meta lbl');
    meta.append(el('span', 'board-job__repo', `📦 ${job.repo}`));
    if (job.lane !== null) {
      meta.append(el('span', 'board-job__branch', `🌿 ${job.lane.branch ?? 'detached'}`));
      meta.append(this.ageNode('board-job__age board-job__lane-age', job.lane.createdAt, 'lane ', ''));
      meta.append(this.ageNode('board-job__age board-job__agent-age', job.lastAgentActivity, 'agent ', ''));
    } else if (job.baseBranch !== null) {
      meta.append(el('span', 'board-job__branch', `⌂ ${job.baseBranch}`));
    }
    if (job.prUrl !== null) {
      const link = el('a', 'board-job__pr', 'PR ↗');
      link.href = job.prUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      // Opening the PR is not a disclosure gesture.
      link.addEventListener('click', (event) => event.stopPropagation());
      meta.append(link);
    }
    meta.title = `${job.repo}${job.lane !== null ? ` · ${job.lane.branch ?? 'detached'}` : ''} · ${job.id}`;
    row.append(meta);

    let body: HTMLElement | null = null;
    const setExpanded = (expanded: boolean, persist = true): void => {
      if (expanded) {
        body ??= this.jobBody(job);
        row.append(body);
        toggle.setAttribute('aria-controls', body.id);
      } else if (body !== null) {
        body.remove();
      }
      toggle.setAttribute('aria-expanded', String(expanded));
      row.dataset.expanded = String(expanded);
      chevron.textContent = expanded ? '▾' : '▸';
      if (persist) this.setJobExpanded(job.id, expanded);
    };
    const flip = (): void => setExpanded(row.dataset.expanded !== 'true');
    toggle.addEventListener('click', flip);
    // Whole-row click target for the summary face; interactive children
    // (PR link, controls) and the expanded body keep their own behavior.
    row.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('a, button, .board-job__body') !== null) return;
      flip();
    });
    setExpanded(this.expandedJobs.has(job.id), false);
    return row;
  }

  /** Expanded detail (the v2/v3 surface): lane strip, note, condensed
   * rounds. Concluded jobs (merged/done) suppress their round history
   * here — a merged job's aborted round is noise, not live state
   * (v4.1 stale-pill suppression). */
  private jobBody(job: JobView): HTMLElement {
    const body = el('div', 'board-job__body');
    this.nextRegionId += 1;
    body.id = `board-job-body-${this.nextRegionId}`;
    if (job.lane !== null) {
      const lane = el('div', 'board-lane');
      lane.append(
        el('span', 'pp-chip board-lane__branch', `🌿 ${job.lane.branch ?? 'detached'}`),
        el('span', 'board-lane__base lbl', `⌂ ${job.lane.sha.slice(0, 8)}`),
        this.ageNode('board-lane__age lbl', job.lane.createdAt, 'lane ', ''),
        this.ageNode('board-lane__activity lbl', job.lastAgentActivity, 'agent ', ''),
      );
      if (job.lane.status !== 'active') {
        lane.append(el('span', 'pp-chip pp-chip--park board-lane__status', job.lane.status));
      }
      body.append(lane);
    }
    if (job.note !== null && job.note !== '') body.append(el('div', 'board-job__note', job.note));
    const concluded = job.status === 'merged' || job.status === 'done';
    const rounds = concluded ? job.rounds.slice(-1) : job.rounds;
    for (const round of rounds) body.append(this.roundRow(round, concluded));
    if (concluded && rounds.length > 0) {
      body.append(el('div', 'lbl board-job__reviewed', 'review history on the ledger'));
    }
    return body;
  }

  /** One round header row: `round N` chip + status + verdict + lens
   * summary with failures counted inline. The per-lens chips are revealed
   * by clicking the row — seven near-identical pills per round were the
   * noise v3 removes, so they are never default-open. */
  private roundRow(round: RoundView, quiescent = false): HTMLElement {
    const roundRow = el('div', 'board-round');
    if (quiescent) roundRow.classList.add('board-round--quiescent');
    const summary = roundSummary(round);
    const toggle = el('button', 'board-round__toggle');
    toggle.type = 'button';
    const chevron = el('span', 'board-round__chevron', '▸');
    chevron.setAttribute('aria-hidden', 'true');
    toggle.append(
      el('span', 'pp-chip pp-chip--perkins', `round ${round.seq}`),
      el('span', 'lbl board-round__status', round.status),
    );
    if (round.verdict !== null) {
      toggle.append(el('span', 'lbl board-round__verdict', `· ${round.verdict}`));
    }
    toggle.append(el('span', 'lbl board-round__lens-progress', `${summary.done}/${summary.total} lenses`));
    if (summary.blockers > 0 && !quiescent) {
      toggle.append(
        el('span', 'pp-chip pp-chip--alert board-round__blockers', `⛔ ${pluralCount(summary.blockers, 'blocker')}`),
      );
    }
    if (summary.failures > 0 && !quiescent) {
      toggle.append(
        el('span', 'pp-chip pp-chip--alert board-round__failures', `✕ ${pluralCount(summary.failures, 'lens failure')}`),
      );
    }
    if (round.status === 'live' || round.status === 'pending') {
      toggle.append(this.ageNode('lbl board-round__elapsed', round.createdAt, '', ' elapsed'));
    }
    toggle.append(chevron);

    let chips: HTMLElement | null = null;
    const setExpanded = (expanded: boolean, remember = true): void => {
      if (remember) {
        if (expanded) this.expandedRounds.add(round.id);
        else this.expandedRounds.delete(round.id);
      }
      if (expanded) {
        chips ??= this.lensChips(round);
        roundRow.append(chips);
        toggle.setAttribute('aria-controls', chips.id);
      } else if (chips !== null) {
        chips.remove();
      }
      toggle.setAttribute('aria-expanded', String(expanded));
      chevron.textContent = expanded ? '▾' : '▸';
    };
    toggle.addEventListener('click', () => setExpanded(!this.expandedRounds.has(round.id)));
    roundRow.append(toggle);
    setExpanded(this.expandedRounds.has(round.id), false);
    return roundRow;
  }

  private lensChips(round: RoundView): HTMLElement {
    const chips = el('div', 'board-round__lenses');
    this.nextRegionId += 1;
    chips.id = `board-round-chips-${this.nextRegionId}`;
    const attempts = new Map(round.lensAttempts.map((entry) => [entry.lens, entry.attempts]));
    for (const chip of round.lenses) {
      const attemptCount = attempts.get(chip.lens) ?? 0;
      const node = el(
        'span',
        `pp-chip board-lens ${lensChipTone(chip.state)}${chip.verdict === 'blocker' ? ' board-lens--blocker' : ''}`,
        `${LENS_STATE_LABEL[chip.state] ?? '?'} ${chip.lens}${attemptCount > 1 ? ` ×${attemptCount}` : ''}`,
      );
      if (chip.verdict === 'blocker') node.title = chip.note ?? 'lens recorded a blocker';
      else if (chip.state === 'error') node.title = chip.note ?? 'lens errored';
      else if (attemptCount > 1) node.title = `${attemptCount} attempts`;
      chips.append(node);
    }
    return chips;
  }

  private setJobExpanded(jobId: string, expanded: boolean): void {
    if (expanded) this.expandedJobs.add(jobId);
    else this.expandedJobs.delete(jobId);
    if (this.collapseStorage !== null) saveExpandedJobs(this.collapseStorage, this.expandedJobs);
  }

  // ------------------------------------------------------------------
  // Agent rail (dense rows, tabs, disposed overflow)
  // ------------------------------------------------------------------

  private renderAgents(agents: readonly AgentView[]): void {
    const rail = mustGet('board-agents');
    rail.replaceChildren();
    this.ensureAgeTicker();
    const live = agents.filter((agent) => agent.state !== 'disposed');
    const disposed = agents.filter((agent) => agent.state === 'disposed');
    this.agentsCount.textContent = String(live.length);
    if (agents.length === 0) {
      rail.append(el('div', 'lbl', 'no agents yet'));
      return;
    }
    // Liveness-first order arrives from the server; disposed rows collapse
    // behind a toggle so the graveyard never crowds live work.
    for (const agent of live) rail.append(this.agentRow(agent, false));
    if (disposed.length > 0) {
      const toggle = el(
        'button',
        'board-agent-toggle',
        `${this.disposedExpanded ? '−' : '+'}${disposed.length} disposed`,
      );
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(this.disposedExpanded));
      toggle.addEventListener('click', () => {
        this.disposedExpanded = !this.disposedExpanded;
        this.renderAgents(agents);
        // The rail is max-height scrollable: reveal the disclosed row
        // instead of leaving it clipped below the fold.
        if (this.disposedExpanded) {
          rail.querySelector<HTMLElement>('.board-agent--disposed')?.scrollIntoView?.({ block: 'nearest' });
        }
      });
      rail.append(toggle);
      if (this.disposedExpanded) {
        for (const agent of disposed) rail.append(this.agentRow(agent, true));
      }
    }
  }

  /** One dense agent row: status dot, name + short hash, role·state
   * subline, right-aligned status chip. Error rows carry the alert
   * accent (tint + left border) so a fault never hides in the list. */
  private agentRow(agent: AgentView, disposed: boolean): HTMLElement {
    const row = el('button', `board-agent${disposed ? ' board-agent--disposed' : ''}`);
    row.type = 'button';
    row.dataset.state = agent.state;
    row.dataset.role = agent.role;
    if (agent.state === 'error') row.classList.add('board-agent--error');
    row.title =
      agent.sessionFile !== null
        ? `${agent.id} — open transcript`
        : `${agent.id} — no session file yet`;
    row.addEventListener('click', () => {
      if (agent.sessionFile !== null) {
        this.onOpenTranscript({ file: agent.sessionFile ?? '', label: agentLabel(agent) });
      }
    });
    const body = el('span', 'board-agent__body');
    const top = el('span', 'board-agent__top');
    top.append(
      el('span', 'board-agent__name', agentLabel(agent)),
      el('span', 'board-agent__hash lbl', agent.id.slice(0, 8)),
    );
    const subline = el('span', 'board-agent__sub lbl');
    subline.append(
      el('span', 'board-agent__emoji', ROLE_EMOJI[agent.role] ?? '🤖'),
      el('span', 'board-agent__role', `${agent.role} · ${agent.state}`),
    );
    // Turn-age counter: a streaming agent shows how long its current turn
    // has been quiet — the operator's "is it stuck?" glance.
    if (agent.state === 'streaming') {
      subline.append(this.ageNode('board-agent__age lbl', agent.lastActivity, '', ' quiet'));
    }
    // E7: supervision mark — a stopped (breaker-tripped) or restarting
    // agent carries its supervision state on the subline (the right chip
    // stays the single status surface the row reads on).
    if (agent.supervision !== null && agent.supervision !== undefined) {
      const supervision = agent.supervision;
      if (supervision.state === 'stopped' || supervision.state === 'restarting') {
        subline.append(
          el(
            'span',
            `board-agent__supervision ${supervision.state === 'stopped' ? 'board-agent__supervision--alert' : 'board-agent__supervision--warn'}`,
            supervision.state === 'stopped' ? '⛔ stopped' : '⏳ restarting',
          ),
        );
        row.title += ` · supervision: ${supervision.state} (${supervision.restarts} restarts)`;
      }
    }
    body.append(top, subline);
    row.append(el('span', 'board-agent__dot'), body);
    row.append(el('span', `pp-chip board-agent__state ${agentStateTone(agent.state)}`, agent.state));
    return row;
  }

  // ------------------------------------------------------------------
  // Notification center
  // ------------------------------------------------------------------

  private renderNotifications(notifications: readonly NotificationView[]): void {
    const list = mustGet('notification-list');
    list.replaceChildren();
    this.updateBadge(notifications);
    this.notificationBell.hidden = false;
    if (notifications.length === 0) {
      list.append(el('div', 'lbl', 'nothing needs attention'));
      return;
    }
    // Routing split (owner ruling 2026-09-23): FOR YOU is the only
    // human-facing band; NEEDS GRU is the self-clearing machine queue
    // (Gru dispositions, the owner bell stays quiet); everything else is
    // the standing feed.
    // A pre-disposition release could Ack machine rows. Those legacy rows
    // are closed receipts, not active NEEDS GRU work, even if unresolved.
    const unresolved = (item: NotificationView): boolean => item.resolvedAt === null && item.ackedAt === null;
    const forYou = notifications.filter((item) => item.routing === 'needs-owner' && unresolved(item));
    const needsGru = notifications.filter((item) => item.routing === 'action-required' && unresolved(item));
    const feed = notifications.filter(
      (item) => item.routing === 'fyi' || !unresolved(item),
    );
    this.renderNotificationSection(list, 'FOR YOU', forYou, 'nothing needs you');
    this.renderNotificationSection(list, 'NEEDS GRU', needsGru, 'machine queue is clear');
    if (feed.length > 0) this.renderNotificationSection(list, 'FEED', feed, null);
  }

  private renderNotificationSection(
    list: HTMLElement,
    label: string,
    rows: readonly NotificationView[],
    empty: string | null,
  ): void {
    const section = el('section', 'board-notification-section');
    section.append(el('div', 'board-notification-section__head lbl', label));
    if (rows.length === 0) {
      if (empty !== null) section.append(el('div', 'board-notification-section__empty lbl', empty));
    } else {
      for (const item of rows) section.append(this.notificationRow(item));
    }
    list.append(section);
  }

  private notificationRow(item: NotificationView): HTMLElement {
    const row = el('div', `board-notification board-notification--${item.severity}`);
    const icon = item.routing === 'needs-owner' ? '🔔' : item.routing === 'action-required' ? '🛠' : item.severity === 'error' ? '🚨' : 'ℹ️';
    row.append(
      el(
        'div',
        'board-notification__title',
        `${icon} ${item.title}${item.resolvedAt !== null ? ' · resolved' : item.ackedAt !== null ? ' ✓' : ''}`,
      ),
      el(
        'div',
        'board-notification__meta lbl',
        `${formatTs(item.ts)} · ${item.routing}${item.detail !== null && item.detail !== '' ? ` — ${item.detail}` : ''}`,
      ),
    );
    // Only an owner stop or FYI row has a human Ack/Mark seen control.
    // Gru records a machine disposition through the authenticated API
    // after acting; a human click must not silently clear NEEDS GRU.
    if (item.routing !== 'action-required' && item.ackedAt === null && item.resolvedAt === null) {
      const ack = document.createElement('button');
      ack.type = 'button';
      ack.className = 'board-notification__ack';
      ack.textContent = item.routing === 'fyi' ? 'Mark seen' : 'Ack';
      ack.addEventListener('click', () => {
        void this.boardClient
          ?.ackNotification(item.id)
          .then(() => {
            this.seenOwnerIds.add(item.id);
            ack.textContent = '✓';
            ack.disabled = true;
          })
          .catch(() => {
            /* the row re-renders on the next snapshot push */
          });
      });
      row.append(ack);
    }
    return row;
  }

  /**
   * E7: NEWLY-ARRIVED notifications earn the live surface — a toast +
   * browser notification + a shown receipt (nothing displayed is
   * unproven). History present at first render never toasts (the badge
   * + panel carry standing state; reloads must not re-tap the shoulder).
   */
  private surfaceNewNotifications(_previous: BoardSnapshot | null, notifications: readonly NotificationView[]): void {
    const firstRender = !this.notificationsInitialized;
    this.notificationsInitialized = true;
    for (const notification of notifications) {
      if (this.knownNotificationIds.has(notification.id)) continue;
      this.knownNotificationIds.add(notification.id);
      // Only needs-owner rings the shoulder; machine/fyi rows live in the
      // panel bands and reach Gru through the wake path instead.
      if (notification.routing !== 'needs-owner') continue;
      if (firstRender || notification.resolvedAt !== null) continue; // history/resolved — no toast spam
      this.onToast?.(notification);
      this.sendShown(notification, 'web-toast');
    }
  }

  private notificationsInitialized = false;

  /** One display receipt per (id, surface) — receipts never spam. The
   * server upgrades shown_at per surface, so a toast receipt never
   * suppresses a later panel receipt. */
  private sendShown(notification: NotificationView, surface: string): void {
    let surfaces = this.sentShown.get(notification.id);
    if (surfaces === undefined) {
      surfaces = new Set<string>();
      this.sentShown.set(notification.id, surfaces);
    }
    if (surfaces.has(surface)) return;
    surfaces.add(surface);
    void this.boardClient?.markNotificationShown(notification.id, surface).then((landed) => {
      if (!landed) surfaces.delete(surface); // retry on the next upgrade
    });
  }

  /** Badge = unacked needs-owner items not yet seen here, at ANY severity
   * (panel-open marks seen; an ack from ANY device clears it via ackedAt).
   * Machine (action-required) and FYI rows never count — they are not the
   * owner's shoulder. */
  private updateBadge(notifications: readonly { id: string; routing: string; severity: string; ackedAt: string | null; resolvedAt: string | null }[]): void {
    const unseen = notifications.filter(
      (n) =>
        n.routing === 'needs-owner' &&
        n.ackedAt === null &&
        n.resolvedAt === null &&
        !this.seenOwnerIds.has(n.id),
    ).length;
    this.notificationBell.dataset.unread = String(unseen);
    this.notificationBadge.textContent = String(unseen);
  }
}

/** A row is "failing" when the record itself says so: blocked/error
 * status, an aborted newest round, or errored lenses in a round that has
 * not posted a verdict. Conflicting-PR-only rows stay calm — the band
 * already shouts. */
export function jobFailing(job: JobView): boolean {
  if (job.status === 'blocked' || job.status === 'error') return true;
  const round = job.rounds.at(-1) ?? null;
  if (round === null) return false;
  if (round.status === 'aborted') return true;
  if (round.status !== 'verdict-posted' && round.lenses.some((lens) => lens.state === 'error')) return true;
  return false;
}

function agentLabel(agent: AgentView): string {
  if (agent.label !== null && agent.label !== '') return agent.label;
  return `${agent.role} · ${agent.id.slice(0, 12)}`;
}

function formatTs(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
