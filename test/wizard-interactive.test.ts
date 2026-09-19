import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Interactive wizard under a REAL PTY (Perkins r2 T1): the documented
 * front door (post-B1 the two-step runs the wizard interactively) is
 * driven end-to-end with expect(1) — each answer is sent only after its
 * prompt appears, exactly like a user. Covers: the all-defaults happy
 * path (with the real first-boot smoke), one invalid-then-valid retry
 * per prompt loop, and the managed-repo multi-pick by index AND by name.
 */

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function fixtureWorkspace(): string {
  const workspace = tempDir('gru-command-pty-ws-');
  for (const repo of ['repo-a', 'repo-b']) {
    mkdirSync(join(workspace, repo, '.git'), { recursive: true });
  }
  return workspace;
}

interface Step {
  /** Prompt anchor: wait for this exact text before answering. */
  readonly expect: string;
  /** The line to send (without CR). */
  readonly send: string;
}

/** Tcl-double-quote escape: our inputs are tame, but be strict anyway. */
function tclQuote(text: string): string {
  return `"${text.replace(/([$"\\[\]])/g, '\\$1')}"`;
}

/**
 * Drive the wizard under a pty via expect(1): spawn node, wait for each
 * prompt anchor, send its answer, then wait for EOF. Returns the full
 * transcript (CR stripped) + exit status.
 */
function ptyWizard(
  steps: readonly Step[],
  env: NodeJS.ProcessEnv,
): { output: string; status: number } {
  const wizard = join(repoRoot, 'dist', 'wizard', 'main.js');
  const script: string[] = ['set timeout 90', `spawn ${process.execPath} ${wizard}`];
  for (const step of steps) {
    // Prompt anchors are matched EXACTLY (braces = literal, no glob).
    script.push(`expect -ex {${step.expect}}`);
    // The CR must live INSIDE the quoted string — outside it becomes a
    // second argument and send errors out (wrong # args).
    script.push(`send -- ${tclQuote(`${step.send}\r`)}`);
  }
  script.push('expect eof');
  let out = '';
  let status = 0;
  try {
    out = execFileSync('expect', ['-c', script.join('\n')], {
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      timeout: 110_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    out = err.stdout ?? '';
    status = err.status ?? 1;
  }
  return { output: out.replace(/\r/g, ''), status };
}

function expectAvailable(): boolean {
  try {
    execFileSync('which', ['expect'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const WS_PROMPT = 'Workspace root (holds ONLY your managed repos)';
const REPOS_PROMPT = 'Managed repos — comma-separated numbers or names';
const RUNTIME_PROMPT = 'Default runtime — ';
const MODEL_PROMPT = 'Model reference';
const THINKING_PROMPT = 'Thinking level';
const HOST_PROMPT = 'Bind host';
const PORT_PROMPT = 'Bind port';
const TOKEN_PROMPT = 'Pairing token';
const REGISTER_PROMPT = 'Register the OS service';
const SMOKE_PROMPT = 'first-boot smoke test now';

const ptyCapable = expectAvailable() && (process.platform === 'darwin' || process.platform === 'linux');

describe.skipIf(!ptyCapable)('interactive wizard under a pty (Perkins r2 T1)', () => {
  it('all-defaults happy path: prompts answered, config written, smoke green', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-home-');
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '' }, // default = all found
        { expect: RUNTIME_PROMPT, send: '' }, // default runtime
        { expect: MODEL_PROMPT, send: '' }, // "default" sentinel
        { expect: THINKING_PROMPT, send: '' }, // "default" sentinel
        { expect: HOST_PROMPT, send: '' }, // 127.0.0.1
        { expect: PORT_PROMPT, send: '0' }, // ephemeral: smoke-safe on a busy machine
        { expect: TOKEN_PROMPT, send: '' }, // generated
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: '' }, // yes (default) — real smoke
      ],
      { GRU_COMMAND_HOME: instance },
    );
    expect(status, output).toBe(0);
    expect(output).toContain('Repos under the workspace root:');
    expect(output).toContain('1. repo-a');
    expect(output).toContain('2. repo-b');
    expect(output).toContain('Managed repos (board grouping): repo-a, repo-b');
    expect(output).toContain('Smoke green');
    expect(output).toContain('Setup complete');
    const config = readFileSync(join(instance, 'config.toml'), 'utf-8');
    expect(config).toContain('port = 0');
    expect(config).toContain(`workspace_root = "${workspace}"`);
  }, 120_000);

  it('every prompt loop retries on invalid input, then accepts the valid answer', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-home2-');
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: 'code' }, // ✗ relative
        { expect: WS_PROMPT, send: workspace }, // retried, valid
        { expect: REPOS_PROMPT, send: '' },
        { expect: RUNTIME_PROMPT, send: 'vim' }, // ✗ unknown runtime
        { expect: RUNTIME_PROMPT, send: '' }, // retried, default
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: 'not a host!' }, // ✗ invalid host (H1 loop)
        { expect: HOST_PROMPT, send: '' }, // retried, default
        { expect: PORT_PROMPT, send: '99999' }, // ✗ out of range
        { expect: PORT_PROMPT, send: '0' }, // retried, ephemeral
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' }, // this leg is about the prompts
      ],
      { GRU_COMMAND_HOME: instance },
    );
    expect(status, output).toBe(0);
    // Every retry loop showed its ✗ and accepted the correction — no
    // all-answers-lost abort at the end (the H1 class).
    expect(output).toContain('workspace_root must be an absolute path');
    expect(output).toContain('valid runtimes:');
    expect(output).toContain('answers.host must be an IPv4/IPv6 literal or a hostname');
    expect(output).toContain('port must be an integer');
    expect(output).toContain('Setup complete');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toContain('port = 0');
  }, 120_000);

  it('managed-repo multi-pick by INDEX selects exactly that repo', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-home3-');
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '1' }, // by index → repo-a
        { expect: RUNTIME_PROMPT, send: '' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: '' },
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
      ],
      { GRU_COMMAND_HOME: instance },
    );
    expect(status, output).toBe(0);
    expect(output).toContain('Managed repos (board grouping): repo-a');
    expect(output).not.toContain('board grouping): repo-a, repo-b');
  }, 120_000);

  it('managed-repo multi-pick by NAME (comma-separated) selects exactly those repos', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-home4-');
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: 'repo-b, repo-a' }, // by name, comma-separated
        { expect: RUNTIME_PROMPT, send: '' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: '' },
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
      ],
      { GRU_COMMAND_HOME: instance },
    );
    expect(status, output).toBe(0);
    // The grouping line preserves the ANSWERED order (the discovery list
    // is sorted; the pick is the user's sequence).
    expect(output).toContain('Managed repos (board grouping): repo-b, repo-a');
  }, 120_000);
});
