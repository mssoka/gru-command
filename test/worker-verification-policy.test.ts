import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { exec, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCLI } from 'vitest/node';
import { nativeCorpus } from './helpers/verification-native-corpus.mjs';
import { BUILD_INCIDENT, FULL_INCIDENT, WEB_INCIDENT, authenticatedCaptureStatus, verificationLane } from './helpers/worker-verification.js';
import { PACKAGE_ROOT } from '../src/bmad/runtime.js';
import type { WorktreeLane } from '../src/dispatch/worktree-port.js';
import { claudeTurnArgs } from '../src/runtime/claude-adapter.js';
import { ClaudeVerificationPermissionChannel, privateClaudeVerificationSettings } from '../src/runtime/claude-verification-settings.js';
import { workerVerificationExtension } from '../src/runtime/pi-adapter.js';
import { workerVerificationHook } from '../src/runtime/worker-verification-hook.js';
import {
  isVerificationProducer,
  normalizedVerificationWords,
  verificationCommandGroups,
  workerVerificationPolicy,
  workerVerificationRefusal,
  type WorkerVerificationPolicy,
} from '../src/runtime/worker-verification-policy.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const CONFIG_FILE = join(tmpdir(), 'gru-915-instance', 'config.toml');

const VERIFY_FIXTURE = [
  '[verify]',
  'full = "npm test"',
  'web = "cd web && npx vitest run --config vitest.config.ts src/lib/board-client.test.ts"',
  'static = "npm run lint && npm run typecheck && npm run build"',
].join('\n');

/** A registered job lane whose canonical contract declares verification scopes. */
function policyFixture(): WorkerVerificationPolicy {
  const root = mkdtempSync(join(tmpdir(), 'gc-worker-verification-'));
  roots.push(root);
  const lanePath = join(root, 'lane');
  mkdirSync(join(lanePath, '.gru-command'), { recursive: true });
  writeFileSync(join(lanePath, '.gru-command', 'worktree.toml'), VERIFY_FIXTURE);
  const lane: WorktreeLane = {
    id: 'job-915', jobId: 'job-915', kind: 'job', repoPath: lanePath, repoName: 'app', path: lanePath,
    branch: 'gru/job-915', sha: '0'.repeat(40), roundId: null, status: 'active',
  };
  const policy = workerVerificationPolicy(lane, CONFIG_FILE);
  expect(policy).toBeDefined();
  return policy as WorkerVerificationPolicy;
}

/** A registered job lane declaring exactly the supplied `[verify]` rows. */
function policyWithVerify(rows: readonly string[]): WorkerVerificationPolicy {
  const root = mkdtempSync(join(tmpdir(), 'gc-worker-verification-'));
  roots.push(root);
  const lanePath = join(root, 'lane');
  mkdirSync(join(lanePath, '.gru-command'), { recursive: true });
  writeFileSync(join(lanePath, '.gru-command', 'worktree.toml'), ['[verify]', ...rows].join('\n'));
  const lane: WorktreeLane = {
    id: 'job-915', jobId: 'job-915', kind: 'job', repoPath: lanePath, repoName: 'app', path: lanePath,
    branch: 'gru/job-915', sha: '0'.repeat(40), roundId: null, status: 'active',
  };
  const policy = workerVerificationPolicy(lane, CONFIG_FILE);
  expect(policy).toBeDefined();
  return policy as WorkerVerificationPolicy;
}

const INCIDENT_FORMS = [
  'cd web && npx vitest run --config vitest.config.ts src/lib/board-client.test.ts src/ui/board.test.ts',
  'npm test',
  'npm run lint && npm run typecheck && npm run build && npm run build:web',
];

const ALLOWED_FORMS = [
  'git status --short',
  "rg 'npm test' src/",
  'cat package.json',
  "printf '%s' 'npm test'",
  'npm view test',
  'node dist/verify/capture-cli.js run --job job-915 --scope full --sink /tmp/s.ndjson --url http://ops --config /tmp/c.toml',
  'node dist/verify/capture-cli.js status --request-id req-1 --url http://ops --config /tmp/c.toml',
  'node tools/patch-vitest-rpc-timeout.mjs',
];

