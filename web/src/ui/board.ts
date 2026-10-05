/**
 * Board view (E6): the live dashboard. v6 ("the cockpit") renders the
 * board as a DENSE ROW LIST, not a card grid: one single-line row pair
 * per job, sticky attention-band separators, inline disclosure.
 *
 * The surface stack:
 *   - the status chip rail (v4 health row relocated; `board-rail.ts`)
 *     under the command bar carries whole-system state incl. the labeled
 *     heist/PR/minion counts and the Jev/unacked trackers;
 *   - attention-bucketed job rows (NEEDS GRU / IN FLIGHT / SETTLED /
 *     COLD) with sticky headers and counts;
 *   - the crew rail (CREW/TRANSCRIPTS tabs, dense rows, disposed overflow);
 *   - the notification center (bell + panel).
 *
 * v3 semantics survive the redesign: rows collapse to their summary face
 * and expand inline; actionable state (unacked action-required, failed or
 * aborted rounds) rides the collapsed face. v4.1's rolling settled window
 * (latest 10 + expand footer, stale pills suppressed on concluded jobs)
 * is carried here; the v5 fill/hover restraint stays.
 */

import {
  agentActivityOf,
  agentRailBand,
  agentRuntimeOf,
  agentStateTone,
  agentStatusOf,
  hasRuntimeClassification,
  isCountedCrewAgent,
  isJobConcluded,
  jobChipTone,
  jobStatusTone,
  lensChipState,
  lensChipTone,
  type AgentView,
  type BoardSnapshot,
  type JobView,
  type NotificationView,
  type PipelineEntryView,
  type RoundView,
} from '../lib/board-protocol.js';
import { loadExpandedJobs, saveExpandedJobs } from '../lib/board-collapse.js';
import {
  BAND_LABELS,
  liveWorkerStampsByJob,
  stoppedWorkersByJob,
  workerStopLabel,
  type BandId,
  type BandedJob,
  type WorkerStopView,
} from '../lib/board-bands.js';
import {
  boardSections,
  inFlightWindow,
  pipelineStateLabel,
  pipelineStateTone,
  pipelineWindow,
  sectionNav,
  settledJobs,
  settledPreview,
  IN_FLIGHT_PREVIEW_SIZE,
  PIPELINE_PREVIEW_SIZE,
  SETTLED_PREVIEW_SIZE,
  type SectionId,
} from '../lib/board-sections.js';
import { railChips, type RailChip } from '../lib/board-rail.js';
import { BOARD_WORDS, heistCount } from '../lib/board-vocabulary.js';
import { formatAge } from '../lib/board-time.js';
import { prLinkLabel } from '../lib/pr-link.js';
import {
  jobSignal,
  pluralCount,
  roundSummary,
  terminalBoundNotificationIds,
  unackedByJob,
  type RoundSummary,
} from '../lib/board-signals.js';
import {
  ownerRows,
  ownerWindow,
  safePrUrl,
  type OwnerAckRow,
  type OwnerPrRow,
} from '../lib/owner-band.js';

/** Truthful lens progress for whole-PR rounds: show what actually ran —
 * including lenses that ran and failed — and name unused lenses instead of
 * counting them as coverage (R9). */
function lensProgressLabel(summary: RoundSummary): string {
  const parts = [`${summary.ran}/${summary.total} lenses ran`];
  if (summary.failures > 0) parts.push(`${summary.failures} failed`);
  if (summary.unused > 0) parts.push(`${summary.unused} not used`);
  if (parts.length === 1) {
    // Clean full-usage round keeps the compact historical label.
    return `${summary.done}/${summary.total} lenses`;
  }
  return parts.join(' · ');
}
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
  unused: '—',
};

export interface TranscriptOpenRequest {
  readonly file: string;
  readonly label: string;
}

export class BoardView {
  private readonly mount: HTMLElement;
  private readonly ownerMount: HTMLElement;
  private readonly boardNav: HTMLElement;
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
  /** The last rendered agent list (parent navigation resolves against it
   * and can expand a collapsed section before scrolling). */
  private lastAgents: readonly AgentView[] = [];
  /** Issue #171: verified-historical rows are collapsed behind their own
   * disclosure (past sessions), separate from the disposed graveyard;
   * the toggle state survives snapshot pushes. */
  private historyExpanded = false;
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
  /** ONE sections derivation per render (classification truth is shared
   * by the shortcut strip and the section bodies — computed from the SAME
   * stopped/live-worker inputs so they can never disagree). */
  private currentSections: ReturnType<typeof boardSections> | null = null;
  /** D3: older receipt pages fetched on demand (merged into FEED). */
  private extraReceipts: NotificationView[] = [];
  private receiptsNextOffset = 0;
  private receiptsLoading = false;
  private receiptsExhausted = false;
  /** Owner notification ids seen in the panel; every pending owner stop,
   * including informational destructive-op asks, earns a bell badge. */
  private readonly seenOwnerIds = new Set<string>();
  /** E7: display receipts already sent (id → surfaces sent). */
  private readonly sentShown = new Map<string, Set<string>>();
  /** E7: notification ids previously seen (new arrivals toast). */
  private readonly knownNotificationIds = new Set<string>();
  /** v4.1/v5: the SETTLED rolling window — now reversible (3-preview). */
  private settledExpanded = false;
  /** Compact section disclosures (owner approval j-1064): session state,
   * preserved across ordinary live snapshot pushes so a push never
   * reopens a section or resets the operator's view. */
  private inFlightExpanded = false;
  private pipelineExpanded = false;
  private forGruExpanded = false;
  private coldExpanded = false;
  /** v5: job ids already on screen (new rows slide in; old ones do not). */
  private readonly knownJobIds = new Set<string>();
  private firstJobsRender = true;
  /** FOR YOU: the older pending tail lives behind the expander
   * (session-expanded, like the SETTLED window). */
  private ownerExpanded = false;

