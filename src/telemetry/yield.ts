/**
 * Yield telemetry (#214) — pure aggregation for the per-trigger cost and
 * yield report. No I/O lives here: the CLI (`src/cli/yield-report.ts`)
 * streams session JSONL and a read-only ledger into these functions, and
 * tests feed fixtures directly. Read-only over the ledger by contract —
 * never write, never migrate.
 *
 * Attribution rules mirror the prompt builders that produce each turn:
 * the prefixes below are retyped here on purpose (the issue scopes this
 * work to new files only) and pinned against drift by tests that run the
 * real prompt builders through `classifyTurn`.
 */

import { createHash } from 'node:crypto';
import { AWARENESS_BLOCK_HEADER } from '../chat/awareness.js';
import { DEFAULT_DECISIONS_CONFIG } from '../config.js';
import { hasShadowEffect, shadowEffectDisagreement, shadowSurfaceRisks } from '../decisions/effects.js';
import { decisionRoute, validateThresholdConfig } from '../decisions/service.js';
import type { Answer, DecisionRoute, RiskClass, ThresholdsConfig } from '../decisions/types.js';
import { BOB_CONSOLIDATION_PROMPT } from '../dispatch/bob-scheduler.js';
import { TERMINAL_JOB_STATUSES } from '../ledger/states.js';

// ------------------------------------------------------------------
// Vocabulary
// ------------------------------------------------------------------

/**
 * Stable identity of a policy-started Gru turn: the FIRST clause of
 * AWARENESS_WAKE_INSTRUCTION. The instruction's tail evolves (GH-218/219
 * appended the decision-memory order), so matching the whole live constant
 * classified every historical wake as an owner turn — 0 of 202 real wake
 * prompts matched. A test pins this marker as the constant's prefix.
 */
export const SERVICE_WAKE_MARKER = 'This turn was started by the service wake policy';

