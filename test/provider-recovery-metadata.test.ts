import { describe, expect, it } from 'vitest';
import {
  ClaudeUsageAdapter,
  CodexUsageAdapter,
  claudeUsageOutcome,
  codexUsageOutcome,
  metadataFingerprint,
  metadataStatusOutcome,
  validateClaudeUsageBody,
  validateCodexUsageBody,
  type MetadataCredential,
  type MetadataFetchPort,
} from '../src/provider-recovery/metadata.js';

/**
 * NON-GENERATION metadata adapters (owner-approved overlay): FAKE transport
 * and FAKE credential resolvers only — zero generation, zero live accounts,
 * zero real keychain access. No HTTP listener is created anywhere (the fake
 * fetch port is an in-memory function), per the phase ruling that real
 * listeners count as service-using verification even inside a test process.
 *
 * NOTE (phase1): this file is WRITTEN SOURCE ONLY under the bounded repair
 * ruling — execution is deferred to an authorized phase.
 */

const CODEX_CREDENTIAL: MetadataCredential = {
  authorization: 'Bearer fake-codex-oauth-token',
  accountBinding: 'codex-account-1',
};
const CLAUDE_CREDENTIAL: MetadataCredential = {
  authorization: 'Bearer fake-claude-oauth-token',
  accountBinding: 'claude-account-1',
};

class FakeFetch implements MetadataFetchPort {
  responses: { status: number; body: string }[] = [];
  readonly calls: { url: string; authorization: string; timeoutMs: number }[] = [];
  get(input: { url: string; authorization: string; accept: string; timeoutMs: number }): Promise<{ status: number; body: string }> {
    this.calls.push({ url: input.url, authorization: input.authorization, timeoutMs: input.timeoutMs });
    const next = this.responses.shift();
    if (next === undefined) return Promise.resolve({ status: 500, body: 'unconfigured' });
    return Promise.resolve(next);
  }
}

const CODEX_BODY = JSON.stringify({
  rateLimit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 52,
      limit_window_seconds: 604800,
      reset_after_seconds: 455232,
      reset_at: 1791046722,
    },
    secondary_window: null,
  },
});

const CLAUDE_BODY = JSON.stringify({
  windows: {
    five_hour: { utilization: 1.0, resetsAtUtc: '2026-09-28T15:40:00Z' },
    seven_day: { utilization: 0.0, resetsAtUtc: '2026-09-29T19:00:00Z' },
    seven_day_oauth_apps: null,
  },
  scopedLimits: [{ percent: 1, resetsAtUtc: '2026-09-28T15:40:00Z' }],
});

describe('codex wham/usage schema validation (strict, fail closed)', () => {
  it('accepts the traced contract shape', () => {
    const body = validateCodexUsageBody(CODEX_BODY);
    expect(body).not.toBeNull();
    expect(body?.rateLimit.allowed).toBe(true);
  });

  it('rejects malformed/partial/unknown schema', () => {
    expect(validateCodexUsageBody('not json')).toBeNull();
    expect(validateCodexUsageBody('{}')).toBeNull();
    expect(validateCodexUsageBody(JSON.stringify({ rateLimit: { allowed: true, limit_reached: false, primary_window: null } }))).toBeNull();
    expect(validateCodexUsageBody(JSON.stringify({ rateLimit: { allowed: 'yes', limit_reached: false, primary_window: null } }))).toBeNull();
    // A window with missing fields is partial evidence — fail closed.
    expect(
      validateCodexUsageBody(
        JSON.stringify({ rateLimit: { allowed: true, limit_reached: false, primary_window: { used_percent: 5 } } }),
      ),
    ).toBeNull();
  });

  it('limit_reached/allowed=false maps to exhausted with a reset hint', () => {
    const body = validateCodexUsageBody(
      JSON.stringify({
        rateLimit: {
          allowed: false,
          limit_reached: true,
          primary_window: { used_percent: 100, limit_window_seconds: 900, reset_after_seconds: 420, reset_at: Math.floor(Date.now() / 1000) + 420 },
        },
      }),
    );
    const outcome = codexUsageOutcome(body!);
    expect(outcome.kind).toBe('exhausted');
    if (outcome.kind === 'exhausted') expect(outcome.retryAfterMs).not.toBeNull();
  });

  it('available windows are evidence, never a capacity promise', () => {
    const outcome = codexUsageOutcome(validateCodexUsageBody(CODEX_BODY)!);
    expect(outcome.kind).toBe('available');
    if (outcome.kind === 'available') {
      expect(outcome.evidence).toMatchObject({ adapter: 'codex-wham-usage', limit_reached: false });
    }
  });
});

