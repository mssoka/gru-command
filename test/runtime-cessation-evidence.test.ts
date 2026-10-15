import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { withFallbacks } from '../src/runtime/fallbacks.js';
import { PI_CAPABILITIES } from '../src/runtime/capabilities.js';
import {
  CESSATION_IDLE_TIMEOUT_MS,
  CessationIdleTimeoutError,
  PiAgentHandle,
} from '../src/runtime/pi-adapter.js';
import { SessionStore } from '../src/sessions/store.js';
import type { AgentHandle, AgentRuntime, RuntimeEvent } from '../src/runtime/types.js';

const CAPS = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };

type EvidenceMode = 'ceased' | 'unknown' | 'throwing' | 'absent';

/** Deterministic inner handle with controllable evidence + lifecycle. */
function evidenceInner(opts: {
  evidence?: EvidenceMode;
  disposedNow?: boolean;
  /** When set, prompts stay in flight until this gate resolves. */
  promptGate?: Promise<void>;
}): { handle: AgentHandle; setEvidence: (e: EvidenceMode) => void; events: RuntimeEvent[] } {
  const state = { evidence: opts.evidence ?? 'unknown', disposed: opts.disposedNow ?? true };
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const events: RuntimeEvent[] = [];
  const handle: AgentHandle = {
    id: 'inner-1', role: 'perkins', sessionFile: null, capabilities: CAPS,
    health: () => ({ state: state.disposed ? 'disposed' : 'idle', lastActivity: null, sessionFile: null }),
    prompt: async () => { await opts.promptGate; }, steer: async () => {}, followUp: async () => {},
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose: async () => {
      state.disposed = true;
      const evidence = state.evidence === 'throwing' ? 'unknown' : state.evidence === 'absent' ? undefined : state.evidence;
      const event: RuntimeEvent = evidence === undefined
        ? { type: 'state', state: 'disposed' }
        : { type: 'cessation_evidence', evidence };
      events.push(event);
      for (const listener of listeners) listener(event);
      for (const listener of listeners) listener({ type: 'state', state: 'disposed' });
    },
    ...(state.evidence === 'absent' ? {} : {
      cessationEvidence: () => {
        if (state.evidence === 'throwing') throw new Error('probe blew up');
        return state.evidence === 'ceased' ? 'ceased' as const : 'unknown' as const;
      },
    }),
  };
  return {
    handle,
    setEvidence: (e) => { state.evidence = e; },
    events,
  };
}

/** The wrapper wraps a RUNTIME; its spawned handle carries the combined
 * evidence. (A raw handle is not a runtime — passing one would be a type
 * error, not a test seam.) */
function wrapHandle(handle: AgentHandle): AgentRuntime {
  return {
    id: 'pi', capabilities: CAPS, health: () => ({ state: 'ok' }), dispose: async () => {},
    spawn: async () => handle,
  };
}

