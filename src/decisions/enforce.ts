import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKTEST_SURFACES } from './cases/registry.js';
import type { SurfaceMode } from './types.js';

/**
 * The enforce gate (issue #223): a surface may only run `enforce` on the
 * strength of a RECORDED backtest result that meets its stated threshold.
 * The evidence lives at `<data_dir>/decisions/backtests/<surface>.json`
 * and is produced by the `backtest` CLI. Without honest, meeting
 * evidence the request fails loud — never a silent deterministic
 * downgrade that an operator would read as a healthy enforce.
 */

export const BACKTEST_RECORD_SCHEMA_VERSION = 2;

/** The threshold statement inside a backtest record: metric + optional
 * per-class label + the minimum acceptable value. */
export interface BacktestThreshold {
  readonly metric: 'agreement' | 'precision' | 'recall';
  /** Per-class metrics are keyed by label; null targets the headline
   * scalar (agreement) or the actionable class (precision/recall). */
  readonly label: string | null;
  readonly min: number;
}

/** One recorded backtest result, as the `backtest` CLI writes it. */
export interface BacktestRecord {
  readonly schemaVersion: number;
  readonly surface: string;
  readonly provider: string;
  readonly model: string | null;
  /** The model requested by the configured profile when evidence was earned. */
  readonly configuredModel: string;
  readonly n: number;
  /** Share of cases where the provider's would-be action matched the
   * deterministic baseline's action. */
  readonly agreement: number;
  /** One-vs-rest precision/recall per label, plus the actionable class
   * headline when the surface declares one. */
  readonly precision: Readonly<Record<string, number>> & { readonly actionable?: number };
  readonly recall: Readonly<Record<string, number>> & { readonly actionable?: number };
  readonly actionable_label: string | null;
  readonly threshold: BacktestThreshold;
  /** Recomputed at record time; the gate re-evaluates it and never
   * trusts this flag alone. */
  readonly met: boolean;
  readonly generatedAt: string;
  readonly costUsd: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
}

export function backtestRecordPath(dataDir: string, surface: string): string {
  if (!/^[a-z0-9_]+$/u.test(surface)) {
    throw new Error(`decision surface name is not a safe backtest record key: ${JSON.stringify(surface)}`);
  }
  return join(dataDir, 'decisions', 'backtests', `${surface}.json`);
}

/** Evaluate one parsed record's threshold honestly. Pure. */
export function backtestMeetsThreshold(record: BacktestRecord): boolean {
  const { metric, label, min } = record.threshold;
  if (!(Number.isFinite(min) && min >= 0 && min <= 1)) return false;
  if (record.n < 1) return false;
  let value: number | undefined;
  if (metric === 'agreement') {
    value = record.agreement;
  } else if (label !== null) {
    value = record[metric][label];
  } else {
    value = record[metric].actionable;
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

export class EnforceGateError extends Error {
  readonly surface: string;
  constructor(surface: string, message: string) {
    super(message);
    this.name = 'EnforceGateError';
    this.surface = surface;
  }
}

function parseRecord(raw: string, path: string, surface: string): BacktestRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new EnforceGateError(surface, `enforce gate: backtest record at ${path} is not valid JSON: ${String(error)}`);
  }
  const r = parsed as Partial<BacktestRecord>;
  if (
    typeof parsed !== 'object' || parsed === null ||
    r.schemaVersion !== BACKTEST_RECORD_SCHEMA_VERSION ||
    typeof r.surface !== 'string' || r.surface !== surface ||
    typeof r.provider !== 'string' || r.provider.trim() === '' ||
    typeof r.configuredModel !== 'string' || r.configuredModel.trim() === '' ||
    typeof r.n !== 'number' || !Number.isSafeInteger(r.n) || r.n < 1 ||
    typeof r.agreement !== 'number' || !(r.agreement >= 0 && r.agreement <= 1) ||
    typeof r.precision !== 'object' || r.precision === null ||
    typeof r.recall !== 'object' || r.recall === null ||
    typeof r.threshold !== 'object' || r.threshold === null ||
    typeof r.threshold.metric !== 'string' ||
    !['agreement', 'precision', 'recall'].includes(r.threshold.metric) ||
    typeof r.threshold.min !== 'number' ||
    typeof r.generatedAt !== 'string' ||
    typeof r.costUsd !== 'number' ||
    typeof r.latencyMs?.p50 !== 'number' || typeof r.latencyMs?.p95 !== 'number'
  ) {
    throw new EnforceGateError(
      surface,
      `enforce gate: backtest record at ${path} does not match schema v${BACKTEST_RECORD_SCHEMA_VERSION}; regenerate it with the decisions backtest CLI`,
    );
  }
  return parsed as BacktestRecord;
}

/**
 * Read + validate the enforce evidence for one surface. Throws
 * {@link EnforceGateError} — with a message a stranger can act on — when
 * the record is missing, malformed, for another provider, or fails its
 * own stated threshold. The routed provider must match the recorded one:
 * evidence earned on one profile never licenses another to enforce.
 */
export function assertEnforceGate(input: {
  readonly dataDir: string;
  readonly surface: string;
  readonly provider: string;
  readonly model: string;
}): BacktestRecord {
  if (!BACKTEST_SURFACES.includes(input.surface)) {
    throw new EnforceGateError(input.surface, `enforce gate: surface "${input.surface}" has no registered backtest; use mode = "off" or "shadow" until labelled cases and a backtest are available`);
  }
  const path = backtestRecordPath(input.dataDir, input.surface);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new EnforceGateError(
      input.surface,
      `enforce gate: surface "${input.surface}" cannot switch to enforce without a recorded backtest that meets its stated threshold. ` +
      `Expected evidence at ${path}; produce it with:\n` +
      `  node dist/decisions/cli.js backtest --surface ${input.surface} --profile ${input.provider} --cases <jsonl> --threshold <min> --save\n` +
      'Deterministic behavior stays available via mode = "off".',
    );
  }
  const record = parseRecord(raw, path, input.surface);
  if (record.provider !== input.provider) {
    throw new EnforceGateError(
      input.surface,
      `enforce gate: surface "${input.surface}" is routed to profile "${input.provider}" but the recorded backtest at ${path} was earned on "${record.provider}". Evidence for one profile never licenses another; rerun the backtest on "${input.provider}".`,
    );
  }
  if (record.configuredModel !== input.model) {
    throw new EnforceGateError(
      input.surface,
      `enforce gate: surface "${input.surface}" is configured for model "${input.model}" but evidence at ${path} was earned on "${record.configuredModel}"; rerun the backtest`,
    );
  }
  if (!backtestMeetsThreshold(record)) {
    throw new EnforceGateError(
      input.surface,
      `enforce gate: the recorded backtest for surface "${input.surface}" (${path}) does not meet its stated threshold ` +
      `${record.threshold.metric}${record.threshold.label === null ? '' : `(${record.threshold.label})`} >= ${record.threshold.min}; ` +
      'rerun the backtest or lower the threshold in the recorded evidence.',
    );
  }
  return record;
}

/** The mode a surface runs in: the explicit config mode, or the pre-#223
 * legacy behavior when omitted (provider answer, no gate). */
export function effectiveSurfaceMode(entry: { readonly mode?: SurfaceMode } | undefined): SurfaceMode | null {
  return entry?.mode ?? null;
}
