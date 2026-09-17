import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GruSessionPointer, SESSION_STATE_NAME } from '../src/chat/session-state.js';

/**
 * The single-Gru resume pointer: resume when the session file exists,
 * fresh spawn (with a warn) only when it vanished, loud refusal on a
 * corrupt pointer — guessing here forks brains.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-pointer-'));
  cleanupDirs.push(dir);
  return dir;
}

describe('GruSessionPointer', () => {
  it('no pointer file → no resume candidate (fresh spawn)', () => {
    const pointer = new GruSessionPointer(fixture());
    expect(pointer.resumeCandidate()).toBeNull();
  });

  it('records atomically and resumes the recorded session file', () => {
    const dir = fixture();
    const sessionFile = join(dir, 'sessions', 'gru-1.jsonl');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    writeFileSync(sessionFile, '{}\n');
    const pointer = new GruSessionPointer(dir);
    pointer.record(sessionFile);
    expect(pointer.resumeCandidate()).toBe(sessionFile);
    // A second pointer over the same dir sees the same record (restart).
    expect(new GruSessionPointer(dir).resumeCandidate()).toBe(sessionFile);
  });

  it('a pointer naming a vanished session file warns and spawns fresh', () => {
    const dir = fixture();
    const warnings: string[] = [];
    writeFileSync(
      join(dir, SESSION_STATE_NAME),
      `${JSON.stringify({ sessionFile: join(dir, 'gone.jsonl'), spawnedAt: 'x' })}\n`,
    );
    const pointer = new GruSessionPointer(dir, (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    });
    expect(pointer.resumeCandidate()).toBeNull();
    expect(warnings.some((msg) => msg.includes('vanished'))).toBe(true);
  });

  it('a corrupt pointer fails loud — never guesses', () => {
    const dir = fixture();
    writeFileSync(join(dir, SESSION_STATE_NAME), '{"sessionFile":', 'utf-8');
    expect(() => new GruSessionPointer(dir).resumeCandidate()).toThrowError(/unreadable/);
    writeFileSync(join(dir, SESSION_STATE_NAME), '{"other":1}\n', 'utf-8');
    expect(() => new GruSessionPointer(dir).resumeCandidate()).toThrowError(/no sessionFile/);
  });
});
