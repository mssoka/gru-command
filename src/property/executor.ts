import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { resolveVitestBinary, VITEST_FAST_CHECK_ADAPTER } from './adapters/vitest-fast-check.js';
import { applyOverlayFiles, sha256Hex, type OverlayInputFile } from './overlay.js';
import { assemblePropertyExecutionReceipt, buildSourceIdentity, environmentProfileString, lockfileIdentity, propertyConfigIdentity, propertyGit, retainedCounterexample } from './receipts.js';
import type { ExecutionReceiptGuard, ExecutionReceiptRef, PropertyAdapter, PropertyExecutionPlan, PropertyOutcomeKind, SandboxBackend, SealedExecutionReceipt } from './types.js';

/** Host approval is a private, identity-bound capability, NOT plan.executable.
 * Repository code runs only in a deny-default sandbox. Forking is denied:
 * the pilot uses one Vitest thread and JS-compatible generated properties,
 * with native config loading and esbuild disabled. Thus a hostile test
 * cannot detach an undisclosed child; cessation means the actual process
 * closed AND its group is empty. No workspace-reported PID is ever killed.
 */
export class PreExecutionRejectionError extends Error {
  constructor(readonly category: string, message: string) {
    super(`${category}: ${message}`); this.name = 'PreExecutionRejectionError';
  }
}
export class WorkspaceCopyError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkspaceCopyError'; }
}
export class SandboxSpawnError extends Error {
  constructor(message: string) { super(message); this.name = 'SandboxSpawnError'; }
}
export interface TypedExecutionRefusal { readonly kind: PropertyOutcomeKind; readonly reason: string; readonly backend: SandboxBackend }
export interface CleanupOutcome { readonly proven: boolean; readonly workspaceRetained: boolean; readonly detail: string }
export type ExecutePlanResult =
  | { readonly executed: true; readonly receipt: SealedExecutionReceipt; readonly ref: ExecutionReceiptRef; readonly cleanup: CleanupOutcome }
  | { readonly executed: false; readonly refusal: TypedExecutionRefusal };
