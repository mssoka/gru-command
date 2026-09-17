// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown, safeHref } from './markdown.js';

/**
 * Renderer suite for the GFM-subset markdown module (issue #10).
 * The end-to-end raw-markdown INVARIANT gate lives at
 * `web/src/ui/chat-gfm-invariant.test.ts` — here we pin the constructs.
 */

beforeEach(() => {
  document.body.replaceChildren();
});

function render(source: string, options?: { streaming?: boolean }): HTMLElement {
  const root = renderMarkdown(source, undefined, options);
  document.body.append(root);
  return root;
}

/** Every text node in the tree, concatenated per-node. */
function textNodes(root: HTMLElement): string[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    texts.push(n.textContent ?? '');
  }
  return texts;
}

describe('renderMarkdown blocks', () => {
  it('renders ATX headers as heading elements with inline content', () => {
    const root = render('## Plan **bold**');
    const h2 = root.querySelector('h2.md-h');
    expect(h2).not.toBeNull();
    expect(h2?.textContent).toBe('Plan bold');
    expect(h2?.querySelector('strong')).not.toBeNull();
    expect(textNodes(root).join('')).not.toContain('##');
  });

  it('renders fenced code blocks with language label, markers consumed', () => {
    const root = render('before\n```ts\nconst x = 1;\nconst y = 2;\n```\nafter');
    const pre = root.querySelector('pre.md-code');
    expect(pre).not.toBeNull();
    expect(pre?.querySelector('code')?.textContent).toBe('const x = 1;\nconst y = 2;');
    expect(pre?.querySelector('.md-code__lang')?.textContent).toBe('ts');
    const all = textNodes(root).join('');
    expect(all).not.toContain('```');
    expect(all).toContain('before');
    expect(all).toContain('after');
  });

  it('renders an unclosed fence as a code block (streaming hold-stable)', () => {
    const root = render('text\n```\npartial code');
    const pre = root.querySelector('pre.md-code');
    expect(pre).not.toBeNull();
    expect(pre?.querySelector('code')?.textContent).toBe('partial code');
    expect(textNodes(root).join('')).not.toContain('```');
  });

  it('renders a GFM table with separator alignment and no raw pipes', () => {
    const root = render('| Lane | State | Notes |\n|:-----|:-----:|------:|\n| e1 | done | ok |');
    const table = root.querySelector('table.md-table');
    expect(table).not.toBeNull();
    const ths = [...(table?.querySelectorAll<HTMLElement>('thead th') ?? [])];
    expect(ths.map((th) => th.textContent)).toEqual(['Lane', 'State', 'Notes']);
    expect(ths[0]?.style.textAlign).toBe('left');
    expect(ths[1]?.style.textAlign).toBe('center');
    expect(ths[2]?.style.textAlign).toBe('right');
    const tds = [...(table?.querySelectorAll('tbody td') ?? [])];
    expect(tds.map((td) => td.textContent)).toEqual(['e1', 'done', 'ok']);
    expect(textNodes(root).join('')).not.toContain('|');
  });

  it('renders a header-only table (separator still streaming) as a table', () => {
    const root = render('| Lane | State |\n| e1 | working |');
    // No separator row at all — never falls back to raw pipes.
    const table = root.querySelector('table.md-table');
    expect(table).not.toBeNull();
    expect(table?.querySelector('thead th')?.textContent).toBe('Lane');
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(textNodes(root).join('')).not.toContain('|');
  });

  it('keeps escaped pipes inside cells and pads short rows to header width', () => {
    const root = render('| a | b | c |\n|---|---|---|\n| x \\| y | z |');
    const tds = [...(root.querySelectorAll('tbody td') ?? [])];
    expect(tds).toHaveLength(3);
    expect(tds[0]?.textContent).toBe('x | y');
    expect(tds[1]?.textContent).toBe('z');
    expect(tds[2]?.textContent).toBe('');
  });

  it('renders nested and ordered lists', () => {
    const root = render('- one\n- two\n  - two.a\n  - two.b\n- three\n1. first\n2. second');
    const ul = root.querySelector('ul.md-list');
    expect(ul).not.toBeNull();
    expect(ul?.querySelectorAll(':scope > li')).toHaveLength(3);
    const nested = ul?.querySelectorAll('li ul.md-list li') ?? [];
    expect(nested).toHaveLength(2);
    const ol = root.querySelector('ol.md-list') as HTMLOListElement | null;
    expect(ol?.start).toBe(1);
    expect(ol?.querySelectorAll('li')).toHaveLength(2);
    expect(textNodes(root).join('')).not.toMatch(/^\s*-\s/m);
  });

  it('renders blockquotes with nested markdown, markers consumed', () => {
    const root = render('> quoted **strong**');
    const quote = root.querySelector('blockquote.md-quote');
    expect(quote).not.toBeNull();
    expect(quote?.textContent).toContain('quoted strong');
    expect(textNodes(root).join('')).not.toContain('>');
  });

  it('renders horizontal rules and paragraphs with <br> soft breaks', () => {
    const root = render('line one\nline two\n\n---\n\nline three');
    const p = root.querySelector('p.md-p');
    expect(p?.querySelectorAll('br')).toHaveLength(1);
    expect(root.querySelector('hr.md-hr')).not.toBeNull();
    expect(root.querySelectorAll('p')).toHaveLength(2);
  });

  it('leaves emoji untouched (unicode passthrough)', () => {
    const root = render('ship it 🚀 🪐 ✅');
    expect(root.querySelector('p')?.textContent).toContain('🚀 🪐 ✅');
  });
});

