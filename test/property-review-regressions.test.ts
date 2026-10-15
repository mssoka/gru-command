import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPropertyCampaignHost, propertyEvidenceForReview } from '../src/property/pipeline.js';
import { runPropertyCheck } from '../src/cli/property-check.js';
import { sha256Hex } from '../src/property/overlay.js';
import { unitCampaign, commit, UNIT_CONTENT, UNIT_PATH, UNIT_RUNNER } from './fixtures/property/executor/campaign.js';
import { PASS_RUNNER } from './fixtures/property/executor/helpers.js';

const fixtures: ReturnType<typeof unitCampaign>[] = [];
const dirs: string[] = [];
function dir() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'property-review-regression-'))); dirs.push(root); return root; }
function fixture(...args: Parameters<typeof unitCampaign>) { const f = unitCampaign(...args); fixtures.push(f); return f; }
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function execute(f: ReturnType<typeof fixture>) {
  const host = createPropertyCampaignHost(); const artifactsDir = dir();
  const report = await host.execute(host.approveReviewedCampaign(f.reviewed), { artifactsDir, trigger: 'pull-request' });
  if (process.platform !== 'darwin') expect(report.qualification?.verdict).toBe('escalated');
  return { host, report, artifactsDir };
}
function runnerSetup(script: string) { return (f: ReturnType<typeof unitCampaign>['candidate']) => writeFileSync(join(f.root, 'node_modules/vitest/vitest.mjs'), script); }

