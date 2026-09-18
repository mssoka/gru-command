import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import {
  consolidateVerdict,
  GhPrPoster,
  LENS_VERDICT_PROTOCOL,
  verdictFromSessionFile,
  WaveRunner,
  type LensResult,
  type VerdictPoster,
} from '../src/dispatch/perkins.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Perkins wave runner (EPICS E8 story 3): lens fleet lifecycle, per-lens
 * chips, verdict consolidation, comment-verdict posting via gh (seam).
 */

const PR_URL = 'https://git.example.invalid/fixture-owner/fixture-app/pull/7';

function done(verdict: LensResult extends never ? never : 'blocker' | 'warning' | 'note' | 'clean'): LensResult {
  return { state: 'done', verdict };
}

interface WaveHarness {
  ledger: LedgerApi;
  repo: FixtureRepo;
  manager: WorktreeManager;
  wave: WaveRunner;
  poster: { post: ReturnType<typeof vi.fn> };
  escalations: { title: string; detail: string }[];
  cleanup(): void;
}

function makeWaveHarness(results: (lens: string) => Promise<LensResult>): WaveHarness {
  const repo = makeFixtureRepo('fixture-wave');
  const dataDir = mkdtempSync(join(tmpdir(), 'gru-command-wavedata-'));
  const ledgerDb = new LedgerDb(dataDir);
  const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
  const manager = new WorktreeManager({
    ledger,
    root: mkdtempSync(join(tmpdir(), 'gru-command-waveroot-')),
    preserveRoot: mkdtempSync(join(tmpdir(), 'gru-command-wavepreserve-')),
    setupTimeoutMs: 30_000,
  });
  const poster = { post: vi.fn(async () => {}) };
  const escalations: { title: string; detail: string }[] = [];
  const wave = new WaveRunner({
    ledger,
    manager,
    spawner: async () => {
      throw new Error('the injectable driver replaces spawning in this suite');
    },
    poster: poster as unknown as VerdictPoster,
    escalate: (title, detail) => escalations.push({ title, detail }),
    driveLens: async (ctx) => results(ctx.lens),
  });
  const h: WaveHarness = {
    ledger,
    repo,
    manager,
    wave,
    poster,
    escalations,
    cleanup(): void {
      ledgerDb.close();
      repo.cleanup();
    },
  };
  return h;
}

const cleanups: WaveHarness[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!.cleanup();
});

function harness(results: (lens: string) => Promise<LensResult>): WaveHarness {
  const h = makeWaveHarness(results);
  cleanups.push(h);
  return h;
}

async function seedJob(h: WaveHarness, withPr: boolean): Promise<string> {
  const job = h.ledger.addJob({
    id: 'job-wave',
    repo: 'fixture-wave',
    title: 'ship the widget',
    briefing: 'make the widget ship',
  });
  h.ledger.setJobStatus(job.id, 'working');
  await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: job.id });
  if (withPr) h.ledger.setJobPr(job.id, PR_URL);
  return job.id;
}

describe('verdict consolidation policy (honest arithmetic)', () => {
  it('any blocker → changes-requested', () => {
    expect(consolidateVerdict([done('clean'), done('note'), done('blocker')])).toBe('changes-requested');
  });
  it('any warning → changes-requested', () => {
    expect(consolidateVerdict([done('clean'), done('warning'), done('clean')])).toBe('changes-requested');
  });
  it('only notes/clean → approved', () => {
    expect(consolidateVerdict([done('clean'), done('note'), done('clean')])).toBe('approved');
  });
  it('a lens that could not conclude → null (escalate, never soften)', () => {
    expect(consolidateVerdict([done('clean'), { state: 'error', note: 'x' }, done('clean')])).toBeNull();
    expect(consolidateVerdict([done('clean'), null, done('clean')])).toBeNull();
  });
});

