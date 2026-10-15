import { createHash } from 'node:crypto';
import type {
  FrozenContract,
  OverlayFile,
  OverlayIdentity,
  PropertyProposal,
  QualificationControlResult,
} from './types.js';
import { isSafeRelativePath, parsePropertyProposal } from './proposal.js';
import type { BaselineAttribution } from './qualification.js';

/**
 * FrozenContract assembly and tamper detection (issue §4: freeze for
 * repair; tamper with the oracle ⇒ requalify).
 *
 * The frozen types extend the shared contract additively so they stay
 * structurally assignable to `FrozenContract` without editing the frozen
 * `types.ts`: overlay entries carry the selection filter they must stay
 * reachable through, and the frozen metadata carries the replay seeds that
 * must stay exercised plus the source identity the contract was qualified
 * against. Control results carry their host receipt refs — never a
 * self-supplied hash. `verifyFrozen` NEVER repairs anything — it reports
 * mismatches as an explicit requalification-required result with reasons.
 */

/** An overlay file plus the runner selection filter that must keep it selected. */
export interface FrozenOverlayEntry extends OverlayFile {
  readonly selectionFilter: string;
}

/** Overlay identity enriched with the tamper-detection metadata. */
export interface FrozenOverlayIdentity extends OverlayIdentity {
  readonly files: readonly FrozenOverlayEntry[];
  /** Replay seeds (retained counterexamples) the overlay must keep exercising. */
  readonly mandatorySeeds: readonly string[];
}

/** What freeze() accepts: the overlay identity plus the source it was
 * qualified against (evidence binds exact source identity). */
export interface FreezeOverlayInput extends FrozenOverlayIdentity {
  readonly sourceSha256: string;
}

/** A `FrozenContract` with the tamper-detection metadata preserved. */
export interface QualifiedFrozenContract extends FrozenContract {
  readonly frozenOverlay: FrozenOverlayIdentity;
  readonly frozenSourceSha256: string;
}

/** The current overlay state verifyFrozen() compares against the frozen set. */
export interface CurrentOverlayState {
  readonly files: readonly FrozenOverlayEntry[];
  /** Seeds the current generators/run actually exercise (host-recorded). */
  readonly exercisedSeeds: readonly string[];
}

/** verifyFrozen() result: mismatches are disclosed, never auto-repaired. */
export interface RequalificationResult {
  readonly requalificationRequired: boolean;
  readonly reasons: readonly string[];
}

export class PropertyFreezeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyFreezeError';
  }
}

const MAX_OVERLAY_FILES = 200;
const MAX_FILTER_BYTES = 500;
const MAX_SEED_BYTES = 500;
const MAX_SOURCE_HASH_BYTES = 200;
const MAX_RECEIPT_ID_BYTES = 200;
const ATTRIBUTIONS: readonly string[] = ['candidate-only', 'baseline-also-fails', 'unattributed'];

export interface FreezeControls {
  readonly knownBadControl: QualificationControlResult;
  readonly healthyControl: QualificationControlResult;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Deterministic canonical JSON: object keys sorted recursively, no
 * whitespace — the byte basis of `frozenAtSha256`. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PropertyFreezeError('canonical JSON refuses non-finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  throw new PropertyFreezeError(`canonical JSON refuses a ${String(typeof value)} value`);
}

function nonEmptyString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PropertyFreezeError(`${name} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, 'utf8') > max) {
    throw new PropertyFreezeError(`${name} exceeds ${max} UTF-8 bytes`);
  }
  return value;
}

function hex64(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new PropertyFreezeError(`${name} must be a sha256 hex digest (64 lowercase hex characters)`);
  }
  return value;
}

function validateEntries(
  entries: readonly unknown[],
  name: string,
  options: { readonly allowEmpty: boolean },
): readonly FrozenOverlayEntry[] {
  if (entries.length === 0 && !options.allowEmpty) {
    throw new PropertyFreezeError(`${name} must list at least one overlay file (nothing to freeze)`);
  }
  if (entries.length > MAX_OVERLAY_FILES) {
    throw new PropertyFreezeError(`${name} exceeds ${MAX_OVERLAY_FILES} files`);
  }
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new PropertyFreezeError(`${name}[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const path = nonEmptyString(record['path'], `${name}[${index}].path`, 500);
    if (!isSafeRelativePath(path)) {
      throw new PropertyFreezeError(
        `${name}[${index}].path must be a safe relative path (no leading "/", no leading "-", no "..", no backslash, no colon), got: "${path}"`,
      );
    }
    if (seen.has(path)) {
      throw new PropertyFreezeError(`${name} lists duplicate path "${path}"`);
    }
    seen.add(path);
    const bytes = record['bytes'];
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new PropertyFreezeError(`${name}[${index}].bytes must be a non-negative safe integer`);
    }
    return {
      path,
      sha256: hex64(record['sha256'], `${name}[${index}].sha256`),
      bytes,
      selectionFilter: nonEmptyString(record['selectionFilter'], `${name}[${index}].selectionFilter`, MAX_FILTER_BYTES),
    };
  });
}

