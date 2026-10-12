/**
 * Shared test support for the uuid suites (uuid.test.ts and
 * chat-client-insecure-uuid.test.ts). Deliberately NOT trusted blindly:
 * the stub self-checks its own shape, and uuid.test.ts keeps a
 * known-answer test with its own inline stub, so a broken helper cannot
 * make both suites pass vacuously.
 */
import { expect, vi } from 'vitest';

/** 8-4-4-4-12 hex, version nibble 4, variant high bits 10xx -> [89ab]. */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Insecure-context stub: crypto exists, getRandomValues works, and
 * randomUUID is simply not on the object (plain-HTTP LAN origins). */
export function stubInsecureCrypto(): void {
  const real = globalThis.crypto;
  vi.stubGlobal('crypto', {
    getRandomValues: <T extends ArrayBufferView>(array: T): T => real.getRandomValues(array),
  });
  expect((globalThis.crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
  expect(typeof globalThis.crypto.getRandomValues).toBe('function');
}