export interface ExecutionApproval { readonly approvalId: string }
export interface ExecutePlanInput {
  readonly plan: PropertyExecutionPlan;
  readonly adapter: PropertyAdapter;
  readonly repoRoot: string;
  readonly packageDir: string;
  readonly approval?: ExecutionApproval;
  readonly overlayFiles?: readonly OverlayInputFile[];
  readonly replaySeed?: string | null;
  readonly replayPath?: string | null;
}
export interface PropertyExecutorOptions {
  readonly sandboxExecutable?: string;
  readonly workspaceParentDir?: string;
  readonly workspaceCopyBounds?: { readonly maxFiles: number; readonly maxBytes: number };
  readonly maxRunTimeoutMs?: number;
  readonly maxMaxOutputBytes?: number;
  readonly denyReadSubpaths?: readonly string[];
  readonly envSource?: Readonly<Record<string, string | undefined>>;
}
const ENV = new Set(['PATH', 'LANG', 'LC_ALL', 'TZ', 'CI']);
const INSTALLERS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'uv', 'cargo', 'bun']);
const POLICY = { maxRunTimeoutMs: 900_000, maxMaxOutputBytes: 64 * 1024 * 1024 };
const CONFIG = `export default { esbuild: false, server: { host: '127.0.0.1', hmr: false, watch: null }, test: { api: false, cache: false, pool: 'threads', maxWorkers: 1, minWorkers: 1, fileParallelism: false, watch: false, deps: { optimizer: { ssr: { enabled: false }, client: { enabled: false } } } } };\n`;
const issued = new WeakMap<object, string>();
/** Full immutable-fact digest, not just a reflectable symbol or a few fields. */
export const isSealedExecutionReceipt: ExecutionReceiptGuard = (candidate): candidate is SealedExecutionReceipt => {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const digest = issued.get(candidate);
  if (digest === undefined) return false;
  try { return digest === sha256Hex(JSON.stringify(candidate)); } catch { return false; }
};
function inside(root: string, path: string): boolean {
  const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
export function resolveSandboxBackend(candidate = '/usr/bin/sandbox-exec'): { readonly backend: SandboxBackend; readonly executable: string | null; readonly reason: string | null } {
  if (process.platform !== 'darwin' || candidate !== '/usr/bin/sandbox-exec') {
    return { backend: 'none-found', executable: null, reason: `no supported sandbox backend (${process.platform}, ${candidate}); generic unshare is not a backend` };
  }
  try {
    if (!lstatSync(candidate).isFile()) throw new Error('not a regular file');
    return { backend: 'macos-sandbox-exec', executable: candidate, reason: null };
  } catch (error) { return { backend: 'none-found', executable: null, reason: String(error) }; }
}
export function validatePlanAgainstHostApproval(input: {
  readonly plan: PropertyExecutionPlan; readonly repoRoot: string; readonly packageDir: string;
  readonly ceilings: { readonly maxRunTimeoutMs: number; readonly maxMaxOutputBytes: number };
}): string {
  const { plan, repoRoot, packageDir, ceilings } = input;
  const fail = (category: string, why: string): never => { throw new PreExecutionRejectionError(category, why); };
  if (INSTALLERS.has(basename(plan.command))) fail('install-attempt', 'dependency installation is never approved by this executor');
  if (!inside(realpathSync(repoRoot), realpathSync(packageDir)) || realpathSync(plan.cwd) !== realpathSync(packageDir)) fail('invalid-plan', 'cwd/package must be inside the approved repository');
  if (plan.adapterId !== 'vitest-fast-check') fail('invalid-plan', 'only the shipped vitest-fast-check adapter is approved');
  const runner = resolveVitestBinary(repoRoot, packageDir);
  if (runner.path === null || realpathSync(plan.command) !== realpathSync(runner.path)) fail('unapproved-command', 'command does not match the contained installed Vitest runner');
  if (plan.args.length !== 3 || plan.args[0] !== 'run' || plan.args[1] !== '--reporter=json') fail('unapproved-argument', 'expected exactly run --reporter=json <selection>');
  const selection = plan.args[2] ?? '';
  if (!selection || selection.startsWith('-') || isAbsolute(selection) || /\\/u.test(selection) || [...selection].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || selection.split('/').some((part) => !part || part === '..' || part === '.')) fail('unapproved-argument', 'selection must be a safe package-relative test path');
  for (const name of plan.envAllowlist) if (!ENV.has(name)) fail('unapproved-environment', `${name} is not an approved environment name`);
  for (const [key, max] of Object.entries({ maxIterations: 10_000, maxShrinkSteps: 10_000, runTimeoutMs: ceilings.maxRunTimeoutMs, maxOutputBytes: ceilings.maxMaxOutputBytes })) {
    const value = plan.budget[key as keyof typeof plan.budget];
    if (!Number.isSafeInteger(value) || value <= 0 || value > max) fail('budget-exceeds-policy', `${key} must be a positive safe integer at most ${max}`);
  }
  return runner.path!;
}
function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function killGroup(pid: number): void { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
function profile(workspace: string, denied: readonly string[]): string {
  const q = (s: string): string => JSON.stringify(s);
  const runtimeReads = ['/System', '/usr/lib', '/usr/share', '/Library/Apple', '/private/var/db/dyld', '/private/var/db/timezone'];
  const literals = ['/', realpathSync(process.execPath), '/dev/urandom', '/dev/random', '/dev/null', '/dev/zero', '/etc/localtime'];
  const reads = [`(subpath ${q(workspace)})`, ...runtimeReads.map((path) => `(subpath ${q(path)})`), ...literals.map((path) => `(literal ${q(path)})`)];
  return [
    '(version 1)', '(deny default)', '(allow file-read-metadata)', '(allow sysctl-read)', '(allow file-map-executable)',
    '(allow sysctl-write (sysctl-name "kern.grade_cputype"))',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    // dyld/Node require reading the root directory itself, not its subtree.
    `(allow process-exec (literal ${q(realpathSync(process.execPath))}))`,
    '(allow process-info* (target self))', '(allow signal (target self))',
    `(allow file-read* ${reads.join(' ')})`,
    // Denials return OS errors. A caught EPERM is not proof of access, and
    // a parser PASS is never qualified product proof (qualification is separate).
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero"))',
    ...denied.map((path) => `(deny file-read-data (subpath ${q(path)}))`),
    '(deny network*)', '(deny process-fork)',
  ].join('\n');
}
type CopyBounds = { readonly maxFiles: number; readonly maxBytes: number };
function snapshotWorkspace(root: string, bounds: CopyBounds, tracked = new Set(propertyGit(root, ['ls-files', '-z']).split('\0'))) {
  const parents = new Set(['']);
  for (const path of tracked) { const parts = path.split(sep); while (parts.length > 1) { parts.pop(); parents.add(parts.join(sep)); } }
  const paths = new Set(['']); const hash = createHash('sha256'); const dependencies = createHash('sha256'); let entries = 0; let bytes = 0;
  const record = (rel: string, data: unknown) => { const encoded = JSON.stringify(data); hash.update(encoded); if (rel.split(sep).includes('node_modules')) dependencies.update(encoded); };
  const walk = (dir: string): void => {
    if (dir.split(sep).length > 128) throw new WorkspaceCopyError('workspace traversal depth exceeds approved bounds');
    for (const name of readdirSync(join(root, dir)).sort()) {
      if (++entries > bounds.maxFiles) throw new WorkspaceCopyError('workspace entry count exceeds approved bounds');
      const rel = dir === '' ? name : join(dir, name); const segments = rel.split(sep);
      if (segments.includes('.git')) continue;
      if (!segments.includes('node_modules') && !tracked.has(rel) && !parents.has(rel)) continue;
      const path = join(root, rel); const stat = lstatSync(path); paths.add(rel);
      if (stat.isDirectory()) { walk(rel); continue; }
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        if (isAbsolute(link) || !inside(root, realpathSync(path))) throw new WorkspaceCopyError(`external/absolute symlink refused: ${rel}`);
        record(rel, [rel, 'symlink', link]); continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) throw new WorkspaceCopyError(`non-regular/hardlinked file refused: ${rel}`);
      bytes += stat.size;
      if (bytes > bounds.maxBytes) throw new WorkspaceCopyError('workspace bytes exceed approved bounds');
      record(rel, [rel, stat.mode & 0o777, createHash('sha256').update(readFileSync(path)).digest('hex')]);
    }
  };
  walk(''); return { digest: hash.digest('hex'), dependencyDigest: dependencies.digest('hex'), paths, tracked };
}
function copyWorkspace(root: string, dest: string, paths: ReadonlySet<string>): void {
  cpSync(root, dest, { recursive: true, dereference: false, verbatimSymlinks: true, filter: (path) => paths.has(relative(root, path)) });
}
export interface PropertyExecutor {
  /** HOST ONLY: explicitly approve exact plan/source/runner bytes. */
  approvePlan(input: Pick<ExecutePlanInput, 'plan' | 'repoRoot' | 'packageDir' | 'overlayFiles' | 'replaySeed' | 'replayPath'>): ExecutionApproval;
  executePlan(input: ExecutePlanInput): Promise<ExecutePlanResult>;
  resolveReceiptRef(ref: ExecutionReceiptRef): SealedExecutionReceipt | null;
}
export function createPropertyExecutor(options: PropertyExecutorOptions = {}): PropertyExecutor {
  const ceilings = { maxRunTimeoutMs: options.maxRunTimeoutMs ?? POLICY.maxRunTimeoutMs, maxMaxOutputBytes: options.maxMaxOutputBytes ?? POLICY.maxMaxOutputBytes };
  for (const [key, value] of Object.entries(ceilings)) if (!Number.isSafeInteger(value) || value <= 0 || value > POLICY[key as keyof typeof POLICY]) throw new PreExecutionRejectionError('budget-exceeds-policy', `invalid host ceiling ${key}`);
  if (options.workspaceCopyBounds !== undefined && (!Number.isSafeInteger(options.workspaceCopyBounds.maxFiles) || options.workspaceCopyBounds.maxFiles < 1 || options.workspaceCopyBounds.maxFiles > 60_000 || !Number.isSafeInteger(options.workspaceCopyBounds.maxBytes) || options.workspaceCopyBounds.maxBytes < 1 || options.workspaceCopyBounds.maxBytes > 2 * 1024 ** 3)) throw new WorkspaceCopyError('invalid approved workspace copy bounds');
  const approvals = new WeakMap<ExecutionApproval, { readonly digest: string; readonly workspaceTreeSha256: string }>();
  const receipts = new Map<string, SealedExecutionReceipt>();
  let running = false;
  const fingerprint = (input: Pick<ExecutePlanInput, 'plan' | 'repoRoot' | 'packageDir' | 'overlayFiles' | 'replaySeed' | 'replayPath'>) => {
    const runner = validatePlanAgainstHostApproval({ ...input, ceilings });
    const source = buildSourceIdentity(input.repoRoot);
    if (source.kind === 'refused-dirty') throw new PreExecutionRejectionError('invalid-plan', 'tracked source must be clean before host approval');
    const workspaceTreeSha256 = snapshotWorkspace(realpathSync(input.repoRoot), options.workspaceCopyBounds ?? { maxFiles: 60_000, maxBytes: 2 * 1024 ** 3 }).digest;
    return { workspaceTreeSha256, digest: sha256Hex(JSON.stringify({ plan: input.plan, root: realpathSync(input.repoRoot), package: realpathSync(input.packageDir), source, runner: sha256Hex(readFileSync(runner, 'utf8')), lock: lockfileIdentity(input.packageDir, input.repoRoot), config: propertyConfigIdentity(input.repoRoot), workspaceTree: workspaceTreeSha256, overlay: (input.overlayFiles ?? []).map(({ path, content }) => ({ path, sha256: sha256Hex(content) })), replaySeed: input.replaySeed ?? null, replayPath: input.replayPath ?? null })) };
  };
  return {
    approvePlan(input) {
      const token = Object.freeze({ approvalId: randomUUID() }); approvals.set(token, fingerprint(input)); return token;
    },
    resolveReceiptRef(ref) { const value = receipts.get(ref?.receiptId); return value !== undefined && isSealedExecutionReceipt(value) ? value : null; },
    async executePlan(input) {
      const { plan, repoRoot, packageDir } = input;
      if (running) return { executed: false, refusal: { kind: 'not-run', reason: 'host property concurrency ceiling (one run) is occupied', backend: 'none-found' } };
      const backend = resolveSandboxBackend(options.sandboxExecutable);
      if (!plan.executable || plan.refusalReason !== null || backend.executable === null) return { executed: false, refusal: { kind: 'not-run', reason: plan.refusalReason ?? backend.reason ?? 'plan is not executable', backend: backend.backend } };
      if (input.adapter !== VITEST_FAST_CHECK_ADAPTER) throw new PreExecutionRejectionError('invalid-plan', 'caller-supplied adapters are not execution authority');
      const approved = input.approval === undefined ? undefined : approvals.get(input.approval);
      if (input.approval === undefined || approved === undefined || approved.digest !== fingerprint(input).digest) throw new PreExecutionRejectionError('unapproved-command', 'missing, forged or stale host approval for exact source/plan/runner');
      if (receipts.size >= 1024) throw new PreExecutionRejectionError('invalid-plan', 'executor receipt retention limit reached');
      const root = realpathSync(repoRoot); const pkg = realpathSync(packageDir);
      const source = buildSourceIdentity(root);
      const workspace = realpathSync(mkdtempSync(join(options.workspaceParentDir ?? tmpdir(), 'gh350-exec-')));
      running = true;
      let uncertainCessation = false;
      try {
        const bounds = options.workspaceCopyBounds ?? { maxFiles: 60_000, maxBytes: 2 * 1024 ** 3 };
        const snapshot = snapshotWorkspace(root, bounds);
        if (snapshot.digest !== approved.workspaceTreeSha256) throw new WorkspaceCopyError('workspace bytes differ from the approved snapshot');
        copyWorkspace(root, workspace, snapshot.paths);
        if (snapshotWorkspace(workspace, bounds, snapshot.tracked).digest !== snapshot.digest) throw new WorkspaceCopyError('copied source/dependency bytes differ from approved inputs');
        if (approved.digest !== fingerprint(input).digest) throw new PreExecutionRejectionError('invalid-plan', 'source identity moved while copying');
        approvals.delete(input.approval);
        const overlay = input.overlayFiles?.length ? applyOverlayFiles({ workspaceRoot: workspace, files: input.overlayFiles }) : null;
        const wsPkg = join(workspace, relative(root, pkg));
        const runner = resolveVitestBinary(workspace, wsPkg);
        if (runner.path === null) throw new PreExecutionRejectionError('unapproved-command', 'copied runner is not contained');
        const configPath = join(workspace, '.property-host.config.mjs');
        if (lstatSync(configPath, { throwIfNoEntry: false }) !== undefined) throw new WorkspaceCopyError('reserved host config path already exists');
        writeFileSync(configPath, CONFIG, { flag: 'wx' });
        const env: Record<string, string> = {};
        for (const name of plan.envAllowlist) if (name !== 'PATH' && options.envSource?.[name] !== undefined) env[name] = options.envSource[name]!;
        for (const [name, dir] of [['HOME', '.property-home'], ['TMPDIR', '.property-tmp']] as const) { env[name] = join(workspace, dir); mkdirSync(env[name], { recursive: true }); }
        env['PATH'] = `${dirname(process.execPath)}:/usr/bin:/bin`;
        env['CI'] = '1'; env['TZ'] = 'UTC';
        // CoreFoundation otherwise probes the real login home despite HOME.
        // Its UID prefix is hexadecimal; decimal is silently ignored by CF.
        env['CFFIXED_USER_HOME'] = env['HOME']!;
        env['__CF_USER_TEXT_ENCODING'] = `0x${(process.getuid?.() ?? 0).toString(16)}:0:0`;
        env['GRU_PROPERTY_MAX_ITERATIONS'] = String(plan.budget.maxIterations);
        env['GRU_PROPERTY_MAX_SHRINK_STEPS'] = String(plan.budget.maxShrinkSteps);
        if (input.replaySeed != null) {
          if (!/^-?\d{1,11}$/u.test(input.replaySeed)) throw new PreExecutionRejectionError('invalid-plan', 'invalid replay seed');
          env['GRU_PROPERTY_SEED'] = input.replaySeed;
        }
        if (input.replayPath != null) {
          if (!/^[0-9:]{0,1000}$/u.test(input.replayPath)) throw new PreExecutionRejectionError('invalid-plan', 'invalid replay shrink path');
          env['GRU_PROPERTY_PATH'] = input.replayPath;
        }
        const sbpl = profile(workspace, options.denyReadSubpaths ?? []);
        const argv = [realpathSync(process.execPath), '--max-old-space-size=256', runner.path, ...plan.args, '--config', configPath, '--configLoader', 'native'];
        const start = Date.now();
        const child = spawn(backend.executable, ['-p', sbpl, ...argv], { cwd: wsPkg, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const capture = { stdout: [] as Buffer[], stderr: [] as Buffer[], stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false };
        for (const name of ['stdout', 'stderr'] as const) child[name]!.on('data', (buf: Buffer) => {
          const remaining = Math.max(0, plan.budget.maxOutputBytes - capture[`${name}Bytes`]);
          const part = buf.subarray(0, remaining); capture[name].push(part); capture[`${name}Bytes`] += part.length;
          if (buf.length > remaining) capture[`${name}Truncated`] = true;
        });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; if (child.pid !== undefined) killGroup(child.pid); }, plan.budget.runTimeoutMs);
        try {
          await new Promise<void>((resolve, reject) => {
            let spawnError: Error | null = null;
            child.once('error', (error) => { spawnError = error; });
            child.once('close', () => spawnError === null ? resolve() : reject(spawnError));
          });
        } catch (error) { throw new SandboxSpawnError(String(error)); } finally { clearTimeout(timer); }
        const proven = child.pid !== undefined && !groupAlive(child.pid);
        // No fork permission exists. If the group is nevertheless live, do
        // not issue evidence, release resources, or claim successful cleanup.
        if (!proven) throw new SandboxSpawnError(`cessation unproven; workspace retained at ${workspace}`);
        const stdout = Buffer.concat(capture.stdout).toString('utf8'); const stderr = Buffer.concat(capture.stderr).toString('utf8');
        const raw = { stdout, stderr, exitCode: child.exitCode, signal: child.signalCode, timedOut, durationMs: Date.now() - start };
        let outcome = VITEST_FAST_CHECK_ADAPTER.interpretExecution(raw, plan);
        if ((capture.stdoutTruncated || capture.stderrTruncated) && outcome.kind === 'pass') outcome = { ...outcome, kind: 'inconclusive', reasons: [...outcome.reasons, 'output capture was truncated'] };
        const environmentProfile = environmentProfileString(env);
        const counterexample = retainedCounterexample({ outcome, environmentProfile });
        const body = assemblePropertyExecutionReceipt({
          identity: { source, workspaceTreeSha256: snapshot.digest, dependencyTreeSha256: snapshot.dependencyDigest, argv, selectionFilter: plan.args[2]!, lockIdentity: lockfileIdentity(pkg, root), configIdentity: propertyConfigIdentity(root), overlay, adapterProfile: `vitest-fast-check;deny-fork;native-config;${sha256Hex(CONFIG)}`, toolVersions: { node: process.versions.node, ...Object.fromEntries(['vitest', 'fast-check'].map((name) => { try { return [name, JSON.parse(readFileSync(join(wsPkg, 'node_modules', name, 'package.json'), 'utf8')).version as string]; } catch { return [name, 'unknown']; } })) } },
          command: argv[0]!, cwd: wsPkg, outcome, stdout, stderr,
          capture: { stdoutTruncated: capture.stdoutTruncated, stderrTruncated: capture.stderrTruncated, complete: !capture.stdoutTruncated && !capture.stderrTruncated },
          counterexample, sandbox: { backend: 'macos-sandbox-exec', profileSummary: `deny-default; read-only workspace/runtime allowlist; no disk writes/network/fork; denials may return EPERM (no per-syscall audit claim); 256MiB V8 heap; profile ${sha256Hex(sbpl)}`, networkDenied: true, filesystemIsolated: true, credentialsStripped: true, refusalReason: null }, replay: input.replaySeed == null ? counterexample?.replay ?? null : { seed: input.replaySeed, shrinkPath: input.replayPath == null ? [] : [input.replayPath], schedule: null, environmentProfile, replaySupported: true, replayDisclosure: 'host-requested native replay controls; PASS alone does not establish reproduction' }, budget: { ...plan.budget },
        });
        const sealed = body as SealedExecutionReceipt;
        issued.set(sealed, sha256Hex(JSON.stringify(sealed)));
        const ref = { receiptId: `pex-${randomUUID()}` }; receipts.set(ref.receiptId, sealed);
        rmSync(workspace, { recursive: true, force: true });
        return { executed: true, receipt: sealed, ref, cleanup: { proven: true, workspaceRetained: false, detail: 'actual close observed, fork denied, process group empty; workspace released' } };
      } catch (error) {
        // A cessation failure is the sole path that must keep its workspace.
        uncertainCessation = error instanceof SandboxSpawnError && error.message.includes('cessation unproven');
        if (!uncertainCessation) rmSync(workspace, { recursive: true, force: true });
        throw error;
      } finally { if (!uncertainCessation) running = false; }
    },
  };
}
