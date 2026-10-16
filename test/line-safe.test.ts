import { describe, expect, it } from 'vitest';
import { lineSafeLiteral, shownText } from '../src/dispatch/line-safe.js';

describe('line-safe text for guidance and ledger lines (#367, #369)', () => {
  it('escapes every control, format, separator, private-use and unassigned code point', () => {
    expect(lineSafeLiteral('a\nb\u007fc‮d ef͸g\u{e0041}h')).toBe('"a\\nb\\u007fc\\u202ed\\u2028e\\ue000f\\u0378g\\udb40\\udc41h"');
  });

  it('shows safe short text as written, and anything else as a bounded line-safe literal', () => {
    expect(shownText('/repo/tree')).toBe('/repo/tree');
    expect(shownText('/repo/tree‮evil')).toBe('"/repo/tree\\u202eevil"');
    expect(shownText('x'.repeat(201))).toBe(`${JSON.stringify('x'.repeat(200))}…`);
    expect(shownText('😀'.repeat(300), 5)).toBe(`${JSON.stringify('😀'.repeat(5))}…`);
    // The bound is in code points: safe astral text within it is shown as written.
    expect(shownText('😀'.repeat(150))).toBe('😀'.repeat(150));
    expect(shownText('😀'.repeat(200))).toBe('😀'.repeat(200));
    expect(shownText('😀'.repeat(201))).toBe(`${JSON.stringify('😀'.repeat(200))}…`);
  });
});