export const SESSION_ROLES = ['gru', 'silas', 'bob', 'perkins', 'minion'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

import { AUTOPILOT_DECISION_EVENT, AUTOPILOT_SOURCE } from '../dispatch/silas-autopilot.js';

/** Which budget a trigger spends: machine attention, delivery work, owner chat. */
export const TURN_CLASSES = ['machine', 'delivery', 'owner'] as const;
export type TurnClass = (typeof TURN_CLASSES)[number];

/** Prompt-format prefixes. Retyped from the builders named in #214; the
 * tests classify real builder output through `classifyTurn` so any prompt
 * rewording fails loudly instead of silently mis-attributing turns. */
export const SILAS_WAKE_PREFIX = 'Silas ops wake — trigger: ';
export const DREAM_PROMPT_PREFIX = 'Book of Lessons — dream pass.';
export const PERKINS_LEAD_PROMPT_PREFIX = 'Conduct the complete Perkins review';
export const MINION_BRIEFING_PREFIX = 'Dispatch briefing — job ';
export const MINION_REBRIEF_PREFIX = 'Re-brief — job ';

/** Silas ops actions that count as follow-through yield. The issue's list
 * plus `provider.recovery-claimed`, which the driver itself treats as Silas
 * follow-through (silas-driver.ts groups it with directive-sent). */
export const SILAS_YIELD_ACTION_KINDS = [
  'silas.directive-sent',
  'silas.rebrief',
  'silas.escalated',
  'silas.pr-registered',
  'silas.review-triggered',
  // The sweep-ack release receipt (issue #117): a rule-based close-out is
  // Silas follow-through and must attribute like every other action.
  'silas.lane-released',
  'job.pr',
  'job.pr-linked',
  'verification.requested',
  'silas.rebrief-recovered',
  'provider.recovery-claimed',
] as const;

/** Ledger kinds the report reads (beyond the wake kinds above). */
export const REPORT_EVENT_KINDS = [
  'silas.wake',
  'gru.wake',
  ...SILAS_YIELD_ACTION_KINDS,
  'notification.resolved',
  'job.status',
  'job.created',
  'decisions.shadow',
  AUTOPILOT_DECISION_EVENT,
] as const;

/** Notification-kind prefix of the mechanical PR-conflict alerts that
 * should belong to Silas's digest, not Gru's attention (#215). */
export const PR_CONFLICT_NOTIFICATION_PREFIX = 'github.pr-conflict';

// ------------------------------------------------------------------
// Turn parsing (from pi session JSONL shapes)
// ------------------------------------------------------------------

export interface TokenClasses {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface ParsedTurn {
  readonly role: SessionRole;
  readonly label: string;
  readonly turnClass: TurnClass;
  /** ISO timestamp of the turn's opening user message. */
  readonly startedAt: string;
  readonly llmCalls: number;
  readonly tokens: TokenClasses;
  readonly costUsd: number;
  readonly compactions: number;
  /** Reduced digest signature (sorted job IDs per category) when the
   * opening prompt is a Silas wake carrying a parseable digest; else null. */
  readonly digestSignature: string | null;
  /** provider/model per assistant message with that message's cost, for
   * the per-model table. */
  readonly models: readonly { readonly provider: string; readonly model: string; readonly costUsd: number }[];
}

export interface SessionParseResult {
  readonly turns: readonly ParsedTurn[];
  /** Lines that were not valid JSON or not a known pi record shape. */
  readonly unparsableLines: number;
  /** Compaction records seen before any turn opened (unattributable). */
  readonly unattributedCompactions: number;
}

export interface TurnClassification {
  readonly label: string;
  readonly turnClass: TurnClass;
}

/** Attribute one opening user message to its trigger. Pure. */
export function classifyTurn(role: SessionRole, text: string): TurnClassification {
  switch (role) {
    case 'silas': {
      const kind = parseSilasWakeTrigger(text);
      return kind === null ? { label: 'other', turnClass: 'machine' } : { label: kind, turnClass: 'machine' };
    }
    case 'gru':
      if (text.includes(SERVICE_WAKE_MARKER)) return { label: 'service-wake', turnClass: 'machine' };
      if (text.startsWith(AWARENESS_BLOCK_HEADER)) return { label: 'owner-turn+awareness', turnClass: 'owner' };
      return { label: 'owner-turn', turnClass: 'owner' };
    case 'bob':
      if (text.startsWith(BOB_CONSOLIDATION_PROMPT)) return { label: 'consolidation', turnClass: 'machine' };
      if (text.startsWith(DREAM_PROMPT_PREFIX)) return { label: 'dream', turnClass: 'machine' };
      return { label: 'other', turnClass: 'machine' };
    case 'perkins':
      if (text.startsWith(PERKINS_LEAD_PROMPT_PREFIX)) return { label: 'lead', turnClass: 'delivery' };
      return { label: 'lens', turnClass: 'delivery' };
    case 'minion':
      if (text.startsWith(MINION_BRIEFING_PREFIX)) return { label: 'briefing', turnClass: 'delivery' };
      if (text.startsWith(MINION_REBRIEF_PREFIX)) return { label: 'rebrief', turnClass: 'delivery' };
      return { label: 'directive/other', turnClass: 'delivery' };
  }
}

/** `buildWakePrompt` opens `Silas ops wake — trigger: <kind>` with an
 * optional ` (job <id>)` clause. Returns the trigger kind when it is a
 * bounded identifier (trigger kinds and future kinds are dot-separated
 * identifiers; anything else is refused so prompt text can never leak
 * into a report label), null when the text is not a wake prompt. */
export function parseSilasWakeTrigger(text: string): string | null {
  if (!text.startsWith(SILAS_WAKE_PREFIX)) return null;
  const rest = text.slice(SILAS_WAKE_PREFIX.length);
  const end = rest.search(/(?: \(job |\n)/);
  const kind = end === -1 ? rest : rest.slice(0, end);
  return /^[A-Za-z0-9._-]{1,40}$/.test(kind) ? kind : null;
}

/** Digest header exactly as `buildWakePrompt` renders it. */
export const SILAS_DIGEST_HEADER = '## Digest (actionable states, JSON)';

const DIGEST_FENCE = /## Digest \(actionable states, JSON\)\s*\n+```json\n([\s\S]*?)\n```/;

/** The wake prompt's digest-identity line (issue #217): every wake — full
 * or delta — names the fingerprint of the digest it was built from, so
 * stability attribution survives the delta prompt shape. */
const DIGEST_FINGERPRINT_LINE = /^Digest fingerprint: ([0-9a-f]{64})$/m;

/** Digest categories that carry actionable rows (skip the scalar header
 * fields `computedAt`/`trigger`). Order is the SilasOpsDigest field order. */
export const DIGEST_CATEGORY_KEYS = [
  'deliveredWithoutPr',
  'prWithoutReview',
  'verdictsAwaitingDirective',
  'stalledWorking',
  'minionErrors',
  'verificationFailures',
  'verificationWaits',
  'providerRecoveryPending',
  'conflictingPrs',
] as const;

/** Parse the digest identity from a Silas wake prompt and reduce it to a
 * stability signature: the `Digest fingerprint:` line when the prompt
 * carries one (issue #217 — full and delta wakes alike), otherwise the
 * fenced full-digest JSON reduced per category to the sorted job IDs
 * (wait ID when a row has no job; older prompt shapes). Null when the
 * prompt carries neither. */
export function digestSignatureFromPrompt(prompt: string): string | null {
  // Fingerprint-bearing prompts (issue #217) attribute directly: the
  // fingerprint IS the stable digest identity, and it is the only
  // digest signal a delta wake carries.
  const fingerprint = DIGEST_FINGERPRINT_LINE.exec(prompt);
  if (fingerprint !== null) return `fp:${fingerprint[1]}`;
  const match = DIGEST_FENCE.exec(prompt);
  const body = match === null ? undefined : match[1];
  if (body === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const digest = parsed as Record<string, unknown>;
  // Shape guard: every PRESENT category must be an array, and at least one
  // actionable category must exist at all. Keys may be ABSENT — older
  // digest formats predate newer categories (e.g. verificationFailures
  // landed with #163) and count as empty for those formats — but a payload
  // with no actionable categories is not a digest, and a non-array value
  // is corrupt; either would fake stability.
  let presentCategories = 0;
  for (const key of DIGEST_CATEGORY_KEYS) {
    const value = digest[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return null;
    presentCategories += 1;
  }
  if (presentCategories === 0) return null;
  const signature: Record<string, readonly string[]> = {};
  for (const key of DIGEST_CATEGORY_KEYS) {
    const rows = digest[key];
    const ids = Array.isArray(rows)
      ? rows
          .map((row) => {
            if (row === null || typeof row !== 'object') return '';
            const record = row as Record<string, unknown>;
            const jobId = record['jobId'];
            if (typeof jobId === 'string' && jobId !== '') return jobId;
            const waitId = record['waitId'];
            return typeof waitId === 'string' ? waitId : '';
          })
          .filter((id) => id !== '')
          .sort()
      : [];
    signature[key] = ids;
  }
  return JSON.stringify(signature);
}

/** Extract the user-visible text of a pi `message` record's content. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const part of content) {
    if (part !== null && typeof part === 'object' && (part as Record<string, unknown>)['type'] === 'text') {
      const value = (part as Record<string, unknown>)['text'];
      if (typeof value === 'string') text += value;
    }
  }
  return text;
}

const emptyTokens = (): TokenClasses => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

/** Lines skipped while parsing, reported so drift stays visible. */
export interface ParseSkips {
  readonly unparsableLines: number;
  readonly unattributedCompactions: number;
}

/** Statefully fold one pi session's JSONL lines into attributed turns.
 * A turn is one `user` message plus the assistant messages that follow it,
 * up to the next `user` message. Accepts a sync or async iterable so the
 * CLI can feed a readline interface directly — no session is ever held in
 * memory whole. Unparsable lines are counted, never thrown; prompt text is
 * never retained. */
export async function parseSessionLines(
  role: SessionRole,
  lines: Iterable<string> | AsyncIterable<string>,
): Promise<SessionParseResult> {
  const turns: ParsedTurn[] = [];
  let unparsableLines = 0;
  let unattributedCompactions = 0;

  let open: {
    readonly startedAt: string;
    readonly label: string;
    readonly turnClass: TurnClass;
    readonly digestSignature: string | null;
    llmCalls: number;
    tokens: TokenClasses;
    costUsd: number;
    compactions: number;
    models: { provider: string; model: string; costUsd: number }[];
  } | null = null;

  const close = (): void => {
    if (open === null) return;
    turns.push({
      role,
      label: open.label,
      turnClass: open.turnClass,
      startedAt: open.startedAt,
      llmCalls: open.llmCalls,
      tokens: { ...open.tokens },
      costUsd: open.costUsd,
      compactions: open.compactions,
      digestSignature: open.digestSignature,
      models: [...open.models],
    });
    open = null;
  };

  for await (const line of lines) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      unparsableLines += 1;
      continue;
    }
    if (record === null || typeof record !== 'object') {
      unparsableLines += 1;
      continue;
    }
    const shaped = record as Record<string, unknown>;
    const type = shaped['type'];
    if (type === 'compaction') {
      if (open !== null) open.compactions += 1;
      else unattributedCompactions += 1;
      continue;
    }
    if (type !== 'message') continue; // session/model_change/thinking_level_change/…
    const message = shaped['message'];
    if (message === null || typeof message !== 'object') {
      unparsableLines += 1;
      continue;
    }
    const shapedMessage = message as Record<string, unknown>;
    const messageRole = shapedMessage['role'];

    if (messageRole === 'user') {
      close();
      const startedAt = shaped['timestamp'];
      if (typeof startedAt !== 'string' || startedAt === '') {
        // A turn without a timestamp cannot be windowed; count it and move on.
        unparsableLines += 1;
        continue;
      }
      const text = messageText(shapedMessage['content']);
      const { label, turnClass } = classifyTurn(role, text);
      // Reduced, non-sensitive: sorted job IDs per digest category only.
      const digestSignature = role === 'silas' ? digestSignatureFromPrompt(text) : null;
      open = {
        startedAt,
        label,
        turnClass,
        digestSignature,
        llmCalls: 0,
        tokens: emptyTokens(),
        costUsd: 0,
        compactions: 0,
        models: [],
      };
      continue;
    }

    if (messageRole === 'assistant' && open !== null) {
      open.llmCalls += 1;
      let messageCost = 0;
      const usage = shapedMessage['usage'];
      if (usage !== null && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        const num = (key: string): number => {
          const value = u[key];
          return typeof value === 'number' && Number.isFinite(value) ? value : 0;
        };
        open.tokens.input += num('input');
        open.tokens.output += num('output');
        open.tokens.cacheRead += num('cacheRead');
        open.tokens.cacheWrite += num('cacheWrite');
        open.tokens.reasoning += num('reasoning');
        const cost = u['cost'];
        if (cost !== null && typeof cost === 'object') {
          const total = (cost as Record<string, unknown>)['total'];
          if (typeof total === 'number' && Number.isFinite(total)) {
            messageCost = total;
            open.costUsd += total;
          }
        }
      }
      const provider = shapedMessage['provider'];
      const model = shapedMessage['model'];
      if (typeof provider === 'string' && typeof model === 'string') {
        open.models.push({ provider, model, costUsd: messageCost });
      }
    }
    // toolResult and anything else: no usage, no attribution.
  }
  close();
  return { turns, unparsableLines, unattributedCompactions };
}

// ------------------------------------------------------------------
// Aggregation
// ------------------------------------------------------------------

export interface LabelUsage {
  readonly role: SessionRole;
  readonly label: string;
  readonly turnClass: TurnClass;
  turns: number;
  llmCalls: number;
  compactions: number;
  tokens: TokenClasses;
  costUsd: number;
}

export interface ClassUsage {
  turns: number;
  llmCalls: number;
  compactions: number;
  tokens: TokenClasses;
  costUsd: number;
}

export interface ModelUsage {
  readonly provider: string;
  readonly model: string;
  llmCalls: number;
  costUsd: number;
}

export interface UsageSummary {
  readonly byLabel: readonly LabelUsage[];
  readonly byClass: Record<TurnClass, ClassUsage>;
  readonly byModel: readonly ModelUsage[];
  readonly total: ClassUsage;
}

const emptyClassUsage = (): ClassUsage => ({ turns: 0, llmCalls: 0, compactions: 0, tokens: emptyTokens(), costUsd: 0 });

/** Aggregate windowed turns into per-label / per-class / per-model usage. */
export function aggregateUsage(turns: readonly ParsedTurn[]): UsageSummary {
  const byLabel = new Map<string, LabelUsage>();
  const byClass: Record<TurnClass, ClassUsage> = {
    machine: emptyClassUsage(),
    delivery: emptyClassUsage(),
    owner: emptyClassUsage(),
  };
  const byModel = new Map<string, ModelUsage>();
  const total = emptyClassUsage();

  const addUsage = (bucket: ClassUsage, turn: ParsedTurn): void => {
    bucket.turns += 1;
    bucket.llmCalls += turn.llmCalls;
    bucket.compactions += turn.compactions;
    bucket.tokens.input += turn.tokens.input;
    bucket.tokens.output += turn.tokens.output;
    bucket.tokens.cacheRead += turn.tokens.cacheRead;
    bucket.tokens.cacheWrite += turn.tokens.cacheWrite;
    bucket.tokens.reasoning += turn.tokens.reasoning;
    bucket.costUsd += turn.costUsd;
  };

  for (const turn of turns) {
    const key = `${turn.role}/${turn.label}`;
    let label = byLabel.get(key);
    if (label === undefined) {
      label = {
        role: turn.role,
        label: turn.label,
        turnClass: turn.turnClass,
        turns: 0,
        llmCalls: 0,
        compactions: 0,
        tokens: emptyTokens(),
        costUsd: 0,
      };
      byLabel.set(key, label);
    }
    addUsage(label, turn);
    addUsage(byClass[turn.turnClass], turn);
    addUsage(total, turn);
    for (const modelCall of turn.models) {
      const modelKey = `${modelCall.provider}/${modelCall.model}`;
      let entry = byModel.get(modelKey);
      if (entry === undefined) {
        entry = { provider: modelCall.provider, model: modelCall.model, llmCalls: 0, costUsd: 0 };
        byModel.set(modelKey, entry);
      }
      entry.llmCalls += 1;
      entry.costUsd += modelCall.costUsd;
    }
  }

  return {
    byLabel: [...byLabel.values()].sort((a, b) => b.costUsd - a.costUsd || a.role.localeCompare(b.role) || a.label.localeCompare(b.label)),
    byClass,
    byModel: [...byModel.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)),
    total,
  };
}

// ------------------------------------------------------------------
// Ledger measures
// ------------------------------------------------------------------

export interface LedgerEventRecord {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly jobId: string | null;
  readonly payload: unknown;
}

export interface NotificationRecordLite {
  readonly id: string;
  readonly kind: string;
}

export interface JobRecordLite {
  readonly id: string;
  readonly createdAt: string;
}

export interface YieldMeasureInput {
  readonly since: string;
  readonly until: string;
  readonly events: readonly LedgerEventRecord[];
  readonly notifications: readonly NotificationRecordLite[];
  readonly jobs: readonly JobRecordLite[];
}

export interface WakeYield {
  readonly wakes: number;
  readonly wakesWithAction: number;
  /** Share of wakes followed by zero actions before the next wake, 0–1. */
  readonly noActionShare: number;
  /** Actions counted inside wake windows, by event kind. */
  readonly actionsByKind: Readonly<Record<string, number>>;
  /** Per-trigger breakdown for Silas wakes (payload.trigger). */
  readonly byTrigger: readonly { readonly trigger: string; readonly wakes: number; readonly wakesWithAction: number }[];
}

export interface DigestStability {
  /** Sweep prompts whose digest parsed into a signature. */
  readonly sweeps: number;
  /** Sweeps whose signature matched the previous sweep's. */
  readonly stable: number;
  /** stable / comparable (sweeps with a predecessor), 0–1; null when < 2. */
  readonly share: number | null;
}

export interface GruWakeCauses {
  readonly wakesWithNotificationIds: number;
  readonly perKind: readonly { readonly kind: string; readonly wakes: number }[];
  /** Wakes whose every notification is a mechanical PR-conflict alert. */
  readonly conflictOnlyWakes: number;
  /** Notification IDs that woke Gru more than once in the window. */
  readonly repeatIncidentIds: number;
  /** Wakes containing at least one repeat incident ID. */
  readonly wakesWithRepeatIncident: number;
  /** Issue #219 / #214: autonomous Gru wakes per day over the window —
   * the headline cost number the decision-cost program tracks. */
  readonly wakesPerDay: number;
  /** Issue #219 / #214: wakes avoided inside the window because the
   * incident was a duplicate (already-woken incident re-detected under a
   * new row id) or hold-covered (an active decision, issue #218), with
   * their share of (opened + avoided) wake demands. */
  readonly avoided: {
    readonly duplicates: number;
    readonly covered: number;
    /** (duplicates + covered) / (gru.wake count + duplicates + covered);
     * null when nothing was demanded in the window. */
    readonly share: number | null;
  };
}

/** One autopilot rule family's decisions over the window, with the
 * agreement measure the rollout reads (issue #243). Agreement is measured
 * over `dry-run` decisions only: an `enforce` decision already acted, so
 * there is nothing for the model to agree with. A decision AGREES when a
 * receipt of the family's own action kinds lands for the same job AFTER the
 * decision, names the SAME predicted debt identity (round/run/head/url),
 * carries a `rule_id` that names the decision's family (a receipt of a kind
 * shared across families carries no weight without it, H6), and is NOT the
 * autopilot's own machine receipt (`source: 'silas-autopilot'`) — the model
 * read the same row and did the same thing. It is UNOBSERVABLE when no
 * `silas.wake` landed after it in the window: the model was never given the
 * row again. Everything else is a disagreement; a reviewer reading the raw
 * events decides whether a specific disagreement was harmful. */
export interface AutopilotFamilyMeasure {
  readonly ruleId: string;
  /** The mode every decision of this family carried, or 'mixed'. */
  readonly mode: string;
  /** Dry-run decisions: the agreement sample. */
  readonly decisions: number;
  /** Enforce-mode decisions: the action was attempted (a failed enforcement
   * still counts here), so there is nothing for the model to agree with. */
  readonly enforced: number;
  readonly agreed: number;
  readonly unobservable: number;
  readonly agreementShare: number | null;
}

export interface AutopilotMeasures {
  readonly decisions: number;
  readonly byFamily: readonly AutopilotFamilyMeasure[];
}

export interface M0Measures {
  /** Distinct jobs whose status moved to merged|done inside the window. */
  readonly finishedJobs: number;
  readonly leadTimeHours: { readonly median: number; readonly max: number } | null;
  /** Non-terminal jobs (replayed status as of `until`) by status, with age. */
  readonly wipByStatus: readonly { readonly status: string; readonly jobs: number; readonly medianAgeHours: number }[];
  readonly wipTotal: number;
  /** Total in-window cost divided by finished heists; null when none finished. */
  readonly costPerFinishedUsd: number | null;
}

export interface LedgerMeasures {
  readonly silasYield: WakeYield;
  readonly gruYield: WakeYield;
  readonly digestStability: DigestStability;
  readonly gruWakeCauses: GruWakeCauses;
  readonly m0: M0Measures;
  readonly decisionsShadow: DecisionShadowMeasures;
  readonly autopilot: AutopilotMeasures;
}

/** How a provider miss came about, from its recorded diagnostics:
 * - `attempted`: the provider call began (diagnostics past `not_started`)
 *   and failed — before or after reaching the network;
 * - `refused`: refused locally before starting (`not_started`, e.g.
 *   capacity);
 * - `stand_in`: diagnostics recorded as null, i.e. no provider call
 *   recorded. Every failure inside a provider call records diagnostics,
 *   so this is normally a stand-in served while the provider was
 *   degraded or disabled, or a refusal before any call (credentials,
 *   disposal); a call that crashed outside the provider's own error
 *   handling also lands here;
 * - `unrecorded`: rows without a readable cause (predating the cause
 *   fields, or with absent or unreadable diagnostics). */
export type ShadowMissKind = 'attempted' | 'refused' | 'stand_in' | 'unrecorded';

/** Answered-ask measures, for a surface/provider row and per model. */
export interface DecisionShadowAnswered {
  /** Asks the provider answered. */
  readonly answered: number;
  /** Answered asks whose answers or routes are not valid for the
   * surface's consumer effect: counted in cost and latency, never in
   * the share. */
  readonly unmeasured: number;
  /** Measurable answered asks on which the consumer would have acted
   * differently; null when no consumer effect is defined for the surface. */
  readonly disagreements: number | null;
  /** `disagreements / (answered - unmeasured)`; null when unmeasured or
   * nothing measurable was answered. */
  readonly disagreementShare: number | null;
  readonly costUsd: number;
  /** Answered asks with a recorded latency: the sample behind the quantiles. */
  readonly latencySamples: number;
  /** Null when no answered ask recorded a latency. */
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
}

/** One surface/provider row of the shadow-decision measures. Its
 * answered-ask fields cover every model; `models` splits them. */
export interface DecisionShadowRow extends DecisionShadowAnswered {
  readonly surface: string;
  readonly provider: string;
  readonly records: number;
  /** Per answering model, so a model switch inside the window is visible
   * rather than blended. */
  readonly models: readonly (DecisionShadowAnswered & { readonly model: string })[];
  /** Answered asks measured at the assumed default thresholds because
   * they were recorded before 2026-10-11, without their thresholds. */
  readonly assumedThresholds: number;
  readonly providerMisses: number;
  /** Charges recorded on misses (normally none); `costUsd` covers answered asks. */
  readonly missCostUsd: number;
  /** Provider misses by kind and reason, most frequent first. Only
   * `attempted` misses carry elapsed time (e.g. a timeout's). */
  readonly misses: readonly {
    readonly kind: ShadowMissKind;
    readonly reason: string;
    readonly count: number;
    readonly latencySamples: number;
    readonly latencyP50Ms: number | null;
    readonly latencyP95Ms: number | null;
  }[];
}

/** Shadow-decision measures (issue #223, reported per #214) per surface
 * and provider. A disagreement is an answered ask on which the surface's
 * consumer would have acted differently than on the deterministic
 * baseline (`shadowEffectDisagreement`). Provider misses serve the
 * baseline itself, so they are counted and broken down on their own and
 * kept out of the share and the answered latency. Counts and rates only;
 * a shadow record never carries request state. */
export interface DecisionShadowMeasures {
  readonly records: number;
  /** `decisions.shadow` rows without a readable surface, provider or
   * provenance: attributable to no row. */
  readonly skipped: number;
  readonly bySurfaceProvider: readonly DecisionShadowRow[];
}

/** The thresholds a row's routes were banded at: recorded since
 * 2026-10-11, `legacyThresholds` before. Null when recorded but invalid. */
function thresholdsOfRow(row: Readonly<Record<string, unknown>>, legacyThresholds: ThresholdsConfig): ThresholdsConfig | null {
  if (!Object.hasOwn(row, 'thresholds')) return legacyThresholds;
  try {
    validateThresholdConfig(row['thresholds'] as ThresholdsConfig);
    return row['thresholds'] as ThresholdsConfig;
  } catch {
    return null;
  }
}

/** Baseline routes for a row recorded before 2026-10-11, which lacks
 * `deterministic_routes`: band each baseline answer at its question's
 * risk class and `thresholds`. Null when the row cannot supply them. */
function legacyBaselineRoutes(
  row: Readonly<Record<string, unknown>>,
  risks: Readonly<Record<string, RiskClass>>,
  thresholds: ThresholdsConfig,
): Record<string, DecisionRoute> | null {
  const answers = row['deterministic_answers'];
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return null;
  const routes: Record<string, DecisionRoute> = {};
  for (const [id, answer] of Object.entries(answers as Record<string, unknown>)) {
    const riskClass = risks[id];
    if (riskClass === undefined) return null;
    try {
      routes[id] = decisionRoute(answer as Answer, riskClass, thresholds);
    } catch {
      return null;
    }
  }
  return routes;
}

const ATTEMPTED_PHASES: ReadonlySet<string> = new Set(['request', 'response_headers', 'response_body', 'response_validation']);

function missCause(row: Readonly<Record<string, unknown>>): { readonly kind: ShadowMissKind; readonly reason: string } {
  const reason = row['fallback_reason'];
  if (typeof reason !== 'string') return { kind: 'unrecorded', reason: 'unrecorded' };
  if (!Object.hasOwn(row, 'request_diagnostics')) return { kind: 'unrecorded', reason };
  const diagnostics = row['request_diagnostics'];
  if (diagnostics === null) return { kind: 'stand_in', reason };
  const phase = typeof diagnostics === 'object' ? (diagnostics as { phase?: unknown }).phase : undefined;
  if (phase === 'not_started') return { kind: 'refused', reason };
  if (typeof phase === 'string' && ATTEMPTED_PHASES.has(phase)) return { kind: 'attempted', reason };
  return { kind: 'unrecorded', reason };
}

/** A usable elapsed time: finite and never negative. */
const elapsedMs = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index]!;
}