describe('cessation evidence contract (adapter-owned; deterministic sources)', () => {
  it('missing, throwing and unknown inner evidence are all UNKNOWN through the wrapper; absent method never fabricates proof', async () => {
    for (const mode of ['absent', 'throwing', 'unknown'] as const) {
      const inner = evidenceInner({ evidence: mode });
      const wrapped = withFallbacks(wrapHandle(inner.handle));
      const handle = await wrapped.spawn('perkins');
      const observed: RuntimeEvent[] = [];
      handle.subscribe((event) => observed.push(event));
      await handle.dispose();
      expect(handle.cessationEvidence?.()).toBe('unknown');
      // The combined surface may report UNKNOWN, never a fabricated positive.
      expect(observed.some((event) => event.type === 'cessation_evidence' && event.evidence === 'ceased')).toBe(false);
      expect(observed.some((event) => event.type === 'cessation_evidence' && event.evidence === 'unknown')).toBe(true);
    }
  });

  it('positive inner proof releases ONLY after the wrapper itself settles (queue drained, no in-flight/control/pump)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inner = evidenceInner({ evidence: 'ceased', disposedNow: false, promptGate: gate });
    const wrapped = withFallbacks(wrapHandle(inner.handle));
    const handle = await wrapped.spawn('perkins');
    const observed: RuntimeEvent[] = [];
    handle.subscribe((event) => observed.push(event));
    // A genuine wrapper-owned delivery, held open while we check evidence.
    const inFlight = handle.prompt('work');
    await Promise.resolve();
    expect(handle.cessationEvidence?.()).toBe('unknown'); // wrapper work still in flight
    release();
    await inFlight;
    await handle.dispose();
    // Wrapper settled (dispose completed) + inner 'ceased' -> combined positive, emitted once.
    expect(handle.cessationEvidence?.()).toBe('ceased');
    const positives = observed.filter((event) => event.type === 'cessation_evidence' && event.evidence === 'ceased');
    expect(positives.length).toBeGreaterThanOrEqual(1);
    // Duplicate event delivery does not duplicate the positive transition.
    const before = positives.length;
    inner.setEvidence('ceased');
    expect(observed.filter((e) => e.type === 'cessation_evidence' && e.evidence === 'ceased').length).toBe(before);
  });

  it('late inner unknown->ceased settles the combined evidence after disposal already completed', async () => {
    const inner = evidenceInner({ evidence: 'unknown' });
    const wrapped = withFallbacks(wrapHandle(inner.handle));
    const handle = await wrapped.spawn('perkins');
    const observed: RuntimeEvent[] = [];
    handle.subscribe((event) => observed.push(event));
    await handle.dispose();
    expect(handle.cessationEvidence?.()).toBe('unknown');
    inner.setEvidence('ceased');
    expect(handle.cessationEvidence?.()).toBe('ceased'); // truthful late re-query
  });

  it('duplicate dispose calls stay single-flight and evidence stays stable', async () => {
    const inner = evidenceInner({ evidence: 'ceased' });
    const wrapped = withFallbacks(wrapHandle(inner.handle));
    const handle = await wrapped.spawn('perkins');
    await Promise.all([handle.dispose(), handle.dispose(), handle.dispose()]);
    expect(handle.cessationEvidence?.()).toBe('ceased');
    expect(inner.events.filter((event) => event.type === 'cessation_evidence').length).toBe(1);
  });

  // RESOLVED (issue #341, Option A): the 'pi adapter cessation evidence'
  // suite below builds a real PiAgentHandle over a deterministic fake session
  // (the exported handle + structural session made a PiKnobs.makeSession seam
  // unnecessary). It proves the bounded post-dispose waitForIdle gates
  // 'ceased', fails loud on an unproven idle, and that an independent
  // isBashRunning true->false flips UNKNOWN->CEASED only when idle was already
  // proven.
  //
  // OWED (next tranche):
  // - claude: close-observed vs error vs deadline vs never-prompted (incl.
  //   bridge-failure downgrade and late original-child close latch) via the
  //   existing claude-double.mjs harness port into this file.
});

// ---------------------------------------------------------------------------
// Pi adapter direct seam (issue #341, Option A): a real PiAgentHandle over a
// deterministic fake session proves 'ceased' now requires the bounded
// post-dispose session waitForIdle, and that an unproven idle fails loud
// instead of silently degrading to dispose-only semantics.
// ---------------------------------------------------------------------------

type PiSession = ConstructorParameters<typeof PiAgentHandle>[1];

const piCleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of piCleanupDirs) rmSync(dir, { recursive: true, force: true });
});

/** Deterministic PiAgentHandle over a controllable session. `waitForIdleMode`
 * selects the idle proof (immediate, never-settling, rejecting, absent =
 * dispose-only, or deferred = settled by the test). The mutable bash flags
 * model an independent executeBash controller, which is NOT part of the SDK
 * session's isIdle. */
function piHandle(opts: {
  waitForIdleMode?: 'idle' | 'never' | 'reject' | 'absent' | 'deferred';
  bashRunning?: boolean;
  pendingBash?: boolean;
  /** When true `session.compact()` never settles, pinning the compaction
   * terminal open so a disposal in that window aborts it synchronously. */
  compactNeverSettles?: boolean;
} = {}): {
  handle: PiAgentHandle;
  session: { disposed: boolean; disposeCalls: number; waitForIdleCalls: number; bashRunning: boolean; pendingBash: boolean };
  events: RuntimeEvent[];
  store: SessionStore;
  sessionFile: string;
  settleIdle: () => void;
} {
  const mode = opts.waitForIdleMode ?? 'idle';
  const state = {
    disposed: false,
    disposeCalls: 0,
    waitForIdleCalls: 0,
    bashRunning: opts.bashRunning ?? false,
    pendingBash: opts.pendingBash ?? false,
  };
  let settleIdle: () => void = () => {};
  let releaseCompact: () => void = () => {};
  const session: PiSession = {
    sessionId: 'pi-session-341',
    sessionFile: undefined,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    get isBashRunning() { return state.bashRunning; },
    get hasPendingBashMessages() { return state.pendingBash; },
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    subscribe: () => () => {},
    dispose: () => { state.disposed = true; state.disposeCalls += 1; releaseCompact(); },
    compact: async () => (opts.compactNeverSettles === true ? new Promise<unknown>((resolve) => { releaseCompact = () => resolve({}); }) : {}),
    getContextUsage: () => undefined,
    ...(mode === 'absent' ? {} : {
      waitForIdle: async () => {
        state.waitForIdleCalls += 1;
        if (mode === 'never') return new Promise<void>(() => {});
        if (mode === 'reject') throw new Error('idle wait rejected');
        if (mode === 'deferred') return new Promise<void>((resolve) => { settleIdle = resolve; });
      },
    }),
  };
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'gru-cessation-pi-')));
  piCleanupDirs.push(store.dataDir);
  const sessionFile = join(store.dataDir, 'session-341.jsonl');
  const handle = new PiAgentHandle(
    'perkins',
    session,
    sessionFile,
    PI_CAPABILITIES,
    false,
    [],
    store,
    () => {},
  );
  const events: RuntimeEvent[] = [];
  handle.subscribe((event) => events.push(event));
  return { handle, session: state, events, store, sessionFile, settleIdle: () => settleIdle() };
}

