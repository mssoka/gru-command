import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  readonly signal?: AbortSignal;
  readonly sandboxExecutable?: string;
  readonly workspaceParentDir?: string;
  readonly workspaceCopyBounds?: { readonly maxFiles: number; readonly maxBytes: number };
  readonly maxRunTimeoutMs?: number;
  readonly maxMaxOutputBytes?: number;
  /** Bound on the summed stdout+stderr bytes of retained receipts (#377). */
  readonly maxRetainedOutputBytes?: number;
  readonly denyReadSubpaths?: readonly string[];
  readonly envSource?: Readonly<Record<string, string | undefined>>;
}
const ENV = new Set(['PATH', 'LANG', 'LC_ALL', 'TZ', 'CI']);
const INSTALLERS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'pip', 'pip3', 'uv', 'cargo', 'bun']);
const POLICY = { maxRunTimeoutMs: 900_000, maxMaxOutputBytes: 8 * 1024 * 1024 };
/** Retention bounds for sealed receipts in a long-lived executor (#377):
 * the oldest receipts are evicted past either bound, so an evicted ref
 * resolves to null and every consumer fails closed (requalify), instead of
 * the executor holding unbounded output or refusing all later runs. */
const RETENTION = { maxReceipts: 1024, maxRetainedOutputBytes: 256 * 1024 * 1024 };
/** The host-owned runner config (#378). Under pool=threads the code under
 * test shares the process with Vitest's reporter, so stdout (and any file the
 * sandbox lets the run write) is writable by that code. The report is
 * therefore AUTHENTICATED by a per-run nonce the code under test cannot
 * learn: the host writes it on fd 3, and this config — evaluated in the main
 * thread before any test worker exists — reads it and closes the fd. The
 * reporter frames Vitest's own JSON report with the nonce; the host parses
 * only that one framed block. The nonce never appears in argv, env or files. */
const CONFIG = [
  "import { closeSync, readSync } from 'node:fs';",
  // fd 3 may be a non-blocking socket: retry EAGAIN (bounded), and always close it.
  'let nonce = \'\';',
  'try {',
  '  const buffer = Buffer.alloc(128); let length = 0; let waited = 0;',
  '  for (;;) {',
  '    let read;',
  '    try { read = readSync(3, buffer, length, buffer.length - length, null); }',
  "    catch (error) { if (error.code !== 'EAGAIN' || waited >= 5000) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); waited += 10; continue; }",
  '    if (read === 0 || (length += read) >= buffer.length) break;',
  '  }',
  "  nonce = buffer.subarray(0, length).toString('utf8').trim();",
  '} finally { closeSync(3); }',
  "if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error('host report nonce unavailable');",
  'const { JsonReporter } = await import(process.env.GRU_PROPERTY_REPORTERS_MODULE);',
  'class HostFramedJsonReporter extends JsonReporter {',
  '  async writeReport(report) { process.stdout.write(`\\n${nonce}:BEGIN\\n${report}\\n${nonce}:END\\n`); }',
  '}',
  "export default { esbuild: false, server: { host: '127.0.0.1', hmr: false, watch: null }, test: { api: false, cache: false, pool: 'threads', maxWorkers: 1, minWorkers: 1, fileParallelism: false, watch: false, reporters: [new HostFramedJsonReporter({})], deps: { optimizer: { ssr: { enabled: false }, client: { enabled: false } } } } };",
  '',
].join('\n');

/** The single nonce-framed report in `stdout`, or null when it is absent,
 * duplicated or unterminated (#378). Nothing outside the frame is parsed. */
export function framedRunnerReport(stdout: string, nonce: string): string | null {
  const begin = `\n${nonce}:BEGIN\n`;
  const end = `\n${nonce}:END\n`;
  const start = stdout.indexOf(begin);
  if (start === -1 || stdout.indexOf(begin, start + 1) !== -1) return null;
  const finish = stdout.indexOf(end, start + begin.length);
  if (finish === -1 || stdout.indexOf(end, finish + 1) !== -1) return null;
  return stdout.slice(start + begin.length, finish);
}
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
/** Bounded storage: one growing buffer per stream (doubling, never past the
 * cap), so even a flood of tiny writes keeps O(1) objects and at most
 * `maxBytes` per stream — never a 2 × maxBytes preallocation (#377) and
 * never an incoming chunk's backing allocation (kept bytes are COPIED). */
