import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
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
  worktrees: InMemoryWorktreePort;
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
  const worktrees = new InMemoryWorktreePort(mkdtempSync(join(tmpdir(), 'gru-command-waveroot-')));
  const poster = { post: vi.fn(async () => {}) };
  const escalations: { title: string; detail: string }[] = [];
  const wave = new WaveRunner({
    ledger,
    worktrees,
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
    worktrees,
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
  await h.worktrees.createJobWorktree({ repoPath: h.repo.path, jobId: job.id });
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

  it('runs the round on a review lane (no branch, ever) swept when the round completes', async () => {
    const h = harness(async () => done('clean'));
    const jobId = await seedJob(h, false);
    const outcome = await h.wave.runRound({ jobId });
    const reviewRow = h.worktrees.getWorktree(outcome.round.id);
    expect(reviewRow?.kind).toBe('review');
    expect(reviewRow?.branch).toBeNull(); // detached-for-reviews: never a branch
    expect(reviewRow?.status).toBe('swept');
    expect(existsSync(reviewRow!.path)).toBe(false);
  });

  it('refuses to review a job without a registered worktree lane', async () => {
    const h = harness(async () => done('clean'));
    h.ledger.addJob({ id: 'job-orphan', repo: 'fixture-wave', title: 'no lane' });
    await expect(h.wave.runRound({ jobId: 'job-orphan' })).rejects.toThrowError(/no worktree in the registry/);
  });

  it('rejects terminal jobs and aborts the round loudly when setup fails (job restored)', async () => {
    const h = harness(async () => done('clean'));
    const jobId = await seedJob(h, false);
    h.ledger.setJobStatus(jobId, 'in-review');
    h.ledger.setJobStatus(jobId, 'merged');
    await expect(h.wave.runRound({ jobId })).rejects.toThrowError(/terminal lanes/);
    expect(h.ledger.listRounds(jobId)).toHaveLength(0);

    // Setup failure: a stale path already exists exactly where the review
    // worktree would go — the round aborts and the job returns to its
    // lane status instead of being stranded in review.
    const fresh = harness(async () => done('clean'));
    const freshJob = await seedJob(fresh, false);
    mkdirSync(join(fresh.worktrees.root, 'fixture-wave', `review-${freshJob}-r1`), { recursive: true });
    await expect(fresh.wave.runRound({ jobId: freshJob })).rejects.toThrowError(/already exists/);
    const round = fresh.ledger.listRounds(freshJob)[0];
    expect(round?.status).toBe('aborted');
    expect(fresh.ledger.getJob(freshJob)?.status).toBe('working');
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
  it('invokes gh with the parsed PR reference and streams the body via stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-ghdouble-'));
    const script = join(dir, 'gh');
    // A recording double: gh never runs for real in tests.
    writeFileSync(
      script,
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$GH_ARGS_LOG"\ncat > "$GH_BODY_LOG"\n',
    );
    chmodSync(script, 0o755);
    const argsLog = join(dir, 'args.txt');
    const bodyLog = join(dir, 'body.txt');
    const previous = { args: process.env['GH_ARGS_LOG'], body: process.env['GH_BODY_LOG'] };
    process.env['GH_ARGS_LOG'] = argsLog;
    process.env['GH_BODY_LOG'] = bodyLog;
    try {
      const poster = new GhPrPoster(script);
      await poster.post({ prUrl: PR_URL, body: 'Perkins verdict body' });
      expect(readFileSync(argsLog, 'utf-8').trim().split('\n')).toEqual([
        'pr',
        'comment',
        '7',
        '--repo',
        'fixture-owner/fixture-app',
        '--body-file',
        '-',
      ]);
      expect(readFileSync(bodyLog, 'utf-8')).toBe('Perkins verdict body');
    } finally {
      if (previous.args === undefined) delete process.env['GH_ARGS_LOG'];
      else process.env['GH_ARGS_LOG'] = previous.args;
      if (previous.body === undefined) delete process.env['GH_BODY_LOG'];
      else process.env['GH_BODY_LOG'] = previous.body;
    }
  });

  it('parses owner/repo/number and fails loud on garbage URLs', async () => {
    const poster = new GhPrPoster('/nonexistent/gh-binary');
    await expect(poster.post({ prUrl: 'https://x.invalid/a/b/pull/12', body: 'v' })).rejects.toThrowError(
      /unavailable|failed to spawn/,
    );
    const real = new GhPrPoster('gh');
    await expect(real.post({ prUrl: 'not-a-url', body: 'v' })).rejects.toThrowError(/cannot parse/);
  });
});
