// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntakeView } from './intake.js';
import { IntakeClientError, type IntakeClient, type Proposal, type IntakeReadback } from '../lib/intake-client.js';
import type { AttachmentChip } from '../lib/protocol.js';
const statement = (text: string) => ({ text, traces: [], clarification: true });
const proposal: Proposal = { schemaVersion: 1, executable: false, projectKey: 'project', repoPath: '/workspace/app', intakeId: 'intake', requestId: 'r1', previousRequestId: null, revisionId: 'a'.repeat(64), workflow: { id: 'owned', sha256: 'c'.repeat(64) }, gaps: [], requirements: [], snapshots: [{ id: 'source', kind: 'spec', locator: 'spec.md', revision: 'v1', sha256: 'd'.repeat(64), raw: 'Requirement', text: 'Requirement', frontmatter: null, identifiers: {} }], plan: { questions: [], unmapped: [], heists: [{ id: 'one', title: 'Native feature', goal: statement('Implement feature'), scope: [statement('Native capture')], exclusions: [statement('No deploy')], acceptance: [{ ...statement('Captures source'), requirementIds: [] }], verification: [statement('npm test')], milestones: ['delivered'], dependencies: [], unresolvedQuestions: [], splitMergeRationale: statement('One unit') }] } };
const reviewed: IntakeReadback = { review: { repoPath: proposal.repoPath, intakeId: 'intake', requestId: 'r1', revisionId: proposal.revisionId, previousToken: null, token: 'b'.repeat(64), status: 'reviewed', selected: [], entries: [] }, accepted: [], remaining: [] };
const partial: IntakeReadback = { review: { ...reviewed.review!, previousToken: reviewed.review!.token, token: 'e'.repeat(64), status: 'approved', selected: ['one'], entries: [{ id: 'accepted-one', requestId: 'accepted-one', repoPath: proposal.repoPath, title: 'Native feature', briefing: 'exact', prerequisites: [] }] }, accepted: [], remaining: [{ heistId: 'one', entryId: 'accepted-one' }] };
afterEach(() => { document.body.replaceChildren(); sessionStorage.clear(); vi.unstubAllGlobals(); });
function fixture() {
  const root = document.createElement('div'); document.body.append(root);
  const picker = { pickIntakeFile: vi.fn((callback: (chip: AttachmentChip, uploaded: boolean) => void) => callback({ path: '/workspace/app/spec.md', name: 'spec.md', kind: 'file' }, false)), pickIntakeRepository: vi.fn((callback: (path: string) => void) => callback('/workspace/app')) };
  const client = { preview: vi.fn(async (_request: Parameters<IntakeClient['preview']>[0]) => proposal), revise: vi.fn(async (_request: Parameters<IntakeClient['revise']>[0]) => ({ ...proposal, requestId: 'r2', revisionId: 'f'.repeat(64) })), review: vi.fn(async (_request: Parameters<IntakeClient['review']>[0]) => reviewed), reject: vi.fn(async (_request: Parameters<IntakeClient['reject']>[0]) => ({ ...reviewed, review: { ...reviewed.review!, status: 'rejected' as const } })), approve: vi.fn(async (_request: Parameters<IntakeClient['approve']>[0]): Promise<IntakeReadback> => ({ ...partial, accepted: [{ heistId: 'one', entryId: 'accepted-one', state: 'waiting' }], remaining: [] })), read: vi.fn(async (_repo: string, _intake: string, _request: string) => proposal), readback: vi.fn(async (_repo: string, _intake: string, _token?: string): Promise<IntakeReadback> => ({ review: null, accepted: [], remaining: [] })) };
  const view = new IntakeView(root, picker, sessionStorage); view.bind(client as unknown as IntakeClient);
  const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)!;
  const click = async (label: string) => { button(label).click(); await vi.waitFor(() => expect(root.textContent).not.toContain('Loading intake…')); };
  const preview = async (kind = 'spec') => {
    await click('Choose repository'); const select = root.querySelector('select')!; select.value = kind; select.dispatchEvent(new Event('change'));
    if (kind === 'issue') { const input = root.querySelector<HTMLInputElement>('[aria-label="Issue reference"]')!; input.value = '#123'; input.dispatchEvent(new Event('input')); }
    else await click('Browse / upload documents');
    await click('Preview sources');
  };
  return { root, picker, client, view, button, click, preview };
}
describe('compact intake review in existing chat', () => {
  it.each(['issue', 'spec', 'bmad'])('previews %s without any automatic approval and displays captured review', async (kind) => {
    const h = fixture(); await h.preview(kind);
    expect(h.client.preview.mock.calls[0]).toBeDefined();
    expect(h.root.textContent).toContain('Scope: Native capture');
    expect(h.root.textContent).toContain('Verification: npm test');
    expect(h.root.textContent).toContain('Dependencies: none');
    expect(h.root.textContent).toContain('spec.md · v1');
    expect(h.client.approve).not.toHaveBeenCalled();
    expect(h.client.review).not.toHaveBeenCalled();
  });
  it('supports intake on LAN HTTP where crypto.randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const h = fixture(); await h.preview();
    expect(h.client.preview).toHaveBeenCalledOnce();
    expect(h.client.preview).toHaveBeenCalledWith(expect.objectContaining({
      intakeId: expect.stringMatching(/^intake-[a-f0-9-]{36}$/u),
      requestId: expect.stringMatching(/^r-[a-f0-9-]{36}$/u),
    }));
    const editor = h.root.querySelector<HTMLTextAreaElement>('textarea')!;
    editor.value = JSON.stringify({ ...proposal.plan, questions: ['Revise on LAN'] });
    editor.dispatchEvent(new Event('input'));
    await h.click('Save new revision');
    expect(h.client.revise).toHaveBeenCalledOnce();
  });
  it('requires review, explicit selection and clean plan bytes; edits produce a new revision and rejection cannot approve', async () => {
    const h = fixture(); await h.preview(); await h.click('Review this revision');
    const checkbox = h.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    expect(h.button('Approve selected work').disabled).toBe(false);
    const editor = h.root.querySelector<HTMLTextAreaElement>('textarea')!; editor.value = JSON.stringify({ ...proposal.plan, questions: ['Needs clarification'] }); editor.dispatchEvent(new Event('input'));
    expect(h.button('Approve selected work').disabled).toBe(true);
    await h.click('Save new revision'); expect(h.client.revise).toHaveBeenCalledOnce(); expect(h.client.approve).not.toHaveBeenCalled();
    h.client.review.mockResolvedValueOnce({ ...reviewed, review: { ...reviewed.review!, requestId: 'r2', revisionId: 'f'.repeat(64) } });
    await h.click('Review this revision');
    h.client.reject.mockResolvedValueOnce({ ...reviewed, review: { ...reviewed.review!, requestId: 'r2', revisionId: 'f'.repeat(64), status: 'rejected' } });
    await h.click('Reject revision'); expect(h.button('Approve selected work').disabled).toBe(true);
  });
  it('names partial accepted identities and reload/reconnect reads only before identical explicit retry', async () => {
    const h = fixture(); await h.preview(); await h.click('Review this revision');
    const checkbox = h.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    h.client.approve.mockRejectedValueOnce(new IntakeClientError('intake_partial_failure', 'Interrupted acceptance', partial));
    await h.click('Approve selected work'); expect(h.root.textContent).toContain('one → accepted-one');
    h.client.readback.mockResolvedValue(partial);
    h.view.bind(h.client as unknown as IntakeClient);
    await vi.waitFor(() => expect(h.root.textContent).toContain('approved. Accepted: none'));
    expect(h.client.approve).toHaveBeenCalledTimes(1);
    await h.click('Retry identical approval');
    expect(h.client.approve.mock.calls[1]).toEqual([{ repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: proposal.requestId, revisionId: proposal.revisionId, expectedToken: reviewed.review!.token, selected: ['one'] }]);
  });
  it('ignores an old pairing preview response and source changes while a request is in flight', async () => {
    const h = fixture(); let resolve!: (p: Proposal) => void;
    h.client.preview.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await h.click('Choose repository'); await h.click('Browse / upload documents');
    const select = h.root.querySelector('select')!; select.value = 'spec'; select.dispatchEvent(new Event('change'));
    h.button('Preview sources').click();
    h.view.bind(null); resolve(proposal);
    await Promise.resolve(); await Promise.resolve();
    expect(h.root.textContent).not.toContain('Scope:');
    expect(h.client.approve).not.toHaveBeenCalled();
  });
});

