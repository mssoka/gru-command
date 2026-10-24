/**
 * Durable pre-mutation custody for a lane's branch creation (issue #453).
 *
 * A `git update-ref` transaction can commit and then fail to settle: the
 * owned child lingers past its close budget, the service dies, or the
 * process is killed. The branch ref then exists at the recorded base while
 * the checkout, the lane handoff receipt and the ledger row never happened.
 * The token that proves authorship used to live only in the creating
 * process's memory, so a later attempt could neither adopt nor roll back
 * that ref, and the branch name — permanently taken — refused every retry.
 *
 * This receipt is written and fsynced BEFORE the ref transaction starts and
 * cleared only once creation has either finished or been rolled back under
 * its own custody proof. A later attempt can therefore distinguish, without
 * inferring anything from an absent PID or an equal tip:
 *
 *   - our transaction committed and the checkout never started (adopt), or
 *   - our transaction never committed (fresh start), or
 *   - the ref/path is foreign or changed (refuse and retain).
 *
 * The receipt binds the job/lane identity, the fixed base sha, the exact
 * branch, the checkout path and the creation token. It never reconstructs
 * a past fact it did not witness: absent means "no record", never
 * "never started".
 */

import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { WorktreeBaseSource } from '../ledger/api.js';
import { CREATION_TOKEN } from './handoff.js';

/** Where a lane's creation receipt lives, under the repository's common
 * directory: the same authority as the ref it protects, and readable
 * without the ledger. */
const INTENT_DIRECTORY = 'gru-creation';
const INTENT_VERSION = 1;
const TOKEN_PREFIX = 'gru-creation:';

export class CreationIntentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CreationIntentError';
  }
}

/** A strict continuation guard refused before it began any checkout work. */
export class RetainedCreationRefusalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetainedCreationRefusalError';
  }
}

/** A strict continuation failed after adopting its receipt; the retained
 * ref, receipt and any partial checkout are kept for inspection. */
export class RetainedCreationFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetainedCreationFailedError';
  }
}

/** The retained receipt a continuation accepted: its token digest and the
 * producer settlement that proved the original creation stopped. */
export interface RetainedReceiptExpectation {
  readonly receiptTokenSha256: string;
  readonly producerSettlementSeq: number;
}

/** A creation token is custody authority: it never enters a note or event. */
export function redactCreationTokens(text: string): string {
  return text.replace(/gru-creation:[A-Za-z0-9-]+/gu, '<redacted-creation-token>');
}

/** The lane a creation receipt belongs to. Identity fields only — every one
 * is revalidated on read against the caller's request, never trusted. */
export interface CreationIntentLane {
  readonly id: string;
  readonly kind: 'job' | 'review' | 'child';
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly path: string;
}

export interface CreationIntent {
  readonly version: typeof INTENT_VERSION;
  readonly lane: CreationIntentLane;
  readonly repoPath: string;
  readonly branch: string;
  readonly sha: string;
  readonly baseSource: WorktreeBaseSource | null;
  readonly token: string;
  /** Who wrote this receipt. Diagnostic only: never cessation proof. */
  readonly host: string;
  readonly pid: number;
  readonly createdAt: string;
}

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** One receipt per branch, named by the branch so a retry finds it without
 * any in-memory state. The branch itself is inside the receipt and must
 * match — a renamed or colliding name is refused, never merged. */
function receiptPath(commonDir: string, branch: string): string {
  return join(commonDir, INTENT_DIRECTORY, `${createHash('sha256').update(branch).digest('hex').slice(0, 40)}.json`);
}

function syncDirectory(dir: string): void {
  let fd: number;
  try { fd = openSync(dir, 'r'); } catch (error) { throw new CreationIntentError(`creation receipt directory ${dir} is unreadable`, { cause: error }); }
  try { fsyncSync(fd); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw new CreationIntentError(`creation receipt directory ${dir} could not be made durable`, { cause: error });
  } finally { closeSync(fd); }
}

function assertLane(value: unknown, file: string): CreationIntentLane {
  const lane = value as Record<string, unknown> | null;
  if (typeof lane !== 'object' || lane === null) throw new CreationIntentError(`creation receipt ${file} has no lane identity`);
  const { id, kind, jobId, roundId, path } = lane;
  if (typeof id !== 'string' || id === '' || typeof path !== 'string' || path === '') throw new CreationIntentError(`creation receipt ${file} has a malformed lane identity`);
  if (kind !== 'job' && kind !== 'review' && kind !== 'child') throw new CreationIntentError(`creation receipt ${file} names an unknown lane kind`);
  if (!(jobId === null || typeof jobId === 'string' && jobId !== '')) throw new CreationIntentError(`creation receipt ${file} has a malformed job identity`);
  if (!(roundId === null || typeof roundId === 'string' && roundId !== '')) throw new CreationIntentError(`creation receipt ${file} has a malformed round identity`);
  if (kind === 'job' && jobId !== id) throw new CreationIntentError(`creation receipt ${file} does not bind the job to its own lane`);
  if (kind === 'review' && roundId !== id) throw new CreationIntentError(`creation receipt ${file} does not bind the review round to its own lane`);
  if (kind === 'child' && jobId === null) throw new CreationIntentError(`creation receipt ${file} does not bind a child lane to its job`);
  return { id, kind, jobId, roundId, path };
}

