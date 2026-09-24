/**
 * Chat view: one DOM tree, two placements (board UX v5/v6). At/above the
 * cockpit breakpoint the panel is the left console pane; below it the
 * panel is reparented into the overlay sheet (bottom sheet on a phone,
 * right drawer on a tablet) opened by the Gru FAB. One message log, one
 * socket, one composer either way.
 *
 * The composer owns the ONE attach flow (SPEC ruling 19): an attach
 * button opens a picker that browses the service's workspace root
 * (on-disk picks become PATH chips — no bytes) or takes device files
 * (phone/camera; bytes materialize into the instance uploads dir and
 * THAT path becomes the chip). Clipboard image paste materializes the
 * same way. The user NEVER types or pastes paths.
 *
 * Unread (v5): a message that lands while no chat surface is in sight
 * counts; the FAB badge and the collapsed console rail's pulse follow.
 */

import type { ChatMessage, ConnectionState } from '../lib/chat-client.js';
import type {
  AttachmentChip,
  ContextEventFrame,
  ContextFrame,
  ControlAction,
  ControlResultFrame,
  LoggedFrame,
} from '../lib/protocol.js';
import { imageKindFor, type BrowseResult, type UploadedFile } from '../lib/attach-client.js';
import { COCKPIT_MIN_WIDTH } from '../lib/console-layout.js';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '../lib/protocol.js';
import { renderMarkdown } from '../lib/markdown.js';
import { el, mustGet } from './dom.js';

/** The chat overlay takes over below the cockpit width (v6). */
const OVERLAY_QUERY = `(max-width: ${COCKPIT_MIN_WIDTH - 1}px)`;

/** Touch devices: the return key inserts a newline (composer fork 1,
 * user ruling 2026-09-20) — the send gesture is the always-visible Send
 * button. `pointer: coarse` describes the PRIMARY input modality, which
 * is what a virtual keyboard's return-key semantics follow; width-only
 * sniffing would misclassify narrow desktop windows and touch-screen
 * laptops (fine primary pointer) as touch. */
const COARSE_QUERY = '(pointer: coarse)';

/** Distance from the log's bottom edge (px) that still counts as "near the
 * bottom" for auto-follow — about one line of body text. */
const STICK_THRESHOLD_PX = 40;

/** The attach resolution surface main.ts binds per pair (token rotates). */
export interface AttachSurface {
  browse(path: string): Promise<BrowseResult>;
  upload(file: File): Promise<UploadedFile>;
}

/** The composer's send seam returns false when the message was NOT
 * queued (no client / rejected) — the composer keeps the typed words and
 * chips (review r1: clearing first violated "never lose a typed word"). */

interface PendingResetView {
  readonly nodes: readonly Node[];
  readonly bubbles: Map<string, HTMLElement>;
  readonly streamingBubble: HTMLElement | null;
  readonly streamingBody: HTMLElement | null;
  readonly streamText: string;
  readonly streamOpen: boolean;
  readonly activeTool: HTMLElement | null;
  readonly activeToolBand: ServiceBand | null;
  readonly serviceBand: ServiceBand | null;
  readonly unread: number;
}

/** One collapsed run of service-context frames (tool lines + notices). */
interface ServiceBand {
  readonly root: HTMLElement;
  readonly head: HTMLButtonElement;
  readonly detail: HTMLElement;
  /** A tool inside this band is still running (head shows "· running"). */
  running: boolean;
}

