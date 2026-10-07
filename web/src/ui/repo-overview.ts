/**
 * Managed repository overview — the compact-row panel rendered inside the
 * crew rail, below the crew list (owner-approved Option A). Read-only:
 * rows disclose GitHub state and link out; nothing here ACKs, executes or
 * changes GitHub state. One list, shared border; status always carries
 * visible text + glyph as well as colour.
 */
import type { RepoOverviewRowView, RepoOverviewView } from '../lib/board-protocol.js';
import {
  repoAgeParts,
  repoBadgeTitle,
  repoCiView,
  repoRowAriaLabel,
  repoRowBadge,
  repoRowNote,
  repoRunContextTitle,
} from '../lib/repo-overview.js';
import { el } from './dom.js';

export interface RepoOverviewPanelDeps {
  /** The board's shared age counter (keeps "Checked 2m ago" ticking). */
  readonly ageNode: (className: string, since: string | null, prefix?: string, suffix?: string) => HTMLElement;
}

/** href assignment is fail-closed: anything but https stays unlinked. */
function safeHref(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

export class RepoOverviewPanel {
  private readonly mount: HTMLElement;
  private readonly deps: RepoOverviewPanelDeps;
  /** Last observable list scroll offset (survives hidden-tab pushes). */
  private lastScrollTop = 0;

  constructor(mount: HTMLElement, deps: RepoOverviewPanelDeps) {
    this.mount = mount;
    this.deps = deps;
  }

  /** `null`/`undefined` (feature not wired or no refresh yet) renders
   * nothing — the CSS `:empty` rule hides the section. Scroll position and
   * the focused row survive the board's periodic full-snapshot rebuilds. */
  render(view: RepoOverviewView | null | undefined): void {
    const previousList = this.mount.querySelector<HTMLElement>('.repo-overview__list');
    const previousScroll = previousList?.scrollTop ?? 0;
    // A hidden panel ([hidden] on the TRANSCRIPTS tab) reports scrollTop 0
    // in a real browser: remember the last observable offset so a push
    // received while hidden restores the operator's place on return.
    if (previousList !== null && (previousList.offsetHeight > 0 || previousScroll > 0)) {
      this.lastScrollTop = previousScroll;
    }
    const active = document.activeElement;
    const focusKey =
      active instanceof HTMLElement && this.mount.contains(active) ? (active.dataset.focusKey ?? null) : null;
    this.mount.replaceChildren();
    if (view === null || view === undefined) return;
    const head = el('div', 'repo-overview__head');
    head.append(el('strong', 'repo-overview__title', '📁 Managed repositories'));
    this.mount.append(
      head,
      el(
        'p',
        'repo-overview__sub',
        'Actions = default-branch CI only · not deployment health',
      ),
    );
    if (view.rows.length === 0) {
      this.mount.append(
        el('p', 'repo-overview__empty', 'No managed repositories found under the configured workspace root.'),
      );
      return;
    }
    const list = el('div', 'repo-overview__list');
    for (const row of view.rows) list.append(this.row(row));
    // User scrolls are the authoritative offset (renders capture it too,
    // but a hidden panel reports 0 — the listener preserves the real one).
    list.addEventListener('scroll', () => {
      this.lastScrollTop = list.scrollTop;
    });
    this.mount.append(list);
    list.scrollTop = this.lastScrollTop;
    if (focusKey !== null) {
      const controls = [...this.mount.querySelectorAll<HTMLElement>('[data-focus-key]')];
      // The exact row may have disappeared between pushes: keep the
      // keyboard position inside the module on the nearest survivor
      // instead of dropping focus to the body.
      (controls.find((node) => node.dataset.focusKey === focusKey) ?? controls[0])?.focus();
    }
  }

  private row(row: RepoOverviewRowView): HTMLElement {
    const badge = repoRowBadge(row);
    const article = el('article', 'repo-row');
    article.dataset.freshness = row.freshness;
    article.dataset.runState = row.linked ? (row.run?.state ?? 'none') : 'unlinked';
    article.setAttribute('aria-label', repoRowAriaLabel(row, badge));

    const top = el('div', 'repo-row__top');
    top.append(this.repoName(row), this.badgeNode(row, badge));
    article.append(top, this.metrics(row), this.meta(row));

    const note = repoRowNote(row);
    if (note !== null) {
      const isWarning = !row.linked || row.freshness === 'unavailable' || row.freshness === 'stale';
      article.append(el('p', `repo-row__note${isWarning ? '' : ' repo-row__note--grey'}`, note));
    }
    return article;
  }

  private repoName(row: RepoOverviewRowView): HTMLElement {
    const href = row.linked ? safeHref(row.link) : null;
    if (href === null) {
      return el('span', 'repo-row__name', row.displayName);
    }
    const link = el('a', 'repo-row__name', row.displayName);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.dataset.focusKey = `repo:${row.key}`;
    link.title = row.fullName !== null ? `${row.fullName} on GitHub` : 'open repository on GitHub';
    return link;
  }

  private badgeNode(row: RepoOverviewRowView, badge: ReturnType<typeof repoRowBadge>): HTMLElement {
    // The established tone contract (pp-chip--<tone>) is the ONLY chip
    // colour mechanism in the loaded stylesheets; emitting it here keeps
    // status colour visible in both themes and pinned by the browser spec.
    const node = el('span', `pp-chip pp-chip--${badge.tone} repo-row__badge`);
    const provider = repoBadgeTitle(row);
    if (provider !== null) node.title = `provider: ${provider}`;
    const glyph = el('span', 'repo-row__badge-glyph', badge.glyph);
    glyph.setAttribute('aria-hidden', 'true');
    node.append(glyph, el('span', 'repo-row__badge-text', badge.text));
    return node;
  }

  private metrics(row: RepoOverviewRowView): HTMLElement {
    const metrics = el('div', 'repo-row__metrics');
    metrics.append(
      this.metric(row.openPrs, 'OPEN PRs', 'open pull requests'),
      this.metric(row.openIssues, 'OPEN issues', 'open issues excluding pull requests', 'excl. PRs'),
    );
    return metrics;
  }

  private metric(value: number | null, label: string, title: string, subLabel?: string): HTMLElement {
    const metric = el('div', 'repo-row__metric');
    const count = el('strong', 'repo-row__metric-count', value === null ? '—' : String(value));
    count.title = value === null ? `${title}: not proven` : `${value} ${title}`;
    const caption = el('span', 'repo-row__metric-label', label);
    if (subLabel !== undefined) caption.append(el('em', 'repo-row__metric-sub', subLabel));
    metric.append(count, caption);
    return metric;
  }

  private meta(row: RepoOverviewRowView): HTMLElement {
    const meta = el('div', 'repo-row__meta');
    const ci = repoCiView(row);
    const ciNode = el('span', 'repo-row__ci');
    ciNode.append(el('b', 'repo-row__ci-label', 'CI: '));
    const href = safeHref(ci.url);
    if (href !== null && ci.workflow !== null) {
      const workflow = el('a', 'repo-row__ci-link', ci.workflow);
      workflow.href = href;
      workflow.target = '_blank';
      workflow.rel = 'noopener noreferrer';
      workflow.dataset.focusKey = `repo-run:${row.key}`;
      ciNode.append(workflow);
    } else {
      ciNode.append(document.createTextNode(ci.label));
    }
    if (ci.branch !== null) ciNode.append(document.createTextNode(` · ${ci.branch}`));
    const context = repoRunContextTitle(row);
    if (context !== null) ciNode.title = context;
    meta.append(ciNode);

    const age = el('span', 'repo-row__age');
    for (const part of repoAgeParts(row)) {
      if (part.kind === 'age') {
        age.append(this.deps.ageNode('repo-row__age-part', part.since, part.prefix, part.suffix));
      } else {
        age.append(document.createTextNode(part.text));
      }
    }
    meta.append(age);
    return meta;
  }
}
