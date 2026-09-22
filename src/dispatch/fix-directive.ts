import type { Role } from '../config.js';
import type { LedgerApi } from '../ledger/api.js';
import type { AgentHandle, SpawnOptions } from '../runtime/types.js';
import { requireSpawnCwd } from '../roles.js';
import { resolveGitCommit } from './perkins-review/artifacts.js';
import type { WorktreePort } from './worktree-port.js';

/**
 * Fix-directive routing (E8 follow-through; owner ruling 2026-09-21): the
 * mechanics of reaching a job's implementing minion. One implementation,
 * two doors — the bmad-review fallback gate's fixDirectiveSink and the
 * silas ops surface — so "route a directive to the minion" can never drift
 * between them.
 */

/** The registry surface directive routing needs (structural — the real
 * RuntimeRegistry satisfies it; tests drive a controllable fake). */
export interface DirectiveRegistry {
  getHandle(agentId: string): AgentHandle | null;
  spawn(role: Role, options?: SpawnOptions): Promise<AgentHandle>;
  disposeHandle(handle: AgentHandle): Promise<void>;
}

export interface DirectiveRoutingDeps {
  readonly registry: DirectiveRegistry;
  readonly ledger: Pick<LedgerApi, 'listAgents' | 'registerAgent'>;
  readonly worktrees: WorktreePort;
}

/** Route a directive to the implementing minion: the live job minion
 * first; otherwise a fresh minion on the job lane. */
export async function routeFixDirectiveToMinion(
  input: DirectiveRoutingDeps & {
    jobId: string;
    directive: string;
    signal: AbortSignal;
    /** Prompt owner tag (audit); defaults to the shared routing owner. */
    owner?: string;
  },
): Promise<{ delivered: boolean; minionId?: string; note?: string }> {
  const owner = input.owner ?? 'fix-directive';
  const minions = input.ledger
    .listAgents()
    .filter((agent) => agent.jobId === input.jobId && agent.role === 'minion');
  for (const minion of [...minions].reverse()) {
    const handle = input.registry.getHandle(minion.id);
    if (handle !== null) {
      await racedPrompt(handle, input.directive, input.signal, owner);
      return { delivered: true, minionId: minion.id };
    }
  }
  const lane = input.worktrees
    .listWorktrees({ jobId: input.jobId })
    .find((candidate) => candidate.kind === 'job');
  if (lane === undefined) {
    return { delivered: false, note: 'no implementing minion session and no job lane' };
  }
  const handle = await input.registry.spawn('minion', { cwd: lane.path });
  try {
    await racedPrompt(handle, input.directive, input.signal, owner);
  } finally {
    await handle.dispose();
  }
  return { delivered: true, minionId: handle.id };
}

/** Race a prompt against cancellation so shutdown cannot stall on an
 * in-flight fix-directive turn. */
function racedPrompt(handle: { prompt(text: string, options?: { owner?: string }): Promise<void> }, text: string, signal: AbortSignal, owner: string): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('review operation aborted'));
  return Promise.race([
    handle.prompt(text, { owner }),
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('review operation aborted')), { once: true });
    }),
  ]);
}

/**
 * The follow-up delivery signal (the loop's close, not a blind re-fire):
 * a settled directive or re-brief minion turn IS the implementing minion's
 * delivery. Record it as `job.delivered` — the same event the initial
 * briefing turn records — carrying the lane head the turn produced. The
 * digest's freshness predicate reads that sha against the round's reviewed
 * target: a moved head warrants the re-review; the same head does not.
 */
