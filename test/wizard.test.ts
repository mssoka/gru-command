import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, configPathFor } from '../src/config.js';
import { probeRuntimes } from '../src/runtime/probe.js';
import { formatHostForUrl, runFirstBootSmoke } from '../src/wizard/main.js';
import { AnswersError, generateToken, parseAnswers, resolveBindHost, validateHost, validateWorkspaceRoot } from '../src/wizard/answers.js';
import {
  backupTimestamp,
  buildQrPayload,
  discoverManagedRepos,
  generateConfigToml,
  seedAnswersFromConfig,
  writeConfigText,
  writeInstanceConfig,
} from '../src/wizard/steps.js';
import type { GruCommandConfig } from '../src/config.js';

/**
 * Setup wizard units (E9): answers validation (fail-loud, nothing
 * written), schema-exact config generation (proven against the REAL
 * loader), backup-on-rerun, QR payload shape parity with the web pairing
 * screen, managed-repo discovery, and no-runtime warn-and-proceed data.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function writeWizardConfig(
  instanceDir: string,
  answers = parseAnswers('{}'),
  home?: string,
  force = false,
  explicitKeys?: ReadonlySet<string>,
) {
  return writeInstanceConfig({ instanceDir, answers, home, force, explicitKeys });
}

function generateWizardConfig(instanceDir: string, answers = parseAnswers('{}')): string {
  return generateConfigToml({ answers, instanceDir });
}

describe('wizard answers', () => {
  it('{} completes headlessly: every answer defaults, token generated', () => {
    const answers = parseAnswers('{}');
    expect(answers.workspaceRoot).toBe('~/code');
    expect(answers.repos).toEqual([]);
    expect(answers.runtime).toBe('pi');
    expect(answers.model).toBe('default'); // SPEC ruling 16: never hardcode a model
    expect(answers.thinkingLevel).toBe('default');
    expect(answers.roles).toEqual({});
    expect(answers.host).toBe('127.0.0.1');
    expect(answers.port).toBe(7665);
    expect(answers.token).not.toBe('');
    expect(answers.registerService).toBe(false);
    expect(answers.smoke).toBe(true);
    expect(answers.bmad).toEqual({});
  });

  it('invalid answers fail loud, naming the field — nothing written anywhere', () => {
    const cases: Array<[string, RegExp]> = [
      ['{"workspace_root":"code"}', /workspace_root must be an absolute path/],
      ['{"runtime":"cursor"}', /unknown runtime `cursor`/],
      ['{"roles":{"chief":"pi"}}', /unknown role `chief`/],
      ['{"roles":{"gru":"vim"}}', /unknown runtime `vim` in answers.roles.gru/],
      ['{"port":"seven"}', /answers.port must be an integer between 0 and 65535/],
      ['{"port":70000}', /answers.port must be an integer between 0 and 65535/],
      ['{"host":"not a host!"}', /answers.host must be an IPv4\/IPv6 literal or a hostname, got: not a host!/],
      ['{"host":"999.1.1.1"}', /answers.host is not a valid IPv4/],
      ['{"host":":::"}', /answers.host is not a valid IPv6/],
      // Perkins r2 note — the validator was wrong BOTH ways: it accepted
      // 'a:b' (2 groups ≠ 8) and rejected the valid '::'. Both pinned.
      ['{"host":"a:b"}', /answers.host is not a valid IPv6/],
      ['{"host":"1:2"}', /answers.host is not a valid IPv6/],
      ['{"host":"::ffff:999.1.1.1"}', /answers.host is not a valid IPv6/],
      ['{"token":""}', /answers.token must not be empty/],
      ['{"frobnicate":1}', /unknown answers key `frobnicate`/],
      ['not json', /--answers is not valid JSON/],
    ];
    for (const [json, pattern] of cases) {
      expect(() => parseAnswers(json), json).toThrow(pattern);
    }
    // A validation failure must never leave a config behind: parsing is
    // pure — prove the loudest case writes nothing.
    const instanceDir = tempDir('gru-command-wizard-nowrite-');
    try {
      parseAnswers('{"port":70000}');
    } catch {
      /* expected */
    }
    expect(existsSync(configPathFor(instanceDir))).toBe(false);
  });

  it('repos answers must name real git repos under the workspace root', () => {
    const home = tempDir('gru-command-wizard-repos-');
    const workspace = join(home, 'code');
    mkdirSync(join(workspace, 'repo-a', '.git'), { recursive: true });
    mkdirSync(join(workspace, 'repo-b'), { recursive: true });
    writeFileSync(join(workspace, 'repo-b', '.git'), 'gitdir: elsewhere\n', 'utf-8');
    mkdirSync(join(workspace, 'not-repo'), { recursive: true });

    const ok = parseAnswers(
      JSON.stringify({ workspace_root: workspace, repos: ['repo-a', 'repo-b'] }),
    );
    expect(ok.repos).toEqual(['repo-a', 'repo-b']);
    expect(ok.bmad).toEqual({ 'repo-a': 'install', 'repo-b': 'install' });
    mkdirSync(join(workspace, 'repo-b', '_bmad', '_config'), { recursive: true });
    writeFileSync(join(workspace, 'repo-b', '_bmad', '_config', 'manifest.yaml'), 'existing\n');
    const defaultsByState = parseAnswers(
      JSON.stringify({ workspace_root: workspace, repos: ['repo-a', 'repo-b'] }),
    );
    expect(defaultsByState.bmad).toEqual({ 'repo-a': 'install', 'repo-b': 'reuse' });
    expect(() =>
      parseAnswers(JSON.stringify({ workspace_root: workspace, repos: ['repo-a', 'repo-a'] })),
    ).toThrow(/duplicate repo names/);
    // .git FILE (worktree pointer) counts; a plain directory does not.
    expect(() => parseAnswers(`{"workspace_root":"${workspace}","repos":["not-repo"]}`)).toThrow(
      /not a git repo under the workspace root/,
    );
    expect(() => parseAnswers(`{"workspace_root":"${workspace}","repos":["../escape"]}`)).toThrow(
      /plain directory names/,
    );
  });
});

