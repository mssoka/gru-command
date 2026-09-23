import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type GruCommandConfig } from '../src/config.js';
import {
  dialHost,
  parseServiceArgs,
  runServiceCli,
  serviceBaseUrl,
  type ServiceCliDeps,
} from '../src/cli/service.js';
import type { RollState } from '../src/roll/state.js';

/**
 * `gru-service roll`: argument contract, service URL resolution, and the
 * follow loop — accepted → phase transitions → done → /health build-sha
 * verification. Exit 0 means the relaunched service really reports the
 * target build; every ambiguity (refused, failed, unreachable, unverified
 * timeout) is non-zero.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempConfig(): GruCommandConfig {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-roll-cli-'));
  cleanupDirs.push(dir);
  writeFileSync(
    join(dir, 'config.toml'),
    '[server]\nhost = "0.0.0.0"\nport = 7665\n[auth]\ntoken = "cli-test-token"\n',
    'utf-8',
  );
  return loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
}

function rollState(phase: RollState['phase'], toSha = 'b'.repeat(40)): RollState {
  return {
    schemaVersion: 1,
    rollId: 'roll-cli-1',
    phase,
    reason: null,
    requestedBy: 'gru-service-cli',
    repoRoot: '/fixture/deploy',
    fromSha: 'a'.repeat(40),
    toSha,
    startedAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    preflight: null,
    drain: null,
    error: null,
    verify: null,
  };
}

function doneStateWithPid(pid: number): RollState {
  return {
    ...rollState('done'),
    verify: { at: '2026-09-23T00:01:00.000Z', sha: 'b'.repeat(40), pid, uptimeMs: 1_000 },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface CliHarness {
  readonly deps: ServiceCliDeps;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly requests: string[];
  readonly clock: { now: number };
}

async function harness(script: {
  post: Response | 'unreachable';
  polls?: readonly (Response | 'unreachable')[];
  health?: Response | 'unreachable';
  /** Listener owners the probe reports (owner incident 2026-09-23). */
  listeners?: readonly { pid: number; command: string }[] | null;
}): Promise<CliHarness> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: string[] = [];
  const clock = { now: 1_000_000 };
  let pollIndex = 0;
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/api/roll') && requests.filter((r) => r.endsWith('/api/roll')).length === 1) {
      if (script.post === 'unreachable') throw new Error('connect ECONNREFUSED');
      return script.post.clone();
    }
    if (url.endsWith('/health')) {
      if (script.health === 'unreachable') throw new Error('connect ECONNREFUSED');
      return (script.health ?? jsonResponse(200, {})).clone();
    }
    const next = script.polls?.[Math.min(pollIndex, (script.polls?.length ?? 1) - 1)];
    pollIndex += 1;
    if (next === 'unreachable') throw new Error('connect ECONNREFUSED');
    return (next ?? jsonResponse(200, { roll: null })).clone();
  };
  return {
    deps: {
      loadConfig: tempConfig,
      fetchFn,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      sleep: async (ms) => { clock.now += ms; },
      now: () => clock.now,
      probeListeners: async () => script.listeners ?? [],
    },
    stdout,
    stderr,
    requests,
    clock,
  };
}

describe('gru-service roll argument contract', () => {
  it('rejects a missing command and unknown commands with usage', () => {
    const missing = parseServiceArgs([]);
    expect(missing.ok).toBe(false);
    const unknown = parseServiceArgs(['restart']);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain('unknown command');
  });

  it('parses roll flags, including the wait/JSON/reason/timeout forms', () => {
    const parsed = parseServiceArgs(['roll', '--no-wait', '--json', '--reason', 'config edit', '--timeout-ms', '5000']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.options).toEqual({
        action: 'roll',
        wait: false,
        json: true,
        reason: 'config edit',
        timeoutMs: 5_000,
      });
    }
  });

  it('rejects bad flag values and unknown flags', () => {
    expect(parseServiceArgs(['roll', '--timeout-ms', '10']).ok).toBe(false);
    expect(parseServiceArgs(['roll', '--timeout-ms', 'soon']).ok).toBe(false);
    expect(parseServiceArgs(['roll', '--reason']).ok).toBe(false);
    expect(parseServiceArgs(['roll', '--frobnicate']).ok).toBe(false);
  });

  it('--help is a clean exit; a bare invocation is usage+error', () => {
    const help = parseServiceArgs(['--help']);
    expect(help.ok).toBe(false);
    if (!help.ok) expect(help.help && help.error === '').toBe(true);
    const bare = parseServiceArgs([]);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error).not.toBe('');
  });
});

describe('gru-service roll target resolution', () => {
  it('dials loopback for wildcard binds and brackets IPv6 hosts', () => {
    expect(dialHost('0.0.0.0')).toBe('127.0.0.1');
    expect(dialHost('127.0.0.1')).toBe('127.0.0.1');
    expect(dialHost('::')).toBe('[::1]');
    expect(dialHost('::1')).toBe('[::1]');
    expect(dialHost('192.168.1.20')).toBe('192.168.1.20');
  });

  it('builds the service URL from the instance config', () => {
    const config = tempConfig();
    expect(serviceBaseUrl(config)).toBe('http://127.0.0.1:7665');
  });
});