export function createBoundedPropertyCapture(maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > POLICY.maxMaxOutputBytes) throw new PreExecutionRejectionError('budget-exceeds-policy', 'invalid capture capacity');
  const store = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const sizes = { stdout: 0, stderr: 0 }; const truncated = { stdout: false, stderr: false };
  return {
    /** Bytes actually allocated (at most 2 × maxBytes, only as output arrives). */
    get capacityBytes(): number { return store.stdout.length + store.stderr.length; },
    push(name: 'stdout' | 'stderr', chunk: Buffer) {
      const count = Math.min(chunk.length, maxBytes - sizes[name]);
      if (count > 0) {
        const need = sizes[name] + count;
        if (store[name].length < need) {
          const grown = Buffer.alloc(Math.min(maxBytes, Math.max(need, store[name].length * 2, 4096)));
          store[name].copy(grown, 0, 0, sizes[name]);
          store[name] = grown;
        }
        chunk.copy(store[name], sizes[name], 0, count);
        sizes[name] = need;
      }
      if (count < chunk.length) truncated[name] = true;
    },
    finish() {
      return { stdout: store.stdout.subarray(0, sizes.stdout).toString('utf8'), stderr: store.stderr.subarray(0, sizes.stderr).toString('utf8'),
        stdoutTruncated: truncated.stdout, stderrTruncated: truncated.stderr, complete: !truncated.stdout && !truncated.stderr };
    },
  };
}

/** Least-recently-used receipt retention with count and byte bounds (#377).
 * `bytes` is the receipt's whole serialized size. `add` evicts the least
 * recently added-or-read receipts (never the one just added) until both
 * bounds hold — a receipt a campaign is still resolving stays warm; a
 * receipt that alone exceeds the byte bound is refused by name; an evicted id
 * resolves to undefined and is counted. */
