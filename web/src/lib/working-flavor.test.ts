import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WORKING_FLAVOR_CATEGORIES,
  WORKING_FLAVOR_INTERVAL_MS,
  WORKING_FLAVOR_PHRASES,
  WorkingFlavorDeck,
} from './working-flavor.js';

/**
 * The approved copy pool and the shuffle contract behind the working-state
 * chip. Deterministic: the deck takes an injected RNG, so every assertion
 * here is exact and no test sleeps or touches Math.random.
 */

/** Deterministic 32-bit PRNG (mulberry32) — tests own their randomness. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const CATEGORY_IDS = [
  'schemes-heists',
  'minion-management',
  'questionable-science',
  'snacks-paperwork',
  'villainous-flair',
] as const;

const CATEGORY_BY_PHRASE = new Map(
  WORKING_FLAVOR_CATEGORIES.flatMap((category) =>
    category.phrases.map((phrase) => [phrase, category.id] as const),
  ),
);

function draw(deck: WorkingFlavorDeck, count: number): string[] {
  return Array.from({ length: count }, () => deck.next());
}

describe('working flavor catalog', () => {
  it('is the approved pool: five categories of twenty, 100 unique phrases', () => {
    expect(WORKING_FLAVOR_CATEGORIES.map((category) => category.id)).toEqual([...CATEGORY_IDS]);
    for (const category of WORKING_FLAVOR_CATEGORIES) {
      expect(category.phrases, category.id).toHaveLength(20);
    }
    expect(WORKING_FLAVOR_PHRASES).toHaveLength(100);
    expect(new Set(WORKING_FLAVOR_PHRASES).size).toBe(100);
  });

  it('pins the approved copy verbatim (sha256 of the joined phrases)', () => {
    // Copy is owner-approved display data: any edit must be an approved
    // copy change and must update this pin deliberately.
    const digest = createHash('sha256')
      .update(WORKING_FLAVOR_PHRASES.join('\n'), 'utf8')
      .digest('hex');
    expect(digest).toBe('f0271dd8db53ddfa1c79bc48d29b515284b30b2ea2c8120733bb880269e9207f');
  });

  it('is display-safe: no visible "Gru is" prefix, no ellipsis, no stray whitespace', () => {
    for (const phrase of WORKING_FLAVOR_PHRASES) {
      expect(phrase).not.toMatch(/^gru is\b/i);
      expect(phrase).not.toContain('…');
      expect(phrase).not.toMatch(/\s{2,}/);
      expect(phrase).toBe(phrase.trim());
      expect(phrase).not.toBe('');
    }
  });

  it('pins the rotation interval at four seconds', () => {
    expect(WORKING_FLAVOR_INTERVAL_MS).toBe(4000);
  });
});

describe('working flavor deck', () => {
  it('deals a full no-repeat bag before repeating any phrase', () => {
    const deck = new WorkingFlavorDeck(seededRandom(20261001));
    const firstBag = draw(deck, 100);
    expect(new Set(firstBag).size).toBe(100);
    expect([...firstBag].sort()).toEqual([...WORKING_FLAVOR_PHRASES].sort());
    const secondBag = draw(deck, 100);
    expect(new Set(secondBag).size).toBe(100);
    expect([...secondBag].sort()).toEqual([...WORKING_FLAVOR_PHRASES].sort());
  });

  it('interleaves categories: consecutive phrases never share one', () => {
    const deck = new WorkingFlavorDeck(seededRandom(7));
    const phrases = draw(deck, 300);
    for (let index = 1; index < phrases.length; index += 1) {
      const previous = CATEGORY_BY_PHRASE.get(phrases[index - 1]!);
      const current = CATEGORY_BY_PHRASE.get(phrases[index]!);
      expect(previous, `phrase ${index} mapped`).toBeDefined();
      expect(current, `${previous} run at draw ${index}`).not.toBe(previous);
    }
  });

  it('never repeats a phrase across a bag boundary', () => {
    const deck = new WorkingFlavorDeck(seededRandom(99));
    const phrases = draw(deck, 250);
    for (let index = 1; index < phrases.length; index += 1) {
      expect(phrases[index], `immediate repeat at draw ${index}`).not.toBe(phrases[index - 1]);
    }
  });

  it('is reproducible for one seed and reorders for another', () => {
    const first = draw(new WorkingFlavorDeck(seededRandom(1234)), 30);
    const same = draw(new WorkingFlavorDeck(seededRandom(1234)), 30);
    const other = draw(new WorkingFlavorDeck(seededRandom(4321)), 30);
    expect(same).toEqual(first);
    expect(other).not.toEqual(first);
  });

  it('keeps its bag across episodes: a later draw continues, never restarts', () => {
    const deck = new WorkingFlavorDeck(seededRandom(555));
    const first = deck.next();
    const second = deck.next();
    const third = deck.next();
    expect(new Set([first, second, third]).size).toBe(3);
  });
});
