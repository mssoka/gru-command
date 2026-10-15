import type { PropertyProposal } from './types.js';

/**
 * Strict validation for GH350 property-contract proposals (issue §4).
 *
 * Proposals are UNTRUSTED reviewer input: this module only validates shape
 * and bounds — it never executes anything and never treats a proposal as
 * evidence (host receipts are the only evidence). The discipline mirrors
 * `src/dispatch/perkins-review/types.ts`: exact key sets, bounded non-empty
 * strings, fail-loud named errors with messages a stranger can act on.
 */

/** UTF-8 byte ceilings and entry caps for proposal payloads. */
export const PROPERTY_PROPOSAL_LIMITS = {
  requirementRef: 200,
  invariant: 2_000,
  inputDomain: 2_000,
  invalidInputBehavior: 2_000,
  establishes: 2_000,
  doesNotEstablish: 2_000,
  targetPackageDir: 500,
  adapterId: 200,
  artifactPath: 500,
  maxArtifactRefs: 200,
} as const;

const PROPOSAL_KEYS = [
  'requirementRef',
  'invariant',
  'inputDomain',
  'invalidInputBehavior',
  'targetPackageDir',
  'adapterId',
  'testArtifactRefs',
  'establishes',
  'doesNotEstablish',
] as const;

const ARTIFACT_REF_KEYS = ['path', 'sha256'] as const;

export class PropertyProposalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyProposalValidationError';
  }
}

function fail(message: string): never {
  throw new PropertyProposalValidationError(message);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0')) {
    fail(`${name} keys do not match the required schema (expected exactly: ${expected.join(', ')})`);
  }
}

function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${name} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, 'utf8') > max) {
    fail(`${name} exceeds ${max} UTF-8 bytes`);
  }
  return value;
}

/**
 * A repo-relative path that is safe to hand to host tooling: relative (no
 * leading `/` or drive colon anywhere), no `..` or `.` segments, no
 * backslash, no control bytes, and no leading `-` (git pathspec hazard).
 */
export function isSafeRelativePath(value: string): boolean {
  return value !== '' &&
    Buffer.byteLength(value, 'utf8') <= 500 &&
    !value.startsWith('/') && !value.startsWith('-') && !value.includes('\\') &&
    !value.includes(':') && ![...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    }) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * A target package directory: the shared contract's safe relative path
 * rules, plus the exact root-package form `.` that seam A's resolution
 * (`src/property/resolve.ts`) uses for the repository root package. A
 * proposal targeting the root package is legitimate; a path with `.`/`..`
 * segments, absolute prefixes or escapes is not.
 */
export function isSafeTargetPackageDir(value: string): boolean {
  return value === '.' || isSafeRelativePath(value);
}

function safeRelativePath(value: string, name: string): string {
  if (!isSafeRelativePath(value)) {
    fail(
      `${name} must be a safe relative path (no leading "/", no leading "-", no ".." or "." segments, ` +
        `no empty segments, no backslash, no colon, no control bytes), got: "${value}"`,
    );
  }
  return value;
}

function safeTargetPackageDir(value: string): string {
  if (!isSafeTargetPackageDir(value)) {
    fail(
      'property proposal targetPackageDir must be a safe target package directory ' +
        '("." for the root package, or a safe relative path with no ".."/"." segments, no leading ' +
        '"/" or "-", no backslash, no colon, no control bytes), ' +
        `got: "${value}"`,
    );
  }
  return value;
}

function sha256Hex(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${name} must be a sha256 hex digest (exactly 64 lowercase hex characters)`);
  }
  return value;
}

function parseArtifactRefs(value: unknown): PropertyProposal['testArtifactRefs'] {
  if (!Array.isArray(value)) {
    fail('property proposal testArtifactRefs must be an array');
  }
  if (value.length === 0) {
    fail('property proposal testArtifactRefs must contain at least one artifact ref (a proposal without test artifacts establishes nothing)');
  }
  if (value.length > PROPERTY_PROPOSAL_LIMITS.maxArtifactRefs) {
    fail(`property proposal testArtifactRefs exceeds ${PROPERTY_PROPOSAL_LIMITS.maxArtifactRefs} entries`);
  }
  return value.map((entry, index) => {
    const candidate = object(entry, `property proposal testArtifactRefs[${index}]`);
    exactKeys(candidate, ARTIFACT_REF_KEYS, `property proposal testArtifactRefs[${index}]`);
    return {
      path: safeRelativePath(
        boundedString(candidate['path'], `testArtifactRefs[${index}].path`, PROPERTY_PROPOSAL_LIMITS.artifactPath),
        `testArtifactRefs[${index}].path`,
      ),
      sha256: sha256Hex(candidate['sha256'], `testArtifactRefs[${index}].sha256`),
    };
  });
}

/**
 * Validate an untrusted proposal payload into a `PropertyProposal`.
 * Every deviation throws `PropertyProposalValidationError` with a message
 * a stranger can act on. Validation only — nothing is executed.
 */
export function parsePropertyProposal(input: unknown): PropertyProposal {
  const candidate = object(input, 'property proposal');
  exactKeys(candidate, PROPOSAL_KEYS, 'property proposal');
  return {
    requirementRef: boundedString(
      candidate['requirementRef'], 'property proposal requirementRef', PROPERTY_PROPOSAL_LIMITS.requirementRef,
    ),
    invariant: boundedString(
      candidate['invariant'], 'property proposal invariant', PROPERTY_PROPOSAL_LIMITS.invariant,
    ),
    inputDomain: boundedString(
      candidate['inputDomain'], 'property proposal inputDomain', PROPERTY_PROPOSAL_LIMITS.inputDomain,
    ),
    invalidInputBehavior: boundedString(
      candidate['invalidInputBehavior'], 'property proposal invalidInputBehavior', PROPERTY_PROPOSAL_LIMITS.invalidInputBehavior,
    ),
    targetPackageDir: safeTargetPackageDir(
      boundedString(
        candidate['targetPackageDir'], 'property proposal targetPackageDir', PROPERTY_PROPOSAL_LIMITS.targetPackageDir,
      ),
    ),
    adapterId: boundedString(
      candidate['adapterId'], 'property proposal adapterId', PROPERTY_PROPOSAL_LIMITS.adapterId,
    ),
    testArtifactRefs: parseArtifactRefs(candidate['testArtifactRefs']),
    establishes: boundedString(
      candidate['establishes'], 'property proposal establishes', PROPERTY_PROPOSAL_LIMITS.establishes,
    ),
    doesNotEstablish: boundedString(
      candidate['doesNotEstablish'], 'property proposal doesNotEstablish', PROPERTY_PROPOSAL_LIMITS.doesNotEstablish,
    ),
  };
}
