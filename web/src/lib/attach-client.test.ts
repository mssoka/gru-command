// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AttachClient,
  AttachError,
  MAX_UPLOAD_BYTES,
  readFileBytes,
} from './attach-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function client(timeoutMs = 50): AttachClient {
  return new AttachClient({ token: 't', host: 'example.test', secure: false, timeoutMs });
}

describe('AttachClient consumer boundary', () => {
  it('preserves the browse truncation flag from the HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ root: '/ws', path: '', parent: null, entries: [], truncated: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )),
    );
    await expect(client().browse('')).resolves.toMatchObject({ truncated: true });
  });

  it('turns a hung request into a bounded timeout error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
      ),
    );
    await expect(client(5).browse('')).rejects.toMatchObject({
      name: 'AttachError',
      status: 0,
    });
  });

  it('maps a fetch failure to an actionable unreachable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('network down'))));
    await expect(client().browse('')).rejects.toMatchObject({
      name: 'AttachError',
      status: 0,
      message: expect.stringContaining('network down'),
    });
  });

  it('rejects an oversized device File before FileReader allocates its bytes', async () => {
    const read = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer');
    const oversized = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'too-big.bin');
    await expect(readFileBytes(oversized)).rejects.toEqual(
      new AttachError(413, `file exceeds the ${MAX_UPLOAD_BYTES} byte cap (${MAX_UPLOAD_BYTES + 1} bytes)`),
    );
    expect(read).not.toHaveBeenCalled();
  });
});
