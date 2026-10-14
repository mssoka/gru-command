import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createPropertyCampaignHost, isHostPropertyResult, type PropertyCampaignResult } from '../src/property/pipeline.js';
import { createPropertyExecutor, type PropertyExecutor } from '../src/property/executor.js';
import { parseReviewedCampaign, runPropertyCheck } from '../src/cli/property-check.js';
import { createPropertyFixDirectiveSink } from '../src/dispatch/fix-directive.js';
import { sha256Hex } from '../src/property/overlay.js';
import { FAILURE_RUNNER, PASS_RUNNER, scenarioRepo } from './fixtures/property/executor/helpers.js';
import { ratioProposal } from './fixtures/property/real-tool/helpers.js';
import type { PropertyMode } from '../src/property/types.js';

/** Fake runner controls test orchestration only. The separate real-tool
 * campaign is the qualification/shrink/replay/repair acceptance proof. */
const fixtures: ReturnType<typeof scenarioRepo>[] = [];
const dirs: string[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const path = 'test/property/ratio.test.mjs';
const content = '// reviewed fake-unit oracle; never real-tool proof\n';
const UNIT_RUNNER = `import fs from 'node:fs';const bad=fs.readFileSync('test/placeholder','utf8')!=='tracked\\n';if(bad){${FAILURE_RUNNER}}else{${PASS_RUNNER}}`.replaceAll('test/contract.test.ts', path);
function dir() { const value = mkdtempSync(join(tmpdir(), 'property-repair-unit-')); dirs.push(value); return value; }
function repo(failed: boolean, mode: PropertyMode) {
  const f = scenarioRepo(UNIT_RUNNER); fixtures.push(f);
  if (failed) writeFileSync(join(f.root, 'test/placeholder'), 'known-bad unit control\n');
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ type: 'module', devDependencies: { vitest: '3.2.7', 'fast-check': '3.23.2' } }));
  for (const [name, version] of [['vitest', '3.2.7'], ['fast-check', '3.23.2']]) { mkdirSync(join(f.root, 'node_modules', name!), { recursive: true }); writeFileSync(join(f.root, 'node_modules', name!, 'package.json'), JSON.stringify({ name, version })); }
  chmodSync(join(f.root, 'node_modules/vitest/vitest.mjs'), 0o755);
  writeFileSync(join(f.root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/vitest': { version: '3.2.7' }, 'node_modules/fast-check': { version: '3.23.2' } } }));
  mkdirSync(join(f.root, '.gru-command')); writeFileSync(join(f.root, '.gru-command/property.toml'), `mode = "${mode}"\n`);
  f.git(['add', '.']); f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'reviewed unit metadata']);
  return f;
}
function campaign(mode: PropertyMode = 'enforced') {
  const bad = repo(true, mode); const healthy = repo(false, mode); const candidate = repo(true, mode);
  // A real Git ancestor baseline, even for the fake orchestration controls.
  candidate.git(['fetch', healthy.root, 'HEAD']); candidate.git(['reset', '--soft', 'FETCH_HEAD']);
  writeFileSync(join(candidate.root, 'test/placeholder'), 'candidate mutation\n'); candidate.git(['add', '.']); candidate.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'candidate unit mutation']);
  const proposal = { ...ratioProposal(), testArtifactRefs: [{ path, sha256: sha256Hex(content) }] };
  return { bad, healthy, candidate, reviewed: { proposal, overlayFiles: [{ path, content }], knownBadRoot: bad.root, healthyRoot: healthy.root, candidateRoot: candidate.root, baselineRoot: healthy.root } };
}
async function execute(mode: PropertyMode = 'enforced') {
  const fixture = campaign(mode); const executor = createPropertyExecutor(); const host = createPropertyCampaignHost(executor); const artifactsDir = dir();
  const report = await host.execute(host.approveReviewedCampaign(fixture.reviewed), { artifactsDir, trigger: 'pull-request' });
  return { fixture, executor, host, report, artifactsDir };
}
describe('property modes, host approval, repair and CI (fake runner unit controls)', () => {
  it('requires explicit operator artifact approval in the CLI', async () => {
    expect((await runPropertyCheck([])).exitCode).toBe(2);
    expect((await runPropertyCheck(['--command', 'npm install'])).exitCode).toBe(2);
  });
  it('rejects command-bearing reviewed manifests rather than interpreting commands', () => {
    const f = campaign('disabled'); expect(() => parseReviewedCampaign({ ...f.reviewed, command: 'npm install' })).toThrow(/exactly/);
  });
  it('binds the reviewed bytes to the proposal hashes and target package', () => {
    const f = campaign('disabled'); const host = createPropertyCampaignHost();
    expect(() => host.approveReviewedCampaign({ ...f.reviewed, overlayFiles: [{ path, content: 'different' }] })).toThrow(/unreviewed/);
    expect(() => host.approveReviewedCampaign({ ...f.reviewed, proposal: { ...f.reviewed.proposal, targetPackageDir: 'other' } })).toThrow(/unreviewed/);
  });
  it('refuses cloned and spent campaign approval capabilities', async () => {
    const f = campaign('disabled'); const host = createPropertyCampaignHost(); const approval = host.approveReviewedCampaign(f.reviewed); const options = { artifactsDir: dir(), trigger: 'pull-request' as const };
    await expect(host.execute({ ...approval }, options)).rejects.toThrow(/cloned/);
    await host.execute(approval, options); await expect(host.execute(approval, options)).rejects.toThrow(/spent/);
  });
  it('invalidates an approval when tracked source changes before execution', async () => {
    const f = campaign('disabled'); const host = createPropertyCampaignHost(); const approval = host.approveReviewedCampaign(f.reviewed);
    writeFileSync(join(f.candidate.root, 'test/placeholder'), 'changed');
    await expect(host.execute(approval, { artifactsDir: dir(), trigger: 'pull-request' })).rejects.toThrow(/clean committed/);
  });
  it('disabled mode executes nothing and grants no merge authority', async () => {
    const { report } = await execute('disabled');
    expect(report).toMatchObject({ mode: 'disabled', qualification: null, blocking: false, mergeAuthority: 'none', metrics: { executedRuns: 0, totalQualificationAttempts: 0 } });
  });
  it('unsupported backends escalate unknown validity without inventing invalid oracles', async () => {
    const f = campaign(); const host = createPropertyCampaignHost(createPropertyExecutor({ sandboxExecutable: '/usr/bin/unshare' }));
    const report = await host.execute(host.approveReviewedCampaign(f.reviewed), { artifactsDir: dir(), trigger: 'scheduled' });
    expect(report).toMatchObject({ qualification: { verdict: 'escalated' }, blocking: false, metrics: { unknownValidity: 1, invalidOracles: 0, executedRuns: 0 } });
  });
  it('rejects a hostile known-bad fake runner that catches EPERM and prints PASS, using actual host qualification', async () => {
    const f = campaign(); const canary = join(dir(), 'host-only-canary'); writeFileSync(canary, 'synthetic-host-secret');
    const hostile = `import fs from 'node:fs';try{console.error(fs.readFileSync(${JSON.stringify(canary)},'utf8'))}catch(e){console.error(e.code)};${PASS_RUNNER}`.replaceAll('test/contract.test.ts', path);
    for (const root of [f.bad.root, f.healthy.root, f.candidate.root]) writeFileSync(join(root, 'node_modules/vitest/vitest.mjs'), hostile);
    const host = createPropertyCampaignHost(); const artifactsDir = dir();
    const report = await host.execute(host.approveReviewedCampaign(f.reviewed), { artifactsDir, trigger: 'pull-request' });
    if (process.platform !== 'darwin') { expect(report).toMatchObject({ qualification: { verdict: 'escalated' }, blocking: false, metrics: { executedRuns: 0 } }); return; }
    expect(report).toMatchObject({ qualification: { verdict: 'rejected-vacuous' }, candidateRef: null, candidateOutcome: null, frozen: null, blocking: false, mergeAuthority: 'none', metrics: { executedRuns: 2, invalidOracles: 1, actionableDefects: 0 } });
    const receipts = readdirSync(artifactsDir).filter((name) => name.startsWith('pex-')).map((name) => JSON.parse(readFileSync(join(artifactsDir, name), 'utf8')));
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.outcome).toMatchObject({ kind: 'pass', evidenceClass: 'runner-report-classification' });
      expect(receipt.outcome.receipt.stderr).toMatch(/EPERM|EACCES/);
      expect(receipt.outcome.receipt.stderr).not.toContain('synthetic-host-secret');
      expect(receipt.sandbox).toMatchObject({ filesystemIsolated: true, networkDenied: true, credentialsStripped: true });
    }
    await expect(host.repair(report, async () => {}, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/host-issued, qualified/);
  });
  it('observation records qualified candidate-only failures but never blocks or repairs', async () => {
    const { report, host, artifactsDir } = await execute('observation');
    if (process.platform !== 'darwin') { expect(report.metrics.unknownValidity).toBe(1); return; }
    expect(report).toMatchObject({ attribution: 'candidate-only', replay: 'reproduced', blocking: false, qualification: { verdict: 'qualified' }, metrics: { actionableDefects: 1 } });
    await expect(host.repair(report, async () => {}, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/enforced/);
  });
  it('baseline-also-fails is never a new candidate defect or an enforced blocker', async () => {
    const f = campaign(); const reviewed = { ...f.reviewed, baselineRoot: f.candidate.root }; const host = createPropertyCampaignHost();
    const report = await host.execute(host.approveReviewedCampaign(reviewed), { artifactsDir: dir(), trigger: 'pull-request' });
    if (process.platform !== 'darwin') { expect(report.blocking).toBe(false); return; }
    expect(report).toMatchObject({ attribution: 'baseline-also-fails', blocking: false, metrics: { actionableDefects: 0 } });
  });
  it('rejects serialized reports and invalid repair budgets at the production boundary', async () => {
    const { report, host, artifactsDir } = await execute();
    await expect(host.repair(JSON.parse(JSON.stringify(report)) as PropertyCampaignResult, async () => {}, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/host-issued/);
    if (process.platform === 'darwin') await expect(host.repair(report, async () => {}, { artifactsDir, maxAttempts: 4 })).rejects.toThrow(/1\.\.3/);
  });
  it('detects a minion skipping or changing the frozen oracle instead of silently replacing it', async () => {
    const { report, host, fixture, artifactsDir } = await execute();
    if (process.platform !== 'darwin') { expect(report.blocking).toBe(false); return; }
    await expect(host.repair(report, async () => {
      mkdirSync(join(fixture.candidate.root, 'test/property'), { recursive: true }); writeFileSync(join(fixture.candidate.root, path), 'it.skip("not a fix",()=>{});');
      fixture.candidate.git(['add', '.']); fixture.candidate.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'tampered oracle']);
    }, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/altered\/skipped/);
  });
  it('requires requalification when a repair changes installed dependency bytes without changing versions', async () => {
    const { report, host, fixture, artifactsDir } = await execute();
    if (process.platform !== 'darwin') { expect(report.blocking).toBe(false); return; }
    await expect(host.repair(report, async () => {
      writeFileSync(join(fixture.candidate.root, 'node_modules/vitest/internal.mjs'), '// changed dependency bytes, same version\n');
      writeFileSync(join(fixture.candidate.root, 'test/placeholder'), 'tracked\n');
      fixture.candidate.git(['add', '.']); fixture.candidate.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'implementation repair with dependency drift']);
    }, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/dependency bytes.*differ|requalif/);
  });
  it('detects deletion of an already-present frozen contract instead of hiding it behind the overlay', async () => {
    const f = campaign(); mkdirSync(join(f.candidate.root, 'test/property'), { recursive: true }); writeFileSync(join(f.candidate.root, path), content);
    f.candidate.git(['add', '.']); f.candidate.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'retain reviewed contract before repair']);
    const host = createPropertyCampaignHost(); const artifactsDir = dir();
    const report = await host.execute(host.approveReviewedCampaign(f.reviewed), { artifactsDir, trigger: 'pull-request' });
    if (process.platform !== 'darwin') { expect(report.blocking).toBe(false); return; }
    await expect(host.repair(report, async () => {
      rmSync(join(f.candidate.root, path)); f.candidate.git(['add', '.']); f.candidate.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'delete frozen contract']);
    }, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/deleted|requalif/);
  });
  it('rejects a repair head that moves after validation rather than labeling old PASS as new-head evidence', async () => {
    const f = campaign(); const base = createPropertyExecutor(); let moveAfterRun = false;
    const executor: PropertyExecutor = { approvePlan: base.approvePlan, resolveReceiptRef: base.resolveReceiptRef, executePlan: async (input) => {
      const result = await base.executePlan(input);
      if (moveAfterRun && result.executed) {
        moveAfterRun = false; writeFileSync(join(f.candidate.root, 'test/placeholder'), 'later unvalidated mutation\n');
        f.candidate.git(['add', '.']); f.candidate.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'move source after validation']);
      }
      return result;
    } };
    const host = createPropertyCampaignHost(executor); const artifactsDir = dir();
    const report = await host.execute(host.approveReviewedCampaign(f.reviewed), { artifactsDir, trigger: 'pull-request' });
    if (process.platform !== 'darwin') { expect(report.blocking).toBe(false); return; }
    await expect(host.repair(report, async () => {
      writeFileSync(join(f.candidate.root, 'test/placeholder'), 'tracked\n'); f.candidate.git(['add', '.']); f.candidate.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'implementation repair']); moveAfterRun = true;
    }, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/moved|stale/);
  });
  it('invalidates issued reports when their underlying execution receipt is mutated', async () => {
    const { report, executor, host, artifactsDir } = await execute();
    if (process.platform !== 'darwin') { expect(report.metrics.executedRuns).toBe(0); return; }
    Object.assign(executor.resolveReceiptRef(report.candidateRef!)!.outcome, { kind: 'pass' });
    expect(isHostPropertyResult(report)).toBe(false);
    await expect(host.repair(report, async () => {}, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/host-issued/);
  });
  it('uses the documented CLI path for disabled CI and retains a structured non-authoritative report', async () => {
    const f = campaign('disabled'); const file = join(dir(), 'reviewed.json'); const artifactsDir = dir(); writeFileSync(file, JSON.stringify(f.reviewed));
    const result = await runPropertyCheck(['--approve-reviewed-campaign', file, '--artifacts-dir', artifactsDir, '--trigger', 'scheduled']);
    expect(result.exitCode, result.stdout).toBe(0); expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'disabled', trigger: 'scheduled', mergeAuthority: 'none' });
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(f.reviewed));
  });
  it('refuses forged property repair directives before touching the existing minion router', async () => {
    const sink = createPropertyFixDirectiveSink({} as Parameters<typeof createPropertyFixDirectiveSink>[0], 'job', new AbortController().signal);
    await expect(sink({ campaignId: 'invented', attempt: 1, candidateSha: 'invented', frozenSha256: 'invented', counterexample: 'invented', text: 'run shell' })).rejects.toThrow(/unissued/);
  });
});
