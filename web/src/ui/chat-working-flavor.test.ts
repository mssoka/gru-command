// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextFrame } from '../lib/protocol.js';
import { WORKING_FLAVOR_PHRASES, WorkingFlavorDeck } from '../lib/working-flavor.js';
import { ChatView } from './chat.js';

/**
 * Working flavor: while the authoritative connected busy state persists the
 * status chip shows an approved phrase immediately, rotates every 4 s from
 * exactly ONE timer, never resamples on repeated renders, stops the moment
 * busy ends, and keeps the live region stable (the decorative phrase is
 * aria-hidden; the factual label is what assistive tech gets).
 *
 * Determinism: a seeded RNG is injected into the view and mirrored by a
 * reference deck; the clock is vitest's fake clock — no sleeps.
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
  contextStatus.setAttribute('role', 'status');
  contextStatus.setAttribute('aria-live', 'polite');
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
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.setAttribute('aria-atomic', 'true');
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
  fileInput.multiple = true;
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
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
}

/** Deterministic 32-bit PRNG (mulberry32) — mirrors the lib test's seed. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function context(overrides: Partial<ContextFrame> = {}): ContextFrame {
  return {
    type: 'context',
    epoch: 1,
    replay_floor_seq: 0,
    state: 'idle',
    usage: null,
    compact_supported: true,
    session_active: true,
    writer: true,
    ...overrides,
  };
}

function status(): HTMLElement {
  return document.getElementById('chat-context-status')!;
}

function label(): HTMLElement {
  return document.getElementById('chat-context-status-label')!;
}

function flavor(): HTMLElement {
  return document.getElementById('chat-context-status-flavor')!;
}

function showBusy(view: ChatView): void {
  view.setControlsConnected(true);
  view.setContext(context({ state: 'busy' }));
}

/** The stylesheet's chat-context declarations are what keep the slot one
 * line and shrinkable; happy-dom cannot lay out, so this pins the rules. */
function readComponentsCss(): string {
  for (const base of [process.cwd(), resolve(process.cwd(), 'web')]) {
    try {
      return readFileSync(resolve(base, 'src/styles/components.css'), 'utf8');
    } catch {
      /* try the next candidate root */
    }
  }
  throw new Error(`components.css not found from ${process.cwd()}`);
}

const COMPONENTS_CSS = readComponentsCss();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ruleBody(selector: string): string {
  const selectorPattern = selector
    .split(',')
    .map((part) => escapeRegExp(part.trim()))
    .join(',\\s*');
  const match = new RegExp(`${selectorPattern}\\s*\\{([\\s\\S]*?)\\}`).exec(COMPONENTS_CSS);
  if (match === null) throw new Error(`no "${selector}" rule in components.css`);
  return match[1]!.replace(/\s+/g, ' ').trim();
}

beforeEach(() => installChatDom());
afterEach(() => {
  vi.useRealTimers();
});

