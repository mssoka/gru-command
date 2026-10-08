import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { JournalStore } from '../src/lessons/journal.js';
import { BibleStore } from '../src/lessons/bible.js';
import { createBibleReferences } from '../src/lessons/references.js';
import { createLessonsServer } from '../src/lessons/server.js';
import { DREAM_STATE_FILE, DreamEngine, LessonProposals, lessonProposalNotifier, loadDreamState, PROPOSAL_FILE } from '../src/lessons/dream.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';

/**
 * Book of Lessons HTTP surface: the journal roundtrip (capture writers),
 * auth discipline, and the reference lookup that renders pointer lines.
 */

const TOKEN = 'lessons-test-token-éphémeral';
const BODY_SENTINEL = 'SECRET-CHAPTER-BODY-NEVER-IN-JSON';

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

interface Harness {
  port: number;
  journal: JournalStore;
  bible: BibleStore;
  proposals: LessonProposals;
  ledger: LedgerApi;
  close: () => Promise<void>;
}

async function boot(opts: { token?: string; withChapter?: boolean } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-lessons-server-'));
  cleanupDirs.push(dir);
  const token = opts.token ?? TOKEN;
  writeFileSync(
    join(dir, 'config.toml'),
    `${token === '' ? '' : `[auth]\ntoken = "${token}"\n`}[server]\nhost = "127.0.0.1"\nport = 0\n`,
    'utf-8',
  );
  const config = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const journal = new JournalStore(join(dir, 'journal'));
  const bible = new BibleStore(join(dir, 'bible'));
  bible.ensureSeeded();
  if (opts.withChapter === true) {
    bible.applyUpdates(
      [
        {
          slug: 'ops-restarts',
          title: 'Ops restarts',
          summary: 'Restart discipline for the hosted service.',
          tags: ['ops'],
          lessons: [
            {
              slug: 'shell-hang',
              body: `A live shell holds the session open. ${BODY_SENTINEL}`,
              tags: ['restarts', 'shell'],
              journalIds: ['j-1'],
            },
          ],
        },
      ],
      new Map([['j-1', '2026-09-23T00:00:00.000Z']]),
    );
  }
  const references = createBibleReferences({ bible, maxReferences: 3 });
  // The production notification chain: a real ledger behind the notifier.
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const proposals = new LessonProposals({ bible, notifier: lessonProposalNotifier({ notifications, ledger }) });
  const server = createLessonsServer({ config, journal, bible, references, proposals });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  return {
    port: (http.address() as AddressInfo).port,
    journal,
    bible,
    proposals,
    ledger,
    close: async () => {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      db.close();
    },
  };
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  return { status: res.status, json, text };
}

function field<T>(json: unknown, key: string): T {
  if (typeof json !== 'object' || json === null) throw new Error(`no json for field ${key}`);
  return (json as Record<string, unknown>)[key] as T;
}

