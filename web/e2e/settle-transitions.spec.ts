import { expect, test } from '@playwright/test';
import { settleTransitions } from './settle-transitions.js';

/**
 * The shared settle helper's own contract (#402): it finishes every
 * running transition and names each one it cannot finish. A page of its
 * own (setContent) — no app, no fixtures — so it lives apart from any
 * feature suite.
 */

test('settleTransitions finishes running transitions and names every culprit it cannot finish (#402)', async ({ page }) => {
  // No frame passes between the class change and the settle: the helper's
  // getAnimations() style flush must find the just-started transitions.
  const start = async () => {
    await page.setContent([
      '<style>.box{width:20px;height:20px;color:rgb(0,0,0);transition:color 30s linear}.box.on{color:rgb(255,0,0)}</style>',
      '<div id="settles" class="box"></div><div id="stalled" class="box"></div>',
    ].join(''));
    await page.evaluate(() => {
      for (const id of ['settles', 'stalled']) {
        const box = document.getElementById(id)!;
        void getComputedStyle(box).color; // commit the start style
        box.classList.add('on');
      }
    });
  };
  const live = () => page.evaluate(() => document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState !== 'finished' && a.playState !== 'idle').length);
  const colorOf = (id: string) => page.evaluate((target) => getComputedStyle(document.getElementById(target)!).color, id);
  // Overrides finish() on ONE element's transition (an own property, so the
  // shared prototype is never touched): 'stall' makes it throw (a zero
  // playback rate — Web Animations specifies InvalidStateError), 'restart'
  // makes it a no-op so the transition never settles.
  const sabotage = (id: string, how: 'stall' | 'restart') => page.evaluate(([target, mode]) => {
    const element = document.getElementById(target);
    const transition = document.getAnimations().find((a) => a instanceof CSSTransition && a.effect instanceof KeyframeEffect && a.effect.target === element);
    if (transition === undefined) throw new Error(`fixture: no running transition on #${target}`);
    if (mode === 'stall') transition.playbackRate = 0;
    else Object.defineProperty(transition, 'finish', { value: () => {}, configurable: true });
  }, [id, how] as const);
  // The helper's own message: Playwright prefixes `page.evaluate: Error: `
  // and appends the in-page stack.
  const failureOf = () => settleTransitions(page, 3).then(() => null, (error: unknown) =>
    (error instanceof Error ? error.message : String(error)).split('\n')[0]!.replace(/^page\.evaluate: Error: /u, ''));

  // Settled straight after the class change — nothing else touched the
  // animations first — every transition reaches its END state.
  await start();
  await settleTransitions(page);
  expect([await colorOf('settles'), await colorOf('stalled'), await live()]).toEqual(['rgb(255, 0, 0)', 'rgb(255, 0, 0)', 0]);

  await start();
  await sabotage('stalled', 'stall');
  const stalled = await failureOf();
  expect(stalled).toMatch(/^a CSS transition could not be finished \(div#stalled\.box\.on color: InvalidStateError: [^;]+\)$/u);
  expect(stalled, 'the transition that settled is no culprit').not.toContain('#settles');
  expect(await colorOf('settles'), 'the OTHER transition still settles').toBe('rgb(255, 0, 0)');
  // Once nothing is stalled, every transition settles to its END state.
  await page.evaluate(() => { for (const a of document.getAnimations()) a.playbackRate = 1; });
  await settleTransitions(page);
  expect(await colorOf('stalled')).toBe('rgb(255, 0, 0)');
  expect(await live()).toBe(0);

  // Transitions that never settle within the bounded passes fail loud,
  // each named exactly once.
  await start();
  await sabotage('settles', 'restart');
  await sabotage('stalled', 'restart');
  const restarting = await failureOf();
  expect(restarting).toMatch(/^CSS transitions kept restarting after 3 settle passes: div#(settles|stalled)\.box\.on color, div#(settles|stalled)\.box\.on color$/u);
  for (const id of ['#settles', '#stalled']) expect(restarting!.split(id).length - 1, id).toBe(1);

  // Both failures at once are BOTH reported: neither hides the other.
  await start();
  await sabotage('stalled', 'stall');
  await sabotage('settles', 'restart');
  expect(await failureOf()).toMatch(
    /^a CSS transition could not be finished \(div#stalled\.box\.on color: InvalidStateError: [^;]+\); CSS transitions kept restarting after 3 settle passes: div#settles\.box\.on color$/u,
  );

  // Both ends of the pass bound are accepted (on a fresh page)...
  await start();
  await settleTransitions(page, 1);
  await settleTransitions(page, 1000);
  expect(await live()).toBe(0);
  // ...and the bound itself must be an integer from 1 to 1000.
  for (const passes of [0, -0, -1, 1.5, 1000.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1001, '5' as unknown as number]) {
    const label = Object.is(passes, -0) ? '-0' : `${typeof passes} ${String(passes)}`;
    await expect(settleTransitions(page, passes), label).rejects.toThrow(/settleTransitions: passes must be an integer from 1 to 1000/u);
  }
});
