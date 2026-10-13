import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WorktreeLane } from '../src/dispatch/worktree-port.js';
import { claudeTurnArgs } from '../src/runtime/claude-adapter.js';
import { claudeVerificationDenyRules, privateClaudeVerificationSettings } from '../src/runtime/claude-verification-settings.js';
import { workerVerificationExtension } from '../src/runtime/pi-adapter.js';
import { workerVerificationHook } from '../src/runtime/worker-verification-hook.js';
import {
  isVerificationProducer,
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
    const policy = policyFixture();
    const rules = claudeVerificationDenyRules(policy);
    for (const rule of [
      'Bash(npm test)', 'Bash(npm tst)', 'Bash(npm --workspace web test)', 'Bash(npx --yes vitest run)',
      'Bash(command npm test)', 'Bash(! npm test)', 'Bash(npx vitest run *)',
    ]) {
      expect(rules, rule).toContain(rule);
    }
    // Blanket tool wildcards would override a hook allow for inspection reads.
    for (const rule of ['Bash(tsc *)', 'Bash(eslint *)', 'Bash(vite build *)', 'Bash(playwright test *)']) {
      expect(rules, rule).not.toContain(rule);
    }
    expect(rules).toContain('Bash(tsc)');
    expect(rules).toContain('Bash(vite build)');
  });

  it('writes a private settings artifact the CLI can actually consume (M5)', () => {
    const policy = policyFixture();
    const settings = privateClaudeVerificationSettings(policy);
    try {
      const parsed = JSON.parse(readFileSync(settings.file, 'utf8')) as {
        permissions?: { deny?: string[] };
        hooks?: { PreToolUse?: { matcher?: string; hooks?: { type?: string; command?: string }[] }[] };
      };
      expect(parsed.permissions?.deny).toEqual(settings.denyRules);
      expect(parsed.permissions?.deny?.length ?? 0).toBeGreaterThan(0);
      const entry = parsed.hooks?.PreToolUse?.[0];
      expect(entry?.matcher).toBe('Bash');
      expect(entry?.hooks?.[0]?.type).toBe('command');
      expect(entry?.hooks?.[0]?.command).toContain('worker-verification-hook.js');
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
    const denied = decide({ type: 'tool_call', toolCallId: '1', toolName: 'bash', input: { command: INCIDENT_FORMS[1] } }) as {
      block?: boolean; reason?: string;
    };
    expect(denied.block).toBe(true);
    expect(denied.reason).toContain(policy.helper);
    expect(decide({ type: 'tool_call', toolCallId: '2', toolName: 'bash', input: { command: 'git log -1' } })).toBeUndefined();
  });

  it('carries the private deny/hook settings into a normal claude turn, never a review turn', () => {
    const policy = policyFixture();
    const settings = privateClaudeVerificationSettings(policy);
    try {
      expect(claudeVerificationDenyRules(policy)).toContain(`Bash(npm test *)`);
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
