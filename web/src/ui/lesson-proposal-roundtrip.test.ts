// @vitest-environment happy-dom

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket as NodeWebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardClient } from '../lib/board-client.js';
import { BoardView } from './board.js';

/**
 * The For You lesson proposal end to end: the board DOM drives the real
 * BoardClient over real HTTP into the production lessons + board request
 * chain (same hook order as main.ts), the production notifier and ledger,
 * and the board WebSocket's snapshot delivery closes the row. Nothing on
 * the wire is fabricated.
 */

// The web build never imports server code (separate builds), so the
// production modules are loaded by path and typed here by what we touch.
const SERVER_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');
async function backend<T>(path: string): Promise<T> {
  return (await import(/* @vite-ignore */ pathToFileURL(join(SERVER_SRC, path)).href)) as T;
}

type Hook = (req: IncomingMessage, res: ServerResponse, path: string) => boolean;
interface NotificationRow {
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}
interface Bible {
  readonly dir: string;
  readonly chaptersDir: string;
  ensureSeeded(): void;
  readIndexText(): string | null;
  readChapter(slug: string): { readonly lessons: readonly { readonly body: string }[] } | null;
}
interface Proposals {
  review(): { readonly id: string; readonly notificationId: string } | null;
}
interface DistillInput {
  readonly entries: readonly { readonly id: string }[];
}

interface Harness {
  readonly base: string;
  readonly bible: Bible;
  readonly proposals: Proposals;
  readonly notification: (id: string) => NotificationRow | null;
  readonly cursor: () => number;
  readonly proposalFile: string;
  readonly propose: () => Promise<{ readonly id: string; readonly notificationId: string }>;
  readonly close: () => Promise<void>;
}

const TOKEN = 'proposal-roundtrip-token';

async function boot(): Promise<Harness> {
  const [{ loadConfig }, { JournalStore }, { BibleStore }, { createBibleReferences }, { createLessonsServer }, dream, { EventBus }, { LedgerApi }, { LedgerDb }, { NotificationCenter }, { BoardEngine }, { createBoardServer }, { TranscriptService }] =
    await Promise.all([
      backend<{ loadConfig: (env: Record<string, string>, home: string) => unknown }>('config.ts'),
      backend<{ JournalStore: new (dir: string) => { append(entry: { kind: string; source: string; body: string }): unknown } }>('lessons/journal.ts'),
      backend<{ BibleStore: new (dir: string) => Bible }>('lessons/bible.ts'),
      backend<{ createBibleReferences: (options: { bible: Bible; maxReferences: number }) => unknown }>('lessons/references.ts'),
      backend<{ createLessonsServer: (options: Record<string, unknown>) => { requestHook: Hook } }>('lessons/server.ts'),
      backend<{
        DreamEngine: new (options: Record<string, unknown>) => { run(): Promise<unknown> };
        LessonProposals: new (options: Record<string, unknown>) => Proposals;
        lessonProposalNotifier: (options: { notifications: unknown; ledger: unknown }) => unknown;
        loadDreamState: (file: string) => { readonly coveredThroughSeq: number };
        DREAM_STATE_FILE: string;
        PROPOSAL_FILE: string;
      }>('lessons/dream.ts'),
      backend<{ EventBus: new () => unknown }>('events/bus.ts'),
      backend<{ LedgerApi: new (handle: unknown, options: { bus: unknown }) => { getNotification(id: string): NotificationRow | null } }>('ledger/api.ts'),
      backend<{ LedgerDb: new (dir: string) => { readonly handle: unknown; close(): void } }>('ledger/db.ts'),
      backend<{ NotificationCenter: new (options: { ledger: unknown; bus: unknown }) => unknown }>('notifications/center.ts'),
      backend<{ BoardEngine: new (options: { ledger: unknown; bus: unknown }) => unknown }>('board/engine.ts'),
      backend<{
        createBoardServer: (options: Record<string, unknown>) => { requestHook: Hook; attach(http: Server): void; dispose(): Promise<void> };
      }>('board/server.ts'),
      backend<{ TranscriptService: new (dir: string, options: { ledger: unknown }) => unknown }>('transcripts/service.ts'),
    ]);
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-proposal-roundtrip-'));
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  const config = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const journal = new JournalStore(join(dir, 'journal'));
  const bible = new BibleStore(join(dir, 'bible'));
  bible.ensureSeeded();
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const proposals = new dream.LessonProposals({ bible, notifier: dream.lessonProposalNotifier({ notifications, ledger }) });
  const lessonsServer = createLessonsServer({
    config,
    journal,
    bible,
    references: createBibleReferences({ bible, maxReferences: 3 }),
    proposals,
  });
  const board = createBoardServer({
    config,
    engine: new BoardEngine({ ledger, bus }),
    ledger,
    transcripts: new TranscriptService(join(dir, 'sessions'), { ledger }),
    bus,
    notifications,
    pushDebounceMs: 10,
  });
  const http = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (lessonsServer.requestHook(req, res, path) || board.requestHook(req, res, path)) return;
    res.writeHead(404);
    res.end();
  });
  board.attach(http);
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  const engine = new dream.DreamEngine({
    journal,
    bible,
    proposals,
    distiller: {
      distill: async (input: DistillInput) => ({
        chapters: [
          {
            slug: 'ops-restarts',
            title: 'Ops restarts',
            summary: 'Restart discipline.',
            tags: ['ops'],
            lessons: [{ slug: 'shell-hang', body: 'Close the shell first.\nThen restart.', journalIds: input.entries.map((entry) => entry.id) }],
          },
        ],
      }),
    },
  });
  return {
    base: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    bible,
    proposals,
    notification: (id) => ledger.getNotification(id),
    cursor: () => dream.loadDreamState(join(bible.dir, dream.DREAM_STATE_FILE)).coveredThroughSeq,
    proposalFile: join(bible.dir, dream.PROPOSAL_FILE),
    propose: async () => {
      journal.append({ kind: 'finding', source: 'gru', body: 'a live shell held the restart' });
      await engine.run();
      return proposals.review()!;
    },
    close: async () => {
      await board.dispose();
      await new Promise<void>((resolveClose) => {
        http.closeAllConnections();
        http.close(() => resolveClose());
      });
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A real HTTP fetch for the client (relative paths, as in production),
 * independent of the DOM environment's fetch. `down()` points it at a
 * closed port: a genuine network failure, not a server refusal. */
function nodeFetch(base: string): { readonly fetchImpl: typeof fetch; readonly down: (on: boolean) => void } {
  let target = base;
  const fetchImpl = ((path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise((resolveFetch, rejectFetch) => {
      const req = request(`${target}${path}`, { method: init.method ?? 'GET', headers: init.headers ?? {} }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          resolveFetch({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) as unknown });
        });
      });
      req.on('error', rejectFetch);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    })) as unknown as typeof fetch;
  return { fetchImpl, down: (on) => { target = on ? 'http://127.0.0.1:9' : base; } };
}

