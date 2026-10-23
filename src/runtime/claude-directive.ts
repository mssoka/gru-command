import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { privateClaudeAskSettings } from './claude-verification-settings.js';
import { thrownText } from './directive-checkpoint.js';
import type { StreamFrame } from './stream-json.js';
import { isVerificationProducer, workerVerificationRefusal, type WorkerVerificationPolicy } from './worker-verification-policy.js';

/**
 * Claude Code directive turns (#424, owner ruling 2026-10-16: exact proof,
 * never resume). A directive turn routes EVERY tool through the CLI's stdio
 * permission prompt (a native `ask` rule reaches the host even under
 * bypassPermissions), so the host allows a tool only after its exact intent
 * is durably in the transcript and the directive's authority still holds.
 */

/** A directive turn's CLI environment (#471): no background tasks. The CLI
 * waits for a running task after the turn's result and then answers its
 * completion in an unprompted turn of its own, after the directive is over
 * and with no host left to decide its tools. It rides in the turn's own
 * `--settings` env, which outranks a user, project or local settings `env`
 * (probed on Claude Code 2.1.306); a switch in the process environment is
 * overridden by any of them. Managed policy settings still outrank it. The
 * switch also stops the CLI from moving a long foreground command to the
 * background, which no tool input would show. */
export const CLAUDE_DIRECTIVE_ENV: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };

/** Private settings for one directive turn: every listed tool asks the host,
 * and background tasks are off. A worker-verification lane keeps its Bash
 * hook (the explanation). */
export function privateClaudeDirectiveSettings(tools: readonly string[], verification?: WorkerVerificationPolicy): {
  readonly file: string;
  dispose(): void;
} {
  return privateClaudeAskSettings(tools, verification, 'gru-directive-', CLAUDE_DIRECTIVE_ENV);
}

export interface ClaudeToolRequest {
  readonly toolUseId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export type ClaudeToolDecision = { readonly allow: true } | { readonly allow: false; readonly message: string };

/**
 * The stdio permission transport of one directive turn, bound to its own
 * child. Every tool request is decided by the host (`decide`); allowed input
 * is returned unchanged and no permission update is ever granted. The CLI
 * runs with --replay-user-messages, so each response the host writes comes
 * back once as an echo; anything else (a foreign response, a repeated or
 * malformed request, an unknown control subtype) fails the turn closed.
 */
export class ClaudeDirectivePermissionChannel {
  private readonly initializeId = randomUUID();
  private readonly requests = new Set<string>();
  private readonly toolUses = new Set<string>();
  private readonly echoes: StreamFrame[] = [];
  private initialized = false;
  private closed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly deps: {
      /** Ends the turn. `refused` is what `refused()` returned when this
       * failure follows the channel's own deny; the host reports the turn's
       * failure from it (the deny, or an earlier failure still owed). */
      readonly fail: (message: string, refused?: unknown) => void;
      /** A tool request this channel denied itself (malformed or foreign, or a
       * fence that failed), once the deny is handed to the CLI's stdin: the
       * host keeps a durable refusal of it, and returns an opaque report the
       * channel hands back to `fail()`. */
      readonly refused: (toolUseId: string | undefined, reason: string) => unknown;
      /** Called once per tool request, after the request frame is durable. */
      readonly decide: (request: ClaudeToolRequest, durable: Promise<void>) => Promise<ClaudeToolDecision>;
      /** Called as an allow is written: the decision written instead (#485). */
      readonly confirm: (request: ClaudeToolRequest) => ClaudeToolDecision;
      readonly verification?: WorkerVerificationPolicy;
    },
  ) {
    child.once('close', () => { this.closed = true; });
    child.once('error', () => { this.closed = true; });
    child.stdin?.on('error', () => this.deps.fail('directive permission transport failed'));
  }

  start(): void {
    this.write({ type: 'control_request', request_id: this.initializeId, request: { subtype: 'initialize' } }, false);
  }

  /** `durable` settles once this frame is written and synced to the transcript. */
  ingest(frame: StreamFrame, durable: Promise<void>): void {
    if (frame['type'] === 'result' && (!this.initialized || this.closed)) {
      this.deps.fail('directive permission initialization did not complete before result');
      return;
    }
    if (frame['type'] === 'control_response') {
      const response = frame['response'] as Record<string, unknown> | undefined;
      if (!this.initialized && response?.['request_id'] === this.initializeId && response['subtype'] === 'success') {
        this.initialized = true;
        return;
      }
      const echo = this.echoes.findIndex((written) => isDeepStrictEqual(written, frame));
      if (echo >= 0) { this.echoes.splice(echo, 1); return; }
      this.deps.fail('foreign or repeated directive permission response');
      return;
    }
    if (frame['type'] !== 'control_request') return;
    const id = frame['request_id'];
    const request = frame['request'] as Record<string, unknown> | undefined;
    const input = request?.['input'];
    const toolUse = request?.['tool_use_id'];
    const toolName = request?.['tool_name'];
    const valid = this.initialized && !this.closed && typeof id === 'string' && id !== '' && !this.requests.has(id) &&
      request?.['subtype'] === 'can_use_tool' && typeof toolName === 'string' && toolName !== '' &&
      typeof toolUse === 'string' && toolUse !== '' && !this.toolUses.has(toolUse) &&
      input !== null && typeof input === 'object' && !Array.isArray(input);
    if (!valid) {
      // Only a deny handed to the CLI's stdin is a refusal.
      let report: unknown;
      if (typeof id === 'string' && id !== '' && !this.closed &&
          this.respond(id, { behavior: 'deny', message: 'Malformed or foreign directive permission request' })) {
        report = this.deps.refused(undefined, 'malformed or foreign directive permission request');
      }
      this.deps.fail('malformed or foreign directive permission request', report);
      return;
    }
    this.requests.add(id as string);
    this.toolUses.add(toolUse as string);
    const tool: ClaudeToolRequest = { toolUseId: toolUse as string, toolName: toolName as string, input: input as Record<string, unknown> };
    // The lane's verification policy refuses known producers before any fence.
    if (this.deps.verification !== undefined && tool.toolName === 'Bash' && typeof tool.input['command'] === 'string' &&
        isVerificationProducer(tool.input['command'], this.deps.verification)) {
      this.respond(id as string, { behavior: 'deny', message: workerVerificationRefusal(this.deps.verification) });
      return;
    }
    this.deps.decide(tool, durable).then(
      (decided) => {
        // A failure recorded since the fence passed still denies the allow.
        const decision = decided.allow ? this.deps.confirm(tool) : decided;
        this.respond(id as string, decision.allow ? { behavior: 'allow', updatedInput: tool.input } : { behavior: 'deny', message: decision.message });
      },
      (error: unknown) => {
        const reason = `directive tool fence failed: ${thrownText(error)}`;
        let report: unknown;
        if (!this.closed && this.respond(id as string, { behavior: 'deny', message: 'The directive tool fence failed' })) {
          report = this.deps.refused(tool.toolUseId, reason);
        }
        this.deps.fail(reason, report);
      },
    );
  }

  /** Whether the response was handed to the CLI. */
  private respond(requestId: string, response: Record<string, unknown>): boolean {
    return this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }, true);
  }

  private write(frame: StreamFrame, echoed: boolean): boolean {
    if (this.closed || this.child.stdin == null || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      this.deps.fail('directive permission transport is unavailable');
      return false;
    }
    if (echoed) this.echoes.push(frame);
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error != null) this.deps.fail('directive permission transport failed');
      });
      return true;
    } catch {
      this.deps.fail('directive permission transport failed');
      return false;
    }
  }
}
