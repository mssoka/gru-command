import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { escalationLabelFromResolvedDetail } from './escalation-triage.js';
import { filteredState, type DecisionMemoryFacts } from '../questions.js';
import { SILAS_YIELD_ACTION_KINDS } from '../../telemetry/yield.js';
import type { LabelledCase } from './registry.js';

/**
 * Escalation-triage labelled-case extractor (issue #223).
 *
 * Links each `gru.wake` to the Silas-authored escalation notifications it
 * delivered, then labels the case from Gru's actual outcome:
 *  - the wake's notifications resolved as duplicate / covered / "nothing
 *    actionable" → `defer_ok`;
 *  - an ops action (Silas directive, re-brief, PR registration, job
 *    creation, …) followed before the next Gru wake → `needs_ruling`.
 * Wakes with mixed or absent evidence are skipped — never guessed.
 *
 * Read-only: the extractor reads the ledger with the same read-only
 * sqlite access the yield report (#214) uses, and the produced state is
 * built through `filteredState` so it carries exactly what a production
 * decision request would carry (redacted, bounded, no credentials).
 */

interface WakeRow {
  readonly seq: number;
  readonly ts: string | null;
  readonly notificationIds: readonly string[];
  readonly mode: string | null;
}

interface NotificationRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string | null;
  readonly detail: string | null;
}

interface EventRow {
  readonly seq: number;
  readonly ts: string | null;
  readonly kind: string;
  readonly jobId: string | null;
  readonly payload: unknown;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

export function parseWakeRow(row: EventRow): WakeRow | null {
  const payload = payloadRecord(row.payload);
  const ids = payload['notification_ids'];
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) return null;
  const mode = payload['mode'];
  return {
    seq: row.seq,
    ts: typeof row.ts === 'string' ? row.ts : null,
    notificationIds: ids as readonly string[],
    mode: typeof mode === 'string' ? mode : null,
  };
}

/** Decision memory (#218) as of the wake, reduced to the exact facts the
 * production ask carries (covers and basis fingerprint included, so a
 * hold scoped to another signal cannot read as applicable). Guarded: a
 * ledger from before migration `decisions` contributes nothing. */
function decisionMemoryAtWake(db: InstanceType<typeof DatabaseSync>, subjects: readonly string[], wakeTs: string | null): {
  openDecisions?: readonly DecisionMemoryFacts[];
  recentDispositions?: readonly DecisionMemoryFacts[];
} {
  try {
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decisions'",
    ).all();
    if (table.length === 0) return {};
    const memory: { openDecisions?: readonly DecisionMemoryFacts[]; recentDispositions?: readonly DecisionMemoryFacts[] } = {};
    const toFacts = (row: Record<string, unknown>): DecisionMemoryFacts => ({
      decision: String(row['decision'] ?? ''),
      reason: String(row['reason'] ?? ''),
      by: String(row['by'] ?? ''),
      covers: (JSON.parse(String(row['covers'] ?? '[]')) as readonly string[]).join(','),
      basis_fingerprint: typeof row['basis_fingerprint'] === 'string' ? (row['basis_fingerprint'] as string) : null,
      recheck_at: typeof row['recheck_at'] === 'string' ? (row['recheck_at'] as string) : null,
    });
    const cut = wakeTs === null ? '' : ' AND created_at <= ?';
    const args = wakeTs === null ? [] : [wakeTs];
    const open: DecisionMemoryFacts[] = [];
    const recent: DecisionMemoryFacts[] = [];
    for (const subject of subjects) {
      for (const row of db.prepare(
        `SELECT decision, reason, by, covers, basis_fingerprint, recheck_at FROM decisions
         WHERE subject = ? AND cleared_at IS NULL${cut} ORDER BY created_at LIMIT 4`,
      ).all(subject, ...args) as Record<string, unknown>[]) open.push(toFacts(row));
      for (const row of db.prepare(
        `SELECT decision, reason, by, covers, basis_fingerprint, recheck_at FROM decisions
         WHERE subject = ?${cut} ORDER BY created_at DESC LIMIT 3`,
      ).all(subject, ...args) as Record<string, unknown>[]) recent.push(toFacts(row));
    }
    if (open.length > 0) memory['openDecisions'] = open.slice(0, 12);
    if (recent.length > 0) memory['recentDispositions'] = recent.slice(0, 12);
    return memory;
  } catch {
    // A damaged or future-schema ledger contributes no memory context —
    // the case stays askable without it, exactly like production's
    // failed-read path.
    return {};
  }
}

/** Extract labelled escalation-triage cases from an OPEN read-only ledger
 * database (caller owns closing). Pure over the database contents. */
