/**
 * Running-build identity (board UX v4): the git revision the service was
 * BUILT from, stamped at build time by tools/write-build-rev.mjs into
 * dist/build-rev.json. Reading git HEAD at boot would lie after a pull
 * without a rebuild — the deploy-drift card renders exactly this file.
 *
 * The package version is stamped too: `gru-service version` must report
 * the version the build actually shipped, not a newer package.json left
 * by a pull that was never rebuilt.
 *
 * Missing/malformed artifact → all-null identity (the card shows
 * "unknown", never a guessed revision).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  /** Package version captured at BUILD time (null when the stamp predates
   * version stamping or was built outside a package). */
  readonly version: string | null;
  /** Build revision (null when built outside a git checkout). */
  readonly rev: string | null;
  /** Commit time of `rev` (ISO; null when unknown). */
  readonly committedAt: string | null;
  /** When the artifact was written (ISO; null when unknown). */
  readonly builtAt: string | null;
}

export const UNKNOWN_BUILD: BuildInfo = { version: null, rev: null, committedAt: null, builtAt: null };

/** Package root from this module's location: `<root>/src|dist/build-info.*`. */
export function defaultPackageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Read the build stamp; anything unreadable degrades to UNKNOWN_BUILD. */
export function readBuildInfo(packageRoot: string = defaultPackageRoot()): BuildInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(packageRoot, 'dist', 'build-rev.json'), 'utf-8'));
  } catch {
    return UNKNOWN_BUILD;
  }
  if (typeof parsed !== 'object' || parsed === null) return UNKNOWN_BUILD;
  const record = parsed as Record<string, unknown>;
  return {
    version: readString(record.version),
    rev: readString(record.rev),
    committedAt: readString(record.committedAt),
    builtAt: readString(record.builtAt),
  };
}
