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
    const frame = parseClientFrame({ type: 'user', text: 'hi', client_msg_id: 'abc' });
    expect(frame).toEqual({ type: 'user', text: 'hi', client_msg_id: 'abc' });
  });

  it('rejects malformed input', () => {
    expect(parseClientFrame('not json')).toBeNull();
    expect(parseClientFrame(null)).toBeNull();
    expect(parseClientFrame([])).toBeNull();
    expect(parseClientFrame({ type: 'user', text: 'hi' })).toBeNull();
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

describe('loggedFrameSeq', () => {
  it('reads seq, defaulting error frames without one to 0', () => {
    expect(loggedFrameSeq({ type: 'delta', text: 'x', seq: 42 })).toBe(42);
    expect(loggedFrameSeq({ type: 'error', message: 'm' })).toBe(0);
  });
});
