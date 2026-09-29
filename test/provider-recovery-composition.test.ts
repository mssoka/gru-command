import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  accountClaimFromAccessToken,
  claudeSnapshot,
  codexSnapshot,
  composeMetadataReaders,
  type NativeCommandPort,
} from '../src/provider-recovery/composition.js';
import { DEFAULT_PROVIDER_RECOVERY_CONFIG } from '../src/config.js';
import type { MetadataFetchPort } from '../src/provider-recovery/metadata.js';
import type { ProbeRoute } from '../src/provider-recovery/probe.js';

/**
 * Production metadata composition — FAKE stores and FAKE command ports
 * only: a temp-dir auth.json fixture for codex and an in-memory command
 * port for claude. Nothing here opens the real keychain, runs a resolver,
 * refreshes/login, or touches a provider. ZERO generation on these paths.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url(payload)}.test-signature`;
}

function authPathWith(credential: unknown, providerId = 'openai-codex'): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr-composition-auth-'));
  cleanupDirs.push(dir);
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify({ [providerId]: credential }));
  return path;
}

const NOW = Date.parse('2026-09-28T10:00:00Z');

describe('codex snapshot (nonmutating auth.json read — no store, no refresh)', () => {
  const access = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } });

  it('returns the JWT auth-claim account + truncated fingerprint for an unexpired OAuth credential', async () => {
    const path = authPathWith({ type: 'oauth', access, refresh: 'refresh-1', expires: NOW + 3_600_000 });
    const snapshot = await codexSnapshot({ authPath: path, now: () => NOW });
    expect(typeof snapshot).not.toBe('string');
    if (typeof snapshot === 'string') return;
    expect(snapshot.provider).toBe('openai-codex');
    expect(snapshot.accountClaim).toBe('acct-1');
    expect(snapshot.store).toBe('pi-auth-json-readonly');
    expect(snapshot.authorization).toBe(`Bearer ${access}`);
    expect(snapshot.credentialFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(snapshot.authorization).not.toContain('refresh-1'); // refresh material never travels
  });

  it('rejects API-key credentials, expired tokens, missing stores, and claim-less tokens', async () => {
    expect(await codexSnapshot({ authPath: authPathWith({ type: 'api_key', key: 'sk-ambient' }) })).toBe(
      'credential-wrong-kind',
    );
    expect(
      await codexSnapshot({ authPath: authPathWith({ type: 'oauth', access, refresh: 'r', expires: NOW - 1 }), now: () => NOW }),
    ).toBe('credential-expired');
    expect(await codexSnapshot({ authPath: join(tmpdir(), `missing-${process.pid}-${NOW}`, 'auth.json') })).toBe(
      'credential-missing',
    );
    expect(
      await codexSnapshot({
        authPath: authPathWith({ type: 'oauth', access: 'not-a-jwt', refresh: 'r', expires: NOW + 1000 }),
        now: () => NOW,
      }),
    ).toBe('account-claim-missing');
  });

  it('accountClaimFromAccessToken reads the client-traced auth claim (chatgpt_account_id first)', () => {
    expect(
      accountClaimFromAccessToken(fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-a', user_id: 'user-b' } })),
    ).toBe('acct-a');
    expect(accountClaimFromAccessToken(fakeJwt({ 'https://api.openai.com/auth': { user_id: 'user-b' } }))).toBe('user-b');
    expect(accountClaimFromAccessToken('opaque')).toBeNull();
    expect(accountClaimFromAccessToken('a.%%%.c')).toBeNull();
  });
});

class FakeCommandPort implements NativeCommandPort {
  result: { readonly exitCode: number; readonly stdout: string } | null = null;
  readonly calls: { readonly service: string; readonly account: string }[] = [];
  findGenericPassword(input: { readonly service: string; readonly account: string }) {
    this.calls.push(input);
    return Promise.resolve(this.result);
  }
}

const CLAUDE_CREDENTIAL = {
  claudeAiOauth: {
    accessToken: 'claude-access-token',
    refreshToken: 'claude-refresh-token',
    expiresAt: NOW + 3_600_000,
    subscription: 'pro',
  },
};

describe('native-claude snapshot (selected keychain store, observed platform — never a brand flag)', () => {
  it('reads the traced claudeAiOauth wrapper from the selected item only', async () => {
    const command = new FakeCommandPort();
    command.result = { exitCode: 0, stdout: JSON.stringify(CLAUDE_CREDENTIAL) };
    const snapshot = await claudeSnapshot({
      command,
      context: { overridesPresent: false },
      account: 'fixture-user',
      now: () => NOW,
    });
    expect(typeof snapshot).not.toBe('string');
    if (typeof snapshot === 'string') return;
    expect(snapshot.provider).toBe('anthropic-claude-native');
    expect(snapshot.authorization).toBe('Bearer claude-access-token');
    expect(snapshot.accountClaim).toBe('fixture-user'); // the selected keychain account is the observed identity
    expect(snapshot.store).toBe('macos-keychain:Claude Code-credentials');
    expect(command.calls).toEqual([{ service: 'Claude Code-credentials', account: 'fixture-user' }]);
  });

  it('rejects overrides, missing items, expired tokens, wrong subscriptions, and malformed stores', async () => {
    const command = new FakeCommandPort();
    command.result = { exitCode: 0, stdout: JSON.stringify(CLAUDE_CREDENTIAL) };
    expect(
      await claudeSnapshot({ command, context: { overridesPresent: true }, account: 'fixture-user', now: () => NOW }),
    ).toBe('context-override-present');
    command.result = null;
    expect(await claudeSnapshot({ command, context: { overridesPresent: false }, account: 'fixture-user', now: () => NOW })).toBe(
      'credential-missing',
    );
    command.result = { exitCode: 1, stdout: '' };
    expect(await claudeSnapshot({ command, context: { overridesPresent: false }, account: 'fixture-user', now: () => NOW })).toBe(
      'credential-missing',
    );
    command.result = {
      exitCode: 0,
      stdout: JSON.stringify({ claudeAiOauth: { ...CLAUDE_CREDENTIAL.claudeAiOauth, expiresAt: NOW - 1 } }),
    };
    expect(await claudeSnapshot({ command, context: { overridesPresent: false }, account: 'fixture-user', now: () => NOW })).toBe(
      'credential-expired',
    );
    command.result = {
      exitCode: 0,
      stdout: JSON.stringify({ claudeAiOauth: { ...CLAUDE_CREDENTIAL.claudeAiOauth, subscription: 'enterprise-x' } }),
    };
    expect(await claudeSnapshot({ command, context: { overridesPresent: false }, account: 'fixture-user', now: () => NOW })).toBe(
      'credential-wrong-kind',
    );
    command.result = { exitCode: 0, stdout: 'not json' };
    expect(await claudeSnapshot({ command, context: { overridesPresent: false }, account: 'fixture-user', now: () => NOW })).toBe(
      'credential-wrong-kind',
    );
  });

  it('accepts the flat credential shape and an explicit email claim', async () => {
    const command = new FakeCommandPort();
    command.result = {
      exitCode: 0,
      stdout: JSON.stringify({
        accessToken: 'flat-token',
        expiresAt: NOW + 1000,
        emailAddress: 'owner@example.test',
      }),
    };
    const snapshot = await claudeSnapshot({
      command,
      context: { overridesPresent: false },
      account: 'fixture-user',
      now: () => NOW,
    });
    expect(typeof snapshot).not.toBe('string');
    if (typeof snapshot === 'string') return;
    expect(snapshot.accountClaim).toBe('owner@example.test');
    // Missing/empty account fails closed before any I/O.
    expect(
      await claudeSnapshot({ command, context: { overridesPresent: false }, account: '', now: () => NOW }),
    ).toBe('account-claim-missing');
  });
});

describe('BoundMetadataReader — provider + credential-generation fencing, zero generation', () => {
  const CODEX_BODY = JSON.stringify({
    rateLimit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 12, limit_window_seconds: 604800, reset_after_seconds: 100, reset_at: 1791046722 },
      secondary_window: null,
    },
  });

  function makeReaders(authPath: string, fetchPort: MetadataFetchPort, account = 'fixture-user') {
    return composeMetadataReaders({
      config: { ...DEFAULT_PROVIDER_RECOVERY_CONFIG, probeTimeoutMs: 30_000 },
      fetch: fetchPort,
      codexAuthPath: authPath,
      claude: {
        command: new FakeCommandPort(),
        context: () => ({ overridesPresent: false }),
        account: () => account,
      },
    });
  }

  it('completes with ledger-safe evidence bound to the exact snapshot fingerprint + account header', async () => {
    const access = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } });
    // The production reader re-reads with the REAL clock; keep the fixture
    // unexpired in real time too.
    const authPath = authPathWith({ type: 'oauth', access, refresh: 'r', expires: Date.now() + 3_600_000 });
    const snapshot = await codexSnapshot({ authPath });
    if (typeof snapshot === 'string') throw new Error('fixture snapshot unexpectedly rejected');
    const calls: { url: string; extraHeaders?: Readonly<Record<string, string>> }[] = [];
    const fetchPort: MetadataFetchPort = {
      get: (input) => {
        calls.push({ url: input.url, ...(input.extraHeaders !== undefined ? { extraHeaders: input.extraHeaders } : {}) });
        return Promise.resolve({ status: 200, body: CODEX_BODY });
      },
    };
    const readers = makeReaders(authPath, fetchPort);
    const route: ProbeRoute = {
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      endpoint: 'https://chatgpt.com/backend-api/codex',
      credentialFingerprint: snapshot.credentialFingerprint,
    };
    const outcome = await readers['openai-codex']!.read(route);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.evidence).toMatchObject({
      adapter: 'codex-wham-usage',
      account_claim: 'acct-1',
      store: 'pi-auth-json-readonly',
    });
    // The request-side account binding rides the credential's OWN claim.
    expect(calls[0]?.extraHeaders).toEqual({ 'chatgpt-account-id': 'acct-1' });
    expect(calls[0]?.url).toBe('https://chatgpt.com/backend-api/wham/usage');
  });

  it('fails closed on credential rotation (fingerprint mismatch) and wrong providers', async () => {
    const access = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } });
    const authPath = authPathWith({ type: 'oauth', access, refresh: 'r', expires: Date.now() + 3_600_000 });
    let calls = 0;
    const fetchPort: MetadataFetchPort = {
      get: () => {
        calls += 1;
        return Promise.resolve({ status: 200, body: CODEX_BODY });
      },
    };
    const readers = makeReaders(authPath, fetchPort);
    const rotated = await readers['openai-codex']!.read({
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      endpoint: 'e',
      credentialFingerprint: 'ffffffffffffffff', // the waiter's binding no longer matches
    });
    expect(rotated.kind).toBe('probe-failed');
    if (rotated.kind === 'probe-failed') expect(rotated.reason).toContain('credential rotated');
    expect(calls).toBe(0); // never a request under a mismatched binding
    const wrongProvider = await readers['openai-codex']!.read({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      endpoint: 'e',
      credentialFingerprint: 'x',
    });
    expect(wrongProvider.kind).toBe('probe-failed');
    expect(calls).toBe(0);
  });

  it('claude metadata reads flow through the same reader contract (owner statuses preserve the hold)', async () => {
    const command = new FakeCommandPort();
    command.result = {
      exitCode: 0,
      stdout: JSON.stringify({
        claudeAiOauth: { ...CLAUDE_CREDENTIAL.claudeAiOauth, expiresAt: Date.now() + 3_600_000 },
      }),
    };
    const snapshot = await claudeSnapshot({
      command,
      context: { overridesPresent: false },
      account: 'fixture-user',
    });
    if (typeof snapshot === 'string') throw new Error('fixture snapshot unexpectedly rejected');
    let status = 200;
    const body = JSON.stringify({
      windows: {
        five_hour: { utilization: 0.2, resetsAtUtc: '2026-09-28T15:40:00Z' },
        seven_day: { utilization: 0.1, resetsAtUtc: '2026-09-29T19:00:00Z' },
      },
    });
    const fetchPort: MetadataFetchPort = {
      get: () => Promise.resolve({ status, body }),
    };
    const readers = composeMetadataReaders({
      config: { ...DEFAULT_PROVIDER_RECOVERY_CONFIG, probeTimeoutMs: 30_000 },
      fetch: fetchPort,
      claude: { command, context: () => ({ overridesPresent: false }), account: () => 'fixture-user' },
    });
    const route: ProbeRoute = {
      provider: 'anthropic-claude-native',
      model: 'claude-opus-4-1',
      endpoint: 'https://api.anthropic.com',
      credentialFingerprint: snapshot.credentialFingerprint,
    };
    const available = await readers['anthropic-claude-native']!.read(route);
    expect(available.kind).toBe('completed');
    status = 403;
    const forbidden = await readers['anthropic-claude-native']!.read(route);
    expect(forbidden.kind).toBe('probe-failed');
    if (forbidden.kind === 'probe-failed') expect(forbidden.reason).toContain('owner-controlled');
  });
});
