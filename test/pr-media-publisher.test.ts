import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { PrMediaConfig } from '../src/config.js';
import {
  escapeMarkdown,
  MEDIA_PUBLISH_RETRY_MS,
  MEDIA_SECTION_BEGIN,
  MEDIA_SECTION_END,
  ownerPrMediaView,
  PrMediaPublisher,
  renderMediaSection,
  repairAttachmentLayout,
  sectionFullyLinked,
  stripMediaSection,
  withMediaSection,
  type GhRunner,
} from '../src/media/publisher.js';
import { storeMedia, type MediaItem } from '../src/media/store.js';
import { minimalPng } from './helpers/images.js';

/**
 * PR media publication (owner rulings 2026-11-15: PR body section replaced
 * each head; on and autonomous by default). One GC-owned section between two
 * markers, bound to the observed head, written only when the PR still sits at
 * that head, journaled on both sides of the write, never re-sent, and retried
 * a bounded number of times.
 */

const PR = 'https://github.com/widget-co/widget-shop/pull/42';
const MR = 'https://gitlab.example.com/widget/shop/-/merge_requests/7';
const HEAD = 'e'.repeat(40);
const NEXT = 'f'.repeat(40);
const HUMAN = 'Fixes the FOR YOU wording.\n\nCloses #570.';
const AUTONOMOUS: PrMediaConfig = { enabled: true, publish: 'autonomous' };

const dirs: string[] = [];
const dbs: LedgerDb[] = [];

afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function webm(): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(32)]);
}

interface World {
  readonly ledger: LedgerApi;
  readonly dataDir: string;
  now: number;
}

function world(prUrl = PR): World {
  const dataDir = mkdtempSync(join(tmpdir(), 'gru-pr-media-publish-'));
  dirs.push(dataDir);
  const db = new LedgerDb(dataDir);
  dbs.push(db);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  ledger.addJob({ id: 'j-ui', repo: 'widget-shop', title: 'Plain-language cards' });
  ledger.setJobPr('j-ui', prUrl);
  // The ledger stamps events with the real clock; the publisher's clock
  // starts there and moves forward from it.
  return { ledger, dataDir, now: Date.now() };
}

function observeGitHub(w: World, sha: string, open = true): void {
  w.ledger.appendCustomEvent({
    kind: 'github.branch-state',
    jobId: 'j-ui',
    payload: {
      repo: 'widget-co/widget-shop', branch: 'fix/570', sha, merged: false, pr_open: open, mergeable_state: 'clean',
      pr_number: 42, pr_url: PR, merge_commit_sha: null, ci: null,
    },
  });
}

function capture(w: World, headSha: string, caption: string, bytes = minimalPng(), role: 'after' | 'before' = 'after'): MediaItem {
  return storeMedia({ dataDir: w.dataDir, ledger: w.ledger, jobId: 'j-ui', headSha, caption, role, bytes });
}

/** A fake gh holding one PR. `videos: 'append'` mimics gh appending a
 * video player after the body instead of rewriting its reference. */
