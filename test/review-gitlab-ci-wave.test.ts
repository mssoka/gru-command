import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaveRunner, type FallbackGateOutcome, type WaveOutcome } from '../src/dispatch/perkins.js';
import { compatibleReviewIdentity, freezeReviewInputs } from '../src/dispatch/perkins-review/artifacts.js';
import type { PrHeadProbe } from '../src/dispatch/perkins-review/fresh-head.js';
import type { RepoRemote } from '../src/dispatch/review-path.js';
import { appendCiEvidence, renderRecordedCiEvidence } from '../src/review-inputs/ci-evidence.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { GitReviewPort } from './helpers/git-review-port.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';

/**
 * A GitLab merge-request job's frozen CI evidence through the real round
 * freeze (#519): the host reads the MR's head pipeline once, right before
 * the freeze, records one `gitlab.*` event, and binds only that event. The
 * GitLab endpoint is a `fetch` double; everything else (git, ledger, freeze,
 * admission preflight, artifacts) is the production path.
 */

const HOST = 'gitlab.example.test';
const PROJECT = 'acme/platform/app';
const IID = 7;
const MR_URL = `https://${HOST}/${PROJECT}/-/merge_requests/${IID}`;
const TOKEN = 'glpat-SENTINEL-wave-4d2b9c7a1e';
const BRANCH = 'feature/review';
const PIPELINE_ID = 4242;
const PIPELINE_URL = `https://${HOST}/${PROJECT}/-/pipelines/${PIPELINE_ID}`;

const repos: FixtureRepo[] = [];
const dbs: LedgerDb[] = [];
const dirs: string[] = [];
const saved = { GITLAB_TOKEN: process.env['GITLAB_TOKEN'], GL_TOKEN: process.env['GL_TOKEN'] };

beforeEach(() => {
  process.env['GITLAB_TOKEN'] = TOKEN;
  delete process.env['GL_TOKEN'];
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (dbs.length > 0) dbs.pop()!.close();
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function asWave(outcome: WaveOutcome | FallbackGateOutcome): WaveOutcome {
  if ('route' in outcome) throw new Error(`expected a Perkins wave outcome, got ${outcome.route}`);
  return outcome;
}

function localHeadProbe(branch: string): PrHeadProbe {
  return async ({ repoPath }) => ({
    headRefName: branch,
    headSha: execFileSync('git', ['-C', repoPath, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf-8' }).trim(),
  });
}

interface Call { readonly url: string; readonly init: RequestInit | undefined }

interface World {
  readonly repo: FixtureRepo;
  readonly ledger: LedgerApi;
  readonly port: GitReviewPort;
  readonly artifacts: string;
  readonly wave: WaveRunner;
  readonly calls: Call[];
  readonly logs: string[];
  readonly escalations: string[];
  /** What the GitLab double answers; replace per case. */
  answer: (call: Call) => Response | Promise<Response>;
  /** The lane's origin remote, as git would report it. */
  origin: RepoRemote | null;
  /** The branch tip the next round freezes. */
  target: string;
  jobs: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The MR the double reports for the world's current branch tip. */
function mrBody(world: World, overrides: Record<string, unknown> = {}, pipeline: Record<string, unknown> | null = {}): Record<string, unknown> {
  return {
    iid: IID,
    state: 'opened',
    sha: world.target,
    web_url: MR_URL,
    head_pipeline: pipeline === null
      ? null
      : { id: PIPELINE_ID, sha: world.target, status: 'success', source: 'merge_request_event', web_url: PIPELINE_URL, ...pipeline },
    ...overrides,
  };
}

async function makeWorld(): Promise<World> {
  const repo = makeFixtureRepo('review-gitlab-ci-wave');
  repos.push(repo);
  repo.git(['checkout', '-b', BRANCH]);
  const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
  const root = temp('review-gitlab-ci-port-');
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '--bare', '--quiet', origin], { stdio: 'ignore' });
  repo.git(['remote', 'add', 'origin', origin]);
  repo.git(['push', '--quiet', 'origin', `refs/heads/${BRANCH}`]);
  const db = new LedgerDb(temp('review-gitlab-ci-db-'));
  dbs.push(db);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  const port = new GitReviewPort(root, BRANCH, target, ledger);
  const artifacts = temp('review-gitlab-ci-artifacts-');
  const fake = fakeWholeSpawner(temp('review-gitlab-ci-sessions-'), {
    images: false,
    specialists: ['blind', 'edge'],
    childAnswer: () => '[]',
  });
  const calls: Call[] = [];
  const logs: string[] = [];
  const escalations: string[] = [];
  const world: World = {
    repo, ledger, port, artifacts, calls, logs, escalations, target, jobs: 0,
    origin: { host: HOST, owner: 'acme/platform', repo: 'app' },
    answer: () => json(mrBody(world)),
    wave: new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fake.spawner,
      reviewArtifactRoot: artifacts,
      prHeadProbe: localHeadProbe(BRANCH),
      reconcileReviewAgent: async () => true,
      repoOrigin: () => world.origin,
      gitlabMrFetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const call = { url: String(input), init };
        calls.push(call);
        return world.answer(call);
      }) as typeof fetch,
      log: (level, msg, fields) => logs.push(JSON.stringify({ level, msg, fields })),
      escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    }),
  };
  return world;
}

