import { describe, expect, it } from 'vitest';
import { ageMs, formatAge, isSameLocalDay, shortRev } from './board-time.js';

const NOW = new Date(2026, 8, 23, 12, 0, 0).getTime(); // local noon
const ISO = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

describe('board time helpers', () => {
  it('formats compact ages: s / m / h / d, honest em dash on junk', () => {
    expect(formatAge(ISO(-5_000), NOW)).toBe('5s');
    expect(formatAge(ISO(-4 * 60_000), NOW)).toBe('4m');
    expect(formatAge(ISO(-6 * 3_600_000), NOW)).toBe('6h');
    expect(formatAge(ISO(-3 * 24 * 3_600_000), NOW)).toBe('3d');
    expect(formatAge(null, NOW)).toBe('—');
    expect(formatAge('not-a-date', NOW)).toBe('—');
    // Future stamps clamp to zero rather than rendering negative ages.
    expect(formatAge(ISO(60_000), NOW)).toBe('0s');
  });

  it('ageMs clamps and nulls like formatAge', () => {
    expect(ageMs(ISO(-1_000), NOW)).toBe(1_000);
    expect(ageMs(null, NOW)).toBeNull();
    expect(ageMs('nope', NOW)).toBeNull();
    expect(ageMs(ISO(10_000), NOW)).toBe(0);
  });

  it('isSameLocalDay is the operator local day, not UTC', () => {
    const now = new Date(2026, 8, 23, 12, 0, 0);
    expect(isSameLocalDay(new Date(2026, 8, 23, 0, 5, 0).toISOString(), now)).toBe(true);
    expect(isSameLocalDay(new Date(2026, 8, 22, 23, 55, 0).toISOString(), now)).toBe(false);
    expect(isSameLocalDay(null, now)).toBe(false);
    expect(isSameLocalDay('garbage', now)).toBe(false);
  });

  it('shortRev renders the first 8 chars or unknown', () => {
    expect(shortRev('abcdef0123456789')).toBe('abcdef01');
    expect(shortRev(null)).toBe('unknown');
    expect(shortRev('')).toBe('unknown');
  });
});
