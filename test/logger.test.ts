import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
