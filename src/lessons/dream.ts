import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LogLevel } from '../logger.js';
import { BibleLockReleaseError, checkPlan, describePlan, type ApplyReport, type BiblePlan, type BibleStore, type PlanReview } from './bible.js';
import { DreamError, isLessonsSlug, ProposalError, type JournalEntry, type ProposedChapter } from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The dream pass: journal → bible. Mechanics only — the judgment (what is
 * one lesson, what merges, how to word it) belongs to the distiller (Bob).
 *
 * Invariants this layer guarantees regardless of distiller behavior:
 *   - the owner approves every book update: a pass PROPOSES (For You) and
 *     nothing is written until Accept; Reject consumes the batch without
 *     writing (owner decision 2026-10-07);
 *   - the cursor advances ONLY on an owner decision (or, in tests, a
 *     successful apply) — a failed dream retries the same entries next
 *     cycle, never a silent skip;
 *   - a bounded batch per pass (entries beyond the bound wait for the
 *     next pass rather than bloating the prompt);
 *   - invented provenance is a hard error (the distiller may only cite
 *     journal ids it was given);
 *   - one pass in flight at a time (the scheduler skips overlapping beats).
 */

export const DREAM_STATE_FILE = '.dream-state.json';
/** Incident kind raised while dream passes keep failing. */
export const DREAM_FAILED_KIND = 'lessons.dream-failed';
export const DEFAULT_MAX_ENTRIES_PER_DREAM = 100;

/** Journal seqs in (afterSeq, throughSeq] — a withdrawn proposal's batch. */
export interface ReplayRange {
  readonly afterSeq: number;
  readonly throughSeq: number;
}

export interface DreamState {
  readonly version: 1;
  /** Journal high-water mark through which the last dream consumed. */
  readonly coveredThroughSeq: number;
  readonly lastDreamAt: string | null;
  readonly cycles: number;
  /** Withdrawn proposals' batches the cursor already moved past, oldest
   * first, disjoint: re-proposed before any new entry, exactly — entries
   * consumed in between are never re-proposed — and the cursor never
   * rewinds. Absent when empty. */
  readonly replay?: readonly ReplayRange[];
}

/** Sorted, with overlapping or adjacent ranges joined — and only those, so
 * the eligible set stays exact. */
export function coalesceReplay(ranges: readonly ReplayRange[]): ReplayRange[] {
  const out: ReplayRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.afterSeq - right.afterSeq)) {
    const last = out.at(-1);
    if (last !== undefined && range.afterSeq <= last.throughSeq) {
      out[out.length - 1] = { afterSeq: last.afterSeq, throughSeq: Math.max(last.throughSeq, range.throughSeq) };
    } else {
      out.push(range);
    }
  }
  return out;
}

/** The state with this replay list (the field is absent when empty). */
function withReplay(state: DreamState, replay: readonly ReplayRange[]): DreamState {
  const { replay: _previous, ...rest } = state;
  return replay.length > 0 ? { ...rest, replay } : rest;
}

/** POSIX single-quoted shell word. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/gu, `'\\''`)}'`;
}

/** The exact command that rebuilds a damaged book's provenance for THIS
 * instance — its GRU_COMMAND_HOME, Node and data dir — pasteable from any
 * shell, including a launchd service's non-default instance. */
export function repairCommand(input: {
  readonly nodePath: string;
  readonly toolPath: string;
  readonly instanceDir: string;
  readonly dataDir: string;
}): string {
  return `GRU_COMMAND_HOME=${shellQuote(input.instanceDir)} ${shellQuote(input.nodePath)} ` +
    `${shellQuote(input.toolPath)} ${shellQuote(input.dataDir)}`;
}

/** The notification surface a failing dream reports through
 * (NotificationCenter in production). */
export interface DreamIncidentPort {
  /** Post — or reuse the open — incident, saying which it was. */
  openIncident(input: {
    kind: string;
    routing: 'action-required';
    severity: 'error';
    title: string;
    detail: string;
    dedupe: 'active';
  }): { readonly record: { readonly id: string; readonly detail: string | null }; readonly created: boolean };
  updateDetail(id: string, detail: string): unknown;
  resolveIncidents(kindPrefix: string, by: string): unknown;
}

const FIRST_FAILURE = /^First failure \(([^)]*)\): (.*)$/mu;
const LATEST_FAILURE = /^Latest failure \([^)]*, failed pass (\d+)\): /mu;

/** Production wiring for DreamScheduler's hooks: a failing dream is ONE
 * open action-required incident per failure streak (it failed every pass
 * for days unnoticed — owner incident 2026-10-07). Its detail keeps the
 * FIRST failure (when the streak began) and refreshes the LATEST one on
 * every failed pass (owner decision 2026-10-07), with the repair command;
 * the next completed pass resolves it. */
export function dreamFailureIncidents(
  port: DreamIncidentPort,
  command: string,
  now: () => Date = () => new Date(),
): { onFailure(error: unknown): void; onSuccess(): void } {
  // Every line terminator — CR, LF, U+2028, U+2029 — folds to a space, so
  // each failure is exactly one line of the detail and parses back whole.
  const oneLine = (error: unknown) => String(error).replace(/\s*[\r\n\u2028\u2029]\s*/gu, ' ');
  const render = (first: { at: string; error: string }, latest: { at: string; error: string }, pass: number) =>
    `First failure (${first.at}): ${first.error}\n` +
    `Latest failure (${latest.at}, failed pass ${pass}): ${latest.error}\n\n` +
    "A failed pass leaves the journal cursor where it was (a failure that moved it says so) and the next beat retries. " +
    "If a chapter's provenance is malformed, rebuild it " +
    `from the journal (dry run first, then add --write):\n${command}`;
  return {
    onFailure: (error) => {
      const latest = { at: now().toISOString(), error: oneLine(error) };
      const fresh = render(latest, latest, 1);
      const { record, created } = port.openIncident({
        kind: DREAM_FAILED_KIND,
        routing: 'action-required',
        severity: 'error',
        title: 'Lesson dream is failing — the Book of Lessons is not being updated',
        detail: fresh,
        dedupe: 'active',
      });
      if (created) return; // a new streak starts at pass 1
      const first = FIRST_FAILURE.exec(record.detail ?? '');
      const pass = Number(LATEST_FAILURE.exec(record.detail ?? '')?.[1] ?? '1') + 1;
      port.updateDetail(
        record.id,
        render(first === null ? latest : { at: first[1]!, error: first[2]! }, latest, pass),
      );
    },
    onSuccess: () => {
      port.resolveIncidents(DREAM_FAILED_KIND, 'dream');
    },
  };
}

