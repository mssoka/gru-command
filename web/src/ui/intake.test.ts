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
  const picker = { pickIntakeFile: vi.fn((callback: (chip: AttachmentChip, uploaded: boolean) => void, _repo?: string, _remaining?: number, _batch?: (pending: boolean) => void) => callback({ path: '/workspace/app/spec.md', name: 'spec.md', kind: 'file' }, false)), pickIntakeRepository: vi.fn((callback: (path: string) => void) => callback('/workspace/app')) };
  const client = { diff: vi.fn(async () => ({ from: 'a', to: 'b', changes: ['Acceptance changed'] })), preview: vi.fn(async (_request: Parameters<IntakeClient['preview']>[0]) => proposal), revise: vi.fn(async (_request: Parameters<IntakeClient['revise']>[0]) => ({ ...proposal, requestId: 'r2', revisionId: 'f'.repeat(64) })), review: vi.fn(async (_request: Parameters<IntakeClient['review']>[0]) => reviewed), reject: vi.fn(async (_request: Parameters<IntakeClient['reject']>[0]) => ({ ...reviewed, review: { ...reviewed.review!, status: 'rejected' as const } })), approve: vi.fn(async (_request: Parameters<IntakeClient['approve']>[0]): Promise<IntakeReadback> => ({ ...partial, accepted: [{ heistId: 'one', entryId: 'accepted-one', state: 'waiting' }], remaining: [] })), read: vi.fn(async (_repo: string, _intake: string, _request: string) => proposal), readback: vi.fn(async (_repo: string, _intake: string, _token?: string): Promise<IntakeReadback> => ({ review: null, accepted: [], remaining: [] })) };
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
describe('intake exact observational recovery', () => {
  it('keeps failed document selection blocked until explicit abandonment or a complete retry', async () => {
    const h = fixture(); await h.preview(); await h.click('Review this revision');
    const box = h.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!; box.checked = true; box.dispatchEvent(new Event('change'));
    let batch!: (pending: boolean, error?: string) => void;
    let publish!: (chip: AttachmentChip, uploaded: boolean) => void;
    h.picker.pickIntakeFile.mockImplementation((callback, _repo, _remaining, update) => { publish = callback; batch = update!; });
    await h.click('Browse / upload documents'); batch(true); batch(false, 'Intake documents were not selected: an upload failed. Retry the complete selection.');
    expect(h.root.querySelector('.intake-status')!.textContent).toContain('upload failed');
    expect(h.root.textContent).not.toContain('Complete document batch finished');
    expect(h.button('Preview sources').disabled).toBe(true); expect(h.button('Approve selected work').disabled).toBe(true);
    h.button('Preview sources').click(); h.button('Approve selected work').click();
    expect(h.client.preview).toHaveBeenCalledTimes(1); expect(h.client.approve).not.toHaveBeenCalled();
    await h.click('Abandon failed document selection');
    expect(h.button('Approve selected work').disabled).toBe(false);
    await h.click('Browse / upload documents'); batch(true); batch(false, 'Retry still failed');
    await h.click('Browse / upload documents'); batch(true); batch(false);
    publish({ path: '/uploads/support.md', name: 'support.md', kind: 'file' }, true);
    await h.click('Preview sources');
    expect(h.client.preview.mock.calls.at(-1)![0].source).toMatchObject({ document: { path: 'spec.md' }, supporting: [{ uploadPath: '/uploads/support.md' }] });
  });

  it.each(['selection', 'review token'])('never associates a competing %s receipt with the original intent', async (difference) => {
    const h = fixture();
    const p = { ...proposal, plan: { ...proposal.plan, heists: [proposal.plan.heists[0]!, { ...proposal.plan.heists[0]!, id: 'two' }] } };
    h.client.preview.mockResolvedValue(p); h.client.read.mockResolvedValue(p);
    await h.preview(); await h.click('Review this revision');
    const box = h.root.querySelector<HTMLInputElement>('[data-heist-id="one"]')!; box.checked = true; box.dispatchEvent(new Event('change'));
    h.client.approve.mockRejectedValueOnce(new IntakeClientError('intake_unreachable', 'Response lost')); await h.click('Approve selected work');
    const original = h.client.approve.mock.calls[0]![0];
    const other: IntakeReadback = { ...partial, review: { ...partial.review!, previousToken: difference === 'review token' ? '9'.repeat(64) : partial.review!.previousToken, selected: difference === 'selection' ? ['two'] : ['one'] }, remaining: [{ heistId: difference === 'selection' ? 'two' : 'one', entryId: 'other-entry' }] };
    h.client.readback.mockResolvedValue(other); h.view.bind(h.client as unknown as IntakeClient);
    await vi.waitFor(() => expect(h.root.querySelector('.intake-approval-recovery')!.textContent).toContain('intake_acceptance_conflict'));
    expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).approvals).toEqual([{ request: original }]);
    expect(h.root.querySelector('.intake-approval-recovery')!.textContent).toContain('not confirmed');
    expect(h.button('Retry original approval r1')).toBeDefined();
    expect(h.button('Retry identical approval').disabled).toBe(true);
    expect(h.client.approve).toHaveBeenCalledTimes(1);
  });

  it('refuses a mismatched successful approval response without stamping its token onto original intent', async () => {
    const h = fixture(); await h.preview(); await h.click('Review this revision');
    const box = h.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!; box.checked = true; box.dispatchEvent(new Event('change'));
    h.client.approve.mockResolvedValueOnce({ ...partial, review: { ...partial.review!, selected: ['another'] } });
    await h.click('Approve selected work');
    expect(h.root.querySelector('.intake-status')!.textContent).toContain('intake_acceptance_conflict');
    expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).approvals[0]).toEqual({ request: h.client.approve.mock.calls[0]![0] });
    expect(h.root.querySelector('.intake-approval-recovery')!.textContent).toContain('not confirmed');
  });

  it('matches the original selected set regardless of click order', async () => {
    const h = fixture(); const p = { ...proposal, plan: { ...proposal.plan, heists: [proposal.plan.heists[0]!, { ...proposal.plan.heists[0]!, id: 'two' }] } };
    h.client.preview.mockResolvedValue(p); await h.preview(); await h.click('Review this revision');
    for (const id of ['two', 'one']) { const box = h.root.querySelector<HTMLInputElement>(`[data-heist-id="${id}"]`)!; box.checked = true; box.dispatchEvent(new Event('change')); }
    const accepted: IntakeReadback = { ...partial, review: { ...partial.review!, selected: ['one', 'two'] }, accepted: [{ heistId: 'one', entryId: 'accepted-one', state: 'waiting' }, { heistId: 'two', entryId: 'accepted-two', state: 'waiting' }], remaining: [] };
    h.client.approve.mockResolvedValueOnce(accepted); await h.click('Approve selected work');
    expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).approvals[0].token).toBe(accepted.review!.token);
    expect(h.root.querySelector('.intake-approval-recovery')!.textContent).toContain('two → accepted-two');
  });

  it('refreshes the same immutable proposal without discarding dirty editor bytes or allowing approval', async () => {
    const h = fixture(); await h.preview(); await h.click('Review this revision');
    const box = h.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!; box.checked = true; box.dispatchEvent(new Event('change'));
    const editor = h.root.querySelector('textarea')!;
    const bytes = JSON.stringify({ ...proposal.plan, questions: ['Unsaved private clarification'] });
    editor.value = bytes; editor.dispatchEvent(new Event('input'));
    h.client.readback.mockResolvedValue(reviewed); await h.click('Read back / recover');
    expect(editor.value).toBe(bytes); expect(h.button('Save new revision').disabled).toBe(false); expect(h.button('Approve selected work').disabled).toBe(true);
    expect(sessionStorage.getItem('gru-intake-recovery')).not.toContain('Unsaved private clarification');
    expect(h.client.revise).not.toHaveBeenCalled(); expect(h.client.approve).not.toHaveBeenCalled();
  });

  it.each([false, true])('recovers a committed pending revision, preserving only newer local edits: %s', async (editedAgain) => {
    const h = fixture(); await h.preview();
    const editor = h.root.querySelector('textarea')!;
    const sent = { ...proposal.plan, questions: ['Sent original refinement'] };
    editor.value = JSON.stringify(sent); editor.dispatchEvent(new Event('input'));
    let committed!: Proposal;
    h.client.revise.mockImplementationOnce(async (request) => { committed = { ...proposal, requestId: request.requestId, revisionId: 'f'.repeat(64), plan: { heists: request.plan.heists, questions: request.plan.questions, unmapped: request.plan.unmapped } }; throw new IntakeClientError('intake_unreachable', 'Response lost'); });
    await h.click('Save new revision');
    const newer = JSON.stringify({ ...sent, questions: ['Newer unsaved private clarification'] });
    if (editedAgain) { editor.value = newer; editor.dispatchEvent(new Event('input')); }
    h.client.read.mockResolvedValue(committed); await h.click('Read back / recover');
    expect(editor.value).toBe(editedAgain ? newer : JSON.stringify(committed.plan, null, 2)); expect(h.button('Save new revision').disabled).toBe(!editedAgain);
    expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!)).toMatchObject({ draft: { requestId: committed.requestId }, pendingRevision: null });
    expect(sessionStorage.getItem('gru-intake-recovery')).not.toContain('Newer unsaved');
    expect(h.client.revise).toHaveBeenCalledTimes(1); expect(h.client.approve).not.toHaveBeenCalled();
  });

  it.each(['intake_invalid_request', 'intake_unreachable', 'intake_storage_error'])('handles replacement preview refusal %s without confusing definite and ambiguous outcomes', async (code) => {
    const h = fixture(); await h.preview(); const previous = JSON.parse(sessionStorage.getItem('gru-intake-recovery')!);
    h.client.preview.mockRejectedValueOnce(new IntakeClientError(code, 'Preview refused')); await h.click('Preview sources');
    const saved = JSON.parse(sessionStorage.getItem('gru-intake-recovery')!);
    if (code === 'intake_invalid_request') {
      expect(saved).toEqual(previous); h.view.bind(h.client as unknown as IntakeClient);
      await vi.waitFor(() => expect(h.client.read).toHaveBeenCalledWith(proposal.repoPath, proposal.intakeId, proposal.requestId));
    } else expect(saved.draft.requestId).not.toBe(previous.draft.requestId);
    expect(h.client.approve).not.toHaveBeenCalled();
  });

  it('prunes removed receipt buttons during delayed progressive recovery', async () => {
    const h = fixture();
    const approvals = Array.from({ length: 20 }, (_, index) => ({ request: { repoPath: proposal.repoPath, intakeId: `progress-${index}`, requestId: 'r1', revisionId: index.toString(16).padStart(64, '0'), expectedToken: reviewed.review!.token, selected: ['one'] } }));
    sessionStorage.setItem('gru-intake-recovery', JSON.stringify({ draft: { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: 'r1' }, pendingRevision: null, approvals }));
    const releases = new Map<string, (value: IntakeReadback) => void>();
    h.client.readback.mockImplementation((_repo, intake) => intake === proposal.intakeId ? Promise.resolve(reviewed) : new Promise((resolve) => releases.set(intake, resolve)));
    h.view.bind(h.client as unknown as IntakeClient);
    await vi.waitFor(() => expect(h.button('Choose repository').disabled).toBe(false));
    for (const { request } of approvals) {
      await vi.waitFor(() => expect(releases.has(request.intakeId)).toBe(true));
      releases.get(request.intakeId)!({ ...reviewed, review: { ...reviewed.review!, intakeId: request.intakeId, revisionId: request.revisionId } });
      await Promise.resolve(); await Promise.resolve();
    }
    await vi.waitFor(() => expect((h.view as unknown as { receiptActive: number }).receiptActive).toBe(0));
    const buttons = (h.view as unknown as { buttons: HTMLButtonElement[] }).buttons;
    expect(buttons.every((button) => h.root.contains(button))).toBe(true);
    expect(buttons).toHaveLength(h.root.querySelectorAll('button').length);
    expect(h.client.approve).not.toHaveBeenCalled();
  });
});

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
  const plan = { ...proposal.plan, heists: proposal.plan.heists.map((heist) => ({ ...heist, goal: statement('Saved bytes') })) };
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
  expect(h.picker.pickIntakeFile).toHaveBeenCalledWith(expect.any(Function), proposal.repoPath, 8, expect.any(Function));
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

