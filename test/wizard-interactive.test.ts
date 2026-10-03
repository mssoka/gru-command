import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
      env: {
        ...process.env,
        ...env,
      },
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
const BMAD_A_PROMPT = 'BMAD in repo-a';
const BMAD_B_PROMPT = 'BMAD in repo-b';
const RUNTIME_PROMPT = 'Default runtime — ';
const MODEL_PROMPT = 'Model reference';
const THINKING_PROMPT = 'Thinking level';
const HOST_PROMPT = 'Bind host (IP address, e.g. 192.168.1.23';
const PORT_PROMPT = 'Bind port';
const TOKEN_PROMPT = 'Pairing token';
const REGISTER_PROMPT = 'Register the OS service';
const SMOKE_PROMPT = 'first-boot smoke test now';

const ptyPlatform = process.platform === 'darwin' || process.platform === 'linux';
const ptySkipOptOut = process.env['GRU_TEST_SKIP_PTY'] === '1';
const ptyCapable = expectAvailable() && ptyPlatform;

describe.skipIf(!ptyCapable || ptySkipOptOut)('interactive wizard under a pty (Perkins r2 T1)', () => {
  it('all-defaults happy path: prompts answered, config written, smoke green', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-home-');
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '' }, // default = all found
        { expect: BMAD_A_PROMPT, send: 'n' },
        { expect: BMAD_B_PROMPT, send: 'n' },
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
    expect(output).toContain('Selected repos for BMAD onboarding: repo-a, repo-b');
    expect(output).toContain('Smoke green');
    expect(output).toContain('Setup complete');
    const config = readFileSync(join(instance, 'config.toml'), 'utf-8');
    expect(config).toContain('port = 0');
    expect(config).toContain(`workspace_root = "${workspace}"`);
  }, 120_000);

  it('Enter accepts the default-on fresh BMAD action and reaches ready state', () => {
    const workspace = fixtureWorkspace();
    execFileSync('git', ['-C', join(workspace, 'repo-a'), 'init', '-q']);
    const instance = tempDir('gru-command-pty-bmad-default-');
    const bin = tempDir('gru-command-pty-bmad-bin-');
    writeFileSync(join(bin, 'uv'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    writeFileSync(
      join(bin, 'npx'),
      [
        '#!/usr/bin/env node',
        "const { mkdirSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "if (process.argv.includes('--version')) { console.log('10.0.0'); process.exit(0); }",
        "const root = process.cwd();",
        "const manifest = ['installation:', '  version: 6.12.0', 'modules:', '  - name: core', '    version: 6.12.0', '  - name: bmm', '    version: 6.12.0', '  - name: cis', '    version: v0.3.2', '  - name: tea', '    version: v1.27.2', '  - name: gds', '    version: v0.7.2', 'ides:', '  - pi', ''].join('\\n');",
        "for (const module of ['core','bmm','cis','tea','gds']) { mkdirSync(join(root, '_bmad', module), { recursive: true }); writeFileSync(join(root, '_bmad', module, 'marker.txt'), module + '\\n'); }",
        "mkdirSync(join(root, '_bmad', '_config'), { recursive: true }); writeFileSync(join(root, '_bmad', '_config', 'manifest.yaml'), manifest);",
        "for (const skill of ['bmad-build','bmad-help','gds-quick-dev']) { const dir=join(root,'.agents','skills',skill); mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,'SKILL.md'),'# skill\\n'); writeFileSync(join(dir,'workflow.md'),'{{.implementation_artifacts}}\\n'); }",
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '1' },
        { expect: BMAD_A_PROMPT, send: '' },
        // The runtime answer is explicit, not Enter: this test's fixture
        // installer binds ONLY Pi (`ides: [pi]`), so the host-probe default
        // (first installed runtime, claude-code when pi is absent) must
        // not decide it. Enter at BMAD_A stays — that default is the
        // behavior under test here; the all-defaults coverage lives in
        // the separate test above.
        { expect: RUNTIME_PROMPT, send: 'pi' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: '' },
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
      ],
      {
        GRU_COMMAND_HOME: instance,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
      },
    );
    expect(status, output).toBe(0);
    expect(output).toContain('  repo-a: install');
    expect(output).toContain('BMAD ready in repo-a');
    expect(existsSync(join(workspace, 'repo-a', '.gru-command', 'bmad-install.json'))).toBe(true);
  }, 120_000);

  it('deterministic BMAD failure offers skip-only with the deliberate-fix path; Enter skips and setup completes (gh-32)', () => {
    const workspace = tempDir('gru-command-pty-det-ws-');
    const repoA = join(workspace, 'repo-a');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoA });
    // Broken existing install: the manifest declares core, whose directory
    // is missing — the exact gh-32 field report. Retry re-checks the same
    // unchanged bytes, so the wizard must offer skip-only, never retry.
    mkdirSync(join(repoA, '_bmad', '_config'), { recursive: true });
    writeFileSync(
      join(repoA, '_bmad', '_config', 'manifest.yaml'),
      'installation:\n  version: 6.12.0\nmodules:\n  - name: core\n    version: 6.12.0\nides:\n  - pi\n',
    );
    const instance = tempDir('gru-command-pty-det-home-');
    const bin = tempDir('gru-command-pty-det-bin-');
    writeFileSync(join(bin, 'uv'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '1' },
        { expect: BMAD_A_PROMPT, send: 'reuse' },
        { expect: RUNTIME_PROMPT, send: 'pi' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: '' },
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
        { expect: 'Skip this repo? [skip]:', send: 'retry' }, // rejected: retry cannot fix it
        { expect: 'Skip this repo? [skip]:', send: '' }, // Enter = skip
      ],
      { GRU_COMMAND_HOME: instance, PATH: `${bin}:${process.env.PATH ?? ''}` },
    );
    expect(status, output).toBe(0);
    expect(output).toContain('deterministic — retrying cannot fix it');
    expect(output).toContain('BMAD manifest declares missing or unsafe module directory');
    // The escape hatch names the deliberate repair path; the wizard never
    // repairs the install itself, and the futile retry is not offered.
    expect(output).toContain('npx bmad-method install');
    expect(output).not.toContain('Retry or skip this repo?');
    // The skip-only loop refuses a typed retry with its correction line
    // before accepting the skip.
    expect(output).toContain('retry cannot fix it; enter skip');
    expect(output).toContain('BMAD not ready in repo-a: skipped by explicit per-repo choice');
    expect(output).toContain('Setup complete');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toContain('port = 0');
  }, 120_000);

  it('transient BMAD failure still offers retry; a successful retried attempt completes (gh-32)', () => {
    const workspace = tempDir('gru-command-pty-retry-ws-');
    const repoA = join(workspace, 'repo-a');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoA });
    const instance = tempDir('gru-command-pty-retry-home-');
    const bin = tempDir('gru-command-pty-retry-bin-');
    writeFileSync(join(bin, 'uv'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    // Stateful fake npx: the pinned installer succeeds in the preflight
    // stage directory (invocation 1) but fails on the first repo write
    // (invocation 2) — a transient download blip, not repo state. The
    // retried attempt (invocations 3–4) succeeds and completes setup.
    // Compare against the REALPATH: the wizard validates and installs
    // through realpathSync (macOS /var/… → /private/var/…).
    const counter = join(bin, 'npx-invocations');
    const repoAReal = realpathSync(repoA);
    const npxScript = [
      '#!/usr/bin/env node',
      "const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "if (process.argv.includes('--version')) { console.log('10.0.0'); process.exit(0); }",
      "const dirAt = process.argv.indexOf('--directory');",
      'const root = dirAt === -1 ? process.cwd() : process.argv[dirAt + 1];',
      `const counter = ${JSON.stringify(counter)};`,
      'let count = 0;',
      "try { count = Number(readFileSync(counter, 'utf-8')); } catch {}",
      'count += 1;',
      "writeFileSync(counter, String(count));",
      `if (root === ${JSON.stringify(repoAReal)} && count === 2) { process.stderr.write('fixture transient download failure\\n'); process.exit(1); }`,
      "const manifest = ['installation:', '  version: 6.12.0', 'modules:', '  - name: core', '    version: 6.12.0', '  - name: bmm', '    version: 6.12.0', '  - name: cis', '    version: v0.3.2', '  - name: tea', '    version: v1.27.2', '  - name: gds', '    version: v0.7.2', 'ides:', '  - pi', ''].join('\\n');",
      "for (const module of ['core','bmm','cis','tea','gds']) { mkdirSync(join(root, '_bmad', module), { recursive: true }); writeFileSync(join(root, '_bmad', module, 'marker.txt'), module + '\\n'); }",
      "mkdirSync(join(root, '_bmad', '_config'), { recursive: true }); writeFileSync(join(root, '_bmad', '_config', 'manifest.yaml'), manifest);",
      "for (const skill of ['bmad-build','bmad-help','gds-quick-dev']) { const dir=join(root,'.agents','skills',skill); mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,'SKILL.md'),'# skill\\n'); writeFileSync(join(dir,'workflow.md'),'{{.implementation_artifacts}}\\n'); }",
      'process.exit(0);',
      '',
    ].join('\n');
    writeFileSync(join(bin, 'npx'), npxScript, { mode: 0o755 });
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '1' },
        { expect: BMAD_A_PROMPT, send: '' }, // default = install (fresh repo)
        { expect: RUNTIME_PROMPT, send: 'pi' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: '' },
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
        { expect: 'Retry or skip this repo? [retry/skip]:', send: 'retry' },
      ],
      { GRU_COMMAND_HOME: instance, PATH: `${bin}:${process.env.PATH ?? ''}` },
    );
    expect(status, output).toBe(0);
    expect(output).toContain('official BMAD installer exited 1');
    // The transient class keeps the plain failure banner and its retry.
    expect(output).toContain('BMAD setup for repo-a failed:');
    expect(output).not.toContain('deterministic — retrying cannot fix it');
    expect(output).toContain('BMAD ready in repo-a');
    expect(output).toContain('Setup complete');
    expect(existsSync(join(repoA, '.gru-command', 'bmad-install.json'))).toBe(true);
  }, 120_000);

  it('EOF (Ctrl-D) at the deterministic skip-only prompt takes the skip path instead of wedging (whole-900 review A2)', () => {
    const workspace = tempDir('gru-command-pty-eof-det-ws-');
    const repoA = join(workspace, 'repo-a');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoA });
    // Same broken existing install as the deterministic test: the prompt
    // under test is the skip-only loop, and a closed stdin must reach the
    // documented skip path (readline question() never settles on EOF).
    mkdirSync(join(repoA, '_bmad', '_config'), { recursive: true });
    writeFileSync(
      join(repoA, '_bmad', '_config', 'manifest.yaml'),
      'installation:\n  version: 6.12.0\nmodules:\n  - name: core\n    version: 6.12.0\nides:\n  - pi\n',
    );
    const instance = tempDir('gru-command-pty-eof-det-home-');
    const bin = tempDir('gru-command-pty-eof-det-bin-');
    writeFileSync(join(bin, 'uv'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '1' },
        { expect: BMAD_A_PROMPT, send: 'reuse' },
        { expect: RUNTIME_PROMPT, send: 'pi' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: '' },
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
        { expect: 'Skip this repo? [skip]:', send: '\u0004' },
      ],
      { GRU_COMMAND_HOME: instance, PATH: `${bin}:${process.env.PATH ?? ''}` },
    );
    expect(status, output).toBe(0);
    expect(output).toContain('input closed (EOF) — taking the skip path');
    expect(output).toContain('deterministic — retrying cannot fix it');
    expect(output).toContain('BMAD not ready in repo-a: skipped by explicit per-repo choice');
    expect(output).toContain('Setup complete');
  }, 120_000);

  it('EOF (Ctrl-D) at the transient retry prompt takes the skip path instead of wedging (whole-900 review A2)', () => {
    const workspace = tempDir('gru-command-pty-eof-retry-ws-');
    const repoA = join(workspace, 'repo-a');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoA });
    const instance = tempDir('gru-command-pty-eof-retry-home-');
    const bin = tempDir('gru-command-pty-eof-retry-bin-');
    writeFileSync(join(bin, 'uv'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    // Stateful fake npx (same shape as the transient retry test): the
    // pinned installer fails on the first repo write, so the retry prompt
    // is reached; Ctrl-D there must skip instead of hanging.
    const counter = join(bin, 'npx-invocations');
    const repoAReal = realpathSync(repoA);
    const npxScript = [
      '#!/usr/bin/env node',
      "const { mkdirSync, writeFileSync, readFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      "if (process.argv.includes('--version')) { console.log('10.0.0'); process.exit(0); }",
      "const dirAt = process.argv.indexOf('--directory');",
      'const root = dirAt === -1 ? process.cwd() : process.argv[dirAt + 1];',
      `const counter = ${JSON.stringify(counter)};`,
      'let count = 0;',
      "try { count = Number(readFileSync(counter, 'utf-8')); } catch {}",
      'count += 1;',
      "writeFileSync(counter, String(count));",
      `if (root === ${JSON.stringify(repoAReal)} && count === 2) { process.stderr.write('fixture transient download failure\\n'); process.exit(1); }`,
      "const manifest = ['installation:', '  version: 6.12.0', 'modules:', '  - name: core', '    version: 6.12.0', '  - name: bmm', '    version: 6.12.0', '  - name: cis', '    version: v0.3.2', '  - name: tea', '    version: v1.27.2', '  - name: gds', '    version: v0.7.2', 'ides:', '  - pi', ''].join('\\n');",
      "for (const module of ['core','bmm','cis','tea','gds']) { mkdirSync(join(root, '_bmad', module), { recursive: true }); writeFileSync(join(root, '_bmad', module, 'marker.txt'), module + '\\n'); }",
      "mkdirSync(join(root, '_bmad', '_config'), { recursive: true }); writeFileSync(join(root, '_bmad', '_config', 'manifest.yaml'), manifest);",
      "for (const skill of ['bmad-build','bmad-help','gds-quick-dev']) { const dir=join(root,'.agents','skills',skill); mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,'SKILL.md'),'# skill\\n'); writeFileSync(join(dir,'workflow.md'),'{{.implementation_artifacts}}\\n'); }",
      'process.exit(0);',
      '',
    ].join('\n');
    writeFileSync(join(bin, 'npx'), npxScript, { mode: 0o755 });
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '1' },
        { expect: BMAD_A_PROMPT, send: '' },
        { expect: RUNTIME_PROMPT, send: 'pi' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: '' },
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
        { expect: 'Retry or skip this repo? [retry/skip]:', send: '\u0004' },
      ],
      { GRU_COMMAND_HOME: instance, PATH: `${bin}:${process.env.PATH ?? ''}` },
    );
    expect(status, output).toBe(0);
    expect(output).toContain('input closed (EOF) — taking the skip path');
    expect(output).toContain('BMAD setup for repo-a failed:');
    expect(output).toContain('BMAD not ready in repo-a: skipped by explicit per-repo choice');
    expect(output).toContain('Setup complete');
  }, 120_000);

  it('interactive hint-less deterministic failures keep neutral guidance and refuse a typed retry (whole-900 review V2)', () => {
    const workspace = tempDir('gru-command-pty-hintless-ws-');
    const repoA = join(workspace, 'repo-a');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoA });
    // A partial install (_bmad without a manifest) is deterministic with
    // NO repairHint: the interactive banner must render the neutral
    // fallback, never the literal 'undefined'.
    mkdirSync(join(repoA, '_bmad', 'bmm'), { recursive: true });
    const instance = tempDir('gru-command-pty-hintless-home-');
    const bin = tempDir('gru-command-pty-hintless-bin-');
    writeFileSync(join(bin, 'uv'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '1' },
        // No manifest exists, so the interactive prompt is the fresh-repo
        // Y/n default (Enter = install): the install attempt then refuses
        // the partial install — deterministic and hint-less.
        { expect: BMAD_A_PROMPT, send: '' },
        { expect: RUNTIME_PROMPT, send: 'pi' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: '' },
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
        { expect: 'Skip this repo? [skip]:', send: 'retry' },
        { expect: 'Skip this repo? [skip]:', send: 'skip' },
      ],
      { GRU_COMMAND_HOME: instance, PATH: `${bin}:${process.env.PATH ?? ''}` },
    );
    expect(status, output).toBe(0);
    expect(output).toContain('partial BMAD installation detected');
    expect(output).toContain('deterministic — retrying cannot fix it');
    expect(output).toContain('Repair the reported condition deliberately, then re-run the wizard');
    expect(output).not.toContain('undefined');
    expect(output).toContain('retry cannot fix it; enter skip');
    expect(output).toContain('BMAD not ready in repo-a: skipped by explicit per-repo choice');
    expect(output).toContain('Setup complete');
  }, 120_000);

  it('already-onboarded deleted runtime binding is skip-only deterministic; a typed retry is refused and only skip completes (gh-32 r1)', () => {
    const workspace = tempDir('gru-command-pty-unbind-ws-');
    const repoA = join(workspace, 'repo-a');
    mkdirSync(join(repoA, '.git'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoA });
    const bin = tempDir('gru-command-pty-unbind-bin-');
    writeFileSync(join(bin, 'uv'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    // Synthetic pinned installer (no real installer execution).
    writeFileSync(
      join(bin, 'npx'),
      [
        '#!/usr/bin/env node',
        "const { mkdirSync, writeFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "if (process.argv.includes('--version')) { console.log('10.0.0'); process.exit(0); }",
        "const root = process.cwd();",
        "const manifest = ['installation:', '  version: 6.12.0', 'modules:', '  - name: core', '    version: 6.12.0', '  - name: bmm', '    version: 6.12.0', '  - name: cis', '    version: v0.3.2', '  - name: tea', '    version: v1.27.2', '  - name: gds', '    version: v0.7.2', 'ides:', '  - pi', ''].join('\\n');",
        "for (const module of ['core','bmm','cis','tea','gds']) { mkdirSync(join(root, '_bmad', module), { recursive: true }); writeFileSync(join(root, '_bmad', module, 'marker.txt'), module + '\\n'); }",
        "mkdirSync(join(root, '_bmad', '_config'), { recursive: true }); writeFileSync(join(root, '_bmad', '_config', 'manifest.yaml'), manifest);",
        "for (const skill of ['bmad-build','bmad-help','gds-quick-dev']) { const dir=join(root,'.agents','skills',skill); mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,'SKILL.md'),'# skill\\n'); writeFileSync(join(dir,'workflow.md'),'{{.implementation_artifacts}}\\n'); }",
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const ptyEnv = { GRU_COMMAND_HOME: tempDir('gru-command-pty-unbind-home-'), PATH: `${bin}:${process.env.PATH ?? ''}` };
    // First run: a successful install records the runtime bindings.
    const first = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '1' },
        { expect: BMAD_A_PROMPT, send: '' }, // default = install (fresh repo)
        { expect: RUNTIME_PROMPT, send: 'pi' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: '' },
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
      ],
      ptyEnv,
    );
    expect(first.status, first.output).toBe(0);
    expect(first.output).toContain('BMAD ready in repo-a');
    expect(existsSync(join(repoA, '.gru-command', 'bmad-install.json'))).toBe(true);
    // The recorded binding then disappears — unchanged on-disk state.
    rmSync(join(repoA, '.agents', 'skills', 'bmad-help'), { recursive: true, force: true });
    const reuseHome = tempDir('gru-command-pty-unbind-home2-');
    const second = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '1' },
        { expect: BMAD_A_PROMPT, send: 'reuse' },
        { expect: RUNTIME_PROMPT, send: 'pi' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: '' },
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
        { expect: 'Skip this repo? [skip]:', send: 'retry' }, // deliberate typed retry attempt
        { expect: 'Skip this repo? [skip]:', send: '' }, // skip-only loop re-prompts; Enter = skip
      ],
      { GRU_COMMAND_HOME: reuseHome, PATH: `${bin}:${process.env.PATH ?? ''}` },
    );
    expect(second.status, second.output).toBe(0);
    expect(second.output).toContain('deterministic — retrying cannot fix it');
    expect(second.output).toContain('BMAD recorded skill binding is missing');
    expect(second.output).toContain('npx bmad-method install');
    // The typed retry is REFUSED, not executed: the skip-only loop answers
    // with its correction line and re-prompts WITHOUT a second onboarding
    // attempt. The observation proving no retry ran: the failure banner and
    // its missing-binding message appear EXACTLY once in the whole
    // transcript — a real retry would re-invoke onboarding and print both
    // again. (The older missing-module typed-retry leg is a different class
    // and does not cover this deleted-binding path; this case does.)
    expect(second.output).toContain('retry cannot fix it; enter skip');
    const bannerCount = second.output.split('deterministic — retrying cannot fix it').length - 1;
    expect(bannerCount, 'typed retry must not initiate another setup attempt').toBe(1);
    const missingCount = second.output.split('BMAD recorded skill binding is missing').length - 1;
    expect(missingCount).toBe(1);
    expect(second.output).not.toContain('Retry or skip this repo?');
    expect(second.output).toContain('BMAD not ready in repo-a: skipped by explicit per-repo choice');
    // The collected answers survived the failure loop: setup completes with
    // the same workspace answer and writes the fresh instance's config.
    expect(second.output).toContain('Setup complete');
    const config = readFileSync(join(reuseHome, 'config.toml'), 'utf-8');
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
        { expect: BMAD_A_PROMPT, send: 'n' },
        { expect: BMAD_B_PROMPT, send: 'n' },
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
        { expect: BMAD_A_PROMPT, send: 'n' },
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
    expect(output).toContain('Selected repos for BMAD onboarding: repo-a');
    expect(output).not.toContain('BMAD onboarding: repo-a, repo-b');
  }, 120_000);

  it('managed-repo multi-pick by NAME (comma-separated) selects exactly those repos', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-home4-');
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: 'repo-b, repo-a' }, // by name, comma-separated
        { expect: BMAD_B_PROMPT, send: 'n' },
        { expect: BMAD_A_PROMPT, send: 'n' },
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
    expect(output).toContain('Selected repos for BMAD onboarding: repo-b, repo-a');
  }, 120_000);

  it('bind host rejects y/n tokens and re-prompts; 0.0.0.0 lands in the config (user-found boot bug)', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-host-');
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '' },
        { expect: BMAD_A_PROMPT, send: 'n' },
        { expect: BMAD_B_PROMPT, send: 'n' },
        { expect: RUNTIME_PROMPT, send: '' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: 'yes' }, // rejected — re-prompt, never written
        { expect: HOST_PROMPT, send: 'no' }, // rejected again
        { expect: HOST_PROMPT, send: '0.0.0.0' }, // valid: all interfaces
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
      ],
      { GRU_COMMAND_HOME: instance },
    );
    expect(status, output).toBe(0);
    expect(output).toContain('is not a bind host — enter an IP address');
    const text = readFileSync(join(instance, 'config.toml'), 'utf-8');
    expect(text).toContain('host = "0.0.0.0"');
  }, 120_000);

  it('bind host accepts a resolvable hostname (localhost) end-to-end', () => {
    const workspace = fixtureWorkspace();
    const instance = tempDir('gru-command-pty-hostname-');
    const { output, status } = ptyWizard(
      [
        { expect: WS_PROMPT, send: workspace },
        { expect: REPOS_PROMPT, send: '' },
        { expect: BMAD_A_PROMPT, send: 'n' },
        { expect: BMAD_B_PROMPT, send: 'n' },
        { expect: RUNTIME_PROMPT, send: '' },
        { expect: MODEL_PROMPT, send: '' },
        { expect: THINKING_PROMPT, send: '' },
        { expect: HOST_PROMPT, send: 'localhost' }, // resolvable → accepted
        { expect: PORT_PROMPT, send: '0' },
        { expect: TOKEN_PROMPT, send: '' },
        { expect: REGISTER_PROMPT, send: 'n' },
        { expect: SMOKE_PROMPT, send: 'n' },
      ],
      { GRU_COMMAND_HOME: instance },
    );
    expect(status, output).toBe(0);
    const text = readFileSync(join(instance, 'config.toml'), 'utf-8');
    expect(text).toContain('host = "localhost"');
  }, 120_000);
});

// W-A (E9 r3 carry): the PTY legs were expect(1)-conditional with NO
// gate — a machine without `expect` silently skipped them and nothing
// failed (suite-shape pins counts statically, not execution). This gate
// is FAIL-SHAPED: on a pty platform without `expect` the suite FAILS
// unless the run EXPLICITLY opts out via GRU_TEST_SKIP_PTY=1.
describe('pty gate (W-A — no silent PTY skips)', () => {
  it('expect(1) is present on pty platforms, or the run explicitly opts out', () => {
    if (!ptyPlatform) return; // non-pty platform — nothing to gate
    if (ptySkipOptOut) return; // explicit, annotated opt-out
    expect(
      expectAvailable(),
      'expect(1) is missing — the PTY-driven wizard legs would silently skip. ' +
        'Install expect (brew install expect / apt-get install expect) ' +
        'or set GRU_TEST_SKIP_PTY=1 to opt out explicitly.',
    ).toBe(true);
  });
});
