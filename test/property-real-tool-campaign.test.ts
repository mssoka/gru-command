import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createPropertyCampaignHost, isHostPropertyRepairDirective, isHostPropertyResult, propertyEvidenceForReview, type PropertyRepairDirective } from '../src/property/pipeline.js';
import { createPropertyExecutor } from '../src/property/executor.js';
import { VITEST_FAST_CHECK_ADAPTER as adapter } from '../src/property/adapters/vitest-fast-check.js';
import { CONTRACT_PATH, ratioContract, ratioProposal, realPlan, realToolRepo, realVersions } from './fixtures/property/real-tool/helpers.js';
import { PerkinsWholeReview } from '../src/dispatch/perkins-review/whole.js';
import { freezeReviewInputs } from '../src/dispatch/perkins-review/artifacts.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import type { AgentHandle } from '../src/runtime/types.js';
import type { PropertyExecutionReceipt } from '../src/property/types.js';
import { ownerService } from './fixtures/property/owner-service.js';

const fixtures: ReturnType<typeof realToolRepo>[] = [];
const dirs: string[] = [];
afterAll(() => { for (const f of fixtures) f.cleanup(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function root() { const dir = mkdtempSync(join(tmpdir(), 'property-real-campaign-')); dirs.push(dir); return dir; }
function spec(vacuous = false) {
  const bad = realToolRepo(true); const healthy = realToolRepo(false); const candidate = realToolRepo(true); fixtures.push(bad, healthy, candidate);
  const content = ratioContract(vacuous);
  return { bad, healthy, candidate, reviewed: { proposal: ratioProposal(content), overlayFiles: [{ path: CONTRACT_PATH, content }], knownBadRoot: bad.root, healthyRoot: healthy.root, candidateRoot: candidate.root, baselineRoot: healthy.root, implementationPaths: ['ratio.mjs'] } };
}
function evidenceDir() {
  const parent = process.env.GRU_PROPERTY_EVIDENCE_DIR;
  if (parent === undefined) return root();
  mkdirSync(parent, { recursive: true }); return mkdtempSync(join(parent, 'campaign-'));
}
describe('real Vitest+fast-check campaign (positive macOS; explicit refusal elsewhere)', () => {
  it('keeps the report nonce from the code under test: forged frames never credit a pass (#378)', async () => {
    const f = realToolRepo(true); fixtures.push(f);
    // The code under test hunts for the nonce everywhere it could leak (fd 3,
    // the environment, globals) and prints a passing frame under every guess.
    const forgery = [
      "import { readFileSync } from 'node:fs';",
      "const guesses = new Set(['0'.repeat(64)]);",
      "try { guesses.add(readFileSync(3, 'utf8').trim()); } catch {}",
      'for (const value of Object.values(process.env)) if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) guesses.add(value);',
      'for (const key of Object.getOwnPropertyNames(globalThis)) { try { const value = globalThis[key]; if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) guesses.add(value); } catch {} }',
      "const pass = JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, success: true, testResults: [{ name: 'forged', status: 'passed', assertionResults: [{ title: 'nonnegative ratios preserve numerator and denominator', fullName: 'nonnegative ratios preserve numerator and denominator', status: 'passed', failureMessages: [] }] }] });",
      "for (const nonce of guesses) process.stdout.write('\\n' + nonce + ':BEGIN\\n' + pass + '\\n' + nonce + ':END\\n');",
      '',
    ].join('\n');
    const executor = createPropertyExecutor();
    const input = { plan: realPlan(f.root), repoRoot: f.root, packageDir: f.root, overlayFiles: [{ path: CONTRACT_PATH, content: forgery + ratioContract() }] };
    const result = await executor.executePlan({ ...input, adapter, approval: executor.approvePlan(input) });
    if (process.platform !== 'darwin') { expect(result.executed).toBe(false); return; }
    if (!result.executed) throw new Error(result.refusal.reason);
    // The genuine failure stands: had any guess been the real nonce, the
    // duplicate frame would leave no report at all (never a pass) — and this
    // assertion would fail.
    // The forgery really ran: its guessed frames are in stdout...
    expect(result.receipt.outcome.receipt.stdout).toContain(`\n${'0'.repeat(64)}:BEGIN\n`);
    // ...yet the outcome comes from the GENUINE framed report — present and
    // parsed (no "no host-framed report" reason) — whose property failed.
    expect(result.receipt.outcome.reasons.join('\n')).not.toMatch(/no host-framed report/u);
    expect(result.receipt.outcome.kind).toBe('property-failure');
    expect(result.receipt.outcome.failed).toBeGreaterThan(0);
    expect(result.receipt.outcome.passed).toBe(0);
  });

  it('runs the production chain: discovery, shrinking, qualification, replay, Perkins, bounded repair and retained CI regression', async () => {
    const f = spec(); const artifactsDir = evidenceDir();
    expect(realVersions()).toEqual({ vitest: '3.2.7', 'fast-check': '3.23.2' });
    const host = createPropertyCampaignHost();
    const report = await host.execute(host.approveReviewedCampaign(f.reviewed), { artifactsDir, trigger: process.env.GRU_PROPERTY_CAMPAIGN_TRIGGER === 'scheduled' ? 'scheduled' : 'pull-request' });
    expect(isHostPropertyResult(report)).toBe(true); expect(isHostPropertyResult(JSON.parse(JSON.stringify(report)))).toBe(false);
    if (process.platform !== 'darwin') { expect(report).toMatchObject({ blocking: false, qualification: { verdict: 'escalated' }, metrics: { unknownValidity: 1, executedRuns: 0 } }); expect(report.disclosure).toContain('no supported sandbox'); return; }
    expect(report).toMatchObject({ qualification: { verdict: 'qualified' }, attribution: 'candidate-only', candidateOutcome: 'property-failure', replay: 'reproduced', blocking: true, mergeAuthority: 'none', metrics: { actionableDefects: 1, invalidOracles: 0, replayReliability: { replayed: 1, reproduced: 1 }, totalTokenCost: null } });
    const receipts = readdirSync(artifactsDir).filter((name) => name.startsWith('pex-')).map((name) => JSON.parse(readFileSync(join(artifactsDir, name), 'utf8')) as PropertyExecutionReceipt);
    const failure = receipts.find((entry) => entry.counterexample !== null)!;
    expect(failure.counterexample?.minimizedInput).toBe('[[1,1]]');
    expect(failure.counterexample?.replay.shrinkPath[0]).toMatch(/^\d+(?::\d+)+$/u);
    expect(failure.outcome.failures[0]!.messageExcerpt).toMatch(/Shrunk [1-9][0-9]* time/);
    expect(failure.sandbox).toMatchObject({ networkDenied: true, filesystemIsolated: true, credentialsStripped: true });
    expect(receipts.some((entry) => entry.outcome.kind === 'pass')).toBe(true);

    const reviewRoot = root(); const sessions = join(reviewRoot, 'sessions'); mkdirSync(sessions);
    const head = f.candidate.git('rev-parse', 'HEAD').trim();
    const snapshot = join(reviewRoot, 'snapshot');
    f.candidate.git('worktree', 'add', '--detach', snapshot, head);
    const review = freezeReviewInputs({ roundId: 'property-production-review', repoPath: snapshot, artifactRoot: join(reviewRoot, 'reviews'), baseRef: f.healthy.git('rev-parse', 'HEAD').trim(), targetRef: head, movementRef: 'HEAD', spec: 'ratio(n,d) must equal n/d for nonnegative n and positive d' });
    const model = fakeWholeSpawner(sessions, { specialists: [], childAnswer: () => '[]' });
    await expect(new PerkinsWholeReview({ policy: loadPerkinsPolicy(), spawner: model.spawner }).run({ roundId: 'property-production-review', roundNumber: 1, frozenReview: review, movementRef: 'HEAD', noSpec: false })).rejects.toThrow(/qualified-property-counterexample/);
    expect(JSON.parse(readFileSync(join(review.directory, 'property/host-evidence.json'), 'utf8'))).toMatchObject({ id: report.id, blocking: true });

    const dbRoot = root(); const db = new LedgerDb(dbRoot);
    try {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: 'ratio-job', repo: 'ratio', title: 'Repair qualified ratio defect' }); ledger.setJobStatus('ratio-job', 'working');
      ledger.registerAgent({ id: 'ratio-minion', role: 'minion', jobId: 'ratio-job' }); ledger.setAgentState('ratio-minion', 'idle');
      const handle: AgentHandle = { id: 'ratio-minion', role: 'minion', sessionFile: null,
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async prompt(text) { expect(text).toContain('Repair the implementation, NOT the frozen oracle'); expect(text).toContain('[[1,1]]'); f.candidate.repair(); },
        async steer() {}, async followUp() {}, subscribe() { return () => {}; }, health() { return { state: 'idle', lastActivity: null, sessionFile: null }; }, async dispose() {} };
      // Production delivery is the property-campaign service's durable
      // directive path (test/property-owner-actions.test.ts); this real-tool
      // proof only needs the host to hand its issued directive to the minion.
      const deliver = async (directive: PropertyRepairDirective): Promise<void> => {
        if (!isHostPropertyRepairDirective(directive)) throw new Error('unissued property repair directive');
        await handle.prompt(directive.text);
      };
      const repaired = await host.repair(report, deliver, { artifactsDir, maxAttempts: 1 });
      expect(repaired).toMatchObject({ blocking: false, candidateOutcome: 'pass', repairAttempts: 1, mergeAuthority: 'none' });
      expect(propertyEvidenceForReview(f.candidate.root, repaired.candidateSha)).toBe(repaired);
      await expect(host.repair(report, deliver, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/consumed/);
      const retained = host.retainReviewedRegression(repaired);
      expect(retained).toHaveLength(3); expect(existsSync(join(f.candidate.root, retained[1]!))).toBe(true);
      expect(readFileSync(join(f.candidate.root, CONTRACT_PATH), 'utf8')).toBe(f.reviewed.overlayFiles[0]!.content);
      expect(readFileSync(join(f.candidate.root, retained[1]!), 'utf8')).toContain(failure.counterexample!.replay.shrinkPath[0]);
      expect(JSON.parse(readFileSync(join(f.candidate.root, retained[2]!), 'utf8')).counterexample.minimizedInput).toBe('[[1,1]]');
      f.candidate.git('add', '.'); f.candidate.git('commit', '-qm', 'retain reviewed minimized regression');
      expect(propertyEvidenceForReview(f.candidate.root, f.candidate.git('rev-parse', 'HEAD').trim())).toBeNull();
      const regressionExecutor = createPropertyExecutor();
      const regressionInput = { plan: { ...realPlan(f.candidate.root), args: ['run', '--reporter=json', retained[1]!] }, repoRoot: f.candidate.root, packageDir: f.candidate.root, adapter };
      const regression = await regressionExecutor.executePlan({ ...regressionInput, approval: regressionExecutor.approvePlan(regressionInput) });
      if (!regression.executed) throw new Error(regression.refusal.reason);
      expect(regression.receipt.outcome.kind, JSON.stringify(regression.receipt.outcome)).toBe('pass');
      const ci = await host.execute(host.approveReviewedCampaign(f.reviewed), { artifactsDir, trigger: 'pull-request' });
      expect(ci).toMatchObject({ candidateOutcome: 'pass', blocking: false, mergeAuthority: 'none' });
    } finally { db.close(); }
  });

  it('replays the minimized native path during incremental repair and retains the candidate counterexample, not the control example', async () => {
    const f = spec(); const artifactsDir = evidenceDir(); const host = createPropertyCampaignHost();
    writeFileSync(join(f.candidate.root, 'ratio.mjs'), 'export function ratio(n,d){return n>=11?0:n/d;}\n');
    f.candidate.git('add', 'ratio.mjs'); f.candidate.git('commit', '-qm', 'distinct candidate defect');
    const report = await host.execute(host.approveReviewedCampaign(f.reviewed), { artifactsDir, trigger: 'pull-request' });
    if (process.platform !== 'darwin') { expect(report.qualification?.verdict).toBe('escalated'); return; }
    expect(report).toMatchObject({ blocking: true, replay: 'reproduced' });
    const partial = await host.repair(report, async () => {
      // The seed's ordinary random cases pass, but the retained minimum still
      // fails. Repair validation must exercise the native shrink path too.
      writeFileSync(join(f.candidate.root, 'ratio.mjs'), 'export function ratio(n,d){return n===11&&d===1?0:n/d;}\n');
      f.candidate.git('add', 'ratio.mjs'); f.candidate.git('commit', '-qm', 'incomplete edge-case repair');
    }, { artifactsDir, maxAttempts: 1 });
    expect(partial).toMatchObject({ candidateOutcome: 'property-failure', blocking: true, repairAttempts: 1 });
    const repaired = await host.repair(partial, async () => { f.candidate.repair(); }, { artifactsDir, maxAttempts: 1 });
    expect(repaired).toMatchObject({ candidateOutcome: 'pass', blocking: false, repairAttempts: 2 });
    const retained = host.retainReviewedRegression(repaired);
    const evidence = JSON.parse(readFileSync(join(f.candidate.root, retained[2]!), 'utf8'));
    expect(evidence.counterexample.minimizedInput).toBe('[[11,1]]');
    const controls = readdirSync(artifactsDir).filter((name) => name.startsWith('pex-')).map((name) => JSON.parse(readFileSync(join(artifactsDir, name), 'utf8')) as PropertyExecutionReceipt);
    expect(controls.some((entry) => entry.counterexample?.minimizedInput === '[[1,1]]')).toBe(true);
    const validation = controls.find((entry) => entry.identity.source.kind === 'clean-sha' && entry.identity.source.sha === repaired.candidateSha)!;
    expect(validation.replay).toMatchObject({ seed: evidence.counterexample.replay.seed, shrinkPath: evidence.counterexample.replay.shrinkPath });
  });

  it('drives real qualification, Perkins blocking, minion repair and reviewed retention through the ordinary owner HTTP service', async () => {
    const f = spec(); const artifactsDir = evidenceDir(); const h = await ownerService(f.candidate.root, () => f.candidate.repair());
    try {
      const proposed = await h.request(h.path, { campaign: f.reviewed }); expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
      const id = proposed.body.id; const expectedHead = proposed.body.candidateSha;
      expect(proposed.body.report).toBeNull(); expect(h.prompts).toEqual([]);
      const executed = await h.request(`${h.path}/${id}/execute`, { decision: 'approve', expectedHead });
      expect(executed.status, JSON.stringify(executed.body)).toBe(200);
      if (process.platform !== 'darwin') { expect(executed.body.report?.qualification?.verdict).toBe('escalated'); return; }
      expect(executed.body.report).toMatchObject({ blocking: true, attribution: 'candidate-only', replay: 'reproduced', qualification: { verdict: 'qualified' }, mergeAuthority: 'none' });
      const issued = propertyEvidenceForReview(f.candidate.root, expectedHead!)!;
      expect(isHostPropertyResult(issued)).toBe(true); expect(issued.id).toBe(executed.body.report!.id);
      const sessions = join(artifactsDir, 'sessions'); mkdirSync(sessions);
      const snapshot = join(artifactsDir, 'snapshot'); f.candidate.git('worktree', 'add', '--detach', snapshot, expectedHead!);
      const review = freezeReviewInputs({ roundId: 'owner-service-property-review', repoPath: snapshot, artifactRoot: join(artifactsDir, 'reviews'), baseRef: f.healthy.git('rev-parse', 'HEAD').trim(), targetRef: expectedHead!, movementRef: 'HEAD', spec: 'ratio(n,d) must equal n/d' });
      const model = fakeWholeSpawner(sessions, { specialists: [], childAnswer: () => '[]' });
      await expect(new PerkinsWholeReview({ policy: loadPerkinsPolicy(), spawner: model.spawner }).run({ roundId: 'owner-service-property-review', roundNumber: 1, frozenReview: review, movementRef: 'HEAD', noSpec: false })).rejects.toThrow(/qualified-property-counterexample/);
      expect((await h.request(`${h.path}/${id}/repair`, {})).body.proposedAction).toBe('repair'); expect(h.prompts).toEqual([]);
      const repaired = await h.request(`${h.path}/${id}/repair`, { decision: 'approve', expectedHead, maxAttempts: 1 });
      expect(repaired.status, JSON.stringify(repaired.body)).toBe(200); expect(repaired.body.report).toMatchObject({ candidateOutcome: 'pass', blocking: false, repairAttempts: 1 }); expect(h.prompts).toHaveLength(1);
      expect(h.ledger.latestJobEvent(h.jobId, 'job.delivered')?.payload).toMatchObject({ sha: repaired.body.candidateSha });
      const retained = await h.request(`${h.path}/${id}/retain`, { decision: 'approve', expectedHead: repaired.body.candidateSha });
      expect(retained.status, JSON.stringify(retained.body)).toBe(200); expect(retained.body.retainedPaths).toHaveLength(3);
      const example = JSON.parse(readFileSync(join(f.candidate.root, retained.body.retainedPaths[2]!), 'utf8'));
      expect(example.counterexample.minimizedInput).toBe('[[1,1]]'); expect(example.counterexample.testIdentity).toContain('nonnegative ratios');
      expect(propertyEvidenceForReview(f.candidate.root, repaired.body.candidateSha!)).toBeNull();
      cpSync(join(h.dir, 'campaigns'), join(artifactsDir, 'owner-service-campaigns'), { recursive: true });
    } finally { await h.close(); }
  });

  it('rejects a real repair that weakens an imported assertion helper outside approved implementation paths', async () => {
    const f = spec(); const source = ratioContract().replace("import {ratio}", "import {checkRatio} from '../../assertions.mjs';import {ratio}").replace('expect(ratio(n,d)).toBe(n/d);', 'checkRatio(ratio(n,d),n/d);');
    for (const repo of [f.bad, f.healthy, f.candidate]) { writeFileSync(join(repo.root, 'assertions.mjs'), "import {expect} from 'vitest';export function checkRatio(actual,expected){expect(actual).toBe(expected);}\n"); repo.git('add', '.'); repo.git('commit', '-qm', 'reviewed imported assertion helper'); }
    f.candidate.git('fetch', f.healthy.root, 'HEAD'); f.candidate.git('reset', '--soft', 'FETCH_HEAD'); f.candidate.git('commit', '-qm', 'candidate with reviewed oracle helper');
    const reviewed = { ...f.reviewed, proposal: ratioProposal(source), overlayFiles: [{ path: CONTRACT_PATH, content: source }] };
    const host = createPropertyCampaignHost(); const artifactsDir = evidenceDir();
    const report = await host.execute(host.approveReviewedCampaign(reviewed), { artifactsDir, trigger: 'pull-request' });
    if (process.platform !== 'darwin') { expect(report.qualification?.verdict).toBe('escalated'); return; }
    expect(report.blocking).toBe(true);
    await expect(host.repair(report, async () => { writeFileSync(join(f.candidate.root, 'assertions.mjs'), 'export function checkRatio(){}\n'); f.candidate.git('add', '.'); f.candidate.git('commit', '-qm', 'weaken imported oracle instead of implementation'); }, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/outside approved implementation paths/);
  });

  it('rejects a real implementation repair that skips the original failing assertion while another test passes', async () => {
    const f = spec(); const source = ratioContract().replace("it('nonnegative ratios", "it.skipIf(ratio('skip',1)===true)('nonnegative ratios") + "it('another selected assertion',()=>expect(true).toBe(true));\n";
    const reviewed = { ...f.reviewed, proposal: ratioProposal(source), overlayFiles: [{ path: CONTRACT_PATH, content: source }] };
    const host = createPropertyCampaignHost(); const artifactsDir = evidenceDir();
    const report = await host.execute(host.approveReviewedCampaign(reviewed), { artifactsDir, trigger: 'pull-request' });
    if (process.platform !== 'darwin') { expect(report.qualification?.verdict).toBe('escalated'); return; }
    expect(report.blocking).toBe(true);
    await expect(host.repair(report, async () => { writeFileSync(join(f.candidate.root, 'ratio.mjs'), "export function ratio(n,d){return n==='skip'?true:0;}\n"); f.candidate.git('add', '.'); f.candidate.git('commit', '-qm', 'skip original property through implementation state'); }, { artifactsDir, maxAttempts: 1 })).rejects.toThrow(/original frozen assertion/);
  });

  it('rejects an actually vacuous oracle that accepts the known-bad ratio implementation', async () => {
    const f = spec(true); const host = createPropertyCampaignHost();
    const report = await host.execute(host.approveReviewedCampaign(f.reviewed), { artifactsDir: evidenceDir(), trigger: 'scheduled' });
    if (process.platform !== 'darwin') { expect(report.qualification?.verdict).toBe('escalated'); return; }
    expect(report).toMatchObject({ qualification: { verdict: 'rejected-vacuous' }, frozen: null, candidateRef: null, blocking: false, metrics: { invalidOracles: 1, actionableDefects: 0, executedRuns: 2 } });
    await expect(host.repair(report, async () => { throw new Error('must never deliver'); }, { artifactsDir: evidenceDir(), maxAttempts: 1 })).rejects.toThrow(/qualified/);
  });
});
