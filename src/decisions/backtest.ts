import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  effectiveDecisionProviders,
  type DecisionsConfig,
} from '../config.js';
import { resolveCredential } from './credentials.js';
import { ProfileDecisionService, ProfileProvider } from './provider.js';
import { KEYLESS_CREDENTIAL, validateProviderProfile } from './profile.js';
import type {
  Answer,
  AnswersFor,
  DecisionOutcome,
  DecisionRequest,
  DecisionRoute,
  QuestionSet,
} from './types.js';
import { requestFromCase, surfaceCaseSpec, type LabelledCase } from './cases/registry.js';
import { BACKTEST_RECORD_SCHEMA_VERSION, backtestMeetsThreshold, type BacktestRecord, type BacktestThreshold } from './enforce.js';

/**
 * The backtest harness (issue #223): replay labelled history cases for a
 * surface through any provider profile (#222) and through the
 * deterministic baseline, and report the comparison — agreement with the
 * baseline, precision/recall of the action that would be taken,
 * confidence calibration, cost and latency. `--record` persists raw
 * provider responses so later runs (and the deterministic test suite)
 * can replay them offline with no provider access.
 */

export interface BacktestActionCounts {
  readonly act: { readonly predicted: number; readonly correct: number };
  readonly defer: { readonly predicted: number; readonly correct: number };
}

export interface BacktestReport {
  readonly schemaVersion: number;
  readonly surface: string;
  readonly provider: string;
  readonly model: string | null;
  /** Configured request model, not the provider's optional response alias. */
  readonly configuredModel: string;
  readonly n: number;
  /** Share of cases where the action served matches the deterministic baseline. */
  readonly agreement: number;
  /** Action confusion: predictions and correct predictions per action. */
  readonly actions: BacktestActionCounts;
  /** One-vs-rest precision/recall per action class; `actionable` is the
   * surface's actionable class headline. */
  readonly precision: Readonly<Record<string, number>> & { readonly actionable: number };
  readonly recall: Readonly<Record<string, number>> & { readonly actionable: number };
  readonly actionable_label: string;
  /** Calibration buckets over the calibration question's routed metric:
   * bucket = [lo, hi), plus the mean correctness inside it. Well
   * calibrated providers show correctness rising with the bucket. */
  readonly calibration: readonly { readonly lo: number; readonly hi: number; readonly n: number; readonly meanCorrect: number }[];
  readonly costUsd: number;
  readonly latencyMs: { readonly p50: number; readonly p95: number };
  readonly replayed: boolean;
  readonly recordedDir: string | null;
  readonly generatedAt: string;
}

// ------------------------------------------------------------------
// Record / replay fetch wrappers
// ------------------------------------------------------------------

export function recordedResponseHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

interface RecordedResponse {
  readonly schemaVersion: number;
  readonly status: number;
  readonly body: string;
}

function responseStub(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** Fetch wrapper that transparently records raw provider responses under
 * `<dir>/<sha256-of-request-body>.json`. Headers (credentials) are never
 * recorded — only the response status and body. */
export function recordingFetch(dir: string, inner: typeof globalThis.fetch): typeof globalThis.fetch {
  mkdirSync(dir, { recursive: true });
  return async (input, init) => {
    const response = await inner(input, init);
    const body = await response.text();
    const bodyForHash = typeof init?.body === 'string' ? init.body : '';
    const hash = recordedResponseHash(bodyForHash);
    const path = join(dir, `${hash}.json`);
    const record: RecordedResponse = { schemaVersion: 1, status: response.status, body };
    const staged = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(staged, path);
    return responseStub(response.status, body);
  };
}

/** Fetch wrapper that serves previously recorded responses by request
 * hash. A missing recording fails loud: replaying must never silently
 * invent a provider answer. */
export function replayingFetch(dir: string): typeof globalThis.fetch {
  return async (_input, init) => {
    const bodyForHash = typeof init?.body === 'string' ? init.body : '';
    const hash = recordedResponseHash(bodyForHash);
    const path = join(dir, `${hash}.json`);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      throw new Error(
        `replay miss: no recorded provider response for request hash ${hash} at ${path}; run the backtest with --record first`,
      );
    }
    let parsed: RecordedResponse;
    try {
      parsed = JSON.parse(raw) as RecordedResponse;
    } catch (error) {
      throw new Error(`replay recording at ${path} is not valid JSON: ${String(error)}`);
    }
    if (parsed.schemaVersion !== 1 || typeof parsed.status !== 'number' || typeof parsed.body !== 'string') {
      throw new Error(`replay recording at ${path} does not match the recording schema`);
    }
    return responseStub(parsed.status, parsed.body);
  };
}

// ------------------------------------------------------------------
// Metrics
// ------------------------------------------------------------------

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function servedAnswers<Q extends QuestionSet>(request: DecisionRequest<Q>, outcome: DecisionOutcome<Q>): AnswersFor<Q> {
  return Object.fromEntries(Object.keys(request.questions).map((id) => [
    id,
    outcome.routes[id]?.path === 'fallback' ? request.fallback[id] : outcome.answers[id],
  ])) as AnswersFor<Q>;
}

