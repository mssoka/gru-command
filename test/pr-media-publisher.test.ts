import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { PrMediaConfig } from '../src/config.js';
import {
  escapeMarkdown,
  findMediaSection,
  GITHUB_BODY_MAX_CHARS,
  MEDIA_PUBLISH_FIX_RECHECK_MS,
  MEDIA_PUBLISH_RETRY_MS,
  MEDIA_PUBLISH_SETTLE_MS,
  MEDIA_SECTION_BEGIN,
  MEDIA_SECTION_END,
  orderForSection,
  ownerPrMediaView,
  parseGhVersion,
  PrMediaPublisher,
  renderMediaSection,
  repairAttachmentLayout,
  sectionFullyLinked,
  spliceMediaSection,
  type GhRunner,
} from '../src/media/publisher.js';
import { mediaJobKey, mediaRoot, readMediaBytes, storeMedia, type MediaItem } from '../src/media/store.js';
import { minimalPng } from './helpers/images.js';

/**
 * PR media publication (owner rulings 2026-11-15: PR body section replaced
 * each head; on and autonomous by default). One GC-owned section between two
 * marker lines, replaced in place, bound to the observed head, written only
 * when the PR still sits at that head, journaled on both sides of the write,
 * never re-sent for the same change/head/captures, retried a bounded number
 * of times, and never left showing an older head as current.
 */

const PR = 'https://github.com/widget-co/widget-shop/pull/42';
const PR_NEW = 'https://github.com/widget-co/widget-shop/pull/43';
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
  // starts past the settle window and moves forward from there.
  return { ledger, dataDir, now: Date.now() + MEDIA_PUBLISH_SETTLE_MS + 1_000 };
}

function observeGitHub(w: World, sha: string, prUrl = PR): void {
  w.ledger.appendCustomEvent({
    kind: 'github.branch-state',
    jobId: 'j-ui',
    payload: {
      repo: 'widget-co/widget-shop', branch: 'fix/570', sha, merged: false, pr_open: true, mergeable_state: 'clean',
      pr_number: Number(prUrl.split('/').at(-1)), pr_url: prUrl, merge_commit_sha: null, ci: null,
    },
  });
}

function capture(w: World, headSha: string, caption: string, bytes = minimalPng(), role: 'after' | 'before' = 'after'): MediaItem {
  return storeMedia({ dataDir: w.dataDir, ledger: w.ledger, jobId: 'j-ui', headSha, caption, role, bytes });
}

interface FakePr { body: string; head: string; prState: string }

/** A fake gh holding one PR. Modes: `append` mimics gh appending video
 * players after the body instead of rewriting their references; `drop`
 * leaves one reference unrewritten (an upload that did not land) and exits
 * non-zero; `failEdit` fails the upload edit; `failRepair` fails the second
 * (repair) edit. */
