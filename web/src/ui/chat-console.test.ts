// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import type { LoggedFrame } from '../lib/protocol.js';
import { ChatView } from './chat.js';

/**
 * Chat surfaces join the console (v5): unread counts only while no chat
 * is in sight — the expanded pane or an open overlay sheet is "in sight";
 * the collapsed rail and the closed overlay are not.
 */

let overlayMatches = false;

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
  const newChat = document.createElement('button');
  newChat.id = 'chat-new';
  context.append(contextStatus, announcement, compact, newChat);
  const form = document.createElement('form');
  form.id = 'chat-form';
  const chips = document.createElement('div');
  chips.id = 'chat-chips';
  const composeRow = document.createElement('div');
  const attach = document.createElement('button');
  attach.id = 'chat-attach';
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
  const fab = document.createElement('button');
  fab.id = 'gru-fab';
  const badge = document.createElement('span');
  badge.id = 'chat-badge';
  badge.textContent = '0';
  fab.append(badge);
  const scrim = document.createElement('div');
  scrim.id = 'chat-scrim';
  scrim.hidden = true;
  const rail = document.createElement('button');
  rail.id = 'chat-rail';
  const sheet = document.createElement('div');
  sheet.id = 'chat-sheet';
  const grip = document.createElement('div');
  grip.id = 'chat-sheet-grip';
  const sheetMount = document.createElement('div');
  sheetMount.id = 'chat-sheet-mount';
  sheet.append(grip, sheetMount);
  document.body.append(mainMount, view, fab, scrim, rail, sheet);

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      // Evaluated at read time: a test can flip the mode and ChatView's
      // captured MediaQueryList sees it (the stub is live, like the real one).
      get matches() {
        return query === '(max-width: 1099px)' ? overlayMatches : false;
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

const delta = (text: string): LoggedFrame => ({ type: 'delta', text, seq: 1 });

function railUnread(): string | null {
  return document.getElementById('chat-rail')?.getAttribute('data-unread') ?? null;
}

function badge(): string {
  return document.getElementById('chat-badge')?.textContent ?? '';
}

beforeEach(() => {
  overlayMatches = false;
  installChatDom();
});

describe('chat console unread (v5)', () => {
  it('does not count while the console pane is in sight', () => {
    const view = new ChatView(() => true);
    view.addFrame(delta('seen'), true);
    expect(badge()).toBe('0');
    expect(railUnread()).toBe('0');
  });

  it('pulses the collapsed rail on new messages and clears on expand', () => {
    const view = new ChatView(() => true);
    view.setPaneCollapsed(true);
    view.addFrame(delta('boss?'), true);
    expect(badge()).toBe('1');
    expect(railUnread()).toBe('1');
    expect(document.getElementById('gru-fab')?.getAttribute('data-unread')).toBe('1');

    view.setPaneCollapsed(false);
    expect(badge()).toBe('0');
    expect(railUnread()).toBe('0');
  });

  it('overlay mode counts while the sheet is closed; opening clears, closing re-arms', () => {
    overlayMatches = true;
    const view = new ChatView(() => true);
    view.addFrame(delta('behind the board'), true);
    expect(badge()).toBe('1');
    expect(railUnread()).toBe('1');

    view.openSheet();
    expect(document.getElementById('chat-sheet')?.getAttribute('data-open')).toBe('true');
    expect(document.getElementById('chat-scrim')?.hidden).toBe(false);
    expect(badge()).toBe('0');
    expect(railUnread()).toBe('0');

    view.closeSheet();
    expect(document.getElementById('chat-scrim')?.hidden).toBe(true);
    view.addFrame(delta('after close'), true);
    expect(badge()).toBe('1');
  });

  it('replayed frames never count as unread (history is not a notification)', () => {
    const view = new ChatView(() => true);
    view.setPaneCollapsed(true);
    view.addFrame(delta('old words'), false);
    expect(badge()).toBe('0');
    expect(railUnread()).toBe('0');
  });
});
