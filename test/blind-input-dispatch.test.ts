import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { loadConfig } from '../src/config.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { DispatchService } from '../src/dispatch/service.js';
import type { LogLevel } from '../src/logger.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import type { ObservedToolResult } from '../src/dispatch/blind-input.js';
import { BLIND_ACCESS_EVENT } from '../src/dispatch/blind-review.js';
import type { Role } from '../src/config.js';
import type { AgentCapabilities, AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Issue #316 at the dispatch boundary: a blind review commission is
 * validated against the parent's EFFECTIVE isolation rule before any
 * reviewer is spawned; validity follows the actual package and observed
 * access, never report settlement. Deterministic fixtures, no paid reviewer.
 */

const TOKEN = 'blind-token';
const PR = 'https://git.example.invalid/o/r/pull/316';
const TARGET = 'f'.repeat(40);
const BASE = 'a'.repeat(40);

const CAPS: AgentCapabilities = {
  streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false,
};

const cleanupDirs: string[] = [];
const cleanupRepos: FixtureRepo[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
});

interface Harness {
  port: number;
  ledger: LedgerApi;
  prompts: string[];
  spawnCount: () => number;
  repo: FixtureRepo;
}

async function boot(opts: {
  sessionToolResults?: (file: string | null) => readonly ObservedToolResult[] | null;
  log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-blind-'));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  mkdirSync(join(dir, 'wtroot'));
  mkdirSync(join(dir, 'wtpreserve'));
  const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'), ledger);
  const prompts: string[] = [];
  let spawns = 0;
  const spawner = async (role: Role, _options?: SpawnOptions): Promise<AgentHandle> => {
    spawns += 1;
    const id = `agent-${spawns}`;
    return {
      role, id, sessionFile: null, capabilities: CAPS,
      async prompt(text: string) { if (role === 'minion') prompts.push(text); },
      async steer() {}, async followUp() {},
      subscribe() { return () => {}; },
      health() { return { state: 'idle' as const, lastActivity: null, sessionFile: null }; },
      async dispose() {},
    };
  };
  const dispatch = new DispatchService({
    ledger,
    worktrees,
    spawner,
    ...(opts.sessionToolResults !== undefined ? { sessionToolResults: opts.sessionToolResults } : {}),
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
  const wave = new WaveRunner({ ledger, worktrees, spawner, bus });
  const server = createDispatchServer({ pendingProducerBlockers: () => [], config: cfg, dispatch, wave, ledger });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  closers.push(async () => {
    await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
    await wave.shutdown();
    db.close();
  });
  const repo = makeFixtureRepo('fixture-blind');
  return { port: (http.address() as AddressInfo).port, ledger, prompts, spawnCount: () => spawns, repo };
}

async function call(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown> };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

const HISTORY_SPEC = [
  '# Accepted spec',
  '## Prior replacement-blind assessment',
  'R7 findings: something',
  '## Triage',
  'disposition: acted',
].join('\n');

const validPackage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  base_sha: BASE,
  target_sha: TARGET,
  files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }],
  ...overrides,
});

async function dispatchParent(h: Harness, body = 'Build the feature.'): Promise<void> {
  const parent = await call(h.port, 'POST', '/api/dispatch', { job_id: 'parent', repo_path: h.repo.path, title: 'feature', briefing: body });
  expect(parent.status).toBe(202);
  await waitFor(() => h.ledger.latestJobEvent('parent', 'job.delivered') !== null);
}

const blindReview = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  job_id: id,
  repo_path: '',
  title: 'review (blind)',
  briefing: 'Review the immutable package read-only.',
  deliverable: 'review',
  target_ref: PR,
  target_sha: TARGET,
  parent_job_id: 'parent',
  ...extra,
});

function amend(h: Harness, body: string): string {
  const contract = h.ledger.effectiveContract('parent')!;
  const result = h.ledger.addJobAmendment({
    jobId: 'parent',
    body,
    approval: { by: 'owner', reference: 'clarification' },
    expectedContractSha256: contract.contractSha256,
    effect: 'administrative',
  });
  expect(result.status).toBe('accepted');
  return h.ledger.effectiveContract('parent')!.contractSha256;
}