  constructor(
    onOpenTranscript: (request: TranscriptOpenRequest) => void,
    boardClient: BoardClient | null = null,
    collapseStorage: StorageLike | null = null,
  ) {
    this.mount = mustGet('board-jobs');
    this.ownerMount = mustGet('board-owner');
    this.boardNav = mustGet('board-nav');
    // Splitter drags and chat collapse change the strip's width WITHOUT a
    // window resize; a wrapping strip changes height while the sticky
    // offsets would keep the prior measurement. Re-measure on actual size
    // changes (Perkins r3 warning). Absent in non-DOM test shims.
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => this.measureNav());
      observer.observe(this.boardNav);
    }
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
    // The strip's measured height feeds the sticky offsets; re-measure on
    // viewport changes so wrapped rows never cover a focused target.
    window.addEventListener('resize', () => this.measureNav());
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

  /** E7: bind the board client (receipts + acks) — rebound on re-pair.
   * Receipt paging is per-connection state: a re-pair must not surface the
   * previous server's fetched receipts or resume its pagination cursor. */
  bindClient(client: BoardClient): void {
    this.boardClient = client;
    this.sentShown.clear();
    this.extraReceipts = [];
    this.receiptsNextOffset = 0;
    this.receiptsExhausted = false;
    this.receiptsLoading = false;
  }

  render(snapshot: BoardSnapshot): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    // Focus preservation across live pushes: the control the operator was
    // on keeps its place (stable focus keys), so a snapshot update never
    // steals focus or resets a disclosure mid-interaction.
    const focusKey = this.captureFocusKey();
    this.currentSections = null; // one fresh derivation per render
    this.renderOwnerActions(snapshot);
    this.renderRail(snapshot);
    this.renderNav(snapshot);
    this.renderJobs(snapshot);
    this.restoreFocusKey(focusKey);
    this.renderAgents(snapshot.agents);
    this.renderNotifications(snapshot);
    this.surfaceNewNotifications(previous, snapshot.notifications);
  }

  // ------------------------------------------------------------------
  // Sticky section shortcut strip (owner approval j-1064)
  // ------------------------------------------------------------------

  /** One compact sticky row of labelled, uncapped counts that jumps to
   * each section. Every section always exists (empty sections carry a
   * compact empty state), so every shortcut has a valid labelled target. */
  private renderNav(snapshot: BoardSnapshot): void {
    // SAME worker-aware derivation as the section bodies (one source per
    // render): a fresh worker on an old lane moves the band in both the
    // counts and the rows, never in one alone.
    const sections = this.sectionsFor(snapshot);
    const nav = this.boardNav;
    nav.hidden = false;
    nav.replaceChildren();
    for (const row of sectionNav(sections.counts, sections.pipelineAvailable)) {
      const link = document.createElement('a');
      link.className = 'board-nav__link';
      link.href = row.href;
      link.dataset.nav = row.id;
      link.dataset.focusKey = `nav:${row.id}`;
      link.append(
        el('span', 'board-nav__label', row.label),
        el('span', 'board-nav__count', row.counted ? String(row.count) : '—'),
      );
      link.title = row.counted
        ? `${row.label}: ${row.count} — jump to section`
        : `${row.label}: not hosted on this server`;
      nav.append(link);
    }
    this.measureNav();
  }

  /** Focus key of the control the operator is on (inside the job list or
   * the strip), or null when focus is elsewhere. */
  private captureFocusKey(): string | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    if (!this.mount.contains(active) && !this.boardNav.contains(active)) return null;
    return active.dataset.focusKey ?? null;
  }

  /** The section a job currently lives in, resolved from the SAME
   * per-render derivation the sections were rendered from (works even
   * when the job's row is inside a collapsed/count-only section and no
   * DOM node exists to walk). */
  private sectionOfJob(jobId: string): string | null {
    const sections = this.currentSections;
    if (sections === null) return null;
    for (const [band, entries] of sections.bands) {
      if (entries.some((entry) => entry.job.id === jobId)) {
        // needs-you renders as the FOR GRU section; every other band name
        // is the section id.
        return band === 'needs-you' ? 'for-gru' : band;
      }
    }
    return null;
  }

  /** The job owning a round (round focus keys must resolve a section even
   * when the round control itself is gone). */
  private jobIdOfRound(roundId: string): string | null {
    for (const repo of this.snapshot?.repos ?? []) {
      for (const job of repo.jobs) {
        if (job.rounds.some((round) => round.id === roundId)) return job.id;
      }
    }
    return null;
  }

  private restoreFocusKey(key: string | null): void {
    if (key === null) return;
    for (const node of [
      ...this.mount.querySelectorAll<HTMLElement>('[data-focus-key]'),
      ...this.boardNav.querySelectorAll<HTMLElement>('[data-focus-key]'),
    ]) {
      if (node.dataset.focusKey === key) {
        node.focus();
        return;
      }
    }
    // The exact control is gone. Focus must land somewhere intentional,
    // never on <body> (Perkins r1 blocker 7 / r2 warning): a section
    // disclosure that disappeared falls back to its ALWAYS-PRESENT
    // shortcut in the sticky strip; a job or round control that vanished
    // resolves its OWNING SECTION from the same snapshot-derived
    // classification the render used (correct even for a job inside a
    // collapsed section with no DOM row), then falls back to that
    // section's disclosure toggle (if it has one) and finally its
    // shortcut — one gesture away, never an unrelated section.
    const sectionKey = /^section:([a-z-]+)$/u.exec(key);
    if (sectionKey !== null) {
      this.boardNav.querySelector<HTMLElement>(`.board-nav__link[data-nav="${sectionKey[1]}"]`)?.focus();
      return;
    }
    let jobId: string | null = null;
    const jobKey = /^job:(.+)$/u.exec(key);
    const roundKey = /^round:(.+)$/u.exec(key);
    if (jobKey !== null && jobKey[1] !== undefined) jobId = jobKey[1];
    else if (roundKey !== null && roundKey[1] !== undefined) jobId = this.jobIdOfRound(roundKey[1]);
    if (jobId === null) return;
    const section = this.sectionOfJob(jobId);
    if (section !== null) {
      const toggle = this.mount.querySelector<HTMLElement>(
        `.board-band[data-section="${section}"] .board-band__more`,
      );
      if (toggle !== null && toggle.getAttribute('aria-expanded') === 'false') {
        toggle.focus();
        return;
      }
      const navLink = this.boardNav.querySelector<HTMLElement>(`.board-nav__link[data-nav="${section}"]`);
      if (navLink !== null) {
        navLink.focus();
        return;
      }
    }
    // Last resort: the row exists but its section could not be resolved
    // (defensive) — the collapsed disclosures, then anything stable.
    this.mount.querySelector<HTMLElement>('.board-band__more')?.focus();
  }

  private measureNav(): void {
    if (this.boardNav.hidden) return;
    const height = this.boardNav.offsetHeight;
    if (height > 0) document.documentElement.style.setProperty('--board-nav-h', `${height}px`);
  }

  // ------------------------------------------------------------------
  // FOR YOU — the permanent owner-action band (owner approval 2026-09-28)
  // ------------------------------------------------------------------

  /** The owner's pending obligations, always at the top of the board:
   * unacked needs-owner rows (Ack closes them on the authoritative
   * snapshot) plus the server-projected, evidence-bound ready PRs (OPEN
   * PR only — a link click never claims a merge). Viewing completes
   * nothing: the count is owed actions, not unseen rows. */
  private renderOwnerActions(snapshot: BoardSnapshot): void {
    const mount = this.ownerMount;
    const rows = ownerRows(snapshot);
    // Focus preservation: a snapshot push re-renders the band; a focused
    // control keeps its place (stable action ids make it the same
    // control, not a lookalike).
    const active = document.activeElement;
    const focusId =
      active instanceof HTMLElement && mount.contains(active)
        ? active.dataset.actionId ?? null
        : null;
    const bandVisible = !mount.hidden && mount.closest('[hidden]') === null;
    mount.replaceChildren();
    const head = el('h2', 'board-band__head');
    head.id = 'board-owner-head';
    head.append(
      el('span', 'board-band__label', 'FOR YOU'),
      el('span', 'board-band__count lbl', `${rows.length} pending`),
    );
    mount.append(head);
    mount.hidden = false;
    if (rows.length === 0) {
      // An empty owner list is healthy, not absence — the calm clear
      // state NEEDS GRU uses (never hidden, never a false alarm).
      const clear = el('div', 'board-band__clear board-owner__clear');
      clear.append(
        el('span', 'board-band__clear-mark', '✓'),
        el('div', 'board-band__clear-text', 'nothing needs you'),
        el('div', 'lbl board-band__clear-hint', 'pending owner actions land here'),
      );
      mount.append(clear);
    } else {
      const window = ownerWindow(rows, this.ownerExpanded);
      const list = el('div', 'board-band__rows board-owner__rows');
      for (const row of window.rows) {
        if (row.kind === 'ack') {
          list.append(this.ownerAckRow(row, bandVisible));
        } else {
          list.append(this.ownerPrRow(row));
        }
      }
      mount.append(list);
      if (window.hidden > 0) {
        const more = el('button', 'board-band__more', `+${window.hidden} older pending`);
        more.type = 'button';
        more.setAttribute('aria-expanded', String(this.ownerExpanded));
        more.addEventListener('click', () => {
          this.ownerExpanded = true;
          if (this.snapshot !== null) this.render(this.snapshot);
        });
        mount.append(more);
      }
    }
    if (focusId !== null) this.refocusAction(focusId);
  }

  private refocusAction(actionId: string): void {
    for (const node of this.ownerMount.querySelectorAll<HTMLElement>('[data-action-id]')) {
      if (node.dataset.actionId === actionId) {
        node.focus();
        return;
      }
    }
  }

  /** One pending ack obligation: what it is, why it is owed, what the
   * Ack does AND does not do. The control stays pending on any HTTP
   * ambiguity — only the authoritative snapshot closes the row. */
  private ownerAckRow(row: OwnerAckRow, bandVisible: boolean): HTMLElement {
    const item = row.notification;
    // The interactive control carries the action id (focus/addressing
    // target); the wrapper stays anonymous so a query always lands on
    // the control, never a lookalike parent.
    const node = el('article', `board-owner__row board-owner__row--${item.severity}`);
    node.append(
      el('div', 'board-owner__title', `🔔 ${item.title}`),
      el(
        'div',
        'board-owner__meta lbl',
        `${formatTs(item.ts)} · owner ack owed${item.detail !== null && item.detail !== '' ? ` — ${item.detail}` : ''}`,
      ),
      el('div', 'lbl board-owner__consequence', row.consequence),
    );
    const ack = document.createElement('button');
    ack.type = 'button';
    ack.className = 'board-owner__ack';
    ack.textContent = 'Ack';
    ack.dataset.actionId = row.actionId;
    ack.addEventListener('click', () => {
      ack.disabled = true;
      ack.textContent = 'acking…';
      void this.boardClient
        ?.ackNotification(item.id)
        .then(() => {
          /* Success is NOT completion — the row closes only when the
           * authoritative snapshot carries ackedAt (any device). */
        })
        .catch(() => {
          // Ambiguous/failed HTTP: the obligation stands. Restore the
          // control; the next snapshot reconciles one authoritative truth.
          ack.disabled = false;
          ack.textContent = 'Ack';
        });
    });
    node.append(ack);
    // Display receipt for what the band actually displayed (shown:true
    // doctrine) — a receipt is proof of display, never of completion.
    if (bandVisible) this.sendShown(item, 'web-board');
    return node;
  }

  /** One evidence-bound ready PR: affected heist, the exact head every
   * piece of evidence is bound to, and OPEN PR — an external link, not
   * an in-app merge. Nothing here claims the merge happened. */
  private ownerPrRow(row: OwnerPrRow): HTMLElement {
    const pr = row.pr;
    const node = el('article', 'board-owner__row board-owner__row--pr');
    node.append(
      el('div', 'board-owner__title', `🔀 ${pr.jobTitle}`),
      el(
        'span',
        'pp-chip pp-chip--done board-owner__ready',
        'ready for you',
      ),
      el(
        'div',
        'board-owner__meta lbl',
        `📦 ${pr.repo} · review approved @ ${pr.sha.slice(0, 8)} · CI green at that head · mergeable`,
      ),
    );
    const href = safePrUrl(pr.prUrl);
    if (href !== null) {
      const open = el('a', 'board-owner__open', 'OPEN PR ↗');
      open.href = href;
      open.target = '_blank';
      open.rel = 'noreferrer';
      open.dataset.actionId = row.actionId;
      open.title = 'Opens the PR on GitHub — merging stays your call there';
      node.append(open);
    } else {
      // Fail closed: an unsafe URL never becomes a link (the server
      // already refuses to project these; this is the browser guard).
      node.append(el('span', 'lbl board-owner__nolink', 'PR link unavailable'));
    }
    return node;
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
   * v4 tracker strip carried (their ids/behavior survive the move). v6.1:
   * every count renders as a labeled field — no bare slash counters. */
  private trackersChipNode(chip: RailChip): HTMLElement {
    const node = el('span', `rail-chip rail-chip--trackers rail-chip--${chip.tone}`);
    node.dataset.chip = 'trackers';
    node.title = chip.titleAttr;
    node.append(el('span', 'rail-chip__label', chip.label));
    for (const group of chip.kpis ?? []) {
      const groupNode = el('span', 'rail-kpi');
      groupNode.title = group.title;
      const label = el('b', 'rail-kpi__label', group.label);
      if (group.total !== undefined) {
        const total = el('span', 'rail-kpi__total', String(group.total.value));
        total.dataset.kpi = group.total.kpi;
        total.title = group.total.title;
        label.append(document.createTextNode(' '), total);
      }
      groupNode.append(label);
      for (const value of group.values) {
        const field = el('span', 'rail-kpi__field');
        const fieldLabel = el('span', 'rail-kpi__field-label', value.label);
        fieldLabel.title = value.title;
        const number = el('span', 'rail-kpi__num', String(value.value));
        number.dataset.kpi = value.kpi;
        number.title = value.title;
        if (value.kpi === 'prs.conflicting' && value.value > 0) {
          number.classList.add('rail-kpi__num--alert');
        }
        field.append(fieldLabel, number);
        groupNode.append(field);
      }
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
    // NEEDS GRU is the LIVE machine queue: action-required rows awaiting a
    // machine disposition (terminal-bound rows are closed receipts below).
    // It never rings the owner bell — the FOR YOU band (bell + toasts) is
    // the only human-facing surface.
    const needsGru = snapshot.unackedActionRequired;
    this.unackedChip.hidden = needsGru === 0;
    this.unackedChip.textContent = `🛠 ${needsGru} needs Gru`;
    this.unackedChip.title = `${needsGru} live machine-attention notification${needsGru === 1 ? '' : 's'} awaiting a Gru disposition — the live queue clears itself; closed receipts stay in the record and the owner bell is not rung.`;
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

  /** The approved six-section stack, in order: For you (owner mount,
   * rendered above) → In flight → Pipeline → For Gru → Settled → Cold.
   * Every section always exists (a valid shortcut target) with either
   * rows or a compact empty state. In flight previews 5, Pipeline 5,
   * Settled 3; For Gru and Cold render no rows until deliberately
   * expanded; disclosures are reversible and survive snapshot pushes. */
  /** The single per-render sections derivation (memoized for this
   * render pass): the nav strip and the section bodies read the SAME
   * classification — stopped/live-worker truth included — so their counts
   * cannot drift apart between renders. */
  private sectionsFor(snapshot: BoardSnapshot): ReturnType<typeof boardSections> {
    if (this.currentSections === null) {
      const stoppedWorkers = stoppedWorkersByJob(snapshot.agents);
      const liveWorkerStamps = liveWorkerStampsByJob(snapshot.agents);
      this.currentSections = boardSections(snapshot, Date.now(), { stoppedWorkers, liveWorkerStamps });
    }
    return this.currentSections;
  }

  private renderJobs(snapshot: BoardSnapshot): void {
    this.mount.replaceChildren();
    const unacked = unackedByJob(snapshot);
    // Section truth: the live needs-Gru view counts only LIVE rows. The
    // stopped-worker map carries the supervision stop (waiting-on-rearm)
    // truth for working lanes; terminal-job notifications stay in the bell.
    // The live-worker stamps keep a re-dispatched lane's fresh registration
    // on the stall clock's floor (never falsely COLD — twelve-followthrough
    // A1/E1). The SAME derivation feeds the shortcut strip (one source:
    // strip counts and section bodies can never disagree).
    const sections = this.sectionsFor(snapshot);
    const stoppedWorkers = stoppedWorkersByJob(snapshot.agents);
    this.mount.append(this.jobsSection('in-flight', sections.bands.get('in-flight') ?? [], unacked, stoppedWorkers));
    this.mount.append(this.pipelineSection(sections));
    this.mount.append(this.forGruSection(sections.bands.get('needs-you') ?? [], unacked, stoppedWorkers));
    this.mount.append(this.jobsSection('settled', settledJobs(sections.bands.get('settled') ?? []), unacked, stoppedWorkers));
    this.mount.append(this.coldSection(sections.bands.get('cold') ?? [], unacked, stoppedWorkers));
    const seenIds = new Set<string>();
    for (const group of sections.bands.values()) for (const entry of group) seenIds.add(entry.job.id);
    for (const id of seenIds) this.knownJobIds.add(id);
    this.firstJobsRender = false;
  }

  /** Shared section shell: sticky head (label + authoritative count) and
   * the body region every disclosure targets by a stable id. */
  private sectionShell(
    sectionId: SectionId,
    cssBand: string,
    label: string,
    countText: string,
  ): { section: HTMLElement; head: HTMLElement; body: HTMLElement; bodyId: string } {
    const section = el('section', `board-band board-band--${cssBand}`);
    section.id = `board-section-${sectionId}`;
    section.dataset.section = sectionId;
    const headId = `${section.id}-head`;
    const bodyId = `${section.id}-body`;
    section.setAttribute('aria-labelledby', headId);
    const head = el('h2', 'board-band__head');
    head.id = headId;
    head.append(el('span', 'board-band__label', label), el('span', 'board-band__count lbl', countText));
    const body = el('div', 'board-band__body');
    body.id = bodyId;
    section.append(head, body);
    return { section, head, body, bodyId };
  }

  /** A disclosure control with proper name/state/controls and a stable
   * focus key — the SAME control before and after a snapshot push. */
  private sectionToggle(input: {
    sectionId: SectionId;
    bodyId: string;
    expanded: boolean;
    label: string;
  }): HTMLButtonElement {
    const button = el('button', 'board-band__more');
    button.type = 'button';
    button.dataset.focusKey = `section:${input.sectionId}`;
    button.setAttribute('aria-expanded', String(input.expanded));
    button.setAttribute('aria-controls', input.bodyId);
    button.textContent = input.label;
    return button;
  }

  private rerender(): void {
    if (this.snapshot !== null) this.render(this.snapshot);
  }

  private emptyLine(text: string): HTMLElement {
    return el('div', 'board-band__empty lbl', text);
  }

  /** In flight (preview 5) and Settled (preview 3): the existing
   * authoritative band order, bounded; Show all/Show fewer reversible. */
  private jobsSection(
    band: 'in-flight' | 'settled',
    jobs: readonly BandedJob[],
    unacked: ReadonlyMap<string, number>,
    stoppedWorkers: ReadonlyMap<string, WorkerStopView>,
  ): HTMLElement {
    const label = band === 'in-flight' ? BAND_LABELS['in-flight'] : BAND_LABELS.settled;
    const { section, body, bodyId } = this.sectionShell(band, band, label, heistCount(jobs.length));
    if (jobs.length === 0) {
      body.append(this.emptyLine(band === 'in-flight' ? 'nothing in flight right now' : 'nothing settled yet'));
      return section;
    }
    const expanded = band === 'in-flight' ? this.inFlightExpanded : this.settledExpanded;
    const window = band === 'in-flight' ? inFlightWindow(jobs, expanded) : settledPreview(jobs, expanded);
    const rows = el('div', 'board-band__rows');
    for (const entry of window.rows) {
      rows.append(
        this.jobRow(entry.job, unacked.get(entry.job.id) ?? 0, entry.stale, band, stoppedWorkers.get(entry.job.id) ?? null),
      );
    }
    body.append(rows);
    if (window.hidden > 0) {
      const more = this.sectionToggle({
        sectionId: band,
        bodyId,
        expanded: false,
        label: band === 'in-flight' ? `Show all ${jobs.length} (${window.hidden} more)` : `Show older settled (+${window.hidden})`,
      });
      more.addEventListener('click', () => {
        if (band === 'in-flight') this.inFlightExpanded = true;
        else this.settledExpanded = true;
        this.rerender();
      });
      body.append(more);
    } else if (expanded && jobs.length > (band === 'in-flight' ? IN_FLIGHT_PREVIEW_SIZE : SETTLED_PREVIEW_SIZE)) {
      const fewer = this.sectionToggle({ sectionId: band, bodyId, expanded: true, label: 'Show fewer' });
      fewer.addEventListener('click', () => {
        if (band === 'in-flight') this.inFlightExpanded = false;
        else this.settledExpanded = false;
        this.rerender();
      });
      body.append(fewer);
    }
    return section;
  }

  /** Pipeline: the server-evaluated durable queue in its deterministic
   * priority order, preview 5 + Show all. Each waiting entry carries its
   * real dependency/resource/capacity/hold reason as plain text; ready
   * entries are labelled honestly. */
  private pipelineSection(sections: ReturnType<typeof boardSections>): HTMLElement {
    const entries = sections.pipelineEntries;
    const { section, body, bodyId } = this.sectionShell(
      'pipeline',
      'pipeline',
      'PIPELINE',
      // The head carries the FULL pending count (never the loaded slice);
      // the preview window only bounds the rows.
      `${sections.counts.pipeline} queued`,
    );
    if (!sections.pipelineAvailable) {
      body.append(this.emptyLine('pipeline queue unavailable on this server'));
      return section;
    }
    if (entries.length === 0) {
      body.append(this.emptyLine('no approved work waiting'));
      return section;
    }
    const window = pipelineWindow(entries, this.pipelineExpanded);
    const rows = el('div', 'board-band__rows board-pipeline__rows');
    for (const entry of window.rows) rows.append(this.pipelineRow(entry));
    body.append(rows);
    if (window.hidden > 0) {
      const more = this.sectionToggle({
        sectionId: 'pipeline',
        bodyId,
        expanded: false,
        label: `Show all ${entries.length} (${window.hidden} more)`,
      });
      more.addEventListener('click', () => {
        this.pipelineExpanded = true;
        this.rerender();
      });
      body.append(more);
    } else if (this.pipelineExpanded && entries.length > PIPELINE_PREVIEW_SIZE) {
      const fewer = this.sectionToggle({ sectionId: 'pipeline', bodyId, expanded: true, label: 'Show fewer' });
      fewer.addEventListener('click', () => {
        this.pipelineExpanded = false;
        this.rerender();
      });
      body.append(fewer);
    }
    return section;
  }

  /** For Gru: the existing machine band, collapsed by default with its
   * complete count; expanding inspects the machine queue. Genuine
   * owner-only matters stay in For you. Collapse never resolves or
   * suppresses anything — it only hides rows. */
  private forGruSection(
    jobs: readonly BandedJob[],
    unacked: ReadonlyMap<string, number>,
    stoppedWorkers: ReadonlyMap<string, WorkerStopView>,
  ): HTMLElement {
    const { section, head, body, bodyId } = this.sectionShell(
      'for-gru',
      'needs-you',
      BAND_LABELS['needs-you'],
      heistCount(jobs.length),
    );
    if (jobs.length === 0) {
      body.append(this.clearForGru());
      return section;
    }
    const toggle = this.sectionToggle({
      sectionId: 'for-gru',
      bodyId,
      expanded: this.forGruExpanded,
      label: this.forGruExpanded ? 'Hide machine queue' : 'Show machine queue',
    });
    toggle.addEventListener('click', () => {
      this.forGruExpanded = !this.forGruExpanded;
      this.rerender();
    });
    head.append(toggle);
    if (!this.forGruExpanded) {
      body.hidden = true;
      return section;
    }
    const rows = el('div', 'board-band__rows');
    for (const entry of jobs) {
      rows.append(
        this.jobRow(entry.job, unacked.get(entry.job.id) ?? 0, entry.stale, 'needs-you', stoppedWorkers.get(entry.job.id) ?? null),
      );
    }
    body.append(rows);
    return section;
  }

  /** Cold: COUNT ONLY by default — zero job rows render until the
   * operator deliberately expands; expansion shows the retained records
   * and can be collapsed again. Never a deletion or a completion. */
  private coldSection(
    jobs: readonly BandedJob[],
    unacked: ReadonlyMap<string, number>,
    stoppedWorkers: ReadonlyMap<string, WorkerStopView>,
  ): HTMLElement {
    const { section, head, body, bodyId } = this.sectionShell('cold', 'cold', BAND_LABELS.cold, heistCount(jobs.length));
    if (jobs.length === 0) {
      body.append(this.emptyLine('no cold records'));
      return section;
    }
    const toggle = this.sectionToggle({
      sectionId: 'cold',
      bodyId,
      expanded: this.coldExpanded,
      label: this.coldExpanded ? 'Hide records' : 'Show records',
    });
    toggle.addEventListener('click', () => {
      this.coldExpanded = !this.coldExpanded;
      this.rerender();
    });
    head.append(toggle);
    if (!this.coldExpanded) {
      body.hidden = true;
      return section;
    }
    const rows = el('div', 'board-band__rows');
    for (const entry of jobs) {
      rows.append(
        this.jobRow(entry.job, unacked.get(entry.job.id) ?? 0, entry.stale, 'cold', stoppedWorkers.get(entry.job.id) ?? null),
      );
    }
    body.append(rows);
    return section;
  }

  /** One pipeline entry row: state chip + title + priority; meta line
   * carries repo, durable enqueue order, age and the exact wait reason
   * (untrusted text renders as text, never markup/instructions). */
  private pipelineRow(entry: PipelineEntryView): HTMLElement {
    const row = el('article', `board-pipeline board-pipeline--${entry.state}`);
    row.dataset.entryId = entry.id;
    row.dataset.state = entry.state;
    const head = el('div', 'board-pipeline__head');
    const title = el('span', 'board-pipeline__title', entry.title);
    title.title = entry.title;
    head.append(
      el('span', `pp-chip board-pipeline__state ${pipelineStateTone(entry)}`, pipelineStateLabel(entry)),
      title,
      el('span', 'pp-chip pp-chip--park board-pipeline__priority', `P${entry.priority}`),
    );
    const meta = el('div', 'board-pipeline__meta lbl');
    meta.append(
      el('span', 'board-pipeline__repo', `📦 ${entry.repo}`),
      el('span', 'board-pipeline__seq', `#${entry.enqueueSeq}`),
      this.ageNode('board-pipeline__age', entry.queuedAt, 'queued ', ''),
    );
    if (entry.reason !== null && entry.reason !== '') {
      meta.append(el('span', 'board-pipeline__reason', entry.reason));
    }
    row.append(head, meta);
    return row;
  }

  /** An empty FOR GRU band is good news, not absence: a calm green
   * satisfied state that is never hidden. */
  private clearForGru(): HTMLElement {
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
  private jobRow(
    job: JobView,
    unackedActionRequired: number,
    stale: boolean,
    band: BandId,
    workerStop: WorkerStopView | null,
  ): HTMLElement {
    const row = el('article', 'board-job');
    row.dataset.jobId = job.id;
    row.dataset.band = band;
    row.dataset.status = job.status;
    // Defect truth (2026-09-29): a supervision-stopped worker is waiting
    // on a human re-arm — the row says so instead of a bare "working".
    // The swap is scoped to working lanes (where the status lies); other
    // statuses keep their true chip, and the agent rail carries the ⛔.
    const waiting = workerStop !== null && job.status === 'working';
    if (waiting) row.dataset.workerState = 'waiting';
    if (jobFailing(job)) row.classList.add('board-job--alert');
    // v5: a job that was not on screen slides in (8px); a snapshot push
    // re-rendering known rows stays still.
    if (!this.firstJobsRender && !this.knownJobIds.has(job.id)) {
      row.classList.add('board-job--enter');
    }

    const head = el('div', 'board-job__head');
    const toggle = el('button', 'board-job__toggle');
    toggle.type = 'button';
    toggle.dataset.focusKey = `job:${job.id}`;
    const chevron = el('span', 'board-job__chevron', '▸');
    chevron.setAttribute('aria-hidden', 'true');
    const dot = el('span', `board-job__dot board-job__dot--${jobStatusTone(job.status)}`);
    dot.setAttribute('aria-hidden', 'true');
    const name = el('span', 'board-job__name', job.title);
    name.title = job.title;
    toggle.append(dot, chevron, name);
    if (stale) {
      const flag = el('span', 'pp-chip pp-chip--alert board-job__stale', 'stalled');
      flag.title = 'working with no minion frames past the stall window';
      toggle.append(flag);
    }
    const signal = jobSignal(job, unackedActionRequired);
    if (signal !== null) {
      const chip = el('span', `pp-chip board-job__signal pp-chip--${signal.tone}`, signal.label);
      chip.title = signal.title;
      toggle.append(chip);
    }
    const status = el(
      'span',
      `pp-chip board-job__status ${waiting ? 'pp-chip--park' : jobChipTone(job.status)}`,
      waiting ? workerStopLabel(workerStop) : job.status,
    );
    if (waiting && workerStop !== null) {
      status.title =
        `worker stopped by supervision` +
        (workerStop.reason === null ? '' : ` (${workerStop.reason.replaceAll('_', ' ')})`) +
        `${workerStop.restarts > 0 ? ` after ${workerStop.restarts} restart${workerStop.restarts === 1 ? '' : 's'}` : ''} — ` +
        'the lane is not running: resolve the condition, then ack the escalation to re-arm';
    }
    toggle.append(status);
    head.append(toggle);
    row.append(head);

    const meta = el('div', 'board-job__meta lbl');
    meta.append(el('span', 'board-job__repo', `📦 ${job.repo}`));
    if (job.lane !== null) {
      meta.append(el('span', 'board-job__branch', `🌿 ${job.lane.branch ?? 'detached'}`));
      meta.append(this.ageNode('board-job__age board-job__lane-age', job.lane.createdAt, `${BOARD_WORDS.heist} `, ''));
      meta.append(this.ageNode('board-job__age board-job__agent-age', job.lastAgentActivity, `${BOARD_WORDS.minion} `, ''));
    } else if (job.baseBranch !== null) {
      meta.append(el('span', 'board-job__branch', `⌂ ${job.baseBranch}`));
    }
    if (job.prUrl !== null) {
      // Owner approval j-982: show the canonical request number when the
      // URL carries one; an unprovable URL keeps the generic label.
      const link = el('a', 'board-job__pr', prLinkLabel(job.prUrl));
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
        this.ageNode('board-lane__age lbl', job.lane.createdAt, `${BOARD_WORDS.heist} `, ''),
        this.ageNode('board-lane__activity lbl', job.lastAgentActivity, `${BOARD_WORDS.minion} `, ''),
      );
      if (job.lane.status !== 'active') {
        lane.append(el('span', 'pp-chip pp-chip--park board-lane__status', job.lane.status));
      }
      body.append(lane);
    }
    if (job.note !== null && job.note !== '') body.append(el('div', 'board-job__note', job.note));
    const concluded = isJobConcluded(job.status);
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
    toggle.dataset.focusKey = `round:${round.id}`;
    const chevron = el('span', 'board-round__chevron', '▸');
    chevron.setAttribute('aria-hidden', 'true');
    toggle.append(
      el('span', 'pp-chip pp-chip--perkins', `round ${round.seq}`),
      el('span', 'lbl board-round__status', round.status),
    );
    if (round.verdict !== null) {
      toggle.append(el('span', 'lbl board-round__verdict', `· ${round.verdict}`));
    }
    toggle.append(el('span', 'lbl board-round__lens-progress', lensProgressLabel(summary)));
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
      const state = lensChipState(chip);
      const unused = state === 'unused';
      const node = el(
        'span',
        `pp-chip board-lens ${lensChipTone(state)}${chip.verdict === 'blocker' ? ' board-lens--blocker' : ''}`,
        `${LENS_STATE_LABEL[state] ?? '?'} ${chip.lens}${attemptCount > 1 ? ` ×${attemptCount}` : ''}${unused ? ' · not used' : ''}`,
      );
      if (chip.verdict === 'blocker') node.title = chip.note ?? 'lens recorded a blocker';
      else if (state === 'error') node.title = chip.note ?? 'lens errored';
      else if (unused) node.title = chip.note ?? 'not used';
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
  // Crew rail (dense rows, tabs, disposed overflow)
  // ------------------------------------------------------------------

  private renderAgents(agents: readonly AgentView[]): void {
    this.lastAgents = agents;
    const rail = mustGet('board-agents');
    rail.replaceChildren();
    this.ensureAgeTicker();
    // Issue #171 truthful agent status: liveness is RUNTIME OWNERSHIP,
    // not the raw stored state. The live crew = current members plus
    // explicitly-ambiguous unverified rows (missing evidence is never
    // death — the row stays visible and marked); on a classifying server
    // only CONFIRMED current rows count toward CREW (n), so the count
    // never claims ambiguous ownership as active. Owner-held stops or
    // restarts stay in the live crew even when the released handle left
    // the ledger state disposed — the current runtime still owns the
    // lane. Verified-historical records (a previous run/import left them)
    // collapse behind a history disclosure with their transcripts intact;
    // fully disposed rows keep their graveyard. A pre-upgrade snapshot
    // (no classification at all) keeps today's attribution and counting.
    const classificationPresent = hasRuntimeClassification(agents);
    const disposed: AgentView[] = [];
    const historical: AgentView[] = [];
    const live: AgentView[] = [];
    for (const agent of agents) {
      const band = agentRailBand(agent);
      if (band === 'disposed') disposed.push(agent);
      else if (band === 'historical') historical.push(agent);
      else live.push(agent);
    }
    this.agentsCount.textContent = String(
      live.filter((agent) => isCountedCrewAgent(agent, classificationPresent)).length,
    );
    if (agents.length === 0) {
      rail.append(el('div', 'lbl', 'no crew yet'));
      return;
    }
    // Membership-first order arrives from the server; disposed rows collapse
    // behind a toggle so the graveyard never crowds live work.
    // A genuine duplicate CURRENT singleton-role owner is an anomaly the
    // service must surface, never silently discard: mark every row of a
    // duplicated singleton role so the operator can investigate (#171).
    const duplicateRoles = duplicatedSingletonRoles(live);
    const labelById = new Map(agents.map((entry) => [entry.id, agentLabel(entry)]));
    // Resolve identities across live AND disposed workers so a collapsed
    // row cannot change the suffix of a visible worker (crew-heist-labels).
    const jobs = new Map(this.snapshot?.repos.flatMap((repo) => repo.jobs.map((job) => [job.id, job] as const)) ?? []);
    const suffixes = minionSuffixes(agents, jobs);
    for (const agent of live) {
      rail.append(
        this.agentRow(
          agent,
          'live',
          duplicateRoles.has(agent.id),
          classificationPresent && agentRuntimeOf(agent) === 'unverified',
          labelById,
          jobs,
          suffixes,
        ),
      );
    }
    if (historical.length > 0) {
      const toggle = el(
        'button',
        'board-agent-toggle',
        `${this.historyExpanded ? '−' : '+'}${historical.length} history`,
      );
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(this.historyExpanded));
      toggle.setAttribute('data-section', 'history');
      toggle.title =
        'verified historical sessions — no current runtime owner; transcripts stay accessible';
      toggle.addEventListener('click', () => {
        this.historyExpanded = !this.historyExpanded;
        this.renderAgents(agents);
        if (this.historyExpanded) {
          rail
            .querySelector<HTMLElement>('.board-agent--historical')
            ?.scrollIntoView?.({ block: 'nearest' });
        }
      });
      rail.append(toggle);
      if (this.historyExpanded) {
        for (const agent of historical) {
          rail.append(this.agentRow(agent, 'historical', false, false, labelById, jobs, suffixes));
        }
      }
    }
    if (disposed.length > 0) {
      const toggle = el(
        'button',
        'board-agent-toggle',
        `${this.disposedExpanded ? '−' : '+'}${disposed.length} disposed`,
      );
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(this.disposedExpanded));
      toggle.setAttribute('data-section', 'disposed');
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
        for (const agent of disposed) rail.append(this.agentRow(agent, 'disposed', false, false, labelById, jobs, suffixes));
      }
    }
  }

  /** One dense agent row: status dot, name + short hash, role·state
   * subline, right-aligned status chip. Error rows carry the alert
   * accent (tint + left border) so a fault never hides in the list.
   * Issue #171: the chip and subline read the DERIVED status (a raw-idle
   * agent with open supervision work shows the work it is doing), and
   * historical rows are marked as past sessions rather than live crew. */
  private agentRow(
    agent: AgentView,
    section: 'live' | 'historical' | 'disposed',
    duplicateSingleton: boolean,
    ambiguousOwnership: boolean,
    labelById: ReadonlyMap<string, string>,
    jobs: ReadonlyMap<string, JobView>,
    suffixes: ReadonlyMap<string, string>,
  ): HTMLElement {
    // Crew-heist-labels: resolve the minion's job once — the heist name
    // drives the primary line, the tooltip keeps the FULL job title, and
    // the accessible name keeps the full identity (G7).
    const job = agent.role === 'minion' ? jobs.get(agent.jobId ?? '') : undefined;
    const name = agent.role === 'minion' ? heistName(job?.displayName ?? job?.title) : agentLabel(agent);
    // A div with button semantics (NOT <button>): the row contains its own
    // parent-navigation button for child rows, and interactive elements
    // must not nest. Keyboard activation matches a button (Enter/Space).
    const row = el(
      'div',
      `board-agent${section === 'disposed' ? ' board-agent--disposed' : ''}${section === 'historical' ? ' board-agent--historical' : ''}`,
    );
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    const status = agentStatusOf(agent);
    row.dataset.state = status;
    row.dataset.role = agent.role;
    // Issue #161: parent navigation target + honest parentage marker
    // (`unknown` when the server gave no information — legacy rows are
    // never inferred as top-level).
    row.dataset.agentId = agent.id;
    row.dataset.parentage = agent.parentage ?? 'unknown';
    if (status === 'error') row.classList.add('board-agent--error');
    row.title =
      agent.sessionFile !== null
        ? `${[...(job !== undefined ? [job.title] : []), agent.id].join(' — ')} — open transcript`
        : `${[...(job !== undefined ? [job.title] : []), agent.id].join(' — ')} — no session file yet`;
    // G7: every rail row carries an accessible name; minions keep their
    // full-identity shape, other roles announce label · id — role · state.
    row.setAttribute('aria-label', agent.role === 'minion'
      ? `${name} · ${agent.id}${job !== undefined ? ` — ${job.title}` : ''} — ${agent.role} · ${status}`
      : `${name} · ${agent.id} — ${agent.role} · ${status}`);
    if (section === 'historical') {
      row.title += ' · historical: no current runtime owner — record retained';
    }
    const openTranscript = (): void => {
      if (agent.sessionFile !== null) {
        // G6: minion tabs read under the heist rail name; the session file
        // (never the label) drives the actual transcript selection. The
        // suffix joins the title so several workers on one heist stay
        // distinguishable, exactly as the rail row shows them.
        const label = agent.role === 'minion' ? `${name} · ${railSuffix(suffixes, agent.id)}` : name;
        this.onOpenTranscript({ file: agent.sessionFile, label });
      }
    };
    row.addEventListener('click', openTranscript);
    row.addEventListener('keydown', (event) => {
      // Keys on the nested parent-navigation button belong to THAT button:
      // the row must not hijack Enter/Space bubbling from a descendant.
      if (event.target !== row) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openTranscript();
      }
    });
    const body = el('span', 'board-agent__body');
    const top = el('span', 'board-agent__top');
    top.append(
      el('span', 'board-agent__name', name),
      el(
        'span',
        'board-agent__hash lbl',
        agent.role === 'minion' ? railSuffix(suffixes, agent.id) : agent.id.slice(0, 8),
      ),
    );
    const subline = el('span', 'board-agent__sub lbl');
    // Issue #161: top-level minions vs minion-created child workers. The
    // marker renders from the durable parentage field only; an omitted
    // field (pre-upgrade server) or a null field (server says unknown)
    // renders no marker — legacy rows are never claimed either way.
    const parentage = agent.parentage;
    const isChild = parentage === 'child';
    subline.append(
      el('span', 'board-agent__emoji', ROLE_EMOJI[agent.role] ?? '🤖'),
      el('span', 'board-agent__role', isChild ? `child · ${status}` : `${agent.role} · ${status}`),
    );
    if (parentage === 'top-level' || parentage === 'child') {
      subline.append(
        el(
          'span',
          `board-agent__parentage board-agent__parentage--${parentage}`,
          isChild ? '🧬 child' : 'top-level',
        ),
      );
    }
    if (isChild && agent.parentAgentId !== null && agent.parentAgentId !== undefined) {
      const parentId = agent.parentAgentId;
      const parentLink = el(
        'button',
        'board-agent__parent-link',
        `↳ ${labelById.get(parentId) ?? parentId.slice(0, 8)}`,
      );
      parentLink.type = 'button';
      parentLink.title = `parent minion ${parentId} — jump to the parent row`;
      parentLink.addEventListener('click', (event) => {
        event.stopPropagation();
        this.revealAgent(parentId);
      });
      subline.append(parentLink);
      row.title += ` · child worker of ${parentId}`;
    }
    const childCounts = agent.childCounts;
    if (childCounts !== null && childCounts !== undefined && childCounts.lifetimeCreations > 0) {
      const family = el(
        'span',
        'board-agent__child-counts',
        `↳ ${childCounts.lifetimeCreations} ${childCounts.lifetimeCreations === 1 ? 'child' : 'children'}` +
          ` (${childCounts.active} active, ${childCounts.queued} queued, ${childCounts.finished} finished)`,
      );
      family.title =
        'family counters: active / queued / finished children, with lifetime logical creations';
      subline.append(family);
    }
    // Turn-age counter: a working agent shows how long its current turn
    // has been quiet — the operator's "is it stuck?" glance. The clock
    // prefers the supervision event stream (#171): deltas never touch the
    // ledger's last_activity, so a busy turn must not read as days-quiet.
    if (status === 'streaming') {
      subline.append(this.ageNode('board-agent__age lbl', agentActivityOf(agent), '', ' quiet'));
    }
    // Issue #171: ambiguous ownership is explicit — an unverified row is
    // visible, marked, and never claimed active or dead by the board (on
    // a pre-upgrade server no row is marked: the whole board is legacy).
    if (ambiguousOwnership) {
      subline.append(el('span', 'board-agent__runtime board-agent__runtime--unknown', '❓ unverified'));
      row.title += ' · runtime ownership unverified (no ownership evidence)';
    }
    if (section === 'historical') {
      subline.append(el('span', 'board-agent__runtime board-agent__runtime--historical', '🕘 history'));
    }
    // Issue #171: a duplicated CURRENT singleton-role owner is surfaced as
    // an anomaly (the service supervises one of each) — never discarded.
    if (duplicateSingleton) {
      subline.append(el('span', 'board-agent__runtime board-agent__runtime--alert', '⚠ duplicate'));
      row.title += ` · anomaly: more than one current ${agent.role} owner — investigate`;
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
    row.append(el('span', `pp-chip board-agent__state ${agentStateTone(status)}`, status));
    return row;
  }

  /** Issue #161 parent navigation: reveal the parent row even when its
   * historical/disposed section is collapsed, then scroll to it. The row
   * is located by dataset comparison — a manually registered agent id can
   * contain selector metacharacters, so ids never enter a CSS selector. */
  private revealAgent(agentId: string): void {
    const target = this.lastAgents.find((agent) => agent.id === agentId);
    if (target === undefined) return;
    const band = agentRailBand(target);
    if (band === 'historical') this.historyExpanded = true;
    if (band === 'disposed') this.disposedExpanded = true;
    this.renderAgents(this.lastAgents);
    const rows = mustGet('board-agents').querySelectorAll<HTMLElement>('.board-agent');
    for (const row of rows) {
      if (row.dataset.agentId === agentId) {
        row.scrollIntoView?.({ block: 'nearest' });
        return;
      }
    }
  }

  // ------------------------------------------------------------------
  // Notification center
  // ------------------------------------------------------------------

  private renderNotifications(snapshot: BoardSnapshot): void {
    const notifications = snapshot.notifications;
    const list = mustGet('notification-list');
    list.replaceChildren();
    this.updateBadge(notifications);
    this.notificationBell.hidden = false;
    // Routing split (owner ruling 2026-09-23): FOR YOU is the only
    // human-facing band; NEEDS GRU is the self-clearing machine queue
    // (Gru dispositions, the owner bell stays quiet); everything else is
    // the standing feed.
    // A pre-disposition release could Ack machine rows. Those legacy rows
    // are closed receipts, not active NEEDS GRU work, even if unresolved.
    // A row bound to a TERMINAL job is the same kind of receipt (section
    // truth, 2026-09-29): the record keeps it — FEED renders it as a
    // closed receipt — but the live queue never counts or lists it.
    const unresolved = (item: NotificationView): boolean => item.resolvedAt === null && item.ackedAt === null;
    const receipts = terminalBoundNotificationIds(snapshot);
    const needsGru = notifications.filter(
      (item) => item.routing === 'action-required' && unresolved(item) && !receipts.has(item.id),
    );
    const feed = [
      ...notifications.filter(
        (item) => item.routing === 'fyi' || !unresolved(item) || receipts.has(item.id),
      ),
      ...this.extraReceipts.filter((extra) => !notifications.some((item) => item.id === extra.id)),
    ];
    // Every snapshot renders the full band structure — an empty feed is
    // good news, not absence. No early return may skip FOR YOU / NEEDS GRU
    // and their clear states (g9).
    // FOR YOU parity (FOR YOU r1): the bell renders the SAME authoritative
    // owner projection the board band renders — pending acks AND ready PRs
    // — so the two surfaces can never disagree about what the owner owes.
    // Alert/history behavior is untouched: the badge and toasts still ride
    // needs-owner notifications only, and acked/resolved rows stay in FEED.
    const ownerRowsForBell = ownerRows(snapshot);
    const forYou = el('section', 'board-notification-section');
    forYou.append(el('div', 'board-notification-section__head lbl', 'FOR YOU'));
    if (ownerRowsForBell.length === 0) {
      forYou.append(el('div', 'board-notification-section__empty lbl', 'nothing needs you'));
    } else {
      for (const row of ownerRowsForBell) {
        forYou.append(row.kind === 'ack' ? this.notificationRow(row.notification) : this.ownerPrRow(row));
      }
    }
    list.append(forYou);
    this.renderNotificationSection(list, 'NEEDS GRU', needsGru, 'live machine queue is clear', receipts);
    if (feed.length > 0) {
      this.renderNotificationSection(list, 'FEED', feed, null, receipts);
      // D3: the snapshot carries the newest receipt window only; older
      // receipts are fetched on demand. The control appears only when a
      // receipt is actually on screen.
      if (
        this.boardClient !== null &&
        !this.receiptsExhausted &&
        feed.some((item) => receipts.has(item.id) || this.extraReceipts.some((extra) => extra.id === item.id))
      ) {
        const more = el(
          'button',
          'board-notification__more lbl',
          this.receiptsLoading ? 'loading older receipts…' : 'load older receipts',
        );
        more.type = 'button';
        (more as HTMLButtonElement).disabled = this.receiptsLoading;
        more.addEventListener('click', () => void this.loadOlderReceipts());
        list.append(more);
      }
    }
  }

  /** D3: fetch the next page of closed receipts and merge it into FEED.
   * A failed page is non-fatal: the control stays for retry. */
  private async loadOlderReceipts(): Promise<void> {
    const client = this.boardClient;
    if (client === null || this.receiptsLoading) return;
    this.receiptsLoading = true;
    if (this.snapshot !== null) this.renderNotifications(this.snapshot);
    try {
      const page = await client.fetchReceipts(this.receiptsNextOffset);
      // Re-paired mid-fetch: the page belongs to the previous server's record.
      if (this.boardClient !== client) return;
      for (const row of page.receipts) {
        if (!this.extraReceipts.some((existing) => existing.id === row.id)) this.extraReceipts.push(row);
      }
      this.receiptsNextOffset = page.nextOffset;
      if (!page.hasMore) this.receiptsExhausted = true;
    } catch {
      // The button remains; a later click retries the same cursor.
    } finally {
      if (this.boardClient === client) {
        this.receiptsLoading = false;
        if (this.snapshot !== null) this.renderNotifications(this.snapshot);
      }
    }
  }

  private renderNotificationSection(
    list: HTMLElement,
    label: string,
    rows: readonly NotificationView[],
    empty: string | null,
    receipts: ReadonlySet<string>,
  ): void {
    const section = el('section', 'board-notification-section');
    section.append(el('div', 'board-notification-section__head lbl', label));
    if (rows.length === 0) {
      if (empty !== null) section.append(el('div', 'board-notification-section__empty lbl', empty));
    } else {
      for (const item of rows) section.append(this.notificationRow(item, receipts.has(item.id)));
    }
    list.append(section);
  }

  private notificationRow(item: NotificationView, closedReceipt = false): HTMLElement {    const row = el(
      'div',
      `board-notification board-notification--${item.severity}${closedReceipt ? ' board-notification--receipt' : ''}`,
    );
    if (closedReceipt) row.dataset.receipt = 'closed';
    const icon = item.routing === 'needs-owner' ? '🔔' : item.routing === 'action-required' ? '🛠' : item.severity === 'error' ? '🚨' : 'ℹ️';
    const suffix = closedReceipt
      ? ' · closed receipt'
      : item.resolvedAt !== null
        ? ' · resolved'
        : item.ackedAt !== null
          ? ' ✓'
          : '';
    row.append(
      el('div', 'board-notification__title', `${icon} ${item.title}${suffix}`),
      el(
        'div',
        'board-notification__meta lbl',
        `${formatTs(item.ts)} · ${item.routing}${item.detail !== null && item.detail !== '' ? ` — ${item.detail}` : ''}`,
      ),
    );
    // Only an owner stop or FYI row has a human Ack/Mark seen control.
    // Gru records a machine disposition through the authenticated API
    // after acting; a human click must not silently clear NEEDS GRU.
    // A closed receipt is machine-attention history: same rule, no Ack.
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
      // History and already-handled rows (acked on ANY device) never toast.
      if (firstRender || notification.ackedAt !== null || notification.resolvedAt !== null) continue;
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
 * already shouts. A CONCLUDED job (merged/done) is a closed receipt: its
 * history renders quiescent and never carries the alert accent. */
export function jobFailing(job: JobView): boolean {
  if (isJobConcluded(job.status)) return false;
  if (job.status === 'blocked' || job.status === 'error') return true;
  const round = job.rounds.at(-1) ?? null;
  if (round === null) return false;
  if (round.status === 'aborted') return true;
  if (round.status !== 'verdict-posted' && round.lenses.some((lens) => lens.state === 'error')) return true;
  return false;
}

type GraphemeSplitter = (text: string) => readonly string[];

/** True when the engine has a real grapheme segmenter. The code-point
 * fallback (very old browsers) cannot see ZWJ emoji clusters or combining
 * sequences, so the invisible-grapheme FILTER inside `heistName` must not
 * run there — it would strip the ZWJ of a family emoji and change the
 * authored label. Visibility is already enforced at every write boundary
 * (ledger + protocol), so skipping the filter on such engines only keeps
 * their rendering faithful to the stored string. */
export const GRAPHEME_SEGMENTATION_AVAILABLE = typeof Intl.Segmenter === 'function';

/** One grapheme splitter serves every rail name and suffix (G8); engines
 * without `Intl.Segmenter` fall back to code points so an old browser
 * renders the rail instead of aborting it (G12). The availability check
 * is re-read at CALL time — a test (or a polyfill) can remove the
 * constructor after module load. */
export function makeGraphemeSplitter(): GraphemeSplitter {
  if (typeof Intl.Segmenter !== 'function') return (text) => [...text];
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return (text) => [...segmenter.segment(text)].map((part) => part.segment);
}

const graphemes: GraphemeSplitter = makeGraphemeSplitter();

/** Named failure for a rail identity the rail's own inputs cannot
 * produce; a miss is a programming error, never a rendered guess. */
export class RailIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RailIdentityError';
  }
}

