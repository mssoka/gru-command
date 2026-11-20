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

  /** One row holds k cards from 190k - 10 px of strip (a 180px card and a
   * 10px gap each): the widths at which auto-fit itself gains a column. */
  const from = (cards: number): number => 190 * cards - 10;
  const between = (low: number, high: number): string => `(${from(low)}px <= width < ${from(high)}px)`;

  it('seven cards that cannot share a row split 4 + 3, then 3 + 2 + 2, then pairs with a full-width last card', () => {
    // 4 + 3 from the width that fits four up to the width that fits seven.
    const wide = rule(between(4, 7));
    expect(wide).toContain(".cockpit-kpis__grid[data-count='7'] { grid-template-columns: repeat(12, minmax(0, 1fr)); }");
    expect(wide).toContain(".cockpit-kpis__grid[data-count='7'] > .cockpit-card { grid-column: span 3; }");
    expect(wide).toContain(".cockpit-kpis__grid[data-count='7'] > .cockpit-card:nth-child(n + 5) { grid-column: span 4; }");
    const middle = rule(between(3, 4));
    expect(middle).toContain(".cockpit-kpis__grid[data-count='7'] { grid-template-columns: repeat(6, minmax(0, 1fr)); }");
    expect(middle).toContain(".cockpit-kpis__grid[data-count='7'] > .cockpit-card:nth-child(n + 4) { grid-column: span 3; }");
    const narrow = rule(`(width < ${from(3)}px)`);
    expect(narrow).toContain(".cockpit-kpis__grid[data-count='7'] > .cockpit-card:last-child");
    expect(narrow).toContain('grid-column: span 2;');
  });

  it('six cards split 3 + 3 and five split 3 + 2, each up to the width that fits them in one row', () => {
    expect(rule(between(3, 6))).toContain(
      ".cockpit-kpis__grid[data-count='6'] { grid-template-columns: repeat(3, minmax(0, 1fr)); }",
    );
    const five = rule(between(3, 5));
    expect(five).toContain(".cockpit-kpis__grid[data-count='5'] > .cockpit-card { grid-column: span 2; }");
    expect(five).toContain(".cockpit-kpis__grid[data-count='5'] > .cockpit-card:nth-child(n + 4) { grid-column: span 3; }");
  });

  it('the even-rows rules are ranges with no gap between them: a fractional width always matches one', () => {
    // `(min-width: 750px) and (max-width: 1319px)` left 749.5px and 1319.5px
    // to auto-fit, which packs 6 + 1 or 3 + 3 + 1.
    const queries = [...COMPONENTS_CSS.matchAll(/@container kpis \(([^)]*)\)/gu)].map((match) => match[1]!);
    const evenRows = queries.filter((query) => query.includes('width <'));
    expect(evenRows.length).toBeGreaterThanOrEqual(5);
    for (const query of evenRows) expect(query, query).not.toMatch(/min-width|max-width/u);
    // Seven cards: the three ranges meet exactly at the widths where a row
    // gains a card, from zero up to the one-row width.
    expect(evenRows).toContain(`width < ${from(3)}px`);
    expect(evenRows).toContain(`${from(3)}px <= width < ${from(4)}px`);
    expect(evenRows).toContain(`${from(4)}px <= width < ${from(7)}px`);
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

describe('crew rail: a readable role line', () => {
  it('the line under a crew name is ordinary case at 11px and wraps instead of cutting the role', () => {
    expect(declared('.board-agent__sub', 'text-transform')).toBe('none');
    expect(declared('.board-agent__sub', 'letter-spacing')).toBe('0');
    expect(declared('.board-agent__sub', 'flex-wrap')).toBe('wrap');
    expect(Number.parseFloat(declared('.board-agent__sub', 'font-size') ?? '0')).toBeGreaterThanOrEqual(11);
    // It used to ellipsize on one line, which cut the role to "M..".
    expect(declared('.board-agent__sub', 'white-space')).toBeNull();
    expect(declared('.board-agent__sub', 'overflow')).toBeNull();
    expect(declared('.board-agent__role', 'flex')).toBe('none');
    expect(declared('.board-agent__role', 'text-overflow')).toBeNull();
    // Nothing on the line is wider than the line: a long chip wraps inside
    // the rail instead of printing over the state chip.
    expect(declared('.board-agent__sub > *', 'max-width')).toBe('100%');
    expect(declared('.board-agent__sub > *', 'min-width')).toBe('0');
    expect(declared('.board-agent__sub .board-agent__child-counts', 'white-space')).toBe('normal');
    // The chips on the line follow its case and size.
    expect(declared('.board-agent__sub .lbl', 'text-transform')).toBe('none');
    expect(declared('.board-agent__sub .lbl', 'font-size')).toBe('inherit');
  });

  it('the name gets the room before the ID code, and "show all" is pinned to the list\'s bottom edge', () => {
    expect(declared('.board-agent__hash', 'flex')).toBe('0 100 auto');
    // …but never to nothing: the code is what tells same-named crew apart.
    expect(declared('.board-agent__hash', 'min-width')).toBe('4ch');
    expect(declared('.board-agent__hash', 'text-overflow')).toBe('ellipsis');
    expect(declared('.board-agent-toggle.board-agents__all', 'position')).toBe('sticky');
    expect(declared('.board-agent-toggle.board-agents__all', 'bottom')).toBe('0');
    expect(declared('.board-agent-toggle.board-agents__all', 'background')).toBe('var(--card)');
    // "Show all" lifts the height limit. The rule must BEAT the base rule's
    // max-height: with one class and an earlier position it lost, the label
    // changed and the list never grew. Two classes, and placed after it.
    expect(declared('.board-agents.board-agents--all', 'max-height')).toBe('none');
    expect(declared('.board-agents--all', 'max-height')).toBeNull();
    expect(declared('.board-agents', 'max-height')).toBe('420px');
    expect(COMPONENTS_CSS.indexOf('.board-agents.board-agents--all {')).toBeGreaterThan(COMPONENTS_CSS.indexOf('.board-agents {'));
    // A row scrolled into view lands above the pinned control.
    expect(Number.parseFloat(declared('.board-agents', 'scroll-padding-bottom') ?? '0')).toBeGreaterThanOrEqual(36);
  });
});

