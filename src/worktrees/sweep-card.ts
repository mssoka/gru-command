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
  'this-lane': 'carries this lane\'s token, but GC did not stop it (a session was still busy in the lane, or it outlived the stop)',
  'other-lane': 'carries another lane\'s token',
  'no-token': 'carries no lane token, so GC did not start it here',
  unreadable: 'GC cannot read its environment (a system binary such as /bin/sh on macOS), so it cannot tell who started it',
};

interface Group {
  readonly name: string;
  readonly members: PausedProcess[];
}

/** Same-named processes together, the largest group first (then by name). */
function groups(details: readonly PausedProcess[]): readonly Group[] {
  const byName = new Map<string, PausedProcess[]>();
  for (const detail of details) {
    const members = byName.get(detail.name) ?? [];
    members.push(detail);
    byName.set(detail.name, members);
  }
  return [...byName.entries()]
    .map(([name, members]) => ({ name, members }))
    .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
}

/** `agent-browser + Google Chrome Helper (Renderer) ×6`. */
export function sweepPausedSummary(details: readonly PausedProcess[]): string {
  return groups(details).map(({ name, members }) => (members.length === 1 ? name : `${name} ×${String(members.length)}`)).join(' + ');
}

function span(values: readonly string[]): string {
  const sorted = [...new Set(values)].sort();
  if (sorted.length === 0) return 'unknown';
  return sorted.length === 1 ? sorted[0]! : `${sorted[0]!} to ${sorted[sorted.length - 1]!}`;
}

function groupLine(group: Group): string {
  const pids = group.members.map((member) => member.pid);
  const started = span(group.members.map((member) => member.startedAt).filter((at): at is string => at !== null));
  const cwds = [...new Set(group.members.map((member) => member.cwd).filter((cwd): cwd is string => cwd !== null))];
  const reasons = [...new Set(group.members.map((member) => member.provenance === 'other-lane'
    ? `carries the token of lane ${member.otherLane ?? 'unknown'}` : WHY[member.provenance]))];
  return `- ${group.name} ×${String(pids.length)} (pid${pids.length === 1 ? '' : 's'} ${pids.join(', ')}; started ${started}` +
    `${cwds.length === 0 ? '' : `; working directory ${cwds.join(', ')}`}): ${reasons.join('; ')}.`;
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
    'GC stops on its own only the processes that carry this lane\'s token, which every session GC spawns in the lane passes to what it starts. These do not:',
    ...groups(details).map(groupLine),
    'The sweep stays paused, and nothing in the lane is removed, until they are stopped.',
  ].join('\n');
  const decision = parseNotificationDecision({
    question: bounded(`Stop the ${processes} still running in lane ${worktree.id} and finish its sweep?`, 300),
    context: bounded(`Still running in ${worktree.path}: ${summary}. The details list each one's pids, start time, working directory, and why GC did not stop it.`, 600),
    recommendation: null,
    reservedClass: 'destructive',
    whyNotDelegable: 'Nothing proves the lane started these processes: one may be your editor or terminal, or another lane\'s, and GC never stops a process it cannot prove is the lane\'s without you.',
    options: [{
      id: STOP_AND_SWEEP_OPTION,
      label: bounded(`Stop these ${processes} and finish the sweep`, 120),
      consequence: `GC sends SIGTERM, then SIGKILL after a grace, to exactly the ${processes} listed, then finishes the sweep. A process that appears later is not touched: it gets its own card.`,
    }],
    discussion: false,
  });
  return { title: `Worktree sweep paused: ${processes} still running in ${worktree.repoName}`, detail, decision };
}
