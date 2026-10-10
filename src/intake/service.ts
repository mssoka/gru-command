import { ArtifactContextError, createPreviewArtifactContext, type PreviewArtifactContext } from '../artifacts/context.js';
import { discoverManagedRepos } from '../repos/discovery.js';
import { loadBundledWorkflowRuntime, type BundledWorkflowRuntime } from '../workflows/runtime.js';
import { REQUIRED_INTAKE_WORKFLOW_FILE } from '../workflows/manifest.js';
import { join, isAbsolute, resolve } from 'node:path';
import { canonicalManagedRepo, captureSources, INTAKE_MAX_DOCUMENTS, INTAKE_MAX_AGGREGATE_BYTES, INTAKE_MAX_REQUIREMENTS, type SourcePorts } from './sources.js';
import { conservativePlan, validatePlan } from './planner.js';
import { canonical, boundedCanonical, digest, IntakeError, type Capture, type DocumentInput, type IntakePlanner, type IntakeRequest, type IntakeSource, type Proposal } from './types.js';

export const INTAKE_HELPER = REQUIRED_INTAKE_WORKFLOW_FILE;
export const INTAKE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export interface IntakeServiceOptions extends SourcePorts {
  readonly dataDir: string;
  readonly workspaceRoot: string;
  /** Explicit managed registry seam; never an ambient cwd. */
  readonly managedRepos?: () => readonly string[];
  readonly workflow?: () => BundledWorkflowRuntime;
  readonly planner?: IntakePlanner;
}
function invalid(message: string): never { throw new IntakeError('intake_invalid_request', message); }
function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !keys.includes(key))) invalid(`${label} contains unsupported fields`);
  return raw;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4096 || /\p{Cc}/u.test(value)) invalid(`${label} must be bounded nonempty text without control characters`);
  return value;
}
function requestId(value: unknown, label: string): string {
  const id = text(value, label);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id)) invalid(`${label} must be a safe lowercase 1–128 character identifier`);
  return id;
}
function document(value: unknown): DocumentInput {
  const raw = record(value, 'document', ['path', 'uploadPath']);
  if ((raw['path'] === undefined) === (raw['uploadPath'] === undefined)) invalid('document must name exactly one path or uploadPath');
  if (raw['path'] !== undefined) return { path: text(raw['path'], 'document.path') };
  const path = text(raw['uploadPath'], 'document.uploadPath');
  if (!isAbsolute(path) || resolve(path) !== path) invalid('uploadPath must be a normalized absolute service-managed upload path');
  return { uploadPath: path };
}
function source(value: unknown): IntakeSource {
  const raw = record(value, 'source', ['kind', 'reference', 'commentIds', 'document', 'supporting']);
  if (raw['kind'] === 'issue') {
    if (raw['document'] !== undefined || raw['supporting'] !== undefined) invalid('issue source cannot include document fields');
    const ids = raw['commentIds'] ?? [];
    if (!Array.isArray(ids) || ids.length >= INTAKE_MAX_DOCUMENTS || ids.some((id) => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) invalid('commentIds must be an explicit unique array of at most 7 positive safe integers');
    return { kind: 'issue', reference: text(raw['reference'], 'source.reference'), commentIds: ids as number[] };
  }
  if (raw['kind'] !== 'spec' && raw['kind'] !== 'bmad') invalid('source.kind must be issue, spec or bmad');
  if (raw['reference'] !== undefined || raw['commentIds'] !== undefined) invalid('document source cannot include issue fields');
  const supporting = raw['supporting'] ?? [];
  if (!Array.isArray(supporting) || supporting.length >= INTAKE_MAX_DOCUMENTS) invalid('supporting must be an explicit array of at most 7 documents');
  const primary = document(raw['document']);
  const documents = supporting.map(document);
  if (new Set([primary, ...documents].map(canonical)).size !== documents.length + 1) invalid('documents must not be duplicated');
  return { kind: raw['kind'], document: primary, supporting: documents };
}
export function parseIntakeRequest(value: unknown): IntakeRequest {
  const raw = record(value, 'intake request', ['repoPath', 'intakeId', 'requestId', 'previousRequestId', 'source', 'plan']);
  // Validate nesting on the complete JSON request before allocating storage.
  canonical(raw);
  const previousRequestId = raw['previousRequestId'] === undefined ? undefined : requestId(raw['previousRequestId'], 'previousRequestId');
  const id = requestId(raw['requestId'], 'requestId');
  if (previousRequestId === id) invalid('previousRequestId must name a different immutable request');
  return {
    repoPath: text(raw['repoPath'], 'repoPath'), intakeId: requestId(raw['intakeId'], 'intakeId'), requestId: id,
    ...(previousRequestId === undefined ? {} : { previousRequestId }), source: source(raw['source']),
    ...(raw['plan'] === undefined ? {} : { plan: JSON.parse(canonical(raw['plan'])) as unknown }),
  };
}

/** Read-only proposals only: this service intentionally has no ledger,
 * scheduler, dispatch, model, BMAD runner or approval port. */
export class IntakeService {
  constructor(private readonly options: IntakeServiceOptions) {}

  private context(repoPath: string, intakeId: string, existingOnly = false): PreviewArtifactContext {
    const registered = (this.options.managedRepos ?? (() => discoverManagedRepos(this.options.workspaceRoot).map((name) => join(this.options.workspaceRoot, name))))();
    const repo = canonicalManagedRepo(repoPath, registered);
    let runtime: BundledWorkflowRuntime;
    try { runtime = (this.options.workflow ?? loadBundledWorkflowRuntime)(); } catch (error) {
      throw new IntakeError('intake_workflow_unavailable', error instanceof Error ? error.message : String(error), 503);
    }
    if (!runtime.manifest.files[INTAKE_HELPER] || !runtime.files.has(INTAKE_HELPER)) throw new IntakeError('intake_workflow_unavailable', 'owned intake helper is missing from the verified GC workflow package', 503);
    const input = { dataDir: this.options.dataDir, repoPath: repo, intakeId: requestId(intakeId, 'intakeId'), workflow: { id: runtime.id, sha256: runtime.contentSha256 } };
    const context = existingOnly ? createPreviewArtifactContext(input, 'existing') : createPreviewArtifactContext(input);
    if (context === null) throw new IntakeError('intake_not_found', 'no existing preview context for this explicit repository/intake identity', 404);
    return context;
  }

  private storage<T>(operation: () => T, allowReplayConflict = true): T {
    try { return operation(); } catch (error) {
      if (error instanceof ArtifactContextError) {
        const conflict = allowReplayConflict && /different bytes|different provenance|different.*identity/u.test(error.message);
        throw new IntakeError(conflict ? 'intake_replay_conflict' : 'intake_storage_error', error.message, conflict ? 409 : 500);
      }
      throw error;
    }
  }

  async preview(value: unknown): Promise<Proposal> {
    const request = parseIntakeRequest(value);
    const context = this.storage(() => this.context(request.repoPath, request.intakeId));
    const prefix = `requests/${request.requestId}`;
    const write = (path: string, value: unknown, sources: Proposal['snapshots'] = [], contents = canonical(value)): void => {
      this.storage(() => context.writeOperational({ path, contents, sources: sources.map(({ kind, locator, revision, sha256 }) => ({ kind, locator, revision, sha256 })) }));
    };
    const retainFailure = (error: unknown): void => {
      const failure = { code: error instanceof IntakeError ? error.code : 'intake_planner_failed', message: error instanceof Error ? error.message : String(error) };
      write(`${prefix}/failures/${digest(canonical(failure))}.json`, failure, capture.snapshots);
    };
    // Preserve the explicit request before attempting any external source read.
    write(`${prefix}/input.json`, request);
    if (request.previousRequestId !== undefined) this.read(request.repoPath, request.intakeId, request.previousRequestId);
    const capture = await captureSources(request.repoPath, request.source, this.options);
    write(`${prefix}/capture.json`, capture, capture.snapshots);
    let plan: Proposal['plan'];
    try {
      if (capture.snapshots.reduce((total, snapshot) => total + Buffer.byteLength(snapshot.raw), 0) > INTAKE_MAX_AGGREGATE_BYTES) {
        throw new IntakeError('intake_aggregate_bounds', 'captured sources exceed 1048576 aggregate UTF-8 bytes; narrow the explicitly supplied documents', 413);
      }
      if (capture.requirements.length > INTAKE_MAX_REQUIREMENTS) throw new IntakeError('intake_source_bounds', 'source inventory exceeds 4000 nonblank lines; narrow the captured documents', 413);
      const candidate = request.plan === undefined
        ? await (this.options.planner ?? conservativePlan)(structuredClone(capture))
        : request.plan;
      plan = validatePlan(candidate, capture);
    } catch (error) {
      retainFailure(error);
      if (error instanceof IntakeError) throw error;
      throw new IntakeError('intake_planner_failed', error instanceof Error ? error.message : String(error));
    }
    // Source gaps cannot disappear when Gru supplies a refinement.
    plan = { ...plan, questions: [...new Set([...plan.questions, ...capture.gaps.map((gap) => gap.question), ...plan.unmapped.map((item) => item.question)])] };
    const requestReference = this.storage(() => context.writeOperational({ path: `${prefix}/input.json`, contents: canonical(request), sources: [] }));
    const body = {
      schemaVersion: 1 as const, executable: false as const, projectKey: context.projectKey,
      repoPath: request.repoPath, intakeId: request.intakeId, requestId: request.requestId,
      previousRequestId: request.previousRequestId ?? null, workflow: requestReference.workflow,
      ...capture, plan,
    };
    try {
      const bodyBytes = boundedCanonical(body, INTAKE_MAX_OUTPUT_BYTES);
      const proposal: Proposal = { ...body, revisionId: digest(bodyBytes) };
      const contents = boundedCanonical(proposal, INTAKE_MAX_OUTPUT_BYTES);
      write(`${prefix}/proposal.json`, proposal, capture.snapshots, contents);
      return proposal;
    } catch (error) {
      if (error instanceof IntakeError && error.code === 'intake_output_bounds') retainFailure(error);
      throw error;
    }
  }

  read(repoPath: string, intakeId: string, id: string): Proposal {
    const context = this.storage(() => this.context(repoPath, intakeId, true), false);
    const prefix = `requests/${requestId(id, 'requestId')}`;
    if (!this.storage(() => context.hasOperational(`${prefix}/proposal.json`), false)) throw new IntakeError('intake_not_found', 'no completed preview for this explicit repository/intake/request identity', 404);
    const proposal = this.storage(() => JSON.parse(context.readOperational(`${prefix}/proposal.json`)) as Proposal, false);
    const request = this.storage(() => parseIntakeRequest(JSON.parse(context.readOperational(`${prefix}/input.json`))), false);
    const captureBytes = this.storage(() => context.readOperational(`${prefix}/capture.json`), false);
    const immutableCapture: Capture = { snapshots: proposal.snapshots, gaps: proposal.gaps, requirements: proposal.requirements };
    if (captureBytes !== canonical(immutableCapture)) throw new IntakeError('intake_storage_error', 'stored capture does not exactly match the immutable proposal capture', 500);
    boundedCanonical(proposal, INTAKE_MAX_OUTPUT_BYTES);
    const { revisionId, ...body } = proposal;
    if (proposal.executable !== false || proposal.repoPath !== repoPath || proposal.intakeId !== intakeId || proposal.requestId !== id ||
        proposal.projectKey !== context.projectKey || proposal.schemaVersion !== 1 || revisionId !== digest(canonical(body)) ||
        request.repoPath !== repoPath || request.intakeId !== intakeId || request.requestId !== id) throw new IntakeError('intake_storage_error', 'stored proposal binding is invalid', 500);
    validatePlan(proposal.plan, proposal);
    return proposal;
  }

  diff(repoPath: string, intakeId: string, from: string, to: string): Readonly<Record<string, unknown>> {
    const before = this.read(repoPath, intakeId, from);
    const after = this.read(repoPath, intakeId, to);
    const changes = <T extends { readonly id: string }>(old: readonly T[], current: readonly T[]): readonly unknown[] => {
      const ids = [...new Set([...old, ...current].map((item) => item.id))];
      return ids.flatMap((id) => {
        const left = old.find((item) => item.id === id) ?? null;
        const right = current.find((item) => item.id === id) ?? null;
        return canonical(left) === canonical(right) ? [] : [{ id, before: left, after: right }];
      });
    };
    const diff = {
      executable: false, from: before.revisionId, to: after.revisionId,
      snapshots: changes(before.snapshots, after.snapshots), heists: changes(before.plan.heists, after.plan.heists),
      gaps: { before: before.gaps, after: after.gaps }, questions: { before: before.plan.questions, after: after.plan.questions },
      unmapped: { before: before.plan.unmapped, after: after.plan.unmapped }, workflow: { before: before.workflow, after: after.workflow },
    };
    boundedCanonical(diff, INTAKE_MAX_OUTPUT_BYTES);
    return diff;
  }
}
