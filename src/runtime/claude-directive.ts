import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { privateClaudeAskSettings } from './claude-verification-settings.js';
import { thrownDetail, thrownText } from './directive-checkpoint.js';
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
  private escalation: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly child: ChildProcess,
    private readonly deps: {
      /** Ends the turn. `refused` is what `refused()` returned when this
       * failure follows the channel's own deny; the host reports the turn's
       * failure from it (the deny, or an earlier failure still owed). A
       * transport or protocol failure names no report and reports itself. */
      readonly fail: (message: string, refused?: unknown) => void;
      /** Handling one of the channel's failures threw: the host's `refused()`
       * or `fail()` (#485). The Claude host's don't throw in production (its
       * logger swallows its own faults, the guard receipt's journal faults are
       * caught and retried at cessation, the turn's failure is recorded in
       * memory, and emit() isolates listeners), so this is a backstop for a GC
       * bug. It is GC's own directive control failing: after `refused()`
       * throws, the host fails the turn with a refusal of `reason`, tagged, or
       * with the failure the turn already owes (a directive turn reports its
       * first failure). After `fail()` throws, the turn's failure is already
       * set (the text `fail()` was given), so this adds nothing but ending the
       * CLI. If this throws too, the channel ends the CLI itself. */
      readonly failRefused: (reason: string) => void;
      /** A tool request this channel denied itself (malformed or foreign, or a
       * fence that failed), once the deny is handed to the CLI's stdin: the
       * host keeps a durable refusal of it, and returns an opaque report the
       * channel hands back to `fail()`. */
      readonly refused: (toolUseId: string | undefined, reason: string) => unknown;
      /** Called once per tool request, after the request frame is durable. */
      readonly decide: (request: ClaudeToolRequest, durable: Promise<void>) => Promise<ClaudeToolDecision>;
      /** Called as an allow is written: the decision written instead (#485).
       * A throw is a fence that failed. */
      readonly confirm: (request: ClaudeToolRequest) => ClaudeToolDecision;
      /** An error-level log line (#485). */
      readonly log: (message: string, fields: Readonly<Record<string, unknown>>) => void;
      /** How long a CLI the channel ends itself has after SIGTERM before SIGKILL. */
      readonly killGraceMs: number;
      readonly verification?: WorkerVerificationPolicy;
    },
  ) {
    child.once('close', () => { this.closed = true; });
    child.once('error', () => { this.closed = true; });
    child.stdin?.on('error', () => this.fail('directive permission transport failed'));
  }

  start(): void {
    this.write({ type: 'control_request', request_id: this.initializeId, request: { subtype: 'initialize' } }, false);
  }

  /** `durable` settles once this frame is written and synced to the transcript. */
  ingest(frame: StreamFrame, durable: Promise<void>): void {
    if (frame['type'] === 'result' && (!this.initialized || this.closed)) {
      this.fail('directive permission initialization did not complete before result');
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
      this.fail('foreign or repeated directive permission response');
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
      if (typeof id === 'string' && id !== '' && !this.closed &&
          this.respond(id, { behavior: 'deny', message: 'Malformed or foreign directive permission request' })) {
        this.refuse(undefined, 'malformed or foreign directive permission request');
      } else this.fail('malformed or foreign directive permission request');
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
        let decision: ClaudeToolDecision;
        try {
          // A failure recorded since the fence passed still denies the allow.
          decision = decided.allow ? this.deps.confirm(tool) : decided;
        } catch (error) {
          // A re-check that throws is a fence that failed, never an unhandled rejection (#485).
          this.fenceFailed(id as string, tool, error);
          return;
        }
        this.respond(id as string, decision.allow ? { behavior: 'allow', updatedInput: tool.input } : { behavior: 'deny', message: decision.message });
      },
      (error: unknown) => this.fenceFailed(id as string, tool, error),
      // The chain's last guard: no channel promise ends in an unhandled rejection (#485).
    ).catch((error: unknown) => this.handlingThrew(`deciding tool request ${tool.toolUseId}`, error));
  }

  /** The fence could not decide: deny the tool, keep a durable refusal of it, and end the turn. */
  private fenceFailed(requestId: string, tool: ClaudeToolRequest, error: unknown): void {
    const reason = `directive tool fence failed: ${thrownText(error)}`;
    if (!this.closed && this.respond(requestId, { behavior: 'deny', message: 'The directive tool fence failed' })) this.refuse(tool.toolUseId, reason);
    else this.fail(reason);
  }

  /** A deny the channel handed to the CLI: the host keeps its refusal, then the turn ends. */
  private refuse(toolUseId: string | undefined, reason: string): void {
    let report: unknown;
    try {
      report = this.deps.refused(toolUseId, reason);
    } catch (error) {
      this.handlingThrew(reason, error);
      return;
    }
    this.fail(reason, report);
  }

  /** Every failure the channel reports goes through here: no channel callback
   * throws (#485). */
  private fail(message: string, refused?: unknown): void {
    try {
      this.deps.fail(message, refused);
    } catch (error) {
      this.handlingThrew(message, error);
    }
  }

  /** Handling `failure` threw (the host's `refused()` or `fail()`; #485): a
   * backstop for a GC bug (see `failRefused`). The log names both; the host
   * fails the turn as GC's own refusal; if that throws as well, the channel
   * ends the CLI itself. Never throws. */
  private handlingThrew(failure: string, error: unknown): void {
    try {
      this.deps.log('claude directive permission handling threw; the turn is refused', { failure, error: thrownDetail(error) });
    } catch { /* the turn still fails */ }
    try {
      this.deps.failRefused(`directive permission handling failed: ${thrownText(error)}`);
    } catch {
      this.endCli();
    }
  }

  /** Ends the CLI when the host cannot, as the host's abort does: its stdin,
   * SIGTERM, then SIGKILL after the grace (armed once). */
  private endCli(): void {
    try { this.child.stdin?.end(); } catch { /* already closed */ }
    try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    if (this.escalation !== null || this.closed) return;
    const escalation = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* already gone */ } }, this.deps.killGraceMs);
    escalation.unref();
    this.escalation = escalation;
    this.child.once('close', () => clearTimeout(escalation));
  }

  /** Whether the response was handed to the CLI. */
  private respond(requestId: string, response: Record<string, unknown>): boolean {
    return this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }, true);
  }

  private write(frame: StreamFrame, echoed: boolean): boolean {
    if (this.closed || this.child.stdin == null || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      this.fail('directive permission transport is unavailable');
      return false;
    }
    if (echoed) this.echoes.push(frame);
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error != null) this.fail('directive permission transport failed');
      });
      return true;
    } catch {
      this.fail('directive permission transport failed');
      return false;
    }
  }
}
