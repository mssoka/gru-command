import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickFreePort, startRealService } from './helpers/real-service.mjs';

/**
 * The failing-dream incident through the REAL composition (owner incident
 * 2026-10-07): the compiled service boots, its due boot dream pass fails,
 * and main's scheduler hooks must raise one action-required incident that
 * carries the repair command bound to THIS instance. Removing main's wiring
 * returns production to log-only failures — this test then fails.
 */

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

describe('compiled service: a failing lesson dream is an incident', () => {
  it('raises one action-required incident with this instance’s repair command', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-dream-incident-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-dream-incident-workspace-'));
    cleanup.push(home, workspace);
    const service = await startRealService({
      port: await pickFreePort(),
      token: 'dream-incident-token',
      home,
      workspace,
      keepHome: true,
      requireWebDist: false,
      nodeImport: join(import.meta.dirname, 'helpers', 'dream-fails.mjs'),
    });
    try {
      await vi.waitFor(
        () => {
          const db = new DatabaseSync(join(home, 'ledger', 'ledger.db'), { readOnly: true });
          try {
            const rows = db
              .prepare("SELECT routing, detail FROM notifications WHERE kind = 'lessons.dream-failed' AND resolved_at IS NULL")
              .all() as { routing: string; detail: string }[];
            expect(rows).toHaveLength(1);
            expect(rows[0]!.routing).toBe('action-required');
            expect(rows[0]!.detail).toContain('forced dream failure (test preload)');
            expect(rows[0]!.detail).toContain(`GRU_COMMAND_HOME='${home}'`);
            expect(rows[0]!.detail).toContain('repair-bible-provenance.mjs');
          } finally {
            db.close();
          }
        },
        { timeout: 20_000, interval: 250 },
      );
    } finally {
      await service.stop();
    }
  }, 60_000);
});
