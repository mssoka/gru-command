import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type {
  AdapterSupport,
  PropertyAdapter,
  PropertyDetectionContext,
  PropertyDetectionResult,
  PropertyExecutionPlan,
  PropertyFailureRecord,
  PropertyRunOutcome,
  PropertyTestPlacement,
  RawExecutionReceipt,
  ToolingState,
  UnselectedFailureRecord,
} from '../types.js';
import { INTERPRETATION_EVIDENCE_CLASS } from '../types.js';

/**
 * GH350 pilot adapter: fast-check properties executed by the Vitest runner
 * in a TARGET repository (never Gru's own stack as an assumption).
 *
 * Honesty rules implemented here:
 * - `detect` treats manifest mappings as hints; every version/state claim
 *   cites what was actually read.
 * - `buildExecutionPlan` names ONLY installed binaries; a missing/invalid
 *   binary yields `executable:false` plus a refusal reason — never an
 *   install, never a silent unusable plan.
 * - `interpretExecution` classifies by positive structural evidence only
 *   (see INTERPRETATION_PRECEDENCE) and can never emit qualified product
 *   proof: `evidenceClass` is pinned to 'runner-report-classification'.
 */

const VITEST_TESTED_RANGE = '>=3.0.0 <4.0.0';
const FAST_CHECK_TESTED_RANGE = '>=3.0.0 <4.0.0';

export const VITEST_FAST_CHECK_ADAPTER_SUPPORT: AdapterSupport = {
  adapterId: 'vitest-fast-check',
  ecosystem: 'node-typescript',
  framework: 'fast-check',
  runner: 'vitest',
  testedVersionRange: `vitest ${VITEST_TESTED_RANGE}; fast-check ${FAST_CHECK_TESTED_RANGE} (runner report contract probed on vitest 3.2.7)`,
  status: 'shipped',
  capabilities: {
    scalarGeneration: true,
    statefulSequences: true,
    controlledInterleavings: false,
    shrinking: true,
    replayBySeed: true,
  },
  notes:
    'Pilot adapter. fast-check command sequences (stateful model testing) are supported; deterministic interleaving control is not — the capability flag is honestly false.',
};

/** Documented pre-report diagnostic signatures (deterministic, anchored).
 * A nonzero exit with NO parsable report matches at most these; anything
 * else is inconclusive — a bare nonzero exit is never asserted evidence of
 * a build failure. */
export const RECOGNIZED_PRE_REPORT_DIAGNOSTICS: readonly { readonly id: string; readonly pattern: RegExp }[] = [
  { id: 'vitest-failed-config-load', pattern: /^Error: Failed to load config/m },
  { id: 'vitest-cannot-find-module', pattern: /^Error: Cannot find module/m },
  { id: 'node-err-module-not-found', pattern: /ERR_MODULE_NOT_FOUND/ },
  { id: 'vitest-failed-resolve-import', pattern: /Failed to resolve import/m },
];

const EXCERPT_BYTES = 400;

function excerpt(text: string): string {
  return Buffer.byteLength(text, 'utf8') <= EXCERPT_BYTES ? text : `${Buffer.from(text, 'utf8').subarray(0, EXCERPT_BYTES).toString('utf8')}…`;
}

