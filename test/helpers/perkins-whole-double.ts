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
 * Offline Perkins whole-PR double: one scripted LEAD that actually drives the
 * product-native tools (run specialists, prior revision, artifacts, submit),
 * plus specialist CHILDREN that answer from a scripted per-prompt responder.
 * The lead brain mirrors the policy's verdict guidance so submissions
 * exercise the REAL host validator — nothing is forged around it.
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

export interface WholeSpawnCall {
  readonly options: SpawnOptions;
  readonly agentId: string;
  readonly sessionFile: string;
  prompt?: string;
  disposed?: boolean;
}

export interface WholeFindingView {
  readonly source: string;
  readonly severity: 'blocker' | 'warning' | 'note';
  readonly category: string;
  readonly title: string;
  readonly location: string;
  readonly evidence: string;
  readonly detail: string;
  readonly recommended_fix: string;
}

export interface WholePriorDisposition {
  readonly prior_index: number;
  readonly status: 'fixed' | 'still-present';
  readonly note: string;
  readonly refresh?: { readonly location?: string; readonly evidence?: string; readonly severity?: 'blocker' | 'warning' | 'note' };
}

/** The exact payload the scripted lead sends to preflight/submit. */
export interface WholeSubmission {
  readonly verdict: string;
  readonly findings: readonly WholeFindingView[];
  readonly prior_dispositions: readonly WholePriorDisposition[];
  readonly report_markdown: string;
}

export interface WholePreflightOptions {
  /** Preflight calls issued before the real submission (default 1). */
  readonly calls?: number;
  /** Applied to the preflight payload only; the real submission is untouched. */
  readonly mutate?: (submission: WholeSubmission) => WholeSubmission;
  /** Build the exact preflight payload (defaults to the full submission). */
  readonly payload?: (submission: WholeSubmission) => unknown;
  /** Real-submission attempt the preflight calls precede (1-based, default 1). */
  readonly beforeAttempt?: number;
  /** Skip the real submission after preflight (proves preflight accepts nothing). */
  readonly withhold?: boolean;
}

export interface WholeLeadOptions {
  childAnswer: (prompt: string, call: WholeSpawnCall) => string | Promise<string>;
  /**
   * Simulate a native-tool specialist runtime (pi): the spawned handle
   * declares the requested perkins_submit_findings tool and, with 'tool',
   * every valid bare JSON array the child answers with is delivered through
   * that tool instead of assistant text. 'text-only' declares the tool but
   * never calls it (proves no silent text fallback). Absent = text-path
   * runtime.
   */
  readonly childNativeTools?: 'tool' | 'text-only';
  /** Lenses the lead runs as specialists. Default: the review's whole
   * catalog parsed from the run tool's declared schema. [] = none. */
  readonly specialists?: readonly string[];
  /** Overrides the verdict (default: computed from retained blockers). */
  readonly verdictOverride?: string;
  /** Transform the retained findings before submission. */
  readonly findings?: (findings: readonly WholeFindingView[]) => readonly WholeFindingView[];
  /** One lead-authored finding added to the submission (source "lead"). */
  readonly leadFinding?: WholeFindingView;
  /** Prior dispositions (default: every prior finding still-present). */
  readonly priorDisposition?: (
    prior: readonly unknown[],
  ) => readonly WholePriorDisposition[];
  readonly neverSubmit?: boolean;
  /** Lenses whose first child answer is malformed (retried once by default). */
  readonly badRuns?: readonly string[];
  readonly storeArtifact?: { readonly name: string; readonly content: string };
  readonly duplicateArtifact?: boolean;
  readonly duplicateRun?: string;
  /** After the worklist completes, try to rerun this (now valid) lens; the
   * host refusal is recorded and the lead proceeds. */
  readonly rerunValid?: string;
  /** After the worklist completes, try one more run of this (exhausted)
   * lens; the host refusal is recorded and the lead proceeds. */
  readonly probeExhausted?: string;
  readonly beforeSubmit?: () => void;
  readonly onLeadStart?: () => void;
  readonly onPriorRevision?: (list: unknown, selected: unknown, prompt: string) => void | Promise<void>;
  readonly priorRevisionPath?: string;
  readonly transformReport?: (report: string) => string;
  /** Validate the exact submission through the preflight channel first. */
  readonly preflight?: WholePreflightOptions;
  /** Real-submission attempts after a rejection (default 1 retry). */
  readonly submitRetries?: number;
  /** Build the exact real-submission payload per attempt (1-based). */
  readonly submitPayload?: (attempt: number, submission: WholeSubmission, findings: readonly WholeFindingView[]) => unknown;
}