// ------------------------------------------------------------------
// Run
// ------------------------------------------------------------------

export interface BacktestRunOptions {
  readonly surface: string;
  readonly profileName: string;
  readonly cases: readonly LabelledCase[];
  readonly config: DecisionsConfig;
  readonly instanceDir: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Direct fetch seam for tests. Ignored when replayDir is set. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Persist raw provider responses here for later offline replay. */
  readonly recordDir?: string;
  /** Serve provider responses from previously recorded files. */
  readonly replayDir?: string;
  readonly now?: () => Date;
}

/** Build the profile-backed service for a backtest run, mirroring the
 * runtime's construction rules. Replay runs accept a stub key when no
 * real credential is present — the replayer owns the wire, so the key is
 * never sent anywhere. */
export function buildBacktestService(input: BacktestRunOptions): {
  readonly service: ProfileDecisionService;
} {
  const profile = effectiveDecisionProviders(input.config)[input.profileName];
  if (profile === undefined) {
    const available = Object.keys(effectiveDecisionProviders(input.config)).join(', ');
    throw new Error(`unknown decision profile "${input.profileName}" (available: ${available})`);
  }
  validateProviderProfile(profile, `decisions.providers.${input.profileName}`);
  let key: string | null = null;
  if (profile.credential !== KEYLESS_CREDENTIAL) {
    const credential = resolveCredential(input.instanceDir, input.env ?? process.env, profile.credential);
    if (credential.state === 'present' && credential.key !== undefined) {
      key = credential.key;
    } else if (input.replayDir === undefined) {
      throw new Error(
        `profile "${input.profileName}" has no resolvable ${profile.credential} credential; live backtests need it (replay runs may omit it)`,
      );
    } else {
      key = '__gru_replay_stub__';
    }
  }
  const fetchImpl =
    input.replayDir !== undefined
      ? replayingFetch(input.replayDir)
      : input.recordDir !== undefined
        ? recordingFetch(input.recordDir, input.fetchImpl ?? globalThis.fetch)
        : input.fetchImpl;
  const service = new ProfileDecisionService(
    new ProfileProvider({ profile, key, credentialMode: 'resolved', ...(fetchImpl !== undefined ? { fetchImpl } : {}) }),
    input.config.thresholds,
    input.profileName,
  );
  return { service };
}

/** Run the backtest over the given labelled cases. Pure over its inputs
 * aside from the optional recording directory. */