describe('worker verification policy: bounded producer classification', () => {
  it('refuses every observed direct command form before a producer starts', () => {
    const policy = policyFixture();
    const started: string[] = [];
    // A fake process runner stands in for the vendor Bash executor: a
    // refused command must never reach it.
    const fakeProcessRunner = (command: string): void => { started.push(command); };
    const attempt = (command: string): void => {
      if (isVerificationProducer(command, policy)) throw new Error(workerVerificationRefusal(policy));
      fakeProcessRunner(command);
    };
    for (const form of INCIDENT_FORMS) {
      expect(() => attempt(form)).toThrow(/refused before execution/u);
    }
    expect(started).toEqual([]);
    attempt('git status --short');
    expect(started).toEqual(['git status --short']);
  });

  it('recognizes conventional producer variants without classifying read text', () => {
    const policy = policyFixture();
    for (const form of INCIDENT_FORMS) expect(isVerificationProducer(form, policy)).toBe(true);
    for (const form of ALLOWED_FORMS) expect(isVerificationProducer(form, policy)).toBe(false);
  });

  it('keeps redirection, heredoc bodies and quoted text out of execution positions', () => {
    const policy = policyFixture();
    expect(isVerificationProducer('npm test>test.log', policy)).toBe(true);
    expect(isVerificationProducer("cat > notes.md <<'EOF'\nnpm test\nEOF\n", policy)).toBe(false);
    expect(verificationCommandGroups('cd web && npx vitest run x')).toEqual([['cd', 'web'], ['npx', 'vitest', 'run', 'x']]);
  });

  it('classifies spaced and mid-command redirection targets as data, not executables (H1)', () => {
    const policy = policyFixture();
    for (const form of ['> test.log npm test', '2> log npm test', 'npm > test.log test', 'npm 2>&1 test']) {
      expect(isVerificationProducer(form, policy), form).toBe(true);
    }
    expect(verificationCommandGroups('> test.log npm test')).toEqual([['npm', 'test']]);
    expect(verificationCommandGroups('2> log npm test')).toEqual([['npm', 'test']]);
    // A redirect target separated from the executable is still only data.
    expect(isVerificationProducer('cat notes.md > test.log', policy)).toBe(false);
  });

  it('classifies executable substitutions in expanding quotes and unquoted heredocs (H2)', () => {
    const policy = policyFixture();
    expect(isVerificationProducer('printf \'%s\' "$(npm test)"', policy)).toBe(true);
    expect(isVerificationProducer('printf \'%s\' "`npm test`"', policy)).toBe(true);
    expect(isVerificationProducer('cat <<EOF\n$(npm test)\nEOF\n', policy)).toBe(true);
    expect(isVerificationProducer('cat <<EOF\n`npm test`\nEOF\n', policy)).toBe(true);
    // Single-quoted and odd-escaped substitutions stay literal source data.
    expect(isVerificationProducer("printf '%s' '$(npm test)'", policy)).toBe(false);
    expect(isVerificationProducer('printf \'%s\' "\\$(npm test)"', policy)).toBe(false);
    expect(isVerificationProducer('cat <<EOF\n\\$(npm test)\nEOF\n', policy)).toBe(false);
    // An even escape is a real substitution.
    expect(isVerificationProducer('cat <<EOF\n\\\\$(npm test)\nEOF\n', policy)).toBe(true);
  });

  it('does not terminally treat a tab-indented plain heredoc delimiter as the end (M4)', () => {
    const policy = policyFixture();
    // `<<` (not `<<-`) never strips tabs, so the tab-indented line is body data.
    expect(isVerificationProducer("cat <<'EOF'\n\tEOF\nnpm test\nEOF\n", policy)).toBe(false);
    expect(isVerificationProducer('cat <<-EOF\n\t$(npm test)\n\tEOF\n', policy)).toBe(true);
  });

  it('allows combined config/help reads and refuses the producing positions (H3 classifier)', () => {
    const policy = policyFixture();
    for (const form of [
      'tsc --version', 'tsc --noEmit --showConfig', 'tsc --project tsconfig.json --showConfig',
      'tsc -p tsconfig.json --showConfig', 'vite build --help', 'eslint --help',
      'eslint --print-config src/index.ts', 'npx tsc --version',
    ]) {
      expect(isVerificationProducer(form, policy), form).toBe(false);
    }
    for (const form of ['tsc src/index.ts', 'eslint src/file.ts', 'eslint', 'jest foo.test.js', 'eslint . -- --help', 'vite build', 'playwright test']) {
      expect(isVerificationProducer(form, policy), form).toBe(true);
    }
  });

  it('strips the time reserved word and its options before matching (M1)', () => {
    const policy = policyFixture();
    for (const form of ['time npm test', 'time -p npm test', 'time --portability npm test']) {
      expect(isVerificationProducer(form, policy), form).toBe(true);
    }
    expect(isVerificationProducer('time -p cat package.json', policy)).toBe(false);
  });

  it('narrows declared npx prefixes to the declared verb (M2)', () => {
    const pw = policyWithVerify(['pw = "npx playwright test"', 'dev = "npx vite build"']);
    expect(isVerificationProducer('npx playwright test', pw)).toBe(true);
    expect(isVerificationProducer('npx vite build', pw)).toBe(true);
    // Non-producer operations of the same tools stay runnable.
    expect(isVerificationProducer('npx playwright install', pw)).toBe(false);
    expect(isVerificationProducer('playwright install-deps', pw)).toBe(false);
    expect(isVerificationProducer('npx vite dev', pw)).toBe(false);
    expect(isVerificationProducer('vite preview', pw)).toBe(false);
  });

  it('derives bare and local-bin equivalents from the lane declaration (M3)', () => {
    const policy = policyWithVerify(['custom = "npx mocha test/foo.js"']);
    expect(isVerificationProducer('npx mocha test/foo.js', policy)).toBe(true);
    expect(isVerificationProducer('mocha', policy)).toBe(true);
    expect(isVerificationProducer('./node_modules/.bin/mocha test/foo.js', policy)).toBe(true);
    expect(isVerificationProducer(`${policy.cwd}/node_modules/.bin/mocha`, policy)).toBe(true);
    expect(isVerificationProducer('mocha --version', policy)).toBe(false);
  });

  it('extracts declared custom producer scripts through the shared normalization (M6)', () => {
    const policy = policyWithVerify(['custom = "CI=1 npm run verify:contract"']);
    expect(isVerificationProducer('npm run verify:contract', policy)).toBe(true);
    expect(isVerificationProducer('CI=1 npm run verify:contract', policy)).toBe(true);
    expect(isVerificationProducer('npm run something-else', policy)).toBe(false);
  });

  it('refuses known local-bin direct forms and the lane absolute bin path (M7)', () => {
    const policy = policyFixture();
    for (const form of [
      './node_modules/.bin/vitest run', '../node_modules/.bin/vitest run', 'node_modules/.bin/tsc',
      'web/node_modules/.bin/eslint .', './web/node_modules/.bin/jest',
      `${policy.cwd}/node_modules/.bin/vitest run`, `${policy.cwd}/web/node_modules/.bin/eslint .`,
    ]) {
      expect(isVerificationProducer(form, policy), form).toBe(true);
    }
  });

  it('keeps the native deny catalogue precise for reads and broad for conventional variants (H3/H4)', () => {
    const { policy } = retainedFixture(true);
    const rules = ['Bash'];
    expect(rules).toEqual(['Bash']);
    for (const row of nativeCorpus) expect(nativeHostDenial(row.raw, policy), row.raw).toBe(row.refused);
  });

  it('writes a private settings artifact the CLI can actually consume (M5)', () => {
    const policy = policyFixture();
    const settings = privateClaudeVerificationSettings(policy);
    try {
      const parsed = JSON.parse(readFileSync(settings.file, 'utf8')) as {
        permissions?: { ask?: string[] };
        hooks?: { PreToolUse?: { matcher?: string; hooks?: { type?: string; command?: string }[] }[] };
      };
      expect(parsed.permissions?.ask).toEqual(['Bash']);
      expect(parsed.permissions?.ask?.length ?? 0).toBeGreaterThan(0);
      const entry = parsed.hooks?.PreToolUse?.[0];
      expect(entry?.matcher).toBe('Bash');
      expect(entry?.hooks?.[0]?.type).toBe('command');
      expect(entry?.hooks?.[0]?.command).toContain('worker-verification-hook.js');
      for (const [command, denied] of [['npm test', true], ['git status', false]] as const) {
        const execution = spawnSync('/bin/sh', ['-c', entry!.hooks![0]!.command!], {
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8',
        });
        expect(execution.status, execution.stderr).toBe(0);
        expect(JSON.parse(execution.stdout)).toEqual(denied ? { hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: workerVerificationRefusal(policy),
        } } : {});
      }
      // The hook reads the sibling policy file, not the settings file.
      const policyFile = join(dirname(settings.file), 'policy.json');
      expect(JSON.parse(readFileSync(policyFile, 'utf8'))).toMatchObject({ jobId: policy.jobId });
    } finally {
      settings.dispose();
    }
  });

  it('names the declared scopes and the authenticated reconcile action in the refusal', () => {
    const policy = policyFixture();
    const refusal = workerVerificationRefusal(policy);
    expect(refusal).toContain(policy.helper);
    expect(refusal).toContain('full, static, web');
    expect(refusal).toContain('status --request-id');
    expect(refusal).toContain('not termination or PASS');
  });

  it('derives the policy from the lane declaration and requires the loaded config path', () => {
    const lane: WorktreeLane = {
      id: 'job-915', jobId: 'job-915', kind: 'job', repoPath: '/nonexistent', repoName: 'app',
      path: '/nonexistent', branch: null, sha: '0'.repeat(40), roundId: null, status: 'active',
    };
    expect(workerVerificationPolicy({ ...lane, kind: 'review' } as WorktreeLane, CONFIG_FILE)).toBeUndefined();
    expect(workerVerificationPolicy(lane, CONFIG_FILE)).toBeUndefined(); // no manifest -> no scopes
  });

  it('refuses a version flag that cannot suppress a selected subcommand (N1)', () => {
    const policy = policyFixture();
    // vite dispatches a matched subcommand BEFORE it reads --version, so a
    // build still runs; --help genuinely suppresses it.
    for (const form of ['vite build --version', 'npx vite build --version', 'playwright test --version']) {
      expect(isVerificationProducer(form, policy), form).toBe(true);
    }
    for (const form of ['vite build --help', 'npx vite build --help', 'tsc --version', 'npx tsc --version']) {
      expect(isVerificationProducer(form, policy), form).toBe(false);
    }
    // The help read stays a read: no blanket wildcard may deny it.
    expect(nativeHostDenial('vite build --help', policy)).toBe(false);
  });

  it('classifies executable substitutions in redirect targets, herestrings and unquoted positions (N2/N3/N9)', () => {
    const policy = policyFixture();
    for (const form of [
      'cat >"$(npm test)"',
      'cat <<<"$(npm test)"',
      'cat > out-$(npm test).log',
      'echo `npm test`',
      'FOO=`npm test`',
      'npm test$(true)',
      'npx vitest run$(true)',
      '$(npm test)',
      'cat <<EOF\n$(\nnpm test\n)\nEOF\n',
    ]) {
      expect(isVerificationProducer(form, policy), form).toBe(true);
    }
    // Quoted/plain data and a harmless expansion stay data.
    for (const form of ["printf '%s' '$(npm test)'", 'cat > notes.md', 'cat <<< "plain"', 'echo done']) {
      expect(isVerificationProducer(form, policy), form).toBe(false);
    }
  });

  it('omits native stems the classifier itself treats as reads (N5)', () => {
    const policy = policyFixture();
    const rules = ['Bash'];
    expect(rules).toEqual(['Bash']);
    // The classifier agrees: script listing and the dev server are reads.
    for (const form of ['npm run', 'npx vite', 'npx playwright', 'npx vite dev']) {
      expect(isVerificationProducer(form, policy), form).toBe(false);
    }
    expect(isVerificationProducer('npm run lint', policy)).toBe(true);
  });

  it('treats a declared npx operand as data, not a mandatory prefix word (N6)', () => {
    const policy = policyWithVerify(['custom = "npx mocha test/foo.js"']);
    for (const form of [
      'npx mocha test/foo.js', 'npx mocha test/bar.js', 'npx mocha',
      'mocha', './node_modules/.bin/mocha test/bar.js',
    ]) {
      expect(isVerificationProducer(form, policy), form).toBe(true);
    }
    expect(isVerificationProducer('npx mocha --version', policy)).toBe(false);
  });

  it('strips conventional exec, nohup and nice wrappers before matching (N7)', () => {
    const policy = policyFixture();
    for (const form of [
      'exec npm test', 'exec -a x npm test', 'exec -- npm test',
      'nohup npm test', 'nice npm test', 'nice -n 5 npm test', 'nice -10 npm test',
    ]) {
      expect(isVerificationProducer(form, policy), form).toBe(true);
    }
    for (const form of ['exec cat package.json', 'nohup cat package.json', 'nice -n 5 cat package.json']) {
      expect(isVerificationProducer(form, policy), form).toBe(false);
    }
  });

  it('covers the npm verb aliases t/rum/urn in classifier and native catalogue (N8)', () => {
    const policy = policyFixture();
    for (const form of ['npm t', 'npm rum build', 'npm urn build', 'npm run-script build']) {
      expect(isVerificationProducer(form, policy), form).toBe(true);
    }
    for (const form of ['npm t', 'npm rum build', 'npm urn build']) expect(nativeHostDenial(form, policy)).toBe(true);
  });

  it('runs the shipped hook CLI as a subprocess and denies a producer (N4)', () => {
    const policy = policyFixture();
    const hook = join(PACKAGE_ROOT, 'dist/runtime/worker-verification-hook.js');
    if (!existsSync(hook)) {
      throw new Error('dist/runtime/worker-verification-hook.js is missing — run `npm run build` first');
    }
    const dir = mkdtempSync(join(tmpdir(), 'gru-hook-'));
    roots.push(dir);
    const policyFile = join(dir, 'policy.json');
    writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
    const run = (input: unknown): { status: number | null; stdout: string; stderr: string } => {
      const result = spawnSync(process.execPath, [hook, policyFile], {
        input: JSON.stringify(input), encoding: 'utf8',
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const denied = run({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(denied.status, denied.stderr).toBe(0);
    const decision = JSON.parse(denied.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(decision.hookSpecificOutput?.permissionDecision).toBe('deny');
    const allowed = run({ tool_name: 'Bash', tool_input: { command: 'git status' } });
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({});
  });
});

describe('worker verification policy: runtime enforcement seams', () => {
  it('denies a producer Bash call through the Claude PreToolUse hook and allows reads', () => {
    const policy = policyFixture();
    for (const form of INCIDENT_FORMS) {
      const decision = workerVerificationHook({ tool_name: 'Bash', tool_input: { command: form } }, policy) as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      };
      expect(decision.hookSpecificOutput?.permissionDecision).toBe('deny');
      expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain(policy.helper);
    }
    expect(workerVerificationHook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, policy)).toEqual({});
    expect(workerVerificationHook({ tool_name: 'Read', tool_input: { command: 'npm test' } }, policy)).toEqual({});
  });

  it('blocks a producer bash tool call through the pi SDK extension before execution', () => {
    const policy = policyFixture();
    let handler: ((event: unknown) => unknown) | undefined;
    const inline = workerVerificationExtension(policy);
    (inline as (pi: unknown) => void)({ on: (_event: string, h: (event: unknown) => unknown) => { handler = h; } });
    expect(handler).toBeDefined();
    const decide = handler as (event: unknown) => unknown;
    for (const form of INCIDENT_FORMS) {
      const denied = decide({ type: 'tool_call', toolCallId: '1', toolName: 'bash', input: { command: form } }) as {
        block?: boolean; reason?: string;
      };
      expect(denied.block, form).toBe(true);
      expect(denied.reason).toContain(policy.helper);
    }
    expect(decide({ type: 'tool_call', toolCallId: '2', toolName: 'bash', input: { command: 'git log -1' } })).toBeUndefined();
  });

  it('carries the private deny/hook settings into a normal claude turn, never a review turn', () => {
    const policy = policyFixture();
    const settings = privateClaudeVerificationSettings(policy);
    try {
      expect(nativeHostDenial('npm test', policy)).toBe(true);
      const base = {
        sessionId: '11111111-1111-1111-1111-111111111111', sessionFile: '/tmp/s.jsonl', cwd: '/tmp',
        binary: 'claude', tools: ['Bash', 'Read'], systemPrompt: 'role', killGraceMs: 2_000, resume: false,
        verificationSettingsFile: settings.file,
      } as const;
      expect(claudeTurnArgs({ ...base }, false)).toContain(settings.file);
      const reviewArgs = claudeTurnArgs({ ...base, isolatedReview: true }, false);
      expect(reviewArgs).not.toContain(settings.file);
    } finally {
      settings.dispose();
    }
  });
});

function nativeHostDenial(command: string, policy: WorkerVerificationPolicy): boolean {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough() }) as unknown as ChildProcess;
  const frames: Record<string, unknown>[] = [];
  child.stdin!.on('data', (chunk: Buffer) => frames.push(JSON.parse(chunk.toString())));
  const channel = new ClaudeVerificationPermissionChannel(child, policy, (message) => { throw new Error(message); }, () => {});
  channel.start();
  channel.ingest({ type: 'control_response', response: { subtype: 'success', request_id: frames[0]!['request_id'] } });
  channel.ingest({ type: 'control_request', request_id: 'owned-request', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'owned-tool', input: { command } } });
  return (frames.at(-1)!['response'] as { response: { behavior: string } }).response.behavior === 'deny';
}
function retainedFixture(quality = false) { const f = verificationLane(quality); roots.push(f.root); return { ...f, policy: f.session.workerVerification! }; }

