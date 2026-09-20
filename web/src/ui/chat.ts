/**
 * Chat view: desktop panel + mobile corner-bubble sheet over one DOM tree.
 * A matchMedia listener reparents the panel into the sheet on small
 * screens, so there is exactly one message log to keep in sync.
 *
 * The composer owns the ONE attach flow (SPEC ruling 19): an attach
 * button opens a picker that browses the service's workspace root
 * (on-disk picks become PATH chips — no bytes) or takes device files
 * (phone/camera; bytes materialize into the instance uploads dir and
 * THAT path becomes the chip). Clipboard image paste materializes the
 * same way. The user NEVER types or pastes paths.
 */

import type { ChatMessage, ConnectionState } from '../lib/chat-client.js';
import type {
  AttachmentChip,
  ContextFrame,
  ControlAction,
  ControlResultFrame,
  LoggedFrame,
} from '../lib/protocol.js';
import { imageKindFor, type BrowseResult, type UploadedFile } from '../lib/attach-client.js';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../lib/protocol.js';
import { renderMarkdown } from '../lib/markdown.js';
import { el, mustGet } from './dom.js';

const MOBILE_QUERY = '(max-width: 768px)';

/** The attach resolution surface main.ts binds per pair (token rotates). */
export interface AttachSurface {
  browse(path: string): Promise<BrowseResult>;
  upload(file: File): Promise<UploadedFile>;
}

/** The composer's send seam returns false when the message was NOT
 * queued (no client / rejected) — the composer keeps the typed words and
 * chips (review r1: clearing first violated "never lose a typed word"). */

export class ChatView {
  private readonly log = mustGet<HTMLElement>('chat-log');
  private readonly panel = mustGet<HTMLElement>('chat-view');
  private readonly sheet = mustGet<HTMLElement>('chat-sheet');
  private readonly sheetMount = mustGet<HTMLElement>('chat-sheet-mount');
  private readonly bubble = mustGet<HTMLButtonElement>('chat-bubble');
  private readonly badge = mustGet<HTMLElement>('chat-badge');
  private readonly mainMount = mustGet<HTMLElement>('chat-main-mount');
  private readonly input = mustGet<HTMLInputElement>('chat-input');
  private readonly chipsRow = mustGet<HTMLElement>('chat-chips');
  private readonly attachButton = mustGet<HTMLButtonElement>('chat-attach');
  private readonly fileInput = mustGet<HTMLInputElement>('chat-attach-file');
  private readonly contextStatus = document.getElementById('chat-context-status');
  private readonly compactButton = document.getElementById('chat-compact') as HTMLButtonElement | null;
  private readonly newChatButton = document.getElementById('chat-new') as HTMLButtonElement | null;
  private readonly picker = mustGet<HTMLElement>('attach-picker');
  private readonly pickerList = mustGet<HTMLElement>('attach-picker-list');
  private readonly pickerPath = mustGet<HTMLElement>('attach-picker-path');
  private readonly pickerError = mustGet<HTMLElement>('attach-picker-error');
  private readonly bubbles = new Map<string, HTMLElement>();
  private streamingBubble: HTMLElement | null = null;
  private streamingBody: HTMLElement | null = null;
  private streamText = '';
  private activeTool: HTMLElement | null = null;
  private unread = 0;
  private mobile = window.matchMedia(MOBILE_QUERY);
  /** Ready-to-send chips (SPEC ruling 19). */
  private pending: AttachmentChip[] = [];
  /** Uploads in flight, keyed by gesture identity (same-name files may overlap). */
  private readonly uploading = new Map<number, string>();
  private nextUploadId = 0;
  private attach: AttachSurface | null = null;
  private pickerAt = '';
  /** Latest browse request/close generation; stale responses never repaint. */
  private browseGeneration = 0;
  /** Absolute workspace root from the current browse (chip paths). */
  private browseRoot = '';
  private context: ContextFrame | null = null;
  private controlsConnected = false;
  private requestControl: ((action: ControlAction) => boolean) | null = null;

