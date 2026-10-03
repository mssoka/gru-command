import { execFileSync } from 'node:child_process';
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGithubVerdictPoster,
  createStartupVerdictPoster,
  loadPerkinsAppBundle,
  parsePerkinsAppConfig,
  PerkinsAppError,
  PerkinsAppHttpError,
  PerkinsAppPrPoster,
  resolvePerkinsAppBundleRoot,
  resolvePerkinsAppKeyPath,
  type AppFetch,
  type AppFetchInit,
} from '../src/dispatch/perkins-github-app.js';
import { AutoVerdictPoster, GhPrPoster, GitLabMrPoster, type VerdictPoster, type VerdictPosterInput } from '../src/dispatch/perkins.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

// ---------------------------------------------------------------------------
// Fixtures: synthetic keys, fixture homes, fixture repo, mocked api.github.com
// ---------------------------------------------------------------------------

function syntheticAppKey(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

interface BundleFixture {
  readonly home: string;
  readonly key: ReturnType<typeof syntheticAppKey>;
  readonly repo: FixtureRepo;
  cleanup(): void;
}

/** A fixture instance dir with a Perkins App bundle and a fixture git repo
 * whose origin matches the PR under test. Nothing reads the real home. */
function makeBundleFixture(configText: string, originUrl = 'https://github.com/acme/widget.git'): BundleFixture {
  const home = mkdtempSync(join(tmpdir(), 'perkins-app-home-'));
  const key = syntheticAppKey();
  mkdirSync(join(home, 'perkins'), { recursive: true });
  // The deployed bundle directory is owner-only 0700 and the loader
  // enforces it; the fixture mirrors the real deployment.
  chmodSync(join(home, 'perkins'), 0o700);
  writeFileSync(join(home, 'perkins', 'app-key.pem'), key.privateKeyPem, 'utf8');
  chmodSync(join(home, 'perkins', 'app-key.pem'), 0o600);
  // The poster never interpolates config values; the fixture substitutes
  // its own placeholder BEFORE writing so the on-disk bytes are a literal
  // quoted absolute path exactly like the deployed bundle.
  const configPath = join(home, 'perkins', 'config');
  writeFileSync(configPath, configText.replaceAll('$BUNDLE_DIR', join(home, 'perkins')), 'utf8');
  // The deployed bundle is 0600 and the loader enforces it.
  chmodSync(configPath, 0o600);
  const repo = makeFixtureRepo('perkins-app-repo');
  execFileSync('git', ['-C', repo.path, 'remote', 'add', 'origin', originUrl], { stdio: 'ignore' });
  return {
    home,
    key,
    repo,
    cleanup() {
      rmSync(home, { recursive: true, force: true });
      repo.cleanup();
    },
  };
}

const DEFAULT_CONFIG = [
  'app_id=424242',
  'key_path="$BUNDLE_DIR/app-key.pem"',
  'installation_id_acme=164552969',
  'installation_id_solarity-services=999888777',
  '',
].join('\n');

const HEAD = '1'.repeat(40);
const BASE = '2'.repeat(40);
const TOKEN = `ghs_${'T'.repeat(36)}`;
/** One fixed clock shared by the poster seam and the mocked provider. */
const NOW = 1_800_000_000_000;

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly redirect?: string;
}

type RouteHandler = (call: RecordedCall) => Promise<{ status: number; body?: unknown; rawText?: string; headers?: Headers | Record<string, string>; stream?: ReadableStream<Uint8Array> }>;

interface Route {
  readonly method: string;
  readonly test: RegExp;
  handler: RouteHandler;
}

/** Fetch double bound to https://api.github.com only: records every call,
 * serves programmable routes. A URL off api.github.com throws loudly so a
 * credential leak fails the test, and no request ever leaves the process. */
function makeApiDouble(overrides: ReadonlyArray<Partial<Route> & { readonly method: string; readonly test: RegExp }> = []) {
  const calls: RecordedCall[] = [];
  const routes: Route[] = [];
  const overrideRoutes: Route[] = [];
  const add = (method: string, test: RegExp, handler: RouteHandler): void => {
    routes.push({ method, test, handler });
  };
  add('POST', /\/app\/installations\/164552969\/access_tokens$/, async () => ({
    status: 201,
    body: {
      token: TOKEN,
      expires_at: new Date(NOW + 3_600_000).toISOString(),
      permissions: { 'pull_requests': 'write', 'metadata': 'read' },
      repositories: [{ full_name: 'acme/widget', id: 1 }],
    },
  }));
  add('POST', /\/app\/installations\/999888777\/access_tokens$/, async () => ({
    status: 403,
    body: { message: 'This installation is suspended. ghs_leakedtoken1234567890' },
  }));
  add('GET', /^\/app$|^https:\/\/api\.github\.com\/app$/, async () => ({
    status: 200,
    body: { id: 424242, slug: 'perkins-review', owner: { login: 'solarity-services' } },
  }));
  add('GET', /\/repos\/acme\/widget\/pulls\/7$/, async () => ({
    status: 200,
    body: { number: 7, head: { sha: HEAD }, base: { sha: BASE } },
  }));
  add('POST', /\/repos\/acme\/widget\/pulls\/7\/reviews$/, async () => ({
    status: 200,
    body: {
      id: 987654,
      user: { login: 'perkins-review[bot]', type: 'Bot', id: 308038895 },
      commit_id: HEAD,
      state: 'COMMENTED',
      body: 'review body\n',
    },
  }));
  for (const override of overrides) {
    overrideRoutes.push({ handler: async () => ({ status: 404, body: { message: 'no route' } }), ...override } as Route);
  }
  const fetchImpl: AppFetch = async (url, init: AppFetchInit = {}) => {
    const call: RecordedCall = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.redirect !== undefined ? { redirect: init.redirect } : {}),
    };
    calls.push(call);
    if (!url.startsWith('https://api.github.com/')) {
      throw new Error(`test double refused a non-api.github.com URL: ${url}`);
    }
    const route = overrideRoutes.find((candidate) => candidate.method === call.method && candidate.test.test(url)) ??
      routes.find((candidate) => candidate.method === call.method && candidate.test.test(url));
    if (route === undefined) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ message: `no test route for ${call.method} ${url}` }) };
    }
    const response = await route.handler(call);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      ...(response.headers !== undefined ? { headers: response.headers } : {}),
      ...(response.stream !== undefined ? { body: response.stream } : {}),
      text: async () => response.rawText ?? JSON.stringify(response.body ?? null),
    };
  };
  return { fetchImpl, calls };
}

const fixtureStack: BundleFixture[] = [];
afterEach(() => {
  while (fixtureStack.length > 0) fixtureStack.pop()!.cleanup();
});

function bundleFixture(configText: string = DEFAULT_CONFIG, originUrl?: string): BundleFixture {
  const fixture = makeBundleFixture(configText, originUrl);
  fixtureStack.push(fixture);
  return fixture;
}

function posterWith(fixture: BundleFixture, overrides: Parameters<typeof makeApiDouble>[0] = [], options: Partial<ConstructorParameters<typeof PerkinsAppPrPoster>[0]> = {}): { poster: PerkinsAppPrPoster; calls: RecordedCall[] } {
  const api = makeApiDouble(overrides);
  const poster = new PerkinsAppPrPoster({
    instanceDir: fixture.home,
    fetchImpl: api.fetchImpl,
    now: () => NOW,
    ...options,
  });
  return { poster, calls: api.calls };
}

const PR_INPUT = {
  prUrl: 'https://github.com/acme/widget/pull/7',
  host: 'github.com',
  body: 'review body\n',
  targetSha: HEAD,
  baseSha: BASE,
} as const;

function repoPathOf(fixture: BundleFixture): string {
  return fixture.repo.path;
}

// ---------------------------------------------------------------------------
// Bundle config parsing (literal KEY=VALUE, never shell)
// ---------------------------------------------------------------------------

