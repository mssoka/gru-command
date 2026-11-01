import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { admitNativeDirectiveFixture } from './helpers/directive-native-fixture.js';
import { pickFreePort, startRealService } from './helpers/real-service.mjs';

/**
 * Issue #547 through the REAL composition: an agent row a previous service
 * process left `spawning` or `streaming` has no process and no registry
 * handle, yet every live-work fence counted it as an open worker turn and
 * nothing ever cleared it. The booted service settles each such row once:
 * the row leaves the live states (`error`), an `agent.state` event names
 * `host-absent at boot`, and the orphan notice makes the turn visible.
 * Removing main's boot call leaves the rows `streaming` and this fails.
 */

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

interface AgentRow { readonly id: string; readonly state: string }
interface EventRow { readonly agent_id: string | null; readonly kind: string; readonly payload: string }
interface NoticeRow { readonly kind: string; readonly routing: string; readonly severity: string; readonly agent_id: string | null }

/** Read the booted service's ledger without writing to it. */
function readLedger<T>(home: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(home, 'ledger', 'ledger.db'), { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function agentRows(home: string, jobId: string): readonly AgentRow[] {
  return readLedger(home, (db) => db.prepare('SELECT id, state FROM agents WHERE job_id = ? ORDER BY id').all(jobId) as unknown as AgentRow[]);
}

function agentEvents(home: string, agentId: string, kind: string): readonly unknown[] {
  return readLedger(home, (db) => (db.prepare('SELECT agent_id, kind, payload FROM events WHERE agent_id = ? AND kind = ? ORDER BY seq').all(agentId, kind) as unknown as EventRow[])
    .map((event) => JSON.parse(event.payload) as unknown));
}

function orphanNotices(home: string, agentId: string): readonly NoticeRow[] {
  return readLedger(home, (db) => db.prepare('SELECT kind, routing, severity, agent_id FROM notifications WHERE kind = ? AND resolved_at IS NULL')
    .all(`supervision.turn-orphaned.${agentId}`) as unknown as NoticeRow[]);
}

function seedHome(prefix: string, seed: (ledger: LedgerApi, home: string) => void): { readonly home: string; readonly workspace: string } {
  const home = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  const workspace = mkdtempSync(join(tmpdir(), `${prefix}-workspace-`));
  cleanup.push(home, workspace);
  const db = new LedgerDb(home);
  try {
    seed(new LedgerApi(db.handle, { bus: new EventBus() }), home);
  } finally {
    db.close();
  }
  return { home, workspace };
}

async function binJob(baseUrl: string, token: string, jobId: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${baseUrl}/api/jobs/${encodeURIComponent(jobId)}/status`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'binned' }),
  });
  return { status: response.status, body: await response.json() };
}

/** A `working` job a previous service process left two open turns on, and a closed neighbour. */
function seedRestartedMidTurn(ledger: LedgerApi, jobId: string): void {
  ledger.addJob({ id: jobId, repo: 'fixture', title: 'restarted mid-turn', baseBranch: 'main', briefing: 'work' });
  ledger.setJobStatus(jobId, 'working');
  ledger.registerAgent({ id: 'ghost-streaming', role: 'minion', jobId });
  ledger.setAgentState('ghost-streaming', 'streaming');
  ledger.registerAgent({ id: 'ghost-spawning', role: 'minion', jobId });
  // A closed neighbour on the same job: not an open turn, never touched.
  ledger.registerAgent({ id: 'closed-idle', role: 'minion', jobId });
  ledger.setAgentState('closed-idle', 'idle');
}

describe('compiled service: boot settles the agent rows a previous process left open (#547)', () => {
  it('moves a streaming and a spawning row of a working job to error, names the reason and orphans each turn', async () => {
    const jobId = 'job-ghost-boot';
    const { home, workspace } = seedHome('gru-ghost-boot', (ledger) => seedRestartedMidTurn(ledger, jobId));
    expect(agentRows(home, jobId)).toEqual([
      { id: 'closed-idle', state: 'idle' },
      { id: 'ghost-spawning', state: 'spawning' },
      { id: 'ghost-streaming', state: 'streaming' },
    ]);

    const service = await startRealService({
      port: await pickFreePort(), token: 'ghost-boot-token', home, workspace, keepHome: true, requireWebDist: false, captureOutput: true,
    });
    try {
      expect(agentRows(home, jobId)).toEqual([
        { id: 'closed-idle', state: 'idle' },
        { id: 'ghost-spawning', state: 'error' },
        { id: 'ghost-streaming', state: 'error' },
      ]);
      expect(agentEvents(home, 'ghost-streaming', 'agent.state').at(-1)).toEqual({ from: 'streaming', to: 'error', error: 'host-absent at boot' });
      expect(agentEvents(home, 'ghost-spawning', 'agent.state').at(-1)).toEqual({ from: 'spawning', to: 'error', error: 'host-absent at boot' });
      for (const agentId of ['ghost-streaming', 'ghost-spawning']) {
        expect(orphanNotices(home, agentId), agentId).toEqual([
          { kind: `supervision.turn-orphaned.${agentId}`, routing: 'action-required', severity: 'error', agent_id: agentId },
        ]);
        expect(agentEvents(home, agentId, 'supervision.turn-recovery'), agentId).toEqual([
          expect.objectContaining({ disposition: 'orphaned', reason: 'host-absent at boot' }),
        ]);
      }
      expect(orphanNotices(home, 'closed-idle')).toEqual([]);
      const summary = service.output().split('\n').flatMap((line) => {
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      }).find((line) => line['msg'] === 'host-absent agent turns settled at boot');
      expect(summary).toMatchObject({ examined: 2, live: 0, settled: 2, failed: 0 });
    } finally {
      await service.stop();
    }
  }, 90_000);

  it('no longer refuses to bin the job for open worker turns', async () => {
    const jobId = 'job-ghost-bin';
    const { home, workspace } = seedHome('gru-ghost-bin', (ledger) => seedRestartedMidTurn(ledger, jobId));
    const service = await startRealService({
      port: await pickFreePort(), token: 'ghost-bin-token', home, workspace, keepHome: true, requireWebDist: false,
    });
    try {
      const binned = await binJob(service.baseUrl, service.token, jobId);
      expect(binned, JSON.stringify(binned.body)).toMatchObject({ status: 200, body: { id: jobId, status: 'binned' } });
    } finally {
      await service.stop();
    }
  }, 90_000);

  it('re-proves a parked job\'s interrupted stop against the settled rows: a ghost turn no longer leaves it unproven', async () => {
    const jobId = 'job-ghost-parked';
    const { home, workspace } = seedHome('gru-ghost-parked', (ledger) => {
      ledger.addJob({ id: jobId, repo: 'fixture', title: 'parked mid-turn', baseBranch: 'main', briefing: 'work' });
      ledger.setJobStatus(jobId, 'working');
      ledger.registerAgent({ id: 'ghost-parked', role: 'minion', jobId });
      ledger.setAgentState('ghost-parked', 'streaming');
      ledger.setJobStatus(jobId, 'parked');
      // The service stopped between the park's stop request and its verdict.
      ledger.appendCustomEvent({ kind: 'job.execution-stop', jobId, payload: { state: 'requested', by: 'crash', reason: 'interrupted' } });
    });
    const service = await startRealService({
      port: await pickFreePort(), token: 'ghost-parked-token', home, workspace, keepHome: true, requireWebDist: false,
    });
    try {
      await vi.waitFor(() => {
        const verdicts = readLedger(home, (db) => (db.prepare("SELECT payload FROM events WHERE job_id = ? AND kind = 'job.execution-stop' ORDER BY seq")
          .all(jobId) as unknown as { payload: string }[]).map((event) => JSON.parse(event.payload) as Record<string, unknown>));
        // The seeded request, the boot re-proof's own intent (a stop pass
        // records `requested` before any effect), then its verdict: the ghost
        // is a settled `error` row, not an open turn the runtime fails to hold.
        expect(verdicts.map((verdict) => verdict['state'])).toEqual(['requested', 'requested', 'stopped']);
        expect(verdicts[2]).toMatchObject({ physical_state: 'stopped', agents: [], outstanding: [] });
      }, { timeout: 30_000, interval: 250 });
      expect(agentRows(home, jobId)).toEqual([{ id: 'ghost-parked', state: 'error' }]);
    } finally {
      await service.stop();
    }
  }, 90_000);

  it('settles a session-bound child worker after the child service has failed it: result and agent row both leave their open states', async () => {
    const jobId = 'job-ghost-child';
    const { home, workspace } = seedHome('gru-ghost-child', (ledger, dir) => {
      ledger.addJob({ id: jobId, repo: 'fixture', title: 'child mid-turn', baseBranch: 'main', briefing: 'work' });
      ledger.setJobStatus(jobId, 'working');
      ledger.registerAgent({ id: 'parent-minion', role: 'minion', jobId, parentage: 'top-level' });
      ledger.setAgentState('parent-minion', 'idle');
      // A child whose session had bound when the service died: the child
      // service fails it at boot, and only then is its row a previous
      // process's open turn. Settling first would own it as unfinished.
      ledger.admitChildWorker({ id: 'child-bound-ghost', parentAgentId: 'parent-minion', jobId, purpose: 'bounded task', authority: 'writer', task: 'inspect', idempotencyKey: 'ghost-child-key' });
      ledger.markChildAdmitted('child-bound-ghost', { worktreeId: 'wt-child-bound-ghost', branch: null });
      ledger.markChildStarted('child-bound-ghost', { sessionFile: join(dir, 'child-bound-ghost.jsonl') });
      ledger.setAgentState('child-bound-ghost', 'streaming');
    });
    const service = await startRealService({
      port: await pickFreePort(), token: 'ghost-child-token', home, workspace, keepHome: true, requireWebDist: false,
    });
    try {
      const child = readLedger(home, (db) => db.prepare('SELECT result_state, result_summary FROM child_workers WHERE id = ?').get('child-bound-ghost')) as
        { result_state: string | null; result_summary: string | null };
      expect(child.result_state).toBe('error');
      expect(child.result_summary).toContain('service restarted while the child was running');
      expect(agentRows(home, jobId)).toEqual([{ id: 'child-bound-ghost', state: 'error' }, { id: 'parent-minion', state: 'idle' }]);
      expect(orphanNotices(home, 'child-bound-ghost')).toHaveLength(1);
    } finally {
      await service.stop();
    }
  }, 90_000);

  it('keeps an admitted directive request admitted while its ghost agent leaves streaming', async () => {
    const jobId = 'job-ghost-directive';
    const requestId = 'req-ghost-directive';
    const { home, workspace } = seedHome('gru-ghost-directive', (ledger, dir) => {
      ledger.addJob({ id: jobId, repo: 'fixture', title: 'admitted directive', baseBranch: 'main', briefing: 'work' });
      ledger.setJobStatus(jobId, 'working');
      ledger.beginDirectiveIntent({ jobId, directive: 'repair the lane', holder: 'silas-ops', requestId });
      admitNativeDirectiveFixture(ledger, requestId, 'ghost-directive-agent', join(dir, 'ghost-directive-agent.jsonl'));
      ledger.setAgentState('ghost-directive-agent', 'streaming');
    });
    expect(readLedger(home, (db) => (db.prepare('SELECT state FROM pending_directives WHERE request_id = ?').get(requestId) as { state: string }).state)).toBe('admitted');

    const service = await startRealService({
      port: await pickFreePort(), token: 'ghost-directive-token', home, workspace, keepHome: true, requireWebDist: false,
    });
    try {
      expect(agentRows(home, jobId)).toEqual([{ id: 'ghost-directive-agent', state: 'error' }]);
      expect(agentEvents(home, 'ghost-directive-agent', 'agent.state').at(-1)).toEqual({ from: 'streaming', to: 'error', error: 'host-absent at boot' });
      expect(orphanNotices(home, 'ghost-directive-agent')).toHaveLength(1);
      // The request is not retired, abandoned, failed or settled by the boot.
      expect(readLedger(home, (db) => (db.prepare('SELECT state FROM pending_directives WHERE request_id = ?').get(requestId) as { state: string }).state)).toBe('admitted');
      const closing = readLedger(home, (db) => db.prepare(
        "SELECT kind FROM events WHERE job_id = ? AND kind IN ('silas.directive-retired', 'silas.directive-abandoned', 'silas.directive-failed', 'silas.directive-producer-ceased', 'job.delivered')",
      ).all(jobId) as unknown as { kind: string }[]);
      expect(closing).toEqual([]);
    } finally {
      await service.stop();
    }
  }, 90_000);
});
