import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_REVIEW_EXECUTABLE_PATHS } from '../src/runtime/review-executable-paths.js';
import { reviewRuntimeVersion } from '../src/runtime/review-build-identity.js';
import { createHash } from 'node:crypto';

/**
 * tools/prune-stale-dist.mjs contract. `tsc` never deletes outputs of a
 * removed source, and `gru roll` rebuilds the deploy clone in place
 * (no clean), so a deleted module's dist/*.js survived every roll until the
 * Perkins runtime fingerprint refused it as "an unproven executable path"
 * (owner incident 2026-10-07: dist/dispatch/perkins-review/hybrid.js). The
 * build must prune exactly those orphans — never a live output, never a
 * build-written extra, never through a symlink — and fail loud without dist/.
 */

const repoRoot = resolve(import.meta.dirname, '..');
const TOOL = join(repoRoot, 'tools', 'prune-stale-dist.mjs');

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-prune-stale-dist-'));
  created.push(dir);
  return dir;
}

function touch(root: string, path: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `// ${path}\n`);
}

function runTool(root: string) {
  return spawnSync(process.execPath, [TOOL, root], { encoding: 'utf-8' });
}

describe('prune-stale-dist', () => {
  it('audits every live compiler output name in the finite runtime catalog', () => {
    const outputs = readdirSync(join(repoRoot, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((path) => path.endsWith('.ts') && !path.endsWith('.d.ts'))
      .map((path) => `dist/${path.slice(0, -3)}.js`);
    const unaudited = outputs.filter((path) => !PUBLIC_REVIEW_EXECUTABLE_PATHS.has(path));
    expect(unaudited).toEqual([]);
  });
  it('catalogs exactly the live handoff executable and includes its bytes in identity while refusing unknown paths (contained B)', () => {
    expect(PUBLIC_REVIEW_EXECUTABLE_PATHS.has('dist/worktrees/handoff.js')).toBe(true);
    // GH270's handoff path plus main's supervision and scheduled-verification
    // helpers. PR312 adds the managed-names and runtime repository helpers;
    // PR289 the publication-evidence module; #382 its shared git-env module
    // (dist/git-env.js); #379/#380 the shared one-line error text
    // (dist/property/error-text.js); #364/#367 the shared line-safe escape
    // (dist/dispatch/line-safe.js); #424 the Claude directive permission
    // channel (dist/runtime/claude-directive.js); #427 the six onboarding
    // modules (dist/onboarding/*.js), then the onboarding proof
    // (dist/onboarding/proof.js), the shared credential redaction it
    // and the Perkins publication use (dist/redaction.js), and the proof
    // record its one reader lives in, which the ledger reads too
    // (dist/onboarding/proof-record.js); #429 the intake breakdown and
    // slicing modules (dist/intake/breakdown.js, dist/intake/slicing.js);
    // then lane slimming's shared reclaim checks (dist/worktrees/reclaim.js)
    // and the report-lane slimmer (dist/worktrees/slimming.js); #427 PR 2b
    // expiry and the moved-repository follow-through
    // (dist/maintenance/expiry.js, dist/maintenance/repo-moves.js) and
    // gru-service reset (dist/cli/reset.js) and its lock name, which the
    // ledger reads without loading SQLite (dist/ledger/reset-lock.js); #427
    // PR 3 the disk view, budget and floor (dist/maintenance/disk.js);
    // #351 the board's raid counts (dist/vector/board.js); #444 the
    // verdict-publication-identity prerequisite check
    // (dist/dispatch/verdict-publication-identity.js); #453 the durable
    // creation receipt the worktree manager writes before its ref
    // transaction (dist/worktrees/creation-intent.js); #446 the
    // default-branch CI alert (dist/repos/default-branch-ci.js); #455 the job
    // execution stop that proves (or refuses to claim) producer cessation
    // (dist/dispatch/job-stop.js); #463 the `gru` operator subcommands
    // (dist/cli/operator.js); #464 the review-owner dead-host proof
    // (dist/runtime/review-host-exit.js).
    expect(PUBLIC_REVIEW_EXECUTABLE_PATHS.size).toBe(5223);
    expect(createHash('sha256').update(`${[...PUBLIC_REVIEW_EXECUTABLE_PATHS].sort().join('\n')}\n`).digest('hex'))
      .toBe('6df0c455c38e87a3128e460a0a92ea4310720cb988e06796c6ccc5a760a816d4');
    const root = fixtureRoot();
    touch(root, 'src/worktrees/handoff.ts'); touch(root, 'dist/worktrees/handoff.js');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: {} }));
    writeFileSync(join(root, 'dist/review-dependency-identity.json'), JSON.stringify({ schemaVersion: 1, dependencySha256: 'a'.repeat(64) }));
    const pruned = runTool(root);
    expect(pruned.status, pruned.stderr).toBe(0); expect(existsSync(join(root, 'dist/worktrees/handoff.js'))).toBe(true);
    const original = reviewRuntimeVersion(root);
    writeFileSync(join(root, 'dist/worktrees/handoff.js'), '// changed handoff executable\n');
    const changed = reviewRuntimeVersion(root); expect(changed).not.toBe(original);
    touch(root, 'dist/worktrees/unregistered-handoff.js');
    expect(() => reviewRuntimeVersion(root)).toThrow(/unproven executable path/);
    rmSync(join(root, 'dist/worktrees/unregistered-handoff.js'));
    expect(reviewRuntimeVersion(root)).toBe(changed);
  });
  it('removes every tsc output whose source is gone, and the directories it empties', () => {
    const root = fixtureRoot();
    touch(root, 'src/main.ts');
    for (const output of ['main.js', 'main.js.map', 'main.d.ts']) touch(root, `dist/${output}`);
    for (const output of ['hybrid.js', 'hybrid.js.map', 'hybrid.d.ts']) {
      touch(root, `dist/dispatch/perkins-review/${output}`);
    }
    touch(root, 'dist/retired/old.js');

    const result = runTool(root);

    expect(result.status, result.stderr).toBe(0);
    for (const output of ['hybrid.js', 'hybrid.js.map', 'hybrid.d.ts']) {
      expect(existsSync(join(root, 'dist/dispatch/perkins-review', output))).toBe(false);
      expect(result.stdout).toContain(
        `removed dist/dispatch/perkins-review/${output} (src/dispatch/perkins-review/hybrid.ts no longer exists)`,
      );
    }
    expect(existsSync(join(root, 'dist/dispatch'))).toBe(false);
    expect(existsSync(join(root, 'dist/retired'))).toBe(false);
    expect(result.stdout).toContain('removed 4 stale output(s)');
  });

  it('keeps live outputs and the files the build writes itself', () => {
    const root = fixtureRoot();
    touch(root, 'src/runtime/review-build-identity.ts');
    touch(root, 'src/runtime/review-mcp-server.mjs');
    const kept = [
      'dist/runtime/review-build-identity.js',
      'dist/runtime/review-build-identity.js.map',
      'dist/runtime/review-build-identity.d.ts',
      'dist/runtime/review-mcp-server.mjs',
      'dist/build-rev.json',
      'dist/review-dependency-identity.json',
    ];
    for (const path of kept) touch(root, path);

    const result = runTool(root);

    expect(result.status, result.stderr).toBe(0);
    for (const path of kept) expect(existsSync(join(root, path)), path).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('never follows or removes a symlink inside dist', () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    touch(outside, 'victim.js');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    symlinkSync(outside, join(root, 'dist', 'linked-dir'), 'dir');
    symlinkSync(join(outside, 'victim.js'), join(root, 'dist', 'linked.js'));

    const result = runTool(root);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(outside, 'victim.js'))).toBe(true);
    expect(existsSync(join(root, 'dist', 'linked-dir'))).toBe(true);
    expect(existsSync(join(root, 'dist', 'linked.js'))).toBe(true);
  });

  it('fails loud when dist or src is missing', () => {
    const noDist = fixtureRoot();
    mkdirSync(join(noDist, 'src'));
    const distResult = runTool(noDist);
    expect(distResult.status).toBe(1);
    expect(distResult.stderr).toContain('is not a directory — run tsc before pruning');

    const noSrc = fixtureRoot();
    touch(noSrc, 'dist/main.js');
    const srcResult = runTool(noSrc);
    expect(srcResult.status).toBe(1);
    expect(srcResult.stderr).toContain('refusing to prune without sources');
    expect(existsSync(join(noSrc, 'dist/main.js'))).toBe(true);
  });

  it('runs in the build right after tsc, before any step that reads dist', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    const steps = pkg.scripts.build!.split(' && ');
    expect(steps[0]).toBe('tsc');
    expect(steps[1]).toBe('node tools/prune-stale-dist.mjs .');
  });
});