function contained(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

interface LockfileProvisions {
  readonly vitest: string | null;
  readonly fastCheck: string | null;
  readonly source: string | null;
}

function provisionFromPackageLock(text: string): { readonly vitest: string | null; readonly fastCheck: string | null } {
  try {
    const parsed = JSON.parse(text) as { packages?: Record<string, { version?: unknown }> };
    const packages = parsed.packages;
    if (typeof packages !== 'object' || packages === null) return { vitest: null, fastCheck: null };
    const vitest = packages['node_modules/vitest'];
    const fastCheck = packages['node_modules/fast-check'];
    return {
      vitest: typeof vitest?.version === 'string' ? vitest.version : null,
      fastCheck: typeof fastCheck?.version === 'string' ? fastCheck.version : null,
    };
  } catch {
    return { vitest: null, fastCheck: null };
  }
}

function provisionFromPnpmOrYarn(text: string): { readonly vitest: string | null; readonly fastCheck: string | null } {
  const find = (name: string): string | null => {
    for (const match of text.matchAll(new RegExp(`^\\s*(?:${name})@[^\\s:]+:[\\s\\S]*?version\\s+"?([^"\\n]+)"?`, 'gm'))) {
      return match[1] ?? null;
    }
    return null;
  };
  return { vitest: find('vitest'), fastCheck: find('fast-check') };
}

function lockfileProvisions(context: PropertyDetectionContext): LockfileProvisions {
  for (const lockfile of context.lockfiles) {
    const base = lockfile.path.split('/').pop() ?? '';
    if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') {
      const provisions = provisionFromPackageLock(lockfile.text);
      if (provisions.vitest !== null || provisions.fastCheck !== null) return { ...provisions, source: lockfile.path };
    } else if (base === 'pnpm-lock.yaml' || base === 'yarn.lock') {
      const provisions = provisionFromPnpmOrYarn(lockfile.text);
      if (provisions.vitest !== null || provisions.fastCheck !== null) return { ...provisions, source: lockfile.path };
    }
  }
  return { vitest: null, fastCheck: null, source: null };
}

function installedVersion(context: PropertyDetectionContext, name: string): string | null {
  for (const root of [context.packageDir, context.repoRoot]) {
    const file = join(root, 'node_modules', name, 'package.json');
    try {
      const info = lstatSync(file);
      if (!info.isFile()) continue;
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Absent or unreadable: not installed proof at this root.
    }
  }
  return null;
}

function majorOf(version: string): number | null {
  const match = /^(\d+)\./u.exec(version.trim());
  return match === null ? null : Number(match[1]);
}

function inTestedRange(version: string, range: string): boolean {
  const bounds = /^>=(\d+)\.\d+\.\d+ <(\d+)\.\d+\.\d+$/u.exec(range);
  if (bounds === null) return false;
  const major = majorOf(version);
  return major !== null && major >= Number(bounds[1]) && major < Number(bounds[2]);
}