  constructor(
    private readonly onSend: (
      text: string,
      attachments?: readonly AttachmentChip[],
    ) => boolean,
  ) {
    mustGet<HTMLFormElement>('chat-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (text === '' && this.pending.length === 0) return;
      // Review r1: uploads still in flight must not silently miss the
      // send — hold the gesture until they land (or fail).
      if (this.uploading.size > 0) {
        this.ephemeralNote('an upload is still on its way — one moment…');
        return;
      }
      const chips = this.pending.length === 0 ? undefined : [...this.pending];
      let queued = false;
      try {
        queued = this.onSend(text, chips);
      } catch (error) {
        this.ephemeralNote(
          `could not send: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!queued) return; // keep the typed words + chips
      this.input.value = '';
      this.clearChips();
      this.closePicker();
    });

    this.wireAttachFlow();
    this.compactButton?.addEventListener('click', () => {
      this.beginControl('compact');
    });
    this.newChatButton?.addEventListener('click', () => {
      if (!window.confirm('Start a new chat? Durable history is kept, but this active view will clear.')) {
        return;
      }
      this.beginControl('new_chat');
    });
    this.renderContext();

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

  // -----------------------------------------------------------------------
  // Context controls
  // -----------------------------------------------------------------------

  bindControls(request: ((action: ControlAction) => boolean) | null): void {
    this.requestControl = request;
    this.renderContext();
  }

  private beginControl(action: ControlAction): void {
    if (this.requestControl?.(action) !== true || this.context === null) return;
    // Disable immediately against double-clicks; the server's canonical
    // snapshot replaces this optimistic busy state on the next frame.
    this.context = {
      ...this.context,
      state: action === 'compact' ? 'compacting' : 'resetting',
      usage: null,
    };
    this.renderContext();
  }

  setControlsConnected(connected: boolean): void {
    this.controlsConnected = connected;
    this.renderContext();
  }

  setContext(snapshot: ContextFrame): void {
    this.context = snapshot;
    this.renderContext();
  }

  showControlResult(result: ControlResultFrame): void {
    if (!result.ok) {
      this.ephemeralNote(
        `${result.action === 'compact' ? 'compact context' : 'new chat'} failed: ` +
          (result.message ?? result.code ?? 'unknown error'),
      );
    } else if (result.action === 'compact') {
      this.ephemeralNote('context compacted');
    }
  }

  private renderContext(): void {
    const snapshot = this.context;
    const connected = this.controlsConnected;
    const busy = snapshot?.state !== 'idle';
    if (this.contextStatus !== null) {
      this.contextStatus.classList.toggle('chat-context__status--busy', connected && busy);
      this.contextStatus.toggleAttribute('aria-busy', connected && busy);
      if (!connected || snapshot === null) {
        this.contextStatus.textContent = 'Context unavailable';
        this.contextStatus.title = 'No current runtime context measurement';
        this.contextStatus.setAttribute('aria-label', 'Context unavailable');
      } else if (snapshot.state === 'busy') {
        this.contextStatus.textContent = 'Gru is working…';
        this.contextStatus.title = 'Context controls are available again after the current turn';
        this.contextStatus.setAttribute('aria-label', 'Gru is working; context controls are busy');
      } else if (snapshot.state === 'compacting') {
        this.contextStatus.textContent = 'Compacting context…';
        this.contextStatus.title = 'Native compaction is in progress';
        this.contextStatus.setAttribute('aria-label', 'Compacting context');
      } else if (snapshot.state === 'resetting') {
        this.contextStatus.textContent = 'Starting new chat…';
        this.contextStatus.title = 'A fresh native session is being activated';
        this.contextStatus.setAttribute('aria-label', 'Starting a new chat');
      } else if (snapshot.usage === null) {
        this.contextStatus.textContent = 'Context unavailable';
        this.contextStatus.title = 'The runtime did not provide current context usage';
        this.contextStatus.setAttribute('aria-label', 'Context usage unavailable');
      } else {
        const percent = Math.round(Math.max(0, Math.min(100, snapshot.usage.percent)));
        this.contextStatus.textContent = `${percent}% context`;
        this.contextStatus.title =
          `${Math.round(snapshot.usage.tokens).toLocaleString()} of ` +
          `${Math.round(snapshot.usage.context_window).toLocaleString()} tokens`;
        this.contextStatus.setAttribute(
          'aria-label',
          `${percent} percent context used; ${this.contextStatus.title}`,
        );
      }
    }
    if (this.compactButton !== null) {
      this.compactButton.disabled =
        !connected || snapshot === null || busy || !snapshot.writer ||
        !snapshot.session_active || !snapshot.compact_supported;
      this.compactButton.title =
        snapshot !== null && !snapshot.writer
          ? 'Read-only tab: another client holds the pen'
          : snapshot !== null && !snapshot.compact_supported
            ? 'Native compaction is unavailable for this runtime'
            : 'Compact context in the current native session';
    }
    if (this.newChatButton !== null) {
      this.newChatButton.disabled = !connected || snapshot === null || busy || !snapshot.writer;
      this.newChatButton.title =
        snapshot !== null && !snapshot.writer
          ? 'Read-only tab: another client holds the pen'
          : 'Start a truly fresh native conversation';
    }
  }

  // -----------------------------------------------------------------------
  // The ONE attach flow (SPEC ruling 19)
  // -----------------------------------------------------------------------

  /** Bind (or rebind) the resolution surface — main.ts calls per pair. */
  bindAttach(surface: AttachSurface | null): void {
    this.attach = surface;
    this.attachButton.disabled = surface === null;
    this.attachButton.title = surface === null ? 'Attach (pairing required)' : 'Attach files';
    if (surface === null) this.closePicker();
  }

  private wireAttachFlow(): void {
    this.attachButton.addEventListener('click', () => this.openPicker(''));
    this.fileInput.addEventListener('change', () => {
      const files = [...this.fileInput.files ?? []];
      this.fileInput.value = ''; // allow re-picking the same file
      for (const file of files) void this.takeDeviceFile(file);
    });

    mustGet<HTMLButtonElement>('attach-picker-close').addEventListener('click', () =>
      this.closePicker(),
    );
    mustGet<HTMLButtonElement>('attach-picker-up').addEventListener('click', () => {
      void this.openPicker(this.pickerAt === '' ? '' : (this.picker.dataset.parent ?? ''));
    });
    mustGet<HTMLButtonElement>('attach-picker-device').addEventListener('click', () => {
      this.fileInput.click();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.picker.hidden) this.closePicker();
    });

    // Clipboard paste of files/images (Mac-screenshot class): bytes →
    // materialize into the uploads dir → chip (never a pasted path).
    this.input.addEventListener('paste', (event) => {
      const files: File[] = [];
      for (const item of event.clipboardData?.items ?? []) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (file !== null) files.push(file);
      }
      if (files.length === 0) return; // plain text paste flows untouched
      event.preventDefault();
      for (const file of files) void this.takeDeviceFile(file);
    });
  }

  private async openPicker(path: string): Promise<void> {
    if (this.attach === null) return;
    const generation = ++this.browseGeneration;
    this.picker.hidden = false;
    this.attachButton.setAttribute('aria-expanded', 'true');
    this.pickerError.hidden = true;
    this.pickerList.replaceChildren(el('div', 'attach-picker__loading', 'browsing…'));
    try {
      const result = await this.attach.browse(path);
      if (generation !== this.browseGeneration) return;
      this.pickerAt = result.path;
      this.browseRoot = result.root;
      this.picker.dataset.parent = result.parent ?? '';
      this.pickerPath.textContent = `/${result.path}`;
      this.renderBrowse(result);
    } catch (error) {
      if (generation !== this.browseGeneration) return;
      this.pickerList.replaceChildren();
      this.pickerError.textContent = String(error instanceof Error ? error.message : error);
      this.pickerError.hidden = false;
    }
  }

  private renderBrowse(result: BrowseResult): void {
    const list = this.pickerList;
    list.replaceChildren();
    if (result.entries.length === 0) {
      list.append(el('div', 'attach-picker__empty', 'nothing pickable here'));
    }
    for (const entry of result.entries) {
      const row = el('button', `attach-row attach-row--${entry.kind}`);
      row.type = 'button';
      row.dataset.name = entry.name;
      row.dataset.kind = entry.kind;
      const icon = el('span', 'attach-row__icon', entry.kind === 'dir' ? '📁' : entry.image ? '🖼️' : '📄');
      const label = el('span', 'attach-row__name', entry.name);
      row.append(icon, label);
      if (!entry.pickable) {
        row.disabled = true;
        row.title = 'Unavailable: target is outside the workspace';
      } else if (entry.kind === 'dir') {
        row.addEventListener('click', () => void this.openPicker(joinRel(result.path, entry.name)));
      } else {
        row.addEventListener('click', () => {
          this.addChip({
            // ABSOLUTE path: the agent reads the file at this path
            // (ruling 19(c) — the pick is a reference, never a copy).
            path: `${result.root}/${joinRel(result.path, entry.name)}`,
            name: entry.name,
            kind: entry.image ? 'image' : 'file',
          });
          this.closePicker();
        });
      }
      list.append(row);
    }
    if (result.truncated) {
      list.append(
        el(
          'div',
          'attach-picker__truncated',
          'Showing the first 500 entries — narrow this folder to see more.',
        ),
      );
    }
  }

  private closePicker(): void {
    this.browseGeneration += 1;
    this.picker.hidden = true;
    this.attachButton.setAttribute('aria-expanded', 'false');
  }

  /** Device files (phone camera/gallery, desktop picks): bytes → uploads. */
  private async takeDeviceFile(file: File): Promise<void> {
    if (this.attach === null) return;
    if (this.pending.length + this.uploading.size >= MAX_ATTACHMENTS_PER_MESSAGE) {
      this.ephemeralNote(`attachment cap reached (${MAX_ATTACHMENTS_PER_MESSAGE})`);
      return;
    }
    const uploadId = ++this.nextUploadId;
    this.uploading.set(uploadId, file.name);
    this.renderChips();
    try {
      const uploaded = await this.attach.upload(file);
      this.addChip({ path: uploaded.path, name: uploaded.name, kind: imageKindFor(uploaded.name) });
    } catch (error) {
      this.ephemeralNote(
        `could not attach ${file.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.uploading.delete(uploadId);
      this.renderChips();
    }
  }

  private addChip(chip: AttachmentChip): void {
    if (this.pending.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      this.ephemeralNote(`attachment cap reached (${MAX_ATTACHMENTS_PER_MESSAGE})`);
      return;
    }
    // Same path twice adds nothing (review r1: duplicate chips duplicated
    // the manifest lines).
    if (this.pending.some((existing) => existing.path === chip.path)) {
      this.ephemeralNote(`${chip.name} is already attached`);
      return;
    }
    this.pending.push(chip);
    this.renderChips();
  }

  private removeChip(index: number): void {
    this.pending.splice(index, 1);
    this.renderChips();
  }

  private clearChips(): void {
    this.pending = [];
    this.renderChips();
  }

  private renderChips(): void {
    this.chipsRow.replaceChildren();
    for (const name of this.uploading.values()) {
      const chip = el('span', 'attach-chip attach-chip--busy', `⏳ ${name}`);
      this.chipsRow.append(chip);
    }
    this.pending.forEach((chipData, index) => {
      const chip = el('span', 'attach-chip');
      chip.title = chipData.path;
      chip.append(
        el('span', 'attach-chip__icon', chipData.kind === 'image' ? '🖼️' : '📎'),
        el('span', 'attach-chip__name', chipData.name),
      );
      const remove = el('button', 'attach-chip__remove', '✕');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${chipData.name}`);
      remove.addEventListener('click', () => this.removeChip(index));
      chip.append(remove);
      this.chipsRow.append(chip);
    });
    this.chipsRow.hidden = this.chipsRow.childElementCount === 0;
  }

  /** Ephemeral, UI-only notice (never enters the durable log). */
  private ephemeralNote(text: string): void {
    const line = el('div', 'notice-line notice-line--ephemeral', `⚠️ ${text}`);
    this.log.append(line);
    this.scrollToEnd();
    setTimeout(() => line.remove(), 6_000);
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
    this.unread = 0;
    this.bubble.dataset.unread = '0';
    this.badge.textContent = '0';
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
    bubble.replaceChildren();
    if (message.text !== '') bubble.append(el('div', 'msg__text', message.text));
    for (const chip of message.attachments ?? []) bubble.append(renderBubbleChip(chip));
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
          ...(frame.attachments !== undefined ? { attachments: frame.attachments } : {}),
        });
        break;
      }
      case 'delta': {
        // Gru replies render as GFM markdown (issue #10: users must never
        // see raw pipes/fences). Accumulate and re-render atomically per
        // delta — one paint, no flicker; incomplete constructs hold stable.
        //
        // Open the stream BEFORE accumulating: openStream() resets
        // streamText when it creates fresh state, so resetting after the
        // `+=` would silently wipe the FIRST replayed delta of a same-page
        // reconnect (partial replay: bare deltas, no turn:start, no reset —
        // Perkins r1/r2 blocker). Order is load-bearing.
        const body = this.streamingBody ?? this.openStream();
        this.streamText += frame.text;
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
      case 'notice': {
        // E7: product notices (action-required escalations) surface in
        // the chat stream — visually distinct from Gru's own bubbles.
        const line = el('div', 'notice-line', frame.text);
        this.log.append(line);
        if (live) this.bumpUnread();
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

/** A chip pill inside a sent bubble (path on hover/title). */
function renderBubbleChip(chip: AttachmentChip): HTMLElement {
  const pill = el('span', `attach-chip attach-chip--sent attach-chip--${chip.kind}`);
  pill.title = chip.path;
  pill.append(
    el('span', 'attach-chip__icon', chip.kind === 'image' ? '🖼️' : '📎'),
    el('span', 'attach-chip__name', chip.name),
  );
  return pill;
}

function joinRel(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`;
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
