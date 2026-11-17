/**
 * The capture viewer (docs/PR-MEDIA.md, "The FOR YOU card"): every capture
 * of one ready PR/MR in a single Gru dialog, so the owner flips through
 * them without leaving the board.
 *
 * It rides the shared modal (scrim, Escape, focus trap and focus return are
 * the modal's) and adds a stage, the capture's label and caption, a
 * position counter, and a filmstrip. ← and → flip (the ends wrap), Home and
 * End jump, and a still that is shown scaled down zooms to its actual size
 * on a click. Bytes come from the caller's loader, so the viewer never
 * fetches on its own: the board hands it the previews it already holds.
 */

import { el } from './dom.js';
import { openModal, type ModalHandle } from './modal.js';

export interface CaptureViewerItem {
  readonly id: string;
  readonly kind: 'image' | 'video';
  readonly role: 'after' | 'before';
  readonly caption: string;
}

/** A capture's object URL, or the named reason it cannot be shown. */
export type CaptureLoad = { readonly url: string } | { readonly error: string };

export interface CaptureViewerOptions {
  /** The heist the captures belong to: the dialog's title. */
  readonly title: string;
  /** The head the captures are bound to, named beside the counter. */
  readonly headSha: string;
  readonly items: readonly CaptureViewerItem[];
  /** The capture to open on; it must be one of `items`. */
  readonly startId: string;
  /** Never rejects: a capture that cannot be shown resolves to its reason. */
  readonly load: (id: string) => Promise<CaptureLoad>;
  readonly onClose?: () => void;
}

export interface CaptureViewerHandle {
  /** Close the viewer. Idempotent. */
  close(): void;
  /** A line above the stage (the card changed while the viewer was open);
   * null clears it. */
  setNotice(text: string | null): void;
}

export class CaptureViewerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureViewerError';
  }
}

/** How a capture is labelled, on the card and in the viewer alike. */
export function captureLabel(item: Pick<CaptureViewerItem, 'kind' | 'role'>): 'before' | 'clip' | 'after' {
  return item.role === 'before' ? 'before' : item.kind === 'video' ? 'clip' : 'after';
}

const LABEL_CHIP = { before: 'pp-chip--alert', after: 'pp-chip--done', clip: 'pp-chip--rev' } as const;

class CaptureViewer implements CaptureViewerHandle {
  private readonly root = el('div', 'media-viewer');
  private readonly notice = el('div', 'media-viewer__notice');
  private readonly stage = el('div', 'media-viewer__stage');
  private readonly chip = el('span', 'pp-chip media-viewer__label');
  private readonly caption = el('span', 'media-viewer__caption');
  private readonly count = el('span', 'lbl media-viewer__count');
  private readonly full = el('a', 'media-viewer__full', 'full size ↗');
  private readonly thumbs: readonly HTMLButtonElement[];
  private readonly modal: ModalHandle;
  private readonly resize: ResizeObserver | null;
  private index: number;
  /** Bumped on every flip: a load that resolves late paints nothing. */
  private shown = 0;
  private closed = false;

  constructor(private readonly options: CaptureViewerOptions) {
    const { items } = options;
    this.index = items.findIndex((item) => item.id === options.startId);
    if (this.index === -1) {
      throw new CaptureViewerError(`capture ${options.startId} is not one of the ${items.length} captures handed to the viewer`);
    }
    const several = items.length > 1;

    this.notice.hidden = true;
    this.notice.setAttribute('role', 'status');

    const main = el('div', 'media-viewer__main');
    const previous = this.navButton('←', 'Previous capture', -1);
    const next = this.navButton('→', 'Next capture', 1);
    main.append(this.stage);
    if (several) main.append(previous, next);
    else main.classList.add('media-viewer__main--single');

    this.full.target = '_blank';
    this.full.rel = 'noreferrer';
    this.full.title = 'Open the full-size image in a new tab';
    this.full.hidden = true;
    const meta = el('div', 'media-viewer__meta');
    meta.append(this.chip, this.caption, this.count, this.full);

    this.root.append(this.notice, main, meta);

    this.thumbs = several ? items.map((item, at) => this.thumb(item, at)) : [];
    if (several) {
      const strip = el('div', 'media-viewer__strip');
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', 'Captures');
      strip.append(...this.thumbs);
      this.root.append(strip);
    }

    // A still is zoomable only while it is shown scaled down, and a resized
    // window changes that.
    this.resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.refreshZoom()) : null;
    this.resize?.observe(this.stage);

