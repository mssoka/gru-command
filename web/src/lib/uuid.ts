/**
 * RFC 4122 v4 UUID minting that works in every browser context that
 * provides Web Crypto.
 *
 * `crypto.randomUUID` exists only in secure contexts (HTTPS, localhost,
 * 127.0.0.1). The product's own LAN bind-host feature serves the UI over
 * plain HTTP (e.g. `http://<hostname>.local:<port>`), where it is simply
 * absent — which made every chat send throw on LAN origins (v1.0.0 field
 * report). When `randomUUID` is unavailable we build the UUID from
 * `crypto.getRandomValues`, which IS available in insecure contexts,
 * setting the RFC 4122 §4.4 version and variant bits ourselves.
 * Dependency-free.
 */

/** A UUID v4 in any context: native `crypto.randomUUID` when the browser
 * provides it (secure contexts), otherwise v4 bytes from `getRandomValues`
 * with the version/variant bits applied. Throws a named error where no
 * Web Crypto exists at all — never a silent fallback. */
export function uuidV4(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new Error('gru: Web Crypto is unavailable in this context; cannot mint message ids');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // RFC 4122 §4.4: version 4 lives in the high nibble of byte 6; the
  // variant (10xx) lives in the top two bits of byte 8. DataView methods
  // keep the bit math free of index-access undefined-widening.
  const view = new DataView(bytes.buffer);
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x40);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
