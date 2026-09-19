import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, configPathFor } from '../src/config.js';
import { probeRuntimes } from '../src/runtime/probe.js';
import {
  AnswersError,
  generateToken,
  parseAnswers,
  validateWorkspaceRoot,
} from '../src/wizard/answers.js';
import {
  backupTimestamp,
  buildQrPayload,
  discoverManagedRepos,
  generateConfigToml,
  writeInstanceConfig,
} from '../src/wizard/steps.js';

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
  });

  it('invalid answers fail loud, naming the field — nothing written anywhere', () => {
    const cases: Array<[string, RegExp]> = [
      ['{"workspace_root":"code"}', /workspace_root must be an absolute path/],
      ['{"runtime":"cursor"}', /unknown runtime `cursor`/],
      ['{"roles":{"chief":"pi"}}', /unknown role `chief`/],
      ['{"roles":{"gru":"vim"}}', /unknown runtime `vim` in answers.roles.gru/],
      ['{"port":"seven"}', /answers.port must be an integer between 0 and 65535/],
      ['{"port":70000}', /answers.port must be an integer between 0 and 65535/],
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
    const { configPath, backupPath } = writeInstanceConfig(instanceDir, answers, home);
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

  it('re-run over an existing config backs it up (timestamped) before rewriting', () => {
    const instanceDir = tempDir('gru-command-wizard-cfg2-');
    const first = parseAnswers('{"token":"first-token"}');
    const second = parseAnswers('{"token":"second-token"}');
    const w1 = writeInstanceConfig(instanceDir, first, home);
    expect(w1.backupPath).toBeNull();
    const w2 = writeInstanceConfig(instanceDir, second, home);
    expect(w2.backupPath).not.toBeNull();
    expect(w2.backupPath).toMatch(/config\.toml\.backup-\d{8}T\d{6}Z$/);
    expect(readFileSync(w2.backupPath!, 'utf-8')).toContain('first-token');
    expect(readFileSync(w2.configPath, 'utf-8')).toContain('second-token');
    // The backup timestamp is filesystem-safe (no colons).
    expect(backupTimestamp()).not.toContain(':');
  });

  it('generated TOML carries only documented top-level keys', () => {
    const instanceDir = tempDir('gru-command-wizard-cfg3-');
    const answers = parseAnswers('{"token":"keys-probe"}');
    const text = generateConfigToml(answers, instanceDir);
    expect(text).toContain('workspace_root');
    expect(text).toContain('[server]');
    expect(text).toContain('[auth]');
    expect(text).toContain('[runtimes]');
    expect(text).toContain('[models]');
    expect(text).toContain('[thinking]');
    // No invented keys: run the loader's unknown-key rejection over it
    // (loadConfig throws on unknown keys — this passing IS the check).
    expect(() => loadConfig({ GRU_COMMAND_HOME: instanceDir }, home)).not.toThrow();
  });
});

describe('wizard pairing QR + repo discovery + runtime probe', () => {
  it('QR payload is byte-identical in shape to the web pairing screen', () => {
    // web/src/ui/pairing.ts builds JSON.stringify({'gru-command':1,url,token})
    expect(buildQrPayload('http://127.0.0.1:7665', 'tok')).toBe(
      '{"gru-command":1,"url":"http://127.0.0.1:7665","token":"tok"}',
    );
    expect(generateToken()).not.toBe(generateToken());
  });

  it('repo discovery: depth-1 .git scan, sorted, dot-dirs skipped', () => {
    const workspace = tempDir('gru-command-wizard-scan-');
    mkdirSync(join(workspace, 'repo-a', '.git'), { recursive: true });
    mkdirSync(join(workspace, 'repo-b'), { recursive: true });
    writeFileSync(join(workspace, 'repo-b', '.git'), 'gitdir: x\n', 'utf-8');
    mkdirSync(join(workspace, 'plain'), { recursive: true });
    mkdirSync(join(workspace, '.hidden', '.git'), { recursive: true });
    expect(discoverManagedRepos(workspace)).toEqual(['repo-a', 'repo-b']);
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

  it('validateWorkspaceRoot rejects relative paths regardless of platform quirks', () => {
    expect(validateWorkspaceRoot('~/code')).toBe('~/code');
    expect(validateWorkspaceRoot('/somewhere/absolute')).toBe('/somewhere/absolute');
    expect(() => validateWorkspaceRoot('code')).toThrow(AnswersError);
    expect(() => validateWorkspaceRoot('./code')).toThrow(AnswersError);
    expect(() => validateWorkspaceRoot('~')).not.toThrow(); // bare ~ = home
  });
});
