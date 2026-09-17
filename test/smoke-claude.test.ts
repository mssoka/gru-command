import { describe, expect, it } from 'vitest';

/**
 * Real-CLI smoke round-trip for the claude-code adapter (EPICS E3
 * acceptance: optional, env-flagged, skipped by default — the default
 * suite never spawns a real `claude`).
 *
 * Run explicitly on a machine with a configured Claude Code install:
 *   GRU_COMMAND_SMOKE_CLAUDE=1 npx vitest run test/smoke-claude.test.ts
 *
 * Spawns the REAL `claude` binary from PATH: one live prompt round-trip
 * plus one resume turn (session continuity through the CLI's own store).
 */
const SMOKE_FLAG = 'GRU_COMMAND_SMOKE_CLAUDE';

describe.skipIf(process.env[SMOKE_FLAG] !== '1')('claude-code smoke (live CLI)', () => {
  it('completes one live round-trip and one resume turn against the real claude CLI', async () => {
    const { loadConfig, configPathFor } = await import('../src/config.js');
    const { ClaudeCodeRuntime } = await import('../src/runtime/claude-adapter.js');
    const { SessionStore } = await import('../src/sessions/store.js');
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const home = mkdtempSync(join(tmpdir(), 'gru-command-smoke-claude-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-command-smoke-ws-'));
    try {
      writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
      const config = loadConfig({ GRU_COMMAND_HOME: home });
      const store = new SessionStore(config.dataDir);
      const runtime = new ClaudeCodeRuntime({ config, store }); // real binary via PATH
      const handle = await runtime.spawn('gru'); // "default" sentinel: claude's own model
      try {
        const deltas: string[] = [];
        handle.subscribe((event) => {
          if (event.type === 'text_delta') deltas.push(event.delta);
        });
        await handle.prompt('Reply with exactly the word: ready', { owner: 'smoke' });
        expect(deltas.join('')).toBeTruthy();
        expect(handle.health().state).toBe('idle');

        // Continuity: dispose + resume against the same transcript file.
        const file = handle.sessionFile!;
        await handle.dispose();
        const resumed = await runtime.spawn('gru', { resumeFile: file });
        try {
          const again: string[] = [];
          resumed.subscribe((event) => {
            if (event.type === 'text_delta') again.push(event.delta);
          });
          await resumed.prompt('Reply with exactly the word: again', { owner: 'smoke' });
          expect(again.join('')).toBeTruthy();
          expect(resumed.health().state).toBe('idle');
        } finally {
          await resumed.dispose();
        }
      } finally {
        await runtime.dispose();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 180_000);
});
