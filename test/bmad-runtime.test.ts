import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { parse } from 'smol-toml';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bindBmadRuntime,
  BmadRuntimeError,
  createBmadRuntimeBinder,
  inspectMaterializedBmadRuntime,
  loadBundledBmadRuntime,
  BMAD_RUNTIME_SOURCE,
  materializeBmadRuntime,
  skillLauncherCommand,
  type MaterializedBmadRuntime,
} from '../src/bmad/runtime.js';
import { readBmadRuntimeManifest, writeBmadRuntimeManifest } from '../src/bmad/vendor.js';
import { runBmadRuntimeCli } from '../src/cli/bmad-runtime.js';
import { loadConfig, type Role, type RuntimeId } from '../src/config.js';
import { RuntimeRegistry, serviceRegistryOptions } from '../src/runtime/registry.js';
import type { AgentHandle, AgentRuntime, ManagedSkillSet, SpawnOptions } from '../src/runtime/types.js';
import type { SessionStore } from '../src/sessions/store.js';

/**
 * The GC-managed BMAD runtime (issue #283): a pinned upstream bundle plus
 * a small GC layer, rendered for a project with no BMAD installation of its
 * own, with quota-free review layers, per-project isolation, and a per-lane
 * binding that survives a newer runtime shipping.
 */

