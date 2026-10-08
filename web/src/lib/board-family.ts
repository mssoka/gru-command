/**
 * Job families (megaminions): a job a minion commissioned — the build
 * workflow's specialist reviewers — carries `parentJobId`, and the board
 * nests it under that heist instead of rendering and counting it as a
 * peer. Pure derivation so nesting, orphans and the surfacing exceptions
 * are unit-testable without a DOM.
 *
 *   - A job nests when its parent is present in the same snapshot AND
 *     that parent is itself top-level. Families are one level deep on the
 *     server; a grandchild or a parent cycle in a snapshot renders flat
 *     rather than vanishing inside a row that never draws its own family.
 *   - An orphan (parent absent) stays top-level: never hidden.
 *   - A child the `surfaced` predicate keeps out stays top-level too (the
 *     board passes NEEDS-YOU, and live work whose heist is not in flight):
 *     attention and running work outrank nesting.
 */

import type { JobView } from './board-protocol.js';

export interface JobFamilies {
  /** Every top-level row — heists plus surfaced megaminions — in
   * snapshot order; the population the bands and HEISTS tracker count. */
  readonly topLevel: readonly JobView[];
  /** Nested megaminions per parent job id, oldest lane first (stable as
   * they work — recency would reorder the rows on every frame). */
  readonly childrenByParent: ReadonlyMap<string, readonly JobView[]>;
  /** Surfaced megaminions (top-level by exception) → their parent job. */
  readonly surfacedParents: ReadonlyMap<string, JobView>;
}

/** The parent named by a job, when that parent is on the board. */
function presentParent(job: JobView, byId: ReadonlyMap<string, JobView>): JobView | null {
  const parentId = job.parentJobId ?? null;
  if (parentId === null || parentId === job.id) return null;
  return byId.get(parentId) ?? null;
}

function childOrder(left: JobView, right: JobView): number {
  const leftAt = left.lane?.createdAt ?? left.updatedAt;
  const rightAt = right.lane?.createdAt ?? right.updatedAt;
  return leftAt.localeCompare(rightAt) || left.id.localeCompare(right.id);
}

export function jobFamilies(
  jobs: readonly JobView[],
  surfaced: (job: JobView, parent: JobView) => boolean = () => false,
): JobFamilies {
  const byId = new Map(jobs.map((job) => [job.id, job] as const));
  const topLevel: JobView[] = [];
  const children = new Map<string, JobView[]>();
  const surfacedParents = new Map<string, JobView>();
  for (const job of jobs) {
    const parent = presentParent(job, byId);
    if (parent === null || presentParent(parent, byId) !== null) {
      topLevel.push(job);
    } else if (surfaced(job, parent)) {
      topLevel.push(job);
      surfacedParents.set(job.id, parent);
    } else {
      const group = children.get(parent.id);
      if (group === undefined) children.set(parent.id, [job]);
      else group.push(job);
    }
  }
  for (const group of children.values()) group.sort(childOrder);
  return { topLevel, childrenByParent: children, surfacedParents };
}

/** A megaminion whose work is still running renders as a visible sub-row
 * under its heist; a concluded one (findings delivered, done, merged,
 * binned) folds into the heist's expanded body. */
export function isLiveMegaminion(job: JobView): boolean {
  return !(job.status === 'delivered' || job.status === 'done' || job.status === 'merged' || job.status === 'binned');
}

/** `↳ 3 megaminions · 2 working · 1 delivered` — the family chip's status
 * breakdown, statuses in the children's own (stable) order. */
export function familyStatusBreakdown(children: readonly JobView[]): readonly { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const child of children) counts.set(child.status, (counts.get(child.status) ?? 0) + 1);
  return [...counts].map(([status, count]) => ({ status, count }));
}