it('retains original partial approval and token independently of a newer reviewed draft through reload/reconnect', async () => {
  const h = fixture();
  const a = { ...proposal, plan: { ...proposal.plan, heists: [proposal.plan.heists[0]!, { ...proposal.plan.heists[0]!, id: 'two' }] } };
  const interrupted: IntakeReadback = { ...partial, review: { ...partial.review!, selected: ['one', 'two'], entries: [...partial.review!.entries, { ...partial.review!.entries[0]!, id: 'remaining-two', requestId: 'remaining-two' }] }, accepted: [{ heistId: 'one', entryId: 'accepted-one', state: 'waiting' }], remaining: [{ heistId: 'two', entryId: 'remaining-two' }] };
  h.client.preview.mockResolvedValueOnce(a);
  await h.preview(); await h.click('Review this revision');
  for (const checkbox of h.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) { checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); }
  h.client.approve.mockRejectedValueOnce(new IntakeClientError('intake_partial_failure', 'Interrupted', interrupted));
  await h.click('Approve selected work');
  const original = h.client.approve.mock.calls[0]![0];
  const editor = h.root.querySelector<HTMLTextAreaElement>('textarea')!;
  editor.value = JSON.stringify({ ...proposal.plan, questions: ['A newer draft'] }); editor.dispatchEvent(new Event('input'));
  await h.click('Save new revision');
  const b = { ...proposal, requestId: 'r2', revisionId: 'f'.repeat(64) };
  const reviewedB = { ...reviewed, review: { ...reviewed.review!, requestId: b.requestId, revisionId: b.revisionId, token: '9'.repeat(64), previousToken: interrupted.review!.token } };
  h.client.review.mockResolvedValueOnce(reviewedB); await h.click('Review this revision');
  h.client.read.mockResolvedValue(b);
  h.client.readback.mockImplementation(async (_repo, _intake, token) => token === interrupted.review!.token ? interrupted : reviewedB);
  const saved = sessionStorage.getItem('gru-intake-recovery')!;
  expect(JSON.parse(saved).draft.requestId).toBe('r2');
  expect(JSON.parse(saved).approvals[0]).toEqual({ request: original, token: interrupted.review!.token });
  expect(saved).not.toContain('briefing'); expect(saved).not.toContain('Requirement'); expect(saved).not.toContain('exact');
  for (let reconnect = 0; reconnect < 2; reconnect += 1) {
    h.view.bind(h.client as unknown as IntakeClient);
    await vi.waitFor(() => expect(h.root.querySelector('.intake-approval-recovery')!.textContent).toContain('two → remaining-two'));
    expect(h.root.querySelector('.intake-approval-recovery')!.textContent).toContain('one → accepted-one');
    expect(h.client.approve).toHaveBeenCalledTimes(1);
  }
  expect(h.client.readback).toHaveBeenCalledWith(proposal.repoPath, proposal.intakeId, interrupted.review!.token);
  h.client.approve.mockResolvedValueOnce({ ...interrupted, remaining: [], accepted: [...interrupted.accepted, { heistId: 'two', entryId: 'remaining-two', state: 'waiting' }] });
  await h.click('Retry original approval r1');
  expect(h.client.approve.mock.calls[1]![0]).toEqual(original);
  expect(h.root.querySelector('.intake-review')!.textContent).toContain(b.revisionId);
});

