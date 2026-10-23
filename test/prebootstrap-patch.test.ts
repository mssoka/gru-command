import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { DispatchService } from '../src/dispatch/service.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { readCreationIntent } from '../src/worktrees/creation-intent.js';
import { repositoryCommonDirectory } from '../src/worktrees/handoff.js';
import {
  assertSafeRequirementsPatch,
  originIdentitySha256,
  parsePreBootstrapDependencyPatchPackage,
  parsePreBootstrapPatchReference,
  preBootstrapPackageContentSha256,
  preBootstrapRequestPayloadSha256,
  PREBOOTSTRAP_PATCH_AUTHORIZATION,
  readPreBootstrapDependencyPatchPackage,
} from '../src/worktrees/prebootstrap-patch.js';
import type { LoadedPreBootstrapPatch, PreBootstrapDependencyPatchPackage } from '../src/worktrees/prebootstrap-patch.js';
import type { AgentCapabilities, AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import { attachBareOrigin, makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

const CAPABILITIES: AgentCapabilities = {
  streaming: true, steer: 'native', resume: 'file', images: false, thinking: false,
  thinkingLevelControl: false, followUp: false,
};
const AUTHORIZED_BRIEFING = `Repair the pinned dependency.\n${PREBOOTSTRAP_PATCH_AUTHORIZATION}\n`;
const OLD_REQUIREMENTS = 'fixture-dep==1.0.0\nshared-lib==4.2.0\n';
const NEW_REQUIREMENTS = 'fixture-dep==2.0.0\nshared-lib==4.2.0\n';

interface PatchFixture {
  readonly repo: FixtureRepo;
  readonly origin: string;
  readonly root: string;
  readonly packageRoot: string;
  readonly ledger: LedgerApi;
  readonly db: LedgerDb;
  readonly manager: WorktreeManager;
  readonly service: DispatchService;
  readonly sourceHead: string;
  readonly sourceRequirements: string;
  readonly spawns: { readonly role: string; readonly cwd: string | undefined }[];
  readonly makePackage: (input?: { readonly jobId?: string; readonly briefing?: string; readonly content?: string; readonly mutate?: (pkg: Record<string, unknown>) => void }) => { readonly reference: { readonly packageFile: string; readonly packageSha256: string }; readonly loaded: LoadedPreBootstrapPatch; readonly path: string; readonly package: PreBootstrapDependencyPatchPackage };
  readonly restart: () => void;
  readonly close: () => void;
}

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

function fixture(setupCommand?: string): PatchFixture {
  const repo = makeFixtureRepo('fixture-prebootstrap');
  repo.commitFile('requirements.txt', OLD_REQUIREMENTS);
  const commandProgram = `const fs=require('node:fs'); const text=fs.readFileSync('requirements.txt','utf8'); if(!text.includes('fixture-dep==2.0.0')) process.exit(9); fs.writeFileSync('setup-succeeded','same-configured-setup\\n');`;
  repo.commitFile('.gru-command/worktree.toml', `[[setup]]\ncommand = ${JSON.stringify(setupCommand ?? `node -e ${JSON.stringify(commandProgram)}`)}\n`);
  const origin = attachBareOrigin(repo);
  repo.git(['push', '--quiet', 'origin', 'main']);
  const sourceHead = repo.head();
  const sourceRequirements = readFileSync(join(repo.path, 'requirements.txt'), 'utf8');
  const root = join(dirname(repo.path), 'gc-private');
  const packageRoot = join(root, 'prebootstrap-patches');
  mkdirSync(packageRoot, { recursive: true, mode: 0o700 });
  let db = new LedgerDb(join(root, 'ledger'));
  let ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
  const worktreeRoot = join(root, 'worktrees');
  const preserveRoot = join(root, 'preserve');
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(preserveRoot, { recursive: true });
  const makeManager = (): WorktreeManager => new WorktreeManager({ ledger, root: worktreeRoot, preserveRoot, setupTimeoutMs: 10_000,
    preBootstrapPatchRoot: packageRoot, enumerateProcesses: () => [], });
  let manager = makeManager();
  const spawns: { role: string; cwd: string | undefined }[] = [];
  const spawner = async (role: 'minion' | 'perkins' | 'silas' | 'bob', options?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, cwd: options?.cwd });
    const handle: AgentHandle = {
      role,
      id: `fake-${String(spawns.length)}`,
      sessionFile: null,
      capabilities: CAPABILITIES,
      async prompt() {},
      async steer() {},
      async followUp() {},
      subscribe() { return () => {}; },
      health() { return { state: 'idle', lastActivity: new Date().toISOString(), sessionFile: null }; },
      async dispose() {},
    };
    return handle;
  };
  let service = new DispatchService({ ledger, worktrees: manager, spawner, preBootstrapPatchRoot: packageRoot });
  const makePackage = (input: { readonly jobId?: string; readonly briefing?: string; readonly content?: string; readonly mutate?: (pkg: Record<string, unknown>) => void } = {}) => {
    const jobId = input.jobId ?? 'job-prebootstrap';
    const briefing = input.briefing ?? AUTHORIZED_BRIEFING;
    const content = input.content ?? NEW_REQUIREMENTS;
    const packageFile = `${jobId}.json`;
    const baseCommit = repo.head();
    const baseTree = repo.git(['rev-parse', `${baseCommit}^{tree}`]);
    const originUrl = repo.git(['remote', 'get-url', 'origin']);
    const identity = {
      jobId,
      repoPath: repo.path,
      title: 'Synthetic dependency repair',
      displayName: null,
      deliverable: 'pr',
      briefing,
      completionHandoff: null,
      packageFile,
    } as const;
    const pkg: Record<string, unknown> = {
      version: 1,
      repository: { path: realpathSync(repo.path), origin_sha256: originIdentitySha256(originUrl) },
      base: { commit: baseCommit, tree: baseTree },
      authority: {
        contract_sha256: sha(briefing),
        work_revision: 0,
        authority_epoch: 0,
        request_sha256: preBootstrapRequestPayloadSha256(identity),
      },
      allowlist: ['requirements.txt'],
      files: [{ path: 'requirements.txt', before_sha256: sha(readFileSync(join(repo.path, 'requirements.txt'))), after_sha256: preBootstrapPackageContentSha256(content), content }],
    };
    input.mutate?.(pkg);
    const bytes = Buffer.from(JSON.stringify(pkg), 'utf8');
    const path = join(packageRoot, packageFile);
    writeFileSync(path, bytes, { mode: 0o600 });
    const reference = { packageFile, packageSha256: sha(bytes) };
    const loaded = readPreBootstrapDependencyPatchPackage(packageRoot, reference);
    return { reference, loaded, path, package: loaded.package };
  };
  return {
    repo, origin, root, packageRoot, get ledger() { return ledger; }, get db() { return db; }, get manager() { return manager; }, get service() { return service; },
    sourceHead, sourceRequirements, spawns, makePackage,
    restart() {
      db.close();
      db = new LedgerDb(join(root, 'ledger'));
      ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
      manager = makeManager();
      service = new DispatchService({ ledger, worktrees: manager, spawner, preBootstrapPatchRoot: packageRoot });
    },
    close() { db.close(); repo.cleanup(); rmSync(root, { recursive: true, force: true }); },
  };
}