/** Total lookup over the suffix map `minionSuffixes` computes for the
 * rendered agents; a miss fails loud instead of printing a silent tail. */
export function railSuffix(suffixes: ReadonlyMap<string, string>, id: string): string {
  const suffix = suffixes.get(id);
  if (suffix === undefined) throw new RailIdentityError(`crew rail suffix missing for agent ${id}`);
  return suffix;
}

/** Graphemes that carry no visible ink: format/control characters
 * (ZWSP, ZWJ, bidi marks) and bare combining marks. A grapheme
 * containing a visible base — including a ZWJ emoji cluster — is never
 * dropped. */
const INVISIBLE_GRAPHEME = /^[\p{Cf}\p{Cc}\p{M}\s]+$/u;

// The authored name is shared by a heist. Older titles are shortened only
// for display; the full title stays on the job and in the row's tooltip.
// Invisible-only graphemes are ignored BEFORE the bound is applied: an
// authored name may start with a run of them, and counting those against
// the 24-grapheme bound shortened the readable letters away (r5
// display-correctness warning). The ledger and protocol keep and validate
// the raw authored value; only the shortened rail label filters.
/** Visible form of one rail word: invisible-only graphemes (ZWSP,
 * format/control characters, bare combining marks) are dropped under a
 * REAL segmenter; the code-point fallback returns the word verbatim —
 * code points cannot see that a ZWJ joiner belongs to the cluster, and
 * stripping it there would change the authored label (edge review
 * 2026-10-05). */
