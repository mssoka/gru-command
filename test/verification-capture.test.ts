import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPTURE_OWNER_VERSION,
  CAPTURE_RECEIPT_VERSION,
  CaptureSinkExistsError,
  captureOwnerPath,
  captureReceiptPath,
  captureReceiptSucceeded,
  identityMismatch,
  openExclusiveCaptureSink,
  parseCapturedNdjson,
  readCaptureOwner,
  withdrawCaptureOwner,
  writeCaptureOwner,
  type CaptureOwnerRecord,
  type CaptureReceipt,
  type ProcessProbe,
} from '../src/verify/capture.js';
import {
  CAPTURE_EXIT,
  parsePsOutput,
  runCaptureCli,
  type CaptureCliDeps,
} from '../src/verify/capture-cli.js';

/**
 * Verification capture (issue #159): exclusive sinks, honest receipts,
 * identity-validated owner withdrawal. The observed incident was multiple
 * watchers sharing one truncating NDJSON sink; these tests pin the
 * supported replacement's refusal semantics.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-capture-'));
  dirs.push(dir);
  return dir;
}

const liveProbe: ProcessProbe = {
  alive: true,
  startTime: 'Mon Oct  6 12:00:00 2026',
  cwd: '/tmp/lane',
  command: 'node dist/verify/capture-cli.js run --sink /tmp/lane/sink.ndjson',
};

function ownerRecord(sink: string, overrides: Partial<CaptureOwnerRecord> = {}): CaptureOwnerRecord {
  return {
    version: CAPTURE_OWNER_VERSION,
    pid: 4242,
    start_time: liveProbe.startTime,
    cwd: liveProbe.cwd ?? '/tmp/lane',
    command: liveProbe.command ?? 'node capture-cli',
    request_id: 'req-owner-1',
    sink,
    run_id: null,
    created_at: '2026-10-06T12:00:00.000Z',
    ...overrides,
  };
}

const COMPLETED_OUTCOME = {
  runId: 'run-capture-1',
  jobId: 'job-capture',
  scope: 'full',
  command: 'npm test',
  cwd: '/tmp/lane',
  ok: true,
  exitCode: 0,
  signal: null,
  timedOut: false,
  queuedMs: 3,
  durationMs: 42,
  sha: 'a'.repeat(40),
  trackedDirty: false,
  workers: 2,
  outputBytes: 128,
  outputSha256: 'b'.repeat(64),
  outputTail: 'ok',
  error: null,
};

function completedNdjson(outcome: Record<string, unknown> = COMPLETED_OUTCOME): string {
  return (
    `${JSON.stringify({ type: 'queued', runId: outcome['runId'], position: 0, active: 0, limit: 1 })}\n` +
    `${JSON.stringify({ type: 'started', runId: outcome['runId'], workers: 2, sha: outcome['sha'], queuedMs: 3 })}\n` +
    `${JSON.stringify({ type: 'output', runId: outcome['runId'], stream: 'stdout', text: 'ok\\n' })}\n` +
    `${JSON.stringify({ type: 'completed', runId: outcome['runId'], outcome })}\n`
  );
}

describe('exclusive capture sink', () => {
  it('creates exclusively before submission and never truncates an existing file', () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'verify.ndjson');
    const sink = openExclusiveCaptureSink(sinkPath);
    sink.write('{"type":"started"}\n');
    expect(sink.bytes).toBe(19);
    // A second capture for the same path is a typed refusal, not a share.
    expect(() => openExclusiveCaptureSink(sinkPath)).toThrow(CaptureSinkExistsError);
    expect(readFileSync(sinkPath, 'utf-8')).toBe('{"type":"started"}\n');
    const digest = sink.close();
    expect(digest.bytes).toBe(19);
    expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('capture receipts', () => {
  function receipt(overrides: Partial<CaptureReceipt> = {}): CaptureReceipt {
    return {
      version: CAPTURE_RECEIPT_VERSION,
      request_id: 'req-receipt',
      sink: '/tmp/a.ndjson',
      outcome: 'completed',
      reconciled: false,
      frames: 4,
      pings: 0,
      capture_bytes: 512,
      capture_sha256: 'c'.repeat(64),
      run_id: 'run-1',
      head: 'a'.repeat(40),
      expected_head: null,
      tracked_dirty: false,
      ok: true,
      exit_code: 0,
      signal: null,
      timed_out: false,
      output_bytes: 128,
      output_sha256: 'b'.repeat(64),
      started: true,
      error: null,
      completed_at: '2026-10-06T12:00:00.000Z',
      ...overrides,
    };
  }

  it('promotes ONLY a completed, clean, exact-head receipt with bound output', () => {
    expect(captureReceiptSucceeded(receipt())).toBe(true);
    expect(captureReceiptSucceeded(receipt({ outcome: 'unknown' }))).toBe(false);
    expect(captureReceiptSucceeded(receipt({ outcome: 'admission-failed' }))).toBe(false);
    expect(captureReceiptSucceeded(receipt({ ok: false, exit_code: 7 }))).toBe(false);
    expect(captureReceiptSucceeded(receipt({ tracked_dirty: true }))).toBe(false);
    expect(captureReceiptSucceeded(receipt({ run_id: null }))).toBe(false);
    expect(captureReceiptSucceeded(receipt({ output_sha256: null }))).toBe(false);
    expect(captureReceiptSucceeded(receipt({ error: 'partial stream' }))).toBe(false);
    expect(captureReceiptSucceeded(receipt({ expected_head: 'd'.repeat(40) }))).toBe(false);
    expect(captureReceiptSucceeded(receipt({ expected_head: 'a'.repeat(40) }))).toBe(true);
    // A replay of a recorded outcome is NOT a promotable full capture, and
    // a completed run without a zero exit is not success either.
    expect(captureReceiptSucceeded(receipt({ reconciled: true }))).toBe(false);
    expect(captureReceiptSucceeded(receipt({ exit_code: null }))).toBe(false);
    expect(captureReceiptSucceeded(receipt({ exit_code: 7, ok: false }))).toBe(false);
  });

  it('counts torn/malformed records, foreign run ids, and post-terminal frames', () => {
    const parsed = parseCapturedNdjson(
      `${completedNdjson()}not-json-at-all\n{"type":"output"\n`,
    );
    expect(parsed.frames).toBe(4);
    expect(parsed.malformed).toBe(2); // the torn line + the frame after terminal
    expect(parsed.outcome?.['runId']).toBe('run-capture-1');
    expect(parsed.started).toBe(true);

    // A concatenated second run's frames are malformed, never merged.
    const foreign = parseCapturedNdjson(
      [
        JSON.stringify({ type: 'started', runId: 'run-a' }),
        JSON.stringify({ type: 'output', runId: 'run-b', stream: 'stdout', text: 'x' }),
      ].join('\n'),
    );
    expect(foreign.malformed).toBe(1);
    expect(foreign.outcome).toBeNull();

    // A second terminal frame is a concatenated stream, not a capture.
    const twoTerminals = parseCapturedNdjson(`${completedNdjson()}${completedNdjson()}`);
    expect(twoTerminals.malformed).toBeGreaterThan(0);
  });

  it('rejects a completed frame whose outcome lacks the receipt bindings', () => {
    const parsed = parseCapturedNdjson(
      `${JSON.stringify({ type: 'completed', runId: 'run-bad', outcome: { runId: 'run-bad', ok: true } })}\n`,
    );
    expect(parsed.outcome).toBeNull();
    expect(parsed.malformed).toBe(1);
  });
});

describe('owner records and identity-validated withdrawal', () => {
  it('reads/writes exclusively and reports malformed records without signalling', async () => {
    const dir = tempDir();
    const ownerPath = join(dir, 'sink.ndjson.owner.json');
    expect(readCaptureOwner(ownerPath)).toEqual({ kind: 'missing' });
    writeFileSync(ownerPath, 'watcher pid=38533\n');
    const malformed = readCaptureOwner(ownerPath);
    expect(malformed.kind).toBe('malformed');
    const signals: string[] = [];
    const result = await withdrawCaptureOwner(ownerPath, {
      probe: () => liveProbe,
      signal: (pid, signal) => signals.push(`${String(pid)}:${signal}`),
      sleep: async () => {},
      killGraceMs: 1,
    });
    expect(result.verdict).toBe('refused');
    expect(result.reason).toContain('malformed');
    expect(signals).toEqual([]);
    // The malformed record is preserved for an explicit operator decision.
    expect(readFileSync(ownerPath, 'utf-8')).toBe('watcher pid=38533\n');
  });

  it('withdraws ONLY a matching identity, and preserves sinks and receipts', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'sink.ndjson');
    const ownerPath = captureOwnerPath(sinkPath);
    writeFileSync(sinkPath, 'captured output');
    writeFileSync(captureReceiptPath(sinkPath), '{"receipt":true}');
    writeCaptureOwner(ownerPath, ownerRecord(sinkPath));
    const signals: string[] = [];
    let alive = true;
    const result = await withdrawCaptureOwner(ownerPath, {
      probe: () =>
        alive
          ? liveProbe
          : { alive: false, startTime: null, cwd: null, command: null },
      signal: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
      sleep: async () => {},
      killGraceMs: 1,
    });
    expect(result.verdict).toBe('withdrawn');
    expect(signals).toEqual(['SIGTERM']);
    expect(existsSync(ownerPath)).toBe(false);
    // Existing results/work are preserved by withdrawal.
    expect(readFileSync(sinkPath, 'utf-8')).toBe('captured output');
    expect(existsSync(captureReceiptPath(sinkPath))).toBe(true);
  });

  it('escalates SIGTERM to SIGKILL but never touches a mismatched process', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'sink.ndjson');
    const ownerPath = captureOwnerPath(sinkPath);
    writeCaptureOwner(ownerPath, ownerRecord(sinkPath));
    const signals: string[] = [];
    const stubborn = await withdrawCaptureOwner(ownerPath, {
      probe: () => liveProbe,
      signal: (_pid, signal) => signals.push(signal),
      sleep: async () => {},
      killGraceMs: 1,
    });
    expect(stubborn.verdict).toBe('withdrawn');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);

    const mismatchPath = captureOwnerPath(join(dir, 'other.ndjson'));
    writeCaptureOwner(mismatchPath, ownerRecord(join(dir, 'other.ndjson')));
    const refused = await withdrawCaptureOwner(mismatchPath, {
      probe: () => ({ ...liveProbe, startTime: 'Tue Oct  7 09:00:00 2026' }),
      signal: (_pid, signal) => signals.push(signal),
      sleep: async () => {},
      killGraceMs: 1,
    });
    expect(refused.verdict).toBe('refused');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']); // nothing added by the mismatch
    expect(existsSync(mismatchPath)).toBe(true);
  });

  it('clears a dead/stale owner without signalling and refuses unverifiable identities', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'sink.ndjson');
    const ownerPath = captureOwnerPath(sinkPath);
    writeCaptureOwner(ownerPath, ownerRecord(sinkPath));
    const signals: string[] = [];
    const stale = await withdrawCaptureOwner(ownerPath, {
      probe: () => ({ alive: false, startTime: null, cwd: null, command: null }),
      signal: (_pid, signal) => signals.push(signal),
      sleep: async () => {},
      killGraceMs: 1,
    });
    expect(stale.verdict).toBe('stale-cleared');
    expect(signals).toEqual([]);
    expect(existsSync(ownerPath)).toBe(false);

    writeCaptureOwner(ownerPath, ownerRecord(sinkPath));
    const unverifiable = await withdrawCaptureOwner(ownerPath, {
      probe: () => ({ alive: true, startTime: null, cwd: null, command: null }),
      signal: (_pid, signal) => signals.push(signal),
      sleep: async () => {},
      killGraceMs: 1,
    });
    expect(unverifiable.verdict).toBe('refused');
    expect(signals).toEqual([]);
  });

  it('reports the exact mismatching identity field and refuses an unverifiable one', () => {
    const record = ownerRecord('/tmp/x.ndjson');
    expect(identityMismatch(record, liveProbe)).toBeNull();
    expect(identityMismatch(record, { ...liveProbe, command: 'node unrelated.js' })).toContain('command');
    expect(identityMismatch(record, { ...liveProbe, cwd: '/tmp/elsewhere' })).toContain('cwd');
    // Start time missing on either side makes withdrawal unverifiable.
    expect(identityMismatch(record, { ...liveProbe, startTime: null })).toContain('unverifiable');
    expect(identityMismatch({ ...record, start_time: null }, liveProbe)).toContain('unverifiable');
  });

  it('never SIGKILLs a recycled pid: escalation revalidates the owner identity', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'recycled.ndjson');
    const ownerPath = captureOwnerPath(sinkPath);
    writeCaptureOwner(ownerPath, ownerRecord(sinkPath));
    const signals: string[] = [];
    let probes = 0;
    const result = await withdrawCaptureOwner(ownerPath, {
      probe: () => {
        probes += 1;
        // First probe: the true owner. Post-grace probe: a recycled,
        // unrelated process with the same pid.
        return probes === 1
          ? liveProbe
          : { alive: true, startTime: 'Tue Oct  7 09:00:00 2026', cwd: '/tmp/lane', command: liveProbe.command };
      },
      signal: (_pid, signal) => signals.push(signal),
      sleep: async () => {},
      killGraceMs: 1,
    });
    expect(signals).toEqual(['SIGTERM']);
    expect(result.verdict).toBe('stale-cleared');
    expect(existsSync(ownerPath)).toBe(false);
  });

  it('parses BSD-style lstart output with variable whitespace', () => {
    const parsed = parsePsOutput('Sun  4 Oct 15:53:22 2026 node dist/verify/capture-cli.js run\n');
    expect(parsed.startTime).toBe('Sun  4 Oct 15:53:22 2026');
    expect(parsed.command).toBe('node dist/verify/capture-cli.js run');
    expect(parsePsOutput('   ')).toEqual({ startTime: null, command: null });
  });
});

describe('capture CLI run: exclusive sink + honest outcome', () => {
  const BASE_ARGS = ['run', '--job', 'job-capture', '--scope', 'full'];

  function deps(overrides: CaptureCliDeps = {}): CaptureCliDeps {
    return {
      probe: () => liveProbe,
      cwd: () => '/tmp/lane',
      argv: ['capture-cli', 'run'],
      now: () => 1_700_000_000_000,
      ...overrides,
    };
  }

  it('writes the success receipt, removes the owner, and exits 0 only on a clean completed run', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'run.ndjson');
    const out: string[] = [];
    const posts: string[] = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      posts.push(input);
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body['request_id']).toBe('req-cli-ok');
      return new Response(completedNdjson(), {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      });
    };
    const code = await runCaptureCli(
      [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-cli-ok', '--url', 'http://127.0.0.1:9', '--token', 't'],
      deps({ fetchImpl, stdout: (text: string) => out.push(text) }),
    );
    expect(code).toBe(CAPTURE_EXIT.ok);
    expect(posts).toHaveLength(1);
    const receipt = JSON.parse(
      readFileSync(captureReceiptPath(sinkPath), 'utf-8'),
    ) as CaptureReceipt;
    expect(receipt.outcome).toBe('completed');
    expect(receipt.run_id).toBe('run-capture-1');
    expect(receipt.head).toBe('a'.repeat(40));
    expect(receipt.capture_bytes).toBeGreaterThan(0);
    expect(captureReceiptSucceeded(receipt)).toBe(true);
    expect(existsSync(captureOwnerPath(sinkPath))).toBe(false);
    // The raw sink is a complete capture, streamed to EOF.
    expect(readFileSync(sinkPath, 'utf-8')).toBe(completedNdjson());
    expect(out.join('')).toContain('run-capture-1');
  });

  it('records an UNKNOWN outcome on a lost connection and never promotes partial data', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'lost.ndjson');
    const code = await runCaptureCli(
      [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-cli-lost', '--url', 'http://127.0.0.1:9', '--token', 't'],
      deps({
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
        stdout: () => {},
      }),
    );
    expect(code).toBe(CAPTURE_EXIT.unknown);
    const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
    expect(receipt.outcome).toBe('unknown');
    expect(receipt.error).toContain('ECONNREFUSED');
    expect(captureReceiptSucceeded(receipt)).toBe(false);
    // The identity trail is preserved for a reconcile/withdraw decision.
    expect(existsSync(captureOwnerPath(sinkPath))).toBe(true);
  });

  it('treats a connection severed after a completed-looking frame as UNKNOWN, never success', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'severed.ndjson');
    const body = completedNdjson();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.error(new Error('socket reset before EOF'));
      },
    });
    const code = await runCaptureCli(
      [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-cli-severed', '--url', 'http://127.0.0.1:9', '--token', 't'],
      deps({ fetchImpl: async () => new Response(stream, { status: 200 }), stdout: () => {} }),
    );
    expect(code).toBe(CAPTURE_EXIT.unknown);
    const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
    expect(receipt.outcome).toBe('unknown');
    expect(receipt.error).toContain('socket reset');
    expect(captureReceiptSucceeded(receipt)).toBe(false);
  });

  it('marks a reconciled terminal replay as an unpromotable capture (exit 1, no rerun)', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'replay.ndjson');
    const body = `${JSON.stringify({ type: 'completed', runId: 'run-capture-1', reconciled: true, outcome: COMPLETED_OUTCOME })}\n`;
    const code = await runCaptureCli(
      [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-cli-replay', '--url', 'http://127.0.0.1:9', '--token', 't'],
      deps({ fetchImpl: async () => new Response(body, { status: 200 }), stdout: () => {} }),
    );
    expect(code).toBe(CAPTURE_EXIT.failed);
    const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
    expect(receipt.outcome).toBe('completed');
    expect(receipt.reconciled).toBe(true);
    expect(captureReceiptSucceeded(receipt)).toBe(false);
    expect(receipt.error).toContain('replayed terminal receipt');
  });

  it('exits 1 when a completed frame lacks the full success bindings (no exit code)', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'unbound.ndjson');
    const body = `${JSON.stringify({
      type: 'completed',
      runId: 'run-capture-1',
      outcome: { ...COMPLETED_OUTCOME, exitCode: null },
    })}\n`;
    const code = await runCaptureCli(
      [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-cli-unbound', '--url', 'http://127.0.0.1:9', '--token', 't'],
      deps({ fetchImpl: async () => new Response(body, { status: 200 }), stdout: () => {} }),
    );
    expect(code).toBe(CAPTURE_EXIT.failed);
    const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
    expect(captureReceiptSucceeded(receipt)).toBe(false);
  });

  it('marks a typed never-started lock_wait_timeout as retryable admission failure', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'admit.ndjson');
    const code = await runCaptureCli(
      [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-cli-admit', '--url', 'http://127.0.0.1:9', '--token', 't'],
      deps({
        fetchImpl: async () =>
          new Response(
            `${JSON.stringify({ type: 'error', code: 'lock_wait_timeout', detail: 'too many runs', wait_ms: 10 })}\n`,
            { status: 200 },
          ),
        stdout: () => {},
      }),
    );
    expect(code).toBe(CAPTURE_EXIT.admissionFailed);
    const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
    expect(receipt.outcome).toBe('admission-failed');
    expect(receipt.started).toBe(false);
  });

  it('refuses a sink owned by a LIVE helper before making any request (single-writer)', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'owned.ndjson');
    writeCaptureOwner(captureOwnerPath(sinkPath), ownerRecord(sinkPath));
    let fetches = 0;
    const errors: string[] = [];
    const code = await runCaptureCli(
      [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-second', '--url', 'http://127.0.0.1:9', '--token', 't'],
      deps({
        fetchImpl: async () => {
          fetches += 1;
          return new Response('', { status: 200 });
        },
        stderr: (text: string) => errors.push(text),
      }),
    );
    expect(code).toBe(CAPTURE_EXIT.usage);
    expect(fetches).toBe(0);
    expect(errors.join('')).toContain('owned by live helper');
  });

  it('keeps single-writer discipline across a fake-clock 15-minute outage (no multiplied watchers)', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'outage-1.ndjson');
    const resumedSink = join(dir, 'outage-2.ndjson');
    let clock = 1_700_000_000_000;
    let outage = true;
    let posts = 0;
    const fetchImpl = async (): Promise<Response> => {
      if (outage) throw new Error('connect: network is unreachable');
      posts += 1;
      return new Response(completedNdjson(), { status: 200 });
    };
    const baseDeps = deps({ fetchImpl, now: () => clock, stdout: () => {} });
    const first = await runCaptureCli(
      [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-outage', '--url', 'http://127.0.0.1:9', '--token', 't'],
      baseDeps,
    );
    expect(first).toBe(CAPTURE_EXIT.unknown);

    // The approved outage lasts 15 minutes; connectivity returns.
    clock += 15 * 60 * 1000;
    outage = false;
    const resumed = await runCaptureCli(
      [...BASE_ARGS, '--sink', resumedSink, '--request-id', 'req-outage', '--url', 'http://127.0.0.1:9', '--token', 't'],
      baseDeps,
    );
    expect(resumed).toBe(CAPTURE_EXIT.ok);
    expect(posts).toBe(1);

    // The pre-outage capture is still exclusively owned: a third watcher
    // cannot start for that sink while the owner identity is live, and it
    // makes NO request. Watchers/requests did not multiply.
    const third = await runCaptureCli(
      [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-outage-3', '--url', 'http://127.0.0.1:9', '--token', 't'],
      baseDeps,
    );
    expect(third).toBe(CAPTURE_EXIT.usage);
    expect(posts).toBe(1);
  });

  it('status answers via the reconcile surface and exits 3 when unreachable', async () => {
    const answers: string[] = [];
    const ok = await runCaptureCli(['status', '--request-id', 'req-status', '--url', 'http://x', '--token', 't'], {
      fetchImpl: async () => new Response('{"state":"running"}\n', { status: 200 }),
      stdout: (text: string) => answers.push(text),
      stderr: () => {},
    });
    expect(ok).toBe(CAPTURE_EXIT.ok);
    expect(answers.join('')).toContain('running');
    const unreachable = await runCaptureCli(['status', '--request-id', 'req-status', '--url', 'http://x', '--token', 't'], {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(unreachable).toBe(CAPTURE_EXIT.unknown);
  });

  it('withdraw subcommand validates identity through injected probes', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'w.ndjson');
    const ownerPath = captureOwnerPath(sinkPath);
    writeCaptureOwner(ownerPath, ownerRecord(sinkPath));
    const signals: string[] = [];
    let alive = true;
    const code = await runCaptureCli(['withdraw', '--owner', ownerPath, '--kill-grace-ms', '1'], {
      probe: () =>
        alive ? liveProbe : { alive: false, startTime: null, cwd: null, command: null },
      signal: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
      sleep: async () => {},
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(CAPTURE_EXIT.ok);
    expect(signals).toEqual(['SIGTERM']);
    expect(existsSync(ownerPath)).toBe(false);
  });
});

describe('keepalive pings in the capture stream (incident 2026-10-09)', () => {
  const PING_LINE = `${JSON.stringify({ type: 'ping' })}\n`;

  function completedWithPings(outcome: Record<string, unknown> = COMPLETED_OUTCOME): string {
    return (
      `${JSON.stringify({ type: 'queued', runId: outcome['runId'], position: 0, active: 0, limit: 1 })}\n` +
      PING_LINE +
      `${JSON.stringify({ type: 'started', runId: outcome['runId'], workers: 2, sha: outcome['sha'], queuedMs: 3 })}\n` +
      PING_LINE +
      `${JSON.stringify({ type: 'output', runId: outcome['runId'], stream: 'stdout', text: 'ok\n' })}\n` +
      PING_LINE +
      `${JSON.stringify({ type: 'completed', runId: outcome['runId'], outcome })}\n`
    );
  }

  function cliDeps(fetchImpl: CaptureCliDeps['fetchImpl']): CaptureCliDeps {
    return {
      probe: () => liveProbe,
      cwd: () => '/tmp/lane',
      argv: ['capture-cli', 'run'],
      now: () => 1_700_000_000_000,
      fetchImpl,
      stdout: () => {},
      stderr: () => {},
    };
  }

  it('accepts interleaved pings and still rejects a frame after the terminal', () => {
    const parsed = parseCapturedNdjson(completedWithPings());
    // Pings are counted apart from the producer frames and are never
    // malformed, and the one terminal completion binds the run/head/output
    // as before.
    expect(parsed.malformed).toBe(0);
    expect(parsed.frames).toBe(4);
    expect(parsed.pings).toBe(3);
    expect(parsed.started).toBe(true);
    expect(parsed.outcome?.['runId']).toBe('run-capture-1');

    // A ping AFTER the terminal frame is still a concatenated/foreign stream:
    // the keepalive must never loosen the post-terminal rejection.
    const postTerminal = parseCapturedNdjson(`${completedNdjson()}${PING_LINE}`);
    expect(postTerminal.malformed).toBe(1);
  });

  it('a completed capture whose body carried pings stays promotable through real EOF', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'pings-ok.ndjson');
    const body = completedWithPings();
    const code = await runCaptureCli(
      ['run', '--job', 'job-capture', '--scope', 'full', '--sink', sinkPath, '--request-id', 'req-cli-pings', '--url', 'http://127.0.0.1:9', '--token', 't'],
      cliDeps(
        async () =>
          new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }),
      ),
    );
    expect(code).toBe(CAPTURE_EXIT.ok);
    const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
    expect(receipt.outcome).toBe('completed');
    expect(captureReceiptSucceeded(receipt)).toBe(true);
    expect(receipt.run_id).toBe('run-capture-1');
    expect(receipt.head).toBe('a'.repeat(40));
    // Producer frames and transport pings are recorded separately.
    expect(receipt.frames).toBe(4);
    expect(receipt.pings).toBe(3);
    // Every real body byte to EOF is preserved, pings included.
    expect(readFileSync(sinkPath, 'utf-8')).toBe(body);
  });

  it('a stream severed after keepalive pings stays UNKNOWN, never success', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'pings-severed.ndjson');
    let step = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step === 0) {
          step += 1;
          controller.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({ type: 'queued', runId: 'run-capture-1', position: 0, active: 0, limit: 1 })}\n` +
                PING_LINE +
                PING_LINE +
                `${JSON.stringify({ type: 'started', runId: 'run-capture-1', workers: 2, sha: 'a'.repeat(40), queuedMs: 1 })}\n`,
            ),
          );
          return;
        }
        controller.error(new Error('socket reset before EOF'));
      },
    });
    const code = await runCaptureCli(
      ['run', '--job', 'job-capture', '--scope', 'full', '--sink', sinkPath, '--request-id', 'req-cli-pings-lost', '--url', 'http://127.0.0.1:9', '--token', 't'],
      cliDeps(async () => new Response(stream, { status: 200 })),
    );
    expect(code).toBe(CAPTURE_EXIT.unknown);
    const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
    expect(receipt.outcome).toBe('unknown');
    expect(receipt.started).toBe(true);
    expect(receipt.error).toContain('socket reset');
    // The keepalive pings were honestly recorded as liveness, not producer
    // frames, and never fabricate output or a terminal.
    expect(receipt.pings).toBe(2);
    expect(receipt.frames).toBe(2);
    expect(receipt.output_bytes).toBeNull();
    expect(captureReceiptSucceeded(receipt)).toBe(false);
  });
});
