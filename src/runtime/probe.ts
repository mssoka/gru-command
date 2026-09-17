import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { RuntimeId } from '../config.js';
import { RUNTIME_IDS } from '../config.js';
import { CLAUDE_CODE_CAPABILITIES } from './claude-adapter.js';
import { PI_CAPABILITIES } from './pi-adapter.js';
import type { AgentCapabilities } from './types.js';

/**
 * Runtime probe (EPICS E3 story 3): detects which agent-runtime CLIs are
 * installed on this machine and reports versions + declared capabilities.
 * The E9 setup wizard consumes this; it is synchronous and runs at
 * wizard/boot time only, never on a hot path.
 */

/** CLI binary name per runtime id. */
const RUNTIME_BINARIES: Readonly<Record<RuntimeId, string>> = {
  pi: 'pi',
  'claude-code': 'claude',
};

const RUNTIME_CAPABILITIES: Readonly<Record<RuntimeId, AgentCapabilities>> = {
  pi: PI_CAPABILITIES,
  'claude-code': CLAUDE_CODE_CAPABILITIES,
};

export interface RuntimeProbeResult {
  readonly id: RuntimeId;
  /** The binary that was looked for. */
  readonly binary: string;
  /** True only when the binary resolves on PATH AND `--version` exits 0 in time. */
  readonly installed: boolean;
  /** Absolute path of the resolved binary, when found on PATH. */
  readonly path: string | null;
  /** First semver-ish token in the `--version` output, when present. */
  readonly version: string | null;
  /** Raw first line of the `--version` output (unparsed fallback). */
  readonly versionRaw: string | null;
  /** The adapter's declared capability set (static — honest by construction). */
  readonly capabilities: AgentCapabilities;
}

export interface ProbeOptions {
  /** PATH to probe against (default: process.env.PATH). Test seam. */
  readonly path?: string;
  /** Per-binary `--version` timeout. Default 5000ms. */
  readonly timeoutMs?: number;
}

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** First x.y.z(.w) token; suffixes stay in versionRaw (loose by design). */
const VERSION_RE = /\d+\.\d+\.\d+(?:\.\d+)?/;

/** Resolve a binary name to an absolute path by scanning PATH dirs. */
export function whichBinary(binary: string, pathEnv: string): string | null {
  const exts =
    process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, `${binary}${ext}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

function probeOne(binary: string, pathEnv: string, timeoutMs: number): Omit<RuntimeProbeResult, 'id' | 'binary' | 'capabilities'> {
  const resolved = whichBinary(binary, pathEnv);
  if (resolved === null) {
    return { installed: false, path: null, version: null, versionRaw: null };
  }
  const probe = spawnSync(binary, ['--version'], {
    env: { PATH: pathEnv },
    timeout: timeoutMs,
    killSignal: 'SIGTERM',
    encoding: 'utf8',
  });
  if (probe.error !== undefined || probe.signal !== null || probe.status !== 0) {
    return { installed: false, path: resolved, version: null, versionRaw: null };
  }
  const out = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim();
  const firstLine = out.split('\n')[0]?.trim() ?? '';
  const match = VERSION_RE.exec(out);
  return {
    installed: true,
    path: resolved,
    version: match !== null ? match[0] : null,
    versionRaw: firstLine !== '' ? firstLine : null,
  };
}

/** Probe every known runtime id; never throws — absence is data. */
export function probeRuntimes(options: ProbeOptions = {}): RuntimeProbeResult[] {
  const pathEnv = options.path ?? process.env['PATH'] ?? '';
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  return RUNTIME_IDS.map((id) => {
    const binary = RUNTIME_BINARIES[id];
    return {
      id,
      binary,
      capabilities: RUNTIME_CAPABILITIES[id],
      ...probeOne(binary, pathEnv, timeoutMs),
    };
  });
}
