import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

/**
 * The macOS suspend-evidence reader at its subprocess boundary, on any OS
 * (review round 4 of #252, owner decision: an Ubuntu-runnable boundary test;
 * the real restricted-PATH test stays macOS-only): the production reader
 * runs /usr/sbin/sysctl by absolute path — the service's PATH need not
 * include /usr/sbin — bounded and SIGKILLed.
 */

const calls = vi.hoisted(() => [] as unknown[][]);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify: promisifyCustom } = await import('node:util');
  const execFile = Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args), {
    [promisifyCustom.custom]: (file: string, args: readonly string[], options: Record<string, unknown>) => {
      calls.push([file, args, options]);
      return Promise.resolve({ stdout: '{ sec = 1790944289, usec = 208542 } Fri Oct  2 13:31:29 2026\n', stderr: '' });
    },
  });
  return { ...actual, execFile };
});

const { parseKernWaketime, readKernWaketime } = await import('../src/dispatch/perkins-review/artifacts.js');

describe('macOS kernel wake reader at its subprocess boundary', () => {
  it('runs /usr/sbin/sysctl by absolute path with the bound and SIGKILL, and its answer parses', async () => {
    const output = await readKernWaketime(1_000);
    expect(calls).toEqual([
      ['/usr/sbin/sysctl', ['-n', 'kern.waketime'], expect.objectContaining({ timeout: 1_000, killSignal: 'SIGKILL' })],
    ]);
    expect(parseKernWaketime(output)).toBe(1_790_944_289_208);
    expect(typeof promisify).toBe('function');
  });
});
