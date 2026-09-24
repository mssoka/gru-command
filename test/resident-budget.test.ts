import { describe, expect, it, vi } from 'vitest';
import { ResidentBudget } from '../src/runtime/resident-budget.js';
import type { AgentHandle } from '../src/runtime/types.js';

function fakeMinion(id: string, onDispose: () => void): AgentHandle {
  return {
    id, role: 'minion', sessionFile: `/sessions/${id}.jsonl`,
    capabilities: { streaming: false, steer: 'queued', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
    health: () => ({ state: 'idle', sessionFile: `/sessions/${id}.jsonl`, lastActivity: null }),
    dispose: vi.fn(async () => { onDispose(); }),
    prompt: vi.fn(async () => {}), steer: vi.fn(async () => {}), followUp: vi.fn(async () => {}),
    subscribe: () => () => {},
  };
}

async function flush(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

describe('service-wide resident permits', () => {
  it('keeps warm idle minions until a queued round needs two, reclaims oldest safe first, and blocks newer workers', async () => {
    const budget = new ResidentBudget(4);
    const occupied = await Promise.all(Array.from({ length: 4 }, () => budget.acquire()));
    const evicted: string[] = [];
    const old = fakeMinion('old', () => { evicted.push('old'); occupied[0]!(); });
    const busy = fakeMinion('busy', () => { evicted.push('busy'); occupied[1]!(); });
    const young = fakeMinion('young', () => { evicted.push('young'); occupied[2]!(); });
    budget.watch(old, () => true, 1);
    budget.watch(busy, () => false, 0); // idle display, supervisor openTurn/tool
    budget.watch(young, () => true, 2);
    const review = budget.acquire(2);
    let workerStarted = false;
    const worker = budget.acquire().then((release) => { workerStarted = true; return release; });
    await flush();
    const reviewRelease = await review;
    expect(evicted).toEqual(['old', 'young']);
    expect(budget.occupied).toBe(4);
    expect(workerStarted).toBe(false);
    expect(busy.dispose).not.toHaveBeenCalled();
    reviewRelease();
    const workerRelease = await worker;
    expect(workerStarted).toBe(true);
    workerRelease();
    occupied[1]!(); occupied[3]!();
    expect(budget.occupied).toBe(0);
  });

  it('cancels waiters without burning a permit, rejects impossible rounds and never double releases', async () => {
    const budget = new ResidentBudget(2);
    const held = await budget.acquire(2);
    const controller = new AbortController();
    const waiting = budget.acquire(2, controller.signal);
    const later = budget.acquire();
    controller.abort();
    await expect(waiting).rejects.toThrow(/cancelled/);
    expect(budget.queued).toBe(1);
    held(); held();
    const release = await later;
    expect(budget.occupied).toBe(1);
    release(); release();
    expect(budget.occupied).toBe(0);
    await expect(budget.acquire(3)).rejects.toThrow(/cannot fit/);
  });

  it('does not free a permit when disposal fails; the waiting caller gets an actionable error', async () => {
    const budget = new ResidentBudget(1);
    const held = await budget.acquire();
    const worker = fakeMinion('stuck', () => {});
    const failure = new Error('adapter refused disposal');
    const broken = { ...worker, dispose: async () => { throw failure; } };
    budget.watch(broken, () => true);
    await expect(budget.acquire()).rejects.toThrow(/resident idle disposal failed: Error: adapter refused disposal/);
    expect(budget.occupied).toBe(1);
    held();
    const next = await budget.acquire();
    next();
  });

  it('two competing rounds and later worker arrivals progress in FIFO order', async () => {
    const budget = new ResidentBudget(2);
    const first = await budget.acquire(2);
    const order: string[] = [];
    const second = budget.acquire(2).then((release) => { order.push('second round'); return release; });
    const worker = budget.acquire().then((release) => { order.push('worker'); return release; });
    first();
    const roundRelease = await second;
    await flush();
    expect(order).toEqual(['second round']);
    roundRelease();
    const workerRelease = await worker;
    expect(order).toEqual(['second round', 'worker']);
    workerRelease();
  });

  it('optional children cannot consume capacity reserved for a queued round', async () => {
    const budget = new ResidentBudget(2);
    const held = await budget.acquire();
    const review = budget.acquire(2);
    expect(budget.tryAcquire()).toBeNull();
    held();
    const release = await review;
    expect(budget.tryAcquire()).toBeNull();
    release();
    const optional = budget.tryAcquire();
    expect(optional).not.toBeNull();
    optional?.();
  });
});