export function createReceiptRetention<T>(bounds: { readonly maxReceipts: number; readonly maxBytes: number }) {
  const entries = new Map<string, { readonly value: T; readonly bytes: number }>();
  let total = 0; let evicted = 0;
  return {
    add(id: string, value: T, bytes: number): void {
      if (bytes > bounds.maxBytes) throw new PreExecutionRejectionError('budget-exceeds-policy', `a ${String(bytes)}-byte receipt exceeds the ${String(bounds.maxBytes)}-byte retention bound`);
      const prior = entries.get(id);
      if (prior !== undefined) { entries.delete(id); total -= prior.bytes; }
      entries.set(id, { value, bytes }); total += bytes;
      for (const [oldest, entry] of entries) {
        if (oldest === id || (entries.size <= bounds.maxReceipts && total <= bounds.maxBytes)) break;
        entries.delete(oldest); total -= entry.bytes; evicted += 1;
      }
    },
    get(id: string | undefined): T | undefined {
      if (id === undefined) return undefined;
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      entries.delete(id); entries.set(id, entry); // a read keeps it warm
      return entry.value;
    },
    get size(): number { return entries.size; },
    get retainedBytes(): number { return total; },
    get evicted(): number { return evicted; },
  };
}
/** Read-only current harness identity, never an execution approval. */
export function propertyWorkspaceIdentity(root: string) { return snapshotWorkspace(realpathSync(root), { maxFiles: 60_000, maxBytes: 2 * 1024 ** 3 }); }
/** Everything except explicitly owner-approved implementation files is frozen. */
export function propertyProtectedIdentity(root: string, implementationPaths: readonly string[]): string {
  const allowed = new Set(implementationPaths);
  const tracked = new Set(propertyGit(root, ['ls-files', '-z']).split('\0').filter((path) => path !== '' && !allowed.has(path)));
  return snapshotWorkspace(realpathSync(root), { maxFiles: 60_000, maxBytes: 2 * 1024 ** 3 }, tracked).digest;
}
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
  /** Retained receipt count/bytes and the byte bound (#377). */
  retention(): { readonly receipts: number; readonly retainedOutputBytes: number; readonly maxRetainedOutputBytes: number; readonly evicted: number };
}
export function createPropertyExecutor(options: PropertyExecutorOptions = {}): PropertyExecutor {
  const ceilings = { maxRunTimeoutMs: options.maxRunTimeoutMs ?? POLICY.maxRunTimeoutMs, maxMaxOutputBytes: options.maxMaxOutputBytes ?? POLICY.maxMaxOutputBytes };
  for (const [key, value] of Object.entries(ceilings)) if (!Number.isSafeInteger(value) || value <= 0 || value > POLICY[key as keyof typeof POLICY]) throw new PreExecutionRejectionError('budget-exceeds-policy', `invalid host ceiling ${key}`);
  if (options.workspaceCopyBounds !== undefined && (!Number.isSafeInteger(options.workspaceCopyBounds.maxFiles) || options.workspaceCopyBounds.maxFiles < 1 || options.workspaceCopyBounds.maxFiles > 60_000 || !Number.isSafeInteger(options.workspaceCopyBounds.maxBytes) || options.workspaceCopyBounds.maxBytes < 1 || options.workspaceCopyBounds.maxBytes > 2 * 1024 ** 3)) throw new WorkspaceCopyError('invalid approved workspace copy bounds');
  const approvals = new WeakMap<ExecutionApproval, { readonly digest: string; readonly workspaceTreeSha256: string }>();
  const maxRetainedOutputBytes = options.maxRetainedOutputBytes ?? RETENTION.maxRetainedOutputBytes;
  if (!Number.isSafeInteger(maxRetainedOutputBytes) || maxRetainedOutputBytes < 1 || maxRetainedOutputBytes > RETENTION.maxRetainedOutputBytes) throw new PreExecutionRejectionError('budget-exceeds-policy', 'invalid host receipt retention bound');
  const receipts = createReceiptRetention<SealedExecutionReceipt>({ maxReceipts: RETENTION.maxReceipts, maxBytes: maxRetainedOutputBytes });
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
    /** Retention introspection for diagnostics and tests (#377). */
    retention() { return { receipts: receipts.size, retainedOutputBytes: receipts.retainedBytes, maxRetainedOutputBytes, evicted: receipts.evicted }; },
    async executePlan(input) {
      const { plan, repoRoot, packageDir } = input;
      if (options.signal?.aborted) return { executed: false, refusal: { kind: 'not-run', reason: 'property host aborted/disposed', backend: 'none-found' } };
      if (running) return { executed: false, refusal: { kind: 'not-run', reason: 'host property concurrency ceiling (one run) is occupied', backend: 'none-found' } };
      const backend = resolveSandboxBackend(options.sandboxExecutable);
      if (!plan.executable || plan.refusalReason !== null || backend.executable === null) return { executed: false, refusal: { kind: 'not-run', reason: plan.refusalReason ?? backend.reason ?? 'plan is not executable', backend: backend.backend } };
      if (input.adapter !== VITEST_FAST_CHECK_ADAPTER) throw new PreExecutionRejectionError('invalid-plan', 'caller-supplied adapters are not execution authority');
      const approved = input.approval === undefined ? undefined : approvals.get(input.approval);
      if (input.approval === undefined || approved === undefined || approved.digest !== fingerprint(input).digest) throw new PreExecutionRejectionError('unapproved-command', 'missing, forged or stale host approval for exact source/plan/runner');
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
        // The copied Vitest's own reporters module (beside its runner), for the
        // host config's framed reporter; the nonce itself goes only on fd 3.
        const reportersModule = join(dirname(runner.path), 'dist', 'reporters.js');
        // The framed report depends on the copied Vitest's own reporters
        // module: a layout without it is refused by name before any run.
        if (!existsSync(reportersModule)) throw new PreExecutionRejectionError('unapproved-command', `copied Vitest has no ${relative(workspace, reportersModule)}; the host-framed report cannot be produced`);
        env['GRU_PROPERTY_REPORTERS_MODULE'] = pathToFileURL(reportersModule).href;
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
        // `--reporter=json` is the approved plan's report request; the host
        // config's nonce-framed JSON reporter fulfils it (a CLI reporter flag
        // would replace the config reporters and print an unframed report).
        const runnerArgs = plan.args.filter((arg) => arg !== '--reporter=json');
        const argv = [realpathSync(process.execPath), '--max-old-space-size=256', runner.path, ...runnerArgs, '--config', configPath, '--configLoader', 'native'];
        const reportNonce = randomBytes(32).toString('hex');
        const start = Date.now();
        const child = spawn(backend.executable, ['-p', sbpl, ...argv], { cwd: wsPkg, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
        // A runner that never reads fd 3 yields no framed report; the channel
        // failure is RECORDED as that run's reason, never swallowed.
        let nonceChannelError: string | null = null;
        const nonceChannel = child.stdio[3] as (NodeJS.WritableStream & { on(event: 'error', listener: (error: Error) => void): unknown }) | null | undefined;
        if (nonceChannel === null || nonceChannel === undefined) nonceChannelError = 'host report channel (fd 3) was not created';
        else {
          nonceChannel.on('error', (error) => { nonceChannelError = String(error); });
          nonceChannel.end(`${reportNonce}\n`);
        }
        const collector = createBoundedPropertyCapture(plan.budget.maxOutputBytes);
        for (const name of ['stdout', 'stderr'] as const) child[name]!.on('data', (buf: Buffer) => collector.push(name, buf));
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; if (child.pid !== undefined) killGroup(child.pid); }, plan.budget.runTimeoutMs);
        const abort = () => { if (child.pid !== undefined) killGroup(child.pid); };
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        try {
          await new Promise<void>((resolve, reject) => {
            let spawnError: Error | null = null;
            child.once('error', (error) => { spawnError = error; });
            child.once('close', () => spawnError === null ? resolve() : reject(spawnError));
          });
        } catch (error) { throw new SandboxSpawnError(String(error)); } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
        const proven = child.pid !== undefined && !groupAlive(child.pid);
        // No fork permission exists. If the group is nevertheless live, do
        // not issue evidence, release resources, or claim successful cleanup.
        if (!proven) throw new SandboxSpawnError(`cessation unproven; workspace retained at ${workspace}`);
        const capture = collector.finish(); const { stdout, stderr } = capture;
        const raw = { stdout, stderr, report: framedRunnerReport(stdout, reportNonce), exitCode: child.exitCode, signal: child.signalCode, timedOut, durationMs: Date.now() - start };
        let outcome = VITEST_FAST_CHECK_ADAPTER.interpretExecution(raw, { ...plan, cwd: wsPkg });
        if ((capture.stdoutTruncated || capture.stderrTruncated) && outcome.kind === 'pass') outcome = { ...outcome, kind: 'inconclusive', reasons: [...outcome.reasons, 'output capture was truncated'] };
        // Why there is no authenticated report, by name (#378).
        if (raw.report === null) {
          const why = capture.stdoutTruncated ? 'no host-framed report: stdout reached the output cap before the frame closed'
            : nonceChannelError !== null ? `no host-framed report: host report channel failed: ${nonceChannelError}`
            : 'no host-framed report: the run printed no single complete nonce frame';
          outcome = { ...outcome, reasons: [...outcome.reasons, why] };
        }
        const environmentProfile = environmentProfileString(env);
        const counterexample = retainedCounterexample({ outcome, environmentProfile });
        const body = assemblePropertyExecutionReceipt({
          identity: { source, workspaceTreeSha256: snapshot.digest, dependencyTreeSha256: snapshot.dependencyDigest, argv, selectionFilter: plan.args[2]!, lockIdentity: lockfileIdentity(pkg, root), configIdentity: propertyConfigIdentity(root), overlay, adapterProfile: `vitest-fast-check;deny-fork;native-config;nonce-framed-report;${sha256Hex(CONFIG)}`, toolVersions: { node: process.versions.node, ...Object.fromEntries(['vitest', 'fast-check'].map((name) => { try { return [name, JSON.parse(readFileSync(join(wsPkg, 'node_modules', name, 'package.json'), 'utf8')).version as string]; } catch { return [name, 'unknown']; } })) } },
          command: argv[0]!, cwd: wsPkg, outcome, stdout, stderr,
          capture: { stdoutTruncated: capture.stdoutTruncated, stderrTruncated: capture.stderrTruncated, complete: !capture.stdoutTruncated && !capture.stderrTruncated },
          counterexample, sandbox: { backend: 'macos-sandbox-exec', profileSummary: `deny-default; read-only workspace/runtime allowlist; no disk writes/network/fork; denials may return EPERM (no per-syscall audit claim); 256MiB V8 heap; profile ${sha256Hex(sbpl)}`, networkDenied: true, filesystemIsolated: true, credentialsStripped: true, refusalReason: null }, replay: input.replaySeed == null ? counterexample?.replay ?? null : { seed: input.replaySeed, shrinkPath: input.replayPath == null ? [] : [input.replayPath], schedule: null, environmentProfile, replaySupported: true, replayDisclosure: 'host-requested native replay controls; PASS alone does not establish reproduction' }, budget: { ...plan.budget },
        });
        const sealed = body as SealedExecutionReceipt;
        const serialized = JSON.stringify(sealed);
        issued.set(sealed, sha256Hex(serialized));
        const ref = { receiptId: `pex-${randomUUID()}` };
        // Retention counts the WHOLE receipt (outcome, excerpts, overlay,
        // counterexample), not just its two output streams.
        receipts.add(ref.receiptId, sealed, Buffer.byteLength(serialized));
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
