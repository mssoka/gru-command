import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { configPathFor, loadConfig } from '../src/config.js';
import { renderReferenceConfig } from '../src/config-reference.js';
import { appendWorkerRules, PR_MEDIA_RULE, WORKER_RULE_BLOCKS } from '../src/dispatch/worker-rules.js';
import { parse as parseToml } from 'smol-toml';
import {
  findMedia,
  listMedia,
  MEDIA_MAX_FILE_BYTES,
  MEDIA_MAX_PER_HEAD,
  MediaError,
  mediaAtHead,
  mediaRoot,
  readMediaBytes,
  sniffMediaType,
  storeMedia,
  validateCaption,
  validateMediaBytes,
  webmFrameSize,
} from '../src/media/store.js';
import { minimalGif, minimalJpeg, minimalPng, minimalWebm, minimalWebp } from './helpers/images.js';

/**
 * PR media store (owner rulings 2026-11-15, PR 1): captures are validated by
 * magic bytes and bounds, written once into the private media home, journaled
 * as `media.captured` bound to their exact head, and re-verified on read.
 */

const dirs: string[] = [];
const dbs: LedgerDb[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'gru-pr-media-'));
  dirs.push(path);
  return path;
}

function ledgerWithJob(): { ledger: LedgerApi; dataDir: string } {
  const dataDir = directory();
  const db = new LedgerDb(dataDir);
  dbs.push(db);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  ledger.addJob({ id: 'j-media', repo: 'widget-shop', title: 'Plain-language cards' });
  return { ledger, dataDir };
}

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** The first 331 bytes of a clip agent-browser 0.25.3 recorded at 390x844
 * (ffmpeg's libavformat 62 wrote it): through the video track's frame size. */
const RECORDED_WEBM_HEAD = Buffer.from(
  '1a45dfa39f4286810142f7810142f2810442f381084282847765626d4287810242858102185380670100000000008f0f114d9b74ba4dbb' +
  '8b53ab841549a96653ac81a14dbb8b53ab841654ae6b53ac81d64dbb8c53ab841254c36753ac8201294dbb8c53ab841c53bb6b53ac828e' +
  'f9ec0100000000000059000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000' +
  '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000001549a966b02ad7b1830f42' +
  '404d808c4c61766636322e332e31303057418c4c61766636322e332e3130304489884095e000000000001654ae6bceae01000000000000' +
  '45d7810173c588c8e11c6bc49c7fb69c810022b59c83756e648881008685565f56503883810123e3838405f5e100e096b0820186ba8203' +
  '4c',
  'hex',
);

function webm(): Buffer {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(32)]);
}

