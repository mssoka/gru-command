import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VerificationScheduler,
  type VerificationProgress,
  type VerificationRecord,
} from '../src/verify/scheduler.js';
import { RETAINED_OUTPUT_PER_RUN_MAX_BYTES } from '../src/verify/output-retention.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Retained-output replay (issue #554), scheduler integration. A capture helper
 * whose response headers took longer than its 60 s bound used to give up
 * while the service accepted and completed the run, losing the run's output
 * everywhere but the ledger tail. These tests drive the real scheduler with
 * real child processes: a same-`request_id` re-submit must receive every
 * output frame from byte 0 (while running, and after completion inside the
 * retention window), and when the output is genuinely gone it must say so.
 */

const WINDOW_MS = 30 * 60 * 1000;

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeRepo(): FixtureRepo {
  const repo = makeFixtureRepo('verify-retention-fixture');
  repos.push(repo);
  return repo;
}

interface Harness {
  readonly scheduler: VerificationScheduler;
  readonly records: VerificationRecord[];
  readonly clock: { value: number };
}

function makeScheduler(options: { injectedClock?: boolean } = {}): Harness {
  const storageDir = join(mkdtempSync(join(tmpdir(), 'gru-verify-retention-')), 'verify');
  dirs.push(storageDir);
  const records: VerificationRecord[] = [];
  const clock = { value: 1_000_000 };
  const scheduler = new VerificationScheduler({
    storageDir,
    limits: { maxConcurrent: 2, workerBudget: 4, lockWaitTimeoutMs: 10_000, runTimeoutMs: 60_000 },
    record: (record) => records.push(record),
    sweepIntervalMs: 20,
    ...(options.injectedClock === true ? { now: () => clock.value } : {}),
  });
  scheduler.start();
  return { scheduler, records, clock };
}

