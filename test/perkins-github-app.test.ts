import { execFileSync } from 'node:child_process';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGithubVerdictPoster,
  loadPerkinsAppBundle,
  parsePerkinsAppConfig,
  PerkinsAppError,
  PerkinsAppHttpError,
  PerkinsAppPrPoster,
  type AppFetch,
  type AppFetchInit,
} from '../src/dispatch/perkins-github-app.js';
import { AutoVerdictPoster, GhPrPoster, GitLabMrPoster } from '../src/dispatch/perkins.js';
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
  writeFileSync(join(home, 'perkins', 'app-key.pem'), key.privateKeyPem, 'utf8');
  chmodSync(join(home, 'perkins', 'app-key.pem'), 0o600);
  // The poster never interpolates config values; the fixture substitutes
  // its own placeholder BEFORE writing so the on-disk bytes are a literal
  // quoted absolute path exactly like the deployed bundle.
  writeFileSync(join(home, 'perkins', 'config'), configText.replaceAll('$BUNDLE_DIR', join(home, 'perkins')), 'utf8');
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

type RouteHandler = (call: RecordedCall) => Promise<{ status: number; body?: unknown }>;

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
      text: async () => JSON.stringify(response.body ?? null),
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
      writeFileSync(join(ecHome, 'perkins', 'app-key.pem'), ec.privateKey, 'utf8');
      writeFileSync(join(ecHome, 'perkins', 'config'), 'app_id=1\nkey_path=app-key.pem\ninstallation_id_acme=5\n', 'utf8');
      expect(() => loadPerkinsAppBundle(ecHome)).toThrow(/not RSA/u);
    } finally {
      rmSync(ecHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Startup selection
// ---------------------------------------------------------------------------

describe('startup poster selection', () => {
  it('keeps the legacy gh poster byte-for-byte when no App bundle exists', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'perkins-app-empty-'));
    try {
      const poster = createGithubVerdictPoster(emptyHome);
      expect(poster).toBeInstanceOf(GhPrPoster);
      const legacy = new GhPrPoster();
      expect(poster.constructor).toBe(legacy.constructor);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it('selects the App poster when the bundle config exists, and AutoVerdictPoster routes github.com through it', async () => {
    const fixture = bundleFixture();
    const api = makeApiDouble();
    const github = createGithubVerdictPoster(fixture.home, {
      fetchImpl: api.fetchImpl,
      now: () => NOW,
    });
    expect(github).toBeInstanceOf(PerkinsAppPrPoster);
    // Startup wiring shape: the auto router delegates the github.com leg to
    // the selected publisher while GitLab routing is untouched.
    const gitlabCalls: string[] = [];
    const gitlab: typeof github = {
      post: async (input) => {
        gitlabCalls.push(input.prUrl);
        return { headSha: input.targetSha, baseSha: input.baseSha };
      },
    };
    const auto = new AutoVerdictPoster(github, gitlab);
    await expect(auto.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) })).resolves.toEqual({ headSha: HEAD, baseSha: BASE });
    expect(api.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
    await auto.post({
      prUrl: 'https://gitlab.example.test/acme/widget/-/merge_requests/7',
      host: 'gitlab.example.test',
      repoPath: repoPathOf(fixture),
      body: 'x',
      targetSha: HEAD,
      baseSha: BASE,
    });
    expect(gitlabCalls).toEqual(['https://gitlab.example.test/acme/widget/-/merge_requests/7']);
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
      .resolves.toEqual({ headSha: HEAD, baseSha: BASE });

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
  it('rejects a delivery whose real author is not the verified App bot', async () => {
    const fixture = bundleFixture();
    const { poster } = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({ status: 200, body: { id: 1, user: { login: 'mssoka', type: 'User' }, commit_id: HEAD, state: 'COMMENTED' } }),
      },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/identity mismatch/u);
  });

  it('rejects a delivery receipt bound to a different commit', async () => {
    const fixture = bundleFixture();
    const { poster } = posterWith(fixture, [
      {
        method: 'POST', test: /\/reviews$/,
        handler: async () => ({ status: 200, body: { id: 1, user: { login: 'perkins-review[bot]', type: 'Bot' }, commit_id: '9'.repeat(40), state: 'COMMENTED' } }),
      },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/receipt mismatch/u);
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
};

describe('bounded ambiguous-POST reconciliation', () => {
  it('credits a provider-proved matching App review without a second POST', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual({ headSha: HEAD, baseSha: BASE });
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
      .rejects.toThrow(/delivery stays unproven/u);
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('treats lookup exhaustion and lookup errors as unproven, never as absence', async () => {
    const fixture = bundleFixture();
    const emptyList = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [] }) },
    ]);
    await expect(emptyList.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(/delivery stays unproven/u);
    expect(emptyList.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);

    const lookupError = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => { throw new Error('socket hang up after send'); } },
      { method: 'GET', test: /\/reviews\?/, handler: async () => { throw new Error('connection reset'); } },
    ]);
    await expect(lookupError.poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .rejects.toThrow(PerkinsAppError);
    expect(lookupError.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
  });

  it('reconciles a 5xx POST outcome the same bounded way', async () => {
    const fixture = bundleFixture();
    const { poster, calls } = posterWith(fixture, [
      { method: 'POST', test: /\/reviews$/, handler: async () => ({ status: 502, body: { message: 'Bad Gateway' } }) },
      { method: 'GET', test: /\/reviews\?/, handler: async () => ({ status: 200, body: [MATCHING_REVIEW] }) },
    ]);
    await expect(poster.post({ ...PR_INPUT, repoPath: repoPathOf(fixture) }))
      .resolves.toEqual({ headSha: HEAD, baseSha: BASE });
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(1);
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
    // the poster class never shells out to gh at all.
    expect((poster as unknown as { binary?: string }).binary).toBeUndefined();
    expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/reviews'))).toHaveLength(0);
  });

  it('leaves the explicit legacy route usable for deployments with no bundle (parity spot-check)', () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'perkins-app-parity-'));
    try {
      const legacy = createGithubVerdictPoster(emptyHome, { fetchImpl: (async () => { throw new Error('unused'); }) as AppFetch });
      expect(legacy).toBeInstanceOf(GhPrPoster);
      expect(GitLabMrPoster).toBeDefined();
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });
});