it('stores the original explicit approval before transmission and retries it when a newer head hides a lost response', async () => {
  const h = fixture(); await h.preview(); await h.click('Review this revision');
  const checkbox = h.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
  h.client.approve.mockImplementationOnce(async (request) => {
    expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).approvals[0].request).toEqual(request);
    throw new IntakeClientError('intake_unreachable', 'Response lost');
  });
  await h.click('Approve selected work');
  const original = h.client.approve.mock.calls[0]![0];
  const b = { ...proposal, requestId: 'r2', revisionId: 'f'.repeat(64) };
  const reviewedB = { ...reviewed, review: { ...reviewed.review!, requestId: 'r2', revisionId: b.revisionId } };
  h.client.readback.mockResolvedValue(reviewedB);
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.button('Retry original approval r1')).toBeDefined());
  await vi.waitFor(() => expect(h.button('Retry original approval r1').disabled).toBe(false));
  expect(h.client.approve).toHaveBeenCalledTimes(1);
  await h.click('Retry original approval r1'); expect(h.client.approve.mock.calls[1]![0]).toEqual(original);
});

it('persists a pending revision before sending and recovers committed-but-lost bytes by read alone', async () => {
  const h = fixture(); await h.preview();
  const editor = h.root.querySelector<HTMLTextAreaElement>('textarea')!;
  const plan = { ...proposal.plan, questions: ['Persist this exact revision'] };
  editor.value = JSON.stringify(plan); editor.dispatchEvent(new Event('input'));
  let committed!: Proposal;
  h.client.revise.mockImplementationOnce(async (request) => {
    const saved = JSON.parse(sessionStorage.getItem('gru-intake-recovery')!);
    expect(saved.pendingRevision.identity.requestId).toBe(request.requestId);
    expect(saved.pendingRevision.previous.requestId).toBe(proposal.requestId);
    committed = { ...proposal, requestId: request.requestId, revisionId: 'f'.repeat(64), plan: request.plan };
    throw new IntakeClientError('intake_unreachable', 'Committed response lost');
  });
  await h.click('Save new revision');
  h.client.read.mockResolvedValue(committed);
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(editor.value).toBe(JSON.stringify(plan, null, 2)));
  expect(h.client.read).toHaveBeenCalledWith(proposal.repoPath, proposal.intakeId, committed.requestId);
  expect(h.client.revise).toHaveBeenCalledTimes(1); expect(h.client.review).not.toHaveBeenCalled(); expect(h.client.approve).not.toHaveBeenCalled();
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).pendingRevision).toBeNull();
});

