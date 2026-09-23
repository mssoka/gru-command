import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Self-roll record (graceful self-roll, issue #34 graduation heist).
 *
 * Two files carry the roll across the process boundary:
 *
 *  - `<data_dir>/roll-state.json` — the state machine record the CLI and
 *    GET /api/roll read (preflight → drain → swap → verify → done/failed).
 *  - `<data_dir>/roll-marker.json` — the SWAP marker written immediately
 *    before the old process exits. The relaunched binary consumes it at
 *    boot: it logs "rolled to <sha>", marks the state record done, and
 *    clears the marker. The marker is the authority for adoption; the
 *    state record is bookkeeping.
 *
 * Writes are atomic (staging file + rename) so a CLI reader never sees a
 * torn record, and a corrupt record is surfaced by the typed error rather
 * than silently re-created.
 */

export const ROLL_RECORD_SCHEMA_VERSION = 1;

export type RollPhase = 'preflight' | 'drain' | 'swap' | 'verify' | 'done' | 'failed';

export interface RollPreflightRecord {
  readonly fromSha: string;
  readonly toSha: string;
  /** True when `git pull --ff-only` moved the checkout. */
  readonly pulled: boolean;
  /** True when dependencies were installed and the product rebuilt. */
  readonly rebuilt: boolean;
  /** Why the build was skipped (null when it ran). */
  readonly skippedBuildReason: string | null;
  readonly durationMs: number;
}

export interface RollWorkItem {
  readonly kind: 'round' | 'minion';
  readonly id: string;
  readonly status: string;
}

export interface RollDrainRecord {
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly waitedMs: number;
  readonly drained: boolean;
  readonly inFlightAtStart: readonly RollWorkItem[];
  readonly abandoned: readonly RollWorkItem[];
}

export interface RollErrorRecord {
  readonly phase: RollPhase;
  readonly detail: string;
}

export interface RollVerifyRecord {
  readonly at: string;
  readonly sha: string | null;
  readonly pid: number;
  readonly uptimeMs: number;
}

export interface RollState {
  readonly schemaVersion: number;
  readonly rollId: string;
  readonly phase: RollPhase;
  readonly reason: string | null;
  readonly requestedBy: string;
  readonly repoRoot: string;
  readonly fromSha: string | null;
  readonly toSha: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly preflight: RollPreflightRecord | null;
  readonly drain: RollDrainRecord | null;
  readonly error: RollErrorRecord | null;
  readonly verify: RollVerifyRecord | null;
}

export interface RollMarker {
  readonly schemaVersion: number;
  readonly rollId: string;
  readonly fromSha: string | null;
  readonly toSha: string;
  readonly markedAt: string;
  readonly reason: string | null;
  readonly requestedBy: string;
}

/** The record exists but cannot be trusted (never overwrite it silently). */
export class CorruptRollRecordError extends Error {
  constructor(
    readonly file: string,
    readonly detail: string,
  ) {
    super(`roll record is unreadable: ${file} (${detail}) — refusing to guess its contents`);
    this.name = 'CorruptRollRecordError';
  }
}

export function rollStatePath(dataDir: string): string {
  return join(dataDir, 'roll-state.json');
}

export function rollMarkerPath(dataDir: string): string {
  return join(dataDir, 'roll-marker.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (error) {
    throw new CorruptRollRecordError(file, `cannot read: ${String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CorruptRollRecordError(file, `invalid JSON: ${String(error)}`);
  }
}

/** Atomic JSON write: staging file in the same directory, then rename. */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const staging = `${file}.tmp-${process.pid}`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(staging, file);
}

const ROLL_PHASES: readonly RollPhase[] = ['preflight', 'drain', 'swap', 'verify', 'done', 'failed'];

function isRollState(value: unknown): value is RollState {
  if (!isRecord(value)) return false;
  return (
    value['schemaVersion'] === ROLL_RECORD_SCHEMA_VERSION &&
    typeof value['rollId'] === 'string' &&
    typeof value['phase'] === 'string' &&
    (ROLL_PHASES as readonly string[]).includes(value['phase'] as string)
  );
}

function isRollMarker(value: unknown): value is RollMarker {
  if (!isRecord(value)) return false;
  return (
    value['schemaVersion'] === ROLL_RECORD_SCHEMA_VERSION &&
    typeof value['rollId'] === 'string' &&
    typeof value['toSha'] === 'string'
  );
}

/** Read the roll state record; null when absent; throws when corrupt. */
export function readRollState(dataDir: string): RollState | null {
  const file = rollStatePath(dataDir);
  if (!existsSync(file)) return null;
  const parsed = readJsonFile(file);
  if (!isRollState(parsed)) throw new CorruptRollRecordError(file, 'unexpected shape');
  return parsed;
}

/** Persist the roll state record atomically. */
export function writeRollState(dataDir: string, state: RollState): void {
  writeJsonAtomic(rollStatePath(dataDir), state);
}

/** Apply a patch, refresh updatedAt, persist, and return the new record. */
export function updateRollState(
  dataDir: string,
  state: RollState,
  patch: Partial<Omit<RollState, 'schemaVersion' | 'rollId'>>,
  now: () => number = Date.now,
): RollState {
  const next: RollState = { ...state, ...patch, updatedAt: new Date(now()).toISOString() };
  writeRollState(dataDir, next);
  return next;
}

/** Read the swap marker; null when absent; throws when corrupt. */
export function readRollMarker(dataDir: string): RollMarker | null {
  const file = rollMarkerPath(dataDir);
  if (!existsSync(file)) return null;
  const parsed = readJsonFile(file);
  if (!isRollMarker(parsed)) throw new CorruptRollRecordError(file, 'unexpected shape');
  return parsed;
}

/** Persist the swap marker atomically. */
export function writeRollMarker(dataDir: string, marker: RollMarker): void {
  writeJsonAtomic(rollMarkerPath(dataDir), marker);
}

/** Clear the swap marker (adoption consumed it). */
export function clearRollMarker(dataDir: string): void {
  rmSync(rollMarkerPath(dataDir), { force: true });
}
