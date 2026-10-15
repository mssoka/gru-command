import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  readCaptureReceipt,
  withdrawCaptureOwner,
  writeCaptureOwner,
  type CaptureOwnerRecord,
  type CaptureReceipt,
  type ProcessProbe,
} from '../src/verify/capture.js';
import {
  CAPTURE_EXIT,
  CAPTURE_RESPONSE_HEADERS_TIMEOUT_MS,
  CAPTURE_RESPONSE_TIMEOUT_CODE,
  checkResponseHeadersTimeoutMs,
  describeTransportError,
  nodeStreamFetch,
  parsePsOutput,
  runCaptureCli,
  type CaptureCliDeps,
} from '../src/verify/capture-cli.js';
import { verificationShellQuote } from '../src/runtime/worker-verification-policy.js';

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

  it('normalizes a pre-keepalive receipt that has no pings field', () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'legacy.ndjson');
    // A receipt written before the keepalive shipped carries no `pings`; it
    // truthfully held zero transport frames and must read back as 0, not
    // undefined.
    const legacy = { ...receipt(), sink: sinkPath } as Record<string, unknown>;
    delete legacy['pings'];
    writeFileSync(captureReceiptPath(sinkPath), `${JSON.stringify(legacy)}\n`);
    const read = readCaptureReceipt(captureReceiptPath(sinkPath));
    expect(read).not.toBeNull();
    expect(read!.pings).toBe(0);
  });

  it('refuses a present-but-corrupt pings field instead of reporting zero', () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'corrupt.ndjson');
    for (const corrupt of ['3', null, -1, 1.5, Number.NaN]) {
      writeFileSync(
        captureReceiptPath(sinkPath),
        `${JSON.stringify({ ...receipt(), sink: sinkPath, pings: corrupt })}\n`,
      );
      expect(readCaptureReceipt(captureReceiptPath(sinkPath))).toBeNull();
    }
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

  it('streams the production transport through a quiet stall with no client idle timeout (raw HTTP, never fetch)', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'stalled.ndjson');
    const frame = completedNdjson();
    const cut = frame.indexOf('{"type":"output"');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(frame.slice(0, cut));
      // A quiet stretch longer than any test would assert on: the raw
      // transport has no response idle timeout, so the stream survives
      // until the scheduler actually produces the terminal frame.
      setTimeout(() => res.end(frame.slice(cut)), 150);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      // Discriminator: if the run path fell back to global fetch, this
      // stub throws and the capture would not come back OK.
      vi.stubGlobal('fetch', () => {
        throw new Error('global fetch must not carry the verify stream');
      });
      const code = await runCaptureCli(
        [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-cli-stall', '--url', `http://127.0.0.1:${String(port)}`, '--token', 't'],
        deps({ stdout: () => {} }),
      );
      expect(code).toBe(CAPTURE_EXIT.ok);
      const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
      expect(receipt.outcome).toBe('completed');
      expect(receipt.reconciled).toBe(false);
      expect(receipt.error).toBeNull();
      expect(captureReceiptSucceeded(receipt)).toBe(true);
      expect(readFileSync(sinkPath, 'utf-8')).toBe(frame);
    } finally {
      vi.unstubAllGlobals();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('the raw transport reads a chunked body through a stall and keeps a bounded consumer queue', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('first\n');
      setTimeout(() => res.end('second\n'), 200);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await nodeStreamFetch(`http://127.0.0.1:${String(port)}/stream`);
      expect(response.ok).toBe(true);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toBe('first\nsecond\n');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('records UNKNOWN and never promotes when the real transport socket is severed mid-stream', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'severed.ndjson');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      // A completed-looking frame, then a hard reset without a clean end:
      // the reader must not treat the parsed outcome as a finished stream.
      res.write(completedNdjson());
      setTimeout(() => res.destroy(), 50);
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const code = await runCaptureCli(
        [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-cli-severed', '--url', `http://127.0.0.1:${String(port)}`, '--token', 't'],
        deps({ stdout: () => {} }),
      );
      expect(code).toBe(CAPTURE_EXIT.unknown);
      const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
      expect(receipt.outcome).toBe('unknown');
      expect(captureReceiptSucceeded(receipt)).toBe(false);
      // The receipt keeps the socket errno, not just "aborted".
      expect(receipt.error).toContain('ECONNRESET');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('the raw transport is one-shot: every mixed or repeated consumer fails loud instead of hanging', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('payload\n');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${String(port)}/one-shot`;
      // text() then text()/json(): the second read rejects (a second
      // `end` listener on the finished response would never settle).
      const first = await nodeStreamFetch(url);
      expect(await first.text()).toBe('payload\n');
      await expect(first.text()).rejects.toThrow(/one-shot/u);
      await expect(first.json()).rejects.toThrow(/one-shot/u);
      // text() then body: the byte stream errors on read, never hangs.
      await expect(first.body!.getReader().read()).rejects.toThrow(/already consumed/u);
      // body then text(): the byte stream owns the response.
      const second = await nodeStreamFetch(url);
      const reader = second.body!.getReader();
      await reader.read();
      await expect(second.text()).rejects.toThrow(/byte stream/u);
      // Touching the body surface claims the response even without a read.
      const third = await nodeStreamFetch(url);
      expect(third.body).not.toBeNull();
      await expect(third.text()).rejects.toThrow(/byte stream/u);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('pauses the socket once the consumer is behind and resumes on read (bounded queue)', async () => {
    const chunkBytes = 64 * 1024;
    const totalBytes = 128 * chunkBytes; // 8 MiB
    let written = 0;
    let releasePump: () => void = () => {};
    const pumpGate = new Promise<void>((resolve) => {
      releasePump = resolve;
    });
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(chunkBytes, 7);
      res.write(chunk); // the first chunk resolves the consumer's first read
      written += chunkBytes;
      // The bulk starts only AFTER the consumer's first read: backpressure
      // observed from here on is the consumer stalling, never the pre-read
      // attach window (a server that pumps before the consumer attaches
      // would record backpressure for either transport shape).
      void pumpGate.then(() => {
        const pump = (): void => {
          while (written < totalBytes) {
            const accepted = res.write(chunk);
            written += chunkBytes;
            if (!accepted) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        pump();
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await nodeStreamFetch(`http://127.0.0.1:${String(port)}/bulk`);
      const reader = response.body!.getReader();
      const first = await reader.read();
      releasePump();
      // While the consumer stays stalled, the bounded queue stops reading
      // the socket, so the server can NEVER finish the transfer; an
      // unbounded queue would drain the whole payload and finish.
      const deadline = Date.now() + 10_000;
      let lastWritten = -1;
      let stableChecks = 0;
      while (written < totalBytes && stableChecks < 4 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        stableChecks = written === lastWritten ? stableChecks + 1 : 0;
        lastWritten = written;
      }
      expect(written, 'the server finished a transfer the stalled consumer never drained').toBeLessThan(totalBytes);
      let received = first.value?.byteLength ?? 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value?.byteLength ?? 0;
      }
      expect(received).toBe(totalBytes);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });


  it('capture status reconciles through the raw transport by default (global fetch never used)', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ state: 'running', requestId: 'req-status-raw' }));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const answers: string[] = [];
      vi.stubGlobal('fetch', () => {
        throw new Error('global fetch must not carry the status request');
      });
      const code = await runCaptureCli(
        ['status', '--request-id', 'req-status-raw', '--url', `http://127.0.0.1:${String(port)}`, '--token', 't'],
        { stdout: (text: string) => answers.push(text), stderr: () => {} },
      );
      expect(code).toBe(CAPTURE_EXIT.ok);
      expect(answers.join('')).toContain('running');
    } finally {
      vi.unstubAllGlobals();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('bounds connect + response headers: a service that never answers is a named transport error, never a hang (#389)', async () => {
    expect(CAPTURE_RESPONSE_HEADERS_TIMEOUT_MS).toBe(60_000);
    const hung = createServer(() => {
      // Accepts the connection and never answers.
    });
    await new Promise<void>((resolveListen) => hung.listen(0, '127.0.0.1', resolveListen));
    try {
      const base = `http://127.0.0.1:${String((hung.address() as AddressInfo).port)}`;
      const started = Date.now();
      const error = await nodeStreamFetch(`${base}/api/verify`, { method: 'POST', body: '{}' }, { responseHeadersTimeoutMs: 150 })
        .then(() => null, (cause: unknown) => cause as NodeJS.ErrnoException);
      expect(error?.message).toMatch(/POST http:\/\/127\.0\.0\.1:\d+\/api\/verify: no response within 150 ms \(connect \+ response headers\)/u);
      expect(error?.message).toContain('outcome is unknown');
      expect(error?.message).toContain("run the capture helper's status action with the same --request-id");
      expect(error?.code).toBe(CAPTURE_RESPONSE_TIMEOUT_CODE);
      expect(Date.now() - started).toBeLessThan(5_000);

      // The capture command records it in the receipt as UNKNOWN — never a hang.
      const dir = tempDir();
      const sinkPath = join(dir, 'hung.ndjson');
      const code = await runCaptureCli(
        [...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-cli-hung', '--url', base, '--token', 't'],
        deps({ stdout: () => {}, responseHeadersTimeoutMs: 150 }),
      );
      expect(code).toBe(CAPTURE_EXIT.unknown);
      const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
      expect(receipt.outcome).toBe('unknown');
      expect(receipt.error).toContain('no response within 150 ms');
      expect(receipt.error).toContain(CAPTURE_RESPONSE_TIMEOUT_CODE);

      // `status` uses the same bounded transport.
      const errors: string[] = [];
      const status = await runCaptureCli(
        ['status', '--request-id', 'req-cli-hung', '--url', base, '--token', 't'],
        { responseHeadersTimeoutMs: 150, stdout: () => {}, stderr: (text: string) => errors.push(text) },
      );
      expect(status).toBe(CAPTURE_EXIT.unknown);
      expect(errors.join('')).toContain('no response within 150 ms');
    } finally {
      hung.closeAllConnections();
      await new Promise<void>((resolveClose) => hung.close(() => resolveClose()));
    }
  });

  const BAD_BOUND = /responseHeadersTimeoutMs must be a number of milliseconds from 1 to 2147483647/u;
  const OPS = ['--url', 'http://127.0.0.1:9', '--token', 't'] as const;
  const deadProbe = { alive: false, startTime: null, cwd: null, command: null };

  it('refuses a headers bound that cannot time correctly by name, as a rejection (#389)', async () => {
    // The timer's real range is accepted at both edges.
    expect(checkResponseHeadersTimeoutMs(1)).toBe(1);
    expect(checkResponseHeadersTimeoutMs(2_147_483_647)).toBe(2_147_483_647);
    for (const bound of [0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 31]) {
      // A Promise-returning transport rejects; it never throws synchronously.
      const pending = nodeStreamFetch('http://127.0.0.1:9/x', undefined, { responseHeadersTimeoutMs: bound });
      await expect(pending, String(bound)).rejects.toThrow(BAD_BOUND);
    }
  });

  it('run and status refuse a bad bound before any request, sink, receipt or output, whatever the transport (#389)', async () => {
    const dir = tempDir();
    const fetchImpl = vi.fn();
    const cases = [
      { label: 'run/default transport', argv: (sink: string) => [...BASE_ARGS, '--sink', sink, '--request-id', 'req-bad-run-1', ...OPS], bound: 0, injected: false },
      { label: 'run/injected transport', argv: (sink: string) => [...BASE_ARGS, '--sink', sink, '--request-id', 'req-bad-run-2', ...OPS], bound: 0.5, injected: true },
      { label: 'status/default transport', argv: () => ['status', '--request-id', 'req-bad-status-1', ...OPS], bound: Number.NaN, injected: false },
      { label: 'status/injected transport', argv: () => ['status', '--request-id', 'req-bad-status-2', ...OPS], bound: 2 ** 31, injected: true },
    ];
    for (const [index, entry] of cases.entries()) {
      const sinkPath = join(dir, `bad-bound-${String(index)}.ndjson`);
      const out: string[] = [];
      const cliDeps: CaptureCliDeps = { ...deps({ stdout: (text: string) => out.push(text) }), stderr: (text: string) => out.push(text), responseHeadersTimeoutMs: entry.bound,
        ...(entry.injected ? { fetchImpl: fetchImpl as never } : {}) };
      await expect(runCaptureCli(entry.argv(sinkPath), cliDeps), entry.label).rejects.toThrow(BAD_BOUND);
      expect(out, entry.label).toEqual([]);
      expect(existsSync(sinkPath), entry.label).toBe(false);
      expect(existsSync(captureReceiptPath(sinkPath)), entry.label).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('every usage error keeps its own usage exit and message despite a bad bound (#389)', async () => {
    const dir = tempDir();
    const fetchImpl = vi.fn();
    try {
      vi.stubEnv('GRU_OPS_URL', undefined);
      vi.stubEnv('GRU_OPS_TOKEN', undefined);
      vi.stubEnv('GRU_COMMAND_CONFIG', undefined);
      const usageCases: readonly (readonly [readonly string[], RegExp])[] = [
        [['--help'], /^usage:/u], [['-h'], /^usage:/u], [[], /^usage:/u],
        [['run', '--bogus'], /--bogus requires a value/u], [['frobnicate'], /unknown command "frobnicate"/u],
        [['run'], /--job is required/u], [['status'], /--request-id is required/u],
        [[...BASE_ARGS, '--sink', join(dir, 'no-ops.ndjson')], /--url \(or GRU_OPS_URL\) is required/u],
        [['status', '--request-id', 'req-no-ops'], /--url \(or GRU_OPS_URL\) is required/u],
        [['status', '--request-id', 'req-no-token', '--url', 'http://127.0.0.1:9'], /--token \(or GRU_OPS_TOKEN\), or --config pointing at a config with \[auth\] token, is required/u],
        [[...BASE_ARGS, '--sink', join(dir, 'no-token.ndjson'), '--url', 'http://127.0.0.1:9'], /--token \(or GRU_OPS_TOKEN\), or --config pointing at a config with \[auth\] token, is required/u],
      ];
      for (const [argv, message] of usageCases) {
        const usage: string[] = [];
        expect(await runCaptureCli(argv, { responseHeadersTimeoutMs: 0, fetchImpl: fetchImpl as never, stderr: (text: string) => usage.push(text) }), argv.join(' ')).toBe(CAPTURE_EXIT.usage);
        expect(usage.join(''), argv.join(' ')).toMatch(message);
        expect(usage.join(''), argv.join(' ')).not.toMatch(BAD_BOUND);
      }
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('owner refusals precede the bound check, and the stale-owner removal follows it (#389)', async () => {
    const dir = tempDir();
    const fetchImpl = vi.fn();
    const probed: number[] = [];
    const run = (sink: string, requestId: string, probe: ProcessProbe, stderr: (text: string) => void) => runCaptureCli(
      [...BASE_ARGS, '--sink', sink, '--request-id', requestId, ...OPS],
      { ...deps({ probe: (pid: number) => { probed.push(pid); return probe; } }), fetchImpl: fetchImpl as never, responseHeadersTimeoutMs: 0, stderr });
    // Malformed owner: its usage refusal, the record untouched.
    const malformedSink = join(dir, 'malformed.ndjson');
    writeFileSync(captureOwnerPath(malformedSink), 'not an owner record');
    const malformed: string[] = [];
    expect(await run(malformedSink, 'req-owner-malformed', liveProbe, (text) => malformed.push(text))).toBe(CAPTURE_EXIT.usage);
    expect(malformed.join('')).toMatch(/is malformed/u);
    expect(malformed.join('')).not.toMatch(BAD_BOUND);
    expect(readFileSync(captureOwnerPath(malformedSink), 'utf-8')).toBe('not an owner record');
    expect(existsSync(malformedSink)).toBe(false);
    expect(probed, 'a malformed record is refused before any probe').toEqual([]);
    // Live owner (explicitly alive): its usage refusal, the record untouched.
    const liveSink = join(dir, 'live.ndjson');
    writeCaptureOwner(captureOwnerPath(liveSink), ownerRecord(liveSink));
    const liveRecord = readFileSync(captureOwnerPath(liveSink), 'utf-8');
    const live: string[] = [];
    expect(await run(liveSink, 'req-owner-live', liveProbe, (text) => live.push(text))).toBe(CAPTURE_EXIT.usage);
    expect(live.join('')).toMatch(/owned by live helper/u);
    expect(live.join('')).not.toMatch(BAD_BOUND);
    expect(readFileSync(captureOwnerPath(liveSink), 'utf-8')).toBe(liveRecord);
    expect(existsSync(liveSink)).toBe(false);
    expect(probed, 'the live refusal probed the recorded owner').toEqual([ownerRecord(liveSink).pid]);
    // Stale owner: the bound error comes first, so the record is NOT removed.
    const staleSink = join(dir, 'stale.ndjson');
    writeCaptureOwner(captureOwnerPath(staleSink), ownerRecord(staleSink));
    const staleRecord = readFileSync(captureOwnerPath(staleSink), 'utf-8');
    await expect(run(staleSink, 'req-owner-stale', deadProbe, () => {})).rejects.toThrow(BAD_BOUND);
    expect(readFileSync(captureOwnerPath(staleSink), 'utf-8')).toBe(staleRecord);
    expect(existsSync(staleSink)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('with a valid bound, a stale owner is removed and the run proceeds through the injected transport (#389)', async () => {
    const dir = tempDir();
    const sinkPath = join(dir, 'stale-valid.ndjson');
    writeCaptureOwner(captureOwnerPath(sinkPath), ownerRecord(sinkPath));
    const fetchImpl = vi.fn(async (): Promise<Response> => { throw new Error('fixture transport unreachable'); });
    for (const bound of [1, 2_147_483_647]) {
      const run = await runCaptureCli([...BASE_ARGS, '--sink', sinkPath.replace('.ndjson', `-${String(bound)}.ndjson`), '--request-id', `req-stale-${String(bound)}`, ...OPS],
        { ...deps({ probe: () => deadProbe }), fetchImpl, responseHeadersTimeoutMs: bound, stdout: () => {}, stderr: () => {} });
      expect(run, String(bound)).toBe(CAPTURE_EXIT.unknown);
    }
    const code = await runCaptureCli([...BASE_ARGS, '--sink', sinkPath, '--request-id', 'req-stale-valid', ...OPS],
      { ...deps({ probe: () => deadProbe }), fetchImpl, responseHeadersTimeoutMs: 30_000, stdout: () => {}, stderr: () => {} });
    expect(code).toBe(CAPTURE_EXIT.unknown);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // The dead claim was cleared and replaced by this run's OWN ownership
    // (kept for reconciliation after an UNKNOWN outcome); its receipt exists.
    expect(existsSync(captureReceiptPath(sinkPath))).toBe(true);
    expect(JSON.parse(readFileSync(captureOwnerPath(sinkPath), 'utf-8'))).toMatchObject({ request_id: 'req-stale-valid' });
  });

  it('accepts the bound at both timer edges and uses the injected transport (#389)', async () => {
    for (const bound of [1, 2_147_483_647]) {
      const edgeFetch = vi.fn(async (): Promise<Response> => { throw new Error('fixture transport unreachable'); });
      expect(await runCaptureCli(['status', '--request-id', 'req-edge', ...OPS],
        { responseHeadersTimeoutMs: bound, fetchImpl: edgeFetch, stdout: () => {}, stderr: () => {} }), String(bound)).toBe(CAPTURE_EXIT.unknown);
      expect(edgeFetch, String(bound)).toHaveBeenCalledTimes(1);
    }
  });

  it('withdraw makes no request, so a bad bound never blocks owner recovery (#389)', async () => {
    const withdraw: string[] = [];
    expect(await runCaptureCli(['withdraw', '--owner', join(tempDir(), 'absent.owner.json')],
      { responseHeadersTimeoutMs: 0, stdout: (text: string) => withdraw.push(text), stderr: (text: string) => withdraw.push(text) })).toBe(CAPTURE_EXIT.usage);
    expect(withdraw.join('')).toMatch(/withdrawal refused: no owner record at this path/u);
    expect(withdraw.join('')).not.toMatch(BAD_BOUND);
  });

  it('the headers bound ends at the response: a body quiet for longer than it still streams to EOF (#389)', async () => {
    // Generous against a loaded runner's connect + headers latency.
    const bound = 1_000;
    let held: ServerResponse | null = null;
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write('first\n');
      held = res;
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await nodeStreamFetch(`http://127.0.0.1:${String(port)}/quiet`, undefined, { responseHeadersTimeoutMs: bound });
      // The body stays quiet past the bound by construction: the timer was
      // armed before connect, and the body is released only after the whole
      // bound (plus a margin) has elapsed SINCE the headers arrived.
      await new Promise((resolveWait) => setTimeout(resolveWait, bound + 250));
      expect(held).not.toBeNull();
      held!.end('second\n');
      expect(await response.text()).toBe('first\nsecond\n');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('rejects an unsupported request body loudly and honors an abort signal', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('chunk');
      // Held open: the abort must reject the reader instead of hanging.
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const port = (server.address() as AddressInfo).port;
      const url = `http://127.0.0.1:${String(port)}/signal`;
      await expect(
        nodeStreamFetch(url, { method: 'POST', body: new URLSearchParams('a=b') }),
      ).rejects.toThrow(/string or Buffer/u);
      const controller = new AbortController();
      const response = await nodeStreamFetch(url, { signal: controller.signal });
      const reader = response.body!.getReader();
      await reader.read();
      controller.abort();
      await expect(reader.read()).rejects.toThrow(/aborted|ECONNRESET|destroyed|reset/i);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it('transport errors render their own errno and any cause for the receipt', () => {
    const own = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    expect(describeTransportError(own)).toContain('ECONNRESET');
    expect(describeTransportError(new Error('plain'))).toBe('plain');
    const wrapper = new Error('request failed', {
      cause: Object.assign(new Error('reset by peer'), { code: 'EPIPE' }),
    });
    expect(describeTransportError(wrapper)).toContain('cause');
    expect(describeTransportError(wrapper)).toContain('EPIPE');
    expect(describeTransportError('boom')).toBe('boom');
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

  it('runs the advertised authenticated status action from a relocated config path with literal $ and backtick (N11)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-$`instance-'));
    dirs.push(root);
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, '[auth]\ntoken = "ops-token"\n');
    let seen: { url: string; auth: string | null } | null = null;
    const out: string[] = [];
    const code = await runCaptureCli(
      ['status', '--request-id', 'req-n11', '--url', 'http://ops', '--config', configPath],
      {
        fetchImpl: async (input, init) => {
          seen = { url: input, auth: new Headers(init?.headers).get('authorization') };
          return new Response('{"state":"running"}\n', { status: 200 });
        },
        stdout: (text: string) => out.push(text),
        stderr: () => {},
      },
    );
    expect(code).toBe(CAPTURE_EXIT.ok);
    expect(seen).toEqual({
      url: 'http://ops/api/verify/status?request_id=req-n11', auth: 'Bearer ops-token',
    });
    expect(out.join('')).toContain('running');
    // The exact path the refusal advertises is shell-safe: quoting it round-trips
    // through a real shell with the literal `$`/backtick intact.
    const resolved = spawnSync('/bin/sh', ['-c', `printf %s ${verificationShellQuote(configPath)}`], { encoding: 'utf8' });
    expect(resolved.status, resolved.stderr).toBe(0);
    expect(resolved.stdout).toBe(configPath);
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

    // A LEADING ping (legal: the body's first frame) still binds the run and
    // parses cleanly.
    const leading = parseCapturedNdjson(
      PING_LINE +
        `${JSON.stringify({ type: 'queued', runId: 'run-capture-1', position: 0, active: 0, limit: 1 })}\n` +
        `${JSON.stringify({ type: 'started', runId: 'run-capture-1', workers: 2, sha: 'a'.repeat(40), queuedMs: 1 })}\n` +
        `${JSON.stringify({ type: 'completed', runId: 'run-capture-1', outcome: COMPLETED_OUTCOME })}\n`,
    );
    expect(leading.malformed).toBe(0);
    expect(leading.frames).toBe(3);
    expect(leading.pings).toBe(1);
    expect(leading.started).toBe(true);
    expect(leading.outcome?.['runId']).toBe('run-capture-1');

    // An IDENTITY-BEARING ping may not bypass the single-run check: a ping
    // for another run makes the stream malformed and it is never promoted.
    const foreignPing = parseCapturedNdjson(
      `${JSON.stringify({ type: 'queued', runId: 'run-capture-1', position: 0, active: 0, limit: 1 })}\n` +
        `${JSON.stringify({ type: 'ping', runId: 'run-foreign' })}\n` +
        `${JSON.stringify({ type: 'completed', runId: 'run-capture-1', outcome: COMPLETED_OUTCOME })}\n`,
    );
    expect(foreignPing.malformed).toBeGreaterThan(0);

    // A LEADING foreign ping cannot silently establish someone else's run.
    const leadingForeign = parseCapturedNdjson(
      `${JSON.stringify({ type: 'ping', runId: 'run-foreign' })}\n` +
        `${JSON.stringify({ type: 'queued', runId: 'run-capture-1', position: 0, active: 0, limit: 1 })}\n` +
        `${JSON.stringify({ type: 'started', runId: 'run-capture-1', workers: 2, sha: 'a'.repeat(40), queuedMs: 1 })}\n` +
        `${JSON.stringify({ type: 'completed', runId: 'run-capture-1', outcome: COMPLETED_OUTCOME })}\n`,
    );
    expect(leadingForeign.malformed).toBeGreaterThan(0);
    expect(leadingForeign.outcome).toBeNull();

    // Identity-free pings and a matching identity-bearing ping stay clean.
    const matchedPing = parseCapturedNdjson(
      `${JSON.stringify({ type: 'ping' })}\n` +
        `${JSON.stringify({ type: 'ping', runId: 'run-capture-1' })}\n` +
        `${JSON.stringify({ type: 'completed', runId: 'run-capture-1', outcome: COMPLETED_OUTCOME })}\n`,
    );
    expect(matchedPing.malformed).toBe(0);
    expect(matchedPing.pings).toBe(2);
    expect(matchedPing.outcome?.['runId']).toBe('run-capture-1');
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

  it('refuses a capture whose pings carry a foreign run identity', async () => {
    const dir = tempDir();
    const producerFrames =
      `${JSON.stringify({ type: 'queued', runId: 'run-capture-1', position: 0, active: 0, limit: 1 })}\n` +
      `${JSON.stringify({ type: 'started', runId: 'run-capture-1', workers: 2, sha: 'a'.repeat(40), queuedMs: 3 })}\n` +
      `${JSON.stringify({ type: 'output', runId: 'run-capture-1', stream: 'stdout', text: 'ok\\n' })}\n` +
      `${JSON.stringify({ type: 'completed', runId: 'run-capture-1', outcome: COMPLETED_OUTCOME })}\n`;
    const foreignPing = `${JSON.stringify({ type: 'ping', runId: 'run-foreign' })}\n`;
    const queuedLine = `${JSON.stringify({ type: 'queued', runId: 'run-capture-1', position: 0, active: 0, limit: 1 })}\n`;
    // After admission, and as a leading frame before any producer frame.
    const afterAdmission = queuedLine + foreignPing + producerFrames.replace(queuedLine, '');
    const leading = foreignPing + producerFrames;
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['after-admission', afterAdmission],
      ['leading', leading],
    ];
    for (const [label, body] of cases) {
      const sinkPath = join(dir, `${label}.ndjson`);
      const exitCode = await runCaptureCli(
        ['run', '--job', 'job-capture', '--scope', 'full', '--sink', sinkPath, '--request-id', `req-foreign-ping-${label}`, '--url', 'http://127.0.0.1:9', '--token', 't'],
        cliDeps(async () => new Response(body, { status: 200 })),
      );
      expect(exitCode, `${label}: a foreign identity-bearing ping must not be promoted`).toBe(CAPTURE_EXIT.unknown);
      const receipt = JSON.parse(readFileSync(captureReceiptPath(sinkPath), 'utf-8')) as CaptureReceipt;
      expect(receipt.outcome).toBe('unknown');
      expect(receipt.error).toContain('malformed');
      expect(captureReceiptSucceeded(receipt)).toBe(false);
    }
  });
});
