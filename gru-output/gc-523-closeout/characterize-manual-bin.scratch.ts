import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { surfaceDirectiveRecovery } from '../src/dispatch/directive-progress.js';
import { retireInterruptedDirectiveFromRoute } from '../src/dispatch/directive-recovery.js';
import { projectMailbox } from '../src/gru-mailbox/projection.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Characterization of issue #523 at the base commit (223ccbbb), run in a
 * scratch extract of that commit by the `closeout-523-before`
 * verify scope. It performs the MANUAL cleanup Gru had to stitch together —
 * `/retire` for the deferred request, then the status write `binned` — and
 * records what it leaves behind. The assertions encode the residue, so the
 * scope passes exactly when the bug is present; this PR does not change the
 * manual path.
 */
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });

it('BUG @223ccbbb: retire-then-bin leaves the recovery card active and the incident on the mailbox', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gru-523-characterize-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo: FixtureRepo = makeFixtureRepo('characterize-app');
  cleanups.push(() => repo.cleanup());
  const bus = new EventBus({});
  const db = new LedgerDb(dir);
  cleanups.push(() => db.close());
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'), ledger);
  const jobId = 'job-characterize';
  const requestId = 'req-characterize';
  const kind = `silas.directive-unreconciled.${requestId}`;

  // The deferred fixture: a request claimed for dispatch and positively
  // deferred before any native effect, its debt and its card.
  ledger.addJob({ id: jobId, repo: 'characterize-app', title: jobId, briefing: 'briefing' });
  ledger.setJobStatus(jobId, 'working');
  await worktrees.createJobWorktree({ repoPath: repo.path, jobId });
  ledger.beginRebriefIntent({ jobId, note: 'redo the work', holder: 'silas-ops', requestId });
  expect(ledger.claimDirectiveDispatch(requestId)).toBe(true);
  const start = ledger.latestJobEventByRequestId(jobId, 'silas.directive-dispatch-started', requestId)!;
  ledger.recordDirectiveDispatchDeferral(ledger.directiveTurnIdentity(requestId), start.seq, 'a supervised producer held the lane');
  surfaceDirectiveRecovery({ ledger, notifications }, requestId, 'deferred before reaching its worker');

  // Step 1 of the manual cleanup: POST /api/silas/directives/{id}/retire.
  const row = ledger.getDirective(requestId)!;
  const authority = ledger.directiveCurrentAuthority(jobId);
  const obligation = ledger.recoveryObligation(jobId, 'directive', requestId);
  retireInterruptedDirectiveFromRoute({
    ledger, worktrees, pendingProducerBlockers: () => [], requestId,
    expected: { jobId, state: 'dispatching', payloadHash: row.payloadHash, head: worktrees.listWorktrees({ jobId })[0]!.sha,
      context: { expectedGeneration: obligation?.generation ?? null, expectedPlanRevision: obligation?.planRevision ?? null,
        expectedObligationState: obligation?.state ?? null, expectedAuthorityEpoch: authority.authorityEpoch,
        expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256 } },
    reason: 'manual cleanup of a canceled heist', by: 'gru' });
  // Step 2: POST /api/jobs/{id}/status {"status":"binned"}.
  ledger.setJobStatus(jobId, 'binned');

  const card = ledger.findNotificationByKind(kind, 'active');
  const mailbox = projectMailbox(ledger);
  const evidence = {
    job: ledger.getJob(jobId)?.status,
    request: ledger.getDirective(requestId)?.state,
    debt: ledger.listObligations({ jobId }).filter((o) => o.incidentKey === `directive-recovery:${requestId}`).map((o) => ({ state: o.state, settlement: o.settlement })),
    activeCard: card === null ? null : { id: card.id, routing: card.routing, resolvedAt: card.resolvedAt, ackedAt: card.ackedAt },
    mailboxItemsNamingTheRequest: mailbox.filter((item) => JSON.stringify(item).includes(requestId)).map((item) => ({ id: item.id, kind: item.kind, title: item.title })),
  };
  console.log(`CHARACTERIZATION ${JSON.stringify(evidence)}`);

  // Both calls succeeded: the job is binned and the debt closed ...
  expect(evidence.job).toBe('binned');
  expect(evidence.request).toBe('retired');
  expect(evidence.debt).toEqual([{ state: 'closed', settlement: { kind: 'job-terminal', jobStatus: 'binned' } }]);
  // ... but the card is still active and the mailbox still lists the incident.
  expect(card).not.toBeNull();
  expect(card?.resolvedAt).toBeNull();
  expect(evidence.mailboxItemsNamingTheRequest.length).toBeGreaterThan(0);
});
