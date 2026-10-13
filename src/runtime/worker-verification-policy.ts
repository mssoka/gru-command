import { isAbsolute, join } from 'node:path';
import { PACKAGE_ROOT } from '../bmad/runtime.js';
import type { WorktreeLane } from '../dispatch/worktree-port.js';
import { loadWorktreeManifest } from '../worktrees/manifest.js';

/**
 * Host-owned admission snapshot for one registered job lane that declares
 * verification scopes (issue #315). It is derived from the lane's own
 * `[verify]` table and the loaded instance config path — never from prompts,
 * basenames or project BMAD text — and it refuses the observed direct
 * producer commands before they start.
 *
 * This is a bounded refusal guard for known conventional producer commands,
 * not a general-purpose shell sandbox: opaque scripts, interpreters and
 * adversarial evasion are out of scope. Execution always receives the
 * original, unmodified command string; the guard never rewrites it.
 */
export interface WorkerVerificationPolicy {
  readonly jobId: string;
  readonly laneId: string;
  readonly cwd: string;
  readonly scopes: readonly string[];
  /** Conventional executable-command word prefixes that must use the scheduler. */
  readonly producerPrefixes: readonly (readonly string[])[];
  readonly helper: string;
  readonly configFile: string;
}

/** Shell control operators that end one simple command and start the next. */
const CONTROL_CHARS = new Set([';', '|', '&', '(', ')', '\n']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;

/**
 * Bounded, quote-aware split of a command string into simple-command word
 * groups. Quoted and escaped text stays one word; redirection targets and
 * literal heredoc bodies are data, not additional executables.
 */
export function verificationCommandGroups(command: string): readonly (readonly string[])[] {
  const groups: string[][] = [];
  let words: string[] = [];
  let word = '';
  let started = false;
  let quote: string | null = null;
  const heredocs: string[] = [];
  const finishWord = (): void => {
    if (started) words.push(word);
    word = '';
    started = false;
  };
  const finishGroup = (): void => {
    finishWord();
    if (words.length > 0) groups.push(words);
    words = [];
  };
  let i = 0;
  while (i < command.length) {
    const char = command[i] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"') { const next = command[++i]; if (next !== undefined) word += next; }
      else word += char;
      i += 1;
      continue;
    }
    if (char === '\\') {
      const next = command[++i];
      if (next !== undefined && next !== '\n') { word += next; started = true; }
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; i += 1; continue; }
    if (char === '#' && !started) { while (i < command.length && command[i] !== '\n') i += 1; continue; }
    if (char === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      // Heredoc redirection: the body is stdin data, never a command here.
      i += 2;
      if (command[i] === '-') i += 1;
      while (command[i] === ' ' || command[i] === '\t') i += 1;
      let delimiter = '';
      let delimQuote: string | null = null;
      while (i < command.length) {
        const c = command[i] as string;
        if (delimQuote !== null) { if (c === delimQuote) delimQuote = null; else delimiter += c; i += 1; continue; }
        if (c === '"' || c === "'") { delimQuote = c; i += 1; continue; }
        if (c === '\\') { const next = command[++i]; if (next !== undefined) delimiter += next; i += 1; continue; }
        if (/[\s;&|()]/u.test(c)) break;
        delimiter += c; i += 1;
      }
      finishWord();
      if (delimiter !== '') heredocs.push(delimiter);
      continue;
    }
    if (char === '<' || char === '>') {
      finishWord();
      while (command[i] === '<' || command[i] === '>') i += 1;
      if (command[i] === '&') i += 1; // >&1 / <&0
      // The redirect target is data; consume one (optionally quoted) word.
      while (i < command.length) {
        const c = command[i] as string;
        if (/[\s;&|()]/u.test(c)) break;
        if (c === '\\') { i += 2; continue; }
        if (c === '"' || c === "'") {
          const close = command.indexOf(c, i + 1);
          i = close < 0 ? command.length : close + 1;
          continue;
        }
        i += 1;
      }
      continue;
    }
    if (CONTROL_CHARS.has(char)) {
      const doubled = (char === '&' || char === '|') && command[i + 1] === char;
      finishGroup();
      if (doubled) i += 1;
      i += 1;
      if (char === '\n') {
        for (const delimiter of heredocs.splice(0)) {
          while (i < command.length) {
            const end = command.indexOf('\n', i);
            const line = end < 0 ? command.slice(i) : command.slice(i, end);
            i = end < 0 ? command.length : end + 1;
            if (line.replace(/^\t+/u, '') === delimiter) break;
          }
        }
      }
      continue;
    }
    if (/\s/u.test(char)) { finishWord(); i += 1; continue; }
    word += char; started = true; i += 1;
  }
  finishGroup();
  return groups;
}

