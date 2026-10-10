import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { PersistedReviewPort } from './helpers/persisted-review-port.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';
import { createHash } from 'node:crypto';

/** The enacted provider state a fixture publisher reports for the intent the
 * host hands it. An intent-less call (a base-era poster) keeps the historical
 * COMMENTED shape, so the overlay stays compilable against the old build. */
const ENACTED_REVIEW_STATE: Record<string, string> = {
  APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED',
};
const enactedFor = (event: string | undefined): string => ENACTED_REVIEW_STATE[event ?? 'COMMENT'] ?? 'COMMENTED';

/**
 * DISPOSABLE CRASH CHILD (R19): spawned by
 * `perkins-builtin-wave.test.ts` with PERKINS_CRASH_CHILD pointing at a
 * JSON payload the parent owns. This file runs a REAL WaveRunner round to
 * the exact boundary between the persisted `round.posted` event and the
 * verdict write, then SIGKILLS ITSELF — the finally-sweep can never run,
 * so the surviving on-disk state is genuine crash-time state. In the
 * normal suite this describe is skipped (no env payload).
 */
interface CrashChildPayload {
  readonly repoPath: string;
  readonly branch: string;
  readonly target: string;
  readonly dbPath: string;
  readonly portRoot: string;
  readonly artifacts: string;
  readonly sessions: string;
  readonly markerPath: string;
  readonly prUrl: string;
  readonly crashPhase?: 'checkpoint';
}

const payloadPath = process.env['PERKINS_CRASH_CHILD'];

describe.skipIf(payloadPath === undefined)('perkins crash child (R19)', () => {
  it('dies between publication and verdict', async () => {
    if (payloadPath === undefined) throw new Error('child payload missing');
    const spec = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(payloadPath, 'utf8'))) as CrashChildPayload;

    class CrashBeforeVerdictLedger extends LedgerApi {
      override setRoundVerdict(id: string, verdict: string): ReturnType<LedgerApi['setRoundVerdict']> {
        // Durable handoff first, then a true process death: no throw, no
        // finally, no sweep — exactly what a crash between the persisted
        // posted event and the verdict write leaves behind.
        writeFileSync(spec.markerPath, `${JSON.stringify({ roundId: id, verdict })}\n`, 'utf8');
        process.kill(process.pid, 'SIGKILL');
        return super.setRoundVerdict(id, verdict);
      }
    }

    const db = new LedgerDb(spec.dbPath);
    const ledger = new CrashBeforeVerdictLedger(db.handle, { bus: new EventBus() });
    const port = new PersistedReviewPort(spec.portRoot, spec.branch, spec.target);
    await port.createJobWorktree({ repoPath: spec.repoPath, jobId: 'job-p3-crash' });
    const job = ledger.addJob({ id: 'job-p3-crash', repo: 'fixture', title: 'crash child', baseBranch: 'main', briefing: 'review' });
    ledger.setJobStatus(job.id, 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: { sha: 'fixture-settled' } });
    ledger.setJobPr(job.id, spec.prUrl);
    const wave = new WaveRunner({
      ledger, worktrees: port,
      ...(spec.crashPhase === 'checkpoint' ? {
        reviewRuntimeIdentity: () => ({ id: 'pi', version: 'test-runtime-v1' }),
        reviewPreflight: async () => ({ ok: true as const, failures: [],
          reviewModel: { role: 'perkins' as const, modelRef: 'fixture-model-v1', settings: {}, authEnv: {}, routingSha256: "fixture-safe-route" } }),
      } : {}),
      spawner: fakeWholeSpawner(spec.sessions, {
        childAnswer: () => '[]', specialists: spec.crashPhase === 'checkpoint' ? ['blind', 'edge'] : [],
        ...(spec.crashPhase === 'checkpoint' ? { beforeSubmit: () => {
          const round = ledger.listRounds(job.id).at(-1)!;
          writeFileSync(spec.markerPath, `${JSON.stringify({ roundId: round.id, phase: 'checkpoint' })}\n`, 'utf8');
          process.kill(process.pid, 'SIGKILL');
        } } : {}),
      }).spawner,
      poster: {
        post: async (call: { readonly body: string; readonly targetSha: string; readonly reviewEvent?: string }) => ({
          reviewId: '9001', actor: 'gru-bot', event: enactedFor(call.reviewEvent), commitId: call.targetSha,
          headSha: call.targetSha, baseSha: 'b'.repeat(40),
          bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex'),
        }),
      },
      reviewArtifactRoot: spec.artifacts,
      prHeadProbe: async () => ({ headRefName: spec.branch, headSha: spec.target }),
    });
    await wave.runRound({ jobId: job.id });
    // Unreachable when the crash fires; present so a silent no-crash run
    // fails the child (and therefore the parent) loudly.
    throw new Error('crash child completed without crashing — the boundary kill never fired');
  });
});
