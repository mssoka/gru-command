import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ChatFrameLog,
  FRAME_LOG_NAME,
  FrameLogCorruptError,
} from '../src/chat/frame-log.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-chatlog-'));
  cleanupDirs.push(dir);
  return dir;
}

function seedFile(dir: string, frames: readonly unknown[]): void {
  writeFileSync(
    join(dir, FRAME_LOG_NAME),
    frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n',
    'utf-8',
  );
}

describe('ChatFrameLog', () => {
  it('loads empty on a missing file and assigns seqs from 1', () => {
    const log = ChatFrameLog.load(fixture());
    expect(log.highWaterSeq).toBe(0);
    expect(log.history).toEqual([]);
    const first = log.append({ type: 'turn', state: 'start' });
    expect(first).toEqual({ type: 'turn', state: 'start', seq: 1 });
    expect(log.highWaterSeq).toBe(1);
  });

  it('persists every append and reloads with the counter at the high-water mark', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir);
    log.append({ type: 'user', text: 'hello', client_msg_id: 'id-1' });
    log.append({ type: 'ack', client_msg_id: 'id-1' });
    log.append({ type: 'delta', text: 'chunk' });

    const reloaded = ChatFrameLog.load(dir);
    expect(reloaded.highWaterSeq).toBe(3);
    expect(reloaded.history).toEqual([
      { type: 'user', text: 'hello', client_msg_id: 'id-1', seq: 1 },
      { type: 'ack', client_msg_id: 'id-1', seq: 2 },
      { type: 'delta', text: 'chunk', seq: 3 },
    ]);
    // The counter continues where the previous process left off.
    const next = reloaded.append({ type: 'turn', state: 'end' });
    expect(next).toEqual({ type: 'turn', state: 'end', seq: 4 });
  });

  it('replayAfter returns exactly the frames above the watermark in order', () => {
    const dir = fixture();
    seedFile(dir, [
      { type: 'user', text: 'a', client_msg_id: 'id-1', seq: 1 },
      { type: 'ack', client_msg_id: 'id-1', seq: 2 },
      { type: 'delta', text: 'x', seq: 3 },
      { type: 'turn', state: 'end', seq: 4 },
    ]);
    const log = ChatFrameLog.load(dir);
    expect(log.replayAfter(0)).toHaveLength(4);
    expect(log.replayAfter(2)).toEqual([
      { type: 'delta', text: 'x', seq: 3 },
      { type: 'turn', state: 'end', seq: 4 },
    ]);
    expect(log.replayAfter(4)).toEqual([]);
    expect(log.replayAfter(99)).toEqual([]);
  });

  it('rebuilds the client_msg_id dedup index across reloads', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir);
    log.append({ type: 'user', text: 'once', client_msg_id: 'id-7' });
    expect(log.hasSeenUserId('id-7')).toBe(true);
    expect(log.hasSeenUserId('id-8')).toBe(false);
    const reloaded = ChatFrameLog.load(dir);
    expect(reloaded.hasSeenUserId('id-7')).toBe(true);
  });

  it('tolerates a torn final line (crash mid-append) with a warn', () => {
    const dir = fixture();
    const warnings: string[] = [];
    writeFileSync(
      join(dir, FRAME_LOG_NAME),
      '{"type":"turn","state":"start","seq":1}\n{"type":"delta","te',
      'utf-8',
    );
    const log = ChatFrameLog.load(dir, (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    });
    // The valid prefix survived; the torn tail was dropped.
    expect(log.history[0]).toEqual({ type: 'turn', state: 'start', seq: 1 });
    expect(warnings.some((msg) => msg.includes('torn final line'))).toBe(true);
    // The settled log (turn was open) appends closing frames with fresh seqs.
    expect(log.highWaterSeq).toBe(2);
    expect(log.history[1]).toEqual({ type: 'turn', state: 'end', seq: 2 });
  });

  it('repairs a torn tail on load: appends after it and the next load stays green', () => {
    const dir = fixture();
    writeFileSync(
      join(dir, FRAME_LOG_NAME),
      '{"type":"turn","state":"start","seq":1}\n{"type":"turn","state":"end","seq":2}\n{"type":"delta","te',
      'utf-8',
    );
    const log = ChatFrameLog.load(dir);
    expect(log.highWaterSeq).toBe(2);
    // The torn line is gone from disk — an append does not bake it into
    // mid-file corruption, so the NEXT boot loads clean.
    log.append({ type: 'delta', text: 'after the crash' });
    const reloaded = ChatFrameLog.load(dir);
    expect(reloaded.history).toEqual([
      { type: 'turn', state: 'start', seq: 1 },
      { type: 'turn', state: 'end', seq: 2 },
      { type: 'delta', text: 'after the crash', seq: 3 },
    ]);
  });

  it('fails loud on mid-file corruption (never silently truncates history)', () => {
    const dir = fixture();
    writeFileSync(
      join(dir, FRAME_LOG_NAME),
      '{"type":"turn","state":"start","seq":1}\nGARBAGE\n{"type":"turn","state":"end","seq":3}\n',
      'utf-8',
    );
    expect(() => ChatFrameLog.load(dir)).toThrowError(FrameLogCorruptError);
    try {
      ChatFrameLog.load(dir);
    } catch (error) {
      expect((error as FrameLogCorruptError).line).toBe(2);
    }
  });

  it('fails loud on a seq gap (the counter must equal the high-water mark)', () => {
    const dir = fixture();
    seedFile(dir, [
      { type: 'turn', state: 'start', seq: 1 },
      { type: 'turn', state: 'end', seq: 7 },
    ]);
    expect(() => ChatFrameLog.load(dir)).toThrowError(/seq gap/);
  });

  it('fails loud on a logged auth_ok frame (never a logged frame)', () => {
    const dir = fixture();
    seedFile(dir, [{ type: 'auth_ok', seq: 1 }]);
    expect(() => ChatFrameLog.load(dir)).toThrowError(/not a logged chat frame/);
  });

  it('boot-settles an open turn: open tools end in reverse order, then the turn', () => {
    const dir = fixture();
    seedFile(dir, [
      { type: 'user', text: 'go', client_msg_id: 'id-1', seq: 1 },
      { type: 'turn', state: 'start', seq: 2 },
      { type: 'tool', name: 'bash', state: 'start', seq: 3 },
      { type: 'tool', name: 'read', state: 'start', seq: 4 },
      { type: 'tool', name: 'read', state: 'end', seq: 5 },
      { type: 'tool', name: 'edit', state: 'start', seq: 6 },
    ]);
    const warnings: string[] = [];
    const log = ChatFrameLog.load(dir, (level, msg) => {
      if (level === 'warn') warnings.push(msg);
    });
    // edit ends, then bash ends, then the turn — and only those.
    expect(log.history.slice(6)).toEqual([
      { type: 'tool', name: 'edit', state: 'end', seq: 7 },
      { type: 'tool', name: 'bash', state: 'end', seq: 8 },
      { type: 'turn', state: 'end', seq: 9 },
    ]);
    expect(warnings.some((msg) => msg.includes('mid-turn'))).toBe(true);
    // A second load finds a settled log — no further additions.
    const again = ChatFrameLog.load(dir);
    expect(again.highWaterSeq).toBe(9);
    expect(again.hasOpenTurn).toBe(false);
  });

  it('tracks hasOpenTurn across the turn lifecycle', () => {
    const log = ChatFrameLog.load(fixture());
    expect(log.hasOpenTurn).toBe(false);
    log.append({ type: 'turn', state: 'start' });
    expect(log.hasOpenTurn).toBe(true);
    log.append({ type: 'turn', state: 'end' });
    expect(log.hasOpenTurn).toBe(false);
  });

  it('persists one json object per line (append-only on disk)', () => {
    const dir = fixture();
    const log = ChatFrameLog.load(dir);
    log.append({ type: 'delta', text: 'a' });
    log.append({ type: 'delta', text: 'b' });
    const lines = readFileSync(join(dir, FRAME_LOG_NAME), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'delta', text: 'a', seq: 1 });
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'delta', text: 'b', seq: 2 });
  });
});
