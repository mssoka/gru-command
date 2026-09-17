import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CLAUDE_CODE_CAPABILITIES } from '../src/runtime/claude-adapter.js';
import { PI_CAPABILITIES } from '../src/runtime/pi-adapter.js';
import { probeRuntimes, whichBinary } from '../src/runtime/probe.js';

/**
 * Runtime-probe tests (EPICS E3 story 3): fixture PATHs holding tiny
 * executable scripts — the probe never touches the real `pi`/`claude`.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

/** A fixture bin dir; entries are <binary name> → script body. */
function fixturePath(entries: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-probe-'));
  cleanupDirs.push(dir);
  for (const [name, body] of Object.entries(entries)) {
    const file = join(dir, name);
    writeFileSync(file, body, 'utf-8');
    chmodSync(file, 0o755);
  }
  return dir;
}

const SH = '#!/bin/sh\n';

describe('probeRuntimes on fixture PATHs', () => {
  it('reports installed runtimes with parsed versions and declared capabilities', () => {
    const dir = fixturePath({
      pi: `${SH}echo "pi 0.85.1"\n`,
      claude: `${SH}echo "9.9.9 (Claude Code)"\n`,
    });
    const report = probeRuntimes({ path: dir });
    expect(report.map((r) => r.id)).toEqual(['pi', 'claude-code']);
    const pi = report[0]!;
    const claude = report[1]!;
    expect(pi.installed).toBe(true);
    expect(pi.version).toBe('0.85.1');
    expect(pi.path).toBe(join(dir, 'pi'));
    expect(pi.capabilities).toEqual(PI_CAPABILITIES);
    expect(claude.installed).toBe(true);
    expect(claude.version).toBe('9.9.9');
    expect(claude.path).toBe(join(dir, 'claude'));
    expect(claude.capabilities).toEqual(CLAUDE_CODE_CAPABILITIES);
    expect(claude.capabilities.steer).toBe('queued');
  });

  it('missing binaries report installed:false with null path/version — absence is data, never a throw', () => {
    const dir = fixturePath({});
    const report = probeRuntimes({ path: dir });
    for (const entry of report) {
      expect(entry.installed).toBe(false);
      expect(entry.path).toBeNull();
      expect(entry.version).toBeNull();
      expect(entry.versionRaw).toBeNull();
    }
  });

  it('a partially installed machine reports each runtime independently', () => {
    const dir = fixturePath({ claude: `${SH}echo "2.1.42 (Claude Code)"\n` });
    const [pi, claude] = probeRuntimes({ path: dir });
    expect(pi!.installed).toBe(false);
    expect(claude!.installed).toBe(true);
    expect(claude!.version).toBe('2.1.42');
  });

  it('a binary that exits non-zero or crashes is not installed (path still reported)', () => {
    const dir = fixturePath({
      pi: `${SH}echo "no version here" >&2\nexit 3\n`,
      claude: `${SH}exit 1\n`,
    });
    const [pi, claude] = probeRuntimes({ path: dir });
    expect(pi!.installed).toBe(false);
    expect(pi!.path).toBe(join(dir, 'pi'));
    expect(pi!.version).toBeNull();
    expect(claude!.installed).toBe(false);
  });

  it('a binary that hangs past the timeout is not installed', () => {
    const dir = fixturePath({
      pi: `${SH}sleep 30\n`,
      claude: `${SH}sleep 30\n`,
    });
    const report = probeRuntimes({ path: dir, timeoutMs: 200 });
    expect(report.every((r) => !r.installed)).toBe(true);
  });

  it('keeps the raw version line when no semver token parses', () => {
    const dir = fixturePath({
      pi: `${SH}echo "pi, custom local build"\n`,
      claude: `${SH}printf "claude-code\\nversion 1.2.3-beta.9"\n`,
    });
    const [pi, claude] = probeRuntimes({ path: dir });
    expect(pi!.installed).toBe(true);
    expect(pi!.version).toBeNull();
    expect(pi!.versionRaw).toBe('pi, custom local build');
    expect(claude!.version).toBe('1.2.3'); // first semver token, suffix stays raw
    expect(claude!.versionRaw).toBe('claude-code');
  });

  it('whichBinary skips non-executable files and finds executables in later PATH dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-probe-'));
    cleanupDirs.push(dir);
    const notExec = join(dir, 'claude');
    writeFileSync(notExec, `${SH}echo hi\n`, 'utf-8'); // 0644 — not executable
    expect(whichBinary('claude', dir)).toBeNull();
    const later = fixturePath({ claude: `${SH}echo "1.0.0"\n` });
    expect(whichBinary('claude', `${dir}:${later}`)).toBe(join(later, 'claude'));
  });
});