it('clears old repository documents and invalidates old file callbacks on repository change', async () => {
  const h = fixture(); await h.preview();
  let old!: (chip: AttachmentChip, uploaded: boolean) => void;
  h.picker.pickIntakeFile.mockImplementationOnce((cb) => { old = cb; });
  await h.click('Browse / upload documents');
  h.picker.pickIntakeRepository.mockImplementationOnce((cb) => cb('/workspace/other'));
  await h.click('Choose repository');
  old({ path: '/workspace/app/stale.md', name: 'stale.md', kind: 'file' }, false);
  expect(h.root.querySelector('.intake-documents')!.textContent).toBe('');
  await h.click('Preview sources'); expect(h.client.preview).toHaveBeenCalledTimes(1);
  expect(h.root.textContent).toContain('Choose the primary source document');
});

it('blocks narrowed previews until the complete in-flight document batch finishes', async () => {
  const h = fixture(); await h.preview();
  let publish!: (chip: AttachmentChip, uploaded: boolean) => void;
  let batch!: (pending: boolean) => void;
  h.picker.pickIntakeFile.mockImplementationOnce((cb, _repo, _remaining, pending) => { publish = cb; batch = pending!; });
  await h.click('Browse / upload documents');
  expect(batch).toBeTypeOf('function'); batch(true);
  expect(h.button('Browse / upload documents').disabled).toBe(true); expect(h.button('Choose repository').disabled).toBe(true);
  h.button('Browse / upload documents').click(); expect(h.picker.pickIntakeFile).toHaveBeenCalledTimes(2);
  const kind = h.root.querySelector('select')!; kind.value = 'issue'; kind.dispatchEvent(new Event('change')); expect(kind.value).toBe('spec');
  h.button('Preview sources').click(); await Promise.resolve();
  expect(h.client.preview).toHaveBeenCalledTimes(1);
  publish({ path: '/uploads/support.md', name: 'support.md', kind: 'file' }, true); batch(false);
  await h.click('Preview sources');
  expect(h.client.preview.mock.calls[1]![0].source).toMatchObject({ supporting: [{ uploadPath: '/uploads/support.md' }] });
});