export function detectVitestFastCheck(context: PropertyDetectionContext): PropertyDetectionResult {
  const manifest = context.manifest;
  if (manifest === null) return { compatible: false, reasons: ['no package.json manifest in this package'], versions: {} };
  const dependencies = { ...(manifest['dependencies'] as Record<string, unknown> | undefined), ...(manifest['devDependencies'] as Record<string, unknown> | undefined) };
  const scripts = manifest['scripts'] as Record<string, unknown> | undefined;
  const scriptText = scripts === undefined ? '' : JSON.stringify(scripts);
  const declaresVitest = typeof dependencies['vitest'] === 'string' || scriptText.includes('vitest');
  const declaresFastCheck = typeof dependencies['fast-check'] === 'string';
  const reasons: string[] = [];
  if (!declaresVitest) reasons.push('vitest is not declared in dependencies/devDependencies or scripts');
  if (!declaresFastCheck) reasons.push('fast-check is not declared in dependencies/devDependencies');
  if (!declaresVitest || !declaresFastCheck) return { compatible: false, reasons, versions: {} };

  const locked = lockfileProvisions(context);
  const installedVitest = installedVersion(context, 'vitest');
  const installedFastCheck = installedVersion(context, 'fast-check');
  const versions: Record<string, string> = {};
  if (locked.vitest !== null) versions['vitest@locked'] = locked.vitest;
  if (locked.fastCheck !== null) versions['fast-check@locked'] = locked.fastCheck;
  if (installedVitest !== null) versions['vitest@installed'] = installedVitest;
  if (installedFastCheck !== null) versions['fast-check@installed'] = installedFastCheck;
  const declaredVitest = typeof dependencies['vitest'] === 'string' ? (dependencies['vitest'] as string) : null;
  const declaredFastCheck = typeof dependencies['fast-check'] === 'string' ? (dependencies['fast-check'] as string) : null;
  if (declaredVitest !== null) versions['vitest@declared'] = declaredVitest;
  if (declaredFastCheck !== null) versions['fast-check@declared'] = declaredFastCheck;

  // Version honesty: an installed/locked vitest outside the probed range is
  // an explicit incompatibility, not a guess.
  const effectiveVitest = installedVitest ?? locked.vitest;
  if (effectiveVitest !== null && !inTestedRange(effectiveVitest, VITEST_TESTED_RANGE)) {
    return {
      compatible: false,
      reasons: [`vitest ${effectiveVitest} is outside the adapter's tested range ${VITEST_TESTED_RANGE} (see docs/PROPERTY-CONTRACTS.md)`],
      versions,
    };
  }
  const effectiveFastCheck = installedFastCheck ?? locked.fastCheck;
  if (effectiveFastCheck !== null && !inTestedRange(effectiveFastCheck, FAST_CHECK_TESTED_RANGE)) {
    return {
      compatible: false,
      reasons: [`fast-check ${effectiveFastCheck} is outside the adapter's tested range ${FAST_CHECK_TESTED_RANGE} (see docs/PROPERTY-CONTRACTS.md)`],
      versions,
    };
  }
  reasons.push(`declared vitest${declaredVitest === null ? '' : `@${declaredVitest}`}, fast-check${declaredFastCheck === null ? '' : `@${declaredFastCheck}`}`);
  return { compatible: true, reasons, versions };
}

// ---------------------------------------------------------------------------
// Placement / execution planning
// ---------------------------------------------------------------------------

export function planVitestPlacement(context: PropertyDetectionContext, slug: string): PropertyTestPlacement {
  const safeSlug = /^[a-z0-9-]+$/u.test(slug) ? slug : 'contract';
  const hasTestDir = (() => {
    try {
      return lstatSync(join(context.packageDir, 'test')).isDirectory();
    } catch {
      return false;
    }
  })();
  const hasSrcDir = (() => {
    try {
      return lstatSync(join(context.packageDir, 'src')).isDirectory();
    } catch {
      return false;
    }
  })();
  const relativePath = hasTestDir
    ? join('test', 'property', `${safeSlug}.test.ts`)
    : hasSrcDir
      ? join('src', 'property', `${safeSlug}.test.ts`)
      : join('test', 'property', `${safeSlug}.test.ts`);
  const filePath = join(context.packageDir, relativePath);
  return {
    filePath,
    selectionFilter: toPosix(relativePath),
    rationale: hasTestDir
      ? 'package has a test/ directory; property contracts live under test/property/'
      : hasSrcDir
        ? 'package has src/ but no test/; property contracts live under src/property/'
        : 'no test/ or src/ directory; defaulting to test/property/ (created on overlay application)',
  };
}

/** Contained, validated runner-binary resolution: the `.bin` entry is a
 * symlink by npm convention — follow it ONLY when the final target is a
 * regular file that stays inside the repository. Any failure returns null
 * with a precise reason (never a silently unusable plan). */
