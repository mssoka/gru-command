import { createHash } from 'node:crypto';
import type { ArtifactWorkflow } from '../artifacts/context.js';
import type { PipelineMilestone } from '../ledger/pipeline.js';

export class IntakeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = 'IntakeError';
  }
}

export interface DocumentInput {
  readonly path?: string;
  readonly uploadPath?: string;
}
export type IntakeSource =
  | { readonly kind: 'issue'; readonly reference: string; readonly commentIds?: readonly number[] }
  | { readonly kind: 'spec' | 'bmad'; readonly document: DocumentInput; readonly supporting?: readonly DocumentInput[] };

export interface IntakeRequest {
  readonly repoPath: string;
  readonly intakeId: string;
  readonly requestId: string;
  readonly previousRequestId?: string;
  readonly source: IntakeSource;
  /** Structured refinement from the existing Gru conversation; never authority. */
  readonly plan?: unknown;
}
export interface Snapshot {
  readonly id: string;
  readonly kind: 'issue' | 'comment' | 'spec' | 'bmad';
  readonly locator: string;
  readonly revision: string;
  readonly sha256: string;
  /** Exact UTF-8 response or file bytes, not normalized Markdown. */
  readonly raw: string;
  /** Traceable planning text: issue title/body or complete document. */
  readonly text: string;
  readonly frontmatter: string | null;
  readonly identifiers: Readonly<Record<string, string>>;
}
export interface Gap {
  readonly code: string;
  readonly locator: string;
  readonly question: string;
}
/** Half-open UTF-16 offsets into snapshot.text; quote must match exactly. */
export interface Trace {
  readonly snapshotId: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}
export interface Requirement {
  readonly id: string;
  readonly trace: Trace;
}
export interface Statement {
  readonly text: string;
  readonly traces: readonly Trace[];
  /** Explicit proposed clarification, not a claim about source requirements. */
  readonly clarification: boolean;
}
export interface Acceptance extends Statement {
  readonly requirementIds: readonly string[];
}
export interface Dependency extends Statement {
  readonly id: string;
  readonly milestone: PipelineMilestone;
}
export interface Heist {
  readonly id: string;
  readonly title: string;
  readonly goal: Statement;
  readonly scope: readonly Statement[];
  readonly exclusions: readonly Statement[];
  readonly acceptance: readonly Acceptance[];
  readonly verification: readonly Statement[];
  readonly milestones: readonly PipelineMilestone[];
  readonly dependencies: readonly Dependency[];
  readonly unresolvedQuestions: readonly string[];
  readonly splitMergeRationale: Statement;
}
export interface Plan {
  readonly heists: readonly Heist[];
  /** Every extracted requirement not mapped to acceptance appears here. */
  readonly unmapped: readonly { readonly requirementId: string; readonly question: string }[];
  readonly questions: readonly string[];
}
export interface Capture {
  readonly snapshots: readonly Snapshot[];
  readonly gaps: readonly Gap[];
  readonly requirements: readonly Requirement[];
}
export interface Proposal extends Capture {
  readonly schemaVersion: 1;
  readonly executable: false;
  readonly projectKey: string;
  readonly repoPath: string;
  readonly intakeId: string;
  readonly requestId: string;
  readonly previousRequestId: string | null;
  readonly revisionId: string;
  readonly workflow: ArtifactWorkflow;
  readonly plan: Plan;
}
export type IntakePlanner = (capture: Capture) => unknown | Promise<unknown>;
export const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const INTAKE_MAX_JSON_NESTING = 64;
/** Stable object-key ordering; array order and all source bytes remain significant. */
export function canonical(value: unknown): string { return canonicalText(value, Infinity); }

/** Stop amplification while serializing, before constructing/publishing a
 * potentially huge proposal or HTTP diff. No truncated JSON is returned. */
export function boundedCanonical(value: unknown, maxBytes: number): string { return canonicalText(value, maxBytes); }

function canonicalText(value: unknown, maxBytes: number): string {
  const chunks: string[] = [];
  let bytes = 0;
  const append = (text: string): void => {
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) throw new IntakeError('intake_output_bounds', `intake JSON output exceeds ${maxBytes} bytes; narrow sources or refine the proposed plan`, 413);
    chunks.push(text);
  };
  const encode = (item: unknown, depth = 0): void => {
    if (typeof item === 'object' && item !== null && depth >= INTAKE_MAX_JSON_NESTING) {
      throw new IntakeError('intake_invalid_request', `intake JSON exceeds ${INTAKE_MAX_JSON_NESTING} nested containers`, 400);
    }
    if (Array.isArray(item)) {
      append('[');
      item.forEach((entry, index) => { if (index !== 0) append(','); encode(entry, depth + 1); });
      append(']');
    } else if (typeof item === 'object' && item !== null) {
      append('{');
      Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).forEach(([key, entry], index) => {
        if (index !== 0) append(',');
        append(`${JSON.stringify(key)}:`);
        encode(entry, depth + 1);
      });
      append('}');
    } else {
      const encoded = JSON.stringify(item);
      if (encoded === undefined) throw new IntakeError('intake_invalid_request', 'intake must contain JSON values only');
      append(encoded);
    }
  };
  encode(value);
  return chunks.join('');
}
