import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/auth.js';
import type { GruCommandConfig } from '../src/config.js';
import { createAttachmentsServer } from '../src/attachments/server.js';
import {
  browseWorkspace,
  chipPathAllowed,
  materializeUpload,
  sanitizeUploadName,
  MAX_BROWSE_ENTRIES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
} from '../src/attachments/resolver.js';

/**
 * The ONE attach flow's seam (SPEC ruling 19, this lane): materialize
 * (clipboard/phone bytes → uploads dir → that path) and browse
 * (workspace-root on-disk picks → metadata only, NEVER bytes).
 */

const TOKEN = 'attach-test-token';
const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

describe('sanitizeUploadName', () => {
  it('strips client paths, control chars, and leading dots; keeps a clean extension', () => {
    expect(sanitizeUploadName('/etc/passwd')).toBe('passwd');
    expect(sanitizeUploadName('..\\..\\shots\\Screen Shot.png')).toBe('Screen Shot.png');
    expect(sanitizeUploadName('\u0000bad\u0007name.txt')).toBe('badname.txt');
    expect(sanitizeUploadName('...hidden')).toBe('hidden');
    expect(sanitizeUploadName('')).toBe('upload');
    expect(sanitizeUploadName('..')).toBe('upload');
  });

  it('bounds the length while preserving the extension tail', () => {
    const long = `${'a'.repeat(300)}.png`;
    const sanitized = sanitizeUploadName(long);
    expect(sanitized.length).toBeLessThanOrEqual(200);
    expect(sanitized.endsWith('.png')).toBe(true);
  });
});

