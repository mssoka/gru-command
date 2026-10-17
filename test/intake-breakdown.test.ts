import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHITECTURE_POLICY, IntakeApprovalService } from '../src/intake/approval.js';
import { PipelineService } from '../src/dispatch/pipeline.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { IntakeService } from '../src/intake/service.js';
import { validatePlan } from '../src/intake/planner.js';
import { canonical, digest, type Proposal } from '../src/intake/types.js';
import { ARCHITECTURE, EPIC, TICKETS } from './helpers/bmad-epic.js';

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function epicFolder(files: Readonly<Record<string, string>> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gc-breakdown-')));
  roots.push(root);
  const repo = join(root, 'workspace', 'shop');
  const dataDir = join(root, 'private-home');
  mkdirSync(join(dataDir, 'uploads'), { recursive: true, mode: 0o700 });
  execFileSync('git', ['init', '-q', repo]);
  const contents = { 'epic-cart/epic-cart.md': EPIC, 'epic-cart/tickets.toml': TICKETS, 'architecture-checkout/architecture-checkout.md': ARCHITECTURE, ...files };
  for (const [path, text] of Object.entries(contents)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const service = new IntakeService({ dataDir, workspaceRoot: join(root, 'workspace'), uploadsDir: join(dataDir, 'uploads'), managedRepos: () => [repo] });
  const source = (supporting: readonly string[] = ['epic-cart/tickets.toml', 'architecture-checkout/architecture-checkout.md']) =>
    ({ kind: 'bmad' as const, document: { path: 'epic-cart/epic-cart.md' }, supporting: supporting.map((path) => ({ path })) });
  return { root, repo, dataDir, service, source };
}
const quoteOf = (proposal: Proposal, snapshotId: string, start: number, end: number) => proposal.snapshots.find(({ id }) => id === snapshotId)!.text.slice(start, end);

describe('BMAD v7 epic folder intake (#429)', () => {
  it('previews one heist per tickets.toml entry in table order, with merged dependencies and exact traces; preview creates no work', async () => {
    const h = epicFolder();
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    expect(proposal.executable).toBe(false);
    expect(proposal.gaps).toEqual([]);
    expect(proposal.snapshots.map(({ locator }) => locator)).toEqual(['epic-cart/epic-cart.md', 'epic-cart/tickets.toml', 'architecture-checkout/architecture-checkout.md']);
    const [one, two, three] = proposal.plan.heists;
    expect(proposal.plan.heists.map(({ id, title }) => [id, title])).toEqual([
      ['entry-1', 'Cart service scaffold'], ['entry-2', 'Apply and refuse discount codes'], ['entry-3', 'Shown total equals charged total'],
    ]);
    expect(one!.dependencies).toEqual([]);
    expect(two!.dependencies.map(({ id, milestone }) => [id, milestone])).toEqual([['entry-1', 'merged']]);
    expect(three!.dependencies.map(({ id, milestone }) => [id, milestone])).toEqual([['entry-2', 'merged']]);
    for (const heist of proposal.plan.heists) expect(heist.milestones).toEqual(['delivered', 'merged']);
    // The entry's own table and the epic line its covers id names, verbatim.
    expect(two!.acceptance[0]!.text).toBe('A valid code lowers the total; an expired one is refused with its reason.');
    expect(two!.acceptance[0]!.clarification).toBe(false);
    const quotes = two!.acceptance[0]!.traces.map(({ quote }) => quote);
    expect(quotes[0]).toMatch(/^\[\[entry\]\]\nid = 2\n[\s\S]*risk = "medium"$/u);
    expect(quotes[1]).toBe('- R2: Apply one discount code; refused codes say why.');
    for (const heist of proposal.plan.heists) {
      for (const statement of [heist.goal, ...heist.scope, ...heist.acceptance, ...heist.verification, ...heist.dependencies, heist.splitMergeRationale]) {
        for (const trace of statement.traces) expect(quoteOf(proposal, trace.snapshotId, trace.start, trace.end)).toBe(trace.quote);
      }
    }
    expect(proposal.plan.unmapped).toEqual([]);
    expect(proposal.plan.questions).toEqual([]);
    expect(validatePlan(proposal.plan, proposal)).toEqual(proposal.plan);
    // Human steps, unknowns and prerequisites outside the epic stay open.
    expect(one!.unresolvedQuestions).toEqual([expect.stringMatching(/^Entry 1 has a human step \(hitl\)/u)]);
    expect(two!.unresolvedQuestions).toEqual(['Entry 2 has an unknown to settle before it starts: Can the discount engine answer within 300 ms?']);
    expect(three!.unresolvedQuestions).toEqual([expect.stringMatching(/^Entry 3 is after "1\.3", outside this breakdown; GC cannot see that work/u)]);
    // Context and the binding architecture are mapped once, on the first entry.
    expect(one!.acceptance.map(({ text }) => text.slice(0, 40))).toEqual(['A shopper adds one item and sees it in t', 'Epic context for the whole breakdown, ma', 'Binding architecture for every entry, ma']);
    expect(two!.acceptance).toHaveLength(1);
    expect(existsSync(join(h.dataDir, 'projects', proposal.projectKey, 'jobs'))).toBe(false);
  });

  const gapCase = async (tickets: string, code: string, detail: RegExp): Promise<void> => {
    const h = epicFolder({ 'epic-cart/tickets.toml': tickets });
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    expect(proposal.gaps).toEqual([{ code, locator: 'epic-cart/tickets.toml', question: expect.stringMatching(detail) }]);
    expect(proposal.plan.heists.map(({ id }) => id)).toEqual(['heist-1']);
    expect(proposal.plan.heists[0]!.acceptance.every(({ clarification }) => clarification)).toBe(true);
    expect(proposal.plan.questions).toContain(proposal.gaps[0]!.question);
  };
  it('names malformed TOML as a visible gap and invents no heist from it', () => gapCase('[[entry]\nid = 1\n', 'intake_malformed_breakdown', /tickets\.toml is not valid TOML: Invalid TOML document/u));
  it('names an unknown after id as a visible gap and invents no heist from it', () => gapCase(TICKETS.replace('after = [1]', 'after = [9]'), 'intake_breakdown_prerequisite', /entry 2 is after 9, which names no entry in this breakdown/u));
  it('names a cycle as a visible gap and invents no heist from it', () => gapCase(TICKETS.replace('after = []', 'after = [3]'), 'intake_breakdown_cycle', /in a cycle: 1 → 3 → 2 → 1/u));
  it('names a self-reference as a visible gap and invents no heist from it', () => gapCase(TICKETS.replace('after = []', 'after = [1]'), 'intake_breakdown_cycle', /in a cycle: 1 → 1/u));
  it('names duplicate ids as a visible gap and invents no heist from it', () => gapCase(TICKETS.replace('id = 3', 'id = 2'), 'intake_malformed_breakdown', /two entries with id 2/u));
  it('names an initiative breakdown as a visible gap and invents no heist from it', () => gapCase(`${TICKETS}\n[[epic]]\nid = 1\nslug = "epic-cart"\n`, 'intake_malformed_breakdown', /\[\[epic\]\] tables, an initiative breakdown/u));
  it('names an entry without a title as a visible gap and invents no heist from it', () => gapCase(TICKETS.replace('title = "Cart service scaffold"\n', ''), 'intake_malformed_breakdown', /entry 1 needs a title/u));
  it('names an unknown type as a visible gap and invents no heist from it', () => gapCase(TICKETS.replace('type = "story"', 'type = "chore"'), 'intake_malformed_breakdown', /entry 1 type "chore" is not one of story, spike, bug/u));
  it('names no entries as a visible gap and invents no heist from it', () => gapCase('# planned later\n', 'intake_malformed_breakdown', /has no \[\[entry\]\] tables/u));

  it('refuses a second breakdown, other TOML and a misnamed breakdown by name', async () => {
    const h = epicFolder({ 'epic-cart/other.toml': TICKETS, 'other/tickets.toml': TICKETS });
    const two = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source(['epic-cart/tickets.toml', 'other/tickets.toml', 'architecture-checkout/architecture-checkout.md']) });
    expect(two.gaps).toEqual([expect.objectContaining({ code: 'intake_malformed_breakdown', question: expect.stringMatching(/supply exactly one tickets\.toml/u) })]);
    expect(two.plan.heists.map(({ id }) => id)).toEqual(['heist-1']);
    const other = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', source: h.source(['epic-cart/other.toml']) });
    expect(other.gaps).toContainEqual({ code: 'intake_document_type', locator: 'epic-cart/other.toml', question: expect.stringMatching(/BMAD source data requires \.md or the epic's tickets\.toml/u) });
    const spec = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r3', source: { kind: 'spec', document: { path: 'epic-cart/tickets.toml' } } });
    expect(spec.gaps).toEqual([expect.objectContaining({ code: 'intake_document_type' })]);
  });

  it('a referenced architecture that is not supplied is a gap; supplied, it binds every heist through the first entry', async () => {
    const h = epicFolder();
    const missing = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source(['epic-cart/tickets.toml']) });
    expect(missing.gaps).toEqual([{ code: 'intake_missing_architecture', locator: 'architecture-checkout.md', question: expect.stringMatching(/^epic-cart\/epic-cart\.md and epic-cart\/tickets\.toml reference the architecture document architecture-checkout\.md, which is not captured/u) }]);
    // Named by the breakdown's `references` alone, it is still required.
    const fromTickets = epicFolder({ 'epic-cart/epic-cart.md': EPIC.replace('- constraint — architecture-checkout/architecture-checkout.md, AD-1\n', '') });
    const viaTickets = await fromTickets.service.preview({ repoPath: fromTickets.repo, intakeId: 'cart', requestId: 'r1', source: fromTickets.source(['epic-cart/tickets.toml']) });
    expect(viaTickets.gaps).toEqual([expect.objectContaining({ code: 'intake_missing_architecture', locator: 'architecture-checkout.md', question: expect.stringMatching(/^epic-cart\/tickets\.toml references/u) })]);
    const bound = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', source: h.source() });
    const architecture = bound.plan.heists[0]!.acceptance[2]!;
    expect(architecture.text).toMatch(/^Binding architecture for every entry, mapped here once: build within architecture-checkout\/architecture-checkout\.md/u);
    expect(architecture.requirementIds).toEqual(bound.requirements.filter(({ trace }) => trace.snapshotId === 's3').map(({ id }) => id));
  });

  it('a recorded source conflict stays open on the entries whose covers it names, else on the whole plan', async () => {
    const h = epicFolder({ 'epic-cart/epic-cart.md': EPIC.replace('- Decision: codes', '- Source conflict: R2 — the epic allows one code vs AD-1 which allows stacking.\n- Source conflict: tax rounding — the PRD and the code disagree.\n- Decision: codes') });
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    expect(proposal.plan.heists[1]!.unresolvedQuestions).toContain('Settle the recorded source conflict before admitting it: - Source conflict: R2 — the epic allows one code vs AD-1 which allows stacking.');
    expect(proposal.plan.heists[0]!.unresolvedQuestions.some((question) => question.includes('Source conflict'))).toBe(false);
    expect(proposal.plan.questions).toEqual(['Settle the recorded source conflict before admitting it: - Source conflict: tax rounding — the PRD and the code disagree.']);
  });

  it('an uncovered requirement line and a covers id the epic lacks stay visible', async () => {
    const h = epicFolder({ 'epic-cart/tickets.toml': TICKETS.replace('covers = ["R3"]', 'covers = ["R9"]') });
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    expect(proposal.plan.unmapped).toEqual([{ requirementId: expect.any(String), question: 'epic-cart/epic-cart.md: "- R3: The total shown is the total charged, before tax." is a requirement no entry covers. Place it in an entry, or confirm it is out of scope.' }]);
    expect(proposal.plan.heists[2]!.unresolvedQuestions).toContain('Entry 3 covers "R9", but no captured epic line starts with that id. Correct covers, or supply the epic that defines it.');
  });
});

