import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Shared pairing-token verification (E6): the chat socket and the board's
 * HTTP/WS surfaces authenticate against the SAME per-install token with
 * the SAME constant-time comparison — one primitive, two doors, zero
 * drift. Hash-then-compare keeps the comparison length-invariant.
 */

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf-8').digest();
}

/** Constant-time token check against the configured token. */
export function tokenMatches(actual: string, configuredHash: Buffer): boolean {
  return timingSafeEqual(hashToken(actual), configuredHash);
}

/** True when a token is configured at all — an empty token is a locked door. */
export function tokenConfigured(configuredToken: string): boolean {
  return configuredToken !== '';
}
