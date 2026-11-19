import { execFileSync } from 'node:child_process';
import { closeSync, constants as fsConstants, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POOL_THREAD_NAME, captureThreadStacks } from '../src/supervision/thread-capture.js';

const CAPTURES = process.platform === 'darwin' || process.platform === 'linux';

describe('thread capture against the real tool', () => {
  it.skipIf(!CAPTURES)('names open(2) as what a jammed pool is blocked in, without using the pool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-thread-capture-real-'));
    // Park every libuv pool thread in open(2) on a FIFO nobody writes to:
    // the jam of 2026-11-18, reproduced. Any pool use by the capture itself
    // would now queue forever and time this test out.
    const poolSize = Math.max(4, Number(process.env['UV_THREADPOOL_SIZE'] ?? 4) || 4);
    const fifos = Array.from({ length: poolSize }, (_value, index) => join(root, `fifo-${index}`));
    for (const fifo of fifos) execFileSync('mkfifo', [fifo]);
    const parked = fifos.map((fifo) => open(fifo, 'r'));
    try {
      // The pool threads start on first use; give each its open(2).
      await new Promise((resolve) => setTimeout(resolve, 500));
      const capture = await captureThreadStacks({ dir: join(root, 'logs'), sampleSeconds: 1 });

      expect(capture.pruneError).toBeNull();
      expect(capture.tool).toBe(process.platform === 'darwin' ? 'sample' : 'proc');
      expect(capture.workers).toHaveLength(poolSize);
      for (const worker of capture.workers) {
        // macOS: the innermost frame for every sample. Linux: asleep in the
        // kernel's FIFO open, inside a system call.
        if (process.platform === 'darwin') expect(worker).toMatch(/^_*open\S* 100%$/);
        else expect(worker).toMatch(/^S in .+, syscall \d+$/);
      }
      expect(readFileSync(capture.file, 'utf8').split(POOL_THREAD_NAME).length - 1).toBeGreaterThanOrEqual(poolSize);
    } finally {
      // A FIFO opened read-write never blocks, and lets its parked reader through.
      const writers = fifos.map((fifo) => openSync(fifo, fsConstants.O_RDWR | fsConstants.O_NONBLOCK));
      for (const handle of await Promise.all(parked)) await handle.close();
      for (const fd of writers) closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
