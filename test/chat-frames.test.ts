import { describe, expect, it } from 'vitest';
import * as web from '../web/src/lib/protocol.js';
import {
  WS_PATH,
  ephemeralError,
  parseClientFrame,
  parseServerFrame,
  withSeq,
  type UnseqedFrame,
} from '../src/chat/frames.js';

/**
 * Parser parity (briefing W1): the E5 frontend's protocol module is the
 * mutation-proven executable spec of the frame contract. The backend
 * mirrors it (tsc cannot import across the workspace boundary), so this
 * corpus feeds BOTH implementations identical inputs and asserts
 * identical verdicts + parsed output. A divergence on EITHER side —
 * a loosened server validator, a tightened web one — fails this suite.
 */

const CLIENT_CORPUS: readonly unknown[] = [
  // valid exemplars
  { type: 'auth', token: 'tok' },
  { type: 'auth', token: 'tok', last_seen_seq: 0 },
  { type: 'auth', token: 'tok', last_seen_seq: 42 },
  { type: 'control', action: 'compact', request_id: 'compact-1' },
  { type: 'control', action: 'new_chat', request_id: 'new-1' },
  { type: 'user', text: 'hello', client_msg_id: 'id-1', epoch: 0 },
  // valid: SPEC ruling 19 attachment chips (both kinds, absent optional)
  {
    type: 'user',
    text: 'look',
    client_msg_id: 'id-2',
    epoch: 3,
    attachments: [
      { path: '/ws/repo/notes.md', name: 'notes.md', kind: 'file' },
      { path: '/data/uploads/1-shot.png', name: 'shot.png', kind: 'image' },
    ],
  },
  { type: 'user', text: '', client_msg_id: 'id-3', epoch: 0, attachments: [{ path: '/x.png', name: 'x.png', kind: 'image' }] },
  // valid: extra keys are ignored
  { type: 'auth', token: 'tok', extra: true },
  { type: 'user', text: 'x', client_msg_id: 'id', epoch: 4, future: 'field' },
  // invalid
  { type: 'auth' },
  { type: 'auth', token: '' },
  { type: 'auth', token: 7 },
  { type: 'auth', token: 'tok', last_seen_seq: -1 },
  { type: 'auth', token: 'tok', last_seen_seq: 1.5 },
  { type: 'auth', token: 'tok', last_seen_seq: Number.MAX_SAFE_INTEGER + 1 },
  { type: 'auth', token: 'tok', last_seen_seq: '7' },
  { type: 'auth', token: 'tok', last_seen_seq: null },
  { type: 'control', action: 'reset', request_id: 'bad' },
  { type: 'control', action: 'compact', request_id: '' },
  { type: 'user', text: '', client_msg_id: 'id' }, // no text AND no chips
  // invalid: SPEC ruling 19 chip shapes (empty array, bad kind, too many,
  // empty fields, oversized path)
  { type: 'user', text: 'hi', client_msg_id: 'id', attachments: [] },
  { type: 'user', text: 'hi', client_msg_id: 'id', attachments: [{ path: '/x', name: 'x', kind: 'video' }] },
  {
    type: 'user',
    text: 'hi',
    client_msg_id: 'id',
    attachments: Array.from({ length: 9 }, (_, i) => ({ path: `/f${i}`, name: `f${i}`, kind: 'file' })),
  },
  { type: 'user', text: 'hi', client_msg_id: 'id', attachments: [{ path: '', name: 'x', kind: 'file' }] },
  { type: 'user', text: 'hi', client_msg_id: 'id', attachments: [{ path: '/x', name: '', kind: 'file' }] },
  {
    type: 'user',
    text: 'hi',
    client_msg_id: 'id',
    attachments: [{ path: `/long/${'a'.repeat(1100)}`, name: 'a', kind: 'file' }],
  },
  { type: 'user', text: 'hi', client_msg_id: 'id', attachments: 'nope' },
  { type: 'user', text: 'hi' },
  { type: 'user', text: 'hi', client_msg_id: '' },
  { type: 'user', text: 'hi', client_msg_id: 3 },
  { type: 'nope' },
  { type: 42 },
  {},
  [],
  null,
  42,
  'not json at all',
  '{"type":"auth","token":"tok"}', // valid JSON string — parsed then validated
  '{"type":"user","text":"hi","client_msg_id":"id","epoch":0}',
  '{"broken json',
  true,
];

