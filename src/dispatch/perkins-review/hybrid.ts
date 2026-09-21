import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { AgentSpawner } from '../service.js';
import type { AgentHandle, NativeAgentTool } from '../../runtime/types.js';
import { MAX_TRANSPORT_CHUNK_BYTES, assertFrozenPromptBounds, refMovedSinceFreeze, writeReviewArtifact, type FrozenReview } from './artifacts.js';
import { finalAssistantText } from './session-output.js';
import { PERKINS_LENSES, type PerkinsLens, type PerkinsPolicy } from './policy.js';
import {
  dedupeVerifiedFindings,
  parseFindings,
  verdictForFindings,
  type CanonicalReviewVerdict,
  type FixAuditResult,
  type LensEnvelope,
  type ReviewCompleteness,
  type ReviewFinding,
  type VerifiedFinding,
  type VerificationDisposition,
} from './types.js';

const CHILD_CONCURRENCY = 4;
const CHILD_SPAWN_TIMEOUT_MS = 60 * 1_000;
const CHILD_TURN_TIMEOUT_MS = 10 * 60 * 1_000;
const LEAD_SPAWN_TIMEOUT_MS = 60 * 1_000;
/** Wall-clock bound on the whole lead run (one prompt = many turns). */
const LEAD_TOTAL_TIMEOUT_MS = 4 * 60 * 60 * 1_000;
const MAX_LEAD_TURNS = 80;
const MAX_TOOL_RUNS = 4;
const MAX_TOTAL_CANDIDATES = 1_000;
const MAX_TERMINAL_ATTEMPTS = 2;
const MAX_LEAD_ARTIFACTS = 20;
const MAX_LEAD_ARTIFACT_BYTES = 100 * 1024;
export const PERKINS_REPORT_MAX_BYTES = 128 * 1024;
const REVIEW_OWNER = 'perkins-hybrid-review';

const BLIND_SYSTEM_PROMPT =
  'You are one blind Perkins lens child. The user prompt is your entire context. You have no tools, repository context, skills, extensions, or delegation authority. Return only the required JSON array.';
const LENS_SYSTEM_PROMPT =
  'You are one Perkins lens child. Use only the read-only frozen-tree tools and the supplied prompt. Return only the required JSON array. Never edit, delegate, invoke skills, or start another review.';

export interface ReviewProgress {
  readonly lens: PerkinsLens;
  readonly chunk: string;
  readonly state: 'running' | 'done' | 'error';
  readonly note?: string;
}

export interface PerkinsHybridReviewOptions {
  readonly spawner: AgentSpawner;
  readonly policy: PerkinsPolicy;
  readonly onProgress?: (progress: ReviewProgress) => void;
  readonly onAgent?: (input: {
    readonly phase: 'lead' | 'lens';
    readonly lens?: PerkinsLens;
    readonly chunk?: string;
    readonly handle: AgentHandle;
  }) => void;
}

export interface RunPerkinsHybridInput {
  readonly roundId: string;
  readonly roundNumber: number;
  readonly frozenReview: FrozenReview;
  readonly movementRef: string;
  readonly noSpec: boolean;
  readonly priorConsolidatedFile?: string;
  /** Service shutdown or caller cancellation. Cancellation is always INCOMPLETE. */
  readonly signal?: AbortSignal;
}

export interface VerificationSummary {
  readonly candidates: number;
  readonly confirmed: number;
  readonly rejected: number;
  readonly unverified: number;
  readonly speculative: number;
  readonly deduplicated: number;
}

export interface PerkinsHybridResult {
  readonly canonicalVerdict: CanonicalReviewVerdict;
  readonly findings: readonly VerifiedFinding[];
  readonly completeness: ReviewCompleteness;
  readonly artifactDirectory: string;
  readonly reportFile: string;
  readonly targetSha: string;
  readonly diffBaseSha: string;
  readonly headMoved: boolean;
  readonly lensEnvelopes: readonly LensEnvelope[];
  readonly priorAudit: readonly FixAuditResult[];
  readonly verificationSummary: VerificationSummary;
}

interface ChildCandidate extends ReviewFinding {
  readonly ref: string;
  readonly chunk: string;
  readonly resultId: string;
  readonly findingIndex: number;
}

interface ChildResult {
  readonly resultId: string;
  readonly agentId: string;
  readonly lens: PerkinsLens;
  readonly chunk: string;
  readonly attempt: 1 | 2;
  readonly status: 'valid' | 'invalid' | 'failed';
  readonly findings: readonly ChildCandidate[];
  /** Host-carried tests-lens coverage gate status (undefined for other lenses). */
  readonly coverageGate?: 'PASS' | 'CONCERNS' | 'FAIL';
  readonly error?: string;
}

interface CandidateDecision {
  readonly candidate_ref: string;
  readonly disposition: VerificationDisposition;
  readonly evidence: string;
  readonly reason: string;
}

