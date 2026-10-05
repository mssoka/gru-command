import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { redactedText } from '../decisions/questions.js';
import type { BusEvent, EventBus } from '../events/bus.js';
import type { LogLevel } from '../logger.js';
import { JOURNAL_MAX_TAG_CHARS, type JournalStore } from './journal.js';
import { LessonCaptureError } from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Perkins review outcome capture (issue #221): when a review round posts
 * a verdict, every blocker in its durable consolidated record becomes ONE
 * deliberate journal entry, so the dream learns from reviews without
 * Bob's hourly consolidation pass. The entry is exactly the shape the
 * journal validates: kind `finding`, source `perkins:<roundId>` (valid
 * under SOURCE_PATTERN), tags `repo:<repo>`, `review:blocker`,
 * `category:<category>`, and a bounded, redacted
 * `<title> — <location>: <detail>` body.
 *
 * Idempotency: a small sidecar of captured round ids (bounded, atomic)
 * makes duplicate verdict events and service restarts journal nothing
 * twice. A round whose consolidated record is missing or unreadable is
 * NOT marked — the failure is loud and a re-posted verdict retries.
 */

/** Body bound for one journaled review finding (a note, not a document). */
export const REVIEW_FINDING_BODY_MAX_CHARS = 2_000;
/** Matches the consolidated records Perkins writes (whole-PR review). */
const CONSOLIDATED_MAX_BYTES = 8 * 1024 * 1024;
/** The same ingress shape `reviewArtifactDirectory` enforces for round ids
 * used as artifact path components — re-checked here before joining paths. */
const ROUND_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;

const VALID_SEVERITIES = ['blocker', 'warning', 'note'] as const;

export interface ReviewOutcomeCaptureOptions {
  readonly bus: EventBus;
  readonly journal: JournalStore;
  /** The Perkins review artifact root (`<data_dir>/reviews`): consolidated
   * records live at `<artifactRoot>/<roundId>/consolidated.json`. */
  readonly artifactRoot: string;
  /** Captured-round sidecar; defaults to a dotfile inside the artifact root. */
  readonly stateFile?: string;
  readonly log?: Log;
}

export interface ConsolidatedFindingSurface {
  readonly severity: string;
  readonly category: string;
  readonly title: string;
  readonly location: string;
  readonly detail: string;
}

export interface ConsolidatedRecordSurface {
  readonly findings: readonly ConsolidatedFindingSurface[];
  readonly repoPath: string;
}

/** Compose one journal tag: redacted (model-supplied text can carry
 * secrets) and bounded to the journal's per-tag limit — a tag is a filter
 * handle, not a record; the body carries the full text. */
function boundedTag(tag: string): string {
  return redactedText(tag, JOURNAL_MAX_TAG_CHARS);
}

function assertObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LessonCaptureError(`consolidated record ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LessonCaptureError(`consolidated record ${name} must be a non-empty string`);
  }
  return value;
}

/**
 * Read the surface this capture consumes from a consolidated record —
 * the blocker findings and the reviewed repo path. The record is
 * machine-written and strictly validated at submit time; anything
 * malformed here is corruption and fails loud (the round stays
 * uncaptured rather than half-journaled).
 */
export function readConsolidatedSurface(artifactRoot: string, roundId: string): ConsolidatedRecordSurface {
  if (!ROUND_ID_PATTERN.test(roundId) || roundId === '.' || roundId === '..') {
    throw new LessonCaptureError(`review round id ${JSON.stringify(roundId)} is not a safe artifact path component`);
  }
  const file = join(artifactRoot, roundId, 'consolidated.json');
  if (!existsSync(file)) {
    throw new LessonCaptureError(`consolidated record ${file} does not exist (yet) — verdict captured nothing`);
  }
  if (statSync(file).size > CONSOLIDATED_MAX_BYTES) {
    throw new LessonCaptureError(`consolidated record ${file} exceeds ${CONSOLIDATED_MAX_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new LessonCaptureError(`consolidated record ${file} is not valid JSON: ${String(error)}`);
  }
  const record = assertObject(parsed, file);
  const rawFindings = record['findings'];
  if (!Array.isArray(rawFindings)) {
    throw new LessonCaptureError(`consolidated record ${file} has no findings array`);
  }
  const findings = rawFindings.map((candidate, index): ConsolidatedFindingSurface => {
    const finding = assertObject(candidate, `finding ${index}`);
    const severity = assertString(finding['severity'], `finding ${index} severity`);
    if (!(VALID_SEVERITIES as readonly string[]).includes(severity)) {
      throw new LessonCaptureError(`consolidated record ${file} finding ${index} severity is invalid`);
    }
    return {
      severity,
      category: assertString(finding['category'], `finding ${index} category`),
      title: assertString(finding['title'], `finding ${index} title`),
      location: assertString(finding['location'], `finding ${index} location`),
      detail: assertString(finding['detail'], `finding ${index} detail`),
    };
  });
  const frozen = assertObject(record['frozen'] ?? {}, 'frozen manifest');
  const repoPath = assertString(frozen['repoPath'], 'frozen.repoPath');
  return { findings, repoPath };
}

function loadCapturedRounds(file: string): readonly string[] {
  if (!existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (error) {
    throw new LessonCaptureError(
      `review capture sidecar ${file} is unreadable (${String(error)}) — inspect or remove the file`,
    );
  }
  const row = assertObject(parsed, file);
  const ids = row['capturedRoundIds'];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new LessonCaptureError(`review capture sidecar ${file} has an invalid capturedRoundIds array`);
  }
  return ids as readonly string[];
}

function saveCapturedRounds(file: string, rounds: readonly string[]): void {
  // Full history: the sidecar is tiny (a short id per reviewed round) and
  // eviction would let an old duplicate verdict journal its blockers twice.
  const staging = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(staging, `${JSON.stringify({ version: 1, capturedRoundIds: rounds }, null, 2)}\n`, 'utf-8');
    renameSync(staging, file);
  } catch (error) {
    try {
      rmSync(staging, { force: true });
    } catch {
      /* best effort — the active sidecar was never replaced */
    }
    throw new LessonCaptureError(`could not write review capture sidecar ${file}: ${String(error)}`);
  }
}