describe('wizard config generation', () => {
  const home = tempDir('gru-command-wizard-home-');

  it('generated config is schema-exact: the REAL loader accepts it', () => {
    const instanceDir = tempDir('gru-command-wizard-cfg-');
    const answers = parseAnswers(
      JSON.stringify({
        workspace_root: '~/code',
        runtime: 'claude-code',
        roles: { gru: 'pi', minion: 'claude-code' },
        token: 'wizard-test-token',
      }),
    );
    const { configPath, backupPath } = writeWizardConfig(instanceDir, answers, home);
    expect(backupPath).toBeNull(); // first write: nothing to back up
    const config = loadConfig({ GRU_COMMAND_HOME: instanceDir }, home);
    expect(config.sourceFile).toBe(configPath);
    expect(config.workspaceRoot).toBe(join(home, 'code'));
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(7665);
    expect(config.auth.token).toBe('wizard-test-token');
    expect(config.runtimes.default).toBe('claude-code');
    expect(config.runtimes.roles).toEqual({ gru: 'pi', minion: 'claude-code' });
    expect(config.models.default).toBe('default');
    expect(config.thinking.default).toBe('default');
    expect(config.dataDir).toBe(instanceDir);
  });

  it('config, backup, and hardened rewrite are 0600 — the pairing token is never world-readable (Perkins r1 W5)', () => {
    const instanceDir = tempDir('gru-command-wizard-mode-');
    const first = writeWizardConfig(instanceDir, parseAnswers('{"token":"mode-one"}'), home);
    // First write: 0600 by construction.
    expect(statSync(first.configPath).mode & 0o777).toBe(0o600);
    // A pre-existing 0644 config (older install) is HARDENED only after explicit force.
    chmodSync(first.configPath, 0o644);
    expect(() =>
      writeWizardConfig(instanceDir, parseAnswers('{"token":"mode-two"}'), home),
    ).toThrow(/without --force/);
    const second = writeWizardConfig(
      instanceDir,
      parseAnswers('{"token":"mode-two"}'),
      home,
      true,
    );
    expect(statSync(second.configPath).mode & 0o777).toBe(0o600);
    // The backup carries the token too — also owner-only.
    expect(second.backupPath).not.toBeNull();
    expect(statSync(second.backupPath!).mode & 0o777).toBe(0o600);
    // No PID-suffixed tmp file survives.
    expect(existsSync(`${second.configPath}.tmp-${process.pid}`)).toBe(false);
  });

  it('write-failure contracts: backup failure aborts with the original intact; write failure is named (Perkins r1 W12)', () => {
    // (a) Backup failure aborts BEFORE any write — the original stands.
    const instanceDir = tempDir('gru-command-wizard-wfail-');
    writeWizardConfig(instanceDir, parseAnswers('{"token":"original"}'), home);
    chmodSync(instanceDir, 0o555); // read-only: the backup copy must fail
    try {
      expect(() =>
        writeWizardConfig(instanceDir, parseAnswers('{"token":"intruder"}'), home, true),
      ).toThrow();
      expect(readFileSync(join(instanceDir, 'config.toml'), 'utf-8')).toContain('original');
    } finally {
      chmodSync(instanceDir, 0o755); // cleanup needs a writable dir
    }
    // (b) Write failure (no prior config): named error, nothing left behind.
    const emptyDir = tempDir('gru-command-wizard-wfail2-');
    mkdirSync(emptyDir, { recursive: true });
    chmodSync(emptyDir, 0o555);
    try {
      expect(() => writeWizardConfig(emptyDir, parseAnswers('{}'), home)).toThrow(
        /failed to write .* atomically/,
      );
      expect(existsSync(join(emptyDir, 'config.toml'))).toBe(false);
      expect(existsSync(join(emptyDir, `config.toml.tmp-${process.pid}`))).toBe(false);
    } finally {
      chmodSync(emptyDir, 0o755);
    }
  });

  it('re-run over an existing config backs it up (timestamped) before rewriting', () => {
    const instanceDir = tempDir('gru-command-wizard-cfg2-');
    const first = parseAnswers('{"token":"first-token"}');
    const second = parseAnswers('{"token":"second-token"}');
    const w1 = writeWizardConfig(instanceDir, first, home);
    expect(w1.backupPath).toBeNull();
    expect(() => writeWizardConfig(instanceDir, second, home)).toThrow(/without --force/);
    // Explicit answers ride with their raw JSON key names — an explicit
    // token always wins over the prior config.
    const w2 = writeWizardConfig(instanceDir, second, home, true, new Set(['token']));
    expect(w2.backupPath).not.toBeNull();
    // Millisecond precision (Perkins r2 note): same-second reruns must
    // not clobber — the name carries ms.
    expect(w2.backupPath).toMatch(/config\.toml\.backup-\d{8}T\d{6}\d{3}Z$/);
    expect(readFileSync(w2.backupPath!, 'utf-8')).toContain('first-token');
    expect(readFileSync(w2.configPath, 'utf-8')).toContain('second-token');
    // Round-trip guarantee: a LATER re-run without explicit keys keeps the
    // operator's token instead of silently regenerating it.
    const w3 = writeWizardConfig(instanceDir, parseAnswers('{}'), home, true);
    expect(readFileSync(w3.configPath, 'utf-8')).toContain('second-token');
    // The backup timestamp is filesystem-safe (no colons).
    expect(backupTimestamp()).not.toContain(':');
  });

  it('same-millisecond forced rewrites retain distinct exclusive backups', () => {
    const instanceDir = tempDir('gru-command-wizard-backup-collision-');
    writeWizardConfig(instanceDir, parseAnswers('{"token":"first"}'), home);
    const now = new Date('2026-09-19T12:34:56.789Z');
    const second = writeConfigText(
      instanceDir,
      generateWizardConfig(instanceDir, parseAnswers('{"token":"second"}')),
      { force: true, now },
    );
    const third = writeConfigText(
      instanceDir,
      generateWizardConfig(instanceDir, parseAnswers('{"token":"third"}')),
      { force: true, now },
    );
    expect(second.backupPath).not.toBe(third.backupPath);
    expect(third.backupPath).toBe(`${second.backupPath}-1`);
    expect(readFileSync(second.backupPath!, 'utf-8')).toContain('first');
    expect(readFileSync(third.backupPath!, 'utf-8')).toContain('second');
  });

  it('generated TOML carries only documented top-level keys (the loader reads THE generated file)', () => {
    const instanceDir = tempDir('gru-command-wizard-cfg3-');
    const answers = parseAnswers('{"token":"keys-probe"}');
    const text = generateWizardConfig(instanceDir, answers);
    expect(text).toContain('workspace_root');
    expect(text).toContain('[server]');
    expect(text).toContain('[auth]');
    expect(text).toContain('[runtimes]');
    expect(text).toContain('[models]');
    expect(text).toContain('[thinking]');
    // Install-v2 full-set ruling: every concrete default is editable in the
    // live file, including the actual per-instance data directory.
    expect(text).toContain(`data_dir = "${instanceDir}"`);
    expect(text).toContain('[supervision]');
    expect(text).toContain('[logging]');
    expect(text).toContain('[chat]');
    expect(text).toContain('[worktrees]');
    expect(text).toContain('[dispatch]');
    // The vacuous version loaded an EMPTY instance dir (pure defaults);
    // the real check writes the generated text and loads THAT file —
    // loadConfig throws on unknown keys, so passing IS the assertion.
    const { configPath } = writeWizardConfig(instanceDir, answers, home);
    const config = loadConfig({ GRU_COMMAND_HOME: instanceDir }, home);
    expect(config.sourceFile).toBe(configPath);
    expect(config.auth.token).toBe('keys-probe');
  });
});

