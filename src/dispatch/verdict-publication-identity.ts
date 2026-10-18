import { join } from 'node:path';
import {
  perkinsAppBundleConfigured,
  perkinsAppBundleDir,
  resolvePerkinsAppBundleRoot,
} from './perkins-github-app.js';
import {
  isGitHubRemote,
  type RepoRemote,
  type ReviewAdvisoryLeg,
  type ReviewPreflightWarning,
} from './review-path.js';

/**
 * Verdict publication identity as an INSTALL PREREQUISITE (issue #444).
 *
 * Owner ruling 2026-09-27 requires the installed Perkins GitHub App
 * (`perkins-review[bot]`) for github.com verdicts, never a personal
 * account — GitHub rejects an account approving its own pull request. The
 * poster is selected ONCE at startup by bundle presence
 * (`createStartupVerdictPoster`), so a missing bundle is a boot fact, not a
 * per-round surprise: without this check a fresh install runs a complete
 * review round and only then dies on a self-author 422, having wasted the
 * round. Docs describe the bundle as the designed identity; this module
 * makes its absence say so out loud.
 *
 * Nothing here changes the publisher. The bundle present selects the App
 * poster exactly as before; its absence keeps the documented legacy `gh`
 * poster (a compatibility boundary, not a silent swap) and is reported as
 * a named gap: one owner-required boot notice, an error log line on every
 * boot, and the non-blocking `verdict-publication-identity` pre-flight
 * advisory on every admitted github.com round. An owner Ack (through the
 * notification API — the FOR YOU band renders no Ack control for a notice)
 * silences the owner bell; the ack is an explicit acknowledgement, never a
 * fix, and the boot error line and the per-round advisory keep naming the
 * gap until positive evidence resolves the incident.
 */

/** The named pre-flight advisory leg (declared once in
 * src/dispatch/review-path.ts REVIEW_ADVISORY_LEGS). */
const VERDICT_PUBLICATION_IDENTITY_LEG: ReviewAdvisoryLeg = 'verdict-publication-identity';

/** Owner-required boot incident kind for a missing bundle. Registered in
 * src/notifications/attention.ts, resolved by positive evidence at boot. */
export const PERKINS_APP_BUNDLE_MISSING_KIND = 'perkins-app-bundle-missing';

/** The condition in one named line — the text both the boot check and the
 * pre-flight advisory carry. */
export const VERDICT_PUBLICATION_GAP =
  'verdict publication identity: MISSING — reviews will run but verdicts cannot post (self-author 422)';

export interface VerdictPublicationIdentity {
  /** The selected github.com publisher: App mode, or the legacy `gh` poster. */
  readonly mode: 'perkins-app' | 'personal-gh';
  readonly reviewEnabled: boolean;
  /** Root holding `perkins/` (instance dir, or the `data_dir` fallback). */
  readonly bundleRoot: string;
  readonly bundleConfigPath: string;
  readonly bundlePresent: boolean;
  /** Non-null only when `[review] enabled = true` and no bundle resolves. */
  readonly gap: ReviewPreflightWarning | null;
}

export interface VerdictPublicationIdentityInput {
  readonly instanceDir: string;
  readonly dataDir?: string | undefined;
  readonly reviewEnabled: boolean;
}

/** Assessment of the identity a github.com verdict would publish as right
 * now. A malformed wiring root throws from the shared bundle resolver
 * (named, absolute-path failure) instead of probing the working directory. */
export function assessVerdictPublicationIdentity(input: VerdictPublicationIdentityInput): VerdictPublicationIdentity {
  const bundleRoot = resolvePerkinsAppBundleRoot({
    instanceDir: input.instanceDir,
    ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
  });
  const bundleConfigPath = join(perkinsAppBundleDir(bundleRoot), 'config');
  const bundlePresent = perkinsAppBundleConfigured(bundleRoot);
  const remediation =
    `Install the Perkins GitHub App bundle in ${perkinsAppBundleDir(bundleRoot)} ` +
    '(config with app_id, key_path and one installation_id_<owner> per reviewed owner, plus the App RSA key — ' +
    'owner-only regular files 0600, the bundle directory exactly 0700), then restart the service: ' +
    'the verdict poster resolves the bundle at startup only. Steps: README Prerequisites / docs/PERKINS-APP-PUBLICATION.md.';
  const gap: ReviewPreflightWarning | null = bundlePresent || !input.reviewEnabled
    ? null
    : {
      leg: VERDICT_PUBLICATION_IDENTITY_LEG,
      detail: `${VERDICT_PUBLICATION_GAP}; no Perkins App bundle at ${bundleConfigPath}`,
      remediation,
    };
  return {
    mode: bundlePresent ? 'perkins-app' : 'personal-gh',
    reviewEnabled: input.reviewEnabled,
    bundleRoot,
    bundleConfigPath,
    bundlePresent,
    gap,
  };
}

/** The advisory for a repository whose remote this round will publish to:
 * only github.com routes through the (absent) App — GitLab notes and
 * unsupported origins are unaffected by the GitHub identity. */
export function verdictPublicationIdentityWarning(
  identity: VerdictPublicationIdentity,
  remote: RepoRemote | null,
): ReviewPreflightWarning | null {
  if (identity.gap === null) return null;
  if (remote === null || !isGitHubRemote(remote.host)) return null;
  return identity.gap;
}

