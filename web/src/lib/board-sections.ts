/**
 * Compact owner-first board sections (owner approval j-1064): the six
 * sections in the exact approved order and the bounded previews that
 * keep the operator's first screen to decisions, executing work and
 * upcoming approved work.
 *
 *   For you → In flight → Pipeline → For Gru → Settled → Cold
 *
 * Pure derivations so the order, the uncapped counts, the 5/5/3 preview
 * windows and the display labels are unit-testable without a DOM. The
 * underlying band CLASSIFICATION never changes here (board-bands.ts owns
 * it); this module only orders and windows what the bands produced, and
 * adds the pipeline block's server-evaluated rows.
 */

import { bucketSnapshot, jobRecency, type BandedJob, type WorkerStopView } from './board-bands.js';
import type { BoardSnapshot, PipelineEntryView, PipelineView } from './board-protocol.js';
import { unackedByJob } from './board-signals.js';
import { ownerPendingCount } from './owner-band.js';

export const SECTION_ORDER = ['for-you', 'in-flight', 'pipeline', 'for-gru', 'settled', 'cold'] as const;
export type SectionId = (typeof SECTION_ORDER)[number];

export const SECTION_LABELS: Readonly<Record<SectionId, string>> = {
  'for-you': 'For you',
  'in-flight': 'In flight',
  pipeline: 'Pipeline',
  'for-gru': 'For Gru',
  settled: 'Settled',
  cold: 'Cold',
};

/** The DOM id each shortcut targets (existing mounts keep their ids). */
export const SECTION_TARGET_IDS: Readonly<Record<SectionId, string>> = {
  'for-you': 'board-owner',
  'in-flight': 'board-section-in-flight',
  pipeline: 'board-section-pipeline',
  'for-gru': 'board-section-for-gru',
  settled: 'board-section-settled',
  cold: 'board-section-cold',
};

/** Approved preview sizes: In flight/Pipeline 5, Settled 3; Cold renders
 * zero rows until deliberately expanded. */
export const IN_FLIGHT_PREVIEW_SIZE = 5;
export const PIPELINE_PREVIEW_SIZE = 5;
export const SETTLED_PREVIEW_SIZE = 3;

export interface SectionCounts {
  readonly 'for-you': number;
  readonly 'in-flight': number;
  readonly pipeline: number;
  readonly 'for-gru': number;
  readonly settled: number;
  readonly cold: number;
}

export interface SectionNavRow {
  readonly id: SectionId;
  readonly label: string;
  readonly count: number;
  readonly targetId: string;
  readonly href: string;
  /** False when the server did not ship a pipeline block (pre-upgrade):
   * the count is not an authoritative zero, it is unknown. */
  readonly counted: boolean;
}

/** Band buckets + pipeline view for one snapshot (single derivation the
 * nav, the sections and the tests all read). */
export interface BoardSections {
  readonly bands: ReadonlyMap<string, readonly BandedJob[]>;
  readonly counts: SectionCounts;
  /** Full pipeline entry list in server order; empty when unwired. */
  readonly pipelineEntries: readonly PipelineEntryView[];
  readonly pipelineAvailable: boolean;
}

export function boardSections(
  snapshot: BoardSnapshot,
  now = Date.now(),
  opts: {
    /** Supervision-stopped worker views per job id — a stopped lane is
     * waiting, never silent-stalled (main's twelve-followthrough A1/E1
     * truth, preserved through the section presentation). */
    readonly stoppedWorkers?: ReadonlyMap<string, WorkerStopView>;
    /** The stall clock's floor per job from LIVE minion workers. */
    readonly liveWorkerStamps?: ReadonlyMap<string, number>;
  } = {},
): BoardSections {
  const groups = bucketSnapshot(snapshot, {
    now,
    unackedByJob: unackedByJob(snapshot),
    ...(opts.stoppedWorkers !== undefined ? { stoppedWorkers: opts.stoppedWorkers } : {}),
    ...(opts.liveWorkerStamps !== undefined ? { liveWorkerStamps: opts.liveWorkerStamps } : {}),
  });
  const byBand = new Map<string, readonly BandedJob[]>();
  for (const group of groups) byBand.set(group.band, group.jobs);
  const pipeline: PipelineView | null = snapshot.pipeline ?? null;
  return {
    bands: byBand,
    counts: {
      'for-you': ownerPendingCount(snapshot),
      'in-flight': byBand.get('in-flight')?.length ?? 0,
      pipeline: pipeline?.pending ?? 0,
      // The section's own authoritative count is the machine band it
      // contains (the global unacked tracker stays a separate chip).
      'for-gru': byBand.get('needs-you')?.length ?? 0,
      settled: byBand.get('settled')?.length ?? 0,
      cold: byBand.get('cold')?.length ?? 0,
    },
    pipelineEntries: pipeline?.entries ?? [],
    pipelineAvailable: pipeline !== null,
  };
}