describe('wizard pairing QR + repo discovery + runtime probe', () => {
  it('formatHostForUrl bracket-wraps IPv6 literals only (Perkins r1 W10)', () => {
    expect(formatHostForUrl('::')).toBe('[::]');
    expect(formatHostForUrl('fe80::1')).toBe('[fe80::1]');
    expect(formatHostForUrl('fe80::1%en0')).toBe('[fe80::1%en0]');
    expect(formatHostForUrl('[::1]')).toBe('[::1]'); // already bracketed
    expect(formatHostForUrl('127.0.0.1')).toBe('127.0.0.1');
    expect(formatHostForUrl('localhost')).toBe('localhost');
  });
  it('QR payload is byte-identical in shape to the web pairing screen', () => {
    // web/src/ui/pairing.ts builds JSON.stringify({'gru-command':1,url,token})
    expect(buildQrPayload('http://127.0.0.1:7665', 'tok')).toBe(
      '{"gru-command":1,"url":"http://127.0.0.1:7665","token":"tok"}',
    );
    expect(generateToken()).not.toBe(generateToken());
  });

  it('repo discovery: depth-1 .git scan, sorted, dot-dirs skipped, symlinked repos included', () => {
    const workspace = tempDir('gru-command-wizard-scan-');
    mkdirSync(join(workspace, 'repo-a', '.git'), { recursive: true });
    mkdirSync(join(workspace, 'repo-b'), { recursive: true });
    writeFileSync(join(workspace, 'repo-b', '.git'), 'gitdir: x\n', 'utf-8');
    mkdirSync(join(workspace, 'plain'), { recursive: true });
    mkdirSync(join(workspace, '.hidden', '.git'), { recursive: true });
    // A symlinked repo directory counts (statSync follows the link); a
    // broken symlink is skipped, not fatal.
    const realRepo = tempDir('gru-command-wizard-scan-real-');
    mkdirSync(join(realRepo, '.git'), { recursive: true });
    symlinkSync(realRepo, join(workspace, 'repo-link'));
    symlinkSync(join(workspace, 'nowhere'), join(workspace, 'broken-link'));
    expect(discoverManagedRepos(workspace)).toEqual(['repo-a', 'repo-b', 'repo-link']);
    expect(discoverManagedRepos(join(workspace, 'does-not-exist'))).toEqual([]);
  });

  it('no runtime CLIs found: probe reports absence as data (warn-and-proceed)', () => {
    const results = probeRuntimes({ path: '' }); // empty PATH: nothing resolvable
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.installed).toBe(false);
      expect(result.path).toBeNull();
    }
    // And the answers layer is unaffected — the wizard proceeds with 'pi'.
    expect(parseAnswers('{}').runtime).toBe('pi');
  });
});

