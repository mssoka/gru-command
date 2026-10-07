// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import type { RepoOverviewRowView, RepoOverviewView } from '../lib/board-protocol.js';
import { el } from './dom.js';
import { RepoOverviewPanel } from './repo-overview.js';

const CHECKED = '2026-10-07T12:00:00.000Z';

function row(over: Partial<RepoOverviewRowView> = {}): RepoOverviewRowView {
  return {
    key: 'alpha',
    displayName: 'alpha',
    linked: true,
    host: 'github.com',
    link: 'https://github.com/acme/alpha',
    linkReason: null,
    fullName: 'acme/alpha',
    openPrs: 2,
    openIssues: 3,
    run: {
      state: 'passed',
      status: 'completed',
      conclusion: 'success',
      workflow: 'checks',
      branch: 'main',
      runNumber: 12,
      url: 'https://github.com/acme/alpha/actions/runs/12',
      runStartedAt: CHECKED,
      runUpdatedAt: CHECKED,
    },
    freshness: 'fresh',
    checkedAt: CHECKED,
    lastAttemptAt: CHECKED,
    error: null,
    ...over,
  };
}

function panel(): { mount: HTMLElement; view: RepoOverviewPanel } {
  const mount = el('section', 'repo-overview');
  document.body.replaceChildren(mount);
  return {
    mount,
    view: new RepoOverviewPanel(mount, {
      ageNode: (className, since, prefix = '', suffix = '') => {
        const node = el('span', className);
        node.dataset.since = since ?? '';
        node.textContent = `${prefix}${since}${suffix}`;
        return node;
      },
    }),
  };
}

