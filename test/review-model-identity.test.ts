import { describe, expect, it } from 'vitest';
import { isPublicModelToken, publicRecoveryModelIdentity } from '../src/runtime/review-model-identity.js';

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
    // Model ids are lowercase; mixed-case key/token material never enters
    // the persisted manifest as a "model".
    expect(claude('sk-ant-api03-Xy7Qk9LmN2pR4tVb8wZ1cD3fG5hJ')).toBe(false);
    expect(claude('anthropic/ghp_Ab12Cd34Ef56Gh78Ij90')).toBe(false);
    expect(claude('claude-opus-5-5', { settingsModel: 'sk-proj-AbCdEfGhIjKl' })).toBe(false);
    expect(isPublicModelToken('claude-opus-5-5')).toBe(true);
    expect(isPublicModelToken('Claude-Opus-5-5')).toBe(false);
    // Lowercase credential shapes are refused too: a long unbroken
    // alphanumeric run (hex/base32 keys, digests) or a UUID.
    expect(isPublicModelToken('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b')).toBe(false);
    expect(claude('anthropic/claude-5d41402abc4b2a76b9719d911017c592')).toBe(false);
    expect(claude('claude-opus-5-5', { settingsModel: '123e4567-e89b-12d3-a456-426614174000' })).toBe(false);
    expect(isPublicModelToken('us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(true);
    // Boundaries: a 23-character run is still a name segment, 24 is not; a
    // UUID is refused anywhere in the id.
    expect(isPublicModelToken(`claude-${'a'.repeat(23)}`)).toBe(true);
    expect(isPublicModelToken(`claude-${'a'.repeat(24)}`)).toBe(false);
    expect(isPublicModelToken('claude-123e4567-e89b-12d3-a456-426614174000')).toBe(false);
    expect(claude('claude-opus-5-5', { settingsModel: 'has space' })).toBe(false);
    expect(claude('claude-opus-5-5', { thinkingLevel: 'turbo' })).toBe(false);
    expect(publicRecoveryModelIdentity({ runtimeId: 'claude-code', modelRef: 'opus', routingSha256: 'x' })).toBe(false);
  });
});
