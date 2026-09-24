import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentSpawner } from '../../src/dispatch/service.js';
import type {
  AgentCapabilities,
  AgentHandle,
  NativeAgentTool,
  RuntimeEventListener,
  SpawnOptions,
} from '../../src/runtime/types.js';

/**
 * Offline Perkins-hybrid double: one scripted LEAD that actually drives the
 * product-native tools (chunk read, run lenses, artifacts, submit), plus
 * lens CHILDREN that answer from a scripted per-prompt responder. The lead
 * brain mirrors the canonical decision math so submissions exercise the
 * REAL host validator — nothing is forged around it.
 */

const CAPS: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: true,
  thinkingLevelControl: true,
  followUp: true,
};

export interface HybridSpawnCall {
  readonly options: SpawnOptions;
  readonly agentId: string;
  readonly sessionFile: string;
  prompt?: string;
  disposed?: boolean;
}

export interface LeadDecision {
  readonly disposition: 'confirmed' | 'rejected' | 'unverifiable-speculative';
  readonly evidence: string;
  readonly reason: string;
}

/** The exact payload the scripted lead sends to preflight/submit. */
export interface HybridSubmission {
  readonly canonical_verdict: string;
  readonly candidate_decisions: ReadonlyArray<{
    readonly candidate_ref: string;
    readonly disposition: 'confirmed' | 'rejected' | 'unverifiable-speculative';
    readonly evidence: string;
    readonly reason: string;
  }>;
  readonly prior_audit: ReadonlyArray<{
    readonly prior_index: number;
    readonly status: 'fixed' | 'still-present';
    readonly evidence: string;
    readonly reason: string;
    readonly fix_location?: { readonly path: string; readonly change: 'added' | 'removed' };
  }>;
  readonly report_markdown: string;
}

export interface HybridPreflightOptions {
  /** Preflight calls issued before the real submission (default 1). */
  readonly calls?: number;
  /** Applied to the preflight payload only; the real submission is untouched. */
  readonly mutate?: (submission: HybridSubmission) => HybridSubmission;
  /** Build the exact preflight payload (defaults to the full submission). */
  readonly payload?: (submission: HybridSubmission) => unknown;
  /** Real-submission attempt the preflight calls precede (1-based, default 1). */
  readonly beforeAttempt?: number;
  /** Skip the real submission after preflight (proves preflight accepts nothing). */
  readonly withhold?: boolean;
}

export interface HybridPreflightResult {
  readonly text: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly terminate?: boolean;
}

