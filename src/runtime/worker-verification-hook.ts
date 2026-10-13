#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isVerificationProducer, workerVerificationRefusal, type WorkerVerificationPolicy } from './worker-verification-policy.js';

/**
 * Claude Code PreToolUse hook: deny a Bash call that would start a known
 * unscheduled verification producer, explaining the supported next action.
 * It returns `{}` (no decision) for every other tool and command, so reads,
 * Git operations and the authenticated capture helper run normally.
 */
export function workerVerificationHook(input: unknown, policy: WorkerVerificationPolicy): unknown {
  const event = input as { readonly tool_name?: unknown; readonly tool_input?: { readonly command?: unknown } } | null;
  const command = event?.tool_input?.command;
  if (event?.tool_name !== 'Bash' || typeof command !== 'string' || !isVerificationProducer(command, policy)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: workerVerificationRefusal(policy),
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = process.argv[2];
    if (file === undefined) throw new Error('worker verification hook requires its host-owned policy file');
    const policy = JSON.parse(readFileSync(file, 'utf8')) as WorkerVerificationPolicy;
    const input = JSON.parse(readFileSync(0, 'utf8')) as unknown;
    process.stdout.write(`${JSON.stringify(workerVerificationHook(input, policy))}\n`);
  } catch {
    // Never echo arbitrary input/settings bytes. Exit 2 is Claude's blocking
    // hook error; native permission denies independently cover the known forms.
    process.stderr.write('Minion verification policy hook failed; use the authenticated scheduled capture helper and declared scopes.\n');
    process.exitCode = 2;
  }
}