/** Exact cessation-evidence events of one verdict (once-only assertions must
 * count, not `.some()`, or a duplicate emission would pass). */
function cessationEvents(events: readonly RuntimeEvent[], evidence: 'ceased' | 'unknown'): RuntimeEvent[] {
  return events.filter((event) => event.type === 'cessation_evidence' && event.evidence === evidence);
}

describe('pi adapter cessation evidence requires a bounded idle proof (#341, Option A)', () => {
  it('dispose followed by a confirmed idle reports ceased', async () => {
    const { handle, session, events } = piHandle({ waitForIdleMode: 'idle' });
    await handle.dispose();
    expect(session.disposed).toBe(true);
    expect(session.waitForIdleCalls).toBe(1);
    expect(handle.cessationEvidence()).toBe('ceased');
    // Exactly-once: repeating the (idempotent) re-query must not re-emit.
    expect(handle.cessationEvidence()).toBe('ceased');
    expect(cessationEvents(events, 'ceased').length).toBe(1);
  });

  it('idle never reached within the bound throws the named error and never reports ceased', async () => {
    vi.useFakeTimers();
    try {
      const { handle, events } = piHandle({ waitForIdleMode: 'never' });
      const settled = handle.dispose().then(
        () => null,
        (error: unknown) => error as Error,
      );
      await vi.advanceTimersByTimeAsync(CESSATION_IDLE_TIMEOUT_MS);
      const error = await settled;
      expect(error).toBeInstanceOf(CessationIdleTimeoutError);
      expect(error?.name).toBe('CessationIdleTimeoutError');
      expect(error?.message).toContain(`${CESSATION_IDLE_TIMEOUT_MS}ms`);
      expect(handle.cessationEvidence()).toBe('unknown');
      expect(events.some((event) => event.type === 'cessation_evidence' && event.evidence === 'ceased')).toBe(false);
      expect(events.some((event) => event.type === 'cessation_evidence' && event.evidence === 'unknown')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pins the idle bound to the literal 5s bridge-timeout contract', async () => {
    // The spec pins the 5s bridge-timeout pattern by VALUE; following the
    // imported constant would let a 10s change pass the suite silently.
    expect(CESSATION_IDLE_TIMEOUT_MS).toBe(5_000);
    vi.useFakeTimers();
    try {
      const { handle } = piHandle({ waitForIdleMode: 'never' });
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      let rejection: unknown = null;
      const pending = handle.dispose().then(
        () => { outcome = 'resolved'; },
        (error: unknown) => { outcome = 'rejected'; rejection = error; },
      );
      await vi.advanceTimersByTimeAsync(4_999);
      expect(outcome).toBe('pending'); // not a moment early
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(outcome).toBe('rejected');
      expect(rejection).toBeInstanceOf(CessationIdleTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one disposal promise: a retry after a timeout observes the same rejection, never a success-shaped bypass', async () => {
    vi.useFakeTimers();
    try {
      const { handle, session } = piHandle({ waitForIdleMode: 'never' });
      const first = handle.dispose().catch((error: unknown) => error as Error);
      // A concurrent caller must wait on the SAME pending proof, not resolve
      // immediately because disposed was marked.
      const concurrent = handle.dispose().catch((error: unknown) => error as Error);
      await vi.advanceTimersByTimeAsync(CESSATION_IDLE_TIMEOUT_MS);
      expect(await first).toBeInstanceOf(CessationIdleTimeoutError);
      expect(await concurrent).toBeInstanceOf(CessationIdleTimeoutError);
      expect(session.waitForIdleCalls).toBe(1); // one proof attempt, shared by both callers
      // Retry AFTER the rejection performs a REAL second proof attempt (main's
      // retryable ownership contract) and, still hung, fails with the named
      // error again — never a success-shaped bypass.
      const retry = handle.dispose().catch((error: unknown) => error as Error);
      await vi.advanceTimersByTimeAsync(CESSATION_IDLE_TIMEOUT_MS);
      expect(await retry).toBeInstanceOf(CessationIdleTimeoutError);
      expect(session.waitForIdleCalls).toBe(2);
      expect(handle.cessationEvidence()).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a rejecting waitForIdle as an unproven idle (no dispose-only fallback)', async () => {
    const { handle, events } = piHandle({ waitForIdleMode: 'reject' });
    await expect(handle.dispose()).rejects.toThrow('idle wait rejected');
    expect(handle.cessationEvidence()).toBe('unknown');
    expect(events.some((event) => event.type === 'cessation_evidence' && event.evidence === 'ceased')).toBe(false);
  });

  it('idle proven but an independent bash controller still active stays unknown until it clears', async () => {
    const { handle, session, events } = piHandle({ waitForIdleMode: 'idle', bashRunning: true });
    await handle.dispose();
    expect(session.waitForIdleCalls).toBe(1);
    expect(handle.cessationEvidence()).toBe('unknown');
    expect(cessationEvents(events, 'ceased').length).toBe(0);
    session.bashRunning = false; // the independent controller finished after disposal
    expect(handle.cessationEvidence()).toBe('ceased');
    // Exactly-once across repeated re-queries (a duplicate would re-emit).
    expect(handle.cessationEvidence()).toBe('ceased');
    expect(handle.cessationEvidence()).toBe('ceased');
    expect(cessationEvents(events, 'ceased').length).toBe(1);
    expect(cessationEvents(events, 'unknown').length).toBe(1);
  });

  it('an unproven idle never becomes ceased even after the bash controller clears', async () => {
    vi.useFakeTimers();
    try {
      const { handle, session } = piHandle({ waitForIdleMode: 'never', bashRunning: true });
      const settled = handle.dispose().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      await vi.advanceTimersByTimeAsync(CESSATION_IDLE_TIMEOUT_MS);
      expect(await settled).toBe('rejected');
      session.bashRunning = false; // clearing the controller is not an idle proof
      expect(handle.cessationEvidence()).toBe('unknown');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a subscriber that re-enters dispose() from the synchronous compaction_end emit cannot start a second disposal', async () => {
    // dispose()`s synchronous prefix emits compaction_end to listeners BEFORE
    // the single-flight cache used to land, so a listener that disposed in
    // that window started a SECOND full disposal (duplicate emit, duplicate
    // session.dispose). The body is deferred one microtask so the cache is
    // already written when the prefix runs.
    const { handle, session, events } = piHandle({ waitForIdleMode: 'idle', compactNeverSettles: true });
    let reentered = false;
    handle.subscribe((event) => {
      if (event.type === 'compaction_end' && !reentered) {
        reentered = true;
        void handle.dispose();
      }
    });
    void handle.compact().catch(() => {}); // compaction stays pending -> disposal aborts it synchronously
    await handle.dispose();
    expect(reentered).toBe(true);
    expect(events.filter((event) => event.type === 'compaction_end').length).toBe(1);
    expect(session.disposeCalls).toBe(1);
    expect(handle.cessationEvidence()).toBe('ceased');
  });

  it('the timed-out session retains its writer lock (ownership is released only on proven cessation)', async () => {
    vi.useFakeTimers();
    try {
      const { handle, store, sessionFile } = piHandle({ waitForIdleMode: 'never' });
      store.acquireLock(sessionFile);
      expect(store.isHeld(sessionFile)).toBe(true);
      const settled = handle.dispose().catch((error: unknown) => error as Error);
      await vi.advanceTimersByTimeAsync(CESSATION_IDLE_TIMEOUT_MS);
      expect(await settled).toBeInstanceOf(CessationIdleTimeoutError);
      // GH286 ownership contract: no idle proof, no release — a still-running
      // turn must keep exclusive writer ownership of its session file.
      expect(store.isHeld(sessionFile)).toBe(true);
      store.releaseLock(sessionFile);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an idle promise that resolves inside the window emits ceased exactly once before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const { handle, events, settleIdle } = piHandle({ waitForIdleMode: 'deferred' });
      let outcome: 'pending' | 'resolved' | 'rejected' = 'pending';
      void handle.dispose().then(
        () => { outcome = 'resolved'; },
        () => { outcome = 'rejected'; },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      // Still inside the bound: disposal pending, no positive evidence yet.
      expect(outcome).toBe('pending');
      expect(cessationEvents(events, 'ceased').length).toBe(0);
      expect(handle.cessationEvidence()).toBe('unknown');
      settleIdle();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBe('resolved');
      expect(handle.cessationEvidence()).toBe('ceased');
      expect(cessationEvents(events, 'ceased').length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
