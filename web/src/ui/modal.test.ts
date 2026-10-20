// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmModal, openModal } from './modal.js';

/**
 * The themed Gru modal: the reusable dialog surface. Confirm resolves
 * true only on the explicit confirm gesture; borrowed content is
 * returned home on close; Escape dismisses the topmost dialog only;
 * focus is trapped inside and restored to the opener.
 */

function dialogCards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.gru-modal__card')];
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
}

afterEach(() => {
  // Close surviving dialogs THROUGH their ✕ so module state (the stack
  // + the document keydown listener) unwinds exactly as in production;
  // the host strip below is only a failed-test safety net.
  for (const close of [...document.querySelectorAll<HTMLButtonElement>('.gru-modal__close')]) {
    close.click();
  }
  for (const host of [...document.querySelectorAll('.gru-modal')]) host.remove();
  document.documentElement.classList.remove('gru-modal-open');
  vi.restoreAllMocks();
});

describe('confirmModal', () => {
  it('renders a themed dialog: role, aria, title, body, and both buttons', async () => {
    const pending = confirmModal({
      title: 'New chat, boss?',
      body: 'Durable history is kept, but this active view will clear.',
      confirmLabel: 'Fresh start',
      cancelLabel: 'Keep plotting',
      glyph: '🧽',
    });
    const [card] = dialogCards();
    if (card === undefined) throw new Error('confirm dialog did not render');
    expect(card.getAttribute('role')).toBe('dialog');
    expect(card.getAttribute('aria-modal')).toBe('true');
    expect(card.querySelector('.gru-modal__title')?.textContent).toBe('New chat, boss?');
    expect(card.querySelector('.gru-modal__glyph')?.textContent).toBe('🧽');
    expect(card.querySelector('.gru-modal__text')?.textContent).toContain('Durable history');
    expect(card.querySelector('.gru-modal__confirm')?.textContent).toBe('Fresh start');
    expect(card.querySelector('.gru-modal__cancel')?.textContent).toBe('Keep plotting');
    // The confirm button opens focused: Enter proceeds, Escape backs out.
    expect(document.activeElement).toBe(card.querySelector('.gru-modal__confirm'));

    (card.querySelector('.gru-modal__cancel') as HTMLButtonElement).click();
    await expect(pending).resolves.toBe(false);
  });

  it('confirm resolves true and tears the dialog down; focus returns to the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const pending = confirmModal({
      title: 'Steal the moon?',
      body: 'It is right there.',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
    });
    const confirm = document.querySelector<HTMLButtonElement>('.gru-modal__confirm')!;
    confirm.click();

    await expect(pending).resolves.toBe(true);
    expect(document.querySelector('.gru-modal')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.documentElement.classList.contains('gru-modal-open')).toBe(false);
  });

  it('cancel and Escape resolve false; a click ON the card stays open', async () => {
    const byCancel = confirmModal({ title: 'a', body: 'b', confirmLabel: 'y', cancelLabel: 'n' });
    (document.querySelector('.gru-modal__cancel') as HTMLButtonElement).click();
    await expect(byCancel).resolves.toBe(false);

    const byEscape = confirmModal({ title: 'a', body: 'b', confirmLabel: 'y', cancelLabel: 'n' });
    pressEscape();
    await expect(byEscape).resolves.toBe(false);

    // A click ON the card (not through it to the scrim) stays open.
    const staying = confirmModal({ title: 'a', body: 'b', confirmLabel: 'y', cancelLabel: 'n' });
    (document.querySelector('.gru-modal__text') as HTMLElement).click();
    (document.querySelector('.gru-modal__cancel') as HTMLButtonElement).click();
    await expect(staying).resolves.toBe(false);
  });

  it('the ✕ close button resolves false on a confirm dialog', async () => {
    const pending = confirmModal({ title: 'a', body: 'b', confirmLabel: 'y', cancelLabel: 'n' });
    (document.querySelector('.gru-modal__close') as HTMLButtonElement).click();
    await expect(pending).resolves.toBe(false);
  });

  it('scrim click is ignored inside the opening gesture grace window, then dismisses', async () => {
    // A habitual double-click's second press lands on the just-mounted
    // scrim — inside the grace window it must NOT dismiss the dialog it
    // just summoned.
    const pending = confirmModal({ title: 'a', body: 'b', confirmLabel: 'y', cancelLabel: 'n' });
    (document.querySelector('.gru-modal') as HTMLElement).click();
    expect(document.querySelector('.gru-modal')).not.toBeNull();

    // Past the window, the same gesture dismisses (resolves false).
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow + 400);
    (document.querySelector('.gru-modal') as HTMLElement).click();
    await expect(pending).resolves.toBe(false);
    expect(document.querySelector('.gru-modal')).toBeNull();
  });

  it('the danger tone paints the alert fill on the confirm button', async () => {
    const pending = confirmModal({
      title: 'a',
      body: 'b',
      confirmLabel: 'y',
      cancelLabel: 'n',
      tone: 'danger',
    });
    expect(
      document.querySelector('.gru-modal__confirm')?.classList.contains('gru-modal__confirm--danger'),
    ).toBe(true);
    (document.querySelector('.gru-modal__cancel') as HTMLButtonElement).click();
    await expect(pending).resolves.toBe(false);
  });

  it('Escape is fully consumed by the dialog — nothing behind the scrim sees it', () => {
    let behindTheScrim = 0;
    const bubbleListener = (): void => {
      behindTheScrim += 1;
    };
    document.addEventListener('keydown', bubbleListener);
    const dialog = openModal({ title: 'x', content: document.createElement('div') });

    pressEscape();
    expect(behindTheScrim).toBe(0); // e.g. the attach picker stays open
    expect(document.querySelector('.gru-modal')).toBeNull();

    document.removeEventListener('keydown', bubbleListener);
    dialog.close();
  });
});

