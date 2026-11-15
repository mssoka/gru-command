import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { configPathFor, loadConfig } from '../src/config.js';
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
} from '../src/media/store.js';
import { minimalGif, minimalJpeg, minimalPng, minimalWebp } from './helpers/images.js';

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
    expect(sniffMediaType(mp4('qt  '))).toBeNull();
    // An EBML header that is not the webm doctype (Matroska) is refused.
    expect(sniffMediaType(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('matroska'), Buffer.alloc(32)]))).toBeNull();
    expect(sniffMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
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
    for (const bad of ['', '   ', 'x'.repeat(201), 'line one\nline two', 'tab\there', 'nel\u0085', 7]) {
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
});