function fakeGh(pr: FakePr, opts: { videos?: 'rewrite' | 'append'; drop?: boolean; failEdit?: boolean; failRepair?: boolean; version?: string; ledger?: LedgerApi } = {}) {
  const calls: string[][] = [];
  let asset = 0;
  let edits = 0;
  const gh: GhRunner = async (args, run) => {
    calls.push([...args]);
    if (args[0] === '--version') return { code: 0, stdout: `gh version ${opts.version ?? '2.101.0'} (2026-09-15)\n`, stderr: '' };
    if (args[0] === 'pr' && args[1] === 'view') {
      return { code: 0, stdout: JSON.stringify({ body: pr.body, headRefOid: pr.head, state: pr.prState }), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'edit') {
      edits += 1;
      // The attempt is journaled BEFORE the irreversible write.
      if (opts.ledger !== undefined) expect(opts.ledger.latestJobEvent('j-ui', 'media.publish-attempt')).not.toBeNull();
      const attached = args.flatMap((arg, index) => (args[index - 1] === '--attach' ? [arg] : []));
      if (attached.length > 0) expect(run.cwd).toBeDefined();
      if (opts.failEdit === true && attached.length > 0) return { code: 1, stdout: '', stderr: 'HTTP 502 while uploading' };
      if (opts.failRepair === true && attached.length === 0 && edits > 1) return { code: 1, stdout: '', stderr: 'HTTP 500 on repair' };
      let body = readFileSync(args[args.indexOf('--body-file') + 1]!, 'utf-8');
      const appended: string[] = [];
      for (const [index, path] of attached.entries()) {
        asset += 1;
        const url = `https://github.com/user-attachments/assets/asset-${asset}`;
        if (opts.drop === true && index === 0) continue;
        if (path.endsWith('.webm') && opts.videos === 'append') appended.push(url);
        else body = body.split(`](${path})`).join(`](${url})`);
      }
      // gh appends each unreferenced attachment as its own paragraph.
      pr.body = `${body}${appended.map((url) => `\n\n${url}`).join('')}`;
      return opts.drop === true && attached.length > 0 ? { code: 1, stdout: PR, stderr: 'failed to upload gc-media-1.png' } : { code: 0, stdout: PR, stderr: '' };
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

function edits(calls: readonly string[][]): number {
  return calls.filter((call) => call[1] === 'edit').length;
}

describe('PR media section text', () => {
  it('renders before shots first and escapes captions so they never become links, mentions, emoji or markers', () => {
    const escaped = escapeMarkdown('[click](https://evil.example) <!-- x --> ![img](u) **bold** @all-team :tada: %milestone &epic $snip');
    expect(escaped).not.toMatch(/(?<!\\)[[\]()<>!*@:%&$]/u);
    const items = [
      { id: 'm-2', role: 'after', kind: 'image', seq: 2, caption: 'After [x](y)' },
      { id: 'm-1', role: 'before', kind: 'image', seq: 3, caption: 'Before' },
      { id: 'm-3', role: 'after', kind: 'video', seq: 4, caption: 'Clip' },
    ] as unknown as MediaItem[];
    const ordered = orderForSection(items);
    expect(ordered.map((item) => item.id)).toEqual(['m-1', 'm-2', 'm-3']);
    const section = renderMediaSection({ headSha: HEAD, items: ordered, targets: new Map([['m-1', './gc-media-1.png'], ['m-2', './gc-media-2.png'], ['m-3', './gc-media-3.webm']]), change: 'MR' });
    expect(section.startsWith(MEDIA_SECTION_BEGIN)).toBe(true);
    expect(section.endsWith(MEDIA_SECTION_END)).toBe(true);
    expect(section).toContain(`Captured at \`${HEAD.slice(0, 12)}\``);
    expect(section).toContain('when the MR head moves');
    expect(section).not.toContain("this PR's head"); // never a claim about the current head
    expect(section.indexOf('**Before:**')).toBeLessThan(section.indexOf('**After:**'));
    expect(section).toContain('**Clip:** Clip');
    expect(section).toContain('After \\[x\\]\\(y\\)');
  });

  it('replaces only its own marker lines in place, and never mistakes quoted or fenced markers for its section', () => {
    const old = `${MEDIA_SECTION_BEGIN}\nold\n${MEDIA_SECTION_END}`;
    const body = `${HUMAN}\n\n${old}\n\nAuthor note after.\r\n`;
    // In place: every byte outside the section is unchanged.
    expect(spliceMediaSection(body, 'NEW')).toBe(`${HUMAN}\n\nNEW\n\nAuthor note after.\r\n`);
    expect(spliceMediaSection(HUMAN, 'NEW')).toBe(`${HUMAN}\n\nNEW`);
    expect(spliceMediaSection('', 'NEW')).toBe('NEW');
    // A description that DISCUSSES the markers keeps every word.
    const quoted = `GC writes between \`${MEDIA_SECTION_BEGIN}\` and \`${MEDIA_SECTION_END}\`.\n- Tests added.`;
    expect(findMediaSection(quoted)).toBeNull();
    expect(spliceMediaSection(quoted, 'NEW')).toBe(`${quoted}\n\nNEW`);
    const fenced = `Example:\n\n\`\`\`md\n${old}\n\`\`\`\n`;
    expect(findMediaSection(fenced)).toBeNull();
    // A closing fence longer than its opener still closes it.
    const longer = `\`\`\`\n${old}\n\`\`\`\`\n\n${old}`;
    expect(findMediaSection(longer)).not.toBeNull();
    expect(findMediaSection(`~~~\n${old}\n\`\`\`\n${old}`)).toBeNull(); // a backtick line never closes a tilde fence
    // An inline ```npm test``` line is a code span, not a fence that hides the section.
    expect(findMediaSection(`Run \n\`\`\`npm test\`\`\`\n\n${old}`)).not.toBeNull();
    // Damage is refused, never guessed: a lone marker line, or two sections.
    expect(spliceMediaSection(`${HUMAN}\n${MEDIA_SECTION_BEGIN}\nhalf`, 'NEW')).toBeNull();
    expect(spliceMediaSection(`${old}\n\n${old}`, 'NEW')).toBeNull();
  });

  it('moves attachments gh appended at the end into the references they stand for, never a person\'s own text', () => {
    const body = [
      HUMAN, '', MEDIA_SECTION_BEGIN, '**After:** a', '', '![Settings \\[beta\\] toggle](https://github.com/user-attachments/assets/1)', '',
      '**Clip:** b', '', '![Flow \\[x\\]](./gc-media-2.webm)', '', MEDIA_SECTION_END,
      'See https://example.com/docs too.',
      'https://github.com/user-attachments/assets/2',
    ].join('\n');
    // A caption with escaped brackets is still seen as unlinked.
    expect(sectionFullyLinked(body)).toBe(false);
    const repaired = repairAttachmentLayout(body);
    expect(sectionFullyLinked(repaired)).toBe(true);
    const [inside, after] = repaired.split(MEDIA_SECTION_END);
    expect(inside).toContain('https://github.com/user-attachments/assets/2');
    expect(inside).not.toContain('./gc-media-2.webm');
    expect(after).toBe('\nSee https://example.com/docs too.');
    expect(repairAttachmentLayout(`${HUMAN}\n\nx`)).toBe(`${HUMAN}\n\nx`);
    // A person's own screenshot after a fully linked section stays theirs.
    const linked = `${MEDIA_SECTION_BEGIN}\n![a](https://github.com/user-attachments/assets/1)\n${MEDIA_SECTION_END}\n\n![mine](https://github.com/user-attachments/assets/9)`;
    expect(repairAttachmentLayout(linked)).toBe(linked);
    // With one reference unlinked, only the LAST trailing line (gh's) moves.
    const mixed = `${MEDIA_SECTION_BEGIN}\n![b](./gc-media-1.webm)\n${MEDIA_SECTION_END}\n![mine](https://github.com/user-attachments/assets/9)\nhttps://github.com/user-attachments/assets/2`;
    const fixed = repairAttachmentLayout(mixed);
    expect(fixed.split(MEDIA_SECTION_END)[0]).toContain('assets/2');
    expect(fixed.split(MEDIA_SECTION_END)[1]).toBe('\n![mine](https://github.com/user-attachments/assets/9)');
    // gh's paragraphs are separated by blank lines: both are taken, in order.
    const two = `${MEDIA_SECTION_BEGIN}\n![b](./gc-media-1.webm)\n![a](./gc-media-2.webm)\n${MEDIA_SECTION_END}\n\nhttps://github.com/user-attachments/assets/1\n\nhttps://github.com/user-attachments/assets/2\n`;
    const both = repairAttachmentLayout(two).split(MEDIA_SECTION_END);
    expect(both[0]!.indexOf('assets/1')).toBeLessThan(both[0]!.indexOf('assets/2'));
    expect(both[1]).toBe('');
    expect(parseGhVersion('gh version 2.101.0 (2026-09-15)\nhttps://github.com/cli/cli/releases')).toEqual([2, 101, 0]);
    expect(parseGhVersion('not gh')).toBeNull();
  });
});

describe('PR media publisher', () => {
  it('writes the section for the observed head once, after the captures settle, journaling the attempt before the write', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'New FOR YOU card');
    capture(w, HEAD, 'Old FOR YOU card', minimalPng(), 'before');
    const pr = { body: `${HUMAN}\n\nTrailing author note.`, head: HEAD, prState: 'OPEN' };
    const { gh, calls } = fakeGh(pr, { ledger: w.ledger });
    const settled = w.now;
    w.now = Date.now(); // captures just arrived: wait for the run to settle
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ considered: 0 });
    expect(calls).toEqual([]);
    w.now = settled;
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ published: 1, failed: 0 });
    expect(kinds(w)).toEqual(['media.publish-attempt', 'media.published']);
    expect(pr.body.startsWith(`${HUMAN}\n\nTrailing author note.`)).toBe(true);
    expect(pr.body.indexOf('**Before:**')).toBeLessThan(pr.body.indexOf('**After:**'));
    expect(pr.body).toContain('![Old FOR YOU card](https://github.com/user-attachments/assets/');
    expect(sectionFullyLinked(pr.body)).toBe(true);
    expect(calls.find((call) => call[1] === 'edit')!.filter((arg) => arg === '--attach')).toHaveLength(2);
    // The same change, head and captures are never re-sent.
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ considered: 0, published: 0 });
    expect(edits(calls)).toBe(1);
  });

  it('marks the section superseded when the head moves, replaces it with new captures, and re-sends a head that returns', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'First head');
    const pr = { body: HUMAN, head: HEAD, prState: 'OPEN' };
    const { gh } = fakeGh(pr);
    await publisher(w, gh).pollOnce();
    // A fix round moves the head and nothing is captured yet: the section
    // must not keep presenting the old pixels as this PR.
    observeGitHub(w, NEXT);
    pr.head = NEXT;
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ published: 1 });
    expect(pr.body).not.toContain('First head');
    expect(pr.body).toContain(`taken at \`${HEAD.slice(0, 12)}\`; this PR is now at \`${NEXT.slice(0, 12)}\``);
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ considered: 0 }); // the note is not re-sent
    capture(w, NEXT, 'Second head');
    w.now += MEDIA_PUBLISH_SETTLE_MS;
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ published: 1 });
    expect(pr.body.split(MEDIA_SECTION_END)).toHaveLength(2);
    expect(pr.body).toContain('Second head');
    // The head returns to HEAD (a revert): its captures are written again.
    observeGitHub(w, HEAD);
    pr.head = HEAD;
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ published: 1 });
    expect(pr.body).toContain('First head');
    expect(pr.body).not.toContain('Second head');
  });

  it('keeps before and after in their places when gh appends the clips instead of rewriting them', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'After clip', webm());
    capture(w, HEAD, 'Before clip', webm(), 'before');
    const pr = { body: HUMAN, head: HEAD, prState: 'OPEN' };
    const { gh, calls } = fakeGh(pr, { videos: 'append' });
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ published: 1 });
    expect(edits(calls)).toBe(2); // the upload, then the repair
    // Files are named and attached in section order: gc-media-1 is the
    // before clip, so the first appended asset belongs under "Before".
    const [inside, after] = pr.body.split(MEDIA_SECTION_END);
    expect(inside!.indexOf('**Before:** Before clip')).toBeLessThan(inside!.indexOf('assets/asset-1'));
    expect(inside!.indexOf('assets/asset-1')).toBeLessThan(inside!.indexOf('**Clip:** After clip'));
    expect(inside!.indexOf('**Clip:** After clip')).toBeLessThan(inside!.indexOf('assets/asset-2'));
    expect(after).toBe('');
  });

  it('skips a moved or closed PR without recording, publishes nothing when off or "never", and counts skips toward the per-tick cap', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'Card');
    const moved = fakeGh({ body: HUMAN, head: NEXT, prState: 'OPEN' });
    expect(await publisher(w, moved.gh).pollOnce()).toMatchObject({ considered: 1, skipped: 1, published: 0 });
    const closed = fakeGh({ body: HUMAN, head: HEAD, prState: 'CLOSED' });
    expect(await publisher(w, closed.gh).pollOnce()).toMatchObject({ skipped: 1 });
    expect(kinds(w)).toEqual([]);
    for (const config of [{ enabled: true, publish: 'never' }, { enabled: false, publish: 'autonomous' }] as const) {
      const quiet = fakeGh({ body: HUMAN, head: HEAD, prState: 'OPEN' });
      expect(await publisher(w, quiet.gh, config).pollOnce()).toMatchObject({ considered: 0 });
      expect(quiet.calls).toEqual([]);
    }
    // Three jobs owe a publication; a tick contacts at most two changes.
    for (const id of ['j-b', 'j-c']) {
      w.ledger.addJob({ id, repo: 'widget-shop', title: id });
      w.ledger.setJobPr(id, PR);
      w.ledger.appendCustomEvent({
        kind: 'github.branch-state', jobId: id,
        payload: { repo: 'widget-co/widget-shop', branch: id, sha: HEAD, merged: false, pr_open: true, mergeable_state: 'clean', pr_number: 42, pr_url: PR, merge_commit_sha: null, ci: null },
      });
      storeMedia({ dataDir: w.dataDir, ledger: w.ledger, jobId: id, headSha: HEAD, caption: 'Card', role: 'after', bytes: minimalPng() });
    }
    const busy = fakeGh({ body: HUMAN, head: NEXT, prState: 'OPEN' });
    expect(await publisher(w, busy.gh).pollOnce()).toMatchObject({ considered: 2, skipped: 2 });
  });

  it('retries a failing write three times, ten minutes apart, saying which attempt failed, then shows it failed', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'Card');
    const { gh, calls } = fakeGh({ body: HUMAN, head: HEAD, prState: 'OPEN' }, { failEdit: true });
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ failed: 1 });
    expect(ownerPrMediaView(w.ledger, { jobId: 'j-ui', prUrl: PR, sha: HEAD }, AUTONOMOUS, true)?.publication)
      .toMatchObject({ state: 'pending', detail: 'attempt 1 of 3 failed: gh pr edit --attach failed (exit 1): HTTP 502 while uploading' });
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ considered: 0 }); // inside the retry gap
    for (let attempt = 0; attempt < 3; attempt += 1) {
      w.now += MEDIA_PUBLISH_RETRY_MS + 1_000;
      await publisher(w, gh).pollOnce();
    }
    expect(calls.filter((call) => call[1] === 'edit' && call.includes('--attach'))).toHaveLength(3);
    const view = ownerPrMediaView(w.ledger, { jobId: 'j-ui', prUrl: PR, sha: HEAD }, AUTONOMOUS, true);
    expect(view?.publication).toMatchObject({ state: 'failed' });
    expect(view?.publication?.detail).toContain('HTTP 502 while uploading');
  });

  it('never leaves broken images: a partial upload or a failed repair is recorded as failed and replaced by a retry note', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'Card one');
    capture(w, HEAD, 'Card two');
    const pr = { body: HUMAN, head: HEAD, prState: 'OPEN' };
    const dropped = fakeGh(pr, { drop: true });
    expect(await publisher(w, dropped.gh).pollOnce()).toMatchObject({ failed: 1 });
    expect(pr.body).not.toContain('./gc-media-');
    expect(pr.body).not.toContain('user-attachments'); // the landed upload left with the section
    expect(pr.body).toContain('did not complete; Gru Command will retry');
    expect(w.ledger.latestJobEvent('j-ui', 'media.published')).toBeNull();
    // The last attempt's note promises no retry.
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      w.now += MEDIA_PUBLISH_RETRY_MS + 1_000;
      await publisher(w, dropped.gh).pollOnce();
    }
    expect(pr.body).toContain('did not complete after 3 attempts; they are on the Gru Command board');

    // One clip dropped, the other landed but appended by gh: the appended
    // link leaves with the replaced section instead of piling up — and a
    // screenshot a person added below the section is never taken for it.
    const w3 = world();
    observeGitHub(w3, HEAD);
    capture(w3, HEAD, 'Clip one', webm());
    capture(w3, HEAD, 'Clip two', webm());
    const mine = '![mine](https://github.com/user-attachments/assets/mine)';
    const pr3 = { body: `${HUMAN}\n\n${MEDIA_SECTION_BEGIN}\nold\n${MEDIA_SECTION_END}\n\n${mine}`, head: HEAD, prState: 'OPEN' };
    const partial = fakeGh(pr3, { drop: true, videos: 'append' });
    expect(await publisher(w3, partial.gh).pollOnce()).toMatchObject({ failed: 1 });
    expect(pr3.body).not.toContain('assets/asset-');
    expect(pr3.body.startsWith(HUMAN)).toBe(true);
    expect(pr3.body.endsWith(mine)).toBe(true);

    const w2 = world();
    observeGitHub(w2, HEAD);
    capture(w2, HEAD, 'Clip', webm());
    const pr2 = { body: HUMAN, head: HEAD, prState: 'OPEN' };
    const repairFails = fakeGh(pr2, { videos: 'append', failRepair: true });
    expect(await publisher(w2, repairFails.gh).pollOnce()).toMatchObject({ failed: 1 });
    expect(JSON.stringify(w2.ledger.latestJobEvent('j-ui', 'media.publish-failed')?.payload)).toContain('HTTP 500 on repair');
  });

  it('fails by name on preconditions: Enterprise Server once; an old gh, an oversize description and damaged markers retried until fixed', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'Card');
    const old = fakeGh({ body: HUMAN, head: HEAD, prState: 'OPEN' }, { version: '2.60.1' });
    await publisher(w, old.gh).pollOnce();
    expect(edits(old.calls)).toBe(0);
    expect(JSON.stringify(w.ledger.latestJobEvent('j-ui', 'media.publish-failed')?.payload)).toContain('needs gh 2.99.0 or newer to attach files (found 2.60.1)');

    const enterpriseUrl = 'https://code.acme.github/widget-co/widget-shop/pull/42';
    const ghes = world(enterpriseUrl);
    observeGitHub(ghes, HEAD, enterpriseUrl);
    capture(ghes, HEAD, 'Card');
    const enterprise = fakeGh({ body: HUMAN, head: HEAD, prState: 'OPEN' });
    await publisher(ghes, enterprise.gh).pollOnce();
    ghes.now += MEDIA_PUBLISH_RETRY_MS * 5;
    expect(await publisher(ghes, enterprise.gh).pollOnce()).toMatchObject({ considered: 0 }); // final: no retry
    expect(enterprise.calls).toEqual([]);
    expect(ownerPrMediaView(ghes.ledger, { jobId: 'j-ui', prUrl: enterpriseUrl, sha: HEAD }, AUTONOMOUS, true)?.publication)
      .toMatchObject({ state: 'failed', detail: expect.stringContaining('GitHub Enterprise Server') });

    const long = world();
    observeGitHub(long, HEAD);
    capture(long, HEAD, 'Card');
    const hugePr = { body: 'x'.repeat(GITHUB_BODY_MAX_CHARS), head: HEAD, prState: 'OPEN' };
    const huge = fakeGh(hugePr);
    await publisher(long, huge.gh).pollOnce();
    expect(edits(huge.calls)).toBe(0);
    const oversize = long.ledger.latestJobEvent('j-ui', 'media.publish-failed')?.payload as Record<string, unknown>;
    expect(oversize['detail']).toContain('65536-character limit');
    expect(oversize).not.toHaveProperty('final');
    // The author shortens the description; the next attempt publishes.
    hugePr.body = 'Short now.';
    long.now += MEDIA_PUBLISH_RETRY_MS + 1_000;
    expect(await publisher(long, huge.gh).pollOnce()).toMatchObject({ published: 1 });

    // Damaged markers: the card asks for a hand fix, and the retry picks it up.
    const damaged = world();
    observeGitHub(damaged, HEAD);
    capture(damaged, HEAD, 'Card');
    const damagedPr = { body: `${HUMAN}\n${MEDIA_SECTION_BEGIN}\nhalf a section`, head: HEAD, prState: 'OPEN' };
    const fixer = fakeGh(damagedPr);
    expect(await publisher(damaged, fixer.gh).pollOnce()).toMatchObject({ failed: 1 });
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      damaged.now += MEDIA_PUBLISH_RETRY_MS + 1_000;
      expect(await publisher(damaged, fixer.gh).pollOnce()).toMatchObject({ failed: 1 });
    }
    // The attempts ran out, but a hand fix is still picked up: hourly re-checks.
    const row = { jobId: 'j-ui', prUrl: PR, sha: HEAD };
    expect(ownerPrMediaView(damaged.ledger, row, AUTONOMOUS, true)?.publication?.detail).toMatch(/delete the stray gc-media marker lines by hand \(Gru Command checks again every hour\)$/u);
    damaged.now += MEDIA_PUBLISH_RETRY_MS + 1_000;
    expect(await publisher(damaged, fixer.gh).pollOnce()).toMatchObject({ considered: 0 }); // not every 10 minutes forever
    damagedPr.body = HUMAN; // the owner deletes the stray marker line hours later
    damaged.now += MEDIA_PUBLISH_FIX_RECHECK_MS * 3;
    expect(await publisher(damaged, fixer.gh).pollOnce()).toMatchObject({ published: 1 });
    // Hand-fix re-checks are not upload attempts: the attempt number recorded
    // for them never counts them toward "3 of 3".
    const recorded = damaged.ledger.listJobEvents('j-ui', { kinds: ['media.publish-failed'], order: 'asc' }).map((event) => (event.payload as { attempt: number }).attempt);
    expect(recorded.every((attempt) => attempt === 1)).toBe(true);
  });

  it('publishes again when the job is re-pointed at another PR, and only against an observation of the job\'s own change', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, HEAD, 'Card');
    const first = fakeGh({ body: HUMAN, head: HEAD, prState: 'OPEN' });
    await publisher(w, first.gh).pollOnce();
    w.ledger.setJobPr('j-ui', PR_NEW);
    // An observation still describing the old PR is not this change's head.
    expect(await publisher(w, first.gh).pollOnce()).toMatchObject({ considered: 0 });
    observeGitHub(w, HEAD, PR_NEW);
    const second = fakeGh({ body: 'Recreated PR.', head: HEAD, prState: 'OPEN' });
    expect(await publisher(w, second.gh).pollOnce()).toMatchObject({ published: 1 });
    expect(second.calls.find((call) => call[1] === 'edit')).toContain(PR_NEW);
  });

  it('projects the FOR YOU block: current captures, superseded count, publication state, and an honest "off"', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    capture(w, 'a'.repeat(40), 'Older head');
    const row = { jobId: 'j-ui', prUrl: PR, sha: HEAD };
    expect(ownerPrMediaView(w.ledger, row, AUTONOMOUS, true)).toEqual({ headSha: HEAD, items: [], superseded: 1, publication: null });
    const item = capture(w, HEAD, 'Current');
    expect(ownerPrMediaView(w.ledger, row, AUTONOMOUS, true)).toMatchObject({
      items: [{ id: item.id, kind: 'image', role: 'after', caption: 'Current' }],
      superseded: 1,
      publication: { state: 'pending', detail: null },
    });
    const { gh } = fakeGh({ body: HUMAN, head: HEAD, prState: 'OPEN' });
    await publisher(w, gh).pollOnce();
    expect(ownerPrMediaView(w.ledger, row, AUTONOMOUS, true)?.publication).toMatchObject({ state: 'published' });
    expect(ownerPrMediaView(w.ledger, row, { enabled: true, publish: 'never' }, true)?.publication).toMatchObject({ state: 'off', detail: null });
    expect(ownerPrMediaView(w.ledger, row, AUTONOMOUS, false)?.publication)
      .toMatchObject({ state: 'off', detail: 'publishing runs on the Silas signal poll, which is off on this instance' });
    expect(ownerPrMediaView(w.ledger, row, { enabled: false, publish: 'autonomous' }, true)).toBeNull();
  });

  it('publishes to a GitLab merge request through the uploads API, keeping an edit made during the uploads, never echoing the token', async () => {
    const observe = (w: World, sha: string): void => {
      w.ledger.appendCustomEvent({
        kind: 'gitlab.mr-observed',
        jobId: 'j-ui',
        payload: { host: 'gitlab.example.com', project: 'widget/shop', mr_iid: 7, state: 'opened', head_sha: sha, head_pipeline: null, merge_commit_sha: null, mergeable: 'clean' },
      });
    };
    const w = world(MR);
    observe(w, HEAD);
    capture(w, HEAD, 'Card');
    const requests: { method: string; url: string; token: string | null; redirect: string | undefined }[] = [];
    let description = 'MR text';
    let reads = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requests.push({ method: init?.method ?? 'GET', url: String(url), token: headers['PRIVATE-TOKEN'] ?? null, redirect: init?.redirect });
      if (String(url).endsWith('/uploads')) {
        description = 'MR text edited during the upload'; // a person edits meanwhile
        return new Response(JSON.stringify({ url: '/uploads/secret123/gc-media-1.png' }), { status: 201 });
      }
      if (init?.method === 'PUT') {
        description = (JSON.parse(String(init.body)) as { description: string }).description;
        return new Response('{}', { status: 200 });
      }
      reads += 1;
      return new Response(JSON.stringify({ description, sha: HEAD, state: 'opened' }), { status: 200 });
    }) as typeof fetch;
    const result = await publisher(w, fakeGh({ body: '', head: HEAD, prState: 'OPEN' }).gh, AUTONOMOUS, { fetch: fetchImpl, env: { GITLAB_TOKEN: 'glpat-secret' } }).pollOnce();
    expect(result).toMatchObject({ published: 1 });
    expect(reads).toBe(2); // once before, once right before the write
    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST', 'GET', 'PUT']);
    expect(requests.every((request) => request.url.startsWith('https://gitlab.example.com/api/v4/projects/widget%2Fshop') && request.token === 'glpat-secret' && request.redirect === 'manual')).toBe(true);
    expect(description.startsWith('MR text edited during the upload')).toBe(true);
    expect(description).toContain('![Card](/uploads/secret123/gc-media-1.png)');
    expect(description).toContain('when the MR head moves');

    // A merged MR, or one whose head moved, is skipped: no upload, no write, no record.
    for (const answer of [{ state: 'merged', sha: HEAD }, { state: 'opened', sha: NEXT }]) {
      const skip = world(MR);
      observe(skip, HEAD);
      capture(skip, HEAD, 'Card');
      const seen: string[] = [];
      const stub = (async (_url: string | URL, init?: RequestInit) => {
        seen.push(init?.method ?? 'GET');
        return new Response(JSON.stringify({ description: '', ...answer }), { status: 200 });
      }) as typeof fetch;
      expect(await publisher(skip, fakeGh({ body: '', head: HEAD, prState: 'OPEN' }).gh, AUTONOMOUS, { fetch: stub, env: { GITLAB_TOKEN: 't' } }).pollOnce()).toMatchObject({ skipped: 1 });
      expect(seen).toEqual(['GET']);
      expect(kinds(skip)).toEqual([]);
    }

    // A failed upload writes no description; the token is never echoed.
    const failing = world(MR);
    observe(failing, HEAD);
    capture(failing, HEAD, 'Card');
    const methods: string[] = [];
    const echo = (async (url: string | URL, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (String(url).endsWith('/uploads')) return new Response('bad token glpat-secret', { status: 500 });
      return new Response(JSON.stringify({ description: '', sha: HEAD, state: 'opened' }), { status: 200 });
    }) as typeof fetch;
    await publisher(failing, fakeGh({ body: '', head: HEAD, prState: 'OPEN' }).gh, AUTONOMOUS, { fetch: echo, env: { GITLAB_TOKEN: 'glpat-secret' } }).pollOnce();
    expect(methods).not.toContain('PUT');
    const failed = failing.ledger.latestJobEvent('j-ui', 'media.publish-failed');
    expect(JSON.stringify(failed?.payload)).toContain('HTTP 500');
    expect(JSON.stringify(failed?.payload)).not.toContain('glpat-secret');
  });

  it('deletes a closed job\'s local captures and journals it, whatever the publish mode', async () => {
    const w = world();
    observeGitHub(w, HEAD);
    const item = capture(w, HEAD, 'Card');
    const dir = join(mediaRoot(w.dataDir), mediaJobKey('j-ui'));
    expect(existsSync(dir)).toBe(true);
    const { gh } = fakeGh({ body: HUMAN, head: HEAD, prState: 'OPEN' });
    expect(await publisher(w, gh, { enabled: true, publish: 'never' }).pollOnce()).toMatchObject({ swept: 0 });
    w.ledger.setJobStatus('j-ui', 'binned');
    expect(await publisher(w, gh, { enabled: true, publish: 'never' }).pollOnce()).toMatchObject({ swept: 1 });
    expect(existsSync(dir)).toBe(false);
    expect(w.ledger.latestJobEvent('j-ui', 'media.swept')?.payload).toEqual({ files: 1, bytes: item.bytes });
    expect(() => readMediaBytes(w.dataDir, item)).toThrow(/no longer in the media store/u);
    expect(await publisher(w, gh).pollOnce()).toMatchObject({ swept: 0 });
  });
});