it('blocks replacement Save and Preview while an ambiguous revision is pending and permits explicit abandonment', async () => {
  const h = fixture(); await h.preview();
  const editor = h.root.querySelector('textarea')!; editor.value = JSON.stringify({ ...proposal.plan, questions: ['original'] }); editor.dispatchEvent(new Event('input'));
  h.client.revise.mockRejectedValueOnce(new IntakeClientError('intake_unreachable', 'Lost response')); await h.click('Save new revision');
  const saved = sessionStorage.getItem('gru-intake-recovery');
  editor.value = JSON.stringify({ ...proposal.plan, questions: ['replacement'] }); editor.dispatchEvent(new Event('input'));
  h.button('Save new revision').click(); h.button('Preview sources').click(); await Promise.resolve();
  expect(h.client.revise).toHaveBeenCalledTimes(1); expect(h.client.preview).toHaveBeenCalledTimes(1); expect(sessionStorage.getItem('gru-intake-recovery')).toBe(saved);
  expect(h.root.textContent).toContain('Abandon pending revision');
  await h.click('Abandon pending revision');
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).pendingRevision).toBeNull();
  expect(h.client.revise).toHaveBeenCalledTimes(1);
});

it.each(['intake_output_bounds', 'intake_replay_conflict', 'intake_aggregate_bounds', 'intake_source_bounds'])('restores previous identity on definite revision refusal %s', async (code) => {
  const h = fixture(); await h.preview();
  const editor = h.root.querySelector('textarea')!; editor.value = JSON.stringify({ ...proposal.plan, questions: ['invalid'] }); editor.dispatchEvent(new Event('input'));
  h.client.revise.mockRejectedValueOnce(new IntakeClientError(code, 'Definite refusal')); await h.click('Save new revision');
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!)).toMatchObject({ draft: { requestId: 'r1' }, pendingRevision: null });
});

