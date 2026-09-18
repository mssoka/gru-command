import { afterEach, describe, expect, it } from 'vitest';
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
import { DispatchService } from '../src/dispatch/service.js';
import { BobScheduler } from '../src/dispatch/bob-scheduler.js';
import { StubScript, makeStubModelRuntime, type StubTurn } from './helpers/stub-model.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * The real-runtime joins (Perkins r2 pattern sweep): every product join
 * that a human or an agent actually rides gets one leg with a REAL pi
 * session behind it — no fake spawner, no fake slot. The dispatch→minion
 * cwd join and Bob's consolidation knock were the last stub-only pair.
 */

interface JoinHarness {
  ledger: LedgerApi;
  repo: FixtureRepo;
  runtime: PiRuntime;
  store: SessionStore;
  dispatch: DispatchService;
  script: StubScript;
  cleanup(): Promise<void>;
}

async function makeJoinHarness(turns: readonly StubTurn[] = []): Promise<JoinHarness> {
  const home = mkdtempSync(join(tmpdir(), 'gru-command-joins-'));
  const workspace = mkdtempSync(join(tmpdir(), 'gru-command-joinsws-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-joinsagent-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    configPathFor(home),
    `workspace_root = "${workspace}"\n[models]\ndefault = "gru-stub/stub-model"\n`,
    'utf-8',
  );
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const store = new SessionStore(config.dataDir);
  const script = new StubScript(turns);
  const runtime = new PiRuntime({
    config,
    store,
    agentDir,
    modelRuntime: await makeStubModelRuntime(script),
  });
  const repo = makeFixtureRepo('fixture-joins');
  const ledgerDb = new LedgerDb(mkdtempSync(join(tmpdir(), 'gru-command-joinsdata-')));
  const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
  const manager = new WorktreeManager({
    ledger,
    root: mkdtempSync(join(tmpdir(), 'gru-command-joinsroot-')),
    preserveRoot: mkdtempSync(join(tmpdir(), 'gru-command-joinspreserve-')),
    setupTimeoutMs: 30_000,
    enumerateProcesses: () => [], // no sweep in these joins; enumeration off
  });
  const dispatch = new DispatchService({
    ledger,
    manager,
    spawner: (role, options) => runtime.spawn(role, options ?? {}),
  });
  return {
    ledger,
    repo,
    runtime,
    store,
    dispatch,
    script,
    async cleanup() {
      await runtime.dispose();
      store.dispose();
      ledgerDb.close();
      repo.cleanup();
    },
  };
}

const cleanups: JoinHarness[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!.cleanup();
});

describe('dispatch → minion: the real spawn join (ruling 17)', () => {
  it('the minion is a REAL session rooted under the worktree path, briefing delivered, arc on the record', async () => {
    const h = await makeJoinHarness([{ deltas: ['working… ', 'briefing received'] }]);
    cleanups.push(h);
    const outcome = await h.dispatch.dispatch({
      jobId: 'job-join',
      repoPath: h.repo.path,
      title: 'real join',
      briefing: 'Make the change and verify it.',
    });
    expect((await outcome.settled).ok).toBe(true);
    // The session lives under the MINION + WORKTREE-CWD directory — the
    // ruling-17 join is real, not a passed-through option.
    const expectedDir = h.store.sessionDirFor('minion', outcome.worktree.path);
    const agent = h.ledger.getAgent(outcome.agentId);
    expect(agent?.sessionFile).toContain(expectedDir);
    expect(agent?.jobId).toBe('job-join');
    // The briefing prompt reached a real model turn.
    expect(h.script.calls.length).toBe(1);
    expect(h.script.calls[0]?.prompt).toContain('Dispatch briefing — job job-join');
    expect(h.script.calls[0]?.prompt).toContain('Make the change and verify it.');
    // The arc is on the record.
    const kinds = h.ledger.listEvents({ limit: 100 }).map((event) => event.kind);
    expect(kinds).toContain('job.handoff');
    expect(kinds).toContain('job.minion-spawned');
    expect(kinds).toContain('job.delivered');
  });
});

describe('Bob: the real consolidation knock', () => {
  it('tick prompts a REAL bob session at the workspace root', async () => {
    const h = await makeJoinHarness([{ deltas: ['consolidating…'] }]);
    cleanups.push(h);
    const scheduler = new BobScheduler({
      intervalMs: 0, // disabled loop — the tick IS the join under test
      slot: { ensure: (options) => h.runtime.spawn('bob', options ?? {}) },
    });
    const result = await scheduler.tick();
    expect(result.prompted).toBe(true);
    // A real bob session, prompted once with the consolidation brief.
    expect(h.script.calls.length).toBe(1);
    expect(h.script.calls[0]?.prompt).toContain('Periodic memory consolidation is due.');
  });
});
