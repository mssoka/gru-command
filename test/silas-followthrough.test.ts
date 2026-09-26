import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { WaveRunner } from '../src/dispatch/perkins.js';
import { fakeWholeSpawner, type WholeLeadOptions } from './helpers/perkins-whole-double.js';
import { SilasDriver } from '../src/dispatch/silas-driver.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { NotificationCenter } from '../src/notifications/center.js';
import type { AgentCapabilities, AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import type { Role } from '../src/config.js';
import { makeFixtureRepo, attachBareOrigin, type FixtureRepo } from './helpers/fixture-repo.js';
import { originHeadProbe } from './helpers/pr-head-probe.js';

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

/**
 * Follow-through integration (E8; owner ruling 2026-09-21): a delivered
 * job lands on the PR registry and under review ENTIRELY WITHOUT HUMAN
 * INPUT — and a NEEDS CHANGES verdict closes its fix loop the same way.
 * Production wiring end to end — dispatch → ledger → bus → silas
 * driver → silas session (a fake that acts exactly as the hosted session
 * would: it reads the wake digest, then drives the same authenticated ops
 * surface a curl call drives) → PR registered → review round requested →
 * fix directive → follow-up delivery → re-review.
 */

const TOKEN = 'silas-integration-token';
const PR_URL = 'https://git.example.invalid/fixture-owner/fixture-app/pull/651';

const cleanupDirs: string[] = [];
const cleanupRepos: FixtureRepo[] = [];
afterEach(() => {
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

/** The digest subset the hosted session acts on (the exact JSON it reads). */
interface DigestView {
  deliveredWithoutPr: { jobId: string }[];
  prWithoutReview: { jobId: string; priorRounds: number }[];
  verdictsAwaitingDirective: {
    jobId: string;
    roundId: string;
    recurringBlockers: { fingerprint: string; advice: string; title: string; location: string }[];
  }[];
}

/** The hosted silas session stand-in: on every wake it parses the digest
 * out of the prompt (exactly what the model reads) and closes the loop
 * through the authenticated HTTP ops surface. */
function silasActsViaHttp(input: { port: () => number; token: string; prFor: (jobId: string) => string }) {
  return async (prompt: string): Promise<void> => {
    const jsonStart = prompt.indexOf('```json');
    const jsonEnd = prompt.indexOf('```', jsonStart + 7);
    if (jsonStart < 0 || jsonEnd < 0) throw new Error('wake prompt carries no digest');
    const digest = JSON.parse(prompt.slice(jsonStart + 7, jsonEnd)) as DigestView;
    const base = `http://127.0.0.1:${input.port()}`;
    const auth = { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' };
    const post = async (path: string, body: unknown, expected: number): Promise<void> => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
      if (res.status !== expected) {
        throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
      }
    };
    for (const row of digest.deliveredWithoutPr) {
      // discovery (transcript/gh) simulated by the fixture mapping…
      const url = input.prFor(row.jobId);
      // …then the exact ops calls the ops-dispatch skill prescribes:
      await post('/api/dispatch/pr', { job_id: row.jobId, url, by: 'silas' }, 200);
      await post('/api/dispatch/review', { job_id: row.jobId, by: 'silas' }, 202);
    }
    for (const row of digest.prWithoutReview) {
      // A delivery moved the lane past the newest round's reviewed target:
      // request the (re-)review exactly as the skill prescribes.
      await post('/api/dispatch/review', { job_id: row.jobId, by: 'silas' }, 202);
    }
    for (const row of digest.verdictsAwaitingDirective) {
      const blocker = row.recurringBlockers.find((candidate) => candidate.advice !== 'monitor');
      if (blocker === undefined) continue;
      if (blocker.advice !== 'directive') {
        throw new Error(`unhandled ladder rung in the fixture: ${blocker.advice}`);
      }
      await post(
        '/api/silas/directive',
        {
          job_id: row.jobId,
          directive: `Fix "${blocker.title}" at ${blocker.location}, then re-run the suite.`,
          blocker_fingerprint: blocker.fingerprint,
        },
        200,
      );
    }
  };
}

interface FollowThroughHarness {
  readonly ledger: LedgerApi;
  readonly dispatch: DispatchService;
  readonly driver: SilasDriver;
  readonly repo: FixtureRepo;
  readonly spawns: { role: Role; options: SpawnOptions }[];
  readonly silasPrompts: Promise<void>[];
  readonly minionPrompts: string[];
  close(): Promise<void>;
}

/** Boot the production follow-through wiring with the silas session faked. */
async function bootFollowThrough(input: {
  fixtureName: string;
  childAnswer: WholeLeadOptions['childAnswer'];
  onLeadStart?: () => void;
  priorDisposition?: WholeLeadOptions['priorDisposition'];
}): Promise<FollowThroughHarness> {
  const repo = makeFixtureRepo(input.fixtureName);
  cleanupRepos.push(repo);
  attachBareOrigin(repo);
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-silas-follow-'));
  cleanupDirs.push(dir);
  writeFileSync(
    join(dir, 'config.toml'),
    `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`,
    'utf-8',
  );
  mkdirSync(join(dir, 'wtroot'));
  const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));

  const spawns: { role: Role; options: SpawnOptions }[] = [];
  const minionPrompts: string[] = [];
  const reviewSessions = join(dir, 'review-sessions');
  mkdirSync(reviewSessions, { recursive: true });
  const hybrid = fakeWholeSpawner(reviewSessions, {
    childAnswer: input.childAnswer,
    ...(input.onLeadStart !== undefined ? { onLeadStart: input.onLeadStart } : {}),
    ...(input.priorDisposition !== undefined ? { priorDisposition: input.priorDisposition } : {}),
  });
  let minionTurns = 0;
  const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, options: options ?? {} });
    if (role === 'perkins') return hybrid.spawner(role, options);
    if (role === 'silas') throw new Error('the integration fakes the silas slot, never spawns it');
    return {
      role,
      id: `agent-${spawns.length}`,
      sessionFile: null,
      capabilities: FAKE_CAPABILITIES,
      async prompt(text: string) {
        if (role !== 'minion' || options?.cwd === undefined) return;
        minionPrompts.push(text);
        minionTurns += 1;
        if (minionTurns === 1) {
          // The briefing turn: deliver a fresh artifact.
          const file = join(options.cwd, `deliverable-${spawns.length}.txt`);
          writeFileSync(file, 'delivered\n');
          execFileSync('git', ['-C', options.cwd, 'add', file]);
        } else {
          // The fix turn: remove the placeholder line the review flagged.
          writeFileSync(join(options.cwd, 'src', 'main.ts'), 'export function answer(): number {\n  return 43;\n}\n');
          execFileSync('git', ['-C', options.cwd, 'add', 'src/main.ts']);
        }
        execFileSync(
          'git',
          ['-C', options.cwd, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', `test: minion turn ${minionTurns}`],
          { stdio: 'ignore' },
        );
        // Each turn lands on the PR branch: the review freeze reads the
        // pushed tip, never the recorded lane pointer.
        const branch = execFileSync('git', ['-C', options.cwd, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
        execFileSync('git', ['-C', options.cwd, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { stdio: 'ignore' });
      },
      async steer() {},
      async followUp() {},
      subscribe() {
        return () => {};
      },
      health() {
        return { state: 'idle' as const, lastActivity: null, sessionFile: null };
      },
      async dispose() {},
    };
  };

  const dispatch = new DispatchService({ ledger, worktrees, spawner });
  const wave = new WaveRunner({
    ledger,
    worktrees,
    spawner,
    poster: { async post(input) { return { headSha: input.targetSha, baseSha: 'stub-base' }; } },
    reviewArtifactRoot: join(dir, 'reviews'),
    prHeadProbe: originHeadProbe(),
  });
  const silasPrompts: Promise<void>[] = [];
  const silasHandle: AgentHandle = {
    role: 'silas',
    id: 'silas-hosted',
    sessionFile: null,
    capabilities: FAKE_CAPABILITIES,
    prompt(text: string) {
      const run = silasActsViaHttp({
        port: () => (http.address() as AddressInfo).port,
        token: TOKEN,
        prFor: (jobId) => (jobId === 'pr-651' ? PR_URL : `${PR_URL}-x`),
      })(text);
      silasPrompts.push(run);
      return run;
    },
    async steer() {},
    async followUp() {},
    subscribe() {
      return () => {};
    },
    health() {
      return { state: 'idle' as const, lastActivity: null, sessionFile: null };
    },
    async dispose() {},
  };

  const server = createDispatchServer({
    config: cfg,
    dispatch,
    wave,
    ledger,
    silasOps: {
      registry: {
        getHandle: () => null,
        spawn: (role, options) => spawner(role, options),
        disposeHandle: async () => {},
      },
      worktrees,
      notifications: new NotificationCenter({ ledger, bus }),
    },
  });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));

  // The driver rides the REAL production wiring: ledger bus → wake.
  const driver = new SilasDriver({
    slot: { ensure: async () => silasHandle },
    ledger,
    worktrees,
    config: { ...cfg.silas, sweepIntervalMs: 0 },
    ops: {
      baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      configPath: join(dir, 'config.toml'),
    },
    bus,
  });
  driver.start();

  return {
    ledger,
    dispatch,
    driver,
    repo,
    spawns,
    silasPrompts,
    minionPrompts,
    close: async () => {
      driver.stop();
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await wave.shutdown();
      db.close();
    },
  };
}

