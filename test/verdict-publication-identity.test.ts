import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { ownerAttentionFor, resolveNotificationRouting } from '../src/notifications/attention.js';
import {
  PERKINS_APP_BUNDLE_MISSING_KIND,
  VERDICT_PUBLICATION_GAP,
  assessVerdictPublicationIdentity,
  renderPerkinsAppPrerequisiteNote,
  renderPerkinsAppSetupGuide,
  reportVerdictPublicationIdentity,
  verdictPublicationIdentityWarning,
} from '../src/dispatch/verdict-publication-identity.js';
import { preflightAdvisoryFields, type RepoRemote } from '../src/dispatch/review-path.js';

/**
 * Issue #444 — the Perkins App bundle is an install prerequisite, and its
 * absence is named instead of discovered after a full review round dies on
 * `422 APPROVE, self-author`. These tests pin the boot incident, the
 * named pre-flight advisory leg, the installer note, and the docs/guide
 * drift that make the prerequisite visible before a round is wasted.
 */

const cleanupDirs: string[] = [];
const openDbs: LedgerDb[] = [];
afterAll(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/** A realistic resolved bundle shape: what presence-based selection sees. */
function writeAppBundle(root: string, appId = '4366368'): void {
  const bundle = join(root, 'perkins');
  mkdirSync(bundle, { recursive: true, mode: 0o700 });
  chmodSync(bundle, 0o700);
  writeFileSync(join(bundle, 'app-key.pem'), '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n', { mode: 0o600 });
  writeFileSync(
    join(bundle, 'config'),
    `app_id=${appId}\nkey_path="${join(bundle, 'app-key.pem')}"\ninstallation_id_solarity-services=999888777\n`,
    { mode: 0o600 },
  );
}

const GITHUB_REMOTE: RepoRemote = { host: 'github.com', owner: 'solarity-services', repo: 'RightTenantry' };
const GITLAB_REMOTE: RepoRemote = { host: 'gitlab.com', owner: 'group/project', repo: 'widget-shop' };

describe('verdict publication identity assessment (#444)', () => {
  it('names the gap when [review] is enabled and no Perkins App bundle resolves', () => {
    const instanceDir = tempDir('gru-444-missing-');
    const identity = assessVerdictPublicationIdentity({ instanceDir, reviewEnabled: true });
    expect(identity).toMatchObject({ mode: 'personal-gh', reviewEnabled: true, bundlePresent: false });
    expect(identity.bundleRoot).toBe(instanceDir);
    expect(identity.bundleConfigPath).toBe(join(instanceDir, 'perkins', 'config'));
    expect(identity.gap).not.toBeNull();
    expect(identity.gap!.leg).toBe('verdict-publication-identity');
    // The named line from the incident, verbatim, plus the path that is missing.
    expect(identity.gap!.detail).toContain(VERDICT_PUBLICATION_GAP);
    expect(VERDICT_PUBLICATION_GAP).toBe(
      'verdict publication identity: MISSING — reviews will run but verdicts cannot post (self-author 422)',
    );
    expect(identity.gap!.detail).toContain(join(instanceDir, 'perkins', 'config'));
    expect(identity.gap!.remediation).toMatch(/restart the service/u);
    expect(identity.gap!.remediation).toContain('PERKINS-APP-PUBLICATION.md');
  });

  it('is quiet when the gate is disabled or the bundle resolves', () => {
    const instanceDir = tempDir('gru-444-quiet-');
    const disabled = assessVerdictPublicationIdentity({ instanceDir, reviewEnabled: false });
    expect(disabled.gap).toBeNull();
    expect(disabled.mode).toBe('personal-gh');

    writeAppBundle(instanceDir);
    const app = assessVerdictPublicationIdentity({ instanceDir, reviewEnabled: true });
    expect(app).toMatchObject({ mode: 'perkins-app', bundlePresent: true, gap: null });
  });

  it('honors the data_dir fallback only while the instance dir holds no bundle', () => {
    const instanceDir = tempDir('gru-444-instance-');
    const dataDir = tempDir('gru-444-data-');
    writeAppBundle(dataDir);
    const relocated = assessVerdictPublicationIdentity({ instanceDir, dataDir, reviewEnabled: true });
    expect(relocated).toMatchObject({ mode: 'perkins-app', bundleRoot: dataDir, gap: null });

    writeAppBundle(instanceDir, '7777777');
    const instanceWins = assessVerdictPublicationIdentity({ instanceDir, dataDir, reviewEnabled: true });
    expect(instanceWins.bundleRoot).toBe(instanceDir);
    expect(readFileSync(instanceWins.bundleConfigPath, 'utf8')).toContain('app_id=7777777');
  });

  it('fails loud on a malformed wiring root instead of probing the working directory', () => {
    expect(() => assessVerdictPublicationIdentity({ instanceDir: 'relative/path', reviewEnabled: true }))
      .toThrow(/absolute instance directory/u);
  });
});

describe('verdict publication identity advisory leg (#444)', () => {
  const missing = assessVerdictPublicationIdentity({ instanceDir: tempDir('gru-444-advisory-'), reviewEnabled: true });

  it('advises only for github.com remotes — GitLab delivery is unaffected by the App identity', () => {
    expect(verdictPublicationIdentityWarning(missing, GITHUB_REMOTE)).toMatchObject({ leg: 'verdict-publication-identity' });
    expect(verdictPublicationIdentityWarning(missing, GITLAB_REMOTE)).toBeNull();
    expect(verdictPublicationIdentityWarning(missing, null)).toBeNull();
  });

  it('does not advise when the bundle resolves, whatever the remote', () => {
    const resolvedDir = tempDir('gru-444-advisory-ok-');
    writeAppBundle(resolvedDir);
    const resolved = assessVerdictPublicationIdentity({ instanceDir: resolvedDir, reviewEnabled: true });
    expect(resolved.gap).toBeNull();
    expect(verdictPublicationIdentityWarning(resolved, GITHUB_REMOTE)).toBeNull();
  });
});

describe('boot report: the missing bundle is an owner-visible incident (#444)', () => {
  function bootRig(): {
    api: LedgerApi;
    notifications: NotificationCenter;
    log: Array<{ level: string; msg: string; fields?: Record<string, unknown> }>;
    ownerAlerts: string[];
  } {
    const db = new LedgerDb(tempDir('gru-444-ledger-'));
    openDbs.push(db);
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    const log: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = [];
    const ownerAlerts: string[] = [];
    return {
      api,
      // The owner bell is the chat-notice hook; recording it proves the
      // notice reaches the human-facing surface, not just the ledger.
      notifications: new NotificationCenter({ ledger: api, bus, onNeedsOwner: (row) => ownerAlerts.push(row.kind) }),
      log,
      ownerAlerts,
    };
  }

  it('posts ONE needs-owner incident plus an error line, both naming the consequence', () => {
    const rig = bootRig();
    const instanceDir = tempDir('gru-444-boot-missing-');
    const report = reportVerdictPublicationIdentity({
      instanceDir,
      reviewEnabled: true,
      notifications: rig.notifications,
      log: (level, msg, fields) => rig.log.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }),
    });
    expect(report.gap).not.toBeNull();
    const incident = rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'unacked');
    expect(incident).not.toBeNull();
    expect(incident).toMatchObject({ kind: 'perkins-app-bundle-missing', routing: 'needs-owner', severity: 'error' });
    expect(incident!.detail).toContain(VERDICT_PUBLICATION_GAP);
    expect(incident!.detail).toContain('restart the service');
    // Scope honesty: a GitLab-only instance is not blocked by a GitHub identity.
    expect(incident!.detail).toContain('GitLab merge-request notes are unaffected');

    // The kind is registered owner-required, so the registry cannot re-route
    // this install prerequisite to Gru's machine queue.
    expect(ownerAttentionFor(PERKINS_APP_BUNDLE_MISSING_KIND)).toBe('owner-required');
    expect(resolveNotificationRouting(PERKINS_APP_BUNDLE_MISSING_KIND, 'needs-owner').routing).toBe('needs-owner');

    const errors = rig.log.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toMatch(/github\.com review verdicts cannot post/u);
    expect(errors[0]!.fields).toMatchObject({
      verdict_publication_identity: 'MISSING',
      scope: 'github.com verdict delivery; GitLab merge-request notes are unaffected',
    });
    // The owner bell rang exactly once for this incident.
    expect(rig.ownerAlerts).toEqual([PERKINS_APP_BUNDLE_MISSING_KIND]);
  });

  it('reuses the one unresolved incident across restarts — an ack silences the bell, never mints a second row', () => {
    const rig = bootRig();
    const instanceDir = tempDir('gru-444-boot-repeat-');
    const boot = () => reportVerdictPublicationIdentity({
      instanceDir,
      reviewEnabled: true,
      notifications: rig.notifications,
      log: () => {},
    });
    boot();
    const first = rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'unacked');
    boot();
    const second = rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'unacked');
    expect(first).not.toBeNull();
    expect(second!.id).toBe(first!.id);
    expect(rig.ownerAlerts).toHaveLength(1);

    // Ack is not the fix: the acknowledgement (the only human-facing bell)
    // stays heard, and the still-unmet prerequisite does not re-ring.
    rig.api.ackNotification(first!.id, 'owner');
    boot();
    expect(rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'unacked')).toBeNull();
    const afterAck = rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'any');
    expect(afterAck!.id).toBe(first!.id);
    expect(afterAck!.ackedAt).not.toBeNull();

    // The fix resolves it: positive evidence at a later boot.
    writeAppBundle(instanceDir);
    boot();
    expect(rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'active')).toBeNull();
  });

  it('resolves the incident on positive evidence: the bundle resolves or reviews are off', () => {
    const rig = bootRig();
    const instanceDir = tempDir('gru-444-boot-resolve-');
    const boot = (reviewEnabled: boolean) => reportVerdictPublicationIdentity({
      instanceDir,
      reviewEnabled,
      notifications: rig.notifications,
      log: () => {},
    });
    boot(true);
    expect(rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'active')).not.toBeNull();

    writeAppBundle(instanceDir);
    boot(true);
    expect(rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'active')).toBeNull();
    expect(rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'any')).toMatchObject({ routing: 'needs-owner' });

    // Disabling the gate is evidence too: no round can owe a verdict.
    const other = tempDir('gru-444-boot-disabled-');
    reportVerdictPublicationIdentity({
      instanceDir: other,
      reviewEnabled: true,
      notifications: rig.notifications,
      log: () => {},
    });
    expect(rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'active')).not.toBeNull();
    reportVerdictPublicationIdentity({
      instanceDir: other,
      reviewEnabled: false,
      notifications: rig.notifications,
      log: () => {},
    });
    expect(rig.api.findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'active')).toBeNull();
  });
});