/** Push a new commit so the next round freezes a different head. */
function advance(world: World): string {
  world.target = world.repo.commitFile(`src/more-${world.jobs}-${Date.now()}.ts`, 'export const more = 1;\n');
  world.repo.git(['push', '--quiet', 'origin', `refs/heads/${BRANCH}`]);
  return world.target;
}

interface FrozenCase {
  readonly jobId: string;
  readonly roundId: string;
  readonly spec: string;
  /** The CI block of the frozen spec, markers included. */
  readonly block: string;
  readonly ci: Record<string, unknown>;
  /** This job's gitlab.* events, oldest first. */
  readonly gitlabEvents: ReturnType<LedgerApi['listEvents']>;
  readonly outcome: WaveOutcome;
}

/** A fresh working job on the world's branch with the given PR link. */
async function prepareJob(world: World, prUrl: string | null, jobId = `job-${++world.jobs}`): Promise<string> {
  const job = world.ledger.addJob({ id: jobId, repo: 'fixture', title: 'gitlab ci evidence', baseBranch: 'main', briefing: 'Goal: ship it.' });
  world.ledger.setJobStatus(job.id, 'working');
  world.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: { sha: 'fixture-settled' } });
  if (prUrl !== null) world.ledger.setJobPr(job.id, prUrl);
  await world.port.createJobWorktree({ repoPath: world.repo.path, jobId: job.id });
  return job.id;
}

/** A fresh job on the world's branch with the given PR link, one round, frozen. */
async function freezeJob(world: World, prUrl: string | null, jobId?: string): Promise<FrozenCase> {
  return roundFor(world, await prepareJob(world, prUrl, jobId));
}