interface AnsweredTally {
  answered: number;
  unmeasured: number;
  disagreements: number;
  cost: number;
  readonly latencies: number[];
}

const newTally = (): AnsweredTally => ({ answered: 0, unmeasured: 0, disagreements: 0, cost: 0, latencies: [] });

function answeredMeasures(tally: AnsweredTally, measured: boolean): DecisionShadowAnswered {
  const disagreements = measured ? tally.disagreements : null;
  const measurable = tally.answered - tally.unmeasured;
  return {
    answered: tally.answered,
    unmeasured: tally.unmeasured,
    disagreements,
    disagreementShare: disagreements === null || measurable === 0 ? null : disagreements / measurable,
    costUsd: tally.cost,
    latencySamples: tally.latencies.length,
    latencyP50Ms: quantile(tally.latencies, 0.5),
    latencyP95Ms: quantile(tally.latencies, 0.95),
  };
}

/** Aggregate decisions.shadow ledger events (#223). Pure. Damaged rows
 * never blind the report: a row without a readable surface, provider or
 * provenance is counted in `skipped`; an answered row whose answers or
 * routes are not valid stays in its group as `unmeasured`. Disagreement
 * is recomputed from each row's answers and routes; the stored
 * `disagrees` flag is never read because rows recorded before 2026-10-11
 * carry an older band-only definition. Those rows also lack
 * `deterministic_routes` and `thresholds`; they are measured at
 * `legacyThresholds`. */
