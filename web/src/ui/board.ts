/**
 * Board view (E6): the live dashboard — repo-grouped job cards with state
 * chips and per-lens round chips, the agent rail (the standing crew), and
 * the notification center. Read-only by design: authorship arrives with
 * the dispatch flow epic.
 *
 * v3: job cards are collapsed by default — title + status + one compact
 * signal + one meta line. Clicking the card expands v2's full detail
 * (lane strip, rounds whose lens chips reveal per round). The expanded
 * set persists per job; actionable state (unacked action-required
 * notifications, failed/aborted rounds) rides the collapsed face and is
 * never hidden by the collapse.
 *
 * v4: the board answers WHAT TO DO NEXT — a KPI strip (status/PR/lane
 * counts), a health row (deploy drift first), and attention-bucketed job
 * ordering (NEEDS YOU / IN FLIGHT / SETTLED / COLD) with recency inside
 * each band.
 */

import {
  agentStateTone,
  jobChipTone,
  lensChipTone,
  type AgentView,
  type BoardSnapshot,
  type JobView,
  type NotificationView,
  type RoundView,
} from '../lib/board-protocol.js';
import { loadExpandedJobs, saveExpandedJobs } from '../lib/board-collapse.js';
import { BAND_LABELS, bucketSnapshot, type BandedJob, type BandId } from '../lib/board-bands.js';
import { healthCards } from '../lib/board-health.js';
import { boardKpis } from '../lib/board-kpi.js';
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
  private readonly notificationBell: HTMLButtonElement;
  private readonly notificationBadge: HTMLElement;
  private readonly notificationPanel: HTMLElement;
  private readonly decisionsChip: HTMLElement;
  private readonly unackedChip: HTMLElement;
  private readonly onOpenTranscript: (request: TranscriptOpenRequest) => void;
  /** v3: collapsed-by-default job cards. The expanded set loads once from
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
  /** Error notification ids the user has already seen (panel opened with
   * them present) — the badge counts only UNSEEN errors. */
  private readonly seenErrorIds = new Set<string>();
  /** E7: display receipts already sent (id → surfaces sent). */
  private readonly sentShown = new Map<string, Set<string>>();
  /** E7: notification ids previously seen (new arrivals toast). */
  private knownNotificationIds = new Set<string>();

  constructor(
    onOpenTranscript: (request: TranscriptOpenRequest) => void,
    boardClient: BoardClient | null = null,
    collapseStorage: StorageLike | null = null,
  ) {
    this.mount = mustGet('board-jobs');
    this.notificationBell = mustGet<HTMLButtonElement>('notification-bell');
    this.notificationBadge = mustGet('notification-badge');
    this.notificationPanel = mustGet('notification-panel');
    this.decisionsChip = mustGet('board-decisions');
    this.unackedChip = mustGet('board-unacked');
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
          if (notification.severity === 'error') this.seenErrorIds.add(notification.id);
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
    this.renderKpis(snapshot);
    this.renderHealth(snapshot);
    this.renderTrackers(snapshot);
    this.renderRepos(snapshot);
    this.renderAgents(snapshot.agents);
    this.renderNotifications(snapshot.notifications);
    this.surfaceNewNotifications(previous, snapshot.notifications);
  }

  // ------------------------------------------------------------------
  // KPI strip + health row (v4)
  // ------------------------------------------------------------------

  /** The top-of-board strip: status counts, PR state, lane activity.
   * Every number is derived from the SAME snapshot the cards render, so
   * the strip can never disagree with the board below it. */
  private renderKpis(snapshot: BoardSnapshot): void {
    const mount = mustGet('board-kpis');
    mount.replaceChildren();
    const kpis = boardKpis(snapshot);
    mount.append(
      this.kpiGroup('Jobs', [
        { label: 'working', value: kpis.jobs.working },
        { label: 'in-review', value: kpis.jobs.inReview },
        { label: 'merged', value: kpis.jobs.merged },
        { label: 'done', value: kpis.jobs.done },
        { label: 'parked', value: kpis.jobs.parked },
      ], `${kpis.jobs.total} jobs on the board`),
      this.kpiGroup('PRs', [
        { label: 'open', value: kpis.prs.open },
        {
          label: 'conflicting',
          value: kpis.prs.conflicting,
          tone: kpis.prs.conflicting > 0 ? 'alert' : null,
        },
        { label: 'merged today', value: kpis.prs.mergedToday },
      ]),
      this.kpiGroup('Lanes', [
        { label: 'live minions', value: kpis.lanes.liveMinions },
        {
          label: 'mid-turn',
          value: kpis.lanes.midTurn,
          ageSince: kpis.lanes.midTurnOldestAt,
        },
        { label: 'disposed', value: kpis.lanes.disposed },
      ]),
    );
  }

  private kpiGroup(
    title: string,
    stats: readonly { label: string; value: number; tone?: 'alert' | null; ageSince?: string | null }[],
    titleAttr?: string,
  ): HTMLElement {
    const card = el('div', 'board-kpi pp-soft');
    const head = el('div', 'lbl board-kpi__title', title);
    if (titleAttr !== undefined) head.title = titleAttr;
    card.append(head);
    const row = el('div', 'board-kpi__row');
    for (const stat of stats) {
      const node = el(
        'span',
        `board-kpi__stat${stat.tone === 'alert' ? ' board-kpi__stat--alert' : ''}`,
      );
      node.append(
        el('b', 'board-kpi__value', String(stat.value)),
        el('span', 'board-kpi__label', stat.label),
      );
      if (stat.ageSince !== undefined && stat.ageSince !== null) {
        node.append(this.ageNode('board-kpi__age lbl', stat.ageSince, 'oldest ', ''));
      }
      row.append(node);
    }
    card.append(row);
    return card;
  }

  /** The slim health row: each card earned by a real incident; sources
   * not yet wired render `n/a` (never a fabricated zero). */
  private renderHealth(snapshot: BoardSnapshot): void {
    const mount = mustGet('board-health');
    mount.replaceChildren();
    for (const card of healthCards(snapshot)) {
      const node = el('div', `board-health__card pp-soft board-health__card--${card.tone}`);
      node.dataset.card = card.id;
      node.title = card.titleAttr;
      node.append(
        el('div', 'lbl board-health__title', card.title),
        el('div', 'board-health__value', card.value),
        el('div', 'lbl board-health__detail', card.detail),
      );
      if (card.flag !== null) {
        node.append(el('span', 'pp-chip pp-chip--alert board-health__flag', card.flag));
      }
      mount.append(node);
    }
  }

  // ------------------------------------------------------------------
  // Trackers: decisions chip + unacked action-required badge
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
    const unacked = snapshot.unackedActionRequired;
    this.unackedChip.hidden = unacked === 0;
    this.unackedChip.textContent = `🔔 ${unacked} action-required`;
    this.unackedChip.title = `${unacked} action-required notification${unacked === 1 ? '' : 's'} awaiting an ack`;
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
  // Repo-grouped job cards
  // ------------------------------------------------------------------

  /** Banded repo cards: NEEDS YOU / IN FLIGHT / SETTLED / COLD, recency
   * within each band. A repo's jobs can appear under several bands — the
   * repo card repeats with only the jobs in that band, so the operator
   * reads priority first and grouping second. */
  private renderRepos(snapshot: BoardSnapshot): void {
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
    for (const group of bands) {
      const section = el('section', `board-band board-band--${group.band}`);
      const head = el('h2', 'board-band__head');
      head.append(
        el('span', 'board-band__label', BAND_LABELS[group.band]),
        el('span', 'board-band__count lbl', `${group.jobs.length} job${group.jobs.length === 1 ? '' : 's'}`),
      );
      section.append(head);
      for (const repo of groupBandedByRepo(group.jobs)) {
        const card = el('section', 'pp-card board-repo reveal');
        const repoHead = el('div', 'board-repo__head');
        repoHead.append(
          el('h2', 'board-repo__name', `📦 ${repo.name}`),
          el('span', 'lbl', `${repo.jobs.length} job${repo.jobs.length === 1 ? '' : 's'}`),
        );
        card.append(repoHead);
        for (const entry of repo.jobs) {
          card.append(this.jobRow(entry.job, unacked.get(entry.job.id) ?? 0, entry.stale, group.band));
        }
        section.append(card);
      }
      this.mount.append(section);
    }
  }

  /** One collapsed-by-default card. Collapsed DOM is exactly: title +
   * status chip + optional stale flag + optional PR link + optional one
   * compact signal chip + one meta line. The detail body is built only
   * when expanded. */
  private jobRow(job: JobView, unackedActionRequired: number, stale: boolean, band: BandId): HTMLElement {
    const row = el('article', 'board-job');
    row.dataset.jobId = job.id;
    row.dataset.band = band;

    const head = el('div', 'board-job__head');
    const toggle = el('button', 'board-job__toggle');
    toggle.type = 'button';
    const chevron = el('span', 'board-job__chevron', '▸');
    chevron.setAttribute('aria-hidden', 'true');
    const name = el('span', 'board-job__name', job.title);
    name.title = job.title;
    toggle.append(
      chevron,
      name,
      el('span', `pp-chip board-job__status ${jobChipTone(job.status)}`, job.status),
    );
    if (stale) {
      const flag = el('span', 'pp-chip pp-chip--alert board-job__stale', 'stalled');
      flag.title = 'working with no agent frames past the stall window';
      toggle.append(flag);
    }
    head.append(toggle);
    if (job.prUrl !== null) {
      const link = el('a', 'board-job__pr', 'PR ↗');
      link.href = job.prUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      // Opening the PR is not a disclosure gesture.
      link.addEventListener('click', (event) => event.stopPropagation());
      head.append(link);
    }
    row.append(head);

    const signal = jobSignal(job, unackedActionRequired);
    if (signal !== null) {
      const chip = el('span', `pp-chip board-job__signal pp-chip--${signal.tone}`, signal.label);
      chip.title = signal.title;
      row.append(chip);
    }

    const meta = el('div', 'board-job__meta lbl');
    meta.textContent = `${job.id} · updated ${formatTs(job.updatedAt)}${job.baseBranch !== null ? ` · base ${job.baseBranch}` : ''}`;
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
      chevron.textContent = expanded ? '▾' : '▸';
      row.dataset.expanded = String(expanded);
      if (persist) this.setJobExpanded(job.id, expanded);
    };
    const flip = (): void => setExpanded(row.dataset.expanded !== 'true');
    toggle.addEventListener('click', flip);
    // Whole-card click target for the summary face; interactive children
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

  /** Expanded detail (the v2 surface): lane strip, note, condensed rounds. */
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
    for (const round of job.rounds) body.append(this.roundRow(round));
    return body;
  }

  /** One round header row: `round N` chip + status + verdict + lens
   * summary with failures counted inline. The per-lens chips are revealed
   * by clicking the row — seven near-identical pills per round were the
   * noise v3 removes, so they are never default-open. */
  private roundRow(round: RoundView): HTMLElement {
    const roundRow = el('div', 'board-round');
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
    if (summary.blockers > 0) {
      toggle.append(
        el('span', 'pp-chip pp-chip--alert board-round__blockers', `⛔ ${pluralCount(summary.blockers, 'blocker')}`),
      );
    }
    if (summary.failures > 0) {
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
  // Agent rail
  // ------------------------------------------------------------------

  private renderAgents(agents: readonly AgentView[]): void {
    const rail = mustGet('board-agents');
    rail.replaceChildren();
    this.ensureAgeTicker();
    if (agents.length === 0) {
      rail.append(el('div', 'lbl', 'no agents yet'));
      return;
    }
    // Liveness-first order arrives from the server; disposed rows collapse
    // behind a toggle so the graveyard never crowds live work.
    const live = agents.filter((agent) => agent.state !== 'disposed');
    const disposed = agents.filter((agent) => agent.state === 'disposed');
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

  private agentRow(agent: AgentView, disposed: boolean): HTMLElement {
    const row = el('button', `board-agent${disposed ? ' board-agent--disposed' : ''}`);
    row.type = 'button';
    row.title =
      agent.sessionFile !== null
        ? `${agent.id} — open transcript`
        : `${agent.id} — no session file yet`;
    row.addEventListener('click', () => {
      if (agent.sessionFile !== null) {
        this.onOpenTranscript({ file: agent.sessionFile ?? '', label: agentLabel(agent) });
      }
    });
    row.append(
      el('span', 'board-agent__emoji', ROLE_EMOJI[agent.role] ?? '🤖'),
      el('span', 'board-agent__name', agentLabel(agent)),
    );
    // Turn-age counter: a streaming agent shows how long its current turn
    // has been quiet — the operator's "is it stuck?" glance.
    if (agent.state === 'streaming') {
      row.append(this.ageNode('board-agent__age lbl', agent.lastActivity, '', ' quiet'));
    }
    row.append(el('span', `pp-chip board-agent__state ${agentStateTone(agent.state)}`, agent.state));
    // E7: supervision mark — a stopped (breaker-tripped) or restarting
    // agent shows its supervision state on the rail.
    if (agent.supervision !== null && agent.supervision !== undefined) {
      const supervision = agent.supervision;
      if (supervision.state === 'stopped' || supervision.state === 'restarting') {
        row.append(
          el(
            'span',
            `pp-chip board-agent__supervision ${supervision.state === 'stopped' ? 'pp-chip--alert' : 'pp-chip--work'}`,
            supervision.state === 'stopped' ? '⛔ stopped' : '⏳ restarting',
          ),
        );
        row.title += ` · supervision: ${supervision.state} (${supervision.restarts} restarts)`;
      }
    }
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
    for (const item of notifications) {
      const row = el('div', `board-notification board-notification--${item.severity}`);
      const icon = item.routing === 'action-required' ? '🔔' : item.severity === 'error' ? '🚨' : 'ℹ️';
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
      // Ack button: action-required rows clear through a human ack
      // (acking also re-arms a tripped breaker server-side). A resolved
      // incident no longer needs human action — no ack control, no badge,
      // no toast — but the durable row stays visible for the record.
      if (item.ackedAt === null && item.resolvedAt === null) {
        const ack = document.createElement('button');
        ack.type = 'button';
        ack.className = 'board-notification__ack';
        ack.textContent = item.routing === 'action-required' ? 'Ack' : 'Mark seen';
        ack.addEventListener('click', () => {
          void this.boardClient
            ?.ackNotification(item.id)
            .then(() => {
              this.seenErrorIds.add(item.id);
              ack.textContent = '✓';
              ack.disabled = true;
            })
            .catch(() => {
              /* the row re-renders on the next snapshot push */
            });
        });
        row.append(ack);
      }
      list.append(row);
    }
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

  /** Badge = unacked error-severity items not yet seen here (panel-open
   * marks seen; an ack from ANY device clears it via ackedAt). The number
   * is rendered — a literal "0" badge read as a false alert. */
  private updateBadge(notifications: readonly { id: string; severity: string; ackedAt: string | null; resolvedAt: string | null }[]): void {
    const unseen = notifications.filter(
      (n) => n.severity === 'error' && n.ackedAt === null && n.resolvedAt === null && !this.seenErrorIds.has(n.id),
    ).length;
    this.notificationBell.dataset.unread = String(unseen);
    this.notificationBadge.textContent = String(unseen);
  }
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

/** Re-group one band's recency-sorted jobs by repo (alphabetical repo
 * order); the band ordering carries priority, grouping stays legible. */
function groupBandedByRepo(jobs: readonly BandedJob[]): { name: string; jobs: readonly BandedJob[] }[] {
  const byRepo = new Map<string, BandedJob[]>();
  for (const entry of jobs) {
    const group = byRepo.get(entry.job.repo);
    if (group === undefined) byRepo.set(entry.job.repo, [entry]);
    else group.push(entry);
  }
  return [...byRepo.entries()]
    .map(([name, grouped]) => ({ name, jobs: grouped }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