const repoRoot = join(import.meta.dirname, '..');
const bundleRoot = join(repoRoot, 'resources', 'bmad-runtime');
const FLOOR_MARKERS = [/finding floor/iu, /find at least/iu, /min\(floor\(/iu, /do not stop with an empty list/iu, /keep thinking/iu];

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) {
    // Materialized runtimes are read-only files in writable directories.
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Canonical (realpath) temp dir: the renderer resolves project roots. */
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim();
}

/** A committed repository with no BMAD state at all. */
function cleanRepo(name = 'project'): string {
  const repo = join(tempDir('gru-command-bmad-rt-'), name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'README.md'), `# ${name}\n`);
  git(repo, ['add', 'README.md']);
  git(repo, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']);
  return repo;
}

/** A copy of the shipped bundle under a scratch package root. */
function packageCopy(): string {
  const root = tempDir('gru-command-bmad-pkg-');
  cpSync(bundleRoot, join(root, 'resources', 'bmad-runtime'), { recursive: true });
  return root;
}

const emptyHome = tempDir('gru-command-bmad-home-');

interface Rendered {
  readonly status: number | null;
  readonly stdout: string;
  /** The generation directory holding the rendered workflow. */
  readonly generation: string | null;
}

/** Run the skill's OWN launcher line, as an agent would, with an empty HOME. */
function render(runtime: MaterializedBmadRuntime, projectRoot: string, skill = 'bmad-build'): Rendered {
  const launcher = skillLauncherCommand(runtime, skill, projectRoot);
  const result = spawnSync('/bin/sh', ['-c', launcher.command], {
    cwd: projectRoot,
    encoding: 'utf-8',
    env: { PATH: process.env.PATH ?? '', HOME: emptyHome, ...launcher.env },
    timeout: 110_000,
  });
  const entry = /^read and follow (\/\S+)\/workflow\.md$/mu.exec(result.stdout ?? '');
  return { status: result.status, stdout: `${result.stdout ?? ''}${result.stderr ?? ''}`, generation: entry?.[1] ?? null };
}

/** Paths, modes and bytes under `root`: any write into it changes the hash. */
function treeHash(root: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      hash.update(`${relative(root, path)}\0${info.mode}\0`);
      if (info.isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(root);
  return hash.digest('hex');
}

const shipped = loadBundledBmadRuntime(repoRoot);
const sharedStore = tempDir('gru-command-bmad-store-');
const sharedRuntime = materializeBmadRuntime(shipped, sharedStore);

describe('GC-managed BMAD runtime bundle', () => {
  it('verifies the shipped bundle and identifies upstream and customization versions', () => {
    const manifest = readBmadRuntimeManifest(bundleRoot);
    expect(shipped.id).toBe('bmad-method@6.12.0+gru-command-bmad.1');
    expect(manifest.upstream).toMatchObject({
      package: 'bmad-method',
      version: '6.12.0',
      integrity: 'sha512-gbbHo32TxCPwo4Yy70kqykFRwN5UdYqfnDKTsKAsF9m5qtLeoiCgEawj/LuzLBHLrYA0WTOyL/XWtXpgyDonMQ==',
      git_head: '05bfbd46d00766ec88eb9b42e76be2c575d64d7b',
      license: 'MIT',
    });
    expect(manifest.customization).toMatchObject({ name: 'gru-command-bmad', version: 1 });
    expect(manifest.skills).toEqual(['bmad-build']);
    // The materialized directory name carries the identity and content hash,
    // and the runtime ships the upstream license and the GC notice.
    expect(sharedRuntime.dir).toBe(join(sharedStore, `bmad-method-6.12.0-gru-command-bmad-1-${shipped.contentSha256.slice(0, 20)}`));
    expect(readFileSync(join(sharedRuntime.dir, 'LICENSE'), 'utf-8')).toContain('MIT License');
    expect(readFileSync(join(sharedRuntime.dir, 'NOTICE.md'), 'utf-8')).toContain('bmad-method');
    // Claude Code namespaces plugin skills by the manifest name; sessions are
    // told to use `<source>:<skill>`, so the two must agree, and each skill
    // must sit where Claude Code discovers plugin skills.
    const plugin = JSON.parse(readFileSync(join(sharedRuntime.dir, '.claude-plugin', 'plugin.json'), 'utf-8')) as { name: string };
    expect(plugin.name).toBe(BMAD_RUNTIME_SOURCE);
    for (const skill of sharedRuntime.skills) {
      expect(readFileSync(join(sharedRuntime.dir, 'skills', skill, 'SKILL.md'), 'utf-8')).toMatch(new RegExp(`^---\\nname: ${skill}\\n`, 'u'));
    }
    // The CLI the build runs reports the same identity.
    const lines: string[] = [];
    expect(runBmadRuntimeCli(['verify', repoRoot], (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([`BMAD runtime ${shipped.id} verified (content sha256 ${shipped.contentSha256})`]);
  });

  it('a changed, missing, undeclared or symlinked bundle file fails verification explicitly', () => {
    const cases: Array<[string, (bundle: string) => void, RegExp]> = [
      ['tampered upstream', (b) => appendFileSync(join(b, 'upstream', 'src', 'scripts', 'render_skill.py'), '# patched\n'), /does not match its pinned sha256/u],
      ['tampered gc layer', (b) => appendFileSync(join(b, 'gc', 'customize', 'bmad-build.toml'), '# drift\n'), /does not match its pinned sha256/u],
      ['missing pinned file', (b) => rmSync(join(b, 'upstream', 'src', 'bmm-skills', 'ship', 'bmad-build', 'step-oneshot.md')), /missing pinned file/u],
      ['undeclared file', (b) => writeFileSync(join(b, 'gc', 'skills', 'bmad-build', 'extra.md'), 'x\n'), /undeclared file/u],
      ['symlinked file', (b) => {
        const target = join(b, 'gc', 'config', 'defaults.toml');
        const copy = `${target}.real`;
        cpSync(target, copy);
        rmSync(target);
        symlinkSync(copy, target);
      }, /symlink/u],
      ['missing manifest', (b) => rmSync(join(b, 'runtime.json')), /cannot read runtime\.json/u],
      ['extra bundle-root entry', (b) => writeFileSync(join(b, 'stray.txt'), 'x\n'), /bundle root must hold exactly gc, runtime\.json, upstream/u],
      ['symlinked bundle area', (b) => {
        cpSync(join(b, 'gc'), `${b}-gc-elsewhere`, { recursive: true });
        rmSync(join(b, 'gc'), { recursive: true });
        symlinkSync(`${b}-gc-elsewhere`, join(b, 'gc'));
      }, /bundle gc\/ is not a real directory/u],
    ];
    for (const [label, mutate, message] of cases) {
      const root = packageCopy();
      mutate(join(root, 'resources', 'bmad-runtime'));
      expect(() => loadBundledBmadRuntime(root), label).toThrow(BmadRuntimeError);
      expect(() => loadBundledBmadRuntime(root), label).toThrow(message);
      expect(() => loadBundledBmadRuntime(root), label).toThrow(/never falls back to another BMAD installation/u);
    }
  });

  it('keeps upstream unchanged: the launcher overlay differs by the renderer line only, and the override replaces only the quota layer', () => {
    const upstreamSkill = join(bundleRoot, 'upstream', 'src', 'bmm-skills', 'ship', 'bmad-build');
    const upstreamLauncher = readFileSync(join(upstreamSkill, 'SKILL.md'), 'utf-8').split('\n');
    const overlay = readFileSync(join(bundleRoot, 'gc', 'skills', 'bmad-build', 'SKILL.md'), 'utf-8').split('\n');
    expect(overlay).toHaveLength(upstreamLauncher.length);
    const changed = overlay.flatMap((line, index) => (line === upstreamLauncher[index] ? [] : [[upstreamLauncher[index], line]]));
    expect(changed).toEqual([[
      'uv run --no-cache "{project-root}/_bmad/scripts/render_skill.py" --project-root "{project-root}" --skill "{skill-root}"',
      'uv run --no-cache "{skill-root}/../../scripts/gc_render.py" --project-root "{project-root}" --skill "{skill-root}"',
    ]]);
    // The upstream defaults really carry the floor in both routes (so the
    // rendered-output assertions below are not vacuous) …
    const defaults = parse(readFileSync(join(upstreamSkill, 'customize.toml'), 'utf-8')) as {
      workflow: Record<string, Array<{ id: string; instruction: string }>>;
    };
    for (const route of ['review_layers', 'oneshot_review_layers']) {
      const blind = defaults.workflow[route]!.find((layer) => layer.id === 'blind-hunter')!;
      expect(blind.instruction, route).toMatch(/find at least N issues/u);
    }
    // … and the GC layer overrides exactly that layer id in each route.
    const gcLayer = parse(readFileSync(join(bundleRoot, 'gc', 'customize', 'bmad-build.toml'), 'utf-8')) as {
      workflow: Record<string, Array<{ id: string; instruction: string }>>;
    };
    expect(Object.keys(gcLayer.workflow).sort()).toEqual(['oneshot_review_layers', 'review_layers']);
    for (const route of ['review_layers', 'oneshot_review_layers']) {
      expect(gcLayer.workflow[route]!.map((layer) => layer.id)).toEqual(['blind-hunter']);
    }
  });

  it('dependency closure: everything the bundled workflow reaches resolves inside the runtime', () => {
    const files = [...shipped.files.keys()];
    const skillRoot = 'skills/bmad-build/';
    const sources = files.filter((path) => path.startsWith(skillRoot) && path.endsWith('.md'));
    const customize = parse(shipped.files.get(`${skillRoot}customize.toml`)!.toString('utf-8')) as { workflow: Record<string, unknown> };
    const defaults = parse(shipped.files.get('config/defaults.toml')!.toString('utf-8')) as Record<string, Record<string, unknown>>;
    const flat = (data: unknown, prefix = ''): Record<string, unknown> => Object.fromEntries(
      Object.entries(data as Record<string, unknown>).flatMap(([key, value]) => (
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? Object.entries(flat(value, `${prefix}${key}.`))
          : [[`${prefix}${key}`, value]]
      )),
    );
    const config = flat(defaults);
    const manifest = readBmadRuntimeManifest(bundleRoot);
    const knownSkills = new Set([...manifest.skills, ...manifest.optional_skill_references]);
    for (const path of sources) {
      const text = shipped.files.get(path)!.toString('utf-8');
      for (const [, target] of text.matchAll(/\[\[bmad-snapshot:([^\]]+)\]\]/gu)) {
        expect(files, `${path} → ${target}`).toContain(`${skillRoot}${target}`);
      }
      for (const [, key] of text.matchAll(/\{workflow\.([A-Za-z0-9_.-]+)\}/gu)) {
        expect(Object.keys(customize.workflow), `${path} → workflow.${key}`).toContain(key);
      }
      for (const [, key] of text.matchAll(/\{\{config\.([A-Za-z0-9_.-]+)\}\}/gu)) {
        expect(Object.keys(config), `${path} → config.${key}`).toContain(key);
      }
      for (const [, key] of text.matchAll(/\{\{\.([A-Za-z0-9_]+)\}\}/gu)) {
        const matches = Object.keys(config).filter((name) => name.split('.').at(-1) === key);
        expect(matches, `${path} → short token ${key}`).toHaveLength(1);
      }
      for (const [name] of text.replace(/\[\[bmad-snapshot:[^\]]+\]\]/gu, '').matchAll(/\bbmad-[a-z][a-z-]*[a-z]\b/gu)) {
        expect(knownSkills.has(name), `${path} mentions ${name}`).toBe(true);
      }
      // Relative reviewer references (`references/x.md`, `review-prompts/x.md`).
      for (const [, rel] of text.matchAll(/`((?:references|review-prompts)\/[a-z0-9-]+\.md)`/gu)) {
        expect(files, `${path} → ${rel}`).toContain(`${skillRoot}${rel}`);
      }
    }
    for (const [, rel] of (customize.workflow['review_layers'] as Array<{ instruction: string }>)
      .flatMap((layer) => [...layer.instruction.matchAll(/\{skill-root\}\/([^`\s]+)/gu)])) {
      expect(files, `customize → ${rel}`).toContain(`${skillRoot}${rel}`);
    }
    // No composed file still depends on a repo-local framework install.
    for (const path of files.filter((file) => !file.endsWith('.py') && file !== 'runtime.json')) {
      const text = shipped.files.get(path)!.toString('utf-8');
      expect(text, path).not.toMatch(/\{project-root\}\/_bmad\/(?:scripts|_config|core|bmm)/u);
    }
    // The renderer imports only the standard library and bundled modules.
    const stdlib = new Set(execFileSync('python3', ['-I', '-c', 'import sys; print("\\n".join(sorted(sys.stdlib_module_names)))'], { encoding: 'utf-8' }).trim().split('\n'));
    const bundledModules = new Set(files.filter((file) => file.startsWith('scripts/') && file.endsWith('.py')).map((file) => file.slice(8, -3)));
    for (const script of bundledModules) {
      const text = shipped.files.get(`scripts/${script}.py`)!.toString('utf-8');
      for (const [, module] of text.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*)/gmu)) {
        expect(stdlib.has(module!) || bundledModules.has(module!), `${script}.py imports ${module}`).toBe(true);
      }
    }
  });
});

describe('rendering for a project with no BMAD installation', () => {
  it('normal and oneshot workflows render from the runtime for a clean repo; git stays clean', () => {
    const repo = cleanRepo('clean-app');
    expect(existsSync(join(repo, '_bmad'))).toBe(false);
    const rendered = render(sharedRuntime, repo);
    expect(rendered.status, rendered.stdout).toBe(0);
    const generation = rendered.generation!;
    expect(generation.startsWith(join(repo, '_bmad', 'render', 'bmad-build'))).toBe(true);
    for (const step of ['workflow.md', 'step-01-clarify-and-route.md', 'step-02-plan.md', 'step-03-implement.md',
      'step-04-review.md', 'step-05-present.md', 'step-oneshot.md', 'spec-template.md']) {
      expect(existsSync(join(generation, step)), step).toBe(true);
    }
    // Every absolute path a rendered step points at (snapshots, reviewer
    // prompts, rubrics) resolves; nothing is left unrendered.
    for (const name of readdirSync(generation).filter((file) => file.endsWith('.md'))) {
      const text = readFileSync(join(generation, name), 'utf-8');
      expect(text, name).not.toMatch(/\[\[bmad-snapshot:|\{workflow\.|\{\{config\.|\{\{\./u);
      for (const [path] of text.matchAll(new RegExp(`${generation.replaceAll('/', '\\/')}\\/[A-Za-z0-9_./-]+\\.md`, 'gu'))) {
        expect(existsSync(path), `${name} → ${path}`).toBe(true);
      }
    }
    expect(readFileSync(join(generation, 'step-04-review.md'), 'utf-8')).toContain(join(repo, '_bmad-output', 'implementation-artifacts'));
    // A fresh checkout needs nothing provisioned: the configured output
    // folders are created on demand, and nothing shows up in git.
    for (const dir of ['_bmad-output/planning-artifacts', '_bmad-output/implementation-artifacts']) {
      expect(lstatSync(join(repo, dir)).isDirectory(), dir).toBe(true);
    }
    expect(git(repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
  });

  it('rendered normal and oneshot reviewer instructions carry no finding quota and accept an empty result', () => {
    const repo = cleanRepo('quota-free');
    const rendered = render(sharedRuntime, repo);
    expect(rendered.status, rendered.stdout).toBe(0);
    const routes: Record<string, string[]> = {
      'step-04-review.md': ['Blind Hunter (`blind-hunter`)', 'Edge Case Hunter (`edge-case-hunter`)', 'Verification Gap Reviewer (`verification-gap`)'],
      'step-oneshot.md': ['Blind Hunter (`blind-hunter`)'],
    };
    for (const [step, layers] of Object.entries(routes)) {
      const text = readFileSync(join(rendered.generation!, step), 'utf-8');
      for (const marker of FLOOR_MARKERS) expect(text, `${step} ${marker}`).not.toMatch(marker);
      for (const layer of layers) expect(text, step).toContain(`#### ${layer}`);
      // Independent review stays on: each layer launches a fresh reviewer.
      expect(text.match(/Launch a context-free subagent/gu)?.length, step).toBe(layers.length);
      expect(text, step).toContain('There is no minimum and no quota');
      expect(text, step).toContain('`No actionable findings.`');
      // No ceiling replaced the floor.
      expect(text, step).not.toMatch(/at most \d+ (?:tool calls|findings|rounds)/iu);
    }
  });

  it('isolation: two projects render into their own configured locations and never write the runtime', () => {
    const before = treeHash(sharedRuntime.dir);
    const alpha = cleanRepo('alpha');
    const beta = cleanRepo('beta');
    mkdirSync(join(alpha, '_bmad', 'custom'), { recursive: true });
    writeFileSync(join(alpha, '_bmad', 'custom', 'config.toml'), '[modules.bmm]\nimplementation_artifacts = "{project-root}/alpha-work"\n');
    mkdirSync(join(beta, '_bmad', 'custom'), { recursive: true });
    writeFileSync(join(beta, '_bmad', 'custom', 'config.toml'), '[modules.bmm]\nimplementation_artifacts = "{project-root}/team-work"\n[core]\ncommunication_language = "English"\n');
    // Personal layer wins over team; project customization wins over the GC layer.
    writeFileSync(join(beta, '_bmad', 'custom', 'config.user.toml'), '[core]\ncommunication_language = "Deutsch"\n');
    writeFileSync(join(beta, '_bmad', 'custom', 'bmad-build.toml'), [
      '[[workflow.oneshot_review_layers]]',
      'id = "blind-hunter"',
      'name = "Project Reviewer"',
      'instruction = "Launch a context-free subagent with this prompt: project-specific review."',
      '',
    ].join('\n'));
    const first = render(sharedRuntime, alpha);
    const second = render(sharedRuntime, beta);
    expect(first.status, first.stdout).toBe(0);
    expect(second.status, second.stdout).toBe(0);
    const alphaReview = readFileSync(join(first.generation!, 'step-04-review.md'), 'utf-8');
    const betaReview = readFileSync(join(second.generation!, 'step-04-review.md'), 'utf-8');
    expect(alphaReview).toContain(join(alpha, 'alpha-work'));
    expect(alphaReview).not.toContain(beta);
    expect(betaReview).toContain(join(beta, 'team-work'));
    expect(betaReview).not.toContain(alpha);
    expect(betaReview).toContain('Speak in `Deutsch`');
    expect(readFileSync(join(second.generation!, 'step-oneshot.md'), 'utf-8')).toContain('project-specific review');
    expect(readFileSync(join(first.generation!, 'step-oneshot.md'), 'utf-8')).not.toContain('project-specific review');
    // Each project holds exactly its own generation; the runtime is untouched.
    for (const [repo, generation] of [[alpha, first.generation!], [beta, second.generation!]] as const) {
      expect(generation.startsWith(join(repo, '_bmad', 'render'))).toBe(true);
      expect(readdirSync(join(repo, '_bmad', 'render', 'bmad-build'))).toHaveLength(1);
    }
    expect(treeHash(sharedRuntime.dir)).toBe(before);
    expect(inspectMaterializedBmadRuntime(sharedRuntime.dir).contentSha256).toBe(shipped.contentSha256);
  });

  it('a differing legacy installer answer or a linked _bmad stops rendering instead of being dropped or escaped', () => {
    const legacy = cleanRepo('legacy-answers');
    mkdirSync(join(legacy, '_bmad'), { recursive: true });
    writeFileSync(join(legacy, '_bmad', 'config.user.toml'), '[core]\nuser_name = "Owner"\ncommunication_language = "Français"\n');
    const halted = render(sharedRuntime, legacy);
    expect(halted.status).toBe(1);
    expect(halted.stdout).toContain('HALT: legacy BMAD installer answer `core.communication_language`');
    expect(halted.stdout).toContain('_bmad/custom/config.user.toml');
    // Equal (or runtime-unused) legacy answers do not block.
    writeFileSync(join(legacy, '_bmad', 'config.user.toml'), '[core]\nuser_name = "Owner"\ncommunication_language = "English"\n');
    expect(render(sharedRuntime, legacy).status).toBe(0);

    // Legacy layers merge like the installer's (personal wins): a team
    // answer superseded by a faithfully re-homed personal one is no conflict.
    writeFileSync(join(legacy, '_bmad', 'config.toml'), '[core]\ncommunication_language = "English"\n');
    writeFileSync(join(legacy, '_bmad', 'config.user.toml'), '[core]\ncommunication_language = "Deutsch"\n');
    mkdirSync(join(legacy, '_bmad', 'custom'), { recursive: true });
    writeFileSync(join(legacy, '_bmad', 'custom', 'config.user.toml'), '[core]\ncommunication_language = "Deutsch"\n');
    expect(render(sharedRuntime, legacy).status).toBe(0);

    // Project state is never read or written through a link out of the checkout.
    const links: Array<[string, (repo: string, elsewhere: string) => void]> = [
      ['_bmad', (repo, elsewhere) => symlinkSync(elsewhere, join(repo, '_bmad'))],
      ['_bmad/custom', (repo, elsewhere) => {
        mkdirSync(join(repo, '_bmad'), { recursive: true });
        writeFileSync(join(elsewhere, 'config.toml'), '[core]\ncommunication_language = "English"\n');
        symlinkSync(elsewhere, join(repo, '_bmad', 'custom'));
      }],
      ['_bmad/render/bmad-build', (repo, elsewhere) => {
        mkdirSync(join(repo, '_bmad', 'render'), { recursive: true });
        symlinkSync(elsewhere, join(repo, '_bmad', 'render', 'bmad-build'));
      }],
    ];
    // A kept render ignore file that lets snapshots through is refused.
    const leaky = cleanRepo('leaky-ignore');
    mkdirSync(join(leaky, '_bmad', 'render'), { recursive: true });
    writeFileSync(join(leaky, '_bmad', 'render', '.gitignore'), 'workflow.md\n');
    const leak = render(sharedRuntime, leaky);
    expect(leak.status).toBe(1);
    expect(leak.stdout).toContain('does not ignore rendered workflow snapshots');
    for (const [label, arrange] of links) {
      const linked = cleanRepo(`linked-${label.replaceAll('/', '-')}`);
      const elsewhere = tempDir('gru-command-bmad-elsewhere-');
      arrange(linked, elsewhere);
      const before = readdirSync(elsewhere);
      const refused = render(sharedRuntime, linked);
      expect(refused.status, label).toBe(1);
      expect(refused.stdout, label).toContain('is a symlink');
      expect(readdirSync(elsewhere), label).toEqual(before);
    }
  });
});

describe('job binding', () => {
  /** Runtime B: the shipped bundle with a visible GC-layer change and version 2. */
  function runtimeB(): string {
    const root = packageCopy();
    const bundle = join(root, 'resources', 'bmad-runtime');
    const layer = join(bundle, 'gc', 'customize', 'bmad-build.toml');
    writeFileSync(layer, readFileSync(layer, 'utf-8').replaceAll('Look for what\'s missing, not only what\'s wrong.', 'Look for what\'s missing, not only what\'s wrong. RUNTIME-B-MARKER.'));
    const current = readBmadRuntimeManifest(bundle);
    const { files: _files, ...upstream } = current.upstream;
    writeBmadRuntimeManifest(bundle, upstream, { name: current.customization.name, version: 2 });
    return root;
  }

  it('a lane keeps runtime A when runtime B ships, a new lane binds B, and a missing A fails loud', () => {
    const repo = cleanRepo('lanes');
    const lanes = tempDir('gru-command-bmad-lanes-');
    const laneOne = join(lanes, 'job-one');
    const laneTwo = join(lanes, 'job-two');
    git(repo, ['worktree', 'add', '-q', '-b', 'gru/job-one', laneOne]);
    git(repo, ['worktree', 'add', '-q', '-b', 'gru/job-two', laneTwo]);
    const store = tempDir('gru-command-bmad-binding-store-');
    const bindA = createBmadRuntimeBinder(store, repoRoot);
    const bindB = createBmadRuntimeBinder(store, runtimeB());

    const a = bindA(laneOne);
    expect(a.runtimeId).toBe('bmad-method@6.12.0+gru-command-bmad.1');
    expect(a.laneBound).toBe(true);
    const bindingFile = join(git(laneOne, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command', 'bmad-runtime.json');
    expect(JSON.parse(readFileSync(bindingFile, 'utf-8'))).toMatchObject({ runtime_id: a.runtimeId, runtime_dir: a.root, content_sha256: a.contentSha256 });
    expect(git(laneOne, ['status', '--porcelain'])).toBe('');

    // GC updates: the running lane keeps A; a new lane selects B.
    const kept = bindB(laneOne);
    expect(kept).toMatchObject({ runtimeId: a.runtimeId, root: a.root, contentSha256: a.contentSha256 });
    const b = bindB(laneTwo);
    expect(b.runtimeId).toBe('bmad-method@6.12.0+gru-command-bmad.2');
    expect(b.root).not.toBe(a.root);
    // The instructions each lane renders follow its own binding.
    const asRuntime = (set: ManagedSkillSet): MaterializedBmadRuntime =>
      ({ id: set.runtimeId, dir: set.root, contentSha256: set.contentSha256, skillsDir: set.skillsDir, skills: set.skills });
    const oneRender = render(asRuntime(kept), laneOne);
    const twoRender = render(asRuntime(b), laneTwo);
    expect(oneRender.status, oneRender.stdout).toBe(0);
    expect(twoRender.status, twoRender.stdout).toBe(0);
    expect(readFileSync(join(oneRender.generation!, 'step-04-review.md'), 'utf-8')).not.toContain('RUNTIME-B-MARKER');
    expect(readFileSync(join(twoRender.generation!, 'step-04-review.md'), 'utf-8')).toContain('RUNTIME-B-MARKER');

    // A non-lane checkout uses the current runtime, unrecorded.
    expect(bindB(repo)).toMatchObject({ runtimeId: b.runtimeId, laneBound: false });

    // A vanished runtime A is never silently replaced by B …
    rmSync(a.root, { recursive: true, force: true });
    expect(() => bindB(laneOne)).toThrow(BmadRuntimeError);
    expect(() => bindB(laneOne)).toThrow(/never switches runtimes silently/u);
    // … only restored when the current build ships exactly A's bytes.
    expect(bindA(laneOne)).toMatchObject({ root: a.root, contentSha256: a.contentSha256 });
    expect(existsSync(join(a.root, 'skills', 'bmad-build', 'SKILL.md'))).toBe(true);
  });

  it('a concurrent first bind adopts the binding that won; production service options carry the binder', async () => {
    const repo = cleanRepo('race');
    const lane = join(tempDir('gru-command-bmad-race-lane-'), 'lane');
    git(repo, ['worktree', 'add', '-q', '-b', 'gru/race', lane]);
    const store = tempDir('gru-command-bmad-race-store-');
    const packageB = runtimeB();
    const bundleA = loadBundledBmadRuntime(repoRoot);
    const bundleB = loadBundledBmadRuntime(packageB);
    // Another process binds the lane to A just before this one publishes B.
    const loser = bindBmadRuntime(lane, {
      storeRoot: store,
      bundled: () => bundleB,
      beforePublish: () => {
        bindBmadRuntime(lane, { storeRoot: store, bundled: () => bundleA });
      },
    });
    expect(loser.id).toBe(bundleA.id);
    expect(loser.contentSha256).toBe(bundleA.contentSha256);
    const bindingFile = join(git(lane, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command', 'bmad-runtime.json');
    expect(JSON.parse(readFileSync(bindingFile, 'utf-8')).runtime_id).toBe(bundleA.id);
    expect(readdirSync(dirname(bindingFile))).toEqual(['bmad-runtime.json']);

    // The options main.ts builds its registry from bind a minion's lane under the data dir.
    const home = tempDir('gru-command-bmad-service-');
    const config = loadConfig({ GRU_COMMAND_HOME: home });
    const options = serviceRegistryOptions({ config, store: {} as SessionStore });
    const seen: Array<ManagedSkillSet | undefined> = [];
    const caps = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };
    const adapter: AgentRuntime = {
      id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
      spawn: async (role: Role, opts: SpawnOptions = {}): Promise<AgentHandle> => {
        seen.push(opts.managedSkills);
        return {
          id: 'service-minion', role, sessionFile: join(home, 'minion.jsonl'), capabilities: caps,
          health: () => ({ state: 'idle', lastActivity: null, sessionFile: join(home, 'minion.jsonl') }),
          subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {},
          promptWithVerdict: async () => ({ ok: true, error: null }),
          hasLiveProcess: () => false, isCompacting: () => false, dispose: async () => {},
        };
      },
    };
    class ServiceRegistry extends RuntimeRegistry {
      override runtimeIdFor(): RuntimeId { return 'pi'; }
      override runtimeFor(): AgentRuntime { return adapter; }
    }
    const serviceLane = join(tempDir('gru-command-bmad-service-lane-'), 'lane');
    git(repo, ['worktree', 'add', '-q', '-b', 'gru/service', serviceLane]);
    const handle = await new ServiceRegistry(options).spawn('minion', { cwd: serviceLane });
    await handle.dispose();
    expect(seen[0]).toMatchObject({ runtimeId: shipped.id, laneBound: true, skills: ['bmad-build'] });
    expect(seen[0]!.root.startsWith(join(config.dataDir, 'bmad-runtime'))).toBe(true);
    const serviceBinding = join(git(serviceLane, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command', 'bmad-runtime.json');
    expect(JSON.parse(readFileSync(serviceBinding, 'utf-8')).runtime_dir).toBe(seen[0]!.root);
  });

  it('a modified materialized runtime is refused, never silently repaired', () => {
    const store = tempDir('gru-command-bmad-tamper-store-');
    const runtime = materializeBmadRuntime(shipped, store);
    const target = join(runtime.dir, 'skills', 'bmad-build', 'step-04-review.md');
    chmodSync(target, 0o644);
    appendFileSync(target, '\nfind at least 10 issues\n');
    expect(() => inspectMaterializedBmadRuntime(runtime.dir)).toThrow(/modified after it was installed/u);
    expect(() => materializeBmadRuntime(shipped, store)).toThrow(/modified after it was installed/u);
    const repo = cleanRepo('tampered');
    const lane = join(tempDir('gru-command-bmad-tamper-lane-'), 'lane');
    git(repo, ['worktree', 'add', '-q', '-b', 'gru/tampered', lane]);
    expect(() => createBmadRuntimeBinder(store, repoRoot)(lane)).toThrow(/modified after it was installed/u);
  });

  it('the registry binds the runtime for build-workflow sessions only, never for reviews', async () => {
    const dir = tempDir('gru-command-bmad-registry-');
    const config = loadConfig({ GRU_COMMAND_HOME: dir });
    const seen: Array<{ role: Role; managed: ManagedSkillSet | undefined }> = [];
    const caps = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };
    const adapter: AgentRuntime = {
      id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
      spawn: async (role: Role, opts: SpawnOptions = {}): Promise<AgentHandle> => {
        seen.push({ role, managed: opts.managedSkills });
        return {
          id: `agent-${seen.length}`, role, sessionFile: join(dir, `${seen.length}.jsonl`), capabilities: caps,
          health: () => ({ state: 'idle', lastActivity: null, sessionFile: join(dir, `${seen.length}.jsonl`) }),
          subscribe: () => () => {}, prompt: async () => {}, steer: async () => {}, followUp: async () => {},
          promptWithVerdict: async () => ({ ok: true, error: null }),
          hasLiveProcess: () => false, isCompacting: () => false, dispose: async () => {},
        };
      },
    };
    class TestRegistry extends RuntimeRegistry {
      override runtimeIdFor(): RuntimeId { return 'pi'; }
      override runtimeFor(): AgentRuntime { return adapter; }
    }
    const bound: string[] = [];
    const managed: ManagedSkillSet = {
      source: 'gru-command-bmad', runtimeId: 'rt', contentSha256: 'c'.repeat(64), root: '/rt', skillsDir: '/rt/skills', skills: ['bmad-build'], laneBound: true,
    };
    const registry = new TestRegistry({
      config,
      store: {} as SessionStore,
      bmadRuntime: (cwd) => {
        bound.push(cwd);
        if (cwd.endsWith('broken')) throw new BmadRuntimeError('bound runtime missing');
        return managed;
      },
    });
    const lane = cleanRepo('registry-lane');
    for (const handle of [
      await registry.spawn('minion', { cwd: lane }),
      await registry.spawn('perkins', { cwd: lane }),
      await registry.spawn('silas'),
      await registry.spawn('minion', { cwd: lane, isolatedReview: { systemPrompt: 'review', tools: [] } }),
    ]) await handle.dispose();
    expect(seen.map((entry) => [entry.role, entry.managed?.runtimeId ?? null])).toEqual([
      ['minion', 'rt'], ['perkins', null], ['silas', null], ['minion', null],
    ]);
    expect(bound).toEqual([lane]);
    await expect(registry.spawn('minion', { cwd: join(lane, 'broken') })).rejects.toThrow('bound runtime missing');
    // A cwd-less spawn (a supervised crash restart resumes by session file
    // alone) still starts, without the managed runtime, and never binds.
    const restarted = await registry.spawn('minion');
    await restarted.dispose();
    expect(seen.at(-1)).toEqual({ role: 'minion', managed: undefined });
    expect(bound).toEqual([lane, join(lane, 'broken')]);
  });
});

describe('maintenance CLI', () => {
  it('check passes paths through the environment, so shell syntax in a directory name stays inert', () => {
    const parent = tempDir('gru-command-bmad-quoted-');
    const repo = join(parent, 'it\'s "$(touch pwned)" `touch pwned2`');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    const lines: string[] = [];
    expect(runBmadRuntimeCli(['check', repo, '--store', sharedStore, '--package-root', repoRoot], (line) => lines.push(line))).toBe(0);
    expect(lines.at(-1)).toMatch(/^ok bmad-build: read and follow \//u);
    expect(lines.at(-1)).toContain(repo);
    for (const dir of [parent, repo, process.cwd()]) {
      expect(existsSync(join(dir, 'pwned')), dir).toBe(false);
      expect(existsSync(join(dir, 'pwned2')), dir).toBe(false);
    }
  });

  it('manifest regeneration is reproducible and vendor refuses a mismatched upstream package', () => {
    const root = packageCopy();
    const bundle = join(root, 'resources', 'bmad-runtime');
    const original = readFileSync(join(bundle, 'runtime.json'), 'utf-8');
    const lines: string[] = [];
    expect(runBmadRuntimeCli(['manifest', root], (line) => lines.push(line))).toBe(0);
    expect(readFileSync(join(bundle, 'runtime.json'), 'utf-8')).toBe(original);
    // A fake "upstream package" of the wrong version is refused before any write.
    const fakePackage = tempDir('gru-command-bmad-fake-upstream-');
    writeFileSync(join(fakePackage, 'package.json'), JSON.stringify({ name: 'bmad-method', version: '6.11.0' }));
    expect(() => runBmadRuntimeCli([
      'vendor', '--from', fakePackage, '--version', '6.13.0', '--integrity', 'sha512-x', '--git-head', 'abc', root,
    ], () => {})).toThrow(/is bmad-method@6\.11\.0, not bmad-method@6\.13\.0/u);
    expect(readFileSync(join(bundle, 'runtime.json'), 'utf-8')).toBe(original);
    expect(loadBundledBmadRuntime(root).contentSha256).toBe(shipped.contentSha256);
  });
});
