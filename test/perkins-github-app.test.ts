import { execFileSync } from 'node:child_process';
import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  type AppFetch,
  type AppFetchInit,
} from '../src/dispatch/perkins-github-app.js';
import { AutoVerdictPoster, GhPrPoster, GitLabMrPoster, type VerdictPoster } from '../src/dispatch/perkins.js';
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

type RouteHandler = (call: RecordedCall) => Promise<{ status: number; body?: unknown; rawText?: string; headers?: Headers | Record<string, string> }>;

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
        "installation_id_mssoka=164552969",
        'installation_id_solarity-services=999888777',
        '  installation_id_MixedCase=42  ',
        '',
      ].join('\n'),
      'perkins app bundle',
    );
    expect(config.appId).toBe(4366368);
    expect(config.keyPath).toBe('/opt/keys/perkins key.pem');
    expect(config.installationIds.get('mssoka')).toBe('164552969');
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
      .toThrow(/unrecognized key "key-path"/u);
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

  it('rejects a bundle file owned by another user', () => {
    if (process.getuid === undefined || process.getuid() === 0) return; // not observable on this platform
    const fixture = bundleFixture('app_id=424242\nkey_path=app-key.pem\ninstallation_id_acme=164552969\n');
    const original = process.getuid;
    const seam = process as { getuid?: () => number };
    try {
      seam.getuid = () => original() + 1;
      expect(() => loadPerkinsAppBundle(fixture.home)).toThrow(/bundle directory is owned by another user/u);
    } finally {
      seam.getuid = original;
    }
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
      const poster = createGithubVerdictPoster(home);
      expect(poster).toBeInstanceOf(PerkinsAppPrPoster);
      const repo = makeFixtureRepo('perkins-app-dangling-repo');
      try {
        execFileSync('git', ['-C', repo.path, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git'], { stdio: 'ignore' });
        await expect(poster.post({ ...PR_INPUT, repoPath: repo.path }))
          .rejects.toThrow(/symbolic link/u);
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
});

// ---------------------------------------------------------------------------
// Post-POST identity proof
// ---------------------------------------------------------------------------

describe('post-publication identity proof', () => {
  it('routes an unprovable receipt through bounded reconciliation — foreign author with no proved match stays unproven', async () => {
    const fixture = bundleFixture();
    const foreign = { id: 1, user: { login: 'mssoka', type: 'User' }, commit_id: HEAD, state: 'COMMENTED', body: 'review body\n' };
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
    const foreign = { id: 1, user: { login: 'mssoka', type: 'User' }, commit_id: HEAD, state: 'COMMENTED', body: 'review body\n' };
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
    const foreignAuthor = { ...MATCHING_REVIEW, user: { login: 'mssoka', type: 'User' } };
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [foreignAuthor] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/NOT re-posted/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
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
      user: { login: 'mssoka', type: 'User' },
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

  it('treats a 2xx receipt with an empty body as an unprovable receipt and reconciles', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 200, rawText: '' }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [] }) },
    ]);
    const error = await poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }).then(() => null, (cause: unknown) => cause as Error);
    expect(error?.message ?? '').toMatch(/<absent>/u);
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
    ]);
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
    // the poster resolves repo origins with git and never shells out to gh.
    expect((poster as unknown as { gitBinary?: string }).gitBinary).toBe('git');
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });
});