    this.modal = openModal({
      title: options.title,
      glyph: '📸',
      content: this.root,
      cardClass: 'media-viewer-card',
      ...(several ? { initialFocus: next } : {}),
      onKeydown: (event) => this.onKeydown(event),
      onClose: () => this.onClosed(),
    });
    this.show(this.index);
  }

  close(): void {
    this.modal.close();
  }

  setNotice(text: string | null): void {
    this.notice.hidden = text === null;
    this.notice.textContent = text ?? '';
  }

  private onClosed(): void {
    this.closed = true;
    this.resize?.disconnect();
    this.stage.querySelector('video')?.pause();
    this.options.onClose?.();
  }

  private navButton(glyph: string, label: string, step: -1 | 1): HTMLButtonElement {
    const button = el('button', `pp-btn media-viewer__nav media-viewer__nav--${step === -1 ? 'previous' : 'next'}`, glyph);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = `${label} (${glyph})`;
    button.addEventListener('click', () => this.step(step));
    return button;
  }

  private thumb(item: CaptureViewerItem, at: number): HTMLButtonElement {
    const button = el('button', `media-viewer__thumb media-viewer__thumb--${item.kind}`);
    button.type = 'button';
    button.dataset.mediaId = item.id;
    button.title = `${captureLabel(item)} · ${item.caption}`;
    button.setAttribute('aria-label', `Capture ${at + 1} of ${this.options.items.length}: ${captureLabel(item)} · ${item.caption}`);
    button.addEventListener('click', () => this.show(at));
    if (item.kind === 'video') {
      button.textContent = '🎬';
      return button;
    }
    void this.options.load(item.id).then((loaded) => {
      if (this.closed || 'error' in loaded) return;
      const image = document.createElement('img');
      image.src = loaded.url;
      image.alt = '';
      button.append(image);
    });
    return button;
  }

  private step(by: -1 | 1): void {
    const total = this.options.items.length;
    this.show((this.index + by + total) % total);
  }

  /** ← and → flip, Home and End jump. A focused clip keeps its own keys
   * (the player seeks on the arrows), and a chord is the browser's. */
  private onKeydown(event: KeyboardEvent): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target instanceof HTMLVideoElement) return;
    const last = this.options.items.length - 1;
    const to =
      event.key === 'ArrowLeft' ? (this.index === 0 ? last : this.index - 1)
        : event.key === 'ArrowRight' ? (this.index === last ? 0 : this.index + 1)
          : event.key === 'Home' ? 0
            : event.key === 'End' ? last
              : null;
    if (to === null) return;
    event.preventDefault();
    if (to !== this.index) this.show(to);
  }

  private show(index: number): void {
    const item = this.options.items[index];
    if (item === undefined) throw new CaptureViewerError(`no capture at position ${index + 1}`);
    this.index = index;
    this.shown += 1;
    const shown = this.shown;
    const label = captureLabel(item);

    // A clip leaving the stage stops; it never plays on unseen.
    this.stage.querySelector('video')?.pause();
    this.stage.classList.remove('media-viewer__stage--actual');
    this.stage.replaceChildren(el('div', 'media-viewer__status', 'loading…'));
    this.full.hidden = true;
    this.full.removeAttribute('href');

    this.chip.className = `pp-chip media-viewer__label ${LABEL_CHIP[label]}`;
    this.chip.textContent = label;
    this.caption.textContent = item.caption;
    const total = this.options.items.length;
    this.count.textContent = `${total === 1 ? '1 capture' : `${index + 1} of ${total}`} · ${this.options.headSha.slice(0, 8)}`;
    this.thumbs.forEach((thumb, at) => {
      if (at === index) thumb.setAttribute('aria-current', 'true');
      else thumb.removeAttribute('aria-current');
    });
    const current = this.thumbs[index];
    if (current !== undefined && typeof current.scrollIntoView === 'function') {
      current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    void this.options.load(item.id).then((loaded) => {
      if (this.closed || shown !== this.shown) return;
      if ('error' in loaded) {
        this.stage.replaceChildren(el('div', 'media-viewer__status', `preview unavailable: ${loaded.error}`));
        return;
      }
      if (item.kind === 'video') {
        const video = document.createElement('video');
        video.src = loaded.url;
        video.controls = true;
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.setAttribute('aria-label', item.caption);
        this.stage.replaceChildren(video);
        return;
      }
      const zoom = el('button', 'media-viewer__zoom');
      zoom.type = 'button';
      zoom.setAttribute('aria-pressed', 'false');
      const image = document.createElement('img');
      image.alt = item.caption;
      image.addEventListener('load', () => this.refreshZoom());
      image.src = loaded.url;
      zoom.append(image);
      zoom.addEventListener('click', () => this.toggleZoom());
      this.stage.replaceChildren(zoom);
      this.full.href = loaded.url;
      this.full.hidden = false;
      this.refreshZoom();
    });
  }

  /** Enable the zoom only where it changes something: a still that fits at
   * its actual size has nothing to zoom into. */
  private refreshZoom(): void {
    const zoom = this.stage.querySelector<HTMLButtonElement>('.media-viewer__zoom');
    const image = zoom?.querySelector('img');
    if (zoom === null || zoom === undefined || image === null || image === undefined) return;
    const actual = this.stage.classList.contains('media-viewer__stage--actual');
    const scaled = image.naturalWidth > image.clientWidth + 1 || image.naturalHeight > image.clientHeight + 1;
    zoom.disabled = !actual && !scaled;
    zoom.title = actual ? 'Fit to the viewer' : scaled ? 'Show at actual size' : '';
  }

  private toggleZoom(): void {
    const actual = this.stage.classList.toggle('media-viewer__stage--actual');
    this.stage.querySelector('.media-viewer__zoom')?.setAttribute('aria-pressed', String(actual));
    if (!actual) this.stage.scrollTo?.(0, 0);
    this.refreshZoom();
  }
}

/** Open the viewer on `startId`; throws when it is not one of `items`. */
export function openCaptureViewer(options: CaptureViewerOptions): CaptureViewerHandle {
  return new CaptureViewer(options);
}