export interface DistillInput {
  readonly entries: readonly JournalEntry[];
  /** Current INDEX.md text (null before the first seed). */
  readonly index: string | null;
  readonly bibleDir: string;
  readonly chapterCapBytes: number;
  readonly indexCapBytes: number;
}

export interface DistillResult {
  readonly chapters: readonly ProposedChapter[];
}

/** The judgment port: production = Bob via the supervised slot; tests use
 * deterministic fakes. */
export interface DreamDistiller {
  distill(input: DistillInput): Promise<DistillResult>;
}

export interface DreamOutcome {
  /** `proposed`: a book update now waits for the owner in For You;
   * `awaiting-owner`: an earlier proposal is still undecided, so this pass
   * did nothing (no distiller call, no model cost). */
  readonly status: 'noop' | 'dreamed' | 'proposed' | 'awaiting-owner';
  readonly entries: number;
  readonly coveredThroughSeq: number;
  readonly chaptersTouched: number;
  readonly lessonsAdded: number;
  readonly lessonsMerged: number;
  readonly lessonsTrimmed: number;
  readonly lessonsDropped: number;
}

export interface DreamEngineOptions {
  readonly journal: {
    list(options?: { after?: number; limit?: number }): readonly JournalEntry[];
  };
  readonly bible: BibleStore;
  readonly distiller: DreamDistiller;
  /** Owner approval (the service's path): every pass proposes, nothing is
   * written until the owner accepts in For You (owner decision 2026-10-07). */
  readonly proposals?: LessonProposals;
  /** Write each pass directly — tests of the dream mechanics only. Exactly
   * one of `proposals` / `autoApply` must be chosen; there is no default. */
  readonly autoApply?: boolean;
  /** Defaults to <bible-dir>/.dream-state.json. With proposals the engine
   * always uses THEIR cursor file — a different one is refused. */
  readonly stateFile?: string;
  readonly maxEntriesPerDream?: number;
  readonly log?: Log;
  readonly now?: () => Date;
}

export class DreamEngine {
  private readonly journal: DreamEngineOptions['journal'];
  private readonly bible: BibleStore;
  private readonly distiller: DreamDistiller;
  private readonly proposals: LessonProposals | null;
  private readonly stateFile: string;
  private readonly maxEntriesPerDream: number;
  private readonly log: Log;
  private readonly now: () => Date;