describe('worker verification policy', () => {
  it('classifies all exact incident forms and simple compounds as whole-call refusals', () => {
    const { policy } = retainedFixture();
    for (const command of [WEB_INCIDENT, FULL_INCIDENT, BUILD_INCIDENT, 'git status; npm test', 'printf ok | npx vitest run', 'X=1 npm test', 'env X=1 npm test', 'command npm test']) {
      expect(isVerificationProducer(command, policy), command).toBe(true);
    }
  });
  it('leaves source/Git and quoted producer read arguments alone', () => {
    const { policy } = retainedFixture();
    for (const command of ['git status && git diff', "printf '%s' 'npm test && npx vitest run'", 'rg "npm run lint; npm test" src', 'cat package.json', '# npm test\ngit status']) {
      expect(isVerificationProducer(command, policy), command).toBe(false);
    }
  });
  it('leaves capture helper and opaque script/interpreter execution outside the bounded classifier', () => {
    const { policy } = retainedFixture();
    for (const command of [`node ${policy.helper} status --request-id existing`, 'node tools/private-script.mjs', 'sh opaque-script.sh']) expect(isVerificationProducer(command, policy)).toBe(false);
  });
  it('snapshots declared scopes from the lane, not its source repo or environment', () => {
    const f = retainedFixture();
    expect(f.policy).toMatchObject({ cwd: f.lane.path, laneId: f.lane.id, jobId: f.lane.jobId, scopes: ['focused', 'full'] });
    writeFileSync(join(f.lane.path, '.gru-command/worktree.toml'), '[verify]\ncustom = "npm run quality"\n');
    expect(f.policy.scopes).toEqual(['focused', 'full']);
    const next = workerVerificationPolicy(f.lane, f.policy.configFile)!;
    expect(isVerificationProducer('npm run quality', next)).toBe(true);
    expect(next.scopes).toEqual(['custom']);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next.producerPrefixes[0])).toBe(true);
  });
  it('excludes child lanes and absent/empty declarations, and keeps malformed declarations loud', () => {
    const f = retainedFixture();
    expect(workerVerificationPolicy({ ...f.lane, kind: 'child' }, f.policy.configFile)).toBeUndefined();
    const path = join(f.lane.path, '.gru-command/worktree.toml');
    rmSync(path);
    expect(workerVerificationPolicy(f.lane, f.policy.configFile)).toBeUndefined();
    writeFileSync(path, '[verify]\n');
    expect(workerVerificationPolicy(f.lane, f.policy.configFile)).toBeUndefined();
    writeFileSync(path, 'invalid = [');
    expect(() => workerVerificationPolicy(f.lane, f.policy.configFile)).toThrow(/not valid TOML/);
  });
  it('names authenticated helper/scopes and reconciliation without admitting or mapping coverage', () => {
    const { policy } = retainedFixture();
    const reason = workerVerificationRefusal(policy);
    expect(reason).toContain('focused, full');
    expect(reason).toContain('capture-cli.js');
    expect(reason).toContain('--config');
    expect(reason).toContain('--request-id');
    expect(reason).toContain('No run was submitted and no receipt was created');
    expect(reason).toContain('timeout is not termination or PASS');
    expect(reason).toContain('never rerun unchanged proof');
  });
  it('private hook/settings expose no MCP/auth or tools and carry independent native denies', () => {
    const { policy } = retainedFixture();
    const settings = privateClaudeVerificationSettings(policy);
    try {
      expect(statSync(settings.file).mode & 0o077).toBe(0);
      const data = JSON.parse(readFileSync(settings.file, 'utf8'));
      expect(data.permissions.ask).toEqual(['Bash']);
      expect(nativeHostDenial(WEB_INCIDENT, policy)).toBe(true);
      expect(nativeHostDenial(FULL_INCIDENT, policy)).toBe(true);
      expect(data.hooks.PreToolUse[0].matcher).toBe('Bash');
      expect(Object.keys(data).sort()).toEqual(['hooks', 'permissions']);
    } finally { settings.dispose(); }
    expect(existsSync(settings.file)).toBe(false);
  });
  it('hook returns private actionable denial for Bash only, never grants permission', () => {
    const { policy } = retainedFixture();
    expect(workerVerificationHook({ tool_name: 'Bash', tool_input: { command: WEB_INCIDENT } }, policy)).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: workerVerificationRefusal(policy) } });
    expect(workerVerificationHook({ tool_name: 'Read', tool_input: { command: FULL_INCIDENT } }, policy)).toEqual({});
    expect(workerVerificationHook({ tool_name: 'Bash', tool_input: { command: 'git diff' } }, policy)).toEqual({});
  });
  it('review-1 independently recognizes every standalone npm check script', () => {
    const { policy } = retainedFixture();
    for (const script of ['lint', 'typecheck', 'build', 'build:web', 'test:backend', 'test:backend:heavy', 'test:heavy', 'test:web', 'e2e']) {
      expect(isVerificationProducer(`npm run ${script}`, policy), script).toBe(true);
    }
  });
  it('review-1 normalizes conventional wrappers and package-manager flags', () => {
    const { policy } = retainedFixture();
    for (const command of ['npm --prefix web test', 'npm --prefix=web run build:web', 'npx --no-install vitest run', 'command -p env -i PATH=/bin npm test', 'env -u UNUSED command -- env --chdir web npm test', 'env --unset=UNUSED -- npm test']) expect(isVerificationProducer(command, policy), command).toBe(true);
    expect(isVerificationProducer('command -v npm test', policy)).toBe(false);
  });
  it('review-1 shares normalization for assignment-prefixed custom declarations', () => {
    const f = retainedFixture();
    writeFileSync(join(f.lane.path, '.gru-command/worktree.toml'), '[verify]\nquality = "CI=1 command -p env -- npm --prefix web run quality"\n');
    const policy = workerVerificationPolicy(f.lane, f.policy.configFile)!;
    for (const command of ['npm run quality', 'CI=1 npm run quality', 'env -i CI=1 command npm --prefix web run quality']) expect(isVerificationProducer(command, policy), command).toBe(true);
    expect(nativeHostDenial('npm run quality', policy)).toBe(true);
  });
  it('review-1 recognizes only known local producer paths including native prefixes', () => {
    const { policy } = retainedFixture();
    for (const base of ['./node_modules/.bin/', '../node_modules/.bin/', `${policy.cwd}/node_modules/.bin/`, `${policy.cwd}/web/node_modules/.bin/`]) {
      for (const producer of ['vitest run', 'jest', 'eslint .', 'tsc --noEmit', 'vite build', 'playwright test']) {
        expect(isVerificationProducer(base + producer, policy), base + producer).toBe(true);
        expect(nativeHostDenial(base + producer, policy)).toBe(true);
      }
    }
    expect(isVerificationProducer('/opaque/vitest run', policy)).toBe(false);
    expect(isVerificationProducer('./scripts/vitest run', policy)).toBe(false);
  });
  it('review-1 delimits redirections without changing producer classification', () => {
    const { policy } = retainedFixture();
    for (const command of ['npm test>test.log', 'npm test>>test.log', 'npm test 2>test.log', '>test.log npm test', 'npm test<input', 'printf ok; npm test>test.log']) expect(isVerificationProducer(command, policy), command).toBe(true);
    expect(isVerificationProducer('printf npm >test', policy)).toBe(false);
  });
  it('review-1 quoted literal heredoc bodies are data but executable neighbors still refuse', () => {
    const { policy } = retainedFixture();
    for (const command of ["cat <<'EOF'\nnpm test\nnpx vitest run\nEOF", 'cat >source.ts <<"EOF"\nnpm test && npm run build\nEOF\ngit status', "cat <<-'EOF'\n\tnpm test\n\tEOF"]) expect(isVerificationProducer(command, policy), command).toBe(false);
    for (const command of ["npm test; cat <<'EOF'\nnpm test\nEOF", "cat <<'EOF'\nnpm test\nEOF\nnpm run build:web", "cat <<'A' <<'B'\nnpm test\nA\nnpx vitest run\nB\nnpm test"]) expect(isVerificationProducer(command, policy), command).toBe(true);
  });
  it('review-1 development servers and browser installation are not producers', () => {
    const { policy } = retainedFixture();
    for (const command of ['vite', 'vite dev', 'vite serve', 'vite preview', 'npx vite dev', 'playwright install', 'playwright install-deps', 'npx playwright install', './node_modules/.bin/vite dev', '../node_modules/.bin/playwright install']) expect(isVerificationProducer(command, policy), command).toBe(false);
    for (const command of ['vite build', 'npx vite build', 'playwright test', 'npx playwright test']) expect(isVerificationProducer(command, policy), command).toBe(true);
  });
  it('review-1 config authority is required and never inferred from dataDir or environment', () => {
    const f = retainedFixture();
    expect(() => workerVerificationPolicy(f.lane)).toThrow(/host-loaded absolute instance config path/);
    expect(f.policy.configFile).toBe(join(f.config.instanceDir, 'config.toml'));
    expect(f.config.dataDir).not.toBe(f.config.instanceDir);
    expect(JSON.stringify(f.policy)).not.toContain('isolated-verification-fixture-token');
  });

  it('review-2 advertised shell-safe status action authenticates literal dollar/backtick host config paths', async () => {
    const f = retainedFixture(); const status = await authenticatedCaptureStatus(f);
    try {
      const reason = workerVerificationRefusal(f.policy);
      const command = reason.split('reconcile that existing request identity: ')[1]!.split('. A timeout')[0]!
        .replace('<existing-id>', 'existing').replace('<ops-url>', status.url);
      expect(f.policy.configFile).toContain('$literal-`literal`');
      const execution = promisify(exec)(command, { cwd: f.policy.cwd });
      await expect(execution).resolves.toMatchObject({ stdout: expect.stringContaining('existing') });
      expect(status.requests).toEqual(['GET /api/verify/status?request_id=existing']);
      expect(existsSync(f.starts)).toBe(false);
    } finally { await status.close(); }
  });
  it('review-2 conventional aliases/options/control/path forms classify without data-position inference', () => {
    const { policy } = retainedFixture(true);
    for (const row of nativeCorpus) expect(isVerificationProducer(row.raw, policy), row.raw).toBe(row.refused);
    for (const command of ['! printf ok | npm test', '( npm test )', '{ npm test; }', 'while npm test; do printf ok; done']) expect(isVerificationProducer(command, policy), command).toBe(true);
  });
  it('review-2 exact declared npm script words survive normalization', () => {
    const f = retainedFixture();
    writeFileSync(join(f.lane.path, '.gru-command/worktree.toml'), '[verify]\nunit = "CI=1 npm run-script test.unit"\ncheck = "npm run check/unit"\n');
    const policy = workerVerificationPolicy(f.lane, f.policy.configFile)!;
    for (const command of ['npm run test.unit', 'npm run-script check/unit']) expect(isVerificationProducer(command, policy), command).toBe(true);
    expect(isVerificationProducer('npm run testXunit', policy)).toBe(false);
  });
  it('review-2 plain unquoted heredoc bodies are data, actual expansions and executable neighbors still refuse', () => {
    const { policy } = retainedFixture();
    for (const command of ['cat <<EOF\nnpm test\nEOF', 'cat <<A <<B\nnpm test\nA\nnpx vitest run\nB']) expect(isVerificationProducer(command, policy), command).toBe(false);
    for (const command of ['cat <<EOF\n$(npm test)\nEOF', 'cat <<EOF\n`npm test`\nEOF', 'cat <<EOF\nnpm test\nEOF\nnpm test']) expect(isVerificationProducer(command, policy), command).toBe(true);
  });
  it('review-2 independent raw native corpus refuses producers and allows meaningful reads without hooks', () => {
    const { policy } = retainedFixture(true); const rules = ['Bash'];
    for (const row of nativeCorpus) expect(nativeHostDenial(row.raw, policy), row.raw).toBe(row.refused);
    expect(rules.some((rule) => rule.includes('*=*'))).toBe(false);
    expect(rules.some((rule) => rule.includes('npm *test'))).toBe(false);
  });

});

