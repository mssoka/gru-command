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

/** Index of the `)` matching the `(` at `open`, honoring nested parens and
 * quotes. An unterminated substitution runs to the end of the text. */
function substitutionEnd(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  let i = open;
  while (i < text.length) {
    const char = text[i] as string;
    if (quote !== null) {
      if (char === '\\' && quote === '"') { i += 2; continue; }
      if (char === quote) quote = null;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; i += 1; continue; }
    if (char === '\\') { i += 2; continue; }
    if (char === '(') depth += 1;
    else if (char === ')') { depth -= 1; if (depth === 0) return i; }
    i += 1;
  }
  return text.length;
}

/**
 * If an unescaped `$(...)`/backtick substitution begins at `at` in expanding
 * text, append its executable body to `out` and return the index just past it;
 * otherwise return -1. Callers have already handled escapes and single
 * quotes, which keep the text literal.
 */
function takeSubstitution(text: string, at: number, out: string[]): number {
  if (text[at] === '$' && text[at + 1] === '(') {
    const end = substitutionEnd(text, at + 1);
    out.push(text.slice(at + 2, end));
    return end + 1;
  }
  if (text[at] === '`') {
    const end = text.indexOf('`', at + 1);
    out.push(text.slice(at + 1, end < 0 ? text.length : end));
    return end < 0 ? text.length : end + 1;
  }
  return -1;
}

/** Executable bodies of unescaped `$(...)`/backtick substitutions in expanding
 * text. An odd number of backslashes escapes the `$`/backtick and the text
 * stays literal source. */
function collectSubstitutions(text: string, out: string[]): void {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    const next = takeSubstitution(text, i, out);
    i = next < 0 ? i + 1 : next;
  }
}

/**
 * Bounded, quote-aware split of a command string into simple-command word
 * groups. Quoted and escaped text stays one word; redirection targets and
 * literal heredoc bodies are data, not additional executables. Unescaped
 * `$(...)`/backtick substitutions in expanding quotes and unquoted heredoc
 * bodies are executable and are recursively classified.
 */