async function roundFor(world: World, jobId: string): Promise<FrozenCase> {
  const begun = await world.wave.beginRound({ jobId });
  const outcome = asWave(await begun.run);
  const directory = join(world.artifacts, outcome.round.id);
  const spec = readFileSync(join(directory, 'spec-context.md'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
    reviewEvidence: { ci: Record<string, unknown> };
  };
  const start = spec.indexOf('--- HOST-RECORDED CI EVIDENCE');
  const end = spec.indexOf('--- END HOST-RECORDED CI EVIDENCE ---', start);
  expect(start, 'the frozen spec carries a CI block').toBeGreaterThanOrEqual(0);
  return {
    jobId,
    roundId: outcome.round.id,
    spec,
    block: spec.slice(start, end + '--- END HOST-RECORDED CI EVIDENCE ---'.length),
    ci: manifest.reviewEvidence.ci,
    // listEvents answers newest first; the cases below read oldest first.
    gitlabEvents: world.ledger.listEvents({ limit: 1000 })
      .filter((event) => event.jobId === jobId && event.kind.startsWith('gitlab.'))
      .sort((left, right) => left.seq - right.seq),
    outcome,
  };
}

async function until(condition: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const reasonLine = (block: string): string | undefined => block.split('\n').find((line) => line.startsWith('reason: '));
const stateLine = (block: string): string | undefined => block.split('\n').find((line) => line.startsWith('state: '));

describe('GitLab merge request CI evidence through the round freeze', () => {
  it('A1: freezes a green record for an opened MR whose success pipeline ran on the exact head', async () => {
    const world = await makeWorld();
    const frozen = await freezeJob(world, MR_URL);
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]!.url).toBe(`https://${HOST}/api/v4/projects/acme%2Fplatform%2Fapp/merge_requests/${IID}`);
    expect(frozen.gitlabEvents).toHaveLength(1);
    const read = frozen.gitlabEvents[0]!;
    expect(read.kind).toBe('gitlab.mr-observed');
    expect(read.roundId).toBe(frozen.roundId);
    expect(frozen.ci).toEqual({
      state: 'green',
      repo: `${HOST}/${PROJECT}`,
      pr: IID,
      sha: world.target,
      observedAt: read.ts,
      sourceKind: 'gitlab.mr-observed',
      sourceSeq: read.seq,
      checks: [{ name: `pipeline #${PIPELINE_ID} (merge_request_event)`, url: PIPELINE_URL }],
      failures: [],
      reason: null,
    });
    expect(stateLine(frozen.block)).toBe('state: GREEN (recorded observation)');
    expect(frozen.block).toContain(`binding: repo=${HOST}/${PROJECT} pr=${IID} sha=${world.target} (matches the frozen review target)`);
    expect(frozen.block).toContain(`  - pipeline #${PIPELINE_ID} (merge_request_event) (${PIPELINE_URL})`);
    expect(frozen.block).toContain("source: gitlab.mr-observed (the host's read of this round;");
    expect(frozen.block).not.toContain(read.ts);
    expect(frozen.block).not.toContain(`seq ${read.seq}`);
    expect(frozen.spec).not.toContain('no PR URL was resolvable');
    // The frozen manifest passes the admission shape validator: the round
    // was admitted with a passing ci-evidence check, not refused.
    const preflight = world.ledger.latestRoundEvent(frozen.roundId, 'round.admission-preflight');
    const payload = preflight?.payload as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(payload.ok).toBe(true);
    expect(payload.checks.find((check) => check.name === 'ci-evidence')).toMatchObject({ ok: true });
    const audit = world.ledger.latestRoundEvent(frozen.roundId, 'round.review-inputs-frozen');
    expect((audit?.payload as { ci: { state: string } }).ci.state).toBe('green');
    await world.wave.shutdown();
  });

  it('A1: records the read before the freeze and names the MR and round in the event payload', async () => {
    const world = await makeWorld();
    world.answer = () => json(mrBody(world, {}, { status: 'running' }));
    const frozen = await freezeJob(world, MR_URL);
    expect(frozen.gitlabEvents[0]!.payload).toEqual({
      host: HOST, project: PROJECT, mr_iid: IID, state: 'opened', head_sha: world.target,
      head_pipeline: { id: PIPELINE_ID, sha: world.target, status: 'running', source: 'merge_request_event', web_url: PIPELINE_URL },
      round_id: frozen.roundId,
    });
    expect(frozen.ci).toMatchObject({ state: 'pending', failures: [], reason: null });
    expect(stateLine(frozen.block)).toBe('state: PENDING — NOT PASS');
    await world.wave.shutdown();
  });

  it('A2: a failed pipeline freezes a failed record whose failure conclusion is the pipeline status', async () => {
    const world = await makeWorld();
    world.answer = () => json(mrBody(world, {}, { status: 'canceled' }));
    const frozen = await freezeJob(world, MR_URL);
    expect(frozen.ci).toMatchObject({
      state: 'failed',
      repo: `${HOST}/${PROJECT}`,
      pr: IID,
      sha: world.target,
      checks: [],
      failures: [{ name: `pipeline #${PIPELINE_ID} (merge_request_event)`, url: PIPELINE_URL, conclusion: 'canceled' }],
      reason: null,
    });
    expect(stateLine(frozen.block)).toBe('state: FAILED — NOT PASS');
    await world.wave.shutdown();
  });

  it('A3: takes the identity from the response, so another project or iid in the answer is NOT-MATCHED', async () => {
    const world = await makeWorld();
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>, Record<string, unknown>]> = [
      ['another project', { web_url: `https://${HOST}/acme/platform/renamed-app/-/merge_requests/${IID}` },
        { repo: `${HOST}/acme/platform/renamed-app`, pr: IID }],
      ['another iid', { iid: 8, web_url: `https://${HOST}/${PROJECT}/-/merge_requests/8` }, { repo: `${HOST}/${PROJECT}`, pr: 8 }],
      ['another head', { sha: 'e'.repeat(40) }, { repo: `${HOST}/${PROJECT}`, pr: IID, sha: 'e'.repeat(40) }],
    ];
    for (const [label, overrides, observed] of cases) {
      world.answer = () => json(mrBody(world, overrides, overrides['sha'] === undefined ? {} : { sha: overrides['sha'] }));
      const frozen = await freezeJob(world, MR_URL);
      expect(frozen.ci, label).toMatchObject({
        state: 'not-matched', sha: world.target, ...observed, checks: [], failures: [],
        sourceKind: 'gitlab.mr-observed',
      });
      expect(stateLine(frozen.block), label).toBe('state: NOT-MATCHED — NO BOUND CI RECEIPT');
      expect(frozen.block, label).not.toContain('GREEN');
    }
    await world.wave.shutdown();
  });

  it('A4: a merged merge request, or one with no head pipeline, freezes UNAVAILABLE', async () => {
    const world = await makeWorld();
    world.answer = () => json(mrBody(world, { state: 'merged' }));
    const merged = await freezeJob(world, MR_URL);
    expect(merged.ci).toMatchObject({ state: 'unavailable', repo: null, pr: null, sha: null, reason: 'the merge request is merged, not opened' });
    expect(reasonLine(merged.block)).toBe('reason: the merge request is merged, not opened');
    world.answer = () => json(mrBody(world, {}, null));
    const bare = await freezeJob(world, MR_URL);
    expect(bare.ci).toMatchObject({ state: 'unavailable', reason: 'the merge request has no head pipeline' });
    await world.wave.shutdown();
  });

  /** One round whose read fails: UNAVAILABLE naming the kind, one failed-read event. */
  async function expectFailedRead(kind: string, answer: () => Response | Promise<Response>): Promise<void> {
    const world = await makeWorld();
    world.answer = answer;
    const frozen = await freezeJob(world, MR_URL);
    expect(world.calls).toHaveLength(1);
    expect(frozen.gitlabEvents).toHaveLength(1);
    expect(frozen.gitlabEvents[0]!.kind).toBe('gitlab.mr-read-failed');
    expect(frozen.gitlabEvents[0]!.payload).toMatchObject({
      host: HOST, project: PROJECT, mr_iid: IID, error_kind: kind, round_id: frozen.roundId,
    });
    expect(frozen.ci).toMatchObject({
      state: 'unavailable', repo: null, pr: null, sha: null, sourceKind: 'gitlab.mr-read-failed',
      sourceSeq: frozen.gitlabEvents[0]!.seq, checks: [], failures: [],
      reason: expect.stringContaining(`error_kind: ${kind}`),
    });
    expect(reasonLine(frozen.block)).toContain(`error_kind: ${kind}`);
    expect(stateLine(frozen.block)).toBe('state: UNAVAILABLE — NO BOUND CI RECEIPT');
    await world.wave.shutdown();
  }

  it('A5: a 401 freezes UNAVAILABLE naming error_kind auth', async () => {
    await expectFailedRead('auth', () => new Response('{"message":"401 Unauthorized"}', { status: 401 }));
  });

  it('A5: a 403 freezes UNAVAILABLE naming error_kind permission', async () => {
    await expectFailedRead('permission', () => new Response('{"message":"403 Forbidden"}', { status: 403 }));
  });

  it('A5: a 404 freezes UNAVAILABLE naming error_kind not-found', async () => {
    await expectFailedRead('not-found', () => new Response('{"message":"404 Not found"}', { status: 404 }));
  });

  it('A5: a 429 freezes UNAVAILABLE naming error_kind rate-limit', async () => {
    await expectFailedRead('rate-limit', () => new Response('Retry later', { status: 429 }));
  });

  it('A5: a rejection named TimeoutError freezes UNAVAILABLE naming error_kind timeout', async () => {
    await expectFailedRead('timeout', () => { throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }); });
  });

  it('A5: a 503 freezes UNAVAILABLE naming error_kind other', async () => {
    await expectFailedRead('other', () => new Response('unavailable', { status: 503 }));
  });

  it('A5: a non-timeout rejection freezes UNAVAILABLE naming error_kind other', async () => {
    await expectFailedRead('other', () => { throw new TypeError('fetch failed'); });
  });

  it('A5: a malformed body freezes UNAVAILABLE naming error_kind other', async () => {
    await expectFailedRead('other', () => new Response('<html>not json</html>', { status: 200 }));
  });

  it('A5: a missing token freezes UNAVAILABLE (token-missing) and makes no request', async () => {
    const world = await makeWorld();
    delete process.env['GITLAB_TOKEN'];
    delete process.env['GL_TOKEN'];
    const frozen = await freezeJob(world, MR_URL);
    expect(world.calls).toHaveLength(0);
    expect(frozen.gitlabEvents).toHaveLength(1);
    expect(frozen.gitlabEvents[0]!.kind).toBe('gitlab.mr-read-failed');
    expect(frozen.gitlabEvents[0]!.payload).toMatchObject({ host: HOST, project: PROJECT, mr_iid: IID, error_kind: 'token-missing' });
    expect(frozen.ci).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('error_kind: token-missing') });
    expect(reasonLine(frozen.block)).toContain('error_kind: token-missing');
    await world.wave.shutdown();
  });

  it('A6: an earlier green observation is never used when this round\'s read fails', async () => {
    const world = await makeWorld();
    const job = world.ledger.addJob({ id: 'job-earlier', repo: 'fixture', title: 'earlier green', baseBranch: 'main', briefing: 'Goal: ship it.' });
    world.ledger.setJobStatus(job.id, 'working');
    world.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: { sha: 'fixture-settled' } });
    world.ledger.setJobPr(job.id, MR_URL);
    const earlier = world.ledger.appendCustomEvent({
      kind: 'gitlab.mr-observed',
      jobId: job.id,
      roundId: 'an-earlier-round',
      payload: {
        host: HOST, project: PROJECT, mr_iid: IID, state: 'opened', head_sha: world.target,
        head_pipeline: { id: PIPELINE_ID, sha: world.target, status: 'success', source: 'push', web_url: PIPELINE_URL },
        round_id: 'an-earlier-round',
      },
    });
    await world.port.createJobWorktree({ repoPath: world.repo.path, jobId: job.id });
    world.answer = () => new Response('{"message":"401 Unauthorized"}', { status: 401 });
    const frozen = await roundFor(world, job.id);
    expect(frozen.ci).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('error_kind: auth') });
    expect(frozen.ci['sourceSeq']).not.toBe(earlier.seq);
    expect(frozen.block).not.toContain('GREEN');
    expect(frozen.gitlabEvents.map((event) => event.kind)).toEqual(['gitlab.mr-observed', 'gitlab.mr-read-failed']);
    await world.wave.shutdown();
  });

  it('A7: makes one request and records one gitlab event per frozen round, and a second round reads again', async () => {
    const world = await makeWorld();
    const first = await freezeJob(world, MR_URL, 'job-two-rounds');
    expect(world.calls).toHaveLength(1);
    expect(first.gitlabEvents).toHaveLength(1);
    const secondHead = advance(world);
    world.answer = () => json(mrBody(world, {}, { status: 'failed' }));
    const second = await roundFor(world, 'job-two-rounds');
    expect(second.outcome.round.id).not.toBe(first.roundId);
    expect(world.calls).toHaveLength(2);
    expect(second.gitlabEvents).toHaveLength(2);
    const [firstEvent, secondEvent] = second.gitlabEvents;
    expect(firstEvent!.roundId).toBe(first.roundId);
    expect(secondEvent!.roundId).toBe(second.roundId);
    expect(secondEvent!.seq).toBeGreaterThan(firstEvent!.seq);
    // Each round froze its own read: the first stays green on its own head.
    expect(first.ci).toMatchObject({ state: 'green', sourceSeq: firstEvent!.seq });
    expect(second.ci).toMatchObject({ state: 'failed', sha: secondHead, sourceSeq: secondEvent!.seq });
    await world.wave.shutdown();
  });

  it('A7: a second job at the same head with an unchanged pipeline freezes the same spec bytes; only the read provenance differs', async () => {
    const world = await makeWorld();
    const first = await freezeJob(world, MR_URL, 'job-reread-1');
    const second = await freezeJob(world, MR_URL, 'job-reread-2');
    expect(world.calls).toHaveLength(2);
    expect(first.ci['state']).toBe('green');
    expect(second.spec).toBe(first.spec);
    expect(second.ci['sourceSeq']).not.toBe(first.ci['sourceSeq']);
    expect(second.ci['observedAt']).not.toBeNull();
    const { observedAt: _firstAt, sourceSeq: _firstSeq, ...firstFacts } = first.ci;
    const { observedAt: _secondAt, sourceSeq: _secondSeq, ...secondFacts } = second.ci;
    expect(secondFacts).toEqual(firstFacts);
    await world.wave.shutdown();
  });

  it('recovery: specialist work stays reusable across a same-head re-read, and is not reused when the pipeline changed', async () => {
    const world = await makeWorld();
    const root = temp('review-gitlab-ci-identity-');
    const recoveryIdentity = {
      jobId: 'job-identity', policySha256: 'a'.repeat(64), runtimeId: 'pi', runtimeVersion: 'runtime-fixture-v1',
      modelRef: 'fixture-model-v1', modelRole: 'perkins', modelSettingsSha256: 'model-settings-fixture-v1',
    };
    const freeze = (roundId: string, status: string, seq: number, ts: string) => {
      const event = {
        seq, ts, kind: 'gitlab.mr-observed', agentId: null, jobId: 'job-identity', roundId, lens: null,
        payload: {
          host: HOST, project: PROJECT, mr_iid: IID, state: 'opened', head_sha: world.target,
          head_pipeline: { id: PIPELINE_ID, sha: world.target, status, source: 'push', web_url: PIPELINE_URL },
          round_id: roundId,
        },
      };
      const ci = renderRecordedCiEvidence({
        events: { branchState: null, ciGreen: null, ciFailed: null },
        targetSha: world.target, expectedRepo: null, expectedPr: null,
        gitlabMr: { host: HOST, project: PROJECT, iid: IID, event },
      });
      return freezeReviewInputs({
        roundId, repoPath: world.repo.path, artifactRoot: root, baseRef: 'main', targetRef: world.target,
        spec: appendCiEvidence({ spec: 'review', block: ci.block, maxBytes: 1_000_000 }),
        recoveryIdentity, ciEvidence: ci.record,
      });
    };
    const prior = freeze('prior', 'success', 11, '2026-10-29T10:00:00.000Z');
    const reread = freeze('reread', 'success', 57, '2026-10-29T10:30:00.000Z');
    expect(reread.manifest.reviewEvidence?.ci).toMatchObject({ sourceSeq: 57, observedAt: '2026-10-29T10:30:00.000Z' });
    expect(reread.manifest.specSha256).toBe(prior.manifest.specSha256);
    expect(compatibleReviewIdentity(reread, prior.directory)).toBe(true);
    const changed = freeze('changed', 'failed', 90, '2026-10-29T11:00:00.000Z');
    expect(compatibleReviewIdentity(changed, prior.directory)).toBe(false);
    // A GitHub record is compared whole, as before: its time and seq are the poll's event.
    const github = (roundId: string, seq: number) => freezeReviewInputs({
      roundId, repoPath: world.repo.path, artifactRoot: root, baseRef: 'main', targetRef: world.target, spec: 'review', recoveryIdentity,
      ciEvidence: {
        state: 'green', repo: 'acme/fixture', pr: 141, sha: world.target, observedAt: '2026-10-29T10:00:00.000Z',
        sourceKind: 'github.ci-green', sourceSeq: seq, checks: [{ name: 'CI', url: null }], failures: [], reason: null,
      },
    });
    const githubPrior = github('github-prior', 5);
    expect(compatibleReviewIdentity(github('github-same', 5), githubPrior.directory)).toBe(true);
    expect(compatibleReviewIdentity(github('github-reobserved', 6), githubPrior.directory)).toBe(false);
    await world.wave.shutdown();
  });

  it('A7: a round refused at a freeze guard makes no request and records no event', async () => {
    const world = await makeWorld();
    const jobId = await prepareJob(world, MR_URL);
    // The lane turns terminal while the review worktree is being created: the
    // freeze-time guard refuses, and that must happen before any read.
    const original = world.port.createReviewWorktree.bind(world.port);
    const created = vi.spyOn(world.port, 'createReviewWorktree').mockImplementation(async (input) => {
      const lane = await original(input);
      world.ledger.setJobStatus(jobId, 'binned');
      return lane;
    });
    await expect(world.wave.beginRound({ jobId })).rejects.toThrow(/terminal lanes do not go back under review/u);
    expect(created).toHaveBeenCalledTimes(1);
    expect(world.calls).toHaveLength(0);
    expect(world.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind.startsWith('gitlab.'))).toEqual([]);
    expect(world.ledger.latestJobEvent(jobId, 'round.review-inputs-frozen')).toBeNull();
    await world.wave.shutdown();
  });

  it('a shutdown while the merge request is being read freezes nothing and records the cancelled read', async () => {
    const world = await makeWorld();
    let entered = false;
    world.answer = (call) => new Promise<Response>((_resolve, reject) => {
      entered = true;
      const signal = call.init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const jobId = await prepareJob(world, MR_URL);
    const settled = world.wave.beginRound({ jobId }).then(() => 'started' as const, (error: unknown) => error);
    await until(() => entered);
    await world.wave.shutdown();
    const outcome = await settled;
    expect(String(outcome)).toMatch(/shut down during review setup|shutting down/u);
    // The cancelled read is still the round's one read: one other failure, no frozen inputs.
    const events = world.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind.startsWith('gitlab.'));
    expect(events.map((event) => event.kind)).toEqual(['gitlab.mr-read-failed']);
    expect(events[0]!.payload).toMatchObject({ error_kind: 'other', mr_iid: IID });
    expect(world.ledger.latestJobEvent(jobId, 'round.review-inputs-frozen')).toBeNull();
    expect(world.escalations).toEqual([]);
  });

  it('A3: a merged-results pipeline at the freeze is NOT-MATCHED, naming it, and never binds', async () => {
    const world = await makeWorld();
    world.answer = () => json(mrBody(world, {}, { sha: 'f'.repeat(40), status: 'success' }));
    const frozen = await freezeJob(world, MR_URL);
    expect(frozen.ci).toMatchObject({
      state: 'not-matched', repo: `${HOST}/${PROJECT}`, pr: IID, sha: world.target, checks: [], failures: [],
      reason: expect.stringContaining('merged-results'),
    });
    expect(stateLine(frozen.block)).toBe('state: NOT-MATCHED — NO BOUND CI RECEIPT');
    expect(frozen.block).not.toContain('GREEN');
    await world.wave.shutdown();
  });

  it('origin: a link to another project than the lane\'s origin makes no request and binds nothing', async () => {
    const world = await makeWorld();
    world.origin = { host: HOST, owner: 'acme/platform', repo: 'a-different-project' };
    const frozen = await freezeJob(world, MR_URL);
    expect(world.calls).toHaveLength(0);
    expect(frozen.gitlabEvents).toHaveLength(1);
    expect(frozen.gitlabEvents[0]!.kind).toBe('gitlab.mr-read-failed');
    expect(frozen.gitlabEvents[0]!.payload).toMatchObject({
      host: HOST, project: PROJECT, mr_iid: IID, error_kind: 'other', detail: expect.stringContaining('not this lane\'s origin'),
    });
    expect(frozen.ci).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('error_kind: other') });
    expect(frozen.block).not.toContain('GREEN');
    await world.wave.shutdown();
  });

  it('origin: an explicitly pinned round on a link to a foreign gitlab host sends no token anywhere', async () => {
    const world = await makeWorld();
    const jobId = await prepareJob(world, 'https://gitlab.attacker.test/acme/platform/app/-/merge_requests/7');
    const begun = await world.wave.beginRound({ jobId, targetRef: world.target });
    const outcome = asWave(await begun.run);
    expect(world.calls).toHaveLength(0);
    const events = world.ledger.listEvents({ limit: 1000 }).filter((event) => event.jobId === jobId && event.kind.startsWith('gitlab.'));
    expect(events.map((event) => event.kind)).toEqual(['gitlab.mr-read-failed']);
    expect(events[0]!.payload).toMatchObject({ host: 'gitlab.attacker.test', error_kind: 'other' });
    const manifest = JSON.parse(readFileSync(join(world.artifacts, outcome.round.id, 'manifest.json'), 'utf8')) as {
      reviewEvidence: { ci: { state: string } };
    };
    expect(manifest.reviewEvidence.ci.state).toBe('unavailable');
    await world.wave.shutdown();
  });

  it('origin: a lane with no resolvable origin makes no request', async () => {
    const world = await makeWorld();
    world.origin = null;
    const frozen = await freezeJob(world, MR_URL);
    expect(world.calls).toHaveLength(0);
    expect(frozen.gitlabEvents[0]!.payload).toMatchObject({ error_kind: 'other', detail: expect.stringContaining('no resolvable origin remote') });
    expect(frozen.ci).toMatchObject({ state: 'unavailable' });
    await world.wave.shutdown();
  });

  it('A8: a GitLab merge request job never renders the no-PR-URL reason', async () => {
    const world = await makeWorld();
    for (const answer of [
      () => json(mrBody(world)),
      () => new Response('', { status: 500 }),
    ]) {
      world.answer = answer;
      const frozen = await freezeJob(world, MR_URL);
      expect(frozen.spec).not.toContain('no PR URL was resolvable');
      expect(frozen.spec).not.toContain('cannot be repository-bound');
    }
    await world.wave.shutdown();
  });

  it('A8: a GitLab-shaped link on a host the service rejects renders the unsupported-host reason', async () => {
    const world = await makeWorld();
    const frozen = await freezeJob(world, 'https://git.example.test/acme/app/-/merge_requests/3');
    expect(frozen.ci).toMatchObject({
      state: 'unavailable', repo: null, observedAt: null, sourceKind: null, sourceSeq: null,
      reason: 'PR link is a GitLab merge request on an unsupported host',
    });
    expect(reasonLine(frozen.block)).toBe('reason: PR link is a GitLab merge request on an unsupported host');
    expect(frozen.spec).not.toContain('no PR URL was resolvable');
    await world.wave.shutdown();
  });

  it('A8: every other unparseable or absent link keeps the existing no-PR-URL reason', async () => {
    const world = await makeWorld();
    for (const link of [null, 'https://github.com/acme/fixture/pull/not-a-number', 'https://example.test/just/a/page', 'not a url']) {
      const frozen = await freezeJob(world, link);
      expect(frozen.ci, String(link)).toMatchObject({
        state: 'unavailable', reason: 'no PR URL was resolvable for the job; a CI receipt cannot be repository-bound',
      });
      expect(reasonLine(frozen.block), String(link)).toContain('no PR URL was resolvable');
    }
    await world.wave.shutdown();
  });

  it('A9: a GitHub PR job, a job with no link and a rejected host make no request and record no gitlab event', async () => {
    const world = await makeWorld();
    const cases = [
      ['a GitHub PR job', 'https://github.com/acme/fixture/pull/141'],
      ['a job with no link', null],
      ['a GitLab-shaped link on a rejected host', 'https://git.example.test/acme/app/-/merge_requests/3'],
      ['a lookalike GitLab host', 'https://evil.gitlab.attacker.test/acme/app/-/merge_requests/3'],
    ] as const;
    for (const [label, link] of cases) {
      const frozen = await freezeJob(world, link);
      expect(world.calls, label).toHaveLength(0);
      expect(frozen.gitlabEvents, label).toHaveLength(0);
    }
    expect(world.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind.startsWith('gitlab.'))).toEqual([]);
    await world.wave.shutdown();
  });

  it('A9: a GitHub PR job keeps binding its github.* events exactly as before', async () => {
    const world = await makeWorld();
    const job = world.ledger.addJob({ id: 'job-github', repo: 'fixture', title: 'github', baseBranch: 'main', briefing: 'Goal: ship it.' });
    world.ledger.setJobStatus(job.id, 'working');
    world.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: { sha: 'fixture-settled' } });
    world.ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/141');
    world.ledger.appendCustomEvent({
      kind: 'github.ci-green',
      jobId: job.id,
      payload: { repo: 'acme/fixture', branch: 'gru/job-github', pr: 141, sha: world.target, checks: ['CI'] },
    });
    await world.port.createJobWorktree({ repoPath: world.repo.path, jobId: job.id });
    const frozen = await roundFor(world, job.id);
    expect(frozen.ci).toMatchObject({ state: 'green', repo: 'acme/fixture', pr: 141, sourceKind: 'github.ci-green' });
    expect(world.calls).toHaveLength(0);
    await world.wave.shutdown();
  });

  it('A10: a token echoed in a 500 body and in a rejection message reaches no event, log, block, manifest or thrown error', async () => {
    const world = await makeWorld();
    const echoes = [
      () => new Response(`internal error: PRIVATE-TOKEN ${TOKEN} was rejected`, { status: 500 }),
      () => { throw new TypeError(`connect failed while sending ${TOKEN}`); },
    ];
    const frozen: FrozenCase[] = [];
    const thrown: string[] = [];
    for (const answer of echoes) {
      world.answer = answer;
      try {
        frozen.push(await freezeJob(world, MR_URL));
      } catch (error) {
        thrown.push(error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error));
      }
    }
    expect(thrown).toEqual([]);
    expect(frozen).toHaveLength(2);
    const everything = [
      JSON.stringify(world.ledger.listEvents({ limit: 5000 })),
      world.logs.join('\n'),
      ...frozen.flatMap((entry) => [
        entry.spec, entry.block, JSON.stringify(entry.ci), JSON.stringify(entry.outcome.round),
        readFileSync(join(world.artifacts, entry.roundId, 'manifest.json'), 'utf8'),
      ]),
    ].join('\n');
    expect(everything).not.toContain(TOKEN);
    await world.wave.shutdown();
  });

  it('A10: the recorded detail of a failed read replaces the token with a placeholder and stays within 300 characters', async () => {
    const world = await makeWorld();
    const echoes = [
      () => new Response(`internal error: PRIVATE-TOKEN ${TOKEN} was rejected ${'x'.repeat(2000)}`, { status: 500 }),
      () => { throw new TypeError(`connect failed while sending ${TOKEN}`); },
    ];
    const frozen: FrozenCase[] = [];
    for (const answer of echoes) {
      world.answer = answer;
      frozen.push(await freezeJob(world, MR_URL));
    }
    expect(world.calls).toHaveLength(2);
    expect(frozen.map((entry) => entry.gitlabEvents[0]!.kind)).toEqual(['gitlab.mr-read-failed', 'gitlab.mr-read-failed']);
    for (const entry of frozen) {
      const detail = String((entry.gitlabEvents[0]!.payload as { detail: unknown }).detail);
      expect(detail).toContain('[redacted]');
      expect(detail).not.toContain(TOKEN);
      expect(detail.length).toBeLessThanOrEqual(300);
    }
    expect(world.logs.some((line) => line.includes('GitLab merge request read failed') && line.includes('[redacted]'))).toBe(true);
    await world.wave.shutdown();
  });
});