interface LeadSubmission {
  readonly canonical_verdict: CanonicalReviewVerdict;
  readonly candidate_decisions: readonly CandidateDecision[];
  readonly prior_audit: readonly FixAuditResult[];
  readonly report_markdown: string;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function headMovedSinceFreeze(review: FrozenReview, movementRef: string): boolean {
  if (refMovedSinceFreeze(review)) return true;
  if (movementRef === review.manifest.targetSha || movementRef === review.manifest.targetRef) return false;
  try {
    return execFileSync(
      'git', ['-C', review.manifest.repoPath, 'rev-parse', '--verify', `${movementRef}^{commit}`],
      { encoding: 'utf8', timeout: GIT_PROOF_TIMEOUT_MS },
    ).trim() !== review.manifest.targetSha;
  } catch {
    return true;
  }
}

/** Exact N-byte UTF-8 prefix of a string (never splitting a code point). */
function bytePrefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut -= 1;
  return bytes.subarray(0, cut).toString('utf8');
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  if (Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    throw new Error(`${name} keys do not match the required schema`);
  }
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string`);
  if (Buffer.byteLength(value, 'utf8') > max) throw new Error(`${name} exceeds ${max} UTF-8 bytes`);
  return value;
}

function findingPath(finding: Pick<ReviewFinding, 'location'>): string | null {
  const token = finding.location.split(':', 1)[0]?.trim() ?? '';
  if (
    token === '' || token === 'N/A' || token.startsWith('-') || token.startsWith('/') ||
    token.includes('\\') || token.split('/').some((component) => component === '' || component === '.' || component === '..')
  ) return null;
  return token;
}

const GIT_PROOF_TIMEOUT_MS = 30_000;

function frozenBlobContains(review: FrozenReview, path: string, evidence: string): boolean {
  try {
    const blob = execFileSync('git', ['-C', review.manifest.repoPath, 'show', `${review.manifest.targetSha}:${path}`], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return blob.includes(evidence);
  } catch {
    return false;
  }
}

function frozenPathDiff(review: FrozenReview, path: string, baseSha = review.manifest.diffBaseSha): string {
  try {
    return execFileSync('git', [
      '-C', review.manifest.repoPath, 'diff', '--no-ext-diff', '--no-color', '--unified=3',
      baseSha, review.manifest.targetSha, '--', `:(literal)${path}`,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

function evidenceAtCitedLocation(review: FrozenReview, finding: ReviewFinding, evidence: string): boolean {
  if (evidence === 'N/A' || evidence.trim() === '') return false;
  const path = findingPath(finding);
  // Binding is to the CITED FILE in the frozen tree (blob or its diff), not
  // to the chunk's changed-file list: lens children read the whole frozen
  // tree and may cite an unchanged file with a real defect.
  if (path === null) return false;
  return frozenBlobContains(review, path, evidence) || frozenPathDiff(review, path).includes(evidence);
}

function evidenceAnywhere(review: FrozenReview, evidence: string): boolean {
  if (evidence === 'N/A' || evidence.trim() === '') return false;
  if (review.chunks.some((chunk) => chunk.diff.includes(evidence))) return true;
  try {
    return execFileSync('git', [
      '-C', review.manifest.repoPath, 'grep', '-F', '--full-name', '--', evidence, review.manifest.targetSha, '--',
    ], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: GIT_PROOF_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() !== '';
  } catch {
    return false;
  }
}

function fixedAuditEvidence(
  review: FrozenReview,
  finding: VerifiedFinding,
  evidence: string,
  priorTargetSha: string | null,
): boolean {
  const path = findingPath(finding);
  if (path === null) return false;
  if (evidence === `PATH ABSENT: ${path}`) {
    try {
      execFileSync('git', ['-C', review.manifest.repoPath, 'cat-file', '-e', `${review.manifest.targetSha}:${path}`], {
        timeout: GIT_PROOF_TIMEOUT_MS, stdio: 'ignore',
      });
      return false;
    } catch {
      return true;
    }
  }
  const diff = frozenPathDiff(review, path, priorTargetSha ?? review.manifest.diffBaseSha);
  return diff.split('\n').some((line) => line.startsWith('-') && !line.startsWith('---') && line.slice(1) === evidence);
}

interface PriorReview {
  readonly findings: readonly VerifiedFinding[];
  readonly targetSha: string | null;
}

function loadPriorReview(file: string | undefined): PriorReview {
  if (file === undefined) return { findings: [], targetSha: null };
  const size = statSync(file).size;
  if (size > 8 * 1024 * 1024) throw new Error('prior consolidated review exceeds 8 MiB');
  const bytes = readFileSync(file);
  if (bytes.byteLength !== size || bytes.byteLength > 8 * 1024 * 1024) {
    throw new Error('prior consolidated review changed while bounded bytes were read');
  }
  const parsed = JSON.parse(bytes.toString('utf8')) as { schemaVersion?: unknown; findings?: unknown; frozen?: { targetSha?: unknown } };
  if (
    parsed.schemaVersion !== 2 ||
    !Array.isArray(parsed.findings) || parsed.findings.length > 10_000 ||
    typeof parsed.frozen?.targetSha !== 'string' || !/^[0-9a-f]{40}$/u.test(parsed.frozen.targetSha)
  ) {
    throw new Error('prior consolidated review has an invalid findings array');
  }
  const lenses = PERKINS_LENSES;
  const findings = parsed.findings.map((entry, index) => {
    const finding = record(entry, `prior finding ${index}`) as Partial<VerifiedFinding>;
    const verification = finding.verification as Partial<VerifiedFinding['verification']> | undefined;
    if (
      typeof finding.source !== 'string' || !lenses.includes(finding.source as typeof lenses[number]) ||
      typeof finding.severity !== 'string' || !['blocker', 'warning', 'note'].includes(finding.severity) ||
      typeof finding.category !== 'string' || typeof finding.title !== 'string' ||
      typeof finding.location !== 'string' || typeof finding.evidence !== 'string' ||
      typeof finding.detail !== 'string' || typeof finding.recommended_fix !== 'string' ||
      !Number.isSafeInteger(finding.roundOrigin) || Number(finding.roundOrigin) < 1 ||
      !Array.isArray(finding.sources) || finding.sources.length === 0 ||
      finding.sources.some((source) => typeof source !== 'string' || !lenses.includes(source as typeof lenses[number])) ||
      !Array.isArray(finding.chunks) || finding.chunks.length === 0 ||
      finding.chunks.some((chunk) => typeof chunk !== 'string' || chunk.trim() === '') ||
      verification === undefined ||
      typeof verification.disposition !== 'string' ||
      !['confirmed', 'unverifiable-speculative'].includes(verification.disposition) ||
      typeof verification.evidence !== 'string' || typeof verification.reason !== 'string'
    ) throw new Error(`prior finding ${index} failed the durable schema`);
    return finding as VerifiedFinding;
  });
  return { findings, targetSha: parsed.frozen.targetSha };
}

function renderTemplateOnce(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{(?:PROJECT_CONVENTIONS|DIFF|SPEC_CONTEXT|LENS_BRIEF|LENS)\}\}/g, (placeholder) =>
    values[placeholder] ?? placeholder,
  );
}

function renderLensPrompt(policy: PerkinsPolicy, review: FrozenReview, lens: PerkinsLens, chunk: string): string {
  const selected = review.chunks.find((candidate) => candidate.id === chunk);
  if (selected === undefined) throw new Error(`missing frozen chunk ${chunk}`);
  if (lens === 'blind') return renderTemplateOnce(policy.portableContract.blindPrompt, { '{{DIFF}}': selected.diff });
  return renderTemplateOnce(policy.portableContract.sharedPrompt, {
    '{{PROJECT_CONVENTIONS}}': review.projectConventions,
    '{{DIFF}}': selected.diff,
    '{{SPEC_CONTEXT}}': review.specContext,
    '{{LENS_BRIEF}}': policy.portableContract.lenses[lens],
    '{{LENS}}': lens,
  });
}

async function boundedPrompt(
  handle: AgentHandle,
  prompt: string,
  timeoutMs: number,
  signals: readonly (AbortSignal | undefined)[] = [],
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectAbort: ((error: Error) => void) | null = null;
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    for (const signal of signals) {
      if (signal === undefined) continue;
      if (signal.aborted) {
        reject(new Error('review operation aborted'));
        return;
      }
      const listener = () => rejectAbort?.(new Error('review operation aborted'));
      listeners.push({ signal, listener });
      signal.addEventListener('abort', listener, { once: true });
    }
  });
  try {
    await Promise.race([
      handle.prompt(prompt, { owner: REVIEW_OWNER }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`review turn timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
      abort,
    ]);
  } finally {
    rejectAbort = null;
    if (timer !== null) clearTimeout(timer);
    for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
  }
}