function mountBoardDom(): void {
  document.body.innerHTML = `
    <div id="chip-rail" hidden>
      <span id="board-decisions"></span>
      <span id="board-unacked" hidden></span>
      <span id="board-wakes" hidden></span>
    </div>
    <nav id="board-nav" hidden></nav>
    <section id="board-owner" hidden></section>
    <div id="board-jobs"></div>
    <div id="board-agents"></div>
    <span id="rail-agents-count">0</span>
    <button id="notification-bell"><span id="notification-badge">0</span></button>
    <div id="notification-panel"><div id="notification-list"></div></div>
  `;
}

const bookFiles = (bible: Bible): string =>
  JSON.stringify([bible.readIndexText(), ...readdirSync(bible.chaptersDir).sort().map((name) => readFileSync(join(bible.chaptersDir, name), 'utf-8'))]);
const row = (notificationId: string, surface = 'board-owner'): HTMLElement | null =>
  document.getElementById(surface)!.querySelector<HTMLElement>(`[data-action-id="owner-proposal:${notificationId}"]`)?.closest('article') ?? null;
const waitFor = <T>(probe: () => T): Promise<T> => vi.waitFor(probe, { timeout: 5_000, interval: 10 });
const shownRow = (notificationId: string, surface?: string): Promise<HTMLElement> =>
  waitFor(() => {
    const found = row(notificationId, surface);
    if (found === null) throw new Error(`no proposal row for ${notificationId} yet`);
    return found;
  });
const alertText = (notificationId: string): Promise<string> =>
  waitFor(() => {
    const text = row(notificationId)?.querySelector('[role="alert"]')?.textContent;
    if (text === undefined || text === null) throw new Error('no alert yet');
    return text;
  });
function openReview(notificationId: string): void {
  const review = row(notificationId)!.querySelector<HTMLDetailsElement>('.board-owner__review')!;
  review.open = true;
  review.dispatchEvent(new Event('toggle'));
}

