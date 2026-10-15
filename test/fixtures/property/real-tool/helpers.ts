import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { sha256Hex } from '../../../../src/property/overlay.js';
import { VITEST_FAST_CHECK_ADAPTER as adapter } from '../../../../src/property/adapters/vitest-fast-check.js';
import type { PropertyExecutionPlan, PropertyMode, PropertyProposal } from '../../../../src/property/types.js';

const fixture = dirname(fileURLToPath(import.meta.url));
export const CONTRACT_PATH = 'test/property/ratio.test.mjs';
export function ratioContract(vacuous = false): string {
  return `import {it,expect} from 'vitest';import fc from 'fast-check';import {ratio} from '../../ratio.mjs';
it('nonnegative ratios preserve numerator and denominator',()=>{
const seed=Number(process.env.GRU_PROPERTY_SEED ?? 424242);
const path=process.env.GRU_PROPERTY_PATH;
fc.assert(fc.property(fc.limitShrink(fc.tuple(fc.integer({min:0,max:10000}),fc.integer({min:1,max:100})),Number(process.env.GRU_PROPERTY_MAX_SHRINK_STEPS ?? 100)), ([n,d])=>{
${vacuous ? 'expect(Number.isFinite(ratio(n,d)) && ratio(n,d)>=0).toBe(true);' : 'expect(ratio(n,d)).toBe(n/d);'}
}),{seed,...(path===undefined?{}:{path}),numRuns:Number(process.env.GRU_PROPERTY_MAX_ITERATIONS ?? 100),maxSkipsPerRun:1,endOnFailure:false,interruptAfterTimeLimit:5000,markInterruptAsFailure:true});});\n`;
}
export function realToolRepo(broken: boolean, mode: PropertyMode = 'enforced') {
  const root = mkdtempSync(join(tmpdir(), 'gru-property-real-'));
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_DATE: '2026-10-14T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-14T00:00:00Z' } });
  try {
    // Required positive fixture: no installation, fallback or silent skip.
    for (const name of ['vitest', 'fast-check']) if (!existsSync(join(fixture, 'node_modules', name, 'package.json'))) throw new Error(`GH350 real-tool fixture missing ${name}; explicit locked provisioning is required`);
    cpSync(join(fixture, 'node_modules'), join(root, 'node_modules'), { recursive: true, verbatimSymlinks: true });
    for (const name of ['package.json', 'package-lock.json']) cpSync(join(fixture, name), join(root, name));
    mkdirSync(join(root, 'test/property'), { recursive: true });
    mkdirSync(join(root, '.gru-command'), { recursive: true });
    writeFileSync(join(root, '.gru-command/property.toml'), `mode = "${mode}"\n`);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    const implementation = (bad: boolean) => `export function ratio(n,d){return ${bad ? '0' : 'n/d'};}\n`;
    writeFileSync(join(root, 'ratio.mjs'), implementation(false));
    git('init', '-q'); git('config', 'user.name', 'Property fixture'); git('config', 'user.email', 'property@example.invalid');
    git('add', '.'); git('commit', '-qm', 'reviewed healthy baseline');
    if (broken) { writeFileSync(join(root, 'ratio.mjs'), implementation(true)); git('add', 'ratio.mjs'); git('commit', '-qm', 'known-bad ratio mutation'); }
    return { root, git, repair() { writeFileSync(join(root, 'ratio.mjs'), implementation(false)); git('add', 'ratio.mjs'); git('commit', '-qm', 'repair ratio'); }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
export function realPlan(root: string): PropertyExecutionPlan {
  return { adapterId: adapter.support.adapterId, command: resolve(root, 'node_modules/vitest/vitest.mjs'), args: ['run', '--reporter=json', CONTRACT_PATH], cwd: root,
    envAllowlist: [], budget: { maxIterations: 100, maxShrinkSteps: 100, runTimeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
    executable: true, refusalReason: null };
}
export function ratioProposal(source = ratioContract()): PropertyProposal {
  return { requirementRef: 'ratio-spec#1', invariant: 'ratio(n,d) equals n/d for nonnegative integer numerators and positive denominators', inputDomain: 'n: integer [0,10000]; d: integer [1,100]', invalidInputBehavior: 'zero denominators excluded by the approved requirement', targetPackageDir: '.', adapterId: adapter.support.adapterId,
    testArtifactRefs: [{ path: CONTRACT_PATH, sha256: sha256Hex(source) }], establishes: 'finite nonnegative rational arithmetic under the reviewed domain', doesNotEstablish: 'division by zero, arbitrary real arithmetic, or merge authority' };
}
export function realVersions() { return Object.fromEntries(['vitest', 'fast-check'].map((name) => [name, (JSON.parse(readFileSync(join(fixture, 'node_modules', name, 'package.json'), 'utf8')) as { version: string }).version])); }
