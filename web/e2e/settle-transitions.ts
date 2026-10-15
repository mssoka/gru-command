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
export async function settleTransitions(page: Page): Promise<void> {
  await page.evaluate((passes) => {
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
    const failures: string[] = [];
    for (let pass = 0; pass < passes; pass += 1) {
      const live = unsettled();
      if (live.length === 0) break;
      for (const transition of live) {
        try { transition.finish(); } catch (error) { failures.push(`${nameOf(transition)}: ${String(error)}`); }
      }
      if (failures.length > 0) break;
    }
    const stuck = [...new Set(unsettled().map(nameOf))];
    if (failures.length > 0) {
      throw new Error(`a CSS transition could not be finished (${failures.join('; ')}); still unsettled: ${stuck.join(', ') || 'none'}`);
    }
    if (stuck.length > 0) throw new Error(`CSS transitions kept restarting after ${String(passes)} settle passes: ${stuck.join(', ')}`);
  }, SETTLE_PASSES);
}
