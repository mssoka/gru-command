import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeReviewInputs, writeReviewArtifact, type FrozenReview } from '../src/dispatch/perkins-review/artifacts.js';
import { PerkinsWholeReview, type PerkinsWholeResult } from '../src/dispatch/perkins-review/whole.js';
import type { NativeAgentTool } from '../src/runtime/types.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';
import {
  MAX_PROPERTY_PROPOSALS_PER_SUBMISSION,
  parsePropertyContractsSubmission,
  PROPERTY_CONTRACTS_INPUT_SCHEMA,
  PROPERTY_CONTRACTS_TOOL_NAME,
  recordPropertyProposals,
  renderPropertyContractsGuidance,
} from '../src/dispatch/perkins-review/property-contracts.js';
import { PROPERTY_PROPOSAL_LIMITS, PropertyProposalValidationError } from '../src/property/proposal.js';
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

const repos: FixtureRepo[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Offline model double; real production lead tools, frozen Git input,
 * write-once artifacts and terminal validator. No provider or executor. */
async function runLeadProbe(
  beforeSubmission: (tool: NativeAgentTool, review: FrozenReview) => Promise<void>,
  afterSubmission?: (tool: NativeAgentTool) => Promise<void>,
): Promise<{ readonly review: FrozenReview; readonly result: PerkinsWholeResult }> {
  const repo = makeFixtureRepo('property-perkins');
  repos.push(repo);
  const base = repo.head();
  repo.git(['checkout', '-b', 'feature/property-review']);
  const target = repo.commitFile('src/main.ts', 'export const answer = 43;\n');
  const root = mkdtempSync(join(tmpdir(), 'property-perkins-'));
  roots.push(root);
  const sessions = join(root, 'sessions');
  mkdirSync(sessions);
  const review = freezeReviewInputs({
    roundId: 'property-round', repoPath: repo.path, artifactRoot: join(root, 'artifacts'),
    baseRef: base, targetRef: target, movementRef: 'feature/property-review', spec: 'answer is 43',
  });
  const fake = fakeWholeSpawner(sessions, { specialists: [], childAnswer: () => '[]' });
  const engine = new PerkinsWholeReview({
    policy: loadPerkinsPolicy(),
    spawner: async (role, options) => {
      const handle = await fake.spawner(role, options);
      const leadPolicy = options?.reviewLead;
      if (leadPolicy === undefined) return handle;
      const tool = leadPolicy.nativeTools.find((entry) => entry.name === PROPERTY_CONTRACTS_TOOL_NAME);
      if (tool === undefined) throw new Error('production Perkins lead is missing the property-contract tool');
      expect(leadPolicy.systemPrompt).toContain(renderPropertyContractsGuidance());
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false, required: ['proposals'] });
      return {
        ...handle,
        prompt: async (text, promptOptions) => {
          await beforeSubmission(tool, review);
          await handle.prompt(text, promptOptions);
          await afterSubmission?.(tool);
        },
      };
    },
  });
  const result = await engine.run({
    roundId: 'property-round', roundNumber: 1, frozenReview: review,
    movementRef: 'feature/property-review', noSpec: false,
  });
  return { review, result };
}

