import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../bmad/runtime.js';
import { verificationShellQuote, type WorkerVerificationPolicy } from './worker-verification-policy.js';

/**
 * Native Bash deny catalogue for the known producer forms. These rules are
 * anchored at the command start (the executable position) and are the
 * independent fallback that still holds when the explanatory hook fails or
 * is unavailable — a healthy hook never becomes the only enforcement.
 */
export function claudeVerificationDenyRules(policy: WorkerVerificationPolicy): readonly string[] {
  const rules = new Set<string>();
  for (const prefix of policy.producerPrefixes) {
    const form = prefix.join(' ');
    rules.add(`Bash(${form})`);
    rules.add(`Bash(${form} *)`);
  }
  return [...rules];
}

/**
 * Private per-handle settings + policy files for one normal (non-review)
 * session. They are removed exactly when the handle that owns them is
 * disposed, the same lifecycle as the review settings file; normal Claude
 * discovery, model and auth stay untouched.
 */
export function privateClaudeVerificationSettings(policy: WorkerVerificationPolicy): {
  readonly file: string;
  readonly denyRules: readonly string[];
  dispose(): void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'gru-worker-verification-'));
  try {
    const policyFile = join(dir, 'policy.json');
    const file = join(dir, 'settings.json');
    const denyRules = claudeVerificationDenyRules(policy);
    writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600, flag: 'wx' });
    const hook = join(PACKAGE_ROOT, 'dist/runtime/worker-verification-hook.js');
    const command = [process.execPath, hook, policyFile].map(verificationShellQuote).join(' ');
    writeFileSync(file, JSON.stringify({
      permissions: { deny: denyRules },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command }] }] },
    }), { mode: 0o600, flag: 'wx' });
    return { file, denyRules, dispose: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