export function visibleWord(word: string, segmentationAvailable: boolean): string {
  if (!segmentationAvailable) return word;
  return graphemes(word).filter((part) => !INVISIBLE_GRAPHEME.test(part)).join('');
}

function heistName(source: string | undefined): string {
  if (source === undefined || source.trim() === '') return 'unassigned';
  const words = source.toLowerCase().trim().split(/\s+/u);
  let result = '';
  for (const word of words) {
    const visible = visibleWord(word, GRAPHEME_SEGMENTATION_AVAILABLE);
    if (visible.trim() === '') continue;
    const next = result === '' ? visible : `${result} ${visible}`;
    if (graphemes(next).length > 24 && result !== '') break;
    result = next;
    if (graphemes(result).length >= 24) break;
  }
  // Don't split emoji sequences or combining marks in a long first word.
  const shortened = graphemes(result).slice(0, 24).join('');
  // Write boundaries reject an invisible-only name; a legacy/foreign row
  // that still carries one renders the neutral fallback, never a blank.
  return shortened.trim() === '' ? 'unassigned' : shortened;
}

/** The normally four-character ID suffix; identical suffixes extend on
 * grapheme boundaries (never halving an astral character) until the
 * peers diverge, independent of row order (G11).
 *
 * A peer can only collide at a length >= 4 when both IDs share the same
 * four trailing graphemes, so long IDs are bucketed by that tail: a
 * one-member bucket keeps four characters with no peer scan at all, and
 * only a genuinely colliding bucket extends. IDs shorter than four
 * graphemes cannot extend and are returned whole (unchanged semantics). */
