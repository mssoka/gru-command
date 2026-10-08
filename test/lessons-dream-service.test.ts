import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BibleStore } from '../src/lessons/bible.js';
import { JournalStore } from '../src/lessons/journal.js';
import {
  DREAM_STATE_FILE,
  DreamEngine,
  LessonProposals,
  lessonProposalNotifier,
  loadDreamState,
  PROPOSAL_FILE,
  saveDreamState,
  type DistillInput,
  type DreamState,
} from '../src/lessons/dream.js';
import type { ProposedChapter } from '../src/lessons/types.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
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
    // An existing book: one chapter and its INDEX, written before the service starts.
    const seeded = new BibleStore(join(home, 'bible'));
    seeded.ensureSeeded();
    seeded.applyUpdates(
      [{ slug: 'model-policy', title: 'Model policy', summary: 'Which model does what.', tags: ['models'], lessons: [{ slug: 'sol', body: 'Silas runs on Sol.', journalIds: ['j-0'] }] }],
      new Map([['j-0', '2026-10-01T00:00:00.000Z']]),
    );
    const entry = new JournalStore(join(home, 'journal')).append({ kind: 'finding', source: 'gru', body: 'a live shell held the restart' });
    const token = 'dream-approval-token';
    const bibleDir = join(home, 'bible');
    const chapters = (): string[] => (existsSync(join(bibleDir, 'chapters')) ? readdirSync(join(bibleDir, 'chapters')).sort() : []);
    /** Every managed byte of the book, plus the dream cursor file. */
    const managed = (): Record<string, string | null> => ({
      'INDEX.md': readFileSync(join(bibleDir, 'INDEX.md'), 'utf-8'),
      ...Object.fromEntries(chapters().map((name) => [`chapters/${name}`, readFileSync(join(bibleDir, 'chapters', name), 'utf-8')])),
      '.dream-state.json': existsSync(join(bibleDir, '.dream-state.json')) ? readFileSync(join(bibleDir, '.dream-state.json'), 'utf-8') : null,
    });
    // Captured BEFORE the service starts (C1): a boot that wrote anything
    // unapproved into the book would show up as a difference.
    const before = managed();
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
      expect(managed()).toEqual(before); // not one managed byte before the owner decides
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
      const plan = (JSON.parse(readFileSync(join(bibleDir, '.proposal.json'), 'utf-8')) as {
        plan: { writes: { slug: string; text: string }[]; indexText: string };
      }).plan;
      const accepted = await api('POST', `/api/lessons/proposal/${String(review['id'])}/accept`);
      expect(accepted.status).toBe(200);
      // Exactly the planned bytes — the new chapter and INDEX — and nothing else changed.
      expect(chapters()).toEqual(['model-policy.md', 'ops-restarts.md']);
      expect(plan.writes.map((write) => write.slug)).toEqual(['ops-restarts']);
      expect(readFileSync(join(bibleDir, 'chapters', 'ops-restarts.md'), 'utf-8')).toBe(plan.writes[0]!.text);
      expect(readFileSync(join(bibleDir, 'INDEX.md'), 'utf-8')).toBe(plan.indexText);
      expect(readFileSync(join(bibleDir, 'chapters', 'model-policy.md'), 'utf-8')).toBe(before['chapters/model-policy.md']);
      // Every field, independently of the plan: the chapter the reviewed
      // lesson makes, citing the captured journal entry.
      expect(new BibleStore(bibleDir).readChapter('ops-restarts')).toEqual({
        slug: 'ops-restarts',
        title: 'Ops restarts',
        summary: 'Restart discipline.',
        tags: ['ops'],
        lessons: [{ slug: 'close-the-shell', body: reviewed, recurred: 1, provenance: [{ id: entry.id, ts: entry.ts }], tags: [] }],
      });
      expect(cursor()).toBe(1);
      expect((await api('GET', '/api/lessons/proposal')).status).toBe(404);
      const resolvedDb = new DatabaseSync(join(home, 'ledger', 'ledger.db'), { readOnly: true });
      try {
        const row = resolvedDb.prepare('SELECT resolved_by FROM notifications WHERE id = ?').get(String(review['notificationId'])) as { resolved_by: string | null };
        expect(row.resolved_by).toBe('owner:accepted');
      } finally {
        resolvedDb.close();
      }
    } finally {
      await service.stop();
    }
  }, 60_000);
});

describe('compiled service: recovery closes the failure incident (#253 round 5, R5-A11)', () => {
  it('a failing boot raises the incident; a restart whose pass completes resolves THAT row by the dream, with no replacement', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-dream-recovery-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-dream-recovery-workspace-'));
    cleanup.push(home, workspace);
    new JournalStore(join(home, 'journal')).append({ kind: 'finding', source: 'gru', body: 'a live shell held the restart' });
    const rows = (): { id: string; resolved_by: string | null }[] => {
      const db = new DatabaseSync(join(home, 'ledger', 'ledger.db'), { readOnly: true });
      try {
        return db.prepare("SELECT id, resolved_by FROM notifications WHERE kind = 'lessons.dream-failed' ORDER BY rowid").all() as { id: string; resolved_by: string | null }[];
      } finally {
        db.close();
      }
    };
    const boot = async (preload: string) => startRealService({
      port: await pickFreePort(), token: 'dream-recovery-token', home, workspace, keepHome: true, requireWebDist: false,
      nodeImport: join(import.meta.dirname, 'helpers', preload),
    });
    const failing = await boot('dream-fails.mjs');
    let incident: string;
    try {
      incident = await vi.waitFor(() => {
        const open = rows().filter((row) => row.resolved_by === null);
        expect(open).toHaveLength(1);
        return open[0]!.id;
      }, { timeout: 20_000, interval: 250 });
    } finally {
      await failing.stop();
    }
    const recovered = await boot('dream-distills.mjs');
    try {
      await vi.waitFor(() => {
        expect(rows()).toEqual([{ id: incident, resolved_by: 'dream' }]);
      }, { timeout: 20_000, interval: 250 });
    } finally {
      await recovered.stop();
    }
  }, 90_000);
});