/** The sticky shortcut strip's rows — labelled, uncapped counts, one per
 * section in the approved order. */
export function sectionNav(counts: SectionCounts, pipelineAvailable = true): readonly SectionNavRow[] {
  return SECTION_ORDER.map((id) => ({
    id,
    label: SECTION_LABELS[id],
    count: counts[id],
    targetId: SECTION_TARGET_IDS[id],
    href: `#${SECTION_TARGET_IDS[id]}`,
    counted: id !== 'pipeline' || pipelineAvailable,
  }));
}

export interface PreviewWindow<T> {
  readonly rows: readonly T[];
  /** Rows held behind the expander (0 = fully shown). */
  readonly hidden: number;
}

/** Bounded preview: `expanded` (or a list at/below the limit) shows
 * everything; otherwise the approved window size renders with a count of
 * the hidden tail. Reversible — the caller keeps the flag across
 * snapshot pushes, so nothing reopens unrequested. */
export function previewWindow<T>(rows: readonly T[], limit: number, expanded: boolean): PreviewWindow<T> {
  if (expanded || rows.length <= limit) return { rows, hidden: 0 };
  const shown = Math.max(0, limit);
  return { rows: rows.slice(0, shown), hidden: rows.length - shown };
}

/** The pipeline preview keeps the SERVER's deterministic order (priority,
 * enqueue sequence, stable id) — the browser never re-sorts. */
export function pipelineWindow(
  entries: readonly PipelineEntryView[],
  expanded: boolean,
): PreviewWindow<PipelineEntryView> {
  return previewWindow(entries, PIPELINE_PREVIEW_SIZE, expanded);
}

export function inFlightWindow(jobs: readonly BandedJob[], expanded: boolean): PreviewWindow<BandedJob> {
  return previewWindow(jobs, IN_FLIGHT_PREVIEW_SIZE, expanded);
}

export function settledPreview(jobs: readonly BandedJob[], expanded: boolean): PreviewWindow<BandedJob> {
  return previewWindow(jobs, SETTLED_PREVIEW_SIZE, expanded);
}

/** Newest settled first (recency + stable id) — the same order the
 * settled band renders, reused by the preview. */
export function settledJobs(jobs: readonly BandedJob[]): readonly BandedJob[] {
  return [...jobs].sort(
    (left, right) => jobRecency(right.job).localeCompare(jobRecency(left.job)) || left.job.id.localeCompare(right.job.id),
  );
}

/** Human label + tone for one pipeline entry state (one mapping for the
 * row chip and the tests). */
export function pipelineStateLabel(entry: Pick<PipelineEntryView, 'state'>): string {
  switch (entry.state) {
    case 'ready':
      return 'ready';
    case 'admitting':
      return 'admitting';
    case 'failed':
      return 'failed';
    default:
      return 'waiting';
  }
}

export function pipelineStateTone(entry: Pick<PipelineEntryView, 'state'>): string {
  switch (entry.state) {
    case 'ready':
      return 'pp-chip--done';
    case 'admitting':
      return 'pp-chip--work';
    case 'failed':
      return 'pp-chip--alert';
    default:
      return 'pp-chip--park';
  }
}