async function boundedSpawn(
  spawn: () => Promise<AgentHandle>,
  timeoutMs: number,
  signals: readonly (AbortSignal | undefined)[],
): Promise<AgentHandle> {
  if (signals.some((signal) => signal?.aborted === true)) throw new Error('review operation aborted');
  const spawning = spawn();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  const abort = new Promise<never>((_resolve, reject) => {
    for (const signal of signals) {
      if (signal === undefined) continue;
      if (signal.aborted) {
        reject(new Error('review operation aborted'));
        return;
      }
      const listener = () => reject(new Error('review operation aborted'));
      listeners.push({ signal, listener });
      signal.addEventListener('abort', listener, { once: true });
    }
  });
  try {
    return await Promise.race([
      spawning,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`review spawn timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
      abort,
    ]);
  } catch (error) {
    // A runtime spawn may not accept AbortSignal. If it resolves after our
    // bound, dispose it immediately so no unowned session survives.
    void spawning.then((handle) => handle.dispose()).catch(() => {});
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
  }
}

async function pool<T, U>(items: readonly T[], concurrency: number, run: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await run(items[index]!);
    }
  });
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  return results;
}

export class PerkinsHybridReview {
  private readonly spawner: AgentSpawner;
  private readonly policy: PerkinsPolicy;
  private readonly onProgress: (progress: ReviewProgress) => void;
  private readonly onAgent: NonNullable<PerkinsHybridReviewOptions['onAgent']>;

  constructor(options: PerkinsHybridReviewOptions) {
    this.spawner = options.spawner;
    this.policy = options.policy;
    this.onProgress = options.onProgress ?? (() => {});
    this.onAgent = options.onAgent ?? (() => {});
  }

  async run(input: RunPerkinsHybridInput): Promise<PerkinsHybridResult> {
    const review = input.frozenReview;
    assertFrozenPromptBounds(review);
    const lenses = input.noSpec
      ? this.policy.portableContract.rules.noSpecLenses
      : this.policy.portableContract.rules.fullLenses;
    const expected = new Set(review.chunks.flatMap((chunk) => lenses.map((lens) => `${lens}\0${chunk.id}`)));
    const priorReview = loadPriorReview(input.priorConsolidatedFile);
    const prior = priorReview.findings;
    const attempts = new Map<string, number>();
    // Host-side bounds restore attempt counters so coverage stays retryable;
    // every child run therefore writes artifacts under a unique run token so
    // a restored retry cannot collide with the write-once artifact store.
    const restoreAttempts = (scheduled: ReadonlyArray<{ key: string }> ): void => {
      for (const run of scheduled) {
        const priorAttempt = attempts.get(run.key) ?? 0;
        if (priorAttempt <= 1) attempts.delete(run.key);
        else attempts.set(run.key, (priorAttempt - 1) as 1 | 2);
      }
    };
    const validCoverage = new Set<string>();
    const results = new Map<string, ChildResult>();
    const candidates = new Map<string, ChildCandidate>();
    const envelopes: LensEnvelope[] = [];
    const leadArtifacts = new Set<string>();
    const readChunks = new Set<string>();
    const agentIds = new Set<string>();
    const sessionFiles = new Set<string>();
    let terminalAttempts = 0;
    let accepted: PerkinsHybridResult | null = null;

    const registerIsolatedHandle = (handle: AgentHandle, phase: 'lead' | 'lens'): void => {
      if (handle.reviewIsolation !== true) throw new Error(`${phase} handle is not review-isolated`);
      if (handle.id.trim() === '' || agentIds.has(handle.id)) throw new Error(`duplicate or empty review agent id: ${handle.id}`);
      if (handle.sessionFile === null || !isAbsolute(handle.sessionFile)) throw new Error(`${phase} session is not durably identified`);
      const sessionFile = resolve(handle.sessionFile);
      if (sessionFiles.has(sessionFile)) throw new Error(`duplicate review session file: ${sessionFile}`);
      agentIds.add(handle.id);
      sessionFiles.add(sessionFile);
    };

    const runChild = async (lens: PerkinsLens, chunk: string, attempt: 1 | 2, signal?: AbortSignal): Promise<ChildResult> => {
      this.onProgress({ lens, chunk, state: 'running' });
      let handle: AgentHandle | null = null;
      let raw: string | null = null;
      const runToken = randomUUID().slice(0, 8);
      try {
        handle = await boundedSpawn(() => this.spawner('perkins', {
          // The blind child is rooted OUTSIDE the repository: even a future
          // tool leak would find no repo to read. Other children read the
          // frozen tree.
          cwd: lens === 'blind' ? review.directory : review.manifest.repoPath,
          isolatedReview: {
            systemPrompt: lens === 'blind' ? BLIND_SYSTEM_PROMPT : LENS_SYSTEM_PROMPT,
            tools: lens === 'blind' ? [] : ['read', 'grep', 'find', 'ls'],
          },
        }), CHILD_SPAWN_TIMEOUT_MS, [signal, input.signal]);
        registerIsolatedHandle(handle, 'lens');
        this.onAgent({ phase: 'lens', lens, chunk, handle });
        await boundedPrompt(
          handle,
          renderLensPrompt(this.policy, review, lens, chunk),
          CHILD_TURN_TIMEOUT_MS,
          [signal, input.signal],
        );
        if (handle.sessionFile === null) throw new Error('lens child session is not durable');
        raw = finalAssistantText(handle.sessionFile);
        const parsed = parseFindings(raw, lens);
        const reviewFindings = parsed.filter((finding) =>
          !(finding.source === 'tests' && finding.category === 'coverage-gate'),
        );
        // The tests lens's validated coverage gate is host-owned evidence:
        // carried into terminal proof so a FAIL gate blocks the verdict.
        const gate = parsed.find((finding) => finding.source === 'tests' && finding.category === 'coverage-gate');
        const coverageGate = gate === undefined ? undefined : (/^Coverage gate: (PASS|CONCERNS|FAIL)$/u.exec(gate.title)?.[1] as 'PASS' | 'CONCERNS' | 'FAIL' | undefined);
        const resultId = `${lens}-${chunk}-a${attempt}-${hash(handle.id).slice(0, 16)}`;
        const childCandidates = reviewFindings.map((finding, findingIndex): ChildCandidate => ({
          ...finding,
          ref: `${resultId}#${findingIndex}`,
          chunk,
          resultId,
          findingIndex,
        }));
        const envelope: LensEnvelope = {
          schemaVersion: 1, lens, chunk, attempt, status: 'valid', outputSha256: hash(raw), findings: reviewFindings,
        };
        envelopes.push(envelope);
        writeReviewArtifact(review, `lenses/${chunk}/${lens}.attempt-${attempt}-${runToken}.raw.json`, `${raw}\n`);
        writeReviewArtifact(review, `lenses/${chunk}/${lens}.attempt-${attempt}-${runToken}.envelope.json`, envelope);
        const result: ChildResult = {
          resultId, agentId: handle.id, lens, chunk, attempt, status: 'valid', findings: childCandidates,
          ...(coverageGate !== undefined ? { coverageGate } : {}),
        };
        writeReviewArtifact(review, `children/${resultId}.json`, result);
        this.onProgress({ lens, chunk, state: 'done', note: `${reviewFindings.length} candidate(s)` });
        return result;
      } catch (error) {
        const message = sanitizeError(error);
        const envelope: LensEnvelope = {
          schemaVersion: 1, lens, chunk, attempt,
          status: raw === null ? 'failed' : 'invalid',
          outputSha256: raw === null ? null : hash(raw), findings: [], error: message,
        };
        envelopes.push(envelope);
        if (raw !== null) {
          // The try block may have already written this exact run-token path
          // before a later step threw; tolerate the collision (write-once).
          try {
            writeReviewArtifact(review, `lenses/${chunk}/${lens}.attempt-${attempt}-${runToken}.raw.json`, `${raw}\n`);
          } catch (writeError) {
            if (!(writeError instanceof Error && 'code' in writeError && (writeError as { code?: string }).code === 'EEXIST')) throw writeError;
          }
        }
        for (const [suffix, value] of [
          [`.error.json`, { error: message } as unknown],
          [`.envelope.json`, envelope as unknown],
        ] as const) {
          try {
            writeReviewArtifact(review, `lenses/${chunk}/${lens}.attempt-${attempt}-${runToken}${suffix}`, value);
          } catch (writeError) {
            if (!(writeError instanceof Error && 'code' in writeError && (writeError as { code?: string }).code === 'EEXIST')) throw writeError;
          }
        }
        this.onProgress({ lens, chunk, state: 'error', note: message });
        return {
          resultId: `failed-${lens}-${chunk}-a${attempt}`,
          agentId: handle?.id ?? 'spawn-failed', lens, chunk, attempt,
          status: raw === null ? 'failed' : 'invalid', findings: [], error: message,
        };
      } finally {
        await handle?.dispose();
      }
    };

    // Tool protocols may deliver multiple calls concurrently. Serialize the
    // scheduling mutation so attempt accounting is atomic and the child pool's
    // concurrency bound applies to the whole round, not merely one tool call.
    let runToolTail: Promise<void> = Promise.resolve();
    const serializeRunTool = <T>(operation: () => Promise<T>): Promise<T> => {
      const current = runToolTail.then(operation, operation);
      runToolTail = current.then(() => undefined, () => undefined);
      return current;
    };

    const runTool: NativeAgentTool = {
      name: 'perkins_run_lenses',
      description: `Start and await 1-${MAX_TOOL_RUNS} host-tracked lens children. Each run must name one required lens and frozen chunk. The host enforces isolation, attempts, concurrency, output validation, durability and ownership.`,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['runs'],
        properties: {
          runs: {
            type: 'array', minItems: 1, maxItems: MAX_TOOL_RUNS,
            items: {
              type: 'object', additionalProperties: false, required: ['lens', 'chunk'],
              properties: {
                lens: { type: 'string', enum: [...lenses] },
                chunk: { type: 'string', enum: review.chunks.map((chunk) => chunk.id) },
              },
            },
          },
        },
      },
      execute: (raw, signal) => serializeRunTool(async () => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        if (accepted !== null) throw new Error('review already has an accepted terminal submission');
        const value = record(raw, 'perkins_run_lenses input');
        exactKeys(value, ['runs'], 'perkins_run_lenses input');
        if (!Array.isArray(value.runs) || value.runs.length < 1 || value.runs.length > MAX_TOOL_RUNS) {
          throw new Error(`runs must contain 1-${MAX_TOOL_RUNS} entries`);
        }
        const requested = value.runs.map((entry, index) => {
          const run = record(entry, `run ${index}`);
          exactKeys(run, ['lens', 'chunk'], `run ${index}`);
          if (typeof run.lens !== 'string' || !lenses.includes(run.lens as PerkinsLens)) throw new Error(`run ${index} lens is not required`);
          if (typeof run.chunk !== 'string' || !review.chunks.some((chunk) => chunk.id === run.chunk)) throw new Error(`run ${index} chunk is unknown`);
          return { lens: run.lens as PerkinsLens, chunk: run.chunk };
        });
        const keys = requested.map((run) => `${run.lens}\0${run.chunk}`);
        if (new Set(keys).size !== keys.length) throw new Error('one tool call cannot duplicate a lens/chunk');
        const scheduled = requested.map((run, index) => {
          const key = keys[index]!;
          if (!expected.has(key)) throw new Error(`run ${index} is outside required coverage`);
          if (validCoverage.has(key)) throw new Error(`coverage ${run.lens}/${run.chunk} is already valid`);
          const priorAttempt = attempts.get(key) ?? 0;
          if (priorAttempt >= this.policy.portableContract.rules.maxLensAttempts) throw new Error(`coverage ${run.lens}/${run.chunk} exhausted its attempts`);
          return { ...run, key, attempt: (priorAttempt + 1) as 1 | 2 };
        });
        for (const run of scheduled) attempts.set(run.key, run.attempt);
        let childResults: readonly ChildResult[];
        try {
          childResults = await pool(scheduled, CHILD_CONCURRENCY, (run) => runChild(run.lens, run.chunk, run.attempt, signal));
        } catch (error) {
          restoreAttempts(scheduled);
          throw error;
        }
        if (accepted !== null) {
          restoreAttempts(scheduled);
          throw new Error('review already has an accepted terminal submission');
        }
        const payload = JSON.stringify({ results: childResults });
        const nextCandidates = childResults.flatMap((result) => result.status === 'valid' ? result.findings : []);
        try {
          if (Buffer.byteLength(payload) > MAX_TRANSPORT_CHUNK_BYTES) {
            throw new Error('lens result batch exceeds the bounded tool response');
          }
          if (candidates.size + nextCandidates.length > MAX_TOTAL_CANDIDATES) {
            throw new Error(`review exceeds ${MAX_TOTAL_CANDIDATES} candidates`);
          }
          if (nextCandidates.some((candidate) => candidates.has(candidate.ref))) {
            throw new Error('lens result batch contains a duplicate candidate reference');
          }
        } catch (error) {
          // Host-side bounds are not child-quality failures: restore the
          // attempt counters so the lens/chunk stays retryable.
          restoreAttempts(scheduled);
          throw error;
        }
        // Commit ownership/coverage only after the exact response bytes have
        // passed every host-side bound. A rejected response cannot silently
        // satisfy terminal proof.
        for (const result of childResults) {
          results.set(result.resultId, result);
          if (result.status !== 'valid') continue;
          validCoverage.add(`${result.lens}\0${result.chunk}`);
          for (const candidate of result.findings) candidates.set(candidate.ref, candidate);
        }
        return {
          text: payload,
          details: { resultCount: childResults.length, candidateCount: nextCandidates.length },
        };
      }),
    };

    const artifactTool: NativeAgentTool = {
      name: 'perkins_store_artifact',
      description: 'Store a bounded lead-authored investigation note under this round. It cannot write the repository or historical review artifacts.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['name', 'content'],
        properties: {
          name: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\\.(md|json)$' },
          content: { type: 'string', minLength: 1, maxLength: MAX_LEAD_ARTIFACT_BYTES },
        },
      },
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        const value = record(raw, 'perkins_store_artifact input');
        exactKeys(value, ['name', 'content'], 'perkins_store_artifact input');
        const name = boundedString(value.name, 'artifact name', 86);
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:md|json)$/.test(name)) throw new Error('artifact name is invalid');
        const content = boundedString(value.content, 'artifact content', MAX_LEAD_ARTIFACT_BYTES);
        if (leadArtifacts.size >= MAX_LEAD_ARTIFACTS || leadArtifacts.has(name)) throw new Error('lead artifact limit or duplicate reached');
        const file = writeReviewArtifact(review, `lead/notes/${name}`, content);
        leadArtifacts.add(name);
        return { text: JSON.stringify({ stored: name, sha256: hash(content) }), details: { file, sha256: hash(content) } };
      },
    };

    const chunkTool: NativeAgentTool = {
      name: 'perkins_read_chunk',
      description: 'Read one frozen diff chunk (id, files, line count, full diff bytes) from this round. Read-only.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['chunk'],
        properties: { chunk: { type: 'string', enum: review.chunks.map((chunk) => chunk.id) } },
      },
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        const value = record(raw, 'perkins_read_chunk input');
        exactKeys(value, ['chunk'], 'perkins_read_chunk input');
        const selected = review.chunks.find((chunk) => chunk.id === value.chunk);
        if (selected === undefined) throw new Error('unknown frozen chunk');
        const payload = JSON.stringify(selected);
        if (Buffer.byteLength(payload) > MAX_TRANSPORT_CHUNK_BYTES) throw new Error('frozen chunk exceeds the bounded tool response');
        readChunks.add(selected.id);
        return { text: payload, details: { id: selected.id } };
      },
    };

    const submitTool: NativeAgentTool = {
      name: 'perkins_submit_review',
      description: 'Submit the lead-authored terminal proof and report. The host rejects missing coverage, foreign/missing candidates, unsupported verification, incomplete prior audits, changed HEAD, or incorrect verdict arithmetic.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: ['canonical_verdict', 'candidate_decisions', 'prior_audit', 'report_markdown'],
        properties: {
          canonical_verdict: { type: 'string', enum: ['READY TO MERGE', 'NEEDS CHANGES', 'MAJOR REWORK NEEDED', 'INCOMPLETE'] },
          candidate_decisions: { type: 'array', maxItems: MAX_TOTAL_CANDIDATES, items: { type: 'object' } },
          prior_audit: { type: 'array', maxItems: 10_000, items: { type: 'object' } },
          report_markdown: { type: 'string', minLength: 1, maxLength: PERKINS_REPORT_MAX_BYTES },
        },
      },
      execute: async (raw, signal) => {
        if (input.signal?.aborted === true || signal?.aborted === true) throw new Error('review operation aborted');
        terminalAttempts += 1;
        if (terminalAttempts > MAX_TERMINAL_ATTEMPTS) throw new Error('terminal submission attempts exhausted');
        try {
          if (accepted !== null) throw new Error('review already has an accepted terminal submission');
          const submission = this.parseSubmission(raw, candidates.size, prior.length);
          writeReviewArtifact(review, `lead/submission-attempt-${terminalAttempts}.json`, submission);
          const missingChunks = review.chunks.filter((chunk) => !readChunks.has(chunk.id)).map((chunk) => chunk.id);
          if (missingChunks.length > 0) throw new Error(`lead has not read every frozen chunk (${missingChunks.join(', ')})`);
          const missingCoverage = [...expected].filter((key) => !validCoverage.has(key));
          if (missingCoverage.length > 0) throw new Error(`required lens/chunk coverage is missing (${missingCoverage.length} run(s))`);
          if (submission.candidate_decisions.length !== candidates.size) throw new Error('terminal submission must decide every child candidate exactly once');
          const decisionRefs = new Set(submission.candidate_decisions.map((decision) => decision.candidate_ref));
          if (decisionRefs.size !== candidates.size || [...decisionRefs].some((ref) => !candidates.has(ref))) {
            throw new Error('terminal submission contains missing, duplicate, or unowned candidate references');
          }
          const findings: VerifiedFinding[] = [];
          let confirmed = 0;
          let rejected = 0;
          let speculative = 0;
          // Carried prior findings enter first so a fresh rediscovery of the
          // same issue merges INTO the original round marker, never replaces it.
          const priorAudit = this.validatePriorAudit(
            review,
            prior,
            submission.prior_audit,
            priorReview.targetSha,
          );
          for (const audit of priorAudit) {
            if (audit.status !== 'still-present') continue;
            const carried = prior[audit.prior_index]!;
            findings.push({
              ...carried,
              evidence: audit.evidence,
              verification: {
                disposition: carried.verification.disposition,
                evidence: audit.evidence,
                reason: audit.reason,
              },
            });
          }
          for (const decision of submission.candidate_decisions) {
            const candidate = candidates.get(decision.candidate_ref)!;
            if (decision.disposition === 'rejected') {
              const anchored = findingPath(candidate) !== null && candidate.location !== 'N/A';
              const located = anchored
                ? evidenceAtCitedLocation(review, candidate, decision.evidence)
                : evidenceAnywhere(review, decision.evidence);
              if (!located || decision.evidence === candidate.evidence) {
                throw new Error(`rejected candidate lacks contradictory frozen evidence at its cited location: ${candidate.ref}`);
              }
              rejected += 1;
              continue;
            }
            const forcedSpeculative = candidate.location === 'N/A' || candidate.evidence === 'N/A' || findingPath(candidate) === null;
            if (!forcedSpeculative && decision.disposition === 'unverifiable-speculative') {
              throw new Error(`anchored candidate must be confirmed or rejected: ${candidate.ref}`);
            }
            const disposition = forcedSpeculative ? 'unverifiable-speculative' : decision.disposition;
            if (disposition === 'confirmed') {
              if (!evidenceAtCitedLocation(review, candidate, candidate.evidence)) {
                throw new Error(`candidate evidence is not locatable at its cited file/hunk: ${candidate.ref}`);
              }
              if (!evidenceAnywhere(review, decision.evidence)) {
                throw new Error(`lead verification evidence is not locatable in the frozen review: ${candidate.ref}`);
              }
              confirmed += 1;
            } else {
              speculative += 1;
            }
            findings.push({
              source: candidate.source,
              severity: disposition === 'unverifiable-speculative' && candidate.severity === 'blocker' ? 'warning' : candidate.severity,
              category: candidate.category,
              title: candidate.title,
              location: candidate.location,
              evidence: candidate.evidence,
              detail: candidate.detail,
              recommended_fix: candidate.recommended_fix,
              verification: { disposition, evidence: decision.evidence, reason: decision.reason },
              chunks: [candidate.chunk],
              sources: [candidate.source],
              roundOrigin: input.roundNumber,
            });
          }
          const deduped = [...dedupeVerifiedFindings(findings)];
          // Host-carried coverage gates: a FAIL coverage gate is a confirmed
          // blocker owned by the host, not by lead discretion.
          for (const result of results.values()) {
            if (result.status === 'valid' && result.coverageGate === 'FAIL') {
              deduped.push({
                source: 'tests',
                severity: 'blocker',
                category: 'coverage-gate',
                title: 'Coverage gate: FAIL',
                location: `chunk ${result.chunk}`,
                evidence: 'Coverage gate: FAIL',
                detail: 'The tests lens reported a failing coverage gate; the review cannot be complete.',
                recommended_fix: 'Restore the coverage the tests lens requires, then rerun the review.',
                verification: { disposition: 'confirmed', evidence: 'Coverage gate: FAIL', reason: 'host-carried coverage gate reported FAIL' },
                chunks: [result.chunk],
                sources: ['tests'],
                roundOrigin: input.roundNumber,
              });
            }
          }
          const finalFindings = dedupeVerifiedFindings(deduped);
          // A moved source ref never retargets this frozen review, but it also
          // cannot authorize the now-different head. The lead may correct an
          // initial conclusive proposal to INCOMPLETE on its second terminal
          // attempt; only that fail-closed submission can be accepted.
          const headMoved = headMovedSinceFreeze(review, input.movementRef);
          const completeness: ReviewCompleteness = {
            complete: !headMoved,
            requiredLensRuns: expected.size,
            validLensRuns: validCoverage.size,
            failedRuns: [],
            verificationComplete: true,
          };
          const canonicalVerdict = verdictForFindings(finalFindings, completeness);
          if (submission.canonical_verdict !== canonicalVerdict) {
            throw new Error(`proposed verdict ${submission.canonical_verdict} conflicts with canonical ${canonicalVerdict}`);
          }
          if (!submission.report_markdown.includes(`**Verdict: ${canonicalVerdict}**`)) throw new Error('lead report does not state the canonical verdict');
          if (!submission.report_markdown.includes(review.manifest.targetSha) || !submission.report_markdown.includes(review.manifest.diffBaseSha)) {
            throw new Error('lead report omits the frozen target/base identity');
          }
          for (const lens of lenses) {
            if (!submission.report_markdown.includes(lens)) throw new Error(`lead report omits required lens coverage: ${lens}`);
          }
          for (const finding of finalFindings) {
            // Host-carried coverage gates are host evidence, not lead-authored
            // report content (the lead never receives the gate finding).
            if (finding.category === 'coverage-gate' && finding.verification.reason.startsWith('host-carried')) continue;
            // Verbatim proof is anchored: the full evidence must appear, or —
            // for evidence longer than 200 bytes — its exact 200-byte prefix.
            // This keeps a 200-candidate report inside the bounded envelope.
            const evidencePrefix = Buffer.byteLength(finding.evidence, 'utf8') > 200 ? bytePrefix(finding.evidence, 200) : finding.evidence;
            for (const required of [finding.title, finding.severity, finding.location, evidencePrefix, finding.recommended_fix]) {
              if (!submission.report_markdown.includes(required)) throw new Error(`lead report omits required finding proof: ${finding.title}`);
            }
          }
          for (const audit of priorAudit) {
            // Same byte-anchored proof as findings: full evidence, or its
            // exact 200-byte prefix for long evidence (bounded report).
            const auditPrefix = Buffer.byteLength(audit.evidence, 'utf8') > 200 ? bytePrefix(audit.evidence, 200) : audit.evidence;
            if (!submission.report_markdown.includes(audit.status) || !submission.report_markdown.includes(auditPrefix)) {
              throw new Error(`lead report omits prior audit proof: ${audit.prior_index}`);
            }
          }
          const reportFile = writeReviewArtifact(review, 'perkins-report.md', submission.report_markdown.endsWith('\n') ? submission.report_markdown : `${submission.report_markdown}\n`);
          const verificationSummary: VerificationSummary = {
            candidates: candidates.size,
            confirmed,
            rejected,
            unverified: speculative,
            speculative,
            deduplicated: finalFindings.length,
          };
          writeReviewArtifact(review, 'consolidated.json', {
            schemaVersion: 2,
            architecture: 'perkins-hybrid',
            canonicalVerdict,
            completeness,
            headMoved,
            findings: finalFindings,
            priorAudit,
            verificationSummary,
            frozen: review.manifest,
            childResults: [...results.values()].map((result) => ({
              resultId: result.resultId, agentId: result.agentId, lens: result.lens,
              chunk: result.chunk, attempt: result.attempt, status: result.status,
            })),
          });
          accepted = {
            canonicalVerdict, findings: finalFindings, completeness,
            artifactDirectory: review.directory, reportFile,
            targetSha: review.manifest.targetSha, diffBaseSha: review.manifest.diffBaseSha,
            headMoved, lensEnvelopes: [...envelopes], priorAudit, verificationSummary,
          };
          return {
            text: JSON.stringify({ accepted: true, canonicalVerdict, findingCount: finalFindings.length }),
            details: { accepted: true, canonicalVerdict, findingCount: finalFindings.length }, terminate: true,
          };
        } catch (error) {
          writeReviewArtifact(review, `lead/submission-attempt-${terminalAttempts}.error.json`, { error: sanitizeError(error) });
          throw error;
        }
      },
    };

    const systemPrompt = [
      this.policy.portableContract.leadWorkflow,
      '',
      '--- PRODUCT-NATIVE TOOL CONTRACT ---',
      'Use perkins_read_chunk to read frozen diff chunks; use perkins_run_lenses to start and receive tracked lens children; use perkins_store_artifact only for optional lead notes; finish by calling perkins_submit_review.',
      'Lens children never inherit these tools. You, the lead, must independently inspect and decide every returned candidate. Do not write implementation files.',
    ].join('\n');
    const initialPrompt = this.leadPrompt(review, lenses, prior);
    let lead: AgentHandle | null = null;
    let unsubscribe = (): void => {};
    let turns = 0;
    try {
      lead = await boundedSpawn(() => this.spawner('perkins', {
        cwd: review.manifest.repoPath,
        reviewLead: {
          systemPrompt,
          tools: ['read', 'grep', 'find', 'ls'],
          nativeTools: [chunkTool, runTool, artifactTool, submitTool],
        },
      }), LEAD_SPAWN_TIMEOUT_MS, [input.signal]);
      registerIsolatedHandle(lead, 'lead');
      this.onAgent({ phase: 'lead', handle: lead });
      unsubscribe = lead.subscribe((event) => {
        if (event.type === 'turn_end') {
          turns += 1;
          if (turns > MAX_LEAD_TURNS) void lead?.dispose();
        }
      });
      await boundedPrompt(lead, initialPrompt, LEAD_TOTAL_TIMEOUT_MS, [input.signal]);
      if (input.signal?.aborted === true) throw new Error('review operation aborted');
      if (turns > MAX_LEAD_TURNS) throw new Error(`Perkins lead exceeded ${MAX_LEAD_TURNS} turns`);
      if (accepted === null) throw new Error('Perkins lead exited without an accepted terminal submission');
      writeReviewArtifact(review, 'lead/receipt.json', {
        schemaVersion: 1,
        leadAgentId: lead.id,
        leadSessionFile: lead.sessionFile,
        turns,
        nativeTools: [chunkTool.name, runTool.name, artifactTool.name, submitTool.name],
      });
      return accepted;
    } finally {
      unsubscribe();
      await lead?.dispose();
    }
  }

  private parseSubmission(value: unknown, candidateCount: number, priorCount: number): LeadSubmission {
    const input = record(value, 'terminal submission');
    exactKeys(input, ['canonical_verdict', 'candidate_decisions', 'prior_audit', 'report_markdown'], 'terminal submission');
    if (
      typeof input.canonical_verdict !== 'string' ||
      !['READY TO MERGE', 'NEEDS CHANGES', 'MAJOR REWORK NEEDED', 'INCOMPLETE'].includes(input.canonical_verdict)
    ) {
      throw new Error('terminal canonical_verdict is invalid');
    }
    if (!Array.isArray(input.candidate_decisions) || input.candidate_decisions.length > Math.max(candidateCount, MAX_TOTAL_CANDIDATES)) throw new Error('candidate_decisions is invalid');
    const candidateDecisions = input.candidate_decisions.map((entry, index): CandidateDecision => {
      const decision = record(entry, `candidate decision ${index}`);
      exactKeys(decision, ['candidate_ref', 'disposition', 'evidence', 'reason'], `candidate decision ${index}`);
      if (
        typeof decision.disposition !== 'string' ||
        !['confirmed', 'rejected', 'unverifiable-speculative'].includes(decision.disposition)
      ) throw new Error(`candidate decision ${index} disposition is invalid`);
      return {
        candidate_ref: boundedString(decision.candidate_ref, `candidate decision ${index} ref`, 240),
        disposition: decision.disposition as VerificationDisposition,
        evidence: boundedString(decision.evidence, `candidate decision ${index} evidence`, 4_000),
        reason: boundedString(decision.reason, `candidate decision ${index} reason`, 1_000),
      };
    });
    if (!Array.isArray(input.prior_audit) || input.prior_audit.length > Math.max(priorCount, 10_000)) throw new Error('prior_audit is invalid');
    const priorAudit = input.prior_audit.map((entry, index): FixAuditResult => {
      const audit = record(entry, `prior audit ${index}`);
      exactKeys(audit, ['prior_index', 'status', 'evidence', 'reason'], `prior audit ${index}`);
      if (!Number.isSafeInteger(audit.prior_index) || Number(audit.prior_index) < 0 || Number(audit.prior_index) >= priorCount) throw new Error(`prior audit ${index} index is invalid`);
      if (typeof audit.status !== 'string' || !['fixed', 'still-present'].includes(audit.status)) {
        throw new Error(`prior audit ${index} status is invalid`);
      }
      return {
        prior_index: Number(audit.prior_index),
        status: audit.status as FixAuditResult['status'],
        evidence: boundedString(audit.evidence, `prior audit ${index} evidence`, 4_000),
        reason: boundedString(audit.reason, `prior audit ${index} reason`, 1_000),
      };
    });
    return {
      canonical_verdict: input.canonical_verdict as CanonicalReviewVerdict,
      candidate_decisions: candidateDecisions,
      prior_audit: priorAudit,
      report_markdown: boundedString(input.report_markdown, 'report_markdown', PERKINS_REPORT_MAX_BYTES),
    };
  }

  private validatePriorAudit(
    review: FrozenReview,
    prior: readonly VerifiedFinding[],
    audit: readonly FixAuditResult[],
    priorTargetSha: string | null,
  ): readonly FixAuditResult[] {
    if (audit.length !== prior.length || new Set(audit.map((entry) => entry.prior_index)).size !== prior.length) {
      throw new Error('prior audit must contain every prior finding exactly once');
    }
    const ordered = [...audit].sort((left, right) => left.prior_index - right.prior_index);
    for (const entry of ordered) {
      const finding = prior[entry.prior_index]!;
      const speculativeNa = finding.verification.disposition === 'unverifiable-speculative' && entry.evidence === 'N/A';
      const path = findingPath(finding);
      const located = speculativeNa || (
        path !== null && (
          entry.status === 'still-present'
            ? frozenBlobContains(review, path, entry.evidence)
            : fixedAuditEvidence(review, finding, entry.evidence, priorTargetSha)
        )
      );
      if (!located) {
        throw new Error(`prior audit ${entry.prior_index} evidence is not locatable at the finding's cited frozen file/hunk`);
      }
    }
    return ordered;
  }

  private leadPrompt(review: FrozenReview, lenses: readonly PerkinsLens[], prior: readonly VerifiedFinding[]): string {
    const coverage = review.chunks.flatMap((chunk) => lenses.map((lens) => ({ lens, chunk: chunk.id, files: chunk.files })));
    return [
      'Conduct the complete Perkins review as the lead. You own scheduling, investigation, candidate verification, prior-finding audit, synthesis and report authorship. The host owns safety and terminal proof validation.',
      '',
      `Frozen target SHA: ${review.manifest.targetSha}`,
      `Frozen diff base SHA: ${review.manifest.diffBaseSha}`,
      `Spec mode: ${review.manifest.specMode}`,
      '',
      '--- FROZEN SPECIFICATION / CONTEXT ---',
      review.specContext,
      '',
      '--- FROZEN PROJECT CONVENTIONS ---',
      review.projectConventions,
      '',
      '--- REQUIRED CHILD COVERAGE ---',
      JSON.stringify(coverage, null, 2),
      '',
      '--- PRIOR VERIFIED FINDINGS TO AUDIT ---',
      JSON.stringify(prior.map((finding, prior_index) => ({ prior_index, ...finding })), null, 2),
      '',
      'Call perkins_run_lenses until every required lens/chunk has a valid owned result. Read any frozen chunk with perkins_read_chunk. Inspect the returned candidates against the frozen tree. Submit one candidate_decisions entry for every candidate ref and one prior_audit entry for every prior_index.',
      'A rejected candidate still requires a concise reason. confirmed evidence must be one contiguous verbatim current-tree substring. N/A claims are speculative and cannot remain blockers.',
      'Write a complete Markdown report containing `**Verdict: ...**` and every retained finding title, then call perkins_submit_review. Never claim completion from missing/failed runs.',
    ].join('\n');
  }
}
