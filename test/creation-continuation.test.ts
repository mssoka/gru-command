import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { loadConfig } from '../src/config.js';
import { DispatchService } from '../src/dispatch/service.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import type { WaveRunner } from '../src/dispatch/perkins.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { repositoryGitEnv } from '../src/dispatch/perkins-review/artifacts.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { PacingGate } from '../src/runtime/pacing.js';
import type { DiskFloorGate, FloorAdmission } from '../src/maintenance/disk.js';
import { writeCreationIntent } from '../src/worktrees/creation-intent.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

const TOKEN = 'synthetic-continuation-test-token';
const repos: FixtureRepo[] = [];
const dirs: string[] = [];
const dbs: LedgerDb[] = [];
const servers: { readonly server: HttpServer; readonly api: ReturnType<typeof createDispatchServer> }[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (servers.length > 0) {
    const current = servers.pop()!;
    current.api.dispose();
    await new Promise<void>((resolve, reject) => current.server.close((error) => error ? reject(error) : resolve()));
  }
  while (dbs.length > 0) dbs.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  while (repos.length > 0) repos.pop()!.cleanup();
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'gru-creation-continuation-'));
  dirs.push(path);
  return path;
}

function git(repo: FixtureRepo, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', repo.path, ...args], {
    encoding: 'utf8', env: { ...repositoryGitEnv(false), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function managerFixture(name: string) {
  const repo = makeFixtureRepo(name);
  repos.push(repo);
  const root = directory();
  const preserveRoot = directory();
  const db = new LedgerDb(directory());
  dbs.push(db);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  const worktrees = new WorktreeManager({ ledger, root, preserveRoot, setupTimeoutMs: 30_000, enumerateProcesses: () => [] });
  return { repo, root, ledger, worktrees };
}

/** A synthetic Git wrapper commits its first update-ref, then remains alive
 * past the close budget. WorktreeManager sends signals only to this owned
 * fixture child and records its later Node close event as producer cessation. */
function committedStall(repo: FixtureRepo, branch: string): string {
  const root = directory();
  const originalPath = process.env.PATH ?? '';
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const script = join(root, 'git');
  writeFileSync(script, [
    '#!/usr/bin/env node',
    'const cp = require("node:child_process"), fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    `const real = ${JSON.stringify(realGit)};`,
    `const branch = ${JSON.stringify(branch)};`,
    `const once = ${JSON.stringify(join(root, 'stalled'))};`,
    `if (args[0] !== 'update-ref' || !args.includes('--stdin')) { const r = cp.spawnSync(real, args, {stdio:'inherit'}); process.exit(r.status ?? 1); }`,
    `const child = cp.spawn(real, args, {stdio:['pipe','pipe','pipe']});`,
    'const stall = !fs.existsSync(once); if (stall) fs.writeFileSync(once, "1");',
    'child.stdin.on("error", () => {}); process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);',
    'let exited = false;',
    'process.on("SIGTERM", () => {});',
    'child.on("close", code => { exited = true; if (!stall) { process.exit(code ?? 1); } setInterval(() => {}, 1000); });',
  ].join('\n') + '\n');
  chmodSync(script, 0o755);
  vi.stubEnv('PATH', `${root}:${process.env.PATH ?? ''}`);
  return originalPath;
}

async function retainedFixture(jobId: string) {
  const h = managerFixture(`retained-${jobId}`);
  const job = h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: `Title ${jobId}`, baseBranch: 'main', briefing: `Original briefing ${jobId}` });
  h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: job.repo, repoPath: h.repo.path } });
  h.ledger.setJobStatus(jobId, 'working');
  const originalPath = committedStall(h.repo, `gru/${jobId}`);
  await expect(h.worktrees.createJobWorktree({ repoPath: h.repo.path, jobId })).rejects.toThrow(/did not close within 1000ms/u);
  vi.stubEnv('PATH', originalPath);
  h.ledger.setJobStatus(jobId, 'blocked');
  expect(h.ledger.getWorktree(jobId)).toBeNull();
  const inspection = await h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId });
  expect(inspection.sha).toBe(git(h.repo, ['rev-parse', `refs/heads/gru/${jobId}`]));
  return { ...h, job: h.ledger.getJob(jobId)!, inspection };
}

