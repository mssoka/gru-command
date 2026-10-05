#!/usr/bin/env node
/**
 * Yield telemetry report (#214) — read-only aggregation of what machine
 * turns cost and achieve. Opens the ledger with node:sqlite in readOnly
 * mode (never writes, never migrates) and streams pi session JSONL from
 * the per-role trees under `<data_dir>/sessions/` (gru, silas, bob,
 * perkins, minion; every .jsonl at any depth), skipping
 * `sessions/backups/`. Output carries counts and bounded
 * identifiers only — never prompt or transcript text.
 */
import { createReadStream, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { loadConfig } from '../config.js';
import {
  buildYieldReport,
  parseSessionLines,
  renderTextReport,
  REPORT_EVENT_KINDS,
  SESSION_ROLES,
  sweepSignaturesOf,
  windowTurns,
  type LedgerEventRecord,
  type NotificationRecordLite,
  type JobRecordLite,
  type ParseSkips,
  type ParsedTurn,
  type SessionRole,
  type YieldReport,
} from '../telemetry/yield.js';

const USAGE =
  'usage: node dist/cli/yield-report.js --since <iso> [--until <iso>] [--data-dir <path>] [--json]';

interface ParsedArgs {
  readonly since: string | null;
  readonly until: string | null;
  readonly dataDir: string | null;
  readonly json: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: { since: string | null; until: string | null; dataDir: string | null; json: boolean } = {
    since: null,
    until: null,
    dataDir: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--since') {
      parsed.since = requireValue(argv, (i += 1), arg);
    } else if (arg === '--until') {
      parsed.until = requireValue(argv, (i += 1), arg);
    } else if (arg === '--data-dir') {
      parsed.dataDir = requireValue(argv, (i += 1), arg);
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return parsed;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value\n${USAGE}`);
  return value;
}

export function requireIso(value: string, flag: string): string {
  // Date.parse alone accepts junk like "2026"; the flags contract is an
  // ISO timestamp with time and zone.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)) {
    throw new Error(`${flag} must be an ISO timestamp with time and zone, got: ${value}`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${flag} must be an ISO timestamp, got: ${value}`);
  return new Date(parsed).toISOString();
}

// ------------------------------------------------------------------
// Session discovery + streaming
// ------------------------------------------------------------------

interface SessionFile {
  readonly role: SessionRole;
  readonly path: string;
}

export function listSessionFiles(dataDir: string): SessionFile[] {
  const sessionsRoot = join(dataDir, 'sessions');
  const files: SessionFile[] = [];
  for (const role of SESSION_ROLES) {
    const roleDir = join(sessionsRoot, role);
    let entries: string[];
    try {
      entries = readdirSync(roleDir, { recursive: true, encoding: 'utf8' });
    } catch (error) {
      // A role with no sessions yet is not an error; any other failure
      // (permissions, I/O) must fail loud — a silently missing role would
      // understate the report without a trace.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const segments = entry.split(/[\\/]/);
      if (segments.includes('backups')) continue;
      files.push({ role, path: join(roleDir, entry) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export interface CollectedSessions {
  readonly turns: ParsedTurn[];
  readonly skips: ParseSkips;
}

export async function collectTurns(files: readonly SessionFile[]): Promise<CollectedSessions> {
  const turns: ParsedTurn[] = [];
  let skips: ParseSkips = { unparsableLines: 0, unattributedCompactions: 0 };
  for (const file of files) {
    // Stream straight into the parser — no session file is ever held in
    // memory whole (the issue's "stream with readline" constraint).
    const readable = createReadStream(file.path, { encoding: 'utf8' });
    const linesRef = createInterface({ input: readable, crlfDelay: Infinity });
    const parsed = await parseSessionLines(file.role, linesRef);
    turns.push(...parsed.turns);
    skips = {
      unparsableLines: skips.unparsableLines + parsed.unparsableLines,
      unattributedCompactions: skips.unattributedCompactions + parsed.unattributedCompactions,
    };
  }
  return { turns, skips };
}

// ------------------------------------------------------------------
// Read-only ledger access
// ------------------------------------------------------------------

export interface LedgerData {
  readonly events: LedgerEventRecord[];
  readonly notifications: NotificationRecordLite[];
  readonly jobs: JobRecordLite[];
}

export function readLedger(dataDir: string): LedgerData {
  const dbPath = join(dataDir, 'ledger', 'ledger.db');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new Error(`cannot open ledger read-only at ${dbPath}: ${(error as Error).message}`);
  }
  try {
    const kinds = REPORT_EVENT_KINDS.map((kind) => `'${kind}'`).join(', ');
    const events = (
      db.prepare(`SELECT seq, ts, kind, job_id, payload FROM events WHERE kind IN (${kinds}) ORDER BY seq`).all() as Record<
        string,
        unknown
      >[]
    ).map((row) => ({
      seq: Number(row['seq']),
      ts: String(row['ts']),
      kind: String(row['kind']),
      jobId: row['job_id'] === null || row['job_id'] === undefined ? null : String(row['job_id']),
      payload: safeParse(row['payload']),
    }));
    const notifications = (
      db.prepare('SELECT id, kind FROM notifications').all() as Record<string, unknown>[]
    ).map((row) => ({ id: String(row['id']), kind: String(row['kind']) }));
    const jobs = (db.prepare('SELECT id, created_at FROM jobs').all() as Record<string, unknown>[]).map((row) => ({
      id: String(row['id']),
      createdAt: String(row['created_at']),
    }));
    return { events, notifications, jobs };
  } finally {
    db.close();
  }
}

function safeParse(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

export async function runYieldReport(argv: readonly string[], now: () => Date = (): Date => new Date()): Promise<number> {
  const args = parseArgs(argv);
  if (args.since === null) throw new Error(`--since <iso> is required\n${USAGE}`);
  const since = requireIso(args.since, '--since');
  const until = args.until === null ? now().toISOString() : requireIso(args.until, '--until');
  if (since >= until) throw new Error(`--since must be before --until (${since} >= ${until})`);

  const dataDir = args.dataDir ?? loadConfig().dataDir;
  const collected = await collectTurns(listSessionFiles(dataDir));
  const ledger = readLedger(dataDir);

  const windowed = windowTurns(collected.turns, since, until);
  const report = buildYieldReport({
    since,
    until,
    generatedAt: now().toISOString(),
    parseSkips: collected.skips,
    turns: windowed,
    // Signatures span the window boundary: the first in-window sweep
    // compares against the last sweep before the window.
    sweepSignatures: sweepSignaturesOf(collected.turns),
    ledger: { since, until, ...ledger },
  });

  process.stdout.write(jsonOutput(report, args.json));
  return 0;
}

function jsonOutput(report: YieldReport, json: boolean): string {
  return json ? `${JSON.stringify(report, null, 2)}\n` : `${renderTextReport(report)}\n`;
}

// ------------------------------------------------------------------
// CLI boundary
// ------------------------------------------------------------------

function sameFileAfterRealpath(a: string, b: string): boolean {
  try {
    return resolve(a) === resolve(b);
  } catch {
    return a === b;
  }
}

const invokedAsCli =
  process.argv[1] !== undefined &&
  sameFileAfterRealpath(process.argv[1], fileURLToPath(import.meta.url));

if (invokedAsCli) {
  runYieldReport(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`yield-report: ${String((error as Error).message ?? error)}\n`);
      process.exit(1);
    });
}
