import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exec, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      const rejection = await expect(promisify(exec)(`node "${join(dir, 'dist', 'verify', 'capture-cli.js')}" status --request-id existing`, { cwd: dir }))
        .resolves.toMatchObject({ stdout: expect.stringContaining('existing') }).then(() => null, (error: unknown) => error as Error);
      expect(rejection).not.toBeNull();
      const message = rejection!.stack ?? String(rejection);
      // Vitest truncates the rejected value: no stderr, nothing that names
      // the missing module — so the report cannot tell setup from behavior,
      // and the generating scopes must exclude it (next test).
      expect(message).toMatch(/^Error: promise rejected "Error: Command failed: node "/u);
      expect(message).not.toMatch(/Cannot find module|MODULE_NOT_FOUND/u);
      const titled = (name: string) => { const r = report(message); r.testResults[0]!.assertionResults[0]!.title = `review-2 ${name}`; return r; };
      expect(classifyReviewedRed(titled(STATUS_ACTION_NAME), 2, 'fast')).toEqual([`review-2 ${STATUS_ACTION_NAME}`]);
      expect(() => classifyReviewedRed(titled('exact declared npm script words survive normalization'), 2, 'fast')).toThrow(/non-behavioral/u);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the generating scopes cannot reach a missing compiled helper: they build it before any test runs (#358 exclusion evidence)', () => {
    const root = join(import.meta.dirname, '..');
    for (const script of ['tools/scheduled-verification-review-baseline.sh', 'tools/scheduled-verification-review2-baseline.sh']) {
      const text = readFileSync(join(root, script), 'utf8');
      const candidate = /^base=([0-9a-f]{40})$/mu.exec(text)?.[1];
      expect(candidate, `${script} names its reviewed candidate`).toBeDefined();
      // The build runs under `set -e` (a failed build aborts the scope) and
      // strictly before the first test run.
      const strict = text.indexOf('\nset -e\n'); const build = text.indexOf('\nnpm run build\n');
      const lenient = text.indexOf('\nset +e\n'); const firstRun = text.indexOf('\nnpx vitest run');
      expect([strict, build, lenient, firstRun].every((at) => at > 0), script).toBe(true);
      expect(strict < build && build < lenient && lenient < firstRun, `${script}: set -e, build, set +e, then tests`).toBe(true);
      // The candidate carries the helper source the build compiles...
      const show = (path: string) => execFileSync('git', ['-C', root, 'show', `${candidate!}:${path}`], { encoding: 'utf8' });
      expect(() => show('src/verify/capture-cli.ts'), `${candidate!} carries the capture helper source`).not.toThrow();
      // ...and its policy names that helper inside the snapshot the build ran in.
      expect(show('src/runtime/worker-verification-policy.ts')).toContain("join(PACKAGE_ROOT, 'dist/verify/capture-cli.js')");
      expect(show('src/bmad/runtime.ts')).toContain("export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');");
    }
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