it('atomically refuses serialized over-budget recovery before sending approval or changing identities', async () => {
  const h = fixture();
  const selected = Array.from({ length: 3900 }, (_, i) => `${i}-${'x'.repeat(120)}`);
  const approvals = Array.from({ length: 4 }, (_, i) => ({ request: { repoPath: proposal.repoPath, intakeId: `large-${i}`, requestId: 'r1', revisionId: i.toString(16).padStart(64, '0'), expectedToken: null, selected } }));
  sessionStorage.setItem('gru-intake-recovery', JSON.stringify({ draft: { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: 'r1' }, pendingRevision: null, approvals }));
  h.view.bind(h.client as unknown as IntakeClient); await vi.waitFor(() => expect(h.button('Choose repository').disabled).toBe(false));
  const p = { ...proposal, plan: { ...proposal.plan, heists: selected.map((id) => ({ ...proposal.plan.heists[0]!, id })) } };
  h.client.preview.mockResolvedValueOnce(p); await h.preview(); await h.click('Review this revision');
  const selection = h.view as unknown as { selected: Set<string>; renderActions(): void };
  selected.forEach((id) => selection.selected.add(id)); selection.renderActions();
  const before = sessionStorage.getItem('gru-intake-recovery'); await h.click('Approve selected work');
  expect(h.client.approve).not.toHaveBeenCalled(); expect(sessionStorage.getItem('gru-intake-recovery')).toBe(before);
  expect(h.root.textContent).toContain('intake_recovery_storage_error');
  expect(JSON.parse(sessionStorage.getItem('gru-intake-recovery')!).approvals).toEqual(approvals);
}, 30_000);