function fakeHandle(id: string, prompts: string[]): AgentHandle {
  const capabilities = {
    streaming: true, steer: 'native' as const, resume: 'file' as const,
    images: false, thinking: false, thinkingLevelControl: false, followUp: false,
  };
  return {
    role: 'minion', id, sessionFile: null, capabilities,
    async prompt(text) { prompts.push(text); },
    async steer() {}, async followUp() {}, subscribe() { return () => {}; },
    health() { return { state: 'idle', lastActivity: null, sessionFile: null }; },
    async dispose() {},
  };
}

type RetainedFixture = Awaited<ReturnType<typeof retainedFixture>>;
async function httpHarness(
  h: Omit<RetainedFixture, 'inspection'> & { readonly inspection?: RetainedFixture['inspection'] },
  workerGate?: PacingGate,
  diskFloor?: Pick<DiskFloorGate, 'admitLane'>,
  spawnFailure?: Error,
) {
  const configDir = directory();
  writeFileSync(join(configDir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf8');
  const config = loadConfig({ GRU_COMMAND_HOME: configDir }, '/home/tester');
  const prompts: string[] = [];
  const spawns: string[] = [];
  const dispatch = new DispatchService({
    ledger: h.ledger,
    worktrees: h.worktrees,
    ...(workerGate !== undefined ? { workerGate } : {}),
    ...(diskFloor !== undefined ? { diskFloor } : {}),
    spawner: async () => {
      if (spawnFailure !== undefined) throw spawnFailure;
      const id = `fixture-minion-${spawns.length + 1}`;
      spawns.push(id);
      return fakeHandle(id, prompts);
    },
  });
  const api = createDispatchServer({ config, dispatch, wave: {} as WaveRunner, ledger: h.ledger, pendingProducerBlockers: () => [] });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (!api.requestHook(req, res, path)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ server, api });
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, dispatch, ledger: h.ledger, worktrees: h.worktrees, prompts, spawns, repo: h.repo, jobId: h.job.id, inspection: h.inspection ?? null };
}

