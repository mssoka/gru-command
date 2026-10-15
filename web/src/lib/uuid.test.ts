/**
 * Unit tests for the uuidV4 helper — both native and insecure-context
 * fallback modes, with RFC 4122 §4.4 bit-level assertions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuidV4 } from './uuid.js';
import { stubInsecureCrypto, UUID_V4_RE } from './uuid-test-support.js';

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

  it('throws an actionable error when no Web Crypto exists at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => uuidV4()).toThrow('Web Crypto is unavailable in this context; cannot mint message ids');
  });

  it('throws when crypto exists with neither randomUUID nor getRandomValues', () => {
    vi.stubGlobal('crypto', {});
    expect(() => uuidV4()).toThrow('Web Crypto is unavailable');
  });

  it('does not swallow a native randomUUID that throws (deliberate fail-loud, no entropy swap)', () => {
    const getRandomValues = vi.fn();
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new Error('native randomUUID exploded');
      },
      getRandomValues,
    });
    expect(() => uuidV4()).toThrow('native randomUUID exploded');
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('error messages carry no invented "gru:" namespace prefix (repo idiom: message-named errors)', () => {
    vi.stubGlobal('crypto', undefined);
    let message: string | undefined;
    try {
      uuidV4();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Web Crypto is unavailable in this context; cannot mint message ids');
    expect(message?.startsWith('gru:')).toBe(false);
  });
});
