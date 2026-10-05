import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request } from 'node:http';
import { dirname, join, sep } from 'node:path';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPackageRoot } from '../src/build-info.js';
import { reviewRuntimeVersion, reviewServiceRuntimeIdentity } from '../src/runtime/review-build-identity.js';
import { reviewPythonExecutable } from '../src/runtime/review-directory-entries.js';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { EventBus } from '../src/events/bus.js';
import { attachBareOrigin, makeFixtureRepo } from './helpers/fixture-repo.js';
import { PersistedReviewPort } from './helpers/persisted-review-port.js';
import { fakeWholeSpawner, groundedFinding } from './helpers/perkins-whole-double.js';

const roots: string[] = [];
const fixture = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function packageIdentity(): { root: string; identity: string } {
  const root = fixture('gru-review-pack-');
  // Standalone test: compile in an isolated tree rather than assuming npm
  // test already populated dist or racing another suite's shared build.
  const source = defaultPackageRoot();
  const build = join(root, 'build');
  for (const path of ['src', 'tools', 'resources', 'roles', 'package.json', 'package-lock.json', 'tsconfig.json']) {
    cpSync(join(source, path), join(build, path), { recursive: true });
  }
  symlinkSync(join(source, 'node_modules'), join(build, 'node_modules'), 'dir');
  execFileSync('npm', ['run', 'build'], { cwd: build, timeout: 120_000 });
  const manifest = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
    cwd: build, encoding: 'utf8', timeout: 60_000,
  })) as [{ filename: string; files: Array<{ path: string }> }];
  expect(manifest[0]!.files.some((entry) => entry.path === 'package-lock.json')).toBe(false);
  expect(manifest[0]!.files.some((entry) => entry.path === 'dist/review-dependency-identity.json')).toBe(true);
  execFileSync('tar', ['-xzf', join(root, manifest[0]!.filename), '-C', root]);
  const installed = join(root, 'package');
  // Copy precisely the installed dependency closure from this npm-ci tree.
  // This is offline and also avoids npm adding a lock to the unpacked tarball.
  const visited = new Set<string>();
  const copyDependency = (name: string, parent: string): void => {
    let base = parent;
    let directory: string | null = null;
    while (base === source || base.startsWith(`${source}${sep}`)) {
      const candidate = join(base, 'node_modules', name);
      if (existsSync(candidate)) { directory = candidate; break; }
      base = dirname(base);
    }
    if (directory === null || visited.has(directory)) return;
    visited.add(directory);
    const destination = join(installed, directory.slice(source.length + 1));
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(directory, destination, { recursive: true });
    const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const dependency of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies, ...metadata.peerDependencies })) {
      copyDependency(dependency, directory);
    }
  };
  const project = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  for (const name of Object.keys(project.dependencies)) copyDependency(name, source);
  expect(existsSync(join(installed, 'node_modules', '@earendil-works', 'pi-ai'))).toBe(true);
  return { root: installed, identity: reviewRuntimeVersion(installed) };
}

