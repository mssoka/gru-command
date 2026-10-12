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