describe('Perkins App bundle config parsing', () => {
  it('parses the installed literal shape: quoted/unquoted paths, hyphenated org owners, no shell interpolation', () => {
    const config = parsePerkinsAppConfig(
      [
        '# literal data, not shell',
        'app_id=4366368',
        'key_path="/opt/keys/perkins key.pem"',
        "installation_id_widget-shop=111222333",
        'installation_id_solarity-services=999888777',
        '  installation_id_MixedCase=42  ',
        '',
      ].join('\n'),
      'perkins app bundle',
    );
    expect(config.appId).toBe(4366368);
    expect(config.keyPath).toBe('/opt/keys/perkins key.pem');
    expect(config.installationIds.get('widget-shop')).toBe('111222333');
    // Hyphenated organization owner survives as a distinct mapping.
    expect(config.installationIds.get('solarity-services')).toBe('999888777');
    // Owner lookup is case-insensitive: MixedCase maps lowercased.
    expect(config.installationIds.get('mixedcase')).toBe('42');
  });

  it('never shell-interpolates values: $HOME stays literal and unquoted paths keep every byte', () => {
    const config = parsePerkinsAppConfig(
      ['app_id=1', 'key_path=$HOME/perkins/app-key.pem', 'installation_id_acme=5'].join('\n'),
      'perkins app bundle',
    );
    expect(config.keyPath).toBe('$HOME/perkins/app-key.pem');
    const unquoted = parsePerkinsAppConfig(
      ['app_id=1', 'key_path=/plain/path.pem', 'installation_id_acme=5'].join('\n'),
      'perkins app bundle',
    );
    expect(unquoted.keyPath).toBe('/plain/path.pem');
  });

  it('fails closed with actionable errors on missing or conflicting entries', () => {
    expect(() => parsePerkinsAppConfig('key_path=/k.pem\ninstallation_id_acme=5\n', 'perkins app bundle'))
      .toThrow(PerkinsAppError);
    expect(() => parsePerkinsAppConfig('key_path=/k.pem\ninstallation_id_acme=5\n', 'perkins app bundle'))
      .toThrow(/app_id/u);
    expect(() => parsePerkinsAppConfig('app_id=1\ninstallation_id_acme=5\n', 'perkins app bundle'))
      .toThrow(/key_path/u);
    expect(() => parsePerkinsAppConfig('app_id=1\nkey_path=/k.pem\n', 'perkins app bundle'))
      .toThrow(/installation_id/u);
    expect(() => parsePerkinsAppConfig('app_id=1\napp_id=2\nkey_path=/k.pem\ninstallation_id_acme=5\n', 'perkins app bundle'))
      .toThrow(/different values/u);
    expect(() => parsePerkinsAppConfig('this is not key value data\n', 'perkins app bundle'))
      .toThrow(/line 1/u);
    expect(() => parsePerkinsAppConfig('app_id=0\nkey_path=/k.pem\ninstallation_id_acme=5\n', 'perkins app bundle'))
      .toThrow(/app_id/u);
    // Case-variant owners collide in the lowercased lookup: a conflict,
    // never a silent last-one-wins.
    expect(() => parsePerkinsAppConfig('app_id=1\nkey_path=/k.pem\ninstallation_id_Acme=5\ninstallation_id_acme=6\n', 'perkins app bundle'))
      .toThrow(/configured twice with different values/u);
    expect(() => parsePerkinsAppConfig('app_id=1\nkey_path=/k.pem\ninstallation_id_=5\n', 'perkins app bundle'))
      .toThrow(/has no owner/u);
    // The bundle contract is closed: unknown keys are provisioning
    // misspellings, not silently ignored extras.
    expect(() => parsePerkinsAppConfig('app_id=1\nkey_path=/k.pem\nkey-path=/other.pem\ninstallation_id_acme=5\n', 'perkins app bundle'))
      .toThrow(/unrecognized key \(key-path\)/u);
  });

  it('sanitizes credential-shaped unknown keys in diagnostics while retaining the line number', () => {
    // KEY_PATTERN admits pasted tokens as unknown keys; the error must
    // carry the line number, never credential-shaped bytes — for BOTH
    // token shapes (the github_pat_ prefix only survives a pre-truncation
    // sanitize).
    for (const credentialKey of [`ghs_${'A'.repeat(36)}`, `github_pat_${'B'.repeat(36)}`]) {
      const keyError = (() => {
        try {
          parsePerkinsAppConfig(`app_id=1\n${credentialKey}=/x\nkey_path=/k.pem\ninstallation_id_acme=5\n`, 'perkins app bundle');
          return 'no error thrown';
        } catch (caught) {
          return caught instanceof Error ? caught.message : String(caught);
        }
      })();
      expect(keyError).toMatch(/line 2/u);
      expect(keyError).toMatch(/unrecognized key/u);
      expect(keyError).not.toContain(credentialKey);
      expect(keyError).not.toContain('ghs_');
      expect(keyError).not.toContain('github_pat_');
    }
  });

  it('sanitizes genuine duplicate-key and case-folded duplicate-owner diagnostics with differing values', () => {
    // The SAME credential-shaped installation key twice with DIFFERING
    // values must throw (never a silent last-one-wins) via the
    // exact-duplicate-key rule — and never echo the raw key bytes.
    const credentialKey = `installation_id_ghs_${'C'.repeat(36)}`;
    const dupKeyError = (() => {
      try {
        parsePerkinsAppConfig(`app_id=1\n${credentialKey}=5\n${credentialKey}=6\nkey_path=/k.pem\n`, 'perkins app bundle');
        return 'no error thrown';
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    })();
    expect(dupKeyError).toMatch(/appears twice with different values/u);
    expect(dupKeyError).not.toContain('ghs_');
    expect(dupKeyError).not.toContain(`ghs_${'C'.repeat(36)}`);
    // A case-folded duplicate OWNER with differing ids throws too: a
    // conflict, never a silent last-one-wins.
    const ownerError = (() => {
      try {
        parsePerkinsAppConfig('app_id=1\nkey_path=/k.pem\ninstallation_id_Acme=5\ninstallation_id_acme=6\n', 'perkins app bundle');
        return 'no error thrown';
      } catch (caught) {
        return caught instanceof Error ? caught.message : String(caught);
      }
    })();
    expect(ownerError).toMatch(/configured twice with different values/u);
  });

  it('sanitizes separator-free lines in diagnostics: full-value redaction for github_pat_ and embedded shapes', () => {
    // A line without '=' is echoed as a key/line prefix. Pre-truncation
    // (24 chars) left a separator-free github_pat_ token at prefix + 13
    // suffix characters — below the sanitizer's 16-char threshold. The
    // FULL line must be sanitized first.
    for (const bareLine of [`github_pat_${'B'.repeat(36)}`, `token github_pat_${'B'.repeat(36)}`, `ghs_${'A'.repeat(36)}`]) {
      const error = (() => {
        try {
          parsePerkinsAppConfig(`app_id=1\n${bareLine}\nkey_path=/k.pem\ninstallation_id_acme=5\n`, 'perkins app bundle');
          return 'no error thrown';
        } catch (caught) {
          return caught instanceof Error ? caught.message : String(caught);
        }
      })();
      expect(error).toMatch(/is not KEY=VALUE/u);
      expect(error).toMatch(/line 2/u);
      expect(error).not.toContain('github_pat_');
      expect(error).not.toContain('ghs_');
      expect(error).not.toContain(bareLine);
    }
  });

  it('loads a bundle whose relative key_path resolves against the trusted bundle dir, and rejects non-RSA keys', () => {
    const fixture = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    const loaded = loadPerkinsAppBundle(fixture.home);
    expect(loaded.config.appId).toBe(424242);
    expect(loaded.config.keyPath).toBe(join(fixture.home, 'perkins', 'app-key.pem'));

    const ecHome = mkdtempSync(join(tmpdir(), 'perkins-app-ec-'));
    try {
      const ec = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        privateKeyEncoding: { type: 'sec1', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      mkdirSync(join(ecHome, 'perkins'), { recursive: true });
      chmodSync(join(ecHome, 'perkins'), 0o700);
      writeFileSync(join(ecHome, 'perkins', 'app-key.pem'), ec.privateKey, 'utf8');
      chmodSync(join(ecHome, 'perkins', 'app-key.pem'), 0o600);
      const ecConfig = join(ecHome, 'perkins', 'config');
      writeFileSync(ecConfig, 'app_id=1\nkey_path=app-key.pem\ninstallation_id_acme=5\n', 'utf8');
      chmodSync(ecConfig, 0o600);
      expect(() => loadPerkinsAppBundle(ecHome)).toThrow(/not RSA/u);
    } finally {
      rmSync(ecHome, { recursive: true, force: true });
    }
  });

  it('rejects App and installation ids outside the safe integer range instead of converting them', () => {
    expect(() => parsePerkinsAppConfig(`app_id=${'9'.repeat(400)}\nkey_path=/k.pem\ninstallation_id_acme=5\n`, 'perkins app bundle'))
      .toThrow(/safe integer/u);
    expect(() => parsePerkinsAppConfig(`app_id=1\nkey_path=/k.pem\ninstallation_id_acme=${'9'.repeat(20)}\n`, 'perkins app bundle'))
      .toThrow(/safe integer/u);
  });
});

// ---------------------------------------------------------------------------
// Bundle file safety (owner-owned 0600 regular files)
// ---------------------------------------------------------------------------

describe('bundle file safety', () => {
  it('rejects a bundle config or key with permissive mode, and a symlinked key', () => {
    const fixture = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    chmodSync(join(fixture.home, 'perkins', 'config'), 0o644);
    expect(() => loadPerkinsAppBundle(fixture.home)).toThrow(/owner-only/u);

    const looseKey = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    chmodSync(join(looseKey.home, 'perkins', 'app-key.pem'), 0o644);
    expect(() => loadPerkinsAppBundle(looseKey.home)).toThrow(/owner-only/u);

    const linked = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    const linkedConfig = join(linked.home, 'perkins', 'config');
    writeFileSync(linkedConfig, 'app_id=424242\nkey_path=linked-key.pem\ninstallation_id_acme=164552969\n', 'utf8');
    chmodSync(linkedConfig, 0o600);
    symlinkSync(join(linked.home, 'perkins', 'app-key.pem'), join(linked.home, 'perkins', 'linked-key.pem'));
    expect(() => loadPerkinsAppBundle(linked.home)).toThrow(/symbolic link/u);
  });

  it('rejects a permissive or symlinked bundle directory, and accepts a read-only (0400) key', () => {
    const fixture = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    chmodSync(join(fixture.home, 'perkins'), 0o755);
    try {
      expect(() => loadPerkinsAppBundle(fixture.home)).toThrow(/mode 0700/u);
    } finally {
      chmodSync(join(fixture.home, 'perkins'), 0o700);
    }

    const dirLinked = mkdtempSync(join(tmpdir(), 'perkins-app-dirlinked-'));
    try {
      mkdirSync(join(dirLinked, 'real-perkins'), { recursive: true });
      symlinkSync(join(dirLinked, 'real-perkins'), join(dirLinked, 'perkins'));
      expect(() => loadPerkinsAppBundle(dirLinked)).toThrow(/symbolic link/u);
    } finally {
      rmSync(dirLinked, { recursive: true, force: true });
    }

    // 0400 is a legitimate hardened key: owner-only AND owner-readable.
    const readOnly = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    chmodSync(join(readOnly.home, 'perkins', 'app-key.pem'), 0o400);
    const loaded = loadPerkinsAppBundle(readOnly.home);
    expect(loaded.config.appId).toBe(424242);
  });

  it('rejects a bundle directory carrying setuid/setgid/sticky bits — exact 0700 includes the high bits', () => {
    const fixture = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    const dir = join(fixture.home, 'perkins');
    chmodSync(dir, 0o2700);
    try {
      // The chmod must actually carry the special bit; otherwise this
      // oracle would silently prove nothing.
      expect(lstatSync(dir).mode & 0o7777).toBe(0o2700);
      expect(() => loadPerkinsAppBundle(fixture.home)).toThrow(/mode 0700 exactly \(found 2700\)/u);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it('rejects a bundle file owned by another user (directory and file branches both)', () => {
    if (process.getuid === undefined || process.getuid() === 0) return; // not observable on this platform
    const fixture = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    const original = process.getuid;
    const seam = process as { getuid?: () => number };
    try {
      // Directory-level: the first uid read belongs to the bundle dir, so
      // the directory check fires before any file is inspected.
      let calls = 0;
      seam.getuid = () => {
        calls += 1;
        return original() + 1;
      };
      expect(() => loadPerkinsAppBundle(fixture.home)).toThrow(/bundle directory is owned by another user/u);
      expect(calls).toBe(1);

      // File-level: pass the directory (uid read #1) and the config file
      // (#2), then fail the KEY file (#3). A regression that drops the
      // per-file ownership check would load the bundle instead of failing.
      calls = 0;
      seam.getuid = () => {
        calls += 1;
        return calls >= 3 ? original() + 1 : original();
      };
      expect(() => loadPerkinsAppBundle(fixture.home)).toThrow(/configured private key file is owned by another user/u);
      expect(calls).toBe(3);
    } finally {
      seam.getuid = original;
    }
  });

  it('rejects a FIFO at the bundle file path promptly — the open must not hold the round hostage', () => {
    if (process.platform === 'win32') return; // mkfifo is POSIX-only
    const home = mkdtempSync(join(tmpdir(), 'perkins-app-fifo-'));
    try {
      mkdirSync(join(home, 'perkins'), { recursive: true });
      chmodSync(join(home, 'perkins'), 0o700);
      execFileSync('mkfifo', [join(home, 'perkins', 'config')]);
      expect(() => loadPerkinsAppBundle(home)).toThrow(/not a regular file/u);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('bounds the read stage itself: a file that exceeds the ceiling when read is refused, never buffered', () => {
    const fixture = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    // The stat reports a small credential file; the read stage is where the
    // grow-after-stat backstop lives. The seam returns more bytes than any
    // stat could have reported without ever touching the key.
    const readImpl = (_fd: number, buffer: Buffer, offset: number, length: number): number => {
      buffer.fill(0x61, offset, offset + length);
      return length;
    };
    expect(() => loadPerkinsAppBundle(fixture.home, { readImpl })).toThrow(/exceeded 1048576 bytes when read/u);
  });
});

// ---------------------------------------------------------------------------
// Startup selection
// ---------------------------------------------------------------------------

describe('startup poster selection (the seam main wires)', () => {
  it('keeps the legacy gh poster and the GitLab leg when no App bundle exists', () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'perkins-app-empty-'));
    try {
      expect(createGithubVerdictPoster(emptyHome)).toBeInstanceOf(GhPrPoster);
      const auto = createStartupVerdictPoster({ instanceDir: emptyHome });
      const legs = auto as unknown as { github: VerdictPoster; gitlab: VerdictPoster };
      expect(legs.github).toBeInstanceOf(GhPrPoster);
      expect(legs.gitlab).toBeInstanceOf(GitLabMrPoster);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('behaviorally routes the no-bundle composite github leg through the githubPosterOverride test seam', async () => {
    const fixture = bundleFixture();
    const emptyHome = mkdtempSync(join(tmpdir(), 'perkins-app-empty-route-'));
    try {
      const routed: string[] = [];
      const stub: VerdictPoster = {
        post: async (input) => {
          routed.push(input.prUrl);
          return { headSha: input.targetSha, baseSha: input.baseSha, reviewId: 'github-stub', actor: 'github-stub', event: 'COMMENTED', commitId: null, bodySha256: 'github-stub' };
        },
      };
      const auto = createStartupVerdictPoster({ instanceDir: emptyHome }, { githubPosterOverride: stub });
      await expect(auto.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
        .resolves.toEqual({
          headSha: HEAD, baseSha: BASE, reviewId: 'github-stub', actor: 'github-stub',
          event: 'COMMENTED', commitId: null, bodySha256: 'github-stub',
        });
      expect(routed).toEqual([PR_INPUT.prUrl]);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('refuses the override test seam when an App bundle is configured', () => {
    const fixture = bundleFixture();
    const stub: VerdictPoster = {
      post: async () => { throw new Error('the override must never be selected in App mode'); },
    };
    // An installed bundle makes the App publisher mandatory: the test seam
    // must fail loudly rather than silently replace it with any poster.
    expect(() => createGithubVerdictPoster(fixture.home, { githubPosterOverride: stub })).toThrow(/githubPosterOverride/u);
    expect(() => createStartupVerdictPoster({ instanceDir: fixture.home }, { githubPosterOverride: stub })).toThrow(/githubPosterOverride/u);
    // A bundle-absent home keeps the seam usable (also pinned behaviorally
    // by the no-bundle routing test above).
    const emptyHome = mkdtempSync(join(tmpdir(), 'perkins-app-override-empty-'));
    try {
      expect(createGithubVerdictPoster(emptyHome, { githubPosterOverride: stub })).toBe(stub);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('routes github.com through the App poster when the bundle exists, with GitLab routing untouched', async () => {
    const fixture = bundleFixture();
    const api = makeApiDouble();
    const auto = createStartupVerdictPoster({ instanceDir: fixture.home }, {
      fetchImpl: api.fetchImpl,
      now: () => NOW,
    });
    const legs = auto as unknown as { github: VerdictPoster; gitlab: VerdictPoster };
    expect(legs.github).toBeInstanceOf(PerkinsAppPrPoster);
    // The wired composite delivers a github.com round through the App.
    await expect(auto.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    expect(api.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    // The router still hands GitLab URLs to the GitLab leg, never the App.
    const gitlabCalls: string[] = [];
    const router = new AutoVerdictPoster(legs.github, {
      post: async (input) => {
        gitlabCalls.push(input.prUrl);
        return { headSha: input.targetSha, baseSha: input.baseSha, reviewId: 'gitlab-stub', actor: 'gitlab-stub', event: 'note', commitId: null, bodySha256: 'gitlab-stub' };
      },
    });
    await router.post({
      prUrl: 'https://gitlab.example.test/acme/widget/-/merge_requests/7',
      host: 'gitlab.example.test',
      repoPath: repoPathOf(fixture),
      body: 'x',
      targetSha: HEAD,
      baseSha: BASE,
    });
    expect(gitlabCalls).toEqual(['https://gitlab.example.test/acme/widget/-/merge_requests/7']);
  });

  it('defers bundle validation to publication time — a broken bundle never bricks startup', () => {
    const broken = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    writeFileSync(join(broken.home, 'perkins', 'app-key.pem'), 'definitely not a pem private key\n', 'utf8');
    const build = (): ReturnType<typeof createStartupVerdictPoster> => createStartupVerdictPoster({ instanceDir: broken.home });
    expect(build).not.toThrow();
    const legs = build() as unknown as { github: VerdictPoster; gitlab: VerdictPoster };
    expect(legs.github).toBeInstanceOf(PerkinsAppPrPoster);
  });

  it('treats a dangling symlinked bundle config as present — never a silent personal-credential fallback', async () => {
    const home = mkdtempSync(join(tmpdir(), 'perkins-app-dangling-'));
    try {
      mkdirSync(join(home, 'perkins'), { recursive: true });
      chmodSync(join(home, 'perkins'), 0o700);
      symlinkSync(join(home, 'perkins', 'missing-config'), join(home, 'perkins', 'config'));
      // Selection sees the bundle; failure is loud and actionable at load.
      // The fetch double must never be reached: this path is offline by
      // construction, not by statement ordering.
      let networkAttempted = false;
      const poster = createGithubVerdictPoster(home, {
        fetchImpl: (async () => {
          networkAttempted = true;
          throw new Error('the fetch double must never run for a broken bundle');
        }) as AppFetch,
      });
      expect(poster).toBeInstanceOf(PerkinsAppPrPoster);
      const repo = makeFixtureRepo('perkins-app-dangling-repo');
      try {
        execFileSync('git', ['-C', repo.path, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git'], { stdio: 'ignore' });
        await expect(poster.post({ ...PR_INPUT, repoPath: repo.path }))
          .rejects.toThrow(/symbolic link/u);
        expect(networkAttempted).toBe(false);
      } finally {
        repo.cleanup();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('selects App mode for any bundle-shaped presence: a directory-named config, an unreadable path, a dangling perkins-dir symlink', async () => {
    // A directory named <instance>/perkins/config: not a regular file, but
    // presence — selection must never silently fall back to the personal
    // poster; the load fails loudly instead.
    const dirConfig = mkdtempSync(join(tmpdir(), 'perkins-app-dirconfig-'));
    try {
      mkdirSync(join(dirConfig, 'perkins', 'config'), { recursive: true });
      chmodSync(join(dirConfig, 'perkins'), 0o700);
      expect(createGithubVerdictPoster(dirConfig)).toBeInstanceOf(PerkinsAppPrPoster);
      expect(() => loadPerkinsAppBundle(dirConfig)).toThrow(/not a regular file/u);
    } finally {
      rmSync(dirConfig, { recursive: true, force: true });
    }

    // lstat ENOTDIR (instance dir is a file): present, loud at load.
    const fileInstanceHome = mkdtempSync(join(tmpdir(), 'perkins-app-fileinstance-'));
    try {
      const fileInstance = join(fileInstanceHome, 'not-a-dir');
      writeFileSync(fileInstance, 'not a directory\n', 'utf8');
      expect(createGithubVerdictPoster(fileInstance)).toBeInstanceOf(PerkinsAppPrPoster);
    } finally {
      rmSync(fileInstanceHome, { recursive: true, force: true });
    }

    // A dangling perkins-dir symlink: ENOENT on config, but a broken
    // bundle — never a missing one.
    const home = mkdtempSync(join(tmpdir(), 'perkins-app-dirlink-'));
    try {
      symlinkSync(join(home, 'missing-perkins'), join(home, 'perkins'));
      expect(createGithubVerdictPoster(home)).toBeInstanceOf(PerkinsAppPrPoster);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('selects App mode when the config stat fails EACCES — an unreadable bundle is never mistaken for absence', () => {
    if (process.getuid === undefined || process.getuid() === 0) return; // permission failure not observable as root
    const home = mkdtempSync(join(tmpdir(), 'perkins-app-eacces-'));
    const perkins = join(home, 'perkins');
    mkdirSync(perkins, { recursive: true });
    try {
      chmodSync(perkins, 0o000);
      // lstat(<home>/perkins/config) now fails EACCES (the parent denies
      // search). Selection must read that as presence, never as absence —
      // a racing unreadable stat can never demote an App deployment to the
      // personal gh poster.
      expect(createGithubVerdictPoster(home)).toBeInstanceOf(PerkinsAppPrPoster);
      const legs = createStartupVerdictPoster({ instanceDir: home }) as unknown as { github: VerdictPoster };
      expect(legs.github).toBeInstanceOf(PerkinsAppPrPoster);
    } finally {
      chmodSync(perkins, 0o700);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps the legacy gh poster when a real perkins/ directory exists without a config — the directory alone is not a bundle', () => {
    const home = mkdtempSync(join(tmpdir(), 'perkins-app-dir-no-config-'));
    try {
      mkdirSync(join(home, 'perkins'), { recursive: true });
      chmodSync(join(home, 'perkins'), 0o700);
      expect(createGithubVerdictPoster(home)).toBeInstanceOf(GhPrPoster);
      const legs = createStartupVerdictPoster({ instanceDir: home }) as unknown as { github: VerdictPoster; gitlab: VerdictPoster };
      expect(legs.github).toBeInstanceOf(GhPrPoster);
      expect(legs.gitlab).toBeInstanceOf(GitLabMrPoster);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to the legacy gh poster when only the bundle config is removed — the documented restoration path', () => {
    const fixture = bundleFixture();
    expect(createGithubVerdictPoster(fixture.home)).toBeInstanceOf(PerkinsAppPrPoster);
    rmSync(join(fixture.home, 'perkins', 'config'));
    expect(createGithubVerdictPoster(fixture.home)).toBeInstanceOf(GhPrPoster);
    const legs = createStartupVerdictPoster({ instanceDir: fixture.home }) as unknown as { github: VerdictPoster };
    expect(legs.github).toBeInstanceOf(GhPrPoster);
  });
});

// ---------------------------------------------------------------------------
// Publication flow
// ---------------------------------------------------------------------------

describe('App publication happy path', () => {
  it('publishes a COMMENT review as the verified App bot with least-scope tokens and a valid RS256 JWT', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);

    // Sequence: mint token -> prove App identity -> prove PR head -> POST review.
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'POST https://api.github.com/app/installations/164552969/access_tokens',
      'GET https://api.github.com/app',
      'GET https://api.github.com/repos/acme/widget/pulls/7',
      'POST https://api.github.com/repos/acme/widget/pulls/7/reviews',
    ]);
    // No /user probe: an installation token is not a user token.
    expect(calls.some((call) => call.url.endsWith('/user'))).toBe(false);

    const mint = calls[0]!;
    // The JWT is a valid RS256 signature by the bundle key with iss = app id.
    const [encodedHeader, encodedPayload, signature] = (mint.headers['AUTHORIZATION'] ?? '').replace(/^Bearer /u, '').split('.');
    expect(encodedHeader).toBe(Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url'));
    const payload = JSON.parse(Buffer.from(encodedPayload!, 'base64url').toString('utf8')) as { iat: number; exp: number; iss: string };
    expect(payload.iss).toBe('424242');
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    const verified = createVerify('RSA-SHA256')
      .update(`${encodedHeader}.${encodedPayload}`)
      .verify(fixture.key.publicKeyPem, Buffer.from(signature!, 'base64url'));
    expect(verified).toBe(true);

    // Least scope: one repository, only the permissions publication needs.
    expect(JSON.parse(mint.body!)).toEqual({
      repositories: ['widget'],
      permissions: { 'pull_requests': 'write', 'metadata': 'read' },
    });

    // Credential class per endpoint: the /app probe carries the App JWT,
    // the repository APIs carry the installation token.
    expect(calls[1]!.headers['AUTHORIZATION']).toBe(mint.headers['AUTHORIZATION']);
    expect(calls[2]!.headers['AUTHORIZATION']).toBe(`Bearer ${TOKEN}`);

    const post = calls[3]!;
    expect(JSON.parse(post.body!)).toEqual({ body: 'review body\n', event: 'COMMENT', commit_id: HEAD });
    expect(post.headers['AUTHORIZATION']).toBe(`Bearer ${TOKEN}`);
    // Credential hygiene everywhere: api.github.com only, redirects refused.
    for (const call of calls) {
      expect(call.url.startsWith('https://api.github.com/')).toBe(true);
      expect(call.redirect).toBe('error');
    }
  });

  it('verifies the PR head before the irreversible POST and refuses a moved head', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'GET', test: /\/repos\/acme\/widget\/pulls\/7$/, handler: async () => ({ status: 200, body: { head: { sha: '9'.repeat(40) }, base: { sha: BASE } } }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).rejects.toThrow(/identity moved/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('refuses a PR identity response missing the base sha before any POST', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'GET', test: /\/repos\/acme\/widget\/pulls\/7$/, handler: async () => ({ status: 200, body: { head: { sha: HEAD } } }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).rejects.toThrow(/base sha/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('sanitizes provider-controlled head bytes in the moved-head diagnostic', async () => {
    const fixture = bundleFixture();
    const secret = `ghs_${'S'.repeat(36)}`;
    const hostileSha = `9${'x'.repeat(79)}\n${secret}`;
    const { poster, calls } = posterWith(fixture, [
      { method: 'GET', test: /\/repos\/acme\/widget\/pulls\/7$/, handler: async () => ({ status: 200, body: { head: { sha: hostileSha }, base: { sha: BASE } } }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    // The moved-head diagnostic is the one provider field that must go
    // through the module's redaction discipline like every other one:
    // token-shaped bytes never reach the record and newlines are collapsed.
    expect(error?.message ?? '').toContain('[REDACTED]');
    expect(error?.message ?? '').not.toContain(secret);
    expect(error?.message ?? '').not.toContain('\n');
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('validates the PR URL and repository origin exactly like the deployed contract', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture);
    await expect(poster.post({
      ...PR_INPUT, repoPath: repoPathOf(fixture), host: 'github.com',
      prUrl: 'https://evil.example/acme/widget/pull/7',
    })).rejects.toThrow(/host-mismatched/u);
    // A different owner/repo on the same host fails the origin check.
    await expect(poster.post({
      ...PR_INPUT, repoPath: repoPathOf(fixture), prUrl: 'https://github.com/acme/other/pull/7',
    })).rejects.toThrow(/origin/u);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed credential and identity checks
// ---------------------------------------------------------------------------

describe('fail-closed credential and identity checks', () => {
  it('refuses when the repository owner has no installation mapping — no fetch, no gh fallback', async () => {
    const fixture = bundleFixture(DEFAULT_CONFIG, 'https://github.com/unknown-org/widget.git');
    const { poster, calls } = posterWith(fixture);
    await expect(poster.post({
      ...PR_INPUT, repoPath: repoPathOf(fixture), prUrl: 'https://github.com/unknown-org/widget/pull/7',
    })).rejects.toThrow(/no installation_id mapping for repository owner "unknown-org"/u);
    expect(calls).toHaveLength(0);
  });

  it('fails sanitized when the key file is missing, unreadable, or not a valid RSA PEM', async () => {
    const fixture = bundleFixture('app_id=424242\nkey_path=/nonexistent/app-key.pem\ninstallation_id_acme=164552969\n');
    const missing = posterWith(fixture);
    await expect(missing.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/missing or inaccessible/u);
    expect(missing.calls).toHaveLength(0);

    const garbage = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    writeFileSync(join(garbage.home, 'perkins', 'app-key.pem'), 'definitely not a pem private key\n', 'utf8');
    const invalid = posterWith(garbage);
    const error = await invalid.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(PerkinsAppError);
    expect(error?.message ?? '').not.toContain('definitely not a pem');
    expect(invalid.calls).toHaveLength(0);
  });

  it('fails before POST when the authenticated App is not the configured App', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'GET', test: /\/app$/, handler: async () => ({ status: 200, body: { id: 999999, slug: 'other-app' } }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/App identity mismatch/u);
    expect(calls.filter((call) => call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('refuses a missing, blank, or charset-invalid App slug before POST — the bot identity must be derivable', async () => {
    const fixture = bundleFixture();
    for (const body of [{ id: 424242 }, { id: 424242, slug: '' }, { id: 424242, slug: 'bad slug!' }]) {
      const { poster, calls } = posterWith(fixture, [
        { method: 'GET', test: /\/app$/, handler: async () => ({ status: 200, body }) },
      ]);
      await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).rejects.toThrow(/usable slug/u);
      expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
    }
  });

  it('refuses an over-length App slug whose derived bot login would break the shared receipt contract', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'GET', test: /\/app$/, handler: async () => ({ status: 200, body: { id: 424242, slug: 'a'.repeat(196) } }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).rejects.toThrow(/receipt contract/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('fails before POST when the token grant lacks the permission or the repository binding', async () => {
    const fixture = bundleFixture();
    const noWrite = posterWith(fixture, [
      { method: 'POST', test: /access_tokens$/, handler: async () => ({ status: 201, body: { token: TOKEN, expires_at: new Date(NOW + 3_600_000).toISOString(), permissions: { 'pull_requests': 'read' }, repositories: [{ full_name: 'acme/widget' }] } }) },
    ]);
    await expect(noWrite.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/pull_requests:write/u);
    expect(noWrite.calls.filter((call) => call.url.endsWith('/reviews'))).toHaveLength(0);

    const otherRepo = posterWith(fixture, [
      { method: 'POST', test: /access_tokens$/, handler: async () => ({ status: 201, body: { token: TOKEN, expires_at: new Date(NOW + 3_600_000).toISOString(), permissions: { 'pull_requests': 'write' }, repositories: [{ full_name: 'acme/other' }] } }) },
    ]);
    await expect(otherRepo.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/does not cover repository acme\/widget/u);
    expect(otherRepo.calls.filter((call) => call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('fails on an expired token grant and maps mint rejections to actionable named errors', async () => {
    const fixture = bundleFixture();
    const expired = posterWith(fixture, [
      { method: 'POST', test: /access_tokens$/, handler: async () => ({ status: 201, body: { token: TOKEN, expires_at: new Date(NOW - 60_000).toISOString(), permissions: { 'pull_requests': 'write' }, repositories: [{ full_name: 'acme/widget' }] } }) },
    ]);
    await expect(expired.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/expired/u);

    const suspended = posterWith(bundleFixture(DEFAULT_CONFIG, 'https://github.com/solarity-services/widget.git'));
    const suspendedFixture = fixtureStack[fixtureStack.length - 1]!;
    await expect(suspended.poster.post({
      ...PR_INPUT, repoPath: repoPathOf(suspendedFixture), prUrl: 'https://github.com/solarity-services/widget/pull/7',
    })).rejects.toThrow(/403/u);

    const unauthorized = posterWith(fixture, [
      { method: 'POST', test: /access_tokens$/, handler: async () => ({ status: 401, body: { message: 'A JSON web token could not be decoded' } }) },
    ]);
    await expect(unauthorized.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/401/u);

    const notFound = posterWith(fixture, [
      { method: 'POST', test: /access_tokens$/, handler: async () => ({ status: 404, body: { message: 'Not Found' } }) },
    ]);
    await expect(notFound.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/404/u);
  });

  it('distinguishes rate-limit refusals from a suspended installation (primary 403, secondary 403, 429)', async () => {
    const fixture = bundleFixture();
    const primary = posterWith(fixture, [
      {
        method: 'POST', test: /access_tokens$/,
        handler: async () => ({
          status: 403,
          body: {
            message: 'API rate limit exceeded for installation ID 164552969.',
            documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limits',
          },
        }),
      },
    ]);
    await expect(primary.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/rate limiting/u);

    const secondary = posterWith(fixture, [
      {
        method: 'POST', test: /access_tokens$/,
        handler: async () => ({
          status: 403,
          body: {
            message: 'You have exceeded a secondary rate limit and should try again later.',
            documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#secondary-rate-limits',
          },
        }),
      },
    ]);
    await expect(secondary.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/rate limiting/u);

    const tooMany = posterWith(fixture, [
      { method: 'POST', test: /access_tokens$/, handler: async () => ({ status: 429, body: { message: 'Too many requests' } }) },
    ]);
    await expect(tooMany.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/429/u);

    // Message-only variants: the plural and gerund forms carry the same
    // window-reset meaning with no documentation_url at all.
    const plural = posterWith(fixture, [
      { method: 'POST', test: /access_tokens$/, handler: async () => ({ status: 403, body: { message: 'You have exceeded the secondary rate limits.' } }) },
    ]);
    await expect(plural.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/rate limiting/u);
    const gerund = posterWith(fixture, [
      { method: 'POST', test: /access_tokens$/, handler: async () => ({ status: 403, body: { message: 'secondary rate limiting is in effect' } }) },
    ]);
    await expect(gerund.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/rate limiting/u);
  });

  it('labels a rate-limited review POST as rate limiting — a definitive refusal with no retry', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({
          status: 403,
          body: {
            message: 'You have exceeded a secondary rate limit.',
            documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#secondary-rate-limits',
          },
        }),
      },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/rate limiting/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('sanitizes provider error bodies so tokens never leak into diagnostics', async () => {
    const fixture = bundleFixture();
    const { poster } = posterWith(fixture, [
      {
        method: 'GET', test: /\/repos\/acme\/widget\/pulls\/7$/,
        handler: async () => ({ status: 403, body: { message: `Resource not accessible by integration. token=${TOKEN}` } }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(PerkinsAppHttpError);
    expect(error?.message ?? '').not.toContain(TOKEN);
    expect(error?.message ?? '').toContain('[REDACTED]');
  });

  it('redacts PEM private-key blocks in provider diagnostics', async () => {
    const fixture = bundleFixture();
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7Z\n-----END RSA PRIVATE KEY-----';
    const { poster } = posterWith(fixture, [
      {
        method: 'GET', test: /\/repos\/acme\/widget\/pulls\/7$/,
        handler: async () => ({ status: 403, body: { message: `refused: ${pem}` } }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toContain('[REDACTED]');
    expect(error?.message ?? '').not.toContain('PRIVATE KEY');
  });

  it('retains no raw provider bytes on the HTTP error object — only sanitized classification state', async () => {
    const fixture = bundleFixture();
    const secret = `ghs_${'L'.repeat(36)}`;
    const { poster } = posterWith(fixture, [
      {
        method: 'GET', test: /\/app$/,
        handler: async () => ({ status: 500, body: { message: 'server error', leaked: secret } }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })
      .then(() => null, (cause: unknown) => cause as PerkinsAppHttpError);
    expect(error).toBeInstanceOf(PerkinsAppHttpError);
    // Structured state carries no raw provider body: a future log or
    // snapshot of the error must not be able to echo credential-shaped
    // provider bytes the classification never needed.
    expect((error as unknown as { body?: unknown }).body).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as PerkinsAppHttpError).providerMessage).toBe('server error');
  });

  it('refuses GitHub hosts the router accepts but the App does not — www.github.com and *.github', async () => {
    const fixture = bundleFixture(DEFAULT_CONFIG, 'https://ghe.corp.github/acme/widget.git');
    const { poster, calls } = posterWith(fixture);
    await expect(poster.post({
      ...PR_INPUT, repoPath: repoPathOf(fixture),
      prUrl: 'https://ghe.corp.github/acme/widget/pull/7', host: 'ghe.corp.github',
    })).rejects.toThrow(/not github\.com/u);
    await expect(poster.post({
      ...PR_INPUT, repoPath: repoPathOf(fixture),
      prUrl: 'https://www.github.com/acme/widget/pull/7', host: 'www.github.com',
    })).rejects.toThrow(/not github\.com/u);
    expect(calls).toHaveLength(0);

    // And through the startup router: isGitHubRemote routes *.github hosts
    // and github.com subdomains to the github leg; the App poster still
    // refuses before any credential leaves the process.
    const api = makeApiDouble();
    const auto = createStartupVerdictPoster({ instanceDir: fixture.home }, { fetchImpl: api.fetchImpl, now: () => NOW });
    await expect(auto.post({
      ...PR_INPUT, repoPath: repoPathOf(fixture),
      prUrl: 'https://ghe.corp.github/acme/widget/pull/7', host: 'ghe.corp.github',
    })).rejects.toThrow(/not github\.com/u);
    await expect(auto.post({
      ...PR_INPUT, repoPath: repoPathOf(fixture),
      prUrl: 'https://www.github.com/acme/widget/pull/7', host: 'www.github.com',
    })).rejects.toThrow(/not github\.com/u);
    expect(api.calls).toHaveLength(0);
  });

  it('refuses non-github.com hosts instead of borrowing the App key', async () => {
    const fixture = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n', 'https://ghe.corp.example/acme/widget.git');
    const { poster, calls } = posterWith(fixture);
    await expect(poster.post({
      ...PR_INPUT, repoPath: repoPathOf(fixture),
      prUrl: 'https://ghe.corp.example/acme/widget/pull/7', host: 'ghe.corp.example',
    })).rejects.toThrow(/not github\.com/u);
    expect(calls).toHaveLength(0);
  });

  it('sanitizes credential-shaped bytes in the host-refusal diagnostic', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture);
    const secret = `ghs_${'H'.repeat(36)}`;
    const hostileHost = `evil.example\n${secret}`;
    const error = await poster.post({
      ...PR_INPUT, repoPath: repoPathOf(fixture), host: hostileHost,
      prUrl: `https://${hostileHost}/acme/widget/pull/7`,
    }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toContain('[REDACTED]');
    expect(error?.message ?? '').not.toContain(secret);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Post-POST identity proof
// ---------------------------------------------------------------------------

describe('post-publication identity proof', () => {
  it('routes an unprovable receipt through bounded reconciliation — foreign author with no proved match stays unproven', async () => {
    const fixture = bundleFixture();
    const foreign = { id: 1, user: { login: 'some-user', type: 'User' }, commit_id: HEAD, state: 'COMMENTED', body: 'review body\n' };
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 200, body: foreign }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [foreign] }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(PerkinsAppError);
    expect(error?.message ?? '').toMatch(/identity mismatch/u);
    expect(error?.message ?? '').toMatch(/provider review 1/u);
    expect(error?.message ?? '').toMatch(/NOT re-posted/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('credits a 2xx unprovable receipt only when the bounded lookup proves our bot published the bytes', async () => {
    const fixture = bundleFixture();
    const foreign = { id: 1, user: { login: 'some-user', type: 'User' }, commit_id: HEAD, state: 'COMMENTED', body: 'review body\n' };
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 200, body: foreign }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('keeps a commit-mismatch receipt unproven through the same bounded lookup', async () => {
    const fixture = bundleFixture();
    const wrongCommit = { id: 2, user: { login: 'perkins-review[bot]', type: 'Bot' }, commit_id: '9'.repeat(40), state: 'COMMENTED' };
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 200, body: wrongCommit }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [] }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/receipt mismatch/u);
    expect(error?.message ?? '').toMatch(/NOT re-posted/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Ambiguous-POST reconciliation
// ---------------------------------------------------------------------------

const MATCHING_REVIEW = {
  id: 987654,
  user: { login: 'perkins-review[bot]', type: 'Bot', id: 308038895 },
  commit_id: HEAD,
  state: 'COMMENTED',
  body: 'review body\n',
  submitted_at: new Date(NOW + 60_000).toISOString(),
};

const BODY_SHA = createHash('sha256').update('review body\n', 'utf8').digest('hex');
/** The PostedReviewReceipt a successful delivery of PR_INPUT resolves to. */
const RECEIPT = {
  headSha: HEAD,
  baseSha: BASE,
  reviewId: '987654',
  actor: 'perkins-review[bot]',
  event: 'COMMENTED',
  commitId: HEAD,
  bodySha256: BODY_SHA,
} as const;

describe('bounded ambiguous-POST reconciliation', () => {
  it('credits a provider-proved matching App review without a second POST', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(1);
  });

  it('never credits a foreign author with the same bytes on the same head', async () => {
    const fixture = bundleFixture();
    const foreignAuthor = { ...MATCHING_REVIEW, user: { login: 'some-user', type: 'User' } };
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [foreignAuthor] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/NOT re-posted/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('never certifies absence when the only predicate-complete review has an unusable provider id', async () => {
    const fixture = bundleFixture();
    const unusableIdReview = { ...MATCHING_REVIEW, id: 0 };
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [unusableIdReview] }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    // A review that matches every delivery predicate except its id is not
    // "did not land": the POST may well have published it.
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);

    // The recovery seam must not read the same walk as provable absence
    // either — a null there re-authorizes publication against this head.
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
  });

  it('treats lookup exhaustion and lookup errors as unproven, never as absence', async () => {
    const fixture = bundleFixture();
    const emptyList = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [] }) },
    ]);
    await expect(emptyList.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/did not land/u);
    expect(emptyList.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);

    const lookupError = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => { throw new Error('connection reset'); } },
    ]);
    await expect(lookupError.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unproven; the review was NOT re-posted/u);
    expect(lookupError.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('reconciles a 5xx POST outcome the same bounded way', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 502, body: { message: 'Bad Gateway' } }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('pages the bounded lookup: a full first page continues to page two and credits a page-two match', async () => {
    const fixture = bundleFixture();
    const foreignPage = Array.from({ length: 100 }, (_, index) => ({
      id: 1000 + index,
      user: { login: 'some-user', type: 'User' },
      commit_id: HEAD,
      state: 'COMMENTED',
      body: 'review body\n',
    }));
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2') ? { status: 200, body: [MATCHING_REVIEW] } : { status: 200, body: foreignPage }),
      },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
  });

  it('stops at the bounded window: two full pages with no match stay unproven with no third request', async () => {
    const fixture = bundleFixture();
    const foreignPage = Array.from({ length: 100 }, (_, index) => ({
      id: 2000 + index,
      user: { login: 'other-user', type: 'User' },
      commit_id: HEAD,
      state: 'COMMENTED',
      body: 'review body\n',
    }));
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: foreignPage }) },
    ], { maxReconciliationPages: 2 });
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unproven/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('honors maxReconciliationPages: a window of one never requests page two', async () => {
    const fixture = bundleFixture();
    const foreignPage = Array.from({ length: 100 }, (_, index) => ({
      id: 3000 + index,
      user: { login: 'other-user', type: 'User' },
      commit_id: HEAD,
      state: 'COMMENTED',
      body: 'review body\n',
    }));
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2') ? { status: 200, body: [MATCHING_REVIEW] } : { status: 200, body: foreignPage }),
      },
    ], { maxReconciliationPages: 1 });
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unproven/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(1);
  });

  it('walks backward from the Link header last page — the newest review is found on a busy PR', async () => {
    const fixture = bundleFixture();
    const foreignPage = Array.from({ length: 100 }, (_, index) => ({
      id: 4000 + index,
      user: { login: 'other-user', type: 'User' },
      commit_id: HEAD,
      state: 'COMMENTED',
      body: 'review body\n',
    }));
    const link = (pages: ReadonlyArray<[number, string]>): Record<string, string> => ({
      link: pages.map(([page, rel]) => `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${page}>; rel="${rel}"`).join(', '),
    });
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => {
          if (call.url.includes('page=3')) {
            return { status: 200, body: [MATCHING_REVIEW], headers: link([[2, 'prev'], [1, 'first']]) };
          }
          // Page 1: full page, Link announces page 3 as last — served as a
          // real Headers instance exactly like production fetch does.
          return {
            status: 200,
            body: foreignPage,
            headers: new Headers({
              link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="next", <https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=3>; rel="last"',
            }),
          };
        },
      },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    const pages = calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?')).map((call) => /[?&]page=(\d+)/u.exec(call.url)?.[1]);
    expect(pages).toEqual(['1', '3']);
  });

  it('keeps walking backward past the newest page when the match is older than the latest review', async () => {
    const fixture = bundleFixture();
    const foreignPage = Array.from({ length: 100 }, (_, index) => ({
      id: 5000 + index,
      user: { login: 'other-user', type: 'User' },
      commit_id: HEAD,
      state: 'COMMENTED',
      body: 'review body\n',
      submitted_at: new Date(NOW + 60_000).toISOString(),
    }));
    const link = (pages: ReadonlyArray<[number, string]>): Record<string, string> => ({
      link: pages.map(([page, rel]) => `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${page}>; rel="${rel}"`).join(', '),
    });
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => {
          if (call.url.includes('page=3')) return { status: 200, body: foreignPage, headers: link([[2, 'prev'], [1, 'first']]) };
          if (call.url.includes('page=2')) return { status: 200, body: [MATCHING_REVIEW], headers: link([[1, 'prev'], [3, 'next']]) };
          return { status: 200, body: foreignPage, headers: link([[2, 'next'], [3, 'last']]) };
        },
      },
    ], { maxReconciliationPages: 3 });
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    const pages = calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?')).map((call) => /[?&]page=(\d+)/u.exec(call.url)?.[1]);
    expect(pages).toEqual(['1', '3', '2']);
  });

  it('reports a malformed list body as a failed lookup, never as searched-and-not-found', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: { message: 'not a list' } }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/malformed list body/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('treats a list with a null entry as a malformed body — named and unresolved, never a raw crash', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW, null] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/malformed list body/u);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/malformed list body/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('treats array-valued and record-less entries as a malformed body on an ambiguous POST — unproven, never did-not-land, no second POST', async () => {
    for (const body of [[[]], [{}], [{ user: { login: 'perkins-review[bot]', type: 'Bot' } }]]) {
      const fixture = bundleFixture();
      const { poster, calls } = posterWith(fixture, [
        { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
        { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body }) },
      ]);
      const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
      // A broken entry can never certify that the POST did not land; the
      // outcome stays explicitly unproven and no second POST is made.
      expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
      expect(error?.message ?? '').not.toMatch(/did not land/u);
      expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    }
  });

  it('treats malformed nested author fields as a malformed body — unproven on an ambiguous POST, unresolved on reconcile, no second POST', async () => {
    // A numeric-id review that is otherwise exact on commit/state/body but
    // carries a malformed nested author (`login`/`type` not provider-typed
    // strings) is undecidable author evidence: it may be this round's
    // publication with mangled fields, so its non-match proves nothing.
    for (const user of [{ login: [], type: 'Bot' }, { login: 'perkins-review[bot]', type: ['Bot'] }]) {
      const fixture = bundleFixture();
      const malformedAuthor = { ...MATCHING_REVIEW, id: 889977, user };
      const { poster, calls } = posterWith(fixture, [
        { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
        { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [malformedAuthor] }) },
      ]);
      const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
      expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
      expect(error?.message ?? '').toMatch(/malformed list body/u);
      expect(error?.message ?? '').not.toMatch(/did not land/u);
      await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
        .rejects.toThrow(/malformed list body/u);
      expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    }
  });

  it('never credits an older round\u2019s identical bytes: stale submitted_at is not a match', async () => {
    const fixture = bundleFixture();
    const stale = { ...MATCHING_REVIEW, id: 111222, submitted_at: new Date(NOW - 3_600_000).toISOString() };
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [stale] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/NOT re-posted/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('a post-failure reconciliation fails closed: no second lookup, no credit, never absence', async () => {
    // The approved live-context semantics (j-642): post() owns the one
    // bounded strict-window reconciliation; the explicit post-failure
    // context must prevent ANY second provider read — the stale identical
    // review below would be credited by ordinary recovery.
    const fixture = bundleFixture();
    const stale = { ...MATCHING_REVIEW, id: 444555, submitted_at: new Date(NOW - 3_600_000).toISOString() };
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [stale] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/NOT re-posted/u);
    const callsBeforeReconcile = calls.length;
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }, { reason: 'post-failure' }))
      .rejects.toThrow(/refused for a failed publication attempt/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    // Only the single strict-window lookup post() already performed: NO
    // additional provider request of ANY route (prepare's token/App/PR
    // calls included) — the refusal fires before prepare().
    expect(calls.length).toBe(callsBeforeReconcile);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(1);
  });

  it('a refused POST fails the post-failure lookup closed before any provider read', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 422, body: { message: 'Validation Failed' } }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(PerkinsAppHttpError);
    const callsBeforeReconcile = calls.length;
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }, { reason: 'post-failure' }))
      .rejects.toThrow(/refused for a failed publication attempt/u);
    // Fail closed means fail closed: zero provider reads (a 4xx refusal
    // never reconciles internally either), and the error never implies a
    // POST landed or a first lookup happened.
    expect(calls.length).toBe(callsBeforeReconcile);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('an ambiguous live failure with only a time-unverifiable identical review still fails the post-failure lookup closed', async () => {
    const fixture = bundleFixture();
    const noTime = {
      id: 222333,
      user: { login: 'perkins-review[bot]', type: 'Bot', id: 308038895 },
      commit_id: HEAD,
      state: 'COMMENTED',
      body: 'review body\n',
    };
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [noTime] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unproven/u);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }, { reason: 'post-failure' }))
      .rejects.toThrow(/refused for a failed publication attempt/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(1);
    // Ordinary (unannotated) recovery keeps its distinct prior semantics
    // for the same bytes — pinned by the recovery suite; the live context
    // is what refuses the second lookup, never a state change.
  });

  it('a concurrent successful attempt between a held publication and its live second lookup cannot upgrade it (real deferred interleaving)', async () => {
    // Genuine interleaving with an explicit event trace: A's publication
    // POST is HELD in-flight, B publishes successfully through the SAME
    // poster (same head/body inputs, different PR), THEN A is released to
    // fail and its live second lookup must still refuse with zero
    // additional provider requests of any route. No sleeps; the ordering
    // is proven by the trace, never by silence.
    const fixture = bundleFixture();
    let releaseA!: () => void;
    const aPostGate = new Promise<void>((resolve) => { releaseA = resolve; });
    let aEntered!: () => void;
    const aEnteredGate = new Promise<void>((resolve) => { aEntered = resolve; });
    const trace: string[] = [];
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/repos\/acme\/widget\/pulls\/8$/,
        handler: async () => ({ status: 200, body: { number: 8, head: { sha: HEAD }, base: { sha: BASE } } }),
      },
      {
        method: 'POST', test: /\/repos\/acme\/widget\/pulls\/8\/reviews$/,
        handler: async () => ({ status: 200, body: { ...MATCHING_REVIEW } }),
      },
      {
        method: 'POST', test: /\/repos\/acme\/widget\/pulls\/7\/reviews$/,
        handler: async () => {
          trace.push('A:post-held');
          aEntered();
          await aPostGate;
          trace.push('A:post-failed');
          throw new Error('socket hang up after send');
        },
      },
      {
        method: 'GET', test: /\/repos\/acme\/widget\/pulls\/7\/reviews\?/,
        handler: async () => {
          trace.push('A:strict-window-lookup');
          return { status: 200, body: [{ ...MATCHING_REVIEW, id: 777888, submitted_at: new Date(NOW - 3_600_000).toISOString() }] };
        },
      },
    ]);
    const pr8: VerdictPosterInput = { ...PR_INPUT, prUrl: 'https://github.com/acme/widget/pull/8', repoPath: repoPathOf(fixture) };
    // A starts first and blocks inside its publication POST; the explicit
    // entered gate proves the positive order — A is held BEFORE B starts.
    // No sleeps and no arbitrary drain; a failed assertion before the
    // release must not leave the held POST as an unhandled rejection, and
    // the finally below always releases it.
    const attemptA = poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) });
    attemptA.catch(() => undefined);
    await aEnteredGate;
    expect(trace).toEqual(['A:post-held']);
    try {
      // B completes through the same poster while A is held; the trace
      // entry is recorded only AFTER B actually completed.
      await expect(poster.post(pr8)).resolves.toEqual(RECEIPT);
      trace.push('B:post-complete');
      // A is released and fails ambiguously...
      releaseA();
      await expect(attemptA).rejects.toThrow(/NOT re-posted/u);
    } finally {
      releaseA();
    }
    // ...and A's live second lookup still refuses with NO provider access
    // of any route (prepare's token/App/PR-identity calls included).
    const callsBeforeReconcile = calls.length;
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }, { reason: 'post-failure' }))
      .rejects.toThrow(/refused for a failed publication attempt/u);
    expect(calls.length).toBe(callsBeforeReconcile);
    // The trace proves the real order: A was held, B completed, THEN A
    // failed and reconciled internally once.
    expect(trace).toEqual(['A:post-held', 'B:post-complete', 'A:post-failed', 'A:strict-window-lookup']);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/pulls/8/reviews'))).toHaveLength(1);
  });

  it('a successful publication AFTER a failed attempt cannot upgrade its live second lookup (real deferred ordering)', async () => {
    // The complementary ordering to the held-act test: A fails completely
    // FIRST — including its own bounded strict-window lookup — then B
    // publishes successfully through the SAME poster with the same
    // head/body inputs on a different PR, and only then does A's live
    // post-failure lookup run. The refusal must still hold with zero
    // additional provider access of any route.
    const fixture = bundleFixture();
    const trace: string[] = [];
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/repos\/acme\/widget\/pulls\/8$/,
        handler: async () => ({ status: 200, body: { number: 8, head: { sha: HEAD }, base: { sha: BASE } } }),
      },
      {
        method: 'POST', test: /\/repos\/acme\/widget\/pulls\/8\/reviews$/,
        handler: async () => ({ status: 200, body: { ...MATCHING_REVIEW } }),
      },
      {
        method: 'POST', test: /\/repos\/acme\/widget\/pulls\/7\/reviews$/,
        handler: async () => {
          trace.push('A:post-failed');
          throw new Error('socket hang up after send');
        },
      },
      {
        method: 'GET', test: /\/repos\/acme\/widget\/pulls\/7\/reviews\?/,
        handler: async () => {
          trace.push('A:strict-window-lookup');
          return { status: 200, body: [{ ...MATCHING_REVIEW, id: 777888, submitted_at: new Date(NOW - 3_600_000).toISOString() }] };
        },
      },
    ]);
    const pr8: VerdictPosterInput = { ...PR_INPUT, prUrl: 'https://github.com/acme/widget/pull/8', repoPath: repoPathOf(fixture) };
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).rejects.toThrow(/NOT re-posted/u);
    expect(trace).toEqual(['A:post-failed', 'A:strict-window-lookup']);
    // B publishes successfully through the same poster afterwards, with
    // the same frozen head and body on a different PR.
    await expect(poster.post(pr8)).resolves.toEqual(RECEIPT);
    trace.push('B:post-complete');
    // A's live second lookup still refuses with no additional provider
    // access of any route (prepare's token/App/PR-identity calls included).
    const callsBeforeReconcile = calls.length;
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }, { reason: 'post-failure' }))
      .rejects.toThrow(/refused for a failed publication attempt/u);
    expect(calls.length).toBe(callsBeforeReconcile);
    expect(trace).toEqual(['A:post-failed', 'A:strict-window-lookup', 'B:post-complete']);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/pulls/7/reviews'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/pulls/8/reviews'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/pulls/7/reviews?'))).toHaveLength(1);
  });

  it('a publication that failed BEFORE sending fails the live second lookup closed with no publication POST at all', async () => {
    // The failure seam passes the post-failure context for ANY post error,
    // including failures before the wire: the refusal stays honest — no
    // publication POST occurred, no review lookup ever runs, nothing is
    // upgraded or certified absent.
    const fixture = bundleFixture();
    const movedHead = 'f'.repeat(40);
    const { poster, calls } = posterWith(fixture, [
      { method: 'GET', test: /\/repos\/acme\/widget\/pulls\/7$/, handler: async () => ({ status: 200, body: { number: 7, head: { sha: movedHead }, base: { sha: BASE } } }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/pull request identity moved before delivery/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
    const callsBeforeReconcile = calls.length;
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }, { reason: 'post-failure' }))
      .rejects.toThrow(/refused for a failed publication attempt/u);
    expect(calls.length).toBe(callsBeforeReconcile);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(0);
  });

  it('missing-mapping diagnostics sanitize credential-shaped configured owners', async () => {
    // A VALID bundle whose only owner key is credential-shaped: the
    // missing-mapping error lists the configured owners — the raw key
    // bytes must never appear, and the check fires before any provider
    // call.
    const fixture = bundleFixture(`app_id=424242\nkey_path="$BUNDLE_DIR/app-key.pem"\ninstallation_id_ghs_${'D'.repeat(36)}=164552969\n`);
    const { poster, calls } = posterWith(fixture, []);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/no installation_id mapping for repository owner "acme"/u);
    expect(error?.message ?? '').toMatch(/configured owners:/u);
    expect(error?.message ?? '').not.toContain('ghs_');
    expect(error?.message ?? '').not.toContain('D'.repeat(36));
    expect(calls).toHaveLength(0);
  });

  it('keeps a predicate-complete review with an unverifiable submission time out of absence certificates, while the recovery seam may still credit it', async () => {
    const fixture = bundleFixture();
    const noTime = {
      id: 222333,
      user: { login: 'perkins-review[bot]', type: 'Bot', id: 308038895 },
      commit_id: HEAD,
      state: 'COMMENTED',
      body: 'review body\n',
    };
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [noTime] }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    // The recovery seam reads the same walk without a round window: the
    // identical publication is credit-able there (its bytes and head are
    // proven; only the in-round window was unprovable).
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual({ ...RECEIPT, reviewId: '222333' });
  });

  it('pins the recency margin edge: a submission exactly at postStart-60s is credited, one millisecond older is not', async () => {
    const fixture = bundleFixture();
    const atBoundary = { ...MATCHING_REVIEW, id: 333444, submitted_at: new Date(NOW - 60_000).toISOString() };
    const justOutside = { ...MATCHING_REVIEW, id: 333555, submitted_at: new Date(NOW - 60_001).toISOString() };
    const boundary = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [atBoundary] }) },
    ]);
    await expect(boundary.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual({ ...RECEIPT, reviewId: '333444' });

    const outside = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [justOutside] }) },
    ]);
    const error = await outside.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/did not land/u);
  });

  it('treats a 2xx receipt with an empty body as an unprovable receipt and reconciles', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 200, rawText: '' }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [] }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/id is not usable/u);
    expect(error?.message ?? '').toMatch(/NOT re-posted/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('treats a 3xx interception as ambiguous — bounded lookup only, never a second POST', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 302, rawText: '' }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/NOT re-posted/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    for (const call of calls) {
      expect(call.url.startsWith('https://api.github.com/')).toBe(true);
      expect(call.redirect).toBe('error');
    }
  });

  it('treats a 2xx with a non-JSON body as ambiguous and credits only a proved match', async () => {
    const fixture = bundleFixture();
    const credited = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 200, rawText: '<html>gateway replaced the response</html>' }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(credited.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);

    const unproven = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 200, rawText: '<html>gateway replaced the response</html>' }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [] }) },
    ]);
    await expect(unproven.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/NOT re-posted/u);
    expect(unproven.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('surfaces a definitive 4xx POST refusal directly — no reconciliation, no retry', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 422, body: { message: 'Validation Failed' } }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/422/u);
    // No lookup after a definitive refusal: the provider proved no review exists.
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('classifies a non-JSON 4xx POST body by its status, not by parse failure', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 403, rawText: '<html>proxy refused the request</html>' }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(PerkinsAppHttpError);
    expect((error as PerkinsAppHttpError).status).toBe(403);
    // A definitive refusal: still no reconciliation lookup, no retry.
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Provider receipt discipline (PostedReviewReceipt contract)
// ---------------------------------------------------------------------------

