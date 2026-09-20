import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickFreePort, startRealService, type RealServiceHandle } from './helpers/real-service.mjs';

/**
 * W5 closure (E5c): the LAN-phone send path exercised over the REAL
 * socket — raw `ws` clients (no browser) walking the exact flow
 * docs/CHAT.md documents for a second device: pair with the token, see
 * full replay, get read-only while the desktop holds the pen, receive
 * the pen silently when it leaves, send successfully, and reconnect
 * with `last_seen_seq` to catch up incrementally. The Gru runtime is
 * the offline claude CLI double (echo replies); everything else —
 * config/token flow, frame contract, seq log, pen arbitration — is the
 * real service.
 */

interface RawFrame {
  readonly type: string;
  readonly seq?: number;
  readonly text?: string;
  readonly client_msg_id?: string;
  readonly message?: string;
  readonly fatal?: boolean;
  readonly state?: string;
  readonly epoch?: number;
}

const W5_TOKEN = 'w5-lan-phone-token';

/** A raw phone-shaped client: auth on open, collect every frame. */
class RawClient {
  readonly frames: RawFrame[] = [];
  private readonly openPromise: Promise<void>;
  private epoch = 0;

  constructor(
    private readonly socket: WebSocket,
    token: string,
    lastSeenSeq?: number,
  ) {
    this.openPromise = new Promise((resolve, reject) => {
      socket.once('open', () => {
        const auth: Record<string, string | number> = { type: 'auth', token };
        if (lastSeenSeq !== undefined && lastSeenSeq > 0) auth['last_seen_seq'] = lastSeenSeq;
        socket.send(JSON.stringify(auth));
        resolve();
      });
      socket.once('error', reject);
    });
    socket.on('message', (data: unknown) => {
      const frame = JSON.parse(String(data)) as RawFrame;
      if (frame.type === 'context' && typeof frame.epoch === 'number') this.epoch = frame.epoch;
      this.frames.push(frame);
    });
  }

  async ready(): Promise<this> {
    await this.openPromise;
    return this;
  }

  send(text: string, clientMsgId: string): void {
    this.socket.send(
      JSON.stringify({ type: 'user', text, client_msg_id: clientMsgId, epoch: this.epoch }),
    );
  }

  sendWithAttachments(
    text: string,
    clientMsgId: string,
    attachments: readonly { readonly path: string; readonly name: string; readonly kind: 'file' | 'image' }[],
  ): void {
    this.socket.send(
      JSON.stringify({
        type: 'user',
        text,
        client_msg_id: clientMsgId,
        epoch: this.epoch,
        attachments,
      }),
    );
  }

  async waitFor(match: (frame: RawFrame) => boolean, what: string, timeoutMs = 10_000): Promise<RawFrame> {
    const start = Date.now();
    for (;;) {
      const found = this.frames.find(match);
      if (found !== undefined) return found;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`waitFor(${what}) timed out after ${timeoutMs}ms; frames: ${JSON.stringify(this.frames)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async waitClosed(timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (this.socket.readyState !== WebSocket.CLOSED) {
      if (Date.now() - start > timeoutMs) throw new Error('socket never closed');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  lastSeq(): number {
    return this.frames.reduce((max, frame) => {
      return typeof frame.seq === 'number' && frame.seq > max ? frame.seq : max;
    }, 0);
  }

  close(): void {
    this.socket.close();
  }
}

function deltaText(frames: readonly RawFrame[]): string {
  return frames
    .filter((frame) => frame.type === 'delta' && typeof frame.text === 'string')
    .map((frame) => frame.text)
    .join('');
}

/**
 * Send until acked — the pen promotes asynchronously after the writer's
 * socket closes, so early attempts may earn a read-only rejection
 * (ephemeral, nothing logged); re-sending the same id is exactly the
 * browser client's own outbox behavior. Resolves with the ack frame.
 */
async function sendUntilAcked(client: RawClient, text: string, id: string, timeoutMs = 10_000): Promise<RawFrame> {
  const start = Date.now();
  for (;;) {
    client.send(text, id);
    try {
      return await client.waitFor(
        (frame) => frame.type === 'ack' && frame.client_msg_id === id,
        `ack ${id}`,
        1_500,
      );
    } catch {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`send was never acked within ${timeoutMs}ms (pen never promoted?): ${text}`);
      }
    }
  }
}

describe('W5 — LAN-phone send path over the real socket', () => {
  let service: RealServiceHandle | null = null;
  let url = '';

  beforeAll(async () => {
    const port = await pickFreePort();
    service = await startRealService({ port, token: W5_TOKEN, requireWebDist: false });
    url = `ws://127.0.0.1:${port}/ws`;
  });

