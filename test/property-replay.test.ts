import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPropertyExecutor } from '../src/property/executor.js';
import { VITEST_FAST_CHECK_ADAPTER as adapter } from '../src/property/adapters/vitest-fast-check.js';
import { replayRetainedCounterexample } from '../src/property/replay.js';
import { extractShrinkPath, retainedCounterexample } from '../src/property/receipts.js';
import { FAILURE_RUNNER, scenarioRepo, REPORT_FRAME } from './fixtures/property/executor/helpers.js';
const fixtures: ReturnType<typeof scenarioRepo>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
async function capture(script = FAILURE_RUNNER) {
  const f = scenarioRepo(script); fixtures.push(f); const executor = createPropertyExecutor();
  const input = { plan: f.plan, repoRoot: f.root, packageDir: f.root, adapter };
  const result = await executor.executePlan({ ...input, approval: executor.approvePlan(input) });
  if (process.platform !== 'darwin') { expect(result.executed).toBe(false); return null; }
  if (!result.executed) throw new Error(result.refusal.reason);
  return { ...input, executor, result };
}
describe('retained counterexample replay (fake unit controls, not real-tool proof)', () => {
  it('extracts the native fast-check shrink path rather than inventing shrink steps', () => {
    expect(extractShrinkPath('{ seed: 42, path: "0:2:1", endOnFailure: true }')).toEqual(['0:2:1']);
    expect(extractShrinkPath('no shrink evidence')).toEqual([]);
  });
  it('retains seed, native path and minimized input from the actual captured report', async () => {
    const r = await capture(); if (r === null) return;
    expect(r.result.receipt.counterexample).toMatchObject({ minimizedInput: '[1]', replay: { seed: '42', shrinkPath: ['0:1'], replaySupported: true } });
    expect(retainedCounterexample({ outcome: { ...r.result.receipt.outcome, kind: 'pass' }, environmentProfile: 'test' })).toBeNull();
  });
  it('replays through the same sandboxed executor and requires exact evidence and environment identities', async () => {
    const r = await capture(); if (r === null) return;
    const replay = await replayRetainedCounterexample({ ...r, counterexample: r.result.receipt.counterexample!, originalReceipt: r.result.receipt });
    expect(replay.kind, replay.disclosure).toBe('reproduced'); expect(replay.environmentMatch).toBe(true);
  });
  it('retains complete bounded native replay data independently of the 400-byte display excerpt', async () => {
    const input = JSON.stringify(Array.from({ length: 1500 }, () => 1));
    const message = `${'display padding '.repeat(70)}\nProperty failed\n{ seed: 42, path: "0:1", endOnFailure: true }\nCounterexample: ${input}\nShrunk 1 time(s)`;
    const script = `${REPORT_FRAME}__report(({numTotalTests:1,numPassedTests:0,numFailedTests:1,numPendingTests:0,numTodoTests:0,success:false,testResults:[{name:process.cwd()+'/test/contract.test.ts',status:'failed',message:'',assertionResults:[{status:'failed',fullName:'contract',failureMessages:[${JSON.stringify(message)}]}]}]}));process.exitCode=1;`;
    const r = await capture(script); if (r === null) return;
    expect(r.result.receipt.outcome.failures[0]!.messageExcerpt.length).toBeLessThanOrEqual(401);
    expect(r.result.receipt.counterexample).toMatchObject({ testIdentity: 'contract', minimizedInput: input, replay: { seed: '42', shrinkPath: ['0:1'], replaySupported: true } });
  });
  it('does not reproduce a different assertion with the same input, seed and unchanged harness bytes', async () => {
    const script = `const assertion=process.env.GRU_PROPERTY_SEED===undefined?'contract':'different assertion';${FAILURE_RUNNER.replace("fullName:'contract'", 'fullName:assertion')}`;
    const r = await capture(script); if (r === null) return;
    const result = await replayRetainedCounterexample({ ...r, counterexample: r.result.receipt.counterexample!, originalReceipt: r.result.receipt });
    expect(result.receipt?.counterexample?.minimizedInput).toBe('[1]'); expect(result.receipt?.identity.dependencyTreeSha256).toBe(r.result.receipt.identity.dependencyTreeSha256);
    expect(result.kind).toBe('not-reproduced'); expect(result.receipt?.counterexample?.testIdentity).toBe('different assertion');
  });
  it('rejects same-version dependency drift even when the replay receives a fresh valid execution approval', async () => {
    const r = await capture(); if (r === null) return;
    writeFileSync(join(r.repoRoot, 'node_modules/vitest/same-version-extra.mjs'), '// changed installed bytes without a version change\n');
    const result = await replayRetainedCounterexample({ ...r, counterexample: r.result.receipt.counterexample!, originalReceipt: r.result.receipt });
    expect(result.receipt?.outcome.kind).toBe('property-failure'); expect(result.receipt?.counterexample?.minimizedInput).toBe('[1]');
    expect(result.receipt?.identity.dependencyTreeSha256).not.toBe(r.result.receipt.identity.dependencyTreeSha256); expect(result.kind).toBe('not-reproduced');
  });
  it('rejects a serialized original receipt at the production replay boundary', async () => {
    const r = await capture(); if (r === null) return;
    await expect(replayRetainedCounterexample({ ...r, counterexample: r.result.receipt.counterexample!, originalReceipt: JSON.parse(JSON.stringify(r.result.receipt)) })).rejects.toThrow(/host-issued/);
  });
  it('discloses changed minimized inputs instead of claiming reproduction', async () => {
    const r = await capture(); if (r === null) return;
    await expect(replayRetainedCounterexample({ ...r, counterexample: { ...r.result.receipt.counterexample!, minimizedInput: '[999]' }, originalReceipt: r.result.receipt })).rejects.toThrow(/original/);
  });
});