describe('blind review commissioning (issue #316)', () => {
  it('refuses a package carrying task specs, prior assessments and deferred docs BEFORE any reviewer spawns', async () => {
    const h = await boot();
    await dispatchParent(h);
    const spawnsBefore = h.spawnCount();
    const res = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-1', {
      repo_path: h.repo.path,
      input_package: validPackage({
        files: [
          { path: 'src/feature.ts', content: 'export const feature = 1;\n' },
          { path: '_bmad-output/implementation-artifacts/deferred-work.md', content: '- deferred' },
          { path: 'docs/accepted-spec.md', content: HISTORY_SPEC },
        ],
      }),
    }));
    expect(res.status).toBe(422);
    expect(res.json['error']).toBe('blind_input_refused');
    expect(String(res.json['correction'])).toMatch(/review_role "claims"/u);
    expect((res.json['violations'] as { code: string; where: string }[]).map((v) => `${v.code}:${v.where}`).sort()).toEqual([
      'excluded-path:_bmad-output/implementation-artifacts/deferred-work.md',
      'history-content:docs/accepted-spec.md',
    ]);
    // No job, no worktree, no reviewer turn; the refusal is audited without the private text.
    expect(h.ledger.getJob('rev-1')).toBeNull();
    expect(h.spawnCount()).toBe(spawnsBefore);
    const refused = h.ledger.latestJobEvent('rev-1', 'review.blind-input-refused');
    expect(refused?.payload).toMatchObject({ code: 'blind_input_refused', parent_job_id: 'parent' });
    expect(JSON.stringify(refused?.payload)).not.toContain('Prior replacement');
  });

  it('a renamed or embedded assessment is refused even with correct source hashes (comment 1)', async () => {
    const h = await boot();
    await dispatchParent(h);
    const source = 'export const feature = 1;\n';
    const res = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-renamed', {
      repo_path: h.repo.path,
      input_package: validPackage({
        files: [
          { path: 'src/feature.ts', content: source },
          { path: 'accepted-spec.md', content: `# Notes\n\nIntro.\n\n${HISTORY_SPEC}\n` },
        ],
      }),
    }));
    expect(res.status).toBe(422);
    expect((res.json['violations'] as { code: string }[]).map((v) => v.code)).toEqual(['history-content']);
    expect(h.ledger.getJob('rev-renamed')).toBeNull();
  });

  it('history embedded in the briefing itself is refused too', async () => {
    const h = await boot();
    await dispatchParent(h);
    const res = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-brief', {
      repo_path: h.repo.path,
      briefing: `Review it.\n\n${HISTORY_SPEC}`,
      input_package: validPackage(),
    }));
    expect(res.status).toBe(422);
    expect((res.json['violations'] as { where: string }[])[0]?.where).toBe('briefing');
  });

  it('admits a valid immutable package and preserves target and blob provenance', async () => {
    const h = await boot();
    await dispatchParent(h);
    const res = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-ok', {
      repo_path: h.repo.path,
      input_package: validPackage({
        diff: { text: ['diff --git a/src/feature.ts b/src/feature.ts', '--- a/src/feature.ts', '+++ b/src/feature.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n') },
        files: [
          { path: 'src/feature.ts', content: 'export const feature = 1;\n' },
          { path: '.gru-command/worktree.toml', content: '[worktree]\nbase = "main"\n' },
        ],
      }),
    }));
    expect(res.status).toBe(202);
    const admitted = h.ledger.latestJobEvent('rev-ok', 'review.blind-input-admitted')?.payload as { role: string; attested: boolean; package: { baseSha: string; targetSha: string; packageSha256: string; files: { path: string; blobSha: string }[] } };
    expect(admitted.role).toBe('blind');
    expect(admitted.attested).toBe(true);
    expect(admitted.package).toMatchObject({ baseSha: BASE, targetSha: TARGET });
    expect(admitted.package.files.map((f) => f.path)).toEqual(['.gru-command/worktree.toml', 'src/feature.ts']);
    expect(admitted.package.files.every((f) => /^[0-9a-f]{40}$/u.test(f.blobSha))).toBe(true);
    // The private bytes never ride the record.
    expect(JSON.stringify(admitted)).not.toContain('export const feature');
    const coverage = await call(h.port, 'GET', '/api/dispatch/jobs/rev-ok/blind-coverage');
    expect(coverage.json).toMatchObject({ state: 'qualifying', qualifying: true, targetSha: TARGET, packageSha256: admitted.package.packageSha256 });
  });

  it('refuses a package built for another target (a stale historical base is not this review)', async () => {
    const h = await boot();
    await dispatchParent(h);
    const res = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-stale-target', {
      repo_path: h.repo.path,
      input_package: validPackage({ target_sha: 'e'.repeat(40) }),
    }));
    expect(res.status).toBe(422);
    expect((res.json['violations'] as { code: string }[])[0]?.code).toBe('target-mismatch');
  });

  it('applies the parent EFFECTIVE rule at commissioning, including an administrative clarification', async () => {
    const h = await boot();
    await dispatchParent(h);
    const staleHash = h.ledger.effectiveContract('parent')!.contractSha256;
    const fresh = amend(h, 'Clarification: blind reviewers get source only.\nblind-isolation: exclude vendor/**\nblind-isolation: require-package');
    const pkg = validPackage({ files: [{ path: 'vendor/lib.ts', content: 'export {};\n' }] });
    // Composed against the pre-clarification contract: refused as stale with the way forward.
    const stale = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-a', {
      repo_path: h.repo.path, input_package: pkg, parent_contract_sha256: staleHash,
    }));
    expect(stale.status).toBe(409);
    expect(stale.json['error']).toBe('stale_parent_contract');
    expect(stale.json['current_contract_sha256']).toBe(fresh);
    // Even with the fresh hash, the clarified rule excludes vendor/**.
    const excluded = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-b', {
      repo_path: h.repo.path, input_package: pkg, parent_contract_sha256: fresh,
    }));
    expect(excluded.status).toBe(422);
    expect((excluded.json['violations'] as { where: string }[])[0]?.where).toBe('vendor/lib.ts');
    // The clarified rule requires a package at all.
    const none = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-c', { repo_path: h.repo.path, parent_contract_sha256: fresh }));
    expect(none.status).toBe(422);
    expect((none.json['violations'] as { code: string }[])[0]?.code).toBe('package-required');
    // A conforming package under the fresh hash is admitted and records the rule version it obeyed.
    const ok = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-d', {
      repo_path: h.repo.path, input_package: validPackage(), parent_contract_sha256: fresh,
    }));
    expect(ok.status).toBe(202);
    expect(h.ledger.latestJobEvent('rev-d', 'review.blind-input-admitted')?.payload).toMatchObject({
      parent_contract_sha256: fresh,
      parent_contract_version: 1,
      rule: { excludeGlobs: ['vendor/**'], requirePackage: true, directives: 2 },
    });
  });

  it('keeps historical bindings and the claims-needed contract separate', async () => {
    const h = await boot();
    await dispatchParent(h);
    // A legacy blind-named review with no package is still admitted (parent rule does not require one)…
    const legacy = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-legacy', { repo_path: h.repo.path }));
    expect(legacy.status).toBe(202);
    // …but it can never read as independent blind coverage.
    expect((await call(h.port, 'GET', '/api/dispatch/jobs/rev-legacy/blind-coverage')).json).toMatchObject({ state: 'unattested', qualifying: false });
    // An unnamed, unclassified reviewer is untouched.
    const plain = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-plain', { repo_path: h.repo.path, title: 'edge review' }));
    expect(plain.status).toBe(202);
    expect((await call(h.port, 'GET', '/api/dispatch/jobs/rev-plain/blind-coverage')).json).toMatchObject({ state: 'unclassified', qualifying: false });
    // A claims reviewer legitimately receives claims and is never refused or counted as blind.
    const claims = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-claims', {
      repo_path: h.repo.path, review_role: 'claims', title: 'claims review',
      briefing: `Review against the claims.\n\n${HISTORY_SPEC}`,
    }));
    expect(claims.status).toBe(202);
    expect((await call(h.port, 'GET', '/api/dispatch/jobs/rev-claims/blind-coverage')).json).toMatchObject({ state: 'not-blind', qualifying: false });
    // Fail loud on a bad role, and on blind fields for a non-review lane.
    const badRole = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-bad', { repo_path: h.repo.path, review_role: 'psychic' }));
    expect(badRole.status).toBe(400);
    const nonReview = await call(h.port, 'POST', '/api/dispatch', {
      job_id: 'impl-2', repo_path: h.repo.path, title: 'impl', briefing: 'b', input_package: validPackage(),
    });
    expect(nonReview.status).toBe(400);
    expect(h.ledger.getJob('impl-2')).toBeNull();
  });

  it('a later prohibited read invalidates coverage while the settled report and findings are preserved (comments 2 and 3)', async () => {
    const h = await boot();
    await dispatchParent(h);
    const created = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-settled', { repo_path: h.repo.path, input_package: validPackage() }));
    expect(created.status).toBe(202);
    await waitFor(() => h.ledger.latestJobEvent('rev-settled', 'job.delivered') !== null);
    // Lifecycle settlement: the commissioner acts on the report.
    await call(h.port, 'POST', '/api/dispatch', { job_id: 'fix-lane', repo_path: h.repo.path, title: 'fix', briefing: 'apply findings' });
    await waitFor(() => h.ledger.latestJobEvent('fix-lane', 'job.delivered') !== null);
    const settled = await call(h.port, 'POST', '/api/jobs/rev-settled/disposition', { outcome: 'acted', directive_job_id: 'fix-lane', by: 'parent' });
    expect(settled.status).toBe(200);
    expect(h.ledger.getJob('rev-settled')?.status).toBe('done');
    // Settled alone proves nothing else: with no prohibited access observed it still qualifies…
    expect((await call(h.port, 'GET', '/api/dispatch/jobs/rev-settled/blind-coverage')).json['qualifying']).toBe(true);
    // …and a later direct spec-page read (grep + offset read of a history-bearing contract) removes that.
    const observed = await call(h.port, 'POST', '/api/dispatch/blind-access', {
      job_id: 'rev-settled',
      tool_results: [
        { tool_name: 'bash', text: 'accepted-spec.md:12:## Prior replacement-blind assessment\naccepted-spec.md:14:R7 findings: foo' },
        { tool_name: 'read', text: `20→${HISTORY_SPEC.split('\n').join('\n21→')}` },
      ],
    });
    expect(observed.status).toBe(200);
    expect(observed.json).toMatchObject({ state: 'invalidated', qualifying: false, prohibitedAccess: 2, reportPreserved: true });
    // Settlement is untouched: report, status, obligation and disposition stay exactly as recorded.
    expect(h.ledger.getJob('rev-settled')?.status).toBe('done');
    expect(h.ledger.latestJobEvent('rev-settled', 'job.report-disposition')?.payload).toMatchObject({ outcome: 'acted' });
    expect(h.ledger.latestJobEvent('rev-settled', 'job.delivered')).not.toBeNull();
    const record = h.ledger.latestJobEvent('rev-settled', 'review.blind-access-observed')?.payload;
    expect(JSON.stringify(record)).not.toContain('R7 findings: foo');
  });

  it('keeps a prohibited read invalidating coverage however many later clean posts age past the old 500 window (review fix)', async () => {
    const h = await boot();
    await dispatchParent(h);
    const created = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-aging', { repo_path: h.repo.path, input_package: validPackage() }));
    expect(created.status).toBe(202);
    const prohibited = await call(h.port, 'POST', '/api/dispatch/blind-access', {
      job_id: 'rev-aging',
      tool_results: [{ tool_name: 'bash', text: 'docs/issues/305-review.md:1:prior assessment' }],
    });
    expect(prohibited.json).toMatchObject({ state: 'invalidated', qualifying: false, prohibitedAccess: 1 });
    // Past the ledger's newest-500 read window: the observation must not age out.
    for (let index = 0; index < 501; index += 1) {
      h.ledger.appendCustomEvent({ kind: BLIND_ACCESS_EVENT, jobId: 'rev-aging', payload: { source: 'operator', scanned: 1, rule_sha256: null, prohibited: [] } });
    }
    expect((await call(h.port, 'GET', '/api/dispatch/jobs/rev-aging/blind-coverage')).json).toMatchObject({
      state: 'invalidated', qualifying: false, prohibitedAccess: 1, accessObserved: true,
    });
  });

  it('observes the finished reviewer session automatically at turn settle', async () => {
    const h = await boot({
      sessionToolResults: () => [
        { index: 0, toolName: 'bash', text: 'src/feature.ts:1:export const feature = 1;' },
        { index: 1, toolName: 'bash', text: '_bmad-output/implementation-artifacts/deferred-work.md:3:- old finding' },
      ],
    });
    await dispatchParent(h);
    const created = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-seen', { repo_path: h.repo.path, input_package: validPackage() }));
    expect(created.status).toBe(202);
    await waitFor(() => h.ledger.latestJobEvent('rev-seen', 'review.blind-access-observed') !== null);
    expect((await call(h.port, 'GET', '/api/dispatch/jobs/rev-seen/blind-coverage')).json).toMatchObject({
      state: 'invalidated', qualifying: false, accessObserved: true,
    });
  });

  it('a throwing session reader is logged and swallowed — never failing the settled turn (issue #339 P5)', async () => {
    const logs: string[] = [];
    const h = await boot({
      sessionToolResults: () => { throw new Error('session unreadable'); },
      log: (_level, msg) => { logs.push(msg); },
    });
    await dispatchParent(h);
    const created = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-reader-fault', { repo_path: h.repo.path, input_package: validPackage() }));
    expect(created.status).toBe(202);
    await waitFor(() => h.ledger.latestJobEvent('rev-reader-fault', 'job.delivered') !== null);
    // The bookkeeping fault is logged and swallowed; the delivery stands and
    // no observation was fabricated from a failed read.
    expect(logs).toContain('blind review access observation failed');
    expect(h.ledger.latestJobEvent('rev-reader-fault', BLIND_ACCESS_EVENT)).toBeNull();
  });

  it('reuses already-owned qualifying coverage instead of spawning a replacement, and replaces only invalidated coverage', async () => {
    const h = await boot();
    await dispatchParent(h);
    const first = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-first', { repo_path: h.repo.path, input_package: validPackage() }));
    expect(first.status).toBe(202);
    const spawnsBefore = h.spawnCount();
    const dup = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-dup', { repo_path: h.repo.path, input_package: validPackage() }));
    expect(dup.status).toBe(409);
    expect(dup.json).toMatchObject({ error: 'blind_coverage_owned', coverage_job_id: 'rev-first' });
    expect(h.ledger.getJob('rev-dup')).toBeNull();
    expect(h.spawnCount()).toBe(spawnsBefore);
    // A new target is new coverage.
    const other = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-other', {
      repo_path: h.repo.path, target_sha: 'd'.repeat(40), input_package: validPackage({ target_sha: 'd'.repeat(40) }),
    }));
    expect(other.status).toBe(202);
    // Once observed access disqualifies the first, a clean replacement is admitted and names what it replaces.
    await call(h.port, 'POST', '/api/dispatch/blind-access', {
      job_id: 'rev-first', tool_results: [{ tool_name: 'bash', text: 'docs/issues/305-review.md:1:x' }],
    });
    const replacement = await call(h.port, 'POST', '/api/dispatch', blindReview('rev-replacement', { repo_path: h.repo.path, input_package: validPackage() }));
    expect(replacement.status).toBe(202);
    expect(h.ledger.latestJobEvent('rev-replacement', 'review.blind-input-admitted')?.payload).toMatchObject({ replaces: ['rev-first'] });
  });

  it('refuses blind access recording for a job that was never admitted as blind', async () => {
    const h = await boot();
    await dispatchParent(h);
    const res = await call(h.port, 'POST', '/api/dispatch/blind-access', { job_id: 'parent', tool_results: [{ text: 'x' }] });
    expect(res.status).toBe(400);
    expect((await call(h.port, 'GET', '/api/dispatch/jobs/nope/blind-coverage')).status).toBe(404);
  });
});
