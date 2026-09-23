import { spawn } from 'node:child_process';

/**
 * Roll command runner (graceful self-roll preflight): a bounded,
 * non-shell command executor. Commands are argv arrays — no shell
 * interpolation — with piped stdio, a hard timeout, and output tail
 * capture for the failure detail. A spawn failure (ENOENT, timeout) is
 * reported through the result, never thrown: the roll controller turns it
 * into a phase failure that leaves the old service serving.
 */

export interface RollCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const OUTPUT_TAIL_BYTES = 8_192;

function tail(text: string): string {
  const bytes = Buffer.byteLength(text, 'utf-8');
  if (bytes <= OUTPUT_TAIL_BYTES) return text;
  return text.slice(text.length - OUTPUT_TAIL_BYTES);
}

export function runRollCommand(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<RollCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const finish = (result: RollCommandResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeoutMs,
      });
    } catch (error) {
      finish({ code: -1, stdout: '', stderr: `failed to spawn ${command}: ${String(error)}` });
      return;
    }
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (error: Error) => {
      finish({
        code: -1,
        stdout: tail(Buffer.concat(stdoutChunks).toString('utf-8')),
        stderr: `failed to run ${command}: ${String(error)}`,
      });
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      const stderr = tail(Buffer.concat(stderrChunks).toString('utf-8'));
      const timedOut = signal !== null && code === null;
      finish({
        code: code ?? -1,
        stdout: tail(Buffer.concat(stdoutChunks).toString('utf-8')),
        stderr: timedOut
          ? `${stderr}command timed out after ${options.timeoutMs} ms (signal ${signal})`.trim()
          : stderr,
      });
    });
  });
}
