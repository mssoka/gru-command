import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERKINS_POLICY_ID = 'perkins-code-review';
export const PERKINS_CANONICAL_SOURCE_SHA256 = 'f38c28ffb10b4e44fa1f87f260a08507bb0a5c8872de2cf47e05a985c5eb92e7';
export const PERKINS_POLICY_SHA256 = 'c1b26e3a1fcb9e5acf3f7cadce96d6fe7b06a0ef83d1242d5fcf880c113c0998';

export const PERKINS_LENSES = [
  'blind',
  'edge',
  'acceptance',
  'security',
  'architecture',
  'codebase',
  'tests',
] as const;
export type PerkinsLens = (typeof PERKINS_LENSES)[number];

export interface PerkinsPolicy {
  readonly identity: string;
  readonly version: number;
  readonly attribution: string;
  readonly provenance: { readonly snapshot: string; readonly sourceSha256: string };
  readonly portableContract: {
    readonly findingSchema: Readonly<Record<string, string>>;
    readonly sharedPrompt: string;
    readonly blindPrompt: string;
    readonly leadWorkflow: string;
    readonly lenses: Readonly<Record<PerkinsLens, string>>;
    readonly verificationPrompt: string;
    readonly reReviewPrompt: string;
    readonly rules: {
      readonly fullLenses: readonly PerkinsLens[];
      readonly noSpecLenses: readonly PerkinsLens[];
      readonly chunkLineThreshold: number;
      readonly maxLensAttempts: number;
      readonly verdicts: Readonly<Record<string, string>>;
      readonly dedupeKey: string;
      readonly incompleteNeverApproves: boolean;
    };
  };
  readonly hostReplacements: readonly string[];
}

/** src/ and dist/ share the same depth under the product root. */
export const PERKINS_PRODUCT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PERKINS_POLICY_FILE = join(
  PERKINS_PRODUCT_ROOT,
  'resources',
  'perkins-code-review',
  'policy.json',
);

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function loadPerkinsPolicy(file = PERKINS_POLICY_FILE): PerkinsPolicy {
  let source: string;
  try {
    if (file === PERKINS_POLICY_FILE) {
      const info = lstatSync(file);
      const root = realpathSync(PERKINS_PRODUCT_ROOT);
      const actual = realpathSync(file);
      const rel = relative(root, actual);
      if (!info.isFile() || info.isSymbolicLink() || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error('resource is not a regular file contained by the installed product');
      }
    }
    source = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`bundled ${PERKINS_POLICY_ID} resource is unreadable at ${file} (${String(error)})`);
  }
  const actual = sha256(source);
  // The integrity pin applies to EVERY resolved path: a caller-supplied
  // alternate path loads the same fail-closed verification, never unverified.
  if (actual !== PERKINS_POLICY_SHA256) {
    throw new Error(
      `bundled ${PERKINS_POLICY_ID} integrity mismatch at ${file}: expected ${PERKINS_POLICY_SHA256}, got ${actual}`,
    );
  }
  let policy: PerkinsPolicy;
  try {
    policy = JSON.parse(source) as PerkinsPolicy;
  } catch (error) {
    throw new Error(`bundled ${PERKINS_POLICY_ID} resource is malformed JSON (${String(error)})`);
  }
  if (
    policy.identity !== PERKINS_POLICY_ID ||
    policy.version !== 1 ||
    policy.provenance?.sourceSha256 !== PERKINS_CANONICAL_SOURCE_SHA256 ||
    policy.portableContract?.rules?.chunkLineThreshold !== 3000 ||
    policy.portableContract?.rules?.maxLensAttempts !== 2 ||
    policy.portableContract?.rules?.incompleteNeverApproves !== true
  ) {
    throw new Error(`bundled ${PERKINS_POLICY_ID} resource failed its identity/provenance/rules contract`);
  }
  for (const lens of PERKINS_LENSES) {
    if (typeof policy.portableContract.lenses[lens] !== 'string' || policy.portableContract.lenses[lens].trim() === '') {
      throw new Error(`bundled ${PERKINS_POLICY_ID} resource is missing lens ${lens}`);
    }
  }
  if (typeof policy.portableContract.leadWorkflow !== 'string' || !policy.portableContract.leadWorkflow.includes('perkins_submit_review')) {
    throw new Error(`bundled ${PERKINS_POLICY_ID} resource is missing the hybrid lead workflow`);
  }
  if (policy.portableContract.rules.fullLenses.join(',') !== PERKINS_LENSES.join(',')) {
    throw new Error(`bundled ${PERKINS_POLICY_ID} full-lens order drifted`);
  }
  return policy;
}
