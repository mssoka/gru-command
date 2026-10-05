import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { DispatchService } from '../src/dispatch/service.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { extractLessonsBlock, createSessionLessonsCapture } from '../src/lessons/capture.js';
import { createReviewOutcomeCapture, REVIEW_FINDING_BODY_MAX_CHARS } from '../src/lessons/review-capture.js';
import { JournalStore } from '../src/lessons/journal.js';
import { LessonCaptureError } from '../src/lessons/types.js';
import type { BusEvent } from '../src/events/bus.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';

/**
 * Minion delivery-report capture: ONLY the last assistant message's opt-in
 * fenced `lessons` block is journaled (source minion:<job>). Everything
 * else in a session is ignored — the block is deliberate.
 */

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function sessionFile(path: string, assistantTexts: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', id: 'sess-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/demo' }),
    JSON.stringify({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'do the job', timestamp: 1000 },
    }),
  ];
  for (const [index, text] of assistantTexts.entries()) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `a${index}`,
        parentId: index === 0 ? 'u1' : `a${index - 1}`,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
          api: 'demo',
          provider: 'demo',
          model: 'demo',
          stopReason: 'stop',
          timestamp: 2000 + index,
        },
      }),
    );
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
}

const BLOCK_A = '```lessons\n{"kind":"finding","tags":["repo:x"],"body":"A lesson from the first report"}\n```';
const BLOCK_B =
  '```lessons\n{"kind":"observation","tags":["ops"],"body":"B lesson"}\n{"kind":"ruling","tags":[],"body":"B ruling"}\n```';

describe('minion lessons capture', () => {
  it('extracts the last fenced lessons block as JSONL drafts', () => {
    const drafts = extractLessonsBlock(`report text\n${BLOCK_A}\nmore text`);
    expect(drafts).toEqual([{ kind: 'finding', tags: ['repo:x'], body: 'A lesson from the first report' }]);
    expect(extractLessonsBlock('no block here')).toEqual([]);
    // The LAST block is the delivery report's opt-in.
    expect(extractLessonsBlock(`${BLOCK_A}\n${BLOCK_B}`)).toHaveLength(2);
  });

  it('rejects a malformed lessons block loudly', () => {
    expect(() => extractLessonsBlock('```lessons\nnot json\n```')).toThrowError(LessonCaptureError);
    expect(() =>
      extractLessonsBlock('```lessons\n{"kind":"gossip","body":"x"}\n```'),
    ).toThrowError(/kind must be one of/);
    expect(() => extractLessonsBlock('```lessons\n{"kind":"finding","body":""}\n```')).toThrowError(
      /body must be a non-empty string/,
    );
  });

  it('captures only the LAST assistant message into the journal with minion:<job> source', () => {
    const dir = tmpDir('gru-command-capture-');
    const journal = new JournalStore(join(dir, 'journal'));
    const session = join(dir, 'sessions', 'minion', 'job-1', 'sess.jsonl');
    sessionFile(session, ['older report without a block', `final report\n${BLOCK_B}`]);
    const capture = createSessionLessonsCapture({ journal });
    const count = capture.capture({ sessionFile: session, source: 'minion:job-1' });
    expect(count).toBe(2);
    const entries = journal.list();
    expect(entries.map((entry) => entry.source)).toEqual(['minion:job-1', 'minion:job-1']);
    expect(entries.map((entry) => entry.kind)).toEqual(['observation', 'ruling']);
    expect(entries[0]!.tags).toEqual(['ops']);
  });

  it('captures nothing from a session without a lessons block or without a session file', () => {
    const dir = tmpDir('gru-command-capture-none-');
    const journal = new JournalStore(join(dir, 'journal'));
    const session = join(dir, 'sess.jsonl');
    sessionFile(session, ['plain delivery report']);
    const capture = createSessionLessonsCapture({ journal });
    expect(capture.capture({ sessionFile: session, source: 'minion:job-2' })).toBe(0);
    expect(capture.capture({ sessionFile: null, source: 'minion:job-2' })).toBe(0);
    expect(journal.list()).toEqual([]);
  });

  it('wires capture into the dispatch settle path', async () => {
    const dir = tmpDir('gru-command-capture-dispatch-');
    const journal = new JournalStore(join(dir, 'journal'));
    const session = join(dir, 'sessions', 'minion', 'job-9', 'sess.jsonl');
    sessionFile(session, [`delivery\n${BLOCK_A}`]);
    const ledgerDb = new LedgerDb(join(dir, 'data'));
    const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
    const worktrees = new InMemoryWorktreePort(join(dir, 'wt'));
    const handle: AgentHandle = {
      role: 'minion',
      id: 'minion-1',
      sessionFile: session,
      capabilities: FAKE_CAPABILITIES,
      async prompt() {},
      async steer() {},
      async followUp() {},
      subscribe() {
        return () => {};
      },
      health() {
        return { state: 'idle', lastActivity: null, sessionFile: session };
      },
      async dispose() {},
    };
    const dispatch = new DispatchService({
      ledger,
      worktrees,
      spawner: async () => handle,
      lessonsCapture: createSessionLessonsCapture({ journal }),
    });
    try {
      const outcome = await dispatch.dispatch({
        jobId: 'job-9',
        repoPath: join(dir, 'repo'),
        title: 'capture me',
        briefing: 'deliver the thing',
      });
      expect(await outcome.settled).toEqual({ ok: true });
      expect(journal.list()).toHaveLength(1);
      expect(journal.list()[0]).toMatchObject({ source: 'minion:job-9', kind: 'finding' });
    } finally {
      ledgerDb.close();
    }
  });
});