const NPM_VALUE_OPTIONS = new Set(['--prefix', '--workspace', '-w', '--cache', '--userconfig', '--registry', '--loglevel']);
const NPM_FLAG_OPTIONS = new Set(['--silent', '-s', '--quiet', '-q', '--offline', '--ignore-scripts', '--workspaces', '--if-present']);
const NPX_VALUE_OPTIONS = new Set(['--package', '-p', '--cache', '--userconfig', '--registry']);
const NPX_FLAG_OPTIONS = new Set(['--no-install', '--yes', '-y', '--offline', '--quiet', '-q']);
const LEADING_KEYWORDS = new Set(['!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', '{', '}', 'time']);

/**
 * One bounded normalization shared by declared-script extraction and
 * execution matching: strips leading shell keywords/assignments and the
 * conventional `command`/`env` wrappers plus supported npm/npx options.
 */
export function normalizedVerificationWords(raw: readonly string[]): readonly string[] {
  let words = [...raw];
  while (LEADING_KEYWORDS.has(words[0] ?? '')) words = words.slice(1);
  while (words.length > 0) {
    while (ASSIGNMENT.test(words[0] ?? '')) words = words.slice(1);
    if (words[0] === 'command') {
      words = words.slice(1);
      while (words[0] === '-p' || words[0] === '--') words = words.slice(1);
      if (words[0] === '-v' || words[0] === '-V') return []; // lookup, not execution
    } else if (words[0] === 'env') {
      words = words.slice(1);
      while (words.length > 0) {
        const option = words[0] as string;
        if (option === '--') { words = words.slice(1); break; }
        if (ASSIGNMENT.test(option) || option === '-i' || option === '--ignore-environment' ||
            option === '-0' || option === '--null' || /^--(?:unset|chdir)=/u.test(option)) {
          words = words.slice(1);
        } else if (option === '-u' || option === '--unset' || option === '-C' || option === '--chdir') {
          words = words.slice(2);
        } else break;
      }
    } else break;
  }
  const tool = words[0];
  if (tool !== 'npm' && tool !== 'npx') return words;
  const values = tool === 'npm' ? NPM_VALUE_OPTIONS : NPX_VALUE_OPTIONS;
  const flags = tool === 'npm' ? NPM_FLAG_OPTIONS : NPX_FLAG_OPTIONS;
  const args = words.slice(1);
  const kept: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--') { kept.push(...args.slice(i + 1)); break; }
    if (values.has(arg)) { i += 1; continue; }
    if (flags.has(arg) || (arg.includes('=') && values.has(arg.split('=')[0] as string))) continue;
    kept.push(arg);
  }
  if (tool === 'npm') {
    if (kept[0] === 't' || kept[0] === 'tst') kept[0] = 'test';
    if (kept[0] === 'run-script' || kept[0] === 'rum' || kept[0] === 'urn') kept[0] = 'run';
    if (kept[0] === 'exec' || kept[0] === 'x') return normalizedVerificationWords(['npx', ...kept.slice(1)]);
  }
  return [tool, ...kept];
}

/** Non-producing inspection modes of a known tool (`tsc --version`, `eslint --help`). */
const DIAGNOSTIC_FLAGS = new Set(['--version', '-v', '-V', '--help', '-h', '--showConfig', '--print-config']);
const CONFIG_VALUE_FLAGS = new Set(['-p', '--project', '--config', '-c']);

function isDiagnosticInvocation(args: readonly string[]): boolean {
  if (args.length === 0) return false;
  let sawDiagnostic = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (DIAGNOSTIC_FLAGS.has(arg)) { sawDiagnostic = true; continue; }
    if (CONFIG_VALUE_FLAGS.has(arg)) { i += 1; continue; }
    return false;
  }
  return sawDiagnostic;
}

/** Well-known verification producers: bare tools, npx forms and npm scripts. */
const KNOWN_TOOLS: readonly (readonly string[])[] = [
  ['vitest'], ['jest'], ['tsc'], ['eslint'], ['vite', 'build'], ['playwright', 'test'],
];
const CHECK_SCRIPTS: readonly string[] = [
  'test', 'test:backend', 'test:backend:heavy', 'test:web', 'test:heavy',
  'lint', 'typecheck', 'build', 'build:web', 'e2e',
];
const FIXED_PRODUCER_PREFIXES: readonly (readonly string[])[] = [
  ['npm', 'test'],
  ...CHECK_SCRIPTS.map((script) => ['npm', 'run', script]),
  ...KNOWN_TOOLS,
  ...KNOWN_TOOLS.map((tool) => ['npx', ...tool]),
];