export function verificationCommandGroups(command: string): readonly (readonly string[])[] {
  const groups: string[][] = [];
  const substitutions: string[] = [];
  let words: string[] = [];
  let word = '';
  let started = false;
  let quote: string | null = null;
  const heredocs: { delimiter: string; expand: boolean; stripTabs: boolean }[] = [];
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
      if (char === quote) { quote = null; i += 1; continue; }
      if (char === '\\' && quote === '"') { const next = command[++i]; if (next !== undefined) word += next; i += 1; continue; }
      if (quote === '"' && char === '$' && command[i + 1] === '(') {
        const end = substitutionEnd(command, i + 1);
        substitutions.push(command.slice(i + 2, end));
        i = end + 1;
        continue;
      }
      if (quote === '"' && char === '`') {
        const end = command.indexOf('`', i + 1);
        substitutions.push(command.slice(i + 1, end < 0 ? command.length : end));
        i = end < 0 ? command.length : end + 1;
        continue;
      }
      word += char; i += 1; continue;
    }
    if (char === '\\') {
      const next = command[++i];
      if (next !== undefined && next !== '\n') { word += next; started = true; }
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; i += 1; continue; }
    // An unquoted `$(...)`/backtick is executed, not literal word text.
    {
      const expansion = takeSubstitution(command, i, substitutions);
      if (expansion >= 0) { i = expansion; continue; }
    }
    if (char === '#' && !started) { while (i < command.length && command[i] !== '\n') i += 1; continue; }
    if (char === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      // Heredoc redirection: the body is stdin data, never a command here.
      i += 2;
      const stripTabs = command[i] === '-';
      if (stripTabs) i += 1;
      while (command[i] === ' ' || command[i] === '\t') i += 1;
      let delimiter = '';
      let delimQuote: string | null = null;
      let quotedDelim = false;
      while (i < command.length) {
        const c = command[i] as string;
        if (delimQuote !== null) { if (c === delimQuote) delimQuote = null; else delimiter += c; i += 1; continue; }
        if (c === '"' || c === "'") { delimQuote = c; quotedDelim = true; i += 1; continue; }
        if (c === '\\') { const next = command[++i]; if (next !== undefined) delimiter += next; quotedDelim = true; i += 1; continue; }
        if (/[\s;&|()]/u.test(c)) break;
        delimiter += c; i += 1;
      }
      finishWord();
      if (delimiter !== '') heredocs.push({ delimiter, expand: !quotedDelim, stripTabs });
      continue;
    }
    if (char === '<' || char === '>') {
      // A digit sequence adjacent to the operator is a file descriptor, not a word.
      if (started && /^[0-9]+$/u.test(word)) { word = ''; started = false; }
      else finishWord();
      while (command[i] === '<' || command[i] === '>') i += 1;
      if (command[i] === '&') i += 1; // >&1 / <&0
      // Whitespace between the operator and its target is insignificant.
      while (command[i] === ' ' || command[i] === '\t') i += 1;
      // The redirect target (including a herestring `<<<`) is data, but a
      // supported executable expansion inside it (`>"$(cmd)"`) still runs.
      let targetQuote: string | null = null;
      while (i < command.length) {
        const c = command[i] as string;
        if (targetQuote !== null) {
          if (c === targetQuote) { targetQuote = null; i += 1; continue; }
          if (c === '\\' && targetQuote === '"') { i += 2; continue; }
          if (targetQuote === '"') {
            const expansion = takeSubstitution(command, i, substitutions);
            if (expansion >= 0) { i = expansion; continue; }
          }
          i += 1;
          continue;
        }
        if (/[\s;&|()]/u.test(c)) break;
        if (c === '\\') { i += 2; continue; }
        if (c === '"' || c === "'") { targetQuote = c; i += 1; continue; }
        const expansion = takeSubstitution(command, i, substitutions);
        if (expansion >= 0) { i = expansion; continue; }
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
        for (const heredoc of heredocs.splice(0)) {
          let body = '';
          while (i < command.length) {
            const end = command.indexOf('\n', i);
            const line = end < 0 ? command.slice(i) : command.slice(i, end);
            i = end < 0 ? command.length : end + 1;
            // Tabs are only stripped for `<<-`, never for a plain `<<`.
            const compared = heredoc.stripTabs ? line.replace(/^\t+/u, '') : line;
            if (compared === heredoc.delimiter) break;
            body += `${line}\n`;
          }
          // Plain stdin is data; only supported executable expansions in an
          // unquoted body contribute a producer. The whole body is scanned at
          // once so a substitution may span lines (`$(` newline `cmd`).
          if (heredoc.expand) collectSubstitutions(body, substitutions);
        }
      }
      continue;
    }
    if (/\s/u.test(char)) { finishWord(); i += 1; continue; }
    word += char; started = true; i += 1;
  }
  finishGroup();
  for (const substitution of substitutions) {
    for (const group of verificationCommandGroups(substitution)) groups.push([...group]);
  }
  return groups;
}

const NPM_VALUE_OPTIONS = new Set(['--prefix', '--workspace', '-w', '--cache', '--userconfig', '--registry', '--loglevel']);
const NPM_FLAG_OPTIONS = new Set(['--silent', '-s', '--quiet', '-q', '--offline', '--ignore-scripts', '--workspaces', '--if-present']);
const NPX_VALUE_OPTIONS = new Set(['--package', '-p', '--cache', '--userconfig', '--registry']);
const NPX_FLAG_OPTIONS = new Set(['--no-install', '--yes', '-y', '--offline', '--quiet', '-q']);
const LEADING_KEYWORDS = new Set(['!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do', '{', '}']);
/** `time` reserved-word options that carry no command of their own. */
const TIME_FLAG_OPTIONS = new Set(['-p', '--portability', '-v', '--verbose', '-a', '--append']);

/**
 * One bounded normalization shared by declared-script extraction and
 * execution matching: strips leading shell keywords/assignments and the
 * conventional `command`/`env` wrappers plus supported npm/npx options.
 */
