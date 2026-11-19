/**
 * Thread stacks of this process, taken when its libuv thread pool stops
 * answering.
 *
 * 2026-11-18: the pool of the owner's instance jammed at 23:58 and the
 * service did nothing for nine hours. The health look named the jam
 * (`threadPoolMs: null`, `FSReqPromise` climbing from 3 to 234) but not
 * what the four pool threads were blocked in, and the restart that cured
 * it removed the only evidence. A capture taken at the moment of the jam
 * is that evidence.
 *
 * Everything here stays off the pool it is diagnosing: one child process
 * (spawned on the loop thread) and synchronous `fs` calls. No
 * `fs.promises` and no callback `fs`: each would queue behind the jam and
 * never return.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The thread name libuv gives its pool threads (macOS and Linux). */
export const POOL_THREAD_NAME = 'libuv-worker';
/** How long macOS `sample` watches the process. */
export const THREAD_CAPTURE_SAMPLE_SECONDS = 3;
/** The capture tool is killed when it has not finished by then. */
export const THREAD_CAPTURE_TOOL_TIMEOUT_MS = 60_000;
/** Captures kept in the folder; older ones are deleted. */
export const THREAD_CAPTURE_KEEP = 5;
const SAMPLE_TOOL = '/usr/bin/sample';
const CAPTURE_FILE = /^thread-capture-.+\.txt$/;
/** File descriptors listed in a Linux capture. */
const PROC_FD_LIMIT = 512;

/** A capture that could not be taken; the message says what to do. */
export class ThreadCaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreadCaptureError';
  }
}

export interface ThreadCapture {
  /** The full capture: every thread of the process. */
  readonly file: string;
  /** `sample`: macOS call-graph sampling. `proc`: Linux `/proc/<pid>/task`. */
  readonly tool: 'sample' | 'proc';
  /** One line per libuv pool thread, saying where it was. `sample`: its
   * innermost frames by share of the samples (`__open_nocancel 100%` is a
   * thread that never left `open`). `proc`: its scheduler state, the
   * kernel function it waits in and its system call number. Empty when
   * the capture names no pool thread; the file still has every thread. */
  readonly workers: readonly string[];
  /** Why captures past the newest {@link THREAD_CAPTURE_KEEP} could not be
   * deleted; null when they were. The capture itself is taken either way. */
  readonly pruneError: string | null;
}

export interface ThreadCaptureOptions {
  /** Folder the capture is written to (`<data_dir>/logs`). */
  readonly dir: string;
  readonly pid?: number;
  readonly platform?: NodeJS.Platform;
  readonly sampleSeconds?: number;
  readonly keep?: number;
  readonly now?: () => number;
  /** Seam (default: `execFile`, killed after `timeoutMs`). */
  readonly run?: (command: string, args: readonly string[], timeoutMs: number) => Promise<void>;
  /** Seam (default `/proc`). */
  readonly procRoot?: string;
}

function oneLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function runTool(command: string, args: readonly string[], timeoutMs: number): Promise<void> {
  return new Promise((done, failed) => {
    execFile(command, [...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error) => {
      if (error === null) done();
      else failed(error);
    });
  });
}

interface Frame {
  readonly depth: number;
  readonly count: number;
  readonly symbol: string;
}

function summarize(total: number, frames: readonly Frame[]): string {
  if (frames.length === 0) return 'no frames read';
  // A frame is innermost when the next line is not nested deeper.
  const innermost = new Map<string, number>();
  frames.forEach((frame, index) => {
    const next = frames[index + 1];
    if (next !== undefined && next.depth > frame.depth) return;
    innermost.set(frame.symbol, (innermost.get(frame.symbol) ?? 0) + frame.count);
  });
  return [...innermost.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([symbol, count]) => `${symbol} ${total > 0 ? Math.round((count * 100) / total) : 0}%`)
    .join(', ');
}

/** What each libuv pool thread was doing, read from the `Call graph:`
 * section of a macOS `sample` report. A format this cannot read answers
 * with no workers; it never throws. */
export function sampleWorkerSummary(report: string): string[] {
  const lines = report.split('\n');
  const start = lines.indexOf('Call graph:');
  if (start === -1) return [];
  const workers: string[] = [];
  let pool: { readonly total: number; readonly frames: Frame[] } | null = null;
  const close = (): void => {
    if (pool !== null) workers.push(summarize(pool.total, pool.frames));
    pool = null;
  };
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.startsWith('Total number in stack')) break;
    const header = /^ {4}(\d+) Thread_\S+?(?::? +(.*))?$/.exec(line);
    if (header !== null) {
      close();
      if ((header[2] ?? '').trim() === POOL_THREAD_NAME) pool = { total: Number(header[1]), frames: [] };
      continue;
    }
    const frame = /^( {4}[ +!:|]+)(\d+) (.+?)(?: {2}\(in .*)?$/.exec(line);
    if (frame !== null && pool !== null) {
      pool.frames.push({ depth: frame[1]!.length, count: Number(frame[2]), symbol: frame[3]! });
    }
  }
  close();
  return workers;
}

