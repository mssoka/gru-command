import type { RuntimeId } from '../config.js';
import { whichBinary } from '../runtime/probe.js';

/** CLI binary and install hint per runtime id (probe.ts owns the binary map). */
const RUNTIME_CLI: Readonly<Record<RuntimeId, { readonly binary: string; readonly install: string }>> = {
  pi: { binary: 'pi', install: 'install the pi CLI' },
  'claude-code': {
    binary: 'claude',
    install: 'install Claude Code (https://docs.claude.com/en/docs/claude-code) and sign in with `claude`',
  },
};

export class RuntimeCliMissingError extends Error {
  override readonly name = 'RuntimeCliMissingError';
}

/**
 * Fail loud when the chosen default runtime (Claude Code) CLI is not on PATH: setup must
 * never write a config that dies at first spawn, and never silently swap in
 * a different runtime. The message names what is missing and both ways out.
 */
export function assertRuntimeCliAvailable(
  runtime: RuntimeId,
  pathEnv: string = process.env['PATH'] ?? '',
): void {
  // pi keeps the long-standing warn-and-proceed behavior (the probe prints it);
  // only the new default is enforced so existing pi workflows are unchanged.
  if (runtime !== 'claude-code') return;
  const { binary, install } = RUNTIME_CLI[runtime];
  if (whichBinary(binary, pathEnv) !== null) return;
  const other: RuntimeId = 'pi';
  throw new RuntimeCliMissingError(
    `the default runtime is "${runtime}" but its CLI \`${binary}\` was not found on PATH.\n` +
      `  Fix: ${install}, then re-run setup.\n` +
      `  Or choose ${other} instead: config-generate --runtime ${other}, or wizard --answers '{"runtime":"${other}"}'.`,
  );
}