export function computeDecisionShadowMeasures(
  events: readonly LedgerEventRecord[],
  legacyThresholds: ThresholdsConfig = DEFAULT_DECISIONS_CONFIG.thresholds,
): DecisionShadowMeasures {
  interface Bucket {
    readonly surface: string;
    readonly provider: string;
    records: number;
    readonly all: AnsweredTally;
    readonly models: Map<string, AnsweredTally>;
    readonly misses: Map<string, { readonly kind: ShadowMissKind; readonly reason: string; count: number; readonly latencies: number[] }>;
    missCount: number;
    missCost: number;
    assumedThresholds: number;
  }
  const groups = new Map<string, Bucket>();
  let total = 0;
  let skipped = 0;
  for (const event of events) {
    if (event.kind !== 'decisions.shadow') continue;
    const payload = event.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      skipped += 1;
      continue;
    }
    const row = payload as Record<string, unknown>;
    const surface = row['surface'];
    const provider = row['provider'];
    const answered = row['provenance_source'] === 'jev';
    if (typeof surface !== 'string' || typeof provider !== 'string' || (!answered && row['provenance_source'] !== 'deterministic')) {
      skipped += 1;
      continue;
    }
    total += 1;
    const key = `${surface}\0${provider}`;
    const bucket: Bucket = groups.get(key) ?? {
      surface, provider, records: 0, all: newTally(), models: new Map(), misses: new Map(), missCount: 0, missCost: 0, assumedThresholds: 0,
    };
    groups.set(key, bucket);
    bucket.records += 1;
    if (!answered) {
      const cause = missCause(row);
      const missKey = `${cause.kind}\0${cause.reason}`;
      const miss = bucket.misses.get(missKey) ?? { ...cause, count: 0, latencies: [] };
      bucket.misses.set(missKey, miss);
      miss.count += 1;
      bucket.missCount += 1;
      if (finiteNumber(row['cost'])) bucket.missCost += row['cost'];
      if (cause.kind === 'attempted' && elapsedMs(row['latency_ms'])) miss.latencies.push(row['latency_ms']);
      continue;
    }
    const modelName = typeof row['model'] === 'string' ? row['model'] : 'unnamed';
    const model = bucket.models.get(modelName) ?? newTally();
    bucket.models.set(modelName, model);
    const tallies = [bucket.all, model];
    for (const tally of tallies) {
      tally.answered += 1;
      if (finiteNumber(row['cost'])) tally.cost += row['cost'];
      if (elapsedMs(row['latency_ms'])) tally.latencies.push(row['latency_ms']);
    }
    const risks = shadowSurfaceRisks(surface);
    if (risks === null) continue;
    const thresholds = thresholdsOfRow(row, legacyThresholds);
    if (!Object.hasOwn(row, 'thresholds')) bucket.assumedThresholds += 1;
    const disagrees = thresholds === null ? null : shadowEffectDisagreement({
      surface,
      baselineAnswers: row['deterministic_answers'],
      // A recorded value is used as recorded (even if damaged); only rows
      // predating the field have their baseline routes rebuilt.
      baselineRoutes: Object.hasOwn(row, 'deterministic_routes')
        ? row['deterministic_routes']
        : legacyBaselineRoutes(row, risks, thresholds),
      providerAnswers: row['answers'],
      providerRoutes: row['routes'],
      providerSource: row['provenance_source'],
      thresholds,
    });
    for (const tally of tallies) {
      if (disagrees === null) tally.unmeasured += 1;
      else if (disagrees) tally.disagreements += 1;
    }
  }
  return {
    records: total,
    skipped,
    bySurfaceProvider: [...groups.values()]
      .map((bucket): DecisionShadowRow => {
        const measured = hasShadowEffect(bucket.surface);
        return {
          surface: bucket.surface,
          provider: bucket.provider,
          records: bucket.records,
          ...answeredMeasures(bucket.all, measured),
          models: [...bucket.models.entries()]
            .map(([model, tally]) => ({ model, ...answeredMeasures(tally, measured) }))
            .sort((a, b) => b.answered - a.answered || a.model.localeCompare(b.model)),
          assumedThresholds: bucket.assumedThresholds,
          providerMisses: bucket.missCount,
          missCostUsd: bucket.missCost,
          misses: [...bucket.misses.values()]
            .map(({ kind, reason, count, latencies }) => ({
              kind, reason, count,
              latencySamples: latencies.length,
              latencyP50Ms: quantile(latencies, 0.5),
              latencyP95Ms: quantile(latencies, 0.95),
            }))
            .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind) || a.reason.localeCompare(b.reason)),
        };
      })
      .sort((a, b) => b.records - a.records || a.surface.localeCompare(b.surface) || a.provider.localeCompare(b.provider)),
  };
}

