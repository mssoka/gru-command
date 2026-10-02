import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Installed-layout playbook regression (owner ruling 2026-10-02, j-745):
 * the minion-owned bmad-build playbook must reach a CLEAN INSTALLATION
 * through the SHIPPED artifact and its normal prompt-loading path — never
 * through this developer checkout, the local journal, home paths, or
 * global custom instructions. The test stages an installed-package layout
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

  it('the installed worker prompt carries the bmad-build playbook', () => {
    const flat = staged.minion.replace(/\s+/gu, ' ');
    expect(flat).toContain("runs the PROJECT's installed `bmad-build` skill");
    expect(flat).toContain('you own its cycle end to end');
    expect(flat).toContain('fresh, context-free reviewer sessions');
    expect(flat).toContain('`pi -p` / `claude -p`');
    expect(flat).toContain('never a second Gru');
    expect(flat).toContain('an inline self-review is not a substitute');
    expect(flat).toContain('report that exact capability gap loudly');
    expect(flat).toContain('official BMAD onboarding/install path');
    expect(flat).toContain('no ad hoc development, no bundled skill snapshots');
  });

  it('the installed ops prompt carries the minion-owned build cycle', () => {
    const flat = staged.silas.replace(/\s+/gu, ' ');
    expect(flat).toContain('Minion-owned build cycle');
    expect(flat).toContain('goal, boundaries, acceptance, verification');
    expect(flat).toContain('verification scheduler');
    expect(flat).toContain('do not commission a supplementary review duplicating');
    expect(flat).toContain('activate the native Perkins gate on that exact final head');
    expect(flat).toContain('NEEDS CHANGES returns to the same implementing minion');
  });

  it('installed prompts load from their own tree: no checkout paths, fail loud without roles/', () => {
    for (const prompt of [staged.minion, staged.silas, staged.gru]) {
      // The text must have come from the staged tree, not from this
      // developer checkout or any personal location.
      expect(prompt).not.toContain(repoRoot);
      expect(prompt).not.toMatch(/\/Users\//u);
      expect(prompt).not.toMatch(/\/home\//u);
    }
    const broken = stageInstalledLayout(false);
    const failure = runProbe(broken) as StagedFailure;
    expect(failure.loadError).toMatch(/role prompt .+ is unreadable/);
    expect(failure.loadError).toMatch(/restore it before hosting sessions/);
  });
});
