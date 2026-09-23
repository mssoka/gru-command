import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';

/**
 * Listener ownership probe (owner incident 2026-09-23, item 3): who is
 * actually LISTENING on the instance port?
 *
 * macOS lets a specific bind (127.0.0.1) coexist with a wildcard bind
 * (0.0.0.0), so a bind succeeding is NOT proof that clients reach the
 * process that bound it: loopback traffic goes to the most specific
 * listener. A `/health` 200 from the squatter must never be read as
 * success — the listener pid is the fact that settles it.
 *
 * The probe is PORT-WIDE on purpose (not address-filtered): a foreign
 * 127.0.0.1 listener must be visible to a service holding the wildcard.
 * A `null` return declares "this platform/tool has no probe" — callers
 * must never treat that as "port is free".
 */

export interface ListenerOwner {
  readonly pid: number;
  readonly command: string;
}

export type ListenerProbe = (host: string, port: number) => Promise<readonly ListenerOwner[] | null>;

/** Slack above lsof's own work; the probe is a boot/preflight step. */
const LSOF_TIMEOUT_MS = 5_000;

/** Platform probe: lsof on macOS, /proc on Linux, null elsewhere. */
export async function defaultListenerProbe(
  host: string,
  port: number,
): Promise<readonly ListenerOwner[] | null> {
  void host; // port-wide by design — see the module note
  if (process.platform === 'darwin') return lsofListeners(port);
  if (process.platform === 'linux') return procListeners(port);
  return null;
}

/** First listener on the port that is not `selfPid`; null when the probe
 * found none or is unavailable. */
export async function foreignListener(input: {
  readonly probe: ListenerProbe;
  readonly host: string;
  readonly port: number;
  readonly selfPid: number;
}): Promise<ListenerOwner | null> {
  const owners = await input.probe(input.host, input.port);
  if (owners === null) return null;
  return owners.find((owner) => owner.pid !== input.selfPid) ?? null;
}

/** All listeners on `port` via lsof; [] when none; null when unusable.
 * Async on purpose: the probe runs on the boot path and must never block
 * the event loop while lsof walks the process table. */
function lsofListeners(port: number): Promise<readonly ListenerOwner[] | null> {
  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'],
      { encoding: 'utf-8', timeout: LSOF_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          // lsof exits 1 when there is nothing to report — a clean empty answer.
          if ((error as { status?: number }).status === 1) resolve([]);
          else resolve(null); // ENOENT / timeout / anything else: declared gap
          return;
        }
        const owners = new Map<number, string>();
        let pid: number | null = null;
        let command = '';
        for (const line of stdout.split('\n')) {
          if (line.startsWith('p')) {
            pid = Number(line.slice(1));
            command = '';
          } else if (line.startsWith('c') && pid !== null) {
            command = line.slice(1);
          } else if (line.startsWith('n') && pid !== null && Number.isInteger(pid)) {
            owners.set(pid, command);
          }
        }
        resolve([...owners].map(([ownerPid, ownerCommand]) => ({ pid: ownerPid, command: ownerCommand })));
      },
    );
  });
}

/** All listeners on `port` via /proc (Linux); [] when none; null when the
 * tcp tables or /proc are unreadable. */
function procListeners(port: number): readonly ListenerOwner[] | null {
  const inodes = new Set<string>();
  let readable = false;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
      readable = true;
    } catch {
      continue;
    }
    for (const line of text.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      const local = parts[1];
      const state = parts[3];
      const inode = parts[9];
      if (state !== '0A' || local === undefined || inode === undefined) continue; // 0A = LISTEN
      const localPort = local.split(':')[1];
      if (localPort === undefined) continue;
      if (Number.parseInt(localPort, 16) === port) inodes.add(inode);
    }
  }
  if (!readable) return null;
  if (inodes.size === 0) return [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  const owners: ListenerOwner[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // kernel threads / other users: not ours to inspect
    }
    let matched = false;
    for (const fd of fds) {
      try {
        const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const match = /^socket:\[(\d+)\]$/.exec(link);
        if (match !== null && match[1] !== undefined && inodes.has(match[1])) {
          matched = true;
          break;
        }
      } catch {
        /* fd closed mid-scan */
      }
    }
    if (matched) owners.push({ pid, command: readPidCommand(pid) });
  }
  return owners;
}

function readPidCommand(pid: number): string {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    const joined = raw.replaceAll('\0', ' ').trim();
    if (joined !== '') return joined;
  } catch {
    /* fall through to comm */
  }
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
  } catch {
    return '';
  }
}