/**
 * Perkins review outcome capture (issue #221): when a round posts a
 * verdict, each consolidated blocker becomes ONE deliberate journal
 * entry (source `perkins:<round>`), redacted and bounded, idempotent
 * per round across duplicate events and service restarts.
 */

function blockerFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: 'blocker',
    category: 'correctness',
    title: 'Off-by-one in the rollup',
    location: 'src/rollup.ts:42',
    evidence: 'the loop exits before the last row',
    detail: 'The rollup drops the last row of every batch.',
    recommended_fix: 'Use <= in the loop guard.',
    verification: { disposition: 'confirmed', evidence: 'reproduced', reason: 'plain from the diff' },
    sources: ['specialist'],
    roundOrigin: 1,
    ...overrides,
  };
}

function writeConsolidated(
  root: string,
  roundId: string,
  findings: readonly Record<string, unknown>[],
  repoPath = '/tmp/gru-command-demo',
): string {
  const directory = join(root, roundId);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'consolidated.json');
  writeFileSync(
    file,
    `${JSON.stringify({ schemaVersion: 3, canonicalVerdict: 'NEEDS CHANGES', findings, frozen: { repoPath } })}\n`,
    'utf-8',
  );
  return file;
}

function verdictEvent(roundId: string): BusEvent {
  return {
    seq: 1,
    ts: '2026-10-05T12:00:00.000Z',
    kind: 'round.verdict',
    agentId: null,
    jobId: 'job-1',
    roundId,
    lens: null,
    payload: { verdict: 'NEEDS CHANGES' },
  };
}

function captureHarness() {
  const dir = tmpDir('gru-command-review-capture-');
  const artifactRoot = join(dir, 'reviews');
  const journal = new JournalStore(join(dir, 'journal'));
  const bus = new EventBus({});
  const logs: [string, string, Record<string, unknown>][] = [];
  const stateFile = join(artifactRoot, '.review-capture-state.json');
  const stop = createReviewOutcomeCapture({
    bus,
    journal,
    artifactRoot,
    stateFile,
    log: (level, message, fields) => logs.push([level, message, fields ?? {}]),
  });
  return { dir, artifactRoot, journal, bus, logs, stateFile, stop };
}

