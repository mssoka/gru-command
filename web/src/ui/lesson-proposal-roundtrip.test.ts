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
  /** While on, the notice cleanup (resolving the For You notice) fails. */
  readonly failCleanup: (on: boolean) => void;
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
        lessonProposalNotifier: (options: { notifications: unknown; ledger: unknown }) => { resolve(id: string, by: string): void };
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
  const realNotifier = dream.lessonProposalNotifier({ notifications, ledger });
  let cleanupDown = false;
  const notifier = {
    ...realNotifier,
    resolve: (id: string, by: string) => {
      if (cleanupDown) throw new Error('notice cleanup is unavailable');
      realNotifier.resolve(id, by);
    },
  };
  const proposals = new dream.LessonProposals({ bible, notifier });
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
    failCleanup: (on) => { cleanupDown = on; },
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
function nodeFetch(base: string): {
  readonly fetchImpl: typeof fetch;
  readonly down: (on: boolean) => void;
  /** POSTs never leave the browser (a failure BEFORE the server hears them). */
  readonly dropPosts: (on: boolean) => void;
  /** POSTs reach the server and are answered, but the reply is lost. */
  readonly loseReplies: (on: boolean) => void;
  /** Proposal GETs made so far. */
  readonly proposalGets: () => number;
  /** Proposal GETs the page is still waiting on (issued − answered). */
  readonly openProposalGets: () => number;
  /** Decision POSTs the server answered (the request really reached it). */
  readonly decisionPosts: () => number;
  /** Withhold the ANSWER of every proposal GET until released — a
   * controlled slow-read schedule (the Ubuntu-run window: a reload still
   * outstanding while the owner tries again), never a wall-clock sleep.
   * The requests themselves are real and always reach the wire. */
  readonly holdProposalGets: (on: boolean) => void;
  readonly releaseProposalGets: () => void;
} {
  let target = base;
  let dropPosts = false;
  let loseReplies = false;
  let proposalGets = 0;
  let openProposalGets = 0;
  let decisionPosts = 0;
  let holdGets = false;
  const heldAnswers: Array<() => void> = [];
  const fetchImpl = ((path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise((resolveFetch, rejectFetch) => {
      const method = init.method ?? 'GET';
      const proposalGet = method === 'GET' && path === '/api/lessons/proposal';
      const decisionPost = method === 'POST' && /^\/api\/lessons\/proposal\/[^/]+\/(?:accept|reject)$/u.test(path);
      if (proposalGet) {
        proposalGets += 1;
        openProposalGets += 1;
      }
      if (method === 'POST' && dropPosts) {
        rejectFetch(new TypeError('fetch failed (request never sent)'));
        return;
      }
      /** Hand the already-settled answer to the page. A held proposal GET is
       * answered only by releaseProposalGets(), so "the page is still
       * waiting on this read" stays observable while it is withheld. */
      const deliver = (answer: () => void): void => {
        if (proposalGet) {
          if (holdGets) {
            heldAnswers.push(() => { openProposalGets -= 1; answer(); });
            return;
          }
          openProposalGets -= 1;
        }
        answer();
      };
      const req = request(`${target}${path}`, { method, headers: init.headers ?? {} }, (res) => {
        if (decisionPost) decisionPosts += 1;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          deliver(() => {
            if (method === 'POST' && loseReplies) {
              rejectFetch(new TypeError('fetch failed (reply lost)'));
              return;
            }
            const text = Buffer.concat(chunks).toString('utf8');
            const status = res.statusCode ?? 0;
            resolveFetch({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) as unknown });
          });
        });
      });
      req.on('error', (error: Error) => deliver(() => rejectFetch(error)));
      if (init.body !== undefined) req.write(init.body);
      req.end();
    })) as unknown as typeof fetch;
  return {
    fetchImpl,
    down: (on) => { target = on ? 'http://127.0.0.1:9' : base; },
    dropPosts: (on) => { dropPosts = on; },
    loseReplies: (on) => { loseReplies = on; },
    proposalGets: () => proposalGets,
    openProposalGets: () => openProposalGets,
    decisionPosts: () => decisionPosts,
    holdProposalGets: (on) => { holdGets = on; },
    releaseProposalGets: () => {
      holdGets = false;
      for (const answer of heldAnswers.splice(0)) answer();
    },
  };
}