  afterAll(async () => {
    await service?.stop();
  });

  let desktop: RawClient;
  let phone: RawClient;

  it('a bad token is fatal before anything is replayed', async () => {
    const intruder = await new RawClient(new WebSocket(url), 'definitely-not-the-token').ready();
    const fatal = await intruder.waitFor(
      (frame) => frame.type === 'error' && frame.fatal === true,
      'fatal unauthorized error',
    );
    expect(fatal.message).toContain('unauthorized');
    await intruder.waitClosed();
    // Fatal frames are never persisted — nothing seq'd ever arrived.
    expect(intruder.frames.filter((frame) => frame.seq !== undefined)).toHaveLength(0);
  });

  it('the desktop pairs, sends, and streams the reply in seq order', async () => {
    desktop = await new RawClient(new WebSocket(url), W5_TOKEN).ready();
    const authOk = await desktop.waitFor((frame) => frame.type === 'auth_ok', 'auth_ok');
    expect(authOk.seq).toBeGreaterThanOrEqual(0);

    desktop.send('hello from the desktop', 'w5-desktop-1');
    await desktop.waitFor(
      (frame) => frame.type === 'ack' && frame.client_msg_id === 'w5-desktop-1',
      'ack for the desktop message',
    );
    await desktop.waitFor((frame) => frame.type === 'turn' && frame.state === 'start', 'turn start');
    await desktop.waitFor((frame) => frame.type === 'turn' && frame.state === 'end', 'turn end');
    expect(deltaText(desktop.frames)).toBe('echo: hello from the desktop');

    const seqs = desktop.frames
      .filter((frame) => typeof frame.seq === 'number')
      .map((frame) => frame.seq as number);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it('the phone pairs read-only: full replay, its send rejected ephemerally', async () => {
    phone = await new RawClient(new WebSocket(url), W5_TOKEN).ready();
    const authOk = await phone.waitFor((frame) => frame.type === 'auth_ok', 'auth_ok');
    expect(authOk.seq).toBeGreaterThan(0); // the desktop's history exists

    // Full replay restores both sides of the conversation.
    await phone.waitFor(
      (frame) => frame.type === 'user' && frame.client_msg_id === 'w5-desktop-1',
      'replayed own-side user frame',
    );
    expect(deltaText(phone.frames)).toBe('echo: hello from the desktop');

    // The phone's send while another client holds the pen: a per-client
    // notice — no seq, not fatal, nothing logged for later readers.
    phone.send('phone tries to write', 'w5-phone-rejected');
    const readOnly = await phone.waitFor(
      (frame) => frame.type === 'error' && (frame.message ?? '').includes('read-only'),
      'read-only rejection',
    );
    expect(readOnly.seq).toBeUndefined();
    expect(readOnly.fatal).not.toBe(true);
  });

  it('pen promotes when the desktop leaves: the phone send path works', async () => {
    desktop.close();
    // Promotion sends no frame — the send being acked IS the proof.
    const ack = await sendUntilAcked(phone, 'phone after promotion', 'w5-phone-2');
    const ackSeq = ack.seq ?? 0;
    await phone.waitFor(
      (frame) => frame.type === 'turn' && frame.state === 'end' && (frame.seq ?? 0) > ackSeq,
      'promoted phone turn end',
    );
    // The fresh slice (seq > ack) is exactly this turn's frames — the
    // replayed desktop turn cannot satisfy the match, and retries that
    // were read-only never ran, so the reply arrives exactly once.
    const fresh = phone.frames.filter((frame) => (frame.seq ?? 0) > ackSeq);
    expect(deltaText(fresh)).toBe('echo: phone after promotion');
  });

  it('the phone reconnects with last_seen_seq: only missed frames replay', async () => {
    const lastSeen = phone.lastSeq();
    phone.close();

    // While the phone is away, a new writer pairs and sends.
    const away = await new RawClient(new WebSocket(url), W5_TOKEN).ready();
    await sendUntilAcked(away, 'while the phone was away', 'w5-away-1');
    await away.waitFor((frame) => frame.type === 'turn' && frame.state === 'end', 'away turn end');

    // The phone returns, catching up from its high-water mark.
    const back = await new RawClient(new WebSocket(url), W5_TOKEN, lastSeen).ready();
    const authOk = await back.waitFor((frame) => frame.type === 'auth_ok', 'auth_ok');
    expect(authOk.seq).toBeGreaterThan(lastSeen);
    await back.waitFor(
      (frame) => frame.type === 'user' && frame.client_msg_id === 'w5-away-1',
      'the missed user frame replays',
    );
    // Replay ends at the settled turn — only then is the delta set complete.
    await back.waitFor((frame) => frame.type === 'turn' && frame.state === 'end', 'replayed turn end');
    // Incremental, not full: everything older stays out, the rejected
    // read-only attempt never surfaces.
    const replayedUserTexts = back.frames
      .filter((frame) => frame.type === 'user' && typeof frame.text === 'string')
      .map((frame) => frame.text);
    expect(replayedUserTexts).toEqual(['while the phone was away']);
    expect(deltaText(back.frames)).toBe('echo: while the phone was away');
    expect(back.frames.some((frame) => (frame.message ?? '').includes('read-only'))).toBe(false);

    away.close();
    back.close();
  });
});

describe('B1 — resolved model inputs drive the real-service vision gate', () => {
  it('an image sent to a declared text-only model emits the decline and never-guess prompt', async () => {
    const port = await pickFreePort();
    const token = 'b1-text-only-model-token';
    const model = 'amazon-bedrock/amazon.nova-micro-v1:0';
    const catalog = await ModelRuntime.create({ refreshOnCreate: false });
    expect(catalog.getModel('amazon-bedrock', 'amazon.nova-micro-v1:0')?.input).toEqual(['text']);
    const service = await startRealService({
      port,
      token,
      requireWebDist: false,
      model,
    });
    const client = await new RawClient(new WebSocket(`ws://127.0.0.1:${port}/ws`), token).ready();
    try {
      await client.waitFor((frame) => frame.type === 'auth_ok', 'auth_ok');
      const upload = await fetch(`${service.baseUrl}/api/attach/uploads`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          filename: 'text-only-proof.png',
          content_base64: Buffer.from('real image-path fixture').toString('base64'),
        }),
      });
      expect(upload.status).toBe(201);
      const stored = (await upload.json()) as { path: string; name: string };

      client.sendWithAttachments('describe this', 'b1-real-decline', [
        { path: stored.path, name: stored.name, kind: 'image' },
      ]);
      const notice = await client.waitFor(
        (frame) => frame.type === 'notice' && (frame.text ?? '').includes('Vision is unavailable'),
        'model-derived vision decline',
      );
      expect(notice.text).toContain('current model');
      await client.waitFor(
        (frame) => frame.type === 'ack' && frame.client_msg_id === 'b1-real-decline',
        'attach ack',
      );
      await client.waitFor(
        (frame) => frame.type === 'turn' && frame.state === 'end',
        'declined-image turn end',
      );
      const delivered = deltaText(client.frames);
      expect(delivered).toContain(stored.path);
      expect(delivered).toContain('do NOT guess');
      expect(client.frames.some((frame) => frame.type === 'error')).toBe(false);
    } finally {
      client.close();
      await service.stop();
    }
  });
});
