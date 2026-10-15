import { describe, expect, it } from 'vitest';
import { publicRecoveryModelIdentity } from '../src/runtime/review-model-identity.js';

/**
 * Claude review recovery identity: model names are judged by shape, never
 * by a list of published names (a list goes stale with every model release
 * and silently drops crash recovery for current models).
 */
describe('publicRecoveryModelIdentity (claude-code)', () => {
  const claude = (modelRef: string, extra: { settingsModel?: string; thinkingLevel?: string } = {}) =>
    publicRecoveryModelIdentity({ runtimeId: 'claude-code', modelRef, ...extra });

  it('accepts current and future model ids, aliases and cloud spellings without a name list', () => {
    for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1',
      'claude-opus-9-1-20291231', 'opus', 'fable', 'opus[1m]', 'us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5@20261001']) {
      expect(claude(model), model).toBe(true);
      expect(claude(`anthropic/${model}`), `anthropic/${model}`).toBe(true);
    }
    expect(claude('claude-opus-5-5', { settingsModel: 'claude-sonnet-5-5', thinkingLevel: 'max' })).toBe(true);
  });

  it('refuses an unverifiable provider prefix, malformed models and unknown effort', () => {
    expect(claude('sk-live-secret/claude-opus-5-5')).toBe(false); // the CLI would silently discard it
    expect(claude('openai-codex/gpt-6-astra')).toBe(false);
    expect(claude('a/b/c')).toBe(false);
    expect(claude('')).toBe(false);
    expect(claude('claude opus')).toBe(false);
    expect(claude('claude-opus-5-5', { settingsModel: 'has space' })).toBe(false);
    expect(claude('claude-opus-5-5', { thinkingLevel: 'turbo' })).toBe(false);
    expect(publicRecoveryModelIdentity({ runtimeId: 'claude-code', modelRef: 'opus', routingSha256: 'x' })).toBe(false);
  });
});
