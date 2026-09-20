import { describe, expect, it } from 'vitest';
import {
  parseClientFrame,
  parseServerFrame,
  loggedFrameSeq,
} from './protocol.js';

describe('parseClientFrame', () => {
  it('accepts a valid auth frame', () => {
    expect(parseClientFrame('{"type":"auth","token":"t"}')).toEqual({ type: 'auth', token: 't' });
  });

  it('accepts auth with last_seen_seq', () => {
    expect(parseClientFrame({ type: 'auth', token: 't', last_seen_seq: 7 })).toEqual({
      type: 'auth',
      token: 't',
      last_seen_seq: 7,
    });
  });

  it('rejects auth with empty token or bad seq', () => {
    expect(parseClientFrame({ type: 'auth', token: '' })).toBeNull();
    expect(parseClientFrame({ type: 'auth', token: 't', last_seen_seq: -1 })).toBeNull();
    expect(parseClientFrame({ type: 'auth', token: 't', last_seen_seq: 1.5 })).toBeNull();
  });

  it('accepts a valid user frame', () => {
    const frame = parseClientFrame({ type: 'user', text: 'hi', client_msg_id: 'abc', epoch: 2 });
    expect(frame).toEqual({ type: 'user', text: 'hi', client_msg_id: 'abc', epoch: 2 });
  });

  it('rejects malformed input', () => {
    expect(parseClientFrame('not json')).toBeNull();
    expect(parseClientFrame(null)).toBeNull();
    expect(parseClientFrame([])).toBeNull();
    expect(parseClientFrame({ type: 'user', text: 'hi', epoch: 0 })).toBeNull();
    expect(parseClientFrame({ type: 'user', text: 'hi', client_msg_id: 'x' })).toBeNull();
    expect(parseClientFrame({ type: 'user', text: 'hi', client_msg_id: 'x', epoch: -1 })).toBeNull();
    expect(parseClientFrame({ type: 'nope' })).toBeNull();
  });
});

describe('parseServerFrame', () => {
  it('accepts auth_ok / ack / delta / tool / turn', () => {
    expect(parseServerFrame({ type: 'auth_ok', seq: 3 })).toEqual({ type: 'auth_ok', seq: 3 });
    expect(parseServerFrame({ type: 'ack', client_msg_id: 'x', seq: 4 })).toEqual({
      type: 'ack',
      client_msg_id: 'x',
      seq: 4,
    });
    expect(parseServerFrame('{"type":"delta","text":"he","seq":5}')).toEqual({
      type: 'delta',
      text: 'he',
      seq: 5,
    });
    expect(parseServerFrame({ type: 'tool', name: 'bash', state: 'start', seq: 6 })).toEqual({
      type: 'tool',
      name: 'bash',
      state: 'start',
      seq: 6,
    });
    expect(parseServerFrame({ type: 'turn', state: 'end', seq: 7 })).toEqual({
      type: 'turn',
      state: 'end',
      seq: 7,
    });
  });

  it('accepts replayed user frames (with seq)', () => {
    expect(parseServerFrame({ type: 'user', text: 'hi', client_msg_id: 'x', seq: 2 })).toEqual({
      type: 'user',
      text: 'hi',
      client_msg_id: 'x',
      seq: 2,
    });
  });

  it('accepts error frames with optional fields', () => {
    expect(parseServerFrame({ type: 'error', message: 'bad' })).toEqual({
      type: 'error',
      message: 'bad',
    });
    expect(parseServerFrame({ type: 'error', message: 'bye', fatal: true, seq: 9 })).toEqual({
      type: 'error',
      message: 'bye',
      fatal: true,
      seq: 9,
    });
  });

  it('rejects frames with missing or wrong-typed fields', () => {
    expect(parseServerFrame({ type: 'delta', text: 'x' })).toBeNull();
    expect(parseServerFrame({ type: 'delta', text: 5, seq: 1 })).toBeNull();
    expect(parseServerFrame({ type: 'tool', name: 't', state: 'middle', seq: 1 })).toBeNull();
    expect(parseServerFrame({ type: 'turn', state: 'pause', seq: 1 })).toBeNull();
    expect(parseServerFrame({ type: 'ack', client_msg_id: 'x' })).toBeNull();
    expect(parseServerFrame({ type: 'user', text: 'hi', client_msg_id: 'x' })).toBeNull();
    expect(parseServerFrame('{"type":')).toBeNull();
  });
});