/** The owner-facing setup guide: the install prerequisite, inline. */
export function renderPerkinsAppSetupGuide(instanceDir: string): string {
  const bundleDir = perkinsAppBundleDir(instanceDir);
  return [
    'Install the Perkins GitHub App bundle (install prerequisite for review verdicts):',
    `  1. Install the GitHub App (id 4366368 for this deployment) in the org that hosts the`,
    '     reviewed repositories, with access to those repositories. Note each owner\'s',
    '     installation id from the installation URL.',
    `  2. Write the bundle in ${bundleDir} (files take literal KEY=VALUE data and are`,
    '     never sourced as a shell script; 0600, or a hardened 0400 for the key):',
    `       ${join(bundleDir, 'config')}`,
    '         app_id=4366368',
    `         key_path="${join(bundleDir, 'app-key.pem')}"`,
    '         installation_id_<owner>=<installation id>   # one entry per reviewed owner',
    `       ${join(bundleDir, 'app-key.pem')}   # the RSA PEM from the App settings page`,
    '     Regular files owned by the service user, owner-only; the directory itself exactly 0700.',
    '  3. Restart the service — the verdict poster resolves the bundle at startup only.',
    '  4. Verify: run a review round; the verdict must post as perkins-review[bot].',
    '     (If it posts as your personal account, the bundle did not resolve.)',
    'Full reference: docs/PERKINS-APP-PUBLICATION.md.',
  ].join('\n');
}

/** The installer flow's status block. Silent about the remediation when the
 * prerequisite is already satisfied OR reviews are disabled (no verdict is
 * owed then); otherwise it leads with the named gap and the guide. */
export function renderPerkinsAppPrerequisiteNote(
  instanceDir: string,
  dataDir?: string,
  reviewEnabled = true,
): string {
  const identity = assessVerdictPublicationIdentity({
    instanceDir,
    ...(dataDir !== undefined ? { dataDir } : {}),
    reviewEnabled,
  });
  if (!identity.gap) {
    if (!identity.reviewEnabled) {
      return 'Review verdict publication: not required — [review] enabled = false in this instance.\n';
    }
    return `Review verdict publication: Perkins App bundle found (${identity.bundleConfigPath}) — ` +
      'github.com verdicts post as perkins-review[bot]; the credential itself is validated at publication.\n';
  }
  return [
    '',
    `⚠ ${VERDICT_PUBLICATION_GAP}`,
    `  No Perkins App bundle at ${identity.bundleConfigPath}.`,
    '  github.com verdicts would publish as your personal `gh` identity, and GitHub',
    '  rejects an account approving its own pull request — every heist PR is created',
    '  by that same identity.',
    '',
    renderPerkinsAppSetupGuide(instanceDir),
    '',
  ].join('\n');
}

/** What the boot check needs from the notification center. */
export interface VerdictPublicationNoticeSink {
  postIncident(input: {
    readonly kind: string;
    readonly routing: 'needs-owner';
    readonly severity: 'error';
    readonly title: string;
    readonly detail?: string | null;
    readonly dedupe: 'active';
  }): unknown;
  resolveExactKind(kind: string, by: string): readonly unknown[];
}

export interface VerdictPublicationBootReport {
  readonly instanceDir: string;
  readonly dataDir?: string | undefined;
  readonly reviewEnabled: boolean;
  readonly notifications: VerdictPublicationNoticeSink;
  readonly log: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * Boot surface for the identity. A missing bundle is loud: one error log
 * line (the JSONL record) and one owner-required incident (FOR YOU), both
 * naming the consequence and the remediation. The incident is posted with
 * `active` dedupe, so every restart reuses the ONE unresolved row (an owner
 * ack silences the bell without hiding the gap or minting a second row);
 * positive evidence at boot — a resolved bundle, or reviews turned off —
 * resolves it, so the notice clears once the prerequisite is met.
 */
export function reportVerdictPublicationIdentity(input: VerdictPublicationBootReport): VerdictPublicationIdentity {
  const identity = assessVerdictPublicationIdentity({
    instanceDir: input.instanceDir,
    ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
    reviewEnabled: input.reviewEnabled,
  });
  if (identity.gap !== null) {
    // Scope is github.com only: GitLab merge-request notes publish on their
    // own token path, so a GitLab-only instance is told the truth (the
    // notice carries the same scope and can be acknowledged) instead of
    // being told its verdicts cannot post.
    input.log('error', 'github.com review verdicts cannot post — the Perkins App bundle is missing', {
      verdict_publication_identity: 'MISSING',
      scope: 'github.com verdict delivery; GitLab merge-request notes are unaffected',
      publisher: 'legacy personal gh (compatibility fallback)',
      consequence: 'self-author 422 on github.com PRs authored by the same gh account',
      bundle_root: identity.bundleRoot,
      bundle_config: identity.bundleConfigPath,
      remediation: identity.gap.remediation,
    });
    input.notifications.postIncident({
      kind: PERKINS_APP_BUNDLE_MISSING_KIND,
      routing: 'needs-owner',
      severity: 'error',
      title: 'Perkins App bundle missing — github.com review verdicts cannot post',
      detail: `${identity.gap.detail}\n\n${identity.gap.remediation}\n\n` +
        'Scope: github.com verdict delivery. GitLab merge-request notes are unaffected, so an instance that reviews only GitLab remotes can acknowledge this notice.',
      dedupe: 'active',
    });
    return identity;
  }
  // Positive evidence: an App bundle resolves, or reviews are disabled.
  // Either way an older owner notice must not keep ringing.
  input.notifications.resolveExactKind(PERKINS_APP_BUNDLE_MISSING_KIND, 'service-boot');
  // Presence selects the App poster; the bundle's VALIDITY is deliberately
  // proven at publication time (never at boot), so this line claims the
  // selection, not a proven identity.
  input.log('info', 'review verdict publication identity', {
    publisher: identity.mode === 'perkins-app'
      ? 'perkins github app bundle present (selected at startup; validated at publication)'
      : 'not required (review disabled)',
    review_enabled: identity.reviewEnabled,
    bundle_root: identity.bundleRoot,
  });
  return identity;
}