describe('managed repository overview panel', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('renders nothing when the feature is absent or has not refreshed yet', () => {
    const { mount, view } = panel();
    view.render(null);
    expect(mount.childElementCount).toBe(0);
    view.render(undefined);
    expect(mount.childElementCount).toBe(0);
  });

  it('renders an explicit empty-registry note instead of an empty list', () => {
    const { mount, view } = panel();
    view.render({ rows: [] } satisfies RepoOverviewView);
    expect(mount.textContent).toContain('Managed repositories');
    expect(mount.textContent).toContain('No managed repositories found under the configured workspace root.');
    expect(mount.querySelector('.repo-overview__list')).toBeNull();
  });

  it('renders one row per repository with identity, counts, CI context, checked age and safe links', () => {
    const { mount, view } = panel();
    view.render({ rows: [row()] });
    // The approved disclosure is pinned: default-branch CI only, never a
    // deployment-health claim.
    const caption = mount.querySelector('.repo-overview__sub')?.textContent ?? '';
    expect(caption).toContain('default-branch CI only');
    expect(caption).toContain('not deployment health');
    const article = mount.querySelector<HTMLElement>('.repo-row')!;
    expect(article.dataset.runState).toBe('passed');
    expect(article.dataset.freshness).toBe('fresh');
    const name = article.querySelector<HTMLAnchorElement>('.repo-row__name')!;
    expect(name.textContent).toBe('alpha');
    expect(name.href).toBe('https://github.com/acme/alpha');
    expect(name.target).toBe('_blank');
    expect(name.rel).toBe('noopener noreferrer');
    expect(name.title).toBe('acme/alpha on GitHub');
    const badge = article.querySelector('.repo-row__badge')!;
    // The established tone contract is what colours the chip (there are no
    // repo-row__badge--<tone> rules); the browser spec pins the computed
    // colour difference between tones.
    expect(badge.classList.contains('pp-chip--done')).toBe(true);
    expect(badge.querySelector('.repo-row__badge-glyph')?.textContent).toBe('✓');
    expect(badge.querySelector('.repo-row__badge-text')?.textContent).toBe('PASSED');
    const counts = [...article.querySelectorAll('.repo-row__metric-count')].map((node) => node.textContent);
    expect(counts).toEqual(['2', '3']);
    expect([...article.querySelectorAll('.repo-row__metric-label')].map((node) => node.textContent)).toEqual([
      'OPEN PRs',
      'OPEN issues excl. PRs',
    ]);
    const ciLink = article.querySelector<HTMLAnchorElement>('.repo-row__ci-link')!;
    expect(ciLink.textContent).toBe('checks');
    expect(ciLink.href).toBe('https://github.com/acme/alpha/actions/runs/12');
    expect(article.querySelector('.repo-row__ci')?.textContent).toBe('CI: checks · main');
    expect(article.querySelector('.repo-row__age')?.textContent).toContain('Checked ');
    expect(article.getAttribute('aria-label')).toBe(
      'alpha — PASSED — 2 open pull requests, 3 open issues excluding pull requests',
    );
  });

  it('shows exact zero counts and an em dash for unproven counts', () => {
    const { mount, view } = panel();
    view.render({ rows: [row({ openPrs: 0, openIssues: 0 }), row({ key: 'beta', displayName: 'beta', openPrs: null, openIssues: null })] });
    const counts = [...mount.querySelectorAll('.repo-row__metric-count')].map((node) => node.textContent);
    expect(counts).toEqual(['0', '0', '—', '—']);
    expect(mount.querySelectorAll('.repo-row__metric-count')[2]?.getAttribute('title')).toContain('not proven');
  });

  it('renders a not-linked row with its reason, no link and no invented counts', () => {
    const { mount, view } = panel();
    view.render({
      rows: [
        row({
          linked: false,
          host: null,
          link: null,
          linkReason: 'no usable origin remote',
          fullName: null,
          openPrs: null,
          openIssues: null,
          run: null,
          freshness: 'unchecked',
          checkedAt: null,
          lastAttemptAt: null,
        }),
      ],
    });
    const article = mount.querySelector<HTMLElement>('.repo-row')!;
    expect(article.querySelector('.repo-row__name')?.tagName).toBe('SPAN');
    expect(article.querySelector('.repo-row__badge-text')?.textContent).toBe('NOT LINKED');
    expect(article.querySelector('.repo-row__note')?.textContent).toContain('no usable origin remote');
    expect(article.dataset.runState).toBe('unlinked');
  });

  it('renders the stale overlay and the no-health-claim note for cached data', () => {
    const { mount, view } = panel();
    view.render({
      rows: [row({ freshness: 'stale', lastAttemptAt: '2026-10-07T12:30:00.000Z', error: 'GitHub rate limit (HTTP 403)' })],
    });
    const article = mount.querySelector<HTMLElement>('.repo-row')!;
    expect(article.querySelector('.repo-row__badge-text')?.textContent).toBe('STALE · last passed');
    expect(article.querySelector('.repo-row__note')?.textContent).toContain('not current health');
    expect(article.dataset.freshness).toBe('stale');
  });

  it('renders hostile provider labels as inert text, never markup, and refuses non-https hrefs', () => {
    const { mount, view } = panel();
    view.render({
      rows: [
        row({
          displayName: '<img src=x onerror=alert(1)>',
          run: { ...row().run!, workflow: '<script>alert(2)</script>', url: 'javascript:alert(3)' },
        }),
      ],
    });
    const article = mount.querySelector<HTMLElement>('.repo-row')!;
    expect(article.querySelector('img, script')).toBeNull();
    expect(article.querySelector('.repo-row__name')?.textContent).toBe('<img src=x onerror=alert(1)>');
    // The invalid URL fails the render-side guard: the workflow stays text.
    expect(article.querySelector('.repo-row__ci-link')).toBeNull();
    expect(article.querySelector('.repo-row__ci')?.textContent).toContain('<script>alert(2)</script>');
  });

  it('keeps the list ordered as delivered and carries stable hooks per row', () => {
    const { mount, view } = panel();
    view.render({
      rows: [
        row({ key: 'alpha', displayName: 'alpha', run: { ...row().run!, state: 'running', status: 'in_progress' } }),
        row({ key: 'beta', displayName: 'beta', run: { ...row().run!, state: 'no-workflow', workflow: null, url: null } }),
      ],
    });
    const rows = [...mount.querySelectorAll<HTMLElement>('.repo-row')];
    expect(rows.map((node) => node.querySelector('.repo-row__name')?.textContent)).toEqual(['alpha', 'beta']);
    expect(rows.map((node) => node.dataset.runState)).toEqual(['running', 'no-workflow']);
    expect(rows[1]?.querySelector('.repo-row__ci')?.textContent).toBe('CI: none · main');
  });

  it('preserves the list scroll position and focused link across snapshot rebuilds', () => {
    const { mount, view } = panel();
    view.render({ rows: [row()] });
    const list = mount.querySelector<HTMLElement>('.repo-overview__list')!;
    list.scrollTop = 120;
    expect(list.scrollTop).toBe(120);
    const link = mount.querySelector<HTMLAnchorElement>('a.repo-row__name')!;
    link.focus();
    expect(document.activeElement).toBe(link);

    view.render({ rows: [row({ openPrs: 9 })] });
    expect(mount.querySelector<HTMLElement>('.repo-overview__list')?.scrollTop).toBe(120);
    expect(document.activeElement).toBe(mount.querySelector('a.repo-row__name'));

    // A push that removes the focused row (or the whole feature) never
    // throws and leaves the section in its honest empty/hidden state.
    view.render({ rows: [] });
    expect(mount.textContent).toContain('No managed repositories');
    view.render(null);
    expect(mount.childElementCount).toBe(0);
  });

  it('renders a live push that drops the overview back to empty', () => {
    const { mount, view } = panel();
    view.render({ rows: [row(), row({ key: 'beta', displayName: 'beta' })] });
    expect(mount.querySelectorAll('.repo-row')).toHaveLength(2);
    view.render({ rows: [] });
    expect(mount.querySelectorAll('.repo-row')).toHaveLength(0);
  });

  it('restores the remembered scroll when a push lands while the panel is hidden', async () => {
    const { mount, view } = panel();
    view.render({ rows: [row()] });
    const list = mount.querySelector<HTMLElement>('.repo-overview__list')!;
    list.scrollTop = 240;
    list.dispatchEvent(new Event('scroll'));
    // Simulate the browser's hidden-panel semantics: [hidden] removes the
    // box, the element reports scrollTop 0, and the render's assignment is
    // discarded — the reveal restores through the mutation observer.
    mount.hidden = true;
    list.scrollTop = 0;
    view.render({ rows: [row(), row({ key: 'beta', displayName: 'beta' })] });
    mount.hidden = false;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mount.querySelector<HTMLElement>('.repo-overview__list')?.scrollTop).toBe(240);
  });

  it('keeps keyboard position inside the module when the focused row disappears', () => {
    const { mount, view } = panel();
    view.render({
      rows: [
        row(),
        row({ key: 'beta', displayName: 'beta', link: 'https://github.com/acme/beta', fullName: 'acme/beta' }),
      ],
    });
    const ciLinks = mount.querySelectorAll<HTMLAnchorElement>('.repo-row__ci-link');
    (ciLinks[1] as HTMLAnchorElement).focus();
    // The focused (last) row is gone; focus lands on the control nearest
    // its old position — the first row's CI link — not the first control
    // and never the body.
    view.render({ rows: [row()] });
    expect(document.activeElement).toBe(mount.querySelector('a.repo-row__ci-link'));

    // When every control disappears focus stays on the module itself.
    view.render({ rows: [] });
    expect(document.activeElement).toBe(mount);
  });

  it('fails closed on a link whose host differs from the row host, even if validation was bypassed', () => {
    const { mount, view } = panel();
    view.render({ rows: [row({ link: 'https://evil.example/acme/alpha', host: 'github.com' })] });
    expect(mount.querySelector('a.repo-row__name')).toBeNull();
    expect(mount.querySelector('.repo-row__name')?.textContent).toBe('alpha');
  });

  it('carries the raw provider context as accessible titles', () => {
    const { mount, view } = panel();
    view.render({ rows: [row()] });
    expect(mount.querySelector('.repo-row__badge')?.getAttribute('title')).toBe('provider: completed / success');
    const ci = mount.querySelector('.repo-row__ci')!;
    expect(ci.getAttribute('title')).toContain('run #12');
    expect(ci.textContent).toBe('CI: checks · main');
  });

  it('renders a branchless row without an invented branch suffix', () => {
    const { mount, view } = panel();
    view.render({
      rows: [
        row({
          run: { ...row().run!, state: 'no-branch', workflow: null, url: null, branch: null, status: null, conclusion: null },
        }),
      ],
    });
    expect(mount.querySelector('.repo-row__ci')?.textContent).toBe('CI: —');
    expect(mount.querySelector('.repo-row__note')?.textContent).toContain('No default branch exists');
  });

  it('hands focus back to the CREW tab when the module disappears on a push', () => {
    const { mount, view } = panel();
    const tab = document.createElement('button');
    tab.id = 'rail-tab-agents';
    document.body.append(tab);
    view.render({ rows: [row()] });
    mount.querySelector<HTMLAnchorElement>('a.repo-row__name')!.focus();
    view.render(null);
    expect(document.activeElement).toBe(tab);

    // The module itself can own focus (nearest-survivor fallback); that
    // case must hand back too.
    tab.blur();
    view.render({ rows: [row()] });
    mount.focus();
    expect(document.activeElement).toBe(mount);
    view.render(null);
    expect(document.activeElement).toBe(tab);
  });

  it('links an unnamed workflow run under its run-number label', () => {
    const { mount, view } = panel();
    view.render({ rows: [row({ run: { ...row().run!, workflow: null } })] });
    const link = mount.querySelector<HTMLAnchorElement>('.repo-row__ci-link');
    expect(link?.textContent).toBe('run #12');
    expect(link?.href).toBe('https://github.com/acme/alpha/actions/runs/12');
  });
});