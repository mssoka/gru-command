import { describe, expect, it } from 'vitest';
import { bucketSnapshot } from './board-bands.js';
import { familyStatusBreakdown, isLiveMegaminion, jobFamilies } from './board-family.js';
import { boardKpis } from './board-kpi.js';
import type { BoardSnapshot, JobView } from './board-protocol.js';
import { boardSections, snapshotSections } from './board-sections.js';

const NOW = Date.parse('2026-10-07T20:10:00.000Z');

function job(id: string, overrides: Partial<JobView> = {}): JobView {
  return {
    id,
    repo: 'demo',
    title: id,
    status: 'working',
    updatedAt: '2026-10-07T20:09:00.000Z',
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: { branch: `gru/${id}`, sha: 'c3f3b35', status: 'active', createdAt: '2026-10-07T20:00:00.000Z' },
    lastAgentActivity: '2026-10-07T20:09:30.000Z',
    ...overrides,
  };
}

function snapshotOf(
  jobs: readonly JobView[],
  extra: { agents?: readonly unknown[]; notifications?: readonly unknown[] } = {},
): BoardSnapshot {
  return {
    repos: [{ name: 'demo', jobs }],
    agents: extra.agents ?? [],
    notifications: extra.notifications ?? [],
  } as unknown as BoardSnapshot;
}

/** The screenshot this feature answers: two implementation heists, one
 * of which commissioned three specialist reviewers. */
const IMPL = job('impl');
const OTHER = job('other');
const BLIND = job('rev-blind', { parentJobId: 'impl', lane: { ...IMPL.lane!, createdAt: '2026-10-07T20:05:57.000Z' } });
const EDGE = job('rev-edge', { parentJobId: 'impl', lane: { ...IMPL.lane!, createdAt: '2026-10-07T20:06:02.000Z' } });
const VERIFY = job('rev-verify', {
  parentJobId: 'impl',
  status: 'delivered',
  lane: { ...IMPL.lane!, createdAt: '2026-10-07T20:06:08.000Z' },
});

describe('job families (megaminions)', () => {
  it('nests children under a present parent, oldest lane first', () => {
    const families = jobFamilies([VERIFY, IMPL, EDGE, OTHER, BLIND]);
    expect(families.topLevel.map((entry) => entry.id)).toEqual(['impl', 'other']);
    expect(families.childrenByParent.get('impl')?.map((entry) => entry.id)).toEqual(['rev-blind', 'rev-edge', 'rev-verify']);
    expect(families.surfacedParents.size).toBe(0);
  });

  it('keeps an orphan (parent not on the board) and a self-parent top-level', () => {
    const orphan = job('orphan', { parentJobId: 'purged' });
    const self = job('self', { parentJobId: 'self' });
    const families = jobFamilies([orphan, self]);
    expect(families.topLevel.map((entry) => entry.id)).toEqual(['orphan', 'self']);
    expect(families.childrenByParent.size).toBe(0);
  });

  it('treats a missing parentJobId (older server) as top-level', () => {
    const legacy = job('legacy');
    expect('parentJobId' in legacy).toBe(false);
    expect(jobFamilies([legacy]).topLevel).toEqual([legacy]);
  });

  it('renders a grandchild or a parent cycle flat instead of losing it inside a nested row', () => {
    const grandchild = job('rev-of-rev', { parentJobId: 'rev-blind' });
    const flat = jobFamilies([IMPL, BLIND, grandchild]);
    expect(flat.topLevel.map((entry) => entry.id)).toEqual(['impl', 'rev-of-rev']);
    expect(flat.childrenByParent.get('impl')?.map((entry) => entry.id)).toEqual(['rev-blind']);
    const left = job('cycle-a', { parentJobId: 'cycle-b' });
    const right = job('cycle-b', { parentJobId: 'cycle-a' });
    expect(jobFamilies([left, right]).topLevel.map((entry) => entry.id)).toEqual(['cycle-a', 'cycle-b']);
  });

  it('surfaces a child the predicate keeps out, remembering its parent', () => {
    const blocked = job('rev-blocked', { parentJobId: 'impl', status: 'blocked' });
    const families = jobFamilies([IMPL, blocked, BLIND], (entry, parent) => entry.status === 'blocked' && parent.id === 'impl');
    expect(families.topLevel.map((entry) => entry.id)).toEqual(['impl', 'rev-blocked']);
    expect(families.surfacedParents.get('rev-blocked')?.id).toBe('impl');
    expect(families.childrenByParent.get('impl')?.map((entry) => entry.id)).toEqual(['rev-blind']);
  });

  it('splits live from concluded specialists and summarises the family by status', () => {
    expect([BLIND, EDGE, VERIFY].filter(isLiveMegaminion).map((entry) => entry.id)).toEqual(['rev-blind', 'rev-edge']);
    for (const status of ['delivered', 'done', 'merged', 'binned']) expect(isLiveMegaminion(job('x', { status }))).toBe(false);
    for (const status of ['dispatched', 'working', 'in-review', 'parked']) expect(isLiveMegaminion(job('x', { status }))).toBe(true);
    expect(familyStatusBreakdown([BLIND, EDGE, VERIFY])).toEqual([
      { status: 'working', count: 2 },
      { status: 'delivered', count: 1 },
    ]);
  });
});