export function recordFollowUpDelivery(input: {
  readonly ledger: Pick<LedgerApi, 'appendCustomEvent'>;
  readonly worktrees: Pick<WorktreePort, 'listWorktrees'>;
  readonly jobId: string;
  readonly agentId: string | null;
  readonly source: 'silas-directive' | 'silas-rebrief';
}): { readonly sha: string | null; readonly lanePath: string | null; readonly note: string | null } {
  const jobLanes = input.worktrees.listWorktrees({ jobId: input.jobId }).filter((lane) => lane.kind === 'job');
  const lane = jobLanes.find((candidate) => candidate.status !== 'swept') ?? jobLanes[0];
  let sha: string | null = null;
  let note: string | null = null;
  if (lane !== undefined) {
    try {
      sha = resolveGitCommit(lane.path, lane.branch !== null && lane.branch !== '' ? lane.branch : 'HEAD');
    } catch (error) {
      // The turn settled — the delivery stands; a head we cannot resolve only
      // means the digest cannot prove a move, so no phantom re-review fires.
      note = `lane head unresolved: ${String(error).slice(0, 200)}`;
    }
  } else {
    note = 'no job lane in the registry to resolve a head from';
  }
  input.ledger.appendCustomEvent({
    kind: 'job.delivered',
    jobId: input.jobId,
    payload: { agentId: input.agentId, source: input.source, sha },
  });
  return { sha, lanePath: lane?.path ?? null, note };
}

/** Render the prompt handed to a FRESH minion taking over a stuck lane:
 * the original briefing (still the contract) plus the re-brief note. */
export function renderRebriefPrompt(input: {
  jobId: string;
  briefing: string | null;
  note: string;
}): string {
  return [
    `Re-brief — job ${input.jobId}`,
    '',
    'A fresh worker is taking over this lane. The prior attempts stalled on',
    'the same blocker; the loop is re-opened with a clean session.',
    '',
    'RE-BRIEF NOTE (why you are here, what to do differently):',
    input.note,
    '',
    'ORIGINAL BRIEFING (still the contract):',
    input.briefing ?? '(the job row carries no stored briefing — read the job note on the board)',
    '',
    'Execute the briefing inside this worktree. Standing orders: work only',
    'inside this tree; commit your work to the branch; verify it (build,',
    'tests, lint — whatever this project calls green) before finishing;',
    'never merge your own pull request. End with a completion report.',
  ].join('\n');
}

/** Re-brief a FRESH minion on the job's lane (the second rung of the
 * recurrence ladder): live minion handles for the job are disposed first
 * (their sessions are preserved on disk — only the live handles go), then
 * a new minion is spawned rooted in the SAME worktree with the re-brief. */
export async function rebriefFreshMinion(
  input: DirectiveRoutingDeps & {
    jobId: string;
    note: string;
    briefing: string | null;
  },
): Promise<{ minionId: string; lanePath: string; prompt: string }> {
  const jobMinions = input.ledger
    .listAgents()
    .filter((agent) => agent.jobId === input.jobId && agent.role === 'minion');
  for (const minion of jobMinions) {
    const handle = input.registry.getHandle(minion.id);
    if (handle === null) continue;
    await input.registry.disposeHandle(handle).catch((error: unknown) => {
      throw new Error(
        `could not retire the prior minion session ${minion.id} before re-briefing: ${String(error)}`,
      );
    });
  }
  const lane = input.worktrees
    .listWorktrees({ jobId: input.jobId })
    .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
  if (lane === undefined) {
    throw new Error(`job "${input.jobId}" has no active job lane — a re-brief needs its worktree`);
  }
  const cwd = requireSpawnCwd('minion', lane.path);
  const handle = await input.registry.spawn('minion', { cwd });
  input.ledger.registerAgent({
    id: handle.id,
    role: 'minion',
    sessionFile: handle.sessionFile,
    jobId: input.jobId,
  });
  const prompt = renderRebriefPrompt({ jobId: input.jobId, briefing: input.briefing, note: input.note });
  try {
    await handle.prompt(prompt, { owner: `silas-rebrief:${input.jobId}` });
  } catch (error) {
    throw new Error(`re-brief turn failed on ${handle.id}: ${String(error)}`);
  }
  return { minionId: handle.id, lanePath: lane.path, prompt };
}
