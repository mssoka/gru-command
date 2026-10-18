import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { repoFullName, type RepoRef } from '../dispatch/github-poll.js';
import {
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
 *   (createdAt, id): passed, failed, timed-out or startup-failure. Queued,
 *   running, cancelled, skipped, neutral, action-required and stale runs
 *   never mask a verdict, never alert and never resolve.
 * - A red verdict raises one `action-required` incident per repo +
 *   workflow + head sha — it wakes Gru whatever the check is named (no
 *   mechanical tier, no Silas digest row). No lane owns a default branch,
 *   so the hold subject is the repository (see src/chat/incident.ts).
 * - A newer passing run of that workflow — or the failing run itself,
 *   re-run green — resolves its open incidents.
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
/** Alert kind prefix: `<prefix>:<owner>/<repo>:<workflowId>:<sha>`. */
export const DEFAULT_BRANCH_CI_FAILED_KIND = 'github.default-branch-ci-failed';
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

/** Per workflow, the newest decisive run on the page (sorted by workflow
 * id). A run without an id, workflow id or head sha is ignored. */
export function defaultBranchVerdicts(runs: readonly RepoOverviewRunRaw[]): readonly DefaultBranchVerdict[] {
  const byWorkflow = new Map<number, RepoOverviewRunRaw[]>();
  for (const run of runs) {
    if (run.id === null || run.workflowId === null || run.headSha === null) continue;
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
  readonly notifications: Pick<NotificationCenter, 'postIncident' | 'resolveIncidents'>;
  readonly log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
}

export class DefaultBranchCiWatch {
  private readonly log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

  constructor(private readonly opts: DefaultBranchCiWatchOptions) {
    this.log = opts.log ?? (() => {});
  }

  /** Apply one committed overview observation (the tracker's hook). */
  observe(observation: DefaultBranchRunsObservation): void {
    for (const verdict of defaultBranchVerdicts(observation.runs)) this.apply(observation, verdict);
  }

  private apply(observation: DefaultBranchRunsObservation, verdict: DefaultBranchVerdict): void {
    const repo = repoFullName(observation.repo);
    const scope = `${repo}:${verdict.workflowId}`;
    const previous = this.recorded(scope);
    if (previous !== null) {
      if (previous.runId === verdict.runId) {
        // The same run re-observed; only a re-run that changed its outcome counts.
        if (previous.verdict === verdict.verdict) return;
      } else if (!isNewerRun({ createdAt: verdict.createdAt, id: verdict.runId }, { createdAt: previous.createdAt, id: previous.runId })) {
        return;
      }
    }
    const url = safeRunUrl(verdict.url, observation.repo.host);
    if (verdict.verdict === 'red') {
      // The incident is posted BEFORE its cursor: a crash between the two
      // re-raises onto the same open row instead of losing the alert.
      if (previous?.verdict !== 'red' || previous.sha !== verdict.sha) this.raise(observation, verdict, url);
    } else {
      if (previous === null || previous.verdict !== 'red') return;
      const resolved = this.opts.notifications.resolveIncidents(`${DEFAULT_BRANCH_CI_FAILED_KIND}:${scope}:`, RESOLVED_BY);
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

  private raise(observation: DefaultBranchRunsObservation, verdict: DefaultBranchVerdict, url: string | null): void {
    const repo = repoFullName(observation.repo);
    const workflow = (verdict.workflow ?? `workflow ${verdict.workflowId}`).slice(0, 120);
    const run = verdict.runNumber !== null ? `run #${verdict.runNumber}` : `run ${verdict.runId}`;
    this.opts.notifications.postIncident({
      kind: defaultBranchCiFailedKind(observation.repo, verdict.workflowId, verdict.sha),
      routing: 'action-required',
      severity: 'error',
      title: `Default branch ${observation.branch} is red: ${workflow} (${repo})`,
      detail: [
        `${workflow} ${run} ${verdict.state} on ${observation.branch} at ${verdict.sha}.${url !== null ? ` ${url}` : ''}`,
        `No lane owns ${observation.branch}: diagnose the run, open a fix heist from the current head, and hold ` +
          `incident:${DEFAULT_BRANCH_CI_FAILED_KIND}:${repo} (covers ci-failed, basis ${verdict.sha}) while it is in flight.`,
        `Resolves itself when a newer ${workflow} run on ${observation.branch} passes.`,
      ].join('\n'),
      dedupe: 'active',
    });
    this.log('info', 'default-branch CI: workflow turned red', {
      repo,
      workflow_id: verdict.workflowId,
      run_id: verdict.runId,
      sha: verdict.sha,
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
