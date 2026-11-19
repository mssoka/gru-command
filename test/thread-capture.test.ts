import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  THREAD_CAPTURE_KEEP,
  THREAD_CAPTURE_SAMPLE_SECONDS,
  THREAD_CAPTURE_TOOL_TIMEOUT_MS,
  ThreadCaptureError,
  captureThreadStacks,
  sampleWorkerSummary,
} from '../src/supervision/thread-capture.js';

/**
 * The shape of a macOS `sample` report (macOS 26, Report Version 7): a main
 * thread, an unnamed thread, one pool thread parked in open(2), one idle
 * pool thread that also did some directory work, and a last thread drawn
 * with spaces only, as `sample` draws the final one.
 */
const SAMPLE_REPORT = [
  'Analysis of sampling node (pid 4242) every 1 millisecond',
  'Process:         node [4242]',
  'Report Version:  7',
  '----',
  '',
  'Call graph:',
  '    1000 Thread_101   DispatchQueue_1: com.apple.main-thread  (serial)',
  '    + 1000 start  (in dyld) + 6992  [0x1818e44e4]',
  '    +   1000 uv_run  (in node) + 408  [0x1010bad84]',
  '    +     1000 kevent  (in libsystem_kernel.dylib) + 8  [0x181c71fc4]',
  '    1000 Thread_102',
  '    + 1000 thread_start  (in libsystem_pthread.dylib) + 8  [0x181caac1c]',
  '    +   1000 __workq_kernreturn  (in libsystem_kernel.dylib) + 8  [0x181c6d9f0]',
  '    1000 Thread_103: libuv-worker',
  '    + 1000 thread_start  (in libsystem_pthread.dylib) + 8  [0x181caac1c]',
  '    +   1000 worker  (in node) + 268  [0x1010b6ef4]',
  '    +     1000 uv__fs_work  (in node) + 176  [0x1010bd7c8]',
  '    +       1000 uv__fs_open  (in node) + 68  [0x1010bc0a4]',
  '    +         1000 __open  (in libsystem_kernel.dylib) + 8  [0x181c6c93c]',
  '    1000 Thread_104: libuv-worker',
  '    + 1000 thread_start  (in libsystem_pthread.dylib) + 8  [0x181caac1c]',
  '    +   800 worker  (in node) + 392  [0x1010b6f70]',
  '    +   ! 800 uv_cond_wait  (in node) + 40  [0x1010c99ac]',
  '    +   !   800 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x181c6f50c]',
  '    +   200 worker  (in node) + 268  [0x1010b6ef4]',
  '    +     140 uv__fs_work  (in node) + 1596  [0x1010bdd54]',
  '    +     : 140 lstat  (in libsystem_kernel.dylib) + 8  [0x181c77860]',
  '    +     50 uv__fs_work  (in node) + 2036  [0x1010bdf0c]',
  '    +     | 50 __getdirentries64  (in libsystem_kernel.dylib) + 8  [0x181c6d9c4]',
  '    +     10 uv_async_send  (in node) + 232  [0x1010ba2e8]',
  '    +       10 kevent  (in libsystem_kernel.dylib) + 8  [0x181c71fc4]',
  '    1000 Thread_105: libuv-worker',
  '      1000 thread_start  (in libsystem_pthread.dylib) + 8  [0x181caac1c]',
  '        1000 worker  (in node) + 268  [0x1010b6ef4]',
  '          1000 ???  (in <unknown binary>)  [0x16f603f20]',
  '',
  'Total number in stack (recursive counted multiple, when >=5):',
  '        5       __open  (in libsystem_kernel.dylib) + 0  [0x181c6c934]',
  '',
].join('\n');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'gru-thread-capture-'));
}

