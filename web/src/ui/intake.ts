import { IntakeClient, IntakeClientError, type IntakeReadback, type Proposal, type Plan, type ReviewDecision } from '../lib/intake-client.js';
import type { AttachmentChip } from '../lib/protocol.js';
import { el } from './dom.js';
import { uuidV4 } from '../lib/uuid.js';

interface Picker {
  pickIntakeFile(callback: (chip: AttachmentChip, uploaded: boolean) => void, repoPath?: string, remaining?: number, batch?: (pending: boolean) => void): void;
  pickIntakeRepository(callback: (path: string) => void): void;
}
interface RecoveryIdentity { readonly repoPath: string; readonly intakeId: string; readonly requestId: string; }
/** Persist only identity and explicit intent, never readback briefing/source bytes.
 * An interrupted approval survives independently of the current draft/head. */
interface ApprovalRecovery {
  readonly request: ReviewDecision & { readonly selected: readonly string[] };
  readonly token?: string;
}
interface PendingRevision { readonly identity: RecoveryIdentity; readonly previous: RecoveryIdentity; }
const RECOVERY_KEY = 'gru-intake-recovery';
function parseRecovery(saved: string): { readonly draft: RecoveryIdentity | null; readonly pendingRevision: PendingRevision | null; readonly approvals: ApprovalRecovery[] } {
  const invalid = (): never => { throw new IntakeClientError('intake_recovery_storage_error', 'Invalid intake recovery storage. Restore a valid identity-only record or clear this tab’s intake recovery storage; no approval was sent.'); };
  if (saved.length > 2 * 1024 * 1024 || new TextEncoder().encode(saved).byteLength > 2 * 1024 * 1024) invalid();
  const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) invalid();
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, max: number): string => { if (typeof value !== 'string' || !value.trim() || value.length > max || /\p{Cc}/u.test(value)) invalid(); return value as string; };
  const id = (value: unknown): string => { const result = text(value, 128); if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(result)) invalid(); return result; };
  const identity = (value: unknown): RecoveryIdentity => { const raw = object(value, ['repoPath', 'intakeId', 'requestId']); return { repoPath: text(raw['repoPath'], 4096), intakeId: id(raw['intakeId']), requestId: id(raw['requestId']) }; };
  const token = (value: unknown): string => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) invalid(); return value as string; };
  const parsed: unknown = JSON.parse(saved);
  const raw = object(parsed, ['repoPath', 'intakeId', 'requestId', 'draft', 'pendingRevision', 'approvals']);
  if ('repoPath' in raw) return { draft: identity(parsed), pendingRevision: null, approvals: [] };
  const approvals = raw['approvals'] === undefined ? [] : raw['approvals'];
  if (!Array.isArray(approvals) || approvals.length > 128) invalid();
  const validated = (approvals as unknown[]).map((value): ApprovalRecovery => {
    const item = object(value, ['request', 'token']);
    const request = object(item['request'], ['repoPath', 'intakeId', 'requestId', 'revisionId', 'expectedToken', 'selected']);
    const selected = request['selected'];
    if (!Array.isArray(selected) || selected.length === 0 || selected.length > 4000 || new Set(selected).size !== selected.length) invalid();
    return { request: { repoPath: text(request['repoPath'], 4096), intakeId: id(request['intakeId']), requestId: id(request['requestId']), revisionId: token(request['revisionId']), expectedToken: request['expectedToken'] === null ? null : token(request['expectedToken']), selected: (selected as unknown[]).map((id) => text(id, 128)) }, ...(item['token'] === undefined ? {} : { token: token(item['token']) }) };
  });
  const keys = validated.map(({ request }) => JSON.stringify([request.repoPath, request.intakeId, request.revisionId]));
  if (new Set(keys).size !== keys.length) invalid();
  const pending = raw['pendingRevision'] == null ? null : object(raw['pendingRevision'], ['identity', 'previous']);
  return { draft: raw['draft'] == null ? null : identity(raw['draft']), approvals: validated, pendingRevision: pending === null ? null : { identity: identity(pending['identity']), previous: identity(pending['previous']) } };
}

