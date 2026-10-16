import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import type { PropertyMetricsSnapshot } from '../property/types.js';

/**
 * Vector's raid records (#351), kept as append-only `vector.*` ledger events
 * and projected in memory. No table: a raid is a short, rare lifecycle, and
 * every decision in it (pick, proposal, Accept, Decline, withdrawal, launch)
 * is already an auditable fact the ledger records once.
 */

export const VECTOR_EVENTS = {
  /** Code offered Gru a candidate list (one Gru turn per distinct list). */
  planOffered: 'vector.plan-offered',
  /** Gru answered an offered list (zero or more picks). */
  planDecided: 'vector.plan-decided',
  /** A validated pick: one raid record is born. */
  picked: 'vector.raid-picked',
  /** The pick waits for the owner in FOR YOU (raid_mode "proposed"). */
  proposed: 'vector.raid-proposed',
  /** The owner declined; the target is not proposed again at this identity. */
  declined: 'vector.raid-declined',
  /** The target changed before a decision; the proposal is void. */
  withdrawn: 'vector.raid-withdrawn',
  /** The raid is launched: it waits in Silas's raid queue. */
  queued: 'vector.raid-queued',
  /** Silas started the raid at a default-branch head. */
  started: 'vector.raid-started',
  /** One attack's verdict and receipts. */
  round: 'vector.raid-round',
  /** A qualified counterexample a fresh replay confirmed. */
  breakIn: 'vector.break-in',
  /** The raid's terminal outcome and its report. */
  finished: 'vector.raid-finished',
  /** A break-in waits for the owner in FOR YOU (fix_mode "proposed"). */
  fixProposed: 'vector.fix-proposed',
  /** The owner declined the fix; the same contract is not proposed again at this identity. */
  fixDeclined: 'vector.fix-declined',
  /** The fix heist was dispatched through the normal dispatch path. */
  fixDispatched: 'vector.fix-dispatched',
} as const;

export const VECTOR_EVENT_KINDS: readonly string[] = Object.values(VECTOR_EVENTS);

/** One package in one managed repository. */
export interface RaidTarget {
  readonly repo: string;
  readonly packageDir: string;
}

/** Why code ranked a candidate where it did (shown to Gru and the owner). */
export interface RaidSignals {
  /** Commits touching the package since its last raid (all history when never raided). */
  readonly commitsSinceLastRaid: number;
  /** Break-ins earlier raids found on this target. */
  readonly escapedRegressions: number;
  /** Changes-requested Perkins verdicts on the repository's jobs since the last raid. */
  readonly perkinsFindings: number;
  /** Whole days since the target's last raid; null when never raided. */
  readonly daysSinceLastRaid: number | null;
}

export type RaidRequester = 'gru' | 'owner-chat';
export type RaidLaunch = 'owner-accept' | 'autonomous' | 'owner-chat';
export type RaidState = 'proposed' | 'declined' | 'withdrawn' | 'queued' | 'running' | 'finished';

/** The terminal outcome vocabulary (#351 §5). None of them is a pass. */
export const RAID_OUTCOMES = ['found', 'budget-exhausted', 'no-qualified-proposals', 'refused', 'unsupported', 'infrastructure-error', 'yielded', 'invalidated'] as const;
export type RaidOutcome = (typeof RAID_OUTCOMES)[number];

/** How a round ended, typed (#351 §3): never a pass of the code. */
export const ROUND_OUTCOMES = ['no-submission', 'invalid-attack', 'duplicate', 'rejected', 'pass', 'inconclusive', 'break-in'] as const;
export type RoundOutcome = (typeof ROUND_OUTCOMES)[number];

/** One attack as the ledger keeps it. */
export interface RaidRoundRecord {
  readonly round: number;
  readonly description: string | null;
  /** The typed round outcome: `inconclusive` is a failure a fresh replay did not reproduce (or a run that settled nothing). */
  readonly outcome: RoundOutcome;
  /** The qualification verdict, or the outcome when qualification never ran. */
  readonly verdict: string;
  readonly candidateOutcome: string | null;
  readonly replay: string | null;
  readonly artifactSha256: string | null;
  readonly executedRuns: number;
  /** Every host-issued receipt of the round (controls, attack, baseline, replay). */
  readonly receipts: readonly string[];
  /** When there are none: why (typed, never inferred). */
  readonly noReceiptReason: string | null;
  readonly detail: string;
}

