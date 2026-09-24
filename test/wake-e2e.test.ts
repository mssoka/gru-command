import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { afterAll, describe, expect, it } from 'vitest';
import { pickFreePort, startRealService, type RealServiceHandle } from './helpers/real-service.mjs';

/**
 * Wake-on-alert e2e (owner ruling 2026-09-23): an action-required
 * notification must OPEN a Gru turn on the REAL service — no user message,
 * no ping. Always runs in `npm test` after the build, using the offline
 * claude CLI double; no live model or paid API calls.
 *
 * The whole path is real: config load → ledger → event bus → awareness
 * wake policy → chat session spawn → turn frames on the wire. Only the
 * model binary is the suite's stream-json double.
 */

interface WireFrame {
  readonly type: string;
  readonly state?: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

async function waitForFrame(
  frames: readonly WireFrame[],
  predicate: (frame: WireFrame) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<WireFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function authedSocket(service: RealServiceHandle): Promise<{ socket: WebSocket; frames: WireFrame[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${service.port}/ws`);
  const frames: WireFrame[] = [];
  socket.on('message', (data) => {
    try {
      frames.push(JSON.parse(String(data)) as WireFrame);
    } catch {
      /* the contract emits JSON only; ignore noise rather than crash the test */
    }
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'auth', token: service.token }));
  await waitForFrame(frames, (frame) => frame.type === 'auth_ok', 'auth_ok');
  return { socket, frames };
}

describe('wake-on-alert real service (offline)', () => {
  let service: RealServiceHandle | null = null;
  afterAll(async () => {
    await service?.stop();
  });

  it('an injected action-required notification opens a Gru turn with its payload', async () => {
    const port = await pickFreePort();
    const logFile = `/tmp/gru-command-wake-e2e-${process.pid}-${Date.now()}.jsonl`;
    service = await startRealService({
      port,
      notifyWake: 'action-required',
      requireWebDist: false,
      extraEnv: { CLAUDE_DOUBLE_LOG: logFile },
    });
    const { socket, frames } = await authedSocket(service);
    try {
      const posted = await fetch(`${service.baseUrl}/api/silas/escalate`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${service.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Wake e2e: lane interruption needs a machine disposition',
          detail: 'injected by the wake-on-alert e2e — no user message is waiting',
        }),
      });
      expect(posted.status).toBe(200);

      // No user frame was sent: any turn here was opened by the wake policy.
      const turnStart = await waitForFrame(
        frames,
        (frame) => frame.type === 'turn' && frame.state === 'start',
        'wake turn start',
      );
      expect(turnStart.type).toBe('turn');
      await waitForFrame(
        frames,
        (frame) => frame.type === 'turn' && frame.state === 'end',
        'wake turn end',
      );

      // Board observability: the wake is a durable gru.wake event.
      const board = await fetch(`${service.baseUrl}/api/board`, {
        headers: { Authorization: `Bearer ${service.token}` },
      });
      expect(board.status).toBe(200);
      const snapshot = (await board.json()) as { wakes: { count: number; lastAt: string | null } };
      expect(snapshot.wakes.count).toBeGreaterThanOrEqual(1);
      expect(snapshot.wakes.lastAt).not.toBeNull();
    } finally {
      socket.close();
    }

    // The turn payload is service context, clearly marked, carrying the
    // notification content — read from the CLI double's invocation log.
    await service.stop();
    service = null;
    const invocations = readFileSync(logFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { prompt?: string });
    const wakePrompt = invocations.find((entry) =>
      (entry.prompt ?? '').includes('[gru awareness · service context'),
    );
    expect(wakePrompt).toBeDefined();
    expect(wakePrompt?.prompt).toContain('Wake e2e: lane interruption needs a machine disposition');
    expect(wakePrompt?.prompt).toContain('This turn was started by the service wake policy');
  });
});
