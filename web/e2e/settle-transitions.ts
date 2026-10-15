import type { Page } from '@playwright/test';

/** Settle passes before an unsettled page is reported as restarting. */
export const SETTLE_PASSES = 60;

/**
 * Jump every unsettled CSS transition on the page to its END state
 * (finish()) instead of awaiting it — headless Chromium on Linux can stall a
 * transition's `finished` promise past the test timeout (#402) — repeating,
 * bounded, until nothing is left unsettled. A finish() that throws, or
 * transitions that keep restarting, fail loud with EVERY culprit named
 * (element, id, classes, pseudo-element and property).
 */
export async function settleTransitions(page: Page, passes = SETTLE_PASSES): Promise<void> {
  // Let transitions a just-committed style change starts on the next frame begin first.
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { requestAnimationFrame(() => { resolve(); }); }); }));
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
    const stuck = [...new Set(unsettled().filter((t) => !failed.has(t)).map(nameOf))];
    if (failed.size > 0) {
      throw new Error(`a CSS transition could not be finished (${[...failed.values()].join('; ')}); other transitions still unsettled: ${stuck.join(', ') || 'none'}`);
    }
    if (stuck.length > 0) throw new Error(`CSS transitions kept restarting after ${String(limit)} settle passes: ${stuck.join(', ')}`);
  }, passes);
}
