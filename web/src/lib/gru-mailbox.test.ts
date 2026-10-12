import { describe, expect, it } from 'vitest';
import { boardSections, sectionNav } from './board-sections.js';
import { isValidSnapshot, parseBoardServerFrame } from './board-protocol.js';
import type { BoardSnapshot, JobView, MailboxView } from './board-protocol.js';

const job = { id: 'blocked', repo: 'r', title: 'blocked child', status: 'blocked', updatedAt: '2026-10-11T00:00:00.000Z', prUrl: null, prState: null, baseBranch: null, note: null, rounds: [], lane: null, lastAgentActivity: null, parentJobId: null } as JobView;
function snapshot(mailbox?: MailboxView): BoardSnapshot {
  return { repos: [{ name: 'r', jobs: [job] }], agents: [], notifications: [], decisions: { enabled: false, status: 'disabled', reason: 'disabled', model: 'm', endpoint: 'https://example.com', credentialPresent: false, credentialSource: 'none', checkedAt: null, incarnation: 'test', generation: 0 }, unackedActionRequired: 2, unackedNeedsOwner: 0, wakes: { count: 0, lastAt: null }, ...(mailbox === undefined ? {} : { mailbox }) };
}
const mailbox: MailboxView = { items: [{ id: 'job:blocked', subject: 'job:blocked', jobId: 'blocked', kind: 'job', title: 'blocked child', reasons: [{ label: 'blocked', signal: 'blocked', basis: 'reason-basis' }], basis: 'basis', state: 'waiting', owner: 'owner', disposition: null, receipt: null, notificationIds: [], producerOwned: false, references: [], restrictions: ['owner stop'], attentionKey: 'attention' }], counts: { threads: 1, incidents: 0, notifications: 0, needsGru: 0 } };
describe('shared server FOR GRU membership', () => {
  it('never guesses eligibility from blocked jobs when mailbox is absent', () => {
    const sections = boardSections(snapshot());
    expect(sections.counts['for-gru']).toBe(0);
    expect(sectionNav(sections.counts, sections.pipelineAvailable, sections.mailboxAvailable).find((row) => row.id === 'for-gru')?.counted).toBe(false);
  });
  it('uses server membership and disposition, independent of notifications', () => {
    const sections = boardSections(snapshot(mailbox));
    expect(sections.bands.get('needs-you')?.map((row) => row.job.id)).toEqual(['blocked']);
    expect(sections.counts['for-gru']).toBe(1);
    expect(sections.mailbox?.items[0]?.state).toBe('waiting');
  });
  it.each(['kind', 'state', 'reference.kind', 'disposition.state', 'disposition.reference.kind', 'receipt.source', 'severity'])('G21 rejects coerced mailbox enum %s at snapshot and frame boundaries', (field) => {
    const item = {
      ...mailbox.items[0]!,
      severity: 'error',
      references: [{ kind: 'decision', id: 'decision-1' }],
      disposition: { basis: 'basis', state: 'waiting', owner: 'owner', detail: 'owner ruling', recordedAt: '2026-10-11T00:00:00.000Z', dependency: 'permission', recheckAt: '2026-10-12T00:00:00.000Z', references: [{ kind: 'decision', id: 'decision-1' }] },
      receipt: { basis: 'basis', attentionKey: 'attention', deliveryId: 'delivery-1', receivedAt: '2026-10-11T00:00:00.000Z', source: 'chat' },
    };
    const valid = { ...snapshot(), mailbox: { ...mailbox, items: [item] } };
    expect(isValidSnapshot(valid)).toBe(true);
    const path = field === 'reference.kind' ? ['references', '0', 'kind']
      : field === 'disposition.reference.kind' ? ['disposition', 'references', '0', 'kind'] : field.split('.');
    for (const transform of [(value: unknown) => [value], (value: unknown) => ({ toString: () => value })]) {
      const malformed = structuredClone(valid);
      let target = malformed.mailbox.items[0] as unknown as Record<string, unknown>;
      for (const segment of path.slice(0, -1)) target = target[segment] as Record<string, unknown>;
      const key = path.at(-1)!;
      target[key] = transform(target[key]);
      expect(isValidSnapshot(malformed)).toBe(false);
      expect(parseBoardServerFrame({ type: 'board', snapshot: malformed })).toBeNull();
    }
  });

  it('G25 validates optional server-owned disposition provenance without coercion', () => {
    const disposition = { basis: 'basis', state: 'waiting', owner: 'owner', detail: 'source-derived', recordedAt: '2026-10-11T00:00:00.000Z', dependency: 'permission', recheckAt: '2026-10-12T00:00:00.000Z', references: [{ kind: 'obligation', id: 'debt' }] };
    const view = (source: unknown) => ({ ...snapshot(), mailbox: { ...mailbox, items: [{ ...mailbox.items[0]!, disposition: { ...disposition, sourceObligationId: source } }] } });
    expect(isValidSnapshot(view('debt'))).toBe(true);
    for (const source of ['', ' ', null, false, 1, ['debt'], { toString: () => 'debt' }]) {
      expect(isValidSnapshot(view(source))).toBe(false);
      expect(parseBoardServerFrame({ type: 'board', snapshot: view(source) })).toBeNull();
    }
  });

  it('rejects malformed mailbox evidence instead of guessing', () => {
    expect(isValidSnapshot(snapshot(mailbox))).toBe(true);
    expect(isValidSnapshot({ ...snapshot(mailbox), mailbox: { ...mailbox, items: [{ ...mailbox.items[0], basis: '' }] } })).toBe(false);
  });
});