it('reads healthy current draft independently of slow receipts with bounded progressive recovery', async () => {
  const h = fixture();
  const approvals = Array.from({ length: 6 }, (_, i) => ({ request: { repoPath: proposal.repoPath, intakeId: `slow-${i}`, requestId: 'r1', revisionId: i.toString(16).padStart(64, '0'), expectedToken: reviewed.review!.token, selected: ['one'] }, token: i.toString(16).padStart(64, '0') }));
  sessionStorage.setItem('gru-intake-recovery', JSON.stringify({ draft: { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: 'r1' }, pendingRevision: null, approvals }));
  const release: ((r: IntakeReadback) => void)[] = [];
  h.client.readback.mockImplementation((_repo, _intake, token) => token === undefined ? Promise.resolve(reviewed) : new Promise((resolve) => release.push(resolve)));
  h.view.bind(h.client as unknown as IntakeClient);
  await vi.waitFor(() => expect(h.root.textContent).toContain('Scope: Native capture'));
  expect(h.button('Choose repository').disabled).toBe(false); expect(release).toHaveLength(4);
  release[0]!({ ...partial, review: { ...partial.review!, intakeId: 'slow-0', revisionId: approvals[0]!.request.revisionId, token: approvals[0]!.token } });
  await vi.waitFor(() => expect(h.root.querySelector('.intake-approval-recovery')!.textContent).toContain('one → accepted-one'));
  expect(release).toHaveLength(5); h.view.bind(null);
  release[1]!(partial); await Promise.resolve(); expect(h.root.textContent).not.toContain('one → accepted-one'); expect(h.client.approve).not.toHaveBeenCalled();
});