export interface BreakInRecord {
  readonly id: string;
  readonly raidId: string;
  readonly target: RaidTarget;
  readonly headSha: string;
  readonly sourceIdentity: string;
  readonly description: string;
  readonly requirementRef: string;
  readonly invariant: string;
  readonly frozenSha256: string;
  readonly counterexample: string;
  readonly seed: string | null;
  readonly shrinkPath: readonly string[];
  /** Where the frozen contract, the test bytes and the receipts are kept. */
  readonly evidenceDir: string;
  readonly testPath: string;
  readonly testSha256: string;
  readonly receipts: readonly string[];
  readonly foundAt: string;
  readonly fix: {
    readonly state: 'proposed' | 'declined' | 'dispatched';
    readonly notificationId: string | null;
    readonly jobId: string | null;
    readonly launchedBy: RaidLaunch | null;
    readonly detail: string | null;
  } | null;
}

export interface RaidRecord {
  readonly id: string;
  readonly target: RaidTarget;
  /** Git tree id of the package at the default-branch head it was picked at. */
  readonly sourceIdentity: string;
  readonly headSha: string;
  readonly reason: string;
  readonly requestedBy: RaidRequester;
  readonly signals: RaidSignals;
  readonly pickedAt: string;
  readonly state: RaidState;
  /** The FOR YOU decision row, when the raid was proposed. */
  readonly notificationId: string | null;
  readonly launchedBy: RaidLaunch | null;
  readonly launchedAt: string | null;
  /** Why a proposal ended without a launch (decline or withdrawal). */
  readonly closedDetail: string | null;
  readonly startedAt: string | null;
  /** The default-branch head the raid actually ran at. */
  readonly runHeadSha: string | null;
  readonly rounds: readonly RaidRoundRecord[];
  readonly outcome: RaidOutcome | null;
  /** The user-facing label (never "pass"). */
  readonly outcomeLabel: string | null;
  readonly finishedAt: string | null;
  readonly reportFile: string | null;
  /** The raid's metrics as its report recorded them. */
  readonly metrics: RaidMetrics | null;
}

/**
 * Per-raid metrics (#351 §5). They extend #350's PropertyMetricsSnapshot:
 * actionable defects are break-ins, invalid oracles are qualification
 * rejections, unknown validity counts inconclusive rounds. Generated case
 * counts are never a measure.
 */
export interface RaidMetrics extends PropertyMetricsSnapshot {
  /** Attacks that reached qualification. */
  readonly proposals: number;
  readonly qualified: number;
  readonly rejectedByVerdict: Readonly<Record<string, number>>;
  readonly inconclusive: number;
  /** Submissions refused before qualification (an invalid attack, or an exact duplicate). */
  readonly invalidAttacks: number;
  readonly duplicates: number;
  readonly breakIns: number;
  readonly wallClockMs: number;
  /** Token usage the runtime reported (rounds that reported none are counted apart). */
  readonly tokens: number;
  readonly roundsWithoutTokenUsage: number;
}

/** Finished raids in a row with no break-in before a repository's spend is flagged. */
export const ZERO_BREAK_IN_FLAG_RAIDS = 5;

/** One repository's raid spend and yield across every raid that ran anything. */
export interface RepositoryRollup {
  readonly repo: string;
  readonly raids: number;
  readonly proposals: number;
  readonly qualified: number;
  readonly rejectedByVerdict: Readonly<Record<string, number>>;
  readonly invalidOracles: number;
  readonly invalidOracleRate: number | null;
  readonly executedRuns: number;
  readonly breakIns: number;
  readonly replayReliability: { readonly replayed: number; readonly reproduced: number };
  readonly wallClockMs: number;
  /** Tokens the runtime reported, and how many rounds reported none. */
  readonly tokens: number;
  readonly roundsWithoutTokenUsage: number;
  /** The headline metric: tokens per break-in, over raids whose every round reported usage (null when that leaves no break-in). */
  readonly costPerBreakIn: number | null;
  /** Raids since the last one that broke in (all of them when none did). */
  readonly raidsSinceLastBreakIn: number;
  /** Set once that streak reaches ZERO_BREAK_IN_FLAG_RAIDS. Turning raids off is the owner's call. */
  readonly flag: string | null;
}