describe('lessons server', () => {
  it('round-trips a journal entry: POST stores it, GET lists it back', async () => {
    const h = await boot();
    try {
      const posted = await call(
        h.port,
        'POST',
        '/api/journal',
        { kind: 'finding', source: 'gru', tags: ['repo:x'], body: 'the shell hang finding' },
        TOKEN,
      );
      expect(posted.status).toBe(201);
      const entry = field<Record<string, unknown>>(posted.json, 'entry');
      expect(entry).toMatchObject({
        seq: 1,
        id: 'j-1',
        kind: 'finding',
        source: 'gru',
        tags: ['repo:x'],
        body: 'the shell hang finding',
      });

      const listed = await call(h.port, 'GET', '/api/journal', undefined, TOKEN);
      expect(listed.status).toBe(200);
      expect(field<unknown[]>(listed.json, 'entries')).toHaveLength(1);
      expect(field<number>(listed.json, 'latest_seq')).toBe(1);

      const filtered = await call(h.port, 'GET', '/api/journal?after=1&limit=5', undefined, TOKEN);
      expect(field<unknown[]>(filtered.json, 'entries')).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('rejects unauthenticated access and unconfigured installs like every other surface', async () => {
    const h = await boot();
    try {
      expect((await call(h.port, 'GET', '/api/journal')).status).toBe(401);
      expect((await call(h.port, 'GET', '/api/journal', undefined, 'wrong-token')).status).toBe(401);
      expect(
        (await call(h.port, 'POST', '/api/journal', { kind: 'finding', source: 'gru', body: 'x' })).status,
      ).toBe(401);
    } finally {
      await h.close();
    }
    const unconfigured = await boot({ token: '' });
    try {
      const res = await call(unconfigured.port, 'GET', '/api/journal', undefined, 'anything');
      expect(res.status).toBe(503);
      expect(field<string>(res.json, 'error')).toBe('not_configured');
    } finally {
      await unconfigured.close();
    }
  });

  it('validates the append body loudly', async () => {
    const h = await boot();
    try {
      const badKind = await call(h.port, 'POST', '/api/journal', { kind: 'gossip', source: 'gru', body: 'x' }, TOKEN);
      expect(badKind.status).toBe(400);
      expect(field<string>(badKind.json, 'detail')).toMatch(/kind must be one of/);
      const noBody = await call(h.port, 'POST', '/api/journal', { kind: 'finding', source: 'gru' }, TOKEN);
      expect(noBody.status).toBe(400);
      expect(field<string>(noBody.json, 'detail')).toMatch(/body must be a string/);
      const badAfter = await call(h.port, 'GET', '/api/journal?after=nope', undefined, TOKEN);
      expect(badAfter.status).toBe(400);
      expect(field<string>(badAfter.json, 'detail')).toMatch(/after must be a non-negative integer/);
    } finally {
      await h.close();
    }
  });

  it('serves the index plus pointer lines — and never a chapter body', async () => {
    const h = await boot({ withChapter: true });
    try {
      const res = await call(h.port, 'GET', '/api/lessons?task=restart%20the%20shell', undefined, TOKEN);
      expect(res.status).toBe(200);
      const index = field<string>(res.json, 'index');
      expect(index).toContain('[ops-restarts](chapters/ops-restarts.md)');
      const references = field<Array<Record<string, unknown>>>(res.json, 'references');
      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({ chapter: 'ops-restarts', lesson: 'shell-hang' });
      expect(String(references[0]!['why'])).toMatch(/restart/);
      expect(String(references[0]!['path'])).toContain(join('chapters', 'ops-restarts.md'));
      // The pointer contract: location + reason only, no content.
      expect(res.text).not.toContain(BODY_SENTINEL);
    } finally {
      await h.close();
    }
  });

  it('answers an unknown /api/lessons route with 404 and empty-task lookups with no pointers', async () => {
    const h = await boot({ withChapter: true });
    try {
      const empty = await call(h.port, 'GET', '/api/lessons', undefined, TOKEN);
      expect(empty.status).toBe(200);
      expect(field<unknown[]>(empty.json, 'references')).toEqual([]);
      const unknown = await call(h.port, 'GET', '/api/lessons/nope', undefined, TOKEN);
      expect(unknown.status).toBe(404);
    } finally {
      await h.close();
    }
  });
});

describe('lesson proposals over HTTP (owner decision 2026-10-07)', () => {
  async function propose(h: Harness): Promise<{ id: string; notificationId: string }> {
    h.journal.append({ kind: 'finding', source: 'gru', body: 'shell hang finding' });
    const engine = new DreamEngine({
      journal: h.journal,
      bible: h.bible,
      proposals: h.proposals,
      distiller: {
        distill: async (input) => ({
          chapters: [
            {
              slug: 'ops-restarts',
              title: 'Ops restarts',
              summary: 'Restart discipline.',
              tags: ['ops'],
              lessons: [{ slug: 'shell-hang', body: 'Close the shell first.', journalIds: input.entries.map((entry) => entry.id) }],
            },
          ],
        }),
      },
    });
    await engine.run();
    return h.proposals.review()!;
  }

  const bookFiles = (bible: BibleStore): string =>
    JSON.stringify([bible.readIndexText(), ...readdirSync(bible.chaptersDir).sort().map((name) => readFileSync(join(bible.chaptersDir, name), 'utf-8'))]);
  const cursor = (bible: BibleStore): number => loadDreamState(join(bible.dir, DREAM_STATE_FILE)).coveredThroughSeq;

  it('Accept over HTTP writes the exact reviewed text, consumes the batch and resolves the For You row', async () => {
    const h = await boot();
    try {
      expect((await call(h.port, 'GET', '/api/lessons/proposal', undefined, TOKEN)).status).toBe(404);
      const { id, notificationId } = await propose(h);
      expect(h.ledger.getNotification(notificationId)).toMatchObject({ routing: 'needs-owner', resolvedAt: null });
      const review = await call(h.port, 'GET', '/api/lessons/proposal', undefined, TOKEN);
      expect(review.status).toBe(200);
      expect(review.json).toMatchObject({ id, notificationId, entries: 1 });
      const reviewedBody = (review.json as { chapters: { added: { body: string }[] }[] }).chapters[0]!.added[0]!.body;

      const wrong = await call(h.port, 'POST', '/api/lessons/proposal/not-it/accept', {}, TOKEN);
      expect(wrong.status).toBe(409);
      expect(wrong.json).toMatchObject({ error: 'proposal_mismatch' });
      expect(h.bible.readChapter('ops-restarts')).toBeNull();

      const accepted = await call(h.port, 'POST', `/api/lessons/proposal/${id}/accept`, {}, TOKEN);
      expect(accepted.status).toBe(200);
      expect(accepted.json).toMatchObject({ id, decision: 'accepted', coveredThroughSeq: 1 });
      expect(h.bible.readChapter('ops-restarts')?.lessons[0]?.body).toBe(reviewedBody);
      expect(cursor(h.bible)).toBe(1);
      expect(h.ledger.getNotification(notificationId)?.resolvedBy).toBe('owner:accepted');
      expect((await call(h.port, 'POST', `/api/lessons/proposal/${id}/reject`, {}, TOKEN)).status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('Reject over HTTP leaves the book byte-identical, consumes the batch, resolves the row; every route needs the token', async () => {
    const h = await boot();
    try {
      const before = bookFiles(h.bible);
      const { id, notificationId } = await propose(h);
      expect((await call(h.port, 'GET', '/api/lessons/proposal')).status).toBe(401);
      expect((await call(h.port, 'POST', `/api/lessons/proposal/${id}/accept`, {})).status).toBe(401);
      expect(h.proposals.review()).not.toBeNull();
      const rejected = await call(h.port, 'POST', `/api/lessons/proposal/${id}/reject`, {}, TOKEN);
      expect(rejected.status).toBe(200);
      expect(rejected.json).toMatchObject({ id, decision: 'rejected', report: null });
      expect(bookFiles(h.bible)).toBe(before);
      expect(cursor(h.bible)).toBe(1);
      expect(h.ledger.getNotification(notificationId)?.resolvedBy).toBe('owner:rejected');
    } finally {
      await h.close();
    }
  });

  it('a stale proposal is refused 409 for Reject too (cursor kept), and a recorded decision cannot be flipped', async () => {
    const h = await boot();
    try {
      const first = await propose(h);
      writeFileSync(join(h.bible.dir, 'INDEX.md'), `${h.bible.readIndexText() ?? ''}\n`);
      const stale = await call(h.port, 'POST', `/api/lessons/proposal/${first.id}/reject`, {}, TOKEN);
      expect(stale.status).toBe(409);
      expect(stale.json).toMatchObject({ error: 'proposal_stale' });
      expect(cursor(h.bible)).toBe(0);

      const engine = new DreamEngine({
        journal: h.journal,
        bible: h.bible,
        proposals: h.proposals,
        distiller: {
          distill: async (input) => ({
            chapters: [
              {
                slug: 'ops-restarts',
                title: 'Ops restarts',
                summary: 'Restart discipline.',
                tags: ['ops'],
                lessons: [{ slug: 'shell-hang', body: 'Close the shell first.', journalIds: input.entries.map((entry) => entry.id) }],
              },
            ],
          }),
        },
      });
      await engine.run(); // re-proposed against the edited book
      const second = h.proposals.review()!;
      const file = join(h.bible.dir, PROPOSAL_FILE);
      // A Reject recorded just before a crash: Accept may never flip it.
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), decision: { kind: 'rejected', at: '2026-10-07T12:00:00.000Z', detail: null } }));
      const flipped = await call(h.port, 'POST', `/api/lessons/proposal/${second.id}/accept`, {}, TOKEN);
      expect(flipped.status).toBe(409);
      expect(flipped.json).toMatchObject({ error: 'proposal_decided' });
      expect(h.bible.readChapter('ops-restarts')).toBeNull();
    } finally {
      await h.close();
    }
  });

  it('a recorded Accept blocked by a changed book answers 202 recorded-but-blocked; the opposite choice is still 409', async () => {
    const h = await boot();
    try {
      const { id } = await propose(h);
      const file = join(h.bible.dir, PROPOSAL_FILE);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf-8')), decision: { kind: 'accepted', at: '2026-10-07T12:00:00.000Z', detail: null } }));
      const index = h.bible.readIndexText()!;
      writeFileSync(join(h.bible.dir, 'INDEX.md'), `${index}\n`);
      const blocked = await call(h.port, 'POST', `/api/lessons/proposal/${id}/accept`, {}, TOKEN);
      expect(blocked.status).toBe(202);
      expect(blocked.json).toMatchObject({ id, decision: 'accepted', incomplete: true });
      expect(field<string>(blocked.json, 'detail')).toContain('recorded but blocked');
      expect(field<string>(blocked.json, 'detail')).toContain('INDEX.md changed');
      const opposite = await call(h.port, 'POST', `/api/lessons/proposal/${id}/reject`, {}, TOKEN);
      expect(opposite.status).toBe(409);
      expect(opposite.json).toMatchObject({ error: 'proposal_decided' });
      writeFileSync(join(h.bible.dir, 'INDEX.md'), index);
      const finished = await call(h.port, 'POST', `/api/lessons/proposal/${id}/accept`, {}, TOKEN);
      expect(finished.status).toBe(200);
      expect(cursor(h.bible)).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('a failure after the decision is recorded answers 202 incomplete; the review carries it; only the same decision finishes it', async () => {
    const h = await boot();
    try {
      const { id, notificationId } = await propose(h);
      const resolve = vi.spyOn(h.ledger, 'resolveNotificationById').mockImplementationOnce(() => {
        throw new Error('ledger is busy');
      });
      const first = await call(h.port, 'POST', `/api/lessons/proposal/${id}/accept`, {}, TOKEN);
      expect(first.status).toBe(202);
      expect(first.json).toMatchObject({ id, decision: 'accepted', incomplete: true });
      expect(field<string>(first.json, 'detail')).toContain('ledger is busy');
      // The book and cursor already moved; the For You row is still open.
      expect(h.bible.readChapter('ops-restarts')?.lessons[0]?.body).toBe('Close the shell first.');
      expect(cursor(h.bible)).toBe(1);
      expect(h.ledger.getNotification(notificationId)?.resolvedAt).toBeNull();

      const review = await call(h.port, 'GET', '/api/lessons/proposal', undefined, TOKEN);
      expect(review.status).toBe(200);
      expect(review.json).toMatchObject({ id, decision: { kind: 'accepted' }, recovery: null });

      const opposite = await call(h.port, 'POST', `/api/lessons/proposal/${id}/reject`, {}, TOKEN);
      expect(opposite.status).toBe(409);
      expect(opposite.json).toMatchObject({ error: 'proposal_decided', detail: 'this lesson proposal was already accepted' });

      const again = await call(h.port, 'POST', `/api/lessons/proposal/${id}/accept`, {}, TOKEN);
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ id, decision: 'accepted', coveredThroughSeq: 1 });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(h.ledger.getNotification(notificationId)?.resolvedBy).toBe('owner:accepted');
      expect(cursor(h.bible)).toBe(1);
      expect((await call(h.port, 'GET', '/api/lessons/proposal', undefined, TOKEN)).status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('a storage failure is an unconfirmed outcome (500), never a refusal — after a recorded Accept moved the book (C8)', async () => {
    const h = await boot();
    try {
      const { id } = await propose(h);
      vi.spyOn(h.ledger, 'resolveNotificationById').mockImplementationOnce(() => {
        throw new Error('ledger is busy');
      });
      expect((await call(h.port, 'POST', `/api/lessons/proposal/${id}/accept`, {}, TOKEN)).status).toBe(202);
      expect(cursor(h.bible)).toBe(1); // applied
      writeFileSync(join(h.bible.dir, PROPOSAL_FILE), '{ not a record');
      const retry = await call(h.port, 'POST', `/api/lessons/proposal/${id}/accept`, {}, TOKEN);
      expect(retry.status).toBe(500);
      expect(retry.json).toMatchObject({ error: 'proposal_unconfirmed' });
    } finally {
      await h.close();
    }
  });
});
