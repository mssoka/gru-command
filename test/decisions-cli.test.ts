import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(`${argv.stdout}${argv.stderr}`).not.toContain(secret);
    expect(`${multiline.stdout}${multiline.stderr}`).not.toContain(secret);
  });

  // Issue #222 — provider profiles through the compiled CLI seam.
  describe('provider profiles (issue #222)', () => {

    it('check --profile probes a keyless loopback systemone profile end to end', async () => {
      const h = home();
      mkdirSync(h.instance, { recursive: true });
      writeFileSync(join(h.instance, 'config.toml'), [
        '[decisions.jev]',
        'enabled = true',
        '[decisions.providers.local]',
        'protocol = "systemone"',
        'endpoint = "http://127.0.0.1:8088/v1/systemone"',
        'model = "laya-test"',
        'credential = "none"',
        'timeout_ms = 2000',
      ].join('\n'));
      // This sandbox refuses a spawned child's connection to its parent's
      // loopback listener, so the compiled child carries the repo's fetch
      // double via --import (the service-integration technique); the log
      // proves the request reached the loopback URL with no credentials.
      const logFile = join(h.instance, 'jev-fetch.jsonl');
      const env = {
        ...h.env,
        NODE_OPTIONS: `--import ${join(import.meta.dirname, 'helpers', 'jev-fetch-double.mjs')}`,
        JEV_FETCH_LOG: logFile,
      };
      const probe = run(['check', '--profile', 'local', '--json'], env);
      expect(probe.status).toBe(0);
      expect(JSON.parse(probe.stdout)).toEqual({
        ok: true,
        status: 'ready',
        reason: null,
        profile: 'local',
      });
      const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toEqual([
        expect.objectContaining({
          url: 'http://127.0.0.1:8088/v1/systemone',
          authorizationPresent: false,
        }),
      ]);
      // Human-readable form of the same probe.
      const plain = run(['check', '--profile', 'local'], env);
      expect(plain.status).toBe(0);
      expect(plain.stdout).toContain('local: ready');
    });

    it('check --profile names an unknown profile loudly, reports a missing slot credential, and keeps the disabled default shape', () => {
      const h = home();
      mkdirSync(h.instance, { recursive: true });
      writeFileSync(join(h.instance, 'config.toml'), '[decisions.jev]\nenabled = true\n');
      const unknown = run(['check', '--profile', 'nonexistent', '--json'], h.env);
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain('unknown decision profile');
      const missing = run(['check', '--profile', 'typesafe-direct', '--json'], h.env);
      expect(missing.status).toBe(1);
      expect(JSON.parse(missing.stdout)).toEqual({
        ok: false,
        status: 'degraded',
        reason: 'credential_missing',
        profile: 'typesafe-direct',
      });
      // Master off: the disabled answer keeps its exact legacy shape.
      const off = home();
      mkdirSync(off.instance, { recursive: true });
      writeFileSync(join(off.instance, 'config.toml'), '[decisions.jev]\nenabled = false\n');
      const disabled = run(['check', '--json'], off.env);
      expect(disabled.status).toBe(0);
      expect(JSON.parse(disabled.stdout)).toEqual({ ok: true, status: 'disabled', reason: null });
    });

    it('status lists every effective profile sanitised, and per-slot credentials resolve across restarts', () => {
      const h = home();
      const typesafeKey = 'test-typesafe-secret-value';
      const set = run(['credentials', 'set', '--slot', 'typesafe', '--stdin'], h.env, `${typesafeKey}\n`);
      expect(set.status).toBe(0);
      expect(set.stdout).toBe('{"ok":true}\n');
      const path = join(h.instance, 'credentials', 'typesafe.key');
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe(typesafeKey);

      const status = run(['status', '--json'], h.env);
      expect(status.status).toBe(0);
      const parsed = JSON.parse(status.stdout) as {
        profiles: { name: string; protocol: string; endpoint: string; model: string; credential: string; credential_state: string; credential_source: string }[];
      };
      expect(status.stdout).not.toContain(typesafeKey);
      expect(parsed.profiles.map((profile) => profile.name).sort()).toEqual(['local', 'openrouter-jev', 'typesafe-direct']);
      const typesafe = parsed.profiles.find((profile) => profile.name === 'typesafe-direct');
      expect(typesafe).toMatchObject({
        protocol: 'systemone',
        endpoint: 'https://api.typesafe.ai/v1/systemone',
        credential: 'typesafe',
        credential_state: 'present',
        credential_source: 'file',
      });
      const local = parsed.profiles.find((profile) => profile.name === 'local');
      expect(local).toMatchObject({ credential: 'none', credential_state: 'present', credential_source: 'none' });
      const openrouter = parsed.profiles.find((profile) => profile.name === 'openrouter-jev');
      expect(openrouter).toMatchObject({ credential: 'openrouter', credential_state: 'absent', credential_source: 'none' });
      // A fresh process resolves the same state (restart parity).
      expect(run(['status', '--json'], h.env).stdout).toBe(status.stdout);
    });

    it('credentials set --slot rejects unknown slots without leaking input', () => {
      const h = home();
      const secret = 'slot-leak-canary';
      const bad = run(['credentials', 'set', '--slot', 'custom-slot', '--stdin'], h.env, `${secret}\n`);
      expect(bad.status).toBe(2);
      expect(bad.stderr).toContain('unknown credential slot');
      expect(`${bad.stdout}${bad.stderr}`).not.toContain(secret);
    });
  });
});
