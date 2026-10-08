import { createHash } from 'node:crypto';

/**
 * Canonical job amendments (owner ruling j-969; PR165 gap).
 *
 * A job's briefing is immutable history. Accepted amendments are append-only,
 * versioned rows that are RENDERED — never merged or rewritten — into the
 * effective acceptance a later review round freezes:
 *
 *   original briefing (verbatim, always first)
 *   + every accepted amendment in version order, each carrying its approval
 *     provenance, explicit supersession list, body hash and effectiveness
 *     status; an amendment superseded by a later one stays visible but is
 *     marked NOT EFFECTIVE.
 *
 * Concurrency is optimistic on the effective contract hash: a writer must
 * present the hash it read (`expectedContractSha256`); a stale writer is
 * rejected, never merged. Idempotent retries return the already-accepted
 * amendment for the same request fingerprint.
 *
 * Authorization honesty: this module stores the approval provenance a caller
 * supplies (`by` + a durable `reference`), but provenance text is not an
 * identity system. The service's paired bearer token remains the only
 * authentication primitive; the amendment surface never infers owner approval
 * from body text, a caller-declared role, a repository document, or a
 * notification acknowledgement.
 */

export const AMENDMENT_MAX_BODY_BYTES = 32 * 1024;
export const AMENDMENT_MAX_SUPERSEDES = 32;
export const AMENDMENT_MAX_SUPERSEDE_CHARS = 300;
export const AMENDMENT_MAX_APPROVAL_BY_BYTES = 200;
export const AMENDMENT_MAX_APPROVAL_REFERENCE_BYTES = 500;
export const AMENDMENT_MAX_IDEMPOTENCY_KEY_CHARS = 200;
/** Rendered-contract bound: below the frozen spec bound (256 KiB), leaving
 * room for the host-recorded verification and CI blocks appended after it. */
export const AMENDMENT_CONTRACT_MAX_BYTES = 192 * 1024;

/**
 * What an accepted amendment asks of the lane (owner rule 1, 2026-10-08).
 * `material`: the approved change requires implementation — the delivered
 * candidate is outdated until a continuation carrying this revision
 * delivers, and a review of the old candidate is superseded. `administrative`:
 * a clarification, typo or bookkeeping update — it never restarts work and
 * never blocks review. Rows accepted before the field existed are `null`
 * (unclassified) and never gate anything: history is not re-decided.
 */
export const AMENDMENT_EFFECTS = ['material', 'administrative'] as const;
export type AmendmentEffect = (typeof AMENDMENT_EFFECTS)[number];

export function isAmendmentEffect(value: unknown): value is AmendmentEffect {
  return typeof value === 'string' && (AMENDMENT_EFFECTS as readonly string[]).includes(value);
}

export interface JobAmendmentApproval {
  readonly by: string;
  readonly reference: string;
}

export interface JobAmendmentRecord {
  readonly id: string;
  readonly jobId: string;
  readonly version: number;
  readonly body: string;
  readonly bodySha256: string;
  readonly supersedes: readonly string[];
  readonly approval: JobAmendmentApproval;
  /** null = accepted before classification existed (never gates work). */
  readonly effect: AmendmentEffect | null;
  readonly previousContractSha256: string;
  readonly contractSha256: string;
  /** Fingerprint of the exact accepted request (idempotency binding). */
  readonly requestSha256: string;
  readonly idempotencyKey: string | null;
  readonly createdAt: string;
}

