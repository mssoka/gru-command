import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Install rehearsal (E9 acceptance): the always-on hygiene gate (zero
 * personal paths / project names outside the allowlisted install URL)
 * plus the env-gated FULL rehearsal — pristine fixture home, fresh
 * file:// clone of THIS repo, non-interactive install, and direct
 * /health smoke assertions. The gated half mirrors
 * scripts/rehearsal.sh; both require a committed tree (a clone sees
 * HEAD, not the working directory) and network for `npm install`.
 */

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe('hygiene grep (always-on)', () => {
  it('scripts/hygiene-grep.sh exists and the tree is clean', () => {
    const script = join(repoRoot, 'scripts', 'hygiene-grep.sh');
    expect(existsSync(script)).toBe(true);
    expect(existsSync(join(repoRoot, 'scripts', 'rehearsal.sh'))).toBe(true);
    const stdout = execFileSync('bash', [script], { encoding: 'utf-8' });
    expect(stdout).toContain('clean');
  });

  it('the gate has teeth: a planted personal path fails it', () => {
    // Untracked-but-not-ignored files ARE scanned (that is how the gate
    // works in a dirty worktree) — plant one, expect failure, remove it.
    // (The planted path is assembled at runtime so this file itself
    // stays hygiene-clean.)
    const plant = join(repoRoot, 'hygiene-probe.tmp');
    const personalPath = ['/Use', 'rs/', 'mos', 'es'].join('');
    writeFileSync(plant, `see ${personalPath}/somewhere/personal\n`, 'utf-8');
    try {
      let status = 0;
      try {
        execFileSync('bash', [join(repoRoot, 'scripts', 'hygiene-grep.sh')], {
          encoding: 'utf-8',
          stdio: 'pipe',
        });
      } catch (error) {
        status = (error as { status?: number }).status ?? 1;
      }
      expect(status).toBe(1);
    } finally {
      rmSync(plant, { force: true });
    }
  });
});

describe.skipIf(process.env['GRU_COMMAND_REHEARSAL'] !== '1')(
  'full install rehearsal (GRU_COMMAND_REHEARSAL=1)',
  () => {
    it(
      'pristine home + fresh clone → non-interactive install → /health smoke',
      async () => {
        const stage = mkdtempSync(join(tmpdir(), 'gru-command-rehearsal-'));
        cleanupDirs.push(stage);
        const home = join(stage, 'home');
        const workspace = join(stage, 'workspace');
        const target = join(home, 'gru-command');
        const instance = join(home, '.gru-command');
        mkdirSync(home, { recursive: true });
        mkdirSync(workspace, { recursive: true });
        for (const repo of ['repo-alpha', 'repo-beta']) {
          mkdirSync(join(workspace, repo), { recursive: true });
          execFileSync('git', ['-C', join(workspace, repo), 'init', '-q']);
          writeFileSync(join(workspace, repo, 'README'), 'fixture\n', 'utf-8');
          execFileSync('git', ['-C', join(workspace, repo), 'add', 'README']);
          execFileSync('git', [
            '-C', join(workspace, repo),
            '-c', 'user.email=rehearsal@example.invalid', '-c', 'user.name=rehearsal',
            'commit', '-qm', 'fixture',
          ]);
        }

        // Non-interactive install against the fresh clone path.
        const answers = JSON.stringify({
          workspace_root: workspace,
          repos: ['repo-alpha', 'repo-beta'],
          port: 0,
          token: 'rehearsal-pairing-token',
          register_service: false,
        });
        const stdout = execFileSync(
          'bash',
          [join(repoRoot, 'install.sh'), '--answers', answers],
          {
            encoding: 'utf-8',
            timeout: 600_000,
            env: {
              ...process.env,
              HOME: home,
              GRU_COMMAND_HOME: instance,
              GRU_COMMAND_ORIGIN: `file://${repoRoot}`,
              GRU_COMMAND_TARGET: target,
            },
          },
        );
        // The wizard's own first-boot smoke gated the exit code; assert
        // its report + the artifacts.
        expect(stdout).toContain('Smoke green');
        expect(existsSync(join(target, 'dist', 'main.js'))).toBe(true);
        expect(existsSync(join(instance, 'config.toml'))).toBe(true);

        // Direct health assertions: boot the installed clone's service
        // (ephemeral port), poll /health for the 3 liveness signals +
        // the identity fingerprint + the 1.0.0 version, clean shutdown.
        const child = spawn(process.execPath, [join(target, 'dist', 'main.js')], {
          env: { ...process.env, GRU_COMMAND_HOME: instance },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf-8');
        });
        try {
          let port: number | null = null;
          const deadline = Date.now() + 30_000;
          while (port === null) {
            for (const line of stderr.split('\n')) {
              try {
                const record = JSON.parse(line) as { msg?: string; port?: unknown };
                if (record.msg === 'listening' && typeof record.port === 'number') {
                  port = record.port;
                }
              } catch {
                /* skip non-JSON lines */
              }
            }
            if (port !== null) break;
            if (Date.now() > deadline) throw new Error('service never listened');
            await new Promise((wake) => setTimeout(wake, 200));
          }
          type HealthShape = {
            version?: string;
            identity?: { install_id?: unknown };
            liveness?: {
              signals?: {
                health_reachable?: { value?: unknown };
                agent_session?: { state?: unknown };
                session_growth?: { value?: unknown };
              };
            };
          };
          let health: HealthShape | null = null;
          const healthDeadline = Date.now() + 15_000;
          while (health === null) {
            try {
              const res = await fetch(`http://127.0.0.1:${port}/health`, {
                signal: AbortSignal.timeout(2_000),
              });
              if (res.ok) health = (await res.json()) as HealthShape;
            } catch {
              /* not up yet */
            }
            if (health === null && Date.now() > healthDeadline) {
              throw new Error('/health never answered');
            }
            if (health === null) await new Promise((wake) => setTimeout(wake, 250));
          }
          expect(health.liveness?.signals?.health_reachable?.value).toBe(true);
          expect(typeof health.liveness?.signals?.agent_session?.state).toBe('string');
          expect(health.liveness?.signals?.session_growth?.value).toBeDefined();
          expect(typeof health.identity?.install_id).toBe('string');
          expect(health.version).toBe('1.0.0');
          // Uploads scaffolding landed with this epic (SPEC ruling 19).
          expect(existsSync(join(instance, 'uploads'))).toBe(true);

          const exitCode = await new Promise<number | null>((resolveExit) => {
            child.on('exit', (code) => resolveExit(code));
            child.kill('SIGTERM');
          });
          expect(exitCode).toBe(0);
        } finally {
          if (child.exitCode === null) child.kill('SIGKILL');
        }
      },
      600_000,
    );
  },
);
