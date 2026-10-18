import { DEFAULT_BRANCH_CI_FAILED_KIND } from '../chat/incident.js';
import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { repoFullName, type RepoRef } from '../dispatch/github-poll.js';
import {
  isDefaultBranchRun,
  isNewerRun,
  runStateOf,
  safeRunUrl,
  selectLatestRun,
  type DefaultBranchRunsObservation,
  type RepoOverviewRunRaw,
} from './overview.js';

/**
 * Default-branch CI alert (#446; owner rulings 2026-10-18): the repo
 * overview already reads each managed repository's default-branch Actions
 * runs; this watch turns that page into a wake when a workflow goes red.
 *
 * - The verdict, per `workflow_id`, is the newest DECISIVE run by
 *   (createdAt, id): passed, failed, timed-out or startup-failure. Queued
 *   (incl. waiting/pending/requested), running, cancelled, skipped,
 *   neutral, action-required, stale-run and unknown runs never mask a
 *   verdict, never alert and never resolve. The runs API matches `branch=`
 *   on the head branch, so `pull_request*` runs and fork runs are not
 *   default-branch runs and never count ({@link isDefaultBranchRun});
 *   every other event, bots included, does.
 * - A red verdict raises one `action-required` incident per repo +
 *   workflow + head sha — it wakes Gru whatever the check is named (no
 *   mechanical tier, no Silas digest row) — then resolves the row for the
 *   workflow's previous red head, which the new head supersedes. No lane
 *   owns a default branch, so the hold subject is the repository (see
 *   src/chat/incident.ts).
 * - A newer passing run of that workflow — or the failing run itself,
 *   re-run green — resolves its open incidents. Without a red cursor (a
 *   crash between post and cursor, a malformed cursor) a pass still
 *   resolves any open row of the workflow — once per process per workflow
 *   until the next raise, since the prefix resolve scans every row — and
 *   records nothing; with a passed cursor only a newer pass does, since a
 *   row raised after it may still be re-running.
 * - Dedupe is by observed change against the latest
 *   `repo.default-branch-ci` event for the workflow, so a restart re-reads
 *   the same cursor and never re-raises; a verdict never steps back to an
 *   older run. A first-ever green is not a change worth recording.
 *
 * Always on for every `managed_repos` entry; no config, no extra GitHub
 * call (the overview's single runs call reads the page).
 */

/** The cursor event: one per observed change, never per pass. */
export const DEFAULT_BRANCH_CI_EVENT = 'repo.default-branch-ci';
const RESOLVED_BY = 'default-branch-ci';

const RED_STATES = ['failed', 'timed-out', 'startup-failure'] as const;
const DECISIVE_STATES: readonly string[] = ['passed', ...RED_STATES];

export interface DefaultBranchVerdict {
  readonly workflowId: number;
  readonly verdict: 'red' | 'passed';
  /** The decisive run's display state (passed/failed/timed-out/startup-failure). */
  readonly state: string;
  readonly runId: number;
  readonly runNumber: number | null;
  readonly sha: string;
  /** Provider workflow name — untrusted text, display only. */
  readonly workflow: string | null;
  readonly url: string | null;
  readonly createdAt: string | null;
}

/** The incident kind for one red workflow at one head. */
export function defaultBranchCiFailedKind(repo: RepoRef, workflowId: number, sha: string): string {
  return `${DEFAULT_BRANCH_CI_FAILED_KIND}:${repoFullName(repo)}:${workflowId}:${sha}`;
}

/** Per workflow, the newest decisive default-branch run on the page
 * (sorted by workflow id). A run without an id, workflow id or head sha is
 * ignored, as is a pull-request or fork run. */