function validateSeeds(seeds: readonly unknown[], name: string): readonly string[] {
  return seeds.map((seed, index) => nonEmptyString(seed, `${name}[${index}]`, MAX_SEED_BYTES));
}

/**
 * Validate one control result. It must be bound to a HOST-ISSUED receipt
 * reference: a bare `satisfied` story without `receiptRef` (or with a
 * self-supplied hash in its place) is rejected — control results are only
 * as trustworthy as the receipt identity they cite.
 */
function validateControl(control: unknown, name: string): QualificationControlResult {
  if (typeof control !== 'object' || control === null || Array.isArray(control)) {
    throw new PropertyFreezeError(`${name} must be a QualificationControlResult object`);
  }
  const record = control as Record<string, unknown>;
  const satisfied = record['satisfied'];
  if (typeof satisfied !== 'boolean') {
    throw new PropertyFreezeError(`${name}.satisfied must be a boolean`);
  }
  const detail = record['detail'];
  if (typeof detail !== 'string' || detail.trim() === '' || Buffer.byteLength(detail, 'utf8') > 2_000) {
    throw new PropertyFreezeError(`${name}.detail must be a non-empty string of at most 2000 UTF-8 bytes`);
  }
  const ref = record['receiptRef'];
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) {
    throw new PropertyFreezeError(
      `${name}.receiptRef must be an ExecutionReceiptRef object — a control result without a host receipt reference is never freeze input`,
    );
  }
  const receiptId = (ref as Record<string, unknown>)['receiptId'];
  if (typeof receiptId !== 'string' || receiptId.trim() === '' || Buffer.byteLength(receiptId, 'utf8') > MAX_RECEIPT_ID_BYTES) {
    throw new PropertyFreezeError(
      `${name}.receiptRef.receiptId must be a non-empty string of at most ${MAX_RECEIPT_ID_BYTES} UTF-8 bytes (never a self-supplied hash)`,
    );
  }
  return { receiptRef: { receiptId }, satisfied, detail };
}

/**
 * Assemble a FrozenContract from a validated proposal, its overlay
 * (carrying source binding, per-file selection filters and mandatory
 * replay seeds), the satisfied control results, and the baseline
 * attribution. `frozenAtSha256` is sha256 over the canonical JSON of every
 * field except itself.
 */
export function freeze(
  proposal: PropertyProposal,
  overlay: FreezeOverlayInput,
  controls: FreezeControls,
  attribution: BaselineAttribution,
): QualifiedFrozenContract {
  // Proposals are untrusted even on this path: validate again before the
  // contract becomes a persisted freeze input.
  const validProposal = parsePropertyProposal(proposal);
  if (!ATTRIBUTIONS.includes(attribution)) {
    throw new PropertyFreezeError(
      `attribution must be one of candidate-only, baseline-also-fails, unattributed (got: "${String(attribution)}")`,
    );
  }
  const knownBadControl = validateControl(controls.knownBadControl, 'knownBadControl');
  if (!knownBadControl.satisfied) {
    throw new PropertyFreezeError(
      `refusing to freeze: the known-bad control is not satisfied (${knownBadControl.detail}) — an unqualified oracle is never frozen`,
    );
  }
  const healthyControl = validateControl(controls.healthyControl, 'healthyControl');
  if (!healthyControl.satisfied) {
    throw new PropertyFreezeError(
      `refusing to freeze: the healthy control is not satisfied (${healthyControl.detail}) — an unqualified oracle is never frozen`,
    );
  }
  if (typeof overlay !== 'object' || overlay === null || Array.isArray(overlay)) {
    throw new PropertyFreezeError('freeze overlay must be an object');
  }
  const record = overlay as unknown as Record<string, unknown>;
  const files = validateEntries(
    Array.isArray(record['files']) ? record['files'] : [],
    'freeze overlay files',
    { allowEmpty: false },
  );
  const mandatorySeeds = validateSeeds(
    Array.isArray(record['mandatorySeeds']) ? record['mandatorySeeds'] : [],
    'freeze overlay mandatorySeeds',
  );
  const overlaySha256 = hex64(record['overlaySha256'], 'freeze overlay overlaySha256');
  const frozenSourceSha256 = nonEmptyString(record['sourceSha256'], 'freeze overlay sourceSha256', MAX_SOURCE_HASH_BYTES);

  const frozenOverlay: FrozenOverlayIdentity = { files, mandatorySeeds, overlaySha256 };
  const contract: Omit<QualifiedFrozenContract, 'frozenAtSha256'> = {
    proposal: validProposal,
    frozenOverlay,
    knownBadControl,
    healthyControl,
    baselineAttribution: attribution,
    frozenSourceSha256,
  };
  return { ...contract, frozenAtSha256: sha256Hex(canonicalJson(contract)) };
}

/** Narrow a persisted FrozenContract back to the enriched shape, failing
 * loud when the tamper-detection metadata is absent. */