export function minionSuffixes(agents: readonly AgentView[], jobs: ReadonlyMap<string, JobView>): ReadonlyMap<string, string> {
  const groups = new Map<string, string[]>();
  for (const agent of agents) {
    if (agent.role !== 'minion') continue;
    // Missing jobs share the neutral label with null bindings; distinguish
    // their IDs against every other unassigned worker in that one group.
    const key = agent.jobId !== null && jobs.has(agent.jobId) ? agent.jobId : '';
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [agent.id]);
    else bucket.push(agent.id);
  }
  const suffixes = new Map<string, string>();
  const cut = (source: readonly string[], length: number): string =>
    source.slice(source.length - length).join('');
  for (const ids of groups.values()) {
    const parts = new Map(ids.map((id) => [id, graphemes(id)] as const));
    const tails = new Map<string, string[]>();
    for (const [id, own] of parts) {
      if (own.length < 4) {
        suffixes.set(id, own.join(''));
        continue;
      }
      const tail = cut(own, 4);
      const bucket = tails.get(tail);
      if (bucket === undefined) tails.set(tail, [id]);
      else bucket.push(id);
    }
    for (const bucket of tails.values()) {
      if (bucket.length === 1) {
        const only = bucket[0]!;
        suffixes.set(only, cut(parts.get(only) ?? [], 4));
        continue;
      }
      for (const id of bucket) {
        const own = parts.get(id) ?? [];
        // For each ID find the shortest suffix which distinguishes it from
        // every colliding peer at that length, independent of row order.
        let length = 4;
        while (
          length < own.length &&
          bucket.some((peer) => peer !== id && cut(parts.get(peer) ?? [], length) === cut(own, length))
        ) length++;
        suffixes.set(id, cut(own, length));
      }
    }
  }
  return suffixes;
}

