import { describe, expect, it } from 'vitest';
import { withFallbacks } from '../src/runtime/fallbacks.js';
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

  // OWED (next tranche, needs seams ported from the adapter suites):
  // - pi: session-level waitForIdle awaited through the real structural
  //   wrapper; independent isBashRunning true->false flips UNKNOWN->CEASED
  //   exactly once (deterministic fake session via a PiKnobs.makeSession
  //   seam — seam NOT added in this tranche to stay inside the allowlist).
  // - claude: close-observed vs error vs deadline vs never-prompted (incl.
  //   bridge-failure downgrade and late original-child close latch) via the
  //   existing claude-double.mjs harness port into this file.
});
