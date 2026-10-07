/**
 * Managed repository overview — pure presentation model (compact rows A).
 *
 * One derivation for badge, CI context, age and notes so the panel and
 * its tests read the same rules: colour is never the only cue (every
 * badge carries text and a glyph), a cached result never reads as current
 * health, and nothing here claims deployment/health semantics. Provider
 * strings are display text only; hrefs stay https-or-nothing.
 */
import type { RepoOverviewRowView, RepoOverviewRunState } from './board-protocol.js';

export type RepoBadgeTone = 'work' | 'done' | 'alert' | 'park';

export interface RepoBadge {
  readonly text: string;
  readonly glyph: string;
  readonly tone: RepoBadgeTone;
}

const RUN_BADGES: Readonly<Record<RepoOverviewRunState, RepoBadge>> = {
  passed: { text: 'PASSED', glyph: '✓', tone: 'done' },
  failed: { text: 'FAILED', glyph: '✕', tone: 'alert' },
  'timed-out': { text: 'TIMED OUT', glyph: '⏱', tone: 'alert' },
  'startup-failure': { text: 'STARTUP FAILED', glyph: '✕', tone: 'alert' },
  'action-required': { text: 'ACTION REQUIRED', glyph: '!', tone: 'alert' },
  cancelled: { text: 'CANCELLED', glyph: '⊘', tone: 'park' },
  skipped: { text: 'SKIPPED', glyph: '—', tone: 'park' },
  neutral: { text: 'NEUTRAL', glyph: '—', tone: 'park' },
  'stale-run': { text: 'STALE RUN', glyph: '⌛', tone: 'park' },
  running: { text: 'RUNNING', glyph: '↻', tone: 'work' },
  queued: { text: 'QUEUED', glyph: '⋯', tone: 'work' },
  'no-workflow': { text: 'NO WORKFLOW', glyph: '∅', tone: 'park' },
  'never-run': { text: 'NO RUNS', glyph: '—', tone: 'park' },
  unavailable: { text: 'UNAVAILABLE', glyph: '!', tone: 'park' },
  unknown: { text: 'UNKNOWN', glyph: '?', tone: 'park' },
};

export function repoRunBadge(state: RepoOverviewRunState): RepoBadge {
  return RUN_BADGES[state];
}

/** Row-level badge: freshness/not-linked overlays replace the run badge so
 * cached or absent data can never present the last outcome as current. */
export function repoRowBadge(row: RepoOverviewRowView): RepoBadge {
  if (!row.linked) return { text: 'NOT LINKED', glyph: '!', tone: 'park' };
  if (row.freshness === 'unchecked') return { text: 'NOT CHECKED', glyph: '?', tone: 'park' };
  if (row.freshness === 'unavailable') return { text: 'UNAVAILABLE', glyph: '!', tone: 'park' };
  if (row.freshness === 'stale') {
    const last = row.run === null ? 'checked' : RUN_BADGES[row.run.state].text.toLowerCase();
    return { text: `STALE · last ${last}`, glyph: '⌛', tone: 'park' };
  }
  return RUN_BADGES[row.run?.state ?? 'unknown'];
}

/** Age/meta parts: live age counters keep ticking via the board's shared
 * ticker; static states render as text. */
export type RepoAgePart =
  | {
      readonly kind: 'age';
      readonly since: string;
      readonly prefix: string;
      readonly suffix: string;
    }
  | { readonly kind: 'text'; readonly text: string };

export function repoAgeParts(row: RepoOverviewRowView): readonly RepoAgePart[] {
  if (!row.linked) return [{ kind: 'text', text: 'Not linked' }];
  if (row.freshness === 'unchecked') return [{ kind: 'text', text: 'Not checked yet' }];
  if (row.freshness === 'unavailable') {
    return row.lastAttemptAt !== null
      ? [{ kind: 'age', since: row.lastAttemptAt, prefix: 'Fetch failed ', suffix: ' ago' }]
      : [{ kind: 'text', text: 'Fetch failed' }];
  }
  const parts: RepoAgePart[] = [];
  if (row.checkedAt !== null) {
    parts.push({ kind: 'age', since: row.checkedAt, prefix: 'Checked ', suffix: ' ago' });
  }
  if (row.freshness === 'stale' && row.error !== null && row.lastAttemptAt !== null) {
    parts.push({ kind: 'text', text: ' · ' });
    parts.push({ kind: 'age', since: row.lastAttemptAt, prefix: 'fetch failed ', suffix: ' ago' });
  }
  if (parts.length === 0) parts.push({ kind: 'text', text: 'Not checked yet' });
  return parts;
}

/** The CI context pieces: workflow (linkable only with a validated https
 * run URL) · the actual branch the run was read from. */
export interface RepoCiView {
  readonly label: string;
  readonly workflow: string | null;
  readonly url: string | null;
  readonly branch: string | null;
}

export function repoCiView(row: RepoOverviewRowView): RepoCiView {
  const run = row.run;
  if (!row.linked || run === null) return { label: '—', workflow: null, url: null, branch: null };
  const noWorkflow = run.state === 'no-workflow';
  return {
    // No workflow name from the provider is disclosed as a dash — never a
    // fabricated "workflow" label on a row whose contract is "missing is
    // never manufactured".
    label: noWorkflow ? 'none' : (run.workflow ?? '—'),
    workflow: noWorkflow ? null : run.workflow,
    url: run.url !== null && run.workflow !== null && !noWorkflow ? run.url : null,
    branch: run.branch,
  };
}

/** The disclosure line under a row; null when nothing needs saying. */
export function repoRowNote(row: RepoOverviewRowView): string | null {
  if (!row.linked) {
    return row.linkReason !== null
      ? `No GitHub link (${row.linkReason}) — no repository data is fetched.`
      : 'No GitHub link — no repository data is fetched.';
  }
  if (row.freshness === 'unavailable') {
    return row.error !== null
      ? `No data — the last fetch failed: ${row.error}`
      : 'No data — the last fetch failed.';
  }
  if (row.freshness === 'stale') {
    return row.error !== null
      ? `Cached result — not current health; the fresh fetch failed: ${row.error}`
      : 'Cached result — not current health; the last check is older than the refresh cadence.';
  }
  const run = row.run;
  if (run === null) return null;
  switch (run.state) {
    case 'running':
      return 'Newest run in progress — older results are not shown as current.';
    case 'queued':
      return 'Newest run queued — an older result is not shown as current.';
    case 'cancelled':
      return 'Run cancelled — neither pass nor failure.';
    case 'never-run':
      return `No workflow run on ${run.branch ?? 'the default branch'} yet.`;
    case 'unknown':
      return 'The provider returned a run state that could not be classified.';
    case 'unavailable':
      return 'Actions is unavailable for this repository.';
    default:
      return null;
  }
}

/** Accessible row summary: identity, the status word, the exact counts
 * (unknown is said, never guessed as zero). */
export function repoRowAriaLabel(row: RepoOverviewRowView, badge: RepoBadge): string {
  const prs = row.openPrs === null ? 'unknown' : String(row.openPrs);
  const issues = row.openIssues === null ? 'unknown' : String(row.openIssues);
  return `${row.displayName} — ${badge.text} — ${prs} open pull requests, ${issues} open issues excluding pull requests`;
}
