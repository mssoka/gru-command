import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseListeningPort } from '../src/wizard/main.js';
import { originIdentitySha256, preBootstrapPackageContentSha256, preBootstrapRequestPayloadSha256, PREBOOTSTRAP_PATCH_AUTHORIZATION } from '../src/worktrees/prebootstrap-patch.js';
import { attachBareOrigin, makeFixtureRepo } from './helpers/fixture-repo.js';

/**
 * Uploads-dir scaffolding (E9 / SPEC ruling 19): boot creates
 * <data_dir>/uploads/ next to logs/ and chat/ — directory creation only.
 * Spawns the BUILT dist/main.js on a fixture instance dir, confirms
 * liveness briefly, then asserts the directory and a clean shutdown.
 */

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Poll /health like every other boot test in this suite does — the
 * service-port-guard suite's waitForHealth, the wizard's own first-boot
 * smoke fetchHealth, and helpers/real-service healthOk all retry with a
 * short per-attempt cap until a bounded deadline. A SINGLE 2s shot is
 * not the liveness contract: the post-listen Gru warmup performs
 * real work on one loop, so on a busy host the first /health response
 * can land just past 2s while the service is healthy (recorded full run
 * ab2ce8e8 at 6a09349: this test aborted, the two non-fetch tests in the
 * same file passed). Every assertion below is unchanged; the per-attempt
 * cap is unchanged.
 */
async function fetchHealthAnswered(port: number): Promise<Response> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: 'Bearer uploads-test-token' },
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return res;
    } catch {
      /* not answering yet — the loop is bounded by the deadline */
    }
    if (Date.now() > deadline) {
      throw new Error(`service never answered /health on port ${port}`);
    }
    await new Promise((wake) => setTimeout(wake, 100));
  }
}

describe('uploads dir scaffolding (SPEC ruling 19)', () => {
  it('boot creates <data_dir>/uploads/ and logs an uploads_dir boot line', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-uploads-'));
    cleanupDirs.push(home);
    writeFileSync(join(home, 'config.toml'), '[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "uploads-test-token"\n', 'utf-8');

    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'main.js')], {
      env: { ...process.env, GRU_COMMAND_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    try {
      const deadline = Date.now() + 20_000;
      let port: number | null = null;
      while (port === null) {
        port = parseListeningPort(stderr);
        if (port !== null) break;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`service exited early — stderr:\n${stderr.slice(-1_000)}`);
        }
        if (Date.now() > deadline) throw new Error(`service never listened — stderr:\n${stderr.slice(-1_000)}`);
        await new Promise((wake) => setTimeout(wake, 150));
      }

      // Liveness briefly (the boot completed far enough to serve /health)
      // and the structured uploads_dir boot line is on the log stream.
      const res = await fetchHealthAnswered(port);
      expect(res.ok).toBe(true);
      // The FULL smoke oracle, not just res.ok (Perkins r1 W8): the
      // default suite boots the real service, so it asserts the same
      // three liveness signals + fingerprint the wizard's smoke does.
      const health = (await res.json()) as {
        identity?: { install_id?: unknown };
        liveness?: {
          signals?: {
            health_reachable?: { value?: unknown };
            agent_session?: { state?: unknown };
            session_growth?: { value?: unknown };
          };
        };
      };
      expect(health.liveness?.signals?.health_reachable?.value).toBe(true);
      expect(typeof health.liveness?.signals?.agent_session?.state).toBe('string');
      expect(health.liveness?.signals?.session_growth?.value).toBeDefined();
      expect(typeof health.identity?.install_id).toBe('string');
      expect(stderr).toContain('"msg":"uploads_dir"');
      expect(stderr).toContain(join(home, 'uploads'));

      // The scaffolding itself: directory creation only, instance state
      // under the data dir (ruling 7) — owner-only like every instance dir
      // (Perkins r2 note: was 0755).
      expect(existsSync(join(home, 'uploads'))).toBe(true);
      expect(existsSync(join(home, 'logs'))).toBe(true);
      expect((statSync(join(home, 'uploads')).mode & 0o777) & 0o077).toBe(0); // no group/world bits

      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
        child.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30_000);

  it('uploads-path obstruction fails boot LOUD and named (exit 1, no raw stack) — Perkins r1 W14', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-uploads-block-'));
    cleanupDirs.push(home);
    writeFileSync(join(home, 'config.toml'), '[server]\nhost = "127.0.0.1"\nport = 0\n', 'utf-8');
    // A FILE named uploads blocks the directory scaffolding.
    writeFileSync(join(home, 'uploads'), 'not a directory', 'utf-8');

    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'main.js')], {
      env: { ...process.env, GRU_COMMAND_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on('exit', (code) => resolveExit(code));
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('uploads dir creation failed');
    expect(stderr).toContain(join(home, 'uploads'));
  }, 30_000);

  it('W-D (E9 r3 carry): a PRE-EXISTING 0755 uploads dir is hardened to 0700 at boot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-uploads-harden-'));
    cleanupDirs.push(home);
    writeFileSync(join(home, 'config.toml'), '[server]\nhost = "127.0.0.1"\nport = 0\n', 'utf-8');
    // The incident shape: an older instance (or a stray mkdir) left the
    // uploads dir group/world traversable — creation-only 0700 never
    // touched it. THIS boot must harden it (fail-loud on chmod failure).
    const loose = join(home, 'uploads');
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    expect(statSync(loose).mode & 0o777).toBe(0o755);

    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'main.js')], {
      env: { ...process.env, GRU_COMMAND_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    try {
      const deadline = Date.now() + 20_000;
      let port: number | null = null;
      while (port === null) {
        port = parseListeningPort(stderr);
        if (port !== null) break;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`service exited early — stderr:\n${stderr.slice(-1_000)}`);
        }
        if (Date.now() > deadline) throw new Error(`service never listened — stderr:\n${stderr.slice(-1_000)}`);
        await new Promise((wake) => setTimeout(wake, 150));
      }
      // Hardened in place: exactly 0700, and the boot log names it.
      expect(statSync(loose).mode & 0o777).toBe(0o700);
      expect(stderr).toContain('uploads_dir hardened');
      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.on('exit', (code) => resolveExit(code));
        child.kill('SIGTERM');
      });
      expect(exitCode).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30_000);
});

