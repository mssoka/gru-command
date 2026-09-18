/**
 * GFM-subset renderer for Gru's chat replies (issue #10).
 *
 * Design contract:
 *
 * - **DOM-built, never `innerHTML`.** Every piece of source text lands via
 *   `textContent`/`createTextNode`, so raw HTML in a reply is displayed
 *   literally and cannot execute. XSS-safety is structural, not filtered.
 * - **Streaming-tolerant.** The chat view re-renders the accumulated reply
 *   text on every delta (atomic `replaceChildren` — one paint per delta,
 *   no flicker). The parser holds incomplete constructs stable instead of
 *   flashing raw markers: an unclosed ``` fence renders as a growing code
 *   block, a table header row that has not met its |---| separator yet
 *   still renders as a table, and a trailing partial block marker (1–2
 *   backticks, bare #, growing ---) is held back entirely until more
 *   deltas arrive or the turn ends.
 * - **The raw-markdown invariant (USER CANON, issue #10):** pipe-leading
 *   table lines and fence markers are ALWAYS consumed into structure —
 *   they never reach the DOM as literal text. `chat-gfm-invariant.test.ts`
 *   enforces this end-to-end and fails if the renderer is disabled.
 *
 * Coverage is a pragmatic GFM subset, tuned for what agents emit: ATX
 * headers, GFM tables (with alignment), fenced code (``` and ~~~), ordered
 * + nested unordered lists, blockquotes, rules, paragraphs (soft newlines
 * render as <br> — chat convention), and inline code / bold / italic /
 * strike / links. Images render as links (no remote loading in v1).
 * Emoji are plain Unicode and pass through untouched.
 */

/** Render options; `streaming` holds trailing partial block markers. */
export interface MarkdownOptions {
  readonly streaming?: boolean;
}

/** Render `source` as markdown into `root` (replacing its children);
 *  returns the filled root. Without `root`, a fresh `div.md-body` is made. */
export function renderMarkdown(
  source: string,
  root?: HTMLElement,
  options?: MarkdownOptions,
): HTMLElement {
  const body = root ?? document.createElement('div');
  // Add the class without clobbering a caller-provided one (chat bubbles
  // carry `msg__body`; the margin-reset CSS keys off it).
  if (!body.classList.contains('md-body')) body.classList.add('md-body');
  body.replaceChildren();
  renderBlocks(source.split('\n'), options?.streaming === true, body);
  return body;
}

// ---------------------------------------------------------------------------
// Block-level parsing
// ---------------------------------------------------------------------------

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s{0,3}([-*_])[ \t]*\1[ \t]*\1[ \t*\-_]*$/;
const QUOTE_RE = /^\s{0,3}>\s?/;
const ROW_RE = /^\s{0,3}\|/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const SEPARATOR_CELL_RE = /^:?-+:?$/;

/** A trailing line that is only a partial block marker (the stream may be
 *  mid-way through emitting it): 1–2 fence ticks, a bare # run, or 1–2
 *  hr characters. Held back while streaming so it cannot flash literal. */
function isPartialMarker(line: string): boolean {
  const t = line.trim();
  return /^[`~]{1,2}$/.test(t) || /^#{1,5}$/.test(t) || /^([-*_])\1?$/.test(t);
}

/** Anything that opens a new block and thus interrupts a paragraph. */
function opensBlock(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    ROW_RE.test(line) ||
    LIST_RE.test(line)
  );
}

function renderBlocks(lines: readonly string[], streaming: boolean, out: HTMLElement): void {
  // While streaming, the final line is still growing: hold a partial marker.
  let end = lines.length;
  if (streaming && end > 0 && isPartialMarker(lines[end - 1] ?? '')) end -= 1;

  let i = 0;
  while (i < end) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? '```';
      const info = (fence[2] ?? '').trim();
      const lang = info.split(/\s+/)[0] ?? '';
      const body: string[] = [];
      i += 1;
      while (i < end) {
        const l = lines[i] ?? '';
        // Closing fence: same char, at least as long, nothing after it.
        const close = new RegExp(
          `^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`,
        ).exec(l);
        if (close !== null) {
          i += 1;
          break;
        }
        body.push(l);
        i += 1;
      }
      out.append(codeBlock(body.join('\n'), lang));
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? '#').length;
      const h = document.createElement(`h${level}` as 'h1');
      h.className = `md-h md-h${level}`;
      renderInline(stripClosingHashes(heading[2] ?? ''), h);
      out.append(h);
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      const hr = document.createElement('hr');
      hr.className = 'md-hr';
      out.append(hr);
      i += 1;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < end && QUOTE_RE.test(lines[i] ?? '')) {
        inner.push((lines[i] ?? '').replace(QUOTE_RE, ''));
        i += 1;
      }
      const quote = document.createElement('blockquote');
      quote.className = 'md-quote';
      renderBlocks(inner, false, quote);
      out.append(quote);
      continue;
    }

    if (ROW_RE.test(line)) {
      i = renderTable(lines, i, end, out);
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list !== null) {
      i = renderList(lines, i, end, out);
      continue;
    }

    // Paragraph: until a blank line or a line that opens another block.
    const para: string[] = [];
    while (i < end) {
      const l = lines[i] ?? '';
      if (l.trim() === '' || opensBlock(l)) break;
      para.push(l);
      i += 1;
    }
    const p = document.createElement('p');
    p.className = 'md-p';
    for (let j = 0; j < para.length; j += 1) {
      if (j > 0) p.append(document.createElement('br'));
      renderInline(para[j] ?? '', p);
    }
    out.append(p);
  }
}

