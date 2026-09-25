// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatView } from './chat.js';
import type { LoggedFrame } from '../lib/protocol.js';

/**
 * Clean-chat clause (owner ruling 2026-09-23): consecutive service-context
 * frames (tool lines + product notices) render as ONE collapsed band —
 * "gear icon N service events — expand" — while conversation frames (user
 * messages, reply deltas, errors) stay visible and close the run.
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
const notice = (text: string): LoggedFrame => ({ type: 'notice', text, seq: (seq += 1) });
const error = (message: string): LoggedFrame => ({ type: 'error', message, seq: (seq += 1) });

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
  const scrim = document.createElement('button');
  scrim.id = 'chat-scrim';
  const fab = document.createElement('button');
  fab.id = 'gru-fab';
  const sheet = document.createElement('div');
  sheet.id = 'chat-sheet';
  const grip = document.createElement('div');
  grip.id = 'chat-sheet-grip';
  const sheetMount = document.createElement('div');
  sheetMount.id = 'chat-sheet-mount';
  sheet.append(grip, sheetMount);
  document.body.append(mainMount, view, bubble, scrim, fab, sheet);
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

beforeEach(() => {
  seq = 0;
  installChatDom();
});

describe('service band — consecutive service frames collapse', () => {
  it('groups a run of tool lines + notices into one collapsed band', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(turn('start'), true);
    view.addFrame(tool('start', 'read_file'), true);
    view.addFrame(tool('end', 'read_file'), true);
    view.addFrame(notice('wake turn opened'), true);
    view.addFrame(turn('end'), true);

    const bands = log().querySelectorAll('.service-band');
    expect(bands).toHaveLength(1);
    const head = bands[0]?.querySelector('.service-band__head');
    expect(head?.textContent).toContain('2 service events');
    expect(head?.textContent).toContain('expand');
    const detail = bands[0]?.querySelector<HTMLElement>('.service-band__detail');
    expect(detail?.hidden).toBe(true);
    // All three lines live inside the band, not directly in the log.
    expect(log().querySelectorAll(':scope > .tool-line')).toHaveLength(0);
    expect(bands[0]?.querySelectorAll('.tool-line')).toHaveLength(1);
    expect(bands[0]?.querySelectorAll('.notice-line')).toHaveLength(1);
  });

  it('expands and collapses on the head click (one tap to the machinery)', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(tool('start', 'grep'), true);
    const head = log().querySelector<HTMLButtonElement>('.service-band__head');
    const detail = log().querySelector<HTMLElement>('.service-band__detail');
    expect(detail?.hidden).toBe(true);
    expect(head?.getAttribute('aria-expanded')).toBe('false');

    head?.click();
    expect(detail?.hidden).toBe(false);
    expect(head?.getAttribute('aria-expanded')).toBe('true');
    expect(head?.textContent).toContain('collapse');

    head?.click();
    expect(detail?.hidden).toBe(true);
    expect(head?.textContent).toContain('expand');
  });

  it('a reply delta closes the run; the next service frame starts a new band', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(tool('start', 'read_file'), true);
    view.addFrame(tool('end', 'read_file'), true);
    view.addFrame(turn('start'), true);
    view.addFrame(delta('On it, boss.'), true);
    view.addFrame(turn('end'), true);
    view.addFrame(tool('start', 'write_file'), true);
    view.addFrame(tool('end', 'write_file'), true);

    const bands = log().querySelectorAll('.service-band');
    expect(bands).toHaveLength(2);
    expect(bands[0]?.querySelector('.service-band__head')?.textContent).toContain('1 service event —');
    expect(bands[1]?.querySelector('.service-band__head')?.textContent).toContain('1 service event —');
    // The reply stays visible as a conversation bubble between the bands.
    const order = [...log().children].map((node) => node.className);
    expect(order).toEqual([
      expect.stringContaining('service-band'),
      expect.stringContaining('msg msg--gru'),
      expect.stringContaining('service-band'),
    ]);
  });

  it('errors stay visible and close the run (fail loud, never banded away)', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(tool('start', 'read_file'), true);
    view.addFrame(error('message delivery failed'), true);
    view.addFrame(tool('start', 'read_file'), true);

    const bands = log().querySelectorAll('.service-band');
    expect(bands).toHaveLength(1);
    expect(log().querySelectorAll('.service-band__head')).toHaveLength(1); // no empty replaced band
    const errorLine = log().querySelector(':scope > .tool-line');
    expect(errorLine?.textContent).toContain('message delivery failed');
  });

  it('marks a running tool in the head and drops the marker when it settles', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(tool('start', 'long_task'), true);
    const head = log().querySelector<HTMLElement>('.service-band__head');
    expect(head?.textContent).toContain('· running');
    view.addFrame(tool('end', 'long_task'), true);
    expect(head?.textContent).not.toContain('· running');
  });

  it('settles the tool-owning band when a reply split it from the current band', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(tool('start', 'long_task'), true);
    const head = log().querySelector<HTMLElement>('.service-band__head');
    expect(head?.textContent).toContain('· running');
    view.addFrame(delta('Working on it.'), true);
    view.addFrame(tool('end', 'long_task'), true);
    expect(head?.textContent).not.toContain('· running');
    expect(log().querySelector('.service-band .tool-line')?.textContent).toContain('· done');
  });

  it('a notice-only run (no tools) still bands', () => {
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(notice('context compacted'), true);
    const head = log().querySelector<HTMLElement>('.service-band__head');
    expect(head?.textContent).toContain('1 service event');
    expect(log().querySelectorAll('.service-band .notice-line')).toHaveLength(1);
  });

  it('a failed new-chat control result lands in the band, not an ephemeral note', () => {
    // r2 53: a failed reset is durable service machinery. After the view
    // rollback the notice must band (survive across newer user messages),
    // never vanish as a 6s ephemeral line.
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(turn('start'), true);
    view.addFrame(delta('older conversation'), true);
    view.addFrame(turn('end'), true);
    view.showControlResult({
      type: 'control_result',
      action: 'new_chat',
      request_id: 'control-x',
      ok: false,
      epoch: 1,
      code: 'failed',
      message: 'New chat did not complete before reconnect',
    });
    const band = log().querySelector('.service-band');
    expect(band).not.toBeNull();
    expect(band?.querySelector('.notice-line')?.textContent).toContain(
      'New chat did not complete before reconnect',
    );
    expect(log().querySelectorAll('.notice-line--ephemeral')).toHaveLength(0);
  });
});
