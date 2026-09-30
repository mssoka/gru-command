// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../lib/markdown.js';

/**
 * Chat reflow contract (owner heist 2026-09-29): the chat pane must never
 * scroll horizontally — long unbroken tokens reflow at every pane width.
 *
 * Happy-dom cannot lay out boxes, so the layout guarantee itself lives in
 * the browser (smoke e2e: '#chat-log'/'#chat-view' scrollWidth <= clientWidth
 * at min/default/wide pane widths in both themes). THIS suite pins the CSS
 * declarations that make that e2e possible, plus the DOM structures they
 * target — reverting any of them to `white-space: pre` / `overflow-x: auto`
 * / an unbounded tool pill fails here first, with the exact selector named.
 */

/** happy-dom rewrites import.meta.url to a non-file scheme, so resolve
 * the stylesheet against the web package root (vitest cwd). */
function readComponentsCss(): string {
  for (const base of [process.cwd(), resolve(process.cwd(), 'web')]) {
    try {
      return readFileSync(resolve(base, 'src/styles/components.css'), 'utf8');
    } catch {
      /* try the next candidate root */
    }
  }
  throw new Error(`components.css not found from ${process.cwd()}`);
}

const COMPONENTS_CSS = readComponentsCss();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** One rule body by selector (whitespace-normalized); selector lists match
 * their exact comma-separated spelling in the stylesheet. */
function ruleBody(selector: string): string {
  const selectorPattern = selector
    .split(',')
    .map((part) => escapeRegExp(part.trim()))
    .join(',\\s*');
  const match = new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\}`).exec(COMPONENTS_CSS);
  if (match === null) throw new Error(`no "${selector}" rule in components.css`);
  return match[1]!.replace(/\s+/g, ' ').trim();
}

const LONG = 'q'.repeat(160);

describe('chat reflow contract', () => {
  it('tool lines wrap long unbroken names/error paths inside the log', () => {
    const body = ruleBody('.tool-line');
    expect(body).toMatch(/max-width:\s*100%/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('fenced code wraps at the pane width instead of scrolling sideways', () => {
    const body = ruleBody('.md-code');
    expect(body).toMatch(/white-space:\s*pre-wrap/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
    expect(body).not.toMatch(/overflow-x/);
  });

  it('tables shrink to the bubble instead of scrolling sideways', () => {
    const body = ruleBody('.md-table');
    expect(body).toMatch(/table-layout:\s*fixed/);
    expect(body).toMatch(/width:\s*100%/);
    expect(body).not.toMatch(/overflow-x/);
    expect(ruleBody('.md-table th, .md-table td')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('the composer field wraps drafted unbroken words instead of scrolling', () => {
    expect(ruleBody('.chat-compose textarea.pp-input')).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('renders code and tables with the full text intact (nothing truncated)', () => {
    const code = renderMarkdown('```\nconst token = "' + LONG + '";\n```');
    expect(code.querySelector('.md-code')?.textContent).toContain(LONG);

    const table = renderMarkdown(`| key | value |\n| --- | --- |\n| ${LONG} | ${LONG} |`);
    expect(table.querySelectorAll('.md-table th, .md-table td')).toHaveLength(4);
    expect(table.querySelector('.md-table')?.textContent).toContain(LONG);
  });
});