const inWindow = (ts: string, since: string, until: string): boolean => ts >= since && ts < until;

/** Total order over ledger events: timestamp, then sequence. Two events
 * sharing a timestamp are ordered by their append sequence, so an action
 * at the exact instant of the next wake lands in exactly one window. */
const eventKeyLessEq = (left: { readonly ts: string; readonly seq: number }, right: { readonly ts: string; readonly seq: number }): boolean =>
  left.ts < right.ts || (left.ts === right.ts && left.seq <= right.seq);

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

/** Yield over one wake kind: actions landing strictly after a wake and at
 * or before the next wake in (ts, seq) order — or strictly before `until`
 * for the last wake, keeping the window end exclusive. */
function computeWakeYield(
  events: readonly LedgerEventRecord[],
  wakeKind: string,
  actionKinds: ReadonlySet<string>,
  since: string,
  until: string,
  triggerOf: (event: LedgerEventRecord) => string,
): WakeYield {
  const wakes = events
    .filter((event) => event.kind === wakeKind && inWindow(event.ts, since, until))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  const actions = events
    .filter((event) => actionKinds.has(event.kind))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);

  const actionsByKind: Record<string, number> = {};
  let wakesWithAction = 0;
  const perTrigger = new Map<string, { wakes: number; wakesWithAction: number }>();

  for (const wake of wakes) {
    const next = wakes.find((candidate) => candidate !== wake && eventKeyLessEq(wake, candidate));
    const nextKey = next ?? null;
    const inWakeWindow = (action: LedgerEventRecord): boolean => {
      const afterWake = action.ts > wake.ts || (action.ts === wake.ts && action.seq > wake.seq);
      if (!afterWake) return false;
      if (nextKey === null) return action.ts < until;
      return action.ts < nextKey.ts || (action.ts === nextKey.ts && action.seq <= nextKey.seq);
    };
    const triggered = actions.some(inWakeWindow);
    if (triggered) wakesWithAction += 1;
    for (const action of actions) {
      if (inWakeWindow(action)) {
        actionsByKind[action.kind] = (actionsByKind[action.kind] ?? 0) + 1;
      }
    }
    const trigger = triggerOf(wake);
    const bucket = perTrigger.get(trigger) ?? { wakes: 0, wakesWithAction: 0 };
    bucket.wakes += 1;
    if (triggered) bucket.wakesWithAction += 1;
    perTrigger.set(trigger, bucket);
  }

  return {
    wakes: wakes.length,
    wakesWithAction,
    noActionShare: wakes.length === 0 ? 0 : (wakes.length - wakesWithAction) / wakes.length,
    actionsByKind,
    byTrigger: [...perTrigger.entries()]
      .map(([trigger, counts]) => ({ trigger, ...counts }))
      .sort((a, b) => b.wakes - a.wakes || a.trigger.localeCompare(b.trigger)),
  };
}

/** Digest stability over silas sweep turns (session side): share of sweeps
 * whose signature matches the previous sweep's in (ts, seq)-free
 * chronological order. Sweeps are drawn from the WHOLE parse so the first
 * in-window sweep can be compared with the last sweep before the window;
 * only in-window sweeps with a predecessor count toward the share. */
export function computeDigestStability(
  sweepSignatures: readonly (readonly [string, string])[],
  since: string,
  until: string,
): DigestStability {
  const ordered = [...sweepSignatures].sort((a, b) => a[0].localeCompare(b[0]));
  let comparable = 0;
  let stable = 0;
  for (let i = 1; i < ordered.length; i += 1) {
    const current = ordered[i];
    const previous = ordered[i - 1];
    if (current === undefined || previous === undefined) continue;
    if (!inWindow(current[0], since, until)) continue;
    comparable += 1;
    if (current[1] === previous[1]) stable += 1;
  }
  return {
    sweeps: ordered.filter((pair) => inWindow(pair[0], since, until)).length,
    stable,
    share: comparable === 0 ? null : stable / comparable,
  };
}