export async function runBacktest(input: BacktestRunOptions): Promise<BacktestReport> {
  const spec = surfaceCaseSpec(input.surface);
  if (input.cases.length === 0) {
    throw new Error(`backtest for surface "${input.surface}" has no labelled cases; extract them first (decisions cli extract-cases)`);
  }
  const labelVocabulary = new Set(spec.labels);
  for (const testCase of input.cases) {
    if (!labelVocabulary.has(testCase.label)) {
      throw new Error(
        `backtest case ${JSON.stringify(testCase.id)} carries label ${JSON.stringify(testCase.label)} outside the ${input.surface} vocabulary (${spec.labels.join(', ')})`,
      );
    }
  }
  const { service } = buildBacktestService(input);
  try {
    const configuredModel = effectiveDecisionProviders(input.config)[input.profileName]!.model;
    let agree = 0;
    const actions = {
      act: { predicted: 0, correct: 0 },
      defer: { predicted: 0, correct: 0 },
    };
    const latencies: number[] = [];
    let cost = 0;
    let model: string | null = null;
    const calibrationBuckets = Array.from({ length: 5 }, (_, bucket) => ({ lo: bucket * 0.2, hi: (bucket + 1) * 0.2, n: 0, correct: 0 }));

    for (const [caseIndex, testCase] of input.cases.entries()) {
      const request = requestFromCase(spec, testCase.state);
      const outcome = await service.decide(request);
      // A provider miss is never evidence that the provider earned enforce.
      // Replay misses additionally indicate an incomplete recording set.
      if (outcome.provenance.source !== 'jev') {
        throw new Error(input.replayDir !== undefined
          ? `replay run produced a fallback for case ${JSON.stringify(testCase.id)} (index ${caseIndex}); the recording set is incomplete — rerun with --record over the same cases/config`
          : `live backtest provider fell back for case ${JSON.stringify(testCase.id)} (index ${caseIndex}); fix the provider and rerun before saving enforce evidence`);
      }
      const predicted = spec.answerAction(servedAnswers(request, outcome) as Record<string, Answer>);
      if (predicted === spec.answerAction(request.fallback as Record<string, Answer>)) agree += 1;
      const actual = spec.labelAction(testCase.label);
      actions[predicted].predicted += 1;
      if (predicted === actual) actions[predicted].correct += 1;
      latencies.push(outcome.provenance.latencyMs);
      if (outcome.provenance.usage?.costUsd !== null && outcome.provenance.usage?.costUsd !== undefined) {
        cost += outcome.provenance.usage.costUsd;
      }
      if (model === null) model = outcome.provenance.model;
      const route = (outcome.routes as unknown as Readonly<Record<string, DecisionRoute>>)[spec.calibrationQuestion]!;
      const bucketIndex = Math.min(calibrationBuckets.length - 1, Math.max(0, Math.floor(route.metric * calibrationBuckets.length)));
      const bucket = calibrationBuckets[bucketIndex]!;
      bucket.n += 1;
      if (predicted === actual) bucket.correct += 1;
    }

    const actionableAction = spec.labelAction(spec.actionableLabel);
    const otherAction = actionableAction === 'act' ? 'defer' : 'act';
    const precisionBase: Record<string, number> = {
      [actionableAction]: ratio(actions[actionableAction].correct, actions[actionableAction].predicted),
      [otherAction]: ratio(actions[otherAction].correct, actions[otherAction].predicted),
    };
    const precision = { ...precisionBase, actionable: precisionBase[actionableAction]! };
    const recallDenominator = {
      [actionableAction]: input.cases.filter((testCase) => spec.labelAction(testCase.label) === actionableAction).length,
      [otherAction]: input.cases.filter((testCase) => spec.labelAction(testCase.label) === otherAction).length,
    };
    const recallBase: Record<string, number> = {
      [actionableAction]: ratio(actions[actionableAction].correct, recallDenominator[actionableAction]!),
      [otherAction]: ratio(actions[otherAction].correct, recallDenominator[otherAction]!),
    };
    const recall = { ...recallBase, actionable: recallBase[actionableAction]! };
    const sortedLatencies = [...latencies].sort((a, b) => a - b);

    return {
      schemaVersion: BACKTEST_RECORD_SCHEMA_VERSION,
      surface: input.surface,
      provider: input.profileName,
      model,
      configuredModel,
      n: input.cases.length,
      agreement: ratio(agree, input.cases.length),
      actions,
      precision,
      recall,
      actionable_label: spec.actionableLabel,
      calibration: calibrationBuckets.map(({ lo, hi, n, correct }) => ({ lo, hi, n, meanCorrect: ratio(correct, n) })),
      costUsd: cost,
      latencyMs: { p50: quantile(sortedLatencies, 0.5), p95: quantile(sortedLatencies, 0.95) },
      replayed: input.replayDir !== undefined,
      recordedDir: input.recordDir ?? null,
      generatedAt: (input.now ?? ((): Date => new Date()))().toISOString(),
    };
  } finally {
    service.dispose();
  }
}

// ------------------------------------------------------------------
// Record save / load (the enforce gate's evidence)
// ------------------------------------------------------------------

/** Assemble the durable enforce-gate record from a report and a stated
 * threshold; `met` is recomputed, never trusted from the caller. */
export function backtestRecordFromReport(
  report: BacktestReport,
  threshold: BacktestThreshold,
): BacktestRecord {
  const record: BacktestRecord = {
    schemaVersion: report.schemaVersion,
    surface: report.surface,
    provider: report.provider,
    model: report.model,
    configuredModel: report.configuredModel,
    n: report.n,
    agreement: report.agreement,
    precision: report.precision,
    recall: report.recall,
    actionable_label: report.actionable_label,
    threshold,
    met: false,
    generatedAt: report.generatedAt,
    costUsd: report.costUsd,
    latencyMs: report.latencyMs,
  };
  return { ...record, met: backtestMeetsThreshold(record) };
}

export function saveBacktestRecord(dataDir: string, record: BacktestRecord): string {
  const dir = join(dataDir, 'decisions', 'backtests');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.surface}.json`);
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(staged, path);
  return path;
}

/** JSONL case file IO, shared by the extract and backtest CLIs. */
export function readCasesJsonl(path: string): LabelledCase[] {
  const raw = readFileSync(path, 'utf8');
  const cases: LabelledCase[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${path}:${index + 1} is not valid JSONL: ${String(error)}`);
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error(`${path}:${index + 1} is not a labelled case object`);
    const c = parsed as Record<string, unknown>;
    if (typeof c['id'] !== 'string' || typeof c['state'] !== 'string' || typeof c['label'] !== 'string') {
      throw new Error(`${path}:${index + 1} must carry string id, state and label`);
    }
    cases.push({ id: c['id'], state: c['state'], label: c['label'] });
  }
  return cases;
}

export function writeCasesJsonl(path: string, cases: readonly LabelledCase[]): void {
  const body = cases.map((testCase) => JSON.stringify(testCase)).join('\n');
  const staged = `${path}.${process.pid}.tmp`;
  writeFileSync(staged, body === '' ? '' : `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(staged, path);
}

/** Case files the extract CLI wrote, by surface convention. */
export function defaultCasesPath(dataDir: string, surface: string): string {
  return join(dataDir, 'decisions', 'cases', `${surface}.jsonl`);
}

/** Number of recorded response files in a recording directory, for the
 * CLI's run summaries. */
export function countRecordedResponses(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}
