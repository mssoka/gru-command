import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { DispatchService } from '../src/dispatch/service.js';
import type { WaveRunner } from '../src/dispatch/perkins.js';
import { gitReviewSourcePreflight, ReviewSourceUnavailableError } from '../src/dispatch/review-source.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { attachBareOrigin, makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Issue #317: a development-review report job is admitted only after the
 * ACTUAL selected object store proves the named target/base/range and
 * required inputs. Two repositories share ONE origin; only one holds the
 * review commits. No model calls: the spawner is a counting fake.
 */

const TOKEN = 'review-source-token';
const CAPS: AgentCapabilities = {
  streaming: true, steer: 'native', resume: 'file', images: false, thinking: false,
  thinkingLevelControl: false, followUp: false,
};
const PR = 'https://git.example.invalid/o/r/pull/9';

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Fixture {
  readonly full: FixtureRepo;
  readonly stale: FixtureRepo;
  readonly base: string;
  readonly target: string;
}

/** `full` and `stale` are clones of one origin (same basename-style origin
 * equality); only `full` has the review base/target commits. */
function sharedOriginFixture(): Fixture {
  const full = makeFixtureRepo('shared-app');
  repos.push(full);
  const origin = attachBareOrigin(full);
  full.git(['push', '--quiet', 'origin', 'main']);
  const parent = mkdtempSync(join(tmpdir(), 'gru-317-stale-'));
  dirs.push(parent);
  const stalePath = join(parent, 'shared-app');
  execFileSync('git', ['clone', '--quiet', origin, stalePath], { stdio: 'ignore' });
  const stale: FixtureRepo = {
    path: stalePath,
    git: (args, cwd = stalePath) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim(),
    commitFile: () => { throw new Error('unused'); },
    head: () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: stalePath, encoding: 'utf-8' }).trim(),
    cleanup: () => {},
  };
  const base = full.commitFile('src/base.ts', 'export const base = 1;\n');
  const target = full.commitFile('docs/claims.md', 'claims: the change is correct\n');
  return { full, stale, base, target };
}

interface Rig {
  readonly service: DispatchService;
  readonly ledger: LedgerApi;
  readonly worktrees: InMemoryWorktreePort;
  readonly prompts: string[];
  readonly spawns: { count: number };
  readonly home: string;
  close(): void;
}

function rig(opts: { wired?: boolean; worktrees?: (root: string) => InMemoryWorktreePort } = {}): Rig {
  const home = mkdtempSync(join(tmpdir(), 'gru-317-home-'));
  dirs.push(home);
  writeFileSync(join(home, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  const db = new LedgerDb(home);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
  const worktrees = (opts.worktrees ?? ((root) => new InMemoryWorktreePort(root)))(join(home, 'wt'));
  const prompts: string[] = [];
  const spawns = { count: 0 };
  const service = new DispatchService({
    ledger,
    worktrees,
    ...(opts.wired === false ? {} : { reviewSource: gitReviewSourcePreflight }),
    spawner: async (role): Promise<AgentHandle> => {
      spawns.count += 1;
      return {
        role, id: `agent-${spawns.count}`, sessionFile: null, capabilities: CAPS,
        async prompt(text: string) { prompts.push(text); },
        async steer() {}, async followUp() {},
        subscribe() { return () => {}; },
        health() { return { state: 'idle', lastActivity: null, sessionFile: null }; },
        async dispose() {},
      };
    },
  });
  return { service, ledger, worktrees, prompts, spawns, home, close: () => db.close() };
}

function review(repoPath: string, targetSha: string, extra: Record<string, unknown> = {}) {
  return {
    jobId: 'rev-1', repoPath, title: 'review', briefing: 'review the delta',
    deliverable: 'review' as const, targetRef: PR, targetSha, ...extra,
  };
}

async function refusal(promise: Promise<unknown>): Promise<ReviewSourceUnavailableError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ReviewSourceUnavailableError);
  return error as ReviewSourceUnavailableError;
}