export class ChatView {
  private readonly log = mustGet<HTMLElement>('chat-log');
  private readonly panel = mustGet<HTMLElement>('chat-view');
  private readonly sheet = mustGet<HTMLElement>('chat-sheet');
  private readonly sheetMount = mustGet<HTMLElement>('chat-sheet-mount');
  private readonly scrim = mustGet<HTMLElement>('chat-scrim');
  private readonly fab = mustGet<HTMLButtonElement>('gru-fab');
  private readonly badge = mustGet<HTMLElement>('chat-badge');
  private readonly mainMount = mustGet<HTMLElement>('chat-main-mount');
  private readonly form = mustGet<HTMLFormElement>('chat-form');
  private readonly input = mustGet<HTMLTextAreaElement>('chat-input');
  private readonly chipsRow = mustGet<HTMLElement>('chat-chips');
  private readonly attachButton = mustGet<HTMLButtonElement>('chat-attach');
  private readonly fileInput = mustGet<HTMLInputElement>('chat-attach-file');
  private readonly contextStatus = mustGet<HTMLElement>('chat-context-status');
  private readonly contextAnnouncement = mustGet<HTMLElement>('chat-context-announcement');
  private readonly compactButton = mustGet<HTMLButtonElement>('chat-compact');
  private readonly newChatButton = mustGet<HTMLButtonElement>('chat-new');
  private readonly picker = mustGet<HTMLElement>('attach-picker');
  private readonly pickerList = mustGet<HTMLElement>('attach-picker-list');
  private readonly pickerPath = mustGet<HTMLElement>('attach-picker-path');
  private readonly pickerError = mustGet<HTMLElement>('attach-picker-error');
  private bubbles = new Map<string, HTMLElement>();
  private streamingBubble: HTMLElement | null = null;
  private streamingBody: HTMLElement | null = null;
  private streamText = '';
  /** True between turn:start (or the first bare delta of a partial replay)
   * and closeStream/markStreamIncomplete. The bubble's DOM is created
   * lazily on the first text delta, so tool-only turns leave no stub. */
  private streamOpen = false;
  private activeTool: HTMLElement | null = null;
  private activeToolBand: ServiceBand | null = null;
  /** One collapsed band per run of consecutive service frames (tool lines
   * + product notices) — owner clean-chat clause 2026-09-23: the chat
   * reads as conversation, machinery one tap away. A conversation frame
   * (user message, reply delta, error) closes the run. */
  private serviceBand: ServiceBand | null = null;
  private unread = 0;
  /** Auto-follow engages while the reader is near the log's bottom; a
   * user scroll away disengages until they return or jump-to-latest. */
  private stickToBottom = true;
  /** Last scrollTop the detector observed, for up-vs-down motion. */
  private lastLogScrollTop = 0;
  /** Pending coalesced replay-settle animation frame. */
  private settleFrame: number | null = null;
  private readonly jumpButton: HTMLButtonElement;
  private overlay = window.matchMedia(OVERLAY_QUERY);
  private coarse = window.matchMedia(COARSE_QUERY);
  /** Console pane collapsed to its rail (v5): unread counts follow. */
  private paneCollapsed = false;
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
  private pendingResetView: PendingResetView | null = null;
  private controlsConnected = false;
  private requestControl: ((action: ControlAction) => boolean) | null = null;