/** A disclosure within the existing chat, never another conversation.
 * Persistence contains identities only; mount/reconnect performs reads only. */
export class IntakeView {
  private client: IntakeClient | null = null;
  private generation = 0;
  private sourceGeneration = 0;
  private approvals: ApprovalRecovery[] = [];
  private approvalReadbacks = new Map<string, IntakeReadback>();
  private readonly approvalErrors = new Map<string, string>();
  private pendingRevision: PendingRevision | null = null;
  private readonly recoveryBody = el('div', 'intake-approval-recovery');
  private lockedInputs: { readonly repo: string; readonly kind: string; readonly issue: string; readonly comments: string; readonly editor: string } | null = null;
  private busy = false;
  private storageError = false;
  private documentsPending = false;
  private receiptActive = 0;
  private readonly receiptWaiters = new Set<() => void>();
  private proposal: Proposal | null = null;
  private readback: IntakeReadback | null = null;
  private readonly repo = el('input', 'pp-input');
  private readonly kind = el('select', 'pp-input');
  private readonly issue = el('input', 'pp-input');
  private readonly comments = el('input', 'pp-input');
  private readonly documents = el('div', 'intake-documents');
  private files: { readonly chip: AttachmentChip; readonly uploaded: boolean }[] = [];
  private readonly reviewBody = el('div', 'intake-review');
  private readonly editor = el('textarea', 'pp-input intake-editor');
  private readonly status = el('div', 'intake-status');
  private readonly actions = el('div', 'intake-actions');
  private readonly selected = new Set<string>();
  private buttons: HTMLButtonElement[] = [];
  private identity: RecoveryIdentity | null = null;

