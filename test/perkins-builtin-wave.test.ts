import { PacingGate, type RetrySettlement } from '../src/runtime/pacing.js';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutoVerdictPoster,
  GhPrPoster,
  publicationProviderKindFor,
  GitLabMrPoster,
  WaveRunner,
  hostDisclosureAppendix,
  redactReviewForPublication,
  settledExecutionFactsLine,
  type EscalationContext,
  type FallbackGateOutcome,
  type VerdictPoster,
  type WaveOutcome,
} from '../src/dispatch/perkins.js';
import { PerkinsAppPrPoster, type AppFetch, type AppFetchInit } from '../src/dispatch/perkins-github-app.js';
import { preflightFailure, runRuntimeReviewPreflight, type FallbackFinding } from '../src/dispatch/review-path.js';
import { configPathFor, loadConfig } from '../src/config.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import { SessionStore } from '../src/sessions/store.js';
import type { PrHeadProbe } from '../src/dispatch/perkins-review/fresh-head.js';
import { BoardEngine } from '../src/board/engine.js';
import { createReviewEscalationNotifier } from '../src/dispatch/escalation-identity.js';
import { NotificationCenter } from '../src/notifications/center.js';
import {
  isValidSnapshot,
  type BoardSnapshot as WireBoardSnapshot,
} from '../web/src/lib/board-protocol.js';
import { terminalBoundNotificationIds } from '../web/src/lib/board-signals.js';

/** These suites exercise the Perkins route (no pre-flight configured), so
 * every runRound result must be a wave outcome; the helper pins that. */
function asWave(outcome: WaveOutcome | FallbackGateOutcome): WaveOutcome {
  if (!('route' in outcome)) return outcome;
  throw new Error(`expected a Perkins wave outcome, got ${outcome.route}`);
}

/** Branch-idle guard (2026-09-23): a review arm is refused while the target
 * lane is busy — a dispatched/working job with no settled delivery for its
 * current attempt. These suites review already-delivered lanes, so record
 * the delivery each fixture implies and let the guard see an idle lane. */
function settleLane(ledger: LedgerApi, jobId: string): void {
  ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: 'fixture-settled' } });
}

/** A syntactically complete `verification.completed` payload carrying every
 * receipt binding `renderRecordedVerification` requires. */
function completedRunPayload(
  sha: string,
  runId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sha,
    scope: 'full',
    command: 'npm test',
    ok: true,
    exit_code: 0,
    duration_ms: 1000,
    workers: 2,
    run_id: runId,
    output_bytes: 4096,
    output_sha256: createHash('sha256').update(runId).digest('hex'),
    ...overrides,
  };
}

/** Complete persisted `verification.completed` rows for the named jobs — the
 * read-only before/after proof that host selection neither adds, deletes,
 * reorders nor rewrites historical verification records (j-1594 acceptance 4).
 * Read through a kind-scoped list (never the iterator under test) with a
 * limit above any fixture history, so truncation cannot fake equality. */
function persistedVerificationRows(ledger: LedgerApi, jobIds: readonly string[]): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  for (const jobId of jobIds) {
    rows[jobId] = ledger.listJobEventsByKinds(jobId, ['verification.completed'], { limit: 1000 });
  }
  return rows;
}

/** A delivered job lane whose target is a fresh commit on its own branch —
 * the fixture shape the recorded-verification wave pins use. The caller
 * appends the synthetic verification history through the returned ledger. */
async function verificationHistoryLane(id: string, prefix: string, prNumber: number): Promise<{
  readonly ledger: LedgerApi;
  readonly job: ReturnType<LedgerApi['addJob']>;
  readonly target: string;
  readonly branch: string;
  readonly artifacts: string;
  readonly sessions: string;
  readonly port: GitReviewPort;
}> {
  const repo = makeFixtureRepo(`${prefix}-repo`);
  repos.push(repo);
  const branch = `feature/${prefix}`;
  repo.git(['checkout', '-b', branch]);
  const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
  const root = mkdtempSync(join(tmpdir(), `${prefix}-port-`));
  const artifacts = mkdtempSync(join(tmpdir(), `${prefix}-artifacts-`));
  const sessions = mkdtempSync(join(tmpdir(), `${prefix}-sessions-`));
  dirs.push(root, artifacts, sessions);
  const db = new LedgerDb(mkdtempSync(join(tmpdir(), `${prefix}-db-`)));
  dbs.push(db);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  const port = new GitReviewPort(root, branch, target);
  await port.createJobWorktree({ repoPath: repo.path, jobId: id });
  const job = ledger.addJob({ id, repo: 'fixture', title: prefix, baseBranch: 'main', briefing: 'review' });
  ledger.setJobStatus(job.id, 'working');
  settleLane(ledger, job.id);
  ledger.setJobPr(job.id, `https://git.example.invalid/acme/fixture/pull/${prNumber}`);
  attachOrigin(repo, branch, root);
  return { ledger, job, target, branch, artifacts, sessions, port };
}

function waveFor(lane: Awaited<ReturnType<typeof verificationHistoryLane>>): WaveRunner {
  const underlying = makeSpawner(lane.sessions, []);
  return new WaveRunner({
    ledger: lane.ledger,
    worktrees: lane.port,
    spawner: (role, options) => underlying(role, options),
    reviewArtifactRoot: lane.artifacts,
    prHeadProbe: localHeadProbe(lane.branch),
  });
}


import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from '../src/dispatch/worktree-port.js';
import type { WorktreeBaseSource } from '../src/ledger/api.js';
import type { AgentSpawner } from '../src/dispatch/service.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { PERKINS_LENSES } from '../src/dispatch/perkins-review/policy.js';
import { laneIsBusy } from '../src/dispatch/branch-idle.js';
import { OWNED_GIT_SEAMS } from '../src/dispatch/perkins-review/artifacts.js';
import { LedgerDb } from '../src/ledger/db.js';
import { FALLBACK_REVIEW_TIMEOUT_MS, lensAgentLabel } from '../src/dispatch/perkins.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeWholeSpawner, groundedFinding, type WholeLeadOptions } from './helpers/perkins-whole-double.js';
import { minimalPng } from './helpers/images.js';
import { renderRecordedVerification } from '../src/verify/evidence.js';
import { GitReviewPort } from './helpers/git-review-port.js';
import { PersistedReviewPort } from './helpers/persisted-review-port.js';

class DeferredReviewPort implements WorktreePort {
  constructor(
    private readonly delegate: GitReviewPort,
    private readonly created: () => void,
    private readonly releaseCreate: Promise<void>,
  ) {}

  createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> {
    return this.delegate.createJobWorktree(input);
  }

  async resolveReviewTarget(input: { repoPath: string; ref: string }): Promise<{
    readonly sha: string;
    readonly baseSource: WorktreeBaseSource | null;
  }> {
    return this.delegate.resolveReviewTarget(input);
  }

  async createReviewWorktree(input: { repoPath: string; roundId: string; ref: string; jobId?: string }): Promise<WorktreeLane> {
    const lane = await this.delegate.createReviewWorktree(input);
    this.created();
    await this.releaseCreate;
    return lane;
  }

  createChildWorktree(input: {
    repoPath: string;
    jobId: string;
    childId: string;
    parentPath: string;
    authority: 'read-only' | 'writer';
  }): Promise<WorktreeLane> {
    return this.delegate.createChildWorktree(input);
  }

  getWorktree(id: string): WorktreeLane | null { return this.delegate.getWorktree(id); }
  listWorktrees(options: { jobId?: string } = {}): readonly WorktreeLane[] { return this.delegate.listWorktrees(options); }
  release(input: { worktreeId: string }): Promise<WorktreeSweepResult> { return this.delegate.release(input); }
}

/** A review port whose sweep is slow (R7-15): a retry must not fire into the
 * setup it is unwinding. */
class SlowReleasePort implements WorktreePort {
  constructor(private readonly delegate: WorktreePort, private readonly releaseMs: number) {}
  createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> { return this.delegate.createJobWorktree(input); }
  resolveReviewTarget(input: { repoPath: string; ref: string }): Promise<{ readonly sha: string; readonly baseSource: WorktreeBaseSource | null }> {
    return this.delegate.resolveReviewTarget(input);
  }
  createReviewWorktree(input: { repoPath: string; roundId: string; ref: string; jobId?: string }): Promise<WorktreeLane> {
    return this.delegate.createReviewWorktree(input);
  }
  createChildWorktree(input: { repoPath: string; jobId: string; childId: string; parentPath: string; authority: 'read-only' | 'writer' }): Promise<WorktreeLane> {
    return this.delegate.createChildWorktree(input);
  }
  getWorktree(id: string): WorktreeLane | null { return this.delegate.getWorktree(id); }
  listWorktrees(options: { jobId?: string } = {}): readonly WorktreeLane[] { return this.delegate.listWorktrees(options); }
  async release(input: { worktreeId: string }): Promise<WorktreeSweepResult> {
    await new Promise((resolve) => setTimeout(resolve, this.releaseMs));
    return this.delegate.release(input);
  }
}

/** A review port whose release can be held (R9-8): while `hold` is set, a
 * sweep records that it entered and waits for `open()`. */
class GatedReleasePort implements WorktreePort {
  hold = false;
  entered = 0;
  private gate: (() => void) | null = null;
  constructor(private readonly delegate: WorktreePort) {}
  createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> { return this.delegate.createJobWorktree(input); }
  resolveReviewTarget(input: { repoPath: string; ref: string }): Promise<{ readonly sha: string; readonly baseSource: WorktreeBaseSource | null }> {
    return this.delegate.resolveReviewTarget(input);
  }
  createReviewWorktree(input: { repoPath: string; roundId: string; ref: string; jobId?: string }): Promise<WorktreeLane> {
    return this.delegate.createReviewWorktree(input);
  }
  createChildWorktree(input: { repoPath: string; jobId: string; childId: string; parentPath: string; authority: 'read-only' | 'writer' }): Promise<WorktreeLane> {
    return this.delegate.createChildWorktree(input);
  }
  getWorktree(id: string): WorktreeLane | null { return this.delegate.getWorktree(id); }
  listWorktrees(options: { jobId?: string } = {}): readonly WorktreeLane[] { return this.delegate.listWorktrees(options); }
  async release(input: { worktreeId: string }): Promise<WorktreeSweepResult> {
    if (this.hold) {
      this.entered += 1;
      await new Promise<void>((resolve) => {
        this.gate = resolve;
      });
    }
    return this.delegate.release(input);
  }
  open(): void {
    this.hold = false;
    this.gate?.();
    this.gate = null;
  }
}

/** Attach a fetchable bare origin inside the test's port root and push the
 * reviewed branch: the fresh-head freeze reads THIS tip, never the local
 * ref left behind by the fixture. `opts.batched` (T4 only) replaces
 * `init --bare` + `push` with ONE `clone --bare` of the repo at the same
 * commit: the bare carries refs/heads/<branch> at the identical sha (plus
 * inert extra state nothing in the flow reads — the bare's HEAD, its own
 * config, and a stale refs/heads/main copy; the head probe reads the LOCAL
 * ref, review worktrees are created from the job repo, and the reconcile
 * git-ops are local), and the job repo's `origin` remote is added exactly
 * as before. Callers that omit the flag keep the historical three-process
 * shape byte-for-byte (phase pr144-t4-second-cost-diagnosis-20261002). */
function attachOrigin(repo: FixtureRepo, branch: string, root: string, opts?: { readonly batched?: boolean }): string {
  const origin = join(root, 'origin.git');
  if (opts?.batched === true) {
    execFileSync('git', ['clone', '--bare', '--quiet', repo.path, origin], { stdio: 'ignore' });
    repo.git(['remote', 'add', 'origin', origin]);
    // Actual equivalence pin (phase pr144-followup14-feedback): the batched
    // bare must carry refs/heads/<branch> at the intended fixture target —
    // the same tip the historical init+push shape produces. The extra inert
    // state a clone carries (source HEAD, bare config, stale refs/heads/main)
    // is never read by the flow and is deliberately not asserted.
    const intended = repo.git(['rev-parse', `refs/heads/${branch}`]);
    const batched = repo.git(['rev-parse', `refs/heads/${branch}`], origin);
    if (batched.toLowerCase() !== intended.toLowerCase()) {
      throw new Error(
        `batched origin refs/heads/${branch} (${batched}) does not match the fixture target (${intended})`,
      );
    }
  } else {
    execFileSync('git', ['init', '--bare', '--quiet', origin], { stdio: 'ignore' });
    repo.git(['remote', 'add', 'origin', origin]);
    repo.git(['push', '--quiet', 'origin', `refs/heads/${branch}`]);
  }
  return origin;
}

/** Loose-ref fast path (phase pr144-completion-cycle-20261002): the git
 * command that just ran wrote `.git/refs/heads/<branch>` as a loose ref,
 * so reading it is value-identical to `git rev-parse refs/heads/<branch>`
 * and saves one git spawn per call in the load-amplified T4 window. Any
 * read failure (worktree gitdir files, packed refs, missing file) falls
 * back to the real rev-parse, so non-loose layouts keep exact behavior.
 * Dispatch only — the resolved value is never altered. */
function looseRefOrRevParse(repoPath: string, ref: string): string {
  try {
    return readFileSync(join(repoPath, '.git', ref), 'utf-8').trim();
  } catch {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', ref], { encoding: 'utf-8' }).trim();
  }
}

/** Probe double for PR rounds: report the reviewed branch's local tip (the
 * same commit pushed to origin before the freeze). */
function localHeadProbe(branch: string): PrHeadProbe {
  return async ({ repoPath }) => ({
    headRefName: branch,
    headSha: looseRefOrRevParse(repoPath, `refs/heads/${branch}`),
  });
}

/** The round id is the artifact directory's basename (the durable
 * naming rule for review round directories). */
function roundIdOf(directory: string): string {
  return directory.split('/').filter(Boolean).at(-1)!;
}

function sourceFor(prompt: string): string {
  if (prompt.includes('source=blind')) return 'blind';
  return /"source": "(blind|edge|acceptance|security|architecture|codebase|tests|performance|operations)"/.exec(prompt)?.[1] ?? 'unknown';
}

/**
 * Whole-PR wave spawner: one scripted lead driving the REAL native tools,
 * plus specialists answering by lens. Security malforms once, then reports
 * the canonical verified blocker — mirroring the pre-hybrid contract.
 */
function makeSpawner(
  root: string,
  order: string[],
  onLeadStart?: () => void,
  answerOverride?: (prompt: string) => string | undefined,
  /** Canonical security-blocker evidence the scripted lead cites on its
   * second attempt. Defaults to the historical `return 43;` snippet the
   * pre-existing fixtures commit; T4's fixture commits `return 44;`, so it
   * passes the snippet its frozen diff actually contains — the locatable-
   * evidence contract (whole.ts evidenceAtCitedLocation) then accepts the
   * canonical attempt instead of burning it. The malformed first attempt
   * and the two-run attempt coverage are unchanged, and every caller that
   * omits this behaves byte-for-byte as before
   * (phase pr144-t4-cost-repair-20261001). */
  securityEvidence?: string,
): AgentSpawner {
  let securityAttempts = 0;
  const brain: WholeLeadOptions = {
    onLeadStart: () => {
      order.push('model:lead');
      onLeadStart?.();
    },
    childAnswer: (prompt) => {
      const source = sourceFor(prompt);
      order.push(`model:${source}`);
      return answerOverride?.(prompt) ?? (source === 'security' && securityAttempts++ === 0
        ? 'malformed first attempt'
        : source === 'security'
          ? JSON.stringify([{
              source: 'security', severity: 'blocker', category: 'auth', title: 'Verified security defect',
              location: 'src/main.ts:2', evidence: securityEvidence ?? '  return 43;', detail: 'The changed line demonstrates the security defect.',
              recommended_fix: 'Correct the implementation and add a regression test.',
            }])
          : '[]');
    },
  };
  return fakeWholeSpawner(root, brain).spawner;
}

const repos: FixtureRepo[] = [];
const dbs: LedgerDb[] = [];
const dirs: string[] = [];
// T4 attribution state (phase pr144-t4-deep-attribution-20261001; test-local,
// observation only): the afterEach close/cleanup loop runs OUTSIDE the test
// body and its inherited 30000 ms bound. When the T4 case arms the observer,
// that loop's cost is measured and labelled here — never inferred, never
// summed into in-test phases. Non-T4 tests arm nothing and behave identically.
let t4Observe = false;
let t4StartAt: number | null = null;
// True only when the test body reached its end. False proves only that the
// body did NOT complete — a timeout abandonment or an already-thrown
// assertion — never that the body is still settling.
let t4BodyCompleted = false;
afterEach(() => {
  const observing = t4Observe;
  t4Observe = false;
  const cleanupStarted = performance.now();
  try {
    while (dbs.length > 0) dbs.pop()!.close();
    while (repos.length > 0) repos.pop()!.cleanup();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  } finally {
    // Observational finalization is exception-safe: it runs even when a
    // cleanup call throws, WITHOUT catching, swallowing, or replacing the
    // original cleanup error, which still propagates to the runner unchanged.
    if (observing && t4StartAt !== null) {
      console.log(`T4-ATTR ${JSON.stringify({
        leg: 'suite', phase: 'outside-test-cleanup', boundary: 'end',
        absMs: Math.round(performance.now() - t4StartAt),
        elapsedMs: Math.round(performance.now() - cleanupStarted),
        outcome: t4BodyCompleted ? 'completed' : 'test-body-incomplete',
        note: 'db.close + repo.cleanup(prune+rm) + rmSync run in afterEach, OUTSIDE the test body and its inherited 30000 ms bound; observed even when cleanup throws; test-body-incomplete means only that the body did not complete',
      })}`);
      t4StartAt = null;
    }
  }
});

describe('GitHub SHA-bound Perkins delivery', () => {
  it('delivers on head equality even when the recorded base is stale, and refuses a moved head', async () => {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gh-poster-'));
    const log = join(root, 'calls.jsonl');
    const binary = join(root, 'gh-double.mjs');
    const repoPath = join(root, 'repo');
    execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://git.example.test/acme/widget.git']);
    const head = '1'.repeat(40);
    const base = '2'.repeat(40);
    const advancedBase = '5'.repeat(40);
    const baseState = join(root, 'base.sha');
    writeFileSync(baseState, base);
    const review = { id: 9001, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: head, body: 'review body\n' };
    writeFileSync(binary, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync, writeFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');\nconst argv = process.argv.slice(2);\nif (argv.includes('--method') && argv.includes('POST')) {\n  const body = JSON.parse(input);\n  writeFileSync(${JSON.stringify(baseState)}, ${JSON.stringify(advancedBase)});\n  process.stdout.write(JSON.stringify({ id: 9001, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: body.commit_id, body: body.body }));\n} else if (argv.some((entry) => entry.includes('/reviews?'))) {\n  process.stdout.write(JSON.stringify([{ id: 8000, user: { login: 'someone' }, state: 'COMMENTED', commit_id: 'f'.repeat(40), body: 'other' }, ${JSON.stringify(review)}]));\n} else if (argv.includes('user') && !argv.some((entry) => entry.includes('/'))) {\n  process.stdout.write('gru-bot');\n} else {\n  process.stdout.write(${JSON.stringify(`${head}\t`)} + readFileSync(${JSON.stringify(baseState)}, 'utf8') + '\\n');\n}\n`, 'utf8');
    chmodSync(binary, 0o755);
    const poster = new GhPrPoster(binary);
    // (a) The base may advance inside POST, after the GitHub identity probe.
    // The receipt carries the base observed by that probe, not a later tip;
    // head equality remains the delivery invariant and the recorded base
    // must NOT refuse a commit-bound review.
    await expect(poster.post({
      prUrl: 'https://git.example.test/acme/widget/pull/42', host: 'git.example.test', repoPath,
      body: 'review body\n', targetSha: head, baseSha: '3'.repeat(40),
    })).resolves.toEqual({
      reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: head,
      headSha: head, baseSha: base,
      bodySha256: createHash('sha256').update('review body\n', 'utf8').digest('hex'),
    });
    expect(readFileSync(baseState, 'utf8')).toBe(advancedBase);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; input: string });
    // identity probe, authenticated-account probe (R32: BEFORE the
    // irreversible POST), commit-bound POST (R5).
    expect(calls).toHaveLength(3);
    expect(calls[0]?.argv).toEqual(['api', '--hostname', 'git.example.test', 'repos/acme/widget/pulls/42', '--jq', '[.head.sha,.base.sha] | @tsv']);
    expect(calls[1]?.argv).toEqual(['api', '--hostname', 'git.example.test', 'user', '--jq', '.login']);
    expect(calls[2]?.argv).toEqual(['api', '--hostname', 'git.example.test', '--method', 'POST', 'repos/acme/widget/pulls/42/reviews', '--input', '-']);
    expect(JSON.parse(calls[2]!.input)).toEqual({ body: 'review body\n', event: 'COMMENT', commit_id: head });
    // (b) A moved head is real movement and still fails closed — before any
    // review is posted.
    await expect(poster.post({
      prUrl: 'https://git.example.test/acme/widget/pull/42', host: 'git.example.test', repoPath,
      body: 'x', targetSha: '4'.repeat(40), baseSha: base,
    })).rejects.toThrow(/identity moved/);
    const callsAfterRefusal = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; input: string });
    expect(callsAfterRefusal.filter((call) => call.argv.includes('--method'))).toHaveLength(1);
    await expect(poster.post({
      prUrl: 'https://evil.example/acme/widget/pull/42', host: 'git.example.test', repoPath,
      body: 'x', targetSha: head, baseSha: base,
    })).rejects.toThrow(/host-mismatched/);
    execFileSync('git', ['-C', repoPath, 'remote', 'set-url', 'origin', 'https://git.example.test/acme/other.git']);
    await expect(poster.post({
      prUrl: 'https://git.example.test/acme/widget/pull/42', host: 'git.example.test', repoPath,
      body: 'x', targetSha: head, baseSha: base,
    })).rejects.toThrow(/reviewed repository origin/);
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses a zero-exit POST with no parsable or unbound receipt, and reconciles an ambiguous post by head+body', async () => {
    const makePoster = (postBehavior: string, reviews: unknown): { poster: GhPrPoster; log: string } => {
      const root = mkdtempSync(join(tmpdir(), 'perkins-gh-receipt-'));
      const log = join(root, 'calls.jsonl');
      const binary = join(root, 'gh-double.mjs');
      const repoPath = join(root, 'repo');
      execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
      execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://git.example.test/acme/widget.git']);
      const head = '1'.repeat(40);
      const base = '2'.repeat(40);
      writeFileSync(binary, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');\nconst argv = process.argv.slice(2);\nif (argv.includes('--method') && argv.includes('POST')) {\n  const body = JSON.parse(input);\n  const behavior = ${JSON.stringify(postBehavior)};\n  if (behavior === 'empty') process.exit(0);\n  if (behavior === 'timeout') process.exit(1);\n  if (behavior === 'wrong-commit') { process.stdout.write(JSON.stringify({ id: 7, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: 'f'.repeat(40), body: body.body })); process.exit(0); }\n  process.stdout.write(JSON.stringify({ id: 9001, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: body.commit_id, body: body.body }));\n} else if (argv.some((entry) => entry.includes('/reviews?'))) {\n  process.stdout.write(${JSON.stringify(JSON.stringify(reviews))});\n} else if (argv.includes('user') && !argv.some((entry) => entry.includes('/'))) {\n  process.stdout.write('gru-bot');\n} else {\n  process.stdout.write(${JSON.stringify(`${head}\t${base}\n`)});\n}\n`, 'utf8');
      chmodSync(binary, 0o755);
      return { poster: new GhPrPoster(binary), log };
    };
    const head = '1'.repeat(40);
    const base = '2'.repeat(40);
    const input: { prUrl: string; host: string; repoPath: string; body: string; targetSha: string; baseSha: string } = {
      prUrl: 'https://git.example.test/acme/widget/pull/42', host: 'git.example.test', repoPath: '',
      body: 'review body\n', targetSha: head, baseSha: base,
    };
    // Empty provider output on a zero exit is NOT a receipt.
    const empty = makePoster('empty', []);
    input.repoPath = join(dirname(empty.log), 'repo');
    await expect(empty.poster.post(input)).rejects.toThrow(/no parsable review receipt/);
    // A receipt bound to another commit is refused.
    const wrongCommit = makePoster('wrong-commit', []);
    input.repoPath = join(dirname(wrongCommit.log), 'repo');
    await expect(wrongCommit.poster.post(input)).rejects.toThrow(/bound to commit/);
    // Ambiguous post (nonzero exit): reconciliation finds the exact review.
    const timeout = makePoster('timeout', [
      { id: 8000, user: { login: 'someone' }, state: 'COMMENTED', commit_id: 'f'.repeat(40), body: 'unrelated' },
      { id: 9001, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: head, body: 'review body\n' },
    ]);
    input.repoPath = join(dirname(timeout.log), 'repo');
    await expect(timeout.poster.post(input)).rejects.toThrow(/review delivery exited 1/);
    await expect(timeout.poster.reconcile!(input)).resolves.toMatchObject({ reviewId: '9001', actor: 'gru-bot', headSha: head });
    // No matching review → honestly null (no fabricated receipt).
    const absent = makePoster('timeout', [
      { id: 8000, user: { login: 'someone' }, state: 'COMMENTED', commit_id: 'f'.repeat(40), body: 'unrelated' },
    ]);
    input.repoPath = join(dirname(absent.log), 'repo');
    await expect(absent.poster.reconcile!(input)).resolves.toBeNull();
  });
  it('requires a provider commit binding on GitHub creation and reconciliation (T5)', async () => {
    const head = '1'.repeat(40);
    const base = '2'.repeat(40);
    const make = (createdLine: string, reviews: unknown): { poster: GhPrPoster; log: string } => {
      const root = mkdtempSync(join(tmpdir(), 'perkins-gh-t5-'));
      const log = join(root, 'calls.jsonl');
      const binary = join(root, 'gh-double.mjs');
      const repoPath = join(root, 'repo');
      execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
      execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://git.example.test/acme/widget.git']);
      writeFileSync(binary, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');\nconst argv = process.argv.slice(2);\nif (argv.includes('--method') && argv.includes('POST')) {\n  process.stdout.write(${JSON.stringify(createdLine)});\n} else if (argv.some((entry) => entry.includes('/reviews?'))) {\n  process.stdout.write(${JSON.stringify(JSON.stringify(reviews))});\n} else if (argv.includes('user') && !argv.some((entry) => entry.includes('/'))) {\n  process.stdout.write('gru-bot');\n} else {\n  process.stdout.write(${JSON.stringify(`${head}\t${base}\n`)});\n}\n`, 'utf8');
      chmodSync(binary, 0o755);
      return { poster: new GhPrPoster(binary), log };
    };
    const input = {
      prUrl: 'https://git.example.test/acme/widget/pull/42', host: 'git.example.test',
      body: 'review body\n', targetSha: head, baseSha: base,
    } as { prUrl: string; host: string; repoPath: string; body: string; targetSha: string; baseSha: string };
    const goodBody = JSON.stringify({ id: 7, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: head, body: 'review body\n' });
    // Creation: a provider response without a usable commit_id is refused
    // — missing, null and empty each fail loud, mismatched is bound-refused.
    for (const [label, created] of [
      ['missing', JSON.stringify({ id: 7, user: { login: 'gru-bot' }, state: 'COMMENTED', body: 'review body\n' })],
      ['null', JSON.stringify({ id: 7, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: null, body: 'review body\n' })],
      ['empty', JSON.stringify({ id: 7, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: '', body: 'review body\n' })],
    ] as const) {
      const refused = make(created, []);
      input.repoPath = join(dirname(refused.log), 'repo');
      await expect(refused.poster.post(input), label).rejects.toThrow(/missing the GitHub commit binding/);
    }
    const mismatched = make(JSON.stringify({ id: 7, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: 'f'.repeat(40), body: 'review body\n' }), []);
    input.repoPath = join(dirname(mismatched.log), 'repo');
    await expect(mismatched.poster.post(input)).rejects.toThrow(/bound to commit/);
    const valid = make(goodBody, []);
    input.repoPath = join(dirname(valid.log), 'repo');
    await expect(valid.poster.post(input)).resolves.toMatchObject({ reviewId: '7', commitId: head, headSha: head });
    // Reconciliation: a body-matching review with no usable commit binding
    // is NOT a match — honestly unresolved, never a bound receipt.
    const unboundList = make(goodBody, [
      { id: 8, user: { login: 'gru-bot' }, state: 'COMMENTED', body: 'review body\n' },
      { id: 9, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: null, body: 'review body\n' },
      { id: 10, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: '', body: 'review body\n' },
    ]);
    input.repoPath = join(dirname(unboundList.log), 'repo');
    await expect(unboundList.poster.reconcile!(input)).resolves.toBeNull();
    const boundList = make(goodBody, [
      { id: 8000, user: { login: 'someone' }, state: 'COMMENTED', commit_id: head, body: 'unrelated' },
      { id: 11, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: head, body: 'review body\n' },
    ]);
    input.repoPath = join(dirname(boundList.log), 'repo');
    await expect(boundList.poster.reconcile!(input)).resolves.toMatchObject({ reviewId: '11', commitId: head, headSha: head });
  });
});

describe('review publication redaction', () => {
  it('masks credential-shaped evidence with a fixed placeholder', () => {
    const token = `${['gh', 'p_'].join('')}${'A'.repeat(24)}`;
    const published = redactReviewForPublication(`Evidence: ${token}\n`);
    expect(published).not.toContain(token);
    expect(published).toBe('Evidence: [REDACTED]\n');
  });

  it('covers every credential pattern including quoted assignments and vendor PATs', () => {
    const githubPat = `${['github', '_pat_'].join('')}${'B'.repeat(22)}`;
    const gitlabToken = `${['glpat', '-'].join('')}${'C'.repeat(22)}`;
    const cases: ReadonlyArray<[string, RegExp]> = [
      ['-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', /\[REDACTED\]/u],
      [`${['sk', '-proj-'].join('')}${'D'.repeat(20)}`, /\[REDACTED\]/u],
      [`AKIA${'E'.repeat(16)}`, /\[REDACTED\]/u],
      [githubPat, /\[REDACTED\]/u],
      [gitlabToken, /\[REDACTED\]/u],
      ['password: "hunter2"', /\[REDACTED\]/u],
      ["api_key = 's3cret value'", /\[REDACTED\]/u],
      ['secret: plainvalue', /\[REDACTED\]/u],
    ];
    for (const [secret, marker] of cases) {
      const published = redactReviewForPublication(`evidence ${secret} end`);
      expect(published).not.toContain(secret);
      expect(published).toMatch(marker);
      expect(published.startsWith('evidence ')).toBe(true);
      expect(published.endsWith(' end')).toBe(true);
    }
  });
});

describe('WaveRunner built-in Perkins production path', () => {
  it('acknowledges a busy implementing minion without an open review turn, and restores the queued handoff after restart', async () => {
    const repo = makeFixtureRepo('perkins-handoff-recovery');
    repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'perkins-handoff-port-'));
    dirs.push(root);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-handoff-db-')));
    dbs.push(db);
    const bus = new EventBus();
    const ledger = new LedgerApi(db.handle, { bus });
    const port = new GitReviewPort(root, 'main', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-handoff' });
    const job = ledger.addJob({ id: 'job-handoff', repo: 'fixture', title: 'handoff', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    const options = {
      ledger, worktrees: port, bus, spawner: vi.fn() as unknown as AgentSpawner,
      reviewPreflight: async () => ({ ok: false as const, failures: [preflightFailure('review-policy', 'disabled')] }),
    };
    const first = new WaveRunner(options);
    const accepted = await first.requestReview({ jobId: job.id, handoff: true });
    expect(accepted.route).toBe('queued');
    expect(ledger.listRounds(job.id)).toHaveLength(0); // no freeze while the branch is busy
    const duplicate = await first.requestReview({ jobId: job.id, handoff: true });
    expect(duplicate.route).toBe('queued');
    if (duplicate.route === 'queued' && accepted.route === 'queued') expect(duplicate.requestSeq).toBe(accepted.requestSeq);
    await first.shutdown();
    const resumed = new WaveRunner(options);
    resumed.resumeQueuedHandoffs();
    expect(ledger.latestJobEvent(job.id, 'job.review-handoff-failed')).toBeNull();
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: { sha: repo.head() } });
    for (let tick = 0; tick < 20 && ledger.latestJobEvent(job.id, 'job.review-handoff-failed') === null; tick += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(ledger.latestJobEvent(job.id, 'job.review-handoff-failed')?.payload).toMatchObject({ error: expect.stringContaining('not configured') });
    expect(ledger.listRounds(job.id)).toHaveLength(0); // fallback unavailable: no phantom approval
    await resumed.shutdown();
  });
  it('holds a reserved round pending while admission waits, admits to live, and cancels cleanly', async () => {
    const repo = makeFixtureRepo('perkins-residency-lifecycle');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 44;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-residency-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-residency-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-residency-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/review', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-residency' });
    const job = ledger.addJob({
      id: 'job-residency', repo: 'fixture', title: 'residency', baseBranch: 'main', briefing: 'review this',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    attachOrigin(repo, 'feature/review', root);
    const spawner = vi.fn() as unknown as AgentSpawner;
    const deferred: Array<{
      resolve: (round: import('../src/runtime/registry.js').ResidentReviewRound) => void;
      reject: (error: Error) => void;
    }> = [];
    const reserveReviewRound = (signal: AbortSignal) => new Promise<import('../src/runtime/registry.js').ResidentReviewRound>((resolve, reject) => {
      deferred.push({ resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('resident admission cancelled')), { once: true });
    });
    const probeRound: import('../src/runtime/registry.js').ResidentReviewRound = {
      spawn: async () => { throw new Error('admission-probe: spawn refused'); },
      beginChildren: () => ({ concurrency: 1, finish: () => {} }),
      close: async () => {},
      // Inert on this double: the admission probe never opens a round body,
      // so it holds no cleanup debt and has nothing to reconcile.
      reconcileCleanup: () => {},
      cleanupDebt: () => [],
    };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts,
      reserveReviewRound,
    });

    // Admitted path: the round freezes pending, waits for two resident
    // slots, then flips live on admission — never before. (Setup includes
    // an await — the admission remote probe — so wait for the EVENT, not
    // a fixed tick count.)
    const admitted = wave.beginRound({ jobId: job.id });
    let queued = ledger.listRounds(job.id)[0];
    for (let waited = 0; waited < 200 && (queued === undefined ||
      ledger.latestRoundEvent(queued.id, 'round.residency-queued') === null); waited += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      queued = ledger.listRounds(job.id)[0];
    }
    expect(queued?.status).toBe('pending'); // NOT live while admission waits
    expect(ledger.latestRoundEvent(queued!.id, 'round.residency-queued')?.roundId).toBe(queued!.id);
    deferred[0]!.resolve(probeRound);
    const outcome = await admitted;
    expect(outcome.round.id).toBe(queued!.id);
    expect(ledger.latestRoundEvent(queued!.id, 'round.residency-admitted')).not.toBeNull();
    expect(ledger.latestRoundEvent(queued!.id, 'round.residency-cancelled')).toBeNull();
    // Admission itself is not a spawn: the first attempted lead transition
    // is what changes pending to live, even if its spawner throws.
    await outcome.run;
    expect(ledger.getRound(queued!.id)?.status).toBe('aborted');
    expect(ledger.uniqueRoundNoSpawnReceipt(queued!.id)).toBeNull();
    await wave.shutdown();
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });

    // Cancelled path: a queued admission aborted by shutdown records the
    // cancellation and aborts the still-pending round.
    const db2 = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-residency-db2-')));
    dbs.push(db2);
    const ledger2 = new LedgerApi(db2.handle, { bus: new EventBus() });
    const port2 = new GitReviewPort(mkdtempSync(join(tmpdir(), 'perkins-residency-port2-')), 'feature/review', target);
    await port2.createJobWorktree({ repoPath: repo.path, jobId: 'job-residency-2' });
    const job2 = ledger2.addJob({
      id: 'job-residency-2', repo: 'fixture', title: 'residency cancel', baseBranch: 'main', briefing: 'review this',
    });
    ledger2.setJobStatus(job2.id, 'working');
    settleLane(ledger2, job2.id);
    deferred.length = 0;
    const wave2 = new WaveRunner({
      ledger: ledger2, worktrees: port2, spawner, reviewArtifactRoot: artifacts,
      reserveReviewRound,
    });
    const pending = wave2.beginRound({ jobId: job2.id });
    pending.catch(() => {}); // observed below via the ledger; avoid unhandled noise
    await new Promise<void>((resolve) => setImmediate(resolve));
    const [waiting] = ledger2.listRounds(job2.id);
    expect(waiting?.status).toBe('pending');
    await wave2.shutdown(); // aborts the active controller → admission rejects
    await pending.catch(() => {});
    expect(ledger2.getRound(waiting!.id)?.status).toBe('aborted');
    expect(ledger2.latestRoundEvent(waiting!.id, 'round.residency-cancelled')).not.toBeNull();
    expect(ledger2.uniqueRoundNoSpawnReceipt(waiting!.id)).not.toBeNull();
    expect(spawner).not.toHaveBeenCalled();
  });
  it('fails closed on bundled-policy setup errors before a round or reviewer spawn', async () => {
    const repo = makeFixtureRepo('perkins-policy-setup-error');
    repos.push(repo);
    const target = repo.head();
    const root = mkdtempSync(join(tmpdir(), 'perkins-policy-setup-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-policy-setup-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-policy-setup-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-policy-error' });
    const job = ledger.addJob({
      id: 'job-policy-error', repo: 'fixture', title: 'policy error', baseBranch: 'main', briefing: 'review this',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const spawner = vi.fn() as unknown as AgentSpawner;
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts,
      reviewPolicyLoader: () => { throw new Error('bundled perkins-code-review integrity mismatch'); },
    });
    await expect(wave.beginRound({ jobId: job.id })).rejects.toThrow(/integrity mismatch/);
    expect(ledger.getJob(job.id)?.status).toBe('working');
    expect(ledger.listRounds(job.id)).toHaveLength(0);
    expect(port.listWorktrees({ jobId: job.id })).toHaveLength(1);
    expect(spawner).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('rejects an empty/unreviewable diff before promising a live round and releases setup state', async () => {
    const repo = makeFixtureRepo('perkins-wave-empty');
    repos.push(repo);
    const target = repo.head();
    const root = mkdtempSync(join(tmpdir(), 'perkins-empty-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-empty-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-empty-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-empty' });
    const job = ledger.addJob({
      id: 'job-empty', repo: 'fixture', title: 'empty review', baseBranch: 'main', briefing: 'review this',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const spawner = vi.fn() as unknown as AgentSpawner;
    const wave = new WaveRunner({ ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts });
    await expect(wave.beginRound({ jobId: job.id })).rejects.toThrow(/frozen review diff is empty/);
    const [round] = ledger.listRounds(job.id);
    expect(round?.status).toBe('aborted');
    expect(ledger.getJob(job.id)?.status).toBe('working');
    expect(port.getWorktree(round!.id)?.status).toBe('swept');
    expect(spawner).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('shutdown waits for active setup, aborts its pending round, and releases the created lane', async () => {
    const repo = makeFixtureRepo('perkins-setup-shutdown');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/setup-shutdown']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-setup-shutdown-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-setup-shutdown-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-setup-shutdown-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const delegate = new GitReviewPort(root, 'feature/setup-shutdown', target);
    let markCreated!: () => void;
    const created = new Promise<void>((resolve) => { markCreated = resolve; });
    let releaseCreate!: () => void;
    const release = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const port = new DeferredReviewPort(delegate, markCreated, release);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-setup-shutdown' });
    const job = ledger.addJob({
      id: 'job-setup-shutdown', repo: 'fixture', title: 'setup shutdown', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner, reviewArtifactRoot: artifacts,
    });
    const beginning = wave.beginRound({ jobId: job.id });
    const observedBeginning = beginning.then((value) => value, (error: unknown) => error);
    await created;
    const round = ledger.listRounds(job.id)[0]!;
    let shutdownSettled = false;
    const shutdown = wave.shutdown().then(() => { shutdownSettled = true; });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    releaseCreate();
    await shutdown;
    expect(await observedBeginning).toBeInstanceOf(Error);
    expect(ledger.getRound(round.id)?.status).toBe('aborted');
    expect(ledger.latestRoundEvent(round.id, 'round.perkins-incomplete')?.payload).toMatchObject({
      reason: 'service_shutdown_setup',
    });
    expect(readFileSync(join(artifacts, round.id, 'perkins-report.md'), 'utf8')).toContain('INCOMPLETE');
    expect(port.getWorktree(round.id)?.status).toBe('swept');
    expect(ledger.getJob(job.id)?.status).toBe('working');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('shutdown aborts an active blocked lead with durable INCOMPLETE proof and lane cleanup', async () => {
    const repo = makeFixtureRepo('perkins-blocked-shutdown');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/blocked-shutdown']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-blocked-shutdown-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-blocked-shutdown-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-blocked-shutdown-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-blocked-shutdown-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/blocked-shutdown', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-blocked-shutdown' });
    const job = ledger.addJob({
      id: 'job-blocked-shutdown', repo: 'fixture', title: 'blocked shutdown', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    let leadStarted!: () => void;
    const started = new Promise<void>((resolve) => { leadStarted = resolve; });
    const never = new Promise<void>(() => {});
    let disposed = false;
    const spawner: AgentSpawner = async (_role, options = {}): Promise<AgentHandle> => {
      const sessionFile = join(sessions, 'blocked-lead.jsonl');
      writeFileSync(sessionFile, '', 'utf8');
      return {
        role: 'perkins', id: 'blocked-lead', sessionFile, reviewIsolation: true,
        capabilities: {
          streaming: true, steer: 'native', resume: 'file', images: false,
          thinking: false, thinkingLevelControl: false, followUp: false,
        },
        async prompt() { if (options.reviewLead !== undefined) leadStarted(); await never; },
        async steer() {}, async followUp() {}, subscribe() { return () => {}; },
        health() { return { state: 'streaming', lastActivity: null, sessionFile }; },
        async dispose() { disposed = true; },
      };
    };
    const wave = new WaveRunner({ ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts });
    const running = wave.runRound({ jobId: job.id });
    await started;
    await wave.shutdown();
    const outcome = asWave(await running);
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.round.status).toBe('aborted');
    expect(readFileSync(outcome.reportFile, 'utf8')).toContain('INCOMPLETE');
    expect(port.getWorktree(outcome.round.id)?.status).toBe('swept');
    expect(disposed).toBe(true);
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });

  it('a lead-submitted INCOMPLETE returns a host-owned report with journal-vs-settled execution facts at the report boundary (gh-169 Q5/Q6)', async () => {
    const repo = makeFixtureRepo('perkins-lead-incomplete');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lead-incomplete']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-li-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-li-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-li-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-li-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/lead-incomplete', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-lead-incomplete' });
    const job = ledger.addJob({ id: 'job-lead-incomplete', repo: 'fixture', title: 'lead incomplete', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/43');
    attachOrigin(repo, 'feature/lead-incomplete', root);
    const escalations: string[] = [];
    const fake = fakeWholeSpawner(sessions, {
      specialists: ['security', 'tests'],
      childAnswer: () => '[]',
      verdictOverride: 'INCOMPLETE',
    });
    const settledHashes = new Map<string, string>();
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/lead-incomplete'),
      reviewFreezeObserver: (frozen) => {
        for (const name of ['manifest.json', 'diff.patch', 'spec-context.md', 'project-conventions.md', 'changed-files.json']) {
          settledHashes.set(name, createHash('sha256').update(readFileSync(join(frozen.directory, name))).digest('hex'));
        }
      },
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.round.status).toBe('aborted');
    // Q6: the RETURNED report is the host-owned INCOMPLETE report — a
    // reader at outcome.reportFile sees the factual counts and the link to
    // the preserved lead report.
    expect(basename(outcome.reportFile)).toBe('perkins-report.host-incomplete.md');
    const hostReport = readFileSync(outcome.reportFile, 'utf8');
    expect(hostReport).toContain('Specialist execution: 2 journaled start(s); settled results: 2 (2 valid, 0 failed)');
    expect(hostReport).toContain('7 of 9 lens(es) never started');
    expect(hostReport).toContain('preserved verbatim at `perkins-report.md`');
    expect(existsSync(join(artifacts, outcome.round.id, 'perkins-report.md'))).toBe(true);
    // Q5: the durable event payload carries the same facts line.
    const incompleteEvent = ledger.listEvents({ limit: 200 }).find((event) => event.kind === 'round.perkins-incomplete');
    expect((incompleteEvent?.payload as { readonly executionFacts?: string }).executionFacts)
      .toContain('2 journaled start(s); settled results: 2 (2 valid, 0 failed)');
    expect(escalations.some((entry) => entry.includes('perkins-report.host-incomplete.md'))).toBe(true);
    // No parent incident: the lead COMPLETED a submission; this is a
    // settled INCOMPLETE, not a parent failure.
    expect(ledger.listEvents({ limit: 200 }).some((event) => event.kind === 'round.parent-incident')).toBe(false);
    // Q10: the frozen packet stays byte-identical through the full settled
    // round (preflight, specialist runs, terminalization, host report).
    for (const [name, digest] of settledHashes) {
      expect(createHash('sha256').update(readFileSync(join(artifacts, outcome.round.id, name))).digest('hex'), name).toBe(digest);
    }
  });

  it('refuses admission through the real wave when the frozen packet corrupts at the freeze boundary (gh-169 Q9)', async () => {
    const repo = makeFixtureRepo('perkins-admission-refused');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/admission-refused']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-refused-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-refused-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-refused-sessions-'));
    dirs.push(sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-refused-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/admission-refused', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-refused' });
    const job = ledger.addJob({ id: 'job-refused', repo: 'fixture', title: 'admission refused', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/44');
    attachOrigin(repo, 'feature/admission-refused', root);
    const escalations: string[] = [];
    const underlying = makeSpawner(sessions, []);
    const wave = new WaveRunner({
      ledger, worktrees: port,
      spawner: (role, options) => underlying(role, options),
      reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/admission-refused'),
      reviewFreezeObserver: (frozen) => {
        // Corrupt TWO independent inputs between the freeze receipts and
        // the admission preflight — exactly the boundary the gate owns —
        // so the exhaustive multi-input refusal is proven end to end (P8).
        writeFileSync(join(frozen.directory, 'diff.patch'), 'tampered after freeze');
        writeFileSync(join(frozen.directory, 'spec-context.md'), 'tampered spec after freeze');
      },
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    await expect(wave.runRound({ jobId: job.id })).rejects.toThrow(
      /review admission preflight refused.*\[frozen-packet:diff\.patch\].*\[frozen-packet:spec-context\.md\]|review admission preflight refused.*\[frozen-packet:spec-context\.md\].*\[frozen-packet:diff\.patch\]/u,
    );
    // One failed admission event with the exhaustive named missing list,
    // an aborted round with a durable no-spawn receipt, and ZERO spawns.
    const admission = ledger.listEvents({ limit: 200 }).find((event) => event.kind === 'round.admission-preflight');
    expect(admission?.payload).toMatchObject({ ok: false });
    const missingInputs = (admission?.payload as { readonly missing?: Array<{ readonly input: string }> }).missing?.map((entry) => entry.input) ?? [];
    expect(missingInputs).toContain('frozen-packet:diff.patch');
    expect(missingInputs).toContain('frozen-packet:spec-context.md');
    expect(missingInputs.length).toBeGreaterThanOrEqual(4);
    const aborted = ledger.listRounds(job.id).find((entry) => entry.status === 'aborted');
    expect(aborted).toBeDefined();
    expect(ledger.listEvents({ limit: 200 }).some((event) => event.kind === 'round.review-no-spawn')).toBe(true);
    expect(ledger.listAgents().filter((agent) => agent.roundId === aborted!.id)).toEqual([]);
    expect(ledger.listEvents({ limit: 200 }).some((event) => event.kind === 'round.parent-incident')).toBe(false);
    expect(escalations.some((entry) => entry.includes('refused admission before any specialist started') &&
      entry.includes('frozen-packet:diff.patch') && entry.includes('frozen-packet:spec-context.md'))).toBe(true);
    expect(port.getWorktree(aborted!.id)?.status).toBe('swept');
  });

  it('an atomic-finalization failure commits nothing deferred: settled truth kept, unused lenses pending, no posted verdict (gh-169 P1)', async () => {
    const repo = makeFixtureRepo('perkins-finalization-explode');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/finalization-explode']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-fe-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-fe-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-fe-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-fe-db-')));
    dbs.push(db);
    // The ledger explodes exactly at verdict recording — AFTER the settled
    // lens chips committed, before the not-used chips were deferred to it.
    class VerdictExplodingLedger extends LedgerApi {
      override setRoundVerdict(): never {
        throw new Error('simulated ledger failure at verdict recording');
      }
    }
    const ledger = new VerdictExplodingLedger(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/finalization-explode', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-fe' });
    const job = ledger.addJob({ id: 'job-fe', repo: 'fixture', title: 'finalization explode', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/45');
    attachOrigin(repo, 'feature/finalization-explode', root);
    const fake = fakeWholeSpawner(sessions, { specialists: ['security'], childAnswer: () => '[]' });
    const poster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      poster, prHeadProbe: localHeadProbe('feature/finalization-explode'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.round.status).toBe('aborted');
    const chips = ledger.getRound(outcome.round.id)?.lenses ?? [];
    // Round-5 P1 ATOMIC finalization: the explosion inside the verdict
    // transaction leaves NOTHING committed — the settled lens keeps the
    // chip it durably committed EARLIER (done), every deferred not-used
    // chip stays PENDING (no coverage claim on an aborted round), no
    // verdict is posted, and the abort is legal and honest.
    const security = chips.find((chip) => chip.lens === 'security');
    expect(security?.state).toBe('done');
    for (const chip of chips.filter((entry) => entry.lens !== 'security')) {
      expect(chip.state, chip.lens).toBe('pending');
    }
    expect(ledger.getRound(outcome.round.id)?.verdict).toBeNull();
    // Returned results agree with the chips: the settled lens keeps its
    // provisional (truthful) result; every other lens is an honest
    // not-started parent-incident outcome; no child failure is invented.
    const securityIndex = chips.findIndex((chip) => chip.lens === 'security');
    expect(outcome.results[securityIndex]?.state).toBe('done');
    expect(outcome.results.filter((result) => result.state === 'error' && result.note.startsWith('not started — parent incident'))).toHaveLength(8);
    const incident = ledger.listEvents({ limit: 200 }).find((event) => event.kind === 'round.parent-incident');
    expect(incident?.payload).toMatchObject({ startedAttempts: 1, startedLenses: ['security'] });
  });

  it('a failed host-INCOMPLETE report write is loud: the event and escalation disclose the fallback (gh-169 P4)', async () => {
    const repo = makeFixtureRepo('perkins-host-report-fail');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/host-report-fail']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-hrf-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-hrf-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-hrf-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-hrf-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/host-report-fail', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-hrf' });
    const job = ledger.addJob({ id: 'job-hrf', repo: 'fixture', title: 'host report fail', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/46');
    attachOrigin(repo, 'feature/host-report-fail', root);
    const escalations: string[] = [];
    const fake = fakeWholeSpawner(sessions, { specialists: ['security'], childAnswer: () => '[]', verdictOverride: 'INCOMPLETE' });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/host-report-fail'),
      reviewFreezeObserver: (frozen) => {
        // Pre-plant a different-bytes host report: the write-once artifact
        // store refuses the later write (EEXIST), forcing the loud path.
        writeFileSync(join(frozen.directory, 'perkins-report.host-incomplete.md'), 'planted different bytes\n');
      },
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    // The returned report regresses to the PRESERVED lead report —
    // disclosed, never silent.
    expect(basename(outcome.reportFile)).toBe('perkins-report.md');
    const event = ledger.listEvents({ limit: 200 }).find((entry) => entry.kind === 'round.perkins-incomplete');
    expect((event?.payload as { readonly hostReportWriteFailed?: string }).hostReportWriteFailed).toBeTruthy();
    expect((event?.payload as { readonly executionFacts?: string }).executionFacts).toContain('1 journaled start(s)');
    expect(escalations.some((entry) => entry.includes('could NOT be written') && entry.includes('fallback record'))).toBe(true);
  });

  it('a journaled-but-unsettled lens is real started work in chip, outcome and report — never not-used (gh-169 R4-2)', async () => {
    const repo = makeFixtureRepo('perkins-unsettled-lens');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/unsettled-lens']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-ul-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-ul-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-ul-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-ul-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/unsettled-lens', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-ul' });
    const job = ledger.addJob({ id: 'job-ul', repo: 'fixture', title: 'unsettled lens', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/48');
    attachOrigin(repo, 'feature/unsettled-lens', root);
    const poster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const fake = fakeWholeSpawner(sessions, { specialists: ['security'], childAnswer: () => '[]' });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      poster, prHeadProbe: localHeadProbe('feature/unsettled-lens'),
      reviewFreezeObserver: (frozen) => {
        // A second-wave start whose pool result never commits: charged to
        // the journal at the freeze boundary, settled nowhere. security a1
        // settles for real below — the unsettled identity is edge a1.
        ledger.appendCustomEvent({
          kind: 'round.specialist-started',
          jobId: job.id,
          roundId: roundIdOf(frozen.directory),
          payload: { lens: 'edge', attempt: 1, originRoundId: roundIdOf(frozen.directory) },
        });
      },
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.verdict).toBe('approved');
    const chips = ledger.getRound(outcome.round.id)?.lenses ?? [];
    // The journaled-but-unsettled lens: an honest execution-gap error chip,
    // never a 'not used' done chip.
    const edge = chips.find((chip) => chip.lens === 'edge');
    expect(edge?.state).toBe('error');
    expect(edge?.note).toContain('attempt(s) started but unsettled: a1');
    const edgeResult = outcome.results[chips.findIndex((chip) => chip.lens === 'edge')];
    expect(edgeResult?.state).toBe('error');
    expect(edgeResult?.state === 'error' && edgeResult.note).toContain('attempt(s) started but unsettled: a1');
    // The conclusive appendix discloses it as started work, never not-used.
    const postedBody = poster.post.mock.calls[0]?.[0]?.body as string;
    expect(postedBody).toContain('2 journaled (1 valid, 0 failed; 1 started-but-unsettled: edge a1)');
    expect(postedBody).toContain('Specialist attempts that started but never committed a result: edge a1');
    expect(postedBody).not.toMatch(/Lenses not used this round:[^\n]*edge/u);
    // P6 (round 5): the exact frozen no-bound-run UNAVAILABLE disclosure
    // reaches the LEAD prompt — not only the frozen bytes.
    expect(fake.leadCalls[0]!.prompt).toContain('--- HOST-RECORDED VERIFICATION');
    expect(fake.leadCalls[0]!.prompt).toContain('state: UNAVAILABLE — NO BOUND VERIFICATION RUN');
    expect(fake.leadCalls[0]!.prompt).toContain('--- HOST-RECORDED CI EVIDENCE');
  });

  it('refuses the freeze pre-round when the spec bound leaves no room for any verification section (gh-169 P9)', async () => {
    const repo = makeFixtureRepo('perkins-verification-noroom');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/verification-noroom']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-vnr-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-vnr-artifacts-'));
    dirs.push(root, artifacts);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-vnr-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/verification-noroom', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-vnr' });
    const job = ledger.addJob({ id: 'job-vnr', repo: 'fixture', title: 'verification no room', baseBranch: 'main', briefing: 'x'.repeat(256 * 1024 - 10) });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/47');
    attachOrigin(repo, 'feature/verification-noroom', root);
    const underlying = makeSpawner(mkdtempSync(join(tmpdir(), 'perkins-vnr-sessions-')), []);
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: (role, options) => underlying(role, options),
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/verification-noroom'),
    });
    // A supplied spec that cannot carry ANY verification section (neither
    // the bound run nor the omission notice nor the absence disclosure)
    // refuses at assembly — the admitted round aborts WITHOUT any spawn
    // (durable no-spawn receipt, zero agents) and nothing froze silently.
    await expect(wave.runRound({ jobId: job.id })).rejects.toThrow(/no room for a verification section/u);
    const rounds = ledger.listRounds(job.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.status).toBe('aborted');
    expect(ledger.listEvents({ limit: 100 }).some((event) => event.kind === 'round.review-no-spawn')).toBe(true);
    expect(ledger.listAgents().filter((agent) => agent.roundId === rounds[0]!.id)).toEqual([]);
  });

  it('freezes an oversized BOUND verification run as an explicit omission notice through the real wave (gh-169 R4-7)', async () => {
    const repo = makeFixtureRepo('perkins-oversized-bound-run');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/oversized-bound-run']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-obr-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-obr-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-obr-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-obr-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/oversized-bound-run', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-obr' });
    // A COMPLETED verification run at the exact target with long host
    // strings (scope/command) so its rendered block is large.
    const longScope = 'scope-'.repeat(60);
    const longCommand = 'cmd-'.repeat(90);
    ledger.appendCustomEvent({
      kind: 'verification.completed',
      jobId: 'job-obr',
      payload: {
        sha: target, scope: longScope, command: longCommand, ok: true, exit_code: 0,
        duration_ms: 1000, workers: 2, run_id: 'run-obr-1', output_bytes: 4096,
        output_sha256: createHash('sha256').update('out').digest('hex'),
      },
    });
    // Size the briefing from the ACTUAL rendered blocks: the real
    // verification block must NOT fit, while the omission notice and the
    // CI section (or its own notice) still can.
    const boundRun = renderRecordedVerification(
      { ts: '2026-10-05T00:00:00Z', payload: ledger.latestJobEvent('job-obr', 'verification.completed')!.payload },
      target,
    )!;
    const evidenceBytes = Buffer.byteLength(boundRun, 'utf8');
    expect(evidenceBytes).toBeGreaterThan(1_000); // the geometry requires a large block
    const briefing = 'x'.repeat(256 * 1024 - 900);
    const job = ledger.addJob({ id: 'job-obr', repo: 'fixture', title: 'oversized bound run', baseBranch: 'main', briefing });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/49');
    attachOrigin(repo, 'feature/oversized-bound-run', root);
    const fake = fakeWholeSpawner(sessions, { childAnswer: () => '[]' });
    const poster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      poster, prHeadProbe: localHeadProbe('feature/oversized-bound-run'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    // The frozen spec carries the EXPLICIT omission notice for the bound
    // run — never silence and never a false NO BOUND RUN claim.
    const frozenSpec = readFileSync(join(artifacts, outcome.round.id, 'spec-context.md'), 'utf8');
    expect(frozenSpec).toContain('state: UNAVAILABLE — VERIFICATION EVIDENCE OMITTED (frozen spec bound)');
    expect(frozenSpec).not.toContain('NO BOUND VERIFICATION RUN');
    expect(frozenSpec).toContain('--- HOST-RECORDED CI EVIDENCE');
    expect(outcome.round.status).toBe('verdict-posted');
  });

  it('keeps the service loop responsive through a stalled advertised-tip probe at admission, refusing fail-closed without spawn (gh-169 P7)', async () => {
    const repo = makeFixtureRepo('perkins-stalled-admission');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/stalled-admission']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-sa-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-sa-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-sa-sessions-'));
    dirs.push(sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-sa-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/stalled-admission', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-sa' });
    const job = ledger.addJob({ id: 'job-sa', repo: 'fixture', title: 'stalled admission', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/50');
    attachOrigin(repo, 'feature/stalled-admission', root);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), 'perkins-sa-shim-'));
    dirs.push(shimDir);
    const shim = join(shimDir, 'git');
    writeFileSync(shim, `#!/bin/sh\ncase " $* " in *"ls-remote"*) sleep 30;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(shim, 0o755);
    const underlying = makeSpawner(sessions, []);
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: (role, options) => underlying(role, options),
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/stalled-admission'),
    });
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 25);
    try {
      await expect(wave.runRound({ jobId: job.id })).rejects.toThrow(/head-binding.*automatic retry 1 of 2 is scheduled/u);
    } finally {
      clearInterval(ticker);
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      await wave.shutdown(); // the scheduled retry stays durable, never fired here
    }
    // A stall is transient: one durable retry is scheduled a minute out.
    expect(ledger.listJobEventsByKinds(job.id, ['round.admission-retry-scheduled'])).toHaveLength(1);
    // Unrelated event-loop work ran THROUGHOUT the stalled probe (the
    // admission probe is off-loop), and the refusal is fail-closed without
    // any spawn.
    expect(ticks).toBeGreaterThan(20);
    const round = ledger.listRounds(job.id)[0]!;
    expect(round.status).toBe('aborted');
    expect(ledger.listEvents({ limit: 100 }).some((event) => event.kind === 'round.review-no-spawn')).toBe(true);
    expect(ledger.listAgents().filter((agent) => agent.roundId === round.id)).toEqual([]);
  });

  it('a mid-loop settled-chip failure preserves the committed chip and invents no child failure (gh-169 P8)', async () => {
    const repo = makeFixtureRepo('perkins-partial-chip-failure');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/partial-chip-failure']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-pcf-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-pcf-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-pcf-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-pcf-db-')));
    dbs.push(db);
    // Explode on the SECOND settled chip write (tests): security's write
    // succeeds first, preserving its committed truth.
    class SecondChipExplodingLedger extends LedgerApi {
      private writes = 0;
      override setLensOutcome(roundId: string, lens: string, state: string, note?: string): ReturnType<LedgerApi['setLensOutcome']> {
        this.writes += 1;
        if (lens === 'tests' && state === 'error') throw new Error('simulated chip-write failure');
        return super.setLensOutcome(roundId, lens, state, note);
      }
    }
    const ledger = new SecondChipExplodingLedger(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/partial-chip-failure', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-pcf' });
    const job = ledger.addJob({ id: 'job-pcf', repo: 'fixture', title: 'partial chip failure', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/51');
    attachOrigin(repo, 'feature/partial-chip-failure', root);
    const fake = fakeWholeSpawner(sessions, {
      specialists: ['security', 'tests'],
      childAnswer: (prompt) => (/"source": "tests"/u.test(prompt) ? 'malformed output' : '[]'),
    });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/partial-chip-failure'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    const chips = ledger.getRound(outcome.round.id)?.lenses ?? [];
    // The FIRST settled lens keeps its committed done chip and matching
    // returned result; the failed-write lens keeps pending (started via
    // journal) and returns an interrupted-execution error — never an
    // invented settled failure, never not-used.
    const security = chips.find((chip) => chip.lens === 'security');
    expect(security?.state).toBe('done');
    const securityResult = outcome.results[chips.findIndex((chip) => chip.lens === 'security')];
    expect(securityResult?.state).toBe('done');
    const testsChip = chips.find((chip) => chip.lens === 'tests');
    // The chip write FAILED, so the durable chip keeps its pre-write state
    // (live — the child had registered); the truth rides in the returned
    // result and the parent incident, never an invented settled failure.
    expect(testsChip?.state).toBe('live');
    const testsResult = outcome.results[chips.findIndex((chip) => chip.lens === 'tests')];
    expect(testsResult?.state).toBe('error');
    // The tests attempt SETTLED (its checkpoint is durable) — the truthful
    // wording discloses the settlement rather than claiming no settlement.
    expect(testsResult?.state === 'error' && testsResult.note).toContain('attempt settled (checkpoint recorded)');
    const incident = ledger.listEvents({ limit: 200 }).find((event) => event.kind === 'round.parent-incident');
    expect(incident?.payload).toMatchObject({ startedLenses: expect.arrayContaining(['security', 'tests']) });
  });

  it('names the actual fallback when delivery fails AND the host report cannot be written (gh-169 P9)', async () => {
    const repo = makeFixtureRepo('perkins-dual-failure');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/dual-failure']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-df-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-df-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-df-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-df-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/dual-failure', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-df' });
    const job = ledger.addJob({ id: 'job-df', repo: 'fixture', title: 'dual failure', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/52');
    attachOrigin(repo, 'feature/dual-failure', root);
    const escalations: string[] = [];
    const fake = fakeWholeSpawner(sessions, { childAnswer: () => '[]' });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      // Delivery FAILS first (poster throws)...
      poster: { post: vi.fn(async () => { throw new Error('simulated delivery failure'); }) },
      prHeadProbe: localHeadProbe('feature/dual-failure'),
      // ...and then the host INCOMPLETE report cannot be written (planted
      // different-bytes write-once collision).
      reviewFreezeObserver: (frozen) => {
        writeFileSync(join(frozen.directory, 'perkins-report.host-incomplete.md'), 'planted different bytes\n');
      },
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    // The RETURNED report is the delivery-incomplete record; the event and
    // the escalation name the SAME fallback path (they agree with the
    // returned outcome), and the lead report stays preserved.
    expect(basename(outcome.reportFile)).toBe('perkins-report.delivery-incomplete.md');
    const event = ledger.listEvents({ limit: 200 }).find((entry) => entry.kind === 'round.perkins-incomplete');
    expect((event?.payload as { readonly reportFile?: string }).reportFile).toBe(outcome.reportFile);
    expect((event?.payload as { readonly hostReportWriteFailed?: string }).hostReportWriteFailed).toBeTruthy();
    expect(escalations.some((entry) => entry.includes('could NOT be written') && entry.includes('perkins-report.delivery-incomplete.md'))).toBe(true);
    expect(existsSync(join(artifacts, outcome.round.id, 'perkins-report.md'))).toBe(true);
  });

  it('the ASYNC admission probe refuses a remote-only advance before any spawn (gh-169 R6-9)', async () => {
    const repo = makeFixtureRepo('perkins-remote-only-advance');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/remote-only-advance']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-roa-port-'));
    const origin = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '--quiet', origin], { stdio: 'ignore' });
    repo.git(['remote', 'add', 'origin', origin]);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/remote-only-advance']);
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-roa-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-roa-sessions-'));
    dirs.push(sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-roa-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/remote-only-advance', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-roa' });
    const job = ledger.addJob({ id: 'job-roa', repo: 'fixture', title: 'remote only advance', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/53');
    const underlying = makeSpawner(sessions, []);
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: (role, options) => underlying(role, options),
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/remote-only-advance'),
      reviewFreezeObserver: () => {
        // Advance the BARE advertised branch from a second clone at the
        // freeze boundary: the local tracking ref stays at the frozen tip,
        // so only the async advertised-tip proof can catch the movement.
        const clone = mkdtempSync(join(tmpdir(), 'perkins-roa-clone-'));
        execFileSync('git', ['clone', '--quiet', origin, clone], { stdio: 'ignore' });
        execFileSync('git', ['-C', clone, 'checkout', '--quiet', 'feature/remote-only-advance'], { stdio: 'ignore' });
        execFileSync('git', ['-C', clone, ...['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid'], 'commit', '--allow-empty', '-m', 'advance advertised tip'], { stdio: 'ignore' });
        execFileSync('git', ['-C', clone, 'push', '--quiet', 'origin', 'refs/heads/feature/remote-only-advance'], { stdio: 'ignore' });
      },
    });
    await expect(wave.runRound({ jobId: job.id })).rejects.toThrow(/head-binding.*advertised .*feature\/remote-only-advance/u);
    const round = ledger.listRounds(job.id)[0]!;
    expect(round.status).toBe('aborted');
    expect(ledger.listEvents({ limit: 100 }).some((event) => event.kind === 'round.review-no-spawn')).toBe(true);
    expect(ledger.listAgents().filter((agent) => agent.roundId === round.id)).toEqual([]);
  });

  it('publishes a frozen MISSING CI record distinctly in the posted body (gh-169 R6-10)', async () => {
    const repo = makeFixtureRepo('perkins-posted-missing-ci');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/posted-missing-ci']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-pmc-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-pmc-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-pmc-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-pmc-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/posted-missing-ci', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-pmc' });
    const job = ledger.addJob({ id: 'job-pmc', repo: 'fixture', title: 'posted missing ci', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    // A github.com PR with NO recorded CI observation: the frozen record is
    // an explicit UNAVAILABLE — published as MISSING, never FAILED.
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/54');
    attachOrigin(repo, 'feature/posted-missing-ci', root);
    const poster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const fake = fakeWholeSpawner(sessions, { childAnswer: () => '[]' });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      poster, prHeadProbe: localHeadProbe('feature/posted-missing-ci'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.verdict).toBe('approved');
    const postedBody = poster.post.mock.calls[0]?.[0]?.body as string;
    expect(postedBody).toContain('- CI evidence at freeze: UNAVAILABLE — NO BOUND CI RECEIPT (missing evidence, not a measured failure)');
    expect(postedBody).not.toContain('FAILED — NOT PASS');
    expect(postedBody).not.toContain('NOT RECORDED');
  });

  it('a settled a1 plus journaled-unsettled a2 on the SAME lens keeps both attempts in chip, report and outcome (gh-169 R6-11)', async () => {
    const repo = makeFixtureRepo('perkins-mixed-attempts');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/mixed-attempts']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-ma-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-ma-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-ma-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-ma-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/mixed-attempts', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-ma' });
    const job = ledger.addJob({ id: 'job-ma', repo: 'fixture', title: 'mixed attempts', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/55');
    attachOrigin(repo, 'feature/mixed-attempts', root);
    const escalations: string[] = [];
    const fake = fakeWholeSpawner(sessions, { specialists: ['security'], childAnswer: () => '[]', verdictOverride: 'INCOMPLETE' });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/mixed-attempts'),
      reviewFreezeObserver: (frozen) => {
        // Charge a SECOND attempt on the SAME lens the workflow will settle
        // as a1: a2 stays journaled-but-unsettled.
        ledger.appendCustomEvent({
          kind: 'round.specialist-started',
          jobId: job.id,
          roundId: roundIdOf(frozen.directory),
          payload: { lens: 'security', attempt: 2, originRoundId: roundIdOf(frozen.directory) },
        });
      },
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    // The chip keeps a1's settled truth AND discloses the unsettled retry.
    const securityChip = ledger.getRound(outcome.round.id)?.lenses.find((chip) => chip.lens === 'security');
    expect(securityChip?.state).toBe('done');
    expect(securityChip?.note).toContain('started but unsettled: a2');
    // The host INCOMPLETE report carries the attempt-granular facts.
    const hostReport = readFileSync(outcome.reportFile, 'utf8');
    expect(hostReport).toContain('2 journaled start(s); settled results: 1 (1 valid, 0 failed)');
    expect(hostReport).toContain('1 started-but-unsettled (security a2)');
    // The returned outcome keeps a1's settled truth AND discloses the
    // unsettled retry (never a bare not-used claim).
    const securityResult = outcome.results[(ledger.getRound(outcome.round.id)?.lenses ?? []).findIndex((chip) => chip.lens === 'security')];
    expect(securityResult?.state).toBe('done');
    expect(securityResult?.state === 'done' && securityResult.evidence).toContain('started but unsettled: a2');
  });

  it('a TRANSIENT second-chip failure lets the abort complete: one incident, consistent terminal state (gh-169 R6-12)', async () => {
    const repo = makeFixtureRepo('perkins-transient-chip-failure');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/transient-chip-failure']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-tcf-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-tcf-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-tcf-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-tcf-db-')));
    dbs.push(db);
    // Fail ONCE on the tests error-chip write: recordLensResults throws,
    // the abort's interrupted-error write succeeds on the retry.
    class TransientChipLedger extends LedgerApi {
      private failedOnce = false;
      override setLensOutcome(roundId: string, lens: string, state: string, note?: string): ReturnType<LedgerApi['setLensOutcome']> {
        if (lens === 'tests' && state === 'error' && !this.failedOnce) {
          this.failedOnce = true;
          throw new Error('transient chip-write failure');
        }
        return super.setLensOutcome(roundId, lens, state, note);
      }
    }
    const ledger = new TransientChipLedger(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/transient-chip-failure', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-tcf' });
    const job = ledger.addJob({ id: 'job-tcf', repo: 'fixture', title: 'transient chip failure', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/56');
    attachOrigin(repo, 'feature/transient-chip-failure', root);
    const fake = fakeWholeSpawner(sessions, {
      specialists: ['security', 'tests'],
      childAnswer: (prompt) => (/"source": "tests"/u.test(prompt) ? 'malformed output' : '[]'),
    });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/transient-chip-failure'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.round.status).toBe('aborted');
    const chips = ledger.getRound(outcome.round.id)?.lenses ?? [];
    expect(chips.find((chip) => chip.lens === 'security')?.state).toBe('done');
    expect(chips.find((chip) => chip.lens === 'tests')?.state).toBe('error');
    // The tests attempt settled (durable checkpoint) — truthful wording.
    expect(chips.find((chip) => chip.lens === 'tests')?.note).toContain('attempt settled (checkpoint recorded)');
    const incidents = ledger.listEvents({ limit: 200 }).filter((event) => event.kind === 'round.parent-incident');
    expect(incidents).toHaveLength(1);
  });

  it('a post-verdict event-write failure never reclassifies the committed verdict (gh-169 R7-1)', async () => {
    const repo = makeFixtureRepo('perkins-event-write-failure');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/event-write-failure']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-ewf-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-ewf-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-ewf-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-ewf-db-')));
    dbs.push(db);
    let reviewEventFailures = 0;
    class ReviewEventExplodingLedger extends LedgerApi {
      override appendCustomEvent(fields: Parameters<LedgerApi['appendCustomEvent']>[0]): ReturnType<LedgerApi['appendCustomEvent']> {
        // R8-1: the failure is TRANSIENT — the committed-verdict path's
        // idempotent retry heals the missing complete-review event.
        if (fields.kind === 'round.perkins-review') {
          reviewEventFailures += 1;
          if (reviewEventFailures === 1) throw new Error('simulated review-event write failure');
        }
        return super.appendCustomEvent(fields);
      }
    }
    const ledger = new ReviewEventExplodingLedger(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/event-write-failure', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-ewf' });
    const job = ledger.addJob({ id: 'job-ewf', repo: 'fixture', title: 'event write failure', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/57');
    attachOrigin(repo, 'feature/event-write-failure', root);
    const escalations: string[] = [];
    const fake = fakeWholeSpawner(sessions, { specialists: ['security'], childAnswer: () => '[]' });
    const poster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      poster, prHeadProbe: localHeadProbe('feature/event-write-failure'),
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    // The verdict and chips committed atomically; the later event write
    // failed and was NOT reclassified — no INCOMPLETE, no parent incident.
    expect(outcome.verdict).toBe('approved');
    expect(outcome.round.status).toBe('verdict-posted');
    expect(outcome.round.verdict).toBe('approved');
    const chips = ledger.getRound(outcome.round.id)?.lenses ?? [];
    expect(chips.find((chip) => chip.lens === 'security')?.state).toBe('done');
    for (const chip of chips.filter((entry) => entry.lens !== 'security')) {
      expect(chip.state, chip.lens).toBe('done');
    }
    expect(ledger.listEvents({ limit: 200 }).some((event) => event.kind === 'round.parent-incident')).toBe(false);
    expect(escalations.some((entry) => entry.includes('after its verdict committed'))).toBe(true);
    // R8-1: the reconciled complete-review event WAS persisted by the
    // retry — the posted predecessor's history survives for the next lead.
    const reconciled = ledger.listEvents({ limit: 200 }).find((event) => event.kind === 'round.perkins-review');
    expect(reconciled?.payload).toMatchObject({ complete: true, reconciledAfterFinalizationFailure: expect.stringContaining('review-event write failure') });
  });

  it('a failed round.perkins-incomplete event write never reclassifies the lead INCOMPLETE as a parent failure (gh-169 R7-2)', async () => {
    const repo = makeFixtureRepo('perkins-incomplete-event-failure');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/incomplete-event-failure']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-ief-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-ief-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-ief-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-ief-db-')));
    dbs.push(db);
    class IncompleteEventExplodingLedger extends LedgerApi {
      override appendCustomEvent(fields: Parameters<LedgerApi['appendCustomEvent']>[0]): ReturnType<LedgerApi['appendCustomEvent']> {
        if (fields.kind === 'round.perkins-incomplete') throw new Error('simulated incomplete-event write failure');
        return super.appendCustomEvent(fields);
      }
    }
    const ledger = new IncompleteEventExplodingLedger(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/incomplete-event-failure', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-ief' });
    const job = ledger.addJob({ id: 'job-ief', repo: 'fixture', title: 'incomplete event failure', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/58');
    attachOrigin(repo, 'feature/incomplete-event-failure', root);
    const escalations: string[] = [];
    const fake = fakeWholeSpawner(sessions, { childAnswer: () => '[]', verdictOverride: 'INCOMPLETE' });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/incomplete-event-failure'),
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.round.status).toBe('aborted');
    // The lead's classification stands; the failed EVENT write is
    // disclosed — and no parent incident is minted for it.
    expect(ledger.listEvents({ limit: 200 }).some((event) => event.kind === 'round.parent-incident')).toBe(false);
    expect(escalations.some((entry) => entry.includes('could not be persisted'))).toBe(true);
    expect(existsSync(join(artifacts, outcome.round.id, 'perkins-report.host-incomplete.md'))).toBe(true);
  });

  it('requires a valid independent freeze receipt before trusting the manifest bytes (gh-169 R7-4)', async () => {
    const repo = makeFixtureRepo('perkins-missing-receipt');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/missing-receipt']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-mr-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-mr-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-mr-sessions-'));
    dirs.push(sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-mr-db-')));
    dbs.push(db);
    class ReceiptSuppressingLedger extends LedgerApi {
      private suppressed?: unknown;
      override appendCustomEvent(fields: Parameters<LedgerApi['appendCustomEvent']>[0]): ReturnType<LedgerApi['appendCustomEvent']> {
        // The receipt write SILENTLY vanishes (a torn/lost write): the
        // preflight must refuse by name rather than skip the byte proof.
        if (fields.kind === 'round.freeze-manifest') {
          this.suppressed = fields;
          return super.appendCustomEvent({ ...fields, kind: 'round.freeze-manifest-lost' });
        }
        return super.appendCustomEvent(fields);
      }
    }
    const ledger = new ReceiptSuppressingLedger(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/missing-receipt', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-mr' });
    const job = ledger.addJob({ id: 'job-mr', repo: 'fixture', title: 'missing receipt', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/59');
    attachOrigin(repo, 'feature/missing-receipt', root);
    const underlying = makeSpawner(sessions, []);
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: (role, options) => underlying(role, options),
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/missing-receipt'),
    });
    // No independent receipt: the byte proof is REQUIRED, so admission
    // refuses under the manifest's own name instead of silently skipping.
    await expect(wave.runRound({ jobId: job.id })).rejects.toThrow(/freeze receipt \(round\.freeze-manifest\) is missing, malformed or conflicting/u);
  });

  it('selects the newest verification run THAT BINDS the target — a newer other-sha run never erases it (gh-169 R7-5)', async () => {
    const repo = makeFixtureRepo('perkins-binding-verification');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/binding-verification']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-bv-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-bv-artifacts-'));
    dirs.push(root, artifacts);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-bv-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/binding-verification', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-bv' });
    const job = ledger.addJob({ id: 'job-bv', repo: 'fixture', title: 'binding verification', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/60');
    attachOrigin(repo, 'feature/binding-verification', root);
    // An OLDER completed run that BINDS the target (PASS), then a NEWER
    // completed run for a DIFFERENT sha — the binding run must win.
    ledger.appendCustomEvent({
      kind: 'verification.completed',
      jobId: job.id,
      payload: {
        sha: target, scope: 'full', command: 'npm test', ok: true, exit_code: 0,
        duration_ms: 1000, workers: 2, run_id: 'run-bind-1', output_bytes: 4096,
        output_sha256: createHash('sha256').update('bind').digest('hex'),
      },
    });
    ledger.appendCustomEvent({
      kind: 'verification.completed',
      jobId: job.id,
      payload: {
        sha: 'f'.repeat(40), scope: 'full', command: 'npm test', ok: true, exit_code: 0,
        duration_ms: 900, workers: 2, run_id: 'run-other-1', output_bytes: 2048,
        output_sha256: createHash('sha256').update('other').digest('hex'),
      },
    });
    const underlying = makeSpawner(mkdtempSync(join(tmpdir(), 'perkins-bv-sessions-')), []);
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: (role, options) => underlying(role, options),
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/binding-verification'),
    });
    await expect(wave.runRound({ jobId: job.id })).resolves.toBeTruthy();
    const round = ledger.listRounds(job.id)[0]!;
    const frozenSpec = readFileSync(join(artifacts, round.id, 'spec-context.md'), 'utf8');
    expect(frozenSpec).toContain('result: PASS (exit 0)');
    expect(frozenSpec).toContain('run_id: run-bind-1');
    expect(frozenSpec).not.toContain('NO BOUND VERIFICATION RUN');
  });

  it('names every charged unsettled attempt when no result settled (gh-169 R7-6)', async () => {
    const repo = makeFixtureRepo('perkins-two-charged');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/two-charged']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-tc-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-tc-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-tc-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-tc-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/two-charged', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-tc2' });
    const job = ledger.addJob({ id: 'job-tc2', repo: 'fixture', title: 'two charged', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/61');
    attachOrigin(repo, 'feature/two-charged', root);
    const poster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const fake = fakeWholeSpawner(sessions, { specialists: ['security'], childAnswer: () => '[]' });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      poster, prHeadProbe: localHeadProbe('feature/two-charged'),
      reviewFreezeObserver: (frozen) => {
        // TWO charged starts on a lens that never settles.
        for (const attempt of [1, 2] as const) {
          ledger.appendCustomEvent({
            kind: 'round.specialist-started',
            jobId: job.id,
            roundId: roundIdOf(frozen.directory),
            payload: { lens: 'edge', attempt, originRoundId: roundIdOf(frozen.directory) },
          });
        }
      },
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    const edgeChip = ledger.getRound(outcome.round.id)?.lenses.find((chip) => chip.lens === 'edge');
    expect(edgeChip?.state).toBe('error');
    expect(edgeChip?.note).toContain('attempt(s) started but unsettled: a1, a2');
  });

  it('finds the binding verification run past 200 unrelated job events (gh-169 R8-2)', async () => {
    const repo = makeFixtureRepo('perkins-busy-verification-window');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/busy-verification-window']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-bvw-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-bvw-artifacts-'));
    dirs.push(root, artifacts);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-bvw-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/busy-verification-window', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-bvw' });
    const job = ledger.addJob({ id: 'job-bvw', repo: 'fixture', title: 'busy verification window', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/62');
    attachOrigin(repo, 'feature/busy-verification-window', root);
    // A binding completed run, then MORE THAN 200 unrelated job events —
    // a generic all-kind window would truncate the binding run away.
    ledger.appendCustomEvent({
      kind: 'verification.completed',
      jobId: job.id,
      payload: {
        sha: target, scope: 'full', command: 'npm test', ok: true, exit_code: 0,
        duration_ms: 1000, workers: 2, run_id: 'run-bvw-1', output_bytes: 4096,
        output_sha256: createHash('sha256').update('bvw').digest('hex'),
      },
    });
    for (let index = 0; index < 205; index += 1) {
      ledger.appendCustomEvent({ kind: 'job.note', jobId: job.id, payload: { note: `noise ${index}` } });
    }
    const underlying = makeSpawner(mkdtempSync(join(tmpdir(), 'perkins-bvw-sessions-')), []);
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: (role, options) => underlying(role, options),
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/busy-verification-window'),
    });
    await expect(wave.runRound({ jobId: job.id })).resolves.toBeTruthy();
    const round = ledger.listRounds(job.id)[0]!;
    const frozenSpec = readFileSync(join(artifacts, round.id, 'spec-context.md'), 'utf8');
    expect(frozenSpec).toContain('result: PASS (exit 0)');
    expect(frozenSpec).toContain('run_id: run-bvw-1');
    expect(frozenSpec).not.toContain('NO BOUND VERIFICATION RUN');
  });

  it('reviews a job with 208 completed verification runs: the newest binding run freezes without a lifetime-window exception (j-1594)', async () => {
    const lane = await verificationHistoryLane('job-lh-208', 'perkins-long-history-208', 70);
    const { ledger, job, target } = lane;
    // 207 completed runs for OTHER shas, then the binding run as the NEWEST.
    // The old lifetime ceiling threw on the total before any search happened.
    for (let index = 0; index < 207; index += 1) {
      ledger.appendCustomEvent({
        kind: 'verification.completed', jobId: job.id,
        payload: completedRunPayload('f'.repeat(40), `run-noise-${index}`),
      });
    }
    ledger.appendCustomEvent({
      kind: 'verification.completed', jobId: job.id,
      payload: completedRunPayload(target, 'run-binding-newest'),
    });
    // Another job's completed history is kind/job-scoped noise here.
    for (let index = 0; index < 210; index += 1) {
      ledger.appendCustomEvent({
        kind: 'verification.completed', jobId: 'job-other',
        payload: completedRunPayload(target, `run-other-${index}`),
      });
    }
    expect(ledger.listJobEventsByKinds(job.id, ['verification.completed'], { limit: 1000 })).toHaveLength(208);
    // BEFORE: every persisted verification row of BOTH jobs (the reviewed
    // lane and the other job's unrelated history).
    const verificationBefore = persistedVerificationRows(ledger, [job.id, 'job-other']);
    const wave = waveFor(lane);
    await expect(wave.runRound({ jobId: job.id })).resolves.toBeTruthy();
    // AFTER: host selection is read-only — the complete persisted history of
    // both jobs is identical row-for-row (same seqs, order, payloads and
    // outcomes). An added, deleted or rewritten receipt (including an OLDER
    // one) fails here, while ordinary round/status bookkeeping — different
    // event kinds — cannot mask it.
    expect(persistedVerificationRows(ledger, [job.id, 'job-other'])).toEqual(verificationBefore);
    const round = ledger.listRounds(job.id)[0]!;
    const frozenSpec = readFileSync(join(lane.artifacts, round.id, 'spec-context.md'), 'utf8');
    expect(frozenSpec).toContain('result: PASS (exit 0)');
    expect(frozenSpec).toContain('run_id: run-binding-newest');
    expect(frozenSpec).not.toContain('NO BOUND VERIFICATION RUN');
    // Exactly ONE verification section, and the round really bound the
    // target — not a vacuous "the exception text is absent" check.
    expect(frozenSpec.match(/--- HOST-RECORDED VERIFICATION \(ledger-backed/gu)).toHaveLength(1);
    expect(round.targetRef).toBe(target);
  });

  it('finds a binding run behind more than 200 newer nonqualifying completed runs (j-1594)', async () => {
    const lane = await verificationHistoryLane('job-lh-old', 'perkins-long-history-old', 71);
    const { ledger, job, target } = lane;
    // The binding run is the OLDEST; the newest-first scan must page past the
    // first page (200 rows) of newer other-sha runs to reach it.
    ledger.appendCustomEvent({
      kind: 'verification.completed', jobId: job.id,
      payload: completedRunPayload(target, 'run-binding-old'),
    });
    for (let index = 0; index < 205; index += 1) {
      ledger.appendCustomEvent({
        kind: 'verification.completed', jobId: job.id,
        payload: completedRunPayload('e'.repeat(40), `run-newer-${index}`),
      });
    }
    const verificationBefore = persistedVerificationRows(ledger, [job.id]);
    const wave = waveFor(lane);
    await expect(wave.runRound({ jobId: job.id })).resolves.toBeTruthy();
    // Paging past two pages to the oldest row rewrote nothing.
    expect(persistedVerificationRows(ledger, [job.id])).toEqual(verificationBefore);
    const round = ledger.listRounds(job.id)[0]!;
    const frozenSpec = readFileSync(join(lane.artifacts, round.id, 'spec-context.md'), 'utf8');
    expect(frozenSpec).toContain('run_id: run-binding-old');
    expect(frozenSpec).not.toContain('NO BOUND VERIFICATION RUN');
  });

  it('renders the explicit UNAVAILABLE section only after a complete long-history selection finds no binding run (j-1594)', async () => {
    const lane = await verificationHistoryLane('job-lh-none', 'perkins-long-history-none', 72);
    const { ledger, job } = lane;
    for (let index = 0; index < 205; index += 1) {
      ledger.appendCustomEvent({
        kind: 'verification.completed', jobId: job.id,
        payload: completedRunPayload('d'.repeat(40), `run-absent-${index}`),
      });
    }
    // A second job's unrelated completed history must survive an exhausted
    // absence proof untouched, too.
    for (let index = 0; index < 3; index += 1) {
      ledger.appendCustomEvent({
        kind: 'verification.completed', jobId: 'job-other-absent',
        payload: completedRunPayload('c'.repeat(40), `run-absent-other-${index}`),
      });
    }
    const verificationBefore = persistedVerificationRows(ledger, [job.id, 'job-other-absent']);
    const wave = waveFor(lane);
    await expect(wave.runRound({ jobId: job.id })).resolves.toBeTruthy();
    // Exhausted absence is still read-only: no record was added to fill the
    // gap, none deleted to shorten the search, none rewritten to look absent.
    expect(persistedVerificationRows(ledger, [job.id, 'job-other-absent'])).toEqual(verificationBefore);
    const round = ledger.listRounds(job.id)[0]!;
    const frozenSpec = readFileSync(join(lane.artifacts, round.id, 'spec-context.md'), 'utf8');
    expect(frozenSpec).toContain('state: UNAVAILABLE — NO BOUND VERIFICATION RUN');
    expect(frozenSpec).not.toContain('result: PASS');
  });

  it('a verification-history read failure during iteration aborts the freeze loudly and never fabricates absence or a pass (j-1594)', async () => {
    const lane = await verificationHistoryLane('job-lh-fail', 'perkins-long-history-fail', 73);
    const { ledger, job, target } = lane;
    ledger.appendCustomEvent({
      kind: 'verification.completed', jobId: job.id,
      payload: completedRunPayload(target, 'run-binding-ok'),
    });
    // The real read is a generator: it cannot fail at the call expression —
    // a storage failure surfaces while the selector iterates. Yield one
    // non-binding run, then fail on the next pull.
    const noise = ledger.appendCustomEvent({
      kind: 'verification.completed', jobId: job.id,
      payload: completedRunPayload('f'.repeat(40), 'run-noise-before-failure'),
    });
    vi.spyOn(ledger, 'iterateJobVerificationCompleted').mockImplementation(function* failingRead() {
      yield noise;
      throw new Error('simulated mid-iteration verification-history read failure');
    });
    const wave = waveFor(lane);
    await expect(wave.runRound({ jobId: job.id })).rejects.toThrow(/simulated mid-iteration verification-history read failure/u);
    const round = ledger.listRounds(job.id)[0]!;
    expect(round.status).toBe('aborted');
    // Round-scoped receipt read — never a global newest-N window.
    expect(ledger.latestRoundEvent(round.id, 'round.review-no-spawn')).not.toBeNull();
    expect(ledger.listAgents().filter((agent) => agent.roundId === round.id)).toEqual([]);
    expect(ledger.latestJobEvent(job.id, 'round.verdict')).toBeNull();
  });

  it('freezes a baseline-red binding run as its honest recorded FAIL with its scope, never relabeled PASS (j-1594)', async () => {
    const lane = await verificationHistoryLane('job-lh-red', 'perkins-long-history-red', 74);
    const { ledger, job, target } = lane;
    ledger.appendCustomEvent({
      kind: 'verification.completed', jobId: job.id,
      payload: completedRunPayload(target, 'run-red', { ok: false, exit_code: 1, scope: 'fast' }),
    });
    for (let index = 0; index < 203; index += 1) {
      ledger.appendCustomEvent({
        kind: 'verification.completed', jobId: job.id,
        payload: completedRunPayload('c'.repeat(40), `run-red-noise-${index}`),
      });
    }
    const wave = waveFor(lane);
    await expect(wave.runRound({ jobId: job.id })).resolves.toBeTruthy();
    const round = ledger.listRounds(job.id)[0]!;
    const frozenSpec = readFileSync(join(lane.artifacts, round.id, 'spec-context.md'), 'utf8');
    expect(frozenSpec).toContain('run_id: run-red');
    expect(frozenSpec).toContain('result: FAIL (exit 1)');
    expect(frozenSpec).toContain('scope: fast');
    expect(frozenSpec).not.toContain('NO BOUND VERIFICATION RUN');
  });

  it('refuses admission on a conflicting duplicate freeze receipt (gh-169 R8-3)', async () => {
    const repo = makeFixtureRepo('perkins-duplicate-receipt');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/duplicate-receipt']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-dr-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-dr-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-dr-sessions-'));
    dirs.push(sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-dr-db-')));
    dbs.push(db);
    class ReceiptDuplicatingLedger extends LedgerApi {
      override appendCustomEvent(fields: Parameters<LedgerApi['appendCustomEvent']>[0]): ReturnType<LedgerApi['appendCustomEvent']> {
        // The receipt write DUPLICATES with a conflicting hash — the
        // unique-receipt check must refuse rather than trust either.
        if (fields.kind === 'round.freeze-manifest') {
          const first = super.appendCustomEvent(fields);
          super.appendCustomEvent({ ...fields, payload: { sha256: 'c'.repeat(64) } });
          return first;
        }
        return super.appendCustomEvent(fields);
      }
    }
    const ledger = new ReceiptDuplicatingLedger(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/duplicate-receipt', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-dr' });
    const job = ledger.addJob({ id: 'job-dr', repo: 'fixture', title: 'duplicate receipt', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/63');
    attachOrigin(repo, 'feature/duplicate-receipt', root);
    const underlying = makeSpawner(sessions, []);
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: (role, options) => underlying(role, options),
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/duplicate-receipt'),
    });
    await expect(wave.runRound({ jobId: job.id })).rejects.toThrow(/missing, malformed or conflicting \(duplicate receipts\)/u);
  });

  it('a started child with a durable settlement event is never called unsettled (gh-169 R8-4)', async () => {
    const repo = makeFixtureRepo('perkins-settled-checkpoint-abort');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/settled-checkpoint-abort']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-sca-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-sca-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-sca-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-sca-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/settled-checkpoint-abort', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-sca' });
    const job = ledger.addJob({ id: 'job-sca', repo: 'fixture', title: 'settled checkpoint abort', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/64');
    attachOrigin(repo, 'feature/settled-checkpoint-abort', root);
    const fake = fakeWholeSpawner(sessions, { specialists: ['security'], childAnswer: () => '[]', neverSubmit: true });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/settled-checkpoint-abort'),
      reviewFreezeObserver: (frozen) => {
        // A charged start AND a durable settlement checkpoint for a lens
        // whose collected result never reached the aborted round.
        const roundId = roundIdOf(frozen.directory);
        ledger.appendCustomEvent({
          kind: 'round.specialist-started', jobId: job.id, roundId,
          payload: { lens: 'edge', attempt: 1, originRoundId: roundId },
        });
        ledger.appendCustomEvent({
          kind: 'round.specialist-settled', jobId: job.id, roundId,
          payload: { lens: 'edge', attempt: 1, sha256: 'a'.repeat(64) },
        });
      },
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    const edgeChip = ledger.getRound(outcome.round.id)?.lenses.find((chip) => chip.lens === 'edge');
    expect(edgeChip?.state).toBe('error');
    expect(edgeChip?.note).toContain('attempt settled (checkpoint recorded)');
    expect(edgeChip?.note).not.toContain('before settlement');
    const edgeResult = outcome.results[(ledger.getRound(outcome.round.id)?.lenses ?? []).findIndex((chip) => chip.lens === 'edge')];
    expect(edgeResult?.state === 'error' && edgeResult.note).toContain('attempt settled (checkpoint recorded)');
  });

  it('records ONE parent incident and zero executed specialist failures when the lead transport dies before any child (gh-169)', async () => {
    const repo = makeFixtureRepo('perkins-lead-connection-error');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/lead-connection-error']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-lead-conn-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-lead-conn-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-lead-conn-sessions-'));
    dirs.push(sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-lead-conn-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/lead-connection-error', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-lead-conn' });
    const job = ledger.addJob({ id: 'job-lead-conn', repo: 'fixture', title: 'lead connection error', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/41');
    attachOrigin(repo, 'feature/lead-connection-error', root);
    let spawned = 0;
    const spawner: AgentSpawner = async (_role, _options = {}) => {
      spawned += 1;
      const sessionFile = join(sessions, `conn-lead-${spawned}.jsonl`);
      writeFileSync(sessionFile, '', 'utf8');
      return {
        role: 'perkins', id: `conn-lead-${spawned}`, sessionFile, reviewIsolation: true,
        capabilities: {
          streaming: true, steer: 'native', resume: 'file', images: false,
          thinking: false, thinkingLevelControl: false, followUp: false,
        },
        // The lead transport dies on its FIRST turn — before any specialist
        // child exists. This is the display evidence that motivated gh-169.
        async prompt() { throw new Error('Connection error'); },
        async steer() {}, async followUp() {}, subscribe() { return () => {}; },
        health() { return { state: 'streaming', lastActivity: null, sessionFile }; },
        async dispose() {},
      };
    };
    const escalations: string[] = [];
    const packetHashes = new Map<string, string>();
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/lead-connection-error'),
      reviewFreezeObserver: (frozen) => {
        // Q10: pin every frozen packet byte at the freeze boundary; the
        // assertions after the abort prove admission/abort/recovery never
        // mutated the frozen review.
        for (const name of ['manifest.json', 'diff.patch', 'spec-context.md', 'project-conventions.md', 'changed-files.json']) {
          packetHashes.set(name, createHash('sha256').update(readFileSync(join(frozen.directory, name))).digest('hex'));
        }
      },
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.round.status).toBe('aborted');
    // Only the lead ever spawned: zero specialist children existed.
    expect(spawned).toBe(1);
    // Counter truth: every lens stays pending (not started) — the round is
    // ONE parent incident, not a nine-chip slate of failed specialists.
    const chips = ledger.getRound(outcome.round.id)?.lenses ?? [];
    expect(chips).toHaveLength(9);
    expect(chips.every((chip) => chip.state === 'pending')).toBe(true);
    const incidents = ledger.listEvents({ limit: 300 }).filter((event) => event.kind === 'round.parent-incident');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.payload).toMatchObject({ startedAttempts: 0, startedLenses: [] });
    expect((incidents[0]?.payload as { readonly notStartedLenses?: readonly string[] }).notStartedLenses).toHaveLength(9);
    // The wave outcome and the durable report carry the same honesty: no
    // lens is a failed execution; the report states the execution facts.
    expect(outcome.results.every((result) => result.state === 'error' && result.note.startsWith('not started — parent incident'))).toBe(true);
    const report = readFileSync(join(artifacts, outcome.round.id, 'perkins-report.md'), 'utf8');
    expect(report).toContain('**Parent incident**');
    expect(report).toContain('0 journaled attempt(s) started');
    expect(report).toContain('9 lens(es) never started');
    expect(report).toContain('Connection error');
    expect(escalations.some((entry) => entry.includes('INCOMPLETE') && entry.includes('0 journaled attempt(s) started'))).toBe(true);
    // Q10: the frozen packet is byte-identical after admission, the lead
    // run, the parent abort and the sweep.
    for (const [name, digest] of packetHashes) {
      expect(createHash('sha256').update(readFileSync(join(artifacts, outcome.round.id, name))).digest('hex'), name).toBe(digest);
    }
    expect(port.getWorktree(outcome.round.id)?.status).toBe('swept');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });

  it('keeps a started lens an honest error while never-started lenses stay pending when the parent aborts after one child (gh-169)', async () => {
    const repo = makeFixtureRepo('perkins-parent-after-child');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/parent-after-child']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-pac-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-pac-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-pac-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-pac-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/parent-after-child', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-pac' });
    const job = ledger.addJob({ id: 'job-pac', repo: 'fixture', title: 'parent after child', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/42');
    attachOrigin(repo, 'feature/parent-after-child', root);
    // One security specialist completes its run (a charged, journaled
    // start); the lead then never submits, so the round dies as a parent
    // failure AFTER real child work existed.
    const fake = fakeWholeSpawner(sessions, {
      specialists: ['security'],
      childAnswer: () => '[]',
      neverSubmit: true,
    });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/parent-after-child'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.round.status).toBe('aborted');
    const chips = ledger.getRound(outcome.round.id)?.lenses ?? [];
    const security = chips.find((chip) => chip.lens === 'security');
    expect(security?.state).toBe('error');
    // The security attempt SETTLED (its checkpoint is durable) — truthful
    // settlement-aware wording rather than a claim of no settlement.
    expect(security?.note).toContain('attempt settled (checkpoint recorded)');
    // Every other lens never started: pending, not error.
    for (const chip of chips.filter((entry) => entry.lens !== 'security')) {
      expect(chip.state, chip.lens).toBe('pending');
    }
    const incident = ledger.listEvents({ limit: 300 }).find((event) => event.kind === 'round.parent-incident');
    expect(incident?.payload).toMatchObject({ startedAttempts: 1, startedLenses: ['security'] });
    // The started lens maps to an interrupted-execution error; the rest are
    // not-started parent-incident outcomes.
    const securityResult = outcome.results[chips.findIndex((chip) => chip.lens === 'security')];
    expect(securityResult?.state).toBe('error');
    expect(securityResult?.state === 'error' && securityResult.note).toContain('attempt settled (checkpoint recorded)');
    expect(outcome.results.filter((result) => result.state === 'error' && result.note.startsWith('not started — parent incident'))).toHaveLength(8);
    const report = readFileSync(join(artifacts, outcome.round.id, 'perkins-report.md'), 'utf8');
    expect(report).toContain('1 journaled attempt(s) started (1 of 9 lenses: security)');
    expect(report).toContain('8 lens(es) never started');
  });

  it('reconciles an interrupted live round as durable INCOMPLETE before startup continues', async () => {
    const repo = makeFixtureRepo('perkins-wave-restart');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/restart']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-restart-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-restart-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-restart-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/restart', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-restart' });
    const job = ledger.addJob({ id: 'job-restart', repo: 'fixture', title: 'restart', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'in-review');
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind', 'security'], targetRef: target });
    await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    ledger.setRoundStatus(round.id, 'live');
    ledger.markLensLive(round.id, 'blind');
    const escalations: string[] = [];
    const escalationContexts: (EscalationContext | undefined)[] = [];
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: artifacts,
      escalate: (title, _detail, context) => {
        escalations.push(title);
        escalationContexts.push(context);
      },
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(round.id)?.status).toBe('aborted');
    // gh-169 counter truth: the live lens (a started child) records an
    // honest execution error; the never-started lens stays pending — one
    // parent incident is not a two-chip slate of failed specialists. The
    // single round.parent-incident event carries the started/not-started
    // facts (startedAttempts 0 here: no specialist start was journaled,
    // only the chip went live).
    const chips = ledger.getRound(round.id)?.lenses ?? [];
    expect(chips.find((chip) => chip.lens === 'blind')?.state).toBe('error');
    expect(chips.find((chip) => chip.lens === 'blind')?.note).toContain('interrupted by parent abort');
    expect(chips.find((chip) => chip.lens === 'security')?.state).toBe('pending');
    const incident = ledger.listEvents({ limit: 200 }).find((event) => event.kind === 'round.parent-incident' && event.roundId === round.id);
    // P5: the event's classification matches the chips — the LIVE lens is
    // started (its child registered; the journal write was lost to the
    // crash), the untouched lens is not started. startedAttempts counts
    // only durable journal entries (zero here).
    expect(incident?.payload).toMatchObject({ startedAttempts: 0, startedLenses: ['blind'] });
    expect((incident?.payload as { readonly notStartedLenses?: readonly string[] }).notStartedLenses)
      .toEqual(['security']);
    // P6: the durable restart report carries the same execution facts.
    const restartReport = readFileSync(join(artifacts, round.id, 'perkins-report.md'), 'utf8');
    expect(restartReport).toContain('**Parent incident**');
    expect(restartReport).toContain('0 journaled attempt(s) started (1 of 2 lenses: blind)');
    expect(restartReport).toContain('1 lens(es) never started (security)');
    expect(port.getWorktree(round.id)?.status).toBe('swept');
    expect(existsSync(join(artifacts, round.id, 'restart-recovery.json'))).toBe(true);
    expect(existsSync(join(artifacts, round.id, 'perkins-report.md'))).toBe(true);
    expect(escalations[0]).toContain('INCOMPLETE');
    // Producer context: the recovery escalation carries its validated
    // round/job identity for the notification binding (followup A4).
    expect(escalationContexts[0]).toEqual({ jobId: 'job-restart', roundId: round.id });
    // V1 chain: the REAL producer context above — not a handcrafted one —
    // flows through the notifier into a live row, and the lane
    // terminalizing reclassifies that emitted row as a closed receipt on
    // BOTH surfaces (the ledger's live chip count and the board's
    // terminal-bound set the bell renders from).
    ledger.registerAgent({ id: 'minion-restart-receipt', role: 'minion', jobId: job.id });
    const chainCenter = new NotificationCenter({ ledger, bus: new EventBus() });
    const liveBefore = ledger.countLivePendingActionRequired();
    const receiptsBefore = ledger.countPendingActionRequiredIncludingReceipts();
    createReviewEscalationNotifier(ledger, chainCenter)(
      'chain: Review round INCOMPLETE',
      'chain detail',
      escalationContexts[0],
    );
    const chainRow = ledger
      .listNotifications({ limit: 100 })
      .find((row) => row.kind === 'review-escalation' && row.title === 'chain: Review round INCOMPLETE');
    expect(chainRow?.agentId).toBe('minion-restart-receipt');
    expect(ledger.countLivePendingActionRequired()).toBe(liveBefore + 1);
    ledger.setJobStatus(job.id, 'merged');
    expect(ledger.countLivePendingActionRequired()).toBe(liveBefore);
    expect(ledger.countPendingActionRequiredIncludingReceipts()).toBe(receiptsBefore + 1);
    // The engine's server-side snapshot and the web's wire type are
    // separate namespaces: cross them the way the wire does — serialize,
    // validate with the web parser, then classify. A shape drift fails the
    // validator here instead of silently changing the board's truth.
    const wireValue: unknown = JSON.parse(JSON.stringify(new BoardEngine({ ledger, bus: new EventBus() }).snapshot()));
    expect(isValidSnapshot(wireValue)).toBe(true);
    expect(terminalBoundNotificationIds(wireValue as WireBoardSnapshot)).toContain(chainRow?.id);
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('reconciles a pending round when restart happened before review-lane registration', async () => {
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-missing-lane-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const job = ledger.addJob({ id: 'job-missing-lane', repo: 'fixture', title: 'missing lane', baseBranch: 'main', briefing: 'review' });
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind', 'security'], targetRef: 'abc123' });
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-missing-lane-artifacts-'));
    dirs.push(artifacts);
    const portRoot = mkdtempSync(join(tmpdir(), 'perkins-missing-lane-port-'));
    dirs.push(portRoot);
    const port = new GitReviewPort(portRoot, 'main', 'abc123');
    const wave = new WaveRunner({ ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner, reviewArtifactRoot: artifacts });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(round.id)?.status).toBe('aborted');
    // gh-169: a pending round with zero children aborts as ONE parent
    // incident — every lens stays pending (not-started), none is error.
    const abortedChips = ledger.getRound(round.id)?.lenses ?? [];
    expect(abortedChips.every((chip) => chip.state === 'pending')).toBe(true);
    const pendingIncident = ledger.listEvents({ limit: 200 }).find((event) => event.kind === 'round.parent-incident' && event.roundId === round.id);
    expect(pendingIncident?.payload).toMatchObject({ startedAttempts: 0, startedLenses: [] });
    // P6: the missing-lane restart report also states the execution facts
    // (zero started, every lens never started).
    const missingLaneReport = readFileSync(join(artifacts, round.id, 'perkins-report.md'), 'utf8');
    expect(missingLaneReport).toContain('**Parent incident**');
    expect(missingLaneReport).toContain('0 journaled attempt(s) started (0 of 2 lenses: none)');
    expect(missingLaneReport).toContain('2 lens(es) never started (blind, security)');
    expect(existsSync(join(artifacts, round.id, 'restart-recovery.json'))).toBe(true);
  });

  it('restart recovery with a charged specialist start keeps ONE parent incident and honest counts (gh-169 P6/P8)', async () => {
    const repo = makeFixtureRepo('perkins-restart-charged');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/restart-charged']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-charged-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-charged-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-charged-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/restart-charged', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-charged' });
    const job = ledger.addJob({ id: 'job-charged', repo: 'fixture', title: 'charged restart', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind', 'security'], targetRef: target });
    await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    ledger.setRoundStatus(round.id, 'live');
    // ONE durable specialist start existed when the service died (the
    // spawn crashed before any agent row or settlement existed).
    ledger.appendCustomEvent({
      kind: 'round.specialist-started',
      jobId: job.id,
      roundId: round.id,
      payload: { lens: 'blind', attempt: 1, originRoundId: round.id },
    });
    const wave = new WaveRunner({ ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner, reviewArtifactRoot: artifacts });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    // A second recovery pass over the now-terminal round mints nothing.
    expect(await wave.recoverInterruptedRounds()).toBe(0);
    const incidents = ledger.listEvents({ limit: 200 }).filter((event) => event.kind === 'round.parent-incident' && event.roundId === round.id);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.payload).toMatchObject({ startedAttempts: 1, startedLenses: ['blind'], notStartedLenses: ['security'] });
    const chips = ledger.getRound(round.id)?.lenses ?? [];
    expect(chips.find((chip) => chip.lens === 'blind')?.state).toBe('error');
    expect(chips.find((chip) => chip.lens === 'security')?.state).toBe('pending');
    // P6: the durable restart report carries the charged-start counts.
    const report = readFileSync(join(artifacts, round.id, 'perkins-report.md'), 'utf8');
    expect(report).toContain('1 journaled attempt(s) started (1 of 2 lenses: blind)');
    expect(report).toContain('1 lens(es) never started (security)');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('does not let a swept lane hide an interrupted pending round during recovery', async () => {
    const repo = makeFixtureRepo('perkins-wave-swept-pending');
    repos.push(repo);
    const target = repo.head();
    const root = mkdtempSync(join(tmpdir(), 'perkins-swept-pending-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-swept-pending-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-swept-pending-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-swept-pending' });
    const job = ledger.addJob({ id: 'job-swept-pending', repo: 'fixture', title: 'swept pending', baseBranch: 'main', briefing: 'review' });
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind'], targetRef: target });
    await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    await port.release({ worktreeId: round.id });
    const wave = new WaveRunner({ ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner, reviewArtifactRoot: artifacts });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(round.id)?.status).toBe('aborted');
    expect(existsSync(join(artifacts, round.id, 'restart-recovery.json'))).toBe(true);
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('sweeps a detached review lane left behind after its round was already terminalized', async () => {
    const repo = makeFixtureRepo('perkins-wave-terminal-cleanup');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/terminal-cleanup']);
    const target = repo.commitFile('src/main.ts', 'export const terminal = true;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-terminal-port-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-terminal-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/terminal-cleanup', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-terminal-cleanup' });
    const job = ledger.addJob({ id: 'job-terminal-cleanup', repo: 'fixture', title: 'terminal', baseBranch: 'main', briefing: 'review' });
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind'], targetRef: target });
    await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    ledger.setRoundStatus(round.id, 'aborted');
    const wave = new WaveRunner({ ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(round.id)?.status).toBe('aborted');
    expect(port.getWorktree(round.id)?.status).toBe('swept');
    rmSync(root, { recursive: true, force: true });
  });

  it('completes a delivered verdict after restart without reposting or marking it incomplete', async () => {
    const repo = makeFixtureRepo('perkins-wave-post-recovery');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/post-recovery']);
    const target = repo.commitFile('src/main.ts', 'export const delivered = true;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-post-recovery-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-post-recovery-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-post-recovery-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/post-recovery', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-post-recovery' });
    const job = ledger.addJob({ id: 'job-post-recovery', repo: 'fixture', title: 'post recovery', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'in-review');
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind'], targetRef: target });
    await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: target, jobId: job.id });
    ledger.setRoundStatus(round.id, 'live');
    ledger.markLensLive(round.id, 'blind');
    ledger.setLensOutcome(round.id, 'blind', 'done', 'delivered');
    // (a) A BARE legacy posted event (no provider-bound receipt) must NOT be
    // promoted to a delivered verdict by restart recovery.
    ledger.appendCustomEvent({
      kind: 'round.posted', jobId: job.id, roundId: round.id,
      payload: { verdict: 'changes-requested', canonicalVerdict: 'NEEDS CHANGES', url: 'https://example.invalid/pr/1' },
    });
    const poster = { post: vi.fn() };
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: artifacts, poster,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(round.id)).toMatchObject({ status: 'aborted', verdict: null });
    expect(ledger.latestRoundEvent(round.id, 'round.post-recovered')).toBeNull();
    expect(escalations.some((line) => line.includes('without a provider-bound receipt'))).toBe(true);
    expect(poster.post).not.toHaveBeenCalled();
    expect(port.getWorktree(round.id)?.status).toBe('swept');

    // (b) A receipt-bound event whose digest matches the preserved
    // publication artifact still completes without reposting.
    const repo2 = makeFixtureRepo('perkins-wave-post-recovery-bound');
    repos.push(repo2);
    repo2.git(['checkout', '-b', 'feature/post-recovery-bound']);
    const target2 = repo2.commitFile('src/main.ts', 'export function delivered = true;\n'.replace('function delivered =', 'const delivered ='));
    const root2 = mkdtempSync(join(tmpdir(), 'perkins-post-recovery-bound-port-'));
    const artifacts2 = mkdtempSync(join(tmpdir(), 'perkins-post-recovery-bound-artifacts-'));
    dirs.push(root2, artifacts2);
    const db2 = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-post-recovery-bound-db-')));
    dbs.push(db2);
    const ledger2 = new LedgerApi(db2.handle, { bus: new EventBus() });
    const port2 = new GitReviewPort(root2, 'feature/post-recovery-bound', target2);
    await port2.createJobWorktree({ repoPath: repo2.path, jobId: 'job-post-recovery-bound' });
    const job2 = ledger2.addJob({ id: 'job-post-recovery-bound', repo: 'fixture', title: 'bound recovery', baseBranch: 'main', briefing: 'review' });
    ledger2.setJobStatus(job2.id, 'working');
    ledger2.setJobStatus(job2.id, 'in-review');
    ledger2.setJobPr(job2.id, 'https://example.invalid/pr/1');
    const round2 = ledger2.addRound({ jobId: job2.id, lenses: ['blind'], targetRef: target2 });
    await port2.createReviewWorktree({ repoPath: repo2.path, roundId: round2.id, ref: target2, jobId: job2.id });
    ledger2.setRoundStatus(round2.id, 'live');
    const round2Directory = join(artifacts2, round2.id);
    mkdirSync(round2Directory, { recursive: true });
    const publicationFile = join(round2Directory, 'perkins-report.publication.md');
    const publicationBody = '# Perkins Code Review\n\n**Verdict: NEEDS CHANGES**\n';
    writeFileSync(publicationFile, publicationBody, 'utf8');
    const publicationSha256 = createHash('sha256').update(publicationBody, 'utf8').digest('hex');
    ledger2.appendCustomEvent({
      kind: 'round.posted', jobId: job2.id, roundId: round2.id,
      payload: {
        verdict: 'changes-requested', canonicalVerdict: 'NEEDS CHANGES', url: 'https://example.invalid/pr/1', host: 'example.invalid',
        targetSha: target2, baseSha: 'b'.repeat(40), publicationFile, publicationSha256, reconciled: false,
        receipt: { reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: target2, headSha: target2, baseSha: 'b'.repeat(40), bodySha256: publicationSha256 },
      },
    });
    const poster2 = { post: vi.fn(), authenticatedActor: async () => 'gru-bot' };
    const wave2 = new WaveRunner({
      ledger: ledger2, worktrees: port2, spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: artifacts2, poster: poster2,
    });
    expect(await wave2.recoverInterruptedRounds()).toBe(1);
    expect(ledger2.getRound(round2.id)).toMatchObject({ status: 'verdict-posted', verdict: 'changes-requested' });
    const recovered2 = ledger2.latestRoundEvent(round2.id, 'round.post-recovered')?.payload as { receipt?: { reviewId?: string } };
    expect(recovered2?.receipt?.reviewId).toBe('9001');
    expect(poster2.post).not.toHaveBeenCalled();
    expect(port2.getWorktree(round2.id)?.status).toBe('swept');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('terminalizes a workflow schema exception and preserves an INCOMPLETE report before sweep', async () => {
    const repo = makeFixtureRepo('perkins-wave-workflow-error');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/workflow-error']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-workflow-error-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-workflow-error-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-workflow-error-sessions-'));
    dirs.push(sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-workflow-error-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/workflow-error', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-workflow-error' });
    const job = ledger.addJob({ id: 'job-workflow-error', repo: 'fixture', title: 'workflow error', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const reviewModel = { role: 'perkins' as const, modelRef: 'default', settings: { model: 'native-model' }, authEnv: {} };
    const seen: { lead: boolean; sameSnapshot: boolean }[] = [];
    const underlying = makeSpawner(sessions, []);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/38');
    attachOrigin(repo, 'feature/workflow-error', root);
    const wave = new WaveRunner({
      ledger, worktrees: port, reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({ ok: true, failures: [], reviewModel }),
      poster: {
        post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
          reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
          headSha: call.targetSha, baseSha: 'b'.repeat(40),
          bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
        })),
      },
      prHeadProbe: localHeadProbe('feature/workflow-error'),
      spawner: (role, options) => {
        if (options?.reviewLead !== undefined || options?.isolatedReview !== undefined) {
          seen.push({ lead: options.reviewLead !== undefined, sameSnapshot: options.reviewModel === reviewModel });
        }
        return underlying(role, options);
      },
    });
    const first = asWave(await wave.runRound({ jobId: job.id }));
    expect(first.round.status).toBe('verdict-posted');
    expect(seen.some((entry) => entry.lead)).toBe(true);
    expect(seen.some((entry) => !entry.lead)).toBe(true);
    expect(seen.every((entry) => entry.sameSnapshot)).toBe(true);
    const priorFile = join(first.artifactDirectory!, 'consolidated.json');
    const prior = JSON.parse((await import('node:fs')).readFileSync(priorFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(priorFile, `${JSON.stringify({ ...prior, findings: [{}] }, null, 2)}\n`, 'utf8');

    const second = asWave(await wave.runRound({ jobId: job.id }));
    expect(second.canonicalVerdict).toBe('INCOMPLETE');
    expect(second.round.status).toBe('aborted');
    // Q4 (gh-169): the pre-spawn failure has a durable no-spawn receipt and
    // NO parent-incident event — its report must say setup refusal, not
    // claim the incident counter exists.
    const refusalReport = readFileSync(join(artifacts, second.round.id, 'perkins-report.md'), 'utf8');
    expect(refusalReport).toContain('**Setup refusal** — the round ended before any review owner spawned');
    expect(refusalReport).not.toContain('**Parent incident**');
    expect(ledger.listEvents({ limit: 200 }).some((event) => event.kind === 'round.parent-incident' && event.roundId === second.round.id)).toBe(false);
    const directory = join(artifacts, second.round.id);
    expect((await import('node:fs')).readFileSync(join(directory, 'perkins-report.md'), 'utf8')).toContain('INCOMPLETE');
    expect(existsSync(join(directory, 'workflow-error.json'))).toBe(true);
    expect(port.getWorktree(second.round.id)?.status).toBe('swept');
  });

  it('records an honest lens error when every specialist attempt fails, while the lead-owned review still completes', async () => {
    const repo = makeFixtureRepo('perkins-specialist-failed');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/specialist-failed']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-fail-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-fail-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-fail-sessions-'));
    dirs.push(sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-fail-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/specialist-failed', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-specialist-failed' });
    const job = ledger.addJob({
      id: 'job-specialist-failed', repo: 'fixture', title: 'specialist failed', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const escalations: string[] = [];
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/36');
    attachOrigin(repo, 'feature/specialist-failed', root);
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      // Only security and tests specialists run; the tests specialist
      // malforms both attempts while the lead's own review completes.
      spawner: fakeWholeSpawner(sessions, {
        childAnswer: (prompt) => (sourceFor(prompt) === 'tests' ? 'malformed' : sourceFor(prompt) === 'security'
          ? JSON.stringify([{
              source: 'security', severity: 'blocker', category: 'auth', title: 'Verified security defect',
              location: 'src/main.ts:2', evidence: '  return 43;', detail: 'The changed line demonstrates the security defect.',
              recommended_fix: 'Correct the implementation and add a regression test.',
            }])
          : '[]'),
        specialists: ['security', 'tests'],
      }).spawner,
      reviewArtifactRoot: artifacts,
      poster: {
        post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
          reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
          headSha: call.targetSha, baseSha: 'b'.repeat(40),
          bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
        })),
      },
      prHeadProbe: localHeadProbe('feature/specialist-failed'),
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    // The failed specialist is an execution fact, never a missing reviewer:
    // the round still reaches the lead's honest conclusive verdict.
    expect(outcome.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(outcome.round.status).toBe('verdict-posted');
    const testsChip = outcome.round.lenses.find((chip) => chip.lens === 'tests');
    expect(testsChip?.state).toBe('error');
    expect(testsChip?.note).toContain('specialist attempts failed');
    const securityChip = outcome.round.lenses.find((chip) => chip.lens === 'security');
    expect(securityChip?.state).toBe('done');
    expect(securityChip?.note).toContain('blocker');
    for (const lens of ['blind', 'edge', 'acceptance', 'architecture', 'codebase', 'performance', 'operations']) {
      const unusedChip = outcome.round.lenses.find((chip) => chip.lens === lens);
      expect(unusedChip?.state, lens).toBe('done');
      expect(unusedChip?.note, lens).toContain('not used');
    }
    expect(escalations).toEqual([]);
    expect(port.getWorktree(outcome.round.id)?.status).toBe('swept');
    for (const directory of [root, artifacts, sessions]) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('audits the last complete predecessor across an incomplete middle round', async () => {
    const repo = makeFixtureRepo('perkins-wave-prior-continuity');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/prior-continuity']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-prior-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-prior-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-prior-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/prior-continuity', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-prior-continuity' });
    const job = ledger.addJob({
      id: 'job-prior-continuity', repo: 'fixture', title: 'prior continuity', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);

    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/37');
    attachOrigin(repo, 'feature/prior-continuity', root);
    const receiptPoster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const firstSessions = mkdtempSync(join(tmpdir(), 'perkins-prior-first-'));
    const first = asWave(await new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(firstSessions, []), poster: receiptPoster,
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/prior-continuity'),
    }).runRound({ jobId: job.id }));
    expect(first.canonicalVerdict).toBe('NEEDS CHANGES');

    const secondSessions = mkdtempSync(join(tmpdir(), 'perkins-prior-second-'));
    const recoveryPreflight = async () => ({
      ok: true as const, failures: [],
      reviewModel: { role: 'perkins' as const, modelRef: 'fixture-model-v1', settings: {}, authEnv: {}, routingSha256: "fixture-safe-route" },
    });
    const recoveryRuntime = () => ({ id: 'pi', version: 'test-runtime-v1' });
    const second = asWave(await new WaveRunner({
      reviewPreflight: recoveryPreflight, reviewRuntimeIdentity: recoveryRuntime,
      ledger,
      worktrees: port,
      // The middle round's lead stops without submitting: an honest
      // INCOMPLETE that leaves no complete consolidated record behind.
      spawner: fakeWholeSpawner(secondSessions, {
        childAnswer: () => '[]', specialists: ['blind', 'edge'],
        neverSubmit: true,
      }).spawner,
      poster: receiptPoster,
      reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/prior-continuity'),
    }).runRound({ jobId: job.id }));
    expect(second.canonicalVerdict).toBe('INCOMPLETE');
    expect(second.round.status).toBe('aborted');
    expect(ledger.listRoundSpecialistStarts(second.round.id)).toHaveLength(2);
    const roundCount = ledger.listRounds(job.id).length;
    await expect(new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(secondSessions, []),
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/prior-continuity'),
    }).runRound({ jobId: job.id })).rejects.toThrow(/may still run; reconcile runtime cessation/);
    expect(ledger.listRounds(job.id)).toHaveLength(roundCount);

    let thirdAuditSeen = false;
    const thirdSessions = mkdtempSync(join(tmpdir(), 'perkins-prior-third-'));
    const thirdFake = fakeWholeSpawner(thirdSessions, {
      childAnswer: () => '[]', specialists: ['tests'],
      // Stage-5: the prior finding's cited file is untouched and its
      // evidence unchanged at the same head, so the host CARRIES it — the
      // prompt shows an empty revisit list and the lead dispositions only
      // what it was shown (the carried blocker still holds the verdict).
      priorDisposition: (shown) => {
        thirdAuditSeen = true;
        return shown.map((entry, index) => {
          const finding = entry as { title: string; location: string };
          return { prior_index: index, status: 'still-present' as const, note: `defect remains: ${finding.location}` };
        });
      },
    });
    const third = asWave(await new WaveRunner({
      reviewPreflight: recoveryPreflight, reviewRuntimeIdentity: recoveryRuntime,
      // This fake has no runtime registry; attest that its prior handles
      // settled before admitting a replacement owner.
      reconcileReviewAgent: async () => true,
      ledger,
      worktrees: port,
      spawner: thirdFake.spawner,
      poster: receiptPoster,
      reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/prior-continuity'),
    }).runRound({ jobId: job.id }));
    expect(thirdAuditSeen).toBe(true);
    expect(thirdFake.childCalls).toHaveLength(1);
    expect(thirdFake.childCalls[0]?.prompt).toContain('"source": "tests"');
    expect(ledger.listRoundSpecialistStarts(third.round.id)).toHaveLength(3);
    expect(readFileSync(join(third.artifactDirectory!, 'perkins-report.publication.md'), 'utf8'))
      .toContain('Prior-round checkpoint evidence shown to the fresh lead: blind, edge');
    expect(third.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(third.round.status).toBe('verdict-posted');
    const consolidated = JSON.parse(readFileSync(join(third.artifactDirectory!, 'consolidated.json'), 'utf8')) as {
      findings: { title: string; roundOrigin: number }[];
    };
    expect(consolidated.findings).toEqual([
      expect.objectContaining({ title: 'Verified security defect', roundOrigin: 1 }),
    ]);
    for (const directory of [root, artifacts, firstSessions, secondSessions, thirdSessions]) {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it('a final whole pass refused transiently is notified once — its automatic retry, not an action-required duplicate (R7-16)', async () => {
    const repo = makeFixtureRepo('perkins-wave-final-pass-refused');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/final-refused']);
    repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-final-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-final-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-final-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/final-refused', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-final-refused' });
    const job = ledger.addJob({
      id: 'job-final-refused', repo: 'fixture', title: 'final pass', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/39');
    attachOrigin(repo, 'feature/final-refused', root);
    const receiptPoster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9002', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const escalations: string[] = [];
    const recoveryPreflight = async () => ({
      ok: true as const, failures: [],
      reviewModel: { role: 'perkins' as const, modelRef: 'fixture-model-v1', settings: {}, authEnv: {}, routingSha256: 'fixture-safe-route' },
    });
    const recoveryRuntime = () => ({ id: 'pi', version: 'test-runtime-v1' });

    // Round 1 (whole): one warning; the round concludes READY.
    const first = asWave(await new WaveRunner({
      reviewPreflight: recoveryPreflight, reviewRuntimeIdentity: recoveryRuntime,
      ledger, worktrees: port, poster: receiptPoster,
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/final-refused'),
      spawner: fakeWholeSpawner(mkdtempSync(join(tmpdir(), 'perkins-final-s1-')), {
        childAnswer: () => '[]', specialists: [],
        leadFinding: groundedFinding('lead', 'warning', { location: 'src/main.ts:1', evidence: 'export function answer(): number {' }),
      }).spawner,
    }).runRound({ jobId: job.id }));
    expect(first.canonicalVerdict).toBe('READY TO MERGE');

    // Round 2 (delta): a blocker INSIDE the delta holds the PR.
    repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 44;\n}\n');
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/final-refused']);
    const secondFake = fakeWholeSpawner(mkdtempSync(join(tmpdir(), 'perkins-final-s2-')), {
      childAnswer: () => '[]', specialists: [],
      leadFinding: groundedFinding('lead', 'blocker', { location: 'src/main.ts:2', title: 'delta blocker' }),
    });
    const second = asWave(await new WaveRunner({
      reviewPreflight: recoveryPreflight, reviewRuntimeIdentity: recoveryRuntime,
      ledger, worktrees: port, spawner: secondFake.spawner, poster: receiptPoster,
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/final-refused'),
    }).runRound({ jobId: job.id }));
    expect(second.round.seq).toBe(2);
    expect(second.canonicalVerdict).toBe('NEEDS CHANGES');

    // Round 3 (delta): every prior and the new blocker sit OUTSIDE this
    // delta, so the convergence rule files them as follow-ups, recomputes
    // the verdict to READY, and the wave AUTO-CHAINS the final whole pass
    // (round 4), which re-holds the untouched blocker.
    repo.commitFile('src/third.ts', 'export const third = 3;\n');
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/final-refused']);
    const thirdFake = fakeWholeSpawner(mkdtempSync(join(tmpdir(), 'perkins-final-s3-')), {
      childAnswer: () => '[]', specialists: [],
      leadFinding: groundedFinding('lead', 'blocker', { location: 'src/main.ts:1', title: 'outside delta blocker' }),
      verdictOverride: 'NEEDS CHANGES',
    });
    // The chained final pass's local admission check fails, transiently.
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = mkdtempSync(join(tmpdir(), 'perkins-final-refused-shim-'));
    dirs.push(shimDir);
    writeFileSync(join(shimDir, 'git'), `#!/bin/sh\ncase " $* " in *" status "*) echo "fatal: index file locked" >&2; exit 128;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(join(shimDir, 'git'), 0o755);
    const oldPath = process.env.PATH;
    const informs: string[] = [];
    const third = new WaveRunner({
      reviewPreflight: recoveryPreflight, reviewRuntimeIdentity: recoveryRuntime, admissionRetryDelaysMs: [60_000],
      inform: (title, detail) => informs.push(`${title}: ${detail}`),
      reviewFreezeObserver: (frozen) => {
        if (frozen.manifest.roundId.endsWith('-r4')) process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
      },
      reconcileReviewAgent: async () => true,
      ledger, worktrees: port, spawner: thirdFake.spawner, poster: receiptPoster,
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/final-refused'),
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    let outcome: WaveOutcome;
    let pendingRetry: unknown;
    try {
      outcome = asWave(await third.runRound({ jobId: job.id }));
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      // The in-memory retry (owner decision 2026-10-08), before shutdown drops it.
      pendingRetry = (third as unknown as { admissionRetries: Map<string, { readonly input: unknown }> }).admissionRetries.get(job.id)?.input;
      await third.shutdown();
    }
    // The delta round's READY stands; the refused final pass retries on its own.
    expect(outcome.round.seq).toBe(3);
    expect(ledger.listRounds(job.id).map((round) => round.status).at(-1)).toBe('aborted');
    expect(ledger.listJobEventsByKinds(job.id, ['round.final-pass-failed'], { limit: 5 })).toHaveLength(1);
    expect(escalations.some((entry) => entry.includes('still owes its final whole-change pass'))).toBe(false);
    expect(escalations.some((entry) => entry.includes('refused admission before any specialist started'))).toBe(false);
    expect(informs.some((entry) => entry.includes('automatic retry 1 of 1 is scheduled'))).toBe(true);
    const scheduled = ledger.latestJobEvent(job.id, 'round.admission-retry-scheduled');
    expect(scheduled?.payload).toMatchObject({ attempt: 1 });
    expect(scheduled?.roundId).toBe(ledger.listRounds(job.id).at(-1)!.id);
    expect(pendingRetry).toMatchObject({ jobId: job.id, targetRef: repo.head() }); // the final pass's own target
  }, 120_000);


  it('Stage-5: a delta READY chains the final whole pass; deferred follow-ups are durable', async () => {
    const repo = makeFixtureRepo('perkins-wave-stage5-final-pass');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/final-pass']);
    repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-final-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-final-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-final-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/final-pass', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-final-pass' });
    const job = ledger.addJob({
      id: 'job-final-pass', repo: 'fixture', title: 'final pass', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/38');
    attachOrigin(repo, 'feature/final-pass', root);
    const receiptPoster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9002', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const escalations: string[] = [];
    const recoveryPreflight = async () => ({
      ok: true as const, failures: [],
      reviewModel: { role: 'perkins' as const, modelRef: 'fixture-model-v1', settings: {}, authEnv: {}, routingSha256: 'fixture-safe-route' },
    });
    const recoveryRuntime = () => ({ id: 'pi', version: 'test-runtime-v1' });

    // Round 1 (whole): one warning; the round concludes READY.
    const first = asWave(await new WaveRunner({
      reviewPreflight: recoveryPreflight, reviewRuntimeIdentity: recoveryRuntime,
      ledger, worktrees: port, poster: receiptPoster,
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/final-pass'),
      spawner: fakeWholeSpawner(mkdtempSync(join(tmpdir(), 'perkins-final-s1-')), {
        childAnswer: () => '[]', specialists: [],
        leadFinding: groundedFinding('lead', 'warning', { location: 'src/main.ts:1', evidence: 'export function answer(): number {' }),
      }).spawner,
    }).runRound({ jobId: job.id }));
    expect(first.canonicalVerdict).toBe('READY TO MERGE');

    // Round 2 (delta): a blocker INSIDE the delta holds the PR.
    repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 44;\n}\n');
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/final-pass']);
    const secondFake = fakeWholeSpawner(mkdtempSync(join(tmpdir(), 'perkins-final-s2-')), {
      childAnswer: () => '[]', specialists: [],
      leadFinding: groundedFinding('lead', 'blocker', { location: 'src/main.ts:2', title: 'delta blocker' }),
    });
    const second = asWave(await new WaveRunner({
      reviewPreflight: recoveryPreflight, reviewRuntimeIdentity: recoveryRuntime,
      ledger, worktrees: port, spawner: secondFake.spawner, poster: receiptPoster,
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/final-pass'),
    }).runRound({ jobId: job.id }));
    expect(second.round.seq).toBe(2);
    expect(second.canonicalVerdict).toBe('NEEDS CHANGES');

    // Round 3 (delta): every prior and the new blocker sit OUTSIDE this
    // delta, so the convergence rule files them as follow-ups, recomputes
    // the verdict to READY, and the wave AUTO-CHAINS the final whole pass
    // (round 4), which re-holds the untouched blocker.
    repo.commitFile('src/third.ts', 'export const third = 3;\n');
    repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/final-pass']);
    const thirdFake = fakeWholeSpawner(mkdtempSync(join(tmpdir(), 'perkins-final-s3-')), {
      childAnswer: () => '[]', specialists: [],
      leadFinding: groundedFinding('lead', 'blocker', { location: 'src/main.ts:1', title: 'outside delta blocker' }),
      verdictOverride: 'NEEDS CHANGES',
    });
    const outcome = asWave(await new WaveRunner({
      reviewPreflight: recoveryPreflight, reviewRuntimeIdentity: recoveryRuntime,
      reconcileReviewAgent: async () => true,
      ledger, worktrees: port, spawner: thirdFake.spawner, poster: receiptPoster,
      reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/final-pass'),
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    }).runRound({ jobId: job.id }));

    const rounds = ledger.listRounds(job.id);
    expect(rounds).toHaveLength(4);
    // The wave call returns the CHAINED whole-pass round, not the delta
    // round whose READY it superseded.
    expect(outcome.round.seq).toBe(4);
    expect(outcome.canonicalVerdict).toBe('NEEDS CHANGES');

    // The delta round (seq 3) posted READY, owed the final pass, and
    // durably filed its deferred follow-ups.
    const deltaRound = rounds.find((round) => round.seq === 3)!;
    const deltaReview = ledger.latestRoundEvent(deltaRound.id, 'round.perkins-review')!;
    expect(deltaReview.payload).toMatchObject({ canonicalVerdict: 'READY TO MERGE', reviewScope: 'delta', finalPassRequired: true, deferredFollowups: 3 });
    const deferredEvents = ledger.listJobEvents(job.id)
      .filter((event) => event.kind === 'round.followups-deferred' && event.roundId === deltaRound.id);
    expect(deferredEvents).toHaveLength(1);
    expect((deferredEvents[0]!.payload as { followups: unknown[] }).followups).toHaveLength(3);
    const deferredFile = JSON.parse(readFileSync(join(artifacts, deltaRound.id, 'followups-deferred.json'), 'utf8')) as {
      followups: Array<{ title: string; deferredFollowup?: true }>;
    };
    expect(deferredFile.followups).toHaveLength(3);
    expect(deferredFile.followups.some((finding) => finding.title === 'outside delta blocker')).toBe(true);
    expect(escalations.some((entry) => entry.includes('deferred 3 follow-up finding(s)'))).toBe(true);

    // The chained final whole pass carries the whole-change authority: the
    // untouched blocker counts again and no deferral survives.
    const finalRound = rounds.find((round) => round.seq === 4)!;
    const finalReview = ledger.latestRoundEvent(finalRound.id, 'round.perkins-review')!;
    expect(finalReview.payload).toMatchObject({ canonicalVerdict: 'NEEDS CHANGES', reviewScope: 'whole' });
    expect((finalReview.payload as { finalPassRequired?: unknown }).finalPassRequired).toBeUndefined();
    const finalConsolidated = JSON.parse(readFileSync(join(artifacts, finalRound.id, 'consolidated.json'), 'utf8')) as {
      findings: Array<{ title: string; deferredFollowup?: true }>;
      convergence: { reviewScope: string; deferredFollowups?: unknown };
    };
    expect(finalConsolidated.convergence.reviewScope).toBe('whole');
    expect(finalConsolidated.convergence.deferredFollowups).toBeUndefined();
    expect(finalConsolidated.findings.find((finding) => finding.title === 'outside delta blocker')?.deferredFollowup).toBeUndefined();

    for (const directory of [root, artifacts]) {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it('requires old-head writer cessation before admitting a new-head review', async () => {
    const repo = makeFixtureRepo('perkins-historical-head');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/historical-head']);
    const oldTarget = repo.commitFile('src/main.ts', 'export const answer = 43;\n');
    const newTarget = repo.commitFile('src/main.ts', 'export const answer = 44;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-historical-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-historical-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-historical-sessions-'));
    const dbDir = mkdtempSync(join(tmpdir(), 'perkins-historical-db-'));
    dirs.push(root, artifacts, sessions, dbDir);
    const db = new LedgerDb(dbDir);
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/historical-head', newTarget);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-historical-head' });
    const job = ledger.addJob({ id: 'job-historical-head', repo: 'fixture', title: 'historical head',
      baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const stale = ledger.addRound({ jobId: job.id, lenses: ['blind'], targetRef: oldTarget });
    ledger.registerAgent({ id: 'historical-agent', role: 'perkins', roundId: stale.id, jobId: job.id });
    ledger.setRoundStatus(stale.id, 'aborted');
    const fresh = fakeWholeSpawner(sessions, { childAnswer: () => '[]', specialists: [], verdictOverride: 'INCOMPLETE' });
    const wave = new WaveRunner({ ledger, worktrees: port, spawner: fresh.spawner, reviewArtifactRoot: artifacts,
      reconcileReviewAgent: async () => false });
    await expect(wave.runRound({ jobId: job.id })).rejects.toThrow(/historical-agent.*may still run/);
    expect(fresh.leadCalls).toHaveLength(0);
    expect(ledger.listRounds(job.id)).toHaveLength(1);
  });

  function integrityHarness(name: string) {
    const repo = makeFixtureRepo(name);
    repos.push(repo);
    repo.git(['checkout', '-b', `feature/${name}`]);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), `${name}-port-`));
    const artifacts = mkdtempSync(join(tmpdir(), `${name}-artifacts-`));
    const dbDir = mkdtempSync(join(tmpdir(), `${name}-db-`));
    dirs.push(root, artifacts, dbDir);
    const db = new LedgerDb(dbDir);
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, `feature/${name}`, target);
    const jobId = `job-${name}`;
    const prepare = async () => {
      await port.createJobWorktree({ repoPath: repo.path, jobId });
      ledger.addJob({ id: jobId, repo: 'fixture', title: name, baseBranch: 'main', briefing: 'review' });
      ledger.setJobStatus(jobId, 'working');
      settleLane(ledger, jobId);
    };
    const fake = (brain: WholeLeadOptions) => {
      const sessions = mkdtempSync(join(tmpdir(), `${name}-sessions-`));
      dirs.push(sessions);
      return fakeWholeSpawner(sessions, brain);
    };
    const wave = (modelRef: string, spawner: AgentSpawner, thinking = 'high', runtimeVersion = 'fixture-runtime-v1',
      routingSha256: string | null = 'fixture-safe-route', runtimeId: 'pi' | 'claude-code' = 'pi',
      settingsModel?: string,
      reserveReviewRound?: (signal: AbortSignal) => Promise<import('../src/runtime/registry.js').ResidentReviewRound>,
      effectiveThinking?: () => string) => new WaveRunner({
      ...(reserveReviewRound === undefined ? {} : { reserveReviewRound }),
      ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts,
      reconcileReviewAgent: async (_agentId, marker) => marker !== null, // fake handles; no claim without owner proof
      reviewRuntimeIdentity: () => ({ id: runtimeId, version: runtimeVersion }),
      reviewThinkingLevel: effectiveThinking ?? (() => thinking),
      reviewPreflight: async () => ({ ok: true as const, failures: [],
        reviewModel: { role: 'perkins' as const, modelRef,
          settings: settingsModel === undefined ? {} : { model: settingsModel }, authEnv: {},
          ...(routingSha256 === null ? {} : { routingSha256 }) } }),
    });
    return { repo, ledger, port, artifacts, jobId, target, prepare, fake, wave };
  }

  it('offers checked lenses after a base-only fast-forward to a fresh lead without refunding starts', async () => {
    const fixture = integrityHarness('perkins-base-fast-forward-credit');
    await fixture.prepare();
    const firstFake = fixture.fake({ childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true });
    const first = asWave(await fixture.wave('fixture-model-v1', firstFake.spawner).runRound({ jobId: fixture.jobId }));
    expect(first.round.status).toBe('aborted');
    const priorBase = fixture.repo.git(['rev-parse', 'main']);
    const newBase = fixture.repo.git([
      '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid',
      'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'base fast-forward',
    ]);
    fixture.repo.git(['update-ref', 'refs/heads/main', newBase]);
    const freshFake = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const next = asWave(await fixture.wave('fixture-model-v1', freshFake.spawner).runRound({ jobId: fixture.jobId }));
    expect(next.round.status).toBe('aborted');
    expect(freshFake.childCalls).toHaveLength(0);
    expect(freshFake.leadCalls).toHaveLength(1);
    expect(freshFake.leadCalls[0]?.prompt).toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(freshFake.leadCalls[0]?.prompt).toContain(`Earlier frozen base tip(s): ${priorBase}; current frozen main tip: ${newBase}`);
    expect(freshFake.leadCalls[0]?.prompt).toContain('Revalidate this current-base mergeability proof');
    // The carried ledger start is charged in this round, not a new child.
    expect(fixture.ledger.listRoundSpecialistStarts(next.round.id)).toHaveLength(1);
    expect(fixture.ledger.listRoundSpecialistStarts(next.round.id)[0]?.payload)
      .toMatchObject({ lens: 'blind', attempt: 1, originRoundId: first.round.id });
    const manifests = [first, next].map((round) => JSON.parse(readFileSync(join(fixture.artifacts, round.round.id, 'manifest.json'), 'utf8')) as { baseRefSha: string });
    expect(manifests.map((manifest) => manifest.baseRefSha)).toEqual([priorBase, newBase]);
  }, 180_000);

  it('withholds base-advanced credit on a merge conflict while retaining charged starts', async () => {
    const fixture = integrityHarness('perkins-base-conflict-refusal');
    await fixture.prepare();
    const earlierFake = fixture.fake({ childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true });
    const earlier = asWave(await fixture.wave('fixture-model-v1', earlierFake.spawner).runRound({ jobId: fixture.jobId }));
    fixture.repo.git(['checkout', 'main']);
    fixture.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 99;\n}\n');
    fixture.repo.git(['checkout', 'feature/perkins-base-conflict-refusal']);
    const freshFake = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const fresh = asWave(await fixture.wave('fixture-model-v1', freshFake.spawner).runRound({ jobId: fixture.jobId }));
    expect(freshFake.leadCalls[0]?.prompt).not.toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(fixture.ledger.listRoundSpecialistStarts(fresh.round.id)[0]?.payload)
      .toMatchObject({ lens: 'blind', attempt: 1, originRoundId: earlier.round.id });
  }, 180_000);

  it('rejects a conclusive recovered verdict when the base moves after lead spawn', async () => {
    const fixture = integrityHarness('perkins-base-submit-race');
    await fixture.prepare();
    const earlierFake = fixture.fake({ childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true });
    await fixture.wave('fixture-model-v1', earlierFake.spawner).runRound({ jobId: fixture.jobId });
    const advanceBase = (message: string) => {
      const next = fixture.repo.git([
        '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid',
        'commit-tree', 'main^{tree}', '-p', 'main', '-m', message,
      ]);
      fixture.repo.git(['update-ref', 'refs/heads/main', next]);
    };
    advanceBase('before lead spawn');
    const leadFake = fixture.fake({ childAnswer: () => '[]', specialists: [],
      beforeSubmit: () => advanceBase('after lead spawn') });
    const outcome = asWave(await fixture.wave('fixture-model-v1', leadFake.spawner).runRound({ jobId: fixture.jobId }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(leadFake.leadCalls[0]?.prompt).toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(leadFake.toolErrors.some((error) => error.tool === 'perkins_submit_review' &&
      error.error.includes('recovered-base-mergeability'))).toBe(true);
  }, 180_000);

  it('recovers a checked Claude specialist with unchanged public model identity and charges the original start', async () => {
    const fixture = integrityHarness('perkins-claude-compatible-credit');
    await fixture.prepare();
    const earlierFake = fixture.fake({ childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true });
    const earlier = asWave(await fixture.wave('anthropic/claude-sonnet-4-6', earlierFake.spawner, 'high',
      'fixture-runtime-v1', null, 'claude-code').runRound({ jobId: fixture.jobId }));
    expect(earlier.round.status).toBe('aborted');
    const freshFake = fixture.fake({ childAnswer: () => '[]', specialists: ['edge'], neverSubmit: true });
    const fresh = asWave(await fixture.wave('anthropic/claude-sonnet-4-6', freshFake.spawner, 'high',
      'fixture-runtime-v1', null, 'claude-code').runRound({ jobId: fixture.jobId }));
    expect(freshFake.leadCalls[0]?.prompt).toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(freshFake.leadCalls[0]?.prompt).toContain('blind grounded defect');
    expect(freshFake.childCalls.map((call) => sourceFor(call.prompt ?? ''))).toEqual(['edge']);
    expect(fixture.ledger.listRoundSpecialistStarts(fresh.round.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ payload: expect.objectContaining({ lens: 'blind', attempt: 1, originRoundId: earlier.round.id }) }),
    ]));
  }, 180_000);

  it('allows a public Claude model but never persists a credential prefix, model setting or thinking sentinel', async () => {
    for (const [name, modelRef, thinking, settingsModel] of [
      ['prefix', 'credential-looking-provider/claude-sonnet-4-6', 'high', undefined],
      ['setting', 'anthropic/claude-sonnet-4-6', 'high', 'credential-looking-model'],
      ['thinking', 'anthropic/claude-sonnet-4-6', 'credential-looking-thinking', undefined],
    ] as const) {
      const fixture = integrityHarness(`perkins-claude-identity-${name}`);
      await fixture.prepare();
      const earlier = fixture.fake({ childAnswer: () => '[]', specialists: ['blind'], neverSubmit: true });
      const first = asWave(await fixture.wave('anthropic/claude-sonnet-4-6', earlier.spawner, 'high',
        'fixture-runtime-v1', null, 'claude-code').runRound({ jobId: fixture.jobId }));
      const initialManifest = JSON.parse(readFileSync(join(fixture.artifacts, first.round.id, 'manifest.json'), 'utf8')) as {
        recoveryIdentity: { modelRef: string } | null;
      };
      expect(initialManifest.recoveryIdentity?.modelRef).toBe('anthropic/claude-sonnet-4-6');
      const changed = fixture.fake({ childAnswer: () => '[]', specialists: ['edge'], neverSubmit: true });
      const next = asWave(await fixture.wave(modelRef, changed.spawner, thinking, 'fixture-runtime-v1',
        null, 'claude-code', settingsModel).runRound({ jobId: fixture.jobId }));
      const manifestBytes = readFileSync(join(fixture.artifacts, next.round.id, 'manifest.json'), 'utf8');
      expect((JSON.parse(manifestBytes) as { recoveryIdentity: unknown }).recoveryIdentity).toBeNull();
      expect(manifestBytes).not.toContain('credential-looking');
      expect(changed.leadCalls[0]?.prompt).not.toContain('RECOVERED SPECIALIST EVIDENCE');
      expect(fixture.ledger.listRoundSpecialistStarts(next.round.id).length).toBeGreaterThan(0);
    }
  }, 180_000);

  it('never credits an unchanged Pi model ID routed to a different endpoint', async () => {
    const fixture = integrityHarness('perkins-pi-route-change');
    await fixture.prepare();
    const first = fixture.fake({ childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true });
    const earlier = asWave(await fixture.wave('fixture-model-v1', first.spawner).runRound({ jobId: fixture.jobId }));
    expect(fixture.ledger.listRoundSpecialistStarts(earlier.round.id)).toHaveLength(1);
    const changedRoute = fixture.fake({ childAnswer: () => '[]', specialists: ['edge'], neverSubmit: true });
    const later = asWave(await fixture.wave('fixture-model-v1', changedRoute.spawner, 'high',
      'fixture-runtime-v1', 'alternate-safe-route').runRound({ jobId: fixture.jobId }));
    expect(changedRoute.leadCalls[0]?.prompt).not.toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(changedRoute.childCalls).toHaveLength(1);
    expect(fixture.ledger.listRoundSpecialistStarts(later.round.id)).toHaveLength(2);
  }, 180_000);

  it('never credits prior Pi work when routing proof is absent in either round', async () => {
    const fixture = integrityHarness('perkins-pi-missing-route');
    await fixture.prepare();
    const first = fixture.fake({ childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true });
    const earlier = asWave(await fixture.wave('fixture-model-v1', first.spawner, 'high', 'fixture-runtime-v1', null)
      .runRound({ jobId: fixture.jobId }));
    expect(fixture.ledger.listRoundSpecialistStarts(earlier.round.id)).toHaveLength(1);
    const laterFake = fixture.fake({ childAnswer: () => '[]', specialists: ['edge'], neverSubmit: true });
    const later = asWave(await fixture.wave('fixture-model-v1', laterFake.spawner)
      .runRound({ jobId: fixture.jobId }));
    expect(laterFake.leadCalls[0]?.prompt).not.toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(laterFake.childCalls).toHaveLength(1);
    expect(fixture.ledger.listRoundSpecialistStarts(later.round.id)).toHaveLength(2);
  }, 180_000);

  it('admits a proven dead Pi host with no registered agents', async () => {
    const fixture = integrityHarness('perkins-pi-dead-empty-owner');
    await fixture.prepare();
    const old = fixture.ledger.addRound({ jobId: fixture.jobId, targetRef: fixture.target, lenses: ['blind'] });
    fixture.ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: fixture.jobId, roundId: old.id,
      payload: { roundId: old.id, targetSha: fixture.target, runtimeId: 'pi', pid: 2147483647,
        generation: '12345678-1234-4234-8234-123456789abc' } });
    fixture.ledger.setRoundStatus(old.id, 'aborted');
    expect(fixture.ledger.listAgents().filter((agent) => agent.roundId === old.id)).toHaveLength(0);
    const replacement = fixture.fake({ childAnswer: () => '[]', specialists: [] });
    const home = mkdtempSync(join(tmpdir(), 'perkins-dead-host-registry-'));
    dirs.push(home);
    const workspace = mkdtempSync(join(tmpdir(), 'perkins-dead-host-workspace-'));
    dirs.push(workspace);
    writeFileSync(configPathFor(home), `workspace_root = ${JSON.stringify(workspace)}\n`);
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const registry = new RuntimeRegistry({ config, store: new SessionStore(config.dataDir),
      ownerProcessProbe: () => 'dead' });
    const wave = new WaveRunner({ ledger: fixture.ledger, worktrees: fixture.port, spawner: replacement.spawner,
      reviewArtifactRoot: fixture.artifacts,
      reconcileReviewAgent: async (agentId, marker) => registry.reviewOwnerCeased(agentId, marker) });
    await wave.runRound({ jobId: fixture.jobId });
    expect(replacement.leadCalls).toHaveLength(1);
    expect(fixture.ledger.listRounds(fixture.jobId)).toHaveLength(2);
  }, 180_000);

  it('recovers A verified work from a partly copied B while carrying every start into C', async () => {
    const fixture = integrityHarness('perkins-three-round-copy');
    await fixture.prepare();
    const a = fixture.fake({ childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true });
    const first = asWave(await fixture.wave('fixture-model-v1', a.spawner).runRound({ jobId: fixture.jobId }));
    expect(fixture.ledger.listRoundSpecialistStarts(first.round.id)).toHaveLength(1);
    const freezeReceipt = fixture.ledger.uniqueRoundFreezeManifestReceipt(first.round.id);
    const firstStart = fixture.ledger.listRoundSpecialistStarts(first.round.id)[0]!;
    expect(freezeReceipt?.seq).toBeLessThan(firstStart.seq);
    expect(freezeReceipt?.payload).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    const b = fixture.fake({ childAnswer: () => 'malformed tests output', specialists: ['tests'], neverSubmit: true });
    const middle = asWave(await fixture.wave('fixture-model-v1', b.spawner).runRound({ jobId: fixture.jobId }));
    expect(fixture.ledger.listRoundSpecialistStarts(middle.round.id)).toHaveLength(3);
    // Crash halfway through B's evidence copy: its charged marker survives,
    // but its copied child proof cannot authenticate a valid outcome.
    rmSync(join(middle.artifactDirectory!, 'children'), { recursive: true, force: true });
    const c = fixture.fake({ childAnswer: () => '[]', specialists: ['edge'], probeExhausted: 'tests', neverSubmit: true });
    const final = asWave(await fixture.wave('fixture-model-v1', c.spawner).runRound({ jobId: fixture.jobId }));
    expect(c.leadCalls[0]?.prompt).toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(c.leadCalls[0]?.prompt).toContain('blind grounded defect');
    expect(c.childCalls).toHaveLength(1);
    expect(c.toolErrors.some((error) => error.error.includes('tests exhausted its attempts'))).toBe(true);
    expect(fixture.ledger.listRoundSpecialistStarts(final.round.id)).toHaveLength(4);
    expect(fixture.ledger.listRoundSpecialistSettlements(final.round.id)).toHaveLength(4);
    expect(fixture.ledger.listRoundSpecialistStarts(final.round.id).map((event) => event.payload))
      .toEqual([{ lens: 'blind', attempt: 1, originRoundId: first.round.id },
        { lens: 'tests', attempt: 1, originRoundId: middle.round.id },
        { lens: 'tests', attempt: 2, originRoundId: middle.round.id },
        { lens: 'edge', attempt: 1, originRoundId: final.round.id }]);
  }, 180_000);

  it('fails closed on two independently charged attempt-one starts instead of deduplicating them', async () => {
    const fixture = integrityHarness('perkins-duplicate-origin');
    await fixture.prepare();
    const first = asWave(await fixture.wave('fixture-model-v1', fixture.fake({
      childAnswer: () => '[]', specialists: ['blind'], neverSubmit: true,
    }).spawner).runRound({ jobId: fixture.jobId }));
    const other = fixture.ledger.addRound({ jobId: fixture.jobId, targetRef: fixture.target, lenses: ['blind'] });
    fixture.ledger.appendCustomEvent({ kind: 'round.specialist-started', jobId: fixture.jobId,
      roundId: other.id, payload: { lens: 'blind', attempt: 1, originRoundId: other.id } });
    fixture.ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: fixture.jobId, roundId: other.id,
      payload: { roundId: other.id, targetSha: fixture.target, runtimeId: 'pi', pid: process.pid,
        generation: '12345678-1234-4234-8234-123456789abc' } });
    fixture.ledger.setRoundStatus(other.id, 'aborted');
    const replacement = fixture.fake({ childAnswer: () => '[]', specialists: [] });
    const result = asWave(await fixture.wave('fixture-model-v1', replacement.spawner).runRound({ jobId: fixture.jobId }));
    expect(result.canonicalVerdict).toBe('INCOMPLETE');
    expect(replacement.leadCalls).toHaveLength(0);
    expect(readFileSync(result.reportFile!, 'utf8')).toContain('independently charged starts');
    expect(fixture.ledger.listRoundSpecialistStarts(first.round.id)).toHaveLength(1);
  }, 180_000);

  it('rejects a 17th charged ledger start before a recovered lead can spawn', async () => {
    const fixture = integrityHarness('perkins-recovered-run-cap');
    await fixture.prepare();
    const a = fixture.fake({ childAnswer: () => '[]', specialists: ['blind'], neverSubmit: true });
    const first = asWave(await fixture.wave('fixture-model-v1', a.spawner).runRound({ jobId: fixture.jobId }));
    for (let i = 0; i < 16; i += 1) {
      fixture.ledger.appendCustomEvent({ kind: 'round.specialist-started', jobId: fixture.jobId,
        roundId: first.round.id, payload: { lens: 'blind', attempt: 1 } });
    }
    const b = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const second = asWave(await fixture.wave('fixture-model-v1', b.spawner).runRound({ jobId: fixture.jobId }));
    expect(second.canonicalVerdict).toBe('INCOMPLETE');
    expect(b.leadCalls).toHaveLength(0);
    expect(readFileSync(second.reportFile!, 'utf8')).toContain('exceeds the 16-run specialist cap');
  }, 180_000);

  it('refuses a duplicate owner marker instead of trusting a newer host PID', async () => {
    const fixture = integrityHarness('perkins-duplicate-owner');
    await fixture.prepare();
    const first = asWave(await fixture.wave('fixture-model-v1', fixture.fake({
      childAnswer: () => '[]', specialists: ['blind'], neverSubmit: true,
    }).spawner).runRound({ jobId: fixture.jobId }));
    const owner = fixture.ledger.uniqueRoundReviewOwnerMarker(first.round.id);
    expect(owner).not.toBeNull();
    fixture.ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: fixture.jobId,
      roundId: first.round.id, payload: owner!.payload });
    expect(fixture.ledger.uniqueRoundReviewOwnerMarker(first.round.id)).toBeNull();
    const replacement = fixture.fake({ childAnswer: () => '[]', specialists: [] });
    await expect(fixture.wave('fixture-model-v1', replacement.spawner).runRound({ jobId: fixture.jobId }))
      .rejects.toThrow(/may still run; reconcile runtime cessation/);
    expect(replacement.leadCalls).toHaveLength(0);
    expect(fixture.ledger.listRounds(fixture.jobId)).toHaveLength(1);
  }, 180_000);

  it('admits only one job round across concurrent setup calls', async () => {
    const fixture = integrityHarness('perkins-concurrent-admission');
    await fixture.prepare();
    const lead = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const wave = fixture.wave('fixture-model-v1', lead.spawner);
    const outcomes = await Promise.allSettled([
      wave.runRound({ jobId: fixture.jobId }), wave.runRound({ jobId: fixture.jobId }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ message: expect.stringMatching(/admission.*in progress/) }) }),
    ]);
    expect(fixture.ledger.listRounds(fixture.jobId)).toHaveLength(1);
  }, 180_000);

  it('commits the job-status flip and predecessor CAS with exactly one new round', async () => {
    const fixture = integrityHarness('perkins-ledger-admission-cas');
    await fixture.prepare();
    const predecessor = fixture.ledger.addRound({ jobId: fixture.jobId, targetRef: fixture.target, lenses: ['blind'] });
    fixture.ledger.setRoundStatus(predecessor.id, 'aborted');
    const input = { jobId: fixture.jobId, expectedLatestRoundId: predecessor.id,
      expectedJobStatus: 'working' as const, targetRef: fixture.target, lenses: ['blind'] };
    const admitted = fixture.ledger.admitReviewRound(input);
    expect(fixture.ledger.getJob(fixture.jobId)?.status).toBe('in-review');
    expect(() => fixture.ledger.admitReviewRound(input)).toThrow(/changed during reconciliation/);
    expect(fixture.ledger.listRounds(fixture.jobId).map((round) => round.id))
      .toEqual([predecessor.id, admitted.id]);
    expect(fixture.ledger.listJobEvents(fixture.jobId).filter((event) =>
      event.kind === 'job.status' && (event.payload as { to?: string }).to === 'in-review')).toHaveLength(1);
  }, 180_000);

  it('does not roll back job status when a later round was admitted during an older setup failure', async () => {
    const fixture = integrityHarness('perkins-successor-setup-rollback');
    await fixture.prepare();
    let entered!: () => void;
    let failSetup!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { failSetup = resolve; });
    const port: WorktreePort = {
      createJobWorktree: (input) => fixture.port.createJobWorktree(input),
      createChildWorktree: (input) => fixture.port.createChildWorktree(input),
      resolveReviewTarget: (input) => fixture.port.resolveReviewTarget(input),
      createReviewWorktree: async () => {
        entered();
        await gate;
        throw new Error('synthetic older setup failure after successor admission');
      },
      getWorktree: (id) => fixture.port.getWorktree(id),
      listWorktrees: (options) => fixture.port.listWorktrees(options),
      release: (input) => fixture.port.release(input),
    };
    const spawner = vi.fn() as unknown as AgentSpawner;
    const wave = new WaveRunner({ ledger: fixture.ledger, worktrees: port, spawner,
      reviewArtifactRoot: fixture.artifacts });
    const starting = wave.beginRound({ jobId: fixture.jobId });
    // Observe a failure as a settled value until the delayed setup is released.
    const observed = starting.then(() => null, (error: unknown) => error);
    await started;
    const old = fixture.ledger.listRounds(fixture.jobId)[0]!;
    expect(fixture.ledger.getJob(fixture.jobId)?.status).toBe('in-review');
    fixture.ledger.setRoundStatus(old.id, 'aborted');
    const successor = fixture.ledger.admitReviewRound({
      jobId: fixture.jobId, expectedLatestRoundId: old.id, expectedJobStatus: 'in-review',
      lenses: ['blind'], targetRef: fixture.target,
    });
    failSetup();
    expect(String(await observed)).toContain('synthetic older setup failure');
    expect(fixture.ledger.getJob(fixture.jobId)?.status).toBe('in-review');
    expect(fixture.ledger.getRound(successor.id)?.status).toBe('pending');
    expect(fixture.ledger.listRounds(fixture.jobId)).toHaveLength(2);
    expect(spawner).not.toHaveBeenCalled();
  }, 180_000);

  it('serializes two runner instances despite a stale predecessor snapshot during reconciliation', async () => {
    const fixture = integrityHarness('perkins-two-runner-race');
    await fixture.prepare();
    const predecessor = fixture.ledger.addRound({ jobId: fixture.jobId, targetRef: fixture.target, lenses: ['blind'] });
    fixture.ledger.registerAgent({ id: 'previous-lead', role: 'perkins', roundId: predecessor.id, jobId: fixture.jobId });
    fixture.ledger.setRoundStatus(predecessor.id, 'aborted');
    const snapshot = fixture.ledger.listRounds(fixture.jobId);
    const originalListRounds = fixture.ledger.listRounds.bind(fixture.ledger);
    // Two hosts can each have a reconciled predecessor snapshot before
    // either publishes the replacement. Only the transactional ledger CAS
    // may grant permission; an in-memory runner guard cannot cover both.
    const stale = vi.spyOn(fixture.ledger, 'listRounds').mockImplementation(() => snapshot);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const fakeA = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const fakeB = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const makeRunner = (spawner: AgentSpawner) => new WaveRunner({
      ledger: fixture.ledger, worktrees: fixture.port, spawner, reviewArtifactRoot: fixture.artifacts,
      reconcileReviewAgent: async () => { arrivals += 1; await barrier; return true; },
      reviewRuntimeIdentity: () => ({ id: 'pi', version: 'fixture-runtime-v1' }),
      reviewPreflight: async () => ({ ok: true, failures: [],
        reviewModel: { role: 'perkins', modelRef: 'fixture-model-v1', settings: {}, authEnv: {}, routingSha256: "fixture-safe-route" } }),
    });
    try {
      const runnerA = makeRunner(fakeA.spawner);
      const runnerB = makeRunner(fakeB.spawner);
      const attempts = [runnerA.runRound({ jobId: fixture.jobId }), runnerB.runRound({ jobId: fixture.jobId })];
      await vi.waitFor(() => expect(arrivals).toBe(2));
      release();
      const outcomes = await Promise.allSettled(attempts);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ message: expect.stringMatching(/changed during reconciliation/) }) }),
      ]);
      expect(fakeA.leadCalls.length + fakeB.leadCalls.length).toBe(1);
      expect(originalListRounds(fixture.jobId)).toHaveLength(2);
    } finally {
      release();
      stale.mockRestore();
    }
  }, 180_000);

  it('blocks an unregistered marked owner before creating a second writer', async () => {
    const fixture = integrityHarness('perkins-unregistered-owner');
    await fixture.prepare();
    const first = asWave(await fixture.wave('fixture-model-v1', fixture.fake({
      childAnswer: () => '[]', specialists: [], neverSubmit: true,
    }).spawner).runRound({ jobId: fixture.jobId }));
    expect(fixture.ledger.uniqueRoundReviewOwnerMarker(first.round.id)).not.toBeNull();
    // Registration can be lost in the marker-before-register crash window.
    const agents = fixture.ledger.listAgents().filter((agent) => agent.roundId === first.round.id);
    expect(agents).toHaveLength(1);
    // A separate ledger round models that window without modifying durable rows.
    const unregistered = fixture.ledger.addRound({ jobId: fixture.jobId, targetRef: fixture.target, lenses: ['blind'] });
    fixture.ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: fixture.jobId, roundId: unregistered.id,
      payload: { roundId: unregistered.id, targetSha: fixture.target, runtimeId: 'pi', pid: process.pid,
        generation: '12345678-1234-4234-8234-123456789abc' } });
    fixture.ledger.setRoundStatus(unregistered.id, 'aborted');
    const replacement = fixture.fake({ childAnswer: () => '[]', specialists: [] });
    const blocked = new WaveRunner({ ledger: fixture.ledger, worktrees: fixture.port,
      spawner: replacement.spawner, reviewArtifactRoot: fixture.artifacts,
      reconcileReviewAgent: async (agentId) => agentId !== '' });
    await expect(blocked.runRound({ jobId: fixture.jobId })).rejects.toThrow(/marker.*may still run/);
    expect(fixture.ledger.listRounds(fixture.jobId)).toHaveLength(2);
    expect(replacement.leadCalls).toHaveLength(0);
  }, 180_000);

  it('refuses an older-head aborted round with neither marker nor agent before creating a new writer', async () => {
    const fixture = integrityHarness('perkins-old-head-untracked-owner');
    await fixture.prepare();
    const old = fixture.ledger.addRound({ jobId: fixture.jobId, targetRef: 'a'.repeat(40), lenses: ['blind'] });
    fixture.ledger.setRoundStatus(old.id, 'aborted');
    const fake = fixture.fake({ childAnswer: () => '[]', specialists: [] });
    await expect(fixture.wave('fixture-model-v1', fake.spawner).runRound({ jobId: fixture.jobId }))
      .rejects.toThrow(/ownership is unknown.*reconcile cessation manually/);
    expect(fixture.ledger.listRounds(fixture.jobId)).toHaveLength(1);
    expect(fake.leadCalls).toHaveLength(0);
  }, 180_000);

  it('blocks an unreceipted legacy freeze with unknown ownership and retains same-head charged starts', async () => {
    const fixture = integrityHarness('perkins-legacy-freeze');
    await fixture.prepare();
    const a = fixture.fake({ childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true });
    const first = asWave(await fixture.wave('fixture-model-v1', a.spawner).runRound({ jobId: fixture.jobId }));
    const legacy = fixture.ledger.addRound({ jobId: fixture.jobId, targetRef: fixture.target, lenses: ['blind'] });
    const legacyDir = join(fixture.artifacts, legacy.id);
    mkdirSync(legacyDir);
    const manifest = JSON.parse(readFileSync(join(first.artifactDirectory!, 'manifest.json'), 'utf8')) as { roundId: string };
    writeFileSync(join(legacyDir, 'manifest.json'), `${JSON.stringify({ ...manifest, roundId: legacy.id }, null, 2)}\n`);
    fixture.ledger.setRoundStatus(legacy.id, 'aborted');
    expect(fixture.ledger.uniqueRoundFreezeManifestReceipt(legacy.id)).toBeNull();
    const c = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    await expect(fixture.wave('fixture-model-v1', c.spawner).runRound({ jobId: fixture.jobId }))
      .rejects.toThrow(/no trusted no-spawn proof or owner marker; ownership is unknown/);
    expect(c.leadCalls).toHaveLength(0);
    expect(fixture.ledger.listRounds(fixture.jobId)).toHaveLength(2);
    expect(fixture.ledger.listRoundSpecialistStarts(first.round.id)).toHaveLength(1);
  }, 180_000);

  it('receipts a rejected resident admission and retries under the same owner without attesting an in-flight review', async () => {
    const fixture = integrityHarness('perkins-resident-admission-retry');
    await fixture.prepare();
    const fake = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    let rejectAdmission = true;
    const reserve = async (): Promise<import('../src/runtime/registry.js').ResidentReviewRound> => {
      if (rejectAdmission) throw new Error('resident slots unavailable');
      return { spawn: (options) => fake.spawner('perkins', options),
        beginChildren: (concurrency) => ({ concurrency, finish() {} }),
        close: async () => {}, reconcileCleanup() {}, cleanupDebt: () => [] };
    };
    const wave = fixture.wave('fixture-model-v1', fake.spawner, 'high', 'fixture-runtime-v1',
      'fixture-safe-route', 'pi', undefined, reserve);
    await expect(wave.runRound({ jobId: fixture.jobId })).rejects.toThrow('resident slots unavailable');
    const failed = fixture.ledger.listRounds(fixture.jobId)[0]!;
    expect(failed.status).toBe('aborted');
    expect(fixture.ledger.uniqueRoundNoSpawnReceipt(failed.id)?.payload)
      .toMatchObject({ roundId: failed.id,
        ownerGeneration: (fixture.ledger.uniqueRoundReviewOwnerMarker(failed.id)?.payload as { generation: string }).generation });
    expect(fixture.ledger.listAgents().filter((agent) => agent.roundId === failed.id)).toHaveLength(0);
    expect(fake.leadCalls).toHaveLength(0);
    rejectAdmission = false;
    const resumed = asWave(await wave.runRound({ jobId: fixture.jobId, force: true }));
    expect(resumed.round.id).not.toBe(failed.id);
    expect(fake.leadCalls).toHaveLength(1);
    expect(fixture.ledger.listAgents().some((agent) => agent.roundId === resumed.round.id)).toBe(true);
    expect(fixture.ledger.uniqueRoundNoSpawnReceipt(resumed.round.id)).toBeNull();
    expect(() => fixture.ledger.abortReviewSetupWithoutSpawn(resumed.round.id)).toThrow('cannot prove no review owner started');
    expect(fixture.ledger.uniqueRoundNoSpawnReceipt(resumed.round.id)).toBeNull();
  }, 180_000);

  it('attests a model/thinking change during resident admission before spawn and retries safely', async () => {
    const fixture = integrityHarness('perkins-admission-thinking-change');
    await fixture.prepare();
    const fake = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    let thinking = 'high';
    let admissions = 0;
    const reserve = async (): Promise<import('../src/runtime/registry.js').ResidentReviewRound> => {
      admissions += 1;
      thinking = admissions === 1 ? 'low' : 'high';
      return { spawn: (options) => fake.spawner('perkins', options),
        beginChildren: (concurrency) => ({ concurrency, finish() {} }),
        close: async () => {}, reconcileCleanup() {}, cleanupDebt: () => [] };
    };
    const wave = fixture.wave('fixture-model-v1', fake.spawner, 'high', 'fixture-runtime-v1',
      'fixture-safe-route', 'pi', undefined, reserve, () => thinking);
    await expect(wave.runRound({ jobId: fixture.jobId })).rejects.toThrow('settings changed since freeze');
    const rejected = fixture.ledger.listRounds(fixture.jobId)[0]!;
    expect(rejected.status).toBe('aborted');
    expect(fixture.ledger.uniqueRoundNoSpawnReceipt(rejected.id)?.payload)
      .toMatchObject({ roundId: rejected.id,
        ownerGeneration: (fixture.ledger.uniqueRoundReviewOwnerMarker(rejected.id)?.payload as { generation: string }).generation });
    expect(fake.leadCalls).toHaveLength(0);
    thinking = 'high';
    const retry = asWave(await wave.runRound({ jobId: fixture.jobId, force: true }));
    expect(retry.round.id).not.toBe(rejected.id);
    expect(fake.leadCalls).toHaveLength(1);
    expect(fixture.ledger.uniqueRoundNoSpawnReceipt(retry.round.id)).toBeNull();
  }, 180_000);

  it('refuses negative proof after a spawner throws before registering its handle', async () => {
    const fixture = integrityHarness('perkins-ambiguous-spawn');
    await fixture.prepare();
    const spawner = vi.fn((_role: Parameters<AgentSpawner>[0], _options: Parameters<AgentSpawner>[1]) => {
      throw new Error('spawner may have started a writer');
    });
    const outcome = asWave(await fixture.wave('fixture-model-v1', spawner).runRound({ jobId: fixture.jobId }));
    expect(outcome.round.status).toBe('aborted');
    expect(spawner).toHaveBeenCalled();
    expect(fixture.ledger.listAgents().filter((agent) => agent.roundId === outcome.round.id)).toHaveLength(0);
    expect(fixture.ledger.uniqueRoundNoSpawnReceipt(outcome.round.id)).toBeNull();
    expect(() => fixture.ledger.abortReviewSetupWithoutSpawn(outcome.round.id)).toThrow('cannot prove no review owner started');
    await expect(new WaveRunner({ ledger: fixture.ledger, worktrees: fixture.port, spawner,
      reviewArtifactRoot: fixture.artifacts }).runRound({ jobId: fixture.jobId }))
      .rejects.toThrow(/marker.*may still run/);
  }, 180_000);

  it('attests setup failure with a unique no-spawn receipt, while legacy missing proof stays blocked', async () => {
    const fixture = integrityHarness('perkins-setup-no-spawn');
    await fixture.prepare();
    const failLive = vi.spyOn(fixture.ledger, 'setRoundStatus').mockImplementationOnce(() => {
      throw new Error('setup failed before any spawn');
    });
    const fake = fixture.fake({ childAnswer: () => '[]', specialists: [] });
    const first = fixture.wave('fixture-model-v1', fake.spawner);
    const failedOutcome = asWave(await first.runRound({ jobId: fixture.jobId }));
    expect(failedOutcome.canonicalVerdict).toBe('INCOMPLETE');
    failLive.mockRestore();
    const failed = fixture.ledger.listRounds(fixture.jobId)[0]!;
    expect(failed.status).toBe('aborted');
    expect(fixture.ledger.uniqueRoundReviewOwnerMarker(failed.id)).not.toBeNull();
    expect(fixture.ledger.uniqueRoundNoSpawnReceipt(failed.id)?.payload)
      .toMatchObject({ roundId: failed.id,
        ownerGeneration: (fixture.ledger.uniqueRoundReviewOwnerMarker(failed.id)?.payload as { generation: string }).generation });
    expect(fake.leadCalls).toHaveLength(0);
    expect(fixture.ledger.getJob(fixture.jobId)?.status).toBe('in-review');
    const replacement = fixture.fake({ childAnswer: () => '[]', specialists: [] });
    await fixture.wave('fixture-model-v1', replacement.spawner).runRound({ jobId: fixture.jobId, force: true });
    expect(replacement.leadCalls).toHaveLength(1);
    fixture.ledger.appendCustomEvent({ kind: 'round.review-no-spawn', jobId: fixture.jobId, roundId: failed.id,
      payload: fixture.ledger.latestRoundEvent(failed.id, 'round.review-no-spawn')?.payload });
    expect(fixture.ledger.uniqueRoundNoSpawnReceipt(failed.id)).toBeNull();
    const third = fixture.fake({ childAnswer: () => '[]', specialists: [] });
    await expect(fixture.wave('fixture-model-v1', third.spawner).runRound({ jobId: fixture.jobId, force: true }))
      .rejects.toThrow(/contradictory or duplicate no-spawn and owner evidence/);
    expect(third.leadCalls).toHaveLength(0);
  }, 180_000);

  it('rejects a thinking change between preflight and freeze before any review spawn', async () => {
    const fixture = integrityHarness('perkins-preflight-thinking');
    await fixture.prepare();
    const fake = fixture.fake({ childAnswer: () => '[]', specialists: [] });
    const wave = new WaveRunner({ ledger: fixture.ledger, worktrees: fixture.port, spawner: fake.spawner,
      reviewArtifactRoot: fixture.artifacts,
      reviewRuntimeIdentity: () => ({ id: 'pi', version: 'fixture-runtime-v1' }),
      reviewThinkingLevel: () => 'low',
      reviewPreflight: async () => ({ ok: true, failures: [], reviewThinkingLevel: 'high',
        reviewModel: { role: 'perkins', modelRef: 'fixture-model-v1', settings: {}, authEnv: {}, routingSha256: "fixture-safe-route" } }),
    });
    await expect(wave.runRound({ jobId: fixture.jobId })).rejects.toThrow(/thinking level changed since preflight/);
    expect(fake.leadCalls).toHaveLength(0);
  }, 180_000);

  it('charges same-head starts but never credits outputs when thinking or runtime changes', async () => {
    const fixture = integrityHarness('perkins-thinking-runtime');
    await fixture.prepare();
    const first = fixture.fake({ childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true });
    await fixture.wave('fixture-model-v1', first.spawner, 'high').runRound({ jobId: fixture.jobId });
    const changedThinking = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const second = asWave(await fixture.wave('fixture-model-v1', changedThinking.spawner, 'low').runRound({ jobId: fixture.jobId }));
    expect(changedThinking.leadCalls[0]?.prompt).not.toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(fixture.ledger.listRoundSpecialistStarts(second.round.id)).toHaveLength(1);
    const changedRuntime = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const third = asWave(await fixture.wave('fixture-model-v1', changedRuntime.spawner, 'high', 'fixture-runtime-v2')
      .runRound({ jobId: fixture.jobId }));
    expect(changedRuntime.leadCalls[0]?.prompt).not.toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(fixture.ledger.listRoundSpecialistStarts(third.round.id)).toHaveLength(1);
  }, 180_000);

  it('refuses a rewritten prior manifest even if its fields and self-hashes impersonate the current model', async () => {
    const fixture = integrityHarness('perkins-manifest-integrity');
    await fixture.prepare();
    const a = fixture.fake({ childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true });
    const first = asWave(await fixture.wave('fixture-model-v1', a.spawner).runRound({ jobId: fixture.jobId }));
    const manifestPath = join(first.artifactDirectory!, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      recoveryIdentity: { modelRef: string }; diffSha256: string; specSha256: string;
    };
    manifest.recoveryIdentity.modelRef = 'fixture-model-v2';
    // Self-consistent frozen-file hashes do not replace the ledger receipt.
    manifest.diffSha256 = createHash('sha256').update(readFileSync(join(first.artifactDirectory!, 'diff.patch'))).digest('hex');
    manifest.specSha256 = createHash('sha256').update(readFileSync(join(first.artifactDirectory!, 'spec-context.md'))).digest('hex');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const b = fixture.fake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const second = asWave(await fixture.wave('fixture-model-v2', b.spawner).runRound({ jobId: fixture.jobId }));
    expect(b.leadCalls[0]?.prompt).not.toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(fixture.ledger.listRoundSpecialistStarts(second.round.id)).toHaveLength(1);
    const receipt = fixture.ledger.uniqueRoundFreezeManifestReceipt(first.round.id);
    expect(receipt).not.toBeNull();
    fixture.ledger.appendCustomEvent({ kind: 'round.freeze-manifest', jobId: fixture.jobId, roundId: first.round.id,
      payload: { sha256: createHash('sha256').update(readFileSync(manifestPath)).digest('hex') } });
    expect(fixture.ledger.uniqueRoundFreezeManifestReceipt(first.round.id)).toBeNull();
  }, 180_000);

  it('does not jump past an incompatible interrupted identity to credit an older checkpoint', async () => {
    const repo = makeFixtureRepo('perkins-intervening-identity');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/intervening-identity']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-intervening-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-intervening-artifacts-'));
    const dbDir = mkdtempSync(join(tmpdir(), 'perkins-intervening-db-'));
    dirs.push(root, artifacts, dbDir);
    const db = new LedgerDb(dbDir);
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/intervening-identity', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-intervening-identity' });
    const job = ledger.addJob({
      id: 'job-intervening-identity', repo: 'fixture', title: 'intervening identity',
      baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const makeFake = (brain: WholeLeadOptions) => {
      const sessions = mkdtempSync(join(tmpdir(), 'perkins-intervening-sessions-'));
      dirs.push(sessions);
      return fakeWholeSpawner(sessions, brain);
    };
    const makeWave = (modelRef: string, spawner: AgentSpawner) => new WaveRunner({
      ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts,
      reconcileReviewAgent: async () => true,
      reviewRuntimeIdentity: () => ({ id: 'pi', version: 'fixture-runtime-v1' }),
      reviewPreflight: async () => ({ ok: true as const, failures: [],
        reviewModel: { role: 'perkins' as const, modelRef, settings: {}, authEnv: {}, routingSha256: "fixture-safe-route" } }),
    });
    const older = makeFake({
      childAnswer: () => JSON.stringify([groundedFinding('blind', 'warning')]),
      specialists: ['blind'], neverSubmit: true,
    });
    const first = asWave(await makeWave('fixture-model-v1', older.spawner).runRound({ jobId: job.id }));
    expect(first.round.status).toBe('aborted');
    expect(ledger.listRoundSpecialistStarts(first.round.id)).toHaveLength(1);
    const incompatible = makeFake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const second = asWave(await makeWave('fixture-model-v2', incompatible.spawner).runRound({ jobId: job.id }));
    expect(second.round.status).toBe('aborted');
    const newer = makeFake({ childAnswer: () => '[]', specialists: [], neverSubmit: true });
    const third = asWave(await makeWave('fixture-model-v1', newer.spawner).runRound({ jobId: job.id }));
    expect(third.round.status).toBe('aborted');
    const fresh = makeFake({ childAnswer: () => '[]', specialists: [], verdictOverride: 'INCOMPLETE' });
    const fourth = asWave(await makeWave('fixture-model-v1', fresh.spawner).runRound({ jobId: job.id }));
    expect(fourth.canonicalVerdict).toBe('INCOMPLETE');
    expect(fresh.leadCalls[0]?.prompt).not.toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(ledger.listRoundSpecialistStarts(fourth.round.id)).toHaveLength(1);
  }, 180_000);

  it('withholds a built-in verdict when PR delivery rejects or is absent', async () => {
    for (const mode of ['rejecting', 'absent'] as const) {
    const repo = makeFixtureRepo(`perkins-wave-post-${mode}`);
    repos.push(repo);
    repo.git(['checkout', '-b', `feature/post-${mode}`]);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), `perkins-post-${mode}-port-`));
    const artifacts = mkdtempSync(join(tmpdir(), `perkins-post-${mode}-artifacts-`));
    const sessions = mkdtempSync(join(tmpdir(), `perkins-post-${mode}-sessions-`));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), `perkins-post-${mode}-db-`)));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, `feature/post-${mode}`, target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: `job-post-${mode}` });
    const job = ledger.addJob({
      id: `job-post-${mode}`, repo: 'fixture', title: 'delivery gate', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/10');
    attachOrigin(repo, `feature/post-${mode}`, root);
    const escalations: string[] = [];
    const poster = mode === 'rejecting'
      ? { post: vi.fn(async () => { throw new Error('posting denied'); }) }
      : undefined;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(sessions, []),
      reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe(`feature/post-${mode}`),
      ...(poster === undefined ? {} : { poster }),
      escalate: (title) => escalations.push(title),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.verdict).toBeNull();
    expect(outcome.posted).toBe(false);
    expect(outcome.round.status).toBe('aborted');
    expect(existsSync(outcome.reportFile!)).toBe(true);
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')?.payload)
      .toMatchObject({ reason: 'report_not_posted' });
    expect(escalations.some((title) => title.includes('NOT posted'))).toBe(true);
    expect(port.getWorktree(outcome.round.id)?.status).toBe('swept');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
    }
  }, 180_000);

  it('freezes a detached tree, runs one lead plus tracked children, posts the exact-head report, and sweeps', async () => {
    const repo = makeFixtureRepo('perkins-wave-built-in');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-wave-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-wave-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-wave-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-wave-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/review', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-built-in' });
    const job = ledger.addJob({
      id: 'job-built-in', repo: 'fixture', title: 'full review', baseBranch: 'main',
      briefing: 'Acceptance: answer returns 43.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/9');
    attachOrigin(repo, 'feature/review', root);
    const order: string[] = [];
    // The poster's receipt simulates a PR whose recorded base has drifted
    // past the round's frozen base: the delivery record must refresh to the
    // delivered identity, never echo the frozen base.
    const deliveredBase = '9'.repeat(40);
    const poster = { post: vi.fn(async (input: { readonly prUrl: string; readonly body: string; readonly targetSha: string }) => {
      expect(ledger.listRounds(job.id).at(-1)).toMatchObject({ status: 'live', verdict: null });
      return {
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: input.targetSha,
        headSha: input.targetSha, baseSha: deliveredBase,
        bodySha256: createHash('sha256').update(input.body, 'utf8').digest('hex'),
      };
    }) };
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(sessions, order),
      poster,
      reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/review'),
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(outcome.verdict).toBe('changes-requested');
    expect(outcome.round.lenses.every((chip) => chip.state === 'done' && chip.agentId === null)).toBe(true);
    expect(outcome.headMoved).toBe(false);
    // One lead + nine catalog children + the retried security lens.
    expect(order.filter((entry) => entry.startsWith('model:'))).toHaveLength(11);
    // The retried security lens registers TWO distinct agent rows: the
    // second attempt is attempt-suffixed, never a duplicate label.
    const roundLabels = ledger
      .listAgents()
      .filter((agent) => agent.roundId === outcome.round.id)
      .map((agent) => agent.label);
    const securityLabels = roundLabels.filter((label) => label?.startsWith('security'));
    expect(securityLabels).toHaveLength(2);
    expect(securityLabels.some((label) => label?.endsWith('#2'))).toBe(true);
    expect(new Set(roundLabels).size).toBe(roundLabels.length);
    expect(order[0]).toBe('model:lead');
    expect(poster.post).toHaveBeenCalledTimes(1);
    expect(poster.post.mock.calls[0]![0]).toMatchObject({ targetSha: target });
    expect(poster.post.mock.calls[0]![0].body).toContain('NEEDS CHANGES');
    // The posted record carries the refreshed PR identity (the live base at
    // delivery), not the frozen review base.
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.posted')?.payload).toMatchObject({
      targetSha: target, baseSha: deliveredBase,
    });
    expect(port.getWorktree(outcome.round.id)?.status).toBe('swept');
    expect(existsSync(outcome.reportFile)).toBe(true);
    const events = ledger.listEvents({ limit: 200 });
    expect(events.some((event) => event.kind === 'round.perkins-review')).toBe(true);
    expect(events.some((event) => event.kind === 'round.head-moved')).toBe(false);
    // Admission preflight (gh-169): the pass is recorded with its complete
    // check list BEFORE any child starts, after the freeze receipts.
    const admissionEvent = events.find((event) => event.kind === 'round.admission-preflight');
    expect(admissionEvent?.roundId).toBe(outcome.round.id);
    expect(admissionEvent?.payload).toMatchObject({ ok: true });
    const checkNames = ((admissionEvent?.payload as { readonly checks?: Array<{ readonly name: string }> }).checks ?? []).map((check) => check.name);
    for (const expected of ['head-binding', 'frozen-packet:manifest.json', 'verification-evidence', 'ci-evidence']) {
      expect(checkNames, expected).toContain(expected);
    }
    const freezeReceipt = events.find((event) => event.kind === 'round.freeze-manifest');
    const firstStart = events.find((event) => event.kind === 'round.specialist-started');
    expect(freezeReceipt?.seq).toBeDefined();
    expect(admissionEvent!.seq).toBeGreaterThan(freezeReceipt!.seq);
    if (firstStart !== undefined) expect(admissionEvent!.seq).toBeLessThan(firstStart.seq);
    // The frozen spec carried the explicit verification-absence disclosure
    // (this job recorded no verification run) — never silence.
    const frozenSpec = readFileSync(join(artifacts, outcome.round.id, 'spec-context.md'), 'utf8');
    expect(frozenSpec).toContain('state: UNAVAILABLE — NO BOUND VERIFICATION RUN');
    expect(frozenSpec).toContain('--- HOST-RECORDED CI EVIDENCE');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });

  it('freezes recorded verification evidence into the review spec context (tests lens ground truth)', async () => {
    const repo = makeFixtureRepo('perkins-verification-evidence');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/evidence']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-evidence-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-evidence-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-evidence-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-evidence-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/evidence', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-evidence' });
    const job = ledger.addJob({
      id: 'job-evidence', repo: 'fixture', title: 'evidence', baseBranch: 'main',
      briefing: 'Acceptance: answer returns 43.',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    // The scheduler's recorded run on the exact frozen target.
    ledger.appendCustomEvent({
      kind: 'verification.completed',
      jobId: job.id,
      payload: {
        run_id: 'run-evidence',
        scope: 'full',
        command: 'npm test',
        sha: target,
        tracked_dirty: false,
        ok: true,
        exit_code: 0,
        signal: null,
        timed_out: false,
        duration_ms: 4321,
        workers: 6,
        output_bytes: 128,
        output_sha256: 'c'.repeat(64),
      },
    });
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(sessions, []),
      reviewArtifactRoot: artifacts,
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    const specContext = readFileSync(join(outcome.artifactDirectory, 'spec-context.md'), 'utf-8');
    expect(specContext).toContain('Acceptance: answer returns 43.');
    expect(specContext).toContain('HOST-RECORDED VERIFICATION');
    expect(specContext).toContain('result: PASS (exit 0)');
    expect(specContext).toContain(`sha: ${target} (matches the frozen review target)`);
    expect(specContext).toContain('duration_ms: 4321');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });

  it('invalidates a round when the source ref moves during lead work and never posts approval', async () => {
    const repo = makeFixtureRepo('perkins-wave-head-move');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-wave-move-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-wave-move-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-wave-move-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-wave-move-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/review', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-head-move' });
    const job = ledger.addJob({
      id: 'job-head-move', repo: 'fixture', title: 'movement', baseBranch: 'main', briefing: 'review',
    });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/10');
    attachOrigin(repo, 'feature/review', root);
    let moved = false;
    const poster = { post: vi.fn(async () => ({ headSha: 'unused-head', baseSha: 'unused-base' })) } as unknown as VerdictPoster;
    const spawner = fakeWholeSpawner(sessions, {
      onLeadStart: () => {
        if (moved) return;
        moved = true;
        repo.commitFile('src/later.ts', 'export const later = true;\n', 'move during review');
        // The PR head MOVES: origin advances past the frozen tip.
        repo.git(['push', '--quiet', 'origin', 'feature/review']);
      },
      childAnswer: () => '[]',
      submitRetries: 1,
      submitPayload: (attempt, submission) => attempt === 1 ? submission : {
        ...submission, verdict: 'INCOMPLETE',
        report_markdown: submission.report_markdown.replace(/\*\*Verdict: [^*]+\*\*/, '**Verdict: INCOMPLETE**'),
      },
    }).spawner;
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner, poster, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/review'),
    });

    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(moved).toBe(true);
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.verdict).toBeNull();
    expect(outcome.posted).toBe(false);
    expect(outcome.round.status).toBe('aborted');
    expect(poster.post).not.toHaveBeenCalled();
    expect(readFileSync(outcome.reportFile, 'utf8')).toContain('INCOMPLETE');
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.posted')).toBeNull();
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.head-moved')?.payload).toMatchObject({ cause: 'target-moved' });
    expect(port.getWorktree(outcome.round.id)?.status).toBe('swept');
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
    rmSync(sessions, { recursive: true, force: true });
  });
});

describe('WaveRunner delivery receipts, reconciliation, prior selection, and disclosure', () => {
  type ReceiptOverrides = Partial<{ reviewId: string; actor: string; event: string; commitId: string | null; headSha: string; baseSha: string; bodySha256: string }>;

  function receiptPoster(overrides: ReceiptOverrides = {}) {
    return {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
        ...overrides,
      })),
    };
  }

  it('refuses a poster receipt that is not bound to the reviewed head or body (B2/B5)', async () => {
    for (const forge of [
      { headSha: 'f'.repeat(40) },
      { commitId: 'f'.repeat(40) },
      { bodySha256: '0'.repeat(64) },
      { reviewId: '' },
      { actor: '' },
    ] as const) {
      const repo = makeFixtureRepo(`perkins-forged-${forge.toString().slice(0, 24)}`);
      repos.push(repo);
      repo.git(['checkout', '-b', 'feature/forged']);
      const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
      const root = mkdtempSync(join(tmpdir(), 'perkins-forged-port-'));
      const artifacts = mkdtempSync(join(tmpdir(), 'perkins-forged-artifacts-'));
      const sessions = mkdtempSync(join(tmpdir(), 'perkins-forged-sessions-'));
      dirs.push(root, artifacts, sessions);
      const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-forged-db-')));
      dbs.push(db);
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      const port = new GitReviewPort(root, 'feature/forged', target);
      await port.createJobWorktree({ repoPath: repo.path, jobId: `job-forged` });
      const job = ledger.addJob({ id: `job-forged`, repo: 'fixture', title: 'forged receipt', baseBranch: 'main', briefing: 'review' });
      ledger.setJobStatus(job.id, 'working');
      settleLane(ledger, job.id);
      ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/31');
    attachOrigin(repo, 'feature/forged', root);
      const escalations: string[] = [];
      const poster = receiptPoster({ ...forge });
      const wave = new WaveRunner({
        ledger, worktrees: port, spawner: makeSpawner(sessions, []), poster, reviewArtifactRoot: artifacts,
        escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
        prHeadProbe: localHeadProbe('feature/forged'),
      });
      const outcome = asWave(await wave.runRound({ jobId: job.id }));
      expect(outcome.canonicalVerdict, JSON.stringify(forge)).toBe('INCOMPLETE');
      expect(outcome.verdict).toBeNull();
      expect(outcome.posted).toBe(false);
      expect(outcome.round.status).toBe('aborted');
      expect(ledger.latestRoundEvent(outcome.round.id, 'round.posted')).toBeNull();
      expect(escalations.length).toBeGreaterThan(0);
    }
  }, 240_000);

  it('reconciles an ambiguous post failure against provider evidence without a duplicate post (B3)', async () => {
    const repo = makeFixtureRepo('perkins-reconcile');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/reconcile']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-reconcile-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-reconcile-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-reconcile-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-reconcile-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/reconcile', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-reconcile' });
    const job = ledger.addJob({ id: 'job-reconcile', repo: 'fixture', title: 'reconcile', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/32');
    attachOrigin(repo, 'feature/reconcile', root);
    const post = vi.fn(async () => { throw new Error('gh api review delivery exited 1: simulated timeout after commit'); });
    const reconcile = vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
      reviewId: '9002', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
      headSha: call.targetSha, baseSha: 'b'.repeat(40),
      bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
    }));
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), poster: { post, reconcile }, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/reconcile') as ReturnType<typeof localHeadProbe>,
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(outcome.posted).toBe(true);
    expect(outcome.verdict).toBe('changes-requested');
    expect(outcome.round.status).toBe('verdict-posted');
    const posted = ledger.latestRoundEvent(outcome.round.id, 'round.posted')?.payload as { receipt?: { reviewId?: string }; reconciled?: boolean };
    expect(posted.receipt?.reviewId).toBe('9002');
    expect(posted.reconciled).toBe(true);
    expect(escalations).toEqual([]);
  });

  it('stays honestly unposted when reconciliation finds no matching provider review (B3)', async () => {
    const repo = makeFixtureRepo('perkins-reconcile-absent');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/reconcile-absent']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-rabs-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-rabs-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-rabs-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-rabs-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/reconcile-absent', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-rabs' });
    const job = ledger.addJob({ id: 'job-rabs', repo: 'fixture', title: 'reconcile absent', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/33');
    attachOrigin(repo, 'feature/reconcile-absent', root);
    const post = vi.fn(async () => { throw new Error('network died'); });
    const reconcile = vi.fn(async () => null);
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), poster: { post, reconcile }, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/reconcile-absent'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.posted).toBe(false);
    expect(outcome.verdict).toBeNull();
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(escalations.some((line) => line.includes('NOT posted safely'))).toBe(true);
    // Even an exhausted lookup with NO match keeps the do-not-retry
    // caution: a just-created review can lag a provider listing, so null
    // absence is not permission to retry blindly (R31).
    expect(escalations.some((line) => line.includes('verify manually before any retry'))).toBe(true);
  });

  it('refuses a provider receipt without a base binding and stays honestly unposted (R34)', async () => {
    const repo = makeFixtureRepo('perkins-missing-base-receipt');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/missing-base-receipt']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-mbase-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-mbase-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-mbase-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-mbase-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/missing-base-receipt', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-mbase' });
    const job = ledger.addJob({ id: 'job-mbase', repo: 'fixture', title: 'missing base receipt', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/41');
    attachOrigin(repo, 'feature/missing-base-receipt', root);
    // An otherwise valid receipt whose base is the shape the shared restart
    // reader rejects: the writer must refuse it, never persist an event
    // recovery cannot parse.
    const post = vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
      reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
      headSha: call.targetSha, baseSha: '',
      bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
    }));
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), poster: { post }, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/missing-base-receipt'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.posted).toBe(false);
    expect(outcome.verdict).toBeNull();
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.posted')).toBeNull();
    const incomplete = ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')?.payload as { reason?: string; error?: string };
    expect(incomplete?.reason).toBe('report_not_posted');
    expect(incomplete?.error).toContain('missing the base binding');
    expect(escalations.some((line) => line.includes('missing the base binding'))).toBe(true);
  });

  it('carries the reconciliation failure and its manual-verification warning into the durable record (R31)', async () => {
    const repo = makeFixtureRepo('perkins-reconcile-failure');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/reconcile-failure']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-rcfail-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-rcfail-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-rcfail-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-rcfail-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/reconcile-failure', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-rcfail' });
    const job = ledger.addJob({ id: 'job-rcfail', repo: 'fixture', title: 'reconcile failure', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/34');
    attachOrigin(repo, 'feature/reconcile-failure', root);
    const post = vi.fn(async () => { throw new Error('network died after commit'); });
    const reconcile = vi.fn(async () => {
      throw new Error('GitHub review reconciliation exceeded the 10-page lookup bound without exhausting the review list; delivery stays unresolved');
    });
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), poster: { post, reconcile }, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/reconcile-failure'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.posted).toBe(false);
    expect(outcome.verdict).toBeNull();
    expect(reconcile).toHaveBeenCalledTimes(1);
    // The escalation names BOTH failures, not just the original POST error.
    const escalation = escalations.find((line) => line.includes('NOT posted safely')) ?? '';
    expect(escalation).toContain('reconciliation after the ambiguous post ALSO failed');
    expect(escalation).toContain('exceeded the 10-page lookup bound');
    expect(escalation).toContain('verify manually before any retry');
    // ...and so does the persisted round.perkins-incomplete record.
    const incomplete = ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')?.payload as { reason?: string; error?: string };
    expect(incomplete?.reason).toBe('report_not_posted');
    expect(incomplete?.error).toContain('reconciliation after the ambiguous post ALSO failed');
    expect(incomplete?.error).toContain('exceeded the 10-page lookup bound');
    expect(incomplete?.error).toContain('verify manually before any retry');
  });

  /** Advance local `main` by one commit without touching the reviewed
   * branch or any checkout: a merge landing on the base mid-round. */
  function advanceMain(repo: FixtureRepo): string {
    const next = repo.git([
      '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid',
      'commit-tree', 'main^{tree}', '-p', 'main', '-m', 'main advances during review',
    ]);
    repo.git(['update-ref', 'refs/heads/main', next]);
    return next;
  }

  async function baseAdvanceFixture(name: string, branch: string, pr: number) {
    const repo = makeFixtureRepo(name);
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', branch]);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), `${name}-port-`));
    const artifacts = mkdtempSync(join(tmpdir(), `${name}-artifacts-`));
    const sessions = mkdtempSync(join(tmpdir(), `${name}-sessions-`));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), `${name}-db-`)));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, branch, target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: `job-${name}` });
    const job = ledger.addJob({ id: `job-${name}`, repo: 'fixture', title: name, baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, `https://git.example.invalid/acme/fixture/pull/${pr}`);
    attachOrigin(repo, branch, root);
    return { repo, base, target, ledger, port, artifacts, sessions, job };
  }

  /** A provider receipt for the reviewed head carrying the live base at
   * its identity probe, not a subsequent advance during delivery. */
  function liveBaseReceipt(reviewId: string, call: { readonly body: string; readonly targetSha: string }, liveBase: string) {
    return {
      reviewId, actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
      headSha: call.targetSha, baseSha: liveBase,
      bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
    };
  }

  function expectRecordedWithFrozenBase(
    fixture: Awaited<ReturnType<typeof baseAdvanceFixture>>,
    outcome: WaveOutcome,
    expected: { readonly reviewId: string; readonly reconciled: boolean; readonly observedBase: string },
  ): void {
    const liveBase = fixture.repo.git(['rev-parse', 'main']);
    expect(liveBase).not.toBe(fixture.base);
    expect(outcome.headMoved).toBe(false);
    expect(outcome.posted).toBe(true);
    expect(outcome.verdict).toBe('changes-requested');
    expect(outcome.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(outcome.round.status).toBe('verdict-posted');
    const posted = fixture.ledger.latestRoundEvent(outcome.round.id, 'round.posted')?.payload as {
      targetSha?: string; baseSha?: string; reconciled?: boolean; receipt?: { reviewId?: string; baseSha?: string };
    } | undefined;
    expect(posted?.receipt?.reviewId).toBe(expected.reviewId);
    expect(posted?.reconciled).toBe(expected.reconciled);
    // Delivery stays bound to the reviewed target; the receipt carries the
    // base observed before POST/reconciliation, while the frozen base stays
    // provenance and main may advance again before the record is written.
    expect(posted?.targetSha).toBe(fixture.target);
    expect(posted?.baseSha).toBe(expected.observedBase);
    expect(posted?.receipt?.baseSha).toBe(expected.observedBase);
    expect(posted?.baseSha).not.toBe(liveBase);
    const recorded = fixture.ledger.latestRoundEvent(outcome.round.id, 'round.perkins-review')?.payload as Record<string, unknown> | undefined;
    expect(recorded).toMatchObject({
      targetSha: fixture.target, baseRefSha: fixture.base, diffBaseSha: fixture.base, headMoved: false, complete: true,
    });
    const manifest = JSON.parse(readFileSync(join(outcome.artifactDirectory, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ baseRef: 'main', baseRefSha: fixture.base, diffBaseSha: fixture.base, targetSha: fixture.target });
    expect(existsSync(join(outcome.artifactDirectory, 'perkins-report.reconciled-unrecorded.json'))).toBe(false);
  }

  it('reports base-rewritten when main is replaced by an orphan during lead work', async () => {
    const fixture = await baseAdvanceFixture('perkins-base-rewrite-lead', 'feature/base-rewrite-lead', 40);
    const post = vi.fn(async () => { throw new Error('a rewritten base must not post'); });
    let rewritten = false;
    const spawner = fakeWholeSpawner(fixture.sessions, {
      onLeadStart: () => {
        const orphan = fixture.repo.git([
          '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid',
          'commit-tree', 'main^{tree}', '-m', 'base rewritten during review',
        ]);
        fixture.repo.git(['update-ref', 'refs/heads/main', orphan]);
        rewritten = true;
      },
      childAnswer: () => '[]',
      submitRetries: 1,
      submitPayload: (attempt, submission) => attempt === 1 ? submission : {
        ...submission, verdict: 'INCOMPLETE',
        report_markdown: submission.report_markdown.replace(/\*\*Verdict: [^*]+\*\*/, '**Verdict: INCOMPLETE**'),
      },
    }).spawner;
    const wave = new WaveRunner({
      ledger: fixture.ledger, worktrees: fixture.port, spawner,
      poster: { post }, reviewArtifactRoot: fixture.artifacts,
      prHeadProbe: localHeadProbe('feature/base-rewrite-lead'),
    });
    const outcome = asWave(await wave.runRound({ jobId: fixture.job.id }));
    expect(rewritten).toBe(true);
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.headMoved).toBe(true);
    expect(outcome.posted).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(fixture.ledger.latestRoundEvent(outcome.round.id, 'round.head-moved')?.payload).toMatchObject({
      cause: 'base-rewritten',
      detail: expect.stringContaining('no longer descends'),
    });
  });

  it('records a conclusive review when only the base advances during lead work and inside POST', async () => {
    const fixture = await baseAdvanceFixture('perkins-base-advance-post', 'feature/base-advance-post', 36);
    let advancedDuringLead = false;
    let observedBase = '';
    const post = vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => {
      observedBase = fixture.repo.git(['rev-parse', 'main']);
      advanceMain(fixture.repo);
      return liveBaseReceipt('9300', call, observedBase);
    });
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger: fixture.ledger, worktrees: fixture.port,
      spawner: makeSpawner(fixture.sessions, [], () => {
        advanceMain(fixture.repo);
        advancedDuringLead = true;
      }),
      poster: { post }, reviewArtifactRoot: fixture.artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/base-advance-post'),
    });
    const outcome = asWave(await wave.runRound({ jobId: fixture.job.id }));
    expect(advancedDuringLead).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(observedBase).not.toBe(fixture.base); // lead advance was visible at the identity probe
    expectRecordedWithFrozenBase(fixture, outcome, { reviewId: '9300', reconciled: false, observedBase });
    expect(escalations).toEqual([]);
  });

  it('records a reconciled delivery when POST throws and the base advances inside the reconcile lookup', async () => {
    const fixture = await baseAdvanceFixture('perkins-base-advance-reconcile', 'feature/base-advance-reconcile', 37);
    const post = vi.fn(async () => { throw new Error('gh api review delivery exited 1: simulated timeout after commit'); });
    let observedBase = '';
    const reconcile = vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => {
      observedBase = fixture.repo.git(['rev-parse', 'main']);
      advanceMain(fixture.repo);
      return liveBaseReceipt('9301', call, observedBase);
    });
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger: fixture.ledger, worktrees: fixture.port, spawner: makeSpawner(fixture.sessions, []),
      poster: { post, reconcile }, reviewArtifactRoot: fixture.artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/base-advance-reconcile'),
    });
    const outcome = asWave(await wave.runRound({ jobId: fixture.job.id }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(observedBase).toBe(fixture.base); // the base advanced only after reconciliation began
    expectRecordedWithFrozenBase(fixture, outcome, { reviewId: '9301', reconciled: true, observedBase });
    expect(escalations).toEqual([]);
  });

  /** Push a new commit (same tree, parent = frozen target) to origin's PR
   * branch: the reviewed target moves on the host mid-delivery. */
  function pushMovedTarget(fixture: Awaited<ReturnType<typeof baseAdvanceFixture>>, branch: string): void {
    const next = fixture.repo.git([
      '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid',
      'commit-tree', `${fixture.target}^{tree}`, '-p', fixture.target, '-m', 'target moves during delivery',
    ]);
    fixture.repo.git(['push', '--quiet', 'origin', `${next}:refs/heads/${branch}`]);
  }

  it('refuses to record a delivery when the target is pushed inside POST or inside the reconcile lookup', async () => {
    // (a) POST returns a valid receipt, but the target moved while it was
    // outstanding: the post-delivery guard refuses the recording.
    const inPost = await baseAdvanceFixture('perkins-target-push-post', 'feature/target-push-post', 38);
    const post = vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => {
      pushMovedTarget(inPost, 'feature/target-push-post');
      return liveBaseReceipt('9302', call, inPost.base);
    });
    const postEscalations: string[] = [];
    const postWave = new WaveRunner({
      ledger: inPost.ledger, worktrees: inPost.port, spawner: makeSpawner(inPost.sessions, []),
      poster: { post }, reviewArtifactRoot: inPost.artifacts,
      escalate: (title, detail) => postEscalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/target-push-post'),
    });
    const postOutcome = asWave(await postWave.runRound({ jobId: inPost.job.id }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(postOutcome.posted).toBe(false);
    expect(postOutcome.verdict).toBeNull();
    expect(postOutcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(postOutcome.headMoved).toBe(true);
    expect(inPost.ledger.latestRoundEvent(postOutcome.round.id, 'round.posted')).toBeNull();
    expect(postEscalations.some((line) => line.includes('source changed while the report was being delivered (target-moved:'))).toBe(true);
    // (b) POST throws; the target moves while the reconcile lookup is
    // outstanding: the found receipt is kept unrecorded with the exact reason.
    const inReconcile = await baseAdvanceFixture('perkins-target-push-reconcile', 'feature/target-push-reconcile', 39);
    const failingPost = vi.fn(async () => { throw new Error('gh api review delivery exited 1: simulated timeout after commit'); });
    const reconcile = vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => {
      pushMovedTarget(inReconcile, 'feature/target-push-reconcile');
      return liveBaseReceipt('9303', call, inReconcile.base);
    });
    const reconcileWave = new WaveRunner({
      ledger: inReconcile.ledger, worktrees: inReconcile.port, spawner: makeSpawner(inReconcile.sessions, []),
      poster: { post: failingPost, reconcile }, reviewArtifactRoot: inReconcile.artifacts,
      prHeadProbe: localHeadProbe('feature/target-push-reconcile'),
    });
    const reconcileOutcome = asWave(await reconcileWave.runRound({ jobId: inReconcile.job.id }));
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcileOutcome.posted).toBe(false);
    expect(reconcileOutcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(reconcileOutcome.headMoved).toBe(true);
    expect(inReconcile.ledger.latestRoundEvent(reconcileOutcome.round.id, 'round.posted')).toBeNull();
    const unrecorded = JSON.parse(readFileSync(join(reconcileOutcome.artifactDirectory, 'perkins-report.reconciled-unrecorded.json'), 'utf8')) as {
      recorded?: boolean; reason?: string; receipt?: { reviewId?: string };
    };
    expect(unrecorded.recorded).toBe(false);
    expect(unrecorded.reason).toMatch(/^source changed while the reconciliation lookup was outstanding \(target-moved: .+\)$/);
    expect(unrecorded.receipt?.reviewId).toBe('9303');
  });

  it('fails loudly when the newest completed predecessor record is missing (B9)', async () => {
    const repo = makeFixtureRepo('perkins-prior-missing');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/prior-missing']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-pmiss-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-pmiss-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-pmiss-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-pmiss-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/prior-missing', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-pmiss' });
    const job = ledger.addJob({ id: 'job-pmiss', repo: 'fixture', title: 'prior missing', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/35');
    attachOrigin(repo, 'feature/prior-missing', root);
    // Round 1 completes and posts...
    const first = asWave(await new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(mkdtempSync(join(tmpdir(), 'perkins-pmiss-s1-')), []),
      poster: receiptPoster(), reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/prior-missing'),
    }).runRound({ jobId: job.id }));
    expect(first.round.status).toBe('verdict-posted');
    // ...then its consolidated record disappears before any new spawn.
    const priorFile = join(artifacts, first.round.id, 'consolidated.json');
    const priorBytes = readFileSync(priorFile);
    rmSync(priorFile);
    const escalations: string[] = [];
    const originalSpawner = makeSpawner(mkdtempSync(join(tmpdir(), 'perkins-pmiss-s2-')), []);
    const secondSpawner = vi.fn((...args: Parameters<AgentSpawner>) => originalSpawner(...args));
    const second = asWave(await new WaveRunner({
      ledger, worktrees: port, spawner: secondSpawner,
      poster: receiptPoster(), reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/prior-missing'),
    }).runRound({ jobId: job.id }));
    expect(second.canonicalVerdict).toBe('INCOMPLETE');
    expect(second.round.status).toBe('aborted');
    expect(secondSpawner).not.toHaveBeenCalled();
    expect(ledger.uniqueRoundNoSpawnReceipt(second.round.id)).not.toBeNull();
    expect(ledger.listRoundSpecialistStarts(second.round.id)).toHaveLength(0);
    expect(escalations.some((line) => line.includes(`required prior review record for round ${first.round.id}`))).toBe(true);
    writeFileSync(priorFile, priorBytes);
    const retrySpawner = makeSpawner(mkdtempSync(join(tmpdir(), 'perkins-pmiss-retry-')), []);
    const resumed = asWave(await new WaveRunner({ ledger, worktrees: port, spawner: retrySpawner,
      poster: receiptPoster(), reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/prior-missing'),
    }).runRound({ jobId: job.id, force: true }));
    expect(resumed.round.id).not.toBe(second.round.id);
    expect(resumed.round.status).toBe('verdict-posted');
    expect(ledger.uniqueRoundNoSpawnReceipt(resumed.round.id)).toBeNull();
  });

  it('publishes the host-owned execution/findings disclosure appendix with the review (B10)', async () => {
    const repo = makeFixtureRepo('perkins-appendix');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/appendix']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-appendix-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-appendix-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-appendix-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-appendix-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/appendix', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-appendix' });
    const job = ledger.addJob({ id: 'job-appendix', repo: 'fixture', title: 'appendix', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    // A github.com-shaped PR: the CI receipt is repo/PR-bound, so a real
    // recorded failure can freeze as the round's measured CI state.
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/34');
    attachOrigin(repo, 'feature/appendix', root);
    // P10 (gh-169): freeze a MEASURED CI FAILURE at the exact target so the
    // posted body's CI state line is asserted against the real posting
    // path, not only the appendix helper.
    ledger.appendCustomEvent({
      kind: 'github.ci-failed',
      jobId: job.id,
      payload: {
        repo: 'acme/fixture',
        pr: 34,
        sha: target,
        failures: [{ name: 'unit-tests', conclusion: 'failure', url: null }],
      },
    });
    // Security reports the canonical blocker; the tests specialist fails
    // both attempts; several lenses stay unused.
    const poster = receiptPoster();
    let securityAttempts = 0;
    const wave = new WaveRunner({
      ledger, worktrees: port,
      spawner: fakeWholeSpawner(sessions, {
        childAnswer: (prompt) => {
          const source = /"source": "(security|tests)"/u.exec(prompt)?.[1];
          if (source === 'security') {
            // Malformed once, then the canonical verified blocker: the done
            // lens note must retain the earlier failed attempt (T12).
            securityAttempts += 1;
            if (securityAttempts === 1) return 'malformed first attempt';
            return JSON.stringify([{
              source: 'security', severity: 'blocker', category: 'auth', title: 'Verified security defect',
              location: 'src/main.ts:2', evidence: '  return 43;', detail: 'The changed line demonstrates the security defect.',
              recommended_fix: 'Correct the implementation and add a regression test.',
            }]);
          }
          if (source === 'tests') return 'malformed output';
          return '[]';
        },
        specialists: ['security', 'tests', 'edge'],
      }).spawner,
      poster,
      reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/appendix'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.verdict).toBe('changes-requested');
    const postedBody = poster.post.mock.calls[0]?.[0]?.body as string;
    expect(postedBody).toContain('## Execution and findings (host-recorded facts)');
    expect(postedBody).toContain('- Retained findings: 1 (1 blocker)');
    expect(postedBody).toContain('Verified security defect');
    expect(postedBody).toContain('- Failed specialist attempts: security ×1, tests ×2');
    // P10: the posted body states the FROZEN CI evidence distinctly — a
    // measured failure is published as FAILED, never softened and never
    // rendered as the NOT RECORDED placeholder.
    expect(postedBody).toContain('- CI evidence at freeze: FAILED — NOT PASS (1 retained failing check(s): unit-tests)');
    expect(postedBody).not.toContain('NOT RECORDED');
    expect(postedBody).not.toContain('UNAVAILABLE');
    expect(postedBody).toContain('- Specialist attempts started: 5 journaled (2 valid, 3 failed) across 3 of 9 available lenses');
    expect(postedBody).toContain('- Lenses not used this round:');
    expect(postedBody).toContain('authenticated COMMENT review on the reviewed commit');
    // R16: the persisted round.posted receipt pins the actual actor/event —
    // removing them from the ledger writer would fail this test.
    const postedEvent = ledger.latestRoundEvent(outcome.round.id, 'round.posted')?.payload as {
      receipt?: { actor?: string; event?: string; reviewId?: string };
    };
    expect(postedEvent.receipt?.actor).toBe('gru-bot');
    expect(postedEvent.receipt?.event).toBe('COMMENTED');
    expect(postedEvent.receipt?.reviewId).toBe('9001');
    // T12: a lens that failed once then succeeded keeps its earlier failure
    // visible in the persisted lens note (security malformed once).
    const securityChip = ledger.getRound(outcome.round.id)?.lenses.find((chip) => chip.lens === 'security');
    expect(securityChip?.state).toBe('done');
    expect(securityChip?.note).toContain('earlier failed attempts: a1 output');
  });

  it('publishes truthful no-spec coverage at the caller boundary: eight available lenses, no phantom acceptance (gh-164)', async () => {
    const repo = makeFixtureRepo('perkins-nospec-appendix');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/nospec-appendix']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-nospec-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-nospec-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-nospec-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-nospec-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/nospec-appendix', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-nospec' });
    const job = ledger.addJob({ id: 'job-nospec', repo: 'fixture', title: 'nospec appendix', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/35');
    attachOrigin(repo, 'feature/nospec-appendix', root);
    const poster = receiptPoster();
    const wave = new WaveRunner({
      ledger, worktrees: port,
      spawner: fakeWholeSpawner(sessions, { childAnswer: () => '[]', specialists: ['blind'] }).spawner,
      poster,
      reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/nospec-appendix'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id, noSpec: true }));
    // The round's OWN chips are the no-spec catalog: acceptance was never
    // available, so it can neither be run nor reported as unused.
    expect(outcome.round.lenses.map((chip) => chip.lens)).toEqual([
      'blind', 'edge', 'security', 'architecture', 'codebase', 'tests', 'performance', 'operations',
    ]);
    const postedBody = poster.post.mock.calls[0]?.[0]?.body as string;
    expect(postedBody).toContain('- Available specialist lenses this round: 8');
    expect(postedBody).toContain('- Lenses not used this round: edge, security, architecture, codebase, tests, performance, operations');
    expect(postedBody).not.toContain('acceptance');
  });

  it('a REAL App publisher reconciling a failed POST never credits a stale identical review — no round.posted, no verdict (App seam)', async () => {
    // r1 finding 2 end-to-end: WaveRunner calls poster.reconcile after the
    // failed post; the App publisher's attempt-constrained second lookup
    // must leave the provider's stale identical review uncredited, so the
    // round stays honestly unposted (no round.posted event, no recorded
    // verdict, no approval completion).
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const home = mkdtempSync(join(tmpdir(), 'perkins-app-seam-home-'));
    dirs.push(home);
    mkdirSync(join(home, 'perkins'), { recursive: true });
    chmodSync(join(home, 'perkins'), 0o700);
    writeFileSync(join(home, 'perkins', 'app-key.pem'), privateKey, 'utf8');
    chmodSync(join(home, 'perkins', 'app-key.pem'), 0o600);
    const configPath = join(home, 'perkins', 'config');
    writeFileSync(configPath, 'app_id=424242\nkey_path="app-key.pem"\ninstallation_id_acme=164552969\n', 'utf8');
    chmodSync(configPath, 0o600);

    const repo = makeFixtureRepo('perkins-app-seam');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/app-seam']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    // The App publisher binds credentials to the PR URL's origin: an
    // ssh-form github.com origin satisfies the identity check. The freeze
    // and drift checks still FETCH that origin and cross-check the local
    // head probe, so the fixture binds the ssh transport to a local bare
    // repo via core.sshCommand — every production freshness check runs,
    // with no network. The delivery itself rides the mocked fetch.
    const originRoot = mkdtempSync(join(tmpdir(), 'perkins-app-seam-origin-'));
    dirs.push(originRoot);
    const origin = join(originRoot, 'origin.git');
    execFileSync('git', ['init', '--bare', '--quiet', origin], { stdio: 'ignore' });
    repo.git(['remote', 'add', 'origin', 'git@github.com:acme/widget.git']);
    repo.git(['push', '--quiet', origin, 'refs/heads/feature/app-seam']);
    const sshDouble = join(originRoot, 'ssh-double.sh');
    writeFileSync(sshDouble, `#!/bin/sh\nexec git-upload-pack ${JSON.stringify(origin)}\n`, 'utf8');
    chmodSync(sshDouble, 0o755);
    repo.git(['config', 'core.sshCommand', sshDouble]);

    const NOW = 1_800_000_000_000;
    let postCount = 0;
    let lookupCount = 0;
    let allRequests = 0;
    let deliveredBody = '';
    const fetchImpl: AppFetch = async (url, init: AppFetchInit = {}) => {
      const method = init.method ?? 'GET';
      allRequests += 1;
      const json = (status: number, body: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body),
      });
      if (method === 'GET' && /\/app$/.test(url)) {
        return json(200, { id: 424242, slug: 'perkins-review', owner: { login: 'solarity-services' } });
      }
      if (method === 'POST' && /\/app\/installations\/164552969\/access_tokens$/.test(url)) {
        return json(201, {
          token: `ghs_${'S'.repeat(36)}`,
          expires_at: new Date(NOW + 3_600_000).toISOString(),
          permissions: { 'pull_requests': 'write', 'metadata': 'read' },
          repositories: [{ full_name: 'acme/widget', id: 1 }],
        });
      }
      if (method === 'GET' && /\/repos\/acme\/widget\/pulls\/7$/.test(url)) {
        return json(200, { number: 7, head: { sha: target }, base: { sha: 'b'.repeat(40) } });
      }
      if (method === 'POST' && /\/repos\/acme\/widget\/pulls\/7\/reviews$/.test(url)) {
        postCount += 1;
        deliveredBody = typeof init.body === 'string' ? (JSON.parse(init.body) as { body?: string }).body ?? '' : '';
        throw new Error('socket hang up after send');
      }
      if (method === 'GET' && /\/repos\/acme\/widget\/pulls\/7\/reviews\?/.test(url)) {
        lookupCount += 1;
        // ONLY a stale identical App review: submitted an hour before this
        // round's POST. An unconstrained second lookup would credit it.
        return json(200, [{
          id: 555666,
          user: { login: 'perkins-review[bot]', type: 'Bot', id: 308038895 },
          commit_id: target,
          state: 'COMMENTED',
          body: deliveredBody,
          submitted_at: new Date(NOW - 3_600_000).toISOString(),
        }]);
      }
      return json(404, { message: `no test route for ${method} ${url}` });
    };
    // The REAL production path: AutoVerdictPoster selecting the real App
    // publisher — so the post-failure caller context must travel through
    // AutoVerdictPoster.reconcile to the same selected backend, not just
    // to a directly injected double.
    const poster = new AutoVerdictPoster(new PerkinsAppPrPoster({ instanceDir: home, fetchImpl, now: () => NOW }));

    const root = mkdtempSync(join(tmpdir(), 'perkins-app-seam-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-app-seam-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-app-seam-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-app-seam-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/app-seam', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-app-seam' });
    const job = ledger.addJob({ id: 'job-app-seam', repo: 'fixture', title: 'app seam', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/widget/pull/7');
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), poster, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/app-seam') as ReturnType<typeof localHeadProbe>,
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    // Exactly one POST (never a duplicate) and exactly ONE reviews lookup:
    // post()'s own bounded strict-window reconciliation. A second lookup
    // would prove the post-failure context never reached the selected App
    // (ordinary recovery would then also CREDIT the stale review and
    // record round.posted).
    expect(postCount).toBe(1);
    expect(lookupCount).toBe(1);
    // The WHOLE provider interaction is exactly the five requests of one
    // post attempt (App identity, token mint, PR identity, the failed
    // POST, and post()'s single strict-window lookup): any additional
    // request — including anything the live second lookup might have sent
    // — fails this pin.
    expect(allRequests).toBe(5);
    // The stale identical review is NOT credited: honestly unposted.
    expect(outcome.posted).toBe(false);
    expect(outcome.round.status).not.toBe('verdict-posted');
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.posted')).toBeNull();
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')).not.toBeNull();
    expect(outcome.verdict ?? null).toBeNull();
    expect(escalations.length).toBeGreaterThanOrEqual(1);
  });

  it('reconciles an ambiguous post through the PRODUCTION adapter: same provider selection, single POST (T1)', async () => {
    const repo = makeFixtureRepo('perkins-adapter-reconcile');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/adapter-reconcile']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-adapt-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-adapt-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-adapt-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-adapt-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/adapter-reconcile', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-adapt' });
    const job = ledger.addJob({ id: 'job-adapt', repo: 'fixture', title: 'adapter reconcile', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/39');
    attachOrigin(repo, 'feature/adapter-reconcile', root);
    // The poster's origin check compares the PR URL against the review
    // worktree's origin remote: present the fixture as the github repo.
    repo.git(['remote', 'set-url', 'origin', 'https://github.com/acme/fixture.git']);
    // The gh double records what a provider-accepted-then-timed-out POST
    // looks like: the POST body is stored as a created review (provider
    // committed), the CLI exits 1, and the later /reviews list carries it.
    const ghRoot = mkdtempSync(join(tmpdir(), 'perkins-gh-adapt-'));
    dirs.push(ghRoot);
    const ghLog = join(ghRoot, 'calls.jsonl');
    const ghStore = join(ghRoot, 'created.json');
    const binary = join(ghRoot, 'gh-double.mjs');
    const repoPath = join(ghRoot, 'repo');
    execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://github.com/acme/fixture.git']);
    writeFileSync(binary, `#!/usr/bin/env node\nimport { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nappendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');\nconst argv = process.argv.slice(2);\nif (argv.includes('--method') && argv.includes('POST')) {\n  const body = JSON.parse(input);\n  writeFileSync(${JSON.stringify(ghStore)}, JSON.stringify({ id: 9100, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: body.commit_id, body: body.body }));\n  process.exit(1);\n} else if (argv.some((entry) => entry.includes('/reviews?'))) {\n  process.stdout.write(JSON.stringify(existsSync(${JSON.stringify(ghStore)}) ? [JSON.parse(readFileSync(${JSON.stringify(ghStore)}, 'utf8'))] : []));\n} else if (argv.includes('user') && !argv.some((entry) => entry.includes('/'))) {\n  process.stdout.write('gru-bot');\n} else {\n  process.stdout.write(${JSON.stringify(`${target}\t${'2'.repeat(40)}\n`)});\n}\n`, 'utf8');
    chmodSync(binary, 0o755);
    // PRODUCTION adapter with the real GitHub poster; the GitLeg provider
    // fails loud if the adapter ever selects it for a github.com URL.
    const gitlabWrong = new GitLabMrPoster({
      token: 'x',
      fetchImpl: async () => { throw new Error('gitlab poster selected for a github.com URL'); },
    });
    const adapter = new AutoVerdictPoster(new GhPrPoster(binary), gitlabWrong);
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), poster: adapter,
      reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/adapter-reconcile'),
    });
    // Explicit commit pin: the freeze needs no origin fetch (the github-form
    // origin below exists for the poster's repo-identity check).
    const outcome = asWave(await wave.runRound({ jobId: job.id, targetRef: target }));
    // One POST attempt, one reconciliation lookup — never a second POST.
    const ghCalls = readFileSync(ghLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] });
    expect(ghCalls.filter((call) => call.argv.includes('POST'))).toHaveLength(1);
    expect(ghCalls.filter((call) => call.argv.some((entry) => entry.includes('/reviews?')))).toHaveLength(1);
    expect(outcome.posted).toBe(true);
    expect(outcome.verdict).toBe('changes-requested');
    expect(outcome.round.status).toBe('verdict-posted');
    const posted = ledger.latestRoundEvent(outcome.round.id, 'round.posted')?.payload as {
      reconciled?: boolean; receipt?: { reviewId?: string; headSha?: string; commitId?: string };
    };
    expect(posted.reconciled).toBe(true);
    expect(posted.receipt?.reviewId).toBe('9100');
    expect(posted.receipt?.headSha).toBe(target);
    expect(posted.receipt?.commitId).toBe(target);
    expect(escalations).toEqual([]);
  });

  it('recovers a REAL writer round.posted event after a crash between publication and verdict (T2)', async () => {
    // The verdict write is lost exactly as a process crash loses it: the
    // round.posted event (real recordDelivery output) is durable, the
    // verdict never lands. No field is invented by the test.
    class CrashBeforeVerdictLedger extends LedgerApi {
      private crashed = false;
      override setRoundVerdict(id: string, verdict: string): ReturnType<LedgerApi['setRoundVerdict']> {
        if (!this.crashed) {
          this.crashed = true;
          // The write is lost exactly as a process crash loses it: no
          // throw (that would terminalize the round), the event log keeps
          // the durable round.posted fact, the verdict simply never lands.
          return this.getRound(id) as ReturnType<LedgerApi['setRoundVerdict']>;
        }
        return super.setRoundVerdict(id, verdict);
      }
    }
    const repo = makeFixtureRepo('perkins-crash-recovery');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/crash-recovery']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-crash-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-crash-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-crash-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-crash-db-')));
    dbs.push(db);
    const ledger = new CrashBeforeVerdictLedger(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/crash-recovery', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-crash' });
    const job = ledger.addJob({ id: 'job-crash', repo: 'fixture', title: 'crash recovery', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/40');
    attachOrigin(repo, 'feature/crash-recovery', root);
    const poster = receiptPoster();
    const first = new WaveRunner({
      ledger: ledger as unknown as LedgerApi, worktrees: port, spawner: makeSpawner(sessions, []),
      poster, reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/crash-recovery'),
    });
    const outcome = asWave(await first.runRound({ jobId: job.id }));
    // Publication happened and its event is the REAL writer output —
    // including the nested headSha recovery requires (the reviewed gap).
    expect(outcome.posted).toBe(true);
    const round = ledger.getRound(outcome.round.id);
    expect(round?.status).toBe('live');
    expect(round?.verdict).toBeNull();
    const postedEvent = ledger.latestRoundEvent(outcome.round.id, 'round.posted')?.payload as {
      publicationFile?: string; publicationSha256?: string;
      receipt?: { reviewId?: string; headSha?: string; bodySha256?: string };
    };
    expect(postedEvent.receipt?.headSha).toBe(target);
    expect(postedEvent.receipt?.bodySha256).toBe(postedEvent.publicationSha256);
    // Recovery consumes the ACTUAL persisted event and completes the round.
    const secondPoster = { post: vi.fn(), authenticatedActor: async () => 'gru-bot' } as unknown as VerdictPoster;
    // A REAL crash dies before runOwnedReview's finally sweeps the review
    // worktree; the sweep above only ran because the simulated crash let
    // the flow continue. Present the crash-time lane state (unswept) to
    // recovery through the same port interface.
    const crashTimePort: WorktreePort = {
      createJobWorktree: (input) => port.createJobWorktree(input),
      resolveReviewTarget: (input) => port.resolveReviewTarget(input),
      createReviewWorktree: (input) => port.createReviewWorktree(input),
      createChildWorktree: (input) => port.createChildWorktree(input),
      getWorktree: (id) => port.getWorktree(id),
      listWorktrees: (listOpts) => port.listWorktrees(listOpts).map((lane) =>
        lane.roundId === outcome.round.id && lane.status === 'swept' ? { ...lane, status: 'active' } : lane),
      release: (input) => port.release(input),
    };
    const second = new WaveRunner({
      ledger: ledger as unknown as LedgerApi, worktrees: crashTimePort,
      spawner: vi.fn() as unknown as AgentSpawner,
      poster: secondPoster, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/crash-recovery'),
    });
    expect(await second.recoverInterruptedRounds()).toBe(1);
    const recovered = ledger.getRound(outcome.round.id);
    expect(recovered?.status).toBe('verdict-posted');
    expect(recovered?.verdict).toBe('changes-requested');
    const recoveredEvent = ledger.latestRoundEvent(outcome.round.id, 'round.post-recovered')?.payload as { receipt?: { reviewId?: string } };
    expect(recoveredEvent?.receipt?.reviewId).toBe('9001');
    expect(secondPoster.post).not.toHaveBeenCalled();
  });

  it('refuses recovery promotion without the preserved publication artifact and digest (T3)', async () => {
    const target = '1'.repeat(40);
    const makeEvent = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      verdict: 'changes-requested', canonicalVerdict: 'NEEDS CHANGES', url: 'https://example.invalid/pr/1',
      targetSha: target, baseSha: '2'.repeat(40),
      receipt: { reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: target, headSha: target, bodySha256: '0'.repeat(64) },
      ...overrides,
    });
    const cases: ReadonlyArray<[string, (file: string, sha: string) => Record<string, unknown>, (artifactDir: string) => void]> = [
      ['publicationFile missing', (file, sha) => makeEvent({ publicationSha256: sha, receipt: { reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: target, headSha: target, bodySha256: sha } }), () => {}],
      ['publicationFile null', (_file, sha) => makeEvent({ publicationFile: null, publicationSha256: sha, receipt: { reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: target, headSha: target, bodySha256: sha } }), () => {}],
      ['publicationFile malformed', (_file, sha) => makeEvent({ publicationFile: 42, publicationSha256: sha, receipt: { reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: target, headSha: target, bodySha256: sha } }), () => {}],
      ['publication file deleted', (file, sha) => makeEvent({ publicationFile: file, publicationSha256: sha, receipt: { reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: target, headSha: target, bodySha256: sha } }), (dir) => { rmSync(join(dir, 'perkins-report.publication.md'), { force: true }); }],
      ['publication digest changed', (file, sha) => makeEvent({ publicationFile: file, publicationSha256: sha, receipt: { reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: target, headSha: target, bodySha256: sha } }), (dir) => { writeFileSync(join(dir, 'perkins-report.publication.md'), '# tampered\n', 'utf8'); }],
    ];
    for (const [label, payloadFor, mutate] of cases) {
      const root = mkdtempSync(join(tmpdir(), 'perkins-t3-port-'));
      const artifacts = mkdtempSync(join(tmpdir(), 'perkins-t3-artifacts-'));
      dirs.push(root, artifacts);
      const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-t3-db-')));
      dbs.push(db);
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      const repo = makeFixtureRepo(`perkins-t3-${label.replace(/\W+/gu, '-')}`);
      repos.push(repo);
      repo.git(['checkout', '-b', `feature/t3-${label.replace(/\W+/gu, '-')}`]);
      const commit = repo.commitFile('src/main.ts', 'export const three = 3;\n');
      const port = new GitReviewPort(root, `feature/t3-${label.replace(/\W+/gu, '-')}`, commit);
      await port.createJobWorktree({ repoPath: repo.path, jobId: `job-t3-${label.replace(/\W+/gu, '-')}` });
      const job = ledger.addJob({ id: `job-t3-${label.replace(/\W+/gu, '-')}`, repo: 'fixture', title: 't3', baseBranch: 'main', briefing: 'review' });
      ledger.setJobStatus(job.id, 'working');
      settleLane(ledger, job.id);
      const round = ledger.addRound({ jobId: job.id, lenses: ['blind'], targetRef: commit });
      await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: commit, jobId: job.id });
      ledger.setRoundStatus(round.id, 'live');
      const roundDir = join(artifacts, round.id);
      mkdirSync(roundDir, { recursive: true });
      const publicationFile = join(roundDir, 'perkins-report.publication.md');
      writeFileSync(publicationFile, '# Perkins Code Review\n\n**Verdict: NEEDS CHANGES**\n', 'utf8');
      const sha = createHash('sha256').update('# Perkins Code Review\n\n**Verdict: NEEDS CHANGES**\n', 'utf8').digest('hex');
      mutate(roundDir);
      ledger.appendCustomEvent({ kind: 'round.posted', jobId: job.id, roundId: round.id, payload: payloadFor(publicationFile, sha) });
      const escalations: string[] = [];
      const wave = new WaveRunner({
        ledger, worktrees: port, spawner: vi.fn() as unknown as never, poster: { post: vi.fn() },
        reviewArtifactRoot: artifacts,
        escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      });
      expect(await wave.recoverInterruptedRounds(), label).toBe(1);
      expect(ledger.getRound(round.id), label).toMatchObject({ status: 'aborted', verdict: null });
      expect(escalations.some((line) => line.includes('without a provider-bound receipt')), label).toBe(true);
      expect(ledger.latestRoundEvent(round.id, 'round.post-recovered'), label).toBeNull();
    }
  });

  it('does not record a reconciled delivery when the ref moved during the lookup (T4a)', async () => {
    // Split from the former composite T4 (moved + aborted in one body): each
    // scenario runs under its own unchanged body ceiling with its assertions
    // intact; main's observation-only T4-PHASE/T4-ATTR instrumentation is
    // retained per leg.
    // T4 phase evidence (phase pr144-t4-phase-evidence-20261001; test-local,
    // observation only): monotonic elapsed per named boundary, emitted as
    // bounded JSON lines so partial evidence survives an exceptional exit or
    // the unchanged 30000 ms bound. Emits stdout lines only; never alters
    // refs, ordering, mocks, or assertions.
    const t4Mark = (kase: 'moved' | 'aborted', phase: string, boundary: 'start' | 'end', outcome: string, elapsedMs?: number): void => {
      console.log(`T4-PHASE ${JSON.stringify({ case: kase, phase, boundary, outcome, ...(elapsedMs !== undefined ? { elapsedMs: Math.round(elapsedMs) } : {}) })}`);
    };
    const t4Timed = async <T>(kase: 'moved' | 'aborted', phase: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      t4Mark(kase, phase, 'start', 'begin');
      try {
        const result = await run();
        t4Mark(kase, phase, 'end', 'completed', performance.now() - started);
        return result;
      } catch (error) {
        t4Mark(kase, phase, 'end', error instanceof Error ? `rejected:${error.name}` : 'rejected', performance.now() - started);
        throw error;
      }
    };
    // Finer attribution (phase pr144-t4-deep-attribution-20261001; test-local,
    // observation only): T4-ATTR carries the absolute elapsed relative to this
    // test's monotonic start on EVERY boundary plus per-phase elapsed, and
    // subdivides fixture prep, the review-lifecycle boundaries this test
    // drives (head probe, native lead start, reconciliation lookup), and the
    // outside-body cleanup (emitted from the gated afterEach). Every real
    // call is forwarded exactly once; ordering, mocks, refs, and assertions
    // are untouched. The T4-PHASE marks above are emitted unchanged.
    // Nested intervals (reconcile-lookup inside wave-round) are reported
    // separately and are never summed into totals.
    const t4Start = performance.now();
    t4StartAt = t4Start;
    t4Observe = true;
    t4BodyCompleted = false;
    const t4Attr = (leg: 'moved' | 'aborted' | 'suite', phase: string, boundary: 'start' | 'end', extra?: { elapsedMs?: number; outcome?: string; note?: string }): void => {
      console.log(`T4-ATTR ${JSON.stringify({
        leg, phase, boundary, absMs: Math.round(performance.now() - t4Start),
        ...(extra?.elapsedMs !== undefined ? { elapsedMs: Math.round(extra.elapsedMs) } : {}),
        ...(extra?.outcome !== undefined ? { outcome: extra.outcome } : {}),
        ...(extra?.note !== undefined ? { note: extra.note } : {}),
      })}`);
    };
    // run() may settle synchronously (plain value) or asynchronously
    // (thenable); the awaited result is forwarded with its exact value and
    // type, exactly one invocation, unchanged error propagation and ordering.
    const t4Step = async <T>(leg: 'moved' | 'aborted', phase: string, run: () => T | Promise<T>): Promise<Awaited<T>> => {
      t4Attr(leg, phase, 'start');
      const started = performance.now();
      try {
        const result = await run();
        t4Attr(leg, phase, 'end', { elapsedMs: performance.now() - started, outcome: 'completed' });
        return result;
      } catch (error) {
        t4Attr(leg, phase, 'end', { elapsedMs: performance.now() - started, outcome: error instanceof Error ? `rejected:${error.name}` : 'rejected' });
        throw error;
      }
    };
    const t4Probe = (leg: 'moved' | 'aborted', branch: string): PrHeadProbe => {
      const inner = localHeadProbe(branch);
      return (input) => t4Step(leg, 'wave/head-probe', () => inner(input));
    };
    t4Attr('suite', 'test-start', 'start', { note: 'split T4a: moved discriminator, inherited 30000 ms bound unchanged; nested intervals are never summed' });
    const prepare = async (name: string, branch: string, leg: 'moved' | 'aborted') => {
      const repo = await t4Step(leg, 'fixture/repo-init', async () => makeFixtureRepo(name, (step) => t4Attr(leg, `fixture/repo-init.${step}`, 'end', { outcome: 'completed' })));
      repos.push(repo);
      await t4Step(leg, 'fixture/branch-create', async () => { repo.git(['checkout', '-b', branch]); });
      const target = await t4Step(leg, 'fixture/target-commit', () => {
        // Batched equivalent of commitFile's add+commit (phase
        // pr144-t4-cost-repair-20261001): one git process stages the file
        // and commits (`commit --include`), removing a Node-to-git spawn
        // per leg while keeping the identical Fixture Tests identity, the
        // identical default message, parent, and resulting tree/HEAD, and
        // the same loud non-zero failure propagation on any git error.
        const file = join(repo.path, 'src/main.ts');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, 'export function answer(): number {\n  return 44;\n}\n');
        repo.git([
          '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid',
          'commit', '--include', 'src/main.ts', '-m', 'fixture: update src/main.ts',
        ]);
        // The branch ref was just written loose by the commit above; the
        // loose read is value-identical to `git rev-parse HEAD` (HEAD is
        // the branch here) with an exact rev-parse fallback.
        return looseRefOrRevParse(repo.path, `refs/heads/${branch}`);
      });
      const temps = await t4Step(leg, 'fixture/tempdirs', () => {
        const root = mkdtempSync(join(tmpdir(), `${name}-port-`));
        const artifacts = mkdtempSync(join(tmpdir(), `${name}-artifacts-`));
        const sessions = mkdtempSync(join(tmpdir(), `${name}-sessions-`));
        dirs.push(root, artifacts, sessions);
        return { root, artifacts, sessions };
      });
      const root = temps.root;
      const artifacts = temps.artifacts;
      const sessions = temps.sessions;
      const ledger = await t4Step(leg, 'fixture/ledger-open', () => {
        const db = new LedgerDb(mkdtempSync(join(tmpdir(), `${name}-db-`)));
        dbs.push(db);
        return new LedgerApi(db.handle, { bus: new EventBus() });
      });
      const port = new GitReviewPort(root, branch, target);
      await t4Step(leg, 'fixture/worktree-create', () => port.createJobWorktree({ repoPath: repo.path, jobId: `job-${name}` }));
      const job = await t4Step(leg, 'fixture/lane-register', () => {
        const job = ledger.addJob({ id: `job-${name}`, repo: 'fixture', title: name, baseBranch: 'main', briefing: 'review' });
        ledger.setJobStatus(job.id, 'working');
        settleLane(ledger, job.id);
        ledger.setJobPr(job.id, `https://git.example.invalid/acme/fixture/pull/${name.length}`);
        return job;
      });
      await t4Step(leg, 'fixture/origin-push', async () => { attachOrigin(repo, branch, root, { batched: true }); });
      return { repo, ledger, port, artifacts, sessions, target, job, root };
    };
    // T4a: the base is rewritten (orphan) while the reconciliation lookup is
    // outstanding: the receipt is preserved, never recorded as delivery.
    const moved = await t4Timed('moved', 'fixture-prep', () => prepare('perkins-t4-moved', 'feature/t4-moved', 'moved'));
    const post = vi.fn(async () => { throw new Error('gh api review delivery exited 1: timeout'); });
    const reconcile = vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => {
      return t4Timed('moved', 'reconcile-lookup', async () => {
        // The base is rewritten (orphan) while the lookup is outstanding:
        // commit-tree without -p, so the new `main` no longer descends from
        // the frozen merge-base — the stale-source guard refMovedSinceFreeze
        // must refuse the recording.
        // commit-tree needs an explicit identity: CI runners have no global
        // git user (commitFile passes one the same way).
        const gitStarted = performance.now();
        t4Mark('moved', 'git-ops', 'start', 'begin');
        const newMain = moved.repo.git([
          '-c', 'user.name=T4 Fixture', '-c', 'user.email=t4@example.invalid',
          'commit-tree', 'main^{tree}', '-m', 'base moves during lookup',
        ]).trim();
        moved.repo.git(['branch', '-f', 'main', newMain]);
        t4Mark('moved', 'git-ops', 'end', 'completed', performance.now() - gitStarted);
        return {
          reviewId: '9200', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
          headSha: call.targetSha, baseSha: 'b'.repeat(40),
          bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
        };
      });
    });
    const escalations: string[] = [];
    const escalationContexts: (EscalationContext | undefined)[] = [];
    const movedWave = new WaveRunner({
      ledger: moved.ledger, worktrees: moved.port, spawner: makeSpawner(moved.sessions, [], () => t4Attr('moved', 'wave/lead-start', 'end', { outcome: 'completed', note: 'native lead child start on the original production path' }), undefined, '  return 44;'),
      poster: { post, reconcile }, reviewArtifactRoot: moved.artifacts,
      escalate: (title, detail, context) => {
        escalations.push(`${title}: ${detail}`);
        escalationContexts.push(context);
      },
      prHeadProbe: t4Probe('moved', 'feature/t4-moved'),
    });
    const movedOutcome = asWave(await t4Timed('moved', 'wave-round', () => movedWave.runRound({ jobId: moved.job.id })));
    expect(movedOutcome.posted).toBe(false);
    expect(movedOutcome.verdict).toBeNull();
    expect(movedOutcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(escalations.some((line) => line.includes('reconciled a provider review but did NOT record it'))).toBe(true);
    // Producer context: the reconciled-unrecorded escalation carries its
    // validated round/job identity for the notification binding (A4).
    expect(
      escalationContexts.some(
        (context) => context?.jobId === moved.job.id && context.roundId === movedOutcome.round.id,
      ),
    ).toBe(true);
    const unrecorded = JSON.parse(readFileSync(join(moved.artifacts, movedOutcome.round.id, 'perkins-report.reconciled-unrecorded.json'), 'utf8')) as { recorded?: boolean; reason?: string; receipt?: { reviewId?: string } };
    expect(unrecorded.recorded).toBe(false);
    expect(unrecorded.reason).toMatch(/^source changed while the reconciliation lookup was outstanding \(base-rewritten: .+\)$/);
    expect(unrecorded.receipt?.reviewId).toBe('9200');
    expect(moved.ledger.latestRoundEvent(movedOutcome.round.id, 'round.posted')).toBeNull();
    t4Attr('moved', 'leg', 'end', { outcome: 'completed', note: 'fixture-prep + wave-round + assertions; reconcile-lookup/git-ops are NESTED in wave-round — never summed' });
    t4BodyCompleted = true;
    t4Attr('suite', 'test-end', 'end', { outcome: 'completed' });
  });

  it('does not record a reconciled delivery when the run aborted during the lookup (T4b)', async () => {
    // Split from the former composite T4 (moved + aborted in one body): each
    // scenario runs under its own unchanged body ceiling with its assertions
    // intact; main's observation-only T4-PHASE/T4-ATTR instrumentation is
    // retained per leg.
    // T4 phase evidence (phase pr144-t4-phase-evidence-20261001; test-local,
    // observation only): monotonic elapsed per named boundary, emitted as
    // bounded JSON lines so partial evidence survives an exceptional exit or
    // the unchanged 30000 ms bound. Emits stdout lines only; never alters
    // refs, ordering, mocks, or assertions.
    const t4Mark = (kase: 'moved' | 'aborted', phase: string, boundary: 'start' | 'end', outcome: string, elapsedMs?: number): void => {
      console.log(`T4-PHASE ${JSON.stringify({ case: kase, phase, boundary, outcome, ...(elapsedMs !== undefined ? { elapsedMs: Math.round(elapsedMs) } : {}) })}`);
    };
    const t4Timed = async <T>(kase: 'moved' | 'aborted', phase: string, run: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      t4Mark(kase, phase, 'start', 'begin');
      try {
        const result = await run();
        t4Mark(kase, phase, 'end', 'completed', performance.now() - started);
        return result;
      } catch (error) {
        t4Mark(kase, phase, 'end', error instanceof Error ? `rejected:${error.name}` : 'rejected', performance.now() - started);
        throw error;
      }
    };
    // Finer attribution (phase pr144-t4-deep-attribution-20261001; test-local,
    // observation only): T4-ATTR carries the absolute elapsed relative to this
    // test's monotonic start on EVERY boundary plus per-phase elapsed, and
    // subdivides fixture prep, the review-lifecycle boundaries this test
    // drives (head probe, native lead start, reconciliation lookup), and the
    // outside-body cleanup (emitted from the gated afterEach). Every real
    // call is forwarded exactly once; ordering, mocks, refs, and assertions
    // are untouched. The T4-PHASE marks above are emitted unchanged.
    // Nested intervals (reconcile-lookup inside wave-round) are reported
    // separately and are never summed into totals.
    const t4Start = performance.now();
    t4StartAt = t4Start;
    t4Observe = true;
    t4BodyCompleted = false;
    const t4Attr = (leg: 'moved' | 'aborted' | 'suite', phase: string, boundary: 'start' | 'end', extra?: { elapsedMs?: number; outcome?: string; note?: string }): void => {
      console.log(`T4-ATTR ${JSON.stringify({
        leg, phase, boundary, absMs: Math.round(performance.now() - t4Start),
        ...(extra?.elapsedMs !== undefined ? { elapsedMs: Math.round(extra.elapsedMs) } : {}),
        ...(extra?.outcome !== undefined ? { outcome: extra.outcome } : {}),
        ...(extra?.note !== undefined ? { note: extra.note } : {}),
      })}`);
    };
    // run() may settle synchronously (plain value) or asynchronously
    // (thenable); the awaited result is forwarded with its exact value and
    // type, exactly one invocation, unchanged error propagation and ordering.
    const t4Step = async <T>(leg: 'moved' | 'aborted', phase: string, run: () => T | Promise<T>): Promise<Awaited<T>> => {
      t4Attr(leg, phase, 'start');
      const started = performance.now();
      try {
        const result = await run();
        t4Attr(leg, phase, 'end', { elapsedMs: performance.now() - started, outcome: 'completed' });
        return result;
      } catch (error) {
        t4Attr(leg, phase, 'end', { elapsedMs: performance.now() - started, outcome: error instanceof Error ? `rejected:${error.name}` : 'rejected' });
        throw error;
      }
    };
    const t4Probe = (leg: 'moved' | 'aborted', branch: string): PrHeadProbe => {
      const inner = localHeadProbe(branch);
      return (input) => t4Step(leg, 'wave/head-probe', () => inner(input));
    };
    t4Attr('suite', 'test-start', 'start', { note: 'split T4b: aborted discriminator, inherited 30000 ms bound unchanged; nested intervals are never summed' });
    const prepare = async (name: string, branch: string, leg: 'moved' | 'aborted') => {
      const repo = await t4Step(leg, 'fixture/repo-init', async () => makeFixtureRepo(name, (step) => t4Attr(leg, `fixture/repo-init.${step}`, 'end', { outcome: 'completed' })));
      repos.push(repo);
      await t4Step(leg, 'fixture/branch-create', async () => { repo.git(['checkout', '-b', branch]); });
      const target = await t4Step(leg, 'fixture/target-commit', () => {
        // Batched equivalent of commitFile's add+commit (phase
        // pr144-t4-cost-repair-20261001): one git process stages the file
        // and commits (`commit --include`), removing a Node-to-git spawn
        // per leg while keeping the identical Fixture Tests identity, the
        // identical default message, parent, and resulting tree/HEAD, and
        // the same loud non-zero failure propagation on any git error.
        const file = join(repo.path, 'src/main.ts');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, 'export function answer(): number {\n  return 44;\n}\n');
        repo.git([
          '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid',
          'commit', '--include', 'src/main.ts', '-m', 'fixture: update src/main.ts',
        ]);
        // The branch ref was just written loose by the commit above; the
        // loose read is value-identical to `git rev-parse HEAD` (HEAD is
        // the branch here) with an exact rev-parse fallback.
        return looseRefOrRevParse(repo.path, `refs/heads/${branch}`);
      });
      const temps = await t4Step(leg, 'fixture/tempdirs', () => {
        const root = mkdtempSync(join(tmpdir(), `${name}-port-`));
        const artifacts = mkdtempSync(join(tmpdir(), `${name}-artifacts-`));
        const sessions = mkdtempSync(join(tmpdir(), `${name}-sessions-`));
        dirs.push(root, artifacts, sessions);
        return { root, artifacts, sessions };
      });
      const root = temps.root;
      const artifacts = temps.artifacts;
      const sessions = temps.sessions;
      const ledger = await t4Step(leg, 'fixture/ledger-open', () => {
        const db = new LedgerDb(mkdtempSync(join(tmpdir(), `${name}-db-`)));
        dbs.push(db);
        return new LedgerApi(db.handle, { bus: new EventBus() });
      });
      const port = new GitReviewPort(root, branch, target);
      await t4Step(leg, 'fixture/worktree-create', () => port.createJobWorktree({ repoPath: repo.path, jobId: `job-${name}` }));
      const job = await t4Step(leg, 'fixture/lane-register', () => {
        const job = ledger.addJob({ id: `job-${name}`, repo: 'fixture', title: name, baseBranch: 'main', briefing: 'review' });
        ledger.setJobStatus(job.id, 'working');
        settleLane(ledger, job.id);
        ledger.setJobPr(job.id, `https://git.example.invalid/acme/fixture/pull/${name.length}`);
        return job;
      });
      await t4Step(leg, 'fixture/origin-push', async () => { attachOrigin(repo, branch, root, { batched: true }); });
      return { repo, ledger, port, artifacts, sessions, target, job, root };
    };
    // (b) The run's abort signal fires while the lookup is outstanding.
    const aborted = await t4Timed('aborted', 'fixture-prep', () => prepare('perkins-t4-aborted', 'feature/t4-aborted', 'aborted'));
    const abortPost = vi.fn(async () => { throw new Error('gh api review delivery exited 1: timeout'); });
    const abortReconcile = vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => {
      return t4Timed('aborted', 'reconcile-lookup', async () => {
        for (const controller of (abortedWave as unknown as { activeControllers: Set<AbortController> }).activeControllers) controller.abort();
        return {
          reviewId: '9201', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
          headSha: call.targetSha, baseSha: 'b'.repeat(40),
          bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
        };
      });
    });
    const abortEscalations: string[] = [];
    const abortedWave = new WaveRunner({
      ledger: aborted.ledger, worktrees: aborted.port, spawner: makeSpawner(aborted.sessions, [], () => t4Attr('aborted', 'wave/lead-start', 'end', { outcome: 'completed', note: 'native lead child start on the original production path' }), undefined, '  return 44;'),
      poster: { post: abortPost, reconcile: abortReconcile }, reviewArtifactRoot: aborted.artifacts,
      escalate: (title, detail) => abortEscalations.push(`${title}: ${detail}`),
      prHeadProbe: t4Probe('aborted', 'feature/t4-aborted'),
    });
    const abortedOutcome = asWave(await t4Timed('aborted', 'wave-round', () => abortedWave.runRound({ jobId: aborted.job.id })));
    expect(abortedOutcome.posted).toBe(false);
    expect(abortedOutcome.verdict).toBeNull();
    const unrecordedAbort = JSON.parse(readFileSync(join(aborted.artifacts, abortedOutcome.round.id, 'perkins-report.reconciled-unrecorded.json'), 'utf8')) as { recorded?: boolean; reason?: string; receipt?: { reviewId?: string } };
    expect(unrecordedAbort.recorded).toBe(false);
    expect(unrecordedAbort.reason).toContain('aborted while the reconciliation lookup was outstanding');
    expect(unrecordedAbort.receipt?.reviewId).toBe('9201');
    expect(aborted.ledger.latestRoundEvent(abortedOutcome.round.id, 'round.posted')).toBeNull();
    // T4a parity: the production abort branch escalates the unrecorded
    // reconciled review; recording without asserting it would hide a lost
    // operator notification.
    expect(abortEscalations.some((line) => line.includes('reconciled a provider review but did NOT record it'))).toBe(true);
    t4Attr('aborted', 'leg', 'end', { outcome: 'completed', note: 'fixture-prep + wave-round + assertions; reconcile-lookup is NESTED in wave-round — never summed' });
    t4BodyCompleted = true;
    t4Attr('suite', 'test-end', 'end', { outcome: 'completed' });
  });
});

describe('bmad-review fallback gate (user amendment 2026-09-20, fork-3)', () => {
  interface GateHarness {
    wave: WaveRunner;
    job: { readonly id: string };
    ledger: LedgerApi;
    port: GitReviewPort;
    root: string;
    artifacts: string;
    sessions: string;
    db: LedgerDb;
    escalations: string[];
    reviews: number[];
    directives: string[];
    repo: FixtureRepo;
  }

  function gateHarness(rounds: FallbackFinding[][]): GateHarness {
    const repo = makeFixtureRepo('perkins-fallback-gate');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/fallback']);
    const target = repo.commitFile('src/fix.ts', 'export const fix = 1;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-gate-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-gate-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-gate-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-gate-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/fallback', target);
    const escalations: string[] = [];
    const reviews: number[] = [];
    const directives: string[] = [];
    const skillFile = join(artifacts, 'skills', 'bmad-review', 'SKILL.md');
    mkdirSync(dirname(skillFile), { recursive: true });
    writeFileSync(skillFile, '---\nname: bmad-review\n---\ninstalled skill bytes', 'utf8');
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(sessions, []),
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({
        ok: false,
        failures: [preflightFailure('model-provider', 'review model provider is not authenticated: acme')],
      }),
      fallbackGate: {
        skillPath: skillFile,
        runFallbackReview: async (input) => {
          reviews.push(input.iteration);
          writeFileSync(input.reportFile, JSON.stringify(rounds[input.iteration - 1] ?? []), 'utf8');
          return rounds[input.iteration - 1] ?? [];
        },
        fixDirectiveSink: async (input) => {
          directives.push(input.directive);
          return { delivered: true, minionId: 'minion-1' };
        },
      },
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const job = ledger.addJob({ id: 'job-fallback-gate', repo: 'fixture', title: 'fallback', baseBranch: 'main' });
    settleLane(ledger, job.id);
    return { wave, job, ledger, port, root, artifacts, sessions, db, escalations, reviews, directives, repo };
  }

  function gateEvents(harness: GateHarness): Array<Record<string, unknown>> {
    return harness.ledger
      .listEvents({ limit: 200 })
      .filter((event) => event.kind === 'job.fallback-review' && event.jobId === harness.job.id)
      .map((event) => event.payload as Record<string, unknown>);
  }

  function cleanupGate(harness: GateHarness): void {
    rmSync(harness.root, { recursive: true, force: true });
    rmSync(harness.artifacts, { recursive: true, force: true });
    rmSync(harness.sessions, { recursive: true, force: true });
  }

  it('routes a native preflight failure to persisted fallback history and forwards a recovered snapshot', async () => {
    const harness = gateHarness([[]]);
    const home = mkdtempSync(join(tmpdir(), 'perkins-native-preflight-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'perkins-native-preflight-ws-'));
    const settingsFile = join(home, 'claude-settings.json');
    writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n[runtimes]\ndefault = "claude-code"\n`);
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const registry = new RuntimeRegistry({
      config, store: new SessionStore(config.dataDir),
      claude: { binary: join(import.meta.dirname, 'helpers', 'claude-double.mjs'), reviewSettingsFile: settingsFile },
    });
    const seen: boolean[] = [];
    const spawner = makeSpawner(harness.sessions, []);
    const wave = new WaveRunner({
      ledger: harness.ledger, worktrees: harness.port, reviewArtifactRoot: harness.artifacts,
      reviewPreflight: () => runRuntimeReviewPreflight(
        () => registry.prepareReviewModel('perkins'),
        { 'resource-integrity': () => {}, 'code-host': () => {}, 'review-policy': () => {} },
      ),
      spawner: (role, options) => {
        if (options?.reviewLead !== undefined || options?.isolatedReview !== undefined) {
          seen.push(options.reviewModel?.role === 'perkins');
        }
        return spawner(role, options);
      },
      fallbackGate: {
        skillPath: join(harness.artifacts, 'skills', 'bmad-review', 'SKILL.md'),
        runFallbackReview: async () => [],
        fixDirectiveSink: async () => ({ delivered: true }),
      },
    });
    try {
      await harness.port.createJobWorktree({ repoPath: harness.repo.path, jobId: harness.job.id });
      writeFileSync(settingsFile, '{"env": {"CLAUDE_CODE_OAUTH_TOKEN":"private-canary"}, broken');
      const failed = await wave.runRound({ jobId: harness.job.id });
      expect('route' in failed && failed.route).toBe('bmad-review-fallback');
      expect(seen).toEqual([]);
      expect(harness.ledger.listRounds(harness.job.id)).toEqual([]);
      const history = gateEvents(harness);
      expect(history.some((payload) => payload['phase'] === 'pass')).toBe(true);
      expect(JSON.stringify(history)).toContain('malformed Claude review model/auth settings JSON');
      expect(JSON.stringify(history)).not.toContain('private-canary');
      writeFileSync(settingsFile, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth' } }));
      const recoveredJob = harness.ledger.addJob({
        id: 'job-native-recovered', repo: 'fixture', title: 'recovered model', baseBranch: 'main', briefing: 'review',
      });
      settleLane(harness.ledger, recoveredJob.id);
      await harness.port.createJobWorktree({ repoPath: harness.repo.path, jobId: recoveredJob.id });
      const recovered = await wave.runRound({ jobId: recoveredJob.id });
      expect('route' in recovered).toBe(false);
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.every(Boolean)).toBe(true);
    } finally {
      await registry.dispose();
      cleanupGate(harness);
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60_000);

  it('triages, routes the blocker fix directive to the minion, re-reviews, and passes clean', async () => {
    const harness = gateHarness([
      [
        { title: 'broken build', category: 'broken-build', location: 'src/fix.ts:1', evidence: 'export const fix = 1;', detail: 'does not compile' },
        { title: 'naming nit', category: 'style', location: 'src/fix.ts:1', evidence: 'export const fix = 1;', detail: 'prefer clearer name' },
      ],
      [],
    ]);
    try {
      await harness.port.createJobWorktree({ repoPath: harness.repo.path, jobId: harness.job.id });
      const outcome = await harness.wave.runRound({ jobId: harness.job.id });
      if (!('route' in outcome)) throw new Error('expected the bmad-review fallback route');
      expect(outcome.skillInstalled).toBe(true);
      expect(outcome.failedLegs.map((leg) => leg.leg)).toEqual(['model-provider']);
      expect(harness.reviews).toEqual([1, 2]);
      expect(harness.directives).toHaveLength(1);
      expect(harness.directives[0]).toContain('broken build');
      expect(harness.directives[0]).not.toContain('naming nit');
      expect(outcome.clearToMerge).toBe(true);
      expect(outcome.blockers).toBe(0);
      expect(outcome.notes).toBe(0); // final round triaged clean
      expect(outcome.iterations).toBe(2);
      expect(outcome.reportFiles).toHaveLength(2);
      const phases = gateEvents(harness).map((payload) => payload['phase']).reverse();
      expect(phases).toEqual(['started', 'triaged', 'fix-directive', 'triaged', 'pass']);
      expect(harness.escalations.some((line) => line.includes('review/fix routing cleared'))).toBe(true);
      // The fallback PASS is not a Perkins READY: the escalation message
      // must never read as merge clearance.
      expect(harness.escalations.some((line) => line.includes('clear to merge'))).toBe(false);
      // The fallback gate never creates a Perkins round or verdict.
      expect(harness.ledger.listRounds(harness.job.id)).toHaveLength(0);
    } finally {
      cleanupGate(harness);
    }
  });

  it('terminates blocked when blockers survive the review bound', async () => {
    const blocker: FallbackFinding = {
      title: 'persistent defect', category: 'correctness', location: 'src/fix.ts:1',
      evidence: 'export const fix = 1;', detail: 'still wrong',
    };
    const harness = gateHarness([[blocker], [blocker], [blocker], [blocker]]);
    try {
      await harness.port.createJobWorktree({ repoPath: harness.repo.path, jobId: harness.job.id });
      const outcome = await harness.wave.runRound({ jobId: harness.job.id });
      if (!('route' in outcome)) throw new Error('expected the bmad-review fallback route');
      expect(outcome.clearToMerge).toBe(false);
      expect(outcome.iterations).toBe(4);
      expect(outcome.blockers).toBe(1);
      expect(harness.reviews).toEqual([1, 2, 3, 4]);
      expect(harness.directives).toHaveLength(3);
      const phases = gateEvents(harness).map((payload) => payload['phase']).reverse();
      expect(phases.at(-1)).toBe('blocked');
      expect(harness.escalations.some((line) => line.includes('BLOCKED'))).toBe(true);
    } finally {
      cleanupGate(harness);
    }
  });

  it('reports both options when the skill is not installed and never reviews', async () => {
    const repo = makeFixtureRepo('perkins-fallback-no-skill');
    repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'perkins-gate-noskill-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-gate-noskill-artifacts-'));
    const noskillSessions = mkdtempSync(join(tmpdir(), 'perkins-gate-noskill-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-gate-noskill-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-no-skill' });
    const job = ledger.addJob({ id: 'job-no-skill', repo: 'fixture', title: 'no skill', baseBranch: 'main' });
    settleLane(ledger, job.id);
    let reviewed = 0;
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: makeSpawner(noskillSessions, []),
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({ ok: false, failures: [preflightFailure('review-policy', 'the Perkins review gate is disabled in config')] }),
      fallbackGate: {
        skillPath: join(artifacts, 'missing', 'SKILL.md'),
        runFallbackReview: async () => {
          reviewed += 1;
          return [];
        },
        fixDirectiveSink: async () => ({ delivered: true }),
      },
      escalate: () => {},
    });
    try {
      const outcome = await wave.runRound({ jobId: job.id });
      if (!('route' in outcome)) throw new Error('expected the bmad-review fallback route');
      expect(outcome.skillInstalled).toBe(false);
      expect(outcome.clearToMerge).toBe(false);
      expect(reviewed).toBe(0);
      expect(outcome.note).toContain('restore the job\'s exact retained GC workflow package/context');
      expect(outcome.note).toContain('never install or borrow an ambient BMAD skill');
      expect(outcome.note).toContain('[review] enabled = true');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(artifacts, { recursive: true, force: true });
      rmSync(noskillSessions, { recursive: true, force: true });
    }
  });

  it('refuses a direct beginRound when the pre-flight routes to the fallback gate', async () => {
    const harness = gateHarness([[]]);
    try {
      await harness.port.createJobWorktree({ repoPath: harness.repo.path, jobId: harness.job.id });
      await expect(harness.wave.beginRound({ jobId: harness.job.id })).rejects.toThrow(/bmad-review fallback gate/u);
      expect(harness.ledger.listRounds(harness.job.id)).toHaveLength(0);
    } finally {
      cleanupGate(harness);
    }
  });
});

describe('GitLab SHA-bound merge-request delivery', () => {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const mrUrl = 'https://gitlab.example.test/acme/widget/-/merge_requests/7';

  function fixture(): { repoPath: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gl-poster-'));
    const repoPath = join(root, 'repo');
    execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://gitlab.example.test/acme/widget.git']);
    return { repoPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  function fetchDouble(response: { status: number; body?: string }, calls: Array<{ url: string; init?: unknown }>) {
    return async (url: string, init?: unknown): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
      calls.push({ url, init });
      if (url.endsWith('/user')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ username: 'gru-bot' }) };
      }
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        text: async () => response.body ?? '',
      };
    };
  }

  function fetchSequence(responses: ReadonlyArray<{ status: number; body?: string }>, calls: Array<{ url: string; init?: unknown }>) {
    let index = 0;
    return async (url: string, init?: unknown): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
      calls.push({ url, init });
      if (url.endsWith('/user')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ username: 'gru-bot' }) };
      }
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        text: async () => response.body ?? '',
      };
    };
  }

  it('delivers on head equality with a verified note receipt — the recorded base is refreshed, never a refusal', async () => {
    const { repoPath, cleanup } = fixture();
    try {
      const calls: Array<{ url: string; init?: unknown }> = [];
      // The MR's recorded base (diff_refs.base_sha is pinned at open/link
      // time) trails the round's frozen base; head equality still delivers.
      const recordedBase = 'c'.repeat(40);
      const mr = () => ({ status: 200, body: JSON.stringify({ sha: head, diff_refs: { base_sha: recordedBase } }) });
      const poster = new GitLabMrPoster({
        token: 'glpat-token',
        fetchImpl: fetchSequence([
          mr(),
          { status: 201, body: JSON.stringify({ id: 55, body: 'review body\n', author: { username: 'gru-bot' } }) },
          mr(),
        ], calls),
      });
      await expect(poster.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'review body\n', targetSha: head, baseSha: base }))
        .resolves.toEqual({
          reviewId: '55', actor: 'gru-bot', event: 'note', commitId: null,
          headSha: head, baseSha: recordedBase,
          bodySha256: createHash('sha256').update('review body\n', 'utf8').digest('hex'),
        });
      // identity probe, authenticated-account probe, note POST,
      // post-delivery confirmation probe
      expect(calls).toHaveLength(4);
      expect(calls[0]?.url).toBe('https://gitlab.example.test/api/v4/projects/acme%2Fwidget/merge_requests/7');
      expect((calls[0]?.init as { headers: Record<string, string> }).headers['PRIVATE-TOKEN']).toBe('glpat-token');
      expect(calls[1]?.url).toBe('https://gitlab.example.test/api/v4/user');
      expect(calls[2]?.url).toContain('/notes');
      expect(JSON.parse((calls[2]?.init as { body: string }).body)).toEqual({ body: 'review body\n' });
      expect(calls[3]?.url).toBe(calls[0]?.url);

      // A zero-status note response whose echoed body differs is refused.
      const echoCalls: Array<{ url: string; init?: unknown }> = [];
      const echoed = new GitLabMrPoster({
        token: 'glpat-token',
        fetchImpl: fetchSequence([mr(), { status: 201, body: JSON.stringify({ id: 56, body: 'something else', author: { username: 'gru-bot' } }) }], echoCalls),
      });
      await expect(echoed.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'review body\n', targetSha: head, baseSha: base }))
        .rejects.toThrow(/receipt body does not match/);
    } finally {
      cleanup();
    }
  });

  it('re-resolves the authenticated user after a token rotation on the same host (R29)', async () => {
    const { repoPath, cleanup } = fixture();
    try {
      let token = 'glpat-a';
      const userTokens: string[] = [];
      const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
        const current = init?.headers?.['PRIVATE-TOKEN'] ?? '';
        if (url.endsWith('/user')) {
          userTokens.push(current);
          return { ok: true, status: 200, text: async () => JSON.stringify({ username: current === 'glpat-a' ? 'user-a' : 'user-b' }) };
        }
        if (url.includes('/notes') && !url.includes('?')) {
          return { ok: true, status: 201, text: async () => JSON.stringify({ id: 70, body: 'rotated body\n', author: { username: current === 'glpat-a' ? 'user-a' : 'user-b' } }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ sha: head, diff_refs: { base_sha: base } }) };
      };
      const poster = new GitLabMrPoster({ tokenResolver: () => token, fetchImpl });
      await expect(poster.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'rotated body\n', targetSha: head, baseSha: base }))
        .resolves.toMatchObject({ actor: 'user-a' });
      // The token rotates under the long-lived poster: the next post must
      // compare against the NEW account, never a host-keyed stale cache.
      token = 'glpat-b';
      await expect(poster.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'rotated body\n', targetSha: head, baseSha: base }))
        .resolves.toMatchObject({ actor: 'user-b' });
      expect(userTokens).toEqual(['glpat-a', 'glpat-b']);
    } finally {
      cleanup();
    }
  });

  it('evidences the authenticated GitLab account for restart recovery (R30)', async () => {
    const calls: Array<{ url: string; init?: unknown }> = [];
    const poster = new GitLabMrPoster({ token: 'glpat-token', fetchImpl: fetchDouble({ status: 200 }, calls) });
    await expect(poster.authenticatedActor!('gitlab.example.test')).resolves.toBe('gru-bot');
    expect(calls.map((call) => call.url)).toEqual(['https://gitlab.example.test/api/v4/user']);
    const noToken = new GitLabMrPoster({ fetchImpl: fetchDouble({ status: 200 }, []) });
    await expect(noToken.authenticatedActor!('gitlab.example.test')).rejects.toThrow(/GITLAB_TOKEN/);
  });

  it('fails closed on a moved head — before and under the note — plus missing token, origin mismatch, and HTTP failure', async () => {
    const { repoPath, cleanup } = fixture();
    try {
      const movedCalls: Array<{ url: string; init?: unknown }> = [];
      const moved = new GitLabMrPoster({
        token: 'glpat-token',
        fetchImpl: fetchDouble({ status: 200, body: JSON.stringify({ sha: 'd'.repeat(40), diff_refs: { base_sha: base } }) }, movedCalls),
      });
      await expect(moved.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'x', targetSha: head, baseSha: base }))
        .rejects.toThrow(/identity moved/u);
      expect(movedCalls).toHaveLength(1);

      const racedCalls: Array<{ url: string; init?: unknown }> = [];
      const raced = new GitLabMrPoster({
        token: 'glpat-token',
        fetchImpl: fetchSequence([
          { status: 200, body: JSON.stringify({ sha: head, diff_refs: { base_sha: base } }) },
          { status: 201, body: JSON.stringify({ id: 57, body: 'x', author: { username: 'gru-bot' } }) },
          { status: 200, body: JSON.stringify({ sha: 'e'.repeat(40), diff_refs: { base_sha: 'f'.repeat(40) } }) },
        ], racedCalls),
      });
      await expect(raced.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'x', targetSha: head, baseSha: base }))
        .rejects.toThrow(/identity moved/u);
      // identity, authenticated-account probe, note POST, moved confirm
      expect(racedCalls).toHaveLength(4);

      const noToken = new GitLabMrPoster({ fetchImpl: fetchDouble({ status: 200, body: '{}' }, []) });
      await expect(noToken.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'x', targetSha: head, baseSha: base }))
        .rejects.toThrow(/GITLAB_TOKEN/u);

      const poster = new GitLabMrPoster({
        token: 't',
        fetchImpl: fetchSequence([
          { status: 200, body: JSON.stringify({ sha: head, diff_refs: { base_sha: base } }) },
          { status: 201, body: JSON.stringify({ id: 58, body: 'x', author: { username: 'gru-bot' } }) },
          { status: 200, body: JSON.stringify({ sha: head, diff_refs: { base_sha: base } }) },
        ], []),
      });
      await expect(poster.post({
        prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'x', targetSha: head, baseSha: base,
      })).resolves.toMatchObject({ reviewId: '58', headSha: head, baseSha: base });

      const wrongRepo = mkdtempSync(join(tmpdir(), 'perkins-gl-wrong-'));
      try {
        const other = join(wrongRepo, 'repo');
        execFileSync('git', ['init', other], { stdio: 'ignore' });
        execFileSync('git', ['-C', other, 'remote', 'add', 'origin', 'https://gitlab.example.test/acme/other.git']);
        await expect(poster.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath: other, body: 'x', targetSha: head, baseSha: base }))
          .rejects.toThrow(/does not match the reviewed repository origin/u);
      } finally {
        rmSync(wrongRepo, { recursive: true, force: true });
      }

      const failing = new GitLabMrPoster({ token: 't', fetchImpl: fetchDouble({ status: 500, body: 'boom' }, []) });
      await expect(failing.post({ prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body: 'x', targetSha: head, baseSha: base }))
        .rejects.toThrow(/HTTP 500/u);
    } finally {
      cleanup();
    }
  });

  it('routes by code host and refuses unsupported hosts', async () => {
    const github = { post: vi.fn(async () => ({ headSha: 'github-head', baseSha: 'github-base' })) } as unknown as VerdictPoster;
    const gitlab = { post: vi.fn(async () => ({ headSha: 'gitlab-head', baseSha: 'gitlab-base' })) } as unknown as VerdictPoster;
    const poster = new AutoVerdictPoster(github, gitlab);
    const base = { prUrl: 'https://x', host: 'x', repoPath: '/r', body: 'b', targetSha: 'h', baseSha: 'b' };
    await expect(poster.post({ ...base, prUrl: 'https://github.com/acme/widget/pull/1', host: 'github.com' }))
      .resolves.toEqual({ headSha: 'github-head', baseSha: 'github-base' });
    expect(github.post).toHaveBeenCalledTimes(1);
    await expect(poster.post({ ...base, prUrl: 'https://gitlab.com/acme/widget/-/merge_requests/2', host: 'gitlab.com' }))
      .resolves.toEqual({ headSha: 'gitlab-head', baseSha: 'gitlab-base' });
    expect(gitlab.post).toHaveBeenCalledTimes(1);
    await expect(poster.post({ ...base, prUrl: 'https://code.company.test/acme/widget/-/merge_requests/3', host: 'code.company.test' }))
      .rejects.toThrow(/unsupported code host/u);
    expect(github.post).toHaveBeenCalledTimes(1);
    expect(gitlab.post).toHaveBeenCalledTimes(1);
  });
});

describe('orphan review-lane recovery', () => {
  it('sweeps a review lane whose ledger round is missing', async () => {
    const repo = makeFixtureRepo('perkins-orphan-lane');
    const root = mkdtempSync(join(tmpdir(), 'perkins-orphan-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-orphan-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-orphan-db-')));
    dbs.push(db);
    dirs.push(root, artifacts);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', repo.head());
    await port.createReviewWorktree({ repoPath: repo.path, roundId: 'orphan-round', ref: 'HEAD' });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(mkdtempSync(join(tmpdir(), 'perkins-orphan-sessions-')), []),
      reviewArtifactRoot: artifacts,
      escalate: () => {},
    });
    const recovered = await wave.recoverInterruptedRounds();
    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(port.getWorktree('orphan-round')?.status).toBe('swept');
  });
});

describe('WaveRunner request guards', () => {
  it('rejects terminal jobs and lane-less jobs at request time without touching state', async () => {
    const repo = makeFixtureRepo('perkins-guard-terminals');
    repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'perkins-guards-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-guards-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-guards-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-guards-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', repo.head());
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), reviewArtifactRoot: artifacts,
    });
    for (const status of ['merged', 'done', 'binned'] as const) {
      await port.createJobWorktree({ repoPath: repo.path, jobId: `job-${status}` });
      const job = ledger.addJob({ id: `job-${status}`, repo: 'fixture', title: status, baseBranch: 'main', briefing: 'b' });
      // Legal path into the terminal states is via in-review (binned is
      // also directly reachable from working).
      ledger.setJobStatus(job.id, 'working');
      ledger.setJobStatus(job.id, 'in-review');
      ledger.setJobStatus(job.id, status);
      await expect(wave.runRound({ jobId: job.id })).rejects.toThrow(/terminal lanes do not go back under review/u);
    }
    const laneless = ledger.addJob({ id: 'job-laneless', repo: 'fixture', title: 'no lane', baseBranch: 'main', briefing: 'b' });
    await expect(wave.runRound({ jobId: laneless.id })).rejects.toThrow(/no job worktree lane/u);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-missing-briefing' });
    const noBriefing = ledger.addJob({ id: 'job-missing-briefing', repo: 'fixture', title: 'no briefing', baseBranch: 'main' });
    settleLane(ledger, noBriefing.id);
    await expect(wave.runRound({ jobId: noBriefing.id })).rejects.toThrow(/requires the job briefing\/spec or explicit noSpec/u);
    await expect(wave.runRound({ jobId: noBriefing.id, noSpec: true, lenses: ['blind'] }))
      .rejects.toThrow(/canonical and cannot be reduced/u);
  });

  it('never completes a conclusive verdict without a PR link: publication is required (B4)', async () => {
    const repo = makeFixtureRepo('perkins-wave-no-pr');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/no-pr']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-no-pr-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-no-pr-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-no-pr-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-no-pr-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/no-pr', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-no-pr' });
    const job = ledger.addJob({ id: 'job-no-pr', repo: 'fixture', title: 'no pr', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    const escalations: string[] = [];
    const poster = { post: vi.fn(async () => ({ headSha: 'unused-head', baseSha: 'unused-base' })) } as unknown as VerdictPoster;
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), poster, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    // The lead reached NEEDS CHANGES, but with no PR the round cannot be a
    // completed published review: no verdict, aborted, escalated, preserved.
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(outcome.verdict).toBeNull();
    expect(outcome.posted).toBe(false);
    expect(outcome.round.status).toBe('aborted');
    expect(ledger.latestRoundEvent(outcome.round.id, 'round.perkins-review')).toBeNull();
    const incomplete = ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')?.payload as { reason?: string };
    expect(incomplete?.reason).toBe('no_pr_link');
    expect(escalations.some((line) => line.includes('NO pull request to publish to'))).toBe(true);
    expect(existsSync(outcome.reportFile)).toBe(true);
    expect(poster.post).not.toHaveBeenCalled();
  });
});

describe('poster transport negatives and fallback-gate terminals', () => {
  it('rejects unparseable URLs, missing gh binaries, and failed probes', async () => {
    const poster = new GhPrPoster('/nonexistent/gh-binary');
    await expect(poster.post({
      prUrl: 'not a url', host: 'x', repoPath: '/r', body: 'b', targetSha: 'h', baseSha: 'b',
    })).rejects.toThrow(/cannot parse pull request URL/u);
    await expect(poster.post({
      prUrl: 'https://github.com/acme/widget/pull/1', host: 'github.com', repoPath: '/r',
      body: 'b', targetSha: 'h', baseSha: 'b',
    })).rejects.toThrow(/unavailable|origin/u);
  });

  it('resolves the GitLab token as GITLAB_TOKEN falling back to GL_TOKEN', async () => {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gl-token-'));
    const originalGitlab = process.env['GITLAB_TOKEN'];
    const originalGl = process.env['GL_TOKEN'];
    try {
      const repoPath = join(root, 'repo');
      execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
      execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://gitlab.example.test/acme/widget.git']);
      const seen: string[] = [];
      const fetchImpl = async (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string }): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
        seen.push(init?.headers?.['PRIVATE-TOKEN'] ?? '');
        if ((init?.method ?? 'GET') === 'POST' && url.includes('/notes')) {
          const noteBody = JSON.parse(init?.body ?? '{}') as { body?: string };
          return { ok: true, status: 201, text: async () => JSON.stringify({ id: 60, body: noteBody.body ?? '', author: { username: 'gru-bot' } }) };
        }
        if (url.endsWith('/user')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ username: 'gru-bot' }) };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ sha: 'h', diff_refs: { base_sha: 'b' } }) };
      };
      process.env['GITLAB_TOKEN'] = 'primary-token';
      process.env['GL_TOKEN'] = 'fallback-token';
      const primary = new GitLabMrPoster({ fetchImpl });
      await primary.post({
        prUrl: 'https://gitlab.example.test/acme/widget/-/merge_requests/7',
        host: 'gitlab.example.test', repoPath, body: 'x', targetSha: 'h', baseSha: 'b',
      });
      expect(seen[0]).toBe('primary-token');
      delete process.env['GITLAB_TOKEN'];
      const fallback = new GitLabMrPoster({ fetchImpl });
      await fallback.post({
        prUrl: 'https://gitlab.example.test/acme/widget/-/merge_requests/7',
        host: 'gitlab.example.test', repoPath, body: 'x', targetSha: 'h', baseSha: 'b',
      });
      expect(seen.at(-1)).toBe('fallback-token');
    } finally {
      if (originalGitlab === undefined) delete process.env['GITLAB_TOKEN'];
      else process.env['GITLAB_TOKEN'] = originalGitlab;
      if (originalGl === undefined) delete process.env['GL_TOKEN'];
      else process.env['GL_TOKEN'] = originalGl;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the not-configured variant when no fallbackGate option exists', async () => {
    const repo = makeFixtureRepo('perkins-gate-unconfigured');
    const root = mkdtempSync(join(tmpdir(), 'perkins-gate-unconf-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-gate-unconf-artifacts-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-gate-unconf-db-')));
    dbs.push(db);
    dirs.push(root, artifacts);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-unconfigured' });
    const job = ledger.addJob({ id: 'job-unconfigured', repo: 'fixture', title: 'unconfigured', baseBranch: 'main' });
    settleLane(ledger, job.id);
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(mkdtempSync(join(tmpdir(), 'perkins-gate-unconf-sessions-')), []),
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({
        ok: false,
        failures: [{ leg: 'model-provider', detail: 'no provider', remediation: 'configure one' }],
      }),
      escalate: () => {},
    });
    const outcome = await wave.runRound({ jobId: job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.skillInstalled).toBe(false);
    expect(outcome.note).toContain('not configured');
    expect(outcome.clearToMerge).toBe(false);
  });
});

describe('production defaultFallbackReview (BLOCKER-1 fix)', () => {
  async function makeProductionGateHarness(options: {
    findingToWrite: readonly Record<string, string>[];
    skillContent?: string;
    resolveReviewResources?: (jobId: string) => { readonly skillPath: string; readonly artifactRoot: string };
    workerGate?: PacingGate;
    /** Provider pacing: the bounded retry settlement to report for a
     * delivered fallback-review turn. Absent = no interlock. */
    retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
    /** Make the fallback turn reject after writing its report (a transport
     * rejection whose automatic retry may still recover the delivery). */
    failPrompt?: boolean;
    inBandError?: boolean;
    missingReportTool?: boolean;
    conflictingReport?: boolean;
    onPrompt?: () => void;
    /** Hold every fallback minion turn open until the test releases it, so a
     * transport wait slice can expire while the review is genuinely live. */
    promptHold?: { readonly release: Promise<void> };
  }): Promise<{
    wave: WaveRunner;
    job: { readonly id: string };
    ledger: LedgerApi;
    port: GitReviewPort;
    root: string;
    artifacts: string;
    sessions: string;
    repo: FixtureRepo;
    skillPath: string;
    prompts: string[];
    systemPrompts: string[];
    spawnCwds: string[];
    escalations: string[];
    disposed: string[];
  }> {
    const repo = makeFixtureRepo('perkins-prod-gate');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/prod-gate']);
    repo.commitFile('src/prod.ts', 'export const prod = 1;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-prod-gate-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/prod-gate', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-prod-gate' });
    const job = ledger.addJob({ id: 'job-prod-gate', repo: 'fixture', title: 'prod gate', baseBranch: 'main' });
    settleLane(ledger, job.id);
    const skillPath = join(artifacts, 'skills', 'bmad-review', 'SKILL.md');
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, options.skillContent ?? '---\nname: bmad-review\n---\nreview skill bytes', 'utf8');
    const prompts: string[] = [];
    const systemPrompts: string[] = [];
    const spawnCwds: string[] = [];
    const escalations: string[] = [];
    const disposed: string[] = [];
    const spawner: AgentSpawner = async (role, spawnOptions = {}) => {
      spawnCwds.push(spawnOptions.cwd ?? '');
      systemPrompts.push(spawnOptions.isolatedReview?.systemPrompt ?? '');
      const file = join(sessions, `prod-${spawnCwds.length}.jsonl`);
      writeFileSync(file, '', 'utf8');
      return {
        role,
        id: `prod-minion-${spawnCwds.length}`,
        sessionFile: file,
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        reviewIsolation: true,
        reviewTools: options.missingReportTool === true ? [] : spawnOptions.isolatedReview?.nativeTools?.map((tool) => tool.name),
        async prompt(text: string) {
          prompts.push(text);
          // Exercise the host closure, never grant the fake model file writes.
          const submit = spawnOptions.isolatedReview!.nativeTools![0]!;
          await submit.execute({ findings: options.findingToWrite });
          if (options.conflictingReport === true) {
            try { await submit.execute({ findings: [{ title: 'Late blocker', category: 'correctness', location: 'src/prod.ts:1', evidence: 'prod = 1', detail: 'A corrected report must not be ignored.' }] }); }
            catch { /* Model ignores the native tool error and replies DONE. */ }
          }
          options.onPrompt?.();
          if (options.promptHold !== undefined) await options.promptHold.release;
          if (options.failPrompt === true) throw new Error('429 too many requests');
        },
        async steer() {},
        async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: options.inBandError === true ? 'error' : 'idle', lastActivity: null, sessionFile: file,
          ...(options.inBandError === true ? { error: 'review turn failed in-band after submitting' } : {}) }; },
        async dispose() { disposed.push(`prod-minion-${spawnCwds.length}`); },
      };
    };
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner,
      reviewArtifactRoot: artifacts,
      ...(options.workerGate !== undefined ? { workerGate: options.workerGate } : {}),
      ...(options.retrySettlement !== undefined ? { retrySettlement: options.retrySettlement } : {}),
      reviewPreflight: async () => ({
        ok: false,
        failures: [preflightFailure('review-policy', 'the Perkins review gate is disabled')],
      }),
      // NO runFallbackReview — the production default runs
      fallbackGate: {
        skillPath,
        ...(options.resolveReviewResources !== undefined ? { resolveReviewResources: options.resolveReviewResources } : {}),
        fixDirectiveSink: async () => ({ delivered: true, minionId: 'prod-1' }),
      },
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    return { wave, job, ledger, port, root, artifacts, sessions, repo, skillPath, prompts, systemPrompts, spawnCwds, escalations, disposed };
  }

  it('production resource resolver wins over ambient skill fixtures and sends reports to the owned job root without native clearance', async () => {
    const { makeWorkflowLane } = await import('./helpers/workflow-lane.js');
    const { createWorkflowSessionBinder, ownedFallbackReviewResources } = await import('../src/workflows/session.js');
    const f = makeWorkflowLane('job-prod-gate'); dirs.push(f.root);
    const bound = createWorkflowSessionBinder(f.dataDir, () => f.lane)({ cwd: f.lane.path });
    const resources = ownedFallbackReviewResources(bound, f.dataDir);
    const ids: string[] = [];
    const h = await makeProductionGateHarness({ findingToWrite: [], resolveReviewResources: (jobId) => { ids.push(jobId); return resources; } });
    const outcome = await h.wave.runRound({ jobId: h.job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(ids).toEqual([h.job.id]);
    expect(outcome.skillInstalled).toBe(true);
    expect(outcome.clearToMerge).toBe(true);
    expect(outcome.reportFiles[0]).toContain(join(resources.artifactRoot, 'fallback-gate'));
    expect(h.prompts[0]).toContain(resources.skillPath);
    expect(h.prompts[0]).not.toContain(h.skillPath);
    expect(h.prompts[0]).toContain('never discover or invoke project/global BMAD');
    expect(h.ledger.listRounds(h.job.id)).toEqual([]);
    expect(h.escalations.join('\n')).toContain('not a Perkins READY');
  });

  it('uses verified helper bytes captured at resolution even when its later pathname is corrupted', async () => {
    const { makeWorkflowLane } = await import('./helpers/workflow-lane.js');
    const { createWorkflowSessionBinder, ownedFallbackReviewResources } = await import('../src/workflows/session.js');
    const f = makeWorkflowLane('job-prod-gate'); dirs.push(f.root);
    const bound = createWorkflowSessionBinder(f.dataDir, () => f.lane)({ cwd: f.lane.path });
    const resources = ownedFallbackReviewResources(bound, f.dataDir);
    const h = await makeProductionGateHarness({ findingToWrite: [], resolveReviewResources: () => {
      chmodSync(resources.skillPath, 0o600); writeFileSync(resources.skillPath, 'UNVERIFIED HELPER OVERRIDE');
      return resources;
    } });
    const outcome = await h.wave.runRound({ jobId: h.job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(true);
    expect(h.systemPrompts[0]).toContain(resources.skillContent);
    expect(h.systemPrompts[0]).not.toContain('UNVERIFIED HELPER OVERRIDE');
  });

  it('ignores inherited Git routing variables and reviews only the assigned working tree', async () => {
    const h = await makeProductionGateHarness({ findingToWrite: [] });
    const foreign = join(h.root, 'foreign-worktree');
    h.repo.git(['worktree', 'add', '-q', '-b', 'feature/foreign-env', foreign, 'main']);
    writeFileSync(join(foreign, 'foreign.ts'), 'export const foreignEnvironment = true;\n');
    const gitDir = h.repo.git(['rev-parse', '--absolute-git-dir']);
    const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;
    const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.GIT_DIR = gitDir; process.env.GIT_WORK_TREE = foreign;
      process.env.GIT_INDEX_FILE = join(h.root, 'foreign-index');
      const outcome = await h.wave.runRound({ jobId: h.job.id });
      if (!('route' in outcome)) throw new Error('expected fallback route');
      expect(outcome.clearToMerge).toBe(true);
      expect(h.prompts[0]).toContain('export const prod = 1;');
      expect(h.prompts[0]).not.toContain('foreignEnvironment');
    } finally {
      for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    }
  });

  it('missing/corrupt owned fallback resources record an actionable blocked result, never borrowed ambient skill bytes', async () => {
    const h = await makeProductionGateHarness({ findingToWrite: [], resolveReviewResources: () => { throw new Error('retained owned helper corrupt: restore exact package'); } });
    const outcome = await h.wave.runRound({ jobId: h.job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(false);
    expect(outcome.skillInstalled).toBe(false);
    expect(outcome.note).toContain('retained owned helper corrupt');
    expect(h.prompts).toEqual([]);
    expect(h.ledger.listRounds(h.job.id)).toEqual([]);
    expect(h.ledger.listEvents().some((event) => event.kind === 'job.fallback-review' && event.jobId === h.job.id)).toBe(true);
  });

  it('blocks oversized complete diffs before spawning rather than passing a truncated prefix', async () => {
    const h = await makeProductionGateHarness({ findingToWrite: [] });
    h.repo.commitFile('large.md', `start\n${'x'.repeat(600 * 1024)}\ntail-defect\n`);
    const outcome = await h.wave.runRound({ jobId: h.job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(false);
    expect(outcome.note).toContain('no truncated review can pass');
    expect(h.spawnCwds).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.ledger.listRounds(h.job.id)).toEqual([]);
  });

  it('records exact base/HEAD and complete diff digest including uncommitted bytes', async () => {
    const h = await makeProductionGateHarness({ findingToWrite: [] });
    writeFileSync(join(h.repo.path, 'src/prod.ts'), 'export const prod = 2;\n');
    const baseRef = h.repo.git(['rev-parse', 'main']); const headRef = h.repo.head();
    const diff = execFileSync('git', ['-C', h.repo.path, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary', '--full-index', baseRef], { encoding: 'utf8' });
    const diffSha256 = createHash('sha256').update(diff).digest('hex');
    const outcome = await h.wave.runRound({ jobId: h.job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(true);
    expect(h.prompts[0]).toContain(`canonical base: ${baseRef}; checkout HEAD: ${headRef}; complete working diff SHA-256: ${diffSha256}`);
    expect(h.prompts[0]).toContain(diff);
    const triaged = h.ledger.listEvents({ limit: 100 }).find((event) => event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'triaged');
    expect(triaged?.payload).toMatchObject({ baseRef, headRef, diffSha256, completeDiff: true });
  });

  it('aborts if working bytes or HEAD move during a fallback turn without a ledger event', async () => {
    for (const change of ['working-bytes', 'head-only']) {
      let mutate = () => {};
      const h = await makeProductionGateHarness({ findingToWrite: [], onPrompt: () => mutate() });
      mutate = () => {
        if (change === 'working-bytes') writeFileSync(join(h.repo.path, 'src/prod.ts'), 'export const prod = 3;\n');
        else h.repo.git(['commit', '--allow-empty', '-qm', 'head moved without content change']);
      };
      const outcome = await h.wave.runRound({ jobId: h.job.id });
      if (!('route' in outcome)) throw new Error('expected fallback route');
      expect(outcome.clearToMerge).toBe(false);
      expect(outcome.note).toContain('working diff or HEAD changed');
      expect(h.ledger.listEvents({ limit: 100 }).some((event) => event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'pass')).toBe(false);
    }
  });

  it('invalidates binary mutations even when their abbreviated Git blob identities collide', async () => {
    let mutate = () => {};
    const h = await makeProductionGateHarness({ findingToWrite: [], onPrompt: () => mutate() });
    const path = join(h.repo.path, 'binary.bin');
    const first = Buffer.from('\0' + '00006161'); const second = Buffer.from('\0' + '00031931');
    writeFileSync(path, Buffer.from('\0base')); h.repo.git(['add', 'binary.bin']); h.repo.git(['commit', '-qm', 'binary baseline']);
    // Both candidate payloads stay uncommitted, so Git's object database
    // cannot widen their same-prefix abbreviated identities to disambiguate.
    writeFileSync(path, first);
    const shortBefore = h.repo.git(['diff', 'main', '--']);
    mutate = () => {
      writeFileSync(path, second);
      // Deterministic SHA-1-prefix collision: old/default diff text is identical.
      expect(h.repo.git(['diff', 'main', '--'])).toBe(shortBefore);
    };
    const outcome = await h.wave.runRound({ jobId: h.job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(false);
    expect(outcome.note).toContain('working diff or HEAD changed');
    expect(h.prompts[0]).toContain('GIT binary patch');
  });

  it('never lets configured textconv hide working-byte movement from the complete input identity', async () => {
    let mutate = () => {};
    const h = await makeProductionGateHarness({ findingToWrite: [], onPrompt: () => mutate() });
    h.repo.git(['update-ref', 'refs/heads/main', 'HEAD']);
    h.repo.git(['config', 'diff.hidden.textconv', `node -e 'process.stdout.write("constant\\n")'`]);
    h.repo.commitFile('.gitattributes', 'src/prod.ts diff=hidden\n');
    const convertedBefore = h.repo.git(['diff', 'main', '--']);
    mutate = () => {
      writeFileSync(join(h.repo.path, 'src/prod.ts'), 'export const prod = 4;\n');
      expect(h.repo.git(['diff', 'main', '--'])).toBe(convertedBefore);
    };
    const outcome = await h.wave.runRound({ jobId: h.job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(false);
    expect(outcome.note).toContain('working diff or HEAD changed');
  });

  it('never passes a submitted empty report when the fulfilled turn settled in-band error', async () => {
    const h = await makeProductionGateHarness({ findingToWrite: [], inBandError: true });
    const outcome = await h.wave.runRound({ jobId: h.job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(false);
    expect(outcome.note).toContain('fallback reviewer turn did not successfully complete');
    expect(h.ledger.listEvents({ limit: 100 }).some((event) => event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'pass')).toBe(false);
  });

  it('blocks when intent-to-add preparation fails instead of claiming an incomplete diff is complete', async () => {
    const h = await makeProductionGateHarness({ findingToWrite: [] });
    writeFileSync(join(h.repo.path, 'untracked.ts'), 'export const missed = true;\n');
    const lock = h.repo.git(['rev-parse', '--path-format=absolute', '--git-path', 'index.lock']);
    writeFileSync(lock, 'held by another writer');
    try {
      const outcome = await h.wave.runRound({ jobId: h.job.id });
      if (!('route' in outcome)) throw new Error('expected fallback route');
      expect(outcome.clearToMerge).toBe(false);
      expect(outcome.note).toContain('cannot prepare the complete fallback working diff');
      expect(h.prompts).toEqual([]);
      expect(h.spawnCwds).toEqual([]);
    } finally { rmSync(lock); }
  });

  it('blocks contradictory findings even when the model ignores the report-tool error', async () => {
    const h = await makeProductionGateHarness({ findingToWrite: [], conflictingReport: true });
    const outcome = await h.wave.runRound({ jobId: h.job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(false);
    expect(outcome.note).toContain('conflicting findings submissions');
    expect(readFileSync(outcome.reportFiles[0]!, 'utf8').trim()).toBe('[]');
  });

  it('blocks a fallback runtime that did not actually expose its scoped report tool', async () => {
    const h = await makeProductionGateHarness({ findingToWrite: [], missingReportTool: true });
    const outcome = await h.wave.runRound({ jobId: h.job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(false);
    expect(outcome.note).toContain('required host-bound findings tool');
    expect(h.prompts).toEqual([]);
    expect(h.disposed).toHaveLength(1);
  });

  it('spawns a minion with the skill prompt, parses findings, and reports clear-to-merge on clean', async () => {
    const h = await makeProductionGateHarness({ findingToWrite: [] });
    try {
      const outcome = await h.wave.runRound({ jobId: h.job.id });
      if (!('route' in outcome)) throw new Error('expected fallback route');
      expect(h.prompts).toHaveLength(1);
      expect(h.ledger.getAgent('prod-minion-1')).toMatchObject({ role: 'perkins', label: 'fallback-review', jobId: h.job.id, state: 'spawning' });
      expect(h.prompts[0]).toContain(h.skillPath);
      expect(h.prompts[0]).toContain('WORKING DIFF');
      expect(h.spawnCwds[0]).toBe(h.repo.path);
      expect(outcome.clearToMerge).toBe(true);
      expect(outcome.iterations).toBe(1);
      expect(outcome.reportFiles).toHaveLength(1);
      const phases = h.ledger.listEvents({ limit: 100 })
        .filter((event) => event.kind === 'job.fallback-review')
        .map((event) => (event.payload as { phase?: string }).phase)
        .reverse();
      expect(phases).toEqual(['started', 'triaged', 'pass']);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
      rmSync(h.artifacts, { recursive: true, force: true });
      rmSync(h.sessions, { recursive: true, force: true });
    }
  });

  it('a fallback review turn open at the transport wait is reported still-running, kept alive and reattached (j-1065 acceptance 2)', async () => {
    let release!: () => void;
    const hold = { release: new Promise<void>((resolve) => { release = resolve; }) };
    const h = await makeProductionGateHarness({ findingToWrite: [], promptHold: hold });
    vi.useFakeTimers();
    try {
      const running = h.wave.runRound({ jobId: h.job.id });
      await vi.advanceTimersByTimeAsync(FALLBACK_REVIEW_TIMEOUT_MS + 1);
      // The wait slice expired while the review turn was genuinely live: a
      // durable still-running report exists and the minion was NOT disposed.
      const phases = h.ledger.listEvents({ limit: 100 })
        .filter((event) => event.kind === 'job.fallback-review')
        .map((event) => (event.payload as { phase?: string }).phase)
        .reverse();
      expect(phases).toContain('still-running');
      expect(h.disposed).toEqual([]);
      expect(h.prompts).toHaveLength(1);
      release();
      const outcome = await running;
      if (!('route' in outcome)) throw new Error('expected fallback route');
      expect(outcome.clearToMerge).toBe(true);
      // The SAME session delivered the review; it was disposed only after.
      expect(h.prompts).toHaveLength(1);
      expect(h.disposed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      rmSync(h.root, { recursive: true, force: true });
      rmSync(h.artifacts, { recursive: true, force: true });
      rmSync(h.sessions, { recursive: true, force: true });
    }
  });

  it('the production fallback review takes a worker pacing slot before it spawns', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'holder' });
    const h = await makeProductionGateHarness({ findingToWrite: [], workerGate: gate });
    try {
      const running = h.wave.runRound({ jobId: h.job.id });
      await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1));
      expect(h.prompts).toHaveLength(0);
      expect(h.spawnCwds).toHaveLength(0);
      holder.release();
      const outcome = await running;
      if (!('route' in outcome)) throw new Error('expected fallback route');
      expect(outcome.clearToMerge).toBe(true);
      expect(h.prompts).toHaveLength(1);
      expect(gate.view().worker).toMatchObject({ running: 0, queued: [] });
    } finally {
      rmSync(h.root, { recursive: true, force: true });
      rmSync(h.artifacts, { recursive: true, force: true });
      rmSync(h.sessions, { recursive: true, force: true });
    }
  });

  it('a fallback rejection whose automatic retry recovers is parsed as delivered', async () => {
    const h = await makeProductionGateHarness({
      findingToWrite: [],
      failPrompt: true,
      retrySettlement: async () => 'recovered',
    });
    try {
      const outcome = await h.wave.runRound({ jobId: h.job.id });
      if (!('route' in outcome)) throw new Error('expected fallback route');
      expect(outcome.clearToMerge).toBe(true);
      expect(h.prompts).toHaveLength(1);
      const phases = h.ledger.listEvents({ limit: 100 })
        .filter((event) => event.kind === 'job.fallback-review')
        .map((event) => (event.payload as { phase?: string }).phase)
        .reverse();
      expect(phases).toEqual(['started', 'triaged', 'pass']);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
      rmSync(h.artifacts, { recursive: true, force: true });
      rmSync(h.sessions, { recursive: true, force: true });
    }
  });

  it('a fallback resolution whose bounded retry exhausts is recorded blocked, never delivered', async () => {
    const h = await makeProductionGateHarness({
      findingToWrite: [],
      retrySettlement: async () => 'exhausted',
    });
    try {
      const outcome = await h.wave.runRound({ jobId: h.job.id });
      if (!('route' in outcome)) throw new Error('expected fallback route');
      expect(outcome.clearToMerge).toBe(false);
      expect(h.escalations.some((entry) => entry.includes('BLOCKED'))).toBe(true);
      const phases = h.ledger.listEvents({ limit: 100 })
        .filter((event) => event.kind === 'job.fallback-review')
        .map((event) => (event.payload as { phase?: string }).phase);
      expect(phases[0]).toBe('blocked'); // newest-first order
    } finally {
      rmSync(h.root, { recursive: true, force: true });
      rmSync(h.artifacts, { recursive: true, force: true });
      rmSync(h.sessions, { recursive: true, force: true });
    }
  });

  it('terminalizes blocked when the minion never writes the report file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-nores-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-nores-art-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-prod-gate-nores-ses-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-prod-gate-nores-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'main', makeFixtureRepo('perkins-prod-gate-nores-repo').head());
    await port.createJobWorktree({ repoPath: makeFixtureRepo('perkins-prod-gate-nores-repo2').path, jobId: 'job-nores' });
    const job = ledger.addJob({ id: 'job-nores', repo: 'fixture', title: 'no report', baseBranch: 'main' });
    settleLane(ledger, job.id);
    const skillPath = join(artifacts, 'SKILL.md');
    writeFileSync(skillPath, 'skill', 'utf8');
    let promptText = '';
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: async (role, options = {}) => {
        const file = join(sessions, 'prod-nres.jsonl');
        writeFileSync(file, '', 'utf8');
        return {
          role, id: 'prod-nres', sessionFile: file,
          reviewTools: options.isolatedReview?.nativeTools?.map((tool) => tool.name),
          capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
          async prompt(text: string) { promptText = text; /* deliberately does NOT write the report */ },
          async steer() {}, async followUp() {},
          subscribe() { return () => {}; },
          health() { return { state: 'idle', lastActivity: null, sessionFile: file }; },
          async dispose() {},
        };
      },
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({
        ok: false,
        failures: [{ leg: 'model-provider', detail: 'not authed', remediation: 'auth' }],
      }),
      fallbackGate: {
        skillPath,
        fixDirectiveSink: async () => ({ delivered: true }),
      },
      escalate: () => {},
    });
    const outcome = await wave.runRound({ jobId: job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(false);
    expect(outcome.iterations).toBe(1); // first round throws (no report file) → blocked immediately
    expect(outcome.skillInstalled).toBe(true);
    expect(promptText).toContain('WORKING DIFF');
    const phases = ledger.listEvents({ limit: 200 })
      .filter((event) => event.kind === 'job.fallback-review')
      .map((event) => (event.payload as { phase?: string }).phase);
    expect(phases[0]).toBe('blocked'); // newest-first order
  });
});


describe('fallback diff includes untracked files (V3 revert-mutation pin)', () => {
  it('round-2 diff includes new-file fixes created by the fix directive', async () => {
    const repo = makeFixtureRepo('perkins-untracked-fix');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/untracked']);
    repo.commitFile('src/base.ts', 'export const base = 1;\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-untracked-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-untracked-art-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-untracked-ses-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-untracked-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/untracked', repo.head());
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-untracked-fix' });
    const job = ledger.addJob({ id: 'job-untracked-fix', repo: 'fixture', title: 'untracked', baseBranch: 'main' });
    settleLane(ledger, job.id);
    const skillFile = join(artifacts, 'SKILL.md');
    writeFileSync(skillFile, 'skill', 'utf8');
    const escalations: string[] = [];
    const diffsSeen: string[] = [];
    const blocker: FallbackFinding[] = [
      { title: 'missing feature', category: 'correctness', location: 'src/new.ts:1', evidence: 'N/A', detail: 'new file needed' },
    ];
    const wave = new WaveRunner({
      ledger, worktrees: port,
      spawner: makeSpawner(sessions, []),
      reviewArtifactRoot: artifacts,
      reviewPreflight: async () => ({
        ok: false,
        failures: [preflightFailure('review-policy', 'disabled')],
      }),
      fallbackGate: {
        skillPath: skillFile,
        runFallbackReview: async (input) => {
          diffsSeen.push(input.diff);
          const findings = input.iteration === 1 ? blocker : [];
          writeFileSync(input.reportFile, JSON.stringify(findings), 'utf8');
          return findings;
        },
        fixDirectiveSink: async () => {
          writeFileSync(join(repo.path, 'src', 'new-feature.ts'), 'export const fixed = true;\n');
          return { delivered: true, minionId: 'm1' };
        },
      },
      escalate: (title) => escalations.push(title),
    });
    const outcome = await wave.runRound({ jobId: job.id });
    if (!('route' in outcome)) throw new Error('expected fallback route');
    expect(outcome.clearToMerge).toBe(true);
    expect(diffsSeen.length).toBe(2);
    expect(diffsSeen[0]).not.toContain('new-feature.ts');
    expect(diffsSeen[1]).toContain('new-feature.ts');
  });
});

describe('fallback review wait constant is the still-running report slice (V4 pin)', () => {
  it('pins the 15-minute transport wait slice', async () => {
    const { FALLBACK_REVIEW_TIMEOUT_MS } = await import('../src/dispatch/perkins.js');
    expect(FALLBACK_REVIEW_TIMEOUT_MS).toBe(15 * 60 * 1_000);
    expect(FALLBACK_REVIEW_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('lens agent labels are unique across retries', () => {
  it('mints the classic label on attempt 1 and the attempt-suffixed label on retry', () => {
    expect(lensAgentLabel('blind', 1)).toBe('blind');
    expect(lensAgentLabel('blind', 2)).toBe('blind#2');
    // A retry never collides with its first attempt.
    expect(lensAgentLabel('blind', 2)).not.toBe(lensAgentLabel('blind', 1));
    expect(lensAgentLabel('edge', 2)).toBe('edge#2');
  });
});

describe('repair pass 3: GitHub receipt identity, state, and pagination (R4/R5/R6/R13)', () => {
  const head = '1'.repeat(40);
  const base = '2'.repeat(40);
  const body = 'review body\n';

  /** gh double with an authenticated-user probe, identity probe, a
   * configurable POST response and per-page review lists. */
  function makeDouble(options: {
    readonly login?: string;
    readonly loginProbeFails?: boolean;
    readonly created?: unknown;
    readonly reviewPages?: readonly unknown[];
    readonly identityBase?: string;
  }): { poster: GhPrPoster; log: string; repoPath: string } {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gh-p3-'));
    dirs.push(root);
    const log = join(root, 'calls.jsonl');
    const binary = join(root, 'gh-double.mjs');
    const repoPath = join(root, 'repo');
    execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://git.example.test/acme/widget.git']);
    const identityOutput = `${head}\t${options.identityBase ?? base}\n`;
    const userResponse = options.loginProbeFails === true
      ? 'process.exit(1);'
      : `process.stdout.write(${JSON.stringify(options.login ?? 'gru-bot')});`;
    writeFileSync(binary, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');\nconst argv = process.argv.slice(2);\nif (argv.includes('--method') && argv.includes('POST')) {\n  const parsed = JSON.parse(input);\n  const created = ${JSON.stringify(options.created === undefined ? 'null' : JSON.stringify(options.created))};\n  const receipt = created === 'null' ? null : JSON.parse(created);\n  const out = receipt ?? { id: 9001, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: parsed.commit_id, body: parsed.body };\n  process.stdout.write(JSON.stringify(out));\n} else if (argv.some((entry) => entry.includes('/reviews?'))) {\n  const page = Number(/[?&]page=(\\d+)/u.exec(argv.find((entry) => entry.includes('/reviews?')) ?? '')?.[1] ?? '1');\n  const pages = ${JSON.stringify(JSON.stringify(options.reviewPages ?? []))};\n  process.stdout.write(JSON.stringify(JSON.parse(pages)[page - 1] ?? []));\n} else if (argv.includes('user') && !argv.some((entry) => entry.includes('/'))) {\n  ${userResponse}\n} else {\n  process.stdout.write(${JSON.stringify(identityOutput)});\n}\n`, 'utf8');
    chmodSync(binary, 0o755);
    return { poster: new GhPrPoster(binary), log, repoPath };
  }
  const input = (repoPath: string) => ({
    prUrl: 'https://git.example.test/acme/widget/pull/42', host: 'git.example.test', repoPath,
    body, targetSha: head, baseSha: base,
  });

  it('refuses a null provider review id instead of stringifying it (R13)', async () => {
    const { poster, repoPath } = makeDouble({ created: { id: null, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: head, body } });
    await expect(poster.post(input(repoPath))).rejects.toThrow(/missing a review id/);
  });

  it('refuses a POST response whose enacted state is not COMMENTED (R6)', async () => {
    const { poster, repoPath } = makeDouble({ created: { id: 9002, user: { login: 'gru-bot' }, state: 'APPROVED', commit_id: head, body } });
    await expect(poster.post(input(repoPath))).rejects.toThrow(/APPROVED.*instead of COMMENTED|enacted/);
  });

  it('refuses a receipt authored by another account than the authenticated poster (R5)', async () => {
    const { poster, repoPath } = makeDouble({ created: { id: 9003, user: { login: 'someone-else' }, state: 'COMMENTED', commit_id: head, body } });
    await expect(poster.post(input(repoPath))).rejects.toThrow(/not the authenticated posting account/);
  });

  it('does not reconcile a copied review from another author even on the right commit (R5)', async () => {
    const { poster, repoPath } = makeDouble({
      reviewPages: [[{ id: 8000, user: { login: 'someone-else' }, state: 'COMMENTED', commit_id: head, body }]],
    });
    await expect(poster.reconcile!(input(repoPath))).resolves.toBeNull();
  });

  it('finds a correctly bound authored match beyond page one (R4)', async () => {
    const filler = Array.from({ length: 100 }, (_unused, index) => ({
      id: 7000 + index, user: { login: 'someone-else' }, state: 'COMMENTED', commit_id: 'f'.repeat(40), body: `filler ${index}`,
    }));
    const { poster, repoPath } = makeDouble({
      reviewPages: [
        filler,
        [{ id: 9100, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: head, body }],
      ],
    });
    await expect(poster.reconcile!(input(repoPath))).resolves.toMatchObject({ reviewId: '9100', actor: 'gru-bot', event: 'COMMENTED', commitId: head });
    const calls = readFileSync(join(dirname(repoPath), 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[]; stdout?: string });
    console.log('P3PAGE calls:', JSON.stringify(calls.map((call) => call.argv.filter((entry) => entry.includes('/reviews?') || entry.includes('user')))));
    expect(calls.filter((call) => call.argv.some((entry) => entry.includes('/reviews?')))).toHaveLength(2);
  });

  it('treats an exhausted pagination bound as unresolved, not proof of absence (R4)', async () => {
    const filler = Array.from({ length: 100 }, (_unused, index) => ({
      id: 7000 + index, user: { login: 'someone-else' }, state: 'COMMENTED', commit_id: 'f'.repeat(40), body: `filler ${index}`,
    }));
    const { poster, repoPath } = makeDouble({ reviewPages: [filler, filler, filler, filler, filler, filler, filler, filler, filler, filler, filler] });
    await expect(poster.reconcile!(input(repoPath))).rejects.toThrow(/exceeded.*pages.*unresolved|unresolved/);
  });

  it('searches reviews collected before the page bound before throwing it (R28)', async () => {
    const filler = Array.from({ length: 100 }, (_unused, index) => ({
      id: 7000 + index, user: { login: 'someone-else' }, state: 'COMMENTED', commit_id: 'f'.repeat(40), body: `filler ${index}`,
    }));
    // A fully bound authored match sits on page one; ten FULL pages hit
    // the lookup bound. The collected match is delivery evidence and must
    // be returned instead of discarded by the bound error.
    const { poster, repoPath } = makeDouble({
      reviewPages: [
        [{ id: 9200, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: head, body }, ...filler.slice(1)],
        ...Array.from({ length: 9 }, () => filler),
      ],
    });
    await expect(poster.reconcile!(input(repoPath))).resolves.toMatchObject({ reviewId: '9200', actor: 'gru-bot', event: 'COMMENTED', commitId: head });
  });

  it('returns an earlier usable bound match when a later match carries an unusable id (R13/R28)', async () => {
    const unusable = { id: null, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: head, body };
    const usable = { id: 9101, user: { login: 'gru-bot' }, state: 'COMMENTED', commit_id: head, body };
    const mixed = makeDouble({ reviewPages: [[usable, unusable]] });
    await expect(mixed.poster.reconcile!(input(mixed.repoPath))).resolves.toMatchObject({ reviewId: '9101', commitId: head });
    // If EVERY collected match is unusable the outcome is a loud refusal,
    // never reported as absence (which could invite a duplicate POST).
    const allUnusable = makeDouble({ reviewPages: [[unusable]] });
    await expect(allUnusable.poster.reconcile!(input(allUnusable.repoPath))).rejects.toThrow(/missing a review id/);
  });

  it('probes the authenticated account BEFORE the irreversible POST (R32)', async () => {
    const { poster, log, repoPath } = makeDouble({ loginProbeFails: true });
    await expect(poster.post(input(repoPath))).rejects.toThrow(/cannot resolve the authenticated gh account/);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] });
    // The failed identity probe means NO review POST was ever issued: a
    // credential hiccup cannot strand a genuinely published review.
    expect(calls.some((call) => call.argv.includes('--method'))).toBe(false);
  });

  it('refuses an unrecordable receipt when the identity probe omits the base (R34)', async () => {
    const { poster, log, repoPath } = makeDouble({ identityBase: '' });
    await expect(poster.post(input(repoPath))).rejects.toThrow(/missing the base sha/);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv).toEqual(['api', '--hostname', 'git.example.test', 'repos/acme/widget/pulls/42', '--jq', '[.head.sha,.base.sha] | @tsv']);
  });

  it('re-resolves the authenticated login after a credential rotation on the same host (R29)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gh-rotate-'));
    dirs.push(root);
    const log = join(root, 'calls.jsonl');
    const binary = join(root, 'gh-double.mjs');
    const loginFile = join(root, 'login.txt');
    const repoPath = join(root, 'repo');
    writeFileSync(loginFile, 'gru-bot', 'utf8');
    execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://git.example.test/acme/widget.git']);
    writeFileSync(binary, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');\nconst argv = process.argv.slice(2);\nconst login = readFileSync(${JSON.stringify(loginFile)}, 'utf8').trim();\nif (argv.includes('--method') && argv.includes('POST')) {\n  const parsed = JSON.parse(input);\n  process.stdout.write(JSON.stringify({ id: 9300, user: { login }, state: 'COMMENTED', commit_id: parsed.commit_id, body: parsed.body }));\n} else if (argv.includes('user') && !argv.some((entry) => entry.includes('/'))) {\n  process.stdout.write(login);\n} else {\n  process.stdout.write(${JSON.stringify(`${head}\t${base}\n`)});\n}\n`, 'utf8');
    chmodSync(binary, 0o755);
    const poster = new GhPrPoster(binary);
    await expect(poster.post(input(repoPath))).resolves.toMatchObject({ actor: 'gru-bot' });
    // The credential rotates under the long-lived poster: the next post
    // must compare against the NEW account, never a host-keyed stale
    // cache (R29).
    writeFileSync(loginFile, 'new-bot', 'utf8');
    await expect(poster.post(input(repoPath))).resolves.toMatchObject({ actor: 'new-bot' });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] });
    expect(calls.filter((call) => call.argv.includes('user'))).toHaveLength(2);
  });


  it('resolves the authenticated login PER HOST — two hosts, two accounts (B3)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gh-twohosts-'));
    dirs.push(root);
    const log = join(root, 'calls.jsonl');
    const binary = join(root, 'gh-double.mjs');
    const repoPath = join(root, 'repo');
    execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://git.example.test/acme/widget.git']);
    writeFileSync(binary, `#!/usr/bin/env node\nimport { appendFileSync, readFileSync } from 'node:fs';\nconst input = readFileSync(0, 'utf8');\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), input }) + '\\n');\nconst argv = process.argv.slice(2);\nconst host = argv[argv.indexOf('--hostname') + 1];\nconst login = host === 'git.example.test' ? 'gru-bot' : 'enterprise-bot';\nif (argv.includes('--method') && argv.includes('POST')) {\n  const parsed = JSON.parse(input);\n  process.stdout.write(JSON.stringify({ id: 9500, user: { login }, state: 'COMMENTED', commit_id: parsed.commit_id, body: parsed.body }));\n} else if (argv.includes('user') && !argv.some((entry) => entry.includes('/'))) {\n  process.stdout.write(login);\n} else {\n  process.stdout.write(${JSON.stringify(`${head}\t${base}\n`)});\n}\n`, 'utf8');
    chmodSync(binary, 0o755);
    const poster = new GhPrPoster(binary);
    // Two github-form PRs on two hosts: each receipt actor must match ITS
    // host's authenticated account — a single-instance cache would cross
    // them and refuse the second delivery.
    for (const [host, owner] of [['git.example.test', 'acme'], ['gh.enterprise.example', 'acme']] as const) {
      const repoDir = join(root, `repo-${host.replace(/[^A-Za-z0-9.-]/gu, '-')}`);
      execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
      execFileSync('git', ['-C', repoDir, 'remote', 'add', 'origin', `https://${host}/${owner}/widget.git`]);
      await expect(poster.post({
        prUrl: `https://${host}/${owner}/widget/pull/7`, host, repoPath: repoDir,
        body: 'multi-host body\n', targetSha: head, baseSha: base,
      })).resolves.toMatchObject({ actor: host === 'git.example.test' ? 'gru-bot' : 'enterprise-bot', event: 'COMMENTED' });
    }
  });

  it('skips PENDING drafts: only an authored COMMENTED publication reconciles (R6/R5)', async () => {
    const { poster, repoPath } = makeDouble({
      reviewPages: [[{ id: 8001, user: { login: 'gru-bot' }, state: 'PENDING', commit_id: head, body }]],
    });
    await expect(poster.reconcile!(input(repoPath))).resolves.toBeNull();
  });
});


describe('repair pass 3: provider forms and posting-account discipline', () => {
  it('derives the provider kind from the URL form, including custom-host merge requests (B1)', () => {
    expect(publicationProviderKindFor('https://git.custom.example/group/repo/-/merge_requests/5')).toBe('gitlab');
    expect(publicationProviderKindFor('https://gitlab.example.test/acme/widget/-/merge_requests/7')).toBe('gitlab');
    expect(publicationProviderKindFor('https://github.com/acme/widget/pull/42')).toBe('github');
    expect(publicationProviderKindFor('https://git.enterprise.example/acme/widget/pull/42')).toBe('github');
    expect(publicationProviderKindFor('https://odd.example/x/y/issues/9')).toBe('unknown');
    expect(publicationProviderKindFor(null)).toBe('unknown');
  });

  it('refuses a GitLab POST note authored by another account than the token (V1)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gl-author-'));
    dirs.push(root);
    const repoPath = join(root, 'repo');
    execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://gitlab.example.test/acme/widget.git']);
    const head = 'a'.repeat(40);
    const fetchImpl = async (url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
      if (url.endsWith('/user')) return { ok: true, status: 200, text: async () => JSON.stringify({ username: 'fixture-bot' }) };
      if (url.includes('/notes') && !url.includes('?')) {
        return { ok: true, status: 201, text: async () => JSON.stringify({ id: 61, body: 'note body\n', author: { username: 'someone-else' } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ sha: head, diff_refs: { base_sha: 'b'.repeat(40) } }) };
    };
    const poster = new GitLabMrPoster({ token: 'glpat-token', fetchImpl: fetchImpl as never });
    await expect(poster.post({
      prUrl: 'https://gitlab.example.test/acme/widget/-/merge_requests/7', host: 'gitlab.example.test', repoPath,
      body: 'note body\n', targetSha: head, baseSha: 'b'.repeat(40),
    })).rejects.toThrow(/not the authenticated posting account/);
  });
});

describe('repair pass 3: GitLab note reconciliation fails closed (R3/T7)', () => {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const mrUrl = 'https://gitlab.example.test/acme/widget/-/merge_requests/7';
  const body = 'review body\n';

  function gitlabDouble(options: {
    readonly user?: string;
    readonly notePages?: readonly unknown[];
    readonly mrStatus?: number;
    readonly mrBaseSha?: string | null;
    readonly mrBaseShaAfterPost?: string | null;
    readonly noteCreated?: unknown;
  }): { poster: GitLabMrPoster; repoPath: string; calls: Array<{ url: string; init?: unknown }> } {
    const root = mkdtempSync(join(tmpdir(), 'perkins-gl-p3-'));
    dirs.push(root);
    const repoPath = join(root, 'repo');
    execFileSync('git', ['init', repoPath], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', 'https://gitlab.example.test/acme/widget.git']);
    const calls: Array<{ url: string; init?: unknown }> = [];
    const primaryBase = options.mrBaseSha === undefined ? base : options.mrBaseSha;
    const laterBase = options.mrBaseShaAfterPost === undefined ? primaryBase : options.mrBaseShaAfterPost;
    let mrCallCount = 0;
    const mr = () => {
      const chosen = mrCallCount === 0 ? primaryBase : laterBase;
      mrCallCount += 1;
      return { status: options.mrStatus ?? 200, body: JSON.stringify(chosen === null ? { sha: head } : { sha: head, diff_refs: { base_sha: chosen } }) };
    };
    const fetchImpl = async (url: string, init?: unknown): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
      calls.push({ url, init });
      if (url.endsWith('/user')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ username: options.user ?? 'gru-bot' }) };
      }
      if (url.includes('/notes?')) {
        const page = Number(/[?&]page=(\d+)/u.exec(url)?.[1] ?? '1');
        const pages = options.notePages ?? [];
        return { ok: true, status: 200, text: async () => JSON.stringify(pages[page - 1] ?? []) };
      }
      if (url.includes('/notes')) {
        const created = options.noteCreated ?? { id: 55, body, author: { username: options.user ?? 'gru-bot' } };
        return { ok: true, status: 201, text: async () => JSON.stringify(created) };
      }
      const response = mr();
      return { ok: response.status < 300, status: response.status, text: async () => response.body };
    };
    return { poster: new GitLabMrPoster({ token: 'glpat-token', fetchImpl: fetchImpl as never }), repoPath, calls };
  }
  const input = (repoPath: string) => ({
    prUrl: mrUrl, host: 'gitlab.example.test', repoPath, body, targetSha: head, baseSha: base,
  });

  it('throws unresolved on ANY body-matching authored note: the creation head cannot be proved (R3)', async () => {
    const { poster, repoPath } = gitlabDouble({
      notePages: [[{ id: 55, body, author: { username: 'gru-bot' } }]],
    });
    await expect(poster.reconcile!(input(repoPath))).rejects.toThrow(/cannot prove|fail closed|unresolved/);
  });

  it('fails closed even when the matching note sits beyond page one (R3/R4)', async () => {
    const filler = Array.from({ length: 100 }, (_unused, index) => ({
      id: 6000 + index, body: `unrelated note ${index}`, author: { username: 'someone-else' },
    }));
    const { poster, repoPath } = gitlabDouble({
      notePages: [filler, [{ id: 56, body, author: { username: 'gru-bot' } }]],
    });
    await expect(poster.reconcile!(input(repoPath))).rejects.toThrow(/cannot prove|fail closed|unresolved/);
  });

  it('returns null only when exhaustive pagination finds no authored body match (R4)', async () => {
    const filler = Array.from({ length: 100 }, (_unused, index) => ({
      id: 6000 + index, body: `unrelated note ${index}`, author: { username: 'someone-else' },
    }));
    const { poster, repoPath } = gitlabDouble({ notePages: [filler, []] });
    await expect(poster.reconcile!(input(repoPath))).resolves.toBeNull();
  });

  it('treats an exhausted pagination bound as unresolved, never as absence (R4)', async () => {
    const filler = Array.from({ length: 100 }, (_unused, index) => ({
      id: 6000 + index, body: `unrelated note ${index}`, author: { username: 'someone-else' },
    }));
    const { poster, repoPath } = gitlabDouble({ notePages: [filler, filler, filler, filler, filler, filler, filler, filler, filler, filler, filler] });
    await expect(poster.reconcile!(input(repoPath))).rejects.toThrow(/exceeded.*pages|unresolved/);
  });

  it('refuses a null or unusable note id instead of stringifying it (R27)', async () => {
    for (const [label, id] of [['null', null], ['boolean', true], ['fractional', 1.5]] as const) {
      const { poster, repoPath } = gitlabDouble({ noteCreated: { id, body, author: { username: 'gru-bot' } } });
      await expect(poster.post(input(repoPath)), label).rejects.toThrow(/missing a review id/);
    }
    // A well-formed id still records normally, including a provider string.
    const good = gitlabDouble({ noteCreated: { id: 55, body, author: { username: 'gru-bot' } } });
    await expect(good.poster.post(input(good.repoPath))).resolves.toMatchObject({ reviewId: '55' });
    const quoted = gitlabDouble({ noteCreated: { id: '56', body, author: { username: 'gru-bot' } } });
    await expect(quoted.poster.post(input(quoted.repoPath))).resolves.toMatchObject({ reviewId: '56' });
  });

  it('refuses a GitLab delivery whose identity probe omits the MR base, before the note exists (R34)', async () => {
    const missing = gitlabDouble({ mrBaseSha: null });
    await expect(missing.poster.post(input(missing.repoPath))).rejects.toThrow(/missing the base sha/);
    // Only the pre-POST identity probe ran; no note was created.
    expect(missing.calls).toHaveLength(1);
    expect(missing.calls.some((call) => call.url.includes('/notes'))).toBe(false);

    // A base that vanishes between the pre-POST probe and the post-delivery
    // confirmation falls back to the base PROVEN for this same head by the
    // pre-POST probe instead of stranding a note that already exists.
    const vanished = gitlabDouble({ mrBaseShaAfterPost: null, noteCreated: { id: 57, body, author: { username: 'gru-bot' } } });
    await expect(vanished.poster.post(input(vanished.repoPath))).resolves.toMatchObject({ reviewId: '57', baseSha: base });
    expect(vanished.calls.some((call) => call.url.includes('/notes') && !call.url.includes('?'))).toBe(true);

    // A whitespace-only base is as unusable as a missing one (the shared
    // reader trims): it is refused BEFORE the note exists.
    const whitespace = gitlabDouble({ mrBaseSha: '   ' });
    await expect(whitespace.poster.post(input(whitespace.repoPath))).rejects.toThrow(/missing the base sha/);
    expect(whitespace.calls).toHaveLength(1);
    expect(whitespace.calls.some((call) => call.url.includes('/notes'))).toBe(false);
  });

  it('treats a body-identical note by another author as ambiguity, never as absence (R35)', async () => {
    const foreign = gitlabDouble({ notePages: [[{ id: 77, body, author: { username: 'someone-else' } }]] });
    await expect(foreign.poster.reconcile!(input(foreign.repoPath)))
      .rejects.toThrow(/body-identical note\(s\) by @someone-else but none authored by gru-bot.*AMBIGUOUS/);

    // The other-author match also decides a bounded lookup: pages that
    // would otherwise hit the page cap stay ambiguous, never absent.
    const filler = Array.from({ length: 100 }, (_unused, index) => ({
      id: 6000 + index, body: `unrelated note ${index}`, author: { username: 'someone-else' },
    }));
    const late = gitlabDouble({ notePages: [filler, [{ id: 78, body, author: { username: 'someone-else' } }]] });
    await expect(late.poster.reconcile!(input(late.repoPath))).rejects.toThrow(/AMBIGUOUS/);

    // ...and at the page cap itself: ten FULL pages where the only body
    // match is foreign must still report ambiguity, not the generic bound.
    const capped = gitlabDouble({
      notePages: [
        ...Array.from({ length: 9 }, () => filler),
        [...filler.slice(1), { id: 80, body, author: { username: 'someone-else' } }],
      ],
    });
    await expect(capped.poster.reconcile!(input(capped.repoPath))).rejects.toThrow(/AMBIGUOUS/);

    // A body match with no usable author is unattributed: ambiguity too,
    // never assumed to be this service's note.
    const unattributed = gitlabDouble({ notePages: [[{ id: 79, body, author: {} }]] });
    await expect(unattributed.poster.reconcile!(input(unattributed.repoPath))).rejects.toThrow(/unattributed/);
  });
});

describe('repair pass 3: restart recovery binding contract (R1/R2/R21)', () => {

  async function recoveryFixture(name: string, shared?: {
    ledger: LedgerApi; port: GitReviewPort; artifacts: string; repo?: FixtureRepo; commit?: string;
  }): Promise<{
    ledger: LedgerApi; port: GitReviewPort; artifacts: string; job: ReturnType<LedgerApi['getJob']>;
    roundId: string; targetSha: string; repo: FixtureRepo; commit: string;
  }> {
    // A shared repo/ledger/port reuses the expensive git plumbing across
    // cases that only need their own round (the R1 case above shares the
    // same way). The first call builds it; later calls ride it and return
    // the same handles.
    const repo = shared?.repo ?? makeFixtureRepo(name);
    if (shared?.repo === undefined) {
      repos.push(repo);
      repo.git(['checkout', '-b', `feature/${name}`]);
    }
    const commit = shared?.commit ?? repo.commitFile('src/main.ts', 'export const p3 = 3;\n');
    let artifacts: string;
    let ledger: LedgerApi;
    let port: GitReviewPort;
    if (shared !== undefined) {
      ({ artifacts, ledger, port } = shared);
    } else {
      const root = mkdtempSync(join(tmpdir(), `${name}-port-`));
      artifacts = mkdtempSync(join(tmpdir(), `${name}-artifacts-`));
      dirs.push(root, artifacts);
      const db = new LedgerDb(mkdtempSync(join(tmpdir(), `${name}-db-`)));
      dbs.push(db);
      ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      port = new GitReviewPort(root, `feature/${name}`, commit);
    }
    await port.createJobWorktree({ repoPath: repo.path, jobId: `job-${name}` });
    const job = ledger.addJob({ id: `job-${name}`, repo: 'fixture', title: name, baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, `https://git.example.invalid/acme/fixture/pull/${name.length}`);
    const round = ledger.addRound({ jobId: job.id, lenses: ['blind'], targetRef: commit });
    await port.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: commit, jobId: job.id });
    ledger.setRoundStatus(round.id, 'live');
    // Return the REFRESHED job record (with prUrl) — the addJob snapshot
    // predates setJobPr.
    return { ledger, port, artifacts, job: ledger.getJob(job.id), roundId: round.id, targetSha: commit, repo, commit };
  }

  function healthyEvent(roundId: string, artifacts: string, prUrl: string, targetSha: string): { payload: Record<string, unknown>; publicationFile: string; sha: string } {
    const roundDir = join(artifacts, roundId);
    mkdirSync(roundDir, { recursive: true });
    const contents = '# Perkins Code Review\n\n**Verdict: NEEDS CHANGES**\n';
    const publicationFile = join(roundDir, 'perkins-report.publication.md');
    writeFileSync(publicationFile, contents, 'utf8');
    const sha = createHash('sha256').update(contents, 'utf8').digest('hex');
    return {
      publicationFile,
      sha,
      payload: {
        verdict: 'changes-requested', canonicalVerdict: 'NEEDS CHANGES', url: prUrl, host: new URL(prUrl).host,
        targetSha, baseSha: '2'.repeat(40),
        publicationFile, publicationSha256: sha,
        receipt: { reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: targetSha, headSha: targetSha, baseSha: '2'.repeat(40), bodySha256: sha },
        reconciled: false,
      },
    };
  }

  it('a null or malformed receipt interrupts its own round without crashing recovery of the rest (R1)', async () => {
    const first = await recoveryFixture('p3-r1-a');
    // Second round in the SAME ledger/port: recovery iterates both lanes;
    // the malformed one must not abort the loop.
    const second = await recoveryFixture('p3-r1-b', { ledger: first.ledger, port: first.port, artifacts: first.artifacts });
    // (a) receipt:null on the first round.
    const malformed = healthyEvent(first.roundId, first.artifacts, first.job!.prUrl!, first.targetSha);
    first.ledger.appendCustomEvent({
      kind: 'round.posted', jobId: first.job!.id, roundId: first.roundId,
      payload: { ...malformed.payload, receipt: null },
    });
    // (b) a healthy bound event on the second round.
    const healthy = healthyEvent(second.roundId, second.artifacts, second.job!.prUrl!, second.targetSha);
    second.ledger.appendCustomEvent({
      kind: 'round.posted', jobId: second.job!.id, roundId: second.roundId, payload: healthy.payload,
    });
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger: first.ledger, worktrees: first.port, spawner: vi.fn() as unknown as AgentSpawner,
      poster: { post: vi.fn(), authenticatedActor: async () => 'gru-bot' },
      reviewArtifactRoot: first.artifacts, escalate: (title) => escalations.push(title),
    });
    await expect(wave.recoverInterruptedRounds()).resolves.toBe(2);
    expect(first.ledger.getRound(first.roundId)?.status).toBe('aborted');
    expect(first.ledger.getRound(first.roundId)?.verdict).toBeNull();
    expect(escalations.some((title) => title.includes('without a provider-bound receipt'))).toBe(true);
    // The OTHER round in the same ledger still recovered.
    expect(first.ledger.getRound(second.roundId)?.status).toBe('verdict-posted');
    expect(first.ledger.getRound(second.roundId)?.verdict).toBe('changes-requested');
  });

  it('a matching digest at a FOREIGN path is not this round\'s publication evidence (R21)', async () => {
    const { ledger, port, artifacts, job, roundId, targetSha } = await recoveryFixture('p3-r21-foreign');
    const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
    // Copy the exact bytes elsewhere and point the event at the copy.
    const foreignDir = mkdtempSync(join(tmpdir(), 'p3-foreign-'));
    dirs.push(foreignDir);
    const foreignFile = join(foreignDir, 'lookalike.md');
    writeFileSync(foreignFile, readFileSync(good.publicationFile, 'utf8'), 'utf8');
    ledger.appendCustomEvent({
      kind: 'round.posted', jobId: job!.id, roundId,
      payload: { ...good.payload, publicationFile: foreignFile },
    });
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: artifacts, escalate: (title) => escalations.push(title),
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(roundId)?.status).toBe('aborted');
    expect(ledger.getRound(roundId)?.verdict).toBeNull();
    expect(escalations.some((line) => line.includes('without a provider-bound receipt'))).toBe(true);
  });

  it('a symlinked canonical publication path is refused as an alias (R21)', async () => {
    const { ledger, port, artifacts, job, roundId, targetSha } = await recoveryFixture('p3-r21-symlink');
    const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
    const real = join(artifacts, roundId, 'real.md');
    writeFileSync(real, readFileSync(good.publicationFile, 'utf8'), 'utf8');
    rmSync(good.publicationFile);
    symlinkSync(real, good.publicationFile);
    ledger.appendCustomEvent({ kind: 'round.posted', jobId: job!.id, roundId, payload: good.payload });
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner, reviewArtifactRoot: artifacts,
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(roundId)?.status).toBe('aborted');
  });

  it('a receipt with an unknown enacted event or foreign PR URL never promotes (R2)', async () => {
    // One shared repo/ledger/port serves all eight mutations: the contract
    // under test is the receipt binding, and a fresh repo + db per case
    // spent most of this test's budget on git plumbing (the R1 case above
    // shares the same way). Every mutation keeps its own round and every
    // assertion is unchanged.
    let shared: {
      ledger: LedgerApi; port: GitReviewPort; artifacts: string; repo: FixtureRepo; commit: string;
    } | undefined;
    for (const [label, mutate] of [
      ['unknown event', (payload: Record<string, unknown>) => ({ ...payload, receipt: { ...(payload.receipt as object), event: 'APPROVED' } })],
      ['foreign url', (payload: Record<string, unknown>) => ({ ...payload, url: 'https://elsewhere.invalid/acme/other/pull/9' })],
      ['comment binding mismatch', (payload: Record<string, unknown>) => ({ ...payload, receipt: { ...(payload.receipt as object), commitId: 'f'.repeat(40) } })],
      ['note claiming a commit', (payload: Record<string, unknown>) => ({ ...payload, receipt: { ...(payload.receipt as object), event: 'note', commitId: 'f'.repeat(40) } })],
      ['verdict contradicts canonical', (payload: Record<string, unknown>) => ({ ...payload, verdict: 'approved', canonicalVerdict: 'NEEDS CHANGES' })],
      ['gitlab note on a github-form PR', (payload: Record<string, unknown>) => ({ ...payload, receipt: { ...(payload.receipt as object), event: 'note', commitId: null } })],
      ['malformed review id', (payload: Record<string, unknown>) => ({ ...payload, receipt: { ...(payload.receipt as object), reviewId: '9001\ninjected' } })],
      ['missing actor', (payload: Record<string, unknown>) => ({ ...payload, receipt: { ...(payload.receipt as object), actor: ' ' } })],
    ] as const) {
      const fixture = await recoveryFixture(`p3-r2-${label.replace(/\W+/gu, '-')}`, shared);
      shared ??= {
        ledger: fixture.ledger, port: fixture.port, artifacts: fixture.artifacts,
        repo: fixture.repo, commit: fixture.commit,
      };
      const { ledger, port, artifacts, job, roundId, targetSha } = fixture;
      const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
      ledger.appendCustomEvent({ kind: 'round.posted', jobId: job!.id, roundId, payload: mutate(good.payload) });
      const wave = new WaveRunner({
        ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner, reviewArtifactRoot: artifacts,
      });
      expect(await wave.recoverInterruptedRounds(), label).toBe(1);
      expect(ledger.getRound(roundId)?.status, label).toBe('aborted');
      expect(ledger.getRound(roundId)?.verdict, label).toBeNull();
    }
  });

  it('promotes ONLY the correctly bound event of the same round (R2 happy path)', async () => {
    const { ledger, port, artifacts, job, roundId, targetSha } = await recoveryFixture('p3-r2-happy');
    const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
    ledger.appendCustomEvent({ kind: 'round.posted', jobId: job!.id, roundId, payload: good.payload });
    const poster = { post: vi.fn(), authenticatedActor: async () => 'gru-bot' } as unknown as VerdictPoster;
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
      poster, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(roundId)?.status).toBe('verdict-posted');
    expect(ledger.getRound(roundId)?.verdict).toBe('changes-requested');
    expect(poster.post).not.toHaveBeenCalled();
  });

  it('promotes a posted event only when the actor matches the evidenced account (R30)', async () => {
    const { ledger, port, artifacts, job, roundId, targetSha } = await recoveryFixture('p3-r30-match');
    const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
    ledger.appendCustomEvent({ kind: 'round.posted', jobId: job!.id, roundId, payload: good.payload });
    const poster = { post: vi.fn(), authenticatedActor: vi.fn(async () => 'GRU-BOT') };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
      poster, reviewArtifactRoot: artifacts,
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(roundId)).toMatchObject({ status: 'verdict-posted', verdict: 'changes-requested' });
    // Case-insensitive exactly like the live writer paths, and the account
    // is probed for the posted event's host — never taken from the event.
    expect(poster.authenticatedActor).toHaveBeenCalledWith('git.example.invalid');
    expect(poster.post).not.toHaveBeenCalled();
  });

  it('refuses to credit a posted event naming a different well-formed actor than the evidenced account (R30)', async () => {
    const { ledger, port, artifacts, job, roundId, targetSha } = await recoveryFixture('p3-r30-mismatch');
    const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
    ledger.appendCustomEvent({ kind: 'round.posted', jobId: job!.id, roundId, payload: good.payload });
    const escalations: string[] = [];
    const poster = { post: vi.fn(), authenticatedActor: vi.fn(async () => 'someone-else') };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
      poster, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(roundId)).toMatchObject({ status: 'aborted', verdict: null });
    expect(escalations.some((line) => line.includes('receipt actor') && line.includes('someone-else') && line.includes('gru-bot'))).toBe(true);
  });

  it('refuses to promote an actor no poster can evidence (R30)', async () => {
    const { ledger, port, artifacts, job, roundId, targetSha } = await recoveryFixture('p3-r30-unprovable');
    const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
    ledger.appendCustomEvent({ kind: 'round.posted', jobId: job!.id, roundId, payload: good.payload });
    const escalations: string[] = [];
    const poster = { post: vi.fn() };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
      poster, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(roundId)).toMatchObject({ status: 'aborted', verdict: null });
    expect(escalations.some((line) => line.includes('cannot evidence the posting account'))).toBe(true);
  });

  it('refuses to promote when the recovery identity probe fails (R30)', async () => {
    const { ledger, port, artifacts, job, roundId, targetSha } = await recoveryFixture('p3-r30-probe-fail');
    const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
    ledger.appendCustomEvent({ kind: 'round.posted', jobId: job!.id, roundId, payload: good.payload });
    const escalations: string[] = [];
    const poster = { post: vi.fn(), authenticatedActor: vi.fn(async () => { throw new Error('gh credential unavailable'); }) };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
      poster, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(roundId)).toMatchObject({ status: 'aborted', verdict: null });
    expect(escalations.some((line) => line.includes('could not be evidenced') && line.includes('gh credential unavailable'))).toBe(true);
  });

  it('refuses promotion of a fully bound event whose canonical bytes fail only the digest check (R36)', async () => {
    for (const [label, tamper] of [
      ['tampered bytes', (directory: string) => { writeFileSync(join(directory, 'perkins-report.publication.md'), '# tampered\n', 'utf8'); }],
      ['deleted file', (directory: string) => { rmSync(join(directory, 'perkins-report.publication.md'), { force: true }); }],
      ['symlink swap', (directory: string) => {
        const canonical = join(directory, 'perkins-report.publication.md');
        const real = join(directory, 'real.md');
        writeFileSync(real, readFileSync(canonical, 'utf8'), 'utf8');
        rmSync(canonical);
        symlinkSync(real, canonical);
      }],
    ] as const) {
      const slug = label.replace(/\W+/gu, '-');
      const { ledger, port, artifacts, job, roundId, targetSha } = await recoveryFixture(`p3-r36-${slug}`);
      const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
      tamper(join(artifacts, roundId));
      ledger.appendCustomEvent({ kind: 'round.posted', jobId: job!.id, roundId, payload: good.payload });
      const escalations: string[] = [];
      const poster = { post: vi.fn(), authenticatedActor: vi.fn(async () => 'gru-bot') };
      const wave = new WaveRunner({
        ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
        poster, reviewArtifactRoot: artifacts,
        escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      });
      // Every earlier binding check passes (actor evidenced, host/reconciled
      // fields valid, job PR bound): the ONLY failing gate is the digest /
      // canonical-file evidence this fixture targets.
      expect(await wave.recoverInterruptedRounds(), label).toBe(1);
      expect(ledger.getRound(roundId)?.status, label).toBe('aborted');
      expect(ledger.getRound(roundId)?.verdict, label).toBeNull();
      expect(escalations.some((line) => line.includes('did not match the posted digest')), label).toBe(true);
    }
  });

  it('refuses a posted event whose host is not its pull request URL host, without probing it (R30)', async () => {
    const { ledger, port, artifacts, job, roundId, targetSha } = await recoveryFixture('p3-r30-host-binding');
    const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
    ledger.appendCustomEvent({
      kind: 'round.posted', jobId: job!.id, roundId,
      payload: { ...good.payload, host: 'gitlab.attacker.test' },
    });
    const escalations: string[] = [];
    const poster = { post: vi.fn(), authenticatedActor: vi.fn(async () => 'gru-bot') };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
      poster, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(roundId)).toMatchObject({ status: 'aborted', verdict: null });
    // The forged host never reaches the identity probe with a credential.
    expect(poster.authenticatedActor).not.toHaveBeenCalled();
    expect(escalations.some((line) => line.includes('host does not match its pull request URL'))).toBe(true);
  });

  it('recovers a fully bound posted event even when the review lane registration was lost (R30/R1)', async () => {
    const { ledger, port, artifacts, job, roundId, targetSha } = await recoveryFixture('p3-r30-missing-lane');
    const good = healthyEvent(roundId, artifacts, job!.prUrl!, targetSha);
    ledger.appendCustomEvent({ kind: 'round.posted', jobId: job!.id, roundId, payload: good.payload });
    // Present the lost-registration state through the same port interface:
    // the round exists in the ledger but has no lane row at all.
    const laneLessPort: WorktreePort = {
      createJobWorktree: (input) => port.createJobWorktree(input),
      resolveReviewTarget: (input) => port.resolveReviewTarget(input),
      createReviewWorktree: (input) => port.createReviewWorktree(input),
      createChildWorktree: (input) => port.createChildWorktree(input),
      getWorktree: (id) => port.getWorktree(id),
      listWorktrees: (opts) => port.listWorktrees(opts).filter((lane) => lane.roundId !== roundId),
      release: (input) => port.release(input),
    };
    const poster = { post: vi.fn(), authenticatedActor: async () => 'gru-bot' };
    const wave = new WaveRunner({
      ledger, worktrees: laneLessPort, spawner: vi.fn() as unknown as AgentSpawner,
      poster, reviewArtifactRoot: artifacts,
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(roundId)).toMatchObject({ status: 'verdict-posted', verdict: 'changes-requested' });
    expect(ledger.latestRoundEvent(roundId, 'round.post-recovered')?.payload).toMatchObject({ verdict: 'changes-requested' });
    expect(poster.post).not.toHaveBeenCalled();
  });

  it('routes restart-recovery identity evidence through the host-selected composite (R30)', async () => {
    const gitlabUrl = 'https://gitlab.example.test/acme/fixture/-/merge_requests/7';
    const makeGitlabPost = async (name: string, evidencedAccount: string) => {
      const fixture = await recoveryFixture(name);
      fixture.ledger.setJobPr(fixture.job!.id, gitlabUrl);
      const good = healthyEvent(fixture.roundId, fixture.artifacts, gitlabUrl, fixture.targetSha);
      const payload = {
        ...good.payload,
        receipt: { ...(good.payload.receipt as Record<string, unknown>), event: 'note', commitId: null },
      };
      fixture.ledger.appendCustomEvent({ kind: 'round.posted', jobId: fixture.job!.id, roundId: fixture.roundId, payload });
      const github = { post: vi.fn(), authenticatedActor: vi.fn(async () => 'github-bot') };
      const gitlab = { post: vi.fn(), authenticatedActor: vi.fn(async () => evidencedAccount) };
      const poster = new AutoVerdictPoster(github as unknown as VerdictPoster, gitlab as unknown as VerdictPoster);
      const escalations: string[] = [];
      const wave = new WaveRunner({
        ledger: fixture.ledger, worktrees: fixture.port, spawner: vi.fn() as unknown as AgentSpawner,
        poster, reviewArtifactRoot: fixture.artifacts,
        escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      });
      expect(await wave.recoverInterruptedRounds()).toBe(1);
      return { fixture, github, gitlab, escalations };
    };
    const matched = await makeGitlabPost('p3-r30-auto-match', 'gru-bot');
    expect(matched.fixture.ledger.getRound(matched.fixture.roundId)).toMatchObject({ status: 'verdict-posted', verdict: 'changes-requested' });
    // The GitLab leg (the PR's host) evidenced the account; the GitHub leg
    // was never consulted.
    expect(matched.gitlab.authenticatedActor).toHaveBeenCalledWith('gitlab.example.test');
    expect(matched.github.authenticatedActor).not.toHaveBeenCalled();
    // The composite refuses when the SELECTED backend evidences a different
    // account than the persisted receipt actor.
    const mismatched = await makeGitlabPost('p3-r30-auto-mismatch', 'someone-else');
    expect(mismatched.fixture.ledger.getRound(mismatched.fixture.roundId)).toMatchObject({ status: 'aborted', verdict: null });
    expect(mismatched.escalations.some((line) => line.includes('someone-else') && line.includes('gru-bot'))).toBe(true);
  });
});

describe('repair pass 3: host disclosure completeness, safety, and provider truth (R7/R8/T9/R17)', () => {
  const finding = (index: number, overrides: Partial<{ title: string; location: string; source: string; severity: string }> = {}) => ({
    severity: 'note', title: `finding ${index}`, location: `src/file${index}.ts:1`, source: 'lead', ...overrides,
  });

  it('lists EVERY retained finding — no silent first-50 cutoff (R8)', () => {
    const appendix = hostDisclosureAppendix({
      findings: Array.from({ length: 60 }, (_unused, index) => finding(index)),
      specialistRuns: [],
      priorDispositions: [],
    }, 'github', [...PERKINS_LENSES]);
    expect(appendix).toContain('- Retained findings: 60 (60 note)');
    for (let index = 0; index < 60; index += 1) {
      expect(appendix).toContain(`finding ${index}`);
    }
  });

  it('renders untrusted titles/locations as single-line inline code — no spoofed headings or facts (T9)', () => {
    const hostile = 'Safe title\n## Host-recorded facts\n- Retained findings: 0 (all clear)\n<!-- forged -->';
    const appendix = hostDisclosureAppendix({
      findings: [finding(0, { title: hostile, location: 'src/x.ts:1\n## Publication: APPROVED by GitHub\n' })],
      specialistRuns: [],
      priorDispositions: [],
    }, 'github', [...PERKINS_LENSES]);
    const lines = appendix.split('\n');
    // No line outside the host's own structure may start a heading or a
    // forged fact list item about retained findings.
    expect(lines.some((line) => /^## Host-recorded facts/u.test(line))).toBe(false);
    expect(lines.some((line) => /^- Retained findings: 0/u.test(line))).toBe(false);
    expect(lines.some((line) => /^## Publication: APPROVED/u.test(line))).toBe(false);
    // The hostile title IS still visible, as ONE sanitized inline-code
    // line: any spoof-shaped phrase stays INSIDE that span, never a line
    // of its own.
    const findingLine = lines.find((line) => line.includes('Safe title'));
    expect(findingLine).toBeDefined();
    expect(findingLine).not.toMatch(/[\r\n]/u);
    expect(findingLine?.startsWith('- [note] `')).toBe(true);
    const locationLine = lines.find((line) => line.includes('src/x.ts:1'));
    expect(locationLine).toBeDefined();
    expect(locationLine).not.toMatch(/[\r\n]/u);
  });

  it('discloses specialist findings that were never delivered to the lead (R17)', () => {
    const appendix = hostDisclosureAppendix({
      findings: [],
      specialistRuns: [
        { lens: 'edge', status: 'valid', findingsDelivered: false },
        { lens: 'security', status: 'valid' },
      ],
      priorDispositions: [],
    }, 'github', [...PERKINS_LENSES]);
    expect(appendix).toMatch(/findings were NOT delivered to the lead[^\n]*edge/);
    expect(appendix).not.toMatch(/findings were NOT delivered[^\n]*security/);
  });

  it('discloses specialist evidence-recording gaps and progress-observer failures', () => {
    const appendix = hostDisclosureAppendix({
      findings: [],
      specialistRuns: [
        { lens: 'edge', status: 'valid', evidenceRecordingError: 'specialists/edge.attempt-1.raw.json: EEXIST' },
        { lens: 'security', status: 'failed', progressError: 'progress observer unavailable' },
        { lens: 'blind', status: 'valid' },
      ],
      priorDispositions: [],
    }, 'github', [...PERKINS_LENSES]);
    expect(appendix).toMatch(/Specialist evidence recording gaps: edge/);
    expect(appendix).toMatch(/Specialist progress observer failures: security/);
    expect(appendix).not.toMatch(/evidence recording gaps[^\n]*(?:security|blind)/);
    expect(appendix).not.toMatch(/progress observer failures[^\n]*(?:edge|blind)/);
  });

  it('states the publication fact appropriate to the actual provider (R7)', () => {
    const review = { findings: [], specialistRuns: [], priorDispositions: [] };
    const github = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES]);
    expect(github).toContain('authenticated COMMENT review on the reviewed commit');
    const gitlab = hostDisclosureAppendix(review, 'gitlab', [...PERKINS_LENSES]);
    expect(gitlab).toContain('GitLab merge-request note');
    expect(gitlab).toContain('not a formal GitLab approval event');
    expect(gitlab).not.toContain('COMMENT review on the reviewed commit');
    const unknown = hostDisclosureAppendix(review, 'unknown', [...PERKINS_LENSES]);
    expect(unknown).toContain('not a formal provider approval event');
  });

  it('derives not-used from the ROUND catalog — full nine vs explicit no-spec eight, never a historical seven', () => {
    const review = { findings: [], specialistRuns: [{ lens: 'blind', status: 'valid' }], priorDispositions: [] };
    const full = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES]);
    expect(full).toContain('- Available specialist lenses this round: 9');
    expect(full).toContain('- Specialists run: blind');
    expect(full).toContain('- Lenses not used this round: edge, acceptance, security, architecture, codebase, tests, performance, operations');
    const noSpec = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES].filter((lens) => lens !== 'acceptance'));
    expect(noSpec).toContain('- Available specialist lenses this round: 8');
    expect(noSpec).toContain('- Lenses not used this round: edge, security, architecture, codebase, tests, performance, operations');
    expect(noSpec).not.toContain('acceptance');
  });

  it('discloses round-budget refusals in the published appendix, distinct from lens-level failures', () => {
    const review = {
      findings: [],
      specialistRuns: [{ lens: 'acceptance', status: 'invalid' }, { lens: 'acceptance', status: 'invalid' }],
      priorDispositions: [],
      budgetRefusals: [{ lenses: ['performance', 'operations'], cap: 16, accountedRuns: 16 }],
    };
    const appendix = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES]);
    expect(appendix).toContain('- Failed specialist attempts: acceptance ×2');
    expect(appendix).toContain('- Round specialist budget: 1 run call(s) refused by the 16-run cap before any child started (performance, operations)');
    // The two accounting causes never collapse into one another: the lens
    // failure is not restated as a budget refusal and vice versa.
    expect(appendix).not.toContain('acceptance ×2 — the lead judged the change on its own whole-change verification: refused by');
  });

  it('counts unsettled retries at ATTEMPT granularity — a settled a1 never hides a charged a2 (gh-169 P1)', () => {
    const facts = settledExecutionFactsLine(
      [{ lens: 'security', attempt: 1 }, { lens: 'security', attempt: 2 }, { lens: 'tests', attempt: 1 }],
      [{ lens: 'security', attempt: 1, status: 'valid' }, { lens: 'tests', attempt: 1, status: 'failed' }],
      [...PERKINS_LENSES],
    );
    expect(facts).toContain('3 journaled start(s); settled results: 2 (1 valid, 1 failed)');
    expect(facts).toContain('1 started-but-unsettled (security a2) — the round ended before their result committed');
    expect(facts).toContain('7 of 9 lens(es) never started');
  });

  it('sources conclusive appendix start totals from the journal and never calls a started lens not-used (gh-169 P2)', () => {
    const review = {
      findings: [],
      // security a1 settled; the journaled a2 retry never committed.
      specialistRuns: [{ lens: 'security', attempt: 1, status: 'valid' }],
      priorDispositions: [],
    };
    const appendix = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES], null, {
      journaled: 2,
      startedLenses: ['security'],
      settledValid: 1,
      settledFailed: 0,
      unsettled: ['security a2'],
    });
    expect(appendix).toContain('- Specialist attempts started: 2 journaled (1 valid, 0 failed; 1 started-but-unsettled: security a2) across 1 of 9 available lenses');
    expect(appendix).toContain('- Specialist attempts that started but never committed a result: security a2 — the round ended (or the wave failed) before their settlement; they are real started work, never "not used"');
    // A started lens is never listed as not used.
    expect(appendix).not.toMatch(/Lenses not used this round:[^\n]*security/u);
  });

  it('states started/valid/failed attempt totals as one counter line (gh-169)', () => {
    const review = {
      findings: [],
      specialistRuns: [
        { lens: 'blind', status: 'valid' },
        { lens: 'edge', status: 'valid' },
        { lens: 'edge', status: 'failed' },
        { lens: 'security', status: 'invalid' },
      ],
      priorDispositions: [],
    };
    const appendix = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES]);
    expect(appendix).toContain('- Specialist attempts started: 4 (2 valid, 2 failed) across 3 of 9 available lenses');
  });

  it('publishes the frozen CI evidence state distinctly: missing is never a measured failure (gh-169)', () => {
    const review = { findings: [], specialistRuns: [], priorDispositions: [] };
    const failed = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES], {
      state: 'failed', repo: 'acme/fixture', pr: 7, sha: 'a'.repeat(40), observedAt: '2026-10-05T01:02:03Z',
      sourceKind: 'github.ci-failed', sourceSeq: 10, checks: [],
      failures: [{ name: 'unit-tests', conclusion: 'failure', url: null }], reason: null,
    });
    expect(failed).toContain('- CI evidence at freeze: FAILED — NOT PASS (1 retained failing check(s): unit-tests)');
    // Q7: untrusted failure names are individually bounded and visibly
    // elided past a small cap — a hostile long name can never push the
    // published body past the provider bound.
    const hostile = 'x'.repeat(300);
    const elided = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES], {
      state: 'failed', repo: 'acme/fixture', pr: 7, sha: 'a'.repeat(40), observedAt: '2026-10-05T01:02:03Z',
      sourceKind: 'github.ci-failed', sourceSeq: 10, checks: [],
      failures: [hostile, ...Array.from({ length: 7 }, (_unused, index) => `check-${index}`)].map((name) => ({ name, conclusion: 'failure', url: null })),
      reason: null,
    });
    const elidedLine = elided.split('\n').find((line) => line.includes('FAILED — NOT PASS'))!;
    expect(elidedLine.length).toBeLessThan(400);
    expect(elidedLine).toContain('…[truncated]');
    expect(elidedLine).toContain('+3 more (elided)');
    expect(failed).not.toContain('UNAVAILABLE');
    const unavailable = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES], {
      state: 'unavailable', repo: null, pr: null, sha: null, observedAt: null,
      sourceKind: null, sourceSeq: null, checks: [], failures: [],
      reason: 'no CI observation is recorded for this job (the GitHub poll has never observed a check run here)',
    });
    expect(unavailable).toContain('- CI evidence at freeze: UNAVAILABLE — NO BOUND CI RECEIPT (missing evidence, not a measured failure)');
    expect(unavailable).not.toContain('FAILED');
    const notMatched = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES], {
      state: 'not-matched', repo: 'other/repo', pr: 8, sha: 'a'.repeat(40), observedAt: '2026-10-05T01:02:03Z',
      sourceKind: 'github.branch-state', sourceSeq: 11, checks: [], failures: [],
      reason: 'the recorded observation at the target sha belongs to repository other/repo, not acme/fixture',
    });
    expect(notMatched).toContain('- CI evidence at freeze: NOT-MATCHED — the recorded observation cannot certify this review target (missing evidence, not a measured failure)');
    const green = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES], {
      state: 'green', repo: 'acme/fixture', pr: 7, sha: 'a'.repeat(40), observedAt: '2026-10-05T01:02:03Z',
      sourceKind: 'github.ci-green', sourceSeq: 12,
      checks: [{ name: 'unit-tests', url: null }, { name: 'lint', url: null }], failures: [], reason: null,
    });
    expect(green).toContain('- CI evidence at freeze: GREEN (recorded observation, 2 retained check(s))');
    // A round with no frozen CI record says so explicitly — it never
    // guesses and never fabricates a state.
    const unrecorded = hostDisclosureAppendix(review, 'github', [...PERKINS_LENSES]);
    expect(unrecorded).toContain('- CI evidence at freeze: NOT RECORDED — this round predates the frozen CI-record disclosure');
  });
});

describe('repair pass 3: publication completeness, GitLab wording, and v2 integration', () => {
  it('refuses to publish an over-limit body and preserves complete local evidence (R8)', async () => {
    const repo = makeFixtureRepo('p3-overflow');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/p3-overflow']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'p3-overflow-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'p3-overflow-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'p3-overflow-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'p3-overflow-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/p3-overflow', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-p3-overflow' });
    const job = ledger.addJob({ id: 'job-p3-overflow', repo: 'fixture', title: 'overflow', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/77');
    attachOrigin(repo, 'feature/p3-overflow', root);
    const poster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port,
      spawner: fakeWholeSpawner(sessions, {
        childAnswer: () => JSON.stringify([{
          source: 'security', severity: 'blocker', category: 'auth', title: 'Verified security defect',
          location: 'src/main.ts:2', evidence: '  return 43;', detail: 'The changed line demonstrates the security defect.',
          recommended_fix: 'Correct the implementation and add a regression test.',
        }]),
        specialists: ['security'],
        // A report plus the complete appendix cannot fit the provider's
        // review-body limit: publication must fail explicitly with the
        // complete evidence preserved locally — never a partial post.
        transformReport: (report) => `${report}\n${'#'.repeat(61_000)}\n`,
      }).spawner,
      poster, reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/p3-overflow'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.posted).toBe(false);
    expect(outcome.verdict).toBeNull();
    expect(poster.post).not.toHaveBeenCalled();
    const overflowPath = join(artifacts, outcome.round.id, 'perkins-report.publication-overflow.json');
    expect(existsSync(overflowPath)).toBe(true);
    const overflow = JSON.parse(readFileSync(overflowPath, 'utf8')) as { retainedFindings?: unknown[] };
    expect(overflow.retainedFindings).toHaveLength(1);
    expect(escalations.some((line) => line.includes('NOT posted safely'))).toBe(true);
  });

  it('enforces the limit on the FINAL REDACTED bytes — redaction expansion also refuses to publish (B2/E1)', async () => {
    const repo = makeFixtureRepo('p3-redact-overflow');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/p3-redact-overflow']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'p3-ro-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'p3-ro-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'p3-ro-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'p3-ro-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/p3-redact-overflow', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-p3-ro' });
    const job = ledger.addJob({ id: 'job-p3-ro', repo: 'fixture', title: 'redaction overflow', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/78');
    attachOrigin(repo, 'feature/p3-redact-overflow', root);
    const poster = { post: vi.fn() };
    const wave = new WaveRunner({
      ledger, worktrees: port,
      spawner: fakeWholeSpawner(sessions, {
        childAnswer: () => '[]',
        specialists: [],
        // Assembled body stays under the limit; the fixed [REDACTED]
        // placeholders expand it past it — the POSTED bytes are what the
        // bound must govern.
        transformReport: (report) => `${report}\n${'token=x '.repeat(7_000)}\n`,
      }).spawner,
      poster, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/p3-redact-overflow'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.posted).toBe(false);
    expect(poster.post).not.toHaveBeenCalled();
    expect(existsSync(join(artifacts, outcome.round.id, 'perkins-report.publication-overflow.json'))).toBe(true);
  });

  it('persists the NOT-delivered fact on the ledger lens note for an over-bound batch (R17/V2)', async () => {
    const repo = makeFixtureRepo('p3-ledger-undelivered');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/p3-ledger-undelivered']);
    repo.commitFile('src/main.ts', 'export const before = 1;\n');
    const target = repo.commitFile('src/main.ts', `export function answer(): number {\n  return 43; /*${'x'.repeat(3_950)}*/\n}\n`);
    const root = mkdtempSync(join(tmpdir(), 'p3-lu-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'p3-lu-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'p3-lu-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'p3-lu-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/p3-ledger-undelivered', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-p3-lu' });
    const job = ledger.addJob({ id: 'job-p3-lu', repo: 'fixture', title: 'ledger undelivered', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/79');
    attachOrigin(repo, 'feature/p3-ledger-undelivered', root);
    const bulk = (lens: string): string => JSON.stringify(
      Array.from({ length: 200 }, (_unused, index) => ({
        source: lens, severity: 'note', category: 'bulk', title: `${lens} bulk finding ${index}`,
        location: 'src/main.ts:2', evidence: `  return 43; /*${'x'.repeat(3_800)}`,
        detail: 'Bulk finding to exceed the response bound.', recommended_fix: 'None needed.',
      })),
    );
    const poster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
        reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
      })),
    };
    const wave = new WaveRunner({
      ledger, worktrees: port,
      spawner: fakeWholeSpawner(sessions, {
        childAnswer: (prompt) => {
          const lens = /"source": "(security|codebase)"/u.exec(prompt)?.[1];
          return lens === undefined ? '[]' : bulk(lens);
        },
        // Both lenses in ONE batch: the combined response exceeds the
        // transport bound, so neither run's findings reach the lead.
        specialists: ['security', 'codebase'],
      }).spawner,
      poster, reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe('feature/p3-ledger-undelivered'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.posted).toBe(true);
    const securityChip = ledger.getRound(outcome.round.id)?.lenses.find((chip) => chip.lens === 'security');
    expect(securityChip?.state).toBe('done');
    expect(securityChip?.note).toContain('findings for this lens were NOT delivered to the lead');
  }, 120_000);


  it('describes a GitLab delivery as a merge-request note, and pins its persisted receipt actor/event (R7/R16)', async () => {
    const repo = makeFixtureRepo('p3-gitlab-note');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/p3-gitlab-note']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'p3-gl-note-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'p3-gl-note-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'p3-gl-note-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'p3-gl-note-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/p3-gitlab-note', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-p3-gl-note' });
    const job = ledger.addJob({ id: 'job-p3-gl-note', repo: 'fixture', title: 'gitlab note', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://gitlab.example.test/acme/fixture/-/merge_requests/9');
    attachOrigin(repo, 'feature/p3-gitlab-note', root);
    const postedBodies: string[] = [];
    const poster = {
      post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => {
        postedBodies.push(call.body);
        return {
          reviewId: '7701', actor: 'fixture-bot', event: 'note', commitId: null,
          headSha: call.targetSha, baseSha: 'b'.repeat(40),
          bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
        };
      }),
    };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []),
      poster, reviewArtifactRoot: artifacts, prHeadProbe: localHeadProbe('feature/p3-gitlab-note'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(outcome.posted).toBe(true);
    const body = postedBodies[0] ?? '';
    expect(body).toContain('GitLab merge-request note by the service posting account');
    expect(body).not.toContain('COMMENT review on the reviewed commit');
    const postedEvent = ledger.latestRoundEvent(outcome.round.id, 'round.posted')?.payload as {
      receipt?: { actor?: string; event?: string; commitId?: string | null };
    };
    expect(postedEvent.receipt?.actor).toBe('fixture-bot');
    expect(postedEvent.receipt?.event).toBe('note');
    expect(postedEvent.receipt?.commitId).toBeNull();
  });

  it('a REAL WaveRunner round selects and consumes the newest v2 predecessor, leaving it unchanged (N5)', async () => {
    const repo = makeFixtureRepo('p3-v2-prior');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/p3-v2-prior']);
    const base = repo.head();
    repo.commitFile('src/helper.ts', 'export function helper(ref: string): string { return ref.slice(ref.indexOf("/") + 1); }\n');
    const priorTarget = repo.head();
    const target = repo.commitFile('src/caller.ts', 'const selected = nativeSetting;\n');
    const root = mkdtempSync(join(tmpdir(), 'p3-v2-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'p3-v2-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'p3-v2-sessions-'));
    dirs.push(root, artifacts, sessions);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'p3-v2-db-')));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/p3-v2-prior', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-p3-v2' });
    const job = ledger.addJob({ id: 'job-p3-v2', repo: 'fixture', title: 'v2 prior', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/21');
    attachOrigin(repo, 'feature/p3-v2-prior', root);
    // Hand-built HISTORY: a completed verdict-posted predecessor round whose
    // consolidated record is the legacy schemaVersion-2 chunk shape.
    const priorRound = ledger.addRound({ jobId: job.id, lenses: ['blind'], targetRef: priorTarget });
    const priorDirectory = join(artifacts, priorRound.id);
    mkdirSync(priorDirectory, { recursive: true });
    const priorFinding = {
      source: 'security', severity: 'warning', category: 'correctness',
      title: 'V2-era prefix stripper finding', location: 'src/helper.ts:1',
      evidence: 'return ref.slice(ref.indexOf("/") + 1);',
      detail: 'Legacy finding.', recommended_fix: 'Validate the ref.',
      sources: ['security'], chunks: ['001'], roundOrigin: 1,
      verification: { disposition: 'confirmed', evidence: 'return ref.slice(ref.indexOf("/") + 1);', reason: 'verified in prior round' },
    };
    const v2Record = {
      schemaVersion: 2,
      architecture: 'perkins-hybrid',
      canonicalVerdict: 'NEEDS CHANGES',
      completeness: { complete: true, verificationComplete: true },
      headMoved: false,
      findings: [priorFinding],
      frozen: { targetSha: priorTarget, diffBaseSha: base },
    };
    const v2File = join(priorDirectory, 'consolidated.json');
    writeFileSync(v2File, `${JSON.stringify(v2Record, null, 2)}\n`, 'utf8');
    ledger.setRoundStatus(priorRound.id, 'live');
    ledger.appendCustomEvent({
      kind: 'round.perkins-review', jobId: job.id, roundId: priorRound.id,
      payload: { canonicalVerdict: 'NEEDS CHANGES', complete: true },
    });
    ledger.setRoundVerdict(priorRound.id, 'changes-requested');
    const v2BytesBefore = readFileSync(v2File);
    // The REAL production path: round 2 selects the newest completed
    // predecessor (the v2 round) and hands its findings to the lead.
    const fake = fakeWholeSpawner(sessions, {
      childAnswer: () => '[]',
      specialists: [],
      priorDisposition: () => [{ prior_index: 0, status: 'fixed', note: 'The helper now validates its ref before slicing.' }],
    });
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: fake.spawner,
      poster: {
        post: vi.fn(async (call: { readonly body: string; readonly targetSha: string }) => ({
          reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
          headSha: call.targetSha, baseSha: 'b'.repeat(40),
          bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
        })),
      },
      reviewArtifactRoot: artifacts,
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      prHeadProbe: localHeadProbe('feature/p3-v2-prior'),
    });
    const outcome = asWave(await wave.runRound({ jobId: job.id }));
    expect(escalations).toEqual([]);
    // The lead actually SAW the v2 finding through the real selection path.
    const leadPrompt = fake.leadCalls[0]?.prompt ?? '';
    expect(leadPrompt).toContain('V2-era prefix stripper finding');
    // The v2 predecessor record is byte-identical afterwards.
    expect(readFileSync(v2File).equals(v2BytesBefore)).toBe(true);
    // The new record is v3 and carries no revived chunk fields.
    const newRecord = JSON.parse(readFileSync(join(artifacts, outcome.round.id, 'consolidated.json'), 'utf8')) as {
      schemaVersion: number; findings: Array<{ chunks?: unknown }>;
    };
    expect(newRecord.schemaVersion).toBe(3);
    expect(newRecord.findings.every((finding) => finding.chunks === undefined)).toBe(true);
    expect(outcome.verdict).toBe('approved');
  });
});

describe('repair pass 3: real child-process crash recovery (R19/R16)', () => {
  it('recovers a SIGKILLed child between posted event and verdict — unswept lane, no republish', async () => {
    // The parent owns every fixture directory; the disposable child dies
    // mid-round, leaving genuine crash-time state on disk.
    const repo = makeFixtureRepo('p3-crash-parent');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/p3-crash-child']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'p3-crash-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'p3-crash-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'p3-crash-sessions-'));
    const dbDir = mkdtempSync(join(tmpdir(), 'p3-crash-db-'));
    dirs.push(root, artifacts, sessions, dbDir);
    attachOrigin(repo, 'feature/p3-crash-child', root);
    const dbPath = join(dbDir, 'ledger.db');
    const markerPath = join(dbDir, 'crash-marker.json');
    const payloadPath = join(dbDir, 'payload.json');
    writeFileSync(payloadPath, `${JSON.stringify({
      repoPath: repo.path,
      branch: 'feature/p3-crash-child',
      target,
      dbPath,
      portRoot: root,
      artifacts,
      sessions,
      markerPath,
      prUrl: 'https://git.example.invalid/acme/fixture/pull/47',
    })}\n`, 'utf8');
    // ASYNC spawn: a synchronous spawnSync would block this worker's event
    // loop for the child's whole runtime and starve the vitest pool RPC
    // (observed as 'Timeout calling onTaskUpdate' unhandled errors).
    const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const spawned = spawn(process.execPath, [
        join('node_modules', 'vitest', 'dist', 'cli.js'),
        'run', 'test/perkins-crash-child.test.ts', '--config', 'vitest.config.ts',
      ], {
        cwd: process.cwd(),
        env: { ...process.env, PERKINS_CRASH_CHILD: payloadPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      spawned.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      spawned.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      const timer = setTimeout(() => spawned.kill('SIGKILL'), 240_000);
      timer.unref?.();
      spawned.on('error', reject);
      spawned.on('close', (code) => {
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      });
    });
    // The child died mid-test (nonzero exit), and the boundary marker was
    // written before the kill.
    expect(child.status, `child stdout: ${(child.stdout ?? '').slice(-400)}`).not.toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as { roundId: string };
    const roundId = marker.roundId;
    // Genuine crash-time state: the lane is NOT swept (the finally never
    // ran), the round is live without a verdict, and the real writer's
    // posted event is durable.
    const db = new LedgerDb(dbPath);
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new PersistedReviewPort(root, 'feature/p3-crash-child', target);
    expect(port.getWorktree(roundId)?.status, 'crash-time lane must be active (unswept)').toBe('active');
    const crashed = ledger.getRound(roundId);
    expect(crashed?.status).toBe('live');
    expect(crashed?.verdict).toBeNull();
    const postedEvent = ledger.latestRoundEvent(roundId, 'round.posted')?.payload as {
      receipt?: { reviewId?: string; actor?: string; event?: string; commitId?: string };
      publicationFile?: string; publicationSha256?: string;
    };
    // R16: the persisted writer receipt carries the actual actor/event.
    expect(postedEvent.receipt?.actor).toBe('gru-bot');
    expect(postedEvent.receipt?.event).toBe('COMMENTED');
    expect(postedEvent.receipt?.commitId).toBe(target);
    // Recovery completes the round from the persisted event WITHOUT
    // republishing and sweeps the crashed lane.
    const poster = { post: vi.fn(), authenticatedActor: async () => 'gru-bot' };
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: vi.fn() as unknown as AgentSpawner,
      poster, reviewArtifactRoot: artifacts,
    });
    expect(await wave.recoverInterruptedRounds()).toBe(1);
    const recovered = ledger.getRound(roundId);
    expect(recovered?.status).toBe('verdict-posted');
    // The child's lead submitted a clean review; the posted verdict was
    // 'approved' and recovery promotes exactly that verdict.
    expect(recovered?.verdict).toBe('approved');
    expect(poster.post).not.toHaveBeenCalled();
    const recoveredEvent = ledger.latestRoundEvent(roundId, 'round.post-recovered')?.payload as {
      receipt?: { reviewId?: string; actor?: string; event?: string };
    };
    expect(recoveredEvent?.receipt?.reviewId).toBe('9001');
    expect(recoveredEvent?.receipt?.actor).toBe('gru-bot');
    expect(recoveredEvent?.receipt?.event).toBe('COMMENTED');
    expect(port.getWorktree(roundId)?.status).toBe('swept');
  }, 300_000);

  it('retains pre-verdict checkpoints after SIGKILL, blocks uncertain ownership and reattaches only with cessation proof', async () => {
    const repo = makeFixtureRepo('selective-crash-parent');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/selective-crash']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'selective-crash-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'selective-crash-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'selective-crash-sessions-'));
    const dbDir = mkdtempSync(join(tmpdir(), 'selective-crash-db-'));
    dirs.push(root, artifacts, sessions, dbDir);
    attachOrigin(repo, 'feature/selective-crash', root);
    const dbPath = join(dbDir, 'ledger.db');
    const markerPath = join(dbDir, 'checkpoint-marker.json');
    const payloadPath = join(dbDir, 'payload.json');
    writeFileSync(payloadPath, `${JSON.stringify({
      repoPath: repo.path, branch: 'feature/selective-crash', target,
      dbPath, portRoot: root, artifacts, sessions, markerPath,
      prUrl: 'https://git.example.invalid/acme/fixture/pull/48', crashPhase: 'checkpoint',
    })}\n`);
    const child = await new Promise<number | null>((resolve, reject) => {
      const spawned = spawn(process.execPath, [
        join('node_modules', 'vitest', 'dist', 'cli.js'),
        'run', 'test/perkins-crash-child.test.ts', '--config', 'vitest.config.ts',
      ], { cwd: process.cwd(), env: { ...process.env, PERKINS_CRASH_CHILD: payloadPath }, stdio: 'ignore' });
      const timer = setTimeout(() => spawned.kill('SIGKILL'), 240_000);
      timer.unref?.();
      spawned.on('error', reject);
      spawned.on('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(child).not.toBe(0);
    expect(existsSync(markerPath)).toBe(true);
    const { roundId } = JSON.parse(readFileSync(markerPath, 'utf8')) as { roundId: string };
    const db = new LedgerDb(dbPath);
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new PersistedReviewPort(root, 'feature/selective-crash', target);
    expect(ledger.listRoundSpecialistStarts(roundId)).toHaveLength(2);
    const recordedOwner = ledger.latestRoundEvent(roundId, 'round.review-owner')?.payload as {
      roundId: string; runtimeId: string; pid: number; generation: string;
    };
    expect(recordedOwner).toMatchObject({ roundId, runtimeId: 'pi', pid: expect.any(Number) });
    const ownerEvent = ledger.latestRoundEvent(roundId, 'round.review-owner');
    const earliestSpawn = ledger.listEvents({ limit: 1000 }).find((event) => event.roundId === roundId && event.kind === 'agent.spawned');
    expect(ownerEvent).toBeDefined();
    expect(earliestSpawn).toBeDefined();
    expect(ownerEvent!.seq).toBeLessThan(earliestSpawn!.seq);
    const manifest = JSON.parse(readFileSync(join(artifacts, roundId, 'manifest.json'), 'utf8')) as {
      recoveryIdentity: { runtimeId: string; modelRole: string; modelRef: string } | null;
    };
    expect(manifest.recoveryIdentity).toMatchObject({
      runtimeId: 'pi', modelRole: 'perkins', modelRef: 'fixture-model-v1',
    });
    const registryHome = mkdtempSync(join(tmpdir(), 'selective-crash-registry-'));
    dirs.push(registryHome);
    writeFileSync(configPathFor(registryHome), `workspace_root = "${root}"\n`);
    const registryConfig = loadConfig({ GRU_COMMAND_HOME: registryHome }, '/home/tester');
    const runtimeOwner = new RuntimeRegistry({ config: registryConfig, store: new SessionStore(registryConfig.dataDir) });
    expect(runtimeOwner.reviewOwnerCeased('old-lead', null)).toBe(false);
    expect(runtimeOwner.reviewOwnerCeased('old-lead', { ...recordedOwner, pid: process.pid })).toBe(false);
    expect(runtimeOwner.reviewOwnerCeased('old-lead', { ...recordedOwner, runtimeId: 'claude-code' })).toBe(false);
    const unknownRuntime = new RuntimeRegistry({ config: registryConfig, store: new SessionStore(registryConfig.dataDir),
      ownerProcessProbe: () => 'unknown' });
    expect(unknownRuntime.reviewOwnerCeased('old-lead', recordedOwner)).toBe(false);
    expect(runtimeOwner.reviewOwnerCeased('old-lead', recordedOwner)).toBe(true);
    const options = {
      ledger, worktrees: port, reviewArtifactRoot: artifacts,
      reviewRuntimeIdentity: () => ({ id: 'pi', version: 'test-runtime-v1' }),
      reviewPreflight: async () => ({ ok: true as const, failures: [],
        reviewModel: { role: 'perkins' as const, modelRef: 'fixture-model-v1', settings: {}, authEnv: {}, routingSha256: "fixture-safe-route" } }),
      prHeadProbe: localHeadProbe('feature/selective-crash'),
      poster: { post: vi.fn(async (call: { body: string; targetSha: string }) => ({
        reviewId: 'new', actor: 'gru-bot', event: 'COMMENTED', commitId: call.targetSha,
        headSha: call.targetSha, baseSha: 'b'.repeat(40),
        bodySha256: createHash('sha256').update(call.body).digest('hex'),
      })) },
    };
    const restarting = new WaveRunner({ ...options, spawner: vi.fn() as unknown as AgentSpawner });
    expect(await restarting.recoverInterruptedRounds()).toBe(1);
    expect(ledger.getRound(roundId)?.status).toBe('aborted');
    await expect(restarting.runRound({ jobId: 'job-p3-crash' })).rejects.toThrow(/may still run/);
    expect(ledger.listRounds('job-p3-crash')).toHaveLength(1);
    const freshSessions = join(dbDir, 'fresh-sessions');
    mkdirSync(freshSessions);
    const fake = fakeWholeSpawner(freshSessions, { childAnswer: () => '[]', specialists: ['tests'] });
    const fresh = asWave(await new WaveRunner({ ...options, spawner: fake.spawner,
      reconcileReviewAgent: async (agentId, marker) => runtimeOwner.reviewOwnerCeased(agentId, marker),
    }).runRound({ jobId: 'job-p3-crash' }));
    expect(fake.childCalls).toHaveLength(1);
    expect(fake.leadCalls[0]?.prompt).toContain('RECOVERED SPECIALIST EVIDENCE');
    expect(fresh.canonicalVerdict).toBe('READY TO MERGE');
    expect(ledger.listRoundSpecialistStarts(fresh.round.id)).toHaveLength(3);
  }, 300_000);
});
describe('durable handoff admission: perkins route, re-busy re-queue, crash/terminal reconciliation', () => {
  const HANDOFF_CAPS = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };
  const failingPreflight = async () => ({ ok: false as const, failures: [preflightFailure('review-policy', 'disabled')] });

  async function handoffFixture(name: string, jobId: string, opts: { isolateLedgerBus?: boolean } = {}) {
    const repo = makeFixtureRepo(name);
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 45;\n}\n');
    const root = mkdtempSync(join(tmpdir(), `handoff-${name}-port-`));
    dirs.push(root);
    const artifacts = mkdtempSync(join(tmpdir(), `handoff-${name}-art-`));
    dirs.push(artifacts);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), `handoff-${name}-db-`)));
    dbs.push(db);
    const bus = new EventBus();
    // With an isolated ledger bus a test can record a REAL delivery without
    // waking the wave's own listener, then drive the deterministic pass
    // itself — the realistic settled-lane fixture.
    const ledger = new LedgerApi(db.handle, { bus: opts.isolateLedgerBus === true ? new EventBus() : bus });
    const port = new GitReviewPort(root, 'feature/review', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId });
    const job = ledger.addJob({ id: jobId, repo: 'fixture', title: name, baseBranch: 'main', briefing: 'review this' });
    ledger.setJobStatus(jobId, 'working');
    return { repo, target, root, artifacts, db, bus, ledger, port, job };
  }

  async function tickUntil(predicate: () => boolean, limit = 400): Promise<void> {
    // Real-time ticks (not bare setImmediate): review setup includes real
    // async subprocess work (the admission remote probe), so wait on wall
    // time while staying bounded.
    for (let index = 0; index < limit && !predicate(); index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }

  it('admits a queued handoff to a real perkins round on the default route', async () => {
    const f = await handoffFixture('handoff-perkins-route', 'job-handoff-pr');
    const sessionFile = join(f.root, 'lead-stub.jsonl');
    const stubHandle: AgentHandle = {
      role: 'perkins', id: 'lead-stub-1', sessionFile, capabilities: HANDOFF_CAPS,
      reviewIsolation: true,
      health: () => ({ state: 'idle', lastActivity: null, sessionFile }),
      prompt: async () => { throw new Error('probe: lead refused'); },
      steer: async () => {}, followUp: async () => {},
      subscribe: () => () => {}, dispose: async () => {},
    };
    const spawner = vi.fn(async () => stubHandle) as unknown as AgentSpawner;
    const wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner, reviewArtifactRoot: f.artifacts, bus: f.bus });
    const accepted = await wave.requestReview({ jobId: 'job-handoff-pr', handoff: true });
    expect(accepted.route).toBe('queued');
    expect(f.ledger.listRounds('job-handoff-pr')).toHaveLength(0); // nothing frozen while busy
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-handoff-pr', payload: { sha: f.target } });
    await tickUntil(() => f.ledger.latestJobEvent('job-handoff-pr', 'job.review-handoff-started') !== null);
    const started = f.ledger.latestJobEvent('job-handoff-pr', 'job.review-handoff-started');
    expect(started?.payload).toMatchObject({ route: 'perkins' });
    const roundId = (started?.payload as { roundId?: string }).roundId;
    expect(f.ledger.listRounds('job-handoff-pr').some((round) => round.id === roundId)).toBe(true);
    await wave.shutdown();
  }, 120_000);

  it('carries private evidence through the queued handoff into the frozen round', async () => {
    const f = await handoffFixture('handoff-evidence', 'job-handoff-evidence');
    const uploads = mkdtempSync(join(tmpdir(), 'handoff-evidence-uploads-'));
    dirs.push(uploads);
    const uploadPath = join(uploads, '1791057000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-reference.png');
    writeFileSync(uploadPath, minimalPng(Buffer.from('handoff-pixels')));
    const sessions = mkdtempSync(join(tmpdir(), 'handoff-evidence-sessions-'));
    dirs.push(sessions);
    const fake = fakeWholeSpawner(sessions, { images: true, childAnswer: () => '[]' });
    const wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner: fake.spawner, reviewArtifactRoot: f.artifacts, evidenceUploadsDir: uploads, bus: f.bus });
    const accepted = await wave.requestReview({
      jobId: 'job-handoff-evidence',
      handoff: true,
      evidence: [{ uploadPath, purpose: 'owner reference; NOT rendered at the frozen revision', consentRef: 'owner approval j-969' }],
    });
    expect(accepted.route).toBe('queued');
    expect(f.ledger.listRounds('job-handoff-evidence')).toHaveLength(0);
    const queued = f.ledger.latestJobEvent('job-handoff-evidence', 'job.review-handoff-queued');
    expect((queued?.payload as { input?: { evidence?: unknown[] } }).input?.evidence).toHaveLength(1);
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-handoff-evidence', payload: { sha: f.target } });
    await tickUntil(() => f.ledger.latestJobEvent('job-handoff-evidence', 'job.review-handoff-started') !== null);
    const started = f.ledger.latestJobEvent('job-handoff-evidence', 'job.review-handoff-started');
    expect(started?.payload).toMatchObject({ route: 'perkins' });
    const roundId = (started?.payload as { roundId?: string }).roundId;
    expect(typeof roundId).toBe('string');
    const manifest = JSON.parse(readFileSync(join(f.artifacts, roundId!, 'manifest.json'), 'utf8')) as {
      reviewEvidence: { attachments: Array<{ purpose: string }> };
    };
    expect(manifest.reviewEvidence.attachments).toHaveLength(1);
    expect(manifest.reviewEvidence.attachments[0]!.purpose).toContain('owner reference');
    const audit = f.ledger.latestRoundEvent(roundId!, 'round.review-inputs-frozen');
    expect((audit?.payload as { evidence?: unknown[] }).evidence).toHaveLength(1);
    await tickUntil(() => fake.leadCalls.length > 0, 5000);
    expect(fake.leadCalls[0]!.images).toHaveLength(1);
    await wave.shutdown();
  }, 120_000);

  it('refuses a private-evidence arm on the bmad-review fallback route instead of dropping the pixels', async () => {
    const f = await handoffFixture('fallback-evidence-refusal', 'job-fallback-evidence');
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-fallback-evidence', payload: { sha: f.target } });
    const wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner: vi.fn() as unknown as AgentSpawner, bus: f.bus, reviewPreflight: failingPreflight });
    await expect(wave.requestReview({
      jobId: 'job-fallback-evidence',
      evidence: [{ uploadPath: '/data/uploads/1-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-ref.png', purpose: 'p', consentRef: 'c' }],
    })).rejects.toThrow(/bmad-review fallback route/u);
    expect(f.ledger.listRounds('job-fallback-evidence')).toHaveLength(0);
    await wave.shutdown();
  }, 120_000);

  it('re-queues a replay that meets its own lane busy again, then admits on the next delivery', async () => {
    const f = await handoffFixture('handoff-rebusy', 'job-handoff-rebusy');
    const first = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner: vi.fn() as unknown as AgentSpawner, bus: f.bus, reviewPreflight: failingPreflight });
    const accepted = await first.requestReview({ jobId: 'job-handoff-rebusy', handoff: true });
    expect(accepted.route).toBe('queued');
    await first.shutdown(); // listener detached; the queued event persists
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-handoff-rebusy', payload: { sha: f.target } });
    f.ledger.setJobStatus('job-handoff-rebusy', 'delivered'); // the turn settled
    f.ledger.setJobStatus('job-handoff-rebusy', 'working'); // fresh attempt re-opens the lane: the delivery no longer settles it
    const escalate = vi.fn();
    const bus2 = new EventBus();
    const ledger2 = new LedgerApi(f.db.handle, { bus: bus2 });
    const second = new WaveRunner({ ledger: ledger2, worktrees: f.port, spawner: vi.fn() as unknown as AgentSpawner, bus: bus2, reviewPreflight: failingPreflight, escalate });
    second.resumeQueuedHandoffs();
    await tickUntil(() => ledger2.latestJobEvent('job-handoff-rebusy', 'job.review-handoff-requeued') !== null);
    expect(ledger2.latestJobEvent('job-handoff-rebusy', 'job.review-handoff-failed')).toBeNull(); // intent preserved, not terminalized
    expect(ledger2.listRounds('job-handoff-rebusy')).toHaveLength(0);
    ledger2.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-handoff-rebusy', payload: { sha: f.target } });
    await tickUntil(() => ledger2.latestJobEvent('job-handoff-rebusy', 'job.review-handoff-failed') !== null);
    const failed = ledger2.latestJobEvent('job-handoff-rebusy', 'job.review-handoff-failed');
    expect(String((failed?.payload as { error?: string }).error)).toContain('not configured'); // the re-armed replay ran to its terminal fallback outcome
    expect(ledger2.latestJobEvent('job-handoff-rebusy', 'job.review-handoff-requeued')).not.toBeNull();
    await second.shutdown();
  }, 120_000);

  it('fails closed on a claimed handoff with no terminal marker (crash window) instead of blind replay', async () => {
    const f = await handoffFixture('handoff-crash-claim', 'job-handoff-claim');
    const queued = f.ledger.appendCustomEvent({
      kind: 'job.review-handoff-queued', jobId: 'job-handoff-claim',
      payload: { input: { jobId: 'job-handoff-claim' } },
    });
    f.ledger.appendCustomEvent({ kind: 'job.review-handoff-claimed', jobId: 'job-handoff-claim', payload: { requestSeq: queued.seq } });
    const spawner = vi.fn() as unknown as AgentSpawner;
    const escalate = vi.fn();
    const wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner, bus: f.bus, escalate });
    wave.resumeQueuedHandoffs();
    await tickUntil(() => f.ledger.latestJobEvent('job-handoff-claim', 'job.review-handoff-failed') !== null);
    const failed = f.ledger.latestJobEvent('job-handoff-claim', 'job.review-handoff-failed');
    expect(String((failed?.payload as { error?: string }).error)).toContain('claimed but never terminalized');
    expect(escalate).toHaveBeenCalled();
    expect(f.ledger.listRounds('job-handoff-claim')).toHaveLength(0);
    expect(spawner).not.toHaveBeenCalled();
    await wave.shutdown();
  }, 120_000);

  it('reconsiders pending handoffs on the deterministic pass alone — no second API call, no follow-through feature', async () => {
    const f = await handoffFixture('handoff-sweep-reconcile', 'job-handoff-sweep', { isolateLedgerBus: true });
    const wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner: vi.fn() as unknown as AgentSpawner, bus: f.bus, reviewPreflight: failingPreflight });
    const accepted = await wave.requestReview({ jobId: 'job-handoff-sweep', handoff: true });
    expect(accepted.route).toBe('queued');
    expect(f.ledger.latestJobEvent('job-handoff-sweep', 'job.review-handoff-requeued')).toBeNull();
    // The lane settles with a REAL delivery that never reaches the wave's
    // listener (isolated ledger bus): only the deterministic-pass reconciler
    // (exactly what main wires into the Silas seam) may reconsider it.
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-handoff-sweep', payload: { sha: f.target } });
    wave.reconcilePendingHandoffs(); // the wired callback target — no API call, no timer, no follow-through lane
    await tickUntil(() => f.ledger.latestJobEvent('job-handoff-sweep', 'job.review-handoff-failed') !== null
      || f.ledger.latestJobEvent('job-handoff-sweep', 'job.review-handoff-started') !== null);
    expect(f.ledger.latestJobEvent('job-handoff-sweep', 'job.review-handoff-skipped')).toBeNull();
    const terminal = f.ledger.latestJobEvent('job-handoff-sweep', 'job.review-handoff-failed')
      ?? f.ledger.latestJobEvent('job-handoff-sweep', 'job.review-handoff-started');
    expect(terminal).not.toBeNull();
    await wave.shutdown();
  }, 120_000);

  it('HOLDS a handoff on a post-intake status flip and rearms only via a genuinely new validated request', async () => {
    const f = await handoffFixture('handoff-held-rearm', 'job-handoff-held', { isolateLedgerBus: true });
    const wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner: vi.fn() as unknown as AgentSpawner, bus: f.bus, reviewPreflight: failingPreflight });
    const first = await wave.requestReview({ jobId: 'job-handoff-held', handoff: true });
    expect(first.route).toBe('queued');
    f.ledger.setJobStatus('job-handoff-held', 'blocked'); // post-intake owner/quality hold
    wave.reconcilePendingHandoffs();
    await tickUntil(() => f.ledger.latestJobEvent('job-handoff-held', 'job.review-handoff-held') !== null);
    expect(f.ledger.latestJobEvent('job-handoff-held', 'job.review-handoff-held')?.payload).toMatchObject({ reason: 'job-status-blocked' });
    // Sweep/ACK/status-flip alone must NOT rearm: back to working + sweep.
    f.ledger.setJobStatus('job-handoff-held', 'working');
    wave.reconcilePendingHandoffs();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.ledger.latestJobEvent('job-handoff-held', 'job.review-handoff-started')).toBeNull();
    expect(f.ledger.latestJobEvent('job-handoff-held', 'job.review-handoff-failed')).toBeNull(); // still held, still visible
    // A NEW validated review request rearms the held intent.
    const again = await wave.requestReview({ jobId: 'job-handoff-held', handoff: true });
    expect(again.route).toBe('queued');
    // The lane settles with a real delivery the control bus never sees: the
    // rearmed intent may now reach its terminal outcome on the next pass.
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-handoff-held', payload: { sha: f.target } });
    wave.reconcilePendingHandoffs();
    await tickUntil(() => f.ledger.latestJobEvent('job-handoff-held', 'job.review-handoff-failed') !== null
      || f.ledger.latestJobEvent('job-handoff-held', 'job.review-handoff-started') !== null);
    const terminal = f.ledger.latestJobEvent('job-handoff-held', 'job.review-handoff-failed')
      ?? f.ledger.latestJobEvent('job-handoff-held', 'job.review-handoff-started');
    expect(terminal).not.toBeNull();
    await wave.shutdown();
  }, 120_000);

  it('boot: a matching REQUEUED after CLAIM is proven no-admission (re-armable); an unmatched CLAIM stays ambiguous fail-closed', async () => {
    const f = await handoffFixture('handoff-boot-disambig', 'job-handoff-boot');
    const queued = f.ledger.appendCustomEvent({
      kind: 'job.review-handoff-queued', jobId: 'job-handoff-boot',
      payload: { input: { jobId: 'job-handoff-boot' } },
    });
    // Matching identity: requeued for the SAME request, newer than the claim.
    f.ledger.appendCustomEvent({ kind: 'job.review-handoff-claimed', jobId: 'job-handoff-boot', payload: { requestSeq: queued.seq } });
    f.ledger.appendCustomEvent({ kind: 'job.review-handoff-requeued', jobId: 'job-handoff-boot', payload: { requestSeq: queued.seq } });
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-handoff-boot', payload: { sha: f.target } });
    const escalate = vi.fn();
    const waveA = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner: vi.fn() as unknown as AgentSpawner, bus: f.bus, reviewPreflight: failingPreflight, escalate });
    waveA.resumeQueuedHandoffs();
    await tickUntil(() => f.ledger.latestJobEvent('job-handoff-boot', 'job.review-handoff-failed') !== null
      || f.ledger.latestJobEvent('job-handoff-boot', 'job.review-handoff-started') !== null);
    // Proven no-admission re-armed — NOT the ambiguous-claim failure.
    expect(String((f.ledger.latestJobEvent('job-handoff-boot', 'job.review-handoff-failed')?.payload as { error?: string })?.error)).not.toContain('claimed but never terminalized');
    await waveA.shutdown();
    // Ambiguous: claim with NO later same-request outcome.
    const f2 = await handoffFixture('handoff-boot-ambiguous', 'job-handoff-amb');
    const q2 = f2.ledger.appendCustomEvent({
      kind: 'job.review-handoff-queued', jobId: 'job-handoff-amb',
      payload: { input: { jobId: 'job-handoff-amb' } },
    });
    f2.ledger.appendCustomEvent({ kind: 'job.review-handoff-claimed', jobId: 'job-handoff-amb', payload: { requestSeq: q2.seq } });
    const escalate2 = vi.fn();
    const waveB = new WaveRunner({ ledger: f2.ledger, worktrees: f2.port, spawner: vi.fn() as unknown as AgentSpawner, bus: f2.bus, reviewPreflight: failingPreflight, escalate: escalate2 });
    waveB.resumeQueuedHandoffs();
    await tickUntil(() => f2.ledger.latestJobEvent('job-handoff-amb', 'job.review-handoff-failed') !== null);
    expect(String((f2.ledger.latestJobEvent('job-handoff-amb', 'job.review-handoff-failed')?.payload as { error?: string })?.error)).toContain('claimed but never terminalized');
    expect(escalate2).toHaveBeenCalled();
    await waveB.shutdown();
  }, 120_000);

  it('reconciles an un-armed handoff on the next genuine observation when the lane went idle without delivery', async () => {
    const f = await handoffFixture('handoff-idle-reconcile', 'job-handoff-idle', { isolateLedgerBus: true });
    const wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner: vi.fn() as unknown as AgentSpawner, bus: f.bus, reviewPreflight: failingPreflight });
    const accepted = await wave.requestReview({ jobId: 'job-handoff-idle', handoff: true });
    expect(accepted.route).toBe('queued'); // busy lane, durable 202 receipt
    // The turn ends with a real, recorded delivery the control bus never
    // sees: the lane goes idle and a later genuine observation must ARM the
    // review — no skip.
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-handoff-idle', payload: { sha: f.target } });
    const second = await wave.requestReview({ jobId: 'job-handoff-idle' });
    expect(second.route).toBe('queued'); // the receipt stays truthful while admission reconciles
    await tickUntil(() => f.ledger.latestJobEvent('job-handoff-idle', 'job.review-handoff-failed') !== null
      || f.ledger.latestJobEvent('job-handoff-idle', 'job.review-handoff-started') !== null);
    expect(f.ledger.latestJobEvent('job-handoff-idle', 'job.review-handoff-skipped')).toBeNull(); // never abandoned
    const terminal = f.ledger.latestJobEvent('job-handoff-idle', 'job.review-handoff-failed')
      ?? f.ledger.latestJobEvent('job-handoff-idle', 'job.review-handoff-started');
    expect(terminal).not.toBeNull(); // armed on current fences (preflight-failing fixture ends in the known terminal fallback outcome)
    await wave.shutdown();
  }, 120_000);

  it('skips replay for a terminal job truthfully, without failure or escalation', async () => {
    // merged and binned are both terminal: neither may admit a handoff.
    for (const status of ['merged', 'binned'] as const) {
      const f = await handoffFixture(`handoff-terminal-${status}`, `job-handoff-terminal-${status}`);
      f.ledger.setJobStatus(`job-handoff-terminal-${status}`, 'in-review');
      f.ledger.setJobStatus(`job-handoff-terminal-${status}`, status);
      f.ledger.appendCustomEvent({
        kind: 'job.review-handoff-queued', jobId: `job-handoff-terminal-${status}`,
        payload: { input: { jobId: `job-handoff-terminal-${status}` } },
      });
      const spawner = vi.fn() as unknown as AgentSpawner;
      const escalate = vi.fn();
      const wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner, bus: f.bus, escalate });
      wave.resumeQueuedHandoffs();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const skipped = f.ledger.latestJobEvent(`job-handoff-terminal-${status}`, 'job.review-handoff-skipped');
      expect(skipped?.payload).toMatchObject({ reason: 'terminal-job', status });
      expect(f.ledger.latestJobEvent(`job-handoff-terminal-${status}`, 'job.review-handoff-failed')).toBeNull();
      expect(escalate).not.toHaveBeenCalled();
      expect(spawner).not.toHaveBeenCalled();
      await wave.shutdown();
    }
  }, 120_000);
});


describe('provider pacing through WaveRunner', () => {
  it('passes review admission and retry policy to the native workflow with round-bound ledger events', async () => {
    const repo = makeFixtureRepo('pacing-wave-port'); repos.push(repo);
    repo.git(['checkout', '-b', 'feature/pacing-wave']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number { return 43; }\n');
    const root = mkdtempSync(join(tmpdir(), 'pacing-wave-root-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'pacing-wave-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'pacing-wave-sessions-'));
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'pacing-wave-db-'))); dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/pacing-wave', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'pacing-wave' });
    ledger.addJob({ id: 'pacing-wave', repo: 'fixture', title: 'pacing wave', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus('pacing-wave', 'working'); settleLane(ledger, 'pacing-wave');
    ledger.setJobPr('pacing-wave', 'https://git.example.invalid/acme/fixture/pull/11');
    attachOrigin(repo, 'feature/pacing-wave', root);
    const poster = { post: vi.fn(async (input: { readonly prUrl: string; readonly body: string; readonly targetSha: string }) => ({
      reviewId: '9101', actor: 'gru-bot', event: 'COMMENTED', commitId: input.targetSha,
      headSha: input.targetSha, baseSha: input.targetSha,
      bodySha256: createHash('sha256').update(input.body, 'utf8').digest('hex'),
    })) };
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 0, maxConcurrentReviewTurns: 1 });
    const holder = await gate.acquireReviewTurn({ id: 'other', label: 'other' });
    let failed = false;
    const fake = fakeWholeSpawner(sessions, { childAnswer: () => '[]', specialists: [],
      promptError: () => { if (failed) return null; failed = true; return '429 too many requests'; } });
    const wave = new WaveRunner({ ledger, worktrees: port, spawner: fake.spawner, reviewArtifactRoot: artifacts, reviewGate: gate,
      poster, prHeadProbe: localHeadProbe('feature/pacing-wave'),
      rateLimitBackoff: { baseMs: 1, maxMs: 1, maxRetries: 1, patterns: [] } });
    // Pin the draw: capped backoff now spreads downward instead of always
    // clamping to maxMs. The ledger assertion still checks an exact delay.
    const jitter = vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const running = wave.runRound({ jobId: 'pacing-wave' });
      // Setup now includes the real async admission remote probe (gh-169
      // R4-6): give the wait room under co-tenant load instead of the 1 s
      // vi.waitFor default.
      await vi.waitFor(() => expect(gate.view().review.queued).toHaveLength(1), { timeout: 15_000 });
      expect(fake.leadCalls).toHaveLength(0);
      holder.release();
      const result = asWave(await running);
      expect(result.canonicalVerdict).toBe('READY TO MERGE');
      const event = ledger.latestRoundEvent(result.round.id, 'pacing.auto-retry');
      expect(event?.jobId).toBe('pacing-wave');
      // Canonical payload across both producers; per-producer context rides
      // the event envelope (roundId/agentId), never the payload.
      expect(Object.keys(event?.payload as Record<string, unknown>).sort()).toEqual([
        'attempt',
        'delay_ms',
        'error',
        'max_auto_retries',
      ]);
      expect(event?.payload).toMatchObject({ attempt: 1, max_auto_retries: 1, delay_ms: 1 });
      expect(event?.roundId).toBe(result.round.id);
      expect(event?.agentId).toBeTruthy();
      expect(gate.view().review).toMatchObject({ running: 0, queued: [] });
    } finally {
      jitter.mockRestore();
      await wave.shutdown();
      for (const dir of [root, artifacts, sessions]) rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('automatic admission retry (owner decisions 2026-10-08: in memory; a stuck git escalates)', () => {
  /** A delivered lane whose advertised-tip probe fails at once while the
   * shim's `remote-down` flag exists — git's own failure, so the refusal is
   * the transient check-failed kind that retries. With `remote-slow`
   * instead, the probe marks `slowStarted`, waits, then answers truthfully. */
  async function transientFixture(name: string, opts: { readonly probeDelaySeconds?: number; readonly stuckFile?: string } = {}) {
    const repo = makeFixtureRepo(`perkins-retry-${name}`);
    repos.push(repo);
    const branch = `feature/retry-${name}`;
    repo.git(['checkout', '-b', branch]);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = mkdtempSync(join(tmpdir(), 'perkins-retry-port-'));
    const artifacts = mkdtempSync(join(tmpdir(), 'perkins-retry-artifacts-'));
    const sessions = mkdtempSync(join(tmpdir(), 'perkins-retry-sessions-'));
    const shimDir = mkdtempSync(join(tmpdir(), 'perkins-retry-shim-'));
    dirs.push(sessions, shimDir);
    const db = new LedgerDb(mkdtempSync(join(tmpdir(), 'perkins-retry-db-')));
    dbs.push(db);
    const bus = new EventBus();
    const ledger = new LedgerApi(db.handle, { bus });
    const port = new GitReviewPort(root, branch, target);
    const jobId = `job-retry-${name}`;
    await port.createJobWorktree({ repoPath: repo.path, jobId });
    ledger.addJob({ id: jobId, repo: 'fixture', title: 'admission retry', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(jobId, 'working');
    settleLane(ledger, jobId);
    ledger.setJobPr(jobId, 'https://github.com/acme/fixture/pull/61');
    attachOrigin(repo, branch, root);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const flag = join(shimDir, 'remote-down');
    const slow = join(shimDir, 'remote-slow');
    const slowStarted = join(shimDir, 'slow-started');
    writeFileSync(flag, '');
    const delay = opts.probeDelaySeconds !== undefined ? `sleep ${opts.probeDelaySeconds}; ` : '';
    // stuckFile: the remote step hangs, recording its process group.
    const remoteDown = opts.stuckFile !== undefined
      ? `ps -o pgid= -p $$ | tr -d ' ' >> "${opts.stuckFile}"; exec sleep 30`
      : `${delay}echo "fatal: unable to access the remote" >&2; exit 128`;
    writeFileSync(join(shimDir, 'git'), [
      '#!/bin/sh',
      `if [ -e "${flag}" ]; then case " $* " in *" ls-remote "*) ${remoteDown};; esac; fi`,
      `if [ -e "${slow}" ]; then case " $* " in *" ls-remote "*) touch "${slowStarted}"; sleep 1;; esac; fi`,
      `exec "${realGit}" "$@"`,
      '',
    ].join('\n'));
    chmodSync(join(shimDir, 'git'), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
    const restorePath = (): void => {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    };
    return { repo, ledger, bus, port, jobId, sessions, artifacts, flag, slow, slowStarted, branch, target, restorePath };
  }

  const kinds = (ledger: LedgerApi, jobId: string, kind: string) =>
    ledger.listJobEventsByKinds(jobId, [kind], { limit: 50 }).slice().reverse();
  const payloads = (ledger: LedgerApi, jobId: string, kind: string) => kinds(ledger, jobId, kind).map((event) => event.payload as Record<string, unknown>);
  const settled = (ledger: LedgerApi, jobId: string) => payloads(ledger, jobId, 'round.admission-retry-settled');
  async function until(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
    await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: timeoutMs, interval: 20 });
  }

  it('retries a transient refusal twice — an FYI per retry, the action-required escalation only after the last; zero delays never race the rollback (R7-15)', async () => {
    const { ledger, port, jobId, sessions, artifacts, branch, restorePath } = await transientFixture('exhausted');
    const informs: string[] = [];
    const escalations: string[] = [];
    const wave = new WaveRunner({
      // A slow sweep: a zero-delay retry must still wait for the rollback.
      ledger, worktrees: new SlowReleasePort(port, 150), spawner: makeSpawner(sessions, []), reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe(branch), admissionRetryDelaysMs: [0, 0],
      inform: (title, detail) => informs.push(`${title}: ${detail}`),
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    try {
      await expect(wave.requestReview({ jobId })).rejects.toThrow(
        /\[head-binding\].*check-failed.*automatic retry 1 of 2 is scheduled for \d{4}-/u,
      );
      expect(escalations).toEqual([]);
      await until(() => escalations.length === 1 && settled(ledger, jobId).length === 2);
    } finally {
      restorePath();
      await wave.shutdown();
    }
    const rounds = ledger.listRounds(jobId);
    expect(rounds.map((round) => round.status)).toEqual(['aborted', 'aborted', 'aborted']);
    expect(ledger.listAgents().filter((agent) => agent.roundId !== null)).toEqual([]);
    const scheduled = kinds(ledger, jobId, 'round.admission-retry-scheduled');
    expect(scheduled.map((event) => [event.roundId, (event.payload as { attempt: number }).attempt]))
      .toEqual([[rounds[0]!.id, 1], [rounds[1]!.id, 2]]);
    expect(settled(ledger, jobId)).toEqual([
      { attempt: 1, scheduledSeq: scheduled[0]!.seq, outcome: 'refused' },
      { attempt: 2, scheduledSeq: scheduled[1]!.seq, outcome: 'refused' },
    ]);
    expect(informs).toHaveLength(2);
    expect(escalations[0]).toContain('automatic retry 2 of 2 was refused too — no retries remain');
  });

  it('a retry is skipped when the job moved on — newer delivery, status, successor round, busy branch — with an FYI and no escalation (R7-22)', async () => {
    const cases: readonly { readonly name: string; readonly move: (f: Awaited<ReturnType<typeof transientFixture>>) => void; readonly reason: RegExp }[] = [
      { name: 'delivery', move: (f) => { f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.jobId, payload: { sha: 'newer' } }); }, reason: /a newer delivery replaced the refused one/u },
      { name: 'status', move: (f) => { f.ledger.setJobStatus(f.jobId, 'blocked'); }, reason: /the job is blocked/u },
      { name: 'successor', move: (f) => { f.ledger.addRound({ jobId: f.jobId, lenses: [...PERKINS_LENSES], targetRef: f.target }); }, reason: /a newer review round already started/u },
      { name: 'busy', move: (f) => { f.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: f.jobId, payload: { request_id: 'repair-1' } }); }, reason: /the branch is busy again/u },
    ];
    for (const entry of cases) {
      const f = await transientFixture(`moved-${entry.name}`);
      const informs: string[] = [];
      const escalations: string[] = [];
      const wave = new WaveRunner({
        ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts,
        prHeadProbe: localHeadProbe(f.branch), admissionRetryDelaysMs: [150],
        inform: (title, detail) => informs.push(`${title}: ${detail}`),
        escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      });
      try {
        await expect(wave.requestReview({ jobId: f.jobId })).rejects.toThrow(/automatic retry 1 of 1 is scheduled/u);
        const roundsBefore = f.ledger.listRounds(f.jobId).length;
        entry.move(f);
        await until(() => informs.some((line) => line.includes('skipped')));
        expect(informs.at(-1), entry.name).toMatch(entry.reason);
        expect(settled(f.ledger, f.jobId), entry.name).toEqual([expect.objectContaining({ outcome: 'skipped', reason: expect.stringMatching(entry.reason) })]);
        expect(f.ledger.listRounds(f.jobId).length, entry.name).toBe(roundsBefore + (entry.name === 'successor' ? 1 : 0));
        expect(escalations, entry.name).toEqual([]);
      } finally {
        f.restorePath();
        await wave.shutdown();
      }
    }
  });

  it('work that makes the branch busy DURING the probe stops the review before any admission effect — a request is refused busy, a forced one too for a blocker its arm never audited, a retry skipped with an FYI (R8-16)', async () => {
    for (const route of ['request', 'forced', 'retry'] as const) {
      const f = await transientFixture(`busy-probe-${route}`);
      const informs: string[] = [];
      const escalations: string[] = [];
      // Armed rounds: the freeze has passed its branch-idle check; the
      // admission probe (slow, and it would pass) starts next — a repair
      // directive lands while it runs.
      let armed = route !== 'retry';
      let landed = false;
      const wave = new WaveRunner({
        ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts,
        prHeadProbe: localHeadProbe(f.branch), admissionRetryDelaysMs: [100],
        reviewFreezeObserver: () => {
          if (!armed) return;
          setTimeout(() => {
            if (route === 'forced') {
              // Another job's lane on the same branch starts working.
              const sibling = `${f.jobId}-sibling`;
              void f.port.createJobWorktree({ repoPath: f.repo.path, jobId: sibling }).then(() => {
                f.ledger.addJob({ id: sibling, repo: 'fixture', title: 'sibling', baseBranch: 'main', briefing: 'sibling' });
                f.ledger.setJobStatus(sibling, 'working');
                landed = true;
              });
              return;
            }
            f.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: f.jobId, payload: { request_id: 'repair-during-probe' } });
            landed = true;
          }, 300);
        },
        inform: (title, detail) => informs.push(`${title}: ${detail}`),
        escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      });
      try {
        if (route !== 'retry') {
          rmSync(f.flag);
          writeFileSync(f.slow, '');
          await expect(wave.requestReview({ jobId: f.jobId, ...(route === 'forced' ? { force: true } : {}) }))
            .rejects.toThrow(route === 'forced' ? new RegExp(`is busy \\(${f.jobId}-sibling: working\\)`, 'u') : /is busy/u);
          expect(landed).toBe(true);
        } else {
          await expect(wave.requestReview({ jobId: f.jobId })).rejects.toThrow(/automatic retry 1 of 1 is scheduled/u);
          rmSync(f.flag);
          writeFileSync(f.slow, '');
          armed = true;
          await until(() => settled(f.ledger, f.jobId).length === 1);
          expect(landed).toBe(true);
          expect(settled(f.ledger, f.jobId)[0]).toMatchObject({ outcome: 'skipped', reason: expect.stringContaining('the branch is busy again') });
          expect(informs.at(-1)).toContain('skipped');
        }
      } finally {
        f.restorePath();
        await wave.shutdown();
      }
      const rounds = f.ledger.listRounds(f.jobId);
      expect(rounds.every((round) => round.status === 'aborted'), route).toBe(true);
      expect(f.ledger.listAgents().filter((agent) => agent.roundId !== null), route).toEqual([]);
      const refused = kinds(f.ledger, f.jobId, 'branch-idle.refused').at(-1);
      expect(refused?.roundId, route).toBe(rounds.at(-1)!.id);
      expect(escalations, route).toEqual([]);
    }
  });

  it('a fresh request refused while a retry waits keeps it — same attempt and due time — so neither the retry nor the final escalation is lost (R7-11)', async () => {
    const { ledger, port, jobId, sessions, artifacts, branch, restorePath } = await transientFixture('takeover');
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe(branch), admissionRetryDelaysMs: [0, 600],
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    try {
      await expect(wave.requestReview({ jobId })).rejects.toThrow(/automatic retry 1 of 2 is scheduled/u);
      // Retry 1 runs at once and is refused: retry 2 now waits.
      await until(() => kinds(ledger, jobId, 'round.admission-retry-scheduled').length === 2);
      const waiting = kinds(ledger, jobId, 'round.admission-retry-scheduled')[1]!;
      expect(waiting.payload).toMatchObject({ attempt: 2 });
      // A fresh request refused meanwhile keeps THAT retry — attempt 2, same due time.
      await expect(wave.requestReview({ jobId })).rejects.toThrow(/automatic retry 2 of 2 is scheduled/u);
      const taken = kinds(ledger, jobId, 'round.admission-retry-scheduled')[2]!;
      expect(taken.roundId).toBe(ledger.listRounds(jobId)[2]!.id);
      expect(taken.payload).toMatchObject({ attempt: 2, dueAt: (waiting.payload as { dueAt: string }).dueAt });
      await until(() => escalations.length === 1);
    } finally {
      restorePath();
      await wave.shutdown();
    }
    expect(ledger.listRounds(jobId)).toHaveLength(4); // request, retry 1, fresh request, retry 2
    expect(escalations[0]).toContain('automatic retry 2 of 2 was refused too — no retries remain');
  });

  it('a waiting retry that comes due while a fresh refusal is still rolling back is kept, and runs once the rollback ends (R9-8)', async () => {
    const { ledger, port, jobId, sessions, artifacts, branch, restorePath } = await transientFixture('rebind-rollback');
    const gated = new GatedReleasePort(port);
    const escalations: string[] = [];
    const informs: string[] = [];
    const delay = 3_000;
    const wave = new WaveRunner({
      ledger, worktrees: gated, spawner: makeSpawner(sessions, []), reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe(branch), admissionRetryDelaysMs: [delay],
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
      inform: (title, detail) => informs.push(`${title}: ${detail}`),
    });
    try {
      await expect(wave.requestReview({ jobId })).rejects.toThrow(/automatic retry 1 of 1 is scheduled/u);
      const dueAt = Date.parse((payloads(ledger, jobId, 'round.admission-retry-scheduled')[0] as { dueAt: string }).dueAt);
      // A fresh request is refused while the retry waits; its rollback is held.
      gated.hold = true;
      const fresh = wave.requestReview({ jobId });
      fresh.catch(() => undefined);
      await until(() => gated.entered === 1, delay);
      expect(Date.now(), 'the fresh refusal must reach its rollback before the retry is due').toBeLessThan(dueAt);
      expect(kinds(ledger, jobId, 'round.admission-retry-scheduled')).toHaveLength(2); // the fresh refusal took the retry over
      // The retry comes due while the rollback is still held.
      await until(() => Date.now() > dueAt + 300, delay + 2_000);
      expect(settled(ledger, jobId)).toEqual([]);
      gated.open();
      await expect(fresh).rejects.toThrow(/automatic retry 1 of 1 is scheduled/u);
      // Armed after the rollback (already due): it runs — and, the remote still down, is refused for the last time.
      await until(() => escalations.length === 1);
    } finally {
      gated.open();
      restorePath();
      await wave.shutdown();
    }
    expect(informs.filter((line) => line.includes('skipped'))).toEqual([]);
    expect(settled(ledger, jobId)).toEqual([expect.objectContaining({ attempt: 1, outcome: 'refused' })]);
    expect(ledger.listRounds(jobId)).toHaveLength(3); // request, fresh request, the retry
    expect(escalations[0]).toContain('automatic retry 1 of 1 was refused too — no retries remain');
  }, 60_000);

  it('a retry binds the delivery its round reviewed, never one that landed during the probe (R7-14)', async () => {
    const { ledger, port, jobId, sessions, artifacts, branch, restorePath } = await transientFixture('probe-delivery', { probeDelaySeconds: 0.4 });
    const informs: string[] = [];
    const wave = new WaveRunner({
      ledger, worktrees: port, spawner: makeSpawner(sessions, []), reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe(branch), admissionRetryDelaysMs: [50],
      inform: (title, detail) => informs.push(`${title}: ${detail}`),
    });
    const reviewed = ledger.latestJobEvent(jobId, 'job.delivered')!.seq;
    try {
      const request = wave.requestReview({ jobId });
      await new Promise((resolve) => setTimeout(resolve, 150));
      ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: 'landed-during-probe' } });
      await expect(request).rejects.toThrow(/automatic retry 1 of 1 is scheduled/u);
      expect(payloads(ledger, jobId, 'round.admission-retry-scheduled')[0]).toMatchObject({ deliverySeq: reviewed });
      await until(() => informs.some((line) => line.includes('a newer delivery replaced the refused one')));
    } finally {
      restorePath();
      await wave.shutdown();
    }
  });

  it('a minion handoff refused transiently is notified once (FYI), and its retries run after the handoff settles (R7-15, R7-16)', async () => {
    const f = await transientFixture('handoff');
    const informs: string[] = [];
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts, bus: f.bus,
      prHeadProbe: localHeadProbe(f.branch), admissionRetryDelaysMs: [0, 0],
      inform: (title, detail) => informs.push(`${title}: ${detail}`),
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    });
    try {
      // The minion is still in its turn: the lane is busy, so the request queues.
      f.ledger.setJobStatus(f.jobId, 'blocked');
      f.ledger.setJobStatus(f.jobId, 'working');
      expect((await wave.requestReview({ jobId: f.jobId, handoff: true })).route).toBe('queued');
      f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.jobId, payload: { sha: f.target } });
      await until(() => escalations.length === 1 && settled(f.ledger, f.jobId).length === 2);
    } finally {
      f.restorePath();
      await wave.shutdown();
    }
    expect(f.ledger.latestJobEvent(f.jobId, 'job.review-handoff-failed')).not.toBeNull();
    expect(escalations[0]).toContain('no retries remain'); // the only action-required notice
    expect(escalations.some((line) => line.includes('Queued review handoff failed'))).toBe(false);
    expect(settled(f.ledger, f.jobId).map((entry) => entry['outcome'])).toEqual(['refused', 'refused']);
    expect(f.ledger.listRounds(f.jobId)).toHaveLength(3);
  });

  it('a shutdown in the middle of a retry starts nothing — no fallback gate — and the next start escalates it instead of resuming (R7-12, R7-17)', async () => {
    const f = await transientFixture('interrupted');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    let calls = 0;
    const escalations: string[] = [];
    const options = {
      ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts,
      prHeadProbe: localHeadProbe(f.branch), admissionRetryDelaysMs: [50],
      escalate: (title: string, detail: string) => escalations.push(`${title}: ${detail}`),
    };
    const first = new WaveRunner({
      ...options,
      reviewPreflight: async () => {
        calls += 1;
        if (calls === 1) return { ok: true as const, failures: [] };
        entered = true;
        await held; // the retry's pre-flight is in flight when the service stops
        return { ok: false as const, failures: [preflightFailure('review-policy', 'disabled')] };
      },
    });
    await expect(first.requestReview({ jobId: f.jobId })).rejects.toThrow(/automatic retry 1 of 1/u);
    await until(() => entered);
    const stopping = first.shutdown();
    release();
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.ledger.listJobEventsByKinds(f.jobId, ['job.fallback-review'], { limit: 10 })).toEqual([]);
    expect(settled(f.ledger, f.jobId)).toEqual([]);
    // Restart: nothing resumes the retry — it escalates, once.
    rmSync(f.flag);
    const second = new WaveRunner(options);
    try {
      expect(second.escalateInterruptedAdmissionRetries()).toBe(1);
      expect(second.escalateInterruptedAdmissionRetries()).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      f.restorePath();
      await second.shutdown();
    }
    expect(escalations).toEqual([expect.stringMatching(new RegExp(`^Automatic review retry for job ${f.jobId} was interrupted by a restart: Retry 1 after refused round ${f.ledger.listRounds(f.jobId)[0]!.id} was due at`, 'u'))]);
    expect(settled(f.ledger, f.jobId)).toEqual([expect.objectContaining({ attempt: 1, outcome: 'interrupted' })]);
    expect(f.ledger.listRounds(f.jobId)).toHaveLength(1); // never re-run
  });

  it('a retry refused while the service stops is settled as refused — the next start does not escalate it again', async () => {
    const f = await transientFixture('refused-at-shutdown');
    const escalations: string[] = [];
    const options = {
      ledger: f.ledger, worktrees: new SlowReleasePort(f.port, 400), spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts,
      prHeadProbe: localHeadProbe(f.branch), admissionRetryDelaysMs: [0],
      escalate: (title: string, detail: string) => escalations.push(`${title}: ${detail}`),
    };
    const first = new WaveRunner(options);
    try {
      await expect(first.requestReview({ jobId: f.jobId })).rejects.toThrow(/automatic retry 1 of 1/u);
      await until(() => escalations.length === 1); // the retry's final refusal, its setup still unwinding
      await first.shutdown();
      await until(() => settled(f.ledger, f.jobId).length === 1);
      expect(settled(f.ledger, f.jobId)[0]).toMatchObject({ outcome: 'refused' });
      const second = new WaveRunner(options);
      expect(second.escalateInterruptedAdmissionRetries()).toBe(0);
      await second.shutdown();
    } finally {
      f.restorePath();
    }
    expect(escalations).toHaveLength(1);
  });

  it('startup escalates only a retry that was really interrupted: never a settled one, a terminal job’s, or one a newer round already answers', async () => {
    const f = await transientFixture('startup-check');
    const escalations: string[] = [];
    const wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), escalate: (title) => escalations.push(title) });
    const schedule = (roundId: string) => f.ledger.appendCustomEvent({ kind: 'round.admission-retry-scheduled', jobId: f.jobId, roundId,
      payload: { attempt: 1, of: 2, dueAt: new Date().toISOString(), deliverySeq: 0 } });
    try {
      const refused = f.ledger.addRound({ jobId: f.jobId, lenses: [...PERKINS_LENSES], targetRef: f.target });
      const first = schedule(refused.id);
      f.ledger.appendCustomEvent({ kind: 'round.admission-retry-settled', jobId: f.jobId, roundId: refused.id,
        payload: { attempt: 1, scheduledSeq: first.seq, outcome: 'ran' } });
      expect(wave.escalateInterruptedAdmissionRetries()).toBe(0); // settled
      schedule(refused.id);
      f.ledger.addRound({ jobId: f.jobId, lenses: [...PERKINS_LENSES], targetRef: f.target });
      expect(wave.escalateInterruptedAdmissionRetries()).toBe(0); // a newer round answers it
      expect(settled(f.ledger, f.jobId).at(-1)).toMatchObject({ outcome: 'interrupted' });
      const latest = f.ledger.listRounds(f.jobId).at(-1)!;
      schedule(latest.id);
      f.ledger.setJobStatus(f.jobId, 'done');
      expect(wave.escalateInterruptedAdmissionRetries()).toBe(0); // terminal
      expect(escalations).toEqual([]);
    } finally {
      f.restorePath();
      await wave.shutdown();
    }
  });

  it('production waits: one minute, then five — never earlier; an unsupported delay is refused up front (R8-19, R7-18)', async () => {
    const f = await transientFixture('default-delays');
    expect(() => new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), admissionRetryDelaysMs: [2_147_483_648] }))
      .toThrow(/admissionRetryDelaysMs must be whole milliseconds from 0 to 2147483647/u);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const wave = new WaveRunner({
      ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts, prHeadProbe: localHeadProbe(f.branch),
    });
    /** The retry timer armed since `from`: its callback and delay. */
    const armed = (from: number): { readonly fire: () => void; readonly ms: number } => {
      const calls = timers.mock.calls.slice(from).filter(([, ms]) => typeof ms === 'number' && ms > 30_000);
      expect(calls).toHaveLength(1);
      return { fire: calls[0]![0] as () => void, ms: calls[0]![1] as number };
    };
    try {
      let mark = timers.mock.calls.length;
      let refusedAt = Date.now();
      await expect(wave.requestReview({ jobId: f.jobId })).rejects.toThrow(/automatic retry 1 of 2 is scheduled/u);
      const first = armed(mark);
      expect(first.ms).toBeGreaterThan(59_000);
      expect(first.ms).toBeLessThanOrEqual(60_000);
      const due1 = Date.parse((payloads(f.ledger, f.jobId, 'round.admission-retry-scheduled')[0] as { dueAt: string }).dueAt);
      expect(due1 - refusedAt).toBeGreaterThanOrEqual(59_000);
      expect(due1 - refusedAt).toBeLessThanOrEqual(61_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(f.ledger.listRounds(f.jobId)).toHaveLength(1); // no early dispatch
      // The minute is up: fire it (standing in for the clock).
      mark = timers.mock.calls.length;
      refusedAt = Date.now();
      first.fire();
      await until(() => kinds(f.ledger, f.jobId, 'round.admission-retry-scheduled').length === 2);
      await until(() => timers.mock.calls.slice(mark).some(([, ms]) => typeof ms === 'number' && ms > 30_000));
      const second = armed(mark);
      expect(second.ms).toBeGreaterThan(299_000);
      expect(second.ms).toBeLessThanOrEqual(300_000);
      const due2 = Date.parse((payloads(f.ledger, f.jobId, 'round.admission-retry-scheduled')[1] as { dueAt: string }).dueAt);
      expect(due2 - refusedAt).toBeGreaterThanOrEqual(299_000);
      expect(due2 - refusedAt).toBeLessThanOrEqual(305_000);
      expect(f.ledger.listRounds(f.jobId)).toHaveLength(2);
    } finally {
      timers.mockRestore();
      f.restorePath();
      await wave.shutdown();
    }
  });

  it('a clean-abort re-arm keeps its delivered-head fence through the retry (R7-23)', async () => {
    const f = await transientFixture('bound-head');
    const wave = new WaveRunner({
      ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts,
      prHeadProbe: localHeadProbe(f.branch), admissionRetryDelaysMs: [30],
    });
    const seen = vi.spyOn(wave, 'requestReview');
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.jobId, payload: { sha: f.target } }); // the head the re-arm proved
    try {
      const targetRef = `origin/${f.branch}`; // the tracking branch the re-arm names
      await expect(wave.requestReview({ jobId: f.jobId, targetRef, boundDeliveredSha: f.target })).rejects.toThrow(/automatic retry 1 of 1/u);
      await until(() => settled(f.ledger, f.jobId).length === 1);
      expect(seen.mock.calls[1]![0]).toMatchObject({ targetRef, boundDeliveredSha: f.target, admissionRetry: expect.any(Object) });
    } finally {
      f.restorePath();
      await wave.shutdown();
    }
  });

  it('a retry re-submits the request exactly — private evidence bytes, scope, delivered-head fence — and never its force (R7-21, R8-21)', async () => {
    const f = await transientFixture('evidence');
    const uploads = mkdtempSync(join(tmpdir(), 'retry-evidence-uploads-'));
    dirs.push(uploads);
    const uploadPath = join(uploads, '1791057000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-reference.png');
    const pixels = minimalPng(Buffer.from('retry-evidence-pixels'));
    writeFileSync(uploadPath, pixels);
    const fake = fakeWholeSpawner(f.sessions, { images: true, childAnswer: () => '[]' });
    const wave = new WaveRunner({
      ledger: f.ledger, worktrees: f.port, spawner: fake.spawner, reviewArtifactRoot: f.artifacts, evidenceUploadsDir: uploads,
      prHeadProbe: localHeadProbe(f.branch), admissionRetryDelaysMs: [100],
    });
    const seen = vi.spyOn(wave, 'requestReview');
    const evidence = [{ uploadPath, purpose: 'owner reference for the retried review', consentRef: 'owner approval j-1001' }];
    const targetRef = `origin/${f.branch}`;
    try {
      // A forced arm: its force covers only the blockers present at ITS arm.
      await expect(wave.requestReview({ jobId: f.jobId, targetRef, evidence, force: true })).rejects.toThrow(/automatic retry 1 of 1/u);
      rmSync(f.flag); // the remote answers before the retry is due
      await until(() => settled(f.ledger, f.jobId).length === 1, 60_000);
      const outcome = settled(f.ledger, f.jobId)[0]!;
      expect(outcome).toMatchObject({ outcome: 'ran', route: 'perkins' });
      const retried = seen.mock.calls[1]![0];
      expect(retried).not.toHaveProperty('force');
      expect(retried).toMatchObject({ jobId: f.jobId, targetRef, evidence });
      const roundId = String(outcome['ranRoundId']);
      const manifest = JSON.parse(readFileSync(join(f.artifacts, roundId, 'manifest.json'), 'utf8')) as {
        branchIdle?: unknown;
        reviewEvidence: { attachments: Array<{ purpose: string; consentRef: string; sha256: string }> };
      };
      expect(manifest.branchIdle).toBeUndefined(); // not forced
      expect(manifest.reviewEvidence.attachments).toEqual([expect.objectContaining({
        purpose: 'owner reference for the retried review', consentRef: 'owner approval j-1001',
        sha256: createHash('sha256').update(pixels).digest('hex'),
      })]);
      await until(() => fake.leadCalls.length > 0, 10_000);
      expect(fake.leadCalls[0]!.images).toHaveLength(1);
      expect(createHash('sha256').update(Buffer.from(fake.leadCalls[0]!.images![0]!.data, 'base64')).digest('hex'))
        .toBe(createHash('sha256').update(pixels).digest('hex')); // the bytes the lead received
    } finally {
      f.restorePath();
      await wave.shutdown();
    }
  });

  it('a git group that would not stop refuses its round, escalates ONCE naming the group, is never retried — and quarantines nothing (owner decision 2026-10-08, R8-25)', async () => {
    const stuckFile = join(mkdtempSync(join(tmpdir(), 'perkins-retry-stuck-')), 'groups');
    dirs.push(dirname(stuckFile));
    const f = await transientFixture('stuck-git', { stuckFile });
    const escalations: string[] = [];
    const informs: string[] = [];
    const stuck = (pgid: number): boolean => existsSync(stuckFile) && readFileSync(stuckFile, 'utf8').split('\n').includes(String(pgid));
    const realSync = OWNED_GIT_SEAMS.groupHasLiveMember;
    const realAsync = OWNED_GIT_SEAMS.groupHasLiveMemberAsync;
    const sync = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMember').mockImplementation((pgid, budget) => stuck(pgid) || realSync(pgid, budget));
    const async = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMemberAsync').mockImplementation(async (pgid, budget) => stuck(pgid) || realAsync(pgid, budget));
    const wave = new WaveRunner({
      ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts, bus: f.bus,
      prHeadProbe: localHeadProbe(f.branch), admissionRetryDelaysMs: [0, 0],
      escalate: (title: string, detail: string) => escalations.push(`${title}: ${detail}`),
      inform: (title: string, detail: string) => informs.push(`${title}: ${detail}`),
    });
    try {
      // Through a queued minion handoff: its wrapper must not alert a second time.
      f.ledger.setJobStatus(f.jobId, 'blocked');
      f.ledger.setJobStatus(f.jobId, 'working');
      expect((await wave.requestReview({ jobId: f.jobId, handoff: true })).route).toBe('queued');
      f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.jobId, payload: { sha: f.target } });
      await until(() => f.ledger.latestJobEvent(f.jobId, 'job.review-handoff-failed') !== null, 60_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(escalations).toHaveLength(1);
      expect(escalations[0]).toMatch(/refused admission before any specialist started: .*cleanup unconfirmed: process group \d+ still running/u);
      expect(informs).toEqual([]);
      expect(kinds(f.ledger, f.jobId, 'round.admission-retry-scheduled')).toEqual([]); // never a retry
      // No quarantine: once the remote answers, the next request is admitted.
      sync.mockRestore();
      async.mockRestore();
      rmSync(f.flag);
      const admitted = await wave.requestReview({ jobId: f.jobId });
      expect(admitted.route).toBe('perkins');
    } finally {
      sync.mockRestore();
      async.mockRestore();
      f.restorePath();
      await wave.shutdown();
    }
  }, 120_000);

  it('a git group that would not stop is escalated naming it even when the branch turned busy during the probe — a busy refusal never masks it (R9-6)', async () => {
    for (const route of ['request', 'forced'] as const) {
      const stuckFile = join(mkdtempSync(join(tmpdir(), 'perkins-retry-stuck-')), 'groups');
      dirs.push(dirname(stuckFile));
      const f = await transientFixture(`stuck-busy-${route}`, { stuckFile });
      const escalations: string[] = [];
      const informs: string[] = [];
      const stuck = (pgid: number): boolean => existsSync(stuckFile) && readFileSync(stuckFile, 'utf8').split('\n').includes(String(pgid));
      const realSync = OWNED_GIT_SEAMS.groupHasLiveMember;
      const realAsync = OWNED_GIT_SEAMS.groupHasLiveMemberAsync;
      const sync = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMember').mockImplementation((pgid, budget) => stuck(pgid) || realSync(pgid, budget));
      const async = vi.spyOn(OWNED_GIT_SEAMS, 'groupHasLiveMemberAsync').mockImplementation(async (pgid, budget) => stuck(pgid) || realAsync(pgid, budget));
      let landed = false;
      const wave = new WaveRunner({
        ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts,
        prHeadProbe: localHeadProbe(f.branch), admissionRetryDelaysMs: [0, 0],
        // New work lands while the stuck remote probe runs.
        reviewFreezeObserver: () => {
          setTimeout(() => {
            if (route === 'forced') {
              const sibling = `${f.jobId}-sibling`;
              void f.port.createJobWorktree({ repoPath: f.repo.path, jobId: sibling }).then(() => {
                f.ledger.addJob({ id: sibling, repo: 'fixture', title: 'sibling', baseBranch: 'main', briefing: 'sibling' });
                f.ledger.setJobStatus(sibling, 'working');
                landed = true;
              });
              return;
            }
            f.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: f.jobId, payload: { request_id: 'repair-during-stuck-probe' } });
            landed = true;
          }, 300);
        },
        escalate: (title: string, detail: string) => escalations.push(`${title}: ${detail}`),
        inform: (title: string, detail: string) => informs.push(`${title}: ${detail}`),
      });
      try {
        await expect(wave.requestReview({ jobId: f.jobId, ...(route === 'forced' ? { force: true } : {}) }))
          .rejects.toThrow(/cleanup unconfirmed: process group \d+ still running/u);
        expect(landed, route).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } finally {
        sync.mockRestore();
        async.mockRestore();
        f.restorePath();
        await wave.shutdown();
      }
      const round = f.ledger.listRounds(f.jobId).at(-1)!;
      expect(round.status, route).toBe('aborted');
      expect(escalations, route).toHaveLength(1);
      expect(escalations[0], route).toMatch(/refused admission before any specialist started: .*cleanup unconfirmed: process group \d+ still running/u);
      expect(informs, route).toEqual([]);
      expect(kinds(f.ledger, f.jobId, 'round.admission-retry-scheduled'), route).toEqual([]);
      expect(payloads(f.ledger, f.jobId, 'round.admission-preflight').at(-1), route).toMatchObject({
        ok: false, missing: [expect.objectContaining({ input: 'head-binding', cleanupUnconfirmed: true })],
      });
      expect(kinds(f.ledger, f.jobId, 'branch-idle.refused').filter((event) => event.roundId === round.id), route).toEqual([]);
    }
  }, 120_000);

  it('a review blocked before any round — its PR head unverifiable — through a queued handoff alerts once, never again as a failed handoff (R8-25)', async () => {
    const f = await transientFixture('blocked-head');
    const escalations: string[] = [];
    const wave = new WaveRunner({
      ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts, bus: f.bus,
      // The code host reports a head the fetched branch tip does not match.
      prHeadProbe: async () => ({ headRefName: f.branch, headSha: '0'.repeat(40) }),
      escalate: (title: string, detail: string) => escalations.push(`${title}: ${detail}`),
    });
    try {
      f.ledger.setJobStatus(f.jobId, 'blocked');
      f.ledger.setJobStatus(f.jobId, 'working');
      expect((await wave.requestReview({ jobId: f.jobId, handoff: true })).route).toBe('queued');
      f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.jobId, payload: { sha: f.target } });
      await until(() => f.ledger.latestJobEvent(f.jobId, 'job.review-handoff-failed') !== null);
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      f.restorePath();
      await wave.shutdown();
    }
    expect(f.ledger.latestJobEvent(f.jobId, 'job.review-freeze-blocked')).not.toBeNull();
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain('was blocked before any round: the PR head could not be verified');
    expect(f.ledger.listRounds(f.jobId)).toEqual([]);
  });

  it('a refused round restores only its own status flip — a reopened attempt in between is never concealed, even one written as the flip is published (R7-10, R8-10)', async () => {
    const f = await transientFixture('restore-cas');
    const round = f.ledger.admitReviewRound({
      jobId: f.jobId, expectedLatestRoundId: null, expectedJobStatus: 'working', lenses: [...PERKINS_LENSES], targetRef: f.target,
    });
    const flip = f.ledger.latestJobEvent(f.jobId, 'job.status')!.seq;
    // While the round set up, the lane reopened (a fix turn) and was linked again.
    f.ledger.setJobStatus(f.jobId, 'working');
    f.ledger.setJobStatus(f.jobId, 'in-review');
    f.ledger.abortReviewSetupWithoutSpawn(round.id);
    const before = f.ledger.latestJobEvent(f.jobId, 'job.status')!.seq;
    expect(f.ledger.restoreReviewSetupStatus({ jobId: f.jobId, roundId: round.id, priorStatus: 'working', attemptStartSeq: 1, expectedStatusSeq: flip })).toBe(false);
    expect(f.ledger.latestJobEvent(f.jobId, 'job.status')!.seq).toBe(before);
    expect(laneIsBusy(f.ledger, f.ledger.getJob(f.jobId)!)).toBe(true); // the reopened attempt has not delivered
    f.restorePath();

    // R8-10: a subscriber reopens the lane SYNCHRONOUSLY when the flip is
    // published — before admission even returns. The token is the flip
    // itself, read inside the admission transaction.
    const g = await transientFixture('restore-publication');
    let reopened = false;
    const stop = g.bus.subscribe((event) => {
      const payload = event.payload as { to?: unknown } | null;
      if (reopened || event.jobId !== g.jobId || event.kind !== 'job.status' || payload?.to !== 'in-review') return;
      reopened = true;
      g.ledger.setJobStatus(g.jobId, 'working');
      g.ledger.setJobStatus(g.jobId, 'in-review');
    });
    const wave = new WaveRunner({
      ledger: g.ledger, worktrees: g.port, spawner: makeSpawner(g.sessions, []), reviewArtifactRoot: g.artifacts,
      prHeadProbe: localHeadProbe(g.branch), admissionRetryDelaysMs: [],
    });
    try {
      await expect(wave.requestReview({ jobId: g.jobId })).rejects.toThrow();
      expect(reopened).toBe(true);
      const statuses = kinds(g.ledger, g.jobId, 'job.status');
      expect(statuses.some((event) => (event.payload as { restoredAfterRound?: unknown }).restoredAfterRound !== undefined)).toBe(false);
      expect(g.ledger.getJob(g.jobId)!.status).toBe('in-review');
      expect(laneIsBusy(g.ledger, g.ledger.getJob(g.jobId)!)).toBe(true);
    } finally {
      stop();
      g.restorePath();
      await wave.shutdown();
    }
  });

  it('a shutdown during freeze-target resolution starts nothing — no round, no review worktree (R8-18)', async () => {
    const f = await transientFixture('shutdown-resolution');
    rmSync(f.flag);
    let entered = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const probe = localHeadProbe(f.branch);
    const wave = new WaveRunner({
      ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts,
      prHeadProbe: async (input) => {
        entered = true;
        await held;
        return probe(input);
      },
    });
    const created = vi.spyOn(f.port, 'createReviewWorktree');
    try {
      const request = wave.requestReview({ jobId: f.jobId });
      await until(() => entered);
      const stopping = wave.shutdown();
      release();
      await expect(request).rejects.toThrow(/shut down during review setup|shutting down/u);
      await stopping;
    } finally {
      f.restorePath();
    }
    expect(f.ledger.listRounds(f.jobId)).toEqual([]);
    expect(created).not.toHaveBeenCalled();
    expect(f.ledger.getJob(f.jobId)!.status).toBe('working');
  });

  it('a shutdown during resolution reconciles no earlier owner; one during that reconciliation still creates no round (R8-18)', async () => {
    for (const during of ['resolution', 'reconciliation'] as const) {
      const f = await transientFixture(`shutdown-${during}`);
      rmSync(f.flag);
      // An earlier round whose owner marker must be reconciled before a replacement.
      const old = f.ledger.addRound({ jobId: f.jobId, lenses: [...PERKINS_LENSES], targetRef: f.target });
      f.ledger.setRoundStatus(old.id, 'aborted');
      f.ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: f.jobId, roundId: old.id,
        payload: { roundId: old.id, targetSha: f.target, runtimeId: 'pi', pid: process.pid, generation: randomUUID() } });
      let entered = false;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const reconciled: string[] = [];
      const probe = localHeadProbe(f.branch);
      const wave = new WaveRunner({
        ledger: f.ledger, worktrees: f.port, spawner: makeSpawner(f.sessions, []), reviewArtifactRoot: f.artifacts,
        prHeadProbe: async (input) => {
          if (during === 'resolution') {
            entered = true;
            await held;
          }
          return probe(input);
        },
        reconcileReviewAgent: async (agentId) => {
          reconciled.push(agentId);
          if (during === 'reconciliation') {
            entered = true;
            await held;
          }
          return true;
        },
      });
      const created = vi.spyOn(f.port, 'createReviewWorktree');
      try {
        const request = wave.requestReview({ jobId: f.jobId });
        await until(() => entered);
        const stopping = wave.shutdown();
        release();
        await expect(request, during).rejects.toThrow(/shut down during review setup|shutting down/u);
        await stopping;
      } finally {
        f.restorePath();
      }
      expect(f.ledger.listRounds(f.jobId).map((round) => round.id), during).toEqual([old.id]);
      expect(created, during).not.toHaveBeenCalled();
      expect(reconciled, during).toEqual(during === 'resolution' ? [] : ['']);
    }
  });
});