/** All ledger-side measures. Pure over the records the CLI read. */
export function computeLedgerMeasures(
  input: YieldMeasureInput,
  sweepSignatures: readonly (readonly [string, string | null])[],
): LedgerMeasures {
  const { since, until, events, notifications, jobs } = input;
  const silasActionKinds = new Set<string>(SILAS_YIELD_ACTION_KINDS);

  const silasYield = computeWakeYield(events, 'silas.wake', silasActionKinds, since, until, (event) => {
    const payload = event.payload;
    if (payload !== null && typeof payload === 'object') {
      const trigger = (payload as Record<string, unknown>)['trigger'];
      if (typeof trigger === 'string') return trigger;
    }
    return 'unknown';
  });
  const gruYield = computeWakeYield(events, 'gru.wake', new Set(['notification.resolved']), since, until, () => 'wake');

  // Digest stability comes from session turns; only parseable digests
  // count. Signatures span the window boundary: the first in-window sweep
  // compares against the last sweep before it.
  const stability = computeDigestStability(
    sweepSignatures.flatMap((pair) => (pair[1] === null ? [] : [[pair[0], pair[1]] as const])),
    since,
    until,
  );

  // Gru wake causes: join payload.notification_ids to notifications.kind.
  const kindOfId = new Map(notifications.map((n) => [n.id, n.kind]));
  const gruWakes = events
    .filter((event) => event.kind === 'gru.wake' && inWindow(event.ts, since, until))
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq);
  const perKind = new Map<string, number>();
  const idWakeCount = new Map<string, number>();
  let wakesWithNotificationIds = 0;
  let conflictOnlyWakes = 0;
  const wakeIds: string[][] = [];
  for (const wake of gruWakes) {
    const payload = wake.payload;
    // Deduplicate within a wake: a repeated ID in one payload is one
    // incident delivered once, not a repeat.
    const ids = [
      ...new Set(
        payload !== null && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>)['notification_ids'])
          ? ((payload as Record<string, unknown>)['notification_ids'] as unknown[]).filter((id): id is string => typeof id === 'string')
          : [],
      ),
    ];
    wakeIds.push(ids);
    if (ids.length > 0) wakesWithNotificationIds += 1;
    let sawConflict = false;
    let sawNonConflict = false;
    for (const id of ids) {
      const kind = kindOfId.get(id) ?? 'unknown';
      perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
      idWakeCount.set(id, (idWakeCount.get(id) ?? 0) + 1);
      if (kind.startsWith(PR_CONFLICT_NOTIFICATION_PREFIX)) sawConflict = true;
      else sawNonConflict = true;
    }
    if (sawConflict && !sawNonConflict) conflictOnlyWakes += 1;
  }
  const repeatIds = [...idWakeCount.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const repeatSet = new Set(repeatIds);
  const wakesWithRepeatIncident = wakeIds.filter((ids) => ids.some((id) => repeatSet.has(id))).length;

  // Issue #219 / #214: the avoidance stream — `gru.wake-deferred` events
  // with reason 'duplicate' (incident-key dedupe) or 'covered' (hold-
  // covered deferral) are wakes that never opened. Failed escalations
  // ('failed') are NOT avoidance — the demand stays unserved.
  let duplicates = 0;
  let covered = 0;
  for (const event of events) {
    if (event.kind !== 'gru.wake-deferred' || !inWindow(event.ts, since, until)) continue;
    const reason =
      event.payload !== null && typeof event.payload === 'object'
        ? (event.payload as Record<string, unknown>)['reason']
        : undefined;
    if (reason === 'duplicate') duplicates += 1;
    else if (reason === 'covered') covered += 1;
  }
  const windowMs = Math.max(1, Date.parse(until) - Date.parse(since));
  const wakesPerDay = (gruWakes.length / windowMs) * 86_400_000;
  const demanded = gruWakes.length + duplicates + covered;

  const gruWakeCauses: GruWakeCauses = {
    wakesWithNotificationIds,
    perKind: [...perKind.entries()]
      .map(([kind, wakes]) => ({ kind, wakes }))
      .sort((a, b) => b.wakes - a.wakes || a.kind.localeCompare(b.kind)),
    conflictOnlyWakes,
    repeatIncidentIds: repeatIds.length,
    wakesWithRepeatIncident,
    wakesPerDay,
    avoided: {
      duplicates,
      covered,
      share: demanded === 0 ? null : (duplicates + covered) / demanded,
    },
  };

  // M0 — heists finished in the window and WIP replayed to `until`.
  // TERMINAL (never WIP) derives from the ledger declaration, so a
  // discarded `binned` lane leaves the flow. FINISHED throughput stays
  // merged/done only: a discard is a disposition, not a success, and must
  // never inflate the finished count or deflate cost-per-finished.
  const terminal = new Set<string>(TERMINAL_JOB_STATUSES);
  const finished = new Set<string>(['merged', 'done']);
  const statusEvents = events
    .filter((event) => event.kind === 'job.status' && event.jobId !== null)
    .sort((a, b) => a.ts.localeCompare(b.ts) || a.seq - b.seq)
    .map((event) => ({ ts: event.ts, jobId: event.jobId as string, to: toStatus(event.payload) }));

  const finishedJobs = new Set<string>();
  const finishTs = new Map<string, string>();
  for (const event of statusEvents) {
    if (!finished.has(event.to) || !inWindow(event.ts, since, until)) continue;
    finishedJobs.add(event.jobId);
    if (!finishTs.has(event.jobId)) finishTs.set(event.jobId, event.ts);
  }
  const leadTimes: number[] = [];
  const createdAt = new Map(jobs.map((job) => [job.id, job.createdAt]));
  for (const jobId of finishedJobs) {
    const created = createdAt.get(jobId);
    const finished = finishTs.get(jobId);
    if (created === undefined || finished === undefined) continue;
    const hours = (Date.parse(finished) - Date.parse(created)) / 3_600_000;
    if (Number.isFinite(hours)) leadTimes.push(hours);
  }
  const leadMedian = median(leadTimes);
  const leadMax = leadTimes.length === 0 ? null : Math.max(...leadTimes);

  const statusAtUntil = new Map<string, string>();
  for (const job of jobs) {
    if (job.createdAt <= until) statusAtUntil.set(job.id, 'dispatched');
  }
  for (const event of statusEvents) {
    if (event.ts > until) continue;
    if (statusAtUntil.has(event.jobId)) statusAtUntil.set(event.jobId, event.to);
  }
  const wipByStatus = new Map<string, number[]>();
  let wipTotal = 0;
  for (const [jobId, status] of statusAtUntil) {
    if (terminal.has(status)) continue;
    wipTotal += 1;
    const created = createdAt.get(jobId);
    const ageHours = created === undefined ? 0 : (Date.parse(until) - Date.parse(created)) / 3_600_000;
    const ages = wipByStatus.get(status) ?? [];
    ages.push(Number.isFinite(ageHours) ? ageHours : 0);
    wipByStatus.set(status, ages);
  }

  const m0: M0Measures = {
    finishedJobs: finishedJobs.size,
    leadTimeHours:
      leadMedian === null || leadMax === null ? null : { median: leadMedian, max: leadMax },
    wipByStatus: [...wipByStatus.entries()]
      .map(([status, ages]) => ({
        status,
        jobs: ages.length,
        medianAgeHours: median(ages) ?? 0,
      }))
      .sort((a, b) => b.jobs - a.jobs || a.status.localeCompare(b.status)),
    wipTotal,
    costPerFinishedUsd: null, // filled by buildYieldReport from session totals
  };

  return {
    silasYield,
    gruYield,
    digestStability: stability,
    gruWakeCauses,
    m0,
    decisionsShadow: computeDecisionShadowMeasures(events),
    autopilot: computeAutopilotMeasures(events, since, until),
  };
}

/** The receipt kinds that prove each autopilot family's action actually
 * happened when LLM Silas performs it (issue #243). */
const AUTOPILOT_FAMILY_RECEIPTS: Readonly<Record<string, readonly string[]>> = {
  'verdict-rung-directive': ['silas.directive-sent'],
  'verdict-rung-rebrief': ['silas.rebrief'],
  'verification-repair': ['silas.directive-sent'],
  'pr-conflict-rebase': ['silas.directive-sent'],
  'clean-abort-service-restart': ['silas.review-triggered'],
  'sweep-ack': ['silas.lane-released'],
  // Issue #243 R2-H8: the bare, untagged `job.pr-linked` the service emits
  // for ANY caller (including the autopilot's own `recordPr`) is NOT model
  // evidence. Only the attributable `silas.pr-registered` receipt counts.
  'delivered-pr-register': ['silas.pr-registered'],
  'pr-review-trigger': ['silas.review-triggered'],
};

/** Receipt kinds shared by more than one family. A receipt of a shared kind
 * can only be credited to a decision when it NAMES that decision's rule id
 * (issue #243 H6): a bare `silas.directive-sent` is as likely to be another
 * family's action, and must never count as agreement. */
const SHARED_RECEIPT_KINDS: ReadonlySet<string> = new Set(
  Object.values(AUTOPILOT_FAMILY_RECEIPTS).flat().filter((kind, index, all) => all.indexOf(kind) !== index),
);

function eventPayload(event: LedgerEventRecord): Record<string, unknown> {
  return event.payload !== null && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {};
}

/** The per-row debt identity a decision predicted, from its `would_call`
 * (issue #243 R2-H7): the round, verification run, conflicting head or PR
 * url the decision named. A family with no per-row key (sweep-ack,
 * pr-review-trigger) returns `{}` and is matched on job + kind + rule only. */
function decisionDebtIdentity(payload: Record<string, unknown>): Record<string, string> {
  const wouldCall = payload['would_call'];
  const call = wouldCall !== null && typeof wouldCall === 'object'
    ? (wouldCall as Record<string, unknown>)
    : {};
  const identity: Record<string, string> = {};
  for (const key of ['blocker_fingerprint', 'source_round_id', 'url'] as const) {
    const value = call[key];
    if (typeof value === 'string' && value !== '') identity[key] = value;
  }
  return identity;
}

/** A receipt counts for a decision's debt only when it names the SAME
 * identity (issue #243 R2-H7) — the exact blocked fingerprint, source round
 * or PR url. A receipt that names a different run/round/head never credits
 * the prediction, and one that omits the identity never credits a
 * prediction that named it. */
function receiptMatchesDebt(identity: Record<string, string>, receipt: Record<string, unknown>): boolean {
  const keys = Object.keys(identity);
  if (keys.length === 0) return true;
  return keys.every((key) => receipt[key] === identity[key]);
}

/**
 * Autopilot decisions and their agreement with what LLM Silas actually did
 * (issue #243, the rollout's `dry-run` read).
 *
 * An `enforce` decision is reported as `enforced` and excluded from the
 * agreement sample — the machine took the action (or attempted it); there is
 * nothing for the model to agree with. A `dry-run` decision AGREES when a
 * receipt of the family's own action kinds lands for the same job AFTER the
 * decision, names the SAME predicted debt identity (round/run/head/url,
 * R2-H7), carries a `rule_id` that names the decision's family (a receipt
 * of a kind shared across families carries no weight without it, H6), and is
 * NOT the autopilot's own machine receipt (`source: 'silas-autopilot'`) —
 * the model read the same row and did the same thing. It is UNOBSERVABLE
 * when no `silas.wake` landed after it in the window, so the model was
 * never handed the row again; everything else is a disagreement. The
 * agreement share is computed over the OBSERVABLE decisions only (L1), and
 * is null when none is observable.
 */