async function request(base: string, method: 'GET' | 'POST', body?: unknown, token: string | null = TOKEN) {
  const response = await fetch(`${base}/api/dispatch/creation-continuation${method === 'GET' ? `?job_id=${encodeURIComponent(String((body as { job_id?: string } | undefined)?.job_id ?? ''))}&request_id=${encodeURIComponent(String((body as { request_id?: string } | undefined)?.request_id ?? ''))}` : ''}`, {
    method,
    ...(body === undefined || method === 'GET' ? {} : { headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) }),
    ...(method === 'GET' ? { headers: token === null ? {} : { authorization: `Bearer ${token}` } } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function waitForState(base: string, jobId: string, requestId: string, expected: string) {
  let last: Record<string, unknown> = {};
  await vi.waitFor(async () => {
    const current = await request(base, 'GET', { job_id: jobId, request_id: requestId });
    last = current.body;
    expect((current.body['readback'] as Record<string, unknown>)?.['state']).toBe(expected);
  }, { timeout: 10_000 });
  return last['readback'] as Record<string, unknown>;
}

function requestPayloadSha256(values: unknown): string {
  return createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex');
}

const receiptFiles = (repo: FixtureRepo): string[] => {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const directory = join(common, 'gru-creation');
  return existsSync(directory) ? readdirSync(directory).filter((entry) => entry.endsWith('.json')) : [];
};

describe('same-job retained initial-creation continuation', () => {
  it('routes an authenticated continuation request to its durable owner', async () => {
    const configDir = directory();
    writeFileSync(join(configDir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf8');
    const config = loadConfig({ GRU_COMMAND_HOME: configDir }, '/home/tester');
    const db = new LedgerDb(directory());
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const readback = { job_id: 'route-job', request_id: 'route-request', state: 'accepted' };
    const requestContinuation = vi.fn(async () => ({ created: true, readback }));
    const dispatch = { requestCreationContinuation: requestContinuation } as unknown as DispatchService;
    const api = createDispatchServer({ config, dispatch, wave: {} as WaveRunner, ledger, pendingProducerBlockers: () => [] });
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (!api.requestHook(req, res, path)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push({ server, api });
    const address = server.address() as AddressInfo;
    const response = await request(`http://127.0.0.1:${address.port}`, 'POST', { job_id: 'route-job', request_id: 'route-request' });
    expect(response.status).toBe(202);
    expect(response.body['readback']).toEqual(readback);
    expect(requestContinuation).toHaveBeenCalledWith({ jobId: 'route-job', requestId: 'route-request' });
    const extraField = await request(`http://127.0.0.1:${address.port}`, 'POST', { job_id: 'route-job', request_id: 'other-request', branch: 'gru/forged' });
    expect(extraField.status).toBe(400);
    expect(requestContinuation).toHaveBeenCalledTimes(1);
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

  it('refuses jobs with non-blocked, agent or live-admission custody state', async () => {
    for (const guard of ['not-blocked', 'amended-contract', 'existing-agent', 'existing-admission'] as const) {
      const h = await retainedFixture(`continuation-existing-${guard}`);
      let releaseAdmission: (() => void) | null = null;
      if (guard === 'not-blocked') h.ledger.setJobStatus(h.job.id, 'working');
      else if (guard === 'amended-contract') {
        const contract = h.ledger.effectiveContract(h.job.id)!;
        expect(h.ledger.addJobAmendment({ jobId: h.job.id, body: 'Synthetic contract amendment', approval: { by: 'fixture-owner', reference: 'synthetic fixture approval' }, expectedContractSha256: contract.contractSha256, effect: 'administrative' }).status).toBe('accepted');
      } else if (guard === 'existing-agent') h.ledger.registerAgent({ id: 'pre-existing-agent', role: 'minion', jobId: h.job.id });
      else releaseAdmission = h.ledger.beginJobAdmission(h.job.id, 'fixture pre-existing admission');
      const api = await httpHarness(h);
      const response = await request(api.base, 'POST', { job_id: api.jobId, request_id: `existing-${guard}` });
      expect(response.status).toBe(409);
      expect((response.body['readback'] as Record<string, unknown>)).toMatchObject({ state: 'refused', active: false });
      expect((response.body['readback'] as Record<string, unknown>)['reason']).toMatch(
        guard === 'not-blocked' ? /not blocked/u
          : guard === 'amended-contract' ? /amended contract/u
            : guard === 'existing-agent' ? /agent record/u : /live admission/u,
      );
      expect(api.ledger.getWorktree(api.jobId)).toBeNull();
      expect(api.spawns).toHaveLength(0);
      expect(api.prompts).toHaveLength(0);
      expect(git(api.repo, ['rev-parse', `refs/heads/gru/${api.jobId}`])).toBe(h.inspection.sha);
      expect(receiptFiles(api.repo)).toHaveLength(1);
      releaseAdmission?.();
    }
  });

  it('records actual worker-pacing queue state and admits only after the configured FIFO gate releases', async () => {
    const h = await retainedFixture('continuation-queued');
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 1 });
    const occupied = await gate.acquireWorkerTurn({ id: 'fixture-occupant', label: 'fixture occupant', jobId: 'other-job' });
    const api = await httpHarness(h, gate);
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
    const api = await httpHarness(h, undefined, floor);
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
    const api = await httpHarness(h, undefined, undefined, new Error('synthetic spawn failure'));
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
    const lane = await h.worktrees.createRetainedJobWorktree({ repoPath: h.repo.path, jobId: h.job.id });
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
    await expect(h.worktrees.createRetainedJobWorktree({ repoPath: h.repo.path, jobId })).rejects.toThrow(/receipt .* absent|receipt .* unreadable/u);
    expect(git(h.repo, ['branch', '--list', `gru/${jobId}`])).toBe('');
    expect(h.ledger.getWorktree(jobId)).toBeNull();

    const retained = await retainedFixture('continuation-no-ref');
    const branch = `refs/heads/gru/${retained.job.id}`;
    git(retained.repo, ['update-ref', '-d', branch]);
    const receiptBefore = receiptFiles(retained.repo);
    await expect(retained.worktrees.createRetainedJobWorktree({ repoPath: retained.repo.path, jobId: retained.job.id })).rejects.toThrow(/no branch ref|cannot clear the receipt|new base/u);
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
        git(h.repo, ['symbolic-ref', branch, 'refs/heads/main']);
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
            : guard === 'symbolic-ref' ? /symbolic ref|reflog/u
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
