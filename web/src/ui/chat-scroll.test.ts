// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ChatView } from './chat.js';
import type { LoggedFrame } from '../lib/protocol.js';

/**
 * The chat viewport policy (owner report 2026-09-22):
 *
 * 1. REPLAY: fresh-load frames arrive as a burst. Per-frame scrolling made
 *    the log visibly flash while markdown/layout kept changing height; the
 *    fix coalesces the burst into ONE settled scroll.
 * 2. STREAMING: auto-follow only while the reader is near the bottom. A
 *    scroll away disengages (new content must NOT move the viewport) and
 *    surfaces the jump-to-latest pill; clicking it — or scrolling back —
 *    re-engages.
 *
 * happy-dom has no layout, so scroll geometry is pinned and programmatic
 * scrollTop writes are counted; a real browser echoes a scroll position
 * change with an async scroll event, which tests dispatch themselves.
 */

let seq = 0;
const turn = (state: 'start' | 'end'): LoggedFrame => ({ type: 'turn', state, seq: (seq += 1) });
const delta = (text: string): LoggedFrame => ({ type: 'delta', text, seq: (seq += 1) });

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

interface LogGeometry {
  setScrollHeight(value: number): void;
  setClientHeight(value: number): void;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  /** Number of scrollTop SETS — programmatic or simulated user drags. */
  readonly writes: number;
}