describe('silas follow-through (no human input)', () => {
  it('delivered job → PR registered → review round requested, driven only by the ledger event', async () => {
    const h = await bootFollowThrough({ fixtureName: 'fixture-app', childAnswer: () => '[]' });
    try {
      // Gru's briefing goes in; the minion delivers; NOBODY touches the API.
      const outcome = await h.dispatch.dispatch({
        jobId: 'pr-651',
        repoPath: h.repo.path,
        title: 'close the loop tonight',
        briefing: 'Deliver the change and end with a completion report containing the PR URL.',
      });
      expect((await outcome.settled).ok).toBe(true);

      // The follow-through completes on its own.
      await vi.waitFor(
        () => {
          const job = h.ledger.getJob('pr-651');
          expect(job?.prUrl).toBe(PR_URL);
          expect(job?.status).toBe('in-review');
        },
        { timeout: 15_000 },
      );
      await Promise.allSettled(h.silasPrompts);

      // Every step is on the record as silas events.
      const events = h.ledger.listJobEvents('pr-651').map((event) => event.kind);
      expect(events).toContain('silas.wake');
      expect(events).toContain('silas.pr-registered');
      expect(events).toContain('silas.review-triggered');
      // The review round exists (requested by the silas-driven call) and
      // the fake wave settles it: the FULL arc runs to a recorded verdict.
      const rounds = h.ledger.listRounds('pr-651');
      expect(rounds).toHaveLength(1);
      expect(rounds[0]?.status).toBe('verdict-posted');
      expect(rounds[0]?.verdict).toBe('approved');
      // The wake prompt taught the session its own ops surface.
      expect(existsSync(outcome.worktree.path)).toBe(true);
      // Driver stops cleanly.
      h.driver.stop();
    } finally {
      await h.close();
    }
  }, 30_000);

  it('first NEEDS CHANGES verdict → fix directive → follow-up delivery → re-review → approved, with no human', async () => {
    let leadRuns = 0;
    const h = await bootFollowThrough({
      fixtureName: 'fixture-app-loop',
      onLeadStart: () => {
        leadRuns += 1;
      },
      // Round 1 finds a blocker; every later round is clean (the fix landed).
      childAnswer: (prompt) => {
        if (leadRuns > 1) return '[]';
        const lens = /"source": "([a-z-]+)"/u.exec(prompt)?.[1] ?? 'blind';
        return JSON.stringify([
          {
            source: lens,
            severity: 'blocker',
            category: 'correctness',
            title: 'deliverable is a stub',
            location: 'src/main.ts',
            evidence: '  return 42;',
            detail: 'The fixture answer still returns the placeholder value.',
            recommended_fix: 'Implement the real answer before this ships.',
          },
        ]);
      },
      // The fix diff removes the flagged line, so the prior finding is
      // revisited as fixed by reviewer judgment.
      priorDisposition: (prior) =>
        prior.map((_entry, index) => ({
          prior_index: index,
          status: 'fixed' as const,
          note: 'the fix turn removed the placeholder return from src/main.ts',
        })),
    });
    try {
      const outcome = await h.dispatch.dispatch({
        jobId: 'pr-651',
        repoPath: h.repo.path,
        title: 'close the fix loop too',
        briefing: 'Deliver the change and end with a completion report containing the PR URL.',
      });
      expect((await outcome.settled).ok).toBe(true);

      // The whole arc completes on its own: round 1 requests changes, the
      // first fix directive lands, the follow-up delivery moves the lane,
      // the re-review runs, and round 2 approves.
      await vi.waitFor(
        () => {
          const rounds = h.ledger.listRounds('pr-651');
          expect(rounds).toHaveLength(2);
          expect(rounds[0]?.verdict).toBe('changes-requested');
          expect(rounds[1]?.verdict).toBe('approved');
        },
        { timeout: 45_000 },
      );
      await Promise.allSettled(h.silasPrompts);

      const rounds = h.ledger.listRounds('pr-651');
      const events = h.ledger.listJobEvents('pr-651');
      // The directive closed round 1's gap and the delivery re-armed review.
      expect(events.map((event) => event.kind)).toContain('silas.directive-sent');
      expect(events.filter((event) => event.kind === 'silas.review-triggered')).toHaveLength(2);
      // Two deliveries: the initial briefing turn and the fix turn.
      const deliveries = events.filter((event) => event.kind === 'job.delivered');
      expect(deliveries).toHaveLength(2);
      const followUp = deliveries[0];
      expect(followUp?.payload).toMatchObject({ source: 'silas-directive' });
      const followUpSha = (followUp?.payload as { sha?: string | null }).sha;
      expect(typeof followUpSha).toBe('string');
      // The freshness predicate's witness: the fix delivery moved the lane
      // past round 1's reviewed target — and round 2 reviewed exactly it.
      expect(followUpSha).not.toBe(rounds[0]?.targetRef);
      expect(rounds[1]?.targetRef).toBe(followUpSha);
      // The directive named the blocker fingerprint the digest computed.
      const directive = events.find((event) => event.kind === 'silas.directive-sent');
      expect((directive?.payload as { blocker_fingerprint?: string }).blocker_fingerprint).toBe(
        'correctness::src/main.ts::deliverable is a stub',
      );
      // The lane ends approved and under review (the human holds the merge).
      expect(h.ledger.getJob('pr-651')?.status).toBe('in-review');
    } finally {
      await h.close();
    }
  }, 60_000);
});
