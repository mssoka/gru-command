import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configPathFor } from '../src/config.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

interface LogLine {
  level: string;
  msg: string;
  [key: string]: unknown;
}

function readLogLines(home: string): LogLine[] {
  const logFile = join(home, 'logs', 'service.log');
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogLine);
}

function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const value = probe();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${what}`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function spawnService(home: string) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, GRU_COMMAND_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });
  return { child, getStderr: () => stderr };
}

async function waitForHealthyPort(home: string, stderr: () => string): Promise<number> {
  return waitFor(
    () => {
      const listening = readLogLines(home).find((line) => line.msg === 'listening');
      if (listening === undefined) return undefined;
      return listening['port'] as number;
    },
    15_000,
    `service listening (stderr: ${stderr()})`,
  );
}

describe('graceful shutdown', () => {
  it('a corrupt chat frame log refuses boot — named, before listening', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-corruptlog-'));
    cleanupDirs.push(home);
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n',
      'utf-8',
    );
    // Mid-file corruption in the durable frame log (garbage BETWEEN two
    // valid lines): boot must fail loud naming the file, and must never
    // report listening (r2 W6': the load runs before the server accepts
    // anything).
    mkdirSync(join(home, 'chat'), { recursive: true });
    writeFileSync(
      join(home, 'chat', 'gru.frames.jsonl'),
      '{"type":"turn","state":"start","seq":1}\nGARBAGE\n{"type":"turn","state":"end","seq":3}\n',
      'utf-8',
    );

    const { child, getStderr } = spawnService(home);
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on('exit', (code) => resolveExit(code));
    });
    expect(exitCode).not.toBe(0);
    expect(getStderr()).toContain('chat frame log');
    expect(getStderr()).toContain('gru.frames.jsonl');
    // Refused BEFORE listening: no listening line was ever logged.
    const msgs = readLogLines(home).map((line) => line.msg);
    expect(msgs).not.toContain('listening');
  });

  it('SIGTERM: stop accepting, exit 0, structured shutdown lines in the data dir log', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-sigterm-'));
    cleanupDirs.push(home);
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n',
      'utf-8',
    );

    const { child, getStderr } = spawnService(home);
    try {
      const port = await waitForHealthyPort(home, getStderr);
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);

      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
        child.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);

      const lines = readLogLines(home);
      const msgs = lines.map((line) => line.msg);
      expect(msgs).toContain('boot');
      expect(msgs).toContain('listening');
      expect(msgs).toContain('shutdown begin');
      expect(msgs).toContain('shutdown complete');
      const boot = lines.find((line) => line.msg === 'boot');
      expect(boot?.['version']).toBeTypeOf('string');
      expect(boot?.['install_id']).toBeTypeOf('string');
      // Per-request structured logging is exercised and asserted, not just wired:
      const requestLine = lines.find((line) => line.msg === 'request');
      expect(requestLine?.['status']).toBe(200);
      expect(requestLine?.['level']).toBe('info');
      expect(requestLine?.['request_id']).toBeTypeOf('string');

      const afterStop = await fetch(`http://127.0.0.1:${port}/health`).then(
        () => 'reachable',
        () => 'unreachable',
      );
      expect(afterStop).toBe('unreachable');

      // W8 (ruling-12 effect): the graceful shutdown persisted the session
      // size snapshot — the next boot's growth detection has a baseline.
      const snapshotFile = join(home, 'sessions', 'store-state.json');
      expect(existsSync(snapshotFile)).toBe(true);
      const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf-8')) as Record<string, number>;
      const files = Object.keys(snapshot);
      // Bob's due-based boot beat (issue #451) spawns the bob slot on a
      // fresh install, so the snapshot legitimately holds that session
      // too; the gru-main session is still exactly the one below.
      const gruRoot = join(home, 'sessions', 'gru') + '/';
      const bobRoot = join(home, 'sessions', 'bob') + '/';
      const gruFiles = files.filter((path) => path.startsWith(gruRoot));
      expect(gruFiles).toHaveLength(1);
      for (const path of files) {
        expect(path.startsWith(gruRoot) || path.startsWith(bobRoot), path).toBe(true);
        expect(Number.isSafeInteger(snapshot[path]), path).toBe(true);
        expect(snapshot[path], path).toBe(readFileSync(path).length);
      }
      const file = gruFiles[0]!;
      const bytes = readFileSync(file);
      expect(snapshot[file]).toBeGreaterThan(0);
      const entries = bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; id?: string });
      expect(entries[0]).toMatchObject({ type: 'session', id: expect.any(String) });
      // Durable native initialization/selection is not a user turn,
      // request admission, assistant completion or fabricated empty store.
      expect(entries.every((entry) => ['session', 'model_change', 'thinking_level_change'].includes(entry.type))).toBe(true);
      const db = new LedgerDb(home);
      try { expect(db.handle.prepare('SELECT COUNT(*) AS n FROM pending_directives').get()?.n).toBe(0); }
      finally { db.close(); }
      // And the boot line reported the session store wiring:
      const storeLine = lines.find((line) => line.msg === 'session store ready');
      expect(storeLine).toBeDefined();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('SIGINT: same graceful path, exit 0', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-sigint-'));
    cleanupDirs.push(home);
    writeFileSync(
      configPathFor(home),
      '[server]\nhost = "127.0.0.1"\nport = 0\n',
      'utf-8',
    );

    const { child, getStderr } = spawnService(home);
    try {
      await waitForHealthyPort(home, getStderr);
      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
        child.kill('SIGINT');
      });
      expect(exitCode).toBe(0);
      const msgs = readLogLines(home).map((line) => line.msg);
      expect(msgs).toContain('shutdown complete');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('invalid config: service refuses to start, exits non-zero with a clear error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-badcfg-'));
    cleanupDirs.push(home);
    writeFileSync(configPathFor(home), 'workspace_root = 42\n', 'utf-8');

    const { child } = spawnService(home);
    const [exitCode, stderr] = await new Promise<[number | null, string]>((resolveExit) => {
      let err = '';
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf-8');
      });
      child.on('exit', (code) => resolveExit([code, err]));
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('configuration invalid');
    expect(stderr).toContain('workspace_root');
    expect(stderr).toContain(configPathFor(home));
  });

  it('boot reconciliation summary pins the actual counter mapping (examined markers, retired jobs)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-rebrief-summary-'));
    cleanupDirs.push(home);
    writeFileSync(configPathFor(home), '[server]\nhost = "127.0.0.1"\nport = 0\n', 'utf-8');
    // Seed the production incident shape (2026-09-30 08:03Z boot): TWO
    // merged jobs, each with an admitted re-brief pair that can never be
    // honored. Admission MUST happen while each job is still nonterminal —
    // the real terminal intake guard refuses markers on merged/done lanes —
    // and the job merges afterwards, exactly how the stale production
    // markers were created. Same data dir the service opens; temp ledger,
    // ephemeral port, no real instance/credentials.
    const seed = new LedgerDb(home);
    const seeded = new LedgerApi(seed.handle);
    for (const jobId of ['merged-pr-one', 'merged-pr-two']) {
      seeded.addJob({ id: jobId, repo: 'fixture', title: 't', briefing: 'b' });
      seeded.setJobStatus(jobId, 'working');
      seeded.beginPendingRebrief({ jobId, note: 'n', briefing: 'b' });
      seeded.setJobStatus(jobId, 'in-review');
      seeded.setJobStatus(jobId, 'merged');
    }
    seed.close();

    const { child, getStderr } = spawnService(home);
    try {
      await waitForHealthyPort(home, getStderr);
      // The summary mixes units BY DESIGN (main.ts emits the existing
      // mapping): `examined` counts MARKERS while completed/redispatched/
      // retired count JOBS — two retired pairs read examined: 4, retired: 2,
      // not a partial failure.
      const summary = await waitFor(
        () => readLogLines(home).find((line) => line.msg === 're-brief reconciliation'),
        15_000,
        're-brief reconciliation summary',
      );
      expect(summary?.['examined']).toBe(4);
      expect(summary?.['completed']).toBe(0);
      expect(summary?.['redispatched']).toBe(0);
      expect(summary?.['retired']).toBe(2);

      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
        child.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);
      // The boot pass itself did the retirement: markers gone, one audit
      // per job carrying that job's terminal status.
      const verifyDb = new LedgerDb(home);
      const verify = new LedgerApi(verifyDb.handle);
      for (const jobId of ['merged-pr-one', 'merged-pr-two']) {
        expect(verify.listPendingRebriefs({ jobId })).toHaveLength(0);
        const audit = verify.latestJobEvent(jobId, 'silas.rebrief-retired');
        expect((audit?.payload as { job_status?: string }).job_status).toBe('merged');
      }
      verifyDb.close();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