describe('renderMarkdown inline', () => {
  it('bold, italic, strike, and code spans never leak their markers', () => {
    const root = render('**bold** and *italic* and ~~gone~~ and `code span`');
    const text = textNodes(root).join('');
    expect(root.querySelector('strong.md-strong')?.textContent).toBe('bold');
    expect(root.querySelector('em.md-em')?.textContent).toBe('italic');
    expect(root.querySelector('s.md-strike')?.textContent).toBe('gone');
    expect(root.querySelector('code.md-code-inline')?.textContent).toBe('code span');
    for (const marker of ['**', '*', '~~', '`']) {
      expect(text).not.toContain(marker);
    }
  });

  it('word-internal underscores are NOT italic (snake_case stays literal)', () => {
    const root = render('the snake_case_name stays');
    expect(root.querySelector('em')).toBeNull();
    expect(textNodes(root).join('')).toContain('snake_case_name');
  });

  it('links only safe schemes; javascript: renders as literal text', () => {
    const root = render('[ok](https://example.com/a) [bad](javascript:alert(1))');
    const links = [...root.querySelectorAll('a.md-a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://example.com/a');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(textNodes(root).join('')).toContain('[bad](javascript:alert(1))');
  });

  it('image syntax renders as a labelled link, not an embedded image', () => {
    const root = render('![chart](https://example.com/chart.png)');
    const a = root.querySelector('a.md-a');
    expect(a).not.toBeNull();
    expect(a?.querySelector('img')).toBeNull();
    expect(a?.textContent).toContain('chart');
  });

  it('raw HTML in a reply is displayed literally and never parsed', () => {
    const root = render('<script>alert(1)</script> and <img src=x onerror=alert(2)>');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    const text = textNodes(root).join('');
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<img src=x onerror=alert(2)>');
  });

  it('backslash escapes display the escaped char without formatting', () => {
    const root = render('literal \\*not italic\\* and \\| pipe');
    expect(root.querySelector('em')).toBeNull();
    const text = textNodes(root).join('');
    expect(text).toContain('*not italic*');
    expect(text).toContain('| pipe');
  });
});

describe('renderMarkdown streaming holds partial markers', () => {
  it('a trailing partial fence/heading/hr marker is held while streaming', () => {
    const root = render('growing text\n``', { streaming: true });
    expect(textNodes(root).join('')).toBe('growing text');
    // Completed (non-streaming) render shows it as plain text per GFM.
    const done = render('growing text\n``');
    expect(textNodes(done).join('')).toContain('``');
  });

  it('held fragments resolve when the construct completes', () => {
    const root = render('text\n```\ncode', { streaming: true });
    expect(root.querySelector('pre.md-code code')?.textContent).toBe('code');
    expect(textNodes(root).join('')).not.toContain('```');
  });

  it('every prefix of a table+code reply renders without raw pipes or fences', () => {
    const reply =
      '| Lane | State |\n|---|---|\n| e1 | done |\n\n```bash\nnpm test\n```\n';
    for (let len = 1; len <= reply.length; len += 1) {
      const root = render(reply.slice(0, len), { streaming: true });
      const text = textNodes(root).join('');
      expect(text, `prefix ${len}: "${reply.slice(0, len)}"`).not.toContain('|');
      expect(text, `prefix ${len}: "${reply.slice(0, len)}"`).not.toContain('```');
    }
  });
});

describe('safeHref', () => {
  it('accepts http(s), mailto, and site-relative hrefs', () => {
    expect(safeHref('https://a.b/c')).toBe('https://a.b/c');
    expect(safeHref('http://a.b')).toBe('http://a.b');
    expect(safeHref('mailto:g@a.b')).toBe('mailto:g@a.b');
    expect(safeHref('/docs/x')).toBe('/docs/x');
    expect(safeHref('#anchor')).toBe('#anchor');
  });

  it('rejects every other scheme', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('vbscript:x')).toBeNull();
    expect(safeHref('')).toBeNull();
  });
});