export interface EffectiveContract {
  /** Number of accepted amendments rendered into `text`. */
  readonly version: number;
  /** sha256 of the original briefing bytes ('' when none was recorded). */
  readonly baseSha256: string;
  /** sha256 of the rendered effective text (equals baseSha256 at version 0). */
  readonly contractSha256: string;
  /** null only when the job has neither a briefing nor amendments. */
  readonly text: string | null;
  readonly amendmentIds: readonly string[];
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function amendmentBodySha256(body: string): string {
  return sha256(body);
}

/** sha256 of the exact request a writer submitted (idempotency fingerprint).
 * The effect joins the fingerprint only when present, so a pre-classification
 * request keeps the fingerprint it was accepted under. */
export function amendmentRequestSha256(input: {
  readonly body: string;
  readonly supersedes: readonly string[];
  readonly approval: JobAmendmentApproval;
  readonly expectedContractSha256: string;
  readonly effect?: AmendmentEffect | null;
}): string {
  return sha256(JSON.stringify({
    body: input.body,
    supersedes: [...input.supersedes],
    approval: { by: input.approval.by, reference: input.approval.reference },
    expectedContractSha256: input.expectedContractSha256,
    ...(input.effect !== undefined && input.effect !== null ? { effect: input.effect } : {}),
  }));
}

/** The highest version among material amendments (0 when none): the work
 * revision a delivery must carry before its candidate may be reviewed. */
export function requiredWorkRevision(amendments: readonly Pick<JobAmendmentRecord, 'version' | 'effect'>[]): number {
  let required = 0;
  for (const amendment of amendments) {
    if (amendment.effect === 'material' && amendment.version > required) required = amendment.version;
  }
  return required;
}

/** A job's work revisions: what review requires vs what the newest
 * delivery carried. `required > delivered` = a correction is pending. */
export interface WorkRevisionState {
  readonly required: number;
  readonly delivered: number;
}

/** The work revision a `job.delivered` event carried: its
 * service-stamped `work_revision` (0 when the event predates revisions or
 * carries none — a delivery never proves a revision it was not stamped
 * with). */
export function deliveredWorkRevision(event: { readonly payload: unknown } | null): number {
  if (event === null || typeof event.payload !== 'object' || event.payload === null) return 0;
  const raw = (event.payload as { work_revision?: unknown }).work_revision;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
}

/** The material amendments a delivery at `deliveredRevision` has not yet
 * carried, in version order: the one continuation's payload (rule 4). */
export function pendingMaterialAmendments(
  amendments: readonly JobAmendmentRecord[],
  deliveredRevision: number,
  upToRevision: number,
): readonly JobAmendmentRecord[] {
  return [...amendments]
    .filter((amendment) => amendment.effect === 'material' &&
      amendment.version > deliveredRevision && amendment.version <= upToRevision)
    .sort((left, right) => left.version - right.version);
}

function hasDisallowedControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 && character !== '\n' && character !== '\t') return true;
    if (code === 127) return true;
  }
  return false;
}

/** Named reason when a draft is structurally invalid, null when valid. */
export function validateAmendmentDraft(input: {
  readonly body: string;
  readonly supersedes: readonly string[];
  readonly approval: JobAmendmentApproval;
  readonly existingAmendmentIds: readonly string[];
}): string | null {
  if (input.body.trim() === '') return 'amendment body must be non-empty';
  if (Buffer.byteLength(input.body, 'utf8') > AMENDMENT_MAX_BODY_BYTES) {
    return `amendment body exceeds ${AMENDMENT_MAX_BODY_BYTES} UTF-8 bytes`;
  }
  if (input.body.includes('\0')) return 'amendment body contains a NUL byte';
  if (input.approval.by.trim() === '' || hasDisallowedControl(input.approval.by)) {
    return 'approval.by must be non-empty printable text';
  }
  if (Buffer.byteLength(input.approval.by, 'utf8') > AMENDMENT_MAX_APPROVAL_BY_BYTES) {
    return `approval.by exceeds ${AMENDMENT_MAX_APPROVAL_BY_BYTES} UTF-8 bytes`;
  }
  if (input.approval.reference.trim() === '' || hasDisallowedControl(input.approval.reference)) {
    return 'approval.reference must be a non-empty durable reference (no control characters)';
  }
  if (Buffer.byteLength(input.approval.reference, 'utf8') > AMENDMENT_MAX_APPROVAL_REFERENCE_BYTES) {
    return `approval.reference exceeds ${AMENDMENT_MAX_APPROVAL_REFERENCE_BYTES} UTF-8 bytes`;
  }
  if (input.supersedes.length > AMENDMENT_MAX_SUPERSEDES) {
    return `supersedes exceeds ${AMENDMENT_MAX_SUPERSEDES} entries`;
  }
  const seen = new Set<string>();
  for (const entry of input.supersedes) {
    if (entry.trim() === '' || hasDisallowedControl(entry)) {
      return 'each supersedes entry must be non-empty printable text';
    }
    if (entry.length > AMENDMENT_MAX_SUPERSEDE_CHARS) {
      return `supersedes entry exceeds ${AMENDMENT_MAX_SUPERSEDE_CHARS} characters`;
    }
    if (seen.has(entry)) return `supersedes entry "${entry}" is duplicated`;
    seen.add(entry);
    if (entry.startsWith('amendment:')) {
      const id = entry.slice('amendment:'.length);
      if (id === '' || !input.existingAmendmentIds.includes(id)) {
        return `supersedes references unknown amendment "${id}"`;
      }
    } else if (!entry.startsWith('original:') || entry.slice('original:'.length).trim() === '') {
      return `supersedes entry "${entry}" must be "original:<anchor>" or "amendment:<id>"`;
    }
  }
  return null;
}

