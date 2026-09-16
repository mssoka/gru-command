import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface InstallIdentity {
  readonly installId: string;
  readonly createdAt: string;
}

/**
 * Stable install id (SPEC ruling 5: /health exposes an identity fingerprint).
 * Created once per instance data dir; every later boot reuses the same id.
 */
export function loadOrCreateIdentity(dataDir: string): InstallIdentity {
  const dir = join(dataDir, 'identity');
  const file = join(dir, 'identity.json');
  if (existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (error) {
      throw new Error(
        `corrupt identity file ${file}: ${(error as Error).message} — delete it to regenerate`,
      );
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['install_id'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['created_at'] !== 'string'
    ) {
      throw new Error(
        `corrupt identity file ${file}: expected {install_id, created_at} — delete it to regenerate`,
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
  writeFileSync(file, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf-8');
  return identity;
}
