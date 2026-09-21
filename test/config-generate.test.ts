import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { loadConfig, ROLES, RUNTIME_IDS } from '../src/config.js';
import {
  CONFIG_ACTIVE_TABLES,
  CONFIG_SECTION_HEADERS,
  renderConfigDocBlock,
  RUNTIME_THINKING_LEVELS,
} from '../src/config-reference.js';

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function run(instance: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    process.execPath,
    [join(repoRoot, 'dist', 'cli', 'config-generate.js'), ...args],
    {
      env: {
        ...process.env,
        ...env,
        GRU_COMMAND_HOME: instance,
      },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );
}

describe('config-generate CLI', () => {
  it('writes the complete teaching config to the actual application read path', () => {
    const root = tempDir('gru-command-config-generate-');
    const instance = join(root, 'instance');
    const result = run(instance);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const file = join(instance, 'config.toml');
    const text = readFileSync(file, 'utf-8');
    const raw = parse(text) as Record<string, unknown>;

    expect(Object.keys(raw)).toEqual([
      'workspace_root',
      'data_dir',
      'server',
      'auth',
      'runtimes',
      'models',
      'thinking',
      'supervision',
      'logging',
      'chat',
      'worktrees',
      'dispatch',
      'review',
    ]);
    for (const section of [
      '[server]',
      '[auth]',
      '[runtimes]',
      '[models]',
      '[thinking]',
      '[supervision]',
      '[logging]',
      '[chat]',
      '[worktrees]',
      '[dispatch]',
    ]) {
      expect(text).toContain(section);
    }
    for (const role of ROLES) {
      expect(text).toContain(`# ${role} =`);
    }
    for (const runtime of RUNTIME_IDS) {
      expect(text).toContain(`[runtimes.${runtime}]`);
      expect(text).toContain(`[runtimes.${runtime}.roles]`);
    }
    expect(text).toContain('# This is the live file read from <instance>/config.toml');
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const loaded = loadConfig({ GRU_COMMAND_HOME: instance }, root);
    expect(loaded.sourceFile).toBe(file);
    expect(loaded.dataDir).toBe(instance);
    expect(loaded.models.default).toBe('default');
    expect(loaded.thinking.default).toBe('default');
    expect(loaded.supervision).toMatchObject({
      enabled: true,
      turnSilenceMs: 900_000,
      restartWindowMs: 600_000,
      maxRestarts: 3,
      restartBackoffMs: 2_000,
    });
  });

  it('emitted reference carries EVERY documented section plus the per-runtime semantics inline', () => {
    const root = tempDir('gru-command-config-docs-');
    const instance = join(root, 'instance');
    const result = run(instance);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const text = readFileSync(join(instance, 'config.toml'), 'utf-8');

    // CONFIG-AS-DOCS: the generated file IS the reference — every section
    // the source of truth documents must appear, IN THE PINNED ORDER
    // (commented example blocks count; a list/emission drift fails here).
    // Matching is line-anchored (root `key =` lines and exact `[table]`
    // lines) so in-text mentions like "[models]/[thinking]" inside
    // comments cannot masquerade as the section header.
    const lines = text.split('\n');
    let cursor = -1;
    const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const header of CONFIG_SECTION_HEADERS) {
      expect(text, header).toContain(header);
      const pattern = header.startsWith('[')
        ? new RegExp(`^#?\\s*${escapeRe(header)}$`)
        : new RegExp(`^#?\\s*${escapeRe(header)}\\s*=`);
      const at = lines.findIndex((line) => pattern.test(line.trim()));
      expect(at, `${header} present as a section line`).toBeGreaterThanOrEqual(0);
      expect(at, `${header} emission order`).toBeGreaterThan(cursor);
      cursor = at;
    }
    const raw = parse(text) as Record<string, unknown>;
    const walk = (path: string): unknown =>
      path.split('.').reduce<unknown>((acc, key) => {
        if (acc === null || typeof acc !== 'object') return undefined;
        return (acc as Record<string, unknown>)[key];
      }, raw);
    for (const table of CONFIG_ACTIVE_TABLES) {
      expect(walk(table), `active table [${table}]`).toBeDefined();
    }

    // Per-runtime thinking-level sets are stated IN the file (pi has
    // minimal; claude-code has ultracode + the effort mapping)...
    expect(text).toContain(`minimal | low | medium | high | xhigh | max`);
    expect(text).toContain(
      'low | medium | high | xhigh | max | ultracode (mapped to the CLI --effort; anything else fails loud at spawn naming the valid set)',
    );
    for (const runtime of RUNTIME_IDS) {
      expect(text).toContain(RUNTIME_THINKING_LEVELS[runtime].join(' | '));
    }
    // ...the provider-stripping model-reference rule...
    expect(text).toContain('strips the provider segment for its CLI --model flag');
    // ...the valid role list...
    expect(text).toContain('valid roles: gru, silas, minion, perkins, bob');
    // ...the RUNTIMES.md pointer...
    expect(text).toContain('docs/RUNTIMES.md');
    // ...and the inline-table role example, with BOTH per-runtime blocks
    // shipped as commented examples (never enabled config).
    expect(text).toContain('Example: minion = { model = "default", thinking_level = "low" }');
    expect(text).toContain('# [runtimes.pi]');
    expect(text).toContain('# [runtimes.claude-code]');
  });

  it('round trip: a --force re-run preserves user-set values and hand-tuned sections, with backup', () => {
    const root = tempDir('gru-command-config-roundtrip-');
    const instance = join(root, 'instance');
    const managed = join(root, 'managed');
    const state = join(root, 'custom-state');
    mkdirSync(instance, { recursive: true });
    const prior = [
      `workspace_root = ${JSON.stringify(managed)}`,
      `data_dir = ${JSON.stringify(state)}`,
      '[server]',
      'host = "192.168.1.23"',
      'port = 7700',
      '[auth]',
      'token = "prior-secret-token"',
      '[runtimes]',
      'default = "claude-code"',
      '[runtimes.roles]',
      'minion = "pi"',
      '[models.roles]',
      'gru = "provider/model-b"',
      '[thinking.roles]',
      'perkins = "max"',
      '[runtimes.claude-code]',
      'model = "anthropic/claude-x"',
      'thinking_level = "high"',
      '[runtimes.claude-code.roles]',
      'minion = { thinking_level = "low" }',
      '[supervision]',
      'turn_silence_ms = 600000',
      '[dispatch]',
      'bob_interval_ms = 120000',
      '[worktrees]',
      `root = ${JSON.stringify(join(root, 'lanes'))}`,
    ].join('\n');
    writeFileSync(join(instance, 'config.toml'), `${prior}\n`);

    const forced = run(instance, ['--force']);
    expect(forced.status, `${forced.stdout}\n${forced.stderr}`).toBe(0);
    const backup = forced.stdout.match(/Previous configuration backed up: (.+)/)?.[1]?.trim();
    expect(backup).toMatch(/config\.toml\.backup-\d{8}T\d{6}\d{3}Z$/);
    expect(readFileSync(backup!, 'utf-8')).toBe(`${prior}\n`); // old values never lost

    const text = readFileSync(join(instance, 'config.toml'), 'utf-8');
    const raw = parse(text) as Record<string, unknown>;
    // Prompted fields: existing values win over '{}' defaults (seeding).
    expect(raw.server).toMatchObject({ host: '192.168.1.23', port: 7700 });
    expect((raw.auth as { token: string }).token).toBe('prior-secret-token');
    expect((raw.runtimes as { default: string }).default).toBe('claude-code');
    // Unprompted sections/keys: preserved ACTIVE, never silently dropped.
    expect(raw.data_dir).toBe(state);
    expect((raw.runtimes as { roles: Record<string, string> }).roles.minion).toBe('pi');
    expect((raw.models as { roles: Record<string, string> }).roles.gru).toBe('provider/model-b');
    expect((raw.thinking as { roles: Record<string, string> }).roles.perkins).toBe('max');
    const claudePolicy = (raw.runtimes as { 'claude-code': Record<string, unknown> })['claude-code'];
    expect(claudePolicy).toMatchObject({ model: 'anthropic/claude-x', thinking_level: 'high' });
    expect(claudePolicy.roles).toMatchObject({ minion: { thinking_level: 'low' } });
    expect((raw.supervision as Record<string, number>).turn_silence_ms).toBe(600000);
    expect((raw.dispatch as Record<string, number>).bob_interval_ms).toBe(120000);
    expect((raw.worktrees as Record<string, string>).root).toBe(join(root, 'lanes'));

    // Fail-loud-clean: the round-tripped file boots through the REAL loader.
    const loaded = loadConfig({ GRU_COMMAND_HOME: instance }, root);
    expect(loaded.workspaceRoot).toBe(managed); // seeded + preserved
    expect(loaded.server.host).toBe('192.168.1.23');
    expect(loaded.auth.token).toBe('prior-secret-token');
    expect(loaded.dispatch.bobIntervalMs).toBe(120000);
    expect(loaded.worktrees.root).toBe(join(root, 'lanes'));
  });

  it('data_dir is emitted ~-anchored for home-under instances (restore-on-new-machine portability)', () => {
    // Regression guard (Perkins R1 blocker 1): a machine-specific absolute
    // data_dir redirects all state to the OLD machine when the config is
    // restored elsewhere. The default home-under instance must emit the
    // portable ~-anchored form; only explicit outside-home
    // GRU_COMMAND_HOME setups may emit absolute paths.
    const fakeHome = tempDir('gru-command-fake-home-');
    const instance = join(fakeHome, '.gru-command');
    const out = run(instance, [], { HOME: fakeHome });
    expect(out.status, `${out.stdout}\n${out.stderr}`).toBe(0);
    expect(out.stdout).toContain('Wrote complete configuration');
    const text = readFileSync(join(instance, 'config.toml'), 'utf-8');
    expect(text).toContain('data_dir = "~/.gru-command"');
    expect(text).not.toContain(`data_dir = "${fakeHome}`);
    expect(text).toContain('re-anchors to'); // portability rationale inline
    // The portable form boots through the REAL loader against the fake home.
    const loaded = loadConfig({ GRU_COMMAND_HOME: instance, HOME: fakeHome }, fakeHome);
    expect(loaded.dataDir).toBe(instance);
    // Round-trip: a preserved home-under data_dir stays ~-anchored too.
    const forced = run(instance, ['--force'], { HOME: fakeHome });
    expect(forced.status, `${forced.stdout}\n${forced.stderr}`).toBe(0);
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toContain(
      'data_dir = "~/.gru-command"',
    );
  });

  it('--force on a FRESH instance dir writes the config instead of throwing (Perkins R1 blocker 3)', () => {
    const root = tempDir('gru-command-config-force-fresh-');
    const instance = join(root, 'instance'); // no config.toml exists
    const forced = run(instance, ['--force']);
    expect(forced.status, `${forced.stdout}\n${forced.stderr}`).toBe(0);
    expect(forced.stdout).not.toContain('config changed after backup');
    expect(existsSync(join(instance, 'config.toml'))).toBe(true);
    expect(loadConfig({ GRU_COMMAND_HOME: instance }, root).sourceFile).toBe(
      join(instance, 'config.toml'),
    );
  });

  it('docs/CONFIG.md reference block is generated from the same source of truth (drift guard)', () => {
    const doc = readFileSync(join(repoRoot, 'docs', 'CONFIG.md'), 'utf-8');
    expect(doc).toContain('<!-- BEGIN GENERATED CONFIG REFERENCE');
    expect(doc).toContain('<!-- END GENERATED CONFIG REFERENCE -->');
    expect(doc).toContain(renderConfigDocBlock());
  });

  it('refuses overwrite without --force and creates a timestamped 0600 backup with force', () => {
    const root = tempDir('gru-command-config-force-');
    const instance = join(root, 'instance');
    expect(run(instance).status).toBe(0);
    const before = readFileSync(join(instance, 'config.toml'), 'utf-8');

    const refused = run(instance);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('without --force');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toBe(before);

    const forced = run(instance, ['--force']);
    expect(forced.status, `${forced.stdout}\n${forced.stderr}`).toBe(0);
    const backup = forced.stdout.match(/Previous configuration backed up: (.+)/)?.[1]?.trim();
    expect(backup).toMatch(/config\.toml\.backup-\d{8}T\d{6}\d{3}Z$/);
    expect(statSync(backup!).mode & 0o777).toBe(0o600);
    expect(readFileSync(backup!, 'utf-8')).toBe(before);
  });
});