/** A raid that actually spent: at least one sandboxed run. */
const SPENT = (raid: RaidRecord): boolean => raid.state === 'finished' && (raid.metrics?.executedRuns ?? 0) > 0;

export function repositoryRollups(raids: readonly RaidRecord[]): readonly RepositoryRollup[] {
  const byRepo = new Map<string, RaidRecord[]>();
  for (const raid of raids.filter(SPENT)) byRepo.set(raid.target.repo, [...(byRepo.get(raid.target.repo) ?? []), raid]);
  return [...byRepo.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([repo, list]) => {
    const ordered = [...list].sort((left, right) => Date.parse(left.finishedAt!) - Date.parse(right.finishedAt!));
    const metrics = ordered.map((raid) => raid.metrics!);
    const sum = (pick: (entry: RaidMetrics) => number): number => metrics.reduce((total, entry) => total + pick(entry), 0);
    const rejectedByVerdict: Record<string, number> = {};
    for (const entry of metrics) for (const [verdict, count] of Object.entries(entry.rejectedByVerdict)) rejectedByVerdict[verdict] = (rejectedByVerdict[verdict] ?? 0) + count;
    const breakIns = sum((entry) => entry.breakIns);
    const proposals = sum((entry) => entry.proposals);
    const invalidOracles = sum((entry) => entry.invalidOracles);
    const tokens = sum((entry) => entry.tokens);
    const fullyReported = metrics.filter((entry) => entry.roundsWithoutTokenUsage === 0);
    const reportedBreakIns = fullyReported.reduce((total, entry) => total + entry.breakIns, 0);
    const lastFound = ordered.map((raid) => raid.outcome === 'found').lastIndexOf(true);
    const raidsSinceLastBreakIn = ordered.length - 1 - lastFound;
    const executedRuns = sum((entry) => entry.executedRuns);
    return {
      repo,
      raids: ordered.length,
      proposals,
      qualified: sum((entry) => entry.qualified),
      rejectedByVerdict,
      invalidOracles,
      invalidOracleRate: proposals === 0 ? null : invalidOracles / proposals,
      executedRuns,
      breakIns,
      replayReliability: { replayed: sum((entry) => entry.replayReliability.replayed), reproduced: sum((entry) => entry.replayReliability.reproduced) },
      wallClockMs: sum((entry) => entry.wallClockMs),
      tokens,
      roundsWithoutTokenUsage: sum((entry) => entry.roundsWithoutTokenUsage),
      costPerBreakIn: reportedBreakIns === 0 ? null : fullyReported.reduce((total, entry) => total + entry.tokens, 0) / reportedBreakIns,
      raidsSinceLastBreakIn,
      flag: raidsSinceLastBreakIn >= ZERO_BREAK_IN_FLAG_RAIDS
        ? `${String(raidsSinceLastBreakIn)} raids in a row found no break-in (${String(executedRuns)} sandboxed runs${tokens > 0 ? `, ${String(tokens)} tokens` : ''} spent in total); turning raids off for ${repo} is your call`
        : null,
    };
  });
}

/** Raids counting toward a repository's daily cap: started in the last 24 hours, or launched and not yet run. */
export function raidsTowardCap(raids: readonly RaidRecord[], repo: string, now: Date): number {
  const DAY_MS = 86_400_000;
  return raids.filter((raid) => raid.target.repo === repo &&
    ((raid.startedAt !== null && now.getTime() - Date.parse(raid.startedAt) < DAY_MS) || raid.state === 'queued' || raid.state === 'running')).length;
}

/** A key naming one target at one source identity. */
export const offerKey = (repo: string, packageDir: string, sourceIdentity: string): string => `${repo}\u0000${packageDir}\u0000${sourceIdentity}`;

export interface PlanRecord {
  readonly digest: string;
  readonly notificationId: string;
  readonly offeredAt: string;
  readonly decidedAt: string | null;
  /** offerKey of every candidate the list offered: once decided, Gru has seen them. */
  readonly offered: readonly string[];
}

export class VectorRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VectorRecordError';
  }
}

type Payload = Record<string, unknown>;

function text(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value === '') throw new VectorRecordError(`vector event is missing "${key}"`);
  return value;
}

