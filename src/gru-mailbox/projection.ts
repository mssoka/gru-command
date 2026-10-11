import { LIVE_DIRECTIVE_STATES } from '../ledger/directives.js';
import { createHash } from 'node:crypto';
import type { DecisionRecord, LedgerApi, NotificationRecord, ObligationRecord } from '../ledger/api.js';
import { producerResolvedBy } from '../ledger/api.js';
import { isJobTerminal } from '../ledger/states.js';
import type { MailboxDisposition, MailboxItem, MailboxReason, MailboxReference } from '../ledger/mailbox.js';
import { incidentSignalOf, incidentSubjectOf } from '../chat/incident.js';

function notificationIdentity(row: NotificationRecord): string {
  return row.kind.includes(':') || producerResolvedBy(row.kind) !== null
    ? `${row.kind}:${row.agentId ?? 'service'}` : `notification:${row.id}`;
}
function notificationBasis(row: NotificationRecord): string {
  return mailboxBasis([notificationIdentity(row), row.kind, row.detail, row.severity]);
}

export function mailboxBasis(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Eligibility is server-owned. No title, delivery, or parent status supplies closure evidence. */
export function projectMailbox(ledger: LedgerApi, now = Date.now(), onNextRecheck?: (at: number) => void): readonly MailboxItem[] {
  const jobs = ledger.listJobs();
  const agents = ledger.listAgents();
  const surfaced = new Map(ledger.listMailboxItems().map((item) => [item.id, item]));
  const stops = ledger.durableSupervisionStops();
  const jobByAgent = new Map(agents.map((agent) => [agent.id, agent.jobId]));
  const notifications: NotificationRecord[] = [];
  for (let offset = 0;; offset += 500) {
    const page = ledger.listNotifications({ routing: 'action-required', unackedOnly: true, limit: 500, offset });
    notifications.push(...page);
    if (page.length < 500) break;
  }
  const bound = new Map<string, NotificationRecord[]>();
  const incidents = new Map<string, NotificationRecord[]>();
  for (const row of notifications) {
    const jobId = row.agentId === null ? null : jobByAgent.get(row.agentId) ?? null;
    // Unknown agent bindings are incidents, never guessed job membership.
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (job !== undefined) {
      if (isJobTerminal(job.status)) continue; // retained in the notification receipt surface
      bound.set(job.id, [...(bound.get(job.id) ?? []), row]);
    } else {
      const key = notificationIdentity(row);
      incidents.set(key, [...(incidents.get(key) ?? []), row]);
    }
  }
  const items: MailboxItem[] = [];
  const make = (id: string, subject: string, jobId: string | null, title: string, reasons: readonly MailboxReason[], rows: readonly NotificationRecord[], references: readonly MailboxReference[], restrictions: readonly string[], context: unknown = null): MailboxItem => {
    const ordered = reasons.map((reason) => ({ ...reason, basis: mailboxBasis([reason.basis, context]) })).sort((a, b) => a.signal.localeCompare(b.signal) || a.basis.localeCompare(b.basis));
    const basis = mailboxBasis(ordered.map((reason) => [reason.signal, reason.basis]));
    return { id, subject, jobId, title, kind: jobId === null ? 'incident' : 'job', reasons: ordered, basis,
      severity: rows.some((row) => row.severity === 'error') || ordered.some((reason) => ['blocked', 'worker-error', 'round-aborted', 'lens-failed', 'pr-conflict'].includes(reason.signal)) ? 'error' : 'info',
      notificationIds: rows.map((row) => row.id).sort(), producerOwned: rows.some((row) => producerResolvedBy(row.kind) !== null),
      state: 'needs-gru', owner: 'gru', disposition: null, receipt: null, references, restrictions,
      attentionKey: `${id}@${basis}` };
  };
  for (const job of jobs) {
    if (isJobTerminal(job.status)) continue;
    const reasons: MailboxReason[] = [];
    const references: MailboxReference[] = [];
    const restrictions: string[] = [];
    const followUpAt: string[] = [];
    const add = (signal: string, label: string, evidence: unknown): void => {
      reasons.push({ signal, label, basis: mailboxBasis(evidence) });
    };
    if (job.status === 'blocked') {
      // Status recurrence and changed failure evidence reopen, unrelated job label edits do not.
      add(job.status, job.status, [job.status, job.note, ledger.latestJobEvent(job.id, 'job.status')?.seq ?? null]);
    }
    const worker = ledger.listImplementerMinions(job.id)[0];
    if (worker !== undefined) references.push({ kind: 'agent', id: worker.id });
    if (worker?.state === 'error') add('worker-error', 'minion error', [worker.id, worker.updatedAt]);
    const stopEvidence: unknown[] = [];
    for (const agent of agents.filter((candidate) => candidate.jobId === job.id && stops.has(candidate.id))) {
      const stop = stops.get(agent.id)!;
      const event = ledger.latestSupervisionEvent(agent.id);
      references.push({ kind: 'agent', id: agent.id });
      if (event !== null) references.push({ kind: 'event', id: String(event.seq) });
      restrictions.push(`owner stop on ${agent.id}: ${stop.reason ?? 'supervision stopped'}; fresh owner authorization required, recheck grants no restart authority`);
      stopEvidence.push([agent.id, event?.seq, stop.reason, stop.restarts]);
    }
    const round = ledger.listRounds(job.id).at(-1);
    if (round !== undefined) {
      if (round.status === 'aborted') add('round-aborted', 'round aborted', [round.id, round.targetRef, round.status]);
      else if (round.status !== 'verdict-posted' && round.lenses.some((lens) => lens.state === 'error')) {
        add('lens-failed', 'lens failed', [round.id, round.targetRef, round.lenses.filter((lens) => lens.state === 'error').map((lens) => [lens.lens, lens.note, lens.updatedAt])]);
      }
    }
    const branch = ledger.latestJobEvent(job.id, 'github.branch-state');
    if (branch !== null) {
      const payload = branch.payload;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error(`mailbox malformed PR evidence for ${job.id}`);
      const evidence = payload as Record<string, unknown>;
      const nullableString = (value: unknown): boolean => value === null || (typeof value === 'string' && value.trim() !== '');
      const hadConflict = surfaced.get(`job:${job.id}`)?.reasons.some((reason) => reason.signal === 'pr-conflict') === true;
      const hasOpen = Object.hasOwn(evidence, 'pr_open');
      if (!nullableString(evidence['pr_url']) || !nullableString(evidence['mergeable_state']) || !nullableString(evidence['sha'])
        || (hasOpen && evidence['pr_open'] !== null && typeof evidence['pr_open'] !== 'boolean') || (!hasOpen && hadConflict)) {
        throw new Error(`mailbox malformed PR evidence for ${job.id}: expected canonical pr_url, pr_open, mergeable_state and sha values`);
      }
      // Pre-open-status observations remain readable as unknown, never eligible.
      // Once a conflict surfaced, an unobserved pull/head/mergeability cannot
      // certify its closure. Explicit same-pull closed evidence still can.
      if (hadConflict && job.prUrl !== null && (evidence['pr_url'] !== job.prUrl || evidence['pr_open'] === null
        || (evidence['pr_open'] !== false && (evidence['sha'] === null || evidence['mergeable_state'] === null || evidence['mergeable_state'] === 'unknown')))) {
        throw new Error(`mailbox PR closure evidence unavailable for ${job.id}: re-observe the pull before clearing retained attention`);
      }
      if (evidence['pr_url'] === job.prUrl && job.prUrl !== null && evidence['pr_open'] === true && evidence['mergeable_state'] === 'dirty') {
        if (typeof evidence['sha'] !== 'string' || evidence['sha'] === '') throw new Error(`mailbox conflicting PR evidence for ${job.id} is missing head sha`);
        add('pr-conflict', 'PR conflicting', [job.prUrl, evidence['sha'], 'dirty']);
      }
    }
    const rows = bound.get(job.id) ?? [];
    const distinctNotifications = new Map(rows.map((row) => [`${notificationIdentity(row)}:${notificationBasis(row)}`, row]));
    for (const row of distinctNotifications.values()) add(incidentSignalOf(row), 'action-required', [notificationIdentity(row), notificationBasis(row)]);
    const independentlyEligible = reasons.length > 0;
    let obligationError = false;
    let owesAnyGru = false;
    const futureDebt: ObligationRecord[] = [];
    // Exhaust the ledger listing; the API's bounded default is not a coverage boundary.
    for (let cursor = 0;;) {
      const page = ledger.listObligationsDetailed({ jobId: job.id, cursor, limit: 1000 });
      if (page.malformed.length > 0) throw new Error(`mailbox malformed obligation evidence: ${page.malformed.map((row) => row.id).join(', ')}`);
      if (page.readable.length === 0) break;
      for (const obligation of page.readable) {
        cursor = Math.max(cursor, ledger.obligationRowid(obligation.id) ?? 0);
        if (!['open', 'waiting', 'suspended'].includes(obligation.state)) continue;
        references.push({ kind: 'obligation', id: obligation.id });
        if (obligation.dueAt !== null) followUpAt.push(obligation.dueAt);
        if (obligation.deadlineAt !== null) followUpAt.push(obligation.deadlineAt);
        const dueAt = obligation.dueAt === null ? null : Date.parse(obligation.dueAt);
        const deadlineAt = obligation.deadlineAt === null ? null : Date.parse(obligation.deadlineAt);
        const gruOwned = obligation.nextAction.kind === 'gru-decision' && obligation.state !== 'suspended';
        if (gruOwned) {
          for (const at of [dueAt, deadlineAt]) if (at !== null && at > now) onNextRecheck?.(at);
        }
        const owesGru = gruOwned && (obligation.state === 'open' ? dueAt === null || dueAt <= now
          : (dueAt !== null && dueAt <= now) || (deadlineAt !== null && deadlineAt <= now));
        owesAnyGru ||= owesGru;
        const retained = !owesGru && surfaced.get(`job:${job.id}`)?.references.some((ref) => ref.kind === 'obligation' && ref.id === obligation.id) === true;
        if (retained) futureDebt.push(obligation);
        if (owesGru && ((deadlineAt !== null && deadlineAt <= now) || (obligation.category.kind === 'known' && ['verification-failure', 'quality-gate', 'lane-unavailable'].includes(obligation.category.category)))) obligationError = true;
        if (independentlyEligible || owesGru || retained) add('obligation', `follow-up ${obligation.id}`, [obligation.id, obligation.planRevision, obligation.state, obligation.nextAction, obligation.dueAt, obligation.deadlineAt]);
      }
      if (page.readable.length < 1000) break;
    }
    const gruFollowUps: DecisionRecord[] = [];
    for (let offset = 0;; offset += 200) {
      const decisions = ledger.listDecisions({ subject: `job:${job.id}`, activeOnly: true, limit: 200, offset });
      for (const decision of decisions) {
        references.push({ kind: 'decision', id: decision.id });
        if (decision.by === 'gru' && decision.recheckAt !== null) gruFollowUps.push(decision);
        if (decision.recheckAt !== null) followUpAt.push(decision.recheckAt);
        if (decision.decision === 'hold') restrictions.push(`${decision.by}: ${decision.reason}`);
      }
      if (decisions.length < 200) break;
    }
    const controls: unknown[] = [];
    for (let cursor = '';;) {
      const page = ledger.listPendingDirectives({ jobId: job.id, limit: 1000, cursor });
      for (const directive of page) {
        cursor = directive.requestId;
        if ((LIVE_DIRECTIVE_STATES as readonly string[]).includes(directive.state) || (directive.state === 'retired' && directive.holdReleasedBy === null)) {
          references.push({ kind: 'directive', id: directive.requestId });
          controls.push([directive.requestId, directive.state, directive.admissionMinion, directive.admissionSeq, directive.deliverySeq, directive.holdReleasedBy]);
          if (directive.state === 'retired') restrictions.push(`retired control ${directive.requestId}: fresh owner-authorized request required`);
        }
      }
      if (page.length < 1000) break;
    }
    const branchPayload = branch?.payload as Record<string, unknown> | undefined;
    const context = [round === undefined ? null : [round.id, round.targetRef, round.status, round.verdict],
      branchPayload === undefined ? null : [branchPayload['sha'], branchPayload['pr_url'], branchPayload['pr_open'], branchPayload['mergeable_state'], branchPayload['ci']],
      worker === undefined ? null : [worker.id, worker.state], controls, ...(stopEvidence.length > 0 ? [stopEvidence] : [])];
    if (reasons.length > 0) {
      const item = make(`job:${job.id}`, `job:${job.id}`, job.id, job.title, reasons, rows, references, restrictions, context);
      const applicableFollowUps = gruFollowUps.filter((decision) => (decision.basisFingerprint === null || decision.basisFingerprint === item.basis)
        && item.reasons.some((reason) => decision.covers.includes(reason.signal)));
      for (const decision of applicableFollowUps) if (Date.parse(decision.recheckAt!) > now) onNextRecheck?.(Date.parse(decision.recheckAt!));
      const owesRecordedGruFollowUp = applicableFollowUps.some((decision) => Date.parse(decision.recheckAt!) <= now);
      let disposition: MailboxDisposition | null = null;
      if (!independentlyEligible && !owesAnyGru && !owesRecordedGruFollowUp && futureDebt.length > 0) {
        const debt = futureDebt[0]!;
        const clocks = futureDebt.flatMap((row) => [row.dueAt, row.deadlineAt]).filter((at): at is string => at !== null && Date.parse(at) > now).sort();
        const owners = futureDebt.map((row) => {
          const minion = row.receiptCorrelation?.minionId === undefined ? null : ledger.getAgent(row.receiptCorrelation.minionId);
          const liveWork = minion?.jobId === job.id && ['spawning', 'streaming'].includes(minion.state) && !stops.has(minion.id);
          const owner = row.nextAction.kind === 'owner-decision' || row.state === 'suspended' ? 'owner'
            : row.nextAction.kind === 'external-wait' ? 'external'
            : row.nextAction.kind === 'silas-mechanical' ? 'silas' : minion?.id ?? row.claim?.holder ?? 'gru';
          return { row, minion, liveWork, owner };
        });
        const nonGru = futureDebt.every((row) => row.nextAction.kind !== 'gru-decision' || row.state === 'suspended');
        const endedGruWork = owners.some(({ row, liveWork }) => row.nextAction.kind === 'gru-decision' && row.state !== 'suspended' && row.receiptCorrelation?.minionId !== undefined && !liveWork);
        const prior = surfaced.get(item.id)?.disposition;
        const monitoring = clocks.length === 0;
        const recheckAt = clocks[0] ?? (prior?.sourceObligationId === debt.id && prior.basis === item.basis && prior.recheckAt !== null && Date.parse(prior.recheckAt) > now
          ? prior.recheckAt : new Date(now + 300_000).toISOString());
        // Monitoring a different owner's debt never admits a Gru turn. Only actual Gru debt/work loss does.
        if (!endedGruWork && (nonGru || !monitoring)) {
          onNextRecheck?.(Date.parse(recheckAt));
          const debtRefs: MailboxReference[] = futureDebt.map((row) => ({ kind: 'obligation', id: row.id }));
          for (const { minion, liveWork } of owners) if (liveWork) debtRefs.push({ kind: 'agent', id: minion!.id });
          const delegated = owners.every(({ liveWork, minion, owner }) => liveWork && minion?.id === owner) && new Set(owners.map(({ minion }) => minion!.id)).size === 1;
          const dependency = futureDebt.map((row) => row.receiptKind !== null ? `${row.receiptKind} receipt for ${row.id}`
            : row.nextAction.kind === 'gru-decision' || row.nextAction.kind === 'owner-decision' ? row.nextAction.decision
            : row.nextAction.kind === 'external-wait' ? row.nextAction.condition : row.nextAction.action).join('; ');
          disposition = { sourceObligationId: debt.id, basis: item.basis, state: delegated ? 'delegated' : 'waiting',
            owner: delegated ? owners[0]!.minion!.id : [...new Set(owners.map(({ owner }) => owner))].join(', '),
            detail: `source-derived follow-up for obligations ${futureDebt.map((row) => row.id).join(', ')}; not a recorded Gru ruling${monitoring ? '; bounded code-only monitoring recheck, not an operational deadline' : ''}`,
            dependency, recheckAt, references: debtRefs, recordedAt: debt.updatedAt };
        }
      }
      items.push({ ...item, disposition, state: disposition?.state ?? item.state, owner: disposition?.owner ?? item.owner,
        severity: obligationError ? 'error' : item.severity, followUpAt: [...new Set(followUpAt)].sort() });
    }
  }
  for (const [key, rows] of incidents) {
    const row = rows[0]!;
    const subject = incidentSubjectOf(row);
    const references: MailboxReference[] = [];
    const restrictions: string[] = [];
    const followUpAt: string[] = [];
    for (let offset = 0;; offset += 200) {
      const page = ledger.listDecisions({ subject, activeOnly: true, limit: 200, offset });
      for (const decision of page) {
        references.push({ kind: 'decision', id: decision.id });
        if (decision.decision === 'hold') restrictions.push(`${decision.by}: ${decision.reason}`);
        if (decision.recheckAt !== null) followUpAt.push(decision.recheckAt);
      }
      if (page.length < 200) break;
    }
    items.push({ ...make(`incident:${mailboxBasis(key)}`, subject, null, row.title,
      [...new Set(rows.map((source) => notificationBasis(source)))].map((basis) => ({ signal: incidentSignalOf(row), label: row.kind, basis: mailboxBasis([key, basis]) })), rows, references, restrictions), followUpAt });
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}