describe('provider receipt discipline', () => {
  it('rejects a 2xx whose enacted state is not COMMENTED, through bounded reconciliation', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({ status: 200, body: { id: 5, user: { login: 'perkins-review[bot]', type: 'Bot' }, state: 'APPROVED', commit_id: HEAD, body: 'review body\n' } }),
      },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [] }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/state mismatch/u);
    expect(error?.message ?? '').toMatch(/NOT re-posted/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('rejects a 2xx whose echoed body digest differs, through bounded reconciliation', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({ status: 200, body: { id: 6, user: { login: 'perkins-review[bot]', type: 'Bot' }, state: 'COMMENTED', commit_id: HEAD, body: 'tampered body\n' } }),
      },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [] }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/body mismatch/u);
    // The empty review list proves the POST did not land; either way the
    // review was never re-posted.
    expect(error?.message ?? '').toMatch(/NOT re-posted/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotent recovery reconciliation (the VerdictPoster.reconcile seam)
// ---------------------------------------------------------------------------

describe('idempotent recovery reconciliation', () => {
  it('returns the provider-proved receipt for an existing matching App review, without any POST', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('returns null only when the bounded walk provably covered the whole review list', async () => {
    const fixture = bundleFixture();
    const foreignPage = Array.from({ length: 100 }, (_, index) => ({
      id: 6000 + index,
      user: { login: 'other-user', type: 'User' },
      commit_id: HEAD,
      state: 'COMMENTED',
      body: 'review body\n',
    }));
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => {
          const page = Number(/[?&]page=(\d+)/u.exec(call.url)?.[1] ?? '1');
          const links = [`<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${Math.min(page + 1, 3)}>; rel="next"`];
          if (page > 1) links.push(`<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${page - 1}>; rel="prev"`);
          links.push('<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=3>; rel="last"');
          return { status: 200, body: foreignPage, headers: { link: links.join(', ') } };
        },
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toBeNull();
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(3);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('throws unresolved when the bounded window cannot cover the review list', async () => {
    const fixture = bundleFixture();
    const foreignPage = Array.from({ length: 100 }, (_, index) => ({
      id: 7000 + index,
      user: { login: 'other-user', type: 'User' },
      commit_id: HEAD,
      state: 'COMMENTED',
      body: 'review body\n',
    }));
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => {
          const page = Number(/[?&]page=(\d+)/u.exec(call.url)?.[1] ?? '1');
          const links = [`<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${Math.min(page + 1, 5)}>; rel="next"`];
          if (page > 1) links.push(`<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${page - 1}>; rel="prev"`);
          links.push('<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=5>; rel="last"');
          return { status: 200, body: foreignPage, headers: { link: links.join(', ') } };
        },
      },
    ], { maxReconciliationPages: 3 });
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(3);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('refuses non-github.com hosts in reconcile exactly like post', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture);
    await expect(poster.reconcile?.({
      ...PR_INPUT, repoPath: repoPathOf(fixture),
      prUrl: 'https://ghe.corp.example/acme/widget/pull/7', host: 'ghe.corp.example',
    })).rejects.toThrow(/not github\.com/u);
    expect(calls).toHaveLength(0);
  });

  it('keeps standalone reconciliation unresolved when a review entry is not a decidable record', async () => {
    for (const body of [[[]], [{}]]) {
      const fixture = bundleFixture();
      const { poster, calls } = posterWith(fixture, [
        { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body }) },
      ]);
      // A malformed entry is never read as provable absence: a null return
      // here would re-authorize publication against this very head.
      await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
        .rejects.toThrow(/malformed list body/u);
      expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
      expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Configured App mode never falls back to personal gh credentials
// ---------------------------------------------------------------------------

describe('no personal-credential fallback in configured App mode', () => {
  it('propagates App failures instead of switching identities, and keeps a GitLab-style path untouched', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /access_tokens$/, handler: async () => ({ status: 403, body: { message: 'Forbidden' } }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(PerkinsAppError);
    // The configured-mode failure is the App's, surfaced for the operator;
    // a configured App bundle cannot select the personal gh poster, and the
    // App poster class itself has no gh execution path.
    expect(createGithubVerdictPoster(fixture.home)).toBeInstanceOf(PerkinsAppPrPoster);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Integration review closures (2026-09-30 independent review findings)
// ---------------------------------------------------------------------------

describe('credential hygiene on rejected URLs', () => {
  it('sanitizes credential-shaped bytes in malformed and host-rejected PR URLs', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture);
    const secret = `ghs_${'S'.repeat(40)}`;
    const malformed = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture), prUrl: `not-a-url tokenX${secret}` })
      .then(() => null, (cause: unknown) => cause as Error);
    expect(malformed).toBeInstanceOf(PerkinsAppError);
    expect(malformed?.message ?? '').not.toContain(secret);
    expect(malformed?.message ?? '').toContain('[REDACTED]');

    // Other credential shapes are redacted in URL errors too, including a
    // token embedded directly after a word character (no separator).
    const pat = `github_pat_${'P'.repeat(30)}`;
    const patError = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture), prUrl: `not-a-url${pat}` })
      .then(() => null, (cause: unknown) => cause as Error);
    expect(patError).toBeInstanceOf(PerkinsAppError);
    expect(patError?.message ?? '').not.toContain(pat);
    expect(patError?.message ?? '').toContain('[REDACTED]');
    const jwt = `eyJ${'A'.repeat(12)}.${'B'.repeat(12)}.${'C'.repeat(12)}`;
    const jwtError = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture), prUrl: `not-a-url${jwt}` })
      .then(() => null, (cause: unknown) => cause as Error);
    expect(jwtError).toBeInstanceOf(PerkinsAppError);
    expect(jwtError?.message ?? '').not.toContain(jwt);
    expect(jwtError?.message ?? '').toContain('[REDACTED]');

    // The unanchored token patterns must not widen to ordinary prose: a
    // benign snake_case word with no token prefix survives as-is.
    const benign = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture), prUrl: 'not-a-url weight_groups_used_by_x' })
      .then(() => null, (cause: unknown) => cause as Error);
    expect(benign?.message ?? '').toContain('weight_groups_used_by_x');

    const userinfo = await poster.post({
      ...PR_INPUT, repoPath: repoPathOf(fixture),
      prUrl: `https://user:${secret}@github.com/acme/widget/pull/7`,
    }).then(() => null, (cause: unknown) => cause as Error);
    expect(userinfo).toBeInstanceOf(PerkinsAppError);
    expect(userinfo?.message ?? '').not.toContain(secret);
    expect(calls).toHaveLength(0);
  });

  it('redacts PKCS#8 and unterminated private-key blocks from diagnostics and serialized errors', async () => {
    const fixture = bundleFixture();
    const blocks = [
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
      `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA${'A'.repeat(40)}`,
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIBozAcBgkqhkiG9w0BBwGg\n-----END ENCRYPTED PRIVATE KEY-----',
    ];
    for (const block of blocks) {
      const { poster } = posterWith(fixture, [
        {
          method: 'GET', test: /\/repos\/acme\/widget\/pulls\/7$/,
          handler: async () => ({ status: 403, body: { message: `refused. ${block}` } }),
        },
      ]);
      const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
      expect(error).toBeInstanceOf(PerkinsAppHttpError);
      expect(error?.message ?? '').not.toContain('MIIE');
      expect(error?.message ?? '').toContain('[REDACTED]');
      expect(JSON.stringify(error)).not.toContain('MIIE');
    }
  });
});