describe('composed boot wiring (real service)', () => {
  it('the real main() boot raises the owner notice and the ledger row for a bundle-less instance', async () => {
    const root = join(import.meta.dirname, '..');
    const { startRealService } = await import('./helpers/real-service.mjs');
    const service = await startRealService({
      port: 0,
      token: 'gru-444-boot-token',
      requireWebDist: false,
      keepHome: true, // read the durable ledger after shutdown
    });
    try {
      await service.stop();
      const db = new LedgerDb(service.home);
      try {
        const row = new LedgerApi(db.handle).findNotificationByKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'unacked');
        expect(row, `no boot incident in ${service.home} (is dist/ stale for ${root}?)`).not.toBeNull();
        expect(row).toMatchObject({ routing: 'needs-owner', severity: 'error' });
        expect(row!.detail).toContain(VERDICT_PUBLICATION_GAP);
      } finally {
        db.close();
      }
    } finally {
      await service.stop();
      rmSync(service.home, { recursive: true, force: true });
      rmSync(service.workspace, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('installer flow: the setup guide is inline (#444)', () => {
  it('renders the full bundle guide with the literal facts a stranger needs', () => {
    const instanceDir = tempDir('gru-444-guide-');
    const guide = renderPerkinsAppSetupGuide(instanceDir);
    expect(guide).toContain('app_id=4366368');
    expect(guide).toContain(`key_path="${join(instanceDir, 'perkins', 'app-key.pem')}"`);
    expect(guide).toContain('installation_id_<owner>');
    expect(guide).toContain('never sourced as a shell script');
    expect(guide).toContain('0600');
    expect(guide).toContain('0700');
    expect(guide).toContain('Restart the service');
    expect(guide).toContain('perkins-review[bot]');
    expect(guide).toContain('docs/PERKINS-APP-PUBLICATION.md');
  });

  it('the end-of-setup note never claims a gap on an instance whose preserved config disables review', () => {
    const instanceDir = tempDir('gru-444-note-disabled-');
    const note = renderPerkinsAppPrerequisiteNote(instanceDir, undefined, false);
    expect(note).toContain('not required');
    expect(note).not.toContain(VERDICT_PUBLICATION_GAP);
    expect(note).not.toContain('app_id=4366368');
  });

  it('the end-of-setup note leads with the named gap and inline guide, or confirms the bundle', () => {
    const instanceDir = tempDir('gru-444-note-');
    const missing = renderPerkinsAppPrerequisiteNote(instanceDir);
    expect(missing).toContain(VERDICT_PUBLICATION_GAP);
    expect(missing).toContain(join(instanceDir, 'perkins', 'config'));
    expect(missing).toContain('app_id=4366368');

    writeAppBundle(instanceDir);
    const present = renderPerkinsAppPrerequisiteNote(instanceDir);
    expect(present).toContain('Perkins App bundle found');
    expect(present).toContain('perkins-review[bot]');
    expect(present).not.toContain(VERDICT_PUBLICATION_GAP);
  });

  // The wizard's runtime check needs a `claude` CLI on PATH; the suite's
  // env-setup appends an inert stub for exactly this reason, so the child
  // inherits it and the test never depends on the host's installs.
  it('the wizard prints the prerequisite status (headless setup against a fresh instance)', () => {
    const repoRoot = join(import.meta.dirname, '..');
    const workspace = tempDir('gru-444-wizard-ws-');
    const instance = tempDir('gru-444-wizard-home-');
    const run = () => spawnSync(process.execPath, [join(repoRoot, 'dist', 'wizard', 'main.js'), '--no-interact', '--force',
      '--answers', JSON.stringify({ workspace_root: workspace, repos: [], port: 0, smoke: false })], {
      env: { ...process.env, GRU_COMMAND_HOME: instance },
      encoding: 'utf-8',
      timeout: 60_000,
    });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('verdict publication identity: MISSING');
    expect(first.stdout).toContain('app_id=4366368');
    expect(first.stdout).toContain('Setup complete');

    writeAppBundle(instance);
    const second = run();
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('Perkins App bundle found');
    expect(second.stdout).not.toContain('verdict publication identity: MISSING');
  }, 120_000);
});

describe('round-side advisory report (#444)', () => {
  it('names the degraded leg and its remediation; nothing to say yields no line', () => {
    expect(preflightAdvisoryFields({ ok: true, failures: [] })).toBeNull();
    expect(preflightAdvisoryFields({ ok: true, failures: [], warnings: [] })).toBeNull();
    const fields = preflightAdvisoryFields({
      ok: true,
      failures: [],
      warnings: [{ leg: 'verdict-publication-identity', detail: VERDICT_PUBLICATION_GAP, remediation: 'restart the service' }],
    });
    expect(fields).not.toBeNull();
    expect(fields!['advisories']).toEqual([`verdict-publication-identity: ${VERDICT_PUBLICATION_GAP}`]);
    expect(fields!['remediation']).toEqual(['restart the service']);
  });
});

describe('docs and wiring pins (#444)', () => {
  const root = join(import.meta.dirname, '..');

  it('README Prerequisites carries the App bundle as a prerequisite with the guide inline', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const prerequisites = readme.slice(readme.indexOf('## Prerequisites'), readme.indexOf('## Setup'));
    expect(prerequisites).toContain('Perkins App bundle');
    expect(prerequisites).toContain('install prerequisite');
    expect(prerequisites).toContain('app_id=4366368');
    expect(prerequisites).toContain('installation_id_<owner>');
    expect(prerequisites).toContain('perkins-review[bot]');
    expect(prerequisites).toContain('PERKINS-APP-PUBLICATION.md');
  });

  it('boot and review-request wiring cannot silently drop the prerequisite surfaces', () => {
    const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8');
    expect(main).toContain('reportVerdictPublicationIdentity({');
    expect(main).toContain('verdictPublicationIdentityWarning(');
    expect(main).toContain('reviewEnabled: config.review.enabled,');
    // The boot notice must not be able to keep the service from starting,
    // and it must post after the chat bell is bound (surfaceInChat).
    expect(main).toMatch(/try \{\n\s+reportVerdictPublicationIdentity\(\{/u);
    expect(main.indexOf('reportVerdictPublicationIdentity({')).toBeGreaterThan(main.indexOf('surfaceInChat = (notification) => {'));
  });

  it('the four-leg route is decided before the advisory is reported (a fallback never claims "the round continues")', () => {
    const perkins = readFileSync(join(root, 'src', 'dispatch', 'perkins.ts'), 'utf8');
    const fallbackReturn = perkins.indexOf('return this.beginFallbackGate(input, result.failures, lanePath');
    const advisoryCalls = [...perkins.matchAll(/this\.reportPreflightWarnings\(input\.jobId, result\);/gu)].map((match) => match.index ?? 0);
    expect(fallbackReturn).toBeGreaterThan(0);
    expect(advisoryCalls).toHaveLength(2);
    // Reported only after the round was constructed (admitted), never before.
    expect(advisoryCalls[0]).toBeGreaterThan(fallbackReturn);
    expect(advisoryCalls[0]).toBeGreaterThan(perkins.indexOf('reviewThinkingLevel: result.reviewThinkingLevel,'));
    expect(perkins).toContain('const fields = preflightAdvisoryFields(result);');
  });
});