export function resolveVitestBinary(repoRoot: string, packageDir: string): { readonly path: string | null; readonly reason: string | null } {
  // Compare canonical forms on both sides: on macOS the repo root may sit
  // behind a /var -> /private/var symlink while realpathSync canonicalizes
  // the target — an uncanonicalized base would falsely "escape".
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(repoRoot);
  } catch (error) {
    return { path: null, reason: `repository root could not be resolved: ${String(error)}` };
  }
  const candidates = [packageDir, ...ancestorsWithin(repoRoot, dirname(packageDir)), repoRoot];
  for (const root of candidates) {
    const bin = join(root, 'node_modules', '.bin', 'vitest');
    let info;
    try {
      info = lstatSync(bin);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(bin);
      } catch (error) {
        return { path: null, reason: `node_modules/.bin/vitest symlink could not be resolved at ${bin}: ${String(error)}` };
      }
      if (!contained(canonicalRoot, target)) {
        return { path: null, reason: `node_modules/.bin/vitest resolves outside the repository (${target}) — refusing uncontained runner binary` };
      }
      let targetInfo;
      try {
        targetInfo = lstatSync(target);
      } catch {
        return { path: null, reason: `resolved vitest binary is unreadable: ${target}` };
      }
      if (!targetInfo.isFile()) {
        return { path: null, reason: `resolved vitest binary is not a regular file: ${target}` };
      }
      return { path: target, reason: null };
    }
    if (info.isFile()) return { path: bin, reason: null };
    return { path: null, reason: `node_modules/.bin/vitest is neither a file nor a symlink at ${bin}` };
  }
  return { path: null, reason: 'no installed vitest binary under the package or repository node_modules — dependency installation is never automatic (see docs/PROPERTY-CONTRACTS.md)' };
}

