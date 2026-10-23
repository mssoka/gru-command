import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly [key: string]: unknown;
}

/** Default rotation policy: rotate at 10 MB, keep 5 rotated files. */
export const LOG_ROTATION_DEFAULTS = { maxBytes: 10_485_760, keep: 5 } as const;

let stderrErrorsGuarded = false;

/**
 * One process-wide 'error' listener on stderr (#496). A failed stderr
 * write (ENOSPC/EDQUOT on launchd's StandardErrorPath, EPIPE on a closed
 * pipe) arrives as an asynchronous 'error' event; unheard, it becomes an
 * uncaught exception and main.ts exits the service on the very line that
 * reported the problem. The mirror is best-effort: service.log stays the
 * record.
 */
function guardStderrErrors(): void {
  if (stderrErrorsGuarded) return;
  stderrErrorsGuarded = true;
  process.stderr.on('error', () => {
    /* best-effort mirror — service.log stays the record */
  });
}

/**
 * Structured JSON-lines logger. One JSON object per line, written to
 * `<data_dir>/logs/service.log` and mirrored to stderr. Synchronous writes:
 * nothing is lost at shutdown.
 *
 * `log()` never throws for anything in `fields` (#496): an unserializable
 * field is dropped and named (see serializeRecord), and rotation, the
 * append and the stderr mirror each fail on their own without stopping
 * the others or reaching the call site.
 *
 * Size-based rotation (E1 deferral, E7 home): when the live file exceeds
 * `maxBytes` BEFORE a write, it rotates to `service.log.1` (shifting
 * older shards up, pruning past `keep`). Rotation checks are cheap —
 * one statSync per line — and a failed rotation never blocks the write.
 */
export class Logger {
  private readonly logFile: string;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(
    readonly dataDir: string,
    private readonly mirrorToStderr: boolean = true,
    rotation: { maxBytes?: number; keep?: number } = {},
  ) {
    const logsDir = join(dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    this.logFile = join(logsDir, 'service.log');
    this.maxBytes = rotation.maxBytes ?? LOG_ROTATION_DEFAULTS.maxBytes;
    this.keep = rotation.keep ?? LOG_ROTATION_DEFAULTS.keep;
    if (mirrorToStderr) guardStderrErrors();
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    const line = `${serializeRecord(level, msg, fields)}\n`;
    try {
      this.rotateIfNeeded(line.length);
    } catch {
      /* a failed rotation never blocks the write */
    }
    try {
      appendFileSync(this.logFile, line, 'utf-8');
    } catch {
      // Disk-full or permissions must never take the serving process down;
      // the best-effort stderr mirror below may still carry the line.
    }
    if (this.mirrorToStderr) {
      try {
        process.stderr.write(line);
      } catch {
        /* best-effort mirror — an async failure lands on guardStderrErrors */
      }
    }
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.log('debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.log('warn', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.log('error', msg, fields);
  }

  /**
   * Rotate before the incoming line would push the live file past the
   * cap: service.log.{keep-1}…service.log.1 shift up one slot, the live
   * file becomes .1, and the next append starts a fresh file. Shard n is
   * NEWER than shard n+1 (1 = most recent rotated).
   */
  private rotateIfNeeded(incomingBytes: number): void {
    let size: number;
    try {
      size = statSync(this.logFile).size;
    } catch {
      return; // no live file yet — nothing to rotate
    }
    if (size + incomingBytes <= this.maxBytes) return;
    const dir = join(this.logFile, '..');
    let names: string[];
    try {
      names = readdirSync(dir).filter((name) => /^service\.log(\.\d+)?$/.test(name));
    } catch {
      return; // a failed rotation NEVER blocks the write — append as-is
    }
    const shards = names
      .map((name) => /^service\.log\.(\d+)$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((a, b) => b - a); // highest slot first
    // Prune the oldest first so a shift never collides.
    for (const slot of shards) {
      if (slot >= this.keep) {
        try {
          rmSync(join(dir, `service.log.${slot}`), { force: true });
        } catch {
          /* best effort */
        }
      }
    }
    for (const slot of shards) {
      if (slot >= this.keep) continue;
      try {
        renameSync(join(dir, `service.log.${slot}`), join(dir, `service.log.${slot + 1}`));
      } catch {
        /* best effort */
      }
    }
    try {
      renameSync(this.logFile, join(dir, 'service.log.1'));
    } catch {
      /* best effort — the append still goes to the live file */
    }
  }
}

/**
 * One JSON line for the record. Reserved keys go last, so a call site can
 * never overwrite ts/level/msg, and `toJSON: undefined` disarms an own
 * toJSON field that would otherwise replace the whole line (undefined keys
 * never reach the output). A field that cannot be serialized (a BigInt, a
 * cycle, a throwing getter or toJSON) is dropped and named with its reason
 * under `fields_unserializable`; the other fields still land. If even that
 * fails, the line keeps ts/level/msg alone.
 */
function serializeRecord(level: LogLevel, msg: string, fields: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  try {
    const record: LogRecord = { ...fields, toJSON: undefined, ts, level, msg };
    return JSON.stringify(record);
  } catch {
    /* salvage field by field below */
  }
  try {
    const kept: Record<string, unknown> = {};
    const unserializable: Record<string, string> = {};
    for (const key of Object.keys(fields)) {
      try {
        const value = fields[key];
        JSON.stringify(value);
        kept[key] = value;
      } catch (error) {
        unserializable[key] = error instanceof Error ? error.message : String(error);
      }
    }
    const record: LogRecord = { ...kept, toJSON: undefined, ts, level, msg, fields_unserializable: unserializable };
    return JSON.stringify(record);
  } catch {
    const lastResort: LogRecord = { ts, level, msg, fields_unserializable: 'unknown' };
    return JSON.stringify(lastResort);
  }
}