function stripClosingHashes(text: string): string {
  return text.replace(/\s+#+\s*$/, '');
}

function codeBlock(code: string, lang: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'md-code';
  if (lang !== '') {
    const label = document.createElement('span');
    label.className = 'md-code__lang';
    label.textContent = lang;
    pre.append(label);
  }
  const codeEl = document.createElement('code');
  // Fence markers are consumed by the parser; only the payload remains.
  codeEl.textContent = code.replace(/\n$/, '');
  pre.append(codeEl);
  return pre;
}

// ---------------------------------------------------------------------------
// Tables — the GFM core of the raw-markdown invariant
// ---------------------------------------------------------------------------

/** Split a table row into cells. `\|` is a literal pipe inside a cell;
 *  the optional leading/trailing border pipes are stripped. */
function splitRow(line: string): string[] {
  // ESC is a private-use placeholder standing in for an escaped pipe while
  // we split on the real ones (a raw \x00 control char trips no-control-regex).
  const ESC = '\uE000';
  const stripped = line
    .replace(/^\s{0,3}\|/, '')
    .replace(/\|\s*$/, '')
    .replace(/\\\|/g, ESC);
  return stripped.split('|').map((cell) => cell.replaceAll(ESC, '|').trim());
}

/** A row made only of |, -, :, whitespace — a separator (or a separator
 *  still streaming in). Either way it is consumed, never rendered. */
function isSeparatorRow(line: string): boolean {
  if (!/^[\s|:-]+$/.test(line) || !line.includes('-')) return false;
  return splitRow(line).every((cell) => SEPARATOR_CELL_RE.test(cell));
}

function alignmentOf(cell: string): 'left' | 'center' | 'right' | undefined {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return undefined;
}

function renderTable(
  lines: readonly string[],
  start: number,
  end: number,
  out: HTMLElement,
): number {
  const rows: string[] = [];
  let i = start;
  while (i < end && ROW_RE.test(lines[i] ?? '')) {
    rows.push(lines[i] ?? '');
    i += 1;
  }
  // First row is always the header (GFM with separator; a separator-less
  // run is a table still streaming its |---| line — render it held stable).
  const [headerLine, ...rest] = rows;
  if (headerLine === undefined) return i;

  const headerCells = splitRow(headerLine);
  const alignments: Array<'left' | 'center' | 'right' | undefined> = headerCells.map(
    () => undefined,
  );
  const bodyLines: string[] = [];
  let firstSeparatorSeen = false;
  for (const line of rest) {
    if (!firstSeparatorSeen && isSeparatorRow(line)) {
      firstSeparatorSeen = true;
      splitRow(line).forEach((cell, index) => {
        alignments[index] = alignmentOf(cell);
      });
      continue;
    }
    bodyLines.push(line);
  }

  const table = document.createElement('table');
  table.className = 'md-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headerCells.forEach((cell, index) => {
    const th = document.createElement('th');
    const align = alignments[index];
    if (align !== undefined) th.style.textAlign = align;
    renderInline(cell, th);
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const line of bodyLines) {
    const tr = document.createElement('tr');
    const cells = splitRow(line);
    for (let c = 0; c < headerCells.length; c += 1) {
      const td = document.createElement('td');
      const align = alignments[c];
      if (align !== undefined) td.style.textAlign = align;
      renderInline(cells[c] ?? '', td);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  out.append(table);
  return i;
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function isOrderedMarker(marker: string): boolean {
  return /\d/.test(marker[0] ?? '');
}

function renderList(
  lines: readonly string[],
  start: number,
  end: number,
  out: HTMLElement,
): number {
  const first = LIST_RE.exec(lines[start] ?? '');
  if (first === null) return start + 1;
  const baseIndent = (first[1] ?? '').length;
  const ordered = isOrderedMarker(first[2] ?? '-');
  const listEl = document.createElement(ordered ? 'ol' : 'ul');
  listEl.className = 'md-list';
  if (ordered) {
    const ol = listEl as HTMLOListElement;
    ol.start = Number((first[2] ?? '1').match(/\d+/)?.[0] ?? 1);
  }

  let i = start;
  while (i < end) {
    const line = lines[i] ?? '';
    if (line.trim() === '') break; // blank line ends the list (simple lists)
    const m = LIST_RE.exec(line);
    if (
      m === null ||
      (m[1] ?? '').length > baseIndent + 1 ||
      isOrderedMarker(m[2] ?? '-') !== ordered
    ) {
      break; // deeper marker = nested item (inside previous li); kind change = new list
    }
    const itemLines: string[] = [m[3] ?? ''];
    const contentIndent = baseIndent + (m[2] ?? '').length + 1;
    i += 1;
    while (i < end) {
      const l = lines[i] ?? '';
      if (l.trim() === '') break;
      const deeper = LIST_RE.exec(l);
      if (deeper !== null && (deeper[1] ?? '').length >= contentIndent) {
        itemLines.push(l.slice(Math.min(contentIndent, l.length)));
        i += 1;
        continue;
      }
      if (/^\s{2,}\S/.test(l) && l.length - l.trimStart().length >= contentIndent) {
        itemLines.push(l.slice(Math.min(contentIndent, l.length)));
        i += 1;
        continue;
      }
      break;
    }
    const li = document.createElement('li');
    li.className = 'md-item';
    renderBlocks(itemLines, false, li);
    listEl.append(li);
  }
  out.append(listEl);
  return i;
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

/** Code spans are extracted first so nothing else formats inside them. */
const CODE_SPAN_RE = /(`+)([\s\S]*?[^`])\1(?!`)/;

const LINK_RE = /!?\[([^\]]*)\]\((\S*?)(?:\s+"[^"]*")?\)/;
const BOLD_STAR_RE = /(?<!\\)\*\*(?=\S)([\s\S]*?\S)\*\*/;
const BOLD_UNDER_RE = /(?<!\\)__(?=\S)([\s\S]*?\S)__/;
const STRIKE_RE = /(?<!\\)~~(?=\S)([\s\S]*?\S)~~/;
const ITALIC_STAR_RE = /(?<!\\)\*(?=\S)([\s\S]*?\S)\*/;
const ITALIC_UNDER_RE = /(?<![\w\\])_(?=\S)([\s\S]*?\S)_(?!\w)/;

/** Only schemes a chat reply may link to; everything else renders literal. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;
  return null;
}

interface InlinePattern {
  readonly re: RegExp;
  readonly onMatch: (match: RegExpExecArray, target: HTMLElement) => void;
}

function wrap(target: HTMLElement, tag: string, className: string, content: string): void {
  const node = document.createElement(tag);
  node.className = className;
  renderInline(content, node);
  target.append(node);
}

const INLINE_PATTERNS: readonly InlinePattern[] = [
  {
    re: LINK_RE,
    onMatch: (match, target) => {
      const href = safeHref(match[2] ?? '');
      if (href === null) {
        // Untrusted scheme: show the syntax literally, link nothing.
        target.append(document.createTextNode(match[0]));
        return;
      }
      const a = document.createElement('a');
      a.className = 'md-a';
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      const isImage = match[0].startsWith('!');
      const label = isImage ? `🖼 ${match[1] ?? 'image'}` : (match[1] ?? '');
      renderInline(label, a);
      if (isImage) a.title = 'image (linked, not embedded)';
      target.append(a);
    },
  },
  { re: BOLD_STAR_RE, onMatch: (m, t) => wrap(t, 'strong', 'md-strong', m[1] ?? '') },
  { re: BOLD_UNDER_RE, onMatch: (m, t) => wrap(t, 'strong', 'md-strong', m[1] ?? '') },
  { re: STRIKE_RE, onMatch: (m, t) => wrap(t, 's', 'md-strike', m[1] ?? '') },
  { re: ITALIC_STAR_RE, onMatch: (m, t) => wrap(t, 'em', 'md-em', m[1] ?? '') },
  { re: ITALIC_UNDER_RE, onMatch: (m, t) => wrap(t, 'em', 'md-em', m[1] ?? '') },
];

function renderInline(text: string, target: HTMLElement): void {
  // 1) Split out code spans; 2) format the remaining text segments.
  let rest = text;
  for (;;) {
    const code = CODE_SPAN_RE.exec(rest);
    if (code === null) break;
    formatText(rest.slice(0, code.index), target);
    let payload = code[2] ?? '';
    if (payload.startsWith(' ') && payload.endsWith(' ') && payload.trim() !== '') {
      payload = payload.slice(1, -1);
    }
    const codeEl = document.createElement('code');
    codeEl.className = 'md-code-inline';
    codeEl.textContent = payload.replace(/\n/g, ' ');
    target.append(codeEl);
    rest = rest.slice(code.index + code[0].length);
  }
  formatText(rest, target);
}

/** Earliest-match dispatch over the inline pattern table. */
function formatText(text: string, target: HTMLElement): void {
  let rest = text;
  for (;;) {
    let hit: { at: number; pattern: InlinePattern; match: RegExpExecArray } | null = null;
    for (const pattern of INLINE_PATTERNS) {
      const m = pattern.re.exec(rest);
      if (m === null) continue;
      if (hit === null || m.index < hit.at) hit = { at: m.index, pattern, match: m };
    }
    if (hit === null) break;
    target.append(document.createTextNode(unescapeChars(rest.slice(0, hit.at))));
    hit.pattern.onMatch(hit.match, target);
    rest = rest.slice(hit.at + hit.match[0].length);
  }
  target.append(document.createTextNode(unescapeChars(rest)));
}

/** GFM backslash escapes: `\*` shows as `*`, etc. */
function unescapeChars(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, '$1');
}
