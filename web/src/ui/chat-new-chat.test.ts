// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView } from './chat.js';
import type { ContextFrame, ControlAction } from '../lib/protocol.js';

/**
 * New chat asks first — through the themed Gru modal (center screen, at
 * the gesture), never the browser's native confirm, which parks its
 * buttons at the top of the viewport. Cancel keeps the view; confirm
 * starts the reset (the control request fires, the status flips to
 * "Starting new chat…").
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
  const contextStatusLabel = document.createElement('span');
  contextStatusLabel.id = 'chat-context-status-label';
  contextStatusLabel.textContent = 'Context unavailable';
  const contextFlavor = document.createElement('span');
  contextFlavor.id = 'chat-context-status-flavor';
  contextFlavor.setAttribute('aria-hidden', 'true');
  contextFlavor.hidden = true;
  contextStatus.append(contextStatusLabel, contextFlavor);
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
  const fab = document.createElement('button');
  fab.id = 'gru-fab';
  const badge = document.createElement('span');
  badge.id = 'chat-badge';
  fab.append(badge);
  const scrim = document.createElement('div');
  scrim.id = 'chat-scrim';
  scrim.hidden = true;
  const sheet = document.createElement('div');
  sheet.id = 'chat-sheet';
  const grip = document.createElement('div');
  grip.id = 'chat-sheet-grip';
  const sheetMount = document.createElement('div');
  sheetMount.id = 'chat-sheet-mount';
  sheet.append(grip, sheetMount);
  document.body.append(mainMount, view, fab, scrim, sheet);
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (_query: string) => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

const IDLE_CONTEXT: ContextFrame = {
  type: 'context',
  epoch: 1,
  replay_floor_seq: 0,
  state: 'idle',
  usage: null,
  compact_supported: true,
  session_active: true,
  writer: true,
};

function newChatButton(): HTMLButtonElement {
  return document.getElementById('chat-new') as HTMLButtonElement;
}

beforeEach(() => {
  installChatDom();
});

describe('new chat confirmation', () => {
  it('opens the themed Gru modal instead of the browser confirm', () => {
    const view = new ChatView(() => true);
    view.setControlsConnected(true);
    view.setContext(IDLE_CONTEXT);
    expect(newChatButton().disabled).toBe(false);

    newChatButton().click();
    const card = document.querySelector<HTMLElement>('.gru-modal__card');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('role')).toBe('dialog');
    expect(card!.querySelector('.gru-modal__title')?.textContent).toBe('New chat, boss?');
    expect(card!.querySelector('.gru-modal__confirm')?.textContent).toBe('Fresh start');
    expect(card!.querySelector('.gru-modal__cancel')?.textContent).toBe('Keep plotting');
    // The page behind the dialog is locked: no scroll, no stray gesture.
    expect(document.documentElement.classList.contains('gru-modal-open')).toBe(true);
  });

  it('cancel keeps the view: no control request, dialog dismissed', async () => {
    const request = vi.fn((): boolean => true);
    const view = new ChatView(() => true);
    view.bindControls(request);
    view.setControlsConnected(true);
    view.setContext(IDLE_CONTEXT);

    newChatButton().click();
    (document.querySelector('.gru-modal__cancel') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector('.gru-modal')).toBeNull();
    expect(
      (document.getElementById('chat-context-status-label') as HTMLElement).textContent,
    ).not.toBe('Starting new chat…');
  });

  it('confirm starts the reset: the new_chat control fires and the status flips', async () => {
    const requests: ControlAction[] = [];
    const view = new ChatView(() => true);
    view.bindControls((action) => {
      requests.push(action);
      return true;
    });
    view.setControlsConnected(true);
    view.setContext(IDLE_CONTEXT);

    newChatButton().click();
    (document.querySelector('.gru-modal__confirm') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(requests).toEqual(['new_chat']);
    expect(document.querySelector('.gru-modal')).toBeNull();
    expect(
      (document.getElementById('chat-context-status-label') as HTMLElement).textContent,
    ).toBe('Starting new chat…');
  });

  it('confirm after the context went stale surfaces a note instead of silently no-oppping', async () => {
    const request = vi.fn((): boolean => true);
    const view = new ChatView(() => true);
    view.bindControls(request);
    view.setControlsConnected(true);
    view.setContext(IDLE_CONTEXT);

    newChatButton().click();
    // The socket drops while the boss is deciding.
    view.setControlsConnected(false);
    (document.querySelector('.gru-modal__confirm') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).not.toHaveBeenCalled();
    expect(document.getElementById('chat-log')?.textContent).toContain(
      'New chat is no longer available — the context changed while you decided.',
    );
    expect(
      (document.getElementById('chat-context-status-label') as HTMLElement).textContent,
    ).not.toBe('Starting new chat…');
  });
});