describe('lesson proposal roundtrip through the real client, servers, ledger and snapshot', () => {
  let harness: Harness | null = null;
  let client: BoardClient | null = null;
  beforeEach(mountBoardDom);
  afterEach(async () => {
    client?.stop();
    client = null;
    await harness?.close();
    harness = null;
  });

  async function connect(h: Harness): Promise<{ readonly down: (on: boolean) => void }> {
    const { fetchImpl, down } = nodeFetch(h.base);
    const view = new BoardView(() => {}, null);
    let open: () => void = () => {};
    const opened = new Promise<void>((resolveOpen) => { open = resolveOpen; });
    client = new BoardClient(
      {
        token: TOKEN,
        host: new URL(h.base).host,
        fetchImpl,
        webSocketCtor: NodeWebSocket as unknown as new (url: string) => WebSocket,
      },
      {
        connection: (state) => { if (state === 'open') open(); },
        snapshot: (snapshot) => view.render(snapshot),
        fatal: (message) => { throw new Error(message); },
      },
    );
    view.bindClient(client);
    client.connect();
    await opened;
    return { down };
  }

  it('Accept in the band writes exactly the reviewed text, advances the cursor, resolves the notice and the snapshot closes the row', async () => {
    const h = (harness = await boot());
    await connect(h);
    const { id, notificationId } = await h.propose();
    await shownRow(notificationId);
    openReview(notificationId);
    const reviewed = await waitFor(() => {
      const text = row(notificationId)!.querySelector('.board-owner__review-lesson .board-owner__review-text')?.textContent;
      if (text === undefined || text === null) throw new Error('review not loaded yet');
      return text;
    });
    expect(reviewed).toBe('Close the shell first.\nThen restart.');
    row(notificationId)!.querySelector<HTMLButtonElement>('.board-owner__accept')!.click();
    await waitFor(() => expect(row(notificationId)).toBeNull());
    expect(h.bible.readChapter('ops-restarts')?.lessons[0]?.body).toBe(reviewed);
    expect(h.cursor()).toBe(1);
    expect(h.notification(notificationId)?.resolvedBy).toBe('owner:accepted');
    expect(h.proposals.review()).toBeNull();
    expect(id).not.toBe('');
  });

  it('a network failure is unconfirmed, a real 409 is translated, and Reject finishes with the book byte-identical', async () => {
    const h = (harness = await boot());
    const { down } = await connect(h);
    const before = bookFiles(h.bible);
    const { id, notificationId } = await h.propose();
    await shownRow(notificationId);
    openReview(notificationId);
    await waitFor(() => {
      if (row(notificationId)!.querySelector('.board-owner__review-lesson') === null) throw new Error('review not loaded yet');
    });

    // 1. The server never hears the decision: unconfirmed, never "not applied".
    down(true);
    row(notificationId)!.querySelector<HTMLButtonElement>('.board-owner__accept')!.click();
    expect(await alertText(notificationId)).toMatch(/^Couldn’t confirm the decision \(connect ECONNREFUSED/u);
    expect(h.proposals.review()).toMatchObject({ id, decision: null });
    down(false);

    // 2. Another device's Reject was recorded before a crash: this page's
    //    Accept meets the server's real 409, translated to its reason.
    const file = JSON.parse(readFileSync(h.proposalFile, 'utf-8')) as Record<string, unknown>;
    writeFileSync(h.proposalFile, JSON.stringify({ ...file, decision: { kind: 'rejected', at: '2026-10-07T00:00:00.000Z', detail: null } }));
    row(notificationId)!.querySelector<HTMLButtonElement>('.board-owner__accept')!.click();
    await waitFor(() => {
      if (row(notificationId)?.querySelector('[role="alert"]')?.textContent !== 'Not applied — this lesson proposal was already rejected.') {
        throw new Error('no decided refusal yet');
      }
    });
    expect(h.bible.readChapter('ops-restarts')).toBeNull();

    // 3. Reject (the band is the only place to decide) refetches the
    //    recorded decision and finishes it; the snapshot closes the row and
    //    the bell's pointer to it.
    (document.getElementById('notification-bell') as HTMLButtonElement).click();
    expect(document.getElementById('notification-list')!.querySelector('.board-owner__row--pointer')).not.toBeNull();
    row(notificationId)!.querySelector<HTMLButtonElement>('.board-owner__reject')!.click();
    await waitFor(() => {
      if (row(notificationId) !== null) throw new Error('row still open');
    });
    expect(document.getElementById('notification-list')!.querySelector('.board-owner__row--pointer')).toBeNull();
    expect(bookFiles(h.bible)).toBe(before);
    expect(h.cursor()).toBe(1);
    expect(h.notification(notificationId)?.resolvedBy).toBe('owner:rejected');
  });
});
