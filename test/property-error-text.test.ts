import { describe, expect, it } from 'vitest';
import { oneLineErrorText } from '../src/property/error-text.js';

describe('one bounded line of error text (#379, #380)', () => {
  it('collapses every break, control, format, blank and lone surrogate, cuts on code points, and names what cannot print', () => {
    expect(oneLineErrorText(new Error('a\nb c‮d 　e\u0007f'), 100)).toBe('Error: a b c d e f');
    expect(oneLineErrorText(`x${'\ud800'}y`, 100)).toBe('x y');
    expect(oneLineErrorText('😀'.repeat(300), 10)).toBe(`${'😀'.repeat(10)}…`);
    // A cut prefix that collapses below the bound never ends in half a pair.
    const blankThenEmoji = `${' '.repeat(39)}${'😀'.repeat(20)}`;
    expect(oneLineErrorText(blankThenEmoji, 10)).toBe(`${'😀'.repeat(10)}…`);
    expect(oneLineErrorText(`${' '.repeat(639)}${'😀'.repeat(20)}`, 10)).not.toMatch(/(?:^|[^\ud800-\udbff])[\udc00-\udfff]|[\ud800-\udbff](?![\udc00-\udfff])/u);
    expect(oneLineErrorText({ toString() { throw new Error('no'); } }, 10)).toBe('an unprintable error');
    expect(oneLineErrorText('  \n\t ', 10)).toBe('an error with no text');
    expect(oneLineErrorText('x'.repeat(10), 10)).toBe('x'.repeat(10));
    expect(oneLineErrorText('x'.repeat(11), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('scans only a bounded prefix of a huge value, and refuses a bound that is no bound', () => {
    expect(oneLineErrorText('y'.repeat(5_000_000), 8)).toBe(`${'y'.repeat(8)}…`);
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => oneLineErrorText('x', bad), String(bad)).toThrow(RangeError);
  });
});
