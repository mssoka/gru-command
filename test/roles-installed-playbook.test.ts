import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBuildInfo } from '../src/build-info.js';

/**
 * Installed-layout playbook regression (owner ruling 2026-10-02, j-745;
 * clarification j-761): the minion-owned build-workflow playbook must reach
 * a CLEAN INSTALLATION through the SHIPPED artifact and its normal
 * prompt-loading path — never through this developer checkout, the local
 * journal, home paths, or global custom instructions. The policy selects
 * the task-relevant BMAD skills from the PROJECT's actual installed skill
 * catalog and metadata, so it survives a BMAD release that renames or
 * replaces its skills. The test stages an installed-package layout
 * (compiled dist + the shipped roles/ and resources/ trees + the
 * dependency tree) in an isolated temp dir, then loads `dist/roles.js`
 * FROM THAT LAYOUT in a child node process whose HOME points at an empty
 * temp home. The assertions fail on the pre-change prompt text and pass
 * on the packaged instructions.
 */

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

interface StagedPrompt {
  readonly minion: string;
  readonly silas: string;
  readonly gru: string;
  /** The packaged ops-dispatch skill body, loaded through the shipped
   *  loader (null only if the staged install genuinely lacks it). */
  readonly opsSkill: string | null;
  /** The assembled Silas operating brief (brief + skills) from the staged
   *  install — the composition a real session receives. */
  readonly silasBrief: string;
  readonly loadError?: undefined;
}
interface StagedFailure {
  readonly minion?: undefined;
  readonly silas?: undefined;
  readonly gru?: undefined;
  readonly loadError: string;
}

/** Stage an installed-package layout: exactly the trees a package install
 *  carries (dist/, roles/, resources/, package.json, node_modules), no
 *  source, no workspace state. `withRoles: false` simulates a broken
 *  install whose persona files are missing. */
function stageInstalledLayout(withRoles: boolean): string {
  if (!existsSync(join(repoRoot, 'dist', 'roles.js'))) {
    throw new Error(
      'dist/roles.js is missing — run `npm run build` first; this regression ' +
        'imports the SHIPPED compiled artifact, never the TypeScript source',
    );
  }
  assertDistCurrent();
  const root = temp('gru-command-installed-');
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
    name: string;
    version: string;
  };
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module' }, null, 2),
  );
  cpSync(join(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });
  cpSync(join(repoRoot, 'resources'), join(root, 'resources'), { recursive: true });
  if (withRoles) cpSync(join(repoRoot, 'roles'), join(root, 'roles'), { recursive: true });
  symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

/** The compiled `dist/` this regression imports must be the CURRENT
 *  candidate's build: a stale dist from an older revision would let the
 *  gate green over code that is not the head under test. The full
 *  verification chain (`npm test`) rebuilds before vitest; a focused scope
 *  must not run on an older build. Tarball / non-git trees (the baseline
 *  snapshot) have no HEAD to compare and keep the existence check only. */
