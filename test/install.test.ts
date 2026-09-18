import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * install.sh (E7 story 3): rendering correctness on THIS platform —
 * placeholder substitution, absolute-path resolution through version
 * manager symlinks, path-with-space survival, and flag handling. The
 * script is executed for real with --print (it changes nothing).
 */

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function print(env: NodeJS.ProcessEnv = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('bash', [join(repoRoot, 'install.sh'), '--print'], {
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', status: err.status ?? 1 };
  }
}

describe('install.sh --print rendering', () => {
  it('renders the platform unit with every placeholder substituted absolutely', () => {
    const { stdout, status } = print();
    expect(status).toBe(0);
    expect(stdout).not.toContain('{{NODE}}');
    expect(stdout).not.toContain('{{REPO_ROOT}}');
    expect(stdout).not.toContain('{{GRU_COMMAND_HOME}}');
    expect(stdout).not.toContain('{{PATH}}');
    // The node path is absolute and stable (resolved through any
    // version-manager symlink — no ephemeral multishell path).
    expect(stdout).toMatch(/\/(dist\/main\.js|node)/);
    if (process.platform === 'darwin') {
      expect(stdout).toContain('<key>Label</key>');
      expect(stdout).toContain('<string>com.gru-command.service</string>');
      expect(stdout).toContain('<key>KeepAlive</key>');
      expect(stdout).toContain('<key>SuccessfulExit</key>');
    } else {
      expect(stdout).toContain('[Unit]');
      expect(stdout).toContain('Restart=on-failure');
      expect(stdout).toContain('WantedBy=default.target');
    }
  });

  it('honors GRU_COMMAND_HOME for the instance dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-install-'));
    cleanupDirs.push(home);
    const { stdout } = print({ GRU_COMMAND_HOME: home });
    expect(stdout).toContain(home);
  });

  it('unknown flags exit non-zero with usage', () => {
    let status = 0;
    try {
      execFileSync('bash', [join(repoRoot, 'install.sh'), '--bogus'], { encoding: 'utf-8', stdio: 'pipe' });
    } catch (error) {
      status = (error as { status?: number }).status ?? 1;
    }
    expect(status).not.toBe(0);
  });

  it('a repo path containing spaces survives rendering (macOS plists; systemd quotes)', () => {
    // Simulate: run from a copy whose path has a space (the script derives
    // REPO_ROOT from its own location).
    const spaced = mkdtempSync(join(tmpdir(), 'gru command install-'));
    cleanupDirs.push(spaced);
mkdirSync(join(spaced, 'install'), { recursive: true });
    copyFileSync(join(repoRoot, 'install.sh'), join(spaced, 'install.sh'));
    for (const unit of ['launchd/com.gru-command.service.plist.template', 'systemd/gru-command.service.template']) {
      mkdirSync(join(spaced, 'install', ...unit.split('/').slice(0, -1)), { recursive: true });
      copyFileSync(join(repoRoot, 'install', unit), join(spaced, 'install', unit));
    }
    const stdout = execFileSync('bash', [join(spaced, 'install.sh'), '--print'], {
      encoding: 'utf-8',
      env: process.env,
    });
    expect(stdout).toContain(spaced);
    if (process.platform !== 'darwin') {
      // systemd ExecStart quotes arguments containing spaces.
      expect(stdout).toMatch(/ExecStart=.*".*gru command install-.*"/);
    }
  });
});
