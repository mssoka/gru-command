/**
 * Dark-mode completeness (v6.1 owner ruling 4): every themed surface must
 * flip with `.dark` — no component may fall back to a baked light hex.
 *
 * This suite reads the real CSS. It fails if a surface token the E7/chat
 * components reference is missing from either theme block, or if a
 * component re-introduces a literal color fallback for one of those
 * tokens (the exact shape of the bug: `var(--accent-soft, #ffe9a8)`
 * rendered pale yellow forever).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const TOKENS_CSS = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const COMPONENTS_CSS = readFileSync(new URL('./components.css', import.meta.url), 'utf8');

/** Surfaces whose old fallbacks never darkened (v6.1 ruling 4 audit). */
const THEMED_SURFACES = [
  'danger-soft',
  'accent-soft',
  'ink-soft',
  'paper-soft',
  'border',
  'danger',
] as const;

/** Changed surfaces (v6.1 audit) whose own rule blocks must stay themed:
 * every color-carrying declaration references a token (var(--…)), never a
 * literal hex/rgb — a literal passes the token checks above but renders one
 * theme forever (vgap r4: presence of tokens is not usage of tokens). */
const THEMED_SELECTORS = [
  '.toast--error',
  '.board-notification--error',
  '.board-notification__ack',
  '.attach-chip',
  '.attach-chip__remove',
] as const;

const COLOR_DECL = /\b(background|background-color|color|border|border-color|fill|stroke)\s*:\s*([^;]+);/g;

function themeBlock(selector: string): string {
  const match = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\}`).exec(TOKENS_CSS);
  if (match === null) throw new Error(`no ${selector} block in tokens.css`);
  return match[1]!;
}

describe('dark-mode surface tokens (v6.1)', () => {
  it('defines every E7/chat surface token in both themes', () => {
    const root = themeBlock(':root');
    const dark = themeBlock('.dark');
    for (const token of THEMED_SURFACES) {
      expect(root, `:root --${token}`).toMatch(new RegExp(`--${token}:\\s*[^;]+;`));
      expect(dark, `.dark --${token}`).toMatch(new RegExp(`--${token}:\\s*[^;]+;`));
    }
  });

  it('never bakes a light fallback for a themed surface token', () => {
    for (const token of THEMED_SURFACES) {
      expect(COMPONENTS_CSS, `var(--${token}, #…) fallback`).not.toMatch(
        new RegExp(`var\\(--${token}\\s*,\\s*#`),
      );
    }
  });

  it('keeps the dark values distinct from the light values (a real flip, not an alias)', () => {
    const root = themeBlock(':root');
    const dark = themeBlock('.dark');
    for (const token of THEMED_SURFACES) {
      const light = new RegExp(`--${token}:\\s*([^;]+);`).exec(root)?.[1]?.trim();
      const darkValue = new RegExp(`--${token}:\\s*([^;]+);`).exec(dark)?.[1]?.trim();
      expect(light, `--${token} light`).toBeDefined();
      expect(darkValue, `--${token} dark`).toBeDefined();
      expect(darkValue, `--${token} flips`).not.toBe(light);
    }
  });

  it('uses the tokens on the changed surfaces — no literal colors in their blocks (vgap r4)', () => {
    for (const selector of THEMED_SELECTORS) {
      const match = new RegExp(`${selector.replace('.', '\\.')}` + String.raw`\s*\{([\s\S]*?)\}`).exec(COMPONENTS_CSS);
      expect(match, `${selector} rule block exists`).not.toBeNull();
      const block = match?.[1] ?? '';
      const decls = [...block.matchAll(COLOR_DECL)];
      expect(decls.length, `${selector} carries color declarations`).toBeGreaterThan(0);
      for (const decl of decls) {
        const value = decl[2]?.trim() ?? '';
        expect(
          value.includes('var(') ||
            value === 'transparent' ||
            value === 'inherit' ||
            value === 'currentColor' ||
            value === 'none' ||
            value === '0',
          `${selector} ${decl[1]}: ${value}`,
        ).toBe(true);
      }
    }
  });
});
