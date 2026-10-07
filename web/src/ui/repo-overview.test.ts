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
    expect(badge.classList.contains('repo-row__badge--done')).toBe(true);
    expect(badge.querySelector('.repo-row__badge-glyph')?.textContent).toBe('✓');
    expect(badge.querySelector('.repo-row__badge-text')?.textContent).toBe('PASSED');
    const counts = [...article.querySelectorAll('.repo-row__metric-count')].map((node) => node.textContent);
    expect(counts).toEqual(['2', '3']);
    expect([...article.querySelectorAll('.repo-row__metric-label')].map((node) => node.textContent)).toEqual([
      'OPEN PRs',
      'OPEN issuesexcl. PRs',
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
});
