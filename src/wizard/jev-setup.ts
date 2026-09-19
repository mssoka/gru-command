import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type CredentialSource = 'environment' | 'file' | 'none';

export interface JevStatus {
  readonly enabled: boolean;
  readonly credential_present: boolean;
  readonly credential_source: CredentialSource;
  readonly reason?: string | null;
}

export interface JevCheck {
  readonly ok: boolean;
  readonly status: 'disabled' | 'ready' | 'degraded';
  readonly reason: string | null;
}

export interface JevCliOptions {
  readonly repoRoot: string;
  readonly instanceDir: string;
  /** Test-only contract seam. Production always uses dist/decisions/cli.js. */
  readonly cliPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function cliPath(options: JevCliOptions): string {
  return options.cliPath ?? join(options.repoRoot, 'dist', 'decisions', 'cli.js');
}

function mergedEnv(options: JevCliOptions): NodeJS.ProcessEnv {
  return { ...process.env, ...options.env };
}

function scrubbedChildEnv(options: JevCliOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...mergedEnv(options),
    GRU_COMMAND_HOME: options.instanceDir,
  };
  delete env.OPENROUTER_API_KEY;
  return env;
}

function runCli(
  options: JevCliOptions,
  args: readonly string[],
  input?: string,
): RunResult {
  const entry = cliPath(options);
  if (!existsSync(entry)) {
    throw new Error(`Jev setup CLI is unavailable at ${entry} — run the product build first`);
  }
  const result = spawnSync(process.execPath, [entry, ...args], {
    input,
    encoding: 'utf-8',
    env: scrubbedChildEnv(options),
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  if (result.error !== undefined) {
    throw new Error(`Jev CLI failed to start: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function sanitizedFailure(operation: string, result: RunResult): Error {
  // The sibling CLI contract is sanitized, but never reflect arbitrary
  // child stderr into setup output: a broken replacement must not echo a key.
  return new Error(`Jev ${operation} failed (exit ${result.status})`);
}

function parseJson<T>(operation: string, result: RunResult, allowFailure = false): T {
  if (result.status !== 0 && !allowFailure) throw sanitizedFailure(operation, result);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`Jev ${operation} returned malformed JSON`);
  }
}

/** Offline status only; never performs a provider request. */
export function readJevStatus(options: JevCliOptions): JevStatus {
  const result = runCli(options, ['status', '--json']);
  const status = parseJson<JevStatus>('status', result);
  if (
    typeof status.enabled !== 'boolean' ||
    typeof status.credential_present !== 'boolean' ||
    !['environment', 'file', 'none'].includes(status.credential_source)
  ) {
    throw new Error('Jev status returned an invalid sanitized shape');
  }
  const environmentKey = mergedEnv(options).OPENROUTER_API_KEY;
  if (environmentKey !== undefined && environmentKey.trim() !== '') {
    return { ...status, credential_present: true, credential_source: 'environment' };
  }
  return status;
}

/** Persist one key through the sibling CLI stdin contract. The value is never logged. */
export function persistJevCredential(options: JevCliOptions, key: string): void {
  if (key.trim() === '' || key.includes('\n') || key.includes('\r')) {
    throw new Error('OpenRouter credential must be one non-empty line');
  }
  const result = runCli(options, ['credentials', 'set', '--stdin'], `${key}\n`);
  const parsed = parseJson<{ ok?: unknown }>('credential persistence', result);
  if (parsed.ok !== true) throw new Error('Jev credential persistence did not confirm success');
}

/** Bounded live readiness probe. Enabled degradation is returned, not hidden. */
export function checkJev(options: JevCliOptions): JevCheck {
  const result = runCli(options, ['check', '--json']);
  const check = parseJson<JevCheck>('check', result, true);
  if (
    typeof check.ok !== 'boolean' ||
    !['disabled', 'ready', 'degraded'].includes(check.status) ||
    !(typeof check.reason === 'string' || check.reason === null)
  ) {
    throw new Error('Jev check returned an invalid sanitized shape');
  }
  if (result.status !== 0 && check.status !== 'degraded') {
    throw sanitizedFailure('check', result);
  }
  return check;
}