it('retains the previous proposal recovery identity on definite revision validation failure', async () => {
  const h = fixture(); await h.preview();
  const editor = h.root.querySelector<HTMLTextAreaElement>('textarea')!; editor.value = JSON.stringify({ ...proposal.plan, questions: ['Invalid'] }); editor.dispatchEvent(new Event('input'));
  h.client.revise.mockRejectedValueOnce(new IntakeClientError('intake_invalid_plan', 'Invalid plan'));
  await h.click('Save new revision');
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).draft.requestId).toBe('r1');
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).pendingRevision).toBeNull();
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.client.read).toHaveBeenCalledWith(proposal.repoPath, proposal.intakeId, 'r1'));
  expect(h.client.revise).toHaveBeenCalledTimes(1);
});

it('locks edits and source controls during held revision and approval responses, including programmatic stale inputs', async () => {
  const h = fixture(); await h.preview();
  const editor = h.root.querySelector<HTMLTextAreaElement>('textarea')!;
  const plan = { ...proposal.plan, questions: ['Saved bytes'] };
  editor.value = JSON.stringify(plan); editor.dispatchEvent(new Event('input'));
  let release!: (p: Proposal) => void;
  h.client.revise.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  h.button('Save new revision').click();
  expect(editor.disabled).toBe(true);
  const kind = h.root.querySelector('select')!; expect(kind.disabled).toBe(true);
  editor.value = 'uncommitted edits'; editor.dispatchEvent(new Event('input'));
  kind.value = 'issue'; kind.dispatchEvent(new Event('change'));
  expect(editor.value).toBe(JSON.stringify(plan)); expect(kind.value).toBe('spec');
  release({ ...proposal, plan }); await vi.waitFor(() => expect(editor.disabled).toBe(false));
  await h.click('Review this revision');
  const checkbox = h.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
  let approve!: (r: IntakeReadback) => void;
  h.client.approve.mockImplementationOnce(() => new Promise((resolve) => { approve = resolve; }));
  h.button('Approve selected work').click();
  const recovery = sessionStorage.getItem('gru-intake-recovery');
  kind.value = 'bmad'; kind.dispatchEvent(new Event('change'));
  h.button('Choose repository').click();
  expect(kind.value).toBe('spec'); expect(h.button('Choose repository').disabled).toBe(true);
  expect(sessionStorage.getItem('gru-intake-recovery')).toBe(recovery);
  approve(partial); await vi.waitFor(() => expect(h.root.textContent).toContain('accepted-one'));
  expect(h.client.approve).toHaveBeenCalledTimes(1);
});