export function extractEscalationTriageCases(db: InstanceType<typeof DatabaseSync>): LabelledCase[] {
  const events = (
    db.prepare(
      `SELECT seq, ts, kind, job_id, payload FROM events
       WHERE kind IN ('gru.wake', 'notification.resolved', 'job.created', ${SILAS_YIELD_ACTION_KINDS.map((kind) => `'${kind}'`).join(', ')})
       ORDER BY seq`,
    ).all() as Record<string, unknown>[]
  ).map((row) => ({
    seq: Number(row['seq']),
    ts: typeof row['ts'] === 'string' ? (row['ts'] as string) : null,
    kind: String(row['kind']),
    jobId: typeof row['job_id'] === 'string' ? row['job_id'] : null,
    payload: safeParse(row['payload']),
  }));
  const notifications = new Map<string, NotificationRow>(
    (
      db.prepare('SELECT id, kind, title, detail FROM notifications').all() as Record<string, unknown>[]
    ).map((row) => [
      String(row['id']),
      {
        id: String(row['id']),
        kind: String(row['kind']),
        title: typeof row['title'] === 'string' ? row['title'] : null,
        detail: typeof row['detail'] === 'string' ? row['detail'] : null,
      },
    ]),
  );

  const wakes: WakeRow[] = [];
  for (const event of events) {
    if (event.kind === 'gru.wake') {
      const wake = parseWakeRow(event);
      if (wake !== null) wakes.push(wake);
    }
  }

  const cases: LabelledCase[] = [];
  for (let index = 0; index < wakes.length; index++) {
    const wake = wakes[index]!;
    const windowEnd = index + 1 < wakes.length ? wakes[index + 1]!.seq : Number.MAX_SAFE_INTEGER;
    const window = events.filter((event) => event.seq > wake.seq && event.seq < windowEnd);
    const ids = new Set(wake.notificationIds);
    const escalations = wake.notificationIds
      .map((id) => notifications.get(id))
      .filter((row): row is NotificationRow => row !== undefined)
      .filter((row) => row.kind.startsWith('silas.escalated') || row.kind.includes('escalat'));
    if (escalations.length === 0) continue;
    const jobs = new Set(escalations.map((row) => row.kind.match(/^silas\.escalated:(.+)$/u)?.[1]).filter((id): id is string => id !== undefined));

    let deferEvidence = false;
    let rulingEvidence = false;
    for (const event of window) {
      if (event.kind === 'notification.resolved') {
        const payload = payloadRecord(event.payload);
        const id = payload['id'];
        if (typeof id !== 'string' || !ids.has(id)) continue;
        const detail = [payload['detail'], payload['by']].filter((part): part is string => typeof part === 'string').join(' ');
        if (escalationLabelFromResolvedDetail(detail) === 'defer_ok') deferEvidence = true;
        continue;
      }
      // Only an action tied to the wake is an outcome; unrelated ops work
      // in the same interval cannot label this escalation.
      const payload = payloadRecord(event.payload);
      const notificationIds = payload['notification_ids'];
      if (
        (typeof payload['notification_id'] === 'string' && ids.has(payload['notification_id'])) ||
        (Array.isArray(notificationIds) && notificationIds.some((id) => typeof id === 'string' && ids.has(id))) ||
        (event.jobId !== null && jobs.has(event.jobId)) ||
        (typeof payload['job_id'] === 'string' && jobs.has(payload['job_id']))
      ) rulingEvidence = true;
    }
    if (deferEvidence === rulingEvidence) continue; // absent or contradictory evidence is never guessed

    // Decision memory (#218) as of the wake — the same facts production
    // carries (open decisions + recent dispositions for the escalated
    // subjects, covers/basis included). Keys are omitted when empty so
    // memory-less history keeps the pre-#218 state shape byte-for-byte.
    const subjects = [
      ...new Set(
        escalations
          .map((row) => row.kind.match(/^silas\.escalated:(.+)$/u)?.[1])
          .filter((id): id is string => id !== undefined)
          .map((id) => `job:${id}`),
      ),
    ];
    const memory = subjects.length > 0 ? decisionMemoryAtWake(db, subjects, wake.ts) : {};
    cases.push({
      id: `escalation-wake-${wake.seq}`,
      state: filteredState({
        wake: { notification_count: wake.notificationIds.length, mode: wake.mode },
        escalations: escalations.map((row) => ({ kind: row.kind, title: row.title, detail: row.detail })),
        ...(memory['openDecisions'] !== undefined ? { open_decisions: memory['openDecisions'] } : {}),
        ...(memory['recentDispositions'] !== undefined ? { recent_dispositions: memory['recentDispositions'] } : {}),
      }),
      label: deferEvidence ? 'defer_ok' : 'needs_ruling',
    });
  }
  return cases;
}

function safeParse(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** Stable per-case content hash used by artifact-based extractors for ids. */
export function caseHash(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);
}
