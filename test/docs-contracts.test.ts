import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = (name: string): string => readFileSync(join(root, 'docs', name), 'utf-8').replace(/\s+/g, ' ');

describe('docs contracts', () => {
  it('BOARD.md promises no age-based owner escalation (#108)', () => {
    const board = doc('BOARD.md');
    expect(board).not.toMatch(/left unresolved \d+ minutes/i);
    expect(board).not.toMatch(/\d+ minutes after delivery/i);
    expect(board).toContain('There is no timed escalation');
  });

  it('CHAT.md scopes the notice frame consistently: notification routing vs operational events (#123)', () => {
    const chat = doc('CHAT.md');
    expect(chat).toContain('the only *notification-routing* kind');
    expect(chat).toContain('operational service events');
    expect(chat).toContain('**Notice routing.**');
    expect(chat).toContain('about (1) only');
    expect(chat).not.toMatch(/needs-owner items \("🔔 For you: …"\) and supervisor restart notices/);
  });
});

describe('docs contracts: decisions', () => {
  it('records the #126 acceptance, #99 actorship and #100 idempotency contracts', () => {
    expect(doc('CHAT.md')).toContain('Untrusted metadata: acceptance record (#126)');
    expect(doc('BOARD.md')).toContain('Actorship (decision #99');
    expect(doc('BOARD.md')).toContain('idempotency_conflict');
  });
});

describe('docs contracts: session backup policy', () => {
  /** Whitespace-normalized slice between two anchors — per-site, never page-wide. */
  function section(text: string, from: string, to: string): string {
    const start = text.indexOf(from);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf(to, start + from.length);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end);
  }

  it('OPERATIONS.md states changed-only copies and the last-snapshot floor', () => {
    const ops = section(doc('OPERATIONS.md'), '## Backups & restore', '## Install rehearsal');
    expect(ops).toContain('copies only');
    expect(ops).toContain('backup-baseline.json');
    expect(ops).toContain('never the newest one');
    // The retired count-only wording is gone from this section.
    expect(ops).not.toContain('newest 24 per file');
    expect(ops).not.toContain('hourly rolling copies');
  });

  it('RUNTIMES.md states the baseline file, the maximum age and both prune rules', () => {
    const runtimes = section(doc('RUNTIMES.md'), '## Session store (SPEC ruling 12)', '### Emergency console');
    expect(runtimes).toContain('backup-baseline.json');
    expect(runtimes).toContain('7 days');
    expect(runtimes).toContain("never a source's newest generation");
    // The retired every-pass copy and count-only statements are gone.
    expect(runtimes).not.toContain('tracked session files are copied hourly');
    expect(runtimes).not.toContain('the newest 24 backups are retained');
  });

  it('SPEC.md ruling 12 states changed-only copying and the newest-generation floor', () => {
    const spec = section(doc('SPEC.md'), '12. **Session forensics preserved:**', '13. **Escalations');
    expect(spec).toContain('copies only');
    expect(spec).toContain('backup-baseline.json');
    expect(spec).toContain("never prunes a source's newest generation");
    expect(spec).not.toContain('hourly rolling backup;');
  });
});