export function computeAutopilotMeasures(
  events: readonly LedgerEventRecord[],
  since: string,
  until: string,
): AutopilotMeasures {
  const decisions = events.filter(
    (event) => event.kind === AUTOPILOT_DECISION_EVENT && inWindow(event.ts, since, until),
  );
  const newestWakeSeq = events
    .filter((event) => event.kind === 'silas.wake' && inWindow(event.ts, since, until))
    .reduce((best, event) => Math.max(best, event.seq), 0);
  const familyActions = events.filter(
    (event) =>
      SILAS_YIELD_ACTION_KINDS.includes(event.kind as (typeof SILAS_YIELD_ACTION_KINDS)[number]) &&
      inWindow(event.ts, since, until),
  );
  const byRule = new Map<string, { modes: Set<string>; decisions: number; enforced: number; agreed: number; unobservable: number }>();
  for (const decision of decisions) {
    const payload =
      decision.payload !== null && typeof decision.payload === 'object'
        ? (decision.payload as Record<string, unknown>)
        : {};
    const ruleId = typeof payload['rule_id'] === 'string' ? payload['rule_id'] : 'unknown';
    const mode = typeof payload['mode'] === 'string' ? payload['mode'] : 'unknown';
    const entry = byRule.get(ruleId) ?? { modes: new Set<string>(), decisions: 0, enforced: 0, agreed: 0, unobservable: 0 };
    entry.modes.add(mode);
    if (mode === 'enforce') {
      entry.enforced += 1;
      byRule.set(ruleId, entry);
      continue;
    }
    entry.decisions += 1;
    const kinds = AUTOPILOT_FAMILY_RECEIPTS[ruleId] ?? [];
    const debt = decisionDebtIdentity(payload);
    const agreed = familyActions.some((event) => {
      if (event.seq <= decision.seq) return false;
      if (event.jobId === null || event.jobId !== decision.jobId) return false;
      if (!kinds.includes(event.kind)) return false;
      const eventBody = eventPayload(event);
      // The autopilot's own action is not the model's agreement (H6).
      if (eventBody['source'] === AUTOPILOT_SOURCE) return false;
      const receiptRuleId = typeof eventBody['rule_id'] === 'string' ? eventBody['rule_id'] : undefined;
      if (receiptRuleId !== undefined) {
        if (receiptRuleId !== ruleId) return false;
      } else if (SHARED_RECEIPT_KINDS.has(event.kind)) {
        // A receipt that names no rule is only attributable to a family whose
        // action kind is unique (H6).
        return false;
      }
      // Issue #243 R2-H7: the debt identity must match too.
      return receiptMatchesDebt(debt, eventBody);
    });
    if (agreed) entry.agreed += 1;
    else if (decision.seq > newestWakeSeq) entry.unobservable += 1;
    byRule.set(ruleId, entry);
  }
  return {
    decisions: decisions.length,
    byFamily: [...byRule.entries()]
      .map(([ruleId, entry]) => {
        // Unobservable decisions are not a model disagreement — the model
        // was never handed the row again. Compute the share over what the
        // model actually observed (L1).
        const observable = entry.decisions - entry.unobservable;
        return {
          ruleId,
          mode: entry.modes.size === 1 ? [...entry.modes][0] ?? 'unknown' : 'mixed',
          decisions: entry.decisions,
          enforced: entry.enforced,
          agreed: entry.agreed,
          unobservable: entry.unobservable,
          agreementShare: observable === 0 ? null : entry.agreed / observable,
        };
      })
      .sort((a, b) => b.decisions - a.decisions || a.ruleId.localeCompare(b.ruleId)),
  };
}

function toStatus(payload: unknown): string {
  if (payload !== null && typeof payload === 'object') {
    const to = (payload as Record<string, unknown>)['to'];
    if (typeof to === 'string') return to;
  }
  return 'unknown';
}

// ------------------------------------------------------------------
// Report assembly
// ------------------------------------------------------------------

export interface YieldReport {
  readonly since: string;
  readonly until: string;
  readonly generatedAt: string;
  readonly parseSkips: ParseSkips;
  readonly usage: UsageSummary;
  readonly silasYield: WakeYield;
  readonly gruYield: WakeYield;
  readonly digestStability: DigestStability;
  readonly gruWakeCauses: GruWakeCauses;
  readonly m0: M0Measures;
  readonly decisionsShadow: DecisionShadowMeasures;
  /** Issue #243: autopilot decisions and their agreement per family. */
  readonly autopilot: AutopilotMeasures;
}

export interface BuildReportInput {
  readonly since: string;
  readonly until: string;
  readonly generatedAt: string;
  readonly parseSkips: ParseSkips;
  /** Windowed session turns (startedAt within [since, until)). */
  readonly turns: readonly ParsedTurn[];
  /** [turnStartedAt, digestSignature] per silas sweep turn in the window. */
  readonly sweepSignatures: readonly (readonly [string, string | null])[];
  readonly ledger: YieldMeasureInput;
}

/** Compose the full report. Pure. */
export function buildYieldReport(input: BuildReportInput): YieldReport {
  const usage = aggregateUsage(input.turns);
  const measures = computeLedgerMeasures(input.ledger, input.sweepSignatures);
  const costPerFinishedUsd = measures.m0.finishedJobs > 0 ? usage.total.costUsd / measures.m0.finishedJobs : null;
  return {
    since: input.since,
    until: input.until,
    generatedAt: input.generatedAt,
    parseSkips: input.parseSkips,
    usage,
    silasYield: measures.silasYield,
    gruYield: measures.gruYield,
    digestStability: measures.digestStability,
    gruWakeCauses: measures.gruWakeCauses,
    m0: { ...measures.m0, costPerFinishedUsd },
    decisionsShadow: measures.decisionsShadow,
    autopilot: measures.autopilot,
  };
}

/** Keep only turns whose opening user message is inside [since, until). */
export function windowTurns<T extends { startedAt: string }>(turns: readonly T[], since: string, until: string): T[] {
  return turns.filter((turn) => inWindow(turn.startedAt, since, until));
}

/** Digest stability source: silas sweep turns with a parseable digest,
 * as [startedAt, signature] pairs. Pass the WHOLE parse (not windowed)
 * so the first in-window sweep compares against the last sweep before
 * the window. */
export function sweepSignaturesOf(turns: readonly ParsedTurn[]): (readonly [string, string])[] {
  return turns.flatMap((turn) =>
    turn.role === 'silas' && turn.label === 'sweep' && turn.digestSignature !== null
      ? [[turn.startedAt, turn.digestSignature] as const]
      : [],
  );
}

// ------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------

const fmtUsd = (value: number): string => `$${value.toFixed(2)}`;
const fmtPct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const fmtNum = (value: number): string => value.toLocaleString('en-US');
const fmtHours = (value: number): string => `${value.toFixed(1)}h`;

/** Ledger-derived text (surface, provider, reason, model) made safe for
 * one report line: control characters replaced and length bounded. A
 * shortened label keeps a hash of the original so two long names never
 * render identically. */
function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '?');
  if (safe.length <= 80) return safe;
  return `${safe.slice(0, 64)}…#${createHash('sha256').update(text).digest('hex').slice(0, 8)}`;
}

/** Shadow asks cost fractions of a cent: four decimals keep them visible. */
const fmtShadowUsd = (value: number): string => `$${value.toFixed(4)}`;

function renderShadowAnswered(measures: DecisionShadowAnswered): string {
  const actsDifferently = measures.disagreements === null
    ? 'would act differently n/a (no consumer effect defined)'
    : measures.unmeasured > 0
      ? `would act differently ${fmtNum(measures.disagreements)} of ${fmtNum(measures.answered - measures.unmeasured)} measurable (${fmtPct(measures.disagreementShare)}; ${fmtNum(measures.unmeasured)} unmeasurable)`
      : `would act differently ${fmtNum(measures.disagreements)} of ${fmtNum(measures.answered)} answered (${fmtPct(measures.disagreementShare)})`;
  const latency = measures.latencyP50Ms === null || measures.latencyP95Ms === null
    ? `answered latency n/a (n=${fmtNum(measures.latencySamples)})`
    : `answered latency p50 ${fmtNum(measures.latencyP50Ms)}ms / p95 ${fmtNum(measures.latencyP95Ms)}ms (n=${fmtNum(measures.latencySamples)})`;
  return `${actsDifferently}, cost ${fmtShadowUsd(measures.costUsd)}, ${latency}`;
}

const MISS_KIND_LABELS: Readonly<Record<ShadowMissKind, string>> = {
  attempted: 'attempted',
  refused: 'refused',
  stand_in: 'stand-in',
  unrecorded: 'unrecorded',
};