describe('thread capture', () => {
  it('says where each libuv pool thread was from a sample call graph', () => {
    expect(sampleWorkerSummary(SAMPLE_REPORT)).toEqual([
      // Never left open(2): a parked pool thread.
      '__open 100%',
      // Idle most of the time; the three most frequent innermost frames only.
      '__psynch_cvwait 80%, lstat 14%, __getdirentries64 5%',
      // The last thread is drawn without "+" and can have no symbol.
      '??? 100%',
    ]);
    // A report this cannot read answers with no workers; the file is the record.
    expect(sampleWorkerSummary('sample: no such process')).toEqual([]);
    expect(sampleWorkerSummary('Call graph:\n    12 Thread_1: libuv-worker\n')).toEqual(['no frames read']);
  });

  it('runs sample on the process, keeps the newest captures and names what failed', async () => {
    const dir = join(tempDir(), 'logs');
    try {
      mkdirSync(dir, { recursive: true });
      const old = Array.from({ length: THREAD_CAPTURE_KEEP + 1 }, (_value, index) => `thread-capture-2026-11-0${index + 1}T00-00-00-000Z.txt`);
      for (const name of old) writeFileSync(join(dir, name), 'old');
      writeFileSync(join(dir, 'service.log'), 'kept');
      const ran: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
      const capture = await captureThreadStacks({
        dir,
        pid: 4242,
        platform: 'darwin',
        now: () => Date.parse('2026-11-18T23:59:39.144Z'),
        run: async (command, args, timeoutMs) => {
          ran.push({ command, args, timeoutMs });
          writeFileSync(args[3]!, SAMPLE_REPORT);
        },
      });
      const file = join(dir, 'thread-capture-2026-11-18T23-59-39-144Z.txt');
      expect(ran).toEqual([
        { command: '/usr/bin/sample', args: ['4242', String(THREAD_CAPTURE_SAMPLE_SECONDS), '-file', file], timeoutMs: THREAD_CAPTURE_TOOL_TIMEOUT_MS },
      ]);
      expect(capture).toEqual({
        file,
        tool: 'sample',
        workers: ['__open 100%', '__psynch_cvwait 80%, lstat 14%, __getdirentries64 5%', '??? 100%'],
        pruneError: null,
      });
      // The newest THREAD_CAPTURE_KEEP captures stay; nothing else in the folder is touched.
      expect(readdirSync(dir).sort()).toEqual(['service.log', ...old.slice(2), 'thread-capture-2026-11-18T23-59-39-144Z.txt'].sort());

      const failed = captureThreadStacks({
        dir,
        pid: 4242,
        platform: 'darwin',
        run: async () => {
          throw new Error('spawn /usr/bin/sample ENOENT');
        },
      });
      await expect(failed).rejects.toBeInstanceOf(ThreadCaptureError);
      await expect(failed).rejects.toThrow('/usr/bin/sample 4242 3 did not finish, so no thread capture was taken: spawn /usr/bin/sample ENOENT');
      await expect(captureThreadStacks({ dir, pid: 4242, platform: 'darwin', run: async () => {} })).rejects.toThrow(/\/usr\/bin\/sample exited without writing .*thread-capture-/);
      const unknown = captureThreadStacks({ dir, platform: 'win32' });
      await expect(unknown).rejects.toBeInstanceOf(ThreadCaptureError);
      await expect(unknown).rejects.toThrow('thread capture knows macOS (sample) and Linux (/proc) only, not win32');
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });

  it('reads every thread and the open files from /proc on Linux', async () => {
    const root = tempDir();
    try {
      const procRoot = join(root, 'proc');
      const thread = (tid: string, comm: string, stat: string, syscall: string | null, wchan: string): void => {
        const task = join(procRoot, '77', 'task', tid);
        mkdirSync(task, { recursive: true });
        writeFileSync(join(task, 'comm'), `${comm}\n`);
        writeFileSync(join(task, 'stat'), `${stat}\n`);
        if (syscall !== null) writeFileSync(join(task, 'syscall'), `${syscall}\n`);
        writeFileSync(join(task, 'wchan'), wchan);
      };
      thread('77', 'node', '77 (node) S 1 77 77 0 -1', '281 0x9 0x7ffc 0x400', 'ep_poll');
      // A thread name may itself hold ")" and spaces: the state follows the LAST ")".
      thread('80', 'libuv-worker', '80 (libuv-worker) S 1 77 77 0 -1', '257 0xffffff9c 0x2d65a040 0x80000', 'wait_for_partner');
      thread('81', 'libuv-worker', '81 (libuv-worker) D 1 77 77 0 -1', '0 0x1b 0x7f00 0x1000', 'nfs_wait_bit_killable');
      thread('82', 'libuv-worker', '82 (libuv-worker) R 1 77 77 0 -1', 'running', '0');
      thread('9', 'odd) name', '9 (odd) name) S 1 77 77 0 -1', null, '0');
      mkdirSync(join(procRoot, '77', 'fd'));
      symlinkSync('/dev/null', join(procRoot, '77', 'fd', '0'));
      symlinkSync('/mnt/share/workspace', join(procRoot, '77', 'fd', '27'));
      const capture = await captureThreadStacks({
        dir: join(root, 'logs'),
        pid: 77,
        platform: 'linux',
        procRoot,
        now: () => Date.parse('2026-11-18T23:59:39.144Z'),
        run: async () => {
          throw new Error('Linux runs no tool');
        },
      });
      const file = join(root, 'logs', 'thread-capture-2026-11-18T23-59-39-144Z.txt');
      expect(capture).toEqual({
        file,
        tool: 'proc',
        workers: ['S in wait_for_partner, syscall 257', 'D in nfs_wait_bit_killable, syscall 0', 'R in no wait channel, syscall running'],
        pruneError: null,
      });
      const lines = readFileSync(file, 'utf8').split('\n');
      expect(lines[0]).toBe(`Thread capture of pid 77 at 2026-11-18T23:59:39.144Z (from ${join(procRoot, '77')}/task)`);
      expect(lines.filter((line) => line.startsWith('tid '))).toEqual([
        expect.stringMatching(/^tid 9 {2}odd\) name {2}state S {2}wchan 0 {2}syscall unreadable \(ENOENT/),
        'tid 77  node  state S  wchan ep_poll  syscall 281 0x9 0x7ffc 0x400',
        'tid 80  libuv-worker  state S  wchan wait_for_partner  syscall 257 0xffffff9c 0x2d65a040 0x80000',
        'tid 81  libuv-worker  state D  wchan nfs_wait_bit_killable  syscall 0 0x1b 0x7f00 0x1000',
        'tid 82  libuv-worker  state R  wchan 0  syscall running',
      ]);
      expect(lines.filter((line) => line.startsWith('fd '))).toEqual(['fd 0 -> /dev/null', 'fd 27 -> /mnt/share/workspace']);

      const gone = captureThreadStacks({ dir: join(root, 'logs'), pid: 78, platform: 'linux', procRoot });
      await expect(gone).rejects.toBeInstanceOf(ThreadCaptureError);
      await expect(gone).rejects.toThrow(/proc\/78\/task cannot be listed, so no thread capture was taken: ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