function agentLabel(agent: AgentView): string {
  if (agent.label !== null && agent.label !== '') return agent.label;
  return `${agent.role} · ${agent.id.slice(0, 12)}`;
}

/** Roles the service hosts ONE of (the standing crew + bob). Minions are
 * a pool and never duplicate — and NEITHER is perkins: a review round
 * runs its lead alongside specialist children under the same role, so a
 * concurrent-review fan-out is normal, not a duplicate-owner anomaly. */
const SINGLETON_ROLES: ReadonlySet<string> = new Set(['gru', 'silas', 'bob']);

/** Issue #171: agent ids of the live rail's rows whose singleton role has
 * MORE THAN ONE current owner — an unexpected concurrent owner is an
 * anomaly to surface, never to silently discard. Only explicitly-current
 * rows count (unverified rows are already marked ambiguous; a historical
 * epoch of the same role is expected, not an anomaly). */
function duplicatedSingletonRoles(liveAgents: readonly AgentView[]): Set<string> {
  const counts = new Map<string, string[]>();
  for (const agent of liveAgents) {
    if (agentRuntimeOf(agent) !== 'current' || !SINGLETON_ROLES.has(agent.role)) continue;
    const ids = counts.get(agent.role) ?? [];
    ids.push(agent.id);
    counts.set(agent.role, ids);
  }
  const duplicated = new Set<string>();
  for (const ids of counts.values()) {
    if (ids.length > 1) for (const id of ids) duplicated.add(id);
  }
  return duplicated;
}

function formatTs(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
