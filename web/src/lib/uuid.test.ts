/**
 * Unit tests for the uuidV4 helper — both native and insecure-context
 * fallback modes, with RFC 4122 §4.4 bit-level assertions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuidV4 } from './uuid.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Secure-context-like stub: native randomUUID delegates a sentinel so the
 * test can prove the helper prefers it verbatim. getRandomValues passes
 * through so a future native-path consult of it cannot crash misleadingly. */
function stubSecureCrypto(): void {
  const real = globalThis.crypto;
  vi.stubGlobal('crypto', {
    randomUUID: () => 'native-was-used-verbatim',
    getRandomValues: <T extends ArrayBufferView>(array: T): T => real.getRandomValues(array),
  });
}

/** Insecure-context stub: getRandomValues only, randomUUID absent. */
function stubInsecureCrypto(): void {
  const real = globalThis.crypto;
  vi.stubGlobal('crypto', {
    getRandomValues: <T extends ArrayBufferView>(array: T): T => real.getRandomValues(array),
  });
  expect((globalThis.crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
}

describe('uuidV4', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers native crypto.randomUUID when the context provides it', () => {
    stubSecureCrypto();
    expect(uuidV4()).toBe('native-was-used-verbatim');
  });

  it('falls back to getRandomValues with correct v4 bits when randomUUID is absent', () => {
    stubInsecureCrypto();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const id = uuidV4();
      expect(id).toMatch(UUID_V4_RE);
      expect(id[14]).toBe('4');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
      seen.add(id);
    }
    expect(seen.size).toBe(200); // fresh randomness, never a constant
  });

  it('produces distinct UUIDs on consecutive calls in the insecure mode', () => {
    stubInsecureCrypto();
    expect(uuidV4()).not.toBe(uuidV4());
  });

  it('sources fallback bytes from crypto.getRandomValues (known answer)', () => {
    // Insecure shape (randomUUID absent) with deterministic entropy: byte
    // i is filled with i. Proves the bytes actually come from
    // getRandomValues — a Math.random() implementation cannot produce it.
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array): Uint8Array => {
        array.forEach((_, i) => {
          array[i] = i;
        });
        return array;
      },
    });
    // bytes 0..15 with §4.4 bits applied: byte6 06→46, byte8 08→88.
    expect(uuidV4()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('throws a named error when no Web Crypto exists at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => uuidV4()).toThrow('gru: Web Crypto is unavailable');
  });
});