describe('working flavor rotation lifecycle', () => {
  it('shows a phrase immediately and rotates at the 3999/4000/8000 ms boundaries', () => {
    vi.useFakeTimers();
    const view = new ChatView(() => true, { random: seededRandom(11) });
    const mirror = new WorkingFlavorDeck(seededRandom(11));
    showBusy(view);

    const first = `${mirror.next()}…`;
    expect(WORKING_FLAVOR_PHRASES).toContain(first.slice(0, -1));
    expect(flavor().hidden).toBe(false);
    expect(flavor().textContent).toBe(first);
    expect(label().textContent).toBe('Gru is working…');
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(3999);
    expect(flavor().textContent).toBe(first);

    vi.advanceTimersByTime(1);
    const second = `${mirror.next()}…`;
    expect(flavor().textContent).toBe(second);
    expect(second).not.toBe(first);

    vi.advanceTimersByTime(4000);
    expect(flavor().textContent).toBe(`${mirror.next()}…`);
  });

  it('does not restart or resample on repeated busy snapshots, tools, or deltas', () => {
    vi.useFakeTimers();
    const view = new ChatView(() => true, { random: seededRandom(22) });
    showBusy(view);
    const first = flavor().textContent;
    vi.advanceTimersByTime(2000);

    view.setContext(context({ state: 'busy' }));
    view.setControlsConnected(true);
    view.addFrame({ type: 'tool', name: 'mock-echo', state: 'start', seq: 1 }, true);
    view.addFrame({ type: 'delta', text: 'still working', seq: 2 }, true);
    view.addFrame({ type: 'tool', name: 'mock-echo', state: 'end', seq: 3 }, true);

    expect(vi.getTimerCount()).toBe(1);
    expect(flavor().textContent).toBe(first);
    vi.advanceTimersByTime(1999);
    expect(flavor().textContent).toBe(first);
    vi.advanceTimersByTime(1);
    expect(flavor().textContent).not.toBe(first);
  });

  it('stops immediately on every non-busy state and no timer advance can overwrite it', () => {
    vi.useFakeTimers();
    const view = new ChatView(() => true, { random: seededRandom(33) });
    showBusy(view);
    vi.advanceTimersByTime(1000);

    view.setContext(context({ state: 'idle', usage: null }));
    expect(label().textContent).toBe('Context unavailable');
    expect(flavor().hidden).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(label().textContent).toBe('Context unavailable');
    expect(flavor().textContent).toBe('');

    showBusy(view);
    expect(vi.getTimerCount()).toBe(1);
    view.setContext(context({ state: 'compacting' }));
    expect(label().textContent).toBe('Compacting context…');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(label().textContent).toBe('Compacting context…');

    showBusy(view);
    view.setContext(context({ state: 'resetting' }));
    expect(label().textContent).toBe('Starting new chat…');
    expect(vi.getTimerCount()).toBe(0);

    showBusy(view);
    view.setControlsConnected(false);
    expect(label().textContent).toBe('Context unavailable');
    expect(vi.getTimerCount()).toBe(0);

    // Null context (a fresh view that reports connected before a snapshot).
    const fresh = new ChatView(() => true, { random: seededRandom(44) });
    fresh.setControlsConnected(true);
    expect(label().textContent).toBe('Context unavailable');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps ONE timer across a log reset and continues at the original deadline', () => {
    vi.useFakeTimers();
    const view = new ChatView(() => true, { random: seededRandom(55) });
    const mirror = new WorkingFlavorDeck(seededRandom(55));
    showBusy(view);
    const first = `${mirror.next()}…`;
    vi.advanceTimersByTime(3000);

    view.reset(); // full replay / epoch boundary: log-only rebuild
    expect(vi.getTimerCount()).toBe(1);
    expect(flavor().textContent).toBe(first);
    vi.advanceTimersByTime(999);
    expect(flavor().textContent).toBe(first);
    vi.advanceTimersByTime(1);
    expect(flavor().textContent).toBe(`${mirror.next()}…`);
  });

  it('reconnect/re-entry creates exactly one timer and continues the same bag', () => {
    vi.useFakeTimers();
    const view = new ChatView(() => true, { random: seededRandom(66) });
    const mirror = new WorkingFlavorDeck(seededRandom(66));
    showBusy(view);
    const first = `${mirror.next()}…`;
    vi.advanceTimersByTime(4000);
    const second = `${mirror.next()}…`;
    expect(flavor().textContent).toBe(second);

    view.setControlsConnected(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(20_000);
    expect(label().textContent).toBe('Context unavailable');

    // Re-entry while the authoritative snapshot is still busy: immediate
    // next phrase (bag preserved), exactly one timer.
    view.setControlsConnected(true);
    const third = `${mirror.next()}…`;
    expect(vi.getTimerCount()).toBe(1);
    expect(flavor().textContent).toBe(third);
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
    vi.advanceTimersByTime(4000);
    expect(flavor().textContent).toBe(`${mirror.next()}…`);
  });
});

describe('working flavor a11y and controls', () => {
  it('keeps the live region stable while the visible phrase rotates', () => {
    vi.useFakeTimers();
    const view = new ChatView(() => true, { random: seededRandom(77) });
    showBusy(view);
    const announcement = document.getElementById('chat-context-announcement')!;
    view.showControlResult({
      type: 'control_result',
      action: 'compact',
      request_id: 'compact-ok',
      ok: true,
      epoch: 1,
    });
    expect(announcement.textContent).toBe('Context compacted successfully');

    expect(status().getAttribute('role')).toBe('status');
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(status().getAttribute('aria-label')).toBe('Gru is working; context controls are busy');
    expect(flavor().getAttribute('aria-hidden')).toBe('true');

    const stableLabel = label().textContent;
    const firstPhrase = flavor().textContent;
    vi.advanceTimersByTime(8000);
    expect(flavor().textContent).not.toBe(firstPhrase); // it really rotated
    expect(label().textContent).toBe(stableLabel); // factual text never churns
    expect(announcement.textContent).toBe('Context compacted successfully');
  });

  it('keeps the factual label on screen while compacting or starting a new chat', () => {
    // Only the rotating-phrase state may visually hide the label. Compacting
    // and resetting have no phrase, so hiding the label there left a bare
    // pulsing dot with no status text (owner report 2026-10-07).
    const view = new ChatView(() => true, { random: seededRandom(99) });
    showBusy(view);
    expect(status().classList.contains('chat-context__status--busy')).toBe(true);
    expect(status().classList.contains('chat-context__status--working')).toBe(true);

    for (const [state, text] of [
      ['compacting', 'Compacting context…'],
      ['resetting', 'Starting new chat…'],
    ] as const) {
      view.setContext(context({ state }));
      expect(status().classList.contains('chat-context__status--busy')).toBe(true);
      expect(status().classList.contains('chat-context__status--working')).toBe(false);
      expect(label().textContent).toBe(text);
      expect(flavor().hidden).toBe(true);
    }
  });

  it('preserves control enablement and restores the factual chip on idle', () => {
    vi.useFakeTimers();
    const view = new ChatView(() => true, { random: seededRandom(88) });
    const compact = document.getElementById('chat-compact') as HTMLButtonElement;
    const fresh = document.getElementById('chat-new') as HTMLButtonElement;

    showBusy(view);
    expect([compact.disabled, fresh.disabled]).toEqual([true, true]);
    expect(status().hasAttribute('aria-busy')).toBe(true);

    view.setContext(context({ state: 'idle', usage: null }));
    expect([compact.disabled, fresh.disabled]).toEqual([false, false]);
    expect(status().hasAttribute('aria-busy')).toBe(false);
    expect(label().textContent).toBe('Context unavailable');
    expect(flavor().hidden).toBe(true);
  });
});

describe('working flavor stylesheet contract', () => {
  it('keeps the chip single-line and shrinkable inside chat-context selectors', () => {
    const chip = ruleBody('.chat-context__status');
    expect(chip).toMatch(/min-width:\s*0/);
    expect(chip).toMatch(/overflow:\s*hidden/);

    const spans = ruleBody('.chat-context__status-label, .chat-context__status-flavor');
    expect(spans).toMatch(/white-space:\s*nowrap/);
    expect(spans).toMatch(/overflow:\s*hidden/);
    expect(spans).toMatch(/text-overflow:\s*ellipsis/);
    expect(spans).toMatch(/min-width:\s*0/);

    const workingLabel = ruleBody('.chat-context__status--working .chat-context__status-label');
    expect(workingLabel).toMatch(/position:\s*absolute/);
    expect(workingLabel).toMatch(/clip:\s*rect\(0, 0, 0, 0\)/);
    // The broad busy class also covers compacting/resetting, whose label is
    // the only visible status text — it must never hide the label.
    expect(COMPONENTS_CSS).not.toMatch(/\.chat-context__status--busy\s+\.chat-context__status-label/);
  });

  it('never wraps the status strip on console/tablet widths', () => {
    // The rotating phrase must stay on ONE line: with the base wrap, the
    // longest approved phrases pushed the controls to a second line and
    // grew the strip (the geometry e2e sweep found 21 phrases doing it).
    // Console/tablet widths pin the single line AND keep the controls
    // non-shrinkable, so only the status chip absorbs a long phrase. The
    // phone sheet keeps the wrap so the status takes its own row.
    expect(COMPONENTS_CSS).toMatch(
      /@media \(min-width: 900px\)\s*\{\s*\.chat-context\s*\{[^}]*flex-wrap:\s*nowrap[\s\S]*?\.chat-context__button\s*\{[^}]*flex:\s*none/,
    );
  });

  it('reserves one flexible chip slot for every rotating phrase', () => {
    // The busy chip must own the strip's flexible slot: with an intrinsic
    // flex-basis a long phrase makes the line overflow and the shrink
    // cascades into the buttons (they narrow and wrap their labels), so
    // their boxes would depend on the phrase. Basis 0 + grow 1 keeps the
    // controls phrase-independent and ellipsizes the phrase in the chip.
    expect(COMPONENTS_CSS).toMatch(/\.chat-context__status--busy\s*\{[^}]*flex:\s*1 1 0/);
  });
});
