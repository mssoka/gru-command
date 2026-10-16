import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exec, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { classifyReviewedRed, STATUS_ACTION_NAME } from '../tools/classify-scheduled-verification-red.mjs';
import { loadWorktreeManifest } from '../src/worktrees/manifest.js';

const title = 'review-2 root-relative web bin paths refuse independently';
function report(message = 'AssertionError: expected true to be false') {
  return { numFailedTests: 1, numFailedTestSuites: 1, testResults: [{ assertionResults: [{ title, status: 'failed', failureMessages: [message] }] }] };
}
describe('reviewed-candidate behavioral RED custody', () => {
  it('declares portable explicit native paths and repository-relative retained proof without replay', () => {
    const manifest = loadWorktreeManifest(join(import.meta.dirname, '..'))!;
    for (const scope of ['gh315-native-early', 'scheduled-verification-native']) {
      const command = manifest.verify[scope]!;
      expect(command, scope).toContain('"$HOME/.local/bin/claude"');
      expect(command, scope).not.toMatch(/\/(?:Users|home)\//u);
    }
    const retained = manifest.verify['gh315-retained-red-classify']!;
    expect(retained).toBe('node tools/classify-scheduled-verification-red.mjs 2 _bmad-output/gate-prep/gh315-retained-review2-red/fast-results.json _bmad-output/gate-prep/gh315-retained-review2-red/heavy-results.json');
    expect(retained).not.toMatch(/vitest|npm|\/(?:Users|home)\//u);
  });
  it('accepts named behavioral assertions for both fast and heavy phases', () => {
    for (const phase of ['fast', 'heavy']) expect(classifyReviewedRed(report(), 2, phase)).toEqual([title]);
  });
  it('accepts the named authenticated status rejection matcher but not arbitrary command failures', () => {
    const r = report('Error: promise rejected "Error: Command failed" instead of resolving');
    r.testResults[0]!.assertionResults[0]!.title = 'review-2 advertised shell-safe status action authenticates literal dollar/backtick host config paths';
    expect(classifyReviewedRed(r, 2, 'fast')).toHaveLength(1);
    expect(() => classifyReviewedRed(report('Error: Command failed: missing fixture'), 2, 'fast')).toThrow(/non-behavioral/);
  });
  it('accepts a wrapped subprocess rejection only for the status action, and never a setup failure (#358)', () => {
    const status = `review-2 ${STATUS_ACTION_NAME}`;
    const wrapped = 'Error: promise rejected "Error: Command failed: node "/private/var… { …(6) }" instead of resolving';
    // Any other listed title: a wrapped subprocess rejection is not its behavioral RED.
    expect(() => classifyReviewedRed(report(wrapped), 2, 'fast')).toThrow(/non-behavioral/);
    const named = (message: string) => { const r = report(message); r.testResults[0]!.assertionResults[0]!.title = status; return r; };
    expect(classifyReviewedRed(named(wrapped), 2, 'fast')).toEqual([status]);
    // The status test's own setup guard and non-subprocess rejections are refused.
    expect(() => classifyReviewedRed(named('Error: fixture setup: compiled capture helper is missing at /x/dist/verify/capture-cli.js'), 2, 'fast')).toThrow(/non-behavioral/);
    expect(() => classifyReviewedRed(named('Error: promise rejected "TypeError: cannot read properties of undefined" instead of resolving'), 2, 'fast')).toThrow(/non-behavioral/);
  });

  it('matches the REAL Vitest rendering of a wrapped subprocess rejection — which a missing helper renders identically (#358)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-missing-helper-'));
    try {
      // Exactly what the status test awaits, against a helper that is not there.
      const rejection = await expect(promisify(exec)(`"${process.execPath}" "${join(dir, 'dist', 'verify', 'capture-cli.js')}" status --request-id existing`, { cwd: dir }))
        .resolves.toMatchObject({ stdout: expect.stringContaining('existing') }).then(() => null, (error: unknown) => error as Error);
      expect(rejection).not.toBeNull();
      const message = rejection!.stack ?? String(rejection);
      // Vitest truncates the rejected value: no stderr, nothing that names
      // the missing module — so the report cannot tell setup from behavior,
      // and the generating scopes must exclude it (next test).
      expect(message).toMatch(/^Error: promise rejected "Error: Command failed: "/u);
      expect(message).not.toMatch(/Cannot find module|MODULE_NOT_FOUND/u);
      const titled = (name: string) => { const r = report(message); r.testResults[0]!.assertionResults[0]!.title = `review-2 ${name}`; return r; };
      expect(classifyReviewedRed(titled(STATUS_ACTION_NAME), 2, 'fast')).toEqual([`review-2 ${STATUS_ACTION_NAME}`]);
      expect(() => classifyReviewedRed(titled('exact declared npm script words survive normalization'), 2, 'fast')).toThrow(/non-behavioral/u);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const BASELINES = ['tools/scheduled-verification-review-baseline.sh', 'tools/scheduled-verification-review2-baseline.sh'] as const;
  const repoRoot = join(import.meta.dirname, '..');

  it('the generating scopes cannot reach a missing compiled helper: they build it in the snapshot and refuse when it is absent (#358 exclusion evidence)', () => {
    // These two scripts generate every report the classifier judges (the
    // review-8 runner never classifies RED; the retained classify scope reads
    // the review-2 baseline's reports).
    const shallow = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim();
    if (shallow === 'true') throw new Error('fixture setup: this evidence reads pinned historical commits — fetch full history (git fetch --unshallow)');
    for (const script of BASELINES) {
      const lines = readFileSync(join(repoRoot, script), 'utf8').split('\n');
      const at = (line: string): number => {
        const index = lines.indexOf(line);
        expect(index, `${script} has the line ${JSON.stringify(line)}`).toBeGreaterThan(0);
        return index;
      };
      const candidate = /^base=([0-9a-f]{40})$/mu.exec(lines.join('\n'))?.[1];
      expect(candidate, `${script} names its reviewed candidate`).toBeDefined();
      // Abort-on-error, into the snapshot, build, the helper must exist,
      // and only then tests.
      const order = [at('set -e'), at('cd "$d"'), at('npm run build'),
        lines.findIndex((line) => line.startsWith('test -f dist/verify/capture-cli.js || {') && line.includes('exit 2')), at('set +e'),
        lines.findIndex((line) => line.startsWith('npx vitest run'))];
      expect(order.every((index) => index > 0), `${script}: ${JSON.stringify(order)}`).toBe(true);
      expect([...order].sort((a, b) => a - b), `${script}: set -e, cd, build, helper guard, set +e, tests`).toEqual(order);
      // The candidate carries the helper source the build compiles, and its
      // policy names that helper inside the snapshot the build ran in.
      const show = (path: string) => execFileSync('git', ['-C', repoRoot, 'show', `${candidate!}:${path}`], { encoding: 'utf8' });
      expect(() => show('src/verify/capture-cli.ts'), `${candidate!} carries the capture helper source`).not.toThrow();
      expect(show('src/runtime/worker-verification-policy.ts')).toContain("join(PACKAGE_ROOT, 'dist/verify/capture-cli.js')");
      expect(show('src/bmad/runtime.ts')).toContain("export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');");
    }
  });

  it('a clone without the pinned revisions is refused by name before anything is created (#358)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gru-shallow-baseline-'));
    try {
      execFileSync('git', ['init', '-q', empty]);
      for (const script of BASELINES) {
        const before = readdirSync(tmpdir()).filter((name) => name.startsWith('gru-gh315-')).length;
        const run = spawnSync('sh', [join(repoRoot, script)], { cwd: empty, encoding: 'utf8', env: { ...process.env, TMPDIR: tmpdir() } });
        expect(run.status, script).toBe(2);
        expect(run.stderr, script).toMatch(/^reviewed candidate [0-9a-f]{40} is not in this clone — fetch full history \(git fetch --unshallow\)$/mu);
        expect(readdirSync(tmpdir()).filter((name) => name.startsWith('gru-gh315-')).length, `${script} created no snapshot`).toBe(before);
      }
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it('the status title the classifier allows is the real status regression\'s title', () => {
    expect(readFileSync(join(repoRoot, 'test/worker-verification-policy.test.ts'), 'utf8')).toContain(`it('review-2 ${STATUS_ACTION_NAME}'`);
    // A wrapped rejection is accepted only as Vitest renders it: nothing after "resolving" on its line.
    const r = report('Error: promise rejected "Error: Command failed: x" instead of resolving (and more)');
    r.testResults[0]!.assertionResults[0]!.title = `review-2 ${STATUS_ACTION_NAME}`;
    expect(() => classifyReviewedRed(r, 2, 'fast')).toThrow(/non-behavioral/u);
  });

  it('rejects missing reports and missing collected suites', () => {
    for (const value of [null, {}, { testResults: [] }]) expect(() => classifyReviewedRed(value, 2, 'fast')).toThrow(/missing collected/);
  });
  it('rejects malformed reporter data', () => {
    expect(() => classifyReviewedRed({ testResults: [null] }, 2, 'fast')).toThrow();
    expect(() => classifyReviewedRed({ testResults: [{}] }, 2, 'heavy')).toThrow(/setup/);
  });
  it('rejects setup-only or import-only suite failures in either candidate phase', () => {
    for (const generation of [1, 2]) for (const phase of ['fast', 'heavy']) {
      expect(() => classifyReviewedRed({ numFailedTests: 0, numFailedTestSuites: 1, testResults: [{ assertionResults: [], message: 'Cannot find module' }] }, generation, phase)).toThrow(/setup/);
    }
  });
  it('rejects a named test that failed only by fixture or transport error', () => {
    expect(() => classifyReviewedRed(report('Error: Reviewed archive seam is absent'), 2, 'heavy')).toThrow(/non-behavioral/);
  });
  it('rejects unlisted assertion failures and unexpected passing legs', () => {
    const r = report(); r.testResults[0]!.assertionResults[0]!.title = 'unrelated assertion';
    expect(() => classifyReviewedRed(r, 2, 'fast')).toThrow(/unlisted/);
    expect(() => classifyReviewedRed({ numFailedTests: 0, testResults: [{ assertionResults: [{ title, status: 'passed' }] }] }, 2, 'heavy')).toThrow(/missing behavioral/);
  });
  it('rejects inconsistent runner counts and preserves review-1 named assertions', () => {
    const r = report(); r.numFailedTests = 2;
    expect(() => classifyReviewedRed(r, 2, 'fast')).toThrow(/inconsistent/);
    r.numFailedTests = 1; r.testResults[0]!.assertionResults[0]!.title = 'review-1 adjacent redirects refuse before any producer';
    expect(classifyReviewedRed(r, 1, 'heavy')).toHaveLength(1);
  });
});
