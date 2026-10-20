/**
 * Gru modal dialogs: the ONE themed overlay surface.
 *
 * Native `window.confirm` is banned in this shell: the browser chrome is
 * off-theme and parks its buttons at the top of the screen, far from the
 * gesture that opened it. Every in-app confirmation — and every floating
 * panel (Settings rides this too) — opens here instead: a dim scrim, a
 * centered Playful Planet card at the middle of the viewport wherever the
 * reader happens to be, Escape/scrim/✕ to dismiss, focus trapped inside
 * while open and restored to the opener on close.
 *
 * Two entry points:
 *  - `confirmModal(options): Promise<boolean>` — the themed replacement
 *    for `window.confirm`; resolves `true` ONLY on the explicit confirm
 *    gesture (Escape, scrim, ✕ and cancel all resolve `false`).
 *  - `openModal(options): ModalHandle` — borrows a caller-owned content
 *    node into the dialog body; on close the node is returned to its
 *    original place in the document, untouched.
 *
 * Dialogs stack: Escape always dismisses the topmost one only.
 */

import { el } from './dom.js';

export interface ModalHandle {
  /** Close the dialog. Idempotent — later calls are no-ops. */
  close(): void;
}

export interface ModalOptions {
  readonly title: string;
  /** Decorative badge glyph (e.g. '⚙️', '🧽'); omitted renders no badge. */
  readonly glyph?: string;
  /** Caller-owned node borrowed into the dialog body. A node that lives
   * in the document is returned home on close; a detached node is simply
   * discarded with the dialog (the caller keeps its reference either
   * way — the dialog never destroys content). */
  readonly content: HTMLElement;
  /** Focus target once open; defaults to the card's first focusable. */
  readonly initialFocus?: HTMLElement;
  /** Fired exactly once when the dialog closes, whatever the gesture. */
  readonly onClose?: () => void;
}

export interface ConfirmOptions {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly glyph?: string;
  /** Visual weight of the confirm button: `danger` paints the alert fill. */
  readonly tone?: 'accent' | 'danger';
}

/** Focusable candidates for the Tab trap, in tab order. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Open dialogs, topmost last: Escape dismisses only the top one. */
const stack: GruModal[] = [];

/** Scrim clicks within this window after open are ignored: the tail of
 * the OPENING gesture (a habitual double-click's second press lands on
 * the just-mounted scrim) must not dismiss the dialog it summoned. */
const SCRIM_GRACE_MS = 250;

/** Stamp for unique aria title ids. */
let dialogCount = 0;

class GruModal implements ModalHandle {
  private readonly host: HTMLElement;
  private readonly card: HTMLElement;
  private readonly body: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  /** Where borrowed content came from; null for detached content. */
  private readonly home: { readonly parent: Node; readonly next: Node | null } | null;
  private readonly previouslyFocused: HTMLElement | null;
  /** When open() mounted the host; scrim dismissal is gated on it. */
  private openedAt = 0;
  private closed = false;