export function defaultBranchVerdicts(runs: readonly RepoOverviewRunRaw[]): readonly DefaultBranchVerdict[] {
  const byWorkflow = new Map<number, RepoOverviewRunRaw[]>();
  for (const run of runs) {
    if (run.id === null || run.workflowId === null || run.headSha === null) continue;
    if (!isDefaultBranchRun(run)) continue;
    if (!DECISIVE_STATES.includes(runStateOf(run.status, run.conclusion))) continue;
    byWorkflow.set(run.workflowId, [...(byWorkflow.get(run.workflowId) ?? []), run]);
  }
  return [...byWorkflow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([workflowId, candidates]) => {
      const latest = selectLatestRun(candidates) as RepoOverviewRunRaw;
      const state = runStateOf(latest.status, latest.conclusion);
      return {
        workflowId,
        verdict: state === 'passed' ? 'passed' : 'red',
        state,
        runId: latest.id as number,
        runNumber: latest.runNumber,
        sha: latest.headSha as string,
        workflow: latest.name,
        url: latest.url,
        createdAt: latest.createdAt,
      };
    });
}

interface RecordedVerdict {
  readonly verdict: 'red' | 'passed';
  readonly runId: number;
  readonly sha: string;
  readonly createdAt: string | null;
}

export interface DefaultBranchCiWatchOptions {
  readonly ledger: Pick<LedgerApi, 'latestEventByPayloadField' | 'appendCustomEvent'>;
  readonly notifications: Pick<NotificationCenter, 'postIncident' | 'resolveIncidents' | 'resolveExactKind'>;
  readonly log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
}

export class DefaultBranchCiWatch {
  private readonly log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
  /** Workflow scopes whose open rows a pass already resolved in this
   * process; a raise un-settles its scope. */
  private readonly settled = new Set<string>();

  constructor(private readonly opts: DefaultBranchCiWatchOptions) {
    this.log = opts.log ?? (() => {});
  }

  /** Apply one committed overview observation (the tracker's hook). One
   * workflow's failure is logged and never skips the repository's others. */
  observe(observation: DefaultBranchRunsObservation): void {
    for (const verdict of defaultBranchVerdicts(observation.runs)) {
      try {
        this.apply(observation, verdict);
      } catch (error) {
        this.log('error', 'default-branch CI: workflow verdict could not be applied — retried next pass', {
          repo: repoFullName(observation.repo),
          workflow_id: verdict.workflowId,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
        });
      }
    }
  }

  private apply(observation: DefaultBranchRunsObservation, verdict: DefaultBranchVerdict): void {
    const repo = repoFullName(observation.repo);
    const scope = `${repo}:${verdict.workflowId}`;
    const previous = this.recorded(scope);
    const newer = previous !== null &&
      isNewerRun({ createdAt: verdict.createdAt, id: verdict.runId }, { createdAt: previous.createdAt, id: previous.runId });
    if (verdict.verdict === 'passed' && previous?.verdict !== 'red') {
      // A same-run or older pass proves nothing about a row raised after
      // the passed cursor (its re-run may still be in progress).
      if (previous === null || newer) this.settle(scope, repo, verdict);
      return;
    }
    if (previous !== null) {
      if (previous.runId === verdict.runId) {
        // The same run re-observed; only a re-run that changed its outcome counts.
        if (previous.verdict === verdict.verdict) return;
      } else if (!newer) {
        return;
      }
    }
    const url = safeRunUrl(verdict.url, observation.repo.host);
    if (verdict.verdict === 'red') {
      // The incident is posted BEFORE its cursor: a crash between the two
      // re-raises onto the same open row instead of losing the alert. A new
      // red head supersedes the old head's row only once its own is posted.
      if (previous?.verdict !== 'red' || previous.sha !== verdict.sha) {
        this.raise(observation, verdict, url, scope, previous?.verdict === 'red' ? previous.sha : null);
      }
    } else {
      const resolved = this.opts.notifications.resolveIncidents(`${DEFAULT_BRANCH_CI_FAILED_KIND}:${scope}:`, RESOLVED_BY);
      this.settled.add(scope);
      this.log('info', 'default-branch CI: workflow passed again, incidents resolved', {
        repo,
        workflow_id: verdict.workflowId,
        run_id: verdict.runId,
        resolved: resolved.length,
      });
    }
    this.opts.ledger.appendCustomEvent({
      kind: DEFAULT_BRANCH_CI_EVENT,
      payload: {
        scope,
        repo,
        host: observation.repo.host,
        branch: observation.branch,
        workflow_id: verdict.workflowId,
        workflow: verdict.workflow,
        verdict: verdict.verdict,
        state: verdict.state,
        run_id: verdict.runId,
        run_number: verdict.runNumber,
        sha: verdict.sha,
        created_at: verdict.createdAt,
        url,
      },
    });
  }