  constructor(opts: DreamEngineOptions) {
    if ((opts.proposals === undefined) === (opts.autoApply !== true)) {
      throw new DreamError(
        'dream engine needs exactly one write path: proposals (owner approval) or autoApply: true (tests)',
      );
    }
    this.journal = opts.journal;
    this.bible = opts.bible;
    this.distiller = opts.distiller;
    this.proposals = opts.proposals ?? null;
    if (this.proposals !== null && opts.stateFile !== undefined && resolve(opts.stateFile) !== this.proposals.stateFile) {
      throw new DreamError(
        `dream engine state file ${opts.stateFile} differs from the proposals' ${this.proposals.stateFile} — ` +
          'one cursor must govern both, or a decision would consume entries the engine proposes again',
      );
    }
    this.stateFile = this.proposals?.stateFile ?? opts.stateFile ?? join(opts.bible.dir, DREAM_STATE_FILE);
    this.maxEntriesPerDream = opts.maxEntriesPerDream ?? DEFAULT_MAX_ENTRIES_PER_DREAM;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  /** One dream pass. No new entries = no distiller call = no model cost. */
  async run(): Promise<DreamOutcome> {
    this.bible.ensureSeeded();
    if (this.proposals !== null) {
      // Finish any decided-but-unclosed proposal, withdraw a stale one, and
      // re-ensure the notice of a still-pending one — never a second proposal.
      const waiting = this.proposals.reconcile();
      if (waiting !== null) {
        this.log('info', 'dream beat skipped — a lesson proposal awaits the owner', { proposal_id: waiting.id });
        return this.idle('awaiting-owner', loadDreamState(this.stateFile));
      }
    }
    let state = loadDreamState(this.stateFile);
    // Replay first, oldest range first. A range whose entries are gone from
    // the journal is dropped and the pass falls through to the next one —
    // and then to new entries — instead of wasting a whole cadence.
    let replay: ReplayRange | undefined;
    let pending: readonly JournalEntry[] = [];
    while (state.replay !== undefined && state.replay.length > 0) {
      const head = state.replay[0]!;
      pending = this.journal.list({ after: head.afterSeq, limit: this.maxEntriesPerDream }).filter((entry) => entry.seq <= head.throughSeq);
      if (pending.length > 0) {
        replay = head;
        break;
      }
      state = withReplay(state, state.replay.slice(1));
      saveDreamState(this.stateFile, state);
    }
    if (replay === undefined) pending = this.journal.list({ after: state.coveredThroughSeq, limit: this.maxEntriesPerDream });
    if (pending.length === 0) return this.idle('noop', state);
    const index = this.bible.readIndexText();
    const result = await this.distiller.distill({
      entries: pending,
      index,
      bibleDir: this.bible.dir,
      chapterCapBytes: this.bible.chapterCapBytes,
      indexCapBytes: this.bible.indexCapBytes,
    });

    // Provenance guard: only ids from THIS batch may be cited. The
    // distiller reads entries; anything else is invention.
    const tsById = new Map(pending.map((entry) => [entry.id, entry.ts]));
    for (const chapter of result.chapters) {
      for (const lesson of chapter.lessons) {
        for (const id of lesson.journalIds) {
          if (!tsById.has(id)) {
            throw new DreamError(
              `distiller cited journal id ${id} (chapter ${chapter.slug}, lesson ${lesson.slug}) but it is not part of this dream batch`,
            );
          }
        }
      }
    }

    const plan = this.bible.planUpdates(result.chapters, tsById);
    const first = pending[0]!;
    const last = pending[pending.length - 1]!;
    const remainingReplay = replay === undefined
      ? []
      : [...(last.seq < replay.throughSeq ? [{ afterSeq: last.seq, throughSeq: replay.throughSeq }] : []), ...state.replay!.slice(1)];
    const nextState = withReplay({
      version: 1,
      coveredThroughSeq: Math.max(state.coveredThroughSeq, last.seq),
      lastDreamAt: this.now().toISOString(),
      cycles: state.cycles + 1,
    }, remainingReplay);
    const outcome = (status: 'dreamed' | 'proposed'): DreamOutcome => ({
      status,
      entries: pending.length,
      coveredThroughSeq: status === 'dreamed' ? nextState.coveredThroughSeq : state.coveredThroughSeq,
      chaptersTouched: plan.report.chaptersWritten,
      lessonsAdded: plan.report.lessonsAdded,
      lessonsMerged: plan.report.lessonsMerged,
      lessonsTrimmed: plan.report.lessonsTrimmed,
      lessonsDropped: plan.report.lessonsDropped,
    });
    if (this.proposals !== null) {
      const proposal = this.proposals.create({
        plan,
        entries: pending.length,
        fromState: state,
        batch: { afterSeq: Math.max(first.seq - 1, replay?.afterSeq ?? state.coveredThroughSeq), throughSeq: last.seq },
        nextState,
      });
      this.log('info', 'dream pass proposed — awaiting the owner in For You', {
        proposal_id: proposal.id,
        entries: pending.length,
        through_seq: last.seq,
        chapters_touched: plan.report.chaptersWritten,
        lessons_added: plan.report.lessonsAdded,
        lessons_merged: plan.report.lessonsMerged,
      });
      return outcome('proposed');
    }

    let report: ApplyReport;
    let cleanupFailure: BibleLockReleaseError | null = null;
    try {
      report = this.bible.applyPlan(plan);
    } catch (error) {
      // Written, then only the lock release failed: the batch IS applied,
      // so the cursor must still advance — a replay would double-count.
      if (!(error instanceof BibleLockReleaseError)) throw error;
      report = error.result as ApplyReport;
      cleanupFailure = error;
    }
    saveDreamState(this.stateFile, nextState);
    if (cleanupFailure !== null) {
      throw new DreamError(
        `the dream pass wrote its update and advanced the journal cursor to ${last.seq}, but ${cleanupFailure.message}`,
      );
    }
    this.log('info', 'dream pass completed', {
      entries: pending.length,
      covered_through_seq: last.seq,
      chapters_touched: report.chaptersWritten,
      lessons_added: report.lessonsAdded,
      lessons_merged: report.lessonsMerged,
      lessons_trimmed: report.lessonsTrimmed,
      lessons_dropped: report.lessonsDropped,
    });
    return outcome('dreamed');
  }

  private idle(status: 'noop' | 'awaiting-owner', state: DreamState): DreamOutcome {
    return {
      status,
      entries: 0,
      coveredThroughSeq: state.coveredThroughSeq,
      chaptersTouched: 0,
      lessonsAdded: 0,
      lessonsMerged: 0,
      lessonsTrimmed: 0,
      lessonsDropped: 0,
    };
  }
}

// ------------------------------------------------------------------
// Owner-approved lesson proposals (owner decision 2026-10-07)
// ------------------------------------------------------------------

export const PROPOSAL_FILE = '.proposal.json';
/** The For You notification kind that carries a lesson proposal. */
export const LESSONS_PROPOSAL_KIND = 'lessons.proposal';
/** The FYI kind posted when a proposal is withdrawn as stale. */
export const LESSONS_PROPOSAL_WITHDRAWN_KIND = 'lessons.proposal-withdrawn';

export type ProposalDecisionKind = 'accepted' | 'rejected' | 'withdrawn';

/** A planned book update waiting for the owner. At most one exists; while
 * it waits, the dream does not distill (and spends nothing). Its decision
 * is recorded BEFORE any book or cursor change and never changes; the
 * record is deleted only after the decision is fully carried out. */
export interface LessonProposal {
  readonly version: 1;
  readonly id: string;
  readonly createdAt: string;
  /** Derived from the id before anything is posted: re-posting is a no-op. */
  readonly notificationId: string;
  /** Journal entries the proposal was distilled from. */
  readonly entries: number;
  /** The complete dream state the proposal was computed from. */
  readonly fromState: DreamState;
  /** The journal range distilled. */
  readonly batch: ReplayRange;
  /** The dream state after an Accept or Reject (both consume the batch). */
  readonly nextState: DreamState;
  readonly plan: BiblePlan;
  readonly decision: {
    readonly kind: ProposalDecisionKind;
    readonly at: string;
    readonly detail: string | null;
  } | null;
  /** Why a recorded decision could not be carried out (the book or the
   * cursor changed under it). The record — and the owner's intent — stay
   * until the conflict is cleared; nothing is withdrawn or re-proposed. */
  readonly recovery: { readonly conflict: string; readonly at: string } | null;
  /** Set once the decision's book and cursor changes are durable: from
   * here only cleanup remains (notices, record removal) — nothing is
   * re-applied or re-validated, whatever happens to the book later. */
  readonly committed: { readonly at: string } | null;
}

/** The owner-facing review of a pending proposal, derived from the plan's
 * baseline and writes. */
export interface LessonProposalReview {
  readonly id: string;
  readonly createdAt: string;
  readonly notificationId: string;
  readonly entries: number;
  readonly throughSeq: number;
  readonly chapters: PlanReview['chapters'];
  readonly index: PlanReview['index'];
  /** The owner's decision when it is recorded but not yet finished — the
   * same decision finishes it; the opposite one is refused. */
  readonly decision: { readonly kind: 'accepted' | 'rejected'; readonly at: string } | null;
  /** Why the recorded decision is blocked (see LessonProposal.recovery). */
  readonly recovery: { readonly conflict: string; readonly at: string } | null;
}

export interface LessonProposalDecision {
  readonly id: string;
  readonly decision: ProposalDecisionKind;
  readonly coveredThroughSeq: number;
  readonly report: BiblePlan['report'] | null;
}

/** How proposals reach the owner. Every call is idempotent by id, so a
 * crash at any point can simply be retried. */
export interface ProposalNotifier {
  /** Ensure the For You decision row with exactly this id exists. */
  ensure(input: { readonly id: string; readonly title: string; readonly detail: string }): void;
  /** Resolve a notice (a resolved or missing one is left alone). */
  resolve(id: string, by: string): void;
  /** Ensure the FYI with exactly this id exists. */
  inform(input: { readonly id: string; readonly title: string; readonly detail: string }): void;
  /** Ensure the owner-held conflict notice with exactly this id exists and
   * says exactly this (an open one is refreshed in place). */
  conflict(input: { readonly id: string; readonly title: string; readonly detail: string }): void;
}

/** The notification surfaces the production notifier writes through
 * (NotificationCenter + LedgerApi). */
export interface ProposalNotificationPorts {
  readonly notifications: {
    post(input: {
      id: string;
      kind: string;
      routing: 'needs-owner' | 'fyi';
      severity: 'info' | 'error';
      title: string;
      detail: string;
    }): unknown;
  };
  readonly ledger: {
    resolveNotificationById(id: string, by: string): unknown;
    updateNotificationDetail(id: string, detail: string, title?: string): unknown;
  };
}

/** The kind of the owner-held notice raised when a recorded decision cannot
 * be carried out. */
export const LESSONS_PROPOSAL_CONFLICT_KIND = 'lessons.proposal-conflict';

/** Production wiring: proposals are owner-held For You rows; withdrawals
 * are FYIs; a decision that cannot be carried out is an owner-held stop. */
export function lessonProposalNotifier(ports: ProposalNotificationPorts): ProposalNotifier {
  return {
    ensure: ({ id, title, detail }) => {
      ports.notifications.post({ id, kind: LESSONS_PROPOSAL_KIND, routing: 'needs-owner', severity: 'info', title, detail });
    },
    resolve: (id, by) => {
      ports.ledger.resolveNotificationById(id, by);
    },
    inform: ({ id, title, detail }) => {
      ports.notifications.post({ id, kind: LESSONS_PROPOSAL_WITHDRAWN_KIND, routing: 'fyi', severity: 'info', title, detail });
    },
    conflict: ({ id, title, detail }) => {
      ports.notifications.post({ id, kind: LESSONS_PROPOSAL_CONFLICT_KIND, routing: 'needs-owner', severity: 'error', title, detail });
      // The same unresolved conflict may change (one file restored, another
      // edited): its notice always says what blocks NOW.
      ports.ledger.updateNotificationDetail(id, detail, title);
    },
  };
}

export interface LessonProposalsOptions {
  readonly bible: BibleStore;
  readonly notifier: ProposalNotifier;
  /** Defaults to <bible-dir>/.dream-state.json. */
  readonly stateFile?: string;
  readonly log?: Log;
  readonly now?: () => Date;
}

/** The complete dream state, compared field by field — the cursor, the
 * cycle count, the schedule timestamp and every replay range. */
const sameState = (left: DreamState, right: DreamState): boolean =>
  left.coveredThroughSeq === right.coveredThroughSeq &&
  left.cycles === right.cycles &&
  left.lastDreamAt === right.lastDreamAt &&
  JSON.stringify(left.replay ?? []) === JSON.stringify(right.replay ?? []);

export class LessonProposals {
  /** The dream cursor these proposals consume; the engine shares it. */
  readonly stateFile: string;
  private readonly bible: BibleStore;
  private readonly notifier: ProposalNotifier;
  private readonly file: string;
  private readonly log: Log;
  private readonly now: () => Date;