  constructor(private readonly options: ModalOptions) {
    const content = options.content;
    this.home =
      content.parentNode !== null ? { parent: content.parentNode, next: content.nextSibling } : null;
    this.previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    dialogCount += 1;
    const titleId = `gru-modal-title-${dialogCount}`;

    this.host = el('div', 'gru-modal');
    this.card = el('div', 'gru-modal__card pp-card');
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', titleId);

    const head = el('div', 'gru-modal__head');
    if (options.glyph !== undefined) {
      const badge = el('span', 'gru-modal__glyph', options.glyph);
      badge.setAttribute('aria-hidden', 'true');
      head.append(badge);
    }
    const title = el('h2', 'gru-modal__title', options.title);
    title.id = titleId;
    const close = el('button', 'pp-btn pp-btn--secondary gru-modal__close', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close dialog');
    close.addEventListener('click', () => this.close());
    head.append(title, close);

    const body = el('div', 'gru-modal__body');
    body.append(content);

    this.closeButton = close;
    this.body = body;

    this.card.append(head, body);
    this.host.append(this.card);
    // The scrim is the host itself: only a click that reaches it (not one
    // settling on the card) dismisses — and never inside the opening
    // gesture's grace window (see SCRIM_GRACE_MS).
    this.host.addEventListener('click', (event) => {
      if (event.target !== this.host) return;
      if (Date.now() - this.openedAt < SCRIM_GRACE_MS) return;
      this.close();
    });
  }

  /** Mount and focus. Construction alone keeps the dialog inert. */
  open(): void {
    document.body.append(this.host);
    document.documentElement.classList.add('gru-modal-open');
    document.addEventListener('keydown', this.onKeydown, true);
    stack.push(this);
    this.openedAt = Date.now();
    // Initial focus: the caller's target, else the content's first
    // control, else the card's ✕ — the dialog's primary purpose wins,
    // dismissal is the fallback, and the card itself (tabindex -1) is
    // the floor for content with no controls at all.
    this.card.tabIndex = -1;
    (this.options.initialFocus ?? this.firstBodyFocusable() ?? this.closeButton).focus();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Borrowed content goes home before the host leaves, so the node is
    // never removed with the dialog it was lent to.
    if (this.home !== null) {
      this.home.parent.insertBefore(this.options.content, this.home.next);
    }
    this.host.remove();
    const index = stack.indexOf(this);
    if (index !== -1) stack.splice(index, 1);
    if (stack.length === 0) document.documentElement.classList.remove('gru-modal-open');
    document.removeEventListener('keydown', this.onKeydown, true);
    if (this.previouslyFocused !== null && this.previouslyFocused.isConnected) {
      this.previouslyFocused.focus();
    }
    this.options.onClose?.();
  }

  /** Escape dismisses the TOPMOST dialog only — and is fully consumed
   * here (capture + stopPropagation), so a picker or sheet listening on
   * the bubble phase behind the scrim never sees THIS Escape too. */
  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (stack[stack.length - 1] !== this) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key === 'Tab') this.trapTab(event);
  };

  private trapTab(event: KeyboardEvent): void {
    const focusables = this.focusables();
    // The ✕ button is never disabled, so this list always has entries;
    // the guard stays as the invariant floor should that ever change.
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const current = document.activeElement;
    // "On a control" is FOCUSABLES MEMBERSHIP, not card containment: the
    // card itself can hold focus (tabindex -1, click on chrome), and a
    // contains()-only check would let a native Tab escape from there —
    // behind the scrim, out of the trap the dialog promises.
    const onControl = current instanceof HTMLElement && focusables.includes(current);
    if (!onControl || (event.shiftKey ? current === first : current === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  private focusables(): HTMLElement[] {
    return [...this.card.querySelectorAll<HTMLElement>(FOCUSABLE)];
  }

  private firstBodyFocusable(): HTMLElement | null {
    return this.body.querySelector<HTMLElement>(FOCUSABLE);
  }
}

/** Open a themed dialog around caller-owned content. */
export function openModal(options: ModalOptions): ModalHandle {
  const modal = new GruModal(options);
  modal.open();
  return modal;
}

/** The themed `window.confirm`: resolves true only on the confirm button. */
export function confirmModal(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const text = el('p', 'gru-modal__text', options.body);
    const cancel = el('button', 'pp-btn pp-btn--secondary gru-modal__cancel', options.cancelLabel);
    cancel.type = 'button';
    const confirm = el('button', 'pp-btn gru-modal__confirm', options.confirmLabel);
    confirm.type = 'button';
    if (options.tone === 'danger') confirm.classList.add('gru-modal__confirm--danger');
    const actions = el('div', 'gru-modal__actions');
    actions.append(cancel, confirm);
    const content = el('div', 'gru-modal__confirm-card');
    content.append(text, actions);
    // Synthetic content has no home: it lives and dies with the dialog.
    const dialog = openModal({
      title: options.title,
      glyph: options.glyph,
      content,
      initialFocus: confirm,
      // Every dismissal gesture funnels here; only the confirm button has
      // resolved true by then, and a settled promise ignores the rewrite.
      onClose: () => resolve(false),
    });
    cancel.addEventListener('click', () => dialog.close());
    confirm.addEventListener('click', () => {
      resolve(true);
      dialog.close();
    });
  });
}
