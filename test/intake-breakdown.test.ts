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
import { architectureSnapshots } from '../src/intake/breakdown.js';
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
  it('names a mistyped hitl as a visible gap and invents no heist from it', () => gapCase(TICKETS.replace('hitl = true', 'hitl = "yes"'), 'intake_malformed_breakdown', /entry 1 hitl must be true or false/u));
  it('names a mistyped description as a visible gap and invents no heist from it', () => gapCase(TICKETS.replace(/description = "Stands up[^\n]*/u, 'description = 7'), 'intake_malformed_breakdown', /entry 1 description must be a string without NUL characters/u));
  it('names a NUL in a field as a visible gap and invents no heist from it', () => gapCase(TICKETS.replace('description = "Stands up', 'description = "Stands\\u0000up'), 'intake_malformed_breakdown', /entry 1 description must be a string without NUL characters/u));
  it('names an entry table it cannot trace exactly as a visible gap and invents no heist from it', () => gapCase(TICKETS.replace(/description = "Stands up[^\n]*/u, 'description = """\nStands up the cart service.\n[notes]\n"""'), 'intake_malformed_breakdown', /each \[\[entry\]\] table must start at its own \[\[entry\]\] header line/u));

  it('maps a breakdown saved with CRLF line endings exactly', async () => {
    const h = epicFolder({ 'epic-cart/tickets.toml': TICKETS.replace(/\n/gu, '\r\n') });
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    expect(proposal.gaps).toEqual([]);
    expect(proposal.plan.heists.map(({ id }) => id)).toEqual(['entry-1', 'entry-2', 'entry-3']);
    expect(proposal.plan.heists[1]!.acceptance[0]!.traces[0]!.quote).toMatch(/^\[\[entry\]\]\r\nid = 2\r\n[\s\S]*risk = "medium"\r$/u);
    expect(proposal.plan.unmapped).toEqual([]);
  });

  it("keeps spikes, checkpoints, refine requests, a missing verify and a quoted sibling id as that heist's questions", async () => {
    const tickets = TICKETS.replace('id = 1\ntype = "story"', 'id = 1\ntype = "spike"\nplan_checkpoint = true\nrefine = true')
      .replace('verify = "A valid code lowers the total; an expired one is refused with its reason."\n', '')
      .replace('after = [2, "1.3"]', 'after = ["2"]');
    const h = epicFolder({ 'epic-cart/tickets.toml': tickets });
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    const [one, two, three] = proposal.plan.heists;
    expect(one!.unresolvedQuestions).toEqual([
      expect.stringMatching(/^Entry 1 has a human step \(hitl\)/u),
      'Entry 1 asks to be refined to full acceptance criteria (refine = true) before it starts. Write them into this heist before admitting it.',
      'Entry 1 is a spike: its result is an answer, not shipped code. Settle it, or confirm it runs as a pull-request heist, before admitting it.',
      "Entry 1 asks for a plan checkpoint (a person reviews the plan before work starts); GC has no such pause. Confirm the owner's PR review and merge cover it before admitting this heist.",
    ]);
    expect(two!.unresolvedQuestions).toContain('Entry 2 has no verify check.');
    expect(two!.acceptance[0]).toMatchObject({ text: 'Clarify how entry 2 is checked; the breakdown gives no verify.', clarification: true });
    expect(three!.dependencies).toEqual([]);
    expect(three!.unresolvedQuestions).toEqual(['Entry 3 is after "2": BMAD reads a quoted number as a tracker id, not entry 2 of this breakdown. Write it bare (after = [2]) if it means that entry, or confirm the tracker work is done, before admitting this heist.']);
  });

  it('covers ids name only their own requirement line, under any requirements heading, and fall back to the whole epic without one', async () => {
    const exact = epicFolder({ 'epic-cart/epic-cart.md': EPIC.replace('- R2: Apply', '- R1.1: Undo the last change.\n- R2: Apply') });
    const first = await exact.service.preview({ repoPath: exact.repo, intakeId: 'cart', requestId: 'r1', source: exact.source() });
    expect(first.plan.heists[0]!.acceptance[0]!.traces.slice(1).map(({ quote }) => quote)).toEqual(['- R1: Add, remove, and change quantity of any item; the total updates at once.']);
    expect(first.plan.unmapped.map(({ question }) => question)).toEqual(['epic-cart/epic-cart.md: "- R1.1: Undo the last change." is a requirement no entry covers. Place it in an entry, or confirm it is out of scope.']);
    const functional = epicFolder({ 'epic-cart/epic-cart.md': EPIC.replace('## Requirements', '## Functional Requirements') });
    const named = await functional.service.preview({ repoPath: functional.repo, intakeId: 'cart', requestId: 'r1', source: functional.source() });
    expect(named.plan.heists.map(({ unresolvedQuestions }) => unresolvedQuestions.filter((question) => question.includes('covers')))).toEqual([[], [], []]);
    expect(named.plan.unmapped).toEqual([]);
    const headless = epicFolder({ 'epic-cart/epic-cart.md': EPIC.replace('## Requirements\n', '') });
    const loose = await headless.service.preview({ repoPath: headless.repo, intakeId: 'cart', requestId: 'r1', source: headless.source() });
    expect(loose.plan.heists[0]!.acceptance[0]!.traces.slice(1).map(({ quote }) => quote)).toEqual(['- R1: Add, remove, and change quantity of any item; the total updates at once.']);
    // A covered line is the entry's own deliverable, never also filed as context.
    const context = loose.plan.heists[0]!.acceptance[1]!;
    expect(context.text).toMatch(/^Epic context for the whole breakdown/u);
    expect(context.requirementIds).not.toContain(loose.requirements.find(({ trace }) => trace.quote.startsWith('- R1'))!.id);
  });

  it('maps a v7 epic folder attached as service uploads', async () => {
    const h = epicFolder();
    const upload = (stamp: string, name: string, text: string): { uploadPath: string } => {
      const uploadPath = join(h.dataDir, 'uploads', `${stamp}-11111111-2222-3333-4444-555555555555-${name}`);
      writeFileSync(uploadPath, text);
      return { uploadPath };
    };
    const source = { kind: 'bmad' as const, document: upload('1791633600000', 'epic-cart.md', EPIC), supporting: [upload('1791633600001', 'tickets.toml', TICKETS), upload('1791633600002', 'architecture-checkout.md', ARCHITECTURE)] };
    const proposal = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source });
    expect(proposal.gaps).toEqual([]);
    expect(proposal.plan.heists.map(({ id }) => id)).toEqual(['entry-1', 'entry-2', 'entry-3']);
    expect(proposal.plan.heists[0]!.acceptance[2]!.text).toMatch(/^Binding architecture for every entry/u);
  });

  it('binds architecture for BMAD sources only, by spine frontmatter or file name, and never the primary document', async () => {
    const h = epicFolder({ 'spec.md': '# Spec\n\n## References\n\n- docs/architecture.md, to update with the new flow.\n' });
    const spec = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: { kind: 'spec', document: { path: 'spec.md' } } });
    expect(spec.gaps).toEqual([]);
    const frontmatter = epicFolder({
      'epic-cart/epic-cart.md': EPIC.replace('- constraint — architecture-checkout/architecture-checkout.md, AD-1\n', ''),
      'epic-cart/tickets.toml': TICKETS.replace('references = ["architecture-checkout/architecture-checkout.md#ad-1"]\n', ''),
      'design/spine-checkout.md': ARCHITECTURE,
    });
    const spine = await frontmatter.service.preview({ repoPath: frontmatter.repo, intakeId: 'cart', requestId: 'r1', source: frontmatter.source(['epic-cart/tickets.toml', 'design/spine-checkout.md']) });
    expect(spine.gaps).toEqual([]);
    expect(architectureSnapshots(spine).map(({ locator }) => locator)).toEqual(['design/spine-checkout.md']);
    const primary = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', source: { kind: 'bmad', document: { path: 'architecture-checkout/architecture-checkout.md' } } });
    expect(architectureSnapshots(primary)).toEqual([]);
    expect(primary.gaps).toEqual([]);
  });

  it('a breakdown must sit beside its epic and is never the primary document', async () => {
    const h = epicFolder({ 'other/tickets.toml': TICKETS });
    const elsewhere = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source(['other/tickets.toml', 'architecture-checkout/architecture-checkout.md']) });
    expect(elsewhere.gaps).toEqual([{ code: 'intake_malformed_breakdown', locator: 'other/tickets.toml', question: "other/tickets.toml is not in the epic's folder epic-cart; supply the tickets.toml that sits beside epic-cart/epic-cart.md. Nothing was mapped from the breakdown." }]);
    expect(elsewhere.plan.heists.map(({ id }) => id)).toEqual(['entry-1', 'entry-2', 'entry-3']);
    const alone = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', source: { kind: 'bmad', document: { path: 'epic-cart/tickets.toml' } } });
    expect(alone.gaps).toContainEqual(expect.objectContaining({ code: 'intake_malformed_breakdown', question: expect.stringMatching(/^Supply the epic's Markdown as the primary document/u) }));
  });

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
  function approvalFixture(tickets: string, files: Readonly<Record<string, string>> = {}, available = 0) {
    const h = epicFolder({ 'epic-cart/tickets.toml': tickets, ...files });
    const db = new LedgerDb(join(h.root, 'ledger'));
    const ledger = new LedgerApi(db.handle);
    const dispatch = vi.fn(async (input: { jobId: string; title: string; briefing: string }) => {
      ledger.addJob({ id: input.jobId, repo: 'shop', title: input.title, briefing: input.briefing });
      ledger.appendCustomEvent({ kind: 'job.minion-spawned', jobId: input.jobId, payload: {} });
      return { settled: Promise.resolve() };
    });
    const pipeline = new PipelineService({ ledger, dispatch: { dispatch }, capacity: () => ({ capacity: 1, occupied: 1 - available, available, queued: 0 }) });
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
    expect(h.dispatch).not.toHaveBeenCalled();
    // A retry of the identical approval converges on the same entries.
    expect(h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-1', 'entry-2'] }).review!.entries).toEqual(readback.review!.entries);
  });

  it('the owner settles a v7 question by refinement and approves it straight into a free pipeline slot', async () => {
    const h = approvalFixture(TICKETS, {}, 1);
    const first = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    expect(first.plan.heists[0]!.unresolvedQuestions).toHaveLength(1);
    const plan = { ...first.plan, heists: first.plan.heists.map((heist) => heist.id === 'entry-1' ? { ...heist, unresolvedQuestions: [] } : heist) };
    const refined = await h.service.revise({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', previousRequestId: 'r1', revisionId: first.revisionId, plan });
    const decision = { repoPath: h.repo, intakeId: 'cart', requestId: 'r2', revisionId: refined.revisionId, expectedToken: null };
    const token = h.approval.review(decision).review!.token;
    const readback = h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-1'] });
    expect(readback.accepted.map(({ heistId }) => heistId)).toEqual(['entry-1']);
    await h.pipeline.whenIdle();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0]![0]).toMatchObject({ title: 'Cart service scaffold' });
  });

  it('a later revision approves a slice whose prerequisite an earlier approval accepted, without enqueueing it twice', async () => {
    const h = approvalFixture(TICKETS.replace('hitl = true\n', ''));
    const first = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    const one = { repoPath: h.repo, intakeId: 'cart', requestId: 'r1', revisionId: first.revisionId, expectedToken: null };
    const accepted = h.approval.approve({ ...one, expectedToken: h.approval.review(one).review!.token, selected: ['entry-1'] }).review!;
    // Entry 2's unknown is settled later, in a new revision.
    const plan = { ...first.plan, heists: first.plan.heists.map((heist) => heist.id === 'entry-2' ? { ...heist, unresolvedQuestions: [] } : heist) };
    const second = await h.service.revise({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', previousRequestId: 'r1', revisionId: first.revisionId, plan });
    const two = { repoPath: h.repo, intakeId: 'cart', requestId: 'r2', revisionId: second.revisionId, expectedToken: accepted.token };
    const readback = h.approval.approve({ ...two, expectedToken: h.approval.review(two).review!.token, selected: ['entry-2'] });
    expect(readback.review!.entries[0]!.prerequisites).toEqual([{ id: accepted.entries[0]!.id, milestone: 'merged' }]);
    expect(h.ledger.listPipelineEntries().map(({ title }) => title).sort()).toEqual(['Apply and refuse discount codes', 'Cart service scaffold']);
  });

  it('refuses a heist that still carries breakdown placeholder text after its question is cleared', async () => {
    const h = approvalFixture(settled.replace('description = "Stands up the cart service with one add-item path through UI, API, and store."\n', ''));
    const first = await h.service.preview({ repoPath: h.repo, intakeId: 'cart', requestId: 'r1', source: h.source() });
    expect(first.plan.heists[0]!.goal.text).toBe('Clarify what entry 1 delivers; the breakdown gives no description.');
    const plan = { ...first.plan, heists: first.plan.heists.map((heist) => heist.id === 'entry-1' ? { ...heist, unresolvedQuestions: [] } : heist) };
    const cleared = await h.service.revise({ repoPath: h.repo, intakeId: 'cart', requestId: 'r2', previousRequestId: 'r1', revisionId: first.revisionId, plan });
    const decision = { repoPath: h.repo, intakeId: 'cart', requestId: 'r2', revisionId: cleared.revisionId, expectedToken: null };
    const token = h.approval.review(decision).review!.token;
    expect(() => h.approval.approve({ ...decision, expectedToken: token, selected: ['entry-1'] })).toThrow(expect.objectContaining({ code: 'intake_incomplete_plan' }));
    expect(h.ledger.listPipelineEntries()).toEqual([]);
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
