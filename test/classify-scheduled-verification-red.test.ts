import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exec, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
      // Vitest keeps only the first ~40 characters of the rejected error, so
      // all the report shows of the failing command is its start — which is
      // exactly the node helper invocation awaited above.
      const shown = /^Error: promise rejected "Error: Command failed: "(.+?)… \{ …\(\d+\) \}" instead of resolving$/u.exec(message.split('\n')[0]!)?.[1];
      expect(shown, message).toBeDefined();
      expect(`${process.execPath}" "${join(dir, 'dist', 'verify', 'capture-cli.js')}" status --request-id existing`.startsWith(shown!), shown).toBe(true);
      expect(message).not.toMatch(/Cannot find module|MODULE_NOT_FOUND/u);
      const titled = (name: string) => { const r = report(message); r.testResults[0]!.assertionResults[0]!.title = `review-2 ${name}`; return r; };
      expect(classifyReviewedRed(titled(STATUS_ACTION_NAME), 2, 'fast')).toEqual([`review-2 ${STATUS_ACTION_NAME}`]);
      expect(() => classifyReviewedRed(titled('exact declared npm script words survive normalization'), 2, 'fast')).toThrow(/non-behavioral/u);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const BASELINES = ['tools/scheduled-verification-review-baseline.sh', 'tools/scheduled-verification-review2-baseline.sh'] as const;
  const BASELINE_LIB = 'tools/scheduled-verification-baseline-lib.sh';
  const repoRoot = join(import.meta.dirname, '..');
  /** A child shell that cannot be redirected to this repository by an
   * ambient git environment (a hook's GIT_DIR) and never hangs the suite. */
  /** The environment minus every `GIT_*` variable: no hook's GIT_DIR can
   * point a fixture's git at this repository. */
  const gitFree = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && !name.startsWith('GRU_HELPER_')));
  function shell(argv: readonly string[], cwd: string, tmp: string, env: NodeJS.ProcessEnv = {}) {
    const run = spawnSync('sh', argv, { cwd, encoding: 'utf8', timeout: 60_000, env: { ...gitFree(), TMPDIR: tmp, ...env } });
    expect(run.signal, `sh ${argv[0] ?? ''} finished within its timeout (signal ${String(run.signal)})`).toBeNull();
    return run;
  }
  function libCall(call: string, cwd: string, tmp: string, env: NodeJS.ProcessEnv = {}) {
    return shell(['-c', `. "$1" && ${call}`, 'lib', join(repoRoot, BASELINE_LIB)], cwd, tmp, env);
  }

  it('only the two baselines and the retained scope invoke the classifier (#358 exclusion scope)', () => {
    // The review-8 runner names the classifier's TEST file, never the
    // classifier: it never classifies RED.
    // Every tracked file in the tree (its working-tree content) — what a
    // commit can carry to CI — so a local untracked scratch file
    // never changes the answer (git grep exits 1 on no match).
    const grep = spawnSync('git', ['-C', repoRoot, 'grep', '-l', 'classify-scheduled-verification-red\\.mjs', '--', '.', ':!test/classify-scheduled-verification-red.test.ts'], { encoding: 'utf8', env: gitFree() });
    expect(grep.status, grep.stderr).toBe(0);
    const invokers = grep.stdout.split('\n').filter((line) => line !== '' && line !== 'tools/classify-scheduled-verification-red.mjs').sort();
    expect(invokers).toEqual(['.gru-command/worktree.toml', ...BASELINES].sort());
    const manifest = loadWorktreeManifest(repoRoot)!;
    expect(Object.entries(manifest.verify).filter(([, command]) => command.includes('classify-scheduled-verification-red.mjs')).map(([scope]) => scope)).toEqual(['gh315-retained-red-classify']);
  });

  it('the generating scopes cannot reach a missing compiled helper: they build it in the snapshot and refuse when it is absent (#358 exclusion evidence)', () => {
    const shallow = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim();
    if (shallow === 'true') throw new Error('fixture setup: this evidence reads pinned historical commits — fetch full history (git fetch --unshallow)');
    for (const script of BASELINES) {
      const lines = readFileSync(join(repoRoot, script), 'utf8').split(/\r?\n/u);
      const at = (line: string): number => {
        expect(lines.filter((candidate) => candidate === line), `${script} has the line ${JSON.stringify(line)} exactly once`).toHaveLength(1);
        return lines.indexOf(line);
      };
      const candidate = /^base=([0-9a-f]{40})$/mu.exec(lines.join('\n'))?.[1];
      expect(candidate, `${script} names its reviewed candidate`).toBeDefined();
      if (spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${candidate!}^{commit}`], { env: gitFree() }).status !== 0) {
        throw new Error(`fixture setup: reviewed candidate ${candidate!} is not in this clone — fetch it`);
      }
      // Abort-on-error, sources checked before the snapshot exists, into the
      // snapshot, build, the helper must exist and load, and only then tests.
      const order = [at('set -e'), lines.findIndex((line) => line.startsWith('set -- test/')), at('lib="$(dirname "$0")/scheduled-verification-baseline-lib.sh"'), at('. "$lib"'),
        at('require_pinned_sources "$base" "$regressions" "$@"'), lines.findIndex((line) => line.startsWith('d=$(mktemp -d ')), at('snapshot_candidate "$d" "$base"'),
        at('cd "$d"'), at('npm run build'), at('require_built_helper'), at('set +e'),
        lines.findIndex((line) => line.startsWith('npx vitest run'))];
      expect(order.every((index) => index > 0), `${script}: ${JSON.stringify(order)}`).toBe(true);
      expect([...order].sort((a, b) => a - b), `${script}: set -e, files, lib, sources, snapshot dir, snapshot, cd, build, helper, set +e, tests`).toEqual(order);
      // The candidate carries the helper source the build compiles, and its
      // policy names that helper inside the snapshot the build ran in.
      const show = (path: string) => execFileSync('git', ['-C', repoRoot, 'show', `${candidate!}:${path}`], { encoding: 'utf8' });
      expect(() => show('src/verify/capture-cli.ts'), `${candidate!} carries the capture helper source`).not.toThrow();
      expect(show('src/runtime/worker-verification-policy.ts')).toContain("join(PACKAGE_ROOT, 'dist/verify/capture-cli.js')");
      expect(show('src/bmad/runtime.ts')).toContain("export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');");
      // Importing the helper loads it without running it: it runs only when invoked directly.
      expect(show('src/verify/capture-cli.ts')).toContain('import.meta.url === pathToFileURL(process.argv[1]).href');
    }
  });

  it('a clone without the pinned revisions is refused by name before anything is created (#358)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'gru-shallow-baseline-'));
    try {
      execFileSync('git', ['init', '-q', join(empty, 'clone')]);
      mkdirSync(join(empty, 'tmp'));
      for (const script of BASELINES) {
        const run = shell([join(repoRoot, script)], join(empty, 'clone'), join(empty, 'tmp'));
        expect(run.status, script).toBe(2);
        expect(run.stderr, script).toMatch(/^reviewed candidate [0-9a-f]{40} is not in this clone — fetch full history \(git fetch --unshallow\)$/mu);
        expect(readdirSync(join(empty, 'tmp')), `${script} created no snapshot`).toEqual([]);
        // A copy run away from its library refuses by name.
        const stray = join(empty, 'stray.sh');
        writeFileSync(stray, readFileSync(join(repoRoot, script)));
        const strayRun = shell([stray], join(empty, 'clone'), join(empty, 'tmp'));
        expect([strayRun.status, strayRun.stderr]).toEqual([2, `cannot read ${join(empty, 'scheduled-verification-baseline-lib.sh')} — run this baseline as: sh tools/stray.sh\n`]);
      }
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it('every pinned source is checked by name: the candidate, the regressions revision, and each regression file (#358)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-pinned-sources-'));
    try {
      const repo = join(dir, 'clone'); mkdirSync(join(dir, 'tmp'));
      execFileSync('git', ['init', '-q', repo]);
      writeFileSync(join(repo, 'present.ts'), 'export {};\n');
      execFileSync('git', ['-C', repo, '-c', 'user.name=gru', '-c', 'user.email=gru@example.test', 'add', 'present.ts']);
      execFileSync('git', ['-C', repo, '-c', 'user.name=gru', '-c', 'user.email=gru@example.test', 'commit', '-q', '-m', 'pinned']);
      const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const absent = '0123456789abcdef0123456789abcdef01234567';
      const check = (args: string) => libCall(`require_pinned_sources ${args}`, repo, join(dir, 'tmp'));
      const regressions = check(`${head} ${absent} present.ts`);
      expect(regressions.status).toBe(2);
      expect(regressions.stderr).toBe(`regressions revision ${absent} is not in this clone — fetch full history (git fetch --unshallow)\n`);
      const file = check(`${head} ${head} present.ts 'missing file.ts'`);
      expect(file.status).toBe(2);
      expect(file.stderr).toBe(`pinned regression file missing file.ts is missing at ${head} — fetch full history (git fetch --unshallow)\n`);
      const present = check(`${head} ${head} present.ts`);
      expect([present.status, present.stderr]).toEqual([0, '']);
      // A suffixed plain revision is still one.
      expect(check(`${head}~0 ${head}^0 present.ts`)).toMatchObject({ status: 0, stderr: '' });
      // Its own arguments are checked by name too.
      const short = check(`${head} ${head}`);
      expect([short.status, short.stderr]).toEqual([2, 'require_pinned_sources needs a candidate, a regressions revision and at least one file (got 2 arguments)\n']);
      expect(check(`${head} ${head} present.ts ''`).stderr).toBe('require_pinned_sources was given an empty file name\n');
      expect(check(`'' ${head} present.ts`).stderr).toBe('require_pinned_sources was given a candidate revision that is empty or not a plain revision: ""\n');
      expect(check(`${head} '' present.ts`).stderr).toBe('require_pinned_sources was given a regressions revision that is empty or not a plain revision: ""\n');
      // A revision git would read as an option is never handed to it.
      expect(check(`--output=/tmp/x ${head} present.ts`).stderr).toBe('require_pinned_sources was given a candidate revision that is empty or not a plain revision: "--output=/tmp/x"\n');
      for (const odd of ['a b', 'HEAD:secret', 'abc*', 'a..b', 'a...b', '^x']) {
        expect(check(`'${odd}' ${head} present.ts`).stderr, odd).toBe(`require_pinned_sources was given a candidate revision that is empty or not a plain revision: "${odd}"\n`);
      }
      // The snapshot is the candidate's tree, with no archive left behind...
      const snapshot = join(dir, 'tmp', 'snap'); mkdirSync(snapshot);
      const made = libCall(`snapshot_candidate '${snapshot}' ${head}`, repo, join(dir, 'tmp'));
      expect([made.status, made.stderr, readdirSync(snapshot), readdirSync(join(dir, 'tmp'))]).toEqual([0, '', ['present.ts'], ['snap']]);
      // Its target must be an existing, empty directory — never one it would wrongly remove.
      const occupied = join(dir, 'occupied'); mkdirSync(occupied); writeFileSync(join(occupied, 'keep'), 'x');
      expect(libCall(`snapshot_candidate '${occupied}' ${head}`, repo, join(dir, 'tmp')).stderr).toBe(`snapshot directory ${occupied} must be an existing, empty, real directory\n`);
      expect(readdirSync(occupied)).toEqual(['keep']);
      expect(libCall(`snapshot_candidate '${join(dir, 'absent')}' ${head}`, repo, join(dir, 'tmp')).stderr).toBe(`snapshot directory ${join(dir, 'absent')} must be an existing, empty, real directory\n`);
      // A linked target is refused: a failure would remove only the link, never the partial tree.
      const target = join(dir, 'link-target'); mkdirSync(target); symlinkSync(target, join(dir, 'linked'));
      for (const linked of [join(dir, 'linked'), `${join(dir, 'linked')}/`, `${join(dir, 'linked')}//`, `${join(dir, 'linked')}/.`]) {
        const refused = libCall(`snapshot_candidate '${linked}' ${head}`, repo, join(dir, 'tmp'));
        expect([refused.status, refused.stderr], linked).toEqual([2, `snapshot directory ${linked} must be an existing, empty, real directory\n`]);
      }
      expect(lstatSync(join(dir, 'linked')).isSymbolicLink() && statSync(target).isDirectory()).toBe(true);
      expect(libCall(`snapshot_candidate '' ${head}`, repo, join(dir, 'tmp')).stderr).toBe('snapshot_candidate needs a snapshot directory and a candidate\n');
      expect(libCall(`snapshot_candidate '${target}' -x`, repo, join(dir, 'tmp')).stderr).toBe('snapshot_candidate was given a candidate that is empty or not a plain revision: "-x"\n');
      // ...and a failed archive removes the partial snapshot and refuses by name.
      const fresh = join(dir, 'tmp', 'fresh'); mkdirSync(fresh);
      const failed = libCall(`snapshot_candidate '${fresh}' ${absent}`, repo, join(dir, 'tmp'));
      expect(failed.status).toBe(2);
      expect(failed.stderr).toMatch(new RegExp(`reviewed candidate ${absent} could not be archived into .*fresh — refusing\\n$`, 'u'));
      expect(readdirSync(join(dir, 'tmp'))).toEqual(['snap']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the built helper must exist, be non-empty and load — a broken helper is refused, a loadable one is never run (#358)', () => {
    // Real path: the shell's $PWD never names a symlinked tmpdir.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gru-built-helper-')));
    try {
      const snapshot = join(dir, 'snapshot'); mkdirSync(join(snapshot, 'dist', 'verify'), { recursive: true }); mkdirSync(join(dir, 'tmp'));
      writeFileSync(join(snapshot, 'package.json'), '{"type":"module"}\n');
      const helper = join(snapshot, 'dist', 'verify', 'capture-cli.js');
      // The real-build case below needs this tree's build; say so before anything else.
      if (!existsSync(join(repoRoot, 'dist', 'verify', 'capture-cli.js'))) throw new Error('fixture setup: this tree has no build — run npm run build first');
      const guard = () => libCall('require_built_helper', snapshot, join(dir, 'tmp'));
      const missing = guard();
      expect(missing.status).toBe(2);
      expect(missing.stderr).toBe(`the build did not emit dist/verify/capture-cli.js — a missing helper would read as behavioral RED; refusing (check the build output; snapshot kept at ${snapshot})\n`);
      writeFileSync(helper, '');
      expect(guard().status, 'an empty helper').toBe(2);
      writeFileSync(helper, "import './scheduler.js';\n");
      const broken = guard();
      expect(broken.status).toBe(2);
      expect(broken.stderr).toMatch(/ERR_MODULE_NOT_FOUND[\s\S]*the built dist\/verify\/capture-cli\.js does not load cleanly — a broken helper would read as behavioral RED; refusing \(snapshot kept at /u);
      writeFileSync(join(snapshot, 'dist', 'verify', 'scheduler.js'), 'export {};\n');
      // Loading runs no CLI: the helper acts only when invoked directly.
      writeFileSync(helper, "import './scheduler.js';\nif (process.argv[1] !== undefined) { console.error('ran'); process.exit(9); }\n");
      const loaded = guard();
      expect([loaded.status, loaded.stderr]).toEqual([0, '']);
      // A helper that exits while loading, or never finishes loading, is refused.
      writeFileSync(helper, 'process.exit(0);\n');
      expect(guard().stderr).toMatch(/does not load cleanly/u);
      // A hang is bounded whether it waits, spins synchronously, ignores
      // SIGTERM, or leaves a descendant holding its output open.
      for (const body of [
        'setInterval(() => {}, 1000);\nawait new Promise(() => {});\n',
        'for (;;) {}\n',
        "process.on('SIGTERM', () => {});\nfor (;;) {}\n",
        // A descendant holds the helper's output open: the bound still holds,
        // and the descendant goes with the helper (checked below).
        `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'ignore'] });\nwriteFileSync(${JSON.stringify(join(dir, 'kid.pid'))}, String(kid.pid));\nsetInterval(() => {}, 1000);\nawait new Promise(() => {});\n`,
      ]) {
        writeFileSync(helper, body);
        const started = Date.now();
        const hung = libCall('require_built_helper', snapshot, join(dir, 'tmp'), { GRU_HELPER_LOAD_MS: '300' });
        expect(Date.now() - started, body).toBeLessThan(8000);
        expect(hung.status, body).toBe(2);
        expect(hung.stderr, body).toMatch(/the helper did not finish loading within 300 ms[\s\S]*does not load cleanly/u);
      }
      // The descendant did not outlive the refusal.
      const pidOf = (file: string): number => {
        const pid = Number(readFileSync(file, 'utf8'));
        expect(Number.isSafeInteger(pid) && pid > 1, `${file} holds a real pid`).toBe(true);
        return pid;
      };
      const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const gone = (pid: number): boolean => { const deadline = Date.now() + 5000; while (alive(pid) && Date.now() < deadline) execFileSync('sleep', ['0.1']); return !alive(pid); };
      expect(gone(pidOf(join(dir, 'kid.pid'))), 'the load\'s descendant was killed with it').toBe(true);
      // ...and neither does one left behind by a load that finished cleanly.
      writeFileSync(join(snapshot, 'dist', 'verify', 'scheduler.js'), 'export {};\n');
      writeFileSync(helper, `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nconst kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });\nwriteFileSync(${JSON.stringify(join(dir, 'left.pid'))}, String(kid.pid));\n`);
      expect(guard()).toMatchObject({ status: 0, stderr: '' });
      expect(gone(pidOf(join(dir, 'left.pid'))), 'a cleanly loaded helper leaves nothing running').toBe(true);
      // No load leaves its temporary directory behind.
      expect(readdirSync(join(dir, 'tmp')).filter((name) => name.startsWith('gru-helper-load-'))).toEqual([]);
      // A helper that prints while loading — even a partial line — still loads.
      writeFileSync(helper, "import './scheduler.js';\nconsole.log('loading capture helper');\nprocess.stdout.write('no newline');\n");
      expect(guard()).toMatchObject({ status: 0, stderr: '' });
      // The bound itself is a whole number from 1 to 3600000 — never one that disables it.
      for (const bound of ['soon', '0', '00', '0000300', '-5', '1.5', '3600001', '99999999', '99999999999999999999999']) {
        expect(libCall('require_built_helper', snapshot, join(dir, 'tmp'), { GRU_HELPER_LOAD_MS: bound }).stderr, bound)
          .toBe(`GRU_HELPER_LOAD_MS must be a whole number of milliseconds from 1 to 3600000, without leading zeros (got "${bound}")\n`);
      }
      // The real compiled helper (this tree's build) loads without running.
      const real = libCall('require_built_helper', repoRoot, join(dir, 'tmp'));
      expect([real.status, real.stderr]).toEqual([0, '']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the status title the classifier allows is the real status regression\'s title', () => {
    // Built in parts so the suite-shape counter never mistakes it for a registration.
    const registration = ['it', `('review-2 ${STATUS_ACTION_NAME}'`].join('');
    expect(readFileSync(join(repoRoot, 'test/worker-verification-policy.test.ts'), 'utf8')).toContain(registration);
  });

  it('a wrapped rejection is accepted only as Vitest renders it: nothing after "resolving" on its line', () => {
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
