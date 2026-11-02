/**
 * The plain-language standard for the FOR YOU surface (issue #570).
 *
 * A FOR YOU card is read by a non-technical owner: it says what happened,
 * why it needs a person, what to do, and what happens if nothing is done.
 * Identifiers, paths, hashes and infrastructure vocabulary belong in
 * `detail` — the ONE slot the card designates for evidence, shown behind
 * "Details" and never on the face.
 *
 * This module is the single authority for both halves of that standard:
 *
 *   - `assertOwnerCardLanguage` — the write boundary. Every producer that
 *     writes owner-facing text (the NotificationCenter write paths and the
 *     ledger's owner-detail update) runs it, so a card with internal
 *     vocabulary, a missing "if you do nothing" line, a missing
 *     recommendation or no specific notice guidance is refused loudly at
 *     the producer, never shown to the owner.
 *   - `ownerNoticeGuidance` — the structured per-kind guidance a notice
 *     card renders (why it is here, what happens if you do nothing, what
 *     to do). Moving it here (from `web/src/lib/owner-band.ts`, which keeps
 *     a re-export) is what lets the server refuse a notice kind that has no
 *     guidance, instead of silently rendering a generic sentence.
 *
 * `detail` is deliberately never inspected: it is the evidence slot.
 *
 * See docs/FOR-YOU.md for the written standard.
 */

import { ownerAttentionFor } from './attention.js';
import type { NotificationDecision } from '../ledger/notification-decision.js';

/** Words a minion uses about its own machinery. Bare matches only, so
 * "plane", "gateway" and repo names that merely contain one are untouched. */
export const OWNER_BANNED_TERMS = [
  'lane',
  'heist',
  'breaker',
  're-arm',
  'quorum',
  'dispatch',
  'gate',
] as const;

/**
 * The default "if you do nothing" line, for a typed decision whose honest
 * answer really is "nothing changes". Required at the boundary with NO
 * automatic default: a producer uses this constant deliberately when it is
 * the truth, and writes its own line when the owner's inaction has a
 * different, specific consequence (GC asks again later, the proposal
 * expires, the sweep stays paused).
 */
export const OWNER_NOTHING_DEFAULT =
  'If you do nothing, nothing changes and this request stays open until it is answered or withdrawn.';

/**
 * A decision the producer genuinely has no preference on still has to say
 * so in the owner's words. The card renders this form without the
 * "Gru recommends:" prefix, so "no preference" is never dressed up as a
 * recommendation.
 */
export const OWNER_NO_RECOMMENDATION_PREFIX = 'No recommendation';

/** Machine shapes refused on the face. Each names what the owner would be
 * shown instead of an outcome. All of them but the bare absolute path match
 * the text as written: a repository slug (`repo/pkg`) has the same shape as a
 * path, so only the leading-slash rule scans the allowlist-masked text. */
