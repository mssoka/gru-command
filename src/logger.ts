import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly [key: string]: unknown;
}

/**
 * Structured JSON-lines logger. One JSON object per line, written to
 * `<data_dir>/logs/service.log` and mirrored to stderr. Synchronous writes:
 * nothing is lost at shutdown.
 */
export class Logger {
  private readonly logFile: string;

  constructor(
    readonly dataDir: string,
    private readonly mirrorToStderr: boolean = true,
  ) {
    const logsDir = join(dataDir, 'logs');
    mkdirSync(logsDir, { recursive: true });
    this.logFile = join(logsDir, 'service.log');
  }

  log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...fields,
    };
    const line = `${JSON.stringify(record)}\n`;
    appendFileSync(this.logFile, line, 'utf-8');
    if (this.mirrorToStderr) {
      process.stderr.write(line);
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
}
