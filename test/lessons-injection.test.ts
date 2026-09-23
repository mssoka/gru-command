import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { renderMinionBriefing, DispatchService } from '../src/dispatch/service.js';
import { renderRebriefPrompt, routeFixDirectiveToMinion } from '../src/dispatch/fix-directive.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import type { LessonPointer, LessonsReferencePort } from '../src/lessons/types.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';

/**
 * Progressive-disclosure injection (Book of Lessons): briefings and
 * directives carry POINTER lines only — location + reason. The chapter
 * body must never leak into a prompt. Acceptance pin: no body sentinel
 * appears in any rendered briefing.
 */

const BODY_SENTINEL = 'THE-CHAPTER-BODY-MUST-NEVER-BE-INLINED';

const POINTER: LessonPointer = {
  chapter: 'ops-restarts',
  lesson: 'shell-hang',
  path: '/tmp/gru-bible/chapters/ops-restarts.md',
  why: 'task mentions restart, shell',
};

function port(pointers: readonly LessonPointer[]): LessonsReferencePort {
  return { referencesFor: () => pointers };
}

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
afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function fakeHandle(role: AgentHandle['role'], prompts: string[]): AgentHandle {
  return {
    role,
    id: 'agent-1',
    sessionFile: null,
    capabilities: FAKE_CAPABILITIES,
    async prompt(text: string) {
      prompts.push(text);
    },
    async steer() {},
    async followUp() {},
    subscribe() {
      return () => {};
    },
    health() {
      return { state: 'idle', lastActivity: null, sessionFile: null };
    },
    async dispose() {},
  };
}

describe('progressive-disclosure injection', () => {
  it('renders the minion briefing with pointer lines and without the chapter body', () => {
    const briefing = renderMinionBriefing({
      jobId: 'job-1',
      repoName: 'repo',
      branch: 'gru/job-1',
      worktreePath: '/tmp/wt',
      sha: 'abc123',
      briefing: 'Restart the service and verify it stays up.',
      lessons: [POINTER],
    });
    expect(briefing).toContain('RELEVANT LESSONS');
    expect(briefing).toContain(
      '- read /tmp/gru-bible/chapters/ops-restarts.md#shell-hang (why: task mentions restart, shell)',
    );
    expect(briefing).not.toContain(BODY_SENTINEL);
  });

  it('omits the section entirely when there are no pointers', () => {
    const briefing = renderMinionBriefing({
      jobId: 'job-1',
      repoName: 'repo',
      branch: 'gru/job-1',
      worktreePath: '/tmp/wt',
      sha: 'abc123',
      briefing: 'do the thing',
    });
    expect(briefing).not.toContain('RELEVANT LESSONS');
  });

  it('injects pointers into a dispatched minion prompt automatically', async () => {
    const dataDir = tmpDir('gru-command-injection-');
    const ledgerDb = new LedgerDb(dataDir);
    const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
    const worktrees = new InMemoryWorktreePort(join(dataDir, 'wt'));
    const prompts: string[] = [];
    const dispatch = new DispatchService({
      ledger,
      worktrees,
      spawner: async (role) => fakeHandle(role, prompts),
      lessons: {
        referencesFor: (taskText) => {
          expect(taskText).toContain('restart the service');
          return [POINTER];
        },
      },
    });
    try {
      const outcome = await dispatch.dispatch({
        jobId: 'job-inject',
        repoPath: join(dataDir, 'repo'),
        title: 'restart the service',
        briefing: 'Restart the service carefully; acceptance: it stays up.',
      });
      expect(await outcome.settled).toEqual({ ok: true });
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0]!;
      expect(prompt).toContain('read /tmp/gru-bible/chapters/ops-restarts.md#shell-hang');
      expect(prompt).not.toContain(BODY_SENTINEL);
    } finally {
      ledgerDb.close();
    }
  });

  it('injects pointers into a re-brief prompt (the second rung of the ladder)', () => {
    const prompt = renderRebriefPrompt({
      jobId: 'job-2',
      briefing: 'original contract: restart the service safely',
      note: 'the same blocker recurred',
      lessons: [POINTER],
    });
    expect(prompt).toContain('RELEVANT LESSONS');
    expect(prompt).toContain('- read /tmp/gru-bible/chapters/ops-restarts.md#shell-hang');
    expect(prompt).not.toContain(BODY_SENTINEL);
  });

  it('injects pointers when routing a fix directive to the implementing minion', async () => {
    const root = tmpDir('gru-command-directive-injection-');
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const ledgerDb = new LedgerDb(dataDir);
    const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath, { recursive: true });
    const worktrees = new InMemoryWorktreePort(join(root, 'wt'));
    await worktrees.createJobWorktree({ repoPath, jobId: 'job-3' });
    const prompts: string[] = [];
    try {
      const result = await routeFixDirectiveToMinion({
        registry: {
          getHandle: () => null,
          spawn: async (role) => fakeHandle(role, prompts),
          disposeHandle: async () => {},
        },
        ledger,
        worktrees,
        jobId: 'job-3',
        directive: 'Fix the shell hang before restarting.',
        signal: new AbortController().signal,
        lessons: port([POINTER]),
      });
      expect(result.delivered).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('read /tmp/gru-bible/chapters/ops-restarts.md#shell-hang');
      expect(prompts[0]).not.toContain(BODY_SENTINEL);
    } finally {
      ledgerDb.close();
    }
  });
});
