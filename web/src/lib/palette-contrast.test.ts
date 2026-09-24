/**
 * Contrast discipline (v5): the palette is cream-based, so text pairs must
 * clear WCAG AA (>= 4.5:1) in BOTH themes. This suite reads the real
 * tokens.css, resolves the variable graph, and pins every text-on-surface
 * pair the console actually uses. A token darkening/lightening that
 * dips below AA fails here before it ships.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TOKENS_CSS = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');

function themeVars(selector: string): Map<string, string> {
  const match = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\}`).exec(TOKENS_CSS);
  if (match === null) throw new Error(`no ${selector} block in tokens.css`);
  const vars = new Map<string, string>();
  for (const entry of match[1]!.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    vars.set(entry[1]!, entry[2]!.trim());
  }
  return vars;
}

/** Resolve `var(--x)` indirection one hop at a time (cycles throw). */
function resolve(vars: Map<string, string>, name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`circular var(--${name})`);
  seen.add(name);
  const value = vars.get(name);
  if (value === undefined) throw new Error(`missing token --${name}`);
  const reference = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  return reference === null ? value : resolve(vars, reference[1]!, seen);
}

function luminance(hex: string): number {
  const value = hex.replace('#', '');
  if (value.length !== 6) throw new Error(`not a hex color: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(vars: Map<string, string>, foreground: string, background: string): number {
  const [lighter, darker] = [luminance(resolve(vars, foreground)), luminance(resolve(vars, background))].sort(
    (left, right) => right - left,
  );
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** Every text-on-surface pair the console/board/chat surfaces use. */
const TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ['ink', 'card'],
  ['ink', 'paper'],
  ['ink', 'soft'],
  ['ink', 'park'], // park chips, COLD band label
  ['muted', 'card'],
  ['muted', 'paper'],
  ['muted', 'soft'],
  ['faint', 'card'],
  ['faint', 'paper'],
  ['faint', 'soft'],
  ['on-state', 'work'], // status chips, Gru bubbles
  ['on-state', 'done'],
  ['on-state', 'rev'],
  ['on-state', 'alert'],
  ['on-state', 'perkins'],
  ['accent-text', 'accent'], // primary buttons
  ['band-needs-you-ink', 'card'], // alert KPI numeral
  ['band-needs-you-ink', 'soft'],
  ['ink', 'accent-soft'], // ack button (v6.1 themed fill)
  ['ink', 'danger-soft'], // error toast (v6.1 themed fill)
  ['muted', 'paper-soft'], // notice line (v6.1 themed fill)
];

describe('palette contrast (v5)', () => {
  for (const [theme, selector] of [
    ['light', ':root'],
    ['dark', '.dark'],
  ] as const) {
    it(`every text pair clears WCAG AA 4.5:1 in the ${theme} theme`, () => {
      const vars = themeVars(selector);
      const failures = TEXT_PAIRS.map(([foreground, background]) => {
        const ratio = contrast(vars, foreground, background);
        return { pair: `${foreground} on ${background}`, ratio };
      }).filter(({ ratio }) => ratio < 4.5);
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    });
  }

  it('the pair list itself is non-trivial (guards an accidentally emptied table)', () => {
    expect(TEXT_PAIRS.length).toBeGreaterThan(12);
  });
});