describe('materializeUpload (ruling 19(c): bytes → uploads dir → THAT path)', () => {
  it('writes the file under the uploads dir, 0600, hardened 0700 dir, and returns its absolute path', () => {
    const dir = tempDir('gru-command-uploads-mat-');
    const stored = materializeUpload(dir, {
      filename: 'screens/Shot 2026.png',
      bytes: new TextEncoder().encode('png-bytes'),
    });
    expect(stored.path.startsWith(dir)).toBe(true);
    expect(stored.bytes).toBe(9);
    expect(readFileSync(stored.path, 'utf-8')).toBe('png-bytes');
    expect(statSync(stored.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(stored.name).toBe('Shot 2026.png');
  });

  it('hardens a PRE-EXISTING loose (0755) uploads dir on write (W-D write-path side)', () => {
    const dir = tempDir('gru-command-uploads-loose-');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    materializeUpload(dir, { filename: 'x.txt', bytes: new TextEncoder().encode('x') });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('never clobbers: same-name collisions materialize side-by-side', () => {
    const dir = tempDir('gru-command-uploads-collide-');
    const first = materializeUpload(dir, { filename: 'same.txt', bytes: new TextEncoder().encode('1') });
    const second = materializeUpload(dir, { filename: 'same.txt', bytes: new TextEncoder().encode('2') });
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(first.path, 'utf-8')).toBe('1');
    expect(readFileSync(second.path, 'utf-8')).toBe('2');
  });

  it('rejects empty bytes (400) and over-cap bytes (413)', () => {
    const dir = tempDir('gru-command-uploads-cap-');
    expect(() => materializeUpload(dir, { filename: 'a', bytes: new Uint8Array() })).toThrow(/empty/);
    const huge = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    expect(() => materializeUpload(dir, { filename: 'a', bytes: huge })).toThrow(/exceeds/);
  });

  it('enforces the file-count quota (review r1: unbounded accumulation)', () => {
    const dir = tempDir('gru-command-uploads-quota-');
    for (let i = 0; i < 3; i += 1) {
      materializeUpload(dir, { filename: `q${i}.txt`, bytes: new TextEncoder().encode(`${i}`) });
    }
    // The cap is the exported constant; simulate reaching it by filling
    // the remainder (bounded here by monkey-scale: cap minus what exists).
    const fill = MAX_UPLOAD_FILES - 3;
    for (let i = 0; i < fill; i += 1) {
      writeFileSync(join(dir, `pre-${i}.txt`), 'x');
    }
    expect(() => materializeUpload(dir, { filename: 'one-more.txt', bytes: new TextEncoder().encode('!') })).toThrow(
      /quota exceeded/,
    );
  }, 60_000);
});

describe('browseWorkspace (ruling 19(c): on-disk = PATH, metadata only)', () => {
  it('lists dirs first then files, flags images, skips dot entries, carries the absolute root', () => {
    const root = tempDir('gru-command-ws-');
    mkdirSync(join(root, 'repo-a'));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'notes.md'), 'x');
    writeFileSync(join(root, 'shot.png'), 'x');
    writeFileSync(join(root, '.env'), 'x');
    const result = browseWorkspace(root, '');
    expect(result.root).toBe(realpathSync(root)); // macOS /var → /private/var
    expect(result.parent).toBeNull();
    expect(result.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:repo-a',
      'file:notes.md',
      'file:shot.png',
    ]);
    const shot = result.entries.find((e) => e.name === 'shot.png');
    expect(shot?.image).toBe(true);
    expect(shot?.size).toBe(1);
  });

  it('navigates into a subdir and reports its parent', () => {
    const root = tempDir('gru-command-ws-nav-');
    mkdirSync(join(root, 'repo-a', 'src'), { recursive: true });
    writeFileSync(join(root, 'repo-a', 'src', 'main.ts'), 'x');
    const result = browseWorkspace(root, 'repo-a');
    expect(result.path).toBe('repo-a');
    expect(result.parent).toBe('');
    expect(result.entries).toHaveLength(1);
    const nested = browseWorkspace(root, 'repo-a/src');
    expect(nested.parent).toBe('repo-a');
    expect(nested.entries[0]?.name).toBe('main.ts');
  });

  it('containment: ../ escapes, absolute outsiders, and symlink tunnels are rejected (400)', () => {
    const root = tempDir('gru-command-ws-keep-');
    const outside = tempDir('gru-command-ws-out-');
    expect(() => browseWorkspace(root, '../')).toThrow(/escapes/);
    expect(() => browseWorkspace(root, outside)).toThrow(/escapes|no such/);
    const tunneled = join(root, 'tunnel');
    symlinkSync(outside, tunneled);
    expect(() => browseWorkspace(root, 'tunnel')).toThrow(/escapes/);
  });

  it('lists SYMLINKS by their target type; broken ones drop out (review r1)', () => {
    const root = tempDir('gru-command-ws-symlink-');
    const realDir = tempDir('gru-command-ws-symlink-real-');
    mkdirSync(join(root, 'plain'));
    writeFileSync(join(realDir, 'linked.md'), 'through the link');
    symlinkSync(join(realDir, 'linked.md'), join(root, 'linked.md'));
    symlinkSync(realDir, join(root, 'dirlink')); // target IS a directory
    symlinkSync(join(root, 'nowhere'), join(root, 'broken')); // broken (target absent)
    const result = browseWorkspace(root, '');
    const names = result.entries.map((e) => `${e.kind}:${e.name}`);
    expect(names).toContain('dir:plain');
    expect(names).toContain('dir:dirlink');
    expect(names).toContain('file:linked.md');
    expect(names).not.toContain('file:broken');
    expect(result.truncated).toBe(false);
  });

  it('caps the listing and reports truncation (review r1)', () => {
    const root = tempDir('gru-command-ws-big-');
    for (let i = 0; i < MAX_BROWSE_ENTRIES + 10; i += 1) {
      writeFileSync(join(root, `f${String(i).padStart(4, '0')}.txt`), 'x');
    }
    const result = browseWorkspace(root, '');
    expect(result.entries.length).toBe(MAX_BROWSE_ENTRIES);
    expect(result.truncated).toBe(true);
  });

  it('chipPathAllowed: workspace + uploads homes pass; outsiders and absent paths fail', () => {
    const root = tempDir('gru-command-ws-prov-');
    const uploads = tempDir('gru-command-uploads-prov-');
    writeFileSync(join(root, 'in-ws.md'), 'x');
    writeFileSync(join(uploads, '1-shot.png'), 'x');
    const outside = tempDir('gru-command-outside-prov-');
    writeFileSync(join(outside, 'secret.txt'), 'x');
    expect(chipPathAllowed(root, uploads, join(root, 'in-ws.md'))).toBe(true);
    expect(chipPathAllowed(root, uploads, join(uploads, '1-shot.png'))).toBe(true);
    expect(chipPathAllowed(root, uploads, join(outside, 'secret.txt'))).toBe(false);
    expect(chipPathAllowed(root, uploads, join(root, 'does-not-exist.md'))).toBe(false);
    expect(chipPathAllowed(root, uploads, 'relative/path.md')).toBe(false);
  });

  it('unknown paths and non-directories are 404s, null bytes are 400s', () => {
    const root = tempDir('gru-command-ws-404-');
    writeFileSync(join(root, 'file.txt'), 'x');
    expect(() => browseWorkspace(root, 'nope')).toThrow(/no such directory/);
    expect(() => browseWorkspace(root, 'file.txt')).toThrow(/not a directory/);
    expect(() => browseWorkspace(root, 'a\0b')).toThrow(/invalid browse path/);
  });
});