/** Which accepted amendments a later one superseded: amendment id → the
 * version of the FIRST later amendment naming `amendment:<id>`. One rule
 * for the rendered contract and the revision continuation. */
export function amendmentSupersessions(amendments: readonly JobAmendmentRecord[]): ReadonlyMap<string, number> {
  const ordered = [...amendments].sort((left, right) => left.version - right.version);
  const supersededBy = new Map<string, number>();
  for (const amendment of ordered) {
    for (const entry of amendment.supersedes) {
      if (!entry.startsWith('amendment:')) continue;
      const id = entry.slice('amendment:'.length);
      if (!supersededBy.has(id)) supersededBy.set(id, amendment.version);
    }
  }
  return supersededBy;
}

/** Render the effective acceptance. Zero amendments return the original
 * briefing bytes EXACTLY (backward compatibility: existing jobs freeze
 * byte-identical specs). */
export function renderEffectiveContract(
  briefing: string | null,
  amendments: readonly JobAmendmentRecord[],
): EffectiveContract {
  const baseSha256 = sha256(briefing ?? '');
  const ordered = [...amendments].sort((left, right) => left.version - right.version);
  if (ordered.length === 0) {
    return {
      version: 0,
      baseSha256,
      contractSha256: baseSha256,
      text: briefing,
      amendmentIds: [],
    };
  }
  // First later amendment naming `amendment:<id>` in its supersedes list owns
  // the supersession marker. History stays visible; effectiveness is explicit.
  const supersededBy = amendmentSupersessions(ordered);
  if (briefing === null) {
    // Unreachable through addJobAmendment (no-briefing jobs take no
    // amendments). A caller bypassing that guard must refuse, never invent
    // contract text.
    throw new Error('cannot render amendments for a job with no recorded briefing');
  }
  const lines: string[] = [
    briefing,
    '',
    '===== CANONICAL AMENDMENTS (append-only; accepted amendments affect later review rounds only) =====',
  ];
  for (const amendment of ordered) {
    const superseder = supersededBy.get(amendment.id);
    lines.push(
      '',
      `## Amendment #${amendment.version} — accepted ${amendment.createdAt}`,
      `approval: ${amendment.approval.by} — ${amendment.approval.reference}`,
      `supersedes: ${amendment.supersedes.length === 0 ? 'none' : amendment.supersedes.join(', ')}`,
      `body_sha256: ${amendment.bodySha256}`,
      // Unclassified (pre-effect) rows render byte-identically to before, so
      // already-frozen contract hashes never move.
      ...(amendment.effect === null ? [] : [amendment.effect === 'material'
        ? 'effect: MATERIAL — requires implementation; the candidate must carry this revision before review'
        : 'effect: ADMINISTRATIVE — no implementation required']),
      superseder === undefined
        ? 'status: EFFECTIVE'
        : `status: NOT EFFECTIVE — superseded by amendment #${superseder}`,
      '',
      amendment.body,
    );
  }
  const text = lines.join('\n');
  return {
    version: ordered.length,
    baseSha256,
    contractSha256: sha256(text),
    text,
    amendmentIds: ordered.map((amendment) => amendment.id),
  };
}
