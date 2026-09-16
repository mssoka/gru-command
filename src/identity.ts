import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface InstallIdentity {
  readonly installId: string;
  readonly createdAt: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * Stable install id (SPEC ruling 5: /health exposes an identity fingerprint).
 * Created once per instance data dir; every later boot reuses the same id.
 * The write is atomic (temp file + rename) so a crash mid-write can never
 * leave a truncated file behind.
 */
export function loadOrCreateIdentity(dataDir: string): InstallIdentity {
  const dir = join(dataDir, 'identity');
  const file = join(dir, 'identity.json');
  if (existsSync(file)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno !== undefined) {
        throw new Error(`cannot read identity file ${file}: ${errno} — check permissions`);
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // Fail loud on genuine corruption: silently regenerating would churn
      // the install fingerprint. The message tells the operator exactly how
      // to recover.
      throw new Error(
        `corrupt identity file ${file}: ${(error as Error).message} — delete it to regenerate`,
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !isNonEmptyString((parsed as Record<string, unknown>)['install_id']) ||
      !isNonEmptyString((parsed as Record<string, unknown>)['created_at'])
    ) {
      throw new Error(
        `corrupt identity file ${file}: expected non-empty {install_id, created_at} — delete it to regenerate`,
      );
    }
    const record = parsed as Record<string, string>;
    return { installId: record['install_id']!, createdAt: record['created_at']! };
  }
  const identity: InstallIdentity = {
    installId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dir, { recursive: true });
  const onDisk = { install_id: identity.installId, created_at: identity.createdAt };
  const staging = join(dir, `.identity.json.tmp-${process.pid}`);
  writeFileSync(staging, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf-8');
  renameSync(staging, file);
  return identity;
}
