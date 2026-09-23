import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPathFor, loadConfig } from '../src/config.js';
import { SessionStore } from '../src/sessions/store.js';
import { PiRuntime } from '../src/runtime/pi-adapter.js';
import { BibleStore } from '../src/lessons/bible.js';
import { renderMinionBriefing } from '../src/dispatch/service.js';
import type { LessonPointer } from '../src/lessons/types.js';
import { makeStubModelRuntime, StubScript, type StubTurn } from './helpers/stub-model.js';

/**
 * Minion-style end-to-end (Book of Lessons acceptance): a briefing carries
 * a POINTER; the agent reads the pointed section with its own file tools
 * and answers from it — while the section body never travels in the
 * briefing itself.
 *
 * The default suite runs the full session path offline through the stub
 * provider (deterministic). The live-model variant is env-gated:
 *   GRU_COMMAND_LESSONS_E2E=1 npx vitest run test/lessons-e2e.test.ts
 */

const PHRASE = 'hold the shell door open before restarting';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function seedBible(): { bible: BibleStore; pointer: LessonPointer } {
  const root = tmpDir('gru-command-e2e-bible-');
  const bible = new BibleStore(join(root, 'bible'));
  bible.ensureSeeded();
  bible.applyUpdates(
    [
      {
        slug: 'ops-restarts',
        title: 'Ops restarts',
        summary: 'Restart discipline for the hosted service.',
        tags: ['ops', 'restarts'],
        lessons: [
          {
            slug: 'shell-hang',
            body: `A live shell holds the session open. ${PHRASE}. Kill it first.`,
            tags: ['restarts', 'shell'],
            journalIds: ['j-1'],
          },
        ],
      },
    ],
    new Map([['j-1', '2026-09-23T00:00:00.000Z']]),
  );
  return {
    bible,
    pointer: {
      chapter: 'ops-restarts',
      lesson: 'shell-hang',
      path: join(bible.dir, 'chapters', 'ops-restarts.md'),
      why: 'task mentions restart, shell',
    },
  };
}

function briefingFor(pointer: LessonPointer): string {
  return renderMinionBriefing({
    jobId: 'job-lessons-e2e',
    repoName: 'fixture',
    branch: 'gru/job-lessons-e2e',
    worktreePath: tmpDir('gru-command-e2e-wt-'),
    sha: 'deadbeef',
    briefing: 'Restart the service. Check the relevant lessons before touching anything.',
    lessons: [pointer],
  });
}

describe('minion-style lessons e2e (stubbed session path)', () => {
  it('the briefing carries a pointer, the agent reads the section, and the answer comes from it', async () => {
    const { pointer } = seedBible();
    const briefing = briefingFor(pointer);
    expect(briefing).toContain(`read ${pointer.path}#shell-hang`);
    expect(briefing).not.toContain(PHRASE);

    const home = tmpDir('gru-command-e2e-home-');
    const workspace = tmpDir('gru-command-e2e-ws-');
    writeFileSync(
      configPathFor(home),
      `workspace_root = "${workspace}"\n[models]\ndefault = "gru-stub/stub-model"\n`,
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const script = new StubScript((prompt, callIndex): StubTurn => {
      if (callIndex === 0) {
        return { deltas: [], toolCall: { id: 'read-1', name: 'read', args: { path: pointer.path } } };
      }
      // The stub hands the tool result back in the next prompt; answering
      // the phrase PROVES the section was actually read.
      return { deltas: [prompt.includes(PHRASE) ? `The pointed section says: ${PHRASE}` : 'SECTION NOT READ'] };
    });
    const modelRuntime = await makeStubModelRuntime(script);
    const runtime = new PiRuntime({ config, store, agentDir: tmpDir('gru-command-e2e-agent-'), modelRuntime });
    const handle = await runtime.spawn('minion', { cwd: tmpDir('gru-command-e2e-cwd-') });
    try {
      const deltas: string[] = [];
      const tools: string[] = [];
      handle.subscribe((event) => {
        if (event.type === 'text_delta') deltas.push(event.delta);
        if (event.type === 'tool_start') tools.push(event.tool);
      });
      await handle.prompt(briefing, { owner: 'lessons-e2e' });
      expect(tools).toContain('read');
      expect(deltas.join('')).toContain(PHRASE);
    } finally {
      await handle.dispose();
    }
  });
});

describe.skipIf(process.env['GRU_COMMAND_LESSONS_E2E'] !== '1')(
  'minion-style lessons e2e (live model)',
  () => {
    it('answers from the pointed section without the body ever entering the briefing', async () => {
      const { pointer } = seedBible();
      const briefing = briefingFor(pointer);
      expect(briefing).not.toContain(PHRASE);

      const home = tmpDir('gru-command-e2e-live-home-');
      const workspace = tmpDir('gru-command-e2e-live-ws-');
      writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
      const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
      const store = new SessionStore(config.dataDir);
      const runtime = new PiRuntime({ config, store });
      const handle = await runtime.spawn('minion', { cwd: tmpDir('gru-command-e2e-live-cwd-') });
      try {
        const deltas: string[] = [];
        handle.subscribe((event) => {
          if (event.type === 'text_delta') deltas.push(event.delta);
        });
        const prompt = `${briefing}\n\nRead the pointed lesson section, then reply with the exact key instruction it gives, quoted.`;
        await handle.prompt(prompt, { owner: 'lessons-e2e-live' });
        expect(deltas.join('')).toContain(PHRASE);
      } finally {
        await handle.dispose();
      }
    }, 180_000);
  },
);
