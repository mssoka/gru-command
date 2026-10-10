import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/** Real PTY front-door coverage. BMAD provisioning/retry prompts are retired (#295). */
const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => { for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true }); });
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}
function fixtureWorkspace(): string {
  const workspace = tempDir('gru-command-pty-ws-');
  for (const repo of ['repo-a', 'repo-b']) {
    mkdirSync(join(workspace, repo));
    execFileSync('git', ['-C', join(workspace, repo), 'init', '-q']);
  }
  return workspace;
}
interface Step {
  readonly expect: string;
  readonly send: string;
}
function tclQuote(text: string): string {
  return `"${text.replace(/([$"\\[\]])/g, '\\$1')}"`;
}
function ptyWizard(steps: readonly Step[], env: NodeJS.ProcessEnv, flags: readonly string[] = []): { output: string; status: number } {
  const wizard = join(repoRoot, 'dist/wizard/main.js');
  const script = ['set timeout 45', `spawn ${tclQuote(process.execPath)} ${tclQuote(wizard)} ${flags.map(tclQuote).join(' ')}`];
  for (const step of steps) {
    script.push(`expect {\n -ex ${tclQuote(step.expect)} {}\n timeout { exit 124 }\n eof { exit 125 }\n}`);
    script.push(`send -- ${tclQuote(`${step.send}\r`)}`);
  }
  script.push('expect {\n eof {}\n timeout { exit 124 }\n}', 'lassign [wait] pid spawnid oserr code', 'exit $code');
  let output = '';
  let status = 0;
  try {
    output = execFileSync('expect', ['-c', script.join('\n')], {
      env: { ...process.env, ...env }, encoding: 'utf-8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    output = err.stdout ?? '';
    status = err.status ?? 1;
  }
  return { output: output.replace(/\r/g, ''), status };
}
function expectAvailable(): boolean {
  try { execFileSync('which', ['expect'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const WS_PROMPT = 'Workspace root (holds ONLY your managed repos)';
const REPOS_PROMPT = 'Repos to validate — comma-separated numbers or names';
const RUNTIME_PROMPT = 'Default runtime — ';
const MODEL_PROMPT = 'Model reference';
const THINKING_PROMPT = 'Thinking level';
const HOST_PROMPT = 'Bind host (IP address, e.g. 192.168.1.23';
const PORT_PROMPT = 'Bind port';
const TOKEN_PROMPT = 'Pairing token';
const REGISTER_PROMPT = 'Register the OS service';
const SMOKE_PROMPT = 'first-boot smoke test now';
const finishSteps = (smoke = 'n'): readonly Step[] => [
  { expect: RUNTIME_PROMPT, send: '' },
  { expect: MODEL_PROMPT, send: '' },
  { expect: THINKING_PROMPT, send: '' },
  { expect: HOST_PROMPT, send: '' },
  { expect: PORT_PROMPT, send: '0' },
  { expect: TOKEN_PROMPT, send: '' },
  { expect: REGISTER_PROMPT, send: 'n' },
  { expect: SMOKE_PROMPT, send: smoke },
];
const ptyPlatform = process.platform === 'darwin' || process.platform === 'linux';
const ptySkipOptOut = process.env['GRU_TEST_SKIP_PTY'] === '1';
const ptyCapable = expectAvailable() && ptyPlatform;

describe.skipIf(!ptyCapable || ptySkipOptOut)('interactive wizard under a pty (Perkins r2 T1)', () => {
  it('all-defaults happy path has no BMAD prompt or generated state and smoke is green', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-home-');
    symlinkSync(join(workspace, 'repo-a'), join(workspace, 'repo-link'));
    const { output, status } = ptyWizard([
      { expect: WS_PROMPT, send: workspace }, { expect: REPOS_PROMPT, send: '' }, ...finishSteps(''),
    ], { GRU_COMMAND_HOME: instance });
    expect(status, output).toBe(0);
    expect(output).toContain('Repositories selected for setup validation: repo-a, repo-b');
    expect(output).toContain('Linked repo entries excluded from setup validation: repo-link');
    expect(output).toContain('Smoke green');
    expect(output).toContain('Setup complete');
    expect(output).not.toContain('BMAD in ');
    expect(output).not.toContain('provision');
    for (const repo of ['repo-a', 'repo-b']) {
      expect(existsSync(join(workspace, repo, '_bmad'))).toBe(false);
      expect(existsSync(join(workspace, repo, '_bmad-output'))).toBe(false);
    }
    const config = readFileSync(join(instance, 'config.toml'), 'utf-8');
    expect(config).toContain('port = 0');
    expect(config).toContain(`workspace_root = "${workspace}"`);
  }, 90_000);

  it('an all-linked workspace can complete setup without selecting entries validation must reject', () => {
    const workspace = tempDir('gru-command-pty-only-linked-');
    const outside = fixtureWorkspace();
    symlinkSync(join(outside, 'repo-a'), join(workspace, 'repo-link'));
    const before = readFileSync(join(outside, 'repo-a', '.git/config'), 'utf-8');
    const instance = tempDir('gru-command-pty-only-linked-home-');
    const { output, status } = ptyWizard([
      { expect: WS_PROMPT, send: workspace }, ...finishSteps(),
    ], { GRU_COMMAND_HOME: instance });
    expect(status, output).toBe(0);
    expect(output).toContain('Linked repo entries excluded from setup validation: repo-link');
    expect(output).toContain('Repositories selected for setup validation: (none)');
    expect(output).not.toContain(REPOS_PROMPT);
    expect(readFileSync(join(outside, 'repo-a', '.git/config'), 'utf-8')).toBe(before);
    expect(existsSync(join(outside, 'repo-a', '_bmad'))).toBe(false);
    expect(loadConfig({ GRU_COMMAND_HOME: instance }).workspaceRoot).toBe(workspace);
  });

  it('malformed/conflicting and linked user BMAD require no provision, repair or skip step', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-independent-');
    mkdirSync(join(workspace, 'repo-a', '_bmad', 'custom'), { recursive: true });
    const settings = join(workspace, 'repo-a', '_bmad', 'custom', 'config.toml');
    writeFileSync(settings, '[broken\n');
    const external = tempDir('gru-command-pty-user-bmad-');
    symlinkSync(external, join(workspace, 'repo-b', '_bmad'));
    const { output, status } = ptyWizard([
      { expect: WS_PROMPT, send: workspace }, { expect: REPOS_PROMPT, send: '' }, ...finishSteps(),
    ], { GRU_COMMAND_HOME: instance });
    expect(status, output).toBe(0);
    expect(output).toContain('Repository ready in repo-a');
    expect(output).toContain('Repository ready in repo-b');
    expect(output).not.toContain('BMAD in ');
    expect(output).not.toContain('Skip this repo');
    expect(readFileSync(settings, 'utf-8')).toBe('[broken\n');
    expect(existsSync(join(external, 'render'))).toBe(false);
  }, 90_000);

  it('every remaining prompt loop retries on invalid input and accepts the valid answer', () => {
    const workspace = fixtureWorkspace();
    const { output, status } = ptyWizard([
      { expect: WS_PROMPT, send: 'code' }, { expect: WS_PROMPT, send: workspace },
      { expect: REPOS_PROMPT, send: 'not-a-repo' }, { expect: REPOS_PROMPT, send: '' },
      { expect: RUNTIME_PROMPT, send: 'vim' }, { expect: RUNTIME_PROMPT, send: '' },
      { expect: MODEL_PROMPT, send: '' }, { expect: THINKING_PROMPT, send: '' },
      { expect: HOST_PROMPT, send: 'not a host!' }, { expect: HOST_PROMPT, send: '' },
      { expect: PORT_PROMPT, send: '99999' }, { expect: PORT_PROMPT, send: '0' },
      { expect: TOKEN_PROMPT, send: '' }, { expect: REGISTER_PROMPT, send: 'n' }, { expect: SMOKE_PROMPT, send: 'n' },
    ], { GRU_COMMAND_HOME: tempDir('gru-command-pty-retry-') });
    expect(status, output).toBe(0);
    for (const text of ['workspace_root must be an absolute path', 'not a discovered repo', 'valid runtimes:', 'answers.host must be', 'port must be an integer', 'Setup complete']) {
      expect(output).toContain(text);
    }
  }, 90_000);

  it('managed-repo multi-pick by INDEX selects exactly that repo', () => {
    const workspace = fixtureWorkspace();
    const { output, status } = ptyWizard([
      { expect: WS_PROMPT, send: workspace }, { expect: REPOS_PROMPT, send: '1' }, ...finishSteps(),
    ], { GRU_COMMAND_HOME: tempDir('gru-command-pty-index-') });
    expect(status, output).toBe(0);
    expect(output).toContain('Repositories selected for setup validation: repo-a');
    expect(output).not.toContain('Repositories selected for setup validation: repo-a, repo-b');
  }, 90_000);

  it('managed-repo multi-pick by NAME preserves the answered order', () => {
    const workspace = fixtureWorkspace();
    const { output, status } = ptyWizard([
      { expect: WS_PROMPT, send: workspace }, { expect: REPOS_PROMPT, send: 'repo-b, repo-a' }, ...finishSteps(),
    ], { GRU_COMMAND_HOME: tempDir('gru-command-pty-name-') });
    expect(status, output).toBe(0);
    expect(output).toContain('Repositories selected for setup validation: repo-b, repo-a');
  }, 90_000);

  it('bind host rejects y/n tokens and re-prompts; 0.0.0.0 lands in the config', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-host-');
    const { output, status } = ptyWizard([
      { expect: WS_PROMPT, send: workspace }, { expect: REPOS_PROMPT, send: '' },
      ...finishSteps().slice(0, 3),
      { expect: HOST_PROMPT, send: 'yes' }, { expect: HOST_PROMPT, send: 'no' }, { expect: HOST_PROMPT, send: '0.0.0.0' },
      ...finishSteps().slice(4),
    ], { GRU_COMMAND_HOME: instance });
    expect(status, output).toBe(0);
    expect(output).toContain('is not a bind host — enter an IP address');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toContain('host = "0.0.0.0"');
  }, 90_000);

  it('bind host accepts a resolvable hostname end-to-end', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-hostname-');
    const { output, status } = ptyWizard([
      { expect: WS_PROMPT, send: workspace }, { expect: REPOS_PROMPT, send: '' },
      ...finishSteps().slice(0, 3), { expect: HOST_PROMPT, send: 'localhost' }, ...finishSteps().slice(4),
    ], { GRU_COMMAND_HOME: instance });
    expect(status, output).toBe(0);
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toContain('host = "localhost"');
  }, 90_000);

  it('repeated interactive setup retains project documents and the existing instance pairing token', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-repeat-');
    mkdirSync(join(workspace, 'repo-a', 'gru-output'));
    const document = join(workspace, 'repo-a', 'gru-output', 'spec.md');
    writeFileSync(document, '# portable knowledge\n');
    const steps = [{ expect: WS_PROMPT, send: workspace }, { expect: REPOS_PROMPT, send: '' }, ...finishSteps()];
    const first = ptyWizard(steps, { GRU_COMMAND_HOME: instance });
    expect(first.status, first.output).toBe(0);
    const before = loadConfig({ GRU_COMMAND_HOME: instance });
    const second = ptyWizard(steps, { GRU_COMMAND_HOME: instance }, ['--force']);
    expect(second.status, second.output).toBe(0);
    expect(second.output).toContain('Existing config found');
    expect(loadConfig({ GRU_COMMAND_HOME: instance })).toEqual(before);
    expect(readFileSync(document, 'utf-8')).toBe('# portable knowledge\n');
  }, 90_000);
});

describe('pty gate (W-A — no silent PTY skips)', () => {
  it('expect(1) is present on pty platforms, or the run explicitly opts out', () => {
    if (!ptyPlatform || ptySkipOptOut) return;
    expect(expectAvailable(), 'expect(1) is missing — install expect or set GRU_TEST_SKIP_PTY=1 to opt out explicitly.').toBe(true);
  });
});