describe('review id discipline', () => {
  it('accepts a provider-quoted string id as the receipt identity', async () => {
    const fixture = bundleFixture();
    const { poster } = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({ status: 200, body: { id: '987654', user: { login: 'perkins-review[bot]', type: 'Bot' }, state: 'COMMENTED', commit_id: HEAD, body: 'review body\n' } }),
      },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual(RECEIPT);
  });

  it('routes a 2xx with an unusable review id into bounded reconciliation instead of a raw failure', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({ status: 200, body: { user: { login: 'perkins-review[bot]', type: 'Bot' }, state: 'COMMENTED', commit_id: HEAD, body: 'review body\n' } }),
      },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);

    // Zero and negative are not usable provider ids either: the 2xx is
    // reconciled like any other unprovable receipt, so the receipt's id
    // comes from the provider list, never from the numeric bound check.
    for (const badId of [0, -1]) {
      const badNumeric = posterWith(fixture, [
        {
          method: 'POST', test: /\/reviews$/,
          handler: async () => ({ status: 200, body: { id: badId, user: { login: 'perkins-review[bot]', type: 'Bot' }, state: 'COMMENTED', commit_id: HEAD, body: 'review body\n' } }),
        },
        { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
      ]);
      await expect(badNumeric.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual(RECEIPT);
    }

    // String parity with the legacy receipts: a provider-quoted '0' stays usable.
    const stringZero = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({ status: 200, body: { id: '0', user: { login: 'perkins-review[bot]', type: 'Bot' }, state: 'COMMENTED', commit_id: HEAD, body: 'review body\n' } }),
      },
    ]);
    await expect(stringZero.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toMatchObject({ reviewId: '0' });

    // A provider-quoted id outside the shared receipt charset is unusable
    // too: the poster must not certify a receipt the ledger would later
    // reject as malformed.
    const spacedId = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({ status: 200, body: { id: 'perkins review 42', user: { login: 'perkins-review[bot]', type: 'Bot' }, state: 'COMMENTED', commit_id: HEAD, body: 'review body\n' } }),
      },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(spacedId.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual(RECEIPT);
  });

  it('refuses an oversized provider reply instead of parsing it', async () => {
    const fixture = bundleFixture();
    const { poster } = posterWith(fixture, [
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, rawText: 'x'.repeat(2_049) }) },
    ], { maxProviderBodyBytes: 2_048 });
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/exceeded 2048 bytes/u);
  });

  it('applies the byte ceiling while streaming, stopping at the cap instead of buffering past it', async () => {
    const fixture = bundleFixture();
    const chunkCount = 100;
    let pulls = 0;
    let cancelled = false;
    const { poster } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async () => ({
          status: 200,
          stream: new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              if (pulls <= chunkCount) controller.enqueue(new Uint8Array(100).fill(65));
              else controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        }),
      },
    ], { maxProviderBodyBytes: 2_048 });
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/exceeded 2048 bytes/u);
    // The reader stopped at the cap and cancelled the source long before
    // the 100-chunk stream could be drained; a buffering implementation
    // would read every chunk (pulls === chunkCount) and never cancel.
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(23);
  });

  it('parses a streamed reply on the happy path (the production read shape)', async () => {
    const fixture = bundleFixture();
    const { poster } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async () => ({
          status: 200,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(JSON.stringify([MATCHING_REVIEW])));
              controller.close();
            },
          }),
        }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual(RECEIPT);
  });

  it('treats a mid-stream read failure on the delivery POST as ambiguous and reconciles, never re-posts', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({
          status: 200,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('connection reset mid-body'));
            },
          }),
        }),
      },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('keeps a 422 refusal definitive when its body stream fails — no lookup, no stale credit', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({
          status: 422,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error('refusal body stream reset'));
            },
          }),
        }),
      },
      // A matching historical review sits in the list and would be credited
      // by reconciliation: an unreadable refusal must never look ambiguous.
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(PerkinsAppHttpError);
    expect((error as PerkinsAppHttpError).status).toBe(422);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('never labels a non-window abuse refusal as rate limiting', async () => {
    const fixture = bundleFixture();
    const { poster } = posterWith(fixture, [
      {
        method: 'POST', test: /access_tokens$/,
        handler: async () => ({
          status: 403,
          body: {
            message: 'Your account has been flagged.',
            documentation_url: 'https://docs.github.com/en/site-policy/acceptable-use-policies/github-abuse',
          },
        }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').not.toMatch(/rate limiting/u);
    expect(error?.message ?? '').toMatch(/suspended or the App forbidden/u);

    // The same classifier guards the delivery-POST refusal branch: an abuse
    // suspension must not be relabeled as a rate-limit wait there either.
    const postPath = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({
          status: 403,
          body: {
            message: 'Your account has been flagged.',
            documentation_url: 'https://docs.github.com/en/site-policy/acceptable-use-policies/github-abuse',
          },
        }),
      },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    const postError = await postPath.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })
      .then(() => null, (cause: unknown) => cause as Error);
    expect(postError?.message ?? '').not.toMatch(/rate limiting/u);
    expect((postError as PerkinsAppHttpError).status).toBe(403);
    expect(postPath.calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(0);
  });

  it('keeps an oversized refusal classified by its status (never as an unknown outcome)', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 403, rawText: 'x'.repeat(2_049), headers: { 'x-ratelimit-remaining': '0' } }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ], { maxProviderBodyBytes: 2_048 });
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(PerkinsAppHttpError);
    expect((error as PerkinsAppHttpError).status).toBe(403);
    // A definitive refusal: no reconciliation lookup, no retry.
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(0);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);

    // The realistic hostile shape: the refusal body arrives as a stream.
    const streamed = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({
          status: 403,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(2_049).fill(120));
              controller.close();
            },
          }),
        }),
      },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ], { maxProviderBodyBytes: 2_048 });
    const streamedError = await streamed.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })
      .then(() => null, (cause: unknown) => cause as Error);
    expect(streamedError).toBeInstanceOf(PerkinsAppHttpError);
    expect((streamedError as PerkinsAppHttpError).status).toBe(403);
    expect(streamed.calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(0);

    // The retained overflow prefix is what preserves prefix-borne
    // classification evidence: a rate-limit marker in the first bytes of an
    // oversized refusal must still classify as rate limiting (dropping the
    // whole boundary chunk would erase it and mislabel the refusal).
    const prefixClassifier = posterWith(fixture, [
      {
        method: 'POST', test: /access_tokens$/,
        handler: async () => ({
          status: 403,
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`API rate limit exceeded. ${'x'.repeat(2_100)}`));
              controller.close();
            },
          }),
        }),
      },
    ], { maxProviderBodyBytes: 2_048 });
    await expect(prefixClassifier.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/rate limiting/u);
  });

  it('routes an oversized OK delivery reply into bounded reconciliation, never a blind retry', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 200, rawText: 'x'.repeat(2_049) }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ], { maxProviderBodyBytes: 2_048 });
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('rejects armed-style broken reply ceilings and lookup windows at construction', () => {
    const fixture = bundleFixture();
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, maxProviderBodyBytes: 0 })).toThrow(/maxProviderBodyBytes/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, maxProviderBodyBytes: -1 })).toThrow(/maxProviderBodyBytes/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, maxProviderBodyBytes: 1024.5 })).toThrow(/maxProviderBodyBytes/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, maxProviderBodyBytes: Number.NaN })).toThrow(/maxProviderBodyBytes/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, maxReconciliationPages: 0 })).toThrow(/maxReconciliationPages must be an integer >= 1/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, maxReconciliationPages: -1 })).toThrow(/maxReconciliationPages/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, maxReconciliationPages: 1.5 })).toThrow(/maxReconciliationPages/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, maxReconciliationPages: Number.NaN })).toThrow(/maxReconciliationPages/u);
    // A small but sane ceiling stays accepted (the tests themselves use one).
    expect(new PerkinsAppPrPoster({ instanceDir: fixture.home, maxProviderBodyBytes: 2_048 })).toBeInstanceOf(PerkinsAppPrPoster);
    expect(new PerkinsAppPrPoster({ instanceDir: fixture.home, maxReconciliationPages: 1 })).toBeInstanceOf(PerkinsAppPrPoster);
  });

  it('refuses broken timeout options at construction — a mis-wired timeout is never an ambiguous delivery', () => {
    const fixture = bundleFixture();
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, probeTimeoutMs: 0 })).toThrow(/probeTimeoutMs/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, probeTimeoutMs: -1 })).toThrow(/probeTimeoutMs/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, probeTimeoutMs: 1.5 })).toThrow(/probeTimeoutMs/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, probeTimeoutMs: Number.NaN })).toThrow(/probeTimeoutMs/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, postTimeoutMs: 0 })).toThrow(/postTimeoutMs/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, postTimeoutMs: -1 })).toThrow(/postTimeoutMs/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, postTimeoutMs: 1.5 })).toThrow(/postTimeoutMs/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: fixture.home, postTimeoutMs: Number.NaN })).toThrow(/postTimeoutMs/u);
    expect(new PerkinsAppPrPoster({ instanceDir: fixture.home, probeTimeoutMs: 1, postTimeoutMs: 1 })).toBeInstanceOf(PerkinsAppPrPoster);
  });
});