export interface HybridRecordResult {
  readonly text: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Scripted per-candidate record calls through perkins_record_decision. */
export interface HybridRecordOptions {
  /** Candidate indexes to record (default: every candidate). */
  readonly only?: readonly number[];
  /** Decision override for the record call (default: the submission's decision). */
  readonly decide?: (candidate: ChildCandidateView, index: number) => LeadDecision;
}

interface ChildCandidateView {
  readonly ref: string;
  readonly source: string;
  readonly severity: 'blocker' | 'warning' | 'note';
  readonly title: string;
  readonly location: string;
  readonly evidence: string;
  readonly recommended_fix: string;
}

interface ChildResultView {
  readonly resultId: string;
  readonly lens: string;
  readonly chunk: string;
  readonly attempt: number;
  readonly status: 'valid' | 'invalid' | 'failed';
  readonly findings: readonly ChildCandidateView[];
}

export interface LeadBrainOptions {
  readonly childAnswer: (prompt: string, call: HybridSpawnCall) => string | Promise<string>;
  /**
   * Simulate a native-tool child runtime (pi): the spawned handle declares
   * the requested perkins_submit_findings tool and, with 'tool', every
   * valid bare JSON array the child answers with is delivered through that
   * tool instead of assistant text. 'text-only' declares the tool but never
   * calls it (proves no silent text fallback). Absent = text-path runtime.
   */
  readonly childNativeTools?: 'tool' | 'text-only';
  readonly decide?: (candidate: ChildCandidateView) => LeadDecision;
  readonly priorAudit?: (
    prior: readonly unknown[],
  ) => ReadonlyArray<{ prior_index: number; status: 'fixed' | 'still-present'; evidence: string; reason: string; fix_location?: { path: string; change: 'added' | 'removed' } }>;
  readonly skipLenses?: readonly string[];
  readonly verdictOverride?: string;
  readonly foreignCandidate?: boolean;
  readonly dropCandidate?: boolean;
  readonly omitTitle?: string;
  readonly neverSubmit?: boolean;
  readonly readChunks?: boolean;
  readonly storeArtifact?: { readonly name: string; readonly content: string };
  readonly duplicateArtifact?: boolean;
  readonly badRuns?: ReadonlyArray<{ lens: string; chunk: string }>;
  readonly duplicateRun?: boolean;
  readonly beforeSubmit?: () => void;
  readonly onLeadStart?: () => void;
  readonly onPriorDelta?: (list: unknown, selected: unknown, prompt: string) => void | Promise<void>;
  readonly transformReport?: (report: string) => string;
  /** Validate the exact submission through the preflight channel first. */
  readonly preflight?: HybridPreflightOptions;
  /** Validate each decision through perkins_record_decision before submitting. */
  readonly recordDecisions?: HybridRecordOptions;
  /** Extra real-submission attempts after a rejection (default 1 retry). */
  readonly submitRetries?: number;
  /** Build the exact real-submission payload per attempt (1-based); default: the full submission. */
  readonly submitPayload?: (attempt: number, submission: HybridSubmission, candidates: readonly ChildCandidateView[]) => unknown;
}

const SEVERITY_RANK: Record<string, number> = { blocker: 3, warning: 2, note: 1 };

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Lens id from either child prompt shape: the text envelope ("source") or
 * the native-tool contract (lens id line). */
function lensFromPrompt(prompt: string): string | null {
  return /"source": "(blind|edge|acceptance|security|architecture|codebase|tests)"/u.exec(prompt)?.[1] ??
    /Your lens id is "(blind|edge|acceptance|security|architecture|codebase|tests)"/u.exec(prompt)?.[1] ??
    null;
}

function extractJsonArray(prompt: string, header: string): string {
  const start = prompt.indexOf(header);
  if (start === -1) throw new Error(`hybrid double could not find prompt section: ${header}`);
  const open = prompt.indexOf('[', start + header.length);
  if (open === -1) throw new Error(`hybrid double could not find the JSON array after: ${header}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < prompt.length; index += 1) {
    const character = prompt[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return prompt.slice(open, index + 1);
    }
  }
  throw new Error(`hybrid double could not find the closing bracket after: ${header}`);
}

function brainVerdict(retained: readonly { severity: string }[]): string {
  const blockers = retained.filter((finding) => finding.severity === 'blocker').length;
  if (blockers === 0) return 'READY TO MERGE';
  if (blockers <= 3) return 'NEEDS CHANGES';
  return 'MAJOR REWORK NEEDED';
}

export function fakeHybridSpawner(
  sessionsRoot: string,
  options: LeadBrainOptions,
): {
  readonly spawner: AgentSpawner;
  readonly calls: HybridSpawnCall[];
  readonly leadCalls: HybridSpawnCall[];
  readonly childCalls: HybridSpawnCall[];
  readonly toolErrors: ReadonlyArray<{ tool: string; error: string }>;
  readonly preflightResults: ReadonlyArray<HybridPreflightResult>;
  readonly recordResults: ReadonlyArray<HybridRecordResult>;
} {
  const calls: HybridSpawnCall[] = [];
  const leadCalls: HybridSpawnCall[] = [];
  const childCalls: HybridSpawnCall[] = [];
  const toolErrors: { tool: string; error: string }[] = [];
  const preflightResults: HybridPreflightResult[] = [];
  const recordResults: HybridRecordResult[] = [];
  let next = 0;

  let ownGateFail = false;
  const runLead = async (call: HybridSpawnCall, prompt: string, tools: readonly NativeAgentTool[]): Promise<string> => {
    ownGateFail = false; // never carry a FAIL gate across lead runs
    options.onLeadStart?.();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const runTool = byName.get('perkins_run_lenses')!;
    const chunkTool = byName.get('perkins_read_chunk')!;
    const priorDeltaTool = byName.get('perkins_read_prior_delta');
    const artifactTool = byName.get('perkins_store_artifact')!;
    const preflightTool = byName.get('perkins_preflight_submission');
    const recordTool = byName.get('perkins_record_decision');
    const submitTool = byName.get('perkins_submit_review')!;

    const coverage = JSON.parse(extractJsonArray(prompt, '--- REQUIRED CHILD COVERAGE ---')) as
      Array<{ lens: string; chunk: string }>;
    const prior = JSON.parse(extractJsonArray(prompt, '--- PRIOR VERIFIED FINDINGS TO AUDIT ---')) as unknown[];
    if (options.onPriorDelta !== undefined) {
      if (priorDeltaTool === undefined) throw new Error('rereview lead needs perkins_read_prior_delta');
      const list = JSON.parse((await priorDeltaTool.execute({})).text) as unknown;
      const selected = JSON.parse((await priorDeltaTool.execute({ path: 'src/caller.ts' })).text) as unknown;
      await options.onPriorDelta(list, selected, prompt);
    }

    if (options.readChunks !== false) {
      for (const chunk of new Set(coverage.map((entry) => entry.chunk))) {
        await chunkTool.execute({ chunk });
      }
    }
    if (options.storeArtifact !== undefined) {
      await artifactTool.execute(options.storeArtifact);
      if (options.duplicateArtifact === true) await artifactTool.execute(options.storeArtifact);
    }

    const candidates: ChildCandidateView[] = [];
    const required = coverage.filter((entry) => !(options.skipLenses ?? []).includes(entry.lens));
    const worklist = required.map((entry) => ({ lens: entry.lens, chunk: entry.chunk }));
    const retried = new Set<string>();
    let first = true;

    while (worklist.length > 0) {
      const batch = worklist.splice(0, 4);
      let runs: Array<{ lens: string; chunk: string }>;
      if (first && options.badRuns !== undefined) {
        runs = [...options.badRuns];
        // Requeue exactly the batch entries the override did not name.
        const overridden = new Set(runs.map((run) => `${run.lens}\0${run.chunk}`));
        worklist.unshift(...batch.filter((entry) => !overridden.has(`${entry.lens}\0${entry.chunk}`)));
      } else if (first && options.duplicateRun === true) {
        runs = [batch[0]!, batch[0]!];
        worklist.unshift(...batch.slice(1));
      } else runs = batch;
      first = false;
      try {
        const response = JSON.parse((await runTool.execute({ runs })).text) as { results: ChildResultView[] };
        for (const result of response.results) {
          const key = `${result.lens}\0${result.chunk}`;
          if (result.status === 'valid') {
            candidates.push(...result.findings);
          } else if (!retried.has(key)) {
            retried.add(key);
            worklist.push({ lens: result.lens, chunk: result.chunk });
          }
        }
      } catch (error) {
        toolErrors.push({ tool: 'perkins_run_lenses', error: String(error) });
        throw error;
      }
    }

    if (options.neverSubmit === true) return 'lead gave up without submitting';

    const decisions = candidates.flatMap((candidate, index) => {
      if (options.dropCandidate === true && index === 0) return [];
      const decision = options.decide?.(candidate) ?? {
        disposition: 'confirmed' as const,
        evidence: 'export function answer(): number {',
        reason: 'lead read the frozen tree and confirmed the exact evidence',
      };
      return [{ candidate_ref: candidate.ref, ...decision }];
    });
    if (options.foreignCandidate === true) {
      decisions.push({
        candidate_ref: 'foreign-lead-forged#0',
        disposition: 'confirmed',
        evidence: 'export function answer(): number {',
        reason: 'forged unowned candidate',
      } as { candidate_ref: string; disposition: 'confirmed'; evidence: string; reason: string });
    }

    const priorAudit = options.priorAudit?.(prior) ??
      prior.map((entry, index) => {
        const finding = entry as { evidence: string; title: string };
        return {
          prior_index: index,
          status: 'still-present' as const,
          evidence: finding.evidence,
          reason: `prior finding remains: ${finding.title}`,
        };
      });

    const retained: Array<{ severity: string; title: string; location: string }> = [];
    for (let index = 0; index < decisions.length; index += 1) {
      const decision = decisions[index]!;
      if (decision.disposition === 'rejected') continue;
      const candidate = candidates.find((entry) => entry.ref === decision.candidate_ref);
      if (candidate === undefined) continue;
      const speculative = candidate.location === 'N/A' || candidate.evidence === 'N/A';
      retained.push({
        severity: speculative && candidate.severity === 'blocker' ? 'warning' : candidate.severity,
        title: candidate.title,
        location: candidate.location,
      });
    }
    for (const audit of priorAudit) {
      if (audit.status !== 'still-present') continue;
      const finding = prior[audit.prior_index] as { severity: string; title: string; location: string };
      retained.push({ severity: finding.severity, title: finding.title, location: finding.location });
    }
    // The host turns a FAIL coverage gate into a host-owned blocker; mirror
    // that in the scripted lead's verdict arithmetic.
    if (ownGateFail) retained.push({ severity: 'blocker', title: 'Coverage gate: FAIL', location: 'N/A' });
    const deduped = new Map<string, { severity: string; title: string; location: string }>();
    for (const finding of retained) {
      const key = `${normalize(finding.title)}\0${normalize(finding.location)}`;
      const existing = deduped.get(key);
      if (existing === undefined || SEVERITY_RANK[finding.severity]! > SEVERITY_RANK[existing.severity]!) {
        deduped.set(key, finding);
      }
    }
    const finalFindings = [...deduped.values()];
    const verdict = options.verdictOverride ?? brainVerdict(finalFindings);
    const targetSha = /^Frozen target SHA: (.+)$/m.exec(prompt)?.[1] ?? 'missing-target';
    const baseSha = /^Frozen diff base SHA: (.+)$/m.exec(prompt)?.[1] ?? 'missing-base';
    const reportCandidates = candidates.filter((finding) => finding.title !== options.omitTitle);
    const baseReport = [
      '# Perkins Code Review',
      '',
      `**Verdict: ${verdict}**`,
      '',
      `Frozen target: ${targetSha}`,
      `Frozen base: ${baseSha}`,
      `Coverage: ${[...new Set(coverage.map((entry) => entry.lens))].join(', ')}`,
      '',
      '## Finding proof',
      JSON.stringify({
        retained: finalFindings.filter((finding) => finding.title !== options.omitTitle),
        candidates: reportCandidates,
      }, null, 2),
      '',
      '## Prior audit proof',
      JSON.stringify({ prior, priorAudit }, null, 2),
      '',
    ].join('\n');
    const report = options.transformReport?.(baseReport) ?? baseReport;

    options.beforeSubmit?.();
    const submission: HybridSubmission = {
      canonical_verdict: verdict,
      candidate_decisions: decisions,
      prior_audit: priorAudit,
      report_markdown: report,
    };
    if (options.recordDecisions !== undefined) {
      if (recordTool === undefined) throw new Error('hybrid double expected the perkins_record_decision tool');
      for (const [index, candidate] of candidates.entries()) {
        if (options.recordDecisions.only !== undefined && !options.recordDecisions.only.includes(index)) continue;
        const decision = options.recordDecisions.decide?.(candidate, index)
          ?? decisions.find((entry) => entry.candidate_ref === candidate.ref);
        if (decision === undefined) continue;
        const result = await recordTool.execute({ candidate_ref: candidate.ref, ...decision });
        recordResults.push({ text: result.text, details: result.details });
      }
    }
    if (options.preflight !== undefined && (options.preflight.beforeAttempt ?? 1) < 1) {
      throw new Error('hybrid double preflight.beforeAttempt must be >= 1');
    }
    const preflightBefore = options.preflight?.beforeAttempt ?? 1;
    const attempts = 1 + Math.max(options.submitRetries ?? 1, 0);
    let lastError: unknown;
    for (let index = 0; index < attempts; index += 1) {
      const attempt = index + 1;
      if (options.preflight !== undefined && attempt === preflightBefore) {
        if (preflightTool === undefined) throw new Error('hybrid double expected the perkins_preflight_submission tool');
        const preflightCalls = options.preflight.calls ?? 1;
        for (let call = 0; call < preflightCalls; call += 1) {
          const payload = options.preflight.payload !== undefined
            ? options.preflight.payload(submission)
            : (options.preflight.mutate?.(submission) ?? submission);
          const result = await preflightTool.execute(payload as Record<string, unknown>);
          preflightResults.push({ text: result.text, details: result.details, terminate: result.terminate });
        }
        if (options.preflight.withhold === true) return 'lead preflighted and withheld the real submission';
      }
      const payload = options.submitPayload?.(attempt, submission, candidates) ?? submission;
      try {
        return (await submitTool.execute(payload as Record<string, unknown>)).text;
      } catch (error) {
        lastError = error;
        toolErrors.push({ tool: 'perkins_submit_review', error: String(error) });
      }
    }
    throw lastError;
  };

  const spawner: AgentSpawner = async (_role, spawnOptions = {}) => {
    const index = next++;
    const file = join(sessionsRoot, `session-${index}.jsonl`);
    writeFileSync(file, '', 'utf8');
    const isLead = spawnOptions.reviewLead !== undefined;
    const agentId = `${isLead ? 'lead' : 'child'}-${index}`;
    const call: HybridSpawnCall = { options: spawnOptions, agentId, sessionFile: file };
    calls.push(call);
    (isLead ? leadCalls : childCalls).push(call);
    const requestedNativeTools = spawnOptions.isolatedReview?.nativeTools ?? [];
    const declaresNativeTools = !isLead && options.childNativeTools !== undefined && requestedNativeTools.length > 0;
    const handle: AgentHandle = {
      role: 'perkins',
      id: agentId,
      sessionFile: file,
      capabilities: CAPS,
      reviewIsolation: true,
      ...(declaresNativeTools ? { reviewTools: requestedNativeTools.map((tool) => tool.name) } : {}),
      async prompt(prompt) {
        call.prompt = prompt;
        let text = isLead
          ? await runLead(call, prompt, spawnOptions.reviewLead!.nativeTools)
          : await options.childAnswer(prompt, call);
        if (!isLead) {
          const lens = lensFromPrompt(prompt);
          if (lens === 'tests') {
            try {
              const parsed = JSON.parse(text) as unknown;
              if (Array.isArray(parsed)) {
                for (const entry of parsed) {
                  if (
                    typeof entry === 'object' && entry !== null &&
                    (entry as { category?: unknown }).category === 'coverage-gate' &&
                    (entry as { title?: unknown }).title === 'Coverage gate: FAIL'
                  ) ownGateFail = true;
                }
                if (!parsed.some((entry) =>
                  typeof entry === 'object' && entry !== null && (entry as { category?: unknown }).category === 'coverage-gate')) {
                  parsed.push({
                    source: 'tests', severity: 'note', category: 'coverage-gate', title: 'Coverage gate: PASS',
                    location: 'N/A', evidence: 'N/A', detail: 'Required test coverage thresholds are satisfied.',
                    recommended_fix: 'Keep the current coverage gate green.',
                  });
                  text = JSON.stringify(parsed);
                }
              }
            } catch {
              // Preserve intentionally malformed child output for retry tests.
            }
          }
          if (options.childNativeTools === 'tool' && declaresNativeTools) {
            // Simulate the runtime executing the child's tool call: a bare
            // JSON array answer becomes the structured submission (source is
            // host-owned and stripped); a schema rejection surfaces as a
            // tool error the model could correct, and no call at all leaves
            // the run unsubmitted.
            const submit = requestedNativeTools.find((tool) => tool.name === 'perkins_submit_findings');
            try {
              const parsed = JSON.parse(text) as unknown;
              if (Array.isArray(parsed) && submit !== undefined) {
                const findings = parsed.map((entry) => {
                  const candidate = entry as Record<string, unknown>;
                  const { source: _source, ...rest } = candidate;
                  return rest;
                });
                try {
                  await submit.execute({ findings });
                } catch {
                  // The runtime reports the tool error to the model; the fake
                  // child simply ends its turn with the rejection recorded.
                }
              }
            } catch {
              // Non-JSON answer: the scripted child never had a submission.
            }
          }
        }
        writeFileSync(file, `${JSON.stringify({ role: 'assistant', text, stopReason: 'stop' })}\n`, 'utf8');
      },
      async steer() {},
      async followUp() {},
      subscribe(_listener: RuntimeEventListener) { return () => {}; },
      health() { return { state: 'idle', lastActivity: null, sessionFile: file }; },
      async dispose() { call.disposed = true; },
    };
    return handle;
  };

  return { spawner, calls, leadCalls, childCalls, toolErrors, preflightResults, recordResults };
}
