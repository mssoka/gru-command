import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WaveRunner, type WaveOutcome } from '../src/dispatch/perkins.js';
import type { FallbackGateOutcome } from '../src/dispatch/perkins.js';
import type { PrHeadProbe } from '../src/dispatch/perkins-review/fresh-head.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { GitReviewPort } from './helpers/git-review-port.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';

const repos: FixtureRepo[] = [];
const dbs: LedgerDb[] = [];
const dirs: string[] = [];
afterEach(() => {
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

function settleLane(ledger: LedgerApi, jobId: string): void {
  ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: 'fixture-settled' } });
}

function localHeadProbe(branch: string): PrHeadProbe {
  return async ({ repoPath }) => ({
    headRefName: branch,
    headSha: execFileSync('git', ['-C', repoPath, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf-8' }).trim(),
  });
}

function attachOrigin(repo: FixtureRepo, branch: string, root: string): void {
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '--bare', '--quiet', origin], { stdio: 'ignore' });
  repo.git(['remote', 'add', 'origin', origin]);
  repo.git(['push', '--quiet', 'origin', `refs/heads/${branch}`]);
}

const IMAGE = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('synthetic-wave-pixels'),
]);

describe('review-input handoff through the real wave freeze', () => {
  it('freezes the amended acceptance, private evidence and exact-target CI, then delivers them', async () => {
    const repo = makeFixtureRepo('review-inputs-wave');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const root = temp('review-inputs-wave-port-');
    const artifacts = temp('review-inputs-wave-artifacts-');
    const uploads = temp('review-inputs-wave-uploads-');
    const db = new LedgerDb(temp('review-inputs-wave-db-'));
    dbs.push(db);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
    const port = new GitReviewPort(root, 'feature/review', target);
    await port.createJobWorktree({ repoPath: repo.path, jobId: 'job-wave' });
    const briefing = 'Goal: ship the label fix.\nAcceptance 1: use the fixed bmad-build entry point.';
    const job = ledger.addJob({ id: 'job-wave', repo: 'fixture', title: 'review inputs', baseBranch: 'main', briefing });
    ledger.setJobStatus(job.id, 'working');
    settleLane(ledger, job.id);
    attachOrigin(repo, 'feature/review', root);
    ledger.setJobPr(job.id, 'https://github.com/acme/fixture/pull/141');
    ledger.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: job.id,
      payload: {
        repo: 'acme/fixture',
        branch: 'gru/job-wave',
        sha: target,
        merged: false,
        pr_open: true,
        mergeable_state: 'clean',
        pr_number: 141,
        pr_url: 'https://github.com/acme/fixture/pull/141',
        ci: {
          sha: target,
          status: 'green',
          signature: '',
          failures: [],
          checks: ['CI'],
          runs: [{ name: 'CI', url: 'https://github.com/acme/fixture/actions/runs/37084763772' }],
        },
      },
    });
    const base = ledger.effectiveContract(job.id)!;
    const added = ledger.addJobAmendment({
      jobId: job.id,
      body: 'Acceptance 1 is superseded: select task-relevant installed skills instead of a fixed entry point.',
      supersedes: ['original:Acceptance 1'],
      approval: { by: 'owner', reference: 'epoch12 seq194760' },
      expectedContractSha256: base.contractSha256,
    });
    expect(added.status).toBe('accepted');
    if (added.status !== 'accepted') throw new Error('unreachable');
    const uploadPath = join(uploads, `${Date.now()}-${randomUUID()}-reference.png`);
    writeFileSync(uploadPath, IMAGE, { mode: 0o600 });
    const fake = fakeWholeSpawner(temp('review-inputs-wave-sessions-'), {
      images: true,
      specialists: ['blind', 'edge'],
      childAnswer: () => '[]',
    });
    const wave = new WaveRunner({
      ledger,
      worktrees: port,
      spawner: fake.spawner,
      reviewArtifactRoot: artifacts,
      evidenceUploadsDir: uploads,
      prHeadProbe: localHeadProbe('feature/review'),
    });
    const begun = await wave.beginRound({
      jobId: job.id,
      evidence: [
        {
          uploadPath,
          purpose: 'owner reference render; NOT rendered at the frozen revision',
          consentRef: 'owner approval j-969',
        },
      ],
    });
    const outcome = asWave(await begun.run);
    const directory = join(artifacts, outcome.round.id);
    const spec = readFileSync(join(directory, 'spec-context.md'), 'utf8');
    expect(spec).toContain(briefing);
    expect(spec).toContain('Acceptance 1 is superseded');
    expect(spec).toContain('approval: owner — epoch12 seq194760');
    expect(spec).toContain('status: EFFECTIVE');
    expect(spec).toContain('state: GREEN (recorded observation)');
    expect(spec).toContain('https://github.com/acme/fixture/actions/runs/37084763772');
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as {
      acceptance: { version: number; baseSha256: string; contractSha256: string; amendmentIds: string[] };
      reviewEvidence: { attachments: Array<{ sha256: string }>; ci: { state: string } };
    };
    expect(manifest.acceptance.version).toBe(1);
    expect(manifest.acceptance.amendmentIds).toEqual([added.amendment.id]);
    expect(manifest.acceptance.contractSha256).toBe(added.contract.contractSha256);
    expect(manifest.acceptance.baseSha256).toBe(base.baseSha256);
    expect(manifest.reviewEvidence.attachments).toHaveLength(1);
    expect(manifest.reviewEvidence.ci.state).toBe('green');
    const lead = fake.leadCalls[0]!;
    expect(lead.images).toHaveLength(1);
    expect(lead.images![0]!.data).toBe(IMAGE.toString('base64'));
    expect(lead.prompt).toContain('Acceptance 1 is superseded');
    expect(lead.prompt).toContain('FROZEN REVIEW EVIDENCE');
    const blind = fake.childCalls.find((call) => call.options.isolatedReview?.systemPrompt.includes('blind Perkins lens child') === true)!;
    expect(blind).toBeDefined();
    expect(blind.images).toBeUndefined();
    expect(blind.prompt).not.toContain('FROZEN REVIEW EVIDENCE');
    const audit = ledger.latestRoundEvent(outcome.round.id, 'round.review-inputs-frozen');
    expect(audit).not.toBeNull();
    const payload = audit!.payload as { acceptance: { version: number }; evidence: unknown[]; ci: { state: string } };
    expect(payload.acceptance.version).toBe(1);
    expect(payload.evidence).toHaveLength(1);
    expect(payload.ci.state).toBe('green');
    await wave.shutdown();
  });
});
