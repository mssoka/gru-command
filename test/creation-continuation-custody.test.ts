import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DispatchService } from '../src/dispatch/service.js';
import type { DiskFloorGate, FloorAdmission } from '../src/maintenance/disk.js';
import { clearCreationIntent, readCreationIntent, writeCreationIntent } from '../src/worktrees/creation-intent.js';
import type { LogLevel } from '../src/logger.js';
import {
  acceptDirectly, cleanupContinuationFixtures, committedExitWithoutClose, directory, fakeHandle, git, hasRawCreationToken, httpHarness,
  managerFixture, processGone, receiptFiles, request, retainedFixture, sha256, syntheticRetained, waitForState, type RetainedFixture,
} from './helpers/creation-continuation.js';

afterEach(cleanupContinuationFixtures);

/** A disk floor that queues every lane until released; its signal ends the wait. */
function heldFloor() {
  let release: (() => void) | null = null;
  const floor: Pick<DiskFloorGate, 'admitLane'> = {
    admitLane: (input) => new Promise<FloorAdmission>((resolve, reject) => {
      input.queued?.({ reason: 'fixture disk floor below threshold', position: 1 });
      input.signal?.addEventListener('abort', () => reject(new Error(`disk floor wait ended: ${String(input.signal?.reason)}`)), { once: true });
      release = () => resolve({ waitedMs: 1, done() {} });
    }),
  };
  return { floor, release: () => release!() };
}

function logSink() {
  const entries: { readonly level: LogLevel; readonly msg: string; readonly fields: Record<string, unknown> }[] = [];
  return { entries, log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => { entries.push({ level, msg, fields: fields ?? {} }); } };
}

/** Every event payload and the note of one job, as text. */
function jobRecordText(h: Pick<RetainedFixture, 'ledger'>, jobId: string): string {
  return JSON.stringify({ note: h.ledger.getJob(jobId)?.note ?? null, events: h.ledger.listJobEvents(jobId, { limit: 1000 }).map((event) => [event.kind, event.payload]) });
}

/** A job dispatched once whose Git child exited while a descendant holds its pipes. */
async function exitedWithoutClose(h: ReturnType<typeof managerFixture>, jobId: string, holdSeconds: number) {
  const job = h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: `Title ${jobId}`, baseBranch: 'main', briefing: `Original briefing ${jobId}` });
  h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: job.repo, repoPath: h.repo.path } });
  h.ledger.setJobStatus(jobId, 'working');
  const pidFile = join(directory(), 'holder.pid');
  const restore = committedExitWithoutClose(pidFile, holdSeconds);
  await expect(h.worktrees.createJobWorktree({ repoPath: h.repo.path, jobId })).rejects.toThrow(/did not close within 1000ms/u);
  vi.stubEnv('PATH', restore);
  h.ledger.setJobStatus(jobId, 'blocked');
  return Number(readFileSync(pidFile, 'utf8'));
}

const settlements = (h: Pick<RetainedFixture, 'ledger'>, jobId: string) => h.ledger.listJobEventsByKinds(jobId, ['job.creation-producer-settled']);

