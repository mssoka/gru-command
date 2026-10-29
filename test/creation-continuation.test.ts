import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CreationContinuationConflictError, RecordNotFound } from '../src/ledger/api.js';
import type { DispatchService } from '../src/dispatch/service.js';
import type { BriefingReviewService } from '../src/briefing-review/service.js';
import { BriefingReviewError } from '../src/briefing-review/types.js';
import { PacingGate } from '../src/runtime/pacing.js';
import type { DiskFloorGate, FloorAdmission } from '../src/maintenance/disk.js';
import { writeCreationIntent } from '../src/worktrees/creation-intent.js';
import type { LogLevel } from '../src/logger.js';
import {
  admitDirectly, cleanupContinuationFixtures, directory, git, httpHarness, managerFixture, receiptFiles, request, requestPayloadSha256,
  restartService, retainedFixture, routeHarness, syntheticRetained, TOKEN, waitForState,
} from './helpers/creation-continuation.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';

afterEach(cleanupContinuationFixtures);

describe('same-job retained initial-creation continuation', () => {
  it('routes an authenticated continuation request to its durable owner and maps every outcome to its status', async () => {
    const readback = { job_id: 'route-job', request_id: 'route-request', state: 'accepted' };
    const outcomes: (() => unknown)[] = [
      () => ({ created: true, readback }),
      () => ({ created: false, readback }),
      () => ({ created: true, readback: { ...readback, state: 'refused' } }),
      () => ({ created: false, readback: { ...readback, state: 'custody-unknown' } }),
      () => { throw new CreationContinuationConflictError('request id route-request was already used with a different payload'); },
      () => { throw new RecordNotFound('job "route-job" not found'); },
    ];
    const requestContinuation = vi.fn(async () => outcomes.shift()!());
    const readContinuation = vi.fn((jobId: string, requestId: string) => requestId === 'route-request' ? { ...readback, job_id: jobId } : null);
    const dispatch = { requestCreationContinuation: requestContinuation, getCreationContinuationReadback: readContinuation } as unknown as DispatchService;
    const base = await routeHarness(dispatch);
    const body = { job_id: 'route-job', request_id: 'route-request' };
    const statuses: [number, unknown][] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request(base, 'POST', body);
      statuses.push([response.status, response.body['error'] ?? null]);
    }
    expect(statuses).toEqual([
      [202, null], [200, null], [409, 'creation_continuation_refused'], [409, 'creation_continuation_unknown'],
      [409, 'creation_continuation_conflict'], [404, 'not_found'],
    ]);
    expect(requestContinuation).toHaveBeenCalledWith({ jobId: 'route-job', requestId: 'route-request' });
    const extraField = await request(base, 'POST', { ...body, branch: 'gru/forged' });
    expect(extraField.status).toBe(400);
    expect(requestContinuation).toHaveBeenCalledTimes(6);

    const get = async (query: string) => {
      const response = await fetch(`${base}/api/dispatch/creation-continuation${query}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect(await get('?job_id=route-job&request_id=route-request')).toEqual({ status: 200, body: { readback } });
    expect(await get('?job_id=route-job&request_id=unknown-request')).toMatchObject({ status: 404, body: { error: 'not_found' } });
    for (const query of ['?job_id=route-job', '?request_id=route-request', '?job_id=route-job&request_id=', '?job_id=a&job_id=b&request_id=route-request', '?job_id=route-job&request_id=route-request&branch=gru/forged']) {
      expect(await get(query), query).toMatchObject({ status: 400, body: { error: 'bad_request' } });
    }
    expect(readContinuation).toHaveBeenCalledTimes(2);
  });

  it('never consults the briefing-review gate: the continued job\'s own dispatch already passed it (#501)', async () => {
    const admitDispatch = vi.fn((): never => {
      throw new BriefingReviewError('briefing_review_required', 'an enforced-tier briefing must be reviewed before dispatch', 400);
    });
    const requestContinuation = vi.fn(async () => ({ created: true, readback: { job_id: 'gate-job', request_id: 'gate-request', state: 'accepted' } }));
    const dispatch = {
      requestCreationContinuation: requestContinuation,
      getCreationContinuationReadback: vi.fn(() => null),
    } as unknown as DispatchService;
    const base = await routeHarness(dispatch, { briefingReview: { admitDispatch } as unknown as BriefingReviewService });
    // A fresh dispatch of this briefing is refused by the enforced gate …
    const fresh = await fetch(`${base}/api/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ job_id: 'gate-job', repo_path: '/tmp/gate-repo', title: 'Gate', briefing: 'Original briefing gate-job' }),
    });
    expect(fresh.status).toBe(400);
    expect(await fresh.json() as Record<string, unknown>).toMatchObject({ error: 'briefing_review_required' });
    expect(admitDispatch).toHaveBeenCalledTimes(1);
    // … while the continuation of the job that dispatch created passes
    // without asking the gate: the job's existence is its admission proof.
    const response = await request(base, 'POST', { job_id: 'gate-job', request_id: 'gate-request' });
    expect(response.status).toBe(202);
    expect(requestContinuation).toHaveBeenCalledWith({ jobId: 'gate-job', requestId: 'gate-request' });
    expect(admitDispatch).toHaveBeenCalledTimes(1);
  });

  it('refuses an unsafe GET identifier by name instead of reaching the ledger (#501)', async () => {
    const readContinuation = vi.fn(() => null);
    const dispatch = {
      requestCreationContinuation: vi.fn(),
      getCreationContinuationReadback: readContinuation,
    } as unknown as DispatchService;
    const base = await routeHarness(dispatch);
    const get = async (query: string) => {
      const response = await fetch(`${base}/api/dispatch/creation-continuation${query}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect(await get('?job_id=bad job&request_id=gate-request')).toMatchObject({ status: 400, body: { error: 'bad_request', detail: 'job id must be a safe 128-character record identifier' } });
    expect(await get('?job_id=gate-job&request_id=bad/request')).toMatchObject({ status: 400, body: { error: 'bad_request', detail: 'request id must be a safe 128-character record identifier' } });
    expect(readContinuation).not.toHaveBeenCalled();
  });

  it('adopts the exact receipt-owned branch/base/provenance and delivers the original job once through authenticated API', async () => {
    const h = await retainedFixture('continuation-positive');
    const api = await httpHarness(h);
    const inspection = api.inspection!;
    const unauthPost = await request(api.base, 'POST', { job_id: api.jobId, request_id: 'unauthorized-request' }, null);
    const unauthGet = await request(api.base, 'GET', { job_id: api.jobId, request_id: 'unauthorized-request' }, null);
    expect(unauthPost.status).toBe(401);
    expect(unauthGet.status).toBe(401);
    expect(api.ledger.getCreationContinuation(api.jobId, 'unauthorized-request')).toBeNull();

    const requestId = 'retained-creation-positive';
    const accepted = await request(api.base, 'POST', { job_id: api.jobId, request_id: requestId });
    expect(accepted.status).toBe(202);
    expect((accepted.body['readback'] as Record<string, unknown>)['state']).toBe('accepted');
    const retry = await request(api.base, 'POST', { job_id: api.jobId, request_id: requestId });
    expect(retry.status).toBe(200);
    const readback = await waitForState(api.base, api.jobId, requestId, 'delivered');
    expect(readback).toMatchObject({ state: 'delivered', active: false, job_status: 'delivered' });
    expect(readback['original']).toMatchObject({
      handoff_repo_path: h.repo.path, repo_path: inspection.repoPath,
      branch: `gru/${api.jobId}`, base_sha: inspection.sha, base_source: inspection.baseSource,
      producer_settlement_seq: inspection.producerSettlementSeq,
    });
    expect(readback['custody']).toMatchObject({
      worktree_id: api.jobId, branch: `gru/${api.jobId}`, sha: inspection.sha,
      base_source: inspection.baseSource, evidence: 'manager-reconciliation', status: 'active',
    });
    expect(readback['admission']).toMatchObject({ agent_id: api.spawns[0], event_seq: expect.any(Number) });
    expect(readback['delivery']).toMatchObject({ agent_id: api.spawns[0], sha: inspection.sha, event_seq: expect.any(Number) });
    // Directive correlation joins job.delivered on request_id: the
    // continuation's delivery carries only its own namespaced identity.
    const delivered = api.ledger.listJobEventsByKinds(api.jobId, ['job.delivered']);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.payload).toMatchObject({ source: 'dispatch', creation_continuation_request_id: requestId, creation_continuation_generation: readback['generation'] });
    expect(delivered[0]!.payload).not.toHaveProperty('request_id');
    expect(JSON.stringify({ readback, timeline: api.ledger.getCreationContinuation(api.jobId, requestId) })).not.toContain('gru-creation:');
    expect(api.spawns).toHaveLength(1);
    expect(api.prompts).toHaveLength(1);
    expect(api.prompts[0]).toContain(`Original briefing ${api.jobId}`);
    expect(api.ledger.getJob(api.jobId)?.status).toBe('delivered');
    expect(api.ledger.listJobEventsByKinds(api.jobId, ['job.handoff'], { limit: 5 })).toHaveLength(1);
    expect(api.ledger.getWorktree(api.jobId)?.branch).toBe(`gru/${api.jobId}`);
    expect(api.ledger.getWorktree(api.jobId)?.sha).toBe(inspection.sha);
    expect(api.ledger.getWorktree(api.jobId)?.baseSource).toBe(inspection.baseSource);
    expect(git(api.repo, ['rev-parse', `refs/heads/gru/${api.jobId}`])).toBe(inspection.sha);
    expect(receiptFiles(api.repo)).toHaveLength(0);

    const afterDeliveryRetry = await request(api.base, 'POST', { job_id: api.jobId, request_id: requestId });
    expect(afterDeliveryRetry.status).toBe(200);
    expect(api.spawns).toHaveLength(1);
    expect(api.prompts).toHaveLength(1);
  });

  it('admits only one competing request when callers race the same blocked job', async () => {
    const h = await retainedFixture('continuation-race');
    const api = await httpHarness(h);
    const outcomes = await Promise.all([
      request(api.base, 'POST', { job_id: api.jobId, request_id: 'race-one' }),
      request(api.base, 'POST', { job_id: api.jobId, request_id: 'race-two' }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 202)).toHaveLength(1);
    const readbacks = outcomes.map((outcome) => outcome.body['readback'] as Record<string, unknown>);
    const winner = readbacks.find((row) => row['state'] === 'accepted' || row['state'] === 'queued' || row['state'] === 'admitted' || row['state'] === 'delivered');
    const loser = readbacks.find((row) => row['state'] === 'refused');
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    const winnerId = winner!['request_id'] as string;
    await waitForState(api.base, api.jobId, winnerId, 'delivered');
    expect(api.spawns).toHaveLength(1);
    expect(api.prompts).toHaveLength(1);
    expect(api.ledger.listJobEventsByKinds(api.jobId, ['job.handoff'], { limit: 5 })).toHaveLength(1);
  });

  it('refuses every job outside a blocked, unamended, workerless initial PR dispatch with its custody kept', async () => {
    const h = managerFixture('continuation-scope');
    const other = makeFixtureRepo('another-repository');
    try {
      const guards = [
        'not-blocked', 'amended-contract', 'existing-agent', 'existing-admission', 'phase-handoff', 'pr-url', 'target-ref', 'target-sha',
        'non-pr-deliverable', 'worker-history', 'delivery-history', 'duplicate-handoff', 'mismatched-handoff', 'live-directive',
        'pending-rebrief', 'directive-request-id',
      ] as const;
      const harness = await httpHarness({ ...h, job: syntheticRetained(h, 'continuation-scope-anchor').job });
      for (const guard of guards) {
        const jobId = `continuation-scope-${guard}`;
        const retained = syntheticRetained(h, jobId, {
          ...(guard === 'non-pr-deliverable' ? { deliverable: 'artifact' as const } : {}),
          ...(guard === 'mismatched-handoff' ? { handoffRepoPath: other.path } : {}),
        });
        let releaseAdmission: (() => void) | null = null;
        let requestId = `scope-${guard}`;
        if (guard === 'not-blocked') h.ledger.setJobStatus(jobId, 'working');
        else if (guard === 'amended-contract') {
          const contract = h.ledger.effectiveContract(jobId)!;
          expect(h.ledger.addJobAmendment({ jobId, body: 'Synthetic contract amendment', approval: { by: 'fixture-owner', reference: 'synthetic fixture approval' }, expectedContractSha256: contract.contractSha256, effect: 'administrative' }).status).toBe('accepted');
        } else if (guard === 'existing-agent') h.ledger.registerAgent({ id: `${jobId}-agent`, role: 'minion', jobId });
        else if (guard === 'existing-admission') releaseAdmission = h.ledger.beginJobAdmission(jobId, 'fixture pre-existing admission');
        else if (guard === 'phase-handoff') h.ledger.beginPhaseHandoff({ jobId, source: 'dispatch', intent: { kind: 'gru-decision', decision: 'fixture decision' } });
        else if (guard === 'pr-url') h.ledger.setJobPr(jobId, 'https://example.invalid/pull/1');
        // A legacy row may carry report targets on a PR-owing job.
        else if (guard === 'target-ref') h.db.handle.prepare('UPDATE jobs SET target_ref = ? WHERE id = ?').run('refs/heads/fixture', jobId);
        else if (guard === 'target-sha') h.db.handle.prepare('UPDATE jobs SET target_sha = ? WHERE id = ?').run(retained.sha, jobId);
        else if (guard === 'worker-history') h.ledger.appendCustomEvent({ kind: 'job.minion-spawned', jobId, payload: { agentId: 'earlier-minion', worktree: '/nowhere', branch: retained.branch } });
        else if (guard === 'delivery-history') h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { agentId: 'earlier-minion', source: 'dispatch', sha: retained.sha, work_revision: 0 } });
        else if (guard === 'duplicate-handoff') h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: retained.job.repo, repoPath: h.repo.path } });
        else if (guard === 'live-directive') h.ledger.beginDirectiveIntent({ jobId, directive: 'fixture directive', holder: 'silas-ops' });
        else if (guard === 'pending-rebrief') h.ledger.beginPendingRebrief({ jobId, note: 'fixture re-brief', briefing: null });
        else if (guard === 'directive-request-id') {
          h.ledger.addJob({ id: 'directive-owner', repo: retained.job.repo, title: 'directive owner', baseBranch: 'main', briefing: 'directive owner' });
          requestId = h.ledger.beginDirectiveIntent({ jobId: 'directive-owner', directive: 'fixture directive', holder: 'silas-ops', requestId: 'shared-request-id' }).record.requestId;
        }
        const response = await request(harness.base, 'POST', { job_id: jobId, request_id: requestId });
        expect(response.status, guard).toBe(409);
        const readback = response.body['readback'] as Record<string, unknown>;
        expect(readback, guard).toMatchObject({ state: 'refused', active: false });
        expect(readback['reason'], guard).toMatch({
          'not-blocked': /is working, not blocked/u,
          'amended-contract': /amended contract/u,
          'existing-agent': /already has an agent record/u,
          'existing-admission': /already has a live admission/u,
          'phase-handoff': /prior phase-handoff contract/u,
          'pr-url': /report or pull-request state/u,
          'target-ref': /report or pull-request state/u,
          'target-sha': /report or pull-request state/u,
          'non-pr-deliverable': /not a PR-owing initial dispatch/u,
          'worker-history': /worker or delivery history/u,
          'delivery-history': /worker or delivery history/u,
          'duplicate-handoff': /no unique original job.handoff/u,
          'mismatched-handoff': /records repository "continuation-scope", but its handoff path .*another-repository names "another-repository"$/u,
          'live-directive': /live directive request .* owns the lane/u,
          'pending-rebrief': /pending re-brief that owns the lane/u,
          'directive-request-id': /names a directive request/u,
        }[guard]);
        expect(h.ledger.getWorktree(jobId), guard).toBeNull();
        expect(git(h.repo, ['rev-parse', `refs/heads/${retained.branch}`]), guard).toBe(retained.sha);
        expect(receiptFiles(h.repo), guard).toContain(`${createHash('sha256').update(retained.branch).digest('hex').slice(0, 40)}.json`);
        releaseAdmission?.();
      }
      expect(harness.spawns).toHaveLength(0);
      expect(harness.prompts).toHaveLength(0);
    } finally {
      other.cleanup();
    }
  });

  it('records actual worker-pacing queue state and admits only after the configured FIFO gate releases', async () => {
    const h = await retainedFixture('continuation-queued');
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 1 });
    const occupied = await gate.acquireWorkerTurn({ id: 'fixture-occupant', label: 'fixture occupant', jobId: 'other-job' });
    const api = await httpHarness(h, { service: { workerGate: gate } });
    const requestId = 'queued-continuation';
    const accepted = await request(api.base, 'POST', { job_id: api.jobId, request_id: requestId });
    expect(accepted.status).toBe(202);
    const queued = await waitForState(api.base, api.jobId, requestId, 'queued');
    expect(queued['queue']).toMatchObject({ gate: 'worker-pacing', reason: expect.any(String) });
    expect(api.spawns).toHaveLength(0);
    expect(api.prompts).toHaveLength(0);
    occupied.release();
    await waitForState(api.base, api.jobId, requestId, 'delivered');
    expect(api.spawns).toHaveLength(1);
    expect(api.prompts).toHaveLength(1);
  });

  it('records disk-floor queue state before any custody adoption and resumes through the ordinary gate', async () => {
    const h = await retainedFixture('continuation-disk-floor');
    let releaseFloor: (() => void) | null = null;
    const floor: Pick<DiskFloorGate, 'admitLane'> = {
      admitLane: vi.fn((input) => new Promise<FloorAdmission>((resolve) => {
        input.queued?.({ reason: 'fixture disk floor below threshold', position: 1 });
        releaseFloor = () => resolve({ waitedMs: 5, done() {} });
      })),
    };
    const api = await httpHarness(h, { service: { diskFloor: floor } });
    const requestId = 'disk-floor-continuation';
    const accepted = await request(api.base, 'POST', { job_id: api.jobId, request_id: requestId });
    expect(accepted.status).toBe(202);
    const queued = await waitForState(api.base, api.jobId, requestId, 'queued');
    expect(queued['queue']).toMatchObject({ gate: 'disk-floor', reason: 'fixture disk floor below threshold' });
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(api.spawns).toHaveLength(0);
    expect(api.prompts).toHaveLength(0);
    releaseFloor!();
    await waitForState(api.base, api.jobId, requestId, 'delivered');
    expect(api.spawns).toHaveLength(1);
    expect(api.prompts).toHaveLength(1);
  });

  it('records a known swept spawn failure without inventing an admission or delivery', async () => {
    const h = await retainedFixture('continuation-spawn-failure');
    const api = await httpHarness(h, { spawnFailure: new Error('synthetic spawn failure') });
    const requestId = 'spawn-failure-request';
    const accepted = await request(api.base, 'POST', { job_id: api.jobId, request_id: requestId });
    expect(accepted.status).toBe(202);
    const failed = await waitForState(api.base, api.jobId, requestId, 'failed');
    expect(failed).toMatchObject({ state: 'failed', active: false, admission: null, delivery: null });
    expect(failed['custody']).toMatchObject({ status: 'swept', evidence: 'manager-reconciliation' });
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'known-swept-failure' });
    expect(api.spawns).toHaveLength(0);
    expect(api.prompts).toHaveLength(0);
  });

  it('turns a durable accepted request without a live owner into custody-unknown after restart and never replays it', async () => {
    const h = await retainedFixture('continuation-restart');
    const identityPayload = {
      schema: 'same-job-retained-creation-continuation-v1', job_id: h.job.id, request_id: 'restart-request',
      handoff_seq: h.ledger.listJobEventsByKinds(h.job.id, ['job.handoff'], { limit: 2 })[0]!.seq,
      briefing_sha256: createHash('sha256').update(h.job.briefing!, 'utf8').digest('hex'), handoff_repo_path: h.repo.path, repo_path: h.inspection!.repoPath,
      branch: h.inspection.branch, base_sha: h.inspection.sha, base_source: h.inspection.baseSource,
      producer_settlement_seq: h.inspection.producerSettlementSeq,
      receipt_token_sha256: h.inspection.receiptTokenSha256,
    };
    h.ledger.acceptCreationContinuation({
      jobId: h.job.id, requestId: 'restart-request', payloadSha256: requestPayloadSha256(identityPayload),
      handoffSeq: identityPayload.handoff_seq, briefingSha256: identityPayload.briefing_sha256,
      handoffRepoPath: identityPayload.handoff_repo_path, repoPath: identityPayload.repo_path, branch: h.inspection.branch, baseSha: h.inspection.sha,
      baseSource: h.inspection.baseSource, producerSettlementSeq: h.inspection.producerSettlementSeq,
      receiptTokenSha256: h.inspection.receiptTokenSha256,
    });
    const api = await httpHarness(h);
    const read = await request(api.base, 'GET', { job_id: api.jobId, request_id: 'restart-request' });
    expect(read.status).toBe(200);
    expect((read.body['readback'] as Record<string, unknown>)).toMatchObject({ state: 'custody-unknown', active: false });
    const retry = await request(api.base, 'POST', { job_id: api.jobId, request_id: 'restart-request' });
    expect(retry.status).toBe(409);
    expect((retry.body['readback'] as Record<string, unknown>)['state']).toBe('custody-unknown');
    expect(api.spawns).toHaveLength(0);
    expect(api.prompts).toHaveLength(0);
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(git(api.repo, ['rev-parse', `refs/heads/gru/${api.jobId}`])).toBe(api.inspection!.sha);
    expect(receiptFiles(api.repo)).toHaveLength(1);
  });

  it('reports an admitted-but-undelivered owner lost on restart as unknown and does not launch it again', async () => {
    const h = await retainedFixture('continuation-admitted-restart');
    const requestId = 'admitted-restart-request';
    const handoff = h.ledger.listJobEventsByKinds(h.job.id, ['job.handoff'], { limit: 2 })[0]!;
    const briefingSha256 = createHash('sha256').update(h.job.briefing!, 'utf8').digest('hex');
    const identityPayload = {
      schema: 'same-job-retained-creation-continuation-v1', job_id: h.job.id, request_id: requestId,
      handoff_seq: handoff.seq, briefing_sha256: briefingSha256, handoff_repo_path: h.repo.path, repo_path: h.inspection.repoPath,
      branch: h.inspection.branch, base_sha: h.inspection.sha, base_source: h.inspection.baseSource,
      producer_settlement_seq: h.inspection.producerSettlementSeq,
      receipt_token_sha256: h.inspection.receiptTokenSha256,
    };
    const accepted = h.ledger.acceptCreationContinuation({
      jobId: h.job.id, requestId, payloadSha256: requestPayloadSha256(identityPayload),
      handoffSeq: handoff.seq, briefingSha256, handoffRepoPath: h.repo.path, repoPath: h.inspection.repoPath,
      branch: h.inspection.branch, baseSha: h.inspection.sha, baseSource: h.inspection.baseSource,
      producerSettlementSeq: h.inspection.producerSettlementSeq, receiptTokenSha256: h.inspection.receiptTokenSha256,
    });
    expect(accepted.timeline.state).toBe('accepted');
    const lane = await h.worktrees.createRetainedJobWorktree({ repoPath: h.repo.path, jobId: h.job.id, expected: h.inspection });
    h.ledger.recordCreationContinuationState({
      jobId: h.job.id, requestId, generation: accepted.timeline.identity.generation,
      stage: 'custody-adopted', details: {
        worktree_id: lane.id, path: lane.path, branch: lane.branch, sha: lane.sha,
        base_source: lane.baseSource, worktree_status: lane.status,
      },
    });
    h.ledger.setJobStatus(h.job.id, 'working');
    h.ledger.registerAgent({ id: 'admitted-before-restart', role: 'minion', jobId: h.job.id, parentage: 'top-level' });
    h.ledger.appendCustomEvent({
      kind: 'job.minion-spawned', jobId: h.job.id,
      payload: {
        agentId: 'admitted-before-restart', worktree: lane.path, branch: lane.branch,
        creation_continuation_request_id: requestId,
        creation_continuation_generation: accepted.timeline.identity.generation,
      },
    });
    h.ledger.recordCreationContinuationState({
      jobId: h.job.id, requestId, generation: accepted.timeline.identity.generation,
      state: 'admitted', stage: 'minion-spawned', details: { agent_id: 'admitted-before-restart' },
    });

    const api = await httpHarness(h);
    const read = await request(api.base, 'GET', { job_id: h.job.id, request_id: requestId });
    expect(read.status).toBe(200);
    expect(read.body['readback']).toMatchObject({ state: 'custody-unknown', active: false, custody: { evidence: 'manager-reconciliation' }, admission: { agent_id: 'admitted-before-restart' }, delivery: null });
    const retry = await request(api.base, 'POST', { job_id: h.job.id, request_id: requestId });
    expect(retry.status).toBe(409);
    expect((retry.body['readback'] as Record<string, unknown>)['state']).toBe('custody-unknown');
    expect(api.spawns).toHaveLength(0);
    expect(api.prompts).toHaveLength(0);
    expect(h.ledger.listJobEventsByKinds(h.job.id, ['job.handoff'], { limit: 5 })).toHaveLength(1);
  });

  it('keeps an admitted continuation custody-unknown across a real ledger close and reopen and never relaunches it', async () => {
    const h = await retainedFixture('continuation-reopen-restart');
    const requestId = 'reopen-restart-request';
    const { lane, agentId, spawnedSeq } = await admitDirectly(h, requestId);
    const first = await httpHarness(h);
    const before = (await request(first.base, 'GET', { job_id: h.job.id, request_id: requestId })).body['readback'] as Record<string, unknown>;
    expect(before).toMatchObject({ state: 'custody-unknown', active: false, admission: { agent_id: agentId, event_seq: spawnedSeq }, delivery: null });
    // The first process is gone: its service and server stopped and the
    // ledger file closed; the second opens that same file from disk.
    const restarted = await restartService(h, first);
    const { api, fixture } = restarted;
    const continuationEvents = () => api.ledger.listJobEventsByKinds(h.job.id, ['job.creation-continuation'], { limit: 50 });
    expect(fixture.db).not.toBe(h.db);
    expect(fixture.db.dbPath).toBe(h.db.dbPath);
    expect(api.ledger).not.toBe(h.ledger);
    expect(api.worktrees).not.toBe(h.worktrees);
    expect(api.dispatch).not.toBe(first.dispatch);
    expect(api.ledger.getJob(h.job.id)?.status).toBe('working');
    expect(api.ledger.getAgent(agentId)).toMatchObject({ jobId: h.job.id, role: 'minion' });
    expect(api.ledger.getWorktree(h.job.id)).toMatchObject({ id: lane.id, path: lane.path, branch: lane.branch, sha: lane.sha, baseSource: lane.baseSource });
    expect(api.ledger.getCreationContinuation(h.job.id, requestId)?.events.map((event) => (event.payload as Record<string, unknown>)['stage']))
      .toEqual(['accepted', 'custody-adopted', 'minion-spawned']);
    const eventsBefore = continuationEvents();
    expect(eventsBefore).toHaveLength(3);

    const read = await request(api.base, 'GET', { job_id: h.job.id, request_id: requestId });
    expect(read.status).toBe(200);
    const readback = read.body['readback'] as Record<string, unknown>;
    expect(readback).toMatchObject({
      state: 'custody-unknown', active: false, job_status: 'working', delivery: null,
      original: { handoff_repo_path: h.repo.path, repo_path: h.inspection.repoPath, branch: h.inspection.branch, base_sha: h.inspection.sha, producer_settlement_seq: h.inspection.producerSettlementSeq },
      custody: { worktree_id: h.job.id, branch: lane.branch, sha: lane.sha, status: 'active', evidence: 'manager-reconciliation' },
      admission: { agent_id: agentId, event_seq: spawnedSeq },
    });
    expect((readback['timeline'] as readonly Record<string, unknown>[]).map((entry) => entry['stage'])).toEqual(['accepted', 'custody-adopted', 'minion-spawned']);
    // The reopened ledger answers exactly what the first process answered.
    expect(readback).toEqual(before);

    const retry = await request(api.base, 'POST', { job_id: h.job.id, request_id: requestId });
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ error: 'creation_continuation_unknown', readback: { state: 'custody-unknown', active: false } });
    expect(retry.body['readback']).toEqual(before);
    expect([...first.spawns, ...api.spawns, ...first.prompts, ...api.prompts]).toEqual([]);
    expect(continuationEvents()).toEqual(eventsBefore);
    expect(api.ledger.listJobEventsByKinds(h.job.id, ['job.minion-spawned'])).toHaveLength(1);
    expect(api.ledger.listJobEventsByKinds(h.job.id, ['job.handoff'], { limit: 5 })).toHaveLength(1);
    expect(api.ledger.listAgents().filter((agent) => agent.jobId === h.job.id).map((agent) => agent.id)).toEqual([agentId]);
    expect(api.ledger.getJob(h.job.id)?.status).toBe('working');
    expect(git(api.repo, ['rev-parse', `refs/heads/gru/${h.job.id}`])).toBe(h.inspection.sha);
  });

  it('records exactly one request and starts at most one owner when the client aborts during the held inspection', async () => {
    const h = await retainedFixture('continuation-client-abort');
    const inspect = h.worktrees.inspectRetainedJobCreation.bind(h.worktrees);
    let reached!: () => void;
    const inspecting = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.worktrees.inspectRetainedJobCreation = async (input) => { reached(); await held; return inspect(input); };
    const logs: { readonly level: LogLevel; readonly msg: string; readonly fields: Record<string, unknown> | undefined }[] = [];
    const api = await httpHarness(h, { serverLog: (level, msg, fields) => { logs.push({ level, msg, fields }); } });
    const body = { job_id: api.jobId, request_id: 'client-abort-request' };
    const continuations = () => api.ledger.listJobEventsByKinds(api.jobId, ['job.creation-continuation'], { limit: 50 });

    const controller = new AbortController();
    const aborted = request(api.base, 'POST', body, TOKEN, controller.signal).then(() => 'answered', (error: unknown) => (error as Error).name);
    await inspecting;
    expect(continuations()).toEqual([]);
    controller.abort();
    expect(await aborted).toBe('AbortError');
    // The server saw the client leave while the inspection was still held.
    await vi.waitFor(() => {
      expect(logs.filter((entry) => entry.msg === 'dispatch request' && entry.fields?.['method'] === 'POST')).toHaveLength(1);
    }, { timeout: 10_000 });
    expect(continuations()).toEqual([]);
    release();

    // The request is recorded after the inspection returns, whoever is still listening.
    await vi.waitFor(() => { expect(api.ledger.getCreationContinuation(api.jobId, body.request_id)).not.toBeNull(); }, { timeout: 10_000 });
    const recorded = api.ledger.getCreationContinuation(api.jobId, body.request_id)!;
    const durable = () => {
      const events = continuations().map((event) => event.payload as Record<string, unknown>);
      return {
        requestIds: [...new Set(events.map((payload) => payload['request_id']))],
        generations: [...new Set(events.map((payload) => payload['generation']))],
        accepted: events.filter((payload) => payload['stage'] === 'accepted').length,
      };
    };
    expect(durable()).toEqual({ requestIds: [body.request_id], generations: [1], accepted: 1 });
    expect(recorded.identity.generation).toBe(1);

    // The client retries with the same id: it reads that request back and records nothing new.
    const retry = await request(api.base, 'POST', body);
    expect(durable()).toEqual({ requestIds: [body.request_id], generations: [1], accepted: 1 });
    expect(retry.status).toBe(200);
    expect(retry.body['readback']).toMatchObject({ job_id: api.jobId, request_id: body.request_id, generation: 1, payload_sha256: recorded.identity.payloadSha256 });
    const readback = await waitForState(api.base, api.jobId, body.request_id, 'delivered');
    expect(readback).toMatchObject({ generation: 1, active: false, admission: { agent_id: api.spawns[0] } });

    expect(durable()).toEqual({ requestIds: [body.request_id], generations: [1], accepted: 1 });
    expect(api.spawns).toHaveLength(1);
    expect(api.prompts).toHaveLength(1);
    expect(api.ledger.listJobEventsByKinds(api.jobId, ['job.minion-spawned'])).toHaveLength(1);
    expect(api.ledger.listJobEventsByKinds(api.jobId, ['job.handoff'], { limit: 5 })).toHaveLength(1);
    // A client leaving is not a server fault.
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it('journals positive producer closure when the owned branch transaction succeeds', async () => {
    const h = managerFixture('successful-producer-close');
    const jobId = 'continuation-successful-producer';
    h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: 'successful producer', baseBranch: 'main', briefing: 'original' });
    const lane = await h.worktrees.createJobWorktree({ repoPath: h.repo.path, jobId });
    // The event stores the digest of the receipt token, not the raw token;
    // its positive fact is the owned child close, independent of exit status.
    const event = h.ledger.listJobEventsByKinds(jobId, ['job.creation-producer-settled'])[0];
    expect(event).toMatchObject({ kind: 'job.creation-producer-settled', jobId });
    const payload = event!.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ branch: lane.branch, sha: lane.sha, close_observed: true, pid: expect.any(Number), exit_code: 0, signal: null });
    expect(h.ledger.hasSettledCreationProducer({ jobId, branch: lane.branch!, sha: lane.sha, tokenSha256: payload['token_sha256'] as string })).toEqual(event);
    expect(h.ledger.getWorktree(jobId)?.path).toBe(lane.path);
  });

  it('refuses unknown producer cessation and retains the receipt/ref without pretending PID absence is proof', async () => {
    const h = managerFixture('unknown-producer');
    const jobId = 'continuation-unknown-producer';
    const job = h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: 'unknown producer', baseBranch: 'main', briefing: 'original' });
    h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: job.repo, repoPath: h.repo.path } });
    h.ledger.setJobStatus(jobId, 'blocked');
    const branch = `gru/${jobId}`;
    const sha = git(h.repo, ['rev-parse', 'HEAD']);
    const token = `gru-creation:${randomUUID()}`;
    writeCreationIntent(git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), {
      lane: { id: jobId, kind: 'job', jobId, roundId: null, path: join(h.root, basename(h.repo.path), `job-${jobId}`) },
      repoPath: realpathSync(h.repo.path), branch, sha, baseSource: 'local-head-fallback', token,
    });
    git(h.repo, ['update-ref', '-m', token, `refs/heads/${branch}`, sha]);
    const api = await httpHarness({ ...h, job });
    const response = await request(api.base, 'POST', { job_id: jobId, request_id: 'unknown-producer-request' });
    expect(response.status).toBe(409);
    const readback = response.body['readback'] as Record<string, unknown>;
    expect(readback['state']).toBe('refused');
    expect(readback['reason']).toMatch(/cessation is UNKNOWN|no exact positive/u);
    expect(api.spawns).toHaveLength(0);
    expect(api.ledger.getWorktree(jobId)).toBeNull();
    expect(git(api.repo, ['rev-parse', `refs/heads/${branch}`])).toBe(sha);
    expect(receiptFiles(api.repo)).toHaveLength(1);
  });

  it('strict manager continuation never resolves a fresh base when the receipt or retained ref is absent', async () => {
    const h = managerFixture('no-fresh-base');
    const jobId = 'continuation-no-fresh-base';
    h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: 'no fresh base', baseBranch: 'main', briefing: 'original' });
    await expect(h.worktrees.createRetainedJobWorktree({ repoPath: h.repo.path, jobId, expected: { receiptTokenSha256: '0'.repeat(64), producerSettlementSeq: 1 } })).rejects.toThrow(/receipt .* absent|receipt .* unreadable/u);
    expect(git(h.repo, ['branch', '--list', `gru/${jobId}`])).toBe('');
    expect(h.ledger.getWorktree(jobId)).toBeNull();

    const retained = await retainedFixture('continuation-no-ref');
    const branch = `refs/heads/gru/${retained.job.id}`;
    git(retained.repo, ['update-ref', '-d', branch]);
    const receiptBefore = receiptFiles(retained.repo);
    await expect(retained.worktrees.createRetainedJobWorktree({ repoPath: retained.repo.path, jobId: retained.job.id, expected: retained.inspection })).rejects.toThrow(/no branch ref|cannot clear the receipt|new base/u);
    expect(receiptFiles(retained.repo)).toEqual(receiptBefore);
    expect(retained.ledger.getWorktree(retained.job.id)).toBeNull();
    expect(git(retained.repo, ['branch', '--list', `gru/${retained.job.id}`])).toBe('');
  });

  it('refuses unsettled locks, symbolic/moved refs and foreign checkout holders without discarding custody', async () => {
    for (const guard of ['lock', 'symbolic-ref', 'moved-ref', 'foreign-holder', 'foreign-checkout', 'foreign-admin', 'unreadable-receipt'] as const) {
      const h = await retainedFixture(`continuation-fence-${guard}`);
      const branch = `refs/heads/gru/${h.job.id}`;
      const receiptBefore = receiptFiles(h.repo);
      if (guard === 'lock') {
        const common = git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const lock = join(common, 'refs/heads', `${h.inspection.branch}.lock`);
        mkdirSync(join(common, 'refs/heads'), { recursive: true });
        writeFileSync(lock, 'synthetic lock\n');
      } else if (guard === 'unreadable-receipt') {
        const common = git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        const receipt = join(common, 'gru-creation', `${createHash('sha256').update(h.inspection.branch).digest('hex').slice(0, 40)}.json`);
        writeFileSync(receipt, '{ malformed receipt\n');
      } else if (guard === 'symbolic-ref') {
        // Rewrite the loose ref in place: its own reflog still names the
        // receipt and the alias resolves to the same base, so only the
        // symbolic-ref guard can refuse it.
        git(h.repo, ['update-ref', 'refs/heads/fixture-alias', h.inspection.sha]);
        const common = git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
        writeFileSync(join(common, branch), 'ref: refs/heads/fixture-alias\n');
      } else if (guard === 'moved-ref') {
        const moved = h.repo.commitFile('changed-base.txt', 'moved\n', 'synthetic moved base');
        git(h.repo, ['update-ref', '-m', 'foreign move', branch, moved]);
      } else if (guard === 'foreign-holder') {
        const holder = join(directory(), 'foreign-holder');
        git(h.repo, ['worktree', 'add', '--quiet', holder, h.inspection.branch]);
      } else if (guard === 'foreign-checkout') {
        mkdirSync(join(h.root, basename(h.repo.path), `job-${h.job.id}`), { recursive: true });
      } else {
        const expectedPath = join(h.root, basename(h.repo.path), `job-${h.job.id}`);
        mkdirSync(join(h.root, basename(h.repo.path)), { recursive: true });
        git(h.repo, ['worktree', 'add', '--quiet', '--detach', expectedPath, h.inspection.sha]);
      }
      await expect(h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId: h.job.id })).rejects.toThrow(
        guard === 'lock' ? /unsettled ref transaction/u
          : guard === 'unreadable-receipt' ? /not valid JSON/u
            : guard === 'symbolic-ref' ? /is a symbolic ref/u
            : guard === 'moved-ref' ? /names base/u
              : guard === 'foreign-holder' ? /held by a worktree/u
                : guard === 'foreign-checkout' ? /checkout at/u
                  : /administration/u,
      );
      expect(receiptFiles(h.repo)).toEqual(receiptBefore);
      expect(h.ledger.getWorktree(h.job.id)).toBeNull();
      if (guard === 'moved-ref') expect(git(h.repo, ['rev-parse', branch])).not.toBe(h.inspection.sha);
      if (guard === 'foreign-holder') expect(git(h.repo, ['worktree', 'list', '--porcelain'])).toContain('foreign-holder');
    }
  });

  it('refuses changed retained fences while preserving the foreign ref and original receipt', async () => {
    const h = await retainedFixture('continuation-wrong-reflog');
    const branch = `refs/heads/gru/${h.job.id}`;
    const base = h.inspection.sha;
    const other = h.repo.commitFile('foreign-change.txt', 'foreign\n', 'foreign fixture move');
    git(h.repo, ['update-ref', '-m', 'foreign movement', branch, other]);
    git(h.repo, ['update-ref', '-m', 'foreign movement', branch, base]);
    const before = receiptFiles(h.repo);
    await expect(h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId: h.job.id })).rejects.toThrow(/reflog/u);
    expect(git(h.repo, ['rev-parse', branch])).toBe(base);
    expect(receiptFiles(h.repo)).toEqual(before);
    expect(h.ledger.getWorktree(h.job.id)).toBeNull();
  });
});