/** Conventional local-bin path forms for the same known tools. */
function directProducerPrefixes(laneRoot: string): readonly (readonly string[])[] {
  const dirs = [
    './node_modules/.bin/', '../node_modules/.bin/', 'node_modules/.bin/',
    'web/node_modules/.bin/', './web/node_modules/.bin/',
    `${join(laneRoot, 'node_modules/.bin')}/`, `${join(laneRoot, 'web/node_modules/.bin')}/`,
  ];
  return dirs.flatMap((dir) => KNOWN_TOOLS.map((tool) => [`${dir}${tool[0] as string}`, ...tool.slice(1)]));
}

/** Declared-scope commands also register the npm scripts and npx tools they use. */
function declaredProducerPrefixes(commands: readonly string[]): readonly (readonly string[])[] {
  const prefixes: string[][] = [];
  for (const command of commands) {
    for (const group of verificationCommandGroups(command)) {
      const words = normalizedVerificationWords(group);
      if (words[0] === 'npm' && words[1] === 'test') prefixes.push(['npm', 'test']);
      else if (words[0] === 'npm' && words[1] === 'run' && (words[2]?.length ?? 0) > 0) prefixes.push(words.slice(0, 3));
      else if (words[0] === 'npx' && (words[1]?.length ?? 0) > 0) prefixes.push(words.slice(0, 2));
    }
  }
  return prefixes;
}

/**
 * Build the policy for one registered lane. `undefined` means the lane
 * declares no verification scopes (nothing to route). A job lane that DOES
 * declare scopes but has no absolute instance config path is a host bug and
 * fails loud rather than advertising an unusable next action.
 */
export function workerVerificationPolicy(lane: WorktreeLane, configFile?: string): WorkerVerificationPolicy | undefined {
  if (lane.kind !== 'job') return undefined;
  const manifest = loadWorktreeManifest(lane.path);
  const scopes = Object.keys(manifest?.verify ?? {}).sort();
  if (scopes.length === 0) return undefined;
  if (lane.jobId === null) {
    throw new Error(`verification policy requires the registered job identity for lane ${lane.id}; repair its worktree record`);
  }
  if (configFile === undefined || !isAbsolute(configFile)) {
    throw new Error(
      `verification policy for job ${lane.jobId} requires the host-loaded absolute instance config path; ` +
        'pass configPathFor(config.instanceDir)',
    );
  }
  const commands = scopes.map((scope) => (manifest as { verify: Record<string, string> }).verify[scope] as string);
  const producerPrefixes = [...FIXED_PRODUCER_PREFIXES, ...declaredProducerPrefixes(commands), ...directProducerPrefixes(lane.path)]
    .map((words) => Object.freeze([...words]));
  return Object.freeze({
    jobId: lane.jobId,
    laneId: lane.id,
    cwd: lane.path,
    scopes: Object.freeze(scopes),
    producerPrefixes: Object.freeze(producerPrefixes),
    helper: join(PACKAGE_ROOT, 'dist/verify/capture-cli.js'),
    configFile,
  });
}

/** True when any simple command in the string is a known unscheduled producer. */
export function isVerificationProducer(command: string, policy: WorkerVerificationPolicy): boolean {
  for (const group of verificationCommandGroups(command)) {
    const words = normalizedVerificationWords(group);
    for (const prefix of policy.producerPrefixes) {
      if (prefix.length > words.length) continue;
      if (!prefix.every((word, index) => words[index] === word)) continue;
      // Direct tools keep their non-producing inspection modes; npm scripts never do.
      if (prefix[0] !== 'npm' && isDiagnosticInvocation(words.slice(prefix.length))) continue;
      return true;
    }
  }
  return false;
}

export function verificationShellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Actionable refusal: names the declared scopes and the supported
 * authenticated helper, and states that a timeout is an unknown outcome to
 * reconcile rather than proof the producer stopped.
 */
export function workerVerificationRefusal(policy: WorkerVerificationPolicy): string {
  const helper = verificationShellQuote(policy.helper);
  const config = verificationShellQuote(policy.configFile);
  return [
    `Minion verification refused before execution: job ${policy.jobId} must use its scheduled declared scopes (${policy.scopes.join(', ')}).`,
    `Schedule the scope with the authenticated capture helper: node ${helper} run --job ${verificationShellQuote(policy.jobId)} ` +
      `--scope <declared-scope> --sink <new-exclusive-path> --expected-head <head> --request-id <durable-id> ` +
      `--url <ops-url> --config ${config}.`,
    'No run was submitted and no receipt was created. This is a bounded refusal for known producer commands, not a shell sandbox.',
    `If an admitted capture times out, reconcile that existing request identity: node ${helper} status --request-id <existing-id> --url <ops-url> --config ${config}. ` +
      'A timeout is not termination or PASS; never rerun unchanged proof to recover logs.',
  ].join(' ');
}