it('discards obsolete picker and upload callbacks but preserves all documents from a current selection', async () => {
  const h = fixture(); await h.preview();
  const callbacks: ((chip: AttachmentChip, uploaded: boolean) => void)[] = [];
  h.picker.pickIntakeFile.mockImplementation((callback) => { callbacks.push(callback); });
  await h.click('Browse / upload documents');
  await h.preview('issue');
  callbacks[0]!({ path: '/uploads/late.md', name: 'late.md', kind: 'file' }, true);
  expect(h.root.textContent).toContain('Scope: Native capture'); expect(h.root.textContent).not.toContain('late.md');
  const kind = h.root.querySelector('select')!; kind.value = 'spec'; kind.dispatchEvent(new Event('change'));
  await h.click('Remove spec.md');
  await h.click('Browse / upload documents');
  callbacks[1]!({ path: '/uploads/primary.md', name: 'primary.md', kind: 'file' }, true);
  callbacks[1]!({ path: '/uploads/support.md', name: 'support.md', kind: 'file' }, true);
  await h.click('Preview sources');
  expect(h.client.preview.mock.calls.at(-1)![0].source).toMatchObject({ document: { uploadPath: '/uploads/primary.md' }, supporting: [{ uploadPath: '/uploads/support.md' }] });
  let repository!: (path: string) => void;
  h.picker.pickIntakeRepository.mockImplementationOnce((callback) => { repository = callback; });
  await h.click('Choose repository');
  kind.value = 'issue'; kind.dispatchEvent(new Event('change')); repository('/wrong/source-repo');
  expect(h.root.querySelector<HTMLInputElement>('[aria-label="Intake repository"]')!.value).toBe(proposal.repoPath);
  h.picker.pickIntakeRepository.mockImplementationOnce((callback) => { repository = callback; });
  await h.click('Choose repository'); h.view.bind(null); repository('/wrong/pairing-repo');
  callbacks[1]!({ path: '/uploads/wrong-pairing.md', name: 'wrong-pairing.md', kind: 'file' }, true);
  expect(h.root.querySelector<HTMLInputElement>('[aria-label="Intake repository"]')!.value).toBe('');
  expect(h.root.textContent).not.toContain('wrong-pairing.md');
});

it('keeps a disconnected pending revision identity while reading the previous proposal until the original commit appears', async () => {
  const h = fixture(); await h.preview();
  const editor = h.root.querySelector<HTMLTextAreaElement>('textarea')!;
  editor.value = JSON.stringify({ ...proposal.plan, questions: ['Pending original revision'] }); editor.dispatchEvent(new Event('input'));
  h.client.revise.mockRejectedValueOnce(new IntakeClientError('intake_unreachable', 'Disconnected'));
  await h.click('Save new revision');
  const pending = JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).pendingRevision.identity;
  h.client.read.mockRejectedValueOnce(new IntakeClientError('intake_not_found', 'Not committed yet')).mockResolvedValueOnce(proposal);
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.client.read).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(h.root.textContent).not.toContain('Loading intake…'));
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).pendingRevision.identity).toEqual(pending);
  h.client.read.mockResolvedValueOnce({ ...proposal, requestId: pending.requestId, revisionId: 'f'.repeat(64) });
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.root.textContent).toContain('f'.repeat(64)));
  expect(h.client.read.mock.calls[2]).toEqual([pending.repoPath, pending.intakeId, pending.requestId]);
  expect(h.client.revise).toHaveBeenCalledTimes(1); expect(h.client.review).not.toHaveBeenCalled(); expect(h.client.approve).not.toHaveBeenCalled();
});

