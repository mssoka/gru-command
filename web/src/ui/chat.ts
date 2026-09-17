/**
 * Chat view: desktop panel + mobile corner-bubble sheet over one DOM tree.
 * A matchMedia listener reparents the panel into the sheet on small
 * screens, so there is exactly one message log to keep in sync.
 */

import type { ChatMessage, ConnectionState } from '../lib/chat-client.js';
import type { LoggedFrame } from '../lib/protocol.js';
import { renderMarkdown } from '../lib/markdown.js';
import { el, mustGet } from './dom.js';

const MOBILE_QUERY = '(max-width: 768px)';

export class ChatView {
  private readonly log = mustGet<HTMLElement>('chat-log');
  private readonly panel = mustGet<HTMLElement>('chat-view');
  private readonly sheet = mustGet<HTMLElement>('chat-sheet');
  private readonly sheetMount = mustGet<HTMLElement>('chat-sheet-mount');
  private readonly bubble = mustGet<HTMLButtonElement>('chat-bubble');
  private readonly badge = mustGet<HTMLElement>('chat-badge');
  private readonly mainMount = mustGet<HTMLElement>('chat-main-mount');
  private readonly bubbles = new Map<string, HTMLElement>();
  private streamingBubble: HTMLElement | null = null;
  private streamingBody: HTMLElement | null = null;
  private streamText = '';
  private activeTool: HTMLElement | null = null;
  private unread = 0;
  private mobile = window.matchMedia(MOBILE_QUERY);

  constructor(onSend: (text: string) => void) {
    mustGet<HTMLFormElement>('chat-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = mustGet<HTMLInputElement>('chat-input');
      const text = input.value.trim();
      if (text === '') return;
      input.value = '';
      onSend(text);
    });

