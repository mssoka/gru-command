import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JournalStore, JOURNAL_BODY_MAX_CHARS } from '../src/lessons/journal.js';
import { JournalError } from '../src/lessons/types.js';

/**
 * Journal (Book of Lessons capture): append-only, deliberate, one JSONL
 * file per source-day; the dream cursor walks seq.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpJournal(): { dir: string; journal: JournalStore } {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-journal-'));
  cleanupDirs.push(dir);
  return { dir, journal: new JournalStore(join(dir, 'journal')) };
}

describe('journal store', () => {
  it('appends entries to per-day files and lists them oldest first with stable ids', () => {
    const { journal } = tmpJournal();
    const first = journal.append(
      { kind: 'finding', source: 'gru', tags: ['repo:x'], body: 'the first finding' },
      new Date('2026-09-23T18:22:31.000Z'),
    );
    const second = journal.append(
      { kind: 'observation', source: 'minion:job-1', tags: [], body: 'the second entry' },
      new Date('2026-09-24T09:00:00.000Z'),
    );
    expect(first).toEqual({
      seq: 1,
      id: 'j-1',
      ts: '2026-09-23T18:22:31.000Z',
      kind: 'finding',
      source: 'gru',
      tags: ['repo:x'],
      body: 'the first finding',
    });
    expect(second.seq).toBe(2);
    expect(second.id).toBe('j-2');
    expect(journal.list()).toEqual([first, second]);
    expect(journal.latestSeq()).toBe(2);

    // One file per source-day, append-only.
    const day1 = readFileSync(join(journal.dir, '2026-09-23.jsonl'), 'utf-8').trim().split('\n');
    const day2 = readFileSync(join(journal.dir, '2026-09-24.jsonl'), 'utf-8').trim().split('\n');
    expect(day1).toHaveLength(1);
    expect(day2).toHaveLength(1);
    expect(JSON.parse(day1[0]!)).toMatchObject({ id: 'j-1', source: 'gru' });
  });

  it('honors after/limit for the dream cursor and resumes seq from disk', () => {
    const { dir, journal } = tmpJournal();
    journal.append({ kind: 'finding', source: 'gru', body: 'one' }, new Date('2026-09-23T00:00:00.000Z'));
    journal.append({ kind: 'finding', source: 'gru', body: 'two' }, new Date('2026-09-23T01:00:00.000Z'));
    journal.append({ kind: 'finding', source: 'gru', body: 'three' }, new Date('2026-09-23T02:00:00.000Z'));
    expect(journal.list({ after: 1, limit: 1 }).map((entry) => entry.body)).toEqual(['two']);
    expect(journal.list({ after: 1 }).map((entry) => entry.body)).toEqual(['two', 'three']);

    const reopened = new JournalStore(journal.dir);
    const fourth = reopened.append(
      { kind: 'ruling', source: 'owner', body: 'four' },
      new Date('2026-09-23T03:00:00.000Z'),
    );
    expect(fourth.seq).toBe(4);
    expect(reopened.latestSeq()).toBe(4);
    expect(dir.length).toBeGreaterThan(0);
  });

  it('validates kind, source, body, and tags loudly', () => {
    const { journal } = tmpJournal();
    expect(() =>
      journal.append({ kind: 'gossip' as never, source: 'gru', body: 'x' }),
    ).toThrowError(JournalError);
    expect(() => journal.append({ kind: 'finding', source: 'Gru!', body: 'x' })).toThrowError(
      /journal source must match/,
    );
    expect(() => journal.append({ kind: 'finding', source: 'gru', body: '   ' })).toThrowError(
      /journal body must be a non-empty string/,
    );
    expect(() =>
      journal.append({ kind: 'finding', source: 'gru', body: 'x'.repeat(JOURNAL_BODY_MAX_CHARS + 1) }),
    ).toThrowError(/exceeds 16000 characters/);
    expect(() =>
      journal.append({ kind: 'finding', source: 'gru', body: 'x', tags: ['ok', ''] }),
    ).toThrowError(/tags must be non-empty strings/);
    expect(() =>
      journal.append({
        kind: 'finding',
        source: 'gru',
        body: 'x',
        tags: Array.from({ length: 17 }, (_, index) => `tag-${index}`),
      }),
    ).toThrowError(/tags exceed 16 entries/);
  });

  it('fails loud on a malformed persisted line, naming the file and line', () => {
    const { dir, journal } = tmpJournal();
    journal.append({ kind: 'finding', source: 'gru', body: 'good line' });
    const file = join(journal.dir, '2026-09-23.jsonl');
    writeFileSync(file, 'not json at all\n', 'utf-8');
    expect(() => journal.list()).toThrowError(/2026-09-23\.jsonl:1 is not valid JSON/);
    expect(dir.length).toBeGreaterThan(0);
  });

  it('keeps a single entry with a colon-bearing source (minion:<job>) verbatim', () => {
    const { journal } = tmpJournal();
    const entry = journal.append({
      kind: 'observation',
      source: 'minion:job-book-of-lessons',
      body: 'the worktree survived the sweep',
    });
    expect(entry.source).toBe('minion:job-book-of-lessons');
    expect(journal.list()[0]).toEqual(entry);
  });
});