const SERVER_CORPUS: readonly unknown[] = [
  // valid exemplars
  { type: 'auth_ok', seq: 0 },
  { type: 'auth_ok', seq: 99 },
  { type: 'ack', client_msg_id: 'id-1', seq: 3 },
  { type: 'user', text: 'hi', client_msg_id: 'id-1', seq: 2 },
  // valid: replays carry the SPEC ruling 19 chips
  {
    type: 'user',
    text: 'look',
    client_msg_id: 'id-2',
    seq: 15,
    attachments: [{ path: '/data/uploads/1-shot.png', name: 'shot.png', kind: 'image' }],
  },
  { type: 'user', text: '', client_msg_id: 'id-3', seq: 16, attachments: [{ path: '/x.png', name: 'x.png', kind: 'image' }] },
  { type: 'delta', text: 'chunk', seq: 4 },
  { type: 'delta', text: '', seq: 5 }, // empty delta text is valid
  { type: 'tool', name: 'bash', state: 'start', seq: 6 },
  { type: 'tool', name: 'bash', state: 'end', seq: 7 },
  { type: 'turn', state: 'start', seq: 8 },
  { type: 'turn', state: 'end', seq: 9 },
  { type: 'notice', text: '⚠ action required: breaker tripped', seq: 12 }, // E7
  { type: 'error', message: 'boom' },
  { type: 'error', message: 'boom', fatal: true },
  { type: 'error', message: 'boom', seq: 10 },
  { type: 'error', message: 'boom', fatal: false, seq: 11 },
  {
    type: 'context',
    epoch: 2,
    replay_floor_seq: 41,
    state: 'idle',
    usage: { tokens: 10, context_window: 100, percent: 10 },
    compact_supported: true,
    session_active: true,
    writer: false,
  },
  { type: 'context', epoch: 2, replay_floor_seq: 41, state: 'busy', usage: null, compact_supported: true, session_active: true, writer: true },
  { type: 'control_result', action: 'new_chat', request_id: 'new-1', ok: true, epoch: 2 },
  { type: 'context_event', action: 'compact', ok: true },
  { type: 'context_event', action: 'compact', ok: false, message: 'provider failed' },
  {
    type: 'control_result',
    action: 'compact',
    request_id: 'compact-1',
    ok: false,
    epoch: 2,
    code: 'busy',
    message: 'chat is busy',
  },
  // invalid
  { type: 'context', epoch: -1, replay_floor_seq: 0, state: 'idle', usage: null, compact_supported: true, session_active: true, writer: true },
  { type: 'context', epoch: Number.MAX_SAFE_INTEGER + 1, replay_floor_seq: 0, state: 'idle', usage: null, compact_supported: true, session_active: true, writer: true },
  { type: 'context', epoch: 1, replay_floor_seq: Number.MAX_SAFE_INTEGER + 1, state: 'idle', usage: null, compact_supported: true, session_active: true, writer: true },
  { type: 'context', epoch: 1, replay_floor_seq: 0, state: 'working', usage: null, compact_supported: true, session_active: true, writer: true },
  { type: 'control_result', action: 'compact', request_id: 'x', ok: true, epoch: Number.MAX_SAFE_INTEGER + 1 },
  { type: 'control_result', action: 'compact', request_id: 'x', ok: false, epoch: 1 },
  { type: 'control_result', action: 'compact', request_id: 'x', ok: true, epoch: 1, code: 'failed' },
  { type: 'context_event', action: 'other', ok: true },
  { type: 'context_event', action: 'compact', ok: 'yes' },
  { type: 'context_event', action: 'compact', ok: false, message: '' },
  { type: 'notice', text: 'no seq' }, // E7: notice REQUIRES seq
  { type: 'notice', text: '', seq: 13 }, // E7: empty text is malformed
  { type: 'notice', seq: 14 }, // E7: missing text
  { type: 'auth_ok' },
  { type: 'auth_ok', seq: -1 },
  { type: 'auth_ok', seq: 1.5 },
  { type: 'auth_ok', seq: Number.MAX_SAFE_INTEGER + 1 },
  { type: 'ack', client_msg_id: '', seq: 1 },
  { type: 'ack', client_msg_id: 'id' },
  { type: 'user', text: 'hi', client_msg_id: 'id' }, // replay user needs seq
  { type: 'user', text: 'hi', client_msg_id: 'id', seq: 1, attachments: [] }, // empty chip array
  { type: 'user', text: 'hi', client_msg_id: 'id', seq: 1, attachments: [{ path: '/x', name: 'x', kind: 'folder' }] },
  { type: 'delta', seq: 1 },
  { type: 'tool', name: 'bash', state: 'middle', seq: 1 },
  { type: 'tool', name: '', state: 'start', seq: 1 },
  { type: 'turn', state: 'pause', seq: 1 },
  { type: 'error' },
  { type: 'error', message: '' },
  { type: 'error', message: 'boom', seq: -3 },
  { type: 'error', message: 'boom', fatal: 'yes' },
  { type: 'auth', token: 'tok' }, // client frames are invalid server→client
  { type: 'nope' },
  {},
  [],
  null,
  42,
  '{"type":"turn","state":"start","seq":1}',
  '{"broken',
];