    this.bubble.addEventListener('click', () => this.setSheetOpen(true));
    const grip = mustGet<HTMLElement>('chat-sheet-grip');
    grip.addEventListener('click', () => this.setSheetOpen(false));
    grip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.setSheetOpen(false);
      }
    });

    const place = (): void => {
      if (this.mobile.matches) {
        this.panel.classList.remove('chat-panel--desktop');
        this.sheetMount.append(this.panel);
      } else {
        this.panel.classList.add('chat-panel--desktop');
        this.mainMount.append(this.panel);
        this.setSheetOpen(false);
      }
    };
    this.mobile.addEventListener('change', place);
    place();
    // Sheet starts closed: inert until first opened.
    this.sheet.toggleAttribute('inert', this.sheet.dataset.open !== 'true');
  }

  /** Open the phone chat sheet (the nav Chat tab on mobile does this). */
  openSheet(): void {
    this.setSheetOpen(true);
  }

  private setSheetOpen(open: boolean): void {
    this.sheet.dataset.open = String(open);
    // A closed sheet is visually hidden AND unfocusable/unannounced.
    this.sheet.toggleAttribute('inert', !open);
    if (open) {
      this.unread = 0;
      this.bubble.dataset.unread = '0';
      this.badge.textContent = '0';
      this.scrollToEnd();
    }
  }

  /** Fresh page load: the server replays everything — rebuild the log. */
  reset(): void {
    this.log.replaceChildren();
    this.bubbles.clear();
    this.streamingBubble = null;
    this.streamingBody = null;
    this.streamText = '';
    this.activeTool = null;
  }

  /** User message status changes: queued → sent → acked. */
  upsertMessage(message: ChatMessage): void {
    let bubble = this.bubbles.get(message.client_msg_id);
    if (bubble === undefined) {
      bubble = el('div', 'msg msg--user');
      this.bubbles.set(message.client_msg_id, bubble);
      this.log.append(bubble);
    }
    bubble.textContent = message.text;
    bubble.classList.toggle('msg--queued', message.status === 'queued');
    const meta =
      message.status === 'queued'
        ? 'queued — sends on reconnect'
        : message.status === 'sent'
          ? 'sent…'
          : null;
    if (meta !== null) bubble.append(el('span', 'msg__meta', meta));
    this.scrollToEnd();
  }

  /** Server frames: streamed Gru replies, tool lines, replayed history. */
  addFrame(frame: LoggedFrame, live: boolean): void {
    switch (frame.type) {
      case 'user': {
        this.upsertMessage({
          client_msg_id: frame.client_msg_id,
          text: frame.text,
          status: 'acked',
        });
        break;
      }
      case 'delta': {
        // Gru replies render as GFM markdown (issue #10: users must never
        // see raw pipes/fences). Accumulate and re-render atomically per
        // delta — one paint, no flicker; incomplete constructs hold stable.
        this.streamText += frame.text;
        const body = this.streamingBody ?? this.openStream();
        renderMarkdown(this.streamText, body, { streaming: true });
        if (live) this.bumpUnread();
        this.scrollToEnd();
        break;
      }
      case 'tool': {
        if (frame.state === 'start') {
          this.activeTool?.remove();
          const line = el('div', 'tool-line tool-line--active', `⚙️ ${frame.name}`);
          line.dataset.toolName = frame.name;
          this.log.append(line);
          this.activeTool = line;
        } else {
          // Only settle the line whose name matches; a stray end for an
          // unknown tool renders standalone instead of cross-labeling.
          if (this.activeTool !== null && this.activeTool.dataset.toolName === frame.name) {
            this.activeTool.classList.remove('tool-line--active');
            this.activeTool.textContent = `⚙️ ${frame.name} · done`;
            this.activeTool = null;
          } else if (this.activeTool === null) {
            this.log.append(el('div', 'tool-line', `⚙️ ${frame.name} · done`));
          }
        }
        this.scrollToEnd();
        break;
      }
      case 'turn': {
        if (frame.state === 'start') {
          this.openStream();
        } else {
          this.closeStream();
        }
        break;
      }
      case 'error': {
        const line = el('div', 'tool-line', `⚠️ ${frame.message}`);
        this.log.append(line);
        this.scrollToEnd();
        break;
      }
    }
  }

  private openStream(): HTMLElement {
    if (this.streamingBody !== null) return this.streamingBody;
    const bubble = el('div', 'msg msg--gru msg--streaming');
    const body = el('div', 'msg__body');
    bubble.append(body);
    this.streamingBubble = bubble;
    this.streamingBody = body;
    this.streamText = '';
    this.log.append(bubble);
    return body;
  }

  private closeStream(): void {
    // Turn end = the document is complete: finalize the render so held
    // streaming fragments (partial fence markers etc.) resolve per GFM.
    if (this.streamingBody !== null) renderMarkdown(this.streamText, this.streamingBody);
    this.streamingBubble?.classList.remove('msg--streaming');
    this.streamingBubble = null;
    this.streamingBody = null;
    this.streamText = '';
  }

  /** A dropped socket mid-turn leaves the bubble marked incomplete. */
  markStreamIncomplete(): void {
    if (this.streamingBubble !== null) {
      this.streamingBubble.append(el('span', 'msg__meta', 'connection lost — resuming…'));
      this.closeStream();
    }
  }

  private bumpUnread(): void {
    if (this.mobile.matches && this.sheet.dataset.open !== 'true') {
      this.unread += 1;
      this.bubble.dataset.unread = String(this.unread);
      this.badge.textContent = String(this.unread);
    }
  }

  private scrollToEnd(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }
}

/** Map connection state onto the nav dot. */
export function renderConnectionDot(state: ConnectionState): void {
  const dot = mustGet<HTMLElement>('conn-dot');
  dot.className = 'conn-dot';
  if (state === 'open') dot.classList.add('conn-dot--open');
  else if (state === 'connecting' || state === 'authenticating' || state === 'reconnecting')
    dot.classList.add('conn-dot--busy');
  else dot.classList.add('conn-dot--down');
  const label = `socket: ${state}`;
  dot.title = label;
  dot.setAttribute('aria-label', label);
}
