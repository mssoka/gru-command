import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Role, type RuntimeId } from '../src/config.js';
import { freezeReviewInputs } from '../src/dispatch/perkins-review/artifacts.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { PerkinsWholeReview } from '../src/dispatch/perkins-review/whole.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import type { AgentHandle, AgentRuntime, RuntimeEventListener, SpawnOptions } from '../src/runtime/types.js';
import type { SessionStore } from '../src/sessions/store.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const caps = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };

describe('four-busy-minion saturation and complete whole-PR Perkins coverage', () => {
  it('keeps busy work and durable lanes intact, admits the lead+child ahead of new arrivals, and runs every lens within four slots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resident-saturation-'));
    dirs.push(dir);
    const sessions = join(dir, 'sessions');
    mkdirSync(sessions);
    const repo = makeFixtureRepo('saturation-fixture');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/review']);
    repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen = freezeReviewInputs({
      roundId: 'saturation-r1', repoPath: repo.path, artifactRoot: dir,
      baseRef: base, targetRef: repo.head(), movementRef: 'feature/review', spec: 'review the change',
    });
    const lane = join(dir, 'job-lane');
    repo.git(['worktree', 'add', '-b', 'gru/job-saturation', lane, 'feature/review']);
    const deliverable = join(lane, 'deliverable.untracked');
    writeFileSync(deliverable, 'preserved by residency release\n');
    const script = fakeWholeSpawner(sessions, { childAnswer: () => '[]' });
    const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 4 } };
    let next = 0;
    let resident = 0;
    let peak = 0;
    const busy = new Map<string, boolean>();
    const implementations = new Map<string, { session: string; lane: string }>();
    const implementationAdapter: AgentRuntime = {
      id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
      spawn: async (role: Role, options: SpawnOptions = {}): Promise<AgentHandle> => {
        const id = `minion-${++next}`;
        const session = join(sessions, `${id}.jsonl`);
        const cwd = options.cwd ?? lane;
        writeFileSync(session, `durable ${id} transcript\n`);
        implementations.set(id, { session, lane: cwd });
        busy.set(id, false);
        resident += 1;
        peak = Math.max(peak, resident);
        let disposed = false;
        const listeners = new Set<RuntimeEventListener>();
        return {
          id, role, sessionFile: session, capabilities: caps,
          health: () => ({ state: disposed ? 'disposed' : 'idle', lastActivity: null, sessionFile: session }),
          prompt: async () => {}, steer: async () => {}, followUp: async () => {},
          subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
          dispose: async () => {
            if (disposed) return;
            disposed = true;
            resident -= 1;
            for (const listener of listeners) listener({ type: 'state', state: 'disposed' });
          },
        };
      },
    };
    const reviewAdapter: AgentRuntime = {
      id: 'claude-code', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
      spawn: async (role: Role, options: SpawnOptions = {}): Promise<AgentHandle> => {
        const scripted = await script.spawner(role, options);
        resident += 1;
        peak = Math.max(peak, resident);
        let disposed = false;
        const listeners = new Set<RuntimeEventListener>();
        return {
          ...scripted,
          // Terminal health truth after the wrapper's owned disposal (the
          // real adapters report 'disposed'); the round's pair release is
          // proof-gated on this — fulfillment alone is not cessation.
          health: () => ({ state: disposed ? 'disposed' : 'idle', lastActivity: null, sessionFile: scripted.sessionFile }),
          subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
          dispose: async () => {
            if (disposed) return;
            disposed = true;
            await scripted.dispose();
            resident -= 1;
            for (const listener of listeners) listener({ type: 'state', state: 'disposed' });
          },
        };
      },
    };
    class TestRegistry extends RuntimeRegistry {
      override runtimeIdFor(role: Role): RuntimeId { return role === 'perkins' ? 'claude-code' : 'pi'; }
      override runtimeFor(id: RuntimeId): AgentRuntime { return id === 'pi' ? implementationAdapter : reviewAdapter; }
    }
    const registry = new TestRegistry({
      config, store: {} as SessionStore, canReclaim: (id) => busy.get(id) === false,
    });
    const minions = await Promise.all(Array.from({ length: 4 }, () => registry.spawn('minion', { cwd: lane })));
    for (const minion of minions) { await minion.prompt('implement'); busy.set(minion.id, true); }
    const review = registry.reserveReviewRound();
    const newcomer = registry.spawn('minion', { cwd: lane });
    expect(registry.residents.queued).toBe(2);
    expect(peak).toBe(4);
    const retained = minions.slice(2);
    await minions[0]!.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registry.residents.queued).toBe(2); // review retains the first freed slot
    await minions[1]!.dispose();
    expect(existsSync(implementations.get(minions[0]!.id)!.session)).toBe(true);
    expect(existsSync(implementations.get(minions[1]!.id)!.session)).toBe(true);
    expect(existsSync(lane)).toBe(true);
    expect(existsSync(deliverable)).toBe(true);
    expect(repo.git(['branch', '--show-current'], lane)).toBe('gru/job-saturation');
    const round = await review;
    const engine = new PerkinsWholeReview({
      spawner: (_role, options) => round.spawn(options ?? {}),
      policy: loadPerkinsPolicy(), maxConcurrentChildren: 2,
      beginChildren: () => round.beginChildren(2),
    });
    try {
      const result = await engine.run({
        roundId: 'saturation-r1', roundNumber: 1, frozenReview: frozen,
        movementRef: 'feature/review', noSpec: false,
      });
      expect(result.canonicalVerdict).toBe('READY TO MERGE');
      expect(script.childCalls).toHaveLength(9);
      expect(result.specialistRuns).toHaveLength(9);
      expect(peak).toBe(4);
      for (const minion of retained) {
        expect(registry.getHandle(minion.id)).toBe(minion);
        expect(implementations.get(minion.id)).toMatchObject({ session: minion.sessionFile, lane });
      }
    } finally {
      await round.close();
    }
    const admitted = await newcomer;
    await admitted.dispose();
    await Promise.all(retained.map((minion) => minion.dispose()));
    expect(resident).toBe(0);
  });

  it('completes the whole-PR review serially at global 2 / child 1 while a newcomer waits, without missing lenses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resident-saturation-2-1-'));
    dirs.push(dir);
    const sessions = join(dir, 'sessions');
    mkdirSync(sessions);
    const repo = makeFixtureRepo('saturation-fixture-2-1');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/review']);
    repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen = freezeReviewInputs({
      roundId: 'saturation-r2', repoPath: repo.path, artifactRoot: dir,
      baseRef: base, targetRef: repo.head(), movementRef: 'feature/review', spec: 'review the change',
    });
    const script = fakeWholeSpawner(sessions, { childAnswer: () => '[]' });
    const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 2 } };
    let next = 0;
    let resident = 0;
    let peak = 0;
    const busy = new Map<string, boolean>();
    const implementationAdapter: AgentRuntime = {
      id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
      spawn: async (role: Role, _options: SpawnOptions = {}): Promise<AgentHandle> => {
        const id = `minion-${++next}`;
        busy.set(id, false);
        resident += 1;
        peak = Math.max(peak, resident);
        let disposed = false;
        const listeners = new Set<RuntimeEventListener>();
        return {
          id, role, sessionFile: join(sessions, `${id}.jsonl`), capabilities: caps,
          health: () => ({ state: disposed ? 'disposed' : 'idle', lastActivity: null, sessionFile: null }),
          prompt: async () => {}, steer: async () => {}, followUp: async () => {},
          subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
          dispose: async () => {
            if (disposed) return;
            disposed = true;
            resident -= 1;
            for (const listener of listeners) listener({ type: 'state', state: 'disposed' });
          },
        };
      },
    };
    const reviewAdapter: AgentRuntime = {
      id: 'claude-code', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
      spawn: async (role: Role, options: SpawnOptions = {}): Promise<AgentHandle> => {
        const scripted = await script.spawner(role, options);
        resident += 1;
        peak = Math.max(peak, resident);
        let disposed = false;
        const listeners = new Set<RuntimeEventListener>();
        return {
          ...scripted,
          // Terminal health truth after the wrapper's owned disposal (the
          // real adapters report 'disposed'); the round's pair release is
          // proof-gated on this — fulfillment alone is not cessation.
          health: () => ({ state: disposed ? 'disposed' : 'idle', lastActivity: null, sessionFile: scripted.sessionFile }),
          subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
          dispose: async () => {
            if (disposed) return;
            disposed = true;
            await scripted.dispose();
            resident -= 1;
            for (const listener of listeners) listener({ type: 'state', state: 'disposed' });
          },
        };
      },
    };
    class TestRegistry extends RuntimeRegistry {
      override runtimeIdFor(role: Role): RuntimeId { return role === 'perkins' ? 'claude-code' : 'pi'; }
      override runtimeFor(id: RuntimeId): AgentRuntime { return id === 'pi' ? implementationAdapter : reviewAdapter; }
    }
    const registry = new TestRegistry({
      config, store: {} as SessionStore, canReclaim: (id) => busy.get(id) === false,
    });
    // One busy implementer holds one of the two global slots; the review
    // round queues until it settles, and a newer minion cannot overtake it.
    const implementer = await registry.spawn('minion');
    await implementer.prompt('implement');
    busy.set(implementer.id, true);
    const review = registry.reserveReviewRound();
    const newcomer = registry.spawn('minion');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(registry.residents.queued).toBe(2);
    busy.set(implementer.id, false);
    await implementer.dispose();
    const round = await review;
    const engine = new PerkinsWholeReview({
      spawner: (_role, options) => round.spawn(options ?? {}),
      policy: loadPerkinsPolicy(), maxConcurrentChildren: 1,
      beginChildren: () => round.beginChildren(1),
    });
    try {
      const result = await engine.run({
        roundId: 'saturation-r2', roundNumber: 1, frozenReview: frozen,
        movementRef: 'feature/review', noSpec: false,
      });
      expect(result.canonicalVerdict).toBe('READY TO MERGE');
      expect(script.childCalls).toHaveLength(9);
      expect(result.specialistRuns).toHaveLength(9);
      // Lead + one serial child never exceed the two-slot global pool.
      expect(peak).toBe(2);
    } finally {
      await round.close();
    }
    const admitted = await newcomer;
    await admitted.dispose();
    expect(resident).toBe(0);
  });
});
