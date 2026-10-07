import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, JobView, PipelineEntryView } from './board-protocol.js';
import {
  boardSections,
  pipelineStateLabel,
  pipelineStateTone,
  pipelineWindow,
  previewWindow,
  sectionNav,
  settledJobs,
  settledPreview,
  IN_FLIGHT_PREVIEW_SIZE,
  PIPELINE_PREVIEW_SIZE,
  SECTION_LABELS,
  SECTION_ORDER,
  SECTION_TARGET_IDS,
  SETTLED_PREVIEW_SIZE,
} from './board-sections.js';

const T0 = '2026-10-03T00:00:00.000Z';

function job(id: string, status: string, updatedAt = T0): JobView {
  return {
    id,
    repo: 'demo',
    title: `Job ${id}`,
    status,
    updatedAt,
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: null,
    lastAgentActivity: null,
  };
}

function pipelineEntry(id: string, overrides: Partial<PipelineEntryView> = {}): PipelineEntryView {
  return {
    id,
    repo: 'demo',
    title: `Entry ${id}`,
    priority: 5,
    enqueueSeq: 1,
    state: 'waiting',
    reason: 'waiting for something',
    queuedAt: T0,
    ...overrides,
  };
}

function snapshot(options: { jobs?: readonly JobView[]; pipeline?: BoardSnapshot['pipeline'] } = {}): BoardSnapshot {
  return {
    repos: [{ name: 'demo', jobs: options.jobs ?? [] }],
    agents: [],
    notifications: [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'sections-test',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
    ...(options.pipeline !== undefined ? { pipeline: options.pipeline } : {}),
  };
}

describe('board sections — approved order and counts', () => {
  it('orders the six sections For you → In flight → Pipeline → For Gru → Settled → Cold', () => {
    expect(SECTION_ORDER).toEqual(['for-you', 'in-flight', 'pipeline', 'for-gru', 'settled', 'cold']);
    expect(SECTION_ORDER.map((id) => SECTION_LABELS[id])).toEqual([
      'For you',
      'In flight',
      'Pipeline',
      'For Gru',
      'Settled',
      'Cold',
    ]);
  });

  it('derives uncapped counts from the snapshot (never a preview window)', () => {
    const jobs = [
      ...Array.from({ length: 7 }, (_, index) => job(`flight-${index}`, 'in-review')),
      job('machine', 'blocked'),
      ...Array.from({ length: 5 }, (_, index) => job(`settled-${index}`, 'delivered', `2026-10-0${index + 1}T00:00:00.000Z`)),
      ...Array.from({ length: 4 }, (_, index) => job(`cold-${index}`, 'done')),
    ];
    const sections = boardSections(
      snapshot({
        jobs,
        pipeline: {
          entries: Array.from({ length: 6 }, (_, index) => pipelineEntry(`p${index}`)),
          pending: 6,
        },
      }),
    );
    expect(sections.counts['in-flight']).toBe(7);
    expect(sections.counts['for-gru']).toBe(1);
    expect(sections.counts.settled).toBe(5);
    expect(sections.counts.cold).toBe(4);
    expect(sections.counts.pipeline).toBe(6);
    const nav = sectionNav(sections.counts, sections.pipelineAvailable);
    expect(nav.map((row) => row.id)).toEqual([...SECTION_ORDER]);
    expect(nav.map((row) => row.count)).toEqual([0, 7, 6, 1, 5, 4]);
    expect(nav.map((row) => row.href)).toEqual(SECTION_ORDER.map((id) => `#${SECTION_TARGET_IDS[id]}`));
    expect(nav.every((row) => row.counted)).toBe(true);
  });

  it('keeps binned rows in the COLD band and its complete count — filtering happens at render, never in the count', () => {
    const sections = boardSections(
      snapshot({
        jobs: [
          job('cold-done', 'done'),
          job('cold-binned', 'binned'),
          job('cold-parked', 'parked'),
        ],
      }),
    );
    expect(sections.counts.cold).toBe(3);
    const coldIds = (sections.bands.get('cold') ?? []).map((entry) => entry.job.id).sort();
    expect(coldIds).toEqual(['cold-binned', 'cold-done', 'cold-parked']);
    // No other section silently absorbs (or drops) the discarded lane.
    expect(sections.counts['in-flight']).toBe(0);
    expect(sections.counts.settled).toBe(0);
    expect(sections.counts['for-gru']).toBe(0);
    const nav = sectionNav(sections.counts, sections.pipelineAvailable);
    expect(nav.find((row) => row.id === 'cold')?.count).toBe(3);
  });

  it('marks the pipeline count unknown (not a false zero) when the server ships no block', () => {
    const sections = boardSections(snapshot());
    expect(sections.pipelineAvailable).toBe(false);
    expect(sections.pipelineEntries).toEqual([]);
    const nav = sectionNav(sections.counts, sections.pipelineAvailable);
    expect(nav.find((row) => row.id === 'pipeline')?.counted).toBe(false);
  });

  it('counts pending owner actions from the same projection the band renders', () => {
    const notifications = [
      {
        id: 'n1',
        ts: T0,
        kind: 'test.notice',
        routing: 'needs-owner' as const,
        severity: 'info' as const,
        title: 'Owner stop',
        detail: null,
        agentId: null,
        shownAt: null,
        ackedAt: null,
        resolvedAt: null,
        resolvedBy: null,
      },
    ];
    const base = snapshot();
    const sections = boardSections({ ...base, notifications });
    expect(sections.counts['for-you']).toBe(1);
  });
});

describe('board sections — bounded reversible previews', () => {
  it('windows 0/1/3/5/6/many at the approved limits and reports the hidden tail', () => {
    const rows = (n: number): number[] => Array.from({ length: n }, (_, index) => index);
    for (const n of [0, 1, 3, 5]) {
      expect(previewWindow(rows(n), IN_FLIGHT_PREVIEW_SIZE, false)).toEqual({ rows: rows(n), hidden: 0 });
    }
    expect(previewWindow(rows(6), IN_FLIGHT_PREVIEW_SIZE, false)).toEqual({ rows: rows(5), hidden: 1 });
    expect(previewWindow(rows(26), IN_FLIGHT_PREVIEW_SIZE, false)).toEqual({ rows: rows(5), hidden: 21 });
    expect(previewWindow(rows(26), IN_FLIGHT_PREVIEW_SIZE, true)).toEqual({ rows: rows(26), hidden: 0 });
    expect(previewWindow(rows(3), SETTLED_PREVIEW_SIZE, false).hidden).toBe(0);
    expect(previewWindow(rows(5), SETTLED_PREVIEW_SIZE, false)).toEqual({ rows: rows(3), hidden: 2 });
    expect(previewWindow(rows(5), SETTLED_PREVIEW_SIZE, true).hidden).toBe(0);
  });

  it('keeps the SERVER pipeline order in the preview and at full expansion', () => {
    const entries = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) =>
      pipelineEntry(id, { priority: index % 2, enqueueSeq: index + 1 }),
    );
    const preview = pipelineWindow(entries, false);
    expect(preview.rows.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(preview.hidden).toBe(1);
    expect(pipelineWindow(entries, true).rows.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(PIPELINE_PREVIEW_SIZE).toBe(5);
    expect(IN_FLIGHT_PREVIEW_SIZE).toBe(5);
    expect(SETTLED_PREVIEW_SIZE).toBe(3);
  });

  it('orders the settled preview newest-first with a stable id tiebreak', () => {
    const entries = [
      { job: job('old', 'delivered', '2026-10-01T00:00:00.000Z'), band: 'settled' as const, stale: false },
      { job: job('new', 'delivered', '2026-10-03T00:00:00.000Z'), band: 'settled' as const, stale: false },
      { job: job('mid', 'delivered', '2026-10-02T00:00:00.000Z'), band: 'settled' as const, stale: false },
    ];
    expect(settledJobs(entries).map((entry) => entry.job.id)).toEqual(['new', 'mid', 'old']);
    const window = settledPreview(settledJobs(entries), false);
    expect(window.rows.map((entry) => entry.job.id)).toEqual(['new', 'mid', 'old']);
  });

  it('maps every pipeline state to one honest label/tone pair', () => {
    expect(pipelineStateLabel({ state: 'ready' })).toBe('ready');
    expect(pipelineStateLabel({ state: 'waiting' })).toBe('waiting');
    expect(pipelineStateLabel({ state: 'admitting' })).toBe('admitting');
    expect(pipelineStateLabel({ state: 'failed' })).toBe('failed');
    expect(pipelineStateTone({ state: 'ready' })).toBe('pp-chip--done');
    expect(pipelineStateTone({ state: 'failed' })).toBe('pp-chip--alert');
    expect(pipelineStateTone({ state: 'waiting' })).toBe('pp-chip--park');
  });
});