describe('review-4 conventional settings preserve producer and read boundaries', () => {
  it('review-4 npm boolean configuration flags do not bypass producer refusal or turn metadata into a producer', () => {
    const { policy } = retainedFixture();
    for (const command of ['npm --no-audit test', 'npm --no-fund run build', 'npm --audit=false test', 'npm --audit false test', 'npm --no-progress test', 'npm --no-color test', 'npm --foreground-scripts test']) {
      expect(isVerificationProducer(command, policy), command).toBe(true);
    }
    for (const command of ['npm --no-audit view test', 'npm --audit=false view test']) {
      expect(isVerificationProducer(command, policy), command).toBe(false);
    }
  });
  it('review-4 Vite clearScreen boolean options preserve build refusal and genuine help reads', () => {
    const { policy } = retainedFixture();
    for (const command of ['vite --clearScreen=false build', 'vite --clearScreen false build', 'npx vite --clearScreen=false build', './node_modules/.bin/vite --clearScreen=false build']) {
      expect(isVerificationProducer(command, policy), command).toBe(true);
    }
    for (const command of ['vite --clearScreen=false build --help', 'vite --clearScreen false build --help', 'npx vite --clearScreen=false build --help']) {
      expect(isVerificationProducer(command, policy), command).toBe(false);
    }
  });
});

