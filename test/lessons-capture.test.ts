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
import { JournalStore } from '../src/lessons/journal.js';
import { LessonCaptureError } from '../src/lessons/types.js';
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
