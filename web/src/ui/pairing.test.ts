import { describe, expect, it } from 'vitest';
import { buildPairingPayload } from './pairing.js';

/**
 * Pairing QR payload parity (Perkins r2 H4/W4): the phone scans what THIS
 * function encodes, so the exact byte shape is a wire contract. The
 * terminal wizard (src/wizard/steps.ts buildQrPayload) pins the same
 * canonical string from the other side — if either drifts, phone pairing
 * breaks with both suites green, so BOTH sides pin it.
 */
describe('pairing payload (QR wire contract)', () => {
  it('encodes the canonical {gru-command:1, url, token} shape, key order included', () => {
    expect(buildPairingPayload('http://127.0.0.1:7665', 'tok')).toBe(
      '{"gru-command":1,"url":"http://127.0.0.1:7665","token":"tok"}',
    );
  });

  it('escapes nothing silently: token bytes round-trip through JSON.parse', () => {
    const payload = buildPairingPayload('http://[::1]:7665', 'tok"with"quotes');
    const parsed = JSON.parse(payload) as { 'gru-command': number; url: string; token: string };
    expect(parsed['gru-command']).toBe(1);
    expect(parsed.url).toBe('http://[::1]:7665');
    expect(parsed.token).toBe('tok"with"quotes');
  });
});