it.each(['lost', 'partial'])('keeps original ambiguous %s approval through changed selection, newer B and reload', async (kind) => {
  const h = fixture();
  const a = { ...proposal, plan: { ...proposal.plan, heists: [proposal.plan.heists[0]!, { ...proposal.plan.heists[0]!, id: 'two' }] } };
  const receipt: IntakeReadback = { ...partial, review: { ...partial.review!, selected: ['one', 'two'], entries: [...partial.review!.entries, { ...partial.review!.entries[0]!, id: 'remaining-two', requestId: 'remaining-two' }] }, accepted: [{ heistId: 'one', entryId: 'accepted-one', state: 'waiting' }], remaining: [{ heistId: 'two', entryId: 'remaining-two' }] };
  h.client.preview.mockResolvedValueOnce(a); h.client.read.mockResolvedValue(a);
  await h.preview(); await h.click('Review this revision');
  for (const checkbox of h.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) { checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); }
  h.client.approve.mockRejectedValueOnce(new IntakeClientError(kind === 'lost' ? 'intake_unreachable' : 'intake_partial_failure', 'Interrupted', kind === 'lost' ? undefined : receipt));
  await h.click('Approve selected work');
  const original = h.client.approve.mock.calls[0]![0];
  const second = h.root.querySelector<HTMLInputElement>('[data-heist-id="two"]')!;
  second.checked = false; second.dispatchEvent(new Event('change'));
  if (kind === 'lost') {
    await h.click('Approve selected work');
    expect(h.root.textContent).toContain('Original approval r1 is unconfirmed');
    expect(h.client.approve).toHaveBeenCalledTimes(1);
  } else expect(second.checked).toBe(true);
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).approvals[0].request).toEqual(original);
  h.client.readback.mockResolvedValue(receipt); await h.click('Read back / recover');
  const editor = h.root.querySelector<HTMLTextAreaElement>('textarea')!;
  editor.value = JSON.stringify({ ...a.plan, questions: ['Newer B'] }); editor.dispatchEvent(new Event('input'));
  await h.click('Save new revision');
  const b = { ...proposal, requestId: 'r2', revisionId: 'f'.repeat(64) };
  const headB = { ...reviewed, review: { ...reviewed.review!, requestId: b.requestId, revisionId: b.revisionId, token: '9'.repeat(64) } };
  h.client.review.mockResolvedValueOnce(headB); await h.click('Review this revision');
  h.client.read.mockResolvedValue(b); h.client.readback.mockImplementation(async (_repo, _intake, token) => token === receipt.review!.token ? receipt : headB);
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.root.textContent).toContain('two → remaining-two'));
  expect(h.client.approve).toHaveBeenCalledTimes(1);
  await h.click('Retry original approval r1');
  expect(h.client.approve.mock.calls[1]![0]).toEqual(original);
});

it('allows corrected selection only after a definite pre-acceptance refusal', async () => {
  const h = fixture(); await h.preview(); await h.click('Review this revision');
  const checkbox = h.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
  h.client.approve.mockRejectedValueOnce(new IntakeClientError('intake_dependency_selection', 'Select prerequisite'));
  await h.click('Approve selected work');
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).approvals).toEqual([]);
  await h.click('Approve selected work'); expect(h.client.approve).toHaveBeenCalledTimes(2);
});

it('reports one failed historical receipt but continues healthy receipts and current draft without approval', async () => {
  const h = fixture();
  const request = { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: 'r1', revisionId: proposal.revisionId, expectedToken: reviewed.review!.token, selected: ['one'] };
  const healthy = { ...partial, review: { ...partial.review!, requestId: 'healthy', revisionId: '8'.repeat(64), token: '7'.repeat(64) } };
  sessionStorage.setItem('gru-intake-recovery', JSON.stringify({ draft: { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: 'current' }, pendingRevision: null, approvals: [{ request, token: partial.review!.token }, { request: { ...request, requestId: 'healthy', revisionId: healthy.review!.revisionId }, token: healthy.review!.token }] }));
  h.client.read.mockResolvedValue({ ...proposal, requestId: 'current' });
  h.client.readback.mockImplementation(async (_repo, _intake, token) => {
    if (token === partial.review!.token) throw new IntakeClientError('intake_storage_error', 'Damaged first receipt');
    return token === healthy.review!.token ? healthy : reviewed;
  });
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.root.textContent).toContain('Scope: Native capture'));
  expect(h.root.querySelector('.intake-approval-recovery')!.textContent).toContain('intake_storage_error: Damaged first receipt');
  expect(h.root.querySelector('.intake-approval-recovery')!.textContent).toContain('Original approval healthy');
  expect(h.root.textContent).toContain('one → accepted-one');
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).approvals[0].request).toEqual(request);
  expect(h.client.approve).not.toHaveBeenCalled();
});

