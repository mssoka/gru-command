import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const CLI = join(process.cwd(), 'dist', 'decisions', 'cli.js');
const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

function home(): { root: string; instance: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'gru-decisions-cli-'));
  cleanup.push(root);
  const instance = join(root, '.gru-command');
  return {
    root,
    instance,
    env: {
      ...process.env,
      HOME: root,
      GRU_COMMAND_HOME: instance,
      OPENROUTER_API_KEY: undefined,
    },
  };
}

function run(args: readonly string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env,
    input,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

describe('compiled decisions CLI seam', () => {
  it('emits the complete default-off fragment and --enabled changes only that flag', () => {
    const h = home();
    const off = run(['config-template'], h.env);
    const on = run(['config-template', '--enabled', 'true'], h.env);
    expect(off.status).toBe(0);
    expect(off.stdout).toContain('[decisions.jev]');
    expect(off.stdout).toContain('[decisions.thresholds.destructive]');
    expect(off.stdout).toContain('require_confirm_on_act = true');
    expect(off.stdout).toContain('enabled = false');
    expect(on.stdout).toBe(off.stdout.replace('enabled = false', 'enabled = true'));
  });

  it('stores one stdin-only key atomically, never echoes it, and resolves it after a fresh process restart', () => {
    const h = home();
    const key = 'test-openrouter-secret-value';
    const set = run(['credentials', 'set', '--stdin'], h.env, `${key}\n`);
    expect(set.status).toBe(0);
    expect(set.stdout).toBe('{"ok":true}\n');
    expect(`${set.stdout}${set.stderr}`).not.toContain(key);
    const path = join(h.instance, 'credentials', 'openrouter.key');
    expect(readFileSync(path, 'utf8')).toBe(key);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);

    const first = run(['status', '--json'], h.env);
    const restarted = run(['status', '--json'], h.env);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      enabled: false,
      credential_present: true,
      credential_source: 'file',
      credential_state: 'present',
    });
    expect(restarted.stdout).toBe(first.stdout);
    expect(restarted.stdout).not.toContain(key);
  });

  it('disabled check is successful/offline; enabled missing-key is sanitized degraded/nonzero', () => {
    const disabled = home();
    const off = run(['check', '--json'], disabled.env);
    expect(off.status).toBe(0);
    expect(JSON.parse(off.stdout)).toEqual({ ok: true, status: 'disabled', reason: null });

    const enabled = home();
    writeFileSync(join(enabled.root, 'placeholder'), 'x');
    // config parent is created explicitly; no credential is provisioned.
    const mkdir = spawnSync('mkdir', ['-p', enabled.instance]);
    expect(mkdir.status).toBe(0);
    writeFileSync(join(enabled.instance, 'config.toml'), '[decisions.jev]\nenabled = true\n');
    const degraded = run(['check', '--json'], enabled.env);
    expect(degraded.status).toBe(1);
    expect(JSON.parse(degraded.stdout)).toEqual({ ok: false, status: 'degraded', reason: 'credential_missing' });
    expect(degraded.stderr).toBe('');
  });

  it('rejects literal-key argv and embedded newlines without leaking input', () => {
    const h = home();
    const secret = 'do-not-echo-this';
    const argv = run(['credentials', 'set', secret], h.env);
    expect(argv.status).toBe(2);
    expect(`${argv.stdout}${argv.stderr}`).not.toContain(secret);
    const multiline = run(['credentials', 'set', '--stdin'], h.env, `${secret}\nsecond\n`);
    expect(multiline.status).toBe(1);
    expect(`${multiline.stdout}${multiline.stderr}`).not.toContain(secret);
  });
});