const MACHINE_TOKENS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'a home-relative path', pattern: /(?:^|[\s("'])~\//u },
  { name: 'a Windows path', pattern: /\b[A-Za-z]:\\/u },
  { name: 'a folder path', pattern: /\.[a-z][a-z0-9-]*\/[A-Za-z0-9._-]+\.[a-z]+\b/u },
  { name: 'a commit id', pattern: /\b[0-9a-f]{40}\b/u },
  { name: 'a content hash', pattern: /\b[0-9a-f]{64}\b/u },
  { name: 'an internal job id', pattern: /\bjob-[0-9a-z]/iu },
  { name: 'a process id', pattern: /\bpid\b/iu },
  { name: 'a git ref', pattern: /\brefs\//u },
  { name: 'a hash name', pattern: /\bsha-?256\b/iu },
  { name: 'a raw error', pattern: /\bError:/u },
  { name: 'a config section', pattern: /\[[a-z][a-z0-9_-]*\]/u },
  { name: 'a config key', pattern: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\s*=\s*/u },
  { name: 'an internal constant', pattern: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u },
];

/** The one rule a repository slug can trip — it needs a token-leading
 * slash, which a slug never has — so a slug like `billing/src/refunds` is
 * allowed on the face while `/srv/gru/state` is not. */
const ABSOLUTE_PATH = /(?:^|[\s("'])\/\S/u;

function refusal(field: string, what: string, token: string, instead: string): Error {
  return new Error(`${field}: ${what} "${token.trim()}" ${instead} (see docs/FOR-YOU.md)`);
}

/** Refuse owner-facing text that uses internal vocabulary or machine
 * tokens. The message names the field, the offending token, and what to do
 * instead, so a producer fixes the copy rather than the validator. */
export function assertOwnerFacingText(field: string, text: string): void {
  for (const term of OWNER_BANNED_TERMS) {
    // `-` is literal outside a character class, so the term needs no escape.
    const match = new RegExp(`\\b${term}\\b`, 'iu').exec(text);
    if (match !== null) {
      throw refusal(field, 'internal vocabulary', match[0], 'is internal vocabulary; say what the owner gets instead');
    }
  }
  for (const token of MACHINE_TOKENS) {
    const match = token.pattern.exec(text);
    if (match !== null) {
      throw refusal(field, `${token.name}`, match[0], 'is not owner language; say it in plain words and put the identifier in detail');
    }
  }
  const path = ABSOLUTE_PATH.exec(text);
  if (path !== null) {
    throw refusal(field, 'an absolute path', path[0], 'is not owner language; say it in plain words and put the path in detail');
  }
}

/** The recommendation rule: either a recommendation, or the explicit
 * no-preference form. A missing one leaves the owner guessing which choice
 * Gru would make. */
function assertRecommendation(recommendation: string | null): void {
  if (recommendation === null) {
    throw new Error(
      'decision.recommendation: every owner decision states a recommendation, or the explicit ' +
        `"${OWNER_NO_RECOMMENDATION_PREFIX} — either choice is fine, because …" form ` +
        `(OWNER_NO_RECOMMENDATION_PREFIX; OWNER_NOTHING_DEFAULT covers the do-nothing line) — ` +
        'see docs/FOR-YOU.md',
    );
  }
}

/** The "if you do nothing" rule: required at the write boundary, optional
 * when reading a pre-upgrade row (a legacy row renders no line rather than
 * an invented fact). */
function assertIfNothing(ifNothing: string | null | undefined): void {
  if (ifNothing === undefined || ifNothing === null) {
    throw new Error(
      'decision.ifNothing: every owner decision says what happens if the owner does nothing ' +
        `(OWNER_NOTHING_DEFAULT when nothing changes) — an undecided card that says nothing is refused ` +
        '(see docs/FOR-YOU.md)',
    );
  }
}

/**
 * The write boundary for owner-facing card text. Runs at every write of
 * owner-facing text (see the call sites named in docs/FOR-YOU.md) once the
 * effective routing is known to be `needs-owner`.
 *
 * `title` is always checked: it is the first line the owner reads. A typed
 * decision has every owner-facing string checked, plus the two required
 * fields. A notice must have specific structured guidance for its kind —
 * the generic fallback sentence is not a standard.
 *
 * `detail` is NOT checked: it is the designated evidence slot.
 */
export function assertOwnerCardLanguage(
  kind: string,
  title: string,
  decision: NotificationDecision | null,
): void {
  assertOwnerFacingText(`notification "${kind}" title`, title);
  if (decision === null) {
    if (ownerNoticeGuidance(kind) === null) {
      throw new Error(
        `notification "${kind}" has no owner guidance: every kind that can reach FOR YOU states why it is ` +
          'here, what happens if the owner does nothing, and what to do (register it in ' +
          'src/notifications/owner-language.ts — see docs/FOR-YOU.md)',
      );
    }
    return;
  }
  assertOwnerFacingText('decision.question', decision.question);
  assertOwnerFacingText('decision.context', decision.context);
  assertRecommendation(decision.recommendation);
  assertOwnerFacingText('decision.recommendation', decision.recommendation ?? '');
  assertOwnerFacingText('decision.whyNotDelegable', decision.whyNotDelegable);
  assertIfNothing(decision.ifNothing);
  assertOwnerFacingText('decision.ifNothing', decision.ifNothing ?? '');
  for (const option of decision.options) {
    assertOwnerFacingText(`decision option "${option.id}" label`, option.label);
    assertOwnerFacingText(`decision option "${option.id}" consequence`, option.consequence);
  }
}

/**
 * Fail-forward for a producer that retries or swallows its post (the Gru
 * wake stops, the lessons conflict notice): a refused title must never lose
 * the stop. The fixed plain title is posted instead and the refused text is
 * moved to `detail`, where evidence belongs — the owner still learns that
 * something needs them, and the machine text is still there to read.
 */
export const OWNER_FALLBACK_NOTICE_TITLE = 'Something needs your attention in Gru Command';

export function ownerNoticeWithFallback(
  kind: string,
  title: string,
  detail: string,
): { readonly title: string; readonly detail: string };
export function ownerNoticeWithFallback(
  kind: string,
  title: string,
  detail: string | null,
): { readonly title: string; readonly detail: string | null };
export function ownerNoticeWithFallback(
  kind: string,
  title: string,
  detail: string | null,
): { readonly title: string; readonly detail: string | null } {
  try {
    assertOwnerCardLanguage(kind, title, null);
    return { title, detail };
  } catch {
    return {
      title: OWNER_FALLBACK_NOTICE_TITLE,
      detail: [title, detail].filter((part): part is string => part !== null && part !== '').join('\n\n'),
    };
  }
}

/** What a notice row tells the owner: why it is here, what happens if they
 * do nothing, and the manual step (the app offers no control for these). */
export interface OwnerNoticeGuidance {
  readonly whyAsked: string;
  readonly ifNothing: string;
  readonly howTo: string;
}

const GUIDANCE: readonly { readonly kind: string; readonly prefix: boolean; readonly guidance: OwnerNoticeGuidance }[] = [
  {
    kind: 'port-squat',
    prefix: false,
    guidance: {
      whyAsked: 'Another program is using the port this app needs, so the app cannot serve anyone until the port is free.',
      ifNothing: 'If you do nothing, the app stays unable to use its port and this notice stays until the port is free.',
      howTo: 'Stop the program named in Details, then restart the service. This notice clears when the app next starts on its port.',
    },
  },
  {
    kind: 'roll-port-squat',
    prefix: false,
    guidance: {
      whyAsked: 'The update was refused because another program is using the port, and the update is yours to start.',
      ifNothing: 'If you do nothing, this instance keeps the version it runs now and nothing is replaced.',
      howTo: 'Stop the program named in Details, then run the update again. This notice stays until an update succeeds.',
    },
  },
  {
    kind: 'perkins-app-bundle-missing',
    prefix: false,
    guidance: {
      whyAsked: 'Review verdicts cannot be posted on GitHub pull requests, and installing the app that posts them is yours to do.',
      ifNothing: 'If you do nothing, GitHub pull-request review verdicts are not posted. Work continues, and GitLab merge requests are unaffected.',
      howTo: 'Install the Perkins GitHub App bundle in the instance folder (README, Prerequisites) and restart the service. This notice clears at the first start that resolves it, or when review is turned off.',
    },
  },
  {
    kind: 'lessons.proposal',
    prefix: false,
    guidance: {
      whyAsked: 'Nothing beyond the Accept or Reject on the proposal itself: the Book of Lessons is yours to change.',
      ifNothing: 'If you do nothing, the proposal waits and the Book of Lessons stays exactly as it is.',
      howTo: 'Review the proposed changes in the Book of Lessons, then Accept or Reject on the proposal.',
    },
  },
  {
    kind: 'lessons.proposal-conflict',
    prefix: false,
    guidance: {
      whyAsked: 'Your Accept or Reject could not be carried out, and only you can decide how the book should be repaired.',
      ifNothing: 'If you do nothing, the Book of Lessons stays as it is; your choice is kept and nothing is proposed again.',
      howTo: 'Restore the files named in Details as the notice describes, then press Accept or Reject again to finish it.',
    },
  },
  {
    kind: 'intake.slicing-result',
    prefix: false,
    guidance: {
      whyAsked: 'A minion finished slicing a plan, and what it should become is your call.',
      ifNothing: 'If you do nothing, nothing is approved: the sliced plan waits in intake and no work starts from it.',
      howTo: 'Open intake in the app, load the sliced revision, and answer the open questions there.',
    },
  },
  {
    kind: 'supervision.restart-cleanup-unconfirmed',
    prefix: false,
    guidance: {
      whyAsked: 'A worker was replaced without proof that what the old one started has stopped, and only you can settle that.',
      ifNothing: 'If you do nothing, the job keeps its automatic restart blocked; nothing is deleted and no newer worker replaces it.',
      howTo: 'Check that nothing from Details still runs for that job, then restart the service. This notice clears when the cleanup is confirmed.',
    },
  },
  {
    kind: 'job-stop-unproven',
    prefix: true,
    guidance: {
      whyAsked: 'You parked this job, and the app cannot prove that everything it started has stopped.',
      ifNothing: 'If you do nothing, the job stays parked and new work for it is refused.',
      howTo: 'Check the processes in Details; where nothing is running for the job, resuming or closing it lifts the hold. This notice settles at the next check.',
    },
  },
  {
    // Pre-#486 pause rows carry no workspace attribution: nobody can act on
    // them, so this is the informational case.
    kind: 'worktree-sweep-paused',
    prefix: false,
    guidance: {
      whyAsked: 'Nothing is asked of you; this is information about an earlier cleanup pause that names no folder.',
      ifNothing: 'If you do nothing, this notice stays open until Gru checks the folder state and closes it.',
      howTo: 'Nothing: Gru verifies the folder state and closes this notice.',
    },
  },
  {
    kind: 'worktree-sweep-paused:',
    prefix: true,
    guidance: {
      whyAsked: 'A workspace was about to be cleaned up while processes were still running in it, and stopping them is your call.',
      ifNothing: 'If you do nothing, the cleanup stays paused and nothing in that folder is removed.',
      howTo: 'Confirm nothing you need is running in the folder named in Details, then complete the cleanup from the card.',
    },
  },
  {
    kind: 'gru.wake-blocked.',
    prefix: true,
    guidance: {
      whyAsked: 'Chat cannot reach Gru, and restarting the service safely is yours to do.',
      ifNothing: 'If you do nothing, the alerts that could not reach Gru stay pending and chat cannot run a turn.',
      howTo: 'Restart the service. This notice stays until the alert behind it is handled.',
    },
  },
  {
    kind: 'gru.wake-blocked-mailbox.',
    prefix: true,
    guidance: {
      whyAsked: 'A message could not be delivered to Gru, and restarting the service safely is yours to do.',
      ifNothing: 'If you do nothing, the undelivered messages stay pending and chat cannot run a turn.',
      howTo: 'Restart the service. This notice stays until the message behind it is delivered or handled.',
    },
  },
  {
    kind: 'gru.wake-failed-escalation.',
    prefix: true,
    guidance: {
      whyAsked: 'Gru’s automatic attempts to act on an alert kept failing, so the alert is waiting for you.',
      ifNothing: 'If you do nothing, the alerts in Details stay open and no further automatic attempt is made.',
      howTo: 'Restart the service; the alerts in Details stay pending for the next turn.',
    },
  },
  {
    kind: 'decisions.enforce-gate.',
    prefix: true,
    guidance: {
      whyAsked: 'A safety check refuses to settle a decision automatically, and repairing it is yours to do.',
      ifNothing: 'If you do nothing, the work that needed this decision stays blocked and nothing is decided for you.',
      howTo: 'Repair or produce passing backtest evidence for the check named in Details, then retry the step. This notice clears when the check passes.',
    },
  },
  {
    kind: 'decisions.degraded.',
    prefix: true,
    guidance: {
      whyAsked: 'The optional decision helper cannot be reached, and its credential or setting is yours to fix.',
      ifNothing: 'If you do nothing, the app keeps using its built-in rules and this notice stays until the helper recovers.',
      howTo: 'Fix the credential or setting named in Details, then press Recheck in the app. This notice clears when the helper answers again.',
    },
  },
  {
    kind: 'silas.recovery-owner-transfer.',
    prefix: true,
    guidance: {
      whyAsked: 'A recovery was handed to you, and only your explicit answer lets it continue.',
      ifNothing: 'If you do nothing, the recovery stays exactly where it is: nothing continues and nothing is thrown away.',
      howTo: 'Read the recovery in the app and record your answer there. The addresses for this recovery are listed in Details.',
    },
  },
];

/** Guidance for a notice kind, or null when the kind has none (which the
 * write boundary refuses for any kind that can reach FOR YOU). */
export function ownerNoticeGuidance(kind: string): OwnerNoticeGuidance | null {
  for (const entry of GUIDANCE) {
    if (entry.prefix ? kind.startsWith(entry.kind) : kind === entry.kind) return entry.guidance;
  }
  return null;
}

/** True when the kind can reach the owner surface (registered owner
 * attention) — the set the guidance table has to cover. */
export function isOwnerFacingKind(kind: string): boolean {
  return ownerAttentionFor(kind) !== 'owner-forbidden';
}
