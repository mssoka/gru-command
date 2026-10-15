import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../../../src/property/overlay.js';
import { ratioProposal } from '../real-tool/helpers.js';
import type { PropertyMode } from '../../../../src/property/types.js';
import { FAILURE_RUNNER, PASS_RUNNER, scenarioRepo } from './helpers.js';

/** Deliberately fake orchestration controls, never real-tool proof. */
export const UNIT_PATH = 'test/property/ratio.test.mjs';
export const UNIT_CONTENT = '// reviewed fake-unit oracle; never real-tool proof\n';
export const UNIT_RUNNER = `import fs from 'node:fs';const bad=fs.readFileSync('test/placeholder','utf8')!=='tracked\\n';if(bad){${FAILURE_RUNNER}}else{${PASS_RUNNER}}`.replaceAll('test/contract.test.ts', UNIT_PATH);
export function unitCampaign(mode: PropertyMode = 'enforced', setup?: (fixture: ReturnType<typeof scenarioRepo>) => void) {
  const fixtures: ReturnType<typeof scenarioRepo>[] = [];
  const repo = (failed: boolean) => {
    const f = scenarioRepo(UNIT_RUNNER); fixtures.push(f);
    if (failed) writeFileSync(join(f.root, 'test/placeholder'), 'known-bad unit control\n');
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vitest: '3.2.7', 'fast-check': '3.23.2' } }));
    for (const [name, version] of [['vitest', '3.2.7'], ['fast-check', '3.23.2']]) { mkdirSync(join(f.root, 'node_modules', name!), { recursive: true }); writeFileSync(join(f.root, 'node_modules', name!, 'package.json'), JSON.stringify({ name, version })); }
    chmodSync(join(f.root, 'node_modules/vitest/vitest.mjs'), 0o755);
    writeFileSync(join(f.root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/vitest': { version: '3.2.7' }, 'node_modules/fast-check': { version: '3.23.2' } } }));
    mkdirSync(join(f.root, '.gru-command')); writeFileSync(join(f.root, '.gru-command/property.toml'), `mode = "${mode}"\n`);
    setup?.(f);
    f.git(['add', '.']); f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'reviewed unit metadata']);
    return f;
  };
  const bad = repo(true); const healthy = repo(false); const candidate = repo(true);
  candidate.git(['fetch', healthy.root, 'HEAD']); candidate.git(['reset', '--soft', 'FETCH_HEAD']);
  writeFileSync(join(candidate.root, 'test/placeholder'), 'candidate mutation\n'); commit(candidate, 'candidate unit mutation');
  const proposal = { ...ratioProposal(), testArtifactRefs: [{ path: UNIT_PATH, sha256: sha256Hex(UNIT_CONTENT) }] };
  return { bad, healthy, candidate, reviewed: { proposal, overlayFiles: [{ path: UNIT_PATH, content: UNIT_CONTENT }], knownBadRoot: bad.root, healthyRoot: healthy.root, candidateRoot: candidate.root, baselineRoot: healthy.root, implementationPaths: ['test/placeholder'] }, cleanup() { for (const f of fixtures) f.cleanup(); } };
}
export function commit(f: ReturnType<typeof scenarioRepo>, message: string) { f.git(['add', '.']); f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message]); }