  /** A pass without a red cursor writes nothing, but closes any row a
   * crash left open (between post and cursor, or a malformed cursor) — once
   * per process per scope until the next raise. */
  private settle(scope: string, repo: string, verdict: DefaultBranchVerdict): void {
    if (this.settled.has(scope)) return;
    const resolved = this.opts.notifications.resolveIncidents(`${DEFAULT_BRANCH_CI_FAILED_KIND}:${scope}:`, RESOLVED_BY);
    this.settled.add(scope);
    if (resolved.length > 0) {
      this.log('info', 'default-branch CI: workflow passed without a red cursor, open incidents resolved', {
        repo,
        workflow_id: verdict.workflowId,
        run_id: verdict.runId,
        resolved: resolved.length,
      });
    }
  }

  private raise(
    observation: DefaultBranchRunsObservation,
    verdict: DefaultBranchVerdict,
    url: string | null,
    scope: string,
    supersededSha: string | null,
  ): void {
    const repo = repoFullName(observation.repo);
    this.settled.delete(scope);
    const workflow = (verdict.workflow ?? `workflow ${verdict.workflowId}`).slice(0, 120);
    const run = verdict.runNumber !== null ? `run #${verdict.runNumber}` : `run ${verdict.runId}`;
    this.opts.notifications.postIncident({
      kind: defaultBranchCiFailedKind(observation.repo, verdict.workflowId, verdict.sha),
      routing: 'action-required',
      severity: 'error',
      title: `Default branch ${observation.branch} is red: ${workflow} (${repo})`,
      detail: [
        `${workflow} ${run} ${verdict.state} on ${observation.branch} at ${verdict.sha}.${url !== null ? ` ${url}` : ''}`,
        `No lane owns ${observation.branch}: diagnose the run, open a fix heist from the current head, hold ` +
          `incident:${DEFAULT_BRANCH_CI_FAILED_KIND}:${repo} (covers ci-failed) with no basis_fingerprint so later red ` +
          'heads carry the fix as a restriction, and disposition this item as waiting on the fix job.',
        `Resolves itself when a newer ${workflow} run on ${observation.branch} passes, this run is re-run green, or a ` +
          `later red head of ${workflow} replaces it.`,
      ].join('\n'),
      dedupe: 'active',
    });
    const superseded = supersededSha === null
      ? 0
      : this.opts.notifications.resolveExactKind(defaultBranchCiFailedKind(observation.repo, verdict.workflowId, supersededSha), RESOLVED_BY).length;
    this.log('info', 'default-branch CI: workflow turned red', {
      repo,
      workflow_id: verdict.workflowId,
      run_id: verdict.runId,
      sha: verdict.sha,
      superseded,
    });
  }

  /** The workflow's recorded cursor; a malformed payload re-observes. */
  private recorded(scope: string): RecordedVerdict | null {
    const event = this.opts.ledger.latestEventByPayloadField(DEFAULT_BRANCH_CI_EVENT, 'scope', scope);
    if (event === null) return null;
    const payload = event.payload as Record<string, unknown> | null;
    const verdict = payload?.['verdict'];
    const runId = payload?.['run_id'];
    const sha = payload?.['sha'];
    const createdAt = payload?.['created_at'];
    if (
      (verdict !== 'red' && verdict !== 'passed') ||
      typeof runId !== 'number' ||
      typeof sha !== 'string' ||
      (createdAt !== null && typeof createdAt !== 'string')
    ) {
      this.log('warn', 'default-branch CI: cursor event has a malformed payload — re-observing', { scope, seq: event.seq });
      return null;
    }
    return { verdict, runId, sha, createdAt };
  }
}
