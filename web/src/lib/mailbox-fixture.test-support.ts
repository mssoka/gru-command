import type { BoardSnapshot, JobView, MailboxView, MailboxItemView } from './board-protocol.js';

/** Mock server evidence for older board regression fixtures. Production never calls this helper. */
export function mailboxFixture(jobs: readonly JobView[], snapshot?: Pick<BoardSnapshot, 'notifications' | 'agents'>, unacked?: ReadonlyMap<string, number>): MailboxView {
  const items: MailboxItemView[] = [];
  for (const job of jobs) {
    if (['merged', 'done', 'binned'].includes(job.status)) continue;
    const rows = (snapshot?.notifications ?? []).filter((row) => row.routing === 'action-required' && row.ackedAt === null && row.resolvedAt === null && snapshot?.agents.some((agent) => agent.id === row.agentId && agent.jobId === job.id));
    const labels: string[] = [];
    if (rows.length > 0 || (unacked?.get(job.id) ?? 0) > 0) labels.push('action-required');
    if (job.status === 'blocked' || job.status === 'error') labels.push(job.status);
    if (job.prState === 'conflicting') labels.push('PR conflicting');
    const round = job.rounds.at(-1);
    if (round?.status === 'aborted') labels.push('round aborted');
    else if (round !== undefined && round.status !== 'verdict-posted' && round.lenses.some((lens) => lens.state === 'error')) labels.push('lens failed');
    if (labels.length === 0) continue;
    items.push({ id: `job:${job.id}`, subject: `job:${job.id}`, jobId: job.id, kind: 'job', title: job.title,
      reasons: labels.map((label) => ({ label, signal: label.replaceAll(' ', '-'), basis: 'fixture-reason-basis' })), basis: 'fixture-basis',
      state: 'needs-gru', owner: 'gru', disposition: null, receipt: null, notificationIds: rows.map((row) => row.id), producerOwned: false, references: [], restrictions: [], attentionKey: `fixture:${job.id}` });
  }
  return { items, counts: { threads: items.length, incidents: 0, notifications: items.reduce((sum, item) => sum + item.notificationIds.length, 0), needsGru: items.length } };
}
export function withMailboxFixture(snapshot: BoardSnapshot): BoardSnapshot {
  return { ...snapshot, mailbox: mailboxFixture(snapshot.repos.flatMap((repo) => repo.jobs), snapshot) };
}
