import { describe, expect, it } from 'vitest';
import { BOARD_WORDS, heistCount, megaminionCount } from './board-vocabulary.js';

/**
 * The v6.1 display vocabulary (owner ruling 2026-09-23): lane/job render
 * as heist, the worker meta word renders as minion, and the agents rail
 * renders as CREW. Pinned as one map so no surface drifts.
 */
describe('board display vocabulary', () => {
  it('maps the render-boundary words once', () => {
    expect(BOARD_WORDS).toEqual({
      heist: 'heist',
      heists: 'heists',
      minion: 'minion',
      megaminion: 'megaminion',
      megaminions: 'megaminions',
      crew: 'crew',
    });
  });

  it('counts megaminions with the right plural (never the #161 "sub-minion" word)', () => {
    expect(megaminionCount(1)).toBe('1 megaminion');
    expect(megaminionCount(3)).toBe('3 megaminions');
    expect(Object.values(BOARD_WORDS).join(' ')).not.toMatch(/sub-?minion/i);
  });

  it('counts heists with the right plural', () => {
    expect(heistCount(0)).toBe('0 heists');
    expect(heistCount(1)).toBe('1 heist');
    expect(heistCount(2)).toBe('2 heists');
    expect(heistCount(12)).toBe('12 heists');
  });

  it('never renders the retired meta words', () => {
    const rendered = [BOARD_WORDS.heist, BOARD_WORDS.heists, BOARD_WORDS.minion, BOARD_WORDS.crew].join(' ');
    expect(rendered).not.toMatch(/\b(?:lane|job|agent)s?\b/);
  });
});
