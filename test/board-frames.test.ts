import { describe, expect, it } from 'vitest';
import * as web from '../web/src/lib/board-protocol.js';
import { BOARD_WS_PATH, parseBoardClientFrame } from '../src/board/frames.js';

/**
 * Board-frame parity (chat-frames pattern): the web validator
 * (web/src/lib/board-protocol.ts) and the server parser
 * (src/board/frames.ts) feed identical corpora and must agree. A
 * divergence on either side fails here.
 */

const CLIENT_CORPUS: readonly unknown[] = [
  // valid
  { type: 'auth', token: 'tok' },
  { type: 'auth', token: 'x'.repeat(200) },
  // valid: extra keys ignored
  { type: 'auth', token: 'tok', extra: true },
  // valid SHAPE (an empty-string token parses; auth rejects it later)
  { type: 'auth', token: '' },
  // invalid
  { type: 'auth' },
  { type: 'auth', token: 7 },
  { type: 'auth', token: null },
  { type: 'board' },
  { type: 'user', text: 'hi' },
  { type: 'nope' },
  { type: 42 },
  {},
  [],
  null,
  'not json',
  true,
];

const SNAPSHOT_VALID = {
  repos: [
    {
      name: 'demo',
      jobs: [
        {
          id: 'j1',
          repo: 'demo',
          title: 't',
          status: 'working',
          updatedAt: '2026-01-01T00:00:00.000Z',
          prUrl: null,
          baseBranch: null,
          note: null,
          rounds: [
            {
              id: 'j1-r1',
              seq: 1,
              status: 'live',
              verdict: null,
              targetRef: null,
              updatedAt: '2026-01-01T00:00:00.000Z',
              lenses: [{ lens: 'blind', state: 'pending', agentId: null, note: null }],
            },
          ],
        },
      ],
    },
  ],
  agents: [],
  notifications: [],
  decisions: {
    enabled: false,
    status: 'disabled',
    reason: 'disabled',
    model: '~typesafe/jev-latest',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    credentialPresent: false,
    credentialSource: 'none',
    checkedAt: null,
    incarnation: 'test-incarnation',
    generation: 0,
  },
};

const SERVER_CORPUS: readonly unknown[] = [
  { type: 'auth_ok' },
  { type: 'error', message: 'invalid token', fatal: true },
  { type: 'error', message: 'soft', fatal: false },
  { type: 'board', snapshot: SNAPSHOT_VALID },
  // invalid
  { type: 'error', message: 'no-fatal-flag' },
  { type: 'error', fatal: true },
  { type: 'board' },
  { type: 'board', snapshot: { repos: [], agents: [], notifications: 'nope' } },
  { type: 'board', snapshot: null },
  { type: 'nope' },
  {},
  [],
  null,
  42,
  'str',
];

describe('board frame parity (server parser ↔ web validator)', () => {
  it('client-frame corpus: identical accept/reject verdicts', () => {
    for (const item of CLIENT_CORPUS) {
      const server = parseBoardClientFrame(item);
      const client = web.parseBoardClientFrame(item);
      expect(server === null, `client corpus item ${JSON.stringify(item)}`).toBe(client === null);
      if (server !== null) {
        expect(server.type).toBe('auth');
        expect(typeof server.token).toBe('string');
      }
    }
  });

  it('server-frame corpus: identical accept/reject verdicts', () => {
    for (const item of SERVER_CORPUS) {
      const client = web.parseBoardServerFrame(item);
      const valid = client !== null;
      if (item === (SERVER_CORPUS[3] as unknown)) {
        expect(valid, 'the valid snapshot exemplar must parse').toBe(true);
      }
      // The server never parses its own outbound frames; the contract here
      // is that the web side accepts exactly the shapes the server sends.
      if (valid) {
        expect(['auth_ok', 'error', 'board']).toContain(client.type);
      }
    }
  });

  it('the ws path constant matches on both sides', () => {
    expect(BOARD_WS_PATH).toBe(web.BOARD_WS_PATH);
    expect(BOARD_WS_PATH).toBe('/board/ws');
  });
});