describe('heist counts exclude nested megaminions', () => {
  const snapshot = snapshotOf([IMPL, OTHER, BLIND, EDGE, VERIFY]);

  it('bands only the heists', () => {
    const banded = bucketSnapshot(snapshot, { now: NOW }).flatMap((group) => group.jobs.map((entry) => entry.job.id));
    expect(banded.sort()).toEqual(['impl', 'other']);
  });

  it('section counts: 2 in flight, the delivered reviewer never lands in Settled', () => {
    const sections = boardSections(snapshot, NOW);
    expect(sections.counts['in-flight']).toBe(2);
    expect(sections.counts.settled).toBe(0);
    const nested = sections.children.get('impl') ?? [];
    expect(nested.map((entry) => [entry.job.id, entry.band])).toEqual([
      ['rev-blind', 'in-flight'],
      ['rev-edge', 'in-flight'],
      ['rev-verify', 'settled'],
    ]);
  });

  it('a NEEDS-YOU megaminion stays surfaced (and counted) in For Gru', () => {
    const blocked = job('rev-blocked', { parentJobId: 'impl', status: 'blocked' });
    const sections = boardSections(snapshotOf([IMPL, blocked]), NOW);
    expect(sections.counts['for-gru']).toBe(1);
    expect(sections.bands.get('needs-you')?.map((entry) => entry.job.id)).toEqual(['rev-blocked']);
    expect(sections.surfacedParents.get('rev-blocked')?.id).toBe('impl');
    expect(sections.children.has('impl')).toBe(false);
  });

  it('a working megaminion with an unacked action-required alert surfaces in For Gru', () => {
    const alerted = snapshotOf([IMPL, BLIND], {
      agents: [{ id: 'blind-minion', role: 'minion', state: 'idle', jobId: 'rev-blind', roundId: null }],
      notifications: [
        {
          id: 'n1',
          ts: '2026-10-07T20:09:00.000Z',
          kind: 'review-escalation',
          routing: 'action-required',
          severity: 'error',
          title: 'reviewer needs a decision',
          detail: '',
          agentId: 'blind-minion',
          shownAt: null,
          ackedAt: null,
          resolvedAt: null,
          resolvedBy: null,
        },
      ],
    });
    const sections = boardSections(alerted, NOW);
    expect(sections.bands.get('needs-you')?.map((entry) => entry.job.id)).toEqual(['rev-blind']);
    expect(sections.counts['for-gru']).toBe(1);
    expect(sections.surfacedParents.get('rev-blind')?.id).toBe('impl');
    expect(sections.children.has('impl')).toBe(false);
  });

  it('running specialists of a heist that is not in flight surface in their own band; finished ones stay nested', () => {
    // The parent minion went quiet past the stall window → its heist sank
    // to COLD (collapsed by default); its reviewers are still working.
    const quietParent = job('impl', { lastAgentActivity: '2026-10-07T18:00:00.000Z', lane: { ...IMPL.lane!, createdAt: '2026-10-07T18:00:00.000Z' } });
    const sections = boardSections(snapshotOf([quietParent, BLIND, EDGE, VERIFY]), NOW);
    expect(sections.bands.get('cold')?.map((entry) => entry.job.id)).toEqual(['impl']);
    expect(sections.bands.get('in-flight')?.map((entry) => entry.job.id).sort()).toEqual(['rev-blind', 'rev-edge']);
    expect(sections.surfacedParents.get('rev-edge')?.id).toBe('impl');
    expect(sections.children.get('impl')?.map((entry) => entry.job.id)).toEqual(['rev-verify']);
    // A delivered heist (Settled) surfaces its running reviewer too.
    const delivered = boardSections(snapshotOf([job('impl', { status: 'delivered' }), BLIND]), NOW);
    expect(delivered.bands.get('in-flight')?.map((entry) => entry.job.id)).toEqual(['rev-blind']);
  });

  it('the HEISTS tracker counts the same top-level rows the sections hold', () => {
    const kpis = boardKpis(snapshot, new Date(NOW), snapshotSections(snapshot, NOW).topLevel);
    expect(kpis.jobs.total).toBe(2);
    expect(kpis.jobs.working).toBe(2);
    const blocked = job('rev-blocked', { parentJobId: 'impl', status: 'blocked' });
    const withSurfaced = snapshotOf([IMPL, OTHER, BLIND, blocked]);
    const sections = snapshotSections(withSurfaced, NOW);
    const rows = [...sections.bands.values()].reduce((sum, group) => sum + group.length, 0);
    expect(boardKpis(withSurfaced, new Date(NOW), sections.topLevel).jobs.total).toBe(rows);
    expect(rows).toBe(3);
  });
});