it.each(['gaps', 'unmapped', 'plan-question', 'heist-question'])('disables new approval for known %s and shows corrective instructions', async (blocker) => {
  const h = fixture(); const p = { ...proposal, gaps: blocker === 'gaps' ? [{ code: 'missing', locator: 'source', question: 'Source missing' }] : [], plan: { ...proposal.plan, unmapped: blocker === 'unmapped' ? [{ requirementId: 'requirement', question: 'Requirement missing' }] : [], questions: blocker === 'plan-question' ? ['Plan missing'] : [], heists: proposal.plan.heists.map((heist) => ({ ...heist, unresolvedQuestions: blocker === 'heist-question' ? ['Heist missing'] : [] })) } } as Proposal;
  h.client.preview.mockResolvedValueOnce(p); await h.preview(); await h.click('Review this revision');
  const box = h.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!; box.checked = true; box.dispatchEvent(new Event('change'));
  expect(h.button('Approve selected work').disabled).toBe(true); expect(h.root.textContent).toContain(blocker === 'gaps' ? 'Repair or reselect source documents and preview again' : 'unmapped requirements and unanswered questions in the plan editor'); expect(h.client.approve).not.toHaveBeenCalled();
});

it('exposes immutable previous revision comparison in this intake disclosure', async () => {
  const h = fixture(); h.client.preview.mockResolvedValueOnce({ ...proposal, previousRequestId: 'prior' }); await h.preview();
  await h.click('Compare previous revision');
  expect(h.client.diff).toHaveBeenCalledWith(proposal.repoPath, proposal.intakeId, 'prior', 'r1'); expect(h.root.textContent).toContain('Acceptance changed'); expect(h.client.approve).not.toHaveBeenCalled();
});

it('fails intake visibly closed when durable browser storage is unavailable before effects', async () => {
  const h = fixture(); const unavailable = { getItem: () => { throw new Error('Unavailable'); }, setItem: () => { throw new Error('Unavailable'); }, removeItem: vi.fn() };
  const view = new IntakeView(h.root, h.picker, unavailable); view.bind(h.client as unknown as IntakeClient);
  const buttons = [...h.root.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent === 'Preview sources'); buttons.at(-1)!.click();
  await Promise.resolve(); expect(h.client.preview).not.toHaveBeenCalled(); expect(h.root.textContent).toContain('intake_recovery_storage_error');
});

it('validates all reader field limits before replacing a persisted draft or preview effects', async () => {
  const h = fixture(); await h.preview();
  const original = sessionStorage.getItem('gru-intake-recovery');
  h.picker.pickIntakeRepository.mockImplementationOnce((cb) => cb(`/${'r'.repeat(4096)}`)); await h.click('Choose repository');
  const kind = h.root.querySelector('select')!; kind.value = 'issue'; kind.dispatchEvent(new Event('change'));
  await h.click('Preview sources'); expect(h.client.preview).toHaveBeenCalledTimes(1); expect(sessionStorage.getItem('gru-intake-recovery')).toBe(original); expect(h.root.textContent).toContain('intake_recovery_storage_error');
});

it('retains original draft and pending metadata when durable storage write fails before revision POST', async () => {
  const h = fixture(); await h.preview(); const saved = sessionStorage.getItem('gru-intake-recovery');
  const editor = h.root.querySelector('textarea')!; editor.value = JSON.stringify({ ...proposal.plan, questions: ['new'] }); editor.dispatchEvent(new Event('input'));
  const write = vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('Quota exhausted'); });
  await h.click('Save new revision'); expect(h.client.revise).not.toHaveBeenCalled(); expect(sessionStorage.getItem('gru-intake-recovery')).toBe(saved); expect(h.root.textContent).toContain('intake_recovery_storage_error'); write.mockRestore();
  await h.click('Save new revision'); expect(h.client.revise).toHaveBeenCalledOnce();
});