/** Boot the built service on `home` and wait for its listening port. */
async function listeningService(home: string): Promise<{ readonly child: ChildProcess; readonly port: number; readonly stderr: () => string }> {
  const child = spawn(process.execPath, [join(repoRoot, 'dist', 'main.js')], {
    env: { ...process.env, GRU_COMMAND_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const port = parseListeningPort(stderr);
    if (port !== null) return { child, port, stderr: () => stderr };
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`service exited early — stderr:\n${stderr.slice(-1_000)}`);
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`service never listened — stderr:\n${stderr.slice(-1_000)}`);
    }
    await new Promise((wake) => setTimeout(wake, 150));
  }
}

async function stopService(child: ChildProcess): Promise<number | null> {
  return new Promise<number | null>((resolveExit) => {
    child.on('exit', (code) => resolveExit(code));
    child.kill('SIGTERM');
  });
}

const PATCH_TOKEN = 'prebootstrap-root-token';
const PATCH_CONFIG = `[server]\nhost = "127.0.0.1"\nport = 0\n[auth]\ntoken = "${PATCH_TOKEN}"\n[worktrees]\nmin_free_disk_gb = 0\n`;

describe('private prebootstrap package root (boot)', () => {
  it('boot creates an owner-only package root that both dispatch and the worktree manager read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-patch-root-'));
    cleanupDirs.push(home);
    writeFileSync(join(home, 'config.toml'), PATCH_CONFIG, 'utf-8');
    const repo = makeFixtureRepo('fixture-boot-prebootstrap');
    const before = 'fixture-dep==1.0.0\n';
    const after = 'fixture-dep==2.0.0\n';
    repo.commitFile('requirements.txt', before);
    repo.commitFile('.gru-command/worktree.toml', '[[setup]]\ncommand = "node -e \\"process.exit(7)\\""\n');
    const origin = attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'main']);
    const service = await listeningService(home);
    try {
      const root = join(home, 'prebootstrap-patches');
      expect(lstatSync(root).isDirectory()).toBe(true);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(service.stderr()).toContain('"msg":"prebootstrap_patch_root"');
      const post = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${String(service.port)}/api/dispatch`, {
        method: 'POST', headers: { authorization: `Bearer ${PATCH_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const briefing = `Repair the pinned dependency.\n${PREBOOTSTRAP_PATCH_AUTHORIZATION}\n`;
      const request = { repo_path: repo.path, title: 'Boot dependency repair', briefing };

      // The service reads the root: a missing package is named, not "not wired".
      const missing = await post({ ...request, job_id: 'boot-missing-package', prebootstrap_patch: { package_file: 'missing.json', package_sha256: 'a'.repeat(64) } });
      expect(missing.status).toBe(422);
      expect(await missing.json()).toMatchObject({ code: 'package_unavailable', detail: expect.stringContaining('missing.json is unavailable') });

      // The manager reads it too: the patch is applied and the unchanged setup runs (and fails here, before any worker).
      const jobId = 'boot-patched';
      const packageFile = `${jobId}.json`;
      const head = repo.head();
      const pkg = {
        version: 1,
        repository: { path: realpathSync(repo.path), origin_sha256: originIdentitySha256(origin) },
        base: { commit: head, tree: repo.git(['rev-parse', `${head}^{tree}`]) },
        authority: { contract_sha256: createHash('sha256').update(briefing).digest('hex'), work_revision: 0, authority_epoch: 0,
          request_sha256: preBootstrapRequestPayloadSha256({ jobId, repoPath: repo.path, title: request.title, displayName: null, deliverable: 'pr',
            briefing, completionHandoff: null, packageFile }) },
        allowlist: ['requirements.txt'],
        files: [{ path: 'requirements.txt', before_sha256: createHash('sha256').update(before).digest('hex'),
          after_sha256: preBootstrapPackageContentSha256(after), content: after }],
      };
      const bytes = Buffer.from(JSON.stringify(pkg), 'utf8');
      writeFileSync(join(root, packageFile), bytes, { mode: 0o600 });
      const patched = await post({ ...request, job_id: jobId,
        prebootstrap_patch: { package_file: packageFile, package_sha256: createHash('sha256').update(bytes).digest('hex') } });
      expect(patched.status).toBe(409);
      const readback = await fetch(`http://127.0.0.1:${String(service.port)}/api/dispatch/jobs/${jobId}/prebootstrap-patch`,
        { headers: { authorization: `Bearer ${PATCH_TOKEN}` } });
      expect(await readback.json()).toMatchObject({ state: 'setup_failed', worker_admission: 'unproven',
        patch: { changed_paths: ['requirements.txt'] }, setup: { stage: 'setup', error_class: 'WorktreeSetupError' } });
      expect(await stopService(service.child)).toBe(0);
    } finally {
      if (service.child.exitCode === null) service.child.kill('SIGKILL');
      repo.cleanup();
    }
  }, 60_000);

  it('boot refuses a symlinked package root, loud and named', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-patch-root-link-'));
    cleanupDirs.push(home);
    writeFileSync(join(home, 'config.toml'), PATCH_CONFIG, 'utf-8');
    mkdirSync(join(home, 'elsewhere'), { mode: 0o700 });
    symlinkSync(join(home, 'elsewhere'), join(home, 'prebootstrap-patches'));
    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'main.js')], {
      env: { ...process.env, GRU_COMMAND_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on('exit', (code) => resolveExit(code));
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('private prebootstrap package directory creation failed');
    expect(stderr).toContain('not a symlink');
  }, 30_000);

  it('boot hardens a pre-existing 0755 package root to 0700', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-patch-root-harden-'));
    cleanupDirs.push(home);
    writeFileSync(join(home, 'config.toml'), PATCH_CONFIG, 'utf-8');
    const loose = join(home, 'prebootstrap-patches');
    mkdirSync(loose, { mode: 0o755 });
    chmodSync(loose, 0o755);
    expect(statSync(loose).mode & 0o777).toBe(0o755);
    const service = await listeningService(home);
    try {
      expect(statSync(loose).mode & 0o777).toBe(0o700);
      expect(await stopService(service.child)).toBe(0);
    } finally {
      if (service.child.exitCode === null) service.child.kill('SIGKILL');
    }
  }, 30_000);
});
