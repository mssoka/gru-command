import { join } from 'node:path';
import { createArtifactContext } from '../artifacts/context.js';
import { materializeBmadRuntime, PACKAGE_ROOT, readBmadRuntimeBinding } from '../bmad/runtime.js';
import type { WorktreeLane, WorktreePort } from '../dispatch/worktree-port.js';
import type { AgentRecord } from '../ledger/api.js';
import type { ManagedSkillSet, ManagedWorkflowSession, SpawnOptions } from '../runtime/types.js';
import { WORKFLOW_SOURCE } from './manifest.js';
import { createWorkflowRuntimeBinder, loadBundledWorkflowRuntime, renderWorkflow, type WorkflowContext } from './runtime.js';

export class WorkflowSessionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'WorkflowSessionError';
  }
}

/** Read only the existing assignment records, never derive a job from a basename.
 * A supervised resume with no cwd recovers the same lane through its session row. */
export function registeredWorkflowLane(
  options: SpawnOptions,
  worktrees: Pick<WorktreePort, 'getWorktree' | 'listWorktrees'>,
  ledger: {
    getAgent(id: string): Pick<AgentRecord, 'id' | 'jobId' | 'sessionFile'> | null;
    listAgents(): readonly Pick<AgentRecord, 'id' | 'jobId' | 'sessionFile'>[];
  },
): WorktreeLane | null {
  const resumed = options.resumeFile === undefined ? [] : ledger.listAgents().filter((agent) => agent.sessionFile === options.resumeFile);
  if (resumed.length > 1) throw new WorkflowSessionError(`ambiguous workflow assignment for session ${options.resumeFile}; repair the agent records`);
  const named = options.agentId === undefined ? null : ledger.getAgent(options.agentId);
  if (named !== null && resumed[0] !== undefined && named.id !== resumed[0].id) {
    throw new WorkflowSessionError('workflow resume identity conflicts with the registered session owner');
  }
  const agent = named ?? resumed[0];
  const assigned = agent === undefined || agent === null ? null
    : worktrees.getWorktree(agent.id) ?? (agent.jobId === null ? null : worktrees.getWorktree(agent.jobId));
  if (assigned !== null) {
    if (options.cwd !== undefined && options.cwd !== assigned.path) {
      throw new WorkflowSessionError(`workflow cwd conflicts with registered assignment ${assigned.id}: ${options.cwd}`);
    }
    return assigned;
  }
  if (agent !== undefined && agent !== null) return null; // never redirect a known owner to another lane
  if (options.cwd === undefined) return null;
  const candidates = worktrees.listWorktrees().filter((lane) => lane.path === options.cwd && lane.status !== 'swept');
  if (candidates.length > 1) throw new WorkflowSessionError(`ambiguous registered workflow lane at ${options.cwd}`);
  return candidates[0] ?? null;
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
    if (lane.kind !== 'job' || !runsBuildFor(lane) || (options.roleTools !== undefined && !options.roleTools.includes('edit'))) {
      return { cwd: lane.path };
    }
    const reference = readBmadRuntimeBinding(lane.path, storeRoot);
    let managed: ManagedSkillSet;
    try {
      managed = bind(lane.path);
    } catch (error) {
      if (reference !== null) {
        throw new WorkflowSessionError(`job ${lane.jobId} retains workflow ${reference.id} at ${reference.dir}; restore that exact retained package and retry the same worker/lane. ${String(error)}`, error);
      }
      throw error;
    }
    // Historical schema-1 workflows retain their own skill/config/output contract.
    if (managed.source !== WORKFLOW_SOURCE) return { cwd: lane.path, managedSkills: managed };
    const artifacts = createArtifactContext({ dataDir, worktree: lane,
      workflow: { id: managed.runtimeId, sha256: managed.contentSha256 } });
    const context: WorkflowContext = {
      projectId: artifacts.projectKey, projectRoot: lane.repoPath, worktreeRoot: lane.path,
      jobId: artifacts.jobId, artifactRoot: artifacts.operationalDirectory, knowledgeRoot: artifacts.knowledgeDirectory,
    };
    artifacts.writeOperational({ path: 'workflow-context.json', contents: `${JSON.stringify(context, null, 2)}\n`, sources: [] });
    const invocation = renderWorkflow({ id: managed.runtimeId, dir: managed.root, contentSha256: managed.contentSha256,
      skillsDir: managed.skillsDir, skills: managed.skills }, context);
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