describe('perkins review outcome capture', () => {
  it('journals one bounded, redacted finding entry per blocker with perkins:<round> source', () => {
    const h = captureHarness();
    writeConsolidated(h.artifactRoot, 'round-abc123', [
      blockerFixture(),
      blockerFixture({ severity: 'warning', title: 'a warning is not journaled' }),
      blockerFixture({ category: 'c'.repeat(80), title: 'second blocker' }),
    ]);
    h.bus.publish(verdictEvent('round-abc123'));
    const entries = h.journal.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'finding',
      source: 'perkins:round-abc123',
      tags: ['repo:gru-command-demo', 'review:blocker', 'category:correctness'],
      body: 'Off-by-one in the rollup — src/rollup.ts:42: The rollup drops the last row of every batch.',
    });
    // Tags stay inside the journal's 64-char bound even for an 80-char category.
    expect(entries[1]!.tags[2]!.length).toBe(64);
    expect(h.logs.every(([level]) => level !== 'error')).toBe(true);
  });

  it('is idempotent per round across duplicate events and capture restarts', () => {
    const h = captureHarness();
    writeConsolidated(h.artifactRoot, 'round-abc123', [blockerFixture()]);
    h.bus.publish(verdictEvent('round-abc123'));
    h.bus.publish(verdictEvent('round-abc123'));
    expect(h.journal.list()).toHaveLength(1);
    // A fresh capture over the same sidecar (service restart) is idempotent too.
    const resumed = createReviewOutcomeCapture({ bus: h.bus, journal: h.journal, artifactRoot: h.artifactRoot, stateFile: h.stateFile });
    h.bus.publish(verdictEvent('round-abc123'));
    expect(h.journal.list()).toHaveLength(1);
    resumed();
  });

  it('a verdict with no blockers marks the round captured and journals nothing', () => {
    const h = captureHarness();
    writeConsolidated(h.artifactRoot, 'round-clean', [blockerFixture({ severity: 'note' })]);
    h.bus.publish(verdictEvent('round-clean'));
    h.bus.publish(verdictEvent('round-clean'));
    expect(h.journal.list()).toEqual([]);
    expect(h.logs.every(([level]) => level !== 'error')).toBe(true);
  });

  it('a missing consolidated record fails loud, marks nothing, and a later event captures', () => {
    const h = captureHarness();
    h.bus.publish(verdictEvent('round-missing'));
    expect(h.journal.list()).toEqual([]);
    expect(h.logs.some(([level, , fields]) => level === 'error' && fields['round_id'] === 'round-missing')).toBe(true);
    // The record appears (e.g. the lead settled just after the verdict) — a
    // re-posted verdict retries instead of having been burned by the sidecar.
    writeConsolidated(h.artifactRoot, 'round-missing', [blockerFixture()]);
    h.bus.publish(verdictEvent('round-missing'));
    expect(h.journal.list()).toHaveLength(1);
  });

  it('redacts secrets and bounds the body of journaled findings', () => {
    const h = captureHarness();
    writeConsolidated(h.artifactRoot, 'round-secret', [
      blockerFixture({
        detail: `leaked key sk-ABCDEFGHIJKLMNOPQRSTUVWX inside ${'x'.repeat(10_000)}`,
      }),
    ]);
    h.bus.publish(verdictEvent('round-secret'));
    const entry = h.journal.list()[0]!;
    expect(entry.body).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(entry.body).toContain('[redacted]');
    expect(entry.body.length).toBeLessThanOrEqual(REVIEW_FINDING_BODY_MAX_CHARS);
  });

  it('redacts model-supplied category text inside tags too', () => {
    const h = captureHarness();
    writeConsolidated(h.artifactRoot, 'round-tag-secret', [
      blockerFixture({ category: 'leak sk-ABCDEFGHIJKLMNOPQRSTUVWX in category' }),
    ]);
    h.bus.publish(verdictEvent('round-tag-secret'));
    const entry = h.journal.list()[0]!;
    expect(entry.tags.join(' ')).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTUVWX');
  });

  it('a partial capture retries without duplicating the already-journaled findings', () => {
    const h = captureHarness();
    writeConsolidated(h.artifactRoot, 'round-partial', [
      blockerFixture(),
      blockerFixture({ title: 'Second blocker', detail: 'The other half.' }),
    ]);
    // Simulate a failed capture that already journaled the first blocker.
    h.journal.append({
      kind: 'finding',
      source: 'perkins:round-partial',
      tags: ['repo:gru-command-demo', 'review:blocker', 'category:correctness'],
      body: 'Off-by-one in the rollup — src/rollup.ts:42: The rollup drops the last row of every batch.',
    });
    h.bus.publish(verdictEvent('round-partial'));
    const entries = h.journal.list();
    expect(entries).toHaveLength(2); // the pre-existing one + exactly the missing one
    expect(entries.filter((entry) => entry.body.startsWith('Second blocker'))).toHaveLength(1);
    expect(entries.filter((entry) => entry.body.startsWith('Off-by-one'))).toHaveLength(1);
  });

  it('captures through the production ledger verdict event, not just a raw bus publish', () => {
    const dir = tmpDir('gru-command-review-capture-ledger-');
    const artifactRoot = join(dir, 'reviews');
    const journal = new JournalStore(join(dir, 'journal'));
    const bus = new EventBus({});
    createReviewOutcomeCapture({ bus, journal, artifactRoot, stateFile: join(artifactRoot, '.review-capture-state.json') });
    const ledgerDb = new LedgerDb(join(dir, 'data'));
    const ledger = new LedgerApi(ledgerDb.handle, { bus });
    try {
      const job = ledger.addJob({ id: 'job-cap', repo: 'demo', title: 'review me', briefing: 'b' });
      const round = ledger.addRound({ jobId: job.id });
      ledger.setRoundStatus(round.id, 'live');
      writeConsolidated(artifactRoot, round.id, [blockerFixture({ location: `src/x.ts:1 (${round.id})` })]);
      ledger.setRoundVerdict(round.id, 'changes-requested');
      const entries = journal.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'finding', source: `perkins:${round.id}` });
    } finally {
      ledgerDb.close();
    }
  });

  it('ignores events that are not round verdicts or carry no round id', () => {
    const h = captureHarness();
    writeConsolidated(h.artifactRoot, 'round-abc123', [blockerFixture()]);
    h.bus.publish({ ...verdictEvent('round-abc123'), kind: 'round.status' });
    h.bus.publish({ ...verdictEvent('round-abc123'), roundId: null });
    expect(h.journal.list()).toEqual([]);
    expect(h.logs).toEqual([]);
  });
});
