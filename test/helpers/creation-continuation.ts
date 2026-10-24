import { expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../src/events/bus.js';
import { LedgerApi } from '../../src/ledger/api.js';
import { LedgerDb } from '../../src/ledger/db.js';
import { loadConfig } from '../../src/config.js';
import { DispatchService, type DispatchServiceOptions } from '../../src/dispatch/service.js';
import { createDispatchServer } from '../../src/dispatch/server.js';
import type { WaveRunner } from '../../src/dispatch/perkins.js';
import type { AgentHandle } from '../../src/runtime/types.js';
import type { LogLevel } from '../../src/logger.js';
import { repositoryGitEnv } from '../../src/dispatch/perkins-review/artifacts.js';
import { WorktreeManager, type WorktreeManagerOptions } from '../../src/worktrees/manager.js';
import { writeCreationIntent } from '../../src/worktrees/creation-intent.js';
import { makeFixtureRepo, type FixtureRepo } from './fixture-repo.js';

/** Shared fixtures for the same-job retained-creation continuation suites:
 * synthetic Git wrappers, retained receipts, and a real HTTP dispatch route. */

export const TOKEN = 'synthetic-continuation-test-token';
const repos: FixtureRepo[] = [];
const dirs: string[] = [];
const dbs: LedgerDb[] = [];
const servers: { readonly server: HttpServer; readonly api: ReturnType<typeof createDispatchServer> }[] = [];

/** afterEach: close servers, ledgers, temp directories and fixture repos. */
export async function cleanupContinuationFixtures(): Promise<void> {
  vi.unstubAllEnvs();
  while (servers.length > 0) {
    const current = servers.pop()!;
    current.api.dispose();
    await new Promise<void>((resolve, reject) => current.server.close((error) => error ? reject(error) : resolve()));
  }
  while (dbs.length > 0) dbs.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  while (repos.length > 0) repos.pop()!.cleanup();
}

export function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'gru-creation-continuation-'));
  dirs.push(path);
  return path;
}

export function trackedDb(): LedgerDb {
  const db = new LedgerDb(directory());
  dbs.push(db);
  return db;
}

export function git(repo: FixtureRepo, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', repo.path, ...args], {
    encoding: 'utf8', env: { ...repositoryGitEnv(false), GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function managerFixture(name: string, options: Partial<WorktreeManagerOptions> = {}) {
  const repo = makeFixtureRepo(name);
  repos.push(repo);
  const root = directory();
  const preserveRoot = directory();
  const bus = new EventBus();
  const db = trackedDb();
  const ledger = new LedgerApi(db.handle, { bus });
  const worktrees = new WorktreeManager({ ledger, root, preserveRoot, setupTimeoutMs: 30_000, enumerateProcesses: () => [], ...options });
  return { repo, root, bus, db, ledger, worktrees };
}

/** Put a synthetic `git` first on PATH; returns the PATH to restore. */
export function gitWrapper(lines: readonly string[]): string {
  const root = directory();
  const originalPath = process.env.PATH ?? '';
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const script = join(root, 'git');
  writeFileSync(script, [
    '#!/usr/bin/env node',
    'const cp = require("node:child_process"), fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    `const real = ${JSON.stringify(realGit)};`,
    `const root = ${JSON.stringify(root)};`,
    `if (args[0] !== 'update-ref' || !args.includes('--stdin')) { const r = cp.spawnSync(real, args, {stdio:'inherit'}); process.exit(r.status ?? 1); }`,
    'const child = cp.spawn(real, args, {stdio:["pipe","pipe","pipe"]});',
    'child.stdin.on("error", () => {}); process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);',
    ...lines,
  ].join('\n') + '\n');
  chmodSync(script, 0o755);
  vi.stubEnv('PATH', `${root}:${originalPath}`);
  return originalPath;
}

/** A synthetic Git wrapper commits its first update-ref, then remains alive
 * past the close budget. WorktreeManager sends signals only to this owned
 * fixture child and records its later Node close event as producer cessation. */
export function committedStall(): string {
  return gitWrapper([
    'const once = require("node:path").join(root, "stalled");',
    'const stall = !fs.existsSync(once); if (stall) fs.writeFileSync(once, "1");',
    'process.on("SIGTERM", () => {});',
    'child.on("close", code => { if (!stall) { process.exit(code ?? 1); } setInterval(() => {}, 1000); });',
  ]);
}

/** The wrapper commits and exits, but a detached descendant keeps the
 * service's pipes open until `releaseFile` exists; its pid is written to
 * `pidFile`. */
export function committedExitWithoutClose(pidFile: string, releaseFile: string): string {
  const hold = `while [ ! -e ${JSON.stringify(releaseFile)} ]; do sleep 0.05; done`;
  return gitWrapper([
    `child.on("close", code => { const holder = cp.spawn("/bin/sh", ["-c", ${JSON.stringify(hold)}], {stdio:["ignore","inherit","inherit"], detached:true}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(holder.pid)); holder.unref(); process.exit(code ?? 1); });`,
  ]);
}

export function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch { return true; }
}

export async function retainedFixture(jobId: string, options: { readonly prepare?: (repo: FixtureRepo) => void; readonly manager?: Partial<WorktreeManagerOptions> } = {}) {
  const h = managerFixture(`retained-${jobId}`, options.manager);
  options.prepare?.(h.repo);
  const job = h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: `Title ${jobId}`, baseBranch: 'main', briefing: `Original briefing ${jobId}` });
  h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: job.repo, repoPath: h.repo.path } });
  h.ledger.setJobStatus(jobId, 'working');
  const originalPath = committedStall();
  await expect(h.worktrees.createJobWorktree({ repoPath: h.repo.path, jobId })).rejects.toThrow(/did not close within 1000ms/u);
  vi.stubEnv('PATH', originalPath);
  h.ledger.setJobStatus(jobId, 'blocked');
  expect(h.ledger.getWorktree(jobId)).toBeNull();
  const inspection = await h.worktrees.inspectRetainedJobCreation({ repoPath: h.repo.path, jobId });
  expect(inspection.sha).toBe(git(h.repo, ['rev-parse', `refs/heads/gru/${jobId}`]));
  return { ...h, job: h.ledger.getJob(jobId)!, inspection };
}

