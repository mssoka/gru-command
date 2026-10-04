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
const COMPONENTS_CSS = readFileSync(new URL('../styles/components.css', import.meta.url), 'utf8');

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

/** One declaration from the FIRST block matching the given selector. */
function declarationIn(css: string, selector: string, property: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`).exec(css);
  if (block === null) return null;
  const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`).exec(block[1]!);
  return declaration === null ? null : declaration[1]!.trim();
}

/** The declared opacity of a selector, or null when it declares none. */
function opacityIn(css: string, selector: string): number | null {
  const raw = declarationIn(css, selector, 'opacity');
  if (raw === null) return null;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`bad opacity "${raw}" for ${selector}`);
  return value;
}

/** The token a selector's color resolves from (single var() indirection). */
function colorTokenIn(css: string, selector: string): string | null {
  const raw = declarationIn(css, selector, 'color');
  if (raw === null) return null;
  const match = /^var\(--([a-z0-9-]+)\)$/.exec(raw);
  return match === null ? null : match[1]!;
}

function channelsOf(hex: string): readonly [number, number, number] {
  const value = hex.replace('#', '');
  if (value.length !== 6) throw new Error(`not a hex color: ${hex}`);
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as unknown as readonly [number, number, number];
}

/** Composite `foreground` at `alpha` over `background` (both hex). */
function mixColor(foreground: string, alpha: number, background: string): string {
  const fg = channelsOf(foreground);
  const bg = channelsOf(background);
  const out = fg.map((channel, index) => Math.round(alpha * channel + (1 - alpha) * bg[index]!));
  return `#${out.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function contrastHex(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
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

  for (const [theme, selector] of [
    ['light', ':root'],
    ['dark', '.dark'],
  ] as const) {
    it(`the closed-receipt composite clears WCAG AA 4.5:1 in the ${theme} theme`, () => {
      const vars = themeVars(selector);
      // Model the closed receipt exactly as shipped (tracked-review A2): an
      // error row paints on-state text on the alert surface; the receipt
      // class may dim the whole row, and the meta line carries its own
      // color + opacity (the receipt override keeps the error row's ink
      // because faint-on-alert composes below AA). Every value is read from
      // the real CSS, so a future dimming change fails here.
      const rowAlpha = opacityIn(COMPONENTS_CSS, '.board-notification--receipt') ?? 1;
      const metaSelector =
        '.board-notification--error.board-notification--receipt .board-notification__meta';
      const metaAlpha =
        opacityIn(COMPONENTS_CSS, metaSelector) ??
        opacityIn(COMPONENTS_CSS, '.board-notification__meta') ??
        1;
      const metaToken =
        colorTokenIn(COMPONENTS_CSS, metaSelector) ?? colorTokenIn(COMPONENTS_CSS, '.lbl') ?? 'ink';
      const paper = resolve(vars, 'paper');
      const alert = resolve(vars, 'alert');
      const title = mixColor(resolve(vars, 'on-state'), rowAlpha, paper);
      const metaInRow = mixColor(resolve(vars, metaToken), metaAlpha, alert);
      const meta = mixColor(metaInRow, rowAlpha, paper);
      const rowBackground = mixColor(alert, rowAlpha, paper);
      const failures = [
        { pair: 'receipt title (on-state on alert, row opacity)', ratio: contrastHex(title, rowBackground) },
        { pair: 'receipt meta (meta token/opacity inside the row)', ratio: contrastHex(meta, rowBackground) },
      ].filter(({ ratio }) => ratio < 4.5);
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    });
  }
});
