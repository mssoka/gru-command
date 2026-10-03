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
      '  process.stdout.write(JSON.stringify({',
      '    minion: ROLE_DEFINITIONS.minion.systemPrompt,',
      '    silas: ROLE_DEFINITIONS.silas.systemPrompt,',
      '    gru: ROLE_DEFINITIONS.gru.systemPrompt,',
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
  if (typeof parsed.minion !== 'string' && typeof parsed.loadError !== 'string') {
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
    expect(flat).toContain("explicitly select the project's installed build-workflow skill");
    expect(flat).toContain("the PROJECT's actual installed skill catalog and metadata");
    expect(flat).toContain('select by capability from what the project really has installed');
    expect(flat).toContain('never by a fixed skill name, a remembered file path, or a hand-maintained rename table');
    expect(flat).toContain('You own the selected workflow end to end');
    expect(flat).toContain("fresh, context-free tracked review jobs you commission through the service's job-dispatch surface");
    expect(flat).toContain('each reviewer is a separate tracked job with its own session and worktree');
    // Native round 1 (admission-cycle blocker): a nested reviewer dispatch
    // that cannot be admitted must stop loud, never deadlock or bypass caps.
    expect(flat).toContain('nested-admission capability gap');
    expect(flat).toContain('do not block waiting');
    expect(flat).toContain('never raise or bypass the configured worker limits');
    // j-810/j-811: the retired untracked headless-launcher wording must never return.
    expect(flat).not.toContain('pi -p');
    expect(flat).not.toContain('claude -p');
    expect(flat).not.toContain('headless print mode');
    expect(flat).toContain('never a second Gru');
    expect(flat).toContain('an inline self-review is not a substitute');
    expect(flat).toContain('report that exact capability gap loudly');
    expect(flat).toContain('supported official BMAD onboarding/discovery path');
    // Native round 2 warning: name the concrete onboarding surface.
    expect(flat).toContain('Project-local BMAD setup');
    expect(flat).toContain('no guessed rename');
    // Continuous completion contract (owner 2026-10-02).
    expect(flat).toContain('Approved work runs to its end without a new go-ahead');
    expect(flat).toContain('A failed attempt is not a destroyed undertaking');
    expect(flat).toContain('no product PR is owed');
    expect(flat).toContain('binding playbook obligations, not runtime guarantees');
    // Owner-held merge adoption on the worker surface + accepted-action
    // reconciliation for dispatched reviewer jobs.
    expect(flat).toContain('the review is the gate, and the owner holds every merge');
    expect(flat).toContain('read-only brief that names the exact immutable head');
    expect(flat).toContain('never echo it');
    expect(flat).toContain('reconcile it by job identity');
    // Owner clarification j-761: never a fixed skill-name dependency —
    // not just the retired `bmad-build` literal.
    expect(staged.minion).not.toMatch(/bmad-[a-z][a-z-]*/u);
  });

  it('the installed ops prompt carries the minion-owned build cycle', () => {
    const flat = staged.silas.replace(/\s+/gu, ' ');
    expect(flat).toContain('Minion-owned build cycle');
    expect(flat).toContain('goal, boundaries, acceptance, verification');
    expect(flat).toContain("selects the task-relevant BMAD skills from the project's actual installed catalog");
    expect(flat).toContain('never demand a fixed skill name in a briefing');
    expect(flat).toContain('verification scheduler');
    expect(flat).toContain('do not commission a supplementary review duplicating');
    expect(flat).toContain('activate the native Perkins gate on that exact final head');
    expect(flat).toContain('NEEDS CHANGES returns to the same implementing minion');
    // Continuous completion + reconciliation contract (owner 2026-10-02).
    expect(flat).toContain('Continuous completion and reconciliation');
    expect(flat).toContain('never ask the owner to say continue');
    expect(flat).toContain('awaiting-review status is not a stop reason');
    expect(flat).toContain('Reconcile accepted actions and requests before resuming');
    expect(flat).toContain('a queue timeout is not a test result');
    expect(flat).toContain('Artifact-only and investigation jobs complete at their verified artifact handback');
    expect(flat).toContain('binding playbook obligations, not implemented guarantees');
    // Owner-held merge on the reviews-are-gates standing order.
    expect(flat).toContain('an approved verdict clears the review');
    expect(flat).not.toContain('approved merges, changes-requested goes back');
    expect(flat).not.toContain('bmad-build');
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
    // The shipped worker contract is satisfied without the old name: no
    // catalog name (and no bmad-* skill token at all) is pinned in the
    // prompt, so a rename cannot strand the playbook.
    const flat = staged.minion.replace(/\s+/gu, ' ');
    expect(flat).toContain("the PROJECT's actual installed skill catalog and metadata");
    expect(flat).toContain('select by capability from what the project really has installed');
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
