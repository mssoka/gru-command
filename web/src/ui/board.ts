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
} from '../lib/board-protocol.js';
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
  private snapshot: BoardSnapshot | null = null;
  /** Error notification ids the user has already seen (panel opened with
   * them present) — the badge counts only UNSEEN errors. */
  private readonly seenErrorIds = new Set<string>();

  constructor(onOpenTranscript: (request: TranscriptOpenRequest) => void) {
    this.mount = mustGet('board-jobs');
    this.notificationBell = mustGet<HTMLButtonElement>('notification-bell');
    this.notificationPanel = mustGet('notification-panel');
    this.onOpenTranscript = onOpenTranscript;
    this.notificationBell.addEventListener('click', () => {
      this.notificationPanel.hidden = !this.notificationPanel.hidden;
      this.notificationBell.dataset.open = String(!this.notificationPanel.hidden);
      if (!this.notificationPanel.hidden) {
        // Opening the panel marks every current error as seen.
        for (const notification of this.snapshot?.notifications ?? []) {
          if (notification.severity === 'error') this.seenErrorIds.add(notification.id);
        }
        this.updateBadge(this.snapshot?.notifications ?? []);
      }
    });
  }

  render(snapshot: BoardSnapshot): void {
    this.snapshot = snapshot;
    this.renderRepos(snapshot);
    this.renderAgents(snapshot.agents);
    this.renderNotifications(snapshot.notifications);
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
      rail.append(row);
    }
  }

  // ------------------------------------------------------------------
  // Notification center
  // ------------------------------------------------------------------

  private renderNotifications(notifications: readonly { id: string; ts: string; severity: string; title: string; detail: string | null }[]): void {
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
      row.append(
        el('div', 'board-notification__title', `${item.severity === 'error' ? '🚨' : 'ℹ️'} ${item.title}`),
        el('div', 'board-notification__meta lbl', `${formatTs(item.ts)}${item.detail !== null && item.detail !== '' ? ` — ${item.detail}` : ''}`),
      );
      list.append(row);
    }
  }

  /** Badge = error-severity items never seen (panel-open marks seen). */
  private updateBadge(notifications: readonly { id: string; severity: string }[]): void {
    const unseen = notifications.filter((n) => n.severity === 'error' && !this.seenErrorIds.has(n.id)).length;
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
