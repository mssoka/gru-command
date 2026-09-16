import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity } from '../src/identity.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-identity-'));
  cleanupDirs.push(dir);
  return dir;
}

function plantIdentity(dataDir: string, content: string): void {
  mkdirSync(join(dataDir, 'identity'), { recursive: true });
  writeFileSync(join(dataDir, 'identity', 'identity.json'), content, 'utf-8');
}

describe('identity fail-loud branches', () => {
  it('refuses a truncated/corrupt identity file, with recovery instructions', () => {
    const home = tmpHome();
    plantIdentity(home, '{install_id": "broken-json');
    expect(() => loadOrCreateIdentity(home)).toThrow(
      /corrupt identity file .* delete it to regenerate/,
    );
  });

  it('refuses a wrong-shaped identity file', () => {
    const home = tmpHome();
    plantIdentity(home, '{"install_id": 5, "created_at": "2026-01-01T00:00:00Z"}');
    expect(() => loadOrCreateIdentity(home)).toThrow(
      /corrupt identity file .* expected non-empty/,
    );
  });

  it('refuses empty-string identity fields', () => {
    const home = tmpHome();
    plantIdentity(home, '{"install_id": "", "created_at": ""}');
    expect(() => loadOrCreateIdentity(home)).toThrow(
      /corrupt identity file .* expected non-empty/,
    );
  });
});
