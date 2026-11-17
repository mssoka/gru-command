// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CaptureViewerError,
  captureLabel,
  openCaptureViewer,
  type CaptureLoad,
  type CaptureViewerItem,
} from './media-viewer.js';

/**
 * The capture viewer: one ready card's captures in a single Gru dialog.
 * The owner flips with the arrows, the keyboard or the filmstrip and never
 * leaves the board; a clip keeps its own keys; a late load paints nothing.
 */

const SHA = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555';
const BEFORE: CaptureViewerItem = { id: 'm-before', kind: 'image', role: 'before', caption: 'Form at 390x844, before' };
const AFTER: CaptureViewerItem = { id: 'm-after', kind: 'image', role: 'after', caption: 'Form at 390x844, after' };
const CLIP: CaptureViewerItem = { id: 'm-clip', kind: 'video', role: 'after', caption: 'Approve flow' };

const loadAll = (id: string): Promise<CaptureLoad> => Promise.resolve({ url: `blob:${id}` });

function q<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (node === null) throw new Error(`missing ${selector}`);
  return node;
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const count = (): string | null => q('.media-viewer__count').textContent;
const currentThumb = (): number =>
  [...document.querySelectorAll('.media-viewer__thumb')].findIndex((thumb) => thumb.getAttribute('aria-current') === 'true');
const stageImage = (): HTMLImageElement | null => document.querySelector<HTMLImageElement>('.media-viewer__stage img');