function readLeadReceipt(review: FrozenReview): Record<string, unknown> {
  return JSON.parse(readFileSync(join(review.directory, 'lead/receipt.json'), 'utf8')) as Record<string, unknown>;
}

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

  it('owns an immutable snapshot rather than retaining caller-mutable proposal arrays', () => {
    const parsed = [...parsePropertyContractsSubmission({ proposals: [validProposal] })];
    const recorded = recordPropertyProposals(parsed);
    parsed.pop();
    expect(recorded.proposals).toHaveLength(1);
    expect(Object.isFrozen(recorded)).toBe(true);
    expect(Object.isFrozen(recorded.proposals)).toBe(true);
    expect(Object.isFrozen(recorded.proposals[0])).toBe(true);
    expect(Object.isFrozen(recorded.proposals[0]!.testArtifactRefs[0])).toBe(true);
  });

  it('records proposals through the actual lead tool without replacing findings or verdict authority', async () => {
    const { review, result } = await runLeadProbe(async (tool) => {
      const recorded = await tool.execute({ proposals: [validProposal] });
      expect(JSON.parse(recorded.text)).toMatchObject({ recorded: 1, trust: 'untrusted-reviewer-input' });
      expect(recorded.details).toMatchObject({ evidenceClass: 'untrusted-reviewer-input' });
    });
    const stored = JSON.parse(readFileSync(join(review.directory, 'property/proposals-1.json'), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ schemaVersion: 1, trust: 'untrusted-reviewer-input', count: 1, proposals: [validProposal] });
    expect(readLeadReceipt(review)['propertyContractProposals']).toBe(1);
    expect(result.findings).toEqual([]);
    // The existing lead terminal submission approves this clean fixture;
    // merely submitting a proposal has no independent verdict authority.
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
  });

  it('rejects invalid and command-bearing payloads without storing them or consuming proposal capacity', async () => {
    const { review } = await runLeadProbe(async (tool) => {
      await expect(tool.execute({ proposals: [validProposal], command: 'npm install' })).rejects.toThrow(/exactly "proposals"/);
      await expect(tool.execute({ proposals: [{ ...validProposal, targetPackageDir: '../outside' }] })).rejects.toThrow(/safe target package/);
      await tool.execute({ proposals: [validProposal] });
    });
    expect(readdirSync(join(review.directory, 'property'))).toEqual(['proposals-1.json']);
    expect(readLeadReceipt(review)['propertyContractProposals']).toBe(1);
  });

  it('enforces a bounded round-wide proposal budget across repeated tool calls', async () => {
    const { review } = await runLeadProbe(async (tool) => {
      for (let call = 0; call < 4; call += 1) {
        await tool.execute({ proposals: Array.from({ length: MAX_PROPERTY_PROPOSALS_PER_SUBMISSION }, () => validProposal) });
      }
      await expect(tool.execute({ proposals: [validProposal] })).rejects.toThrow(/round.*32/i);
    });
    expect(readLeadReceipt(review)['propertyContractProposals']).toBe(32);
    expect(readdirSync(join(review.directory, 'property'))).toHaveLength(4);
  });

  it('refuses late proposals after the terminal review submission is accepted', async () => {
    const { review } = await runLeadProbe(
      async (tool) => { await tool.execute({ proposals: [validProposal] }); },
      async (tool) => { await expect(tool.execute({ proposals: [validProposal] })).rejects.toThrow(/closed/); },
    );
    expect(readLeadReceipt(review)['propertyContractProposals']).toBe(1);
    expect(readdirSync(join(review.directory, 'property'))).toHaveLength(1);
  });

  it('does not report a proposal as recorded when durable artifact persistence fails', async () => {
    const { review } = await runLeadProbe(async (tool, frozen) => {
      writeReviewArtifact(frozen, 'property/proposals-1.json', { occupied: true });
      await expect(tool.execute({ proposals: [validProposal] })).rejects.toThrow();
    });
    expect(readLeadReceipt(review)['propertyContractProposals']).toBe(0);
  });

  it('uses the shared proposal ceilings in the provider-facing tool schema', () => {
    const fields = PROPERTY_CONTRACTS_INPUT_SCHEMA.properties.proposals.items.properties;
    expect(fields.adapterId.maxLength).toBe(PROPERTY_PROPOSAL_LIMITS.adapterId);
    expect(fields.testArtifactRefs.maxItems).toBe(PROPERTY_PROPOSAL_LIMITS.maxArtifactRefs);
    expect(fields.testArtifactRefs.items.properties.path.maxLength).toBe(PROPERTY_PROPOSAL_LIMITS.artifactPath);
  });

  it('keeps the tool name in the product-native naming family', () => {
    expect(PROPERTY_CONTRACTS_TOOL_NAME).toMatch(/^[a-z][a-z0-9_]{1,63}$/u);
    expect(PROPERTY_CONTRACTS_TOOL_NAME.startsWith('perkins_')).toBe(true);
  });
});
