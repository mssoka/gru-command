#!/usr/bin/env node
/**
 * Bundled BMAD runtime maintenance (issue #283; docs/BMAD-RUNTIME.md).
 *
 *   verify [package-root]
 *       Verify the shipped bundle against its runtime.json (the build runs
 *       this; a failure fails the build).
 *   manifest [package-root] [--customization-version <n>]
 *       Regenerate runtime.json after a deliberate change to the GC layer.
 *   vendor --tarball <bmad-method-<v>.tgz> --version <v> --integrity <sha512-…>
 *          --git-head <sha> [--customization-version <n>] [package-root]
 *       Replace the bundled upstream files with another bmad-method release,
 *       after checking the tarball against its registry integrity.
 *   check <project-root> [--store <dir>] [--package-root <dir>]
 *       Materialize the shipped runtime and run each bundled skill's own
 *       launcher command against a project checkout (a fresh worktree is the
 *       intended target): proves the checkout renders with no repo-local
 *       BMAD install.
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BMAD_RUNTIME_RESOURCE_DIR,
  loadBundledBmadRuntime,
  materializeBmadRuntime,
  PACKAGE_ROOT,
  skillLauncherCommand,
} from '../bmad/runtime.js';
import { readBmadRuntimeManifest, vendorBmadTarball, writeBmadRuntimeManifest } from '../bmad/vendor.js';

const USAGE = [
  'usage: node dist/cli/bmad-runtime.js verify [package-root]',
  '       node dist/cli/bmad-runtime.js manifest [package-root] [--customization-version <n>]',
  '       node dist/cli/bmad-runtime.js vendor --tarball <file.tgz> --version <v> --integrity <sha512-…> --git-head <sha>',
  '                                            [--customization-version <n>] [package-root]',
  '       node dist/cli/bmad-runtime.js check <project-root> [--store <dir>] [--package-root <dir>]',
].join('\n');

/** Run every bundled skill's launcher against `projectRoot`; false on any HALT. */
export function checkBmadRuntime(
  projectRoot: string,
  store: string,
  packageRoot: string,
  write: (line: string) => void,
): boolean {
  const runtime = materializeBmadRuntime(loadBundledBmadRuntime(packageRoot), store);
  write(`BMAD runtime ${runtime.id} at ${runtime.dir}`);
  let ok = true;
  for (const skill of runtime.skills) {
    const launcher = skillLauncherCommand(runtime, skill, projectRoot);
    const result = spawnSync('/bin/sh', ['-c', launcher.command], {
      cwd: projectRoot,
      env: { ...process.env, ...launcher.env },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    const rendered = result.status === 0 && /^read and follow \/.+\/workflow\.md$/mu.test(result.stdout ?? '');
    write(`${rendered ? 'ok' : 'FAILED'} ${skill}: ${output === '' ? `exit ${String(result.status)}` : output}`);
    ok &&= rendered;
  }
  return ok;
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value\n${USAGE}`);
  argv.splice(index, 2);
  return value;
}

function customizationVersion(argv: string[], current: number): number {
  const raw = option(argv, '--customization-version');
  if (raw === undefined) return current;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--customization-version must be a positive integer`);
  return parsed;
}

export function runBmadRuntimeCli(args: readonly string[], write: (line: string) => void): number {
  const argv = [...args];
  const command = argv.shift();
  if (command === 'verify') {
    const runtime = loadBundledBmadRuntime(resolve(argv[0] ?? '.'));
    write(`BMAD runtime ${runtime.id} verified (content sha256 ${runtime.contentSha256})`);
    return 0;
  }
  if (command === 'check') {
    const store = option(argv, '--store') ?? join(homedir(), '.gru-command', 'bmad-runtime');
    const packageRoot = option(argv, '--package-root') ?? PACKAGE_ROOT;
    const projectRoot = argv[0];
    if (projectRoot === undefined) throw new Error(USAGE);
    return checkBmadRuntime(resolve(projectRoot), resolve(store), resolve(packageRoot), write) ? 0 : 1;
  }
  if (command === 'manifest' || command === 'vendor') {
    const tarball = command === 'vendor' ? option(argv, '--tarball') : undefined;
    const version = command === 'vendor' ? option(argv, '--version') : undefined;
    const integrity = command === 'vendor' ? option(argv, '--integrity') : undefined;
    const gitHead = command === 'vendor' ? option(argv, '--git-head') : undefined;
    const packageRoot = resolve(argv.find((arg) => !arg.startsWith('--')) ?? '.');
    const bundleRoot = join(packageRoot, BMAD_RUNTIME_RESOURCE_DIR);
    const current = readBmadRuntimeManifest(bundleRoot);
    const customization = {
      name: current.customization.name,
      version: customizationVersion(argv, current.customization.version),
    };
    const { files: _files, ...upstreamIdentity } = current.upstream;
    if (command === 'manifest') {
      const manifest = writeBmadRuntimeManifest(bundleRoot, upstreamIdentity, customization);
      write(`wrote ${join(bundleRoot, 'runtime.json')} for ${manifest.id}`);
    } else {
      if (tarball === undefined || version === undefined || integrity === undefined || gitHead === undefined) {
        throw new Error(`vendor requires --tarball, --version, --integrity and --git-head\n${USAGE}`);
      }
      const manifest = vendorBmadTarball(packageRoot, resolve(tarball), {
        ...upstreamIdentity,
        version,
        integrity,
        git_head: gitHead,
        tarball: `https://registry.npmjs.org/${upstreamIdentity.package}/-/${upstreamIdentity.package}-${version}.tgz`,
      }, customization);
      write(`vendored ${manifest.id}; review the upstream/ diff and the GC overlays before release`);
    }
    loadBundledBmadRuntime(packageRoot);
    return 0;
  }
  throw new Error(USAGE);
}

const invokedAsCli = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsCli) {
  try {
    process.exit(runBmadRuntimeCli(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`)));
  } catch (error) {
    process.stderr.write(`bmad-runtime: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
