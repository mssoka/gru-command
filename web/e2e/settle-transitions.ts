import type { Page } from '@playwright/test';

/** Settle passes before an unsettled page is reported as restarting. */
export const SETTLE_PASSES = 60;

/**
 * Jump every unsettled CSS transition on the page to its END state
 * (finish()) instead of awaiting it — headless Chromium on Linux can stall a
 * transition's `finished` promise past the test timeout (#402) — repeating,
 * bounded, until nothing is left unsettled. `document.getAnimations()`
 * flushes pending style changes first (Web Animations), so a transition a
 * just-committed class change starts is already listed: no frame wait is
 * needed, and none can hang a throttled page. A finish() that throws and
 * transitions that keep restarting each fail loud, together, with EVERY
 * culprit named (element, id, classes, pseudo-element and property).
 */
export async function settleTransitions(page: Page, passes = SETTLE_PASSES): Promise<void> {
  if (!Number.isSafeInteger(passes) || passes < 1) throw new Error(`settleTransitions: passes must be a positive integer, got ${String(passes)}`);
  await page.evaluate((limit) => {
    // Running (pending play included) or paused transitions are unsettled;
    // finished and idle ones are done.
    const unsettled = (): CSSTransition[] => document
      .getAnimations()
      .filter((a): a is CSSTransition => a instanceof CSSTransition && a.playState !== 'finished' && a.playState !== 'idle');
    const nameOf = (t: CSSTransition): string => {
      const effect = t.effect instanceof KeyframeEffect ? t.effect : null;
      const target = effect?.target ?? null;
      const element = target instanceof Element
        ? `${target.tagName.toLowerCase()}${target.id === '' ? '' : `#${target.id}`}${[...target.classList].map((c) => `.${c}`).join('')}`
        : `non-element target (${target === null ? 'none' : String(target)})`;
      return `${element}${effect?.pseudoElement ?? ''} ${t.transitionProperty}`;
    };
    // Every pass finishes everything still live; a transition whose finish()
    // throws is recorded and skipped, so the others still settle.
    const failed = new Map<CSSTransition, string>();
    for (let pass = 0; pass < limit; pass += 1) {
      const live = unsettled().filter((t) => !failed.has(t));
      if (live.length === 0) break;
      for (const transition of live) {
        try { transition.finish(); } catch (error) { failed.set(transition, `${nameOf(transition)}: ${String(error)}`); }
      }
    }
    // What is still live after every pass was finished each pass: it restarts.
    const restarting = [...new Set(unsettled().filter((t) => !failed.has(t)).map(nameOf))];
    const problems = [
      ...(failed.size > 0 ? [`a CSS transition could not be finished (${[...failed.values()].join('; ')})`] : []),
      ...(restarting.length > 0 ? [`CSS transitions kept restarting after ${String(limit)} settle passes: ${restarting.join(', ')}`] : []),
    ];
    if (problems.length > 0) throw new Error(problems.join('; '));
  }, passes);
}