describe('retained-creation continuation custody', () => {
  it('settles an exited Git producer once, only after the descendant holding its pipes stops, and the continuation is then admissible', async () => {
    const h = managerFixture('late-close');
    const jobId = 'late-close';
    const holder = await exitedWithoutClose(h, jobId, 5);
    expect(processGone(holder)).toBe(false);
    expect(settlements(h, jobId)).toHaveLength(0);
    await expect(h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId })).rejects.toThrow(/cessation is UNKNOWN/u);
    await vi.waitFor(() => { expect(processGone(holder)).toBe(true); }, { timeout: 10_000 });
    await vi.waitFor(() => { expect(settlements(h, jobId)).toHaveLength(1); });
    const inspection = await h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId });
    expect(inspection.producerSettlementSeq).toBe(settlements(h, jobId)[0]!.seq);
    const api = await httpHarness({ ...h, job: h.ledger.getJob(jobId)!, inspection });
    expect((await request(api.base, 'POST', { job_id: jobId, request_id: 'late-close' })).status).toBe(202);
    await waitForState(api.base, jobId, 'late-close', 'delivered');
    expect(settlements(h, jobId)).toHaveLength(1);
    expect(api.spawns).toHaveLength(1);
  });

  it('never counts the close its own released pipes cause as producer settlement', async () => {
    const h = managerFixture('released-close', { creationCloseWindowMs: 100 });
    const jobId = 'released-close';
    const holder = await exitedWithoutClose(h, jobId, 3);
    await vi.waitFor(() => { expect(processGone(holder)).toBe(true); }, { timeout: 10_000 });
    expect(settlements(h, jobId)).toHaveLength(0);
    await expect(h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId })).rejects.toThrow(/cessation is UNKNOWN/u);
  });

  it('records one settlement per receipt token and refuses the token for another branch', async () => {
    const h = managerFixture('settlement-once');
    const sha = git(h.repo, ['rev-parse', 'HEAD']);
    const tokenSha256 = sha256(`gru-creation:${randomUUID()}`);
    h.ledger.addJob({ id: 'settled-once', repo: basename(h.repo.path), title: 'once', baseBranch: 'main', briefing: 'once' });
    const first = h.ledger.recordCreationProducerSettlement({ jobId: 'settled-once', branch: 'gru/settled-once', sha, tokenSha256, pid: 4242, exitCode: 0, signal: null });
    expect(h.ledger.recordCreationProducerSettlement({ jobId: 'settled-once', branch: 'gru/settled-once', sha, tokenSha256, pid: 4343, exitCode: null, signal: 'SIGKILL' })).toEqual(first);
    h.ledger.addJob({ id: 'other-branch', repo: basename(h.repo.path), title: 'other', baseBranch: 'main', briefing: 'other' });
    expect(() => h.ledger.recordCreationProducerSettlement({ jobId: 'other-branch', branch: 'gru/other-branch', sha, tokenSha256, pid: 4242, exitCode: 0, signal: null }))
      .toThrow(/already settled for job "settled-once"/u);
    expect(settlements(h, 'settled-once')).toHaveLength(1);
    expect(settlements(h, 'other-branch')).toHaveLength(0);
  });

  it('keeps an ordinary dispatch when its producer settlement cannot be recorded, and logs it', async () => {
    const sink = logSink();
    const h = managerFixture('settlement-write-failure', { log: sink.log });
    const jobId = 'settlement-write-failure';
    h.ledger.recordCreationProducerSettlement = () => { throw new Error('synthetic SQLITE_BUSY'); };
    const prompts: string[] = [];
    const dispatch = new DispatchService({ ledger: h.ledger, worktrees: h.worktrees, spawner: async () => fakeHandle('ordinary-minion', prompts) });
    const outcome = await dispatch.dispatch({ jobId, repoPath: h.repo.path, title: 'ordinary', briefing: 'ordinary briefing' });
    expect(await outcome.settled).toEqual({ ok: true });
    expect(h.ledger.getJob(jobId)?.status).toBe('delivered');
    expect(h.ledger.getWorktree(jobId)).toMatchObject({ status: 'active', branch: `gru/${jobId}` });
    expect(receiptFiles(h.repo)).toHaveLength(0);
    expect(sink.entries).toContainEqual(expect.objectContaining({ level: 'error', msg: expect.stringMatching(/producer settlement could not be recorded/u) }));
  });

  it('runs the configured setup in the continuation lane', async () => {
    const h = await retainedFixture('setup-runs', { prepare: (repo) => { repo.commitFile('.gru-command/worktree.toml', '[[setup]]\ncommand = "touch setup-ran.txt"\n', 'fixture setup manifest'); } });
    const api = await httpHarness(h);
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'setup' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'setup', 'delivered');
    expect(existsSync(join(api.ledger.getWorktree(api.jobId)!.path, 'setup-ran.txt'))).toBe(true);
    expect(api.ledger.listJobEventsByKinds(api.jobId, ['worktree.bootstrapped'])).toHaveLength(1);
  });

  it('keeps the retained ref and receipt when the configured setup fails after adoption and reads back failed with custody retained', async () => {
    const h = await retainedFixture('setup-fails', { prepare: (repo) => { repo.commitFile('.gru-command/worktree.toml', '[[setup]]\ncommand = "exit 7"\n', 'failing setup manifest'); } });
    const api = await httpHarness(h);
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'setup-fails' })).status).toBe(202);
    const failed = await waitForState(api.base, api.jobId, 'setup-fails', 'failed');
    expect(failed).toMatchObject({ active: false, custody: null, admission: null, delivery: null });
    expect(failed['reason']).toMatch(/^retained creation of branch gru\/setup-fails failed after adoption; its ref and receipt are kept: worktree setup command exited 7/u);
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'retained-custody-kept' });
    expect(git(api.repo, ['rev-parse', `refs/heads/gru/${api.jobId}`])).toBe(h.inspection.sha);
    expect(receiptFiles(api.repo)).toHaveLength(1);
    expect(api.spawns).toHaveLength(0);
    expect(api.ledger.getJob(api.jobId)?.status).toBe('blocked');
  });

  it('disposes the spawned minion and its agent row when a write after the spawn throws', async () => {
    const h = await retainedFixture('admitted-write');
    const original = h.ledger.recordCreationContinuationState.bind(h.ledger);
    h.ledger.recordCreationContinuationState = (input) => {
      if (input.state === 'admitted') throw new Error('synthetic admitted-state write failure');
      return original(input);
    };
    const api = await httpHarness(h);
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'admitted-write' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'admitted-write', 'custody-unknown');
    expect(api.spawns).toEqual(['fixture-minion-1']);
    expect(api.disposed).toEqual(['fixture-minion-1']);
    expect(api.prompts).toHaveLength(0);
    expect(api.ledger.getAgent('fixture-minion-1')?.state).toBe('disposed');
    expect(api.ledger.getJob(api.jobId)?.status).toBe('blocked');
  });

  it('settles the job delivered when only the continuation delivered-state write fails', async () => {
    const h = await retainedFixture('delivered-write');
    const original = h.ledger.recordCreationContinuationState.bind(h.ledger);
    h.ledger.recordCreationContinuationState = (input) => {
      if (input.state === 'delivered') throw new Error('synthetic delivered-state write failure');
      return original(input);
    };
    const sink = logSink();
    const api = await httpHarness(h, { service: { log: sink.log } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'delivered-write' })).status).toBe(202);
    await vi.waitFor(() => { expect(api.ledger.getJob(api.jobId)?.status).toBe('delivered'); }, { timeout: 10_000 });
    const readback = await waitForState(api.base, api.jobId, 'delivered-write', 'delivered');
    expect(readback).toMatchObject({ active: false, delivery: { agent_id: 'fixture-minion-1' } });
    expect(api.ledger.getCreationContinuation(api.jobId, 'delivered-write')?.state).toBe('admitted');
    expect(sink.entries).toContainEqual(expect.objectContaining({ level: 'error', msg: expect.stringMatching(/delivered state could not be recorded/u) }));
  });

  it('never writes a creation token into a job note or event when the checkout cannot be added', async () => {
    const h = await retainedFixture('token-worktree-add');
    const parent = join(h.root, basename(h.repo.path));
    mkdirSync(parent, { recursive: true });
    chmodSync(parent, 0o555);
    try {
      const api = await httpHarness(h);
      expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'token-worktree-add' })).status).toBe(202);
      const failed = await waitForState(api.base, api.jobId, 'token-worktree-add', 'failed');
      expect(failed['reason']).toMatch(/<redacted-creation-token>/u);
      expect(api.ledger.getJob(api.jobId)?.note).toMatch(/^dispatch failed: .*<redacted-creation-token>/u);
      expect(hasRawCreationToken(jobRecordText(api, api.jobId))).toBe(false);

      // Ordinary dispatch writes its failure note through the same redaction.
      const prompts: string[] = [];
      const dispatch = new DispatchService({ ledger: h.ledger, worktrees: h.worktrees, spawner: async () => fakeHandle('ordinary-minion', prompts) });
      await expect(dispatch.dispatch({ jobId: 'token-ordinary', repoPath: h.repo.path, title: 'ordinary', briefing: 'ordinary briefing' })).rejects.toThrow(/gru-creation:/u);
      expect(h.ledger.getJob('token-ordinary')?.note).toMatch(/^dispatch failed: .*<redacted-creation-token>/u);
      expect(hasRawCreationToken(jobRecordText(h, 'token-ordinary'))).toBe(false);
    } finally {
      chmodSync(parent, 0o755);
    }
  });

  it('never writes a creation token into a job note or event when a foreign administration appears after inspection', async () => {
    const h = await retainedFixture('token-foreign-admin');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'token-foreign-admin' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'token-foreign-admin', 'queued');
    const common = realpathSync(git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const parent = join(h.root, basename(h.repo.path));
    mkdirSync(parent, { recursive: true });
    const admin = join(common, 'worktrees', 'forged');
    mkdirSync(admin, { recursive: true });
    writeFileSync(join(admin, 'gitdir'), `${join(realpathSync(parent), `job-${api.jobId}`, '.git')}\n`);
    writeFileSync(join(admin, 'HEAD'), `ref: refs/heads/gru/${api.jobId}\n`);
    writeFileSync(join(admin, 'commondir'), '../..\n');
    writeFileSync(join(admin, 'locked'), `gru-creation:${randomUUID()}\n`);
    held.release();
    const refused = await waitForState(api.base, api.jobId, 'token-foreign-admin', 'refused');
    expect((refused['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'refused', stage: 'manager-guard-refused' });
    expect(api.ledger.getJob(api.jobId)?.note).toMatch(/^dispatch failed: .*<redacted-creation-token>/u);
    expect(hasRawCreationToken(jobRecordText(api, api.jobId))).toBe(false);
    expect(api.spawns).toHaveLength(0);
  });

  it('reads back custody-unknown when shutdown cancels the automatic retries after the prompt was sent', async () => {
    const h = await retainedFixture('shutdown-cancel');
    const stop = new AbortController();
    const api = await httpHarness(h, { service: { stopSignal: stop.signal, retrySettlement: () => { stop.abort(); return new Promise(() => {}); } } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'shutdown-cancel' })).status).toBe(202);
    const unknown = await waitForState(api.base, api.jobId, 'shutdown-cancel', 'custody-unknown');
    expect(api.prompts).toHaveLength(1);
    expect(unknown).toMatchObject({ active: false, admission: { agent_id: 'fixture-minion-1' }, delivery: null });
    expect((unknown['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'custody-unknown', stage: 'turn-outcome-unknown' });
  });

  it('takes the job admission after the disk floor, so the owner can bin a continuation queued there', async () => {
    const h = await retainedFixture('bin-at-floor');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor, bus: h.bus } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'bin-at-floor' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'bin-at-floor', 'queued');
    expect(api.ledger.listJobAdmissions(api.jobId)).toEqual([]);
    api.ledger.setJobStatus(api.jobId, 'binned');
    const failed = await waitForState(api.base, api.jobId, 'bin-at-floor', 'failed');
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'failed-before-manager' });
    expect(api.ledger.getJob(api.jobId)?.status).toBe('binned');
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(git(api.repo, ['rev-parse', `refs/heads/gru/${api.jobId}`])).toBe(h.inspection.sha);
    expect(receiptFiles(api.repo)).toHaveLength(1);
    expect(api.spawns).toHaveLength(0);
  });

  it('refuses a live property admission taken while queued at the floor as admission-refused', async () => {
    const h = await retainedFixture('admission-refused');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'admission-refused' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'admission-refused', 'queued');
    const releaseProperty = api.ledger.beginJobAdmission(api.jobId, 'property repair fixture');
    try {
      held.release();
      const refused = await waitForState(api.base, api.jobId, 'admission-refused', 'refused');
      expect((refused['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'refused', stage: 'admission-refused' });
      expect(refused['reason']).toMatch(/competing property\/producer admission/u);
    } finally {
      releaseProperty();
    }
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(api.spawns).toHaveLength(0);
  });

  it('refuses a receipt swapped after acceptance even when it carries its own settlement', async () => {
    const h = await retainedFixture('swapped-receipt');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'swapped-receipt' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'swapped-receipt', 'queued');
    const common = git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const original = readCreationIntent(common, h.inspection.branch)!;
    const token = `gru-creation:${randomUUID()}`;
    clearCreationIntent(common, h.inspection.branch, original.token);
    writeCreationIntent(common, { lane: original.lane, repoPath: original.repoPath, branch: original.branch, sha: original.sha, baseSource: original.baseSource, token });
    const ref = `refs/heads/${h.inspection.branch}`;
    git(h.repo, ['update-ref', '-m', 'fixture swap', ref, h.repo.commitFile('swap.txt', 'swap\n', 'fixture swap')]);
    git(h.repo, ['update-ref', '-m', token, ref, h.inspection.sha]);
    h.ledger.recordCreationProducerSettlement({ jobId: api.jobId, branch: h.inspection.branch, sha: h.inspection.sha, tokenSha256: sha256(token), pid: 4242, exitCode: 0, signal: null });
    // The swapped receipt is otherwise a valid retained creation.
    expect((await h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId: api.jobId })).receiptTokenSha256).toBe(sha256(token));
    held.release();
    const refused = await waitForState(api.base, api.jobId, 'swapped-receipt', 'refused');
    expect((refused['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'refused', stage: 'manager-guard-refused' });
    expect(refused['reason']).toMatch(/is not the receipt this continuation accepted/u);
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(receiptFiles(api.repo)).toHaveLength(1);
    expect(api.spawns).toHaveLength(0);
  });

  it('applies one canonical repository rule in the service and the ledger and names a symlinked mismatch', async () => {
    const h = managerFixture('canonical-repository');
    const alias = join(directory(), 'alias-name');
    symlinkSync(h.repo.path, alias);
    const jobId = 'canonical-repository';
    // Dispatch through the alias records its leaf as the job's repository.
    const job = h.ledger.addJob({ id: jobId, repo: 'alias-name', title: 'alias', baseBranch: 'main', briefing: 'Original briefing alias' });
    const handoff = h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: 'alias-name', repoPath: alias } });
    h.ledger.setJobStatus(jobId, 'working');
    h.ledger.setJobStatus(jobId, 'blocked');
    const api = await httpHarness({ ...h, job });
    const response = await request(api.base, 'POST', { job_id: jobId, request_id: 'alias' });
    expect(response.status).toBe(409);
    const reason = (response.body['readback'] as Record<string, unknown>)['reason'];
    const canonical = realpathSync(h.repo.path);
    expect(reason).toBe(`job "${jobId}" records repository "alias-name", but its handoff path resolves to "${basename(canonical)}" (${canonical})`);
    const direct = h.ledger.acceptCreationContinuation({
      jobId, requestId: 'direct', payloadSha256: sha256('direct'), handoffSeq: handoff.seq, briefingSha256: sha256(job.briefing!),
      handoffRepoPath: alias, repoPath: canonical, branch: `gru/${jobId}`, baseSha: git(h.repo, ['rev-parse', 'HEAD']),
      baseSource: 'local-head-fallback', producerSettlementSeq: null, receiptTokenSha256: null,
    });
    expect(direct.timeline).toMatchObject({ state: 'refused' });
    expect((direct.timeline.events[0]!.payload as Record<string, unknown>)['reason']).toBe(reason);
  });

  it('starts one owner for concurrent identical requests (a client timeout retry)', async () => {
    const h = await retainedFixture('in-flight-duplicate');
    // Both requests pass the pre-acceptance readback before either inspects.
    const inspect = h.worktrees.inspectRetainedJobCreation.bind(h.worktrees);
    let arrived = 0;
    let open!: () => void;
    const both = new Promise<void>((resolve) => { open = resolve; });
    h.worktrees.inspectRetainedJobCreation = async (input) => { arrived += 1; if (arrived === 2) open(); await both; return inspect(input); };
    const api = await httpHarness(h);
    const body = { job_id: api.jobId, request_id: 'duplicate' };
    const outcomes = await Promise.all([request(api.base, 'POST', body), request(api.base, 'POST', body)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([200, 202]);
    await waitForState(api.base, api.jobId, 'duplicate', 'delivered');
    await vi.waitFor(() => { expect(api.dispatch.getCreationContinuationReadback(api.jobId, 'duplicate')?.active).toBe(false); });
    expect(api.ledger.getJob(api.jobId)?.status).toBe('delivered');
    expect(api.spawns).toHaveLength(1);
    expect(api.prompts).toHaveLength(1);
  });

  it('reads back a live admitted turn whose prompt is still running as admitted, active and undelivered', async () => {
    const h = await retainedFixture('live-admitted');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const api = await httpHarness(h, { prompt: () => held });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'live-admitted' })).status).toBe(202);
    await vi.waitFor(() => { expect(api.prompts).toHaveLength(1); }, { timeout: 10_000 });
    const live = (await request(api.base, 'GET', { job_id: api.jobId, request_id: 'live-admitted' })).body['readback'];
    expect(live).toMatchObject({ state: 'admitted', active: true, delivery: null, admission: { agent_id: 'fixture-minion-1' } });
    release();
    await waitForState(api.base, api.jobId, 'live-admitted', 'delivered');
  });

  it('refuses through the dispatch path, with no fresh base, when the retained ref is lost while queued', async () => {
    const h = await retainedFixture('no-fresh-dispatch');
    const held = heldFloor();
    const api = await httpHarness(h, { service: { diskFloor: held.floor } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'no-fresh' })).status).toBe(202);
    await waitForState(api.base, api.jobId, 'no-fresh', 'queued');
    git(api.repo, ['update-ref', '-d', `refs/heads/gru/${api.jobId}`]);
    held.release();
    const refused = await waitForState(api.base, api.jobId, 'no-fresh', 'refused');
    expect((refused['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'refused', stage: 'manager-guard-refused' });
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(git(api.repo, ['branch', '--list', `gru/${api.jobId}`])).toBe('');
    expect(receiptFiles(api.repo)).toHaveLength(1);
    expect(api.spawns).toHaveLength(0);
  });

  it('never accepts a producer settlement bound to another receipt token', async () => {
    const h = managerFixture('token-binding');
    const retained = syntheticRetained(h, 'token-binding', { settle: false });
    // An earlier, different attempt's settlement on the same branch and base.
    h.ledger.recordCreationProducerSettlement({ jobId: 'token-binding', branch: retained.branch, sha: retained.sha, tokenSha256: sha256(`gru-creation:${randomUUID()}`), pid: 4242, exitCode: 0, signal: null });
    const api = await httpHarness({ ...h, job: retained.job });
    const response = await request(api.base, 'POST', { job_id: 'token-binding', request_id: 'token-binding' });
    expect(response.status).toBe(409);
    expect((response.body['readback'] as Record<string, unknown>)['reason']).toMatch(/cessation is UNKNOWN/u);
    const settled = settlements(h, 'token-binding')[0]!;
    const direct = h.ledger.acceptCreationContinuation({
      jobId: 'token-binding', requestId: 'direct', payloadSha256: sha256('direct'),
      handoffSeq: h.ledger.listJobEventsByKinds('token-binding', ['job.handoff'])[0]!.seq, briefingSha256: sha256(retained.job.briefing!),
      handoffRepoPath: h.repo.path, repoPath: realpathSync(h.repo.path), branch: retained.branch, baseSha: retained.sha,
      baseSource: 'local-head-fallback', producerSettlementSeq: settled.seq, receiptTokenSha256: sha256(retained.token),
    });
    expect(direct.timeline).toMatchObject({ state: 'refused' });
    expect((direct.timeline.events[0]!.payload as Record<string, unknown>)['reason']).toMatch(/no exact positive retained-creation producer settlement/u);
    expect(api.ledger.getWorktree('token-binding')).toBeNull();
    expect(api.spawns).toHaveLength(0);
  });

  it('refuses a new request while an earlier one is custody-unknown', async () => {
    const h = await retainedFixture('unknown-fence');
    const first = acceptDirectly(h, 'first');
    h.ledger.recordCreationContinuationState({ jobId: h.job.id, requestId: 'first', generation: first.timeline.identity.generation, state: 'custody-unknown', stage: 'unsettled-failure', details: { reason: 'fixture' } });
    const api = await httpHarness(h);
    const second = await request(api.base, 'POST', { job_id: api.jobId, request_id: 'second' });
    expect(second.status).toBe(409);
    expect((second.body['readback'] as Record<string, unknown>)['reason']).toMatch(/another continuation request first owns this job's continuation fence/u);
    expect(api.ledger.getWorktree(api.jobId)).toBeNull();
    expect(api.spawns).toHaveLength(0);
  });

  it('records a turn that settles failed as a known turn-settled failure', async () => {
    const h = await retainedFixture('turn-failure');
    const api = await httpHarness(h, { prompt: async () => { throw new Error('synthetic turn failure'); } });
    expect((await request(api.base, 'POST', { job_id: api.jobId, request_id: 'turn-failure' })).status).toBe(202);
    const failed = await waitForState(api.base, api.jobId, 'turn-failure', 'failed');
    expect(failed).toMatchObject({ active: false, admission: { agent_id: 'fixture-minion-1' }, delivery: null, reason: expect.stringMatching(/synthetic turn failure/u) });
    expect((failed['timeline'] as readonly Record<string, unknown>[]).at(-1)).toMatchObject({ state: 'failed', stage: 'turn-settled-failure' });
    expect(api.prompts).toHaveLength(1);
  });
});