function expectParity(
  label: string,
  input: unknown,
  webParse: (raw: unknown) => unknown,
  serverParse: (raw: unknown) => unknown,
): void {
  const webResult = webParse(input);
  const serverResult = serverParse(input);
  expect(serverResult, `${label}: server parser diverged from web parser`).toEqual(webResult);
}

describe('chat frame parser parity with the web contract module', () => {
  it('shares the endpoint path', () => {
    expect(WS_PATH).toBe(web.WS_PATH);
  });

  it('client-frame corpus: identical verdicts and parsed output', () => {
    for (const [index, input] of CLIENT_CORPUS.entries()) {
      expectParity(`client corpus #${index}`, input, web.parseClientFrame, parseClientFrame);
    }
  });

  it('server-frame corpus: identical verdicts and parsed output', () => {
    for (const [index, input] of SERVER_CORPUS.entries()) {
      expectParity(`server corpus #${index}`, input, web.parseServerFrame, parseServerFrame);
    }
  });

  it('every frame the server can emit validates against the WEB validator', () => {
    const seqed: readonly UnseqedFrame[] = [
      { type: 'ack', client_msg_id: 'id-1' },
      { type: 'delta', text: 'chunk' },
      { type: 'tool', name: 'bash', state: 'start' },
      { type: 'tool', name: 'bash', state: 'end' },
      { type: 'turn', state: 'start' },
      { type: 'turn', state: 'end' },
      { type: 'error', message: 'logged error' },
      { type: 'user', text: 'hi', client_msg_id: 'id-1', epoch: 0 },
      // SPEC ruling 19: user frames with chips + attachment-only frames.
      {
        type: 'user',
        text: 'hi',
        client_msg_id: 'id-2',
        epoch: 0,
        attachments: [{ path: '/ws/repo/shot.png', name: 'shot.png', kind: 'image' }],
      },
      {
        type: 'user',
        text: '',
        client_msg_id: 'id-3',
        epoch: 0,
        attachments: [{ path: '/data/uploads/1-x.png', name: 'x.png', kind: 'image' }],
      },
    ];
    for (const frame of seqed) {
      const built = withSeq(frame, 7);
      expect(
        web.parseServerFrame(built),
        `web validator rejected server-built ${frame.type}`,
      ).toEqual(built);
    }
    // r2 W3': fatal is UNPERSISTABLE at the type level — the compiler
    // itself rejects the poison (this line fails typecheck if the
    // UnseqedFrame narrowing regresses).
    // @ts-expect-error fatal must never be persistable
    withSeq({ type: 'error', message: 'poison', fatal: true }, 7);
    // auth_ok + ephemeral (seq-less) errors are built inline at the server.
    expect(web.parseServerFrame({ type: 'auth_ok', seq: 0 })).toEqual({ type: 'auth_ok', seq: 0 });
    expect(web.parseServerFrame(ephemeralError('policy notice'))).toEqual(
      ephemeralError('policy notice'),
    );
    expect(web.parseServerFrame(ephemeralError('fatal notice', true))).toEqual(
      ephemeralError('fatal notice', true),
    );
  });
});
