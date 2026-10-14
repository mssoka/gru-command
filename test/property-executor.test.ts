import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPropertyExecutor, isSealedExecutionReceipt, resolveSandboxBackend, validatePlanAgainstHostApproval } from '../src/property/executor.js';
import { VITEST_FAST_CHECK_ADAPTER as adapter } from '../src/property/adapters/vitest-fast-check.js';
import { applyOverlayFiles } from '../src/property/overlay.js';
import { PASS_RUNNER, scenarioRepo } from './fixtures/property/executor/helpers.js';
const fixtures: ReturnType<typeof scenarioRepo>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function fixture(script = PASS_RUNNER) { const f = scenarioRepo(script); fixtures.push(f); return f; }
function ceilings() { return { maxRunTimeoutMs: 900_000, maxMaxOutputBytes: 64 * 1024 * 1024 }; }
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
  it('invalidates approval when runner bytes or tracked source changes', () => {
    const f = fixture(); const executor = createPropertyExecutor();
    executor.approvePlan({ plan: f.plan, repoRoot: f.root, packageDir: f.root });
    writeFileSync(join(f.root, 'test/placeholder'), 'changed');
    expect(() => executor.approvePlan({ plan: f.plan, repoRoot: f.root, packageDir: f.root })).toThrow(/clean/);
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
});
