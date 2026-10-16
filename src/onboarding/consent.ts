import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The installer's one-shot onboarding consent (#427). The wizard runs with
 * the service down: it probes the selected repositories, asks once whether
 * to onboard the ones whose origin has no manifest, and leaves the answer
 * here. The service reads it at its next start, records each repository's
 * consent in the ledger, and removes the file. Consent skips the FOR YOU
 * card; it never skips a decline, an open job or the origin check.
 */

export const ONBOARDING_CONSENT_FILE = 'onboarding-consent.json';

export interface OnboardingConsent {
  readonly source: 'installer';
  /** When the owner answered the installer. */
  readonly recordedAt: string;
  readonly repos: readonly string[];
}

export class OnboardingConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingConsentError';
  }
}

export const onboardingConsentPath = (instanceDir: string): string => join(instanceDir, ONBOARDING_CONSENT_FILE);

/** Write (or replace) the consent file atomically, private to the owner. */
export function writeOnboardingConsent(instanceDir: string, repos: readonly string[], now: Date = new Date()): string {
  if (repos.length === 0) throw new OnboardingConsentError('onboarding consent names no repository');
  const path = onboardingConsentPath(instanceDir);
  const temp = `${path}.${String(process.pid)}.tmp`;
  const body = { version: 1, source: 'installer', recorded_at: now.toISOString(), repos: [...repos] };
  writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return path;
}

/** The consent file, or null when there is none. A file that exists but is
 * not a consent record fails loud, naming what is wrong with it. */
export function readOnboardingConsent(instanceDir: string): OnboardingConsent | null {
  const path = onboardingConsentPath(instanceDir);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new OnboardingConsentError(`onboarding consent ${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (record === null || record['version'] !== 1 || record['source'] !== 'installer') {
    throw new OnboardingConsentError(`onboarding consent ${path} must be {"version": 1, "source": "installer", "recorded_at", "repos"}`);
  }
  const recordedAt = record['recorded_at'];
  if (typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt))) {
    throw new OnboardingConsentError(`onboarding consent ${path} recorded_at must be an ISO timestamp`);
  }
  const repos = record['repos'];
  if (!Array.isArray(repos) || repos.length === 0 || repos.some((repo) => typeof repo !== 'string' || repo === '')) {
    throw new OnboardingConsentError(`onboarding consent ${path} repos must be a non-empty list of repository names`);
  }
  return { source: 'installer', recordedAt, repos: [...new Set(repos as string[])] };
}

export function removeOnboardingConsent(instanceDir: string): void {
  rmSync(onboardingConsentPath(instanceDir), { force: true });
}
