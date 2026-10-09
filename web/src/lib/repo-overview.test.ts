import { describe, expect, it } from 'vitest';
import type { RepoOverviewRowView, RepoOverviewRunState } from './board-protocol.js';
import {
  repoAgeParts,
  repoBadgeTitle,
  repoCiView,
  repoRowAriaLabel,
  repoRowBadge,
  repoRowNote,
  repoRunBadge,
  repoRunContextTitle,
} from './repo-overview.js';

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
      runCreatedAt: CHECKED,
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

describe('managed repository overview — badge model', () => {
  it('gives every run state visible text, a glyph and a tone', () => {
    const cases: ReadonlyArray<readonly [RepoOverviewRunState, string, string, string]> = [
      ['passed', 'PASSED', '✓', 'done'],
      ['failed', 'FAILED', '✕', 'alert'],
      ['timed-out', 'TIMED OUT', '⏱', 'alert'],
      ['startup-failure', 'STARTUP FAILED', '✕', 'alert'],
      ['action-required', 'ACTION REQUIRED', '!', 'alert'],
      ['cancelled', 'CANCELLED', '⊘', 'park'],
      ['skipped', 'SKIPPED', '—', 'park'],
      ['neutral', 'NEUTRAL', '—', 'park'],
      ['stale-run', 'STALE RUN', '⌛', 'park'],
      ['running', 'RUNNING', '↻', 'work'],
      ['queued', 'QUEUED', '⋯', 'work'],
      ['no-workflow', 'NO WORKFLOW', '∅', 'park'],
      ['never-run', 'NO RUNS', '—', 'park'],
      ['no-branch', 'NO BRANCH', '—', 'park'],
      ['unavailable', 'UNAVAILABLE', '!', 'park'],
      ['unknown', 'UNKNOWN', '?', 'park'],
    ];
    for (const [state, text, glyph, tone] of cases) {
      expect(repoRunBadge(state)).toEqual({ text, glyph, tone });
    }
  });

  it('overlays freshness and not-linked so cached data never shows as current', () => {
    expect(repoRowBadge(row())).toEqual({ text: 'PASSED', glyph: '✓', tone: 'done' });
    expect(repoRowBadge(row({ freshness: 'unchecked', checkedAt: null, lastAttemptAt: null }))).toEqual({
      text: 'NOT CHECKED',
      glyph: '?',
      tone: 'park',
    });
    expect(repoRowBadge(row({ freshness: 'unavailable', checkedAt: null, error: 'HTTP 500' }))).toEqual({
      text: 'UNAVAILABLE',
      glyph: '!',
      tone: 'park',
    });
    expect(repoRowBadge(row({ freshness: 'stale', error: 'HTTP 500' }))).toEqual({
      text: 'STALE · last passed',
      glyph: '⌛',
      tone: 'park',
    });
    expect(
      repoRowBadge(
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
      ),
    ).toEqual({ text: 'NOT LINKED', glyph: '!', tone: 'park' });
  });

  it('keeps a stale overlay honest about what the last observation was', () => {
    const failed = row({ freshness: 'stale', error: 'HTTP 500', run: { ...row().run!, state: 'failed' } });
    expect(repoRowBadge(failed).text).toBe('STALE · last failed');
    const noWorkflow = row({ freshness: 'stale', error: 'HTTP 500', run: { ...row().run!, state: 'no-workflow' } });
    expect(repoRowBadge(noWorkflow).text).toBe('STALE · last no workflow');
  });
});