const SEVERITY_RANK: Record<string, number> = { blocker: 3, warning: 2, note: 1 };

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function brainVerdict(retained: readonly { severity: string }[]): string {
  const blockers = retained.filter((finding) => finding.severity === 'blocker').length;
  if (blockers === 0) return 'READY TO MERGE';
  if (blockers <= 3) return 'NEEDS CHANGES';
  return 'MAJOR REWORK NEEDED';
}

export function fakeWholeSpawner(
  sessionsRoot: string,
  options: WholeLeadOptions,
): {
  readonly spawner: AgentSpawner;
  readonly calls: WholeSpawnCall[];
  readonly leadCalls: WholeSpawnCall[];
  readonly childCalls: WholeSpawnCall[];
  readonly toolErrors: ReadonlyArray<{ tool: string; error: string }>;
  readonly preflightResults: ReadonlyArray<{ text: string; details?: Readonly<Record<string, unknown>>; terminate?: boolean }>;
} {
  const calls: WholeSpawnCall[] = [];
  const leadCalls: WholeSpawnCall[] = [];
  const childCalls: WholeSpawnCall[] = [];
  const toolErrors: { tool: string; error: string }[] = [];
  const preflightResults: { text: string; details?: Readonly<Record<string, unknown>>; terminate?: boolean }[] = [];
  let next = 0;

  const runLead = async (call: WholeSpawnCall, prompt: string, tools: readonly NativeAgentTool[]): Promise<string> => {
    options.onLeadStart?.();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const runTool = byName.get('perkins_run_specialists')!;
    const priorRevisionTool = byName.get('perkins_read_prior_revision');
    const artifactTool = byName.get('perkins_store_artifact')!;
    const preflightTool = byName.get('perkins_preflight_submission');
    const submitTool = byName.get('perkins_submit_review')!;

    const catalog = runTool.inputSchema.properties !== undefined
      ? ((runTool.inputSchema as { properties: { runs: { items: { properties: { lens: { enum: readonly string[] } } } } } })
        .properties.runs.items.properties.lens.enum)
      : [];
    const prior = JSON.parse((() => {
      const start = prompt.indexOf('--- PRIOR FINDINGS TO REVISIT ---');
      const header = '--- PRIOR FINDINGS TO REVISIT ---';
      if (start === -1) return '[]';
      const open = prompt.indexOf('[', start + header.length);
      if (open === -1) return '[]';
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let index = open; index < prompt.length; index += 1) {
        const character = prompt[index]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === '[') depth += 1;
        else if (character === ']') {
          depth -= 1;
          if (depth === 0) return prompt.slice(open, index + 1);
        }
      }
      return '[]';
    })()) as unknown[];

    if (options.onPriorRevision !== undefined) {
      if (priorRevisionTool === undefined) throw new Error('rereview lead needs perkins_read_prior_revision');
      const list = JSON.parse((await priorRevisionTool.execute({})).text) as unknown;
      const selected = JSON.parse(
        (await priorRevisionTool.execute({ path: options.priorRevisionPath ?? 'src/main.ts' })).text,
      ) as unknown;
      await options.onPriorRevision(list, selected, prompt);
    }
    if (options.storeArtifact !== undefined) {
      await artifactTool.execute(options.storeArtifact);
      if (options.duplicateArtifact === true) {
        try {
          await artifactTool.execute(options.storeArtifact);
        } catch (error) {
          toolErrors.push({ tool: 'perkins_store_artifact', error: String(error) });
        }
      }
    }

    const findings: WholeFindingView[] = [];
    const worklist = [...(options.specialists !== undefined ? [...options.specialists] : [...catalog])];
    const retried = new Set<string>();
    let first = true;
    while (worklist.length > 0) {
      const batch = worklist.splice(0, 4);
      let runs: readonly string[];
      if (first && options.badRuns !== undefined) {
        runs = options.badRuns;
        const overridden = new Set(runs);
        worklist.unshift(...batch.filter((lens) => !overridden.has(lens)));
      } else if (first && options.duplicateRun !== undefined) {
        runs = [options.duplicateRun, options.duplicateRun];
        worklist.unshift(...batch.filter((lens) => lens !== options.duplicateRun));
      } else {
        runs = batch;
      }
      first = false;
      try {
        const response = JSON.parse((await runTool.execute({ runs: runs.map((lens) => ({ lens })) })).text) as {
          results: Array<{ lens: string; status: string; failureKind?: string; error?: string; findings?: WholeFindingView[] }>;
        };
        for (const result of response.results) {
          if (result.status === 'valid') findings.push(...(result.findings ?? []));
          else if (!retried.has(result.lens)) {
            retried.add(result.lens);
            worklist.push(result.lens);
          }
        }
      } catch (error) {
        // A refused batch (duplicate lens, exhausted attempts, transport
        // bound) is recorded; the lead continues with what it has.
        toolErrors.push({ tool: 'perkins_run_specialists', error: String(error) });
        for (const lens of runs) {
          if (!retried.has(lens)) {
            retried.add(lens);
            worklist.push(lens);
          }
        }
        continue;
      }
    }

    for (const probe of [options.rerunValid, options.probeExhausted]) {
      if (probe === undefined) continue;
      try {
        await runTool.execute({ runs: [{ lens: probe }] });
      } catch (error) {
        toolErrors.push({ tool: 'perkins_run_specialists', error: String(error) });
      }
    }

    if (options.neverSubmit === true) return 'lead gave up without submitting';

    const effectiveDispositions: readonly WholePriorDisposition[] = options.priorDisposition?.(prior) ??
      prior.map((entry, index) => {
        const finding = entry as { title: string };
        return {
          prior_index: index,
          status: 'still-present' as const,
          note: `prior remains: ${finding.title}`,
        };
      });
    const priorDispositions = effectiveDispositions;

    const retained: WholeFindingView[] = [...(options.findings?.(findings) ?? findings)];
    if (options.leadFinding !== undefined) retained.push(options.leadFinding);
    // Policy verdict guidance counts confirmed blockers — a still-present
    // prior blocker is still a blocker of this change (the SAME effective
    // dispositions the submission carries feed the verdict).
    for (const disposition of effectiveDispositions) {
      if (disposition.status !== 'still-present') continue;
      const carried = prior[disposition.prior_index] as { severity: string; title: string; location: string };
      // The scripted lead cites the CURRENT location/severity when the
      // disposition refreshes one, so its finding merges with the carried
      // prior instead of duplicating it.
      retained.push({
        source: 'lead',
        severity: (disposition.refresh?.severity ?? carried.severity) as WholeFindingView['severity'],
        category: 'carried',
        title: carried.title,
        location: disposition.refresh?.location ?? carried.location,
        evidence: disposition.refresh?.evidence ?? 'carried from prior round',
        detail: 'Still present from the prior round.', recommended_fix: 'Resolve the prior finding.',
      });
    }
    const deduped = new Map<string, WholeFindingView>();
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

    // The whole-PR report is coherent prose: identity anchors, verdict line,
    // and per-finding source references — deliberately NOT a verbatim
    // transcription of every structured field.
    const baseReport = [
      '# Perkins Code Review',
      '',
      `**Verdict: ${verdict}**`,
      '',
      `Frozen target: ${targetSha}`,
      `Frozen base: ${baseSha}`,
      `Specialists used: ${[...new Set((options.specialists !== undefined ? options.specialists : catalog))].join(', ') || 'none'}`,
      '',
      ...(finalFindings.length === 0 ? ['No grounded findings were retained.'] : finalFindings.flatMap((finding) => [
        `### ${finding.severity} — ${finding.title}`,
        `Source: ${finding.source} · Location: ${finding.location}`,
        finding.detail,
        `Fix: ${finding.recommended_fix}`,
        '',
      ])),
      ...(prior.length === 0 ? [] : [
        '## Prior findings revisited',
        ...priorDispositions.map((disposition) => {
          const finding = prior[disposition.prior_index] as { title: string; location: string };
          return `- #${disposition.prior_index} ${disposition.status}: ${finding.title} @ ${finding.location} — ${disposition.note}`;
        }),
        '',
      ]),
    ].join('\n');
    const report = options.transformReport?.(baseReport) ?? baseReport;

    options.beforeSubmit?.();
    const submission: WholeSubmission = {
      verdict,
      findings: finalFindings,
      prior_dispositions: priorDispositions,
      report_markdown: report,
    };
    if (options.preflight !== undefined && (options.preflight.beforeAttempt ?? 1) < 1) {
      throw new Error('whole double preflight.beforeAttempt must be >= 1');
    }
    const preflightBefore = options.preflight?.beforeAttempt ?? 1;
    const attempts = 1 + Math.max(options.submitRetries ?? 1, 0);
    let lastError: unknown;
    for (let index = 0; index < attempts; index += 1) {
      const attempt = index + 1;
      if (options.preflight !== undefined && attempt === preflightBefore) {
        if (preflightTool === undefined) throw new Error('whole double expected the perkins_preflight_submission tool');
        const preflightCalls = options.preflight.calls ?? 1;
        for (let callIndex = 0; callIndex < preflightCalls; callIndex += 1) {
          const payload = options.preflight.payload !== undefined
            ? options.preflight.payload(submission)
            : (options.preflight.mutate?.(submission) ?? submission);
          const result = await preflightTool.execute(payload as Record<string, unknown>);
          preflightResults.push({ text: result.text, details: result.details, terminate: result.terminate });
        }
        if (options.preflight.withhold === true) return 'lead preflighted and withheld the real submission';
      }
      const payload = options.submitPayload?.(attempt, submission, finalFindings) ?? submission;
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
    const agentId = `${isLead ? 'lead' : 'specialist'}-${index}`;
    const call: WholeSpawnCall = { options: spawnOptions, agentId, sessionFile: file };
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
        const text = isLead
          ? await runLead(call, prompt, spawnOptions.reviewLead!.nativeTools)
          : await options.childAnswer(prompt, call);
        if (!isLead && options.childNativeTools === 'tool' && declaresNativeTools) {
          // Simulate the runtime executing the specialist's tool call: a
          // bare JSON array answer becomes the structured submission (source
          // is host-owned and stripped); a schema rejection surfaces as a
          // tool error the model could correct, and no call at all leaves
          // the run unsubmitted.
          const submit = requestedNativeTools.find((tool) => tool.name === 'perkins_submit_findings');
          try {
            const parsed = JSON.parse(text) as unknown;
            if (Array.isArray(parsed) && submit !== undefined) {
              const childFindings = parsed.map((entry) => {
                const candidate = entry as Record<string, unknown>;
                const { source: _source, ...rest } = candidate;
                return rest;
              });
              try {
                await submit.execute({ findings: childFindings });
              } catch {
                // The runtime reports the tool error to the model; the fake
                // child simply ends its turn with the rejection recorded.
              }
            }
          } catch {
            // Non-JSON answer: the scripted child never had a submission.
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

  return { spawner, calls, leadCalls, childCalls, toolErrors, preflightResults };
}

/** A grounded finding the scripted child can return for a fixture diff. */
export function groundedFinding(
  source: string,
  severity: 'blocker' | 'warning' | 'note' = 'blocker',
  overrides: Partial<WholeFindingView> = {},
): WholeFindingView {
  return {
    source,
    severity,
    category: 'correctness',
    title: `${source} grounded defect`,
    location: 'src/main.ts:1',
    evidence: 'export function answer(): number {',
    detail: 'The exact changed function demonstrates the defect.',
    recommended_fix: 'Correct the function and retain a regression test.',
    ...overrides,
  };
}