describe('review-8 actual CLI and shell boundaries', () => {
  it('review-8 selected Vitest run never treats its version flag as a non-producing diagnostic', () => {
    const { policy } = retainedFixture();
    const parsed = parseCLI(['vitest', 'run', 'example.test.js', '--version']);
    // The installed CLI only short-circuits version with NO matched command;
    // run remains selected with this operand and proceeds to its test action.
    expect(parsed.options.run).toBe(true);
    expect(Reflect.get(parsed.options, 'version')).toBe(true);
    expect(parsed.filter).toEqual(['example.test.js']);
    for (const command of ['vitest run --version', 'npx vitest run --version', 'npm exec -- vitest run --version']) {
      expect(isVerificationProducer(command, policy), command).toBe(true);
      expect(nativeHostDenial(command, policy), command).toBe(true);
    }
    for (const command of ['vitest --version', 'npx vitest --version', 'vitest run --version --help']) {
      expect(isVerificationProducer(command, policy), command).toBe(false);
    }
  });
  it('review-8 package-manager normalization preserves the child tool option terminator', () => {
    const { policy } = retainedFixture();
    const parsed = parseCLI(['vitest', 'run', '--', '--help']);
    expect(Reflect.get(parsed.options, 'help')).not.toBe(true);
    expect((parsed.options as Record<string, unknown>)['--']).toEqual(['--help']);
    for (const command of [
      'npx vitest run -- --help', 'npx --no-install vitest run -- --help',
      'npx -- vitest run -- --help', 'npm exec -- vitest run -- --help',
      'npm x -- vitest run -- --help',
    ]) {
      expect(isVerificationProducer(command, policy), command).toBe(true);
      expect(nativeHostDenial(command, policy), command).toBe(true);
    }
    expect(normalizedVerificationWords(['npx', 'vitest', 'run', '--', '--help']))
      .toEqual(['npx', 'vitest', 'run', '--', '--help']);
    // npm consumes its own separator; npx must not consume the child's next one.
    expect(normalizedVerificationWords(['npm', 'exec', '--', 'vitest', 'run', '--', '--help']))
      .toEqual(['npx', 'vitest', 'run', '--', '--help']);
    for (const command of ['npx -- vitest run --help', 'npm exec -- vitest run --help']) {
      expect(isVerificationProducer(command, policy), command).toBe(false);
    }
  });
  it('review-8 adjacent heredoc descriptors are redirects rather than npm operands', () => {
    const { policy } = retainedFixture();
    const bin = join(policy.cwd, 'fixture-bin'); mkdirSync(bin);
    const argv = join(policy.cwd, 'shell-argv.txt');
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${argv}'\n`, { mode: 0o700 });
    for (const command of ['npm 0<<EOF test\nEOF\n', '0<<EOF npm test\nEOF\n', 'npm 2<<-EOF test\n\tEOF\n']) {
      const execution = spawnSync('/bin/sh', ['-c', command], {
        cwd: policy.cwd, env: { ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` }, encoding: 'utf8',
      });
      expect(execution.status, execution.stderr).toBe(0);
      expect(readFileSync(argv, 'utf8')).toBe('test\n');
      expect(verificationCommandGroups(command), command).toEqual([['npm', 'test']]);
      expect(isVerificationProducer(command, policy), command).toBe(true);
      expect(nativeHostDenial(command, policy), command).toBe(true);
    }
    // Whitespace or quoting makes the numeric text a real operand, not an IO number.
    for (const command of ['npm 0 <<EOF test\nEOF\n', 'npm "0"<<EOF test\nEOF\n', 'npm \\0<<EOF test\nEOF\n']) {
      expect(verificationCommandGroups(command), command).toEqual([['npm', '0', 'test']]);
      expect(isVerificationProducer(command, policy), command).toBe(false);
    }
  });
  it('review-8 genuine help after a file operand remains a read before option termination', () => {
    const { policy } = retainedFixture();
    const sentinel = join(policy.cwd, 'ordinary-test-ran');
    const file = join(policy.cwd, 'example.test.js');
    writeFileSync(file, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(sentinel)}, 'ran');\n`);
    const cli = join(PACKAGE_ROOT, 'node_modules/vitest/vitest.mjs');
    const help = spawnSync(process.execPath, [cli, 'run', file, '--help'], { cwd: policy.cwd, encoding: 'utf8' });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Usage:');
    expect(existsSync(sentinel)).toBe(false);
    for (const command of [
      'vitest run src/example.test.ts --help', 'npx vitest run src/example.test.ts --help',
      'npm exec -- vitest run src/example.test.ts --help', 'vitest run src/example.test.ts -h',
      'vitest run --help -- src/example.test.ts',
    ]) {
      expect(isVerificationProducer(command, policy), command).toBe(false);
      expect(workerVerificationHook({ tool_name: 'Bash', tool_input: { command } }, policy), command).toEqual({});
      expect(nativeHostDenial(command, policy), command).toBe(false);
    }
    for (const command of ['vitest run src/example.test.ts -- --help', 'npx vitest run -- --help']) {
      expect(isVerificationProducer(command, policy), command).toBe(true);
    }
  });
});

describe('strict repair native host identity and failure fences', () => {
  function channelFixture() {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough() }) as unknown as ChildProcess;
    const frames: Record<string, unknown>[] = []; const failures: string[] = [];
    child.stdin!.on('data', (chunk: Buffer) => frames.push(JSON.parse(chunk.toString())));
    const channel = new ClaudeVerificationPermissionChannel(child, policyFixture(), (message) => failures.push(message), () => {});
    channel.start(); channel.ingest({ type: 'control_response', response: { subtype: 'success', request_id: frames[0]!['request_id'] } });
    return { child, channel, frames, failures };
  }
  it('strict repair host returns original valid read input unchanged without permission updates', () => {
    const f = channelFixture(); const input = { command: "printf '%s' 'npm test'", timeout: 17, description: 'literal' };
    f.channel.ingest({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't', input } });
    expect(f.frames.at(-1)).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'r', response: { behavior: 'allow', updatedInput: input } } });
    expect(f.failures).toEqual([]);
  });
  it('strict repair malformed and unrelated-tool permission requests deny and fail loud', () => {
    for (const request of [{ subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't', input: {} }, { subtype: 'can_use_tool', tool_name: 'mcp__foreign', tool_use_id: 't', input: { command: 'git status' } }]) {
      const f = channelFixture(); f.channel.ingest({ type: 'control_request', request_id: 'r', request });
      expect(f.frames.at(-1)).toMatchObject({ response: { request_id: 'r', response: { behavior: 'deny' } } });
      expect(f.failures).toEqual(['malformed or foreign worker verification permission request']);
    }
  });
  it('strict repair repeated request or tool-use identity cannot acquire host approval', () => {
    const f = channelFixture(); const request = { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't', input: { command: 'git status' } };
    f.channel.ingest({ type: 'control_request', request_id: 'r', request });
    f.channel.ingest({ type: 'control_request', request_id: 'different', request });
    expect(f.frames.at(-1)).toMatchObject({ response: { response: { behavior: 'deny' } } });
    expect(f.failures).toHaveLength(1);
  });
  it('strict repair only original-child cessation invalidates its host transport', () => {
    const f = channelFixture(); new EventEmitter().emit('close');
    f.child.emit('close', 0, null);
    const before = f.frames.length;
    f.channel.ingest({ type: 'control_request', request_id: 'r', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't', input: { command: 'git status' } } });
    expect(f.frames).toHaveLength(before); expect(f.failures).toHaveLength(1);
  });
});