  constructor(
    private readonly onSend: (
      text: string,
      attachments?: readonly AttachmentChip[],
    ) => boolean,
  ) {
    // Multi-line composer (textarea): Enter sends, Shift+Enter inserts a
    // newline — DESKTOP/fine-pointer only. Coarse-pointer (touch) devices
    // take the standard mobile pattern: the return key inserts a newline
    // via the native default (which also keeps IME confirmation native),
    // and sending is the button's job. Guards on the intercepting path:
    // modifier combos are not sends; key auto-repeat must not re-submit
    // (a held Enter would stack failed-send notes); IME composition
    // (CJK/emoji pickers) uses Enter to CONFIRM — never send while
    // composing (isComposing; keyCode 229 is the legacy composition code
    // some browsers still emit).
    this.input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      if (this.coarse.matches) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.repeat) return;
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      this.form.requestSubmit();
    });
    // Auto-grow with content; the CSS max-height is the hard cap (the
    // textarea scrolls internally past it) and this keeps height honest.
    this.input.addEventListener('input', () => this.autosize());
    // Reflow outside of typing (window resize) re-wraps lines — re-measure.
    window.addEventListener('resize', () => this.autosize());
    this.setEnterKeyHint();
    // Keyboard attach/detach (tablets etc.) flips the touch pattern live.
    this.coarse.addEventListener('change', () => this.setEnterKeyHint());
    this.autosize();

    this.form.addEventListener('submit', (event) => {
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
      this.autosize(); // collapse back to one row after send/clear
      this.clearChips();
      this.closePicker();
    });

    this.wireAttachFlow();
    this.compactButton.addEventListener('click', () => {
      this.beginControl('compact');
    });
    this.newChatButton.addEventListener('click', () => {
      if (!window.confirm('Start a new chat? Durable history is kept, but this active view will clear.')) {
        return;
      }
      this.beginControl('new_chat');
    });
    this.renderContext();

    // Jump-to-latest: overlays the log's bottom edge while auto-follow is
    // disengaged (the reader is in history); clicking re-engages.
    this.jumpButton = el('button', 'chat-jump', '↓ Latest');
    this.jumpButton.type = 'button';
    this.jumpButton.setAttribute('aria-label', 'Jump to the latest message');
    this.jumpButton.hidden = true;
    this.jumpButton.addEventListener('click', () => this.scrollToEnd());
    this.panel.append(this.jumpButton);
    this.log.addEventListener('scroll', this.onLogScroll);

    this.scrim.addEventListener('click', () => this.setSheetOpen(false));
    const grip = mustGet<HTMLElement>('chat-sheet-grip');
    grip.addEventListener('click', () => this.setSheetOpen(false));
    grip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.setSheetOpen(false);
      }
    });

    const place = (): void => {
      if (this.overlay.matches) {
        // Overlay sheet: bottom sheet on a phone, right drawer on a tablet.
        this.sheetMount.append(this.panel);
      } else {
        // Console pane: the left column of the three-pane estate.
        this.mainMount.append(this.panel);
        this.setSheetOpen(false);
      }
      // New container width reflows lines — re-measure the composer.
      this.autosize();
    };
    this.overlay.addEventListener('change', place);
    place();
    // Sheet starts closed: inert until first opened.
    this.sheet.toggleAttribute('inert', this.sheet.dataset.open !== 'true');
    // Unread surfaces start at zero (FAB badge + rail dot).
    this.renderUnread();
  }

  /** The virtual keyboard's return key is labeled for its actual job:
   * newline on touch, send on desktop. */
  private setEnterKeyHint(): void {
    this.input.setAttribute('enterkeyhint', this.coarse.matches ? 'enter' : 'send');
  }

  /** Grow the composer to fit its content (one row at rest); the CSS
   * `max-height` cap clamps it, then the textarea scrolls internally.
   * An empty composer gets NO inline height: intrinsic rows="1" sizing
   * is one row, and Chromium folds a WRAPPED placeholder (narrow sheet)
   * into scrollHeight when collapsed — placeholder must never drive
   * layout. Non-empty: measure with the height collapsed so scrollHeight
   * reflects CONTENT. */
  private autosize(): void {
    if (this.input.value === '') {
      this.input.style.removeProperty('height');
      return;
    }
    this.input.style.height = '0';
    // scrollHeight excludes borders; box-sizing is border-box, so the
    // explicit height must carry them (offsetHeight − clientHeight at the
    // collapsed state is exactly the border box).
    const borders = this.input.offsetHeight - this.input.clientHeight;
    this.input.style.height = `${this.input.scrollHeight + borders}px`;
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
    if (action === 'new_chat') this.beginPendingResetView();
    // Disable immediately against double-clicks; the server's canonical
    // snapshot replaces this optimistic busy state on the next frame.
    this.context = {
      ...this.context,
      state: action === 'compact' ? 'compacting' : 'resetting',
      usage: null,
    };
    this.renderContext();
  }

  /** Restore the optimistic empty view from a tab-persisted unresolved
   * New-chat marker after reload/re-pair. */
  restorePendingNewChat(): void {
    this.beginPendingResetView();
  }

  private beginPendingResetView(): void {
    if (this.pendingResetView !== null) return;
    this.pendingResetView = {
      nodes: [...this.log.childNodes],
      bubbles: this.bubbles,
      streamingBubble: this.streamingBubble,
      streamingBody: this.streamingBody,
      streamText: this.streamText,
      streamOpen: this.streamOpen,
      activeTool: this.activeTool,
      activeToolBand: this.activeToolBand,
      serviceBand: this.serviceBand,
      unread: this.unread,
    };
    // Confirmation accepted: immediately show the fresh pending view. The
    // detached render model remains available for an uncommitted failure.
    this.log.replaceChildren();
    this.bubbles = new Map();
    this.streamingBubble = null;
    this.streamingBody = null;
    this.streamText = '';
    this.streamOpen = false;
    this.activeTool = null;
    this.activeToolBand = null;
    this.serviceBand = null;
    this.unread = 0;
    this.cancelSettleScroll();
    this.stickToBottom = true;
    this.jumpButton.hidden = true;
    this.lastLogScrollTop = 0;
    this.clearUnread();
  }

  private rollbackPendingResetView(): void {
    const prior = this.pendingResetView;
    if (prior === null) return;
    const pendingNodes = [...this.log.childNodes];
    const pendingBubbles = this.bubbles;
    this.log.replaceChildren(...prior.nodes, ...pendingNodes);
    this.bubbles = prior.bubbles;
    for (const [id, bubble] of pendingBubbles) this.bubbles.set(id, bubble);
    this.streamingBubble = prior.streamingBubble;
    this.streamingBody = prior.streamingBody;
    this.streamText = prior.streamText;
    this.streamOpen = prior.streamOpen;
    this.activeTool = prior.activeTool;
    this.activeToolBand = prior.activeToolBand;
    this.serviceBand = prior.serviceBand;
    this.unread = prior.unread;
    this.renderUnread();
    this.pendingResetView = null;
    this.scrollToEnd();
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
      if (result.action === 'new_chat') this.rollbackPendingResetView();
      const message =
        `${result.action === 'compact' ? 'compact context' : 'new chat'} failed: ` +
        (result.message ?? result.code ?? 'unknown error');
      this.ephemeralNote(message);
      this.announceContextOutcome(message);
    } else if (result.action === 'compact') {
      this.ephemeralNote('context compacted');
      this.announceContextOutcome('Context compacted successfully');
    }
  }

  showContextEvent(event: ContextEventFrame): void {
    const message = event.ok
      ? event.action === 'compact'
        ? 'Context compacted successfully'
        : 'New chat started'
      : event.message ??
        (event.action === 'compact' ? 'Context compaction failed' : 'New chat supervision degraded');
    this.ephemeralNote(message);
    this.announceContextOutcome(message);
  }

  private announceContextOutcome(message: string): void {
    // A dedicated persistent live region is intentionally independent from
    // the frequently-refreshed usage/status chip, so the following idle
    // context snapshot cannot overwrite a terminal announcement.
    this.contextAnnouncement.textContent = message;
  }

  private renderContext(): void {
    const snapshot = this.context;
    const connected = this.controlsConnected;
    const busy = snapshot?.state !== 'idle';
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
    this.compactButton.disabled =
      !connected || snapshot === null || busy || !snapshot.writer ||
      !snapshot.session_active || !snapshot.compact_supported;
    this.compactButton.title =
      snapshot !== null && !snapshot.writer
        ? 'Read-only tab: another client holds the pen'
        : snapshot !== null && !snapshot.compact_supported
          ? 'Native compaction is unavailable for this runtime'
          : 'Compact context in the current native session';
    this.newChatButton.disabled = !connected || snapshot === null || busy || !snapshot.writer;
    this.newChatButton.title =
      snapshot !== null && !snapshot.writer
        ? 'Read-only tab: another client holds the pen'
        : 'Start a truly fresh native conversation';
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
    this.followContent(true);
    setTimeout(() => line.remove(), 6_000);
  }

  /** Open the phone/tablet chat overlay (the nav Chat tab and the FAB). */
  openSheet(): void {
    this.setSheetOpen(true);
  }

  /** Dismiss the overlay (the nav Board tab, the scrim, the grip). */
  closeSheet(): void {
    this.setSheetOpen(false);
  }

  /** Hand the composer focus (the FAB/rail expanding the console pane). */
  focusComposer(): void {
    this.input.focus();
    this.scrollToEnd();
  }

  /** Console (v5): the pane collapsed to its slim rail. Unread counting
   * follows the collapsed rail, and expanding the pane clears it. */
  setPaneCollapsed(collapsed: boolean): void {
    this.paneCollapsed = collapsed;
    if (!collapsed && !this.overlay.matches) this.clearUnread();
  }

  /** Is a chat surface in sight right now? Overlay mode follows the sheet;
   * the console follows the pane. */
  private chatVisible(): boolean {
    if (this.overlay.matches) return this.sheet.dataset.open === 'true';
    return !this.paneCollapsed;
  }

  private setSheetOpen(open: boolean): void {
    this.sheet.dataset.open = String(open);
    // A closed sheet is visually hidden AND unfocusable/unannounced.
    this.sheet.toggleAttribute('inert', !open);
    // The board stays visible behind, dimmed (v5).
    this.scrim.hidden = !open;
    if (open) {
      this.clearUnread();
      this.scrollToEnd();
    }
  }

  /** Fresh page load: the server replays everything — rebuild the log. */
  reset(): void {
    this.pendingResetView = null;
    this.log.replaceChildren();
    this.bubbles.clear();
    this.clearUnread();
    this.streamingBubble = null;
    this.streamingBody = null;
    this.streamText = '';
    this.streamOpen = false;
    this.activeTool = null;
    this.activeToolBand = null;
    this.serviceBand = null;
    this.cancelSettleScroll();
    this.stickToBottom = true;
    this.jumpButton.hidden = true;
    this.lastLogScrollTop = 0;
  }

  /** User message status changes: queued → sent → acked. `live` is false
   * for replayed frames: the viewport settle coalesces those. */
  upsertMessage(message: ChatMessage, live = true): void {
    // A user message is conversation: it ends any open service run.
    this.closeServiceBand();
    let bubble = this.bubbles.get(message.client_msg_id);
    const fresh = bubble === undefined;
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
    if (!live) {
      this.scheduleSettleScroll();
    } else if (fresh) {
      // A just-sent message is a deliberate gesture: show it + re-engage.
      this.scrollToEnd();
    } else {
      this.followContent(true);
    }
  }

  /** Server frames: streamed Gru replies, tool lines, replayed history. */
  addFrame(frame: LoggedFrame, live: boolean): void {
    switch (frame.type) {
      case 'user': {
        this.upsertMessage(
          {
            client_msg_id: frame.client_msg_id,
            text: frame.text,
            status: 'acked',
            ...(frame.attachments !== undefined ? { attachments: frame.attachments } : {}),
          },
          live,
        );
        break;
      }
      case 'delta': {
        // Gru replies render as GFM markdown (issue #10: users must never
        // see raw pipes/fences). Accumulate and re-render atomically per
        // delta — one paint, no flicker; incomplete constructs hold stable.
        //
        // Open the stream BEFORE accumulating: openStream() resets
        // streamText when it opens fresh state, so resetting after the
        // `+=` would silently wipe the FIRST replayed delta of a same-page
        // reconnect (partial replay: bare deltas, no turn:start, no reset —
        // Perkins r1/r2 blocker). Order is load-bearing. The bubble's DOM
        // is created lazily on the first text delta too: a tool-only turn
        // never leaves an empty stub.
        this.closeServiceBand();
        if (!this.streamOpen) this.openStream();
        this.streamText += frame.text;
        if (frame.text !== '') {
          const body = this.streamingBody ?? this.mountStreamBubble();
          renderMarkdown(this.streamText, body, { streaming: true });
        }
        if (live) this.bumpUnread();
        this.followContent(live);
        break;
      }
      case 'tool': {
        if (frame.state === 'start') {
          this.activeTool?.remove();
          if (this.activeToolBand !== null) {
            this.activeToolBand.running = false;
            if (this.activeToolBand.detail.childElementCount === 0) {
              this.activeToolBand.root.remove();
              if (this.serviceBand === this.activeToolBand) this.serviceBand = null;
            } else {
              this.renderServiceHead(this.activeToolBand);
            }
            this.activeToolBand = null;
          }
          const line = el('div', 'tool-line tool-line--active', `⚙️ ${frame.name}`);
          line.dataset.toolName = frame.name;
          const band = this.appendServiceLine(line);
          band.running = true;
          this.renderServiceHead(band);
          this.activeTool = line;
          this.activeToolBand = band;
        } else {
          // Only settle the line whose name matches; a stray end for an
          // unknown tool renders standalone instead of cross-labeling.
          if (this.activeTool !== null && this.activeTool.dataset.toolName === frame.name) {
            this.activeTool.classList.remove('tool-line--active');
            this.activeTool.textContent = `⚙️ ${frame.name} · done`;
            this.activeTool = null;
            if (this.activeToolBand !== null) {
              this.activeToolBand.running = false;
              this.renderServiceHead(this.activeToolBand);
              this.activeToolBand = null;
            }
          } else if (this.activeTool === null) {
            this.appendServiceLine(el('div', 'tool-line', `⚙️ ${frame.name} · done`));
          }
        }
        this.followContent(live);
        break;
      }
      case 'turn': {
        if (frame.state === 'start') {
          this.openStream();
        } else {
          this.closeStream();
          // The final render can change height (held fragments resolve):
          // keep a stuck viewport at the bottom, never move a disengaged one.
          this.followContent(live);
        }
        break;
      }
      case 'error': {
        this.closeServiceBand();
        const line = el('div', 'tool-line', `⚠️ ${frame.message}`);
        this.log.append(line);
        this.followContent(live);
        break;
      }
      case 'notice': {
        // E7: product notices (wake failures, supervisor restarts, control
        // outcomes) are service machinery — they join the collapsed
        // service band so the conversation stays readable.
        this.appendServiceLine(el('div', 'notice-line', frame.text));
        if (live) this.bumpUnread();
        this.followContent(live);
        break;
      }
    }
  }

  /** Append a service-context line to the open band (opening one if the
   * previous frame was conversation); returns the band for head updates. */
  private appendServiceLine(node: HTMLElement): ServiceBand {
    // Reset rollback can restore an older band with a newer user bubble
    // after it. Never append a notice before that intervening conversation.
    const band = this.serviceBand?.root === this.log.lastElementChild
      ? this.serviceBand : this.openServiceBand();
    band.detail.append(node);
    this.renderServiceHead(band);
    return band;
  }

  private openServiceBand(): ServiceBand {
    const root = el('div', 'service-band');
    const head = el('button', 'service-band__head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');
    const detail = el('div', 'service-band__detail');
    detail.hidden = true;
    const band: ServiceBand = { root, head, detail, running: false };
    head.addEventListener('click', () => {
      detail.hidden = !detail.hidden;
      head.setAttribute('aria-expanded', String(!detail.hidden));
      this.renderServiceHead(band);
    });
    root.append(head, detail);
    this.log.append(root);
    this.serviceBand = band;
    return band;
  }

  private renderServiceHead(band: ServiceBand): void {
    const count = band.detail.childElementCount;
    const suffix = band.running ? ' · running' : '';
    band.head.textContent = `⚙️ ${count} service event${count === 1 ? '' : 's'}${suffix} — ${
      band.detail.hidden ? 'expand' : 'collapse'
    }`;
  }

  /** A conversation frame arrived; the next service frame starts a fresh
   * band (consecutive runs only). */
  private closeServiceBand(): void {
    this.serviceBand = null;
  }

  /** Open the LOGICAL stream for a turn (or for the first bare delta of a
   * partial replay). No DOM yet — the bubble mounts with the first text. */
  private openStream(): void {
    if (this.streamOpen) return;
    this.streamOpen = true;
    this.streamingBubble = null;
    this.streamingBody = null;
    this.streamText = '';
  }

  /** Lazily create the Gru bubble for the first text delta of a stream. */
  private mountStreamBubble(): HTMLElement {
    const bubble = el('div', 'msg msg--gru msg--streaming');
    const body = el('div', 'msg__body');
    bubble.append(body);
    this.streamingBubble = bubble;
    this.streamingBody = body;
    this.log.append(bubble);
    return body;
  }

  private closeStream(): void {
    // Turn end = the document is complete: finalize the render so held
    // streaming fragments (partial fence markers etc.) resolve per GFM.
    if (this.streamingBody !== null) renderMarkdown(this.streamText, this.streamingBody);
    // Defensive: a stream that never produced text (every delta empty)
    // must not leave an empty stub behind.
    if (this.streamingBubble !== null && this.streamText.trim() === '') {
      this.streamingBubble.remove();
    }
    this.streamingBubble?.classList.remove('msg--streaming');
    this.streamOpen = false;
    this.streamingBubble = null;
    this.streamingBody = null;
    this.streamText = '';
  }

  /** A dropped socket mid-turn leaves the bubble marked incomplete. */
  markStreamIncomplete(): void {
    if (this.streamingBubble !== null) {
      this.streamingBubble.append(el('span', 'msg__meta', 'connection lost — resuming…'));
    }
    // No bubble (tool-only turn) just closes the logical stream so a later
    // replayed delta opens a fresh one instead of appending to a ghost.
    this.closeStream();
  }

  private bumpUnread(): void {
    if (this.chatVisible()) return;
    this.unread += 1;
    this.renderUnread();
  }

  /** Reset unread on every surface (FAB badge + collapsed console rail). */
  private clearUnread(): void {
    this.unread = 0;
    this.renderUnread();
  }

  private renderUnread(): void {
    this.fab.dataset.unread = String(this.unread);
    this.badge.textContent = String(this.unread);
    // The collapsed console rail pulses on unread — a subtle dot, not a
    // second counter (the FAB badge carries the number).
    document.getElementById('chat-rail')?.setAttribute('data-unread', String(this.unread));
  }

  // -----------------------------------------------------------------------
  // Viewport policy: replay settle + bottom-stickiness
  // -----------------------------------------------------------------------

  /** User scroll detector. Only an upward move with the bottom still out
   * of reach disengages: programmatic motion (scrollToEnd and its smooth
   * animation) only ever moves down, so it can never read as the user
   * taking over — no echo-guard flag needed. */
  private readonly onLogScroll = (): void => {
    const top = this.log.scrollTop;
    const distance = this.log.scrollHeight - top - this.log.clientHeight;
    if (distance <= STICK_THRESHOLD_PX) {
      this.setStuck(true);
    } else if (top < this.lastLogScrollTop) {
      this.setStuck(false);
    }
    this.lastLogScrollTop = top;
  };

  /** Show/hide the jump-to-latest pill with the engagement state. */
  private setStuck(stuck: boolean): void {
    if (this.stickToBottom === stuck) return;
    this.stickToBottom = stuck;
    this.jumpButton.hidden = stuck;
  }

  /** New content: replay frames coalesce into one settled scroll; live
   * frames follow only while engaged — a reader in history is never
   * yanked, the jump-to-latest pill surfaces instead. */
  private followContent(live: boolean): void {
    if (!live) {
      this.scheduleSettleScroll();
      return;
    }
    if (this.stickToBottom) this.scrollToEnd();
    else this.jumpButton.hidden = false;
  }

  /** A replay burst re-arms the pending frame while frames keep arriving;
   * exactly one scroll lands once the burst goes quiet. */
  private scheduleSettleScroll(): void {
    this.cancelSettleScroll();
    this.settleFrame = requestAnimationFrame(() => {
      this.settleFrame = null;
      if (this.stickToBottom) this.scrollToEnd();
    });
  }

  private cancelSettleScroll(): void {
    if (this.settleFrame !== null) {
      cancelAnimationFrame(this.settleFrame);
      this.settleFrame = null;
    }
  }

  /** Programmatic scroll to the bottom; always re-engages. */
  private scrollToEnd(): void {
    this.setStuck(true);
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

/** Map connection state onto the nav dot. 'stale' is the board's
 * liveness-window state: the last snapshot is on screen but the socket is
 * presumed dead (recovery already under way). */
export function renderConnectionDot(state: ConnectionState | 'stale'): void {
  const dot = mustGet<HTMLElement>('conn-dot');
  dot.className = 'conn-dot';
  if (state === 'open') dot.classList.add('conn-dot--open');
  else if (state === 'stale') dot.classList.add('conn-dot--stale');
  else if (state === 'connecting' || state === 'authenticating' || state === 'reconnecting')
    dot.classList.add('conn-dot--busy');
  else dot.classList.add('conn-dot--down');
  const label = `socket: ${state}`;
  dot.title = label;
  dot.setAttribute('aria-label', label);
}