function signalsOf(value: unknown): RaidSignals {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Payload;
  const count = (key: string): number => (typeof raw[key] === 'number' ? raw[key] : 0);
  return {
    commitsSinceLastRaid: count('commits_since_last_raid'),
    escapedRegressions: count('escaped_regressions'),
    perkinsFindings: count('perkins_findings'),
    daysSinceLastRaid: typeof raw['days_since_last_raid'] === 'number' ? raw['days_since_last_raid'] : null,
  };
}

/** Read a stored metrics object; anything absent counts as zero. */
export function metricsOf(value: unknown): RaidMetrics {
  const m = (typeof value === 'object' && value !== null ? value : {}) as Payload;
  const count = (key: string): number => (typeof m[key] === 'number' ? m[key] : 0);
  const replay = (typeof m['replayReliability'] === 'object' && m['replayReliability'] !== null ? m['replayReliability'] : {}) as Payload;
  const rejected = (typeof m['rejectedByVerdict'] === 'object' && m['rejectedByVerdict'] !== null ? m['rejectedByVerdict'] : {}) as Payload;
  return {
    actionableDefects: count('actionableDefects'),
    invalidOracles: count('invalidOracles'),
    unknownValidity: count('unknownValidity'),
    totalQualificationAttempts: count('totalQualificationAttempts'),
    replayReliability: { replayed: typeof replay['replayed'] === 'number' ? replay['replayed'] : 0, reproduced: typeof replay['reproduced'] === 'number' ? replay['reproduced'] : 0 },
    escapedRegressions: count('escapedRegressions'),
    executedRuns: count('executedRuns'),
    totalExecutionMs: count('totalExecutionMs'),
    totalTokenCost: typeof m['totalTokenCost'] === 'number' ? m['totalTokenCost'] : null,
    proposals: count('proposals'),
    qualified: count('qualified'),
    rejectedByVerdict: Object.fromEntries(Object.entries(rejected).filter((entry): entry is [string, number] => typeof entry[1] === 'number')),
    inconclusive: count('inconclusive'),
    invalidAttacks: count('invalidAttacks'),
    duplicates: count('duplicates'),
    breakIns: count('breakIns'),
    wallClockMs: count('wallClockMs'),
    tokens: count('tokens'),
    roundsWithoutTokenUsage: count('roundsWithoutTokenUsage'),
  };
}

export function signalsPayload(signals: RaidSignals): Payload {
  return {
    commits_since_last_raid: signals.commitsSinceLastRaid,
    escaped_regressions: signals.escapedRegressions,
    perkins_findings: signals.perkinsFindings,
    days_since_last_raid: signals.daysSinceLastRaid,
  };
}

const PAGE = 500;

/**
 * The raid projection. It reads only `vector.*` events, after the last seq it
 * applied, so a long ledger costs one indexed page per refresh.
 */
export class VectorLedger {
  private cursor = 0;
  private readonly raidsById = new Map<string, RaidRecord>();
  private readonly plans = new Map<string, PlanRecord>();
  private readonly breakInsById = new Map<string, BreakInRecord>();
  private skippedEvents = 0;

  constructor(private readonly ledger: LedgerApi, private readonly log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void = () => {}) {}

