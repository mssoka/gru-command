import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { JournalStore } from '../src/lessons/journal.js';
import { BibleStore } from '../src/lessons/bible.js';
import { createBibleReferences } from '../src/lessons/references.js';
import { createLessonsServer } from '../src/lessons/server.js';

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
  const server = createLessonsServer({ config, journal, bible, references });
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
    close: async () => {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
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
