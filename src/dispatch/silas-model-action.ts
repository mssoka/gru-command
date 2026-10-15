import { createHash } from 'node:crypto';
import type { LedgerApi } from '../ledger/api.js';
import type { SilasOpsDigest } from './silas-driver.js';
import type { Role } from '../config.js';
import type { AgentHandle, NativeAgentTool, NativeAgentToolResult, SpawnOptions } from '../runtime/types.js';

/**
 * Issue #243 H6 — the product-owned native tool a SILAS model turn may call.
 *
 * The closure is built PER SPAWN and bound to that spawn's EXACT handle, so a
 * model turn in one Silas incarnation can never act for whichever incarnation
 * happens to be current later. Identity is host-minted from durable ledger
 * evidence (the live turn owner, the observed digest, the actual job row) and
 * the host-callback invocation id is an EXPLICIT ledger event seq — never the
 * SDK's ephemeral tool-call id, which is neither durable nor recorded here.
 */
export const SILAS_MODEL_ACTION_TOOL = 'silas_action';

export type SilasModelActionKind = 'dispatch' | 'escalate' | 'hold';
const ACTIONS: readonly SilasModelActionKind[] = ['dispatch', 'escalate', 'hold'];

export interface SilasModelActionToolDeps {
  /** The EXACT handle of the spawn this tool belongs to. It is null until the
   * spawn resolves; each spawn's closure assigns its own binding, so a
   * re-spawn produces a distinct tool bound to a distinct incarnation. */
  readonly getHandle: () => AgentHandle | null;
  readonly ledger: LedgerApi;
  /** Canonical read-only digest observed AT INVOCATION time, computed with the
   * SAME seams the driver and the API digest endpoint use. */
  readonly digest: () => Promise<SilasOpsDigest>;
  readonly log?: (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

const refusal = (reason: string, message: string): NativeAgentToolResult => ({
  text: JSON.stringify({ ok: false, reason, message }),
  details: { ok: false, reason },
});

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/** Bounds on the model's free text (#369): the record is advisory audit
 * material, so an over-long field is refused by name, never truncated. */
export const SILAS_ACTION_LIMITS = { jobId: 200, family: 128, debt: 128, rationale: 2000 } as const;
const HEAD_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export function createSilasModelActionTool(deps: SilasModelActionToolDeps): NativeAgentTool {
  return {
    name: SILAS_MODEL_ACTION_TOOL,
    description:
      'Record ONE ADVISORY Silas arbitration action (dispatch | escalate | hold) for a canonical job. ' +
      'It executes nothing: the host only binds the record to the live model turn, the observed digest ' +
      'and the actual job row, and returns a durable action id. Perform the operation through its own ' +
      'endpoint. Free text is bounded (rationale ' + String(SILAS_ACTION_LIMITS.rationale) + ' chars) and ' +
      'head must be a full commit SHA.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        jobId: { type: 'string', maxLength: SILAS_ACTION_LIMITS.jobId },
        family: { type: 'string', maxLength: SILAS_ACTION_LIMITS.family },
        debt: { type: 'string', maxLength: SILAS_ACTION_LIMITS.debt },
        head: { type: 'string', pattern: HEAD_SHA.source },
        rationale: { type: 'string', maxLength: SILAS_ACTION_LIMITS.rationale },
      },
      required: ['action', 'jobId'],
    },
    async execute(input): Promise<NativeAgentToolResult> {
      const handle = deps.getHandle();
      if (handle === null) {
        return refusal('unbound', 'this Silas tool is not bound to a live handle yet');
      }
      const turn = handle.pendingTurn?.() ?? null;
      if (turn === null) {
        return refusal('no-live-turn', 'no live model turn currently owns this session');
      }
      const args = (input ?? {}) as Record<string, unknown>;
      const action = str(args['action']);
      if (action === null || !ACTIONS.includes(action as SilasModelActionKind)) {
        return refusal('bad-action', `action must be one of ${ACTIONS.join('|')}`);
      }
      const jobId = str(args['jobId']);
      if (jobId === null) return refusal('bad-job', 'jobId is required');
      for (const field of ['jobId', 'family', 'debt', 'rationale'] as const) {
        const value = args[field];
        if (value !== undefined && (typeof value !== 'string' || value.length > SILAS_ACTION_LIMITS[field])) {
          return refusal('bad-field', `${field} must be a string of at most ${String(SILAS_ACTION_LIMITS[field])} characters`);
        }
      }
      const head = str(args['head']);
      if (args['head'] !== undefined && (head === null || !HEAD_SHA.test(head))) {
        return refusal('bad-field', 'head must be a full lowercase commit SHA (40 or 64 hex characters)');
      }
      const job = deps.ledger.getJob(jobId);
      if (job === null) return refusal('unknown-job', `no canonical job row for ${jobId}`);
      const digest = await deps.digest();
      const digestSha256 = createHash('sha256').update(JSON.stringify(digest)).digest('hex');
      const observation = deps.ledger.appendCustomEvent({
        kind: 'silas.model-observation',
        agentId: handle.id,
        jobId,
        payload: {
          handle_id: handle.id,
          session_file: handle.sessionFile,
          turn_owner: turn.owner,
          digest_sha256: digestSha256,
          job_id: jobId,
        },
      });
      const actionId = `silas-action:${observation.seq}`;
      const receipt = deps.ledger.appendCustomEvent({
        kind: 'silas.model-action',
        agentId: handle.id,
        jobId,
        payload: {
          action_id: actionId,
          host_callback_invocation_id: observation.seq,
          sdk_tool_call_id: null,
          action,
          job_id: jobId,
          family: str(args['family']),
          debt: str(args['debt']),
          head,
          rationale: str(args['rationale']),
          digest_sha256: digestSha256,
        },
      });
      deps.log?.('info', 'silas model action recorded', {
        action,
        action_id: actionId,
        job: jobId,
        event: receipt.seq,
      });
      return {
        text: JSON.stringify({ ok: true, action_id: actionId, action, job_id: jobId }),
        details: {
          ok: true,
          action_id: actionId,
          host_callback_invocation_id: observation.seq,
          event_seq: receipt.seq,
        },
      };
    },
  };
}

/**
 * The Silas slot's spawn (issue #243 H6, pinned by #368): appends a model-action
 * tool to the caller's native tools and binds it to THIS spawn's handle once
 * the spawn resolves — a re-spawn gets its own tool, never a late lookup of
 * whichever incarnation is current.
 */
export function spawnSilasWithActionTool(
  deps: Omit<SilasModelActionToolDeps, 'getHandle'> & {
    readonly registry: { spawn(role: Role, options?: SpawnOptions): Promise<AgentHandle> };
  },
  spawnOptions?: SpawnOptions,
): Promise<AgentHandle> {
  let bound: AgentHandle | null = null;
  const actionTool = createSilasModelActionTool({
    getHandle: () => bound,
    ledger: deps.ledger,
    digest: deps.digest,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  });
  return deps.registry
    .spawn('silas', {
      ...(spawnOptions ?? {}),
      nativeTools: [...(spawnOptions?.nativeTools ?? []), actionTool],
    })
    .then((handle) => {
      bound = handle;
      return handle;
    });
}
