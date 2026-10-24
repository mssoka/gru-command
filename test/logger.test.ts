import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function serviceRecords(dir: string): Record<string, unknown>[] {
  return readFileSync(join(dir, 'logs', 'service.log'), 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function enospc(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
}

describe('logger structured-line contract', () => {
  it('reserved structural keys cannot be overwritten by call sites', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-logger-'));
    cleanupDirs.push(dir);
    const logger = new Logger(dir, false);
    logger.info('real-message', { level: 'fake', msg: 'spoofed', ts: 'not-a-time' });
    const lines = readFileSync(join(dir, 'logs', 'service.log'), 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1] ?? '') as Record<string, unknown>;
    expect(last['level']).toBe('info');
    expect(last['msg']).toBe('real-message');
    expect(last['ts']).not.toBe('not-a-time');
    // An own toJSON field would replace the whole line; it is disarmed.
    logger.info('to-json-field', { lane: 'L-42', toJSON: () => ({ hijacked: true }) });
    const disarmed = serviceRecords(dir).at(-1) ?? {};
    expect(disarmed['msg']).toBe('to-json-field');
    expect(disarmed['lane']).toBe('L-42');
    expect(disarmed['hijacked']).toBeUndefined();
  });
});

describe('logger size-based rotation (E7)', () => {
  it('rotates at the cap: shards shift, retention prunes, writes continue', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-logger-rot-'));
    cleanupDirs.push(dir);
    const logger = new Logger(dir, false, { maxBytes: 600, keep: 2 });
    // ~120 bytes/line → rotate every ~5 lines; push well past retention.
    for (let i = 0; i < 30; i += 1) {
      logger.info('rotation-beat', { i, pad: 'x'.repeat(60) });
    }
    const names = readdirSync(join(dir, 'logs')).sort();
    // Live file + at most `keep` shards.
    expect(names).toContain('service.log');
    expect(names.filter((n) => /^service\.log\.\d+$/.test(n)).length).toBeLessThanOrEqual(2);
    // The live file is under the cap and parses line-by-line.
    const live = readFileSync(join(dir, 'logs', 'service.log'), 'utf-8');
    expect(live.length).toBeLessThanOrEqual(700); // cap + one line of slack
    for (const line of live.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Shard 1 exists and parses too (highest slot = oldest was pruned).
    const shard1 = readFileSync(join(dir, 'logs', 'service.log.1'), 'utf-8');
    for (const line of shard1.trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('rotation is best-effort: a failing or throwing rotation never blocks the append', () => {
    // Real failure: shard 1 is a non-empty directory, so the prune and the
    // live-file rename both fail inside rotateIfNeeded.
    const blocked = tempDir('gru-command-logger-rot-blocked-');
    mkdirSync(join(blocked, 'logs', 'service.log.1'), { recursive: true });
    writeFileSync(join(blocked, 'logs', 'service.log.1', 'occupant'), 'x');
    const blockedLogger = new Logger(blocked, false, { maxBytes: 10, keep: 1 });
    for (let i = 0; i < 5; i += 1) blockedLogger.info('still-alive', { i });
    expect(serviceRecords(blocked).map((record) => record['i'])).toEqual([0, 1, 2, 3, 4]);

    // A rotation that throws outright is guarded apart from the append.
    const throwing = tempDir('gru-command-logger-rot-throws-');
    const throwingLogger = new Logger(throwing, false);
    const rotate = vi.fn(() => {
      throw new Error('rotation exploded');
    });
    Reflect.set(throwingLogger, 'rotateIfNeeded', rotate);
    expect(() => throwingLogger.info('rotation-threw')).not.toThrow();
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(serviceRecords(throwing).map((record) => record['msg'])).toEqual(['rotation-threw']);
  });
});

describe('logger never throws (#496)', () => {
  it('an unserializable field is named with its reason; the other fields and ts/level/msg still land', () => {
    const dir = tempDir('gru-command-logger-unser-');
    const logger = new Logger(dir, false);
    const cycle: Record<string, unknown> = { name: 'cycle' };
    cycle['self'] = cycle;
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>, string, RegExp]> = [
      ['bigint', { lane: 'L-42', count: 10n }, 'count', /BigInt/],
      ['cycle', { lane: 'L-42', node: cycle }, 'node', /circular/i],
      [
        'throwing-getter',
        {
          lane: 'L-42',
          get boom(): unknown {
            throw new Error('getter exploded');
          },
        },
        'boom',
        /^getter exploded$/,
      ],
      [
        'unserializable-reason',
        {
          lane: 'L-42',
          get worse(): unknown {
            throw Object.assign(new Error('placeholder'), { message: 10n });
          },
        },
        'worse',
        /^10$/,
      ],
      [
        'undescribable-reason',
        {
          lane: 'L-42',
          get odd(): unknown {
            throw Object.create(null);
          },
        },
        'odd',
        /^unknown$/,
      ],
      // In the salvaged record the reserved keys still win over call-site
      // values, and the toJSON disarm still holds.
      [
        'spoof-and-hijack',
        { lane: 'L-42', count: 10n, level: 'fake', msg: 'spoofed', toJSON: () => ({ hijacked: true }) },
        'count',
        /BigInt/,
      ],
      // An own __proto__ field (JSON.parse makes one) stays a field, and is
      // named when it is the unserializable one.
      [
        'bad-own-proto',
        Object.defineProperty({ lane: 'L-42' }, '__proto__', { value: 10n, enumerable: true }),
        '__proto__',
        /BigInt/,
      ],
      ['own-proto', Object.assign(JSON.parse('{"__proto__":{"x":1},"lane":"L-42"}'), { count: 10n }), 'count', /BigInt/],
    ];
    for (const [name, fields] of cases) {
      expect(() => logger.error(`unserializable-${name}`, fields), name).not.toThrow();
    }
    const records = serviceRecords(dir);
    expect(records).toHaveLength(cases.length);
    for (const [index, [name, , badKey, reason]] of cases.entries()) {
      const record = records[index] ?? {};
      expect(record['msg'], name).toBe(`unserializable-${name}`);
      expect(record['level'], name).toBe('error');
      expect(typeof record['ts'], name).toBe('string');
      expect(record['lane'], name).toBe('L-42');
      expect(record['hijacked'], name).toBeUndefined();
      const unserializable = record['fields_unserializable'] as Record<string, unknown>;
      expect(Object.keys(unserializable), name).toEqual([badKey]);
      expect(unserializable[badKey], name).toMatch(reason);
    }
    const ownProto = records.at(-1) ?? {};
    expect(Object.hasOwn(ownProto, '__proto__')).toBe(true);
    expect(ownProto['__proto__']).toEqual({ x: 1 });
  });

  it('a record that fails again after salvage still writes a last-resort ts/level/msg line', () => {
    const dir = tempDir('gru-command-logger-last-resort-');
    const logger = new Logger(dir, false);
    // Serializes alone (second call) but not in the first or the salvaged record.
    let calls = 0;
    const flaky = {
      toJSON(): string {
        calls += 1;
        if (calls === 2) return 'ok';
        throw new Error('flaky toJSON');
      },
    };
    expect(() => logger.error('last-resort', { lane: 'L-42', flaky })).not.toThrow();
    expect(calls).toBe(3);
    const [record] = serviceRecords(dir);
    expect(record?.['msg']).toBe('last-resort');
    expect(record?.['level']).toBe('error');
    expect(record?.['fields_unserializable']).toBe('unknown');
  });

  it('a throwing stderr mirror never escapes log(), and the file line still lands', () => {
    const dir = tempDir('gru-command-logger-stderr-throw-');
    const logger = new Logger(dir, true);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw enospc();
    });
    try {
      expect(() => logger.warn('mirror-throws')).not.toThrow();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
    expect(serviceRecords(dir).map((record) => record['msg'])).toEqual(['mirror-throws']);
  });

  it('a failed append still reaches the stderr mirror, and a failing mirror then never escapes', () => {
    const dir = tempDir('gru-command-logger-append-fails-');
    const logger = new Logger(dir, true);
    // A directory where service.log belongs: every append fails (EISDIR).
    mkdirSync(join(dir, 'logs', 'service.log'));
    const mirrored: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      mirrored.push(String(chunk));
      return true;
    });
    try {
      expect(() => logger.error('append-failed')).not.toThrow();
      expect(mirrored.map((line) => (JSON.parse(line) as Record<string, unknown>)['msg'])).toEqual(['append-failed']);
      write.mockImplementation(() => {
        throw enospc();
      });
      expect(() => logger.error('append-and-mirror-failed')).not.toThrow();
    } finally {
      write.mockRestore();
    }
  });

  it('the first mirroring logger installs one process-wide stderr error listener that absorbs an async write error', async () => {
    const dir = tempDir('gru-command-logger-stderr-event-');
    // A fresh module instance and a listener-free stderr, so only this
    // test's loggers can install the guard.
    // rawListeners keeps once-wrappers one-shot when they are put back.
    const existing = process.stderr.rawListeners('error') as Array<(error: Error) => void>;
    process.stderr.removeAllListeners('error');
    try {
      vi.resetModules();
      const { Logger: FreshLogger } = await import('../src/logger.js');
      new FreshLogger(dir, false);
      expect(process.stderr.listenerCount('error')).toBe(0);
      const logger = new FreshLogger(dir, true);
      new FreshLogger(dir, true);
      expect(process.stderr.listenerCount('error')).toBe(1);
      // EventEmitter throws an 'error' event nobody listens for: the
      // uncaught exception main.ts turns into process.exit(1).
      expect(() => process.stderr.emit('error', enospc())).not.toThrow();
      logger.info('after-stderr-error');
      expect(serviceRecords(dir).at(-1)?.['msg']).toBe('after-stderr-error');
    } finally {
      process.stderr.removeAllListeners('error');
      for (const listener of existing) process.stderr.on('error', listener);
    }
  });
});