function fakeGh(state: { body: string; head: string; prState: string }, opts: { videos?: 'rewrite' | 'append'; failEdit?: boolean } = {}) {
  const calls: string[][] = [];
  let asset = 0;
  const gh: GhRunner = async (args, run) => {
    calls.push([...args]);
    if (args[0] === 'pr' && args[1] === 'view') {
      return { code: 0, stdout: JSON.stringify({ body: state.body, headRefOid: state.head, state: state.prState }), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'edit') {
      if (opts.failEdit === true) return { code: 1, stdout: '', stderr: 'HTTP 502 while uploading' };
      let body = readFileSync(args[args.indexOf('--body-file') + 1]!, 'utf-8');
      const attached = args.flatMap((arg, index) => (args[index - 1] === '--attach' ? [arg] : []));
      expect(run.cwd).toBeDefined();
      const appended: string[] = [];
      for (const path of attached) {
        asset += 1;
        const url = `https://github.com/user-attachments/assets/asset-${asset}`;
        if (path.endsWith('.webm') && opts.videos === 'append') appended.push(url);
        else body = body.split(`](${path})`).join(`](${url})`);
      }
      state.body = appended.length === 0 ? body : `${body}\n${appended.join('\n')}`;
      return { code: 0, stdout: PR, stderr: '' };
    }
    throw new Error(`unexpected gh call ${args.join(' ')}`);
  };
  return { gh, calls };
}

function publisher(w: World, gh: GhRunner, config: PrMediaConfig = AUTONOMOUS, gitlab?: { fetch: typeof fetch; env: NodeJS.ProcessEnv }): PrMediaPublisher {
  return new PrMediaPublisher({ ledger: w.ledger, dataDir: w.dataDir, config: () => config, gh, now: () => w.now, ...(gitlab !== undefined ? { gitlab } : {}) });
}

function kinds(w: World): string[] {
  return w.ledger.listJobEvents('j-ui', { order: 'asc', limit: 500 }).map((event) => event.kind).filter((kind) => kind.startsWith('media.publish'));
}

describe('PR media section text', () => {
  it('renders before shots first, escapes captions so they can never become links, images or markers', () => {
    expect(escapeMarkdown('[click](https://evil.example) <!-- x --> ![img](u) **bold**')).not.toMatch(/(?<!\\)[[\]()<>!*]/u);
    const items = [
      { id: 'm-2', role: 'after', kind: 'image', seq: 2, caption: 'After [x](y)' },
      { id: 'm-1', role: 'before', kind: 'image', seq: 3, caption: 'Before' },
      { id: 'm-3', role: 'after', kind: 'video', seq: 4, caption: 'Clip' },
    ] as unknown as MediaItem[];
    const section = renderMediaSection({ headSha: HEAD, items, targets: new Map([['m-1', './gc-media-1.png'], ['m-2', './gc-media-2.png'], ['m-3', './gc-media-3.webm']]) });
    expect(section.startsWith(MEDIA_SECTION_BEGIN)).toBe(true);
    expect(section.endsWith(MEDIA_SECTION_END)).toBe(true);
    expect(section).toContain(`\`${HEAD.slice(0, 12)}\``);
    expect(section.indexOf('**Before:**')).toBeLessThan(section.indexOf('**After:**'));
    expect(section).toContain('**Clip:** Clip');
    expect(section).toContain('After \\[x\\]\\(y\\)');
  });

  it('replaces only its own section, keeps the author\'s text, and refuses damaged markers', () => {
    const once = withMediaSection(HUMAN, `${MEDIA_SECTION_BEGIN}\nold\n${MEDIA_SECTION_END}`);
    expect(stripMediaSection(once)).toBe(HUMAN);
    expect(stripMediaSection(`${HUMAN}\n\n${MEDIA_SECTION_BEGIN}\nold\n${MEDIA_SECTION_END}\n\nAuthor note after.`)).toBe(`${HUMAN}\n\nAuthor note after.`);
    expect(stripMediaSection(`${HUMAN}\n${MEDIA_SECTION_BEGIN}\nhalf a section`)).toBeNull();
    expect(stripMediaSection(`${once}\n${once}`)).toBeNull();
    expect(withMediaSection('', 'S')).toBe('S');
  });

  it('moves attachments gh appended back into the section, never a person\'s own text or links', () => {
    const body = [
      HUMAN, '', MEDIA_SECTION_BEGIN, '**After:** a', '', '![a](https://github.com/user-attachments/assets/1)', '',
      '**Clip:** b', '', '![b](./gc-media-2.webm)', '', MEDIA_SECTION_END,
      'https://github.com/user-attachments/assets/2',
      'See https://example.com/docs too.',
    ].join('\n');
    expect(sectionFullyLinked(body)).toBe(false);
    const repaired = repairAttachmentLayout(body);
    expect(sectionFullyLinked(repaired)).toBe(true);
    const [inside, after] = repaired.split(MEDIA_SECTION_END);
    expect(inside).toContain('https://github.com/user-attachments/assets/2');
    expect(inside).not.toContain('./gc-media-2.webm');
    expect(after).toContain('See https://example.com/docs too.');
    expect(repairAttachmentLayout(withMediaSection(HUMAN, 'x'))).toBe(withMediaSection(HUMAN, 'x'));
  });
});

describe('PR media publisher', () => {
  it('writes the section for the observed head once, journaling the attempt before the write', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'New FOR YOU card');
    capture(w, HEAD, 'Old FOR YOU card', minimalPng(), 'before');
    const pr = { body: HUMAN, head: HEAD, prState: 'OPEN' };
    const { gh, calls } = fakeGh(pr);
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ published: 1, failed: 0 });
    expect(kinds(w)).toEqual(['media.publish-attempt', 'media.published']);
    expect(pr.body.startsWith(HUMAN)).toBe(true);
    expect(pr.body).toContain('![Old FOR YOU card](https://github.com/user-attachments/assets/');
    expect(sectionFullyLinked(pr.body)).toBe(true);
    const edit = calls.find((call) => call[1] === 'edit')!;
    expect(edit.filter((arg) => arg === '--attach')).toHaveLength(2);
    // The same head and captures are never re-sent.
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ considered: 0, published: 0 });
    expect(calls.filter((call) => call[1] === 'edit')).toHaveLength(1);
  });

  it('replaces the section when the head moves and new captures arrive, keeping exactly one section', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'First head');
    const pr = { body: HUMAN, head: HEAD, prState: 'OPEN' };
    const { gh } = fakeGh(pr);
    await publisher(w, gh).pollOnce();
    observeGitHub(w, NEXT);
    pr.head = NEXT;
    // No captures at the new head yet: the old section stays, naming its own head.
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ considered: 0 });
    capture(w, NEXT, 'Second head');
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ published: 1 });
    expect(pr.body.split(MEDIA_SECTION_END)).toHaveLength(2);
    expect(pr.body).toContain('Second head');
    expect(pr.body).not.toContain('First head');
    expect(pr.body).toContain(NEXT.slice(0, 12));
  });

  it('repairs a video gh appended after the body so the section holds every capture', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'Still');
    capture(w, HEAD, 'Approve flow', webm());
    const pr = { body: HUMAN, head: HEAD, prState: 'OPEN' };
    const { gh, calls } = fakeGh(pr, { videos: 'append' });
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ published: 1 });
    expect(calls.filter((call) => call[1] === 'edit')).toHaveLength(2); // the upload, then the repair
    const [inside, after] = pr.body.split(MEDIA_SECTION_END);
    expect(inside).toContain('https://github.com/user-attachments/assets/asset-2');
    expect(after).toBe('');
  });

  it('skips a moved or closed PR without recording anything, and never publishes in "never" mode', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'Card');
    const moved = fakeGh({ body: HUMAN, head: NEXT, prState: 'OPEN' });
    expect(await publisher(w, moved.gh).pollOnce()).toMatchObject({ skipped: 1, published: 0 });
    const closed = fakeGh({ body: HUMAN, head: HEAD, prState: 'CLOSED' });
    expect(await publisher(w, closed.gh).pollOnce()).toMatchObject({ skipped: 1 });
    expect(kinds(w)).toEqual([]);
    const never = fakeGh({ body: HUMAN, head: HEAD, prState: 'OPEN' });
    expect(await publisher(w, never.gh, { enabled: true, publish: 'never' }).pollOnce()).toMatchObject({ considered: 0 });
    expect(never.calls).toEqual([]);
  });

  it('retries a failing write at most three times, ten minutes apart, then shows it failed on the card', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'Card');
    const { gh, calls } = fakeGh({ body: HUMAN, head: HEAD, prState: 'OPEN' }, { failEdit: true });
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ failed: 1 });
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ considered: 0 }); // inside the retry gap
    w.now += MEDIA_PUBLISH_RETRY_MS + 1_000;
    await publisher(w, gh).pollOnce();
    w.now += MEDIA_PUBLISH_RETRY_MS + 1_000;
    await publisher(w, gh).pollOnce();
    w.now += MEDIA_PUBLISH_RETRY_MS + 1_000;
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ considered: 0 });
    expect(calls.filter((call) => call[1] === 'edit')).toHaveLength(3);
    const view = ownerPrMediaView(w.ledger, 'j-ui', HEAD, AUTONOMOUS);
    expect(view?.publication).toMatchObject({ state: 'failed' });
    expect(view?.publication?.detail).toContain('HTTP 502 while uploading');
  });

  it('projects the FOR YOU block: current captures, superseded count and publication state', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, 'a'.repeat(40), 'Older head');
    expect(ownerPrMediaView(w.ledger, 'j-ui', HEAD, AUTONOMOUS)).toEqual({ headSha: HEAD, items: [], superseded: 1, publication: null });
    const item = capture(w, HEAD, 'Current');
    expect(ownerPrMediaView(w.ledger, 'j-ui', HEAD, AUTONOMOUS)).toMatchObject({
      items: [{ id: item.id, kind: 'image', role: 'after', caption: 'Current' }],
      superseded: 1,
      publication: { state: 'pending' },
    });
    const { gh } = fakeGh({ body: HUMAN, head: HEAD, prState: 'OPEN' });
    await publisher(w, gh).pollOnce();
    expect(ownerPrMediaView(w.ledger, 'j-ui', HEAD, AUTONOMOUS)?.publication).toMatchObject({ state: 'published' });
    expect(ownerPrMediaView(w.ledger, 'j-ui', HEAD, { enabled: true, publish: 'never' })?.publication).toMatchObject({ state: 'off' });
    expect(ownerPrMediaView(w.ledger, 'j-ui', HEAD, { enabled: false, publish: 'autonomous' })).toBeNull();
  });

  it('publishes to a GitLab merge request through the uploads API, never echoing the token', async () => {
    const w = world(MR);
    w.ledger.appendCustomEvent({
      kind: 'gitlab.mr-observed',
      jobId: 'j-ui',
      payload: { host: 'gitlab.example.com', project: 'widget/shop', mr_iid: 7, state: 'opened', head_sha: HEAD, head_pipeline: null, merge_commit_sha: null, mergeable: 'clean' },
    });
    capture(w, HEAD, 'Card');
    const requests: { method: string; url: string; token: string | null }[] = [];
    let description = 'MR text';
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ method: init?.method ?? 'GET', url: String(url), token: headers['PRIVATE-TOKEN'] ?? null });
      if (String(url).endsWith('/uploads')) return new Response(JSON.stringify({ url: '/uploads/secret123/gc-media-1.png' }), { status: 201 });
      if (init?.method === 'PUT') {
        description = (JSON.parse(String(init.body)) as { description: string }).description;
        return new Response('{}', { status: 200 });
      }
      return new Response(JSON.stringify({ description, sha: HEAD, state: 'opened' }), { status: 200 });
    }) as typeof fetch;
    const result = await publisher(w, fakeGh({ body: '', head: HEAD, prState: 'OPEN' }).gh, AUTONOMOUS, { fetch: fetchImpl, env: { GITLAB_TOKEN: 'glpat-secret' } }).pollOnce();
    expect(result).toMatchObject({ published: 1 });
    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST', 'PUT']);
    expect(requests.every((request) => request.url.startsWith('https://gitlab.example.com/api/v4/projects/widget%2Fshop') && request.token === 'glpat-secret')).toBe(true);
    expect(description.startsWith('MR text')).toBe(true);
    expect(description).toContain('![Card](/uploads/secret123/gc-media-1.png)');

    const failing = world(MR);
    failing.ledger.appendCustomEvent({
      kind: 'gitlab.mr-observed',
      jobId: 'j-ui',
      payload: { host: 'gitlab.example.com', project: 'widget/shop', mr_iid: 7, state: 'opened', head_sha: HEAD, head_pipeline: null, merge_commit_sha: null, mergeable: 'clean' },
    });
    capture(failing, HEAD, 'Card');
    const echo = (async () => new Response('bad token glpat-secret', { status: 401 })) as unknown as typeof fetch;
    await publisher(failing, fakeGh({ body: '', head: HEAD, prState: 'OPEN' }).gh, AUTONOMOUS, { fetch: echo, env: { GITLAB_TOKEN: 'glpat-secret' } }).pollOnce();
    const failed = failing.ledger.latestJobEvent('j-ui', 'media.publish-failed');
    expect(JSON.stringify(failed?.payload)).toContain('HTTP 401');
    expect(JSON.stringify(failed?.payload)).not.toContain('glpat-secret');
  });
});
