import type { DirectiveRequestRecord, JobRecord, LedgerApi } from '../../src/ledger/api.js';
import type { WorktreeLane, WorktreePort } from '../../src/dispatch/worktree-port.js';
import { markHistoricalDirectiveFixture } from './directive-native-fixture.js';

/**
 * Request-seeding helpers shared by the directive suites.
 *
 * They write only through the real `LedgerApi` and the harness's worktree
 * port: a job, its lane, and one live directive request (optionally marked as
 * a pre-native historical row, the shape whose producer custody is unknown).
 * Moved out of `test/directive-retirement.test.ts` unchanged so the owner
 * approval suite (#523) seeds the same fixtures, not lookalikes.
 */

/** The bits of a test harness these helpers write through. */
export interface DirectiveSeedHarness {
  readonly ledger: LedgerApi;
  readonly worktrees: Pick<WorktreePort, 'createJobWorktree'>;
}

/** A job row (default `working`), exactly as the suites have always seeded it. */
export function seedJob(
  h: DirectiveSeedHarness,
  jobId: string,
  status = 'working',
  deliverable?: 'review' | 'artifact' | 'investigation',
): JobRecord {
  const job = h.ledger.addJob({ id: jobId, repo: 'fixture-app', title: jobId, briefing: `briefing for ${jobId}`, ...(deliverable === undefined ? {} : { deliverable }) });
  if (status !== 'dispatched') h.ledger.setJobStatus(jobId, status as never);
  return job;
}

/** One live intent on a ready lane with the fixture repo. */
export async function seededLiveRequest(
  h: DirectiveSeedHarness,
  repo: { readonly path: string },
  jobId: string,
  requestId: string,
): Promise<{ lane: WorktreeLane; row: DirectiveRequestRecord }> {
  seedJob(h, jobId);
  const lane = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId });
  const begun = h.ledger.beginDirectiveIntent({ jobId, directive: `repair ${jobId}`, holder: 'silas-ops', requestId });
  return { lane, row: begun.record };
}

/** The same request as a pre-native historical row: no request kind, no
 * authority epoch or contract snapshot, so its producer custody is unknown. */
export async function historicalLiveRequest(
  h: DirectiveSeedHarness,
  repo: { readonly path: string },
  jobId: string,
  requestId: string,
): Promise<{ lane: WorktreeLane; row: DirectiveRequestRecord }> {
  const seeded = await seededLiveRequest(h, repo, jobId, requestId);
  markHistoricalDirectiveFixture(h.ledger, requestId);
  return { lane: seeded.lane, row: h.ledger.getDirective(requestId)! };
}