describe('openModal', () => {
  function homeWithPanel(): { readonly parent: HTMLElement; readonly panel: HTMLElement } {
    const parent = document.createElement('main');
    const sibling = document.createElement('div');
    const panel = document.createElement('section');
    panel.textContent = 'panel body';
    parent.append(sibling, panel);
    document.body.append(parent);
    return { parent, panel };
  }

  it('borrows the content into the dialog and returns it home on close', () => {
    const { parent, panel } = homeWithPanel();
    const onClose = vi.fn();
    const dialog = openModal({ title: 'Panel', content: panel, onClose });

    const card = document.querySelector<HTMLElement>('.gru-modal__card')!;
    expect(card.contains(panel)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    dialog.close();
    // Home again — same parent, same position (before the nothing that
    // followed it, i.e. still the last child).
    expect(parent.contains(panel)).toBe(true);
    expect(panel.nextSibling).toBeNull();
    expect(document.querySelector('.gru-modal')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);

    // Idempotent: a second close neither re-fires onClose nor throws.
    dialog.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes the TOPMOST dialog only', () => {
    const { panel: inner } = homeWithPanel();
    const outer = openModal({ title: 'outer', content: document.createElement('div') });
    const innerDialog = openModal({ title: 'inner', content: inner });

    pressEscape();
    expect(document.querySelectorAll('.gru-modal').length).toBe(1);
    expect(inner.parentElement).not.toBe(document.querySelector('.gru-modal__card'));

    pressEscape();
    expect(document.querySelectorAll('.gru-modal').length).toBe(0);
    expect(inner.parentElement).not.toBeNull();
    void outer;
    void innerDialog;
  });

  it('traps Tab inside the card and restores focus to the opener', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const panel = document.createElement('div');
    const first = document.createElement('button');
    const last = document.createElement('button');
    panel.append(first, last);

    const dialog = openModal({ title: 'Trap', content: panel });
    expect(document.activeElement).toBe(first);

    // Tab off the card's LAST focusable (✕ head button, first button,
    // last button) wraps to the card's first — the ✕.
    const dismiss = document.querySelector<HTMLButtonElement>('.gru-modal__close')!;
    last.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement).toBe(dismiss);

    // Shift+Tab off the card's first focusable wraps to the last.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last);

    // The card itself can hold focus (tabindex -1, a click on chrome):
    // Tab from there must still wrap INSIDE, not escape behind the scrim.
    const card = document.querySelector<HTMLElement>('.gru-modal__card')!;
    card.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement).toBe(dismiss);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last);

    dialog.close();
    expect(document.activeElement).toBe(opener);
  });

  it('focus-less content falls back to the ✕ button', () => {
    const dialog = openModal({ title: 'No controls', content: document.createElement('div') });
    expect(document.activeElement).toBe(document.querySelector('.gru-modal__close'));
    dialog.close();
  });

  it('closing never throws when the opener has already left the document', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const dialog = openModal({ title: 'x', content: document.createElement('div') });
    opener.remove();
    dialog.close();
    expect(document.querySelector('.gru-modal')).toBeNull();
  });
});
