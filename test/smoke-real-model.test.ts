import { describe, expect, it } from 'vitest';

/**
 * Real-model smoke round-trip (EPICS E2 acceptance: optional, env-flagged,
 * skipped by default — the default suite never touches the network).
 *
 * Run explicitly with a configured pi install:
 *   GRU_COMMAND_SMOKE=1 npx vitest run test/smoke-real-model.test.ts
 *
 * Uses the REAL agent dir (~/.pi/agent) and the real model catalog; expects
 * the runtime's default model to answer one trivial prompt.
 */
const SMOKE_FLAG = 'GRU_COMMAND_SMOKE';

describe.skipIf (process.env[SMOKE_FLAG] !== '1') ('real-model smoke (live pi)', () => {
  it('completes one live prompt round-trip against the configured default model', async () => {
    const { loadConfig } = await import('../src/config.js');
    const { PiRuntime } = await import('../src/runtime/pi-adapter.js');
    const { SessionStore } = await import('../src/sessions/store.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const home = mkdtempSync(join(tmpdir(), 'gru-command-smoke-'));
    try {
      const { writeFileSync } = await import('node:fs');
      const { configPathFor } = await import('../src/config.js');
      writeFileSync(configPathFor(home), 'workspace_root = "/tmp"\n', 'utf-8');
      const config = loadConfig({ GRU_COMMAND_HOME: home });
      const store = new SessionStore(config.dataDir);
      const runtime = new PiRuntime({ config, store }); // real agentDir + model catalog
      const handle = await runtime.spawn('gru'); // "default" sentinel: pi's own model
      try {
        const deltas: string[] = [];
        handle.subscribe((event) => {
          if (event.type === 'text_delta') deltas.push(event.delta);
        });
        await handle.prompt('Reply with exactly the word: ready', { owner: 'smoke' });
        expect(deltas.join('')).toBeTruthy();
        expect(handle.health().state).toBe('idle');
      } finally {
        await handle.dispose();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
