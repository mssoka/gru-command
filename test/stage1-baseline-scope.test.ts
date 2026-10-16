import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * GH-175: the `perkins-stage1-baseline` scope must select the intended
 * transport tests, stop with a distinct diagnostic before Vitest when a
 * prerequisite breaks, keep a genuine assertion RED visible, and refuse an
 * unexpectedly green baseline. Everything runs against throwaway fixtures;
 * no real baseline archive or Vitest run is spent.
 */
const repoRoot = join(import.meta.dirname, '..');
const verdictTool = join(repoRoot, 'tools', 'stage1-baseline-verdict.mjs');
const PINNED_BASE = '9bb51b05af5d8f0a0cd389788d1d3f19607d5361';

const scopes = (parseToml(readFileSync(join(repoRoot, '.gru-command', 'worktree.toml'), 'utf8')) as {
  verify: Record<string, string>;
}).verify;
const command = scopes['perkins-stage1-baseline']!;

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-stage1-baseline-test-'));
  cleanups.push(dir);
  return dir;
}

describe('perkins-stage1-baseline selection (#175)', () => {
  const pattern = new RegExp(/-t "([^"]+)"/.exec(command)![1]!);
  const transportTitles = [...readFileSync(join(repoRoot, 'test', 'review-mcp-transport.test.ts'), 'utf8')
    .matchAll(/^\s*it\('([^']+)'/gm)].map((match) => match[1]!);

  it('selects the join/reattach reproduction and both wait tests, from files the scope overlays', () => {
    expect(command).toContain('cp test/review-mcp-transport.test.ts "$d/test/"');
    expect(command).not.toContain('join an identical');
    const selected = transportTitles.filter((title) => pattern.test(title));
    expect(selected.some((title) => title.startsWith('joins an identical in-flight request'))).toBe(true);
    expect(selected.some((title) => title.includes('wait-expired'))).toBe(true);
    expect(selected.some((title) => title.includes('malformed wait'))).toBe(true);
    expect(selected).toHaveLength(3);
  });

  it('verifies the selection through the verdict tool with one fragment per -t alternative', () => {
    const fragments = [...command.matchAll(/baseline-report\.json"((?: "[^"]+")+)/g)][0]![1]!
      .trim().split('" "').map((fragment) => fragment.replace(/"/g, ''));
    expect(fragments).toEqual(pattern.source.split('|'));
  });
});

describe('perkins-stage1-baseline verdict tool (#175)', () => {
  function verdict(report: unknown, ...fragments: string[]) {
    const dir = scratch();
    const file = join(dir, 'report.json');
    if (report !== undefined) writeFileSync(file, JSON.stringify(report));
    return spawnSync(process.execPath, [verdictTool, file, ...fragments], { encoding: 'utf8' });
  }
  /** A matcher failure raised in the test file itself. */
  const ASSERTION = 'AssertionError: expected 1 to be 2\n    at /snapshot/test/review-mcp-transport.test.ts:10:5';
  const report = (...tests: Array<[string, 'passed' | 'failed' | 'pending', string?]>) => ({
    testResults: [{ assertionResults: tests.map(([fullName, status, message]) => ({
      fullName, status, failureMessages: status === 'failed' ? [message ?? ASSERTION] : [],
    })) }],
  });

  it('accepts a genuine assertion RED covering every fragment and names the failures', () => {
    const result = verdict(report(['suite joins an identical x', 'failed'], ['suite other', 'passed']), 'joins an identical');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('EXPECTED RED: 1 of 2');
    expect(result.stdout).toContain('RED: suite joins an identical x');
  });

  it('refuses a vacuous selection (a fragment matching only skipped or no tests) with exit 6', () => {
    const result = verdict(report(['suite wait-expired', 'failed'], ['suite joins an identical', 'pending']), 'wait-expired', 'joins an identical');
    expect(result.status).toBe(6);
    expect(result.stderr).toContain('SELECTION INCOMPLETE');
    expect(result.stderr).toContain('joins an identical');
    expect(verdict(report(), 'anything').status).toBe(6);
  });

  it('refuses a run whose failed test failed some other way than an assertion — a beforeAll setup error — with exit 5 (#360 R4-V3)', () => {
    const hook = 'Error: setup broke\n    at /snapshot/test/helpers/fixture.ts:3:9';
    const setup = verdict(report(['suite joins an identical x', 'failed', hook], ['suite joins an identical y', 'failed']), 'joins an identical');
    expect(setup.status).toBe(5);
    expect(setup.stderr).toContain('RUN BROKEN');
    expect(setup.stderr).toContain('NOT RED: suite joins an identical x');
    // An assertion raised inside a shared helper is setup too.
    const helper = verdict(report(['suite joins an identical x', 'failed', 'AssertionError: x\n    at /snapshot/test/helpers/fixture.ts:3:9']), 'joins an identical');
    expect(helper.status).toBe(5);
    // A failure with no message at all is no evidence either.
    const silent = verdict({ testResults: [{ assertionResults: [{ fullName: 'suite joins an identical x', status: 'failed', failureMessages: [] }] }] }, 'joins an identical');
    expect(silent.status).toBe(5);
  });

  it('refuses a failed run without any failing selected test, or without a report, with exit 5', () => {
    const noFailure = verdict({ numFailedTestSuites: 1, ...report(['suite joins an identical', 'passed']) }, 'joins an identical');
    expect(noFailure.status).toBe(5);
    expect(noFailure.stderr).toContain('RUN BROKEN');
    const missing = verdict(undefined, 'joins an identical');
    expect(missing.status).toBe(5);
    expect(missing.stderr).toContain('no readable Vitest JSON report');
  });
});

describe('perkins-stage1-baseline scope exit contract (#175)', () => {
  /** A throwaway repo whose HEAD commit stands in for the pinned base. */
  function fixture(patchBody: string): { repo: string; run: (npxBody?: string) => ReturnType<typeof spawnSync> } {
    const repo = scratch();
    mkdirSync(join(repo, 'tools'));
    mkdirSync(join(repo, 'test'));
    writeFileSync(join(repo, 'tools', 'patch-vitest-rpc-timeout.mjs'), patchBody);
    writeFileSync(join(repo, 'test', 'review-mcp-transport.test.ts'), '// fixture\n');
    mkdirSync(join(repo, 'node_modules'));
    const git = (...args: string[]) => {
      const out = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      expect(out.status, out.stderr).toBe(0);
      return out.stdout.trim();
    };
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    const scope = command.replace(PINNED_BASE, base).replace('"$root/tools/stage1-baseline-verdict.mjs"', JSON.stringify(verdictTool));
    expect(scope).toContain(base);
    return {
      repo,
      run: (npxBody) => {
        const bin = scratch();
        const npx = join(bin, 'npx');
        writeFileSync(npx, `#!/bin/sh\n${npxBody ?? 'echo "VITEST-WAS-RUN"; exit 0'}\n`);
        chmodSync(npx, 0o755);
        return spawnSync('sh', ['-c', scope], {
          cwd: repo,
          encoding: 'utf8',
          env: { PATH: `${bin}:${process.env.PATH ?? ''}`, TMPDIR: scratch(), HOME: process.env.HOME ?? '' },
        });
      },
    };
  }

  it('stops with exit 3 and the captured patch diagnostic BEFORE Vitest when the RPC patch fails', () => {
    const { run } = fixture('console.error("rpc patch layout unrecognized: vitest dist moved"); process.exit(2);\n');
    const result = run();
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('rpc patch layout unrecognized: vitest dist moved');
    expect(result.stdout).toContain('BASELINE PREREQUISITE FAILED (exit 3)');
    expect(result.stdout).toContain('RPC patch exited non-zero');
    expect(result.stdout).not.toContain('VITEST-WAS-RUN');
  });

  it('stops with exit 3 before Vitest when the pinned base cannot be archived', () => {
    const { repo } = fixture('process.exit(0);\n');
    const result = spawnSync('sh', ['-c', command], {
      cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TMPDIR: scratch() },
    });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('git archive of 9bb51b05af5d8f0a0cd389788d1d3f19607d5361 failed');
    expect(result.stdout).not.toContain('baseline pre-change');
  });

  it('fails loud with exit 4 when the baseline passes unexpectedly', () => {
    const { run } = fixture('process.exit(0);\n');
    const result = run('echo "VITEST-WAS-RUN"; exit 0');
    expect(result.status).toBe(4);
    expect(result.stdout).toContain('FAILS-BEFORE CLAIM BROKEN (exit 4)');
  });

  it('reports exit 5 when Vitest fails without producing a verifiable report', () => {
    const { run } = fixture('process.exit(0);\n');
    const result = run('echo "VITEST-WAS-RUN"; exit 1');
    expect(result.status).toBe(5);
    expect(result.stderr).toContain('no readable Vitest JSON report');
  });

  it('keeps a verified assertion RED visible and exits 1 (the scheduler-expected outcome)', () => {
    const { run } = fixture('process.exit(0);\n');
    const report = JSON.stringify({
      testResults: [{
        assertionResults: [
          { fullName: 'suite joins an identical in-flight request', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2\n    at /snapshot/test/review-mcp-transport.test.ts:10:5'] },
          { fullName: 'suite wait-expired tools/call', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2\n    at /snapshot/test/review-mcp-transport.test.ts:20:5'] },
          { fullName: 'suite fails loud on a malformed wait override', status: 'failed', failureMessages: ['AssertionError: expected 1 to be 2\n    at /snapshot/test/review-mcp-transport.test.ts:30:5'] },
        ],
      }],
    });
    // The stub honours --outputFile.json=<path> like the real reporter.
    const result = run(`for a in "$@"; do case "$a" in --outputFile.json=*) printf '%s' '${report}' > "\${a#--outputFile.json=}";; esac; done; exit 1`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('EXPECTED RED: 3 of 3');
    expect(result.stdout).toContain('EXPECTED-NONZERO: genuine pre-change assertion RED');
  });
});
