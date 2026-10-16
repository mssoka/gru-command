import type { Writable } from 'node:stream';

/** Run a child, teeing its complete output into `log`; a capture write that
 * fails stops the child and rejects once it has closed. */
export function run(
  command: string,
  args: readonly string[],
  cwd: string,
  log: string,
  sinks?: readonly [Writable, Writable],
): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
