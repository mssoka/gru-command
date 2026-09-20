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
    expect(pointer.current()).toMatchObject({ epoch: 0, replayFloorSeq: 0 });
    expect(pointer.resumeCandidate()).toBeNull();
    expect(warnings.some((msg) => msg.includes('vanished'))).toBe(true);
  });

  it('advances epoch and replay floor atomically while preserving the old session file', () => {
    const dir = fixture();
    const oldFile = join(dir, 'old.jsonl');
    const freshFile = join(dir, 'fresh.jsonl');
    writeFileSync(oldFile, 'old bytes\n');
    writeFileSync(freshFile, '');
    const pointer = new GruSessionPointer(dir);
    pointer.record(oldFile);
    expect(pointer.advance(freshFile, 41)).toMatchObject({
      sessionFile: freshFile,
      epoch: 1,
      replayFloorSeq: 41,
    });
    expect(new GruSessionPointer(dir).current()).toMatchObject({ epoch: 1, replayFloorSeq: 41 });
    expect(pointer.resumeCandidate()).toBe(freshFile);
  });

  it('two successive resets advance safely and a later record preserves the boundary', () => {
    const dir = fixture();
    const files = ['one', 'two', 'three'].map((name) => join(dir, `${name}.jsonl`));
    for (const file of files) writeFileSync(file, '');
    const pointer = new GruSessionPointer(dir);
    pointer.record(files[0]!);
    pointer.advance(files[1]!, 10);
    expect(pointer.advance(files[2]!, 20)).toMatchObject({ epoch: 2, replayFloorSeq: 20 });
    expect(pointer.record(files[2]!)).toMatchObject({ epoch: 2, replayFloorSeq: 20 });
  });

  it('a corrupt pointer fails loud — never guesses', () => {
    const dir = fixture();
    writeFileSync(join(dir, SESSION_STATE_NAME), '{"sessionFile":', 'utf-8');
    expect(() => new GruSessionPointer(dir).resumeCandidate()).toThrowError(/unreadable/);
    writeFileSync(join(dir, SESSION_STATE_NAME), '{"other":1}\n', 'utf-8');
    expect(() => new GruSessionPointer(dir).resumeCandidate()).toThrowError(/no sessionFile/);
    writeFileSync(
      join(dir, SESSION_STATE_NAME),
      `${JSON.stringify({ sessionFile: join(dir, 'x.jsonl'), epoch: null, replayFloorSeq: null })}\n`,
      'utf-8',
    );
    expect(() => new GruSessionPointer(dir).current()).toThrowError(/invalid epoch\/replay floor/);
    writeFileSync(
      join(dir, SESSION_STATE_NAME),
      `${JSON.stringify({ sessionFile: join(dir, 'x.jsonl'), epoch: 1 })}\n`,
      'utf-8',
    );
    expect(() => new GruSessionPointer(dir).current()).toThrowError(/incomplete epoch\/replay floor/);
  });
});
