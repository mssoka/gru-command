// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowseResult, UploadedFile } from '../lib/attach-client.js';
import { parseServerFrame, type ContextFrame } from '../lib/protocol.js';
import { ChatView, type AttachSurface } from './chat.js';

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
  const announcement = document.createElement('span');
  announcement.id = 'chat-context-announcement';
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
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
  const up = document.createElement('button');
  up.id = 'attach-picker-up';
  const close = document.createElement('button');
  close.id = 'attach-picker-close';
  const device = document.createElement('button');
  device.id = 'attach-picker-device';
  picker.append(up, pickerPath, device, close, pickerError, pickerList);

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

function result(
  path: string,
  entries: BrowseResult['entries'] = [],
  truncated = false,
): BrowseResult {
  return {
    root: '/workspace',
    path,
    parent: path === '' ? null : '',
    entries,
    truncated,
  } as BrowseResult;
}

function surface(overrides: Partial<AttachSurface> = {}): AttachSurface {
  return {
    browse: async () => result(''),
    upload: async (file) => ({ path: `/uploads/${file.name}`, name: file.name, bytes: file.size }),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => installChatDom());

describe('chat context control rendering', () => {
  it('disables controls from authoritative reader, busy, inactive, unsupported, and disconnected state', () => {
    const view = new ChatView(() => true);
    view.bindControls(() => true);
    view.setControlsConnected(true);
    const set = (overrides: Partial<ContextFrame> = {}) =>
      view.setContext({
        type: 'context',
        epoch: 1,
        replay_floor_seq: 0,
        state: 'idle',
        usage: null,
        compact_supported: true,
        session_active: true,
        writer: true,
        ...overrides,
      });
    const compact = document.getElementById('chat-compact') as HTMLButtonElement;
    const fresh = document.getElementById('chat-new') as HTMLButtonElement;

    set({ writer: false });
    expect([compact.disabled, fresh.disabled]).toEqual([true, true]);
    set({ state: 'busy' });
    expect([compact.disabled, fresh.disabled]).toEqual([true, true]);
    set({ session_active: false });
    expect([compact.disabled, fresh.disabled]).toEqual([true, false]);
    set({ compact_supported: false });
    expect([compact.disabled, fresh.disabled]).toEqual([true, false]);
    set();
    view.setControlsConnected(false);
    expect([compact.disabled, fresh.disabled]).toEqual([true, true]);
  });

  it('renders authoritative usage and announces optimistic New chat progress accessibly', () => {
    const view = new ChatView(() => true);
    const request = vi.fn(() => true);
    view.bindControls(request);
    view.setControlsConnected(true);
    const wireSnapshot = parseServerFrame(JSON.stringify({
      type: 'context',
      epoch: 3,
      replay_floor_seq: 41,
      state: 'idle',
      usage: { tokens: 370, context_window: 1_000, percent: 37 },
      compact_supported: true,
      session_active: true,
      writer: true,
    }));
    expect(wireSnapshot?.type).toBe('context');
    if (wireSnapshot?.type !== 'context') throw new Error('provider context did not parse');
    view.setContext(wireSnapshot);
    const status = document.getElementById('chat-context-status')!;
    expect(status.textContent).toBe('37% context');
    expect(status.getAttribute('title')).toContain('370 of 1,000 tokens');
    expect(status.getAttribute('aria-label')).toContain('37 percent context used');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    document.getElementById('chat-new')!.click();
    expect(request).toHaveBeenCalledWith('new_chat');
    expect(status.textContent).toBe('Starting new chat…');
    expect(status.hasAttribute('aria-busy')).toBe(true);
    expect((document.getElementById('chat-compact') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('chat-new') as HTMLButtonElement).disabled).toBe(true);
  });

  it('announces compact success and failure in a persistent live region', () => {
    const view = new ChatView(() => true);
    const announcement = document.getElementById('chat-context-announcement')!;
    expect(announcement.getAttribute('role')).toBe('status');
    expect(announcement.getAttribute('aria-live')).toBe('polite');

    view.showControlResult({
      type: 'control_result',
      action: 'compact',
      request_id: 'compact-ok',
      ok: true,
      epoch: 1,
    });
    expect(announcement.textContent).toBe('Context compacted successfully');
    view.showControlResult({
      type: 'control_result',
      action: 'compact',
      request_id: 'compact-failed',
      ok: false,
      epoch: 1,
      code: 'failed',
      message: 'provider refused',
    });
    expect(announcement.textContent).toContain('compact context failed: provider refused');
    // An idle usage refresh updates only the usage chip, not the terminal
    // announcement users of assistive technology are still consuming.
    view.setContext({
      type: 'context',
      epoch: 1,
      replay_floor_seq: 0,
      state: 'idle',
      usage: null,
      compact_supported: true,
      session_active: true,
      writer: true,
    });
    expect(announcement.textContent).toContain('provider refused');

    view.showContextEvent({ type: 'context_event', action: 'compact', ok: true });
    expect(announcement.textContent).toBe('Context compacted successfully');
    view.showContextEvent({
      type: 'context_event',
      action: 'new_chat',
      ok: false,
      message: 'New chat started, but supervision is degraded',
    });
    expect(announcement.textContent).toContain('supervision is degraded');
  });

  it('clears the active view immediately for New chat and restores it on rejection', () => {
    const view = new ChatView(() => true);
    view.bindControls(() => true);
    view.setControlsConnected(true);
    view.setContext({
      type: 'context',
      epoch: 4,
      replay_floor_seq: 10,
      state: 'idle',
      usage: null,
      compact_supported: true,
      session_active: true,
      writer: true,
    });
    view.addFrame({ type: 'notice', text: 'retired transcript', seq: 11 }, false);
    expect(document.getElementById('chat-log')?.textContent).toContain('retired transcript');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    document.getElementById('chat-new')!.click();
    expect(document.getElementById('chat-log')?.textContent).not.toContain('retired transcript');
    view.upsertMessage({
      client_msg_id: 'pending-after-reset',
      text: 'typed into pending view',
      status: 'queued',
    });

    view.showControlResult({
      type: 'control_result',
      action: 'new_chat',
      request_id: 'new-failed',
      ok: false,
      epoch: 4,
      code: 'failed',
      message: 'fresh spawn failed',
    });
    expect(document.getElementById('chat-log')?.textContent).toContain('retired transcript');
    expect(document.getElementById('chat-log')?.textContent).toContain('fresh spawn failed');
    expect(
      [...document.querySelectorAll('.msg--user')].filter((node) =>
        node.textContent?.includes('typed into pending view'),
      ),
    ).toHaveLength(1);
  });
});

describe('composer attach consumer paths', () => {
  it('keeps typed text and chips after a failed send; remove and Escape remain live', async () => {
    const onSend = vi.fn(() => false);
    const view = new ChatView(onSend);
    view.bindAttach(
      surface({
        browse: async () =>
          result('', [
            { name: 'keep.md', kind: 'file', size: 1, image: false, pickable: true },
          ] as BrowseResult['entries']),
      }),
    );
    document.getElementById('chat-attach')!.click();
    await settle();
    (document.querySelector('.attach-row--file') as HTMLButtonElement).click();
    const input = document.getElementById('chat-input') as HTMLTextAreaElement;
    input.value = 'do not lose me';
    document.getElementById('chat-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('do not lose me');
    expect(document.querySelectorAll('#chat-chips .attach-chip')).toHaveLength(1);

    (document.querySelector('.attach-chip__remove') as HTMLButtonElement).click();
    expect(document.querySelectorAll('#chat-chips .attach-chip')).toHaveLength(0);

    document.getElementById('chat-attach')!.click();
    await settle();
    expect((document.getElementById('attach-picker') as HTMLElement).hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect((document.getElementById('attach-picker') as HTMLElement).hidden).toBe(true);
  });

  it('holds send until ALL same-name concurrent uploads settle', async () => {
    const resolvers: Array<(uploaded: UploadedFile) => void> = [];
    const onSend = vi.fn(() => true);
    const view = new ChatView(onSend);
    view.bindAttach(
      surface({
        upload: async () => new Promise<UploadedFile>((resolve) => resolvers.push(resolve)),
      }),
    );
    const first = new File(['one'], 'same.png', { type: 'image/png' });
    const second = new File(['two'], 'same.png', { type: 'image/png' });
    const fileInput = document.getElementById('chat-attach-file') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [first, second] });
    fileInput.dispatchEvent(new Event('change'));
    expect(resolvers).toHaveLength(2);
    expect(document.querySelectorAll('.attach-chip--busy')).toHaveLength(2);

    resolvers[0]!({ path: '/uploads/one-same.png', name: 'same.png', bytes: 3 });
    await settle();
    (document.getElementById('chat-input') as HTMLTextAreaElement).value = 'wait for both';
    document.getElementById('chat-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.attach-chip--busy')).toHaveLength(1);

    resolvers[1]!({ path: '/uploads/two-same.png', name: 'same.png', bytes: 3 });
    await settle();
    document.getElementById('chat-form')!.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('ignores a late browse response after newer navigation has rendered', async () => {
    let releaseSlow!: (value: BrowseResult) => void;
    const slow = new Promise<BrowseResult>((resolve) => {
      releaseSlow = resolve;
    });
    const view = new ChatView(() => true);
    view.bindAttach(
      surface({
        browse: async (path) => {
          if (path === 'slow') return slow;
          return result('', [
            { name: 'slow', kind: 'dir', size: null, image: false, pickable: true },
          ] as BrowseResult['entries']);
        },
      }),
    );
    document.getElementById('chat-attach')!.click();
    await settle();
    (document.querySelector('.attach-row--dir') as HTMLButtonElement).click();
    document.getElementById('attach-picker-up')!.click();
    await settle();
    expect(document.getElementById('attach-picker-path')!.textContent).toBe('/');

    releaseSlow(result('slow'));
    await settle();
    expect(document.getElementById('attach-picker-path')!.textContent).toBe('/');
  });

  it('ignores a stale rejected browse after newer navigation has rendered', async () => {
    let rejectSlow!: (reason: Error) => void;
    const slow = new Promise<BrowseResult>((_resolve, reject) => {
      rejectSlow = reject;
    });
    const view = new ChatView(() => true);
    view.bindAttach(
      surface({
        browse: async (path) => {
          if (path === 'slow') return slow;
          return result('', [
            { name: 'slow', kind: 'dir', size: null, image: false, pickable: true },
            { name: 'current.md', kind: 'file', size: 4, image: false, pickable: true },
          ] as BrowseResult['entries']);
        },
      }),
    );
    document.getElementById('chat-attach')!.click();
    await settle();
    (document.querySelector('.attach-row--dir') as HTMLButtonElement).click();
    document.getElementById('attach-picker-up')!.click();
    await settle();

    rejectSlow(new Error('stale browse failed'));
    await settle();
    expect(document.getElementById('attach-picker-path')!.textContent).toBe('/');
    expect(document.querySelector('.attach-row--file')?.textContent).toContain('current.md');
    expect((document.getElementById('attach-picker-error') as HTMLElement).hidden).toBe(true);
  });

  it('ignores a pending browse rejection after the picker closes', async () => {
    let rejectBrowse!: (reason: Error) => void;
    const pending = new Promise<BrowseResult>((_resolve, reject) => {
      rejectBrowse = reject;
    });
    const view = new ChatView(() => true);
    view.bindAttach(surface({ browse: async () => pending }));
    document.getElementById('chat-attach')!.click();
    document.getElementById('attach-picker-close')!.click();
    rejectBrowse(new Error('closed request failed'));
    await settle();

    expect((document.getElementById('attach-picker') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('attach-picker-error') as HTMLElement).hidden).toBe(true);
  });

  it('shows capped-listing state and disables out-of-workspace symlink targets', async () => {
    const view = new ChatView(() => true);
    view.bindAttach(
      surface({
        browse: async () =>
          result(
            '',
            [
              { name: 'outside.md', kind: 'file', size: 4, image: false, pickable: false },
            ] as BrowseResult['entries'],
            true,
          ),
      }),
    );
    document.getElementById('chat-attach')!.click();
    await settle();
    const row = document.querySelector('.attach-row--file') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.title).toMatch(/outside the workspace/i);
    expect(document.querySelector('.attach-picker__truncated')?.textContent).toMatch(/first 500/i);
    row.click();
    expect(document.querySelectorAll('#chat-chips .attach-chip')).toHaveLength(0);
  });

  it('the ninth unique pick is rejected by a fresh, exact cap signal', async () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({
      name: `f${index}.txt`,
      kind: 'file' as const,
      size: 1,
      image: false,
      pickable: true,
    }));
    const view = new ChatView(() => true);
    view.bindAttach(surface({ browse: async () => result('', entries as BrowseResult['entries']) }));
    for (let index = 0; index < 9; index += 1) {
      document.getElementById('chat-attach')!.click();
      await settle();
      const row = [...document.querySelectorAll<HTMLButtonElement>('.attach-row--file')]
        .find((candidate) => candidate.dataset.name === `f${index}.txt`)!;
      row.click();
    }
    expect(document.querySelectorAll('#chat-chips .attach-chip')).toHaveLength(8);
    const notices = [...document.querySelectorAll('.notice-line--ephemeral')];
    expect(notices.at(-1)?.textContent).toBe('⚠️ attachment cap reached (8)');
  });
});