function repoSpec(
  repo: FixtureRepo,
  requestId: string,
  command: string,
): Parameters<VerificationScheduler['submit']>[0] {
  return { jobId: 'job-retention', scope: 'full', command, cwd: repo.path, head: repo.head(), requestId };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The sink's reassembled output: every `output` frame's text, in order. */
function outputText(frames: readonly VerificationProgress[]): string {
  return frames.map((frame) => (frame.type === 'output' ? frame.text : '')).join('');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function replayedMarker(frame: VerificationProgress | undefined): unknown {
  return (frame as { readonly replayed_output?: unknown } | undefined)?.replayed_output;
}

describe('retained-output replay (issue #554)', () => {
  it('A2 #554: a same-request_id re-submit while the run is live gets its output from byte 0, then live frames', async () => {
    const repo = makeRepo();
    const { scheduler, records } = makeScheduler();
    const command =
      'node -e "process.stdout.write(\'first\\n\'); setTimeout(() => { process.stdout.write(\'second\\n\'); }, 800)"';
    const spec = repoSpec(repo, 'req-a2-live', command);
    const firstFrames: VerificationProgress[] = [];
    const first = scheduler.submit(spec, (frame) => {
      firstFrames.push(frame);
    });
    // Re-submit only once the run has genuinely streamed its first output:
    // that frame must come back from byte 0 to the reconnecting sink.
    await waitFor(() => firstFrames.some((frame) => frame.type === 'output'));
    const replayFrames: VerificationProgress[] = [];
    const second = scheduler.submit(spec, (frame) => {
      replayFrames.push(frame);
    });
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(secondOutcome.runId).toBe(firstOutcome.runId);
    expect(firstOutcome.ok).toBe(true);

    const attached = replayFrames.find((frame) => frame.type === 'attached');
    expect(attached).toBeDefined();
    expect(replayedMarker(attached)).toBe('complete');
    expect((attached as { readonly state?: unknown }).state).toBe('running');
    const attachedAt = replayFrames.indexOf(attached as VerificationProgress);
    // The retained prefix arrives BEFORE the acknowledgement, the live tail
    // after it: no gap and no duplicate, exactly the run's output.
    const replayedPrefix = outputText(replayFrames.slice(0, attachedAt));
    const liveTail = outputText(replayFrames.slice(attachedAt + 1));
    expect(replayedPrefix).toBe('first\n');
    expect(liveTail).toBe('second\n');
    expect(replayedPrefix + liveTail).toBe('first\nsecond\n');
    expect(Buffer.byteLength(replayedPrefix + liveTail)).toBe(firstOutcome.outputBytes);
    expect(sha256(replayedPrefix + liveTail)).toBe(firstOutcome.outputSha256);
    // One producer, one terminal.
    expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(1);
    expect(replayFrames.filter((frame) => frame.type === 'completed')).toHaveLength(1);
    await scheduler.dispose();
  });

  it('A3 #554: a re-submit after completion inside the window gets the retained output, then the reconciled terminal', async () => {
    const repo = makeRepo();
    const { scheduler, records } = makeScheduler();
    const spec = repoSpec(repo, 'req-a3-window', 'node -e "process.stdout.write(\'kept one\\n\'); process.stdout.write(\'kept two\\n\')"');
    const firstFrames: VerificationProgress[] = [];
    const first = await scheduler.submit(spec, (frame) => {
      firstFrames.push(frame);
    });
    expect(first.ok).toBe(true);
    const runOutput = outputText(firstFrames);
    expect(runOutput).toBe('kept one\nkept two\n');

    const replayFrames: VerificationProgress[] = [];
    const replay = await scheduler.submit(spec, (frame) => {
      replayFrames.push(frame);
    });
    expect(replay.runId).toBe(first.runId);
    const terminal = replayFrames[replayFrames.length - 1];
    expect(terminal?.type).toBe('completed');
    expect((terminal as { readonly reconciled?: unknown }).reconciled).toBe(true);
    expect(replayedMarker(terminal)).toBe('complete');
    const replayedOutput = outputText(replayFrames);
    expect(replayedOutput).toBe(runOutput);
    expect(Buffer.byteLength(replayedOutput)).toBe(first.outputBytes);
    expect(sha256(replayedOutput)).toBe(first.outputSha256);
    // One run, never a rerun under the same identity.
    expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(1);
    expect(records.filter((record) => record.kind === 'verification.completed')).toHaveLength(1);
    expect(records.filter((record) => record.kind === 'verification.reconciled')).toHaveLength(1);
    await scheduler.dispose();
  });

  it('A3 #554: past the 30-minute window the replay is loud — no output frames, replayed_output none', async () => {
    const repo = makeRepo();
    const { scheduler, records, clock } = makeScheduler({ injectedClock: true });
    const spec = repoSpec(repo, 'req-a3-expired', 'node -e "process.stdout.write(\'gone soon\\n\')"');
    const first = await scheduler.submit(spec);
    expect(first.ok).toBe(true);
    clock.value += WINDOW_MS + 1;
    const replayFrames: VerificationProgress[] = [];
    const replay = await scheduler.submit(spec, (frame) => {
      replayFrames.push(frame);
    });
    expect(replay.runId).toBe(first.runId);
    // The recorded outcome is still the run's; only the output is gone, and
    // the terminal says exactly that.
    expect(replayFrames).toHaveLength(1);
    expect(replayFrames[0]?.type).toBe('completed');
    expect((replayFrames[0] as { readonly reconciled?: unknown }).reconciled).toBe(true);
    expect(replayedMarker(replayFrames[0])).toBe('none');
    expect((replayFrames[0] as { readonly outcome?: { readonly outputSha256?: string } }).outcome?.outputSha256).toBe(
      first.outputSha256,
    );
    expect(outputText(replayFrames)).toBe('');
    expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(1);
    await scheduler.dispose();
  });

  it('A3 #554: past the per-run 8 MiB cap the replay keeps the retained prefix and says incomplete', async () => {
    const repo = makeRepo();
    const { scheduler } = makeScheduler();
    const spec = repoSpec(repo, 'req-a3-capped', 'node -e "process.stdout.write(\'x\'.repeat(9 * 1024 * 1024))"');
    const first = await scheduler.submit(spec);
    expect(first.ok).toBe(true);
    expect(first.outputBytes).toBe(9 * 1024 * 1024);
    const replayFrames: VerificationProgress[] = [];
    const replay = await scheduler.submit(spec, (frame) => {
      replayFrames.push(frame);
    });
    expect(replay.runId).toBe(first.runId);
    const terminal = replayFrames[replayFrames.length - 1];
    expect(terminal?.type).toBe('completed');
    expect(replayedMarker(terminal)).toBe('incomplete');
    const replayedOutput = outputText(replayFrames);
    expect(replayedOutput.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(replayedOutput)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(replayedOutput.length).toBeLessThan(first.outputBytes);
    expect(sha256(replayedOutput)).not.toBe(first.outputSha256);
    await scheduler.dispose();
  });

  it('A3 #554: the 64 MiB total cap evicts the oldest completed output first', async () => {
    const repo = makeRepo();
    const { scheduler } = makeScheduler();
    const runIds: string[] = [];
    // Nine runs of > 8 MiB retain exactly 8 MiB each: the ninth pushes the
    // total past 64 MiB and must evict the oldest, never a newer run.
    for (let index = 0; index < 9; index += 1) {
      const outcome = await scheduler.submit(
        repoSpec(repo, `req-a3-total-${String(index)}`, 'node -e "process.stdout.write(\'y\'.repeat(9 * 1024 * 1024))"'),
      );
      expect(outcome.ok).toBe(true);
      runIds.push(outcome.runId);
    }
    const oldest = runIds[0] as string;
    const kept = runIds[runIds.length - 1] as string;
    const oldestFrames: VerificationProgress[] = [];
    const oldestReplay = await scheduler.submit(
      repoSpec(repo, 'req-a3-total-0', 'node -e "process.stdout.write(\'y\'.repeat(9 * 1024 * 1024))"'),
      (frame) => {
        oldestFrames.push(frame);
      },
    );
    expect(oldestReplay.runId).toBe(oldest);
    expect(replayedMarker(oldestFrames[oldestFrames.length - 1])).toBe('none');
    expect(outputText(oldestFrames)).toBe('');
    const keptFrames: VerificationProgress[] = [];
    const keptReplay = await scheduler.submit(
      repoSpec(repo, 'req-a3-total-8', 'node -e "process.stdout.write(\'y\'.repeat(9 * 1024 * 1024))"'),
      (frame) => {
        keptFrames.push(frame);
      },
    );
    expect(keptReplay.runId).toBe(kept);
    expect(replayedMarker(keptFrames[keptFrames.length - 1])).toBe('incomplete');
    // The cap is enforced at a FRAME boundary, and a frame is whatever the OS
    // pipe handed the runner (at most `OUTPUT_FRAME_MAX_BYTES`), so the retained
    // prefix ends within one frame below the cap. Asserting an exact 8 MiB here
    // made this test depend on chunking: it passes on an idle host and fails on
    // a loaded CI runner by exactly one frame.
    const keptBytes = Buffer.byteLength(outputText(keptFrames));
    expect(keptBytes).toBeLessThanOrEqual(RETAINED_OUTPUT_PER_RUN_MAX_BYTES);
    expect(RETAINED_OUTPUT_PER_RUN_MAX_BYTES - keptBytes).toBeLessThanOrEqual(8 * 1024);
    await scheduler.dispose();
  });

  it('#554: a different request_id attacher is unchanged — no replay and no replay marker', async () => {
    const repo = makeRepo();
    const { scheduler } = makeScheduler();
    const command = 'node -e "setTimeout(() => process.stdout.write(\'shared\\n\'), 800)"';
    const primary = scheduler.submit(repoSpec(repo, 'req-different-a', command));
    const differentFrames: VerificationProgress[] = [];
    const different = scheduler.submit(
      { jobId: 'job-retention', scope: 'full', command, cwd: repo.path, head: repo.head(), requestId: 'req-different-b' },
      (frame) => {
        differentFrames.push(frame);
      },
    );
    await waitFor(() => differentFrames.some((frame) => frame.type === 'attached'));
    const [firstOutcome, secondOutcome] = await Promise.all([primary, different]);
    expect(secondOutcome.runId).toBe(firstOutcome.runId);
    expect(differentFrames[0]?.type).toBe('attached');
    expect(replayedMarker(differentFrames[0])).toBeUndefined();
    // A different identity starts at attach time: today's partial capture,
    // never a replayed prefix; output streamed after the attach is live.
    const attachedAt = differentFrames.indexOf(differentFrames[0] as VerificationProgress);
    expect(outputText(differentFrames.slice(0, attachedAt))).toBe('');
    expect(outputText(differentFrames.slice(attachedAt + 1))).toBe('shared\n');
    await scheduler.dispose();
  });

  it('#554: the ledger output hash is the hash of the frames a capture reassembles (stdout/stderr interleave)', async () => {
    const repo = makeRepo();
    const { scheduler } = makeScheduler();
    // A chunk larger than one 8 KiB frame on stdout overlaps a stderr write
    // while a slow sink is still draining the first frame. The ledger hash
    // must follow the FRAME order a capture reassembles, not emit-call order.
    const command =
      'node -e "process.stdout.write(\'s\'.repeat(20 * 1024)); setTimeout(() => process.stderr.write(\'err\\n\'), 20)"';
    const frames: VerificationProgress[] = [];
    const outcome = await scheduler.submit(repoSpec(repo, 'req-interleave', command), async (frame) => {
      frames.push(frame);
      if (frame.type === 'output') await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(outcome.ok).toBe(true);
    const reassembled = outputText(frames);
    expect(reassembled).toContain('err\n');
    expect(Buffer.byteLength(reassembled)).toBe(outcome.outputBytes);
    expect(sha256(reassembled)).toBe(outcome.outputSha256);
    await scheduler.dispose();
  });
});