const active: PatchFixture[] = [];
afterEach(() => { vi.restoreAllMocks(); while (active.length > 0) active.pop()!.close(); });
function makeFixture(setupCommand?: string): PatchFixture { const value = fixture(setupCommand); active.push(value); return value; }

async function dispatch(f: PatchFixture, jobId = 'job-prebootstrap', reference?: { packageFile: string; packageSha256: string }, briefing = AUTHORIZED_BRIEFING) {
  return f.service.dispatch({ jobId, repoPath: f.repo.path, title: 'Synthetic dependency repair', briefing,
    ...(reference === undefined ? {} : { preBootstrapPatch: reference }) });
}

describe('pre-bootstrap dependency patch package fences', () => {
  it('reads only hash-matched bounded package files beneath the private package root', () => {
    const f = makeFixture();
    const made = f.makePackage();
    expect(parsePreBootstrapPatchReference({ package_file: made.reference.packageFile, package_sha256: made.reference.packageSha256 })).toEqual(made.reference);
    expect(readPreBootstrapDependencyPatchPackage(f.packageRoot, made.reference).package).toEqual(made.package);
    expect(() => parsePreBootstrapPatchReference({ package_file: '../escape.json', package_sha256: made.reference.packageSha256 })).toThrow(/basename/u);
    expect(() => parsePreBootstrapDependencyPatchPackage(Buffer.from('{}'), '0'.repeat(64))).toThrow(/SHA-256/u);
    expect(() => parsePreBootstrapDependencyPatchPackage(Buffer.alloc(1024 * 1024 + 1), '0'.repeat(64))).toThrow(/exceeds/u);
    const link = join(f.packageRoot, 'linked.json');
    symlinkSync(made.path, link);
    expect(() => readPreBootstrapDependencyPatchPackage(f.packageRoot, { packageFile: 'linked.json', packageSha256: made.reference.packageSha256 })).toThrow(/regular file|symlink/u);
    const rootLink = join(f.root, 'package-root-link');
    symlinkSync(f.packageRoot, rootLink);
    expect(() => readPreBootstrapDependencyPatchPackage(rootLink, made.reference)).toThrow(/root is unavailable/u);
    chmodSync(made.path, 0o644);
    expect(() => readPreBootstrapDependencyPatchPackage(f.packageRoot, made.reference)).toThrow(/owner-only/u);
  });

  it('refuses malformed schema, unknown files, unsupported revision, and non-dependency syntax', () => {
    const f = makeFixture();
    const made = f.makePackage();
    expect(() => parsePreBootstrapDependencyPatchPackage(Buffer.from('{"version":1}'), sha('{"version":1}'))).toThrow(/exactly/u);
    const duplicate = Buffer.from('{"version":1,"version":1}');
    expect(() => parsePreBootstrapDependencyPatchPackage(duplicate, sha(duplicate))).toThrow(/duplicate JSON key/u);
    const unsupported = JSON.parse(readFileSync(made.path, 'utf8')) as Record<string, unknown>;
    (unsupported['authority'] as Record<string, unknown>)['work_revision'] = 1;
    const bytes = Buffer.from(JSON.stringify(unsupported));
    expect(() => parsePreBootstrapDependencyPatchPackage(bytes, sha(bytes))).toThrow(/revision 0/u);
    const otherFile = JSON.parse(readFileSync(made.path, 'utf8')) as Record<string, unknown>;
    ((otherFile['files'] as Record<string, unknown>[])[0]!)['path'] = '.gru-command/worktree.toml';
    const otherFileBytes = Buffer.from(JSON.stringify(otherFile));
    expect(() => parsePreBootstrapDependencyPatchPackage(otherFileBytes, sha(otherFileBytes))).toThrow(/exactly requirements.txt/u);
    expect(() => assertSafeRequirementsPatch(OLD_REQUIREMENTS, 'fixture-dep==2.0.0\n--index-url https://example.invalid\n')).toThrow(/pinned distribution/u);
    expect(() => assertSafeRequirementsPatch(OLD_REQUIREMENTS, '# changed comment\nfixture-dep==2.0.0\nshared-lib==4.2.0\n')).toThrow(/comments and blank lines/u);
  });

  it('rejects an unapproved or mismatched contract before creating a job or lane', async () => {
    const f = makeFixture();
    const made = f.makePackage({ briefing: 'Missing the explicit authorization.' });
    await expect(dispatch(f, 'job-no-authorization', made.reference, 'Missing the explicit authorization.')).rejects.toThrow(/authorization/u);
    expect(f.ledger.getJob('job-no-authorization')).toBeNull();
    expect(f.ledger.getWorktree('job-no-authorization')).toBeNull();
    expect(f.spawns).toHaveLength(0);
    const valid = f.makePackage({ jobId: 'job-contract', briefing: AUTHORIZED_BRIEFING });
    await expect(dispatch(f, 'job-contract', valid.reference, `${AUTHORIZED_BRIEFING}changed`)).rejects.toThrow(/different work contract/u);
    expect(f.ledger.getJob('job-contract')).toBeNull();
    expect(f.repo.head()).toBe(f.sourceHead);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
  });

  it('refuses report and nested lanes before creating a job or lane', async () => {
    const f = makeFixture();
    const report = f.makePackage({ jobId: 'job-report' });
    await expect(f.service.dispatch({ jobId: 'job-report', repoPath: f.repo.path, title: 'report', briefing: AUTHORIZED_BRIEFING,
      deliverable: 'artifact', preBootstrapPatch: report.reference })).rejects.toThrow(/only for an ordinary PR-owing implementation lane/u);
    const nested = f.makePackage({ jobId: 'job-nested' });
    await expect(f.service.dispatch({ jobId: 'job-nested', repoPath: f.repo.path, title: 'nested', briefing: AUTHORIZED_BRIEFING,
      parentJobId: 'parent-job', preBootstrapPatch: nested.reference })).rejects.toThrow(/fresh top-level job lane/u);
    expect(f.ledger.getJob('job-report')).toBeNull();
    expect(f.ledger.getJob('job-nested')).toBeNull();
    expect(f.spawns).toHaveLength(0);
  });

  it('binds package admission to the exact normalized dispatch payload', async () => {
    const f = makeFixture();
    const made = f.makePackage({ jobId: 'job-request-mismatch' });
    await expect(f.service.dispatch({ jobId: 'job-request-mismatch', repoPath: f.repo.path, title: 'Changed title',
      briefing: AUTHORIZED_BRIEFING, preBootstrapPatch: made.reference })).rejects.toThrow(/different dispatch payload/u);
    expect(f.ledger.getJob('job-request-mismatch')).toBeNull();
    const handoff = f.makePackage({ jobId: 'job-handoff-mismatch' });
    await expect(f.service.dispatch({ jobId: 'job-handoff-mismatch', repoPath: f.repo.path, title: 'Synthetic dependency repair',
      briefing: AUTHORIZED_BRIEFING, completionHandoff: { kind: 'gru-decision', decision: 'unbound intent' },
      preBootstrapPatch: handoff.reference })).rejects.toThrow(/different dispatch payload/u);
    expect(f.ledger.getJob('job-handoff-mismatch')).toBeNull();
    expect(f.spawns).toHaveLength(0);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
  });

  it('refuses missing/hash-invalid packages before a job or lane exists', async () => {
    const f = makeFixture();
    const missing = { packageFile: 'missing.json', packageSha256: 'a'.repeat(64) };
    await expect(dispatch(f, 'job-missing-package', missing)).rejects.toThrow(/unavailable/u);
    expect(f.ledger.getJob('job-missing-package')).toBeNull();
    const made = f.makePackage({ jobId: 'job-wrong-package-hash' });
    await expect(dispatch(f, 'job-wrong-package-hash', { packageFile: made.reference.packageFile, packageSha256: '0'.repeat(64) })).rejects.toThrow(/SHA-256/u);
    expect(f.ledger.getJob('job-wrong-package-hash')).toBeNull();
    expect(f.spawns).toHaveLength(0);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
  });

  it('rejects mismatched old dependency bytes before creating a branch', async () => {
    const f = makeFixture();
    const made = f.makePackage({ jobId: 'job-old-bytes-mismatch', mutate: (pkg) => {
      ((pkg['files'] as Record<string, unknown>[])[0]!)['before_sha256'] = '0'.repeat(64);
    } });
    await expect(dispatch(f, 'job-old-bytes-mismatch', made.reference)).rejects.toThrow(/file_mismatch/u);
    expect(f.ledger.getWorktree('job-old-bytes-mismatch')).toBeNull();
    expect(f.repo.git(['branch', '--list', 'gru/job-old-bytes-mismatch'])).toBe('');
    expect(f.spawns).toHaveLength(0);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
  });

  it('rejects command/config content before creating a branch or writing source', async () => {
    const f = makeFixture();
    const made = f.makePackage({ jobId: 'job-unapproved-content', content: '-e /tmp/foreign\n' });
    await expect(dispatch(f, 'job-unapproved-content', made.reference)).rejects.toThrow(/pinned distribution/u);
    expect(f.ledger.getWorktree('job-unapproved-content')).toBeNull();
    expect(f.repo.git(['branch', '--list', 'gru/job-unapproved-content'])).toBe('');
    expect(f.spawns).toHaveLength(0);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
  });

  it('serializes concurrent identical initial dispatches and admits at most one worker', async () => {
    const f = makeFixture();
    const made = f.makePackage();
    const attempts = await Promise.allSettled([dispatch(f, 'job-prebootstrap', made.reference), dispatch(f, 'job-prebootstrap', made.reference)]);
    const fulfilled = attempts.find((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof dispatch>>> => attempt.status === 'fulfilled');
    expect(fulfilled).toBeDefined();
    await fulfilled!.value.settled;
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(f.spawns).toHaveLength(1);
    expect(f.ledger.listJobEvents('job-prebootstrap', { kinds: ['worktree.prebootstrap-patch-started'] })).toHaveLength(1);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
  });

  it('keeps ordinary no-patch dispatch behavior and emits no patch receipts', async () => {
    const f = makeFixture('node -e "require(\'node:fs\').writeFileSync(\'ordinary-setup\', \'ok\\n\')"');
    const outcome = await dispatch(f, 'job-no-patch');
    await outcome.settled;
    expect(f.spawns).toHaveLength(1);
    expect(existsSync(join(f.spawns[0]!.cwd!, 'ordinary-setup'))).toBe(true);
    expect(f.ledger.listJobEvents('job-no-patch', { kinds: ['job.prebootstrap-patch-admitted'] })).toHaveLength(0);
    expect(f.repo.head()).toBe(f.sourceHead);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
  });

  it('fails unchanged setup without a patch, then applies only the package in a new lane before that same setup and worker admission', async () => {
    const f = makeFixture();
    await expect(dispatch(f, 'job-unpatched')).rejects.toThrow(/exited 9/u);
    expect(f.spawns).toHaveLength(0);
    expect(f.ledger.getWorktree('job-unpatched')).toBeNull();
    expect(f.repo.head()).toBe(f.sourceHead);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);

    const sourceRefs = f.repo.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/main', 'refs/remotes/origin/main']);
    const made = f.makePackage({ jobId: 'job-patched' });
    const outcome = await dispatch(f, 'job-patched', made.reference);
    expect(f.spawns).toHaveLength(1);
    expect(existsSync(join(f.spawns[0]!.cwd!, 'setup-succeeded'))).toBe(true);
    expect(readFileSync(join(f.spawns[0]!.cwd!, 'requirements.txt'), 'utf8')).toBe(NEW_REQUIREMENTS);
    expect(readFileSync(join(f.spawns[0]!.cwd!, '.gru-command', 'worktree.toml'), 'utf8'))
      .toBe(readFileSync(join(f.repo.path, '.gru-command', 'worktree.toml'), 'utf8'));
    expect(f.ledger.latestJobEvent('job-patched', 'worktree.prebootstrap-setup-succeeded')?.seq)
      .toBeLessThan(f.ledger.latestJobEvent('job-patched', 'job.minion-spawned')?.seq ?? Number.MAX_SAFE_INTEGER);
    expect(f.ledger.latestJobEvent('job-patched', 'worktree.prebootstrap-setup-started')).not.toBeNull();
    expect(f.ledger.latestJobEvent('job-patched', 'worktree.prebootstrap-setup-spawned')).not.toBeNull();
    expect(f.ledger.latestJobEvent('job-patched', 'worktree.prebootstrap-setup-process-settled')).not.toBeNull();
    const patchEvent = f.ledger.latestJobEvent('job-patched', 'worktree.prebootstrap-patch-applied')?.payload as Record<string, unknown>;
    expect(patchEvent).toMatchObject({ changed_paths: ['requirements.txt'] });
    const alternateIndex = join(f.root, 'verification-index');
    const indexEnv = { ...process.env, GIT_INDEX_FILE: alternateIndex };
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: outcome.worktree.path, env: indexEnv });
    execFileSync('git', ['add', '--', 'requirements.txt'], { cwd: outcome.worktree.path, env: indexEnv });
    const independentlyComputedTree = execFileSync('git', ['write-tree'], { cwd: outcome.worktree.path, env: indexEnv, encoding: 'utf8' }).trim();
    expect(patchEvent['after_tree']).toBe(independentlyComputedTree);
    expect(outcome.agentId).toBe('fake-1');
    await outcome.settled;
    expect(f.repo.head()).toBe(f.sourceHead);
    expect(f.repo.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/main', 'refs/remotes/origin/main'])).toBe(sourceRefs);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
    expect(f.ledger.directiveCurrentAuthority('job-patched')).toMatchObject({ workRevision: 0, authorityEpoch: 0 });
  });

  it('refuses a worktree capability that returns without exact patch/setup receipts', async () => {
    const f = makeFixture();
    const made = f.makePackage({ jobId: 'job-no-setup-proof' });
    vi.spyOn(f.manager, 'createJobWorktreeWithPreBootstrapPatch').mockResolvedValue({
      id: 'job-no-setup-proof', kind: 'job', repoPath: f.repo.path, repoName: f.repo.path.split('/').filter(Boolean).at(-1) ?? 'fixture',
      path: join(f.root, 'fake-lane'), branch: 'gru/job-no-setup-proof', sha: f.sourceHead, baseSource: 'origin',
      jobId: 'job-no-setup-proof', roundId: null, status: 'active', note: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), laneToken: null,
    });
    await expect(dispatch(f, 'job-no-setup-proof', made.reference)).rejects.toThrow(/setup_receipt_mismatch/u);
    expect(f.spawns).toHaveLength(0);
    expect(f.ledger.getWorktree('job-no-setup-proof')).toBeNull();
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
  });

  it('refuses worker admission when contract authority changes after successful setup', async () => {
    const f = makeFixture();
    const made = f.makePackage({ jobId: 'job-authority-changed' });
    const originalAppend = f.ledger.appendCustomEvent.bind(f.ledger);
    const append = vi.spyOn(f.ledger, 'appendCustomEvent');
    const originalAuthority = f.ledger.directiveCurrentAuthority.bind(f.ledger);
    let authorityChanged = false;
    append.mockImplementation((input) => {
      const event = originalAppend(input);
      if (input.kind === 'worktree.prebootstrap-setup-succeeded') authorityChanged = true;
      return event;
    });
    vi.spyOn(f.ledger, 'directiveCurrentAuthority').mockImplementation((jobId) => {
      const current = originalAuthority(jobId);
      return authorityChanged ? { ...current, workRevision: current.workRevision + 1 } : current;
    });
    await expect(dispatch(f, 'job-authority-changed', made.reference)).rejects.toThrow(/authority_mismatch/u);
    expect(f.spawns).toHaveLength(0);
    expect(f.ledger.latestJobEvent('job-authority-changed', 'worktree.prebootstrap-setup-succeeded')).not.toBeNull();
    expect(f.ledger.latestJobEvent('job-authority-changed', 'job.prebootstrap-patch-dispatch-failed')).not.toBeNull();
    const retained = f.ledger.getWorktree('job-authority-changed');
    expect(retained?.status).toBe('active');
    expect(retained !== null && existsSync(retained.path)).toBe(true);
    expect(retained === null ? '' : readFileSync(join(retained.path, 'requirements.txt'), 'utf8')).toBe(NEW_REQUIREMENTS);
    expect(readCreationIntent(repositoryCommonDirectory(f.repo.path), 'gru/job-authority-changed')).not.toBeNull();
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
    append.mockRestore();
  });

  it('retains a patched lane on setup failure and never spawns a worker', async () => {
    const f = makeFixture('node -e "process.exit(7)"');
    const made = f.makePackage({ jobId: 'job-setup-failure' });
    await expect(dispatch(f, 'job-setup-failure', made.reference)).rejects.toThrow(/error_sha256=/u);
    expect(f.spawns).toHaveLength(0);
    const lane = f.ledger.getWorktree('job-setup-failure');
    expect(lane).not.toBeNull();
    expect(readFileSync(join(lane!.path, 'requirements.txt'), 'utf8')).toBe(NEW_REQUIREMENTS);
    expect(f.ledger.latestJobEvent('job-setup-failure', 'worktree.prebootstrap-setup-failed')?.payload).toMatchObject({ error_class: 'WorktreeSetupError', stage: 'setup' });
    expect(readCreationIntent(repositoryCommonDirectory(f.repo.path), 'gru/job-setup-failure')).not.toBeNull();
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
  });

  it('consumes an interrupted patch request, preserves the lane, and refuses same-job replay', async () => {
    const f = makeFixture();
    const made = f.makePackage({ jobId: 'job-interrupted' });
    const append = vi.spyOn(f.ledger, 'appendCustomEvent');
    let interrupted = false;
    append.mockImplementation((input) => {
      if (!interrupted && input.kind === 'worktree.prebootstrap-patch-applied') {
        interrupted = true;
        throw new Error('simulated receipt interruption');
      }
      return Object.getPrototypeOf(f.ledger).appendCustomEvent.call(f.ledger, input);
    });
    await expect(dispatch(f, 'job-interrupted', made.reference)).rejects.toThrow(/error_sha256=/u);
    expect(f.spawns).toHaveLength(0);
    const lane = f.ledger.getWorktree('job-interrupted');
    expect(lane).not.toBeNull();
    expect(readFileSync(join(lane!.path, 'requirements.txt'), 'utf8')).toBe(NEW_REQUIREMENTS);
    expect(f.ledger.latestJobEvent('job-interrupted', 'worktree.prebootstrap-patch-started')).not.toBeNull();
    expect(f.ledger.latestJobEvent('job-interrupted', 'worktree.prebootstrap-setup-started')).toBeNull();
    expect(readCreationIntent(repositoryCommonDirectory(f.repo.path), 'gru/job-interrupted')).not.toBeNull();
    append.mockRestore();
    f.restart();
    expect(f.ledger.getWorktree('job-interrupted')?.path).toBe(lane!.path);
    expect(f.ledger.latestJobEvent('job-interrupted', 'worktree.prebootstrap-patch-started')).not.toBeNull();
    await expect(dispatch(f, 'job-interrupted', made.reference)).rejects.toThrow(/already exists|duplicate|UNIQUE/u);
    expect(readFileSync(join(lane!.path, 'requirements.txt'), 'utf8')).toBe(NEW_REQUIREMENTS);
    expect(f.spawns).toHaveLength(0);
  });

  it('rejects a changed repository origin and failed-fetch local fallback before creating a lane', async () => {
    const f = makeFixture();
    const made = f.makePackage({ jobId: 'job-origin-mismatch' });
    f.repo.git(['remote', 'set-url', 'origin', join(dirname(f.repo.path), 'different-origin.git')]);
    await expect(dispatch(f, 'job-origin-mismatch', made.reference)).rejects.toThrow(/source_mismatch/u);
    expect(f.ledger.getWorktree('job-origin-mismatch')).toBeNull();
    expect(f.repo.git(['branch', '--list', 'gru/job-origin-mismatch'])).toBe('');
    expect(f.spawns).toHaveLength(0);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);
  });

  it('rejects a symlinked source dependency file before creating the branch or applying content', async () => {
    const f = makeFixture();
    const target = join(f.repo.path, 'requirements-target.txt');
    writeFileSync(target, OLD_REQUIREMENTS);
    f.repo.git(['rm', '--quiet', 'requirements.txt']);
    symlinkSync('requirements-target.txt', join(f.repo.path, 'requirements.txt'));
    f.repo.git(['add', 'requirements.txt', 'requirements-target.txt']);
    f.repo.git(['commit', '--quiet', '-m', 'synthetic symlink requirements']);
    f.repo.git(['push', '--quiet', 'origin', 'main']);
    const made = f.makePackage({ jobId: 'job-symlink-requirements' });
    await expect(dispatch(f, 'job-symlink-requirements', made.reference)).rejects.toThrow(/file_mismatch/u);
    expect(f.ledger.getWorktree('job-symlink-requirements')).toBeNull();
    expect(f.repo.git(['branch', '--list', 'gru/job-symlink-requirements'])).toBe('');
    expect(readFileSync(target, 'utf8')).toBe(OLD_REQUIREMENTS);
    expect(f.spawns).toHaveLength(0);
  });

  it('rejects stale base and foreign branch receipts before applying content', async () => {
    const f = makeFixture();
    const stale = f.makePackage({ jobId: 'job-stale-base' });
    f.repo.commitFile('src/new-head.ts', 'export const newer = true;\n');
    f.repo.git(['push', '--quiet', 'origin', 'main']);
    await expect(dispatch(f, 'job-stale-base', stale.reference)).rejects.toThrow(/error_sha256=/u);
    expect(f.ledger.getWorktree('job-stale-base')).toBeNull();
    expect(f.spawns).toHaveLength(0);
    expect(readFileSync(join(f.repo.path, 'requirements.txt'), 'utf8')).toBe(f.sourceRequirements);

    const foreign = f.makePackage({ jobId: 'job-foreign-branch' });
    f.repo.git(['branch', 'gru/job-foreign-branch', 'HEAD']);
    await expect(dispatch(f, 'job-foreign-branch', foreign.reference)).rejects.toThrow(/foreign_ref/u);
    expect(f.ledger.getWorktree('job-foreign-branch')).toBeNull();
    expect(f.spawns).toHaveLength(0);
  });
});
