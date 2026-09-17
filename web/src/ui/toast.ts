/**
 * Toast stack (E7): in-app notification toasts. Product notices that need
 * eyes land here for a few seconds — the notification center (bell panel)
 * is the durable list; toasts are the live tap on the shoulder. Every
 * shown toast earns a display receipt via the caller's onShown callback
 * (the shown:true doctrine: nothing is displayed unproven).
 */

import { el } from './dom.js';

export interface ToastInput {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly severity: 'info' | 'error';
  /** Fired once when the toast is DISPLAYED (the shown receipt). */
  readonly onShown: () => void;
}

const TOAST_MS = 6_000;
/** Max simultaneous toasts — older ones make room for newer. */
const MAX_TOASTS = 4;

export class ToastStack {
  private readonly mount: HTMLElement;
  private readonly toasts = new Map<string, HTMLElement>();

  constructor(mount: HTMLElement | null) {
    this.mount = mount ?? el('div');
    if (mount === null) this.mount.className = 'toast-stack';
  }

  /** Idempotent per id: a re-render of the same notification never
   * double-toasts (and never double-receipts). */
  show(input: ToastInput): void {
    if (this.toasts.has(input.id)) return;
    while (this.toasts.size >= MAX_TOASTS) {
      const oldest = this.mount.firstElementChild;
      if (oldest === null) break;
      this.dismiss(oldest as HTMLElement);
    }
    const toast = el('div', `toast toast--${input.severity} reveal`);
    toast.dataset.toastId = input.id;
    const text = el('div', 'toast__text');
    text.append(el('div', 'toast__title', input.title));
    if (input.detail !== null && input.detail !== '') {
      text.append(el('div', 'toast__detail', input.detail));
    }
    const close = document.createElement('button');
    close.className = 'toast__close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => this.dismiss(toast));
    toast.append(text, close);
    toast.addEventListener('click', (event) => {
      if (event.target === close) return;
      this.dismiss(toast);
    });
    this.mount.append(toast);
    this.toasts.set(input.id, toast);
    input.onShown();
    setTimeout(() => this.dismiss(toast), TOAST_MS);
  }

  private dismiss(toast: HTMLElement): void {
    const id = toast.dataset.toastId ?? '';
    if (!this.toasts.has(id)) return;
    this.toasts.delete(id);
    toast.remove();
  }
}