function mountBoardDom(): void {
  document.body.innerHTML = `
    <div id="command-health" hidden>
      <span id="command-health-summary"></span>
      <span id="command-health-parts"></span>
      <span id="board-decisions"></span>
      <span id="board-wakes" hidden></span>
    </div>
    <section id="board-kpis" hidden></section>
    <nav id="board-nav" hidden></nav>
    <section id="board-owner" hidden></section>
    <div id="board-jobs"></div>
    <div id="board-agents"></div>
    <section id="board-repos" data-rail-panel="agents"></section>
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
/** One macrotask boundary: by the time it resolves, every microtask the page
 * queued for work already delivered to it has run (its own fetch/WS
 * reactions included). A turn — never a delay, never a wait for load. */
const turnEnd = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
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

  async function connect(h: Harness): Promise<ReturnType<typeof nodeFetch>> {
    const wire = nodeFetch(h.base);
    const { fetchImpl } = wire;
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
    return wire;
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
    const wire = await connect(h);
    const { down } = wire;
    const before = bookFiles(h.bible);
    const { id, notificationId } = await h.propose();
    await shownRow(notificationId);
    openReview(notificationId);
    await waitFor(() => {
      if (row(notificationId)!.querySelector('.board-owner__review-lesson') === null) throw new Error('review not loaded yet');
    });
    const button = (kind: 'accept' | 'reject'): HTMLButtonElement => row(notificationId)!.querySelector<HTMLButtonElement>(`.board-owner__${kind}`)!;

    // 1. The server never hears the decision: unconfirmed, never "not applied".
    //    The mandated reconcile read is HELD here (a controlled slow-read
    //    schedule — the read is real, only its answer is withheld): this is
    //    the exact-head Ubuntu window, where step 2 ran while that read's
    //    cycle was still in flight — the repeat click then read fresh, saw
    //    the just-injected durable rejection and locked Accept, so the real
    //    409 was never requested.
    wire.holdProposalGets(true);
    down(true);
    button('accept').click();
    expect(await alertText(notificationId)).toMatch(/^Couldn’t confirm the decision \(connect ECONNREFUSED/u);
    expect(h.proposals.review()).toMatchObject({ id, decision: null });
    // The page asked the server again, for real, and is still waiting on it.
    expect(wire.openProposalGets()).toBe(1);
    down(false);
    wire.releaseProposalGets();
    // Readiness barrier — the step the Ubuntu run lacked. The released read is
    // a real failed read; one turn lets the page run everything it queued for
    // that answer (the review the owner was reading is restored, the row's
    // in-flight state cleared), and no read may still be outstanding. Only
    // then is the repeat attempt below issued against the settled row rather
    // than against the outage's outstanding read.
    await turnEnd();
    await waitFor(() => {
      if (wire.openProposalGets() !== 0) throw new Error('the mandated reload is still outstanding');
      if (row(notificationId)!.querySelector('.board-owner__review-lesson') === null) throw new Error('the reviewed text is not restored yet');
    });
    expect(button('accept').disabled).toBe(false);

    // 2. Another device's Reject was recorded before a crash: this page's
    //    Accept meets the server's real 409, translated to its reason.
    const file = JSON.parse(readFileSync(h.proposalFile, 'utf-8')) as Record<string, unknown>;
    writeFileSync(h.proposalFile, JSON.stringify({ ...file, decision: { kind: 'rejected', at: '2026-10-07T00:00:00.000Z', detail: null } }));
    const answeredBefore = wire.decisionPosts();
    button('accept').click();
    await waitFor(() => {
      if (row(notificationId)?.querySelector('[role="alert"]')?.textContent !== 'Not applied — this lesson proposal was already rejected.') {
        throw new Error('no decided refusal yet');
      }
    });
    // That refusal is the server's own answer to a real POST.
    expect(wire.decisionPosts()).toBe(answeredBefore + 1);
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

  /** The lost-reply scenario (#277): the server durably records the choice
   * but its notice cleanup is down, so it answers 202 — and that reply is
   * lost. The page must reload the proposal and lock the opposite choice
   * from what the server holds, never from what was attempted. */
  for (const [attempted, opposite] of [['accept', 'reject'], ['reject', 'accept']] as const) {
    it(`a lost ${attempted} reply with a durable intent and open cleanup reloads the proposal, locks ${opposite} from the fetched decision and replaces the uncertainty wording (#277)`, async () => {
      const h = (harness = await boot());
      const wire = await connect(h);
      const before = bookFiles(h.bible);
      const { notificationId } = await h.propose();
      await shownRow(notificationId);
      openReview(notificationId);
      await waitFor(() => {
        if (row(notificationId)!.querySelector('.board-owner__review-lesson') === null) throw new Error('review not loaded yet');
      });
      const button = (kind: 'accept' | 'reject'): HTMLButtonElement => row(notificationId)!.querySelector<HTMLButtonElement>(`.board-owner__${kind}`)!;
      const label = attempted === 'accept' ? 'Accept' : 'Reject';
      expect(button('accept').disabled).toBe(false);
      expect(button('reject').disabled).toBe(false);

      h.failCleanup(true);
      wire.loseReplies(true);
      const getsBefore = wire.proposalGets();
      button(attempted).click();
      // The page asked the server again; the recorded decision replaces the
      // uncertainty wording and locks the other choice.
      await waitFor(() => {
        const text = row(notificationId)?.querySelector('[role="alert"]')?.textContent;
        if (text !== `Your ${label} is recorded but not finished — press ${label} to finish it.`) {
          throw new Error(`still showing: ${String(text)}`);
        }
      });
      expect(wire.proposalGets()).toBeGreaterThan(getsBefore);
      expect(button(opposite).disabled).toBe(true);
      expect(button(attempted).disabled).toBe(false);
      expect(h.proposals.review()).toMatchObject({ decision: { kind: attempted === 'accept' ? 'accepted' : 'rejected' } });
      expect((await alertText(notificationId))).not.toContain('may or may not');
      // Nothing is closed yet: the cleanup is still down.
      expect(h.notification(notificationId)?.resolvedAt).toBeNull();

      // Cleanup back and replies flowing: the same choice finishes it.
      wire.loseReplies(false);
      h.failCleanup(false);
      button(attempted).click();
      await waitFor(() => {
        if (row(notificationId) !== null) throw new Error('row still open');
      });
      expect(h.notification(notificationId)?.resolvedBy).toBe(`owner:${attempted === 'accept' ? 'accepted' : 'rejected'}`);
      if (attempted === 'reject') expect(bookFiles(h.bible)).toBe(before);
      else expect(h.bible.readChapter('ops-restarts')?.lessons[0]?.body).toBe('Close the shell first.\nThen restart.');
    });
  }

  it('a genuinely pre-intent failure stays undecided: the reload shows no recorded decision, so both choices stay available (#277)', async () => {
    const h = (harness = await boot());
    const wire = await connect(h);
    const { notificationId } = await h.propose();
    await shownRow(notificationId);
    openReview(notificationId);
    await waitFor(() => {
      if (row(notificationId)!.querySelector('.board-owner__review-lesson') === null) throw new Error('review not loaded yet');
    });
    const button = (kind: 'accept' | 'reject'): HTMLButtonElement => row(notificationId)!.querySelector<HTMLButtonElement>(`.board-owner__${kind}`)!;
    wire.dropPosts(true);
    const getsBefore = wire.proposalGets();
    button('accept').click();
    // The page still reloads to find out, and finds nothing recorded.
    await waitFor(() => {
      if (wire.proposalGets() <= getsBefore) throw new Error('the proposal was not reloaded');
    });
    expect(await alertText(notificationId)).toMatch(/^Couldn’t confirm the decision \(fetch failed \(request never sent\)\)/u);
    expect(h.proposals.review()).toMatchObject({ decision: null });
    await waitFor(() => {
      if (button('accept').disabled || button('reject').disabled) throw new Error('still settling');
    });
    expect(button('accept').disabled).toBe(false);
    expect(button('reject').disabled).toBe(false);
    expect(h.bible.readChapter('ops-restarts')).toBeNull();
    // The failure was transient: Reject is still a real, available choice.
    wire.dropPosts(false);
    button('reject').click();
    await waitFor(() => {
      if (row(notificationId) !== null) throw new Error('row still open');
    });
    expect(h.notification(notificationId)?.resolvedBy).toBe('owner:rejected');
  });
});