describe('wave lifecycle', () => {
  it('runs a full round: chips pending→done, verdict recorded and posted', async () => {
    const h = harness(async (lens) => done(lens === 'edge' ? 'warning' : 'clean'));
    const jobId = await seedJob(h, true);
    const outcome = await h.wave.runRound({ jobId });
    expect(outcome.verdict).toBe('changes-requested');
    expect(outcome.posted).toBe(true);

    const round = h.ledger.getRound(outcome.round.id);
    expect(round?.status).toBe('verdict-posted');
    expect(round?.verdict).toBe('changes-requested');
    // Every lens chip resolved with its verdict on the record.
    expect(round?.lenses).toHaveLength(7);
    for (const chip of round?.lenses ?? []) {
      expect(chip.state).toBe('done');
      if (chip.lens === 'edge') expect(chip.note).toBe('warning');
    }
    // Job moved to in-review; the comment went to the PR with the round id.
    expect(h.ledger.getJob(jobId)?.status).toBe('in-review');
    expect(h.poster.post).toHaveBeenCalledTimes(1);
    const body = h.poster.post.mock.calls[0]?.[0]?.body as string;
    expect(body).toContain('verdict: changes-requested');
    expect(body).toContain('- edge: warning');
  });

  it('withholds the verdict when a lens errors — escalation, no post, round stays live', async () => {
    const h = harness(async (lens) =>
      lens === 'security' ? { state: 'error', note: 'could not conclude' } : done('clean'),
    );
    const jobId = await seedJob(h, true);
    const outcome = await h.wave.runRound({ jobId });
    expect(outcome.verdict).toBeNull();
    expect(outcome.posted).toBe(false);
    expect(h.poster.post).not.toHaveBeenCalled();
    const round = h.ledger.getRound(outcome.round.id);
    expect(round?.status).toBe('live'); // inconclusive, not papered over
    expect(round?.lenses.find((chip) => chip.lens === 'security')?.state).toBe('error');
    expect(h.escalations).toHaveLength(1);
    expect(h.escalations[0]?.title).toMatch(/could not conclude/);
  });

  it('records the verdict in the ledger even when the PR post fails (fail-loud escalation)', async () => {
    const h = harness(async () => done('clean'));
    h.poster.post.mockRejectedValueOnce(new Error('gh unavailable'));
    const jobId = await seedJob(h, true);
    const outcome = await h.wave.runRound({ jobId });
    expect(outcome.verdict).toBe('approved');
    expect(outcome.posted).toBe(false);
    // Record of record stands; the failure escalated.
    expect(h.ledger.getRound(outcome.round.id)?.verdict).toBe('approved');
    expect(h.escalations[0]?.title).toMatch(/NOT to the pull request/);
    expect(h.ledger.listEvents({ limit: 100 }).some((e) => e.kind === 'round.post-failed')).toBe(true);
  });

  it('skips posting when the job has no PR link, but still records the verdict', async () => {
    const h = harness(async () => done('clean'));
    const jobId = await seedJob(h, false);
    const outcome = await h.wave.runRound({ jobId });
    expect(outcome.verdict).toBe('approved');
    expect(outcome.posted).toBe(false);
    expect(h.poster.post).not.toHaveBeenCalled();
    expect(h.escalations).toHaveLength(0);
  });

  it('runs the round against a DETACHED review worktree, swept when the round completes', async () => {
    const heads: string[] = [];
    const h = harness(async () => done('clean'));
    // Capture the review tree's HEAD ref while the fleet is live.
    const wave = new WaveRunner({
      ledger: h.ledger,
      manager: h.manager,
      spawner: async () => {
        throw new Error('driver replaces spawning');
      },
      driveLens: async (ctx) => {
        heads.push(h.repo.git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.worktreePath));
        return done('clean');
      },
    });
    h.wave = wave;
    const jobId = await seedJob(h, false);
    const outcome = await wave.runRound({ jobId });
    // Detached while live: HEAD, never a branch.
    expect(heads).toHaveLength(7);
    expect(new Set(heads)).toEqual(new Set(['HEAD']));
    // The round's worktree row survives as the record; the tree is gone.
    const reviewRow = h.ledger.getWorktree(outcome.round.id);
    expect(reviewRow?.kind).toBe('review');
    expect(reviewRow?.branch).toBeNull();
    expect(reviewRow?.status).toBe('swept');
    expect(existsSync(reviewRow!.path)).toBe(false);
  });

  it('refuses to review a job without a registered worktree lane', async () => {
    const h = harness(async () => done('clean'));
    h.ledger.addJob({ id: 'job-orphan', repo: 'fixture-wave', title: 'no lane' });
    await expect(h.wave.runRound({ jobId: 'job-orphan' })).rejects.toThrowError(/no worktree in the registry/);
  });
});

describe('verdict extraction from lens sessions', () => {
  it('takes the LAST LENS-VERDICT line from a session file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gru-command-lens-')), 'session.jsonl');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, JSON.stringify({ role: 'assistant', text: 'first take LENS-VERDICT: note' }) + '\n');
    appendFileSync(file, JSON.stringify({ role: 'assistant', text: 'on reflection LENS-VERDICT: blocker' }) + '\n');
    expect(verdictFromSessionFile(file)).toBe('blocker');
  });

  it('null when the protocol line is absent (an inconclusive lens)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gru-command-lens-')), 'session.jsonl');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(file, JSON.stringify({ role: 'assistant', text: 'looks fine to me' }) + '\n');
    expect(verdictFromSessionFile(file)).toBeNull();
  });

  it('cannot be forged by the prompt echo: the protocol text names a placeholder, not a verdict word', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'gru-command-lens-')), 'session.jsonl');
    const { appendFileSync } = await import('node:fs');
    // The user turn carries the protocol instruction VERBATIM (the prompt
    // lives in the session jsonl too) — it must not read as a verdict.
    appendFileSync(
      file,
      JSON.stringify({ role: 'user', text: `Review lens "edge". ${LENS_VERDICT_PROTOCOL}` }) + '\n',
    );
    expect(verdictFromSessionFile(file)).toBeNull();
    appendFileSync(file, JSON.stringify({ role: 'assistant', text: 'done — LENS-VERDICT: note' }) + '\n');
    expect(verdictFromSessionFile(file)).toBe('note');
  });
});

describe('gh poster seam', () => {
  it('parses owner/repo/number and fails loud on garbage URLs', async () => {
    const poster = new GhPrPoster('/nonexistent/gh-binary');
    await expect(poster.post({ prUrl: 'https://x.invalid/a/b/pull/12', body: 'v' })).rejects.toThrowError(
      /unavailable|failed to spawn/,
    );
    const real = new GhPrPoster('gh');
    await expect(real.post({ prUrl: 'not-a-url', body: 'v' })).rejects.toThrowError(/cannot parse/);
  });
});