function requireQualified(frozen: FrozenContract): QualifiedFrozenContract {
  if (typeof frozen !== 'object' || frozen === null) {
    throw new PropertyFreezeError('frozen contract must be an object');
  }
  const record = frozen as unknown as Record<string, unknown>;
  const overlay = record['frozenOverlay'];
  if (typeof overlay !== 'object' || overlay === null || !Array.isArray((overlay as Record<string, unknown>)['files'])) {
    throw new PropertyFreezeError('frozen contract has no frozenOverlay.files — cannot verify tamper detection');
  }
  for (const entry of (overlay as Record<string, unknown>)['files'] as unknown[]) {
    if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>)['selectionFilter'] !== 'string') {
      throw new PropertyFreezeError(
        'frozen contract overlay entries lack selectionFilter metadata — tamper detection is impossible without it',
      );
    }
  }
  if (!Array.isArray((overlay as Record<string, unknown>)['mandatorySeeds'])) {
    throw new PropertyFreezeError('frozen contract has no frozenOverlay.mandatorySeeds — seed-exclusion detection is impossible');
  }
  if (typeof record['frozenSourceSha256'] !== 'string' || record['frozenSourceSha256'] === '') {
    throw new PropertyFreezeError('frozen contract has no frozenSourceSha256 — source-identity verification is impossible');
  }
  return frozen as QualifiedFrozenContract;
}

/**
 * Verify a frozen contract against the CURRENT overlay state and source
 * hash. Detects: deleted files (frozen but absent), altered files (hash or
 * byte mismatch), narrowed/changed selection filters (the frozen contract
 * is no longer selected exactly as frozen), generator-excluded
 * counterexamples (a mandatory replay seed no longer exercised),
 * source-identity drift, and a persisted contract that no longer matches
 * its own frozenAtSha256. Any mismatch yields an explicit
 * requalification-required result with reasons. The oracle is NEVER
 * auto-repaired here — requalification is the only remedy.
 */
export function verifyFrozen(
  frozen: FrozenContract,
  currentOverlay: CurrentOverlayState,
  currentSourceHash: string,
): RequalificationResult {
  const qualified = requireQualified(frozen);
  if (typeof currentOverlay !== 'object' || currentOverlay === null || !Array.isArray(currentOverlay.files)) {
    throw new PropertyFreezeError('current overlay state must be an object with a files array');
  }
  // The CURRENT overlay may legitimately be empty — that is exactly the
  // "every frozen file was deleted" tamper scenario, reported as reasons.
  const currentFiles = validateEntries(currentOverlay.files, 'current overlay files', { allowEmpty: true });
  const currentSeeds = validateSeeds(currentOverlay.exercisedSeeds ?? [], 'current overlay exercisedSeeds');
  const sourceHash = nonEmptyString(currentSourceHash, 'currentSourceHash', MAX_SOURCE_HASH_BYTES);

  const reasons: string[] = [];

  const recomputed = sha256Hex(canonicalJson({
    proposal: qualified.proposal,
    frozenOverlay: qualified.frozenOverlay,
    knownBadControl: qualified.knownBadControl,
    healthyControl: qualified.healthyControl,
    baselineAttribution: qualified.baselineAttribution,
    frozenSourceSha256: qualified.frozenSourceSha256,
  }));
  if (recomputed !== qualified.frozenAtSha256) {
    reasons.push(
      `frozen-at-hash-mismatch: the persisted contract no longer matches its own frozenAtSha256 ` +
        `(recorded ${qualified.frozenAtSha256}, recomputed ${recomputed})`,
    );
  }

  const currentByPath = new Map(currentFiles.map((entry) => [entry.path, entry]));
  for (const frozenEntry of qualified.frozenOverlay.files) {
    const current = currentByPath.get(frozenEntry.path);
    if (current === undefined) {
      reasons.push(`deleted-file: "${frozenEntry.path}" is in the frozen set but absent from the current overlay`);
      continue;
    }
    if (current.sha256 !== frozenEntry.sha256 || current.bytes !== frozenEntry.bytes) {
      reasons.push(
        `altered-file: "${frozenEntry.path}" changed (frozen sha256 ${frozenEntry.sha256}/${frozenEntry.bytes}B, ` +
          `current ${current.sha256}/${current.bytes}B)`,
      );
    }
    if (current.selectionFilter !== frozenEntry.selectionFilter) {
      reasons.push(
        `narrowed-selection-filter: selection filter for "${frozenEntry.path}" changed (frozen ` +
          `"${frozenEntry.selectionFilter}", current "${current.selectionFilter}") — the frozen contract is no ` +
          `longer selected exactly as frozen (any narrowing or widening breaks the frozen selection identity)`,
      );
    }
  }

  const exercised = new Set(currentSeeds);
  for (const seed of qualified.frozenOverlay.mandatorySeeds) {
    if (!exercised.has(seed)) {
      reasons.push(
        `generator-excluded-counterexample: mandatory replay seed "${seed}" is no longer exercised by the current overlay`,
      );
    }
  }

  if (sourceHash !== qualified.frozenSourceSha256) {
    reasons.push(
      `source-changed: the source the contract was frozen against changed (frozen ${qualified.frozenSourceSha256}, ` +
        `current ${sourceHash}) — stale evidence, requalification required`,
    );
  }

  return { requalificationRequired: reasons.length > 0, reasons };
}