describe('wizard CLI surface', () => {
  it('interactive mode without a TTY exits 2 printing the terminal recovery command (Perkins r1 B1)', () => {
    const repoRoot = join(import.meta.dirname, '..');
    // stdin: 'ignore' = not a TTY — exactly the piped one-liner's world.
    const res = spawnSync(process.execPath, [join(repoRoot, 'dist', 'wizard', 'main.js')], {
      env: { ...process.env, GRU_COMMAND_TEST_NO_TTY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    expect(res.status).toBe(2);
    const err = res.stderr?.toString('utf-8') ?? '';
    expect(err).toContain('no controlling terminal for interactive setup');
    // The recovery command names THIS checkout's install.sh — the user
    // copies it straight into a terminal.
    expect(err).toContain(`bash ${repoRoot}/install.sh`);
    expect(err).toContain('--no-interact');
  });

  it('host validation accepts every VALID IPv6 form (Perkins r2 note)', () => {
    for (const good of ['::', '::1', 'fe80::1', 'fe80::1%en0', '1:2:3:4:5:6:7:8', '::ffff:127.0.0.1']) {
      expect(parseAnswers(JSON.stringify({ host: good })).host, good).toBe(good);
    }
  });

  it('bind-host y/n tokens are rejected — they once booted a config into getaddrinfo ENOTFOUND yes', () => {
    for (const bad of ['y', 'Y', 'yes', 'YES', 'n', 'N', 'no', 'No']) {
      expect(() => validateHost(bad), bad).toThrow(/is not a bind host — enter an IP address/);
      expect(() => parseAnswers(JSON.stringify({ host: bad })), bad).toThrow(/is not a bind host/);
    }
    // The 0.0.0.0 all-interfaces answer stays valid (the health smoke
    // maps it to 127.0.0.1 for polling).
    expect(parseAnswers(JSON.stringify({ host: '0.0.0.0' })).host).toBe('0.0.0.0');
  });

  it('resolveBindHost: IP literals skip the resolver; hostnames must resolve; failures name the fix', async () => {
    let lookups = 0;
    const lookup = async (): Promise<void> => {
      lookups += 1;
    };
    for (const literal of ['127.0.0.1', '192.168.1.23', '0.0.0.0']) {
      expect(await resolveBindHost(literal, lookup), literal).toBe(literal);
    }
    expect(lookups).toBe(0); // IP literals never touch the resolver
    expect(await resolveBindHost('gru-host.test', lookup)).toBe('gru-host.test');
    expect(lookups).toBe(1); // a hostname IS resolved before acceptance

    const refusing = async (): Promise<void> => {
      throw new Error('NXDOMAIN');
    };
    await expect(resolveBindHost('nope.invalid', refusing)).rejects.toThrow(
      /bind host "nope\.invalid" does not resolve.*enter an IP address/s,
    );
    const pending = (): Promise<void> => new Promise(() => {});
    await expect(resolveBindHost('slow.invalid', pending, 20)).rejects.toThrow(/timed out/);
    await expect(resolveBindHost('yes', lookup)).rejects.toThrow(/is not a bind host/);
  });

  it('re-run seeding: existing config values become the prompt defaults; explicit answers win', () => {
    const prior = {
      workspaceRoot: '/tmp/some-workspace',
      server: { host: '192.168.1.5', port: 7700 },
      auth: { token: 'prior-token' },
      runtimes: { default: 'claude-code' },
      models: { default: 'zai-coding-cn/glm-5.3' },
      thinking: { default: 'high' },
    } as unknown as GruCommandConfig;

    // '{}' — nothing explicit: every prompted field adopts the prior value.
    const seeded = seedAnswersFromConfig(parseAnswers('{}'), prior);
    expect(seeded.workspaceRoot).toBe('/tmp/some-workspace');
    expect(seeded.runtime).toBe('claude-code');
    expect(seeded.model).toBe('zai-coding-cn/glm-5.3');
    expect(seeded.thinkingLevel).toBe('high');
    expect(seeded.host).toBe('192.168.1.5');
    expect(seeded.port).toBe(7700);
    expect(seeded.token).toBe('prior-token'); // never silently regenerated

    // Explicit answers always win — including resetting a field to the
    // documented default (the raw key marks intent).
    const reset = seedAnswersFromConfig(
      parseAnswers(JSON.stringify({ host: '127.0.0.1', token: 'fresh-token' })),
      prior,
      new Set(['host', 'token']),
    );
    expect(reset.host).toBe('127.0.0.1');
    expect(reset.token).toBe('fresh-token');
    expect(reset.port).toBe(7700); // not explicit → prior

    // No prior config → answers pass through untouched.
    const fresh = parseAnswers('{}');
    expect(seedAnswersFromConfig(fresh, null)).toBe(fresh);
  });

  it('--answers without a JSON argument exits 2 with usage', () => {
    const repoRoot = join(import.meta.dirname, '..');
    let status = 0;
    try {
      execFileSync('bash', ['-c', `node ${JSON.stringify(join(repoRoot, 'dist/wizard/main.js'))} --answers`], {
        encoding: 'utf-8',
        stdio: 'pipe',
        env: process.env,
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? 1;
    }
    expect(status).toBe(2);
  });

  it('--answers rejects secrets (token) and non-object JSON with the documented errors', () => {
    const repoRoot = join(import.meta.dirname, '..');
    const wizard = join(repoRoot, 'dist/wizard/main.js');
    const runWizard = (answers: string): { status: number; stderr: string } => {
      try {
        const out = execFileSync('bash', ['-c', `node ${JSON.stringify(wizard)} --answers ${JSON.stringify(answers)}`], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GRU_COMMAND_HOME: tempDir('gru-command-wizard-answers-') },
        });
        return { status: 0, stderr: out };
      } catch (error) {
        const err = error as { status?: number; stderr?: string | Buffer };
        return { status: err.status ?? 1, stderr: String(err.stderr ?? '') };
      }
    };
    // Secrets are forbidden on the command line (documented contract).
    const secret = runWizard('{"token":"leaky"}');
    expect(secret.status).toBe(1);
    expect(secret.stderr).toContain('secrets are forbidden in --answers: token');
    // Non-object JSON must produce the documented parse error — never a
    // raw TypeError from the round-trip key pre-parse (Perkins R1 warning).
    for (const bad of ['null', '[1,2]', '"str"']) {
      const res = runWizard(bad);
      expect(res.status, bad).toBe(1);
      expect(res.stderr, bad).toMatch(/must be a JSON object|not valid JSON/);
      expect(res.stderr, bad).not.toContain('TypeError');
    }
  });

  it('pre-flight port check: an occupied fixed port fails LOUD with stop-first guidance, nothing written (Perkins r2 H2)', async () => {
    const repoRoot2 = join(import.meta.dirname, '..');
    const instance = tempDir('gru-command-pty-h2-');
    // Hold a real port so the pre-flight sees a live listener.
    const holder = createServer();
    holder.listen(0, '127.0.0.1');
    await new Promise<void>((ready) => holder.once('listening', ready));
    const heldPort = (holder.address() as { port: number }).port;
    try {
      const res = spawnSync(
        process.execPath,
        [
          join(repoRoot2, 'dist', 'wizard', 'main.js'),
          '--answers',
          JSON.stringify({ port: heldPort, smoke: false }),
        ],
        {
          env: {
            ...process.env,
            GRU_COMMAND_HOME: instance,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      );
      const text = `${res.stdout?.toString('utf-8') ?? ''}\n${res.stderr?.toString('utf-8') ?? ''}`;
      expect(res.status, text).toBe(1);
      expect(text).toContain(`port ${heldPort} on 127.0.0.1 is already in use`);
      expect(text).toContain('--uninstall');
      // Failed BEFORE the write: no config, no half-install.
      expect(existsSync(join(instance, 'config.toml'))).toBe(false);
    } finally {
      holder.close();
    }
  });

  it('validateWorkspaceRoot rejects relative paths regardless of platform quirks', () => {
    expect(validateWorkspaceRoot('~/code')).toBe('~/code');
    expect(validateWorkspaceRoot('/somewhere/absolute')).toBe('/somewhere/absolute');
    expect(() => validateWorkspaceRoot('code')).toThrow(AnswersError);
    expect(() => validateWorkspaceRoot('./code')).toThrow(AnswersError);
    expect(() => validateWorkspaceRoot('~')).not.toThrow(); // bare ~ = home
  });
});

describe('wizard first-boot smoke — failure modes (I/O matrix)', () => {
  it('a service that never answers /health fails loud NAMING the missing signal', async () => {
    // A stub "service": prints the real 'listening' JSON line, accepts
    // TCP connections, but never serves /health — the smoke must time
    // out and name 'health_reachable' (the signal that never came).
    const stage = tempDir('gru-command-smoke-deaf-');
    mkdirSync(join(stage, 'dist'), { recursive: true });
    writeFileSync(
      join(stage, 'dist', 'main.js'),
      [
        "const { createServer } = require('node:net');",
        "const srv = createServer((s) => { s.on('data', () => {}); });",
        'srv.listen(0, () => {',
        "  process.stderr.write(JSON.stringify({ msg: 'listening', port: srv.address().port }) + '\\n');",
        '});',
      ].join('\n'),
      'utf-8',
    );
    const instanceDir = tempDir('gru-command-smoke-deaf-home-');
    await expect(
      runFirstBootSmoke({
        repoRoot: stage,
        instanceDir,
        host: '127.0.0.1',
        port: 0,
        timeoutMs: 1_500,
        token: 'wizard-test-token',
      }),
    ).rejects.toThrow(/health_reachable.*never came|never came.*health_reachable/);
  });

  it('a service that exits before listening fails loud naming the exit', async () => {
    const stage = tempDir('gru-command-smoke-die-');
    mkdirSync(join(stage, 'dist'), { recursive: true });
    writeFileSync(
      join(stage, 'dist', 'main.js'),
      "process.stderr.write('boom\\n'); process.exit(3);",
      'utf-8',
    );
    const instanceDir = tempDir('gru-command-smoke-die-home-');
    await expect(
      runFirstBootSmoke({
        repoRoot: stage,
        instanceDir,
        host: '127.0.0.1',
        port: 0,
        timeoutMs: 5_000,
        token: 'wizard-test-token',
      }),
    ).rejects.toThrow(/exited before listening \(exit code 3, signal none\)/);
  });
});
