import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../bmad/runtime.js';
import { isVerificationProducer, verificationShellQuote, type WorkerVerificationPolicy } from './worker-verification-policy.js';

/** Conventional npm verb aliases (review-2/3 parity items). */
const NPM_VERB_ALIASES: Record<string, readonly string[]> = {
  test: ['test', 'tst'],
  run: ['run', 'run-script'],
};
/** Supported npm option positions that may precede the verb/script. */
const NPM_OPTION_PREFIXES: readonly string[] = [
  '', '--workspace web ', '-w web ', '--prefix web ', '--loglevel error ',
];
const NPX_OPTION_PREFIXES: readonly string[] = ['', '--no-install ', '--yes ', '-y '];
/** Known producing verbs of the verb-less catalogue tools (`vitest run …`). */
const PRODUCING_VERBS: Record<string, readonly string[]> = {
  vitest: ['run'], vite: ['build'], playwright: ['test'], jest: [], tsc: [], eslint: [],
};

/**
 * Conventional spellings of one producer prefix. Only the option positions the
 * spec demonstrated are enumerated; arbitrary argument tails stay with the
 * classifier, which owns the precise reading of option/operand positions.
 */
function variantBases(prefix: readonly string[]): readonly string[] {
  const bases = new Set<string>();
  if (prefix[0] === 'npm') {
    const verb = prefix[1] as string;
    const rest = prefix.slice(2).join(' ');
    for (const alias of NPM_VERB_ALIASES[verb] ?? [verb]) {
      for (const option of NPM_OPTION_PREFIXES) {
        const stem = `npm ${option}${alias}`.trim();
        bases.add(stem);
        if (rest !== '') {
          bases.add(`${stem} ${rest}`);
          if (alias.startsWith('r')) bases.add(`${stem} --if-present ${rest}`);
        }
      }
    }
    return [...bases];
  }
  if (prefix[0] === 'npx') {
    const tool = prefix[1] as string;
    const rest = prefix.slice(2).join(' ');
    const suffixes = rest !== '' ? [rest] : (PRODUCING_VERBS[tool] ?? []);
    for (const option of NPX_OPTION_PREFIXES) {
      const stem = `npx ${option}${tool}`.trim();
      bases.add(stem);
      for (const suffix of suffixes) bases.add(`${stem} ${suffix}`);
    }
    return [...bases];
  }
  bases.add(prefix.join(' '));
  const tool = prefix[0] as string;
  if (prefix.length === 1) {
    for (const verb of PRODUCING_VERBS[tool] ?? []) bases.add(`${tool} ${verb}`);
  }
  return [...bases];
}

function escapePattern(form: string): string {
  return form.replace(/[\\*?]/gu, '\\$&');
}

/**
 * A trailing wildcard is emitted only when the classifier also refuses every
 * diagnostic form of the same stem (`vite build --help` and `tsc --showConfig`
 * are reads, so `Bash(vite build *)`/`Bash(tsc *)` would override a hook
 * allow). Everything else relies on the exact form; the classifier remains the
 * precise authority for argument tails when the hook is available.
 */
function wildcardSafe(form: string, policy: WorkerVerificationPolicy): boolean {
  return ['--help', '--version', '--showConfig', '--print-config x'].every(
    (probe) => isVerificationProducer(`${form} ${probe}`, policy),
  );
}

/**
 * Native Bash deny catalogue. Rules name executable/verb/option positions
 * literally and are the independent fallback that still holds when the
 * explanatory hook fails or is unavailable. They are derived from the same
 * normalized producer prefixes as the classifier, expanded over the
 * conventional spellings, but never over-broad enough to deny a documented
 * inspection read (`tsc --showConfig`, `vite build --help`, `eslint --help`).
 */
export function claudeVerificationDenyRules(policy: WorkerVerificationPolicy): readonly string[] {
  const rules = new Set<string>();
  const bases = new Set<string>();
  for (const prefix of policy.producerPrefixes) for (const base of variantBases(prefix)) bases.add(base);
  for (const base of bases) {
    if (base.trim() === '') continue;
    for (const wrapped of [base, `command ${base}`, `! ${base}`]) {
      const pattern = escapePattern(wrapped);
      rules.add(`Bash(${pattern})`);
      if (wildcardSafe(wrapped, policy)) rules.add(`Bash(${pattern} *)`);
    }
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