/** Pin scroll geometry on the log and make every scrollTop write visible. */
function pinLogGeometry(): LogGeometry {
  const node = document.getElementById('chat-log') as HTMLElement;
  let scrollHeight = 100;
  let clientHeight = 100;
  let scrollTop = 0;
  let writes = 0;
  Object.defineProperty(node, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(node, 'clientHeight', {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(node, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
      writes += 1;
    },
  });
  return {
    setScrollHeight: (value) => {
      scrollHeight = value;
    },
    setClientHeight: (value) => {
      clientHeight = value;
    },
    get scrollTop() {
      return scrollTop;
    },
    get scrollHeight() {
      return scrollHeight;
    },
    get writes() {
      return writes;
    },
  };
}

function log(): HTMLElement {
  return document.getElementById('chat-log') as HTMLElement;
}

function jump(): HTMLButtonElement {
  return document.querySelector('.chat-jump') as HTMLButtonElement;
}

/** The browser's async echo of a position change. */
function echoScroll(): void {
  log().dispatchEvent(new Event('scroll'));
}

/** Simulate the reader dragging the viewport to `top` (echo included). */
function userScrollTo(top: number): void {
  log().scrollTop = top;
  echoScroll();
}

/** happy-dom runs requestAnimationFrame on setImmediate; one macrotask
 * hop lets a pending settle frame fire. */
async function nextFrame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Engine state everyone needs: a live delta followed by its echo, i.e.
 * the log resting at the bottom with auto-follow engaged. */
function engagedView(): { view: ChatView; geo: LogGeometry } {
  const geo = pinLogGeometry();
  const view = new ChatView(() => true);
  view.reset();
  geo.setScrollHeight(1_200);
  view.addFrame(delta('live '), true);
  echoScroll();
  return { view, geo };
}

beforeEach(() => {
  seq = 0;
  installChatDom();
});

describe('replay settle (fresh page load)', () => {
  it('a burst of replayed frames lands as exactly one scroll to the bottom', async () => {
    const geo = pinLogGeometry();
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(turn('start'), false);
    // Layout keeps growing while the replay streams in.
    for (let i = 0; i < 8; i += 1) {
      geo.setScrollHeight(600 + i * 120);
      view.addFrame(delta(`chunk ${i} `), false);
    }
    view.addFrame(turn('end'), false);
    expect(geo.writes, 'no scrolling while the replay burst is arriving').toBe(0);

    await nextFrame();
    expect(geo.writes, 'exactly one settled scroll').toBe(1);
    expect(geo.scrollTop).toBe(600 + 7 * 120);
  });

  it('re-arms while frames keep arriving, then fires once per quiet burst', async () => {
    const geo = pinLogGeometry();
    const view = new ChatView(() => true);
    view.reset();
    view.addFrame(delta('first '), false);
    // A frame landing inside this same macrotask re-arms the settle.
    geo.setScrollHeight(500);
    view.addFrame(delta('second '), false);
    await nextFrame();
    expect(geo.writes, 'one scroll for the whole burst').toBe(1);

    geo.setScrollHeight(900);
    view.addFrame(delta('third '), false);
    await nextFrame();
    expect(geo.writes, 'one scroll for the next burst').toBe(2);
    expect(geo.scrollTop).toBe(900);
  });

  it('a reader parked in history is never yanked by replay frames', async () => {
    const { view, geo } = engagedView();
    expect(jump().hidden).toBe(true);
    // The reader scrolls up into history: sticking disengages.
    userScrollTo(300);
    expect(jump().hidden).toBe(false);
    const writes = geo.writes;

    // Reconnect: partial replay delivers the missed tail as bare deltas.
    geo.setScrollHeight(1_800);
    view.addFrame(delta('missed '), false);
    view.addFrame(turn('end'), false);
    await nextFrame();
    expect(geo.writes, 'no scroll while disengaged').toBe(writes);
    expect(geo.scrollTop).toBe(300);
    expect(jump().hidden).toBe(false);
  });
});

describe('streaming bottom-stickiness', () => {
  it('live deltas follow the bottom while engaged', () => {
    const { view, geo } = engagedView();
    expect(geo.scrollTop).toBe(1_200);
    geo.setScrollHeight(1_800);
    view.addFrame(delta('more '), true);
    expect(geo.scrollTop).toBe(1_800);
  });

  it('a user scroll away disengages: later deltas and status lines stay put', () => {
    const { view, geo } = engagedView();
    userScrollTo(300);
    expect(jump().hidden).toBe(false);
    const writes = geo.writes;

    geo.setScrollHeight(1_800);
    view.addFrame(delta('streaming '), true);
    view.addFrame({ type: 'tool', name: 'read', state: 'start', seq: (seq += 1) }, true);
    view.addFrame({ type: 'notice', text: 'heads up', seq: (seq += 1) }, true);
    view.addFrame({ type: 'error', message: 'boom', seq: (seq += 1) }, true);
    expect(geo.writes, 'disengaged viewport is never yanked').toBe(writes);
    expect(geo.scrollTop).toBe(300);
    expect(jump().hidden).toBe(false);
  });

  it('scrolling back to the bottom re-engages auto-follow', () => {
    const { view, geo } = engagedView();
    userScrollTo(300);
    expect(jump().hidden).toBe(false);

    // The reader returns to the bottom themselves.
    geo.setScrollHeight(1_200);
    userScrollTo(1_100);
    expect(jump().hidden).toBe(true);

    const writes = geo.writes;
    geo.setScrollHeight(1_500);
    view.addFrame(delta('next '), true);
    expect(geo.writes).toBe(writes + 1);
    expect(geo.scrollTop).toBe(1_500);
  });

  it('jump-to-latest scrolls down and re-engages', () => {
    const { view, geo } = engagedView();
    userScrollTo(300);
    const writes = geo.writes;

    jump().click();
    expect(geo.writes).toBe(writes + 1);
    expect(geo.scrollTop).toBe(geo.scrollHeight);
    expect(jump().hidden).toBe(true);

    geo.setScrollHeight(1_600);
    view.addFrame(delta('following again '), true);
    expect(geo.scrollTop).toBe(1_600);
  });

  it('programmatic follow motion is never mistaken for a scroll-away', () => {
    const geo = pinLogGeometry();
    const view = new ChatView(() => true);
    view.reset();
    geo.setScrollHeight(2_000);
    view.addFrame(delta('live '), true); // programmatic write to the bottom
    // A smooth programmatic scroll echoes intermediate positions on its
    // way DOWN (0 → 400 → 900 → 2000). Distance is still far from the
    // bottom at the intermediate steps; the detector must stay engaged,
    // because only upward motion counts as the reader taking over.
    for (const top of [400, 900]) {
      log().scrollTop = top;
      echoScroll();
      expect(jump().hidden, `still engaged at ${top}`).toBe(true);
    }
    log().scrollTop = 2_000;
    echoScroll();
    expect(jump().hidden).toBe(true);
  });
});