describe('gru-service roll follow loop', () => {
  it('exits 0 only after /health reports the target build sha', async () => {
    const h = await harness({
      post: jsonResponse(202, { status: 'accepted', roll: rollState('preflight') }),
      polls: [
        jsonResponse(200, { roll: rollState('drain') }),
        jsonResponse(200, { roll: rollState('swap') }),
        jsonResponse(200, { roll: rollState('done') }),
      ],
      health: jsonResponse(200, { build: { rev: 'b'.repeat(40) } }),
    });
    const code = await runServiceCli(['roll'], h.deps);
    expect(code).toBe(0);
    expect(h.stdout.join('\n')).toContain(`rolled ${'a'.repeat(40)} → ${'b'.repeat(40)} (verified on /health)`);
    expect(h.stderr).toEqual([]);
  });

  it('--no-wait returns right after the 202 acceptance', async () => {
    const h = await harness({
      post: jsonResponse(202, { status: 'accepted', roll: rollState('preflight') }),
    });
    const code = await runServiceCli(['roll', '--no-wait'], h.deps);
    expect(code).toBe(0);
    expect(h.requests).toHaveLength(1);
  });

  it('attaches to a roll already in progress (409) and still verifies it', async () => {
    const h = await harness({
      post: jsonResponse(409, { error: 'roll_in_progress', roll: rollState('drain') }),
      polls: [jsonResponse(200, { roll: rollState('done') })],
      health: jsonResponse(200, { build: { rev: 'b'.repeat(40) } }),
    });
    const code = await runServiceCli(['roll'], h.deps);
    expect(code).toBe(0);
    expect(h.stdout.join('\n')).toContain('attaching');
  });

  it('a failed roll record exits 1 with the recorded detail', async () => {
    const failed = { ...rollState('failed'), error: { phase: 'preflight' as const, detail: 'npm ci failed' } };
    const h = await harness({
      post: jsonResponse(202, { status: 'accepted', roll: rollState('preflight') }),
      polls: [jsonResponse(200, { roll: failed })],
    });
    const code = await runServiceCli(['roll'], h.deps);
    expect(code).toBe(1);
    expect(h.stdout.join('\n')).toContain('npm ci failed');
  });

  it('an unreachable service refuses instead of pretending', async () => {
    const h = await harness({ post: 'unreachable' });
    const code = await runServiceCli(['roll'], h.deps);
    expect(code).toBe(1);
    expect(h.stderr.join('\n')).toContain('service unreachable');
  });

  it('a done record whose /health sha never matches times out non-zero with the bail hint', async () => {
    const h = await harness({
      post: jsonResponse(202, { status: 'accepted', roll: rollState('preflight') }),
      polls: [jsonResponse(200, { roll: rollState('done') })],
      health: jsonResponse(200, { build: { rev: 'c'.repeat(40) } }),
    });
    const code = await runServiceCli(['roll'], h.deps);
    expect(code).toBe(1);
    expect(h.stderr.join('\n')).toContain('does not report the target build');
    expect(h.stderr.join('\n')).toContain('bail:');
  });

  it('REFUSES a foreign listener answering /health even when the build sha matches (pid evidence, not a 200)', async () => {
    const h = await harness({
      post: jsonResponse(202, { status: 'accepted', roll: rollState('preflight') }),
      polls: [jsonResponse(200, { roll: doneStateWithPid(42_424) })],
      health: jsonResponse(200, { build: { rev: 'b'.repeat(40) } }),
      listeners: [{ pid: 999, command: 'node /fixture/worktree/dist/main.js' }],
    });
    const code = await runServiceCli(['roll'], h.deps);
    expect(code).toBe(1);
    expect(h.stdout.join('\n')).not.toContain('verified on /health');
    expect(h.stderr.join('\n')).toContain('is pid 999');
    expect(h.stderr.join('\n')).toContain('foreign listener answered');
    expect(h.stderr.join('\n')).toContain('Action required');
  });

  it('verifies when the port listener IS the adopted process', async () => {
    const h = await harness({
      post: jsonResponse(202, { status: 'accepted', roll: rollState('preflight') }),
      polls: [jsonResponse(200, { roll: doneStateWithPid(42_424) })],
      health: jsonResponse(200, { build: { rev: 'b'.repeat(40) } }),
      listeners: [{ pid: 42_424, command: 'node dist/main.js' }],
    });
    const code = await runServiceCli(['roll'], h.deps);
    expect(code).toBe(0);
    expect(h.stdout.join('\n')).toContain(`rolled ${'a'.repeat(40)} → ${'b'.repeat(40)} (verified on /health)`);
    expect(h.stderr).toEqual([]);
  });

  it('a swap that never returns times out with the last phase named', async () => {
    const h = await harness({
      post: jsonResponse(202, { status: 'accepted', roll: rollState('preflight') }),
      polls: ['unreachable'],
    });
    const code = await runServiceCli(['roll', '--timeout-ms', '10000'], h.deps);
    expect(code).toBe(1);
    expect(h.stderr.join('\n')).toContain('did not complete within 10000 ms');
  });
});
