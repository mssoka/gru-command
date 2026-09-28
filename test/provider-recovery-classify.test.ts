import { describe, expect, it } from 'vitest';
import {
  classifyProviderRejection,
  extractProviderRejectionEvidence,
  providerSupportsSensor,
} from '../src/provider-recovery/classify.js';
import {
  credentialFingerprintOf,
  isCompletedProducerEvidence,
  PROBE_MAX_OUTPUT_TOKENS,
  PROBE_PROMPT,
  PROBE_TIMEOUT_MS,
  type ProbeRoute,
} from '../src/provider-recovery/probe.js';
import type { AssistantMessage } from '@earendil-works/pi-ai';

/**
 * Provider-aware classification (briefing acceptance 1/8/14): explicit
 * temporary-recoverable limits only; auth/permission/billing/ambiguous and
 * unsupported providers stay owner-controlled; evidence is never prose.
 */

const ROUTE: ProbeRoute = {
  provider: 'zai-coding-cn',
  model: 'glm-5.3',
  baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  credentialFingerprint: 'abc123',
};

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'openai-completions',
    provider: 'zai-coding-cn',
    model: 'glm-5.3',
    usage: {
      input: 3,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 4,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
    ...overrides,
  } as AssistantMessage;
}

describe('provider-aware classification — temporary vs owner-controlled', () => {
  it('HTTP 429 is temporary-recoverable (usage limit that resets)', () => {
    const outcome = classifyProviderRejection({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      status: 429,
      errorMessage: '429: {"error":{"code":"1302","message":"usage limit"}}',
    });
    expect(outcome).toEqual({ kind: 'temporary-recoverable', retryAfterMs: null });
  });

  it('GLM body code 1302/1308 is temporary-recoverable regardless of HTTP status', () => {
    for (const code of ['1302', '1308']) {
      const outcome = classifyProviderRejection({
        provider: 'zai-coding-cn',
        model: 'glm-5.3',
        status: 429,
        bodyCode: code,
        errorMessage: '429: {"error":{"code":"' + code + '"}}',
      });
      expect(outcome.kind).toBe('temporary-recoverable');
    }
  });

  it('a trustworthy Retry-After rides the temporary class as a hint', () => {
    const outcome = classifyProviderRejection({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      status: 429,
      retryAfterMs: 900_000,
      errorMessage: '429: rate limited',
    });
    expect(outcome).toEqual({ kind: 'temporary-recoverable', retryAfterMs: 900_000 });
  });

  it('authentication (401) stays owner-controlled', () => {
    expect(classifyProviderRejection({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      status: 401,
      errorMessage: '401: unauthorized',
    })).toEqual({ kind: 'owner-controlled', reason: 'authentication' });
  });

  it('permission (403) stays owner-controlled', () => {
    expect(classifyProviderRejection({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      status: 403,
      errorMessage: '403: forbidden',
    })).toEqual({ kind: 'owner-controlled', reason: 'permission' });
  });

  it('billing (402 and GLM 1113 insufficient balance) stays owner-controlled', () => {
    expect(classifyProviderRejection({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      status: 402,
      errorMessage: '402: payment required',
    })).toEqual({ kind: 'owner-controlled', reason: 'billing' });
    expect(classifyProviderRejection({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      status: 429,
      bodyCode: '1113',
      errorMessage: '429: {"error":{"code":"1113","message":"Insufficient Balance"}}',
    })).toEqual({ kind: 'owner-controlled', reason: 'billing' });
  });

  it('unknown status with no body code is ambiguous → owner-controlled (fail toward owner)', () => {
    expect(classifyRejectionWithStatus(500)).toEqual({ kind: 'owner-controlled', reason: 'ambiguous' });
    expect(classifyRejectionWithStatus(undefined)).toEqual({ kind: 'owner-controlled', reason: 'ambiguous' });
  });

  it('missing provider/model identity is ambiguous — a wait cannot bind a route', () => {
    expect(classifyProviderRejection({
      provider: '',
      model: 'glm-5.3',
      status: 429,
      errorMessage: '429: limited',
    })).toEqual({ kind: 'owner-controlled', reason: 'ambiguous' });
  });

  function classifyRejectionWithStatus(status: number | undefined): { kind: string; reason: string } {
    const outcome = classifyProviderRejection({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      ...(status !== undefined ? { status } : {}),
      errorMessage: 'something odd',
    });
    return outcome as { kind: string; reason: string };
  }
});