function assertDistCurrent(): void {
  // Tarball / baseline snapshots carry no checkout: keep the existence
  // check only there. A real checkout that cannot resolve HEAD is a broken
  // guard, not an excuse to skip the staleness check — fail loud.
  if (!existsSync(join(repoRoot, '.git'))) return;
  let head: string;
  try {
    head = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch (error) {
    throw new Error(
      `cannot resolve HEAD for the stale-dist guard in ${repoRoot}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The staged layout copies roles/, resources/, and package.json from the
  // working tree, and the compiled dist/ loader code derives from the
  // loader sources: a dirty checkout at the same HEAD would green over
  // uncommitted prompt text or a loader change that dist/ does not carry,
  // so refuse those inputs explicitly (bmad-review 4af6aab: src/roles.ts
  // and the ops-skill loader are compiled loader inputs, not just dist
  // consumers).
  const dirty = execFileSync(
    'git',
    [
      '-C', repoRoot, 'status', '--porcelain', '--',
      'roles', 'resources', 'package.json',
      'src/roles.ts', 'src/dispatch/silas-driver.ts',
    ],
    { encoding: 'utf-8' },
  ).trim();
  if (dirty !== '') {
    throw new Error(
      `the installed-layout gate inputs are dirty: ${dirty.split('\n').join('; ')} — commit before running this scope`,
    );
  }
  const built = readBuildInfo(repoRoot).rev;
  if (built !== head) {
    throw new Error(
      `dist/ is stale for this gate: built rev ${built ?? 'unknown'}, HEAD ${head}. ` +
        'Run the full verification gate (it rebuilds) before this focused scope.',
    );
  }
}

/** Run `probe.mjs` inside the staged install under an EMPTY home, so the
 *  load cannot lean on the developer checkout's source, the journal, or
 *  user config. Module resolution goes through the node_modules tree every
 *  real install carries (symlinked to this checkout's dependency tree —
 *  the dependencies themselves, not this repo's source). */
function runProbe(installedRoot: string): StagedPrompt | StagedFailure {
  const emptyHome = temp('gru-command-installed-home-');
  mkdirSync(join(emptyHome, '.pi', 'agent'), { recursive: true });
  writeFileSync(
    join(installedRoot, 'probe.mjs'),
    [
      'try {',
      '  const { ROLE_DEFINITIONS } = await import("./dist/roles.js");',
      '  const { loadSilasSkills, silasBriefSections } = await import("./dist/dispatch/silas-driver.js");',
      '  const skills = loadSilasSkills();',
      '  const opsSkill = skills.find((skill) => skill.name === "ops-dispatch");',
      '  process.stdout.write(JSON.stringify({',
      '    minion: ROLE_DEFINITIONS.minion.systemPrompt,',
      '    silas: ROLE_DEFINITIONS.silas.systemPrompt,',
      '    gru: ROLE_DEFINITIONS.gru.systemPrompt,',
      '    opsSkill: opsSkill === undefined ? null : opsSkill.body,',
      '    silasBrief: silasBriefSections({ skills, ops: { baseUrl: "http://127.0.0.1:1", configPath: "/tmp/merge-authority-probe-config" } }).join("\\n"),',
      '  }));',
      '} catch (error) {',
      '  process.stdout.write(JSON.stringify({ loadError: String(error && error.message ? error.message : error) }));',
      '}',
      '',
    ].join('\n'),
  );
  const stdout = execFileSync(process.execPath, [join(installedRoot, 'probe.mjs')], {
    cwd: installedRoot,
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: emptyHome,
      PI_CODING_AGENT_DIR: join(emptyHome, '.pi', 'agent'),
    },
  });
  const parsed = JSON.parse(stdout) as StagedPrompt | StagedFailure;
  if (parsed.loadError !== undefined) return parsed;
  if (typeof parsed.minion !== 'string' || typeof parsed.silas !== 'string' || typeof parsed.gru !== 'string' ||
    typeof parsed.silasBrief !== 'string' || (parsed.opsSkill !== null && typeof parsed.opsSkill !== 'string')) {
    throw new Error(`unexpected probe output: ${stdout.slice(0, 200)}`);
  }
  return parsed;
}

/** A representative RENAMED/REPLACEMENT project skill catalog (owner
 *  clarification j-761): BMAD versions may rename or replace their skills,
 *  so the shipped policy selects by the project's ACTUAL installed catalog
 *  and metadata — never by a name remembered from this release. Each
 *  fixture entry mirrors a real install's runtime skill folder
 *  (`.agents/skills/<name>/SKILL.md` with `name`/`description` front
 *  matter). */
function stageSkillCatalogEntry(projectRoot: string, name: string, description: string): void {
  const skillDir = join(projectRoot, '.agents', 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: '${description}'`, '---', '', `# ${name}`, '', 'Follow the workflow this skill points to.', ''].join('\n'),
  );
}

/** Deterministic reading of the selection contract over a staged catalog:
 *  the installed skill folders' `SKILL.md` front-matter metadata is the
 *  matrix; the task-relevant entry is the one whose description covers
 *  implementation work — never one remembered by name. */
function selectImplementationSkills(projectRoot: string): string[] {
  const skillsRoot = join(projectRoot, '.agents', 'skills');
  return readdirSync(skillsRoot)
    .filter((name) => {
      const entry = readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf-8');
      const front = /^---\nname: .+\ndescription: '([^']*)'\n---\n/u.exec(entry);
      return front !== null && front[1]!.includes('implementation work');
    })
    .sort();
}