it('P33 production directive resource shutdown joins progress before failing registry and cannot skip either stage', async () => {
  const { disposeDirectiveResources } = await import('../src/dispatch/directive-progress.js');
  const order: string[] = []; let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const run = disposeDirectiveResources({ dispose: async () => { order.push('progress-stop'); await pending; order.push('progress-joined'); } },
    { dispose: async () => { order.push('registry'); throw new Error('registry teardown fault'); } }).then(() => null, (error: unknown) => error);
  await Promise.resolve(); expect(order).toEqual(['progress-stop']); release();
  expect(await run).toBeInstanceOf(AggregateError); expect(order).toEqual(['progress-stop', 'progress-joined', 'registry']);
  order.length = 0;
  const both = await disposeDirectiveResources({ dispose: async () => { order.push('progress'); throw new Error('progress failure'); } },
    { dispose: async () => { order.push('registry'); throw new Error('registry failure'); } }).then(() => null, (error: unknown) => error);
  expect(order).toEqual(['progress', 'registry']); expect((both as AggregateError).errors).toHaveLength(2);
});

it('R12 actual main boot survives a persistent historical group failure and retains its action while healthy work settles', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gru-main-historical-fault-')); cleanupDirs.push(home);
  const workspace = mkdtempSync(join(tmpdir(), 'gru-main-historical-workspace-')); cleanupDirs.push(workspace);
  writeFileSync(configPathFor(home), `workspace_root = ${JSON.stringify(workspace)}\n[server]\nhost = "127.0.0.1"\nport = 0\n`);
  const failedJob = 'boot-failed-historical'; const healthyJob = 'boot-healthy-historical';
  const seedDb = new LedgerDb(home); const seed = new LedgerApi(seedDb.handle);
  for (const jobId of [failedJob, healthyJob]) {
    seed.addJob({ id: jobId, repo: 'fixture', title: 'original historical intent', briefing: 'original approved scope' });
    seed.setJobStatus(jobId, 'working');
    const markers = seed.beginPendingRebrief({ jobId, note: 'original correction', briefing: 'original approved scope' });
    seed.bindPendingRebriefWorker({ ids: markers.map((row) => row.id), agentId: 'original-historical-minion', sessionFile: null });
    for (const marker of seed.listPendingRebriefs({ jobId })) seed.appendCustomEvent({ kind: marker.kind, jobId,
      agentId: 'original-historical-minion', payload: { marker_id: marker.id, payload_hash: marker.payloadHash,
        work_revision: marker.workRevision, ...(marker.kind === 'silas.rebrief' ? { minion_id: 'original-historical-minion' } : { agentId: 'original-historical-minion', source: 'silas-rebrief', sha: 'original-legacy-head' }) } });
  }
  const original = seed.listPendingRebriefs({ jobId: failedJob });
  const originalEvents = seed.listJobEventsByKinds(failedJob, ['silas.rebrief', 'job.delivered']); seedDb.close();
  const root = join(import.meta.dirname, '..'); const hook = join(home, 'historical-fault-hook.mjs');
  writeFileSync(hook, `import { LedgerApi } from ${JSON.stringify(`file://${join(root, 'dist/ledger/api.js')}`)};
const clear = LedgerApi.prototype.clearPendingRebriefsIfCurrentAndSettle;
LedgerApi.prototype.clearPendingRebriefsIfCurrentAndSettle = function(markers) {
  if (markers[0]?.jobId === ${JSON.stringify(failedJob)}) throw new Error('persistent original scoped historical storage refusal');
  return clear.call(this, markers);
};
`);
  const child = spawn(process.execPath, ['--import', hook, 'dist/main.js'], { cwd: root,
    env: { ...process.env, GRU_COMMAND_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString('utf8'); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  try {
    const outcome = await Promise.race([
      waitForHealthyPort(home, () => stderr).then((port) => ({ kind: 'listening' as const, port })),
      exited.then((code) => ({ kind: 'exit' as const, code })),
    ]);
    expect(outcome.kind, stderr).toBe('listening');
    if (outcome.kind !== 'listening') throw new Error('asserted service boot must reach its listener');
    expect((await fetch(`http://127.0.0.1:${outcome.port}/health`)).status).toBe(200);
    const summary = readLogLines(home).find((line) => line.msg === 're-brief reconciliation');
    expect(summary).toMatchObject({ completed: 1, redispatched: 0, failed: 1 });
    child.kill('SIGTERM'); expect(await exited).toBe(0);
    const db = new LedgerDb(home); const ledger = new LedgerApi(db.handle);
    try {
      expect(ledger.listPendingRebriefs({ jobId: failedJob })).toEqual(original);
      expect(ledger.listPendingRebriefs({ jobId: healthyJob })).toEqual([]);
      expect(ledger.listJobEventsByKinds(failedJob, ['silas.rebrief', 'job.delivered'])).toEqual(originalEvents);
      expect(ledger.listObligations({ jobId: failedJob }).some((row) => row.state === 'open' && row.nextAction.kind === 'gru-decision')).toBe(true);
      expect(ledger.findNotificationByKind(`silas.rebrief-unreconciled.${failedJob}`, 'active')).toMatchObject({ routing: 'action-required' });
      expect(ledger.latestJobEvent(failedJob, 'silas.rebrief-settled')).toBeNull();
    } finally { db.close(); }
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
});