describe('managed repository overview — meta and notes', () => {
  it('renders the checked age from the successful fetch and never from render time', () => {
    expect(repoAgeParts(row())).toEqual([{ kind: 'age', since: CHECKED, prefix: 'Checked ', suffix: ' ago' }]);
    expect(repoAgeParts(row({ freshness: 'unchecked', checkedAt: null, lastAttemptAt: null }))).toEqual([
      { kind: 'text', text: 'Not checked yet' },
    ]);
    expect(repoAgeParts(row({ freshness: 'unavailable', checkedAt: null, error: 'HTTP 500' }))).toEqual([
      { kind: 'age', since: CHECKED, prefix: 'Fetch failed ', suffix: ' ago' },
    ]);
    const staleFailed = row({
      freshness: 'stale',
      checkedAt: CHECKED,
      lastAttemptAt: '2026-10-07T12:30:00.000Z',
      error: 'HTTP 500',
    });
    expect(repoAgeParts(staleFailed)).toEqual([
      { kind: 'age', since: CHECKED, prefix: 'Checked ', suffix: ' ago' },
      { kind: 'text', text: ' · ' },
      { kind: 'age', since: '2026-10-07T12:30:00.000Z', prefix: 'fetch failed ', suffix: ' ago' },
    ]);
  });

  it('derives the CI context from the run, linking only when a workflow and URL exist', () => {
    expect(repoCiView(row())).toEqual({
      label: 'checks',
      workflow: 'checks',
      url: 'https://github.com/acme/alpha/actions/runs/12',
      branch: 'main',
    });
    expect(repoCiView(row({ run: { ...row().run!, state: 'no-workflow', workflow: null, url: null } }))).toEqual({
      label: 'none',
      workflow: null,
      url: null,
      branch: 'main',
    });
    // A missing workflow name is never fabricated; with a validated run
    // URL the link is offered under a run-number label, without one it is
    // a dash.
    expect(repoCiView(row({ run: { ...row().run!, workflow: null, url: null } }))).toEqual({
      label: '—',
      workflow: null,
      url: null,
      branch: 'main',
    });
    expect(repoCiView(row({ run: { ...row().run!, workflow: null } }))).toEqual({
      label: 'run #12',
      workflow: null,
      url: 'https://github.com/acme/alpha/actions/runs/12',
      branch: 'main',
    });
    expect(
      repoCiView(row({ run: { ...row().run!, state: 'never-run', workflow: null, url: null, branch: 'trunk' } })),
    ).toEqual({ label: '—', workflow: null, url: null, branch: 'trunk' });
    expect(
      repoCiView(
        row({
          linked: false,
          host: null,
          link: null,
          linkReason: 'non-GitHub remote',
          fullName: null,
          openPrs: null,
          openIssues: null,
          run: null,
          freshness: 'unchecked',
          checkedAt: null,
          lastAttemptAt: null,
        }),
      ),
    ).toEqual({ label: '—', workflow: null, url: null, branch: null });
  });

  it('discloses precedence, no-health-claim, cancelled and no-run semantics', () => {
    expect(repoRowNote(row())).toBeNull();
    expect(repoRowNote(row({ run: { ...row().run!, state: 'running', conclusion: null, status: 'in_progress' } }))).toContain(
      'older results are not shown as current',
    );
    expect(repoRowNote(row({ run: { ...row().run!, state: 'queued', conclusion: null, status: 'queued' } }))).toContain(
      'not shown as current',
    );
    expect(repoRowNote(row({ run: { ...row().run!, state: 'cancelled', conclusion: 'cancelled' } }))).toContain(
      'neither pass nor failure',
    );
    expect(
      repoRowNote(row({ run: { ...row().run!, state: 'never-run', workflow: null, url: null, branch: 'trunk' } })),
    ).toBe('No workflow run on trunk yet.');
    expect(repoRowNote(row({ run: { ...row().run!, state: 'unavailable' } }))).toContain('Actions is unavailable');
    expect(
      repoRowNote(
        row({ run: { ...row().run!, state: 'no-branch', workflow: null, url: null, branch: null } }),
      ),
    ).toBe('No default branch exists on this repository yet.');
    expect(repoRowNote(row({ run: { ...row().run!, state: 'unknown' } }))).toContain('could not be classified');
    expect(repoRowNote(row({ freshness: 'stale', error: null, lastAttemptAt: null }))).toBe(
      'Cached result — not current health; the last check is older than the refresh cadence.',
    );
    expect(repoRowNote(row({ freshness: 'stale', error: 'GitHub rate limit (HTTP 403)' }))).toContain(
      'not current health; the fresh fetch failed',
    );
    expect(repoRowNote(row({ freshness: 'unavailable', checkedAt: null, error: 'HTTP 500' }))).toContain(
      'the last fetch failed: HTTP 500',
    );
    const unlinked = row({
      linked: false,
      host: null,
      link: null,
      linkReason: 'non-GitHub remote',
      fullName: null,
      openPrs: null,
      openIssues: null,
      run: null,
      freshness: 'unchecked',
      checkedAt: null,
      lastAttemptAt: null,
    });
    expect(repoRowNote(unlinked)).toContain('non-GitHub remote');
  });

  it('names unknown counts in the accessible summary instead of guessing zero', () => {
    const badge = repoRowBadge(row());
    expect(repoRowAriaLabel(row(), badge)).toBe('alpha — PASSED — 2 open pull requests, 3 open issues excluding pull requests');
    const unknown = row({ openPrs: null, openIssues: null });
    expect(repoRowAriaLabel(unknown, repoRowBadge(unknown))).toContain('unknown open pull requests, unknown open issues');
  });
  it('renders the raw provider context that the protocol validates', () => {
    expect(repoBadgeTitle(row())).toBe('completed / success');
    expect(repoRunContextTitle(row())).toContain('provider status: completed');
    expect(repoRunContextTitle(row())).toContain('run #12');
    // Creation and start stay distinct in the disclosure.
    expect(repoRunContextTitle(row())).toContain('created 2026-10-07T12:00:00.000Z');
    expect(repoRunContextTitle(row())).toContain('started 2026-10-07T12:00:00.000Z');
    const queued = row({
      run: {
        ...row().run!,
        runStartedAt: null,
        runCreatedAt: '2026-10-07T11:00:00.000Z',
      },
    });
    expect(repoRunContextTitle(queued)).toContain('created 2026-10-07T11:00:00.000Z');
    expect(repoRunContextTitle(queued)).not.toContain('started ');
    expect(repoRunContextTitle(row({ run: { ...row().run!, status: null } }))).toBeNull();
    expect(repoRunContextTitle(row({ run: null }))).toBeNull();
  });
});