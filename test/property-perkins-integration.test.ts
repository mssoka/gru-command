import { describe, expect, it } from 'vitest';
import {
  MAX_PROPERTY_PROPOSALS_PER_SUBMISSION,
  parsePropertyContractsSubmission,
  PROPERTY_CONTRACTS_TOOL_NAME,
  recordPropertyProposals,
  renderPropertyContractsGuidance,
} from '../src/dispatch/perkins-review/property-contracts.js';
import { PropertyProposalValidationError } from '../src/property/proposal.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';

/**
 * GH350 Perkins production wiring (issue §3): structured requirement-grounded
 * property-contract proposals, kept strictly separate from host execution
 * receipts. Proposals are UNTRUSTED reviewer input — recording one is never
 * evidence that a test ran, and never authorizes anything.
 */

const validProposal = {
  requirementRef: 'GH350 §3 requirement-grounded findings',
  invariant: 'the ratio calculator returns a finite nonnegative float equal to numerator/denominator for denominator != 0',
  inputDomain: 'integer numerator in [-1000, 1000]; integer denominator in [1, 1000]',
  invalidInputBehavior: 'denominator 0 throws RatioDomainError before any division',
  targetPackageDir: '.',
  adapterId: 'vitest-fast-check',
  testArtifactRefs: [{ path: 'test/property/ratio.test.ts', sha256: 'a'.repeat(64) }],
  establishes: 'the ratio invariant holds for generated inputs in the domain',
  doesNotEstablish: 'performance characteristics or non-ratio calculator behavior',
};

describe('GH350 Perkins property-contract proposal wiring', () => {
  it('parses a valid multi-proposal submission', () => {
    const parsed = parsePropertyContractsSubmission({ proposals: [validProposal, { ...validProposal, requirementRef: 'second-ref' }] });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.adapterId).toBe('vitest-fast-check');
    expect(parsed[1]!.requirementRef).toBe('second-ref');
  });

  it('rejects non-object submissions and wrong key sets', () => {
    expect(() => parsePropertyContractsSubmission([])).toThrow(PropertyProposalValidationError);
    expect(() => parsePropertyContractsSubmission({ extra: true })).toThrow(/exactly "proposals"/);
  });

  it('rejects empty and oversized proposal arrays', () => {
    expect(() => parsePropertyContractsSubmission({ proposals: [] })).toThrow(/at least one proposal/);
    const tooMany = Array.from({ length: MAX_PROPERTY_PROPOSALS_PER_SUBMISSION + 1 }, () => validProposal);
    expect(() => parsePropertyContractsSubmission({ proposals: tooMany })).toThrow(RegExp(`${MAX_PROPERTY_PROPOSALS_PER_SUBMISSION} entries`));
  });

  it('rejects an invalid entry with its actionable indexed message', () => {
    const badSha = { ...validProposal, testArtifactRefs: [{ path: 'x.ts', sha256: 'not-hex' }] };
    expect(() => parsePropertyContractsSubmission({ proposals: [validProposal, badSha] })).toThrow(/proposals\[1\]:/);
  });

  it('records proposals as structurally untrusted input with no evidence fields', () => {
    const recorded = recordPropertyProposals(parsePropertyContractsSubmission({ proposals: [validProposal] }));
    expect(recorded.trust).toBe('untrusted-reviewer-input');
    expect(recorded.count).toBe(1);
    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toContain('"outcome"');
    expect(serialized).not.toContain('"outputs"');
    expect(serialized).not.toContain('"receipt"');
  });

  it('renders lead guidance naming the tool, the separation and the no-authorization rule', () => {
    const guidance = renderPropertyContractsGuidance();
    expect(guidance).toContain(PROPERTY_CONTRACTS_TOOL_NAME);
    expect(guidance).toContain('never evidence that any test ran');
    expect(guidance).toContain('no proposal authorizes merge, execution or dependency installation');
    expect(guidance).toContain('do not force every finding into a property');
  });

  it('loads the refreshed pinned policy carrying the GH350 lead-workflow guidance', () => {
    const policy = loadPerkinsPolicy();
    expect(policy.portableContract.leadWorkflow).toContain('perkins_submit_property_contracts');
    expect(policy.portableContract.leadWorkflow).toContain('separately from host-owned execution receipts');
    expect(policy.hostReplacements.some((entry) => entry.includes('untrusted input recorded separately from host execution receipts'))).toBe(true);
  });

  it('keeps the tool name in the product-native naming family', () => {
    expect(PROPERTY_CONTRACTS_TOOL_NAME).toMatch(/^[a-z][a-z0-9_]{1,63}$/u);
    expect(PROPERTY_CONTRACTS_TOOL_NAME.startsWith('perkins_')).toBe(true);
  });
});