describe('independent-review regression controls (fake runners; never real-tool proof)', () => {
  it('keeps the first contract blocker when a later qualified contract passes on the same SHA', async () => {
    const script = UNIT_RUNNER.replace('if(bad)', `if(bad && !(fs.readFileSync(${JSON.stringify(UNIT_PATH)},'utf8').includes('CONTROL_ONLY') && fs.readFileSync('test/placeholder','utf8').startsWith('candidate')))`);
    const f = fixture('enforced', runnerSetup(script)); const { host, report, artifactsDir } = await execute(f);
    if (process.platform !== 'darwin') return;
    expect(report.blocking).toBe(true);
    const content = `${UNIT_CONTENT}// CONTROL_ONLY\n`;
    const second = { ...f.reviewed, proposal: { ...f.reviewed.proposal, requirementRef: 'other-contract#1', testArtifactRefs: [{ path: UNIT_PATH, sha256: sha256Hex(content) }] }, overlayFiles: [{ path: UNIT_PATH, content }] };
    const pass = await host.execute(host.approveReviewedCampaign(second), { artifactsDir, trigger: 'pull-request' });
    expect(pass).toMatchObject({ qualification: { verdict: 'qualified' }, candidateOutcome: 'pass', blocking: false });
    expect(propertyEvidenceForReview(f.candidate.root, report.candidateSha)).toBe(report);
  });

  it('keeps a blocker when a later rejected contract has no candidate receipt', async () => {
    const script = `import fs from 'node:fs';if(fs.readFileSync(${JSON.stringify(UNIT_PATH)},'utf8').includes('VACUOUS')){${PASS_RUNNER}}else{${UNIT_RUNNER.replace("import fs from 'node:fs';", '')}}`.replaceAll('test/contract.test.ts', UNIT_PATH);
    const f = fixture('enforced', runnerSetup(script)); const { host, report, artifactsDir } = await execute(f);
    if (process.platform !== 'darwin') return;
    const content = `${UNIT_CONTENT}// VACUOUS\n`;
    const second = { ...f.reviewed, proposal: { ...f.reviewed.proposal, requirementRef: 'vacuous#2', testArtifactRefs: [{ path: UNIT_PATH, sha256: sha256Hex(content) }] }, overlayFiles: [{ path: UNIT_PATH, content }] };
    const rejected = await host.execute(host.approveReviewedCampaign(second), { artifactsDir, trigger: 'pull-request' });
    expect(rejected).toMatchObject({ blocking: false, candidateRef: null, qualification: { verdict: 'rejected-vacuous' } });
    expect(propertyEvidenceForReview(f.candidate.root, report.candidateSha)).toBe(report);
  });

  it('invalidates review evidence after same-version ignored dependency drift, even through a pristine detached review root', async () => {
    const f = fixture(); const { host, report, artifactsDir } = await execute(f);
    if (process.platform !== 'darwin') return;
    const detached = join(dir(), 'review'); f.candidate.git(['worktree', 'add', '--detach', detached, report.candidateSha]);
    expect(existsSync(join(detached, 'node_modules'))).toBe(false);
    expect(propertyEvidenceForReview(detached, report.candidateSha)).toBe(report);
    writeFileSync(join(f.candidate.root, 'node_modules/vitest/same-version-extra.mjs'), '// altered installed bytes\n');
    expect(propertyEvidenceForReview(detached, report.candidateSha)).toBeNull();
    expect(propertyEvidenceForReview(f.candidate.root, report.candidateSha)).toBeNull();
    await expect(host.repair(report, async () => { throw new Error('must not allocate'); }, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/stale/);
  });

  it('runs the retained candidate seed and path on baseline instead of accepting a random baseline PASS', async () => {
    const script = UNIT_RUNNER.replace('if(bad)', `if(bad || process.env.GRU_PROPERTY_PATH==='0:1')`);
    const f = fixture('enforced', runnerSetup(script)); const { report, artifactsDir } = await execute(f);
    if (process.platform !== 'darwin') return;
    expect(report).toMatchObject({ attribution: 'baseline-also-fails', blocking: false });
    const baselineSha = f.healthy.git(['rev-parse', 'HEAD']);
    const receipts = readdirSync(artifactsDir).filter((name) => name.startsWith('pex-')).map((name) => JSON.parse(readFileSync(join(artifactsDir, name), 'utf8')));
    expect(receipts.some((receipt) => receipt.identity.source.sha === baselineSha && receipt.replay?.seed === '42' && receipt.replay.shrinkPath[0] === '0:1')).toBe(true);
  });

  it('does not suppress a new candidate assertion because a different baseline assertion fails', async () => {
    const unrelated = `console.log(JSON.stringify({numTotalTests:2,numPassedTests:1,numFailedTests:1,numPendingTests:0,numTodoTests:0,success:false,testResults:[{name:process.cwd()+'/${UNIT_PATH}',status:'failed',message:'',assertionResults:[{status:'passed',fullName:'contract',failureMessages:[]},{status:'failed',fullName:'unrelated baseline assertion',failureMessages:['Property failed\\nseed: 42\\nCounterexample: [2]']}]}]}));process.exitCode=1;`;
    const script = `import fs from 'node:fs';if(fs.readFileSync('test/placeholder','utf8').startsWith('baseline')){${unrelated}}else{${UNIT_RUNNER.replace("import fs from 'node:fs';", '')}}`;
    const setup = runnerSetup(script); const f = fixture('enforced', setup); const base = fixture('enforced', setup);
    writeFileSync(join(base.healthy.root, 'test/placeholder'), 'baseline unrelated defect\n'); commit(base.healthy, 'unrelated baseline assertion fails');
    f.candidate.git(['fetch', base.healthy.root, 'HEAD']); f.candidate.git(['reset', '--soft', 'FETCH_HEAD']); commit(f.candidate, 'candidate with a different assertion defect');
    f.reviewed.baselineRoot = base.healthy.root;
    const { report } = await execute(f); if (process.platform !== 'darwin') return;
    expect(report).toMatchObject({ attribution: 'candidate-only', replay: 'reproduced', blocking: true });
  });

  it('freezes imported oracle helpers outside explicit implementation repair paths', async () => {
    const f = fixture('enforced', (repo) => {
      writeFileSync(join(repo.root, 'oracle-helper.mjs'), 'export const enabled=true;\n');
      writeFileSync(join(repo.root, 'node_modules/vitest/vitest.mjs'), `import {enabled} from '../../oracle-helper.mjs';${UNIT_RUNNER.replace('if(bad)', 'if(bad && enabled)')}`);
    });
    const { host, report, artifactsDir } = await execute(f); if (process.platform !== 'darwin') return;
    await expect(host.repair(report, async () => { writeFileSync(join(f.candidate.root, 'oracle-helper.mjs'), 'export const enabled=false;\n'); commit(f.candidate, 'weaken oracle helper, not implementation'); }, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/outside approved implementation paths/);
  });

  it('refuses repair allocation when the owner approved no implementation paths', async () => {
    const f = fixture(); f.reviewed.implementationPaths = [];
    const { host, report, artifactsDir } = await execute(f); if (process.platform !== 'darwin') return;
    await expect(host.repair(report, async () => { throw new Error('no writer approved'); }, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/no implementation repair paths/);
  });

  it('refuses an original assertion becoming skipped while a different selected assertion passes', async () => {
    const skipped = `console.log(JSON.stringify({numTotalTests:2,numPassedTests:1,numFailedTests:0,numPendingTests:1,numTodoTests:0,success:true,testResults:[{name:process.cwd()+'/${UNIT_PATH}',status:'passed',message:'',assertionResults:[{status:'skipped',fullName:'contract',failureMessages:[]},{status:'passed',fullName:'replacement assertion',failureMessages:[]}]}]}));`;
    const script = `import fs from 'node:fs';if(fs.readFileSync('test/placeholder','utf8')==='skip\\n'){${skipped}}else{${UNIT_RUNNER.replace("import fs from 'node:fs';", '')}}`;
    const f = fixture('enforced', runnerSetup(script)); const { host, report, artifactsDir } = await execute(f); if (process.platform !== 'darwin') return;
    await expect(host.repair(report, async () => { writeFileSync(join(f.candidate.root, 'test/placeholder'), 'skip\n'); commit(f.candidate, 'skip original assertion via implementation state'); }, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/original frozen assertion/);
  });

  it('uses enforced CLI status 1 for a qualified replayed candidate blocker', async () => {
    const f = fixture(); const file = join(dir(), 'campaign.json'); writeFileSync(file, JSON.stringify(f.reviewed));
    const result = await runPropertyCheck(['--approve-reviewed-campaign', file, '--artifacts-dir', dir()]);
    if (process.platform !== 'darwin') { expect(result.exitCode).toBe(2); return; }
    expect(JSON.parse(result.stdout).blocking).toBe(true); expect(result.exitCode).toBe(1);
  });

  it('returns observation CLI status 0 for a refused/unqualified report without pretending qualification', async () => {
    const f = fixture('observation', runnerSetup(PASS_RUNNER.replaceAll('test/contract.test.ts', UNIT_PATH)));
    const file = join(dir(), 'campaign.json'); writeFileSync(file, JSON.stringify(f.reviewed));
    const result = await runPropertyCheck(['--approve-reviewed-campaign', file, '--artifacts-dir', dir()]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'observation', blocking: false, qualification: { verdict: process.platform === 'darwin' ? 'rejected-vacuous' : 'escalated' } });
  });

  it('does not count a null-receipt unsupported replay as an executed replay', async () => {
    const script = UNIT_RUNNER.replace('Counterexample: [1]', 'No native counterexample line');
    const f = fixture('enforced', runnerSetup(script)); const { report } = await execute(f); if (process.platform !== 'darwin') return;
    expect(report).toMatchObject({ replay: 'unsupported-replay', blocking: false, metrics: { replayReliability: { replayed: 0, reproduced: 0 } } });
  });
});

describe('synthetic provisioning destination preflight (never an installer)', () => {
  function synthetic() {
    const root = dir(); const script = join(root, 'tools/provision-property-real-fixture.mjs'); mkdirSync(dirname(script), { recursive: true });
    cpSync(resolve('tools/provision-property-real-fixture.mjs'), script);
    const target = join(root, 'test/fixtures/property/real-tool'); mkdirSync(target, { recursive: true });
    return { root, target, script };
  }
  const preflight = (script: string, home: string) => spawnSync(process.execPath, [script, 'preflight'], { encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C' } });
  it('refuses provisioning root, stage and home aliases without writing outside or invoking npm', () => {
    for (const relative of ['.provisioning', '.provisioning/materialize', '.provisioning/materialize/home']) {
      const f = synthetic(); const outside = dir(); mkdirSync(dirname(join(f.target, relative)), { recursive: true }); symlinkSync(outside, join(f.target, relative));
      const result = preflight(f.script, f.root); expect(result.status).toBe(1); expect(result.stderr).toContain('ordinary directory'); expect(readdirSync(outside)).toEqual([]);
    }
  });
  it('keeps a successful provisioning preflight read-only with no materialization', () => {
    const f = synthetic(); const result = preflight(f.script, f.root);
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain('no installer invoked'); expect(readdirSync(f.target)).toEqual([]);
    expect(existsSync(join(f.target, 'node_modules'))).toBe(false);
  });
});