function renderShadowMisses(row: DecisionShadowRow): string {
  const parts = (Object.keys(MISS_KIND_LABELS) as ShadowMissKind[]).flatMap((kind) => {
    const misses = row.misses.filter((miss) => miss.kind === kind);
    if (misses.length === 0) return [];
    const count = misses.reduce((sum, miss) => sum + miss.count, 0);
    // An unrecorded miss without a reason carries the placeholder reason.
    const named = misses.filter((miss) => !(kind === 'unrecorded' && miss.reason === 'unrecorded'));
    if (named.length === 0) return [`${MISS_KIND_LABELS[kind]} ${fmtNum(count)}`];
    const reasons = misses.map((miss) => {
      const elapsed = miss.latencyP50Ms === null || miss.latencyP95Ms === null
        ? ''
        : ` (p50 ${fmtNum(miss.latencyP50Ms)}ms / p95 ${fmtNum(miss.latencyP95Ms)}ms, n=${fmtNum(miss.latencySamples)})`;
      const reason = kind === 'unrecorded' && miss.reason === 'unrecorded' ? 'no reason' : printable(miss.reason);
      return `${reason} ${fmtNum(miss.count)}${elapsed}`;
    });
    return [`${MISS_KIND_LABELS[kind]} ${fmtNum(count)}: ${reasons.join(', ')}`];
  });
  return `provider misses ${fmtNum(row.providerMisses)}${parts.length > 0 ? ` (${parts.join('; ')})` : ''}`;
}

function renderShadowRow(row: DecisionShadowRow): string {
  const missCost = row.missCostUsd > 0 ? `, miss cost ${fmtShadowUsd(row.missCostUsd)}` : '';
  const assumed = row.assumedThresholds > 0 ? `, ${fmtNum(row.assumedThresholds)} at assumed default thresholds` : '';
  return `records ${fmtNum(row.records)}, answered ${fmtNum(row.answered)}, ${renderShadowMisses(row)}, ${renderShadowAnswered(row)}${missCost}${assumed}`;
}


/** Human-readable text table. Counts and bounded identifiers only — no
 * prompt text, transcripts, tokens (secrets) or session paths. */
export function renderTextReport(report: YieldReport): string {
  const lines: string[] = [];
  const push = (line = ''): void => {
    lines.push(line);
  };

  push(`Yield report ${report.since} → ${report.until} (generated ${report.generatedAt})`);
  push('');

  push('Usage by trigger');
  push('  role       label                  class      turns      calls         in        out     cache        cost    compactions');
  for (const label of report.usage.byLabel) {
    push(
      `  ${label.role.padEnd(10)} ${label.label.padEnd(21)} ${label.turnClass.padEnd(9)} ${fmtNum(label.turns).padStart(6)} ${fmtNum(label.llmCalls).padStart(10)} ${fmtNum(label.tokens.input).padStart(10)} ${fmtNum(label.tokens.output).padStart(10)} ${fmtNum(label.tokens.cacheRead + label.tokens.cacheWrite).padStart(10)} ${fmtUsd(label.costUsd).padStart(9)} ${fmtNum(label.compactions).padStart(13)}`,
    );
  }
  push('');
  push('Usage by class');
  for (const turnClass of TURN_CLASSES) {
    const bucket = report.usage.byClass[turnClass];
    push(
      `  ${turnClass.padEnd(9)} turns ${fmtNum(bucket.turns).padStart(6)}  calls ${fmtNum(bucket.llmCalls).padStart(7)}  tokens ${fmtNum(bucket.tokens.input + bucket.tokens.output + bucket.tokens.cacheRead + bucket.tokens.cacheWrite).padStart(11)}  cost ${fmtUsd(bucket.costUsd).padStart(9)}  (${((bucket.costUsd / (report.usage.total.costUsd || 1)) * 100).toFixed(1)}%)`,
    );
  }
  push(
    `  ${'total'.padEnd(9)} turns ${fmtNum(report.usage.total.turns).padStart(6)}  calls ${fmtNum(report.usage.total.llmCalls).padStart(7)}  tokens ${fmtNum(report.usage.total.tokens.input + report.usage.total.tokens.output + report.usage.total.tokens.cacheRead + report.usage.total.tokens.cacheWrite).padStart(11)}  cost ${fmtUsd(report.usage.total.costUsd).padStart(9)}`,
  );
  push('');
  push('Usage by model');
  for (const model of report.usage.byModel) {
    push(`  ${model.provider}/${model.model}: ${fmtNum(model.llmCalls)} calls`);
  }
  push('');

  push('Silas yield');
  push(`  wakes ${fmtNum(report.silasYield.wakes)}, with follow-through ${fmtNum(report.silasYield.wakesWithAction)}, no-action share ${fmtPct(report.silasYield.noActionShare)}`);
  for (const trigger of report.silasYield.byTrigger) {
    push(`  trigger ${trigger.trigger}: wakes ${fmtNum(trigger.wakes)}, no-action ${fmtPct(trigger.wakes === 0 ? null : (trigger.wakes - trigger.wakesWithAction) / trigger.wakes)}`);
  }
  push('');
  push('Gru yield');
  push(`  wakes ${fmtNum(report.gruYield.wakes)}, with action ${fmtNum(report.gruYield.wakesWithAction)}, no-action share ${fmtPct(report.gruYield.noActionShare)}`);
  push('');
  push('Silas digest stability');
  push(`  sweeps ${fmtNum(report.digestStability.sweeps)}, stable ${fmtNum(report.digestStability.stable)}, share ${fmtPct(report.digestStability.share)}`);
  push('');
  push('Gru wake causes');
  push(`  wakes with notification ids ${fmtNum(report.gruWakeCauses.wakesWithNotificationIds)}, conflict-only ${fmtNum(report.gruWakeCauses.conflictOnlyWakes)}`);
  push(`  repeat-incident ids ${fmtNum(report.gruWakeCauses.repeatIncidentIds)} across ${fmtNum(report.gruWakeCauses.wakesWithRepeatIncident)} wakes`);
  push(`  wakes/day ${report.gruWakeCauses.wakesPerDay.toFixed(2)}, avoided ${fmtNum(report.gruWakeCauses.avoided.duplicates)} duplicate(s) + ${fmtNum(report.gruWakeCauses.avoided.covered)} covered (${fmtPct(report.gruWakeCauses.avoided.share)})`);
  for (const kind of report.gruWakeCauses.perKind.slice(0, 10)) {
    push(`  kind ${kind.kind}: ${fmtNum(kind.wakes)} wakes`);
  }
  push('');
  push('Decisions (shadow, #223)');
  if (report.decisionsShadow.bySurfaceProvider.length === 0) {
    push(`  no shadow records in window (records ${fmtNum(report.decisionsShadow.records)})`);
  }
  for (const row of report.decisionsShadow.bySurfaceProvider) {
    push(`  ${printable(row.surface)} / ${printable(row.provider)}: ${renderShadowRow(row)}`);
    for (const model of row.models) {
      push(`    model ${printable(model.model)}: answered ${fmtNum(model.answered)}, ${renderShadowAnswered(model)}`);
    }
  }
  if (report.decisionsShadow.skipped > 0) {
    push(`  ${fmtNum(report.decisionsShadow.skipped)} unreadable shadow row(s) skipped`);
  }
  push('');
  push('Silas autopilot (#243)');
  if (report.autopilot.decisions === 0) {
    push('  no autopilot decisions in window');
  } else {
    push(`  decisions ${fmtNum(report.autopilot.decisions)}`);
    for (const family of report.autopilot.byFamily) {
      push(
        `  ${printable(family.ruleId)} [${printable(family.mode)}]: decisions ${fmtNum(family.decisions)}, ` +
          `agreed ${fmtNum(family.agreed)} (${fmtPct(family.agreementShare)}), unobservable ${fmtNum(family.unobservable)}, ` +
          `enforced ${fmtNum(family.enforced)}`,
      );
    }
  }
  push('');
  push('M0 — heists');
  push(`  finished in window ${fmtNum(report.m0.finishedJobs)}`);
  push(
    `  lead time ${report.m0.leadTimeHours === null ? 'n/a' : `median ${fmtHours(report.m0.leadTimeHours.median)}, max ${fmtHours(report.m0.leadTimeHours.max)}`}`,
  );
  push(`  non-terminal WIP ${fmtNum(report.m0.wipTotal)} at window end`);
  for (const wip of report.m0.wipByStatus) {
    push(`  ${wip.status}: ${fmtNum(wip.jobs)} (median age ${fmtHours(wip.medianAgeHours)})`);
  }
  if (report.m0.costPerFinishedUsd !== null) {
    push(`  cost per finished heist ${fmtUsd(report.m0.costPerFinishedUsd)}`);
  }
  push('');
  if (report.parseSkips.unparsableLines > 0 || report.parseSkips.unattributedCompactions > 0) {
    push(`skipped: ${fmtNum(report.parseSkips.unparsableLines)} unparsable lines, ${fmtNum(report.parseSkips.unattributedCompactions)} pre-turn compactions`);
  }
  return lines.join('\n');
}