/** Read and validate one branch's receipt. Absent is not an error and is
 * not proof — it is the caller's cue to look at the ref and refuse one it
 * cannot attribute. Every malformed or partial receipt is named. */
export function readCreationIntent(commonDir: string, branch: string): CreationIntent | null {
  const file = receiptPath(commonDir, branch);
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new CreationIntentError(`creation receipt ${file} is unreadable`, { cause: error });
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) { throw new CreationIntentError(`creation receipt ${file} is not valid JSON`, { cause: error }); }
  const receipt = raw as Record<string, unknown> | null;
  if (typeof receipt !== 'object' || receipt === null) throw new CreationIntentError(`creation receipt ${file} is malformed`);
  if (receipt['version'] !== INTENT_VERSION) throw new CreationIntentError(`creation receipt ${file} has an unsupported version ${String(receipt['version'])}`);
  const { repoPath, branch: storedBranch, sha, baseSource, token, host, pid, createdAt } = receipt;
  if (typeof repoPath !== 'string' || repoPath === '') throw new CreationIntentError(`creation receipt ${file} has no repository`);
  if (storedBranch !== branch) throw new CreationIntentError(`creation receipt ${file} names branch ${String(storedBranch)}, not ${branch}`);
  if (typeof sha !== 'string' || !SHA.test(sha)) throw new CreationIntentError(`creation receipt ${file} has a malformed base sha`);
  if (!(baseSource === null || baseSource === 'origin' || baseSource === 'local-head-fallback')) throw new CreationIntentError(`creation receipt ${file} has an unknown base source`);
  // The canonical spelling every downstream receipt parser accepts — a token
  // that only LOOKS like one would be adopted here and refused after
  // registration, stranding a published lane (issue #453 review).
  if (typeof token !== 'string' || !CREATION_TOKEN.test(token)) throw new CreationIntentError(`creation receipt ${file} has a malformed creation token`);
  if (typeof host !== 'string' || host === '' || !Number.isSafeInteger(pid) || (pid as number) <= 0) throw new CreationIntentError(`creation receipt ${file} has a malformed writer identity`);
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) throw new CreationIntentError(`creation receipt ${file} has a malformed timestamp`);
  const lane = assertLane(receipt['lane'], file);
  // A job lane always resolves its provenance; a receipt that lost it can
  // never be honoured, so it is refused where it is read.
  if (lane.kind === 'job' && baseSource === null) throw new CreationIntentError(`creation receipt ${file} has no base provenance for a job lane`);
  return { version: INTENT_VERSION, lane, repoPath, branch, sha, baseSource, token, host, pid: pid as number, createdAt };
}

/** Publish the receipt durably BEFORE the ref transaction. An existing
 * receipt for the same branch is never overwritten: it is either an
 * unreconciled earlier attempt or a foreign fact, and both are refusals. */
export function writeCreationIntent(commonDir: string, intent: Omit<CreationIntent, 'version' | 'host' | 'pid' | 'createdAt'>): CreationIntent {
  const directory = join(commonDir, INTENT_DIRECTORY);
  const file = receiptPath(commonDir, intent.branch);
  const receipt: CreationIntent = { version: INTENT_VERSION, ...intent, host: hostname(), pid: process.pid, createdAt: new Date().toISOString() };
  const temp = join(directory, `.${receipt.token.slice(TOKEN_PREFIX.length)}.tmp`);
  let failed: unknown;
  try {
    mkdirSync(directory, { recursive: true });
    syncDirectory(commonDir); // the new directory's own entry is durable before it is used
    syncDirectory(directory);
    const fd = openSync(temp, 'wx');
    try { writeFileSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temp, file); // atomic publication, never an overwrite
    syncDirectory(directory);
  } catch (error) {
    failed = error; // named below, after our own temporary name is gone
  }
  try { unlinkSync(temp); } catch (error) {
    // Our own temporary name is absent when the exclusive open never ran.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CreationIntentError(`the temporary creation receipt for branch ${intent.branch} could not be removed`,
        { cause: failed === undefined ? error : new AggregateError([failed, error], 'receipt publication and its temporary name both failed') });
    }
  }
  if (failed !== undefined) {
    if ((failed as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CreationIntentError(`branch ${intent.branch} already has an unreconciled creation receipt — inspect it before retrying`, { cause: failed });
    }
    throw new CreationIntentError(`creation receipt for branch ${intent.branch} could not be published`, { cause: failed });
  }
  return receipt;
}

/** Clear the receipt once creation finished or was rolled back. Only the
 * exact owning token may clear it; a different receipt is left for its own
 * reconciliation to judge. */
export function clearCreationIntent(commonDir: string, branch: string, token: string): void {
  const file = receiptPath(commonDir, branch);
  const receipt = readCreationIntent(commonDir, branch);
  if (receipt === null) return;
  if (receipt.token !== token) {
    throw new CreationIntentError(`creation receipt for branch ${branch} belongs to another invocation — refusing to clear it`);
  }
  try {
    unlinkSync(file);
    syncDirectory(join(commonDir, INTENT_DIRECTORY));
  } catch (error) {
    throw new CreationIntentError(`creation receipt ${file} could not be cleared`, { cause: error });
  }
}