it('P33 actual main shutdown joins progress even when shared registry disposal rejects', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gru-main-progress-fault-')); cleanupDirs.push(home);
  writeFileSync(configPathFor(home), '[server]\nhost = "127.0.0.1"\nport = 0\n');
  const trace = join(home, 'shutdown-order.jsonl'); const hook = join(home, 'fault-hook.mjs');
  const root = join(import.meta.dirname, '..');
  writeFileSync(hook, `import { appendFileSync } from 'node:fs';
import { DirectiveProgressService } from ${JSON.stringify(`file://${join(root, 'dist/dispatch/directive-progress.js')}`)};
import { RuntimeRegistry } from ${JSON.stringify(`file://${join(root, 'dist/runtime/registry.js')}`)};
const trace = ${JSON.stringify(trace)}; const original = DirectiveProgressService.prototype.dispose;
DirectiveProgressService.prototype.dispose = async function() { appendFileSync(trace, 'progress-stop\\n'); await original.call(this); appendFileSync(trace, 'progress-joined\\n'); };
RuntimeRegistry.prototype.dispose = async function() { appendFileSync(trace, 'registry\\n'); throw new Error('controlled shared registry shutdown refusal'); };
`);
  const child = spawn(process.execPath, ['--import', hook, process.env.GH286_RECEIVED_MAIN ?? 'dist/main.js'], {
    cwd: root, env: { ...process.env, GRU_COMMAND_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString('utf8'); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  try {
    await waitForHealthyPort(home, () => stderr); child.kill('SIGTERM'); expect(await exited).toBe(0);
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual(['progress-stop', 'progress-joined', 'registry']);
    expect(readLogLines(home).some((line) => String(line.msg).includes('dispose failed'))).toBe(true);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
});
