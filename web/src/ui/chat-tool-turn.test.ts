// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatView } from './chat.js';
import type { LoggedFrame } from '../lib/protocol.js';

/**
 * Tool-only turns must not leave empty Gru bubble stubs (owner report
 * 2026-09-22, screenshot-verified): the stream bubble is created lazily on
 * the FIRST text delta, so a turn that only ran tools closes with no stub.
 * The streamed-markdown semantics themselves are pinned in
 * chat-gfm-invariant.test.ts; this suite pins the bubble lifecycle shape.
 */

let seq = 0;
const turn = (state: 'start' | 'end'): LoggedFrame => ({ type: 'turn', state, seq: (seq += 1) });
const delta = (text: string): LoggedFrame => ({ type: 'delta', text, seq: (seq += 1) });
const tool = (state: 'start' | 'end', name = 'read_file'): LoggedFrame => ({
  type: 'tool',
  name,
  state,
  seq: (seq += 1),
});

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
  const contextAnnouncement = document.createElement('span');
  contextAnnouncement.id = 'chat-context-announcement';
  const compact = document.createElement('button');
  compact.id = 'chat-compact';
  const newChat = document.createElement('button');
  newChat.id = 'chat-new';
  context.append(contextStatus, contextAnnouncement, compact, newChat);
  const form = document.createElement('form');
  form.id = 'chat-form';
  const chips = document.createElement('div');
  chips.id = 'chat-chips';
  const composeRow = document.createElement('div');
  const attachButton = document.createElement('button');
  attachButton.id = 'chat-attach';
  const input = document.createElement('textarea');
  input.id = 'chat-input';
  const send = document.createElement('button');
  send.id = 'chat-send';
  const fileInput = document.createElement('input');
  fileInput.id = 'chat-attach-file';
  composeRow.append(attachButton, input, send);
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
  const bubble = document.createElement('button');
  bubble.id = 'chat-bubble';
  const badge = document.createElement('span');
  badge.id = 'chat-badge';
  badge.textContent = '0';
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
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

function log(): HTMLElement {
  return document.getElementById('chat-log') as HTMLElement;
}

function bubbles(): HTMLElement[] {
  return [...log().querySelectorAll<HTMLElement>('.msg--gru')];
}

beforeEach(() => {
  seq = 0;
  installChatDom();
});

describe('tool-only turns render no empty bubble', () => {
  it('a live turn with only tool activity leaves no .msg--gru stub', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(turn('start'), true);
    view.addFrame(tool('start'), true);
    view.addFrame(tool('end'), true);
    view.addFrame(turn('end'), true);

    expect(bubbles()).toHaveLength(0);
    const lines = log().querySelectorAll('.tool-line');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toContain('read_file');
  });

  it('the replay path renders no stub either', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(turn('start'), false);
    view.addFrame(tool('start'), false);
    view.addFrame(tool('end'), false);
    view.addFrame(turn('end'), false);
    expect(bubbles()).toHaveLength(0);
    expect(log().querySelectorAll('.tool-line')).toHaveLength(1);
  });

  it('three tool-only turns leave zero stubs between tool groups', () => {
    const view = new ChatView(() => true);
    view.reset();
    for (let i = 0; i < 3; i += 1) {
      view.addFrame(turn('start'), true);
      view.addFrame(tool('start', `tool-${i}`), true);
      view.addFrame(tool('end', `tool-${i}`), true);
      view.addFrame(turn('end'), true);
    }
    expect(bubbles()).toHaveLength(0);
    expect(log().querySelectorAll('.tool-line')).toHaveLength(3);
  });

  it('a turn whose deltas are all empty text leaves no bubble', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(turn('start'), true);
    view.addFrame(delta(''), true);
    view.addFrame(delta(''), true);
    view.addFrame(turn('end'), true);
    expect(bubbles()).toHaveLength(0);
  });
});

describe('text turns keep the streaming lifecycle', () => {
  it('a text turn renders exactly one bubble and finalizes it at turn end', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(turn('start'), true);
    view.addFrame(delta('hello '), true);
    view.addFrame(delta('boss'), true);
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]?.classList.contains('msg--streaming')).toBe(true);

    view.addFrame(turn('end'), true);
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]?.textContent).toContain('hello boss');
    expect(bubbles()[0]?.classList.contains('msg--streaming')).toBe(false);
  });

  it('bare deltas after a partial replay still open a bubble (no turn:start)', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(delta('missed '), false);
    view.addFrame(delta('tail'), false);

    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]?.textContent).toContain('missed tail');
    view.addFrame(turn('end'), false);
    expect(bubbles()[0]?.classList.contains('msg--streaming')).toBe(false);
  });

  it('the first delta of a fresh turn is never wiped by deferred open', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(turn('start'), true);
    view.addFrame(delta('kept'), true);
    expect(bubbles()[0]?.textContent).toContain('kept');
  });

  it('a drop on a tool-only turn does not wedge the next stream', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(turn('start'), true);
    view.addFrame(tool('start'), true);
    view.markStreamIncomplete(); // no bubble to mark — the turn just closes

    view.addFrame(tool('end'), true);
    view.addFrame(delta('late text'), false);
    view.addFrame(turn('end'), false);
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]?.textContent).toContain('late text');
  });
});
