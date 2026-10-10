import { join } from 'node:path';
import { createArtifactContext } from '../artifacts/context.js';
import { materializeBmadRuntime, PACKAGE_ROOT, readBmadRuntimeBinding } from '../bmad/runtime.js';
import type { WorktreeLane, WorktreePort } from '../dispatch/worktree-port.js';
import type { AgentRecord, JobRecord } from '../ledger/api.js';
import type { ManagedSkillSet, ManagedWorkflowSession, SpawnOptions } from '../runtime/types.js';
import { WORKFLOW_SOURCE } from './manifest.js';
import { createWorkflowRuntimeBinder, loadBundledWorkflowRuntime, renderWorkflow, validateWorkflowContext, workflowRuntimeForInvocation, type WorkflowContext } from './runtime.js';

export class WorkflowSessionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'WorkflowSessionError';
  }
}

type WorkflowAgent = Pick<AgentRecord, 'id' | 'jobId' | 'sessionFile' | 'role' | 'parentage'>;

/** Read only the existing assignment records, never derive a job from a basename.
 * A supervised resume with no cwd recovers the same lane through its session row. */
export function registeredWorkflowLane(
  options: SpawnOptions,
  worktrees: Pick<WorktreePort, 'getWorktree' | 'listWorktrees'>,
  ledger: {
    getAgent(id: string): WorkflowAgent | null;
    listAgents(): readonly WorkflowAgent[];
    listJobAdmissions(jobId: string): readonly string[];
  },
): WorktreeLane | null {
  const resumed = options.resumeFile === undefined ? [] : ledger.listAgents().filter((agent) => agent.sessionFile === options.resumeFile);
  if (resumed.length > 1) throw new WorkflowSessionError(`ambiguous workflow assignment for session ${options.resumeFile}; repair the agent records`);
  if (options.resumeFile !== undefined && resumed.length === 0) {
    throw new WorkflowSessionError(`workflow resume requires the registered session owner for ${options.resumeFile}; restore its agent record before resuming`);
  }
  const named = options.agentId === undefined ? null : ledger.getAgent(options.agentId);
  if (resumed[0] !== undefined && options.agentId !== undefined && options.agentId !== resumed[0].id) {
    throw new WorkflowSessionError('workflow resume identity conflicts with the registered session owner');
  }
  const agent = named ?? resumed[0];
  const assigned = agent === undefined || agent === null ? null
    : worktrees.getWorktree(agent.id) ?? (agent.jobId === null || agent.parentage === 'child' ? null : worktrees.getWorktree(agent.jobId));
  if (assigned !== null) {
    if (assigned.jobId !== agent?.jobId) {
      throw new WorkflowSessionError(`registered workflow lane ${assigned.id} does not belong to worker ${agent?.id}; repair its job/worktree ownership records`);
    }
    if (options.cwd !== undefined && options.cwd !== assigned.path) {
      throw new WorkflowSessionError(`workflow cwd conflicts with registered assignment ${assigned.id}: ${options.cwd}`);
    }
    return assigned;
  }
  if (agent !== undefined && agent !== null) return null; // never redirect a known owner to another lane
  if (options.cwd === undefined) return null;
  const candidates = worktrees.listWorktrees().filter((lane) => lane.path === options.cwd && lane.status !== 'swept');
  if (candidates.length > 1) throw new WorkflowSessionError(`ambiguous registered workflow lane at ${options.cwd}`);
  const candidate = candidates[0];
  if (candidate?.kind === 'job') {
    if (ledger.listAgents().some((owner) => owner.jobId === candidate.jobId && owner.role === 'minion' && owner.parentage !== 'child')) {
      throw new WorkflowSessionError(`registered job ${candidate.jobId} already has a logical worker; resume its recorded session/identity instead of attaching an unknown worker by cwd`);
    }
    if (!ledger.listJobAdmissions(candidate.id).includes('initial dispatch')) {
      throw new WorkflowSessionError(`fresh workflow worker for ${candidate.id} requires its recorded initial dispatch admission; restore missing worker ownership records rather than replacing it by cwd`);
    }
  }
  return candidate ?? null;
}

/** Production build selection: #292 immutable resources + #293 registered storage.
 * Bounded child/report tasks are not another top-level implementation workflow. */
