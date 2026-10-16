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

/** A spawn carries a handful of native tools; a slot count past this is no tool list. */
const MAX_NATIVE_TOOLS = 256;
/** Bounds on the model's free text (#369): the record is advisory audit
 * material, so an over-long field is refused by name, never truncated.
 * Lengths are in code points — the unit JSON Schema `maxLength` counts. */
export const SILAS_ACTION_LIMITS = { jobId: 200, family: 128, debt: 128, rationale: 2000 } as const;
const BOUNDED_FIELDS = Object.keys(SILAS_ACTION_LIMITS) as readonly (keyof typeof SILAS_ACTION_LIMITS)[];
const HEAD_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
/** Characters that never enter the audit record: every control (Cc),
 * format (Cf — bidi overrides and isolates, zero-width spaces, tags), line or
 * paragraph separator (Zl/Zp), private-use (Co) and unassigned (Cn) code
 * point. The zero-width joiner and non-joiner are the exception: emoji
 * sequences and Indic or Persian text need them, and they cannot reorder or
 * hide a line. The rationale alone may carry tabs and line feeds; a carriage
 * return could overwrite a rendered line, so it never may. Unassigned (Cn)
 * is judged by this runtime's Unicode tables: fail-closed — a code point with
 * no defined rendering is refused until the runtime knows it. */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu;
const JOINERS: ReadonlySet<string> = new Set(['\u200c', '\u200d']);
const hasUnsafeText = (value: string, allowBreaks: boolean): boolean =>
  [...value.matchAll(UNSAFE_TEXT)].some(([char]) => !JOINERS.has(char) && !(allowBreaks && (char === '\t' || char === '\n')));

/** What a bounded text field may not carry — stated once, for the schema
 * the model reads and for the refusal it gets. */
const UNSAFE_TEXT_RULE = 'control, format, separator, private-use or unassigned characters (zero-width joiners allowed)';
const TEXT_RULE = `non-blank; length in code points; no ${UNSAFE_TEXT_RULE}`;
/** Characters that render as nothing — every default-ignorable code point
 * (joiners, Hangul fillers, variation selectors…) and the blank Braille
 * pattern: a value made only of these (and whitespace) is blank. */
const INVISIBLE_FILLERS = /[\p{Default_Ignorable_Code_Point}\u2800]/gu;

/** Why a present bounded field is unusable, or null when it is fine. */
function boundedFieldProblem(field: keyof typeof SILAS_ACTION_LIMITS, value: unknown): string | null {
  const limit = SILAS_ACTION_LIMITS[field];
  // Joiners and filler characters render as nothing: they never make a value non-blank.
  if (typeof value !== 'string' || value.replace(INVISIBLE_FILLERS, '').trim() === '') return `${field} must be a non-blank string`;
  // A lone surrogate is no character a reader can see, and no UTF-8 text.
  if (/\p{Surrogate}/u.test(value)) return `${field} must be well-formed Unicode`;
  if ([...value].length > limit) return `${field} must be at most ${String(limit)} characters`;
  if (hasUnsafeText(value, field === 'rationale')) return `${field} must not contain ${UNSAFE_TEXT_RULE}`;
  return null;
}

export function createSilasModelActionTool(deps: SilasModelActionToolDeps): NativeAgentTool {
  return {
    name: SILAS_MODEL_ACTION_TOOL,
    description:
      'Record ONE ADVISORY Silas arbitration action (dispatch | escalate | hold) for a canonical job. ' +
      'It executes nothing: the host only binds the record to the live model turn, the observed digest ' +
      'and the actual job row, and returns a durable action id. Perform the operation through its own ' +
      'endpoint. Free text is bounded (rationale ' + String(SILAS_ACTION_LIMITS.rationale) + ' chars) and ' +
      'head must be a full lowercase commit SHA (40 or 64 hex characters).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        jobId: { type: 'string', minLength: 1, maxLength: SILAS_ACTION_LIMITS.jobId, description: TEXT_RULE },
        family: { type: 'string', minLength: 1, maxLength: SILAS_ACTION_LIMITS.family, description: TEXT_RULE },
        debt: { type: 'string', minLength: 1, maxLength: SILAS_ACTION_LIMITS.debt, description: TEXT_RULE },
        head: { type: 'string', pattern: HEAD_SHA.source, description: 'full lowercase commit SHA (40 or 64 hex characters)' },
        rationale: { type: 'string', minLength: 1, maxLength: SILAS_ACTION_LIMITS.rationale, description: `${TEXT_RULE}; tabs and line feeds allowed` },
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
      // No arguments at all reads as an empty object (refused below for its
      // missing action); any other non-object input is refused by name.
      const raw: unknown = input ?? {};
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return refusal('bad-input', 'the tool input must be a JSON object');
      }
      const args = raw as Record<string, unknown>;
      const action = str(args['action']);
      if (action === null || !ACTIONS.includes(action as SilasModelActionKind)) {
        return refusal('bad-action', `action must be one of ${ACTIONS.join('|')}`);
      }
      const jobId = str(args['jobId']);
      if (jobId === null) return refusal('bad-job', 'jobId is required');
      for (const field of BOUNDED_FIELDS) {
        const problem = args[field] === undefined ? null : boundedFieldProblem(field, args[field]);
        if (problem !== null) return refusal('bad-field', problem);
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
  const supplied: unknown = spawnOptions?.nativeTools ?? [];
  if (!Array.isArray(supplied)) return Promise.reject(new TypeError('spawn options nativeTools must be an array of named native tools'));
  // Read once, every slot (holes included), each slot and name exactly once:
  // a hostile array or getter is refused by index, never a raw throw, and
  // what was checked is what is spawned.
  let slots: number;
  try { slots = supplied.length; } catch { return Promise.reject(new TypeError('spawn options nativeTools cannot be read')); }
  if (slots > MAX_NATIVE_TOOLS) return Promise.reject(new TypeError(`spawn options nativeTools has ${String(slots)} slots (at most ${String(MAX_NATIVE_TOOLS)})`));
  const callerTools: NativeAgentTool[] = [];
  const names: string[] = [];
  for (let index = 0; index < slots; index += 1) {
    let tool: unknown;
    let name: unknown;
    try {
      tool = supplied[index];
      name = tool === null || typeof tool !== 'object' ? undefined : (tool as { name?: unknown }).name;
    } catch { name = undefined; }
    if (typeof name !== 'string' || name === '') {
      return Promise.reject(new TypeError(`spawn options nativeTools[${String(index)}] must be a native tool with a non-empty string name`));
    }
    callerTools.push(tool as NativeAgentTool);
    names.push(name);
  }
  if (names.includes(SILAS_MODEL_ACTION_TOOL)) {
    return Promise.reject(new Error(
      `the Silas spawn already carries a ${SILAS_MODEL_ACTION_TOOL} tool — each spawn binds its own; pass spawn options without it`,
    ));
  }
  return deps.registry
    .spawn('silas', {
      ...(spawnOptions ?? {}),
      nativeTools: [...callerTools, actionTool],
    })
    .then((handle) => {
      bound = handle;
      return handle;
    });
}
