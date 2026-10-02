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
  const text = String(chunk);
  const current = tracked.output[streamName];
  const next = current + text;
  const bounded = next.length > OUTPUT_TAIL_LIMIT ? next.slice(-OUTPUT_TAIL_LIMIT) : next;
  if (next.length > OUTPUT_TAIL_LIMIT) tracked.outputTruncated[streamName] = true;
  tracked.output[streamName] = bounded;
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
  };
  if (tracked.exitCode !== null || tracked.signal !== null) tracked.exitedAt = tracked.startedAt;
  target.processes.push(tracked);
  if (captureOutput) {
    for (const streamName of ['stdout', 'stderr']) {
      const stream = child[streamName];
      if (stream !== null && stream !== undefined && typeof stream.on === 'function') {
        stream.on('data', (chunk) => appendTail(tracked, streamName, chunk));
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

const SECRET_LABEL =
  /(["']?(?:token|api[_-]?key|secret|password|passwd|authorization|credential)s?["']?\s*[:=]\s*)(?:"([^"\n]{4,})"|'([^'\n]{4,})'|(?:(?:Bearer|Basic)\s+)?([^\s"',;}\]]{4,}))/gi;
const BEARER_TOKEN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const SECRET_VALUE = /\b(?:sk|gho|ghp|ghs|ghr|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;

/** Redact credential-shaped values; safe for bounded child output tails. */
export function redactDiagnosticText(text) {
  return String(text)
    .replace(SECRET_LABEL, '$1[REDACTED]')
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(SECRET_VALUE, '[REDACTED]')
    .replace(JWT, '[REDACTED]')
    .replace(AWS_KEY, '[REDACTED]');
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

/** Vitest per-test/per-hook timeouts and the harness's own step deadline. */
export function isTimeoutError(error) {
  if (error instanceof FixtureStepTimeoutError) return true;
  // Vitest serializes result errors into null-prototype clones (processError
  // → serializeValue), so the class identity is gone but `name` survives.
  if (error !== null && typeof error === 'object' && error.name === 'FixtureStepTimeoutError') return true;
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
  if (target === null) {
    return `[harness-diagnostics] no active test scope; error: ${firstLine(message)}`;
  }
  const now = target.clock();
  const elapsed = now - target.startedAt;
  const timeout = timedOut ?? isTimeoutError(error);
  const hookPhase = /^hook\b/i.test(firstLine(message));
  const lines = [];
  lines.push(
    `[harness-diagnostics] ${timeout ? 'TIMEOUT' : 'FAILURE'} ${target.file} > ${target.name}`,
  );
  lines.push(
    `  elapsed: ${formatMs(elapsed)} (${timeout ? 'timeout' : 'failure'}${hookPhase ? ', hook/setup phase' : ''})`,
  );
  lines.push(`  error: ${firstLine(message)}`);
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
      if (tracked.spawnError !== null) lines.push(`      spawn error: ${firstLine(tracked.spawnError)}`);
      for (const streamName of ['stdout', 'stderr']) {
        const tail = tracked.output[streamName];
        if (tail !== '') {
          const suffix = tracked.outputTruncated[streamName] ? ' [truncated to last bytes]' : '';
          lines.push(`      ${streamName} tail${suffix}: ${tailExcerpt(tail)}`);
        }
      }
    }
  }
  const rendered = redactDiagnosticText(lines.join('\n'));
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
 * Run one fixture step under a hard step deadline. The step itself is
 * expected to use owned processes; on expiry the thrown error carries
 * the rendered diagnostics (last step, owned child state, output tails).
 */
export async function runBoundedFixtureStep(label, fn, { deadlineMs = 5_000, scope } = {}) {
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
