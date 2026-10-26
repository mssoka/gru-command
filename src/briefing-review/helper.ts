import { REQUIRED_BRIEFING_REVIEW_WORKFLOW_FILE } from '../workflows/manifest.js';
import { loadBundledWorkflowRuntime, type BundledWorkflowRuntime } from '../workflows/runtime.js';
import { BRIEFING_REVIEW_LENSES, BriefingReviewError, type BriefingReviewLens } from './types.js';

/**
 * The verified lens helper. Its bytes are integrity-pinned in the GC workflow
 * package; the package id and sha256 are named in every lens briefing, so a
 * reviewer (and a stranger reading the ledger) can prove which method text ran.
 *
 * The lens helper is guarded HERE, at commission, and in the manifest refresh —
 * never in `loadBundledWorkflowRuntime`, which must keep loading a pinned
 * historical package so its lanes stay valid.
 */

export const BRIEFING_REVIEW_HELPER = REQUIRED_BRIEFING_REVIEW_WORKFLOW_FILE;

const PREAMBLE_END = /^## Lens: ([a-z]+)$/gmu;

export interface BriefingReviewHelper {
  readonly packageId: string;
  readonly sha256: string;
  /** The shared rules every lens reads. */
  readonly preamble: string;
  /** This lens's own section, verbatim from the verified bytes. */
  readonly lensSection: (lens: BriefingReviewLens) => string;
}

function unavailable(detail: string): BriefingReviewError {
  return new BriefingReviewError('briefing_review_workflow_unavailable', detail, 503);
}

/** Split the verified helper into its shared preamble and one section per
 * lens; a missing section is an unverifiable helper, never a silent generic
 * prompt. */
export function splitLensHelper(text: string): { readonly preamble: string; readonly sections: ReadonlyMap<BriefingReviewLens, string> } {
  const marks = [...text.matchAll(PREAMBLE_END)];
  const first = marks[0];
  if (first === undefined || first.index === undefined) {
    throw unavailable(`the briefing-review helper ${BRIEFING_REVIEW_HELPER} carries no "## Lens:" sections`);
  }
  const sections = new Map<BriefingReviewLens, string>();
  marks.forEach((mark, index) => {
    const lens = mark[1];
    const start = mark.index ?? 0;
    const next = marks[index + 1];
    const end = next?.index ?? text.length;
    if (lens !== undefined && (BRIEFING_REVIEW_LENSES as readonly string[]).includes(lens)) {
      sections.set(lens as BriefingReviewLens, text.slice(start, end).trim());
    }
  });
  for (const lens of BRIEFING_REVIEW_LENSES) {
    if (!sections.has(lens)) throw unavailable(`the briefing-review helper ${BRIEFING_REVIEW_HELPER} has no "## Lens: ${lens}" section`);
  }
  return { preamble: text.slice(0, first.index).trim(), sections };
}

export function loadBriefingReviewHelper(
  workflow: () => BundledWorkflowRuntime = loadBundledWorkflowRuntime,
): BriefingReviewHelper {
  let runtime: BundledWorkflowRuntime;
  try {
    runtime = workflow();
  } catch (error) {
    throw unavailable(error instanceof Error ? error.message : String(error));
  }
  const bytes = runtime.files.get(BRIEFING_REVIEW_HELPER);
  const sha256 = runtime.manifest.files[BRIEFING_REVIEW_HELPER];
  if (bytes === undefined || sha256 === undefined) {
    throw unavailable(
      `the briefing-review helper ${BRIEFING_REVIEW_HELPER} is missing from the verified GC workflow package ${runtime.id}; ` +
        'rebuild or reinstall GC — no commission is dispatched without the lens method it names',
    );
  }
  const { preamble, sections } = splitLensHelper(bytes.toString('utf-8'));
  return {
    packageId: runtime.id,
    sha256,
    preamble,
    lensSection: (lens) => {
      const section = sections.get(lens);
      if (section === undefined) throw unavailable(`the briefing-review helper has no section for lens ${lens}`);
      return section;
    },
  };
}
