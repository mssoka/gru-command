/**
 * Typed owner-decision metadata (owner release 2026-10-11).
 *
 * A FOR YOU card is a decision, not an acknowledgement queue: it must
 * present a short title, the precise question, Gru's recommendation (when
 * one exists), concrete options with their consequences, and the full
 * diagnostics behind a disclosure. The metadata is supplied by the
 * producer as a typed object, validated at the server write boundary and
 * rendered as data — NEVER extracted from, or executed from, notification
 * prose. The browser submits the displayed typed decision alongside its
 * option id; the server rejects the choice if the stored decision changed.
 *
 * `reservedClass` records which reserved owner boundary the question
 * falls under, and `whyNotDelegable` records why Silas/Gru cannot safely
 * decide it — both required, so an escalation cannot quietly turn an
 * operational item into an owner chore.
 */

export const OWNER_RESERVED_CLASSES = [
  'scope-design',
  'authority-cost',
  'destructive',
  'merge',
  'lessons',
] as const;
export type OwnerReservedClass = (typeof OWNER_RESERVED_CLASSES)[number];

export const OWNER_RESERVED_CLASS_LABELS: Readonly<Record<OwnerReservedClass, string>> = {
  'scope-design': 'scope or design tradeoff',
  'authority-cost': 'authority or cost beyond delegation',
  destructive: 'destructive or irreversible choice',
  merge: 'merge decision',
  lessons: 'lesson proposal',
};

export interface NotificationDecisionOption {
  readonly id: string;
  readonly label: string;
  readonly consequence: string;
}

export interface NotificationDecision {
  /** The precise question the owner is answering (one line). */
  readonly question: string;
  /** One or two sentences of context, in the producer's own words. */
  readonly context: string;
  /** Gru's recommendation, when one exists. */
  readonly recommendation: string | null;
  /** Which reserved owner boundary this decision falls under. */
  readonly reservedClass: OwnerReservedClass;
  /** Why this cannot safely be decided by Silas/Gru. */
  readonly whyNotDelegable: string;
  /** Concrete options (1..4) — every option merely RECORDS the choice. */
  readonly options: readonly NotificationDecisionOption[];
  /** When true, the decision needs discussion with Gru first; options may
   * be empty and the card offers the existing chat route instead of
   * inventing an executable control. */
  readonly discussion: boolean;
}

/** Owner proposals whose PRODUCER may withdraw them undecided, because the
 * thing proposed changed before the owner answered (#351: a raid target's
 * code moved; #427: the repository left managed_repos, or onboarding was
 * turned off). Every other undecided owner row stays open until answered. */
const PRODUCER_WITHDRAWABLE_KINDS: readonly string[] = ['vector.raid-proposal', 'onboarding.proposal'];

export function producerWithdrawable(kind: string): boolean {
  return PRODUCER_WITHDRAWABLE_KINDS.includes(kind);
}

const OPTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Reject C0 controls (except tab/LF) and DEL without a raw control range
 * literal in the source. */
function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x7f) return true;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a) return true;
  }
  return false;
}

function boundedString(
  value: unknown,
  what: string,
  max: number,
  opts: { readonly allowNewlines?: boolean } = {},
): string {
  if (typeof value !== 'string') throw new Error(`${what} must be a string`);
  if (hasControlChars(value)) throw new Error(`${what} must not contain control characters`);
  if (opts.allowNewlines !== true && value.includes('\n')) throw new Error(`${what} must be a single line`);
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`${what} must not be blank`);
  if (trimmed.length > max) throw new Error(`${what} must be at most ${max} characters`);
  return trimmed;
}

function boundedOptionalString(value: unknown, what: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${what} must be a string or null`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return boundedString(trimmed, what, max, { allowNewlines: true });
}

/** Strict parse at the write boundary: a malformed decision is a loud
 * producer bug, never a silently dropped owner question. */
/** Validate one concrete option list (1..4 entries). Shared by the
 * escalation write boundary and the supported discussion follow-up that
 * attaches agreed options to an existing discussion-only decision. */
export function parseDecisionOptions(value: unknown): readonly NotificationDecisionOption[] {
  if (!Array.isArray(value)) throw new Error('decision.options must be a list');
  if (value.length > 4) throw new Error('decision.options supports at most 4 options');
  const options: NotificationDecisionOption[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('decision.options entries must be objects');
    }
    const option = entry as Record<string, unknown>;
    const id = boundedString(option['id'], 'decision option id', 64);
    if (!OPTION_ID.test(id)) {
      throw new Error(`decision option id "${id}" must be a lowercase slug (a-z, 0-9, hyphen)`);
    }
    if (seen.has(id)) throw new Error(`decision option id "${id}" is duplicated`);
    seen.add(id);
    options.push({
      id,
      label: boundedString(option['label'], `decision option "${id}" label`, 120),
      consequence: boundedString(option['consequence'], `decision option "${id}" consequence`, 400, {
        allowNewlines: true,
      }),
    });
  }
  return options;
}

export function parseNotificationDecision(value: unknown): NotificationDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('decision must be an object');
  }
  const raw = value as Record<string, unknown>;
  const question = boundedString(raw['question'], 'decision.question', 300);
  const context = boundedString(raw['context'], 'decision.context', 600, { allowNewlines: true });
  const recommendation = boundedOptionalString(raw['recommendation'], 'decision.recommendation', 300);
  const reservedClass = raw['reservedClass'];
  if (typeof reservedClass !== 'string' || !(OWNER_RESERVED_CLASSES as readonly string[]).includes(reservedClass)) {
    throw new Error(
      `decision.reservedClass must be one of ${OWNER_RESERVED_CLASSES.join(', ')}`,
    );
  }
  const whyNotDelegable = boundedString(raw['whyNotDelegable'], 'decision.whyNotDelegable', 400, {
    allowNewlines: true,
  });
  const discussionRaw = raw['discussion'];
  if (discussionRaw !== undefined && typeof discussionRaw !== 'boolean') {
    throw new Error('decision.discussion must be a boolean when present');
  }
  const discussion = discussionRaw === true;
  const optionsRaw = raw['options'];
  if (!Array.isArray(optionsRaw)) throw new Error('decision.options must be a list');
  if (optionsRaw.length === 0 && !discussion) {
    throw new Error('decision.options requires at least one option unless decision.discussion is true');
  }
  const options = parseDecisionOptions(optionsRaw);
  return {
    question,
    context,
    recommendation,
    reservedClass: reservedClass as OwnerReservedClass,
    whyNotDelegable,
    options,
    discussion,
  };
}

/** Read-side parse: rows written by an older build or a corrupted column
 * render honestly as "no typed decision" (the caller keeps the detail and
 * shows no invented control), never crash a surface. */
export function parseStoredNotificationDecision(json: string | null): NotificationDecision | null {
  if (json === null || json.trim() === '') return null;
  try {
    return parseNotificationDecision(JSON.parse(json));
  } catch {
    return null;
  }
}

export function serializeNotificationDecision(decision: NotificationDecision): string {
  return JSON.stringify(decision);
}
