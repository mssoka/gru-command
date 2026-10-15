import { createHash } from 'node:crypto';
import type { LedgerApi } from '../ledger/api.js';
import type { SilasOpsDigest } from './silas-driver.js';
import type { AgentHandle, NativeAgentTool, NativeAgentToolResult } from '../runtime/types.js';

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

export function createSilasModelActionTool(deps: SilasModelActionToolDeps): NativeAgentTool {
  return {
    name: SILAS_MODEL_ACTION_TOOL,
    description:
      'Record ONE Silas arbitration action (dispatch | escalate | hold) for a canonical job. ' +
      'The host binds it to the live model turn, the observed digest and the actual job row, ' +
      'and returns a durable action id.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        jobId: { type: 'string' },
        family: { type: 'string' },
        debt: { type: 'string' },
        head: { type: 'string' },
        rationale: { type: 'string' },
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
          head: str(args['head']),
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