describe('compiled service: startup finishes a recorded decision without another POST (#253 round 5, C11)', () => {
  const twoChapters = (ids: readonly string[]): ProposedChapter[] => [
    { slug: 'ops-restarts', title: 'Ops restarts', summary: 'Restart discipline.', tags: ['ops'], lessons: [{ slug: 'close-the-shell', body: 'Close the live shell first.', journalIds: [...ids] }] },
    { slug: 'review-rounds', title: 'Review rounds', summary: 'Review discipline.', tags: ['review'], lessons: [{ slug: 'fix-everything', body: 'Fix every finding.', journalIds: [...ids] }] },
  ];

  /** A home whose proposal was ACCEPTED and then interrupted at `phase`,
   * with a dream that is not due — so only startup reconciliation can
   * finish it. Returns what the finished book and cursor must be. */
  async function interruptedAccept(phase: 'partially-applied' | 'cursor-persisted' | 'committed-cleanup') {
    const home = mkdtempSync(join(tmpdir(), `gru-dream-restart-${phase}-`));
    cleanup.push(home);
    const journal = new JournalStore(join(home, 'journal'));
    const entry = journal.append({ kind: 'finding', source: 'gru', body: 'a live shell held the restart' });
    const bible = new BibleStore(join(home, 'bible'));
    bible.ensureSeeded();
    const stateFile = join(bible.dir, DREAM_STATE_FILE);
    saveDreamState(stateFile, { ...loadDreamState(stateFile), lastDreamAt: new Date().toISOString() }); // not due
    const db = new LedgerDb(home); // the service's own ledger (<home>/ledger/ledger.db)
    try {
      const bus = new EventBus();
      const ledger = new LedgerApi(db.handle, { bus });
      const notifications = new NotificationCenter({ ledger, bus });
      const notifier = lessonProposalNotifier({ notifications, ledger });
      const proposals = new LessonProposals({ bible, notifier });
      const distill = async (input: DistillInput) => ({ chapters: twoChapters(input.entries.map((item) => item.id)) });
      await new DreamEngine({ journal, bible, distiller: { distill }, proposals }).run();
      const file = join(bible.dir, PROPOSAL_FILE);
      const record = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown> & {
        id: string; notificationId: string; nextState: DreamState; plan: { writes: { slug: string; text: string }[]; indexText: string };
      };
      const decided = { ...record, decision: { kind: 'accepted', at: new Date().toISOString(), detail: null } };
      if (phase === 'partially-applied') {
        writeFileSync(join(bible.chaptersDir, `${record.plan.writes[0]!.slug}.md`), record.plan.writes[0]!.text);
        writeFileSync(file, JSON.stringify(decided));
      } else {
        bible.applyPlan(record.plan as never);
        saveDreamState(stateFile, record.nextState);
        writeFileSync(file, JSON.stringify(phase === 'committed-cleanup' ? { ...decided, committed: { at: new Date().toISOString() } } : decided));
      }
      return { home, file, record, throughSeq: entry.seq };
    } finally {
      db.close();
    }
  }

  for (const phase of ['partially-applied', 'cursor-persisted', 'committed-cleanup'] as const) {
    it(`${phase}: the restart writes exactly the plan, advances the cursor, resolves the row and removes the record`, async () => {
      const { home, file, record, throughSeq } = await interruptedAccept(phase);
      const workspace = mkdtempSync(join(tmpdir(), 'gru-dream-restart-workspace-'));
      cleanup.push(workspace);
      const service = await startRealService({
        port: await pickFreePort(), token: 'dream-restart-token', home, workspace, keepHome: true, requireWebDist: false,
      });
      try {
        await vi.waitFor(() => expect(existsSync(file)).toBe(false), { timeout: 20_000, interval: 250 });
      } finally {
        await service.stop();
      }
      const bibleDir = join(home, 'bible');
      for (const write of record.plan.writes) {
        expect(readFileSync(join(bibleDir, 'chapters', `${write.slug}.md`), 'utf-8')).toBe(write.text);
      }
      expect(readFileSync(join(bibleDir, 'INDEX.md'), 'utf-8')).toBe(record.plan.indexText);
      expect(loadDreamState(join(bibleDir, DREAM_STATE_FILE)).coveredThroughSeq).toBe(throughSeq);
      const db = new DatabaseSync(join(home, 'ledger', 'ledger.db'), { readOnly: true });
      try {
        expect(db.prepare('SELECT resolved_by FROM notifications WHERE id = ?').get(record.notificationId)).toEqual({ resolved_by: 'owner:accepted' });
      } finally {
        db.close();
      }
    }, 60_000);
  }
});
