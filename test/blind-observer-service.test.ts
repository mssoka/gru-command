import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { admitBlindReview, recordBlindAdmission, BLIND_ACCESS_EVENT } from '../src/dispatch/blind-review.js';
import { pickFreePort, startRealService } from './helpers/real-service.mjs';

/**
 * The production startup observer assembly (issue #339 F3): the real
 * `dist/main.js` installs `supervisorLive.setObserveBlindTurn(observeBlindTurn)`
 * at boot. A preload double captures that PRODUCTION installation and drives a
 * recovered turn whose prompt appends a prohibited read; the installed observer
 * must record the invalidation on the real ledger. Deleting the main.ts
 * installation leaves the supervisor's observer null, no event lands, and this
 * test fails — the component test alone cannot see that.
 */

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('compiled service: the production blind observer is installed at startup (issue #339 F3)', () => {
  it('a recovered turn invalidates blind coverage through the real main.ts assembly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-blind-observer-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-blind-observer-ws-'));
    const sessionDir = mkdtempSync(join(tmpdir(), 'gru-blind-observer-session-'));
    cleanup.push(home, workspace, sessionDir);
    const jobId = 'job-blind-startup';
    const agentId = 'minion-blind-startup';
    const targetSha = 'f'.repeat(40);
    const sessionFile = join(sessionDir, 'reviewer.jsonl');
    // The session STARTS clean; the recovered double appends its prohibited
    // read during delivery.
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    // Seed the durable ledger BEFORE boot: a blind-review job, its implementer
    // agent, and the admission the shared observer judges access against.
    const db = new LedgerDb(home);
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: jobId, repo: 'fixture', title: 'blind review' });
      ledger.setJobStatus(jobId, 'working');
      ledger.registerAgent({ id: agentId, role: 'minion', jobId, sessionFile });
      const admission = admitBlindReview({
        ledger,
        jobId,
        title: 'review (blind)',
        deliverable: 'review',
        briefing: 'Review the immutable package read-only.',
        targetSha,
        repoName: 'fixture',
        inputPackage: { baseSha: 'a'.repeat(40), targetSha, files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }] },
      });
      if (admission === null) throw new Error('the job was not admitted as a blind review');
      recordBlindAdmission(ledger, jobId, admission);
    } finally {
      db.close();
    }
    const trigger = join(workspace, 'trigger.json');
    const result = join(workspace, 'result.json');
    const service = await startRealService({
      port: await pickFreePort(),
      token: 'blind-observer-token',
      home,
      workspace,
      requireWebDist: false,
      nodeImport: join(import.meta.dirname, 'helpers', 'blind-observer-preload.mjs'),
      extraEnv: { GRU_BLIND_TRIGGER: trigger, GRU_BLIND_RESULT: result },
    });
    try {
      // The test does NOT install the observer: the preload captured the
      // production main.ts installation and drives the recovered turn.
      writeFileSync(trigger, JSON.stringify({ jobId, agentId, sessionFile }), 'utf-8');
      await vi.waitFor(() => {
        expect(JSON.parse(readFileSync(result, 'utf-8'))).toMatchObject({ installed: true, observed: true });
      }, { timeout: 15_000, interval: 100 });
      await vi.waitFor(() => {
        const read = new DatabaseSync(join(home, 'ledger', 'ledger.db'), { readOnly: true });
        try {
          const rows = read.prepare('SELECT payload FROM events WHERE kind = ? AND job_id = ?').all(BLIND_ACCESS_EVENT, jobId) as { payload: string }[];
          expect(rows).toHaveLength(1);
          const payload = JSON.parse(rows[0]!.payload) as { prohibited?: readonly unknown[] };
          expect(payload.prohibited?.length).toBeGreaterThanOrEqual(1);
        } finally {
          read.close();
        }
      }, { timeout: 15_000, interval: 200 });
    } finally {
      await service.stop();
    }
  }, 90_000);

  it('a directive HTTP continuation invalidates blind coverage through the real main-to-server assembly (issue #339 G2)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-blind-http-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-blind-http-ws-'));
    const sessionDir = mkdtempSync(join(tmpdir(), 'gru-blind-http-session-'));
    cleanup.push(home, workspace, sessionDir);
    const jobId = 'job-blind-http';
    const agentId = 'minion-blind-http';
    const targetSha = 'f'.repeat(40);
    const sessionFile = join(sessionDir, 'reviewer.jsonl');
    // The session STARTS clean; the runtime fixture appends its prohibited
    // read when the production directive route prompts the seeded minion.
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const db = new LedgerDb(home);
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: jobId, repo: 'fixture', title: 'blind review' });
      ledger.setJobStatus(jobId, 'working');
      ledger.registerAgent({ id: agentId, role: 'minion', jobId, sessionFile });
      const admission = admitBlindReview({
        ledger,
        jobId,
        title: 'review (blind)',
        deliverable: 'review',
        briefing: 'Review the immutable package read-only.',
        targetSha,
        repoName: 'fixture',
        inputPackage: { baseSha: 'a'.repeat(40), targetSha, files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }] },
      });
      if (admission === null) throw new Error('the job was not admitted as a blind review');
      recordBlindAdmission(ledger, jobId, admission);
    } finally {
      db.close();
    }
    const token = 'blind-http-token';
    const service = await startRealService({
      port: await pickFreePort(),
      token,
      home,
      workspace,
      requireWebDist: false,
      // The runtime fixture only supplies a scripted minion handle; the test
      // never injects the observer and never calls the scanner.
      nodeImport: join(import.meta.dirname, 'helpers', 'blind-http-directive-preload.mjs'),
      extraEnv: { GRU_BLIND_HTTP_MINION_ID: agentId, GRU_BLIND_HTTP_SESSION_FILE: sessionFile },
    });
    try {
      const res = await fetch(`${service.baseUrl}/api/silas/directive`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: jobId, directive: 'continue the blind review' }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { request_id?: string };
      expect(typeof body.request_id).toBe('string');
      // The observer is supplied ONLY by main.ts's createDispatchServer port.
      await vi.waitFor(() => {
        const read = new DatabaseSync(join(home, 'ledger', 'ledger.db'), { readOnly: true });
        try {
          const rows = read.prepare('SELECT payload FROM events WHERE kind = ? AND job_id = ?').all(BLIND_ACCESS_EVENT, jobId) as { payload: string }[];
          expect(rows).toHaveLength(1);
          const payload = JSON.parse(rows[0]!.payload) as { prohibited?: readonly unknown[] };
          expect(payload.prohibited?.length).toBeGreaterThanOrEqual(1);
        } finally {
          read.close();
        }
      }, { timeout: 20_000, interval: 200 });
    } finally {
      await service.stop();
    }
  }, 120_000);
});
