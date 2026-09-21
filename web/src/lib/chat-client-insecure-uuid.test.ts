/**
 * Insecure-context send-path phantom check.
 *
 * `crypto.randomUUID` exists ONLY in secure contexts (HTTPS, localhost,
 * 127.0.0.1). The product's LAN bind-host feature serves the UI over plain
 * HTTP (e.g. `http://<hostname>.local:<port>`), where it is simply absent —
 * and before the fallback, every send() threw
 * "could not send: globalThis.crypto.randomUUID is not a function".
 *
 * These tests stub the global crypto object to the insecure-context shape —
 * getRandomValues present, randomUUID ABSENT — inject no `idgen`, and run
 * the real send() path. The asserted UUID must carry the RFC 4122 version
 * and variant bits and must differ across calls; "did not throw" alone is
 * not acceptable evidence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatClient } from './chat-client.js';
import type { StorageLike } from '../theme.js';
import type { ChatClientEvents } from './chat-client.js';

/** 8-4-4-4-12 hex, version nibble 4, variant high bits 10xx → [89ab]. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const noopEvents: ChatClientEvents = {
  connection: () => {},
  messageStatus: () => {},
  frame: () => {},
  replayStart: () => {},
  replayEnd: () => {},
  fatal: () => {},
};

/** Simulate an insecure-context browser: crypto exists, getRandomValues
 * works, and randomUUID is simply not on the object. */
function stubInsecureCrypto(): void {
  const real = globalThis.crypto;
  vi.stubGlobal('crypto', {
    getRandomValues: <T extends ArrayBufferView>(array: T): T => real.getRandomValues(array),
  });
  expect((globalThis.crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
}

function newInsecureClient(idgen?: () => string): ChatClient {
  return new ChatClient(
    {
      token: 'insecure-token',
      host: 'Mosess-MacBook-Pro.local:7665',
      secure: false,
      storage: memStorage(),
      ...(idgen !== undefined ? { idgen } : {}),
    },
    noopEvents,
  );
}

describe('chat send over plain HTTP (crypto.randomUUID unavailable, no idgen)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('send() mints a fresh RFC 4122 v4 UUID per message instead of throwing', () => {
    stubInsecureCrypto();
    const client = newInsecureClient();
    const first = client.send('hello over plain http');
    const second = client.send('second send must differ');
    for (const id of [first.client_msg_id, second.client_msg_id]) {
      expect(id).toMatch(UUID_V4_RE);
      expect(id[14]).toBe('4'); // explicit version nibble
      expect(['8', '9', 'a', 'b']).toContain(id[19]); // explicit variant bits
    }
    expect(first.client_msg_id).not.toBe(second.client_msg_id);
  });

  it('an injected idgen keeps precedence even without crypto.randomUUID', () => {
    stubInsecureCrypto();
    let calls = 0;
    const client = newInsecureClient(() => `m${++calls}`);
    expect(client.send('injected wins').client_msg_id).toBe('m1');
    expect(client.send('still injected').client_msg_id).toBe('m2');
  });
});
