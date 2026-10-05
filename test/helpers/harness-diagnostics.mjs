/**
 * Bounded timeout/failure diagnostics for the Vitest harness.
 *
 * One scope per test records:
 *  - fixture steps completed (the last one names where a stall happened),
 *  - child processes demonstrably owned by the fixture (pid, exit state,
 *    bounded stdout/stderr tails).
 *
 * The Vitest wiring lives in ./timeout-diagnostics.ts (a setup file).
 * Helpers (fixture-repo, real-service, local run helpers) call
 * markFixtureStep/trackChildProcess so a timeout is actionable instead
 * of a bare "Test timed out".
 *
 * Safety rules baked in here:
 *  - Output tails are bounded and secret-redacted before rendering.
 *  - Environments, argv and live-session contents are never rendered.
 *  - Only ChildProcess handles registered by the fixture are ever
 *    signalled; foreign processes are never inspected or killed.
 *  - Waits are bounded: bounded step deadlines, bounded teardown.
 *
 * Plain .mjs so test/helpers/real-service.mjs (also loaded by Playwright
 * outside Vitest) can import it; TS consumers use the adjacent .d.mts.
 */
import { clearTimeout, setTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

const OUTPUT_TAIL_LIMIT = 2_048; // chars kept per stream, per process
const RENDER_LIMIT = 8_192; // chars of the rendered diagnostics block
const STEP_LIMIT = 16;
const PROCESS_LIMIT = 12;

let activeScope = null;

export class FixtureStepTimeoutError extends Error {
  constructor(label, deadlineMs, diagnostics) {
    super(`Fixture step "${label}" exceeded its ${deadlineMs}ms deadline.\n${diagnostics}`);
    this.name = 'FixtureStepTimeoutError';
    this.stepLabel = label;
    this.deadlineMs = deadlineMs;
    this.diagnostics = diagnostics;
  }
}

export function createTestScope({ file, name, now = Date.now, parent = null }) {
  return {
    file: String(file ?? '<unknown file>'),
    name: String(name ?? '<unknown test>'),
    startedAt: now(),
    clock: now,
    steps: [],
    processes: [],
    parent: parent ?? null,
  };
}

/** Make `scope` the worker-current scope; returns the displaced scope (if any). */
export function activateTestScope(scope) {
  const previous = activeScope;
  activeScope = scope;
  return previous;
}

export function currentTestScope() {
  return activeScope;
}

export function deactivateTestScope(scope) {
  // Nested scopes restore their parent (a file-level scope around
  // beforeAll owns file-scoped children); a root scope restores null.
  if (activeScope === scope) activeScope = scope.parent ?? null;
}

/** Innermost-first chain of scopes (test scope, then its parents). */
function scopeLineage(scope) {
  const chain = [];
  for (let cursor = scope; cursor !== null && cursor !== undefined; cursor = cursor.parent ?? null) {
    chain.push(cursor);
  }
  return chain;
}

function scopeOf(scope) {
  return scope ?? activeScope;
}

/** Record a completed fixture step ("git clone", "install.sh --no-interact"). */
export function markFixtureStep(label, scope) {
  const target = scopeOf(scope);
  if (target === null) return;
  target.steps.push({ label: String(label), completedAt: target.clock() });
  if (target.steps.length > STEP_LIMIT) target.steps.shift();
}

function appendTail(tracked, streamName, chunk) {
  let text = String(chunk);
  const wasOpen = tracked.openCredential[streamName] === true;
  let stillOpen = false;
  if (wasOpen) {
    // The previous chunk ended inside a credential value. Discard the rest
    // of that credential's line fail-closed (the reviewer-sanctioned
    // fallback): nothing from the continuation — quoted or not, with any
    // embedded whitespace — is ever rendered. A newline resolves the state
    // and is kept, so the following line resumes on its own line.
    const newline = text.indexOf('\n');
    if (newline === -1) {
      text = '';
      stillOpen = true;
    } else {
      text = text.slice(newline);
    }
    tracked.openCredential[streamName] = false;
  }
  const combined = tracked.output[streamName] + text;
  // A value the streaming detector sees as unfinished is masked BEFORE it
  // is retained: whatever opens continuation suppression is itself removed,
  // so no fragment can be kept while its continuation is discarded,
  // whether or not the redactor below would have matched it. JS `$` (no
  // `m` flag) matches only at the very end, so a newline-terminated value
  // is complete and never opens the state.
  const open = UNTERMINATED_VALUE.test(combined);
  const masked = open ? combined.replace(UNTERMINATED_VALUE, maskUnterminatedValue) : combined;
  // Redact BEFORE trimming: the retained tail is always sanitized text, so
  // a credential pair split across chunks is redacted the moment its second
  // half arrives, and no trim can ever cut a label away from its value.
  const redacted = redactDiagnosticText(masked);
  const bounded = redacted.length > OUTPUT_TAIL_LIMIT ? redacted.slice(-OUTPUT_TAIL_LIMIT) : redacted;
  // The marker follows the text actually cut: redaction can lengthen short
  // values ("sk-a" → "[REDACTED]"), so the raw length is not the measure.
  if (redacted.length > OUTPUT_TAIL_LIMIT) tracked.outputTruncated[streamName] = true;
  tracked.output[streamName] = bounded;
  tracked.openCredential[streamName] = stillOpen || open;
}

/** Keep an unfinished credential's label or auth scheme; mask its value. */
function maskUnterminatedValue(_match, label, scheme) {
  return `${label ?? scheme ?? ''}[REDACTED]`;
}

/**
 * Track a child process the test fixture owns. Never called with a
 * process the fixture did not spawn. `captureOutput` attaches bounded
 * listeners so a timeout can report the relevant tail.
 */
export function trackChildProcess(child, { label, captureOutput = true, scope } = {}) {
  const target = scopeOf(scope);
  if (target === null || child === null || typeof child !== 'object') return null;
  const tracked = {
    child,
    pid: Number.isInteger(child.pid) ? child.pid : null,
    label: String(label ?? 'child process'),
    startedAt: target.clock(),
    exitedAt: null,
    exitCode: child.exitCode ?? null,
    signal: child.signalCode ?? null,
    spawnError: null,
    output: { stdout: '', stderr: '' },
    outputTruncated: { stdout: false, stderr: false },
    openCredential: { stdout: false, stderr: false },
  };
  if (tracked.exitCode !== null || tracked.signal !== null) tracked.exitedAt = tracked.startedAt;
  target.processes.push(tracked);
  if (captureOutput) {
    for (const streamName of ['stdout', 'stderr']) {
      const stream = child[streamName];
      if (stream !== null && stream !== undefined && typeof stream.on === 'function') {
        // Buffer chunks are decoded statefully: a multi-byte character split
        // across chunks must not become U+FFFD. The caller's own listeners
        // keep whatever encoding the caller chose.
        const decoder = new StringDecoder('utf8');
        stream.on('data', (chunk) =>
          appendTail(tracked, streamName, typeof chunk === 'string' ? chunk : decoder.write(chunk)),
        );
      }
    }
  }
  child.once('exit', (code, signal) => {
    tracked.exitedAt = target.clock();
    tracked.exitCode = code ?? null;
    tracked.signal = signal ?? null;
  });
  // Keep an owned child's asynchronous error from crashing the worker;
  // the exit state and any captured tail still explain what happened.
  child.once('error', (error) => {
    tracked.spawnError = String(error?.message ?? error);
  });
  return tracked;
}

// Unquoted label values run to whitespace or a delimiter. A backslash is part
// of the value unless it escapes a quote (a JSON-escaped closing delimiter),
// so `password=abcd\efgh` redacts whole instead of exposing `\efgh`.
const SECRET_LABEL =
  /(\\?["']?(?:token|api[_-]?key|secret|password|passwd|authorization|credential)s?\\?["']?\s*\\?[:=]\s*)(?!\[REDACTED\])(?:"((?:[^"\\\n]|\\.){4,})"|\\"((?:[^"\\\n]|\\.){4,})\\"|'((?:[^'\\\n]|\\.){4,})'|\\'((?:[^'\\\n]|\\.){4,})\\'|(?:(?:Bearer|Basic)\s+)?(?!\[REDACTED\])(?!(?:Bearer|Basic)(?:\s|$))((?:[^\s"',;}\\\]]|\\(?!["'])){4,}))/gi;
// Fail-closed leftover: a label whose value is short, quoted-but-unterminated
// (to end of line) or otherwise outside the specific shapes above still
// redacts rather than exposing the remainder.
const SECRET_OPEN =
  /(\\?["']?(?:token|api[_-]?key|secret|password|passwd|authorization|credential)s?\\?["']?\s*\\?[:=]\s*)(?!\[REDACTED\])(?!(?:Bearer|Basic)(?:\s|$))(?:\\?["'][^\n]*|(?:[^\s"',;}\\\]]|\\(?!["']))+)/gi;

// Streaming fail-closed state: a value that reached the end of the captured
// text without a delimiter may continue in the next chunk; the rest of that
// credential's line is then discarded rather than rendered naked, and the
// match itself is masked before retention (group 1: label, group 2: auth
// scheme; both kept).
const UNTERMINATED_VALUE =
  /(?:(\\?["']?(?:token|api[_-]?key|secret|password|passwd|authorization|credential)s?\\?["']?\s*\\?[:=]\s*)(?!\[REDACTED\])(?:\\?"(?:[^"\\\n]|\\.)*\\?|\\?'(?:[^'\\\n]|\\.)*\\?|[^\s"',;}\]]+)|\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+|\b(?:sk|gho|ghp|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|\bAKIA[0-9A-Z]+)$/i;
// Shapes MUST agree with the streaming detector — any positive length, the
// same case-insensitivity — so a complete value redacts exactly like an
// unfinished one is masked. The auth scheme is kept as written.
const BEARER_TOKEN = /\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi;
const SECRET_VALUE = /\b(?:sk|gho|ghp|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi;
const AWS_KEY = /\bAKIA[0-9A-Z]+/gi;

/** Redact credential-shaped values; safe for bounded child output tails. */
export function redactDiagnosticText(text) {
  return String(text)
    .replace(SECRET_LABEL, '$1[REDACTED]')
    .replace(BEARER_TOKEN, '$1[REDACTED]')
    .replace(SECRET_VALUE, '[REDACTED]')
    .replace(JWT, '[REDACTED]')
    .replace(AWS_KEY, '[REDACTED]')
    .replace(SECRET_OPEN, '$1[REDACTED]');
}

function errorText(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const message = error.message;
    if (typeof message === 'string') return message;
    try {
      return JSON.stringify(error);
    } catch {
      return '[unserializable error]';
    }
  }
  try {
    return String(error);
  } catch {
    return '[unserializable error]';
  }
}

const DEADLINE_ERROR_NAMES = new Set(['FixtureStepTimeoutError', 'OwnedCommandTimeoutError']);

/** Vitest per-test/per-hook timeouts and the harness's own step/command deadlines. */
export function isTimeoutError(error) {
  if (error instanceof FixtureStepTimeoutError || error instanceof OwnedCommandTimeoutError) return true;
  // Vitest serializes result errors into null-prototype clones (processError
  // → serializeValue), so the class identity is gone but `name` survives.
  if (error !== null && typeof error === 'object' && DEADLINE_ERROR_NAMES.has(error.name)) return true;
  const message = errorText(error);
  return (
    /\b(?:test|hook|fixture step)\b[^.\n]*timed out in \d+ms/i.test(message) ||
    /\bfixture step\b[^.\n]*exceeded its \d+ms deadline/i.test(message)
  );
}

function formatMs(ms) {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

function firstLine(text) {
  const line = String(text).split('\n', 1)[0] ?? '';
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

/** Last few non-empty lines of a tail, flattened and bounded for rendering. */
function tailExcerpt(text) {
  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(-4);
  const joined = lines.join(' | ');
  return joined.length > 480 ? `...${joined.slice(-477)}` : joined;
}

/**
 * Render the bounded diagnostics block for a failing/timed-out test.
 * `timedOut` is normally derived from the error; pass it explicitly only
 * when the caller already knows (a fixture deadline).
 */
export function renderFailureDiagnostics(scope, error, { timedOut } = {}) {
  const target = scopeOf(scope);
  const message = errorText(error);
  // Sanitize the COMPLETE error string before any truncation: a quoted
  // credential cut at the 240-char line bound would lose its closing quote
  // and defeat the matcher.
  const safeMessage = redactDiagnosticText(message);
  if (target === null) {
    return `[harness-diagnostics] no active test scope; error: ${firstLine(safeMessage)}`;
  }
  const now = target.clock();
  const elapsed = now - target.startedAt;
  const timeout = timedOut ?? isTimeoutError(error);
  const hookPhase = /^hook\b/i.test(firstLine(safeMessage));
  const lines = [];
  lines.push(
    `[harness-diagnostics] ${timeout ? 'TIMEOUT' : 'FAILURE'} ${target.file} > ${target.name}`,
  );
  lines.push(
    `  elapsed: ${formatMs(elapsed)} (${timeout ? 'timeout' : 'failure'}${hookPhase ? ', hook/setup phase' : ''})`,
  );
  lines.push(`  error: ${firstLine(safeMessage)}`);
  const lineage = scopeLineage(target);
  // File-scope children (started in beforeAll) render first; the test's own
  // children last, so the newest evidence survives the per-process cap.
  const allProcesses = [...lineage].reverse().flatMap((scope) => scope.processes);
  const lastStep = lineage
    .flatMap((scope) => scope.steps)
    .reduce(
      (latest, step) => (latest === undefined || step.completedAt >= latest.completedAt ? step : latest),
      undefined,
    );
  if (lastStep === undefined) {
    lines.push('  last completed fixture step: none recorded');
  } else {
    lines.push(
      `  last completed fixture step: "${lastStep.label}" at +${formatMs(Math.max(0, lastStep.completedAt - target.startedAt))} ` +
        `(${formatMs(now - lastStep.completedAt)} before this report)`,
    );
  }
  if (allProcesses.length === 0) {
    lines.push('  owned children tracked: none');
  } else {
    lines.push(`  owned children tracked: ${allProcesses.length}`);
    // Every tracked child stays disposable at teardown; only the render is
    // capped, naming the overflow explicitly.
    const shown = allProcesses.slice(-PROCESS_LIMIT);
    if (allProcesses.length > shown.length) {
      lines.push(`    ... ${allProcesses.length - shown.length} earlier owned children not listed`);
    }
    for (const tracked of shown) {
      const state =
        tracked.exitCode === null && tracked.signal === null
          ? `running (started +${formatMs(tracked.startedAt - target.startedAt)})`
          : `exited code=${String(tracked.exitCode)} signal=${String(tracked.signal)} at ` +
            `+${formatMs((tracked.exitedAt ?? now) - target.startedAt)}`;
      lines.push(`    - pid ${String(tracked.pid)} "${tracked.label}": ${state}`);
      if (tracked.spawnError !== null) {
        lines.push(`      spawn error: ${firstLine(redactDiagnosticText(tracked.spawnError))}`);
      }
      for (const streamName of ['stdout', 'stderr']) {
        const tail = tracked.output[streamName];
        if (tail !== '') {
          const suffix = tracked.outputTruncated[streamName] ? ' [truncated to last bytes]' : '';
          // Redact the complete retained tail BEFORE excerpting, so a label
          // is never cut away from its value by the 477-char bound.
          lines.push(`      ${streamName} tail${suffix}: ${tailExcerpt(redactDiagnosticText(tail))}`);
        }
      }
    }
  }
  // The identity header (the repo-authored file path and test name) is never
  // a credential and must stay readable — a test named "…tokens: a bare
  // 429…" is not a secret. Every line below it is redacted as a whole.
  const [header, ...body] = lines;
  const rendered = `${header}\n${redactDiagnosticText(body.join('\n'))}`;
  if (rendered.length <= RENDER_LIMIT) return rendered;
  // Keep the head (identity, elapsed, last step) AND the tail (the freshest
  // owned-child evidence): elide the middle instead of the ending.
  const marker = '\n...[diagnostics truncated]...\n';
  const keep = RENDER_LIMIT - marker.length;
  const head = Math.floor(keep / 2);
  return `${rendered.slice(0, head)}${marker}${rendered.slice(rendered.length - (keep - head))}`;
}

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Bounded teardown for fixture-owned children only: SIGTERM, wait
 * `graceMs`, then SIGKILL, wait `killGraceMs`. Untracked/foreign
 * processes are never touched. The whole disposal shares one
 * `totalMs` deadline, so a test that leaked many stuck children cannot
 * push the teardown hook past its own budget; every child still gets a
 * SIGTERM and a SIGKILL attempt, and an unreaped one is reported.
 */
export async function disposeScopeProcesses(
  scope,
  { graceMs = 2_000, killGraceMs = 1_000, totalMs = 15_000 } = {},
) {
  const target = scopeOf(scope);
  if (target === null) return [];
  const deadline = Date.now() + totalMs;
  const results = [];
  for (const tracked of target.processes) {
    const { child, label, pid } = tracked;
    if (child.exitCode !== null || child.signalCode !== null) {
      results.push({ label, pid, disposition: 'already-exited' });
      continue;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    const remaining = deadline - Date.now();
    let exited = remaining > 0 ? await waitForExit(child, Math.min(graceMs, remaining)) : false;
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      const remainingAfterKill = deadline - Date.now();
      exited = remainingAfterKill > 0 ? await waitForExit(child, Math.min(killGraceMs, remainingAfterKill)) : false;
    }
    results.push({ label, pid, disposition: exited ? 'reaped' : 'unreaped' });
  }
  return results;
}

/**
 * One line per owned child that survived the bounded teardown, so a leak
 * is named instead of silently adding co-tenant load. Empty when every
 * child was reaped or had already exited.
 */
export function renderTeardownReport(scope, results) {
  const target = scopeOf(scope);
  const identity = target === null ? '<no active test scope>' : `${target.file} > ${target.name}`;
  return results
    .filter((entry) => entry.disposition === 'unreaped')
    .map(
      (entry) =>
        `[harness-diagnostics] UNREAPED ${identity}: pid ${String(entry.pid)} ` +
        `"${redactDiagnosticText(entry.label)}" survived bounded teardown`,
    );
}

/**
 * Run one fixture step under a hard step deadline. The step itself is
 * expected to use owned processes; on expiry the thrown error carries
 * the rendered diagnostics (last step, owned child state, output tails).
 */export async function runBoundedFixtureStep(label, fn, { deadlineMs = 5_000, scope } = {}) {
  const target = scopeOf(scope);
  if (target === null) {
    throw new Error('runBoundedFixtureStep requires an active test scope');
  }
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new FixtureStepTimeoutError(label, deadlineMs, '');
      error.message = `Fixture step "${label}" exceeded its ${deadlineMs}ms deadline.`;
      error.diagnostics = renderFailureDiagnostics(target, error, { timedOut: true });
      error.message = `${error.message}\n${error.diagnostics}`;
      reject(error);
    }, deadlineMs);
  });
  try {
    const result = await Promise.race([Promise.resolve().then(fn), deadline]);
    markFixtureStep(label, target);
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export class OwnedCommandTimeoutError extends Error {
  constructor(label, deadlineMs) {
    super(`${label} exceeded its ${deadlineMs}ms deadline`);
    this.name = 'OwnedCommandTimeoutError';
    this.label = label;
    this.deadlineMs = deadlineMs;
  }
}

const COMMAND_OUTPUT_LIMIT = 4 * 1024 * 1024;

/**
 * Run an owned child ASYNCHRONOUSLY under a bounded deadline. The child is
 * registered with the active diagnostics scope (pid/state/output tails) and
 * the returned stdout/stderr are captured for assertions. A deadline expiry
 * SIGTERMs (then SIGKILLs after `killGraceMs`) the child before throwing an
 * `OwnedCommandTimeoutError` whose `stdout`/`stderr` carry the partial
 * output — so a stalled CLI can never block the worker past its classified
 * test ceiling, and its evidence stays diagnosable. Foreign processes are
 * never touched.
 */
export async function runOwnedCommand(
  command,
  args,
  { label, cwd, env, input, deadlineMs = 120_000, scope, killGraceMs = 1_000 } = {},
) {
  const name = String(label ?? command);
  const child = spawn(command, args, {
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Decode statefully before any listener attaches: per-chunk String(buffer)
  // turns a multi-byte character split across chunks into U+FFFD.
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  const tracked = trackChildProcess(child, { label: name, scope });
  let stdout = '';
  let stderr = '';
  let outputTruncated = false;
  const collect = (current, chunk) => {
    const next = current + String(chunk);
    if (next.length > COMMAND_OUTPUT_LIMIT) outputTruncated = true;
    return next.length > COMMAND_OUTPUT_LIMIT ? next.slice(-COMMAND_OUTPUT_LIMIT) : next;
  };
  child.stdout?.on('data', (chunk) => {
    stdout = collect(stdout, chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr = collect(stderr, chunk);
  });
  let spawnError = null;
  child.once('error', (error) => {
    spawnError = error;
  });
  if (child.stdin !== null) {
    if (input !== undefined) child.stdin.end(String(input));
    else child.stdin.end();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    const escalate = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, killGraceMs);
    escalate.unref?.();
  }, deadlineMs);
  const closed = await new Promise((resolve) => {
    let settled = false;
    const settle = (code, signal) => {
      if (!settled) {
        settled = true;
        resolve({ code, signal });
      }
    };
    child.once('close', (code, signal) => settle(code, signal));
    // A grandchild holding the stdio pipes open must not defeat the
    // deadline: settle shortly after the direct child exits.
    child.once('exit', (code, signal) => {
      setTimeout(() => settle(code, signal), 100);
    });
    // A spawn failure may never produce 'close' on some platforms.
    child.once('error', () => settle(null, null));
  });
  clearTimeout(timer);
  if (timedOut) {
    const error = new OwnedCommandTimeoutError(name, deadlineMs);
    error.stdout = stdout;
    error.stderr = stderr;
    throw error;
  }
  return {
    status: closed.code,
    signal: closed.signal,
    stdout,
    stderr,
    outputTruncated,
    spawnError: spawnError === null ? null : String(spawnError.message ?? spawnError),
    tracked,
  };
}
