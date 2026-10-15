import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { nativeSeams } from './helpers/silas-native-seams.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { createSilasAutopilotOps } from '../src/dispatch/silas-autopilot-ops.js';
import { SessionStore } from '../src/sessions/store.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';

/**
 * Issue #243 F-H4 — the durable pre-first-await shutdown checkpoint.
 *
 * The REAL shutdown path (`src/main.ts`) writes a durable checkpoint of the
 * still-owned pending autopilot producers plus the last-seen session sizes
 * BEFORE its first potentially-unbounded await, while locks and the ledger
 * remain OPEN. These tests exercise the two production seams it composes:
 * the ops instantaneous pending snapshot and the distinct SessionStore
 * checkpoint artifact (which never replaces the original final snapshot).
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const CAPS: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

function idleHandle(id: string): AgentHandle {
  return {
    id,
    role: 'minion',
    sessionFile: null,
    async prompt() {},
    capabilities: CAPS,
    async steer() {},
    async followUp() {},
    subscribe() {
      return () => {};
    },
    health() {
      return { state: 'idle' as const, lastActivity: null, sessionFile: null };
    },
    async dispose() {},
  } satisfies AgentHandle;
}

const waveStub = () => ({
  assertWriterAdmissible: () => {},
  clearLaneForWriter: async () => undefined,
  requestReview: async () => {
    throw new Error('unused');
  },
});

describe('F-H4 pending ownership snapshot (production ops seam)', () => {
  it('reports the still-owned producer identity WITHOUT joining, then empties on settle', async () => {
    const ledger = new LedgerApi(new LedgerDb(temp('h4-db-')).handle, {});
    const job = ledger.addJob({ id: 'job-h4', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    ledger.registerAgent({ id: 'min-h4', role: 'minion', jobId: job.id });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = {
      ...idleHandle('min-h4'),
      async prompt() {
        await gate;
      },
    } satisfies AgentHandle;
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub() as never,
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} } as never,
      worktrees: { listWorktrees: () => [] } as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.sendDirective({ jobId: job.id, directive: 'x', ruleId: 'verdict-rung-directive', sourceRoundId: 'round-h4' });
    await vi.waitFor(() => expect(ops.pendingSnapshot()).toHaveLength(1));
    const snapshot = ops.pendingSnapshot();
    expect(snapshot[0]).toMatchObject({
      operation: 'directive',
      jobId: job.id,
      ruleId: 'verdict-rung-directive',
      agentId: null,
    });
    expect(snapshot[0]?.requestRefs).toHaveLength(1);
    expect(typeof snapshot[0]?.requestRefs[0]).toBe('string');
    // The snapshot is INSTANTANEOUS: the producer is still gated/open here.
    release();
    await vi.waitFor(() => expect(ops.pendingSnapshot()).toHaveLength(0));
  }, 30_000);

  it('snapshots a re-brief producer with its durable marker identities', async () => {
    const ledger = new LedgerApi(new LedgerDb(temp('h4-db2-')).handle, {});
    const job = ledger.addJob({ id: 'job-h4r', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(job.id, 'working');
    const repoDir = temp('h4-repo-');
    // A real job lane is required by rebriefFreshMinion; a plain directory is
    // enough here because the mocked spawner never touches it.
    const handle = idleHandle('fresh-h4r');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = {
      ...handle,
      async prompt() {
        await gate;
      },
    } satisfies AgentHandle;
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub() as never,
      registry: { getHandle: () => null, spawn: async () => gated, disposeHandle: async () => {} } as never,
      worktrees: {
        listWorktrees: () => [{ id: job.id, kind: 'job', status: 'active', branch: 'gru/h4r', path: repoDir }],
      } as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.sendRebrief({ jobId: job.id, note: 'n', ruleId: 'verdict-rung-rebrief', sourceRoundId: 'round-h4r' });
    await vi.waitFor(() => expect(ops.pendingSnapshot()).toHaveLength(1));
    const snapshot = ops.pendingSnapshot();
    expect(snapshot[0]).toMatchObject({ operation: 'rebrief', jobId: job.id, ruleId: 'verdict-rung-rebrief', agentId: null });
    expect(snapshot[0]?.requestRefs.length).toBeGreaterThanOrEqual(1);
    release();
    await vi.waitFor(() => expect(ops.pendingSnapshot()).toHaveLength(0));
  }, 30_000);
});

describe('F-H4 distinct SessionStore checkpoint artifact', () => {
  it('writes a separate checkpoint and never replaces or duplicates the final snapshot', () => {
    const dataDir = temp('h4-store-');
    const store = new SessionStore(dataDir, { log: () => {} });
    mkdirSync(join(store.sessionsDir, 'silas'), { recursive: true });
    writeFileSync(join(store.sessionsDir, 'silas', 's1.jsonl'), '{"synthetic":1}\n');
    const pending = [
      { operation: 'rebrief', jobId: 'job-h4r', ruleId: 'verdict-rung-rebrief', requestRefs: ['marker-1'], agentId: null },
    ];
    store.writeShutdownCheckpoint({ pending });
    const checkpointPath = join(store.sessionsDir, 'store-shutdown-checkpoint.json');
    expect(existsSync(checkpointPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(checkpointPath, 'utf-8')) as Record<string, unknown>;
    expect(parsed['phase']).toBe('shutdown-checkpoint');
    expect(parsed['pendingWork']).toEqual(pending);
    expect(Object.keys(parsed['sessions'] as Record<string, number>).length).toBeGreaterThanOrEqual(1);
    // The ORIGINAL final snapshot artifact is untouched by the checkpoint.
    expect(existsSync(join(store.sessionsDir, 'store-state.json'))).toBe(false);
    store.persistSnapshot();
    expect(existsSync(join(store.sessionsDir, 'store-state.json'))).toBe(true);
    // The final snapshot carries its ORIGINAL shape (a bare size map), never
    // the checkpoint's phase/pending fields.
    const finalSnapshot = JSON.parse(readFileSync(join(store.sessionsDir, 'store-state.json'), 'utf-8')) as Record<string, unknown>;
    expect(finalSnapshot['phase']).toBeUndefined();
    expect(finalSnapshot['pendingWork']).toBeUndefined();
    store.dispose();
  });
});
