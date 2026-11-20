/**
 * Readable heist rows (owner pick 2026-11-20): the line under a heist's
 * title reads as a sentence. It was 10.5px uppercase monospace with the
 * branch name taking most of the line; these pins fail if the label
 * treatment creeps back.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const COMPONENTS_CSS = readFileSync(new URL('./components.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

/** One declaration from the LAST rule whose selector list names `selector`
 * exactly (the cascade's winner among equal-specificity rules). */
function declared(selector: string, property: string): string | null {
  let value: string | null = null;
  for (const match of COMPONENTS_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    if (!match[1]!.split(',').map((entry) => entry.trim()).includes(selector)) continue;
    const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);`, 'u').exec(match[2]!);
    if (declaration !== null) value = declaration[1]!.trim();
  }
  return value;
}

describe('readable heist rows', () => {
  it('the meta line is ordinary case in the body font at a readable size', () => {
    // The element also carries `.lbl` (uppercase, wide tracking): the row's
    // own rule must undo both, and come after `.lbl` to win the tie.
    expect(declared('.board-job__meta', 'text-transform')).toBe('none');
    expect(declared('.board-job__meta', 'letter-spacing')).toBe('0');
    expect(declared('.board-job__meta', 'font-family')).toBe('var(--font-body)');
    expect(Number.parseFloat(declared('.board-job__meta', 'font-size') ?? '0')).toBeGreaterThanOrEqual(12);
    expect(COMPONENTS_CSS.lastIndexOf('.board-job__meta {')).toBeGreaterThan(COMPONENTS_CSS.indexOf('.lbl {'));
  });

  it('the repo is a tag and the branch is last on the line, in the code font', () => {
    expect(declared('.board-job__repo', 'border')).toBe('2px solid var(--line)');
    expect(declared('.board-job__repo', 'color')).toBe('var(--ink)');
    expect(declared('.board-job__repo', 'background')).toBe('var(--card)');
    // Visual order only: the DOM keeps repo, branch, ages, link.
    expect(Number.parseInt(declared('.board-job__branch', 'order') ?? '0', 10)).toBeGreaterThan(0);
    expect(declared('.board-job__branch', 'font-family')).toContain('monospace');
  });

  it('the open/close arrow is a boxed control, not a bare glyph', () => {
    expect(declared('.board-job__chevron', 'border')).toBe('2px solid var(--line)');
    expect(Number.parseFloat(declared('.board-job__chevron', 'width') ?? '0')).toBeGreaterThanOrEqual(20);
    expect(Number.parseFloat(declared('.board-job__chevron', 'height') ?? '0')).toBeGreaterThanOrEqual(20);
  });

  it('a long branch name ellipsizes inside the row instead of widening the board', () => {
    // At 320px a nested row's unbreakable branch name pushed the page 21px
    // sideways: an implicit `auto` grid track cannot shrink below its
    // content's minimum. The row and the nested-row list use one shrinkable
    // track, and the branch itself may shrink.
    expect(declared('.board-job', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declared('.board-job__family', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declared('.board-job__branch', 'min-width')).toBe('0');
    expect(declared('.board-job__branch', 'overflow')).toBe('hidden');
    expect(declared('.board-job__branch', 'text-overflow')).toBe('ellipsis');
  });
});

describe('number cards: even rows', () => {
  const rule = (query: string): string => {
    const start = COMPONENTS_CSS.indexOf(`@container kpis ${query}`);
    if (start === -1) throw new Error(`no @container kpis ${query} block`);
    let depth = 0;
    for (let index = COMPONENTS_CSS.indexOf('{', start); index < COMPONENTS_CSS.length; index += 1) {
      if (COMPONENTS_CSS[index] === '{') depth += 1;
      if (COMPONENTS_CSS[index] === '}') {
        depth -= 1;
        if (depth === 0) return COMPONENTS_CSS.slice(start, index + 1);
      }
    }
    throw new Error(`unterminated @container kpis ${query} block`);
  };

  it('seven cards that cannot share a row split 4 + 3, then 3 + 2 + 2, then pairs with a full-width last card', () => {
    const wide = rule('(min-width: 750px) and (max-width: 1319px)');
    expect(wide).toContain(".cockpit-kpis__grid[data-count='7'] { grid-template-columns: repeat(12, minmax(0, 1fr)); }");
    expect(wide).toContain(".cockpit-kpis__grid[data-count='7'] > .cockpit-card { grid-column: span 3; }");
    expect(wide).toContain(".cockpit-kpis__grid[data-count='7'] > .cockpit-card:nth-child(n + 5) { grid-column: span 4; }");
    const middle = rule('(min-width: 560px) and (max-width: 749px)');
    expect(middle).toContain(".cockpit-kpis__grid[data-count='7'] { grid-template-columns: repeat(6, minmax(0, 1fr)); }");
    expect(middle).toContain(".cockpit-kpis__grid[data-count='7'] > .cockpit-card:nth-child(n + 4) { grid-column: span 3; }");
    const narrow = rule('(max-width: 559px)');
    expect(narrow).toContain(".cockpit-kpis__grid[data-count='7'] > .cockpit-card:last-child");
    expect(narrow).toContain('grid-column: span 2;');
  });

  it('six cards split 3 + 3 and five split 3 + 2; the thresholds are where a row gains a card (190k - 10)', () => {
    expect(rule('(min-width: 560px) and (max-width: 1129px)')).toContain(
      ".cockpit-kpis__grid[data-count='6'] { grid-template-columns: repeat(3, minmax(0, 1fr)); }",
    );
    const five = rule('(min-width: 560px) and (max-width: 939px)');
    expect(five).toContain(".cockpit-kpis__grid[data-count='5'] > .cockpit-card { grid-column: span 2; }");
    expect(five).toContain(".cockpit-kpis__grid[data-count='5'] > .cockpit-card:nth-child(n + 4) { grid-column: span 3; }");
    // One row holds k cards from 190k - 10 px: 7 at 1320, 6 at 1130, 5 at 940, 4 at 750, 3 at 560.
    for (const [cards, width] of [[7, 1320], [6, 1130], [5, 940], [4, 750], [3, 560]] as const) {
      expect(190 * cards - 10, `${cards} cards`).toBe(width);
    }
  });

  it('a card whose headline is zero steps back by colour only', () => {
    expect(declared('.cockpit-card--quiet .cockpit-card__big', 'color')).toBe('var(--muted)');
  });
});

describe('health pill: one calm line', () => {
  it('folds only the readings that need no look, and gives up the list\'s room when none shows', () => {
    expect(declared(".command-health[data-details='closed'] .command-health__part[data-problem='false']", 'display')).toBe('none');
    expect(
      declared(".command-health[data-details='closed'] .command-health__parts:not(:has([data-problem='true']))", 'display'),
    ).toBe('none');
    // A phone folds the calm readings unconditionally, so the control that
    // could not show them is hidden there too.
    expect(COMPONENTS_CSS).toMatch(
      /@media \(max-width: 640px\) \{[\s\S]*?\.command-health__part\[data-problem='false'\] \{ display: none; \}[\s\S]*?\.command-health__more \{ display: none; \}/u,
    );
    // No rule hides a reading that needs a look.
    expect(COMPONENTS_CSS).not.toMatch(/\.command-health__part\[data-problem='true'\]\s*\{[^}]*display:\s*none/u);
  });
});

