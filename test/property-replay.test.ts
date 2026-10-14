import { afterEach, describe, expect, it } from 'vitest';
import { createPropertyExecutor } from '../src/property/executor.js';
import { VITEST_FAST_CHECK_ADAPTER as adapter } from '../src/property/adapters/vitest-fast-check.js';
import { replayRetainedCounterexample } from '../src/property/replay.js';
import { extractShrinkPath, retainedCounterexample } from '../src/property/receipts.js';
import { FAILURE_RUNNER, scenarioRepo } from './fixtures/property/executor/helpers.js';
const fixtures: ReturnType<typeof scenarioRepo>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
async function capture() {
  const f = scenarioRepo(FAILURE_RUNNER); fixtures.push(f); const executor = createPropertyExecutor();
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
  it('rejects a serialized original receipt at the production replay boundary', async () => {
    const r = await capture(); if (r === null) return;
    await expect(replayRetainedCounterexample({ ...r, counterexample: r.result.receipt.counterexample!, originalReceipt: JSON.parse(JSON.stringify(r.result.receipt)) })).rejects.toThrow(/host-issued/);
  });
  it('discloses changed minimized inputs instead of claiming reproduction', async () => {
    const r = await capture(); if (r === null) return;
    await expect(replayRetainedCounterexample({ ...r, counterexample: { ...r.result.receipt.counterexample!, minimizedInput: '[999]' }, originalReceipt: r.result.receipt })).rejects.toThrow(/original/);
  });
});
