/**
 * Transcript view (E6): searchable, scrollable per-agent transcripts from
 * the session store — better than a terminal pane by design: full
 * scrollback, long lines UNWRAP (pre-wrap, never clipped), server-side
 * search so the browser never loads a whole session file. Newest page
 * first; "load older" pages backwards by entry index cursor.
 */

import type { TranscriptInfo, TranscriptPage, TranscriptSearchResult } from '../lib/board-protocol.js';
import type { BoardClient } from '../lib/board-client.js';
import { el, mustGet } from './dom.js';

const PAGE_SIZE = 50;

export class TranscriptView {
  private readonly drawer: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly searchResults: HTMLElement;
  private readonly loader: HTMLElement;
  private readonly olderBtn: HTMLButtonElement;
  private file: string | null = null;
  private nextCursor: number | null = null;
  private wrap = true;

  constructor(
    private readonly client: BoardClient,
    private readonly listMount: HTMLElement,
  ) {
    this.drawer = mustGet('transcript-drawer');
    this.title = mustGet('transcript-title');
    this.body = mustGet('transcript-body');
    this.searchInput = mustGet<HTMLInputElement>('transcript-search');
    this.searchResults = mustGet('transcript-search-results');
    this.loader = mustGet('transcript-loader');
    this.olderBtn = mustGet<HTMLButtonElement>('transcript-older');
    mustGet<HTMLButtonElement>('transcript-close').addEventListener('click', () => this.close());
    this.olderBtn.addEventListener('click', () => {
      if (this.file !== null && this.nextCursor !== null) void this.loadOlder(this.file, this.nextCursor);
    });
    mustGet<HTMLButtonElement>('transcript-wrap').addEventListener('click', (event) => {
      this.wrap = !this.wrap;
      this.body.classList.toggle('transcript-body--nowrap', !this.wrap);
      (event.target as HTMLButtonElement).textContent = this.wrap ? 'wrap: on' : 'wrap: off';
    });
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    this.searchInput.addEventListener('input', () => {
      if (searchTimer !== null) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        void this.runSearch();
      }, 250);
    });
  }

  /** Populate the transcript picker (agent rail → transcript list). */
  renderList(infos: readonly TranscriptInfo[]): void {
    this.listMount.replaceChildren();
    if (infos.length === 0) {
      this.listMount.append(el('div', 'lbl', 'no session transcripts yet'));
      return;
    }
    for (const info of infos) {
      const row = el('button', 'board-agent');
      row.type = 'button';
      row.addEventListener('click', () => void this.open(info));
      const label = info.agentLabel !== null && info.agentLabel !== '' ? info.agentLabel : `${info.role || 'session'} · ${info.file.split('/').pop() ?? info.file}`;
      row.append(
        el('span', 'board-agent__emoji', info.role === '' ? '📄' : '🧾'),
        el('span', 'board-agent__name', label),
        el('span', 'lbl', formatSize(info.sizeBytes)),
      );
      this.listMount.append(row);
    }
  }

  async open(info: TranscriptInfo): Promise<void> {
    this.file = info.file;
    this.title.textContent = info.agentLabel !== null && info.agentLabel !== '' ? info.agentLabel : info.file.split('/').pop() ?? info.file;
    this.body.replaceChildren();
    this.searchResults.replaceChildren();
    this.searchInput.value = '';
    this.drawer.hidden = false;
    this.setLoading(true);
    try {
      const page = await this.client.pageTranscript(info.file, { limit: PAGE_SIZE });
      this.renderPage(page, true);
    } catch {
      this.body.append(el('div', 'lbl', 'could not load transcript'));
    } finally {
      this.setLoading(false);
    }
  }

  private async loadOlder(file: string, cursor: number): Promise<void> {
    this.olderBtn.disabled = true;
    try {
      const page = await this.client.pageTranscript(file, { before: cursor, limit: PAGE_SIZE });
      this.renderPage(page, false);
    } catch {
      this.body.prepend(el('div', 'lbl', 'could not load older entries'));
    } finally {
      this.olderBtn.disabled = false;
    }
  }

  /** Oldest loaded entry index (or 0 when everything is loaded). */
  private oldestLoaded(): number {
    if (this.nextCursor === null) return 0;
    return this.nextCursor;
  }

  private renderPage(page: TranscriptPage, fresh: boolean): void {
    this.nextCursor = page.nextCursor;
    this.olderBtn.hidden = this.nextCursor === null;
    this.olderBtn.textContent = `load older (${page.nextCursor ?? 0} left)`;
    if (fresh && page.skippedTornLines > 0) {
      this.body.append(el('div', 'lbl transcript-torn', `${page.skippedTornLines} unparsable line(s) skipped`));
    }
    if (fresh && page.total === 0) {
      this.body.append(el('div', 'lbl', 'this session has no entries yet'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const entry of page.entries) frag.append(this.entryNode(entry));
    if (fresh) this.body.replaceChildren(frag);
    else this.body.prepend(frag);
    // Newest-first rendering: fresh pages land at the TOP (the newest).
    if (fresh) this.body.scrollTop = 0;
  }

  private entryNode(entry: TranscriptPage['entries'][number]): HTMLElement {
    const row = el('div', `transcript-entry transcript-entry--${entry.kind}`);
    row.dataset.entryIndex = String(entry.index);
    if (entry.isError) row.classList.add('transcript-entry--error');
    const head = el('div', 'transcript-entry__head lbl');
    head.textContent = `${entry.kind === 'tool_result' ? `🛠 ${entry.toolName ?? 'tool'}` : entry.kind === 'user' ? '👤 user' : entry.kind === 'assistant' ? '🤖 assistant' : entry.kind}${entry.ts !== null ? ` · ${new Date(entry.ts).toLocaleTimeString()}` : ''}`;
    row.append(head);
    if (entry.thinking !== null && entry.thinking !== '') {
      const think = el('details', 'transcript-entry__thinking');
      think.append(el('summary', '', 'thinking'));
      think.append(el('div', 'transcript-entry__thinking-body', entry.thinking));
      row.append(think);
    }
    if (entry.text !== '') row.append(el('div', 'transcript-entry__text', entry.text));
    return row;
  }

  private async runSearch(): Promise<void> {
    if (this.file === null) return;
    const query = this.searchInput.value.trim();
    this.searchResults.replaceChildren();
    if (query === '') return;
    try {
      const result = await this.client.searchTranscript(this.file, query);
      this.renderSearch(result);
    } catch {
      this.searchResults.append(el('div', 'lbl', 'search failed'));
    }
  }

  private renderSearch(result: TranscriptSearchResult): void {
    if (result.matches.length === 0) {
      this.searchResults.append(el('div', 'lbl', 'no matches'));
    }
    if (result.scanned < result.total) {
      this.searchResults.append(
        el('div', 'lbl', `scanned the newest ${result.scanned} of ${result.total} entries`),
      );
    }
    for (const match of result.matches) {
      const row = el('button', 'transcript-match');
      row.type = 'button';
      row.addEventListener('click', () => {
        void this.jumpTo(match.index);
      });
      row.append(el('span', 'transcript-match__kind lbl', `#${match.index} ${match.kind}`));
      row.append(el('span', 'transcript-match__snippet', match.snippet));
      this.searchResults.append(row);
    }
  }

  /** Jump to an entry index, paging older entries in (bounded) until the
   * index is loaded — search scans the whole file, not just loaded pages. */
  private async jumpTo(index: number): Promise<void> {
    const file = this.file;
    if (file === null) return;
    let guard = 0;
    while (index < this.oldestLoaded() && this.nextCursor !== null && guard < 100) {
      guard += 1;
      const cursor = this.nextCursor;
      let page: TranscriptPage;
      try {
        page = await this.client.pageTranscript(file, { before: cursor, limit: PAGE_SIZE });
      } catch {
        return;
      }
      this.renderPage(page, false);
      if (page.nextCursor === null) break;
    }
    const target = this.body.querySelector<HTMLElement>(`[data-entry-index="${index}"]`);
    if (target !== null) {
      target.scrollIntoView({ block: 'center' });
      target.classList.add('transcript-entry--flash');
      setTimeout(() => target.classList.remove('transcript-entry--flash'), 1_200);
    }
  }

  private setLoading(loading: boolean): void {
    this.loader.hidden = !loading;
  }

  close(): void {
    this.drawer.hidden = true;
    this.file = null;
  }

  refreshList(): void {
    void this.client
      .listTranscripts()
      .then((res) => this.renderList(res.transcripts))
      .catch(() => {
        /* the banner surface carries connection state */
      });
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