describe('installed-layout playbook loading (shipped artifact, clean install)', () => {
  // One staged install + one probe run shared by the prompt-content tests;
  // the broken-install case stages its own (loading must fail loud there).
  let staged: StagedPrompt;
  beforeAll(() => {
    const probe = runProbe(stageInstalledLayout(true));
    if (probe.loadError !== undefined) throw new Error(`staged install failed to load: ${probe.loadError}`);
    staged = probe as StagedPrompt;
  });

  it('the package manifest ships the persona and ops-skill trees', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      files?: string[];
    };
    expect(pkg.files).toEqual(expect.arrayContaining(['roles/', 'resources/silas-skills/']));
  });

  it('the installed worker prompt carries the BMAD workflow playbook', () => {
    const flat = staged.minion.replace(/\s+/gu, ' ');
    expect(flat).toContain("your session's actual skill catalog/metadata");
    // Issue #283: the catalog includes the lane-bound GC-managed runtime,
    // which wins over same-named copies; project state stays in the project.
    expect(flat).toContain('the Gru Command-managed BMAD runtime bound to your lane');
    expect(flat).toContain('takes precedence over same-named copies');
    expect(flat).toContain('never edit the runtime directory');
    expect(flat).toContain('task-relevant BMAD skills by capability');
    expect(flat).toContain('never by a fixed skill name, a remembered file path, or a hand-maintained rename table');
    expect(flat).toContain('You own the');
    expect(flat).toContain('selected workflow end to end');
    expect(flat).toContain("fresh, context-free tracked review jobs you commission through the service's job-dispatch surface");
    expect(flat).toContain('a separate tracked job with its own session and worktree');
    // The nested-admission constraint and the loud-stop rule must travel
    // into the installed prompt.
    expect(flat).toContain('nested-admission capability gap');
    expect(flat).toContain('do not block waiting');
    expect(flat).toContain('bounded client wait');
    expect(flat).toContain('never raise or bypass the configured worker limits');
    expect(flat).toContain('"deliverable": "review"');
    expect(flat).toContain('`"parent_job_id"`');
    // j-810/j-811: the retired untracked headless-launcher wording must never return.
    expect(flat).not.toContain('pi -p');
    expect(flat).not.toContain('claude -p');
    expect(flat).not.toContain('headless print mode');
    expect(flat).toContain('an inline self-review is not a substitute');
    expect(flat).toContain('report that exact capability gap loudly');
    expect(flat).toContain('supported BMAD onboarding/discovery path');
    // The concrete onboarding surface and the fixed-name ban.
    expect(flat).toContain('the setup wizard\'s BMAD provisioning step');
    expect(flat).toContain('"GC-managed BMAD runtime" section');
    expect(flat).not.toContain('Project-local BMAD setup');
    expect(flat).toContain('no guessed rename');
    expect(flat).toContain('no hand-copied skill files');
    // Merge boundary on the worker surface (owner ruling 2026-10-10):
    // same-branch integration is ordinary worker execution; the final PR
    // merge is the owner's.
    expect(flat).toContain('merge main into your task branch');
    expect(flat).toContain('the owner performs every final PR merge');
    expect(flat).toContain('never moves a branch under an active review freeze');
    expect(flat).toContain('read-only brief that names the exact immutable head');
    expect(flat).toContain('never echo or copy');
    // Owner clarification j-761: never a fixed skill-name dependency —
    // not just the retired `bmad-build` literal.
    expect(staged.minion).not.toMatch(/bmad-[a-z][a-z-]*/u);
  });

  it('the installed ops prompt carries the minion-owned build cycle', () => {
    const flat = staged.silas.replace(/\s+/gu, ' ');
    expect(flat).toContain('Minion-owned build cycle');
    expect(flat).toContain('goal, boundaries, acceptance, verification');
    expect(flat).toContain("task-relevant BMAD skills from its session's actual skill catalog");
    expect(flat).toContain('the Gru Command-managed BMAD runtime bound to its lane');
    expect(flat).toContain('never demand a fixed skill name in a briefing');
    expect(flat).toContain('verification scheduler');
    expect(flat).toContain('do not commission a supplementary review duplicating');
    expect(flat).toContain('exact-final-head READY');
    expect(flat).toContain('NEEDS CHANGES returns to the same implementing worker');
    // Merge boundary on the installed ops prompt.
    expect(flat).toContain('The owner performs every final PR merge, in every repository');
    expect(flat).toContain('integrates main into the existing task branch');
    expect(flat).not.toContain('bmad-build');
    // Fixed build-skill names must not return on the ops surface either,
    // while the legitimate review tokens stay allowed.
    const opsTokens = [...flat.matchAll(/bmad-[a-z][a-z-]*/gu)].map((match) => match[0]);
    expect(opsTokens.every((token) => token === 'bmad-review' || token === 'bmad-review-fallback')).toBe(true);
  });

  it('the installed ops skill and assembled brief carry the worker/owner merge boundary', () => {
    expect(staged.opsSkill).not.toBeNull();
    const ops = (staged.opsSkill ?? '').replace(/\s+/gu, ' ');
    expect(ops).toContain('The owner performs every final PR merge, in every repository');
    expect(ops).toContain('merge the PR base into your task branch');
    expect(ops).toContain('never rebase, reset or force-push');
    expect(ops).toContain('`pr-conflict-rebase`');
    expect(ops).not.toContain('The chief holds merge authority');
    expect(ops).not.toContain('"directive":"rebase');
    const brief = staged.silasBrief.replace(/\s+/gu, ' ');
    expect(brief).toContain('every final PR merge');
    expect(brief).toContain('integrating main into its own task branch');
    expect(brief).toContain('fallback PASS are not that clearance');
  });

  it('a renamed/replacement project catalog still satisfies the worker contract (no fixed skill name)', () => {
    // BMAD may rename or replace its implementation skill; selection keys
    // on the project's actual catalog and the task, not a remembered name.
    // Stage that rename with an unrelated sibling entry and consume the
    // catalog as the contract describes. A fixed dependency on ANY
    // installed catalog name — the retired `bmad-build` or the renamed
    // entry — fails this test.
    const project = temp('gru-command-renamed-catalog-');
    stageSkillCatalogEntry(project, 'bmad-architecture', 'Work out and record architecture decisions in a short architecture document.');
    stageSkillCatalogEntry(
      project,
      'bmad-delivery-cycle',
      'Turns implementation work into working code, reviewed and verified — the renamed replacement entry for that capability.',
    );
    // Capability-based selection over the actual installed catalog: the
    // task-relevant entry is found by its description metadata, and the
    // unrelated sibling is not selected.
    expect(selectImplementationSkills(project)).toEqual(['bmad-delivery-cycle']);
    // The shipped worker contract names no entry from the staged catalog
    // and no bmad-* token at all, so a rename of the installed build skill
    // cannot strand the playbook. This pins name-absence plus the
    // metadata-selection clauses; it is prose, not a runtime selector.
    const flat = staged.minion.replace(/\s+/gu, ' ');
    expect(flat).toContain("your session's actual skill catalog/metadata");
    expect(flat).toContain('task-relevant BMAD skills by capability');
    expect(flat).toContain('never by a fixed skill name, a remembered file path, or a hand-maintained rename table');
    const installedNames = readdirSync(join(project, '.agents', 'skills')).sort();
    expect(installedNames).toEqual(['bmad-architecture', 'bmad-delivery-cycle']);
    for (const name of installedNames) expect(staged.minion).not.toContain(name);
    expect(staged.minion).not.toMatch(/bmad-[a-z][a-z-]*/u);
    expect(existsSync(join(project, '.agents', 'skills', 'bmad-build', 'SKILL.md'))).toBe(false);
  });

  it('installed prompts load from their own tree: no checkout paths, fail loud without roles/', () => {
    for (const prompt of [staged.minion, staged.silas, staged.gru]) {
      // The text must have come from the staged tree, not from this
      // developer checkout or any personal location.
      expect(prompt).not.toContain(repoRoot);
      expect(prompt).not.toMatch(/\/Users\//u);
      expect(prompt).not.toMatch(/\/home\//u);
      // Home-relative paths must not ship through this seam either.
      expect(prompt).not.toContain('~/');
    }
    const broken = stageInstalledLayout(false);
    const failure = runProbe(broken) as StagedFailure;
    expect(failure.loadError).toMatch(/role prompt .+ is unreadable/);
    expect(failure.loadError).toMatch(/restore it before hosting sessions/);
  });
});
