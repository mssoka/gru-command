import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearCreationIntent, readCreationIntent, writeCreationIntent, type CreationIntent } from '../src/worktrees/creation-intent.js';

/**
 * The creation receipt is the only durable proof that a lane's branch
 * transaction was ours (issue #453). These pin the reader's refusals: a
 * receipt that is malformed, inconsistent or written by another invocation
 * must never be adoptable, and a receipt may never be overwritten silently.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function common(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-creation-intent-'));
  dirs.push(dir);
  return dir;
}

function token(): string {
  return `gru-creation:${randomUUID()}`;
}

function receipt(overrides: Partial<Omit<CreationIntent, 'version' | 'host' | 'pid' | 'createdAt'>> = {}) {
  return {
    lane: { id: 'job-1', kind: 'job' as const, jobId: 'job-1', roundId: null, path: '/lanes/repo/job-job-1' },
    repoPath: '/repos/repo', branch: 'gru/job-1', sha: 'a'.repeat(40), baseSource: 'origin' as const, token: token(),
    ...overrides,
  };
}

function receiptFile(dir: string): string {
  const file = readdirSync(join(dir, 'gru-creation')).filter((entry) => entry.endsWith('.json'));
  expect(file).toHaveLength(1);
  return join(dir, 'gru-creation', file[0]!);
}

function mutate(dir: string, change: (value: Record<string, unknown>) => void): void {
  const file = receiptFile(dir);
  const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  change(value);
  writeFileSync(file, JSON.stringify(value));
}

describe('creation receipt (#453)', () => {
  it('round-trips exactly, and never overwrites an unreconciled receipt for its branch', () => {
    const dir = common();
    const written = writeCreationIntent(dir, receipt());
    expect(readCreationIntent(dir, 'gru/job-1')).toEqual(written);
    expect(() => writeCreationIntent(dir, receipt())).toThrow(/already has an unreconciled creation receipt/);
    // The first receipt is untouched by the refused write.
    expect(readCreationIntent(dir, 'gru/job-1')).toEqual(written);
    // Another branch has its own receipt.
    writeCreationIntent(dir, receipt({ lane: { id: 'job-2', kind: 'job', jobId: 'job-2', roundId: null, path: '/lanes/repo/job-job-2' }, branch: 'gru/job-2' }));
    expect(readdirSync(join(dir, 'gru-creation')).filter((entry) => entry.endsWith('.json'))).toHaveLength(2);
  });

  it('refuses a token the handoff receipt reader would reject', () => {
    const dir = common();
    writeCreationIntent(dir, receipt());
    mutate(dir, (value) => { value['token'] = 'gru-creation:not-a-uuid'; });
    expect(() => readCreationIntent(dir, 'gru/job-1')).toThrow(/has a malformed creation token/);
  });

  it('clears only the receipt its own token names', () => {
    const dir = common();
    const written = writeCreationIntent(dir, receipt());
    expect(() => clearCreationIntent(dir, 'gru/job-1', token())).toThrow(/belongs to another invocation/);
    expect(existsSync(receiptFile(dir))).toBe(true);
    clearCreationIntent(dir, 'gru/job-1', written.token);
    expect(readCreationIntent(dir, 'gru/job-1')).toBeNull();
  });

  it('names every malformed receipt instead of guessing at it', () => {
    for (const [change, error] of [
      [(value: Record<string, unknown>) => { value['version'] = 2; }, /unsupported version/],
      [(value: Record<string, unknown>) => { value['branch'] = 'gru/other'; }, /names branch gru\/other, not gru\/job-1/],
      [(value: Record<string, unknown>) => { value['sha'] = 'not-a-sha'; }, /malformed base sha/],
      [(value: Record<string, unknown>) => { value['baseSource'] = 'guessed'; }, /unknown base source/],
      [(value: Record<string, unknown>) => { (value['lane'] as Record<string, unknown>)['id'] = 'other'; }, /does not bind the job to its own lane/],
      [(value: Record<string, unknown>) => { value['baseSource'] = null; }, /has no base provenance for a job lane/],
    ] as const) {
      const dir = common();
      writeCreationIntent(dir, receipt());
      mutate(dir, change);
      expect(() => readCreationIntent(dir, 'gru/job-1'), String(change)).toThrow(error);
    }
    const dir = common();
    writeCreationIntent(dir, receipt());
    writeFileSync(receiptFile(dir), '{not json');
    expect(() => readCreationIntent(dir, 'gru/job-1')).toThrow(/is not valid JSON/);
  });
});