describe('attachments HTTP surface (/api/attach)', () => {
  let server: Server;
  let port = 0;
  const workspaceRoot = tempDir('gru-command-ws-http-');
  const dataDir = tempDir('gru-command-data-http-');
  const config = {
    workspaceRoot,
    dataDir,
    auth: { token: TOKEN },
  } as unknown as GruCommandConfig;

  beforeAll(async () => {
    mkdirSync(join(workspaceRoot, 'repo-a'));
    writeFileSync(join(workspaceRoot, 'repo-a', 'readme.md'), 'pick me');
    const attachments = createAttachmentsServer({ config });
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!attachments.requestHook(req, res, path)) {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    hashToken(TOKEN); // exercise the same hashing path as the server
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const auth = { authorization: `Bearer ${TOKEN}` };

  it('browse is token-gated (401) and returns metadata only', async () => {
    const unauth = await fetch(`http://127.0.0.1:${port}/api/attach/browse`);
    expect(unauth.status).toBe(401);
    const res = await fetch(`http://127.0.0.1:${port}/api/attach/browse?path=repo-a`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      root: string;
      entries: Array<{ name: string; kind: string; size: number | null }>;
    };
    expect(body.root).toBe(realpathSync(workspaceRoot));
    expect(body.entries).toEqual([{ name: 'readme.md', kind: 'file', size: 7, image: false }]);
  });

  it('uploads materialize under <data_dir>/uploads/ and return THAT path', async () => {
    const bytes = Buffer.from('phone-origin bytes');
    const res = await fetch(`http://127.0.0.1:${port}/api/attach/uploads`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'camera-roll.png', content_base64: bytes.toString('base64') }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { path: string; name: string; bytes: number };
    expect(body.path.startsWith(join(config.dataDir, 'uploads'))).toBe(true);
    expect(body.bytes).toBe(bytes.byteLength);
    expect(readFileSync(body.path, 'utf-8')).toBe('phone-origin bytes');
    expect(statSync(join(config.dataDir, 'uploads')).mode & 0o777).toBe(0o700);
  });

  it('uploads reject a bad body (400) and are token-gated (401)', async () => {
    const unauth = await fetch(`http://127.0.0.1:${port}/api/attach/uploads`, {
      method: 'POST',
      body: '{}',
    });
    expect(unauth.status).toBe(401);
    const bad = await fetch(`http://127.0.0.1:${port}/api/attach/uploads`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'x.bin' }),
    });
    expect(bad.status).toBe(400);
    const res = (await bad.json()) as { detail: string };
    expect(res.detail).toContain('content_base64');
  });

  it('unknown attach routes 404 under the hook', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/attach/nope`, { headers: auth });
    expect(res.status).toBe(404);
  });
});