export type RetainedFixture = Awaited<ReturnType<typeof retainedFixture>>;

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** A blocked job's retained state without a stalled child: its receipt, the
 * committed ref with the receipt's reflog entry, and (unless `settle` is
 * false) the producer settlement the manager journals on close. */
export function syntheticRetained(h: ReturnType<typeof managerFixture>, jobId: string, options: {
  readonly settle?: boolean; readonly deliverable?: 'artifact'; readonly handoffRepoPath?: string;
} = {}) {
  const job = h.ledger.addJob({ id: jobId, repo: basename(h.repo.path), title: `Title ${jobId}`, baseBranch: 'main', briefing: `Original briefing ${jobId}`,
    ...(options.deliverable === undefined ? {} : { deliverable: options.deliverable }) });
  h.ledger.appendCustomEvent({ kind: 'job.handoff', jobId, payload: { repo: job.repo, repoPath: options.handoffRepoPath ?? h.repo.path } });
  h.ledger.setJobStatus(jobId, 'working');
  h.ledger.setJobStatus(jobId, 'blocked');
  const branch = `gru/${jobId}`;
  const sha = git(h.repo, ['rev-parse', 'HEAD']);
  const token = `gru-creation:${randomUUID()}`;
  writeCreationIntent(git(h.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']), {
    lane: { id: jobId, kind: 'job', jobId, roundId: null, path: join(h.root, basename(h.repo.path), `job-${jobId}`) },
    repoPath: realpathSync(h.repo.path), branch, sha, baseSource: 'local-head-fallback', token,
  });
  git(h.repo, ['update-ref', '-m', token, `refs/heads/${branch}`, sha]);
  if (options.settle !== false) {
    h.ledger.recordCreationProducerSettlement({ jobId, branch, sha, tokenSha256: sha256(token), pid: 4242, exitCode: 0, signal: null });
  }
  return { job: h.ledger.getJob(jobId)!, token, branch, sha };
}

export function fakeHandle(id: string, prompts: string[], options: {
  readonly prompt?: (text: string) => Promise<void>; readonly disposed?: string[]; readonly health?: AgentHandle['health'];
} = {}): AgentHandle {
  const capabilities = {
    streaming: true, steer: 'native' as const, resume: 'file' as const,
    images: false, thinking: false, thinkingLevelControl: false, followUp: false,
  };
  return {
    role: 'minion', id, sessionFile: null, capabilities,
    async prompt(text) { prompts.push(text); await options.prompt?.(text); },
    async steer() {}, async followUp() {}, subscribe() { return () => {}; },
    health: options.health ?? (() => ({ state: 'idle', lastActivity: null, sessionFile: null })),
    async dispose() { options.disposed?.push(id); },
  };
}

export interface HarnessOptions {
  readonly spawnFailure?: Error;
  /** Runs after each prompt is recorded: hold it, or reject the turn. */
  readonly prompt?: (text: string) => Promise<void>;
  readonly health?: AgentHandle['health'];
  readonly service?: Partial<Omit<DispatchServiceOptions, 'ledger' | 'worktrees' | 'spawner'>>;
  readonly serverLog?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
}

type HarnessSource = Pick<RetainedFixture, 'ledger' | 'worktrees' | 'repo' | 'job'> & { readonly inspection?: RetainedFixture['inspection'] };

