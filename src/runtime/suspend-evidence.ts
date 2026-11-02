import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * OS suspend evidence, shared by the two producers that must tell a real
 * system sleep from a process that simply could not run: the Perkins
 * admission probe (#252: a git step that failed while the machine slept is
 * re-run once) and the supervisor's clock-gap classification (#569: a tick
 * gap is a sleep or an event-loop stall).
 *
 * The readers are bounded and never throw: anything unreadable, malformed or
 * late is "no evidence", which both callers treat as the failure they were
 * already handling.
 */

const execFileAsPromised = promisify(execFileCallback);

/** How long a reader may spend on the OS evidence before the answer is
 * discarded (owner decision 2026-10-07, round 3: a separate, bounded
 * allowance — the caller's own budget is usually what the suspend spent). */
export const SUSPEND_EVIDENCE_TIMEOUT_MS = 1_000;

/** `sysctl -n kern.waketime` by absolute path — the service's PATH need
 * not include /usr/sbin. */
export const readKernWaketime = async (timeoutMs: number): Promise<string> =>
  (await execFileAsPromised('/usr/sbin/sysctl', ['-n', 'kern.waketime'], {
    encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
  })).stdout;

/** Parse `sysctl -n kern.waketime` ("{ sec = 1790944289, usec = 208542 } …"). */
export function parseKernWaketime(output: string): number | null {
  const match = /sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/u.exec(output);
  return match === null ? null : Number(match[1]) * 1000 + Math.floor(Number(match[2]) / 1000);
}

/** Whether the OS proves the machine suspended after `sinceWallMs`: on macOS
 * the kernel's last wake is later than that wall clock. Every Node clock on
 * macOS keeps counting through sleep (libuv uses mach_continuous_time), so
 * this is the only way to tell a macOS sleep from a stalled event loop; on
 * Linux the monotonic clock already pauses, so the caller never needs it and
 * no subprocess is spawned. */
export async function readSuspendedSince(sinceWallMs: number): Promise<boolean> {
  if (process.platform !== 'darwin') return false; // the monotonic clock decides elsewhere
  try {
    const wakeMs = parseKernWaketime(await readKernWaketime(SUSPEND_EVIDENCE_TIMEOUT_MS));
    return wakeMs !== null && wakeMs > sinceWallMs;
  } catch {
    return false; // no evidence
  }
}
