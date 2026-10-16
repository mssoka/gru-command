import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBoundedPropertyCapture, createPropertyExecutor, PreExecutionRejectionError, createReceiptRetention, framedRunnerReport, isSealedExecutionReceipt, noReportReasons, NONCE_READ_BUDGET_MS, nonceReaderSource, propertyWorkspaceIdentity, ReceiptRetentionError, resolveSandboxBackend, validatePlanAgainstHostApproval } from '../src/property/executor.js';
import { VITEST_FAST_CHECK_ADAPTER as adapter } from '../src/property/adapters/vitest-fast-check.js';
import { applyOverlayFiles, applyOverlayFilesAllOrNothing } from '../src/property/overlay.js';
import { buildSourceIdentity } from '../src/property/receipts.js';
import { PASS_RUNNER, scenarioRepo } from './fixtures/property/executor/helpers.js';
const fixtures: ReturnType<typeof scenarioRepo>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function fixture(script = PASS_RUNNER) { const f = scenarioRepo(script); fixtures.push(f); return f; }
function ceilings() { return { maxRunTimeoutMs: 900_000, maxMaxOutputBytes: 8 * 1024 * 1024 }; }
async function run(script: string, opts: { readonly timeout?: number; readonly output?: number; readonly env?: Record<string, string> } = {}) {
  const f = fixture(script); const executor = createPropertyExecutor({ envSource: opts.env });
  const plan = { ...f.plan, budget: { ...f.plan.budget, runTimeoutMs: opts.timeout ?? 10_000, maxOutputBytes: opts.output ?? 32_768 } };
  const approval = executor.approvePlan({ plan, repoRoot: f.root, packageDir: f.root });
  const result = await executor.executePlan({ plan, adapter, repoRoot: f.root, packageDir: f.root, approval });
  if (process.platform !== 'darwin') { expect(result.executed).toBe(false); return null; }
  if (!result.executed) throw new Error(result.refusal.reason);
  return { ...result, executor, fixture: f };
}
describe('host property executor (positive sandbox controls on macOS; other hosts refuse)', () => {
  it('does not execute repository clean filters while discovering committed source identity', () => {
    const f = fixture(); const marker = join(f.root, 'filter-executed'); const script = join(f.root, 'owned-filter.mjs');
    writeFileSync(join(f.root, '.gitattributes'), 'test/placeholder filter=property-owned\n'); f.git(['add', '.gitattributes']); f.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'owned filter attribute']);
    writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');process.stdout.write(fs.readFileSync(0));`);
    f.git(['config', 'filter.property-owned.clean', `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`]); f.git(['config', 'filter.property-owned.required', 'true']);
    writeFileSync(join(f.root, 'test/placeholder'), 'tracked\n'); // force an index-stat refresh with identical bytes
    expect(buildSourceIdentity(f.root).kind).toBe('clean-sha'); expect(existsSync(marker)).toBe(false);
  });
  it('retains fixed capture storage under sustained post-cap flooding, not incoming backing allocations', () => {
    const source = `const POLICY={maxMaxOutputBytes:67108864};const capture=(${createBoundedPropertyCapture.toString()})(1024);global.gc();const before=process.memoryUsage().arrayBuffers;const first=Buffer.from('abc');capture.push('stdout',first);first.fill(122);for(let i=0;i<2000;i++){capture.push('stdout',Buffer.alloc(131072,120));capture.push('stderr',Buffer.alloc(131072,121));}global.gc();global.gc();console.log(JSON.stringify({retained:process.memoryUsage().arrayBuffers-before,capacity:capture.capacityBytes,...capture.finish()}));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15_000, env: { PATH: '/usr/bin:/bin', LANG: 'C' } }));
    expect(result.retained).toBeLessThan(2 * 1024 * 1024); expect(result.capacity).toBe(2048); expect(result.stdout).toHaveLength(1024); expect(result.stderr).toHaveLength(1024); expect(result.stdout.startsWith('abc')).toBe(true); expect(result.complete).toBe(false);
  });
  it('allocates capture storage only for bytes actually kept, never 2 × the cap up front (#377)', () => {
    const source = `const POLICY={maxMaxOutputBytes:8388608};global.gc();const before=process.memoryUsage().arrayBuffers;const capture=(${createBoundedPropertyCapture.toString()})(8388608);capture.push('stdout',Buffer.from('small output'));global.gc();console.log(JSON.stringify({allocated:process.memoryUsage().arrayBuffers-before,capacity:capture.capacityBytes,stdout:capture.finish().stdout}));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15_000, env: { PATH: '/usr/bin:/bin', LANG: 'C' } }));
    expect(result.capacity).toBeLessThanOrEqual(64 * 1024); // grows with output; nothing near the 8 MiB cap up front
    expect(result.allocated).toBeLessThan(1024 * 1024); // a 16 MiB preallocation would show here
    expect(result.stdout).toBe('small output');
  });
  it('keeps one growing buffer per stream under a flood of tiny writes, never one object per chunk (#377)', () => {
    const source = `const POLICY={maxMaxOutputBytes:8388608};const capture=(${createBoundedPropertyCapture.toString()})(65536);global.gc();const before=process.memoryUsage().arrayBuffers;for(let i=0;i<200000;i++)capture.push('stdout',Buffer.from([97+(i%26)]));global.gc();const out=capture.finish();console.log(JSON.stringify({retained:process.memoryUsage().arrayBuffers-before,capacity:capture.capacityBytes,length:out.stdout.length,head:out.stdout.slice(0,3),truncated:out.stdoutTruncated}));`;
    const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 15_000, env: { PATH: '/usr/bin:/bin', LANG: 'C' } }));
    expect(result).toMatchObject({ capacity: 65536, length: 65536, head: 'abc', truncated: true });
    expect(result.retained).toBeLessThan(1024 * 1024);
  });
  it('bounds retained receipts by count and summed output bytes, evicting the oldest first (#377)', () => {
    const retention = createReceiptRetention<string>({ maxReceipts: 3, maxBytes: 100 });
    retention.add('a', 'A', 40); retention.add('b', 'B', 40);
    expect([retention.get('a'), retention.get('b'), retention.retainedBytes]).toEqual(['A', 'B', 80]);
    retention.add('c', 'C', 40); // 120 bytes > 100: the oldest goes
    expect([retention.get('a'), retention.get('b'), retention.get('c'), retention.retainedBytes]).toEqual([undefined, 'B', 'C', 80]);
    retention.add('d', 'D', 10); retention.add('e', 'E', 10); // 4 receipts > 3: the oldest goes
    expect([retention.get('b'), retention.get('c'), retention.get('d'), retention.get('e'), retention.size]).toEqual([undefined, 'C', 'D', 'E', 3]);
    // A receipt that alone exceeds the byte bound is refused by name; nothing changes.
    expect(() => retention.add('huge', 'H', 500)).toThrow(ReceiptRetentionError);
    expect(() => retention.add('huge', 'H', 500)).toThrow(/^a 500-byte receipt exceeds the 100-byte retention bound$/u);
    expect([retention.size, retention.retainedBytes, retention.evicted]).toEqual([3, 60, 2]);
    // Re-adding an id replaces its bytes instead of double-counting them.
    retention.add('c', 'C2', 30);
    expect([retention.get('c'), retention.retainedBytes]).toEqual(['C2', 50]);
    // A read keeps a receipt warm: the least recently USED one goes first.
    retention.get('d'); retention.add('f', 'F', 10);
    expect([retention.get('e'), retention.get('d'), retention.get('f'), retention.evicted]).toEqual([undefined, 'D', 'F', 3]);
    expect(retention.get(undefined)).toBeUndefined();
  });
  it('a completed run whose receipt exceeds the retention bound is reported by name, never issued (#377)', async () => {
    const f = fixture(`process.stdout.write('y'.repeat(6000))`);
    const executor = createPropertyExecutor({ maxRetainedOutputBytes: 1024 });
    const input = { plan: f.plan, repoRoot: f.root, packageDir: f.root };
    const pending = executor.executePlan({ ...input, adapter, approval: executor.approvePlan(input) });
    if (process.platform !== 'darwin') { expect((await pending).executed).toBe(false); return; }
    const error = await pending.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReceiptRetentionError);
    expect(String(error)).toMatch(/^ReceiptRetentionError: the run completed \([a-z-]+\) but its receipt was not issued: a \d+-byte receipt exceeds the 1024-byte retention bound; raise the host retention bound or lower max_output_bytes$/u);
    expect(executor.retention()).toMatchObject({ receipts: 0, retainedOutputBytes: 0 });
  });
  it('names every reason a run has no authenticated report (#378)', () => {
    expect(noReportReasons({ stdoutTruncated: false, nonceChannelError: null })).toEqual(['no host-framed report: the run printed no single complete nonce frame']);
    expect(noReportReasons({ stdoutTruncated: true, nonceChannelError: null })).toEqual(['no host-framed report: stdout reached the output cap before the frame closed']);
    expect(noReportReasons({ stdoutTruncated: false, nonceChannelError: 'Error: EPIPE' })).toEqual(['no host-framed report: host report channel failed: Error: EPIPE']);
    expect(noReportReasons({ stdoutTruncated: true, nonceChannelError: 'Error: EPIPE' })).toEqual([
      'no host-framed report: stdout reached the output cap before the frame closed',
      'no host-framed report: host report channel failed: Error: EPIPE',
    ]);
  });
  it('reads the fd-3 nonce through EAGAIN within its budget, and a close failure never masks the read error (#378)', () => {
    type Step = number | string | Error;
    const errno = (code: string): Error => Object.assign(new Error(code), { code });
    const reader = (budgetMs = NONCE_READ_BUDGET_MS) => new Function('readSync', 'closeSync', `${nonceReaderSource(budgetMs)}\nreturn nonce;`) as (read: (fd: number, buffer: Buffer, offset: number, length: number) => number, close: (fd: number) => void) => string;
    const run = (steps: readonly Step[], closeError: Error | null = null, budgetMs = NONCE_READ_BUDGET_MS) => {
      const closed: number[] = [];
      const queue = [...steps];
      let reads = 0;
      const read = (fd: number, buffer: Buffer, offset: number, length: number): number => {
        expect(fd).toBe(3);
        reads += 1;
        const step = queue.shift() ?? 0;
        if (step instanceof Error) throw step;
        if (typeof step === 'string') return buffer.write(step, offset, length);
        return step;
      };
      const close = (fd: number) => { closed.push(fd); if (closeError !== null) throw closeError; };
      return { result: (() => { try { return reader(budgetMs)(read, close); } catch (error) { return error; } })(), closed, reads };
    };
    const nonce = 'c'.repeat(64);
    // A not-yet-written non-blocking channel is retried, then read whole, then closed.
    expect(run([errno('EAGAIN'), errno('EAGAIN'), `${nonce}\n`, 0])).toEqual({ result: nonce, closed: [3], reads: 4 });
    // Any other read error is the channel's failure — and still closes fd 3.
    expect(run([errno('EBADF')])).toMatchObject({ result: { code: 'EBADF' }, closed: [3] });
    // A close failure never masks the read's own error...
    expect(run([errno('EIO')], errno('EBADF'))).toMatchObject({ result: { code: 'EIO' } });
    // ...and is the failure when the read itself succeeded.
    expect(run([`${nonce}\n`, 0], errno('EBADF'))).toMatchObject({ result: { code: 'EBADF' } });
    // A channel that never delivers gives up after its bounded wait — one
    // read per 10 ms waited, then the last — and still closes (a 50 ms
    // budget here; the shipped config waits NONCE_READ_BUDGET_MS).
    expect(run(Array.from({ length: 100 }, () => errno('EAGAIN')), null, 50)).toMatchObject({ result: { code: 'EAGAIN' }, closed: [3], reads: 6 });
    expect(NONCE_READ_BUDGET_MS).toBe(5000);
    // A whole number of 10 ms steps, bounded: a startup never waits without end.
    for (const bad of [5, 15, 60_010, Number.NaN, 2 ** 53]) expect(() => nonceReaderSource(bad), String(bad)).toThrow(/^nonce reader budget must be a multiple of 10 ms from 10 to 60000, got /u);
    for (const good of [10, 50, 60_000, NONCE_READ_BUDGET_MS]) expect(() => nonceReaderSource(good), String(good)).not.toThrow();
  });
  it('refuses an invalid host receipt retention bound and reports the bound it enforces (#377)', () => {
    for (const bad of [0, -1, 1.5, 256 * 1024 * 1024 + 1]) expect(() => createPropertyExecutor({ maxRetainedOutputBytes: bad })).toThrow(/receipt retention bound/);
    expect(createPropertyExecutor({ maxRetainedOutputBytes: 4096 }).retention()).toEqual({ receipts: 0, retainedOutputBytes: 0, maxRetainedOutputBytes: 4096, evicted: 0 });
    expect(createPropertyExecutor().retention().maxRetainedOutputBytes).toBe(256 * 1024 * 1024);
    expect(() => createPropertyExecutor({ maxMaxOutputBytes: 8 * 1024 * 1024 + 1 })).toThrow(/invalid host ceiling/);
  });
  it('evicts the oldest sealed receipt past the retained-output bound; its ref then resolves to null (#377)', async () => {
    const f = fixture(`process.stdout.write('y'.repeat(6000))`);
    // Measure one whole sealed receipt, then bound retention below two of them.
    const probe = createPropertyExecutor();
    const probeInput = { plan: f.plan, repoRoot: f.root, packageDir: f.root };
    const measured = await probe.executePlan({ ...probeInput, adapter, approval: probe.approvePlan(probeInput) });
    if (process.platform !== 'darwin') { expect(measured.executed).toBe(false); return; }
    if (!measured.executed) throw new Error(measured.refusal.reason);
    const bound = Math.floor(probe.retention().retainedOutputBytes * 1.5);
    expect(probe.retention().retainedOutputBytes).toBe(Buffer.byteLength(JSON.stringify(measured.receipt))); // the WHOLE receipt counts
    const size = (receipt: unknown) => Buffer.byteLength(JSON.stringify(receipt));
    const executor = createPropertyExecutor({ maxRetainedOutputBytes: bound });
    const execute = async () => {
      const input = { plan: f.plan, repoRoot: f.root, packageDir: f.root };
      return executor.executePlan({ ...input, adapter, approval: executor.approvePlan(input) });
    };
    const first = await execute();
    if (!first.executed) throw new Error(first.refusal.reason);
    expect(executor.resolveReceiptRef(first.ref)).toBe(first.receipt);
    const second = await execute();
    if (!second.executed) throw new Error(second.refusal.reason);
    // The premise, measured rather than assumed: each fits, both do not.
    expect(size(first.receipt)).toBeLessThanOrEqual(bound);
    expect(size(second.receipt)).toBeLessThanOrEqual(bound);
    expect(size(first.receipt) + size(second.receipt)).toBeGreaterThan(bound);
    expect(executor.resolveReceiptRef(first.ref)).toBeNull(); // evicted: consumers fail closed
    expect(executor.resolveReceiptRef(second.ref)).toBe(second.receipt);
    expect(executor.retention()).toMatchObject({ receipts: 1, maxRetainedOutputBytes: bound, evicted: 1 });
  });
  async function assertUnsupportedRunner(layout: false | 'directory' | 'symlink'): Promise<void> {
    const f = scenarioRepo(PASS_RUNNER, { reportersModule: layout }); fixtures.push(f);
    const executor = createPropertyExecutor();
    const input = { plan: f.plan, repoRoot: f.root, packageDir: f.root };
    const pending = executor.executePlan({ ...input, adapter, approval: executor.approvePlan(input) });
    if (process.platform !== 'darwin') { expect((await pending).executed).toBe(false); return; }
    const error = await pending.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(PreExecutionRejectionError);
    expect((error as PreExecutionRejectionError).category).toBe('unsupported-runner');
    expect(String(error)).toMatch(/copied Vitest has no regular file node_modules\/vitest\/dist\/reporters\.js; the host-framed report cannot be produced/u);
  }
  it('refuses by name a copied Vitest without the reporters module the framed report needs (#378)', () => assertUnsupportedRunner(false));
  it('refuses a reporters module that is a directory (#378)', () => assertUnsupportedRunner('directory'));
  it('refuses a reporters module that is a symbolic link (#378)', () => assertUnsupportedRunner('symlink'));
  it('never copies a reporters module reached through a directory linked outside the repository (#378)', async () => {
    const f = scenarioRepo(PASS_RUNNER, { reportersModule: 'linked-dist' }); fixtures.push(f);
    const executor = createPropertyExecutor();
    const input = { plan: f.plan, repoRoot: f.root, packageDir: f.root };
    // The workspace reading the copy is made from refuses the link on every platform...
    expect(() => propertyWorkspaceIdentity(f.root)).toThrow(/^external\/absolute symlink refused: node_modules\/vitest\/dist$/u);
    const outcome = await Promise.resolve().then(() => executor.executePlan({ ...input, adapter, approval: executor.approvePlan(input) }))
      .then((result) => ({ result, caught: null }), (caught: unknown) => ({ result: null, caught }));
    if (resolveSandboxBackend().executable !== null) {
      // ...and a real run refuses before any copy exists.
      expect(outcome.result).toBeNull();
      expect(String(outcome.caught)).toMatch(/external\/absolute symlink refused: node_modules\/vitest\/dist/u);
    } else {
      // Without a sandbox backend, nothing runs at all.
      expect(outcome.result).toMatchObject({ executed: false, refusal: { kind: 'not-run' } });
    }
  });
  it('refuses a raw receipt without its framed report field, by name; null is no report (#378)', () => {
    const f = fixture(PASS_RUNNER);
    const raw = { stdout: '', stderr: '', report: null, exitCode: 1, signal: null, timedOut: false, durationMs: 1 };
    for (const report of [undefined, 5]) {
      expect(() => adapter.interpretExecution({ ...raw, report } as never, { ...f.plan, cwd: f.root }), String(report)).toThrow(TypeError);
    }
    expect(adapter.interpretExecution(raw, { ...f.plan, cwd: f.root }).kind).not.toBe('pass');
  });
  it('extracts exactly one nonce-framed runner report and nothing else (#378)', () => {
    const nonce = 'a'.repeat(64);
    const frame = (body: string) => `\n${nonce}:BEGIN\n${body}\n${nonce}:END\n`;
    expect(framedRunnerReport(`noise${frame('{"report":1}')}tail`, nonce)).toBe('{"report":1}');
    expect(framedRunnerReport('{"numTotalTests":1}', nonce)).toBeNull(); // unframed
    expect(framedRunnerReport(frame('{}') + frame('{}'), nonce)).toBeNull(); // duplicated
    expect(framedRunnerReport(`\n${nonce}:BEGIN\n{}`, nonce)).toBeNull(); // unterminated
    expect(framedRunnerReport(frame('{}').replaceAll(nonce, 'b'.repeat(64)), nonce)).toBeNull(); // guessed nonce
  });
  it('never credits a report the code under test prints without the host nonce (#378)', async () => {
    // The runner prints a perfectly valid PASS report straight to stdout (as
    // repository code under test could), never reading the fd-3 nonce.
    const forged = `console.log(JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,success:true,testResults:[{name:process.cwd()+'/test/contract.test.ts',status:'passed',message:'',assertionResults:[{status:'passed',fullName:'contract',failureMessages:[]}]}]}));`;
    const r = await run(forged); if (r === null) return;
    expect(r.receipt.outcome.kind).not.toBe('pass');
    expect(r.receipt.outcome.receipt.report).toBeNull();
    // The same report through the authenticated channel is credited.
    const framed = await run(PASS_RUNNER); if (framed === null) return;
    expect(framed.receipt.outcome.kind).toBe('pass');
    expect(framed.receipt.identity.adapterProfile).toContain('nonce-framed-report');
    expect(framed.receipt.identity.argv).not.toContain('--reporter=json'); // the framed host reporter fulfils it
  });
  it('aborts an owned process and proves close/group cessation before disposal releases its workspace', async () => {
    const f = fixture('setInterval(()=>{},1000);'); const controller = new AbortController(); const executor = createPropertyExecutor({ signal: controller.signal });
    const input = { plan: f.plan, adapter, repoRoot: f.root, packageDir: f.root }; const approval = executor.approvePlan(input);
    const operation = executor.executePlan({ ...input, approval }); const timer = setTimeout(() => controller.abort(), 30);
    try {
      const result = await operation;
      if (process.platform !== 'darwin') { expect(result.executed).toBe(false); return; }
      if (!result.executed) throw new Error(result.refusal.reason);
      expect(result.cleanup).toMatchObject({ proven: true, workspaceRetained: false }); expect(result.receipt.outcome.kind).toBe('infrastructure-error'); expect(existsSync(result.receipt.cwd)).toBe(false);
      expect(await executor.executePlan({ ...input, approval })).toMatchObject({ executed: false, refusal: { kind: 'not-run', reason: expect.stringContaining('aborted') } });
    } finally { clearTimeout(timer); }
  });
  it('refuses unsupported sandbox backends, including unshare', () => {
    expect(resolveSandboxBackend('/usr/bin/unshare')).toMatchObject({ backend: 'none-found', executable: null });
  });
  it('rejects installer commands before creating a workspace', () => {
    const f = fixture(); expect(() => validatePlanAgainstHostApproval({ plan: { ...f.plan, command: '/usr/bin/npm' }, repoRoot: f.root, packageDir: f.root, ceilings: ceilings() })).toThrow(/install-attempt/);
  });
  it('rejects caller flags, credential environment requests and invalid budgets', () => {
    const f = fixture();
    for (const plan of [{ ...f.plan, args: ['run', '--reporter=json', '--config=evil'] }, { ...f.plan, envAllowlist: ['AWS_TOKEN'] }, { ...f.plan, budget: { ...f.plan.budget, runTimeoutMs: NaN } }]) {
      expect(() => validatePlanAgainstHostApproval({ plan, repoRoot: f.root, packageDir: f.root, ceilings: ceilings() })).toThrow();
    }
  });
  it('requires an actual host capability; executable and cloned approvals do not authorize execution', async () => {
    const f = fixture(); const executor = createPropertyExecutor(); const input = { plan: f.plan, adapter, repoRoot: f.root, packageDir: f.root };
    const approval = executor.approvePlan(input);
    if (process.platform !== 'darwin') { expect((await executor.executePlan(input)).executed).toBe(false); return; }
    await expect(executor.executePlan(input)).rejects.toThrow(/host approval/);
    await expect(executor.executePlan({ ...input, approval: { ...approval } })).rejects.toThrow(/host approval/);
  });
  it('invalidates approval when runner bytes or tracked source changes', async () => {
    const f = fixture(); const executor = createPropertyExecutor();
    const input = { plan: f.plan, repoRoot: f.root, packageDir: f.root, adapter }; const approval = executor.approvePlan(input);
    writeFileSync(join(f.root, 'node_modules/vitest/vitest.mjs'), `${PASS_RUNNER}\n// altered runner`);
    if (process.platform === 'darwin') await expect(executor.executePlan({ ...input, approval })).rejects.toThrow(/stale host approval/);
    writeFileSync(join(f.root, 'test/placeholder'), 'changed');
    expect(() => executor.approvePlan(input)).toThrow(/clean/);
  });
  it('refuses transient unapproved copy bytes even when the source is restored before the final check', async () => {
    const f = fixture(); const executor = createPropertyExecutor(); const input = { plan: f.plan, adapter, repoRoot: f.root, packageDir: f.root };
    const approval = executor.approvePlan(input);
    if (process.platform !== 'darwin') { expect((await executor.executePlan({ ...input, approval })).executed).toBe(false); return; }
    const target = join(f.root, 'test/placeholder'); const original = readFileSync(target); const mkdtemp = fs.mkdtempSync; const copy = fs.cpSync;
    // Deterministic race: change only after admission, copy the transient
    // bytes, then restore before the final source fingerprint. No sleeps.
    const make = vi.spyOn(fs, 'mkdtempSync').mockImplementation((prefix, options) => {
      const destination = mkdtemp(prefix, options); writeFileSync(target, 'unapproved transient bytes\n'); return destination;
    });
    const cp = vi.spyOn(fs, 'cpSync').mockImplementation((...args) => { copy(...args); writeFileSync(target, original); });
    syncBuiltinESMExports();
    try {
      await expect(executor.executePlan({ ...input, approval })).rejects.toThrow(/approved snapshot/);
      expect(make).toHaveBeenCalledOnce(); expect(cp).not.toHaveBeenCalled();
    } finally { make.mockRestore(); cp.mockRestore(); syncBuiltinESMExports(); writeFileSync(target, original); }
  });
  it('issues only real host receipts and rejects forged, cloned, serialized and mutated evidence', async () => {
    const r = await run(PASS_RUNNER); if (r === null) return;
    expect(r.receipt.outcome.kind, JSON.stringify(r.receipt.outcome.receipt)).toBe('pass'); expect(r.cleanup.proven).toBe(true); expect(existsSync(r.receipt.cwd)).toBe(false);
    expect(isSealedExecutionReceipt(r.receipt)).toBe(true);
    expect(isSealedExecutionReceipt({ ...r.receipt })).toBe(false);
    expect(isSealedExecutionReceipt(JSON.parse(JSON.stringify(r.receipt)))).toBe(false);
    expect(isSealedExecutionReceipt({})).toBe(false);
    Object.assign(r.receipt.identity, { selectionFilter: 'narrowed' });
    expect(isSealedExecutionReceipt(r.receipt)).toBe(false); expect(r.executor.resolveReceiptRef(r.ref)).toBeNull();
  });
  it('scrubs synthetic credentials and gives the process isolated HOME/TMPDIR', async () => {
    const r = await run(`console.log(JSON.stringify({secret:process.env.AWS_TOKEN,home:process.env.HOME,tmp:process.env.TMPDIR}))`, { env: { AWS_TOKEN: 'synthetic-secret' } }); if (r === null) return;
    const raw = r.receipt.outcome.receipt.stdout; expect(raw).not.toContain('synthetic-secret');
    expect(JSON.parse(raw).home).toContain('.property-home'); expect(JSON.parse(raw).tmp).toContain('.property-tmp');
  });
  it('denies arbitrary host file reads without needing a credential denylist', async () => {
    const f = fixture(); const canary = join(f.root, 'host-canary'); writeFileSync(canary, 'synthetic-secret');
    // Untracked files are not copied and host paths are not readable.
    const r = await run(`import fs from 'node:fs';try{fs.readFileSync(${JSON.stringify(canary)});console.log('LEAK')}catch(e){console.log(e.code)}`); if (r === null) return;
    expect(r.receipt.outcome.receipt.stdout).toMatch(/EPERM|EACCES/); expect(r.receipt.outcome.receipt.stdout).not.toContain('LEAK');
  });
  it('denies writes outside the workspace', async () => {
    const f = fixture(); const outside = join(f.root, 'outside-write');
    const r = await run(`import fs from 'node:fs';try{fs.writeFileSync(${JSON.stringify(outside)},'bad');console.log('ESCAPE')}catch(e){console.log(e.code)}`); if (r === null) return;
    expect(existsSync(outside)).toBe(false); expect(r.receipt.outcome.receipt.stdout).toMatch(/EPERM|EACCES/);
  });
  it('denies loopback network access (owned listener observes no connection)', async () => {
    let connections = 0; const server = createServer((s) => { connections += 1; s.destroy(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const r = await run(`import net from 'node:net';const s=net.connect(${port},'127.0.0.1');s.on('error',e=>console.log(e.code));s.on('connect',()=>{console.log('LEAK');s.destroy()});`);
      if (r !== null) expect(r.receipt.outcome.receipt.stdout).toMatch(/EPERM|EACCES/);
      expect(connections).toBe(0);
    } finally { await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())); }
  });
  it('denies detached descendants rather than trusting attacker-supplied PID disclosures', async () => {
    const r = await run(`import {spawn} from 'node:child_process';try{const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});p.on('error',e=>console.log(e.code));}catch(e){console.log(e.code)}`); if (r === null) return;
    expect(r.receipt.outcome.receipt.stdout).toMatch(/EPERM|EACCES/); expect(r.cleanup.proven).toBe(true);
  });
  it('bounds output capture and never turns truncated output into PASS', async () => {
    const r = await run(`process.stdout.write('x'.repeat(100000))`, { output: 100 }); if (r === null) return;
    expect(r.receipt.capture).toMatchObject({ stdoutTruncated: true, complete: false }); expect(r.receipt.outputs[0]!.bytes).toBeLessThanOrEqual(100); expect(r.receipt.outcome.kind).not.toBe('pass');
    // Why there is no authenticated report is named, never silent (#378).
    expect(r.receipt.outcome.reasons).toContain('no host-framed report: stdout reached the output cap before the frame closed');
  });
  it('kills an expired run and proves actual process cessation before cleanup', async () => {
    const r = await run(`setInterval(()=>{},1000)`, { timeout: 300 }); if (r === null) return;
    expect(r.receipt.outcome.kind).toBe('timeout'); expect(r.cleanup.proven).toBe(true); expect(r.receipt.outcome.receipt.signal).toBe('SIGKILL');
  });
  it('refuses planted overlay symlinks before even mkdir can escape', () => {
    const f = fixture(); const outside = fixture(); symlinkSync(outside.root, join(f.root, 'link'));
    expect(() => applyOverlayFiles({ workspaceRoot: f.root, files: [{ path: 'link/new/evil.ts', content: 'bad' }] })).toThrow(/parent/);
    expect(existsSync(join(outside.root, 'new'))).toBe(false);
  });
  it('binds exact overlay bytes and refuses duplicate paths', () => {
    const f = fixture(); const overlay = applyOverlayFiles({ workspaceRoot: f.root, files: [{ path: 'test/a.ts', content: 'a' }] });
    expect(overlay.files[0]!.bytes).toBe(1); expect(readFileSync(join(f.root, 'test/a.ts'), 'utf8')).toBe('a');
    expect(() => applyOverlayFiles({ workspaceRoot: f.root, files: [{ path: 'a', content: '1' }, { path: 'a', content: '2' }] })).toThrow(/duplicate/);
    mkdirSync(join(f.root, 'normal')); writeFileSync(join(f.root, 'normal/a'), 'a');
  });
  it('writes a live overlay all-or-nothing: a mid-way refusal leaves no partial set and restores overwritten files (#380)', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'test/existing.test.mjs'), 'original bytes\n');
    fs.chmodSync(join(f.root, 'test/existing.test.mjs'), 0o640);
    mkdirSync(join(f.root, 'test/occupied.replay.json'));
    const files = [
      { path: 'test/existing.test.mjs', content: 'overlay bytes\n' },
      { path: 'test/new.regression.test.mjs', content: 'wrapper\n' },
      { path: 'test/fresh/deeper/wrapper.test.mjs', content: 'nested\n' }, // creates two parents
      { path: 'test/occupied.replay.json', content: '{}\n' }, // a directory: refused mid-way
    ];
    expect(() => applyOverlayFilesAllOrNothing({ workspaceRoot: f.root, files })).toThrow(/non-file entry/);
    expect(readFileSync(join(f.root, 'test/existing.test.mjs'), 'utf8')).toBe('original bytes\n');
    expect(fs.statSync(join(f.root, 'test/existing.test.mjs')).mode & 0o777).toBe(0o640);
    expect(existsSync(join(f.root, 'test/new.regression.test.mjs'))).toBe(false);
    // The parent directories it created are gone too: no empty debris.
    expect(existsSync(join(f.root, 'test/fresh'))).toBe(false);
    expect(fs.statSync(join(f.root, 'test/occupied.replay.json')).isDirectory()).toBe(true);
    // Without the refusal the same set lands whole.
    applyOverlayFilesAllOrNothing({ workspaceRoot: f.root, files: files.slice(0, 2) });
    expect(readFileSync(join(f.root, 'test/existing.test.mjs'), 'utf8')).toBe('overlay bytes\n');
    expect(readFileSync(join(f.root, 'test/new.regression.test.mjs'), 'utf8')).toBe('wrapper\n');
  });
  it('rolls back only the directories it made: a later refused path leaves no debris and no false rollback failure (#380)', () => {
    const f = fixture();
    const files = [
      { path: 'test/made/here/a.test.mjs', content: 'a\n' },
      // Refused by path: its missing parent `test/never` is never created.
      { path: 'test/never/../../../escape.test.mjs', content: 'x\n' },
    ];
    const error = (() => { try { applyOverlayFilesAllOrNothing({ workspaceRoot: f.root, files }); return null; } catch (caught) { return caught; } })();
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/overlay path must be a safe relative path/u);
    expect(existsSync(join(f.root, 'test/made'))).toBe(false);
    expect(existsSync(join(f.root, 'test/never'))).toBe(false);
  });
  // Permission bits do not bind root, so these two need an ordinary user.
  const asUser = process.getuid?.() !== 0;
  it.runIf(asUser)('restores a read-only original exactly, bytes and mode (#380)', () => {
    const f = fixture();
    const target = join(f.root, 'test/readonly.test.mjs');
    writeFileSync(target, 'original\n'); fs.chmodSync(target, 0o444);
    const files = [{ path: 'test/readonly.test.mjs', content: 'overlay\n' }, { path: 'test/../../escape.test.mjs', content: 'x\n' }];
    let error: unknown = null;
    try { applyOverlayFilesAllOrNothing({ workspaceRoot: f.root, files }); } catch (caught) { error = caught; }
    // The restore itself succeeds: the original error, never a rollback failure.
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/overlay path must be a safe relative path/u);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
    expect(fs.statSync(target).mode & 0o777).toBe(0o444);
  });
  it.runIf(asUser)('a rollback leaves a file the failed apply never touched exactly as it was, even in a locked directory (#380)', () => {
    const f = fixture();
    const locked = join(f.root, 'test/locked');
    mkdirSync(locked); writeFileSync(join(locked, 'kept.test.mjs'), 'original\n');
    const before = fs.statSync(join(locked, 'kept.test.mjs'));
    const files = [{ path: 'test/locked/kept.test.mjs', content: 'overlay\n' }, { path: 'test/../../escape.test.mjs', content: 'x\n' }];
    // The refusal lands before any write: the untouched file needs no restore,
    // so the locked directory cannot fail the rollback.
    fs.chmodSync(locked, 0o555);
    let error: unknown = null;
    try { applyOverlayFilesAllOrNothing({ workspaceRoot: f.root, files }); } catch (caught) { error = caught; } finally { fs.chmodSync(locked, 0o755); }
    expect(error).not.toBeInstanceOf(AggregateError);
    expect(String(error)).toMatch(/overlay path must be a safe relative path/u);
    const after = fs.statSync(join(locked, 'kept.test.mjs'));
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
  });
  it('binds host approval to exact overlay bytes and replay controls', async () => {
    const f = fixture(); const executor = createPropertyExecutor();
    const input = { plan: f.plan, repoRoot: f.root, packageDir: f.root, adapter, overlayFiles: [{ path: 'test/approved.mjs', content: 'approved' }] };
    const approval = executor.approvePlan(input);
    if (process.platform !== 'darwin') { expect((await executor.executePlan({ ...input, approval })).executed).toBe(false); return; }
    await expect(executor.executePlan({ ...input, approval, overlayFiles: [{ path: 'test/approved.mjs', content: 'changed' }] })).rejects.toThrow(/stale host approval/);
    await expect(executor.executePlan({ ...input, approval, replaySeed: '999' })).rejects.toThrow(/stale host approval/);
  });
  it('invalidates approval on installed dependency bytes even when version metadata is unchanged', async () => {
    const f = fixture(); const executor = createPropertyExecutor(); const file = join(f.root, 'node_modules/vitest/internal.mjs');
    writeFileSync(file, 'export const x=1;'); const input = { plan: f.plan, repoRoot: f.root, packageDir: f.root, adapter }; const approval = executor.approvePlan(input);
    writeFileSync(file, 'export const x=2;');
    if (process.platform !== 'darwin') { expect((await executor.executePlan({ ...input, approval })).executed).toBe(false); return; }
    await expect(executor.executePlan({ ...input, approval })).rejects.toThrow(/stale host approval/);
  });
  it('denies disk writes even inside the copied workspace', async () => {
    const r = await run(`import fs from 'node:fs';try{fs.writeFileSync('disk-flood',Buffer.alloc(1024));console.log('WRITE')}catch(e){console.log(e.code)}`); if (r === null) return;
    expect(r.receipt.outcome.receipt.stdout).toMatch(/EPERM|EACCES/); expect(r.receipt.outcome.receipt.stdout).not.toContain('WRITE'); expect(r.cleanup.proven).toBe(true);
  });
  it('enforces one active run and spends a host capability only once', async () => {
    const f = fixture(`setInterval(()=>{},1000)`); const executor = createPropertyExecutor();
    const input = { plan: { ...f.plan, budget: { ...f.plan.budget, runTimeoutMs: 300 } }, repoRoot: f.root, packageDir: f.root, adapter }; const approval = executor.approvePlan(input);
    const first = executor.executePlan({ ...input, approval });
    const second = await executor.executePlan({ ...input, approval }); const result = await first;
    if (process.platform !== 'darwin') { expect(result.executed).toBe(false); return; }
    expect(second).toMatchObject({ executed: false, refusal: { reason: expect.stringContaining('concurrency ceiling') } });
    expect(result).toMatchObject({ executed: true, cleanup: { proven: true } });
    await expect(executor.executePlan({ ...input, approval })).rejects.toThrow(/host approval/);
  });
  it('refuses dependency symlink/hardlink escapes and invalid copy ceilings before execution', () => {
    const f = fixture(); const outside = fixture(); const secret = join(outside.root, 'canary'); writeFileSync(secret, 'synthetic-secret');
    symlinkSync(secret, join(f.root, 'node_modules/escape'));
    const input = { plan: f.plan, repoRoot: f.root, packageDir: f.root };
    expect(() => createPropertyExecutor().approvePlan(input)).toThrow(/symlink refused/);
    const hard = fixture(); linkSync(secret, join(hard.root, 'node_modules/hardlink'));
    expect(() => createPropertyExecutor().approvePlan({ ...input, repoRoot: hard.root, packageDir: hard.root, plan: hard.plan })).toThrow(/hardlinked/);
    expect(() => createPropertyExecutor({ workspaceCopyBounds: { maxFiles: NaN, maxBytes: 1000 } })).toThrow(/invalid/);
  });
  it('keeps a caught-denial fake PASS as an unqualified parser report, never product proof', async () => {
    const host = fixture(); const canary = join(host.root, 'protected-canary'); writeFileSync(canary, 'synthetic-secret');
    const r = await run(`import fs from 'node:fs';try{console.error(fs.readFileSync(${JSON.stringify(canary)},'utf8'))}catch(e){console.error(e.code)};${PASS_RUNNER}`); if (r === null) return;
    // Owner decision: retain the raw classification, not a fatal startup
    // policy or a product verdict. The separate host campaign rejects this
    // runner when it also reports PASS against the known-bad control.
    expect(r.receipt.outcome).toMatchObject({ kind: 'pass', evidenceClass: 'runner-report-classification' });
    expect(r.receipt.outcome.receipt.stderr).toMatch(/EPERM|EACCES/);
    expect(r.receipt.outcome.receipt.stderr).not.toContain('synthetic-secret');
    expect(r.receipt).not.toHaveProperty('qualification'); expect(r.cleanup.proven).toBe(true);
  });
  it('kills live worker threads as well as the parent before claiming cessation', async () => {
    const r = await run(`import {Worker} from 'node:worker_threads';new Worker('console.log("THREAD_READY");setInterval(()=>{},1000)',{eval:true});setInterval(()=>{},1000)`, { timeout: 1000 }); if (r === null) return;
    expect(r.receipt.outcome.receipt.stdout).toContain('THREAD_READY'); expect(r.receipt.outcome.kind).toBe('timeout'); expect(r.cleanup.proven).toBe(true);
  });
});