export async function httpHarness(h: HarnessSource, options: HarnessOptions = {}) {
  const configDir = directory();
  writeFileSync(join(configDir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf8');
  const config = loadConfig({ GRU_COMMAND_HOME: configDir }, '/home/tester');
  const prompts: string[] = [];
  const spawns: string[] = [];
  const disposed: string[] = [];
  const dispatch = new DispatchService({
    ledger: h.ledger,
    worktrees: h.worktrees,
    ...options.service,
    spawner: async () => {
      if (options.spawnFailure !== undefined) throw options.spawnFailure;
      const id = `fixture-minion-${spawns.length + 1}`;
      spawns.push(id);
      return fakeHandle(id, prompts, {
        disposed, ...(options.prompt === undefined ? {} : { prompt: options.prompt }), ...(options.health === undefined ? {} : { health: options.health }),
      });
    },
  });
  const api = createDispatchServer({ config, dispatch, wave: {} as WaveRunner, ledger: h.ledger, pendingProducerBlockers: () => [],
    ...(options.serverLog === undefined ? {} : { log: options.serverLog }) });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (!api.requestHook(req, res, path)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ server, api });
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, dispatch, ledger: h.ledger, worktrees: h.worktrees, prompts, spawns, disposed, repo: h.repo, jobId: h.job.id, inspection: h.inspection ?? null };
}

/** A route-only server over a stand-in dispatch service. */
export async function routeHarness(dispatch: DispatchService) {
  const configDir = directory();
  writeFileSync(join(configDir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf8');
  const config = loadConfig({ GRU_COMMAND_HOME: configDir }, '/home/tester');
  const ledger = new LedgerApi(trackedDb().handle, { bus: new EventBus() });
  const api = createDispatchServer({ config, dispatch, wave: {} as WaveRunner, ledger, pendingProducerBlockers: () => [] });
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (!api.requestHook(req, res, path)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push({ server, api });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function request(base: string, method: 'GET' | 'POST', body?: unknown, token: string | null = TOKEN) {
  const response = await fetch(`${base}/api/dispatch/creation-continuation${method === 'GET' ? `?job_id=${encodeURIComponent(String((body as { job_id?: string } | undefined)?.job_id ?? ''))}&request_id=${encodeURIComponent(String((body as { request_id?: string } | undefined)?.request_id ?? ''))}` : ''}`, {
    method,
    ...(body === undefined || method === 'GET' ? {} : { headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) }),
    ...(method === 'GET' ? { headers: token === null ? {} : { authorization: `Bearer ${token}` } } : {}),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

export async function waitForState(base: string, jobId: string, requestId: string, expected: string) {
  let last: Record<string, unknown> = {};
  await vi.waitFor(async () => {
    const current = await request(base, 'GET', { job_id: jobId, request_id: requestId });
    last = current.body;
    expect((current.body['readback'] as Record<string, unknown>)?.['state']).toBe(expected);
  }, { timeout: 10_000 });
  return last['readback'] as Record<string, unknown>;
}

/** Wait for the in-process owner to finish, then return its readback. */
export async function waitInactive(dispatch: DispatchService, jobId: string, requestId: string) {
  await vi.waitFor(() => { expect(dispatch.getCreationContinuationReadback(jobId, requestId)?.active).toBe(false); }, { timeout: 20_000, interval: 50 });
  return dispatch.getCreationContinuationReadback(jobId, requestId)!;
}

export function requestPayloadSha256(values: unknown): string {
  return createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex');
}

/** Accept a request straight through the ledger with the fixture's exact
 * retained identity (a request whose owner is not this process). */
export function acceptDirectly(h: RetainedFixture, requestId: string) {
  const handoff = h.ledger.listJobEventsByKinds(h.job.id, ['job.handoff'], { limit: 2 })[0]!;
  const briefingSha256 = createHash('sha256').update(h.job.briefing!, 'utf8').digest('hex');
  return h.ledger.acceptCreationContinuation({
    jobId: h.job.id, requestId, payloadSha256: requestPayloadSha256({ requestId }),
    handoffSeq: handoff.seq, briefingSha256, handoffRepoPath: h.repo.path, repoPath: h.inspection.repoPath,
    branch: h.inspection.branch, baseSha: h.inspection.sha, baseSource: h.inspection.baseSource,
    producerSettlementSeq: h.inspection.producerSettlementSeq, receiptTokenSha256: h.inspection.receiptTokenSha256,
  });
}

export const receiptFiles = (repo: FixtureRepo): string[] => {
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const receipts = join(common, 'gru-creation');
  return existsSync(receipts) ? readdirSync(receipts).filter((entry) => entry.endsWith('.json')) : [];
};

export const hasRawCreationToken = (text: string): boolean => /gru-creation:[0-9a-f]{8}-/u.test(text);