function prune(dir: string, keep: number): void {
  const captures = readdirSync(dir).filter((name) => CAPTURE_FILE.test(name)).sort();
  for (const name of captures.slice(0, Math.max(0, captures.length - keep))) rmSync(join(dir, name), { force: true });
}

type Taken = Omit<ThreadCapture, 'pruneError'>;

async function captureWithSample(file: string, pid: number, seconds: number, run: NonNullable<ThreadCaptureOptions['run']>): Promise<Taken> {
  try {
    await run(SAMPLE_TOOL, [String(pid), String(seconds), '-file', file], THREAD_CAPTURE_TOOL_TIMEOUT_MS);
  } catch (error) {
    throw new ThreadCaptureError(`${SAMPLE_TOOL} ${pid} ${seconds} did not finish, so no thread capture was taken: ${oneLine(error)}`);
  }
  let report: string;
  try {
    report = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ThreadCaptureError(`${SAMPLE_TOOL} exited without writing ${file}: ${oneLine(error)}`);
  }
  return { file, tool: 'sample', workers: sampleWorkerSummary(report) };
}

function captureFromProc(file: string, pid: number, procRoot: string, now: number): Taken {
  const base = join(procRoot, String(pid));
  const read = (path: string): string => {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch (error) {
      return `unreadable (${oneLine(error)})`;
    }
  };
  let tids: string[];
  try {
    tids = readdirSync(join(base, 'task')).sort((a, b) => Number(a) - Number(b));
  } catch (error) {
    throw new ThreadCaptureError(`${join(base, 'task')} cannot be listed, so no thread capture was taken: ${oneLine(error)}`);
  }
  const workers: string[] = [];
  const threads = tids.map((tid) => {
    const task = join(base, 'task', tid);
    const comm = read(join(task, 'comm'));
    // `stat` is "<pid> (<comm>) <state> ...": the state follows the last ")".
    const stat = read(join(task, 'stat'));
    const state = /^\S/.exec(stat.slice(stat.lastIndexOf(')') + 1).trim())?.[0] ?? '?';
    const syscall = read(join(task, 'syscall'));
    const wchan = read(join(task, 'wchan'));
    if (comm === POOL_THREAD_NAME) workers.push(`${state} in ${wchan === '0' || wchan === '' ? 'no wait channel' : wchan}, syscall ${syscall.split(' ')[0]}`);
    return `tid ${tid}  ${comm}  state ${state}  wchan ${wchan}  syscall ${syscall}`;
  });
  let fds: string[];
  try {
    fds = readdirSync(join(base, 'fd')).sort((a, b) => Number(a) - Number(b)).slice(0, PROC_FD_LIMIT).map((fd) => {
      try {
        return `fd ${fd} -> ${readlinkSync(join(base, 'fd', fd))}`;
      } catch (error) {
        return `fd ${fd} -> unreadable (${oneLine(error)})`;
      }
    });
  } catch (error) {
    fds = [`fd table unreadable (${oneLine(error)})`];
  }
  const report = [
    `Thread capture of pid ${pid} at ${new Date(now).toISOString()} (from ${base}/task)`,
    'state: R running, S sleeping, D uninterruptible wait. syscall: "<number> <args> <sp> <pc>", "running", or -1 when blocked outside a system call.',
    '',
    ...threads,
    '',
    ...fds,
    '',
  ].join('\n');
  try {
    writeFileSync(file, report);
  } catch (error) {
    throw new ThreadCaptureError(`the thread capture could not be written to ${file}: ${oneLine(error)}`);
  }
  return { file, tool: 'proc', workers };
}

/**
 * Capture every thread of this process into `dir` and say where the libuv
 * pool threads were. macOS runs `sample`; Linux reads `/proc/<pid>/task`.
 * Rejects with {@link ThreadCaptureError} when no capture was taken.
 */
export async function captureThreadStacks(opts: ThreadCaptureOptions): Promise<ThreadCapture> {
  const platform = opts.platform ?? process.platform;
  const pid = opts.pid ?? process.pid;
  const now = (opts.now ?? Date.now)();
  if (platform !== 'darwin' && platform !== 'linux') {
    throw new ThreadCaptureError(`thread capture knows macOS (sample) and Linux (/proc) only, not ${platform}`);
  }
  try {
    mkdirSync(opts.dir, { recursive: true });
  } catch (error) {
    throw new ThreadCaptureError(`the capture folder ${opts.dir} cannot be created: ${oneLine(error)}`);
  }
  const file = join(opts.dir, `thread-capture-${new Date(now).toISOString().replace(/[:.]/g, '-')}.txt`);
  const capture =
    platform === 'darwin'
      ? await captureWithSample(file, pid, opts.sampleSeconds ?? THREAD_CAPTURE_SAMPLE_SECONDS, opts.run ?? runTool)
      : captureFromProc(file, pid, opts.procRoot ?? '/proc', now);
  try {
    prune(opts.dir, opts.keep ?? THREAD_CAPTURE_KEEP);
    return { ...capture, pruneError: null };
  } catch (error) {
    return { ...capture, pruneError: oneLine(error) };
  }
}