describe('installed Perkins runtime identity', () => {
  it.skipIf(process.platform !== 'darwin')('fails closed on a missing pinned Python helper without leaking its output', () => {
    const root = fixture('gru-darwin-identity-');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'review-dependency-identity.json'), JSON.stringify({
      schemaVersion: 1, dependencySha256: 'a'.repeat(64),
    }));
    vi.stubEnv('GRU_COMMAND_REVIEW_PYTHON', join(root, 'missing-python'));
    expect(() => reviewRuntimeVersion(root)).toThrow('requires a usable pinned Python 3 executable');
    expect(() => reviewServiceRuntimeIdentity({ runtimeIdFor: () => 'pi' }, root))
      .toThrow('requires a usable pinned Python 3 executable');
    const fake = join(root, 'bad-python');
    writeFileSync(fake, '#!/bin/sh\necho credential-looking-secret\n', { mode: 0o755 });
    vi.stubEnv('GRU_COMMAND_REVIEW_PYTHON', realpathSync(fake));
    expect(() => reviewRuntimeVersion(root)).toThrow('requires a usable pinned Python 3 executable');
    expect(() => reviewRuntimeVersion(root)).not.toThrow('credential-looking-secret');
  });
  it('fingerprints the actual npm tarball without a package-lock and fails closed on missing provenance', () => {
    const { root, identity } = packageIdentity();
    expect(identity).toMatch(/^[a-f0-9]{64}$/u);
    expect(reviewRuntimeVersion(root)).toBe(identity);
    expect(statSync(join(root, 'dist', 'review-dependency-identity.json')).mode & 0o444).toBe(0o444);
    expect(reviewServiceRuntimeIdentity({ runtimeIdFor: () => 'pi' }, root)).toEqual({ id: 'pi', version: identity });
    const codingAgentMetadata = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
    const originalMetadata = readFileSync(codingAgentMetadata, 'utf8');
    const mutatedMetadata = JSON.parse(originalMetadata) as { piConfig: { configDir: string } };
    mutatedMetadata.piConfig.configDir = '.other-pi';
    writeFileSync(codingAgentMetadata, JSON.stringify(mutatedMetadata));
    expect(reviewRuntimeVersion(root)).not.toBe(identity);
    writeFileSync(codingAgentMetadata, originalMetadata);
    const unsafeMetadata = JSON.parse(originalMetadata) as { piConfig: Record<string, string> };
    unsafeMetadata.piConfig['credential'] = 'sensitive-value';
    writeFileSync(codingAgentMetadata, JSON.stringify(unsafeMetadata));
    expect(() => reviewRuntimeVersion(root)).toThrow('unknown or unsafe installed piConfig');
    for (const piConfig of [
      { configDir: '.credentialLookingSecret' },
      { configDir: '.pi', name: 'credentialLookingSecret' },
    ]) {
      writeFileSync(codingAgentMetadata, JSON.stringify({ ...JSON.parse(originalMetadata) as object, piConfig }));
      expect(() => reviewRuntimeVersion(root)).toThrow('unknown or unsafe installed piConfig');
    }
    for (const unsafeField of [
      { version: '1.2.3-credentialLookingSecret' },
      { dependencies: { credentialLookingSecret: '1.0.0' } },
    ]) {
      writeFileSync(codingAgentMetadata, JSON.stringify({ ...JSON.parse(originalMetadata) as object, ...unsafeField }));
      expect(() => reviewRuntimeVersion(root)).toThrow(/invalid installed review dependency|unknown installed dependency name/);
    }
    writeFileSync(codingAgentMetadata, originalMetadata);
    for (const loader of [
      { main: './dist/credential-looking-token.js' },
      { exports: { './credential-looking-key': './dist/index.js' } },
      { exports: { '.': './dist/credential-looking-token.js' } },
      { imports: { '#credential-looking-key': './dist/index.js' } },
      { type: 'credential-looking-type' },
    ]) {
      writeFileSync(codingAgentMetadata, JSON.stringify({ ...JSON.parse(originalMetadata) as object, ...loader }));
      expect(() => reviewRuntimeVersion(root)).toThrow(/unsafe installed dependency loader/);
    }
    writeFileSync(codingAgentMetadata, originalMetadata);
    const catalog = join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'anthropic.json');
    writeFileSync(catalog, `${readFileSync(catalog, 'utf8')} `);
    expect(reviewRuntimeVersion(root)).not.toBe(identity);
    const dependency = join(root, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js');
    expect(existsSync(dependency)).toBe(true);
    writeFileSync(dependency, `${readFileSync(dependency, 'utf8')}\n// changed installed provider\n`);
    expect(reviewRuntimeVersion(root)).not.toBe(identity);
    const changedDependency = reviewRuntimeVersion(root);
    const binary = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules',
      '@esbuild', `${process.platform}-${process.arch}`, 'bin', 'esbuild');
    if (existsSync(binary)) {
      writeFileSync(binary, Buffer.concat([readFileSync(binary), Buffer.from('changed public platform executable')]));
      expect(reviewRuntimeVersion(root)).not.toBe(changedDependency);
    }
    const helper = join(root, 'dist', 'dispatch', 'perkins-review', 'session-output.js');
    writeFileSync(helper, `${readFileSync(helper, 'utf8')}\n// changed helper\n`);
    expect(reviewRuntimeVersion(root)).not.toBe(changedDependency);
    const secret = join(root, 'private-credential.txt');
    writeFileSync(secret, 'never hash this credential');
    rmSync(dependency);
    symlinkSync(secret, dependency);
    expect(() => reviewRuntimeVersion(root)).toThrow();
    rmSync(dependency);
    execFileSync('mkfifo', [dependency]);
    expect(() => reviewRuntimeVersion(root)).toThrow(/non-regular|bounded and regular/);
    rmSync(dependency);
    rmSync(join(root, 'dist', 'review-dependency-identity.json'));
    expect(() => reviewRuntimeVersion(root)).toThrow();
  }, 300_000);

  it('resolves a hoisted installed dependency by the Node ancestor lookup', () => {
    const { root, identity } = packageIdentity();
    const nested = join(root, 'node_modules', 'dijkstrajs');
    const hoisted = join(dirname(root), 'node_modules', 'dijkstrajs');
    mkdirSync(dirname(hoisted), { recursive: true });
    cpSync(nested, hoisted, { recursive: true });
    rmSync(nested, { recursive: true });
    expect(reviewRuntimeVersion(root)).toMatch(/^[a-f0-9]{64}$/u);
    expect(reviewRuntimeVersion(root)).not.toBe(identity);
    const code = join(hoisted, 'lib', 'index.js');
    if (existsSync(code)) {
      writeFileSync(code, `${readFileSync(code, 'utf8')}\n// hoisted behavior change\n`);
      expect(reviewRuntimeVersion(root)).not.toBe(identity);
    }
  }, 90_000);

  it('freezes an actual installed service-configured round and restores checked lenses through a fresh installed runner', async () => {
    const { root } = packageIdentity();
    const { createServiceReviewWave } = await import(pathToFileURL(join(root, 'dist', 'dispatch', 'service-review-wave.js')).href) as
      typeof import('../src/dispatch/service-review-wave.js');
    const repo = makeFixtureRepo('installed-service-freeze');
    const db = new LedgerDb(fixture('installed-service-ledger-'));
    try {
      repo.git(['checkout', '-b', 'feature/installed-service']);
      const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
      attachBareOrigin(repo);
      repo.git(['push', '-u', 'origin', 'main', 'feature/installed-service']);
      const port = new PersistedReviewPort(fixture('installed-service-port-'), 'feature/installed-service', target);
      const artifacts = fixture('installed-service-artifacts-');
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      const job = ledger.addJob({ id: 'installed-service-job', repo: 'fixture', title: 'installed service review',
        baseBranch: 'main', briefing: 'check the exact changed function' });
      ledger.setJobStatus(job.id, 'working');
      ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: { sha: target } });
      ledger.setJobPr(job.id, 'https://git.example.invalid/acme/fixture/pull/37');
      await port.createJobWorktree({ repoPath: repo.path, jobId: job.id });
      const registry = { runtimeIdFor: () => 'pi', reviewThinkingLevel: () => 'high' };
      const createWave = (spawner: ReturnType<typeof fakeWholeSpawner>['spawner']) => createServiceReviewWave({
        registry,
        options: {
          ledger, worktrees: port, spawner, reviewArtifactRoot: artifacts,
          reconcileReviewAgent: async () => true,
          reviewPreflight: async () => ({ ok: true as const, failures: [],
            reviewModel: { role: 'perkins' as const, modelRef: 'stub/stable-model', settings: {},
              authEnv: {}, routingSha256: 'stable-offline-endpoint' }, reviewThinkingLevel: 'high' }),
          prHeadProbe: async () => ({ headRefName: 'feature/installed-service', headSha: target }),
          poster: { post: async (call: { body: string; targetSha: string }) => ({
            reviewId: 'fixture-review', actor: 'fixture', event: 'COMMENTED', commitId: call.targetSha,
            headSha: call.targetSha, baseSha: repo.git(['rev-parse', 'main']),
            bodySha256: createHash('sha256').update(call.body).digest('hex'),
          }) },
        },
      });
      const original = fakeWholeSpawner(fixture('installed-service-first-sessions-'), {
        childAnswer: (prompt) => prompt.includes('tests') ? 'not valid JSON' : JSON.stringify([groundedFinding(
          prompt.includes('edge') ? 'edge' : 'blind', 'warning')]),
        specialists: ['blind', 'edge', 'tests'], neverSubmit: true,
      });
      const first = await createWave(original.spawner).runRound({ jobId: job.id });
      if ('route' in first) throw new Error('installed service took the fallback route');
      const firstManifest = JSON.parse(readFileSync(join(artifacts, first.round.id, 'manifest.json'), 'utf8')) as {
        recoveryIdentity: { runtimeVersion: string } | null;
      };
      expect(firstManifest.recoveryIdentity?.runtimeVersion).toBe(reviewRuntimeVersion(root));
      expect(ledger.listRoundSpecialistStarts(first.round.id)).toHaveLength(4);
      // A newly constructed service runner consumes the durable ledger and
      // original checkpoint files, never a prior in-memory lead result.
      const resumed = fakeWholeSpawner(fixture('installed-service-second-sessions-'), {
        childAnswer: () => '[]', specialists: ['acceptance'], verdictOverride: 'INCOMPLETE',
      });
      const second = await createWave(resumed.spawner).runRound({ jobId: job.id });
      if ('route' in second) throw new Error('installed service took the fallback route');
      expect(resumed.leadCalls[0]?.prompt).toContain('RECOVERED SPECIALIST EVIDENCE');
      expect(resumed.childCalls).toHaveLength(1);
      expect(resumed.childCalls[0]?.prompt).toContain('acceptance');
      expect(ledger.listRoundSpecialistStarts(second.round.id)).toHaveLength(5);
      expect(second.canonicalVerdict).toBe('INCOMPLETE');
    } finally {
      db.close();
      repo.cleanup();
    }
  }, 90_000);

  it('boots the installed main entrypoint and recovers checked lenses through its real service runner', async () => {
    // Linux's installed identity and both actual HTTP rounds must succeed
    // even when the macOS-only Python helper cannot possibly be executed.
    if (process.platform === 'linux') {
      vi.stubEnv('GRU_COMMAND_REVIEW_PYTHON', join(tmpdir(), 'gru-absent-python-for-linux-review'));
      expect(() => reviewPythonExecutable()).toThrow('usable pinned Python 3 executable');
    }
    const { root } = packageIdentity();
    const home = fixture('gru-installed-service-home-');
    const workspace = fixture('gru-installed-service-workspace-');
    const repo = makeFixtureRepo('installed-main-entrypoint');
    const db = new LedgerDb(home);
    const token = 'installed-test-token';
    const jobId = 'installed-main-review';
    const bin = join(home, 'bin');
    mkdirSync(bin);
    try {
      attachBareOrigin(repo);
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      ledger.addJob({ id: jobId, repo: repo.path, title: 'installed service review',
        baseBranch: 'main', briefing: 'inspect exact changed function' });
      ledger.setJobStatus(jobId, 'working');
      const manager = new WorktreeManager({ ledger, root: join(home, 'worktrees'),
        preserveRoot: join(home, 'preserves'), setupTimeoutMs: 10_000 });
      const lane = await manager.createJobWorktree({ repoPath: repo.path, jobId });
      writeFileSync(join(lane.path, 'src', 'main.ts'), 'export function answer(): number { return 43; }\n');
      execFileSync('git', ['-C', lane.path, 'add', 'src/main.ts']);
      execFileSync('git', ['-C', lane.path, '-c', 'user.name=Fixture Tests',
        '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'change answer']);
      const target = execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: target } });
      writeFileSync(join(home, 'config.toml'), [
        `workspace_root = ${JSON.stringify(workspace)}`, '[server]', 'host = "127.0.0.1"', 'port = 0',
        '[auth]', `token = ${JSON.stringify(token)}`, '[runtimes]', 'default = "pi"',
        '[models]', 'default = "stub/stable-model"', '',
      ].join('\n'));
      // Only the public code-host probe is doubled; all git worktree and
      // ledger operations remain local. No network access is possible.
      const git = join(bin, 'git');
      writeFileSync(git, `#!/bin/sh\nif [ "$1" = "-C" ] && [ "$3" = "remote" ] && [ "$4" = "get-url" ]; then echo https://github.com/acme/fixture.git; exit 0; fi\nexec /usr/bin/git "$@"\n`);
      chmodSync(git, 0o755);
      const gh = join(bin, 'gh');
      writeFileSync(gh, '#!/bin/sh\necho acme/fixture\n');
      chmodSync(gh, 0o755);
      const fake = join(home, 'fake-whole.mjs');
      writeFileSync(fake, transpileModule(readFileSync(join(defaultPackageRoot(), 'test/helpers/perkins-whole-double.ts'), 'utf8'), {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
      }).outputText);
      const preload = join(home, 'preload.mjs');
      writeFileSync(preload, `import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { RuntimeRegistry } from ${JSON.stringify(pathToFileURL(join(root, 'dist/runtime/registry.js')).href)};
import { fakeWholeSpawner, groundedFinding } from ${JSON.stringify(pathToFileURL(fake).href)};
const stage = process.env.GRU_TEST_STAGE;
if (process.platform === 'linux') {
  const probe = spawnSync('python3', ['--version'], { env: process.env, encoding: 'utf8' });
  if (probe.error?.code !== 'ENOENT') throw new Error('Linux review service PATH unexpectedly resolves python3');
  writeFileSync(join(process.env.GRU_COMMAND_HOME, 'python-free-' + stage + '.json'),
    JSON.stringify({ path: process.env.PATH, unavailable: true }));
}
const sessionRoot = join(process.env.GRU_COMMAND_HOME, 'sessions-' + stage);
mkdirSync(sessionRoot);
const fixture = fakeWholeSpawner(sessionRoot, {
  specialists: stage === 'first' ? ['blind', 'edge', 'tests'] : ['acceptance'],
  childAnswer: (prompt) => stage === 'first' && prompt.includes('tests') ? 'not valid JSON' :
    JSON.stringify([groundedFinding(prompt.includes('acceptance') ? 'acceptance' : prompt.includes('edge') ? 'edge' : 'blind', 'warning')]),
  neverSubmit: true,
});
process.on('exit', () => writeFileSync(join(process.env.GRU_COMMAND_HOME, 'calls-' + stage + '.json'),
  JSON.stringify({ leads: fixture.leadCalls.map((call) => call.prompt),
    children: fixture.childCalls.filter((call) => call.options.isolatedReview !== undefined).map((call) => call.prompt) })));
RuntimeRegistry.prototype.prepareReviewModel = async () => ({ role: 'perkins', modelRef: 'stub/stable-model',
  settings: {}, authEnv: {}, routingSha256: 'offline-public-route' });
RuntimeRegistry.prototype.spawn = (role, options) => fixture.spawner(role, options);
RuntimeRegistry.prototype.reserveReviewRound = async () => ({
  spawn: (options) => fixture.spawner('perkins', options),
  beginChildren: (max) => ({ concurrency: max, finish() {} }),
  close: async () => {}, reconcileCleanup() {}, cleanupDebt: () => [],
});
`);
      const sleep = (ms: number) => new Promise<void>((resolveDelay) => { setTimeout(resolveDelay, ms); });
      const servicePath = process.platform === 'linux' ? bin : `${bin}:/usr/bin:/bin`;
      const start = async (stage: string, pythonOverride?: string) => {
        const child = spawn(process.execPath, ['--import', preload, join(root, 'dist/main.js')], {
          env: { ...process.env, GRU_COMMAND_HOME: home, GRU_SERVICE_PORT: '0', GRU_TEST_STAGE: stage,
            GRU_COMMAND_REVIEW_PYTHON: process.platform === 'darwin'
              ? pythonOverride ?? reviewPythonExecutable() : join(home, 'missing-python'),
            PATH: servicePath }, stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        let port: number | null = null;
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const listenLine = stderr.split('\n').find((line) => line.includes('"msg":"listening"'));
          if (listenLine !== undefined) {
            port = (JSON.parse(listenLine) as { port: number }).port;
            break;
          }
          if (child.exitCode !== null) break;
          await sleep(100);
        }
        if (port === null) {
          child.kill('SIGTERM');
          throw new Error(`installed service failed to listen (${stage}): ${stderr.slice(-3500)}`);
        }
        return { child, port, stderr: () => stderr };
      };
      for (const stage of ['first', 'second']) {
        const service = await start(stage);
        try {
          if (process.platform === 'linux') {
            expect(JSON.parse(readFileSync(join(home, `python-free-${stage}.json`), 'utf8')))
              .toEqual({ path: bin, unavailable: true });
          }
          const response = await new Promise<{ status: number | undefined; body: string }>((resolveResponse, rejectResponse) => {
            const req = request(`http://127.0.0.1:${service.port}/api/dispatch/review`, {
              method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            }, (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk: string) => { body += chunk; });
              res.on('end', () => resolveResponse({ status: res.statusCode, body }));
            });
            req.on('error', rejectResponse);
            req.end(JSON.stringify({ job_id: jobId }));
          });
          const { body } = response;
          expect(response.status, body).toBe(202);
          expect(body).toContain('perkins');
          let round = ledger.listRounds(jobId).at(-1);
          for (let attempt = 0; attempt < 150 && round?.status !== 'aborted'; attempt += 1) {
            await sleep(100);
            round = ledger.listRounds(jobId).at(-1);
          }
          expect(round?.status, service.stderr().slice(-3500)).toBe('aborted');
          const manifest = JSON.parse(readFileSync(join(home, 'reviews', round!.id, 'manifest.json'), 'utf8')) as {
            recoveryIdentity: { runtimeVersion: string; modelRef: string } | null;
          };
          expect(manifest.recoveryIdentity?.runtimeVersion).toBe(reviewRuntimeVersion(root));
          expect(manifest.recoveryIdentity?.modelRef).toBe('stub/stable-model');
          expect(ledger.listRoundSpecialistStarts(round!.id)).toHaveLength(stage === 'first' ? 4 : 5);
        } finally {
          if (service.child.exitCode === null) {
            service.child.kill('SIGTERM');
            await new Promise<void>((resolveExit) => { service.child.once('exit', () => resolveExit()); });
          }
        }
      }
      const secondCalls = JSON.parse(readFileSync(join(home, 'calls-second.json'), 'utf8')) as {
        leads: string[]; children: string[];
      };
      expect(secondCalls.leads[0]).toContain('RECOVERED SPECIALIST EVIDENCE');
      expect(secondCalls.children).toHaveLength(1);
      expect(secondCalls.children[0]).toContain('acceptance');
      if (process.platform === 'darwin') {
        const missing = await start('missing', join(home, 'missing-python'));
        try {
          const response = await new Promise<{ status: number | undefined; body: string }>((resolveResponse, rejectResponse) => {
            const req = request(`http://127.0.0.1:${missing.port}/api/dispatch/review`, {
              method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            }, (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk: string) => { body += chunk; });
              res.on('end', () => resolveResponse({ status: res.statusCode, body }));
            });
            req.on('error', rejectResponse);
            req.end(JSON.stringify({ job_id: jobId }));
          });
          expect(response.status, response.body).toBe(400);
          expect(response.body).toContain('usable pinned Python 3 executable');
          const failedRound = ledger.listRounds(jobId).at(-1)!;
          expect(failedRound.status).toBe('aborted');
          expect(ledger.listRoundSpecialistStarts(failedRound.id)).toHaveLength(0);
          expect(missing.stderr()).not.toContain('credential-looking-secret');
        } finally {
          if (missing.child.exitCode === null) {
            missing.child.kill('SIGTERM');
            await new Promise<void>((resolveExit) => { missing.child.once('exit', () => resolveExit()); });
          }
        }
      }
    } finally {
      db.close();
      repo.cleanup();
    }
  }, 120_000);

  it('builds a sanitized lock closure digest without hashing or publishing credential URLs', () => {
    const root = fixture('gru-review-lock-');
    const lock = join(root, 'package-lock.json');
    const generate = () => execFileSync('node', [join(defaultPackageRoot(), 'tools', 'write-review-dependency-identity.mjs'), root]);
    const content = (version: string, secret: string) => JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { version: '1.0.0' },
        'node_modules/@earendil-works/pi-ai': { version, integrity: `sha512-${secret}`,
          resolved: `https://user:${secret}@registry.example.test/example`, authToken: secret },
        [`node_modules/${secret}`]: { version: '9.9.9' },
      },
    });
    writeFileSync(lock, content('2.0.0', 'first-sensitive-value'));
    generate();
    const artifact = join(root, 'dist', 'review-dependency-identity.json');
    const first = readFileSync(artifact, 'utf8');
    expect(first).not.toMatch(/sensitive|registry\.example|https:|authToken/u);
    writeFileSync(lock, content('2.0.0', 'other-sensitive-value'));
    generate();
    expect(readFileSync(artifact, 'utf8')).toBe(first);
    writeFileSync(lock, content('2.0.1', 'other-sensitive-value'));
    generate();
    expect(readFileSync(artifact, 'utf8')).not.toBe(first);
    writeFileSync(lock, content('2.0.0-secret-looking', 'secret'));
    expect(() => generate()).toThrow();
  });
});
