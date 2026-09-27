import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERKINS_POLICY_ID = 'perkins-code-review';
export const PERKINS_CANONICAL_SOURCE_SHA256 = 'f38c28ffb10b4e44fa1f87f260a08507bb0a5c8872de2cf47e05a985c5eb92e7';
export const PERKINS_POLICY_SHA256 = '5622da6b100dff79cda29147cb7a3ecd8dd5e0e4905b8bcfb4dcd22f58dfb6a9';

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

/** Authoring sources of a whole-PR review finding: any specialist lens, or
 * the lead's own investigation. */
export const PERKINS_FINDING_SOURCES = [...PERKINS_LENSES, 'lead'] as const;
export type PerkinsFindingSource = (typeof PERKINS_FINDING_SOURCES)[number];

export interface PerkinsPolicy {
  readonly identity: string;
  readonly version: number;
  readonly attribution: string;
  readonly provenance: { readonly snapshot: string; readonly sourceSha256: string };
  readonly portableContract: {
    readonly findingSchema: Readonly<Record<string, string>>;
    readonly sharedPrompt: string;
    readonly blindPrompt: string;
    /** Child output instructions rendered into {{OUTPUT_CONTRACT}}: the
     * native-tool contract is tool-only; the text contracts are the strict
     * bare-array envelope kept for non-tool runtimes. */
    readonly outputContracts: {
      readonly text: string;
      readonly blindText: string;
      readonly nativeTool: string;
      readonly blindNativeTool: string;
    };
    readonly leadWorkflow: string;
    readonly lenses: Readonly<Record<PerkinsLens, string>>;
    readonly rules: {
      readonly fullLenses: readonly PerkinsLens[];
      readonly noSpecLenses: readonly PerkinsLens[];
      /** Per-specialist attempt bound: a resource limit on one lens's
       * retries, never a required-coverage gate. */
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
    policy.portableContract?.rules?.maxLensAttempts !== 2 ||
    policy.portableContract?.rules?.incompleteNeverApproves !== true
  ) {
    throw new Error(`bundled ${PERKINS_POLICY_ID} resource failed its identity/provenance/rules contract`);
  }
  const rules = policy.portableContract.rules;
  if ('chunkLineThreshold' in rules) {
    throw new Error(`bundled ${PERKINS_POLICY_ID} carries the retired chunk-threshold rule`);
  }
  for (const lens of PERKINS_LENSES) {
    if (typeof policy.portableContract.lenses[lens] !== 'string' || policy.portableContract.lenses[lens].trim() === '') {
      throw new Error(`bundled ${PERKINS_POLICY_ID} resource is missing lens ${lens}`);
    }
  }
  if (typeof policy.portableContract.leadWorkflow !== 'string' || !policy.portableContract.leadWorkflow.includes('perkins_submit_review')) {
    throw new Error(`bundled ${PERKINS_POLICY_ID} resource is missing the whole-PR lead workflow`);
  }
  const outputContracts = policy.portableContract.outputContracts;
  for (const key of ['text', 'blindText', 'nativeTool', 'blindNativeTool'] as const) {
    if (typeof outputContracts?.[key] !== 'string' || outputContracts[key].trim() === '') {
      throw new Error(`bundled ${PERKINS_POLICY_ID} resource is missing child output contract ${key}`);
    }
  }
  for (const key of ['nativeTool', 'blindNativeTool'] as const) {
    if (!outputContracts[key].includes('perkins_submit_findings')) {
      throw new Error(`bundled ${PERKINS_POLICY_ID} ${key} contract must name the perkins_submit_findings tool`);
    }
  }
  for (const key of ['sharedPrompt', 'blindPrompt'] as const) {
    if (!policy.portableContract[key].includes('{{OUTPUT_CONTRACT}}')) {
      throw new Error(`bundled ${PERKINS_POLICY_ID} ${key} is missing the output-contract placeholder`);
    }
  }
  // The blind child has no tools: the whole-change file inventory and the
  // locatable-evidence discipline are the only grounding that keeps its
  // citations verifiable, so the policy cannot silently drop either.
  if (!policy.portableContract.blindPrompt.includes('{{CHANGED_FILES}}')) {
    throw new Error(`bundled ${PERKINS_POLICY_ID} blindPrompt is missing the whole-change file inventory placeholder`);
  }
  for (const key of ['blindText', 'blindNativeTool'] as const) {
    if (!outputContracts[key].includes('FILES IN THIS CHANGE') || !outputContracts[key].includes('recited verbatim')) {
      throw new Error(`bundled ${PERKINS_POLICY_ID} ${key} is missing the locatable-evidence discipline`);
    }
  }
  if (policy.portableContract.rules.fullLenses.join(',') !== PERKINS_LENSES.join(',')) {
    throw new Error(`bundled ${PERKINS_POLICY_ID} full-lens order drifted`);
  }
  return policy;
}