function ancestorsWithin(repoRoot: string, from: string): readonly string[] {
  const ancestors: string[] = [];
  let cursor = from;
  while (contained(repoRoot, cursor) && cursor !== repoRoot) {
    ancestors.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return ancestors;
}

export function buildVitestExecutionPlan(context: PropertyDetectionContext, placement: PropertyTestPlacement): PropertyExecutionPlan {
  const binary = resolveVitestBinary(context.repoRoot, context.packageDir);
  return {
    adapterId: VITEST_FAST_CHECK_ADAPTER_SUPPORT.adapterId,
    command: binary.path ?? join(context.packageDir, 'node_modules', '.bin', 'vitest'),
    args: ['run', '--reporter=json', placement.selectionFilter],
    cwd: context.packageDir,
    envAllowlist: ['PATH', 'LANG', 'LC_ALL', 'TZ', 'CI'],
    budget: { maxIterations: 100, maxShrinkSteps: 500, runTimeoutMs: 120_000, maxOutputBytes: 32 * 1024 * 1024 },
    executable: binary.path !== null,
    refusalReason: binary.reason,
  };
}

// ---------------------------------------------------------------------------
// Interpretation (pure function over a captured receipt)
// ---------------------------------------------------------------------------

interface VitestJsonReport {
  readonly numTotalTests: number;
  readonly numPassedTests: number;
  readonly numFailedTests: number;
  readonly numPendingTests: number;
  readonly numTodoTests: number;
  readonly success: boolean;
  readonly testResults: readonly {
    readonly name: string;
    readonly status: string;
    readonly message: string | null;
    readonly assertionResults: readonly {
      readonly status: string;
      readonly fullName: string;
      readonly failureMessages: readonly string[];
    }[];
  }[];
}

function parseVitestReport(stdout: string): VitestJsonReport | null {
  const attempt = (text: string): VitestJsonReport | null => {
    try {
      const parsed = JSON.parse(text) as Partial<VitestJsonReport>;
      if (!Array.isArray(parsed.testResults) || typeof parsed.numTotalTests !== 'number') return null;
      return {
        numTotalTests: parsed.numTotalTests,
        numPassedTests: typeof parsed.numPassedTests === 'number' ? parsed.numPassedTests : 0,
        numFailedTests: typeof parsed.numFailedTests === 'number' ? parsed.numFailedTests : 0,
        numPendingTests: typeof parsed.numPendingTests === 'number' ? parsed.numPendingTests : 0,
        numTodoTests: typeof parsed.numTodoTests === 'number' ? parsed.numTodoTests : 0,
        success: parsed.success === true,
        testResults: parsed.testResults,
      };
    } catch {
      return null;
    }
  };
  const direct = attempt(stdout.trim());
  if (direct !== null) return direct;
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return attempt(stdout.slice(start, end + 1));
}

function extractSeed(messages: readonly string[]): string | null {
  for (const message of messages) {
    const match = /seed[:=]\s*(-?\d+)/iu.exec(message);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

function recognizedDiagnostic(stderr: string): string | null {
  for (const signature of RECOGNIZED_PRE_REPORT_DIAGNOSTICS) {
    if (signature.pattern.test(stderr)) return signature.id;
  }
  return null;
}

function notRunOutcome(reason: string): PropertyRunOutcome {
  return {
    kind: 'not-run',
    evidenceClass: INTERPRETATION_EVIDENCE_CLASS,
    selected: 0, executed: 0, skipped: 0, failed: 0, passed: 0,
    failures: [], unselectedFailures: [], reasons: [reason], matchedDiagnostic: null,
    receipt: { exitCode: null, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 0 },
  };
}

/** The interpretation precedence, exactly as specified in the GH350 spec's
 * I/O matrix. Exported for the executor seam (receipts carry outcomes). */
export function interpretVitestJsonReceipt(raw: RawExecutionReceipt, plan: PropertyExecutionPlan): PropertyRunOutcome {
  const base = { evidenceClass: INTERPRETATION_EVIDENCE_CLASS, receipt: raw } as const;
  if (!plan.executable) {
    return { ...notRunOutcome(plan.refusalReason ?? 'execution plan is not executable'), receipt: raw };
  }
  if (raw.timedOut) {
    return { ...base, kind: 'timeout', selected: 0, executed: 0, skipped: 0, failed: 0, passed: 0, failures: [], unselectedFailures: [], reasons: ['wall-clock budget expired before the runner reported'], matchedDiagnostic: null };
  }
  if (raw.signal !== null && raw.exitCode === null) {
    return { ...base, kind: 'infrastructure-error', selected: 0, executed: 0, skipped: 0, failed: 0, passed: 0, failures: [], unselectedFailures: [], reasons: [`runner killed by signal ${raw.signal}`], matchedDiagnostic: null };
  }

  const report = parseVitestReport(raw.stdout);
  if (report === null) {
    const diagnostic = raw.exitCode !== 0 ? recognizedDiagnostic(raw.stderr) : null;
    if (diagnostic !== null) {
      return { ...base, kind: 'build-failure', selected: 0, executed: 0, skipped: 0, failed: 0, passed: 0, failures: [], unselectedFailures: [], reasons: [`nonzero exit ${raw.exitCode} with recognized pre-report diagnostic "${diagnostic}"`], matchedDiagnostic: diagnostic };
    }
    return {
      ...base,
      kind: 'inconclusive',
      selected: 0, executed: 0, skipped: 0, failed: 0, passed: 0,
      failures: [], unselectedFailures: [],
      reasons: [
        raw.exitCode === 0
          ? 'runner exited 0 without a parsable JSON report — missing evidence is never a pass'
          : `nonzero exit ${raw.exitCode} without a parsable report or recognized diagnostic — not asserted as a build failure`,
      ],
      matchedDiagnostic: null,
    };
  }

  // Structural classes over the parsable report.
  const selectionFilter = toPosix(plan.args[plan.args.length - 1] ?? '');
  const suites = report.testResults.map((suite) => ({
    suite,
    selected: selectionFilter !== '' && toPosix(suite.name).endsWith(selectionFilter),
  }));
  if (report.testResults.length === 0) {
    return { ...base, kind: 'selection-failure', selected: 0, executed: 0, skipped: 0, failed: 0, passed: 0, failures: [], unselectedFailures: [], reasons: ['parsable report contains zero test results — zero selected tests is never a pass'], matchedDiagnostic: null };
  }

  let executed = 0;
  let skipped = 0;
  let failed = 0;
  let passed = 0;
  let selectedExecuted = 0;
  const failures: PropertyFailureRecord[] = [];
  const unselectedFailures: UnselectedFailureRecord[] = [];
  for (const { suite, selected } of suites) {
    if (suite.assertionResults.length === 0 && suite.status === 'failed') {
      // handled below as a collection failure candidate
    }
    for (const assertion of suite.assertionResults) {
      if (assertion.status === 'skipped' || assertion.status === 'todo' || assertion.status === 'pending') {
        skipped += 1;
        continue;
      }
      executed += 1;
      if (selected) selectedExecuted += 1;
      if (assertion.status === 'failed') {
        failed += 1;
        const record = {
          testIdentity: assertion.fullName,
          messageExcerpt: excerpt(assertion.failureMessages.join('\n')),
          seed: extractSeed(assertion.failureMessages),
        };
        if (selected) failures.push(record);
        else unselectedFailures.push({ testIdentity: assertion.fullName, messageExcerpt: record.messageExcerpt });
      } else if (assertion.status === 'passed') {
        passed += 1;
      }
    }
  }

  const collectionFailures = suites.filter(({ suite }) => suite.status === 'failed' && suite.assertionResults.length === 0);
  const reasons: string[] = [];
  let kind: PropertyRunOutcome['kind'];
  if (collectionFailures.length > 0) {
    kind = 'collection-failure';
    for (const { suite } of collectionFailures) {
      reasons.push(`suite failed to collect: ${suite.name}${suite.message === null || suite.message === '' ? '' : ` (${excerpt(suite.message)})`}`);
    }
  } else if (failures.length > 0) {
    kind = 'property-failure';
    reasons.push(`${failures.length} selected assertion failure(s) — runner-report classification only, not qualified contract/product proof`);
  } else if (executed === 0) {
    kind = 'inconclusive';
    reasons.push('all selected tests skipped — skipped rows are not executed controls');
  } else {
    kind = 'pass';
  }

  // Contradiction checks: the report must be self-consistent and agree with
  // the direct exit code, or it can never yield pass.
  const totalsConsistent = report.numTotalTests === executed + skipped && report.numFailedTests === failed && report.numPassedTests === passed;
  const exitConsistent = (raw.exitCode === 0) === report.success || failed > 0;
  if (kind === 'pass' && (!totalsConsistent || !exitConsistent || raw.exitCode !== 0 || unselectedFailures.length > 0 || selectedExecuted === 0)) {
    kind = 'inconclusive';
    if (!totalsConsistent) reasons.push('report totals disagree with per-assertion accounting — contradictory report');
    if (!exitConsistent) reasons.push(`report success=${String(report.success)} disagrees with exit code ${raw.exitCode ?? 'null'} — contradictory report`);
    if (raw.exitCode !== 0) reasons.push(`nonzero exit ${raw.exitCode} bars pass`);
    if (unselectedFailures.length > 0) reasons.push(`${unselectedFailures.length} unselected failure(s) disclosed — contract cannot pass while unselected failures stand`);
    if (selectedExecuted === 0) reasons.push('zero executed selected tests — never a pass');
  }
  if (kind !== 'pass' && unselectedFailures.length > 0) {
    reasons.push(`${unselectedFailures.length} unselected failure(s) disclosed separately`);
  }

  return {
    ...base,
    kind,
    selected: suites.some((entry) => entry.selected) ? selectedExecuted : 0,
    executed,
    skipped,
    failed,
    passed,
    failures,
    unselectedFailures,
    reasons,
    matchedDiagnostic: null,
  };
}

export const VITEST_FAST_CHECK_ADAPTER: PropertyAdapter = {
  support: VITEST_FAST_CHECK_ADAPTER_SUPPORT,
  detect: detectVitestFastCheck,
  planPlacement: planVitestPlacement,
  buildExecutionPlan: buildVitestExecutionPlan,
  interpretExecution: interpretVitestJsonReceipt,
};

export type { ToolingState };