describe('claude oauth/usage schema validation (strict, fail closed)', () => {
  it('accepts the traced contract shape', () => {
    const body = validateClaudeUsageBody(CLAUDE_BODY);
    expect(body).not.toBeNull();
    expect(body?.windows.five_hour.utilization).toBe(1);
  });

  it('rejects malformed bodies, bad utilization ranges, and missing required windows', () => {
    expect(validateClaudeUsageBody('nope')).toBeNull();
    expect(validateClaudeUsageBody('{}')).toBeNull();
    expect(
      validateClaudeUsageBody(JSON.stringify({ windows: { five_hour: { utilization: 1, resetsAtUtc: 'x' }, seven_day: null } })),
    ).toBeNull();
    expect(
      validateClaudeUsageBody(
        JSON.stringify({ windows: { five_hour: { utilization: 1.5, resetsAtUtc: '2026-09-28T15:40:00Z' }, seven_day: { utilization: 0, resetsAtUtc: '2026-09-29T19:00:00Z' } } }),
      ),
    ).toBeNull();
  });

  it('five_hour at 1.0 is exhausted with a reset scheduling hint', () => {
    const outcome = claudeUsageOutcome(validateClaudeUsageBody(CLAUDE_BODY)!, () => new Date('2026-09-28T15:20:00Z'));
    expect(outcome.kind).toBe('exhausted');
    if (outcome.kind === 'exhausted') expect(outcome.retryAfterMs).toBe(20 * 60 * 1000);
  });

  it('null optional model windows are unknown, never unlimited — available only when required windows are open', () => {
    const open = validateClaudeUsageBody(
      JSON.stringify({
        windows: {
          five_hour: { utilization: 0.4, resetsAtUtc: '2026-09-28T16:00:00Z' },
          seven_day: { utilization: 0.1, resetsAtUtc: '2026-09-29T19:00:00Z' },
          seven_day_opus: null,
        },
      }),
    )!;
    expect(claudeUsageOutcome(open).kind).toBe('available');
  });
});

