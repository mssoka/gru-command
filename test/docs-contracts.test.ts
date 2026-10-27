import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BACKUP_MAX_AGE_MS } from '../src/sessions/store.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = (name: string): string => readFileSync(join(root, 'docs', name), 'utf-8').replace(/\s+/g, ' ');
/** Derived from the code's own default, never a hand-maintained literal. */
const MAX_AGE_DAYS = BACKUP_MAX_AGE_MS / (24 * 60 * 60 * 1000);

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

  it('OPERATIONS.md states changed-only copies, the missing-backup repair, the age and the floor', () => {
    const ops = section(doc('OPERATIONS.md'), '## Backups & restore', '## Install rehearsal');
    expect(ops).toContain('copies only');
    expect(ops).toContain('backup-baseline.json');
    // The missing-recorded-generation repair (a reclaim must not silence backups):
    expect(ops).toContain('recorded generation has gone missing');
    // The count rule is scoped to a live transcript; the dead-source rule stays:
    expect(ops).toContain('Per live transcript the newest 24 backups are kept');
    expect(ops).toContain('A transcript that is gone keeps its newest backup while its older generations age out');
    // The fingerprint (and its metadata-touch consequence) is stated, not implied:
    expect(ops).toContain('metadata-only touch costs one harmless extra copy');
    expect(ops).toContain('its recorded entry stays in the baseline');
    // The chosen maximum age, derived from the code's default:
    expect(ops).toContain(`ISO hour ended more than ${MAX_AGE_DAYS} days ago`);
    expect(ops).toContain('never the generation the baseline records');
    // The retired count-only and every-pass wording is gone from this section.
    expect(ops).not.toContain('newest 24 per file');
    expect(ops).not.toContain('hourly rolling copies');
    expect(ops).not.toContain('Per source: the newest 24 backups');
  });

  it('RUNTIMES.md states the baseline shape, changed-only copies and both prune rules', () => {
    const runtimes = section(doc('RUNTIMES.md'), '## Session store (SPEC ruling 12)', '### Emergency console');
    expect(runtimes).toContain('backup-baseline.json');
    // The recorded baseline shape, field by field:
    expect(runtimes).toContain('"version":1');
    expect(runtimes).toContain('"size":N');
    expect(runtimes).toContain('"mtimeMs":M');
    expect(runtimes).toContain('"ctimeMs":C');
    expect(runtimes).toContain('"backup":"<generation file name>"');
    expect(runtimes).toContain('unchanged sources are not copied at all');
    expect(runtimes).toContain('a live source whose recorded generation is gone is copied again');
    expect(runtimes).toContain('newest 24 generations of a live source');
    expect(runtimes).toContain(`ISO hour ended more than ${MAX_AGE_DAYS} days ago`);
    expect(runtimes).toContain("never a source's newest generation");
    expect(runtimes).toContain('a source that is gone keeps its newest backup while its older generations age out');
    expect(runtimes).toContain('never a generation the baseline records');
    expect(runtimes).toContain('sampled when the pass scans the source');
    expect(runtimes).toContain('the entry recorded for a source that is gone stays in the baseline');
    // The retired every-pass copy and count-only statements are gone.
    expect(runtimes).not.toContain('tracked session files are copied hourly');
    expect(runtimes).not.toContain('the newest 24 backups are retained');
  });

  it('SPEC.md ruling 12 states changed-only copying, the repair and both prune rules', () => {
    const spec = section(doc('SPEC.md'), '12. **Session forensics preserved:**', '13. **Escalations');
    expect(spec).toContain('copies only');
    expect(spec).toContain('size/mtime/ctime fingerprint');
    expect(spec).toContain('backup-baseline.json');
    expect(spec).toContain("re-creates a live file's missing recorded backup");
    // Both prune rules, their scopes and the floors:
    expect(spec).toContain('newest 24 generations of a live source');
    expect(spec).toContain(`ISO hour ended more than ${MAX_AGE_DAYS} days ago`);
    expect(spec).toContain('never the generation the baseline records');
    expect(spec).not.toContain('hourly rolling backup;');
  });
});