describe('bounded lookup growth and link sanity', () => {
  const fullPage = Array.from({ length: 100 }, (_, index) => ({
    id: 8000 + index,
    user: { login: 'other-user', type: 'User' },
    commit_id: HEAD,
    state: 'COMMENTED',
    body: 'review body\n',
  }));

  it('never certifies absence from a page=0 "last" link (a rewriting intermediary cannot mint coverage)', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async () => ({
          status: 200,
          body: fullPage,
          headers: { link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=0>; rel="last"' },
        }),
      },
    ], { maxReconciliationPages: 2 });
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    // The unusable Link header falls back to the sequential walk, still bounded.
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
  });

  it('never certifies absence from conflicting rel="last" entries — a self-disagreeing header keeps uncertainty', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async () => ({
          status: 200,
          body: [],
          headers: { link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=1>; rel="last", <https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=5>; rel="last"' },
        }),
      },
    ], { maxReconciliationPages: 2 });
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    // A conflicting page count must never become "the POST did not land".
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('keeps a valid earlier last-page bound from certifying absence when a later page contradicts it (explicit reconcile)', async () => {
    // Page 1 announces last=2; page 2's header then claims last=2 AND
    // last=5. Collapsing the contradiction to "no information" left the
    // earlier bound usable and {1,2} looked covered — absence certified
    // without reading pages 3-5. A contradictory header poisons the
    // certificate: the walk stays bounded and unresolved, and an
    // independently proved match would still be credited.
    const fixture = bundleFixture();
    const lastLink = (last: number): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? {
              status: 200,
              body: fullPage,
              headers: { link: [
                '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="last"',
                '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=5>; rel="last"',
              ].join(', ') },
            }
          : { status: 200, body: fullPage, headers: lastLink(2) }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('keeps a valid earlier last-page bound from proving a POST did not land when a later page contradicts it', async () => {
    const fixture = bundleFixture();
    const lastLink = (last: number): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? {
              status: 200,
              body: fullPage,
              headers: { link: [
                '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="last"',
                '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=5>; rel="last"',
              ].join(', ') },
            }
          : { status: 200, body: fullPage, headers: lastLink(2) }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('keeps a valid earlier last-page bound from certifying absence when a later page carries malformed last evidence (explicit reconcile)', async () => {
    // `page=2junk` is not a page number: its numeric prefix must not parse
    // as a valid bound that combines with the earlier last=2 into a false
    // completeness certificate over {1,2}.
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: lastLink('2junk') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('keeps a valid earlier last-page bound from proving a POST did not land when later last evidence is malformed', async () => {
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: lastLink('2junk') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('still credits an exact match found on a page whose pagination evidence is malformed', async () => {
    // Poisoned completeness evidence forbids absence certificates — it
    // never blocks positive, independently proved exact-match credit.
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: [MATCHING_REVIEW], headers: lastLink('2junk') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('keeps a valid earlier last-page bound from certifying absence when a later page carries duplicate page parameters (explicit reconcile)', async () => {
    // `page=2&page=5` inside ONE last URL is duplicate/conflicting
    // evidence: picking the first value would re-certify {1,2} as full
    // coverage without reading pages 3-5.
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: lastLink('2&page=5') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('keeps a valid earlier last-page bound from certifying absence when a later page mixes malformed and valid page parameters (explicit reconcile)', async () => {
    // `page=2junk&page=2`: first-match extraction silently skipped the
    // malformed prefix and accepted the later valid 2; the URL is
    // self-contradictory and must poison completeness instead.
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: lastLink('2junk&page=2') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('keeps duplicate page parameters from proving a POST did not land', async () => {
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: lastLink('2&page=5') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('still credits an exact match when a later page carries duplicate page parameters', async () => {
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: [MATCHING_REVIEW], headers: lastLink('2&page=5') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('keeps a valid earlier bound from certifying absence when a later last entry carries a bare duplicate page key', async () => {
    // `?page=2&page` has TWO page keys (the second with an empty value):
    // a raw `[?&]page=` match sees only the first and would re-certify
    // {1,2} as full coverage without reading pages 3+. Semantic query
    // parsing sees the duplicate and poisons completeness.
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: lastLink('2&page') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('keeps a valid earlier bound from certifying absence when a later last entry carries a decoded duplicate page key', async () => {
    // `?page=2&%70age=5` is a duplicate page key after percent-decoding:
    // the encoded key is invisible to a raw match, which would accept 2.
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: lastLink('2&%70age=5') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('keeps a valid earlier bound from certifying absence when a last entry carries its page only in the fragment', async () => {
    // The entry has NO query `page` parameter at all; the fragment's
    // `&page=2` must not be read as pagination evidence.
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: { link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100#x&page=2>; rel="last"' } }
          : { status: 200, body: fullPage, headers: { link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="last"' } }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('keeps a fragment-supplied page parameter from proving a POST did not land', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: { link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100#x&page=2>; rel="last"' } }
          : { status: 200, body: fullPage, headers: { link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="last"' } }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('keeps malformed-then-valid page parameters from proving a POST did not land', async () => {
    // The recovery-path mixed oracle exists; this is the POST-path twin.
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: lastLink('2junk&page=2') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('keeps a bare duplicate page key from proving a POST did not land', async () => {
    // `?page=2&page` POST-path twin of the recovery-path bare-duplicate
    // oracle: a raw `[?&]page=` match sees only the first value and would
    // prove absence from an incomplete window; semantic query parsing sees
    // the second, empty-valued page key and keeps the delivery unproven.
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: lastLink('2&page') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
  });

  it('keeps a decoded duplicate page key from proving a POST did not land', async () => {
    // `?page=2&%70age=5` POST-path twin: the encoded duplicate is
    // invisible to a raw match but is a second page key after decoding.
    const fixture = bundleFixture();
    const lastLink = (last: string): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: fullPage, headers: lastLink('2&%70age=5') }
          : { status: 200, body: fullPage, headers: lastLink('2') }),
      },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
  });

  it('still credits an exact match when a later last entry carries its page only in the fragment', async () => {
    // Positive control for the semantic parser: poisoned pagination
    // evidence never suppresses a genuinely proved receipt.
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
          ? { status: 200, body: [MATCHING_REVIEW], headers: { link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100#x&page=2>; rel="last"' } }
          : { status: 200, body: fullPage, headers: { link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="last"' } }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual(RECEIPT);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('does not certify absence when the review list grows mid-walk beyond the visited pages', async () => {
    const fixture = bundleFixture();
    const lastLink = (last: number): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
            ? { status: 200, body: fullPage, headers: lastLink(3) }
            : { status: 200, body: fullPage, headers: lastLink(2) }),
      },
    ], { maxReconciliationPages: 2 });
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
  });

  it('never certifies absence from an inconsistent shrinking last-page snapshot', async () => {
    // The maximum any response reported governs coverage: page 1 announces
    // five pages, then page 5 claims two. Written assignment would shrink
    // the tracked bound and certify {1,5,4} as full coverage; the maximum
    // keeps the walk honestly unresolved instead of minting a duplicate-
    // review permission.
    const fixture = bundleFixture();
    const lastLink = (last: number): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (/[?&]page=1$/u.test(call.url)
            ? { status: 200, body: fullPage, headers: lastLink(5) }
            : { status: 200, body: fullPage, headers: lastLink(2) }),
      },
    ], { maxReconciliationPages: 3 });
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    const pages = calls
      .filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))
      .map((call) => /[?&]page=(\d+)/u.exec(call.url)?.[1]);
    expect(pages).toEqual(['1', '5', '4']);
  });

  it('finds a recovered review deeper than the old three-page window (shared ten-page parity)', async () => {
    const fixture = bundleFixture();
    const lastLink = (last: number): Record<string, string> => ({
      link: `<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=${last}>; rel="last"`,
    });
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (call.url.includes('page=2')
            ? { status: 200, body: [MATCHING_REVIEW], headers: lastLink(5) }
            : { status: 200, body: fullPage, headers: lastLink(5) }),
      },
    ]);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual(RECEIPT);
    const pages = calls
      .filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))
      .map((call) => /[?&]page=(\d+)/u.exec(call.url)?.[1]);
    expect(pages).toEqual(['1', '5', '4', '3', '2']);
  });

  it('never certifies absence from a short page when a Link header is present without rel="last"', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async () => ({
          status: 200,
          body: [],
          headers: { link: '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="next"' },
        }),
      },
    ], { maxReconciliationPages: 2 });
    // A rewriting intermediary's header must not turn a short page into an
    // end-of-list signal: the walk stays bounded and unresolved, never an
    // absence certificate that would re-authorize publication.
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    expect(calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))).toHaveLength(2);
  });

  it('parses rel="last" independent of parameter order — a reordered later bound cannot mint a false absence', async () => {
    const fixture = bundleFixture();
    const page1Link = '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="last"';
    const reorderedLast = '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=5>; title="tail"; rel="last"';
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (/[?&]page=1$/u.test(call.url)
            ? { status: 200, body: fullPage, headers: { link: page1Link } }
            : { status: 200, body: fullPage, headers: { link: reorderedLast } }),
      },
    ], { maxReconciliationPages: 3 });
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/delivery stays unproven/u);
    expect(error?.message ?? '').not.toMatch(/did not land/u);
    // The reordered page-5 bound was read and the POST walk extended toward
    // it (pages 1 and 2 were already visited; page 5 is the new jump target).
    const postWalkPages = calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))
      .map((call) => /[?&]page=(\d+)/u.exec(call.url)?.[1]);
    expect(postWalkPages).toEqual(['1', '2', '5']);
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unresolved/u);
    // The standalone reconcile walks the same list again (the shared call
    // log now holds both walks); each walk reached the reordered bound.
    const allWalkPages = calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))
      .map((call) => /[?&]page=(\d+)/u.exec(call.url)?.[1]);
    expect(allWalkPages).toEqual(['1', '2', '5', '1', '2', '5']);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('still credits a proved match on a page whose reordered rel="last" bound extended the walk', async () => {
    const fixture = bundleFixture();
    const page1Link = '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=2>; rel="last"';
    const reorderedLast = '<https://api.github.com/repos/acme/widget/pulls/7/reviews?per_page=100&page=5>; title="tail"; rel="last"';
    const { poster, calls } = posterWith(fixture, [
      {
        method: 'GET', test: /\/reviews\?/,
        handler: async (call) => (/[?&]page=1$/u.test(call.url)
            ? { status: 200, body: fullPage, headers: { link: page1Link } }
            : (/[?&]page=5$/u.test(call.url)
                ? { status: 200, body: [MATCHING_REVIEW], headers: { link: reorderedLast } }
                : { status: 200, body: fullPage, headers: { link: reorderedLast } })),
      },
    ], { maxReconciliationPages: 3 });
    await expect(poster.reconcile?.({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual(RECEIPT);
    const pages = calls.filter((call) => call.method === 'GET' && call.url.includes('/reviews?'))
      .map((call) => /[?&]page=(\d+)/u.exec(call.url)?.[1]);
    expect(pages).toEqual(['1', '2', '5']);
  });
});

describe('key path resolution and external keys', () => {
  it('resolves absolute and relative key paths; Windows-form paths are refused on POSIX instead of probing the CWD', () => {
    expect(resolvePerkinsAppKeyPath('/bundle', '/abs/key.pem')).toBe('/abs/key.pem');
    expect(resolvePerkinsAppKeyPath('/bundle', 'keys/k.pem')).toBe(join('/bundle', 'keys/k.pem'));
    expect(resolvePerkinsAppKeyPath('/bundle', '../keys/k.pem')).toBe(join('/bundle', '../keys/k.pem'));
    if (process.platform === 'win32') {
      expect(resolvePerkinsAppKeyPath('/bundle', 'C:\\keys\\k.pem')).toBe('C:\\keys\\k.pem');
      expect(resolvePerkinsAppKeyPath('/bundle', '\\\\server\\share\\k.pem')).toBe('\\\\server\\share\\k.pem');
    } else {
      // On POSIX neither form is absolute: used verbatim they would resolve
      // against the process working directory, so they are refused by name.
      for (const form of ['C:\\keys\\k.pem', 'C:/keys/k.pem', '\\\\server\\share\\k.pem']) {
        expect(() => resolvePerkinsAppKeyPath('/bundle', form)).toThrow(/Windows path form on a POSIX host/u);
      }
      // Integration: a bundle config naming a Windows-form key refuses at
      // load, before any CWD file could be opened as the App key.
      const fixture = bundleFixture('app_id=424242\nkey_path=C:\\keys\\k.pem\ninstallation_id_acme=164552969\n');
      expect(() => loadPerkinsAppBundle(fixture.home)).toThrow(/Windows path form on a POSIX host/u);
    }
  });

  it('treats a single leading backslash as bundle-relative — only UNC starts with two', () => {
    // A lone leading backslash is not an absolute form on either platform:
    // on POSIX it is an ordinary filename character, on Windows a
    // drive-relative root. It must resolve under the bundle dir (the
    // documented never-CWD rule), never be used as written.
    expect(resolvePerkinsAppKeyPath('/bundle', '\\k.pem')).toBe(join('/bundle', '\\k.pem'));
    expect(resolvePerkinsAppKeyPath('/bundle', '\\keys\\k.pem')).toBe(join('/bundle', '\\keys\\k.pem'));
  });

  it('accepts an external key reached through .. and rejects the same path when symlinked', () => {
    const fixture = bundleFixture('app_id=424242\nkey_path=../keys/app-key.pem\ninstallation_id_acme=164552969\n');
    mkdirSync(join(fixture.home, 'keys'), { recursive: true });
    const externalKey = join(fixture.home, 'keys', 'app-key.pem');
    writeFileSync(externalKey, fixture.key.privateKeyPem, 'utf8');
    chmodSync(externalKey, 0o600);
    expect(loadPerkinsAppBundle(fixture.home).config.appId).toBe(424242);

    const linked = bundleFixture('app_id=424242\nkey_path=../keys/app-key.pem\ninstallation_id_acme=164552969\n');
    mkdirSync(join(linked.home, 'keys'), { recursive: true });
    symlinkSync(join(linked.home, 'perkins', 'app-key.pem'), join(linked.home, 'keys', 'app-key.pem'));
    expect(() => loadPerkinsAppBundle(linked.home)).toThrow(/symbolic link/u);
  });

  it('accepts and safety-checks an absolute key outside the bundle dir', () => {
    const outside = mkdtempSync(join(tmpdir(), 'perkins-app-external-'));
    try {
      const key = syntheticAppKey();
      const externalKey = join(outside, 'app-key.pem');
      writeFileSync(externalKey, key.privateKeyPem, 'utf8');
      chmodSync(externalKey, 0o600);
      const fixture = bundleFixture(`app_id=424242\nkey_path=${externalKey}\ninstallation_id_acme=164552969\n`);
      expect(loadPerkinsAppBundle(fixture.home).config.appId).toBe(424242);
      chmodSync(externalKey, 0o644);
      expect(() => loadPerkinsAppBundle(fixture.home)).toThrow(/owner-only/u);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects an implausibly large credential file instead of buffering it', () => {
    const fixture = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    const configPath = join(fixture.home, 'perkins', 'config');
    writeFileSync(configPath, 'x'.repeat(1_048_577), 'utf8');
    chmodSync(configPath, 0o600);
    expect(() => loadPerkinsAppBundle(fixture.home)).toThrow(/implausibly large/u);
  });
});

describe('bundle root resolution (instance dir vs relocated data dir)', () => {
  const writeBundle = (root: string): void => {
    const key = syntheticAppKey();
    mkdirSync(join(root, 'perkins'), { recursive: true });
    chmodSync(join(root, 'perkins'), 0o700);
    writeFileSync(join(root, 'perkins', 'app-key.pem'), key.privateKeyPem, 'utf8');
    chmodSync(join(root, 'perkins', 'app-key.pem'), 0o600);
    const configPath = join(root, 'perkins', 'config');
    writeFileSync(configPath, 'app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n', 'utf8');
    chmodSync(configPath, 0o600);
  };

  it('prefers the instance dir, falls back to a relocated data dir, and defaults to the instance dir', () => {
    const instance = mkdtempSync(join(tmpdir(), 'perkins-root-instance-'));
    const data = mkdtempSync(join(tmpdir(), 'perkins-root-data-'));
    try {
      expect(resolvePerkinsAppBundleRoot({ instanceDir: instance, dataDir: data })).toBe(instance);
      writeBundle(data);
      expect(resolvePerkinsAppBundleRoot({ instanceDir: instance, dataDir: data })).toBe(data);
      writeBundle(instance);
      expect(resolvePerkinsAppBundleRoot({ instanceDir: instance, dataDir: data })).toBe(instance);
    } finally {
      rmSync(instance, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('publishes through a bundle found under the relocated data dir', async () => {
    const fixture = bundleFixture();
    const instance = mkdtempSync(join(tmpdir(), 'perkins-root-boot-'));
    const data = mkdtempSync(join(tmpdir(), 'perkins-root-data-only-'));
    try {
      writeBundle(data);
      const api = makeApiDouble();
      const auto = createStartupVerdictPoster({ instanceDir: instance, dataDir: data }, {
        fetchImpl: api.fetchImpl,
        now: () => NOW,
      });
      const legs = auto as unknown as { github: VerdictPoster; gitlab: VerdictPoster };
      expect(legs.github).toBeInstanceOf(PerkinsAppPrPoster);
      await expect(auto.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual(RECEIPT);
    } finally {
      rmSync(instance, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('fails loud on malformed wiring roots instead of probing the CWD', () => {
    expect(() => createGithubVerdictPoster('relative/path')).toThrow(/absolute instance directory/u);
    expect(() => createGithubVerdictPoster('')).toThrow(PerkinsAppError);
    // The exported poster class is a public boundary too: a direct
    // construction with a relative or empty root fails before any probe.
    expect(() => new PerkinsAppPrPoster({ instanceDir: 'relative/path' })).toThrow(/absolute instance directory/u);
    expect(() => new PerkinsAppPrPoster({ instanceDir: '' })).toThrow(PerkinsAppError);
    const abs = mkdtempSync(join(tmpdir(), 'perkins-root-malformed-'));
    try {
      expect(() => createStartupVerdictPoster({ instanceDir: abs, dataDir: 'relative' })).toThrow(/absolute data directory/u);
    } finally {
      rmSync(abs, { recursive: true, force: true });
    }
  });
});

describe('startup wiring pin (src/main.ts)', () => {
  it('wires the App-selected factory and cannot revert to the personal poster unnoticed', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf-8');
    expect(main).toContain("import { createStartupVerdictPoster } from './dispatch/perkins-github-app.js';");
    expect(main).toContain('poster: createStartupVerdictPoster(config),');
    expect(main).not.toContain('poster: new AutoVerdictPoster()');
    expect(main).not.toMatch(/poster:\s*new GhPrPoster\(/u);
  });
});