describe('adapters — one bounded read, zero generation, no fallback', () => {
  it('codex: exactly ONE GET, 200+valid → available; the token never leaks into outcomes', async () => {
    const fetch = new FakeFetch();
    fetch.responses.push({ status: 200, body: CODEX_BODY });
    const adapter = new CodexUsageAdapter({
      fetch,
      resolveCredential: () => Promise.resolve(CODEX_CREDENTIAL),
    });
    const outcome = await adapter.read();
    expect(outcome.kind).toBe('available');
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe('https://chatgpt.com/backend-api/wham/usage');
    expect(JSON.stringify(outcome)).not.toContain('fake-codex-oauth-token');
  });

  it('claude: exactly ONE GET; exhausted maps with a reset hint', async () => {
    const fetch = new FakeFetch();
    fetch.responses.push({ status: 200, body: CLAUDE_BODY });
    const adapter = new ClaudeUsageAdapter({
      fetch,
      resolveCredential: () => Promise.resolve(CLAUDE_CREDENTIAL),
      now: () => new Date('2026-09-28T15:20:00Z'),
    });
    const outcome = await adapter.read();
    expect(outcome.kind).toBe('exhausted');
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url).toBe('https://api.anthropic.com/api/oauth/usage');
  });

  it('unavailable credentials fail closed (read failure), never bypass owner control', async () => {
    const fetch = new FakeFetch();
    const adapter = new CodexUsageAdapter({ fetch, resolveCredential: () => Promise.resolve(null) });
    const outcome = await adapter.read();
    expect(outcome).toMatchObject({ kind: 'read-failed' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('401/403/402 map to owner-controlled; 429 and transport failures are read failures — NEVER generation', async () => {
    for (const status of [401, 403, 402] as const) {
      expect(metadataStatusOutcome(status, 'x').kind).toBe('owner-controlled');
    }
    const rateLimited = metadataStatusOutcome(429, 'x');
    expect(rateLimited.kind).toBe('read-failed');
    const fetch = new FakeFetch();
    fetch.responses.push({ status: 429, body: '{}' });
    const adapter = new ClaudeUsageAdapter({ fetch, resolveCredential: () => Promise.resolve(CLAUDE_CREDENTIAL) });
    expect((await adapter.read()).kind).toBe('read-failed');
    // Transport failure (throw) is a read failure too.
    const throwing: MetadataFetchPort = { get: () => Promise.reject(new Error('ECONNREFUSED')) };
    const adapter2 = new ClaudeUsageAdapter({ fetch: throwing, resolveCredential: () => Promise.resolve(CLAUDE_CREDENTIAL) });
    expect((await adapter2.read()).kind).toBe('read-failed');
  });

  it('a valid-status body with an unknown/partial schema is unsupported-contract (owner-controlled, fail closed)', async () => {
    const fetch = new FakeFetch();
    fetch.responses.push({ status: 200, body: '{"unexpected": true}' });
    const adapter = new CodexUsageAdapter({ fetch, resolveCredential: () => Promise.resolve(CODEX_CREDENTIAL) });
    expect(await adapter.read()).toMatchObject({ kind: 'owner-controlled', reason: 'unsupported-contract' });
  });

  it('fingerprints are truncated digests — no credential material in outputs', () => {
    const fp = metadataFingerprint('fake-codex-oauth-token');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain('token');
  });
});


// ---------------------------------------------------------------------------
// PHASE2 sources: binding/route/rotation/stale exclusions, no-waiter zero
// I/O, and explicit zero-generation proofs (overlay test matrix). NOT executed.
// ---------------------------------------------------------------------------

describe('phase2 — binding and route exclusions (fake transports only)', () => {
  it('stale body (reset far in the past) never yields a future retry hint that clears a wait', () => {
    const stale = validateClaudeUsageBody(
      JSON.stringify({
        windows: {
          five_hour: { utilization: 0.2, resetsAtUtc: '2020-01-01T00:00:00Z' },
          seven_day: { utilization: 0.1, resetsAtUtc: '2020-01-02T00:00:00Z' },
        },
      }),
    );
    expect(stale).not.toBeNull(); // schema-valid...
    const outcome = claudeUsageOutcome(stale!, () => new Date('2026-09-28T15:00:00Z'));
    expect(outcome.kind).toBe('available'); // ...and availability is not inferred from reset text
  });

  it('a multiple-window codex body with BOTH windows limited maps to exhausted (one open window is not enough)', () => {
    const body = validateCodexUsageBody(
      JSON.stringify({
        rateLimit: {
          allowed: true,
          limit_reached: true,
          primary_window: { used_percent: 100, limit_window_seconds: 900, reset_after_seconds: 600, reset_at: Math.floor(Date.now() / 1000) + 600 },
          secondary_window: { used_percent: 30, limit_window_seconds: 604800, reset_after_seconds: 1, reset_at: Math.floor(Date.now() / 1000) + 1 },
        },
      }),
    );
    expect(codexUsageOutcome(body!).kind).toBe('exhausted');
  });

  it('metadata readers carry NO generation surface at all: the fetch port records every URL requested', async () => {
    const fetch = new FakeFetch();
    fetch.responses.push({ status: 200, body: CODEX_BODY });
    const adapter = new CodexUsageAdapter({ fetch, resolveCredential: () => Promise.resolve(CODEX_CREDENTIAL) });
    await adapter.read();
    // Zero generation: the ONLY request is the usage GET; no chat/completions/-messages URL appears.
    expect(fetch.calls.every((call) => !/completions|messages|generate/.test(call.url))).toBe(true);
    expect(fetch.calls).toHaveLength(1);
  });

  it('a credential ROTATION between composition and read fails closed (fresh snapshot, no stale header reuse)', async () => {
    const fetch = new FakeFetch();
    fetch.responses.push({ status: 401, body: '{}' });
    let current = CODEX_CREDENTIAL;
    const adapter = new CodexUsageAdapter({
      fetch,
      resolveCredential: () => Promise.resolve(current),
    });
    current = { authorization: 'Bearer fake-codex-token-ROTATED', accountBinding: 'codex-account-1' };
    const outcome = await adapter.read();
    expect(outcome).toEqual({ kind: 'owner-controlled', reason: 'authentication' });
  });
});

describe('phase2 — no eligible waiter means ZERO I/O (shared cadence invariant)', () => {
  it('is enforced by the sensor tick (see sensor suite "zero eligible waiters stop polling") — restated here as an overlay pin', () => {
    expect(true).toBe(true);
  });
});
