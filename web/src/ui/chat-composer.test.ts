// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from './chat.js';

/**
 * The multi-line composer: Enter sends, Shift+Enter inserts a newline,
 * IME composition never sends, and the textarea auto-grows/collapses.
 */

function installChatDom(): void {
  document.body.replaceChildren();
  const mainMount = document.createElement('div');
  mainMount.id = 'chat-main-mount';
  const log = document.createElement('div');
  log.id = 'chat-log';
  const context = document.createElement('div');
  context.id = 'chat-context-controls';
  const contextStatus = document.createElement('span');
  contextStatus.id = 'chat-context-status';
  const announcement = document.createElement('span');
  announcement.id = 'chat-context-announcement';
  const compact = document.createElement('button');
  compact.id = 'chat-compact';
  compact.type = 'button';
  compact.disabled = true;
  const newChat = document.createElement('button');
  newChat.id = 'chat-new';
  newChat.type = 'button';
  newChat.disabled = true;
  context.append(contextStatus, announcement, compact, newChat);
  const form = document.createElement('form');
  form.id = 'chat-form';
  const chips = document.createElement('div');
  chips.id = 'chat-chips';
  chips.hidden = true;
  const composeRow = document.createElement('div');
  const attach = document.createElement('button');
  attach.id = 'chat-attach';
  attach.type = 'button';
  const input = document.createElement('textarea');
  input.id = 'chat-input';
  const send = document.createElement('button');
  send.id = 'chat-send';
  send.type = 'submit';
  const fileInput = document.createElement('input');
  fileInput.id = 'chat-attach-file';
  fileInput.type = 'file';
  composeRow.append(attach, input, send);
  form.append(chips, composeRow, fileInput);

  const picker = document.createElement('div');
  picker.id = 'attach-picker';
  picker.hidden = true;
  const pickerList = document.createElement('div');
  pickerList.id = 'attach-picker-list';
  const pickerPath = document.createElement('div');
  pickerPath.id = 'attach-picker-path';
  const pickerError = document.createElement('div');
  pickerError.id = 'attach-picker-error';
  const pickerUp = document.createElement('button');
  pickerUp.id = 'attach-picker-up';
  const pickerClose = document.createElement('button');
  pickerClose.id = 'attach-picker-close';
  const pickerDevice = document.createElement('button');
  pickerDevice.id = 'attach-picker-device';
  picker.append(pickerUp, pickerPath, pickerDevice, pickerClose, pickerError, pickerList);

  const view = document.createElement('section');
  view.id = 'chat-view';
  view.append(log, context, form, picker);
  const bubble = document.createElement('button');
  bubble.id = 'chat-bubble';
  const badge = document.createElement('span');
  badge.id = 'chat-badge';
  bubble.append(badge);
  const sheet = document.createElement('div');
  sheet.id = 'chat-sheet';
  const grip = document.createElement('div');
  grip.id = 'chat-sheet-grip';
  const sheetMount = document.createElement('div');
  sheetMount.id = 'chat-sheet-mount';
  sheet.append(grip, sheetMount);
  document.body.append(mainMount, view, bubble, sheet);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
}

function input(): HTMLTextAreaElement {
  return document.getElementById('chat-input') as HTMLTextAreaElement;
}

/** Pin layout numbers happy-dom cannot compute, so the autosize math
 * (collapse → measure → border compensation) is exercised exactly. */
function pinGeometry(scrollHeight: number, borders: number): void {
  const node = input();
  Object.defineProperty(node, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(node, 'offsetHeight', {
    configurable: true,
    get: () => node.clientHeight + borders,
  });
  Object.defineProperty(node, 'clientHeight', { configurable: true, value: 40 });
}

/** Count submit dispatches on the form (requestSubmit's oracle). The
 * view's own listener already preventDefaults — ours just counts. */
function countedSubmit(form: HTMLFormElement): () => number {
  let count = 0;
  form.addEventListener('submit', () => {
    count += 1;
  });
  return () => count;
}

beforeEach(() => installChatDom());

describe('multi-line composer', () => {
  it('Enter sends; Shift+Enter and IME composition never send', () => {
    const view = new ChatView(() => true);
    view.bindAttach(null);
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const submits = countedSubmit(form);

    input().value = 'one line only';
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(submits()).toBe(1);

    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(submits()).toBe(1);

    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(submits()).toBe(1);
  });

  it('Enter with empty composer does not submit (view-level guard holds)', () => {
    const onSend = vi.fn(() => true);
    new ChatView(onSend);
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('modifier combos and key auto-repeat never send', () => {
    const view = new ChatView(() => true);
    view.bindAttach(null);
    const form = document.getElementById('chat-form') as HTMLFormElement;
    const submits = countedSubmit(form);
    input().value = 'guarded gestures';

    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(submits()).toBe(0);

    // A held Enter: the first press sends, every auto-repeat is ignored.
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    input().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(submits()).toBe(1);
  });

  it('auto-grows with content and collapses back after a successful send', () => {
    pinGeometry(40, 6);
    const view = new ChatView(() => true);
    view.bindAttach(null);
    // One row at rest: NO inline height — intrinsic rows=1 sizing rules
    // (a wrapped placeholder must never drive layout).
    expect(input().style.height).toBe('');

    pinGeometry(300, 6);
    input().value = 'steal the moon';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    expect(input().style.height).toBe('306px'); // grew with content

    pinGeometry(40, 6);
    input().value = 'steal the moon\nthen home for bananas';
    const form = document.getElementById('chat-form') as HTMLFormElement;
    let submissions = 0;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submissions += 1;
    });
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(submissions).toBe(1);
    expect(input().value).toBe(''); // cleared on success…
    expect(input().style.height).toBe(''); // …and collapsed to one row
  });

  it('keeps the typed words and height when the send is rejected', () => {
    pinGeometry(300, 6);
    const view = new ChatView(() => false);
    view.bindAttach(null);
    input().value = 'still drafting';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    const form = document.getElementById('chat-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(input().value).toBe('still drafting');
    expect(input().style.height).toBe('306px'); // no collapse mid-draft
  });
});