function mp4(brand = 'isom'): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`, 'ascii'), Buffer.alloc(32)]);
}

afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('PR media store', () => {
  it('identifies stills and clips by magic bytes only, refusing QuickTime and anything else', () => {
    expect(sniffMediaType(minimalPng())).toBe('image/png');
    expect(sniffMediaType(minimalJpeg())).toBe('image/jpeg');
    expect(sniffMediaType(minimalGif())).toBe('image/gif');
    expect(sniffMediaType(minimalWebp())).toBe('image/webp');
    expect(sniffMediaType(webm())).toBe('video/webm');
    expect(sniffMediaType(mp4())).toBe('video/mp4');
    expect(sniffMediaType(mp4('iso2'))).toBe('video/mp4');
    // ISO base-media files that are not MP4 video share the ftyp box.
    for (const brand of ['qt  ', 'heic', 'avif', 'mif1', 'M4A ', '3gp4']) expect(sniffMediaType(mp4(brand)), brand).toBeNull();
    // An EBML header that is not the webm doctype (Matroska) is refused.
    expect(sniffMediaType(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('matroska'), Buffer.alloc(32)]))).toBeNull();
    expect(sniffMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  it('reads a clip\'s frame size from its first video track, and names none for a file it cannot read whole', () => {
    // A real recording's head, and the same structure built by hand.
    expect(webmFrameSize(RECORDED_WEBM_HEAD)).toEqual({ width: 390, height: 844 });
    expect(webmFrameSize(minimalWebm(1280, 800))).toEqual({ width: 1280, height: 800 });
    expect(webmFrameSize(minimalWebm(3840, 2160))).toEqual({ width: 3840, height: 2160 });
    // Cut one byte short, the height is half a number: no size, never a wrong one.
    expect(webmFrameSize(RECORDED_WEBM_HEAD.subarray(0, RECORDED_WEBM_HEAD.length - 1))).toBeNull();
    expect(webmFrameSize(RECORDED_WEBM_HEAD.subarray(0, 120))).toBeNull();
    // An audio track, a WebM with no tracks, another type, nothing at all.
    const audioOnly = minimalWebm(640, 480);
    audioOnly[audioOnly.indexOf(0xe0, 30)] = 0xe1;
    expect(webmFrameSize(audioOnly)).toBeNull();
    expect(webmFrameSize(webm())).toBeNull();
    expect(webmFrameSize(minimalPng())).toBeNull();
    expect(webmFrameSize(Buffer.alloc(0))).toBeNull();
    // A hand-built head is still a WebM by its magic bytes.
    expect(sniffMediaType(minimalWebm())).toBe('video/webm');
    expect(validateMediaBytes(minimalWebm(390, 844))).toBe('video/webm');
  });

  it('refuses empty, oversized, unsupported and truncated captures with named codes', () => {
    const code = (bytes: Buffer): string => {
      try {
        validateMediaBytes(bytes);
        return 'accepted';
      } catch (error) {
        return error instanceof MediaError ? `${error.status}:${error.code}` : 'other';
      }
    };
    expect(code(Buffer.alloc(0))).toBe('400:media_empty');
    expect(code(Buffer.concat([minimalPng(), Buffer.alloc(MEDIA_MAX_FILE_BYTES)]))).toBe('413:media_too_large');
    expect(code(Buffer.from('plain text'))).toBe('415:media_unsupported_type');
    expect(code(minimalPng().subarray(0, 20))).toBe('415:media_invalid');
    expect(code(minimalPng())).toBe('accepted');
    expect(code(webm())).toBe('accepted');
  });

  it('accepts one honest caption line and refuses empty, long or multi-line captions', () => {
    expect(validateCaption('  FOR YOU card at 375 px  ')).toBe('FOR YOU card at 375 px');
    for (const bad of ['', '   ', 'x'.repeat(201), 'line one\nline two', 'tab\there', 'nel\u0085', 'rtl \u202Egnp.exe', 'zero\u200Bwidth', 'iso\u2066late', 7]) {
      expect(() => validateCaption(bad)).toThrow(MediaError);
    }
  });

  it('writes each capture once into a private store and journals it bound to its head', () => {
    const { ledger, dataDir } = ledgerWithJob();
    const item = storeMedia({ dataDir, ledger, jobId: 'j-media', headSha: HEAD, caption: 'New card', role: 'after', bytes: minimalPng() });
    expect(item.id).toMatch(/^m-[0-9a-f-]{36}$/u);
    expect(item.mediaType).toBe('image/png');
    expect(item.kind).toBe('image');
    expect(item.capturedBy).toBe('minion');
    const root = mediaRoot(dataDir);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, item.file)).mode & 0o777).toBe(0o600);
    // The job id never becomes a path component: the directory is a hash.
    expect(item.file.startsWith('j-media')).toBe(false);
    const event = ledger.latestJobEvent('j-media', 'media.captured');
    expect(event?.payload).toMatchObject({ id: item.id, head_sha: HEAD, media_type: 'image/png', role: 'after', caption: 'New card', captured_by: 'minion' });
    expect(JSON.stringify(event?.payload)).not.toContain(dataDir);
    expect(findMedia(ledger, item.id)).toMatchObject({ id: item.id, headSha: HEAD });
    expect(findMedia(ledger, 'm-not-a-real-id')).toBeNull();
    expect(readMediaBytes(dataDir, item).equals(minimalPng())).toBe(true);
  });

  it('selects captures by exact head and caps the captures one head may carry', () => {
    const { ledger, dataDir } = ledgerWithJob();
    storeMedia({ dataDir, ledger, jobId: 'j-media', headSha: OTHER, caption: 'Old head', role: 'after', bytes: minimalPng() });
    for (let index = 0; index < MEDIA_MAX_PER_HEAD; index += 1) {
      storeMedia({ dataDir, ledger, jobId: 'j-media', headSha: HEAD, caption: `Shot ${index}`, role: index === 0 ? 'before' : 'after', bytes: minimalPng() });
    }
    const all = listMedia(ledger, 'j-media');
    expect(all).toHaveLength(MEDIA_MAX_PER_HEAD + 1);
    expect(all[0]!.caption).toBe('Old head'); // oldest first
    expect(mediaAtHead(all, HEAD)).toHaveLength(MEDIA_MAX_PER_HEAD);
    expect(mediaAtHead(all, OTHER).map((item) => item.caption)).toEqual(['Old head']);
    expect(() => storeMedia({ dataDir, ledger, jobId: 'j-media', headSha: HEAD, caption: 'One too many', role: 'after', bytes: minimalPng() }))
      .toThrow(/already has 8 captures/u);
  });

  it('refuses to serve a capture whose stored bytes changed or vanished', () => {
    const { ledger, dataDir } = ledgerWithJob();
    const item = storeMedia({ dataDir, ledger, jobId: 'j-media', headSha: HEAD, caption: 'Card', role: 'after', bytes: minimalPng() });
    const path = join(mediaRoot(dataDir), item.file);
    const altered = minimalPng();
    altered[altered.length - 13] = altered[altered.length - 13]! ^ 0xff; // same size, different bytes
    writeFileSync(path, altered);
    expect(() => readMediaBytes(dataDir, item)).toThrow(/changed after it was recorded/u);
    rmSync(path);
    expect(() => readMediaBytes(dataDir, item)).toThrow(/no longer in the media store/u);
  });

  it('defaults [pr_media] to on and autonomous, and refuses unknown keys or modes', () => {
    const load = (toml: string): ReturnType<typeof loadConfig> => {
      const home = directory();
      writeFileSync(configPathFor(home), toml, { encoding: 'utf-8', mode: 0o600 });
      return loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    };
    expect(load('[server]\nport = 0\n').prMedia).toEqual({ enabled: true, publish: 'autonomous' });
    expect(load('[pr_media]\nenabled = false\npublish = "never"\n').prMedia).toEqual({ enabled: false, publish: 'never' });
    expect(() => load('[pr_media]\npublish = "proposed"\n')).toThrow(/pr_media\.publish must be one of "autonomous", "never"/u);
    expect(() => load('[pr_media]\nmax_bytes = 5\n')).toThrow(/unknown key `max_bytes` in \[pr_media\]/u);
  });

  it('regenerating the config keeps the owner\'s [pr_media] choices instead of resetting them to the defaults', () => {
    const home = directory();
    writeFileSync(configPathFor(home), '[pr_media]\nenabled = false\npublish = "never"\n', { encoding: 'utf-8', mode: 0o600 });
    const custom = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const text = renderReferenceConfig({ instanceDir: '/i', workspaceRoot: '/w', managedRepos: [], host: '127.0.0.1', port: 7665, token: 't', runtime: 'claude-code', model: 'default', thinkingLevel: 'default', roles: {} }, custom);
    expect((parseToml(text) as Record<string, unknown>)['pr_media']).toEqual({ enabled: false, publish: 'never' });
  });

  it('every worker instruction carries the media rule, naming exactly the fields the capture API reads', () => {
    expect(WORKER_RULE_BLOCKS).toContain(PR_MEDIA_RULE);
    const brief = appendWorkerRules('Fix the FOR YOU wording.');
    expect(brief).toContain('POST /api/media');
    for (const field of ['"job_id"', '"head_sha"', '"caption"', '"role"', '"content_base64"']) expect(brief).toContain(field);
    // Large bodies go through a file, never a command-line argument.
    expect(brief).toContain('curl --data-binary @<file>');
    // Read-only and review jobs are told to submit nothing.
    expect(brief).toMatch(/Review, read-only and other non-publishing jobs submit nothing/u);
  });
});