export function createWorkflowSessionBinder(
  dataDir: string,
  laneFor: (options: SpawnOptions) => WorktreeLane | null,
  packageRoot = PACKAGE_ROOT,
  runsBuildFor: (lane: WorktreeLane) => boolean = () => true,
): (options: SpawnOptions) => ManagedWorkflowSession {
  const storeRoot = join(dataDir, 'bmad-runtime'); // retain the historical store and private Git binding
  const bind = createWorkflowRuntimeBinder(storeRoot, packageRoot);
  return (options) => {
    const lane = laneFor(options);
    if (lane === null || lane.status === 'swept') {
      throw new WorkflowSessionError(`GC workflow requires the live registered assignment for ${options.cwd ?? options.resumeFile ?? options.agentId ?? 'this minion'}; restore its job/worktree records before resuming`);
    }
    const reference = readBmadRuntimeBinding(lane.path, storeRoot);
    let retained: ManagedSkillSet | undefined;
    if (reference !== null) {
      try {
        retained = bind(lane.path);
      } catch (error) {
        throw new WorkflowSessionError(`job ${lane.jobId} retains workflow ${reference.id} at ${reference.dir}; restore that exact retained package and retry the same worker/lane. ${String(error)}`, error);
      }
      // Historical bindings precede the NEW-job build/report routing decision.
      if (retained.source !== WORKFLOW_SOURCE) return { cwd: lane.path, managedSkills: retained };
    }
    if (lane.kind !== 'job' || !runsBuildFor(lane) || (options.roleTools !== undefined && !options.roleTools.includes('edit'))) {
      return { cwd: lane.path };
    }
    // Select read-only, then validate paths/context and render before publishing
    // a first lane binding. Failed initialization must not pin a never-started job.
    const bundle = workflowRuntimeForInvocation(lane.path, storeRoot, packageRoot);
    const artifacts = createArtifactContext({ dataDir, worktree: lane,
      workflow: { id: bundle.id, sha256: bundle.contentSha256 } });
    const context: WorkflowContext = {
      projectId: artifacts.projectKey, projectRoot: lane.repoPath, worktreeRoot: lane.path,
      jobId: artifacts.jobId, artifactRoot: artifacts.operationalDirectory, knowledgeRoot: artifacts.knowledgeDirectory,
    };
    validateWorkflowContext(bundle, context, [join(storeRoot, bundle.dirName)]);
    const invocation = renderWorkflow(materializeBmadRuntime(bundle, storeRoot), context);
    artifacts.writeOperational({ path: 'workflow-context.json', contents: `${JSON.stringify(context, null, 2)}\n`, sources: [] });
    const managed = retained ?? bind(lane.path);
    if (managed.runtimeId !== bundle.id || managed.contentSha256 !== bundle.contentSha256) {
      throw new WorkflowSessionError(`job ${lane.jobId} acquired a conflicting workflow binding during initialization; restore its exact artifact/runtime records before retrying`);
    }
    return { cwd: lane.path, managedSkills: { ...managed, workflow: {
      context, invocation, contextFile: join(context.artifactRoot, 'workflow-context.json'),
    } } };
  };
}

/** The fallback uses a single owned adversarial helper, not the build/review
 * orchestrator or an ambient bmad-review skill. Legacy build bindings stay intact. */
export function ownedFallbackReviewResources(
  session: ManagedWorkflowSession, dataDir: string, packageRoot = PACKAGE_ROOT,
): { readonly skillPath: string; readonly artifactRoot: string } {
  const workflow = session.managedSkills?.workflow;
  if (workflow !== undefined) return {
    skillPath: join(workflow.invocation.snapshotDir, 'skills/gc-build/review-prompts/adversarial.md'),
    artifactRoot: workflow.context.artifactRoot,
  };
  const runtime = materializeBmadRuntime(loadBundledWorkflowRuntime(packageRoot), join(dataDir, 'bmad-runtime'));
  return { skillPath: join(runtime.skillsDir, 'gc-build/review-prompts/adversarial.md'), artifactRoot: join(dataDir, 'reviews') };
}

/** Shared production wiring, exercised directly by dispatch/runtime/gate proofs.
 * The lazy ledger accessor preserves boot order without copying assignment rules. */
export function serviceWorkflowAuthority(dataDir: string, records: () => Pick<WorktreePort, 'getWorktree' | 'listWorktrees'> & {
  getAgent(id: string): WorkflowAgent | null;
  listAgents(): readonly WorkflowAgent[];
  listJobAdmissions(jobId: string): readonly string[];
  getJob(id: string): Pick<JobRecord, 'id' | 'deliverable'> | null;
}, packageRoot = PACKAGE_ROOT): {
  readonly workflowLaneFor: (options: SpawnOptions) => WorktreeLane | null;
  readonly workflowBuildFor: (lane: WorktreeLane) => boolean;
  readonly resolveReviewResources: (jobId: string) => { readonly skillPath: string; readonly artifactRoot: string };
} {
  const workflowLaneFor = (options: SpawnOptions): WorktreeLane | null => registeredWorkflowLane(options, records(), records());
  return {
    workflowLaneFor,
    workflowBuildFor: (lane) => {
      const job = records().getJob(lane.id);
      if (job === null) throw new WorkflowSessionError(`GC workflow requires the registered job record for ${lane.id}`);
      return job.deliverable === null || job.deliverable === 'pr';
    },
    resolveReviewResources: (jobId) => {
      const lane = records().getWorktree(jobId);
      if (lane === null || lane.kind !== 'job' || lane.jobId !== jobId || lane.status === 'swept') {
        throw new WorkflowSessionError(`GC fallback review requires the live registered job worktree for ${jobId}`);
      }
      // Resource selection is authorized by the explicit registered JOB, not
      // permission to spawn a replacement implementation worker by its cwd.
      const session = createWorkflowSessionBinder(dataDir, () => lane, packageRoot)({ cwd: lane.path });
      return ownedFallbackReviewResources(session, dataDir, packageRoot);
    },
  };
}