describe('review source preflight (service)', () => {
  it('refuses a dispatch routed to the clone that lacks the commits, before any job, worktree or spawn', async () => {
    const f = sharedOriginFixture();
    const r = rig();
    try {
      // The clones are indistinguishable by basename and origin url.
      expect(f.stale.git(['remote', 'get-url', 'origin'])).toBe(f.full.git(['remote', 'get-url', 'origin']));
      expect(f.stale.git(['status', '--porcelain'])).toBe('');
      const error = await refusal(r.service.dispatch(review(f.stale.path, f.target, { targetBase: f.base })));
      expect(error.message).toContain(`target commit ${f.target} is not in the object store`);
      expect(error.message).toContain(`focused-delta base ${f.base} is not in the object store`);
      expect(error.message).toContain('No minion was spawned and no review ran');
      expect(r.spawns.count).toBe(0);
      expect(r.ledger.getJob('rev-1')).toBeNull();
      expect(r.worktrees.listWorktrees()).toHaveLength(0);
      expect(r.ledger.listEvents({ limit: 50 }).filter((e) => e.kind.startsWith('job.'))).toHaveLength(0);
      // A refusal is repeatable by the commissioner only: nothing retried it.
      expect(r.spawns.count).toBe(0);
    } finally {
      r.close();
    }
  });

  it('admits exactly the intended review from the repository that has the commits, binding target, range and claims input', async () => {
    const f = sharedOriginFixture();
    const r = rig();
    try {
      const outcome = await r.service.dispatch(review(f.full.path, f.target.slice(0, 12), {
        targetBase: f.base,
        requiredInputs: [{ path: 'docs/claims.md', lens: 'claims' }],
      }));
      expect((await outcome.settled).ok).toBe(true);
      const prompt = r.prompts[0]!;
      expect(prompt).toContain('REVIEW SOURCE');
      expect(prompt).toContain(`Target commit: ${f.target}`);
      expect(prompt).toContain(`Range: ${f.base}..${f.target} (1 commits)`);
      expect(prompt).toContain('Required claims input: docs/claims.md');
      const bound = r.ledger.latestJobEvent('rev-1', 'job.review-source-verified')!.payload as Record<string, unknown>;
      expect(bound).toMatchObject({ target_sha: f.target, target_base: f.base, range_commits: 1, source: 'repository' });
      expect(r.ledger.getJob('rev-1')).toMatchObject({ commissioner: 'gru', targetSha: f.target.slice(0, 12), deliverable: 'review' });
    } finally {
      r.close();
    }
  });

  it('refuses when the base is present but the target is missing, and when an input or range is wrong', async () => {
    const f = sharedOriginFixture();
    const r = rig();
    try {
      const rangeOnly = await refusal(r.service.dispatch(review(f.stale.path, f.target, { targetBase: f.stale.head() })));
      expect(rangeOnly.problems.join('\n')).toContain('target commit');
      expect(rangeOnly.problems.join('\n')).not.toContain('focused-delta base');
      const missingInput = await refusal(r.service.dispatch(review(f.full.path, f.target, {
        requiredInputs: [{ path: 'docs/absent.md', lens: 'claims' }],
      })));
      expect(missingInput.message).toContain('required claims input docs/absent.md is not a file in the target tree');
      const empty = await refusal(r.service.dispatch(review(f.full.path, f.target, { targetBase: f.target })));
      expect(empty.message).toContain('contains no commits to review');
      const loose = await refusal(r.service.dispatch(review(f.full.path, 'main')));
      expect(loose.message).toContain('is not an exact commit id');
      expect(r.spawns.count).toBe(0);
      expect(r.ledger.getJob('rev-1')).toBeNull();
    } finally {
      r.close();
    }
  });

  it('fails loud when review-source fields are supplied but no preflight is wired, and rejects them on non-review jobs', async () => {
    const f = sharedOriginFixture();
    const bare = rig({ wired: false });
    try {
      await expect(bare.service.dispatch(review(f.full.path, f.target, { targetBase: f.base }))).rejects.toThrow(/review source preflight is not wired/u);
      await expect(bare.service.dispatch({ ...review(f.full.path, f.target), deliverable: 'investigation', targetBase: f.base }))
        .rejects.toThrow(/only apply to review jobs/u);
      expect(bare.spawns.count).toBe(0);
    } finally {
      bare.close();
    }
  });

  describe('authorized source repair from an immutable package', () => {
    function bundleOf(f: Fixture): { path: string; sha256: string } {
      const dir = mkdtempSync(join(tmpdir(), 'gru-317-bundle-'));
      dirs.push(dir);
      const path = join(dir, 'review.bundle');
      f.full.git(['bundle', 'create', path, 'main']);
      return { path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
    }

    it('fetches a hash-pinned bundle into the selected repository only, then admits the review', async () => {
      const f = sharedOriginFixture();
      const pkg = bundleOf(f);
      const r = rig();
      try {
        const outcome = await r.service.dispatch(review(f.stale.path, f.target, {
          targetBase: f.base, sourcePackage: pkg,
          requiredInputs: [{ path: 'docs/claims.md', lens: 'claims' }],
        }));
        expect((await outcome.settled).ok).toBe(true);
        expect(f.stale.git(['cat-file', '-t', f.target])).toBe('commit');
        expect(f.stale.git(['rev-parse', 'refs/gru/review-source/rev-1'])).toBe(f.target);
        // No checkout/reset: the stale clone's branch and HEAD are untouched.
        expect(f.stale.git(['rev-parse', 'refs/heads/main'])).not.toBe(f.target);
        const bound = r.ledger.latestJobEvent('rev-1', 'job.review-source-verified')!.payload as Record<string, unknown>;
        expect(bound).toMatchObject({ source: 'source-package', package_sha256: pkg.sha256 });
      } finally {
        r.close();
      }
    });

    it('refuses a package whose bytes do not match the pinned hash, without touching the repository', async () => {
      const f = sharedOriginFixture();
      const pkg = bundleOf(f);
      const r = rig();
      try {
        const error = await refusal(r.service.dispatch(review(f.stale.path, f.target, {
          sourcePackage: { ...pkg, sha256: 'a'.repeat(64) },
        })));
        expect(error.message).toContain('does not match the pinned sha256');
        expect(() => f.stale.git(['cat-file', '-e', `${f.target}^{commit}`])).toThrow();
        expect(r.spawns.count).toBe(0);
        expect(r.ledger.getJob('rev-1')).toBeNull();
      } finally {
        r.close();
      }
    });

    it('refuses a package that does not carry the target', async () => {
      const f = sharedOriginFixture();
      const dir = mkdtempSync(join(tmpdir(), 'gru-317-bundle-'));
      dirs.push(dir);
      const path = join(dir, 'old.bundle');
      f.full.git(['branch', 'old-tip', f.base]);
      f.full.git(['bundle', 'create', path, 'old-tip']);
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      const r = rig();
      try {
        const error = await refusal(r.service.dispatch(review(f.stale.path, f.target, { sourcePackage: { path, sha256 } })));
        expect(error.message).toContain('carries no ref at target');
        expect(r.spawns.count).toBe(0);
      } finally {
        r.close();
      }
    });
  });

  it('does not substitute a reviewer worktree from a different object store', async () => {
    const f = sharedOriginFixture();
    class WrongStorePort extends InMemoryWorktreePort {
      override async createJobWorktree(input: { repoPath: string; jobId: string }) {
        return super.createJobWorktree({ ...input, repoPath: f.stale.path });
      }
    }
    const r = rig({ worktrees: (root) => new WrongStorePort(root) });
    try {
      const error = await refusal(r.service.dispatch(review(f.full.path, f.target)));
      expect(error.message).toContain('not the verified');
      expect(r.spawns.count).toBe(0);
      // The job is blocked (not delivered), no report or completion exists.
      expect(r.ledger.getJob('rev-1')?.status).toBe('blocked');
      expect(r.ledger.latestJobEvent('rev-1', 'job.delivered')).toBeNull();
      expect(r.worktrees.listWorktrees({ jobId: 'rev-1' }).filter((l) => l.status === 'active')).toHaveLength(0);
    } finally {
      r.close();
    }
  });

  it('leaves non-review dispatches and the PR lane untouched by the preflight', async () => {
    const f = sharedOriginFixture();
    const r = rig();
    try {
      const outcome = await r.service.dispatch({ jobId: 'impl-1', repoPath: f.stale.path, title: 't', briefing: 'b' });
      expect((await outcome.settled).ok).toBe(true);
      expect(r.prompts[0]).not.toContain('REVIEW SOURCE');
    } finally {
      r.close();
    }
  });
});

describe('review source preflight (POST /api/dispatch)', () => {
  async function boot(f: Fixture) {
    const r = rig();
    const cfg = loadConfig({ GRU_COMMAND_HOME: r.home }, '/home/tester');
    const wave = {
      requestReview: async () => ({ route: 'queued' }), resumeQueuedHandoffs: () => {}, shutdown: async () => {},
      activeReview: () => null,
    } as unknown as WaveRunner;
    const server = createDispatchServer({ config: cfg, dispatch: r.service, wave, ledger: r.ledger, pendingProducerBlockers: () => [] });
    const http: HttpServer = createServer((req, res) => {
      if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
      res.writeHead(404); res.end();
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as AddressInfo).port;
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dispatch`, {
        method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const body = (repo: FixtureRepo, extra: Record<string, unknown> = {}) => ({
      job_id: 'rev-http', repo_path: repo.path, title: 'review', briefing: 'review the delta',
      deliverable: 'review', target_ref: PR, target_sha: f.target, target_base: f.base, ...extra,
    });
    const close = async () => { await new Promise<void>((resolve) => http.close(() => resolve())); r.close(); };
    return { r, post, body, close };
  }

  it('answers a concrete 422 refusal for the wrong clone and 202 for the right one', async () => {
    const f = sharedOriginFixture();
    const h = await boot(f);
    try {
      const refused = await h.post(h.body(f.stale));
      expect(refused.status).toBe(422);
      expect(refused.json['error']).toBe('review_source_unavailable');
      expect(String(refused.json['detail'])).toContain('is not in the object store');
      expect(refused.json['problems']).toBeInstanceOf(Array);
      expect(refused.json['retry_authorized']).toBe(false);
      expect(h.r.spawns.count).toBe(0);
      expect(h.r.ledger.getJob('rev-http')).toBeNull();
      const admitted = await h.post(h.body(f.full, { required_inputs: [{ path: 'docs/claims.md', lens: 'claims' }] }));
      expect(admitted.status).toBe(202);
      expect(h.r.spawns.count).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('rejects malformed review-source fields as 400 and never feeds claims inputs to a blind lens', async () => {
    const f = sharedOriginFixture();
    const h = await boot(f);
    try {
      const blind = await h.post(h.body(f.full, { required_inputs: [{ path: 'docs/claims.md', lens: 'blind' }] }));
      expect(blind.status).toBe(400);
      expect(String(blind.json['detail'])).toContain('lens must be one of claims');
      const badPackage = await h.post(h.body(f.full, { source_package: { path: '/x' } }));
      expect(badPackage.status).toBe(400);
      const badInputs = await h.post(h.body(f.full, { required_inputs: 'docs/claims.md' }));
      expect(badInputs.status).toBe(400);
      expect(h.r.spawns.count).toBe(0);
      expect(h.r.ledger.getJob('rev-http')).toBeNull();
    } finally {
      await h.close();
    }
  });
});
