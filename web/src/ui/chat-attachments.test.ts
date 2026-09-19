// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowseResult, UploadedFile } from '../lib/attach-client.js';
import { ChatView, type AttachSurface } from './chat.js';

function installChatDom(): void {
  document.body.replaceChildren();
  const mainMount = document.createElement('div');
  mainMount.id = 'chat-main-mount';
  const log = document.createElement('div');
  log.id = 'chat-log';
  const form = document.createElement('form');
  form.id = 'chat-form';
  const chips = document.createElement('div');
  chips.id = 'chat-chips';
  chips.hidden = true;
  const composeRow = document.createElement('div');
  const attach = document.createElement('button');
  attach.id = 'chat-attach';
  attach.type = 'button';
  const input = document.createElement('input');
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
  view.append(log, form, picker);
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
    const input = document.getElementById('chat-input') as HTMLInputElement;
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
    (document.getElementById('chat-input') as HTMLInputElement).value = 'wait for both';
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
