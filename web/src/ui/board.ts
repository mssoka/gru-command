/**
 * Board view (E6): the live dashboard — repo-grouped job cards with state
 * chips and per-lens round chips, the agent rail (the standing crew), and
 * the notification center. Read-only by design: authorship arrives with
 * the dispatch flow epic.
 */

import {
  agentStateTone,
  jobChipTone,
  lensChipTone,
  type AgentView,
  type BoardSnapshot,
  type JobView,
  type NotificationView,
} from '../lib/board-protocol.js';
import type { BoardClient } from '../lib/board-client.js';
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
  private readonly notificationPanel: HTMLElement;
  private readonly onOpenTranscript: (request: TranscriptOpenRequest) => void;
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
  ) {
    this.mount = mustGet('board-jobs');
    this.notificationBell = mustGet<HTMLButtonElement>('notification-bell');
    this.notificationPanel = mustGet('notification-panel');
    this.onOpenTranscript = onOpenTranscript;
    this.boardClient = boardClient;
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
    this.renderRepos(snapshot);
    this.renderAgents(snapshot.agents);
    this.renderNotifications(snapshot.notifications);
    this.surfaceNewNotifications(previous, snapshot.notifications);
  }

  get current(): BoardSnapshot | null {
    return this.snapshot;
  }

  // ------------------------------------------------------------------
  // Repo-grouped job cards
  // ------------------------------------------------------------------

  private renderRepos(snapshot: BoardSnapshot): void {
    this.mount.replaceChildren();
    if (snapshot.repos.length === 0) {
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
    for (const repo of snapshot.repos) {
      const card = el('section', 'pp-card board-repo reveal');
      const head = el('div', 'board-repo__head');
      head.append(el('h2', 'board-repo__name', `📦 ${repo.name}`), el('span', 'lbl', `${repo.jobs.length} job${repo.jobs.length === 1 ? '' : 's'}`));
      card.append(head);
      for (const job of repo.jobs) card.append(this.jobRow(job));
      this.mount.append(card);
    }
  }

  private jobRow(job: JobView): HTMLElement {
    const row = el('article', 'board-job');
    const title = el('div', 'board-job__title');
    title.append(
      el('span', 'board-job__name', job.title),
      el('span', `pp-chip ${jobChipTone(job.status)}`, job.status),
    );
    row.append(title);
    const meta = el('div', 'board-job__meta lbl');
    meta.textContent = `${job.id} · updated ${formatTs(job.updatedAt)}${job.baseBranch !== null ? ` · base ${job.baseBranch}` : ''}`;
    row.append(meta);
    if (job.note !== null && job.note !== '') row.append(el('div', 'board-job__note', job.note));
    for (const round of job.rounds) {
      const roundRow = el('div', 'board-round');
      const head = el('div', 'board-round__head');
      head.append(
        el('span', 'pp-chip pp-chip--perkins', `round ${round.seq}`),
        el('span', 'lbl', round.status + (round.verdict !== null ? ` · ${round.verdict}` : '')),
      );
      roundRow.append(head);
      const chips = el('div', 'board-round__lenses');
      for (const chip of round.lenses) {
        const node = el(
          'span',
          `pp-chip board-lens ${lensChipTone(chip.state)}`,
          `${LENS_STATE_LABEL[chip.state] ?? '?'} ${chip.lens}`,
        );
        if (chip.state === 'error') node.title = chip.note ?? 'lens errored';
        chips.append(node);
      }
      roundRow.append(chips);
      row.append(roundRow);
    }
    if (job.prUrl !== null) {
      const link = el('a', 'board-job__pr', 'pull request ↗');
      link.href = job.prUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      row.append(link);
    }
    return row;
  }

  // ------------------------------------------------------------------
  // Agent rail
  // ------------------------------------------------------------------

  private renderAgents(agents: readonly AgentView[]): void {
    const rail = mustGet('board-agents');
    rail.replaceChildren();
    if (agents.length === 0) {
      rail.append(el('div', 'lbl', 'no agents yet'));
      return;
    }
    for (const agent of agents) {
      const row = el('button', 'board-agent');
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
        el('span', `pp-chip board-agent__state ${agentStateTone(agent.state)}`, agent.state),
      );
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
      rail.append(row);
    }
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
          `${icon} ${item.title}${item.ackedAt !== null ? ' ✓' : ''}`,
        ),
        el(
          'div',
          'board-notification__meta lbl',
          `${formatTs(item.ts)} · ${item.routing}${item.detail !== null && item.detail !== '' ? ` — ${item.detail}` : ''}`,
        ),
      );
      // Ack button: action-required rows clear through a human ack
      // (acking also re-arms a tripped breaker server-side).
      if (item.ackedAt === null) {
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
      if (firstRender) continue; // history load — no toast spam
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
   * marks seen; an ack from ANY device clears it via ackedAt). */
  private updateBadge(notifications: readonly { id: string; severity: string; ackedAt: string | null }[]): void {
    const unseen = notifications.filter(
      (n) => n.severity === 'error' && n.ackedAt === null && !this.seenErrorIds.has(n.id),
    ).length;
    this.notificationBell.dataset.unread = String(unseen);
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