it('keeps historical receipt concurrency bounded across overlapping recoveries and pairing generations', async () => {
  const h = fixture();
  const approvals = Array.from({ length: 8 }, (_, i) => ({ request: { repoPath: proposal.repoPath, intakeId: `history-${i}`, requestId: 'r1', revisionId: i.toString(16).padStart(64, '0'), expectedToken: null, selected: ['one'] }, token: i.toString(16).padStart(64, '0') }));
  sessionStorage.setItem('gru-intake-recovery', JSON.stringify({ draft: { repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: 'r1' }, pendingRevision: null, approvals }));
  const release: ((r: IntakeReadback) => void)[] = [];
  h.client.readback.mockImplementation((_repo, _intake, token) => token === undefined ? Promise.resolve(reviewed) : new Promise((resolve) => release.push(resolve)));
  h.view.bind(h.client as unknown as IntakeClient); await vi.waitFor(() => expect(h.button('Choose repository').disabled).toBe(false)); expect(release).toHaveLength(4);
  await h.click('Read back / recover'); expect(release).toHaveLength(4);
  h.view.bind(h.client as unknown as IntakeClient); await vi.waitFor(() => expect(h.button('Choose repository').disabled).toBe(false)); expect(release).toHaveLength(4);
  release[0]!(partial); await vi.waitFor(() => expect(release).toHaveLength(5));
  h.view.bind(null); release.slice(1).forEach((done) => done(partial)); await Promise.resolve(); expect(h.root.textContent).not.toContain('one → accepted-one');
});

describe('intake slicing by a planning minion (#429)', () => {
  it('commissions a planning minion for the shown revision and loads its sliced revision once it lands', async () => {
    const h = fixture();
    const commission = { repoPath: proposal.repoPath, intakeId: 'intake', requestId: 'r1', revisionId: proposal.revisionId, jobId: 'intake-slice-abc', resultRequestId: 'slice-abc', dispatched: true, jobStatus: 'queued' };
    const slice = vi.fn(async (_request: Parameters<IntakeClient['slice']>[0]) => commission);
    Object.assign(h.client, { slice });
    await h.preview();
    expect(h.button('Load sliced revision')).toBeUndefined();
    await h.click('Slice into heists (planning minion)');
    expect(slice).toHaveBeenCalledWith({ repoPath: proposal.repoPath, intakeId: 'intake', requestId: 'r1', revisionId: proposal.revisionId });
    const status = () => h.root.querySelector('.intake-status')!.textContent;
    expect(status()).toContain('Planning minion intake-slice-abc (queued) is slicing this revision. Its sliced plan lands as request slice-abc');
    expect(h.client.approve).not.toHaveBeenCalled();
    h.client.read.mockRejectedValueOnce(new IntakeClientError('intake_not_found', 'no completed preview'));
    await h.click('Load sliced revision');
    expect(status()).toBe('Planning minion intake-slice-abc has not submitted its breakdown yet.');
    const sliced = { ...proposal, requestId: 'slice-abc', previousRequestId: 'r1', revisionId: '9'.repeat(64) };
    h.client.read.mockResolvedValueOnce(sliced);
    await h.click('Load sliced revision');
    expect(h.client.read).toHaveBeenLastCalledWith(proposal.repoPath, 'intake', 'slice-abc');
    expect(status()).toContain('Sliced revision loaded');
    expect(h.root.textContent).toContain(`Snapshot revision: ${'9'.repeat(64)}`);
    expect(h.button('Compare previous revision')).toBeDefined();
    expect(h.button('Load sliced revision')).toBeUndefined();
  });

  it('offers no slicing while captured sources have gaps', async () => {
    const h = fixture();
    h.client.preview.mockResolvedValueOnce({ ...proposal, gaps: [{ code: 'intake_missing_architecture', locator: 'architecture.md', question: 'Supply it.' }] });
    await h.preview();
    expect(h.button('Slice into heists (planning minion)').disabled).toBe(true);
  });
});