  constructor(opts: LessonProposalsOptions) {
    this.bible = opts.bible;
    this.notifier = opts.notifier;
    this.stateFile = resolve(opts.stateFile ?? join(opts.bible.dir, DREAM_STATE_FILE));
    this.file = join(opts.bible.dir, PROPOSAL_FILE);
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  /** The stored proposal record (pending or mid-decision), or null. The
   * record's shape AND integrity — plan consistency, baseline, cursor
   * bounds — are checked before anything acts on it; a corrupt record
   * fails loud. */
  pending(): LessonProposal | null {
    if (!existsSync(this.file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch (error) {
      throw new DreamError(`lesson proposal ${this.file} is unreadable (${String(error)}) — inspect or remove it`);
    }
    const proposal = validateLessonProposal(parsed, this.file);
    try {
      checkPlan(proposal.plan);
    } catch (error) {
      throw new DreamError(`lesson proposal ${this.file} is malformed (${error instanceof Error ? error.message : String(error)}) — inspect or remove it`);
    }
    return proposal;
  }

  /** The review of the proposal the owner still has to act on — undecided,
   * or decided but not finished (a restart or another device must still be
   * able to finish it) — or null when none awaits the owner. */
  review(): LessonProposalReview | null {
    const proposal = this.pending();
    if (proposal === null) return null;
    const { decision } = proposal;
    let recorded: LessonProposalReview['decision'] = null;
    if (decision !== null) {
      if (decision.kind === 'withdrawn') return null; // the next reconcile finishes it
      recorded = { kind: decision.kind, at: decision.at };
    }
    const review = describePlan(proposal.plan);
    return {
      id: proposal.id,
      createdAt: proposal.createdAt,
      notificationId: proposal.notificationId,
      entries: proposal.entries,
      throughSeq: proposal.batch.throughSeq,
      chapters: review.chapters,
      index: review.index,
      decision: recorded,
      recovery: proposal.recovery,
    };
  }

  /** Persist a new proposal, then put it in front of the owner. */
  create(input: {
    readonly plan: BiblePlan;
    readonly entries: number;
    readonly fromState: DreamState;
    readonly batch: ReplayRange;
    readonly nextState: DreamState;
  }): LessonProposal {
    if (this.pending() !== null) throw new DreamError('a lesson proposal is already pending');
    const id = randomUUID();
    const proposal: LessonProposal = {
      version: 1,
      id,
      createdAt: this.now().toISOString(),
      notificationId: `lessons-proposal:${id}`,
      entries: input.entries,
      fromState: input.fromState,
      batch: input.batch,
      nextState: input.nextState,
      plan: input.plan,
      decision: null,
      recovery: null,
      committed: null,
    };
    validateLessonProposal(JSON.parse(JSON.stringify(proposal)), 'new proposal');
    checkPlan(proposal.plan);
    // Durable first, with the notice id already fixed: a crash before or
    // after the post leaves a record the next reconcile re-announces under
    // the SAME id — never an orphan row.
    this.write(proposal);
    this.notifier.ensure({ id: proposal.notificationId, ...proposalNotice(proposal) });
    return proposal;
  }

  /**
   * Bring the stored record to a settled state: finish a decided proposal
   * (a crash may have interrupted it), withdraw an UNDECIDED one that went
   * stale, and re-ensure the notice of one still awaiting the owner.
   * Returns the proposal that still blocks the dream (pending, or decided
   * but in recovery conflict), or null. Run at startup and before every pass.
   */
  reconcile(): LessonProposal | null {
    const proposal = this.pending();
    if (proposal === null) return null;
    if (proposal.decision !== null) {
      try {
        this.finish(proposal);
        return null;
      } catch (error) {
        if (error instanceof ProposalError && error.code === 'conflict') return this.pending();
        throw error;
      }
    }
    const stale = this.staleness(proposal);
    if (stale !== null) {
      this.withdraw(proposal, stale);
      return null;
    }
    this.notifier.ensure({ id: proposal.notificationId, ...proposalNotice(proposal) });
    return proposal;
  }

  /** Owner Accept: write the planned update, then advance the cursor. */
  accept(id: string): LessonProposalDecision {
    return this.decide(id, 'accepted');
  }

  /** Owner Reject: the book is untouched; the batch is consumed anyway. */
  reject(id: string): LessonProposalDecision {
    return this.decide(id, 'rejected');
  }

  private decide(id: string, kind: 'accepted' | 'rejected'): LessonProposalDecision {
    const proposal = this.pending();
    if (proposal === null) throw new ProposalError('none', 'no lesson proposal is pending');
    if (proposal.id !== id) {
      throw new ProposalError('mismatch', `lesson proposal ${id} is not the pending one (${proposal.id})`);
    }
    if (proposal.decision !== null) {
      // The same decision retried resumes it; the opposite decision can
      // never undo a recorded one.
      if (proposal.decision.kind !== kind) {
        throw new ProposalError('decided', `this lesson proposal was already ${proposal.decision.kind}`);
      }
      return this.finishRecorded(proposal);
    }
    const stale = this.staleness(proposal);
    if (stale !== null) {
      this.withdraw(proposal, stale);
      throw new ProposalError('stale', `${stale} — the proposal was withdrawn; the next dream re-proposes these journal entries`);
    }
    const decided: LessonProposal = { ...proposal, decision: { kind, at: this.now().toISOString(), detail: null } };
    this.write(decided); // the decision is durable BEFORE the book or cursor changes
    return this.finishRecorded(decided);
  }

  /** Carry out a recorded decision for its decider: anything that fails
   * AFTER the record exists is "recorded, not yet finished" — never "not
   * applied" (the intent stands, and the same decision resumes it). */
  private finishRecorded(proposal: LessonProposal): LessonProposalDecision {
    try {
      return this.finish(proposal);
    } catch (error) {
      const label = proposal.decision!.kind === 'accepted' ? 'Accept' : 'Reject';
      if (error instanceof ProposalError && error.code === 'conflict') {
        // Blocked by a recovery conflict: still recorded, never "refused".
        throw new ProposalError('incomplete', `the ${label} is recorded but blocked: ${error.message}`);
      }
      throw new ProposalError(
        'incomplete',
        `the ${label} is recorded but finishing it failed ` +
          `(${error instanceof Error ? error.message : String(error)}); it resumes on the next attempt or service start`,
      );
    }
  }

  /** Why a pending proposal can no longer be applied as reviewed, or null. */
  private staleness(proposal: LessonProposal): string | null {
    const state = loadDreamState(this.stateFile);
    if (!sameState(state, proposal.fromState)) {
      return `the dream cursor moved to ${state.coveredThroughSeq} since this proposal was made at ${proposal.fromState.coveredThroughSeq}`;
    }
    if (this.bible.fingerprint() !== proposal.plan.base) return 'the Book of Lessons changed since this proposal was made';
    return null;
  }

  /** Withdraw an UNDECIDED proposal (cursor never rewinds; a batch the
   * cursor already passed is queued for replay so it is still proposed). */
  private withdraw(proposal: LessonProposal, detail: string): void {
    const state = loadDreamState(this.stateFile);
    // Only the part of the batch the cursor already passed needs a replay;
    // the rest is still ahead of it. Joined only where ranges touch, so no
    // consumed entry between two ranges is ever re-proposed.
    const passed = Math.min(state.coveredThroughSeq, proposal.batch.throughSeq);
    if (passed > proposal.batch.afterSeq) {
      saveDreamState(
        this.stateFile,
        withReplay(state, coalesceReplay([...(state.replay ?? []), { afterSeq: proposal.batch.afterSeq, throughSeq: passed }])),
      );
    }
    const withdrawn: LessonProposal = {
      ...proposal,
      decision: { kind: 'withdrawn', at: this.now().toISOString(), detail },
    };
    this.write(withdrawn);
    this.finish(withdrawn);
  }

  /** Record a recovery conflict: the owner's decision stays, nothing is
   * withdrawn or re-proposed, and an owner-held notice explains it. */
  private conflict(proposal: LessonProposal, detail: string, blocked: 'book' | 'cursor'): never {
    const recorded: LessonProposal = { ...proposal, recovery: { conflict: detail, at: this.now().toISOString() } };
    this.write(recorded);
    const label = proposal.decision?.kind === 'rejected' ? 'Reject' : 'Accept';
    const repair = blocked === 'cursor'
      ? `Restore the dream state file ${this.stateFile} to the state this decision started from ` +
        `(${JSON.stringify(proposal.fromState)}) or the one it produces (${JSON.stringify(proposal.nextState)})`
      : label === 'Reject'
        // A Reject writes nothing: only the book as reviewed finishes it.
        ? `Restore each listed Book of Lessons file to the book as reviewed (plan.before in ${this.file}) — ` +
          'a Reject writes nothing, so only that state finishes it'
        : `Restore each listed Book of Lessons file to its state before the update (plan.before in ${this.file}) ` +
          'or after it (plan.writes and plan.indexText; chapters in plan.retired deleted) — any mix of the two finishes it';
    this.notifier.conflict({
      id: `lessons-proposal-conflict:${proposal.id}`,
      title: `Your ${label} of the lesson proposal could not finish — ${detail.split(/[;(]/u)[0]!.trim()}`,
      detail: `${detail}. Your ${label} is kept and nothing will be re-proposed. ${repair}, then press ${label} again to finish it.`,
    });
    throw new ProposalError('conflict', `${detail}; your ${label} is kept — ${blocked === 'book' ? 'restore the book' : 'restore the dream state'}, then press ${label} again`);
  }

  /** Carry out a recorded decision. Every step is idempotent, and the
   * record is deleted only after all of them — so a crash anywhere is
   * finished by the next reconcile or a retried decision. A book or
   * cursor that changed under a recorded decision is a conflict: nothing
   * is overwritten, withdrawn or re-proposed. */
  private finish(proposal: LessonProposal): LessonProposalDecision {
    const decision = proposal.decision!;
    let report: BiblePlan['report'] | null = decision.kind === 'accepted' ? proposal.plan.report : null;
    let current = proposal;
    if (decision.kind !== 'withdrawn' && proposal.committed === null) {
      const state = loadDreamState(this.stateFile);
      const cursorFresh = sameState(state, proposal.fromState);
      if (!cursorFresh && !sameState(state, proposal.nextState)) {
        this.conflict(proposal, `the dream cursor state changed (now ${JSON.stringify(state)}) while this decision was being carried out`, 'cursor');
      }
      if (decision.kind === 'accepted') {
        try {
          report = this.bible.applyPlan(proposal.plan);
        } catch (error) {
          if (error instanceof BibleLockReleaseError) {
            // Written; only the lock release failed — the update stands.
            report = error.result as ApplyReport;
            this.log('error', 'lesson proposal written, but the book write lock could not be released', { error: error.message });
          } else {
            if (!(error instanceof ProposalError && error.code === 'stale')) throw error;
            this.conflict(proposal, error.message.replace(/; nothing was written$/u, ''), 'book');
          }
        }
      } else {
        // A Reject consumes the batch the owner reviewed against THIS book;
        // a book changed since is a conflict, never silently consumed —
        // whether or not the cursor already moved.
        const drift = this.bible.driftFrom(proposal.plan, true);
        if (drift.length > 0) {
          this.conflict(proposal, `the Book of Lessons changed since this proposal was rejected (${drift.join(', ')})`, 'book');
        }
      }
      if (cursorFresh) saveDreamState(this.stateFile, proposal.nextState);
      current = { ...proposal, committed: { at: this.now().toISOString() } };
      this.write(current); // durable: from here on, cleanup only
    }
    this.notifier.resolve(current.notificationId, decision.kind === 'withdrawn' ? 'stale' : `owner:${decision.kind}`);
    if (current.recovery !== null) this.notifier.resolve(`lessons-proposal-conflict:${current.id}`, 'recovered');
    if (decision.kind === 'withdrawn') {
      this.notifier.inform({
        id: `lessons-proposal-withdrawn:${current.id}`,
        title: 'Lesson proposal withdrawn — the Book of Lessons changed',
        detail: `${decision.detail ?? 'the proposal went stale'}. Nothing was written; the next dream re-proposes these journal entries.`,
      });
    }
    // Everything that can fail happens BEFORE the record goes: a failure
    // here leaves it in place, so the same decision (or startup) resumes.
    const coveredThroughSeq = loadDreamState(this.stateFile).coveredThroughSeq;
    this.log(decision.kind === 'withdrawn' ? 'warn' : 'info', `lesson proposal ${decision.kind}`, {
      proposal_id: current.id,
      covered_through_seq: coveredThroughSeq,
      chapters_written: report?.chaptersWritten ?? 0,
      ...(decision.detail !== null ? { detail: decision.detail } : {}),
    });
    rmSync(this.file, { force: true });
    return { id: current.id, decision: decision.kind, coveredThroughSeq, report };
  }

  private write(proposal: LessonProposal): void {
    const staging = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(staging, `${JSON.stringify(proposal, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
      renameSync(staging, this.file);
    } catch (error) {
      rmSync(staging, { force: true });
      throw new DreamError(`could not write lesson proposal ${this.file}: ${String(error)}`);
    }
  }
}

function proposalNotice(proposal: LessonProposal): { title: string; detail: string } {
  const review = describePlan(proposal.plan);
  const count = (pick: (change: PlanReview['chapters'][number]) => number) =>
    review.chapters.reduce((total, change) => total + pick(change), 0);
  const added = count((change) => change.added.length);
  const updated = count((change) => change.changed.length);
  const removed = count((change) => change.removed.length);
  const retired = review.chapters.filter((change) => change.retired).length;
  const changes = added + updated + removed;
  const chapters = review.chapters.map((change) => change.slug);
  const parts = [
    `${added} new`,
    `${updated} updated`,
    ...(removed > 0 ? [`${removed} removed`] : []),
    ...(retired > 0 ? [`${retired} chapter(s) retired`] : []),
  ];
  return {
    title: `Book of Lessons: ${changes} lesson change${changes === 1 ? '' : 's'} proposed`,
    detail:
      `From ${proposal.entries} journal entr${proposal.entries === 1 ? 'y' : 'ies'}: ${parts.join(', ')} ` +
      `across ${chapters.length} chapter(s) (${chapters.join(', ')}). Review the changes, then Accept or Reject.`,
  };
}

// ------------------------------------------------------------------
// Stored-proposal validation: a record is checked completely before
// anything acts on it, so a corrupt plan can never half-apply.
// ------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MANAGED_PATH = /^(?:INDEX\.md|chapters\/[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/u;

function validateLessonProposal(value: unknown, where: string): LessonProposal {
  const fail = (what: string): never => {
    throw new DreamError(`lesson proposal ${where} is malformed (${what}) — inspect or remove it`);
  };
  const record = (input: unknown, what: string): Record<string, unknown> =>
    typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : fail(what);
  const count = (input: unknown, what: string): number =>
    typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : fail(what);
  const text = (input: unknown, what: string): string => (typeof input === 'string' ? input : fail(what));
  const strings = (input: unknown, what: string): string[] =>
    Array.isArray(input) && input.every((item) => typeof item === 'string') ? (input as string[]) : fail(what);
  const range = (input: unknown, what: string): ReplayRange => {
    const row = record(input, what);
    const afterSeq = count(row['afterSeq'], `${what}.afterSeq`);
    const throughSeq = count(row['throughSeq'], `${what}.throughSeq`);
    if (afterSeq >= throughSeq) fail(`${what} is empty`);
    return { afterSeq, throughSeq };
  };
  const state = (input: unknown, what: string): DreamState => {
    try {
      return parseDreamState(input, what);
    } catch {
      return fail(what);
    }
  };

  const instant = (input: unknown, what: string): string => {
    const at = text(input, what);
    return Number.isNaN(Date.parse(at)) ? fail(`${what} is not a timestamp`) : at;
  };

  const row = record(value, 'root');
  if (row['version'] !== 1) fail('version');
  const id = text(row['id'], 'id');
  if (id === '') fail('id');
  instant(row['createdAt'], 'createdAt');
  if (row['notificationId'] !== `lessons-proposal:${id}`) fail('notificationId');
  const entries = count(row['entries'], 'entries');
  const fromState = state(row['fromState'], 'fromState');
  const batch = range(row['batch'], 'batch');
  const nextState = state(row['nextState'], 'nextState');

  // The cursor transition must be exactly the one a dream pass produces:
  // a batch inside the oldest replay range (or past the cursor), and a
  // next state that keeps every other range untouched.
  const ranges = fromState.replay ?? [];
  const head = ranges[0];
  if (batch.afterSeq < (head?.afterSeq ?? fromState.coveredThroughSeq)) fail('batch starts before the cursor');
  if (head !== undefined && batch.throughSeq > head.throughSeq) fail('batch overruns the replay range');
  if (entries < 1 || entries > batch.throughSeq - batch.afterSeq) fail('entries outside the batch');
  if (nextState.coveredThroughSeq !== Math.max(fromState.coveredThroughSeq, batch.throughSeq)) fail('nextState cursor');
  if (nextState.cycles !== fromState.cycles + 1) fail('nextState cycles');
  if (nextState.lastDreamAt === null) fail('nextState lastDreamAt');
  const remainder = head === undefined
    ? []
    : [...(batch.throughSeq < head.throughSeq ? [{ afterSeq: batch.throughSeq, throughSeq: head.throughSeq }] : []), ...ranges.slice(1)];
  if (JSON.stringify(nextState.replay ?? []) !== JSON.stringify(remainder)) fail('nextState replay remainder');

  const plan = record(row['plan'], 'plan');
  // Absent: planned under the first release's contract (R6-01); 2: today's.
  if (plan['contract'] !== undefined && plan['contract'] !== 2) fail('plan.contract');
  if (typeof plan['base'] !== 'string' || !SHA256_HEX.test(plan['base'])) fail('plan.base');
  if (typeof plan['after'] !== 'string' || !SHA256_HEX.test(plan['after'])) fail('plan.after');
  text(plan['indexText'], 'plan.indexText');
  if (!Array.isArray(plan['files'])) fail('plan.files');
  for (const [index, file] of (plan['files'] as unknown[]).entries()) {
    const entry = record(file, `plan.files[${index}]`);
    if (typeof entry['path'] !== 'string' || !MANAGED_PATH.test(entry['path'])) fail(`plan.files[${index}].path`);
    for (const side of ['before', 'after'] as const) {
      const hash = entry[side];
      if (hash !== null && (typeof hash !== 'string' || !SHA256_HEX.test(hash))) fail(`plan.files[${index}].${side}`);
    }
  }
  if (!Array.isArray(plan['before'])) fail('plan.before');
  for (const [index, file] of (plan['before'] as unknown[]).entries()) {
    const entry = record(file, `plan.before[${index}]`);
    if (typeof entry['path'] !== 'string' || !MANAGED_PATH.test(entry['path'])) fail(`plan.before[${index}].path`);
    if (entry['text'] !== null) text(entry['text'], `plan.before[${index}].text`);
  }
  if (!Array.isArray(plan['writes'])) fail('plan.writes');
  for (const [index, write] of (plan['writes'] as unknown[]).entries()) {
    const entry = record(write, `plan.writes[${index}]`);
    if (typeof entry['slug'] !== 'string' || !isLessonsSlug(entry['slug'])) fail(`plan.writes[${index}].slug`);
    text(entry['text'], `plan.writes[${index}].text`);
  }
  for (const slug of strings(plan['retired'], 'plan.retired')) if (!isLessonsSlug(slug)) fail('plan.retired slug');
  const report = record(plan['report'], 'plan.report');
  for (const key of ['chaptersWritten', 'chaptersRetired', 'lessonsAdded', 'lessonsMerged', 'lessonsTrimmed', 'lessonsDropped']) {
    count(report[key], `plan.report.${key}`);
  }
  if (typeof plan['chapterCapBytes'] !== 'number' || !Number.isSafeInteger(plan['chapterCapBytes']) || plan['chapterCapBytes'] <= 0) {
    fail('plan.chapterCapBytes');
  }
  if (row['decision'] !== null) {
    const decision = record(row['decision'], 'decision');
    if (decision['kind'] !== 'accepted' && decision['kind'] !== 'rejected' && decision['kind'] !== 'withdrawn') fail('decision.kind');
    instant(decision['at'], 'decision.at');
    if (decision['detail'] !== null) text(decision['detail'], 'decision.detail');
  }
  if (row['recovery'] !== null) {
    const recovery = record(row['recovery'], 'recovery');
    text(recovery['conflict'], 'recovery.conflict');
    instant(recovery['at'], 'recovery.at');
  }
  // Records written before the committed phase existed read as not yet committed.
  if (row['committed'] === undefined) (row as Record<string, unknown>)['committed'] = null;
  if (row['committed'] !== null) {
    if (row['decision'] === null) fail('committed without a decision');
    instant(record(row['committed'], 'committed')['at'], 'committed.at');
  }
  return value as LessonProposal;
}

/**
 * Cadence trigger for the dream (default: on boot + every 12h), due-based
 * (issue #221): the next pass is due `lastDreamAt + intervalMs`, read from
 * the persisted dream state at start, so a service restart inherits the
 * running cadence instead of resetting it. The on-boot pass fires only
 * when the dream is already due; a restart before the due time waits out
 * the remainder as the first periodic beat. Never overlaps; a failed pass
 * is logged loud and retried at the next beat.
 */
export interface DreamSchedulerOptions {
  /** Interval in ms; 0 disables the periodic trigger (a due on-boot pass still fires). */
  readonly intervalMs: number;
  readonly dreamOnBoot: boolean;
  /** Persisted last-dream timestamp (ISO string) or null (never dreamed),
   * read fresh at start. Omitting it keeps the pre-due semantics: the dream
   * counts as due immediately. */
  readonly lastDreamAt?: () => string | null;
  readonly run: () => Promise<DreamOutcome>;
  /** A failed pass, beyond the log line — production raises an incident so
   * a broken dream cannot stay silent for days (owner incident 2026-10-07). */
  readonly onFailure?: (error: unknown) => void;
  /** A pass that completed (including noop) — production resolves that incident. */
  readonly onSuccess?: (outcome: DreamOutcome) => void;
  readonly log?: Log;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly now?: () => Date;
}

export class DreamScheduler {
  private readonly opts: DreamSchedulerOptions;
  private readonly log: Log;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private firstBeatTimer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(opts: DreamSchedulerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  get running(): boolean {
    return this.timer !== null || this.bootTimer !== null || this.firstBeatTimer !== null;
  }

  /** Milliseconds until the next dream is due, from the persisted schedule:
   * `max(0, lastDreamAt + intervalMs − now)`; null (never dreamed) is due
   * now. An unparsable timestamp is a corrupt state file — refuse to guess. */
  private dueInMs(): number {
    const lastDreamAt = this.opts.lastDreamAt?.() ?? null;
    if (lastDreamAt === null) return 0;
    const last = Date.parse(lastDreamAt);
    if (Number.isNaN(last)) {
      throw new DreamError(
        `persisted dream state has an unparsable lastDreamAt ${JSON.stringify(lastDreamAt)} — inspect or remove the dream state file`,
      );
    }
    return Math.max(0, last + this.opts.intervalMs - this.now().getTime());
  }

  start(): void {
    if (this.timer !== null || this.bootTimer !== null || this.firstBeatTimer !== null) return;
    const dueInMs = this.dueInMs();
    if (this.opts.dreamOnBoot && dueInMs === 0) {
      const setTimeoutImpl = this.opts.setTimeout ?? setTimeout;
      this.bootTimer = setTimeoutImpl(() => {
        this.bootTimer = null;
        void this.tick();
      }, 0);
      this.bootTimer.unref?.();
    }
    if (this.opts.intervalMs > 0) {
      // Cadence continuity: a restart mid-interval waits out the remainder
      // (dueInMs) instead of resetting the clock; due-now falls back to a
      // full interval. The recurring interval arms after the first beat.
      const firstBeatInMs = dueInMs > 0 ? dueInMs : this.opts.intervalMs;
      const setTimeoutImpl = this.opts.setTimeout ?? setTimeout;
      this.firstBeatTimer = setTimeoutImpl(() => {
        this.firstBeatTimer = null;
        void this.tick();
        const setIntervalImpl = this.opts.setInterval ?? setInterval;
        this.timer = setIntervalImpl(() => {
          void this.tick();
        }, this.opts.intervalMs);
        this.timer.unref?.();
      }, firstBeatInMs);
      this.firstBeatTimer.unref?.();
    }
    this.log('info', 'lesson dream trigger started', {
      interval_ms: this.opts.intervalMs,
      on_boot: this.opts.dreamOnBoot,
      boot_pass_due: this.opts.dreamOnBoot && dueInMs === 0,
      due_in_ms: dueInMs,
      first_beat_in_ms: this.opts.intervalMs > 0 ? (dueInMs > 0 ? dueInMs : this.opts.intervalMs) : null,
    });
  }

  stop(): void {
    if (this.bootTimer !== null) {
      (this.opts.clearTimeout ?? clearTimeout)(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.firstBeatTimer !== null) {
      (this.opts.clearTimeout ?? clearTimeout)(this.firstBeatTimer);
      this.firstBeatTimer = null;
    }
    if (this.timer !== null) {
      (this.opts.clearInterval ?? clearInterval)(this.timer);
      this.timer = null;
    }
  }

  /** A throwing hook is logged, never allowed to break the beat. */
  private notify(hook: 'onFailure' | 'onSuccess', call: () => void): void {
    try {
      call();
    } catch (error) {
      this.log('warn', `dream ${hook} hook threw`, { error: String(error) });
    }
  }

  /** One dream beat. A busy engine skips the beat (returns null). */
  async tick(): Promise<DreamOutcome | null> {
    if (this.busy) {
      this.log('info', 'dream beat skipped — previous pass still running', {});
      return null;
    }
    this.busy = true;
    try {
      const outcome = await this.opts.run();
      if (outcome.status === 'noop') {
        this.log('debug', 'dream beat: no new journal entries', {});
      }
      this.notify('onSuccess', () => this.opts.onSuccess?.(outcome));
      return outcome;
    } catch (error) {
      this.log('error', 'dream pass failed — the next beat retries', {
        error: String(error),
      });
      this.notify('onFailure', () => this.opts.onFailure?.(error));
      return null;
    } finally {
      this.busy = false;
    }
  }
}

export function loadDreamState(file: string): DreamState {
  if (!existsSync(file)) {
    return { version: 1, coveredThroughSeq: 0, lastDreamAt: null, cycles: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new DreamError(
      `dream state ${file} is unreadable (${String(error)}); refusing to guess — inspect or remove the file`,
    );
  }
  return parseDreamState(parsed, `dream state ${file}`);
}

function parseDreamState(parsed: unknown, where: string): DreamState {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DreamError(`${where} is not an object — inspect or remove the file`);
  }
  const row = parsed as Record<string, unknown>;
  const covered = row['coveredThroughSeq'];
  const lastDreamAt = row['lastDreamAt'];
  const cycles = row['cycles'];
  if (typeof covered !== 'number' || !Number.isSafeInteger(covered) || covered < 0) {
    throw new DreamError(`${where} has an invalid coveredThroughSeq — inspect or remove the file`);
  }
  // A timestamp the scheduler cannot read would stop it at startup.
  if (lastDreamAt !== null && (typeof lastDreamAt !== 'string' || Number.isNaN(Date.parse(lastDreamAt)))) {
    throw new DreamError(`${where} has an invalid lastDreamAt — inspect or remove the file`);
  }
  if (typeof cycles !== 'number' || !Number.isSafeInteger(cycles) || cycles < 0) {
    throw new DreamError(`${where} has an invalid cycles counter — inspect or remove the file`);
  }
  const state: DreamState = { version: 1, coveredThroughSeq: covered, lastDreamAt, cycles };
  const replay = row['replay'];
  if (replay === undefined) return state;
  // One range (the format before disjoint ranges) or a list of them.
  const ranges = Array.isArray(replay) ? (replay as unknown[]) : [replay];
  const parsedRanges = ranges.map((item) => {
    const range = item as Record<string, unknown> | null;
    const afterSeq = range?.['afterSeq'];
    const throughSeq = range?.['throughSeq'];
    if (
      typeof afterSeq !== 'number' || !Number.isSafeInteger(afterSeq) || afterSeq < 0 ||
      typeof throughSeq !== 'number' || !Number.isSafeInteger(throughSeq) || throughSeq <= afterSeq
    ) {
      throw new DreamError(`${where} has an invalid replay range — inspect or remove the file`);
    }
    // A replay range is a batch the cursor already passed: one beyond it
    // would let the cursor jump past entries nobody reviewed.
    if (throughSeq > covered) {
      throw new DreamError(`${where} has a replay range beyond its cursor — inspect or remove the file`);
    }
    return { afterSeq, throughSeq };
  });
  return withReplay(state, coalesceReplay(parsedRanges));
}

export function saveDreamState(file: string, state: DreamState): void {
  const staging = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    renameSync(staging, file);
  } catch (error) {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* best effort — the active state was never replaced */
    }
    throw new DreamError(`could not write dream state ${file}: ${String(error)}`);
  }
}