afterEach(() => {
  for (const close of [...document.querySelectorAll<HTMLButtonElement>('.gru-modal__close')]) close.click();
  for (const host of [...document.querySelectorAll('.gru-modal')]) host.remove();
  document.documentElement.classList.remove('gru-modal-open');
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('capture viewer', () => {
  it('opens on the chosen capture in one Gru dialog: title, label, caption, position, filmstrip', async () => {
    openCaptureViewer({ title: 'Heist job-shots', headSha: SHA, items: [BEFORE, AFTER, CLIP], startId: AFTER.id, load: loadAll });
    const card = q('.gru-modal__card');
    expect(card.classList.contains('media-viewer-card')).toBe(true);
    expect(card.getAttribute('role')).toBe('dialog');
    expect(q('.gru-modal__title').textContent).toBe('Heist job-shots');
    expect(q('.gru-modal__glyph').textContent).toBe('📸');
    expect(q('.media-viewer__label').textContent).toBe('after');
    expect(q('.media-viewer__label').classList.contains('pp-chip--done')).toBe(true);
    expect(q('.media-viewer__caption').textContent).toBe('Form at 390x844, after');
    expect(count()).toBe('2 of 3 · aaaa1111');
    expect(document.querySelectorAll('.media-viewer__thumb')).toHaveLength(3);
    expect(currentThumb()).toBe(1);
    // Enter or Space on the focused arrow moves on.
    expect(document.activeElement).toBe(q('.media-viewer__nav--next'));
    await vi.waitFor(() => expect(stageImage()?.src).toBe('blob:m-after'));
    expect(stageImage()?.alt).toBe('Form at 390x844, after');
    // The new tab is still on offer, as a choice rather than the only way.
    const full = q<HTMLAnchorElement>('.media-viewer__full');
    expect(full.hidden).toBe(false);
    expect(full.href).toBe('blob:m-after');
    expect(full.target).toBe('_blank');
    expect(full.rel).toContain('noreferrer');
    // A still's thumb carries its picture; a clip's carries the clapper.
    await vi.waitFor(() => expect(document.querySelectorAll('.media-viewer__thumb img')).toHaveLength(2));
    expect(q('.media-viewer__thumb--video').textContent).toBe('🎬');
    expect(q('.media-viewer__thumb--video').getAttribute('aria-label')).toBe('Capture 3 of 3: clip · Approve flow');
  });

  it('flips with ← and → (the ends wrap), jumps with Home and End, and follows the arrows and the filmstrip', async () => {
    openCaptureViewer({ title: 'Heist', headSha: SHA, items: [BEFORE, AFTER, CLIP], startId: BEFORE.id, load: loadAll });
    expect(count()).toBe('1 of 3 · aaaa1111');
    expect(q('.media-viewer__label').classList.contains('pp-chip--alert')).toBe(true);

    const right = press('ArrowRight');
    expect(right.defaultPrevented).toBe(true);
    expect(count()).toBe('2 of 3 · aaaa1111');
    await vi.waitFor(() => expect(stageImage()?.src).toBe('blob:m-after'));

    press('ArrowRight');
    expect(count()).toBe('3 of 3 · aaaa1111');
    expect(q('.media-viewer__label').textContent).toBe('clip');
    expect(q('.media-viewer__label').classList.contains('pp-chip--rev')).toBe(true);
    press('ArrowRight');
    expect(count()).toBe('1 of 3 · aaaa1111');
    press('ArrowLeft');
    expect(count()).toBe('3 of 3 · aaaa1111');
    press('Home');
    expect(count()).toBe('1 of 3 · aaaa1111');
    press('End');
    expect(count()).toBe('3 of 3 · aaaa1111');

    q<HTMLButtonElement>('.media-viewer__nav--previous').click();
    expect(count()).toBe('2 of 3 · aaaa1111');
    q<HTMLButtonElement>('.media-viewer__nav--next').click();
    q<HTMLButtonElement>('.media-viewer__nav--next').click();
    expect(count()).toBe('1 of 3 · aaaa1111');
    document.querySelectorAll<HTMLButtonElement>('.media-viewer__thumb')[1]!.click();
    expect(count()).toBe('2 of 3 · aaaa1111');
    expect(currentThumb()).toBe(1);
    expect(q('.media-viewer__caption').textContent).toBe('Form at 390x844, after');
  });

  it('leaves a chord to the browser, a focused clip its own keys, and every other key alone', async () => {
    openCaptureViewer({ title: 'Heist', headSha: SHA, items: [BEFORE, CLIP], startId: CLIP.id, load: loadAll });
    await vi.waitFor(() => expect(document.querySelector('.media-viewer__stage video')).not.toBeNull());
    const video = q<HTMLVideoElement>('.media-viewer__stage video');
    expect(video.controls).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.getAttribute('aria-label')).toBe('Approve flow');
    // No "full size" link for a clip: its player has its own controls.
    expect(q('.media-viewer__full').hidden).toBe(true);

    // The player seeks on the arrows while it holds focus.
    const seek = press('ArrowLeft', {}, video);
    expect(seek.defaultPrevented).toBe(false);
    expect(count()).toBe('2 of 2 · aaaa1111');
    // Cmd/Ctrl/Alt/Shift + arrow is the browser's (history, selection).
    const chords: readonly KeyboardEventInit[] = [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }];
    for (const chord of chords) {
      expect(press('ArrowLeft', chord).defaultPrevented).toBe(false);
    }
    expect(press('a').defaultPrevented).toBe(false);
    expect(count()).toBe('2 of 2 · aaaa1111');

    // Flipping away stops the clip: it never plays on unseen.
    const pause = vi.spyOn(video, 'pause');
    press('ArrowLeft');
    expect(count()).toBe('1 of 2 · aaaa1111');
    expect(pause).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.media-viewer__stage video')).toBeNull();
  });

  it('names the reason a capture cannot be shown, and a load that lands after a flip paints nothing', async () => {
    let settleBefore: (loaded: CaptureLoad) => void = () => {};
    const slow = new Promise<CaptureLoad>((resolve) => { settleBefore = resolve; });
    const load = vi.fn((id: string): Promise<CaptureLoad> =>
      id === BEFORE.id ? slow : Promise.resolve({ error: 'media_altered' }));
    openCaptureViewer({ title: 'Heist', headSha: SHA, items: [BEFORE, AFTER], startId: BEFORE.id, load });
    expect(q('.media-viewer__status').textContent).toBe('loading…');

    press('ArrowRight');
    await vi.waitFor(() => expect(q('.media-viewer__status').textContent).toBe('preview unavailable: media_altered'));
    expect(q('.media-viewer__full').hidden).toBe(true);

    // The first capture's bytes arrive only now: the owner is on the second.
    settleBefore({ url: 'blob:late' });
    await slow;
    await Promise.resolve();
    expect(stageImage()).toBeNull();
    expect(q('.media-viewer__status').textContent).toBe('preview unavailable: media_altered');
    expect(count()).toBe('2 of 2 · aaaa1111');
  });

  it('shows a lone capture with no arrows and no filmstrip', async () => {
    openCaptureViewer({ title: 'Heist', headSha: SHA, items: [AFTER], startId: AFTER.id, load: loadAll });
    expect(document.querySelector('.media-viewer__nav')).toBeNull();
    expect(document.querySelector('.media-viewer__strip')).toBeNull();
    expect(q('.media-viewer__main').classList.contains('media-viewer__main--single')).toBe(true);
    expect(count()).toBe('1 capture · aaaa1111');
    await vi.waitFor(() => expect(stageImage()?.src).toBe('blob:m-after'));
    press('ArrowRight');
    expect(count()).toBe('1 capture · aaaa1111');
    expect(stageImage()?.src).toBe('blob:m-after');
  });

  it('zooms a still that is shown scaled down to its actual size and back, and offers nothing for one that fits', async () => {
    openCaptureViewer({ title: 'Heist', headSha: SHA, items: [BEFORE, AFTER], startId: BEFORE.id, load: loadAll });
    await vi.waitFor(() => expect(stageImage()).not.toBeNull());
    const stage = q('.media-viewer__stage');
    const zoom = q<HTMLButtonElement>('.media-viewer__zoom');
    // Not loaded yet, so nothing to zoom into.
    expect(zoom.disabled).toBe(true);
    expect(zoom.title).toBe('');

    // 1280 px of picture in a narrower stage: it is drawn scaled down.
    const image = stageImage()!;
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1280 });
    Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 800 });
    image.dispatchEvent(new Event('load'));
    expect(zoom.disabled).toBe(false);
    expect(zoom.title).toBe('Show at actual size');
    expect(zoom.getAttribute('aria-pressed')).toBe('false');

    zoom.click();
    expect(stage.classList.contains('media-viewer__stage--actual')).toBe(true);
    expect(zoom.getAttribute('aria-pressed')).toBe('true');
    expect(zoom.title).toBe('Fit to the viewer');
    zoom.click();
    expect(stage.classList.contains('media-viewer__stage--actual')).toBe(false);
    expect(zoom.getAttribute('aria-pressed')).toBe('false');

    // The next capture starts fitted, whatever the last one was left at.
    zoom.click();
    press('ArrowRight');
    expect(stage.classList.contains('media-viewer__stage--actual')).toBe(false);
  });

  it('carries a notice above the stage, and closes once: Escape, focus back on the opener, clip stopped', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const viewer = openCaptureViewer({ title: 'Heist', headSha: SHA, items: [BEFORE, CLIP], startId: CLIP.id, load: loadAll, onClose });
    await vi.waitFor(() => expect(document.querySelector('.media-viewer__stage video')).not.toBeNull());
    const pause = vi.spyOn(q<HTMLVideoElement>('.media-viewer__stage video'), 'pause');

    const notice = q('.media-viewer__notice');
    expect(notice.hidden).toBe(true);
    viewer.setNotice('the card changed');
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe('the card changed');
    expect(notice.getAttribute('role')).toBe('status');
    viewer.setNotice(null);
    expect(notice.hidden).toBe(true);
    expect(notice.textContent).toBe('');

    press('Escape');
    expect(document.querySelector('.gru-modal')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    viewer.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses a start capture that is not in the set, and mounts nothing', () => {
    expect(() => openCaptureViewer({ title: 'Heist', headSha: SHA, items: [BEFORE], startId: 'm-missing', load: loadAll }))
      .toThrow(CaptureViewerError);
    expect(() => openCaptureViewer({ title: 'Heist', headSha: SHA, items: [BEFORE], startId: 'm-missing', load: loadAll }))
      .toThrow('capture m-missing is not one of the 1 captures handed to the viewer');
    expect(document.querySelector('.gru-modal')).toBeNull();
  });

  it('labels a capture the same way on the card and in the viewer', () => {
    expect(captureLabel({ kind: 'image', role: 'before' })).toBe('before');
    expect(captureLabel({ kind: 'video', role: 'before' })).toBe('before');
    expect(captureLabel({ kind: 'image', role: 'after' })).toBe('after');
    expect(captureLabel({ kind: 'video', role: 'after' })).toBe('clip');
  });
});
