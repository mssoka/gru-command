import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../bmad/runtime.js';
import type { StreamFrame } from './stream-json.js';
import { isVerificationProducer, verificationShellQuote, workerVerificationRefusal, type WorkerVerificationPolicy } from './worker-verification-policy.js';

/** Private files survive disposal until every original policy child closes.
 * Normal discovery, model and auth remain untouched. The native ask rule
 * routes Bash to the host even in bypass mode; the hook only explains. */
export function privateClaudeVerificationSettings(policy: WorkerVerificationPolicy): {
  readonly file: string;
  dispose(): void;
} {
  return privateClaudeAskSettings(['Bash'], policy, 'gru-worker-verification-');
}

/** Private settings whose native `ask` rule routes each listed tool to the
 * stdio host, even under bypassPermissions. A worker-verification policy
 * adds its Bash hook (the explanation). Shared by verification lanes and
 * directive turns (#424). */
export function privateClaudeAskSettings(ask: readonly string[], policy: WorkerVerificationPolicy | undefined, prefix: string): {
  readonly file: string;
  dispose(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    const file = join(dir, 'settings.json');
    let hooks: Record<string, unknown> | undefined;
    if (policy !== undefined) {
      const policyFile = join(dir, 'policy.json');
      writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600, flag: 'wx' });
      const hook = join(PACKAGE_ROOT, 'dist/runtime/worker-verification-hook.js');
      const command = [process.execPath, hook, policyFile].map(verificationShellQuote).join(' ');
      hooks = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] };
    }
    writeFileSync(file, JSON.stringify({ permissions: { ask: [...ask] }, ...(hooks === undefined ? {} : { hooks }) }), { mode: 0o600, flag: 'wx' });
    return { file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** One supported stdio permission transport, bound to the original child.
 * No permission updates or tools are granted. Allowed input is returned
 * unchanged; malformed/foreign/repeated requests fail closed. */
export class ClaudeVerificationPermissionChannel {
  private readonly initializeId = randomUUID();
  private readonly requests = new Set<string>();
  private readonly toolUses = new Set<string>();
  private initialized = false;
  private closed = false;

  constructor(
    private readonly child: ChildProcess,
    private readonly policy: WorkerVerificationPolicy,
    private readonly fail: (message: string) => void,
    private readonly ready: () => void,
  ) {
    child.once('close', () => { this.closed = true; });
    child.once('error', () => { this.closed = true; });
    child.stdin?.on('error', () => this.fail('worker verification permission transport failed'));
  }

  start(): void {
    this.write({ type: 'control_request', request_id: this.initializeId, request: { subtype: 'initialize' } });
  }

  ingest(frame: StreamFrame): void {
    // Pipelining must not silently turn an unanswered initialization into a
    // healthy terminal turn, even when the model never requested Bash.
    if (frame['type'] === 'result' && (!this.initialized || this.closed)) {
      this.fail('worker verification permission initialization did not complete before result');
      return;
    }
    if (frame['type'] === 'control_response') {
      const response = frame['response'] as Record<string, unknown> | undefined;
      if (response?.['request_id'] !== this.initializeId || response['subtype'] !== 'success' || this.initialized || this.closed) {
        this.fail('worker verification permission initialization failed');
        return;
      }
      this.initialized = true;
      this.ready();
      return;
    }
    if (frame['type'] !== 'control_request') return;
    const id = frame['request_id'];
    const request = frame['request'] as Record<string, unknown> | undefined;
    const input = request?.['input'];
    const toolUse = request?.['tool_use_id'];
    const valid = this.initialized && !this.closed && typeof id === 'string' && id !== '' && !this.requests.has(id) &&
      request?.['subtype'] === 'can_use_tool' && request['tool_name'] === 'Bash' &&
      typeof toolUse === 'string' && toolUse !== '' && !this.toolUses.has(toolUse) &&
      input !== null && typeof input === 'object' && !Array.isArray(input) &&
      typeof (input as Record<string, unknown>)['command'] === 'string';
    if (!valid) {
      if (typeof id === 'string' && id !== '' && !this.closed) this.write({ type: 'control_response', response: {
        subtype: 'success', request_id: id, response: { behavior: 'deny', message: 'Malformed or foreign worker verification permission request' },
      } });
      this.fail('malformed or foreign worker verification permission request');
      return;
    }
    this.requests.add(id as string);
    this.toolUses.add(toolUse as string);
    const denied = isVerificationProducer((input as Record<string, string>)['command']!, this.policy);
    this.write({ type: 'control_response', response: {
      subtype: 'success', request_id: id,
      response: denied ? { behavior: 'deny', message: workerVerificationRefusal(this.policy) } : { behavior: 'allow', updatedInput: input },
    } });
  }

  private write(frame: StreamFrame): void {
    if (this.closed || this.child.stdin == null || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
      this.fail('worker verification permission transport is unavailable');
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error != null) this.fail('worker verification permission transport failed');
      });
    } catch {
      this.fail('worker verification permission transport failed');
    }
  }
}
