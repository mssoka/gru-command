import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '../src/logger.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

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

  it('rotation is best-effort: an unwritable dir still logs to stderr without throwing', () => {
    const logger = new Logger(join(tmpdir(), 'gru-command-logger-dead-', `${Date.now()}-${process.pid}`), true, {
      maxBytes: 10,
      keep: 1,
    });
    expect(() => {
      for (let i = 0; i < 5; i += 1) logger.info('still-alive', { i });
    }).not.toThrow();
  });
});

describe('logger never throws (#496)', () => {
  it('unserializable fields still write a ts/level/msg line and never throw at the call site', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-logger-unser-'));
    cleanupDirs.push(dir);
    const logger = new Logger(dir, false);
    const cycle: Record<string, unknown> = { name: 'cycle' };
    cycle['self'] = cycle;
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ['bigint', { count: 10n }],
      ['cycle', { node: cycle }],
      [
        'throwing-getter',
        Object.defineProperty({}, 'boom', {
          enumerable: true,
          get() {
            throw new Error('getter exploded');
          },
        }) as Record<string, unknown>,
      ],
    ];
    for (const [name, fields] of cases) {
      expect(() => logger.error(`unserializable-${name}`, fields), name).not.toThrow();
    }
    const lines = readFileSync(join(dir, 'logs', 'service.log'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(cases.length);
    for (const [index, [name]] of cases.entries()) {
      const record = JSON.parse(lines[index] ?? '') as Record<string, unknown>;
      expect(record['msg'], name).toBe(`unserializable-${name}`);
      expect(record['level'], name).toBe('error');
      expect(typeof record['ts'], name).toBe('string');
      expect(typeof record['fields_unserializable'], name).toBe('string');
    }
    expect(JSON.parse(lines[2] ?? '')['fields_unserializable']).toBe('getter exploded');
  });

  it('a throwing stderr mirror never escapes log(), and the file line still lands', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-logger-stderr-throw-'));
    cleanupDirs.push(dir);
    const logger = new Logger(dir, true);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    });
    try {
      expect(() => logger.warn('mirror-throws')).not.toThrow();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
    const record = JSON.parse(readFileSync(join(dir, 'logs', 'service.log'), 'utf-8').trim()) as Record<string, unknown>;
    expect(record['msg']).toBe('mirror-throws');
  });

  it('an asynchronous stderr error event is heard, not an uncaught exception', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-logger-stderr-event-'));
    cleanupDirs.push(dir);
    // EventEmitter throws an 'error' event nobody listens for, which is the
    // uncaught exception that main.ts turns into process.exit(1).
    const logger = new Logger(dir, false);
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    new Logger(dir, true);
    const guarded = process.stderr.listenerCount('error');
    expect(() => process.stderr.emit('error', enospc)).not.toThrow();
    // One process-wide listener: more mirroring loggers add none.
    new Logger(dir, true);
    expect(process.stderr.listenerCount('error')).toBe(guarded);
    logger.info('after-stderr-error');
    const record = JSON.parse(readFileSync(join(dir, 'logs', 'service.log'), 'utf-8').trim()) as Record<string, unknown>;
    expect(record['msg']).toBe('after-stderr-error');
  });
});
