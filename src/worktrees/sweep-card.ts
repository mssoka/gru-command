import { parseNotificationDecision, type NotificationDecision } from '../ledger/notification-decision.js';
import type { WorktreeRecord } from '../ledger/api.js';
import type { PausedProcess, PausedProcessProvenance } from './manager.js';

/**
 * The owner's card for a paused sweep (#486). GC stops on its own every
 * process rooted in the lane that carries the lane's token, so what is left
 * is what GC cannot prove is the lane's: the card names each kind of
 * process, when it started, where it runs and why GC did not stop it, and
 * offers one action, "Stop these N processes and finish the sweep".
 */

/** The card's kind prefix; the full kind is `<prefix><lane id>:<pause id>`. */
export const SWEEP_PAUSED_KIND_PREFIX = 'worktree-sweep-paused:';

/** The card's one option. */
export const STOP_AND_SWEEP_OPTION = 'stop-and-sweep';

export function sweepPausedKind(laneId: string, pauseId: string): string {
  return `${SWEEP_PAUSED_KIND_PREFIX}${laneId}:${pauseId}`;
}

/** The lane and pause a card's kind names, or null for a kind that is not
 * one (the legacy exact `worktree-sweep-paused`, or a random suffix written
 * before #486). The pause id never holds a colon; a lane id may. */
export function sweepPausedCardOf(kind: string): { readonly laneId: string; readonly pauseId: string } | null {
  if (!kind.startsWith(SWEEP_PAUSED_KIND_PREFIX)) return null;
  const rest = kind.slice(SWEEP_PAUSED_KIND_PREFIX.length);
  const split = rest.lastIndexOf(':');
  if (split <= 0 || split === rest.length - 1) return null;
  return { laneId: rest.slice(0, split), pauseId: rest.slice(split + 1) };
}

const WHY: Readonly<Record<PausedProcessProvenance, string>> = {
  'this-lane': 'carries this lane\'s token, but a session GC runs in the lane was still busy (or it outlived the stop), so GC left it',
  'other-lane': 'carries another lane\'s token',
  'no-token': 'carries no lane token, so no session GC spawned in the lane started it',
  unreadable: 'GC could not read its environment (macOS hides it for system binaries such as /bin/sh), so it cannot tell who started it',
};

function reasonOf(detail: PausedProcess): string {
  return detail.provenance === 'other-lane' ? `carries the token of lane ${detail.otherLane ?? 'unknown'}` : WHY[detail.provenance];
}

interface Group {
  readonly name: string;
  readonly members: PausedProcess[];
}

/** Processes that share `key` together, the largest group first (then by
 * name). */
function groupBy(details: readonly PausedProcess[], key: (detail: PausedProcess) => string): readonly Group[] {
  const grouped = new Map<string, Group>();
  for (const detail of details) {
    const id = key(detail);
    const group = grouped.get(id) ?? { name: detail.name, members: [] };
    group.members.push(detail);
    grouped.set(id, group);
  }
  return [...grouped.values()].sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
}

/** `Google Chrome ×11 + agent-browser`. */
export function sweepPausedSummary(details: readonly PausedProcess[]): string {
  return groupBy(details, (detail) => detail.name)
    .map(({ name, members }) => (members.length === 1 ? name : `${name} ×${String(members.length)}`)).join(' + ');
}

function span(values: readonly string[]): string {
  const sorted = [...new Set(values)].sort();
  if (sorted.length === 0) return 'unknown';
  return sorted.length === 1 ? sorted[0]! : `${sorted[0]!} to ${sorted[sorted.length - 1]!}`;
}

function startedSpan(details: readonly PausedProcess[]): string {
  return span(details.map((detail) => detail.startedAt).filter((at): at is string => at !== null));
}

/** One line per name and reason, so each pid's reason is its own. */
function groupLine(group: Group): string {
  const pids = group.members.map((member) => member.pid);
  const cwds = [...new Set(group.members.map((member) => member.cwd).filter((cwd): cwd is string => cwd !== null))];
  return `- ${group.name} ×${String(pids.length)} (pid${pids.length === 1 ? '' : 's'} ${pids.join(', ')}; started ${startedSpan(group.members)}` +
    `${cwds.length === 0 ? '' : `; working directory ${cwds.join(', ')}`}): ${reasonOf(group.members[0]!)}.`;
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The card: its title, its detail (one line per kind of process) and its
 * typed decision. */
export function sweepPausedCard(worktree: WorktreeRecord, details: readonly PausedProcess[]): {
  readonly title: string;
  readonly detail: string;
  readonly decision: NotificationDecision;
} {
  const count = details.length;
  const processes = `${String(count)} process${count === 1 ? '' : 'es'}`;
  const summary = sweepPausedSummary(details);
  const detail = [
    `Lane ${worktree.id} (${worktree.kind}${worktree.jobId !== null ? `, job ${worktree.jobId}` : ''}) at ${worktree.path} is being released, but ${processes} still run in it.`,
    'GC stops a process on its own only when it carries this lane\'s token (every session GC spawns in the lane passes it to what it starts) and no session of the lane is busy. It did not stop these:',
    ...groupBy(details, (detail) => `${detail.name}\n${reasonOf(detail)}`).map(groupLine),
    'The sweep stays paused, and nothing in the lane is removed, until they are stopped.',
  ].join('\n');
  const decision = parseNotificationDecision({
    question: bounded(`Stop the ${processes} still running in lane ${worktree.id} and finish its sweep?`, 300),
    context: bounded(`Still running in ${worktree.path}, started ${startedSpan(details)}: ${summary}. The details list each one's pids, start time, working directory, and why GC did not stop it.`, 600),
    recommendation: null,
    reservedClass: 'destructive',
    whyNotDelegable: 'GC stops a process without you only when it carries this lane\'s token and no session of the lane is busy. For these it cannot prove that: one may be your editor or terminal, another lane\'s, or in use by a busy session, so stopping them is your call.',
    options: [{
      id: STOP_AND_SWEEP_OPTION,
      label: bounded(`Stop these ${processes} and finish the sweep`, 120),
      consequence: `GC sends SIGTERM, then SIGKILL after a grace, to exactly the ${processes} listed, then finishes the sweep. A process that appears later is not touched: it gets its own card.`,
    }],
    discussion: false,
  });
  return { title: `Worktree sweep paused: ${processes} still running in ${worktree.repoName}`, detail, decision };
}