it.each([null, { draft: null, approvals: {} }, { draft: null, approvals: [null] }, { draft: null, approvals: [{ request: {} }] }, { draft: null, approvals: [{ request: { repoPath: '/repo', intakeId: 'id', requestId: 'r1', revisionId: 'a'.repeat(64), expectedToken: null, selected: 'one' } }] }, { draft: { repoPath: '/repo', intakeId: '../escape', requestId: 'r1' }, approvals: [] }, { draft: null, approvals: [], briefing: 'private source payload' }])('handles malformed recovery structure without crashing pairing: %j', (saved) => {
  const h = fixture(); sessionStorage.setItem('gru-intake-recovery', JSON.stringify(saved));
  expect(() => h.view.bind(h.client as unknown as IntakeClient)).not.toThrow();
  expect(h.root.textContent).toContain('intake_recovery_storage_error');
  expect(h.client.read).not.toHaveBeenCalled(); expect(h.client.readback).not.toHaveBeenCalled(); expect(h.client.approve).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('gru-intake-recovery')).toBe(JSON.stringify(saved));
});

it('retains valid legacy identity-only recovery and passes chosen repository/document slots to its picker', async () => {
  const h = fixture(); sessionStorage.setItem('gru-intake-recovery', JSON.stringify({ repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: proposal.requestId }));
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.root.textContent).toContain('Scope: Native capture'));
  await h.click('Browse / upload documents');
  expect(h.picker.pickIntakeFile).toHaveBeenCalledWith(expect.any(Function), proposal.repoPath, 8);
  expect(h.client.approve).not.toHaveBeenCalled();
});

it('refuses a new approval before exceeding recoverable tab history without dropping original identities', async () => {
  const h = fixture();
  const approvals = Array.from({ length: 128 }, (_, index) => ({ request: { repoPath: proposal.repoPath, intakeId: `history-${index}`, requestId: 'r1', revisionId: index.toString(16).padStart(64, '0'), expectedToken: null, selected: ['one'] } }));
  sessionStorage.setItem('gru-intake-recovery', JSON.stringify({ draft: { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: proposal.requestId }, pendingRevision: null, approvals }));
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.button('Choose repository').disabled).toBe(false));
  await h.preview(); await h.click('Review this revision');
  const checkbox = h.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!; checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
  await h.click('Approve selected work');
  expect(h.client.approve).not.toHaveBeenCalled();
  expect(h.root.textContent).toContain('128 original approvals');
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).approvals).toEqual(approvals);
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.button('Choose repository').disabled).toBe(false));
  expect(h.root.textContent).not.toContain('Invalid intake recovery storage');
  expect(h.client.approve).not.toHaveBeenCalled();
});

it('finishes observational recovery of approval receipts without a current draft', async () => {
  const h = fixture();
  const request = { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: proposal.requestId, revisionId: proposal.revisionId, expectedToken: reviewed.review!.token, selected: ['one'] };
  sessionStorage.setItem('gru-intake-recovery', JSON.stringify({ draft: null, pendingRevision: null, approvals: [{ request, token: partial.review!.token }] }));
  h.client.readback.mockResolvedValue(partial);
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.button('Retry original approval r1').disabled).toBe(false));
  expect(h.root.querySelector('.intake-status')!.textContent).not.toContain('Loading intake');
  expect(h.root.textContent).toContain('one → accepted-one');
  expect(h.client.read).not.toHaveBeenCalled();
  expect(h.client.approve).not.toHaveBeenCalled();
});
