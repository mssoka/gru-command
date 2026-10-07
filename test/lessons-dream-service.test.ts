import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JournalStore } from '../src/lessons/journal.js';
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

describe('compiled service: a successful dream waits for the owner (owner decision 2026-10-07)', () => {
  it('proposes without touching the book or cursor; Accept over HTTP writes exactly the reviewed text', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-dream-approval-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-dream-approval-workspace-'));
    cleanup.push(home, workspace);
    new JournalStore(join(home, 'journal')).append({ kind: 'finding', source: 'gru', body: 'a live shell held the restart' });
    const token = 'dream-approval-token';
    const service = await startRealService({
      port: await pickFreePort(),
      token,
      home,
      workspace,
      keepHome: true,
      requireWebDist: false,
      nodeImport: join(import.meta.dirname, 'helpers', 'dream-distills.mjs'),
    });
    const api = async (method: string, path: string): Promise<{ status: number; json: Record<string, unknown> }> => {
      const response = await fetch(`http://127.0.0.1:${service.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    };
    const bibleDir = join(home, 'bible');
    const chapters = (): string[] => (existsSync(join(bibleDir, 'chapters')) ? readdirSync(join(bibleDir, 'chapters')) : []);
    const cursor = (): number =>
      existsSync(join(bibleDir, '.dream-state.json'))
        ? (JSON.parse(readFileSync(join(bibleDir, '.dream-state.json'), 'utf-8')) as { coveredThroughSeq: number }).coveredThroughSeq
        : 0;
    try {
      const review = await vi.waitFor(
        async () => {
          const pending = await api('GET', '/api/lessons/proposal');
          expect(pending.status).toBe(200);
          return pending.json;
        },
        { timeout: 20_000, interval: 250 },
      );
      expect(chapters()).toEqual([]); // nothing written before the owner decides
      expect(cursor()).toBe(0);
      const reviewed = ((review['chapters'] as { added: { body: string }[] }[])[0]!.added[0]!).body;
      expect(reviewed).toBe('Close the live shell before a restart (test preload).');
      const db = new DatabaseSync(join(home, 'ledger', 'ledger.db'), { readOnly: true });
      try {
        const row = db.prepare('SELECT routing, resolved_at FROM notifications WHERE id = ?').get(String(review['notificationId'])) as
          | { routing: string; resolved_at: string | null }
          | undefined;
        expect(row).toEqual({ routing: 'needs-owner', resolved_at: null });
      } finally {
        db.close();
      }
      const accepted = await api('POST', `/api/lessons/proposal/${String(review['id'])}/accept`);
      expect(accepted.status).toBe(200);
      expect(readFileSync(join(bibleDir, 'chapters', 'ops-restarts.md'), 'utf-8')).toContain(reviewed);
      expect(cursor()).toBe(1);
      expect((await api('GET', '/api/lessons/proposal')).status).toBe(404);
    } finally {
      await service.stop();
    }
  }, 60_000);
});