describe('supported providers (v1 scope)', () => {
  it('only the installed China coding route has a verified sensor adapter', () => {
    expect(providerSupportsSensor('zai-coding-cn')).toBe(true);
    expect(providerSupportsSensor('zai')).toBe(false);
    expect(providerSupportsSensor('openai')).toBe(false);
    expect(providerSupportsSensor('anthropic')).toBe(false);
  });
});

describe('evidence extraction — machine shapes only, never prose', () => {
  it('parses the transport-composed "<status>: <json-body>" shape', () => {
    const evidence = extractProviderRejectionEvidence({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      errorMessage: '429: {"error":{"code":"1302","message":"quota exceeded"}}',
    });
    expect(evidence.status).toBe(429);
    expect(evidence.bodyCode).toBe('1302');
  });

  it('a bare status prefix parses; no status yields undefined, not a guess', () => {
    const bare = extractProviderRejectionEvidence({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      errorMessage: '429: too many requests',
    });
    expect(bare.status).toBe(429);
    expect(bare.bodyCode).toBeUndefined();

    const prose = extractProviderRejectionEvidence({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      errorMessage: 'the provider said quota-ish things about 429 maybe',
    });
    expect(prose.status).toBeUndefined();
    expect(prose.bodyCode).toBeUndefined();
  });

  it('non-JSON bodies yield no body code', () => {
    const evidence = extractProviderRejectionEvidence({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      errorMessage: '429: plain text body, no json',
    });
    expect(evidence.status).toBe(429);
    expect(evidence.bodyCode).toBeUndefined();
  });
});

describe('completed-producer evidence gate (acceptance 5)', () => {
  it('a completed protocol message with usage and content counts', () => {
    expect(isCompletedProducerEvidence(assistantMessage(), ROUTE)).toBe(true);
  });

  it('an error stop reason never counts', () => {
    const message = assistantMessage({ stopReason: 'error', errorMessage: '429: limited' });
    expect(isCompletedProducerEvidence(message, ROUTE)).toBe(false);
  });

  it('a pending/aborted/toolUse stop never counts', () => {
    expect(isCompletedProducerEvidence(assistantMessage({ stopReason: 'pending' }), ROUTE)).toBe(false);
    expect(isCompletedProducerEvidence(assistantMessage({ stopReason: 'aborted' }), ROUTE)).toBe(false);
    expect(isCompletedProducerEvidence(assistantMessage({ stopReason: 'toolUse' }), ROUTE)).toBe(false);
  });

  it('a message for a DIFFERENT provider or model is not route-bound evidence', () => {
    expect(
      isCompletedProducerEvidence(
        assistantMessage({ provider: 'openai' as never }),
        ROUTE,
      ),
    ).toBe(false);
    expect(
      isCompletedProducerEvidence(
        assistantMessage({ model: 'glm-5.3-flash' }),
        ROUTE,
      ),
    ).toBe(false);
  });

  it('a message without usage accounting is partial evidence — fail closed', () => {
    const message = assistantMessage();
    delete (message as Partial<AssistantMessage>).usage;
    expect(isCompletedProducerEvidence(message, ROUTE)).toBe(false);
  });

  it('an empty-content message is malformed evidence — fail closed', () => {
    expect(isCompletedProducerEvidence(assistantMessage({ content: [] }), ROUTE)).toBe(false);
  });
});

describe('probe envelope bounds (owner-approved pins)', () => {
  it('max output tokens pinned at 64, prompt fixed, timeout finite', () => {
    expect(PROBE_MAX_OUTPUT_TOKENS).toBe(64);
    expect(PROBE_PROMPT.length).toBeGreaterThan(0);
    expect(PROBE_PROMPT).not.toContain('briefing');
    expect(PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
    expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('credential fingerprints are truncated digests, never the credential', () => {
    const fingerprint = credentialFingerprintOf('ZAI-live-secret-key-value');
    expect(fingerprint).toHaveLength(16);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint).not.toContain('secret');
  });
});
