import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPathFor, loadConfig } from '../src/config.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { PiRuntime } from '../src/runtime/pi-adapter.js';
import { SessionStore } from '../src/sessions/store.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import {
  makeStubModelRuntime,
  StubScript,
  type StubCall,
  type StubImage,
  type StubTurn,
} from './helpers/stub-model.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Perkins default lens driver (EPICS E8 story 3, production path): spawn
 * a REAL pi session per lens rooted in the review worktree, prompt it,
 * and read the structured verdict out of the session jsonl. The stub
 * model routes by lens prompt, so this exercises the whole driver
 * without a network — including the prompt-echo hazard (the protocol
 * text lives in the same session file as the answer).
 */

/** Routes the stub model's turn by the lens named in the prompt. */
class RoutedLensScript extends StubScript {
  constructor(private readonly route: (prompt: string) => StubTurn) {
    super([]);
  }

  override next(prompt: string, images: StubImage[] = []): StubTurn {
    this.calls.push({ prompt, imageCount: images.length, images } as StubCall);
    return this.route(prompt);
  }
}

function verdictFor(prompt: string, verdict: string, lens: string): StubTurn {
  return prompt.includes(`lens "${lens}"`)
    ? { deltas: [`reviewing as ${lens}… `, `LENS-VERDICT: ${verdict}`] }
    : { deltas: ['reviewing… ', 'LENS-VERDICT: clean'] };
}

interface DriverHarness {
  ledger: LedgerApi;
  repo: FixtureRepo;
  manager: WorktreeManager;
  runtime: PiRuntime;
  store: SessionStore;
  wave: WaveRunner;
  poster: { post: ReturnType<typeof vi.fn> };
  escalations: { title: string; detail: string }[];
  cleanup(): Promise<void>;
}

async function makeDriverHarness(script: StubScript): Promise<DriverHarness> {
  const home = mkdtempSync(join(tmpdir(), 'gru-command-driver-'));
  const workspace = mkdtempSync(join(tmpdir(), 'gru-command-driverws-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-driveragent-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    configPathFor(home),
    `workspace_root = "${workspace}"\n[models]\ndefault = "gru-stub/stub-model"\n`,
    'utf-8',
  );
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const store = new SessionStore(config.dataDir);
  const runtime = new PiRuntime({
    config,
    store,
    agentDir,
    modelRuntime: await makeStubModelRuntime(script),
  });
  const repo = makeFixtureRepo('fixture-driver');
  const ledgerDb = new LedgerDb(mkdtempSync(join(tmpdir(), 'gru-command-driverdata-')));
  const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
  const manager = new WorktreeManager({
    ledger,
    root: mkdtempSync(join(tmpdir(), 'gru-command-driverroot-')),
    preserveRoot: mkdtempSync(join(tmpdir(), 'gru-command-driverpreserve-')),
    setupTimeoutMs: 30_000,
  });
  const poster = { post: vi.fn(async () => {}) };
  const escalations: { title: string; detail: string }[] = [];
  const wave = new WaveRunner({
    ledger,
    manager,
    spawner: (role, options) => runtime.spawn(role, options ?? {}),
    poster,
    escalate: (title, detail) => escalations.push({ title, detail }),
    // NO driveLens override — the production driver under test.
  });
  return {
    ledger,
    repo,
    manager,
    runtime,
    store,
    wave,
    poster,
    escalations,
    async cleanup() {
      await runtime.dispose();
      store.dispose();
      ledgerDb.close();
      repo.cleanup();
    },
  };
}

const cleanups: DriverHarness[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!.cleanup();
});

const PR_URL = 'https://git.example.invalid/fixture-owner/fixture-driver/pull/4';

async function seed(h: DriverHarness): Promise<string> {
  const job = h.ledger.addJob({
    id: 'job-driver',
    repo: 'fixture-driver',
    title: 'driver round',
    briefing: 'review the stub change',
  });
  h.ledger.setJobStatus(job.id, 'working');
  h.ledger.setJobPr(job.id, PR_URL); // posting is gated on the lane's PR link
  await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId: job.id });
  return job.id;
}

describe('Perkins default driver over real pi sessions (stub model)', () => {
  it('spawns a real session per lens and consolidates verdicts read from the session jsonl', async () => {
    const h = await makeDriverHarness(new RoutedLensScript((prompt) => verdictFor(prompt, 'warning', 'edge')));
    cleanups.push(h);
    const jobId = await seed(h);
    const outcome = await h.wave.runRound({ jobId });

    // edge's warning came OUT OF ITS SESSION FILE — changes-requested.
    expect(outcome.verdict).toBe('changes-requested');
    expect(outcome.posted).toBe(true);
    const round = h.ledger.getRound(outcome.round.id);
    expect(round?.lenses).toHaveLength(7);
    for (const chip of round?.lenses ?? []) {
      expect(chip.state).toBe('done');
    }
    expect(round?.lenses.find((chip) => chip.lens === 'edge')?.note).toBe('warning');
    // Every other lens parsed 'clean' — the protocol text echoed in the
    // same session file (the prompt) did NOT forge a verdict.
    for (const chip of round?.lenses ?? []) {
      if (chip.lens !== 'edge') expect(chip.note).toBe('clean');
    }
    expect(h.poster.post).toHaveBeenCalledTimes(1);
    const body = h.poster.post.mock.calls[0]?.[0]?.body as string;
    expect(body).toContain('- edge: warning');
    // The review worktree was released after the round.
    expect(h.ledger.getWorktree(outcome.round.id)?.status).toBe('swept');
  });

  it('turns a lens that concludes without the protocol line into an error chip → verdict withheld', async () => {
    const h = await makeDriverHarness(
      new RoutedLensScript((prompt) =>
        prompt.includes('lens "security"')
          ? { deltas: ['I looked around but found nothing worth a line.'] }
          : { deltas: ['reviewing… ', 'LENS-VERDICT: clean'] },
      ),
    );
    cleanups.push(h);
    const jobId = await seed(h);
    const outcome = await h.wave.runRound({ jobId });

    expect(outcome.verdict).toBeNull();
    expect(outcome.posted).toBe(false);
    expect(h.poster.post).not.toHaveBeenCalled();
    const round = h.ledger.getRound(outcome.round.id);
    expect(round?.status).toBe('live'); // inconclusive is not a verdict
    expect(round?.lenses.find((chip) => chip.lens === 'security')?.state).toBe('error');
    expect(h.escalations.some((entry) => entry.title.includes('could not conclude'))).toBe(true);
  });
});