  constructor(private readonly root: HTMLElement, private readonly picker: Picker, private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = null) {
    const disclosure = el('details', 'intake');
    disclosure.append(el('summary', '', 'Review source intake'));
    const body = el('div', 'intake-body');
    this.repo.readOnly = true; this.repo.setAttribute('aria-label', 'Intake repository');
    this.issue.placeholder = '#123 or GitHub issue URL'; this.issue.setAttribute('aria-label', 'Issue reference');
    this.comments.placeholder = 'Selected comment IDs (comma separated, optional)'; this.comments.setAttribute('aria-label', 'Issue comment IDs');
    for (const kind of ['issue', 'spec', 'bmad']) { const option = el('option', '', kind === 'bmad' ? 'BMAD documents' : kind); option.value = kind; this.kind.append(option); }
    this.kind.setAttribute('aria-label', 'Intake source');
    const repoButton = this.button('Choose repository', () => {
      const client = this.client, generation = ++this.sourceGeneration;
      this.picker.pickIntakeRepository((path) => {
        if (this.busy || this.client !== client || this.sourceGeneration !== generation) return;
        if (this.repo.value !== path) { this.files = []; this.renderFiles(); }
        this.repo.value = path; this.invalidateSource();
      });
    });
    const filesButton = this.button('Browse / upload documents', () => {
      if (!this.repo.value) { this.status.textContent = 'Choose a managed repository first.'; return; }
      const client = this.client, generation = ++this.sourceGeneration;
      this.documentsPending = false; this.renderActions();
      this.picker.pickIntakeFile((chip, uploaded) => {
        if (this.busy || this.client !== client || this.sourceGeneration !== generation) return;
        if (this.files.length >= 8) { this.status.textContent = 'At most eight explicit documents.'; return; }
        if (!this.files.some((file) => file.chip.path === chip.path)) this.files = [...this.files, { chip, uploaded }];
        this.invalidateSource(false); this.renderFiles();
      }, this.repo.value, 8 - this.files.length, (pending) => {
        if (this.client !== client || this.sourceGeneration !== generation) return;
        this.documentsPending = pending;
        this.lockedInputs = pending ? { repo: this.repo.value, kind: this.kind.value, issue: this.issue.value, comments: this.comments.value, editor: this.editor.value } : null;
        this.renderActions();
        this.status.textContent = pending ? 'Wait for the complete document upload batch before preview.' : 'Complete document batch finished; preview all selected documents.';
      });
    });
    this.kind.addEventListener('change', () => { if (!this.guardInputs()) return; this.invalidateSource(); this.renderSource(); });
    this.issue.addEventListener('input', () => { if (this.guardInputs()) this.invalidateSource(); });
    this.comments.addEventListener('input', () => { if (this.guardInputs()) this.invalidateSource(); });
    this.editor.setAttribute('aria-label', 'Concrete intake plan JSON');
    this.editor.addEventListener('input', () => { if (!this.guardInputs()) return; this.sourceGeneration += 1; this.renderActions(); });
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    body.append(this.repo, repoButton, this.kind, this.issue, this.comments, filesButton, this.documents);
    body.append(this.button('Preview sources', () => { void this.preview(); }), this.button('Read back / recover', () => { void this.recover(); }), this.reviewBody, this.editor, this.actions, this.recoveryBody, this.status);
    disclosure.append(body); root.append(disclosure);
    this.renderSource(); this.renderActions();
  }
  bind(client: IntakeClient | null): void {
    this.generation += 1; this.wakeReceiptWaiters(); this.sourceGeneration += 1; this.client = client; this.busy = false; this.lockedInputs = null;
    this.proposal = null; this.readback = null; this.selected.clear(); this.reviewBody.replaceChildren(); this.editor.value = ''; this.editor.hidden = true;
    this.documentsPending = false; this.files = []; this.repo.value = ''; this.issue.value = ''; this.comments.value = ''; this.renderFiles();
    this.identity = null; this.approvals = []; this.pendingRevision = null; this.approvalReadbacks.clear(); this.approvalErrors.clear();
    this.storageError = false;
    try {
      if (this.storage === null) throw new Error('Durable tab storage is unavailable');
      const saved = this.storage.getItem(RECOVERY_KEY);
      if (saved) {
        const recovery = parseRecovery(saved);
        this.identity = recovery.draft; this.approvals = recovery.approvals; this.pendingRevision = recovery.pendingRevision;
      }
      this.persistRecovery();
      this.status.textContent = '';
    } catch (error) {
      this.storageError = true;
      this.status.textContent = error instanceof IntakeClientError ? `${error.code}: ${error.message}` : 'intake_recovery_storage_error: Cannot read intake recovery storage. Restore or clear this tab’s identity-only recovery record.';
    }
    this.renderActions();
    if (!this.storageError && client !== null && (this.identity !== null || this.approvals.length > 0)) void this.recover();
  }
  clearRecovery(): void {
    try { this.commitRecovery(null, null, []); this.storageError = false; this.approvalReadbacks.clear(); this.approvalErrors.clear(); }
    catch (error) { this.storageError = true; this.status.textContent = String(error); }
    this.renderActions();
  }
  private button(label: string, action: () => void): HTMLButtonElement {
    const button = el('button', 'pp-btn pp-btn--secondary', label); button.type = 'button'; button.addEventListener('click', () => { if (!button.disabled && this.client !== null && !this.busy && !this.documentsPending && !this.storageError) action(); }); this.buttons.push(button); return button;
  }
  private renderSource(): void { this.issue.hidden = this.kind.value !== 'issue'; this.comments.hidden = this.kind.value !== 'issue'; this.documents.hidden = this.kind.value === 'issue'; }
  private guardInputs(): boolean {
    if (!this.busy && !this.documentsPending) return true;
    if (this.lockedInputs) {
      this.repo.value = this.lockedInputs.repo; this.kind.value = this.lockedInputs.kind; this.issue.value = this.lockedInputs.issue; this.comments.value = this.lockedInputs.comments; this.editor.value = this.lockedInputs.editor;
    }
    return false;
  }
  private invalidateSource(invalidatePicker = true): void {
    if (this.busy) return;
    if (invalidatePicker) { this.sourceGeneration += 1; this.documentsPending = false; }
    this.generation += 1; this.proposal = null; this.readback = null; this.selected.clear(); this.reviewBody.replaceChildren(); this.editor.hidden = true; this.editor.value = ''; this.renderActions();
  }
  private renderFiles(): void {
    this.documents.replaceChildren();
    this.files.forEach(({ chip }, index) => {
      const row = el('div', '', `${index === 0 ? 'Primary' : 'Supporting'}: ${chip.name}`);
      row.append(this.button(`Remove ${chip.name}`, () => { this.files = this.files.filter((_, i) => i !== index); this.invalidateSource(); this.renderFiles(); })); this.documents.append(row);
    });
  }
  private commitRecovery(draft: RecoveryIdentity | null, pendingRevision: PendingRevision | null, approvals: ApprovalRecovery[]): void {
    try {
      const serialized = JSON.stringify({ draft, pendingRevision, approvals });
      parseRecovery(serialized); // Writer and reader have exactly the same contract.
      if (this.storage === null) throw new Error('Durable tab storage is unavailable');
      this.storage.setItem(RECOVERY_KEY, serialized);
    } catch (error) {
      throw new IntakeClientError('intake_recovery_storage_error', `Cannot retain recoverable intake identities: ${String(error)}. Original identities retained; restore durable tab storage or use a new tab before any new decision.`);
    }
    this.identity = draft; this.pendingRevision = pendingRevision; this.approvals = approvals;
  }
  private persistRecovery(): void { this.commitRecovery(this.identity, this.pendingRevision, this.approvals); }
  private saveIdentity(identity: RecoveryIdentity, pending = this.pendingRevision): void { this.commitRecovery(identity, pending, this.approvals); }
  private rememberApproval(request: ApprovalRecovery['request'], readback?: IntakeReadback): void {
    const token = readback?.review?.status === 'approved' ? readback.review.token : undefined;
    const previous = this.approvals.find((item) => item.request.revisionId === request.revisionId && item.request.intakeId === request.intakeId && item.request.repoPath === request.repoPath);
    if (previous && JSON.stringify(previous.request) !== JSON.stringify(request)) throw new IntakeClientError('intake_approval_pending', `Original approval ${previous.request.requestId} is unconfirmed or accepted. Read back or explicitly retry its original selection before changing it.`);
    if (previous === undefined && this.approvals.length >= 128) throw new IntakeClientError('intake_recovery_storage_error', 'This tab retains 128 original approvals. Use another tab for new intake, retaining these original identities; no approval was sent.');
    const knownToken = token ?? previous?.token;
    const recovery = { request, ...(knownToken === undefined ? {} : { token: knownToken }) };
    this.commitRecovery(this.identity, this.pendingRevision, [...this.approvals.filter((item) => item !== previous), recovery]);
    if (readback) { this.approvalReadbacks.set(request.revisionId, readback); this.approvalErrors.delete(request.revisionId); }
  }
  private async transmitApproval(client: IntakeClient, request: ApprovalRecovery['request']): Promise<IntakeReadback> {
    const generation = this.generation;
    const current = (): boolean => this.client === client && this.generation === generation;
    this.rememberApproval(request);
    try {
      const readback = await client.approve(request); if (current()) this.rememberApproval(request, readback); return readback;
    } catch (error) {
      if (current() && error instanceof IntakeClientError) {
        if (error.readback) this.rememberApproval(request, error.readback);
        else if (['intake_dependency_selection', 'intake_incomplete_plan', 'intake_invalid_request', 'intake_invalid_plan', 'intake_output_bounds', 'intake_stale_review', 'intake_stale_revision'].includes(error.code)) {
          // These named refusals precede acceptance; a corrected selection is safe.
          this.commitRecovery(this.identity, this.pendingRevision, this.approvals.filter((item) => item.request !== request || item.token !== undefined));
        }
      }
      throw error;
    }
  }
  private async run(operation: (client: IntakeClient, current: () => boolean) => Promise<void>): Promise<void> {
    if (this.client === null || this.busy) return;
    if (this.documentsPending) { this.status.textContent = 'Wait for the complete document upload batch before making an intake decision.'; return; }
    const client = this.client; const generation = ++this.generation; this.wakeReceiptWaiters();
    const current = (): boolean => this.client === client && this.generation === generation;
    this.sourceGeneration += 1;
    this.lockedInputs = { repo: this.repo.value, kind: this.kind.value, issue: this.issue.value, comments: this.comments.value, editor: this.editor.value };
    this.busy = true; this.status.textContent = 'Loading intake…'; this.renderActions();
    try { if (this.storageError) throw new IntakeClientError('intake_recovery_storage_error', 'Restore durable tab storage and rebind intake before making decisions.'); this.persistRecovery(); await operation(client, current); }
    catch (error) { if (current()) { if (error instanceof IntakeClientError && error.readback && error.readback.review?.revisionId === this.proposal?.revisionId) this.readback = error.readback; this.status.textContent = `${error instanceof IntakeClientError ? `${error.code}: ` : ''}${error instanceof Error ? error.message : String(error)} ${this.receiptText()}`; } }
    finally { if (current()) { this.busy = false; this.lockedInputs = null; this.renderActions(); } }
  }
  private async preview(): Promise<void> {
    await this.run(async (client, current) => {
      if (this.pendingRevision) throw new Error('Recover or explicitly abandon the pending revision before replacing it.');
      if (this.documentsPending) throw new Error('Wait for the complete document upload batch before preview.');
      if (!this.repo.value) throw new Error('Choose a managed repository first.');
      const document = ({ chip, uploaded }: typeof this.files[number]) => uploaded ? { uploadPath: chip.path } : { path: chip.path.startsWith(`${this.repo.value}/`) ? chip.path.slice(this.repo.value.length + 1) : chip.path };
      const kind = this.kind.value as 'issue' | 'spec' | 'bmad';
      if (kind !== 'issue' && !this.files[0]) throw new Error('Choose the primary source document.');
      const source = kind === 'issue' ? { kind, reference: this.issue.value, commentIds: this.comments.value.trim() === '' ? [] : this.comments.value.split(',').map((id) => Number(id.trim())) } : { kind, document: document(this.files[0]!), supporting: this.files.slice(1).map(document) };
      const identity = { repoPath: this.repo.value, intakeId: `intake-${uuidV4()}`, requestId: `r-${uuidV4()}` };
      this.saveIdentity(identity, null);
      const proposal = await client.preview({ ...identity, source });
      if (!current()) return;
      this.showProposal(proposal);
      const readback = await client.readback(identity.repoPath, identity.intakeId);
      if (!current()) return;
      this.readback = readback;
      this.status.textContent = 'Preview only: zero executable work. Review this revision before deciding.';
    });
  }
  private wakeReceiptWaiters(): void {
    const waiters = [...this.receiptWaiters]; this.receiptWaiters.clear(); waiters.forEach((wake) => wake());
  }
  private async readReceipt(client: IntakeClient, recovery: ApprovalRecovery, current: () => boolean): Promise<IntakeReadback | null> {
    // The bound survives overlapping recovery generations and re-pairing;
    // superseded requests may still be consuming their timeout budget.
    while (current() && this.receiptActive >= 4) await new Promise<void>((resolve) => { this.receiptWaiters.add(resolve); });
    if (!current()) return null;
    this.receiptActive += 1;
    try { return await client.readback(recovery.request.repoPath, recovery.request.intakeId, recovery.token); }
    finally { this.receiptActive -= 1; this.wakeReceiptWaiters(); }
  }
  private async recover(): Promise<void> {
    await this.run(async (client, current) => {
      let identity = this.pendingRevision?.identity ?? this.identity;
      // Historical receipts cannot delay the current draft. Four bounded
      // workers publish individual rows/errors as they arrive, with the same
      // generation guard as the draft read. Recovery never sends approval.
      const receipts = [...this.approvals];
      let nextReceipt = 0;
      const worker = async (): Promise<void> => {
        while (current() && nextReceipt < receipts.length) {
          const recovery = receipts[nextReceipt++]!;
          try {
            const readback = await this.readReceipt(client, recovery, current);
            if (!current() || readback === null) return;
            if (readback.review?.status === 'approved' && readback.review.revisionId === recovery.request.revisionId) this.rememberApproval(recovery.request, readback);
            this.approvalErrors.delete(recovery.request.revisionId);
          } catch (error) {
            if (!current()) return;
            this.approvalErrors.set(recovery.request.revisionId, `${error instanceof IntakeClientError ? error.code : 'intake_unreachable'}: ${error instanceof Error ? error.message : String(error)}. Original identity retained; read back again or explicitly retry only that original approval.`);
          }
          this.renderApprovalRecovery();
        }
      };
      const receiptReads = Promise.all(Array.from({ length: Math.min(4, receipts.length) }, worker));
      if (identity !== null) {
        let recoveredPending = this.pendingRevision !== null;
        let proposal: Proposal;
        try { proposal = await client.read(identity.repoPath, identity.intakeId, identity.requestId); }
        catch (error) {
          if (!current()) return;
          if (!(error instanceof IntakeClientError) || error.code !== 'intake_not_found' || !this.pendingRevision) throw error;
          // Absence is not proof that a disconnected POST cannot still commit.
          // Read the previous proposal, but retain the original pending identity.
          identity = this.pendingRevision.previous; recoveredPending = false; this.saveIdentity(identity);
          proposal = await client.read(identity.repoPath, identity.intakeId, identity.requestId);
        }
        if (!current()) return;
        const readback = await client.readback(identity.repoPath, identity.intakeId);
        if (!current()) return;
        if (recoveredPending) this.saveIdentity(identity, null);
        this.showProposal(proposal); this.readback = readback;
        if (readback.review?.revisionId === proposal.revisionId && readback.review.status === 'approved') { this.selected.clear(); readback.review.selected.forEach((id) => this.selected.add(id)); }
        this.status.textContent = this.receiptText();
      }
      if (identity === null) {
        if (this.approvals.length === 0) throw new Error('No intake identity to recover. Preview a source first.');
        await receiptReads; if (!current()) return;
        this.status.textContent = 'Original approval receipts refreshed below. Recovery reads only; explicitly retry an original approval if needed.';
      }
    });
  }
  private receiptText(): string {
    if (!this.readback?.review) return 'Preview only: no reviewed decision or accepted work.';
    return `${this.readback.review.status}. Accepted: ${this.readback.accepted.map((item) => `${item.heistId} → ${item.entryId} (${item.state})`).join(', ') || 'none'}. Remaining: ${this.readback.remaining.map((item) => `${item.heistId} → ${item.entryId}`).join(', ') || 'none'}.`;
  }
  private decision(): ReviewDecision {
    const p = this.proposal!;
    return { repoPath: p.repoPath, intakeId: p.intakeId, requestId: p.requestId, revisionId: p.revisionId, expectedToken: this.readback?.review?.token ?? null };
  }
  private dirty(): boolean { return this.proposal !== null && this.editor.value !== JSON.stringify(this.proposal.plan, null, 2); }
  private renderActions(): void {
    this.actions.replaceChildren();
    this.buttons = this.buttons.filter((button) => this.root.contains(button));
    for (const button of this.buttons) button.disabled = this.client === null || this.busy || this.storageError || this.documentsPending || button.textContent === 'Preview sources' && this.pendingRevision !== null;
    for (const input of [this.repo, this.kind, this.issue, this.comments, this.editor]) input.disabled = this.client === null || this.busy || this.documentsPending;
    this.editor.hidden = this.proposal === null;
    this.renderApprovalRecovery();
    const action = (label: string, enabled: boolean, operation: (client: IntakeClient, current: () => boolean) => Promise<void>): void => {
      const button = this.button(label, () => { void this.run(operation); }); button.disabled = !enabled || this.client === null || this.busy || this.storageError || this.documentsPending; this.actions.append(button);
    };
    if (this.pendingRevision) action('Abandon pending revision', true, async () => {
      this.saveIdentity(this.pendingRevision!.previous, null);
      this.status.textContent = 'Pending identity explicitly abandoned in this tab. No replacement revision or approval was sent; any committed original revision remains on the server.';
    });
    if (!this.proposal) return;
    const same = this.readback?.review?.revisionId === this.proposal.revisionId;
    const reviewed = same && this.readback?.review?.status === 'reviewed';
    const approved = same && this.readback?.review?.status === 'approved';
    for (const checkbox of this.reviewBody.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      const id = checkbox.dataset.heistId!;
      checkbox.checked = this.selected.has(id);
      checkbox.disabled = approved || this.busy;
    }
    if (this.proposal.previousRequestId) action('Compare previous revision', true, async (client, current) => {
      const p = this.proposal!; const comparison = await client.diff(p.repoPath, p.intakeId, p.previousRequestId!, p.requestId);
      if (!current()) return;
      const details = el('details'); details.open = true; details.append(el('summary', '', 'Immutable revision comparison'), el('pre', '', JSON.stringify(comparison, null, 2))); this.reviewBody.append(details);
      this.status.textContent = 'Compare captured scope, acceptance, dependencies and provenance before review or approval.';
    });
    action('Save new revision', this.dirty() && this.pendingRevision === null, async (client, current) => {
      const p = this.proposal!; const plan = JSON.parse(this.editor.value) as Plan;
      const identity = { repoPath: p.repoPath, intakeId: p.intakeId, requestId: `r-${uuidV4()}` };
      const previous = { repoPath: p.repoPath, intakeId: p.intakeId, requestId: p.requestId };
      this.saveIdentity(identity, { identity, previous });
      let proposal: Proposal;
      try { proposal = await client.revise({ ...identity, previousRequestId: p.requestId, revisionId: p.revisionId, plan }); }
      catch (error) {
        if (current() && error instanceof IntakeClientError && ['intake_invalid_request', 'intake_invalid_plan', 'intake_stale_revision', 'intake_output_bounds', 'intake_replay_conflict', 'intake_aggregate_bounds', 'intake_source_bounds'].includes(error.code)) { this.saveIdentity(previous, null); }
        throw error;
      }
      if (!current()) return;
      this.saveIdentity(identity, null); this.showProposal(proposal); this.status.textContent = 'New captured revision; review again before approval.';
    });
    action('Review this revision', !this.dirty() && !reviewed && !approved && !(same && this.readback?.review?.status === 'rejected'), async (client, current) => {
      const readback = await client.review(this.decision()); if (!current()) return; this.readback = readback; this.status.textContent = 'Reviewed. Select complete work and explicitly approve, or reject.';
    });
    action('Reject revision', reviewed && !this.dirty(), async (client, current) => {
      const readback = await client.reject(this.decision()); if (!current()) return; this.readback = readback; this.status.textContent = this.receiptText();
    });
    const blocked = this.proposal.gaps.length > 0 || this.proposal.plan.unmapped.length > 0 || this.proposal.plan.questions.length > 0 || this.proposal.plan.heists.some((heist) => this.selected.has(heist.id) && heist.unresolvedQuestions.length > 0);
    if (blocked && !approved) this.actions.append(el('p', '', 'Resolve source gaps, unmapped requirements and unanswered questions in the plan editor, save a new revision, then review again before approval.'));
    action(approved ? 'Retry identical approval' : 'Approve selected work', !this.dirty() && this.selected.size > 0 && (reviewed && !blocked || approved && (this.readback?.remaining.length ?? 0) > 0), async (client, current) => {
      const d = this.decision();
      const original = this.approvals.find(({ request }) => request.repoPath === d.repoPath && request.intakeId === d.intakeId && request.revisionId === d.revisionId);
      const request = approved ? original?.request ?? { ...d, expectedToken: this.readback!.review!.previousToken, selected: this.readback!.review!.selected } : { ...d, selected: [...this.selected] };
      const readback = await this.transmitApproval(client, request); if (!current()) return; this.readback = readback; this.status.textContent = this.receiptText();
    });
  }
  private renderApprovalRecovery(): void {
    this.recoveryBody.replaceChildren();
    for (const recovery of this.approvals) {
      const readback = this.approvalReadbacks.get(recovery.request.revisionId);
      const row = el('div', '', `Original approval ${recovery.request.requestId}. Accepted: ${readback?.accepted.map(({ heistId, entryId }) => `${heistId} → ${entryId}`).join(', ') || (readback ? 'none' : 'not confirmed')}. Remaining: ${readback?.remaining.map(({ heistId, entryId }) => `${heistId} → ${entryId}`).join(', ') || (readback ? 'none' : `not confirmed (${recovery.request.selected.join(', ')})`)}.`);
      const error = this.approvalErrors.get(recovery.request.revisionId);
      if (error) row.append(el('p', '', error));
      if (!readback || readback.remaining.length > 0) {
        const retry = this.button(`Retry original approval ${recovery.request.requestId}`, () => { void this.run(async (client, current) => {
          const result = await this.transmitApproval(client, recovery.request);
          if (!current()) return;
          if (this.proposal?.revisionId === result.review?.revisionId) this.readback = result;
          this.status.textContent = `Original approval ${recovery.request.requestId} read back; accepted and remaining identities below.`;
        }); });
        retry.disabled = this.client === null || this.busy || this.storageError || this.documentsPending; row.append(retry);
      }
      this.recoveryBody.append(row);
    }
  }
  private showProposal(proposal: Proposal): void {
    this.saveIdentity({ repoPath: proposal.repoPath, intakeId: proposal.intakeId, requestId: proposal.requestId });
    this.proposal = proposal; this.selected.clear(); this.repo.value = proposal.repoPath;
    this.editor.value = JSON.stringify(proposal.plan, null, 2);
    if (this.busy && this.lockedInputs) this.lockedInputs = { ...this.lockedInputs, repo: this.repo.value, editor: this.editor.value };
    this.reviewBody.replaceChildren(el('p', '', `Repository: ${proposal.repoPath}\nSnapshot revision: ${proposal.revisionId}`));
    for (const snapshot of proposal.snapshots) {
      const details = el('details'); details.append(el('summary', '', `${snapshot.kind}: ${snapshot.locator} · ${snapshot.revision} · ${snapshot.sha256}`), el('pre', '', snapshot.text)); this.reviewBody.append(details);
    }
    for (const heist of proposal.plan.heists) {
      const label = el('label', 'intake-selection'); const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.dataset.heistId = heist.id; checkbox.setAttribute('aria-label', `Select ${heist.id}`);
      checkbox.addEventListener('change', () => { if (this.busy || checkbox.disabled) { checkbox.checked = this.selected.has(heist.id); return; } if (checkbox.checked) this.selected.add(heist.id); else this.selected.delete(heist.id); this.renderActions(); });
      label.append(checkbox, document.createTextNode(`${heist.id}: ${heist.title}`));
      const text = [`Goal: ${heist.goal.text}`, `Scope: ${heist.scope.map(({ text }) => text).join('\n')}`, `Exclusions: ${heist.exclusions.map(({ text }) => text).join('\n')}`, `Acceptance: ${heist.acceptance.map(({ text }) => text).join('\n')}`, `Verification: ${heist.verification.map(({ text }) => text).join('\n')}`, `Dependencies: ${heist.dependencies.map(({ id, milestone }) => `${id} → ${milestone}`).join(', ') || 'none'}`, `Questions: ${heist.unresolvedQuestions.join('\n') || 'none'}`];
      this.reviewBody.append(label, el('pre', '', text.join('\n\n')));
    }
    this.reviewBody.append(el('pre', '', `Source gaps: ${proposal.gaps.map(({ question }) => question).join('\n') || 'none'}\nUnresolved: ${proposal.plan.questions.join('\n') || 'none'}\nUnmapped: ${proposal.plan.unmapped.map(({ question }) => question).join('\n') || 'none'}`));
  }
}