describe('context-control frames', () => {
  it('accepts canonical control, context, and terminal result shapes', () => {
    expect(parseClientFrame({ type: 'control', action: 'new_chat', request_id: 'n1' })).toEqual({
      type: 'control',
      action: 'new_chat',
      request_id: 'n1',
    });
    expect(
      parseServerFrame({
        type: 'context',
        epoch: 2,
        replay_floor_seq: 9,
        state: 'idle',
        usage: null,
        compact_supported: true,
        session_active: true,
        writer: true,
      }),
    ).toMatchObject({ type: 'context', epoch: 2, replay_floor_seq: 9 });
    expect(
      parseServerFrame({
        type: 'control_result',
        action: 'compact',
        request_id: 'c1',
        ok: false,
        epoch: 2,
        code: 'failed',
        message: 'provider declined',
      }),
    ).toMatchObject({ type: 'control_result', ok: false, code: 'failed' });
    expect(
      parseServerFrame({
        type: 'context_event',
        action: 'compact',
        ok: false,
        message: 'automatic compaction failed',
      }),
    ).toEqual({
      type: 'context_event',
      action: 'compact',
      ok: false,
      message: 'automatic compaction failed',
    });
  });

  it('accepts authoritative provider usage and rejects every numeric boundary violation', () => {
    const context = {
      type: 'context',
      epoch: 2,
      replay_floor_seq: 9,
      state: 'idle',
      usage: { tokens: 370, context_window: 1_000, percent: 37 },
      compact_supported: true,
      session_active: true,
      writer: true,
    } as const;
    expect(parseServerFrame(context)).toEqual(context);
    for (const usage of [
      { tokens: -1, context_window: 1_000, percent: 37 },
      { tokens: Number.NaN, context_window: 1_000, percent: 37 },
      { tokens: 370, context_window: 0, percent: 37 },
      { tokens: 370, context_window: Number.POSITIVE_INFINITY, percent: 37 },
      { tokens: 370, context_window: 1_000, percent: -0.1 },
      { tokens: 370, context_window: 1_000, percent: 100.1 },
      { tokens: 370, context_window: 1_000, percent: Number.NaN },
    ]) {
      expect(parseServerFrame({ ...context, usage })).toBeNull();
    }
  });

  it('rejects malformed control, context, and inconsistent terminal results', () => {
    expect(parseClientFrame({ type: 'control', action: 'reset', request_id: 'n1' })).toBeNull();
    expect(
      parseServerFrame({
        type: 'context',
        epoch: -1,
        replay_floor_seq: 0,
        state: 'idle',
        usage: null,
        compact_supported: true,
        session_active: true,
        writer: true,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: 'control_result',
        action: 'compact',
        request_id: 'c1',
        ok: false,
        epoch: 1,
      }),
    ).toBeNull();
    expect(
      parseServerFrame({
        type: 'control_result',
        action: 'compact',
        request_id: 'c1',
        ok: true,
        epoch: 1,
        code: 'failed',
      }),
    ).toBeNull();
    expect(parseServerFrame({ type: 'context_event', action: 'other', ok: true })).toBeNull();
    expect(
      parseServerFrame({ type: 'context_event', action: 'compact', ok: false, message: '' }),
    ).toBeNull();
  });
});

describe('loggedFrameSeq', () => {
  it('reads seq, defaulting error frames without one to 0', () => {
    expect(loggedFrameSeq({ type: 'delta', text: 'x', seq: 42 })).toBe(42);
    expect(loggedFrameSeq({ type: 'error', message: 'm' })).toBe(0);
  });
});

describe('attachment chips on user frames (SPEC ruling 19)', () => {
  const chips = [
    { path: '/ws/repo/notes.md', name: 'notes.md', kind: 'file' as const },
    { path: '/data/uploads/1-shot.png', name: 'shot.png', kind: 'image' as const },
  ];

  it('accepts a user frame carrying valid chips', () => {
    const frame = parseClientFrame({
      type: 'user', text: 'look', client_msg_id: 'a1', epoch: 3, attachments: chips,
    });
    expect(frame).toEqual({
      type: 'user', text: 'look', client_msg_id: 'a1', epoch: 3, attachments: chips,
    });
  });

  it('accepts an attachment-ONLY frame (empty text, chips present)', () => {
    const frame = parseClientFrame({
      type: 'user',
      text: '',
      client_msg_id: 'a2',
      epoch: 0,
      attachments: [{ path: '/x.png', name: 'x.png', kind: 'image' }],
    });
    expect(frame?.type).toBe('user');
  });

  it('rejects empty-text frames WITHOUT chips (still malformed)', () => {
    expect(parseClientFrame({ type: 'user', text: '', client_msg_id: 'a3', epoch: 0 })).toBeNull();
  });

  it('rejects bad chip kinds, empty arrays, and over-cap arrays', () => {
    expect(
      parseClientFrame({
        type: 'user',
        text: 'x',
        client_msg_id: 'a4',
        epoch: 0,
        attachments: [{ path: '/v', name: 'v', kind: 'video' }],
      }),
    ).toBeNull();
    expect(
      parseClientFrame({ type: 'user', text: 'x', client_msg_id: 'a5', epoch: 0, attachments: [] }),
    ).toBeNull();
    expect(
      parseClientFrame({
        type: 'user',
        text: 'x',
        client_msg_id: 'a6',
        epoch: 0,
        attachments: Array.from({ length: 9 }, (_, i) => ({ path: `/f${i}`, name: `f${i}`, kind: 'file' as const })),
      }),
    ).toBeNull();
  });

  it('replayed user frames keep their chips (history restores them)', () => {
    const frame = parseServerFrame({
      type: 'user',
      text: 'look',
      client_msg_id: 'a1',
      seq: 3,
      attachments: chips,
    });
    expect(frame).toMatchObject({ type: 'user', seq: 3, attachments: chips });
  });
});
