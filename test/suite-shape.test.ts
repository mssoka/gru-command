import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phantom-check guard: every test file must register exactly its pinned
 * number of tests. A file that silently collects zero tests (or loses some
 * to an aborted module) fails here instead of passing vacuously.
 * Adding a test? Bump this pin — that is the point.
 */
const PINS: Record<string, number> = {
  'chat-frame-log.test.ts': 11,
  'chat-frames.test.ts': 4,
  'chat-server.test.ts': 15,
  'chat-session-state.test.ts': 4,
  'claude-adapter.test.ts': 50,
  'config.test.ts': 31,
  'health.test.ts': 12,
  'identity.test.ts': 3,
  'logger.test.ts': 1,
  'pi-adapter.test.ts': 32,
  'roles-gru.test.ts': 4,
  'runtime-probe.test.ts': 7,
  'session-store.test.ts': 14,
  'shutdown.test.ts': 3,
  'smoke-claude.test.ts': 1,
  'smoke-real-model.test.ts': 1,
  'static.test.ts': 7,
  'stub-runtime.test.ts': 11,
  'suite-shape.test.ts': 1,
};

describe('suite shape', () => {
  it('every test file is pinned and registers exactly its expected test count', () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir)
      .filter((name) => name.endsWith('.test.ts'))
      .sort();
    expect(files).toEqual(Object.keys(PINS).sort());
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf-8');
      const registered = (source.match(/\bit\(/g) ?? []).length;
      const pinned = PINS[file] ?? -1;
      expect(
        registered,
        `${file}: registered ${registered} tests, pin says ${pinned === -1 ? 'UNPINNED' : pinned}`,
      ).toBe(pinned);
    }
  });
});
