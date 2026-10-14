import type { PropertyProposal } from '../../property/types.js';
import { parsePropertyProposal, PROPERTY_PROPOSAL_LIMITS, PropertyProposalValidationError } from '../../property/proposal.js';

/**
 * GH350 Perkins production wiring (issue §3): a structured, requirement-
 * grounded property-contract proposal path for the review lead.
 *
 * Trust boundary (host-owned, non-negotiable):
 * - Proposals are UNTRUSTED reviewer input. Recording a proposal asserts
 *   nothing about execution; reviewer-written claims are never evidence
 *   that tests ran. Host execution receipts are a separate host-owned
 *   artifact type produced only by the property executor.
 * - A proposal NEVER authorizes merging, execution, dependency
 *   installation or any command; qualification and execution decisions
 *   belong to the host pipeline (GH350 seams B/D).
 */

export const PROPERTY_CONTRACTS_TOOL_NAME = 'perkins_submit_property_contracts';
export const MAX_PROPERTY_PROPOSALS_PER_SUBMISSION = 8;
export const MAX_PROPERTY_PROPOSALS_PER_ROUND = 32;

/** Provider-facing hints share the validator's ceilings; runtime parsing
 * additionally enforces UTF-8 bytes, exact keys and safe paths. */
export const PROPERTY_CONTRACTS_INPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['proposals'],
  properties: {
    proposals: {
      type: 'array', minItems: 1, maxItems: MAX_PROPERTY_PROPOSALS_PER_SUBMISSION,
      items: {
        type: 'object', additionalProperties: false,
        required: ['requirementRef', 'invariant', 'inputDomain', 'invalidInputBehavior', 'targetPackageDir', 'adapterId', 'testArtifactRefs', 'establishes', 'doesNotEstablish'],
        properties: {
          requirementRef: { type: 'string', minLength: 1, maxLength: PROPERTY_PROPOSAL_LIMITS.requirementRef },
          invariant: { type: 'string', minLength: 1, maxLength: PROPERTY_PROPOSAL_LIMITS.invariant },
          inputDomain: { type: 'string', minLength: 1, maxLength: PROPERTY_PROPOSAL_LIMITS.inputDomain },
          invalidInputBehavior: { type: 'string', minLength: 1, maxLength: PROPERTY_PROPOSAL_LIMITS.invalidInputBehavior },
          targetPackageDir: { type: 'string', minLength: 1, maxLength: PROPERTY_PROPOSAL_LIMITS.targetPackageDir },
          adapterId: { type: 'string', minLength: 1, maxLength: PROPERTY_PROPOSAL_LIMITS.adapterId },
          testArtifactRefs: {
            type: 'array', minItems: 1, maxItems: PROPERTY_PROPOSAL_LIMITS.maxArtifactRefs,
            items: {
              type: 'object', additionalProperties: false, required: ['path', 'sha256'],
              properties: {
                path: { type: 'string', minLength: 1, maxLength: PROPERTY_PROPOSAL_LIMITS.artifactPath },
                sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              },
            },
          },
          establishes: { type: 'string', minLength: 1, maxLength: PROPERTY_PROPOSAL_LIMITS.establishes },
          doesNotEstablish: { type: 'string', minLength: 1, maxLength: PROPERTY_PROPOSAL_LIMITS.doesNotEstablish },
        },
      },
    },
  },
};

/** Bounded lead-facing guidance rendered into the review prompt. */
export function renderPropertyContractsGuidance(): string {
  return [
    'PROPERTY CONTRACT PROPOSALS (optional): when a review finding has a trustworthy executable oracle, you may attach a property-contract proposal via perkins_submit_property_contracts.',
    'Each proposal names the requirement reference, intended invariant, input domain, invalid-input behavior, target package, adapter id, test artifact references with sha256, and what the test does and does not establish.',
    'Use ordinary deterministic regressions when one example suffices; keep source-grounded qualitative findings for concerns without a trustworthy executable oracle — do not force every finding into a property.',
    'Proposals are untrusted input the HOST validates and may later qualify and execute in restricted environments; your proposal alone is never evidence that any test ran, and no proposal authorizes merge, execution or dependency installation.',
  ].join('\n');
}

/** Strict parse of the tool submission: an object with exactly a bounded
 * `proposals` array of PropertyProposal payloads. Every entry is validated
 * by the shared proposal validator; the first violation rejects the whole
 * submission with its actionable message. */
export function parsePropertyContractsSubmission(input: unknown): readonly PropertyProposal[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new PropertyProposalValidationError('perkins_submit_property_contracts input must be an object');
  }
  const value = input as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.join('\0') !== 'proposals') {
    throw new PropertyProposalValidationError('perkins_submit_property_contracts input keys do not match the required schema (exactly "proposals")');
  }
  if (!Array.isArray(value['proposals'])) {
    throw new PropertyProposalValidationError('proposals must be an array');
  }
  if (value['proposals'].length === 0) {
    throw new PropertyProposalValidationError('proposals must contain at least one proposal (an empty list is not a submission)');
  }
  if (value['proposals'].length > MAX_PROPERTY_PROPOSALS_PER_SUBMISSION) {
    throw new PropertyProposalValidationError(`proposals exceed ${MAX_PROPERTY_PROPOSALS_PER_SUBMISSION} entries per submission`);
  }
  return value['proposals'].map((entry, index) => {
    try {
      return parsePropertyProposal(entry);
    } catch (error) {
      if (error instanceof PropertyProposalValidationError) {
        throw new PropertyProposalValidationError(`proposals[${index}]: ${error.message}`);
      }
      throw error;
    }
  });
}

/** The durable record a submission becomes: untrusted-input marking is
 * structural — there is no field a proposal can set that turns this into
 * execution evidence. */
export interface RecordedPropertyProposals {
  readonly schemaVersion: 1;
  readonly trust: 'untrusted-reviewer-input';
  readonly count: number;
  readonly proposals: readonly PropertyProposal[];
}

export function recordPropertyProposals(proposals: readonly PropertyProposal[]): RecordedPropertyProposals {
  const snapshot = Object.freeze(parsePropertyContractsSubmission({ proposals }).map((proposal) => Object.freeze({
    ...proposal,
    testArtifactRefs: Object.freeze(proposal.testArtifactRefs.map((ref) => Object.freeze({ ...ref }))),
  })));
  return Object.freeze({
    schemaVersion: 1,
    trust: 'untrusted-reviewer-input',
    count: snapshot.length,
    proposals: snapshot,
  });
}