  /** Apply every `vector.*` event the projection has not seen yet. An event
   * that cannot apply (a record naming an unknown raid, a missing field) is
   * logged at error with its seq and skipped, never a wedge: the projection
   * keeps every other raid working. */
  refresh(): void {
    for (;;) {
      const page = this.ledger.listEventsAfter(this.cursor, { kinds: VECTOR_EVENT_KINDS, limit: PAGE });
      for (const event of page) {
        try {
          this.apply(event.kind, (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Payload, event.ts);
        } catch (error) {
          this.skippedEvents += 1;
          this.log('error', 'vector event skipped: it does not apply to the raid projection', { seq: event.seq, kind: event.kind, error: error instanceof Error ? error.message : String(error) });
        } finally {
          this.cursor = event.seq;
        }
      }
      if (page.length < PAGE) return;
    }
  }

  /** How many stored `vector.*` events could not apply (each logged). */
  skipped(): number {
    this.refresh();
    return this.skippedEvents;
  }

  /** Append one `vector.*` fact and apply it. */
  record(kind: string, payload: Payload): void {
    if (!VECTOR_EVENT_KINDS.includes(kind)) throw new VectorRecordError(`unknown vector event kind "${kind}"`);
    this.refresh();
    const event = this.ledger.appendCustomEvent({ kind, payload });
    this.apply(kind, payload, event.ts);
    this.cursor = Math.max(this.cursor, event.seq);
  }

  raids(): readonly RaidRecord[] {
    this.refresh();
    return [...this.raidsById.values()];
  }

  raid(id: string): RaidRecord | null {
    this.refresh();
    return this.raidsById.get(id) ?? null;
  }

  breakIns(): readonly BreakInRecord[] {
    this.refresh();
    return [...this.breakInsById.values()];
  }

  breakIn(id: string): BreakInRecord | null {
    this.refresh();
    return this.breakInsById.get(id) ?? null;
  }

  plan(digest: string): PlanRecord | null {
    this.refresh();
    return this.plans.get(digest) ?? null;
  }

  /** offerKey of every candidate an answered (or superseded) list showed Gru. */
  decidedOffers(): readonly string[] {
    this.refresh();
    return [...this.plans.values()].filter((plan) => plan.decidedAt !== null).flatMap((plan) => plan.offered);
  }

  planCount(): number {
    this.refresh();
    return this.plans.size;
  }

  openPlans(): readonly PlanRecord[] {
    this.refresh();
    return [...this.plans.values()].filter((plan) => plan.decidedAt === null);
  }

  private apply(kind: string, payload: Payload, ts: string): void {
    switch (kind) {
      case VECTOR_EVENTS.planOffered: {
        const digest = text(payload, 'digest');
        const offered = Array.isArray(payload['offered']) ? (payload['offered'] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
        this.plans.set(digest, { digest, notificationId: text(payload, 'notification_id'), offeredAt: ts, decidedAt: null, offered });
        return;
      }
      case VECTOR_EVENTS.planDecided: {
        const digest = text(payload, 'digest');
        const plan = this.plans.get(digest);
        if (plan !== undefined) this.plans.set(digest, { ...plan, decidedAt: ts });
        return;
      }
      case VECTOR_EVENTS.picked: {
        const id = text(payload, 'raid_id');
        this.raidsById.set(id, {
          id,
          target: { repo: text(payload, 'repo'), packageDir: text(payload, 'package_dir') },
          sourceIdentity: text(payload, 'source_identity'),
          headSha: text(payload, 'head_sha'),
          reason: text(payload, 'reason'),
          requestedBy: payload['requested_by'] === 'owner-chat' ? 'owner-chat' : 'gru',
          signals: signalsOf(payload['signals']),
          pickedAt: ts,
          state: 'proposed',
          notificationId: null,
          launchedBy: null,
          launchedAt: null,
          closedDetail: null,
          startedAt: null,
          runHeadSha: null,
          rounds: [],
          outcome: null,
          outcomeLabel: null,
          finishedAt: null,
          reportFile: null,
          metrics: null,
        });
        return;
      }
      case VECTOR_EVENTS.breakIn: {
        const id = text(payload, 'break_in_id');
        const strings = (key: string): readonly string[] => (Array.isArray(payload[key]) ? (payload[key] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : []);
        this.breakInsById.set(id, {
          id,
          raidId: text(payload, 'raid_id'),
          target: { repo: text(payload, 'repo'), packageDir: text(payload, 'package_dir') },
          headSha: text(payload, 'head_sha'),
          sourceIdentity: text(payload, 'source_identity'),
          description: text(payload, 'description'),
          requirementRef: text(payload, 'requirement_ref'),
          invariant: text(payload, 'invariant'),
          frozenSha256: text(payload, 'frozen_sha256'),
          counterexample: typeof payload['counterexample'] === 'string' ? payload['counterexample'] : '',
          seed: typeof payload['seed'] === 'string' ? payload['seed'] : null,
          shrinkPath: strings('shrink_path'),
          evidenceDir: text(payload, 'evidence_dir'),
          testPath: text(payload, 'test_path'),
          testSha256: text(payload, 'test_sha256'),
          receipts: strings('receipts'),
          foundAt: ts,
          fix: null,
        });
        return;
      }
      case VECTOR_EVENTS.fixProposed:
      case VECTOR_EVENTS.fixDeclined:
      case VECTOR_EVENTS.fixDispatched: {
        const id = text(payload, 'break_in_id');
        const breakIn = this.breakInsById.get(id);
        if (breakIn === undefined) throw new VectorRecordError(`${kind} names unknown break-in "${id}"`);
        const previous = breakIn.fix;
        const fix = kind === VECTOR_EVENTS.fixProposed
          ? { state: 'proposed' as const, notificationId: text(payload, 'notification_id'), jobId: null, launchedBy: null, detail: null }
          : kind === VECTOR_EVENTS.fixDeclined
            ? { state: 'declined' as const, notificationId: previous?.notificationId ?? null, jobId: null, launchedBy: null, detail: text(payload, 'detail') }
            : { state: 'dispatched' as const, notificationId: previous?.notificationId ?? null, jobId: text(payload, 'job_id'),
              launchedBy: (payload['launched_by'] === 'autonomous' ? 'autonomous' : 'owner-accept') as RaidLaunch, detail: null };
        this.breakInsById.set(id, { ...breakIn, fix });
        return;
      }
      default:
        break;
    }
    const id = text(payload, 'raid_id');
    const raid = this.raidsById.get(id);
    if (raid === undefined) throw new VectorRecordError(`${kind} names unknown raid "${id}"`);
    switch (kind) {
      case VECTOR_EVENTS.proposed:
        this.raidsById.set(id, { ...raid, state: 'proposed', notificationId: text(payload, 'notification_id') });
        return;
      case VECTOR_EVENTS.declined:
        this.raidsById.set(id, { ...raid, state: 'declined', closedDetail: text(payload, 'detail') });
        return;
      case VECTOR_EVENTS.withdrawn:
        this.raidsById.set(id, { ...raid, state: 'withdrawn', closedDetail: text(payload, 'detail') });
        return;
      case VECTOR_EVENTS.queued: {
        const launchedBy = text(payload, 'launched_by');
        if (launchedBy !== 'owner-accept' && launchedBy !== 'autonomous' && launchedBy !== 'owner-chat') {
          throw new VectorRecordError(`raid "${id}" names an unknown launch "${launchedBy}"`);
        }
        this.raidsById.set(id, { ...raid, state: 'queued', launchedBy, launchedAt: ts });
        return;
      }
      case VECTOR_EVENTS.started:
        this.raidsById.set(id, { ...raid, state: 'running', startedAt: ts, runHeadSha: text(payload, 'head_sha') });
        return;
      case VECTOR_EVENTS.round: {
        const outcome = text(payload, 'outcome');
        if (!(ROUND_OUTCOMES as readonly string[]).includes(outcome)) throw new VectorRecordError(`raid "${id}" names an unknown round outcome "${outcome}"`);
        const receipts = Array.isArray(payload['receipts']) ? (payload['receipts'] as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
        const round: RaidRoundRecord = {
          round: typeof payload['round'] === 'number' ? payload['round'] : raid.rounds.length + 1,
          description: typeof payload['description'] === 'string' ? payload['description'] : null,
          outcome: outcome as RoundOutcome,
          verdict: text(payload, 'verdict'),
          candidateOutcome: typeof payload['candidate_outcome'] === 'string' ? payload['candidate_outcome'] : null,
          replay: typeof payload['replay'] === 'string' ? payload['replay'] : null,
          artifactSha256: typeof payload['artifact_sha256'] === 'string' ? payload['artifact_sha256'] : null,
          executedRuns: typeof payload['executed_runs'] === 'number' ? payload['executed_runs'] : 0,
          receipts,
          noReceiptReason: receipts.length > 0 ? null : (typeof payload['no_receipt_reason'] === 'string' ? payload['no_receipt_reason'] : `no receipt: the round ended ${outcome}`),
          detail: typeof payload['detail'] === 'string' ? payload['detail'] : '',
        };
        this.raidsById.set(id, { ...raid, rounds: [...raid.rounds, round] });
        return;
      }
      case VECTOR_EVENTS.finished: {
        const outcome = text(payload, 'outcome');
        if (!(RAID_OUTCOMES as readonly string[]).includes(outcome)) throw new VectorRecordError(`raid "${id}" names an unknown outcome "${outcome}"`);
        this.raidsById.set(id, { ...raid, state: 'finished', outcome: outcome as RaidOutcome, outcomeLabel: text(payload, 'label'), finishedAt: ts,
          reportFile: typeof payload['report_file'] === 'string' ? payload['report_file'] : null,
          metrics: metricsOf(payload['metrics']) });
        return;
      }
      default:
        throw new VectorRecordError(`unhandled vector event kind "${kind}"`);
    }
  }
}