/** Bodies already journaled for `perkins:<roundId>` — the idempotency
 * check that makes a partial-failure retry (or a lost sidecar) append
 * only the missing findings instead of duplicating the recorded ones.
 * Pages the whole journal so correctness never depends on its size. */
function journaledFindingBodies(journal: JournalStore, source: string): Set<string> {
  const bodies = new Set<string>();
  let after = 0;
  for (;;) {
    const page = journal.list({ after, limit: 10_000 });
    if (page.length === 0) break;
    for (const entry of page) {
      if (entry.source === source && entry.kind === 'finding') bodies.add(entry.body);
    }
    after = page[page.length - 1]!.seq;
    if (page.length < 10_000) break;
  }
  return bodies;
}

/**
 * Subscribe to the event bus and journal one finding per consolidated
 * blocker on every `round.verdict`. Returns the unsubscribe handle. A
 * capture failure is logged loud and leaves the round uncaptured (a
 * duplicate verdict event retries); idempotency is enforced twice — the
 * sidecar short-circuits known rounds, and the journal itself dedupes
 * per-finding so a partial capture never duplicates on retry. The round
 * is remembered only after the sidecar write succeeds.
 */
export function createReviewOutcomeCapture(opts: ReviewOutcomeCaptureOptions): () => void {
  const log = opts.log ?? (() => {});
  const stateFile = opts.stateFile ?? join(opts.artifactRoot, '.review-capture-state.json');
  const capturedRounds = new Set<string>(loadCapturedRounds(stateFile));

  const captureRound = (roundId: string): void => {
    if (capturedRounds.has(roundId)) return;
    let journaled = 0;
    try {
      const record = readConsolidatedSurface(opts.artifactRoot, roundId);
      const repoTag = boundedTag(`repo:${basename(record.repoPath)}`);
      const source = `perkins:${roundId}`;
      const alreadyJournaled = journaledFindingBodies(opts.journal, source);
      const blockers = record.findings.filter((finding) => finding.severity === 'blocker');
      for (const finding of blockers) {
        const body = redactedText(
          `${finding.title} — ${finding.location}: ${finding.detail}`,
          REVIEW_FINDING_BODY_MAX_CHARS,
        );
        if (alreadyJournaled.has(body)) continue;
        opts.journal.append({
          kind: 'finding',
          source,
          tags: [repoTag, 'review:blocker', boundedTag(`category:${finding.category}`)],
          body,
        });
        journaled += 1;
      }
      saveCapturedRounds(stateFile, [...capturedRounds, roundId]);
      capturedRounds.add(roundId);
      log('info', 'perkins review outcome captured into the journal', {
        round_id: roundId,
        blockers: blockers.length,
      });
    } catch (error) {
      log('error', 'perkins review outcome capture failed — round left uncaptured for a retry', {
        round_id: roundId,
        journaled,
        error: String(error),
      });
    }
  };

  return opts.bus.subscribe((event: BusEvent) => {
    if (event.kind !== 'round.verdict' || event.roundId === null) return;
    captureRound(event.roundId);
  });
}