export function normalizedVerificationWords(raw: readonly string[]): readonly string[] {
  let words = [...raw];
  // The `time` reserved word and its own options precede the timed command.
  for (;;) {
    if (words[0] === 'time') {
      words = words.slice(1);
      while (words.length > 0) {
        const option = words[0] as string;
        if (TIME_FLAG_OPTIONS.has(option)) { words = words.slice(1); continue; }
        if (option === '-o' || option === '--output') { words = words.slice(2); continue; }
        if (option.startsWith('--output=')) { words = words.slice(1); continue; }
        break;
      }
      continue;
    }
    if (LEADING_KEYWORDS.has(words[0] ?? '')) { words = words.slice(1); continue; }
    break;
  }
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
    } else if (words[0] === 'exec') {
      words = words.slice(1);
      // `exec [-c] [-l] [-a name] [--] command`
      while (words.length > 0) {
        const option = words[0] as string;
        if (option === '-a') { words = words.slice(2); continue; }
        if (option === '-c' || option === '-l' || option === '--') { words = words.slice(1); continue; }
        break;
      }
    } else if (words[0] === 'nohup') {
      words = words.slice(1);
      if (words[0] === '--') words = words.slice(1);
    } else if (words[0] === 'nice') {
      words = words.slice(1);
      // `nice [-n N | --adjustment[=]N | -N] command`
      while (words.length > 0) {
        const option = words[0] as string;
        if (option === '-n' || option === '--adjustment') { words = words.slice(2); continue; }
        if (option.startsWith('--adjustment=') || /^-\d+$/u.test(option)) { words = words.slice(1); continue; }
        break;
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

/** Help flags short-circuit any tool, with or without a selected subcommand. */
const HELP_FLAGS = new Set(['--help', '-h']);
/** Version flags only suppress a producer that has NOT selected a subcommand. */
const VERSION_FLAGS = new Set(['--version', '-v', '-V']);
/** Non-producing inspection flags (`tsc --showConfig`). */
const INSPECT_FLAGS = new Set(['--showConfig', '--print-config']);
/** Inspection flags that consume a following operand (the file to inspect). */
const DIAGNOSTIC_VALUE_FLAGS = new Set(['--print-config']);
/** Option positions whose value is configuration, not a literal operand. */
const CONFIG_VALUE_FLAGS = new Set(['-p', '--project', '--config', '-c']);
/** Flags that leave a combined invocation a read (`tsc --noEmit --showConfig`). */
const DIAGNOSTIC_COMPANION_FLAGS = new Set(['--noEmit', '--pretty', '--diagnostics', '--extendedDiagnostics']);

/**
 * True when every argument is a non-producing inspection position. A prefix
 * that already selected a verb (`vite build`, `npx vitest run`) makes the
 * version exemption subcommand-aware: `vite build --version` still builds, so
 * only `--help` and the tool's own inspection flags stay reads.
 */
function isDiagnosticInvocation(args: readonly string[], selectsVerb: boolean): boolean {
  let sawDiagnostic = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    // `--` ends option interpretation: literal operands after it (including a
    // trailing `--help`) are data, not a help request.
    if (arg === '--') return false;
    if (HELP_FLAGS.has(arg)) { sawDiagnostic = true; i += 1; continue; }
    if (VERSION_FLAGS.has(arg)) {
      // `vite build --version` executes the selected subcommand; a bare
      // `tsc --version` is a read.
      if (selectsVerb) return false;
      sawDiagnostic = true;
      i += 1;
      continue;
    }
    if (DIAGNOSTIC_VALUE_FLAGS.has(arg)) {
      sawDiagnostic = true;
      i += 1;
      if (i < args.length && !(args[i] as string).startsWith('-')) i += 1;
      continue;
    }
    if (INSPECT_FLAGS.has(arg)) { sawDiagnostic = true; i += 1; continue; }
    if (CONFIG_VALUE_FLAGS.has(arg)) { i += 2; continue; }
    if (DIAGNOSTIC_COMPANION_FLAGS.has(arg)) { i += 1; continue; }
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

const LOCAL_BIN_DIRS: readonly string[] = [
  './node_modules/.bin/', '../node_modules/.bin/', 'node_modules/.bin/',
  'web/node_modules/.bin/', './web/node_modules/.bin/',
];

/** Conventional local-bin path forms for the same known tools. */
function directProducerPrefixes(laneRoot: string): readonly (readonly string[])[] {
  const dirs = [...LOCAL_BIN_DIRS, `${join(laneRoot, 'node_modules/.bin')}/`, `${join(laneRoot, 'web/node_modules/.bin')}/`];
  return dirs.flatMap((dir) => KNOWN_TOOLS.map((tool) => [`${dir}${tool[0] as string}`, ...tool.slice(1)]));
}

/** Tools whose other subcommands are development operations (dev server,
 * browser install), never declared-script authority from a bare name. */
const DEV_SUBCOMMAND_TOOLS = new Set(['vite', 'playwright']);

function localBinPrefixes(tool: string, args: readonly string[], laneRoot: string): readonly (readonly string[])[] {
  const dirs = [...LOCAL_BIN_DIRS, `${join(laneRoot, 'node_modules/.bin')}/`, `${join(laneRoot, 'web/node_modules/.bin')}/`];
  return dirs.map((dir) => [`${dir}${tool}`, ...args]);
}

/** Declared-scope commands also register the npm scripts, npx tools and their
 * bare/local-bin equivalents that the lane's own contract names. */
function declaredProducerPrefixes(commands: readonly string[], laneRoot: string): readonly (readonly string[])[] {
  const prefixes: (readonly string[])[] = [];
  for (const command of commands) {
    for (const group of verificationCommandGroups(command)) {
      const words = normalizedVerificationWords(group);
      if (words[0] === 'npm' && words[1] === 'test') prefixes.push(['npm', 'test']);
      else if (words[0] === 'npm' && words[1] === 'run' && (words[2]?.length ?? 0) > 0) prefixes.push(words.slice(0, 3));
      else if (words[0] === 'npx' && (words[1]?.length ?? 0) > 0) {
        const tool = words[1] as string;
        const verb = words[2];
        if (DEV_SUBCOMMAND_TOOLS.has(tool)) {
          // A declared verb keeps the producer precise; a bare declaration
          // would block the tool's development/install subcommands.
          const tail = verb !== undefined && !verb.startsWith('-') ? [verb] : [];
          prefixes.push(['npx', tool, ...tail]);
          if (tail.length > 0) prefixes.push([tool, ...tail], ...localBinPrefixes(tool, tail, laneRoot));
        } else {
          // The word after a plain tool is an operand, not a verb: the tool
          // itself is the producer, so every spelling of it is covered.
          prefixes.push(['npx', tool], [tool], ...localBinPrefixes(tool, [], laneRoot));
        }
      }
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
  const producerPrefixes = [...FIXED_PRODUCER_PREFIXES, ...declaredProducerPrefixes(commands, lane.path), ...directProducerPrefixes(lane.path)]
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

/** True when a matched prefix already names a producing verb/subcommand
 * (`vite build`, `npx vitest run`) rather than a bare executable (`tsc`). */
function prefixSelectsVerb(prefix: readonly string[]): boolean {
  return prefix.length > (prefix[0] === 'npx' ? 2 : 1);
}

/** True when any simple command in the string is a known unscheduled producer. */
export function isVerificationProducer(command: string, policy: WorkerVerificationPolicy): boolean {
  for (const group of verificationCommandGroups(command)) {
    const words = normalizedVerificationWords(group);
    for (const prefix of policy.producerPrefixes) {
      if (prefix.length > words.length) continue;
      if (!prefix.every((word, index) => words[index] === word)) continue;
      // Direct tools keep their non-producing inspection modes; npm scripts never do.
      if (prefix[0] !== 'npm' && isDiagnosticInvocation(words.slice(prefix.length), prefixSelectsVerb(prefix))) continue;
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
