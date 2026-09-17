import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Session-path helpers shared by every runtime adapter (pi, claude-code).
 * Extracted from the pi adapter in E3 so adapters normalize and guard
 * session files identically.
 */

/** Normalize like the pi SDK (tilde + file:// decode + resolve) so lock keys
 * and active-session keys always match the session's own path. */
export function normalizeSessionPath(input: string): string {
  let p = input;
  if (p === '~') return process.env['HOME'] ?? p;
  if (p.startsWith('~/')) p = join(process.env['HOME'] ?? '', p.slice(2));
  if (/^file:\/\//.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      /* leave as-is; resolve() will reject a bad path loudly */
    }
  }
  // resolve() is Node's path.resolve — join+normalize against cwd.
  return resolve(p);
}

/** A session file already hosted by this process must not be re-opened. */
export class SessionAlreadyActiveError extends Error {
  constructor(readonly file: string) {
    super(
      `session file ${file} is already hosted by this process — refusing to ` +
        'double-resume (single-writer rule, SPEC ruling 1/12)',
    );
    this.name = 'SessionAlreadyActiveError';
  }
}