describe('approval of a v7 breakdown (#429)', () => {
  function approvalFixture(tickets: string, files: Readonly<Record<string, string>> = {}) {
    const h = epicFolder({ 'epic-cart/tickets.toml': tickets, ...files });
    const db = new LedgerDb(join(h.root, 'ledger'));
    const ledger = new LedgerApi(db.handle);
    const dispatch = vi.fn(async () => ({ settled: Promise.resolve() }));
    const pipeline = new PipelineService({ ledger, dispatch: { dispatch }, capacity: () => ({ capacity: 1, occupied: 1, available: 0, queued: 0 }) });
    const approval = new IntakeApprovalService({ intake: h.service, ledger, pipeline });
    cleanups.push(() => { pipeline.dispose(); db.close(); });
    return { ...h, ledger, pipeline, approval, dispatch };
  }
  const settled = TICKETS.replace('hitl = true\n', '').replace('unknown = "Can the discount engine answer within 300 ms?"\n', '');

  it('admits only the selected heists, each briefing binding the captured architecture; prerequisites are selected together', async () => {
    const h = approvalFixture(settled);
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    expect(proposal.plan.heists.map(({ unresolvedQuestions }) => unresolvedQuestions.length)).toEqual([0, 0, 1]);
    const decision = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: proposal.revisionId, expectedToken: null };
    const token = h.approval.review(decision).review!.token;
    expect(() => h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-2'] })).toThrow(expect.objectContaining({ code: 'intake_dependency_selection' }));
    expect(() => h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-1', 'entry-2', 'entry-3'] })).toThrow(expect.objectContaining({ code: 'intake_incomplete_plan' }));
    const readback = h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-1', 'entry-2'] });
    expect(readback.accepted.map(({ heistId }) => heistId)).toEqual(['entry-1', 'entry-2']);
    const [first, second] = readback.review!.entries;
    expect(second!.prerequisites).toEqual([{ id: first!.id, milestone: 'merged' }]);
    for (const entry of readback.review!.entries) {
      expect(h.pipeline.entry(entry.id)).not.toBeNull();
      const briefing = JSON.parse(entry.briefing) as { architecture: { policy: string; documents: unknown[] } };
      expect(briefing.architecture.documents).toEqual([{ snapshotId: 's3', locator: 'architecture-checkout/architecture-checkout.md', sha256: proposal.snapshots[2]!.sha256 }]);
      expect(briefing.architecture.policy).toBe(ARCHITECTURE_POLICY);
    }
    expect(h.ledger.getJob(first!.id)).toBeNull();
    // A retry of the identical approval converges on the same entries.
    expect(h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-1', 'entry-2'] }).review!.entries).toEqual(readback.review!.entries);
  });

  it('an approval retry enqueues the frozen recorded entries, even when this build renders briefings differently', async () => {
    const h = approvalFixture(settled);
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    const decision = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: proposal.revisionId, expectedToken: null };
    const token = h.approval.review(decision).review!.token;
    // An approval frozen by an earlier build whose enqueue was interrupted.
    const entryId = `intake-${digest(canonical([proposal.projectKey, 'cart', proposal.revisionId, 'entry-1']))}`;
    const body = { ...decision, previousToken: token, status: 'approved' as const, selected: ['entry-1'], entries: [{ id: entryId, requestId: entryId, repoPath: h.repo, title: 'Cart service scaffold', briefing: 'briefing bytes frozen by an earlier build', prerequisites: [] }] };
    const { expectedToken: _expected, ...frozen } = body;
    h.ledger.recordIntakeReview({ ...frozen, token: digest(canonical(frozen)) });
    const readback = h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-1'] });
    expect(readback.accepted.map(({ entryId: id }) => id)).toEqual([entryId]);
    expect(h.pipeline.entry(entryId)!.briefing).toBe('briefing bytes frozen by an earlier build');
  });

  it('a briefing without captured architecture keeps the earlier shape', async () => {
    const h = approvalFixture(settled, { 'epic-cart/epic-cart.md': EPIC.replace('- constraint — architecture-checkout/architecture-checkout.md, AD-1\n', ''), 'epic-cart/tickets.toml': settled.replace('references = ["architecture-checkout/architecture-checkout.md#ad-1"]\n', '') });
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source(['epic-cart/tickets.toml']) });
    const decision = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: proposal.revisionId, expectedToken: null };
    const token = h.approval.review(decision).review!.token;
    const readback = h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-1'] });
    expect(Object.keys(JSON.parse(readback.review!.entries[0]!.briefing) as object).sort()).toEqual(['approval', 'heist', 'provenance', 'sourcePolicy']);
  });

  it('a twelve-entry chained epic with a sizable architecture approves in one decision', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => index + 1);
    const epic = EPIC.replace(/- R1:[\s\S]*?before tax\.\n/u, ids.map((id) => `- R${id}: Requirement ${id} of the cart, described in a full sentence of realistic length for an epic line.\n`).join(''));
    const tickets = ids.map((id) => `[[entry]]\nid = ${id}\ntype = "story"\ntitle = "Slice ${id}"\ndescription = "Delivers requirement ${id} through the cart service, its API and the store, with tests."\nverify = "The cart check for requirement ${id} passes against the running service."\ncovers = ["R${id}"]\nafter = [${id === 1 ? '' : id - 1}]\nrisk = "medium"\n`).join('\n');
    const architecture = `${ARCHITECTURE}${Array.from({ length: 170 }, (_, index) => `\n### AD-${index + 2} — Decision ${index + 2}\n\n- **Binds:** cart\n- **Rule:** The cart follows rule ${index + 2}, written out as an enforceable sentence a builder can check in review.\n`).join('')}`;
    const h = approvalFixture(tickets, { 'epic-cart/epic-cart.md': epic, 'architecture-checkout/architecture-checkout.md': architecture });
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    expect(Buffer.byteLength(architecture)).toBeGreaterThan(20_000);
    expect(proposal.plan.heists).toHaveLength(12);
    const decision = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: proposal.revisionId, expectedToken: null };
    const token = h.approval.review(decision).review!.token;
    const readback = h.approval.approve({ ...decision, expectedToken: token, selected: ids.map((id) => `entry-${id}`) });
    expect(readback.accepted).toHaveLength(12);
  });
});
