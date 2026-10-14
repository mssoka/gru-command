#!/usr/bin/env node
/**
 * GH350 real-tool fixture provisioning (Root-approved 2026-10-14, bounded
 * guards; see _bmad-output/implementation-artifacts/gh350-lane-board.md).
 *
 * Two declared stages, each run exactly as recorded:
 *   resolve     — ONE initial lockfile resolution (`npm install
 *                 --package-lock-only`) producing the committed lock
 *                 identity; ranges are resolution inputs, never execution
 *                 identity.
 *   materialize — ONE fresh locked materialization (`npm ci`) into the
 *                 fixture's gitignored node_modules, then validation of the
 *                 actually installed locked toolchain.
 *
 * Guards enforced here: public npm registry only (no git/URL/path
 * specifiers survive — the lock is scanned); dependency lifecycle scripts,
 * audit and funding disabled; owned isolated HOME/config/cache/temp; a
 * minimal allowlisted environment with no credentials; canonical
 * containment + no-symlink destination checks; refusal on unexpected
 * existing state; complete separate output streams with direct exit codes
 * and timings preserved as JSON. Network is used ONLY for these documented
 * provisioning stages — never for generated-test execution.
 *
 * Unexpected provisioning failure STOPs this stage with evidence; there is
 * no retry, cleanup or broader fallback here.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(repoRoot, 'test', 'fixtures', 'property', 'real-tool');
const provisioningDir = join(fixtureDir, '.provisioning');
const registry = 'https://registry.npmjs.org/';
const MAX_STREAM_BYTES = 32 * 1024 * 1024;

function dirname(path) {
  const parts = path.split('/');
  parts.pop();
  return parts.join('/') || '/';
}

function fail(message) {
  process.stderr.write(`provision-property-real-fixture: ${message}\n`);
  process.exit(1);
}

function contained(base, candidate) {
  const rel = relative(base, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function canonicalContainment() {
  // Every path component of the fixture must be canonical (no symlinked
  // destination segments) and the fixture must sit inside the repository.
  let canonical;
  try {
    canonical = realpathSync(fixtureDir);
  } catch (error) {
    fail(`fixture directory is unreadable: ${String(error)}`);
  }
  let canonicalRepo;
  try {
    canonicalRepo = realpathSync(repoRoot);
  } catch (error) {
    fail(`repository root is unreadable: ${String(error)}`);
  }
  if (!contained(canonicalRepo, canonical)) fail(`fixture resolves outside the repository: ${canonical}`);
  let cursor = repoRoot;
  for (const part of fixtureDir.split(sep).slice(repoRoot.split(sep).length)) {
    cursor = join(cursor, part);
    let info;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      fail(`destination segment is unreadable: ${cursor} (${String(error)})`);
    }
    if (info.isSymbolicLink()) fail(`destination segment is a symlink: ${cursor}`);
  }
  return canonical;
}

function isolatedEnvironment(stage) {
  const home = join(provisioningDir, stage, 'home');
  const cache = join(provisioningDir, stage, 'cache');
  const tmp = join(provisioningDir, stage, 'tmp');
  for (const dir of [home, cache, tmp]) mkdirSync(dir, { recursive: true });
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: tmp,
    LANG: 'C',
    npm_config_cache: cache,
    npm_config_registry: registry,
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    NO_COLOR: '1',
  };
  return { env, home, cache, tmp };
}

function runInstaller(stage, args) {
  const canonical = canonicalContainment();
  const { env, home, cache, tmp } = isolatedEnvironment(stage);
  const installer = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const argv = [installer, args.join(' ')];
  const record = {
    stage,
    installer: argv.join(' '),
    node: process.version,
    cwd: canonical,
    envPolicy: {
      allowlist: Object.keys(env).sort(),
      isolatedHome: home,
      isolatedCache: cache,
      isolatedTmp: tmp,
      credentialsStripped: 'allowlist-only environment; no token/key/secret variables are passed',
    },
    registry,
    expectedResult: stage === 'resolve' ? 'package-lock.json written with exact resolved versions and integrity' : 'node_modules materialized exactly from the committed lock',
    outputLimits: { maxStreamBytes: MAX_STREAM_BYTES, stdoutPath: join(provisioningDir, stage, 'stdout.txt'), stderrPath: join(provisioningDir, stage, 'stderr.txt') },
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(join(provisioningDir, stage, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  const started = Date.now();
  const result = spawnSync(installer, args, {
    cwd: canonical,
    env,
    encoding: 'buffer',
    maxBuffer: MAX_STREAM_BYTES,
    timeout: 10 * 60 * 1000,
  });
  const durationMs = Date.now() - started;
  const stdout = (result.stdout ?? Buffer.alloc(0)).toString('utf8');
  const stderr = (result.stderr ?? Buffer.alloc(0)).toString('utf8');
  writeFileSync(record.outputLimits.stdoutPath, stdout);
  writeFileSync(record.outputLimits.stderrPath, stderr);
  const outcome = {
    stage,
    exitCode: result.status,
    signal: result.signal,
    timedOut: result.error !== undefined && result.error.code === 'ETIMEDOUT',
    durationMs,
    stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
    stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
    stderrBytes: Buffer.byteLength(stderr, 'utf8'),
    stderrSha256: createHash('sha256').update(stderr).digest('hex'),
  };
  writeFileSync(join(provisioningDir, stage, 'outcome.json'), `${JSON.stringify(outcome, null, 2)}\n`);
  if (result.error !== undefined && result.error.code !== 'ETIMEDOUT') fail(`installer could not be spawned: ${String(result.error)}`);
  return outcome;
}

function assertPublicRegistryLock() {
  const lockPath = join(fixtureDir, 'package-lock.json');
  if (!existsSync(lockPath)) fail('package-lock.json is missing after the resolve stage');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lock.lockfileVersion !== 3) fail(`expected lockfileVersion 3, got ${String(lock.lockfileVersion)}`);
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === '') continue;
    const resolved = entry?.resolved;
    if (typeof resolved !== 'string' || !resolved.startsWith(registry)) {
      fail(`lock entry ${path} resolves outside the public npm registry: ${String(resolved)}`);
    }
    if (typeof entry?.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) {
      fail(`lock entry ${path} lacks sha512 integrity`);
    }
  }
}

function validateInstalledToolchain() {
  const lock = JSON.parse(readFileSync(join(fixtureDir, 'package-lock.json'), 'utf8'));
  const expected = {
    vitest: lock.packages?.['node_modules/vitest']?.version,
    'fast-check': lock.packages?.['node_modules/fast-check']?.version,
  };
  for (const [name, version] of Object.entries(expected)) {
    if (typeof version !== 'string') fail(`committed lock does not pin ${name}`);
    const installedPath = join(fixtureDir, 'node_modules', name, 'package.json');
    if (!existsSync(installedPath)) fail(`installed toolchain is missing ${name} — campaign is NOT runnable`);
    const installed = JSON.parse(readFileSync(installedPath, 'utf8'));
    if (installed.version !== version) fail(`installed ${name}@${installed.version} does not match the committed lock ${version}`);
  }
  const vitestBin = join(fixtureDir, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitestBin)) fail('vitest entrypoint (node_modules/vitest/vitest.mjs) is missing after materialization');
  process.stdout.write(`validated locked toolchain: vitest@${expected.vitest} fast-check@${expected['fast-check']}\n`);
}

const stage = process.argv[2];
if (stage === 'resolve') {
  if (!existsSync(join(fixtureDir, 'package.json'))) fail('fixture package.json is missing');
  const lockPath = join(fixtureDir, 'package-lock.json');
  if (existsSync(lockPath)) fail('package-lock.json already exists — the one initial lock resolution was already performed; commit it and use materialize');
  mkdirSync(join(provisioningDir, 'resolve'), { recursive: true });
  const outcome = runInstaller('resolve', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${registry}`]);
  if (outcome.exitCode !== 0) fail(`resolve stage failed (exit ${outcome.exitCode}) — STOP with evidence at ${join(provisioningDir, 'resolve')}; no retry`);
  assertPublicRegistryLock();
  const lock = readFileSync(lockPath, 'utf8');
  process.stdout.write(`resolve stage complete: lock sha256=${createHash('sha256').update(lock).digest('hex')}\n`);
  process.exit(0);
}
if (stage === 'materialize') {
  const lockPath = join(fixtureDir, 'package-lock.json');
  if (!existsSync(lockPath)) fail('committed package-lock.json is required before materialization');
  assertPublicRegistryLock();
  const modules = join(fixtureDir, 'node_modules');
  if (existsSync(modules)) fail('node_modules already exists — unexpected existing state; STOP with evidence; no silent reinstall');
  mkdirSync(join(provisioningDir, 'materialize'), { recursive: true });
  const outcome = runInstaller('materialize', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${registry}`]);
  if (outcome.exitCode !== 0) {
    // npm ci leaves a partial node_modules on failure — the evidence stays;
    // unexpected provisioning failures STOP, no cleanup/retry here.
    fail(`materialize stage failed (exit ${outcome.exitCode}) — STOP with evidence at ${join(provisioningDir, 'materialize')}; no retry, no cleanup`);
  }
  validateInstalledToolchain();
  process.exit(0);
}
fail(`usage: node tools/provision-property-real-fixture.mjs <resolve|materialize>`);
